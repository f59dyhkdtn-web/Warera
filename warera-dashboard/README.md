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

The Market/Rankings/Battles tabs were removed from the UI (unused), but their backend
routes stay — `/api/market/prices` and `/api/market/orders` are still used internally
by Craft ROI and Cases (material prices, order-book prices), and the rest are cheap to
leave in place in case a future tab wants them.

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
| `GET /api/craft/history?hours=168`         | `transaction.getPaginatedTransactions` (reads from the background collector — see below) |

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
- **A number looks empty/"—"**: open the browser console, find the logged raw
  payload, and update the relevant field-name list in `public/app.js` to match.
- **Some endpoints may require auth** (the community docs mention rankings/referrals
  sometimes needing an API key). If you hit that, you'd add an `Authorization` or
  `X-API-Key` header in `lib/warera.js`'s `fetchWithRetry`.

## Craft ROI tab

Modeled after community "crafting ROI" trackers: a grid of all 6 rarities showing
margin %, sample size, and profit odds; click one to see a breakdown by equipment
slot; below that, average sale price broken down by the item's specific stat roll.
A 1h/2h/4h/8h/16h/24h filter re-slices everything by how recent the trades are —
with one deliberate exception, see "Recency vs completeness" below.

- **Craft cost**: live, from scraps/steel quantities per rarity (hardcoded, confirmed
  static in-game values) × current scraps/steel prices from `itemTrading.getPrices`.
- **Each rarity's overall figure is odds-weighted across slots (30% Weapon / 14% each
  armor piece), not a pool of raw sale counts.** Armor sells far more often than
  weapons on the open market (confirmed, not assumed) — an unweighted pool of
  individual sales would let armor's margin dominate and drown out weapon's true 30%
  share of what a craft actually produces. `weightedSlotCombine()` in `app.js` handles
  this; slots with zero sample are excluded and the remaining odds renormalized.
- **Material prices come from the real order book, not `itemTrading.getPrices`.**
  That endpoint turned out to return some other reference number — a live comparison
  against the actual in-game order book showed it meaningfully off from the price
  you'd really pay. `getOrderBookPrice()` in `app.js` fetches `tradingOrder.getTopOrders`
  for scraps/steel specifically. Confirmed live via console: the response is
  `{ buyOrders: [...], sellOrders: [...] }`, each order with a plain numeric `price`
  field — falls back to the reference price only if that fetch fails or the selected
  side has no active orders.
- **Ask vs Bid toggle**: defaults to **Ask** (cheapest active sell order — what buying
  instantly actually costs). Switching to **Bid** uses the highest active buy order
  instead (what patient buyers are already offering, if you'd rather place your own
  order and wait than pay to buy instantly).
- **Scraps/steel prices can be manually overridden** via the two inputs next to the
  recency controls — useful for checking a specific price point rather than
  whatever's live (and takes priority over the Ask/Bid toggle when set). Blank means
  "use live price"; "Reset to live" clears both at once. An active override is
  called out in the panel note.
- **Sale data comes from a continuously-running background collector, not a
  per-request fetch.** This API has no working server-side filter — `transactionType`
  and `limit` are both silently ignored (confirmed via `/api/craft/debug`), returning
  ~10 mixed records per page (wages, case openings, dismantles, market sales all
  together) regardless of what's requested. At real game volume, no single request
  could pull a representative sample without timing out. So `server.js` runs a loop
  (`ingestTick`, starts on boot) that pulls one page every ~320ms indefinitely,
  accumulating equipment sales into an in-memory store keyed by transaction `_id`.
  `/api/craft/history` just reads from that store instantly — no pagination happens
  inside a request anymore.
- **Retention is 7 days** (`STORE_WINDOW_MS` in `server.js`), extended from an
  original 26h specifically so infrequently-traded stat-roll combinations (a specific
  jet roll that might only sell once every several days) still have a real recent
  price to fall back on — see "Recency vs completeness" below. Capped at 150,000
  records; well within both Upstash's free-tier storage and Render's free-tier RAM,
  since equipment-only filtering already cuts ~90% of raw volume before storage.
