/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * The browser driver: an intent script against a real storefront.
 *
 * Slow, and that is the point. This one drives an actual page through the
 * actual instrumentation, so what lands in the reports came through the same
 * code path a shopper's browser uses — the script tag, the data attributes,
 * the first-party proxy, all of it. The synth driver can only prove the
 * collector and the reports are right; this proves the *storefront* is
 * instrumented.
 *
 * It reports what it ACTUALLY DID, not what it was asked to do. A step it
 * could not perform — a control that moved, a checkout that needs a payment
 * method it does not have — is recorded as skipped, and the reconciler is
 * held to the performed list. Otherwise every driver limitation would surface
 * as a tracking bug, and the one report that has to be trustworthy would cry
 * wolf.
 */

import { chromium } from 'playwright';
import { pathFor } from '../lib/profile.js';

/** Step-level timeouts. Generous: a cold serverless storefront is slow. */
const NAV_TIMEOUT = 30_000;
const ACTION_TIMEOUT = 10_000;

/** How long a shopper "looks" at something, so sessions are not instant. */
const DWELL = {
  viewProduct: [900, 2600],
  search: [700, 1800],
  browseCategory: [700, 1800],
  default: [350, 900]
};

export async function createBrowserDriver({ profile, opts }) {
  const base = opts.target.replace(/\/+$/, '');
  const browser = await chromium.launch({ headless: !opts.headed });

  return {
    async run(session) {
      // A fresh context per session: its own storage, so its own anonymous id
      // and its own gate cookie. Reusing one would make every session look
      // like the same returning shopper.
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: profile.context?.locale || 'en-US'
      });
      const page = await context.newPage();
      page.setDefaultTimeout(ACTION_TIMEOUT);
      page.setDefaultNavigationTimeout(NAV_TIMEOUT);

      /** Every POST the page made to its ingest path, so delivery is provable. */
      const posts = [];
      page.on('response', (res) => {
        const url = res.url();
        if (/\/api\/clickstream|\/collect(\?|$)/.test(url) && res.request().method() === 'POST') {
          posts.push({ status: res.status() });
        }
      });

      const performed = [];
      const skipped = [];

      try {
        await passGate(page, base, profile, session);

        for (const step of session.steps) {
          try {
            const did = await perform(page, base, profile, step, session);
            if (did) performed.push(step);
            else skipped.push({ t: step.t, reason: 'not applicable' });
          } catch (err) {
            // One control that moved must not abandon the whole session: the
            // steps already performed are real data and worth keeping.
            skipped.push({ t: step.t, reason: shortError(err) });
          }
        }

        // The client batches for two seconds and flushes on page hide, so give
        // it both before tearing the context down — otherwise the last events
        // of every session are lost and look like a tracking bug.
        await page.evaluate(() => window.clickstream?.flush?.()).catch(() => {});
        await page.waitForTimeout(1200);

        const sessionId = await page
          .evaluate(() => window.clickstream?.identity?.().sessionId ?? null)
          .catch(() => null);

        return {
          sessionId,
          performed,
          skipped,
          accepted: posts.filter((p) => p.status === 202).length,
          rejected: posts.filter((p) => p.status >= 400).map((p) => ({ status: p.status })),
          requests: posts.length
        };
      } finally {
        await context.close().catch(() => {});
      }
    },

    async close() {
      await browser.close().catch(() => {});
    }
  };
}

/**
 * Get past the site's own gate, if it has one.
 *
 * A gated storefront answers every content URL with a redirect, so a driver
 * that skips this records a session of nothing but gate page views — which
 * reads as catastrophic tracking failure rather than as a driver that never
 * logged in.
 */
