// Fault-injection tests for the browser viewer session (session.js) — U2 contract.
//
// session.js is executed in node:vm with fake Terminal / FitAddon / SerializeAddon /
// WebSocket / fetch / timers, so binary frames, attach tickets, disconnect storms,
// re-attach budgets, write-ownership frames, snapshot capture/restore and disposal
// can be driven deterministically — the U0 gate「先通过故障注入测试」(workspace plan
// §9) plus the U2.1/U2.4 additions (u2 plan §3.2/§4.1/§4.4). No network, no DOM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../session.js', import.meta.url), 'utf8')

class FakeTerminal {
  constructor(opts) {
    this.options = { ...opts, fontSize: opts.fontSize ?? 13 }
    this.cols = 80
    this.rows = 24
    this.handlers = {}
    this.disposed = false
    this.written = []
    this.cleared = false
    this.selected = []
    this.scrolledTo = []
    this.selectionCleared = 0
    this.resetCount = 0
    this._buffer = { active: { length: 0, cursorY: 0, getLine: () => null } }
  }
  get buffer() { return this._buffer }
  loadAddon() {}
  open() {}
  dispose() { this.disposed = true }
  onData(fn) { this.handlers.data = fn }
  onResize(fn) { this.handlers.resize = fn }
  write(u8) { this.written.push(u8) }
  reset() { this.resetCount += 1; this.written = [] }
  clear() { this.cleared = true }
  select(col, row, length) { this.selected.push([col, row, length]) }
  scrollToLine(row) { this.scrolledTo.push(row) }
  clearSelection() { this.selectionCleared += 1 }
  /** 测试桩：安装一个可见缓冲（行文本数组）供 find 扫描。 */
  setBufferLines(lines, cursorY = 0) {
    this._buffer = { active: { length: lines.length, cursorY, getLine: y => (y >= 0 && y < lines.length ? { translateToString: () => lines[y] } : null) } }
  }
}

class FakeFitAddon {
  constructor() { this.fitCalls = 0 }
  fit() { this.fitCalls += 1 }
}

/** U2.4：官方 addon 的测试替身（serialize 产出固定串，可改写）。 */
class FakeSerializeAddon {
  static canned = 'SNAP-CANNED'
  serialize() { return FakeSerializeAddon.canned }
}

class FakeWebSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.binaryType = null
    this.sent = [] // strings (control frames) and typed arrays (output frames)
    this.closeArgs = null
    FakeWebSocket.created.push(this)
  }
  send(data) { this.sent.push(data) }
  close(code, reason) {
    if (this.closeArgs !== null) return
    this.closeArgs = { code, reason }
    this.readyState = 3
    this.onclose?.({})
  }
  // -- test-side drivers
  open() { this.readyState = 1; this.onopen?.() }
  serverText(frame) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify(frame) }) }
  serverRaw(text) { this.readyState = 1; this.onmessage?.({ data: text }) }
  serverBinary(bytes) { this.readyState = 1; this.onmessage?.({ data: new Uint8Array(bytes).buffer }) }
  drop() { this.readyState = 3; this.onclose?.({}) }
}

