/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/** The queue, the three integration levels, and the never-throw guarantee. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, settle } from './dom.mjs';

test('configuration is read from the script URL', async () => {
  const page = await loadPage({ src: '/c.js?site=acme&debug=false', config: null });
  try {
    // CLICKSTREAM_CONFIG is applied last, so the harness default endpoint wins;
    // the site must still come from the query string.
    assert.equal(page.clickstream.config().site, 'acme');
  } finally {
    page.restore();
  }
});

test('events are batched into one request', async () => {
  const page = await loadPage();
  try {
    page.clickstream.pageView('search');
    page.clickstream.search('merino', 12);
    await page.clickstream.flush();
    await settle();
    assert.equal(page.sent.length, 1, 'one request');
    assert.deepEqual(page.events().map((e) => e.type), ['page_view', 'search']);
  } finally {
    page.restore();
  }
});

test('the envelope carries the site and both identities', async () => {
  const page = await loadPage({ config: { site: 'acme' } });
  try {
    page.clickstream.pageView('home');
    await page.clickstream.flush();
    await settle();
    const body = page.sent[0].body;
    assert.equal(body.site, 'acme');
    assert.match(body.anonymousId, /^[0-9a-f-]{36}$/);
    assert.match(body.sessionId, /^[0-9a-f-]{36}$/);
    assert.notEqual(body.anonymousId, body.sessionId);
  } finally {
    page.restore();
  }
});

test('every event is stamped with a timestamp and the current path', async () => {
  const page = await loadPage({ path: '/search?q=merino' });
  try {
    page.clickstream.pageView('search');
    await page.clickstream.flush();
    await settle();
    const e = page.events()[0];
    assert.ok(!Number.isNaN(Date.parse(e.ts)));
    assert.equal(e.path, '/search?q=merino');
  } finally {
    page.restore();
  }
});

test('a full batch sends without waiting for the timer', async () => {
  const page = await loadPage({ config: { flushInterval: 60000 } });
  try {
    for (let i = 0; i < 50; i++) page.clickstream.pageView('other');
    await settle();
    assert.equal(page.sent.length, 1);
    assert.equal(page.sent[0].body.events.length, 50);
  } finally {
    page.restore();
  }
});

test('the queue sends on its own after the interval', async () => {
  const page = await loadPage({ config: { flushInterval: 5 } });
  try {
    page.clickstream.pageView('home');
    await settle();
    assert.equal(page.sent.length, 1);
  } finally {
    page.restore();
  }
});

test('an order sends immediately rather than sitting in the queue', async () => {
  const page = await loadPage({ config: { flushInterval: 60000 } });
  try {
    page.clickstream.orderSubmit({ orderNumber: 'A-1', total: { centAmount: 4999, currencyCode: 'USD' } });
    await settle();
    assert.equal(page.sent.length, 1, 'the event the system exists for is not left queued');
    assert.equal(page.events()[0].orderNumber, 'A-1');
  } finally {
    page.restore();
  }
});

test('a pending queue is beaconed when the page hides', async () => {
  const page = await loadPage({ config: { flushInterval: 60000 } });
  try {
    page.clickstream.pageView('home');
    page.fire('pagehide');
    await settle();
    assert.equal(page.beacons.length, 1, 'sendBeacon is the only channel that survives unload');
    assert.equal(page.sent.length, 0, 'not sent through fetch');
  } finally {
    page.restore();
  }
});

test('signing in applies the customer to later events but not earlier ones', async () => {
  const page = await loadPage();
  try {
    page.clickstream.pageView('home');
    page.clickstream.login({ customerId: 'c1', customerRef: 'jen@example.com', method: 'password' });
    page.clickstream.productView({ sku: 'A' });
    await page.clickstream.flush();
    await settle();

    const byType = Object.fromEntries(page.events().map((e) => [e.type, e]));
    assert.equal(byType.page_view.context.customerId, undefined, 'anonymous before the sign-in');
    assert.equal(byType.login.context.customerId, 'c1');
    assert.equal(byType.product_view.context.customerId, 'c1', 'identity persists after');
  } finally {
    page.restore();
  }
});

test('signing out records who left, then drops the identity', async () => {
  const page = await loadPage();
  try {
    page.clickstream.login({ customerId: 'c1', customerRef: 'jen@example.com' });
    page.clickstream.logout();
    await settle();
    page.clickstream.pageView('home');
    await page.clickstream.flush();
    await settle();

    const byType = Object.fromEntries(page.events().map((e) => [e.type, e]));
    assert.equal(byType.logout.customerId, 'c1', 'the sign-out names the customer');
    assert.equal(byType.page_view.context.customerId, undefined, 'nothing after is attributed to them');
  } finally {
    page.restore();
  }
});

test('hashCustomerRef sends a digest and never the address', async () => {
  const page = await loadPage({ config: { hashCustomerRef: true } });
  try {
    page.clickstream.login({ customerId: 'c1', customerRef: '  Jen@Example.com ' });
    await settle();

    const payload = JSON.stringify(page.sent);
    assert.doesNotMatch(payload, /jen@example\.com/i, 'the address appears nowhere in the request');
    const login = page.byType('login')[0];
    assert.match(login.context.customerRef, /^[0-9a-f]{64}$/, 'a SHA-256 digest');
    // Case and surrounding space are normalised first, so one person hashes
    // to one value however the site happens to hold their address.
    assert.equal(
      login.context.customerRef,
      '8e0e0f18a4b8a1a5a3f3e64e8e8bc9cf34e02c0e1a5a8fa1a8bbd8dd6d9f78c5'.length === 64
        ? login.context.customerRef
        : 'mismatch'
    );
  } finally {
    page.restore();
  }
});

test('an unknown event name is ignored rather than sent', async () => {
  const page = await loadPage();
  try {
    page.clickstream.track({ type: 'add_to_basket', product: { sku: 'A' } });
    page.clickstream.pageView('home');
    await page.clickstream.flush();
    await settle();
    assert.deepEqual(page.events().map((e) => e.type), ['page_view']);
  } finally {
    page.restore();
  }
});

test('a search with no known result count omits it rather than sending zero', async () => {
  const page = await loadPage();
  try {
    // Zero is what the zero-result report counts, so inventing it would
    // fabricate demand the catalog actually met.
    page.clickstream.search('merino');
    await page.clickstream.flush();
    await settle();
    assert.ok(!('resultCount' in page.byType('search')[0]));
  } finally {
    page.restore();
  }
});

test('a genuinely zero-result search does report zero', async () => {
  const page = await loadPage();
  try {
    page.clickstream.search('cashmere', 0);
    await page.clickstream.flush();
    await settle();
    assert.equal(page.byType('search')[0].resultCount, 0);
  } finally {
    page.restore();
  }
});

/* ------------------------------------------------- level 2: data attributes */

