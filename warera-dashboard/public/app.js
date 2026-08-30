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
// Confirmed directly from the in-game "Open Case" screen (screenshot):
// 62% Common, 30% Uncommon, 7.1% Rare, 0.85% Epic, 0.04% Legendary, 0.01%
// Mythic — and, per the same confirmation, equipment TYPE within a given
// rarity follows the same odds as crafting (TYPE_ODDS above), independent
// of rarity. So full outcome probability = RARITY_ODDS × TYPE_ODDS.
const RARITY_ODDS = { common: 62, uncommon: 30, rare: 7.1, epic: 0.85, legendary: 0.04, mythic: 0.01 };
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
// 'ask' (default) = cheapest active sell order, what buying instantly
// actually costs. 'bid' = highest active buy order, what patient buyers
// are already offering. Only matters when there's no manual override.
let priceSide = 'ask';

async function getMaterialPrices() {
  const data = await api('/api/market/prices');
  const rows = marketRowsFrom(data);
  const map = {};
  rows.forEach(({ item, price }) => { map[item] = price; });

  // itemTrading.getPrices (above) turned out to be some other reference
  // number, not the price you'd actually pay to buy right now — it was
  // off from the real order book by a meaningful amount. The true cost
  // to instantly acquire a material is the cheapest active SELL order
  // (ask), or, if you'd rather see what patient buyers are already
  // offering instead of paying to buy instantly, the highest active BUY
  // order (bid) — see priceSide. Falls back to the reference price only
  // if the order book fetch fails or its shape doesn't parse as expected.
  const [scrapsPrice, steelPrice] = await Promise.all([
    getOrderBookPrice('scraps', map.scraps),
    getOrderBookPrice('steel', map.steel),
  ]);
  map.scraps = scrapsPrice;
  map.steel = steelPrice;
  return map;
}

/**
 * Best active order for an item on the selected side — cheapest sell
 * (ask, the default: what you'd pay to buy instantly) or highest buy
 * (bid: what patient buyers are already offering). Confirmed live (via
 * console): tradingOrder.getTopOrders returns
 * { buyOrders: [...], sellOrders: [...] }, each order having a numeric
 * `price` field — no side/type field needed, the two books are already
 * split out.
 */
