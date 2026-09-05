/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Traffic generator.
 *
 * Two jobs from one behaviour model:
 *
 *   SEEDING — give a storefront's analytics a believable past, so a walkthrough opens
 *   on inhabited reports instead of empty ones. `--mode synth` writes weeks of
 *   history in under a minute.
 *
 *   VERIFYING — drive a real browser through the real storefront and check
 *   that what the tracking captured matches what the shopper was told to do.
 *   `--mode browser`, then `reconcile.js`.
 *
 * Both modes execute the same intent scripts, so seeded history and live
 * traffic are the same shape and the join does not show.
 *
 *   node tools/traffic/run.js --profile thegoodstore --sessions 800 --days 45
 *   node tools/traffic/run.js --profile thegoodstore --mode browser --sessions 12
 *   node tools/traffic/run.js --profile thegoodstore --dry-run
 */

import { randomUUID } from 'node:crypto';
import { buildSession, buildShopperPool, rng, sessionStartedAt } from './lib/behaviour.js';
import { expectedFunnel, PERSONAS } from './lib/personas.js';
import { listProfiles, loadProfile } from './lib/profile.js';
import { expectedCounts, openLog, sessionRecord } from './lib/log.js';
import { pickUserAgent, postSession, synthesize } from './drivers/synth.js';

/* ------------------------------------------------------------------- args */

function args(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const a = args(process.argv);
const num = (v, d) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
};

const opts = {
  profile: a.profile || process.env.CLICKSTREAM_PROFILE || 'thegoodstore',
  mode: a.mode || 'synth',
  sessions: num(a.sessions, 200),
  days: num(a.days, 30),
  seed: num(a.seed, 20260905),
  concurrency: num(a.concurrency, 8),
  target: a.target || process.env.CLICKSTREAM_TARGET_URL || '',
  endpoint: a.endpoint || process.env.CLICKSTREAM_ENDPOINT || '',
  ingestKey: process.env.CLICKSTREAM_INGEST_KEY || '',
  log: a.log === true ? defaultLogPath() : a.log || defaultLogPath(),
  dryRun: Boolean(a['dry-run']),
  customers: num(a.customers, 12),
  quiet: Boolean(a.quiet),
  headed: Boolean(a.headed),
  loop: Boolean(a.loop),
  ratePerMinute: num(a['rate-per-minute'], 30)
};

function defaultLogPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `tools/traffic/log/${stamp}.jsonl`;
}

if (a.help || a.h) {
  console.log(`
Traffic generator — seeds realistic data and verifies tracking accuracy.

  --profile <id>        store profile (default thegoodstore; available: see below)
  --mode synth|browser  synth posts events directly; browser drives a real page
  --sessions <n>        sessions to generate (default 200)
  --days <n>            spread history over this many days (default 30, synth only)
  --seed <n>            PRNG seed; same seed, same data (default 20260905)
  --concurrency <n>     parallel sessions (default 8)
  --customers <n>       size of the signed-in customer pool (default 12)
  --target <url>        storefront base URL (browser mode) [CLICKSTREAM_TARGET_URL]
  --endpoint <url>      collector /collect URL (synth mode) [CLICKSTREAM_ENDPOINT]
  --log <path>          action log; this is the ground truth for reconcile.js
  --loop                keep generating, at --rate-per-minute, until stopped
  --rate-per-minute <n> sessions per minute in --loop mode (default 30)
  --headed              show the browser (browser mode)
  --dry-run             print the implied funnel and one sample session, write nothing
  --quiet               only print the summary

CLICKSTREAM_INGEST_KEY must be set for synth mode — ingest is authenticated.

Profiles available: ${(await listProfiles()).join(', ')}
`);
  process.exit(0);
}

/* --------------------------------------------------------------- customers */

/**
 * The signed-in shopper pool.
 *
 * Emails are derived from the profile id and an index rather than invented, so
 * the same run always produces the same people and the Sign-ins report
 * shows the same names tomorrow.
 */
function buildCustomers(profile, count) {
  const first = ['jen', 'sam', 'alex', 'robin', 'casey', 'morgan', 'riley', 'jordan',
    'quinn', 'avery', 'harper', 'rowan', 'sasha', 'noor', 'kai', 'devon'];
  return Array.from({ length: count }, (_, i) => ({
    id: `${profile.site}-c${i + 1}`,
    email: `${first[i % first.length]}${i >= first.length ? i : ''}@example.com`,
    password: process.env.CLICKSTREAM_CUSTOMER_PASSWORD || '123'
  }));
}

