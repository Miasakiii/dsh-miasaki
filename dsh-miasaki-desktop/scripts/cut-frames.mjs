// cut-frames.mjs — 预切桌宠图集为逐帧 PNG + 帧清单（供原生分层窗口渲染）
// kurumi：按行切帧（全部 9 行，非空探测）；whale：图集 11 行 + idle.gif 帧序列 + 立绘三态；
// inverse：立绘三态直接引用。
// A 批（2026-10-19）：多形象（换装）——variant 键（`whale.<name>`）与 default 平铺，
// 切帧按 ATLAS_SPECS 键自动进行（见下方调用处），schema 与加载链同构。
import sharp from 'sharp'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const CELL_W = 192, CELL_H = 208
/**
 * **每主题的行名表**（图集行号 → Rust 行名空间）。
 *
 * ⚠ 行号是**生成模板的约定**，不是跨主题语义契约：不同主题同一行号的语义可能不同。
 * 2026-09-27 逐行视觉核验实证——kurumi `r7` = 坐姿打字（Rust 行名 `run`，服务 Thinking），
 * whale `r7` = 站姿待机（与 `run` 无关），连 `r0` 的帧数都不同（6 vs 7）。
 * 故**不共用一份 ROW_NAMES**（v5 之前是全局数组，只对 kurumi 成立）。
 * 见 design/pet-v5-motion-plan.md §2.3.2。
 */
const ATLAS_SPECS = {
  kurumi: ['idle', 'runRight', 'runLeft', 'wave', 'jump', 'failed', 'wait', 'run', 'review'],
  // whale 图集实测 8 列 × 11 行。r0–r6 = 主动作（2026-09-27 逐行视觉核验）；
  // r7–r10 = **站姿待机变体群**（2026-10-18 逐行视觉核验：四行均为女仆装站立待机，
  // 姿态微差——双手交叠 / 侧身发 sweeps / 微张双臂 / 尾翼弧度；帧数 6/6/8/8），
  // 以 idle2–idle5 登记进 Rust 行空间，供 whale 专属 ambient 池做「待机不重样」（R21）。
  whale: ['idle', 'runRight', 'runLeft', 'wave', 'jump', 'failed', 'wait', 'idle2', 'idle3', 'idle4', 'idle5'],
}

const manifest = {
  // whale：atlas 行（行选择）+ states 立绘（强度档 deep 仍走立绘）并存
  whale: { kind: 'atlas', rows: {}, states: {} },
  kurumi: { kind: 'atlas', rows: {} },
  inverse: { kind: 'states', states: {} }
}

async function cutAtlas(mode) {
  const spec = ATLAS_SPECS[mode]
  const src = join(root, 'ui', 'pets', mode, 'spritesheet.png')
  const outDir = join(root, 'ui', 'pets', mode, 'frames')
  mkdirSync(outDir, { recursive: true })
  const meta = await sharp(src).metadata()
  const rows = Math.floor(meta.height / CELL_H)
  const frames = {}
  for (const [r, rowName] of spec.entries()) {
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
      const cleaned = await despeckle(buf)
      await sharp(cleaned).toFile(join(outDir, file))
      cols.push(file)
    }
    frames[rowName] = cols
    console.log(`${mode} ${rowName} (r${r}): ${cols.length} frames`)
  }
  manifest[mode].rows = frames
}

// A 批（2026-10-19）：按 ATLAS_SPECS 的**每个键**切（含 variant 键如
// `whale.sakura`——多形象与 default 平铺前缀键、schema 同构）。manifest 条目
// 按需创建：加一个形象 = ATLAS_SPECS 加一行（源图集 + 行名表），其余自动。
for (const mode of Object.keys(ATLAS_SPECS)) {
  if (!manifest[mode]) manifest[mode] = { kind: 'atlas', rows: {} }
  await cutAtlas(mode)
}

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

// 边缘去噪:杀散点 + 杀半透明光晕
// 1. a<24 → 0(对齐 cutAtlas 非空探测阈值)
// 2. 0<a<96 且 8 邻域无 a>=128 的不透明邻居 → 0(杀光晕浮雾,保留主体边)
// 3. a>=96 但 8 邻域中 a>=128 的不透明邻居 <2 → 0(杀孤立散点,保留主体内部)
async function despeckle(buf) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
  const { width: w, height: h, channels: c } = info
  if (c !== 4) {
    return sharp(data, { raw: { width: w, height: h, channels: c } }).png().toBuffer()
  }
  const at = (x, y) => data[(y * w + x) * 4 + 3]
  const out = Buffer.from(data)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = at(x, y)
      if (a < 24) { out[(y * w + x) * 4 + 3] = 0; continue }
      // 实心像素保留(主体内部,无需清理)
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
      if (strong === 0) {
        // 邻域无任何强前景 → 浮雾/孤立散点
        out[(y * w + x) * 4 + 3] = 0
      }
    }
  }
  return sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()
}

// whale:拆 idle.gif 帧序列(192×208×6 垂直帧条)；deep 保持立绘单帧。
// R21（2026-10-18）：`work` 立绘退役——whale 走图集分支后 `whale_states` 只在
// deep 覆盖分支被读且 key 恒为 "deep"（compose 分支条件决定），work 是 567KB 死素材；
// idle（6 帧）保留作 deep 缺失时的 fallback（image.rs 的 states.get("idle") 兜底）。
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
    const cleaned = await despeckle(await stripGreenEdge(buf))
    await writeFile(join(outDir, f), cleaned)
    files.push(`states/${f}`)
  }
  console.log(`whale idle frames: ${files.length} x ${CELL_W}x${frameH} (from ${meta.width}x${totalH})`)
  return files
}
manifest.whale.states.idle = await cutWhaleIdleFrames()

// whale 立绘强度档：仅 deep（R21 退役 work，见 cutWhaleIdleFrames 上方注释）
for (const s of ['deep']) {
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
