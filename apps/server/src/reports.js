/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * The report catalog.
 *
 * Each report declares its columns and a `run(filters)`, and the admin renders
 * them generically — so adding a report means adding one entry here and
 * nothing else. Every query is parameterised; no filter value is ever
 * interpolated into SQL.
 *
 * All of them start from the same `scoped` CTE, which joins events to their
 * session and applies the shared segment filter. That is what makes "last 7
 * days, mobile, signed-in" mean the same thing on all thirteen.
 */

import { rows, one } from './db.js';
import { buildWhere } from './filters.js';
import {
  FUNNEL_STEPS,
  EVENT_LABELS,
  FULFILLMENT_LABELS,
  STORE_FULFILLMENTS
} from '../../../packages/shared/events.js';

/**
 * The common prefix: every event in the segment, with its session's
 * dimensions alongside.
 */
function scoped(f, startIndex = 1) {
  const { where, params, next } = buildWhere(f, { startIndex });
  return {
    cte: `
      scoped AS (
        SELECT e.*, s.customer_ref AS session_customer_ref, s.device, s.store,
               s.channel, s.locale, s.started_at AS session_started_at
          FROM events e
          JOIN sessions s ON s.id = e.session_id
        ${where}
      )`,
    params,
    next
  };
}

/** Column types the renderer understands. */
const T = {
  text: 'text',
  number: 'number',
  money: 'money',
  percent: 'percent',
  date: 'date',
  code: 'code'
};

/* ------------------------------------------------------------------ overview */

const overview = {
  key: 'overview',
  title: 'Overview',
  blurb: 'Headline numbers for the segment.',
  group: 'Summary',
  kind: 'stats',
  async run(f) {
    const s = scoped(f);
    const r = await one(
      `WITH ${s.cte}
       SELECT
         COUNT(DISTINCT session_id)                                            AS sessions,
         COUNT(DISTINCT shopper_id)                                            AS shoppers,
         COUNT(*)                                                              AS events,
         COUNT(*) FILTER (WHERE type = 'search')                               AS searches,
         COUNT(*) FILTER (WHERE type = 'search' AND result_count = 0)          AS zero_result_searches,
         COUNT(*) FILTER (WHERE type = 'category_view')                        AS category_views,
         COUNT(*) FILTER (WHERE type = 'facet_apply')                          AS filters_applied,
         COUNT(*) FILTER (WHERE type = 'product_view')                         AS product_views,
         COUNT(*) FILTER (WHERE type = 'add_to_cart')                          AS add_to_carts,
         COUNT(DISTINCT session_id) FILTER (WHERE type = 'order_submit')        AS converting_sessions,
         COUNT(*) FILTER (WHERE type = 'order_submit')                          AS orders,
         COALESCE(SUM(order_amount) FILTER (WHERE type = 'order_submit'), 0)    AS revenue,
         COUNT(*) FILTER (WHERE type = 'login')                                 AS logins,
         COUNT(*) FILTER (WHERE type = 'logout')                                AS logouts,
         COUNT(DISTINCT session_id) FILTER (WHERE session_customer_ref IS NOT NULL) AS signed_in_sessions,
         MODE() WITHIN GROUP (ORDER BY currency) FILTER (WHERE currency IS NOT NULL) AS currency
       FROM scoped`,
      s.params
    );

    const sessions = r?.sessions ?? 0;
    const orders = r?.orders ?? 0;
    const revenue = r?.revenue ?? 0;
    const currency = r?.currency ?? 'USD';

    return {
      currency,
      stats: [
        { label: 'Sessions', value: sessions, type: T.number },
        { label: 'Shoppers', value: r?.shoppers ?? 0, type: T.number },
        { label: 'Events', value: r?.events ?? 0, type: T.number },
        {
          label: 'Conversion',
          // Sessions that ordered over all sessions. Per session rather than
          // per shopper, because a shopper who returns and buys on the third
          // visit did not convert three times.
          value: sessions ? (r.converting_sessions / sessions) * 100 : 0,
          type: T.percent,
          hint: `${r?.converting_sessions ?? 0} of ${sessions} sessions ordered`
        },
        { label: 'Orders', value: orders, type: T.number },
        { label: 'Revenue', value: revenue, type: T.money, currency },
        {
          label: 'Average order',
          value: orders ? Math.round(revenue / orders) : 0,
          type: T.money,
          currency
        },
        { label: 'Searches', value: r?.searches ?? 0, type: T.number },
        {
          label: 'Zero-result searches',
          value: r?.zero_result_searches ?? 0,
          type: T.number,
          hint: 'Shoppers who asked for something the catalog did not answer'
        },
        { label: 'Category browses', value: r?.category_views ?? 0, type: T.number },
        { label: 'Filters applied', value: r?.filters_applied ?? 0, type: T.number },
        { label: 'Product views', value: r?.product_views ?? 0, type: T.number },
        { label: 'Add to carts', value: r?.add_to_carts ?? 0, type: T.number },
        {
          label: 'View to cart',
          value: r?.product_views ? (r.add_to_carts / r.product_views) * 100 : 0,
          type: T.percent
        },
        { label: 'Sign-ins', value: r?.logins ?? 0, type: T.number },
        {
          label: 'Signed-in sessions',
          value: sessions ? ((r?.signed_in_sessions ?? 0) / sessions) * 100 : 0,
          type: T.percent,
          hint: `${r?.signed_in_sessions ?? 0} of ${sessions}`
        }
      ]
    };
  }
};

