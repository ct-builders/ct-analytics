/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * End to end: the real browser client, over real HTTP, into real Postgres,
 * read back through the real reports.
 *
 * Nothing here is stubbed except the DOM. That matters most for attribution —
 * the link from a search to the product it sold is computed in the browser,
 * carried on the wire, stored in a column and joined in SQL, and a test that
 * skipped any of those four would not prove the chain works.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

// Set before the first import that reaches config.js, which reads the
// environment once at module load.
const ADMIN_TOKEN = 'test-token';
process.env.CLICKSTREAM_ADMIN_TOKEN = ADMIN_TOKEN;

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadClient, scratchDatabase, startServer, until, REPO_ROOT, INGEST_KEY } from './helpers.mjs';

let db;
let server;
let query;
let reports;
let filters;

before(async () => {
  db = await scratchDatabase('e2e');
  ({ query } = await import('../src/db.js'));
  reports = await import('../src/reports.js');
  filters = await import('../src/filters.js');
  await query("INSERT INTO sites (slug, name) VALUES ('shop', 'Test Shop')");
  server = await startServer();
});

after(async () => {
  await server?.close();
  await db?.drop();
});

/** Run a report over everything recorded, with no segment narrowing. */
function allTime(extra = '') {
  return filters.parseFilters(new URLSearchParams(`range=all&limit=100&${extra}`));
}

async function run(key, extra) {
  return reports.reportByKey(key).run(allTime(), extra);
}

/** Count rows of one event type. */
async function count(type) {
  const r = await query('SELECT COUNT(*)::int AS n FROM events WHERE type = $1', [type]);
  return r.rows[0].n;
}

test('the collector serves the browser client it is asked for', async () => {
  const res = await fetch(`${server.base}/c.js?site=shop`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);

  // Byte-identical to the file on disk. Asserting on some string inside it
  // just pins the test to an implementation detail that will be refactored.
  const served = await res.text();
  const onDisk = await readFile(join(REPO_ROOT, 'packages', 'browser', 'clickstream.js'), 'utf8');
  assert.equal(served, onDisk, 'the shipped file, not a placeholder or a stale copy');
});

