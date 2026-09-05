/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/** The row mapper and the session upsert, against a real database. */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { scratchDatabase } from './helpers.mjs';

let db;
let ingest;
let deviceFrom;
let query;

before(async () => {
  db = await scratchDatabase('ingest');
  ({ ingest, deviceFrom } = await import('../src/ingest.js'));
  ({ query } = await import('../src/db.js'));
  await query("INSERT INTO sites (slug, name) VALUES ('shop', 'Shop')");
});

after(async () => {
  await db?.drop();
});

const ts = () => new Date().toISOString();

function payload(events, overrides = {}) {
  return {
    site: 'shop',
    anonymousId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    sessionId: `sess-${Math.random().toString(36).slice(2)}`,
    events,
    ...overrides
  };
}

test('device class is derived from the user agent', () => {
  assert.equal(deviceFrom('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148 Safari'), 'mobile');
  assert.equal(deviceFrom('Mozilla/5.0 (iPad; CPU OS 17_0) Mobile/15E148'), 'tablet');
  assert.equal(deviceFrom('Mozilla/5.0 (Linux; Android 14) AppleWebKit Chrome/128 Mobile Safari'), 'mobile');
  // Android without a Mobile token is a tablet, which is the convention
  // vendors have actually kept to.
  assert.equal(deviceFrom('Mozilla/5.0 (Linux; Android 14) AppleWebKit Chrome/128 Safari'), 'tablet');
  assert.equal(deviceFrom('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/128'), 'desktop');
  assert.equal(deviceFrom(''), null);
  assert.equal(deviceFrom(undefined), null);
});

test('money is stored in minor units alongside its currency', async () => {
  const p = payload([
    {
      type: 'add_to_cart',
      product: { sku: 'SW-42', price: { centAmount: 12900, currencyCode: 'USD' } },
      quantity: 2,
      cartTotal: { centAmount: 25800, currencyCode: 'USD' },
      ts: ts()
    }
  ]);
  await ingest(p, { userAgent: 'test' });

  const row = await query(
    "SELECT unit_amount, cart_amount, currency, quantity FROM events WHERE type='add_to_cart' ORDER BY id DESC LIMIT 1"
  );
  assert.equal(row.rows[0].unit_amount, 12900, 'never a float');
  assert.equal(row.rows[0].cart_amount, 25800);
  assert.equal(row.rows[0].currency, 'USD');
  assert.equal(row.rows[0].quantity, 2);
});

test('attribution is flattened into queryable columns', async () => {
  await ingest(
    payload([
      {
        type: 'add_to_cart',
        product: { sku: 'A' },
        quantity: 1,
        attribution: {
          discoveryId: '11111111-2222-4333-8444-555555555555',
          discoveryType: 'search',
          query: 'merino',
          position: 3,
          facets: [{ name: 'color', value: 'blue' }]
        },
        ts: ts()
      }
    ]),
    { userAgent: 'test' }
  );

  const row = await query(
    `SELECT discovery_id, discovery_type, source_query, source_position, source_facets
       FROM events WHERE sku = 'A' ORDER BY id DESC LIMIT 1`
  );
  const r = row.rows[0];
  assert.equal(r.discovery_type, 'search');
  assert.equal(r.source_query, 'merino');
  assert.equal(r.source_position, 3);
  assert.deepEqual(r.source_facets, [{ name: 'color', value: 'blue' }]);
});

test('an event-level customer wins over the session context', async () => {
  // The login event names the customer even though context was set in the
  // same tick, which is what makes "who signed in" answerable.
  await ingest(
    payload([
      {
        type: 'login',
        customerId: 'c-event',
        customerRef: 'event@example.com',
        context: { customerId: 'c-context', customerRef: 'context@example.com' },
        ts: ts()
      }
    ]),
    { userAgent: 'test' }
  );
  const row = await query("SELECT customer_id FROM events WHERE type='login' ORDER BY id DESC LIMIT 1");
  assert.equal(row.rows[0].customer_id, 'c-event');
});

test('a later batch without a dimension does not erase it from the session', async () => {
  const sessionId = 'sess-persist';
  await ingest(
    payload([{ type: 'page_view', pageType: 'home', context: { store: 'us-store' }, ts: ts() }], { sessionId }),
    { userAgent: 'test' }
  );
  // A second batch carrying no store at all.
  await ingest(
    payload([{ type: 'page_view', pageType: 'cart', ts: ts() }], { sessionId }),
    { userAgent: 'test' }
  );

  const row = await query('SELECT store FROM sessions WHERE session_key = $1', [sessionId]);
  assert.equal(row.rows[0].store, 'us-store', 'the opening batch established it and it stuck');
});

test('a mid-session sign-in lands on the session row', async () => {
  const sessionId = 'sess-login';
  await ingest(
    payload([{ type: 'page_view', pageType: 'home', ts: ts() }], { sessionId }),
    { userAgent: 'test' }
  );
  await ingest(
    payload(
      [{ type: 'login', customerId: 'c1', customerRef: 'jen@example.com', ts: ts() }],
      { sessionId }
    ),
    { userAgent: 'test' }
  );
  const row = await query('SELECT customer_ref FROM sessions WHERE session_key = $1', [sessionId]);
  assert.equal(row.rows[0].customer_ref, 'jen@example.com');
});

