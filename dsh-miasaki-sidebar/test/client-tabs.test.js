import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * client.js 是 `__ModuleLoader__` bundle（没有 exports），所以纯逻辑按源码
 * 抽取求值 —— 与 drawer-gesture.test.js 同一手法（桌面线注入层也用这招）。
 *
 * 覆盖两处「改错了很难在实机发现」的逻辑：
 *   1. 持久化 v3 与 v2/v1 迁移（升级不丢面板状态）；
 *   2. 目录分组与组内统计求和（审查列表的核心数据）。
 *
 * 抽取靠锚点，改名或挪位会**响亮失败**而不是静默通过。
 */
const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

/**
 * 模块级区段（常量 + normalizePersisted + load/savePersisted）。
 * 这一段用锚点切分而不是括号匹配：`normalizePersisted` 里有模板字符串
 * `${raw.tab}-1`，花括号计数会被字符串里的 `{` 骗到。
 */
function loadModuleLevel() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const start = source.indexOf('const STORAGE_PREFIX')
  const end = source.indexOf('const store = {')
  assert.notStrictEqual(start, -1, 'client.js 里找不到 STORAGE_PREFIX')
  assert.notStrictEqual(end, -1, 'client.js 里找不到 store 定义')
  const storage = new Map()
  const localStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
    removeItem: key => { storage.delete(key) },
  }
  const factory = new Function('localStorage',
    `${source.slice(start, end)}
     return { normalizePersisted, loadPersisted, savePersisted, REVIEW_VIEWS, REVIEW_DEFAULT_VIEW }`)
  return { api: factory(localStorage), storage }
}

/** 箭头函数体括号匹配（该函数体内字符串不含花括号）。 */
function loadArrowFunction(name) {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const marker = `const ${name} = `
  const at = source.indexOf(marker)
  assert.notStrictEqual(at, -1, `client.js 里找不到 ${name}`)
  const exprStart = at + marker.length
  const bodyStart = source.indexOf('{', source.indexOf('=>', exprStart))
  assert.notStrictEqual(bodyStart, -1, `${name} 缺少箭头函数体`)
  let depth = 0
  let end = -1
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  assert.notStrictEqual(end, -1, `${name} 的函数体未闭合`)
  return new Function(`"use strict";return (${source.slice(exprStart, end)})`)()
}

const { api, storage } = loadModuleLevel()
const groupEntries = loadArrowFunction('groupEntries')

// ---------------------------------------------------------------------------
// 持久化 v3 + 迁移
// ---------------------------------------------------------------------------

test('normalizePersisted: v3 shape round-trips, bad tab entries are dropped', () => {
  const normalized = api.normalizePersisted({
    open: true,
    width: 5000,
    tabs: [{ id: 'review-2', type: 'review', view: 'staged' }, { id: 'x', type: 'nope' }, null, 'junk'],
    active: 'review-2',
  })
  assert.equal(normalized.open, true)
  assert.equal(normalized.width, 600, '宽度超上限被 clamp')
  assert.deepEqual(normalized.tabs, [{ id: 'review-2', type: 'review', view: 'staged' }])
  assert.equal(normalized.active, 'review-2')
})

test('normalizePersisted: unknown review view falls back to the default', () => {
  const normalized = api.normalizePersisted({ tabs: [{ id: 'review-1', type: 'review', view: 'bogus' }], active: 'review-1' })
  assert.equal(normalized.tabs[0].view, api.REVIEW_DEFAULT_VIEW)
  // 终端标签不带 view 字段
  const terminal = api.normalizePersisted({ tabs: [{ id: 'terminal-1', type: 'terminal', view: 'staged' }], active: 'terminal-1' })
  assert.equal('view' in terminal.tabs[0], false)
})

test('normalizePersisted: active falls back to the last tab, empty list keeps null', () => {
  const fallback = api.normalizePersisted({ tabs: [{ id: 'a-1', type: 'review' }, { id: 'terminal-1', type: 'terminal' }], active: 'missing' })
  assert.equal(fallback.active, 'terminal-1')
  assert.equal(api.normalizePersisted({}).active, null)
  assert.deepEqual(api.normalizePersisted({}).tabs, [])
})