test('a shopper journey is captured, attributed and reported', async () => {
  const page = await loadClient({
    src: `${server.base}/c.js?site=shop`,
    config: { endpoint: `${server.base}/api/clickstream`, flushInterval: 20, auto: false, autoClicks: false },
    path: '/'
  });

  try {
    const { clickstream } = page;
    assert.ok(clickstream && clickstream.loaded, 'client installed itself on window');

    clickstream.identify({ store: 'us-store', channel: 'web', locale: 'en-US', currency: 'USD' });

    // A shopper searches, filters, clicks the third result, and buys it.
    clickstream.pageView('home');
    page.navigate('/search?q=merino');
    clickstream.pageView('search');
    clickstream.search('merino', 12);
    clickstream.facetApply({ name: 'color', value: 'blue' }, [{ name: 'color', value: 'blue' }], 4);
    clickstream.resultClick({ sku: 'SW-42', name: 'Merino Crew', price: { centAmount: 12900, currencyCode: 'USD' } }, 3);

    page.navigate('/product/merino-crew');
    clickstream.pageView('product');
    clickstream.productView({ sku: 'SW-42', name: 'Merino Crew', price: { centAmount: 12900, currencyCode: 'USD' } });
    clickstream.addToCart(
      { sku: 'SW-42', name: 'Merino Crew', price: { centAmount: 12900, currencyCode: 'USD' } },
      1,
      { centAmount: 12900, currencyCode: 'USD' }
    );

    clickstream.login({ customerId: 'c-1', customerRef: 'jen@example.com', method: 'password' });
    clickstream.checkoutStart({ cartTotal: { centAmount: 12900, currencyCode: 'USD' }, itemCount: 1 });
    clickstream.orderSubmit({
      orderNumber: 'A-1001',
      total: { centAmount: 12900, currencyCode: 'USD' },
      itemCount: 1,
      items: [{ product: { sku: 'SW-42', name: 'Merino Crew', price: { centAmount: 12900, currencyCode: 'USD' } }, quantity: 1 }]
    });
    clickstream.logout();

    await clickstream.flush();
    // Every event arrives, including the ones sent on the login and order
    // paths that flush themselves.
    await until(async () => (await count('order_submit')) === 1 && (await count('logout')) === 1);

    /* ---- the whole taxonomy landed ---- */
    for (const type of [
      'page_view', 'search', 'facet_apply', 'result_click', 'product_view',
      'add_to_cart', 'login', 'checkout_start', 'order_submit', 'logout'
    ]) {
      assert.equal(await count(type), type === 'page_view' ? 3 : 1, `${type} recorded`);
    }

    /* ---- attribution survived the whole chain ---- */
    const atc = await query(
      `SELECT source_query, source_position, discovery_type, source_facets
         FROM events WHERE type = 'add_to_cart'`
    );
    assert.equal(atc.rows[0].source_query, 'merino', 'the add-to-cart knows which search sold it');
    assert.equal(atc.rows[0].source_position, 3, 'and at which rank');
    assert.equal(atc.rows[0].discovery_type, 'search');
    assert.deepEqual(atc.rows[0].source_facets, [{ name: 'color', value: 'blue' }], 'and under which filter');

    /* ---- identity was applied from the login onwards, and dropped after ---- */
    const session = await query('SELECT customer_ref, store, channel, device FROM sessions');
    assert.equal(session.rows[0].customer_ref, 'jen@example.com');
    assert.equal(session.rows[0].store, 'us-store');
    assert.equal(session.rows[0].channel, 'web');

    const home = await query(
      "SELECT customer_ref FROM events WHERE type = 'page_view' AND page_type = 'home'"
    );
    assert.equal(home.rows[0].customer_ref, null, 'browsing before the login stays anonymous');

    /* ---- order lines were split out for revenue attribution ---- */
    const lines = await query('SELECT sku, quantity, unit_amount FROM order_items');
    assert.equal(lines.rows.length, 1);
    assert.equal(lines.rows[0].sku, 'SW-42');
    assert.equal(lines.rows[0].unit_amount, 12900);

    /* ---- and the reports say so ---- */
    const searches = await run('searches');
    const merino = searches.rows.find((r) => r.query === 'merino');
    assert.ok(merino, 'the search appears');
    assert.equal(merino.add_to_carts, 1, 'attributed to a cart add');

    const s2p = await run('search-to-product');
    const pair = s2p.rows.find((r) => r.query === 'merino' && r.sku === 'SW-42');
    assert.ok(pair, 'search-to-product joined the query to the product');
    assert.equal(pair.best_position, 3);

    const revenue = await run('revenue-by-discovery');
    const attributed = revenue.rows.find((r) => r.discovery === 'merino');
    assert.ok(attributed, 'revenue attributed back to the search');
    assert.equal(attributed.revenue, 12900, 'the full order value');
    assert.equal(attributed.orders, 1);

    const funnel = await run('funnel');
    assert.equal(funnel.total, 1);
    assert.deepEqual(funnel.steps.map((s) => s.count), [1, 1, 1, 1, 1], 'one session reached every step');

    const overview = await run('overview');
    const stat = (label) => overview.stats.find((s) => s.label === label).value;
    assert.equal(stat('Sessions'), 1);
    assert.equal(stat('Orders'), 1);
    assert.equal(stat('Revenue'), 12900);
    assert.equal(stat('Conversion'), 100);

    const trail = await run('journey', { sessionId: session.rows[0].id ?? 1 });
    assert.ok(trail.rows.length >= 10, 'the session journey lists the whole visit in order');
  } finally {
    page.restore();
  }
});

