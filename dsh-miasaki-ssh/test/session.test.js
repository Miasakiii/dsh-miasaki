// Fault-injection tests for the browser viewer session (session.js).
//
// session.js is executed in node:vm with fake Terminal / FitAddon /
// WebSocket / timers, so binary frames, disconnect storms, re-attach budgets
// and disposal can be driven deterministically — the U0 gate「先通过故障注入
// 测试」(design/2026-09-12-ssh-workspace-plan.md §9). No network, no DOM.
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
    this._buffer = { active: { length: 0, cursorY: 0, getLine: () => null } }
  }
  get buffer() { return this._buffer }
  loadAddon() {}
  open() {}
  dispose() { this.disposed = true }
  onData(fn) { this.handlers.data = fn }
  onResize(fn) { this.handlers.resize = fn }
  write(u8) { this.written.push(u8) }
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
  const rafQueue = [] // rAF queue
  const timers = [] // { fn, delay }
  const winListeners = new Map()
  const roCallbacks = []
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
    const session = SshTermSession.create({
      conn: { id: 'conn-1', label: 'box', host: 'box', port: 22, username: 'root', ...(options.conn ?? {}) },
      holder,
      Terminal: FakeTerminal,
      FitAddon: { FitAddon: FakeFitAddon },
      WebSocketCtor: FakeWebSocket,
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
      ...(options.extra ?? {}),
    })
    return {
      session, statuses, frames,
      term: session.term,
      fit: session.fit,
      socket: () => FakeWebSocket.created.at(-1),
    }
  }

  function pumpFrames(n = 10) { for (let i = 0; i < n && rafQueue.length > 0; i += 1) rafQueue.shift()() }
  function pumpTimers() { while (timers.length > 0) timers.shift().fn() }

  return { SshTermSession, create, pumpFrames, pumpTimers, timers, winListeners, roCallbacks }
}

test('binary output frames reach the terminal as bytes; attach carries the size', () => {
  const h = makeHarness()
  const { term, socket } = h.create()
  const ws = socket()
  assert.equal(ws.binaryType, 'arraybuffer')
  ws.open()
  const attach = JSON.parse(ws.sent[0])
  assert.equal(attach.type, 'attach')
  assert.equal(attach.connId, 'conn-1')
  assert.deepEqual([attach.cols, attach.rows], [80, 24])
  ws.serverBinary([72, 73])
  assert.equal(term.written.length, 1)
  assert.equal(Buffer.from(term.written[0]).toString(), 'HI')
})

test('disposing a viewer kills the whole bundle: no cross-writes from stale frames', () => {
  const h = makeHarness()
  const a = h.create({ conn: { id: 'conn-a' } })
  const wsA = a.socket()
  wsA.open()
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
  b.socket().open()
  b.socket().serverBinary([66])
  assert.equal(Buffer.from(b.term.written[0]).toString(), 'B')
})

test('viewer WS drop re-attaches with bounded backoff; server frames reset the budget', () => {
  const h = makeHarness()
  const { statuses, socket } = h.create()
  socket().open()
  socket().drop()
  assert.match(statuses.at(-1).text, /正在重新附着（1\/4）/)
  h.pumpTimers()
  assert.equal(FakeWebSocket.created.length, 2)
  assert.equal(h.timers.at(-1)?.delay, undefined) // re-attach timer already consumed by pumpTimers

  // server proof of life resets the attempt budget
  socket().open()
  socket().serverText({ type: 'ready', state: 'connected' })
  socket().drop()
  h.pumpTimers()
  assert.equal(FakeWebSocket.created.length, 3)

  // exhaust the budget: 4 attempts, then give up with an actionable message
  for (let i = 0; i < 10; i += 1) {
    socket().drop()
    h.pumpTimers()
  }
  const last = statuses.at(-1)
  assert.equal(last.kind, 'error')
  assert.match(last.text, /多次重连失败/)
  const countBefore = FakeWebSocket.created.length
  h.pumpTimers()
  assert.equal(FakeWebSocket.created.length, countBefore) // no more sockets after giving up
})

test('re-attach backoff grows linearly (0.8s × attempt)', () => {
  const h = makeHarness()
  const { socket } = h.create()
  socket().open()
  socket().drop()
  assert.equal(h.timers.at(-1).delay, 800)
  h.pumpTimers()
  socket().drop()
  assert.equal(h.timers.at(-1).delay, 1600)
  h.pumpTimers()
  socket().drop()
  assert.equal(h.timers.at(-1).delay, 2400)
})

