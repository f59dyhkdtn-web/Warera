# WarEra Dispatch — unofficial stats dashboard

A small dashboard for the browser game [WarEra](https://app.warera.io): market prices,
player/country rankings, and active battles.

## What this is (and isn't)

WarEra has **no official public API**. This app talks to
[**gateway.warerastats.io**](https://gateway.warerastats.io/) — a free, keyless,
community-run proxy that's officially documented (endpoint names and input
parameters are confirmed straight from that page) and mirrors the real WarEra API
1:1. It also has its own scraped database for a few things the primary API won't
serve without a logged-in session — transaction history being the one this app
needs, for the Craft ROI tab.

Two things are still not guaranteed, worth knowing:

1. **Response shapes aren't documented anywhere found so far** — only the request
   parameters are. Every route logs its raw payload to the browser console for
   exactly this reason; if a column looks empty or wrong, check the console.
2. It's still a third party, not WarEra itself — it could change or go away.
   `WARERA_API_BASE_URL` env var lets you point back at `https://api2.warera.io/trpc/`
   directly if needed (transaction history won't work there — see Craft ROI section).

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

## Craft ROI tab

Modeled after community "crafting ROI" trackers: a grid of all 6 rarities showing
margin %, sample size, and profit odds; click one to see a breakdown by equipment
slot; below that, average sale price broken down by the item's specific stat roll.
A 1h/2h/4h/8h/16h/24h filter re-slices everything by how recent the trades are.

- **Craft cost**: live, from scraps/steel quantities per rarity (hardcoded, confirmed
  static in-game values) × current scraps/steel prices from `itemTrading.getPrices`.
- **Sale data**: pulled once per ~3 minutes from `/api/craft/history`, which pages
  through `transaction.getPaginatedTransactions` (filtered to `transactionType:
  itemMarket`) accumulating up to 2000 records or 24 hours of trades, whichever comes
  first. The time-window buttons just re-filter that already-fetched batch client-side
  — no extra API calls per click.
- **Rarity/slot inference and stat-roll values are NOT confirmed against a real schema.**
  Only the *request* parameters for `transaction.getPaginatedTransactions` are
  documented (by the gateway); the *response* shape isn't. `parseTransaction()` in
  `app.js` tries several plausible field names for rarity, slot, price, and stat value,
  and logs a sample of the raw payload to the console. **The stat-roll grid is the part
  most likely to come up empty** — if it does, that section says so explicitly rather
  than showing fake numbers, and the console log is where to find the real field name
  to add.
- Sample-size confidence badges (high/medium/low) use thresholds I picked (100 / 20
  sales) — not a WarEra-published figure, just a reasonable line so a 2-sale average
  isn't shown with the same weight as a 500-sale one.

## Disclaimer

Unofficial, community-built, not affiliated with WarEra. Read-only — this never writes
data back to the game.
