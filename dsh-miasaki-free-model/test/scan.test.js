/**
 * 来源 A（官方 `llm` 契约枚举）与多来源 `/scan` 路由的回归网。
 *
 * 这里钉的是 M1 的三条纪律，每一条都有明确的失败形态：
 *   ① **逐 provider 隔离** —— 一个平台挂了只进 `partial[]`。若不隔离，一个配错的
 *      平台会把整个免费模型视图打成错误页。
 *   ② **逐调用超时 + 失败回落** —— `resolveModelInfo` 挂掉时条目仍要产出（元数据留空），
 *      而不是让整轮扫描消失。
 *   ③ **能力只到能被证明的程度** —— 适配器来源不声明工具参数，就不能声称它能做子代理；
 *      画像必须把它标成"未声明 / 需实测"，而不是猜一个 false 了事。
 *
 * 免费的 L0/L1 分层也在这里锁住：L0 是 provider 级（免 Key 车道，整路由免费），
 * L1 是模型级后缀（`:free` / `-free`）。两者都不依赖任何硬编码的插件名。
 *
 * 只 mock 外部服务（`llm` 服务与 `settings`）；本文件不出网。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';
import { buildProfile } from '../lib/profile.js';
import { adapterFreeReason, freeIdReason, freeLaneOf, scanAdapterProviders } from '../lib/scan.js';

const NS = 'llm-pi-ai';
const SCAN_PATH = '/freemodel-api/scan';

/** 一个有 baseURL 的平台（来源 B 的扫描目标）。 */
const STORED = {
  providers: {
    stepfun: { displayName: '阶跃', baseURL: 'https://api.example.com/v1', models: [] },
  },
};

const FREE_LANE = { id: 'our-free-model', name: 'Our Free Model' };
const PLAIN = { id: 'openrouter', name: 'OpenRouter' };

/** 一个形状可控的 llm 服务替身。 */
function makeLlm({ providers = [], models = {}, resolved = {}, failModels = [], failResolve = [] } = {}) {
  const calls = { listModels: [], resolveModelInfo: 0 };
  return {
    calls,
    listProviders: () => providers,
    async listModels(id) {
      calls.listModels.push(id);
      if (failModels.includes(id)) throw new Error(`${id} 目录请求失败`);
      return models[id] ?? [];
    },
    async resolveModelInfo(provider, model) {
      calls.resolveModelInfo += 1;
      if (failResolve.includes(`${provider}/${model}`)) throw new Error('元数据解析失败');
      return resolved[`${provider}/${model}`] ?? null;
    },
    async listConfigurableProviders() { return [] },
  };
}

/** Boot apply() with a route table, an optional llm service and one settings world. */
function boot({ llm, settings } = {}) {
  const routes = new Map();
  apply({
    settings: settings ?? { get: (ns) => (ns === NS ? STORED : undefined) },
    webServer: { register: (entry) => routes.set(entry.path, entry.handler) },
    get: (key) => (key === 'llm' ? llm : undefined),
  });
  return async (path, body) => {
    const handler = routes.get(path);
    assert.notEqual(handler, undefined, `route ${path} must be registered`);
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = {
      method: body === undefined ? 'GET' : 'POST',
      headers: { host: '127.0.0.1:3080' },
      on(event, cb) {
        if (event === 'data' && text !== '') cb(Buffer.from(text));
        if (event === 'end') cb();
        return this;
      },
    };
    const res = { status: 0, payload: '', writeHead(s) { this.status = s }, end(c) { this.payload = c } };
    await handler(req, res);
    return JSON.parse(res.payload);
  };
}

// ── ① 免费判定分层 ──────────────────────────────────────────────────────────

test('L0：provider id/name 命中 /free/i 即免 Key 车道', () => {
  assert.equal(freeLaneOf(FREE_LANE), true);
  assert.equal(freeLaneOf({ id: 'x', name: 'Free Tier Gateway' }), true);
  assert.equal(freeLaneOf(PLAIN), false);
  assert.equal(freeLaneOf(undefined), false);
});

test('L1：模型 id 的 :free / -free 后缀', () => {
  assert.equal(freeIdReason('vendor/model:free'), 'id 以 :free / -free 结尾');
  assert.equal(freeIdReason('muse-spark-1.3-contributor-free'), 'id 以 :free / -free 结尾');
  assert.equal(freeIdReason('gpt-4o'), null);
});

