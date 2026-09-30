// ledger-dir.test.mjs — I1 账本目录身份闸门（2026-09-30）
//
// 钉住的纪律（回归矩阵台账 I1 原话：「2026-09-29 已用 LEDGER_DIR_NAME 解耦但**无闸门**」）：
//   ① **目录名冻结为历史值** —— 改这个字符串 = 所有既有账本对新版本不可见，
//      用户看到统计凭空清零（静默失效第 17 位：不报错、界面正常、数字归零）；
//   ② **目录身份与包身份无派生关系** —— 本模块不读 package.json / 不读插件名，
//      故「包名加 scope / 改名」在物理上不可能影响目录（2026-09-29 的真实事故面）；
//   ③ 宿主服务三种形态与优先级、异常回退都落到同一个目录名。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { LEDGER_DIR_NAME, PROFILE_SOURCES, resolveDataDir, resolveProfileKey, safeProfileDir } from '../lib/ledger-dir.js'

const USAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 造一个只回应指定服务的 ctx stub。 */
function ctxOf(services) {
  return { get: (k) => services[k] }
}

test('I1：目录名冻结为历史值 —— 改名等于让既有账本全部失联', () => {
  // 刻意写死字面量：这条断言的作用就是「有人想改时会被拦下」。
  // 真要改目录名，必须同时给出历史账本的搬迁方案（否则用户看到统计清零）。
  assert.equal(LEDGER_DIR_NAME, 'dsh-token-monitor')
  assert.equal(LEDGER_DIR_NAME.includes('/'), false, '目录名不得含 /（含 scope 的包名会被 path.join 当两级）')
  assert.equal(LEDGER_DIR_NAME.startsWith('@'), false, '目录名不得带 scope')
})

test('I1：目录身份与包身份无派生关系（模块不读 package.json / 不读插件名）', () => {
  const src = readFileSync(join(USAGE_DIR, 'lib', 'ledger-dir.js'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/package\.json/.test(code), false, '不得从 package.json 派生目录名')
  assert.equal(/\bname\b\s*[),\]}]/.test(code), false, '不得把插件名变量拼进路径')
  assert.equal(/from\s+['"][^'"]*package\.json/.test(code), false, '不得 import package.json')

  // 反向佐证：包名确实带 scope，而目录名不带 —— 两者形态上就不可能相等
  const pkg = JSON.parse(readFileSync(join(USAGE_DIR, 'package.json'), 'utf8'))
  assert.ok(pkg.name.startsWith('@'), '当前包名带 scope（这正是当初必须解耦的原因）')
  assert.notEqual(LEDGER_DIR_NAME, pkg.name, '目录名绝不能等于完整包名')
})

test('I1：宿主服务三形态都落到同一个目录名（字符串 / resolve / dir）', () => {
  const base = join('C:', 'tmp', 'base')
  assert.equal(resolveDataDir(ctxOf({ pluginData: base })), join(base, LEDGER_DIR_NAME))
  assert.equal(resolveDataDir(ctxOf({ dataDir: base })), join(base, LEDGER_DIR_NAME))
  assert.equal(resolveDataDir(ctxOf({ storage: base })), join(base, LEDGER_DIR_NAME))
  assert.equal(
    resolveDataDir(ctxOf({ pluginData: { resolve: (n) => join(base, 'via-resolve', n) } })),
    join(base, 'via-resolve', LEDGER_DIR_NAME),
  )
  assert.equal(
    resolveDataDir(ctxOf({ pluginData: { dir: join(base, 'via-dir') } })),
    join(base, 'via-dir', LEDGER_DIR_NAME),
  )
})

test('I1：优先级 pluginData > dataDir > storage（宿主版本差异不留歧义）', () => {
  const r = resolveDataDir(ctxOf({
    pluginData: join('C:', 'a'),
    dataDir: join('C:', 'b'),
    storage: join('C:', 'c'),
  }))
  assert.equal(r, join('C:', 'a', LEDGER_DIR_NAME))
})

test('I1：服务缺失 / 取服务抛错 ⇒ 回退默认路径（不因宿主异常丢账本）', () => {
  const fallback = join(homedir(), '.dsh', 'plugins-data', LEDGER_DIR_NAME)
  assert.equal(resolveDataDir(ctxOf({})), fallback)
  assert.equal(resolveDataDir({ get: () => { throw new Error('无此服务') } }), fallback)
  assert.equal(resolveDataDir(ctxOf({ pluginData: '' })), fallback, '空字符串不算有效服务')
  assert.equal(
    resolveDataDir(ctxOf({ pluginData: { resolve: () => null } })),
    fallback,
    'resolve 返回空值不算命中',
  )
})

// ---------------------------------------------------------------------------
// 静默失效 #18：拿不到 profile 名时**不再假装隔离**
//
// 此前 resolveProfileName 返回裸字符串 `'default'`，页面于是照常宣称
// 「本页只统计当前 profile（default）· 与其它 profile 的账本完全隔离」——
// 而那个桶是**共享兜底区**：宿主既没给 profileContext、环境也没有 DSH_PROFILE 时，
// 多个不同环境会写进同一个桶。用户以为干净、实际混账，且不报任何错。
// ---------------------------------------------------------------------------

test('#18：profileContext 优先，且 name 前后空白被去掉', () => {
  const key = resolveProfileKey(ctxOf({ profileContext: { name: '  miasaki  ' } }), {})
  assert.equal(key.name, 'miasaki')
  assert.equal(key.source, 'profileContext')
})

test('#18：服务缺席时用环境变量 DSH_PROFILE（launcher 注入档）', () => {
  const key = resolveProfileKey(ctxOf({}), { DSH_PROFILE: 'web' })
  assert.equal(key.name, 'web')
  assert.equal(key.source, 'env')
})

test('#18：三档都拿不到 ⇒ name=default 但 source=unknown（不假装是真实 profile）', () => {
  // 注：env 一律**显式**传表 —— 省略时函数会用 `process.env`（这是生产路径的正确行为：
  // index.js 就是这么调的），但那会让本用例依赖「运行环境里恰好有没有 DSH_PROFILE」。
  // 首版就踩了这个：本机跑在桌面端里、环境里带 DSH_PROFILE，用例拿到 'desktop' 而失败。
  const cases = [
    [ctxOf({}), {}],
    [ctxOf({ profileContext: { name: '   ' } }), { DSH_PROFILE: '  ' }],
    [{ get: () => { throw new Error('无此服务') } }, {}],
    [ctxOf({ profileContext: { name: 42 } }), { DSH_PROFILE: 7 }],
  ]
  for (const [ctx, env] of cases) {
    const key = resolveProfileKey(ctx, env)
    assert.equal(key.name, 'default', '目录仍是 default（既有账本不能丢）')
    assert.equal(key.source, 'unknown', '来源必须如实标 unknown —— 页面据此说明「可能混账」')
  }
  assert.deepEqual([...PROFILE_SOURCES], ['profileContext', 'env', 'unknown'])
})

test('#18：safeProfileDir 是安全边界 —— 含斜杠的输入不得逃出账本根目录', () => {
  assert.equal(safeProfileDir('@miasaki/dsh-x'), '_miasaki_dsh-x', '斜杠必须净化（否则 path.join 会多一级）')
  assert.equal(safeProfileDir('../../etc'), '.._.._etc', '不得产生可逃逸的路径')
  assert.equal(safeProfileDir('../evil'), '.._evil')
  assert.equal(safeProfileDir(''), 'default')
  assert.equal(safeProfileDir(null), 'default')
  assert.equal(safeProfileDir('desktop'), 'desktop', '正常名原样保留')
})
