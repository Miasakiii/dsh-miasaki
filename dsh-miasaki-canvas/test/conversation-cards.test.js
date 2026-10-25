import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function loadConversationCards({ sideChatIds } = {}) {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const start = source.indexOf('function overlapsCard')
  const end = source.indexOf('function canvasConnectors')
  // 耗时拆分纯函数（2026-10-20）：processDurationMs / formatDurationMs /
  // turnTimingSplit 在文件后段（processSummary 区），单独切片求值 —— 三者均为
  // 无外部依赖的纯函数（不碰 escapeHtml / renderMarkdown）。
  const timingStart = source.indexOf('function processSummary')
  const timingEnd = source.indexOf('function renderCardInspector')
  assert.notStrictEqual(timingStart, -1, 'app.js 里找不到 processSummary')
  assert.notStrictEqual(timingEnd, -1, 'app.js 里找不到 renderCardInspector 锚点')
  // 侧线标注（2026-09-30）：`conversationCards` 会给卡片打 `sideChat` 标，判据函数在文件更上面
  // —— 切片必须把那段一起求值，否则整段调用栈 ReferenceError（本文件因此改过一次切片范围）。
  const sideChatStart = source.indexOf('// --- 辅助对话（侧线）标注')
  const sideChatEnd = source.indexOf('// Sidebar thread list:')
  assert.notStrictEqual(sideChatStart, -1, 'app.js 里找不到辅助对话标注段')
  assert.notStrictEqual(sideChatEnd, -1, 'app.js 里找不到侧栏线程列表锚点')
  const stored = sideChatIds === undefined ? null : JSON.stringify(sideChatIds)
  const context = {
    globalThis: {},
    CARD_WIDTH: 310,
    CARD_HEIGHT: 276,
    CARD_GAP_Y: 42,
    CAMERA_INSET_X: 56,
    CAMERA_INSET_Y: 56,
    localStorage: { getItem: () => stored },
    console: { warn: () => {} },
    messagesFor: thread => thread.messages,
    state: { branchAnchors: new Map(), cardPositions: new Map(), liveReplies: new Map(), collapsedCardIds: new Set() },
  }
  vm.createContext(context)
  vm.runInContext(`${source.slice(sideChatStart, sideChatEnd)}\n${source.slice(start, end)}\n${source.slice(timingStart, timingEnd)};globalThis.conversationCards = conversationCards;globalThis.conversationGraphView = conversationGraphView;globalThis.initialCanvasCamera = initialCanvasCamera;globalThis.processDurationMs = processDurationMs;globalThis.formatDurationMs = formatDurationMs;globalThis.turnTimingSplit = turnTimingSplit`, context)
  return { conversationCards: context.globalThis.conversationCards, conversationGraphView: context.globalThis.conversationGraphView, initialCanvasCamera: context.globalThis.initialCanvasCamera, processDurationMs: context.globalThis.processDurationMs, formatDurationMs: context.globalThis.formatDurationMs, turnTimingSplit: context.globalThis.turnTimingSplit, state: context.state }
}

test('projects each user question in one DSH session as a connected canvas card', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([{
    id: 'session-1', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '第一个问题', sourceSeq: 1 },
      { kind: 'assistant', text: '第一个回答草稿', sourceSeq: 2 },
      { kind: 'assistant', text: '第一个最终回答', sourceSeq: 3 },
      { kind: 'user', text: '第二个问题', sourceSeq: 4 },
      { kind: 'assistant', text: '第二个最终回答', sourceSeq: 5 },
    ],
  }])

  assert.equal(cards.length, 2)
  assert.equal(cards[0].question, '第一个问题')
  assert.equal(cards[0].answer.text, '第一个最终回答')
  assert.equal(cards[1].question, '第二个问题')
  assert.equal(cards[1].parentId, cards[0].id)
  assert.equal(cards[1].position.x, cards[0].position.x + 365)
  assert.equal(cards[0].canContinue, undefined)
  assert.equal(cards[1].canContinue, true)
})

