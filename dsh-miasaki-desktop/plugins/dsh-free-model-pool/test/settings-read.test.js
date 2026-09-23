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
 * `ctx.settings.get is not a function` (the live 0.1.7 breakage that made the
 * Models page's free-model pool panel report it verbatim), and the
 * property-proxy throw when `settings` was never injected.
 *
 * This file is byte-identical to dsh-model-probe's copy of the same test: the
 * two plugins ship as independent `file:` packages, so the helper they exercise
 * is deliberately duplicated rather than shared across package boundaries.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readSettingsSection } from '../lib/settings-read.js';

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

test('≤0.1.6: a throwing get propagates — route handlers keep reporting it', () => {
  // free-model-pool's listPlatforms/apply are wrapped by the route envelope,
  // which turns a throw into `{ok:false,error}` for the panel. The helper must
  // not swallow on the old path, or that posture dies.
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
