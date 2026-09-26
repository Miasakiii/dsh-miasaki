// 桌面壳窗控让位取数（2026-09-27，T3）。
//
// 背景：`client.js` 的 `syncChrome()` 原先直接 `document.querySelector('#miasaki-titlebar .tb-group')`
// 量宽，并在注释里断言「按钮组宽度与 right 偏移固定，不随窗口尺寸变化，故无需监听 resize」。
// **前半句是错的**：宽度会被别的插件改 —— sidebar 线的终端键插进 `.tb-group` **首位**
// （`dsh-miasaki-sidebar/client.js` 的 `titlebarButton.ensure`，108px → 136px）。而画布只在
// `open()` / `onFrameLoad()` / `showMapOverlay()` 三条路径各量一次，注入晚于首次取数时就
// **一直少让 28px**，且没有任何自愈路径。
//
// 本文件守两件事：
//   ① 取数契约化 —— `window.miasakiDesktop`（desktop 线 `themes/src/10-contract.js`）在位时
//      `reserve = ceil(innerWidth - chrome.bounds().left + 6)`，并在初始化时订阅 `chrome.onChange`
//      （壳窗控组尺寸 / 位置变化 → 重发一次），退订挂在 apply 的清理效果里；
//   ② 契约缺失（浏览器直开 / 旧壳）退化为**原样保留**的 DOM 探针（`.tb-group` 优先 / `.tb-capsule` 兜底）。
//
// 手法与 `header-adaptive.test.js` 同源：`client.js` 是 `__ModuleLoader__` bundle（没有 exports），
// 因此按源码锚点把「契约取名 + `syncChrome` + 订阅」三段**真实代码**切出来用 `new Function` 求值，
// `window` / `document` / `HTMLElement` / `send` 全部以参数注入 —— 零依赖，不引入 jsdom。
// 锚点改名会**响亮失败**，不会静默通过。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const CLIENT_URL = new URL('../client.js', import.meta.url)
const DECL = "var d = typeof window !== 'undefined' ? window.miasakiDesktop : undefined"

/** 按锚点切片；缺锚点立刻失败（防止改名后测试静默通过）。 */
function slice(source, from, to) {
  const start = source.indexOf(from)
  assert.notStrictEqual(start, -1, `client.js 里找不到起始锚点：${from}`)
  const end = source.indexOf(to, start + from.length)
  assert.notStrictEqual(end, -1, `client.js 里找不到结束锚点：${to}`)
  return source.slice(start, end)
}

/** DOM 仿真：探针只用到 `instanceof HTMLElement` 与 `getBoundingClientRect()` 两处。 */
class FakeElement {
  constructor(rect) { this.rect = rect }
  getBoundingClientRect() { return this.rect }
}

/**
 * 求值 client.js 里真实的三段代码：契约对象取名 / `syncChrome()` / `chrome.onChange` 订阅。
 * `send` 换成记录器，调用方据此断言下发的 `canvas:chrome.reserve`；`queries` 记录 DOM 探针
 * 被问过哪些选择器（用来证明「契约在位时不走探针」）。
 */
async function loadChromeSync({ desktop, innerWidth = 1280, nodes = {}, probeThrows = false } = {}) {
  const source = await readFile(CLIENT_URL, 'utf8')
  const declStart = source.indexOf(DECL)
  assert.notStrictEqual(declStart, -1, 'client.js 里找不到契约取名锚点（模块初始化只取一次）')
  const decl = source.slice(declStart, source.indexOf('\n', declStart))
  const block = slice(source, 'const syncChrome = () => {', 'const syncCurrentSession = () => {')

  const sends = []
  const queries = []
  const fakeWindow = { innerWidth, miasakiDesktop: desktop }
  const fakeDocument = {
    querySelector: selector => {
      queries.push(selector)
      if (probeThrows) throw new Error('无父文档场景')
      return nodes[selector] ?? null
    },
  }
  // 用拼接而非模板字符串：切出来的源码注释里含反引号，模板串会被它截断。
  const body = 'const send = (type, payload) => sends.push({ type, payload })\n'
    + decl + '\n' + block + '\nreturn { syncChrome, unsubscribeChrome }'
  const api = new Function('window', 'document', 'HTMLElement', 'sends', body)(
    fakeWindow, fakeDocument, FakeElement, sends)
  return { ...api, sends, queries }
}

/**
 * fake 契约：只实现本线消费的三个面（`has` / `chrome.bounds` / `chrome.onChange`），
 * 并按真实契约的纪律「能力表即事实」——`subscribe` 给了才登记 `chrome.onChange`。
 */
