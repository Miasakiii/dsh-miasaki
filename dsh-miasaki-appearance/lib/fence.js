// 浏览器信任围栏 —— 与 ssh / sidebar 两条线同一套（DSH 自带的 /api 围栏不覆盖本线路由）。
//
//  1. Host 头必须是 localhost / 环回字面量，或 config.trustedHosts 里的一项；
//  2. `sec-fetch-site: cross-site` 一律拒绝（跨站请求由浏览器自己标注）；
//  3. Origin 存在时其 hostname 必须等于 Host 的 hostname（或环回）。
//
// 本线只有只读配置与一条写配置的路由，没有文件系统或进程能力，但围栏仍保留：
// 它挡住的是「任意网页借用户浏览器改本机 GUI 配置」这一类请求。

/** 去掉 Host 头里的端口。 */
export function stripPort(host) {
  const text = typeof host === 'string' ? host.trim() : ''
  if (text === '') return ''
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    return end === -1 ? text.toLowerCase() : text.slice(0, end + 1).toLowerCase()
  }
  const colon = text.lastIndexOf(':')
  return (colon === -1 ? text : text.slice(0, colon)).toLowerCase()
}

/**
 * 判定一次请求是否来自可信来源。
 * @param {object} headers - Node 请求头对象。
 * @param {Set<string>} trustedHosts - 额外放行的主机名（已小写）。
 * @returns {{ok: boolean, reason?: string}} 判定结果。
 */
export function fenceCheck(headers, trustedHosts) {
  const hostname = stripPort(headers?.host)
  if (!trustedHosts.has(hostname) && hostname !== 'localhost' && hostname !== '127.0.0.1') {
    return { ok: false, reason: 'untrusted-host' }
  }
  if (headers?.['sec-fetch-site'] === 'cross-site') {
    return { ok: false, reason: 'cross-site' }
  }
  if (typeof headers?.origin === 'string' && headers.origin.length > 0) {
    let originHostname = null
    try {
      originHostname = new URL(headers.origin).hostname.toLowerCase()
    } catch {
      return { ok: false, reason: 'bad-origin' }
    }
    if (originHostname !== hostname && originHostname !== '127.0.0.1' && originHostname !== 'localhost') {
      return { ok: false, reason: 'untrusted-origin' }
    }
  }
  return { ok: true }
}

/** 构造放行主机名集合（localhost 与环回恒在其中）。 */
export function buildTrustedHosts(raw) {
  const list = Array.isArray(raw) ? raw : []
  return new Set(['localhost', '127.0.0.1', ...[...list].map(item => String(item).trim().toLowerCase()).filter(Boolean)])
}
