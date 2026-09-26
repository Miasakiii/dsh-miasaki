// ~/.ssh/config 别名导入（P1-1，design/2026-09-26-ssh-zcode-benchmark-plan.md §4-P1-1，D2=①）。
// 让用户在新建/编辑主机时直接选自己 ssh 里已有的 Host，而不是手抄地址。
//
// 双通道（对标 zcode packages/services/src/system/sshConfigAlias.ts 的三条教训）：
//  1. `ssh -G` 优先（本机 ssh 自己把 Include/ Match/ 默认值全算好），失败/没有 ssh
//     可执行文件时回退自研解析器（Include glob / 注释 / 引号 / 转义 / 深度 8）。
//  2. `ssh -G` 会返回**默认** identityfile（~/.ssh/id_rsa）—— 直接采用会把「密码登录」
//     误判成「密钥登录」。⇒ privateKeyPath 只信 config 显式声明的 IdentityFile。
//  3. Windows 路径里的 `\` 不是转义符 ⇒ tokenizer 仅在确为转义分隔符/引号时解义。
// D2=①：含 ProxyJump / ProxyCommand 的 alias 不导入（标 direct:false，UI 禁选，
// 不静默丢弃——用户在 ssh 里就是用别名连的，看不见会更困惑）。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { glob, readFile } from 'node:fs/promises'
import os from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

export const MAX_ALIAS_COUNT = 200
export const MAX_INCLUDE_DEPTH = 8
const SSH_G_TIMEOUT_MS = 1_500
const SSH_G_CONCURRENCY = 3
const CACHE_TTL_MS = 30_000

// ---------------------------------------------------------------------------
// tokenizer

/** 去行内注释（引号内的 # 不是注释）。 */
function stripInlineComment(line) {
  let quote = null
  let escaped = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (quote !== null) { if (ch === quote) quote = null; continue }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === '#') return line.slice(0, i)
  }
  return line
}

