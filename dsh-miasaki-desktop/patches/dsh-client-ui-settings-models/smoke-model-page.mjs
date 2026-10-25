#!/usr/bin/env node
// smoke-model-page.mjs — 「设置 → 模型」编辑卡片真机冒烟（DSH 0.2.1 keyState 事故的验收固化）。
//
// 为什么存在（2026-10-20 事故）：
//   DSH 升到 0.2.1-rc.2 后重打本体补丁 `dsh-client-ui-settings-models`，其中一条编辑
//   （编辑卡片密钥区下方的无 Key 提示）锚点仍唯一命中、`verify` 三行 PASS、产物语法合法，
//   但它引用的 `keyState` 在 0.2.1 的新作用域里已不存在。真机点开任一 provider 的「编辑」
//   卡片时，整块内容区抛：
//       ReferenceError: keyState is not defined at curatedFields
//       slot entry crashed in 'settings.section'
//   设置页内容区整块变空白。修复方式是删掉那条编辑并重打补丁。
//   这证明：语法 / 锚点 / 逐字节三档静态闸门都拦不住「锚点命中但作用域已变」——
//   必须真的在浏览器里把「编辑」卡片点开，才能验收。本脚本把这个动作固化成一条命令。
//
// 前置条件：
//   ① miasaki 桌面端正在运行（后端监听 127.0.0.1:3080，日志里有 `dsh web: …token=…` 启动行）；
//   ② 本补丁已 apply 且生效（`node patch.mjs status` 报 patched，`node patch.mjs verify` 三行 PASS）；
//   ③ 系统装有 Microsoft Edge（默认探测 x86 / x64 两个安装路径，可用 --edge 覆盖）。
//
// 用法（在任意目录执行；token 只从日志读取、只用于导航，输出一律脱敏成 token=<redacted>）：
//   node smoke-model-page.mjs
//   node smoke-model-page.mjs --port 3080
//   node smoke-model-page.mjs --log "%LOCALAPPDATA%\miasaki\server.log"
//   node smoke-model-page.mjs --edge "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
//   node smoke-model-page.mjs --keep-open    # 调试：退出时不杀 Edge，保留 CDP 端口供人工看
//
// 流程：系统 Edge `--headless=new` + CDP 打开带 token 的地址 → 等前端加载 → 点「账号菜单」
// → 点「设置」→ 点「模型」→ 依次点开每个「编辑」卡片，检查设置弹窗文案同时含「API 密钥」与
// 「保存」。全程用 Runtime.enable / Log.enable / Page.enable 收集三类运行时错误：
// Runtime.exceptionThrown、Log.entryAdded(level=error)、Runtime.consoleAPICalled(type=error)。
//
// 判定：
//   PASS = 至少点开 1 个编辑卡片，且 0 条运行时错误 → [smoke] PASS，exit 0；
//   FAIL = 上述三类错误任一出现 / 编辑卡片没打开 / 找不到「模型」入口 / token 提取失败
//          → [smoke] FAIL（逐条打印错误文本与最多 15 行堆栈），exit 1。
//
// **这不是 CI 闸门，它是升级重打后的人工验收步骤。**
// 它要回答的是「真实浏览器里这张卡片能不能渲染」，只有真机上有答案；CI 能自证的只是
// 「补丁文件长得对」（`patch.mjs verify` / verify-all 那一层）。跑它的时机：每次 DSH 升级
// 重打本补丁后，或改过 EDITS 后 —— 手动跑一遍再收工。

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = '[smoke]'
const DEFAULT_PORT = 3080
/** Edge 安装路径候选（x86 安装是默认形态，64 位系统上固定在 Program Files (x86)）。 */
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
/** 页面导航后等前端 bundle 加载 + 首个会话列表渲染的固定等待。 */
const NAV_SETTLE_MS = 9000
/** 每次点开「编辑」卡片后的固定等待（再加一轮轮询容错）。 */
const EDIT_SETTLE_MS = 1500

/** 本脚本自己的错误类型：catch 到它时只打一行可读结论，不甩裸栈。 */
class SmokeError extends Error {}

