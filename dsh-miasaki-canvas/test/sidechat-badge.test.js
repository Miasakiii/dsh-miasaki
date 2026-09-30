// 辅助对话（侧线）在会话布上的**可见性与标注**（2026-09-30）。
//
// 背景：sidebar 线的「辅助对话」用官方 `sessions.fork` 建侧线，并且**不在官方会话列表**里
// 显示（本仓「不占会话记录」的落点）。但**画布必须照旧显示它** —— 画布走宿主
// `ctx.sessions.list()`，与官方列表的可见性判据无关，这条线从来不归列表管。
//
// 本文件守住两件事：
//   ① 画布**不因为别线的隐藏而少画一条线**（数据面与列表可见性解耦）；
//   ② 侧线在画布上**可辨识**：线头卡、血缘树行、详情页三处都有「辅助对话」标注。
//
// 判据从哪来：官方 fork 出的 child 与用户手动拉的分支，在 header 上完全一样
// （都是 `parentSession` + `isSeeded`）⇒ **宿主侧区分不了**。唯一判据是 sidebar 写下的
// 跨包声明（localStorage 键 `miasaki-sidebar:sidechat:hidden:v1`，JSON 字符串数组），
// 与 desktop 线补丁 `patches/dsh-client-ui-workspace` 读的是同一份。
//
// 红线：读不到 / 坏掉 ⇒ 只是**没有标注**，画布其余行为一字不变（本线的显示权不依赖别线）。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8')

/** 抽 app.js 里那段声明读取求值（自包含，只依赖 localStorage 与 console）。 */
async function loadSideChatReader(storage, warn) {
  const source = await read('app.js')
  const start = source.indexOf('// --- 辅助对话（侧线）标注')
  const end = source.indexOf('// Sidebar thread list:')
  assert.notStrictEqual(start, -1, 'app.js 里找不到辅助对话标注段')
  assert.notStrictEqual(end, -1, 'app.js 里找不到侧栏线程列表锚点')
  const factory = new Function('localStorage', 'console',
    `${source.slice(start, end)}
     return { sideChatSessionIds, isSideChatThread, SIDECHAT_HIDDEN_KEY }`)
  return factory(storage, { warn: warn ?? (() => {}) })
}

/** 可变 localStorage 替身（同时记录读取次数，用来钉住缓存）。 */
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  const calls = { get: 0 }
  return {
    map,
    calls,
    getItem: key => { calls.get += 1; return map.has(key) ? map.get(key) : null },
    setItem: (key, value) => { map.set(key, String(value)) },
  }
}

const KEY = 'miasaki-sidebar:sidechat:hidden:v1'
const SIDECHAT = 'session-side'
const PLAIN = 'session-plain'

test('声明缺失：画布一条线都不少画，只是没有标注', async () => {
  const { sideChatSessionIds, isSideChatThread } = await loadSideChatReader(makeStorage())
  assert.strictEqual(sideChatSessionIds().size, 0)
  assert.strictEqual(isSideChatThread({ dshSessionId: SIDECHAT }), false)
  assert.strictEqual(isSideChatThread({ dshSessionId: null }), false)
  assert.strictEqual(isSideChatThread(null), false, '没有会话 id 的线不构成辅助对话')
  assert.strictEqual(isSideChatThread(undefined), false)
})

test('声明命中即标注：只有声明的 child 是辅助对话，别的线不受影响', async () => {
  const storage = makeStorage({ [KEY]: JSON.stringify([SIDECHAT]) })
  const { isSideChatThread } = await loadSideChatReader(storage)
  assert.strictEqual(isSideChatThread({ dshSessionId: SIDECHAT }), true)
  assert.strictEqual(isSideChatThread({ dshSessionId: PLAIN }), false, '普通会话（含用户手动 fork 的分支）不加标注')
})

test('声明坏掉：按「无标注」继续，并留痕一次（不静默吞错）', async () => {
  const warnings = []
  const storage = makeStorage({ [KEY]: '{ 这不是 JSON' })
  const { sideChatSessionIds } = await loadSideChatReader(storage, (...args) => warnings.push(args.join(' ')))
  assert.strictEqual(sideChatSessionIds().size, 0)
  assert.equal(warnings.length, 1, '声明坏了必须留痕')
  assert.match(warnings[0], /辅助对话声明不是合法 JSON/)
  sideChatSessionIds()
  sideChatSessionIds()
  assert.equal(warnings.length, 1, '缓存要挡住重复告警：渲染每帧都会问一次')
})

