// @miasaki/dsh-appearance — 配置模型与契约判定（纯逻辑，无运行时依赖）。
//
// 这里只放三件与运行时无关的事：默认值、类型收窄与钳制、首帧注入文本的生成。
// 判定逻辑放这里而不是 client 半，是因为 client bundle 由 ModuleLoader 装载、
// **不能 import**（只能 require('react')），所以浏览器只负责「采集事实」，
// 判定与归一化一律由 Host 侧执行 —— 这样这一段可以直接被单测覆盖。
import { avatarFileFromSource } from './avatar.js'

/** 配置版本；结构不兼容变更时 +1，并在 migrateConfig 里补一条迁移分支。 */
export const CONFIG_VERSION = 3

/** 皮肤白名单。M1 只有「纯净」；M2 下沉 desktop 线的刻刻帝 / 狂狂帝。 */
export const SKINS = Object.freeze(['pure', 'zafkiel', 'kurkuriel'])

/** 明暗偏好 —— 取值必须与官方 ctx.theme.setTheme 接受的一致。 */
export const SCHEMES = Object.freeze(['light', 'dark', 'system'])

/** 动效预设（M3）。 */
export const MOTION_PRESETS = Object.freeze(['fluid', 'elegant', 'minimal'])

/** 会话密度（M4）。 */
export const DENSITIES = Object.freeze(['comfortable', 'compact'])

/** 官方字号轴边界（与 dsh-client-ui-theme 的 FONT_SIZE_MIN/MAX 对齐）。 */
export const FONT_SIZE_MIN = 12
export const FONT_SIZE_MAX = 17

/** 壁纸模糊档位边界（px）。 */
export const BLUR_MIN = 0
export const BLUR_MAX = 60

/** 玻璃档位（M2 设计 §5.3）：off = 原生观感。 */
export const GLASS_LEVELS = Object.freeze(['off', 'light', 'frost', 'mica'])

/** 壁纸铺排方式。 */
export const WALLPAPER_FITS = Object.freeze(['cover', 'contain', 'tile'])

/** 壁纸焦点（background-position）。 */
export const WALLPAPER_FOCUSES = Object.freeze(['center', 'top', 'bottom', 'left', 'right'])

/** 表面不透明度旋钮范围（0–100，100 = 不透明）。 */
export const SURFACE_MIN = 0
export const SURFACE_MAX = 100

/** 暗色遮罩强度边界（0–100）。 */
export const SCRIM_MIN = 0
export const SCRIM_MAX = 100

/** 动效强度倍率边界。 */
export const SCALE_MIN = 0.5
export const SCALE_MAX = 1.5

/** 会话最大宽度边界（px）；0 = 用官方默认。 */
export const MAX_WIDTH_MIN = 0
export const MAX_WIDTH_MAX = 1600

/** 单片字符串字段的上限，防止把配置文件当数据通道用。 */
const MAX_TEXT = 512

/**
 * 出厂配置。**总开关默认关闭**——「未配置的外观线对页面零影响」是本线的硬契约，
 * 也是验收项（停用插件后与原生截图逐像素一致）。
 */
export const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  enabled: false,
  theme: Object.freeze({ skin: 'pure', scheme: 'system', accent: '', fontSize: 14 }),
  wallpaper: Object.freeze({
    source: '', light: '', dark: '', blur: 0, scrim: 0,
    fit: 'cover', focus: 'center', glass: 'off', vignette: 0,
    surface: Object.freeze({ sidebar: 100, conversation: 100, composer: 100, overlay: 100 }),
  }),
  // 软件头像（M2.5）：一张 PNG，浏览器侧归一化后落在 `<dataDir>/avatars/`；
  // 除本线设置面板外，**桌面壳也读同一份配置**（窗口 / 任务栏 / 托盘图标），
  // 因此这里的字段是跨线契约，改动需同步 dsh-miasaki-desktop 的 launcher_icon 模块。
  avatar: Object.freeze({ source: '' }),
  motion: Object.freeze({ enabled: false, preset: 'fluid', scale: 1 }),
  conversation: Object.freeze({ density: 'comfortable', maxWidth: 0 }),
})

