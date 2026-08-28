'use strict';

/**
 * Thin client for WarEra's tRPC API, routed through the community gateway
 * at gateway.warerastats.io by default (see below for why).
 *
 * IMPORTANT / READ ME:
 * There is no official WarEra-run public API. This uses:
 *  - Endpoint names & input parameters: officially documented by the
 *    gateway itself at https://gateway.warerastats.io/ (fetched directly,
 *    not secondhand — this is the most reliable source we have).
 *  - Response *output* shapes: NOT documented anywhere found so far. Each
 *    route in server.js / consumer in app.js logs the raw payload to the
 *    console and extracts fields defensively — if a field looks wrong,
 *    check the console log.
 *
 * WHY THE GATEWAY AND NOT api2.warera.io DIRECTLY:
 * A couple of endpoints (transaction.getPaginatedTransactions, for one)
 * return 401 from the primary API — they need a logged-in session, not
 * just a public request. The gateway continuously scrapes and stores that
 * data itself, so it can serve it back without needing your session. It
 * also documents itself as free, keyless, drop-in-compatible with the
 * primary API. Everything else this app uses is supported there too.
 * Override with WARERA_API_BASE_URL if you ever want to point back at
 * api2.warera.io directly (auth-requiring calls just won't work there).
 */

// Defaults to the community gateway (gateway.warerastats.io) rather than
// api2.warera.io directly — see the note above for why. No API key needed
// per the gateway's own docs (WARERA_GATEWAY_API_KEY below is unused
// unless that changes; kept as an escape hatch). Must end with a trailing
// slash; normalized below if not. Override with WARERA_API_BASE_URL to
// point elsewhere, e.g. back at the primary API.
const RAW_BASE_URL = process.env.WARERA_API_BASE_URL || 'https://gateway.warerastats.io/trpc/';
const BASE_URL = (RAW_BASE_URL.endsWith('/') ? RAW_BASE_URL : `${RAW_BASE_URL}/`).replace(/\/$/, '');
const GATEWAY_API_KEY = process.env.WARERA_GATEWAY_API_KEY || '';

// The gateway states its own rate limit as 200/min with request dedup and
// 400ms batching built in; we still self-limit as a courtesy.
const RATE_LIMIT_PER_MINUTE = 150;
const RATE_LIMIT_WINDOW_MS = 60_000;

// Default cache TTLs per data category (milliseconds). Tune freely.
const CACHE_TTL_MS = {
  market: 30_000, // prices move often but not every second
  rankings: 60_000,
  battles: 15_000, // battles are close to live
  battleLive: 5_000,
  default: 30_000,
};

// ---- tiny in-memory cache -------------------------------------------------

const cache = new Map(); // key -> { expiresAt, value }

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// ---- tiny token-bucket rate limiter ---------------------------------------

let tokens = RATE_LIMIT_PER_MINUTE;
setInterval(() => {
  tokens = RATE_LIMIT_PER_MINUTE;
}, RATE_LIMIT_WINDOW_MS).unref();

const waitQueue = [];

function scheduleQueueDrain() {
  if (waitQueue.length === 0) return;
  setTimeout(() => {
    while (tokens > 0 && waitQueue.length > 0) {
      tokens -= 1;
      const resolve = waitQueue.shift();
      resolve();
    }
    if (waitQueue.length > 0) scheduleQueueDrain();
  }, 250);
}

function takeToken() {
  if (tokens > 0) {
    tokens -= 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waitQueue.push(resolve);
    scheduleQueueDrain();
  });
}

// ---- request building ------------------------------------------------------

/**
 * Builds candidate URLs for a tRPC query, most-likely-correct first.
 * We try each in order until one returns a parseable 2xx response.
 */
function buildUrls(procedure, input) {
  const urls = [];

  if (input === undefined) {
    // No-input query — the simple case, same across tRPC conventions.
    urls.push(`${BASE_URL}/${procedure}`);
    return urls;
  }

  // Shape A: batch=1 with superjson-style wrapping (common for Next.js
  // apps using httpBatchLink + superjson transformer).
  const batchInput = encodeURIComponent(JSON.stringify({ 0: { json: input } }));
  urls.push(`${BASE_URL}/${procedure}?batch=1&input=${batchInput}`);

  // Shape B: plain (non-batched) input, no transformer wrapping.
  const plainInput = encodeURIComponent(JSON.stringify(input));
  urls.push(`${BASE_URL}/${procedure}?input=${plainInput}`);

  return urls;
}

/**
 * Pulls the actual payload out of whatever shape the server responded
 * with. Handles: batched array response, single superjson-wrapped
 * response, and plain response.
 */
