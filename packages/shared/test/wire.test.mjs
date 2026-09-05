/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Validation policy: lenient about unknown fields, strict about the ones
 * reports read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, validatePayload, MAX_BATCH, MAX_CLOCK_SKEW_MS } from '../wire.js';
import { EVENT_TYPES, FUNNEL_STEPS, PAGE_TYPES } from '../events.js';

const ts = '2026-09-04T12:00:00.000Z';
const now = Date.parse(ts);

test('a well-formed event of every shape is accepted', () => {
  const ok = [
    { type: 'page_view', pageType: 'home', ts },
    { type: 'search', query: 'merino', resultCount: 0, ts },
    { type: 'category_view', categoryPath: 'mens/shoes', ts },
    { type: 'facet_apply', facet: { name: 'color', value: 'blue' }, facets: [], ts },
    { type: 'facet_remove', facet: { name: 'color', value: 'blue' }, facets: [], ts },
    { type: 'sort_change', sort: 'price-asc', ts },
    { type: 'result_click', product: { sku: 'A' }, position: 1, ts },
    { type: 'product_view', product: { productId: 'p1' }, ts },
    { type: 'add_to_cart', product: { productKey: 'k' }, quantity: 1, ts },
    { type: 'remove_from_cart', product: { sku: 'A' }, quantity: 1, ts },
    { type: 'cart_view', ts },
    { type: 'checkout_start', ts },
    { type: 'checkout_step', step: 'shipping', ts },
    { type: 'order_submit', total: { centAmount: 1999, currencyCode: 'USD' }, ts },
    { type: 'login', customerId: 'c1', ts },
    { type: 'logout', ts }
  ];
  for (const e of ok) assert.equal(validateEvent(e), null, `${e.type} should be valid`);
  assert.equal(ok.length, EVENT_TYPES.length, 'every type in the taxonomy is covered here');
});

test('an unknown event type is refused by name', () => {
  assert.match(validateEvent({ type: 'add_to_basket', ts }), /unknown event type/);
  assert.match(validateEvent({ type: 'add_to_basket', ts }), /add_to_basket/);
});

test('a search with no query is refused', () => {
  assert.match(validateEvent({ type: 'search', resultCount: 3, ts }), /query is required/);
});

test('a zero-result search is valid — it is the point', () => {
  assert.equal(validateEvent({ type: 'search', query: 'xyzzy', resultCount: 0, ts }), null);
});

test('a search with no result count is valid, because a URL cannot know it', () => {
  assert.equal(validateEvent({ type: 'search', query: 'merino', ts }), null);
});

test('a product event needs at least one identifier', () => {
  assert.match(
    validateEvent({ type: 'product_view', product: { name: 'Jumper' }, ts }),
    /productId, productKey, sku/
  );
  // Any one of the three is enough; sites differ in what they know.
  for (const id of [{ sku: 'A' }, { productKey: 'k' }, { productId: 'p' }]) {
    assert.equal(validateEvent({ type: 'product_view', product: id, ts }), null);
  }
});

test('an order needs both an amount and a currency', () => {
  assert.match(validateEvent({ type: 'order_submit', total: { centAmount: 100 }, ts }), /currencyCode/);
  assert.match(validateEvent({ type: 'order_submit', total: { currencyCode: 'USD' }, ts }), /centAmount/);
  assert.match(validateEvent({ type: 'order_submit', ts }), /required/);
});

test('a zero-value order is valid — a fully discounted order is still an order', () => {
  assert.equal(
    validateEvent({ type: 'order_submit', total: { centAmount: 0, currencyCode: 'USD' }, ts }),
    null
  );
});

test('a missing or unparseable timestamp is refused', () => {
  assert.match(validateEvent({ type: 'logout' }), /ISO 8601/);
  assert.match(validateEvent({ type: 'logout', ts: 'yesterday' }), /ISO 8601/);
  assert.match(validateEvent({ type: 'logout', ts: 12345 }), /ISO 8601/);
});