test('a second visit from the same browser is the same shopper', async () => {
  const page = await loadClient({
    src: `${server.base}/c.js?site=shop`,
    config: { endpoint: `${server.base}/api/clickstream`, flushInterval: 20, auto: false, autoClicks: false }
  });

  let anonymousId;
  const pageViewsBefore = await count('page_view');
  try {
    anonymousId = page.clickstream.identity().anonymousId;
    page.clickstream.pageView('home');
    await page.clickstream.flush();
    await until(async () => (await count('page_view')) > pageViewsBefore);
  } finally {
    page.restore();
  }

  const shoppersBefore = await query('SELECT COUNT(*)::int AS n FROM shoppers');

  // Same durable browser id, a new session id: a returning shopper starting a
  // second visit, which must not create a second shopper row.
  const res = await fetch(`${server.base}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INGEST_KEY}` },
    body: JSON.stringify({
      site: 'shop',
      anonymousId,
      sessionId: '11111111-2222-4333-8444-555555555555',
      events: [{ type: 'page_view', pageType: 'home', ts: new Date().toISOString() }]
    })
  });
  assert.equal(res.status, 202);

  const shoppersAfter = await query('SELECT COUNT(*)::int AS n FROM shoppers');
  assert.equal(shoppersAfter.rows[0].n, shoppersBefore.rows[0].n, 'no new shopper row');

  const sessions = await query(
    `SELECT COUNT(*)::int AS n FROM sessions
      WHERE shopper_id = (SELECT id FROM shoppers WHERE anonymous_id = $1)`,
    [anonymousId]
  );
  assert.equal(sessions.rows[0].n, 2, 'but a second session');
});

test('a malformed event is refused and explained, without losing the batch', async () => {
  const res = await fetch(`${server.base}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INGEST_KEY}` },
    body: JSON.stringify({
      site: 'shop',
      anonymousId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      sessionId: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      events: [
        { type: 'search', resultCount: 3, ts: new Date().toISOString() },
        { type: 'page_view', pageType: 'home', ts: new Date().toISOString() }
      ]
    })
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.accepted, 1, 'the good event was kept');
  assert.equal(body.rejected.length, 1);
  assert.match(body.rejected[0].reason, /query is required/);

  // And it is visible in the diagnostics report rather than lost.
  const health = await run('install-health');
  assert.ok(health.rows.some((r) => /query is required/.test(r.reason)), 'shown in Install health');
});

test('an unknown site is refused rather than silently accepted', async () => {
  const res = await fetch(`${server.base}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INGEST_KEY}` },
    body: JSON.stringify({
      site: 'not-a-site',
      anonymousId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      sessionId: 'ffffffff-bbbb-4ccc-8ddd-000000000000',
      events: [{ type: 'page_view', pageType: 'home', ts: new Date().toISOString() }]
    })
  });
  assert.equal(res.status, 404, 'a typo in a script tag should be loud');
});

test('the admin refuses a request with no token and serves one with it', async () => {
  const denied = await fetch(`${server.base}/report/overview`, { redirect: 'manual' });
  assert.equal(denied.status, 401);

  const allowed = await fetch(`${server.base}/report/overview?token=${ADMIN_TOKEN}`);
  assert.equal(allowed.status, 200);
  const html = await allowed.text();
  assert.match(html, /Overview/);
  assert.match(html, /Conversion/);
});

