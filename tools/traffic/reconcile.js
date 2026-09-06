/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Does the tracking capture what actually happened?
 *
 * Reads the action log — what each shopper was instructed to do — and compares
 * it against what the reports actually hold, session by session and field by
 * field. The log is the ground truth, so this is an exact check rather than a
 * plausibility check: the log says the shopper clicked result 3, so
 * `source_position` either says 3 or the tracking is wrong.
 *
 * Three classes of finding, in descending severity:
 *
 *   MISSING SESSION — a whole visit never arrived. Ingest, auth, or the client
 *   failing to load.
 *   MISSING EVENTS  — the session arrived but is short of a step. An
 *   un-instrumented call site, or an event lost on navigation.
 *   WRONG FIELD     — the event arrived carrying the wrong value. The most
 *   dangerous class, because the reports look populated and are subtly untrue.
 *
 *   CLICKSTREAM_GATE_PASSWORD=… node tools/traffic/reconcile.js \
 *     --log tools/traffic/log/<run>.jsonl --admin https://…
 */

import { readFile } from 'node:fs/promises';

function args(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else { out[a.slice(2)] = next; i++; }
  }
  return out;
}

// Only the CLI entry point parses argv and can exit the process — importing
// this module (the test suite does, for `reconcileSession`) must not.
const isMain = import.meta.url === `file://${process.argv[1]}`;

const a = isMain ? args(process.argv) : {};
const opts = {
  log: a.log,
  admin: (a.admin || process.env.CLICKSTREAM_ADMIN_URL || '').replace(/\/+$/, ''),
  email: a.email || process.env.CLICKSTREAM_GATE_EMAIL || 'reconcile@example.com',
  password: process.env.CLICKSTREAM_GATE_PASSWORD || '',
  token: process.env.CLICKSTREAM_ADMIN_TOKEN || '',
  json: Boolean(a.json),
  limit: Number.parseInt(String(a.limit ?? '200'), 10),
  since: a.since || ''
};

if (isMain && (!opts.log || a.help)) {
  console.log(`
Compare an action log against what the tracking captured.

  --log <path>      action log written by run.js (required)
  --admin <url>     admin base URL [CLICKSTREAM_ADMIN_URL]
  --email <addr>    email to present at the gate (default reconcile@example.com)
  --limit <n>       sessions to check per request (default 200)
  --since <iso>     only sessions logged at or after this timestamp
  --json            machine-readable output

CLICKSTREAM_GATE_PASSWORD, or CLICKSTREAM_ADMIN_TOKEN if the admin uses a token.
`);
  process.exit(opts.log ? 0 : 1);
}

/* ------------------------------------------------------------------- auth */

/**
 * Get through the gate once and keep the cookie.
 *
 * The reconciler is a client of the same gate a person uses; there is no
 * back door for it, which is the point.
 */
