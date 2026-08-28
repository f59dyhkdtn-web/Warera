'use strict';

/*
 * Frontend for the WarEra dashboard.
 *
 * NOTE ON FIELD NAMES: the backend's response *shape* for each item
 * (a price row, a ranking row, a battle) is not from an official spec —
 * it's a best guess from community docs. Each render function below
 * tries a short list of plausible field names (see `pick`) before
 * giving up, and logs the raw payload to the console so you can see
 * the real field names your account's data comes back with and adjust
 * `pick(...)` calls accordingly.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function pick(obj, keys, fallback = '—') {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return fallback;
}

function fmtNum(n) {
  if (typeof n !== 'number') {
    const parsed = Number(n);
    if (Number.isNaN(parsed)) return n ?? '—';
    n = parsed;
  }
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

async function api(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || `Request failed: ${path}`);
  }
  return body.data;
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  // Some tRPC procedures return { items: [...] } style pagination.
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function emptyRow(colspan, text) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = colspan;
  td.className = 'empty-state';
  td.textContent = text;
  tr.appendChild(td);
  return tr;
}

// ---- Tabs -------------------------------------------------------------

function initTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('is-active'));
      $$('.panel').forEach((p) => p.classList.remove('is-active'));
      tab.classList.add('is-active');
      $(`#panel-${tab.dataset.tab}`).classList.add('is-active');
    });
  });
}

// ---- Ticker -------------------------------------------------------------

async function refreshTicker() {
  const el = $('#tickerText');
  try {
    const battles = asArray(await api('/api/battles?active=true&limit=50'));
    el.textContent = `uplink stable · ${battles.length} active front${battles.length === 1 ? '' : 's'} · last sync ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    el.textContent = `uplink degraded — ${err.message}`;
  }
}

// ---- Market -------------------------------------------------------------

/**
 * itemTrading.getPrices returns a flat object — { itemCode: price, ... } —
 * not a list of rows. Some other endpoints on this API DO return arrays,
 * so this still checks for that shape first in case WarEra changes it
 * later, then falls back to treating a plain object as a code->price map.
 */
function marketRowsFrom(data) {
  if (Array.isArray(data)) {
    return data.map((row) => ({
      item: pick(row, ['itemCode', 'code', 'item', 'name']),
      price: Number(pick(row, ['price', 'sellPrice', 'bestSell', 'value'], null)),
    }));
  }
  if (data && typeof data === 'object') {
    return Object.entries(data).map(([item, price]) => ({ item, price: Number(price) }));
  }
  return [];
}

async function loadMarket() {
  const tbody = $('#marketTable tbody');
  const note = $('#marketNote');
  tbody.innerHTML = '';
  note.textContent = 'loading…';

  try {
    const data = await api('/api/market/prices');
    console.log('market/prices raw payload:', data);
    let rows = marketRowsFrom(data);

    const filter = $('#marketFilter').value.trim().toLowerCase();
    if (filter) rows = rows.filter((r) => r.item.toLowerCase().includes(filter));
    rows.sort((a, b) => a.item.localeCompare(b.item));

    if (rows.length === 0) {
      tbody.appendChild(emptyRow(2, 'No items returned. Check the console for the raw payload shape.'));
      note.textContent = '';
      return;
    }

    for (const { item, price } of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${item}</td>
        <td class="num">${Number.isFinite(price) ? fmtNum(price) : '—'}</td>
      `;
      tbody.appendChild(tr);
    }
    note.textContent = `${rows.length} item${rows.length === 1 ? '' : 's'} · cached ~30s`;
  } catch (err) {
    tbody.appendChild(emptyRow(2, `Failed to load: ${err.message}`));
    note.textContent = '';
  }
}

// ---- Rankings -------------------------------------------------------------

async function loadRankings() {
  const tbody = $('#rankingsTable tbody');
  const note = $('#rankingsNote');
  tbody.innerHTML = '';
  note.textContent = 'loading…';

  try {
    const type = $('#rankingType').value;
    const data = await api(`/api/rankings?type=${encodeURIComponent(type)}&limit=50`);
    const rows = asArray(data);
    console.log('rankings raw payload:', data);

    if (rows.length === 0) {
      tbody.appendChild(emptyRow(4, 'No ranking rows returned. Check the console for the raw payload shape.'));
      note.textContent = '';
      return;
    }

    rows.forEach((row, i) => {
      const name = pick(row, ['username', 'uname', 'name', 'displayName']);
      const country = pick(row, ['country', 'countryName']);
      const value = pick(row, ['value', 'score', type], null);

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="num">${i + 1}</td>
        <td>${name}</td>
        <td>${country}</td>
        <td class="num">${value !== null ? fmtNum(value) : '—'}</td>
      `;
      tbody.appendChild(tr);
    });
    note.textContent = `top ${rows.length} by ${type} · cached ~60s`;
  } catch (err) {
    tbody.appendChild(emptyRow(4, `Failed to load: ${err.message}`));
    note.textContent = '';
  }
}

