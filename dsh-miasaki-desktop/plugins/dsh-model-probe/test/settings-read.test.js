/**
 * Dual-track settings read coverage.
 *
 * The two worlds these cases pin:
 *  - ≤0.1.6: `ctx.settings.get(ns)` reads a registered namespace. `describe`
 *    also exists there, so the probe ORDER (`get` first) is the contract —
 *    flipping it would read the wrong shape on the old host.
 *  - 0.1.7+: `get` is gone; `describe()` projects every profile entry with
 *    volatile Config fields, `ns` = entry id, `value` = resolved value.
 *
 * Each case mirrors one failure that shipped or nearly shipped:
 * `ctx.settings.get is not a function` (the live 0.1.7 breakage), the silent
 * try/catch swallow that turned it into no-credential probes, and the
 * property-proxy throw when `settings` was never injected.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readSettingsSection } from '../lib/settings-read.js';
import { probeModel } from '../lib/index.js';

const NS = 'llm-pi-ai';

/** ≤0.1.6 settings service: get reads a registered namespace; describe also exists. */
function oldWorld(resolved) {
  return {
    get: (ns) => (ns === NS ? resolved : undefined),
    describe: () => [{ ns: 'ui-theme', value: {} }],
  };
}

/** 0.1.7 SettingsForms: no `get`; describe projects profile entry config. */
function newWorld(descriptors) {
  return { describe: () => descriptors };
}

test('≤0.1.6: get is the live read and its value rides through', () => {
  const resolved = { providers: { stepfun: { baseURL: 'https://api.stepfun.com/step_plan' } } };
  const ctx = { settings: oldWorld(resolved) };
  assert.deepEqual(readSettingsSection(ctx, NS), resolved);
});

test('≤0.1.6: get wins even though describe exists on the same service', () => {
  // 0.1.5 ships BOTH methods; the get-first probe order is what keeps the old
  // host on its own (registered-namespace) read shape.
  let describeCalls = 0;
  const ctx = {
    settings: {
      get: () => ({ providers: {} }),
      describe: () => { describeCalls += 1; return [] },
    },
  };
  readSettingsSection(ctx, NS);
  assert.equal(describeCalls, 0);
});

test('≤0.1.6: an unregistered namespace reads as null', () => {
  const ctx = { settings: oldWorld(undefined) };
  assert.equal(readSettingsSection(ctx, NS), null);
});

test('≤0.1.6: a throwing get propagates — call sites keep their own posture', () => {
  // model-probe wraps the read in try/catch (degrade to request fields);
  // free-model-pool lets the route handler report it. The helper must not
  // swallow on the old path, or that difference dies.
  const ctx = {
    settings: {
      get: () => { throw new TypeError('settings namespace "…" must match …') },
      describe: () => [],
    },
  };
  assert.throws(() => readSettingsSection(ctx, NS), TypeError);
});

test('0.1.7: describe projects the entry config and value rides through', () => {
  const value = { providers: { openrouter: { baseURL: 'https://openrouter.ai/api/v1' } } };
  const ctx = { settings: newWorld([
    { ns: 'ui-theme', value: { preference: 'system' } },
    { ns: NS, value, revision: 3 },
  ]) };
  assert.deepEqual(readSettingsSection(ctx, NS), value);
});

test('0.1.7: a namespace with no entry reads as null', () => {
  const ctx = { settings: newWorld([{ ns: 'ui-theme', value: {} }]) };
  assert.equal(readSettingsSection(ctx, NS), null);
});

test('0.1.7: an entry whose value is absent reads as null', () => {
  const ctx = { settings: newWorld([{ ns: NS, revision: 0 }]) };
  assert.equal(readSettingsSection(ctx, NS), null);
});

test('a settings service with neither method reads as null', () => {
  const ctx = { settings: {} };
  assert.equal(readSettingsSection(ctx, NS), null);
});

test('an absent settings service reads as null', () => {
  assert.equal(readSettingsSection({ settings: null }, NS), null);
  assert.equal(readSettingsSection({}, NS), null);
});

test('a throwing property proxy (settings never injected) reads as null', () => {
  // cordis: accessing a non-injected service property throws; the helper must
  // not turn that into a boot-time failure.
  const ctx = {
    get settings() { throw new Error('cannot get property "settings" without inject') },
  };
  assert.equal(readSettingsSection(ctx, NS), null);
});

// ---- wiring: resolveProfile → probeModel ----------------------------------
// The helper contract above is only half the regression; what broke on 0.1.7
// was the stored-profile read inside the probe. A saved provider row sends no
// baseURL/api in the request body (the Models page only sends drafts), so a
// failed profile read degrades the probe to defaults — and a network fetch to
// the default protocol. These cases prove the stored profile still resolves.

/** The saved row's shape: everything the probe needs lives in settings. */
const SAVED_ROW = {
  providers: {
    step: { baseURL: 'https://probe.invalid/v1', api: 'no-such-protocol', apiKeyEnv: 'MIASAKI_PROBE_TEST_KEY' },
  },
};

test('probeModel resolves the stored profile on ≤0.1.6 (get world)', async () => {
  process.env.MIASAKI_PROBE_TEST_KEY = 'k';
  try {
    const ctx = { settings: oldWorld(SAVED_ROW) };
    // The profile's own `api` is unprobeable, so the probe stops with
    // `unsupported` BEFORE any fetch — the profile was read, or `api` would
    // have defaulted to openai-completions and the probe would have fetched.
    const result = await probeModel(ctx, { provider: 'step', model: 'step-5-preview' });
    assert.equal(result.kind, 'unsupported');
    assert.equal(result.api, 'no-such-protocol');
  } finally {
    delete process.env.MIASAKI_PROBE_TEST_KEY;
  }
});

test('probeModel resolves the stored profile on 0.1.7 (describe world)', async () => {
  process.env.MIASAKI_PROBE_TEST_KEY = 'k';
  try {
    const ctx = { settings: newWorld([{ ns: NS, value: SAVED_ROW, revision: 1 }]) };
    const result = await probeModel(ctx, { provider: 'step', model: 'step-5-preview' });
    assert.equal(result.kind, 'unsupported');
    assert.equal(result.api, 'no-such-protocol');
  } finally {
    delete process.env.MIASAKI_PROBE_TEST_KEY;
  }
});
