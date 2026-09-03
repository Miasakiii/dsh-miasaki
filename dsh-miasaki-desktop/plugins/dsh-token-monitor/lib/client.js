window.__ModuleLoader__.load({
	id: "dsh-token-monitor",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		/** Required services: the slot registry is the only hard dependency. */
		const inject = ["slots"];

		const CSS = `
			.tokmn-pane { padding: 6px 20px 28px; }
			.tokmn-head { display: flex; align-items: baseline; justify-content: space-between; margin: 2px 0 14px; }
			.tokmn-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 18px; }
			.tokmn-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 12px 16px; }
			.tokmn-card-title { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0 0 10px; font-weight: 600; letter-spacing: 0.02em; }
			.tokmn-stat-value { font-size: 24px; font-weight: 700; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; line-height: 1.15; }
			.tokmn-stat-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 4px; word-break: break-all; }
			/* hero：上下文剩余（ZCode context bar 语言） */
			.tokmn-hero { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 16px 20px 14px; margin-bottom: 16px; }
			.tokmn-hero-wait { font-size: 13px; color: var(--dsw-alias-label-secondary); padding: 10px 0 6px; }
			.tokmn-hero-top { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 14px; }
			.tokmn-hero-big { font-size: 40px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
			.tokmn-hero-label { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 8px; }
			.tokmn-hero-side { margin-left: auto; text-align: right; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.9; }
			.tokmn-bar { height: 8px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; display: flex; flex: 1; }
			.tokmn-bar-lg { height: 12px; border-radius: 6px; }
			.tokmn-bar-seg { height: 100%; }
			/* 今日累计 + 限额 + 近 7 天趋势 */
			.tokmn-today { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(220px, 1.4fr) minmax(150px, auto); gap: 22px; align-items: center; }
			@media (max-width: 720px) { .tokmn-today { grid-template-columns: 1fr; } }
			.tokmn-today-big { font-size: 30px; font-weight: 700; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; line-height: 1.1; }
			.tokmn-limit { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
			.tokmn-limit-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
			.tokmn-limit-pct { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
			.tokmn-limitbar { height: 10px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
			.tokmn-limitbar-fill { height: 100%; border-radius: 5px; }
			.tokmn-limit-edit { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
			.tokmn-btn { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
			.tokmn-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
			.tokmn-btn:disabled { opacity: 0.5; cursor: default; }
			.tokmn-btn-sm { padding: 2px 9px; font-size: 11px; }
			.tokmn-input { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 4px 8px; font-size: 12px; font-variant-numeric: tabular-nums; }
			.tokmn-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
			.tokmn-spark { display: flex; align-items: flex-end; gap: 6px; }
			.tokmn-spark-colwrap { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; }
			.tokmn-spark-col { width: 100%; max-width: 22px; border-radius: 3px 3px 0 0; background: var(--dsw-alias-label-secondary); }
			.tokmn-spark-today { background: var(--dsw-alias-brand-primary); }
			.tokmn-spark-label { font-size: 9px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
			/* 行列表 / 图例 / chip / 性能 */
			.tokmn-row { display: flex; align-items: center; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
			.tokmn-row:last-child { border-bottom: none; }
			.tokmn-name { flex: 1.4; min-width: 0; font-size: 13px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.tokmn-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); }
			.tokmn-num { font-size: 13px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
			.tokmn-legend { display: inline-flex; align-items: center; gap: 6px; margin-right: 16px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
			.tokmn-dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
			.tokmn-chip { display: inline-flex; align-items: center; gap: 7px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 5px 14px; font-size: 12px; color: var(--dsw-alias-label-primary); margin: 0 8px 8px 0; }
			.tokmn-sec { margin-bottom: 18px; }
			.tokmn-sec-title { font-size: 13px; font-weight: 700; color: var(--dsw-alias-label-primary); margin: 0 0 10px; }
			.tokmn-perf { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; }
			.tokmn-perf-label { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-bottom: 2px; }
			.tokmn-perf-value { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
			.tokmn-foot { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.8; margin-top: 6px; }
			.tokmn-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 14px 0; }
			.tokmn-mono { font-variant-numeric: tabular-nums; }
		`;

		/** One JSON call against the host-side route（对齐 dsh-free-model-pool 约定）。 */
		async function api(method, path, body) {
			const res = await fetch(path, {
				method,
				headers: body === undefined ? {} : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			const payload = await res.json();
			if (!payload.ok) throw new Error(payload.error || "请求失败");
			return payload;
		}

		function fetchSummary(sessionId) {
			const url = "/dsh-token-monitor/summary?sessionId=" + encodeURIComponent(String(sessionId || ""));
			return window.fetch(url, { cache: "no-store" })
				.then((r) => {
					if (!r.ok) throw new Error("HTTP " + r.status + "（" + (r.status === 404 ? "host 路由未注册" : r.statusText || "请求失败") + "）");
					return r.text();
				})
				.then((text) => {
					if (!text) throw new Error("空响应（host 半未激活）");
					try { return JSON.parse(text); } catch (e) { throw new Error("非 JSON 响应: " + text.slice(0, 80)); }
				});
		}

		/** 阈值分档（ZCode 用量面板 45/75/95 分档）。 */
		function tierColor(pct) {
			return pct >= 95 ? "var(--dsw-alias-state-error-primary)"
				: pct >= 75 ? "var(--dsw-alias-state-warn-primary)"
				: pct >= 45 ? "var(--dsw-alias-brand-primary)"
				: "var(--dsw-alias-state-success-primary)";
		}

		function tierWord(pct) {
			return pct >= 95 ? "临界" : pct >= 75 ? "高压" : pct >= 45 ? "过半" : "充裕";
		}

		/**
		 * Token 用量监控视图：会话视图第三 Tab（对话/轨迹右侧）。
		 * 信息架构参考 ZCode 用量面板 —— 剩余视角优先：上下文剩余 hero →
		 * 今日累计 + 自定义限额 + 近 7 天趋势 → 统计卡 → 模型/工具明细。
		 */
		function TokenMonitorView(props) {
			const sessionId = props && props.sessionId;
			const [data, setData] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [limitEditing, setLimitEditing] = react.useState(false);
			const [limitValue, setLimitValue] = react.useState("");
			const [limitUnit, setLimitUnit] = react.useState("M");
			const [limitBusy, setLimitBusy] = react.useState(false);
			const [limitMsg, setLimitMsg] = react.useState(null);

			react.useEffect(() => {
				let alive = true;
				const load = () => fetchSummary(sessionId)
					.then((j) => { if (alive) { setData(j); setError(null); } })
					.catch((e) => { if (alive) setError(String(e && e.message || e)); });
				load();
				const timer = window.setInterval(load, 3000);
				return () => { alive = false; window.clearInterval(timer); };
			}, [sessionId]);

			// 保存限额后立刻拉一次（不经 alive 守卫：能点按钮组件必然挂着）。
			const loadNow = () => fetchSummary(sessionId).then((j) => { setData(j); }).catch(() => {});

			const full = (n) => (typeof n === "number" ? n.toLocaleString("zh-CN") : "—");
			const fmt = (n) => {
				if (typeof n !== "number") return "—";
				if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
				if (n >= 10000) return (n / 1000).toFixed(1) + "K";
				return full(n);
			};
			const fmtMs = (n) => (typeof n === "number" ? full(Math.round(n)) + " ms" : "—");

			const official = (data && data.official) || {};
			const tu = official.tokenUsage || {};
			const stats = official.sessionStats || {};
			const cp = official.contextPressure || {};
			const cb = official.contextBreakdown || {};
			const calls = (data && data.live && data.live.calls) || [];
			const tools = (data && data.live && data.live.tools) || [];
			const ledger = (data && data.ledger) || {};
			const today = ledger.today || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, total: 0 };
			const trend = ledger.trend || [];
			const limit = data && data.config ? (data.config.dailyTokenLimit || null) : null;
			const sampledAt = data && data.live && data.live.sampledAt;

			// ---- 上下文 hero：分母 = contextWindow，剩余视角 -----------------
			const hasCtx = typeof cp.contextWindow === "number" && cp.contextWindow > 0;
			const ctxUsed = hasCtx ? Math.min(cp.projectedTokens || 0, cp.contextWindow) : 0;
			const ctxUsedPct = hasCtx ? Math.min(100, Math.round((ctxUsed / cp.contextWindow) * 100)) : 0;
			const ctxFreePct = hasCtx ? 100 - ctxUsedPct : 0;
			const cbParts = [
				{ label: "系统提示", v: cb.systemTokens || 0, c: "var(--dsw-alias-brand-primary)" },
				{ label: "工具", v: cb.toolsTokens || 0, c: "var(--dsw-alias-state-warn-primary)" },
				{ label: "消息", v: cb.messageTokens || 0, c: "var(--dsw-alias-state-success-primary)" }
			];
			const cbSum = Math.max(1, cbParts[0].v + cbParts[1].v + cbParts[2].v);
			// 已用超出窗口时以已用和为分母（三段保持相对比例、剩余归零）。
			const heroScale = hasCtx ? Math.max(cp.contextWindow, cbSum) : cbSum;
			const ctxFreeV = hasCtx ? Math.max(0, cp.contextWindow - cbSum) : 0;

			// ---- 限额与趋势 --------------------------------------------------
			const limitPct = limit ? Math.min(100, Math.round((today.total / limit) * 100)) : null;
			const limitLeft = limit ? Math.max(0, limit - today.total) : null;
			const maxDay = Math.max(1, ...trend.map((d) => d.total || 0));

			const tuTotal = (tu.uncachedInputTokens || 0) + (tu.outputTokens || 0) + (tu.cacheReadTokens || 0) + (tu.cacheWriteTokens || 0);
			const maxCall = Math.max(1, ...calls.map((c) => c.total || 0));
			const decodeSpeed = (typeof stats.decodeMs === "number" && stats.decodeMs > 0 && typeof stats.decodeTokens === "number")
				? (stats.decodeTokens / (stats.decodeMs / 1000)).toFixed(1) + " tok/s" : "—";

			const segs = (parts, scale) => react.createElement("div", { className: "tokmn-bar" },
				parts.map((p, i) => p.v > 0 ? react.createElement("div", {
					key: i, className: "tokmn-bar-seg",
					style: { width: Math.max(2, Math.round((p.v / scale) * 100)) + "%", background: p.c },
					title: p.label + ": " + full(p.v)
				}) : null));

			const stat = (label, value, sub) => react.createElement("div", { className: "tokmn-card" },
				react.createElement("div", { className: "tokmn-card-title" }, label),
				react.createElement("div", { className: "tokmn-stat-value", title: full(value) }, String(value)),
				sub ? react.createElement("div", { className: "tokmn-stat-sub" }, sub) : null);

			const perfItem = (label, value) => react.createElement("div", null,
				react.createElement("div", { className: "tokmn-perf-label" }, label),
				react.createElement("div", { className: "tokmn-perf-value" }, value));

			const saveLimit = async () => {
				const n = parseFloat(limitValue);
				if (!isFinite(n) || n <= 0) { setLimitMsg({ ok: false, text: "请输入正数" }); return; }
				const tokens = Math.round(n * (limitUnit === "M" ? 1e6 : 1e3));
				setLimitBusy(true); setLimitMsg(null);
				try {
					await api("POST", "/dsh-token-monitor/config", { dailyTokenLimit: tokens });
					setLimitEditing(false); setLimitValue("");
					setLimitMsg({ ok: true, text: "限额已保存" });
					await loadNow();
				} catch (e) {
					setLimitMsg({ ok: false, text: "保存失败: " + String(e && e.message || e) });
				} finally {
					setLimitBusy(false);
				}
			};

			const clearLimit = async () => {
				setLimitBusy(true); setLimitMsg(null);
				try {
					await api("POST", "/dsh-token-monitor/config", { dailyTokenLimit: null });
					setLimitEditing(false); setLimitValue("");
					setLimitMsg({ ok: true, text: "已清除限额" });
					await loadNow();
				} catch (e) {
					setLimitMsg({ ok: false, text: "清除失败: " + String(e && e.message || e) });
				} finally {
					setLimitBusy(false);
				}
			};

			// 限额块：编辑/未设置态 vs 展示态。
			let limitBlock;
			if (limitEditing || !limit) {
				limitBlock = react.createElement("div", { className: "tokmn-limit" },
					react.createElement("div", { className: "tokmn-limit-head" },
						react.createElement("span", null, "日限额（tokens）"),
						!limit && !limitEditing ? react.createElement("button", {
							className: "tokmn-btn tokmn-btn-sm", disabled: limitBusy,
							onClick: () => { setLimitEditing(true); setLimitValue(""); }
						}, "设置日限额") : null),
					limitEditing
						? react.createElement("div", { className: "tokmn-limit-edit" },
							react.createElement("input", {
								className: "tokmn-input", type: "number", min: "0.1", step: "any",
								placeholder: "如 3.5", value: limitValue,
								onChange: (e) => setLimitValue(e.target.value)
							}),
							react.createElement("select", {
								className: "tokmn-input", value: limitUnit,
								onChange: (e) => setLimitUnit(e.target.value)
							},
								react.createElement("option", { value: "M" }, "M tokens"),
								react.createElement("option", { value: "K" }, "K tokens")),
							react.createElement("button", { className: "tokmn-btn", onClick: saveLimit, disabled: limitBusy }, limitBusy ? "保存中…" : "保存"),
							react.createElement("button", {
								className: "tokmn-btn", disabled: limitBusy,
								onClick: () => { setLimitEditing(false); setLimitValue(""); }
							}, "取消"))
						: react.createElement("div", { className: "tokmn-stat-sub" }, "未设置 —— 设置后此处显示进度条与阈值预警（45 / 75 / 95% 分档变色）。"));
			} else {
				limitBlock = react.createElement("div", { className: "tokmn-limit" },
					react.createElement("div", { className: "tokmn-limit-head" },
						react.createElement("span", null, "日限额 ", react.createElement("strong", { className: "tokmn-num" }, fmt(limit))),
						react.createElement("span", { className: "tokmn-limit-pct", style: { color: tierColor(limitPct) } }, limitPct + "%"),
						react.createElement("button", {
							className: "tokmn-btn tokmn-btn-sm", disabled: limitBusy,
							onClick: () => { setLimitEditing(true); setLimitValue(""); }
						}, "编辑"),
						react.createElement("button", { className: "tokmn-btn tokmn-btn-sm", onClick: clearLimit, disabled: limitBusy }, "清除")),
					react.createElement("div", { className: "tokmn-limitbar" },
						react.createElement("div", {
							className: "tokmn-limitbar-fill",
							style: { width: Math.max(limitPct, 1.5) + "%", background: tierColor(limitPct) }
						})),
					react.createElement("div", { className: "tokmn-stat-sub" },
						"已用 " + fmt(today.total) + " · 剩余 " + fmt(limitLeft)));
			}

			const heroBlock = !hasCtx
				? react.createElement("div", { className: "tokmn-hero" },
					react.createElement("div", { className: "tokmn-hero-wait" }, "等待会话投影数据 —— 发起一次对话后，此处将显示上下文剩余。"))
				: react.createElement("div", { className: "tokmn-hero" },
					react.createElement("div", { className: "tokmn-hero-top" },
						react.createElement("div", null,
							react.createElement("div", { className: "tokmn-hero-big", style: { color: tierColor(ctxUsedPct) } }, ctxFreePct + "%"),
							react.createElement("div", { className: "tokmn-hero-label" }, "上下文剩余 · " + tierWord(ctxUsedPct))),
						react.createElement("div", { className: "tokmn-hero-side" },
							react.createElement("div", null, "已用 ", react.createElement("strong", { className: "tokmn-num" }, fmt(ctxUsed)), " / ", fmt(cp.contextWindow)),
							react.createElement("div", null, "投影 ", fmt(cp.projectedTokens), " · 压力 ", fmt(cp.pressureTokens)))),
					react.createElement("div", { className: "tokmn-bar tokmn-bar-lg" },
						cbParts.map((p, i) => p.v > 0 ? react.createElement("div", {
							key: i, className: "tokmn-bar-seg",
							style: { width: Math.max(2, Math.round((p.v / heroScale) * 100)) + "%", background: p.c },
							title: p.label + ": " + full(p.v)
						}) : null)),
					react.createElement("div", { style: { display: "flex", flexWrap: "wrap", marginTop: 10 } },
						cbParts.map((p) => react.createElement("span", { className: "tokmn-legend", key: p.label },
							react.createElement("span", { className: "tokmn-dot", style: { background: p.c } }),
							p.label + " " + fmt(p.v))).concat([
							react.createElement("span", { className: "tokmn-legend", key: "_free" },
								react.createElement("span", {
									className: "tokmn-dot",
									style: { background: "var(--dsw-alias-bg-layer-2)", boxShadow: "inset 0 0 0 1px var(--dsw-alias-border-l1)" }
								}),
								"未使用 " + fmt(ctxFreeV))
						])));

			const sparkBlock = trend.length === 0
				? react.createElement("div", { className: "tokmn-stat-sub" }, "暂无历史数据")
				: react.createElement("div", { className: "tokmn-spark" },
					trend.map((d, i) => {
						const isToday = i === trend.length - 1;
						const h = d.total > 0 ? Math.max(3, Math.round((d.total / maxDay) * 44)) : 2;
						return react.createElement("div", { className: "tokmn-spark-colwrap", key: d.date || i },
							react.createElement("div", {
								className: "tokmn-spark-col" + (isToday ? " tokmn-spark-today" : ""),
								style: { height: h + "px", opacity: d.total > 0 ? (isToday ? 1 : 0.45) : 0.18 },
								title: d.date + " · 合计 " + full(d.total)
									+ "\n输入 " + full(d.inputTokens) + " · 输出 " + full(d.outputTokens)
									+ " · 缓存读 " + full(d.cacheReadTokens)
							}),
							react.createElement("div", { className: "tokmn-spark-label" }, isToday ? "今日" : String(d.date || "").slice(5)));
					}));

			return react.createElement("div", { className: "tokmn-pane" },
				react.createElement("style", null, CSS),
				react.createElement("div", { className: "tokmn-head" },
					react.createElement("h3", { style: { margin: 0, fontSize: 16, color: "var(--dsw-alias-label-primary)" } }, "Token 用量"),
					react.createElement("span", { className: "tokmn-stat-sub" },
						sampledAt ? "更新于 " + new Date(sampledAt).toLocaleTimeString("zh-CN", { hour12: false }) + " · 每 3 秒" : "每 3 秒自动刷新")),
				error ? react.createElement("p", { style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12 } }, "加载失败: " + error) : null,

				heroBlock,

				react.createElement("div", { className: "tokmn-sec" },
					react.createElement("div", { className: "tokmn-sec-title" }, "今日用量 · 全部会话（账本）"),
					react.createElement("div", { className: "tokmn-card tokmn-today" },
						react.createElement("div", null,
							react.createElement("div", { className: "tokmn-today-big", title: full(today.total) }, fmt(today.total)),
							react.createElement("div", { className: "tokmn-stat-sub" },
								"输入 " + fmt(today.inputTokens) + " · 输出 " + fmt(today.outputTokens) + " · 缓存读 " + fmt(today.cacheReadTokens))),
						limitBlock,
						react.createElement("div", null,
							react.createElement("div", { className: "tokmn-meta", style: { marginBottom: 6 } }, "近 7 天趋势"),
							sparkBlock)),
					limitMsg ? react.createElement("div", {
						style: {
							fontSize: 12, marginTop: 8,
							color: limitMsg.ok ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)"
						}
					}, limitMsg.text) : null),

				react.createElement("div", { className: "tokmn-grid" },
					stat("模型输出", fmt(tu.outputTokens), "解码 " + fmt(stats.decodeTokens) + " tok"),
					stat("缓存读取 / 写入", fmt(tu.cacheReadTokens) + " / " + fmt(tu.cacheWriteTokens), "上下文复用与持久化"),
					stat("累计 Tokens（官方）", fmt(tuTotal), "未缓存输入 " + fmt(tu.uncachedInputTokens) + " · 输出 " + fmt(tu.outputTokens)),
					stat("轮次 / 步数", fmt(stats.turns) + " / " + fmt(stats.steps))),

				react.createElement("div", { className: "tokmn-sec" },
					react.createElement("div", { className: "tokmn-sec-title" }, "按模型明细 · 实时采集（自插件启用起）"),
					react.createElement("div", { className: "tokmn-card" },
						calls.length === 0
							? react.createElement("div", { className: "tokmn-empty" }, "暂无数据 —— 插件启用后的模型调用会显示在这里。")
							: calls.map((c) => react.createElement("div", { className: "tokmn-row", key: c.provider + "|" + c.model },
								react.createElement("div", { className: "tokmn-name", title: c.provider },
									c.model,
									react.createElement("div", { className: "tokmn-meta" }, c.provider + " · " + c.calls + " 次调用")),
								segs([
									{ label: "输入", v: c.inputTokens || 0, c: "var(--dsw-alias-brand-primary)" },
									{ label: "输出", v: c.outputTokens || 0, c: "var(--dsw-alias-state-success-primary)" },
									{ label: "缓存读", v: c.cacheReadTokens || 0, c: "var(--dsw-alias-state-warn-primary)" },
									{ label: "推理", v: c.reasoningTokens || 0, c: "var(--dsw-alias-label-secondary)" }
								], maxCall),
								react.createElement("div", { className: "tokmn-num", style: { width: 78, textAlign: "right" }, title: full(c.total) }, fmt(c.total) + " tok"))))),

				react.createElement("div", { className: "tokmn-sec" },
					react.createElement("div", { className: "tokmn-sec-title" }, "工具调用 · 实时采集"),
					tools.length === 0
						? react.createElement("div", { className: "tokmn-empty" }, "暂无数据。")
						: react.createElement("div", null, tools.map((t) => react.createElement("span", {
							className: "tokmn-chip", key: t.name,
							title: "最近 " + new Date(t.lastAt).toLocaleTimeString("zh-CN")
						}, t.name, react.createElement("strong", { className: "tokmn-mono" }, t.count))))),

				react.createElement("div", { className: "tokmn-sec" },
					react.createElement("div", { className: "tokmn-sec-title" }, "性能（官方）"),
					react.createElement("div", { className: "tokmn-card" },
						react.createElement("div", { className: "tokmn-perf" },
							perfItem("TTFT", fmtMs(stats.ttftMs)),
							perfItem("解码耗时", fmtMs(stats.decodeMs)),
							perfItem("解码速度", decodeSpeed),
							perfItem("模型耗时", fmtMs(stats.llmMs)),
							perfItem("工具耗时", fmtMs(stats.toolMs))))),

				react.createElement("p", { className: "tokmn-foot" },
					"口径说明：官方聚合（tokenUsage / contextPressure / sessionStats）由会话日志投影，跨进程重启、含插件启用前历史；按模型的令牌明细与工具计数由本插件实时采集，仅统计进程启动之后；今日用量与近 7 天趋势来自跨会话账本（usage-log.jsonl），自插件首次部署起累计、跨 host 重启持久，限额为本地自定义配置（DSH 无配额接口）。")
			);
		}

		/**
		 * Client plugin body: register the usage view tab beside chat/trajectory.
		 */
		function apply(ctx) {
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "token-monitor",
				order: 15,
				label: "用量"
			}, TokenMonitorView));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
