// Pure store layer for @miasaki/dsh-ssh: validation, keys/fingerprints,
// browser fence rules, and JSON persistence (connections + known_hosts).
// Kept free of any ssh2/WebSocket imports so it is directly unit-testable.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const DEFAULT_PORT = 22
export const AUTH_METHODS = new Set(['password', 'key', 'agent'])
/** Agent 访问档位（A1 工具面，Agent 化规划 §7.1）：默认 none = 模型看不见这台主机。 */
export const AGENT_ACCESS_LEVELS = new Set(['none', 'readonly', 'full'])
/** 每条连接的本地转发规则上限（每条 = 一个本机监听端口，hold 不住太多）。 */
export const MAX_FORWARDS_PER_CONNECTION = 8

export class InputError extends Error {}
export class NotFoundError extends Error {}

// Strip a port suffix from a Host header value ('example.com:3080' -> 'example.com').
export function stripPort(host) {
  return String(host).replace(/:\d+$/, '').toLowerCase()
}

/**
 * Canonical stick key for a host:port pair ('[::1]:22', 'example.com:22').
 * IPv6 literals are bracketed so ':' never collides with the separator.
 */
export function hostKeyOf(hostname, port) {
  const h = String(hostname).trim()
  const p = Number(port) || DEFAULT_PORT
  return h.includes(':') ? `[${h}]:${p}` : `${h}:${p}`
}

/**
 * Split a `host:port` pair typed into the host field ('example.com:2222',
 * '[::1]:2222') so a pasted address still connects. A bare IPv6 literal keeps
 * its colons (address syntax, not a port) and reports `port: null`.
 */
export function splitHostPort(value) {
  const text = String(value ?? '').trim()
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(text)
  if (bracketed !== null) return { host: bracketed[1], port: Number(bracketed[2]) }
  // Exactly one colon plus a digits-only tail is 'host:port'; IPv6 literals have
  // two or more colons and never match.
  const plain = /^([^:]+):(\d+)$/.exec(text)
  if (plain !== null) return { host: plain[1], port: Number(plain[2]) }
  return { host: text, port: null }
}

/** OpenSSH-style SHA256 fingerprint of a DER host key. */
export function fingerprintOf(keyBuffer) {
  const digest = createHash('sha256').update(keyBuffer).digest('base64')
  return `SHA256:${digest}`
}

// Label normalization: non-empty, trimmed, capped.
export function normalizeLabel(label, maxLength = 80) {
  const text = String(label ?? '').trim()
  if (text.length === 0) throw new InputError('名称不能为空')
  return text.slice(0, maxLength)
}

function requireText(value, field, maxLength = 4096) {
  const text = String(value ?? '').trim()
  if (text.length === 0) throw new InputError(`${field}不能为空`)
  return text.slice(0, maxLength)
}

function requireHost(host) {
  const text = requireText(host, '主机地址', 255)
  // Reject whitespace / scheme-looking values; IPv6 brackets allowed via store.
  if (/[\s/\\]/.test(text.replace(/^\[|\]$/g, ''))) throw new InputError('主机地址不合法')
  return text
}

function requirePort(port) {
  const p = Number(port ?? DEFAULT_PORT)
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('端口必须是 1–65535 的整数')
  return p
}

/**
 * 校验并归一化转发规则（U3/P2-1：本地端口转发）。
 * 每条规则 = 本机 127.0.0.1:localPort → 经 SSH → 远端 remoteHost:remotePort。
 * 规则只有一处（与 splitHostPort 同源的纪律）：REST 写入与连接时建立都过它。
 * remoteHost 是**远端视角**的地址（常见 `127.0.0.1`/`localhost`——服务就在 SSH
 * 服务器本机上），因此不做 DNS 语法强校验，只拒空白与反斜杠。
 */
export function normalizeForwards(input) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new InputError('转发规则必须是数组')
  if (input.length > MAX_FORWARDS_PER_CONNECTION) {
    throw new InputError(`每条连接最多 ${MAX_FORWARDS_PER_CONNECTION} 条转发规则`)
  }
  const seenPorts = new Set()
  const out = []
  for (const raw of input) {
    if (raw === null || typeof raw !== 'object') throw new InputError('转发规则格式不正确')
    const localPort = Number(raw.localPort)
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new InputError('本地端口必须是 1–65535 的整数')
    if (seenPorts.has(localPort)) throw new InputError(`本地端口 ${localPort} 重复`)
    seenPorts.add(localPort)
    const remoteHost = String(raw.remoteHost ?? '').trim()
    if (remoteHost.length === 0) throw new InputError('远端主机不能为空')
    if (remoteHost.length > 255 || /[\s\\]/.test(remoteHost)) throw new InputError('远端主机不合法')
    const remotePort = Number(raw.remotePort)
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new InputError('远端端口必须是 1–65535 的整数')
    out.push({
      localPort,
      remoteHost,
      remotePort,
      label: String(raw.label ?? '').trim().slice(0, 40),
    })
  }
  return out
}