async function passGate(page, base, profile, session) {
  await page.goto(base + pathFor(profile, 'home'), { waitUntil: 'domcontentloaded' });

  const email = page.locator(profile.selectors.gateEmail).first();
  if (!(await email.count())) return;
  if (!(await email.isVisible().catch(() => false))) return;

  await email.fill(session.customer?.email || 'traffic@example.com');
  const password = page.locator('input[type=password]').first();
  if ((await password.count()) && (await password.isVisible().catch(() => false))) {
    const secret = process.env.CLICKSTREAM_TARGET_GATE_PASSWORD || '';
    if (secret) await password.fill(secret);
  }
  await submitForm(page, email, profile.selectors.gateSubmit);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

/**
 * Submit a form without relying on a pointer landing on the button.
 *
 * Gates and modals are frequently rendered under a full-page overlay, and a
 * real click is then intercepted by a div that is not the control — which
 * fails the whole session for a reason that has nothing to do with the
 * storefront. `requestSubmit()` fires the same submit event the button would,
 * and honours validation; the click is kept as a fallback for a form that has
 * none.
 */
async function submitForm(page, fieldLocator, buttonSelector) {
  const submitted = await fieldLocator
    .evaluate((el) => {
      const form = el.closest('form');
      if (!form) return false;
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      return true;
    })
    .catch(() => false);
  if (submitted) return;
  await page.locator(buttonSelector).first().click({ force: true });
}

/** @returns {Promise<boolean>} whether the step was actually performed. */
async function perform(page, base, profile, step, session) {
  const sel = profile.selectors;
  const dwell = async (kind) => {
    const [lo, hi] = DWELL[kind] || DWELL.default;
    await page.waitForTimeout(lo + Math.floor(Math.random() * (hi - lo)));
  };

  switch (step.t) {
    case 'land':
      // The gate already landed us on the home page.
      await dwell('default');
      return true;

    case 'login': {
      if (!step.customer) return false;
      await page.goto(base + pathFor(profile, 'login'), { waitUntil: 'domcontentloaded' });
      const loginEmail = page.locator(sel.loginEmail).first();
      await loginEmail.fill(step.customer.email);
      await page.locator(sel.loginPassword).first().fill(step.customer.password || '123');
      await submitForm(page, loginEmail, sel.loginSubmit);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await dwell('default');
      // Only a real sign-in counts: an unregistered customer leaves the page
      // on the login form, and reporting that as a login would invent data.
      return !page.url().includes(pathFor(profile, 'login'));
    }

    case 'logout': {
      const out = page.locator("a:has-text('Sign out'), button:has-text('Sign out')").first();
      if (!(await out.count())) return false;
      await out.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return true;
    }

    case 'search':
      await page.goto(base + pathFor(profile, 'search', { term: step.term }), {
        waitUntil: 'domcontentloaded'
      });
      await dwell('search');
      return true;

    case 'browseCategory':
      await page.goto(base + pathFor(profile, 'category', { slug: step.slug }), {
        waitUntil: 'domcontentloaded'
      });
      await dwell('browseCategory');
      return true;

    case 'applyFacet':
    case 'removeFacet': {
      const chip = page.locator(sel.facetChip.replace('{value}', step.value)).first();
      if (!(await chip.count())) return false;
      await chip.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await dwell('default');
      return true;
    }

    case 'sort': {
      const select = page.locator(sel.sortSelect).first();
      if (!(await select.count())) return false;
      await select.selectOption({ index: 1 }).catch(() => {});
      await dwell('default');
      return true;
    }

    case 'clickResult': {
      const cards = page.locator(sel.resultCard);
      const count = await cards.count();
      if (!count) return false;
      // The rank the script asked for, or the last card if the real listing is
      // shorter than the profile's product list.
      const index = Math.min(step.rank - 1, count - 1);
      const card = cards.nth(index);

      // Read what is ACTUALLY there before clicking, and correct the step.
      //
      // The script predicted a product at this rank from the profile's list,
      // but the live listing is sorted by the store's own relevance and will
      // not match. Left uncorrected, the reconciler compares the tracking
      // against a prediction and reports a field error for every click —
      // condemning tracking that recorded exactly what was clicked.
      //
      // What the driver observed in the page IS the ground truth.
      const href = (await card.getAttribute('href').catch(() => null)) || '';
      const observedSku = /\/p\/([^/?#]+)/.exec(href)?.[1];
      if (observedSku) {
        step.product = { ...step.product, sku: decodeURIComponent(observedSku) };
      }
      step.rank = index + 1;

      await card.click({ force: true });
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await dwell('viewProduct');
      return true;
    }

    case 'viewProduct': {
      // A clickResult immediately before this already navigated here, and the
      // product view fires on render — so re-navigating would double-count it.
      if (page.url().includes('/p/')) {
        // Correct the step to whatever the page actually is, for the same
        // reason clickResult does: the URL is the truth, the script was a
        // prediction.
        const sku = /\/p\/([^/?#]+)/.exec(page.url())?.[1];
        if (sku) step.product = { ...step.product, sku: decodeURIComponent(sku) };
        return true;
      }
      await page.goto(
        base + pathFor(profile, 'product', { slug: step.product.slug, sku: step.product.sku }),
        { waitUntil: 'domcontentloaded' }
      );
      await dwell('viewProduct');
      return true;
    }

    case 'addToCart': {
      const button = page.locator(sel.addToCart).first();
      if (!(await button.count())) return false;
      await button.scrollIntoViewIfNeeded().catch(() => {});

      // The product added is whatever is on THIS page, not the one the
      // script predicted from the profile's list — a search that landed on
      // a different product (the live catalog no longer matches the
      // profile's static order) still adds the product actually shown.
      // Same correction clickResult/viewProduct already apply, so the
      // reconciler is held to what happened rather than what was guessed.
      const sku = /\/p\/([^/?#]+)/.exec(page.url())?.[1];
      if (sku) step.product = { ...step.product, sku: decodeURIComponent(sku) };

      // Sticky headers and cart drawers overlap controls on a narrow
      // viewport; the intent is the click, not the hit-test.
      await button.click({ force: true });
      await dwell('default');
      return true;
    }

    case 'viewCart':
      await page.goto(base + pathFor(profile, 'cart'), { waitUntil: 'domcontentloaded' });
      await dwell('default');
      return true;

    case 'removeFromCart': {
      const remove = page.locator("button:has-text('Remove')").first();
      if (!(await remove.count())) return false;
      await remove.click();
      await dwell('default');
      return true;
    }

    case 'checkout':
      await page.goto(base + pathFor(profile, 'checkout'), { waitUntil: 'domcontentloaded' });
      await dwell('default');
      return true;

    case 'placeOrder':
      // Completing a real checkout needs an address and a payment method this
      // driver does not have. Recorded as skipped rather than faked, so the
      // reconciler is not held to an order that never happened — and so the
      // gap is visible in the log instead of looking like lost tracking.
      return false;

    case 'leave':
      return true;

    default:
      return false;
  }
}

function shortError(err) {
  return String(err.message || err).split('\n')[0].slice(0, 140);
}