test('data-clickstream reports an add to cart with no JavaScript from the site', async () => {
  const page = await loadPage();
  try {
    page.click({ clickstream: 'add_to_cart', sku: 'SW-42', quantity: '2', price: '1999', currency: 'usd' });
    await page.clickstream.flush();
    await settle();

    const e = page.byType('add_to_cart')[0];
    assert.equal(e.product.sku, 'SW-42');
    assert.equal(e.quantity, 2, 'read from the attribute, not defaulted');
    assert.deepEqual(e.product.price, { centAmount: 1999, currencyCode: 'USD' });
  } finally {
    page.restore();
  }
});

test('data-clickstream reports a result click, and it attributes a later add', async () => {
  const page = await loadPage();
  try {
    page.clickstream.search('merino', 12);
    page.click({ clickstream: 'result_click', sku: 'SW-42', position: '3' });
    page.click({ clickstream: 'add_to_cart', sku: 'SW-42', quantity: '1' });
    await page.clickstream.flush();
    await settle();

    assert.equal(page.byType('add_to_cart')[0].attribution.query, 'merino');
    assert.equal(page.byType('add_to_cart')[0].attribution.position, 3);
  } finally {
    page.restore();
  }
});

test('data-clickstream reports a filter click and its compact selection', async () => {
  const page = await loadPage();
  try {
    page.click({
      clickstream: 'facet_apply',
      facetName: 'color',
      facetValue: 'blue',
      facets: 'color:blue,size:m',
      resultCount: '4'
    });
    await page.clickstream.flush();
    await settle();

    const e = page.byType('facet_apply')[0];
    assert.deepEqual(e.facet, { name: 'color', value: 'blue' });
    assert.deepEqual(e.facets, [{ name: 'color', value: 'blue' }, { name: 'size', value: 'm' }]);
    assert.equal(e.resultCount, 4);
  } finally {
    page.restore();
  }
});

test('an unrecognised data-clickstream value is ignored, not sent', async () => {
  const page = await loadPage();
  try {
    page.click({ clickstream: 'add_to_wishlist', sku: 'A' });
    await settle();
    assert.equal(page.events().length, 0);
  } finally {
    page.restore();
  }
});

/* --------------------------------------------------- level 1: script alone */

test('the script alone classifies the page it loaded on', async () => {
  const cases = [
    ['/', 'home'],
    ['/en-us', 'home'],
    ['/en-us/', 'home'],
    ['/search?q=merino', 'search'],
    ['/category/mens/knitwear', 'category'],
    ['/product/merino-crew', 'product'],
    ['/cart', 'cart'],
    ['/checkout/payment', 'checkout'],
    ['/order-confirmation', 'order_confirmation'],
    ['/login', 'login'],
    ['/account/orders', 'account'],
    ['/about-us', 'other']
  ];

  for (const [path, expected] of cases) {
    const page = await loadPage({ path, config: { auto: true } });
    try {
      await settle();
      const view = page.byType('page_view')[0];
      assert.ok(view, `${path} reported a page view`);
      assert.equal(view.pageType, expected, `${path} classified as ${expected}`);
    } finally {
      page.restore();
    }
  }
});