/** 运行期状态。集中放一处，失败报告与清理都从这里取。 */
const state = {
  port: DEFAULT_PORT,
  logPath: '',
  token: '',
  keepOpen: false,
  edge: null,
  edgePath: '',
  debugPort: null,
  userDataDir: null,
  cdp: null,
  pageSessionId: null,
  openedCards: 0,
  editButtonCount: 0,
  /** 脚本自身判定出的失败原因（如找不到入口、卡片没打开、token 缺失）。 */
  failures: [],
  /** 页面侧收集到的运行时错误（未捕获异常 / 日志 error / console.error）。 */
  runtimeErrors: [],
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 统一输出前缀；所有行都过一遍脱敏（token / URL 不得出现在任何输出里）。 */
function log(message) {
  console.log(`${PREFIX} ${redact(message)}`)
}

function warn(message) {
  console.error(`${PREFIX} ${redact(message)}`)
}

/** 输出脱敏：token 字面量 + `token=…` 两种形态。占位符 `token=<redacted>` 本身不受影响。 */
function redact(value) {
  let text = String(value)
  if (state.token.length > 0) text = text.split(state.token).join('<redacted>')
  // 只吞 token 可能出现的字符（URL 安全字符集）。中文说明 / 省略号 `…` 必须原样保留，
  // 否则像「…?token=…」写进日志」这种句子会被整段误伤，报错反而看不懂。
  return text.replace(/token=[A-Za-z0-9\-._~+/=%]+/g, 'token=<redacted>')
}

/** 把异常压成一行可读文本；fetch 的 ECONNREFUSED 在 cause 里，要带出来。 */
function describeError(error) {
  if (error instanceof Error) {
    const code = error.code === undefined ? '' : ` ${error.code}`
    const cause = error.cause instanceof Error
      ? `（${error.cause.message}${error.cause.code === undefined ? '' : ` ${error.cause.code}`}）`
      : ''
    return `${error.message}${code}${cause}`
  }
  return String(error)
}

function defaultLogPath() {
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData === undefined || localAppData.length === 0) return ''
  return join(localAppData, 'miasaki', 'server.log')
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    port: DEFAULT_PORT,
    log: defaultLogPath(),
    edge: null,
    keepOpen: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--keep-open') {
      options.keepOpen = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    const flag = /^--(port|log|edge)$/.exec(arg)
    if (flag === null) throw new SmokeError(`未知参数：${arg}（可用 --port / --log / --edge / --keep-open / --help）`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new SmokeError(`参数 ${arg} 缺少取值`)
    index += 1
    if (flag[1] === 'port') {
      const port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SmokeError(`--port 取值非法：${value}（应为 1–65535 的整数）`)
      options.port = port
    } else if (flag[1] === 'log') {
      options.log = value
    } else {
      options.edge = value
    }
  }
  return options
}

function printUsage() {
  console.log('用法：node smoke-model-page.mjs [选项]')
  console.log('  --port <端口>   miasaki 后端端口（默认 3080）')
  console.log('  --log <路径>    含 dsh web 启动行的日志（默认 %LOCALAPPDATA%\\miasaki\\server.log）')
  console.log('  --edge <路径>   msedge.exe 完整路径（默认探测 x86 / x64 安装路径）')
  console.log('  --keep-open     退出时保留 headless Edge 与其临时资料目录（调试用）')
  console.log('  --help          显示本帮助')
}

// ---------------------------------------------------------------------------
// 第 1 步：从桌面端日志里取 token（只读，不落盘）
//
// 日志形态（每次 dsh web 启动写一行，历史累积很多行，必须取**最后一条**）：
//   dsh web: http://127.0.0.1:3080/?token=<token>
// 端口按 --port 过滤：同一份日志可能混着不同端口的启动行，取错端口等于拿旧 token 去
// 导航新服务，会得到一张未登录的页面，报错反而指向「找不到账号菜单」，误导排查。
// ---------------------------------------------------------------------------

