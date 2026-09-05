/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * The shopper behaviour model.
 *
 * Produces an **intent script** — an ordered list of abstract steps like
 * "search for sofa", "click result 3", "add to cart" — and nothing else. It
 * knows about shoppers; it knows nothing about HTTP, Playwright, CSS
 * selectors or the event taxonomy.
 *
 * That separation is the whole design. Both drivers execute the same script:
 * one synthesises events and posts them to the collector in milliseconds, the
 * other drives a real browser through a real storefront over minutes. Because
 * the script comes first and the driver second, backfilled data and
 * browser-driven data are the same shape — a run can seed six weeks of
 * history and then generate live traffic on top of it without the join
 * showing.
 *
 * It also makes the accuracy check exact rather than statistical. The intent
 * script IS the ground truth: it says a shopper clicked result 3, so the
 * captured `source_position` either says 3 or the tracking is wrong. Nothing
 * has to be inferred from timing or ordering.
 *
 * Deterministic throughout: same seed, same scripts. A dataset that looked
 * right yesterday looks identical today.
 */

import { pickPersona } from './personas.js';

/** Mulberry32. Small, fast, and seedable so runs are reproducible. */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const between = (rand, [lo, hi]) => lo + Math.floor(rand() * (hi - lo + 1));
const chance = (rand, p) => rand() < p;

/**
 * When a session happened.
 *
 * Two shaping decisions, both there because the alternative looks fake in the
 * reports. Recency weighting (`pow` > 1) means a "last 7 days" view is busier
 * than a "last 90 days" view, as real traffic is. The hour-of-day curve means
 * the Sessions report does not show a suspiciously even spread across 3am.
 */
export function sessionStartedAt(rand, { now, days }) {
  const ageDays = days * Math.pow(rand(), 1.7);
  const start = new Date(now - ageDays * 86_400_000);
  // A crude two-peak retail day: late morning and mid evening.
  const hourWeights = [
    0.2, 0.1, 0.1, 0.1, 0.2, 0.4, 0.8, 1.4, 2.0, 2.6, 3.0, 3.0,
    2.8, 2.6, 2.4, 2.3, 2.4, 2.8, 3.2, 3.4, 3.0, 2.2, 1.2, 0.6
  ];
  const total = hourWeights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  let hour = 0;
  for (let i = 0; i < 24; i++) {
    r -= hourWeights[i];
    if (r <= 0) { hour = i; break; }
  }
  start.setUTCHours(hour, Math.floor(rand() * 60), Math.floor(rand() * 60), 0);
  return start;
}

/**
 * Choose a fulfilment method, and a store when one is involved.
 *
 * Decided once per session, at the point the shopper commits to a basket,
 * because that is when a real shopper decides — and because deciding earlier
 * would attach a store to browsing that had nothing to do with one.
 *
 * The method is drawn from what the chosen store actually offers, so the
 * reports never show a location taking curbside orders it cannot fulfil. That
 * matters in front of an audience: someone will read a row and ask.
 */
function chooseFulfillment(rand, profile) {
  const stores = profile.stores || [];
  const rate = profile.storeFulfillmentRate ?? 0;
  if (!stores.length || !chance(rand, rate)) return { fulfillment: 'delivery' };

  const total = stores.reduce((n, st) => n + (st.weight ?? 1), 0);
  let r = rand() * total;
  let store = stores[stores.length - 1];
  for (const st of stores) {
    r -= st.weight ?? 1;
    if (r <= 0) { store = st; break; }
  }
  const options = store.fulfillments?.length ? store.fulfillments : ['pickup'];
  return {
    fulfillment: pick(rand, options),
    location: { key: store.key, name: store.name }
  };
}

/**
 * Build one session's intent script.
 *
 * @param {object} opts
 * @param {() => number} opts.rand
 * @param {import('./profile.js').Profile} opts.profile
 * @param {{ anonymousId: string, customer?: { id: string, email: string, password?: string } }} opts.shopper
 * @param {Date} opts.startedAt
 * @param {import('./personas.js').Persona} [opts.persona]
 */
