// native-bg.test.js — 窗口底色回传的解析与合成闸门（W4.3，2026-09-25）。
//
// 守什么：Rust 侧的窗口底 / Mica 回退色是**硬编码两档**（main.rs:1652-1655）、只在窗口创建时
// 算一次；运行期切主题或换皮肤时不会更新 ⇒ Win10（Mica 不可用）会露出旧主题的实色底。
// 本分片把「页面实际底色」经 hash 的 `bg=` 字段回报给壳（6 位十六进制、不带 `#`——`#` 会
// 截断 fragment）。
//
// 两条边界必须钉死：
//   ① **半透明底要合成到不透明**（DSH 的 `--dsw-alias-bg-base` 是 alpha 值，直接取会得到
//      半透明色，DWM 不认）；
//   ② **拿不到不透明底就如实返回空串、放弃上报**——壳保持既有硬编码，绝不引入"猜一个颜色"
//      这种更难查的错误来源（宁可不变，不可变错）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../src/02-core.js', import.meta.url), 'utf8')

const slice = (() => {
  const begin = source.indexOf('/* @slice:native-bg:begin')
  assert.notEqual(begin, -1, '02-core.js 必须保留 @slice:native-bg:begin 标记')
  const end = source.indexOf('/* @slice:native-bg:end */', begin)
  assert.notEqual(end, -1, '02-core.js 必须保留 @slice:native-bg:end 标记')
  return source.slice(begin, end)
})()

/**
 * 造一个最小页面。`body`/`html` 是 computed backgroundColor 字面量。
 * `noApi` = 无 getComputedStyle；`throws` = getComputedStyle 抛异常。
 */
function harness({ body = 'rgba(0, 0, 0, 0)', html = 'rgba(0, 0, 0, 0)', noApi = false, throws = false } = {}) {
  const sandbox = {
    window: {},
    document: { body: { id: 'body' }, documentElement: { id: 'html' } }
  }
  if (!noApi) {
    const getComputedStyle = (el) => {
      if (throws) throw new Error('getComputedStyle blocked')
      return { backgroundColor: el.id === 'body' ? body : html }
    }
    sandbox.window.getComputedStyle = getComputedStyle
    // 被测代码用的是裸 `getComputedStyle`（浏览器里即 window 上的那个），VM 里要单独提供
    sandbox.getComputedStyle = getComputedStyle
  }
  vm.runInNewContext(slice, sandbox)
  return sandbox
}

test('初始 CUR_BG 为空串（未测量即不参与上报）', () => {
  assert.equal(harness().CUR_BG, '')
})

test('★ parseCssColor：rgb / rgba / 空格分隔 / 斜杠 / 百分比 alpha', () => {
  const { parseCssColor } = harness()
  assert.deepEqual({ ...parseCssColor('rgb(12, 11, 17)') }, { r: 12, g: 11, b: 17, a: 1 })
  assert.deepEqual({ ...parseCssColor('rgba(12, 11, 17, 0.8)') }, { r: 12, g: 11, b: 17, a: 0.8 })
  assert.deepEqual({ ...parseCssColor('rgba(12 11 17 / 50%)') }, { r: 12, g: 11, b: 17, a: 0.5 })
  assert.deepEqual({ ...parseCssColor('rgba(12, 11, 17, 25%)') }, { r: 12, g: 11, b: 17, a: 0.25 })
  assert.equal(parseCssColor('transparent'), null, '关键字色不得被误解析')
  assert.equal(parseCssColor('#0c0b11'), null, 'hex 不得被误解析（computed 值恒为 rgb() 形式）')
  assert.equal(parseCssColor(''), null)
  assert.equal(parseCssColor(undefined), null)
})

test('toHexColor：补零与越界 clamp', () => {
  const { toHexColor } = harness()
  assert.equal(toHexColor({ r: 12, g: 11, b: 17 }), '0c0b11')
  assert.equal(toHexColor({ r: 255, g: 0, b: 0 }), 'ff0000')
  assert.equal(toHexColor({ r: 300, g: -5, b: 12.6 }), 'ff000d', '越界必须 clamp、小数必须四舍五入')
})

test('不透明 body 底色 → 直接取用', () => {
  assert.equal(harness({ body: 'rgb(247, 244, 241)' }).resolveNativeBg(), 'f7f4f1')
})

test('★ 半透明 body 底 → 与 html 底合成到不透明', () => {
  // rgba(12,11,17,.5) over rgb(255,255,255) = (133.5, 133, 136) → 86 85 88
  assert.equal(
    harness({ body: 'rgba(12, 11, 17, 0.5)', html: 'rgb(255, 255, 255)' }).resolveNativeBg(),
    '868588'
  )
})

test('★ 半透明 body + 半透明/透明 html → 空串（放弃上报，不猜颜色）', () => {
  assert.equal(harness({ body: 'rgba(12, 11, 17, 0.8)', html: 'rgba(255, 255, 255, 0.5)' }).resolveNativeBg(), '')
  assert.equal(harness({ body: 'rgba(12, 11, 17, 0.8)', html: 'rgba(0, 0, 0, 0)' }).resolveNativeBg(), '')
})

test('完全透明的 body 底 → 空串', () => {
  assert.equal(harness({ body: 'rgba(0, 0, 0, 0)', html: 'rgb(255, 255, 255)' }).resolveNativeBg(), '')
})

test('取不到样式（无 API / 抛异常）→ 空串，不抛', () => {
  assert.equal(harness({ body: 'rgb(1, 2, 3)', noApi: true }).resolveNativeBg(), '')
  assert.equal(harness({ body: 'rgb(1, 2, 3)', throws: true }).resolveNativeBg(), '')
})

test('产出形态：只含 6 位十六进制（hash 里不得出现 `#`）', () => {
  const value = harness({ body: 'rgb(247, 244, 241)' }).resolveNativeBg()
  assert.match(value, /^[0-9a-f]{6}$/, '必须是 6 位小写十六进制')
  assert.doesNotMatch(value, /#/, '绝不能带 #（会截断 fragment）')
})

test('接线纪律：apply 与首帧都重算，且 bg 字段在 diag 之前', () => {
  // 顺序契约：syncHash 读 CUR_BG，故 apply 必须先算后同步
  assert.match(source, /CUR_BG = resolveNativeBg\(\)\s*\n\s*syncHash\(true\)/, 'apply 里必须"先算后同步"')
  assert.match(source, /\+ bgPart \+ '&diag='/, 'bg 必须排在 diag 之前（diag 恒为末字段）')
  const ready = source.indexOf('CUR_BG = resolveNativeBg()', source.indexOf('function apply'))
  assert.notEqual(ready, -1)
})