async function getOrderBookPrice(itemCode, fallbackPrice, sideOverride) {
  const side = sideOverride ?? priceSide;
  try {
    const res = await fetch(`/api/market/orders?item=${itemCode}`);
    const body = await res.json();
    if (!res.ok || body.ok === false) throw new Error(body.error || 'orders fetch failed');

    const key = side === 'bid' ? 'buyOrders' : 'sellOrders';
    const orders = Array.isArray(body.data?.[key]) ? body.data[key] : [];
    const prices = orders.map((o) => Number(o.price)).filter(Number.isFinite);

    if (prices.length === 0) {
      console.warn(`no ${side} orders found for ${itemCode} — using reference price instead`);
      return fallbackPrice;
    }
    return side === 'bid' ? Math.max(...prices) : Math.min(...prices);
  } catch (err) {
    console.warn(`order-book fetch failed for ${itemCode}, falling back to reference price:`, err.message);
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
let rawHistoryCache = null; // { fetchedAt, raw } — shared underlying fetch for both Craft ROI and Cases tabs

async function fetchRawHistory() {
  const now = Date.now();
  if (rawHistoryCache && now - rawHistoryCache.fetchedAt < 20_000) {
    return rawHistoryCache.raw;
  }
  const res = await fetch('/api/craft/history?hours=168'); // 7 days — the 1h-24h window buttons still control the "preferred/fresh" side; this widens how far the fallback can reach
  const body = await res.json();
  if (!res.ok || body.ok === false) throw new Error(body.error || 'Failed to load transaction history');
  console.log('craft history status:', { storeSize: body.storeSize, ingestActive: body.ingestActive, typeCounts: body.typeCounts });
  console.log('item codes collected so far:', body.itemCodeCounts);
  craftIngestStatus = { storeSize: body.storeSize, ingestActive: body.ingestActive, typeCounts: body.typeCounts };
  const raw = asArray(body.data);
  rawHistoryCache = { fetchedAt: now, raw };
  return raw;
}

async function fetchCraftHistory() {
  const raw = await fetchRawHistory();
  return raw.map(parseTransaction).filter((tx) => tx !== null && tx.price !== null);
}

/**
 * openCase records: { itemCode: <case code>, item: { code: <what came out>, ... } }.
 * Confirmed live earlier in this project (itemCode: "case1", item.code: "gloves1").
 */
function parseCaseOpen(tx) {
  if (tx.transactionType !== 'openCase') return null;
  if (!tx.item || !tx.item.code) return null;

  const caseCode = String(tx.itemCode ?? '');
  const resultCode = String(tx.item.code);
  let resultRarity = null;
  let resultSlot = null;
  const armorMatch = resultCode.match(ARMOR_CODE_PATTERN);
  if (armorMatch) {
    resultSlot = ARMOR_CODE_TO_SLOT[armorMatch[1].toLowerCase()];
    resultRarity = RARITIES[Number(armorMatch[2]) - 1] ?? null;
  } else if (resultCode) {
    resultSlot = 'Weapon';
    resultRarity = WEAPON_NAME_TO_RARITY[resultCode.toLowerCase()] ?? null;
  }

  const tsRaw = tx.createdAt ?? null;
  return {
    caseCode,
    resultCode,
    resultRarity,
    resultSlot,
    timestampMs: tsRaw ? new Date(tsRaw).getTime() : null,
  };
}

/**
 * dismantleItem records: { itemCode: <material received, e.g. "scraps">,
 * quantity: <amount>, item: { code: <what was dismantled>, ... } }.
 */
function parseDismantle(tx) {
  if (tx.transactionType !== 'dismantleItem') return null;
  if (!tx.item || !tx.item.code) return null;

  const materialCode = String(tx.itemCode ?? '');
  const quantity = Number(tx.quantity) || 0;
  const sourceCode = String(tx.item.code);
  let sourceRarity = null;
  let sourceSlot = null;
  const armorMatch = sourceCode.match(ARMOR_CODE_PATTERN);
  if (armorMatch) {
    sourceSlot = ARMOR_CODE_TO_SLOT[armorMatch[1].toLowerCase()];
    sourceRarity = RARITIES[Number(armorMatch[2]) - 1] ?? null;
  } else if (sourceCode) {
    sourceSlot = 'Weapon';
    sourceRarity = WEAPON_NAME_TO_RARITY[sourceCode.toLowerCase()] ?? null;
  }

  const tsRaw = tx.createdAt ?? null;
  return {
    materialCode,
    quantity,
    sourceRarity,
    sourceSlot,
    timestampMs: tsRaw ? new Date(tsRaw).getTime() : null,
  };
}

async function fetchCaseOpens() {
  const raw = await fetchRawHistory();
  return raw.map(parseCaseOpen).filter((x) => x !== null);
}

async function fetchDismantles() {
  const raw = await fetchRawHistory();
  return raw.map(parseDismantle).filter((x) => x !== null);
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
 * Takes BOTH the recency-windowed sales and the full collected history (up to 7 days): for
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
  const count = fullMatches.length; // total sample backing this row (full collected history), not just the recency window
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
          <div class="rarity-card__sample">${r.count} sale${r.count === 1 ? '' : 's'} (7d) <span class="used-tag">· ${r.usedCount} used</span></div>
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
          <tr><th>Slot</th><th>Odds</th><th>Avg Sale Price</th><th>Margin</th><th>P(profit)</th><th>Sales (7d / used)</th></tr>
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
    ? '<p class="breakdown-footnote">Cards marked "older" had no sale in the selected time window — showing their most recent known price from the full collected history (up to 7 days) instead of hiding them.</p>'
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
        in the full collected history (up to 7 days) (${fullMatches.length} sale${fullMatches.length === 1 ? '' : 's'} matched, but none carried a
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
      const sideText = !overrideParts.length && priceSide === 'bid'
        ? ' Using the current best BID (what buyers are offering), not the ask.'
        : '';
      const coverage = craftIngestStatus.ingestActive
        ? `Building up live — ${equipCount} equipment sales collected so far. ${modeText}${overrideText}${sideText}`
        : `Data collection isn't running (check WARERA_API_KEY) — showing whatever was collected before it stopped.`;
      note.textContent = coverage;
    }
  } catch (err) {
    grid.innerHTML = `<p class="empty-state">Failed to load: ${err.message}</p>`;
    breakdown.innerHTML = '';
    statroll.innerHTML = '';
  }
}

// ---- Cases (Case ROI) ------------------------------------------------------

// Which real market items look like case SKUs — auto-discovered rather than
// hardcoded, since case pricing/naming isn't confirmed (a much earlier
// itemTrading.getPrices dump appeared to show "case"-like keys, but that
// was never independently verified against this specific use).
async function discoverCasePrices() {
  const data = await api('/api/market/prices');
  const rows = marketRowsFrom(data);
  const caseRows = rows.filter((r) => r.item.toLowerCase().includes('case'));

  // Same fix already applied to scraps/steel in getMaterialPrices():
  // itemTrading.getPrices is some other reference number, not what you'd
  // actually pay — use the real order book's cheapest active sell order
  // instead, falling back to the reference price only if that fails.
  const withRealPrices = await Promise.all(
    caseRows.map(async (row) => ({
      ...row,
      price: await getOrderBookPrice(row.item, row.price),
    }))
  );
  return withRealPrices;
}

/**
 * Full 36-outcome distribution (6 rarities × 6 slots), confirmed directly
 * from the in-game "Open Case" screen — RARITY_ODDS and TYPE_ODDS are
 * independent, so P(outcome) = P(rarity) × P(slot). Same for every case
 * SKU (no per-case odds difference has been confirmed or observed).
 */
function theoreticalOutcomeOdds() {
  const totalRarity = Object.values(RARITY_ODDS).reduce((s, v) => s + v, 0);
  const totalType = Object.values(TYPE_ODDS).reduce((s, v) => s + v, 0);
  const outcomes = [];
  RARITIES.forEach((rarity) => {
    SLOTS.forEach((slot) => {
      outcomes.push({
        rarity,
        slot,
        prob: (RARITY_ODDS[rarity] / totalRarity) * (TYPE_ODDS[slot] / totalType),
      });
    });
  });
  return outcomes;
}

/**
 * Confirmed directly (in-game, via player): dismantling refunds exactly
 * the scraps used to craft that rarity (100%) and NO steel. Uses the same
 * CRAFT_COST table Craft ROI already relies on, so the two stay in sync.
 */
function scrapValueFor(rarity, scrapsBidPrice) {
  const cost = CRAFT_COST[rarity];
  if (!cost || !Number.isFinite(scrapsBidPrice)) return null;
  // Scrapyard upgrade (0 = none, 1-5 = confirmed 1%-5% bonus scraps from
  // dismantling) — applied unrounded, e.g. level 4 on a Common (6 base
  // scraps) gives 6 × 1.04 = 6.24, not rounded to 6.
  const bonusMultiplier = 1 + scrapyardLevel / 100;
  return cost.scraps * bonusMultiplier * scrapsBidPrice;
}

async function getScrapsBidPrice() {
  const data = await api('/api/market/prices');
  const rows = marketRowsFrom(data);
  const referenceRow = rows.find((r) => r.item === 'scraps');
  const referencePrice = referenceRow ? referenceRow.price : null;
  // Always Bid here, regardless of Craft ROI's Ask/Bid toggle — scrap
  // value represents scraps you're receiving and plan to sell, so the
  // price you'd actually realize is what buyers are offering (Bid), not
  // what it'd cost to buy scraps yourself (Ask).
  return getOrderBookPrice('scraps', referencePrice, 'bid');
}

function computeSellValue(windowedTx, fullTx, rarity, slot) {
  const s = statsFor(windowedTx, fullTx, rarity, slot, null);
  return s.avgPrice;
}

function computeCaseEV(windowedTx, fullTx, scrapsBidPrice) {
  const outcomes = theoreticalOutcomeOdds().map((o) => ({
    ...o,
    sellValue: computeSellValue(windowedTx, fullTx, o.rarity, o.slot),
    scrapValue: scrapValueFor(o.rarity, scrapsBidPrice),
  }));

  function weightedEV(valueFn) {
    let total = 0;
    let weight = 0;
    outcomes.forEach((o) => {
      const v = valueFn(o);
      if (v === null) return; // unknown outcomes excluded, remaining renormalized
      total += v * o.prob;
      weight += o.prob;
    });
    return weight > 0 ? total / weight : null;
  }

  return {
    outcomes,
    evSellAll: weightedEV((o) => o.sellValue),
    evScrapAll: weightedEV((o) => o.scrapValue),
    evOptimal: weightedEV((o) => {
      if (o.sellValue === null) return o.scrapValue;
      if (o.scrapValue === null) return o.sellValue;
      return Math.max(o.sellValue, o.scrapValue);
    }),
    evDefault: weightedEV((o) => {
      const choice = DEFAULT_STRATEGY[o.rarity] || 'sell';
      const preferred = choice === 'scrap' ? o.scrapValue : o.sellValue;
      return preferred !== null ? preferred : (choice === 'scrap' ? o.sellValue : o.scrapValue);
    }),
    evCustom: weightedEV((o) => {
      const choice = customStrategy[o.rarity] || 'sell';
      const preferred = choice === 'scrap' ? o.scrapValue : o.sellValue;
      return preferred !== null ? preferred : (choice === 'scrap' ? o.sellValue : o.scrapValue);
    }),
  };
}

let caseDataCache = null;

// The realistic strategy most players will actually follow — scrapping
// every single Common/Uncommon by hand for little value each isn't worth
// the clicks, so this treats those two rarities as "always scrap" and
// everything above as "always sell". Fixed (not user-editable) — that's
// what "your strategy" below is for, which starts matching this pattern
// but can be adjusted per rarity from there.
const DEFAULT_STRATEGY = { common: 'scrap', uncommon: 'scrap', rare: 'sell', epic: 'sell', legendary: 'sell', mythic: 'sell' };

const customStrategy = {}; // rarity -> 'sell' | 'scrap' — starts as a copy of DEFAULT_STRATEGY, then user-editable
RARITIES.forEach((r) => { customStrategy[r] = DEFAULT_STRATEGY[r]; });
// Independent from Craft ROI's own recency controls — you might reasonably
// want a faster-moving 1h view on Craft ROI while Cases uses a steadier
// 24h+ window for a "should I buy this" decision, or vice versa.
let casesHoursWindow = 24;
// 0 = no Scrapyard upgrade, 1-5 = confirmed 1%-5% bonus scraps from
// dismantling. Defaults to 0 (no assumed upgrade) — set to your actual level.
let scrapyardLevel = 0;

function caseStrategyRow(label, gross, net, starred) {
  const netCls = net === null ? '' : net >= 0 ? 'up' : 'down';
  return `
    <tr class="${starred ? 'case-strategy-table__optimal' : ''}">
      <td>${label}</td>
      <td class="num">${gross !== null ? fmtNum(gross) : '—'}</td>
      <td class="num ${netCls}">${net !== null ? `${net >= 0 ? '+' : ''}${fmtNum(net)}` : '—'}</td>
    </tr>
  `;
}

function renderCaseCards() {
  const grid = $('#caseGrid');
  if (!caseDataCache) return;
  const { priceRows, scrapsBidPrice, marketTx } = caseDataCache;
  const windowedTx = withinWindow(marketTx, casesHoursWindow);
  const ev = computeCaseEV(windowedTx, marketTx, scrapsBidPrice); // same distribution for every case — only price differs
  const sellSampleTotal = ev.outcomes.reduce((s, o) => s + (statsFor(windowedTx, marketTx, o.rarity, o.slot, null).count || 0), 0);

  grid.innerHTML = priceRows
    .map((row) => {
      const caseCode = row.item;
      const price = row.price;

      // Headline number is the default strategy (scrap Common/Uncommon,
      // sell the rest) — a realistic ceiling on what you'll actually do,
      // not the theoretical optimal (which assumes hand-scrapping every
      // single Common/Uncommon roll, impractical at real volume).
      const netDefault = ev.evDefault !== null ? ev.evDefault - price : null;
      const netOptimal = ev.evOptimal !== null ? ev.evOptimal - price : null;
      const netSell = ev.evSellAll !== null ? ev.evSellAll - price : null;
      const netScrap = ev.evScrapAll !== null ? ev.evScrapAll - price : null;
      const netCustom = ev.evCustom !== null ? ev.evCustom - price : null;
      const pct = netDefault !== null && price > 0 ? (netDefault / price) * 100 : null;

      return `
        <div class="case-card">
          <div class="case-card__head">
            <span class="case-card__title">${caseCode}</span>
            ${pct !== null
              ? `<span class="case-verdict ${pct >= 0 ? 'case-verdict--good' : 'case-verdict--bad'}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>`
              : '<span class="confidence-chip confidence-none">no sell data yet</span>'}
          </div>
          <div class="case-card__verdict-label ${netDefault === null ? '' : netDefault >= 0 ? 'up' : 'down'}">
            ${netDefault === null ? 'Not enough sell data yet' : netDefault >= 0 ? 'Opening pays off' : "Don't open"}
          </div>
          <div class="case-card__stats">
            <div><span class="case-stat__label">Price</span><span class="case-stat__value">${fmtNum(price)}</span></div>
            <div><span class="case-stat__label">EV (default)</span><span class="case-stat__value">${ev.evDefault !== null ? fmtNum(ev.evDefault) : '—'}</span></div>
            <div><span class="case-stat__label">Net</span><span class="case-stat__value ${netDefault === null ? '' : netDefault >= 0 ? 'up' : 'down'}">${netDefault !== null ? `${netDefault >= 0 ? '+' : ''}${fmtNum(netDefault)}` : '—'}</span></div>
          </div>
          <table class="case-strategy-table">
            <tbody>
              ${caseStrategyRow("Sell case (don't open)", price, null, false)}
              ${caseStrategyRow('Open → sell everything', ev.evSellAll, netSell, false)}
              ${caseStrategyRow('Open → scrap everything', ev.evScrapAll, netScrap, false)}
              ${caseStrategyRow('Open → default (scrap C/U, sell rest)', ev.evDefault, netDefault, true)}
              ${caseStrategyRow('Open → optimal (max sell/scrap)', ev.evOptimal, netOptimal, false)}
              ${caseStrategyRow('Open → your strategy', ev.evCustom, netCustom, false)}
            </tbody>
          </table>
          <p class="case-sample-note">Odds and scrap value: confirmed in-game formulas, scraps priced at Bid (what you'd realize selling them)${scrapyardLevel > 0 ? `, Scrapyard lvl ${scrapyardLevel}: +${scrapyardLevel}% scraps applied` : ', no Scrapyard bonus'}. Sell values: ${sellSampleTotal} real equipment sales from the last ${casesHoursWindow}h (falls back further back per outcome if the window has none) across all 36 outcomes.</p>
        </div>
      `;
    })
    .join('');
}

function renderStrategyPanel() {
  const el = $('#strategyRarityRow');
  el.innerHTML = RARITIES.map(
    (r) => `
    <div class="strategy-rarity-item">
      <span class="rarity-chip rarity-${r}">${r}</span>
      <div class="time-filter">
        <button data-rarity="${r}" data-action="sell" class="${customStrategy[r] === 'sell' ? 'is-active' : ''}">sell</button>
        <button data-rarity="${r}" data-action="scrap" class="${customStrategy[r] === 'scrap' ? 'is-active' : ''}">scrap</button>
      </div>
    </div>
  `
  ).join('');

  $$('.strategy-rarity-item button', el).forEach((btn) => {
    btn.addEventListener('click', () => {
      customStrategy[btn.dataset.rarity] = btn.dataset.action;
      renderCaseCards();
      renderStrategyPanel();
    });
  });
}

async function renderCasesTab() {
  const grid = $('#caseGrid');
  const note = $('#casesNote');
  grid.innerHTML = '<p class="empty-state">Loading case data…</p>';

  try {
    const [priceRows, scrapsBidPrice, caseOpens, dismantles, marketTx] = await Promise.all([
      discoverCasePrices(),
      getScrapsBidPrice(),
      fetchCaseOpens(),
      fetchDismantles(),
      fetchCraftHistory(),
    ]);

    if (priceRows.length === 0) {
      grid.innerHTML = `
        <p class="empty-state">
          No case-priced items found via itemTrading.getPrices — cases might not
          trade through the simple goods market at all (could be a fixed shop
          price instead of a live market price). Check the console for the full
          price list this pulled from.
        </p>
      `;
      note.textContent = '';
      const data = await api('/api/market/prices');
      console.log('material prices checked for case-like keys:', data);
      return;
    }

    console.log('discovered case price entries:', priceRows);
    console.log('scraps Bid price used for scrap value:', scrapsBidPrice);
    console.log('openCase/dismantleItem observed so far (not required, informational):', { caseOpens: caseOpens.length, dismantles: dismantles.length });
    caseDataCache = { priceRows, scrapsBidPrice, marketTx };
    renderCaseCards();
    renderStrategyPanel();

    note.textContent = `Odds (62/30/7.1/0.85/0.04/0.01% by rarity, 30/14/14/14/14/14% by slot) ` +
      `and scrap value (100% of craft scraps, confirmed no steel refund) use confirmed in-game formulas — ` +
      `not observed frequency. Sell values come from real trade history, shared with Craft ROI.`;
  } catch (err) {
    grid.innerHTML = `<p class="empty-state">Failed to load: ${err.message}</p>`;
    note.textContent = '';
  }
}

// ---- Wire up -------------------------------------------------------------

function init() {
  initTabs();

  $('#craftRefresh').addEventListener('click', () => {
    rawHistoryCache = null; // force a fresh fetch
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

  $$('#priceSideFilter button').forEach((btn) => {
    btn.addEventListener('click', () => {
      priceSide = btn.dataset.side;
      $$('#priceSideFilter button').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
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

  $('#casesRefresh').addEventListener('click', () => {
    caseDataCache = null;
    renderCasesTab();
  });
  $$('#casesTimeFilter button').forEach((btn) => {
    btn.addEventListener('click', () => {
      casesHoursWindow = Number(btn.dataset.hours);
      $$('#casesTimeFilter button').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      renderCaseCards(); // recompute only — data's already cached, no refetch needed
    });
  });
  $$('#scrapyardFilter button').forEach((btn) => {
    btn.addEventListener('click', () => {
      scrapyardLevel = Number(btn.dataset.level);
      $$('#scrapyardFilter button').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      renderCaseCards(); // pure multiplier — recompute only
    });
  });

  renderCraftRoi();
  renderCasesTab();
  refreshTicker();
  setInterval(refreshTicker, 20_000);
  // Only Craft ROI auto-refreshes — its numbers genuinely grow as the
  // background collector runs. Cases doesn't need this (its EV comes from
  // fixed formulas + Craft ROI's already-refreshing sell data), and
  // auto-refreshing it was an unwanted side effect, not intentional.
  setInterval(() => {
    if ($('#panel-craft').classList.contains('is-active')) renderCraftRoi();
  }, 30_000);
}

document.addEventListener('DOMContentLoaded', init);
