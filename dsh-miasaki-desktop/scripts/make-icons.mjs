// make-icons.mjs — Miasaki 图标设计管线（v2 徽章化设计）
// 设计语言：圆形头像徽章 + 暗夜底 + 鎏金时钟环（刻刻帝母题）
//  - app 图标：头像头部裁切 → 圆形 → 1024 暗夜底 + 金环 + 12 刻度 + 绯红顶珠
//  - theme 图标：三主题同构徽章（中性环 / 金环 / 破血红环）
import sharp from 'sharp'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
mkdirSync(join(root, 'ui', 'icons'), { recursive: true })
// 源图以工程内主副本为准（ui/icons/avatar-source.png；桌面临时文件可能被清理）
const userImg = join(root, 'ui', 'icons', 'avatar-source.png')
const kurumi = join(root, 'ui', 'pets', 'kurumi', 'spritesheet.webp')

// 头像头部裁切（MiMo 量测：头部 10%~55% 高度、居中；蓝箭头图标在 (18,22) 14x14）
// 源 160x165 → 头部+肩部区 (34, 10, 96, 96) 方形（x≥34 避开蓝图标，y 6%~64% 避开底部文字）
const HEAD = { left: 34, top: 10, width: 96, height: 96 }
// 主题小图标用更紧的头部裁切
const HEAD_TIGHT = { left: 42, top: 20, width: 76, height: 76 }

function circleMaskSvg(size) {
  const r = Math.floor(size / 2)
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<circle cx="${r}" cy="${r}" r="${r}" fill="white"/></svg>`
  )
}

// 消除源图杂质（鲜蓝"外部链接"小图标）已通过 fix-avatar.mjs 烙入主副本，此处无需补丁
// （保留 patchArtifact 仅供源图更换时参考；fix-avatar.mjs 已归档 _refs/scripts-archive/）

function ringSvg(size, color, opts = {}) {
  const c = size / 2
  const r = opts.radius || size / 2 - 5
  const w = opts.width || 3.5
  const parts = []
  if (opts.broken) {
    parts.push(`<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${w}" stroke-dasharray="${opts.dash || '26 12'}"/>`)
  } else {
    parts.push(`<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${w}"/>`)
  }
  if (opts.ticks) {
    for (let i = 0; i < 12; i++) {
      const a = (i * 30 - 90) * Math.PI / 180
      const r1 = r - w - 4
      const r2 = r + w + 4
      parts.push(`<line x1="${(c + r1 * Math.cos(a)).toFixed(1)}" y1="${(c + r1 * Math.sin(a)).toFixed(1)}"` +
        ` x2="${(c + r2 * Math.cos(a)).toFixed(1)}" y2="${(c + r2 * Math.sin(a)).toFixed(1)}" stroke="${color}" stroke-width="${w}"/>`)
    }
  }
  if (opts.dot) {
    parts.push(`<circle cx="${c}" cy="${(c - r).toFixed(1)}" r="${w + 3}" fill="${opts.dot}"/>`)
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${parts.join('')}</svg>`)
}

// ============ 1) 主题图标（96px 徽章） ============

// pure：头像 + 中性银环
{
  const head = await sharp(userImg).extract(HEAD_TIGHT).resize(96, 96, { kernel: 'lanczos3' })
    .composite([{ input: circleMaskSvg(96), blend: 'dest-in' }]).png().toBuffer()
  await sharp(head)
    .composite([{ input: ringSvg(96, '#8A8295', { width: 3, radius: 44 }) }])
    .png().toFile(join(root, 'ui', 'icons', 'theme-pure.png'))
  console.log('theme-pure.png (badge) done')
}

// zafkiel：狂三头部 + 鎏金环
{
  const head = await sharp(kurumi).extract({ left: 28, top: 4, width: 136, height: 136 })
    .resize(96, 96, { kernel: 'lanczos3' })
    .composite([{ input: circleMaskSvg(96), blend: 'dest-in' }]).png().toBuffer()
  await sharp(head)
    .composite([{ input: ringSvg(96, '#D9B36A', { width: 3, radius: 44, dot: '#C23A2E' }) }])
    .png().toFile(join(root, 'ui', 'icons', 'theme-zafkiel.png'))
  console.log('theme-zafkiel.png (badge) done')
}

// inverse：反转狂三新立绘（states/idle.png 头部） + 破碎血红环
{
  const invImg = join(root, 'ui', 'pets', 'inverse', 'states', 'idle.png')
  const meta = await sharp(invImg).metadata()
  // 自适应头部定位（Q 版全身立绘 332x540）：头部总占顶部，身体从 ~45% 高度起明显变宽。
  // 此前两版均失败——固定窗口按旧尺寸取中部（只拍到脸的中上一条）；
  // 全图亮区 bbox 被衣服高光拉满整幅（side clamp 成全宽、top=97 → 头顶整段被切）。
  // 本版：仅在顶部 35% 高度内统计 alpha bbox 与最大行宽，方形居中于该 bbox，
  // 顶边取内容起始处（留 1% 余量），宽度含住发梢。
  const { data, info } = await sharp(invImg).raw().toBuffer({ resolveWithObject: true })
  const scanH = Math.max(1, Math.round(info.height * 0.35))
  let minX = info.width, maxX = -1, startY = info.height, maxW = 0
  for (let y = 0; y < scanH; y++) {
    let yMin = info.width, yMax = -1
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] < 32) continue
      if (x < yMin) yMin = x
      if (x > yMax) yMax = x
    }
    if (yMax < 0) continue
    if (y < startY) startY = y
    if (yMin < minX) minX = yMin
    if (yMax > maxX) maxX = yMax
    maxW = Math.max(maxW, yMax - yMin + 1)
  }
  if (maxX < 0) throw new Error('inverse 立绘无内容，无法定位头部')
  let side = Math.round(maxW * 1.06)
  const cx = (minX + maxX) / 2
  const top = Math.min(Math.max(Math.round(startY * 0.6), 0), info.height - 1)
  side = Math.min(side, info.width, info.height - top)
  const left = Math.min(Math.max(Math.round(cx - side / 2), 0), info.width - side)
  console.log(`[inverse] head window: left=${left} top=${top} side=${side} (bbox ${minX}..${maxX}, startY=${startY}, maxW=${maxW})`)
  const head = await sharp(invImg).extract({ left, top, width: side, height: side })
    .resize(96, 96, { kernel: 'lanczos3' })
    .composite([{ input: circleMaskSvg(96), blend: 'dest-in' }]).png().toBuffer()
  await sharp(head)
    .composite([{ input: ringSvg(96, '#9E1B1B', { width: 3, radius: 44, broken: true }) }])
    .png().toFile(join(root, 'ui', 'icons', 'theme-inverse.png'))
  console.log('theme-inverse.png (badge) done')
}

// ============ 2) 软件图标（1024 徽章，源 = src-tauri/icon-new.png 用户提供的 DeepSeek 娘艺术图） ============

{
  const art = join(root, 'src-tauri', 'icon-new.png')
  // 1024 应用图标源
  await sharp(art).resize(1024, 1024, { kernel: 'lanczos3' }).png()
    .toFile(join(root, 'src-tauri', 'app-icon-source.png'))
  console.log('app-icon-source.png (art 1024) done')

  // 加载页小图标（128）
  await sharp(art).resize(128, 128, { kernel: 'lanczos3' }).png()
    .toFile(join(root, 'ui', 'icons', 'app.png'))
  console.log('app.png (art 128) done')
}
