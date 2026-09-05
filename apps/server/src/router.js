/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * The request pipeline, in one place.
 *
 * Both the server entry point and the test harness call this, so a test
 * exercises the same ordering production does. When the harness had its own
 * copy of this sequence, adding the gate to the entry point left every test
 * running against an ungated pipeline — passing, and proving nothing.
 *
 * The order encodes three rules:
 *
 * 1. Health is answered before anything else, so a platform probe never meets
 *    a redirect to the gate.
 * 2. The collector runs before the gate, and is never gated. A shopper's
 *    browser has no gate cookie, so gating ingest would silently stop every
 *    event from every instrumented site.
 * 3. The gate runs before the admin. Everything the admin serves is derived
 *    from shopper browsing behaviour.
 */

import { runsAdmin, runsCollector, config } from './config.js';
import { handleCollector } from './collector.js';
import { handleAdmin } from './admin.js';
import { gateSatisfied, handleGate, isGateEnabled, redirectToGate } from './gate.js';
import { json, parseUrl, send } from './http.js';

export async function handleRequest(req, res) {
  const { pathname } = parseUrl(req);

  if (pathname === '/health' || pathname === '/healthz') {
    json(res, 200, { ok: true, mode: config.mode, gated: isGateEnabled() });
    return;
  }

  if (runsCollector() && (await handleCollector(req, res))) return;

  if (runsAdmin()) {
    if (isGateEnabled()) {
      if (await handleGate(req, res, pathname)) return;
      if (!gateSatisfied(req)) {
        redirectToGate(res);
        return;
      }
    }
    if (await handleAdmin(req, res)) return;
  }

  send(res, 404, 'not found');
}
