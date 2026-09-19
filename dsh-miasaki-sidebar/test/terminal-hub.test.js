import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PTY_SHELLS,
  ScrollbackRing,
  TERMINAL_MAX_SESSIONS,
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
// TerminalHub（2026-09-19 多标签）：注入 fake pty（node-pty 的原生加载与真实
// spawn 由 T2 spike 与实机验证覆盖；这里锁多会话隔离、定向广播、上限、关闭
// 回收与尺寸仲裁）。
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
    frames() { return sent.map(t => JSON.parse(t)) },
    frame(type) { return sent.map(t => JSON.parse(t)).filter(frame => frame.type === type) },
  }
}

const quietLogger = { warn() {}, info() {}, error() {} }

function makeHub(replayBytes = 1024) {
  const fakeModule = makeFakePtyModule()
  // resolveBin 也注入：默认实现用 `where.exe` 探测 PATH（子进程 + 管道 stdio），
  // 受限沙箱会以 spawn EPERM 拒绝，于是「不需要真实 shell」的单测反而全挂。
  // 给一个绝对假路径即可与宿主环境彻底解耦（断言只要求「是绝对路径」）。
  const hub = new TerminalHub({
    replayBytes,
    viewers: new Map(),
    logger: quietLogger,
    resolveBin: async shell => `C:\\fake-shells\\${shell.bin}.exe`,
  })
  hub._pty = fakeModule
  return { hub, fakeModule }
}

/** 把一个 viewer 绑到某个会话（WS 接线里由 ensureAttached → hub.bind 完成）。 */
function attach(hub, viewer, session, cols = 80, rows = 24) {
  hub.bind(viewer, session, cols, rows)
  return viewer
}

test('TerminalHub: TERMINAL_MAX_SESSIONS is the documented cap', () => {
  assert.equal(TERMINAL_MAX_SESSIONS, 8, '上限 8（对齐 ssh 线 U2.1），且是 host 侧强制常量')
})

test('TerminalHub: per-session lifecycle — idle, cwd fence, enum fence, spawn shape', async () => {
  const { hub, fakeModule } = makeHub()
  assert.deepEqual(hub.status('nope'), { state: 'idle' }, '未知 id 的状态是 idle，不当探针面')
  assert.deepEqual(hub.list(), [], '初始没有会话')

  // cwd 校验先于 spawn：不存在的目录直接拒绝，绝不 spawn。
  await assert.rejects(() => hub.ensureSession({ shell: 'powershell', cwd: 'C:\\NoSuchDir_terminal_hub_test', cols: 80, rows: 24 }), /工作目录不存在/)
  // shell 枚举外（含 wt 这类窗口容器）：显式拒绝。
  await assert.rejects(() => hub.ensureSession({ shell: 'wt', cwd: process.cwd(), cols: 80, rows: 24 }), /未知的终端类型/)

  const first = await hub.ensureSession({ shell: 'powershell', cwd: process.cwd(), cols: 80, rows: 24 })
  assert.equal(first.spawned, true)
  assert.equal(typeof first.session.id, 'string', 'session id 由 host 生成（客户端只寻址）')
  assert.equal(fakeModule.spawned.length, 1)
  assert.equal(fakeModule.spawned[0].bin.includes('\\'), true, 'spawn 用绝对路径（conpty 拒绝裸名）')
  assert.deepEqual(fakeModule.spawned[0].opts, { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd() })
  assert.equal(hub.status(first.session.id).state, 'running')
  assert.equal(hub.snapshot().sessions.length, 1)
  assert.equal(hub.snapshot().limit, 8)
})

test('TerminalHub: a running session ignores new parameters, restart respawns in place', async () => {
  const { hub, fakeModule } = makeHub()
  const first = await hub.ensureSession({ shell: 'powershell', cwd: process.cwd(), cols: 80, rows: 24 })
  const id = first.session.id

  // 运行中的会话绝不因新参数重启（切会话不自动重启的红线延续）。
  const again = await hub.ensureSession({ sessionId: id, shell: 'cmd', cwd: process.cwd(), cols: 120, rows: 40 })
  assert.equal(again.spawned, false)
  assert.equal(again.session, first.session)
  assert.equal(fakeModule.spawned.length, 1)

  // 退出后再次 attach 同一 id → 重新 spawn（[重启] 语义，tab 不变）。
  first.session.pty.emitExit(0)
  assert.equal(hub.status(id).state, 'exited')
  const respawned = await hub.ensureSession({ sessionId: id, shell: 'powershell', cwd: process.cwd(), cols: 80, rows: 24 })
  assert.equal(respawned.spawned, true)
  assert.equal(respawned.session.id, id, '同一个 id 重生：前端 tab 不需要换键')
  assert.equal(fakeModule.spawned.length, 2)

  // 运行中 + restart: true → kill 旧进程后 spawn 新的（换 shell 语义）。
  const old = respawned.session.pty
  const fourth = await hub.ensureSession({ sessionId: id, shell: 'cmd', cwd: process.cwd(), cols: 80, rows: 24, restart: true })
  assert.equal(old.killed, true)
  assert.equal(fourth.spawned, true)
  assert.equal(fourth.session.id, id)
  assert.equal(fakeModule.spawned.length, 3)
})

