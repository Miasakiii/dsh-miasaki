import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { WorkspaceStore } from '../index.js'

const cwd = 'C:\\work\\merge'

function makeSession(id, title, extra = {}) {
  return { id, title, cwd, header: { meta: { cwd } }, events: [], ...extra }
}

async function storeWithTwoLines() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-canvas-merge-'))
  const store = new WorkspaceStore(join(directory, 'state.json'))
  await store.syncSessions([
    makeSession('s-a', '线 A'),
    makeSession('s-b', '线 B'),
  ])
  const [workspace] = await store.list()
  const graph = await store.get(workspace.id)
  const threadA = graph.threads.find(thread => thread.dshSessionId === 's-a')
  const threadB = graph.threads.find(thread => thread.dshSessionId === 's-b')
  return { store, workspaceId: workspace.id, threadA, threadB }
}

test('v4 file migrates to v5 with merge fields backfilled on load', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-canvas-migrate-v5-'))
  const dataFile = join(directory, 'state.json')
  await writeFile(dataFile, JSON.stringify({
    version: 4,
    hiddenSessionIds: [],
    workspaces: [{
      id: 'w-1', kind: 'dsh', cwd, title: 'x',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      threads: [{
        id: 't-1', title: 's', parentId: null, dshSessionId: 's-1', dshSessionTitle: null,
        color: '#0f766e', position: { x: 86, y: 82 },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        messages: [],
      }],
    }],
  }))
  const store = new WorkspaceStore(dataFile)
  const graph = await store.get('w-1')
  assert.equal(graph.threads[0].mergeFrom, null)
  assert.equal(graph.threads[0].mergeState, null)
  assert.deepEqual(graph.threads[0].absorbedBy, [])
  assert.match(await readFile(dataFile, 'utf8'), /"version": ?5/)
})

test('createMergeDraft validates sources and stores the merge plan', async () => {
  const { store, workspaceId, threadA, threadB } = await storeWithTwoLines()
  await assert.rejects(
    () => store.createMergeDraft(workspaceId, { sources: [threadA.id, 'missing'], forkSource: threadA.id }),
    /合并来源不存在/,
  )
  await assert.rejects(
    () => store.createMergeDraft(workspaceId, { sources: [threadA.id, threadA.id], forkSource: threadA.id }),
    /两个不同的节点/,
  )
  await assert.rejects(
    () => store.createMergeDraft(workspaceId, { sources: [threadA.id, threadB.id], forkSource: 'nope' }),
    /forkSource/,
  )

  const draft = await store.createMergeDraft(workspaceId, {
    sources: [threadA.id, threadB.id],
    forkSource: threadA.id,
    anchorSeqA: 12,
    userIntent: '综合两条线',
  })
  assert.equal(draft.mergeState, 'draft')
  assert.equal(draft.dshSessionId, null)
  assert.deepEqual(draft.mergeFrom.sources, [threadA.id, threadB.id])
  assert.equal(draft.mergeFrom.anchorSeqA, 12)
  assert.equal(draft.mergeFrom.anchorSeqB, null)
  assert.equal(draft.mergeFrom.injectedForm, 'full')
  assert.equal(draft.mergeFrom.userIntent, '综合两条线')
  assert.match(draft.title, /^合并：线 A × 线 B$/)
})

test('prepareMergeMessage quotes both anchor exchanges and maps the fork cut', async () => {
  const { store, workspaceId, threadA, threadB } = await storeWithTwoLines()
  const graphA = await store.get(workspaceId)
  await store.projectEvents(
    { id: 's-a', title: '线 A', cwd, header: { meta: { cwd } }, events: [] },
    [
      { type: 'user/message', seq: 12, time: 1, data: { content: [{ type: 'text', text: '如何设计合并？' }] } },
      { type: 'assistant/message', seq: 13, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '三层分离：事实、投影、交互。' }] } } },
    ],
  )
  await store.projectEvents(
    { id: 's-b', title: '线 B', cwd, header: { meta: { cwd } }, events: [] },
    [
      { type: 'user/message', seq: 7, time: 3, data: { content: [{ type: 'text', text: 'B 线的问题' }] } },
      { type: 'assistant/message', seq: 8, time: 4, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'B 线的结论' }] } } },
    ],
  )
  // The sync happens before projection; bind the projected messages onto the threads.
  const graph = await store.get(workspaceId)
  const draft = await store.createMergeDraft(workspaceId, {
    sources: [threadA.id, threadB.id],
    forkSource: threadA.id,
    anchorSeqA: 12,
    anchorSeqB: 7,
  })
  const prepare = await store.prepareMergeMessage(draft.id)
  assert.equal(prepare.forkSessionId, threadA.dshSessionId)
  assert.equal(prepare.atSeq, 12)
  assert.match(prepare.messageText, /\[合并请求\]/)
  assert.match(prepare.messageText, /来源线 A/)
  assert.match(prepare.messageText, /如何设计合并？/)
  assert.match(prepare.messageText, /三层分离：事实、投影、交互。/)
  assert.match(prepare.messageText, /B 线的结论/)
  assert.match(prepare.messageText, /用户合并指令：（无，请自行综合）/)
  void graph
})

