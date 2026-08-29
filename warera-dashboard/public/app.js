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
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

// Odds a Case has drop each equipment slot: a stated 30% Weapon / 70%
// "other slot" split. WarEra doesn't publish the breakdown *within* that
// 70%, so this assumes the remaining five slots are equally likely —
// flagged as an assumption, not a fact. Used both for a single "roll" and
// as the weighting for a rarity's overall P(profit).
const TYPE_ODDS = { Weapon: 30, Helmet: 14, Chest: 14, Gloves: 14, Pants: 14, Boots: 14 };
const SLOTS = Object.keys(TYPE_ODDS);
const ARMOR_SLOTS = SLOTS.filter((s) => s !== 'Weapon'); // stat-roll grid excludes Weapon

// Sample-size thresholds for the confidence badge. Not a WarEra figure —
// just a reasonable line to draw so a 2-sale "average" isn't presented
// with the same weight as a 500-sale one.
const CONFIDENCE = { high: 100, medium: 20 };

let materialPriceCache = null;
let craftHistoryCache = null; // { fetchedAt, hours, transactions: parsed[] }
let craftHoursWindow = 24;
let selectedRarity = 'epic';
let selectedStatSlot = 'Chest';

async function getMaterialPrices() {
  const data = await api('/api/market/prices');
  const rows = marketRowsFrom(data);
  const map = {};
  rows.forEach(({ item, price }) => { map[item] = price; });
  return map;
}

// Raw materials/goods trade through the same itemMarket transaction log as
// Confirmed live from /api/craft/debug: a transaction record's REAL shape
// is { itemCode, money, quantity, transactionType, item?: { type, code,
// skills: {...} }, createdAt, ... }. Only "itemMarket"-type records with a
// nested item.type === "equipment" are actual gear sales — wage,
// dismantleItem, and openCase records show up in the same log and must be
// filtered out explicitly (the transactionType *request* filter turned
// out to be silently ignored by the API, so filtering happens here,
// client-side, against the real field on each record instead).
//
// Equipment itemCode is like "helmet4" — a slot name plus a digit 1-6
// matching RARITIES' 1-based position (helmet4 → RARITIES[4-1] → "epic").
// Weapon codes (e.g. "knife") don't carry that digit, so weapon rarity is
// still not recoverable from the sale record — that part of the earlier
// "indicative" approach holds up under the real data.
const ARMOR_CODE_PATTERN = /^(helmet|chest|boots|gloves|pants)(\d)$/i;
const ARMOR_CODE_TO_SLOT = { helmet: 'Helmet', chest: 'Chest', boots: 'Boots', gloves: 'Gloves', pants: 'Pants' };

/**
 * Turns one raw transaction record into a normalized shape, or null for
 * records that aren't an equipment market sale (wages, case openings,
 * dismantles, raw-material trades — all share this same log).
 */
function parseTransaction(tx) {
  if (tx.transactionType !== 'itemMarket') return null;
  if (!tx.item || tx.item.type !== 'equipment') return null;

  const itemCode = String(tx.item.code ?? tx.itemCode ?? '');
  const quantity = Number(tx.quantity) || 1;
  const money = Number(tx.money);
  const price = Number.isFinite(money) ? money / quantity : null;

  // First value in `skills` is treated as "the" stat roll, regardless of
  // its name (dodge/armor/precision/attack all appear depending on slot)
  // — good enough to bucket sales by, without hardcoding a name per slot.
  const skillValues = tx.item.skills ? Object.values(tx.item.skills) : [];
  const statValue = Number(skillValues[0]);

  const tsRaw = tx.createdAt ?? tx.timestamp ?? null;
  const timestampMs = tsRaw ? new Date(tsRaw).getTime() : null;

  let rarity = null;
  let slot = null;
  const armorMatch = itemCode.match(ARMOR_CODE_PATTERN);
  if (armorMatch) {
    slot = ARMOR_CODE_TO_SLOT[armorMatch[1].toLowerCase()];
    rarity = RARITIES[Number(armorMatch[2]) - 1] ?? null;
  } else if (itemCode) {
    // Not an armor-pattern code, but still a real equipment sale — a
    // weapon. Rarity genuinely unknown from the code (see note above).
    slot = 'Weapon';
  }

  return {
    itemCode,
    rarity,
    slot,
    price: Number.isFinite(price) ? price : null,
    statValue: Number.isFinite(statValue) ? statValue : null,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
  };
}

async function fetchCraftHistory() {
  const now = Date.now();
  if (craftHistoryCache && now - craftHistoryCache.fetchedAt < 5 * 60_000) {
    return craftHistoryCache.transactions;
  }
  const data = await api('/api/craft/history?hours=24&transactionType=itemMarket');
  console.log('craft history raw payload (first 3):', Array.isArray(data) ? data.slice(0, 3) : data);
  const raw = asArray(data);
  const transactions = raw.map(parseTransaction).filter((tx) => tx !== null && tx.price !== null);
  craftHistoryCache = { fetchedAt: now, transactions };
  return transactions;
}

function withinWindow(transactions, hours) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return transactions.filter((tx) => tx.timestampMs === null || tx.timestampMs >= cutoff);
}

