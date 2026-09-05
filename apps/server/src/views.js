/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * The admin's HTML.
 *
 * Server-rendered strings, no client framework and no build step — the same
 * reason the browser client is one plain file. The stylesheet and the sorting
 * script are inlined because together they are the whole of the admin's
 * assets, and fetching them separately would be the only two requests the
 * page makes beyond itself.
 *
 * Everything interpolated goes through `esc`. Report values originate in a
 * browser payload, which makes every cell untrusted input.
 */

import { esc } from './http.js';
import { REPORTS } from './reports.js';
import { RANGES, DEVICES, IDENTITY, toQuery, describe } from './filters.js';
import { SORT_SCRIPT } from './sort-script.js';

/* ---------------------------------------------------------------- formatting */

/** Minor units to a readable amount. Currency-aware, never a float sum. */
export function formatMoney(minorUnits, currency, fractionDigits = 2) {
  if (minorUnits === null || minorUnits === undefined) return '—';
  const divisor = Math.pow(10, fractionDigits);
  const value = Number(minorUnits) / divisor;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits
    }).format(value);
  } catch {
    // An unknown currency code from a payload must not take the page down.
    return `${value.toFixed(fractionDigits)} ${currency || ''}`.trim();
  }
}

export function formatNumber(v) {
  if (v === null || v === undefined) return '—';
  return new Intl.NumberFormat('en-US').format(Number(v));
}

