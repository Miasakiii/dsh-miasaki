// make-inverse-sheet.mjs — 把 inverse/states 三态立绘拼成横排 spritesheet(png + webp),
// 补齐 Codex 风格宠物包结构(与 whale/kurumi 一致;运行时仍由 frames.json 驱动,此文件仅供 manifest 引用/预览)
// 用法:node scripts/make-inverse-sheet.mjs  (在 desktop 目录)
import sharp from 'sharp'
import { join } from 'node:path'

const inv = join(process.cwd(), 'ui', 'pets', 'inverse')
const statesDir = join(inv, 'states')

const names = ['idle', 'work', 'deep']
const metas = []
for (const n of names) {
  metas.push(await sharp(join(statesDir, `${n}.png`)).metadata())
}

const totalW = metas.reduce((s, m) => s + m.width, 0)
const maxH = Math.max(...metas.map((m) => m.height))

let x = 0
const inputs = []
for (let i = 0; i < names.length; i++) {
  inputs.push({ input: join(statesDir, `${names[i]}.png`), left: x, top: maxH - metas[i].height })
  x += metas[i].width
}

const base = sharp({
  create: { width: totalW, height: maxH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
await base.clone().composite(inputs).png().toFile(join(inv, 'spritesheet.png'))
await base.clone().composite(inputs).webp({ lossless: true }).toFile(join(inv, 'spritesheet.webp'))
console.log(`[make-inverse-sheet] ${totalW}x${maxH} -> spritesheet.png / spritesheet.webp`)