function craftCostFor(rarity, prices) {
  const cost = CRAFT_COST[rarity];
  if (!Number.isFinite(prices.scraps) || !Number.isFinite(prices.steel)) return null;
  return cost.scraps * prices.scraps + cost.steel * prices.steel;
}

function statsFor(transactions, rarity, slot, craftTotal) {
  const matches = transactions.filter((tx) => tx.rarity === rarity && (!slot || tx.slot === slot));
  const count = matches.length;
  const avgPrice = count ? matches.reduce((s, tx) => s + tx.price, 0) / count : null;
  const marginAbs = avgPrice !== null && craftTotal !== null ? avgPrice - craftTotal : null;
  const marginPct = marginAbs !== null && craftTotal > 0 ? (marginAbs / craftTotal) * 100 : null;
  const pProfit = craftTotal !== null && count
    ? (matches.filter((tx) => tx.price > craftTotal).length / count) * 100
    : null;
  return { count, avgPrice, marginAbs, marginPct, pProfit };
}

function confidenceLabel(count) {
  if (count >= CONFIDENCE.high) return { label: 'high confidence', cls: 'high' };
  if (count >= CONFIDENCE.medium) return { label: 'medium confidence', cls: 'medium' };
  if (count > 0) return { label: 'low confidence', cls: 'low' };
  return { label: 'no data', cls: 'none' };
}

function renderRarityGrid(transactions, prices) {
  const grid = $('#rarityGrid');
  const perRarity = RARITIES.map((rarity) => {
    const craftTotal = craftCostFor(rarity, prices);
    // Pools every sale of this rarity across all slots — a reasonable
    // stand-in for a slot-odds-weighted average, since real trade volume
    // per slot roughly tracks the same odds naturally.
    const overall = statsFor(transactions, rarity, null, craftTotal);
    return { rarity, craftTotal, ...overall };
  });

  const best = perRarity
    .filter((r) => r.count >= CONFIDENCE.medium && r.marginPct !== null)
    .sort((a, b) => b.marginPct - a.marginPct)[0];

  grid.innerHTML = perRarity
    .map((r) => {
      const conf = confidenceLabel(r.count);
      const isBest = best && r.rarity === best.rarity;
      const isSelected = r.rarity === selectedRarity;
      const pctText = r.marginPct !== null ? `${r.marginPct >= 0 ? '+' : ''}${r.marginPct.toFixed(1)}%` : '—';
      const pctCls = r.marginPct === null ? '' : r.marginPct >= 0 ? 'up' : 'down';
      return `
        <button class="rarity-card rarity-card--${r.rarity} ${isSelected ? 'is-selected' : ''}" data-rarity="${r.rarity}">
          <div class="rarity-card__top">
            <span class="rarity-chip rarity-${r.rarity}">${r.rarity}</span>
            <span class="confidence-chip confidence-${conf.cls}">${conf.label}</span>
          </div>
          <div class="rarity-card__sample">${r.count} sale${r.count === 1 ? '' : 's'}</div>
          <div class="rarity-card__pct ${pctCls}">${pctText}</div>
          <div class="rarity-card__margin">${r.marginAbs !== null ? `${r.marginAbs >= 0 ? '+' : ''}${fmtNum(r.marginAbs)} per craft` : '—'}</div>
          <div class="rarity-card__foot">
            <span>Cost ${r.craftTotal !== null ? fmtNum(r.craftTotal) : '—'} → Avg ${r.avgPrice !== null ? fmtNum(r.avgPrice) : '—'}</span>
            <span>P(profit) ${r.pProfit !== null ? r.pProfit.toFixed(1) + '%' : '—'}</span>
          </div>
          ${isBest ? '<span class="best-roi-badge">Best ROI</span>' : ''}
        </button>
      `;
    })
    .join('');

  $$('.rarity-card', grid).forEach((card) => {
    card.addEventListener('click', () => {
      selectedRarity = card.dataset.rarity;
      renderCraftRoi();
    });
  });
}