/* -------------------------------------------------------------------- funnel */

const funnel = {
  key: 'funnel',
  title: 'Funnel',
  blurb: 'Sessions reaching each step, and where they stop.',
  group: 'Summary',
  kind: 'funnel',
  async run(f) {
    const s = scoped(f);
    // One counted column per step, built from the shared FUNNEL_STEPS so the
    // funnel is defined in exactly one place.
    const selects = FUNNEL_STEPS.map(
      (step) =>
        `COUNT(DISTINCT session_id) FILTER (WHERE type IN (${step.types
          .map((t) => `'${t}'`)
          .join(',')})) AS ${step.key}`
    ).join(',\n         ');

    const r = await one(
      `WITH ${s.cte}
       SELECT COUNT(DISTINCT session_id) AS all_sessions,
         ${selects}
       FROM scoped`,
      s.params
    );

    const total = r?.all_sessions ?? 0;
    let previous = null;
    const steps = FUNNEL_STEPS.map((step) => {
      const count = r?.[step.key] ?? 0;
      const row = {
        label: step.label,
        count,
        // Share of all sessions, so every row is comparable to the same base.
        ofTotal: total ? (count / total) * 100 : 0,
        // Share of the previous step, which is where the drop-off actually is.
        ofPrevious: previous === null ? 100 : previous ? (count / previous) * 100 : 0,
        dropped: previous === null ? 0 : Math.max(previous - count, 0)
      };
      previous = count;
      return row;
    });

    return { total, steps };
  }
};

/* ------------------------------------------------------------------ searches */

const searches = {
  key: 'searches',
  title: 'Searches',
  blurb: 'What shoppers typed, how many matches they got, and whether it led anywhere.',
  group: 'Discovery',
  columns: [
    { key: 'query', label: 'Query', type: T.text },
    { key: 'searches', label: 'Searches', type: T.number },
    { key: 'sessions', label: 'Sessions', type: T.number },
    { key: 'results', label: 'Results', type: T.number },
    { key: 'zero_results', label: 'Zero-result', type: T.number },
    { key: 'product_views', label: 'Products viewed', type: T.number },
    { key: 'add_to_carts', label: 'Added to cart', type: T.number },
    { key: 'cart_rate', label: 'Search to cart', type: T.percent }
  ],
  async run(f) {
    const s = scoped(f);
    const limitParam = s.next;
    return {
      rows: await rows(
        `WITH ${s.cte},
         searched AS (
           SELECT query, session_id, result_count FROM scoped
            WHERE type = 'search' AND query IS NOT NULL
         ),
         -- Outcomes are joined by the query recorded ON the later event, not
         -- by adjacency in the log. That is what the browser's discovery
         -- attribution is for.
         outcomes AS (
           SELECT source_query AS query,
                  COUNT(*) FILTER (WHERE type = 'product_view') AS product_views,
                  COUNT(*) FILTER (WHERE type = 'add_to_cart')  AS add_to_carts
             FROM scoped
            WHERE source_query IS NOT NULL
            GROUP BY source_query
         )
         SELECT sr.query,
                COUNT(*)                        AS searches,
                COUNT(DISTINCT sr.session_id)   AS sessions,
                MAX(sr.result_count)            AS results,
                COUNT(*) FILTER (WHERE sr.result_count = 0) AS zero_results,
                COALESCE(o.product_views, 0)    AS product_views,
                COALESCE(o.add_to_carts, 0)     AS add_to_carts,
                CASE WHEN COUNT(*) > 0
                     THEN (COALESCE(o.add_to_carts, 0)::numeric / COUNT(*)) * 100
                     ELSE 0 END                 AS cart_rate
           FROM searched sr
           LEFT JOIN outcomes o ON o.query = sr.query
          GROUP BY sr.query, o.product_views, o.add_to_carts
          ORDER BY searches DESC, sr.query
          LIMIT $${limitParam}`,
        [...s.params, f.limit]
      )
    };
  }
};

const zeroResults = {
  key: 'zero-results',
  title: 'Zero-result searches',
  blurb: 'Demand the catalog did not answer. The most directly actionable list here.',
  group: 'Discovery',
  columns: [
    { key: 'query', label: 'Query', type: T.text },
    { key: 'searches', label: 'Times searched', type: T.number },
    { key: 'sessions', label: 'Sessions', type: T.number },
    { key: 'shoppers', label: 'Shoppers', type: T.number },
    { key: 'last_seen', label: 'Last searched', type: T.date }
  ],
  async run(f) {
    const s = scoped(f);
    return {
      rows: await rows(
        `WITH ${s.cte}
         SELECT query,
                COUNT(*)                    AS searches,
                COUNT(DISTINCT session_id)  AS sessions,
                COUNT(DISTINCT shopper_id)  AS shoppers,
                MAX(ts)                     AS last_seen
           FROM scoped
          WHERE type = 'search' AND result_count = 0 AND query IS NOT NULL
          GROUP BY query
          ORDER BY searches DESC, last_seen DESC
          LIMIT $${s.next}`,
        [...s.params, f.limit]
      )
    };
  }
};

