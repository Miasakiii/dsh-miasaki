import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * 标题栏终端按钮的**写域边界**回归锁（2026-09-27 建立，同日随实机事件放宽为「能力门控」）。
 *
 * 背景：桌面壳的标题栏按钮组（`#miasaki-titlebar .tb-group`）是零占位浮层，壳用一个
 * CSS 变量给官方 DSH 控件留右边距（`themes/src/03-switcher.js`）。本线自 2026-09-12
 * 起往 `.tb-group` 首位插一个终端按钮，并在创建时**硬编码**把该变量写成 `156px`。
 *
 * 第一版契约（同日早先）：壳改用 `ResizeObserver` 观测 `.tb-group` 实宽**自动**计算
 * （公式 = 组宽 + 8 + 12：108→128、136→156，与手写值完全一致），故本线**只准插按钮，
 * 不准写变量**；断言为「变量名字面量不得出现在 client.js」。
 *
 * **2026-09-27 实机事件（用户报「右侧边栏按钮和终端按钮重叠」）暴露了那条契约的缺口**：
 * 迁移只完成了一半 —— 本线删掉写入**立即生效**（`exports["./client"]` 直指源码），
 * 而壳侧的自动计算要**重新编译 exe**（`include_str!` 编译期内嵌）。运行中的壳仍是
 * 9-26 12:47 构建的旧版 ⇒ 变量**无人写** ⇒ 回落到照「**无终端键**」定的静态兜底
 * `128px`，正好少让一格（26 + gap 2 = 28px）⇒ 官方 ExpandButton 压住终端键
 * （实机测量：官方 icon 距右缘 134.5–149.5px、终端键 icon 125.5–136.5px，两者相切）。
 *
 * 故契约放宽为**能力门控**：`chrome.bounds` 能力在位（新壳）⇒ 本线不写，壳是唯一写者；
 * 能力缺席（旧壳 / 浏览器直开）⇒ 本线按**同源公式**（`.tb-group` 实宽 + 8 + 12）兜底。
 * 本文件锁死三件事：① 写入必须过能力门控；② 公式必须从实宽算、不得再出现硬编码 px；
 * ③ 停止时只清理本线写过的值（否则会删掉新壳写进去的让位量）。
 */
const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

/** 截取 `titlebarButton` 里某个方法的源码块（到下一个同级方法名为止）。 */
function methodBody(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `未找到方法起点：${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `未找到方法终点：${endMarker}`)
  return source.slice(start, end)
}

test('让位量写入必须受 `chrome.bounds` 能力门控（新壳在位则不写）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const body = methodBody(source, 'writeReserve(group) {', 'watchReserve(group) {')
  assert.match(
    body,
    /has\('chrome\.bounds'\)/,
    '写让位量前必须判桌面壳的 chrome.bounds 能力：能力在位说明壳自己会观测实宽，本线再写就是第二个写者',
  )
  assert.match(
    body,
    /setProperty\('--ms-titlebar-reserve'/,
    '旧壳兜底路径应当写让位量（否则 03-switcher 的静态兜底按「无终端键」定值，插键后少让一格）',
  )
})

test('公式必须按 `.tb-group` 实宽计算，不得回潮成硬编码 px', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const body = methodBody(source, 'writeReserve(group) {', 'watchReserve(group) {')
  assert.match(body, /getBoundingClientRect\(\)\.width/, '必须量按钮组实宽')
  assert.doesNotMatch(body, /\+\s*'\s*\d+px'/, '不得把让位量写成字面量常量')
  assert.doesNotMatch(body, /156/, '不得再出现历史硬编码值 156')
})

test('停止时只清理本线写过的值（不删新壳写的让位量）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const body = methodBody(source, 'stop() {', 'watch() {')
  assert.match(body, /if \(titlebarButton\.wroteReserve\)/, 'removeProperty 必须被 wroteReserve 门控')
  assert.match(body, /stopReserveWatch\(\)/, '停止时应摘掉本线的 ResizeObserver')
})

test('对照：终端按钮注入逻辑仍在（只挪写域，不删功能）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  assert.match(source, /const titlebarButton = \{/, 'titlebarButton 定义应保留')
  assert.match(source, /#miasaki-titlebar \.tb-group/, '仍以壳标题栏按钮组为注入锚点')
  assert.match(source, /group\.insertBefore\(btn, first\)/, '仍插在 .tb-group 首位')
  assert.match(source, /new MutationObserver\(/, '仍靠 MutationObserver 维持首位')
  assert.match(source, /titlebarButton\.openMenu\(caret\)/, '▾ 菜单入口应保留')
})
