/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * The reports admin.
 *
 * Read-only. It has no route that writes anything, which is the cheapest way
 * to make sure a mistake here cannot corrupt the data it reports on.
 */

import { config } from './config.js';
import { esc, html, json, parseUrl, safeEqual, send } from './http.js';
import { gateSatisfied, isGateEnabled } from './gate.js';
import { filterOptions, reportByKey, REPORTS } from './reports.js';
import { rows } from './db.js';
import { parseFilters, toQuery } from './filters.js';
import {
  dataTable,
  filterBar,
  funnelChart,
  header,
  journeyMeta,
  layout,
  statTiles
} from './views.js';
import { EVENT_LABELS, EVENT_TYPES, FUNNEL_STEPS, PAGE_TYPES } from '../../../packages/shared/events.js';

/**
 * Gate the admin.
 *
 * A token in the `Authorization` header or a `token` query parameter — the
 * query parameter because this is often opened from a terminal or a chat
 * message. When no token is configured the admin refuses every request unless
 * `CLICKSTREAM_ADMIN_OPEN` is set, so a deploy that forgets the variable fails
 * loudly rather than serving every shopper's journey to the internet.
 *
 * This is a shared secret, not an identity system. Anything carrying real
 * traffic should sit behind the platform's own access layer as well.
 */
function authorize(req, res, params) {
  // A satisfied gate IS the authorization. The visitor supplied the shared
  // password and their email was logged; asking them for a bearer token as
  // well would mean two secrets to distribute and no more safety. The gate is
  // enforced ahead of this in server.js, so reaching here with it satisfied
  // means it was passed.
  if (isGateEnabled() && gateSatisfied(req)) return true;
  if (config.adminOpen) return true;
  if (!config.adminToken) {
    html(
      res,
      503,
      errorPage(
        'Admin is not configured',
        'Set <code>CLICKSTREAM_ADMIN_TOKEN</code> to a secret and pass it as <code>?token=…</code>, ' +
          'or set <code>CLICKSTREAM_ADMIN_OPEN=true</code> to run without a token on a trusted network.'
      )
    );
    return false;
  }
  const header0 = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const supplied = header0 || params.get('token') || '';
  if (safeEqual(supplied, config.adminToken)) return true;

  html(res, 401, errorPage('Not authorised', 'Append <code>?token=…</code> to the URL.'));
  return false;
}