/* ------------------------------------------------------- search to product */

const searchToProduct = {
  key: 'search-to-product',
  title: 'Search to product',
  blurb: 'Which query led to which product — the question a plain event log cannot answer.',
  group: 'Discovery',
  columns: [
    { key: 'query', label: 'Query', type: T.text },
    { key: 'product', label: 'Product', type: T.text },
    { key: 'sku', label: 'SKU', type: T.code },
    { key: 'views', label: 'Views', type: T.number },
    { key: 'adds', label: 'Added', type: T.number },
    { key: 'best_position', label: 'Best rank', type: T.number },
    { key: 'filters', label: 'Filters used', type: T.text }
  ],
  async run(f) {
    const s = scoped(f);
    return {
      rows: await rows(
        `WITH ${s.cte}
         SELECT source_query AS query,
                COALESCE(product_name, product_key, sku, product_id) AS product,
                sku,
                COUNT(*) FILTER (WHERE type = 'product_view') AS views,
                COUNT(*) FILTER (WHERE type = 'add_to_cart')  AS adds,
                MIN(source_position)                          AS best_position,
                -- The filter set that was active when the product was
                -- clicked, flattened for display.
                (SELECT string_agg(DISTINCT fv.name || '=' || fv.value, ', ')
                   FROM scoped x,
                        jsonb_to_recordset(COALESCE(x.source_facets, '[]'::jsonb))
                          AS fv(name text, value text)
                  WHERE x.source_query = scoped.source_query
                    AND COALESCE(x.sku, x.product_key, x.product_id)
                        = COALESCE(scoped.sku, scoped.product_key, scoped.product_id)
                ) AS filters
           FROM scoped
          WHERE source_query IS NOT NULL
            AND type IN ('product_view', 'add_to_cart', 'result_click')
            AND COALESCE(sku, product_key, product_id) IS NOT NULL
          GROUP BY source_query, product, sku, product_key, product_id
          ORDER BY adds DESC, views DESC
          LIMIT $${s.next}`,
        [...s.params, f.limit]
      )
    };
  }
};

const revenueByDiscovery = {
  key: 'revenue-by-discovery',
  title: 'Revenue by discovery',
  blurb: 'Order revenue attributed to the search or category that first sold each line.',
  group: 'Discovery',
  columns: [
    { key: 'discovery', label: 'Found via', type: T.text },
    { key: 'discovery_type', label: 'Type', type: T.text },
    { key: 'orders', label: 'Orders', type: T.number },
    { key: 'units', label: 'Units', type: T.number },
    { key: 'revenue', label: 'Revenue', type: T.money }
  ],
  async run(f) {
    const s = scoped(f);
    const r = await rows(
      `WITH ${s.cte},
       -- Each order line, matched back to the add-to-cart that put it in the
       -- basket, so the line inherits how the shopper found it. LATERAL picks
       -- the most recent matching add before the order, which is correct when
       -- a shopper adds, removes and re-adds the same product.
       lines AS (
         SELECT oi.quantity,
                oi.unit_amount,
                oi.currency,
                oe.id AS order_event_id,
                atc.source_query,
                atc.source_category_path,
                atc.discovery_type
           FROM order_items oi
           JOIN scoped oe ON oe.id = oi.event_id
           LEFT JOIN LATERAL (
             SELECT a.source_query, a.source_category_path, a.discovery_type
               FROM events a
              WHERE a.session_id = oi.session_id
                AND a.type = 'add_to_cart'
                AND COALESCE(a.sku, a.product_key, a.product_id)
                    = COALESCE(oi.sku, oi.product_key, oi.product_id)
                AND a.ts <= oe.ts
              ORDER BY a.ts DESC
              LIMIT 1
           ) atc ON TRUE
       )
       SELECT COALESCE(source_query, source_category_path, 'Direct')      AS discovery,
              COALESCE(discovery_type, 'direct')                          AS discovery_type,
              COUNT(DISTINCT order_event_id)                              AS orders,
              SUM(quantity)                                               AS units,
              SUM(quantity * COALESCE(unit_amount, 0))                     AS revenue,
              MODE() WITHIN GROUP (ORDER BY currency)                      AS currency
         FROM lines
        GROUP BY discovery, discovery_type
        ORDER BY revenue DESC NULLS LAST
        LIMIT $${s.next}`,
      [...s.params, f.limit]
    );
    return { rows: r, currency: r.length ? r[0].currency : null };
  }
};

/* -------------------------------------------------------------------- facets */

