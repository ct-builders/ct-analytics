/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * The action log.
 *
 * One JSON line per session, holding what the shopper was instructed to do and
 * what the driver reports it actually did. This is the ground truth the
 * accuracy check reads, which is why it records the intent rather than the
 * events: comparing captured events against other captured events proves
 * nothing.
 *
 * JSONL rather than one JSON document so a long run can be tailed while it is
 * still going, and so a crash leaves every completed line readable.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openLog(path) {
  if (!path) {
    return { write: () => {}, close: async () => {}, path: null };
  }
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { flags: 'a' });

  return {
    path,
    /** @param {object} record */
    write(record) {
      stream.write(`${JSON.stringify(record)}\n`);
    },
    close() {
      return new Promise((resolve) => stream.end(resolve));
    }
  };
}

/**
 * The ground-truth record for one session.
 *
 * `expected` is a flat count of what the intent script asked for, per event
 * type. The reconciler compares it against what the database holds, so a
 * mismatch names the event type rather than just saying the totals differ.
 */
export function sessionRecord({ session, sessionId, driver, profile, outcome, expected, error }) {
  return {
    at: new Date().toISOString(),
    driver,
    site: profile.site,
    profile: profile.id,
    sessionId,
    anonymousId: session.anonymousId,
    persona: session.persona,
    signedIn: session.signedIn,
    customer: session.customer?.email ?? null,
    startedAt: session.startedAt,
    // The instructions, verbatim. A step is one shopper action; the driver
    // may turn it into more than one event.
    steps: session.steps.map(summariseStep),
    // What the driver could not do, and why. Kept beside the intent so a run
    // is diagnosable without re-running it, and so a driver gap is never
    // mistaken for lost tracking.
    ...(outcome?.skipped?.length ? { skipped: outcome.skipped } : {}),
    expected,
    outcome,
    ...(error ? { error: String(error.message || error) } : {})
  };
}

function summariseStep(step) {
  const out = { t: step.t };
  if (step.term) out.term = step.term;
  if (step.expectZero) out.expectZero = true;
  // The size of the result set the shopper was shown. Recorded so the
  // reconciler can assert the exact number rather than merely "not zero".
  if (step.products) out.resultCount = step.products.length;
  if (step.slug) out.slug = step.slug;
  if (step.name && step.t !== 'applyFacet' && step.t !== 'removeFacet') out.name = step.name;
  if (step.t === 'applyFacet' || step.t === 'removeFacet') {
    out.facet = `${step.name}=${step.value}`;
    if (step.resultCount !== undefined) out.resultCount = step.resultCount;
  }
  if (step.key) out.sort = step.key;
  if (step.checkoutSteps !== undefined) out.checkoutSteps = step.checkoutSteps;
  if (step.rank !== undefined) out.rank = step.rank;
  if (step.product) out.sku = step.product.sku;
  if (step.quantity !== undefined) out.quantity = step.quantity;
  if (step.items) out.items = step.items.map((i) => `${i.product.sku}x${i.quantity}`);
  if (step.reason) out.reason = step.reason;
  if (step.fulfillment) out.fulfillment = step.fulfillment;
  if (step.location) out.locationKey = step.location.key;
  if (step.customer) out.customer = step.customer.email;
  if (step.direct) out.direct = true;
  return out;
}

/**
 * Count what the intent script asked for, by Clickstream event type.
 *
 * This is the mapping the reconciler holds the tracking to, so it lives with
 * the log rather than inside a driver: it must describe the INTENT, not any
 * one driver's translation of it.
 */
export function expectedCounts(session) {
  const counts = {};
  const bump = (type, n = 1) => {
    counts[type] = (counts[type] || 0) + n;
  };

  for (const step of session.steps) {
    switch (step.t) {
      case 'land': bump('page_view'); break;
      case 'login': bump('page_view'); bump('login'); break;
      case 'logout': bump('logout'); break;
      case 'search': bump('page_view'); bump('search'); break;
      case 'browseCategory': bump('page_view'); bump('category_view'); break;
      case 'applyFacet': bump('facet_apply'); break;
      case 'removeFacet': bump('facet_remove'); break;
      case 'sort': bump('sort_change'); break;
      case 'clickResult': bump('result_click'); break;
      case 'viewProduct': bump('page_view'); bump('product_view'); break;
      case 'addToCart': bump('add_to_cart'); break;
      case 'removeFromCart': bump('remove_from_cart'); break;
      case 'viewCart': bump('cart_view'); break;
      // Two steps either way, but a collection order gets `collection`
      // instead of `shipping` — see the synth driver. A driver that only
      // reaches the first step says so, the same way it corrects a rank or a
      // quantity: holding the tracking to steps nobody walked reports a
      // missing event for a checkout that was recorded exactly right.
      case 'checkout':
        bump('page_view');
        bump('checkout_start');
        bump('checkout_step', step.checkoutSteps ?? 2);
        break;
      case 'placeOrder': bump('order_submit'); bump('page_view'); break;
      case 'leave': break;
      default: break;
    }
  }
  return counts;
}