// ---- Battles -------------------------------------------------------------

async function loadBattles() {
  const grid = $('#battleGrid');
  const note = $('#battlesNote');
  grid.innerHTML = '';
  note.textContent = 'loading…';

  try {
    const activeOnly = $('#battlesActiveOnly').checked;
    const data = await api(`/api/battles?limit=30${activeOnly ? '&active=true' : ''}`);
    const rows = asArray(data);
    console.log('battles raw payload:', data);

    if (rows.length === 0) {
      grid.innerHTML = '';
      grid.appendChild(Object.assign(document.createElement('div'), {
        className: 'empty-state',
        textContent: 'No battles returned. Check the console for the raw payload shape.',
      }));
      note.textContent = '';
      return;
    }

    for (const battle of rows) {
      const attacker = pick(battle, ['attackerName', 'attackerCountry', 'attacker'], 'Attacker');
      const defender = pick(battle, ['defenderName', 'defenderCountry', 'defender'], 'Defender');
      const region = pick(battle, ['regionName', 'region', 'location'], '');
      const attackerScore = Number(pick(battle, ['attackerScore', 'attackerDamage', 'attackerPoints'], 0)) || 0;
      const defenderScore = Number(pick(battle, ['defenderScore', 'defenderDamage', 'defenderPoints'], 0)) || 0;
      const total = attackerScore + defenderScore || 1;
      const attackerPct = Math.round((attackerScore / total) * 100);

      const card = document.createElement('div');
      card.className = 'battle-card';
      card.innerHTML = `
        <div class="battle-card__sides">${attacker} <span class="battle-card__vs">vs</span> ${defender}</div>
        <div class="battle-card__meta">
          <span>${region || 'Region unknown'}</span>
          <span>${fmtNum(attackerScore)} — ${fmtNum(defenderScore)}</span>
        </div>
        <div class="battle-card__bar">
          <div class="battle-card__bar-fill" style="width:${attackerPct}%"></div>
        </div>
      `;
      grid.appendChild(card);
    }
    note.textContent = `${rows.length} battle${rows.length === 1 ? '' : 's'} · cached ~15s`;
  } catch (err) {
    grid.innerHTML = '';
    note.textContent = `Failed to load: ${err.message}`;
  }
}

// ---- Craft ROI ------------------------------------------------------------

// Scraps + Steel required per rarity, straight from the in-game "Craft
// Items" menu (confirmed static, not something the API exposes directly —
// there's no known crafting-cost endpoint, so this is hand-entered).
const CRAFT_COST = {
  common: { scraps: 6, steel: 1 },
  uncommon: { scraps: 18, steel: 2 },
  rare: { scraps: 54, steel: 4 },
  epic: { scraps: 162, steel: 8 },
  legendary: { scraps: 486, steel: 16 },
  mythic: { scraps: 1458, steel: 32 },
};

// Odds a Case drops each rarity — as stated by WarEra's own game guide.
const RARITY_ODDS = { common: 62, uncommon: 30, rare: 7.1, epic: 0.85, legendary: 0.04, mythic: 0.01 };

