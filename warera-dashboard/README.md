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
| `UPSTASH_REDIS_REST_URL` | (none) | Enables persistence for Craft ROI's collected sales — see below |
| `UPSTASH_REDIS_REST_TOKEN` | (none) | Paired with the URL above |

Transaction history (Craft ROI's sale prices) will 401 without `WARERA_API_KEY` set —
that's expected, not a bug. Everything else works with no configuration at all.

```bash
WARERA_API_KEY=wae_your_token_here npm start
```

### Making Craft ROI's data survive redeploys (optional)

By default, Craft ROI's collected sales data lives only in memory — every redeploy,
and every Render free-tier sleep/wake cycle (sleeps after 15 min idle), resets it to
zero and it has to rebuild from scratch. Setting `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` fixes that: the collected dataset is loaded from a free
[Upstash](https://upstash.com) Redis database on startup and saved back every 5
minutes (plus once more right before a redeploy kills the old instance), so restarts
resume instead of starting over.

1. Sign up at upstash.com (free, no credit card) and create a Redis database.
2. From that database's page, copy the **REST URL** and **REST Token**.
3. On Render, add them as environment variables: `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN`, then redeploy once to pick them up.

The free tier (500K commands/month, 256MB storage) covers this comfortably — this app
only writes a handful of times per hour, not per transaction.

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
- **Sale data comes from a continuously-running background collector, not a
  per-request fetch.** This API has no working server-side filter — `transactionType`
  and `limit` are both silently ignored (confirmed via `/api/craft/debug`), returning
  ~10 mixed records per page (wages, case openings, dismantles, market sales all
  together) regardless of what's requested. At real game volume, no single request
  could pull a representative sample without timing out. So `server.js` runs a loop
  (`ingestTick`, starts on boot) that pulls one page every ~700ms indefinitely,
  accumulating equipment sales into an in-memory store keyed by transaction `_id`.
  `/api/craft/history` just reads from that store instantly — no pagination happens
  inside a request anymore.
- **This means coverage builds up over time, not instantly.** Right after a deploy or
  a Render free-tier wake-up (sleeps after 15 min idle, which resets the in-memory
  store), expect the tab to show very little — it only reflects what's been collected
  since the process started, and cannot retroactively backfill a full day in one shot.
  The panel note shows real collection status; the tab auto-refreshes every 30s so
  numbers visibly fill in as more accumulates. If you want durable long-term coverage
  across restarts, that's a real gap to solve for later (external keep-alive pings, a
  paid always-on tier, or persisting the store to disk/a DB instead of memory).
- **Requires `WARERA_API_KEY`** (see Configuration) — without it, the collector keeps
  failing quietly (with backoff, so it's not hammering logs) and the tab shows a clear
  message, while the rest of the dashboard keeps working normally.
- **Rarity/slot/stat-roll are confirmed from live data** (via `/api/craft/debug`,
  included in this project for future debugging): equipment sales have a nested
  `item: { code: "helmet4", skills: {...} }` — `helmet4`'s digit (1–6) matches
  common→mythic order for armor. Price is `money` divided by `quantity`.
- **Weapon rarity comes from a player-confirmed name→rarity mapping**
  (`WEAPON_NAME_TO_RARITY` in `app.js`: knife=common, rifle=uncommon, gun=rare,
  sniper=epic, tank=legendary, jet=mythic) — each weapon name is its own rarity
  tier, the same way armor has one piece per slot+digit. This isn't a documented API
  field like armor's digit suffix is; it's what the person running this confirmed
  in-game. If a new weapon name shows up that isn't in that map, its rarity is left
  unknown rather than guessed — check `item codes collected so far` in the console
  (logged automatically) to catch that.
- **Weapon stat rolls are a combination of two values** (e.g. attack + crit chance),
  not one — `parseTransaction()` builds a combined `statKey` from every field in
  `skills` sorted by name, so the stat-roll grid buckets by the full combination
  (a specific attack+crit pairing), matching how a single craft actually rolls both
  at once rather than treating them as independent.
- Sample-size confidence badges (high/medium/low) use thresholds I picked (100 / 20
  sales) — not a WarEra-published figure, just a reasonable line so a 2-sale average
  isn't shown with the same weight as a 500-sale one.

## Disclaimer

Unofficial, community-built, not affiliated with WarEra. Read-only — this never writes
data back to the game.