test('an unknown page type is refused, and the message lists the valid ones', () => {
  const reason = validateEvent({ type: 'page_view', pageType: 'plp', ts });
  assert.match(reason, /pageType must be one of/);
  for (const p of PAGE_TYPES) assert.ok(reason.includes(p), `${p} is listed`);
});

test('unknown extra fields are accepted and preserved', () => {
  assert.equal(validateEvent({ type: 'logout', ts, businessUnit: 'bu-1' }), null);
});

test('one bad event does not cost the rest of the batch', () => {
  const r = validatePayload(
    {
      site: 'example',
      anonymousId: 'a',
      sessionId: 's',
      events: [
        { type: 'page_view', pageType: 'home', ts },
        { type: 'search', resultCount: 1, ts },
        { type: 'logout', ts }
      ]
    },
    { now }
  );
  assert.equal(r.site, 'example');
  assert.equal(r.valid.length, 2);
  assert.deepEqual(r.rejected, [{ index: 1, reason: 'query is required', type: 'search' }]);
});

test('a malformed envelope throws, naming the missing field', () => {
  const base = { site: 's', anonymousId: 'a', sessionId: 'ss', events: [] };
  assert.throws(() => validatePayload({ ...base, site: undefined }), /site is required/);
  assert.throws(() => validatePayload({ ...base, anonymousId: undefined }), /anonymousId is required/);
  assert.throws(() => validatePayload({ ...base, sessionId: undefined }), /sessionId is required/);
  assert.throws(() => validatePayload({ ...base, events: undefined }), /events must be an array/);
  assert.throws(() => validatePayload('nope'), /body must be a JSON object/);
  assert.throws(() => validatePayload(null), /body must be a JSON object/);
});

test('an oversized batch is refused rather than silently truncated', () => {
  const events = Array.from({ length: MAX_BATCH + 1 }, () => ({ type: 'logout', ts }));
  assert.throws(
    () => validatePayload({ site: 's', anonymousId: 'a', sessionId: 'x', events }),
    /MAX_BATCH/
  );
});

test('a wildly wrong client clock is clamped, not dropped', () => {
  // A phone with a wrong clock is common, and a 1979 timestamp disappears
  // from every date-ranged report. The event happened; only its clock lied.
  const r = validatePayload(
    {
      site: 's',
      anonymousId: 'a',
      sessionId: 'x',
      events: [
        { type: 'logout', ts: '1979-01-01T00:00:00.000Z' },
        { type: 'logout', ts: '2041-01-01T00:00:00.000Z' },
        { type: 'logout', ts }
      ]
    },
    { now }
  );
  assert.equal(r.valid.length, 3);
  assert.equal(r.valid[0].tsClamped, true, 'past clamped');
  assert.equal(r.valid[1].tsClamped, true, 'future clamped');
  assert.equal(r.valid[2].tsClamped, undefined, 'a sane clock is left alone');
  assert.equal(Date.parse(r.valid[0].ts), now);
});

test('a timestamp just inside the skew window is left alone', () => {
  const nearly = new Date(now - MAX_CLOCK_SKEW_MS + 60_000).toISOString();
  const r = validatePayload(
    { site: 's', anonymousId: 'a', sessionId: 'x', events: [{ type: 'logout', ts: nearly }] },
    { now }
  );
  assert.equal(r.valid[0].tsClamped, undefined);
  assert.equal(r.valid[0].ts, nearly);
});

test('overlong strings are capped rather than rejected', () => {
  const long = 'x'.repeat(5000);
  const r = validatePayload(
    { site: long, anonymousId: 'a', sessionId: 'x', events: [] },
    { now }
  );
  assert.equal(r.site.length, 512);
});

test('every funnel step names only real event types', () => {
  for (const step of FUNNEL_STEPS) {
    for (const type of step.types) {
      assert.ok(EVENT_TYPES.includes(type), `${type} in step ${step.key} is a real event type`);
    }
  }
});
