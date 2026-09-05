/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * The entry point.
 *
 * One process serves the collector, the admin, or both, chosen by `MODE`.
 * They are separable because their exposure is opposite: the collector must
 * be reachable by every shopper's browser, and the admin must not be. `both`
 * is the development default and is fine on a trusted network.
 */

import { createServer } from 'node:http';
import { config, runsAdmin, runsCollector } from './config.js';
import { ingestConfigProblems, warnOnBrowserIngest } from './collector.js';
import { handleRequest } from './router.js';
import { closePool, query } from './db.js';
import { migrate } from './migrate.js';
import { send } from './http.js';
import { gateMisconfigured, gateSite, isGateEnabled } from './gate.js';

const VALID_MODES = ['collect', 'admin', 'both'];

async function main() {
  if (!VALID_MODES.includes(config.mode)) {
    console.error(`[clickstream] MODE must be one of ${VALID_MODES.join(', ')} (got ${JSON.stringify(config.mode)})`);
    process.exit(1);
  }

  // A collector that would accept unauthenticated writes does not start. The
  // failure is otherwise invisible: the reports fill up and look fine.
  if (runsCollector()) {
    const problems = ingestConfigProblems();
    if (problems.length) {
      for (const p of problems) console.error(`[clickstream] ${p}`);
      process.exit(1);
    }
    warnOnBrowserIngest();
  }

  // Fail on a bad database before binding the port, so a misconfigured deploy
  // never reports itself healthy.
  try {
    await query('SELECT 1');
  } catch (err) {
    console.error(`[clickstream] cannot reach postgres: ${err.message}`);
    console.error('[clickstream] set DATABASE_URL, or PGHOST/PGDATABASE/PGUSER/PGPASSWORD.');
    process.exit(1);
  }

  // Applying pending migrations on boot means a deploy is one step. It is safe
  // to run concurrently: each file is wrapped in a transaction and recorded,
  // so a second instance starting at the same moment applies nothing.
  try {
    await migrate({ silent: true });
  } catch (err) {
    console.error(`[clickstream] ${err.message}`);
    process.exit(1);
  }


  // Half-configured gate: one of GATE_SITE / GATE_AUTH_URL without the other.
  // Refusing to start is the only safe response, because the failure mode is
  // an open reports UI that looks gated.
  if (gateMisconfigured()) {
    console.error(
      '[clickstream] GATE_SITE and GATE_AUTH_URL must both be set or both be unset. ' +
        'Refusing to start rather than serving the reports ungated.'
    );
    process.exit(1);
  }

  if (runsAdmin() && !isGateEnabled() && !config.adminToken && !config.adminOpen) {
    console.warn(
      '[clickstream] admin has no gate and no CLICKSTREAM_ADMIN_TOKEN — every admin request will be refused. ' +
        'Set GATE_SITE + GATE_AUTH_URL, set the token, or CLICKSTREAM_ADMIN_OPEN=true on a trusted network.'
    );
  }

  // The pipeline itself lives in router.js, so the tests drive the same
  // ordering this does.
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      console.error('[clickstream] unhandled request error:', err.stack || err.message);
      send(res, 500, 'internal error');
    }
  });

  server.listen(config.port, config.host, () => {
    const base = `http://localhost:${config.port}`;
    console.log(`[clickstream] listening on ${config.host}:${config.port} (mode: ${config.mode})`);
    if (runsCollector()) {
      console.log(`[clickstream]   client   ${base}/c.js?site=<slug>`);
      console.log(`[clickstream]   collect  POST ${base}/collect`);
    }
    if (runsAdmin()) {
      if (isGateEnabled()) {
        console.log(`[clickstream]   reports  ${base}/  (gated as site "${gateSite()}")`);
      } else {
        const t = config.adminToken ? `?token=${config.adminToken}` : '';
        console.log(`[clickstream]   reports  ${base}/report/overview${t}`);
      }
    }
  });

  // Drain in-flight requests before exiting, so a rolling deploy does not
  // drop the batch that was mid-insert.
  const shutdown = async (signal) => {
    console.log(`[clickstream] ${signal} — shutting down`);
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    // Do not hang forever on a wedged keep-alive connection.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

await main();
