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

// User-confirmed in-game (not from any documented API field): each weapon
// name is its own single rarity tier, the same way each armor piece has
// exactly one rarity per digit. Not independently verifiable against a
// schema the way armor's digit-suffix pattern was — if a name shows up
// that isn't in this map, its rarity is left unknown rather than guessed.
const WEAPON_NAME_TO_RARITY = {
  knife: 'common',
  gun: 'uncommon',
  rifle: 'rare',
  sniper: 'epic',
  tank: 'legendary',
  jet: 'mythic',
};

// Sample-size thresholds for the confidence badge. Not a WarEra figure —
// just a reasonable line to draw so a 2-sale "average" isn't presented
// with the same weight as a 500-sale one.
const CONFIDENCE = { high: 100, medium: 20 };

let craftHistoryCache = null; // { fetchedAt, hours, transactions: parsed[] }
let craftHoursWindow = 24;
// Two independent ways to pick which sales feed each stat-roll bucket's
// average: 'window' (the hours buttons, with fallback — see buildStatBuckets)
// or 'lastN' (each combination's own N most recent sales, regardless of
// when they happened — see buildStatBucketsLastN).
let recencyMode = 'window';
let lastNCount = 2;
let selectedRarity = 'epic';
let selectedStatSlot = 'Chest';
// null = use the live price fetched below; a number = manual override,
// entered via the inputs in the Craft ROI panel.
let scrapsPriceOverride = null;
let steelPriceOverride = null;

async function getMaterialPrices() {
  const data = await api('/api/market/prices');
  const rows = marketRowsFrom(data);
  const map = {};
  rows.forEach(({ item, price }) => { map[item] = price; });

  // itemTrading.getPrices (above) turned out to be some other reference
  // number, not the price you'd actually pay to buy right now — it was
  // off from the real order book by a meaningful amount. The true cost
  // to instantly acquire a material is the cheapest active SELL order, so
  // fetch the real order book for scraps/steel specifically and prefer
  // that, falling back to the reference price only if the order book
  // fetch fails or its shape doesn't parse as expected.
  const [scrapsAsk, steelAsk] = await Promise.all([
    getBestAskPrice('scraps', map.scraps),
    getBestAskPrice('steel', map.steel),
  ]);
  map.scraps = scrapsAsk;
  map.steel = steelAsk;
  return map;
}

/**
 * Cheapest active sell (ask) order for an item — what you'd actually pay
 * to buy it right now, as opposed to itemTrading.getPrices' reference
 * number. tradingOrder.getTopOrders' response shape isn't independently
 * confirmed, so this logs the raw payload and tries a few plausible field
 * names for "which side is this order on" and "what's its price" — if the
 * resulting cost still looks wrong, check that console log for the real
 * field names.
 */
