// build-init.mjs — 把 themes/*.css 内联进运行时，产出 src-tauri/injected/theme-init.js
// 并执行令牌完备性校验（每个非 pure 主题必须覆盖 design/token-surface.txt 中的全部令牌）。
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const THEMES = ['pure', 'zafkiel', 'kurkuriel']
// 非颜色/无需覆盖的令牌
const EXCLUDED = new Set(['--dsh-scrollbar-width'])

// 宠物图集 webp → png（WebView2 对 PNG 的半透明合成更稳）
for (const pet of ['whale', 'kurumi']) {
  const src = join(root, 'ui', 'pets', pet, 'spritesheet.webp')
  const dst = join(root, 'ui', 'pets', pet, 'spritesheet.png')
  if (existsSync(src)) {
    await sharp(src).png().toFile(dst)
    console.log(`[build-init] ${pet} atlas -> png`)
  }
}

const styles = {}
for (const t of THEMES) {
  // M2 S2 起，非 pure 主题拆为 skin（配色，让位协议下可停注入）+ deco（装饰，恒注入）。
  // pure 语义是"不覆盖任何 token"，无 skin 层。
  if (t === 'pure') {
    const p = join(root, 'themes', `${t}.css`)
    if (!existsSync(p)) {
      console.error(`[build-init] 缺少主题文件: ${p}`)
      process.exit(1)
    }
    styles[t] = { skin: '', deco: readFileSync(p, 'utf8') }
    continue
  }
  const skinPath = join(root, 'themes', `${t}.skin.css`)
  const decoPath = join(root, 'themes', `${t}.deco.css`)
  for (const p of [skinPath, decoPath]) {
    if (!existsSync(p)) {
      console.error(`[build-init] 缺少主题文件: ${p}`)
      process.exit(1)
    }
  }
  styles[t] = { skin: readFileSync(skinPath, 'utf8'), deco: readFileSync(decoPath, 'utf8') }
}

// 令牌完备性校验（只作用于配色层 *.skin.css——deco 不含色阶）
const surfacePath = join(root, 'design', 'token-surface.txt')
if (!existsSync(surfacePath)) {
  console.error('[build-init] 缺少 design/token-surface.txt，无法执行令牌完备性校验')
  process.exit(1)
}
const surface = readFileSync(surfacePath, 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((n) => !EXCLUDED.has(n))

for (const t of ['zafkiel', 'kurkuriel']) {
  const css = styles[t].skin
  const missing = surface.filter((n) => !css.includes(`${n}:`))
  if (missing.length > 0) {
    console.error(`[build-init] ${t}.css 缺少令牌定义 (${missing.length}):`)
    for (const n of missing) console.error(`  ${n}`)
    process.exit(1)
  }
}

const RUNTIME_SRC_DIR = join(root, 'themes', 'src')
const RUNTIME_MANIFEST = join(RUNTIME_SRC_DIR, 'MANIFEST.json')
let runtime = ''
let runtimeSliceCount = 0
// D1: themes/src/ 按 MANIFEST 顺序拼接为运行时（source of truth）；
// 缺失时回退到 legacy themes/runtime.js（保持旧链路可用）。
if (existsSync(RUNTIME_MANIFEST) && existsSync(join(RUNTIME_SRC_DIR, '00-boot.js'))) {
  const manifest = JSON.parse(readFileSync(RUNTIME_MANIFEST, 'utf8'))
  // W0-T0.4：order 是拼接事实源，漏登记即「静默不打包」——空/缺失直接判失败，不产出半成品
  if (!Array.isArray(manifest.order) || manifest.order.length === 0) {
    console.error('[build-init] MANIFEST.order 缺失或为空，拒绝生成产物')
    process.exit(1)
  }
  const parts = []
  for (const f of manifest.order) {
    const p = join(RUNTIME_SRC_DIR, f)
    if (!existsSync(p)) {
      console.error(`[build-init] 缺少运行时分片: ${p}`)
      process.exit(1)
    }
    parts.push(readFileSync(p, 'utf8'))
  }
  runtime = parts.join('')
  runtimeSliceCount = parts.length
  console.log(`[build-init] runtime from themes/src/ (${manifest.order.length} 片)`)
} else {
  runtime = readFileSync(join(root, 'themes', 'runtime.js'), 'utf8')
  console.log('[build-init] runtime from legacy themes/runtime.js（回退）')
}

// ---------------------------------------------------------------------------
// W0-T0.4（2026-09-25）产物自校验。
// 由来：官方同类 manifest 曾出现「尾部 `}` 被条目 size 截断」却仍被打包分发，
// 随包 JSON 用 JSON.parse 直接失败（见
// dsh-miasaki-shared-docs/dsh-platform/dsh-official-desktop-analysis-2026-09-25.md §1.2）。
// 本产物是「JSON 字面量 + JS 分片」拼接而成，同样存在结构错位而构建照常通过的风险。
// 三道：① 样式 JSON 可解析且键集 == THEMES；② 分片数 == MANIFEST.order；③ 写盘字节一致。
// ---------------------------------------------------------------------------
const stylesJson = JSON.stringify(styles)
try {
  const reparsed = JSON.parse(stylesJson)
  const got = Object.keys(reparsed).sort().join(',')
  const want = [...THEMES].sort().join(',')
  if (got !== want) {
    console.error(`[build-init] 自校验失败：样式键集 [${got}] ≠ 主题集 [${want}]`)
    process.exit(1)
  }
} catch (e) {
  console.error(`[build-init] 自校验失败：样式 JSON 不可解析 — ${e.message}`)
  process.exit(1)
}
// 漏登记防护（W0-T0.4）：拼接**只**按 MANIFEST.order，目录里新增分片若忘了登记，
// 旧实现会静默不打包（回归面裸奔）——这里改为显式判失败。
if (runtimeSliceCount > 0) {
  const declared = JSON.parse(readFileSync(RUNTIME_MANIFEST, 'utf8')).order
  const onDisk = readdirSync(RUNTIME_SRC_DIR).filter((f) => f.endsWith('.js'))
  const unregistered = onDisk.filter((f) => !declared.includes(f))
  if (unregistered.length > 0) {
    console.error(
      `[build-init] 自校验失败：themes/src 下存在未登记进 MANIFEST.order 的分片: ${unregistered.join(', ')}`
    )
    process.exit(1)
  }
}

const bundle =
  `/* 由 scripts/build-init.mjs 生成，勿手改 */\n` +
  `window.__MIASAKI_STYLES__=${stylesJson};\n${runtime}`

const outDir = join(root, 'src-tauri', 'injected')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'theme-init.js')
writeFileSync(outPath, bundle, 'utf8')

// 写盘后回读：字节数一致才认为产物完整（截断 / 编码异常在此拦截）
const expectedBytes = Buffer.byteLength(bundle, 'utf8')
const written = readFileSync(outPath)
if (written.length !== expectedBytes) {
  console.error(`[build-init] 自校验失败：写盘字节 ${written.length} ≠ 期望 ${expectedBytes}`)
  process.exit(1)
}

const kb = Math.round(written.length / 1024)
console.log(
  `[build-init] ok → src-tauri/injected/theme-init.js (${kb} KB)，令牌校验通过，` +
  `自校验通过（${runtimeSliceCount > 0 ? `${runtimeSliceCount} 片` : 'legacy 单文件'}）`
)