// ---------------------------------------------------------------------------
// 收窄原语。磁盘上的内容与浏览器发来的 JSON 一律视为不可信输入。

/** 取整并夹进区间；非有限数回退。 */
function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** 取数并夹进区间；保留小数。 */
function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** 白名单取值；不在表内回退。 */
function pickEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/** 布尔量；只认真正的 boolean 与字符串 "true"/"false"。 */
function toBoolean(value, fallback) {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return fallback
}

/** 截断字符串并去首尾空白。 */
function toText(value, fallback = '') {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > MAX_TEXT ? trimmed.slice(0, MAX_TEXT) : trimmed
}

/** 强调色只接受 #rgb / #rrggbb 或空串（空 = 跟随主题品牌色）。 */
function toAccent(value) {
  const text = toText(value)
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(text) ? text.toLowerCase() : ''
}

/** 壁纸图源只接受空串、内置 id、同源绝对路径、http(s) URL。 */
function toWallpaperSource(value) {
  const text = toText(value)
  if (text === '') return ''
  if (/^builtin:[a-z0-9-]{1,40}$/.test(text)) return text
  if (text.startsWith('/') && !text.startsWith('//')) return text
  if (/^https?:\/\/[^\s]+$/.test(text)) return text
  return ''
}

/**
 * 头像图源只接受空串或**本线头像路由下的白名单文件**。
 *
 * 比壁纸严得多，因为它是跨线输入：桌面壳（Miasaki.exe）会读同一份配置去取图标，
 * 只认 `/appearance/avatar/<白名单文件名>` 意味着壳侧永远只读自己那一个本地目录，
 * 既不需要联网，也没有第二个路径穿越面。
 */
function toAvatarSource(value) {
  const text = toText(value)
  if (text === '') return ''
  return avatarFileFromSource(text) === null ? '' : text
}

/** 把一个板块的原始输入收窄成对象（非对象一律当空对象）。 */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

// ---------------------------------------------------------------------------
// 迁移与归一化

/**
 * 版本迁移。M1 只有 v1，函数体是骨架：新增版本时在此串一条分支，
 * 保证「旧配置 + 新字段」不会留下空洞。
 * @param {object} raw - 磁盘上的原始配置。
 * @returns {object} 迁移后的原始配置（仍未经 sanitize）。
 */
export function migrateConfig(raw) {
  const source = asRecord(raw)
  const version = clampInt(source.version, 0, CONFIG_VERSION, 0)
  if (version >= CONFIG_VERSION) return source
  // v0（无 version 字段）→ v1：v1 引入前没有任何已发布字段，直接补齐版本号。
  // v1 → v2：wallpaper 增量字段（light/dark/fit/focus/glass/vignette/surface）——
  // 全部纯新增，sanitizeConfig 对缺失字段回退默认，这里只需抬版本号让 sanitize 补齐。
  // v2 → v3：avatar 板块（软件头像）—— 同样纯新增，旧配置补 `avatar.source = ''`（= 不设置，
  // 桌面壳继续用出厂图标），因此没有需要搬运的旧字段。
  return { ...source, version: CONFIG_VERSION }
}

/**
 * 只保留已知字段并钳制取值。未知字段丢弃，非法值回退默认。
 * @param {object} raw - 任意来源的配置候选。
 * @returns {object} 归一化后的配置（新对象，可直接落盘或下发）。
 */
