// 远程路径规范化（U2.2，decision/2026-09-26-ssh-zcode-benchmark-plan.md §4-P0-2 决策 7：
// SFTP 与将来 A1 的 ssh_read_file / exec 共用同一套路径口径，避免两条通道的安全判据漂移）。
//
// 纯函数层，不碰网络：词法层的 `.`/`..`/`//` 归一 + `~` 展开 + NUL/超长拒绝。
// 服务器真相（符号链接的真实落点）由 lib/sftp.js 在每次操作前用 realpath 兜底。
//
// 判据（U2 规划 §8 风险表「路径穿越 / 符号链接逃逸」）：
//  - 拒绝 NUL 与控制字符（C 层字符串截断是经典逃逸手法）
//  - `..` 在词法层就地结算，根处的 `..` 按 POSIX 语义停在根（`/..` === `/`）
//  - 结果恒为绝对路径（`/` 开头）；相对输入基于 baseDir 结算
//  - 长度封顶 MAX_PATH_LENGTH，超长直接拒（不静默截断——截断后的路径不是用户要的路径）
import { MAX_PATH_LENGTH } from './limits.js'

export { MAX_PATH_LENGTH }

/** 展开 `~` / `~/...`：没有 homeDir 时原样返回（调用方会给）。 */
export function expandHomePath(raw, homeDir) {
  const text = String(raw ?? '')
  if (text === '~') return homeDir ?? text
  if (text.startsWith('~/')) return homeDir !== undefined && homeDir !== null ? `${homeDir}${text.slice(1)}` : text
  return text
}

/**
 * 词法归一一条远端路径。
 * @param {string} raw 用户输入 / UI 传来的路径
 * @param {{ homeDir?: string, baseDir?: string }} [ctx] homeDir 展开 `~`；baseDir 结算相对输入
 * @returns {{ path: string } | { error: string }}
 */
export function normalizeRemotePath(raw, ctx = {}) {
  let text = String(raw ?? '')
  if (text.length === 0) return { error: '路径不能为空' }
  if (text.length > MAX_PATH_LENGTH) return { error: `路径过长（上限 ${MAX_PATH_LENGTH} 字符）` }
  if (text.includes('\0')) return { error: '路径包含非法字符（NUL）' }
  // 控制字符一并拒绝：换行/回车会把路径拆成多行日志或伪造 shell 续行
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code < 0x20 || code === 0x7f) return { error: '路径包含控制字符' }
  }
  text = expandHomePath(text, ctx.homeDir)
  if (!text.startsWith('/')) {
    const base = ctx.baseDir ?? ctx.homeDir
    if (base === undefined || base === null || base.length === 0) return { error: '相对路径需要基准目录' }
    text = `${base.replace(/\/+$/, '')}/${text}`
  }
  const segments = []
  for (const segment of text.split('/')) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') {
      // 根处的 `..` 按 POSIX 语义停留在根；绝不弹出根
      if (segments.length > 0) segments.pop()
      continue
    }
    segments.push(segment)
  }
  return { path: `/${segments.join('/')}` }
}

/** realpath（服务器真相）之后仍在词法层确认一次：结果绝对、无 NUL、不超长。 */
export function assertResolvedPath(path) {
  const text = String(path ?? '')
  if (!text.startsWith('/')) return { error: '服务器返回了非绝对路径' }
  if (text.includes('\0')) return { error: '服务器返回的路径包含 NUL' }
  if (text.length > MAX_PATH_LENGTH) return { error: '服务器返回的路径过长' }
  return { path: text }
}

/**
 * candidate 是否位于 root 之内（realpath 之后的包含判定，按段比较，防 `/a/bc`
 * 冒充 `/a/b` 的前缀）。root 为 `/` 时恒真（整个文件系统）。
 */
export function isPathInside(root, candidate) {
  const r = String(root ?? '')
  const c = String(candidate ?? '')
  if (r === '/' || c === '/') return true
  if (!r.endsWith('/')) return c === r || c.startsWith(`${r}/`)
  return c.startsWith(r)
}