async function getBestAskPrice(itemCode, fallbackPrice) {
  try {
    const res = await fetch(`/api/market/orders?item=${itemCode}`);
    const body = await res.json();
    if (!res.ok || body.ok === false) throw new Error(body.error || 'orders fetch failed');
    console.log(`top orders for ${itemCode}:`, body.data);

    const orders = asArray(body.data);
    const sellOrders = orders.filter((o) => {
      const side = String(pick(o, ['side', 'type', 'orderType', 'kind'], '')).toLowerCase();
      return side.includes('sell') || side.includes('ask');
    });
    const candidates = (sellOrders.length ? sellOrders : orders)
      .map((o) => Number(pick(o, ['price', 'unitPrice', 'askPrice', 'sellPrice'], null)))
      .filter(Number.isFinite);

    if (candidates.length === 0) {
      console.warn(`no usable sell price found for ${itemCode} in orders response — using reference price instead`);
      return fallbackPrice;
    }
    return Math.min(...candidates);
  } catch (err) {
    console.warn(`best-ask fetch failed for ${itemCode}, falling back to reference price:`, err.message);
    return fallbackPrice;
  }
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
  // Not requiring tx.item.type === 'equipment' specifically — real data
  // showed weapon sales vanishing under that check despite confirmed high
  // real volume, while every armor category came through fine. A nested
  // item object with a code is enough to know it's gear (armor or weapon)
  // rather than a raw-material trade, without assuming an exact type string.
  if (!tx.item || !tx.item.code) return null;

  const itemCode = String(tx.item.code ?? tx.itemCode ?? '');
  const quantity = Number(tx.quantity) || 1;
  const money = Number(tx.money);
  const price = Number.isFinite(money) ? money / quantity : null;

  // Armor has one stat (dodge/armor/precision); weapons have two (attack +
  // critChance) — a craft rolls ALL of them together as one combination,
  // so they're grouped as a unit (statKey), not averaged separately. Kept
  // sorted by stat name so the same combination always produces the same
  // key regardless of the order fields happened to arrive in.
  const skills = tx.item.skills && typeof tx.item.skills === 'object' ? tx.item.skills : {};
  const skillEntries = Object.entries(skills)
    .filter(([, v]) => Number.isFinite(Number(v)))
    .sort(([a], [b]) => a.localeCompare(b));
  const statKey = skillEntries.length ? skillEntries.map(([k, v]) => `${k}:${v}`).join('|') : null;
  const statLabel = skillEntries.length ? skillEntries.map(([, v]) => v).join(' / ') : null;

  const tsRaw = tx.createdAt ?? tx.timestamp ?? null;
  const timestampMs = tsRaw ? new Date(tsRaw).getTime() : null;

  let rarity = null;
  let slot = null;
  const armorMatch = itemCode.match(ARMOR_CODE_PATTERN);
  if (armorMatch) {
    slot = ARMOR_CODE_TO_SLOT[armorMatch[1].toLowerCase()];
    rarity = RARITIES[Number(armorMatch[2]) - 1] ?? null;
  } else if (itemCode) {
    slot = 'Weapon';
    rarity = WEAPON_NAME_TO_RARITY[itemCode.toLowerCase()] ?? null;
  }

  return {
    itemCode,
    rarity,
    slot,
    price: Number.isFinite(price) ? price : null,
    statKey,
    statLabel,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
  };
}

let craftIngestStatus = null; // { storeSize, ingestActive, typeCounts } — for the coverage note

async function fetchCraftHistory() {
  const now = Date.now();
  if (craftHistoryCache && now - craftHistoryCache.fetchedAt < 20_000) {
    return craftHistoryCache.transactions;
  }
  const res = await fetch('/api/craft/history?hours=24');
  const body = await res.json();
  if (!res.ok || body.ok === false) throw new Error(body.error || 'Failed to load transaction history');
  console.log('craft history status:', { storeSize: body.storeSize, ingestActive: body.ingestActive, typeCounts: body.typeCounts });
  console.log('item codes collected so far:', body.itemCodeCounts);
  craftIngestStatus = { storeSize: body.storeSize, ingestActive: body.ingestActive, typeCounts: body.typeCounts };
  const raw = asArray(body.data);
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
  const scrapsPrice = Number.isFinite(scrapsPriceOverride) ? scrapsPriceOverride : prices.scraps;
  const steelPrice = Number.isFinite(steelPriceOverride) ? steelPriceOverride : prices.steel;
  if (!Number.isFinite(scrapsPrice) || !Number.isFinite(steelPrice)) return null;
  return cost.scraps * scrapsPrice + cost.steel * steelPrice;
}

/**
 * Groups sales by exact stat-roll combination (statKey) and averages
 * price within each combination, then averages those bucket-averages
 * together (unweighted) — a craft has roughly equal odds of landing on
 * any combination, so a straight average of raw sales would be skewed by
 * however the mix happened to trade recently.
 *
 * Takes BOTH the recency-windowed sales and the full ~24h history: for
 * each bucket, prefers the windowed price (freshest) but falls back to
 * the full-history price for that specific bucket if the window has zero
 * sales for it. Without this, a real but infrequently-traded combination
 * (e.g. a top-roll item that sold once 8h ago but not in the last hour)
 * would silently vanish from the estimate on a short window — not because
 * it's rare, but because the window happened to miss it.
 */
