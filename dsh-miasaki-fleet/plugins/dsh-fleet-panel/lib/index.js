/**
 * @miasaki/dsh-fleet-panel — host 半（2026-10-19，P0「看得见」批次）。
 *
 * 职责只有两件，都刻意保持薄：
 *  1. **确保 fleet-monitor 在跑**：先探测 `127.0.0.1:<port>/api/fleet`；
 *     已在跑就复用（不重复拉起），不在跑就以隐藏窗口拉起
 *     `fleet-monitor/server.js`。**只有本插件拉起的实例才由本插件回收**
 *     （复用别人拉起的实例时不动它）。
 *  2. **同源托管面板**：`/dsh-fleet/panel` 返回改写后的 panel.html（把页面里的
 *     API 基址从 `http://127.0.0.1:39801` 改成 `/dsh-fleet`），`/dsh-fleet/api/*`
 *     原样代理到 fleet-monitor 的 `/api/*`，`/dsh-fleet/health` 供浮窗探活与重试。
 *
 * **不重写任何判定**：可派集 / 能力断层 / 事件流 / 验证者的口径全部留在
 * fleet-monitor（它 spawn 现成 CLI，与派单器判定同源）—— 与仓库「判定单点」
 * 纪律一致；本插件只做传输层。
 *
 * 三条路由都过 `fence.js` 的三道信任围栏（与其它线同构）。`POST
 * /dsh-fleet/api/toggle/*` 最终会触发 monitor 的写接口（落盘 control.json），
 * 围栏必须排在业务之前。
 *
 * @module @miasaki/dsh-fleet-panel
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fenceHandler } from './fence.js';

export const inject = ['webServer'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const DEFAULT_FLEET_ROOT = process.env.MIASAKI_FLEET_ROOT || path.resolve(PLUGIN_ROOT, '..', '..');
const DEFAULT_PORT = Number.parseInt(process.env.FLEET_MONITOR_PORT || '39801', 10);
const MONITOR_ORIGIN_HOST = '127.0.0.1';

const PROBE_TIMEOUT_MS = 800;
const START_TIMEOUT_MS = 6000;
const START_POLL_MS = 150;
const PROXY_TIMEOUT_MS = 10000;
const MAX_PROXY_BODY = 1024 * 1024;

/** 运行期配置：默认值（生产走默认），测试可经 apply(ctx, config) 覆盖。 */
const options = {
	autoStart: true,
	noSpawn: false,
	fleetRoot: DEFAULT_FLEET_ROOT,
	port: DEFAULT_PORT,
};

/** 本插件拉起的 monitor 子进程（复用别人拉起的实例时保持 null）。 */
let child = null;
/** 拉起失败/探活失败的最近原因 —— 不静默：health 端点原样下发。 */
let lastError = null;
/** 单飞：多个请求同时触发时只拉起一次。 */
let ensurePromise = null;
/** `process.once('exit')` 只挂一次。 */
let exitHookInstalled = false;

function monitorDir() {
	return path.join(options.fleetRoot, 'fleet-monitor');
}

function monitorScript() {
	return path.join(monitorDir(), 'server.js');
}

function panelHtmlPath() {
	return path.join(monitorDir(), 'panel.html');
}

function monitorOrigin() {
	return `http://${MONITOR_ORIGIN_HOST}:${options.port}`;
}

/**
 * 探测 fleet-monitor 是否已在服务。
 * 判据是应用层：`GET /api/fleet` 返回可解析 JSON（不是 TCP 端口通就算好 ——
 * 端口被别的进程占用时「端口通」会给出假阳性，这正是桌面壳 P10 的教训）。
 *
 * @returns {Promise<{ok: boolean, reused?: boolean, error?: string}>}
 */
