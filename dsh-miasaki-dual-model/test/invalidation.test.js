import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SETTINGS_INVALIDATION_EVENTS, watchSettingsInvalidation } from '../lib/invalidation.js'

/** 记录 ctx.on 注册的桩；不模拟任何 DSH 事件系统，只验证注册/触发/反注册行为。 */
function stubCtx() {
  const listeners = new Map()
  return {
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(handler)
      return () => listeners.get(name)?.delete(handler)
    },
    /** 模拟一次事件发出（任意 payload 均可，处理器不消费参数）。 */
    emit(name, ...args) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(...args)
    },
    has(name) {
      return (listeners.get(name)?.size ?? 0) > 0
    },
  }
}

test('事件名常量：旧名在前、新名在后，恰好两条（0.1.5/0.1.6 → 0.1.7+ 双轨）', () => {
  assert.deepEqual(SETTINGS_INVALIDATION_EVENTS, ['settings/updated', 'settings/document-updated'])
})

test('watchSettingsInvalidation：两个名字都注册监听', () => {
  const ctx = stubCtx()
  const dispose = watchSettingsInvalidation(ctx, () => {})
  assert.equal(ctx.has('settings/updated'), true)
  assert.equal(ctx.has('settings/document-updated'), true)
  dispose()
})

test('watchSettingsInvalidation：任一事件发出都击穿缓存（含 0.1.7 新事件的 payload 形状）', () => {
  const ctx = stubCtx()
  let hits = 0
  watchSettingsInvalidation(ctx, () => { hits += 1 })

  ctx.emit('settings/updated', 'llm-pi-ai', { a: 1 }, { a: 2 }, 'update')
  assert.equal(hits, 1, '旧事件（0.1.5/0.1.6 语义）应命中')

  ctx.emit('settings/document-updated', 'llm-pi-ai', 42)
  assert.equal(hits, 2, '新事件（0.1.7 RAW 文档层语义，ns + revision）应命中')

  ctx.emit('llm/adapters-updated', [])
  assert.equal(hits, 2, '无关事件不应误触发')
})

test('watchSettingsInvalidation：dispose 后两个名字都不再触发', () => {
  const ctx = stubCtx()
  let hits = 0
  const dispose = watchSettingsInvalidation(ctx, () => { hits += 1 })
  dispose()

  ctx.emit('settings/updated')
  ctx.emit('settings/document-updated')
  assert.equal(hits, 0)
})

test('watchSettingsInvalidation：重复 dispose 幂等，不抛错', () => {
  const ctx = stubCtx()
  const dispose = watchSettingsInvalidation(ctx, () => {})
  dispose()
  assert.doesNotThrow(() => dispose())
})
