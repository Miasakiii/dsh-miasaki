import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * M2 辅助对话的**侧线登记表**（client.js 模块级 `sideChatRegistry` 及其纯函数）。
 *
 * 为什么它是关键路径（不是缓存）：官方右栏会按会话持久化 tab 骨架
 * （localStorage 键 `dsh.sidebar-right.v1.<sessionId>`），但持久化的 tab 记录只有
 * `{ id, kind, contentId, title }` —— **不含 `params`**，还原时 `params` 恒为
 * `undefined`（0.1.7-rc.2 `dsh-client-ui-sidebar-right/lib/client.js:4941-4946` /
 * `:6090-6094`，2026-09-28 实读 + S7 实测）。⇒ 刷新后「这条 tab 该显示哪条侧线」
 * 只能由本表回答，故 fork 成功必须**同步**写盘。
 *
 * client.js 是 `__ModuleLoader__` bundle（没有 exports），故按源码抽取求值。
 */
const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

/** 抽取登记表常量 + 纯函数 + store，注入 localStorage 求值。 */
function loadSideChatRegistry(localStorage) {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const start = source.indexOf('const SIDECHAT_REGISTRY_KEY = ')
  const end = source.indexOf('// Module-level store for the content layer.')
  assert.notStrictEqual(start, -1, 'client.js 里找不到 SIDECHAT_REGISTRY_KEY')
  assert.notStrictEqual(end, -1, 'client.js 里找不到模块级 store 锚点')
  const factory = new Function('localStorage',
    `${source.slice(start, end)}
     return { sideChatRegistry, sideChatLinesFor, sideChatActiveFor, sideChatAddLine, sideChatSetActive, sideChatDropLine, SIDECHAT_REGISTRY_KEY }`)
  return factory(localStorage)
}

function makeStorage(initial = {}, { failWrite = false } = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (failWrite) throw new Error('QuotaExceededError')
      map.set(key, String(value))
    },
    removeItem: key => { map.delete(key) },
  }
}

const PARENT = 'session-parent'
const CHILD_A = 'session-child-a'
const CHILD_B = 'session-child-b'

test('空存储读出空表，损坏 JSON 也不抛（降级为空表）', () => {
  const empty = loadSideChatRegistry(makeStorage())
  assert.deepStrictEqual(empty.sideChatRegistry.get(), {})
  const corrupt = loadSideChatRegistry(makeStorage({ 'miasaki-sidebar:sidechat:v1': '{ 这不是 JSON' }))
  assert.deepStrictEqual(corrupt.sideChatRegistry.get(), {})
  const wrongShape = loadSideChatRegistry(makeStorage({ 'miasaki-sidebar:sidechat:v1': '[1,2,3]' }))
  assert.deepStrictEqual(wrongShape.sideChatRegistry.get(), {}, '数组不是合法的登记表形态')
})

test('新增侧线：登记该行并把新侧线置为 active', () => {
  const { sideChatRegistry, sideChatAddLine, sideChatLinesFor, sideChatActiveFor } = loadSideChatRegistry(makeStorage())
  sideChatRegistry.update(reg => sideChatAddLine(reg, PARENT, CHILD_A, 1000))
  const registry = sideChatRegistry.get()
  assert.strictEqual(sideChatActiveFor(registry, PARENT), CHILD_A)
  assert.deepStrictEqual(sideChatLinesFor(registry, PARENT), [{ childSessionId: CHILD_A, createdAt: 1000 }])
})

test('同一 child 重复登记不产生重复行（对账幂等）', () => {
  const { sideChatRegistry, sideChatAddLine, sideChatLinesFor } = loadSideChatRegistry(makeStorage())
  sideChatRegistry.update(reg => sideChatAddLine(reg, PARENT, CHILD_A, 1000))
  sideChatRegistry.update(reg => sideChatAddLine(reg, PARENT, CHILD_A, 2000))
  assert.strictEqual(sideChatLinesFor(sideChatRegistry.get(), PARENT).length, 1)
  assert.strictEqual(sideChatLinesFor(sideChatRegistry.get(), PARENT)[0].createdAt, 2000, '以最后一次登记为准')
})

