// M2.7 应用图标预设：绘制器 / PNG 编码 / 预设表的一致性。
//
// 这套断言的意义在于「预设图标是**算出来的**」这个事实：没有二进制资源可比对，
// 所以只能把不变量钉死 —— 圆角外必须透明、圆角内必须不透明、同一 id 必须字节可复现、
// PNG 容器必须合法（签名 + IHDR 尺寸 + IEND）。位图预设（portrait）则断言它走另一条路。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import {
  ICON_PRESETS,
  encodePng,
  presetAssetPath,
  presetById,
  presetFileName,
  presetIdFromUrl,
  presetUrl,
  renderPreset,
  renderPresetPng,
} from '../lib/icon-presets.js'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 取 RGBA 画布上某点的四通道。 */
function pixel(rgba, size, x, y) {
  const i = (y * size + x) * 4
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
}

/** 拆出 PNG 的 chunk 列表（类型 + 数据），顺带验证长度字段自洽。 */
function chunksOf(png) {
  assert.deepEqual(png.subarray(0, 8), PNG_MAGIC, 'PNG 必须带标准签名')
  const chunks = []
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('latin1')
    const data = png.subarray(offset + 8, offset + 8 + length)
    chunks.push({ type, data })
    offset += 12 + length
  }
  assert.equal(offset, png.length, 'chunk 长度必须刚好铺满文件')
  return chunks
}

test('预设表：只有两款（默认 / 头像），id 唯一、标签非空，且每款要么可渲染要么有位图资源', () => {
  assert.equal(ICON_PRESETS.length, 2, '预设只有「默认」与「头像」两款（用户 2026-09-21 拍板）')
  const ids = new Set()
  for (const preset of ICON_PRESETS) {
    assert.match(preset.id, /^[a-z][a-z0-9-]*$/, `${preset.id} 必须是合法 id（文件名要过白名单）`)
    assert.equal(ids.has(preset.id), false, `${preset.id} 重复`)
    ids.add(preset.id)
    assert.equal(typeof preset.label, 'string')
    assert.notEqual(preset.label.trim(), '')
    const renderable = preset.base !== undefined && preset.mark !== undefined
    assert.equal(renderable || typeof preset.asset === 'string', true, `${preset.id} 既不能渲染也没有资源`)
  }
  // 「默认」在首位（九宫格的第一格），「头像」紧随其后
  assert.equal(ICON_PRESETS[0].id, 'default')
  assert.equal(ICON_PRESETS[1].id, 'portrait')
})

test('预设文件名与 URL 往返：都落在跨线契约的白名单形态里', () => {
  for (const preset of ICON_PRESETS) {
    const file = presetFileName(preset.id)
    assert.match(file, /^[\w][\w.-]{0,80}\.png$/, `${file} 必须命中桌面壳侧的白名单`)
    assert.equal(presetUrl(preset.id), `/appearance/avatar/${file}`)
    assert.equal(presetIdFromUrl(presetUrl(preset.id)), preset.id, 'URL 必须能反查回 id')
  }
  assert.equal(presetIdFromUrl('/appearance/avatar/avatar-abc.png'), null, '用户上传的图不是预设')
  assert.equal(presetIdFromUrl('https://example.com/preset-default.png'), null)
  assert.equal(presetIdFromUrl(undefined), null)
  assert.equal(presetById('nope'), null)
})

test('renderPreset：圆角外透明、圆角内不透明、徽记真的画上了', () => {
  const size = 128
  const preset = presetById('default')
  const { width, height, rgba } = renderPreset(preset, size)
  assert.equal(width, size)
  assert.equal(height, size)
  // 四个角在圆角外 → 全透明（否则图标会带四个硬角）
  for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
    assert.equal(pixel(rgba, size, x, y)[3], 0, `(${x},${y}) 必须在圆角外`)
  }
  // 顶边中点与中心在圆角内 → 不透明
  assert.equal(pixel(rgba, size, size >> 1, 0)[3], 255)
  assert.equal(pixel(rgba, size, size >> 1, size >> 1)[3], 255)
  // 徽记：中央圆点处应比同行的底色更亮（default 是深底浅图案）
  const markPixel = pixel(rgba, size, Math.round(size * 0.5), Math.round(size * 0.365))
  const basePixel = pixel(rgba, size, Math.round(size * 0.5), Math.round(size * 0.18))
  assert.equal(markPixel[0] > basePixel[0], true, '中央圆点应当比底色亮')
})

