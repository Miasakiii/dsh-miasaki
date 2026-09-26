// Runtime-layer tests for U3/P2-1: jump-host resolution (ensureJumpRuntime /
// openJumpChannel) and local-forward lifecycle (setupForwards / closeForwards /
// listState exposure). No real ssh2 connection: the jump rc is fault-injected
// exactly like runtime.test.js's liveRuntime pattern.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SshRuntime, RuntimeConn } from '../lib/runtime.js'
import { SshStore } from '../lib/store.js'

async function freshRuntime() {
  const dir = await mkdtemp(join(tmpdir(), 'ssh-fwd-runtime-'))
  const store = new SshStore(`${dir}/data`)
  await store.ready
  const runtime = new SshRuntime(store, {})
  return { runtime, store, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** 一个已连接的 RuntimeConn（client 是可控替身）。 */
function injectConnected(runtime, connId, record, clientStub) {
  const rc = new RuntimeConn(runtime, connId, record, { runtimeId: `rt-${connId}` })
  rc.status = 'connected'
  rc.client = clientStub
  runtime.conns.set(rc.id, rc)
  runtime.byProfile.set(connId, rc.id)
  return rc
}

test('JUMP: ensureJumpRuntime 复用已连接的跳板 rc，直接返回它的 client', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const jumpClient = { marker: 'jump-client' }
    injectConnected(runtime, 'jump-1', { host: 'bastion', label: 'bastion' }, jumpClient)
    const result = await runtime.ensureJumpRuntime('jump-1')
    assert.equal(result.error, undefined)
    assert.equal(result.client, jumpClient)
  } finally { await cleanup() }
})

test('JUMP: 跳板未连接且是密码认证 ⇒ JUMP_UNAVAILABLE（不把发起认证暴露成隐式能力）', async () => {
  const { runtime, store, cleanup } = await freshRuntime()
  try {
    await store.createConnection({ label: 'jump', host: 'bastion.example.com', port: 22, username: 'admin', auth: { method: 'password' } })
    const created = (await store.listConnections())[0]
    const result = await runtime.ensureJumpRuntime(created.id)
    // 跳板从未连过（无指纹记录）⇒ 前置拒绝；其 TOFU 确认窗口没有 UI 附着点
    assert.equal(result.error.code, 'JUMP_UNAVAILABLE')
    assert.match(result.error.message, /请先单独连接该主机完成信任/)
    assert.equal(runtime.conns.size, 0, '拒绝路径不留任何残留 rc')
  } finally { await cleanup() }
})

test('JUMP: openJumpChannel 成功/失败/同步抛/超时四态', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const okChannel = { id: 'ch' }
    const ok = await runtime.openJumpChannel({ forwardOut: (_a, _b, _c, _d, cb) => cb(null, okChannel) }, { host: 't', port: 22 })
    assert.equal(ok, okChannel)
    const failed = await runtime.openJumpChannel({ forwardOut: (_a, _b, _c, _d, cb) => cb(new Error('prohibited')) }, { host: 't', port: 22 })
    assert.equal(failed, null)
    const thrown = await runtime.openJumpChannel({ forwardOut() { throw new Error('Not connected') } }, { host: 't', port: 22 })
    assert.equal(thrown, null)
    // 超时：forwardOut 永不回调 ⇒ 50ms 预算内返回 null（生产预算 = 握手预算）
    const hung = await runtime.openJumpChannel({ forwardOut() { return undefined } }, { host: 't', port: 22 }, { timeoutMs: 50 })
    assert.equal(hung, null)
  } finally { await cleanup() }
})

test('JUMP: connect() 遇跳板不可用 ⇒ bail 且 error 码为 JUMP_UNAVAILABLE', async () => {
  const { runtime, store, cleanup } = await freshRuntime()
  try {
    // 目标（password 直连部分留给 buildConnectConfig 校验，先造跳板引用）
    const jump = await store.createConnection({ label: 'jump', host: 'bastion', port: 22, username: 'a', auth: { method: 'agent' } })
    const target = await store.createConnection({
      label: 'target', host: '10.0.0.9', port: 22, username: 'ops', auth: { method: 'agent' },
      jumpHostId: jump.id,
    })
    // agent 认证但 agentSupported=false ⇒ buildConnectConfig 先报 AGENT_UNAVAILABLE？
    // 顺序上 jump 解析在 buildConnectConfig 之后 ⇒ 这里 agentSupported 置真，让跳板先失败
    runtime.agentSupported = true
    const result = await runtime.connect(target.id)
    // 跳板（agent）隐式建连会在 agentSock 缺失时以 AGENT_UNAVAILABLE 失败 ⇒ 同样走 JUMP_UNAVAILABLE
    assert.equal(result.error, 'JUMP_UNAVAILABLE')
    const rc = runtime.runtimeOf(target.id)
    assert.equal(rc.status, 'error')
    assert.equal(rc.lastErrorCode, 'JUMP_UNAVAILABLE')
  } finally { await cleanup() }
})

test('FORWARD: setupForwards 按记录建立转发，listState 暴露 forwards 与 via', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const events = []
    const client = {
      marker: 'c',
      forwardOut: () => undefined, // 不做真实转发：只验注册与状态暴露
    }
    const rc = injectConnected(runtime, 'fwd-1', {
      host: 'box', label: 'box',
      forwards: [{ localPort: 18080, remoteHost: '127.0.0.1', remotePort: 8080 }, { localPort: 19090, remoteHost: 'db', remotePort: 5432 }],
      jumpHostId: 'jump-9',
    }, client)
    rc.broadcast = json => events.push(json)
    runtime.setupForwards(rc)
    assert.equal(rc.forwarders.size, 2)
    assert.ok(rc.forwarders.has(18080))
    assert.ok(rc.forwarders.has(19090))
    const state = runtime.listState().find(item => item.id === 'fwd-1')
    assert.equal(state.via, 'jump-9')
    assert.equal(state.forwards.length, 2)
    assert.equal(state.forwards[0].localPort, 18080)
    // 幂等：再调一次不重复建
    runtime.setupForwards(rc)
    assert.equal(rc.forwarders.size, 2)
    runtime.closeForwards(rc)
    assert.equal(rc.forwarders.size, 0)
    const after = runtime.listState().find(item => item.id === 'fwd-1')
    assert.deepEqual(after.forwards, [])
  } finally { await cleanup() }
})

test('FORWARD: 无转发规则 ⇒ setupForwards 零动作', async () => {
  const { runtime, cleanup } = await freshRuntime()
  try {
    const rc = injectConnected(runtime, 'fwd-2', { host: 'box', label: 'box' }, { forwardOut: () => undefined })
    runtime.setupForwards(rc)
    assert.equal(rc.forwarders.size, 0)
  } finally { await cleanup() }
})
