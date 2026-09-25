// console-hook.test.js — 渲染层 console 错误旁路的闸门（W2 收尾，2026-09-25）。
//
// 守什么：诊断报告的 `--- renderer console ---` 段此前**恒为空**（Rust 侧
// `diag::push_console_line` 与 `#[tauri::command] diag_console` 早已就位，但无写者）。
// 而 TODO 里那个挂了半个月的 P0（偶发「全黑无响应」）恰恰是**渲染层**异常 ——
// 挂起前最后的 console.error 往往是唯一线索。
//
// 三条纪律逐条钉死：
//   ① 只旁路不改变：原生 console.error 照常被调用（页面行为零变化）；
//   ② 只顶层 frame：子 frame 重复上报会把同一批错误灌进报告；
//   ③ 有界 + 节流：环形缓冲（50 条 / 16 KiB，丢最旧）+ 2s 批量一次（错误风暴不得打满 IPC）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const slicePath = join(desktop, 'themes', 'src', '11-console.js')
const manifestPath = join(desktop, 'themes', 'src', 'MANIFEST.json')
const bundlePath = join(desktop, 'src-tauri', 'injected', 'theme-init.js')
const source = readFileSync(slicePath, 'utf8')

/**
 * 造一个最小页面。`tauri=false` 模拟浏览器直开（无 __TAURI__）。
 * 定时器手动触发（`fireTimers`），便于断言节流行为。
 */
function harness({ isTop = true, tauri = true } = {}) {
  const nativeCalls = []
  const invokes = []
  const listeners = {}
  const timers = []
  const win = {
    addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn) }
  }
  win.top = isTop ? win : {}
  if (tauri) {
    win.__TAURI__ = {
      core: {
        invoke: (cmd, args) => { invokes.push({ cmd, args }); return Promise.resolve() }
      }
    }
  }
  const sandbox = {
    window: win,
    console: { error: (...args) => nativeCalls.push(args) },
    setTimeout: (fn) => { timers.push(fn); return timers.length },
    clearTimeout: () => {}
  }
  vm.runInNewContext(source, sandbox)
  return {
    win,
    nativeCalls,
    invokes,
    listeners,
    timerCount: () => timers.length,
    fireTimers: () => { while (timers.length > 0) timers.shift()() },
    /** 推入若干错误（走被包裹后的 console.error）。 */
    error: (...args) => sandbox.console.error(...args),
    linesOf: (i) => invokes[i].args.lines
  }
}

test('分片已登记进 MANIFEST.order 且生成产物含它', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.ok(manifest.order.includes('11-console.js'), '11-console.js 未登记进 order（拼接唯一真相）')
  const bundle = readFileSync(bundlePath, 'utf8')
  assert.ok(bundle.includes('diag_console'), 'theme-init.js 里找不到 console 钩子特征——重跑 npm run gen-init')
})

test('形态纪律：自包含 IIFE', () => {
  assert.match(source, /^\/\*[\s\S]*?\*\/\s*;\(function \(\) \{/, '必须以 ;((function(){ 开头（防 ASI）')
  assert.match(source, /\}\)\(\)\s*$/, '必须以 })() 自闭合')
})

test('★ 只旁路不改变：原生 console.error 照常被调用', () => {
  const h = harness()
  h.error('boom', 42)
  assert.equal(h.nativeCalls.length, 1, '原生 console.error 必须仍被调用')
  assert.equal([...h.nativeCalls[0]].join('|'), 'boom|42', '原生调用参数必须原样透传')
})

test('★ 上报：2s 节流后经 diag_console 批量推送', () => {
  const h = harness()
  h.error('one')
  h.error('two')
  assert.equal(h.timerCount(), 1, '多次 error 只应登记一个定时器（节流）')
  assert.equal(h.invokes.length, 0, 'flush 之前不得推送')
  h.fireTimers()
  assert.equal(h.invokes.length, 1)
  assert.equal(h.invokes[0].cmd, 'diag_console')
  // 注意：lines 来自 VM realm，其原型与本 realm 的 Array 不同 ⇒ 用 join 比较
  assert.equal([...h.linesOf(0)].join('|'), 'one|two')
  assert.equal(h.timerCount(), 0, 'flush 后不应留下定时器')
})

