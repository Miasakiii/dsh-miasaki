import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * 审查视图的持久化（client.js 模块级 `reviewView`）。
 *
 * 背景：自研壳退役后（2026-09-10 迁移官方右栏、2026-09-11 完成清理），官方
 * `tabActions` 只有 openResource / openTab / close —— **没有**「更新当前 tab 参数」
 * 的通道，`navigation.params` 只在打开时写入。故视图选择必须由本插件自管，
 * 语义为「上次查看的视图」（全局单值，跨 tab 与刷新保留）。
 *
 * 本文件锁死这条链路：默认值、非法值回退、写入与订阅通知、私有模式降级。
 * 它同时是「视图下拉不再依赖已退役的壳 store」这一修复的回归证明 ——
 * 修复前 `setTabView` 写的是壳的 tabs 数组，而该数组在官方右栏下恒为空，
 * 下拉点了没有反应。
 *
 * client.js 是 `__ModuleLoader__` bundle（没有 exports），故按源码抽取求值。
 * 注意与同目录 review-view.test.js 区分：那个测的是 **host 半**的四视图解析器。
 */
const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

/** 取一行 `const <name> = …` 的定义（不含换行），避免在测试里硬编码取值。 */
function constLine(source, name) {
  const at = source.indexOf(`const ${name} = `)
  assert.notStrictEqual(at, -1, `client.js 里找不到 ${name}`)
  const end = source.indexOf('\n', at)
  return source.slice(at, end)
}

/** 抽取常量 + readStoredReviewView + reviewView，注入 localStorage 求值。 */
function loadReviewView(localStorage) {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const start = source.indexOf('const readStoredReviewView = ')
  const end = source.indexOf('const store = {')
  assert.notStrictEqual(start, -1, 'client.js 里找不到 readStoredReviewView')
  assert.notStrictEqual(end, -1, 'client.js 里找不到 store 定义')
  const prelude = ['REVIEW_VIEW_KEY', 'REVIEW_VIEWS', 'REVIEW_DEFAULT_VIEW']
    .map(name => constLine(source, name)).join('\n')
  const factory = new Function('localStorage',
    `${prelude}
     ${source.slice(start, end)}
     return { reviewView, REVIEW_VIEWS, REVIEW_DEFAULT_VIEW, REVIEW_VIEW_KEY }`)
  return factory(localStorage)
}

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
  }
}

const throwingStorage = {
  getItem: () => { throw new Error('denied') },
  setItem: () => { throw new Error('denied') },
  removeItem: () => { throw new Error('denied') },
}

test('review view: 无记录时取默认视图', () => {
  const api = loadReviewView(makeStorage())
  assert.equal(api.reviewView.get(), api.REVIEW_DEFAULT_VIEW)
})

test('review view: 读取已保存的合法值', () => {
  const storage = makeStorage({ 'miasaki-sidebar:review-view': 'last' })
  const api = loadReviewView(storage)
  assert.equal(api.REVIEW_VIEW_KEY, 'miasaki-sidebar:review-view')
  assert.equal(api.reviewView.get(), 'last')
})

test('review view: 存储里是非法值时回退默认（不抛错）', () => {
  for (const bogus of ['bogus', '', 'STAGED', 'null']) {
    const api = loadReviewView(makeStorage({ 'miasaki-sidebar:review-view': bogus }))
    assert.equal(api.reviewView.get(), api.REVIEW_DEFAULT_VIEW, `非法值 ${JSON.stringify(bogus)} 应回退`)
  }
})

test('review view: set 合法值 → 更新、落盘、通知订阅者一次', () => {
  const storage = makeStorage()
  const api = loadReviewView(storage)
  let hits = 0
  const off = api.reviewView.subscribe(() => { hits += 1 })

  api.reviewView.set('staged')
  assert.equal(api.reviewView.get(), 'staged')
  assert.equal(storage.getItem('miasaki-sidebar:review-view'), 'staged', '必须落盘')
  assert.equal(hits, 1, '订阅者收到一次通知')

  api.reviewView.set('staged')
  assert.equal(hits, 1, '同值重复设置不通知')
  api.reviewView.set('bogus')
  assert.equal(hits, 1, '非法值被忽略且不通知')
  assert.equal(api.reviewView.get(), 'staged', '非法值不改变当前视图')

  off()
  api.reviewView.set('all')
  assert.equal(api.reviewView.get(), 'all')
  assert.equal(hits, 1, '退订后不再通知')
})

test('review view: 每个合法视图都可往返（REVIEW_VIEWS 全集）', () => {
  const storage = makeStorage()
  const api = loadReviewView(storage)
  for (const view of api.REVIEW_VIEWS) {
    api.reviewView.set(view)
    assert.equal(api.reviewView.get(), view)
    // 与初值相同的那个视图 set 会短路（不写盘），重载时取默认 —— 与该值一致，
    // 故这里断言「重载后读回该值」而不是「存储里一定有该键」。
    const reloaded = loadReviewView(storage)
    assert.equal(reloaded.reviewView.get(), view, `重新加载后应读回 ${view}`)
  }
  // 至少有一个非默认视图确实落了盘（否则上面的往返可能是假通过）
  assert.notEqual(api.REVIEW_DEFAULT_VIEW, 'last', '默认视图不应是 last，否则本用例失去区分力')
  assert.equal(storage.getItem('miasaki-sidebar:review-view'), 'last')
})

test('review view: localStorage 抛错时降级为内存态（读取回默认、写入不炸）', () => {
  const api = loadReviewView(throwingStorage)
  assert.equal(api.reviewView.get(), api.REVIEW_DEFAULT_VIEW)
  api.reviewView.set('all')
  assert.equal(api.reviewView.get(), 'all', '写盘失败仍应在内存里生效')
})
