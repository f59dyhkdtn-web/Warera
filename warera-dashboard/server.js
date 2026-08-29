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

// GET /api/craft/history?hours=24&transactionType=itemMarket
// Aggregates several pages of transaction.getPaginatedTransactions into
// one larger, time-windowed batch (so the frontend's 1h/2h/.../24h filter
// buttons can re-slice client-side without hitting the API again). Result
// is cached here for a few minutes since the pagination loop itself is
// several API calls.
const historyCache = new Map(); // key -> { expiresAt, data }
const HISTORY_CACHE_TTL_MS = 3 * 60_000;

app.get('/api/craft/history', async (req, res) => {
  const hours = req.query.hours ? Number(req.query.hours) : 24;
  const transactionType = req.query.transactionType || 'itemMarket';
  const cacheKey = `${transactionType}:${hours}`;

  const cached = historyCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return res.json({ ok: true, data: cached.data, cached: true });
  }

  try {
    const oldestMs = Date.now() - hours * 60 * 60 * 1000;
    const getTimestamp = (tx) => {
      const raw = tx.createdAt ?? tx.timestamp ?? tx.date ?? tx.time ?? null;
      const t = raw ? new Date(raw).getTime() : NaN;
      return Number.isFinite(t) ? t : null;
    };
    // Transaction history needs an authenticated request — a WARERA_API_KEY
    // env var (an official per-account token from WarEra's own "API
    // Tokens" account settings screen) sent as X-API-Key on the PRIMARY
    // API. Without one configured, this reliably 401s — that's expected,
    // not a bug, until a token is set.
    //
    // NOTE ON PAGE SIZE: a live check (/api/craft/debug) showed the API
    // ignores the "limit" input and returns roughly 10 records per page
    // regardless, and the log mixes EVERY transaction type together (wage,
    // openCase, dismantleItem, itemMarket, etc.) — the "transactionType"
    // input filter is ignored too. So maxPages needs to be much higher
    // than it would if paging returned ~100 filtered records at a time;
    // filtering down to real itemMarket equipment sales happens client-side
    // in app.js against each record's own transactionType field instead.
    //
    // maxPages is deliberately capped well short of what would cover a
    // full 24h of "thousands per day" activity — at ~10 records/page and
    // our own 150/min self-throttle, a much higher cap risks the request
    // itself timing out (Render's proxy or the browser) before it
    // finishes, which would be worse than a smaller-but-reliable sample.
    // This trades sample size for reliability; raise it if it turns out
    // requests comfortably finish well under whatever timeout applies.
    // Not passing transactionType here (even though the API appears to
    // ignore it for filtering) — a hypothesis for the last bug was that
    // sending a filter alongside a cursor makes the API invalidate/reset
    // the cursor, which would explain pagination silently not advancing.
    // Filtering happens entirely client-side against each record's own
    // fields regardless, so there's no downside to dropping it here.
    const pageLog = [];
    const transactions = await warera.queryPaginated(
      'transaction.getPaginatedTransactions',
      {},
      { pageSize: 100, maxPages: 80, maxRecords: 1000, oldestMs, getTimestamp, pageLog }
    );
    const itemMarketCount = transactions.filter((t) => t.transactionType === 'itemMarket').length;
    console.log(
      `craft history: ${transactions.length} records over ${pageLog.length} pages, ` +
      `${itemMarketCount} itemMarket, cursor sample: ${pageLog.slice(0, 3).map((p) => p.cursorOut).join(' | ')}`
    );
    historyCache.set(cacheKey, { data: transactions, expiresAt: Date.now() + HISTORY_CACHE_TTL_MS });
    res.json({ ok: true, data: transactions, cached: false, pageSummary: pageLog.slice(0, 10) });
  } catch (err) {
    console.error(err);
    const authIssue = /401/.test(err.message);
    res.status(502).json({
      ok: false,
      error: authIssue
        ? 'Transaction history needs an authenticated request. Set a WARERA_API_KEY ' +
          'environment variable to a token generated from your WarEra account\'s API ' +
          'Tokens screen — the rest of the dashboard works fine without it.'
        : err.message,
    });
  }
});

// GET /api/craft/debug
// Temporary diagnostic: returns ONE raw, unflattened page of
// transaction.getPaginatedTransactions exactly as the API sends it —
// used to find the real pagination field names (what the "next cursor"
// is actually called), since only the request parameters for this
// procedure are documented anywhere found, not the response shape.
app.get('/api/craft/debug', async (req, res) => {
  try {
    const data = await warera.query(
      'transaction.getPaginatedTransactions',
      { transactionType: req.query.transactionType || 'itemMarket', limit: 5 },
      { skipCache: true }
    );
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