test('切换 active：已知父会话生效，未知父会话原样返回（不凭空造行）', () => {
  const { sideChatRegistry, sideChatAddLine, sideChatSetActive, sideChatActiveFor } = loadSideChatRegistry(makeStorage())
  sideChatRegistry.update(reg => sideChatAddLine(reg, PARENT, CHILD_A, 1000))
  sideChatRegistry.update(reg => sideChatAddLine(reg, PARENT, CHILD_B, 2000))
  assert.strictEqual(sideChatActiveFor(sideChatRegistry.get(), PARENT), CHILD_B)
  sideChatRegistry.update(reg => sideChatSetActive(reg, PARENT, CHILD_A))
  assert.strictEqual(sideChatActiveFor(sideChatRegistry.get(), PARENT), CHILD_A)
  const before = sideChatRegistry.get()
  sideChatRegistry.update(reg => sideChatSetActive(reg, 'session-unknown', CHILD_A))
  assert.strictEqual(sideChatRegistry.get(), before, '未知父会话必须原样返回同一个引用')
})

test('摘除侧线：删掉 active 回退到最近一行，删空则 active 为 null', () => {
  const { sideChatRegistry, sideChatAddLine, sideChatDropLine, sideChatActiveFor, sideChatLinesFor } = loadSideChatRegistry(makeStorage())
  sideChatRegistry.update(reg => sideChatAddLine(reg, PARENT, CHILD_A, 1000))
  sideChatRegistry.update(reg => sideChatAddLine(reg, PARENT, CHILD_B, 2000))
  sideChatRegistry.update(reg => sideChatDropLine(reg, PARENT, CHILD_B))
  assert.strictEqual(sideChatActiveFor(sideChatRegistry.get(), PARENT), CHILD_A)
  sideChatRegistry.update(reg => sideChatDropLine(reg, PARENT, CHILD_A))
  assert.strictEqual(sideChatActiveFor(sideChatRegistry.get(), PARENT), null)
  assert.deepStrictEqual(sideChatLinesFor(sideChatRegistry.get(), PARENT), [])
})

test('写入落盘并通知订阅者；同值写入不通知（update 的 no-op 语义）', () => {
  const storage = makeStorage()
  const { sideChatRegistry, sideChatAddLine, sideChatSetActive } = loadSideChatRegistry(storage)
  let notified = 0
  const unsubscribe = sideChatRegistry.subscribe(() => { notified += 1 })
  sideChatRegistry.update(reg => sideChatAddLine(reg, PARENT, CHILD_A, 1000))
  assert.strictEqual(notified, 1)
  assert.match(storage.map.get('miasaki-sidebar:sidechat:v1'), new RegExp(CHILD_A))
  sideChatRegistry.update(reg => sideChatSetActive(reg, PARENT, CHILD_A)) // 已经是 active
  assert.strictEqual(notified, 1, '同值写入不得触发通知（避免无谓重渲染）')
  unsubscribe()
  sideChatRegistry.update(reg => sideChatAddLine(reg, PARENT, CHILD_B, 2000))
  assert.strictEqual(notified, 1, '退订后不再收到通知')
})

test('私有模式（写盘抛错）降级为内存生效，不把异常抛给调用方', () => {
  const { sideChatRegistry, sideChatAddLine, sideChatActiveFor, sideChatLinesFor } = loadSideChatRegistry(makeStorage({}, { failWrite: true }))
  assert.doesNotThrow(() => sideChatRegistry.update(reg => sideChatAddLine(reg, PARENT, CHILD_A, 1000)))
  assert.strictEqual(sideChatActiveFor(sideChatRegistry.get(), PARENT), CHILD_A)
  assert.strictEqual(sideChatLinesFor(sideChatRegistry.get(), PARENT).length, 1)
})