function buildStatBuckets(windowedMatches, fullMatches) {
  const fullByKey = new Map(); // statKey -> { label, prices: [] }
  fullMatches.forEach((tx) => {
    if (tx.statKey === null) return;
    if (!fullByKey.has(tx.statKey)) fullByKey.set(tx.statKey, { label: tx.statLabel, prices: [], recentPrices: [] });
    fullByKey.get(tx.statKey).prices.push(tx.price);
  });
  windowedMatches.forEach((tx) => {
    if (tx.statKey === null || !fullByKey.has(tx.statKey)) return;
    fullByKey.get(tx.statKey).recentPrices.push(tx.price);
  });

  return [...fullByKey.entries()].map(([key, { label, prices, recentPrices }]) => {
    const usedPrices = recentPrices.length > 0 ? recentPrices : prices;
    const avg = usedPrices.reduce((s, p) => s + p, 0) / usedPrices.length;
    return { key, label, avg, totalCount: prices.length, usedCount: usedPrices.length, isFallback: recentPrices.length === 0 };
  });
}

/**
 * Alternate mode: instead of a shared time window, takes each specific
 * combination's own N most recent sales, whenever they happened. Two
 * combinations that trade at very different frequencies (a common combo
 * with 50 sales/day vs a rare one with 2/week) both get "how has *this*
 * combo actually been selling lately" on equal footing — a fixed time
 * window would show a rich recent sample for one and nothing for the
 * other, even though both are equally "current" for their own frequency.
 */
function buildStatBucketsLastN(fullMatches, n) {
  const byKey = new Map(); // statKey -> { label, txs: [] }
  fullMatches.forEach((tx) => {
    if (tx.statKey === null) return;
    if (!byKey.has(tx.statKey)) byKey.set(tx.statKey, { label: tx.statLabel, txs: [] });
    byKey.get(tx.statKey).txs.push(tx);
  });

  return [...byKey.entries()].map(([key, { label, txs }]) => {
    const sorted = [...txs].sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0));
    const used = sorted.slice(0, n);
    const avg = used.reduce((s, tx) => s + tx.price, 0) / used.length;
    return { key, label, avg, totalCount: txs.length, usedCount: used.length, isFallback: false };
  });
}

// Dispatches to whichever recency mode is currently selected — everything
// downstream (rarity cards, breakdown table, stat-roll grid) reads
// through this, so switching modes updates all of them consistently.
function getStatBuckets(windowedMatches, fullMatches) {
  return recencyMode === 'lastN'
    ? buildStatBucketsLastN(fullMatches, lastNCount)
    : buildStatBuckets(windowedMatches, fullMatches);
}

function statsFor(windowedTx, fullTx, rarity, slot, craftTotal) {
  const windowedMatches = windowedTx.filter((tx) => tx.rarity === rarity && (!slot || tx.slot === slot));
  const fullMatches = fullTx.filter((tx) => tx.rarity === rarity && (!slot || tx.slot === slot));
  const count = fullMatches.length; // total sample backing this row (full ~24h), not just the recency window
  if (count === 0) return { count: 0, usedCount: 0, avgPrice: null, marginAbs: null, marginPct: null, pProfit: null };

  const withStat = fullMatches.filter((tx) => tx.statKey !== null);
  let avgPrice;
  let pProfit;
  let usedCount;

  if (withStat.length > 0) {
    const buckets = getStatBuckets(windowedMatches, fullMatches);
    avgPrice = buckets.reduce((s, b) => s + b.avg, 0) / buckets.length;
    pProfit = craftTotal !== null
      ? (buckets.filter((b) => b.avg > craftTotal).length / buckets.length) * 100
      : null;
    // How many individual sales actually fed the price above — as
    // opposed to `count`, which is every sale ever collected for this
    // row regardless of whether it was used (see the "sales" vs "used"
    // distinction surfaced in the UI).
    usedCount = buckets.reduce((s, b) => s + b.usedCount, 0);
  } else {
    // No stat-roll data at all for this slot — fall back to a plain
    // average, preferring the recency window if it has any sales.
    const priceSource = windowedMatches.length > 0 ? windowedMatches : fullMatches;
    avgPrice = priceSource.reduce((s, tx) => s + tx.price, 0) / priceSource.length;
    pProfit = craftTotal !== null ? (priceSource.filter((tx) => tx.price > craftTotal).length / priceSource.length) * 100 : null;
    usedCount = priceSource.length;
  }

  const marginAbs = avgPrice !== null && craftTotal !== null ? avgPrice - craftTotal : null;
  const marginPct = marginAbs !== null && craftTotal > 0 ? (marginAbs / craftTotal) * 100 : null;
  return { count, usedCount, avgPrice, marginAbs, marginPct, pProfit };
}