export function formatPercent(v) {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  // One decimal below 10% so a 0.4% conversion rate is not shown as 0%.
  return `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;
}

export function formatDate(v) {
  if (!v) return '—';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function formatDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Render one cell by its declared column type. */
function cell(value, column, ctx) {
  switch (column.type) {
    case 'money':
      return esc(formatMoney(value, ctx.currency, ctx.fractionDigits));
    case 'number':
      if (column.key === 'duration_s') return esc(formatDuration(value));
      return esc(formatNumber(value));
    case 'percent':
      return esc(formatPercent(value));
    case 'date':
      return esc(formatDate(value));
    case 'code':
      return value ? `<code>${esc(value)}</code>` : '—';
    case 'journey-link':
      return value
        ? `<a class="pill" href="/report/journey?session=${esc(value)}${ctx.queryTail}">Open journey</a>`
        : '—';
    default: {
      const s = value === null || value === undefined || value === '' ? '—' : String(value);
      // Long paths and queries would otherwise stretch a column past the
      // viewport and push the numbers off screen.
      return s.length > 120 ? `<span title="${esc(s)}">${esc(s.slice(0, 118))}…</span>` : esc(s);
    }
  }
}

/**
 * What a cell sorts by, when its rendered text would not sort as itself.
 *
 * `$1,234.56`, `2m 4s` and `2026-09-01 10:14:02Z` all read well and compare
 * badly, so the raw value travels with the cell as `data-sort` and the
 * client-side sort prefers it over the text.
 */
function sortValue(value, column) {
  if (value === null || value === undefined || value === '') return null;
  switch (column.type) {
    case 'money':
    case 'number':
    case 'percent': {
      const n = Number(value);
      return Number.isFinite(n) ? String(n) : null;
    }
    case 'date': {
      const d = value instanceof Date ? value : new Date(value);
      return Number.isNaN(d.getTime()) ? null : String(d.getTime());
    }
    default:
      return null;
  }
}

/* -------------------------------------------------------------------- layout */

const CSS = `
:root {
  --bg: #ffffff;
  --panel: #f7f8fa;
  --border: #e2e5ea;
  --text: #1a1d21;
  --muted: #61666e;
  --accent: #0b6bcb;
  --accent-soft: #e8f1fb;
  --good: #1a7f4b;
  --warn: #a15c00;
  --bad: #b3261e;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--panel); padding: 1px 4px; border-radius: 3px; }
.wrap { display: flex; min-height: 100vh; align-items: stretch; }
nav {
  width: 216px; flex: 0 0 216px; border-right: 1px solid var(--border);
  background: var(--panel); padding: 16px 0;
}
nav .brand { font-weight: 700; font-size: 15px; padding: 0 16px 12px; letter-spacing: -0.01em; }
nav .brand span { color: var(--muted); font-weight: 400; font-size: 12px; display: block; }
nav .group { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); padding: 14px 16px 4px; }
nav a { display: block; padding: 5px 16px; color: var(--text); }
nav a.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; box-shadow: inset 2px 0 0 var(--accent); }
main { flex: 1 1 auto; min-width: 0; padding: 20px 24px 48px; }
h1 { font-size: 20px; margin: 0 0 2px; letter-spacing: -0.01em; }
.blurb { color: var(--muted); margin: 0 0 4px; }
.segment { color: var(--muted); font-size: 12px; margin: 0 0 14px; }
.segment b { color: var(--text); font-weight: 600; }
form.filters {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end;
  background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
  padding: 10px 12px; margin-bottom: 16px;
}
form.filters label { font-size: 11px; color: var(--muted); display: block; margin-bottom: 2px; }
form.filters select, form.filters input {
  font: inherit; padding: 4px 6px; border: 1px solid var(--border);
  border-radius: 4px; background: #fff; color: var(--text); min-width: 110px;
}
form.filters button {
  font: inherit; font-weight: 600; padding: 5px 12px; border: 1px solid var(--accent);
  background: var(--accent); color: #fff; border-radius: 4px; cursor: pointer;
}
form.filters a.reset { font-size: 12px; color: var(--muted); padding-bottom: 6px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
.tile { border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; }
.tile .k { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.tile .v { font-size: 22px; font-weight: 650; letter-spacing: -0.02em; margin-top: 2px; }
.tile .h { font-size: 11px; color: var(--muted); margin-top: 2px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); background: var(--panel); position: sticky; top: 0; }
td.num, th.num { text-align: right; }
tbody tr:hover { background: var(--accent-soft); }
th.sortable { padding: 0; }
th.sortable > button {
  font: inherit; color: inherit; letter-spacing: inherit; text-transform: inherit;
  background: none; border: 0; margin: 0; width: 100%; padding: 6px 10px;
  display: flex; align-items: center; gap: 5px; cursor: pointer;
}
th.sortable.num > button { flex-direction: row-reverse; }
th.sortable > button::after { content: "↕"; font-size: 10px; opacity: 0.4; }
th.sortable > button:hover { color: var(--text); }
th.sortable > button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
th[aria-sort="ascending"], th[aria-sort="descending"] { color: var(--accent); }
th[aria-sort="ascending"] > button::after { content: "↑"; opacity: 1; }
th[aria-sort="descending"] > button::after { content: "↓"; opacity: 1; }
.pill { display: inline-block; font-size: 11px; padding: 1px 8px; border: 1px solid var(--border); border-radius: 999px; background: #fff; }
.empty { color: var(--muted); border: 1px dashed var(--border); border-radius: 6px; padding: 24px; text-align: center; }
.empty b { color: var(--text); }
.note { font-size: 12px; color: var(--muted); margin: 8px 0 0; }
.bar { background: var(--accent-soft); height: 22px; border-radius: 3px; position: relative; min-width: 2px; }
.bar > span { position: absolute; inset: 0; display: flex; align-items: center; padding-left: 8px; font-size: 12px; font-weight: 600; }
.bar-fill { background: var(--accent); height: 100%; border-radius: 3px; }
.drop { color: var(--bad); font-size: 12px; }
.meta { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px 16px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 16px; }
.meta div span { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.scroll { overflow-x: auto; }
`;

/**
 * The page shell.
 *
 * Reports are grouped in the order the catalog declares them, so the
 * navigation follows the funnel rather than the alphabet.
 */
export function layout({ title, activeKey, filters, body }) {
  const groups = [];
  for (const r of REPORTS) {
    if (r.hidden) continue;
    let g = groups.find((x) => x.name === r.group);
    if (!g) groups.push((g = { name: r.group, items: [] }));
    g.items.push(r);
  }

  const tail = toQuery(filters);
  const nav = groups
    .map(
      (g) => `<div class="group">${esc(g.name)}</div>` +
        g.items
          .map(
            (r) =>
              `<a href="/report/${esc(r.key)}${tail}"${r.key === activeKey ? ' class="active"' : ''}>${esc(r.title)}</a>`
          )
          .join('')
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Commerce Clickstream</title>
<style>${CSS}</style>
</head><body><div class="wrap">
<nav>
  <div class="brand">Clickstream<span>shopper analytics</span></div>
  ${nav}
  <div class="group">Reference</div>
  <a href="/events${tail}">Event taxonomy</a>
  <a href="/install${tail}">Install</a>
</nav>
<main>${body}</main>
</div>
<script>${SORT_SCRIPT}</script>
</body></html>`;
}

/** The segment filter bar. Present on every report, so it is built once. */
export function filterBar(filters, options) {
  const opt = (value, label, current) =>
    `<option value="${esc(value)}"${String(current) === String(value) ? ' selected' : ''}>${esc(label)}</option>`;

  return `<form class="filters" method="get">
  <div><label for="f-site">Site</label>
    <select id="f-site" name="site">
      ${opt('', 'All sites', filters.site)}
      ${options.sites.map((s) => opt(s.slug, s.name, filters.site)).join('')}
    </select></div>
  <div><label for="f-range">Range</label>
    <select id="f-range" name="range">
      ${Object.entries(RANGES).map(([k, v]) => opt(k, v.label, filters.range)).join('')}
    </select></div>
  <div><label for="f-from">From</label>
    <input id="f-from" type="date" name="from" value="${esc(filters.from)}"></div>
  <div><label for="f-to">To</label>
    <input id="f-to" type="date" name="to" value="${esc(filters.to)}"></div>
  <div><label for="f-device">Device</label>
    <select id="f-device" name="device">
      ${opt('', 'Any device', filters.device)}
      ${DEVICES.map((d) => opt(d, d, filters.device)).join('')}
    </select></div>
  <div><label for="f-identity">Shoppers</label>
    <select id="f-identity" name="identity">
      ${Object.entries(IDENTITY).map(([k, v]) => opt(k, v, filters.identity)).join('')}
    </select></div>
  ${options.stores.length ? `<div><label for="f-store">Store</label>
    <select id="f-store" name="store">
      ${opt('', 'Any store', filters.store)}
      ${options.stores.map((s) => opt(s, s, filters.store)).join('')}
    </select></div>` : ''}
  ${options.channels.length ? `<div><label for="f-channel">Channel</label>
    <select id="f-channel" name="channel">
      ${opt('', 'Any channel', filters.channel)}
      ${options.channels.map((c) => opt(c, c, filters.channel)).join('')}
    </select></div>` : ''}
  <div><label for="f-limit">Rows</label>
    <select id="f-limit" name="limit">
      ${[25, 50, 100, 250, 500].map((n) => opt(n, n, filters.limit)).join('')}
    </select></div>
  ${filters._token ? `<input type="hidden" name="token" value="${esc(filters._token)}">` : ''}
  <button type="submit">Apply</button>
  <a class="reset" href="/report/${esc(filters._active || 'overview')}${
    filters._token ? `?token=${encodeURIComponent(filters._token)}` : ''
  }">Reset</a>
</form>`;
}

export function header(report, filters) {
  return `<h1>${esc(report.title)}</h1>
<p class="blurb">${esc(report.blurb)}</p>
<p class="segment">Showing <b>${esc(describe(filters))}</b>${filters.site ? '' : ' · all sites'}</p>`;
}

/* ------------------------------------------------------------------- widgets */

export function statTiles(result) {
  return `<div class="tiles">${result.stats
    .map((s) => {
      const v =
        s.type === 'money'
          ? formatMoney(s.value, s.currency || result.currency)
          : s.type === 'percent'
            ? formatPercent(s.value)
            : formatNumber(s.value);
      return `<div class="tile"><div class="k">${esc(s.label)}</div>
        <div class="v">${esc(v)}</div>
        ${s.hint ? `<div class="h">${esc(s.hint)}</div>` : ''}</div>`;
    })
    .join('')}</div>`;
}

/**
 * The funnel, as proportional bars.
 *
 * Both percentages are shown on purpose. Share of all sessions makes the rows
 * comparable; share of the previous step is where the drop-off actually is,
 * and reading only the first hides a step that loses half its traffic late in
 * the funnel.
 */
export function funnelChart(result) {
  if (!result.total) return emptyState('No sessions in this segment.');
  return `<table>
  <thead><tr><th>Step</th><th class="num">Sessions</th><th class="num">Of all</th>
    <th class="num">Of previous</th><th style="width:38%">Reach</th></tr></thead>
  <tbody>${result.steps
    .map(
      (s) => `<tr>
      <td><b>${esc(s.label)}</b></td>
      <td class="num" data-sort="${esc(String(s.count))}">${esc(formatNumber(s.count))}</td>
      <td class="num" data-sort="${esc(String(s.ofTotal))}">${esc(formatPercent(s.ofTotal))}</td>
      <td class="num" data-sort="${esc(String(s.ofPrevious))}">${esc(formatPercent(s.ofPrevious))}${
        s.dropped ? ` <span class="drop">−${esc(formatNumber(s.dropped))}</span>` : ''
      }</td>
      <td data-sort="${esc(String(s.ofTotal))}"><div class="bar"><div class="bar-fill" style="width:${Math.max(s.ofTotal, 0.5).toFixed(2)}%"></div>
        <span>${esc(formatNumber(s.count))}</span></div></td>
    </tr>`
    )
    .join('')}</tbody></table>
  <p class="note">Base: ${esc(formatNumber(result.total))} sessions. A session counts for a step if it
  produced any of that step's events, so a shopper who browsed a category rather than searching
  still counts as having discovered something.</p>`;
}

const NUMERIC = new Set(['number', 'money', 'percent']);

export function dataTable(report, result, filters) {
  if (!result.rows || !result.rows.length) {
    return emptyState(
      'Nothing recorded for this segment yet.',
      'Widen the date range, or check <b>Install health</b> for events the collector refused.'
    );
  }
  const ctx = { currency: result.currency, queryTail: toQuery(filters), fractionDigits: 2 };
  return `<div class="scroll"><table>
  <thead><tr>${report.columns
    .map((c) => `<th${NUMERIC.has(c.type) ? ' class="num"' : ''}>${esc(c.label)}</th>`)
    .join('')}</tr></thead>
  <tbody>${result.rows
    .map(
      (row) =>
        `<tr>${report.columns
          .map((c) => {
            const sort = sortValue(row[c.key], c);
            return `<td${NUMERIC.has(c.type) ? ' class="num"' : ''}${
              sort === null ? '' : ` data-sort="${esc(sort)}"`
            }>${cell(row[c.key], c, ctx)}</td>`;
          })
          .join('')}</tr>`
    )
    .join('')}</tbody></table></div>
  ${result.note ? `<p class="note">${esc(result.note)}</p>` : ''}
  ${
    result.rows.length >= filters.limit
      ? `<p class="note">Showing the first ${esc(formatNumber(filters.limit))} rows in the report's own order —
         raise <b>Rows</b> to see more. Sorting by a column reorders these rows, not the rows beyond them.</p>`
      : ''
  }`;
}

export function emptyState(message, hint) {
  return `<div class="empty"><b>${esc(message)}</b>${hint ? `<div class="note">${hint}</div>` : ''}</div>`;
}

/** The session-detail header, above the ordered event trail. */
export function journeyMeta(meta) {
  if (!meta) return emptyState('No such session.');
  const field = (label, value) =>
    `<div><span>${esc(label)}</span>${esc(value ?? '—')}</div>`;
  return `<div class="meta">
    ${field('Site', meta.site)}
    ${field('Shopper', meta.customer_ref || 'anonymous')}
    ${field('Started', formatDate(meta.started_at))}
    ${field('Last event', formatDate(meta.last_event_at))}
    ${field('Device', meta.device)}
    ${field('Store', meta.store)}
    ${field('Channel', meta.channel)}
    ${field('Locale', meta.locale)}
    ${field('Landed on', meta.landing_path)}
    ${field('Referrer', meta.referrer)}
    ${field('Browser id', meta.anonymous_id)}
  </div>`;
}