/** 按空白切 token，支持引号与转义；Windows 路径的 `\` 默认保留字面。 */
function splitTokens(line) {
  const tokens = []
  let current = ''
  let quote = null
  let escaped = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      const next = line[i + 1]
      // 只有确为转义分隔符/引号/续行时才解义；`C:\Users\...` 的反斜杠保留
      if (next !== undefined && /[\s'"\\#]/.test(next)) { current += next; i += 1; continue }
      current += '\\'
      continue
    }
    if (quote !== null) {
      if (ch === quote) { quote = null; continue }
      current += ch
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (/\s/.test(ch)) {
      if (current.length > 0) { tokens.push(current); current = '' }
      continue
    }
    current += ch
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

function expandHome(rawPath, home) {
  const trimmed = String(rawPath ?? '').trim()
  if (trimmed.length === 0) return trimmed
  const withD = trimmed.replace(/^%d(?=$|[\\/])/, home)
  if (withD === '~') return home
  if (withD.startsWith('~/') || withD.startsWith('~\\')) return join(home, withD.slice(2))
  return withD
}

function hasGlobPattern(value) {
  return /[*?[\]]/.test(value)
}

// ---------------------------------------------------------------------------
// 解析（Include / Host 块）

async function parseBlocks(configPath, visited, depth) {
  const normalized = resolve(configPath)
  if (visited.has(normalized) || depth > MAX_INCLUDE_DEPTH) return []
  visited.add(normalized)
  let content = ''
  try {
    content = await readFile(normalized, 'utf8')
  } catch {
    return []
  }
  const blocks = [{ patterns: ['*'], directives: [], source: normalized, fromHost: false }]
  let current = blocks[0]
  for (const rawLine of content.split(/\r?\n/)) {
    const tokens = splitTokens(stripInlineComment(rawLine).trim())
    if (tokens.length === 0) continue
    const key = tokens[0].toLowerCase()
    if (key === 'include') {
      const baseDir = dirname(normalized)
      for (const token of tokens.slice(1)) {
        const expanded = expandHome(token, os.homedir())
        if (expanded.length === 0) continue
        const pattern = isAbsolute(expanded) ? expanded : resolve(baseDir, expanded)
        if (!hasGlobPattern(pattern)) {
          if (existsSync(pattern)) blocks.push(...await parseBlocks(pattern, visited, depth + 1))
          continue
        }
        try {
          for await (const match of glob(pattern)) {
            blocks.push(...await parseBlocks(resolve(match), visited, depth + 1))
          }
        } catch { /* 单个坏 Include 不阻塞整体加载 */ }
      }
      continue
    }
    if (key === 'host') {
      current = { patterns: tokens.slice(1), directives: [], source: normalized, fromHost: true }
      blocks.push(current)
      continue
    }
    if (tokens.length >= 2) current.directives.push({ key, value: tokens.slice(1).join(' ') })
  }
  return blocks
}

/** 该别名匹配到的全部 directive（跨块合并，按 ssh 的「首次命中优先」语义取首个值）。 */
function directivesFor(blocks, alias) {
  const directives = []
  for (const block of blocks) {
    if (!blockMatches(block.patterns, alias)) continue
    directives.push(...block.directives)
  }
  return directives
}

function matchPattern(pattern, alias) {
  if (pattern === '*') return true
  if (!/[*?]/.test(pattern)) return pattern === alias
  const body = [...pattern].map(ch => {
    if (ch === '*') return '.*'
    if (ch === '?') return '.'
    return ch.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  }).join('')
  try { return new RegExp(`^${body}$`).test(alias) } catch { return false }
}

function blockMatches(patterns, alias) {
  let positive = false
  for (const raw of patterns) {
    const pattern = String(raw ?? '').trim()
    if (pattern.length === 0) continue
    if (pattern.startsWith('!')) {
      if (matchPattern(pattern.slice(1), alias)) return false
      continue
    }
    if (matchPattern(pattern, alias)) positive = true
  }
  return positive
}

function isConnectableAlias(alias) {
  const trimmed = String(alias ?? '').trim()
  if (trimmed.length === 0) return false
  if (trimmed === '*' || trimmed.startsWith('!')) return false
  return !/[?*[\\\]]/.test(trimmed)
}

function toPort(raw) {
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined
}

/** 自研解析产物：host/port/user/privateKeyPath + 是否含跳板（proxyjump/proxycommand）。 */
function aliasFromBlocks(blocks, alias, source) {
  let host
  let port
  let username
  let privateKeyPath
  let jump = false
  for (const directive of directivesFor(blocks, alias)) {
    if (host === undefined && directive.key === 'hostname') host = directive.value.trim() || undefined
    if (port === undefined && directive.key === 'port') port = toPort(directive.value)
    if (username === undefined && directive.key === 'user') username = directive.value.trim() || undefined
    if (privateKeyPath === undefined && directive.key === 'identityfile') {
      const expanded = expandHome(directive.value, os.homedir())
      privateKeyPath = expanded.length > 0 ? expanded : undefined
    }
    if (directive.key === 'proxyjump' || directive.key === 'proxycommand') jump = true
  }
  return {
    alias,
    host: host ?? alias,
    ...(port === undefined ? {} : { port }),
    ...(username === undefined ? {} : { username }),
    ...(privateKeyPath === undefined ? {} : { privateKeyPath }),
    direct: jump !== true,
    source,
  }
}

// ---------------------------------------------------------------------------
// ssh -G 通道

function findOnPath(binary) {
  const rawPath = process.env['PATH']
  if (rawPath === undefined) return null
  for (const entry of rawPath.split(delimiter)) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    const full = join(trimmed, binary)
    if (existsSync(full)) return full
  }
  return null
}

function resolveSshExecutable() {
  if (process.platform !== 'win32') return findOnPath('ssh')
  const fromPath = findOnPath('ssh.exe')
  if (fromPath !== null) return fromPath
  const windir = (process.env['WINDIR'] ?? 'C:\\Windows').trim()
  const pf = (process.env['ProgramFiles'] ?? 'C:\\Program Files').trim()
  const pf86 = (process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)').trim()
  const candidates = [
    join(windir, 'System32', 'OpenSSH', 'ssh.exe'),
    join(pf, 'OpenSSH', 'ssh.exe'),
    join(pf, 'Git', 'usr', 'bin', 'ssh.exe'),
    join(pf86, 'Git', 'usr', 'bin', 'ssh.exe'),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

/** 跑一次 `ssh -G <alias>`；超时/失败返回 null（调用方回退自研解析）。 */
export function runSshG(sshPath, configPath, alias, { timeoutMs = SSH_G_TIMEOUT_MS, spawnFn = spawn } = {}) {
  return new Promise(resolvePromise => {
    let finished = false
    let stdout = ''
    let child
    try {
      child = spawnFn(sshPath, ['-G', '-F', configPath, '-o', 'BatchMode=yes', alias], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        // ASKPASS 清空：某些环境会把口令提示挂起，拖死 1.5s 窗口
        env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never', SSH_ASKPASS: '', DISPLAY: '' },
      })
    } catch {
      resolvePromise(null)
      return
    }
    const timer = setTimeout(() => {
      if (finished) return
      finished = true
      try { child.kill() } catch { /* gone */ }
      resolvePromise(null)
    }, timeoutMs)
    child.stdout?.on('data', chunk => {
      if (finished) return
      stdout += String(chunk)
      if (stdout.length > 128_000) stdout = stdout.slice(0, 128_000)
    })
    child.on('error', () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolvePromise(null)
    })
    child.on('close', code => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolvePromise(code === 0 ? stdout : null)
    })
  })
}

/** 解析 `ssh -G` 输出里的 hostname / port / user（identityfile 刻意不取——教训 2）。 */
export function parseSshGOutput(output) {
  let host
  let port
  let username
  for (const rawLine of String(output ?? '').split(/\r?\n/)) {
    const match = /^(\S+)\s+(.*)$/.exec(rawLine.trim())
    if (match === null) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim()
    if (key === 'hostname' && host === undefined && value.length > 0) host = value
    if (key === 'port' && port === undefined) port = toPort(value)
    if (key === 'user' && username === undefined && value.length > 0) username = value
  }
  return { host, port, username }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length)
  let cursor = 0
  const safe = Math.max(1, Math.min(concurrency, items.length))
  async function worker() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: safe }, worker))
  return results
}