export function sanitizeConfig(raw) {
  const source = migrateConfig(raw)
  const theme = asRecord(source.theme)
  const wallpaper = asRecord(source.wallpaper)
  const avatar = asRecord(source.avatar)
  const motion = asRecord(source.motion)
  const conversation = asRecord(source.conversation)

  return {
    version: CONFIG_VERSION,
    enabled: toBoolean(source.enabled, DEFAULT_CONFIG.enabled),
    theme: {
      skin: pickEnum(theme.skin, SKINS, DEFAULT_CONFIG.theme.skin),
      scheme: pickEnum(theme.scheme, SCHEMES, DEFAULT_CONFIG.theme.scheme),
      accent: toAccent(theme.accent),
      fontSize: clampInt(theme.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, DEFAULT_CONFIG.theme.fontSize),
    },
    wallpaper: {
      source: toWallpaperSource(wallpaper.source),
      light: toWallpaperSource(wallpaper.light),
      dark: toWallpaperSource(wallpaper.dark),
      blur: clampInt(wallpaper.blur, BLUR_MIN, BLUR_MAX, DEFAULT_CONFIG.wallpaper.blur),
      scrim: clampInt(wallpaper.scrim, SCRIM_MIN, SCRIM_MAX, DEFAULT_CONFIG.wallpaper.scrim),
      fit: pickEnum(wallpaper.fit, WALLPAPER_FITS, DEFAULT_CONFIG.wallpaper.fit),
      focus: pickEnum(wallpaper.focus, WALLPAPER_FOCUSES, DEFAULT_CONFIG.wallpaper.focus),
      glass: pickEnum(wallpaper.glass, GLASS_LEVELS, DEFAULT_CONFIG.wallpaper.glass),
      vignette: clampInt(wallpaper.vignette, SCRIM_MIN, SCRIM_MAX, DEFAULT_CONFIG.wallpaper.vignette),
      surface: {
        sidebar: clampInt(asRecord(wallpaper.surface).sidebar, SURFACE_MIN, SURFACE_MAX, 100),
        conversation: clampInt(asRecord(wallpaper.surface).conversation, SURFACE_MIN, SURFACE_MAX, 100),
        composer: clampInt(asRecord(wallpaper.surface).composer, SURFACE_MIN, SURFACE_MAX, 100),
        overlay: clampInt(asRecord(wallpaper.surface).overlay, SURFACE_MIN, SURFACE_MAX, 100),
      },
    },
    avatar: {
      source: toAvatarSource(avatar.source),
    },
    motion: {
      enabled: toBoolean(motion.enabled, DEFAULT_CONFIG.motion.enabled),
      preset: pickEnum(motion.preset, MOTION_PRESETS, DEFAULT_CONFIG.motion.preset),
      scale: clampNumber(motion.scale, SCALE_MIN, SCALE_MAX, DEFAULT_CONFIG.motion.scale),
    },
    conversation: {
      density: pickEnum(conversation.density, DENSITIES, DEFAULT_CONFIG.conversation.density),
      maxWidth: clampInt(conversation.maxWidth, MAX_WIDTH_MIN, MAX_WIDTH_MAX, DEFAULT_CONFIG.conversation.maxWidth),
    },
  }
}

/**
 * 把一次「部分更新」深合并进当前配置（按板块一层）。面板每次只发改动的字段，
 * 因此这里必须逐板块合并，而不是整体替换。
 * @param {object} current - 当前已生效配置。
 * @param {object} patch - 部分配置（可只含某板块的某个字段）。
 * @returns {object} 合并并归一化后的配置。
 */
export function mergeConfig(current, patch) {
  const base = sanitizeConfig(current)
  const incoming = asRecord(patch)
  // wallpaper.surface 必须逐旋钮合并：面板每次只发改动的那个旋钮，整块浅合并会把
  // 未提交的旋钮重置回默认（100）——M2 S5 实机面板空白修复时一并发现。
  const incomingWallpaper = asRecord(incoming.wallpaper)
  const mergedSurface = incomingWallpaper.surface === undefined
    ? base.wallpaper.surface
    : { ...base.wallpaper.surface, ...asRecord(incomingWallpaper.surface) }
  return sanitizeConfig({
    ...base,
    ...incoming,
    theme: { ...base.theme, ...asRecord(incoming.theme) },
    wallpaper: { ...base.wallpaper, ...incomingWallpaper, surface: mergedSurface },
    avatar: { ...base.avatar, ...asRecord(incoming.avatar) },
    motion: { ...base.motion, ...asRecord(incoming.motion) },
    conversation: { ...base.conversation, ...asRecord(incoming.conversation) },
  })
}

