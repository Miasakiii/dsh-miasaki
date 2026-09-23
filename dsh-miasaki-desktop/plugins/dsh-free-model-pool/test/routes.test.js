/**
 * Route-level regression coverage for the dual-track settings read.
 *
 * The live 0.1.7 breakage was `ctx.settings.get is not a function` surfacing
 * verbatim from GET /freepool-api/status — the Models page's free-model pool
 * panel rendered it as its error text. These cases boot the real `apply()`
 * with each world's settings service and drive the actual routes, so the
 * regression net covers the wiring, not just the helper:
 *   - /status resolves the platform list from the stored section;
 *   - /apply reads the section, merges, and writes through update().
 *
 * Only the external service is mocked: `globalThis.fetch` stands in for the
 * platform's /models endpoint. No network call leaves this file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';

const NS = 'llm-pi-ai';
const STATUS_PATH = '/freepool-api/status';
const APPLY_PATH = '/freepool-api/apply';

/** The stored section: one scan-able route (a baseURL is what qualifies). */
const STORED = {
  providers: {
    stepfun: { displayName: '阶跃', baseURL: 'https://api.example.com/v1', models: [] },
  },
};

/** One free model as a gateway's /models endpoint reports it. */
const FREE_MODEL = {
  id: 'step-free:free',
  name: 'Step Free',
  context_length: 128000,
  top_provider: { max_completion_tokens: 8192 },
  architecture: { input_modalities: ['text'] },
  supported_parameters: ['tools', 'tool_choice'],
};

/** ≤0.1.6 settings service shape (get reads registered namespaces). */
function oldWorld() {
  return { get: (ns) => (ns === NS ? STORED : undefined) };
}

/** 0.1.7 SettingsForms shape (describe projects profile entry config). */
function newWorld() {
  return { describe: () => [{ ns: NS, value: STORED, revision: 7 }] };
}

/** Boot apply() with one world's settings service; returns a route caller. */
function boot(settings) {
  const routes = new Map();
  apply({
    settings,
    webServer: { register: (entry) => routes.set(entry.path, entry.handler) },
  });
  return async (path, body) => {
    const handler = routes.get(path);
    assert.notEqual(handler, undefined, `route ${path} must be registered`);
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = {
      method: body === undefined ? 'GET' : 'POST',
      headers: {},
      on(event, cb) {
        if (event === 'data' && text !== '') cb(Buffer.from(text));
        if (event === 'end') cb();
        return this;
      },
    };
    const res = {
      status: 0,
      payload: '',
      writeHead(status) { this.status = status },
      end(chunk) { this.payload = chunk },
    };
    await handler(req, res);
    return JSON.parse(res.payload);
  };
}

/** Stand in for the platform's /models endpoint (the only external service). */
function stubModelsEndpoint() {
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://api.example.com/v1/models');
    return { ok: true, json: async () => ({ data: [FREE_MODEL] }) };
  };
}

for (const [label, world] of [['≤0.1.6', oldWorld], ['0.1.7', newWorld]]) {
  test(`${label}: /status lists the stored platforms`, async () => {
    const call = boot(world());
    const reply = await call(STATUS_PATH);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.platforms.length, 1);
    assert.equal(reply.platforms[0].id, 'stepfun');
    assert.equal(reply.platforms[0].endpoint, 'https://api.example.com/v1/models');
  });

  test(`${label}: /apply merges detected models and writes through update()`, async () => {
    const originalFetch = globalThis.fetch;
    stubModelsEndpoint();
    const writes = [];
    try {
      const settings = Object.assign(world(), {
        update: async (ns, patch) => { writes.push({ ns, patch }) },
      });
      const call = boot(settings);
      const reply = await call(APPLY_PATH, { platform: 'stepfun' });
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.equal(reply.written, 1);
      assert.equal(writes.length, 1, 'exactly one settings write per apply');
      assert.equal(writes[0].ns, NS);
      assert.deepEqual(writes[0].patch.providers.stepfun.models, [{
        id: 'step-free:free',
        name: 'Step Free',
        contextWindow: 128000,
        maxTokens: 8192,
        input: ['text'],
        compat: { supportsDeveloperRole: false, thinkingFormat: 'openrouter' },
      }]);
      assert.equal(writes[0].patch.providers.stepfun.api, 'openai-completions');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('a settings service with neither read method degrades to an empty platform list', async () => {
  // Neither DSH generation can reach this shape (both ship get or describe);
  // the posture is a quiet empty list, never a thrown route error.
  const call = boot({});
  const reply = await call(STATUS_PATH);
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.platforms, []);
});