test('keeps a failed turn visible when Harness produces no assistant message', async () => {
  const { conversationCards } = await loadConversationCards()
  const [card] = conversationCards([{
    id: 'session-error', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '调用搜索', sourceSeq: 1 },
      { kind: 'error', text: 'QuotaExceeded: INSUFFICIENT_BALANCE: 余额不足', sourceSeq: 2 },
    ],
  }])

  assert.equal(card.answer, null)
  assert.equal(card.error.text, 'QuotaExceeded: INSUFFICIENT_BALANCE: 余额不足')
  assert.equal(card.canContinue, true)
})

test('connects a restored fork to its DSH seed boundary, not its canvas position', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    {
      id: 'parent', parentId: null, position: { x: 86, y: 82 },
      messages: [
        { kind: 'user', text: '第一轮', sourceSeq: 1 },
        { kind: 'assistant', text: '第一轮回答', sourceSeq: 2 },
        { kind: 'user', text: '第二轮', sourceSeq: 5 },
        { kind: 'assistant', text: '第二轮回答', sourceSeq: 6 },
        { kind: 'user', text: '第三轮', sourceSeq: 9 },
        { kind: 'assistant', text: '第三轮回答', sourceSeq: 10 },
      ],
    },
    {
      id: 'child', parentId: 'parent', sourceSeedLength: 8, position: { x: 9999, y: -9999 },
      messages: [
        { kind: 'user', text: '分支问题', sourceSeq: 9 },
        { kind: 'assistant', text: '分支回答', sourceSeq: 10 },
      ],
    },
  ])

  const parentTurns = cards.filter(card => card.dshThreadId === 'parent')
  const childTurn = cards.find(card => card.dshThreadId === 'child')
  assert.equal(childTurn.parentId, parentTurns[1].id)
})

test('uses a restored child message sequence to reconnect a legacy fork at its user turn', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    {
      id: 'parent', parentId: null, position: { x: 86, y: 82 },
      messages: [
        { kind: 'user', text: '你好', sourceSeq: 7 },
        { kind: 'assistant', text: '你好，我是助手。', sourceSeq: 111 },
        { kind: 'user', text: '你是谁', sourceSeq: 118 },
        { kind: 'assistant', text: '我是 DSH。', sourceSeq: 278 },
      ],
    },
    {
      id: 'child', parentId: 'parent', sourceSeedLength: null, position: { x: 1200, y: 900 },
      messages: [
        { kind: 'user', text: '代码是什么', sourceSeq: 121 },
        { kind: 'assistant', text: '代码是指令。', sourceSeq: 569 },
      ],
    },
  ])

  const parentTurns = cards.filter(card => card.dshThreadId === 'parent')
  const childTurn = cards.find(card => card.dshThreadId === 'child')
  assert.equal(childTurn.parentId, parentTurns[1].id)
})

test('places a fork beside the exact parent turn while avoiding overlap', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    {
      id: 'parent', parentId: null, position: { x: 86, y: 82 },
      messages: [
        { kind: 'user', text: '第一轮', sourceSeq: 1 },
        { kind: 'assistant', text: '第一轮回答', sourceSeq: 2 },
        { kind: 'user', text: '第二轮', sourceSeq: 5 },
        { kind: 'assistant', text: '第二轮回答', sourceSeq: 6 },
        { kind: 'user', text: '第三轮', sourceSeq: 9 },
        { kind: 'assistant', text: '第三轮回答', sourceSeq: 10 },
      ],
    },
    {
      id: 'child', parentId: 'parent', sourceSeedLength: 8, position: { x: 86, y: 900 },
      messages: [
        { kind: 'user', text: '第二轮分支', sourceSeq: 9 },
        { kind: 'assistant', text: '分支回答', sourceSeq: 10 },
      ],
    },
  ])

  const parentTurns = cards.filter(card => card.dshThreadId === 'parent')
  const childTurn = cards.find(card => card.dshThreadId === 'child')
  assert.equal(childTurn.parentId, parentTurns[1].id)
  assert.equal(childTurn.position.x, parentTurns[1].position.x + 365)
  assert.ok(childTurn.position.y > parentTurns[1].position.y)
})