export function probeMonitor(timeoutMs = PROBE_TIMEOUT_MS) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const req = http.get(`${monitorOrigin()}/api/fleet`, { timeout: timeoutMs }, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => {
				if (res.statusCode !== 200) {
					done({ ok: false, error: `fleet-monitor 返回 HTTP ${res.statusCode}` });
					return;
				}
				try {
					const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
					if (!body || typeof body !== 'object') throw new Error('响应不是对象');
					done({ ok: true, reused: true });
				} catch (e) {
					done({ ok: false, error: `fleet-monitor 响应不可解析：${String((e && e.message) || e)}` });
				}
			});
		});
		req.on('timeout', () => {
			req.destroy(new Error('探活超时'));
		});
		req.on('error', (e) => {
			done({ ok: false, error: `fleet-monitor 不可达：${String((e && e.message) || e)}` });
		});
	});
}

/** 以隐藏窗口拉起 fleet-monitor；不接管 stdout/stderr（避免管道依赖）。 */
function spawnMonitor() {
	const script = monitorScript();
	if (!fs.existsSync(script)) {
		throw new Error(`fleet-monitor 入口不存在：${script}（检查 MIASAKI_FLEET_ROOT）`);
	}
	const proc = spawn(process.execPath, [script], {
		cwd: monitorDir(),
		env: process.env,
		windowsHide: true,
		stdio: 'ignore',
	});
	child = proc;
	lastError = null;
	proc.once('error', (e) => {
		lastError = `拉起 fleet-monitor 失败：${String((e && e.message) || e)}`;
		if (child === proc) child = null;
	});
	proc.once('exit', (code, signal) => {
		// 非本插件主动回收的退出 = 异常退出，记原因（主动 stopMonitor 会把 child 置 null）。
		if (child === proc) {
			lastError = `fleet-monitor 已退出（code=${code === null ? 'null' : code}, signal=${signal || 'none'}）`;
			child = null;
		}
	});
	return proc;
}

/** 轮询等待 monitor 就绪。 */
async function waitReady(deadline) {
	while (Date.now() < deadline) {
		const probe = await probeMonitor();
		if (probe.ok) return { ok: true, reused: false };
		lastError = probe.error || lastError;
		await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
	}
	return { ok: false, error: lastError || 'fleet-monitor 在超时内未就绪' };
}

/**
 * 确保 monitor 在跑（单飞）。返回值原样给 health 端点：
 * `{ok, reused, pid, error}`。
 */
export function ensureMonitor() {
	if (ensurePromise) return ensurePromise;
	ensurePromise = (async () => {
		const probe = await probeMonitor();
		if (probe.ok) {
			// 复用成功：清掉之前的探活错误，避免 health 在「ok:true」的同时带一条旧错误误导排查。
			lastError = null;
			return { ok: true, reused: true, pid: child ? child.pid : null };
		}
		if (options.noSpawn) {
			return { ok: false, reused: false, pid: null, error: lastError || '禁止拉起（noSpawn）' };
		}
		if (!options.autoStart) {
			return { ok: false, reused: false, pid: null, error: '未自动启动（autoStart=false）' };
		}
		let proc;
		try {
			proc = spawnMonitor();
		} catch (e) {
			lastError = String((e && e.message) || e);
			return { ok: false, reused: false, pid: null, error: lastError };
		}
		const ready = await waitReady(Date.now() + START_TIMEOUT_MS);
		if (!ready.ok) {
			return { ok: false, reused: false, pid: proc.pid || null, error: ready.error || lastError };
		}
		lastError = null;
		return { ok: true, reused: false, pid: proc.pid || null };
	})().finally(() => {
		ensurePromise = null;
	});
	return ensurePromise;
}

/** 只回收本插件拉起的实例（复用别人的不动）。 */
export function stopMonitor() {
	if (child) {
		const proc = child;
		child = null;
		try {
			proc.kill();
		} catch (e) {
			// 已经退出/无权限：无需处理，但记原因供 health 排查。
			lastError = `回收 fleet-monitor 失败：${String((e && e.message) || e)}`;
		}
	}
}

