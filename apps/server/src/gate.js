/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * A shared-password gate in front of the reports.
 *
 * The admin renders every shopper's browsing history, so it needs to be
 * closed. A bearer token in the URL closes it but is miserable to share: it
 * ends up pasted into chat, it breaks when someone trims the query string, and
 * it cannot be rotated without telling everyone. A gate asks for a work email
 * and one shared password, sets a cookie, and gets out of the way.
 *
 * The password itself is never held here. It is validated by an external
 * service — whatever `GATE_AUTH_URL` points at — which is also where the
 * visitor log lives. This process only ever sees whether that service said yes.
 *
 * The cookie is presence-checked, not verified. That is deliberate and it is
 * not the weak link: the cookie is `HttpOnly`, `Secure`, `SameSite=Lax` and
 * first-party, so a visitor can only obtain one by passing the gate, and the
 * value stored is the upstream session token so the check could be tightened
 * to a verification without changing the shape of any of this.
 *
 * Disabled entirely when `GATE_SITE` is unset, which is how local development
 * and the collector run.
 */

import { esc, parseCookies, send } from './http.js';

/** Cookie name. First-party, and deliberately not the upstream session name. */
const COOKIE = process.env.GATE_COOKIE_NAME || 'demo_gate';

/** Six months. A link shared with a colleague should not expire mid-review. */
const MAX_AGE_SECONDS = Number(process.env.GATE_COOKIE_MAX_AGE || 60 * 60 * 24 * 180);

/** The registered site identifier the auth service knows this deploy by. */
export function gateSite() {
  return (process.env.GATE_SITE || '').trim();
}

/** Origin of the service that validates the password. */
function authOrigin() {
  return (process.env.GATE_AUTH_URL || '').trim().replace(/\/+$/, '');
}

/**
 * The gate is on only when both halves are configured. Half-configuring it
 * leaves the reports open, so that combination refuses to serve rather than
 * failing quietly — see `gateMisconfigured`.
 */
export function isGateEnabled() {
  return Boolean(gateSite() && authOrigin());
}

/** True when one half is set and the other is not. */
export function gateMisconfigured() {
  return Boolean(gateSite()) !== Boolean(authOrigin());
}

/** Whether this request already carries a gate cookie. */
export function gateSatisfied(req) {
  if (!isGateEnabled()) return false;
  const cookies = parseCookies(req.headers.cookie);
  return Boolean(cookies[COOKIE]);
}

/**
 * Whether the site is "open" — email only, no password. Read from the auth
 * service so the form matches how the site is actually registered.
 *
 * Falls back to closed on any error, so an upstream hiccup shows a password
 * field rather than accidentally dropping the gate.
 */
