// inverse-states.mjs — 反转狂三立绘处理:flood-fill 背景消除(边缘连通)→ 裁剪 → despeckle → 缩放高度 540 → states/
// 用法:node scripts/inverse-states.mjs  (在 desktop 目录)
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// despeckle:杀散点 + 杀光晕浮雾(同 cut-frames.mjs:孤点/光晕,保留主体边)
async function despeckle(out, w, h) {
  const at = (x, y) => out[(y * w + x) * 4 + 3]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = at(x, y)
      if (a < 24) { out[(y * w + x) * 4 + 3] = 0; continue }
      if (a >= 128) continue
      let strong = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          if (at(nx, ny) >= 128) strong++
        }
      }
      if (strong === 0) out[(y * w + x) * 4 + 3] = 0
    }
  }
}

const root = join(process.cwd(), 'ui', 'pets', 'inverse')
const RAW = join(root, 'raw')
const OUT = join(root, 'states')
mkdirSync(OUT, { recursive: true })

const TOL = 22

// 核心背景:深蓝纯色(B 显著占优)—— 严格阈值,只识别背景本体
function isBgCore(pr, pg, pb) {
  const mx = Math.max(pr, pg)
  return pb > 60 && (pb - mx) > 38
}

// 相邻颜色接近(用于从核心背景向渐变区扩展)
function near(pr, pg, pb, nr, ng, nb) {
  return Math.max(Math.abs(pr - nr), Math.abs(pg - ng), Math.abs(pb - nb)) < TOL
}

async function cutout(name, outName) {
  const img = await sharp(join(RAW, `${name}.png`)).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const { data, info } = img
  const { width: w, height: h, channels: c } = info

  // —— flood-fill:核心背景特征 + 连通性扩展(渐变区可扩展,人物内部不连通则保留) ——
  const bg = new Uint8Array(w * h)
  const stack = []
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const i = y * w + x
    if (!bg[i]) { bg[i] = 1; stack.push(i) }
  }
  // 种子:四边中满足核心背景特征的像素
  for (let x = 0; x < w; x++) {
    const ti = x * c, bi = ((h - 1) * w + x) * c
    if (isBgCore(data[ti], data[ti + 1], data[ti + 2])) push(x, 0)
    if (isBgCore(data[bi], data[bi + 1], data[bi + 2])) push(x, h - 1)
  }
  for (let y = 0; y < h; y++) {
    const li = (y * w) * c, ri = (y * w + w - 1) * c
    if (isBgCore(data[li], data[li + 1], data[li + 2])) push(0, y)
    if (isBgCore(data[ri], data[ri + 1], data[ri + 2])) push(w - 1, y)
  }
  while (stack.length) {
    const i = stack.pop()
    const x = i % w, y = (i - x) / w
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const ni = ny * w + nx
      if (bg[ni]) continue
      const nr = data[ni * c], ng = data[ni * c + 1], nb = data[ni * c + 2]
      if (isBgCore(nr, ng, nb)) { bg[ni] = 1; stack.push(ni) }
    }
  }

  // —— 找人物 bounding box(非背景区) ——
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bg[y * w + x]) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) { console.error(`[inverse-states] ${name}: 无前景!`); return }
  const pad = 6
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad)
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad)
  const cw = maxX - minX + 1, ch = maxY - minY + 1

  // —— 输出 RGBA(背景透明,前景膨胀 1px 取邻近前景均值覆盖光晕 + 降蓝) ——
  const out = Buffer.alloc(cw * ch * 4)
  // 前景掩码 + 1px 膨胀
  const fg = new Uint8Array(cw * ch)
  const at = (x, y) => {
    const sx = x + minX, sy = y + minY
    return bg[sy * w + sx] ? 0 : 1
  }
  // 1px 邻域前景均值色(用于环带像素覆色,避免残留底色噪边)
  const ringColor = (x, y) => {
    let rs = 0, gs = 0, bs = 0, n = 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue
        if (at(nx, ny) !== 1) continue
        const ssi = ((ny + minY) * w + (nx + minX)) * c
        rs += data[ssi]; gs += data[ssi + 1]; bs += data[ssi + 2]; n++
      }
    }
    if (n === 0) return null
    return [Math.round(rs / n), Math.round(gs / n), Math.round(bs / n)]
  }
  const nearFg = (x, y) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const nx = x + dx, ny = y + dy
        if (nx >= 0 && ny >= 0 && nx < cw && ny < ch && at(nx, ny)) return true
      }
    }
    return false
  }
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const sx = x + minX, sy = y + minY
      const si = (sy * w + sx) * c
      const o = (y * cw + x) * 4
      const isFg = at(x, y) === 1
      let a = isFg ? 255 : 0
      let ro = data[si], go = data[si + 1], bo = data[si + 2]
      // 膨胀环(1px):邻近前景的背景像素 → 半透明 150,颜色取邻近前景均值(消除残留底色)
      if (!isFg && nearFg(x, y)) {
        a = 150
        const rc = ringColor(x, y)
        if (rc) { ro = rc[0]; go = rc[1]; bo = rc[2] }
      }
      // 降蓝:蓝占优像素压回中性(去蓝边)
      const mx = Math.max(ro, go)
      if (a < 255 && bo - mx > 12) bo = mx + 8
      out[o] = ro; out[o + 1] = go; out[o + 2] = bo; out[o + 3] = a
    }
  }

  // despeckle:杀散点 + 杀光晕(对环带+主体的统一去噪)
  await despeckle(out, cw, ch)

  // —— 缩放到高度 540(渲染 270 高的 2 倍超采样) ——
  // 曾输出 208 高:128×208 渲染放大到 270 时糊化,时钟眼(金表盘 12:05)失去辨识度,
  // 用户反馈「不像」→ 高清源(1728×2368)应保留细节,缩小采样比放大糊化好。
  // 曾输出 `${name}.png`(blue-*.png):与 frames.json 引用的 states/idle.png 错位,
  // 桌宠实际渲染的是旧 128×208 产物(v1 遗留断层)——本次统一为 {idle,work,deep}.png。
  const targetH = 540
  const targetW = Math.round(cw * targetH / ch)
  const png = await sharp(out, { raw: { width: cw, height: ch, channels: 4 } })
    .resize(targetW, targetH, { fit: 'fill' })
    .png()
    .toFile(join(OUT, `${outName}.png`))
  console.log(`[inverse-states] ${name}: bbox ${cw}x${ch} -> ${png.width}x${png.height}`)
}

for (const [src, out] of [['blue-idle', 'idle'], ['blue-work', 'work'], ['blue-deep', 'deep']]) {
  await cutout(src, out)
}
console.log('[inverse-states] done')