const facets = {
  key: 'facets',
  title: 'Filters and facets',
  blurb: 'Which filters shoppers actually use, and which lead to a cart.',
  group: 'Discovery',
  columns: [
    { key: 'facet_name', label: 'Filter', type: T.text },
    { key: 'facet_value', label: 'Value', type: T.text },
    { key: 'applied', label: 'Applied', type: T.number },
    { key: 'removed', label: 'Removed', type: T.number },
    { key: 'sessions', label: 'Sessions', type: T.number },
    { key: 'led_to_cart', label: 'Led to cart', type: T.number }
  ],
  async run(f) {
    const s = scoped(f);
    return {
      rows: await rows(
        `WITH ${s.cte},
         clicks AS (
           SELECT facet_name, facet_value, type, session_id FROM scoped
            WHERE facet_name IS NOT NULL
         ),
         -- An add-to-cart counts for a filter when that filter was in the
         -- selection recorded on the add-to-cart's own attribution.
         carts AS (
           SELECT fv.name AS facet_name, fv.value AS facet_value, COUNT(*) AS led_to_cart
             FROM scoped,
                  jsonb_to_recordset(COALESCE(source_facets, '[]'::jsonb))
                    AS fv(name text, value text)
            WHERE type = 'add_to_cart'
            GROUP BY fv.name, fv.value
         )
         SELECT c.facet_name,
                c.facet_value,
                COUNT(*) FILTER (WHERE c.type = 'facet_apply')  AS applied,
                COUNT(*) FILTER (WHERE c.type = 'facet_remove') AS removed,
                COUNT(DISTINCT c.session_id)                    AS sessions,
                COALESCE(k.led_to_cart, 0)                      AS led_to_cart
           FROM clicks c
           LEFT JOIN carts k
                  ON k.facet_name = c.facet_name
                 AND k.facet_value = c.facet_value
          GROUP BY c.facet_name, c.facet_value, k.led_to_cart
          ORDER BY applied DESC, sessions DESC
          LIMIT $${s.next}`,
        [...s.params, f.limit]
      )
    };
  }
};

/* ---------------------------------------------------------------- categories */

const categories = {
  key: 'categories',
  title: 'Categories browsed',
  blurb: 'Where shoppers browse, and how well each category converts.',
  group: 'Discovery',
  columns: [
    { key: 'category_path', label: 'Category', type: T.text },
    { key: 'views', label: 'Browses', type: T.number },
    { key: 'sessions', label: 'Sessions', type: T.number },
    { key: 'product_views', label: 'Products viewed', type: T.number },
    { key: 'add_to_carts', label: 'Added to cart', type: T.number },
    { key: 'cart_rate', label: 'Browse to cart', type: T.percent }
  ],
  async run(f) {
    const s = scoped(f);
    return {
      rows: await rows(
        `WITH ${s.cte},
         browsed AS (
           SELECT category_path, session_id FROM scoped
            WHERE type = 'category_view' AND category_path IS NOT NULL
         ),
         outcomes AS (
           SELECT source_category_path AS category_path,
                  COUNT(*) FILTER (WHERE type = 'product_view') AS product_views,
                  COUNT(*) FILTER (WHERE type = 'add_to_cart')  AS add_to_carts
             FROM scoped
            WHERE source_category_path IS NOT NULL
            GROUP BY source_category_path
         )
         SELECT b.category_path,
                COUNT(*)                      AS views,
                COUNT(DISTINCT b.session_id)  AS sessions,
                COALESCE(o.product_views, 0)  AS product_views,
                COALESCE(o.add_to_carts, 0)   AS add_to_carts,
                CASE WHEN COUNT(*) > 0
                     THEN (COALESCE(o.add_to_carts, 0)::numeric / COUNT(*)) * 100
                     ELSE 0 END               AS cart_rate
           FROM browsed b
           LEFT JOIN outcomes o ON o.category_path = b.category_path
          GROUP BY b.category_path, o.product_views, o.add_to_carts
          ORDER BY views DESC
          LIMIT $${s.next}`,
        [...s.params, f.limit]
      )
    };
  }
};

/* ------------------------------------------------------------------ products */

