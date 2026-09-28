/**
 * @miasaki/dsh-free-model — 路由信任围栏。
 *
 * 本插件按 `kind: 'exact'` 注册在 webServer 上。exact 分发的优先级高于内核
 * `/api` 的处理链，所以这些路由**不会**经过 composition 自己的准入检查 ——
 * 不加围栏时，任何能解析到本机回环地址的页面都可以直接
 * `POST /freemodel-api/apply` 改写模型配置（**写操作**），或
 * `POST /freemodel-api/subagent` 改写预设文件。本模块关掉这个口子。
 *
 * 两层，按序尝试：
 *
 * 1. composition 挂了 `connection` 服务时，用它给出的准入判定
 *    （`requestRejection`，与内核 `/api` 完全同级：信任围栏 + 浏览器鉴权 cookie）
 *    —— 插件因此永远不会比应用本身更弱。**必须逐请求读取**：该服务可能比本插件
 *    晚 provide，若在 apply 时快照一次，围栏会在整轮进程里退化成第 2 层
 *    （同类教训见 dsh-our-free-model 的实测记录）。
 * 2. 没有该服务时，用结构化复刻：只允许回环 Host、拒绝跨站 fetch、
 *    Origin/Referer 存在时必须与本机 Host 同名；**Host 缺失或为空一律拒绝**
 *    （fail closed，不退回 socket 本地地址）。
 *
 * 这两层都是**纵深防御**而非鉴权本身：真正的鉴权由 connection 服务的 cookie
 * 完成，结构层挡的是 DNS rebinding 与跨站触发。
 *
 * @module @miasaki/dsh-free-model/trust
 */

/** 同机浏览器可以合法使用的 Host 名（去端口后比较；IPv6 保留方括号，与 URL.hostname 同形）。 */
const TRUSTED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 把 Host / Origin / Referer 的原始值取成小写 hostname；解析不出来返回 null。 */
function hostnameOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const raw = value.trim();
  try {
    // Host 头不带 scheme，Origin/Referer 带；补一个再解析，两种形状共用一条路径。
    return new URL(raw.includes('://') ? raw : `http://${raw}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 结构化围栏：不依赖任何服务，只看请求头。导出是为了单测能直接打它。
 * @param headers - 请求头（`req.headers`）。
 * @returns `{ok:true}` 或 `{ok:false, status, error}`。
 */
export function structuralFence(headers) {
  const hostname = hostnameOf(headers?.host);
  if (hostname === null || !TRUSTED_HOSTNAMES.has(hostname)) {
    return { ok: false, status: 403, error: '不被信任的 Host' };
  }
  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
    return { ok: false, status: 403, error: '跨站请求被拒绝' };
  }
  for (const name of ['origin', 'referer']) {
    const raw = headers[name];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const originHostname = hostnameOf(raw);
    // `Origin: null`（opaque origin）解析出的 hostname 不会命中白名单，同样被拒。
    if (originHostname === null || originHostname !== hostname) {
      return { ok: false, status: 403, error: '跨站来源被拒绝' };
    }
  }
  return { ok: true };
}

/**
 * 判定一个请求是否放行。
 * @param headers - 请求头（`req.headers`）。
 * @param connection - **当次** `ctx.get('connection')` 的结果；调用方必须逐请求读取。
 * @returns `{ok:true}` 或 `{ok:false, status, error}`。
 */
export function trustFence(headers, connection) {
  if (connection !== undefined && connection !== null && typeof connection.requestRejection === 'function') {
    try {
      const rejection = connection.requestRejection({ headers });
      if (rejection === 401) return { ok: false, status: 401, error: '未通过浏览器鉴权' };
      if (rejection === 403) return { ok: false, status: 403, error: '请求来源不被信任' };
      if (rejection === undefined) return { ok: true };
    } catch {
      // connection 抛错属 composition 缺陷：退回结构层，而不是让每个请求 500。
    }
  }
  return structuralFence(headers);
}
