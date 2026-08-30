'use strict';

const path = require('path');
const express = require('express');
const warera = require('./lib/warera');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

function handle(promise, res) {
  promise
    .then((data) => res.json({ ok: true, data }))
    .catch((err) => {
      console.error(err);
      res.status(502).json({ ok: false, error: err.message });
    });
}

// ---- Market ----------------------------------------------------------------

// GET /api/market/prices
// itemTrading.getPrices takes NO parameters (confirmed) — it always
// returns every tradeable item's price. Filtering happens client-side.
app.get('/api/market/prices', (req, res) => {
  handle(warera.query('itemTrading.getPrices', undefined, { cacheCategory: 'market' }), res);
});

// GET /api/market/orders?item=IRON  (item required)
app.get('/api/market/orders', (req, res) => {
  if (!req.query.item) {
    return res.status(400).json({ ok: false, error: 'Query param "item" is required' });
  }
  handle(
    warera.query('tradingOrder.getTopOrders', { itemCode: req.query.item }, { cacheCategory: 'market' }),
    res
  );
});

// GET /api/market/transactions?item=CODE&limit=100&transactionType=itemMarket
// Historical trade log — used by the Craft ROI tab to compute real average
// sale prices for equipment (equipment has no live order-book price).
// transactionType defaults to "itemMarket" (equipment buy/sell), since the
// full log also includes wages, donations, case openings, crafting, etc.
// Valid transactionType values: applicationFee, trading, itemMarket, wage,
// donation, articleTip, openCase, craftItem, dismantleItem, battleLoot.
app.get('/api/market/transactions', (req, res) => {
  const input = {
    limit: req.query.limit ? Number(req.query.limit) : 100,
    transactionType: req.query.transactionType || 'itemMarket',
  };
  if (req.query.item) input.itemCode = req.query.item;
  handle(warera.query('transaction.getPaginatedTransactions', input, { cacheTtlMs: 60_000 }), res);
});

// ---- Background transaction ingestion ----------------------------------
//
// This API has NO working server-side filter — transactionType and limit
// are both silently ignored (confirmed via /api/craft/debug), and it only
// returns ~10 records per page regardless of what's requested. At real
// game volume (thousands of trades/day per rarity, per the person running
// this), there is no way to pull a representative sample in one request —
// any synchronous per-request pagination loop would either time out or
// return a tiny, misleading sample.
//
// So: a background loop below continuously pulls one page every ~700ms
// (respecting the same shared rate limiter as everything else in this
// app), building up a real dataset over time in `txStore`, keyed by _id
// to naturally dedupe. /api/craft/history just reads from that store
// instantly — no pagination happens inside a request anymore.
//
// HONEST LIMITATION: this can only accumulate data going forward from
// whenever the server process started — it cannot retroactively backfill
// a full day of history in one shot (nothing could, without a working
// filter). Right after a deploy, expect the store to be nearly empty;
// coverage grows the longer the process stays up (roughly: ~1 hour
// running ≈ ~1 hour of real coverage, up to the 26h cap below). Render's
// free tier sleeps after 15 min idle, which resets this on the next
// request — if you want durable long-term coverage, that's the tradeoff
// to solve for later (keep-alive pings, or a paid always-on tier).
const txStore = new Map(); // _id -> transaction record
// A week plus a little buffer — extended from the original 26h so rare
// combinations (e.g. a specific jet stat-roll that might only sell once
// every several days) still have a real "most recent price" to fall back
// on instead of showing nothing. Equipment-only filtering already cuts
// stored volume by ~90% before it reaches this store, so a week's worth
// stays well within both Upstash's free-tier storage cap (256MB — even
// 100k+ records is only tens of MB as JSON) and Render's free-tier RAM.
const STORE_WINDOW_MS = 7.25 * 24 * 60 * 60 * 1000;
const STORE_MAX_SIZE = 150_000;
// ---- Optional persistence (Upstash Redis) --------------------------------
// Without these two env vars, everything below still works exactly as
// before — the collected dataset just resets to zero on every restart or
// redeploy. With them set, txStore survives restarts: loaded from Upstash
// on boot, snapshotted back every 5 minutes, and flushed once more on
// SIGTERM (the signal Render sends right before killing the old instance
// during a redeploy) to minimize the gap.
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const PERSIST_KEY = 'warera_craft_equipment_sales_v1';
const PERSIST_ENABLED = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

