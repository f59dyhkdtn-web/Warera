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
const STORE_WINDOW_MS = 26 * 60 * 60 * 1000; // slightly over 24h; trimmed below
const STORE_MAX_SIZE = 50_000;
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

let ingestCursor; // undefined = "start from the newest page"
let ingestTicksSinceResync = 0;
const RESYNC_EVERY_TICKS = 200; // periodically re-check the newest page so brand-new trades aren't missed
let ingestFailures = 0;

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
    for (const item of items) {
      if (item && item._id && item.transactionType === 'itemMarket' && item.item?.type === 'equipment') {
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

// 190/min shared budget ÷ ~1 request per tick ≈ one tick every ~320ms.
// Other tabs (market/rankings/battles) are cached 15-60s so they barely
// touch this budget — ingestion can safely use nearly all of it.
const INGEST_INTERVAL_MS = 320;

async function startIngestion() {
  await persistLoad(); // resume from a saved snapshot, if one exists, before ticking
  setInterval(() => {
    // Back off when failing repeatedly (e.g. no WARERA_API_KEY set yet)
    // instead of hammering the API/logs every tick.
    if (ingestFailures > 3 && ingestFailures % 10 !== 0) return;
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
  const hours = req.query.hours ? Number(req.query.hours) : 24;
  const cutoff = Date.now() - hours * 60 * 60 * 1000;

  const windowed = [...txStore.values()].filter((tx) => {
    const t = tx.createdAt ? new Date(tx.createdAt).getTime() : null;
    return t === null || t >= cutoff;
  });

  const typeCounts = {};
  windowed.forEach((t) => {
    const key = t.transactionType || '(none)';
    typeCounts[key] = (typeCounts[key] || 0) + 1;
  });

  res.json({
    ok: true,
    data: windowed,
    storeSize: txStore.size,
    typeCounts,
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
    const data = await warera.query('transaction.getPaginatedTransactions', input, { skipCache: true });
    res.json({ ok: true, data });
  } catch (err) {
    console.error(err);
    res.status(502).json({ ok: false, error: err.message });
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
