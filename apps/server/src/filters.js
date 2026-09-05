/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * The segment filters every report shares.
 *
 * One builder, so "last 7 days, mobile, signed-in shoppers" means the same
 * thing on every report and is written once. Each filter emits a fragment and
 * its parameters; nothing is ever interpolated into SQL.
 */

/** Named ranges offered in the UI, as day offsets from today. */
export const RANGES = {
  today: { label: 'Today', days: 0 },
  '7d': { label: 'Last 7 days', days: 7 },
  '30d': { label: 'Last 30 days', days: 30 },
  '90d': { label: 'Last 90 days', days: 90 },
  all: { label: 'All time', days: null }
};

export const DEVICES = ['mobile', 'tablet', 'desktop'];

/** Whether a shopper was signed in. Its own filter because it splits every rate. */
export const IDENTITY = {
  any: 'All shoppers',
  registered: 'Signed in',
  anonymous: 'Anonymous'
};

/**
 * Normalise raw query-string values into a filter object.
 * @param {URLSearchParams} params
 */
export function parseFilters(params) {
  const range = RANGES[params.get('range')] ? params.get('range') : '30d';
  return {
    site: params.get('site') || '',
    range,
    from: params.get('from') || '',
    to: params.get('to') || '',
    device: DEVICES.includes(params.get('device')) ? params.get('device') : '',
    store: params.get('store') || '',
    channel: params.get('channel') || '',
    identity: IDENTITY[params.get('identity')] ? params.get('identity') : 'any',
    customer: params.get('customer') || '',
    limit: clampLimit(params.get('limit'))
  };
}

function clampLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(n, 1), 500);
}

/**
 * Build a WHERE clause for a query whose events are aliased `e` and whose
 * sessions are aliased `s`.
 *
 * @param {ReturnType<typeof parseFilters>} f
 * @param {{ eventAlias?: string, sessionAlias?: string, startIndex?: number }} [opts]
 * @returns {{ where: string, params: unknown[], next: number }}
 */
export function buildWhere(f, opts = {}) {
  const e = opts.eventAlias || 'e';
  const s = opts.sessionAlias || 's';
  const clauses = [];
  const params = [];
  let i = opts.startIndex || 1;

  if (f.site) {
    clauses.push(`${e}.site_id = (SELECT id FROM sites WHERE slug = $${i++})`);
    params.push(f.site);
  }

  // An explicit from/to wins over the named range, so a link with dates in it
  // survives being shared.
  if (f.from) {
    clauses.push(`${e}.ts >= $${i++}`);
    params.push(new Date(`${f.from}T00:00:00Z`));
  }
  if (f.to) {
    clauses.push(`${e}.ts < $${i++}`);
    // Exclusive upper bound on the following day, so "to 2026-09-04" includes
    // everything that happened on the 4th rather than only midnight.
    params.push(new Date(new Date(`${f.to}T00:00:00Z`).getTime() + 86_400_000));
  }
  if (!f.from && !f.to) {
    const days = RANGES[f.range].days;
    if (days === 0) {
      clauses.push(`${e}.ts >= date_trunc('day', now())`);
    } else if (days !== null) {
      clauses.push(`${e}.ts >= now() - ($${i++} || ' days')::interval`);
      params.push(String(days));
    }
  }

  if (f.device) {
    clauses.push(`${s}.device = $${i++}`);
    params.push(f.device);
  }
  if (f.store) {
    clauses.push(`${s}.store = $${i++}`);
    params.push(f.store);
  }
  if (f.channel) {
    clauses.push(`${s}.channel = $${i++}`);
    params.push(f.channel);
  }
  if (f.identity === 'registered') {
    clauses.push(`${s}.customer_ref IS NOT NULL`);
  } else if (f.identity === 'anonymous') {
    clauses.push(`${s}.customer_ref IS NULL`);
  }
  if (f.customer) {
    clauses.push(`${s}.customer_ref = $${i++}`);
    params.push(f.customer);
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
    next: i
  };
}

/**
 * Serialise filters back into a query string, for links that keep the segment.
 *
 * The admin token rides along when one is in play. Every internal link is
 * built from here, so this is the single point that keeps navigation from
 * logging you out — a link that drops the token turns the whole admin into one
 * page you can reach only by editing the URL.
 */
export function toQuery(f, overrides = {}) {
  const merged = { ...f, ...overrides };
  const qs = new URLSearchParams();
  for (const key of ['site', 'range', 'from', 'to', 'device', 'store', 'channel', 'identity', 'customer']) {
    if (merged[key] && !(key === 'range' && (merged.from || merged.to)) && !(key === 'identity' && merged[key] === 'any')) {
      qs.set(key, merged[key]);
    }
  }
  if (merged.limit && merged.limit !== 50) qs.set('limit', String(merged.limit));
  for (const [k, v] of Object.entries(overrides)) {
    if (v === '' || v === null || v === undefined) qs.delete(k);
  }
  if (merged._token) qs.set('token', merged._token);
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/** A one-line description of the active segment, for the page header. */
export function describe(f) {
  const bits = [];
  if (f.from || f.to) bits.push(`${f.from || 'start'} to ${f.to || 'now'}`);
  else bits.push(RANGES[f.range].label.toLowerCase());
  if (f.device) bits.push(f.device);
  if (f.store) bits.push(`store ${f.store}`);
  if (f.channel) bits.push(`channel ${f.channel}`);
  if (f.identity !== 'any') bits.push(IDENTITY[f.identity].toLowerCase());
  if (f.customer) bits.push(f.customer);
  return bits.join(' · ');
}
