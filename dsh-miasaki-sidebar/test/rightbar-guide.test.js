import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * 官方右栏「开始」引导页的入口胶囊契约（2026-09-10 实机故障的回归锁）。
 *
 * 现象：迁移到官方右栏后，打开右栏是一片**空白** —— 引导页没有渲染出「审查 / 终端」
 * 两个入口胶囊。原因不是注册失败（`sidebar.right.pane.tab` 的两个 body 都在册），
 * 而是 guide 条目的文本字段被当成字符串传了：
 *
 *   entry.title()            官方 GuideBody/EntryBox 的调用形态
 *   entry.description?.()    同上
 *
 * 传字符串 ⇒ TypeError ⇒ React 放弃整棵引导页子树 ⇒ 右栏一片空白。
 * 官方自身的写法见 `@deepseek-ai/dsh-client-ui-sidebar-files`：
 * `guide: [{ order: 10, title: () => t('guide.title'), description: () => t('guide.description') }]`。
 *
 * 抽取手法与 client-tabs.test.js / drawer-gesture.test.js 一致：client.js 是
 * `__ModuleLoader__` bundle（没有 exports），纯逻辑按源码锚点抽取求值；锚点改名或
 * 挪位会**响亮失败**而不是静默通过。
 */
const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

/** 抽取模块级的 rightBarGuideEntry 构造器并求值。 */
function loadGuideEntryFactory() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const marker = 'const rightBarGuideEntry = '
  const at = source.indexOf(marker)
  assert.notStrictEqual(at, -1, 'client.js 里找不到 rightBarGuideEntry 定义')
  const exprStart = at + marker.length
  const exprEnd = source.indexOf('\n\n', exprStart)
  assert.notStrictEqual(exprEnd, -1, 'rightBarGuideEntry 之后缺少空行锚点')
  const expression = source.slice(exprStart, exprEnd).trim().replace(/,$/, '')
  return new Function(`return (${expression})`)()
}

test('guide 条目把文本以函数形式暴露（官方按 entry.title() 调用）', () => {
  const entry = loadGuideEntryFactory()('审查', '收尾自检清单 + 本轮改动 diff', 10)
  assert.equal(typeof entry.title, 'function', 'title 必须是函数')
  assert.equal(typeof entry.description, 'function', 'description 必须是函数')
  assert.equal(entry.title(), '审查')
  assert.equal(entry.description(), '收尾自检清单 + 本轮改动 diff')
  assert.equal(entry.order, 10)
  assert.equal(entry.kind, undefined, 'kind 由官方 refresh() 从 definition.kind 注入，条目不自带')
})

test('官方渲染路径在抽取出的条目上不抛错', () => {
  const entry = loadGuideEntryFactory()('终端', '把系统终端打开到当前会话的工作目录', 20)
  assert.doesNotThrow(() => entry.title())
  assert.doesNotThrow(() => entry.description?.())
  // 描述缺省时官方走可选链，不应把 undefined 也变成调用
  const bare = loadGuideEntryFactory()('x', undefined, 30)
  assert.equal(bare.description?.(), undefined)
})

test('回归对照：字符串形态正是右栏空白的成因', () => {
  const broken = { title: '审查', description: '收尾自检清单', order: 10 }
  assert.throws(() => broken.title(), TypeError)
  assert.throws(() => broken.description?.(), TypeError)
})

test('注册处使用 rightBarGuideEntry，不再内联字面量条目', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  assert.match(source, /guide: \[rightBarGuideEntry\(/, '注册处应调用 rightBarGuideEntry')
  assert.doesNotMatch(source, /guide: \[\{ kind: tab\.kind/, '不应回退到内联字面量 guide 条目')
})
