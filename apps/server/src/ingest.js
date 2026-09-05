/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Ingest: validated events onto typed rows.
 *
 * One batch is one transaction. A batch that inserted its session and then
 * failed on an event would otherwise leave a session row with nothing in it,
 * which reads in every report as a visit where the shopper did nothing.
 */

import { validatePayload, str, int, num, isObject } from '../../../packages/shared/wire.js';
import { transaction, query } from './db.js';
import { config } from './config.js';
import { HttpError } from './http.js';

/**
 * Device class from the user agent.
 *
 * Deliberately crude — three buckets, matched on the few tokens that have
 * been stable for a decade. Anything finer is a losing battle against a
 * string vendors change at will, and "which device class converts worse" is
 * the only question this column exists to answer.
 */
export function deviceFrom(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  if (!ua) return null;
  if (/ipad|tablet|playbook|silk|kindle/.test(ua)) return 'tablet';
  // `mobi` catches Mobile Safari, Chrome Mobile and Firefox Mobile; Android
  // without it is a tablet.
  if (/mobi|iphone|ipod|windows phone/.test(ua)) return 'mobile';
  if (/android/.test(ua)) return 'tablet';
  return 'desktop';
}

/** Money helper: minor units and currency, or nulls. */
function money(m) {
  if (!isObject(m)) return { amount: null, currency: null };
  const amount = num(m.centAmount);
  return {
    amount: amount === undefined ? null : Math.round(amount),
    currency: str(m.currencyCode) ?? null
  };
}

function product(p) {
  if (!isObject(p)) return {};
  return {
    product_id: str(p.productId) ?? null,
    product_key: str(p.productKey) ?? null,
    sku: str(p.sku) ?? null,
    product_name: str(p.name) ?? null,
    category_path: str(p.categoryPath) ?? null
  };
}

/** Facet selections, normalised and length-capped. */
function facets(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const f of list.slice(0, 50)) {
    if (!isObject(f)) continue;
    const name = str(f.name);
    if (!name) continue;
    out.push({ name, value: str(f.value) ?? '' });
  }
  return out.length ? JSON.stringify(out) : null;
}

/** The 44 event columns, in the order the INSERT uses them. */
const COLUMNS = [
  'site_id', 'session_id', 'shopper_id', 'type', 'ts', 'seq',
  'path', 'page_type', 'title', 'referrer',
  'query', 'result_count', 'category_path', 'category_id', 'sort',
  'facet_name', 'facet_value', 'facets', 'position',
  'product_id', 'product_key', 'sku', 'product_name',
  'unit_amount', 'currency', 'quantity', 'cart_amount', 'item_count',
  'step', 'order_id', 'order_number', 'order_amount',
  'customer_id', 'customer_ref', 'login_method',
  'discovery_id', 'discovery_type', 'source_query', 'source_category_path',
  'source_position', 'source_facets', 'props'
];

/**
 * Map one validated event to a row.
 *
 * Every branch writes the same column set, so a new event type cannot
 * accidentally shift the positional parameters of the INSERT.
 */