test('adapterFreeReason：L0 整路由优先于 L1 后缀，都不命中返回 null', () => {
  assert.match(adapterFreeReason(FREE_LANE, { id: 'anything' }), /免 Key 车道/);
  assert.match(adapterFreeReason(PLAIN, { id: 'x-free' }), /:free \/ -free 结尾/);
  assert.equal(adapterFreeReason(PLAIN, { id: 'gpt-4o' }), null);
});

// ── ② 扫描：枚举 / 隔离 / 回落 / 缓存 ───────────────────────────────────────

test('scan：免 Key 车道的整路由模型都算免费（L0）', async () => {
  const llm = makeLlm({
    providers: [FREE_LANE],
    models: { 'our-free-model': [{ id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3' }, { id: 'plain-model', name: 'Plain' }] },
  });
  const result = await scanAdapterProviders(llm);
  assert.equal(result.available, true);
  assert.equal(result.models.length, 2, 'L0 命中后整路由免费，不受模型级后缀影响');
  assert.equal(result.sources[0].freeLane, true);
  assert.equal(result.sources[0].freeCount, 2);
  assert.equal(result.models[0].source, 'adapter');
  assert.equal(result.models[0].writable, false, '免 Key 车道不可写入 llm-pi-ai');
});

test('scan：非免 Key 车道只看 L1 后缀', async () => {
  const llm = makeLlm({
    providers: [PLAIN],
    models: { openrouter: [{ id: 'a:free' }, { id: 'b-free' }, { id: 'c-paid' }] },
  });
  const result = await scanAdapterProviders(llm);
  assert.deepEqual(result.models.map((m) => m.id).sort(), ['a:free', 'b-free']);
  assert.equal(result.sources[0].freeLane, false);
  assert.equal(result.sources[0].modelCount, 3, 'modelCount 是清单总数，freeCount 才是命中数');
  assert.equal(result.sources[0].freeCount, 2);
});

test('scan：llm 服务缺席或形状不对 → available:false，不抛', async () => {
  assert.deepEqual(await scanAdapterProviders(undefined), { available: false, sources: [], models: [], partial: [] });
  assert.deepEqual(await scanAdapterProviders({}), { available: false, sources: [], models: [], partial: [] });
});

test('scan：单个 provider 拉目录失败被隔离进 partial，其它 provider 照常', async () => {
  const llm = makeLlm({
    providers: [PLAIN, FREE_LANE],
    models: { 'our-free-model': [{ id: 'x-free' }] },
    failModels: ['openrouter'],
  });
  const result = await scanAdapterProviders(llm);
  assert.equal(result.available, true);
  assert.equal(result.partial.length, 1);
  assert.match(result.partial[0].error, /目录请求失败/);
  const failed = result.sources.find((s) => s.id === 'openrouter');
  assert.equal(failed.error !== null, true, '失败来源要留痕，不能悄悄消失');
  assert.equal(failed.freeCount, 0);
  assert.equal(result.models.length, 1, '另一个 provider 的模型不受影响');
  assert.equal(result.models[0].provider, 'our-free-model');
});

test('scan：resolveModelInfo 失败时条目仍产出，元数据留空', async () => {
  const llm = makeLlm({
    providers: [FREE_LANE],
    models: { 'our-free-model': [{ id: 'x-free', name: 'X' }] },
    failResolve: ['our-free-model/x-free'],
  });
  const result = await scanAdapterProviders(llm);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].contextWindow, null);
  assert.equal(result.models[0].maxTokens, null);
  assert.equal(result.models[0].profile.vision, false);
});

test('scan：解析结果进缓存，refresh 才重扫', async () => {
  const llm = makeLlm({
    providers: [FREE_LANE],
    models: { 'our-free-model': [{ id: 'x-free' }] },
    resolved: { 'our-free-model/x-free': { inputModalities: ['text', 'image'], context: { contextWindow: 262144 } } },
  });
  const cache = new Map();
  await scanAdapterProviders(llm, { cache });
  assert.equal(llm.calls.resolveModelInfo, 1);
  await scanAdapterProviders(llm, { cache });
  assert.equal(llm.calls.resolveModelInfo, 1, '第二次应命中缓存');
  await scanAdapterProviders(llm, { cache, refresh: true });
  assert.equal(llm.calls.resolveModelInfo, 2, 'refresh 应清缓存');
});

test('scan：官方真值进画像（视觉 / 上下文），工具能力标为未声明', async () => {
  const llm = makeLlm({
    providers: [FREE_LANE],
    models: { 'our-free-model': [{ id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3' }] },
    resolved: {
      'our-free-model/muse-spark-1.3-contributor-free': {
        inputModalities: ['text', 'image'],
        context: { contextWindow: 262144 },
        defaultMaxTokens: 32768,
        reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' },
      },
    },
  });
  const [entry] = (await scanAdapterProviders(llm)).models;
  assert.equal(entry.contextWindow, 262144);
  assert.equal(entry.maxTokens, 32768);
  assert.equal(entry.profile.vision, true);
  assert.equal(entry.profile.reasoning, true);
  assert.equal(entry.profile.longContext, false);
  assert.equal(entry.profile.toolsUnknown, true);
  assert.equal(entry.profile.canAgent, false, '未声明 ≠ 支持');
  assert.match(entry.profile.verdict, /需实测验证/);
  assert.match(entry.profile.warnings.join(' '), /工具参数未声明/);
});

// ── ③ 画像的共用实现 ────────────────────────────────────────────────────────

test('profile：端点来源声明了 tools + tool_choice 才认子代理可用', () => {
  const ok = buildProfile({ hasTools: true, hasToolChoice: true, source: 'endpoint' });
  assert.equal(ok.canAgent, true);
  assert.equal(ok.toolsUnknown, false);
  assert.equal(ok.verdict, '可用：通用子代理（工具调用完整）');

  const noChoice = buildProfile({ hasTools: true, hasToolChoice: false, source: 'endpoint' });
  assert.equal(noChoice.canAgent, false);
  assert.equal(noChoice.verdict, '需实测验证：申明支持工具但无 tool_choice，子代理可能失败');

  const unverified = buildProfile({ toolsUnknown: true, source: 'adapter' });
  assert.equal(unverified.canAgent, false);
  assert.equal(unverified.role, '工具能力未声明');
  assert.match(unverified.verdict, /该来源不声明工具参数/);
});

// ── ④ /scan 路由（端到端） ──────────────────────────────────────────────────

test('route: /scan 汇总两个来源，并给出决策摘要', async () => {
  const llm = makeLlm({
    providers: [FREE_LANE],
    models: { 'our-free-model': [{ id: 'a-free', name: 'A' }] },
    resolved: { 'our-free-model/a-free': { context: { contextWindow: 200000 } } },
  });
  const call = boot({ llm });
  const reply = await call(SCAN_PATH, {});
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.adapterAvailable, true);
  assert.equal(reply.models.length, 1);
  assert.equal(reply.summary.total, 1);
  assert.deepEqual(reply.partial, []);
  const kinds = reply.sources.map((s) => `${s.id}:${s.kind}`);
  assert.deepEqual(kinds, ['our-free-model:adapter', 'stepfun:pi-ai']);
});

test('route: /scan 对同一个路由键不重复列（适配器来源优先）', async () => {
  // 平台清单里也有一个 our-free-model（同一路由键两条来源都看得到）。
  const settings = {
    get: (ns) => (ns === NS
      ? { providers: { 'our-free-model': { displayName: 'Our Free Model', baseURL: 'https://x/v1', models: [] } } }
      : undefined),
  };
  const llm = makeLlm({ providers: [FREE_LANE], models: { 'our-free-model': [{ id: 'a-free' }] } });
  const reply = await boot({ llm, settings })(SCAN_PATH, {});
  assert.equal(reply.sources.filter((s) => s.id === 'our-free-model').length, 1);
  assert.equal(reply.sources[0].kind, 'adapter');
});

test('route: /scan 支持按 provider 过滤，并透出 partial', async () => {
  const llm = makeLlm({
    providers: [PLAIN, FREE_LANE],
    models: { 'our-free-model': [{ id: 'a-free' }] },
    failModels: ['openrouter'],
  });
  const call = boot({ llm });
  const only = await call(SCAN_PATH, { provider: 'our-free-model' });
  assert.deepEqual(only.sources.map((s) => s.id), ['our-free-model']);
  assert.equal(only.models.length, 1);
  assert.deepEqual(only.partial, [], '未被请求的 provider 失败不该出现在本次 partial 里');

  const all = await call(SCAN_PATH, {});
  assert.equal(all.partial.length, 1);
  assert.equal(all.sources.some((s) => s.id === 'stepfun'), true, '平台清单照常列出');
});

test('route: llm 缺席时 /scan 仍返回平台清单', async () => {
  const reply = await boot({})(SCAN_PATH, {});
  assert.equal(reply.ok, true);
  assert.equal(reply.adapterAvailable, false);
  assert.deepEqual(reply.models, []);
  assert.deepEqual(reply.sources.map((s) => s.id), ['stepfun']);
});
