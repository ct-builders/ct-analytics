/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Discovery attribution — the part of this system that cannot be recovered
 * after the fact, and therefore the part most worth testing hard.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, settle } from './dom.mjs';

/** Attribution attached to the first event of a type. */
function attr(page, type) {
  const e = page.byType(type)[0];
  return e && e.attribution;
}

test('a search carries its own discovery id, so later events can join to it', async () => {
  const page = await loadPage();
  try {
    page.clickstream.search('merino', 12);
    await page.clickstream.flush();
    await settle();
    const a = attr(page, 'search');
    assert.equal(a.discoveryType, 'search');
    assert.equal(a.query, 'merino');
    assert.match(a.discoveryId, /^[0-9a-f-]{36}$/);
  } finally {
    page.restore();
  }
});

test('a product added after a search knows which search sold it', async () => {
  const page = await loadPage();
  try {
    page.clickstream.search('merino', 12);
    page.clickstream.resultClick({ sku: 'SW-42' }, 3);
    page.clickstream.addToCart({ sku: 'SW-42' }, 1);
    await page.clickstream.flush();
    await settle();

    const a = attr(page, 'add_to_cart');
    assert.equal(a.query, 'merino');
    assert.equal(a.position, 3, 'the rank it was clicked at survives to the cart');
    assert.equal(a.discoveryId, attr(page, 'search').discoveryId, 'same discovery');
  } finally {
    page.restore();
  }
});

test('filters narrow the listing without starting a new discovery', async () => {
  const page = await loadPage();
  try {
    page.clickstream.search('merino', 12);
    page.clickstream.facetApply({ name: 'color', value: 'blue' }, [{ name: 'color', value: 'blue' }], 4);
    page.clickstream.resultClick({ sku: 'SW-42' }, 1);
    await page.clickstream.flush();
    await settle();

    assert.equal(attr(page, 'facet_apply').discoveryId, attr(page, 'search').discoveryId);
    assert.deepEqual(attr(page, 'result_click').facets, [{ name: 'color', value: 'blue' }]);
  } finally {
    page.restore();
  }
});

test('a later filter click does not rewrite an earlier product attribution', async () => {
  const page = await loadPage();
  try {
    page.clickstream.search('merino', 12);
    page.clickstream.resultClick({ sku: 'SW-42' }, 1);
    page.clickstream.facetApply({ name: 'color', value: 'red' }, [{ name: 'color', value: 'red' }]);
    await page.clickstream.flush();
    await settle();

    // The snapshot was taken before the filter existed, so it must not have
    // acquired one retroactively.
    assert.equal(attr(page, 'result_click').facets, undefined);
  } finally {
    page.restore();
  }
});

test('two products found by two different searches keep their own attribution', async () => {
  const page = await loadPage();
  try {
    page.clickstream.search('merino', 12);
    page.clickstream.resultClick({ sku: 'A' }, 1);
    page.clickstream.search('cotton', 30);
    page.clickstream.resultClick({ sku: 'B' }, 2);
    page.clickstream.addToCart({ sku: 'A' }, 1);
    page.clickstream.addToCart({ sku: 'B' }, 1);
    await page.clickstream.flush();
    await settle();

    const adds = page.byType('add_to_cart');
    assert.equal(adds[0].attribution.query, 'merino', 'A keeps the search that found it');
    assert.equal(adds[1].attribution.query, 'cotton', 'B keeps its own');
  } finally {
    page.restore();
  }
});

test('a product viewed with no result click falls back to the current listing', async () => {
  const page = await loadPage();
  try {
    page.clickstream.categoryView('mens/shoes', { resultCount: 8 });
    page.clickstream.productView({ sku: 'SH-1' });
    await page.clickstream.flush();
    await settle();

    const a = attr(page, 'product_view');
    assert.equal(a.discoveryType, 'category');
    assert.equal(a.categoryPath, 'mens/shoes');
  } finally {
    page.restore();
  }
});

test('a product reached with no discovery at all is reported as direct', async () => {
  const page = await loadPage();
  try {
    page.clickstream.productView({ sku: 'SH-1' });
    await page.clickstream.flush();
    await settle();
    assert.equal(attr(page, 'product_view').discoveryType, 'direct');
  } finally {
    page.restore();
  }
});

test('attribution survives a full page navigation', async () => {
  // sessionStorage outlives a navigation; the client is reconstructed as it
  // would be on a server-rendered site's next page.
  const storages = {
    durable: (() => {
      const m = new Map();
      return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
    })(),
    perTab: (() => {
      const m = new Map();
      return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
    })()
  };

  const listing = await loadPage({ storages, path: '/search?q=merino' });
  try {
    listing.clickstream.search('merino', 12);
    listing.clickstream.resultClick({ sku: 'SW-42' }, 4);
    await listing.clickstream.flush();
  } finally {
    listing.restore();
  }

  // A brand new page, same tab.
  const pdp = await loadPage({ storages, path: '/product/merino-crew' });
  try {
    pdp.clickstream.addToCart({ sku: 'SW-42' }, 1);
    await pdp.clickstream.flush();
    await settle();
    const a = attr(pdp, 'add_to_cart');
    assert.equal(a.query, 'merino', 'the search that found it survived the page load');
    assert.equal(a.position, 4);
  } finally {
    pdp.restore();
  }
});

test('signing out clears the browsing context', async () => {
  const page = await loadPage();
  try {
    page.clickstream.search('merino', 12);
    page.clickstream.login({ customerId: 'c1', customerRef: 'jen@example.com' });
    page.clickstream.logout();
    await page.clickstream.flush();
    await settle();

    page.clickstream.productView({ sku: 'X' });
    await page.clickstream.flush();
    await settle();

    assert.equal(attr(page, 'product_view').discoveryType, 'direct',
      'the next shopper on a shared machine inherits nothing');
  } finally {
    page.restore();
  }
});

test('the pinned-product map is capped so a long session cannot grow it forever', async () => {
  const page = await loadPage();
  try {
    page.clickstream.search('q', 200);
    for (let i = 0; i < 60; i++) page.clickstream.resultClick({ sku: `S${i}` }, i + 1);
    await page.clickstream.flush();
    await settle();

    const stored = JSON.parse(page.storages.perTab.getItem('clickstream.attribution'));
    assert.equal(Object.keys(stored.products).length, 50, 'capped at 50');
    assert.ok(!stored.products['sku:S0'], 'earliest evicted');
    assert.ok(stored.products['sku:S59'], 'most recent kept');
  } finally {
    page.restore();
  }
});
