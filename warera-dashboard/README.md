# WarEra Dispatch — unofficial stats dashboard

A small dashboard for the browser game [WarEra](https://app.warera.io): market prices,
player/country rankings, and active battles.

## What this is (and isn't)

WarEra has **no official public API**, but it does have official **per-account API
tokens** — generate one from your account's "API Tokens" screen in-game. This app uses
`api2.warera.io` (the same backend the game's own web client uses) for everything.
Most of it works with no token at all; transaction history (Craft ROI's sale prices)
needs one, since that endpoint 401s on anonymous requests.

Worth knowing:

1. **Set `WARERA_API_KEY` to get Craft ROI's sale-price data working.** Generate a
   dedicated token in-game (don't reuse one already wired into another tool) and set
   it as an environment variable — see Configuration below. Without it, everything
   else in the dashboard still works fine; only that one tab's sale-price section
   shows a clear message instead of data.
2. **Response shapes aren't documented anywhere found so far** — only request
   parameters are (via [gateway.warerastats.io](https://gateway.warerastats.io/)'s own
   docs page, used as a reference even though this app calls the primary API
   directly). Every route logs its raw payload to the browser console for exactly
   this reason; check there if a column looks wrong.
3. **Treat your token like a password.** It's tied to your real WarEra account. Only
   set it as an environment variable on your host (Render, etc.) — never commit it
   into a file that goes to GitHub. You can revoke it any time from the same in-game
   screen you created it on.

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
| `WARERA_API_KEY` | (none) | Your personal WarEra API token — required for Craft ROI's sale-price data, unused everywhere else |
| `WARERA_API_BASE_URL` | `https://api2.warera.io/trpc/` | Overrides the base URL for every call, if you ever need to point elsewhere |

Transaction history (Craft ROI's sale prices) will 401 without `WARERA_API_KEY` set —
that's expected, not a bug. Everything else works with no configuration at all.

```bash
WARERA_API_KEY=wae_your_token_here npm start
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
  first. **Requires `WARERA_API_KEY`** (see Configuration) — without it, this section
  shows a clear message rather than data, while the rest of the dashboard keeps
  working normally. The time-window buttons re-filter the already-fetched batch
  client-side — no extra API calls per click.
- **Rarity/slot come from parsing `itemCode`, confirmed from live data**: equipment
  codes look like `helmet4` — a slot name plus a digit 1–6 matching common→mythic
  order (4 = epic). Price comes from the `money` field (divided by `quantity`, since
  some rows are multi-unit). **Weapon sale codes (e.g. `sniper`) don't carry that
  digit**, so weapon rarity can't be determined from the sale data alone — the
  breakdown table pools all weapon sales together regardless of rarity and marks that
  row "indicative" rather than guessing, matching how community trackers handle the
  same gap. Stat-roll values are still unconfirmed — `parseTransaction()` in `app.js`
  tries several plausible field names for that one; **the stat-roll grid is the part
  most likely to still come up empty** — if it does, that section says so explicitly,
  and the console log (`craft history raw payload`) is where to find the real field
  name to add.
- Sample-size confidence badges (high/medium/low) use thresholds I picked (100 / 20
  sales) — not a WarEra-published figure, just a reasonable line so a 2-sale average
  isn't shown with the same weight as a 500-sale one.

## Disclaimer

Unofficial, community-built, not affiliated with WarEra. Read-only — this never writes
data back to the game.
