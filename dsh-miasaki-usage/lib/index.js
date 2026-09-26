/**
 * dsh-token-monitor — host half。
 *
 * 数据三通道：
 * - 官方持久聚合：sessionProjections（tokenUsage / contextPressure /
 *   contextBreakdown / sessionStats）+ tokenMeter.measure —— 覆盖整个
 *   会话日志，跨进程重启可用。
 * - 实时明细：llm/stream 按 (sessionId, provider, model) 累计 provider
 *   实报 usage（inputTokens / outputTokens / cacheReadTokens /
 *   reasoningTokens），tools/result 按 (sessionId, 工具名) 计数 ——
 *   自本进程启动起。
 * - 跨会话账本：与实时明细同口径的增量按日累计并落盘
 *   `usage-log.jsonl`（5s 节流 flush + 进程退出兜底），支撑热力图 /
 *   近 30 天趋势 / 模型用量占比 / 总览统计。账本另记每日调用次数
 *   （calls ≈ 轮消息）与每会话活跃跨度（first/last，用于「最长聊天
 *   时长」，以 `type:'span'` 快照行落盘、min/max 合并）。保留窗口
 *   LEDGER_DAYS 天，超窗条目在 flush 时剪除。限额配置存 `config.json`，
 *   跨 host 重启持久。数据目录：优先宿主提供的插件数据目录服务，否则
 *   `~/.dsh/plugins-data/dsh-token-monitor/`。
 * - 会话身份（v0.5.0）：账本按 sessionId 聚合，而 `session-<uuid>` 排在一列
 *   等于没有信息，且 `sessions.get` 只认当前活着的会话（已归档一律
 *   undefined）。标题与工作目录改由 `sessionQuery.readTitleSnapshots` 折叠
 *   会话日志取得（支持已持久化会话、批量、按会话隔离失败），带 TTL 缓存 +
 *   启动预热；冷读约 0.3s/会话，只发生在首轮。
 *
 * 对外暴露（webServer 精确路由，`{ok, error}` 包装对齐 dsh-free-model-pool）。
 * v0.4.0 起按视图拆分（旧 /summary 退役）：会话内归 /session，跨会话归 /global。
 * - GET  /dsh-token-monitor/session?sessionId=…  当前会话：官方聚合 + 实时明细
 *        （live.calls / live.tools 按 sessionId 过滤 + 会话活跃跨度）——会话页专用
 * - GET  /dsh-token-monitor/global               跨会话：总览统计 / 今日 / 近 30 天
 *        趋势（含按模型明细）/ 会话活跃分布（近 30 日按 sessionId 聚合，含逐日
 *        用量与窗口分母）/ 限额
 * - GET  /dsh-token-monitor/heatmap              稀疏每日账单（热力图数据源）
 * - GET  /dsh-token-monitor/config               限额配置
 * - POST /dsh-token-monitor/config               body `{dailyTokenLimit: number|null}`
 * - POST /dsh-token-monitor/reset                清空账本（配置保留，不可恢复）
 *
 * @module dsh-token-monitor
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-token-monitor';
export const inject = ['webServer'];

/** 账本保留窗口（天）：覆盖热力图一年视图 + 余量。 */
const LEDGER_DAYS = 380;
/** 启动载入的文件尾部上限；~150B/行约可容一年。 */
const TAIL_BYTES = 8 * 1024 * 1024;
/** 会话跨度快照最小推进间隔：活跃会话每分钟至多落一行。 */
const SPAN_FLUSH_MS = 60 * 1000;
/**
 * 全局页「会话活跃分布」下发的会话条数上限（v0.5.0）：客户端在这份集合上做
 * 排序键切换 / 标题搜索 / 条数切换，避免每次交互都回主机取数；只取 Top N
 * 会让"按轮消息"排序与搜索在截断后的集合上进行，故上限放到 50。
 */
const SESSION_TOPN = 50;
/** 「会话活跃分布」目录维度的下发条数上限（与会话维度同量级）。 */
const CWD_TOPN = 50;
/** 会话标题缓存窗口：已有标题 30 分钟内不重读日志。 */
const TITLE_TTL_MS = 30 * 60 * 1000;
/** 尚无标题（日志里还没落 title 事件的会话）的重试间隔。 */
const TITLE_RETRY_MS = 2 * 60 * 1000;
/** 全局页等待标题折叠的上限：超时则本次先用截断 ID，后台补完下一轮轮询即有。 */
const TITLE_WAIT_MS = 2500;
/** 账本载入后预热标题的延迟（先让宿主 boot 稳定，再去做磁盘侧折叠）。 */
const TITLE_WARM_DELAY_MS = 1500;

