// cut-frames.mjs — 预切桌宠图集为逐帧 PNG + 帧清单（供原生分层窗口渲染）
// kurumi：按 Codex 行切帧（全部 9 行，非空探测）；whale：拆 idle.gif 帧序列 + 立绘三态；
// inverse：立绘三态直接引用
import sharp from 'sharp'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const CELL_W = 192, CELL_H = 208
const ROW_NAMES = ['idle', 'runRight', 'runLeft', 'wave', 'jump', 'failed', 'wait', 'run', 'review']
// v2：全部语义行切出（非空自动探测；空行省略）。v1 曾只切 4 行（僵硬诊断 #1）
const NEEDED = ['idle', 'runRight', 'runLeft', 'wave', 'jump', 'failed', 'wait', 'run', 'review']

const manifest = {
  whale: { kind: 'states', states: {} },
  kurumi: { kind: 'atlas', rows: {} },
  inverse: { kind: 'states', states: {} }
}

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

// GIF 透明替代色残留后处理:绿色主导像素 → alpha 0(纯绿 0,254,0 / 0,126,0 等描边即此类)
async function stripGreenEdge(buf) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
    if (a > 0 && g > r + 30 && g > b + 30) data[i + 3] = 0
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer()
}

// whale:拆 idle.gif 帧序列(192×208×6 垂直帧条),work/deep 保持立绘单帧
async function cutWhaleIdleFrames() {
  const src = join(root, 'ui', 'pets', 'whale', 'idle.gif')
  const outDir = join(root, 'ui', 'pets', 'whale', 'states')
  mkdirSync(outDir, { recursive: true })
  const meta = await sharp(src, { animated: true }).metadata()
  const pages = meta.pages ?? 1
  const totalH = meta.height ?? pages * CELL_H
  const frameH = Math.floor(totalH / pages)
  // sharp 的 animated 语义:输入按每帧垂直堆叠成一张图;page:p 输出的是"从第 p 页起的堆叠塔"
  // (曾在 v2 初版踩坑:直接 page 导出得到 192×1248/1040/832… 尺寸不一 → 渲染逐帧缩放跳动)。
  // 正确做法:整图 → extract 逐段(顶部=帧 0),每帧尺寸保证 192×208。
  const full = await sharp(src, { animated: true }).png().toBuffer()
  const files = []
  for (let p = 0; p < pages; p++) {
    const f = `idle-${String(p).padStart(2, '0')}.png`
    const buf = await sharp(full)
      .extract({ left: 0, top: p * frameH, width: CELL_W, height: frameH })
      .png()
      .toBuffer()
    await writeFile(join(outDir, f), await stripGreenEdge(buf))
    files.push(`states/${f}`)
  }
  console.log(`whale idle frames: ${files.length} x ${CELL_W}x${frameH} (from ${meta.width}x${totalH})`)
  return files
}
manifest.whale.states.idle = await cutWhaleIdleFrames()

for (const s of ['work', 'deep']) {
  manifest.whale.states[s] = `states/${s}.png`
  console.log(`whale state ${s}: states/${s}.png`)
}
// inverse:立绘三态(由 inverse-states.mjs 生成于 states/)
for (const s of ['idle', 'work', 'deep']) {
  manifest.inverse.states[s] = `states/${s}.png`
  console.log(`inverse state ${s}: states/${s}.png`)
}

writeFileSync(join(root, 'ui', 'pets', 'frames.json'), JSON.stringify(manifest, null, 2))
console.log('frames.json written')
