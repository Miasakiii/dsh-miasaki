// Fleet Monitor 的浏览器信任围栏 —— 与 appearance / ssh / sidebar 三条线同一套三道判定。
// 本线不 import 其它线代码（八线零耦合纪律），故为同构副本，判据与措辞刻意保持一致。
//
//   1. Host 头必须是 localhost / 环回字面量，或 FLEET_MONITOR_TRUSTED_HOSTS 里的一项；
//   2. `sec-fetch-site: cross-site` 一律拒绝（跨站请求由浏览器自己标注）；
//   3. Origin 存在时其 hostname 必须等于 Host 的 hostname（或环回）。
//
// 为什么必须有（2026-09-26 审计 P1.5）：本服务带一组**写接口**
// （POST /api/toggle/:agentId 直接落盘 control.json），而此前是 CORS 通配 `*` +
// 零鉴权 —— 全仓唯一「写接口零鉴权 + CORS 通配」的组合。只绑 127.0.0.1 挡不住
// 浏览器发起的跨站请求：绑定地址限制的是「谁能连」，不是「谁在被用户浏览器带着连」。

'use strict';

/** 去掉 Host 头里的端口。 */
function stripPort(host) {
  const text = typeof host === 'string' ? host.trim() : '';
  if (text === '') return '';
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    return end === -1 ? text.toLowerCase() : text.slice(0, end + 1).toLowerCase();
  }
  const colon = text.lastIndexOf(':');
  return (colon === -1 ? text : text.slice(0, colon)).toLowerCase();
}

/**
 * 判定一次请求是否来自可信来源。
 * @param {object} headers - Node 请求头对象。
 * @param {Set<string>} trustedHosts - 额外放行的主机名（已小写）。
 * @returns {{ok: boolean, reason?: string}} 判定结果。
 */
function fenceCheck(headers, trustedHosts) {
  const allowed = trustedHosts instanceof Set ? trustedHosts : new Set();
  const hostname = stripPort(headers && headers.host);
  if (!allowed.has(hostname) && hostname !== 'localhost' && hostname !== '127.0.0.1') {
    return { ok: false, reason: 'untrusted-host' };
  }
  if (headers && headers['sec-fetch-site'] === 'cross-site') {
    return { ok: false, reason: 'cross-site' };
  }
  const origin = headers && headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    let originHostname = null;
    try {
      originHostname = new URL(origin).hostname.toLowerCase();
    } catch {
      return { ok: false, reason: 'bad-origin' };
    }
    if (originHostname !== hostname && originHostname !== '127.0.0.1' && originHostname !== 'localhost') {
      return { ok: false, reason: 'untrusted-origin' };
    }
  }
  return { ok: true };
}

/** 构造放行主机名集合（localhost 与环回恒在其中）。 */
function buildTrustedHosts(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return new Set(['localhost', '127.0.0.1', ...[...list].map(item => String(item).trim().toLowerCase()).filter(Boolean)]);
}

/**
 * 只对**已通过围栏**的请求回显 CORS 头。
 *
 * 用回显而不用 `*`：通配会让任意来源的脚本合法读到本面板的响应（含 agent 成本账本），
 * 而跨站请求本来就在围栏处 403、永远走不到这里。`Vary: Origin` 保证中间层不串缓存。
 */
function corsHeadersFor(headers) {
  const origin = headers && typeof headers.origin === 'string' ? headers.origin : '';
  const out = { Vary: 'Origin' };
  if (origin !== '') {
    out['Access-Control-Allow-Origin'] = origin;
    out['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    out['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  return out;
}

module.exports = { stripPort, fenceCheck, buildTrustedHosts, corsHeadersFor };
