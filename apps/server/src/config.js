/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Configuration, entirely from the environment.
 *
 * Every value has a default that works on a developer machine, so `npm run
 * dev` needs no `.env` at all. Nothing here reads a config file: a deployment
 * that needs different values sets different environment variables, which is
 * what every host this runs on already does.
 */

/** @param {string} name @param {string} fallback */
function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name, fallback) {
  const n = parseInt(env(name, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const v = env(name, '').toLowerCase();
  if (!v) return fallback;
  return v !== 'false' && v !== '0' && v !== 'no';
}

/**
 * The Postgres connection.
 *
 * `DATABASE_URL` wins when set, because that is what every managed host
 * supplies. Otherwise the parts are assembled, defaulting to a local socket
 * connection as the current OS user — which is how a stock Homebrew or
 * Debian Postgres is reachable with no password.
 */
function databaseConfig() {
  const url = env('DATABASE_URL', '');
  if (url) {
    return {
      connectionString: url,
      // Cloud SQL and most managed Postgres require TLS but present a
      // certificate for an internal hostname, so verification is off while
      // encryption stays on. A private-IP or socket connection needs neither.
      ssl: bool('DATABASE_SSL', /\bsslmode=require\b/.test(url)) ? { rejectUnauthorized: false } : false
    };
  }
  return {
    host: env('PGHOST', 'localhost'),
    port: int('PGPORT', 5432),
    database: env('PGDATABASE', 'clickstream'),
    user: env('PGUSER', process.env.USER || 'postgres'),
    password: env('PGPASSWORD', ''),
    ssl: bool('DATABASE_SSL', false) ? { rejectUnauthorized: false } : false
  };
}

export const config = {
  /**
   * `collect` runs the public ingest endpoint and serves the browser client.
   * `admin` runs the reports. `both` runs them on one port, which is the
   * development default and fine on a trusted network.
   *
   * They are separable because they have opposite exposure: the collector is
   * open to the internet by necessity, the admin must never be.
   */
  mode: env('MODE', 'both'),
  port: int('PORT', 8080),
  host: env('HOST', '0.0.0.0'),

  database: databaseConfig(),
  poolMax: int('DATABASE_POOL_MAX', 10),

  /**
   * Origins allowed to post events when a site row lists none. Empty means
   * any origin is accepted, which is right while wiring a site up and wrong for
   * production — the collector warns on startup while this is empty.
   */
  defaultOrigins: env('CLICKSTREAM_ORIGINS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Bearer token every event POST must carry.
   *
   * Ingest is a write endpoint on the public internet, so it is authenticated.
   * The caller is expected to be a SERVER — the site proxies its shoppers'
   * events through its own backend, which holds this token. That is the only
   * arrangement in which ingest is genuinely authenticated, because a secret
   * shipped to a browser is not a secret.
   */
  ingestKey: env('CLICKSTREAM_INGEST_KEY', ''),

  /**
   * Opt in to accepting posts straight from shoppers' browsers, authenticated
   * by the `Origin` header against the site's allowlist and nothing else.
   *
   * This is weaker and the docs say so plainly: `Origin` is set by the browser
   * and can be forged by anything that is not a browser. It exists because a
   * site with no backend of its own has no way to hold a token, and it is
   * off unless asked for — with a non-empty origin list required per site.
   */
  ingestAllowBrowser: bool('CLICKSTREAM_INGEST_ALLOW_BROWSER', false),

  /**
   * Shared secret required on the admin. Absent means the admin refuses to
   * start unless CLICKSTREAM_ADMIN_OPEN is also set — a reports UI silently
   * listening on 0.0.0.0 with no auth is the failure mode most worth
   * preventing, and a deploy that forgets the token should fail loudly.
   */
  adminToken: env('CLICKSTREAM_ADMIN_TOKEN', ''),
  adminOpen: bool('CLICKSTREAM_ADMIN_OPEN', false),

  /** Days of raw events kept by the retention job. 0 disables deletion. */
  retentionDays: int('CLICKSTREAM_RETENTION_DAYS', 0),

  /** Rejected-event rows kept, so a bad install stays diagnosable but bounded. */
  ingestErrorLimit: int('CLICKSTREAM_INGEST_ERROR_LIMIT', 1000),

  logLevel: env('LOG_LEVEL', 'info')
};

export function runsCollector() {
  return config.mode === 'collect' || config.mode === 'both';
}

export function runsAdmin() {
  return config.mode === 'admin' || config.mode === 'both';
}