const products = {
  key: 'products',
  title: 'Products',
  blurb: 'Views, adds and orders per product, with the view-to-cart rate.',
  group: 'Products',
  columns: [
    { key: 'product', label: 'Product', type: T.text },
    { key: 'sku', label: 'SKU', type: T.code },
    { key: 'views', label: 'Views', type: T.number },
    { key: 'adds', label: 'Added', type: T.number },
    { key: 'removes', label: 'Removed', type: T.number },
    { key: 'cart_rate', label: 'View to cart', type: T.percent },
    { key: 'ordered_units', label: 'Units ordered', type: T.number },
    { key: 'revenue', label: 'Revenue', type: T.money }
  ],
  async run(f) {
    const s = scoped(f);
    const r = await rows(
      `WITH ${s.cte},
       activity AS (
         SELECT COALESCE(sku, product_key, product_id)              AS identity,
                MAX(COALESCE(product_name, product_key, sku))       AS product,
                MAX(sku)                                            AS sku,
                COUNT(*) FILTER (WHERE type = 'product_view')       AS views,
                COUNT(*) FILTER (WHERE type = 'add_to_cart')        AS adds,
                COUNT(*) FILTER (WHERE type = 'remove_from_cart')   AS removes
           FROM scoped
          WHERE COALESCE(sku, product_key, product_id) IS NOT NULL
          GROUP BY identity
       ),
       sold AS (
         SELECT COALESCE(oi.sku, oi.product_key, oi.product_id)  AS identity,
                SUM(oi.quantity)                                 AS ordered_units,
                SUM(oi.quantity * COALESCE(oi.unit_amount, 0))   AS revenue,
                MODE() WITHIN GROUP (ORDER BY oi.currency)       AS currency
           FROM order_items oi
           JOIN scoped oe ON oe.id = oi.event_id
          GROUP BY identity
       )
       SELECT a.product, a.sku, a.views, a.adds, a.removes,
              CASE WHEN a.views > 0
                   THEN (a.adds::numeric / a.views) * 100
                   ELSE NULL END               AS cart_rate,
              COALESCE(s2.ordered_units, 0)     AS ordered_units,
              COALESCE(s2.revenue, 0)           AS revenue,
              s2.currency
         FROM activity a
         LEFT JOIN sold s2 ON s2.identity = a.identity
        ORDER BY a.views DESC, a.adds DESC
        LIMIT $${s.next}`,
      [...s.params, f.limit]
    );
    return { rows: r, currency: r.find((x) => x.currency)?.currency ?? null };
  }
};

/* -------------------------------------------------------- omnichannel */


const fulfillmentMix = {
  key: 'fulfillment',
  title: 'Fulfilment mix',
  blurb: 'How shoppers chose to receive their orders, and what each choice is worth.',
  group: 'Omnichannel',
  columns: [
    { key: 'label', label: 'Fulfilment', type: T.text },
    { key: 'carts', label: 'Chosen at cart', type: T.number },
    { key: 'checkouts', label: 'Reached checkout', type: T.number },
    { key: 'orders', label: 'Orders', type: T.number },
    { key: 'units', label: 'Units', type: T.number },
    { key: 'revenue', label: 'Revenue', type: T.money },
    { key: 'share_of_revenue', label: 'Share of revenue', type: T.percent },
    { key: 'cart_to_order', label: 'Cart to order', type: T.percent }
  ],
  async run(f) {
    const s = scoped(f);
    const r = await rows(
      `WITH ${s.cte},
       chosen AS (
         SELECT fulfillment,
                COUNT(*) FILTER (WHERE type = 'add_to_cart')     AS carts,
                COUNT(*) FILTER (WHERE type = 'checkout_start')  AS checkouts,
                COUNT(*) FILTER (WHERE type = 'order_submit')    AS orders
           FROM scoped
          WHERE fulfillment IS NOT NULL
          GROUP BY fulfillment
       ),
       -- Revenue comes from the order LINES, not the order total: a mixed
       -- basket can ship one line and hold another for collection, and
       -- crediting the whole order to one method would overstate whichever
       -- the shopper happened to pick last.
       sold AS (
         SELECT COALESCE(oi.fulfillment, 'delivery') AS fulfillment,
                SUM(oi.quantity)                              AS units,
                SUM(oi.quantity * COALESCE(oi.unit_amount, 0)) AS revenue,
                MODE() WITHIN GROUP (ORDER BY oi.currency)     AS currency
           FROM order_items oi
           JOIN scoped oe ON oe.id = oi.event_id
          GROUP BY 1
       )
       SELECT COALESCE(c.fulfillment, s2.fulfillment)  AS fulfillment,
              COALESCE(c.carts, 0)                     AS carts,
              COALESCE(c.checkouts, 0)                 AS checkouts,
              COALESCE(c.orders, 0)                    AS orders,
              COALESCE(s2.units, 0)                    AS units,
              COALESCE(s2.revenue, 0)                  AS revenue,
              s2.currency,
              CASE WHEN COALESCE(c.carts, 0) > 0
                   THEN (COALESCE(c.orders, 0)::numeric / c.carts) * 100
                   ELSE NULL END                       AS cart_to_order
         FROM chosen c
         FULL OUTER JOIN sold s2 ON s2.fulfillment = c.fulfillment
        ORDER BY revenue DESC NULLS LAST`,
      s.params
    );

    const totalRevenue = r.reduce((n, row) => n + Number(row.revenue || 0), 0);
    const storeRevenue = r
      .filter((row) => STORE_FULFILLMENTS.includes(row.fulfillment))
      .reduce((n, row) => n + Number(row.revenue || 0), 0);

    return {
      rows: r.map((row) => ({
        ...row,
        label: FULFILLMENT_LABELS[row.fulfillment] ?? row.fulfillment,
        share_of_revenue: totalRevenue ? (Number(row.revenue || 0) / totalRevenue) * 100 : null
      })),
      currency: r.find((x) => x.currency)?.currency ?? null,
      note:
        totalRevenue > 0
          ? `The store network carried ${((storeRevenue / totalRevenue) * 100).toFixed(1)}% of revenue ` +
            'in this segment — pick-up, curbside, reserve and ship-from-store combined.'
          : 'No revenue in this segment yet.'
    };
  }
};