test('keeps every turn of one branch on the same horizontal lane', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    {
      id: 'parent', parentId: null, position: { x: 86, y: 82 },
      messages: [
        { kind: 'user', text: '第一轮', sourceSeq: 1 },
        { kind: 'assistant', text: '第一轮回答', sourceSeq: 2 },
        { kind: 'user', text: '第二轮', sourceSeq: 5 },
        { kind: 'assistant', text: '第二轮回答', sourceSeq: 6 },
      ],
    },
    {
      id: 'child', parentId: 'parent', sourceSeedLength: 7, position: { x: 999, y: 999 },
      messages: [
        { kind: 'user', text: '分支第一轮', sourceSeq: 7 },
        { kind: 'assistant', text: '分支第一轮回答', sourceSeq: 8 },
        { kind: 'user', text: '分支第二轮', sourceSeq: 9 },
        { kind: 'assistant', text: '分支第二轮回答', sourceSeq: 10 },
        { kind: 'user', text: '分支第三轮', sourceSeq: 11 },
        { kind: 'assistant', text: '分支第三轮回答', sourceSeq: 12 },
      ],
    },
  ])

  const childTurns = cards.filter(card => card.dshThreadId === 'child')
  assert.equal(new Set(childTurns.map(card => card.position.y)).size, 1)
  assert.equal(childTurns[1].position.x, childTurns[0].position.x + 365)
  assert.equal(childTurns[2].position.x, childTurns[1].position.x + 365)
})

test('moves automatically placed cards below an occupied card instead of overlapping it', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    { id: 'first', parentId: null, position: { x: 86, y: 82 }, messages: [{ kind: 'user', text: '第一条', sourceSeq: 1 }] },
    { id: 'second', parentId: null, position: { x: 86, y: 220 }, messages: [{ kind: 'user', text: '第二条', sourceSeq: 1 }] },
  ])

  assert.equal(cards[0].position.y, 82)
  assert.ok(cards[1].position.y >= 400)
})

test('honors an in-memory dragged card position even far from the natural layout', async () => {
  const { conversationCards, state } = await loadConversationCards()
  state.cardPositions.set('session-1:turn:1', { x: 1280, y: 1280 })
  const cards = conversationCards([{
    id: 'session-1', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '第一个问题', sourceSeq: 1 },
      { kind: 'assistant', text: '第一个回答', sourceSeq: 2 },
    ],
  }])

  assert.equal(cards[0].position.x, 1280)
  assert.equal(cards[0].position.y, 1280)
})

test('does not move later turns when an earlier card is dragged', async () => {
  const { conversationCards, state } = await loadConversationCards()
  state.cardPositions.set('session-1:turn:1', { x: 1280, y: 1280 })
  const cards = conversationCards([{
    id: 'session-1', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '第一个问题', sourceSeq: 1 },
      { kind: 'assistant', text: '第一个回答', sourceSeq: 2 },
      { kind: 'user', text: '第二个问题', sourceSeq: 3 },
      { kind: 'assistant', text: '第二个回答', sourceSeq: 4 },
    ],
  }])

  assert.equal(cards[0].position.x, 1280)
  assert.equal(cards[1].position.x, 451)
  assert.equal(cards[1].position.y, 82)
})

