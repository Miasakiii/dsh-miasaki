// @miasaki/dsh-appearance — 应用图标预设的**程序化生成**（纯逻辑，只用 Node 内建模块）。
//
// 为什么是"生成"而不是"放一批 PNG 资源"：
//   1. 本线的硬纪律是**零第三方依赖**（不能引 sharp / canvas），而仓库里唯一现成的光栅器在
//      desktop 线 —— 跨线取素材会把两条线绑在一起，正是本仓明令避免的耦合；
//   2. 图像资源一旦入库就不可参数化：这套定义里配色/圆角/构图全是数据，改一处即可全量重出；
//   3. 交付物仍是**普通 PNG**（写进 avatars/ 目录），所以桌面壳那侧零改动、跨线契约一个字不用动。
//
// 渲染管线（单遍扫描，解析式抗锯齿，不做超采样）：
//   SDF（有符号距离场）算覆盖率 → 逐层 alpha-over 合成 → 圆角方遮罩裁边 → PNG 编码（node:zlib）。
// 512×512 一张约 26 万像素、每像素十来个图元求值，单张毫秒级。
//
// 预设表当前共四款：程序化「默认」+ 三款鲸鱼娘位图（头像 / 立绘 / 现行），
// 2026-09-23 追加两款位图的理由见 ICON_PRESETS 的注释。

import { deflateSync } from 'node:zlib'

/* ------------------------------------------------------------------ 颜色 */

/** `#rgb` / `#rrggbb` → [r,g,b]；非法回退黑色（配置面已收窄，这里只兜底）。 */
function parseHex(text) {
  const hex = typeof text === 'string' ? text.trim() : ''
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    return [parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16), parseInt(hex[3] + hex[3], 16)]
  }
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
  }
  return [0, 0, 0]
}

/** 在两个 RGB 之间线性插值（t 已 clamp）。 */
function mixRgb(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]
}

/**
 * 把 fill 描述编译成「归一化坐标 → RGB」的取值函数。
 * 支持纯色字符串与线性渐变；两端点用归一化画布坐标（0..1），与图元定义同一坐标系。
 * @param {string|{kind: string, from: number[], to: number[], stops: Array}} fill - 填充描述。
 * @returns {(x: number, y: number) => number[]} 取值函数。
 */
function compileFill(fill) {
  if (typeof fill === 'string') {
    const rgb = parseHex(fill)
    return () => rgb
  }
  if (fill !== null && typeof fill === 'object' && fill.kind === 'linear' && Array.isArray(fill.stops) && fill.stops.length > 0) {
    const stops = fill.stops
      .map(stop => ({ at: Number(stop[0]), rgb: parseHex(stop[1]) }))
      .sort((a, b) => a.at - b.at)
    const from = fill.from ?? [0, 0]
    const to = fill.to ?? [0, 1]
    const dx = to[0] - from[0]
    const dy = to[1] - from[1]
    const lenSq = dx * dx + dy * dy
    return (x, y) => {
      const t = lenSq === 0 ? 0 : Math.min(1, Math.max(0, ((x - from[0]) * dx + (y - from[1]) * dy) / lenSq))
      let lo = stops[0]
      let hi = stops[stops.length - 1]
      for (const stop of stops) {
        if (stop.at <= t) lo = stop
        if (stop.at >= t) { hi = stop; break }
      }
      const span = hi.at - lo.at
      return mixRgb(lo.rgb, hi.rgb, span <= 0 ? 0 : (t - lo.at) / span)
    }
  }
  return () => [0, 0, 0]
}

/* -------------------------------------------------------------- SDF 图元 */

