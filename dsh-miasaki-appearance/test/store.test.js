import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppearanceStore } from '../lib/store.js'
import { CONFIG_VERSION, DEFAULT_CONFIG, sanitizeConfig } from '../lib/config.js'

/** 建一个用完即删的临时数据目录。 */
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mia-appearance-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('load：配置文件不存在时回退出厂配置', async () => {
  await withTempDir(async (dir) => {
    const store = new AppearanceStore(dir)
    assert.equal(store.persistent, true)
    assert.deepEqual(await store.load(), sanitizeConfig(DEFAULT_CONFIG))
  })
})

test('save → load：往返一致且磁盘格式可读', async () => {
  await withTempDir(async (dir) => {
    const store = new AppearanceStore(dir)
    const saved = await store.save({ enabled: true, theme: { skin: 'zafkiel' } })
    assert.equal(saved.enabled, true)
    assert.equal(saved.theme.skin, 'zafkiel')

    const raw = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
    assert.equal(raw.enabled, true)
    assert.equal(raw.theme.skin, 'zafkiel')
    assert.equal(raw.version, CONFIG_VERSION) // M2 S5 起 v2；M2.5 的 avatar 板块抬到 v3；2026-09-26 去重抬到 v4

    assert.deepEqual(await store.load(), saved)
  })
})

test('save：落盘前归一化（非法值不进入磁盘）', async () => {
  await withTempDir(async (dir) => {
    const store = new AppearanceStore(dir)
    await store.save({
      theme: { skin: '不存在的皮肤', scheme: 'dark', accent: '红色', fontSize: 999 },
      wallpaper: { source: 'javascript:x' },
    })
    const raw = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
    // 2026-09-26 去重：scheme / accent / fontSize 已移除，非法皮肤名白名单回退
    assert.deepEqual(raw.theme, { skin: 'pure' })
    assert.equal(raw.wallpaper.source, '')
  })
})

test('load：磁盘内容损坏时回退默认，不抛异常', async () => {
  await withTempDir(async (dir) => {
    const store = new AppearanceStore(dir)
    await writeFile(join(dir, 'config.json'), '{ 半截 JSON', 'utf8')
    assert.deepEqual(await store.load(), sanitizeConfig(DEFAULT_CONFIG))
  })
})

test('load：磁盘上是数组／标量时同样回退', async () => {
  await withTempDir(async (dir) => {
    const store = new AppearanceStore(dir)
    await writeFile(join(dir, 'config.json'), '"just a string"', 'utf8')
    assert.deepEqual(await store.load(), sanitizeConfig(DEFAULT_CONFIG))
  })
})

test('无 dataDir：降级为不落盘，save 仍返回归一化结果', async () => {
  const store = new AppearanceStore(undefined)
  assert.equal(store.persistent, false)
  assert.deepEqual(await store.load(), sanitizeConfig(DEFAULT_CONFIG))
  const saved = await store.save({ enabled: true })
  assert.equal(saved.enabled, true, '内存态仍然可用，只是不落盘')
})

test('dataDir 为空串时同样降级', () => {
  assert.equal(new AppearanceStore('   ').persistent, false)
})
