/**
 * 浏览器信任围栏覆盖（2026-10-20，ff54a）。
 *
 * 本插件的 `/dual-model/api/*` 是 webServer 自注册的 prefix 路由，**不经过**内核
 * `/api` 的准入链；此前唯一门禁是「回环 Host + Origin 全权相等」，任意本机进程
 * 伪造 Host 且不带 Origin 即可改写配置。这里钉四类边界：
 *   ① 结构层的每一条判据（含 SPEC §2 的端口判据与 Chromium 剥端口兼容）；
 *   ② `connection.requestRejection` 的 401/403/undefined/其他值/抛错；
 *   ③ 围栏真的挂在路由上、且先于业务执行（401/403 不会走到 handler）；
 *   ④ `connection` 是**逐请求**读取的（晚 provide 后立刻接管）。
 *
 * 只 mock 外部服务（webServer 路由表 + 可选 connection）；配置落盘用临时目录，
 * 不碰真实 `~/.dsh`。本文件不出网。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, structuralFence, trustFence } from '../index.js'

const API_PREFIX = '/dual-model/api'
const LOOPBACK = { host: '127.0.0.1:3080' }

/**
 * 最小 ctx：只实现 apply() 用到的 effect / on / provide / get / webServer.register。
 * @param {{value: object | undefined}} connectionBox - 可变的 connection 槽（逐请求读取）。
 */
function makeCtx(connectionBox) {
  const routes = new Map()
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on() { return () => {} },
    provide() { return () => {} },
    get(key) { return key === 'connection' ? connectionBox.value : undefined },
    webServer: { register(entry) { routes.set(entry.path, entry.handler) } },
  }
  return { ctx, routes }
}

/** A fake req: `api()` only reads method/url/headers; `readJson` consumes it as an async iterable. */
function makeReq({ method = 'GET', url = `${API_PREFIX}/state`, headers = LOOPBACK, body } = {}) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (text !== '') yield Buffer.from(text)
    },
  }
}

/** Boot the real apply() against a throwaway data dir; routes come from the mock webServer. */
async function boot(connectionBox = { value: undefined }) {
  const dir = await mkdtemp(join(tmpdir(), 'dual-model-fence-'))
  const { ctx, routes } = makeCtx(connectionBox)
  await apply(ctx, { dataDir: dir })
  const handler = routes.get(API_PREFIX)
  assert.equal(typeof handler, 'function', `prefix route ${API_PREFIX} must be registered`)
  return {
    dir,
    connectionBox,
    /**
     * 调一条 API 路由。
     * @param {string} path - API_PREFIX 之后的部分（如 '/state'）。
     * @param {object} [options] - method / headers / body。
     * @returns {Promise<{status: number, body: object}>} 状态码与 JSON 响应。
     */
    async call(path, { method = 'GET', headers = LOOPBACK, body } = {}) {
      const req = makeReq({ method, url: `${API_PREFIX}${path}`, headers, body })
      const res = {
        status: 0,
        payload: '',
        writeHead(status) { this.status = status },
        end(chunk) { this.payload = chunk },
      }
      await handler(req, res)
      return { status: res.status, body: JSON.parse(res.payload) }
    },
  }
}

/** Run `fn` against a booted app, then remove the temp data dir. */
async function withBoot(connectionBox, fn) {
  const app = await boot(connectionBox)
  try {
    return await fn(app)
  } finally {
    await rm(app.dir, { recursive: true, force: true })
  }
}

// ── ① 结构层 ──────────────────────────────────────────────────────────────

test('structuralFence: 回环 Host、无 Origin → 放行', () => {
  assert.deepEqual(structuralFence({ host: '127.0.0.1:3080' }), { ok: true })
  assert.deepEqual(structuralFence({ host: 'localhost:3080' }), { ok: true })
  assert.deepEqual(structuralFence({ host: '[::1]:3080' }), { ok: true })
})