test('prepareMergeMessage uses the B anchor when the fork source is switched', async () => {
  const { store, workspaceId, threadA, threadB } = await storeWithTwoLines()
  const draft = await store.createMergeDraft(workspaceId, {
    sources: [threadA.id, threadB.id],
    forkSource: threadB.id,
    anchorSeqA: 12,
    anchorSeqB: 7,
  })
  const prepare = await store.prepareMergeMessage(draft.id)
  assert.equal(prepare.forkSessionId, threadB.dshSessionId)
  assert.equal(prepare.atSeq, 7)
})

test('prepareMergeMessage truncates over-long quoted answers', async () => {
  const { store, workspaceId, threadA, threadB } = await storeWithTwoLines()
  await store.projectEvents(
    { id: 's-b', title: '线 B', cwd, header: { meta: { cwd } }, events: [] },
    [
      { type: 'user/message', seq: 7, time: 3, data: { content: [{ type: 'text', text: 'B 线的问题' }] } },
      { type: 'assistant/message', seq: 8, time: 4, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '长'.repeat(9_000) }] } } },
    ],
  )
  const draft = await store.createMergeDraft(workspaceId, { sources: [threadA.id, threadB.id], forkSource: threadA.id })
  const prepare = await store.prepareMergeMessage(draft.id)
  assert.ok(prepare.messageText.length < 9_000 + 500)
  assert.match(prepare.messageText, /——…（详情查看全文）/)
})

test('commitMerge binds the session, links the fork parent, and marks sources absorbed', async () => {
  const { store, workspaceId, threadA, threadB } = await storeWithTwoLines()
  const draft = await store.createMergeDraft(workspaceId, { sources: [threadA.id, threadB.id], forkSource: threadA.id })
  await assert.rejects(
    () => store.commitMerge(draft.id, {}),
    /dshSessionId/,
  )
  const committed = await store.commitMerge(draft.id, { dshSessionId: 's-merge', dshSessionTitle: '合并产物' })
  assert.equal(committed.mergeState, 'committed')
  assert.equal(committed.dshSessionId, 's-merge')
  assert.equal(committed.parentId, threadA.id)
  const graph = await store.get(workspaceId)
  assert.deepEqual(graph.threads.find(thread => thread.id === threadA.id).absorbedBy, [draft.id])
  assert.deepEqual(graph.threads.find(thread => thread.id === threadB.id).absorbedBy, [draft.id])
})

test('commitMerge folds in the orphan node won by the projection race', async () => {
  const { store, workspaceId, threadA, threadB } = await storeWithTwoLines()
  const draft = await store.createMergeDraft(workspaceId, { sources: [threadA.id, threadB.id], forkSource: threadA.id })
  // session/created projection won the race: an orphan thread for the fork exists.
  await store.projectEvents(
    { id: 's-merge', title: '线 A 分支', cwd, header: { meta: { cwd }, parentSession: 's-a', seedLength: 12 }, events: [] },
    [{ type: 'user/message', seq: 30, time: 1, data: { content: [{ type: 'text', text: '[合并请求] …' }] } }],
  )
  const committed = await store.commitMerge(draft.id, { dshSessionId: 's-merge' })
  assert.equal(committed.mergeState, 'committed')
  const graph = await store.get(workspaceId)
  assert.equal(graph.threads.filter(thread => thread.dshSessionId === 's-merge').length, 1)
  const merged = graph.threads.find(thread => thread.id === draft.id)
  assert.ok(merged.messages.some(message => message.text === '[合并请求] …'))
  assert.equal(merged.sourceSeedLength, 12)
})

test('updateMergeDraft edits intent and fork source while still a draft', async () => {
  const { store, workspaceId, threadA, threadB } = await storeWithTwoLines()
  const draft = await store.createMergeDraft(workspaceId, { sources: [threadA.id, threadB.id], forkSource: threadA.id })
  await store.commitMerge(draft.id, { dshSessionId: 's-merge' })
  await assert.rejects(
    () => store.updateMergeDraft(draft.id, { userIntent: 'too late' }),
    /只有合并请求草稿可以编辑/,
  )

  const second = await store.createMergeDraft(workspaceId, { sources: [threadA.id, threadB.id], forkSource: threadA.id })
  const updated = await store.updateMergeDraft(second.id, { forkSource: threadB.id, userIntent: '以 B 为主线' })
  assert.equal(updated.mergeFrom.forkSource, threadB.id)
  assert.equal(updated.mergeFrom.userIntent, '以 B 为主线')
})

test('removing a merge node clears absorbedBy back-references', async () => {
  const { store, workspaceId, threadA, threadB } = await storeWithTwoLines()
  const draft = await store.createMergeDraft(workspaceId, { sources: [threadA.id, threadB.id], forkSource: threadA.id })
  await store.commitMerge(draft.id, { dshSessionId: 's-merge' })
  await store.removeThread(draft.id)
  const graph = await store.get(workspaceId)
  assert.deepEqual(graph.threads.find(thread => thread.id === threadA.id).absorbedBy, [])
  assert.deepEqual(graph.threads.find(thread => thread.id === threadB.id).absorbedBy, [])
})
