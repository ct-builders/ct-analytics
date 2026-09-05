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
import { corsHeaders, json, parseUrl, readJson, safeEqual, send } from './http.js';

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

/**
 * Is this event POST allowed to write?
 *
 * Two acceptable answers, and no third.
 *
 * 1. It carries the ingest token. This is real authentication, and it implies
 *    the caller is a server — a site's own backend proxying its shoppers'
 *    events. A token in a browser is readable by anyone who views source, so
 *    the browser is never given one.
 *
 * 2. Browser-direct posts are explicitly enabled AND the request's `Origin` is
 *    on that site's allowlist. This is weaker and worth naming honestly:
 *    `Origin` is set by the browser, so anything that is not a browser can
 *    forge it. It buys you "a random scanner cannot write to your reports",
 *    not "only your site can". It exists because a site with no backend has
 *    nowhere to keep a token.
 *
 * A site with an empty allowlist is refused even in mode 2, because
 * "authenticated by Origin" against a list that permits every origin is not
 * authentication at all.
 *
 * @returns {{status: number, error: string} | null} null when allowed, or the
 *   refusal to send back. A nullable result rather than a tagged union,
 *   because there is exactly one success shape and it carries nothing.
 */
function ingestRefusal(req, origin, origins) {
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (config.ingestKey && supplied && safeEqual(supplied, config.ingestKey)) {
    return null;
  }

  // A token was offered and did not match. Say so rather than falling through
  // to the origin check, so a server with a stale token gets a clear 401
  // instead of a confusing 403 about origins.
  if (supplied) {
    return { status: 401, error: 'invalid ingest token' };
  }

  if (!config.ingestAllowBrowser) {
    return { status: 401, error: 'ingest requires a bearer token; post through your own backend' };
  }
  if (!origins || !origins.length) {
    return { status: 403, error: 'browser ingest needs an origin allowlist for this site' };
  }
  if (!origin) {
    return { status: 403, error: 'missing Origin' };
  }
  if (!origins.includes(origin) && !origins.includes('*')) {
    return { status: 403, error: 'origin not allowed' };
  }
  return null;
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

    // Re-resolve from the body's slug when the query string omitted it, so a
    // site's own allowlist is what gets enforced either way.
    const bodySlug = body && typeof body.site === 'string' ? body.site : '';
    const effectiveOrigins = slug
      ? await allowedOrigins(slug)
      : bodySlug
        ? await allowedOrigins(bodySlug)
        : config.defaultOrigins;
    const effective = slug ? cors : corsHeaders(origin, effectiveOrigins);

    // Authorization before anything touches the database.
    const refusal = ingestRefusal(req, origin, effectiveOrigins);
    if (refusal) {
      json(res, refusal.status, { error: refusal.error }, effective);
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

/**
 * Refuse to start a collector that would accept unauthenticated writes.
 *
 * A write endpoint on the public internet with no credential is not a
 * configuration worth supporting, and the failure is invisible once it is
 * running — the reports fill up and look fine.
 *
 * @returns {string[]} fatal problems; empty when the configuration is sound.
 */
export function ingestConfigProblems() {
  const problems = [];
  if (!config.ingestKey && !config.ingestAllowBrowser) {
    problems.push(
      'ingest has no credential. Set CLICKSTREAM_INGEST_KEY and have your site post ' +
        'through its own backend, or set CLICKSTREAM_INGEST_ALLOW_BROWSER=true to accept ' +
        'browser posts authenticated by Origin alone (weaker — see docs/security.md).'
    );
  }
  if (config.ingestKey && config.ingestKey.length < 24) {
    problems.push('CLICKSTREAM_INGEST_KEY is shorter than 24 characters. Generate one with `openssl rand -hex 32`.');
  }
  return problems;
}

/** Warn about the weaker mode being on, every start, so it stays visible. */
export function warnOnBrowserIngest() {
  if (config.ingestAllowBrowser) {
    console.warn(
      '[clickstream] CLICKSTREAM_INGEST_ALLOW_BROWSER is on — browser posts are authenticated ' +
        'by Origin alone, which anything that is not a browser can forge. Per-site origin ' +
        'allowlists are required and enforced.'
    );
  }
}