/* -------------------------------------------------------------------- main */

async function main() {
  const profile = await loadProfile(opts.profile);
  const rand = rng(opts.seed);
  const customers = buildCustomers(profile, opts.customers);

  if (opts.dryRun) return dryRun(profile, rand, customers);

  if (opts.mode === 'synth' && !opts.endpoint) {
    fail('--endpoint (or CLICKSTREAM_ENDPOINT) is required in synth mode');
  }
  if (opts.mode === 'synth' && !opts.ingestKey) {
    fail('CLICKSTREAM_INGEST_KEY is required — the collector authenticates ingest');
  }
  if (opts.mode === 'browser' && !opts.target) {
    fail('--target (or CLICKSTREAM_TARGET_URL) is required in browser mode');
  }

  const log = openLog(opts.log);
  const pool = buildShopperPool({
    rand,
    sessions: opts.sessions,
    customers,
    newId: () => randomUUID()
  });

  say(`profile   ${profile.label} (site "${profile.site}")`);
  say(`mode      ${opts.mode}`);
  say(`sessions  ${opts.sessions}${opts.loop ? ` then looping at ${opts.ratePerMinute}/min` : ''}`);
  if (opts.mode === 'synth') say(`history   ${opts.days} days`);
  say(`shoppers  ${pool.length} browsers, ${customers.length} known customers`);
  say(`log       ${log.path}`);
  say('');

  const driver = opts.mode === 'browser'
    ? await (await import('./drivers/browser.js')).createBrowserDriver({ profile, opts })
    : null;

  const stats = {
    sessions: 0, events: 0, rejected: 0, failed: 0,
    byPersona: {}, byOutcome: {}, skipped: {}
  };
  const now = Date.now();

  const queue = [];
  for (let i = 0; i < opts.sessions; i++) {
    const shopper = pool[Math.floor(rand() * pool.length)];
    const startedAt = opts.mode === 'browser'
      ? new Date()
      : sessionStartedAt(rand, { now, days: opts.days });
    const session = buildSession({ rand, profile, shopper, startedAt });
    // Its own derived seed. The scripts are built sequentially and so are
    // deterministic, but the drivers also draw randomness (dwell times, user
    // agents) and they run concurrently — sharing one generator across
    // workers would make the output depend on scheduling order.
    session.seed = (opts.seed + index_seed(i)) >>> 0;
    queue.push(session);
  }
  // Chronological, so a backfill inserts history in the order it happened and
  // the session upsert never has to reorder itself.
  queue.sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt));

  let cursor = 0;
  const workers = Array.from({ length: Math.min(opts.concurrency, queue.length) }, () =>
    (async () => {
      for (;;) {
        const index = cursor++;
        if (index >= queue.length) return;
        const session = queue[index];
        try {
          const outcome = driver
            ? await driver.run(session)
            : await runSynth(session, { profile });
          // Held to what the driver ACTUALLY DID. A step it could not perform
          // — a control that moved, a checkout needing a payment method it
          // does not have — must not be counted as missing tracking, or the
          // one report that has to be trustworthy cries wolf.
          const expected = expectedCounts(
            outcome.performed ? { ...session, steps: outcome.performed } : session
          );
          stats.sessions += 1;
          stats.events += outcome.accepted ?? 0;
          stats.rejected += outcome.rejected?.length ?? 0;
          stats.byPersona[session.persona] = (stats.byPersona[session.persona] || 0) + 1;
          for (const s2 of outcome.skipped ?? []) {
            const label = `${s2.t}: ${s2.reason}`;
            stats.skipped[label] = (stats.skipped[label] || 0) + 1;
          }
          const last = session.steps[session.steps.length - 1];
          const reason = last?.reason ?? 'completed';
          stats.byOutcome[reason] = (stats.byOutcome[reason] || 0) + 1;
          log.write(sessionRecord({
            session, sessionId: outcome.sessionId, driver: opts.mode, profile, outcome, expected
          }));
          if (!opts.quiet && stats.sessions % 50 === 0) {
            say(`  ${stats.sessions}/${queue.length} sessions, ${stats.events} events`);
          }
        } catch (err) {
          stats.failed += 1;
          log.write(sessionRecord({
            session, sessionId: null, driver: opts.mode, profile,
            outcome: { accepted: 0 }, expected: expectedCounts(session), error: err
          }));
          if (stats.failed <= 3) console.error(`  session failed: ${err.message}`);
          if (stats.failed === 4) console.error('  (further failures suppressed; see the log)');
        }
      }
    })()
  );

  await Promise.all(workers);
  if (driver?.close) await driver.close();
  await log.close();

  say('');
  say(`done: ${stats.sessions} sessions, ${stats.events} events accepted`);
  if (stats.rejected) say(`WARNING: ${stats.rejected} events rejected by the collector`);
  if (stats.failed) say(`WARNING: ${stats.failed} sessions failed`);
  if (Object.keys(stats.skipped).length) {
    say('');
    say('steps the driver could not perform (not tracking failures):');
    for (const [k, v] of Object.entries(stats.skipped).sort((x, y) => y[1] - x[1])) {
      say(`  ${k.padEnd(28)} ${v}`);
    }
  }
  say('');
  say('by persona:');
  for (const [k, v] of Object.entries(stats.byPersona).sort((x, y) => y[1] - x[1])) {
    say(`  ${k.padEnd(20)} ${String(v).padStart(5)}  ${pct(v, stats.sessions)}`);
  }
  say('how sessions ended:');
  for (const [k, v] of Object.entries(stats.byOutcome).sort((x, y) => y[1] - x[1])) {
    say(`  ${k.padEnd(20)} ${String(v).padStart(5)}  ${pct(v, stats.sessions)}`);
  }
  say('');
  say(`next: node tools/traffic/reconcile.js --log ${log.path}`);
}

