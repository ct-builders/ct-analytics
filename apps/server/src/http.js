/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/** Small helpers over node:http, so the server needs no web framework. */

import { MAX_BODY_BYTES } from '../../../packages/shared/wire.js';
import { SORT_SCRIPT_CSP_HASH } from './sort-script.js';

/**
 * An Error carrying the HTTP status it should become.
 *
 * A named class rather than an ad-hoc `err.status = 400`, so a handler can
 * tell "this request was bad" from "this server is broken" — the first is a
 * 4xx the caller should see, the second is a 500 that belongs in the log.
 */
export class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function send(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    // Analytics responses are never useful to a cache, and a cached 204 on
    // the collect endpoint would silently swallow a site's events.
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

export function json(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
}

export function html(res, status, markup, headers = {}) {
  send(res, status, markup, {
    'Content-Type': 'text/html; charset=utf-8',
    // The admin renders values that originate in a browser payload, so a
    // strict policy is worth having even though everything is escaped.
    // `script-src` names the admin's own table-sorting script by hash rather
    // than opening inline execution, so a payload that smuggles a script tag
    // past the escaping still cannot run it.
    'Content-Security-Policy':
      `default-src 'none'; script-src ${SORT_SCRIPT_CSP_HASH}; style-src 'unsafe-inline'; ` +
      "img-src data:; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers
  });
}

/**
 * Read and parse a JSON body.
 *
 * Bounded, and the bound is enforced while reading rather than after: a
 * 50 MB body must not be buffered before being rejected. `sendBeacon` posts
 * `text/plain` in some browsers, so the content type is not checked.
 */
export function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        reject(new HttpError(400, 'empty request body'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Resolve the CORS headers for a request.
 *
 * A site's `origins` list wins; the environment default applies when it is
 * empty. An empty list at both levels reflects the origin back, which is what
 * makes a new install work the moment it is deployed anywhere — and is why the
 * collector warns about it on startup.
 */
/**
 * @param {string|undefined} origin
 * @param {string[]|null|undefined} allowed
 * @returns {Record<string, string>}
 */
export function corsHeaders(origin, allowed) {
  if (!origin) return {};
  const list = allowed && allowed.length ? allowed : null;
  const permitted = !list || list.includes(origin) || list.includes('*');
  if (!permitted) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    // Credentialed, because the collect endpoint is often reached through a
    // site's own first-party path where a session cookie is present.
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

/** Path and query, without needing a base URL. */
export function parseUrl(req) {
  const raw = req.url || '/';
  const i = raw.indexOf('?');
  const pathname = i === -1 ? raw : raw.slice(0, i);
  const params = new URLSearchParams(i === -1 ? '' : raw.slice(i + 1));
  return { pathname, params };
}

/**
 * Parse a `Cookie` header into a plain object.
 *
 * Values are decoded but not validated. Only the gate reads these, and it
 * checks presence rather than trusting content.
 *
 * @param {string|undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed percent-escape must not take down the request.
      out[name] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/** HTML-escape. Everything rendered by the admin passes through this. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Constant-time string comparison, for the admin token.
 *
 * A plain `===` on a secret leaks its length and its matching prefix through
 * timing. The cost here is one comparison per request.
 */
export function safeEqual(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= x.charCodeAt(i % (x.length || 1)) ^ y.charCodeAt(i % (y.length || 1));
  }
  return diff === 0;
}