test('order lines are split out so revenue can be attributed per product', async () => {
  await ingest(
    payload([
      {
        type: 'order_submit',
        orderNumber: 'A-77',
        total: { centAmount: 20000, currencyCode: 'USD' },
        items: [
          { product: { sku: 'X', price: { centAmount: 5000, currencyCode: 'USD' } }, quantity: 2 },
          { product: { sku: 'Y', price: { centAmount: 10000, currencyCode: 'USD' } }, quantity: 1 }
        ],
        ts: ts()
      }
    ]),
    { userAgent: 'test' }
  );

  const lines = await query(
    `SELECT oi.sku, oi.quantity, oi.unit_amount
       FROM order_items oi
       JOIN events e ON e.id = oi.event_id
      WHERE e.order_number = 'A-77'
      ORDER BY oi.sku`
  );
  assert.equal(lines.rows.length, 2);
  assert.deepEqual(lines.rows[0], { sku: 'X', quantity: 2, unit_amount: 5000 });
  assert.deepEqual(lines.rows[1], { sku: 'Y', quantity: 1, unit_amount: 10000 });
});

test('an order line with no product identifier is skipped, not stored blank', async () => {
  await ingest(
    payload([
      {
        type: 'order_submit',
        orderNumber: 'A-78',
        total: { centAmount: 100, currencyCode: 'USD' },
        items: [{ product: { name: 'Mystery' }, quantity: 1 }, { product: { sku: 'Z' }, quantity: 1 }],
        ts: ts()
      }
    ]),
    { userAgent: 'test' }
  );
  const lines = await query(
    `SELECT oi.sku FROM order_items oi JOIN events e ON e.id = oi.event_id WHERE e.order_number = 'A-78'`
  );
  assert.deepEqual(lines.rows.map((r) => r.sku), ['Z']);
});

test('batch order is preserved, so the funnel can be read in sequence', async () => {
  const sessionId = 'sess-order';
  await ingest(
    payload(
      [
        { type: 'search', query: 'a', resultCount: 1, ts: '2026-09-04T12:00:00.000Z' },
        { type: 'product_view', product: { sku: 'A' }, ts: '2026-09-04T12:00:00.000Z' },
        { type: 'add_to_cart', product: { sku: 'A' }, quantity: 1, ts: '2026-09-04T12:00:00.000Z' }
      ],
      { sessionId }
    ),
    { userAgent: 'test', now: Date.parse('2026-09-04T12:00:00.000Z') }
  );

  // Identical timestamps are routine on a listing page, so `seq` is what
  // keeps the order readable.
  const rows = await query(
    `SELECT type, seq FROM events
      WHERE session_id = (SELECT id FROM sessions WHERE session_key = $1)
      ORDER BY ts, seq`,
    [sessionId]
  );
  assert.deepEqual(rows.rows.map((r) => r.type), ['search', 'product_view', 'add_to_cart']);
  assert.deepEqual(rows.rows.map((r) => r.seq), [0, 1, 2]);
});

test('an unknown site is refused with 404 rather than accepted into nowhere', async () => {
  await assert.rejects(
    () => ingest(payload([{ type: 'logout', ts: ts() }], { site: 'nope' }), {}),
    (err) => err.status === 404 && /unknown site/.test(err.message)
  );
});

test('an inactive site is refused with 403', async () => {
  await query("INSERT INTO sites (slug, name, active) VALUES ('off', 'Off', false)");
  await assert.rejects(
    () => ingest(payload([{ type: 'logout', ts: ts() }], { site: 'off' }), {}),
    (err) => err.status === 403
  );
});

test('rejected events are recorded with their reason', async () => {
  const before2 = await query('SELECT COUNT(*)::int AS n FROM ingest_errors');
  const result = await ingest(
    payload([
      { type: 'search', resultCount: 1, ts: ts() },
      { type: 'page_view', pageType: 'home', ts: ts() }
    ]),
    { userAgent: 'test' }
  );
  assert.equal(result.accepted, 1);
  assert.equal(result.rejected.length, 1);

  const after2 = await query(
    'SELECT reason, event_type FROM ingest_errors ORDER BY id DESC LIMIT 1'
  );
  assert.match(after2.rows[0].reason, /query is required/);
  assert.equal(after2.rows[0].event_type, 'search');
  assert.ok(
    (await query('SELECT COUNT(*)::int AS n FROM ingest_errors')).rows[0].n > before2.rows[0].n
  );
});

test('a batch of only bad events records them and inserts nothing', async () => {
  const result = await ingest(payload([{ type: 'search', ts: ts() }]), { userAgent: 'test' });
  assert.equal(result.accepted, 0);
  assert.equal(result.rejected.length, 1);
});

test('a returning browser is one shopper across many sessions', async () => {
  const anonymousId = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  for (let i = 0; i < 3; i++) {
    await ingest(
      payload([{ type: 'page_view', pageType: 'home', ts: ts() }], {
        anonymousId,
        sessionId: `visit-${i}`
      }),
      { userAgent: 'test' }
    );
  }
  const shoppers = await query('SELECT COUNT(*)::int AS n FROM shoppers WHERE anonymous_id = $1', [anonymousId]);
  const sessions = await query(
    `SELECT COUNT(*)::int AS n FROM sessions
      WHERE shopper_id = (SELECT id FROM shoppers WHERE anonymous_id = $1)`,
    [anonymousId]
  );
  assert.equal(shoppers.rows[0].n, 1);
  assert.equal(sessions.rows[0].n, 3);
});

test('site-specific extras land in props and nowhere else', async () => {
  await ingest(
    payload([{ type: 'page_view', pageType: 'home', props: { businessUnit: 'bu-9' }, ts: ts() }]),
    { userAgent: 'test' }
  );
  const row = await query("SELECT props FROM events WHERE type='page_view' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(row.rows[0].props, { businessUnit: 'bu-9' });
});