const storePerformance = {
  key: 'stores',
  title: 'Store performance',
  blurb: 'Every location the online channel sent business to, and how much.',
  group: 'Omnichannel',
  columns: [
    { key: 'location', label: 'Store', type: T.text },
    { key: 'location_key', label: 'Key', type: T.code },
    { key: 'carts', label: 'Chosen at cart', type: T.number },
    { key: 'orders', label: 'Orders', type: T.number },
    { key: 'units', label: 'Units', type: T.number },
    { key: 'revenue', label: 'Revenue', type: T.money },
    { key: 'methods', label: 'Methods used', type: T.text },
    { key: 'shoppers', label: 'Shoppers', type: T.number },
    { key: 'last_order', label: 'Last order', type: T.date }
  ],
  async run(f) {
    const s = scoped(f);
    const r = await rows(
      `WITH ${s.cte},
       touched AS (
         SELECT location_key,
                MAX(COALESCE(location_name, location_key))       AS location,
                COUNT(*) FILTER (WHERE type = 'add_to_cart')     AS carts,
                COUNT(*) FILTER (WHERE type = 'order_submit')    AS orders,
                COUNT(DISTINCT shopper_id)                       AS shoppers,
                string_agg(DISTINCT fulfillment, ', ')            AS methods,
                MAX(ts) FILTER (WHERE type = 'order_submit')      AS last_order
           FROM scoped
          WHERE location_key IS NOT NULL
          GROUP BY location_key
       ),
       sold AS (
         SELECT oi.location_key,
                SUM(oi.quantity)                               AS units,
                SUM(oi.quantity * COALESCE(oi.unit_amount, 0))  AS revenue,
                MODE() WITHIN GROUP (ORDER BY oi.currency)      AS currency
           FROM order_items oi
           JOIN scoped oe ON oe.id = oi.event_id
          WHERE oi.location_key IS NOT NULL
          GROUP BY oi.location_key
       )
       SELECT t.location_key, t.location, t.carts, t.orders, t.shoppers,
              t.methods, t.last_order,
              COALESCE(s2.units, 0)   AS units,
              COALESCE(s2.revenue, 0) AS revenue,
              s2.currency
         FROM touched t
         LEFT JOIN sold s2 ON s2.location_key = t.location_key
        ORDER BY revenue DESC, t.carts DESC
        LIMIT $${s.next}`,
      [...s.params, f.limit]
    );
    return {
      rows: r,
      currency: r.find((x) => x.currency)?.currency ?? null,
      note:
        'Aggregate across all locations is the Fulfilment mix report; this is the same ' +
        'business split by where it landed.'
    };
  }
};

/* -------------------------------------------------------------------- orders */

const orders = {
  key: 'orders',
  title: 'Orders',
  blurb: 'Every order, with the shopper and how they found what they bought.',
  group: 'Orders',
  columns: [
    { key: 'ts', label: 'When', type: T.date },
    { key: 'order_number', label: 'Order', type: T.text },
    { key: 'customer_ref', label: 'Shopper', type: T.text },
    { key: 'items', label: 'Lines', type: T.number },
    { key: 'order_amount', label: 'Total', type: T.money },
    { key: 'discovery', label: 'Found via', type: T.text },
    { key: 'device', label: 'Device', type: T.text },
    { key: 'session_id', label: 'Session', type: T.number }
  ],
  async run(f) {
    const s = scoped(f);
    const r = await rows(
      `WITH ${s.cte}
       SELECT ts,
              COALESCE(order_number, order_id, '—')                  AS order_number,
              COALESCE(customer_ref, session_customer_ref, 'anonymous') AS customer_ref,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.event_id = scoped.id) AS items,
              order_amount,
              currency,
              COALESCE(source_query, source_category_path, 'Direct') AS discovery,
              device,
              session_id
         FROM scoped
        WHERE type = 'order_submit'
        ORDER BY ts DESC
        LIMIT $${s.next}`,
      [...s.params, f.limit]
    );
    return { rows: r, currency: r.find((x) => x.currency)?.currency ?? null };
  }
};

/* --------------------------------------------------------------------- pages */

const pages = {
  key: 'pages',
  title: 'Pages',
  blurb: 'Traffic by page type and path.',
  group: 'Traffic',
  columns: [
    { key: 'page_type', label: 'Page type', type: T.text },
    { key: 'path', label: 'Path', type: T.text },
    { key: 'views', label: 'Views', type: T.number },
    { key: 'sessions', label: 'Sessions', type: T.number },
    { key: 'shoppers', label: 'Shoppers', type: T.number }
  ],
  async run(f) {
    const s = scoped(f);
    return {
      rows: await rows(
        `WITH ${s.cte}
         SELECT COALESCE(page_type, 'other')  AS page_type,
                COALESCE(path, '—')           AS path,
                COUNT(*)                      AS views,
                COUNT(DISTINCT session_id)    AS sessions,
                COUNT(DISTINCT shopper_id)    AS shoppers
           FROM scoped
          WHERE type = 'page_view'
          GROUP BY page_type, path
          ORDER BY views DESC
          LIMIT $${s.next}`,
        [...s.params, f.limit]
      )
    };
  }
};