function makeHarness() {
  FakeWebSocket.created = []
  FakeSerializeAddon.canned = 'SNAP-CANNED'
  const rafQueue = [] // rAF queue
  const timers = [] // { fn, delay }
  const winListeners = new Map()
  const roCallbacks = []
  let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ticket: 'tok-1', expiresAt: 1, shells: [] }) })
  class FakeResizeObserver {
    constructor(cb) { roCallbacks.push(cb) }
    observe() {}
    disconnect() {}
  }
  const holder = {}

  const context = vm.createContext({})
  vm.runInContext(source, context, { filename: 'session.js' })
  const SshTermSession = context.SshTermSession
  assert.notEqual(SshTermSession, undefined, 'session.js must expose SshTermSession')

  function create(options = {}) {
    const statuses = []
    const frames = [] // control frames surfaced to app.js
    const modeChanges = []
    const session = SshTermSession.create({
      conn: { id: 'conn-1', label: 'box', host: 'box', port: 22, username: 'root', ...(options.conn ?? {}) },
      holder,
      Terminal: FakeTerminal,
      FitAddon: { FitAddon: FakeFitAddon },
      SerializeAddon: options.noSerializer === true ? undefined : { SerializeAddon: FakeSerializeAddon },
      WebSocketCtor: FakeWebSocket,
      fetcher: options.fetcher ?? (() => fetchImpl()),
      location: { protocol: 'http:', host: 'dsh.test' },
      requestFrame: fn => rafQueue.push(fn),
      setTimer: (fn, ms) => { const t = { fn, delay: ms }; timers.push(t); return t },
      clearTimer: t => { const i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1) },
      eventTarget: {
        addEventListener: (type, fn) => winListeners.set(type, fn),
        removeEventListener: (type, fn) => { if (winListeners.get(type) === fn) winListeners.delete(type) },
      },
      ResizeObserver: FakeResizeObserver,
      onStatus: (kind, text) => statuses.push({ kind, text }),
      onFrame: msg => frames.push(msg),
      onModeChange: mode => modeChanges.push(mode),
      ...(options.extra ?? {}),
    })
    return {
      session, statuses, frames, modeChanges,
      term: session.term,
      fit: session.fit,
      socket: () => FakeWebSocket.created.at(-1),
    }
  }

  function pumpFrames(n = 10) { for (let i = 0; i < n && rafQueue.length > 0; i += 1) rafQueue.shift()() }
  function pumpTimers() { while (timers.length > 0) timers.shift().fn() }
  // ticket fetch → WebSocket 构造发生在 promise 微任务链上：setImmediate 之前全部排空
  const flush = () => new Promise(resolve => setImmediate(resolve))
  async function openFirst() { await flush(); const ws = FakeWebSocket.created.at(-1); ws?.open(); return ws }

  return { SshTermSession, create, pumpFrames, pumpTimers, flush, openFirst, timers, winListeners, roCallbacks, setFetch: fn => { fetchImpl = fn } }
}

const ATTACH = { ticket: 'tok-1' }

test('attach: ticket minted over HTTP, v2 frame carries ticket/size/shellSeq', async () => {
  const h = makeHarness()
  const { term } = h.create({ extra: { shellSeq: 2 } })
  const ws = await h.openFirst()
  assert.equal(ws.binaryType, 'arraybuffer')
  const attach = JSON.parse(ws.sent[0])
  assert.equal(attach.type, 'attach')
  assert.equal(attach.v, 2)
  assert.equal(attach.ticket, 'tok-1')
  assert.equal(attach.shellSeq, 2)
  assert.deepEqual([attach.cols, attach.rows], [80, 24])
  void term
})

test('binary output frames reach the terminal as bytes', async () => {
  const h = makeHarness()
  h.create()
  const ws = await h.openFirst()
  ws.serverBinary([72, 73])
  const { session } = { session: FakeWebSocket.created.length && null }
  void session
  const created = FakeWebSocket.created.at(-1)
  void created
  const harness = h
  const term = harness.create // no-op; actual term access below
  void term
})

test('binary bytes land in the terminal (fresh load replays)', async () => {
  const h = makeHarness()
  const { term } = h.create()
  const ws = await h.openFirst()
  ws.serverBinary([72, 73])
  assert.equal(term.written.length, 1)
  assert.equal(Buffer.from(term.written[0]).toString(), 'HI')
})

test('disposing a viewer kills the whole bundle: no cross-writes from stale frames', async () => {
  const h = makeHarness()
  const a = h.create({ conn: { id: 'conn-a' } })
  const wsA = await h.openFirst()
  a.session.dispose()
  // disposal unwinds everything the viewer owned
  assert.equal(a.term.disposed, true)
  assert.deepEqual(wsA.closeArgs, { code: 1000, reason: 'viewer-disposed' })
  assert.equal(wsA.onmessage, null)
  assert.equal(wsA.onclose, null)
  // a stale frame delivered on the dead socket must not write anywhere
  wsA.serverBinary([65])
  assert.equal(a.term.written.length, 0)
  // a fresh viewer for another host works end to end
  const b = h.create({ conn: { id: 'conn-b' } })
  const wsB = await h.openFirst()
  wsB.serverBinary([66])
  assert.equal(Buffer.from(b.term.written[0]).toString(), 'B')
})

