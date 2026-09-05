/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * A static file server for the example storefront, plus a first-party proxy to
 * the collector.
 *
 * The proxy is the interesting part, and it is how a real site should be
 * wired: the browser posts to `/api/clickstream` on its OWN origin, and the server
 * forwards it. That keeps the request first-party, so it is unaffected by
 * tracker-blocking extensions and needs no CORS configuration at all.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, 'public');

const PORT = Number(process.env.PORT || 3000);
/** Where the Clickstream collector is listening. */
const COLLECTOR = process.env.CLICKSTREAM_COLLECTOR || 'http://localhost:8080';
const SITE = process.env.CLICKSTREAM_SITE || 'example';

/**
 * The ingest token.
 *
 * It lives HERE, on the server, and is attached below on the way out. It is
 * never sent to the browser, which is the whole point of the proxy: a token in
 * a page is readable by anyone who views source, so a browser cannot hold one.
 */
const INGEST_KEY = process.env.CLICKSTREAM_INGEST_KEY || '';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // The first-party collector proxy.
  if (url.pathname === '/api/clickstream') {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const upstream = await fetch(`${COLLECTOR}/collect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The credential the browser does not have.
          ...(INGEST_KEY ? { Authorization: `Bearer ${INGEST_KEY}` } : {}),
          // Passed through so the collector can classify the device.
          'User-Agent': req.headers['user-agent'] || 'unknown'
        },
        body: Buffer.concat(chunks)
      });
      const body = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(body);
    } catch (err) {
      // The storefront must not care that analytics is down.
      console.error(`[storefront] collector unreachable at ${COLLECTOR}: ${err.message}`);
      res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"accepted":0}');
    }
    return;
  }

  // The client itself, also proxied, so everything is same-origin.
  if (url.pathname === '/c.js') {
    try {
      const upstream = await fetch(`${COLLECTOR}/c.js`);
      res.writeHead(upstream.status, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store'
      }).end(await upstream.text());
    } catch {
      // A storefront that will not load because the tracker is down is worse
      // than one with no tracking, so serve a harmless no-op instead.
      res.writeHead(200, { 'Content-Type': 'application/javascript' })
        .end('/* clickstream collector unreachable */');
    }
    return;
  }

  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      .end(`window.CLICKSTREAM_CONFIG = ${JSON.stringify({ site: SITE, endpoint: '/api/clickstream', debug: true })};`);
    return;
  }

  // Static files, with every unknown path falling through to index.html so
  // the client-side routes work on a hard refresh.
  const rel = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  const candidate = rel === '/' ? '/index.html' : rel;
  try {
    const file = await readFile(join(PUBLIC, candidate));
    res.writeHead(200, { 'Content-Type': TYPES[extname(candidate)] || 'application/octet-stream' }).end(file);
  } catch {
    try {
      const file = await readFile(join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'Content-Type': TYPES['.html'] }).end(file);
    } catch {
      res.writeHead(404).end('not found');
    }
  }
});

server.listen(PORT, () => {
  console.log(`[storefront] http://localhost:${PORT}`);
  console.log(`[storefront] posting events to ${COLLECTOR}/collect as site "${SITE}"`);
  if (!INGEST_KEY) {
    console.warn(
      '[storefront] CLICKSTREAM_INGEST_KEY is not set — the collector will refuse every event ' +
        'with 401. Set it to the same value the collector runs with.'
    );
  }
});
