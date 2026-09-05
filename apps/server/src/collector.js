/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * The collector: the only part of this system exposed to the internet.
 *
 * It does three things — serve the browser client, accept batches of events,
 * and answer a health check. It deliberately does nothing else. Anything that
 * reads data lives in the admin, on a different port with a different
 * exposure, so a mistake in a report cannot become a data leak on a public
 * endpoint.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { ingest } from './ingest.js';
import { rows } from './db.js';
import { corsHeaders, json, parseUrl, readJson, send } from './http.js';

const here = dirname(fileURLToPath(import.meta.url));
const BROWSER_DIR = join(here, '..', '..', '..', 'packages', 'browser');

/**
 * The allowed-origins list per site, cached briefly.
 *
 * Every event POST would otherwise begin with a lookup, and the answer
 * changes about once a month. Sixty seconds is short enough that adding an
 * origin takes effect without a restart.
 */
const originCache = new Map();
const ORIGIN_TTL_MS = 60_000;

async function allowedOrigins(slug) {
  const hit = originCache.get(slug);
  if (hit && hit.expires > Date.now()) return hit.origins;
  let origins = config.defaultOrigins;
  try {
    const found = await rows('SELECT origins FROM sites WHERE slug = $1', [slug]);
    if (found.length && Array.isArray(found[0].origins) && found[0].origins.length) {
      origins = found[0].origins;
    }
  } catch {
    // A database blip must not turn into a CORS failure on every storefront
    // at once; fall back to the configured default.
  }
  originCache.set(slug, { origins, expires: Date.now() + ORIGIN_TTL_MS });
  return origins;
}

let clientSource;

/** The browser client, read once and held. It is one small file. */
async function browserClient() {
  if (!clientSource) clientSource = await readFile(join(BROWSER_DIR, 'clickstream.js'), 'utf8');
  return clientSource;
}

/**
 * @returns {Promise<boolean>} whether the request was handled, so the server
 * can fall through to the admin when both run on one port.
 */
export async function handleCollector(req, res) {
  const { pathname, params } = parseUrl(req);

  if (pathname === '/health' || pathname === '/healthz') {
    json(res, 200, { ok: true, mode: config.mode });
    return true;
  }

  // The browser client. `/c.js` is the short form that goes in a script tag.
  if ((pathname === '/c.js' || pathname === '/clickstream.js') && req.method === 'GET') {
    try {
      send(res, 200, await browserClient(), {
        'Content-Type': 'application/javascript; charset=utf-8',
        // Five minutes: long enough to spare the origin on a busy site, short
        // enough that a fix to the client reaches every page the same day.
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*'
      });
    } catch (err) {
      send(res, 500, 'client unavailable');
      console.error('[clickstream] could not read clickstream.js:', err.message);
    }
    return true;
  }

  if (pathname === '/snippet.js' && req.method === 'GET') {
    try {
      send(res, 200, await readFile(join(BROWSER_DIR, 'snippet.js'), 'utf8'), {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=300'
      });
    } catch {
      send(res, 404, 'not found');
    }
    return true;
  }

  if (pathname === '/collect') {
    const origin = req.headers.origin;
    // The slug is on the query string for preflight, where there is no body
    // to read it from.
    const slug = params.get('site') || '';
    const cors = corsHeaders(origin, slug ? await allowedOrigins(slug) : config.defaultOrigins);

    if (req.method === 'OPTIONS') {
      send(res, 204, '', cors);
      return true;
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' }, cors);
      return true;
    }

    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      json(res, err.status || 400, { error: err.message }, cors);
      return true;
    }

    // Re-resolve CORS from the body's slug when the query string omitted it,
    // so a site with a restricted origin list is still enforced.
    const bodySlug = body && typeof body.site === 'string' ? body.site : '';
    const effective = slug
      ? cors
      : corsHeaders(origin, bodySlug ? await allowedOrigins(bodySlug) : config.defaultOrigins);

    if (origin && !effective['Access-Control-Allow-Origin']) {
      json(res, 403, { error: 'origin not allowed' });
      return true;
    }

    try {
      const result = await ingest(body, { userAgent: req.headers['user-agent'] });
      // 202, not 200: the events are recorded, and there is nothing for the
      // browser to do with the response. Rejections are reported so a
      // developer can see them in the network tab during an install.
      json(
        res,
        202,
        { accepted: result.accepted, rejected: result.rejected },
        effective
      );
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[clickstream] ingest failed:', err.message);
      json(res, status, { error: err.message }, effective);
    }
    return true;
  }

  return false;
}

/** Warn once at startup about the configuration that is fine only locally. */
export function warnOnOpenCors() {
  if (!config.defaultOrigins.length) {
    console.warn(
      '[clickstream] no CLICKSTREAM_ORIGINS set and sites may list none — events will be accepted from any origin. ' +
        'Fine while wiring a site up; set per-site origins before production.'
    );
  }
}
