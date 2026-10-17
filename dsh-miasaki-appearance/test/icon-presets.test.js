// M2.7 应用图标预设：预设表 / 命名 / URL / 位图资源的一致性。
//
// 2026-10-14：程序化「默认」款退役（用户「预设的这个图标删掉」），随之删除的还有
// 渲染与 PNG 编码两条链（它们唯一的消费者就是「默认」）—— 当时钉渲染不变量的用例
// （圆角外透明 / 两次渲染逐字节一致 / PNG 容器合法 / 尺寸钳制）一并退场。
// 本文件收敛为：**三款位图预设**的不变量 + 命名 / URL 往返 + 退役 id 不得复活。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import {
  ICON_PRESETS,
  presetAssetPath,
  presetById,
  presetFileName,
  presetIdFromUrl,
  presetUrl,
} from '../lib/icon-presets.js'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

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

test('预设表：三款位图（头像 / 立绘 / 现行），id 唯一、标签非空、每款都带资源', () => {
  assert.equal(ICON_PRESETS.length, 3, '2026-10-14 删掉程序化「默认」后，只剩三款位图')
  const ids = new Set()
  for (const preset of ICON_PRESETS) {
    assert.match(preset.id, /^[a-z][a-z0-9-]*$/, `${preset.id} 必须是合法 id（文件名要过白名单）`)
    assert.equal(ids.has(preset.id), false, `${preset.id} 重复`)
    ids.add(preset.id)
    assert.equal(typeof preset.label, 'string')
    assert.notEqual(preset.label.trim(), '')
    // 程序化渲染（base / mark）已随「默认」退役：每款必须是位图预设
    assert.equal(typeof preset.asset, 'string', `${preset.id} 必须带 asset 资源路径`)
  }
  assert.deepEqual(ICON_PRESETS.map(p => p.id), ['portrait', 'illustration', 'current'])
})

test('预设文件名与 URL 往返：都落在跨线契约的白名单形态里', () => {
  for (const preset of ICON_PRESETS) {
    const file = presetFileName(preset.id)
    assert.match(file, /^[\w][\w.-]{0,80}\.png$/, `${file} 必须命中桌面壳侧的白名单`)
    assert.equal(presetUrl(preset.id), `/appearance/avatar/${file}`)
    assert.equal(presetIdFromUrl(presetUrl(preset.id)), preset.id, 'URL 必须能反查回 id')
  }
  assert.equal(presetIdFromUrl('/appearance/avatar/avatar-abc.png'), null, '用户上传的图不是预设')
  assert.equal(presetIdFromUrl('https://example.com/preset-portrait.png'), null, '非同源路由不是预设')
  // 2026-10-14：「默认」已退役 —— 旧配置 / 旧截图里的 preset-default.png 不得再被
  // 识别成预设（否则面板会把一个不存在的款当成在役预设显示）。
  assert.equal(presetIdFromUrl('/appearance/avatar/preset-default.png'), null, '已退役的预设 URL 不得反查出 id')
  assert.equal(presetById('default'), null, '已退役的 id 取不到预设')
  assert.equal(presetIdFromUrl(undefined), null)
  assert.equal(presetById('nope'), null)
})

test('位图预设：走资源不走绘制器，且资源确实在仓库里（512 方图 + 标准 PNG 容器）', () => {
  // 2026-09-23 起位图预设三款：portrait / illustration / current。
  const bitmap = { portrait: 'assets/presets/portrait.png', illustration: 'assets/presets/illustration.png', current: 'assets/presets/current.png' }
  for (const [id, asset] of Object.entries(bitmap)) {
    assert.equal(presetAssetPath(id), asset)
    const full = new URL(`../${asset}`, import.meta.url)
    assert.equal(existsSync(full), true, `位图预设 ${id} 的资源必须入库`)
    const bytes = readFileSync(full)
    assert.deepEqual(bytes.subarray(0, 8), PNG_MAGIC, `${id} 资源必须是 PNG`)
    const chunks = chunksOf(bytes)
    assert.equal(chunks[0].data.readUInt32BE(0), 512, `${id} 资源必须是 512 宽`)
    assert.equal(chunks[0].data.readUInt32BE(4), 512, `${id} 资源必须是 512 高`)
  }
  // 退役 id 与未知 id 一视同仁：没有资源路径
  assert.equal(presetAssetPath('default'), null, '已退役的「默认」不得再有资源路径')
  assert.equal(presetAssetPath('nope'), null)
})
