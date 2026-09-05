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

/** The control only a signed-in page carries — the sign-in check and the sign-out step both look for it. */
const SIGN_OUT = "a:has-text('Sign out'), button:has-text('Sign out')";

/** How long a shopper "looks" at something, so sessions are not instant. */
const DWELL = {
  viewProduct: [900, 2600],
  search: [700, 1800],
  browseCategory: [700, 1800],
  default: [350, 900]
};

export async function createBrowserDriver({ profile, opts }) {
  const base = opts.target.replace(/\/+$/, '');
  const browser = await chromium.launch({
    headless: !opts.headed,
    // Playwright closes the browser and ends the process on an interrupt by
    // default, which takes the sessions in flight with it. A standing run is
    // stopped with Ctrl-C as a matter of course, and its log is the ground
    // truth the accuracy check reads — so a visit cut off mid-way reads as
    // lost tracking. The run's own drain owns shutdown instead.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false
  });

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
            if (did === true) performed.push(step);
            // A skip says WHY. "Not applicable" covers an expected skip and a
            // selector that has broken with the same three words, and the
            // accuracy check reads every skip as "not a tracking failure" — so
            // an undiagnosed skip is how coverage quietly falls away.
            else skipped.push({ t: step.t, reason: String(did || 'not applicable') });
          } catch (err) {
            // One control that moved must not abandon the whole session: the
            // steps already performed are real data and worth keeping.
            skipped.push({ t: step.t, reason: shortError(err) });
          }
        }

        // Let a navigation the last step kicked off land first. A route that
        // redirects on arrival — a checkout that goes straight to its first
        // step — leaves the page still navigating here, and both calls below
        // then throw with the execution context destroyed: the flush is
        // skipped and the session id comes back null, so the visit that went
        // DEEPEST into the funnel is the one dropped from the accuracy check.
        await page.waitForLoadState('domcontentloaded').catch(() => {});

        // The client batches for two seconds and flushes on page hide, so give
        // it both before tearing the context down — otherwise the last events
        // of every session are lost and look like a tracking bug.
        await inPage(page, () => window.clickstream?.flush?.());
        await page.waitForTimeout(1200);

        const sessionId = await inPage(
          page,
          () => window.clickstream?.identity?.().sessionId ?? null
        );

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

  await fillField(page, email, session.customer?.email || 'traffic@example.com');
  const password = page.locator('input[type=password]').first();
  if ((await password.count()) && (await password.isVisible().catch(() => false))) {
    const secret = process.env.CLICKSTREAM_TARGET_GATE_PASSWORD || '';
    if (secret) await fillField(page, password, secret);
  }
  await submitForm(page, email, profile.selectors.gateSubmit);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

/**
 * Run something in the page, surviving a navigation landing underneath.
 *
 * An `evaluate` issued while the page is still navigating throws with the
 * execution context destroyed. Retrying once the load state settles is the
 * difference between reading a session's identity and reporting the whole
 * visit as having never arrived.
 */
async function inPage(page, fn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.evaluate(fn);
    } catch {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(400);
    }
  }
  return null;
}

/**
 * Type into a field, and make sure the value stuck.
 *
 * A framework-controlled input renders from its own state, so a value filled
 * before that component is live gets silently reverted on hydration:
 * `fill()` reports success, the field ends up empty, and the form then fails
 * HTML validation and issues no request at all. The page comes back looking
 * untouched — which the driver read as a sign-in the storefront had rejected,
 * for a customer who signs in perfectly well.
 *
 * Re-filling until the value survives a beat is also the hydration wait: once
 * it sticks, the component is live, so the submit that follows has a handler
 * listening for it.
 */
async function fillField(page, locator, value) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await locator.fill(value);
    await page.waitForTimeout(180);
    if ((await locator.inputValue().catch(() => '')) === value) return true;
  }
  return false;
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

/**
 * Navigate, tolerating a navigation the page started for itself.
 *
 * A click on a storefront control often kicks off a client-side navigation
 * that lands after the driver has moved on. Playwright then aborts the
 * driver's own `goto` with "interrupted by another navigation", and a step
 * that was perfectly performable is recorded as skipped — which costs
 * coverage for a race rather than for anything the storefront did. Let the
 * in-flight navigation land, then go again.
 */