async function runSynth(session, { profile }) {
  const local = rng(session.seed);
  const { payload } = synthesize(session, { profile, rand: local });
  const { accepted, rejected } = await postSession(payload, {
    endpoint: opts.endpoint,
    ingestKey: opts.ingestKey,
    userAgent: pickUserAgent(local)
  });
  return { sessionId: payload.sessionId, accepted, rejected, events: payload.events.length };
}

function dryRun(profile, rand, customers) {
  const funnel = expectedFunnel();
  say(`profile ${profile.label} — ${profile.products.length} products, ` +
      `${profile.categories.length} categories, ${profile.searchTerms.length} search terms, ` +
      `${profile.searchMisses.length} miss terms`);
  say('');
  say('persona mix:');
  const total = PERSONAS.reduce((n, p) => n + p.weight, 0);
  for (const p of PERSONAS) {
    say(`  ${p.key.padEnd(20)} ${String(Math.round((p.weight / total) * 100)).padStart(3)}%  ${p.label}`);
  }
  say('');
  say('implied funnel (share of sessions reaching each step):');
  for (const [k, v] of Object.entries(funnel)) {
    say(`  ${k.padEnd(10)} ${(v * 100).toFixed(1).padStart(5)}%`);
  }
  say('');
  const shopper = buildShopperPool({ rand, sessions: 10, customers, newId: () => randomUUID() })[0];
  const sample = buildSession({ rand, profile, shopper, startedAt: new Date() });
  say(`sample session (persona: ${sample.persona}, signedIn: ${sample.signedIn}):`);
  for (const step of sample.steps) {
    const detail = [step.term, step.slug, step.product?.sku, step.rank && `rank ${step.rank}`,
      step.name && step.value && `${step.name}=${step.value}`, step.reason]
      .filter(Boolean).join(' ');
    say(`  ${step.t.padEnd(16)} ${detail}`);
  }
  say('');
  const { payload } = synthesize(sample, { profile, rand });
  say(`that session becomes ${payload.events.length} events:`);
  say(`  ${payload.events.map((e) => e.type).join(' → ')}`);
  say('');
  say('nothing was written (--dry-run)');
}

/** Spread session indices across the seed space so derived seeds differ widely. */
function index_seed(i) {
  return Math.imul(i + 1, 0x9e3779b1);
}

const say = (s) => { if (!opts.quiet || !s) console.log(s); };
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');
function fail(message) {
  console.error(`[traffic] ${message}`);
  process.exit(1);
}

try {
  await main();
} catch (err) {
  console.error(`[traffic] ${err.message}`);
  process.exitCode = 1;
}