test('keeps a dragged pending turn position after DSH assigns a source sequence', async () => {
  const { conversationCards, state } = await loadConversationCards()
  state.cardPositions.set('session-1:turn-index:0', { x: 740, y: 360 })
  const cards = conversationCards([{
    id: 'session-1', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '第一个问题', sourceSeq: 21 },
      { kind: 'assistant', text: '第一个回答', sourceSeq: 22 },
    ],
  }])

  assert.equal(cards[0].position.x, 740)
  assert.equal(cards[0].position.y, 360)
})

test('derives root card positions from the visible graph instead of stale persisted thread pixels', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([
    { id: 'dirty-root', parentId: null, position: { x: 86, y: 3200 }, messages: [{ kind: 'user', text: '脏坐标会话', sourceSeq: 1 }] },
  ])

  assert.equal(cards[0].position.x, 86)
  assert.equal(cards[0].position.y, 82)
})

test('focuses a new-session draft before existing cards when initializing the canvas', async () => {
  const { initialCanvasCamera, state } = await loadConversationCards()
  state.draft = { kind: 'new', text: '', sending: false }
  state.zoom = 1
  const camera = initialCanvasCamera([{ id: 'old-card', position: { x: 86, y: 1600 } }])

  assert.equal(camera.x, -30)
  assert.equal(camera.y, -26)
})

test('collapsing a conversation card hides its complete linear descendant chain', async () => {
  const { conversationCards, conversationGraphView } = await loadConversationCards()
  const cards = conversationCards([{
    id: 'session-1', parentId: null,
    messages: [
      { kind: 'user', text: '第一轮', sourceSeq: 1 },
      { kind: 'assistant', text: '回答一', sourceSeq: 2 },
      { kind: 'user', text: '第二轮', sourceSeq: 3 },
      { kind: 'assistant', text: '回答二', sourceSeq: 4 },
      { kind: 'user', text: '第三轮', sourceSeq: 5 },
      { kind: 'assistant', text: '回答三', sourceSeq: 6 },
    ],
  }])

  const graph = conversationGraphView(cards, new Set([cards[0].id]))
  assert.deepEqual(Array.from(graph.cards, card => card.id), [cards[0].id])
  assert.equal(graph.childCounts.get(cards[0].id), 1)
  assert.equal(graph.descendantCounts.get(cards[0].id), 2)
})

test('collapsing a fork point hides all branch descendants without hiding another root', async () => {
  const { conversationCards, conversationGraphView } = await loadConversationCards()
  const cards = conversationCards([
    {
      id: 'parent', parentId: null,
      messages: [
        { kind: 'user', text: '父问题', sourceSeq: 1 },
        { kind: 'assistant', text: '父回答', sourceSeq: 2 },
        { kind: 'user', text: '父追问', sourceSeq: 5 },
        { kind: 'assistant', text: '父追问回答', sourceSeq: 6 },
      ],
    },
    {
      id: 'child', parentId: 'parent', sourceSeedLength: 4,
      messages: [
        { kind: 'user', text: '分支问题', sourceSeq: 4 },
        { kind: 'assistant', text: '分支回答', sourceSeq: 5 },
        { kind: 'user', text: '分支追问', sourceSeq: 6 },
      ],
    },
    { id: 'other-root', parentId: null, messages: [{ kind: 'user', text: '独立会话', sourceSeq: 1 }] },
  ])
  const forkPoint = cards.find(card => card.dshThreadId === 'parent' && card.turnIndex === 0)
  const graph = conversationGraphView(cards, new Set([forkPoint.id]))

  assert.deepEqual(Array.from(graph.cards, card => card.question).sort(), ['父问题', '独立会话'].sort())
  assert.equal(graph.childCounts.get(forkPoint.id), 2)
  assert.equal(graph.descendantCounts.get(forkPoint.id), 3)
})

