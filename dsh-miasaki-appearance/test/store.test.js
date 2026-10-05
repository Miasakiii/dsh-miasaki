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

// ---------------------------------------------------------------------------
// 读时迁移回写（2026-10-05）
//
// 事故形态：v6 配置在内存里被 sanitize 抬到 v7，但**不回写磁盘**；而跨线消费端
// `dsh-miasaki-desktop/src-tauri/src/boot_intro.rs` 直接读该文件 ⇒ 永远看不到 `boot`
// 板块 ⇒ 片头永远不播，且用户不动一次面板（唯一会走 save 的路径）就永远修不好。
// 因此这里的判据一律落在**磁盘**上，不是内存态。

/** v6 形态的旧配置（`boot` 板块存在之前的样子）。 */
function v6Config() {
  return {
    version: 6,
    enabled: true,
    theme: { skin: 'pure' },
    wallpaper: { source: 'builtin:aurora', blur: 0, scrim: 20, fit: 'cover', focus: 'center', glass: 'light', vignette: 10 },
    motion: { enabled: true, preset: 'elegant', scale: 1, bootSplash: 'auto' },
    conversation: { density: 'comfortable', maxWidth: 0, font: 'system', cursor: 'off', quoteCode: 'default' },
  }
}

test('loadWithMigration：v6 旧配置抬到 v7 并回写磁盘 —— 桌面壳能读到 boot 板块', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'config.json')
    await writeFile(file, JSON.stringify(v6Config()), 'utf8')
    const store = new AppearanceStore(dir)

    const { config, migrated, error } = await store.loadWithMigration()
    assert.equal(migrated, true, 'v6 必须被判定为需要迁移')
    assert.equal(error, null)
    assert.equal(config.version, CONFIG_VERSION)
    assert.deepEqual(config.boot, { intro: 'brand', audio: false }, '内存态补出厂档')

    // 事故判据：**磁盘**上必须出现 boot 板块（壳侧只读盘，看不见内存态）。
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.version, CONFIG_VERSION, '版本号必须落盘')
    assert.deepEqual(raw.boot, { intro: 'brand', audio: false }, 'boot 板块必须落盘')
    assert.equal(raw.enabled, true, '迁移不得丢弃用户已有字段（总开关是片头门控）')
    assert.equal(raw.theme.skin, 'pure')
    assert.equal(raw.motion.bootSplash, 'auto')
  })
})

test('loadWithMigration：盘上已是当前版本 ⇒ 不写盘', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'config.json')
    // 塞一个 sanitize 不认识的字段：若真发生写盘，它会被丢弃 ⇒ 文本必变
    // （比 mtime 更硬的判据，且不受文件系统时间戳精度影响）。
    await writeFile(file, JSON.stringify({ ...sanitizeConfig(DEFAULT_CONFIG), unknownField: 1 }), 'utf8')
    const before = await readFile(file, 'utf8')
    const store = new AppearanceStore(dir)

    const { migrated, error } = await store.loadWithMigration()
    assert.equal(migrated, false, '当前版本不触发迁移')
    assert.equal(error, null)
    assert.equal(await readFile(file, 'utf8'), before, '磁盘文本必须逐字节不变')
  })
})

test('loadWithMigration：磁盘内容损坏 / 非对象 ⇒ 回退默认且不写盘', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'config.json')
    for (const broken of ['{ 半截 JSON', '"just a string"', '[1, 2, 3]']) {
      await writeFile(file, broken, 'utf8')
      const store = new AppearanceStore(dir)
      const { config, migrated, error } = await store.loadWithMigration()
      assert.deepEqual(config, sanitizeConfig(DEFAULT_CONFIG), `${broken} 必须回退默认`)
      assert.equal(migrated, false, `${broken} 不构成「旧版本迁移」`)
      assert.equal(error, null)
      assert.equal(await readFile(file, 'utf8'), broken, `${broken} 原样留在盘上（不覆写损坏文件）`)
    }
  })
})

test('loadWithMigration：无 dataDir ⇒ 不落盘、不报错', async () => {
  const store = new AppearanceStore(undefined)
  const { config, migrated, error } = await store.loadWithMigration()
  assert.equal(migrated, false)
  assert.equal(error, null)
  assert.deepEqual(config, sanitizeConfig(DEFAULT_CONFIG))
})

// 说明：**「回写失败」刻意没有用例** —— 让「读得到、写不进」在 Windows 与 Linux 上
// 同时可靠复现需要改目录 ACL / 只读位，两平台语义不同（POSIX 目录权限 vs Windows
// 只读属性），硬造会得到一个在 CI 上假绿的测试。该分支的实现保证是「不抛、把原因
// 交回调用方」，由 index.js 记入 logger.error（`lib/store.js` 的 loadWithMigration）。
