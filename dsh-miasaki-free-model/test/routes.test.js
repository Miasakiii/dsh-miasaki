/**
 * Route-level regression coverage for the dual-track settings read.
 *
 * The live 0.1.7 breakage was `ctx.settings.get is not a function` surfacing
 * verbatim from GET /freemodel-api/status — the Models page's free-model pool
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
const STATUS_PATH = '/freemodel-api/status';
const APPLY_PATH = '/freemodel-api/apply';

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
    // 信任围栏逐请求读 `connection`；这些用例的 composition 没有该服务 → 走结构层。
    get: () => undefined,
  });
  return async (path, body) => {
    const handler = routes.get(path);
    assert.notEqual(handler, undefined, `route ${path} must be registered`);
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = {
      method: body === undefined ? 'GET' : 'POST',
      // 结构层要求回环 Host —— 越界与顺序断言见 test/trust.test.js。
      headers: { host: '127.0.0.1:3080' },
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

test('route table: 每个路径只注册一条 exact 路由（webServer 按 path 去重）', () => {
  // 真机教训（2026-09-28，DSH 0.2.0-rc.1）：webServer 的 exact 表**按 path 去重**，
  // 同一路径注册第二条会抛 `duplicate exact route` —— 而那是 apply 期抛错，
  // 结果是**整个插件不激活**（启动日志：`1 entry did not activate`）。
  // 离线测试的 mock webServer 只往表里塞，永远看不见这条约束，所以在闸门里前移它：
  // 一个路径的多个方法必须在**同一条**路由内分派。
  const routes = [];
  apply({
    settings: { get: (ns) => (ns === NS ? STORED : undefined) },
    webServer: { register: (entry) => routes.push(entry) },
    get: () => undefined,
  });
  const paths = routes.map((entry) => entry.path);
  const duplicates = [...new Set(paths.filter((path, index) => paths.indexOf(path) !== index))];
  assert.deepEqual(duplicates, [], `同一路径注册了多条：${duplicates.join('、')}`);
  assert.equal(routes.length > 0, true, '至少要注册一条路由');
});
