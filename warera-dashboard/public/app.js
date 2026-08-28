'use strict';

/*
 * Frontend for the WarEra dashboard.
 *
 * NOTE ON FIELD NAMES: the backend's response *shape* for each item
 * (a price row, a ranking row, a battle) is not from an official spec —
 * it's a best guess from community docs. Each render function below
 * tries a short list of plausible field names (see `pick`) before
 * giving up, and logs the raw payload to the console so you can see
 * the real field names your account's data comes back with and adjust
 * `pick(...)` calls accordingly.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function pick(obj, keys, fallback = '—') {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return fallback;
}

function fmtNum(n) {
  if (typeof n !== 'number') {
    const parsed = Number(n);
    if (Number.isNaN(parsed)) return n ?? '—';
    n = parsed;
  }
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

async function api(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || `Request failed: ${path}`);
  }
  return body.data;
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  // Some tRPC procedures return { items: [...] } style pagination.
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function emptyRow(colspan, text) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = colspan;
  td.className = 'empty-state';
  td.textContent = text;
  tr.appendChild(td);
  return tr;
}

// ---- Tabs -------------------------------------------------------------

function initTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('is-active'));
      $$('.panel').forEach((p) => p.classList.remove('is-active'));
      tab.classList.add('is-active');
      $(`#panel-${tab.dataset.tab}`).classList.add('is-active');
    });
  });
}

// ---- Ticker -------------------------------------------------------------

async function refreshTicker() {
  const el = $('#tickerText');
  try {
    const battles = asArray(await api('/api/battles?active=true&limit=50'));
    el.textContent = `uplink stable · ${battles.length} active front${battles.length === 1 ? '' : 's'} · last sync ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    el.textContent = `uplink degraded — ${err.message}`;
  }
}

// ---- Market -------------------------------------------------------------

/**
 * itemTrading.getPrices returns a flat object — { itemCode: price, ... } —
 * not a list of rows. Some other endpoints on this API DO return arrays,
 * so this still checks for that shape first in case WarEra changes it
 * later, then falls back to treating a plain object as a code->price map.
 */
function marketRowsFrom(data) {
  if (Array.isArray(data)) {
    return data.map((row) => ({
      item: pick(row, ['itemCode', 'code', 'item', 'name']),
      price: Number(pick(row, ['price', 'sellPrice', 'bestSell', 'value'], null)),
    }));
  }
  if (data && typeof data === 'object') {
    return Object.entries(data).map(([item, price]) => ({ item, price: Number(price) }));
  }
  return [];
}

async function loadMarket() {
  const tbody = $('#marketTable tbody');
  const note = $('#marketNote');
  tbody.innerHTML = '';
  note.textContent = 'loading…';

  try {
    const data = await api('/api/market/prices');
    console.log('market/prices raw payload:', data);
    let rows = marketRowsFrom(data);

    const filter = $('#marketFilter').value.trim().toLowerCase();
    if (filter) rows = rows.filter((r) => r.item.toLowerCase().includes(filter));
    rows.sort((a, b) => a.item.localeCompare(b.item));

    if (rows.length === 0) {
      tbody.appendChild(emptyRow(2, 'No items returned. Check the console for the raw payload shape.'));
      note.textContent = '';
      return;
    }

    for (const { item, price } of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${item}</td>
        <td class="num">${Number.isFinite(price) ? fmtNum(price) : '—'}</td>
      `;
      tbody.appendChild(tr);
    }
    note.textContent = `${rows.length} item${rows.length === 1 ? '' : 's'} · cached ~30s`;
  } catch (err) {
    tbody.appendChild(emptyRow(2, `Failed to load: ${err.message}`));
    note.textContent = '';
  }
}

// ---- Rankings -------------------------------------------------------------

async function loadRankings() {
  const tbody = $('#rankingsTable tbody');
  const note = $('#rankingsNote');
  tbody.innerHTML = '';
  note.textContent = 'loading…';

  try {
    const type = $('#rankingType').value;
    const data = await api(`/api/rankings?type=${encodeURIComponent(type)}&limit=50`);
    const rows = asArray(data);
    console.log('rankings raw payload:', data);

    if (rows.length === 0) {
      tbody.appendChild(emptyRow(4, 'No ranking rows returned. Check the console for the raw payload shape.'));
      note.textContent = '';
      return;
    }

    rows.forEach((row, i) => {
      const name = pick(row, ['username', 'uname', 'name', 'displayName']);
      const country = pick(row, ['country', 'countryName']);
      const value = pick(row, ['value', 'score', type], null);

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="num">${i + 1}</td>
        <td>${name}</td>
        <td>${country}</td>
        <td class="num">${value !== null ? fmtNum(value) : '—'}</td>
      `;
      tbody.appendChild(tr);
    });
    note.textContent = `top ${rows.length} by ${type} · cached ~60s`;
  } catch (err) {
    tbody.appendChild(emptyRow(4, `Failed to load: ${err.message}`));
    note.textContent = '';
  }
}