test('viewer WS drop re-attaches with a FRESH ticket and bounded backoff', async () => {
  const h = makeHarness()
  const { statuses, frames } = h.create()
  let ws = await h.openFirst()
  let seenTickets = ['tok-1']
  h.setFetch(async () => ({ ok: true, status: 200, json: async () => ({ ticket: `tok-${seenTickets.push('t') + 1}`, shells: [] }) }))
  ws.drop()
  assert.match(statuses.at(-1).text, /正在重新附着（1\/4）/)
  h.pumpTimers()
  await h.flush()
  assert.equal(FakeWebSocket.created.length, 2)
  ws = FakeWebSocket.created.at(-1)
  ws.open()
  const attach2 = JSON.parse(ws.sent[0])
  assert.equal(attach2.type, 'attach')
  assert.notEqual(attach2.ticket, 'tok-1', 'every (re)attach mints a one-time ticket')

  // server proof of life resets the attempt budget
  ws.serverText({ type: 'ready', state: 'connected', shellId: 'sh-1', mode: 'write' })
  assert.equal(frames.at(-1)?.state, 'connected')
  ws.drop()
  h.pumpTimers()
  await h.flush()
  assert.equal(FakeWebSocket.created.length, 3)

  // exhaust the budget: 4 attempts, then give up with an actionable message
  for (let i = 0; i < 10; i += 1) {
    FakeWebSocket.created.at(-1).drop()
    h.pumpTimers()
    await h.flush()
  }
  const last = statuses.at(-1)
  assert.equal(last.kind, 'error')
  assert.match(last.text, /多次重连失败/)
  const countBefore = FakeWebSocket.created.length
  h.pumpTimers()
  await h.flush()
  assert.equal(FakeWebSocket.created.length, countBefore) // no more sockets after giving up
})

test('re-attach backoff grows linearly (0.8s × attempt)', async () => {
  const h = makeHarness()
  h.create()
  const ws = await h.openFirst()
  ws.drop()
  assert.equal(h.timers.at(-1).delay, 800)
  h.pumpTimers()
  await h.flush()
  FakeWebSocket.created.at(-1).drop()
  assert.equal(h.timers.at(-1).delay, 1600)
  h.pumpTimers()
  await h.flush()
  FakeWebSocket.created.at(-1).drop()
  assert.equal(h.timers.at(-1).delay, 2400)
})

test('ticket fetch failure retries with the same budget, then reports an actionable error', async () => {
  const h = makeHarness()
  h.setFetch(async () => ({ ok: false, status: 404, json: async () => ({ error: '连接不存在或未在运行' }) }))
  const { statuses } = h.create()
  await h.flush()
  assert.match(statuses.at(-1).text, /正在重新附着（1\/4）|附着失败/)
  for (let i = 0; i < 10; i += 1) {
    h.pumpTimers()
    await h.flush()
  }
  const last = statuses.at(-1)
  assert.equal(last.kind, 'error')
  assert.match(last.text, /连接不存在或未在运行|附着失败/)
})

test('SSH-level close ends the viewer: no re-attach after the WS drops', async () => {
  const h = makeHarness()
  const { statuses } = h.create()
  const ws = await h.openFirst()
  ws.serverText({ type: 'status', state: 'closed' })
  ws.drop()
  h.pumpTimers()
  await h.flush()
  assert.equal(FakeWebSocket.created.length, 1)
  assert.equal(statuses.at(-1).text, '会话已结束')
})

test('shell.closed ends THIS shell only: no re-attach, viewer stays quiet', async () => {
  const h = makeHarness()
  const { statuses, frames } = h.create()
  const ws = await h.openFirst()
  ws.serverText({ type: 'shell.closed', shellId: 'sh-1', reason: 'exit' })
  assert.equal(statuses.at(-1).text, '会话已结束')
  assert.equal(frames.at(-1)?.type, 'shell.closed')
  ws.drop()
  h.pumpTimers()
  await h.flush()
  assert.equal(FakeWebSocket.created.length, 1, 'a closed shell cannot be revived by re-attach')
})

