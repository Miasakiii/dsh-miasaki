// @miasaki/dsh-appearance — 软件头像的收窄与校验（纯逻辑，无运行时依赖）。
//
// 头像与壁纸是两条不同的链路：壁纸是浏览器直接消费的文件，格式宽容（png/jpg/webp/…）；
// 头像还要被**桌面壳（Miasaki.exe）**读去做窗口 / 任务栏 / 托盘图标，而桌面壳只依赖
// `png` crate（不引入 jpeg/webp 解码器），所以这里把格式收敛到**唯一一种**：PNG。
//
// 收敛点放在浏览器侧（canvas 重编码，见 client.js 的 fileToAvatarPng），host 只做
// 「是不是真 PNG + 多大 + 能不能落盘」的最终把关 —— 与 lib/config.js 的既定分工一致：
// 浏览器负责采事实/预处理，判定与白名单一律在 host（可单测）。

/** 头像目录名（dataDir 之下），与壁纸目录并列、互不共享。 */
export const AVATAR_DIRNAME = 'avatars'

/** host 对外服务的头像 URL 前缀（config.avatar.source 的合法形态之一）。 */
export const AVATAR_URL_PREFIX = '/appearance/avatar/'

/** 头像文件名白名单：防路径穿越的最终闸门（basename 后仍须整体命中）。 */
export const AVATAR_NAME_RE = /^[\w][\w.-]{0,80}\.png$/i

/** PNG 魔数（8 字节）：`\x89PNG\r\n\x1a\n`。 */
const PNG_MAGIC = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 单个头像的体积上限（解码后的二进制字节数）。canvas 归一化后的图通常 < 1MB。 */
export const AVATAR_MAX_BYTES = 4 * 1024 * 1024

/** data URL 文本上限（base64 膨胀约 4/3，再留出前缀与空白余量）。 */
export const AVATAR_DATA_URL_MAX = Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 1024

/**
 * 校验一段字节是不是 PNG。
 * @param {Uint8Array|Buffer} bytes - 待检字节。
 * @returns {boolean} 是否以 PNG 魔数开头。
 */
export function isPng(bytes) {
  if (bytes === undefined || bytes === null || bytes.length < PNG_MAGIC.length) return false
  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    if (bytes[i] !== PNG_MAGIC[i]) return false
  }
  return true
}

/**
 * 从 config.avatar.source 解析出文件名；不是本线头像路由的路径一律 null。
 *
 * 这条规则是**跨线契约**的一半（另一半在桌面壳 `launcher_icon` 模块）：
 * 两端都必须只认 `/appearance/avatar/<白名单文件名>`，任何 http(s) 外链在这里就出局，
 * 桌面壳因此永远不需要访问网络。
 * @param {unknown} source - 配置里的图源字符串。
 * @returns {string|null} 合法文件名，否则 null。
 */
export function avatarFileFromSource(source) {
  if (typeof source !== 'string') return null
  if (!source.startsWith(AVATAR_URL_PREFIX)) return null
  const rest = source.slice(AVATAR_URL_PREFIX.length)
  // 只认单段路径：出现 `/`、`\`、`%2f` 之类一律出局（文件名的最终判定交给白名单）。
  if (rest === '' || rest.includes('/') || rest.includes('\\')) return null
  let decoded = rest
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    return null
  }
  return AVATAR_NAME_RE.test(decoded) ? decoded : null
}

/**
 * 解析浏览器发来的 PNG data URL。
 *
 * 只接受 `data:image/png;base64,…`：client 半用 canvas 把任意格式重编码成 PNG 后上传，
 * 因此这里遇到 jpeg/webp 等前缀说明调用方绕过了归一化，应当明确拒绝而不是宽容猜测。
 * @param {unknown} text - 请求体里的 dataUrl 字段。
 * @returns {{ok: true, bytes: Buffer}|{ok: false, error: string}} 解析结果。
 */
export function parseAvatarDataUrl(text) {
  if (typeof text !== 'string' || text === '') return { ok: false, error: '缺少图片数据' }
  if (text.length > AVATAR_DATA_URL_MAX) return { ok: false, error: '图片过大（请先用图片工具压缩到 4MB 以内）' }
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(text)
  if (match === null) return { ok: false, error: '只接受 PNG（面板会自动把其它格式转成 PNG）' }
  let bytes = null
  try {
    bytes = Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
  } catch {
    return { ok: false, error: '图片数据不是合法的 base64' }
  }
  if (bytes.length === 0) return { ok: false, error: '图片数据为空' }
  if (bytes.length > AVATAR_MAX_BYTES) return { ok: false, error: '图片过大（上限 4MB）' }
  // base64 解码不会校验内容：魔数必须真查，否则任意文件都能穿上 .png 外衣。
  if (!isPng(bytes)) return { ok: false, error: '这不是有效的 PNG 数据' }
  return { ok: true, bytes }
}

/**
 * 生成一个新的头像文件名（时间戳 + 随机后缀，绝不覆盖既有文件）。
 * @param {number} now - 毫秒时间戳（注入以便单测）。
 * @param {() => number} random - 0–1 随机源（注入以便单测）。
 * @returns {string} 形如 `avatar-lz3k9q-4f2a1b.png` 的文件名。
 */
export function makeAvatarName(now, random = Math.random) {
  const stamp = Math.max(0, Math.floor(now)).toString(36)
  const salt = Math.floor(Math.max(0, Math.min(0.999999, random())) * 0xffffff).toString(16).padStart(6, '0')
  return `avatar-${stamp}-${salt}.png`
}
