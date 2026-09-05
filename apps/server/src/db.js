/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/** Postgres access. One pool for the process; `pg` is the only dependency. */

import pg from 'pg';
import { config } from './config.js';

/**
 * BIGINT arrives as a string by default, because a 64-bit integer does not
 * fit a JS number. Every bigint here is either an id or a minor-unit money
 * amount, both far below 2^53, so parsing them to numbers is safe and saves
 * every report from string-to-number coercion. Row counts from COUNT() are
 * bigint too, and a report that renders "1234" as a string sorts wrongly.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
/** NUMERIC, used by the average and percentage aggregates. */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));

let pool;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({ ...config.database, max: config.poolMax });
    pool.on('error', (err) => {
      // An idle client dropped by the server. `pg` replaces it; logging and
      // carrying on is correct, and rethrowing would take the process down.
      console.error('[clickstream] idle postgres client error:', err.message);
    });
  }
  return pool;
}

/** @param {string} sql @param {unknown[]} [params] */
export async function query(sql, params = []) {
  const started = Date.now();
  const result = await getPool().query(sql, params);
  const ms = Date.now() - started;
  if (config.logLevel === 'debug') {
    console.debug(`[clickstream] ${ms}ms ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  return result;
}

/** Rows only, for the common case. */
export async function rows(sql, params = []) {
  return (await query(sql, params)).rows;
}

/** First row, or null. */
export async function one(sql, params = []) {
  const r = await query(sql, params);
  return r.rows.length ? r.rows[0] : null;
}

/**
 * Run a function inside a transaction, on one client.
 *
 * Ingest needs this: a batch that inserts a session, then its events, then
 * order lines must not leave a session row with no events behind if the
 * process dies mid-batch.
 */
export async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already gone; the transaction is rolled back by
      // virtue of never having been committed.
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
