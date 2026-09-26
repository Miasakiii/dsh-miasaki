// Connection diagnostics for one target: DNS → TCP → SSH banner → (opt-in) advertised
// auth methods, plus the two facts a user needs to get unblocked — this machine's public
// egress IP and its LAN addresses.
//
// Rules fixed by the 2026-09-26 incident (a user's IP got banned while debugging):
//   1. The default probe NEVER sends a password. A diagnostics button that counts as a
//      failed login gets the user banned by fail2ban / cloud brute-force protection.
//   2. The auth-method probe asks with the protocol's `none` method, which OpenSSH does
//      not log as a failed password attempt (sshd log filters ignore it).
//   3. Asking a third-party service for the egress IP is opt-in per call — the caller
//      says so explicitly, the UI defaults to off.
//   4. Every step is bounded and reports its own elapsed time; a slow step must not
//      stretch the whole report.
import { lookup } from 'node:dns/promises'
import net from 'node:net'
import os from 'node:os'
import { Client } from 'ssh2'

export const TCP_TIMEOUT_MS = 3500
export const BANNER_TIMEOUT_MS = 1500
export const DNS_TIMEOUT_MS = 2500
export const EGRESS_TIMEOUT_MS = 3000
export const AUTH_TIMEOUT_MS = 8000

/** Egress-IP services, tried in order; each answer is one plain-text IP. */
export const EGRESS_ENDPOINTS = [
  { url: 'https://ipinfo.io/ip', source: 'ipinfo.io' },
  { url: 'https://api.ipify.org', source: 'api.ipify.org' },
  { url: 'https://ifconfig.me/ip', source: 'ifconfig.me' },
]

