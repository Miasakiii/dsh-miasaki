// 浏览器信任围栏 —— 与 ssh / sidebar 两条线同一套（DSH 自带的 /api 围栏不覆盖本线路由）。
//
//  1. Host 头必须是 localhost / 环回字面量，或 config.trustedHosts 里的一项；
//  2. `sec-fetch-site: cross-site` 一律拒绝（跨站请求由浏览器自己标注）；
//  3. Origin 存在时：hostname 必须**等于** Host 的 hostname，且端口必须与 Host 端口一致
//     （2026-10-19 04af2：此前 hostname 命中环回别名就无条件放行、且完全不比端口 ——
//     同站跨端口页面（same-site + 无预检）因此能改本机 GUI 配置）。Chromium 某些构建会
//     剥掉非默认回环端口（`Origin: http://127.0.0.1`），此时退回 hostname 判定，不误拒。
//
// 本线只有只读配置与一条写配置的路由，没有文件系统或进程能力，但围栏仍保留：
// 它挡住的是「任意网页借用户浏览器改本机 GUI 配置」这一类请求。三道都是纵深防御，
// 不是鉴权本身（写配置路由没有 token/认证）。
//
// 后续可选加固（本批未做，见 design/CHANGELOG.md 2026-10-19 条）：拒绝
// `sec-fetch-site` 非 `same-origin` 的请求、写路由要求自定义请求头（强制预检）。

/** 从 Host 头拆出 hostname 与端口；无端口 / 端口非数字时 port 为 null。 */
export function splitHostPort(host) {
  const text = typeof host === 'string' ? host.trim() : ''
  if (text === '') return { hostname: '', port: null }
  // IPv6 字面量带方括号：[::1] / [::1]:3080。hostname 与 URL.hostname 同形（保留方括号）。
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end === -1) return { hostname: text.toLowerCase(), port: null }
    const rest = text.slice(end + 1)
    const match = /^:(\d{1,5})$/.exec(rest)
    return { hostname: text.slice(0, end + 1).toLowerCase(), port: match === null ? null : match[1] }
  }
  const colon = text.lastIndexOf(':')
  if (colon === -1) return { hostname: text.toLowerCase(), port: null }
  const match = /^\d{1,5}$/.exec(text.slice(colon + 1))
  return { hostname: text.slice(0, colon).toLowerCase(), port: match === null ? null : match[0] }
}

/** 去掉 Host 头里的端口。 */
export function stripPort(host) {
  return splitHostPort(host).hostname
}

/**
 * Host 是否落在环回 / trustedHosts 白名单内。
 *
 * 文件路由（`/appearance/wallpaper|avatar`）用它做**只查 Host** 的准入 ——
 * `<img>` 请求可能没有 Origin，所以那里不套 Origin / Sec-Fetch-Site 判据。
 * @param {string|undefined} host - `req.headers.host`。
 * @param {Set<string>} trustedHosts - 额外放行的主机名（已小写）。
 * @returns {boolean} 是否可信。
 */
export function isTrustedHost(host, trustedHosts) {
  const { hostname } = splitHostPort(host)
  return trustedHosts.has(hostname) || hostname === 'localhost' || hostname === '127.0.0.1'
}

/**
 * 判定一次请求是否来自可信来源。
 * @param {object} headers - Node 请求头对象。
 * @param {Set<string>} trustedHosts - 额外放行的主机名（已小写）。
 * @returns {{ok: boolean, reason?: string}} 判定结果。
 */
export function fenceCheck(headers, trustedHosts) {
  const { hostname, port: hostPort } = splitHostPort(headers?.host)
  if (!trustedHosts.has(hostname) && hostname !== 'localhost' && hostname !== '127.0.0.1') {
    return { ok: false, reason: 'untrusted-host' }
  }
  if (headers?.['sec-fetch-site'] === 'cross-site') {
    return { ok: false, reason: 'cross-site' }
  }
  if (typeof headers?.origin === 'string' && headers.origin.length > 0) {
    let origin = null
    try {
      origin = new URL(headers.origin)
    } catch {
      return { ok: false, reason: 'bad-origin' }
    }
    const originHostname = origin.hostname.toLowerCase()
    // 回环豁免已删除（04af2）：Origin hostname 必须等于 Host hostname ——
    // Host 已先被校验为环回/trusted，因此这里不再接受「任意环回别名」。
    if (originHostname !== hostname) {
      return { ok: false, reason: 'untrusted-origin' }
    }
    // 端口判据（04af2）：同站不同端口 = same-site、无预检，能改配置；Origin 显式带端口
    // 时必须与 Host 端口相等。Origin 端口被浏览器剥掉（''）⇒ 退回 hostname 判定（兼容）。
    if (origin.port !== '') {
      const expectedPort = hostPort === null ? (origin.protocol === 'https:' ? 443 : 80) : Number(hostPort)
      if (Number(origin.port) !== expectedPort) {
        return { ok: false, reason: 'cross-port-origin' }
      }
    }
  }
  return { ok: true }
}

/** 构造放行主机名集合（localhost 与环回恒在其中）。 */
export function buildTrustedHosts(raw) {
  const list = Array.isArray(raw) ? raw : []
  return new Set(['localhost', '127.0.0.1', ...[...list].map(item => String(item).trim().toLowerCase()).filter(Boolean)])
}
