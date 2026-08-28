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

// GET /api/market/prices?item=IRON  (item optional — omit for all items)
app.get('/api/market/prices', (req, res) => {
  const input = req.query.item ? { itemCode: req.query.item } : undefined;
  handle(warera.query('itemTrading.getPrices', input, { cacheCategory: 'market' }), res);
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

// GET /api/market/transactions?item=CODE&limit=100
// Historical trade log — used by the Craft ROI tab to compute real average
// sale prices for equipment, since equipment has no live order-book price.
app.get('/api/market/transactions', (req, res) => {
  const input = { limit: req.query.limit ? Number(req.query.limit) : 100 };
  if (req.query.item) input.itemCode = req.query.item;
  handle(warera.query('transaction.getPaginatedTransactions', input, { cacheTtlMs: 60_000 }), res);
});

// ---- Rankings ---------------------------------------------------------------

// GET /api/rankings?type=wealth&limit=50
app.get('/api/rankings', (req, res) => {
  const input = {
    type: req.query.type || 'wealth',
    limit: req.query.limit ? Number(req.query.limit) : 50,
  };
  handle(warera.query('ranking.getRanking', input, { cacheCategory: 'rankings' }), res);
});

// GET /api/battle-rankings?battleId=...&side=attacker
app.get('/api/battle-rankings', (req, res) => {
  if (!req.query.battleId) {
    return res.status(400).json({ ok: false, error: 'Query param "battleId" is required' });
  }
  const input = { battleId: req.query.battleId };
  if (req.query.side) input.side = req.query.side;
  handle(warera.query('battleRanking.getRanking', input, { cacheCategory: 'rankings' }), res);
});

// ---- Battles ------------------------------------------------------------------

// GET /api/battles?active=true&limit=20
app.get('/api/battles', (req, res) => {
  const input = {
    limit: req.query.limit ? Number(req.query.limit) : 20,
  };
  if (req.query.active !== undefined) input.active = req.query.active === 'true';
  if (req.query.country) input.country = req.query.country;
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
app.get('/api/search', (req, res) => {
  if (!req.query.q) {
    return res.status(400).json({ ok: false, error: 'Query param "q" is required' });
  }
  handle(warera.query('search.searchAnything', { query: req.query.q }, { cacheTtlMs: 15_000 }), res);
});

// GET /api/users/:id
app.get('/api/users/:id', (req, res) => {
  handle(warera.query('user.getUserById', { userId: req.params.id }, { cacheTtlMs: 60_000 }), res);
});

// GET /api/events?limit=20&country=Indonesia
app.get('/api/events', (req, res) => {
  const input = { limit: req.query.limit ? Number(req.query.limit) : 20 };
  if (req.query.country) input.country = req.query.country;
  handle(warera.query('event.getEventsPaginated', input, { cacheCategory: 'battles' }), res);
});

app.listen(PORT, () => {
  console.log(`WarEra dashboard running at http://localhost:${PORT}`);
});