function fakeContract({ bounds = () => null, subscribe } = {}) {
  const calls = { bounds: 0, onChange: 0 }
  const capabilities = new Set(['chrome.bounds', ...(subscribe === undefined ? [] : ['chrome.onChange'])])
  return {
    calls,
    has: name => capabilities.has(name),
    chrome: {
      bounds: () => { calls.bounds += 1; return bounds() },
      ...(subscribe === undefined ? {} : { onChange: cb => { calls.onChange += 1; return subscribe(cb) } }),
    },
  }
}

test('契约在位：reserve 由 chrome.bounds() 的视口矩形算出，且不再问 DOM', async () => {
  const contract = fakeContract({
    bounds: () => ({ left: 1120, top: 5, right: 1256, bottom: 31, width: 136, height: 26 }),
    subscribe: () => () => {},
  })
  const api = await loadChromeSync({ desktop: contract, innerWidth: 1280 })

  api.syncChrome()
  // 1280 - 1120 + 6（余量）= 166
  assert.deepEqual(api.sends.at(-1), { type: 'canvas:chrome', payload: { reserve: 166 } })
  assert.equal(contract.calls.bounds, 1, '每次 syncChrome 恰好取一次契约读数')
  assert.deepEqual(api.queries, [], '契约在位时不得再走 DOM 探针')
})

test('订阅 chrome.onChange：按钮组被插键后重发一次，reserve 补上 28px', async () => {
  let box = { left: 1164, width: 108 } // 壳窗控组独处：1280 - 1164 + 6 = 122
  const listeners = []
  const contract = fakeContract({
    bounds: () => box,
    subscribe: cb => {
      listeners.push(cb)
      return () => { listeners.length = 0 }
    },
  })
  const api = await loadChromeSync({ desktop: contract, innerWidth: 1280 })
  assert.equal(contract.calls.onChange, 1, '初始化时若 has("chrome.onChange") 必须订阅')
  assert.equal(listeners.length, 1)

  api.syncChrome()
  assert.equal(api.sends.at(-1).payload.reserve, 122)

  // sidebar 线把终端键插到 .tb-group 首位：按钮组变宽 28px，左缘左移 28px。
  const before = api.sends.length
  box = { left: 1136, width: 136 }
  for (const listener of [...listeners]) listener()

  assert.equal(api.sends.length, before + 1, 'onChange 触发必须重发一次 canvas:chrome')
  assert.equal(api.sends.at(-1).type, 'canvas:chrome')
  assert.equal(api.sends.at(-1).payload.reserve, 150, '重发后 reserve 应补上少让的 28px')

  api.unsubscribeChrome()
  assert.equal(listeners.length, 0, '清理路径拿到的退订函数必须能摘掉监听')
})

test('契约缺失：回落 DOM 探针（.tb-group 优先 / .tb-capsule 兜底），且不订阅', async () => {
  const group = await loadChromeSync({
    desktop: undefined,
    innerWidth: 1280,
    nodes: { '#miasaki-titlebar .tb-group': new FakeElement({ left: 1166, width: 108 }) },
  })
  group.syncChrome()
  assert.deepEqual(group.sends.at(-1), { type: 'canvas:chrome', payload: { reserve: 120 } })
  assert.equal(group.unsubscribeChrome, null, '契约缺失时没有订阅源')

  // v3 旧类名（v4 去胶囊化之前的壳）：兜底路径必须原样保留。
  const legacy = await loadChromeSync({
    desktop: undefined,
    innerWidth: 1280,
    nodes: { '#miasaki-titlebar .tb-capsule': new FakeElement({ left: 1152, width: 122 }) },
  })
  legacy.syncChrome()
  assert.equal(legacy.sends.at(-1).payload.reserve, 134)
  assert.deepEqual(legacy.queries, ['#miasaki-titlebar .tb-group', '#miasaki-titlebar .tb-capsule'])

  // 普通浏览器：没有窗控组 ⇒ 0，行为与桌面适配之前一致。
  const plain = await loadChromeSync({ desktop: undefined, innerWidth: 1280 })
  plain.syncChrome()
  assert.equal(plain.sends.at(-1).payload.reserve, 0)

  // 契约对象在、但不是能力面（子 frame 只拿到 `{ protocolVersion, isDesktop, isLocalPage }` 空壳，
  // 没有 has）：按「契约不可用」处理 ⇒ 仍走 DOM 兜底，且不得抛错。
  const shell = await loadChromeSync({
    desktop: { protocolVersion: 1, isDesktop: true, isLocalPage: true },
    innerWidth: 1280,
    nodes: { '#miasaki-titlebar .tb-group': new FakeElement({ left: 1166, width: 108 }) },
  })
  shell.syncChrome()
  assert.equal(shell.sends.at(-1).payload.reserve, 120)
  assert.equal(shell.unsubscribeChrome, null)
  assert.deepEqual(shell.queries, ['#miasaki-titlebar .tb-group'])
})