function confidenceLabel(count) {
  if (count >= CONFIDENCE.high) return { label: 'high confidence', cls: 'high' };
  if (count >= CONFIDENCE.medium) return { label: 'medium confidence', cls: 'medium' };
  if (count > 0) return { label: 'low confidence', cls: 'low' };
  return { label: 'no data', cls: 'none' };
}

/**
 * Combines per-slot stats into one rarity-level figure, weighted by each
 * slot's real Case odds (30% Weapon, 14% each armor piece) — NOT by
 * pooling raw sale counts together. Armor sells far more often than
 * weapons on the open market (confirmed against real usage, not assumed),
 * so an unweighted pool of individual sales would let armor's margin
 * drown out weapon's true 30% share of what a craft actually produces.
 * Slots with zero sample are excluded and the remaining odds renormalized,
 * rather than treating a missing slot as zero.
 */
function weightedSlotCombine(slotStats) {
  const withData = slotStats.filter((s) => s.avgPrice !== null);
  const totalCount = slotStats.reduce((sum, s) => sum + s.count, 0);
  const totalUsedCount = slotStats.reduce((sum, s) => sum + (s.usedCount ?? 0), 0);
  if (withData.length === 0) return { count: totalCount, usedCount: totalUsedCount, avgPrice: null, pProfit: null };

  const totalOdds = withData.reduce((sum, s) => sum + s.odds, 0);
  const avgPrice = withData.reduce((sum, s) => sum + s.avgPrice * s.odds, 0) / totalOdds;

  const withProfit = withData.filter((s) => s.pProfit !== null);
  const pProfit = withProfit.length > 0
    ? withProfit.reduce((sum, s) => sum + s.pProfit * s.odds, 0) / withProfit.reduce((sum, s) => sum + s.odds, 0)
    : null;

  return { count: totalCount, usedCount: totalUsedCount, avgPrice, pProfit };
}

