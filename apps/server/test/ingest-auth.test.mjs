/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Who is allowed to write events.
 *
 * Ingest is a write endpoint on the public internet, so every one of these
 * cases matters more than a report rendering correctly. The refusals are
 * asserted individually rather than as "not 202", because the difference
 * between 401 and 403 is the difference between "your token is wrong" and
 * "your origin is wrong", and a deployer chasing a silent analytics failure
 * needs to be told which.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { scratchDatabase, startServer, INGEST_KEY } from './helpers.mjs';

let db;
let server;
let query;
let config;

before(async () => {
  db = await scratchDatabase('ingestauth');
  ({ query } = await import('../src/db.js'));
  ({ config } = await import('../src/config.js'));
  await query("INSERT INTO sites (slug, name) VALUES ('open-site', 'No allowlist')");
  await query(
    `INSERT INTO sites (slug, name, origins)
          VALUES ('listed', 'Has allowlist', ARRAY['https://shop.example'])`
  );
  server = await startServer();
});

after(async () => {
  await server?.close();
  await db?.drop();
});

let counter = 0;
function payload(site = 'listed') {
  counter += 1;
  return JSON.stringify({
    site,
    anonymousId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    sessionId: `ffffffff-bbbb-4ccc-8ddd-${String(counter).padStart(12, '0')}`,
    events: [{ type: 'page_view', pageType: 'home', ts: new Date().toISOString() }]
  });
}

function post({ token, origin, site } = {}) {
  /** @type {Record<string,string>} */
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  return fetch(`${server.base}/collect`, { method: 'POST', headers, body: payload(site) });
}

/* ------------------------------------------------------- the token path */

test('the correct token writes', async () => {
  const res = await post({ token: INGEST_KEY });
  assert.equal(res.status, 202);
  assert.equal((await res.json()).accepted, 1);
});

test('no credential at all is refused, and says what to do', async () => {
  const res = await post({});
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(body.error, /requires a bearer token/);
  assert.match(body.error, /your own backend/, 'points at the fix, not just the failure');
});

test('a wrong token is refused as a token problem, not an origin problem', async () => {
  const res = await post({ token: 'not-the-key' });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /invalid ingest token/);
});

test('a token that is a prefix of the real one is refused', async () => {
  const res = await post({ token: INGEST_KEY.slice(0, -1) });
  assert.equal(res.status, 401);
});

test('a token with the real one as a prefix is refused', async () => {
  const res = await post({ token: `${INGEST_KEY}x` });
  assert.equal(res.status, 401);
});

test('an empty bearer value is refused', async () => {
  const res = await fetch(`${server.base}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' },
    body: payload()
  });
  assert.equal(res.status, 401);
});

test('nothing was written by any of the refused requests', async () => {
  // The refusal happens before the database is touched, so a rejected write
  // cannot leave a shopper or session row behind.
  const r = await query('SELECT COUNT(*)::int AS n FROM events');
  assert.equal(r.rows[0].n, 1, 'only the one authorised write above');
});

/* ------------------------------------------- the browser-direct path */

test('an Origin alone is refused while browser ingest is off', async () => {
  assert.equal(config.ingestAllowBrowser, false, 'off by default');
  const res = await post({ origin: 'https://shop.example' });
  assert.equal(res.status, 401);
});

test('browser ingest accepts an allowlisted origin', async () => {
  config.ingestAllowBrowser = true;
  try {
    const res = await post({ origin: 'https://shop.example', site: 'listed' });
    assert.equal(res.status, 202);
  } finally {
    config.ingestAllowBrowser = false;
  }
});

test('browser ingest refuses an origin that is not on the list', async () => {
  config.ingestAllowBrowser = true;
  try {
    const res = await post({ origin: 'https://evil.example', site: 'listed' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /origin not allowed/);
  } finally {
    config.ingestAllowBrowser = false;
  }
});

test('browser ingest refuses a site with no allowlist', async () => {
  // "Authenticated by Origin" against a list that permits everything is not
  // authentication, so an empty list is a refusal rather than a wildcard.
  config.ingestAllowBrowser = true;
  try {
    const res = await post({ origin: 'https://anywhere.example', site: 'open-site' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /needs an origin allowlist/);
  } finally {
    config.ingestAllowBrowser = false;
  }
});

test('browser ingest refuses a request with no Origin', async () => {
  config.ingestAllowBrowser = true;
  try {
    const res = await post({ site: 'listed' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /missing Origin/);
  } finally {
    config.ingestAllowBrowser = false;
  }
});

test('a token still works while browser ingest is on', async () => {
  config.ingestAllowBrowser = true;
  try {
    const res = await post({ token: INGEST_KEY, site: 'listed' });
    assert.equal(res.status, 202);
  } finally {
    config.ingestAllowBrowser = false;
  }
});

/* ----------------------------------------------- what must stay open */

test('preflight needs no credential, or the browser never gets to send one', async () => {
  const res = await fetch(`${server.base}/collect?site=listed`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://shop.example', 'Access-Control-Request-Method': 'POST' }
  });
  assert.equal(res.status, 204);
});

test('the client script needs no credential', async () => {
  const res = await fetch(`${server.base}/c.js?site=listed`, { redirect: 'manual' });
  assert.equal(res.status, 200);
});

test('health needs no credential', async () => {
  const res = await fetch(`${server.base}/health`, { redirect: 'manual' });
  assert.equal(res.status, 200);
});

/* ------------------------------------------------- startup refusals */

test('a collector with no credential refuses to start', async () => {
  const { ingestConfigProblems } = await import('../src/collector.js');
  const key = config.ingestKey;
  const browser = config.ingestAllowBrowser;
  try {
    config.ingestKey = '';
    config.ingestAllowBrowser = false;
    const problems = ingestConfigProblems();
    assert.equal(problems.length, 1);
    assert.match(problems[0], /no credential/);
  } finally {
    config.ingestKey = key;
    config.ingestAllowBrowser = browser;
  }
});

test('a short ingest key is refused at startup', async () => {
  const { ingestConfigProblems } = await import('../src/collector.js');
  const key = config.ingestKey;
  try {
    config.ingestKey = 'short';
    const problems = ingestConfigProblems();
    assert.ok(problems.some((p) => /shorter than 24/.test(p)));
    assert.ok(problems.some((p) => /openssl rand/.test(p)), 'tells you how to make one');
  } finally {
    config.ingestKey = key;
  }
});

test('browser-only ingest is a sound configuration on its own', async () => {
  const { ingestConfigProblems } = await import('../src/collector.js');
  const key = config.ingestKey;
  const browser = config.ingestAllowBrowser;
  try {
    config.ingestKey = '';
    config.ingestAllowBrowser = true;
    assert.deepEqual(ingestConfigProblems(), [], 'explicitly opted into, so allowed');
  } finally {
    config.ingestKey = key;
    config.ingestAllowBrowser = browser;
  }
});
