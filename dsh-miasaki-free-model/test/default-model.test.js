/**
 * 默认模型路由（`/freemodel-api/default-model`）的回归网。
 *
 * 这条路由是 M3 里唯一走**官方写路径**的动作（`agentDefaultModel.saveSelection`），
 * 与 `/subagent` 的文件级改写是两回事 —— 它不依赖预设文件存在、也不依赖其格式，
 * 下一次会话立即生效。因此它的失败形态要逐个钉住：
 *   · 服务缺席（极简 composition）→ 读返回 supported:false、写回人话错误，**不是** 500；
 *   · 读失败 → 按"读不到"处理（默认模型不是本面板的核心功能，不该因此整块报错）；
 *   · 写失败 → 把官方抛出的原因透传给调用方；
 *   · 参数缺失 → 在碰服务之前就拒绝。
 *
 * 只 mock 外部服务（`agentDefaultModel` 与 `settings`）；本文件不出网。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';

const NS = 'llm-pi-ai';
const PATH = '/freemodel-api/default-model';
const STORED = { providers: { stepfun: { displayName: '阶跃', baseURL: 'https://api.example.com/v1', models: [] } } };

/** Boot apply() with an optional agentDefaultModel service. */
function boot(service) {
  // default-model 在**一条**路由里分派 GET/POST（webServer 的 exact 表按 path 去重，
  // 分两条注册会抛 duplicate exact route —— 真机实测会让整个插件不激活）。
  const routes = [];
  apply({
    settings: { get: (ns) => (ns === NS ? STORED : undefined) },
    webServer: { register: (entry) => routes.push(entry) },
    get: (key) => (key === 'agentDefaultModel' ? service : undefined),
  });
  return async (method, body) => {
    const entry = routes.find((item) => item.path === PATH && item.handler.methods.includes(method));
    assert.notEqual(entry, undefined, `route ${method} ${PATH} must be registered`);
    const handler = entry.handler;
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = {
      method,
      headers: { host: '127.0.0.1:3080' },
      on(event, cb) {
        if (event === 'data' && text !== '') cb(Buffer.from(text));
        if (event === 'end') cb();
        return this;
      },
    };
    const res = { status: 0, payload: '', writeHead(s) { this.status = s }, end(c) { this.payload = c } };
    await handler(req, res);
    return { status: res.status, body: JSON.parse(res.payload) };
  };
}

test('GET：服务在场 → 返回当前默认模型选择', async () => {
  const reply = await boot({
    currentSelection: () => ({ provider: 'our-free-model', model: 'muse-spark-1.3-contributor-free' }),
  })('GET');
  assert.equal(reply.status, 200);
  assert.equal(reply.body.ok, true);
  assert.equal(reply.body.supported, true);
  assert.equal(reply.body.selection.provider, 'our-free-model');
});

test('GET：服务缺席 → supported:false，不报错', async () => {
  const reply = await boot(undefined)('GET');
  assert.equal(reply.body.ok, true);
  assert.deepEqual(reply.body.selection, null);
  assert.equal(reply.body.supported, false);
});

test('GET：currentSelection 抛错 → 读不到而不是整块失败', async () => {
  const reply = await boot({ currentSelection: () => { throw new Error('配置编辑器缺席') } })('GET');
  assert.equal(reply.body.ok, true);
  assert.equal(reply.body.supported, true);
  assert.equal(reply.body.selection, null);
});

test('POST：走官方 saveSelection 写默认模型', async () => {
  const writes = [];
  const reply = await boot({
    currentSelection: () => null,
    saveSelection: async (next) => { writes.push(next) },
  })('POST', { provider: 'openrouter', model: 'vendor/model:free' });
  assert.equal(reply.body.ok, true);
  assert.equal(reply.body.provider, 'openrouter');
  assert.equal(reply.body.model, 'vendor/model:free');
  assert.deepEqual(writes, [{ provider: 'openrouter', model: 'vendor/model:free' }],
    '只传 provider 与 model，不替官方补别的字段');
});

test('POST：服务缺席 → 语义化错误（不是 500）', async () => {
  const reply = await boot(undefined)('POST', { provider: 'openrouter', model: 'x' });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.ok, false);
  assert.match(reply.body.error, /agentDefaultModel/);
});

test('POST：参数缺失在碰服务之前就被拒', async () => {
  let called = false;
  const service = {
    currentSelection: () => null,
    saveSelection: async () => { called = true },
  };
  const missingModel = await boot(service)('POST', { provider: 'openrouter' });
  assert.equal(missingModel.body.ok, false);
  const missingAll = await boot(service)('POST', {});
  assert.equal(missingAll.body.ok, false);
  assert.equal(called, false, '参数不合法时不该调用官方写路径');
});

test('POST：官方写路径抛错 → 原因透传', async () => {
  const reply = await boot({
    currentSelection: () => null,
    saveSelection: async () => { throw new Error('部署没有配置编辑器') },
  })('POST', { provider: 'openrouter', model: 'x' });
  assert.equal(reply.body.ok, false);
  assert.match(reply.body.error, /配置编辑器/);
});