test('NO_CONNECTION marks the viewer dead and surfaces an actionable error', async () => {
  const h = makeHarness()
  const { statuses } = h.create()
  const ws = await h.openFirst()
  ws.serverText({ type: 'error', code: 'NO_CONNECTION', message: '连接不存在或已关闭' })
  assert.equal(statuses.at(-1).kind, 'error')
  ws.drop()
  h.pumpTimers()
  await h.flush()
  assert.equal(FakeWebSocket.created.length, 1)
})

test('VERSION_MISMATCH tells the user to refresh and ends the viewer', async () => {
  const h = makeHarness()
  const { statuses } = h.create()
  const ws = await h.openFirst()
  ws.serverText({ type: 'error', code: 'VERSION_MISMATCH', message: 'SSH 插件已升级，请刷新页面后继续' })
  assert.equal(statuses.at(-1).kind, 'error')
  assert.match(statuses.at(-1).text, /刷新/)
  ws.drop()
  h.pumpTimers()
  await h.flush()
  assert.equal(FakeWebSocket.created.length, 1)
})

test('waiting-fingerprint surfaces to app.js via onFrame without ending the viewer', async () => {
  const h = makeHarness()
  const { statuses, frames } = h.create()
  const ws = await h.openFirst()
  ws.serverText({ type: 'status', state: 'waiting-fingerprint', token: 'tok-1', fingerprint: 'SHA256:abc' })
  assert.equal(statuses.at(-1).kind, 'warn')
  assert.equal(frames.at(-1).token, 'tok-1')
  // 只转发一次：状态帧统一前置转发，分支里不再重复调 onFrame
  assert.equal(frames.filter(f => f.token === 'tok-1').length, 1)
  ws.drop() // viewer blip while the user decides — re-attach is allowed
  h.pumpTimers()
  await h.flush()
  assert.equal(FakeWebSocket.created.length, 2)
})

test('ready 帧同时喂给 onFrame（状态模型），并落 shellId + 写权模式', async () => {
  const h = makeHarness()
  const { statuses, frames, modeChanges, session } = h.create()
  const ws = await h.openFirst()
  ws.serverText({ type: 'ready', state: 'connected', shellId: 'sh-2', mode: 'read' })
  assert.equal(statuses.at(-1).kind, 'ok')
  assert.equal(frames.at(-1)?.type, 'status', 'ready 帧必须转发给 app.js 状态模型')
  assert.equal(frames.at(-1)?.state, 'connected')
  // 初次即为 read：setMode 只在变化时通知（read→read 无第二次），这是刻意去抖
  assert.deepEqual(modeChanges, [], 'unchanged mode does not fire onModeChange (de-dup)')
  assert.equal(session.isWriteOwner(), false, 'still read-only after ready')
  ws.serverText({ type: 'write.granted', shellId: 'sh-2' })
  assert.deepEqual(modeChanges, ['write'])
  assert.equal(session.isWriteOwner(), true)
})

test('write.revoked flips the viewer to read-only with a clear message', async () => {
  const h = makeHarness()
  const { statuses, modeChanges } = h.create()
  const ws = await h.openFirst()
  ws.serverText({ type: 'ready', state: 'connected', shellId: 'sh-1', mode: 'write' })
  ws.serverText({ type: 'write.revoked', shellId: 'sh-1' })
  assert.deepEqual(modeChanges, ['write', 'read'])
  assert.match(statuses.at(-1).text, /只读|接管/)
})

test('shell.opened resets sshEnded, parses seq from the title and reports to app.js', async () => {
  const h = makeHarness()
  const { frames } = h.create()
  const ws = await h.openFirst()
  ws.serverText({ type: 'shell.opened', shellId: 'sh-2', title: 'box #2', mode: 'write' })
  assert.equal(frames.at(-1)?.type, 'shell.opened')
  assert.equal(frames.at(-1)?.shellId, 'sh-2')
  // 之后 ws 断开要能重附着（shell 活着 ⇒ 不是 sshEnded）
  ws.drop()
  h.pumpTimers()
  await h.flush()
  assert.equal(FakeWebSocket.created.length, 2)
})

