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
    // Transaction history 401s on the primary API (needs a logged-in
    // session) — routed at the gateway specifically, isolated from every
    // other call in this app. A live test showed the gateway can ALSO
    // 401 here despite documenting itself as keyless, so this may simply
    // fail; the catch below turns that into a clear message rather than
    // a generic error.
    const transactions = await warera.queryPaginated(
      'transaction.getPaginatedTransactions',
      { transactionType },
      { pageSize: 100, maxPages: 20, maxRecords: 2000, oldestMs, getTimestamp, baseUrl: warera.GATEWAY_BASE_URL }
    );
    historyCache.set(cacheKey, { data: transactions, expiresAt: Date.now() + HISTORY_CACHE_TTL_MS });
    res.json({ ok: true, data: transactions, cached: false });
  } catch (err) {
    console.error(err);
    const authIssue = /401/.test(err.message);
    res.status(502).json({
      ok: false,
      error: authIssue
        ? 'Transaction history requires access this app doesn\'t have (401 from the gateway). ' +
          'Neither the primary WarEra API nor the community gateway will serve this without a ' +
          'login session or API key we don\'t have — the rest of the dashboard is unaffected.'
        : err.message,
    });
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