export function toRow(event, ctx) {
  const a = isObject(event.attribution) ? event.attribution : {};
  const c = isObject(event.context) ? event.context : {};
  const cart = money(event.cartTotal);
  const total = money(event.total);
  const prod = product(event.product);
  const unit = money(event.product && event.product.price);

  const row = {
    site_id: ctx.siteId,
    session_id: ctx.sessionId,
    shopper_id: ctx.shopperId,
    type: event.type,
    ts: new Date(Date.parse(event.ts)),
    seq: ctx.seq,

    path: str(event.path) ?? null,
    page_type: str(event.pageType) ?? null,
    title: str(event.title) ?? null,
    referrer: str(event.referrer) ?? null,

    query: str(event.query) ?? null,
    result_count: int(event.resultCount) ?? null,
    category_path: str(event.categoryPath) ?? prod.category_path ?? null,
    category_id: str(event.categoryId) ?? null,
    sort: str(event.sort) ?? null,

    facet_name: isObject(event.facet) ? str(event.facet.name) ?? null : null,
    facet_value: isObject(event.facet) ? str(event.facet.value) ?? null : null,
    facets: facets(event.facets),
    position: int(event.position) ?? null,

    product_id: prod.product_id ?? null,
    product_key: prod.product_key ?? null,
    sku: prod.sku ?? null,
    product_name: prod.product_name ?? null,

    unit_amount: unit.amount,
    // An event's own currency wins, then the unit price's, then the cart's —
    // so a revenue report never has to guess which column to trust.
    currency: str(event.currency) ?? unit.currency ?? cart.currency ?? total.currency ?? str(c.currency) ?? null,
    quantity: int(event.quantity) ?? null,
    cart_amount: cart.amount,
    item_count: int(event.itemCount) ?? null,

    step: str(event.step) ?? null,
    order_id: str(event.orderId) ?? null,
    order_number: str(event.orderNumber) ?? null,
    order_amount: total.amount,

    // Event-level identity wins over session context, so the login event
    // itself names the customer even though context was set in the same tick.
    customer_id: str(event.customerId) ?? str(c.customerId) ?? null,
    customer_ref: str(event.customerRef) ?? str(c.customerRef) ?? null,
    login_method: str(event.method) ?? null,

    discovery_id: str(a.discoveryId) ?? null,
    discovery_type: str(a.discoveryType) ?? null,
    source_query: str(a.query) ?? null,
    source_category_path: str(a.categoryPath) ?? null,
    source_position: int(a.position) ?? null,
    source_facets: facets(a.facets),

    props: isObject(event.props) ? JSON.stringify(event.props) : null
  };

  return COLUMNS.map((c2) => row[c2] ?? null);
}

/** Session dimensions carried by an event's context. */
function contextOf(event) {
  const c = isObject(event.context) ? event.context : {};
  return {
    store: str(c.store) ?? null,
    channel: str(c.channel) ?? null,
    locale: str(c.locale) ?? null,
    currency: str(c.currency) ?? null,
    customer_id: str(event.customerId) ?? str(c.customerId) ?? null,
    customer_ref: str(event.customerRef) ?? str(c.customerRef) ?? null
  };
}

/**
 * Record a batch.
 *
 * @param {unknown} body    the parsed request body
 * @param {{ userAgent?: string, now?: number }} meta
 * @returns {Promise<{accepted:number, rejected:Array, site:string}>}
 */
export async function ingest(body, meta = {}) {
  const { site, anonymousId, sessionId, valid, rejected } = validatePayload(body, { now: meta.now });

  if (rejected.length) await logRejections(site, rejected, body);
  if (!valid.length) return { accepted: 0, rejected, site };

  const accepted = await transaction(async (client) => {
    const siteRow = await client.query(
      'SELECT id, active FROM sites WHERE slug = $1',
      [site]
    );
    if (!siteRow.rows.length) {
      // An unknown slug is almost always a typo in a script tag, so it is
      // worth surfacing rather than silently accepting into nowhere.
      throw new HttpError(404, `unknown site ${JSON.stringify(site)}`);
    }
    if (siteRow.rows[0].active === false) {
      throw new HttpError(403, `site ${JSON.stringify(site)} is not active`);
    }
    const siteId = siteRow.rows[0].id;

    // Upsert the shopper, advancing last_seen_at.
    const shopper = await client.query(
      `INSERT INTO shoppers (site_id, anonymous_id)
            VALUES ($1, $2)
       ON CONFLICT (site_id, anonymous_id)
       DO UPDATE SET last_seen_at = now()
         RETURNING id`,
      [siteId, anonymousId]
    );
    const shopperId = shopper.rows[0].id;

    // The session's dimensions come from the last event in the batch that
    // supplies each one, so a login mid-batch lands on the session row.
    const dims = {};
    for (const e of valid) {
      const c = contextOf(e);
      for (const k of Object.keys(c)) if (c[k] !== null) dims[k] = c[k];
    }
    const first = valid[0];
    const lastTs = new Date(Math.max(...valid.map((e) => Date.parse(e.ts))));

    const session = await client.query(
      `INSERT INTO sessions
              (site_id, shopper_id, session_key, started_at, last_event_at,
               store, channel, locale, currency, customer_id, customer_ref,
               user_agent, device, referrer, landing_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (site_id, session_key) DO UPDATE SET
            last_event_at = GREATEST(sessions.last_event_at, EXCLUDED.last_event_at),
            -- COALESCE with EXCLUDED first: a value that arrives later wins,
            -- but a batch that carries no store must not erase the one the
            -- opening batch established.
            store        = COALESCE(EXCLUDED.store,        sessions.store),
            channel      = COALESCE(EXCLUDED.channel,      sessions.channel),
            locale       = COALESCE(EXCLUDED.locale,       sessions.locale),
            currency     = COALESCE(EXCLUDED.currency,     sessions.currency),
            customer_id  = COALESCE(EXCLUDED.customer_id,  sessions.customer_id),
            customer_ref = COALESCE(EXCLUDED.customer_ref, sessions.customer_ref)
       RETURNING id`,
      [
        siteId, shopperId, sessionId,
        new Date(Date.parse(first.ts)), lastTs,
        dims.store ?? null, dims.channel ?? null, dims.locale ?? null, dims.currency ?? null,
        dims.customer_id ?? null, dims.customer_ref ?? null,
        str(meta.userAgent) ?? null, deviceFrom(meta.userAgent),
        str(first.referrer) ?? null, str(first.path) ?? null
      ]
    );
    const sessionRowId = session.rows[0].id;

    // One multi-row INSERT for the whole batch. Fifty round trips per beacon
    // is what makes a collector fall over under a traffic spike.
    const params = [];
    const tuples = [];
    valid.forEach((event, i) => {
      const row = toRow(event, { siteId, sessionId: sessionRowId, shopperId, seq: i });
      const base = params.length;
      tuples.push(`(${row.map((_, n) => `$${base + n + 1}`).join(',')})`);
      params.push(...row);
    });

    const inserted = await client.query(
      `INSERT INTO events (${COLUMNS.join(',')}) VALUES ${tuples.join(',')} RETURNING id, type`,
      params
    );

    await insertOrderItems(client, inserted.rows, valid, siteId, sessionRowId);
    return inserted.rowCount;
  });

  return { accepted, rejected, site };
}