/**
 * 深度比较两份配置是否等价 —— 用于判断一次写入是否真的改变了什么，
 * 避免每次面板打开都触发一次磁盘写与一次首帧快照重算。
 * @param {object} left - 已归一化配置。
 * @param {object} right - 已归一化配置。
 * @returns {boolean} 是否逐字段相等。
 */
export function configEquals(left, right) {
  return JSON.stringify(sanitizeConfig(left)) === JSON.stringify(sanitizeConfig(right))
}

// ---------------------------------------------------------------------------
// 首帧注入文本

/**
 * 首帧门控脚本。在 body 开标签之后、shell 挂载之前执行（webserver/index-inject
 * 的 `body` placement），因此**不能依赖任何插件、不能抛异常**。
 *
 * 只做一件事：把归一化后的开关与皮肤写成 `<html>` 上的属性，供后续
 * CSS 选择器与 client 半接管。总开关关闭时属性为 "off"，页面表现与原生完全一致。
 * @param {object} config - 已归一化配置。
 * @returns {string} 内联脚本正文。
 */
export function buildBootScript(config) {
  const safe = sanitizeConfig(config)
  const state = JSON.stringify(safe.enabled ? 'on' : 'off')
  const skin = JSON.stringify(safe.theme.skin)
  const scheme = JSON.stringify(safe.theme.scheme)
  const glass = JSON.stringify(safe.enabled ? safe.wallpaper.glass : 'off')
  // 壁纸标记：desktop 装饰层据此把自家光晕（#miasaki-aurora）降为透明，避免两层氛围打架。
  const wallpaper = JSON.stringify(safe.enabled && safe.wallpaper.source !== '' ? 'on' : 'off')
  return `(() => { try { const r = document.documentElement; r.setAttribute('data-mia-appearance', ${state}); r.setAttribute('data-mia-skin', ${skin}); r.setAttribute('data-mia-scheme', ${scheme}); r.setAttribute('data-mia-glass', ${glass}); r.setAttribute('data-mia-wallpaper', ${wallpaper}) } catch (e) { /* 首帧注入不得抛错 */ } })()`
}

/**
 * 首帧样式（head placement）。M1 返回空串（不注入 style 行）；
 * M2 皮肤下沉后由这里产出静态色阶，避免「先原生后外观」的闪色。
 *
 * 产出形态（M2 设计 §6.1）：按 `data-mia-skin` 属性选择器覆盖双明暗——
 * 官方明暗由 `body[data-ds-dark-theme]` 属性驱动，CSS 选择器天然动态匹配，
 * 首帧脚本不需要猜偏好。token 表与运行时 `overrideTokens` 消费同一份
 * （`lib/skins/*.js`，host 半 import 后传入），两处值一致 → presenter 接管后无跳变。
 * `{light,dark}` 同值对下两段内容相同，保留双段是对冲官方将来在 dark 段恢复 per-token 差异。
 *
 * @param {object} config - 已归一化配置。
 * @param {object|null} skinTokens - 皮肤 token 表（`lib/skins/<skin>.js` 的 tokens；
 *   `{ "--x": {light, dark} }`）。pure 或未提供时返回空串。
 * @returns {string} CSS 文本；空串表示本次不注入。
 */
export function buildBootStyle(config, skinTokens, builtinWallpapers) {
  const safe = sanitizeConfig(config)
  if (!safe.enabled) return ''
  const parts = []
  const skinCss = buildSkinBootCss(safe, skinTokens)
  if (skinCss !== '') parts.push(skinCss)
  const wallpaperCss = buildWallpaperBootCss(safe, builtinWallpapers)
  if (wallpaperCss !== '') parts.push(wallpaperCss)
  const glassCss = buildGlassBootCss(safe)
  if (glassCss !== '') parts.push(glassCss)
  return parts.join('\n')
}