// ---- Battles -------------------------------------------------------------

async function loadBattles() {
  const grid = $('#battleGrid');
  const note = $('#battlesNote');
  grid.innerHTML = '';
  note.textContent = 'loading…';

  try {
    const activeOnly = $('#battlesActiveOnly').checked;
    const data = await api(`/api/battles?limit=30${activeOnly ? '&active=true' : ''}`);
    const rows = asArray(data);
    console.log('battles raw payload:', data);

    if (rows.length === 0) {
      grid.innerHTML = '';
      grid.appendChild(Object.assign(document.createElement('div'), {
        className: 'empty-state',
        textContent: 'No battles returned. Check the console for the raw payload shape.',
      }));
      note.textContent = '';
      return;
    }

    for (const battle of rows) {
      const attacker = pick(battle, ['attackerName', 'attackerCountry', 'attacker'], 'Attacker');
      const defender = pick(battle, ['defenderName', 'defenderCountry', 'defender'], 'Defender');
      const region = pick(battle, ['regionName', 'region', 'location'], '');
      const attackerScore = Number(pick(battle, ['attackerScore', 'attackerDamage', 'attackerPoints'], 0)) || 0;
      const defenderScore = Number(pick(battle, ['defenderScore', 'defenderDamage', 'defenderPoints'], 0)) || 0;
      const total = attackerScore + defenderScore || 1;
      const attackerPct = Math.round((attackerScore / total) * 100);

      const card = document.createElement('div');
      card.className = 'battle-card';
      card.innerHTML = `
        <div class="battle-card__sides">${attacker} <span class="battle-card__vs">vs</span> ${defender}</div>
        <div class="battle-card__meta">
          <span>${region || 'Region unknown'}</span>
          <span>${fmtNum(attackerScore)} — ${fmtNum(defenderScore)}</span>
        </div>
        <div class="battle-card__bar">
          <div class="battle-card__bar-fill" style="width:${attackerPct}%"></div>
        </div>
      `;
      grid.appendChild(card);
    }
    note.textContent = `${rows.length} battle${rows.length === 1 ? '' : 's'} · cached ~15s`;
  } catch (err) {
    grid.innerHTML = '';
    note.textContent = `Failed to load: ${err.message}`;
  }
}

// ---- Wire up -------------------------------------------------------------

function init() {
  initTabs();

  $('#marketRefresh').addEventListener('click', loadMarket);
  $('#marketFilter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadMarket();
  });
  $('#rankingsRefresh').addEventListener('click', loadRankings);
  $('#rankingType').addEventListener('change', loadRankings);
  $('#battlesRefresh').addEventListener('click', loadBattles);
  $('#battlesActiveOnly').addEventListener('change', loadBattles);

  loadMarket();
  loadRankings();
  loadBattles();
  refreshTicker();
  setInterval(refreshTicker, 20_000);
}

document.addEventListener('DOMContentLoaded', init);
