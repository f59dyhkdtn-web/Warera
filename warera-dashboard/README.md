# WarEra Dispatch — unofficial stats dashboard

A small dashboard for the browser game [WarEra](https://app.warera.io): market prices,
player/country rankings, and active battles.

## What this is (and isn't)

WarEra has **no official public API**. This app talks to `api2.warera.io` (the same
backend the game's own web client uses) for everything by default. One exception:
transaction history (used by the Craft ROI tab) 401s there — it needs a logged-in
session, not just a public request — so that one call is routed instead to
[**gateway.warerastats.io**](https://gateway.warerastats.io/), a community-run proxy
that scrapes and stores its own copy of transaction data.

Worth knowing:

1. **The gateway's own docs say it's free and keyless**, but a live test showed it
   also returning 401 on calls that work fine against the primary API — a real
   contradiction I couldn't resolve without testing it live myself. So it's isolated
   to just the one call that needs it (rather than trusted as a global default), and
   if it doesn't work, Craft ROI's sale-price data will show a clear error while the
   rest of the dashboard keeps working normally.
2. **Response shapes aren't documented anywhere found so far** — only request
   parameters are (via the gateway's own page). Every route logs its raw payload to
   the browser console for exactly this reason; check there if a column looks wrong.
3. `WARERA_API_BASE_URL` env var overrides the base URL for *everything* if you want
   to point it elsewhere; `WARERA_GATEWAY_API_KEY` sets an `X-API-Key` header for
   gateway calls specifically, in case that turns out to be what it actually needs.

Respect the game's rate limits — the client here caps itself at 150 req/min (WarEra's
community docs mention a 200/min ceiling) and caches responses for 15–60 seconds
depending on how often that data changes.

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
| `WARERA_API_BASE_URL` | `https://api2.warera.io/trpc/` | Overrides the base URL for EVERY call (not just transaction history) |
| `WARERA_GATEWAY_API_KEY` | (none) | Sends `X-API-Key` on gateway calls — try this if Craft ROI's sale data still 401s |

Transaction history (Craft ROI's sale prices) always goes through the gateway
specifically, regardless of `WARERA_API_BASE_URL` — see the Craft ROI section below
for why, and what happens if the gateway rejects it too.

```bash
WARERA_GATEWAY_API_KEY=your_key npm start
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
  first. This call is routed to the gateway specifically (the primary API 401s on it),
  isolated from every other call in the app — if the gateway also rejects it, you'll
  see a clear message in the Craft ROI tab explaining that, while the rest of the
  dashboard (Market/Rankings/Battles) keeps working normally. The time-window buttons
  re-filter the already-fetched batch client-side — no extra API calls per click.
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
