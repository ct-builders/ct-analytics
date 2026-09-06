/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { perform, productFromPath } from './browser.js';

const profile = {
  paths: { product: '/en-us/{slug}/p/{sku}' }
};

/** A page double that tracks navigations and reflects them back through url(). */
function fakePage(startUrl, { redirectTo } = {}) {
  let url = startUrl;
  const gotoCalls = [];
  return {
    url: () => url,
    async goto(target) {
      gotoCalls.push(target);
      url = redirectTo ?? target;
    },
    async waitForLoadState() {},
    async waitForTimeout() {},
    gotoCalls
  };
}

test('a listing-paired view trusts the page it already landed on', async () => {
  const page = fakePage('https://x/en-us/modern-glam-dresser/p/RCD-01');
  const lastClick = { sku: 'RCD-01', rank: 2 };
  const step = {
    t: 'viewProduct',
    rank: 2,
    product: { sku: 'MGD-01', slug: 'modern-glam-dresser' }
  };

  const result = await perform(page, 'https://x', profile, step, {}, lastClick);

  assert.equal(result, true);
  assert.equal(page.gotoCalls.length, 0, 'a click already put us on the right page');
  assert.equal(step.product.sku, 'RCD-01', 'the URL is the ground truth, not the profile prediction');
  assert.equal(step.rank, 2);
});

test('a standalone view navigates instead of re-reporting whatever page it is already on', async () => {
  // The page is still sitting on the PREVIOUS step's product — e.g. an
  // addToCart that did not navigate away — the way it does before a
  // second-line companion view. The old code mistook this for a click that
  // had just landed here and skipped navigating entirely, silently
  // re-reporting the wrong product and dropping the real view.
  const page = fakePage('https://x/en-us/rustic-country-dresser/p/RCD-01');
  const step = {
    t: 'viewProduct',
    // No `rank` — a companion (or direct-mode) view never carries one.
    product: { sku: 'MGD-01', slug: 'modern-glam-dresser' }
  };

  const result = await perform(page, 'https://x', profile, step, {}, {});

  assert.equal(result, true);
  assert.deepEqual(page.gotoCalls, ['https://x/en-us/modern-glam-dresser/p/MGD-01']);
  assert.equal(step.product.sku, 'MGD-01');
});

test('a standalone view corrects its sku from a live catalog that redirected elsewhere', async () => {
  const page = fakePage('https://x/en-us/rustic-country-dresser/p/RCD-01', {
    redirectTo: 'https://x/en-us/modern-bookcase/p/MB-0973'
  });
  const step = {
    t: 'viewProduct',
    product: { sku: 'MGD-01', slug: 'modern-glam-dresser' }
  };

  await perform(page, 'https://x', profile, step, {}, {});

  assert.equal(step.product.sku, 'MB-0973', 'the landed page is the ground truth, not the prediction');
  assert.equal(
    step.product.slug,
    'modern-bookcase',
    'the redirect changed both halves of the pair, not just the sku'
  );
});

test('productFromPath extracts slug and sku together, not just the sku half', () => {
  assert.deepEqual(productFromPath('/en-us/walnut-cabinet/p/WCS-09'), {
    slug: 'walnut-cabinet',
    sku: 'WCS-09'
  });
  assert.deepEqual(
    productFromPath('https://x/en-us/amalia-rug/p/AMR-09?ref=nav'),
    { slug: 'amalia-rug', sku: 'AMR-09' }
  );
  assert.equal(productFromPath('/en-us/cart'), null);
});