// ---------------------------------------------------------------------------
// 主入口

let cache = null

/**
 * 枚举 ~/.ssh/config 里可导入的别名。
 * @param {{ configPath?: string, now?: () => number, ttlMs?: number, spawnFn?: Function }} [deps]
 *        测试注入点：configPath 指到样本文件、spawnFn 桩掉 ssh 进程。
 * @returns {Promise<{aliases: object[], from: 'ssh-g'|'parser'|'none', error?: string}>}
 */
export async function listSshConfigAliases(deps = {}) {
  const configPath = deps.configPath ?? join(os.homedir(), '.ssh', 'config')
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? CACHE_TTL_MS
  // 缓存按 configPath 为键（测试注入的样本配置同样可命中/可过期）
  if (cache !== null && cache.configPath === configPath && cache.expiresAt > now()) {
    return { aliases: cache.aliases.map(item => ({ ...item })), from: cache.from }
  }
  if (!existsSync(configPath)) {
    cache = { configPath, expiresAt: now() + ttlMs, aliases: [], from: 'none' }
    return { aliases: [], from: 'none' }
  }
  const blocks = await parseBlocks(configPath, new Set(), 0)
  const aliasMetas = []
  const seen = new Set()
  for (const block of blocks) {
    if (block.fromHost !== true || block.patterns.length !== 1) continue
    const alias = block.patterns[0]?.trim()
    if (!isConnectableAlias(alias) || seen.has(alias)) continue
    seen.add(alias)
    aliasMetas.push({ alias, source: block.source })
    if (aliasMetas.length >= MAX_ALIAS_COUNT) break
  }
  if (aliasMetas.length === 0) {
    cache = { configPath, expiresAt: now() + ttlMs, aliases: [], from: 'parser' }
    return { aliases: [], from: 'parser' }
  }
  const fallback = aliasMetas.map(meta => aliasFromBlocks(blocks, meta.alias, meta.source))
  const sshPath = resolveSshExecutable()
  // deps.spawnFn === null 是测试缝隙：强制跳过 ssh -G、只走自研解析。
  if (sshPath !== null && deps.spawnFn !== null) {
    const resolved = await mapWithConcurrency(aliasMetas, SSH_G_CONCURRENCY, async meta => {
      const base = fallback.find(item => item.alias === meta.alias)
      const output = await runSshG(sshPath, configPath, meta.alias, { spawnFn: deps.spawnFn })
      if (output === null) return base
      const parsed = parseSshGOutput(output)
      const merged = {
        alias: meta.alias,
        host: parsed.host ?? base?.host ?? meta.alias,
        direct: base?.direct ?? true,
        source: meta.source,
      }
      const port = parsed.port ?? base?.port
      if (port !== undefined) merged.port = port
      const username = parsed.username ?? base?.username
      if (username !== undefined) merged.username = username
      // privateKeyPath 只信 config 显式声明：ssh -G 的默认 identityfile 会把
      // 「密码登录」误判成「密钥登录」（教训 2）
      if (base?.privateKeyPath !== undefined) merged.privateKeyPath = base.privateKeyPath
      return merged
    })
    cache = { configPath, expiresAt: now() + ttlMs, aliases: resolved, from: 'ssh-g' }
    return { aliases: resolved.map(item => ({ ...item })), from: 'ssh-g' }
  }
  cache = { configPath, expiresAt: now() + ttlMs, aliases: fallback, from: 'parser' }
  return { aliases: fallback.map(item => ({ ...item })), from: 'parser' }
}

/** 测试辅助：清缓存。 */
export function clearAliasCache() {
  cache = null
}
