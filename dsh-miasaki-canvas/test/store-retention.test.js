// store-retention.test.js — 存储治理行为闸门（2026-09-26，84MB store 的治理）。
//
// 守什么：`workspaces.json` 曾涨到 84MB（203 线程 / 14843 条消息），构成为
// process.result 43.7MB + process.arguments 14.4MB + 消息正文 15.5MB（骨架仅 0.08MB）——
// 工具调用的两个字段是投影里**唯一没有上限**的，消息条数也从未设限。治理后必须在
// 所有会增长数据的路径上同时成立：
//   ① 单条工具载荷超限即截断（且 `null` 必须保持 `null` —— 前端据此显示「等待结果」，
//      一旦变成字符串，等待中的调用会伪装成「已完成」）；
//   ② 每个线程只留最近 N 条消息（画布节点是会话预览，不是全文副本）；
//   ③ 被裁掉的消息不得因 replay 从更早的 seq 重放而复活（裁剪水位）。
// 迁移只允许对**真的被改写**的数据置位：否则「已是最新的文件载入不重写」契约失守
// （那条契约由 workspace-store.test.js 的 does-not-rewrite 用例单独钉住）。
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkspaceStore } from '../index.js'

// 上限值从实现源码提取：闸门钉的是**行为**（超限即截断、只留最近 N 条），
// 不是某个具体数字 —— 调参时这里跟着走，行为回归仍会被抓住。
const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
const constant = (name) => {
  const match = new RegExp(`const ${name} = ([\\d_]+)`).exec(source)
  assert.notEqual(match, null, `index.js 必须保留常量 ${name}`)
  return Number(match[1].replaceAll('_', ''))
}
const MAX_THREAD_MESSAGES = constant('MAX_THREAD_MESSAGES')
const MAX_PROCESS_PAYLOAD_LENGTH = constant('MAX_PROCESS_PAYLOAD_LENGTH')

const TRUNCATED = /已截断/
const NOW = '2026-01-01T00:00:00.000Z'

async function freshStore() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-canvas-retention-'))
  const dataFile = join(directory, 'state.json')
  return { store: new WorkspaceStore(dataFile), dataFile }
}

/** 投影会话落在专门的「DSH 任务」工作区里，取它（而不是新建一个空工作区）。 */
async function projectedThread(store) {
  const [workspace] = await store.list()
  const graph = await store.get(workspace.id)
  return graph.threads[0]
}

const toolSession = (id, payload) => ({
  id,
  header: {},
  firstLiveSeq: 0,
  events: [
    { type: 'assistant/message', seq: 0, time: 1, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '开始处理' }] } } },
    { type: 'tool/call', seq: 1, time: 2, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: payload } },
  ],
})

test('工具载荷超限即截断：arguments 保头 + 带可见标记', async () => {
  const { store } = await freshStore()
  const long = 'x'.repeat(MAX_PROCESS_PAYLOAD_LENGTH + 500)
  await store.projectSession(toolSession('session-args', long))
  const thread = await projectedThread(store)
  const [entry] = thread.messages[0].process
  assert.ok(entry.arguments.length < long.length, '超限的 arguments 必须被截断')
  assert.match(entry.arguments, TRUNCATED, '截断必须带可见标记，而不是静默截尾')
  assert.ok(entry.arguments.startsWith('x'.repeat(MAX_PROCESS_PAYLOAD_LENGTH)), '保头：上限内的前缀逐字节保留')
  assert.ok(entry.arguments.length <= MAX_PROCESS_PAYLOAD_LENGTH + 40, '截断后长度 = 上限 + 标记')
})

test('工具结果超限即截断：result 同受约束，error 仍为 null', async () => {
  const { store } = await freshStore()
  const long = 'y'.repeat(MAX_PROCESS_PAYLOAD_LENGTH + 500)
  const session = toolSession('session-result', '{"cmd":"ls"}')
  session.events.push({
    type: 'tool/result', seq: 2, time: 3,
    data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: long }] } },
  })
  await store.projectSession(session)
  const thread = await projectedThread(store)
  const [entry] = thread.messages[0].process
  assert.ok(entry.result.length < long.length, '超限的 result 必须被截断')
  assert.match(entry.result, TRUNCATED)
  assert.equal(entry.error, null, '没有错误时必须是 null，不能被截断逻辑写成字符串')
})

test('等待中的工具调用：result 保持 null（前端据此显示「等待结果」）', async () => {
  const { store } = await freshStore()
  await store.projectSession(toolSession('session-pending', '{"cmd":"sleep 5"}'))
  const thread = await projectedThread(store)
  const [entry] = thread.messages[0].process
  assert.equal(entry.result, null)
  assert.equal(entry.error, null)
  assert.equal(entry.arguments, '{"cmd":"sleep 5"}', '未超限的载荷必须逐字节保留')
})