test('声明形态容错：非数组、空串、非字符串一律忽略', async () => {
  const objectShape = await loadSideChatReader(makeStorage({ [KEY]: '{"a":1}' }))
  assert.strictEqual(objectShape.sideChatSessionIds().size, 0, '对象不是合法声明形态')

  const mixed = await loadSideChatReader(makeStorage({ [KEY]: JSON.stringify([SIDECHAT, 42, null, '', { id: 1 }]) }))
  assert.deepStrictEqual([...mixed.sideChatSessionIds()], [SIDECHAT], '只收非空字符串')
})

test('缓存按「上一次读到的原始串」失效：原文变了就重算', async () => {
  const storage = makeStorage({ [KEY]: JSON.stringify([SIDECHAT]) })
  const { sideChatSessionIds, isSideChatThread } = await loadSideChatReader(storage)
  const first = sideChatSessionIds()
  assert.strictEqual(sideChatSessionIds(), first, '原文未变时返回同一个集合（不重复 parse）')
  assert.strictEqual(isSideChatThread({ dshSessionId: SIDECHAT }), true)

  storage.setItem(KEY, JSON.stringify([PLAIN]))
  const second = sideChatSessionIds()
  assert.notStrictEqual(second, first, '原文变了必须重算')
  assert.strictEqual(isSideChatThread({ dshSessionId: SIDECHAT }), false, '撤销声明后标注要消失')
  assert.strictEqual(isSideChatThread({ dshSessionId: PLAIN }), true)
})

test('源码契约：三处标注齐全，且卡头标注只挂线头卡', async () => {
  const app = await read('app.js')
  // 数据面：卡片打标来自 thread（渲染层零查找）。
  assert.match(app, /sideChat: isSideChatThread\(thread\)/, '卡片必须在 conversationCards 里按 thread 打标')
  // ① 线头卡徽标
  assert.match(app, /card\.turnIndex === 0 && card\.sideChat === true \? '<span class="sidechat-badge"/,
    '卡头徽标只挂线头卡（每轮都挂会糊成一片）')
  // ② 血缘树行徽标，且优先于「分支」
  assert.match(app, /isSideChat[\s\S]{0,60}?tree-sidechat[\s\S]{0,80}?辅助对话/, '树行徽标要带 tree-sidechat 类并写「辅助对话」')
  assert.match(app, /const isSideChat = isSideChatThread\(thread\)/, '树行也要按 thread 判')
  // ③ 详情页 badge
  assert.match(app, /const badge = isMerge \? '合并' : isSideChatThread\(thread\) \? '辅助对话'/)
})

test('源码契约：声明变化要重渲染 —— 靠跨文档 storage 事件，不靠轮询', async () => {
  const app = await read('app.js')
  assert.match(app, /window\.addEventListener\('storage', event => \{[\s\S]*?event\.key !== SIDECHAT_HIDDEN_KEY[\s\S]*?sideChatRaw = null[\s\S]*?render\(\)/)
  assert.doesNotMatch(app, /setInterval\([^)]*sideChat/i, '标注不该引入轮询（跨文档 storage 事件已经够）')
})

test('样式契约：三处标注都有样式，且随明暗主题两套', async () => {
  const css = await read('styles.css')
  assert.match(css, /\.tree-row i\.tree-sidechat \{ color: #0d9488; \}/)
  assert.match(css, /\.thread-card \.sidechat-badge \{/, '卡头徽标要照 merge-badge 的家族（inline-flex / 999px / 11px）')
  assert.match(css, /\.thread-card \.sidechat-badge \{[^}]*border-radius: 999px/)
  assert.match(css, /\[data-theme="dark"\] \.tree-row i\.tree-sidechat \{ color: #5eead4; \}/)
  assert.match(css, /\[data-theme="dark"\] \.thread-card \.sidechat-badge \{/)
  assert.match(css, /\.thread-card:has\(\.merge-badge\) \.sidechat-badge \{ margin-left: 0; \}/,
    '同时又是合并节点时，两个 auto 边距不能打架')
})

test('解耦契约：画布的显示权不读别线的会话列表判据', async () => {
  const app = await read('app.js')
  const client = await read('client.js')
  // 画布只认那份 localStorage 声明，且**只**认这一个键；不 import 别线、不判别线插件在场。
  assert.match(app, /const SIDECHAT_HIDDEN_KEY = 'miasaki-sidebar:sidechat:hidden:v1'/)
  // 注释里提到契约来源是应该的；这里禁的是**代码依赖**（import / require 别线的包）。
  assert.doesNotMatch(app + client, /(?:import|require)[^\n]*@miasaki\/dsh-/, '不 import 别线包')
  assert.doesNotMatch(app, /sessionVisible|origin === 'subagent'/,
    '不复制官方列表的可见性判据：画布不看 origin，只看那份声明')
  // 声明读不出来时不许影响别的渲染分支：只有 sideChatSessionIds 一处读它。
  assert.equal(app.match(/localStorage\.getItem\(SIDECHAT_HIDDEN_KEY\)/g)?.length, 1)
})
