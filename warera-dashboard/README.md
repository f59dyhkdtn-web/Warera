# WarEra Dispatch — unofficial stats dashboard

A small dashboard for the browser game [WarEra](https://app.warera.io): market prices,
player/country rankings, and active battles.

## What this is (and isn't)

WarEra has **no official public API**. Everything here talks to the same backend the
game's own web client uses (`api2.warera.io`), based on community reverse-engineering:

- Endpoint names: [Context7's WarEra API index](https://context7.com/websites/api2_warera_io)
- Response shapes / conventions: [majimawrks/warera-api-docs](https://majimawrks.github.io/warera-api-docs/) and [majimawrks/warera-fetch](https://github.com/majimawrks/warera-fetch)

This means two things could be slightly off and need a small fix on your end:

1. **The exact query-string format.** `lib/warera.js` tries the two most common tRPC
   request shapes automatically, so this usually isn't something you need to touch.
2. **The exact field names in each response** (e.g. is a price called `sellPrice` or
   `bestSell`?). The frontend (`public/app.js`) tries a few likely names for each field
   and logs the raw API response to the browser console — open DevTools, look at what
   came back, and add the real field name to the relevant `pick(...)` call if a column
   shows up empty.

Respect the game's rate limits — the client here caps itself at 150 req/min (WarEra's
community docs mention a 200/min ceiling) and caches responses for 15–60 seconds
depending on how often that data changes.

There's also a community-run caching gateway at `gateway.warerastats.io/trpc/` that
batches/dedupes requests server-side and requires its own `X-API-Key` header. You can
point this app at it instead of the primary API — see Configuration below. It's a
convenience option, not something this app needs; the primary API works fine on its
own for a dashboard this size.

**A note on other third-party WarEra tools you might come across:** anything that
proxies your requests server-side (a "live API tester" website, for instance) sees
whatever you type into it, including any API key. Fine for poking at public read-only
data with no key attached; something to think twice about before pasting in credentials.

## Setup

Requires Node.js 18+.

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

### Configuration (optional)

Environment variables, all optional:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the dashboard server listens on |
| `WARERA_API_BASE_URL` | `https://api2.warera.io/trpc/` | Set to `https://gateway.warerastats.io/trpc/` to use the community gateway instead |
| `WARERA_GATEWAY_API_KEY` | (none) | Required if you set the base URL to the gateway |

```bash
WARERA_API_BASE_URL=https://gateway.warerastats.io/trpc/ WARERA_GATEWAY_API_KEY=your_key npm start
```

## Project layout

```
server.js          Express app — thin REST wrapper around the WarEra API
lib/warera.js       tRPC client: request building, in-memory cache, rate limiting, retries
public/index.html   Dashboard markup
public/style.css    Dashboard styling
public/app.js        Dashboard data-fetching + rendering
```

## Backend routes

| Route                                   | WarEra procedure               |
|------------------------------------------|---------------------------------|
| `GET /api/market/prices?item=CODE`        | `itemTrading.getPrices`         |
| `GET /api/market/orders?item=CODE`        | `tradingOrder.getTopOrders`     |
| `GET /api/rankings?type=wealth&limit=50`  | `ranking.getRanking`            |
| `GET /api/battle-rankings?battleId=...`   | `battleRanking.getRanking`      |
| `GET /api/battles?active=true&limit=20`   | `battle.getBattles`             |
| `GET /api/battles/:id`                    | `battle.getById`                |
| `GET /api/battles/:id/live`               | `battle.getLiveBattleData`      |
| `GET /api/countries`                      | `country.getAllCountries`       |
| `GET /api/search?q=...`                   | `search.searchAnything`         |
| `GET /api/users/:id`                       | `user.getUserById`              |
| `GET /api/events?limit=20&country=...`     | `event.getEventsPaginated`      |

Each route just calls `warera.query(procedure, input, options)` — adding a new one for
any other procedure (e.g. `mu.getById` for military units, `company.getById`,
`alliance.getManyPaginated`) is a 2-line addition in `server.js`. The known full
procedure catalog (73 procedures across ~35 namespaces, as of 2026-08) covers battles,
companies, alliances, tournaments, work/wages, and more — this dashboard only wires up
a fraction of it.

## If something breaks

- **A panel shows "Failed to load"**: check the terminal running `npm start` — the
  error from the WarEra API is logged there. Rate limiting (429) is retried
  automatically a few times; anything else usually means a procedure name or input
  shape has changed on WarEra's side.
- **A panel loads but columns are empty/"—"**: open the browser console, find the
  logged raw payload (e.g. `market/prices raw payload: …`), and update the relevant
  `pick([...])` field-name list in `public/app.js` to match.
- **Some endpoints may require auth** (the community docs mention rankings/referrals
  sometimes needing an API key). If you hit that, you'd add an `Authorization` or
  `X-API-Key` header in `lib/warera.js`'s `fetchWithRetry`.

## Disclaimer

Unofficial, community-built, not affiliated with WarEra. Read-only — this never writes
data back to the game.
