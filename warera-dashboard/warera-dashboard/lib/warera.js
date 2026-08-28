'use strict';

/**
 * Thin client for the (unofficial, reverse-engineered) WarEra tRPC API.
 *
 * IMPORTANT / READ ME:
 * There is no official public API spec. Everything here is based on
 * community reverse-engineering (majimawrks/warera-api-docs,
 * majimawrks/warera-fetch, gsipos/warera-tools). The base URL and
 * procedure names are believed correct as of writing, but the exact
 * *query string shape* tRPC expects (plain input vs. batch+superjson
 * wrapped input) can vary by server config and may drift over time.
 *
 * If requests start failing:
 *   1. Open https://app.warera.io in a browser, open DevTools > Network,
 *      trigger the screen that shows market/ranking/battle data, and look
 *      at an actual request to api2.warera.io/trpc/... to see the real
 *      query string shape and copy it here.
 *   2. This client already tries the two most common tRPC shapes
 *      (see `buildUrl`) and falls back automatically, so a single
 *      procedure name changing on WarEra's side is the most likely
 *      break point, not the request format.
 */

// Configurable so you can point this at the community gateway
// (https://gateway.warerastats.io/trpc/) instead of the primary API — the
// gateway batches/dedupes/caches on its end, which helps if you're doing a
// lot of reads. Must end with a trailing slash; normalized below if not.
// The gateway requires an X-API-Key header (see WARERA_GATEWAY_API_KEY).
const RAW_BASE_URL = process.env.WARERA_API_BASE_URL || 'https://api2.warera.io/trpc/';
const BASE_URL = (RAW_BASE_URL.endsWith('/') ? RAW_BASE_URL : `${RAW_BASE_URL}/`).replace(/\/$/, '');
const GATEWAY_API_KEY = process.env.WARERA_GATEWAY_API_KEY || '';

// WarEra community docs mention a 200 requests/minute limit on the primary
// API. We stay comfortably under that with a simple token-bucket limiter.
// (If you switch to the gateway, its own batching/caching means this limit
// matters less, but there's no harm leaving it on.)
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

module.exports = { query, CACHE_TTL_MS };
