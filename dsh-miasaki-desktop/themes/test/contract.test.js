// contract.test.js — 桌面壳↔渲染层契约 v1 的闸门（W1-T1.3，2026-09-25）。
//
// 守什么：`themes/src/10-contract.js` 暴露 `window.miasakiDesktop`，给七线插件一个
// **有版本号、可探测、可降级**的能力面（此前每个插件各自猜环境）。三条设计纪律必须被钉住：
//   ① 只暴露确实实现的能力（能力表即事实）；
//   ② 只读 + 订阅，**不得开写通道** —— 写通道已有既有的 hash 字段协议（05-sensors 的
//      petHashCmd / 02-core 的 syncHash），在契约里再写一套会立刻造出第三个 hash 写者，
//      正是 W0-T0.2 刚修掉的竞态；
//   ③ 子 frame 只给空壳（initialization_script 注入每个文档；08-ready.js:3-8 有"iframe 里
//      浮出两套假窗控"的实机教训）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const slicePath = join(desktop, 'themes', 'src', '10-contract.js')
const manifestPath = join(desktop, 'themes', 'src', 'MANIFEST.json')
const bundlePath = join(desktop, 'src-tauri', 'injected', 'theme-init.js')
const source = readFileSync(slicePath, 'utf8')

/** 造一个最小页面：可控 frame 身份 / origin / 主题属性，收集 observer 与事件监听。 */
function harness({ isTop = true, protocol = 'http:', hostname = '127.0.0.1', theme = 'zafkiel' } = {}) {
  const observers = []
  const listeners = {}
  const attrs = {}
  const dispatched = []
  if (theme !== null) attrs['data-miasaki-theme'] = theme

  const documentElement = { getAttribute: (n) => (n in attrs ? attrs[n] : null) }
  const win = {
    addEventListener: (n, fn) => { (listeners[n] = listeners[n] || []).push(fn) },
    removeEventListener: (n, fn) => { listeners[n] = (listeners[n] || []).filter((f) => f !== fn) },
    // v1.1 写能力是「派发内部事件」，这里记录派发以便断言
    dispatchEvent: (ev) => { dispatched.push(ev); return true }
  }
  win.top = isTop ? win : {}

  const sandbox = {
    window: win,
    document: { documentElement },
    location: { protocol, hostname },
    // VM 新 realm 没有 CustomEvent，注入一个最小实现
    CustomEvent: class {
      constructor(type, init) {
        this.type = type
        this.detail = init === undefined ? undefined : init.detail
      }
    },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; this.disconnected = false; observers.push(this) }
      observe(target, opts) { this.target = target; this.opts = opts }
      disconnect() { this.disconnected = true }
    }
  }
  vm.runInNewContext(source, sandbox)
  return { api: win.miasakiDesktop, observers, listeners, attrs, documentElement, dispatched }
}

test('分片已登记进 MANIFEST.order 且生成产物含它', () => {
  assert.ok(existsSync(slicePath), '缺少 themes/src/10-contract.js')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.ok(manifest.order.includes('10-contract.js'), '10-contract.js 未登记进 order（拼接唯一真相）')
  assert.ok(existsSync(bundlePath), '缺少 src-tauri/injected/theme-init.js（先跑 npm run gen-init）')
  assert.ok(
    readFileSync(bundlePath, 'utf8').includes('miasakiDesktop'),
    'theme-init.js 里找不到契约特征——MANIFEST 或分片与产物不同步，重跑 npm run gen-init'
  )
})

test('形态纪律：自包含 IIFE（不寄生大 IIFE，不共享作用域）', () => {
  assert.match(source, /^\/\*[\s\S]*?\*\/\s*;\(function \(\) \{/, '必须以 ;((function(){ 开头（前片末尾可能是 )()，防 ASI）')
  assert.match(source, /\}\)\(\)\s*$/, '必须以 })() 自闭合')
})

