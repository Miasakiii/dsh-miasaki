// Pure store layer for @miasaki/dsh-ssh: validation, keys/fingerprints,
// browser fence rules, and JSON persistence (connections + known_hosts).
// Kept free of any ssh2/WebSocket imports so it is directly unit-testable.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const DEFAULT_PORT = 22
export const AUTH_METHODS = new Set(['password', 'key', 'agent'])

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
    id: typeof input.id === 'string' && input.id.length > 0 ? input.id : randomUUID(),
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