/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * The synth driver: an intent script straight to wire events.
 *
 * This is what seeds a dataset. Six weeks of plausible history in under a minute,
 * posted to the collector over HTTP with the ingest token — so it works
 * against a deployed collector from a laptop, with no database access.
 *
 * It reimplements one thing the browser client normally does, and only one:
 * discovery attribution. A search mints a discovery id, filters narrow it
 * without starting a new one, and a result click pins that context plus the
 * rank to the product. Getting this right here is what makes seeded data
 * indistinguishable from browser-driven data in the reports — and it is
 * verified against the real client by the tool's own tests, so the two cannot
 * drift silently.
 *
 * Timestamps come from the intent script, not from the clock, which is how a
 * session can be backdated six weeks and still read as one continuous visit.
 */

import { randomUUID } from 'node:crypto';

/** Milliseconds a shopper spends between steps, by step kind. */
const DWELL = {
  land: [1200, 4000],
  login: [4000, 12000],
  search: [2000, 9000],
  browseCategory: [2000, 9000],
  applyFacet: [1500, 6000],
  removeFacet: [1200, 4000],
  sort: [1000, 3500],
  clickResult: [400, 1500],
  viewProduct: [4000, 40000],
  addToCart: [1500, 6000],
  viewCart: [3000, 15000],
  removeFromCart: [2000, 6000],
  checkout: [8000, 40000],
  placeOrder: [3000, 10000],
  logout: [1000, 3000],
  leave: [0, 0]
};

/** The omnichannel dimensions a step carries, or nothing. */
function omni(step) {
  const out = {};
  if (step.fulfillment) out.fulfillment = step.fulfillment;
  if (step.location) out.location = { ...step.location };
  return out;
}

const money = (p, currency) =>
  p.priceCents === undefined ? undefined : { centAmount: p.priceCents, currencyCode: currency };

function productRef(p, currency) {
  const ref = { sku: p.sku };
  if (p.name) ref.name = p.name;
  if (p.categoryPath) ref.categoryPath = p.categoryPath;
  const price = money(p, currency);
  if (price) ref.price = price;
  return ref;
}

/**
 * Translate one session's intent script into wire events.
 *
 * @param {object} session  from behaviour.buildSession
 * @param {object} opts
 * @param {import('../lib/profile.js').Profile} opts.profile
 * @param {() => number} opts.rand
 * @returns {{ payload: object, summary: object }}
 */