async function go(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    if (!/interrupted by another navigation/i.test(String(err.message || err))) throw err;
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/**
 * Run one step.
 *
 * @returns {Promise<true|string>} `true` when the step was performed, or the
 * reason it could not be — which goes in the log, so a broken selector reads
 * differently from a facet that was never on this listing.
 */
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
      if (!step.customer) return 'no customer on this shopper';
      await go(page, base + pathFor(profile, 'login'));
      const loginEmail = page.locator(sel.loginEmail).first();
      const filled = await fillField(page, loginEmail, step.customer.email);
      await fillField(page, page.locator(sel.loginPassword).first(), step.customer.password || '123');
      if (!filled) return 'the email field would not hold a value';
      await submitForm(page, loginEmail, sel.loginSubmit);

      // The sign-in posts and then redirects on the client, which against a
      // cold serverless storefront takes seconds. One load state and a dwell
      // decide before the answer arrives, and the visit is then logged as a
      // rejected sign-in for a customer who signed in perfectly well — which
      // reads as a broken storefront rather than as a driver in a hurry.
      const loginPath = pathFor(profile, 'login');
      await page
        .waitForURL((url) => !url.pathname.includes(loginPath), { timeout: 20_000 })
        .catch(() => {});

      // Signed in is a claim about the page, not about the URL: a gated site
      // bounces an unauthenticated visitor somewhere that is also "not the
      // login page", and treating that as a sign-in would invent the one event
      // the Sign-ins report is made of. A sign-out control is what only a
      // signed-in page carries.
      if (page.url().includes(loginPath)) return `sign-in rejected for ${step.customer.email}`;
      if (!(await page.locator(SIGN_OUT).first().count())) {
        return `signed in but no sign-out control at ${new URL(page.url()).pathname}`;
      }
      await dwell('default');
      return true;
    }

    case 'logout': {
      const out = page.locator(SIGN_OUT).first();
      if (!(await out.count())) return 'no sign-out control on the page';
      await out.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return true;
    }

    case 'search':
      await go(page, base + pathFor(profile, 'search', { term: step.term }));
      await dwell('search');
      return true;

    case 'browseCategory':
      await go(page, base + pathFor(profile, 'category', { slug: step.slug }));
      await dwell('browseCategory');
      return true;

    case 'applyFacet':
    case 'removeFacet': {
      const chip = page.locator(sel.facetChip.replace('{value}', step.value)).first();
      if (!(await chip.count())) return `no facet control for ${step.name}=${step.value}`;
      await chip.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await dwell('default');
      return true;
    }

    case 'sort': {
      const select = page.locator(sel.sortSelect).first();
      if (!(await select.count())) return 'no sort control on this listing';
      await select.selectOption({ index: 1 }).catch(() => {});
      await dwell('default');
      return true;
    }

    case 'clickResult': {
      // behaviour.js's browseListing() emits several clickResult+viewProduct
      // pairs back to back from ONE listing, with no search/browseCategory step
      // between them. The previous pair already navigated this page to a
      // product detail page, so without returning to the listing first, this
      // query would match whatever `a[href*='/p/']` links THAT page happens to
      // carry — related products (rendered with no rank, so they never track a
      // result_click) or recently-viewed cards (which track nothing at all) —
      // instead of the next-ranked result the script actually asked for.
      if (page.url().includes('/p/')) {
        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      }
      const cards = page.locator(sel.resultCard);
      const count = await cards.count();
      if (!count) return 'no result cards on the listing';
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
      await go(
        page,
        base + pathFor(profile, 'product', { slug: step.product.slug, sku: step.product.sku })
      );
      await dwell('viewProduct');
      return true;
    }

    case 'addToCart': {
      const button = page.locator(sel.addToCart).first();
      if (!(await button.count())) return 'no add-to-cart control on the page';
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
      await go(page, base + pathFor(profile, 'cart'));
      await dwell('default');
      return true;

    case 'removeFromCart': {
      const remove = page.locator("button:has-text('Remove')").first();
      if (!(await remove.count())) return 'nothing in the cart to remove';
      await remove.click();
      await dwell('default');
      return true;
    }

    case 'checkout':
      await go(page, base + pathFor(profile, 'checkout'));
      await dwell('default');
      return true;

    case 'placeOrder':
      // Completing a real checkout needs an address and a payment method this
      // driver does not have. Recorded as skipped rather than faked, so the
      // reconciler is not held to an order that never happened — and so the
      // gap is visible in the log instead of looking like lost tracking.
      return 'needs a payment method the driver does not have';

    case 'leave':
      return true;

    default:
      return `no driver support for step "${step.t}"`;
  }
}

function shortError(err) {
  return String(err.message || err).split('\n')[0].slice(0, 140);
}