test('SSH-level close ends the viewer: no re-attach after the WS drops', () => {
  const h = makeHarness()
  const { statuses, socket } = h.create()
  socket().open()
  socket().serverText({ type: 'status', state: 'closed' })
  socket().drop()
  h.pumpTimers()
  assert.equal(FakeWebSocket.created.length, 1)
  assert.equal(statuses.at(-1).text, '会话已结束')
})

test('NO_CONNECTION marks the viewer dead and surfaces an actionable error', () => {
  const h = makeHarness()
  const { statuses, socket } = h.create()
  socket().open()
  socket().serverText({ type: 'error', code: 'NO_CONNECTION', message: '连接不存在或已关闭' })
  assert.equal(statuses.at(-1).kind, 'error')
  socket().drop()
  h.pumpTimers()
  assert.equal(FakeWebSocket.created.length, 1)
})

test('waiting-fingerprint surfaces to app.js via onFrame without ending the viewer', () => {
  const h = makeHarness()
  const { statuses, frames, socket } = h.create()
  socket().open()
  socket().serverText({ type: 'status', state: 'waiting-fingerprint', token: 'tok-1', fingerprint: 'SHA256:abc' })
  assert.equal(statuses.at(-1).kind, 'warn')
  assert.equal(frames.at(-1).token, 'tok-1')
  socket().drop() // viewer blip while the user decides — re-attach is allowed
  h.pumpTimers()
  assert.equal(FakeWebSocket.created.length, 2)
})

test('malformed control frames are ignored without breaking the session', () => {
  const h = makeHarness()
  const { statuses, socket } = h.create()
  socket().open()
  const before = statuses.length
  socket().serverRaw('@@@ not json')
  socket().serverRaw('{"no-type":1}')
  socket().serverRaw('[]')
  assert.equal(statuses.length, before)
})

test('outgoing resize is clamped before it reaches the wire', () => {
  const h = makeHarness()
  const { term, socket } = h.create()
  const ws = socket()
  ws.open()
  term.handlers.resize({ cols: 99999, rows: -3 })
  term.handlers.resize({ cols: 100, rows: 30 })
  const resize = ws.sent.map(s => JSON.parse(s)).filter(f => f.type === 'resize')
  assert.deepEqual(resize[0], { type: 'resize', cols: 1000, rows: 2 })
  assert.deepEqual(resize[1], { type: 'resize', cols: 100, rows: 30 })
})

test('container resize fits through rAF, coalesced; a dead session never fits again', () => {
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

test('dispose cancels pending re-attach and unwinds every listener', () => {
  const h = makeHarness()
  const { session, term, socket } = h.create()
  socket().open()
  socket().drop() // schedules a re-attach timer
  session.dispose()
  h.pumpTimers()
  assert.equal(FakeWebSocket.created.length, 1) // timer was cancelled
  assert.equal(term.disposed, true)
  assert.equal(h.winListeners.size, 0) // window resize listener removed
})

// ---- U1：主题 / 字号 / 查找 / 清屏 / 直写输入 -------------------------------

test('applyTheme pushes a new xterm theme onto the live terminal', () => {
  const h = makeHarness()
  const { session, term } = h.create()
  session.applyTheme({ background: '#010203', foreground: '#040506', cursor: '#070809' })
  assert.equal(term.options.theme.background, '#010203')
  assert.equal(term.options.theme.foreground, '#040506')
  session.applyTheme(null)
  session.applyTheme('nope')
  assert.equal(term.options.theme.background, '#010203') // 非法输入被忽略
})

test('setFontSize clamps to 12–20 and schedules a re-fit', () => {
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

test('find scans the buffer, selects matches and navigates with wrapping', () => {
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

test('clearLocal clears the local display only; input writes straight to the socket', () => {
  const h = makeHarness()
  const { session, term, socket } = h.create()
  const ws = socket()
  ws.open()
  session.clearLocal()
  assert.equal(term.cleared, true)
  session.input('ls\n')
  const inputFrames = ws.sent.filter(s => typeof s === 'string').map(s => JSON.parse(s)).filter(f => f.type === 'input')
  assert.deepEqual(inputFrames, [{ type: 'input', data: 'ls\n' }])
})

test('onResize callback reports viewer size changes', () => {
  const h = makeHarness()
  const sizes = []
  const { term } = h.create({ extra: { onResize: size => sizes.push({ ...size }) } })
  term.handlers.resize({ cols: 120, rows: 40 })
  assert.deepEqual(sizes.at(-1), { cols: 120, rows: 40 })
})