function errorPage(title, detail) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)} · ct-analytics</title>
<style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
background:#fff;color:#1a1d21;margin:0;display:grid;place-items:center;min-height:100vh}
div{max-width:34rem;padding:24px}h1{font-size:18px;margin:0 0 8px}
code{background:#f7f8fa;padding:1px 4px;border-radius:3px;font-size:12px}
p{color:#61666e;margin:0}</style></head>
<body><div><h1>${esc(title)}</h1><p>${detail}</p></div></body></html>`;
}

/** @returns {Promise<boolean>} whether the request was handled. */
export async function handleAdmin(req, res) {
  const { pathname, params } = parseUrl(req);

  if (req.method !== 'GET') return false;
  if (
    !pathname.startsWith('/report') &&
    !['/', '/events', '/install', '/reports.json', '/api/session-events'].includes(pathname)
  ) {
    return false;
  }
  if (!authorize(req, res, params)) return true;

  const filters = parseFilters(params);
  // Attached to the filter object so `toQuery` puts it on every link it
  // builds, rather than being threaded through each call site by hand.
  const token = params.get('token');
  if (token) filters._token = token;

  if (pathname === '/') {
    send(res, 302, '', { Location: `/report/overview${toQuery(filters)}` });
    return true;
  }

  // A machine-readable catalog, so the reports can be driven from a script
  // without scraping the HTML.
  if (pathname === '/reports.json') {
    json(res, 200, {
      reports: REPORTS.filter((r) => !r.hidden).map((r) => ({
        key: r.key,
        title: r.title,
        blurb: r.blurb,
        group: r.group,
        kind: r.kind || 'table',
        columns: (r.columns || []).map((c) => ({ key: c.key, label: c.label, type: c.type }))
      }))
    });
    return true;
  }

  /**
   * Ordered events for named sessions, as JSON.
   *
   * Exists so tracking accuracy can be checked without exposing the database.
   * The traffic generator records which session keys it created; this hands
   * back exactly those events so the two can be compared field by field.
   *
   * Read-only, gated like every other admin route, and bounded — an unbounded
   * export endpoint on a service holding shopper behaviour is a data-leak
   * waiting for a wrong query string.
   */
  if (pathname === '/api/session-events') {
    const site = params.get('site');
    const keys = (params.get('sessions') || '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 200);

    if (!site || !keys.length) {
      json(res, 400, { error: 'site and sessions (comma-separated session keys) are required' });
      return true;
    }

    try {
      const found = await sessionEvents(site, keys);
      json(res, 200, { site, sessions: found });
    } catch (err) {
      console.error('[clickstream] session-events failed:', err.message);
      json(res, 500, { error: err.message });
    }
    return true;
  }

  if (pathname === '/events') {
    html(res, 200, taxonomyPage(filters));
    return true;
  }

  if (pathname === '/install') {
    html(res, 200, installPage(filters));
    return true;
  }

  const key = pathname.replace(/^\/report\/?/, '') || 'overview';
  const report = reportByKey(key);
  if (!report) {
    html(res, 404, errorPage('No such report', `<code>${esc(key)}</code> is not in the catalog.`));
    return true;
  }

  filters._active = report.key;

  try {
    const [options, result] = await Promise.all([
      filterOptions(),
      report.run(filters, { sessionId: params.get('session') })
    ]);

    let body = header(report, filters);
    // The journey report is one specific session, so the segment filter bar
    // would be misleading: it does not narrow what is shown.
    if (report.key !== 'journey') body += filterBar(filters, options);
    if (report.key === 'journey') body += journeyMeta(result.meta);

    if (report.kind === 'stats') body += statTiles(result);
    else if (report.kind === 'funnel') body += funnelChart(result);
    else body += dataTable(report, result, filters);

    html(res, 200, layout({ title: report.title, activeKey: report.key, filters, body }));
  } catch (err) {
    console.error(`[clickstream] report ${report.key} failed:`, err.message);
    html(
      res,
      500,
      layout({
        title: report.title,
        activeKey: report.key,
        filters,
        body:
          header(report, filters) +
          `<div class="empty"><b>This report failed to run.</b>
           <div class="note">${esc(err.message)}</div></div>`
      })
    );
  }
  return true;
}

/**
 * Every event for the named sessions, grouped by session key and in order.
 *
 * Returns the fields an accuracy check needs — the event type, the dimensions
 * that identify what it was about, and the attribution — and not the whole
 * row, so this cannot become a bulk export of everything by accident.
 */
async function sessionEvents(site, keys) {
  const found = await rows(
    `SELECT s.session_key,
            s.store, s.channel, s.locale, s.currency, s.device, s.customer_ref,
            e.type, e.ts, e.seq, e.page_type, e.path,
            e.query, e.result_count, e.category_path,
            e.facet_name, e.facet_value, e.sort, e.position,
            e.sku, e.product_key, e.product_id, e.quantity,
            e.unit_amount, e.cart_amount, e.order_amount, e.currency AS event_currency,
            e.order_number, e.customer_id, e.login_method, e.step,
            e.discovery_type, e.source_query, e.source_category_path, e.source_position
       FROM events e
       JOIN sessions s ON s.id = e.session_id
       JOIN sites si ON si.id = e.site_id
      WHERE si.slug = $1 AND s.session_key = ANY($2::text[])
      ORDER BY s.session_key, e.ts, e.seq, e.id`,
    [site, keys]
  );

  /** @type {Record<string, any>} */
  const bySession = {};
  for (const row of found) {
    const key = row.session_key;
    if (!bySession[key]) {
      bySession[key] = {
        sessionKey: key,
        store: row.store,
        channel: row.channel,
        locale: row.locale,
        currency: row.currency,
        device: row.device,
        customerRef: row.customer_ref,
        events: []
      };
    }
    const { session_key: _k, store: _s, channel: _c, locale: _l, currency: _cu,
      device: _d, customer_ref: _cr, ...event } = row;
    bySession[key].events.push(event);
  }
  // Keys with no rows are reported as absent rather than omitted, because
  // "the session never arrived" is the single most important finding.
  for (const key of keys) {
    if (!bySession[key]) bySession[key] = { sessionKey: key, missing: true, events: [] };
  }
  return Object.values(bySession);
}

/* ------------------------------------------------------------- reference pages */

function taxonomyPage(filters) {
  const funnelOf = (type) => {
    const step = FUNNEL_STEPS.find((s) => s.types.includes(type));
    return step ? step.label : '—';
  };

  const body = `<h1>Event taxonomy</h1>
<p class="blurb">The closed set of events a site can report. Anything else is refused at the door.</p>
<p class="segment">${esc(String(EVENT_TYPES.length))} event types · ${esc(String(PAGE_TYPES.length))} page types</p>
<div class="scroll"><table>
  <thead><tr><th>Event</th><th>Name</th><th>Funnel step</th></tr></thead>
  <tbody>${EVENT_TYPES.map(
    (t) => `<tr><td>${esc(EVENT_LABELS[t] || t)}</td><td><code>${esc(t)}</code></td>
      <td>${esc(funnelOf(t))}</td></tr>`
  ).join('')}</tbody>
</table></div>
<p class="note">Page views additionally carry a page type:
${PAGE_TYPES.map((p) => `<code>${esc(p)}</code>`).join(' ')}</p>
<p class="note">Why the set is closed: free-form event names plus an untyped property bag produce data
nobody can report on, because nothing guarantees that a search carries a query or that an
add-to-cart carries a price. Site-specific dimensions belong in <code>props</code>, which every
event accepts and no shipped report reads.</p>`;

  return layout({ title: 'Event taxonomy', activeKey: '', filters, body });
}

function installPage(filters) {
  const body = `<h1>Install</h1>
<p class="blurb">One script tag. Three levels of integration, and a site can mix them freely.</p>

<h2 style="font-size:15px;margin:20px 0 6px">1 · The script alone</h2>
<p class="note" style="margin-top:0">Reports page views, classifies each page from its URL, and picks up
single-page navigations. Nothing else about the site changes.</p>
<pre style="background:#f7f8fa;border:1px solid #e2e5ea;border-radius:6px;padding:12px;overflow-x:auto"><code>&lt;script src="https://YOUR-COLLECTOR/c.js?site=YOUR-SITE" defer&gt;&lt;/script&gt;</code></pre>

<h2 style="font-size:15px;margin:20px 0 6px">2 · Data attributes</h2>
<p class="note" style="margin-top:0">Reports clicks with no JavaScript at all. The instrumentation lives on
the markup, so it survives a frontend rewrite.</p>
<pre style="background:#f7f8fa;border:1px solid #e2e5ea;border-radius:6px;padding:12px;overflow-x:auto"><code>&lt;button data-clickstream="add_to_cart" data-sku="SW-42"
        data-quantity="1" data-price="1999" data-currency="USD"&gt;Add to cart&lt;/button&gt;

&lt;a href="/product/sw-42" data-clickstream="result_click"
   data-sku="SW-42" data-position="3"&gt;Merino Crew&lt;/a&gt;

&lt;button data-clickstream="facet_apply"
        data-facet-name="color" data-facet-value="blue"&gt;Blue&lt;/button&gt;</code></pre>

<h2 style="font-size:15px;margin:20px 0 6px">3 · The API</h2>
<p class="note" style="margin-top:0">For what a click cannot express — an order total known only after the
server responds, a sign-in, or a result count.</p>
<pre style="background:#f7f8fa;border:1px solid #e2e5ea;border-radius:6px;padding:12px;overflow-x:auto"><code>clickstream.search('merino', 12);
clickstream.login({ customerId: 'c-1', customerRef: 'shopper@example.com' });
clickstream.orderSubmit({
  orderNumber: 'A-1049',
  total: { centAmount: 12980, currencyCode: 'USD' },
  items: [{ product: { sku: 'SW-42', price: { centAmount: 6490, currencyCode: 'USD' } }, quantity: 2 }]
});</code></pre>

<p class="note">The result count is the one dimension worth wiring by hand even on a minimal install:
without it the <b>Zero-result searches</b> report — the most directly actionable list here — stays empty.</p>
<p class="note">Full instructions, including how to stand up the database, are in the repository's
<code>docs/</code> directory.</p>`;

  return layout({ title: 'Install', activeKey: '', filters, body });
}