/**
 * 把 panel.html 里的 API 基址从「直连 39801」改成同源前缀 `/dsh-fleet`。
 *
 * 锚点是 panel.html 里那行 `if (location.port === '39801') return location.origin;`。
 * **找不到锚点必须抛错**：静默返回原页面会让面板在 iframe 里直连 39801（跨源），
 * 表现为「页面能开但数据全空」，属于最难查的一类静默失效。
 *
 * 另修一处同源漏网（2026-10-20 实机发现）：panel.html 的**判定层四块**用的是绝对路径
 * `j('/api/dispatchable')` 之类，**不走 API_BASE** —— 只改基址的话它们会打到 DSH 自身的
 * `/api/*`（返回 `not found` 文本），面板 `JSON.parse` 报
 * `SyntaxError: Unexpected token 'o'`，四块全部显示「不可用」。故一并改写为
 * `/dsh-fleet/api/...`（与代理前缀对齐）。
 *
 * @param {string} html
 * @returns {string}
 */
export function rewritePanelHtml(html) {
	const anchor = "if (location.port === '39801') return location.origin;";
	if (typeof html !== 'string' || !html.includes(anchor)) {
		throw new Error('panel.html 未找到 API_BASE 锚点 —— 拒绝静默返回原页面（面板数据会全空）');
	}
	const rebased = html.replace(anchor, "return '/dsh-fleet';");
	// 判定层端点（j('/api/...')）走绝对路径，必须同步加同源前缀。
	return rebased.split("j('/api/").join("j('/dsh-fleet/api/");
}

/**
 * 把 `/dsh-fleet/api/...` 转成上游 `/api/...`；前缀不符返回 null。
 * @param {string} rawUrl `req.url`（可能带 query）
 * @returns {string | null}
 */
export function buildProxyTarget(rawUrl) {
	const raw = typeof rawUrl === 'string' ? rawUrl : '';
	const q = raw.indexOf('?');
	const pathname = q === -1 ? raw : raw.slice(0, q);
	const search = q === -1 ? '' : raw.slice(q);
	if (pathname !== '/dsh-fleet/api' && !pathname.startsWith('/dsh-fleet/api/')) return null;
	return pathname.slice('/dsh-fleet'.length) + search;
}

function sendJSON(res, status, value) {
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-store');
	res.end(JSON.stringify(value, null, 2));
}

async function handleHealth(_req, res) {
	const state = await ensureMonitor();
	sendJSON(res, 200, {
		ok: state.ok === true,
		running: state.ok === true,
		reused: state.reused === true,
		pid: state.pid ?? null,
		error: state.ok === true ? null : (state.error ?? lastError ?? null),
		port: options.port,
		fleet_root: options.fleetRoot,
		panel: '/dsh-fleet/panel',
	});
}

async function handlePanel(_req, res) {
	const file = panelHtmlPath();
	try {
		const html = fs.readFileSync(file, 'utf8');
		const rewritten = rewritePanelHtml(html);
		res.statusCode = 200;
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.setHeader('Cache-Control', 'no-store');
		res.end(rewritten);
	} catch (e) {
		sendJSON(res, 500, { ok: false, error: String((e && e.message) || e) });
	}
}

function pipeProxy(req, res, target) {
	const headers = { ...req.headers, host: `${MONITOR_ORIGIN_HOST}:${options.port}` };
	// 跳过头：由本层重新计算（长度随转发内容变化，避免上游误判）。
	delete headers['transfer-encoding'];
	delete headers['content-length'];

	const chunks = [];
	let size = 0;
	let aborted = false;

	const upstream = http.request(
		{
			host: MONITOR_ORIGIN_HOST,
			port: options.port,
			path: target,
			method: req.method,
			headers,
			timeout: PROXY_TIMEOUT_MS,
		},
		(upRes) => {
			const body = [];
			upRes.on('data', (c) => body.push(c));
			upRes.on('end', () => {
				if (aborted) return;
				res.statusCode = upRes.statusCode || 502;
				const ct = upRes.headers['content-type'] || 'application/json; charset=utf-8';
				res.setHeader('Content-Type', ct);
				res.setHeader('Cache-Control', 'no-store');
				res.end(Buffer.concat(body));
			});
		},
	);
	upstream.on('timeout', () => {
		upstream.destroy(new Error(`上游 ${PROXY_TIMEOUT_MS}ms 超时`));
	});
	upstream.on('error', (e) => {
		if (aborted) return;
		aborted = true;
		sendJSON(res, 502, { ok: false, error: `fleet-monitor 代理失败：${String((e && e.message) || e)}` });
	});

	req.on('data', (c) => {
		size += c.length;
		if (size > MAX_PROXY_BODY) {
			aborted = true;
			req.destroy();
			upstream.destroy();
			sendJSON(res, 413, { ok: false, error: '请求体过大' });
			return;
		}
		chunks.push(c);
	});
	req.on('end', () => {
		if (aborted) return;
		if (chunks.length) {
			const body = Buffer.concat(chunks);
			upstream.setHeader('Content-Length', String(body.length));
			upstream.write(body);
		}
		upstream.end();
	});
	req.on('error', () => {
		if (aborted) return;
		aborted = true;
		upstream.destroy();
		sendJSON(res, 502, { ok: false, error: '客户端请求读取失败' });
	});
}

