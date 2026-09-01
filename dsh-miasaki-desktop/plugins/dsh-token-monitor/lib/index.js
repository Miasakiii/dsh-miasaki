/**
 * dsh-token-monitor — host half。
 *
 * 数据双通道：
 * - 官方持久聚合：sessionProjections（tokenUsage / contextPressure /
 *   contextBreakdown / sessionStats）+ tokenMeter.measure —— 覆盖整个
 *   会话日志，跨进程重启可用。
 * - 实时明细：llm/stream 按 (sessionId, provider, model) 累计 provider
 *   实报 usage（inputTokens / outputTokens / cacheReadTokens /
 *   reasoningTokens），tools/result 按 (sessionId, 工具名) 计数 ——
 *   自本进程启动起。
 *
 * 对外暴露 GET /dsh-token-monitor/summary?sessionId=…（webServer 精确
 * 路由），返回 lossless JSON 摘要，供 client「用量」Tab 拉取。
 *
 * @module dsh-token-monitor
 */

export const name = 'dsh-token-monitor';
export const inject = ['webServer'];

export function apply(ctx) {
	const live = { calls: {}, tools: {} };
	const now = () => Date.now();

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
			entry.calls++;
			entry.inputTokens += typeof u.inputTokens === 'number' ? u.inputTokens : 0;
			entry.outputTokens += typeof u.outputTokens === 'number' ? u.outputTokens : 0;
			entry.cacheReadTokens += typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0;
			entry.reasoningTokens += typeof u.reasoningTokens === 'number' ? u.reasoningTokens : 0;
			entry.total = entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.reasoningTokens;
			entry.lastAt = now();
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
			note: '模型明细与工具统计自插件（进程）启动起实时采集；官方聚合与估算覆盖整个会话日志。'
		};
	}

	function handler(req, res) {
		let sessionId;
		try {
			const url = new URL(req.url || '/', 'http://localhost');
			sessionId = url.searchParams.get('sessionId') || undefined;
		} catch (e) {
			res.statusCode = 400;
			res.end(JSON.stringify({ error: 'bad url' }));
			return;
		}
		buildSummary(sessionId).then((data) => {
			res.setHeader('Content-Type', 'application/json; charset=utf-8');
			res.setHeader('Cache-Control', 'no-store');
			res.end(JSON.stringify(data));
		}).catch((e) => {
			res.statusCode = 500;
			res.setHeader('Content-Type', 'application/json; charset=utf-8');
			res.end(JSON.stringify({ error: String(e && e.message || e) }));
		});
	}

	ctx.webServer.register({
		kind: 'exact',
		path: '/dsh-token-monitor/summary',
		handler
	});
}
