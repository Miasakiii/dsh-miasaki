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
     return { sideChatRegistry, sideChatLinesFor, sideChatActiveFor, sideChatAddLine, sideChatSetActive, sideChatDropLine, SIDECHAT_REGISTRY_KEY, SIDECHAT_HIDDEN_KEY, sideChatHiddenIds, publishSideChatHidden, sideChatInheritedTurns, sideChatInheritedCss, clearInheritedGoal }`)
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

// ---------------------------------------------------------------------------
// 决策⑥ / S9 的最小补偿（2026-09-30）：侧线创建后清掉继承来的 goal
//
// fork 是**零类型过滤**的日志前缀拷贝 ⇒ child 继承父会话的 goal / plan / todo。
// goal 有官方补偿 API（`ctx.remote.goals.get` → `goals.clear`，代价是 child 日志留一条
// `goal/change{operation:'clear'}` tombstone）；plan / todo **没有**客户端 API。
// 本组钉住四件事：补偿真的调、参数对、失败不外抛、服务缺席不打扰。
// ---------------------------------------------------------------------------

/** 造一个假 `ctx.remote.goals`，记录调用。 */
function fakeGoals({ goal, failGet = false, failClear = false } = {}) {
  const calls = { get: [], clear: [] }
  return {
    calls,
    remote: {
      goals: {
        get: (sessionId) => {
          calls.get.push(sessionId)
          if (failGet) return Promise.reject(new Error('boom-get'))
          return Promise.resolve(goal)
        },
        clear: (sessionId, patch) => {
          calls.clear.push([sessionId, patch])
          if (failClear) return Promise.reject(new Error('boom-clear'))
          return Promise.resolve()
        },
      },
    },
  }
}

/** 抽一个 microtask tick：补偿是异步的，断言前要让它的 Promise 链跑完。 */
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

/** 在断言期间收集 console.warn（补偿失败必须留痕，但不外抛）。 */
async function withWarnings(fn) {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    await fn()
  } finally {
    console.warn = original
  }
  return warnings
}

test('决策⑥：child 上有 goal ⇒ 调 goals.clear，且带上 id 与 revision', async () => {
  const { clearInheritedGoal } = loadSideChatRegistry(makeStorage())
  const goals = fakeGoals({ goal: { id: 'goal-42', revision: 7 } })
  clearInheritedGoal({ remote: goals.remote }, 'session-child')
  await tick()
  assert.deepEqual(goals.calls.get, ['session-child'], '必须先按 childId 取 goal')
  assert.deepEqual(goals.calls.clear, [['session-child', { id: 'goal-42', revision: 7 }]],
    'clear 必须带 id + revision（官方 UI 同款调用形态）')
})

test('决策⑥：child 上没有 goal ⇒ 不调 clear（无谓的 tombstone 也是噪声）', async () => {
  const { clearInheritedGoal } = loadSideChatRegistry(makeStorage())
  const goals = fakeGoals({ goal: null })
  clearInheritedGoal({ remote: goals.remote }, 'session-child')
  await tick()
  assert.equal(goals.calls.clear.length, 0)
  const goals2 = fakeGoals({ goal: { revision: 1 } }) // 有 revision 没有 id：不是合法 goal
  clearInheritedGoal({ remote: goals2.remote }, 'session-child')
  await tick()
  assert.equal(goals2.calls.clear.length, 0, '没有 id 的 goal 不构成可清对象')
})

test('决策⑥：补偿失败只留痕、不外抛（侧线本身才是主产物）', async () => {
  const { clearInheritedGoal } = loadSideChatRegistry(makeStorage())
  for (const bad of [{ goal: { id: 'g', revision: 1 }, failGet: true },
    { goal: { id: 'g', revision: 1 }, failClear: true }]) {
    const goals = fakeGoals(bad)
    let thrown = null
    const warnings = await withWarnings(async () => {
      try { clearInheritedGoal({ remote: goals.remote }, 'session-child') } catch (e) { thrown = e }
      await tick() // warn 发生在 Promise 链里 —— 收集必须覆盖它，否则 stub 已被还原
    })
    assert.equal(thrown, null, '补偿失败必须被自己吞掉，不能把已建好的侧线拖死')
    assert.equal(warnings.length, 1, '失败必须留痕 —— 静默吞错正是本仓明令禁止的形态')
    assert.match(warnings[0], /goal 补偿失败（不影响侧线本身）/)
  }
})

test('决策⑥：服务缺席（旧宿主没有 ctx.remote.goals）⇒ 静默返回，不报错', async () => {
  const { clearInheritedGoal } = loadSideChatRegistry(makeStorage())
  const warnings = await withWarnings(async () => {
    assert.doesNotThrow(() => clearInheritedGoal({}, 'session-child'))
    assert.doesNotThrow(() => clearInheritedGoal(undefined, 'session-child'))
    assert.doesNotThrow(() => clearInheritedGoal({ remote: {} }, 'session-child'))
    assert.doesNotThrow(() => clearInheritedGoal({ remote: { goals: {} } }, 'session-child'))
  })
  await tick()
  assert.deepEqual(warnings, [], '服务缺席是正常形态，不该产生告警噪声')
})

test('源码契约：补偿不阻塞、不污染「新建侧线」的返回链路', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const at = source.indexOf('const createSideChat = ')
  assert.notStrictEqual(at, -1, 'client.js 里找不到 createSideChat')
  const body = source.slice(at, source.indexOf('const sideChatForkErrorText = ', at))
  assert.match(body, /clearInheritedGoal\(ctx, childId\)/, 'fork 成功后必须触发补偿')
  assert.match(body, /return childId/, '补偿不得改变 fork 的 resolve 值（childId 要照原样往下传）')
  assert.doesNotMatch(body, /await clearInheritedGoal/, '补偿绝不能 await —— 侧线创建不等它')
  // 调用的必须是同一个模块级函数（防止在闭包里另写一份实现 ⇒ 口径漂移）
  assert.match(source, /^ {4}function clearInheritedGoal\(ctx, childSessionId\)/m,
    'clearInheritedGoal 必须是模块级函数（否则单测覆盖不到）')
})

test('源码契约：已知限制如实写明 —— plan / todo 无客户端 API', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  assert.match(source, /plan \/ todo \*\*没有\*\*客户端 API|plan \/ todo 没有客户端 API/,
    '做不到的事要写清楚，而不是让用户以为「继承」是被设计成这样')
})

// --- 侧线「不占官方会话列表」声明（2026-09-30）--------------------------------
// 官方把列表投影留在壳里（`dsh-client-ui-workspace` 的 `sessionVisible()`），插件没有
// 「不进列表」的接口 ⇒ 约定一份 localStorage 声明：插件写 child id，壳侧补丁读它。
// 这里钉住的是**插件到底声明了什么** —— 声明写错的症状是「侧线又出现在列表里」，
// 不是崩溃，所以只靠肉眼验收抓不住。

test('隐藏声明：登记表 → 去重排序的 child id 数组', () => {
  const { sideChatHiddenIds, sideChatAddLine, sideChatSetActive, sideChatDropLine } = loadSideChatRegistry(makeStorage())
  assert.deepStrictEqual(sideChatHiddenIds({}), [], '空表声明空数组')
  let registry = sideChatAddLine({}, PARENT, CHILD_B, 2)
  registry = sideChatAddLine(registry, PARENT, CHILD_A, 1)
  registry = sideChatAddLine(registry, 'session-other-parent', CHILD_B, 3) // 跨父会话 + 重复 id
  assert.deepStrictEqual(sideChatHiddenIds(registry), [CHILD_A, CHILD_B].sort(), '跨父会话取并集、去重、排序稳定')
  registry = sideChatSetActive(registry, PARENT, CHILD_A)
  assert.deepStrictEqual(sideChatHiddenIds(registry), [CHILD_A, CHILD_B].sort(), '切 active 不改变声明')
  registry = sideChatDropLine(registry, PARENT, CHILD_A)
  assert.deepStrictEqual(sideChatHiddenIds(registry), [CHILD_B], '删掉的侧线不再被声明')
})

test('隐藏声明：残缺登记形态被容忍 —— 一条坏数据不得丢整份声明', () => {
  const { sideChatHiddenIds } = loadSideChatRegistry(makeStorage())
  assert.deepStrictEqual(sideChatHiddenIds({
    brokenNull: null,
    brokenLines: { lines: 'not-an-array' },
    mixed: { lines: [null, {}, { childSessionId: '' }, { childSessionId: 42 }, { childSessionId: 'session-keep' }] },
  }), ['session-keep'])
})

test('隐藏声明：登记表每次变更后全量重写（不是增量）', () => {
  const storage = makeStorage()
  const { sideChatRegistry, sideChatAddLine, sideChatDropLine, SIDECHAT_HIDDEN_KEY } = loadSideChatRegistry(storage)
  assert.deepStrictEqual(JSON.parse(storage.getItem(SIDECHAT_HIDDEN_KEY)), [], '加载即发布一次（空表 → 空数组）')
  sideChatRegistry.update(reg => sideChatAddLine(reg, PARENT, CHILD_A, 1))
  assert.deepStrictEqual(JSON.parse(storage.getItem(SIDECHAT_HIDDEN_KEY)), [CHILD_A], '新建侧线后声明跟上')
  sideChatRegistry.update(reg => sideChatAddLine(reg, PARENT, CHILD_B, 2))
  assert.deepStrictEqual(JSON.parse(storage.getItem(SIDECHAT_HIDDEN_KEY)), [CHILD_A, CHILD_B].sort())
  sideChatRegistry.update(reg => sideChatDropLine(reg, PARENT, CHILD_A))
  assert.deepStrictEqual(JSON.parse(storage.getItem(SIDECHAT_HIDDEN_KEY)), [CHILD_B],
    '全量重写：删掉的侧线不残留在声明里（否则它会在列表里永久隐身）')
})

test('隐藏声明：已有侧线在插件加载时被一次性收编（含本次改动之前建的）', () => {
  const storage = makeStorage({
    'miasaki-sidebar:sidechat:v1': JSON.stringify({
      [PARENT]: { activeChildId: CHILD_A, lines: [{ childSessionId: CHILD_A, createdAt: 1 }] },
    }),
  })
  const { SIDECHAT_HIDDEN_KEY } = loadSideChatRegistry(storage)
  assert.deepStrictEqual(JSON.parse(storage.getItem(SIDECHAT_HIDDEN_KEY)), [CHILD_A],
    '老侧线必须在首屏就被收编 —— 否则刷新后它会先闪进列表再消失')
})

test('隐藏声明：写盘失败只留痕（后果是回到「侧线可见」的旧行为，不是数据损坏）', async () => {
  const warnings = await withWarnings(async () => {
    loadSideChatRegistry(makeStorage({}, { failWrite: true }))
  })
  assert.equal(warnings.length, 1, '写失败必须留痕 —— 静默吞错正是本仓明令禁止的形态')
  assert.match(warnings[0], /侧线列表隐藏声明写入失败/)
})

test('源码契约：声明与登记表同源，且壳侧契约（键名/形态）写在源码里', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  assert.match(source, /const SIDECHAT_HIDDEN_KEY = 'miasaki-sidebar:sidechat:hidden:v1'/,
    '键名是跨包契约，必须与 desktop 线补丁逐字一致')
  assert.match(source, /publishSideChatHidden\(next\)/, '登记表变更必须触发声明重写')
  assert.match(source, /^ {4}publishSideChatHidden\(sideChatRegistry\.value\)$/m,
    '插件加载时必须发布一次（首屏正确性靠它）')
  assert.doesNotMatch(source, /sideChatHiddenIds[\s\S]{0,400}?console\.log/,
    '声明是机器读的，不该往控制台刷日志')
})

// --- 侧线「继承段不显示」的判据（2026-09-30）-----------------------------------
// 官方没有消息级过滤位，界面折叠只能在显示层做；而「从第几轮开始是继承段」必须算准，
// 否则要么折掉用户自己的问题，要么一条都没折掉（后者是静默失效，肉眼极难发现）。

/** 造一个最小事件窗口源（形态对齐 SessionEventSource 契约）。 */
function makeEventSource(entries, hasMore = false) {
  return {
    getSnapshot: () => ({ entries, hasMore, revision: 1, change: { kind: 'replace', entries } }),
  }
}
const durable = (type, data) => ({ type: 'event', event: { type, seq: 0, time: 0, data } })
const turnStart = turn => durable('turn/start', { turn })
const turnEnd = turn => durable('turn/end', { turn, reason: { kind: 'completed' } })
const seedMarker = () => durable('session/end-seed', { inherited: true })

test('继承段判据①：窗口里看得到 fork 标记 ⇒ 标记之前的最大轮号', () => {
  const { sideChatInheritedTurns } = loadSideChatRegistry(makeStorage())
  const source = makeEventSource([
    turnStart(1), turnEnd(1),
    turnStart(2), turnEnd(2),
    seedMarker(),
    turnStart(3), turnEnd(3),
  ])
  assert.equal(sideChatInheritedTurns(source), 2, '继承了两轮；标记之后的第 3 轮是侧线自己的')
})

test('继承段判据②：窗口看不到标记（只加载了尾部）⇒ 首轮号减一', () => {
  const { sideChatInheritedTurns } = loadSideChatRegistry(makeStorage())
  assert.equal(sideChatInheritedTurns(makeEventSource([turnStart(5), turnEnd(5)], true)), 4,
    '分页只到第 5 轮 ⇒ 前面 1..4 轮属于继承段')
})

test('非 fork 会话 / 空窗口一律 0（宁可不折叠，也绝不折掉用户自己的轮次）', () => {
  const { sideChatInheritedTurns } = loadSideChatRegistry(makeStorage())
  assert.equal(sideChatInheritedTurns(makeEventSource([turnStart(1), turnEnd(1)])), 0, '从第 1 轮开始的窗口没有继承段')
  assert.equal(sideChatInheritedTurns(makeEventSource([])), 0)
  assert.equal(sideChatInheritedTurns(makeEventSource([seedMarker(), turnStart(1)])), 0, '标记在最前面 ⇒ 没有可折叠的前缀')
})

test('继承段判据：残缺事件形态被容忍，不抛也不乱折', () => {
  const { sideChatInheritedTurns } = loadSideChatRegistry(makeStorage())
  assert.equal(sideChatInheritedTurns(null), 0)
  assert.equal(sideChatInheritedTurns({}), 0)
  assert.equal(sideChatInheritedTurns({ getSnapshot: () => ({}) }), 0)
  assert.equal(sideChatInheritedTurns({ getSnapshot: () => ({ entries: 'nope' }) }), 0)
  assert.equal(sideChatInheritedTurns(makeEventSource([
    null,
    { type: 'transient', event: { type: 'assistant/live-chunk', data: { turn: 9 } } }, // 流式增量不参与判定
    { type: 'event' },
    durable('turn/start', {}), // 缺 turn 字段
    durable('goal/change', { turn: 99 }), // 非轮次事件不参与
    turnStart(7),
  ])), 6, '只认持久事件的数字 turn')
})

test('折叠 CSS：逐轮枚举、限定侧线容器、轮数异常时放弃折叠', () => {
  const { sideChatInheritedCss } = loadSideChatRegistry(makeStorage())
  assert.equal(sideChatInheritedCss(0), '', '没有继承段就不产生样式')
  assert.equal(sideChatInheritedCss(2),
    '.dsh-sidebar-sidechat-body [data-chat-turn="1"],.dsh-sidebar-sidechat-body [data-chat-turn="2"]{display:none}')
  assert.equal(sideChatInheritedCss(201), '', '超过上限宁可完全不折叠，也不生成上千条选择器')
  assert.equal(sideChatInheritedCss(-1), '')
  assert.equal(sideChatInheritedCss(1.5), '')
  assert.doesNotMatch(sideChatInheritedCss(1), /:not\(/, '选择器要简单到不会牵连同容器内的其他行')
})

test('源码契约：折叠作用域只限侧线面板，且头注写明「模型仍看得见」', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  assert.match(source, /className: 'dsh-sidebar-sidechat-body'/, '侧线正文容器必须仍在（CSS 作用域锚点）')
  assert.match(source, /useSideChatInheritedTurns\(reference\)/, 'SideChatTab 必须按 reference 算继承段轮数')
  assert.match(source, /上文已折叠 \$\{inheritedTurns\} 轮，模型仍然看得见/,
    '用户看不到继承段，但必须被告知模型仍然带着它')
  // 只查侧线自己的两段源码：本文件别处（终端 popover 等）本来就在用 DOM 观察，
  // 断言整个文件会把别人的实现算到侧线头上。
  const sideChatSection = source.slice(
    source.indexOf('const SIDECHAT_HIDDEN_KEY'),
    source.indexOf('// Module-level store for the content layer.'))
  const tabSection = source.slice(
    source.indexOf('function SideChatTab'),
    source.indexOf('// --- 官方右栏 tab 类型注册'))
  assert.notEqual(sideChatSection, '', '切片锚点失效（client.js 结构变了）')
  assert.notEqual(tabSection, '', '切片锚点失效（SideChatTab 不见了）')
  assert.doesNotMatch(sideChatSection + tabSection, /document\.querySelector|MutationObserver/,
    '折叠走容器内 CSS，不做 DOM 扫描（否则会动到主会话与官方 subagent 会话）')
  assert.doesNotMatch(sideChatSection, /!important/,
    '不用 !important 硬压官方样式 —— 要能随官方样式演进而失效，而不是打赢它')
})