test('expanding a card restores descendants at their original coordinates', async () => {
  const { conversationCards, conversationGraphView } = await loadConversationCards()
  const cards = conversationCards([{
    id: 'session-1', parentId: null,
    messages: [
      { kind: 'user', text: '第一轮', sourceSeq: 1 },
      { kind: 'assistant', text: '回答一', sourceSeq: 2 },
      { kind: 'user', text: '第二轮', sourceSeq: 3 },
    ],
  }])
  const originalPositions = cards.map(card => ({ ...card.position }))

  assert.equal(conversationGraphView(cards, new Set([cards[0].id])).cards.length, 1)
  const expanded = conversationGraphView(cards, new Set()).cards
  assert.equal(expanded.length, 2)
  assert.deepEqual(expanded.map(card => ({ ...card.position })), originalPositions)
})

test('a new descendant remains hidden while its ancestor is collapsed', async () => {
  const { conversationCards, conversationGraphView } = await loadConversationCards()
  const initialCards = conversationCards([{
    id: 'session-1', parentId: null,
    messages: [
      { kind: 'user', text: '第一轮', sourceSeq: 1 },
      { kind: 'assistant', text: '回答一', sourceSeq: 2 },
      { kind: 'user', text: '第二轮', sourceSeq: 3 },
    ],
  }])
  const collapsedId = initialCards[0].id
  const updatedCards = conversationCards([{
    id: 'session-1', parentId: null,
    messages: [
      { kind: 'user', text: '第一轮', sourceSeq: 1 },
      { kind: 'assistant', text: '回答一', sourceSeq: 2 },
      { kind: 'user', text: '第二轮', sourceSeq: 3 },
      { kind: 'assistant', text: '回答二', sourceSeq: 4 },
      { kind: 'user', text: '后来新增的第三轮', sourceSeq: 5 },
    ],
  }])

  const graph = conversationGraphView(updatedCards, new Set([collapsedId]))
  assert.deepEqual(Array.from(graph.cards, card => card.question), ['第一轮'])
  assert.equal(graph.descendantCounts.get(collapsedId), 2)
})

test('nested collapsed nodes remain visible when their ancestor is expanded', async () => {
  const { conversationCards, conversationGraphView } = await loadConversationCards()
  const cards = conversationCards([{
    id: 'session-1', parentId: null,
    messages: [
      { kind: 'user', text: '第一轮', sourceSeq: 1 },
      { kind: 'assistant', text: '回答一', sourceSeq: 2 },
      { kind: 'user', text: '第二轮', sourceSeq: 3 },
      { kind: 'assistant', text: '回答二', sourceSeq: 4 },
      { kind: 'user', text: '第三轮', sourceSeq: 5 },
    ],
  }])

  const nested = conversationGraphView(cards, new Set([cards[0].id, cards[1].id]))
  assert.deepEqual(Array.from(nested.cards, card => card.question), ['第一轮', '第二轮'])
  const childOnly = conversationGraphView(cards, new Set([cards[1].id]))
  assert.deepEqual(Array.from(childOnly.cards, card => card.question), ['第一轮', '第二轮'])
})

test('cyclic collapsed roots stay visible and count unique descendants', async () => {
  const { conversationGraphView } = await loadConversationCards()
  const cards = [
    { id: 'a', parentId: 'b', dshThreadId: 'a' },
    { id: 'b', parentId: 'a', dshThreadId: 'b' },
  ]
  const graph = conversationGraphView(cards, new Set(['a', 'b']))

  assert.deepEqual(Array.from(graph.cards, card => card.id), ['a', 'b'])
  assert.equal(graph.descendantCounts.get('a'), 1)
  assert.equal(graph.descendantCounts.get('b'), 1)
})