test('TerminalHub: multi-session isolation — output, input and resize never cross tabs', async () => {
  const { hub, fakeModule } = makeHub()
  const a = await hub.ensureSession({ shell: 'powershell', cwd: process.cwd(), cols: 80, rows: 24 })
  const b = await hub.ensureSession({ shell: 'cmd', cwd: process.cwd(), cols: 100, rows: 30 })
  assert.notEqual(a.session.id, b.session.id, '两个会话 id 不同')
  assert.equal(hub.list().length, 2)

  const viewerA = attach(hub, makeViewer(), a.session, 80, 24)
  const viewerB = attach(hub, makeViewer(), b.session, 100, 30)

  // 输出只去该会话的 viewer（多开不串台的第一条）。
  a.session.pty.emitData('hello pty')
  assert.deepEqual(viewerA.frame('output'), [{ v: 2, sessionId: a.session.id, type: 'output', data: 'hello pty' }])
  assert.deepEqual(viewerB.sent, [], 'A 的输出不会写进 B 的 xterm')

  // 输入只进该会话的 pty。
  hub.write(viewerA, 'ls\r')
  assert.deepEqual(fakeModule.spawned[0].writes, ['ls\r'])
  assert.deepEqual(fakeModule.spawned[1].writes, [])

  // resize 只动该会话的 pty。
  hub.resize(viewerB, 120, 40)
  assert.deepEqual(fakeModule.spawned[1].resized, [[120, 40]])
  assert.deepEqual(fakeModule.spawned[0].resized, [], 'A 的 pty 尺寸不被 B 的 resize 改动')

  // 退出状态也只通知该会话的 viewer。
  b.session.pty.emitExit(7)
  assert.deepEqual(viewerB.frame('status'), [{ v: 2, sessionId: b.session.id, type: 'status', state: 'exited', code: 7 }])
  assert.deepEqual(viewerA.frame('status'), [])
  assert.equal(hub.status(b.session.id).exitCode, 7)

  // write/resize 对已退出会话 no-op。
  hub.write(viewerB, 'x')
  hub.resize(viewerB, 1, 1)
  assert.equal(fakeModule.spawned[1].writes.length, 0)
  assert.equal(fakeModule.spawned[1].resized.length, 1)
})

test('TerminalHub: an unbound or unknown sessionId drops input/resize silently', async () => {
  const { hub, fakeModule } = makeHub()
  const a = await hub.ensureSession({ shell: 'powershell', cwd: process.cwd(), cols: 80, rows: 24 })
  const unbound = makeViewer() // 从未 bind：模拟没带 sessionId 的帧
  hub.viewers.set(unbound, { sessionId: null, cols: null, rows: null })
  const stale = makeViewer() // 绑定到一个已被关掉的会话
  hub.viewers.set(stale, { sessionId: 'gone-session', cols: 80, rows: 24 })

  hub.write(unbound, 'x')
  hub.resize(unbound, 10, 10)
  hub.write(stale, 'y')
  hub.resize(stale, 10, 10)
  assert.deepEqual(fakeModule.spawned[0].writes, [], '未绑定的帧写不进任何 pty')
  assert.deepEqual(fakeModule.spawned[0].resized, [], '未知 id 的 resize 被静默丢弃（不当探针面）')
  assert.equal(hub.status(a.session.id).state, 'running')

  // attach 带一个不存在的 id：按新建处理，ready 帧带回真 id。
  const created = await hub.ensureSession({ sessionId: 'gone-session', shell: 'powershell', cwd: process.cwd(), cols: 80, rows: 24 })
  assert.notEqual(created.session.id, 'gone-session')
  assert.equal(created.spawned, true)
})