/* --------------------------------------------------------------- identity */

const logins = {
  key: 'logins',
  title: 'Sign-ins',
  blurb: 'Sign-in and sign-out activity by registered shoppers.',
  group: 'Shoppers',
  columns: [
    { key: 'customer_ref', label: 'Shopper', type: T.text },
    { key: 'logins', label: 'Sign-ins', type: T.number },
    { key: 'logouts', label: 'Sign-outs', type: T.number },
    { key: 'methods', label: 'Methods', type: T.text },
    { key: 'sessions', label: 'Sessions', type: T.number },
    { key: 'orders', label: 'Orders', type: T.number },
    { key: 'revenue', label: 'Revenue', type: T.money },
    { key: 'last_seen', label: 'Last seen', type: T.date }
  ],
  async run(f) {
    const s = scoped(f);
    const r = await rows(
      `WITH ${s.cte},
       -- Grouped by the identity on the session rather than on the event, so
       -- a shopper's anonymous browsing before they signed in is counted with
       -- the rest of that visit.
       identified AS (
         SELECT COALESCE(customer_ref, session_customer_ref) AS shopper, *
           FROM scoped
          WHERE COALESCE(customer_ref, session_customer_ref) IS NOT NULL
       )
       SELECT shopper                                        AS customer_ref,
              COUNT(*) FILTER (WHERE type = 'login')         AS logins,
              COUNT(*) FILTER (WHERE type = 'logout')        AS logouts,
              string_agg(DISTINCT login_method, ', ')        AS methods,
              COUNT(DISTINCT session_id)                     AS sessions,
              COUNT(*) FILTER (WHERE type = 'order_submit')  AS orders,
              COALESCE(SUM(order_amount) FILTER (WHERE type = 'order_submit'), 0) AS revenue,
              MODE() WITHIN GROUP (ORDER BY currency)         AS currency,
              MAX(ts)                                        AS last_seen
         FROM identified
        GROUP BY shopper
        ORDER BY last_seen DESC
        LIMIT $${s.next}`,
      [...s.params, f.limit]
    );
    return { rows: r, currency: r.find((x) => x.currency)?.currency ?? null };
  }
};

const sessions = {
  key: 'sessions',
  title: 'Sessions',
  blurb: 'Every visit in the segment. Open one to read the shopper’s whole journey.',
  group: 'Shoppers',
  columns: [
    { key: 'started_at', label: 'Started', type: T.date },
    { key: 'customer_ref', label: 'Shopper', type: T.text },
    { key: 'events', label: 'Events', type: T.number },
    { key: 'searches', label: 'Searches', type: T.number },
    { key: 'products', label: 'Products', type: T.number },
    { key: 'adds', label: 'Added', type: T.number },
    { key: 'ordered', label: 'Ordered', type: T.number },
    { key: 'revenue', label: 'Revenue', type: T.money },
    { key: 'device', label: 'Device', type: T.text },
    { key: 'duration_s', label: 'Duration', type: T.number },
    { key: 'session_id', label: 'Journey', type: 'journey-link' }
  ],
  async run(f) {
    const s = scoped(f);
    const r = await rows(
      `WITH ${s.cte}
       SELECT session_id,
              MIN(session_started_at)                        AS started_at,
              COALESCE(MAX(session_customer_ref), 'anonymous') AS customer_ref,
              COUNT(*)                                       AS events,
              COUNT(*) FILTER (WHERE type = 'search')        AS searches,
              COUNT(*) FILTER (WHERE type = 'product_view')  AS products,
              COUNT(*) FILTER (WHERE type = 'add_to_cart')   AS adds,
              COUNT(*) FILTER (WHERE type = 'order_submit')  AS ordered,
              COALESCE(SUM(order_amount) FILTER (WHERE type = 'order_submit'), 0) AS revenue,
              MAX(device)                                    AS device,
              MODE() WITHIN GROUP (ORDER BY currency)         AS currency,
              EXTRACT(EPOCH FROM (MAX(ts) - MIN(ts)))::int    AS duration_s
         FROM scoped
        GROUP BY session_id
        ORDER BY started_at DESC
        LIMIT $${s.next}`,
      [...s.params, f.limit]
    );
    return { rows: r, currency: r.find((x) => x.currency)?.currency ?? null };
  }
};

/**
 * One session's complete ordered event trail — the journey the whole system is
 * named for. Not filtered by the segment: once you are looking at a single
 * visit, hiding part of it would be actively misleading.
 */