// 辅助对话（侧线）标注（2026-09-30）：侧线在官方列表里被隐藏，但在画布上照旧显示 ——
// 这里钉住「显示 + 可辨识」的数据面：声明的 child 打 `sideChat` 标，其余线一个都不受影响。
test('marks every card of a declared side-chat line, and nothing else', async () => {
  const { conversationCards } = await loadConversationCards({ sideChatIds: ['session-side'] })
  const cards = conversationCards([
    { id: 'thread-side', dshSessionId: 'session-side', parentId: 'thread-parent', position: { x: 486, y: 82 }, messages: [{ kind: 'user', text: '侧线提问', sourceSeq: 1 }, { kind: 'assistant', text: '侧线回答', sourceSeq: 2 }] },
    { id: 'thread-plain', dshSessionId: 'session-plain', parentId: 'thread-parent', position: { x: 486, y: 400 }, messages: [{ kind: 'user', text: '普通分支', sourceSeq: 1 }, { kind: 'assistant', text: '普通回答', sourceSeq: 2 }] },
  ])
  const side = cards.filter(card => card.dshThreadId === 'thread-side')
  const plain = cards.filter(card => card.dshThreadId === 'thread-plain')
  assert.ok(side.length > 0 && plain.length > 0, '两条线都要出卡（画布不隐藏任何一条）')
  assert.ok(side.every(card => card.sideChat === true), '声明的侧线每张卡都带 sideChat 标（渲染层据此决定线头卡徽标）')
  assert.ok(plain.every(card => card.sideChat === false), '用户自己 fork 的分支不受影响')
})

test('without the declaration the canvas behaves exactly as before', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([{
    id: 'thread-side', dshSessionId: 'session-side', parentId: null, position: { x: 86, y: 82 },
    messages: [{ kind: 'user', text: '提问', sourceSeq: 1 }],
  }])
  assert.ok(cards.length > 0, '声明缺席时线照旧在画布上')
  assert.ok(cards.every(card => card.sideChat === false), '只是没有标注')
})

// ── 耗时拆分纯函数（2026-10-20，第二期）────────────────────────────────────

test('processDurationMs computes call-to-result duration', async () => {
  const { processDurationMs } = await loadConversationCards()
  assert.equal(processDurationMs({ calledAt: '2026-01-01T00:00:00.000Z', resultedAt: '2026-01-01T00:00:03.500Z' }), 3_500)
})

test('processDurationMs returns null for missing or unusable timestamps', async () => {
  const { processDurationMs } = await loadConversationCards()
  assert.equal(processDurationMs({ calledAt: '2026-01-01T00:00:00.000Z', resultedAt: null }), null, '未回结果')
  assert.equal(processDurationMs({ calledAt: null, resultedAt: '2026-01-01T00:00:03.500Z' }), null, 'result 先到（pendingProcess 场景）')
  assert.equal(processDurationMs({}), null, '老数据无字段')
  assert.equal(processDurationMs({ calledAt: 'not-a-date', resultedAt: '2026-01-01T00:00:03.500Z' }), null, '非法时间串')
})

test('processDurationMs clamps clock rollback to zero instead of showing negatives', async () => {
  const { processDurationMs } = await loadConversationCards()
  assert.equal(processDurationMs({ calledAt: '2026-01-01T00:00:05.000Z', resultedAt: '2026-01-01T00:00:03.000Z' }), 0)
})

test('formatDurationMs renders ms / s / m tiers with an em dash for null', async () => {
  const { formatDurationMs } = await loadConversationCards()
  assert.equal(formatDurationMs(420), '420ms')
  assert.equal(formatDurationMs(1_500), '1.5s')
  assert.equal(formatDurationMs(45_000), '45s')
  assert.equal(formatDurationMs(125_000), '2m5s')
  assert.equal(formatDurationMs(null), '—')
})

test('turnTimingSplit sums tool durations and approximates model wait', async () => {
  const { turnTimingSplit } = await loadConversationCards()
  const messages = [
    { kind: 'user', at: '2026-01-01T00:00:00.000Z' },
    { kind: 'assistant', at: '2026-01-01T00:00:10.000Z', process: [
      { calledAt: '2026-01-01T00:00:02.000Z', resultedAt: '2026-01-01T00:00:05.000Z' },
      { calledAt: '2026-01-01T00:00:06.000Z', resultedAt: '2026-01-01T00:00:08.000Z' },
    ] },
  ]
  const split = turnTimingSplit(messages)
  assert.equal(split.toolMs, 5_000, '工具累计 = 各条目耗时之和（并行按串行累加）')
  assert.equal(split.modelMs, 5_000, '模型耗时 = 首条 assistant 的 at − user 的 at − 工具累计（轮边界近似）')
})