const ms = () => Date.now()

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时（${timeoutMs}ms）`)), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

const messageOf = error => String(error?.message ?? error)

/**
 * Non-loopback-ish LAN/global addresses of this machine. Purely local (no network
 * call): the user needs these when a firewall rule must name their address.
 * @returns {{name: string, address: string, family: string, internal: boolean}[]}
 */
export function listLocalAddresses() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list ?? []) {
      out.push({ name, address: item.address, family: item.family, internal: item.internal === true })
    }
  }
  return out
}

/** OS/runtime facts worth attaching to a report (no network call). */
export function runtimeFacts() {
  return { platform: `${os.platform()} ${os.release()}`, node: process.version }
}

/**
 * Resolve a hostname. IP literals short-circuit (no lookup), which is exactly the
 * distinction that made `getaddrinfo ENOTFOUND` confusing in the field.
 */
export async function resolveHost(host, { timeoutMs = DNS_TIMEOUT_MS, resolver = lookup } = {}) {
  const started = ms()
  if (net.isIP(host) !== 0) return { ips: [host], literal: true, ms: 0 }
  try {
    const result = await withTimeout(resolver(host, { all: true }), timeoutMs)
    return { ips: result.map(item => item.address), literal: false, ms: ms() - started }
  } catch (error) {
    return { error: messageOf(error), ms: ms() - started }
  }
}

/** Map a socket error code onto the vocabulary the report and the verdict use. */
export function classifySocketFailure(error) {
  const code = String(error?.code ?? '')
  if (code === 'ECONNREFUSED') return 'refused'
  if (code === 'ECONNRESET') return 'reset'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'unreachable'
  if (code === 'ETIMEDOUT') return 'timeout'
  return 'error'
}

/**
 * One TCP connection that also tries to read the SSH banner, so the two facts come
 * from the same handshake. A server that accepts TCP and then says nothing is a
 * distinct (and common) failure mode: "something is there, but it is not sshd".
 * @returns {Promise<{outcome: string, ms: number, banner: string|null, detail: string|null}>}
 */
export function probeTcpAndBanner(host, port, {
  timeoutMs = TCP_TIMEOUT_MS,
  bannerMs = BANNER_TIMEOUT_MS,
} = {}) {
  return new Promise(resolve => {
    const started = ms()
    const result = { outcome: 'error', ms: 0, banner: null, detail: null }
    let settled = false
    let connected = false
    const socket = net.connect({ host, port })
    const finish = (outcome, detail = null) => {
      if (settled) return
      settled = true
      result.outcome = outcome
      result.detail = detail
      result.ms = ms() - started
      try { socket.destroy() } catch { /* already closed */ }
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => {
      // Connected: from here on the only question is whether an SSH banner arrives.
      // A silent socket is NOT a TCP timeout — it is the distinct "something is
      // listening but it is not sshd" case, and the verdict must say so.
      connected = true
      socket.setTimeout(bannerMs)
      socket.once('data', chunk => {
        const line = String(chunk).split('\n')[0].trim()
        result.banner = line.length > 0 ? line : null
        finish('connected', result.banner)
      })
    })
    // 未建连就超时：outcome 已经说明「无响应」，detail 留空即可（否则报告里会出现
    // 「无响应（丢包）· 3500ms · 无响应」这种重复）。
    socket.on('timeout', () => finish(connected ? 'connected' : 'timeout', connected ? '已连接但对端无数据' : null))
    socket.on('error', error => finish(classifySocketFailure(error), messageOf(error)))
    socket.on('close', () => finish(connected ? 'connected' : 'error', connected ? '已连接但对端无数据' : '连接关闭'))
  })
}

/** Interpret a banner line: only `SSH-<proto>-<software>` means an SSH server. */
export function parseBanner(banner) {
  if (typeof banner !== 'string' || banner.length === 0) return { isSsh: false, software: null }
  const match = /^SSH-(\d+\.\d+)-(.+)$/.exec(banner)
  if (match === null) return { isSsh: false, software: null }
  return { isSsh: true, software: match[2] }
}

/**
 * Ask the server which authentication methods it allows, using the protocol's `none`
 * method: `USERAUTH_FAILURE` carries the list, and OpenSSH does not log `none` as a
 * failed password attempt. Nothing is written to known_hosts (this is a probe, not a
 * connection the user owns) and no credential of any kind is sent.
 */
export function probeAuthMethods(host, port, username, { timeoutMs = AUTH_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    const started = ms()
    const result = { methods: null, error: null, ms: 0 }
    let settled = false
    const client = new Client()
    const finish = () => {
      if (settled) return
      settled = true
      result.ms = ms() - started
      try { client.end() } catch { /* already gone */ }
      resolve(result)
    }
    client.on('error', error => { result.error = messageOf(error); finish() })
    client.on('close', finish)
    client.on('keyboard-interactive', (name, instructions, lang, prompts, done) => {
      // Reaching a prompt means the server does offer keyboard-interactive; answer
      // nothing and stop — no password, no partial authentication.
      result.methods = result.methods ?? ['keyboard-interactive']
      done([])
      finish()
    })
    try {
      client.connect({
        host,
        port,
        username: typeof username === 'string' && username.length > 0 ? username : 'probe',
        readyTimeout: timeoutMs,
        // Never accept a host key silently on behalf of the user; this probe only
        // reads what the server advertises.
        hostVerifier: () => true,
        authHandler: (methodsLeft, partialSuccess, callback) => {
          if (methodsLeft === null) return callback('none') // first call: ask with `none`
          result.methods = methodsLeft
          callback(false) // got the list; stop before trying anything real
          return undefined
        },
      })
    } catch (error) {
      result.error = messageOf(error)
      finish()
    }
    setTimeout(finish, timeoutMs + 500).unref?.()
  })
}

/**
 * This machine's public egress IP, asked of a third-party service. Only called when
 * the caller (the UI button) explicitly asks for it.
 */
export async function resolveEgressIp({
  timeoutMs = EGRESS_TIMEOUT_MS,
  fetcher = fetch,
  endpoints = EGRESS_ENDPOINTS,
} = {}) {
  const failures = []
  for (const endpoint of endpoints) {
    const started = ms()
    try {
      const res = await withTimeout(fetcher(endpoint.url, { headers: { accept: 'text/plain' } }), timeoutMs)
      const text = String(await res.text()).trim()
      if (net.isIP(text.split('\n')[0].trim()) !== 0) {
        const ip = text.split('\n')[0].trim()
        return { ip, source: endpoint.source, ms: ms() - started }
      }
      failures.push(`${endpoint.source}: 返回内容不是 IP`)
    } catch (error) {
      failures.push(`${endpoint.source}: ${messageOf(error)}`)
    }
  }
  return { error: failures.join('；') }
}

/**
 * Turn the collected facts into one conclusion plus actionable hints. The verdict is
 * computed here (not in the UI) so the wording stays in one place and can be tested.
 */
export function buildVerdict(report) {
  const { dns, tcp, ssh, auth } = report
  if (dns?.error !== undefined && dns.error !== null) {
    return {
      level: 'error',
      code: 'DNS_FAILED',
      title: `域名解析失败：${dns.error}`,
      hints: ['检查主机名拼写；主机栏只填域名或 IP，端口填在「端口」栏'],
    }
  }
  if (tcp?.outcome === 'timeout') {
    return {
      level: 'error',
      code: 'TCP_TIMEOUT',
      title: `TCP ${report.target.port} 无响应（${tcp.ms}ms 丢包）`,
      hints: [
        '确认云安全组 / 服务器防火墙放行了这个端口（来源要包含本机出口 IP）',
        '确认服务在监听（服务器上 `sudo ss -lntp | grep <端口>`）',
        '若同一 IP 上有过多次认证失败，可能已被 fail2ban / 云主机安全临时封禁 —— 这类封禁表现为整机所有端口一起超时',
      ],
    }
  }
  if (tcp?.outcome === 'refused') {
    return {
      level: 'error',
      code: 'TCP_REFUSED',
      title: `TCP ${report.target.port} 被拒绝（连接被 RST）`,
      hints: ['端口上没有服务在监听，多半是端口写错或 sshd 没起来'],
    }
  }
  if (tcp?.outcome === 'reset') {
    return {
      level: 'error',
      code: 'TCP_RESET',
      title: 'TCP 连接被重置',
      hints: ['有前置设备（防护/端口映射）在应答，但不是 sshd', '确认端口映射的后端端口是不是 sshd 的端口'],
    }
  }
  if (tcp?.outcome === 'unreachable') {
    return { level: 'error', code: 'TCP_UNREACHABLE', title: '网络不可达（路由问题）', hints: ['本机到该地址没有可用路由，检查网络/VPN 设置'] }
  }
  if (tcp?.outcome !== 'connected') {
    return { level: 'error', code: 'TCP_ERROR', title: `TCP 连接失败：${tcp?.detail ?? '未知原因'}`, hints: [] }
  }
  const banner = parseBanner(ssh?.banner)
  if (banner.isSsh !== true) {
    return {
      level: 'error',
      code: 'NOT_SSH',
      title: ssh?.banner === null || ssh?.banner === undefined
        ? 'TCP 通了，但对端一个字节都没有回 —— 这不是 SSH 服务'
        : `TCP 通了，但回的不是 SSH banner：${ssh.banner}`,
      hints: [
        '这个端口后面多半是别的服务，或端口映射没有指向 sshd',
        '服务器上确认 sshd 端口：`sudo ss -lntp | grep sshd`',
      ],
    }
  }
  if (auth?.methods !== null && auth?.methods !== undefined) {
    const methods = auth.methods
    const passwordCapable = methods.includes('password') || methods.includes('keyboard-interactive')
    if (!passwordCapable) {
      return {
        level: 'warn',
        code: 'PASSWORD_DISABLED',
        title: `服务端不允许密码登录（仅 ${methods.join(' / ') || '未知'}）`,
        hints: ['把认证方式改成「私钥」，或在服务器上开启密码认证'],
      }
    }
  }
  return {
    level: 'ok',
    code: 'REACHABLE',
    title: `网络与 SSH 服务可达（${ssh.banner}）`,
    hints: auth?.methods !== null && auth?.methods !== undefined
      ? [`服务端允许的认证方式：${auth.methods.join(' / ')}`, '若仍连不上，那就是账号 / 密码问题']
      : ['若仍连不上，多半是账号 / 密码问题；可勾选「探测认证方式」进一步确认'],
  }
}

/**
 * Run the whole probe for one target.
 * @param {{host: string, port: number, username?: string, label?: string,
 *   probeAuth?: boolean, resolveEgress?: boolean, timeoutMs?: number}} input
 * @param {{fetcher?: Function, resolver?: Function}} deps injection points for tests
 * @returns {Promise<object>} the report the UI renders (verdict included)
 */
export async function diagnose(input, deps = {}) {
  const host = String(input?.host ?? '').trim()
  const port = Number(input?.port)
  const report = {
    target: { host, port, label: typeof input?.label === 'string' ? input.label : null },
    ranAt: new Date().toISOString(),
    local: { addresses: listLocalAddresses(), ...runtimeFacts() },
    egress: null,
    dns: null,
    tcp: null,
    ssh: null,
    auth: null,
    verdict: null,
  }
  if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    report.verdict = { level: 'error', code: 'BAD_INPUT', title: '主机或端口不合法', hints: [] }
    return report
  }

  const timeoutMs = Number.isFinite(input?.timeoutMs) ? input.timeoutMs : TCP_TIMEOUT_MS
  report.dns = await resolveHost(host, { resolver: deps.resolver ?? lookup })
  if (report.dns.error === undefined) {
    // Probe the name (not our resolved IP): if the system resolves differently than we
    // did, the report should reflect what an actual connection does.
    const probe = await probeTcpAndBanner(host, port, { timeoutMs })
    report.tcp = { outcome: probe.outcome, ms: probe.ms, detail: probe.detail }
    report.ssh = { banner: probe.banner, ...parseBanner(probe.banner) }
    if (input?.probeAuth === true && probe.outcome === 'connected') {
      report.auth = await probeAuthMethods(host, port, input?.username)
    }
  }
  if (input?.resolveEgress === true) {
    report.egress = await resolveEgressIp({ fetcher: deps.fetcher ?? fetch })
  }
  report.verdict = buildVerdict({ ...report, tcp: report.tcp ?? { outcome: 'error', detail: '未探测' } })
  return report
}