test('TerminalHub: session cap rejects the 9th session, close frees a slot', async () => {
  const { hub } = makeHub()
  for (let i = 0; i < TERMINAL_MAX_SESSIONS; i++) {
    await hub.ensureSession({ shell: 'powershell', cwd: process.cwd(), cols: 80, rows: 24 })
  }
  assert.equal(hub.list().length, 8)
  await assert.rejects(() => hub.ensureSession({ shell: 'powershell', cwd: process.cwd(), cols: 80, rows: 24 }), /上限 8 个/)

  const victim = hub.list()[0].id
  assert.equal(hub.close(victim), true)
  assert.equal(hub.list().length, 7)
  const fresh = await hub.ensureSession({ shell: 'powershell', cwd: process.cwd(), cols: 80, rows: 24 })
  assert.equal(fresh.spawned, true)
  assert.equal(hub.list().length, 8)
})

test('TerminalHub: close() kills the pty, drops the session and notifies its viewers', async () => {
  const { hub, fakeModule } = makeHub()
  const a = await hub.ensureSession({ shell: 'powershell', cwd: process.cwd(), cols: 80, rows: 24 })
  const viewer = attach(hub, makeViewer(), a.session)
  const other = attach(hub, makeViewer(), a.session)

  assert.equal(hub.close('does-not-exist'), false, '关闭未知会话幂等失败、不抛错')
  assert.equal(hub.close(a.session.id), true)

  assert.equal(fakeModule.spawned[0].killed, true, 'close = kill 掉真实进程')
  assert.equal(hub.get(a.session.id), null, '会话对象被摘掉')
  assert.equal(hub.list().length, 0)
  for (const viewerEntry of [viewer, other]) {
    assert.deepEqual(viewerEntry.frame('closed'), [{ v: 2, sessionId: a.session.id, type: 'closed', reason: 'user' }])
    assert.equal(hub.viewers.get(viewerEntry).sessionId, null, 'viewer 绑定被解除，无法再写进已关闭的会话')
  }
})

test('TerminalHub: size arbitration takes the minimum across viewers of one session', async () => {
  const { hub, fakeModule } = makeHub()
  const a = await hub.ensureSession({ shell: 'powershell', cwd: process.cwd(), cols: 80, rows: 24 })
  const pty = fakeModule.spawned[0]

  const wide = attach(hub, makeViewer(), a.session, 160, 50)
  assert.deepEqual(pty.resized, [[160, 50]], '单 viewer 时采用它自己的尺寸（覆盖 spawn 时的默认值）')

  const narrow = attach(hub, makeViewer(), a.session, 90, 20)
  assert.deepEqual(pty.resized.at(-1), [90, 20], '两个 viewer 取最小：保证窄的一侧不折行错乱')

  // 宽的一侧再放大：最小值不变 ⇒ 不该再 resize（避免 TUI 反复重排）。
  hub.resize(wide, 200, 60)
  assert.equal(pty.resized.length, 2, '最小值未变则不调用 pty.resize')

  // 窄的一侧撤了：最小值变成宽的一侧。
  hub.detach(narrow)
  assert.deepEqual(pty.resized.at(-1), [200, 60], 'viewer 消失后重算最小值')
})

test('TerminalHub: a backed-up viewer drops frames of its own session only', async () => {
  const { hub } = makeHub()
  const a = await hub.ensureSession({ shell: 'powershell', cwd: process.cwd(), cols: 80, rows: 24 })
  const b = await hub.ensureSession({ shell: 'powershell', cwd: process.cwd(), cols: 80, rows: 24 })
  const healthy = attach(hub, makeViewer(), a.session)
  const flooded = attach(hub, makeViewer(), a.session)
  const otherSession = attach(hub, makeViewer(), b.session)
  flooded.bufferedAmount = 9 * 1024 * 1024

  a.session.pty.emitData('tick')
  assert.deepEqual(healthy.frame('output').length, 1)
  assert.deepEqual(flooded.sent, [], '背压超限的 viewer 丢帧（T6：洪泛保护），不阻塞其他 viewer')
  assert.deepEqual(otherSession.sent, [], '别的会话的 viewer 更不该收到')

  b.session.pty.emitData('tock')
  assert.deepEqual(otherSession.frame('output').length, 1)
})

test('TerminalHub: dispose() kills every session (no orphan pty after plugin unload)', async () => {
  const { hub, fakeModule } = makeHub()
  for (let i = 0; i < 3; i++) {
    await hub.ensureSession({ shell: 'powershell', cwd: process.cwd(), cols: 80, rows: 24 })
  }
  assert.equal(fakeModule.spawned.length, 3)
  hub.dispose()
  assert.equal(fakeModule.spawned.every(proc => proc.killed), true, '卸载时全部会话都被 kill')
  assert.equal(hub.list().length, 0)
})
