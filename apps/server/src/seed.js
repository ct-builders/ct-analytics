/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Development seed.
 *
 * Generates plausible shopper journeys and pushes them through the real ingest
 * path, so the data exercises validation, the row mapper and every report —
 * rather than being inserted straight into the tables, which would let a
 * schema mistake survive.
 *
 * Deterministic: the same seed produces the same data, so a number in a report
 * can be checked by hand and stays checkable tomorrow.
 *
 *   npm run seed                    # 400 sessions over 30 days
 *   npm run seed -- --sessions 50 --days 7 --site example
 */

import { randomUUID } from 'node:crypto';
import { ingest } from './ingest.js';
import { closePool, query } from './db.js';
import { migrate } from './migrate.js';

/** Mulberry32 — a small deterministic PRNG. Seeded, so runs are repeatable. */
function rng(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATALOG = [
  { sku: 'SW-42', productKey: 'merino-crew', name: 'Merino Crew Sweater', categoryPath: 'mens/knitwear', price: 12900, color: 'blue', size: 'm' },
  { sku: 'SW-43', productKey: 'merino-vneck', name: 'Merino V-Neck', categoryPath: 'mens/knitwear', price: 11900, color: 'grey', size: 'l' },
  { sku: 'SH-11', productKey: 'oxford-shirt', name: 'Oxford Shirt', categoryPath: 'mens/shirts', price: 8900, color: 'white', size: 'm' },
  { sku: 'SH-12', productKey: 'flannel-shirt', name: 'Brushed Flannel Shirt', categoryPath: 'mens/shirts', price: 9500, color: 'red', size: 's' },
  { sku: 'TR-21', productKey: 'chino-slim', name: 'Slim Chinos', categoryPath: 'mens/trousers', price: 10500, color: 'navy', size: '32' },
  { sku: 'JK-31', productKey: 'quilted-jacket', name: 'Quilted Jacket', categoryPath: 'mens/outerwear', price: 24900, color: 'green', size: 'l' },
  { sku: 'JK-32', productKey: 'rain-shell', name: 'Lightweight Rain Shell', categoryPath: 'mens/outerwear', price: 19900, color: 'black', size: 'm' },
  { sku: 'AC-51', productKey: 'wool-scarf', name: 'Lambswool Scarf', categoryPath: 'accessories/scarves', price: 4900, color: 'grey', size: 'os' },
  { sku: 'AC-52', productKey: 'leather-belt', name: 'Leather Belt', categoryPath: 'accessories/belts', price: 5900, color: 'brown', size: '34' },
  { sku: 'SN-61', productKey: 'canvas-sneaker', name: 'Canvas Sneaker', categoryPath: 'shoes/sneakers', price: 7900, color: 'white', size: '9' }
];

/**
 * What a shopper reaches for alongside something else.
 *
 * Baskets are not random pairs. A second line picked uniformly from the
 * catalog would give every pair the same lift, and Bought together would then
 * be a popularity list dressed up as an affinity — the one thing that report
 * exists not to be. The accessories carry most of the attachments here, which
 * is also what a real apparel catalog does.
 */
const COMPANIONS = {
  'SW-42': ['AC-51', 'TR-21'],
  'SW-43': ['AC-51'],
  'SH-11': ['TR-21', 'AC-52'],
  'SH-12': ['TR-21'],
  'TR-21': ['AC-52', 'SN-61'],
  'JK-31': ['AC-51'],
  'JK-32': ['AC-51'],
  'SN-61': ['TR-21']
};

/** Terms that find something, weighted so a few dominate as in real traffic. */
const QUERIES = [
  'merino', 'merino', 'merino', 'sweater', 'sweater', 'shirt', 'shirt',
  'jacket', 'chinos', 'scarf', 'belt', 'sneakers', 'wool', 'flannel'
];

/** Terms the catalog cannot answer. The zero-result report exists for these. */
const MISSES = ['cashmere', 'linen suit', 'swim shorts', 'cufflinks', 'raincoat XXL', 'hiking boots'];

const CUSTOMERS = [
  'jen@example.com', 'sam@example.com', 'alex@example.com',
  'robin@example.com', 'casey@example.com'
];

const DEVICES = [
  { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', weight: 5 },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', weight: 4 },
  { ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', weight: 1 },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', weight: 3 }
];

const STORES = ['us-store', 'eu-store'];
const CHANNELS = ['web', 'app'];

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

function weighted(rand, list) {
  const total = list.reduce((n, x) => n + x.weight, 0);
  let r = rand() * total;
  for (const item of list) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return list[list.length - 1];
}

function money(centAmount) {
  return { centAmount, currencyCode: 'USD', fractionDigits: 2 };
}

/**
 * Build one session's events, with the attribution the browser client would
 * have attached. Synthesised here rather than imported, because the real
 * tracker needs a DOM — the end-to-end test drives the actual client instead.
 */
function buildSession(rand, startedAt) {
  const events = [];
  const store = pick(rand, STORES);
  const channel = pick(rand, CHANNELS);
  const context = { store, channel, locale: 'en-US', currency: 'USD' };
  let t = startedAt;

  const step = (ms) => {
    // Some dwell between events, so session durations vary realistically.
    t = new Date(t.getTime() + Math.floor(ms * (0.5 + rand())));
    return t.toISOString();
  };

  const push = (event) => events.push({ ...event, ts: step(9000), context: { ...context } });

  // A quarter of visits sign in early, which is what makes the signed-in
  // versus anonymous split in the reports non-trivial.
  const signsIn = rand() < 0.25;
  const customerRef = signsIn ? pick(rand, CUSTOMERS) : null;

  push({ type: 'page_view', pageType: 'home', path: '/', title: 'Home' });

  if (signsIn) {
    context.customerId = `c-${CUSTOMERS.indexOf(customerRef) + 1}`;
    context.customerRef = customerRef;
    push({ type: 'page_view', pageType: 'login', path: '/login' });
    push({
      type: 'login',
      customerId: context.customerId,
      customerRef,
      method: rand() < 0.3 ? 'one-click' : 'password',
      path: '/login'
    });
  }

  // Discovery: mostly search, sometimes a category browse.
  const viaSearch = rand() < 0.7;
  const discoveryId = randomUUID();
  let attribution;
  let candidates;

  if (viaSearch) {
    // One search in eight finds nothing, which is roughly what real catalogs
    // do and enough to make the zero-result report meaningful.
    const misses = rand() < 0.12;
    const q = misses ? pick(rand, MISSES) : pick(rand, QUERIES);
    candidates = misses ? [] : CATALOG.filter((p) => matches(p, q));
    if (!misses && !candidates.length) candidates = [pick(rand, CATALOG)];

    push({
      type: 'page_view',
      pageType: 'search',
      path: `/search?q=${encodeURIComponent(q)}`
    });
    push({
      type: 'search',
      query: q,
      resultCount: candidates.length,
      path: `/search?q=${encodeURIComponent(q)}`,
      attribution: { discoveryId, discoveryType: 'search', query: q }
    });
    attribution = { discoveryId, discoveryType: 'search', query: q };

    if (!candidates.length) {
      // A shopper who finds nothing usually leaves, which is the whole point
      // of the report.
      return { events, userAgent: weighted(rand, DEVICES).ua };
    }
  } else {
    const categoryPath = pick(rand, CATALOG).categoryPath;
    candidates = CATALOG.filter((p) => p.categoryPath === categoryPath);
    push({ type: 'page_view', pageType: 'category', path: `/category/${categoryPath}` });
    push({
      type: 'category_view',
      categoryPath,
      resultCount: candidates.length,
      path: `/category/${categoryPath}`,
      attribution: { discoveryId, discoveryType: 'category', categoryPath }
    });
    attribution = { discoveryId, discoveryType: 'category', categoryPath };
  }

  // Filters, on about half of listings.
  const facets = [];
  if (rand() < 0.5) {
    const target = pick(rand, candidates);
    const facet = rand() < 0.6
      ? { name: 'color', value: target.color }
      : { name: 'size', value: target.size };
    facets.push(facet);
    push({
      type: 'facet_apply',
      facet,
      facets: [...facets],
      resultCount: candidates.filter((p) => p[facet.name] === facet.value).length,
      attribution: { ...attribution, facets: [...facets] }
    });
    // Some shoppers narrow twice, some change their mind and remove one.
    if (rand() < 0.3) {
      push({
        type: 'facet_remove',
        facet,
        facets: [],
        attribution: { ...attribution, facets: [] }
      });
      facets.length = 0;
    }
  }
  if (rand() < 0.2) {
    push({ type: 'sort_change', sort: pick(rand, ['price-asc', 'price-desc', 'newest']), attribution });
  }

  const withFacets = facets.length ? { ...attribution, facets: [...facets] } : attribution;

  // The click through to a product, then the product page.
  const position = 1 + Math.floor(rand() * Math.min(candidates.length, 8));
  const chosen = candidates[Math.min(position - 1, candidates.length - 1)];
  const productAttr = { ...withFacets, position };
  const productRef = {
    sku: chosen.sku,
    productKey: chosen.productKey,
    name: chosen.name,
    categoryPath: chosen.categoryPath,
    price: money(chosen.price)
  };

  push({ type: 'result_click', product: productRef, position, attribution: productAttr });
  push({
    type: 'page_view',
    pageType: 'product',
    path: `/product/${chosen.productKey}`,
    title: chosen.name
  });
  push({ type: 'product_view', product: productRef, attribution: productAttr });

  // Roughly two in five product views become an add to cart.
  if (rand() > 0.42) {
    const quantity = rand() < 0.8 ? 1 : 2;
    push({
      type: 'add_to_cart',
      product: productRef,
      quantity,
      cartTotal: money(chosen.price * quantity),
      attribution: productAttr
    });

    // Some shoppers reconsider before checkout.
    if (rand() < 0.15) {
      push({
        type: 'remove_from_cart',
        product: productRef,
        quantity,
        cartTotal: money(0),
        attribution: productAttr
      });
      return { events, userAgent: weighted(rand, DEVICES).ua };
    }

    // A second line, found from the first product's page rather than from the
    // listing — which is where an accessory is actually picked up.
    const lines = [{ product: productRef, quantity }];
    const companions = COMPANIONS[chosen.sku];
    if (companions && rand() < 0.4) {
      const alsoSku = pick(rand, companions);
      const also = CATALOG.find((p) => p.sku === alsoSku);
      const alsoRef = {
        sku: also.sku,
        productKey: also.productKey,
        name: also.name,
        categoryPath: also.categoryPath,
        price: money(also.price)
      };
      const alsoAttr = { discoveryId: randomUUID(), discoveryType: 'recommendation' };
      push({
        type: 'page_view',
        pageType: 'product',
        path: `/product/${also.productKey}`,
        title: also.name
      });
      push({ type: 'product_view', product: alsoRef, attribution: alsoAttr });
      push({
        type: 'add_to_cart',
        product: alsoRef,
        quantity: 1,
        cartTotal: money(chosen.price * quantity + also.price),
        attribution: alsoAttr
      });
      lines.push({ product: alsoRef, quantity: 1 });
    }

    const cartTotal = lines.reduce((n, l) => n + l.product.price.centAmount * l.quantity, 0);
    const units = lines.reduce((n, l) => n + l.quantity, 0);

    push({ type: 'cart_view', cartTotal: money(cartTotal), itemCount: units, path: '/cart' });

    if (rand() > 0.35) {
      push({
        type: 'checkout_start',
        cartTotal: money(cartTotal),
        itemCount: units,
        path: '/checkout'
      });
      push({ type: 'checkout_step', step: 'shipping', path: '/checkout/shipping' });

      if (rand() > 0.25) {
        push({ type: 'checkout_step', step: 'payment', path: '/checkout/payment' });
        push({
          type: 'order_submit',
          orderId: randomUUID(),
          orderNumber: `A-${1000 + Math.floor(rand() * 9000)}`,
          total: money(cartTotal),
          itemCount: units,
          items: lines,
          path: '/order-confirmation',
          attribution: withFacets
        });
        push({ type: 'page_view', pageType: 'order_confirmation', path: '/order-confirmation' });

        if (signsIn && rand() < 0.4) {
          push({ type: 'logout', customerId: context.customerId, customerRef });
        }
      }
    }
  }

  return { events, userAgent: weighted(rand, DEVICES).ua };
}

/** Crude relevance, so a search's result count is not arbitrary. */
function matches(product, q) {
  const needle = q.toLowerCase();
  return (
    product.name.toLowerCase().includes(needle) ||
    product.productKey.includes(needle) ||
    product.categoryPath.includes(needle)
  );
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  await migrate({ silent: true });

  const slug = arg('site', 'example');
  const sessionCount = parseInt(arg('sessions', '400'), 10);
  const days = parseInt(arg('days', '30'), 10);
  const seed = parseInt(arg('seed', '20260904'), 10);
  const reset = process.argv.includes('--reset');

  await query(
    `INSERT INTO sites (slug, name) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`,
    [slug, slug === 'example' ? 'Example Storefront' : slug]
  );

  if (reset) {
    // ON DELETE CASCADE clears shoppers, sessions, events and order lines.
    await query('DELETE FROM shoppers WHERE site_id = (SELECT id FROM sites WHERE slug = $1)', [slug]);
    await query('DELETE FROM ingest_errors WHERE site_slug = $1', [slug]);
    console.log(`[clickstream] cleared existing data for ${slug}`);
  }

  const rand = rng(seed);
  const now = Date.now();
  // A pool of returning browsers, so "shoppers" is meaningfully smaller than
  // "sessions" and the returning-visitor numbers are not all 1:1.
  const browsers = Array.from({ length: Math.max(1, Math.floor(sessionCount * 0.6)) }, () => randomUUID());

  let accepted = 0;
  let rejected = 0;

  for (let i = 0; i < sessionCount; i++) {
    // Spread across the window, with more traffic recently.
    const ageDays = days * Math.pow(rand(), 1.6);
    const startedAt = new Date(now - ageDays * 86_400_000 - rand() * 3_600_000);

    const { events, userAgent } = buildSession(rand, startedAt);
    if (!events.length) continue;

    const payload = {
      site: slug,
      anonymousId: pick(rand, browsers),
      sessionId: randomUUID(),
      events
    };

    try {
      // Straight through the real ingest path, in batches of the same size the
      // browser client uses, so the multi-row insert is exercised too.
      for (let n = 0; n < payload.events.length; n += 50) {
        const result = await ingest(
          { ...payload, events: payload.events.slice(n, n + 50) },
          { userAgent, now: startedAt.getTime() }
        );
        accepted += result.accepted;
        rejected += result.rejected.length;
      }
    } catch (err) {
      console.error(`[clickstream] session ${i} failed: ${err.message}`);
      throw err;
    }

    if ((i + 1) % 100 === 0) console.log(`[clickstream] ${i + 1}/${sessionCount} sessions`);
  }

  const summary = await query(
    `SELECT
       (SELECT COUNT(*) FROM sessions WHERE site_id = s.id)    AS sessions,
       (SELECT COUNT(*) FROM shoppers WHERE site_id = s.id)    AS shoppers,
       (SELECT COUNT(*) FROM events   WHERE site_id = s.id)    AS events,
       (SELECT COUNT(*) FROM events   WHERE site_id = s.id AND type = 'order_submit') AS orders
     FROM sites s WHERE s.slug = $1`,
    [slug]
  );
  const t = summary.rows[0];
  console.log(
    `[clickstream] seeded ${slug}: ${t.sessions} sessions, ${t.shoppers} shoppers, ` +
      `${t.events} events, ${t.orders} orders (${accepted} accepted, ${rejected} rejected)`
  );
  if (rejected) console.warn('[clickstream] some events were rejected — see the Install health report');
}

try {
  await main();
} catch (err) {
  console.error(`[clickstream] seed failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
