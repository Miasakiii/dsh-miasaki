// diff-tokens.mjs — DSH 令牌面漂移报告（D4，只告警不阻塞）
// 对比 design/token-surface.txt × themes/{zafkiel,kurkuriel}.css：
//   缺失 = surface 有而 css 无（build-init 已强制失败，此处复述定位行）
//   死覆盖 = css 定义了 surface 之外的 --dsw-*/--dsh-*/--dsl-* 令牌（rc.x 失效残留，无害但需定期清理）
// 用法：node scripts/diff-tokens.mjs
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const EXCLUDED = new Set(['--dsh-scrollbar-width'])
const surface = new Set(
  readFileSync(join(root, 'design', 'token-surface.txt'), 'utf8')
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((n) => !EXCLUDED.has(n))
)
const tokenRe = /(--(?:dsw|dsh|dsl)[\w-]*)\s*:/g
let deadTotal = 0
for (const t of ['zafkiel', 'kurkuriel']) {
  const p = join(root, 'themes', `${t}.css`)
  if (!existsSync(p)) { console.error(`[diff-tokens] 缺少 ${p}`); process.exit(2) }
  const css = readFileSync(p, 'utf8')
  const missing = [...surface].filter((n) => !css.includes(`${n}:`))
  const defined = new Set([...css.matchAll(tokenRe)].map((m) => m[1]))
  // 死覆盖仅判 static 色阶（主题覆盖主体）；--dsw-alias-*/--dsh-* 系标题栏融合有意引用，不在此列
  const dead = [...defined].filter((n) => n.startsWith('--dsw-static-') && !surface.has(n)).sort()
  const aliasExtra = [...defined].filter((n) => !n.startsWith('--dsw-static-') && !surface.has(n) && !EXCLUDED.has(n)).sort()
  deadTotal += dead.length
  console.log(`[diff-tokens] ${t}: surface=${surface.size} defined=${defined.size} 缺失=${missing.length} 死覆盖=${dead.length} alias外覆=${aliasExtra.length}`)
  for (const n of missing) console.log(`  MISSING ${n}`)
  for (const n of dead) console.log(`  DEAD ${n}（static 色阶外覆盖，rc.x 失效残留？）`)
  for (const n of aliasExtra) console.log(`  ALIAS ${n}（非 surface alias 融合引用，属设计意图，忽略）`)
}
console.log(deadTotal ? `[diff-tokens] 提示：清理死覆盖前先真机确认 DSH 新版是否恢复该令牌` : '[diff-tokens] 无漂移')
