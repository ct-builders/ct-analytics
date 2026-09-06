/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSession } from './reconcile.js';

const baseRecord = {
  sessionId: 's1',
  persona: 'researcher',
  driver: 'browser',
  customer: null,
  expected: { facet_apply: 1, facet_remove: 1 }
};

test('a facet skipped before a performed one is not blamed for the performed one\'s value', () => {
  // The intent asked for two facets; the live listing only offered a control
  // for the second, so the first is skipped. `steps` (the full intent) still
  // lists both, in order — `performedSteps` has only the one the driver
  // actually clicked.
  const record = {
    ...baseRecord,
    steps: [
      { t: 'applyFacet', facet: 'eco-claims=low-voc-finish' },
      { t: 'applyFacet', facet: 'eco-claims=recycled-steel' },
      { t: 'removeFacet', facet: 'eco-claims=recycled-steel' }
    ],
    performedSteps: [
      { t: 'applyFacet', facet: 'eco-claims=recycled-steel' },
      { t: 'removeFacet', facet: 'eco-claims=recycled-steel' }
    ]
  };
  const captured = {
    events: [
      { type: 'facet_apply', facet_name: 'eco-claims', facet_value: 'recycled-steel' },
      { type: 'facet_remove', facet_name: 'eco-claims', facet_value: 'recycled-steel' }
    ]
  };

  const findings = reconcileSession(record, captured);
  assert.deepEqual(findings, [], 'the one facet actually applied was recorded exactly right');
});

test('a genuine wrong-field mismatch is still caught against performedSteps', () => {
  const record = {
    ...baseRecord,
    steps: [{ t: 'applyFacet', facet: 'eco-claims=recycled-steel' }],
    performedSteps: [{ t: 'applyFacet', facet: 'eco-claims=recycled-steel' }],
    expected: { facet_apply: 1 }
  };
  const captured = {
    events: [{ type: 'facet_apply', facet_name: 'eco-claims', facet_value: 'organic-cotton' }]
  };

  const findings = reconcileSession(record, captured);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /facet is eco-claims=organic-cotton, expected eco-claims=recycled-steel/);
});

test('without performedSteps (synth driver), field checks fall back to the full intent', () => {
  const record = {
    ...baseRecord,
    driver: 'synth',
    steps: [{ t: 'applyFacet', facet: 'eco-claims=recycled-steel' }],
    expected: { facet_apply: 1 }
    // no performedSteps: synth never skips, so `steps` already is what ran.
  };
  const captured = {
    events: [{ type: 'facet_apply', facet_name: 'eco-claims', facet_value: 'recycled-steel' }]
  };

  const findings = reconcileSession(record, captured);
  assert.deepEqual(findings, []);
});
