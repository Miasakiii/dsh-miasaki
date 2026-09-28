/**
 * Trust-fence coverage for the plugin's HTTP surface.
 *
 * 本插件的路由是 exact 注册，**不经过**内核 `/api` 的准入链，因此围栏是
 * 唯一的口子。这里钉三件事：
 *   ① 结构化层（无 connection 服务的 composition）的每一条边界；
 *   ② connection 服务在场时以它的判定为准、且**逐请求读取**（不做快照）；
 *   ③ 围栏真的挂在路由上、且**先于 method 检查与业务**执行。
 *
 * 只 mock 外部服务（webServer 路由表 + 可选的 connection）；本文件不出网。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';
import { structuralFence, trustFence } from '../lib/trust.js';

const NS = 'llm-pi-ai';
const STORED = {
  providers: {
    stepfun: { displayName: '阶跃', baseURL: 'https://api.example.com/v1', models: [] },
  },
};

/** Boot apply() with a route table and an optional live `connection` value. */
function boot(connection) {
  const routes = new Map();
  apply({
    settings: { get: (ns) => (ns === NS ? STORED : undefined) },
    webServer: { register: (entry) => routes.set(entry.path, entry.handler) },
    get: (key) => (key === 'connection' ? connection : undefined),
  });
  return async (path, { method = 'GET', headers = {}, body } = {}) => {
    const handler = routes.get(path);
    assert.notEqual(handler, undefined, `route ${path} must be registered`);
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = {
      method,
      headers,
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
    return { status: res.status, body: JSON.parse(res.payload) };
  };
}

const LOOPBACK = { host: '127.0.0.1:3080' };

// ── ① 结构化层 ──────────────────────────────────────────────────────────────

test('structuralFence: 回环 Host、无 Origin → 放行', () => {
  assert.deepEqual(structuralFence({ host: '127.0.0.1:3080' }), { ok: true });
  assert.deepEqual(structuralFence({ host: 'localhost:3080' }), { ok: true });
});

test('structuralFence: 非回环 Host → 403', () => {
  const verdict = structuralFence({ host: 'evil.example:3080' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 403);
});

test('structuralFence: Host 缺失或为空 → 403（fail closed，不退回 socket 本地地址）', () => {
  assert.equal(structuralFence({}).status, 403);
  assert.equal(structuralFence({ host: '' }).status, 403);
  assert.equal(structuralFence({ host: '   ' }).status, 403);
});

test('structuralFence: 跨站 fetch → 403', () => {
  const verdict = structuralFence({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' });
  assert.equal(verdict.status, 403);
});

test('structuralFence: 异源 Origin / opaque Origin → 403', () => {
  assert.equal(structuralFence({ host: '127.0.0.1:3080', origin: 'http://evil.example' }).status, 403);
  // `Origin: null`（沙箱 iframe、data: 文档）解析不成同源，同样拒。
  assert.equal(structuralFence({ host: '127.0.0.1:3080', origin: 'null' }).status, 403);
});

test('structuralFence: 同源 Origin / Referer → 放行；异源 Referer → 403', () => {
  assert.deepEqual(
    structuralFence({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }),
    { ok: true },
  );
  assert.deepEqual(
    structuralFence({ host: '127.0.0.1:3080', referer: 'http://127.0.0.1:3080/settings' }),
    { ok: true },
  );
  assert.equal(
    structuralFence({ host: '127.0.0.1:3080', referer: 'http://evil.example/settings' }).status,
    403,
  );
});

// ── ② connection 服务在场 ────────────────────────────────────────────────────

test('trustFence: connection 判 401 → 401（与内核 /api 同级）', () => {
  const verdict = trustFence(LOOPBACK, { requestRejection: () => 401 });
  assert.equal(verdict.status, 401);
});

test('trustFence: connection 判 403 → 403', () => {
  const verdict = trustFence(LOOPBACK, { requestRejection: () => 403 });
  assert.equal(verdict.status, 403);
});

test('trustFence: connection 放行即放行 —— 即便 Host 不是回环（准入权在该服务）', () => {
  assert.deepEqual(trustFence({ host: 'evil.example' }, { requestRejection: () => undefined }), { ok: true });
});

test('trustFence: connection 抛错 → 退回结构层，而不是 500', () => {
  const verdict = trustFence({ host: 'evil.example' }, {
    requestRejection: () => { throw new Error('composition bug') },
  });
  assert.equal(verdict.status, 403);
});

test('trustFence: connection 逐请求读取 —— 晚 provide 后立刻接管', () => {
  let live;
  const read = () => live;
  // 第一请求：服务还没 provide → 走结构层，非回环 Host 被拒。
  assert.equal(trustFence({ host: 'evil.example' }, read()).status, 403);
  // 服务 provide 出来之后，同一个调用点立刻按它的判定走。
  live = { requestRejection: () => undefined };
  assert.deepEqual(trustFence({ host: 'evil.example' }, read()), { ok: true });
});

// ── ③ 围栏挂在路由上（端到端） ───────────────────────────────────────────────

test('route: 非回环 Host 的请求进不了业务 handler', async () => {
  const call = boot(undefined);
  const reply = await call('/freemodel-api/status', { headers: { host: 'evil.example:3080' } });
  assert.equal(reply.status, 403);
  assert.equal(reply.body.ok, false);
});

test('route: 围栏先于 method 检查 —— 跨站 POST 得 403 而不是 405', async () => {
  const call = boot(undefined);
  const reply = await call('/freemodel-api/apply', {
    method: 'POST',
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
    body: { platform: 'stepfun' },
  });
  assert.equal(reply.status, 403);
});

test('route: 围栏通过后 method 不符 → 405；正确 method → 200', async () => {
  const call = boot(undefined);
  const wrong = await call('/freemodel-api/status', { method: 'POST', headers: LOOPBACK });
  assert.equal(wrong.status, 405);
  const ok = await call('/freemodel-api/status', { headers: LOOPBACK });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
});

test('route: 带合法 connection 服务的 composition 里，同源请求照常通过', async () => {
  const call = boot({ requestRejection: () => undefined });
  const ok = await call('/freemodel-api/status', { headers: LOOPBACK });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  const denied = boot({ requestRejection: () => 401 });
  assert.equal((await denied('/freemodel-api/status', { headers: LOOPBACK })).status, 401);
});
