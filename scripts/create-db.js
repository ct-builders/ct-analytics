/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Create the local development database, then migrate it.
 *
 * Uses `createdb` from the Postgres client tools, which is what a developer
 * with a working local Postgres already has. Idempotent: an existing database
 * is left alone and only the migrations run.
 *
 *   npm run db:create
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const name = process.env.PGDATABASE || 'clickstream';

try {
  await exec('createdb', [name]);
  console.log(`[clickstream] created database ${name}`);
} catch (err) {
  const message = String(err.stderr || err.message);
  if (/already exists/i.test(message)) {
    console.log(`[clickstream] database ${name} already exists`);
  } else if (/command not found|ENOENT/i.test(message)) {
    console.error(
      '[clickstream] `createdb` is not on PATH. Install the Postgres client tools, ' +
        `or create the database yourself:\n  CREATE DATABASE ${name};`
    );
    process.exit(1);
  } else {
    console.error(`[clickstream] could not create ${name}: ${message.trim()}`);
    process.exit(1);
  }
}

process.env.PGDATABASE = name;
const { migrate } = await import('../apps/server/src/migrate.js');
const { closePool } = await import('../apps/server/src/db.js');
try {
  await migrate();
} finally {
  await closePool();
}