function extractToken(logPath, port) {
  if (logPath === undefined || logPath.length === 0) {
    throw new SmokeError('无法确定日志路径：%LOCALAPPDATA% 为空。请用 --log 指定 miasaki 的 server.log。')
  }
  if (!existsSync(logPath)) {
    throw new SmokeError(
      `无法读取日志：${logPath} 不存在。miasaki 桌面端启动后会把「dsh web: http://127.0.0.1:${port}/?token=…」写进日志；` +
      '请确认桌面端已启动，或用 --log 指定正确路径。',
    )
  }
  let text
  try {
    text = readFileSync(logPath, 'utf8')
  } catch (error) {
    throw new SmokeError(`无法读取日志：${logPath}（${describeError(error)}）`)
  }
  const lines = text.split(/\r?\n/)
  const pattern = /dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+))/
  let lastMatch = null
  let token = null
  for (const line of lines) {
    const match = pattern.exec(line)
    if (match === null) continue
    lastMatch = { linePort: Number(match[2]), token: match[3] }
    // 同端口可能有多条历史启动行：一直覆盖，留下最后一条（token 每次启动都会变）。
    if (lastMatch.linePort === port) token = lastMatch.token
  }
  if (token === null || token.length === 0) {
    const lastPort = lastMatch === null ? null : lastMatch.linePort
    const hint = lastPort === null
      ? '日志里没有任何「dsh web: http://127.0.0.1:<端口>/?token=…」启动行。'
      : `日志里最后一条启动行的端口是 ${lastPort}，与 --port ${port} 不一致。`
    throw new SmokeError(`${hint}请确认 miasaki 后端确实监听 ${port}，或核对 --port / --log。`)
  }
  return token
}

// ---------------------------------------------------------------------------
// 第 2 步：确认 host 活着（在启动浏览器之前失败，错误更直白）
// ---------------------------------------------------------------------------

async function ensureHostRunning(port) {
  const url = `http://127.0.0.1:${port}/`
  try {
    // 无 token 访问根路径会返回 401 —— 那也说明 host 活着；连不上才是「没在跑」。
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
    await response.arrayBuffer().catch(() => {}) // guard-ok: 这里只探活 —— 无 token 访问根路径返回 401 同样证明 host 在跑，响应体内容与本脚本无关；读体失败不得被误判成「后端没起来」（真正的不可达由 fetch 抛错走下面显式 SmokeError）
  } catch (error) {
    throw new SmokeError(
      `无法连接 ${url}：miasaki 后端似乎没有在运行（${describeError(error)}）。` +
      `请先启动 miasaki 桌面端，确认 ${port} 端口在监听后再跑本脚本。`,
    )
  }
}

// ---------------------------------------------------------------------------
// 第 3 步：启动 headless Edge 并连上 CDP
//
// 用系统 Edge（不引入 playwright / puppeteer，零第三方依赖）；临时 profile 放系统临时目录
// （mkdtempSync(tmpdir())），退出时杀掉整棵 Edge 进程树并删掉 —— 仓库里不留任何临时文件。
// ---------------------------------------------------------------------------

function resolveEdgePath(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) {
    if (!existsSync(explicit)) throw new SmokeError(`--edge 指定的 Edge 不存在：${explicit}`)
    return explicit
  }
  const found = EDGE_CANDIDATES.find(candidate => existsSync(candidate))
  if (found === undefined) {
    throw new SmokeError(`找不到 Microsoft Edge（已探测：${EDGE_CANDIDATES.join(' / ')}）。可用 --edge 指定 msedge.exe 的完整路径。`)
  }
  return found
}