test('navigating the admin does not log you out', async () => {
  // Every internal link is generated, and one that drops the token turns the
  // admin into a single page reachable only by editing the URL.
  const html = await (await fetch(`${server.base}/report/sessions?token=${ADMIN_TOKEN}&range=all`)).text();

  const hrefs = [...html.matchAll(/href="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((h) => h.startsWith('/'));
  assert.ok(hrefs.length > 5, 'the page has internal links to check');

  for (const href of hrefs) {
    assert.match(href, /[?&]token=/, `${href} carries the token`);
    const res = await fetch(`${server.base}${href.replace(/&amp;/g, '&')}`);
    assert.equal(res.status, 200, `${href} is reachable`);
  }

  // The filter form is a GET submit, so it needs the token as a field or
  // applying a filter signs you out.
  assert.match(html, /<input type="hidden" name="token"/, 'the filter form carries it too');
});

test('the session journey opens from the sessions list', async () => {
  const session = await query('SELECT id FROM sessions ORDER BY id LIMIT 1');
  const res = await fetch(
    `${server.base}/report/journey?session=${session.rows[0].id}&token=${ADMIN_TOKEN}`
  );
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Session journey/);
  assert.doesNotMatch(html, /No such session/);
  assert.doesNotMatch(html, /This report failed to run/);
});

test('every report in the catalog renders over real data', async () => {
  const catalog = await (await fetch(`${server.base}/reports.json?token=${ADMIN_TOKEN}`)).json();
  assert.ok(catalog.reports.length >= 14, 'the catalog is published');

  for (const r of catalog.reports) {
    const res = await fetch(`${server.base}/report/${r.key}?token=${ADMIN_TOKEN}&range=all`);
    assert.equal(res.status, 200, `${r.key} rendered`);
    const html = await res.text();
    assert.doesNotMatch(html, /This report failed to run/, `${r.key} did not error`);
  }
});

test('report values are escaped, not injected', async () => {
  // A query term that would break out of the HTML if it were interpolated raw.
  const nasty = '<img src=x onerror=alert(1)>';
  await fetch(`${server.base}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INGEST_KEY}` },
    body: JSON.stringify({
      site: 'shop',
      anonymousId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      sessionId: 'ffffffff-cccc-4ccc-8ddd-111111111111',
      events: [{ type: 'search', query: nasty, resultCount: 0, ts: new Date().toISOString() }]
    })
  });

  const html = await (await fetch(`${server.base}/report/searches?token=${ADMIN_TOKEN}&range=all`)).text();
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'escaped');
  assert.ok(!html.includes('<img src=x'), 'not injected');
});

/**
 * Post one order straight at the collector.
 *
 * The browser client is driven end to end above; what matters here is the
 * shape of the basket, and building three of them through the fake DOM would
 * bury that under setup.
 */
async function postOrder(sessionId, orderNumber, items) {
  const total = items.reduce((n, i) => n + i.price * i.quantity, 0);
  const res = await fetch(`${server.base}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INGEST_KEY}` },
    body: JSON.stringify({
      site: 'shop',
      anonymousId: 'basket00-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      sessionId,
      events: [
        {
          type: 'order_submit',
          orderNumber,
          total: { centAmount: total, currencyCode: 'USD' },
          itemCount: items.length,
          items: items.map((i) => ({
            product: { sku: i.sku, name: i.sku, price: { centAmount: i.price, currencyCode: 'USD' } },
            quantity: i.quantity
          })),
          ts: new Date().toISOString()
        }
      ]
    })
  });
  assert.equal(res.status, 202, await res.text());
}

