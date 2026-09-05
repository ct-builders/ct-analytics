/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Migration runner.
 *
 * Files in `migrations/` are applied in filename order and recorded in
 * `schema_migrations`, so re-running is a no-op. Each file runs inside its own
 * transaction: a migration that fails halfway leaves the schema exactly as it
 * was, rather than half-applied and unrecorded — which is the state that
 * needs a human and a psql session to untangle.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getPool, closePool, query } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', 'migrations');

async function ensureRegistry() {
  // Created outside the numbered migrations because the runner needs it
  // before it can know which of them have run.
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function migrate({ silent = false } = {}) {
  await ensureRegistry();

  const applied = new Set(
    (await query('SELECT version FROM schema_migrations')).rows.map((r) => r.version)
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const pending = files.filter((f) => !applied.has(f));

  if (!pending.length) {
    if (!silent) console.log(`[clickstream] schema up to date (${files.length} migration(s))`);
    return { applied: [], total: files.length };
  }

  const client = await getPool().connect();
  const done = [];
  try {
    for (const file of pending) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        // Name the file. "syntax error at or near" with no filename is
        // useless once there is more than one migration.
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
      done.push(file);
      if (!silent) console.log(`[clickstream] applied ${file}`);
    }
  } finally {
    client.release();
  }
  return { applied: done, total: files.length };
}

// Runnable directly: `node src/migrate.js`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await migrate();
  } catch (err) {
    console.error(`[clickstream] ${err.message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
