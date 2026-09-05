/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Test helpers: a throwaway database, and a browser-shaped global scope that
 * the real `clickstream.js` can run inside.
 *
 * The point of the fake window is that the end-to-end test drives the SAME
 * file a real site loads, over real HTTP, rather than a Node-flavoured
 * re-implementation of it. A test that exercises a parallel code path proves
 * nothing about the file that actually ships.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..', '..', '..');
const BROWSER_FILE = join(REPO_ROOT, 'packages', 'browser', 'clickstream.js');

/**
 * Create a scratch database and run the migrations into it. Each test file
 * gets its own, so they can run in any order.
 */
export async function scratchDatabase(label) {
  const name = `clickstream_test_${label}_${process.pid}`;
  await exec('dropdb', ['--if-exists', name]).catch(() => {});
  await exec('createdb', [name]);
  process.env.PGDATABASE = name;

  // Imported only after PGDATABASE is set, because config reads the
  // environment once at module load.
  const { migrate } = await import('../src/migrate.js');
  await migrate({ silent: true });

  return {
    name,
    async drop() {
      const { closePool } = await import('../src/db.js');
      await closePool();
      await exec('dropdb', ['--if-exists', name]).catch(() => {});
    }
  };
}

/** A minimal in-memory Storage. */
function storage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear()
  };
}

/**
 * Install a browser-shaped global scope and evaluate the real clickstream.js in
 * it. Returns the resulting `window.clickstream` plus controls for simulating
 * navigation and lifecycle events.
 */
export async function loadClient(opts) {
  const listeners = new Map();
  const addListener = (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(fn);
  };

  const scriptEl = { src: opts.src, dataset: {} };

  const doc = {
    currentScript: scriptEl,
    title: opts.title ?? 'Test page',
    referrer: opts.referrer ?? '',
    visibilityState: 'visible',
    readyState: 'complete',
    addEventListener: addListener,
    createElement: () => ({}),
    head: { appendChild: () => {} },
    getElementsByTagName: () => [scriptEl]
  };

  const win = {
    addEventListener: addListener,
    localStorage: storage(),
    sessionStorage: storage(),
    // Real fetch and crypto from Node, so the transport and id generation
    // under test are the production ones.
    fetch: globalThis.fetch,
    crypto: globalThis.crypto,
    console
  };
  if (opts.config) win.CLICKSTREAM_CONFIG = opts.config;

  const loc = (() => {
    const p = opts.path ?? '/';
    const i = p.indexOf('?');
    return { pathname: i === -1 ? p : p.slice(0, i), search: i === -1 ? '' : p.slice(i) };
  })();

  const saved = {};
  const scope = {
    window: win,
    document: doc,
    location: loc,
    navigator: { sendBeacon: undefined },
    localStorage: win.localStorage,
    sessionStorage: win.sessionStorage
  };
  // defineProperty rather than assignment: Node exposes `globalThis.navigator`
  // as a getter-only accessor, so a plain assignment throws.
  for (const [k, v] of Object.entries(scope)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }

  const source = await readFile(BROWSER_FILE, 'utf8');
  // Indirect eval, so the IIFE resolves the globals above rather than this
  // module's scope.
  (0, eval)(source);

  return {
    clickstream: win.clickstream,
    window: win,
    /** Move the simulated page, the way a server-rendered click would. */
    navigate(path) {
      const i = path.indexOf('?');
      loc.pathname = i === -1 ? path : path.slice(0, i);
      loc.search = i === -1 ? '' : path.slice(i);
    },
    fire(name) {
      for (const fn of listeners.get(name) ?? []) fn();
    },
    restore() {
      for (const [k, descriptor] of Object.entries(saved)) {
        if (descriptor === undefined) delete globalThis[k];
        else Object.defineProperty(globalThis, k, descriptor);
      }
    }
  };
}

/**
 * Boot the collector and admin on an ephemeral port.
 *
 * Note what is NOT here: setting CLICKSTREAM_ADMIN_TOKEN. `config.js` reads the
 * environment once at module load, and by the time this runs it has already
 * been imported through the database helpers. A test that needs a token must
 * set it at its own module top level, before the first import.
 */
export async function startServer() {
  const { createServer } = await import('node:http');
  // The SHARED pipeline, not a copy of it. A harness with its own routing
  // order is a harness that stops testing production the moment production
  // changes.
  const { handleRequest } = await import('../src/router.js');

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      res.writeHead(500).end(err.message);
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

/** Wait for a condition, so tests never depend on a fixed sleep. */
export async function until(predicate, { timeout = 5000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, interval));
  }
}
