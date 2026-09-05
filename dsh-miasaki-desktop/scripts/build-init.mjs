// build-init.mjs — 把 themes/*.css 内联进运行时，产出 src-tauri/injected/theme-init.js
// 并执行令牌完备性校验（每个非 pure 主题必须覆盖 design/token-surface.txt 中的全部令牌）。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
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
  const p = join(root, 'themes', `${t}.css`)
  if (!existsSync(p)) {
    console.error(`[build-init] 缺少主题文件: ${p}`)
    process.exit(1)
  }
  styles[t] = readFileSync(p, 'utf8')
}

// 令牌完备性校验
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
  const css = styles[t]
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
// D1: themes/src/ 按 MANIFEST 顺序拼接为运行时（source of truth）；
// 缺失时回退到 legacy themes/runtime.js（保持旧链路可用）。
if (existsSync(RUNTIME_MANIFEST) && existsSync(join(RUNTIME_SRC_DIR, '00-boot.js'))) {
  const manifest = JSON.parse(readFileSync(RUNTIME_MANIFEST, 'utf8'))
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
  console.log(`[build-init] runtime from themes/src/ (${manifest.order.length} 片)`)
} else {
  runtime = readFileSync(join(root, 'themes', 'runtime.js'), 'utf8')
  console.log('[build-init] runtime from legacy themes/runtime.js（回退）')
}
const bundle =
  `/* 由 scripts/build-init.mjs 生成，勿手改 */\n` +
  `window.__MIASAKI_STYLES__=${JSON.stringify(styles)};\n${runtime}`

const outDir = join(root, 'src-tauri', 'injected')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'theme-init.js')
writeFileSync(outPath, bundle, 'utf8')

const kb = Math.round(Buffer.byteLength(bundle) / 1024)
console.log(`[build-init] ok → src-tauri/injected/theme-init.js (${kb} KB)，令牌校验通过`)
