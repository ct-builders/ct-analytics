/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * A browser-shaped scope for testing `clickstream.js` with no server and no
 * database — the transport is captured instead of sent.
 *
 * The file under test is the one that ships. Re-implementing its logic in a
 * test double would prove nothing about it.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BROWSER_FILE = join(here, '..', 'clickstream.js');

function storage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    _map: map
  };
}

/**
 * Load the client into a fake page.
 *
 * @param {{ path?: string, config?: object, dataset?: object,
 *           src?: string, storages?: object }} [opts]
 */
export async function loadPage(opts = {}) {
  const sent = [];
  const listeners = new Map();
  const clicks = [];
  const addListener = (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(fn);
  };

  const scriptEl = { src: opts.src ?? '/c.js?site=test', dataset: opts.dataset ?? {} };
  const beacons = [];

  const doc = {
    currentScript: scriptEl,
    title: 'Test',
    referrer: opts.referrer ?? '',
    visibilityState: 'visible',
    readyState: 'complete',
    addEventListener: addListener,
    createElement: () => ({}),
    head: { appendChild: () => {} },
    getElementsByTagName: () => [scriptEl]
  };

  const durable = opts.storages?.durable ?? storage();
  const perTab = opts.storages?.perTab ?? storage();

  const win = {
    addEventListener: addListener,
    localStorage: durable,
    sessionStorage: perTab,
    crypto: globalThis.crypto,
    console,
    // Captured rather than posted, so a test asserts on the payload.
    fetch: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
    history: {
      pushState() {},
      replaceState() {}
    }
  };
  // `auto` defaults OFF in the harness, not in the product: most unit tests
  // assert on an exact event list, and an automatic page view would be noise
  // in every one of them. The tests that cover auto reporting opt back in.
  win.CLICKSTREAM_CONFIG = {
    endpoint: '/collect',
    flushInterval: 5,
    auto: false,
    ...(opts.config || {})
  };

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
    navigator: {
      sendBeacon: (url, blob) => {
        beacons.push({ url, blob });
        return true;
      }
    },
    localStorage: durable,
    sessionStorage: perTab,
    Blob: globalThis.Blob,
    XMLHttpRequest: undefined
  };
  // defineProperty: `globalThis.navigator` is a getter-only accessor in Node,
  // so a plain assignment throws.
  for (const [k, v] of Object.entries(scope)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }

  // Seed the install stub's queue when a test wants the replay path.
  if (opts.pending) win.clickstream = { q: opts.pending };

  const source = await readFile(BROWSER_FILE, 'utf8');
  (0, eval)(source);

  return {
    clickstream: win.clickstream,
    sent,
    beacons,
    /** Every event across every request so far. */
    events: () => sent.flatMap((r) => r.body.events),
    byType: (type) => sent.flatMap((r) => r.body.events).filter((e) => e.type === type),
    /** Simulate a click on an element carrying data-clickstream attributes. */
    click(dataset) {
      const el = { dataset, closest: () => el };
      for (const fn of listeners.get('click') ?? []) fn({ target: el });
    },
    fire(name) {
      for (const fn of listeners.get(name) ?? []) fn();
    },
    navigate(path) {
      const i = path.indexOf('?');
      loc.pathname = i === -1 ? path : path.slice(0, i);
      loc.search = i === -1 ? '' : path.slice(i);
    },
    storages: { durable, perTab },
    restore() {
      for (const [k, descriptor] of Object.entries(saved)) {
        if (descriptor === undefined) delete globalThis[k];
        else Object.defineProperty(globalThis, k, descriptor);
      }
    }
  };
}

/**
 * Let the queue's flush timer fire.
 *
 * A test must not leave a timer pending past `restore()`. The client reads
 * `window.fetch` at call time rather than capturing it — correct, because a
 * real page has exactly one window — so a late timer from a torn-down page
 * posts into whichever page is current when it fires, and the failure surfaces
 * as an unrelated test intermittently seeing one extra request.
 *
 * In practice that means any test enabling `auto` should also shorten
 * `autoSearchDelay` (default 800ms) and settle afterwards.
 */
export const settle = () => new Promise((r) => setTimeout(r, 40));
