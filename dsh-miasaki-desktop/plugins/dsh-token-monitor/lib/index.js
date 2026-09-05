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
 *
 * 对外暴露（webServer 精确路由，`{ok, error}` 包装对齐 dsh-free-model-pool）：
 * - GET  /dsh-token-monitor/summary?sessionId=…  官方 + 实时 + 账本（今日 /
 *        近 30 天趋势含按模型明细 / 总览统计 stats）+ 限额
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

export function apply(ctx) {
	const live = { calls: {}, tools: {} };
	const now = () => Date.now();

	// ---- 跨会话账本与限额配置 ------------------------------------------

	const dataDir = resolveDataDir(ctx);
	const ledgerFile = path.join(dataDir, 'usage-log.jsonl');
	const configFile = path.join(dataDir, 'config.json');

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

	/** 记录会话活跃跨度（min first / max last 合并，快照幂等）。 */
	function touchSpan(date, sessionId, ts) {
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
			spanDirty.add(date + '|' + sessionId);
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
					touchSpan(j.date, j.sessionId, j.first);
					touchSpan(j.date, j.sessionId, j.last);
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

	async function buildSummary(sessionId) {
		const calls = [];
		const tools = [];
		for (const k of Object.keys(live.calls)) {
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
			const t = live.tools[k];
			tools.push({ name: t.name, count: t.count, lastAt: t.lastAt });
		}
		tools.sort((a, b) => b.count - a.count);
		return {
			sessionId: sessionId || null,
			official: await officialSummary(sessionId),
			live: { calls, tools, sampledAt: now() },
			stats: computeStats(),
			ledger: {
				today: aggregateDay(localDate()),
				trend: ledgerTrend(30),
				since: ledgerSince || localDate(),
				error: ledgerError
			},
			config: { dailyTokenLimit: config.dailyTokenLimit },
			note: '模型明细与工具统计自插件（进程）启动起实时采集；官方聚合与估算覆盖整个会话日志；总览统计、热力图、近 30 天趋势与模型用量占比来自跨会话账本（usage-log.jsonl，保留 380 天），自插件首次部署起累计、跨 host 重启持久；限额为本地自定义配置（DSH 无配额接口）。'
		};
	}

	function sendJSON(res, code, obj) {
		res.statusCode = code;
		res.setHeader('Content-Type', 'application/json; charset=utf-8');
		res.setHeader('Cache-Control', 'no-store');
		res.end(JSON.stringify(obj));
	}

	function handler(req, res) {
		let sessionId;
		try {
			const url = new URL(req.url || '/', 'http://localhost');
			sessionId = url.searchParams.get('sessionId') || undefined;
		} catch (e) {
			sendJSON(res, 400, { error: 'bad url' });
			return;
		}
		buildSummary(sessionId).then((data) => sendJSON(res, 200, data)).catch((e) => {
			sendJSON(res, 500, { error: String(e && e.message || e) });
		});
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
		path: '/dsh-token-monitor/summary',
		handler
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

	// 账本初始化：建目录 → 载入近 LEDGER_DAYS 天 → 载入限额配置 → 5s 节流落盘。
	try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { ledgerError = String(e && e.message || e); }
	loadLedger();
	loadConfig();
	pruneOld();
	const flushTimer = setInterval(() => { flushLedger(); pruneOld(); }, 5000);
	if (typeof flushTimer.unref === 'function') flushTimer.unref();
	// 信号默认终止也会经过 'exit'，此处只做同步 flush（span 快照强制落盘），不干预宿主退出逻辑。
	process.on('exit', () => flushLedger(true));
}
