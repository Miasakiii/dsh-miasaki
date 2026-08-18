// recolor-inverse.mjs — 反转狂三立绘：像素级重着色（真正的白发形态）
// 黑发/轮廓(L<70) → 银白；红色系保留并加深为血绯；其余 → 苍白化
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'ui', 'pets', 'inverse')
mkdirSync(outDir, { recursive: true })
const src = join(root, 'ui', 'pets', 'kurumi', 'spritesheet.png')

const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true })
const out = Buffer.alloc(data.length)
for (let i = 0; i < data.length; i += info.channels) {
  const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
  if (a < 16) { out[i + 3] = 0; continue }
  out[i + 3] = a
  const L = 0.299 * r + 0.587 * g + 0.114 * b
  if (L < 70) {
    // 黑发/轮廓 → 银白（带冷调）
    const n = Math.round(255 - (70 - L) * 1.2)
    out[i] = Math.min(255, n)
    out[i + 1] = Math.min(255, Math.round(n * 0.98))
    out[i + 2] = Math.min(255, Math.round(n * 1.04))
  } else if (r > 140 && r > g * 1.4 && r > b * 1.4) {
    // 红（瞳/发饰）→ 血绯加深
    out[i] = Math.round(r * 0.85)
    out[i + 1] = Math.round(g * 0.5)
    out[i + 2] = Math.round(b * 0.5)
  } else {
    // 皮肤/衣物 → 苍白化
    out[i] = Math.min(255, Math.round(r * 0.5 + 127))
    out[i + 1] = Math.min(255, Math.round(g * 0.5 + 125))
    out[i + 2] = Math.min(255, Math.round(b * 0.5 + 128))
  }
}
await sharp(out, { raw: { width: info.width, height: info.height, channels: info.channels } })
  .png()
  .toFile(join(outDir, 'spritesheet.png'))
console.log('inverse spritesheet.png done')