test(`线程只保留最近 ${MAX_THREAD_MESSAGES} 条消息，且保留的是最新的一批`, async () => {
  const { store } = await freshStore()
  const overflow = 20
  const count = MAX_THREAD_MESSAGES + overflow
  const events = Array.from({ length: count }, (_, i) => ({
    type: 'user/message', seq: i, time: i + 1, data: { content: [{ type: 'text', text: `消息 ${i}` }] },
  }))
  await store.projectSession({ id: 'session-window', header: {}, firstLiveSeq: 0, events })
  const thread = await projectedThread(store)
  assert.equal(thread.messages.length, MAX_THREAD_MESSAGES)
  assert.equal(thread.messages.at(-1).sourceSeq, count - 1, '必须保留最新一条')
  assert.equal(thread.messages[0].sourceSeq, overflow, '被丢弃的是最早的一批')
  assert.equal(thread.trimmedBeforeSeq, overflow - 1, '水位 = 已丢弃消息的最高 seq')
})

test('★ 裁剪水位：从更早的 seq 重放不得让已丢弃的卡片复活', async () => {
  const { store } = await freshStore()
  const overflow = 20
  const count = MAX_THREAD_MESSAGES + overflow
  const events = Array.from({ length: count }, (_, i) => ({
    type: 'user/message', seq: i, time: i + 1, data: { content: [{ type: 'text', text: `消息 ${i}` }] },
  }))
  const session = { id: 'session-replay', header: {}, firstLiveSeq: 0, events }
  await store.projectSession(session)
  assert.equal((await projectedThread(store)).messages.length, MAX_THREAD_MESSAGES)

  // 从 0 重放整段历史：窗口内的重复由 sourceSeq 拦、窗口外的由水位拦
  await store.projectSession(session, 0)
  const thread = await projectedThread(store)
  assert.equal(thread.messages.length, MAX_THREAD_MESSAGES, '重放旧事件不得复活已裁剪消息')
  assert.equal(thread.messages.at(-1).sourceSeq, count - 1)
  assert.equal(thread.messages[0].sourceSeq, overflow)
})

test('老 store 载入即剪裁：超量消息与超长载荷在 load 时治理并落盘', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-canvas-migrate-'))
  const dataFile = join(directory, 'state.json')
  const overflow = 30
  const long = 'z'.repeat(MAX_PROCESS_PAYLOAD_LENGTH + 400)
  const messages = Array.from({ length: MAX_THREAD_MESSAGES + overflow }, (_, i) => ({
    id: `m-${i}`, kind: 'assistant', text: 'hi', sourceSeq: i, at: NOW,
    process: [{ callId: 'c', turn: 1, step: 1, name: 'bash', arguments: long, result: long, error: null }],
  }))
  const state = {
    version: 5,
    hiddenSessionIds: [],
    workspaces: [{
      id: 'w-1', kind: 'dsh', cwd: 'C:\\work\\x', title: 'x', createdAt: NOW, updatedAt: NOW,
      threads: [{
        id: 't-1', title: 's', parentId: null, dshSessionId: 's-1', dshSessionTitle: null,
        color: '#0f766e', position: { x: 86, y: 82 }, sourceSeedLength: null,
        createdAt: NOW, updatedAt: NOW, messages, mergeFrom: null, mergeState: null, absorbedBy: [],
      }],
    }],
  }
  await writeFile(dataFile, JSON.stringify(state))
  const before = (await stat(dataFile)).size

  const store = new WorkspaceStore(dataFile)
  await store.ready
  const graph = await store.get('w-1')
  const thread = graph.threads[0]
  assert.equal(thread.messages.length, MAX_THREAD_MESSAGES, '载入即裁剪到保留窗口')
  assert.ok(thread.messages[0].process[0].arguments.length < long.length, '载入即截断超长载荷')
  assert.match(thread.messages[0].process[0].result, TRUNCATED)
  assert.equal(thread.trimmedBeforeSeq, overflow - 1, '迁移必须同时写入裁剪水位')

  const after = (await stat(dataFile)).size
  assert.ok(after < before, `迁移必须落盘（${before} → ${after}），否则下次载入还要再算一遍`)
})

test('迁移对已合规文件不置位：载入不产生额外写盘（与 does-not-rewrite 契约一致）', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-canvas-noop-'))
  const dataFile = join(directory, 'state.json')
  const state = {
    version: 5,
    hiddenSessionIds: [],
    workspaces: [{
      id: 'w-1', kind: 'dsh', cwd: 'C:\\work\\x', title: 'x', createdAt: NOW, updatedAt: NOW,
      threads: [{
        id: 't-1', title: 's', parentId: null, dshSessionId: 's-1', dshSessionTitle: null,
        color: '#0f766e', position: { x: 86, y: 82 }, sourceSeedLength: null,
        createdAt: NOW, updatedAt: NOW, trimmedBeforeSeq: -1,
        messages: [{ id: 'm-1', kind: 'assistant', text: 'hi', sourceSeq: 1, at: NOW, process: [] }],
        mergeFrom: null, mergeState: null, absorbedBy: [],
      }],
    }],
  }
  await writeFile(dataFile, JSON.stringify(state))
  const before = (await stat(dataFile)).mtimeMs
  await new Promise(resolve => setTimeout(resolve, 80))
  await new WorkspaceStore(dataFile).ready
  const after = (await stat(dataFile)).mtimeMs
  assert.equal(after, before, '内容未变不得重写')
})
