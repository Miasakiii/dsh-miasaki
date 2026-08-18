// segment-litu.mjs — 分割 dsh立绘 三视图（白底），输出每张图的三个视图透明 PNG
import sharp from 'sharp'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const srcDir = 'C:/Users/Asakii/Desktop/dsh立绘'
const outDir = join(root, 'ui', 'pets', 'whale', 'states')
mkdirSync(outDir, { recursive: true })

for (const [name, file] of [['s', '小.jpg'], ['m', '中.jpg'], ['l', '大.jpg']]) {
  const src = join(srcDir, file)
  if (!existsSync(src)) { console.log('missing', src); continue }
  const meta = await sharp(src).metadata()
  const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true })
  // 列亮度剖面：找非白像素的列区间，分割出视图
  const colHits = new Array(info.width).fill(0)
  for (let y = 0; y < info.height; y += 2) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels
      const r = data[i], g = data[i + 1], b = data[i + 2]
      if (r < 235 || g < 235 || b < 235) colHits[x]++
    }
  }
  // 连续非白列段
  const segs = []
  let inSeg = false, start = 0
  for (let x = 0; x < info.width; x++) {
    const on = colHits[x] > 4
    if (on && !inSeg) { inSeg = true; start = x }
    if (!on && inSeg) { inSeg = false; if (x - start > 40) segs.push([start, x]) }
  }
  if (inSeg) segs.push([start, info.width])
  console.log(`${file}: ${info.width}x${info.height}, segments: ${JSON.stringify(segs)}`)
  // 每个视图段：水平也按非白行裁剪
  for (let si = 0; si < segs.length; si++) {
    const [sx, ex] = segs[si]
    // 行剖面
    const rowHits = new Array(info.height).fill(0)
    for (let y = 0; y < info.height; y += 2) {
      for (let x = sx; x < ex; x++) {
        const i = (y * info.width + x) * info.channels
        const r = data[i], g = data[i + 1], b = data[i + 2]
        if (r < 235 || g < 235 || b < 235) rowHits[y]++
      }
    }
    let sy = 0, ey = info.height
    for (let y = 0; y < info.height; y++) { if (rowHits[y] > 4) { sy = y; break } }
    for (let y = info.height - 1; y >= 0; y--) { if (rowHits[y] > 4) { ey = y; break } }
    const pad = 4
    const left = Math.max(0, sx - pad)
    const top = Math.max(0, sy - pad)
    const w = Math.min(info.width - left, (ex - sx) + pad * 2)
    const h = Math.min(info.height - top, (ey - sy) + pad * 2)
    // 白底 → 透明：洪泛填充（从边缘连通的近白像素 = 背景 → alpha 0；角色保持不透明）
    const cropBuf = await sharp(src).extract({ left, top, width: w, height: h }).raw().toBuffer({ resolveWithObject: true })
    const raw = cropBuf.data
    const cw = cropBuf.info.width
    const ch = cropBuf.info.height
    const chn = cropBuf.info.channels
    const isBg = (r, g, b) => r > 240 && g > 240 && b > 240
    const alphaArr = new Uint8Array(cw * ch).fill(255)
    const visited = new Uint8Array(cw * ch)
    const stack = []
    for (let x = 0; x < cw; x++) { stack.push([x, 0]); stack.push([x, ch - 1]) }
    for (let y = 0; y < ch; y++) { stack.push([0, y]); stack.push([cw - 1, y]) }
    while (stack.length) {
      const [x, y] = stack.pop()
      if (x < 0 || y < 0 || x >= cw || y >= ch) continue
      const idx = y * cw + x
      if (visited[idx]) continue
      visited[idx] = 1
      const i = idx * chn
      if (!isBg(raw[i], raw[i + 1], raw[i + 2])) continue
      alphaArr[idx] = 0
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
    }
    const crop = await sharp(src).extract({ left, top, width: w, height: h }).png().toBuffer()
    const view = await sharp(crop)
      .joinChannel(alphaArr, { raw: { width: cw, height: ch, channels: 1 } })
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 4 })
      .png()
      .toBuffer()
    const out = join(outDir, `${name}_v${si}.png`)
    await sharp(view).toFile(out)
    console.log(`  -> ${out} (${w}x${h})`)
  }
}