test('主帧：完整能力对象（版本号 + 能力表 + has 探测）', () => {
  const { api } = harness({ isTop: true })
  assert.equal(api.protocolVersion, 1)
  assert.equal(api.isDesktop, true)
  assert.equal(api.isLocalPage, false)
  // 注意：api 来自 vm 新 realm，其数组与本 realm 的 Array 原型不同 ⇒ 用 join 比较
  assert.equal(
    api.capabilities.join('|'),
    'theme.current|theme.onChange|theme.set|window.maxState.subscribe|window.controls|assets.baseUrl'
  )
  assert.equal(api.has('theme.current'), true)
  assert.equal(api.has('nope.at.all'), false)
  assert.equal(api.assets.baseUrl, 'http://127.0.0.1:39800/')
})

test('★ 子 frame：只给空壳（不得暴露能力对象）', () => {
  const { api } = harness({ isTop: false })
  assert.equal(api.protocolVersion, 1)
  assert.equal(api.isDesktop, true)
  assert.equal(api.capabilities, undefined, '子 frame 拿到了能力表')
  assert.equal(api.theme, undefined, '子 frame 拿到了 theme 命名空间')
  assert.equal(api.window, undefined, '子 frame 拿到了 window 命名空间')
  assert.equal(api.has, undefined)
})

test('本地唤醒页判定与 02-core 同口径（tauri.localhost）', () => {
  assert.equal(harness({ protocol: 'tauri:', hostname: 'localhost' }).api.isLocalPage, true)
  assert.equal(harness({ protocol: 'http:', hostname: 'tauri.localhost' }).api.isLocalPage, true)
  assert.equal(harness({ protocol: 'http:', hostname: '127.0.0.1' }).api.isLocalPage, false)
})

test('theme.current()：合法值直读、非法/缺失返回 null', () => {
  assert.equal(harness({ theme: 'kurkuriel' }).api.theme.current(), 'kurkuriel')
  assert.equal(harness({ theme: 'bogus' }).api.theme.current(), null, '非法主题必须返回 null 而非透传')
  assert.equal(harness({ theme: null }).api.theme.current(), null, '属性缺失必须返回 null')
})

test('theme.onChange：观察属性变化、回调给当前主题、退订即断开', () => {
  const h = harness({ theme: 'pure' })
  const seen = []
  const off = h.api.theme.onChange((t) => seen.push(t))
  assert.equal(h.observers.length, 1, '未注册 MutationObserver')
  assert.equal([...h.observers[0].opts.attributeFilter].join(','), 'data-miasaki-theme')
  h.attrs['data-miasaki-theme'] = 'zafkiel'
  h.observers[0].cb()
  assert.deepEqual(seen, ['zafkiel'])
  off()
  assert.equal(h.observers[0].disconnected, true, '退订未 disconnect')
})

test('theme.onChange：非法入参（非函数）安全返回空退订，不抛', () => {
  const h = harness()
  assert.equal(typeof h.api.theme.onChange(null), 'function')
  assert.equal(h.observers.length, 0, '非函数入参不应注册观察者')
})

test('window.onMaxStateChange：订阅 CustomEvent、解析 detail.max、退订即移除', () => {
  const h = harness()
  const seen = []
  const off = h.api.window.onMaxStateChange((m) => seen.push(m))
  const handlers = h.listeners['miasaki-max-state'] || []
  assert.equal(handlers.length, 1, '未注册 miasaki-max-state 监听')
  handlers[0]({ detail: { max: true } })
  handlers[0]({ detail: { max: false } })
  handlers[0]({}) // 缺 detail 不得抛
  assert.deepEqual(seen, [true, false, false])
  off()
  assert.equal((h.listeners['miasaki-max-state'] || []).length, 0, '退订未移除监听')
})