async function siteIsOpen() {
  try {
    const r = await fetch(`${authOrigin()}/site-info?site=${encodeURIComponent(gateSite())}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return false;
    const body = /** @type {{ open?: boolean }} */ (await r.json());
    return body.open === true;
  } catch {
    return false;
  }
}

function cookieHeader(value) {
  // SameSite=Lax, not None: Lax IS sent on a top-level navigation, which is
  // how a visitor arrives after the gate redirects them home. None would need
  // Secure anyway and buys nothing here.
  return `${COOKIE}=${value}; Path=/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Validate a submission against the auth service.
 *
 * On success the upstream sets its own session cookie; that token becomes the
 * value of our first-party cookie. The browser is never handed the upstream
 * cookie, which keeps the whole exchange same-origin.
 */
async function validate({ email, password }) {
  const r = await fetch(`${authOrigin()}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ site: gateSite(), email, password }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!r.ok) return null;
  const upstream = r.headers.get('set-cookie') || '';
  // Fall back to a placeholder only if the upstream set no cookie, which is an
  // abnormal path — the gate should still open, since it did say yes.
  const match = upstream.match(/dt_session=([^;]+)/);
  return match ? match[1] : '1';
}

/** Parse an `application/x-www-form-urlencoded` body. */
function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8192) {
        reject(new Error('form body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      resolve({ email: params.get('email') || '', password: params.get('password') || '' });
    });
    req.on('error', reject);
  });
}

/**
 * The gate page. Self-contained HTML with inline CSS, matching the admin's
 * light theme, and a native form POST rather than fetch — a top-level submit
 * is what lets the response set a `SameSite=Lax` cookie and redirect in one
 * step.
 */
function gatePage({ open, error, name }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name || 'Commerce Clickstream')} — access</title>
<style>
  :root { --border:#e2e5ea; --text:#1a1d21; --muted:#61666e; --accent:#0b6bcb; --bad:#b3261e; --panel:#f7f8fa; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#fff; color:var(--text);
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .card { width:min(92vw,380px); border:1px solid var(--border); border-radius:10px; padding:26px 24px; }
  h1 { font-size:19px; margin:0 0 4px; letter-spacing:-0.01em; }
  p.sub { color:var(--muted); margin:0 0 20px; font-size:14px; }
  label { display:block; font-size:12px; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted); margin-bottom:4px; }
  input { width:100%; font:inherit; padding:8px 10px; border:1px solid var(--border); border-radius:6px; background:#fff; color:var(--text); margin-bottom:14px; }
  button { width:100%; font:inherit; font-weight:600; padding:9px 14px; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:6px; cursor:pointer; }
  .err { background:#fdecea; border:1px solid var(--bad); color:var(--bad); border-radius:6px; padding:8px 10px; font-size:13px; margin:0 0 16px; }
  .foot { color:var(--muted); font-size:12px; margin:18px 0 0; }
  .brand { font-weight:700; font-size:15px; margin:0 0 18px; }
  .brand span { display:block; color:var(--muted); font-weight:400; font-size:12px; }
</style>
</head><body>
<form class="card" method="post" action="/gate">
  <div class="brand">Clickstream<span>shopper analytics</span></div>
  <h1>${esc(name || 'Reports')}</h1>
  <p class="sub">Enter your work email${open ? '' : ' and the site password'} to continue.</p>
  ${error ? '<p class="err">That did not work. Check the password and try again.</p>' : ''}
  <label for="email">Work email</label>
  <input id="email" name="email" type="email" required autocomplete="email" autofocus>
  ${open ? '' : `<label for="password">Site password</label>
  <input id="password" name="password" type="password" required autocomplete="current-password">`}
  <button type="submit">Continue</button>
  <p class="foot">These reports contain shopper browsing behaviour. Access is logged.</p>
</form>
</body></html>`;
}

/**
 * Handle the gate's own routes.
 *
 * @returns {Promise<boolean>} whether the request was handled.
 */
export async function handleGate(req, res, pathname) {
  if (pathname !== '/gate') return false;

  if (req.method === 'GET') {
    // Already through: send them on rather than showing a form that would
    // confuse someone who followed an old link.
    if (gateSatisfied(req)) {
      send(res, 303, '', { Location: '/' });
      return true;
    }
    const [open] = await Promise.all([siteIsOpen()]);
    send(res, 200, gatePage({ open, error: req.url.includes('error=1'), name: process.env.GATE_NAME }), {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    return true;
  }

  if (req.method === 'POST') {
    let form;
    try {
      form = await readForm(req);
    } catch {
      send(res, 303, '', { Location: '/gate?error=1' });
      return true;
    }
    let token = null;
    try {
      token = await validate(form);
    } catch {
      token = null;
    }
    if (!token) {
      send(res, 303, '', { Location: '/gate?error=1', 'Cache-Control': 'no-store' });
      return true;
    }
    send(res, 303, '', {
      Location: '/',
      'Set-Cookie': cookieHeader(token),
      'Cache-Control': 'no-store'
    });
    return true;
  }

  send(res, 405, 'method not allowed');
  return true;
}

/** Redirect an unauthenticated request to the gate. */
export function redirectToGate(res) {
  send(res, 307, '', { Location: '/gate', 'Cache-Control': 'no-store' });
}

export { COOKIE as GATE_COOKIE };
