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
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, readBody } from '../lib/index.js';

const NS = 'llm-pi-ai';
const STATUS_PATH = '/freemodel-api/status';
const APPLY_PATH = '/freemodel-api/apply';
const DETECT_PATH = '/freemodel-api/detect';
const SUBAGENT_PATH = '/freemodel-api/subagent';

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

/** Boot apply() with one world's settings service; returns a caller with status + body. */
function bootRaw(settings) {
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
      destroyed: false,
      destroy() { this.destroyed = true },
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
    return { status: res.status, body: JSON.parse(res.payload), req };
  };
}

/** Boot apply() with one world's settings service; resolves to the JSON body only. */
function boot(settings) {
  const call = bootRaw(settings);
  return async (path, body) => (await call(path, body)).body;
}

/** Run `fn` with USERPROFILE/HOME pointed at a throwaway dir; restores both and cleans up. */
async function withTempHome(home, fn) {
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    for (const key of ['USERPROFILE', 'HOME']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(home, { recursive: true, force: true });
  }
}

/** A throwaway user home with one installed preset (`whale`) carrying agentOptions. */
function makePresetHome() {
  const home = mkdtempSync(join(tmpdir(), 'freemodel-subagent-'));
  const dir = join(home, '.dsh', '.agent-presets', 'whale');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'agent.cordis.yml');
  writeFileSync(file, [
    'plugins:',
    '  - id: tool-subagent',
    '    config:',
    '      agentOptions:',
    '        provider: old-provider',
    '        model: old-model',
    '        maxTokens: 1024',
    '',
  ].join('\n'), 'utf8');
  return { home, file };
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

// ── c0850：/subagent 的 model 白名单（禁换行/控制字符） ─────────────────────

test('/subagent: model 含换行/空白 → 400，且被拒请求不写预设文件', async () => {
  const { home, file } = makePresetHome();
  const before = readFileSync(file, 'utf8');
  await withTempHome(home, async () => {
    const call = bootRaw(oldWorld());
    // 报告里的 YAML 注入载荷 + 空格 + 引号/注释符：都超出模型 id 的可见字符集。
    for (const model of ['evil\n        model: injected', 'evil model', 'evil"#x']) {
      const reply = await call(SUBAGENT_PATH, { provider: 'stepfun', model });
      assert.equal(reply.status, 400, `model ${JSON.stringify(model)} 应被拒`);
      assert.equal(reply.body.ok, false);
      assert.match(reply.body.error, /非法字符/);
    }
    assert.equal(readFileSync(file, 'utf8'), before, '被拒的请求不得改写预设文件');
  });
});

test('/subagent: 合法 model 通过，写盘只有一行 model（无注入行）', async () => {
  const { home, file } = makePresetHome();
  await withTempHome(home, async () => {
    const call = bootRaw(oldWorld());
    const reply = await call(SUBAGENT_PATH, { provider: 'stepfun', model: 'z-ai/glm-5.2:free' });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.ok, true);
    assert.deepEqual(reply.body.updated, ['whale']);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^ {8}model: z-ai\/glm-5\.2:free$/m);
    // 注入判据：文件里 model: 行只应有一行（原 old-model 被替换，没有多出的注入行）。
    assert.equal(text.split('\n').filter((line) => /^\s*model:/.test(line)).length, 1);
    assert.doesNotMatch(text, /injected/);
  });
});

// ── f8129：readBody 累计上限 + aborted/error 收口 ───────────────────────────

/** A fake IncomingMessage: EventEmitter with the destroy() the route wrapper calls. */
function fakeRequest() {
  const req = new EventEmitter();
  req.destroyed = false;
  req.destroy = () => { req.destroyed = true };
  return req;
}

test('readBody: 累计超过 64 KiB → 413（不再缓冲）', async () => {
  const req = fakeRequest();
  const pending = readBody(req);
  req.emit('data', Buffer.alloc(64 * 1024 + 1, 0x20));
  await assert.rejects(pending, (error) => {
    assert.equal(error.status, 413);
    assert.match(error.message, /请求体过大/);
    return true;
  });
});

test('readBody: aborted → 400（客户端中途断开不再悬挂）', async () => {
  const req = fakeRequest();
  const pending = readBody(req);
  req.emit('aborted');
  await assert.rejects(pending, (error) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /中断/);
    return true;
  });
});

test('readBody: error → 400（读流异常不再悬挂）', async () => {
  const req = fakeRequest();
  const pending = readBody(req);
  req.emit('error', new Error('socket reset'));
  await assert.rejects(pending, (error) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /读取失败/);
    return true;
  });
});

test('readBody: 空请求体 → {}（既有语义不变）', async () => {
  const req = fakeRequest();
  const pending = readBody(req);
  req.emit('end');
  assert.deepEqual(await pending, {});
});

test('route: POST /detect 的请求体超 64 KiB → 413 并关闭连接', async () => {
  const call = bootRaw(oldWorld());
  const reply = await call(DETECT_PATH, { platform: 'stepfun', pad: 'x'.repeat(70 * 1024) });
  assert.equal(reply.status, 413);
  assert.equal(reply.body.ok, false);
  assert.match(reply.body.error, /请求体过大/);
  assert.equal(reply.req.destroyed, true, '超限请求要关闭连接，不能继续读后续字节');
});