test('源码契约：fork 成功即同步写盘（登记表是刷新后唯一的侧线身份来源）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const at = source.indexOf('const createLine = () => {')
  assert.notStrictEqual(at, -1, 'client.js 里找不到 createLine')
  const body = source.slice(at, source.indexOf('const switchLine = ', at))
  assert.match(body, /createSideChat\(parentSessionId\)/, '新建侧线必须走 createSideChat（含并发去重）')
  assert.match(body, /\.then\(childId => \{[\s\S]*sideChatAddLine\(/, 'fork 的 then 里必须立刻登记')
  assert.match(body, /sideChatRegistry\.update\(/, '登记必须经 store 写入（含落盘与通知）')
})

test('源码契约：并发去重在 finally 里释放 key（不得退化成单例）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const at = source.indexOf('const createSideChat = ')
  assert.notStrictEqual(at, -1, 'client.js 里找不到 createSideChat')
  const body = source.slice(at, source.indexOf('const sideChatForkErrorText', at))
  assert.match(body, /pendingSideChatCreations\.get\(parentSessionId\)/, '必须查同一父会话的在途创建')
  assert.match(body, /\.finally\(\(\) => \{[\s\S]*pendingSideChatCreations\.delete\(parentSessionId\)/, 'resolve 后必须删除 key')
  assert.match(body, /sessionId: parentSessionId, increaseTitle: true/, 'fork 必须 increaseTitle，且不传 atSeq（取已完成轮次前缀）')
  assert.ok(!/atSeq/.test(body), '不传 atSeq —— 边界由宿主取「最后一个已完成轮次前缀」')
})

test('源码契约：子槽正文只喂 phase 的三个合法取值 + hero 必填', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const at = source.indexOf('function SideChatConversation(props)')
  assert.notStrictEqual(at, -1, 'client.js 里找不到 SideChatConversation')
  const body = source.slice(at, source.indexOf('function SideChatTab(props)', at))
  assert.match(body, /variant: 'embedded'/, '必须复用官方 embedded 变体（零自研聊天 UI）')
  assert.match(body, /phase: settling \? 'settling' : \(hero \? 'hero' : 'active'\)/, 'phase 只允许 settling / hero / active 三值')
  assert.match(body, /hero \}/, 'hero 是必填项（官方输入 props 要求）')
  assert.ok(!/'engaging'.*phase|phase: 'engaging'/.test(body), 'engaging 不是合法 phase')
})

test('源码契约：tab 类型注册声明了自名子槽，子槽正文走 slots.inject 挂载', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  assert.match(source, /children: \{ \[SIDECHAT_CHILD_SLOT\]: \{ kind: 'single', scope: 'session' \} \}/,
    'children 必须是「声明 + 授权」，且 scope 为 session（框架据此下发 SessionProvider）')
  assert.match(source, /ctx\.slots\.inject\(SIDECHAT_CHILD_SLOT, \(\) => ctx\.slots\.register\(/,
    '父注册与子注册分属两个 effect，子槽必须用 slots.inject 等声明')
  assert.match(source, /kind: 'sidechat'/, '侧线 tab 的 kind 必须是 sidechat')
  assert.match(source, /id: '@miasaki\/dsh-sidebar\/sidechat'/, '注册 key 用类型 id（不是 kind）')
})

test('源码契约：侧线头写明「继续」的真实语义（S8 实测的越界路径）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  assert.match(source, /说「继续」等于接着做主线未完成的活/,
    '决策②：S8 实测「一句继续就让侧线接着做父任务」，提示必须写具体行为')
})

test('源码契约：空白父会话的 fork 失败要翻译成人话', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const at = source.indexOf('const sideChatForkErrorText = ')
  assert.notStrictEqual(at, -1, 'client.js 里找不到 sideChatForkErrorText')
  const body = source.slice(at, source.indexOf('function SideChatFixedChatView', at))
  assert.match(body, /no completed turn/i, '必须识别宿主的 fork-unavailable 文案')
  assert.match(body, /先让主会话跑完一轮/, '必须给可执行的引导，而不是甩宿主错误串')
})
