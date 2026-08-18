// cut-frames.mjs — 预切桌宠图集为逐帧 PNG + 帧清单（供原生分层窗口渲染）
// kurumi/inverse：按 Codex 行切帧（每行非空帧）；whale：立绘三态直接引用
import sharp from 'sharp'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const CELL_W = 192, CELL_H = 208
const ROW_NAMES = ['idle', 'runRight', 'runLeft', 'wave', 'jump', 'failed', 'wait', 'run', 'review']
// 渲染需要的行
const NEEDED = ['idle', 'wave', 'jump', 'run']

const manifest = { whale: { kind: 'states', states: {} }, kurumi: { kind: 'atlas', rows: {} }, inverse: { kind: 'atlas', rows: {} } }

async function cutAtlas(mode) {
  const src = join(root, 'ui', 'pets', mode, 'spritesheet.png')
  const outDir = join(root, 'ui', 'pets', mode, 'frames')
  mkdirSync(outDir, { recursive: true })
  const meta = await sharp(src).metadata()
  const rows = Math.floor(meta.height / CELL_H)
  const frames = {}
  for (const rowName of NEEDED) {
    const r = ROW_NAMES.indexOf(rowName)
    if (r >= rows) continue
    const cols = []
    for (let c = 0; c < 8; c++) {
      const buf = await sharp(src).extract({ left: c * CELL_W, top: r * CELL_H, width: CELL_W, height: CELL_H })
        .png().toBuffer()
      // 判定非空：alpha 覆盖
      const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
      let hits = 0
      for (let i = 3; i < data.length; i += 16 * info.channels) {
        if (data[i] > 24) { hits++; if (hits > 8) break }
      }
      if (hits <= 8) continue
      const file = `r${r}c${c}.png`
      await sharp(buf).toFile(join(outDir, file))
      cols.push(file)
    }
    frames[rowName] = cols
    console.log(`${mode} ${rowName}: ${cols.length} frames`)
  }
  manifest[mode].rows = frames
}

await cutAtlas('kurumi')
await cutAtlas('inverse')

for (const s of ['idle', 'work', 'deep']) {
  manifest.whale.states[s] = `states/${s}.png`
  console.log(`whale state ${s}: states/${s}.png`)
}

writeFileSync(join(root, 'ui', 'pets', 'frames.json'), JSON.stringify(manifest, null, 2))
console.log('frames.json written')