function renderBreakdown(transactions, prices) {
  const el = $('#craftBreakdown');
  const craftTotal = craftCostFor(selectedRarity, prices);

  const rows = SLOTS.map((slot) => {
    // Weapon sales carry no reliable rarity signal in their itemCode (see
    // parseTransaction) — pooling ALL weapon sales here rather than
    // filtering by selectedRarity, and flagging it, beats silently
    // showing zero when data actually exists.
    const s = slot === 'Weapon'
      ? statsFor(transactions, null, slot, craftTotal)
      : statsFor(transactions, selectedRarity, slot, craftTotal);
    const odds = TYPE_ODDS[slot];
    return { slot, odds, ...s, indicative: slot === 'Weapon' };
  });

  el.innerHTML = `
    <div class="breakdown-head">
      <h3>${selectedRarity[0].toUpperCase()}${selectedRarity.slice(1)} — by equipment slot</h3>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Slot</th><th>Odds</th><th>Avg Sale Price</th><th>Margin</th><th>P(profit)</th><th>Sales Seen</th></tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr>
              <td>${r.slot}${r.indicative ? ' <span class="indicative-tag" title="Rarity can\'t be read from weapon sale codes — pooled across all rarities, compared against this rarity\'s craft cost">indicative</span>' : ''}</td>
              <td class="num">${r.odds}%</td>
              <td class="num">${r.avgPrice !== null ? fmtNum(r.avgPrice) : '—'}</td>
              <td class="num ${r.marginAbs === null ? '' : r.marginAbs >= 0 ? 'up' : 'down'}">${r.marginAbs !== null ? `${r.marginAbs >= 0 ? '+' : ''}${fmtNum(r.marginAbs)}` : '—'}</td>
              <td class="num">${r.pProfit !== null ? r.pProfit.toFixed(1) + '%' : '—'}</td>
              <td class="num">${r.count}</td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    </div>
    ${rows.some((r) => r.indicative) ? '<p class="breakdown-footnote">Weapon rarity can\'t be determined from the sale data, so Weapon figures pool sales across all rarities and compare them against the selected rarity\'s craft cost — treat as a rough estimate, not a precise one.</p>' : ''}
  `;
}

function renderStatRollSection(transactions, prices) {
  const el = $('#statrollSection');
  const craftTotal = craftCostFor(selectedRarity, prices);
  const matches = transactions.filter((tx) => tx.rarity === selectedRarity && tx.slot === selectedStatSlot);
  const withStat = matches.filter((tx) => tx.statValue !== null);

  const tabs = ARMOR_SLOTS
    .map((slot) => `<button class="statroll-tab ${slot === selectedStatSlot ? 'is-active' : ''}" data-slot="${slot}">${slot}</button>`)
    .join('');

  if (withStat.length === 0) {
    el.innerHTML = `
      <div class="statroll-head">
        <h3>Value per stat roll</h3>
        <div class="statroll-tabs">${tabs}</div>
      </div>
      <p class="empty-state">
        No stat-roll value found in the transaction data for ${selectedRarity} ${selectedStatSlot}
        in this window (${matches.length} sale${matches.length === 1 ? '' : 's'} matched, but none carried a
        recognizable stat field). Check the console log for the raw transaction shape —
        the field name may need adjusting in <code>parseTransaction()</code>, or this
        combo just hasn't traded recently.
      </p>
    `;
  } else {
    const byValue = new Map();
    withStat.forEach((tx) => {
      if (!byValue.has(tx.statValue)) byValue.set(tx.statValue, []);
      byValue.get(tx.statValue).push(tx.price);
    });
    const rows = [...byValue.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([statValue, prices2]) => {
        const avg = prices2.reduce((s, p) => s + p, 0) / prices2.length;
        const diff = craftTotal !== null ? avg - craftTotal : null;
        return { statValue, count: prices2.length, avg, diff };
      });

    el.innerHTML = `
      <div class="statroll-head">
        <h3>Value per stat roll — ${selectedRarity} ${selectedStatSlot}</h3>
        <div class="statroll-tabs">${tabs}</div>
      </div>
      <div class="statroll-grid">
        ${rows
          .map(
            (r) => `
          <div class="statroll-card">
            <div class="statroll-card__value">${r.statValue}</div>
            <div class="statroll-card__count">${r.count}× seen</div>
            <div class="statroll-card__price">${fmtNum(r.avg)}</div>
            <div class="statroll-card__diff ${r.diff === null ? '' : r.diff >= 0 ? 'up' : 'down'}">${r.diff !== null ? `${r.diff >= 0 ? '+' : ''}${fmtNum(r.diff)} vs craft` : ''}</div>
          </div>
        `
          )
          .join('')}
      </div>
    `;
  }

  $$('.statroll-tab', el).forEach((tab) => {
    tab.addEventListener('click', () => {
      selectedStatSlot = tab.dataset.slot;
      renderCraftRoi();
    });
  });
}

async function renderCraftRoi() {
  const grid = $('#rarityGrid');
  const breakdown = $('#craftBreakdown');
  const statroll = $('#statrollSection');

  try {
    const [prices, allTransactions] = await Promise.all([
      materialPriceCache ?? getMaterialPrices(),
      fetchCraftHistory(),
    ]);
    materialPriceCache = prices;
    const windowed = withinWindow(allTransactions, craftHoursWindow);

    renderRarityGrid(windowed, prices);
    renderBreakdown(windowed, prices);
    renderStatRollSection(windowed, prices);
  } catch (err) {
    grid.innerHTML = `<p class="empty-state">Failed to load: ${err.message}</p>`;
    breakdown.innerHTML = '';
    statroll.innerHTML = '';
  }
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

  $('#craftRefresh').addEventListener('click', () => {
    craftHistoryCache = null; // force a fresh fetch
    renderCraftRoi();
  });
  $$('#timeFilter button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#timeFilter button').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      craftHoursWindow = Number(btn.dataset.hours);
      renderCraftRoi();
    });
  });

  loadMarket();
  loadRankings();
  loadBattles();
  renderCraftRoi();
  refreshTicker();
  setInterval(refreshTicker, 20_000);
}

document.addEventListener('DOMContentLoaded', init);
