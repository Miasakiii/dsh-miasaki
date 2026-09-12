import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PTY_SHELLS,
  ScrollbackRing,
  TerminalHub,
  clampPtySize,
  createTokenGate,
  fenceRequest,
  ptyShellsForPlatform,
} from '../index.js'

// ---------------------------------------------------------------------------
// 纯函数：枚举纪律 / 尺寸夹紧 / 回放环 / 一次性 token。
// ---------------------------------------------------------------------------

test('PTY_SHELLS: stream shells only — wt is a window container and never enters', () => {
  assert.equal(PTY_SHELLS.some(shell => shell.id === 'wt'), false, 'wt.exe 不进 pty 集合（启动器 §6.1 纪律延续）')
  const ids = PTY_SHELLS.map(shell => shell.id)
  assert.equal(new Set(ids).size, ids.length, 'shell id 全局唯一')
  assert.deepEqual(ptyShellsForPlatform('win32').map(shell => shell.id), ['pwsh', 'powershell', 'cmd'])
  assert.deepEqual(ptyShellsForPlatform('linux').map(shell => shell.id), ['bash'])
})

test('clampPtySize: non-numeric falls back, out-of-range clamps', () => {
  assert.equal(clampPtySize(undefined, 16, 500, 80), 80)
  assert.equal(clampPtySize('abc', 16, 500, 80), 80)
  assert.equal(clampPtySize(1, 16, 500, 80), 16)
  assert.equal(clampPtySize(99999, 16, 500, 80), 500)
  assert.equal(clampPtySize(100.4, 16, 500, 80), 100)
})

test('ScrollbackRing: capped, drops oldest whole chunks, keeps an oversized single chunk', () => {
  const ring = new ScrollbackRing(10)
  ring.push('aaaaa')
  ring.push('bbbbb')
  assert.equal(ring.read(), 'aaaaabbbbb')
  assert.equal(ring.dropped, false)

  ring.push('ccccc')
  assert.equal(ring.read(), 'bbbbbccccc', '超限丢最老的整块')
  assert.equal(ring.dropped, true)

  const huge = new ScrollbackRing(4)
  huge.push('0123456789')
  assert.equal(huge.read(), '0123456789', '单块超上限时保留（不至于丢当前输出）')
})

test('createTokenGate: one-shot consumption and TTL expiry', async () => {
  const gate = createTokenGate()
  const token = gate.issue()
  assert.equal(gate.consume(token), true)
  assert.equal(gate.consume(token), false, '同一个 token 用完即废')

  const fast = createTokenGate({ ttlMs: 5 })
  const stale = fast.issue()
  await new Promise(done => setTimeout(done, 20))
  assert.equal(fast.consume(stale), false, '过期的 token 无效')
  assert.equal(gate.consume('not-a-token'), false)
})

test('fenceRequest: the WS upgrade runs the same three layers as the HTTP routes', () => {
  const trusted = new Set(['localhost', '127.0.0.1'])
  assert.equal(fenceRequest({ host: 'evil.example.com' }, trusted).ok, false, '层 1：Host 围栏')
  assert.equal(fenceRequest({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }, trusted).ok, false, '层 2：跨站标记')
  assert.equal(fenceRequest({ host: '127.0.0.1', origin: 'http://evil.example.com' }, trusted).ok, false, '层 3：外部 Origin')
  assert.equal(fenceRequest({ host: '127.0.0.1', origin: 'null' }, trusted).ok, false, '不透明来源（沙箱 iframe / file:）')
  assert.equal(fenceRequest({ host: 'localhost:3080', origin: 'http://localhost:3080' }, trusted).ok, true, '同源放行（比 hostname 而非端口）')
  assert.equal(fenceRequest({ host: '127.0.0.1:3080' }, trusted).ok, true, '无 Origin 的普通升级请求放行')
})

// ---------------------------------------------------------------------------
// TerminalHub：注入 fake pty（node-pty 的原生加载与真实 spawn 由 T2 spike 与
// 实机验证覆盖；这里锁单会话语义、回放、广播与生命周期）。
// ---------------------------------------------------------------------------

function makeFakePtyModule() {
  const spawned = []
  return {
    spawned,
    spawn(bin, args, opts) {
      const handlers = { data: null, exit: null }
      const proc = {
        pid: 4000 + spawned.length + 1,
        bin, args, opts,
        writes: [],
        resized: [],
        killed: false,
        write(data) { proc.writes.push(data) },
        resize(cols, rows) { proc.resized.push([cols, rows]) },
        kill() { proc.killed = true; handlers.exit?.({ exitCode: 0 }) },
        onData(cb) { handlers.data = cb },
        onExit(cb) { handlers.exit = cb },
        emitData(text) { handlers.data?.(text) },
        emitExit(code) { handlers.exit?.({ exitCode: code }) },
      }
      spawned.push(proc)
      return proc
    },
  }
}