test('products bought in the same order are paired, in both directions', async () => {
  const before = await count('order_submit');

  // Three baskets. The cable sells with both laptops; the sleeve with one.
  await postOrder('bbbbbbbb-0001-4ccc-8ddd-eeeeeeeeeeee', 'B-1', [
    { sku: 'LAPTOP', quantity: 1, price: 120000 },
    { sku: 'CABLE', quantity: 2, price: 1500 }
  ]);
  await postOrder('bbbbbbbb-0002-4ccc-8ddd-eeeeeeeeeeee', 'B-2', [
    { sku: 'LAPTOP', quantity: 1, price: 120000 },
    { sku: 'CABLE', quantity: 1, price: 1500 },
    { sku: 'SLEEVE', quantity: 1, price: 4000 }
  ]);
  await postOrder('bbbbbbbb-0003-4ccc-8ddd-eeeeeeeeeeee', 'B-3', [
    { sku: 'CABLE', quantity: 1, price: 1500 }
  ]);
  await until(async () => (await count('order_submit')) === before + 3);

  const result = await run('bought-together');
  const pair = (x, y) =>
    result.rows.find(
      (r) => (r.sku_a === x && r.sku_b === y) || (r.sku_a === y && r.sku_b === x)
    );

  const laptopCable = pair('LAPTOP', 'CABLE');
  assert.ok(laptopCable, 'the laptop and the cable are paired');
  assert.equal(Number(laptopCable.pair_orders), 2, 'in the two orders holding both');

  // Read from the laptop the cable attaches to everything; read from the
  // cable the laptop does not. A single attach rate could not say that.
  const fromLaptop = laptopCable.sku_a === 'LAPTOP' ? laptopCable.a_rate : laptopCable.b_rate;
  const fromCable = laptopCable.sku_a === 'LAPTOP' ? laptopCable.b_rate : laptopCable.a_rate;
  assert.equal(Math.round(Number(fromLaptop)), 100, 'every laptop order carried a cable');
  assert.equal(Math.round(Number(fromCable)), 67, 'two of the three cable orders carried a laptop');

  // The pair's own lines in the shared orders, not those orders' totals:
  // two laptops and three cables.
  assert.equal(Number(laptopCable.revenue), 2 * 120000 + 3 * 1500);

  // Lift against chance. Of the four order baskets recorded, the laptop is in
  // two and the cable in three, so chance alone would pair them in 2/4 × 3/4.
  const baskets = before + 3;
  assert.equal(
    Number(laptopCable.lift).toFixed(4),
    ((2 * baskets) / (2 * 3)).toFixed(4)
  );

  assert.ok(!result.rows.some((r) => r.sku_a === r.sku_b), 'nothing pairs with itself');
  assert.ok(pair('LAPTOP', 'SLEEVE'), 'a pair seen once is still listed');
  assert.equal(pair('CABLE', 'LAPTOP'), laptopCable, 'and each pair appears exactly once');
});

test('every table in the admin sorts by its headers', async () => {
  // The headers become buttons in the browser, so what the server has to get
  // right is the script and the raw values the sort reads back — formatted
  // money, percentages and dates do not compare as themselves.
  for (const key of ['products', 'bought-together', 'funnel', 'orders']) {
    const html = await (
      await fetch(`${server.base}/report/${key}?token=${ADMIN_TOKEN}&range=all`)
    ).text();
    assert.match(html, /aria-sort/, `${key} ships the sorting script`);
    assert.match(html, /data-sort="/, `${key} carries raw values to sort on`);
  }

  const orders = await (
    await fetch(`${server.base}/report/orders?token=${ADMIN_TOKEN}&range=all`)
  ).text();
  // Order B-1: one laptop and two cables, $1,230.00 on the page.
  assert.match(orders, /data-sort="123000"/, 'a money cell sorts on its minor units');
  assert.ok(orders.includes('$1,230.00'), 'and still reads as money');
});

test('the sorting script is the only script the policy will run', async () => {
  // The admin's policy is default-src 'none'. The sorting script is allowed
  // by the hash of its own source, so an edit to the script that did not
  // reach the header would leave every table unsortable in a real browser —
  // which no assertion on the markup would catch.
  const res = await fetch(`${server.base}/report/products?token=${ADMIN_TOKEN}&range=all`);
  const csp = res.headers.get('content-security-policy');
  const inline = /<script>([\s\S]*?)<\/script>/.exec(await res.text());

  assert.ok(inline, 'the page carries an inline script');
  const digest = createHash('sha256').update(inline[1], 'utf8').digest('base64');
  assert.ok(csp.includes(`'sha256-${digest}'`), 'and the policy names that exact script');

  assert.match(csp, /default-src 'none'/, 'everything else is still refused');
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, 'no blanket inline execution');
});
