/**
 * dsh-token-monitor — 路由信任围栏（I5，2026-09-30）。
 *
 * 为什么需要：本插件按 `kind: 'exact'` 注册在 webServer 上，而 exact 分发的优先级
 * 高于内核 `/api` 的处理链 ⇒ 这些路由**不经过** composition 自己的准入检查。
 * 在此之前，本线是九线里**唯一没有同源围栏**的一条 —— 2026-09-29 实测：
 * 非环回 `Host`、跨站（`sec-fetch-site: cross-site`）打 `/dsh-token-monitor/*`
 * 两轴都返回 **200**，其中 `POST /reset` 是**清空账本**的写操作。
 *
 * 定级：响应不带任何 CORS 头 ⇒ 浏览器页面读不到响应体，实际暴露面限于本机进程，
 * 属**纵深防御缺失**（非当场可利用漏洞）。补法与 appearance / ssh / dual-model /
 * free-model 四线同款 —— 九线代码零耦合，各带一份实现，但口径一致。
 *
 * 两层，按序尝试（与 @miasaki/dsh-free-model 的 `lib/trust.js` 同构）：
 *  1. composition 挂了 `connection` 服务时，用官方准入判定（`requestRejection`，
 *     与内核 `/api` 同级：信任围栏 + 浏览器鉴权 cookie）。**必须逐请求读取** ——
 *     该服务可能比本插件晚 provide，若在装载时快照一次，围栏会整轮退化成第 2 层。
 *  2. 没有该服务时用结构化复刻：只允许回环 Host、拒绝跨站 fetch、
 *     Origin/Referer 存在时必须与本机 Host 同名；**Host 缺失或为空一律拒绝**
 *     （fail closed，不退回 socket 本地地址）。
 *
 * 纯官方契约：只读请求头与 `ctx.get('connection')`，不碰任何 miasaki 内部实现。
 *
 * @module dsh-token-monitor/fence
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
 *     更不会触碰账本（`/reset` 的写路径在围栏之后）。
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
