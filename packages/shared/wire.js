/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Validation of what arrives at the collector.
 *
 * Hand-written rather than schema-library-driven, so the whole system has no
 * runtime dependencies beyond the Postgres driver. The policy is deliberately
 * asymmetric: **lenient about unknown fields, strict about the ones reports
 * read**. An event carrying an extra property is accepted and stored, because
 * a site will always know something we did not anticipate. An event missing
 * its discriminating dimension is rejected with a reason, because a collector
 * that quietly accepts a `search` with no query produces a top-queries report
 * full of blanks and no way to find out why.
 *
 * Rejections are per event, not per batch. One broken call site in a site's
 * markup must not cost the other 49 events in the request.
 */

import { EVENT_TYPES, PAGE_TYPES } from './events.js';

const EVENT_TYPE_SET = new Set(EVENT_TYPES);
const PAGE_TYPE_SET = new Set(PAGE_TYPES);

/** Longest string kept in a typed text column, to bound a hostile payload. */
export const MAX_STRING = 512;

/** Most events accepted in one POST. Matches the browser client's batch cap. */
export const MAX_BATCH = 50;

/** Largest request body the collector will parse, in bytes. */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * How far a client timestamp may drift from the collector's clock before it is
 * replaced. Phones with a wrong clock are common, and a 1979 or 2041 timestamp
 * silently disappears from every date-ranged report.
 */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>} a type predicate, so callers narrow
 *   rather than needing a cast at every property access below.
 */
export function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Trimmed, non-empty, length-capped string — or undefined.
 * @param {unknown} v
 * @returns {string|undefined}
 */
export function str(v) {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > MAX_STRING ? t.slice(0, MAX_STRING) : t;
}

/** @param {unknown} v @returns {number|undefined} */
export function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Integer for counts and positions. Rounds rather than rejecting.
 * @param {unknown} v @returns {number|undefined}
 */
export function int(v) {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n);
}

/**
 * A product must be identifiable by something, or it cannot be grouped.
 * @param {unknown} p
 */
function hasProductIdentity(p) {
  return Boolean(isObject(p) && (str(p.productId) || str(p.productKey) || str(p.sku)));
}

/** @param {Record<string, any>} e */
function productReason(e) {
  return hasProductIdentity(e.product) ? null : 'product needs one of productId, productKey, sku';
}

/** @param {Record<string, any>} e */
function facetReason(e) {
  return isObject(e.facet) && str(e.facet.name) ? null : 'facet.name is required';
}

/**
 * The dimension each event type must carry to be reportable, keyed by type so
 * the rule sits beside the taxonomy it enforces.
 */
/** @type {Record<string, (e: Record<string, any>) => string|null>} */
const REQUIRED = {
  page_view: (e) =>
    PAGE_TYPE_SET.has(e.pageType) ? null : `pageType must be one of ${PAGE_TYPES.join(', ')}`,
  search: (e) => (str(e.query) ? null : 'query is required'),
  category_view: (e) => (str(e.categoryPath) ? null : 'categoryPath is required'),
  facet_apply: facetReason,
  facet_remove: facetReason,
  sort_change: (e) => (str(e.sort) ? null : 'sort is required'),
  result_click: productReason,
  product_view: productReason,
  add_to_cart: productReason,
  remove_from_cart: productReason,
  order_submit: (e) =>
    isObject(e.total) && num(e.total.centAmount) !== undefined && str(e.total.currencyCode)
      ? null
      : 'total.centAmount and total.currencyCode are required'
};

/**
 * Validate one event. Returns the reason it is unacceptable, or null.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function validateEvent(raw) {
  if (!isObject(raw)) return 'event must be an object';
  if (typeof raw.type !== 'string' || !EVENT_TYPE_SET.has(raw.type)) {
    return `unknown event type ${JSON.stringify(raw.type)}`;
  }
  if (typeof raw.ts !== 'string' || Number.isNaN(Date.parse(raw.ts))) {
    return 'ts must be an ISO 8601 timestamp';
  }
  const check = REQUIRED[raw.type];
  return check ? check(raw) : null;
}

/**
 * Validate a whole envelope.
 *
 * Throws on a malformed envelope — there is nothing to store and nothing to
 * partially salvage. Individual bad events are collected into `rejected`
 * instead, with their index and reason, so the caller can log what a site is
 * getting wrong without losing the rest of the batch.
 *
 * @param {unknown} body
 * @param {{ now?: number }} [opts]
 */
export function validatePayload(body, opts = {}) {
  if (!isObject(body)) throw new Error('body must be a JSON object');

  const site = str(body.site);
  if (!site) throw new Error('site is required');
  const anonymousId = str(body.anonymousId);
  if (!anonymousId) throw new Error('anonymousId is required');
  const sessionId = str(body.sessionId);
  if (!sessionId) throw new Error('sessionId is required');
  if (!Array.isArray(body.events)) throw new Error('events must be an array');
  if (body.events.length > MAX_BATCH) throw new Error(`events exceeds MAX_BATCH of ${MAX_BATCH}`);

  const now = opts.now ?? Date.now();
  /** @type {Record<string, any>[]} */
  const valid = [];
  /** @type {{index: number, reason: string, type: string|null}[]} */
  const rejected = [];

  body.events.forEach((/** @type {any} */ event, /** @type {number} */ index) => {
    const reason = validateEvent(event);
    if (reason) {
      rejected.push({ index, reason, type: isObject(event) ? String(event.type) : null });
      return;
    }
    // Clamp an implausible client clock to arrival time rather than dropping
    // the event: the event happened, only its timestamp is untrustworthy.
    const ts = Date.parse(event.ts);
    const skewed = Math.abs(ts - now) > MAX_CLOCK_SKEW_MS;
    valid.push(skewed ? { ...event, ts: new Date(now).toISOString(), tsClamped: true } : event);
  });

  return { site, anonymousId, sessionId, valid, rejected };
}