async function persistLoad() {
  if (!PERSIST_ENABLED) return;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${PERSIST_KEY}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const body = await res.json();
    if (body?.result) {
      const items = JSON.parse(body.result);
      for (const item of items) {
        if (item && item._id) txStore.set(item._id, item);
      }
      console.log(`persisted store restored: ${items.length} equipment sales loaded from Upstash`);
    }
  } catch (err) {
    console.error('persist load failed (continuing with an empty store):', err.message);
  }
}

async function persistSave() {
  if (!PERSIST_ENABLED) return;
  try {
    const items = [...txStore.values()];
    await fetch(`${UPSTASH_URL}/set/${PERSIST_KEY}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      body: JSON.stringify(items),
    });
  } catch (err) {
    console.error('persist save failed:', err.message);
  }
}

if (PERSIST_ENABLED) {
  console.log('WARERA persistence: enabled (Upstash) — loading any previously saved data...');
} else {
  console.log(
    'WARERA persistence: not configured (set UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) — ' +
    'collected data will reset on every restart or redeploy.'
  );
}

// Per-user snapshots for My ROI — same Upstash setup as above, keyed per
// user instead of one shared key. Lets repeat loads for the same user
// fetch only what's new since last time (see queryUserTransactions'
// knownIds param) instead of re-paginating the whole requested window
// every single load.
async function loadMyTxSnapshot(userId) {
  if (!PERSIST_ENABLED) return [];
  try {
    const res = await fetch(`${UPSTASH_URL}/get/warera_my_tx_${userId}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const body = await res.json();
    return body?.result ? JSON.parse(body.result) : [];
  } catch (err) {
    console.error(`my-tx snapshot load failed for ${userId}:`, err.message);
    return [];
  }
}

async function saveMyTxSnapshot(userId, items) {
  if (!PERSIST_ENABLED) return;
  try {
    await fetch(`${UPSTASH_URL}/set/warera_my_tx_${userId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      body: JSON.stringify(items),
    });
  } catch (err) {
    console.error(`my-tx snapshot save failed for ${userId}:`, err.message);
  }
}

let ingestCursor; // undefined = "start from the newest page"
let ingestTicksSinceResync = 0;
const RESYNC_EVERY_TICKS = 200; // periodically re-check the newest page so brand-new trades aren't missed
let ingestFailures = 0;
// Set to true for the duration of an on-demand My ROI fetch — the
// background collector skips its ticks entirely while this is set,
// giving the on-demand request the full rate budget instead of just a
// fixed slice of it. Restoring priority order: a real user waiting on a
// button click matters more than the background collector's steady
// drip, which can afford to pause briefly.
let onDemandPriority = false;

async function ingestTick() {
  try {
    const input = { limit: 100 };
    if (ingestCursor !== undefined) input.cursor = ingestCursor;
    const data = await warera.query('transaction.getPaginatedTransactions', input, { skipCache: true });
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];

    // Only equipment market sales are ever used by the frontend (see
    // parseTransaction in app.js) — filtering here, not just on read,
    // means wages/case-openings/dismantles/material-trades (~90% of raw
    // volume) never occupy memory or persistence space at all.
    //
    // NOT checking item.type === 'equipment' specifically anymore: real
    // data showed zero weapon sales ever collected despite confirmed high
    // real volume, while every armor category was well represented — the
    // likely cause is weapons using a different type string internally
    // (e.g. "weapon" as its own category, not "equipment"). Requiring
    // just a nested item object with a code is enough to distinguish gear
    // sales (armor OR weapons) from raw-material trades, which have no
    // nested item object at all — without needing to know every exact
    // type string in advance.
    // Also capturing openCase and dismantleItem now (previously only
    // itemMarket) — the new Cases tab needs real per-case rarity odds
    // (from openCase records: which case was opened + what came out) and
    // real dismantle refund amounts (from dismantleItem records: what
    // materials + quantity came back for a known source item), neither of
    // which can be reliably guessed. Both types carry a nested item.code
    // the same way itemMarket sales do, so the same shape check applies.
    const KNOWN_TYPES = new Set(['itemMarket', 'openCase', 'dismantleItem']);
    for (const item of items) {
      if (item && item._id && KNOWN_TYPES.has(item.transactionType) && item.item?.code) {
        txStore.set(item._id, item);
      }
    }

    if (txStore.size > STORE_MAX_SIZE) {
      const cutoff = Date.now() - STORE_WINDOW_MS;
      for (const [id, tx] of txStore) {
        const t = tx.createdAt ? new Date(tx.createdAt).getTime() : null;
        if (t !== null && t < cutoff) txStore.delete(id);
        if (txStore.size <= STORE_MAX_SIZE * 0.8) break;
      }
    }

    ingestFailures = 0;
    ingestTicksSinceResync += 1;
    const nextCursor = data?.nextCursor ?? data?.cursor ?? data?.meta?.nextCursor;
    if (!nextCursor || ingestTicksSinceResync >= RESYNC_EVERY_TICKS) {
      ingestCursor = undefined;
      ingestTicksSinceResync = 0;
    } else {
      ingestCursor = nextCursor;
    }
  } catch (err) {
    ingestFailures += 1;
    if (ingestFailures <= 3 || ingestFailures % 20 === 0) {
      console.error(`craft ingest tick failed (${ingestFailures} in a row):`, err.message);
    }
  }
}

// 190/min shared budget ÷ ~1 request per tick. Deliberately NOT using
// nearly the whole budget anymore — My ROI's on-demand pagination bursts
// (up to 200 sequential requests for a first-time user) were queuing
// behind this continuously-running collector and taking a long time to
// clear. ~400ms leaves real headroom (~90/min) for on-demand requests
// while still collecting at a reasonable pace for Craft ROI/Cases.
const INGEST_INTERVAL_MS = 400;

async function startIngestion() {
  await persistLoad(); // resume from a saved snapshot, if one exists, before ticking
  setInterval(() => {
    // Back off when failing repeatedly (e.g. no WARERA_API_KEY set yet)
    // instead of hammering the API/logs every tick.
    if (ingestFailures > 3 && ingestFailures % 10 !== 0) return;
    if (onDemandPriority) return; // an on-demand request is running — let it have the budget
    ingestTick();
  }, INGEST_INTERVAL_MS);
  ingestTick();

  if (PERSIST_ENABLED) {
    setInterval(persistSave, 5 * 60_000);
    process.on('SIGTERM', async () => {
      console.log('SIGTERM received — saving final snapshot before shutdown...');
      await persistSave();
      process.exit(0);
    });
  }
}
startIngestion();

// GET /api/craft/history?hours=24
// Reads straight from the continuously-growing txStore above — instant,
// no per-request API calls. `storeSize`/`typeCounts`/`ingestFailures` are
// included so the frontend (or you, via console) can see real ingestion
// health rather than just an empty-looking result.
app.get('/api/craft/history', (req, res) => {
  const hours = req.query.hours ? Number(req.query.hours) : 168; // 7 days, matching STORE_WINDOW_MS
  const cutoff = Date.now() - hours * 60 * 60 * 1000;

  const windowed = [...txStore.values()].filter((tx) => {
    const t = tx.createdAt ? new Date(tx.createdAt).getTime() : null;
    return t === null || t >= cutoff;
  });

  const typeCounts = {};
  const itemCodeCounts = {}; // diagnostic: every distinct item.code seen — helps spot missing categories (e.g. weapons) at a glance
  windowed.forEach((t) => {
    const key = t.transactionType || '(none)';
    typeCounts[key] = (typeCounts[key] || 0) + 1;
    const code = t.item?.code || t.itemCode || '(none)';
    itemCodeCounts[code] = (itemCodeCounts[code] || 0) + 1;
  });

  res.json({
    ok: true,
    data: windowed,
    storeSize: txStore.size,
    typeCounts,
    itemCodeCounts,
    ingestFailures,
    ingestActive: ingestFailures <= 3,
  });
});


// GET /api/craft/debug
// Temporary diagnostic: returns ONE raw, unflattened page of
// transaction.getPaginatedTransactions exactly as the API sends it —
// used to find the real pagination field names (what the "next cursor"
// is actually called), since only the request parameters for this
// procedure are documented anywhere found, not the response shape.
app.get('/api/craft/debug', async (req, res) => {
  try {
    const input = { transactionType: req.query.transactionType || 'itemMarket', limit: 5 };
    if (req.query.itemCode) input.itemCode = req.query.itemCode;
    if (req.query.userId) input.userId = req.query.userId;
    const data = await warera.query('transaction.getPaginatedTransactions', input, { skipCache: true });
    res.json({ ok: true, data });
  } catch (err) {
    console.error(err);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// GET /api/craft/debug-my-transactions?userId=X
// Tests the request shape confirmed via live browser DevTools capture
// (POST, plain JSON body { "0": { direction, limit, userId, ... } },
// batch=1) against api2.warera.io specifically — api4.warera.io (where
// that capture happened) explicitly rejects API-token auth with "Use
// api2.warera.io instead", so this checks whether the SAME request shape
// that filters correctly on api4 also filters correctly on the domain
// our token actually works on. Every earlier userId test used a
// different (GET-based) request format, so this hasn't been tried yet.
app.get('/api/craft/debug-my-transactions', async (req, res) => {
  if (!req.query.userId) return res.status(400).json({ ok: false, error: 'userId query param required' });
  try {
    const body = JSON.stringify({ 0: { direction: 'forward', limit: 5, userId: req.query.userId } });
    const url = 'https://api2.warera.io/trpc/transaction.getPaginatedTransactions?batch=1';
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (process.env.WARERA_API_KEY) headers['X-API-Key'] = process.env.WARERA_API_KEY;
    const upstream = await fetch(url, { method: 'POST', headers, body });
    const text = await upstream.text();
    res.status(200).json({ ok: true, upstreamStatus: upstream.status, upstreamOk: upstream.ok, body: text });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// GET /api/my/transactions?userId=X&weeks=4
// Real per-user transaction history — the confirmed working userId
// filter (see lib/warera.js queryPost/queryUserTransactions) means this
// is a direct, efficient fetch of just this user's own activity, not a
// passive sample of the whole game. Cached briefly per user so switching
// between tabs or re-rendering doesn't re-paginate every time.
const myTxCache = new Map(); // userId -> { data, expiresAt }
const MY_TX_CACHE_TTL_MS = 3 * 60_000;

app.get('/api/my/transactions', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'userId query param required' });
  const weeks = req.query.weeks ? Number(req.query.weeks) : 4;
  const cacheKey = `${userId}:${weeks}`;

  const cached = myTxCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return res.json({ ok: true, data: cached.data, cached: true });
  }

  onDemandPriority = true;
  try {
    const existing = await loadMyTxSnapshot(userId); // [] if nothing persisted yet for this user
    const existingIds = new Set(existing.map((t) => t._id).filter(Boolean));
    const oldestMs = Date.now() - weeks * 7 * 24 * 60 * 60 * 1000;

    // Only pages back as far as needed: stops at the first already-known
    // transaction if we have a snapshot (fast repeat loads), or paginates
    // the full requested window if this user has never been fetched
    // before (unavoidably slower — nothing to skip yet). maxPages capped
    // at 40 (was 200) — that was letting a stuck/misbehaving fetch run
    // for minutes; 40 pages × 50/page = 2000 transactions is already a
    // lot for one person, and `stats` below shows exactly why it stopped
    // so a real problem is visible instead of just "it's slow".
    const stats = {};
    const newItems = await warera.queryUserTransactions(userId, {
      knownIds: existingIds.size > 0 ? existingIds : null,
      oldestMs,
      maxPages: 40,
      pageSize: 50,
      stats,
    });
    console.log(`my-transactions for ${userId}:`, stats);

    // Merge, dedupe, and keep a slightly wider rolling window than
    // requested (5 weeks) so switching the weeks dropdown to something
    // larger than last time doesn't require a full refetch either.
    const merged = [...newItems, ...existing];
    const seen = new Set();
    const deduped = merged.filter((t) => {
      if (!t._id || seen.has(t._id)) return false;
      seen.add(t._id);
      return true;
    });
    const rollingCutoff = Date.now() - 5 * 7 * 24 * 60 * 60 * 1000;
    const trimmed = deduped.filter((t) => {
      const ts = t.createdAt ? new Date(t.createdAt).getTime() : null;
      return ts === null || ts >= rollingCutoff;
    });

    await saveMyTxSnapshot(userId, trimmed);

    const displayCutoff = Date.now() - weeks * 7 * 24 * 60 * 60 * 1000;
    const forDisplay = trimmed.filter((t) => {
      const ts = t.createdAt ? new Date(t.createdAt).getTime() : null;
      return ts === null || ts >= displayCutoff;
    });

    myTxCache.set(cacheKey, { data: forDisplay, expiresAt: Date.now() + MY_TX_CACHE_TTL_MS });
    res.json({ ok: true, data: forDisplay, cached: false, newlyFetched: newItems.length, totalStored: trimmed.length, stats });
  } catch (err) {
    console.error(err);
    res.status(502).json({ ok: false, error: err.message });
  } finally {
    onDemandPriority = false;
  }
});

// ---- Rankings ---------------------------------------------------------------

// GET /api/rankings?type=userWealth&limit=50
// ranking.getRanking's required param is "rankingType" (not "type"), with
// a fixed enum of values — confirmed via the gateway's docs. There's no
// "strength" category; valid options include userWealth, userDamages,
// userLevel, userBounty, userReferrals, userCasesOpened, and country/mu
// equivalents (countryWealth, muDamages, etc.).
app.get('/api/rankings', (req, res) => {
  const input = {
    rankingType: req.query.type || 'userWealth',
    limit: req.query.limit ? Number(req.query.limit) : 50,
  };
  handle(warera.query('ranking.getRanking', input, { cacheCategory: 'rankings' }), res);
});

// GET /api/battle-rankings?battleId=...&side=attacker&dataType=damage&type=user
// battleRanking.getRanking requires dataType (damage|points|money), type
// (user|country|mu), and side (attacker|defender|merged) — all three are
// required, not optional as originally guessed. battleId narrows to one
// battle; omit it for a global ranking.
app.get('/api/battle-rankings', (req, res) => {
  const input = {
    dataType: req.query.dataType || 'damage',
    type: req.query.type || 'user',
    side: req.query.side || 'merged',
  };
  if (req.query.battleId) input.battleId = req.query.battleId;
  handle(warera.query('battleRanking.getRanking', input, { cacheCategory: 'rankings' }), res);
});

// ---- Battles ------------------------------------------------------------------

// GET /api/battles?active=true&limit=20&countryId=...
// battle.getBattles' real param names are isActive (not active) and
// countryId (not country).
app.get('/api/battles', (req, res) => {
  const input = {
    limit: req.query.limit ? Number(req.query.limit) : 20,
  };
  if (req.query.active !== undefined) input.isActive = req.query.active === 'true';
  if (req.query.countryId) input.countryId = req.query.countryId;
  handle(warera.query('battle.getBattles', input, { cacheCategory: 'battles' }), res);
});

// GET /api/battles/:id
app.get('/api/battles/:id', (req, res) => {
  handle(
    warera.query('battle.getById', { battleId: req.params.id }, { cacheCategory: 'battles' }),
    res
  );
});

// GET /api/battles/:id/live
app.get('/api/battles/:id/live', (req, res) => {
  handle(
    warera.query(
      'battle.getLiveBattleData',
      { battleId: req.params.id },
      { cacheCategory: 'battleLive' }
    ),
    res
  );
});

// ---- Misc / supporting lookups ------------------------------------------------

// GET /api/countries
app.get('/api/countries', (req, res) => {
  handle(warera.query('country.getAllCountries', undefined, { cacheCategory: 'rankings' }), res);
});

// GET /api/search?q=...
// search.searchAnything's real param name is "searchText" (not "query").
app.get('/api/search', (req, res) => {
  if (!req.query.q) {
    return res.status(400).json({ ok: false, error: 'Query param "q" is required' });
  }
  handle(warera.query('search.searchAnything', { searchText: req.query.q }, { cacheTtlMs: 15_000 }), res);
});

// GET /api/users/:id
app.get('/api/users/:id', (req, res) => {
  handle(warera.query('user.getUserById', { userId: req.params.id }, { cacheTtlMs: 60_000 }), res);
});

// GET /api/events?limit=20&countryId=...
// event.getEventsPaginated's real param name is "countryId" (not "country").
app.get('/api/events', (req, res) => {
  const input = { limit: req.query.limit ? Number(req.query.limit) : 20 };
  if (req.query.countryId) input.countryId = req.query.countryId;
  handle(warera.query('event.getEventsPaginated', input, { cacheCategory: 'battles' }), res);
});

app.listen(PORT, () => {
  console.log(`WarEra dashboard running at http://localhost:${PORT}`);
});
