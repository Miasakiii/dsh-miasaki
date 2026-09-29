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
     return { sideChatRegistry, sideChatLinesFor, sideChatActiveFor, sideChatAddLine, sideChatSetActive, sideChatDropLine, SIDECHAT_REGISTRY_KEY, lastTurnsForkSeq, SIDECHAT_TURNS }`)
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
  assert.match(body, /increaseTitle: true/, 'fork 必须 increaseTitle')
  // 2026-09-29 改：此前断言「不传 atSeq」（= 全文继承）。用户反馈「把主会话又复制一遍」
  // 之后改为**截断到最近 N 轮**：传 `atSeq` 且切点由 `sideChatForkSeq()` 显式解析，
  // 拿不到就退回全文（mode: 'full'）并由 UI 标注，不再默认走全文。
  assert.match(body, /atSeq: forkPlan\.atSeq/, '必须把解析出的切点传给 fork')
  assert.match(body, /sideChatForkSeq\(parentSessionId\)/, '切点必须经 sideChatForkSeq 解析（含降级）')
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

/* ---------------- 截断 fork：切点解析（2026-09-29 新增） ---------------- */

/** 造一条 `turn/start` 事件条目（形状对齐 SessionEventLikeEntry）。 */
const turnStart = seq => ({ type: 'event', event: { type: 'turn/start', seq } })
/** 造一条非轮次事件（用户消息），用来验证「只认 turn/start」。 */
const userMsg = seq => ({ type: 'event', event: { type: 'user/message', seq } })
/** 造一条 transient（live chunk）——不是轮次，必须跳过。 */
const transient = () => ({ type: 'transient', event: { type: 'assistant/live-chunk', seq: 999 } })

test('切点解析：取「最后 N 轮」的第一轮起点（atSeq 是 inclusive 前缀边界）', () => {
  const { lastTurnsForkSeq, SIDECHAT_TURNS } = loadSideChatRegistry(makeStorage())
  assert.strictEqual(SIDECHAT_TURNS, 3, '默认继承轮数就是 3（改它要同时改这里的期望）')
  // 5 轮：seq 10/20/30/40/50 ⇒ 最后 3 轮的第一轮是 seq=30
  const entries = [turnStart(10), userMsg(11), turnStart(20), userMsg(21),
    turnStart(30), userMsg(31), turnStart(40), userMsg(41), turnStart(50), userMsg(51)]
  assert.strictEqual(lastTurnsForkSeq(entries, 3), 30)
  assert.strictEqual(lastTurnsForkSeq(entries, 1), 50, 'N=1 就是最后一轮')
  assert.strictEqual(lastTurnsForkSeq(entries, 5), 10, 'N=轮数 ⇒ 退化成全文（宿主语义）')
})

test('切点解析：不足 N 轮返回 undefined（不猜切点，让调用方退回全文）', () => {
  const { lastTurnsForkSeq } = loadSideChatRegistry(makeStorage())
  assert.strictEqual(lastTurnsForkSeq([turnStart(10), userMsg(11), turnStart(20)], 3), undefined,
    '只有 2 轮时不许猜——猜错会让侧线莫名丢上下文，比多带历史更糟')
  assert.strictEqual(lastTurnsForkSeq([], 3), undefined, '空窗口')
})

test('切点解析：跳过 transient 与一切非 turn/start 事件', () => {
  const { lastTurnsForkSeq } = loadSideChatRegistry(makeStorage())
  const entries = [turnStart(10), transient(), userMsg(11), turnStart(20), transient(),
    turnStart(30), transient(), turnStart(40)]
  assert.strictEqual(lastTurnsForkSeq(entries, 2), 30,
    'transient（live chunk）不是轮次；user/message 也不是轮次边界')
})

test('切点解析：结构不认识时返回 undefined（含 seq 非数字）', () => {
  const { lastTurnsForkSeq } = loadSideChatRegistry(makeStorage())
  assert.strictEqual(lastTurnsForkSeq(undefined, 3), undefined, '非数组')
  assert.strictEqual(lastTurnsForkSeq(null, 3), undefined, 'null')
  assert.strictEqual(lastTurnsForkSeq([turnStart(10), turnStart(20), turnStart(30)], 0), undefined, 'turns<=0')
  assert.strictEqual(lastTurnsForkSeq([turnStart('x'), turnStart('y'), turnStart('z')], 1), undefined,
    'seq 不是数字 ⇒ 不返回一个假的切点')
})

test('登记表：forkMode 随行落盘，缺省时不写该字段（旧记录形状保持）', () => {
  const { sideChatRegistry, sideChatAddLine, sideChatLinesFor } = loadSideChatRegistry(makeStorage())
  sideChatRegistry.update(reg => sideChatAddLine(reg, PARENT, CHILD_A, 1000, 'turns'))
  assert.strictEqual(sideChatLinesFor(sideChatRegistry.get(), PARENT)[0].forkMode, 'turns')
  // 不传 forkMode（旧调用形态）⇒ 不凭空写字段
  sideChatRegistry.update(reg => sideChatAddLine(reg, PARENT, CHILD_B, 2000))
  const lineB = sideChatLinesFor(sideChatRegistry.get(), PARENT).find(l => l.childSessionId === CHILD_B)
  assert.ok(!('forkMode' in lineB), '未提供切点模式时不得写该字段')
})