export function buildSession({ rand, profile, shopper, startedAt, persona }) {
  const p = persona ?? pickPersona(rand);
  /** @type {any[]} */
  const steps = [];
  const say = (t, extra = {}) => steps.push({ t, ...extra });

  const signedIn = Boolean(shopper.customer) && chance(rand, p.signedIn);

  say('land', { path: '/' });
  if (signedIn) say('login', { customer: shopper.customer });

  // How this shopper finds things.
  const roll = rand();
  const mode =
    roll < p.discovery.search ? 'search'
      : roll < p.discovery.search + p.discovery.category ? 'category'
        : 'direct';

  /** Products this session has actually seen, so later steps refer to real ones. */
  const seen = [];
  const searchCount = between(rand, p.searchesPerSession);

  if (mode === 'search' || (mode === 'category' && searchCount > 0 && chance(rand, 0.3))) {
    for (let i = 0; i < Math.max(1, searchCount); i++) {
      // A miss ends the discovery attempt: a shopper who finds nothing
      // usually leaves, which is the entire point of the zero-result report.
      if (chance(rand, p.zeroResultRate)) {
        say('search', { term: pick(rand, profile.searchMisses), expectZero: true });
        if (chance(rand, 0.7)) { say('leave', { reason: 'no results' }); return finish(); }
        continue;
      }
      const entry = pick(rand, profile.searchTerms);
      say('search', { term: entry.term, products: entry.products });
      browseListing(entry.products);
    }
  } else if (mode === 'category') {
    const cat = pick(rand, profile.categories);
    say('browseCategory', { slug: cat.slug, name: cat.name, products: cat.products });
    browseListing(cat.products);
  } else {
    // Straight to a product, the way a returning visitor or an email link
    // arrives. No discovery, so attribution should record `direct`.
    const product = pick(rand, profile.products);
    say('viewProduct', { product, direct: true });
    seen.push(product);
  }

  if (!seen.length) { say('leave', { reason: 'nothing viewed' }); return finish(); }

  const chosen = seen[Math.floor(rand() * seen.length)];

  if (!chance(rand, p.addToCart)) { say('leave', { reason: 'did not add' }); return finish(); }

  const quantity = chance(rand, p.multiUnitRate) ? between(rand, [2, 3]) : 1;
  const fulfil = chooseFulfillment(rand, profile);
  say('addToCart', { product: chosen, quantity, ...fulfil });

  if (chance(rand, p.removeFromCart)) {
    say('viewCart');
    say('removeFromCart', { product: chosen, quantity, ...fulfil });
    say('leave', { reason: 'emptied cart' });
    return finish();
  }

  say('viewCart');

  if (!chance(rand, p.reachCheckout)) { say('leave', { reason: 'abandoned cart' }); return finish(); }

  say('checkout', { items: [{ product: chosen, quantity }], ...fulfil });

  if (!chance(rand, p.completeOrder)) { say('leave', { reason: 'abandoned checkout' }); return finish(); }

  say('placeOrder', { items: [{ product: chosen, quantity }], ...fulfil });
  if (signedIn && chance(rand, 0.3)) say('logout', { customer: shopper.customer });
  say('leave', { reason: 'ordered' });
  return finish();

  /** Walk a result list: maybe filter, maybe sort, then open some products. */
  function browseListing(candidates) {
    if (!candidates || !candidates.length) return;
    let pool = candidates;

    if (chance(rand, p.facetRate) && profile.facets.length) {
      const facet = pick(rand, profile.facets);
      const value = pick(rand, facet.values);
      const narrowed = pool.filter((x) => (x.attrs || {})[facet.name] === value);
      say('applyFacet', { name: facet.name, value, resultCount: narrowed.length });
      // A filter that empties the list is a real and interesting outcome, so
      // it is kept rather than retried — but the shopper backs it out.
      if (!narrowed.length) {
        say('removeFacet', { name: facet.name, value, resultCount: pool.length });
      } else {
        pool = narrowed;
      }
    }

    if (chance(rand, p.sortRate) && profile.sorts.length) {
      say('sort', { key: pick(rand, profile.sorts) });
    }

    const views = Math.min(between(rand, p.productsViewed), pool.length);
    const ranks = new Set();
    for (let i = 0; i < views; i++) {
      // Rank 1 is clicked far more often than rank 12. Squaring the roll
      // reproduces that without a lookup table, and it is what makes the
      // "which rank converts" report say something.
      const rank = 1 + Math.floor(Math.pow(rand(), 2) * pool.length);
      if (ranks.has(rank)) continue;
      ranks.add(rank);
      const product = pool[rank - 1];
      say('clickResult', { product, rank });
      say('viewProduct', { product, rank });
      seen.push(product);
    }
  }

  function finish() {
    return {
      persona: p.key,
      signedIn,
      anonymousId: shopper.anonymousId,
      customer: signedIn ? shopper.customer : undefined,
      startedAt: startedAt.toISOString(),
      steps
    };
  }
}

/**
 * A pool of shoppers.
 *
 * Fewer browsers than sessions, so "shoppers" is meaningfully smaller than
 * "sessions" and the returning-visitor numbers are not all 1:1 — which is the
 * giveaway that data was generated one session at a time.
 */
export function buildShopperPool({ rand, sessions, customers, returningRatio = 0.6, newId }) {
  const count = Math.max(1, Math.round(sessions * returningRatio));
  const pool = [];
  for (let i = 0; i < count; i++) {
    // Roughly a third of browsers belong to a known customer, so the same
    // person can appear signed in and anonymous across visits.
    const customer = customers.length && chance(rand, 0.34)
      ? customers[i % customers.length]
      : undefined;
    pool.push({ anonymousId: newId(), customer });
  }
  return pool;
}