export function synthesize(session, { profile, rand }) {
  const currency = profile.context?.currency || 'USD';
  const between = ([lo, hi]) => lo + Math.floor(rand() * (hi - lo + 1));

  let clock = Date.parse(session.startedAt);
  const events = [];
  const context = { ...(profile.context || {}) };

  /** Discovery state, mirroring the browser client's attribution. */
  let discovery = null;
  const pinned = new Map();

  const path = (key, vars) =>
    (profile.paths[key] || '/').replace(/\{(\w+)\}/g, (_, n) => String(vars?.[n] ?? ''));

  const snapshot = () => {
    if (!discovery) return { discoveryType: 'direct' };
    const out = { discoveryId: discovery.id, discoveryType: discovery.type };
    if (discovery.query) out.query = discovery.query;
    if (discovery.categoryPath) out.categoryPath = discovery.categoryPath;
    if (discovery.facets?.length) out.facets = discovery.facets.map((f) => ({ ...f }));
    return out;
  };

  const emit = (event, { attribution } = {}) => {
    events.push({
      ...event,
      ts: new Date(clock).toISOString(),
      ...(attribution ? { attribution } : {}),
      context: { ...context }
    });
  };

  const advance = (kind) => {
    clock += between(DWELL[kind] || [1000, 4000]);
  };

  for (const step of session.steps) {
    switch (step.t) {
      case 'land':
        emit({ type: 'page_view', pageType: 'home', path: path('home') });
        break;

      case 'login':
        context.customerId = step.customer.id;
        context.customerRef = step.customer.email;
        emit({ type: 'page_view', pageType: 'login', path: path('login') });
        emit({
          type: 'login',
          customerId: step.customer.id,
          customerRef: step.customer.email,
          method: 'password',
          path: path('login')
        });
        break;

      case 'logout':
        emit({ type: 'logout', customerId: context.customerId, customerRef: context.customerRef });
        delete context.customerId;
        delete context.customerRef;
        discovery = null;
        pinned.clear();
        break;

      case 'search': {
        const resultCount = step.expectZero ? 0 : (step.products?.length ?? 0);
        const p = path('search', { term: step.term });
        emit({ type: 'page_view', pageType: 'search', path: p });
        discovery = { id: randomUUID(), type: 'search', query: step.term, facets: [] };
        emit(
          { type: 'search', query: step.term, resultCount, path: p },
          { attribution: snapshot() }
        );
        break;
      }

      case 'browseCategory': {
        const p = path('category', { slug: step.slug });
        emit({ type: 'page_view', pageType: 'category', path: p });
        discovery = { id: randomUUID(), type: 'category', categoryPath: step.slug, facets: [] };
        emit(
          {
            type: 'category_view',
            categoryPath: step.slug,
            categoryName: step.name,
            resultCount: step.products?.length,
            path: p
          },
          { attribution: snapshot() }
        );
        break;
      }

      case 'applyFacet':
        if (discovery) discovery.facets = [...discovery.facets, { name: step.name, value: step.value }];
        emit(
          {
            type: 'facet_apply',
            facet: { name: step.name, value: step.value },
            facets: discovery ? discovery.facets : [],
            resultCount: step.resultCount
          },
          { attribution: snapshot() }
        );
        break;

      case 'removeFacet':
        if (discovery) {
          discovery.facets = discovery.facets.filter(
            (f) => !(f.name === step.name && f.value === step.value)
          );
        }
        emit(
          {
            type: 'facet_remove',
            facet: { name: step.name, value: step.value },
            facets: discovery ? discovery.facets : [],
            resultCount: step.resultCount
          },
          { attribution: snapshot() }
        );
        break;

      case 'sort':
        if (discovery) discovery.sort = step.key;
        emit({ type: 'sort_change', sort: step.key }, { attribution: snapshot() });
        break;

      case 'clickResult': {
        const attribution = { ...snapshot(), position: step.rank };
        pinned.set(step.product.sku, attribution);
        emit(
          { type: 'result_click', product: productRef(step.product, currency), position: step.rank },
          { attribution }
        );
        break;
      }

      case 'viewProduct': {
        const attribution = pinned.get(step.product.sku) ?? snapshot();
        if (!pinned.has(step.product.sku) && discovery) pinned.set(step.product.sku, attribution);
        const p = path('product', { slug: step.product.slug, sku: step.product.sku });
        emit({ type: 'page_view', pageType: 'product', path: p, title: step.product.name });
        emit({ type: 'product_view', product: productRef(step.product, currency), path: p }, { attribution });
        break;
      }

      case 'addToCart': {
        const attribution = pinned.get(step.product.sku) ?? snapshot();
        emit(
          {
            type: 'add_to_cart',
            product: productRef(step.product, currency),
            quantity: step.quantity,
            cartTotal: { centAmount: (step.product.priceCents ?? 0) * step.quantity, currencyCode: currency },
            ...omni(step)
          },
          { attribution }
        );
        break;
      }

      case 'removeFromCart':
        emit(
          {
            type: 'remove_from_cart',
            product: productRef(step.product, currency),
            quantity: step.quantity,
            cartTotal: { centAmount: 0, currencyCode: currency },
            ...omni(step)
          },
          { attribution: pinned.get(step.product.sku) ?? snapshot() }
        );
        break;

      case 'viewCart':
        emit({ type: 'cart_view', path: path('cart') });
        break;

      case 'checkout': {
        const total = step.items.reduce((n, i) => n + (i.product.priceCents ?? 0) * i.quantity, 0);
        const itemCount = step.items.reduce((n, i) => n + i.quantity, 0);
        emit({ type: 'page_view', pageType: 'checkout', path: path('checkout') });
        emit({
          type: 'checkout_start',
          cartTotal: { centAmount: total, currencyCode: currency },
          itemCount,
          path: path('checkout'),
          ...omni(step)
        });
        // A collection order skips the shipping step, which is the whole
        // reason the checkout funnel differs by fulfilment.
        if (!step.location) emit({ type: 'checkout_step', step: 'shipping', path: path('checkout') });
        else emit({ type: 'checkout_step', step: 'collection', path: path('checkout'), ...omni(step) });
        emit({ type: 'checkout_step', step: 'payment', path: path('checkout'), ...omni(step) });
        break;
      }

      case 'placeOrder': {
        const total = step.items.reduce((n, i) => n + (i.product.priceCents ?? 0) * i.quantity, 0);
        const itemCount = step.items.reduce((n, i) => n + i.quantity, 0);
        const orderId = randomUUID();
        const orderNumber = `A-${1000 + Math.floor(rand() * 9000)}`;
        emit(
          {
            type: 'order_submit',
            orderId,
            orderNumber,
            total: { centAmount: total, currencyCode: currency },
            itemCount,
            items: step.items.map((i) => ({
              product: productRef(i.product, currency),
              quantity: i.quantity,
              ...omni(step)
            })),
            ...omni(step)
          },
          { attribution: snapshot() }
        );
        emit({
          type: 'page_view',
          pageType: 'order_confirmation',
          path: path('orderConfirmation', { orderId })
        });
        break;
      }

      case 'leave':
        break;

      default:
        throw new Error(`synth driver does not know step "${step.t}"`);
    }
    advance(step.t);
  }

  return {
    payload: {
      site: profile.site,
      anonymousId: session.anonymousId,
      sessionId: randomUUID(),
      events
    },
    summary: {
      persona: session.persona,
      signedIn: session.signedIn,
      startedAt: session.startedAt,
      steps: session.steps.length,
      events: events.length
    }
  };
}

/**
 * Post one session's events to the collector.
 *
 * Split into batches of the collector's own maximum, and posted in order:
 * events within a session must arrive in sequence or the funnel reads wrong.
 */
export async function postSession(payload, { endpoint, ingestKey, userAgent, maxBatch = 50 }) {
  let accepted = 0;
  const rejected = [];

  for (let i = 0; i < payload.events.length; i += maxBatch) {
    const batch = { ...payload, events: payload.events.slice(i, i + maxBatch) };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ingestKey ? { Authorization: `Bearer ${ingestKey}` } : {}),
        'User-Agent': userAgent
      },
      body: JSON.stringify(batch)
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`collector returned ${res.status}: ${body.slice(0, 200)}`);
    }
    const body = await res.json();
    accepted += body.accepted ?? 0;
    if (body.rejected?.length) rejected.push(...body.rejected);
  }

  return { accepted, rejected };
}

/** User agents, so the device breakdown in the reports is not all desktop. */
export const USER_AGENTS = [
  { weight: 5, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { weight: 4, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' },
  { weight: 3, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' },
  { weight: 1, ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }
];

export function pickUserAgent(rand) {
  const total = USER_AGENTS.reduce((n, x) => n + x.weight, 0);
  let r = rand() * total;
  for (const x of USER_AGENTS) {
    r -= x.weight;
    if (r <= 0) return x.ua;
  }
  return USER_AGENTS[0].ua;
}