/** 皮肤段：双段属性选择器展开 token 表（M2 §6.1）。 */
function buildSkinBootCss(safe, skinTokens) {
  if (safe.theme.skin === 'pure' || skinTokens === null || skinTokens === undefined) return ''
  const names = Object.keys(skinTokens).sort()
  if (names.length === 0) return ''
  const light = names.map(n => `  ${n}: ${skinTokens[n].light};`).join('\n')
  const dark = names.map(n => `  ${n}: ${skinTokens[n].dark};`).join('\n')
  const skin = JSON.stringify(safe.theme.skin)
  return `html[data-mia-skin=${skin}] body {\n${light}\n}\nhtml[data-mia-skin=${skin}] body[data-ds-dark-theme] {\n${dark}\n}`
}

/** 双重背景的序：遮罩在最上、晕影次之、壁纸图最底。 */
function wallpaperLayerCss(wallpaper, builtinWallpapers) {
  const layers = []
  if (wallpaper.scrim > 0) {
    layers.push(`linear-gradient(rgba(0, 0, 0, ${(wallpaper.scrim / 100).toFixed(2)}), rgba(0, 0, 0, ${(wallpaper.scrim / 100).toFixed(2)}))`)
  }
  if (wallpaper.vignette > 0) {
    layers.push(`radial-gradient(ellipse at center, rgba(0, 0, 0, 0) 55%, rgba(0, 0, 0, ${(wallpaper.vignette / 100).toFixed(2)}) 100%)`)
  }
  if (wallpaper.source !== '') {
    const builtin = asRecord(builtinWallpapers)[wallpaper.source.slice('builtin:'.length)]
    if (wallpaper.source.startsWith('builtin:')) {
      // 内置壁纸是程序化 CSS 渐变（零资产）；未知 id 视为无效源，不注入（配置面已白名单）。
      if (typeof builtin === 'string') layers.push(builtin)
    } else {
      layers.push(`url("${wallpaper.source.replace(/\\/g, '/').replace(/"/g, '%22')}")`)
    }
  }
  if (layers.length === 0) return null
  const repeat = wallpaper.fit === 'tile' ? 'repeat' : 'no-repeat'
  const size = wallpaper.fit === 'tile' ? 'auto' : wallpaper.fit
  return (
    `body::before {\n` +
    `  content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;\n` +
    `  background-image: ${layers.join(', ')};\n` +
    `  background-size: ${size}; background-position: ${wallpaper.focus}; background-repeat: ${repeat};\n` +
    `}`
  )
}

function buildWallpaperBootCss(safe, builtinWallpapers) {
  const css = wallpaperLayerCss(safe.wallpaper, builtinWallpapers)
  return css === null ? '' : css
}

/** 玻璃段：三条 slot 实盒子规则（S1a 探针定稿的命中路径），composer/settings 降级纯 alpha。 */
function buildGlassBootCss(safe) {
  const glass = safe.wallpaper.glass
  if (glass === 'off') return ''
  const blur = { light: 'blur(8px)', frost: 'blur(20px) saturate(1.4)', mica: 'blur(40px) saturate(1.6)' }[glass]
  if (blur === undefined) return ''
  return (
    `html[data-mia-glass=${JSON.stringify(glass)}] [data-slot="sidebar"] > *,\n` +
    `html[data-mia-glass=${JSON.stringify(glass)}] [data-slot="main.conversation"] > *,\n` +
    `html[data-mia-glass=${JSON.stringify(glass)}] [data-slot="rightbar"] > * {\n` +
    `  backdrop-filter: ${blur};\n` +
    `}`
  )
}

/**
 * params 层（client 半 overrideTokens 的 'appearance:params' source）的表面不透明度覆盖表。
 * 表面旋钮（0–100）映射到 6 个半透明 alias（M2 设计 §5.4）；值用 color-mix 引用官方端点
 * static —— 解析发生在 body（皮肤已覆盖），自动跟明暗、跟皮肤。100 = 不输出（保持原生）。
 * @param {object} config - 已归一化配置。
 * @returns {object|null} overrideTokens 可吃的表；全部 100 时返回 null（无需注册层）。
 */
