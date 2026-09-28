import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * 主视图会话取数契约（2026-09-27 实机故障的回归锁）。
 *
 * 现象：用户点终端按钮，底部面板出来了但里面只有空态「打开一个带工作区的会话后
 * 即可启动终端」，终端打不开；审查 tab 同样不取数。
 *
 * 根因：`currentSessionCwd()` 按 `ctx.sessions.list.getSnapshot().current` 取
 * 「当前会话」，而会话列表快照**没有 current 字段** —— SessionListState 恒为
 * `{ ids, byId, phase, projectionsBySession }`（运行版
 * `@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.js`
 * 的 createSnapshotStore 初值与 projectList 的 list.set 为证）。于是
 * `snapshot.current` 恒 undefined ⇒ reviewCwd 恒 null ⇒ 终端的 cwd 守卫
 * （`当前会话没有工作区`）与空态永远跳过自动开标签。
 *
 * 正确判据与官方 ui-session 的 publishMain 同款：`retainedBy.mainView > 0`
 * （mainView retain 源由官方 ui-workspace 打开主视图会话时持有）。
 *
 * 抽取手法与 rightbar-guide.test.js 一致：按源码锚点抽取闭包内的
 * mainSessionIdOf 并以注入 ctx 求值；锚点改名或挪位会**响亮失败**。
 */
const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

/** 抽取 mainSessionIdOf（apply 闭包内的模块级箭头函数，ctx 以参数注入）。 */
function loadMainSessionIdOf(ctx) {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const marker = 'const mainSessionIdOf = '
  const at = source.indexOf(marker)
  assert.notStrictEqual(at, -1, 'client.js 里找不到 mainSessionIdOf 定义')
  const exprStart = at + marker.length
  const exprEnd = source.indexOf('\n\n', exprStart)
  assert.notStrictEqual(exprEnd, -1, 'mainSessionIdOf 之后缺少空行锚点')
  const expression = source.slice(exprStart, exprEnd).trim().replace(/,$/, '')
  return new Function('ctx', `return (${expression})`)(ctx)
}

const snapshotOf = rows => ({ ids: Object.keys(rows), byId: rows, phase: 'ready', projectionsBySession: {} })

test('无 current 字段的快照里按 mainView 判据取到主会话', () => {
  const fn = loadMainSessionIdOf({ sessions: { retainInfo: () => ({ getSnapshot: () => ({ retainedBy: {} }) }) } })
  const snapshot = snapshotOf({
    's-sub': { id: 's-sub', cwd: '/repo/sub', retainedBy: { subagent: 1 } },
    's-main': { id: 's-main', cwd: '/repo/main', retainedBy: { mainView: 1 } },
  })
  assert.equal(fn(snapshot), 's-main')
})

test('快照行 retainedBy 陈旧时回落 retainInfo 实时读', () => {
  // 切换瞬间：list 快照里两行都还没有 mainView（publishRetention 尚未投影），
  // 但 retainInfo.getSnapshot() 直达 scopes record，是实时的。
  const live = { 's-a': { mainView: 0 }, 's-b': { mainView: 1 } }
  const ctx = {
    sessions: {
      retainInfo: id => ({ getSnapshot: () => ({ retainedBy: live[id] }) }),
    },
  }
  const fn = loadMainSessionIdOf(ctx)
  const snapshot = snapshotOf({
    's-a': { id: 's-a', cwd: '/repo/a', retainedBy: { mainView: 1 } },
    's-b': { id: 's-b', cwd: '/repo/b', retainedBy: {} },
  })
  // 第一路 find 命中 s-a（快照行），说明 stale 场景由 retainInfo 兜底仅在
  // 快照全无 mainView 时生效；两个会话都在时以快照为准。
  assert.equal(fn(snapshot), 's-a')

  const stale = snapshotOf({
    's-a': { id: 's-a', cwd: '/repo/a', retainedBy: { subagent: 1 } },
    's-b': { id: 's-b', cwd: '/repo/b', retainedBy: { subagent: 1 } },
  })
  assert.equal(fn(stale), 's-b', '快照无 mainView 时必须用 retainInfo 实时读兜底')
})

test('没有任何 mainView 会话时返回 undefined（cwd 取 null，不猜）', () => {
  const ctx = {
    sessions: { retainInfo: () => ({ getSnapshot: () => ({ retainedBy: {} }) }) },
  }
  const fn = loadMainSessionIdOf(ctx)
  assert.equal(fn(snapshotOf({})), undefined)
  assert.equal(fn(snapshotOf({ 's-x': { id: 's-x', retainedBy: {} } })), undefined)
  assert.equal(fn({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} }), undefined)
})

test('retainInfo 抛错时不外溢（回到 undefined，由上层 catch 收口）', () => {
  const ctx = { sessions: { retainInfo: () => { throw new Error('no scopes') } } }
  const fn = loadMainSessionIdOf(ctx)
  assert.equal(fn(snapshotOf({ 's-x': { id: 's-x', retainedBy: {} } })), undefined)
})

test('回归对照：旧取数法 snapshot.current 恒为 undefined', () => {
  // 这正是 2026-09-27 故障的机理：SessionListState 没有 current 字段。
  const snapshot = snapshotOf({ 's-main': { id: 's-main', cwd: '/repo/main', retainedBy: { mainView: 1 } } })
  assert.equal(snapshot.current, undefined)
  assert.equal(snapshot.current === undefined ? null : snapshot.byId[snapshot.current]?.cwd, null)
})

test('源码静态断言：不得回潮到 snapshot.current，且必须保留 mainView 判据', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  // 注释里允许出现 snapshot.current（根因记录），只扫**代码行**：
  // 整行注释与块注释行剥掉后再匹配。React ref 的 `.current`
  // （anchorRef.current / copiedTimer.current / hunkRefs.current）与 CSS 类名
  // 不在断言范围内——死的只有「会话快照的 .current」这一个形态。
  const codeLines = source.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
  const code = codeLines.join('\n')
  assert.doesNotMatch(code, /snapshot\.current/, '会话快照没有 current 字段')
  assert.doesNotMatch(code, /getSnapshot\(\)\.current/, '会话快照没有 current 字段')
  assert.match(source, /mainSessionIdOf\(snapshot\)/, 'currentSessionCwd 必须走 mainSessionIdOf')
  assert.match(source, /retainedBy\?\.mainView/, '主视图判据必须读 retainedBy.mainView')
})

test('源码静态断言：autoOpen 由 store 订阅驱动，不再一次性', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  assert.match(source, /const autoOpenOnce = \(\) =>/, 'autoOpen 必须提取为可重复触发的函数')
  assert.match(source, /store\.subscribe\(\(\) => \{[\s\S]*?autoOpenOnce\(\)/, 'cwd 晚到时必须补开终端（store 订阅驱动）')
  assert.match(source, /removeEmpty\(inst\)\s*\n\s*renderTabs\(inst\)/, 'cwd 到位必须重绘空态（过期文案/无按钮）')
  assert.match(source, /if \(inst\.offStore !== undefined && inst\.offStore !== null\)/, 'unmount 必须退订 store 订阅')
})