/** 本地时区日期键（YYYY-MM-DD，用户视角的"今日"）。 */
function localDate(t) {
	const d = t || new Date();
	return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 往前 days 天的日期键。 */
function dateOffset(days) {
	const d = new Date();
	d.setDate(d.getDate() + days);
	return localDate(d);
}

/** 日期键差（b - a，单位天），按 UTC 日历日求差规避夏令时。 */
function diffDays(a, b) {
	const pa = a.split('-').map(Number);
	const pb = b.split('-').map(Number);
	return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

/** 插件数据目录：优先宿主服务，否则 ~/.dsh/plugins-data/<name>/。 */
function resolveDataDir(ctx) {
	try {
		for (const k of ['pluginData', 'dataDir', 'storage']) {
			const v = ctx.get(k);
			if (typeof v === 'string' && v) return path.join(v, name);
			if (v && typeof v === 'object') {
				if (typeof v.resolve === 'function') {
					const r = v.resolve(name);
					if (typeof r === 'string' && r) return r;
				}
				if (typeof v.dir === 'string' && v.dir) return path.join(v.dir, name);
			}
		}
	} catch (e) { /* 探测失败走默认 */ }
	return path.join(os.homedir(), '.dsh', 'plugins-data', name);
}

/**
 * 当前 profile 名 —— **账本口径的隔离键**（2026-09-26「统计要干净」）：
 * 官方桌面端（`desktop`）、自制壳（`miasaki`）、浏览器 GUI（`web`）各记各的账，
 * 官方桌面端的统计里不会再混进自制壳的消耗。来源优先宿主 `profileContext` 服务
 * （`profile-boot` 提供，字段 `name`），其次进程环境变量 `DSH_PROFILE`（launcher 注入），
 * 最后回落 `default`——三档都拿不到时退化为旧的「全局单账本」语义，不会丢数据。
 */
function resolveProfileName(ctx) {
	try {
		const pc = ctx.get('profileContext');
		if (pc && typeof pc.name === 'string' && pc.name.trim()) return pc.name.trim();
	} catch (e) { /* 服务缺席：走环境变量 */ }
	const env = process.env.DSH_PROFILE;
	if (typeof env === 'string' && env.trim()) return env.trim();
	return 'default';
}

/** profile 名净化成目录名：只留字母数字与 `._-`，其余换 `_`，空则 `default`。 */
function safeProfileDir(profile) {
	return String(profile || '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'default';
}

export function apply(ctx) {
	const live = { calls: {}, tools: {} };
	/** sessionId -> {first, last}：本进程内会话活跃跨度（会话页「活跃时长」，实时口径）。 */
	const liveSpans = new Map();
	const now = () => Date.now();

	/** 本进程内会话活跃跨度（min first / max last 合并，与会话页实时口径配套）。 */
	function touchLiveSpan(sessionId, ts) {
		if (!sessionId || sessionId === '?') return;
		let s = liveSpans.get(sessionId);
		if (!s) { s = { first: ts, last: ts }; liveSpans.set(sessionId, s); return; }
		if (ts < s.first) s.first = ts;
		if (ts > s.last) s.last = ts;
	}

	// ---- 会话身份（标题 / 工作目录）折叠与缓存 --------------------------
	//
	// 账本里只有 sessionId，拼不出"这是哪个会话"——45 个 `session-<uuid>` 排在一
	// 起等于没信息。标题真相不在账本里也不在内存 store 里：`sessions.get` 只认
	// 当前活着的会话，已归档会话一律 undefined（旧实现因此整列显示截断 ID）。
	// 日志才是真相源，由 `sessionQuery.readTitleSnapshots` 折叠（支持已持久化
	// 会话、批量、按会话隔离失败），顺带给出 header 的 cwd / origin / preset。
	// 冷读有成本（实测 10 会话 ≈ 2.8s），故：命中缓存零成本、未命中才批量折叠
	// 一次，且同一时刻只有一个折叠任务在飞（5s 轮询与启动预热不会重读同一批）。

	/** sessionId -> {title,titleSource,cwd,cwdName,createdAt,origin,agentPreset,at}。 */
	const titleCache = new Map();
	/** 单飞的标题折叠任务。 */
	let titleJob = null;

	/** 缓存是否仍然新鲜（有标题走长 TTL，无标题走短重试）。 */
	function titleFresh(id) {
		const c = titleCache.get(id);
		if (!c) return false;
		return (Date.now() - c.at) < (c.title ? TITLE_TTL_MS : TITLE_RETRY_MS);
	}

	/** 折叠一批会话标题写入缓存；单会话失败被隔离，留待下轮重试。 */
	async function runTitleJob(ids) {
		const q = ctx.get('sessionQuery');
		if (!q || typeof q.readTitleSnapshots !== 'function') return;
		const results = await q.readTitleSnapshots(ids);
		const at = Date.now();
		for (const r of (results || [])) {
			const id = r && r.sessionId ? String(r.sessionId) : '';
			if (!id || !r || r.status !== 'fulfilled' || !r.value) continue;
			const h = r.value.session || {};
			const t = r.value.title || null;
			const cwd = typeof h.cwd === 'string' && h.cwd ? h.cwd : null;
			titleCache.set(id, {
				title: (t && typeof t.title === 'string' && t.title.trim()) ? t.title.trim() : null,
				titleSource: (t && t.source && typeof t.source.kind === 'string') ? t.source.kind : null,
				cwd,
				cwdName: cwd ? (cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd) : null,
				createdAt: typeof h.createdAt === 'number' ? h.createdAt : null,
				origin: typeof h.origin === 'string' ? h.origin : null,
				agentPreset: typeof h.agentPreset === 'string' ? h.agentPreset : null,
				at
			});
		}
	}

	/** 补齐给定会话的标题（命中即返回；未命中则等当前折叠任务，最多两轮）。 */
	async function ensureTitles(ids) {
		for (let round = 0; round < 2; round++) {
			const missing = ids.filter((id) => !titleFresh(id));
			if (missing.length === 0) return;
			if (!titleJob) titleJob = runTitleJob(missing).finally(() => { titleJob = null; });
			await titleJob.catch((e) => { ledgerError = String(e && e.message || e); });
		}
	}

	/** Promise.race 的超时腿（只放弃等待，不取消底下的折叠任务）。 */
	function sleep(ms) {
		return new Promise((resolve) => {
			const t = setTimeout(resolve, ms);
			if (t && typeof t.unref === 'function') t.unref();
		});
	}

	/**
	 * 把身份贴到排行行上。缓存未命中时退回内存 store 的标题（零成本），
	 * 再不行保留 null —— 客户端降级显示截断 ID，绝不凭空编造名字。
	 */
	function decorateSessions(rows) {
		let sessionsSvc = null;
		try { sessionsSvc = ctx.get('sessions'); } catch (e) { /* 无服务则仅用缓存 */ }
		for (const r of rows) {
			const c = titleCache.get(r.sessionId);
			r.title = (c && c.title) || null;
			r.titleSource = (c && c.titleSource) || null;
			r.cwd = (c && c.cwd) || null;
			r.cwdName = (c && c.cwdName) || null;
			r.agentPreset = (c && c.agentPreset) || null;
			r.createdAt = (c && c.createdAt) || null;
			r.subagent = !!(c && c.origin === 'subagent');
			if (!r.title) {
				try {
					const s = sessionsSvc && sessionsSvc.get(r.sessionId);
					if (s && typeof s.title === 'string' && s.title.trim()) {
						r.title = s.title.trim();
						r.titleSource = 'live';
					}
				} catch (e) { /* 降级 */ }
			}
		}
	}

	/** 预热：把窗口内全部会话的标题一次折出来，浮窗首开就有名字。 */
	function warmTitles() {
		const cutoff = dateOffset(-29);
		const ids = new Set();
		for (const [date, day] of ledgerDays) {
			if (date < cutoff) continue;
			for (const e of day.values()) {
				if (e.sessionId && e.sessionId !== '?') ids.add(e.sessionId);
			}
		}
		if (ids.size > 0) ensureTitles(Array.from(ids)).catch(() => { /* 预热失败不致命 */ });
	}

	// ---- 跨会话账本与限额配置 ------------------------------------------

	const dataDir = resolveDataDir(ctx);
	/**
	 * **按 profile 分区**（2026-09-26）：账本与限额同住一个 profile 子目录 ——
	 * 官方桌面端只记载官方自己这个实例的消耗，自制壳 / 浏览器 GUI 各记各的。
	 * 分区前是全局单文件，历史归位见 migrateLegacyLedger()。
	 */
	const profileName = resolveProfileName(ctx);
	const profileDir = path.join(dataDir, safeProfileDir(profileName));
	const ledgerFile = path.join(profileDir, 'usage-log.jsonl');
	const configFile = path.join(profileDir, 'config.json');

	/** date -> Map("sessionId|provider|model" -> 分项累计)；仅保留 LEDGER_DAYS 天。 */
	const ledgerDays = new Map();
	/** "date|sessionId|provider|model" -> 自上次 flush 以来的增量（待落盘）。 */
	const pending = new Map();
	/** date -> Map(sessionId -> {first, last})：会话活跃跨度（最长聊天时长）。 */
	const spans = new Map();
	/** "date|sessionId" -> 已落盘快照的 last（控制写盘频率）。 */
	const spanWritten = new Map();
	/** 自上次 flush 以来有跨度更新的 "date|sessionId"。 */
	const spanDirty = new Set();
	/** 账本内存窗口内最早有数据的日期。 */
	let ledgerSince = null;
	let ledgerError = null;
	let config = { version: 1, dailyTokenLimit: null };

	/**
	 * 双写：ledgerDays（聚合权威）+ pending（落盘增量）。dCalls 为调用次数增量。
	 * `toPending=false` 时不进落盘队列——启动载入磁盘存量必须走此路径，
	 * 否则存量会被当成新增量在 5s 后 flush 回写，每次重启账本翻倍。
	 */
	function addToLedger(date, sessionId, provider, model, dIn, dOut, dCache, dReason, dCalls, toPending) {
		try {
			const key = sessionId + '|' + provider + '|' + model;
			let day = ledgerDays.get(date);
			if (!day) { day = new Map(); ledgerDays.set(date, day); }
			let e = day.get(key);
			if (!e) {
				e = { sessionId, provider, model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, calls: 0 };
				day.set(key, e);
			}
			e.inputTokens += dIn; e.outputTokens += dOut;
			e.cacheReadTokens += dCache; e.reasoningTokens += dReason;
			e.calls += dCalls || 0;
			if (toPending === false) return;
			const pk = date + '|' + key;
			let p = pending.get(pk);
			if (!p) {
				p = { date, sessionId, provider, model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, calls: 0 };
				pending.set(pk, p);
			}
			p.inputTokens += dIn; p.outputTokens += dOut;
			p.cacheReadTokens += dCache; p.reasoningTokens += dReason;
			p.calls += dCalls || 0;
		} catch (e) { ledgerError = String(e && e.message || e); }
	}

	/**
	 * 记录会话活跃跨度（min first / max last 合并，快照幂等）。
	 *
	 * `dirty=false` 专供**启动载入**：磁盘上的存量快照已经在文件里了，绝不能再标脏。
	 * 否则 `process.on('exit')` 的强制 flush 会把这些键当成本次推进重新写一遍 ——
	 * 每次 host 正常退出都追加一批重复 span 行（v0.5.1 修复；实测本机账本因此积了
	 * 920 行冗余、单键最多重复 82 次，占全账本 20%）。
	 */
	function touchSpan(date, sessionId, ts, dirty) {
		if (!sessionId || sessionId === '?') return;
		try {
			let day = spans.get(date);
			if (!day) { day = new Map(); spans.set(date, day); }
			let s = day.get(sessionId);
			if (!s) {
				s = { first: ts, last: ts };
				day.set(sessionId, s);
			} else {
				if (ts < s.first) s.first = ts;
				if (ts > s.last) s.last = ts;
			}
			if (dirty !== false) spanDirty.add(date + '|' + sessionId);
		} catch (e) { /* 隔离 */ }
	}

	/** 追加写 pending 增量与 span 快照；写成功才清空（失败保留下次重试）。 */
	function flushLedger(force) {
		const lines = [];
		const spanMarks = [];
		if (pending.size > 0) {
			for (const p of pending.values()) {
				lines.push(JSON.stringify({
					date: p.date, ts: now(), sessionId: p.sessionId,
					provider: p.provider, model: p.model,
					inputTokens: p.inputTokens, outputTokens: p.outputTokens,
					cacheReadTokens: p.cacheReadTokens, reasoningTokens: p.reasoningTokens,
					calls: p.calls
				}));
			}
		}
		for (const key of spanDirty) {
			const i = key.indexOf('|');
			const date = key.slice(0, i);
			const sessionId = key.slice(i + 1);
			const day = spans.get(date);
			const s = day && day.get(sessionId);
			if (!s) { spanMarks.push([key, null]); continue; }
			const written = spanWritten.get(key);
			// 快照按 last 推进 ≥1 分钟才落盘；进程退出（force）不限。
			if (force || written === undefined || s.last - written >= SPAN_FLUSH_MS) {
				lines.push(JSON.stringify({ type: 'span', date, ts: now(), sessionId, first: s.first, last: s.last }));
				spanMarks.push([key, s.last]);
			}
		}
		if (lines.length === 0) return;
		try {
			fs.appendFileSync(ledgerFile, lines.join('\n') + '\n', 'utf8');
			pending.clear();
			for (const [key, last] of spanMarks) {
				spanDirty.delete(key);
				if (last !== null) spanWritten.set(key, last);
			}
			ledgerError = null;
		} catch (e) { ledgerError = String(e && e.message || e); }
	}

	/** 剪除超窗日期（flush 时调用，成本低）。 */
	function pruneOld() {
		const cutoff = dateOffset(-(LEDGER_DAYS - 1));
		for (const d of ledgerDays.keys()) if (d < cutoff) ledgerDays.delete(d);
		for (const d of spans.keys()) if (d < cutoff) spans.delete(d);
		for (const k of spanWritten.keys()) if (k.slice(0, k.indexOf('|')) < cutoff) spanWritten.delete(k);
	}

	/** 启动时载入最近 LEDGER_DAYS 天；文件超 TAIL_BYTES 只解析尾部（丢弃不完整首行）。 */
	function loadLedger() {
		let buf;
		try {
			const st = fs.statSync(ledgerFile);
			if (st.size === 0) return;
			if (st.size > TAIL_BYTES) {
				const fd = fs.openSync(ledgerFile, 'r');
				try {
					buf = Buffer.alloc(TAIL_BYTES);
					fs.readSync(fd, buf, 0, TAIL_BYTES, st.size - TAIL_BYTES);
					const nl = buf.indexOf(10);
					buf = buf.slice(nl >= 0 ? nl + 1 : 0);
				} finally { fs.closeSync(fd); }
			} else {
				buf = fs.readFileSync(ledgerFile);
			}
		} catch (e) { return; }
		const cutoff = dateOffset(-(LEDGER_DAYS - 1));
		for (const line of buf.toString('utf8').split('\n')) {
			const s = line.trim();
			if (!s) continue;
			let j;
			try { j = JSON.parse(s); } catch (e) { continue; }
			if (!j || typeof j.date !== 'string' || j.date < cutoff) continue;
			if (j.type === 'span') {
				if (typeof j.sessionId === 'string' && typeof j.first === 'number' && typeof j.last === 'number') {
					// 载入存量快照：只进内存聚合（dirty=false），不标脏 —— 否则退出时的
					// 强制 flush 会把它们当成本次推进重复回写（v0.5.1 修复）。
					touchSpan(j.date, j.sessionId, j.first, false);
					touchSpan(j.date, j.sessionId, j.last, false);
					spanWritten.set(j.date + '|' + j.sessionId, j.last);
					if (!ledgerSince || j.date < ledgerSince) ledgerSince = j.date;
				}
				continue;
			}
			const n = (v) => (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0;
			// 载入存量只进内存聚合（toPending=false），绝不回写磁盘。
			addToLedger(j.date,
				typeof j.sessionId === 'string' ? j.sessionId : '?',
				typeof j.provider === 'string' ? j.provider : '?',
				typeof j.model === 'string' ? j.model : '?',
				n(j.inputTokens), n(j.outputTokens), n(j.cacheReadTokens), n(j.reasoningTokens), n(j.calls), false);
			if (!ledgerSince || j.date < ledgerSince) ledgerSince = j.date;
		}
	}

	function loadConfig() {
		try {
			const j = JSON.parse(fs.readFileSync(configFile, 'utf8'));
			if (j && typeof j === 'object') {
				const v = j.dailyTokenLimit;
				config = {
					version: 1,
					dailyTokenLimit: (typeof v === 'number' && isFinite(v) && v > 0 && v <= 1e12) ? Math.round(v) : null
				};
			}
		} catch (e) { /* 无配置或损坏 → 默认 */ }
	}

	function saveConfig() {
		fs.mkdirSync(dataDir, { recursive: true });
		fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
	}

	function aggregateDay(date) {
		const out = {
			date, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
			reasoningTokens: 0, total: 0, calls: 0, byModel: []
		};
		const day = ledgerDays.get(date);
		if (!day) return out;
		const byModel = new Map();
		for (const e of day.values()) {
			out.inputTokens += e.inputTokens; out.outputTokens += e.outputTokens;
			out.cacheReadTokens += e.cacheReadTokens; out.reasoningTokens += e.reasoningTokens;
			out.calls += e.calls || 0;
			const mk = e.provider + '|' + e.model;
			let m = byModel.get(mk);
			if (!m) {
				m = { provider: e.provider, model: e.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, total: 0 };
				byModel.set(mk, m);
			}
			m.inputTokens += e.inputTokens; m.outputTokens += e.outputTokens;
			m.cacheReadTokens += e.cacheReadTokens; m.reasoningTokens += e.reasoningTokens;
			m.total = m.inputTokens + m.outputTokens + m.cacheReadTokens + m.reasoningTokens;
		}
		out.total = out.inputTokens + out.outputTokens + out.cacheReadTokens + out.reasoningTokens;
		out.byModel = Array.from(byModel.values()).sort((a, b) => b.total - a.total);
		return out;
	}

	/** 近 days 天每日聚合（含今日），空日补 0；每日带按模型明细（趋势图 / 环形图共用）。 */
	function ledgerTrend(days) {
		const out = [];
		for (let i = days - 1; i >= 0; i--) {
			const d = dateOffset(-i);
			const a = aggregateDay(d);
			out.push({
				date: d,
				inputTokens: a.inputTokens, outputTokens: a.outputTokens,
				cacheReadTokens: a.cacheReadTokens, reasoningTokens: a.reasoningTokens,
				total: a.total, calls: a.calls,
				models: a.byModel.map((m) => ({ provider: m.provider, model: m.model, total: m.total }))
			});
		}
		return out;
	}

	/** 总览统计：累计 / 单日峰值 / 最长聊天时长 / 连续天数（全部来自账本）。 */
	function computeStats() {
		let totalTokens = 0;
		let peak = 0, peakDate = null;
		const active = [];
		for (const [date, day] of ledgerDays) {
			let t = 0;
			for (const e of day.values()) t += e.inputTokens + e.outputTokens + e.cacheReadTokens + e.reasoningTokens;
			if (t > 0) {
				totalTokens += t;
				active.push(date);
				if (t > peak) { peak = t; peakDate = date; }
			}
		}
		let longestMs = 0;
		for (const day of spans.values()) {
			for (const s of day.values()) {
				const d = s.last - s.first;
				if (d > longestMs) longestMs = d;
			}
		}
		const activeSet = new Set(active);
		const cursor = new Date();
		cursor.setHours(0, 0, 0, 0);
		if (!activeSet.has(localDate(cursor))) cursor.setDate(cursor.getDate() - 1);
		let currentStreak = 0;
		while (activeSet.has(localDate(cursor))) {
			currentStreak++;
			cursor.setDate(cursor.getDate() - 1);
		}
		let longestStreak = 0, run = 0, prev = null;
		for (const d of active.sort()) {
			run = (prev !== null && diffDays(prev, d) === 1) ? run + 1 : 1;
			if (run > longestStreak) longestStreak = run;
			prev = d;
		}
		return {
			totalTokens,
			peakDayTokens: peak,
			peakDayDate: peakDate,
			longestSessionMs: longestMs,
			currentStreakDays: currentStreak,
			longestStreakDays: longestStreak,
			activeDays: active.length,
			since: ledgerSince || localDate()
		};
	}

	/** 稀疏每日账单（热力图数据源）：仅含有活动的日子，零日由客户端按日历补齐。 */
	function heatmapDays() {
		const out = [];
		for (const [date, day] of ledgerDays) {
			let total = 0, calls = 0;
			for (const e of day.values()) {
				total += e.inputTokens + e.outputTokens + e.cacheReadTokens + e.reasoningTokens;
				calls += e.calls || 0;
			}
			if (total > 0 || calls > 0) out.push({ date, total, calls });
		}
		out.sort((a, b) => (a.date < b.date ? -1 : 1));
		return out;
	}

	// 透传包装：绝不打断上游流；观察失败被完全隔离。
	function wrapStream(stream, onChunk) {
		return {
			[Symbol.asyncIterator]() {
				const inner = (stream && stream[Symbol.asyncIterator]) ? stream[Symbol.asyncIterator]() : stream;
				return {
					next(arg) {
						const p = inner.next(arg);
						return Promise.resolve(p).then((r) => {
							if (r && !r.done) {
								try { onChunk(r.value); } catch (e) { /* 观察隔离 */ }
							}
							return r;
						});
					},
					return(v) {
						const p = inner.return ? inner.return(v) : Promise.resolve({ done: true, value: v });
						return Promise.resolve(p);
					},
					throw(e) {
						const p = inner.throw ? inner.throw(e) : Promise.reject(e);
						return Promise.resolve(p);
					}
				};
			}
		};
	}

	ctx.on('llm/stream', (options, next) => {
		const stream = next();
		return wrapStream(stream, (chunk) => {
			const u = chunk && chunk.usage;
			if (!u || typeof u !== 'object') return;
			const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '?';
			const provider = typeof options.provider === 'string' ? options.provider : '?';
			const model = typeof options.model === 'string' ? options.model : '?';
			const key = sessionId + '|' + provider + '|' + model;
			let entry = live.calls[key];
			if (!entry) {
				entry = live.calls[key] = {
					provider, model,
					calls: 0, inputTokens: 0, outputTokens: 0,
					cacheReadTokens: 0, reasoningTokens: 0,
					total: 0, lastAt: now()
				};
			}
			const dIn = typeof u.inputTokens === 'number' ? u.inputTokens : 0;
			const dOut = typeof u.outputTokens === 'number' ? u.outputTokens : 0;
			const dCache = typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0;
			const dReason = typeof u.reasoningTokens === 'number' ? u.reasoningTokens : 0;
			entry.calls++;
			entry.inputTokens += dIn;
			entry.outputTokens += dOut;
			entry.cacheReadTokens += dCache;
			entry.reasoningTokens += dReason;
			entry.total = entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.reasoningTokens;
			entry.lastAt = now();
			// 账本与实时明细同口径（同为 chunk.usage 增量累计）；每次实报记 1 次调用（≈ 轮消息）。
			const date = localDate();
			addToLedger(date, sessionId, provider, model, dIn, dOut, dCache, dReason, 1);
			touchSpan(date, sessionId, now());
			touchLiveSpan(sessionId, now());
		});
	});

	ctx.on('tools/result', (exec) => {
		try {
			const agent = exec && exec.agent;
			const name = exec && (exec.name || exec.tool);
			if (!name) return;
			const sessionId = agent && typeof agent.id === 'string' ? agent.id : '?';
			const key = sessionId + '|' + String(name);
			let entry = live.tools[key];
			if (!entry) entry = live.tools[key] = { name: String(name), count: 0, lastAt: now() };
			entry.count++;
			entry.lastAt = now();
			// 工具活动同样视为会话活跃（参与聊天时长跨度）。
			touchSpan(localDate(), sessionId, now());
			touchLiveSpan(sessionId, now());
		} catch (e) { /* 隔离 */ }
	});

	async function officialSummary(sessionId) {
		const out = {
			tokenUsage: null, sessionStats: null,
			contextPressure: null, contextBreakdown: null,
			meter: null, error: null
		};
		if (!sessionId) { out.error = 'no sessionId'; return out; }
		const sessions = ctx.get('sessions');
		if (!sessions) { out.error = 'no sessions service'; return out; }
		const session = sessions.get(sessionId);
		if (!session) { out.error = 'session not found'; return out; }
		const projections = ctx.get('sessionProjections');
		if (projections) {
			try {
				const snap = projections.snapshot(session);
				const values = (snap && snap.values) || {};
				const pick = (k, fields) => {
					const v = values[k];
					if (!v || typeof v !== 'object') return null;
					const r = {};
					for (const f of fields) if (typeof v[f] === 'number') r[f] = v[f];
					return r;
				};
				out.tokenUsage = pick('tokenUsage', ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']);
				out.sessionStats = pick('sessionStats', ['turns', 'steps', 'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens']);
				out.contextPressure = pick('contextPressure', ['pressureTokens', 'projectedTokens', 'contextWindow']);
				out.contextBreakdown = pick('contextBreakdown', ['systemTokens', 'toolsTokens', 'messageTokens']);
			} catch (e) { out.error = String(e && e.message || e); }
		}
		const meter = ctx.get('tokenMeter');
		if (meter) {
			try {
				const m = meter.measure(session);
				if (m && typeof m === 'object') {
					out.meter = {};
					for (const k of ['totalTokens', 'surfaceTokens', 'surfaceDeltaTokens', 'logRevision']) {
						if (typeof m[k] === 'number') out.meter[k] = m[k];
					}
				}
			} catch (e) { if (!out.error) out.error = String(e && e.message || e); }
		}
		return out;
	}

	/**
	 * 会话路由载荷：官方聚合 + 实时明细。live.calls / live.tools 按 sessionId
	 * 过滤后再下发（修复 v0.3.3 全量返回、混入同进程其他会话数据的边界缺陷），
	 * 并附本进程内会话活跃跨度（会话页「活跃时长」实时口径）。
	 */
	async function buildSessionPayload(sessionId) {
		const calls = [];
		const tools = [];
		const prefix = (sessionId || '') + '|';
		for (const k of Object.keys(live.calls)) {
			if (sessionId && !k.startsWith(prefix)) continue;
			const c = live.calls[k];
			if (c.provider === '?') continue;
			calls.push({
				provider: c.provider, model: c.model, calls: c.calls,
				inputTokens: c.inputTokens, outputTokens: c.outputTokens,
				cacheReadTokens: c.cacheReadTokens, reasoningTokens: c.reasoningTokens,
				total: c.total, lastAt: c.lastAt
			});
		}
		calls.sort((a, b) => b.total - a.total);
		for (const k of Object.keys(live.tools)) {
			if (sessionId && !k.startsWith(prefix)) continue;
			const t = live.tools[k];
			tools.push({ name: t.name, count: t.count, lastAt: t.lastAt });
		}
		tools.sort((a, b) => b.count - a.count);
		const span = (sessionId && liveSpans.get(sessionId)) || null;
		return {
			ok: true,
			sessionId: sessionId || null,
			official: await officialSummary(sessionId),
			live: {
				calls, tools,
				activeSpan: span ? { first: span.first, last: span.last } : null,
				sampledAt: now()
			},
			note: '官方聚合（tokenUsage / contextPressure / sessionStats）由会话日志投影、覆盖本会话全程（含插件启用前历史、跨重启），与「轨迹」页同源；按模型明细、工具计数与会话活跃时长由本插件实时采集、仅统计本进程启动之后的本会话。本页不含任何跨会话累计，全局总量统计请见左侧边栏「用量统计」。'
		};
	}

	/**
	 * 近 days 天按会话聚合（全局页「会话活跃分布」，v0.5.0 由 Top N 排行升级）：
	 * - 每会话：tokens 总量 + 轮消息 + 账本活跃跨度（跨天合并 min first / max last）
	 *   + 逐日用量 `daily[i]`（对齐 dates[i]，空日 0；客户端按各会话自身峰值分档
	 *   着色，表达"哪些天在活跃"而不是"和最大会话比有多小"）；
	 * - 集合级：`totalAll` / `callsAll` = 窗口内全部会话合计（**含未进 rows 的长尾**，
	 *   作排行占比分母；若用 rows 之和做分母，长尾会话会让占比整体虚高）、
	 *   `matched` = 窗口内有量的会话总数。
	 *
	 * limit 只作下发上限（客户端在其上做排序 / 搜索 / 条数切换）。
	 * 标题与工作目录等身份字段由 decorateSessions 从 titleCache 贴上，本函数
	 * 只负责账本侧聚合，不碰磁盘。
	 */
	function sessionRanking(days, limit) {
		const cutoff = dateOffset(-(days - 1));
		const dates = [];
		const dateIdx = new Map();
		for (let i = days - 1; i >= 0; i--) {
			const d = dateOffset(-i);
			dateIdx.set(d, dates.length);
			dates.push(d);
		}
		const bySession = new Map();
		for (const [date, day] of ledgerDays) {
			if (date < cutoff) continue;
			const di = dateIdx.get(date);
			for (const e of day.values()) {
				const sid = e.sessionId || '?';
				let s = bySession.get(sid);
				if (!s) {
					s = {
						sessionId: sid, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
						reasoningTokens: 0, total: 0, calls: 0, first: null, last: null,
						daily: new Array(days).fill(0)
					};
					bySession.set(sid, s);
				}
				s.inputTokens += e.inputTokens; s.outputTokens += e.outputTokens;
				s.cacheReadTokens += e.cacheReadTokens; s.reasoningTokens += e.reasoningTokens;
				s.total = s.inputTokens + s.outputTokens + s.cacheReadTokens + s.reasoningTokens;
				s.calls += e.calls || 0;
				if (di !== undefined) {
					s.daily[di] += e.inputTokens + e.outputTokens + e.cacheReadTokens + e.reasoningTokens;
				}
			}
		}
		for (const [date, day] of spans) {
			if (date < cutoff) continue;
			for (const [sid, s] of day) {
				const t = bySession.get(sid);
				if (!t) continue;
				if (t.first === null || s.first < t.first) t.first = s.first;
				if (t.last === null || s.last > t.last) t.last = s.last;
			}
		}
		const rows = Array.from(bySession.values());
		for (const r of rows) { if (r.first === null) { r.first = 0; r.last = 0; } }
		let totalAll = 0, callsAll = 0;
		for (const r of rows) { totalAll += r.total; callsAll += r.calls; }
		rows.sort((a, b) => b.total - a.total || b.calls - a.calls);
		const out = rows.slice(0, limit);
		return { windowDays: days, dates, rows: out, all: rows, totalAll, callsAll, matched: rows.length };
	}

	/**
	 * 按工作目录聚合（「会话活跃分布」的第二维度，对齐参考图的"按工作空间"）。
	 *
	 * 为什么必须有这个维度：近 30 日窗口里**单会话的时间跨度天生很短**——实测真实
	 * 账本 45 个会话、1350 个「会话×日」格只有 50 格非零（4%），Top 会话也只活跃
	 * 1–2 天。逐日分布若只看单会话，条带几乎全空、比原来的比例条更没信息。按目录
	 * 把同一项目的多个会话叠加，才看得出"这个项目哪几天在烧 token"，形态与参考图
	 * 的密集条带一致。
	 *
	 * 入参是**全量**会话行（不是 Top N 截断后的），否则聚合结果会随截断口径漂移。
	 * 依赖 decorateSessions 先贴上 cwd；未折叠出目录的会话不参与（计入 unresolved，
	 * 由客户端如实提示，不塞进"未知目录"这种假分组）。
	 */
	function cwdRanking(all, days) {
		const byCwd = new Map();
		let unresolved = 0;
		for (const r of all) {
			const key = r.cwd;
			if (!key) { unresolved++; continue; }
			let g = byCwd.get(key);
			if (!g) {
				g = {
					kind: 'cwd', key, sessionId: 'cwd:' + key, title: r.cwdName || key,
					cwd: key, cwdName: r.cwdName || key, subagent: false,
					total: 0, calls: 0, sessions: 0, first: null, last: null,
					daily: new Array(days).fill(0)
				};
				byCwd.set(key, g);
			}
			g.sessions++;
			g.total += r.total || 0;
			g.calls += r.calls || 0;
			if (r.first && (g.first === null || r.first < g.first)) g.first = r.first;
			if (r.last && (g.last === null || r.last > g.last)) g.last = r.last;
			for (let i = 0; i < days; i++) g.daily[i] += r.daily[i] || 0;
		}
		const out = Array.from(byCwd.values())
			.sort((a, b) => b.total - a.total || b.calls - a.calls)
			.slice(0, CWD_TOPN);
		let total = 0, calls = 0;
		for (const g of byCwd.values()) { total += g.total; calls += g.calls; }
		return { rows: out, unresolved, matched: byCwd.size, totalAll: total, callsAll: calls };
	}

	/** 全局路由载荷：跨会话账本统计（总览 / 今日 / 趋势 / 会话活跃分布）+ 限额。 */
	async function buildGlobalPayload() {
		const rank = sessionRanking(30, SESSION_TOPN);
		// 折叠与身份都按**全量**会话走：目录维度要在全量上聚合，只看 Top N 会让
		// 结果随截断口径漂移。
		const ids = rank.all.map((r) => r.sessionId);
		if (ids.length > 0 && ids.some((id) => !titleFresh(id))) {
			// 冷读（或 TTL 到期）时等一小段：首屏尽量带名字；超时则本次先用
			// 截断 ID 兜底，折叠任务继续在后台跑完，下一轮 5s 轮询即有标题。
			await Promise.race([
				ensureTitles(ids).catch((e) => { ledgerError = String(e && e.message || e); }),
				sleep(TITLE_WAIT_MS)
			]);
		} else if (ids.length > 0) {
			ensureTitles(ids).catch((e) => { ledgerError = String(e && e.message || e); });
		}
		decorateSessions(rank.all);
		const byCwd = cwdRanking(rank.all, rank.windowDays);
		return {
			ok: true,
			stats: computeStats(),
			today: aggregateDay(localDate()),
			trend: ledgerTrend(30),
			sessions: {
				windowDays: rank.windowDays, limit: SESSION_TOPN, dates: rank.dates,
				rows: rank.rows, totalAll: rank.totalAll, callsAll: rank.callsAll, matched: rank.matched,
				byCwd: {
					limit: CWD_TOPN, rows: byCwd.rows, unresolved: byCwd.unresolved,
					matched: byCwd.matched, totalAll: byCwd.totalAll, callsAll: byCwd.callsAll
				}
			},
			since: ledgerSince || localDate(),
			config: { dailyTokenLimit: config.dailyTokenLimit },
			error: ledgerError,
			profile: profileName,
			sampledAt: now(),
			note: '全局统计来自跨会话账本（usage-log.jsonl，保留 380 天），自插件首次部署起累计、跨 host 重启持久，部署前的历史会话不在其中；账本按 profile 分区 —— 本页只统计当前 profile（' + profileName + '）的消耗，官方桌面端与自制壳 / 浏览器 GUI 各记各的账、互不混入；会话活跃分布基于账本 sessionId 按近 30 日聚合、逐日格点按所选行自身峰值分档（按会话看时间跨度天生短，按工作目录看才是同一项目的叠加形态），标题与工作目录由 sessionQuery 折叠会话日志得出（已归档会话同样可得，冷读约 0.3s/会话，命中缓存后零成本；取不到时降级显示截断 ID，不参与目录聚合）；占比分母为窗口内全部会话合计（含未列出的长尾会话）。日限额为本地自定义配置（DSH 无配额接口），同样按 profile 分区。'
		};
	}

	function sendJSON(res, code, obj) {
		res.statusCode = code;
		res.setHeader('Content-Type', 'application/json; charset=utf-8');
		res.setHeader('Cache-Control', 'no-store');
		res.end(JSON.stringify(obj));
	}

	function sessionHandler(req, res) {
		let sessionId;
		try {
			const url = new URL(req.url || '/', 'http://localhost');
			sessionId = url.searchParams.get('sessionId') || undefined;
		} catch (e) {
			sendJSON(res, 400, { ok: false, error: 'bad url' });
			return;
		}
		buildSessionPayload(sessionId)
			.then((data) => sendJSON(res, 200, data))
			.catch((e) => sendJSON(res, 500, { ok: false, error: String(e && e.message || e) }));
	}

	function globalHandler(req, res) {
		buildGlobalPayload()
			.then((data) => sendJSON(res, 200, data))
			.catch((e) => sendJSON(res, 500, { ok: false, error: String(e && e.message || e) }));
	}

	function heatmapHandler(req, res) {
		try {
			sendJSON(res, 200, { ok: true, days: heatmapDays(), since: ledgerSince || localDate() });
		} catch (e) {
			sendJSON(res, 500, { ok: false, error: String(e && e.message || e) });
		}
	}

	function readBody(req) {
		return new Promise((resolve, reject) => {
			let raw = '';
			req.on('data', (c) => {
				raw += c;
				if (raw.length > 8192) { reject(new Error('请求体过大')); req.destroy(); }
			});
			req.on('end', () => resolve(raw));
			req.on('error', reject);
		});
	}

	async function configHandler(req, res) {
		const send = (code, obj) => sendJSON(res, code, obj);
		try {
			if (req.method === 'GET') {
				send(200, { ok: true, config });
				return;
			}
			if (req.method === 'POST') {
				const j = JSON.parse(await readBody(req) || '{}');
				let v = j.dailyTokenLimit;
				if (v === null || v === undefined || v === '') v = null;
				else if (typeof v !== 'number' || !isFinite(v) || v <= 0 || v > 1e12) {
					send(400, { ok: false, error: 'dailyTokenLimit 需为正数（≤1e12）或 null' });
					return;
				} else {
					v = Math.round(v);
				}
				config = { version: 1, dailyTokenLimit: v };
				saveConfig();
				flushLedger();
				send(200, { ok: true, config });
				return;
			}
			send(405, { ok: false, error: 'method not allowed' });
		} catch (e) {
			send(400, { ok: false, error: String(e && e.message || e) });
		}
	}

	/** 清空跨会话账本（内存聚合 + 落盘文件 + 跨度），限额配置保留。 */
	function resetHandler(req, res) {
		if (req.method !== 'POST') {
			sendJSON(res, 405, { ok: false, error: 'method not allowed' });
			return;
		}
		try {
			ledgerDays.clear();
			pending.clear();
			spans.clear();
			spanWritten.clear();
			spanDirty.clear();
			ledgerSince = null;
			ledgerError = null;
			try { fs.rmSync(ledgerFile, { force: true }); } catch (e) { /* 删除失败时内存已清，下次 flush 只写新增量 */ }
			sendJSON(res, 200, { ok: true, stats: computeStats(), note: '账本已清空，从现在起重新累计' });
		} catch (e) {
			sendJSON(res, 500, { ok: false, error: String(e && e.message || e) });
		}
	}

	ctx.webServer.register({
		kind: 'exact',
		path: '/dsh-token-monitor/session',
		handler: sessionHandler
	});
	ctx.webServer.register({
		kind: 'exact',
		path: '/dsh-token-monitor/global',
		handler: globalHandler
	});
	ctx.webServer.register({
		kind: 'exact',
		path: '/dsh-token-monitor/heatmap',
		handler: heatmapHandler
	});
	ctx.webServer.register({
		kind: 'exact',
		path: '/dsh-token-monitor/config',
		handler: configHandler
	});
	ctx.webServer.register({
		kind: 'exact',
		path: '/dsh-token-monitor/reset',
		handler: resetHandler
	});

	/**
	 * 一次性历史归位（2026-09-26 分区改造的配套）：分区之前账本是**全局单文件**
	 * `<dataDir>/usage-log.jsonl`，desktop / web / miasaki 三个 profile 混写在一起、
	 * 无法事后拆分归属。分区后它只归**自制环境**（`miasaki` 分区）——官方桌面端必须
	 * 从零开始，否则历史里混着的自制壳消耗会永久污染「官方消耗」口径。
	 * 只在 miasaki 分区首次启动、且该分区还没有账本时搬一次；跨卷 / 被占用导致搬不动
	 * 就留在原地并记 error，不影响新账本从零起算。
	 * 想把这段历史改判给别的 profile：停掉所有 host，把 `miasaki/` 目录改名即可。
	 */
	function migrateLegacyLedger() {
		try {
			if (safeProfileDir(profileName) !== 'miasaki') return;
			if (fs.existsSync(ledgerFile)) return;
			const legacyLedger = path.join(dataDir, 'usage-log.jsonl');
			if (!fs.existsSync(legacyLedger)) return;
			fs.mkdirSync(profileDir, { recursive: true });
			fs.renameSync(legacyLedger, ledgerFile);
			const legacyConfig = path.join(dataDir, 'config.json');
			if (fs.existsSync(legacyConfig) && !fs.existsSync(configFile)) fs.renameSync(legacyConfig, configFile);
			for (const f of fs.readdirSync(dataDir)) {
				if (!f.startsWith('usage-log.jsonl.bak-')) continue;
				try { fs.renameSync(path.join(dataDir, f), path.join(profileDir, f)); } catch (e) { /* 备份搬不动无妨 */ }
			}
		} catch (e) { ledgerError = '历史账本归位失败：' + String(e && e.message || e); }
	}

	// 账本初始化：建目录 →（首次）历史归位 → 载入近 LEDGER_DAYS 天 → 载入限额配置 → 5s 节流落盘。
	try { fs.mkdirSync(profileDir, { recursive: true }); } catch (e) { ledgerError = String(e && e.message || e); }
	migrateLegacyLedger();
	loadLedger();
	loadConfig();
	pruneOld();
	// 账本载入后预热会话标题：账本只有 sessionId，标题须折日志（冷读有成本），
	// 提前跑掉，浮窗第一次打开就带名字；延迟一拍让宿主 boot 先稳定。
	const warmTimer = setTimeout(() => { try { warmTitles(); } catch (e) { /* 预热失败不致命 */ } }, TITLE_WARM_DELAY_MS);
	if (warmTimer && typeof warmTimer.unref === 'function') warmTimer.unref();
	const flushTimer = setInterval(() => { flushLedger(); pruneOld(); }, 5000);
	if (typeof flushTimer.unref === 'function') flushTimer.unref();
	// 信号默认终止也会经过 'exit'，此处只做同步 flush（span 快照强制落盘），不干预宿主退出逻辑。
	process.on('exit', () => flushLedger(true));
}