test('★ 子 frame：完全不装钩子（避免重复上报）', () => {
  const h = harness({ isTop: false })
  h.error('in-iframe')
  assert.equal(h.win.__MIASAKI_CONSOLE_HOOKED__, undefined, '子 frame 不得置钩子标记')
  assert.equal(h.timerCount(), 0, '子 frame 不得登记定时器')
  h.fireTimers()
  assert.equal(h.invokes.length, 0, '子 frame 不得上报')
})

test('非壳环境（无 __TAURI__）：不报错、不推送', () => {
  const h = harness({ tauri: false })
  h.error('browser-only')
  h.fireTimers()
  assert.equal(h.invokes.length, 0)
  assert.equal(h.nativeCalls.length, 1, '浏览器里原生行为不受影响')
})

test('★ 环形上限：超过 50 条只保留最新的', () => {
  const h = harness()
  for (let i = 0; i < 60; i++) h.error('e' + i)
  h.fireTimers()
  const lines = h.linesOf(0)
  assert.equal(lines.length, 50, '必须裁剪到 50 条上限')
  assert.equal(lines[0], 'e10', '丢弃的必须是最旧的')
  assert.equal(lines[49], 'e59', '保留的必须包含最新的')
})

test('单条超长截断 + 空白行丢弃', () => {
  const h = harness()
  h.error('x'.repeat(5000))
  h.error('   ')
  h.error('\n\t')
  h.fireTimers()
  const lines = h.linesOf(0)
  assert.equal(lines.length, 1, '空白行必须被丢弃')
  assert.equal(lines[0].length, 2001, '超长行截断到 2000 字符 + 省略号')
  assert.ok(lines[0].endsWith('…'))
})

test('非字符串参数（对象/Error）安全序列化', () => {
  const h = harness()
  h.error({ a: 1 })
  h.error(new Error('kaboom'))
  h.fireTimers()
  const lines = h.linesOf(0)
  assert.equal(lines[0], '{"a":1}')
  assert.ok(lines[1].includes('kaboom'), 'Error 必须带出 message/stack')
})

test('未捕获错误与未处理拒绝也进缓冲', () => {
  const h = harness()
  const onError = (h.listeners['error'] || [])[0]
  const onRejection = (h.listeners['unhandledrejection'] || [])[0]
  assert.equal(typeof onError, 'function', '必须监听 error')
  assert.equal(typeof onRejection, 'function', '必须监听 unhandledrejection')
  onError({ message: 'uncaught boom' })
  onRejection({ reason: 'rejected!' })
  h.fireTimers()
  const lines = h.linesOf(0)
  assert.ok(lines[0].startsWith('[uncaught]'), '未捕获错误必须有前缀标记')
  assert.ok(lines[1].startsWith('[unhandledrejection]'))
})

test('★ 与红条同一判据：ResizeObserver 调度噪声不进报告', () => {
  const h = harness()
  // 与 00-boot.js 红条过滤（2026-09-25）同一判据的两种形态
  h.error('ResizeObserver loop completed with undelivered notifications.')
  h.error('ResizeObserver loop limit exceeded')
  h.error('ResizeObserver loop limit exceeded.')
  const onError = (h.listeners['error'] || [])[0]
  onError({ message: 'ResizeObserver loop completed with undelivered notifications.' })
  h.error('真正的问题')
  h.fireTimers()
  const lines = h.linesOf(0)
  assert.equal(lines.length, 1, '调度噪声必须被过滤，只留真实错误')
  assert.equal(lines[0], '真正的问题')
})

test('重复注入（同一文档跑两次）只装一次钩子', () => {
  const h = harness()
  assert.equal(h.win.__MIASAKI_CONSOLE_HOOKED__, true)
  // 再跑一遍同一份源码（模拟 on_page_load 的二次 eval）：标记已存在即早退，不得重复包裹
  const timers2 = []
  vm.runInNewContext(source, {
    window: h.win,
    console: { error: () => {} },
    setTimeout: (fn) => { timers2.push(fn); return 1 }
  })
  assert.equal(timers2.length, 0, '第二次注入不得再装钩子')
})
