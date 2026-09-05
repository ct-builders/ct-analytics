/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Shopper archetypes.
 *
 * The funnel shape in the reports is an OUTCOME of the persona mix, not a
 * global dice roll applied to every session. That matters for both jobs this
 * tool does.
 *
 * For seeding a demonstration it is what makes the data survive being clicked into. A
 * uniform 40%-add-to-cart rule produces a tidy funnel and a Sessions report
 * full of identical-looking visits; open any one of them and it is obviously
 * synthetic. Real traffic is a mixture — most visitors never intended to buy,
 * a few arrived knowing the SKU — and mixtures are what make the session
 * journeys read like people.
 *
 * For checking tracking accuracy it gives coverage. A bouncer exercises the
 * single-page-view path, a researcher exercises deep browsing with filters,
 * a returning customer exercises identity across sessions.
 *
 * `weight` is relative frequency. Everything else is a probability applied at
 * that step, so the compounding is visible rather than hidden in one number.
 */

/** @typedef {{
 *   key: string,
 *   label: string,
 *   weight: number,
 *   signedIn: number,
 *   discovery: { search: number, category: number, direct: number },
 *   searchesPerSession: [number, number],
 *   zeroResultRate: number,
 *   facetRate: number,
 *   sortRate: number,
 *   productsViewed: [number, number],
 *   addToCart: number,
 *   removeFromCart: number,
 *   reachCheckout: number,
 *   completeOrder: number,
 *   multiUnitRate: number,
 *   secondLine: number
 * }} Persona */

/** @type {Persona[]} */
export const PERSONAS = [
  {
    key: 'bouncer',
    label: 'Lands and leaves',
    // The largest group on every real storefront, and the one synthetic data
    // usually omits — which is why synthetic conversion rates look wrong.
    weight: 30,
    signedIn: 0,
    discovery: { search: 0.15, category: 0.25, direct: 0.6 },
    searchesPerSession: [0, 1],
    zeroResultRate: 0.25,
    facetRate: 0,
    sortRate: 0,
    productsViewed: [0, 1],
    addToCart: 0,
    removeFromCart: 0,
    reachCheckout: 0,
    completeOrder: 0,
    multiUnitRate: 0,
    secondLine: 0
  },
  {
    key: 'browser',
    label: 'Window shopping',
    weight: 26,
    signedIn: 0.08,
    discovery: { search: 0.35, category: 0.55, direct: 0.1 },
    searchesPerSession: [1, 3],
    zeroResultRate: 0.18,
    facetRate: 0.35,
    sortRate: 0.2,
    productsViewed: [1, 4],
    addToCart: 0.12,
    removeFromCart: 0.4,
    reachCheckout: 0.1,
    completeOrder: 0.2,
    multiUnitRate: 0.1,
    secondLine: 0.25
  },
  {
    key: 'researcher',
    label: 'Comparing carefully',
    weight: 18,
    signedIn: 0.25,
    discovery: { search: 0.6, category: 0.35, direct: 0.05 },
    searchesPerSession: [2, 5],
    // Researchers ask for things by name, so they hit the edges of the
    // catalog more often than anyone else.
    zeroResultRate: 0.3,
    facetRate: 0.75,
    sortRate: 0.55,
    productsViewed: [3, 8],
    addToCart: 0.4,
    removeFromCart: 0.35,
    reachCheckout: 0.35,
    completeOrder: 0.45,
    multiUnitRate: 0.15,
    // Comparing carefully and then buying two of what was compared is the
    // most ordinary way a basket ends up with more than one line in it.
    secondLine: 0.45
  },
  {
    key: 'intent-buyer',
    label: 'Came to buy',
    weight: 14,
    signedIn: 0.45,
    discovery: { search: 0.7, category: 0.2, direct: 0.1 },
    searchesPerSession: [1, 2],
    zeroResultRate: 0.06,
    facetRate: 0.3,
    sortRate: 0.15,
    productsViewed: [1, 3],
    addToCart: 0.85,
    removeFromCart: 0.1,
    reachCheckout: 0.9,
    completeOrder: 0.8,
    multiUnitRate: 0.25,
    secondLine: 0.5
  },
  {
    key: 'returning-customer',
    label: 'Signed-in regular',
    weight: 12,
    // Always signed in: this persona is what makes the signed-in versus
    // anonymous split in the reports non-trivial, and what exercises
    // identity carrying across sessions.
    signedIn: 1,
    discovery: { search: 0.45, category: 0.45, direct: 0.1 },
    searchesPerSession: [1, 3],
    zeroResultRate: 0.1,
    facetRate: 0.4,
    sortRate: 0.25,
    productsViewed: [2, 5],
    addToCart: 0.6,
    removeFromCart: 0.2,
    reachCheckout: 0.7,
    completeOrder: 0.72,
    multiUnitRate: 0.35,
    // Knows the catalog, so carries the largest baskets on the site.
    secondLine: 0.6
  }
];

/** Pick a persona by weight. */
export function pickPersona(rand) {
  const total = PERSONAS.reduce((n, p) => n + p.weight, 0);
  let r = rand() * total;
  for (const p of PERSONAS) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return PERSONAS[PERSONAS.length - 1];
}

export function personaByKey(key) {
  return PERSONAS.find((p) => p.key === key);
}

/**
 * The funnel this mix implies, computed rather than asserted.
 *
 * Printed by `--dry-run` so the shape can be checked before generating
 * anything, so a run can be tuned to a target conversion rate without
 * running the tool twice.
 */
export function expectedFunnel(personas = PERSONAS) {
  const total = personas.reduce((n, p) => n + p.weight, 0);
  const acc = { discover: 0, product: 0, cart: 0, checkout: 0, order: 0 };
  for (const p of personas) {
    const share = p.weight / total;
    // A session "discovers" if it searched or browsed a category at all.
    const discovers = 1 - p.discovery.direct * (p.searchesPerSession[1] === 0 ? 1 : 0.35);
    const viewsProduct = p.productsViewed[1] > 0 ? Math.min(1, (p.productsViewed[0] + p.productsViewed[1]) / 2) : 0;
    const carts = viewsProduct > 0 ? p.addToCart : 0;
    const checkout = carts * p.reachCheckout;
    const order = checkout * p.completeOrder;
    acc.discover += share * discovers;
    acc.product += share * Math.min(1, viewsProduct);
    acc.cart += share * carts;
    acc.checkout += share * checkout;
    acc.order += share * order;
  }
  return acc;
}