async function handleProxy(req, res) {
	const target = buildProxyTarget(req.url);
	if (!target) {
		sendJSON(res, 404, { ok: false, error: '未知的 /dsh-fleet/api 路径' });
		return;
	}
	const state = await ensureMonitor();
	if (!state.ok) {
		sendJSON(res, 502, { ok: false, error: state.error || 'fleet-monitor 未就绪' });
		return;
	}
	pipeProxy(req, res, target);
}

/**
 * 插件入口。
 * @param ctx cordis 上下文
 * @param {{autoStart?: boolean, noSpawn?: boolean, fleetRoot?: string, port?: number}} [config]
 *   `autoStart:false` 只注册路由、不主动拉起（测试用）；`fleetRoot`/`port` 供夹具覆盖。
 */
export function apply(ctx, config) {
	if (config && typeof config === 'object') {
		if (typeof config.autoStart === 'boolean') options.autoStart = config.autoStart;
		if (typeof config.noSpawn === 'boolean') options.noSpawn = config.noSpawn;
		if (typeof config.fleetRoot === 'string' && config.fleetRoot) options.fleetRoot = config.fleetRoot;
		if (Number.isInteger(config.port) && config.port > 0) options.port = config.port;
	}

	const getConnection = () => {
		try {
			return ctx.get('connection');
		} catch {
			return undefined;
		}
	};

	ctx.webServer.register({
		kind: 'prefix',
		path: '/dsh-fleet/api',
		handler: fenceHandler((req, res) => handleProxy(req, res), getConnection),
	});
	ctx.webServer.register({
		kind: 'exact',
		path: '/dsh-fleet/panel',
		handler: fenceHandler((req, res) => handlePanel(req, res), getConnection),
	});
	ctx.webServer.register({
		kind: 'exact',
		path: '/dsh-fleet/health',
		handler: fenceHandler((req, res) => handleHealth(req, res), getConnection),
	});

	// 预热：DSH 启动即把 monitor 拉起来（用户点开浮窗前就绪）。
	// 失败不抛（插件加载不能因 monitor 起不来而整树失败），原因留在 health 端点。
	ensureMonitor().catch((e) => {
		lastError = String((e && e.message) || e);
	});

	// 回收：本插件拉起的实例在插件卸载/进程退出时带走（复用别人的不动）。
	try {
		if (typeof ctx.on === 'function') ctx.on('dispose', stopMonitor);
	} catch {
		// 宿主没有 dispose 事件时靠 process exit 钩子兜底。
	}
	if (!exitHookInstalled) {
		exitHookInstalled = true;
		process.once('exit', stopMonitor);
	}
}

/** 测试钩子：只暴露纯函数与状态，不改变生产行为。 */
export const __test = {
	rewritePanelHtml,
	buildProxyTarget,
	probeMonitor,
	ensureMonitor,
	stopMonitor,
	fleetRoot: () => options.fleetRoot,
	monitorDir,
	monitorScript,
	panelHtmlPath,
	options,
};