const journey = {
  key: 'journey',
  title: 'Session journey',
  blurb: 'Every event in one visit, in order.',
  group: 'Shoppers',
  hidden: true,
  columns: [
    { key: 'ts', label: 'When', type: T.date },
    { key: 'label', label: 'Event', type: T.text },
    { key: 'detail', label: 'Detail', type: T.text },
    { key: 'discovery', label: 'Found via', type: T.text }
  ],
  async run(f, extra = {}) {
    const sessionId = parseInt(extra.sessionId, 10);
    if (!Number.isFinite(sessionId)) return { rows: [], meta: null };

    const meta = await one(
      `SELECT s.id, s.session_key, s.started_at, s.last_event_at, s.device, s.store,
              s.channel, s.locale, s.currency, s.customer_ref, s.landing_path,
              s.referrer, sh.anonymous_id, si.slug AS site
         FROM sessions s
         JOIN shoppers sh ON sh.id = s.shopper_id
         JOIN sites si ON si.id = s.site_id
        WHERE s.id = $1`,
      [sessionId]
    );

    const r = await rows(
      `SELECT ts, type, path, page_type, query, result_count, category_path,
              facet_name, facet_value, sort, position, product_name, sku,
              quantity, unit_amount, cart_amount, item_count, step,
              order_number, order_amount, currency, customer_ref, login_method,
              source_query, source_category_path, discovery_type, source_position
         FROM events
        WHERE session_id = $1
        ORDER BY ts, seq, id`,
      [sessionId]
    );

    return {
      meta,
      rows: r.map((e) => ({
        ts: e.ts,
        label: EVENT_LABELS[e.type] ?? e.type,
        detail: detailFor(e),
        discovery: e.source_query || e.source_category_path || e.discovery_type || ''
      }))
    };
  }
};

/** A one-line human summary of an event, for the journey trail. */
function detailFor(e) {
  switch (e.type) {
    case 'page_view':
      return `${e.page_type ?? 'other'} — ${e.path ?? ''}`;
    case 'search':
      return e.result_count === null
        ? `“${e.query}”`
        : `“${e.query}” — ${e.result_count} result${e.result_count === 1 ? '' : 's'}`;
    case 'category_view':
      return e.category_path ?? '';
    case 'facet_apply':
    case 'facet_remove':
      return `${e.facet_name} = ${e.facet_value ?? ''}`;
    case 'sort_change':
      return e.sort ?? '';
    case 'result_click':
      return `${e.product_name ?? e.sku ?? ''} at rank ${e.position ?? '?'}`;
    case 'product_view':
      return e.product_name ?? e.sku ?? '';
    case 'add_to_cart':
    case 'remove_from_cart':
      return `${e.quantity ?? 1} × ${e.product_name ?? e.sku ?? ''}`;
    case 'cart_view':
      return e.item_count === null ? '' : `${e.item_count} item(s)`;
    case 'checkout_start':
      return e.item_count === null ? '' : `${e.item_count} item(s)`;
    case 'checkout_step':
      return e.step ?? '';
    case 'order_submit':
      return `${e.order_number ?? ''}`;
    case 'login':
      return `${e.customer_ref ?? ''}${e.login_method ? ` (${e.login_method})` : ''}`;
    case 'logout':
      return e.customer_ref ?? '';
    default:
      return '';
  }
}

/* ------------------------------------------------------------------ install */

const installHealth = {
  key: 'install-health',
  title: 'Install health',
  blurb: 'Events the collector refused, so a broken install is visible rather than silent.',
  group: 'Diagnostics',
  columns: [
    { key: 'ts', label: 'When', type: T.date },
    { key: 'site_slug', label: 'Site', type: T.text },
    { key: 'event_type', label: 'Event', type: T.text },
    { key: 'reason', label: 'Why it was refused', type: T.text }
  ],
  async run(f) {
    // Deliberately not segment-filtered: a rejected event never became a row,
    // so it has no session to filter by.
    const params = [];
    let where = '';
    if (f.site) {
      where = 'WHERE site_slug = $1';
      params.push(f.site);
    }
    return {
      rows: await rows(
        `SELECT ts, site_slug, event_type, reason
           FROM ingest_errors
          ${where}
          ORDER BY ts DESC
          LIMIT $${params.length + 1}`,
        [...params, f.limit]
      ),
      note: 'Not affected by the date or segment filters — a refused event has no session.'
    };
  }
};

export const REPORTS = [
  overview,
  funnel,
  searches,
  zeroResults,
  searchToProduct,
  revenueByDiscovery,
  facets,
  categories,
  products,
  fulfillmentMix,
  storePerformance,
  orders,
  pages,
  logins,
  sessions,
  journey,
  installHealth
];

export function reportByKey(key) {
  return REPORTS.find((r) => r.key === key);
}

/** Distinct values for the segment dropdowns. */
export async function filterOptions() {
  const [siteRows, storeRows, channelRows] = await Promise.all([
    rows('SELECT slug, name FROM sites WHERE active ORDER BY name'),
    rows("SELECT DISTINCT store FROM sessions WHERE store IS NOT NULL ORDER BY store LIMIT 100"),
    rows("SELECT DISTINCT channel FROM sessions WHERE channel IS NOT NULL ORDER BY channel LIMIT 100")
  ]);
  return {
    sites: siteRows,
    stores: storeRows.map((r) => r.store),
    channels: channelRows.map((r) => r.channel)
  };
}