/**
 * Order lines for any order_submit in the batch.
 *
 * Matched back to their events by position: the RETURNING clause of a
 * multi-row INSERT preserves the order of VALUES, so row *i* is event *i*.
 */
async function insertOrderItems(client, insertedRows, events, siteId, sessionId) {
  const params = [];
  const tuples = [];

  events.forEach((event, i) => {
    if (event.type !== 'order_submit' || !Array.isArray(event.items)) return;
    const eventId = insertedRows[i] && insertedRows[i].id;
    if (!eventId) return;

    for (const item of event.items.slice(0, 200)) {
      if (!isObject(item)) continue;
      const p = product(item.product);
      if (!p.product_id && !p.product_key && !p.sku) continue;
      const unit = money(item.product && item.product.price);
      const base = params.length;
      tuples.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`);
      params.push(
        eventId, siteId, sessionId,
        p.product_id, p.product_key, p.sku, p.product_name,
        int(item.quantity) ?? 1, unit.amount, unit.currency
      );
    }
  });

  if (!tuples.length) return;
  await client.query(
    `INSERT INTO order_items
       (event_id, site_id, session_id, product_id, product_key, sku,
        product_name, quantity, unit_amount, currency)
     VALUES ${tuples.join(',')}`,
    params
  );
}

/**
 * Record why events were refused, capped so a badly instrumented site cannot
 * fill the disk. Without this, a site whose markup sends a malformed
 * dimension looks exactly like a site nobody visited.
 */
async function logRejections(site, rejected, body) {
  try {
    for (const r of rejected.slice(0, 10)) {
      const original = Array.isArray(body.events) ? body.events[r.index] : null;
      await query(
        'INSERT INTO ingest_errors (site_slug, event_type, reason, payload) VALUES ($1,$2,$3,$4)',
        [site, r.type, r.reason, original ? JSON.stringify(original).slice(0, 4000) : null]
      );
    }
    // Trim on write rather than on a schedule, so the cap holds even if
    // nobody ever runs the retention job.
    await query(
      `DELETE FROM ingest_errors
        WHERE id < (SELECT MIN(id) FROM (
                SELECT id FROM ingest_errors ORDER BY id DESC LIMIT $1
              ) keep)`,
      [config.ingestErrorLimit]
    );
  } catch (err) {
    // Failing to log a rejection must not fail the request that carried
    // valid events alongside it.
    console.error('[clickstream] could not record rejection:', err.message);
  }
}

export { COLUMNS };