export function buildSurfaceTokens(config) {
  const safe = sanitizeConfig(config)
  const { sidebar, conversation, composer, overlay } = safe.wallpaper.surface
  // 官方 alias → static 端点（design-platform.css light/dark 两段的映射，S1b 复读实测）
  const ENDPOINTS = {
    '--dsw-specific-sidebar-fill': ['neutral-bluish-950', 'neutral-bluish-00'],
    '--dsw-alias-bg-base': ['neutral-bluish-950', 'neutral-bluish-00'],
    '--dsw-alias-bg-layer-1': ['neutral-bluish-900', 'neutral-bluish-00'],
    '--dsw-alias-bg-layer-2': ['neutral-bluish-850', 'neutral-bluish-00'],
    '--dsw-alias-bg-module-platform': ['neutral-bluish-900', 'neutral-bluish-00'],
    '--dsw-alias-bg-overlay': ['neutral-bluish-850', 'neutral-bluish-00'],
  }
  const mix = (percent, endpoint) =>
    `color-mix(in srgb, var(--dsw-static-${endpoint}) ${percent}%, transparent)`
  const out = {}
  const put = (name, percent) => {
    if (percent >= 100) return
    const [dark, light] = ENDPOINTS[name]
    const p = Math.max(percent, 0).toFixed(0)
    out[name] = { light: mix(p, light), dark: mix(p, dark) }
  }
  put('--dsw-specific-sidebar-fill', sidebar)
  put('--dsw-alias-bg-base', conversation)
  put('--dsw-alias-bg-layer-1', conversation)
  put('--dsw-alias-bg-layer-2', conversation)
  put('--dsw-alias-bg-module-platform', composer)
  put('--dsw-alias-bg-overlay', overlay)
  return Object.keys(out).length === 0 ? null : out
}

// ---------------------------------------------------------------------------
// 契约自检

/**
 * 判定一次契约探针的结果。浏览器只负责采集事实（服务是否存在、锚点是否在位、
 * token 是否可读），判定规则集中在这里，便于单测与后续扩项。
 *
 * 级别语义：`error` = 该板块不可用（面板显示黄条并禁用相关控件）；
 * `warn` = 可用但行为会降级（例如桌面壳主题已接管，本线主题板块让位）。
 * @param {object} probe - 浏览器采集到的事实。
 * @returns {{ok: boolean, issues: Array<{level: string, code: string, message: string}>}}
 */