test('renderPreset：同一 id 两次渲染逐字节一致（可复现，便于落盘幂等）', () => {
  const a = renderPresetPng('default', 64)
  const b = renderPresetPng('default', 64)
  assert.deepEqual(a, b, '渲染必须是确定性的，否则每次请求都会重写磁盘')
})

test('renderPresetPng：合法 PNG（签名 / IHDR 尺寸 / IEND），尺寸受钳制', () => {
  const png = renderPresetPng('default', 64)
  assert.deepEqual(png.subarray(0, 8), PNG_MAGIC)
  const chunks = chunksOf(png)
  assert.deepEqual(chunks.map(c => c.type), ['IHDR', 'IDAT', 'IEND'])
  assert.equal(chunks[0].data.readUInt32BE(0), 64)
  assert.equal(chunks[0].data.readUInt32BE(4), 64)
  assert.equal(chunks[0].data[8], 8, '8 位深')
  assert.equal(chunks[0].data[9], 6, 'RGBA 色彩类型')
  // IDAT 能解开，且长度 = 高 × (1 + 宽 × 4)（每行一个 filter 字节）
  const raw = inflateSync(chunks[1].data)
  assert.equal(raw.length, 64 * (1 + 64 * 4))
  // 尺寸钳制：过小/过大都不崩，落在 [16, 2048]
  assert.equal(chunksOf(renderPresetPng('default', 1))[0].data.readUInt32BE(0), 16)
  assert.equal(chunksOf(renderPresetPng('default', 99999))[0].data.readUInt32BE(0), 2048)
  assert.equal(renderPresetPng('nope', 64), null, '未知 id 不产字节')
})

test('encodePng：CRC 与 zlib 流自洽（无第三方编码器可依赖，这条是唯一防线）', () => {
  const rgba = new Uint8ClampedArray(4 * 2 * 2)
  rgba.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 0])
  const png = encodePng(rgba, 2, 2)
  const chunks = chunksOf(png)
  // CRC 自查：重算每个 chunk 的 CRC 必须与文件里写的一致
  const table = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })()
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i += 1) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  let offset = 8
  for (const chunk of chunks) {
    const declared = png.readUInt32BE(offset + 8 + chunk.data.length)
    const typeAndData = png.subarray(offset + 4, offset + 8 + chunk.data.length)
    assert.equal(declared, crc32(typeAndData), `${chunk.type} 的 CRC 必须正确`)
    offset += 12 + chunk.data.length
  }
  // 像素顺序保持不变：每行前缀一个 filter 字节（0），其余原样
  const raw = inflateSync(chunks.find(c => c.type === 'IDAT').data)
  assert.deepEqual([...raw], [
    0, 255, 0, 0, 255, 0, 255, 0, 255, // filter + 第一行两个像素
    0, 0, 0, 255, 255, 255, 255, 255, 0, // filter + 第二行两个像素
  ])
})

test('位图预设：走资源不走绘制器，且资源确实在仓库里', () => {
  const asset = presetAssetPath('portrait')
  assert.equal(asset, 'assets/presets/portrait.png')
  assert.equal(renderPresetPng('portrait', 64), null, '位图预设不参与程序化渲染')
  assert.equal(presetAssetPath('default'), null)
  const full = new URL(`../${asset}`, import.meta.url)
  assert.equal(existsSync(full), true, '位图预设的资源必须入库')
  const bytes = readFileSync(full)
  assert.deepEqual(bytes.subarray(0, 8), PNG_MAGIC, '资源必须是 PNG')
  const chunks = chunksOf(bytes)
  assert.equal(chunks[0].data.readUInt32BE(0), 512)
  assert.equal(chunks[0].data.readUInt32BE(4), 512)
})
