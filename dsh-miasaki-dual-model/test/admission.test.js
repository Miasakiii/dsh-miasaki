// lib/admission.js 的回归闸门 —— 准入与路由的判据必须同源。
//
// 要锁死的失效链（2026-09-29 修复）：
//   准入只看"启用 + 配置了辅助模型"就放行图片，而路由还要看 `hasImage`（pre-step 实测）。
//   两者不同源时，一旦 pre-step 没挂上或判定抛错，就会出现
//   「准入门已放行 → 路由不切 → 图片交给不支持图的主模型 → 全程零信号」。
//   本测试把"图片执行通道未建立时不接管"钉死。

import assert from 'node:assert/strict'
import test from 'node:test'

import { decideAdmission, imageContextOnFailure } from '../lib/admission.js'

const ASSIST = { provider: 'volc', model: 'doubao-vision' }

test('decideAdmission：未启用一律不接管（走本体原生分支）', () => {
  assert.equal(decideAdmission({ enabled: false, assist: ASSIST, channelReady: true }), undefined)
  assert.equal(decideAdmission({ enabled: undefined, assist: ASSIST, channelReady: true }), undefined)
})

test('decideAdmission：未配置辅助模型不接管', () => {
  assert.equal(decideAdmission({ enabled: true, assist: undefined, channelReady: true }), undefined)
  assert.equal(decideAdmission({ enabled: true, assist: null, channelReady: true }), undefined)
  assert.equal(decideAdmission({ enabled: true, assist: { provider: '', model: 'm' }, channelReady: true }), undefined)
  assert.equal(decideAdmission({ enabled: true, assist: { provider: 'p', model: '   ' }, channelReady: true }), undefined)
})

test('★ 通道未建立时不接管 —— 否则放行的是一张没有任何模型会看的图', () => {
  assert.equal(decideAdmission({ enabled: true, assist: ASSIST, channelReady: false }), undefined)
  assert.equal(decideAdmission({ enabled: true, assist: ASSIST, channelReady: undefined }), undefined)
  // 严格的 true 才算就绪：任何真值 coercion 都不接受（'true' / 1 都不是证据）
  assert.equal(decideAdmission({ enabled: true, assist: ASSIST, channelReady: 'true' }), undefined)
})

test('启用 + 已配置 + 通道就绪 ⇒ 接管，并给出归一化后的路由', () => {
  const route = decideAdmission({
    enabled: true,
    assist: { provider: ' volc ', model: ' doubao-vision ' },
    channelReady: true,
  })
  assert.deepEqual(route, { provider: 'volc', model: 'doubao-vision' })
})

test('★ 判定失败时保守按「有图」处理，且必须留痕', () => {
  const calls = []
  const original = console.warn
  console.warn = (...args) => calls.push(args)
  let result
  try {
    result = imageContextOnFailure(new Error('deriveMessages 抛错'))
  } finally {
    console.warn = original
  }
  assert.equal(result, true, '保守取 true：多切一次辅助模型远好于丢一张图')
  assert.equal(calls.length, 1, '静默失败等于无从归因 —— 必须留痕一次')
})

test('保守策略与准入的配合：判失败 ⇒ hasImage 为真 ⇒ 路由会切到辅助模型', () => {
  // 把两段逻辑按 index.js 的实际接线串起来，证明失效链已被堵住。
  // 留痕行为由上一个用例断言；这里静音，避免测试日志里出现看似报错的 warn。
  const original = console.warn
  console.warn = () => {}
  let hasImage
  try {
    hasImage = imageContextOnFailure(new Error('boom')) // pre-step 的 catch 分支
  } finally {
    console.warn = original
  }
  const routed = decideAdmission({ enabled: true, assist: ASSIST, channelReady: true })
  assert.equal(routed !== undefined && hasImage === true, true, '准入放行时路由必定处于图片上下文')
})