test('turnTimingSplit omits halves without data', async () => {
  const { turnTimingSplit } = await loadConversationCards()
  const noTools = turnTimingSplit([
    { kind: 'user', at: '2026-01-01T00:00:00.000Z' },
    { kind: 'assistant', at: '2026-01-01T00:00:04.000Z', process: [] },
  ])
  assert.equal(noTools.toolMs, null, '无工具时间 → 不渲染工具项')
  assert.equal(noTools.modelMs, 4_000)

  const legacy = turnTimingSplit([
    { kind: 'user', at: '2026-01-01T00:00:00.000Z' },
    { kind: 'assistant', at: '2026-01-01T00:00:04.000Z', process: [{ name: 'bash', result: 'ok' }] },
  ])
  assert.equal(legacy.toolMs, null, '老条目无时间字段 → 工具项不渲染')
  assert.equal(legacy.modelMs, 4_000, '模型耗时不受工具缺时间影响')
})

// 模型调用次数徽标（2026-10-20）：一轮内模型可能来回多趟（每 step 一条 assistant
// 消息），卡片 meta 显示「调用 N 次」。口径：按 turn:step 去重；只统计持久化消息
// （有 sourceSeq）；liveReplies 合成的前端 pending 消息无 step，不计入。
test('counts distinct model calls per turn by turn:step', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([{
    id: 'session-1', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '第一个问题', sourceSeq: 1 },
      { kind: 'assistant', text: '第一步回复', sourceSeq: 2, turn: 1, step: 1 },
      { kind: 'assistant', text: '第二步回复', sourceSeq: 3, turn: 1, step: 2 },
      { kind: 'user', text: '第二个问题', sourceSeq: 4 },
      { kind: 'assistant', text: '第二轮回复', sourceSeq: 5, turn: 2, step: 1 },
    ],
  }])

  assert.equal(cards[0].callCount, 2, '一轮内两个 step = 两次模型调用')
  assert.equal(cards[1].callCount, 1)
})

test('does not double-count streamed assistant messages of one step', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([{
    id: 'session-1', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '问题', sourceSeq: 1 },
      { kind: 'assistant', text: '草稿', sourceSeq: 2, turn: 1, step: 1 },
      { kind: 'assistant', text: '最终', sourceSeq: 3, turn: 1, step: 1 },
    ],
  }])

  assert.equal(cards[0].callCount, 1, '同 step 的多条 assistant 只算一次调用')
})

test('excludes live pending replies without a step from the call count', async () => {
  const { conversationCards } = await loadConversationCards()
  const cards = conversationCards([{
    id: 'session-1', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '问题', sourceSeq: 1 },
      { kind: 'assistant', text: '', pending: true, at: '2026-10-20T00:00:00.000Z' },
    ],
  }])

  assert.equal(cards[0].callCount, 0, 'liveReplies 合成消息（无 sourceSeq/step）不计入')
})

test('keeps a failed turn at zero calls so the badge stays hidden', async () => {
  const { conversationCards } = await loadConversationCards()
  const [card] = conversationCards([{
    id: 'session-error', parentId: null, position: { x: 86, y: 82 },
    messages: [
      { kind: 'user', text: '调用搜索', sourceSeq: 1 },
      { kind: 'error', text: '余额不足', sourceSeq: 2 },
    ],
  }])

  assert.equal(card.callCount, 0, 'error 轮没有 assistant 消息，调用数为 0（meta 不渲染徽标）')
})
