/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Retention: delete raw events older than the configured window.
 *
 * Off by default. Turning it on is a decision about the site's own privacy
 * commitments, not something a module should make on the operator's behalf —
 * but a system that records shopper behaviour and never forgets any of it is
 * a liability, so this exists and the README says to set it.
 *
 * Deletes in batches. One `DELETE` over a year of events takes a lock long
 * enough to stall ingest, and a collector that returns errors during the
 * nightly cleanup loses events it will never get back.
 *
 *   CLICKSTREAM_RETENTION_DAYS=180 npm run retention
 */

import { config } from './config.js';
import { closePool, query } from './db.js';

const BATCH = 5000;

export async function runRetention({ days = config.retentionDays, silent = false } = {}) {
  if (!days || days <= 0) {
    if (!silent) console.log('[clickstream] retention disabled (CLICKSTREAM_RETENTION_DAYS is 0)');
    return { events: 0, sessions: 0, shoppers: 0 };
  }

  let events = 0;
  for (;;) {
    // Deleting by primary key from a bounded subquery keeps each statement's
    // lock footprint small and predictable.
    const res = await query(
      `DELETE FROM events
        WHERE id IN (
          SELECT id FROM events
           WHERE ts < now() - ($1 || ' days')::interval
           LIMIT ${BATCH}
        )`,
      [String(days)]
    );
    events += res.rowCount;
    if (res.rowCount < BATCH) break;
  }

  // Sessions and shoppers left with nothing behind them. Done after the
  // events, because that is the only point at which they are actually empty.
  const sessions = await query(
    `DELETE FROM sessions
      WHERE last_event_at < now() - ($1 || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = sessions.id)`,
    [String(days)]
  );
  const shoppers = await query(
    `DELETE FROM shoppers
      WHERE last_seen_at < now() - ($1 || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.shopper_id = shoppers.id)`,
    [String(days)]
  );

  const errors = await query(
    `DELETE FROM ingest_errors WHERE ts < now() - ($1 || ' days')::interval`,
    [String(days)]
  );

  if (!silent) {
    console.log(
      `[clickstream] retention (${days}d): removed ${events} events, ${sessions.rowCount} sessions, ` +
        `${shoppers.rowCount} shoppers, ${errors.rowCount} ingest errors`
    );
  }
  return {
    events,
    sessions: sessions.rowCount,
    shoppers: shoppers.rowCount,
    errors: errors.rowCount
  };
}

if (process.argv[1] && process.argv[1].endsWith('retention.js')) {
  try {
    await runRetention();
  } catch (err) {
    console.error(`[clickstream] retention failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