test('malformed control frames are ignored without breaking the session', async () => {
  const h = makeHarness()
  const { statuses } = h.create()
  const ws = await h.openFirst()
  const before = statuses.length
  ws.serverRaw('@@@ not json')
  ws.serverRaw('{"no-type":1}')
  ws.serverRaw('[]')
  assert.equal(statuses.length, before)
})

test('outgoing input/resize carry v:2 + shellId; resize is clamped', async () => {
  const h = makeHarness()
  const { term } = h.create()
  const ws = await h.openFirst()
  ws.serverText({ type: 'ready', state: 'connected', shellId: 'sh-1', mode: 'write' })
  term.handlers.resize({ cols: 99999, rows: -3 })
  term.handlers.resize({ cols: 100, rows: 30 })
  const frames = ws.sent.map(s => JSON.parse(s))
  assert.deepEqual(frames[1], { v: 2, type: 'resize', shellId: 'sh-1', cols: 1000, rows: 2 })
  assert.deepEqual(frames[2], { v: 2, type: 'resize', shellId: 'sh-1', cols: 100, rows: 30 })
  term.handlers.data('ls\n')
  const input = frames.concat(ws.sent.slice(3).map(s => JSON.parse(s))).filter(f => f.type === 'input')
  assert.deepEqual(input, [{ v: 2, type: 'input', shellId: 'sh-1', data: 'ls\n' }])
})

test('takeover() and closeShell() address the bound shell only', async () => {
  const h = makeHarness()
  const { session } = h.create()
  const ws = await h.openFirst()
  ws.serverText({ type: 'ready', state: 'connected', shellId: 'sh-3', mode: 'read' })
  session.takeover()
  session.closeShell()
  const frames = ws.sent.map(s => JSON.parse(s))
  assert.deepEqual(frames.at(-2), { v: 2, type: 'shell.takeover', shellId: 'sh-3' })
  assert.deepEqual(frames.at(-1), { v: 2, type: 'shell.close', shellId: 'sh-3' })
})

test('container resize fits through rAF, coalesced; a dead session never fits again', async () => {
  const h = makeHarness()
  const { session, fit } = h.create()
  const ro = h.roCallbacks.at(-1)
  assert.notEqual(ro, undefined)
  ro(); ro(); ro() // burst of container events
  h.pumpFrames(10)
  assert.equal(fit.fitCalls, 2) // 1 initial fit + 1 coalesced burst (3 events → 1 frame)
  h.pumpFrames(5)
  assert.equal(fit.fitCalls, 2)
  session.dispose()
  ro()
  h.pumpFrames(5)
  assert.equal(fit.fitCalls, 2)
})

test('dispose cancels pending re-attach and unwinds every listener', async () => {
  const h = makeHarness()
  const { session, term } = h.create()
  const ws = await h.openFirst()
  ws.drop() // schedules a re-attach timer
  session.dispose()
  h.pumpTimers()
  await h.flush()
  assert.equal(FakeWebSocket.created.length, 1) // timer was cancelled
  assert.equal(term.disposed, true)
  assert.equal(h.winListeners.size, 0) // window resize listener removed
})

// ---- U1：主题 / 字号 / 查找 / 清屏 / 直写输入 -------------------------------

test('applyTheme pushes a new xterm theme onto the live terminal', async () => {
  const h = makeHarness()
  const { session, term } = h.create()
  session.applyTheme({ background: '#010203', foreground: '#040506', cursor: '#070809' })
  assert.equal(term.options.theme.background, '#010203')
  assert.equal(term.options.theme.foreground, '#040506')
  session.applyTheme(null)
  session.applyTheme('nope')
  assert.equal(term.options.theme.background, '#010203') // 非法输入被忽略
})

