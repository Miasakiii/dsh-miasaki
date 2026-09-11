// @miasaki/dsh-appearance — 配置模型与契约判定（纯逻辑，无运行时依赖）。
//
// 这里只放三件与运行时无关的事：默认值、类型收窄与钳制、首帧注入文本的生成。
// 判定逻辑放这里而不是 client 半，是因为 client bundle 由 ModuleLoader 装载、
// **不能 import**（只能 require('react')），所以浏览器只负责「采集事实」，
// 判定与归一化一律由 Host 侧执行 —— 这样这一段可以直接被单测覆盖。

/** 配置版本；结构不兼容变更时 +1，并在 migrateConfig 里补一条迁移分支。 */
export const CONFIG_VERSION = 1

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
  wallpaper: Object.freeze({ source: '', blur: 0, scrim: 0 }),
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
      blur: clampInt(wallpaper.blur, BLUR_MIN, BLUR_MAX, DEFAULT_CONFIG.wallpaper.blur),
      scrim: clampInt(wallpaper.scrim, SCRIM_MIN, SCRIM_MAX, DEFAULT_CONFIG.wallpaper.scrim),
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
  return sanitizeConfig({
    ...base,
    ...incoming,
    theme: { ...base.theme, ...asRecord(incoming.theme) },
    wallpaper: { ...base.wallpaper, ...asRecord(incoming.wallpaper) },
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
  return `(() => { try { const r = document.documentElement; r.setAttribute('data-mia-appearance', ${state}); r.setAttribute('data-mia-skin', ${skin}); r.setAttribute('data-mia-scheme', ${scheme}) } catch (e) { /* 首帧注入不得抛错 */ } })()`
}

/**
 * 首帧样式（head placement）。M1 返回空串（不注入 style 行）；
 * M2 皮肤下沉后由这里产出静态色阶，避免「先原生后外观」的闪色。
 * @param {object} config - 已归一化配置。
 * @returns {string} CSS 文本；空串表示本次不注入。
 */
export function buildBootStyle(config) {
  const safe = sanitizeConfig(config)
  if (!safe.enabled || safe.theme.skin === 'pure') return ''
  // M2：刻刻帝 / 狂狂帝的静态色阶在此展开（值来自 desktop 线 themes/*.css）。
  return ''
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

  if (facts.desktopTheme === true) {
    issues.push({ level: 'warn', code: 'desktop-theme-active', message: '检测到桌面壳主题引擎在位（html[data-miasaki-theme]）——按让位协议，本线主题板块先让位，避免两套主题互相覆盖' })
  }

  return { ok: issues.length === 0, issues }
}
