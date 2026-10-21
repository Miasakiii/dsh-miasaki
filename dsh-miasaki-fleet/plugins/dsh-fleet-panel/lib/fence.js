/**
 * dsh-fleet-panel — 路由信任围栏（2026-10-19，P0）。
 *
 * 为什么需要：本插件向 webServer 注册 `/dsh-fleet/*` 三条路由（exact + prefix），
 * 其中 `/dsh-fleet/api/*` 会把请求**代理到 fleet-monitor 的写接口**
 * （`POST /api/toggle/:agentId` 会落盘 control.json）。官方 webServer 的
 * 命名路由不分发浏览器鉴权，因此三条路由都必须自带同源围栏，口径与
 * appearance / ssh / sidebar / dual-model / free-model / usage 六线同构
 * （九线代码零耦合，各带一份实现，判据一致）。
 *
 * 两层，按序尝试：
 *  1. composition 挂了 `connection` 服务时，用官方准入判定（`requestRejection`）。
 *     **必须逐请求读取** —— 该服务可能比本插件晚 provide。
 *  2. 没有该服务时用结构化复刻：只允许回环 Host、拒绝跨站 fetch、
 *     Origin/Referer 存在时必须与本机 Host 同名；Host 缺失或为空一律拒绝
 *     （fail closed，不退回 socket 本地地址）。
 *
 * @module dsh-fleet-panel/fence
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
 * @param headers 请求头（`req.headers`）
 * @returns `{ok:true}` 或 `{ok:false, status, error}`
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
 * @param headers 请求头（`req.headers`）
 * @param connection **当次** `ctx.get('connection')` 的结果；调用方必须逐请求读取
 * @returns `{ok:true}` 或 `{ok:false, status, error}`
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

/**
 * 把一个业务 handler 包成「先过围栏，再进业务」。
 *
 * 存在的意义有两条：
 *  ① **围栏先于一切业务判定** —— 跨站 POST 打过来得到的是 403，而不是 405/400，
 *     更不会触碰代理与 monitor 的写接口。
 *  ② 接入点单点化 —— lib/index.js 在 register 处统一包装，新增路由不会漏挂围栏。
 *
 * @param handler 业务 handler `(req, res) => void`
 * @param getConnection 每次请求**重新**取 connection 的函数（逐请求读取）
 */
export function fenceHandler(handler, getConnection) {
	return (req, res) => {
		let connection;
		try {
			connection = typeof getConnection === 'function' ? getConnection() : undefined;
		} catch {
			connection = undefined;
		}
		const verdict = trustFence(req?.headers || {}, connection);
		if (!verdict.ok) {
			res.statusCode = verdict.status;
			res.setHeader('Content-Type', 'application/json; charset=utf-8');
			res.setHeader('Cache-Control', 'no-store');
			res.end(JSON.stringify({ ok: false, error: verdict.error }));
			return;
		}
		return handler(req, res);
	};
}