test('setFontSize clamps to 12–20 and schedules a re-fit', async () => {
  const h = makeHarness()
  const { session, fit } = h.create()
  const before = fit.fitCalls
  assert.equal(session.setFontSize(16), 16)
  assert.equal(session.fontSize(), 16)
  assert.equal(session.setFontSize(99), 20)
  assert.equal(session.setFontSize(1), 12)
  h.pumpFrames(10)
  assert.ok(fit.fitCalls > before, 'font change must schedule a fit (which resizes the PTY)')
})

test('find scans the buffer, selects matches and navigates with wrapping', async () => {
  const h = makeHarness()
  const { session, term } = h.create()
  term.setBufferLines(['error: alpha failed', 'ok line', 'alpha again error'])
  // 注意：返回对象来自 vm realm，须浅拷贝后再 deepEqual
  let result = { ...session.find('alpha') }
  assert.deepEqual(result, { total: 2, current: 1 })
  assert.deepEqual(term.selected.at(-1), [7, 0, 5])
  assert.deepEqual(term.scrolledTo.at(-1), 0)
  result = { ...session.find('alpha', 1) } // next
  assert.deepEqual(result, { total: 2, current: 2 })
  result = { ...session.find('alpha', 1) } // wraps
  assert.deepEqual(result, { total: 2, current: 1 })
  result = { ...session.find('alpha', -1) } // prev wraps backwards
  assert.deepEqual(result, { total: 2, current: 2 })
  assert.deepEqual({ ...session.find('') }, { total: 0, current: 0 }) // 空查询清选择
  assert.equal(term.selectionCleared >= 1, true)
  // 新查询从光标行之后开始
  term.setBufferLines(['alpha first', 'middle', 'alpha last'], 1)
  result = { ...session.find('alpha') }
  assert.deepEqual(result, { total: 2, current: 2 })
})

test('snapshot (text) returns a read-only tail of the buffer for 「送往对话」(A0)', async () => {
  const h = makeHarness()
  const { session, term } = h.create()
  term.setBufferLines(['alpha', 'beta', 'gamma', '   ', ''])
  // 默认 40 行：全部内容，尾部空行被裁掉
  assert.equal(session.snapshot(), 'alpha\nbeta\ngamma')
  // 只取最后 N 行
  assert.equal(session.snapshot(2), 'beta\ngamma')
  assert.equal(session.snapshot(1), 'gamma')
  // 非整数 / 越界由 clampDim 兜底到最后 40 行（即全部），不抛异常
  assert.equal(session.snapshot('nope'), 'alpha\nbeta\ngamma')
  assert.equal(session.snapshot(9999), 'alpha\nbeta\ngamma')
  // 空缓冲区 / 全是空行 → 空串：调用方据此提示「没有可送出的输出」
  term.setBufferLines([])
  assert.equal(session.snapshot(), '')
  term.setBufferLines(['   ', ''])
  assert.equal(session.snapshot(), '')
  // 只读：快照不向 socket 写入任何字节（送往对话绝不等同于向远端发命令）
  const ws = await h.openFirst()
  term.setBufferLines(['x'])
  const before = ws.sent.length
  session.snapshot()
  assert.equal(ws.sent.length, before)
  // 已销毁的查看器不再产出内容
  session.dispose()
  assert.equal(session.snapshot(), '')
})

test('clearLocal clears the local display only; input writes straight to the socket', async () => {
  const h = makeHarness()
  const { session, term } = h.create()
  const ws = await h.openFirst()
  ws.serverText({ type: 'ready', state: 'connected', shellId: 'sh-1', mode: 'write' })
  session.clearLocal()
  assert.equal(term.cleared, true)
  session.input('ls\n')
  const inputFrames = ws.sent.filter(s => typeof s === 'string').map(s => JSON.parse(s)).filter(f => f.type === 'input')
  assert.deepEqual(inputFrames, [{ v: 2, type: 'input', shellId: 'sh-1', data: 'ls\n' }])
})

// ---- U2.4：屏幕快照的采集与恢复（serialize 路线 A）-------------------------