/**
 * 连接 id 的合法形状 —— **一处口径**，store / REST 路由 / WS 票据三处共用。
 *
 * 2026-09-26 A1 实测逮到两次「同一份数据，Agent 用得了、人点不动」：REST 路由目录段与
 * `/ssh/api/attach`、`/ssh/api/sftp/ticket` 都各自写着 `[0-9a-f-]+`（UUID 形状），而 store
 * 对 id 只要求「非空字符串」⇒ 任何非 UUID 的 id 都会在页面侧被判非法。
 * id 是内部标识（页面从不自己造），所以判据只需挡住路径分隔符、空白与控制字符。
 */
export function isConnectionId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false
  if (value !== value.trim()) return false // 首尾空白会造成「看着一样、查不到」
  return !/[\s/\\]/.test(value) && !/[\u0000-\u001f\u007f]/.test(value)
}

/**
 * Validate and normalize a raw connection input into a stored record shape.
 * auth.keyPath must be an absolute path when method is 'key'; passwords are
 * never accepted into the store (they live in the runtime only).
 */
export function normalizeConnection(input = {}) {
  const authMethod = typeof input.auth?.method === 'string' ? input.auth.method : 'password'
  if (!AUTH_METHODS.has(authMethod)) throw new InputError('不支持的认证方式')
  // A port pasted into the host field wins over the port column: `8.138.243.30:25112`
  // beside the default 22 is exactly the shape that reached ssh2 as a hostname and
  // failed DNS (getaddrinfo ENOTFOUND, 实机反馈 2026-09-26).
  const typedHost = splitHostPort(input.host)
  const record = {
    id: isConnectionId(input.id) ? input.id : randomUUID(),
    label: normalizeLabel(input.label, 80),
    host: requireHost(typedHost.host),
    port: requirePort(typedHost.port ?? input.port),
    username: (String(input.username ?? '').trim().slice(0, 255)),
    auth: { method: authMethod },
    group: (String(input.group ?? '').trim().slice(0, 40) || '未分组'),
    favorite: input.favorite === true,
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    lastConnectedAt: input.lastConnectedAt ?? null,
    // U3（P2-1）：本地端口转发规则 + 跳板引用（另一条连接记录的 id）。
    // 跳板必须是一条**已受信任的主机记录**（D4=②）：凭据与 TOFU 全部复用既有机制。
    forwards: normalizeForwards(input.forwards),
    ...(typeof input.jumpHostId === 'string' && input.jumpHostId.trim().length > 0
      ? { jumpHostId: input.jumpHostId.trim() }
      : {}),
    // A1 工具面（Agent 化规划 §7.1）：Agent 访问档位。默认 none（模型看不见这台主机）。
    agentAccess: AGENT_ACCESS_LEVELS.has(input.agentAccess) ? input.agentAccess : 'none',
  }
  if (authMethod === 'key') {
    const keyPath = String(input.auth?.keyPath ?? '').trim()
    if (keyPath.length === 0) throw new InputError('私钥路径不能为空')
    if (!isAbsolutePath(keyPath)) throw new Error('私钥路径必须是绝对路径')
    record.auth.keyPath = keyPath.slice(0, 4096)
  }
  return record
}

/** Public shape sent to the browser: no secret-bearing fields exist in a record. */
export function sanitizeConnection(record) {
  return {
    id: record.id,
    label: record.label,
    host: record.host,
    port: record.port,
    username: record.username,
    auth: record.auth,
    group: record.group,
    favorite: record.favorite === true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastConnectedAt: record.lastConnectedAt,
    forwards: Array.isArray(record.forwards) ? record.forwards.map(item => ({ ...item })) : [],
    agentAccess: AGENT_ACCESS_LEVELS.has(record.agentAccess) ? record.agentAccess : 'none',
    ...(typeof record.jumpHostId === 'string' && record.jumpHostId.length > 0 ? { jumpHostId: record.jumpHostId } : {}),
  }
}

// ---------------------------------------------------------------------------
// Browser trust fence (mirrors the /sidebar approach; the DSH /api fence does
// not cover /ssh routes).
//  1. Host header must be localhost / loopback literal or in trustedHosts.
//  2. sec-fetch-site: cross-site is always rejected (browser flags
//     cross-site requests itself).
//  3. Origin (when present) hostname must equal the Host hostname (loopback).
// Shared by both the HTTP handler and the WebSocket upgrade gate.
export function fenceCheck(headers, trustedHosts) {
  const hostHeader = typeof headers['host'] === 'string' ? headers['host'] : ''
  const hostname = stripPort(hostHeader).toLowerCase()
  if (!trustedHosts.has(hostname) && hostname !== 'localhost' && hostname !== '127.0.0.1') {
    return { ok: false, reason: 'untrusted-host' }
  }
  if (headers['sec-fetch-site'] === 'cross-site') {
    return { ok: false, reason: 'cross-site' }
  }
  if (typeof headers['origin'] === 'string' && headers['origin'].length > 0) {
    let originHostname = null
    try { originHostname = new URL(headers['origin']).hostname.toLowerCase() } catch { return { ok:false, reason:'bad-origin' } }
    if (originHostname !== hostname && originHostname !== '127.0.0.1' && originHostname !== 'localhost') {
      return { ok: false, reason: 'untrusted-origin' }
    }
  }
  return { ok: true }
}