/** 圆角矩形的有符号距离（负=内部），坐标用归一化画布单位。 */
function roundRectDistance(x, y, shape) {
  const halfW = shape.w / 2
  const halfH = shape.h / 2
  const cx = shape.x + halfW
  const cy = shape.y + halfH
  const r = Math.min(shape.r ?? 0, halfW, halfH)
  const qx = Math.abs(x - cx) - (halfW - r)
  const qy = Math.abs(y - cy) - (halfH - r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - r
}

/** 圆的有符号距离。 */
function circleDistance(x, y, shape) {
  return Math.hypot(x - shape.cx, y - shape.cy) - shape.r
}

/** 任一图元在 (x,y) 处的有符号距离。 */
function shapeDistance(x, y, shape) {
  return shape.kind === 'circle' ? circleDistance(x, y, shape) : roundRectDistance(x, y, shape)
}

/**
 * 由距离场算覆盖率（解析式抗锯齿）：边缘 ±半个像素内线性过渡。
 * @param {number} distance - 归一化单位的距离。
 * @param {number} pixel - 一个像素对应的归一化长度（1/size）。
 * @returns {number} 0..1 覆盖率。
 */
function coverage(distance, pixel) {
  return Math.min(1, Math.max(0, 0.5 - distance / pixel))
}

/* ---------------------------------------------------------------- 预设表 */

/**
 * 画布几何：图标占满画布，圆角 23.5%（对齐 Windows 11 图标观感，与本仓 make-icons 同一口径）。
 * 图案统一落在 0.20–0.80 的安全区里，任何尺寸下都不会被圆角切到。
 */
const CANVAS = Object.freeze({ radius: 0.235, safe: 0.2 })

/**
 * 「默认」款的几何徽记：抽象「M」—— 左右各一组「短块 + 长块」+ 中央两枚圆点。
 * （2026-09-21 由 A/B/C/D 四版骨架**渲染出来目检**后选定；方块 + 圆点的像素感）
 */
const MARK = Object.freeze([
  Object.freeze({ kind: 'rect', x: 0.200, y: 0.285, w: 0.155, h: 0.155, r: 0.045 }),
  Object.freeze({ kind: 'rect', x: 0.200, y: 0.470, w: 0.155, h: 0.245, r: 0.045 }),
  Object.freeze({ kind: 'rect', x: 0.645, y: 0.285, w: 0.155, h: 0.155, r: 0.045 }),
  Object.freeze({ kind: 'rect', x: 0.645, y: 0.470, w: 0.155, h: 0.245, r: 0.045 }),
  Object.freeze({ kind: 'circle', cx: 0.500, cy: 0.365, r: 0.055 }),
  Object.freeze({ kind: 'circle', cx: 0.500, cy: 0.565, r: 0.055 }),
])

/**
 * 预设表。
 *
 * **四款**（2026-09-23 在「默认 / 头像」两款基础上追加两款鲸鱼娘位图）：
 *  - 2026-09-21：参考截图里那套通用软件风格的多配色图标（暗夜玻璃 / 素雅银 / 果冻蓝 /
 *    缠线绿 / 蒙德里安 / 暖橙 / 流光）**不适合本项目**，初版七款连同它们带出的渲染能力
 *    （顶部高光 `gloss` / 装饰层 `deco` / 骨架覆盖 `marks`）一并撤掉，只保留程序化的
 *    「默认」与用户提供的「头像」；
 *  - 2026-09-23：用户又给了两张鲸鱼娘图，要求三款应用图标（现行软件图标 / 两张新图）
 *    都进预设自由选 —— 于是位图预设扩到三款：「头像」（此前的图）、「立绘」（新方图）、
 *    「现行」（现行 EXE 图标同款艺术图 `src-tauri/icon-new.png`）。三者同角色不同构图，
 *    用户在面板里随场景挑；命名约定沿用"内容是什么就叫什么"。
 *
 * 字段：
 *  - `base`：底层（纯色或线性渐变），先画；
 *  - `mark`：徽记颜色（纯色或渐变）；
 *  - `asset`：位图预设（插件自带 PNG 的相对路径）；给了它就不走程序化绘制。
 *
 * 将来若要加款，**配色应当取本仓三主题的色感**（墨夜 / 绯红 / 鎏金 / 骨白 / 枪铁）
 * 或角色主题，而不是通用软件的配色习惯。
 */
export const ICON_PRESETS = Object.freeze([
  Object.freeze({
    id: 'default',
    label: '默认',
    base: { kind: 'linear', from: [0, 0], to: [1, 1], stops: [[0, '#26262c'], [1, '#0e0e12']] },
    mark: '#f4f4f6',
  }),
  // 「头像」是位图预设：资源入库在 assets/presets/portrait.png（用户提供的图，
  // 处理链见该目录 README）。程序化与位图对 host 是同一个接口：
  // 「给一个预设 id，拿一份 PNG 字节」，落盘路径与跨线契约完全一致。
  Object.freeze({
    id: 'portrait',
    label: '头像',
    asset: 'assets/presets/portrait.png',
  }),
  // 2026-09-23 追加两款：源图与配方见 assets/presets/README.md。
  Object.freeze({
    id: 'illustration',
    label: '立绘',
    asset: 'assets/presets/illustration.png',
  }),
  Object.freeze({
    id: 'current',
    label: '现行',
    asset: 'assets/presets/current.png',
  }),
])

/** 按 id 取预设；未知 id 返回 null（调用方据此 404 / 回退）。 */
export function presetById(id) {
  for (const preset of ICON_PRESETS) {
    if (preset.id === id) return preset
  }
  return null
}

/** 预设图标在 avatars 目录里的文件名（必须命中跨线契约的白名单）。 */
export function presetFileName(id) {
  return `preset-${id}.png`
}

/** 预设图标的同源 URL（面板预览与 avatar.source 都用它）。 */
export function presetUrl(id) {
  return `/appearance/avatar/${presetFileName(id)}`
}

/** 由 URL 反查预设 id；非预设 URL 返回 null。 */
export function presetIdFromUrl(url) {
  if (typeof url !== 'string') return null
  for (const preset of ICON_PRESETS) {
    if (url === presetUrl(preset.id)) return preset.id
  }
  return null
}

/* ------------------------------------------------------------ 渲染与编码 */

/**
 * 渲染一款预设为 RGBA 像素。
 * @param {object} preset - ICON_PRESETS 里的一项。
 * @param {number} size - 边长（像素）。
 * @returns {{width: number, height: number, rgba: Uint8ClampedArray}} 渲染结果。
 */
export function renderPreset(preset, size) {
  if (preset === null || typeof preset !== 'object') {
    throw new TypeError('renderPreset：preset 必须是 ICON_PRESETS 里的一项')
  }
  // 位图预设（`asset` 型）没有程序化几何：直调本函数只会让 compileFill(undefined)
  // 落到末行的 `[0,0,0]` 兜底，画出一张「黑徽记」脏图（2026-09-23 复审 P3）。
  // 公开入口 renderPresetPng 已提前 return null，这里再挡一道，让越过公开入口的
  // 直调**响亮失败**而不是静默画错 —— 静默错误比崩溃更难发现。
  if (preset.asset !== undefined) {
    throw new TypeError(`renderPreset：位图预设 ${preset.id} 不走程序化渲染（应走 presetAssetPath 取 PNG）`)
  }
  if (preset.mark === undefined) {
    throw new TypeError(`renderPreset：预设 ${preset.id} 缺 mark 字段（缺了会画成黑徽记）`)
  }
  const px = Math.max(16, Math.min(2048, Math.floor(size)))
  const pixel = 1 / px
  const rgba = new Uint8ClampedArray(px * px * 4)

  const baseFill = preset.base === undefined ? null : compileFill(preset.base)
  const markFill = compileFill(preset.mark)
  const baseShape = { kind: 'rect', x: 0, y: 0, w: 1, h: 1, r: CANVAS.radius }
  const markShapes = MARK.map(shape => ({ ...shape, fill: markFill }))

  for (let iy = 0; iy < px; iy += 1) {
    const y = (iy + 0.5) * pixel
    for (let ix = 0; ix < px; ix += 1) {
      const x = (ix + 0.5) * pixel
      // 圆角方遮罩：所有内容只在图标区域内出现
      const mask = coverage(roundRectDistance(x, y, baseShape), pixel)
      if (mask <= 0) continue

      let r = 0
      let g = 0
      let b = 0
      let a = 0

      /** alpha-over 合成一层。 */
      const over = (rgb, alpha) => {
        if (alpha <= 0) return
        const sa = alpha
        const da = a * (1 - sa)
        const outA = sa + da
        if (outA <= 0) return
        r = (rgb[0] * sa + r * a * (1 - sa)) / outA
        g = (rgb[1] * sa + g * a * (1 - sa)) / outA
        b = (rgb[2] * sa + b * a * (1 - sa)) / outA
        a = outA
      }

      // 1) 底：纯色或渐变
      if (baseFill !== null) over(baseFill(x, y), 1)

      // 2) 徽记（六枚图元，统一取 mark 的颜色/渐变）
      for (const shape of markShapes) {
        const cov = coverage(shapeDistance(x, y, shape), pixel)
        if (cov > 0) over(markFill(x, y), cov)
      }

      const offset = (iy * px + ix) * 4
      rgba[offset] = r
      rgba[offset + 1] = g
      rgba[offset + 2] = b
      rgba[offset + 3] = a * mask * 255
    }
  }

  return { width: px, height: px, rgba }
}

/* PNG 编码（CRC32 + chunk 组装 + zlib deflate） */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 组装一个 PNG chunk（长度 + 类型 + 数据 + CRC）。 */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

/**
 * 把 RGBA 像素编码成 PNG（8 位真彩 + alpha，无第三方依赖）。
 * @param {Uint8ClampedArray} rgba - 行主序 RGBA。
 * @param {number} width - 宽。
 * @param {number} height - 高。
 * @returns {Buffer} PNG 字节。
 */
export function encodePng(rgba, width, height) {
  const stride = width * 4
  // 每行前置一个 filter 字节（0 = None）：PNG 规范要求，缺了任何解码器都会报错。
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    for (let i = 0; i < stride; i += 1) raw[y * (stride + 1) + 1 + i] = rgba[y * stride + i]
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 生成一款预设图标的 PNG 字节（仅程序化预设）。
 * @param {string} id - 预设 id。
 * @param {number} size - 边长（默认 512，与面板上传的归一化上限一致）。
 * @returns {Buffer|null} PNG 字节；未知 id 或**位图预设**（`asset` 型）返回 null。
 */
export function renderPresetPng(id, size = 512) {
  const preset = presetById(id)
  if (preset === null || preset.asset !== undefined) return null
  const { width, height, rgba } = renderPreset(preset, size)
  return encodePng(rgba, width, height)
}

/**
 * 位图预设的资源相对路径（相对插件根目录）；程序化预设返回 null。
 * @param {string} id - 预设 id。
 * @returns {string|null} 形如 `assets/presets/portrait.png`。
 */
export function presetAssetPath(id) {
  const preset = presetById(id)
  return preset !== null && typeof preset.asset === 'string' ? preset.asset : null
}