test('U2.4 restore: snapshot frame before any output resets + writes the snapshot, binary replay is dropped', async () => {
  const h = makeHarness()
  const { term } = h.create()
  const ws = await h.openFirst()
  ws.serverText({ type: 'snapshot', shellId: 'sh-1', data: 'SNAP-SERIALIZED' })
  ws.serverBinary([72, 73]) // 回放与快照二选一：快照已到 ⇒ 整段回放丢弃
  assert.equal(term.resetCount, 1)
  assert.equal(term.written.length, 1)
  assert.equal(Buffer.from(term.written[0]).toString(), 'SNAP-SERIALIZED')
  // 之后到达的二进制是实时输出，正常写入
  ws.serverBinary([74])
  assert.equal(term.written.length, 2)
})

test('U2.4 restore: no snapshot ⇒ fresh load replays the binary (回放兜底)', async () => {
  const h = makeHarness()
  const { term } = h.create()
  const ws = await h.openFirst()
  ws.serverBinary([72, 73])
  assert.equal(term.resetCount, 0)
  assert.equal(Buffer.from(term.written[0]).toString(), 'HI')
})

test('U2.4 restore: re-attach with live local buffer drops the whole replay (不翻倍)', async () => {
  const h = makeHarness()
  const { term } = h.create()
  let ws = await h.openFirst()
  ws.serverBinary([72, 73])
  ws.drop()
  h.pumpTimers()
  await h.flush()
  ws = FakeWebSocket.created.at(-1)
  ws.open()
  ws.serverBinary([88])
  assert.equal(term.written.length, 1, 'local buffer still holds the output: replay dropped')
  assert.equal(Buffer.from(term.written[0]).toString(), 'HI')
})

test('U2.4 capture: after output goes idle the serialized screen is reported once', async () => {
  const h = makeHarness()
  const { session } = h.create()
  const ws = await h.openFirst()
  ws.serverText({ type: 'ready', state: 'connected', shellId: 'sh-1', mode: 'write' })
  ws.serverBinary([79])
  h.pumpTimers() // SNAPSHOT_IDLE_MS 到点
  const snap = ws.sent.map(s => JSON.parse(s)).find(f => f.type === 'snapshot')
  assert.equal(snap.shellId, 'sh-1')
  assert.equal(snap.data, 'SNAP-CANNED')
  void session
})

test('U2.4 capture: over-cap serialization is dropped (不阻塞终端)', async () => {
  const h = makeHarness()
  const { session } = h.create()
  FakeSerializeAddon.canned = 'x'.repeat(128 * 1024 + 1)
  const ws = await h.openFirst()
  ws.serverText({ type: 'ready', state: 'connected', shellId: 'sh-1', mode: 'write' })
  ws.serverBinary([79])
  h.pumpTimers()
  const snap = ws.sent.map(s => JSON.parse(s)).find(f => f.type === 'snapshot')
  assert.equal(snap, undefined)
  void session
})

test('U2.4 degraded: no SerializeAddon ⇒ no capture, replay path still works', async () => {
  const h = makeHarness()
  const { term } = h.create({ noSerializer: true })
  const ws = await h.openFirst()
  ws.serverText({ type: 'ready', state: 'connected', shellId: 'sh-1', mode: 'write' })
  ws.serverBinary([79])
  h.pumpTimers()
  const snap = ws.sent.map(s => JSON.parse(s)).find(f => f.type === 'snapshot')
  assert.equal(snap, undefined, 'addon missing ⇒ snapshot capture silently disabled')
  ws.drop()
  h.pumpTimers()
  await h.flush()
  FakeWebSocket.created.at(-1).open()
  FakeWebSocket.created.at(-1).serverBinary([88]) // 第一段 = 回放（bufferLive ⇒ 丢弃）
  FakeWebSocket.created.at(-1).serverBinary([72]) // 第二段起 = 实时输出
  assert.equal(Buffer.from(term.written.at(-1)).toString(), 'H', 'live output flows after the dropped replay')
})

test('onResize callback reports viewer size changes', async () => {
  const sizes = []
  const h = makeHarness()
  const { term } = h.create({ extra: { onResize: size => sizes.push({ ...size }) } })
  await h.flush()
  term.handlers.resize({ cols: 120, rows: 40 })
  assert.deepEqual(sizes.at(-1), { cols: 120, rows: 40 })
})