/** 找一个当前空闲的本地端口做 CDP 调试端口（避免固定端口被占用）。 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** 轮询 DevTools HTTP 端点，直到 Edge 起来并给出 browser WebSocket 地址。 */
async function waitForDevTools(debugPort) {
  const deadline = Date.now() + 20000
  let lastError = null
  while (Date.now() < deadline) {
    if (state.edge !== null && state.edge.exitCode !== null) {
      throw new SmokeError(`Edge 启动后立即退出（exit ${state.edge.exitCode}），无法建立 CDP 连接。`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return await response.json()
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(200)
  }
  throw new SmokeError(`Edge 在 20s 内没有开放 CDP 调试端口 ${debugPort}（${describeError(lastError)}）。`)
}

async function launchBrowser(edgePath) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-smoke-edge-'))
  state.userDataDir = userDataDir
  const debugPort = await findFreePort()
  const args = [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    // Node 内置 WebSocket 的握手可能带 Origin；新版 Chromium 默认拒绝非白名单 Origin。
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu',
    '--no-first-run',
    '--window-size=1280,800',
    'about:blank',
  ]
  log(`启动 headless Edge（CDP 端口 ${debugPort}，临时资料目录 ${userDataDir}）`)
  const child = spawn(edgePath, args, { stdio: 'ignore', windowsHide: true })
  // 下面用 once('spawn') / once('error') 竞速；这个空监听只为防止「error 未处理」直接崩进程。
  child.on('error', () => {})
  const spawnFailure = await new Promise(resolve => {
    child.once('spawn', () => resolve(null))
    child.once('error', error => resolve(error))
  })
  if (spawnFailure !== null) throw new SmokeError(`启动 Edge 失败：${describeError(spawnFailure)}`)
  state.edge = child
  state.edgePath = edgePath
  state.debugPort = debugPort
  const version = await waitForDevTools(debugPort)
  state.cdp = await CdpConnection.open(version.webSocketDebuggerUrl)
}

/** 最小 CDP 客户端：按 id 对响应，按 method 分发事件（够本脚本用，不做通用封装）。 */
class CdpConnection {
  constructor(webSocket) {
    this.webSocket = webSocket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
    this.openPromise = new Promise((resolve, reject) => {
      this.resolveOpen = resolve
      this.rejectOpen = reject
    })
    webSocket.addEventListener('open', () => this.resolveOpen())
    webSocket.addEventListener('error', () => this.rejectOpen(new SmokeError('连接 Edge CDP 失败：WebSocket 握手出错')))
    webSocket.addEventListener('close', () => {
      this.closed = true
      this.rejectOpen(new SmokeError('CDP 连接在握手阶段被关闭'))
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new SmokeError('CDP 连接在命令等待期间被关闭'))
      }
      this.pending.clear()
    })
    webSocket.addEventListener('message', event => this.handleMessage(event.data))
  }

  static async open(webSocketDebuggerUrl) {
    const connection = new CdpConnection(new WebSocket(webSocketDebuggerUrl))
    await connection.openPromise
    return connection
  }

  handleMessage(raw) {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error !== undefined) {
        pending.reject(new SmokeError(`CDP 命令 ${pending.method} 失败：${message.error.message}`))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message.method !== undefined) {
      const handlers = this.listeners.get(message.method)
      if (handlers !== undefined) for (const handler of handlers) handler(message.params, message.sessionId)
    }
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new SmokeError('CDP 连接已关闭'))
    const id = this.nextId
    this.nextId += 1
    const message = { id, method, params }
    if (sessionId !== undefined) message.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SmokeError(`CDP 命令超时（${timeoutMs}ms）：${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.webSocket.send(JSON.stringify(message))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new SmokeError(`向 Edge 发送 CDP 命令失败：${describeError(error)}`))
      }
    })
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(handler)
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.webSocket.close()
    } catch { /* 关闭失败不影响退出：进程会被 taskkill 兜底 */ } // guard-ok: 关闭 WebSocket 是无副作用收尾（连接随进程退出回收），吞错不会掩盖任何冒烟结论——真正的失败路径（host 不可达 / 卡片未打开 / 运行时异常）都在别处显式 throw 并计入 FAIL
  }
}

function callPage(method, params = {}, timeoutMs = 30000) {
  return state.cdp.send(method, params, state.pageSessionId, timeoutMs)
}

// ---------------------------------------------------------------------------
// 第 4 步：页面内动作 + 三类运行时错误的收集
// ---------------------------------------------------------------------------

/** Log / Runtime 的对象描述可能带堆栈；优先取字符串值，其次描述。 */
function describeRemoteObject(object) {
  if (object === undefined || object === null) return ''
  if (typeof object.value === 'string') return object.value
  if (object.value !== undefined) return JSON.stringify(object.value)
  if (object.unserializableValue !== undefined) return object.unserializableValue
  if (object.description !== undefined) return object.description
  return typeof object.type === 'string' ? object.type : ''
}

/**
 * 在点击任何东西**之前**就登记错误监听（Runtime.enable / Log.enable / Page.enable 之前调）。
 * 三类来源都收：
 *   ① 未捕获异常（ReferenceError / TypeError 这一类）；
 *   ② 浏览器日志里 level=error 的条目（含资源加载失败）；
 *   ③ console.error（React 错误边界通常把被捕获的渲染错误打到 console）。
 */
function registerErrorListeners() {
  state.cdp.on('Runtime.exceptionThrown', params => {
    const details = params.exceptionDetails ?? {}
    const description = details.exception?.description ?? ''
    const headline = description.split('\n')[0] || details.text || '(无描述)'
    state.runtimeErrors.push({ kind: '未捕获异常', headline, stack: description })
  })
  state.cdp.on('Log.entryAdded', params => {
    const entry = params.entry ?? {}
    if (entry.level !== 'error') return
    const location = entry.url === undefined
      ? ''
      : `${entry.url}${entry.lineNumber === undefined ? '' : `:${entry.lineNumber}`}`
    state.runtimeErrors.push({
      kind: '日志错误',
      headline: entry.text ?? '(无文本)',
      stack: [entry.source, location].filter(part => typeof part === 'string' && part.length > 0).join(' '),
    })
  })
  state.cdp.on('Runtime.consoleAPICalled', params => {
    if (params.type !== 'error') return
    const args = Array.isArray(params.args) ? params.args : []
    const headline = args.map(describeRemoteObject).filter(text => text.length > 0).join(' ')
    const stack = args.map(arg => arg?.description ?? '').filter(text => text.length > 0).join('\n')
    state.runtimeErrors.push({ kind: 'console.error', headline: headline || '(无文本)', stack })
  })
}

/** 建一个独立标签页，attach 成扁平会话，并打开三个要收集事件的 domain。 */
async function preparePage() {
  registerErrorListeners()
  const { targetId } = await state.cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await state.cdp.send('Target.attachToTarget', { targetId, flatten: true })
  state.pageSessionId = sessionId
  await callPage('Page.enable')
  await callPage('Runtime.enable')
  await callPage('Log.enable')
}

/** Runtime.evaluate 的薄封装：returnByValue，页面内异常转成 SmokeError（不算页面运行时错误）。 */
async function evaluate(expression) {
  const result = await callPage('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) {
    const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '(无描述)'
    throw new SmokeError(`页面内求值失败：${description}`)
  }
  return result.result?.value
}

/** 轮询页面表达式直到返回 ok=true 或超时；返回最后一次结果，调用方负责判 ok。 */
async function pollPage(expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    last = await evaluate(expression)
    if (last !== null && last !== undefined && last.ok === true) return last
    if (Date.now() >= deadline) return last
    await sleep(250)
  }
}

// 这几个选择器是 2026-10-20 真机实测可用的形态，直接沿用（改选择器前先真机复核）。
function expressionClickAccountMenu() {
  return `(() => {
    const button = Array.from(document.querySelectorAll('button')).find(element => element.getAttribute('aria-label') === '账号菜单')
    if (button === undefined) return { ok: false }
    button.click()
    return { ok: true }
  })()`
}

function expressionClickLeafText(label) {
  return `(() => {
    const wanted = ${JSON.stringify(label)}
    const matches = Array.from(document.querySelectorAll('body *')).filter(element => (
      element.children.length === 0
      && element.textContent.trim() === wanted
      && element.getClientRects().length > 0
    ))
    if (matches.length === 0) return { ok: false }
    matches[0].click()
    return { ok: true, tag: matches[0].tagName, candidates: matches.length }
  })()`
}

function expressionAnyEditButton() {
  return `(() => {
    const count = Array.from(document.querySelectorAll('button')).filter(button => button.textContent.trim() === '编辑').length
    return { ok: count > 0, count }
  })()`
}

function expressionClickEditButton(index) {
  return `(() => {
    const buttons = Array.from(document.querySelectorAll('button')).filter(button => button.textContent.trim() === '编辑')
    if (buttons.length <= ${index}) return { ok: false, count: buttons.length }
    buttons[${index}].click()
    return { ok: true, count: buttons.length }
  })()`
}

function expressionEditDialogOpen() {
  return `(() => {
    const dialogs = Array.from(document.querySelectorAll('[role=dialog]'))
    const opened = dialogs.some(dialog => {
      const text = dialog.innerText || ''
      return text.includes('API 密钥') && text.includes('保存')
    })
    return { ok: opened, dialogCount: dialogs.length }
  })()`
}

// ---------------------------------------------------------------------------
// 第 5 步：主流程
// ---------------------------------------------------------------------------

async function run(options) {
  state.token = extractToken(options.log, options.port)
  log(`目标 http://127.0.0.1:${options.port}/?token=<redacted>`)
  await ensureHostRunning(options.port)
  log(`host 存活（${options.port} 端口有 HTTP 响应），日志 ${options.log}`)

  const edgePath = resolveEdgePath(options.edge)
  await launchBrowser(edgePath)
  await preparePage()
  log('已连接 Edge CDP，开始加载 DSH 页面')

  const navigation = await callPage('Page.navigate', {
    url: `http://127.0.0.1:${options.port}/?token=${state.token}`,
  })
  if (navigation.errorText !== undefined) {
    throw new SmokeError(`页面导航失败：${navigation.errorText}（host 可能在响应前退出？）`)
  }
  log(`已导航，等待前端 bundle 与首个会话列表（约 ${Math.round(NAV_SETTLE_MS / 1000)}s）`)
  await sleep(NAV_SETTLE_MS)

  // ① 账号菜单
  const accountMenu = await pollPage(expressionClickAccountMenu(), 10000)
  if (accountMenu === null || accountMenu.ok !== true) {
    throw new SmokeError('页面上找不到「账号菜单」按钮（前端没加载完？token 失效导致停在未登录页？）')
  }
  log('已点开账号菜单')
  await sleep(1000)

  // ② 设置
  const settings = await pollPage(expressionClickLeafText('设置'), 8000)
  if (settings === null || settings.ok !== true) {
    throw new SmokeError('账号菜单里找不到「设置」入口（菜单没打开 / 文案变了？）')
  }
  log('已点击「设置」')
  await sleep(2000)

  // ③ 模型
  const models = await pollPage(expressionClickLeafText('模型'), 8000)
  if (models === null || models.ok !== true) {
    throw new SmokeError('设置弹窗里找不到「模型」导航项（FAIL 条件之一；也可能是设置页本身没渲染出来）')
  }
  log('已点击「模型」')
  await sleep(2000)

  // ④ 逐个点开编辑卡片
  const editButtons = await pollPage(expressionAnyEditButton(), 10000)
  const count = editButtons === null ? 0 : (editButtons.count ?? 0)
  if (count === 0) {
    throw new SmokeError('模型页上没有找到任何「编辑」按钮（provider 卡片没渲染？）')
  }
  state.editButtonCount = count
  const attempts = Math.min(8, count)
  log(`模型页找到 ${count} 个「编辑」按钮，本次逐个点开 ${attempts} 个验收`)
  for (let index = 0; index < attempts; index += 1) {
    const clicked = await evaluate(expressionClickEditButton(index))
    if (clicked === null || clicked.ok !== true) {
      throw new SmokeError(`第 ${index + 1} 个「编辑」按钮在点击前消失了（DOM 变了？）`)
    }
    await sleep(EDIT_SETTLE_MS)
    const dialog = await pollPage(expressionEditDialogOpen(), 5000)
    if (dialog === null || dialog.ok !== true) {
      const dialogCount = dialog === null ? 0 : (dialog.dialogCount ?? 0)
      throw new SmokeError(
        `第 ${index + 1} 个「编辑」按钮点开后没有检测到编辑卡片（[role=dialog] ${dialogCount} 个，` +
        '文案缺少「API 密钥」或「保存」）—— 这正是 slot entry crashed 导致内容区空白的形态',
      )
    }
    state.openedCards += 1
    log(`第 ${index + 1}/${attempts} 个「编辑」卡片已打开（弹窗文案含「API 密钥」与「保存」）`)
  }
}