test('migration: a v2 single-tab record becomes a one-element v3 tab list', () => {
  storage.clear()
  storage.set('miasaki-sidebar:v2:session-a', JSON.stringify({ open: true, width: 420, tab: 'terminal' }))
  const restored = api.loadPersisted('session-a')
  assert.deepEqual(restored.tabs, [{ id: 'terminal-1', type: 'terminal' }])
  assert.equal(restored.active, 'terminal-1')
  assert.equal(restored.width, 420)
  // 迁移后写入 v3 并删除旧键
  assert.ok(storage.has('miasaki-sidebar:v3:session-a'), '必须写入 v3 键')
  assert.equal(storage.has('miasaki-sidebar:v2:session-a'), false, 'v2 键必须删除')
})

test('migration: a v1 global record migrates once and is removed', () => {
  storage.clear()
  storage.set('miasaki-sidebar:v1', JSON.stringify({ open: true, width: 360, tab: 'review' }))
  const first = api.loadPersisted('session-b')
  assert.deepEqual(first.tabs, [{ id: 'review-1', type: 'review', view: api.REVIEW_DEFAULT_VIEW }])
  assert.equal(storage.has('miasaki-sidebar:v1'), false, 'v1 全局键只迁移一次')
  // 第二个会话读不到 v1 了（已被消费），于是返回 null 保持当前 UI 状态
  assert.equal(api.loadPersisted('session-c'), null)
})

test('migration: v3 wins over a leftover v2 record, and no record returns null', () => {
  storage.clear()
  storage.set('miasaki-sidebar:v2:session-d', JSON.stringify({ tab: 'terminal' }))
  storage.set('miasaki-sidebar:v3:session-d', JSON.stringify({ tabs: [{ id: 'review-1', type: 'review', view: 'all' }], active: 'review-1' }))
  const restored = api.loadPersisted('session-d')
  assert.equal(restored.tabs[0].type, 'review')
  assert.equal(storage.has('miasaki-sidebar:v2:session-d'), true, 'v3 存在时不动 v2 键')
  assert.equal(api.loadPersisted('no-such-session'), null)
  assert.equal(api.loadPersisted(''), null, '空 sessionId 不读写存储')
})

test('savePersisted: writes the v3 key with tabs/active only', () => {
  storage.clear()
  api.savePersisted('session-e', {
    open: true,
    width: 400,
    tabs: [{ id: 'review-1', type: 'review', view: 'last' }],
    active: 'review-1',
    // 非持久化字段不得落盘
    drawerOffset: 120,
    pageVisible: false,
  })
  const raw = JSON.parse(storage.get('miasaki-sidebar:v3:session-e'))
  assert.deepEqual(raw, {
    open: true,
    width: 400,
    tabs: [{ id: 'review-1', type: 'review', view: 'last' }],
    active: 'review-1',
  })
})

// ---------------------------------------------------------------------------
// 目录分组与统计
// ---------------------------------------------------------------------------

test('groupEntries: groups by directory, sums stats, keeps paths normalized', () => {
  const groups = groupEntries([
    { path: 'lib/cache.ts', add: 155, del: 23, binary: false },
    { path: 'lib/oauth.ts', add: 37, del: 18, binary: false },
    { path: 'app/page.tsx', add: 7, del: 0, binary: false },
    { path: 'README.md', add: 3, del: 1, binary: false },
    { path: 'img.png', add: null, del: null, binary: true },
    { path: 'sub\\win.ts', add: 2, del: 2, binary: false },
  ])
  const byDir = new Map(groups.map(group => [group.dir, group]))
  assert.deepEqual([...byDir.keys()], ['', 'app', 'lib', 'sub'], '目录字典序，根目录是空串')
  assert.equal(byDir.get('').label, './')
  assert.equal(byDir.get('lib').label, 'lib/')
  assert.deepEqual([byDir.get('lib').add, byDir.get('lib').del], [192, 41], '组统计是组内求和')
  assert.deepEqual(byDir.get('lib').entries.map(entry => entry.name), ['cache.ts', 'oauth.ts'])
  assert.equal(byDir.get('sub').entries[0].name, 'win.ts', '反斜杠路径归一后取文件名')
})

test('groupEntries: binary entries contribute no numbers and do not fake a sum', () => {
  const groups = groupEntries([
    { path: 'assets/logo.png', add: null, del: null, binary: true },
    { path: 'assets/icon.svg', add: 4, del: 1, binary: false },
  ])
  const group = groups[0]
  assert.equal(group.counted, 1, '只有带数字的条目参与统计计数')
  assert.deepEqual([group.add, group.del], [4, 1])
})

test('groupEntries: an empty list produces no groups', () => {
  assert.deepEqual(groupEntries([]), [])
})
