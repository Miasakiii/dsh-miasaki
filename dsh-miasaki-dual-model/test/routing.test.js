import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeRoute, sameRoute, decideRoute, applyRoute, supportsImage, selectVisionModels,
} from '../lib/routing.js'

test('normalizeRoute：缺任一项即视为未配置', () => {
  assert.equal(normalizeRoute(undefined), undefined)
  assert.equal(normalizeRoute(null), undefined)
  assert.equal(normalizeRoute({ provider: '', model: 'm' }), undefined)
  assert.equal(normalizeRoute({ provider: 'p', model: '' }), undefined)
  assert.equal(normalizeRoute({ provider: '   ', model: 'm' }), undefined)
  assert.equal(normalizeRoute({ provider: 42, model: 'm' }), undefined)
})

test('normalizeRoute：去除首尾空白', () => {
  assert.deepEqual(normalizeRoute({ provider: ' p ', model: ' m ' }), { provider: 'p', model: 'm' })
})

test('sameRoute：两侧都必须是完整路由', () => {
  assert.equal(sameRoute({ provider: 'a', model: 'b' }, { provider: 'a', model: 'b' }), true)
  assert.equal(sameRoute({ provider: 'a', model: 'b' }, { provider: 'a', model: 'c' }), false)
  assert.equal(sameRoute(undefined, { provider: 'a', model: 'b' }), false)
})

test('decideRoute：未启用 / 未配置 / 无图 一律 keep', () => {
  const current = { provider: 'main', model: 'text-only' }
  const assist = { provider: 'vision', model: 'v1' }
  assert.deepEqual(decideRoute({ enabled: false, assist, hasImage: true, current }), { kind: 'keep' })
  assert.deepEqual(decideRoute({ enabled: true, assist: undefined, hasImage: true, current }), { kind: 'keep' })
  assert.deepEqual(decideRoute({ enabled: true, assist, hasImage: false, current }), { kind: 'keep' })
  assert.deepEqual(decideRoute({ enabled: true, assist, hasImage: undefined, current }), { kind: 'keep' })
})

test('decideRoute：图片上下文 + 已配置辅助模型 → assist', () => {
  const decision = decideRoute({
    enabled: true,
    assist: { provider: 'vision', model: 'v1' },
    hasImage: true,
    current: { provider: 'main', model: 'text-only' },
  })
  assert.equal(decision.kind, 'assist')
  assert.equal(decision.provider, 'vision')
  assert.equal(decision.model, 'v1')
})

test('decideRoute：辅助模型与当前路由相同 → keep（不做无意义的 config 抖动）', () => {
  const decision = decideRoute({
    enabled: true,
    assist: { provider: 'same', model: 'same' },
    hasImage: true,
    current: { provider: 'same', model: 'same' },
  })
  assert.deepEqual(decision, { kind: 'keep' })
})

test('applyRoute：切换时必须清空继承的 reasoningEffort', () => {
  const config = { provider: 'main', model: 'text-only', reasoningEffort: 'max', temperature: 0.3 }
  const applied = applyRoute(config, { kind: 'assist', provider: 'vision', model: 'v1' })
  assert.equal(applied.provider, 'vision')
  assert.equal(applied.model, 'v1')
  assert.equal(applied.reasoningEffort, undefined)
  assert.equal(Object.prototype.hasOwnProperty.call(applied, 'reasoningEffort'), false)
  // 其它采样字段保持不动
  assert.equal(applied.temperature, 0.3)
  // 原对象不被修改
  assert.equal(config.provider, 'main')
})

test('applyRoute：keep 时原样返回同一对象', () => {
  const config = { provider: 'main', model: 'm', reasoningEffort: 'low' }
  assert.equal(applyRoute(config, { kind: 'keep' }), config)
})

test('supportsImage：undefined 按 unknown 放行，显式缺失才是负能力', () => {
  assert.equal(supportsImage(undefined), true)
  assert.equal(supportsImage(null), true)
  assert.equal(supportsImage(['text', 'image']), true)
  assert.equal(supportsImage(['text']), false)
  assert.equal(supportsImage([]), false)
})

test('selectVisionModels：保持输入顺序并过滤掉纯文本模型', () => {
  const models = [
    { provider: 'a', id: 'text-only', inputModalities: ['text'] },
    { provider: 'a', id: 'vision-1', inputModalities: ['text', 'image'] },
    { provider: 'b', id: 'unknown', inputModalities: undefined },
  ]
  const picked = selectVisionModels(models)
  assert.deepEqual(picked.map(model => model.id), ['vision-1', 'unknown'])
})