// ---------------------------------------------------------------------------
// 第 6 步：退出清理与结果报告
// ---------------------------------------------------------------------------

/** 杀掉整棵 Edge 进程树（只 kill 主进程会留下 renderer / gpu 子进程与临时目录占位）。 */
async function stopEdge(child) {
  if (child === null || child.exitCode !== null) return
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  if (child.exitCode !== null) return
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    sleep(3000),
  ])
  if (child.exitCode === null) {
    try {
      child.kill('SIGKILL')
    } catch { /* 已退出 / 不可杀：临时目录清理仍会尝试，失败只警告 */ } // guard-ok: 杀浏览器进程是清理动作，taskkill 已先行；这里失败最多留下一个临时 profile 警告，不影响冒烟判定，也不得因此把 PASS 翻成 FAIL
    await sleep(500)
  }
}

function removeTempDir() {
  if (state.userDataDir === null) return
  try {
    rmSync(state.userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch (error) {
    warn(`警告：临时资料目录清理失败（不影响判定，可手动删除）：${state.userDataDir}（${describeError(error)}）`)
  }
  state.userDataDir = null
}

async function cleanup() {
  if (state.cdp !== null) {
    state.cdp.close()
    state.cdp = null
  }
  if (state.keepOpen && state.edge !== null) {
    log(`--keep-open：保留 headless Edge（pid ${state.edge.pid}，CDP 端口 ${state.debugPort}）`)
    log(`调试资料目录 ${state.userDataDir}`)
    log(`关闭方式：taskkill /PID ${state.edge.pid} /T /F`)
    return
  }
  if (state.edge !== null) {
    await stopEdge(state.edge)
    state.edge = null
  }
  removeTempDir()
}

/** 输出 PASS / FAIL，并返回 exit code。 */
function report() {
  const failures = state.failures
  const errors = state.runtimeErrors
  const passed = failures.length === 0 && errors.length === 0 && state.openedCards > 0
  const target = `http://127.0.0.1:${state.port}/?token=<redacted>`
  if (passed) {
    console.log(`${PREFIX} PASS 设置 → 模型页点开 ${state.openedCards} 个「编辑」卡片，0 条运行时错误（${target}）`)
    return 0
  }

  console.error(`${PREFIX} FAIL 设置 → 模型页冒烟未通过：点开 ${state.openedCards} 个「编辑」卡片，运行时错误 ${errors.length} 条，失败原因 ${failures.length} 条`)
  console.error(`${PREFIX}   目标 ${target}`)
  failures.forEach((failure, index) => {
    console.error(`${PREFIX}   失败 ${index + 1}/${failures.length}：${redact(failure)}`)
  })
  errors.forEach((error, index) => {
    console.error(`${PREFIX}   错误 ${index + 1}/${errors.length} [${error.kind}] ${redact(error.headline)}`)
    const lines = String(error.stack ?? '').split(/\r?\n/).slice(0, 15)
    const meaningful = lines.filter(line => line.trim().length > 0)
    if (meaningful.length > 0) {
      console.error(`${PREFIX}     堆栈（前 15 行）：`)
      for (const line of meaningful) console.error(`${PREFIX}       ${redact(line)}`)
    }
  })
  if (state.openedCards === 0 && failures.length === 0) {
    console.error(`${PREFIX}   失败原因：没有点开任何编辑卡片`)
  }
  const combined = errors.map(error => `${error.headline}\n${error.stack}`).join('\n')
  if (/slot entry crashed|ReferenceError|TypeError/.test(combined)) {
    console.error(`${PREFIX}   提示：出现 slot entry crashed / ReferenceError / TypeError —— 这正是 0.2.1`)
    console.error(`${PREFIX}         「keyState is not defined at curatedFields」事故的形态。静态闸门（语法 / 锚点 /`)
    console.error(`${PREFIX}         逐字节）拦不住「锚点命中但作用域已变」：请回查本补丁 EDITS 是否引用了旧`)
    console.error(`${PREFIX}         作用域变量，删除该编辑、重打补丁，再跑一次本脚本验收。`)
  }
  return 1
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

let helpRequested = false
try {
  const options = parseArgs(process.argv.slice(2))
  state.port = options.port
  state.logPath = options.log
  state.keepOpen = options.keepOpen
  if (options.help) {
    helpRequested = true
    printUsage()
  } else {
    await run(options)
  }
} catch (error) {
  if (error instanceof SmokeError) {
    state.failures.push(error.message)
  } else {
    const stack = error instanceof Error && error.stack !== undefined
      ? error.stack.split(/\r?\n/).slice(1, 6).join('\n')
      : ''
    state.failures.push(`${describeError(error)}${stack.length > 0 ? `\n${stack}` : ''}`)
  }
} finally {
  await cleanup()
}

process.exit(helpRequested ? 0 : report())