// Odds a Case has drop each equipment slot: a stated 30% Weapon / 70%
// "other slot" split. WarEra doesn't publish the breakdown *within* that
// 70%, so this assumes the remaining five slots are equally likely —
// flagged as an assumption, not a fact.
const TYPE_ODDS = { Weapon: 30, Helmet: 14, Chest: 14, Gloves: 14, Pants: 14, Boots: 14 };

function weightedPick(oddsMap) {
  const entries = Object.entries(oddsMap);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = Math.random() * total;
  for (const [key, weight] of entries) {
    if (roll < weight) return key;
    roll -= weight;
  }
  return entries[entries.length - 1][0];
}

let materialPriceCache = null; // { scraps: n, steel: n, ... } — refreshed per render

async function getMaterialPrices() {
  const data = await api('/api/market/prices');
  const rows = marketRowsFrom(data);
  const map = {};
  rows.forEach(({ item, price }) => { map[item] = price; });
  return map;
}

/**
 * Historical equipment sale prices, from the actual trade log
 * (transaction.getPaginatedTransactions). This endpoint's exact response
 * shape isn't independently documented — it's used elsewhere per a
 * secondhand doc, but we don't have the field-level detail. So: fetch a
 * batch of recent transactions, log the raw payload for verification, and
 * try a handful of plausible field names per transaction. If a column
 * looks empty/wrong, check the console log and adjust the `pick(...)`
 * calls in this function.
 */
async function getEquipmentTransactions(rarity, type) {
  const data = await api('/api/market/transactions?limit=200');
  console.log('market/transactions raw payload:', data);
  const rows = asArray(data);

  const matches = rows
    .map((tx) => ({
      itemCode: pick(tx, ['itemCode', 'item', 'code'], ''),
      slot: pick(tx, ['slot', 'equipmentType', 'itemType', 'type'], ''),
      rarity: pick(tx, ['rarity', 'itemRarity', 'quality'], ''),
      price: Number(pick(tx, ['price', 'amount', 'totalPrice', 'value'], null)),
      timestamp: pick(tx, ['createdAt', 'timestamp', 'date', 'time'], null),
    }))
    .filter((tx) => Number.isFinite(tx.price))
    .filter((tx) => {
      const haystack = `${tx.itemCode} ${tx.slot}`.toLowerCase();
      const rarityMatch = tx.rarity
        ? tx.rarity.toString().toLowerCase() === rarity.toLowerCase()
        : haystack.includes(rarity.toLowerCase());
      const typeMatch = haystack.includes(type.toLowerCase());
      return rarityMatch && typeMatch;
    });

  return { all: rows, matches };
}

