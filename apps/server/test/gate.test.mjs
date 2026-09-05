/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * The shared-password gate.
 *
 * A stub auth service stands in for the real one, so the password exchange
 * under test is the actual HTTP call the deployed gate makes — including the
 * upstream cookie being adopted as the first-party one.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Set before the first import that reaches config.js.
process.env.CLICKSTREAM_ADMIN_TOKEN = 'unused-token';

import { scratchDatabase, startServer, INGEST_KEY } from './helpers.mjs';

const PASSWORD = 'lights';
let db;
let server;
let upstream;
let upstreamBase;
let query;
/** Requests the stub auth service received, so the payload can be asserted. */
const authCalls = [];
let siteOpen = false;

before(async () => {
  db = await scratchDatabase('gate');
  ({ query } = await import('../src/db.js'));
  await query("INSERT INTO sites (slug, name) VALUES ('shop', 'Shop')");
  await query(
    `INSERT INTO shoppers (site_id, anonymous_id) VALUES ((SELECT id FROM sites WHERE slug='shop'), 'a1')`
  );

  // The stub auth service: /site-info and /auth, same contract as the real one.
  upstream = createServer((req, res) => {
    if (req.url.startsWith('/site-info')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ open: siteOpen, name: 'Clickstream Reports' }));
      return;
    }
    if (req.url === '/auth' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        authCalls.push(body);
        if (siteOpen ? Boolean(body.email) : body.password === PASSWORD) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': 'dt_session=upstream.jwt.value; Path=/; HttpOnly'
          });
          res.end('{"ok":true}');
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end('{"error":"bad password"}');
        }
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  process.env.GATE_SITE = 'clickstream-reports';
  process.env.GATE_AUTH_URL = upstreamBase;
  process.env.GATE_NAME = 'Clickstream Reports';

  server = await startServer();
});

after(async () => {
  await server?.close();
  await new Promise((r) => upstream?.close(r));
  delete process.env.GATE_SITE;
  delete process.env.GATE_AUTH_URL;
  await db?.drop();
});

test('the gate is enabled only when both halves are configured', async () => {
  const { isGateEnabled, gateMisconfigured } = await import('../src/gate.js');
  assert.equal(isGateEnabled(), true);
  assert.equal(gateMisconfigured(), false);

  const site = process.env.GATE_SITE;
  delete process.env.GATE_SITE;
  // Half-configured is the dangerous state: it would leave the reports open
  // while looking gated, so it is reported as a misconfiguration.
  assert.equal(isGateEnabled(), false);
  assert.equal(gateMisconfigured(), true);
  process.env.GATE_SITE = site;
});

test('a report request with no cookie is sent to the gate', async () => {
  const res = await fetch(`${server.base}/report/overview`, { redirect: 'manual' });
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), '/gate');
});

test('the token is no longer a way in once the gate is on', async () => {
  // Otherwise there would be two secrets to distribute and the weaker one
  // would define the security of the whole thing.
  const res = await fetch(`${server.base}/report/overview?token=unused-token`, { redirect: 'manual' });
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), '/gate');
});

test('the gate page renders with a password field', async () => {
  const res = await fetch(`${server.base}/gate`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Work email/);
  assert.match(html, /Site password/);
  assert.match(html, /name="password"/);
  assert.match(html, /Clickstream Reports/, 'the site name comes from the auth service');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('an open site collects an email and shows no password field', async () => {
  siteOpen = true;
  try {
    const html = await (await fetch(`${server.base}/gate`)).text();
    assert.match(html, /Work email/);
    assert.doesNotMatch(html, /name="password"/, 'a required field nobody can fill would block every visitor');
  } finally {
    siteOpen = false;
  }
});

test('a wrong password does not open the gate', async () => {
  const res = await fetch(`${server.base}/gate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'someone@example.com', password: 'wrong' }),
    redirect: 'manual'
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/gate?error=1');
  assert.equal(res.headers.get('set-cookie'), null, 'no cookie is issued');
});

test('the right password opens the gate and sets a hardened cookie', async () => {
  const res = await fetch(`${server.base}/gate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'verify@example.com', password: PASSWORD }),
    redirect: 'manual'
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');

  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /^demo_gate=/);
  assert.match(cookie, /HttpOnly/, 'not readable from JavaScript');
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/, 'Lax is sent on the top-level navigation home');
  assert.match(cookie, /Max-Age=\d+/);
  assert.match(cookie, /upstream\.jwt\.value/, 'the upstream session token becomes the value');

  // The submission reached the auth service with the registered site id.
  const last = authCalls[authCalls.length - 1];
  assert.equal(last.site, 'clickstream-reports');
  assert.equal(last.email, 'verify@example.com');
});

