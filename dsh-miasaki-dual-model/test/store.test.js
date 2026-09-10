import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeConfig, DEFAULT_CONFIG, DualModelStore } from '../lib/store.js'

test('sanitizeConfig：缺省值来自 DEFAULT_CONFIG', () => {
  assert.deepEqual(sanitizeConfig(undefined), { ...DEFAULT_CONFIG })
  assert.deepEqual(sanitizeConfig(null), { ...DEFAULT_CONFIG })
  assert.deepEqual(sanitizeConfig('garbage'), { ...DEFAULT_CONFIG })
  assert.deepEqual(sanitizeConfig([]), { ...DEFAULT_CONFIG })
})

test('sanitizeConfig：丢弃未知字段', () => {
  const cleaned = sanitizeConfig({ enabled: false, assistProvider: 'p', assistModel: 'm', injected: 'evil' })
  assert.deepEqual(Object.keys(cleaned).sort(), ['assistModel', 'assistProvider', 'enabled'])
  assert.equal(cleaned.injected, undefined)
})

test('sanitizeConfig：类型不对一律回退安全值', () => {
  const cleaned = sanitizeConfig({ enabled: 'yes', assistProvider: 42, assistModel: { a: 1 } })
  assert.equal(cleaned.enabled, false) // 非 true 即假
  assert.equal(cleaned.assistProvider, '')
  assert.equal(cleaned.assistModel, '')
})

test('sanitizeConfig：字符串去除首尾空白', () => {
  const cleaned = sanitizeConfig({ assistProvider: '  openai ', assistModel: ' gpt-5.6-sol ' })
  assert.equal(cleaned.assistProvider, 'openai')
  assert.equal(cleaned.assistModel, 'gpt-5.6-sol')
})

test('DualModelStore：缺失文件时 load 回退默认，不抛错', async () => {
  const store = new DualModelStore(join(tmpdir(), 'dual-model-absent-dir-xyz'))
  assert.deepEqual(await store.load(), { ...DEFAULT_CONFIG })
})

test('DualModelStore：save → load 往返一致，且未知字段不入库', async () => {
  const dir = join(tmpdir(), `dual-model-test-${process.pid}`)
  try {
    const store = new DualModelStore(dir)
    const saved = await store.save({ enabled: true, assistProvider: ' x ', assistModel: 'y', junk: 1 })
    assert.deepEqual(saved, { enabled: true, assistProvider: 'x', assistModel: 'y' })
    assert.deepEqual(await store.load(), { enabled: true, assistProvider: 'x', assistModel: 'y' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('DualModelStore：磁盘内容损坏时 load 回退默认而非抛错', async () => {
  const dir = join(tmpdir(), `dual-model-corrupt-${process.pid}`)
  try {
    const store = new DualModelStore(dir)
    await store.save({ enabled: true, assistProvider: 'p', assistModel: 'm' })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(store.file, '{ this is not json', 'utf8')
    assert.deepEqual(await store.load(), { ...DEFAULT_CONFIG })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