export function evaluateContract(probe) {
  const facts = asRecord(probe)
  const services = asRecord(facts.services)
  const methods = asRecord(facts.themeMethods)
  const anchors = asRecord(facts.anchors)
  const tokens = asRecord(facts.tokens)
  const issues = []

  if (services.theme !== true) {
    issues.push({ level: 'error', code: 'theme-service-missing', message: '未取到官方主题服务（ctx.theme）——明暗与字号不可用，请确认 DSH 版本 ≥ 0.1.5-rc.1' })
  } else {
    for (const [name, label] of [['getTheme', 'getTheme'], ['setTheme', 'setTheme'], ['setFontSize', 'setFontSize'], ['overrideTokens', 'overrideTokens']]) {
      if (methods[name] !== true) {
        issues.push({ level: 'error', code: `theme-method-missing:${name}`, message: `主题服务缺少 ${label}()——DSH 可能已升级并调整了接口，该板块已自动禁用` })
      }
    }
  }

  if (services.slots !== true) {
    issues.push({ level: 'error', code: 'slots-service-missing', message: '未取到插槽服务（ctx.slots）——外观页无法注册' })
  }

  if (anchors.main !== true) {
    issues.push({ level: 'warn', code: 'anchor-main-missing', message: '未找到中栏锚点 [data-slot="main"]——动效与会话效果将降级为不生效（不报错）' })
  }

  if (tokens.aliasBgBase !== true) {
    issues.push({ level: 'warn', code: 'token-alias-missing', message: '未能读到官方别名 token（--dsw-alias-bg-base）——壁纸与玻璃档位可能不可见' })
  }
  if (tokens.staticDeepseek500 !== true) {
    issues.push({ level: 'warn', code: 'token-static-missing', message: '未能读到静态色阶（--dsw-static-deepseek-500）——皮肤色阶可能无法覆盖' })
  }

  // M2 §8：皮肤生效抽查——client 上报若干代表 token 的期望值（来自 /skin 的表）与
  // 实测 computed 值；不一致说明 override 层未生效（典型原因：client 半更新后未重启 host）。
  const spot = Array.isArray(facts.skinSpot) ? facts.skinSpot : []
  const spotMiss = spot.filter(s => asRecord(s).expected !== asRecord(s).actual)
  if (spot.length > 0 && spotMiss.length > 0) {
    issues.push({
      level: 'warn',
      code: 'skin-token-miss',
      message: `皮肤可能未完全生效（${spotMiss.length}/${spot.length} 个抽查 token 不符，如 ${spotMiss[0].name}）——请重启 dsh web`,
    })
  }

  // M2 §8：玻璃锚点命中——档位非 off 但锚点未命中时降级提示（S1a 探针定稿的三条路径，
  // 任一命中即至少部分玻璃生效；全部未命中说明页面结构变了，玻璃已无效果）。
  const glass = typeof facts.glass === 'string' ? facts.glass : 'off'
  const glassAnchors = asRecord(facts.glassAnchors)
  if (glass !== 'off') {
    const hits = Object.values(glassAnchors).filter(Boolean).length
    if (hits === 0) {
      issues.push({
        level: 'warn',
        code: 'glass-anchor-miss',
        message: '该容器不支持毛玻璃（锚点未命中），已降级为纯透明分层',
      })
    }
  }

  // M2 §8：让位协议的双向保险。desktop 在位（data-miasaki-theme）且本线皮肤接管中
  // （appearance on + 皮肤非 pure）时，desktop 必须已置让位标记（data-miasaki-theme-yield）；
  // 未让位 = 两个引擎同时写 token（唯一不可接受的冲突）→ error 级，面板禁用皮肤板块。
  const skinNow = typeof facts.skin === 'string' ? facts.skin : 'pure'
  const appearanceOn = documentFriendly(facts.mia)
  if (facts.desktopTheme === true) {
    if (appearanceOn && skinNow !== 'pure' && facts.desktopYield !== true) {
      issues.push({
        level: 'error',
        code: 'override-conflict',
        message: '检测到桌面壳主题引擎未按协议让位（缺 data-miasaki-theme-yield 标记）——皮肤板块已停用，请更新桌面壳（appearance 线 S6 版本）',
      })
    } else if (appearanceOn !== true && facts.desktopYield !== true) {
      issues.push({ level: 'warn', code: 'desktop-theme-active', message: '检测到桌面壳主题引擎在位（html[data-miasaki-theme]）——按让位协议，本线主题板块先让位，避免两套主题互相覆盖' })
    }
  }

  // M2.5：client 更新而 host 未重启时，配置里根本没有 avatar 板块（旧 sanitize 会把它丢掉），
  // 面板上的头像设置会静默失效 —— 明确报出来，而不是让用户以为功能坏了。
  // 只在探针**明确报了 false** 时判定：旧 client（不认识该字段）不上报，不能误报。
  if (facts.avatarField === false) {
    issues.push({
      level: 'warn',
      code: 'avatar-host-stale',
      message: 'Host 半尚未认识「软件头像」（配置里没有 avatar 字段）——请重启 dsh web，否则头像设置无法保存',
    })
  }

  return { ok: issues.length === 0, issues }
}

/** html 门控属性是否为 "on"（客户端 boot script 写入的只有 on/off 两值）。 */
function documentFriendly(mia) {
  return mia === 'on'
}