test('量不到就让 0，绝不抛错：探针异常 / 非元素 / 宽度 0 / 契约返回 null', async () => {
  const throwing = await loadChromeSync({ desktop: undefined, innerWidth: 1280, probeThrows: true })
  throwing.syncChrome()
  assert.equal(throwing.sends.at(-1).payload.reserve, 0, '无父文档 / 探针异常必须兜底 0')

  const notElement = await loadChromeSync({
    desktop: undefined,
    innerWidth: 1280,
    nodes: { '#miasaki-titlebar .tb-group': { getBoundingClientRect: () => ({ left: 1166, width: 108 }) } },
  })
  notElement.syncChrome()
  assert.equal(notElement.sends.at(-1).payload.reserve, 0, '不是 HTMLElement 就当作量不到')

  const zeroWidth = await loadChromeSync({
    desktop: undefined,
    innerWidth: 1280,
    nodes: { '#miasaki-titlebar .tb-group': new FakeElement({ left: 0, width: 0 }) },
  })
  zeroWidth.syncChrome()
  assert.equal(zeroWidth.sends.at(-1).payload.reserve, 0)

  const noBox = await loadChromeSync({ desktop: fakeContract({ bounds: () => null }), innerWidth: 1280 })
  noBox.syncChrome()
  assert.equal(noBox.sends.at(-1).payload.reserve, 0, '契约量不到（null）⇒ 0')

  const zeroBox = await loadChromeSync({
    desktop: fakeContract({ bounds: () => ({ left: 1000, width: 0 }) }),
    innerWidth: 1280,
  })
  zeroBox.syncChrome()
  assert.equal(zeroBox.sends.at(-1).payload.reserve, 0, 'width <= 0 ⇒ 0')
  assert.deepEqual(zeroBox.queries, [], '契约在位（哪怕量不到）也不得回落 DOM 探针')
})

test('取值点纪律：契约对象只在模块初始化取一次，错误前提的注释已删除', async () => {
  const source = await readFile(CLIENT_URL, 'utf8')
  const declStart = source.indexOf(DECL)
  assert.notStrictEqual(declStart, -1, '契约对象要按冻结写法在模块初始化时取一次')
  assert.ok(declStart < source.indexOf('module.exports.apply'), '取名必须在模块初始化，不在 apply 内')

  const block = slice(source, 'const syncChrome = () => {', 'const syncCurrentSession = () => {')
  assert.doesNotMatch(block, /window\.miasakiDesktop/, 'syncChrome 不得每次重取契约对象')
  assert.match(block, /d\.has\('chrome\.bounds'\)/, '契约优先必须由 has() 判定')
  // DOM 探针是兜底路径，必须逐字保留（浏览器直开 / 旧壳）。
  assert.match(block, /document\.querySelector\('#miasaki-titlebar \.tb-group'\) \?\?\s*\n\s*document\.querySelector\('#miasaki-titlebar \.tb-capsule'\)/)

  // 旧注释断言「宽度固定 ⇒ 无需监听」——前提是错的（sidebar 会插终端键），必须换成准确描述：
  // 窗口尺寸确实不影响，但同排其他插件会插按钮；契约在位订阅，契约缺失才一次性探针。
  assert.doesNotMatch(source, /不随窗口尺寸变化，故无需监听 resize/)
  const rationale = slice(source, '// 取数口径（2026-09-27）', 'const syncChrome = () => {')
  assert.match(rationale, /契约优先，DOM 兜底/)
  assert.match(rationale, /窗口尺寸\*\*确实\*\*不影响按钮组的 right 偏移/)
  assert.match(rationale, /同排其他插件会往按钮组里插按钮/)
  assert.match(rationale, /108px → 136px/, '要让读者看见「28px 从哪来」的具体数字')
  assert.match(rationale, /必须订阅 chrome\.onChange/)
  assert.match(rationale, /不是\*\*官方 DSH chrome 的位置/, '契约量的是壳窗控组，不是官方 DSH chrome')
  // 退订挂在既有清理路径（themeObserver 那处）旁。
  assert.match(source, /themeObserver\?\.disconnect\(\)[\s\S]{0,400}?if \(typeof unsubscribeChrome === 'function'\) unsubscribeChrome\(\)/)
})