function renderCraftCard(rarity, type, prices, txResult) {
  const card = $('#craftCard');
  const cost = CRAFT_COST[rarity];
  const scrapsPrice = prices.scraps;
  const steelPrice = prices.steel;
  const haveMaterialPrices = Number.isFinite(scrapsPrice) && Number.isFinite(steelPrice);

  const scrapsCost = haveMaterialPrices ? cost.scraps * scrapsPrice : null;
  const steelCost = haveMaterialPrices ? cost.steel * steelPrice : null;
  const craftTotal = haveMaterialPrices ? scrapsCost + steelCost : null;

  const matches = txResult.matches;
  const avgPrice = matches.length
    ? matches.reduce((sum, tx) => sum + tx.price, 0) / matches.length
    : null;
  const recent = [...matches]
    .sort((a, b) => (b.timestamp ?? 0) < (a.timestamp ?? 0) ? -1 : 1)
    .slice(0, 5);

  card.innerHTML = `
    <div class="craft-card__head">
      <span class="rarity-chip rarity-${rarity}">${rarity}</span>
      <h3>${type}</h3>
    </div>
    <div class="craft-card__body">
      <div class="craft-col">
        <h4>Craft cost <span class="live-tag">live</span></h4>
        <div class="craft-line"><span>${fmtNum(cost.scraps)} Scraps @ ${haveMaterialPrices ? fmtNum(scrapsPrice) : '—'}</span><span class="num">${scrapsCost !== null ? fmtNum(scrapsCost) : '—'}</span></div>
        <div class="craft-line"><span>${fmtNum(cost.steel)} Steel @ ${haveMaterialPrices ? fmtNum(steelPrice) : '—'}</span><span class="num">${steelCost !== null ? fmtNum(steelCost) : '—'}</span></div>
        <div class="craft-line craft-line--total"><span>Total to craft</span><span class="num">${craftTotal !== null ? fmtNum(craftTotal) : '—'}</span></div>
      </div>
      <div class="craft-col">
        <h4>Market price <span class="live-tag">from ${matches.length} sale${matches.length === 1 ? '' : 's'}</span></h4>
        ${
          avgPrice !== null
            ? `
          <div class="craft-line craft-line--total"><span>Avg sale price</span><span class="num">${fmtNum(avgPrice)}</span></div>
          ${recent
            .map(
              (tx) =>
                `<div class="craft-line craft-line--sm"><span>${tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'recent sale'}</span><span class="num">${fmtNum(tx.price)}</span></div>`
            )
            .join('')}
        `
            : `<p class="empty-state" style="padding:10px 0;">No matching transactions found in the last ${txResult.all.length} trades. Check the console log — the item/rarity field names may need adjusting, or this combo just hasn't traded recently. Try widening with a bigger transaction sample or a different rarity.</p>`
        }
      </div>
    </div>
    <div class="craft-verdict" id="craftVerdict"></div>
  `;

  const verdict = $('#craftVerdict');
  if (craftTotal === null || avgPrice === null) {
    verdict.textContent = '';
  } else {
    const savings = avgPrice - craftTotal;
    const pct = craftTotal > 0 ? (savings / craftTotal) * 100 : 0;
    if (savings >= 0) {
      verdict.innerHTML = `<span class="up">Craft it</span> — saves ${fmtNum(savings)} vs. the average sale price (${pct.toFixed(1)}% cheaper to craft)`;
    } else {
      verdict.innerHTML = `<span class="down">Buy it</span> — buying averages ${fmtNum(Math.abs(savings))} cheaper (${Math.abs(pct).toFixed(1)}% cheaper to buy)`;
    }
  }
}

async function loadCraftRoi() {
  const rarity = $('#craftRarity').value;
  const type = $('#craftType').value;
  const card = $('#craftCard');
  card.innerHTML = '<p class="empty-state">loading material prices &amp; transaction history…</p>';

  try {
    const [prices, txResult] = await Promise.all([
      materialPriceCache ?? getMaterialPrices(),
      getEquipmentTransactions(rarity, type),
    ]);
    materialPriceCache = prices;
    renderCraftCard(rarity, type, prices, txResult);
  } catch (err) {
    card.innerHTML = `<p class="empty-state">Failed to load: ${err.message}</p>`;
  }
}

function rollCraftItem() {
  const rarity = weightedPick(RARITY_ODDS);
  const type = weightedPick(TYPE_ODDS);
  $('#craftRarity').value = rarity;
  $('#craftType').value = type;
  loadCraftRoi();
}

// ---- Wire up -------------------------------------------------------------

function init() {
  initTabs();

  $('#marketRefresh').addEventListener('click', loadMarket);
  $('#marketFilter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadMarket();
  });
  $('#rankingsRefresh').addEventListener('click', loadRankings);
  $('#rankingType').addEventListener('change', loadRankings);
  $('#battlesRefresh').addEventListener('click', loadBattles);
  $('#battlesActiveOnly').addEventListener('change', loadBattles);

  $('#craftRoll').addEventListener('click', rollCraftItem);
  $('#craftRarity').addEventListener('change', loadCraftRoi);
  $('#craftType').addEventListener('change', loadCraftRoi);

  loadMarket();
  loadRankings();
  loadBattles();
  loadCraftRoi();
  refreshTicker();
  setInterval(refreshTicker, 20_000);
}

document.addEventListener('DOMContentLoaded', init);