function renderRarityGrid(windowedTx, fullTx, prices) {
  const grid = $('#rarityGrid');
  const perRarity = RARITIES.map((rarity) => {
    const craftTotal = craftCostFor(rarity, prices);
    const slotStats = SLOTS.map((slot) => ({
      odds: TYPE_ODDS[slot],
      ...statsFor(windowedTx, fullTx, rarity, slot, craftTotal),
    }));
    const overall = weightedSlotCombine(slotStats);
    const marginAbs = overall.avgPrice !== null && craftTotal !== null ? overall.avgPrice - craftTotal : null;
    const marginPct = marginAbs !== null && craftTotal > 0 ? (marginAbs / craftTotal) * 100 : null;
    return { rarity, craftTotal, ...overall, marginAbs, marginPct };
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
          <div class="rarity-card__sample">${r.count} sale${r.count === 1 ? '' : 's'} (24h) <span class="used-tag">· ${r.usedCount} used</span></div>
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

function renderBreakdown(windowedTx, fullTx, prices) {
  const el = $('#craftBreakdown');
  const craftTotal = craftCostFor(selectedRarity, prices);

  const rows = SLOTS.map((slot) => {
    const s = statsFor(windowedTx, fullTx, selectedRarity, slot, craftTotal);
    const odds = TYPE_ODDS[slot];
    // Weapon rarity comes from a player-confirmed name→rarity mapping
    // (WEAPON_NAME_TO_RARITY), not a documented API field — flagged
    // lightly so it's clear that row rests on slightly different footing
    // than armor's digit-suffix parsing, without implying the data itself
    // is unreliable.
    return { slot, odds, ...s, unverified: slot === 'Weapon' };
  });

  el.innerHTML = `
    <div class="breakdown-head">
      <h3>${selectedRarity[0].toUpperCase()}${selectedRarity.slice(1)} — by equipment slot</h3>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Slot</th><th>Odds</th><th>Avg Sale Price</th><th>Margin</th><th>P(profit)</th><th>Sales (24h / used)</th></tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr>
              <td>${r.slot}${r.unverified ? ' <span class="indicative-tag" title="Rarity comes from a player-confirmed weapon name mapping, not a documented API field">unverified mapping</span>' : ''}</td>
              <td class="num">${r.odds}%</td>
              <td class="num">${r.avgPrice !== null ? fmtNum(r.avgPrice) : '—'}</td>
              <td class="num ${r.marginAbs === null ? '' : r.marginAbs >= 0 ? 'up' : 'down'}">${r.marginAbs !== null ? `${r.marginAbs >= 0 ? '+' : ''}${fmtNum(r.marginAbs)}` : '—'}</td>
              <td class="num">${r.pProfit !== null ? r.pProfit.toFixed(1) + '%' : '—'}</td>
              <td class="num">${r.count} / ${r.usedCount}</td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Shared grid renderer for the stat-roll section — one card per stat-roll
 * combination, delegating bucket construction to getStatBuckets so it
 * automatically reflects whichever recency mode (time window vs last-N
 * sales per combination) is currently selected.
 */
function statRollGridHtml(windowedMatches, fullMatches, craftTotal) {
  if (fullMatches.filter((tx) => tx.statKey !== null).length === 0) return null;

  const buckets = getStatBuckets(windowedMatches, fullMatches)
    .map((b) => ({ ...b, diff: craftTotal !== null ? b.avg - craftTotal : null }))
    // Sort by the first number in the label (works for both single-stat
    // "24" and multi-stat "128 / 16" combinations).
    .sort((a, b) => parseFloat(a.label) - parseFloat(b.label));

  const countLabel = (r) =>
    recencyMode === 'lastN'
      ? `${r.usedCount} of ${r.totalCount}× used`
      : `${r.totalCount}× seen${r.isFallback ? ' <span class="stale-tag">older</span>' : ''}`;

  return `
    <div class="statroll-grid">
      ${buckets
        .map(
          (r) => `
        <div class="statroll-card${r.isFallback ? ' statroll-card--stale' : ''}" ${r.isFallback ? 'title="No sale in the selected window — showing this combination\'s most recent known price instead"' : ''}>
          <div class="statroll-card__value">${r.label}</div>
          <div class="statroll-card__count">${countLabel(r)}</div>
          <div class="statroll-card__price">${fmtNum(r.avg)}</div>
          <div class="statroll-card__diff ${r.diff === null ? '' : r.diff >= 0 ? 'up' : 'down'}">${r.diff !== null ? `${r.diff >= 0 ? '+' : ''}${fmtNum(r.diff)} vs craft` : ''}</div>
        </div>
      `
        )
        .join('')}
    </div>
  `;
}

function renderStatRollSection(windowedTx, fullTx, prices) {
  const el = $('#statrollSection');
  const craftTotal = craftCostFor(selectedRarity, prices);
  const windowedMatches = windowedTx.filter((tx) => tx.rarity === selectedRarity && tx.slot === selectedStatSlot);
  const fullMatches = fullTx.filter((tx) => tx.rarity === selectedRarity && tx.slot === selectedStatSlot);

  const tabs = SLOTS
    .map((slot) => `<button class="statroll-tab ${slot === selectedStatSlot ? 'is-active' : ''}" data-slot="${slot}">${slot}</button>`)
    .join('');

  const grid = statRollGridHtml(windowedMatches, fullMatches, craftTotal);
  const weaponNote = selectedStatSlot === 'Weapon'
    ? '<p class="breakdown-footnote">Weapon stat rolls combine two values (e.g. attack / crit chance) — each card is one full combination, not a single stat.</p>'
    : '';
  const staleNote = grid && grid.includes('statroll-card--stale')
    ? '<p class="breakdown-footnote">Cards marked "older" had no sale in the selected time window — showing their most recent known price from the full ~24h history instead of hiding them.</p>'
    : '';

  el.innerHTML = grid
    ? `
      <div class="statroll-head">
        <h3>Value per stat roll — ${selectedRarity} ${selectedStatSlot}</h3>
        <div class="statroll-tabs">${tabs}</div>
      </div>
      ${grid}
      ${weaponNote}
      ${staleNote}
    `
    : `
      <div class="statroll-head">
        <h3>Value per stat roll</h3>
        <div class="statroll-tabs">${tabs}</div>
      </div>
      <p class="empty-state">
        No stat-roll value found in the transaction data for ${selectedRarity} ${selectedStatSlot}
        in the full ~24h history (${fullMatches.length} sale${fullMatches.length === 1 ? '' : 's'} matched, but none carried a
        recognizable stat field). Check the console log for the raw transaction shape —
        the field name may need adjusting in <code>parseTransaction()</code>, or this
        combo just hasn't traded recently.
      </p>
    `;

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
  const note = $('#craftNote');

  try {
    const [prices, allTransactions] = await Promise.all([
      getMaterialPrices(), // always fresh — server caches this itself for 30s, so no staleness risk from calling it every render
      fetchCraftHistory(),
    ]);
    const windowed = withinWindow(allTransactions, craftHoursWindow);

    renderRarityGrid(windowed, allTransactions, prices);
    renderBreakdown(windowed, allTransactions, prices);
    renderStatRollSection(windowed, allTransactions, prices);

    if (craftIngestStatus) {
      const equipCount = allTransactions.length;
      const modeText = recencyMode === 'lastN'
        ? `Using each combination's last ${lastNCount} sale${lastNCount === 1 ? '' : 's'}, whenever they happened.`
        : `Using sales from the last ${craftHoursWindow}h (falls back to older data per combination if the window has none).`;
      const overrideParts = [];
      if (Number.isFinite(scrapsPriceOverride)) overrideParts.push(`scraps @ ${fmtNum(scrapsPriceOverride)}`);
      if (Number.isFinite(steelPriceOverride)) overrideParts.push(`steel @ ${fmtNum(steelPriceOverride)}`);
      const overrideText = overrideParts.length ? ` Using manual price for ${overrideParts.join(' and ')} (not live).` : '';
      const coverage = craftIngestStatus.ingestActive
        ? `Building up live — ${equipCount} equipment sales collected so far. ${modeText}${overrideText}`
        : `Data collection isn't running (check WARERA_API_KEY) — showing whatever was collected before it stopped.`;
      note.textContent = coverage;
    }
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
      recencyMode = 'window';
      craftHoursWindow = Number(btn.dataset.hours);
      $$('#timeFilter button').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      $$('#lastNFilter button').forEach((b) => b.classList.remove('is-active'));
      renderCraftRoi();
    });
  });
  $$('#lastNFilter button').forEach((btn) => {
    btn.addEventListener('click', () => {
      recencyMode = 'lastN';
      lastNCount = Number(btn.dataset.lastn);
      $$('#lastNFilter button').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      $$('#timeFilter button').forEach((b) => b.classList.remove('is-active'));
      renderCraftRoi();
    });
  });

  $('#scrapsOverride').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    scrapsPriceOverride = Number.isFinite(v) ? v : null;
    renderCraftRoi();
  });
  $('#steelOverride').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    steelPriceOverride = Number.isFinite(v) ? v : null;
    renderCraftRoi();
  });
  $('#clearOverrides').addEventListener('click', () => {
    scrapsPriceOverride = null;
    steelPriceOverride = null;
    $('#scrapsOverride').value = '';
    $('#steelOverride').value = '';
    renderCraftRoi();
  });

  loadMarket();
  loadRankings();
  loadBattles();
  renderCraftRoi();
  refreshTicker();
  setInterval(refreshTicker, 20_000);
  // The background ingest store grows continuously server-side — refresh
  // periodically so the numbers visibly fill in without manual refreshing.
  setInterval(() => {
    if ($('#panel-craft').classList.contains('is-active')) renderCraftRoi();
  }, 30_000);
}

document.addEventListener('DOMContentLoaded', init);