function makeViewer() {
  const sent = []
  return {
    sent,
    bufferedAmount: 0,
    send(text) { sent.push(text) },
    frame(type) {
      return sent.map(t => JSON.parse(t)).filter(frame => frame.type === type)
    },
  }
}

test('TerminalHub: single session, replay, broadcast and exit status', { skip: process.platform === 'win32' ? false : 'where 解析用例只在 win32 跑' }, async () => {
  const fakeModule = makeFakePtyModule()
  const hub = new TerminalHub({ replayBytes: 1024, viewers: new Set(), logger: { warn() {}, info() {}, error() {} } })
  hub._pty = fakeModule
  const viewer = makeViewer()
  hub.viewers.add(viewer)

  assert.deepEqual(hub.status(), { state: 'idle' })

  // cwd 校验先于 spawn：不存在的目录 404，绝不 spawn。
  await assert.rejects(() => hub.ensureSession({ shell: 'powershell', cwd: 'C:\\NoSuchDir_terminal_hub_test', cols: 80, rows: 24 }), /工作目录不存在/)

  // 未知 shell id / 二进制枚举外：显式拒绝（空闲态下校验才可达——运行中的
  // 单会话本来就忽略新参数，这是 §4.3 的语义，不是漏洞）。
  await assert.rejects(() => hub.ensureSession({ shell: 'wt', cwd: process.cwd(), cols: 80, rows: 24 }), /未知的终端类型/)

  const first = await hub.ensureSession({ shell: 'powershell', cwd: process.cwd(), cols: 80, rows: 24 })
  assert.equal(first.spawned, true)
  assert.equal(hub.status().state, 'running')
  assert.equal(fakeModule.spawned.length, 1)
  // T2 spike 纪律：spawn 的是 where 解析出的绝对路径，不是裸名。
  assert.equal(fakeModule.spawned[0].bin.includes('\\'), true, 'spawn 用绝对路径（conpty 拒绝裸名）')
  assert.deepEqual(fakeModule.spawned[0].opts, { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd() })

  // 运行中的会话绝不因新参数重启（§4.3：切会话不自动重启）。
  const again = await hub.ensureSession({ shell: 'cmd', cwd: process.cwd(), cols: 120, rows: 40 })
  assert.equal(again.spawned, false)
  assert.equal(again.session, first.session)
  assert.equal(fakeModule.spawned.length, 1)

  // 输出 → 环形缓冲 + 广播；write/resize 到达 pty。
  first.session.pty.emitData('hello pty')
  assert.deepEqual(viewer.frame('output'), [{ type: 'output', data: 'hello pty' }])
  hub.write('ls\r')
  assert.deepEqual(fakeModule.spawned[0].writes, ['ls\r'])
  hub.resize(100, 30)
  assert.deepEqual(fakeModule.spawned[0].resized, [[100, 30]])

  // exit → 状态帧 + exited 标记；write/resize 对已退出会话 no-op。
  first.session.pty.emitExit(7)
  assert.deepEqual(viewer.frame('status'), [{ type: 'status', state: 'exited', code: 7 }])
  assert.equal(hub.status().state, 'exited')
  assert.equal(hub.status().exitCode, 7)
  hub.write('x')
  hub.resize(1, 1)
  assert.equal(fakeModule.spawned[0].writes.length, 1)
  assert.equal(fakeModule.spawned[0].resized.length, 1)

  // 退出后再次 attach → 重新 spawn（用户手点 [重启] 的语义）。
  const third = await hub.ensureSession({ shell: 'powershell', cwd: process.cwd(), cols: 80, rows: 24 })
  assert.equal(third.spawned, true)
  assert.equal(fakeModule.spawned.length, 2)

  // 运行中 + restart: true → kill 旧进程后 spawn 新的（换 shell 语义）。
  const old = third.session.pty
  const fourth = await hub.ensureSession({ shell: 'cmd', cwd: process.cwd(), cols: 80, rows: 24, restart: true })
  assert.equal(old.killed, true)
  assert.equal(fourth.spawned, true)
  assert.equal(fakeModule.spawned.length, 3)
})

test('TerminalHub: a backed-up viewer drops frames instead of growing memory without bound', async () => {
  const fakeModule = makeFakePtyModule()
  const hub = new TerminalHub({ replayBytes: 1024, viewers: new Set(), logger: { warn() {}, info() {}, error() {} } })
  hub._pty = fakeModule
  const healthy = makeViewer()
  const flooded = makeViewer()
  flooded.bufferedAmount = 9 * 1024 * 1024
  hub.viewers.add(healthy)
  hub.viewers.add(flooded)

  const { session } = await hub.ensureSession({ shell: 'powershell', cwd: process.cwd(), cols: 80, rows: 24 })
  session.pty.emitData('tick')
  assert.deepEqual(healthy.frame('output'), [{ type: 'output', data: 'tick' }])
  assert.deepEqual(flooded.sent, [], '背压超限的 viewer 丢帧（T6：洪泛保护），不阻塞其他 viewer')
})