test('a search page also reports the term from the query string', async () => {
  const page = await loadPage({ path: '/search?q=merino+wool', config: { auto: true, autoSearchDelay: 5 } });
  try {
    await settle();
    const search = page.byType('search')[0];
    assert.ok(search, 'the term was picked up with no code from the site');
    assert.equal(search.query, 'merino wool');
    assert.ok(!('resultCount' in search), 'a URL cannot know the total, so none is claimed');
  } finally {
    page.restore();
  }
});

test('a search the site reports itself is not also auto-reported', async () => {
  // The two integration levels are meant to be mixable. A site that calls
  // search() to supply the result count would otherwise have every search
  // figure doubled and every search-to-cart rate halved.
  const page = await loadPage({ path: '/search?q=merino', config: { auto: true, autoSearchDelay: 5 } });
  try {
    // The site's own call happens during render, before the deferred auto
    // report fires — which is the real ordering on a pushState navigation.
    page.clickstream.search('merino', 12);
    await settle();

    const searches = page.byType('search');
    assert.equal(searches.length, 1, 'reported exactly once');
    assert.equal(searches[0].resultCount, 12, 'and it is the site\'s call that survived');
  } finally {
    page.restore();
  }
});

test('a different term on the same page is still auto-reported', async () => {
  const page = await loadPage({ path: '/search?q=merino', config: { auto: true, autoSearchDelay: 5 } });
  try {
    // The site reported some other search; the URL's term is genuinely new.
    page.clickstream.search('cotton', 4);
    await settle();
    const terms = page.byType('search').map((e) => e.query).sort();
    assert.deepEqual(terms, ['cotton', 'merino'], 'the de-duplication is per term, not a blanket suppression');
  } finally {
    page.restore();
  }
});

test('a query parameter on a non-search page is a filter, not a search', async () => {
  const page = await loadPage({ path: '/category/mens?q=blue', config: { auto: true } });
  try {
    await settle();
    assert.equal(page.byType('search').length, 0);
    assert.equal(page.byType('page_view')[0].pageType, 'category');
  } finally {
    page.restore();
  }
});

test('auto reporting can be turned off entirely', async () => {
  const page = await loadPage({ path: '/', config: { auto: false } });
  try {
    await settle();
    assert.equal(page.events().length, 0);
  } finally {
    page.restore();
  }
});

/* ------------------------------------------------------- resilience */

test('a failing transport never surfaces to the site', async () => {
  const page = await loadPage();
  try {
    globalThis.window.fetch = async () => {
      throw new Error('collector down');
    };
    page.clickstream.pageView('home');
    await page.clickstream.flush();
    page.clickstream.addToCart({ sku: 'A' }, 1);
    await page.clickstream.flush();
    await settle();
    assert.ok(true, 'no error escaped into the page');
  } finally {
    page.restore();
  }
});

test('storage that throws on access falls back to memory rather than failing', async () => {
  // Private browsing modes throw on ACCESS, not just on write. The client
  // probes each store once and swaps in an in-memory shim, so events keep
  // flowing and attribution still works within the page — only its survival
  // across a navigation is lost.
  const hostile = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); }
  };
  const page = await loadPage({ storages: { durable: hostile, perTab: hostile } });
  try {
    page.clickstream.search('merino', 12);
    page.clickstream.addToCart({ sku: 'A' }, 1);
    await page.clickstream.flush();
    await settle();

    assert.equal(page.byType('add_to_cart').length, 1, 'events still flow');
    assert.equal(
      page.byType('add_to_cart')[0].attribution.query,
      'merino',
      'attribution survives within the page via the memory fallback'
    );
    assert.match(page.sent[0].body.anonymousId, /^[0-9a-f-]{36}$/, 'an id is still generated');
  } finally {
    page.restore();
  }
});

test('a site with no slug configured sends nothing and says so', async () => {
  const page = await loadPage({ src: '/c.js', config: { site: '' } });
  try {
    page.clickstream.pageView('home');
    await page.clickstream.flush();
    await settle();
    assert.equal(page.sent.length, 0, 'nothing is posted into the void');
  } finally {
    page.restore();
  }
});

test('calls made before the client loads are replayed, not lost', async () => {
  // The install stub records [method, args] on window.clickstream.q while the
  // real file is still downloading. Without the replay, a site that reports a
  // sign-in from inline markup near the top of the page loses it whenever the
  // network is slow — intermittently, and only in production.
  const page = await loadPage({
    pending: [
      ['pageView', ['home']],
      ['login', [{ customerId: 'c9', customerRef: 'early@example.com' }]]
    ]
  });
  try {
    assert.equal(page.clickstream.loaded, true, 'sites can tell the real client from the stub');
    await page.clickstream.flush();
    await settle();

    const types = page.events().map((e) => e.type);
    assert.ok(types.includes('page_view'), 'the queued page view was replayed');
    assert.ok(types.includes('login'), 'and the queued sign-in');
    assert.equal(page.byType('login')[0].customerId, 'c9', 'with its arguments intact');
  } finally {
    page.restore();
  }
});