test('the password is never held by this process', async () => {
  // It is only ever forwarded. Nothing in the gate module contains it.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/gate.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, new RegExp(PASSWORD, 'i'));
});

test('a visitor carrying the cookie reads the reports with no token', async () => {
  const res = await fetch(`${server.base}/report/overview?range=all`, {
    headers: { cookie: 'demo_gate=upstream.jwt.value' }
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Overview/);
  assert.match(html, /Conversion/);
  assert.doesNotMatch(html, /Not authorised/);
});

test('every report is reachable behind the gate', async () => {
  const cookie = 'demo_gate=upstream.jwt.value';
  const catalog = await (await fetch(`${server.base}/reports.json`, { headers: { cookie } })).json();
  for (const r of catalog.reports) {
    const res = await fetch(`${server.base}/report/${r.key}?range=all`, { headers: { cookie } });
    assert.equal(res.status, 200, `${r.key} is reachable`);
  }
});

test('the gate page sends an already-authenticated visitor onward', async () => {
  const res = await fetch(`${server.base}/gate`, {
    headers: { cookie: 'demo_gate=upstream.jwt.value' },
    redirect: 'manual'
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
});

test('the collector stays ungated — a shopper has no gate cookie', async () => {
  // Gating ingest would silently stop every event on every instrumented site.
  const res = await fetch(`${server.base}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INGEST_KEY}` },
    body: JSON.stringify({
      site: 'shop',
      anonymousId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      sessionId: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      events: [{ type: 'page_view', pageType: 'home', ts: new Date().toISOString() }]
    })
  });
  assert.equal(res.status, 202);
});

test('the client script stays ungated', async () => {
  // It is loaded by shoppers' browsers, which never have a gate cookie.
  // `manual` matters: a followed redirect to the gate page is also a 200, so
  // without it this passes whether the script is served or gated away.
  const res = await fetch(`${server.base}/c.js?site=shop`, { redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
});

test('health stays ungated, so a platform probe is not a redirect loop', async () => {
  const res = await fetch(`${server.base}/health`, { redirect: 'manual' });
  assert.equal(res.status, 200);
});

test('an auth service that is down keeps the gate closed', async () => {
  const original = process.env.GATE_AUTH_URL;
  // A port nothing is listening on.
  process.env.GATE_AUTH_URL = 'http://127.0.0.1:1';
  try {
    const res = await fetch(`${server.base}/gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'a@example.com', password: PASSWORD }),
      redirect: 'manual'
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/gate?error=1');
    assert.equal(res.headers.get('set-cookie'), null, 'fails closed, never open');

    // And the form still renders, with the password field shown.
    const html = await (await fetch(`${server.base}/gate`)).text();
    assert.match(html, /name="password"/, 'an upstream hiccup must not drop the password field');
  } finally {
    process.env.GATE_AUTH_URL = original;
  }
});

test('an oversized form body is refused rather than buffered', async () => {
  const res = await fetch(`${server.base}/gate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=' + 'x'.repeat(20_000),
    redirect: 'manual'
  }).catch(() => null);
  // Either a redirect back to the gate or a dropped connection; never a cookie.
  if (res) assert.equal(res.headers.get('set-cookie'), null);
});