- **Coverage builds up over time, not instantly**, and a restart empties the
  in-memory store — mitigated two ways, both optional: an UptimeRobot-style keep-alive
  ping prevents Render's free tier from sleeping (sleeps after 15 min idle, which
  would otherwise reset collection), and `UPSTASH_REDIS_REST_URL`/`_TOKEN` (see
  Configuration) persist the store across restarts and redeploys so it doesn't start
  over from zero each time. Without either, expect the tab to show very little right
  after a deploy or wake-up — the panel note shows real collection status, and the
  tab auto-refreshes every 30s so numbers visibly fill in as more accumulates.
- **Requires `WARERA_API_KEY`** (see Configuration) — without it, the collector keeps
  failing quietly (with backoff, so it's not hammering logs) and the tab shows a clear
  message, while the rest of the dashboard keeps working normally.
- **Rarity/slot/stat-roll are confirmed from live data** (via `/api/craft/debug`,
  included in this project for future debugging): equipment sales have a nested
  `item: { code: "helmet4", skills: {...} }` — `helmet4`'s digit (1–6) matches
  common→mythic order for armor. Price is `money` divided by `quantity`.
- **Weapon rarity comes from a player-confirmed name→rarity mapping**
  (`WEAPON_NAME_TO_RARITY` in `app.js`: knife=common, gun=uncommon, rifle=rare,
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

### Recency vs completeness

Two independent ways to pick which sales feed each stat-roll bucket's average:

- **By time window** (1h/2h/.../24h buttons): for each specific combination, prefers a
  price from the selected window if one exists, but falls back to that combination's
  most recent sale in the full ~24h history if the window has none — rather than
  silently dropping it. Without this, a real but infrequently-traded combination (a
  top roll that sold once 8 hours ago but not in the last hour) would vanish from the
  estimate purely because the window missed it, not because it doesn't exist. Cards
  using a fallback price are marked "older" with a dashed border.
- **By last N sales per combo** (Last 1 / Last 2 / Last 5 buttons): instead of a
  shared time window, takes each combination's own N most recent sales, whenever they
  happened. Two combinations that trade at very different frequencies both get "how
  has *this one* actually been selling lately" on equal footing — a fixed time window
  would show a rich sample for a common combo and nothing for a rare one, even though
  both are equally "current" relative to their own pace. Cards show how many of a
  combination's sales were actually used (e.g. "2 of 14× used").

Only one mode is active at a time — picking one deselects the other. Both modes feed
the same underlying calculation, so the rarity cards and breakdown table update to
match whichever is selected, not just the stat-roll grid.

### Interpolation for missing stat-roll combinations

A different gap from the one above: even with recency handled, a *specific* stat-roll
combination might simply never have sold at all within the whole retention window
(e.g. a particular jet attack/crit pairing, if jets trade rarely). `interpolateStatBuckets()`
fills these by linearly interpolating between the two nearest *real* observed
combinations — but only within the same secondary stat value (e.g. only across attack
values that share the same crit chance for weapons; the whole set for single-stat
armor, which has no secondary axis) — and only strictly between two observed points,
never extrapolating beyond the lowest/highest value actually seen for that secondary
value. Interpolated cards are visibly marked ("interpolated", dotted blue border,
zero sample count) so they're never mistaken for a real sale. This feeds into the same
bucket-averaging used everywhere (rarity cards, breakdown table, Cases), so its effect
isn't limited to the stat-roll grid.

**What this does NOT solve:** if a whole rarity+slot has zero sales at all in the
entire retention window (not just one missing combination, but nothing to interpolate
between), that outcome is still excluded from calculations entirely rather than
estimated — see `weightedEV()` in the Cases section below.

**"Sales" counts intentionally don't change between 1h/2h/.../24h** — that number is
always the full 7-day collected total for that row, since a tiny window's sample would
make the confidence badges misleading. **"Used" is real sales within your selected
window, full stop** — it can only grow (or stay the same) as you widen the window,
never shrink. An earlier version summed each stat-roll combination's own fallback
count instead (a combination with zero in-window sales pulls in its whole 7-day count
just to compute a price) — that made *narrower* windows show a *bigger* "used" number
whenever more combinations needed to fall back, which was backwards and confusing.
"Last N" mode uses a different, still-correct formula for the same reason (there's no
shared window to measure against in that mode) — see `statsFor()` in `app.js`.

## Cases tab

Compares buying/opening a case against just reselling it — same "sell everything /
scrap everything / optimal / your strategy" comparison the reference community tool
(the same one Craft ROI was modeled after) uses for this.

**Known gap**: if one of the 36 rarity+slot outcomes has zero sales at all across the
whole retention window, `weightedEV()` excludes it from the EV calculation entirely
and renormalizes probability across the remaining outcomes — it does not estimate a
value for it, since interpolation (see above) needs at least two real points to work
from and there's nothing to interpolate when a whole outcome has no data. This is
currently silent — no on-screen warning when it happens.

- **Case prices/SKUs are auto-discovered, not hardcoded.** `discoverCasePrices()`
  scans `itemTrading.getPrices`' response for any key containing "case" — confirmed
  by the person running this that cases do trade through that same simple-goods
  system as scraps/steel, so this is expected to reliably find them.
- **Outcome odds are a confirmed in-game formula, not observed frequency.**
  Confirmed directly from the in-game "Open Case" screen: 62% Common / 30% Uncommon /
  7.1% Rare / 0.85% Epic / 0.04% Legendary / 0.01% Mythic, and — also confirmed —
  equipment slot within a rolled rarity follows the same odds as crafting (30%
  Weapon / 14% each armor piece), independent of rarity. `theoreticalOutcomeOdds()`
  in `app.js` combines these into the full 36-outcome distribution. This applies to
  every case SKU equally — no per-case odds difference has been confirmed.
- **Scrap value is a confirmed in-game formula too.** Dismantling refunds exactly
  the scraps used to craft that rarity (100%) and confirmed **no steel refund** —
  `scrapValueFor()` reuses the same `CRAFT_COST` table Craft ROI already relies on,
  so the two stay in sync automatically.
- **Scraps are priced at Bid for scrap value specifically — always, regardless of
  Craft ROI's Ask/Bid toggle.** `getScrapsBidPrice()` calls `getOrderBookPrice()`
  with an explicit side override rather than reading the shared `priceSide` global.
  Reasoning: scrap value represents scraps you're receiving and (per the plan
  behind this tab) intend to sell — the price actually realized selling something is
  Bid (what buyers are offering), not Ask (what it'd cost to buy scraps yourself).
  Craft cost elsewhere keeps using whichever side Craft ROI has selected, since
  that's a purchase, not a sale.
- **Scrapyard upgrade** (None / 1-5, buttons next to the time window): a confirmed
  1-5% bonus to scraps received from dismantling, applied unrounded (e.g. level 4 on
  a Common's 6 base scraps = 6.24, not rounded to 6). Defaults to None — set it to
  your actual level. Pure multiplier, so switching it just recomputes from
  already-cached data, no refetch.
- **Sell values reuse Craft ROI's existing rarity+slot price data** (`statsFor()`) —
  no separate pricing logic, so improvements to Craft ROI's accuracy carry over here
  automatically. This is the one part of the calculation still bounded by real
  collected sales, same as Craft ROI itself.
- **Has its own time-window selector, independent of Craft ROI's.** Defaults to 24h,
  goes up to 7d (the full retention window). Same window+fallback behavior as Craft
  ROI (prefers a sale within the window, falls back to the most recent sale further
  back if none) — just a separate `casesHoursWindow` value, since you might
  reasonably want a faster-moving window on Craft ROI while Cases uses a steadier one
  for a buy/don't-buy decision, or vice versa.
- **`openCase` and `dismantleItem` transactions are still collected** in the
  background (alongside `itemMarket` sales), but only informationally now, logged to
  the console — not required for the tab to show real numbers, since odds and scrap
  value come from the confirmed formulas above instead. Could be used later as a
  cross-check against the formulas if useful.
- **Headline % and verdict use the "default" strategy, not "optimal".** `DEFAULT_STRATEGY`
  (fixed: scrap Common/Uncommon, sell everything else) is the realistic ceiling on
  what someone will actually do — the theoretical "optimal" (max of sell/scrap per
  outcome) assumes hand-scrapping every single Common/Uncommon roll individually,
  impractical at real volume, so it's shown as a plain reference row instead of the
  headline number.
- **The custom-strategy panel** (sell vs scrap per rarity) starts pre-filled to match
  `DEFAULT_STRATEGY` rather than all-"sell" — adjust per rarity from there, and both
  case cards' "your strategy" row updates live from the same already-collected data,
  no refetch.

## My ROI tab

A real personal transaction tracker — confirmed via live browser DevTools capture to
work with actually-filtered, complete per-user data, unlike Craft ROI/Cases' passive
sampling of the whole game.

- **How the userId filter got confirmed working, when every other filter tested in
  this project wasn't**: `transaction.getPaginatedTransactions` genuinely respects
  `userId` — but only via a specific request shape (POST, plain JSON body
  `{ "0": { direction, limit, userId, ... } }`, `batch=1`) that nothing earlier in
  this project had tried; every prior attempt used a GET-based shape instead. Found by
  capturing the real request WarEra's own in-game "Transactions" page makes (at
  `/user/<id>/transactions`), via DevTools Network tab, then reproducing it
  server-side. That page's own requests go to `api4.warera.io`, which explicitly
  rejects API-token auth ("Use api2.warera.io") — so this app sends the same
  confirmed request shape to `api2.warera.io` instead, which does accept the token.
  `queryPost()` and `queryUserTransactions()` in `lib/warera.js` implement this.
- **This means real, complete history is achievable — not just passive sampling.**
  `/api/my/transactions` pages directly through one user's own transactions using
  this working filter, going back as far as requested (up to 4 weeks by default) in
  one efficient, targeted fetch — not the general collector's approach of sampling
  everything and hoping.
- **Cash-flow direction ("seller receives, buyer pays") is confirmed for item/trading
  sales specifically, assumed (not independently verified) for other types** like
  wages or donations, since they share the identical `buyerId`/`sellerId` shape but
  haven't been checked one-by-one the way item sales were.
- **Crafting, Dismantling, and Case Opening show counts only in the by-type table** —
  those records don't carry a `money` field (they're material/loot events, not
  currency transfers). **But crafting IS now connected to its eventual sale**, via the
  "Craft → Sell chains" section — see below.
- **Craft → Sell chain-following, using each item's own persistent ID.** Confirmed via
  live console inspection (not assumed): a crafted item has its own `_id`, separate
  from the transaction's `_id`, that stays stable through its lifetime — appearing
  again in whichever `itemMarket` sale or `dismantleItem` record eventually happens to
  it. `linkCraftLifecycles()` in `app.js` groups the (confirmed real) multiple
  `craftItem` records a single craft produces — one per material consumed, e.g. one
  for scraps and one for steel, all sharing the same item ID — into one total
  material cost per item, then looks for a later sale or dismantle sharing that same
  ID. Items with both ends of the chain inside the fetched window get a real per-item
  profit figure; items crafted but not yet resolved show as "still held" (cost known,
  outcome pending) rather than being silently dropped or guessed at. Material cost
  uses today's live scraps/steel price, not the price actually paid at crafting time
  (not tracked) — an approximation for older crafts, noted as such in the UI.
- **Persisted per user (if Upstash is configured), with incremental refresh.** First
  load for a new user has to page through their full requested history — unavoidably
  slow. Every load after that only fetches transactions newer than what's already
  persisted (`queryUserTransactions`' `knownIds` param stops paging as soon as it
  recognizes an already-seen transaction, since pages return newest-first), then
  merges with the stored snapshot. Keeps a rolling 5-week window server-side
  regardless of what's currently selected, so widening the weeks dropdown doesn't
  force a full refetch either. Without Upstash configured, this still works — it's
  just slow every time, like the first load always is.
- **The background collector was slowed slightly (400ms/tick, from 320ms) to make
  room for this.** It was continuously using nearly the entire shared rate budget,
  which meant a first-time My ROI load (up to 200 sequential requests) had to queue
  behind it. Trades a bit of Craft ROI/Cases collection speed for on-demand
  requests actually getting a fair share of the budget.
- No account/login system — you paste in your own user ID (found in your profile's
  URL) each time; nothing is stored server-side beyond a brief 3-minute cache per ID
  and (if Upstash is configured) the persisted per-user snapshot described above.

## Disclaimer

Unofficial, community-built, not affiliated with WarEra. Read-only — this never writes
data back to the game.