async function authenticate() {
  if (opts.token) return { Authorization: `Bearer ${opts.token}` };
  if (!opts.password) {
    throw new Error('set CLICKSTREAM_GATE_PASSWORD (or CLICKSTREAM_ADMIN_TOKEN)');
  }

  const res = await fetch(`${opts.admin}/gate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: opts.email, password: opts.password }),
    redirect: 'manual'
  });
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/demo_gate=([^;]+)/);
  if (!match) throw new Error(`the gate refused the password (HTTP ${res.status})`);
  return { cookie: `demo_gate=${match[1]}` };
}

/* --------------------------------------------------------------- the check */

/** Field checks, keyed by event type. Each returns a list of problems. */
const FIELD_CHECKS = {
  search(step, event, record) {
    const problems = [];
    if (event.query !== step.term) {
      problems.push(`query is ${JSON.stringify(event.query)}, expected ${JSON.stringify(step.term)}`);
    }
    if (step.expectZero && event.result_count !== 0) {
      // A zero-result search recorded as anything else silently empties the
      // report that exists to find unmet demand.
      problems.push(`zero-result search recorded result_count=${event.result_count}`);
    }
    if (step.expectZero) return problems;

    if (event.result_count === 0) {
      problems.push('search that had results recorded result_count=0');
    } else if (record.driver !== 'browser' && step.resultCount !== undefined
               && event.result_count !== step.resultCount) {
      // How many results a term returns is the STORE's answer. The profile's
      // product list is a prediction, and a live search engine is fuzzier than
      // it — a term the profile maps to one product legitimately comes back
      // with twenty-six. Holding a real listing to the prediction reports a
      // field error on nearly every search and buries the findings that
      // matter. Synth traffic is the opposite case: the driver fabricated
      // that number, so it has to come back exactly.
      problems.push(`result_count is ${event.result_count}, expected ${step.resultCount}`);
    }
    return problems;
  },

  category_view(step, event) {
    return event.category_path === step.slug
      ? []
      : [`category_path is ${JSON.stringify(event.category_path)}, expected ${JSON.stringify(step.slug)}`];
  },

  result_click(step, event) {
    const problems = [];
    if (event.sku !== step.sku) problems.push(`sku is ${event.sku}, expected ${step.sku}`);
    if (event.position !== step.rank) {
      problems.push(`position is ${event.position}, expected ${step.rank}`);
    }
    return problems;
  },

  product_view(step, event) {
    const problems = [];
    if (event.sku !== step.sku) problems.push(`sku is ${event.sku}, expected ${step.sku}`);
    // The reason the whole system exists: a product opened from a search must
    // carry that search.
    if (step.rank !== undefined && event.source_position !== step.rank) {
      problems.push(`source_position is ${event.source_position}, expected ${step.rank} (attribution lost)`);
    }
    return problems;
  },

  add_to_cart(step, event) {
    const problems = [];
    if (event.sku !== step.sku) problems.push(`sku is ${event.sku}, expected ${step.sku}`);
    if (step.quantity !== undefined && event.quantity !== step.quantity) {
      problems.push(`quantity is ${event.quantity}, expected ${step.quantity}`);
    }
    return problems;
  },

  facet_apply(step, event) {
    const expected = String(step.facet || '');
    const actual = `${event.facet_name}=${event.facet_value}`;
    return actual === expected ? [] : [`facet is ${actual}, expected ${expected}`];
  },

  order_submit(step, event) {
    return event.order_amount > 0 ? [] : [`order_amount is ${event.order_amount}`];
  }
};

/** The step kind each event type is checked against. */
const STEP_FOR_EVENT = {
  search: 'search',
  category_view: 'browseCategory',
  result_click: 'clickResult',
  product_view: 'viewProduct',
  add_to_cart: 'addToCart',
  facet_apply: 'applyFacet',
  order_submit: 'placeOrder'
};

export function reconcileSession(record, captured) {
  /** @type {{level: string, message: string}[]} */
  const findings = [];

  if (!captured || captured.missing) {
    findings.push({
      level: 'missing-session',
      message: `session ${record.sessionId ?? '(none recorded)'} never arrived ` +
        `(persona ${record.persona}, ${record.steps.length} steps)`
    });
    return findings;
  }

  // 1. Counts per event type.
  const actual = {};
  for (const e of captured.events) actual[e.type] = (actual[e.type] || 0) + 1;
  for (const [type, want] of Object.entries(record.expected)) {
    const got = actual[type] || 0;

    // Page views are the one count nothing can predict on a real storefront.
    // A route that redirects on arrival, a sign-in that lands elsewhere and a
    // product view that follows a result click without navigating all move
    // the count away from one-per-step; counting the driver's own navigations
    // instead fails the other way, because a framework router's soft
    // navigations are not all reported to it. Either way the check was
    // reporting correct tracking as broken, so browser traffic is held to
    // what actually matters here: page views arrived at all. Synth traffic
    // still counts them exactly — there the driver fabricated them — and the
    // events that carry the reports, the searches and views and clicks, are
    // exact in both modes.
    if (type === 'page_view' && record.driver === 'browser') {
      if (got === 0) {
        findings.push({ level: 'missing-events', message: 'page_view: none captured at all' });
      }
      continue;
    }

    if (got < want) {
      findings.push({
        level: 'missing-events',
        message: `${type}: captured ${got}, expected ${want}`
      });
    } else if (got > want) {
      findings.push({
        level: 'extra-events',
        message: `${type}: captured ${got}, expected ${want} (double-counted?)`
      });
    }
  }

  // 2. Fields, matching each expected step against the captured events of
  //    that type in order.
  //
  // Walks `performedSteps` (what the driver actually got through) rather than
  // `steps` (the full intent) when it is available. A skipped step of the same
  // kind ahead of a real one — a facet the live listing never offered, a
  // control that moved — would otherwise shift every later comparison by one
  // slot and blame the tracking for a value it was never given the chance to
  // record.
  const stepSource = record.performedSteps ?? record.steps;
  for (const [eventType, stepKind] of Object.entries(STEP_FOR_EVENT)) {
    const steps = stepSource.filter((s) => s.t === stepKind);
    const events = captured.events.filter((e) => e.type === eventType);
    const check = FIELD_CHECKS[eventType];
    if (!check) continue;
    for (let i = 0; i < Math.min(steps.length, events.length); i++) {
      for (const problem of check(steps[i], events[i], record)) {
        findings.push({ level: 'wrong-field', message: `${eventType}[${i}]: ${problem}` });
      }
    }
  }

  // 3. Identity and session dimensions.
  // Whether this visit signed in is what the driver DID, not what the script
  // asked for. A sign-in it could not complete is recorded as skipped and left
  // out of the expected counts, and expecting the customer anyway blames the
  // tracking for a step that never happened.
  const signedIn = Boolean(record.expected?.login);
  if (signedIn && record.customer && captured.customerRef !== record.customer) {
    findings.push({
      level: 'wrong-field',
      message: `customer_ref is ${JSON.stringify(captured.customerRef)}, expected ${JSON.stringify(record.customer)}`
    });
  }
  if (!signedIn && captured.customerRef) {
    findings.push({
      level: 'wrong-field',
      message: `anonymous session carries customer_ref ${JSON.stringify(captured.customerRef)}`
    });
  }

  return findings;
}

/* -------------------------------------------------------------------- main */

async function main() {
  if (!opts.admin) throw new Error('--admin (or CLICKSTREAM_ADMIN_URL) is required');

  const lines = (await readFile(opts.log, 'utf8')).split('\n').filter(Boolean);
  let records = lines.map((l) => JSON.parse(l));
  if (opts.since) records = records.filter((r) => r.at >= opts.since);
  const usable = records.filter((r) => r.sessionId);
  const failedToRun = records.filter((r) => !r.sessionId);

  if (!usable.length) {
    console.log(`no sessions with an id in ${opts.log}${opts.since ? ` since ${opts.since}` : ''}`);
    if (failedToRun.length) console.log(`${failedToRun.length} session(s) failed while generating`);
    return;
  }

  const auth = await authenticate();
  const site = usable[0].site;

  /** @type {Map<string, any>} */
  const captured = new Map();
  for (let i = 0; i < usable.length; i += opts.limit) {
    const batch = usable.slice(i, i + opts.limit);
    const url = `${opts.admin}/api/session-events?site=${encodeURIComponent(site)}` +
      `&sessions=${encodeURIComponent(batch.map((r) => r.sessionId).join(','))}`;
    const res = await fetch(url, {
      headers: { ...(auth.cookie ? { cookie: auth.cookie } : {}), ...(auth.Authorization ? { Authorization: auth.Authorization } : {}) }
    });
    if (!res.ok) throw new Error(`admin returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    for (const s of body.sessions) captured.set(s.sessionKey, s);
  }

  const byLevel = {};
  const perSession = [];
  let clean = 0;

  for (const record of usable) {
    const findings = reconcileSession(record, captured.get(record.sessionId));
    if (!findings.length) { clean += 1; continue; }
    perSession.push({ sessionId: record.sessionId, persona: record.persona, findings });
    for (const f of findings) {
      byLevel[f.level] = byLevel[f.level] || [];
      byLevel[f.level].push(f.message);
    }
  }

  // Coverage counts a browser session's page views as satisfied whenever they
  // came in under the navigation ceiling, for the same reason the check does:
  // a framework router navigates for things that are not new pages, so the
  // ceiling is an upper bound, not a target. Counting the shortfall as a miss
  // reads as 80% coverage on a run where every semantic event landed — and a
  // headline number that cries wolf is one nobody looks at.
  const totalExpected = usable.reduce((n, r) => {
    const seen = captured.get(r.sessionId);
    return n + Object.entries(r.expected).reduce((m, [type, want]) => {
      if (type !== 'page_view' || r.driver !== 'browser' || !seen) return m + want;
      const got = seen.events.filter((e) => e.type === 'page_view').length;
      return m + Math.min(want, got);
    }, 0);
  }, 0);
  const totalCaptured = [...captured.values()].reduce((n, s) => n + s.events.length, 0);

  const report = {
    log: opts.log,
    site,
    sessionsChecked: usable.length,
    sessionsClean: clean,
    sessionsWithFindings: perSession.length,
    generationFailures: failedToRun.length,
    eventsExpected: totalExpected,
    eventsCaptured: totalCaptured,
    coverage: totalExpected ? totalCaptured / totalExpected : 1,
    findingsByLevel: Object.fromEntries(Object.entries(byLevel).map(([k, v]) => [k, v.length])),
    sample: perSession.slice(0, 10)
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = perSession.length ? 1 : 0;
    return;
  }

  console.log(`\nreconcile — ${opts.log}`);
  console.log(`  site              ${site}`);
  console.log(`  sessions checked  ${usable.length}`);
  console.log(`  clean             ${clean} (${((clean / usable.length) * 100).toFixed(1)}%)`);
  console.log(`  with findings     ${perSession.length}`);
  if (failedToRun.length) console.log(`  failed to generate ${failedToRun.length}`);
  console.log(`  events expected   ${totalExpected}`);
  console.log(`  events captured   ${totalCaptured}`);
  console.log(`  coverage          ${(report.coverage * 100).toFixed(1)}%`);

  if (!perSession.length) {
    console.log('\n  no discrepancies. Every logged action is in the reports with the right values.\n');
    return;
  }

  console.log('\nfindings by class:');
  const order = ['missing-session', 'missing-events', 'wrong-field', 'extra-events'];
  for (const level of order) {
    const list = byLevel[level];
    if (!list?.length) continue;
    console.log(`\n  ${level} (${list.length})`);
    const counts = {};
    for (const m of list) {
      // Collapse the varying parts so recurring problems group together.
      const shape = m.replace(/\b\d+\b/g, 'N').replace(/"[^"]*"/g, '"…"');
      counts[shape] = (counts[shape] || 0) + 1;
    }
    const examples = {};
    for (const m of list) {
      const shape = m.replace(/\b\d+\b/g, 'N').replace(/"[^"]*"/g, '"…"');
      if (!examples[shape]) examples[shape] = m;
    }
    for (const [shape, n] of Object.entries(counts).sort((x, y) => y[1] - x[1]).slice(0, 8)) {
      console.log(`    ${String(n).padStart(4)} × ${shape}`);
      if (examples[shape] !== shape) console.log(`           e.g. ${examples[shape]}`);
    }
  }
  console.log('');
  process.exitCode = 1;
}

if (isMain) {
  try {
    await main();
  } catch (err) {
    console.error(`[reconcile] ${err.message}`);
    process.exitCode = 2;
  }
}
