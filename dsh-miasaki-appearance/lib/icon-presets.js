// @miasaki/dsh-appearance — 应用图标预设表与命名 / URL 工具（纯逻辑，只用 Node 内建模块）。
//
// 2026-10-14：**程序化「默认」款退役**（用户「预设的这个图标删掉」）——随之删除的还有
// 整条程序化渲染链（SDF 距离场 / 解析式抗锯齿 / alpha-over 合成 / 手写 PNG 编码）。
// 那条链**唯一的消费者就是「默认」**：位图预设走 `asset` 读插件自带 PNG，从不绘制。
// 留着一堆没有消费者的渲染代码，比删掉更危险（下一个改预设的人要先读懂一套没人用的光栅器，
// 才知道自己的改动会不会踩到它）。本文件因此收敛为：**位图预设表 + 命名 / URL 工具**。
//
// 历史备查（均已随代码删除，勿再引用）：程序化渲染见 git 历史 2026-09-21 首版
// （`design/2026-09-21-appearance-icon-presets-design.md` 有当日的渲染管线与骨架选定记录）；
// renderPreset / renderPresetPng / encodePng 三个导出在 2026-10-14 前存在。

/* ---------------------------------------------------------------- 预设表 */

/**
 * 预设表。
 *
 * **三款位图预设**（2026-09-23 由用户拍板「三款鲸鱼娘图标全进预设」；2026-10-14 删掉
 * 程序化「默认」款后剩这三款）：
 *  - 「头像」（portrait）：最早进预设的图（trim 黑边 → 居中裁方 → 512 → 圆角 → 量化）；
 *  - 「立绘」（illustration）与「现行」（current）：同日追加的两张鲸鱼娘构图，
 *    「现行」是现行 EXE 图标同款艺术图（`dsh-miasaki-desktop/src-tauri/icon-new.png`），
 *    面板拿它当「出厂图标」的近似预览。三者同角色不同构图，用户在面板里随场景挑；
 *    命名约定沿用"内容是什么就叫什么"。
 *
 * 源图与处理配方见 `assets/presets/README.md`。位图预设对 host 是同一个接口：
 * 「给一个预设 id，拿一份 PNG 字节」，落盘路径（`avatars/preset-<id>.png`）与
 * 跨线契约（桌面壳只认 `avatars/<白名单文件名>`）完全一致。
 *
 * 将来若要加款：**优先继续进位图**（资源入库 `assets/presets/`）；若确需程序化生成，
 * 先想清楚渲染链要落在哪 —— 本线硬纪律是零第三方依赖，重写一套光栅器不是小决定。
 */
export const ICON_PRESETS = Object.freeze([
  Object.freeze({
    id: 'portrait',
    label: '头像',
    asset: 'assets/presets/portrait.png',
  }),
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

/**
 * 位图预设的资源相对路径（相对插件根目录）；未知 id 返回 null。
 * @returns {string|null} 形如 `assets/presets/portrait.png`。
 */
export function presetAssetPath(id) {
  const preset = presetById(id)
  return preset !== null && typeof preset.asset === 'string' ? preset.asset : null
}
