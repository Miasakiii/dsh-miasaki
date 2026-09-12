// derive-skins.mjs — 把 desktop 线的 `*.skin.css` 编译为 appearance 线的皮肤 token 表。
//
// M2 S3（设计文档 §2 修正版）：官方全部 token 声明在 body 上（appearance M2 §1.1/§1.2），
// body inline 覆盖 static 可回溯影响 alias —— 因此皮肤 = skin.css 的**直接编译**
// （{light,dark} 同值对），无需任何 alias 派生。
//
// 输入：dsh-miasaki-desktop/themes/{zafkiel,kurkuriel}.skin.css
// 输出：lib/skins/{zafkiel,kurkuriel}.js（ESM：name / meta / tokens）
// 纪律：fail-closed——四条校验任一失败即退出非零；产物可复算（--check 模式 diff 一致性）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const desktopThemes = join(root, '..', 'dsh-miasaki-desktop', 'themes')
const surfacePath = join(root, '..', 'dsh-miasaki-desktop', 'design', 'token-surface.txt')
const outDir = join(root, 'lib', 'skins')

const SKINS = [
  { id: 'zafkiel', label: '刻刻帝', preferredScheme: 'dark' },
  { id: 'kurkuriel', label: '狂狂帝', preferredScheme: 'light' },
]

// 初版 C 类 18 个中性 alias（M2 设计 §2 黑名单）——它们是官方明暗自适应值，皮肤不得覆盖。
const FORBIDDEN = [
  '--dsw-alias-bg-mask-1', '--dsw-alias-bg-mask-2', '--dsw-alias-bg-mask-3', '--dsw-alias-bg-mask-photo',
  '--dsw-alias-bg-skeleton',
  '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l3', '--dsw-alias-border-l4',
  '--dsw-alias-border-inverted', '--dsw-alias-border-inverted-strong',
  '--dsw-alias-button-tool-bar-bg', '--dsw-alias-button-tool-bar-border', '--dsw-alias-button-tool-bar-item',
  '--dsw-alias-interactive-bg-active', '--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-hover-accent',
]

/** 解析一块 CSS 文本里的 `--token: value;` 对。 */
function parseTokens(css) {
  return Object.fromEntries(
    [...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()])
  )
}

/** 块提取：从 `sel {` 到配对 `}`（支持嵌套一层防护）。 */
function extractBlock(css, selectorPrefix) {
  const i = css.indexOf(selectorPrefix)
  if (i < 0) throw new Error(`找不到选择器块: ${selectorPrefix}`)
  const start = css.indexOf('{', i)
  let depth = 1, end = start + 1
  while (depth > 0 && end < css.length) {
    if (css[end] === '{') depth++
    if (css[end] === '}') depth--
    end++
  }
  return css.slice(start + 1, end - 1)
}

function buildSkin(id) {
  const css = readFileSync(join(desktopThemes, `${id}.skin.css`), 'utf8')
  // 主体块（static + 品牌 alias + 组件自有）：首个 `html[data-miasaki-theme="X"] {`；
  // 注意主体块选择器是双目标（第二行 `html[...] body {` 与尾块同文本），尾块必须取**最后一个**。
  const main = parseTokens(extractBlock(css, `html[data-miasaki-theme="${id}"]`))
  const translucent = parseTokens(extractBlock(css, lastIndex(css, `html[data-miasaki-theme="${id}"] body {`)))
  return mergeTokens(main, translucent)
}

/** 从指定偏移处提取块（避免同名选择器首现误命中）。 */
function lastIndex(css, needle) {
  const i = css.lastIndexOf(needle)
  if (i < 0) throw new Error(`找不到选择器块: ${needle}`)
  return css.slice(i)
}

// 品牌 alias 重定向：var(--dsw-static-X) → 皮肤色阶值（单层替换；声明顺序无关，map 已全量）
function mergeTokens(main, translucent) {
  for (const [name, value] of Object.entries(main)) {
    if (!value.startsWith('var(--dsw-static-')) continue
    const source = value.slice('var('.length, -1)
    if (main[source] === undefined) throw new Error(`品牌 alias ${name} 引用的 ${source} 不在本皮肤色阶表`)
    main[name] = main[source]
  }
  return { ...main, ...translucent }
}