function isAbsolutePath(p) { return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) }

// ---------------------------------------------------------------------------
// JSON persistence for connections.json + known_hosts.json.
class JsonFile {
  constructor(file, fallback) {
    this.file = file
    this.fallback = fallback
    this.value = null
    this.serial = Promise.resolve()
  }
  async load() {
    await mkdir(dirname(this.file), { recursive: true })
    try {
      const raw = await readFile(this.file, 'utf8')
      this.value = JSON.parse(raw)
    } catch (error) {
      if (error?.code === 'ENOENT') { this.value = structuredClone(this.fallback); await this.save() }
      else throw new Error(`cannot read ${this.file}: ${error.message}`)
    }
    return this.value
  }
  async save() {
    const snapshot = structuredClone(this.value)
    this.serial = this.serial.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
      await rename(tmp, this.file)
    })
    await this.serial
  }
}

export class SshStore {
  constructor(dataDir, { scrollbackBytes } = {}) {
    if (typeof dataDir !== 'string' || dataDir.length === 0) throw new Error('ssh: config.dataDir must be a non-empty path')
    this.dataDir = dataDir
    this.connectionsFile = `${dataDir}/connections.json`
    this.hostsFile = `${dataDir}/known_hosts.json`
    this.ready = this.init()
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true })
    this.connections = new JsonFile(this.connectionsFile, { version: 1, connections: [] })
    this.hosts = new JsonFile(this.hostsFile, { version: 1, hosts: {} })
    await Promise.all([this.connections.load(), this.hosts.load()])
    // Migrate/repair: drop anything beyond a plain record list.
    const list = this.connections.value.connections ?? []
    this.connections.value.connections = list.filter(item => item && typeof item.id === 'string')
  }

  // -- connections ----------------------------------------------------------
  async listConnections() {
    await this.ready
    return [...this.connections.value.connections].map(sanitizeConnection).sort((a, b) => a.updatedAt < b.updatedAt ? 1 : -1)
  }

  async getConnection(id) {
    await this.ready
    return this.connections.value.connections.find(item => item.id === id) ?? null
  }

  async createConnection(input) {
    await this.ready
    const record = normalizeConnection(input)
    if (this.connections.value.connections.some(item => item.id === record.id)) throw new Error('连接已存在')
    this.connections.value.connections.push(record)
    await this.connections.save()
    return sanitizeConnection(record)
  }

  async updateConnection(id, patch) {
    await this.ready
    const index = this.connections.value.connections.findIndex(item => item.id === id)
    if (index === -1) throw new NotFoundError('连接不存在')
    const merged = normalizeConnection({ ...this.connections.value.connections[index], ...patch, id })
    merged.updatedAt = new Date().toISOString()
    this.connections.value.connections[index] = merged
    await this.connections.save()
    return sanitizeConnection(merged)
  }

  async removeConnection(id) {
    await this.ready
    const before = this.connections.value.connections.length
    this.connections.value.connections = this.connections.value.connections.filter(item => item.id !== id)
    const removed = before !== this.connections.value.connections.length
    if (removed) await this.connections.save()
    return removed
  }

  async touchConnected(id) {
    await this.ready
    const record = this.connections.value.connections.find(item => item.id === id)
    if (record === undefined) return
    record.lastConnectedAt = new Date().toISOString()
    await this.connections.save()
  }

  // -- known_hosts ----------------------------------------------------------
  async listHosts() {
    await this.ready
    return Object.entries(this.hosts.value.hosts).map(([hostKey, entry]) => ({
      hostKey,
      fingerprint: entry.fingerprint,
      algo: entry.algo,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt ?? null,
    })).sort((a, b) => (a.hostKey < b.hostKey ? -1 : 1))
  }

  async getFingerprint(hostKey) {
    await this.ready
    const entry = this.hosts.value.hosts[hostKey]
    return entry ? { fingerprint: entry.fingerprint, algo: entry.algo, firstSeenAt: entry.firstSeenAt } : null
  }

  async recordFingerprint(hostKey, fingerprint, algo = 'SHA256') {
    await this.ready
    const now = new Date().toISOString()
    const previous = this.hosts.value.hosts[hostKey]
    this.hosts.value.hosts[hostKey] = {
      algo: algo,
      fingerprint,
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
    }
    await this.hosts.save()
  }

  async forgetHost(hostKey) {
    await this.ready
    if (this.hosts.value.hosts[hostKey] !== undefined) {
      delete this.hosts.value.hosts[hostKey]
      await this.hosts.save()
    }
  }
}