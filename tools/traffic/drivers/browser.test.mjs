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

test('a result click settles the listing before reading or clicking a card, closing the window where a sort/facet swap in flight could be raced', async () => {
  // A card matching "attached" is not proof the listing has finished
  // changing — a sort/facet/search step just before this one keeps its OLD
  // cards on screen while the new list loads. This fake never removes its
  // one card, so the test cannot see staleness directly; what it CAN prove
  // is the ordering the fix depends on: settle on network idle before
  // trusting `count()`/`getAttribute()`/`click()` at all.
  const calls = [];
  const cardHref = '/en-us/walnut-cabinet/p/WCS-09';
  const page = {
    url: () => 'https://x/en-us/search?q=cabinet',
    async waitForLoadState(state) {
      calls.push(`waitForLoadState:${state ?? 'load'}`);
    },
    async waitForTimeout() {},
    async goBack() {
      calls.push('goBack');
    },
    locator() {
      return {
        first() {
          return this;
        },
        async waitFor() {
          calls.push('cards.waitFor:attached');
        },
        async count() {
          return 1;
        },
        nth() {
          return {
            async getAttribute() {
              calls.push('card.getAttribute');
              return cardHref;
            },
            async click() {
              calls.push('card.click');
            }
          };
        }
      };
    }
  };
  const profileWithSelectors = {
    ...profile,
    selectors: { resultCard: "a[href*='/p/']" }
  };
  const step = { t: 'clickResult', rank: 1, product: { sku: 'SCG-09' } };
  const lastClick = {};

  const result = await perform(page, 'https://x', profileWithSelectors, step, {}, lastClick);

  assert.equal(result, true);
  assert.equal(step.product.sku, 'WCS-09', 'still corrects from what is actually on the card');
  const settleIndex = calls.indexOf('waitForLoadState:networkidle');
  const readIndex = calls.indexOf('card.getAttribute');
  const clickIndex = calls.indexOf('card.click');
  assert.notEqual(settleIndex, -1, 'settles on network idle before trusting the listing');
  assert.ok(
    settleIndex < readIndex && settleIndex < clickIndex,
    'settles BEFORE reading or clicking the card, not after — otherwise both still race the swap'
  );
});

test("a result click waits for the PDP to actually render before dwelling, closing the window where the next clickResult's goBack leaves before this page's own view fires", async () => {
  // The PDP is an async server component: `domcontentloaded` resolves before
  // the product fetch that gates `TrackEvent` has even started. A short
  // dwell followed immediately by the next clickResult's goBack can leave
  // this page before `product_view` ever mounts, dropping the view for a
  // page that was genuinely visited. Waiting for the add-to-cart control —
  // rendered from the same fetch TrackEvent depends on — is the real signal.
  const calls = [];
  const cardHref = '/en-us/walnut-cabinet/p/WCS-09';
  const page = {
    url: () => 'https://x/en-us/search?q=cabinet',
    async waitForLoadState(state) {
      calls.push(`waitForLoadState:${state ?? 'load'}`);
    },
    async waitForTimeout() {},
    async goBack() {},
    locator(selector) {
      calls.push(`locator:${selector}`);
      return {
        first() {
          return this;
        },
        async waitFor() {
          calls.push(`waitFor:${selector}`);
        },
        async count() {
          return 1;
        },
        nth() {
          return {
            async getAttribute() {
              return cardHref;
            },
            async click() {
              calls.push('card.click');
            }
          };
        }
      };
    }
  };
  const profileWithSelectors = {
    ...profile,
    selectors: { resultCard: "a[href*='/p/']", addToCart: "button:has-text('Add to Cart')" }
  };
  const step = { t: 'clickResult', rank: 1, product: { sku: 'SCG-09' } };

  const result = await perform(page, 'https://x', profileWithSelectors, step, {}, {});

  assert.equal(result, true);
  const clickIndex = calls.indexOf('card.click');
  const waitIndex = calls.indexOf(`waitFor:${profileWithSelectors.selectors.addToCart}`);
  assert.notEqual(waitIndex, -1, 'waits on the add-to-cart control before moving on');
  assert.ok(
    clickIndex < waitIndex,
    'waits AFTER the click lands, before dwelling — otherwise the next step can leave before this page`s own product_view fires'
  );
});

test('a facet click waits for the URL to actually reflect the toggle before the next step can click the same chip', async () => {
  // applyFacet and removeFacet share one selector — the same chip toggles
  // both ways. A removeFacet step right after applyFacet clicks that chip
  // again before its own step returns, so if this click does not wait for
  // the URL to actually drop the applied value, the next click can land
  // while the pill's onClick is still reading the pre-click (still-applied)
  // searchParams — it sees "applied" again and reapplies instead of
  // removing. Waiting on network idle does not catch this: a cached RSC
  // segment resolves with no network activity at all.
  const calls = [];
  let capturedPredicate;
  const page = {
    url: () => 'https://x/en-us/category/dressers?eco-claims=low-voc-finish',
    async waitForLoadState() {},
    async waitForTimeout() {},
    async waitForURL(predicate) {
      calls.push('waitForURL');
      capturedPredicate = predicate;
    },
    locator() {
      return {
        first() {
          return this;
        },
        async waitFor() {
          calls.push('chip.waitFor:attached');
        },
        async count() {
          return 1;
        },
        async click() {
          calls.push('chip.click');
        }
      };
    }
  };
  const profileWithSelectors = {
    ...profile,
    selectors: { facetChip: "button:has-text('{value}')" }
  };
  const step = { t: 'removeFacet', name: 'eco-claims', value: 'low-voc-finish' };

  const result = await perform(page, 'https://x', profileWithSelectors, step, {});

  assert.equal(result, true);
  const clickIndex = calls.indexOf('chip.click');
  const waitIndex = calls.indexOf('waitForURL');
  assert.notEqual(waitIndex, -1, 'waits for the URL to reflect the removal after the click');
  assert.ok(
    clickIndex < waitIndex,
    'waits AFTER clicking, before returning — otherwise the next facet step can race this one'
  );
  assert.equal(
    capturedPredicate(new URL('https://x/c?eco-claims=low-voc-finish')),
    false,
    'not settled while the facet is still applied'
  );
  assert.equal(
    capturedPredicate(new URL('https://x/c')),
    true,
    'settled once the param is actually gone — the real signal removal committed'
  );
});

test('an applyFacet step waits for the URL to actually gain the value, not lose it', async () => {
  const page = {
    url: () => 'https://x/en-us/category/dressers',
    async waitForLoadState() {},
    async waitForTimeout() {},
    waitForURLCalls: [],
    async waitForURL(predicate) {
      this.waitForURLCalls.push(predicate);
    },
    locator() {
      return {
        first() {
          return this;
        },
        async waitFor() {},
        async count() {
          return 1;
        },
        async click() {}
      };
    }
  };
  const profileWithSelectors = {
    ...profile,
    selectors: { facetChip: "button:has-text('{value}')" }
  };
  const step = { t: 'applyFacet', name: 'eco-claims', value: 'low-voc-finish' };

  await perform(page, 'https://x', profileWithSelectors, step, {});

  const predicate = page.waitForURLCalls[0];
  assert.equal(
    predicate(new URL('https://x/c')),
    false,
    'not settled until the value actually shows up in the URL'
  );
  assert.equal(
    predicate(new URL('https://x/c?eco-claims=low-voc-finish')),
    true,
    'settled once the apply actually committed'
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