function unwrapResult(body) {
  // Batched: [ { result: { data: { json: ... } } } ]
  if (Array.isArray(body)) {
    const first = body[0];
    if (first?.result?.data?.json !== undefined) return first.result.data.json;
    if (first?.result?.data !== undefined) return first.result.data;
    if (first?.error) throw new Error(first.error.message || 'WarEra API error');
    return first;
  }
  // Single: { result: { data: { json: ... } } } or { result: { data: ... } }
  if (body?.result?.data?.json !== undefined) return body.result.data.json;
  if (body?.result?.data !== undefined) return body.result.data;
  if (body?.error) throw new Error(body.error.message || 'WarEra API error');
  return body;
}

async function fetchWithRetry(url, attempt = 0) {
  await takeToken();

  const headers = {
    // Some endpoints (e.g. rankings/referrals) reportedly check
    // Origin — matching a real browser session avoids surprises.
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Origin: 'https://app.warera.io',
    Accept: 'application/json',
  };
  // Required when BASE_URL points at gateway.warerastats.io — omitted
  // entirely against the primary API since it doesn't need it.
  if (GATEWAY_API_KEY) headers['X-API-Key'] = GATEWAY_API_KEY;

  const res = await fetch(url, { headers });

  if (res.status === 429 && attempt < 4) {
    const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return fetchWithRetry(url, attempt + 1);
  }

  return res;
}

/**
 * Calls a WarEra tRPC query procedure, with caching and rate limiting.
 *
 * @param {string} procedure e.g. "itemTrading.getPrices"
 * @param {object} [input] query input, if the procedure needs one
 * @param {object} [opts]
 * @param {string} [opts.cacheCategory] key into CACHE_TTL_MS
 * @param {number} [opts.cacheTtlMs] overrides the category TTL
 * @param {boolean} [opts.skipCache]
 */
async function query(procedure, input, opts = {}) {
  const cacheKey = `${procedure}:${JSON.stringify(input ?? null)}`;
  if (!opts.skipCache) {
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;
  }

  const urls = buildUrls(procedure, input);
  let lastError;

  for (const url of urls) {
    try {
      const res = await fetchWithRetry(url);
      if (!res.ok) {
        lastError = new Error(`WarEra API ${res.status} for ${procedure}`);
        continue;
      }
      const body = await res.json();
      const data = unwrapResult(body);
      const ttl = opts.cacheTtlMs ?? CACHE_TTL_MS[opts.cacheCategory] ?? CACHE_TTL_MS.default;
      cacheSet(cacheKey, data, ttl);
      return data;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`WarEra API request failed for ${procedure}`);
}

/**
 * Pulls a batch of a paginated procedure's results into one flat array,
 * following cursor-style pagination and stopping once either enough pages
 * have been fetched, a hard record cap is hit, or the items themselves
 * report timestamps older than `oldestMs` (whichever comes first).
 *
 * The exact shape of a paginated response (is the cursor called
 * `nextCursor`? is the list called `items`?) isn't independently
 * confirmed for this API — this tries the common tRPC infinite-query
 * convention ({ items, nextCursor }) and a couple of fallbacks. If
 * pagination silently stops after one page, that's the likely culprit —
 * check what a raw response actually looks like and adjust `extractPage`.
 *
 * @param {string} procedure
 * @param {object} baseInput input fields other than cursor/limit
 * @param {object} [opts]
 * @param {number} [opts.pageSize=100]
 * @param {number} [opts.maxPages=20]
 * @param {number} [opts.maxRecords=2000]
 * @param {number} [opts.oldestMs] stop once items are older than this (epoch ms)
 * @param {function} [opts.getTimestamp] (item) => epoch ms | null
 */
async function queryPaginated(procedure, baseInput, opts = {}) {
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 20;
  const maxRecords = opts.maxRecords ?? 2000;
  const getTimestamp = opts.getTimestamp ?? (() => null);

  const all = [];
  let cursor;

  for (let page = 0; page < maxPages; page += 1) {
    const input = { ...baseInput, limit: pageSize };
    if (cursor !== undefined) input.cursor = cursor;

    const data = await query(procedure, input, { skipCache: true });

    const items = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.results)
      ? data.results
      : [];

    if (items.length === 0) break;
    all.push(...items);

    if (all.length >= maxRecords) break;

    if (opts.oldestMs !== undefined) {
      const oldestOnPage = Math.min(
        ...items.map((it) => getTimestamp(it)).filter((t) => Number.isFinite(t))
      );
      if (Number.isFinite(oldestOnPage) && oldestOnPage < opts.oldestMs) break;
    }

    cursor = data?.nextCursor ?? data?.cursor ?? data?.meta?.nextCursor;
    if (cursor === undefined || cursor === null) break;
  }

  return all;
}

module.exports = { query, queryPaginated, CACHE_TTL_MS };