test('★ 只读纪律：契约内不得出现任何 hash 写通道', () => {
  // 只检查**代码**：注释里说明"为什么不这么做"是应当保留的文档，不该被误伤。
  // 剥离块注释与行首注释即可（本文件是自写源码，不含会藏 `//` 的行首字符串字面量；
  // 唯一含 `//` 的是 URL 常量 'http://127.0.0.1:39800/'，不在行首）。
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\.replaceState\s*\(/, '契约里出现 hash 写入（会造出第三个 hash 写者）')
  assert.doesNotMatch(code, /\bpetHashCmd\s*\(|\bsyncHash\s*\(/, '契约不得调用既有写通道')
  assert.doesNotMatch(code, /__TAURI__|\.invoke\s*\(/, '契约不得走 Tauri IPC（远程页无权限，且与既有通道重复）')
})

test('★ 能力表与暴露面一致（能力表即事实，不留"将来会有"的占位）', () => {
  const { api } = harness()
  for (const name of api.capabilities) {
    const [ns, member] = name.split('.')
    if (ns === 'theme') assert.equal(typeof api.theme[member], 'function', `${name} 声称支持但未实现`)
    if (ns === 'window') {
      if (member === 'controls') {
        assert.equal(typeof api.window.controls, 'object', `${name} 声称支持但未实现`)
        for (const c of ['minimize', 'maximize', 'close']) {
          assert.equal(typeof api.window.controls[c], 'function', `controls.${c} 缺失`)
        }
      } else {
        assert.equal(typeof api.window.onMaxStateChange, 'function', `${name} 声称支持但未实现`)
      }
    }
    if (ns === 'assets') assert.equal(typeof api.assets.baseUrl, 'string', `${name} 声称支持但未实现`)
  }
})

/* ---------------- v1.1 受控写能力（2026-09-25） ---------------- */

test('★ v1.1：theme.set 派发内部事件；非法名拒绝且不派发', () => {
  const h = harness()
  assert.equal(h.api.theme.set('kurkuriel'), true)
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0].type, 'miasaki-theme-set')
  assert.equal(h.dispatched[0].detail.theme, 'kurkuriel')

  assert.equal(h.api.theme.set('bogus'), false, '非法主题名必须拒绝')
  assert.equal(h.api.theme.set(''), false)
  assert.equal(h.api.theme.set(undefined), false)
  assert.equal(h.dispatched.length, 1, '被拒绝的调用不得派发事件')
})

test('★ v1.1：window.controls 派发内部事件、只暴露人话名', () => {
  const h = harness()
  assert.equal(h.api.window.controls.minimize(), true)
  assert.equal(h.api.window.controls.maximize(), true)
  assert.equal(h.api.window.controls.close(), true)
  assert.equal(
    h.dispatched.map((e) => e.type).join('|'),
    'miasaki-window-command|miasaki-window-command|miasaki-window-command'
  )
  assert.equal(
    h.dispatched.map((e) => e.detail.command).join('|'),
    'minimize|maximize|close',
    '内部协议名 min/max 不得透出，映射留在寄生侧'
  )
  // 内部协议名不得出现在公开面
  assert.equal(h.api.window.controls.min, undefined)
  assert.equal(h.api.window.controls.max, undefined)
})

test('★ v1.1：写能力仍不开 hash 通道（契约只派发事件）', () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\.replaceState\s*\(/, '契约不得直接写 hash')
  assert.match(code, /miasaki-theme-set/, '主题切换必须派发内部事件')
  assert.match(code, /miasaki-window-command/, '窗控必须派发内部事件')
})

test('★ v1.1：寄生侧必须真的监听（静态断言，防"派发了没人收"）', () => {
  const core = readFileSync(join(desktop, 'themes', 'src', '02-core.js'), 'utf8')
  const titlebar = readFileSync(join(desktop, 'themes', 'src', '06-titlebar.js'), 'utf8')
  assert.match(core, /addEventListener\('miasaki-theme-set'/, '02-core 必须监听主题切换事件')
  assert.match(core, /ORDER\.indexOf\(t\) >= 0/, '执行侧必须再校验一次白名单（双向校验）')
  assert.match(titlebar, /addEventListener\('miasaki-window-command'/, '06-titlebar 必须监听窗控事件')
  assert.match(titlebar, /petHashCmd\('min'\)/, '窗控必须复用既有 hash 写者（不新增写者）')
})
