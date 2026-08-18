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
// （保留 patchArtifact 仅供源图更换时参考）

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

// inverse：反转狂三新立绘（银白/苍白/血红已烘焙）头部 + 破碎血红环
{
  const invAtlas = join(root, 'ui', 'pets', 'inverse', 'spritesheet.png')
  const head = await sharp(invAtlas).extract({ left: 28, top: 4, width: 136, height: 136 })
    .resize(96, 96, { kernel: 'lanczos3' })
    .composite([{ input: circleMaskSvg(96), blend: 'dest-in' }]).png().toBuffer()
  await sharp(head)
    .composite([{ input: ringSvg(96, '#9E1B1B', { width: 3, radius: 44, broken: true }) }])
    .png().toFile(join(root, 'ui', 'icons', 'theme-inverse.png'))
  console.log('theme-inverse.png (badge) done')
}

// ============ 2) 软件图标（1024 徽章） ============

{
  const SIZE = 1024
  const bg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
    `<defs><radialGradient id="bg" cx="50%" cy="42%" r="72%">` +
    `<stop offset="0%" stop-color="#241D30"/><stop offset="100%" stop-color="#0C0B11"/>` +
    `</radialGradient></defs>` +
    `<rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>` +
    `</svg>`
  )
  // 头像：头部裁切 → 圆形 → 760px（居中于 1024）
  const head = await sharp(userImg).extract(HEAD)
    .resize(760, 760, { kernel: 'lanczos3' })
    .sharpen({ sigma: 1.2 })
    .composite([{ input: circleMaskSvg(760), blend: 'dest-in' }])
    .png().toBuffer()
  // 时钟环：金环 + 12 刻度 + 绯红顶珠（r=470）
  const ring = ringSvg(SIZE, '#D9B36A', { width: 16, radius: 470, ticks: true, dot: '#C23A2E' })
  await sharp(bg)
    .composite([
      { input: head, left: 132, top: 132 },
      { input: ring }
    ])
    .png().toFile(join(root, 'src-tauri', 'app-icon-source.png'))
  console.log('app-icon-source.png (badge 1024) done')

  // 加载页小头像（128，同款徽章）
  const head128 = await sharp(userImg).extract(HEAD)
    .resize(128, 128, { kernel: 'lanczos3' })
    .composite([{ input: circleMaskSvg(128), blend: 'dest-in' }]).png().toBuffer()
  await sharp(head128)
    .composite([{ input: ringSvg(128, '#D9B36A', { width: 4, radius: 58, dot: '#C23A2E' }) }])
    .png().toFile(join(root, 'ui', 'icons', 'app.png'))
  console.log('app.png (badge 128) done')
}
