// 皮肤 token 表契约测试（M2 S3）。
// 断言对象是**产物**（lib/skins/*.js）而非派生过程——derive-skins.mjs 的四条校验保证生成时
// 正确，本文件保证产物入库后不被手改/过期（配合 `derive-skins.mjs --check` 双保险）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const zafkiel = await import('../lib/skins/zafkiel.js')
const kurkuriel = await import('../lib/skins/kurkuriel.js')

const EXPECTED_COUNT = 105 // static 73 + 品牌 alias 1 + 组件自有 25 + 半透明 alias 6（M2 设计 §2）

test('两皮肤模块导出形状：name / meta / tokens', () => {
  for (const mod of [zafkiel, kurkuriel]) {
    assert.equal(typeof mod.name, 'string')
    assert.equal(mod.meta.id, mod.name)
    assert.equal(typeof mod.meta.label, 'string')
    assert.ok(['dark', 'light'].includes(mod.meta.preferredScheme))
    assert.equal(typeof mod.tokens, 'object')
  }
  assert.equal(zafkiel.meta.preferredScheme, 'dark')
  assert.equal(kurkuriel.meta.preferredScheme, 'light')
})

test('token 数量恰为 105，且两皮肤键集合一致', () => {
  const z = Object.keys(zafkiel.tokens)
  const k = Object.keys(kurkuriel.tokens)
  assert.equal(z.length, EXPECTED_COUNT)
  assert.equal(k.length, EXPECTED_COUNT)
  assert.deepEqual([...z].sort(), [...k].sort(), '两皮肤的 token 键集合必须一致（消费端按同一结构驱动）')
})

test('每个值都是 {light,dark} 同值字符串对（overrideTokens 直接可吃）', () => {
  for (const mod of [zafkiel, kurkuriel]) {
    for (const [name, pair] of Object.entries(mod.tokens)) {
      assert.equal(typeof pair, 'object', name)
      assert.deepEqual(Object.keys(pair).sort(), ['dark', 'light'], name)
      assert.equal(typeof pair.light, 'string', name)
      assert.ok(pair.light.length > 0, name)
      assert.equal(pair.light, pair.dark, `${name}: static 明度中立，应为同值对（M2 §1.4）`)
    }
  }
})

test('值不残留 var() 引用（品牌 alias 重定向已在编译期替换）', () => {
  for (const mod of [zafkiel, kurkuriel]) {
    for (const [name, pair] of Object.entries(mod.tokens)) {
      assert.doesNotMatch(pair.light, /var\(/, name)
    }
  }
  // 品牌重定向应等于皮肤 deepseek-450 色阶值
  assert.equal(zafkiel.tokens['--dsw-alias-brand-primary-new-colorprimary-new-color'].light, '#c23a2e')
  assert.equal(kurkuriel.tokens['--dsw-alias-brand-primary-new-colorprimary-new-color'].light, '#9e1b1b')
})

test('黑名单（初版 C 类中性 alias）不得出现在任何皮肤', () => {
  const forbidden = [
    '--dsw-alias-bg-mask-1', '--dsw-alias-bg-mask-2', '--dsw-alias-bg-mask-3', '--dsw-alias-bg-mask-photo',
    '--dsw-alias-bg-skeleton', '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l3',
    '--dsw-alias-border-l4', '--dsw-alias-interactive-bg-active', '--dsw-alias-interactive-bg-hover',
  ]
  for (const mod of [zafkiel, kurkuriel]) {
    for (const f of forbidden) assert.equal(f in mod.tokens, false, f)
  }
})

test('代表性端点值正确（皮肤可辨识性的最低断言）', () => {
  // zafkiel 墨夜 / kurkuriel 骨白（与 desktop verify-themes 的令牌断言同源）
  assert.equal(zafkiel.tokens['--dsw-static-neutral-bluish-950'].light, '#0c0b11')
  assert.equal(zafkiel.tokens['--dsw-static-neutral-bluish-50'].light, '#f1edf6')
  assert.equal(kurkuriel.tokens['--dsw-static-neutral-bluish-50'].light, '#fcfaf8')
  assert.equal(kurkuriel.tokens['--dsw-static-neutral-bluish-950'].light, '#0f0d0b')
  // 半透明 alias（壁纸参数层的默认档）
  assert.match(zafkiel.tokens['--dsw-alias-bg-base'].light, /rgba\(12, 11, 17, \.8\)/)
})

test('产物未被手改：与 derive-skins 重算一致（--check 的测试侧等价）', async () => {
  // 轻量校验：产物文件头声明生成器 + tokens 键序稳定（字典序）。
  // 全量 diff 由 verify-all 的 `derive-skins --check` 项负责，这里防的是"单测被单独跑"的路径。
  for (const id of ['zafkiel', 'kurkuriel']) {
    const src = await readFile(fileURLToPath(new URL(`../lib/skins/${id}.js`, import.meta.url)), 'utf8')
    assert.match(src, /由 scripts\/derive-skins\.mjs 生成/)
    const keys = Object.keys(JSON.parse(src.slice(src.indexOf('tokens = ') + 9, src.lastIndexOf('}') + 1)))
    assert.deepEqual(keys, [...keys].sort(), `${id}: tokens 必须按字典序排列（可复算纪律）`)
  }
})
