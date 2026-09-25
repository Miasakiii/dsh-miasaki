// material.test.js — 原生材质事实落地的闸门（W4.2 材质分层，2026-09-25）。
//
// 守什么：外观线的玻璃档位 `mica` 语义是「用系统云母」，但实现是页面侧
// `backdrop-filter: blur(40px)`。Win11 上原生 Mica 同时生效 ⇒ 两层模糊（更糊、更耗电、
// 语义自相矛盾）。分工是「**壳说事实、页面选分支**」：
//   · 壳给预判值（`window.__MIA_NATIVE_MICA__`，随 initialization_script 注入）
//     并在页面就绪后用 DWM 实际结果广播 `miasaki-native-material`；
//   · 本分片把事实落到 `html[data-mia-native-mica]`；
//   · 外观线的 `mica` 档规则挂在 `:not([data-mia-native-mica="on"])` 上。
//
// 三条纪律钉死：① 只搬运事实、不做材质决策；② 拿不到预判值一律按 off（**保守** ——
// 宁可让页面侧玻璃兜住视觉，也不要"以为有原生材质、结果什么都没有"的裸窗口）；
// ③ document_start 跑，全程不得抛错。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const slicePath = join(desktop, 'themes', 'src', '12-material.js')
const manifestPath = join(desktop, 'themes', 'src', 'MANIFEST.json')
const bundlePath = join(desktop, 'src-tauri', 'injected', 'theme-init.js')
const source = readFileSync(slicePath, 'utf8')

const ATTR = 'data-mia-native-mica'

/** 造一个最小页面：`noRoot` = documentElement 缺失（极端环境）。 */
function harness({ predicted, noRoot = false } = {}) {
  const attrs = {}
  const listeners = {}
  const win = {
    addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn) }
  }
  if (predicted !== undefined) win.__MIA_NATIVE_MICA__ = predicted
  const sandbox = {
    window: win,
    document: { documentElement: noRoot ? null : { setAttribute: (k, v) => { attrs[k] = v } } }
  }
  vm.runInNewContext(source, sandbox)
  return {
    win,
    attrs,
    listeners,
    fireMaterial: (detail) => {
      const handler = (listeners['miasaki-native-material'] || [])[0]
      handler(detail === undefined ? {} : { detail })
    }
  }
}

test('分片已登记进 MANIFEST.order 且生成产物含它', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.ok(manifest.order.includes('12-material.js'), '12-material.js 未登记进 order')
  assert.ok(
    readFileSync(bundlePath, 'utf8').includes('data-mia-native-mica'),
    'theme-init.js 里找不到材质分片特征——重跑 npm run gen-init'
  )
})

test('形态纪律：自包含 IIFE', () => {
  assert.match(source, /^\/\*[\s\S]*?\*\/\s*;\(function \(\) \{/, '必须以 ;((function(){ 开头（防 ASI）')
  assert.match(source, /\}\)\(\)\s*$/, '必须以 })() 自闭合')
})

test('★ 首帧：预判 true → on；false / 缺失 → off', () => {
  assert.equal(harness({ predicted: true }).attrs[ATTR], 'on')
  assert.equal(harness({ predicted: false }).attrs[ATTR], 'off')
  assert.equal(harness().attrs[ATTR], 'off', '壳没给预判时必须按 off（保守）')
})

test('★ 预判只认严格 true（字符串 "true" 不算，避免与壳的序列化约定漂移）', () => {
  assert.equal(harness({ predicted: 'true' }).attrs[ATTR], 'off')
  assert.equal(harness({ predicted: 1 }).attrs[ATTR], 'off')
  assert.equal(harness({ predicted: null }).attrs[ATTR], 'off')
})

test('★ 修正：广播事件携带 DWM 实际结果时翻转属性', () => {
  const h = harness({ predicted: true }) // 预判有原生
  assert.equal(h.attrs[ATTR], 'on')
  h.fireMaterial({ mica: false }) // 实际 DWM 拒绝了
  assert.equal(h.attrs[ATTR], 'off', '实际值必须能推翻预判')
  h.fireMaterial({ mica: true })
  assert.equal(h.attrs[ATTR], 'on')
})

test('事件缺 detail / 非布尔 → 按 off（保守，不猜）', () => {
  const h = harness({ predicted: true })
  h.fireMaterial(undefined)
  assert.equal(h.attrs[ATTR], 'off')
  h.fireMaterial({})
  assert.equal(h.attrs[ATTR], 'off')
  h.fireMaterial({ mica: 'yes' })
  assert.equal(h.attrs[ATTR], 'on', 'truthy 即视为真（壳只发 true/false）')
})

test('documentElement 缺失（极端环境）不抛、不设置', () => {
  const h = harness({ predicted: true, noRoot: true })
  assert.deepEqual(h.attrs, {})
})

test('纪律：不做材质决策、不读外观线配置（只搬运事实）', () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /data-mia-glass|localStorage|appearance/i, '材质分片不得掺入外观线决策')
  assert.match(code, /addEventListener\('miasaki-native-material'/, '必须监听壳广播')
})