function verify(id, tokens, surface) {
  const errors = []
  const keys = Object.keys(tokens)
  // ① desktop 完备性判据：token-surface.txt 全集（除 --dsh-scrollbar-width）都在输出中
  const missing = surface.filter(n => !keys.includes(n))
  const extraStatic = keys.filter(k => k.startsWith('--dsw-static-') && !surface.includes(k))
  if (missing.length) errors.push(`① surface 缺失 ${missing.length}: ${missing.slice(0, 5).join(', ')}…`)
  if (extraStatic.length) errors.push(`① surface 之外的 static: ${extraStatic.slice(0, 5).join(', ')}…`)
  // ② 值不残留 var( 引用
  const withVar = Object.entries(tokens).filter(([, v]) => v.includes('var('))
  if (withVar.length) errors.push(`② 残留 var() 引用: ${withVar.map(([k]) => k).join(', ')}`)
  // ③ 键集合 = 预期（static 73 + 品牌 1 + 组件自有 25 + 半透明 6 = 105）；黑名单不得出现
  if (keys.length !== 105) errors.push(`③ 键数量 ${keys.length} ≠ 105`)
  const bad = keys.filter(k => FORBIDDEN.includes(k))
  if (bad.length) errors.push(`③ 黑名单 token 出现: ${bad.join(', ')}`)
  // ④ 值均为合法字面
  const empty = Object.entries(tokens).filter(([, v]) => v === '' || v === undefined)
  if (empty.length) errors.push(`④ 空值: ${empty.map(([k]) => k).join(', ')}`)
  return errors
}

const surface = existsSync(surfacePath)
  ? readFileSync(surfacePath, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      .filter(n => n !== '--dsh-scrollbar-width') // 与 desktop build-init 同款 EXCLUDED（非颜色令牌）
  : null
if (!surface) {
  console.error(`[derive-skins] 缺少 ${surfacePath}`)
  process.exit(1)
}

const check = process.argv.includes('--check')
mkdirSync(outDir, { recursive: true })
let failed = false

for (const { id, label, preferredScheme } of SKINS) {
  try {
    const tokens = buildSkin(id)
    const errors = verify(id, tokens, surface)
    if (errors.length) {
      for (const e of errors) console.error(`[derive-skins] ${id} ${e}`)
      failed = true
      continue
    }
    // 稳定排序输出，保证产物可复算；{light,dark} 同值对——overrideTokens 直接可吃
    // （validateOverrides 只收双值对；static 明度中立 → 同值，见 M2 设计 §1.4/§2）
    const sorted = Object.fromEntries(
      Object.entries(tokens).sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, { light: v, dark: v }])
    )
    const header =
      `// 由 scripts/derive-skins.mjs 生成，勿手改；源 = dsh-miasaki-desktop/themes/${id}.skin.css\n` +
      `// 语义见 design/2026-09-12-appearance-m2-design.md §2：{light,dark} 同值对（static 明度中立，\n` +
      `// 明暗语义由官方 alias 端点选择承载；body inline 覆盖 static 可回溯 alias，§1.2 实机已证）。\n`
    const body =
      `export const name = ${JSON.stringify(id)}\n\n` +
      `export const meta = ${JSON.stringify({ id, label, preferredScheme }, null, 2)}\n\n` +
      `export const tokens = ${JSON.stringify(sorted, null, 2)}\n`
    const out = join(outDir, `${id}.js`)
    if (check) {
      if (!existsSync(out) || readFileSync(out, 'utf8') !== header + body) {
        console.error(`[derive-skins] ${id}: 产物与重算不一致（lib/skins/${id}.js 过期或被手改）`)
        failed = true
      } else {
        console.log(`[derive-skins] ${id}: --check 一致（105 token）`)
      }
    } else {
      writeFileSync(out, header + body)
      console.log(`[derive-skins] ${id}: 105 token → lib/skins/${id}.js`)
    }
  } catch (error) {
    console.error(`[derive-skins] ${id}: ${error.message}`)
    failed = true
  }
}

process.exit(failed ? 1 : 0)