test('structuralFence: 非回环 Host → 403', () => {
  const verdict = structuralFence({ host: 'evil.example:3080' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 403)
})

test('structuralFence: Host 缺失或为空 → 403（fail closed）', () => {
  assert.equal(structuralFence({}).status, 403)
  assert.equal(structuralFence({ host: '' }).status, 403)
  assert.equal(structuralFence({ host: '   ' }).status, 403)
})

test('structuralFence: 跨站 fetch → 403', () => {
  const verdict = structuralFence({ ...LOOPBACK, 'sec-fetch-site': 'cross-site' })
  assert.equal(verdict.status, 403)
})

test('structuralFence: 异源 Origin / Referer / opaque Origin → 403', () => {
  assert.equal(structuralFence({ ...LOOPBACK, origin: 'http://evil.example' }).status, 403)
  assert.equal(structuralFence({ ...LOOPBACK, referer: 'http://evil.example/settings' }).status, 403)
  assert.equal(structuralFence({ ...LOOPBACK, origin: 'null' }).status, 403)
})

test('structuralFence: 同源 Origin / Referer → 放行', () => {
  assert.deepEqual(structuralFence({ ...LOOPBACK, origin: 'http://127.0.0.1:3080' }), { ok: true })
  assert.deepEqual(structuralFence({ ...LOOPBACK, referer: 'http://127.0.0.1:3080/settings' }), { ok: true })
})

test('structuralFence: 跨端口 Origin → 403（SPEC §2 端口判据）', () => {
  const verdict = structuralFence({ ...LOOPBACK, origin: 'http://127.0.0.1:5173' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 403)
  assert.match(verdict.error, /跨端口/)
})

test('structuralFence: Origin 不带端口（Chromium 剥端口）→ 按 hostname 放行，不误拒', () => {
  assert.deepEqual(structuralFence({ ...LOOPBACK, origin: 'http://127.0.0.1' }), { ok: true })
  assert.deepEqual(structuralFence({ host: 'localhost:3080', origin: 'http://localhost' }), { ok: true })
})

test('structuralFence: Host 无端口时按 Origin 的 scheme 取默认端口', () => {
  // http 默认 80：显式 :80 等于默认 → 放行；显式 :8080 等于跨端口 → 拒。
  assert.deepEqual(structuralFence({ host: '127.0.0.1', origin: 'http://127.0.0.1:80' }), { ok: true })
  assert.equal(structuralFence({ host: '127.0.0.1', origin: 'http://127.0.0.1:8080' }).status, 403)
  // https 默认 443。
  assert.deepEqual(structuralFence({ host: '127.0.0.1', origin: 'https://127.0.0.1:443' }), { ok: true })
})

test('structuralFence: IPv6 回环同源 → 放行', () => {
  assert.deepEqual(structuralFence({ host: '[::1]:3080', origin: 'http://[::1]:3080' }), { ok: true })
})

// ── ② connection 服务在场 ──────────────────────────────────────────────────

test('trustFence: connection 判 401 → 401；判 403 → 403', () => {
  assert.equal(trustFence(LOOPBACK, { requestRejection: () => 401 }).status, 401)
  assert.equal(trustFence(LOOPBACK, { requestRejection: () => 403 }).status, 403)
})

test('trustFence: connection 放行即放行 —— 即便 Host 不是回环（准入权在该服务）', () => {
  assert.deepEqual(trustFence({ host: 'evil.example' }, { requestRejection: () => undefined }), { ok: true })
})

test('trustFence: connection 抛错 → 退回结构层，而不是 500', () => {
  const boom = { requestRejection: () => { throw new Error('composition bug') } }
  assert.equal(trustFence({ host: 'evil.example' }, boom).status, 403)
  assert.deepEqual(trustFence(LOOPBACK, boom), { ok: true })
})

test('trustFence: connection 返回其他值（如 500）→ 退回结构层', () => {
  assert.equal(trustFence({ host: 'evil.example' }, { requestRejection: () => 500 }).status, 403)
  assert.deepEqual(trustFence(LOOPBACK, { requestRejection: () => 500 }), { ok: true })
})

// ── ③/④ 围栏挂在路由上（端到端） ────────────────────────────────────────────

test('route: 无 connection 的 composition 里，同源 GET /state → 200', async () => {
  await withBoot({ value: undefined }, async (app) => {
    const reply = await app.call('/state')
    assert.equal(reply.status, 200)
    assert.equal(reply.body.enabled, true)
  })
})

test('route: 无 connection 时非回环 Host → 403（不再裸奔）', async () => {
  await withBoot({ value: undefined }, async (app) => {
    const reply = await app.call('/state', { headers: { host: 'evil.example:3080' } })
    assert.equal(reply.status, 403)
    assert.match(reply.body.error, /Host/)
  })
})

test('route: 无 connection 时跨端口 Origin → 403（SPEC §2 端口判据）', async () => {
  await withBoot({ value: undefined }, async (app) => {
    const reply = await app.call('/state', {
      headers: { ...LOOPBACK, origin: 'http://127.0.0.1:5173' },
    })
    assert.equal(reply.status, 403)
  })
})

test('route: 跨站 POST /settings → 403，且不落盘', async () => {
  await withBoot({ value: undefined }, async (app) => {
    const reply = await app.call('/settings', {
      method: 'POST',
      headers: { ...LOOPBACK, 'sec-fetch-site': 'cross-site' },
      body: { enabled: false, assistProvider: 'pwn', assistModel: 'pwn' },
    })
    assert.equal(reply.status, 403)
    await assert.rejects(readFile(join(app.dir, 'config.json'), 'utf8'))
  })
})

test('route: connection 判 401 → 401；判 403 → 403（围栏先于业务，不读 body）', async () => {
  await withBoot({ value: { requestRejection: () => 401 } }, async (app) => {
    const reply = await app.call('/settings', { method: 'POST', body: { enabled: false } })
    assert.equal(reply.status, 401)
  })
  await withBoot({ value: { requestRejection: () => 403 } }, async (app) => {
    assert.equal((await app.call('/state')).status, 403)
  })
})

test('route: connection 逐请求读取 —— 晚 provide 后同一路由立刻接管', async () => {
  await withBoot({ value: undefined }, async (app) => {
    // 服务还没 provide：结构层按非回环 Host 拒绝。
    const before = await app.call('/state', { headers: { host: 'evil.example:3080' } })
    assert.equal(before.status, 403)
    // 服务 provide 出来之后，同一个路由/同一个调用点按它的判定走。
    app.connectionBox.value = { requestRejection: () => undefined }
    const after = await app.call('/state', { headers: { host: 'evil.example:3080' } })
    assert.equal(after.status, 200)
  })
})

test('route: 同源 POST /settings → 200 并落盘到 dataDir', async () => {
  await withBoot({ value: undefined }, async (app) => {
    const reply = await app.call('/settings', {
      method: 'POST',
      headers: { ...LOOPBACK, origin: 'http://127.0.0.1:3080' },
      body: { enabled: false, assistProvider: 'sys-a', assistModel: 'vision-a' },
    })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.enabled, false)
    const saved = JSON.parse(await readFile(join(app.dir, 'config.json'), 'utf8'))
    assert.deepEqual(saved, { enabled: false, assistProvider: 'sys-a', assistModel: 'vision-a' })
  })
})
