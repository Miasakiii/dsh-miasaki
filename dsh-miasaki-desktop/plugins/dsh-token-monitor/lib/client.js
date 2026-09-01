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
			.tokmn-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 18px; }
			.tokmn-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 12px 16px; }
			.tokmn-card-title { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0 0 10px; font-weight: 600; letter-spacing: 0.02em; }
			.tokmn-stat-value { font-size: 24px; font-weight: 700; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; line-height: 1.15; }
			.tokmn-stat-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 4px; word-break: break-all; }
			.tokmn-bar { height: 8px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; display: flex; flex: 1; }
			.tokmn-bar-seg { height: 100%; }
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
			.tokmn-foot { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.8; margin-top: 6px; }
			.tokmn-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 14px 0; }
			.tokmn-mono { font-variant-numeric: tabular-nums; }
		`;

		/**
		 * Token 用量监控视图：会话视图第三 Tab（对话/轨迹右侧）。
		 * 数据经 GET /dsh-token-monitor/summary?sessionId=… 拉取（官方持久聚合
		 * + host 实时明细），3 秒轮询；离开视图即卸载并停止。
		 */
		function TokenMonitorView(props) {
			const sessionId = props && props.sessionId;
			const [data, setData] = react.useState(null);
			const [error, setError] = react.useState(null);

			react.useEffect(() => {
				let alive = true;
				const load = () => {
					const url = "/dsh-token-monitor/summary?sessionId=" + encodeURIComponent(String(sessionId || ""));
					window.fetch(url, { cache: "no-store" })
						.then((r) => {
							if (!r.ok) throw new Error("HTTP " + r.status + "（" + (r.status === 404 ? "host 路由未注册" : r.statusText || "请求失败") + "）");
							return r.text();
						})
						.then((text) => {
							if (!text) throw new Error("空响应（host 半未激活）");
							try { return JSON.parse(text); } catch (e) { throw new Error("非 JSON 响应: " + text.slice(0, 80)); }
						})
						.then((j) => { if (alive) { setData(j); setError(null); } })
						.catch((e) => { if (alive) setError(String(e && e.message || e)); });
				};
				load();
				const timer = window.setInterval(load, 3000);
				return () => { alive = false; window.clearInterval(timer); };
			}, [sessionId]);

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

			const tuTotal = (tu.uncachedInputTokens || 0) + (tu.outputTokens || 0) + (tu.cacheReadTokens || 0) + (tu.cacheWriteTokens || 0);
			const ctxWindow = cp.contextWindow || 1;
			const ctxPct = Math.min(100, Math.round(((cp.projectedTokens || 0) / ctxWindow) * 100));
			const cbParts = [
				{ label: "系统提示", v: cb.systemTokens || 0, c: "var(--dsw-alias-brand-primary)" },
				{ label: "工具", v: cb.toolsTokens || 0, c: "var(--dsw-alias-state-warn-primary)" },
				{ label: "消息", v: cb.messageTokens || 0, c: "var(--dsw-alias-state-success-primary)" }
			];
			const cbSum = Math.max(1, cbParts[0].v + cbParts[1].v + cbParts[2].v);
			const maxCall = Math.max(1, ...calls.map((c) => c.total || 0));

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

			return react.createElement("div", { className: "tokmn-pane" },
				react.createElement("style", null, CSS),
				react.createElement("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "2px 0 14px" } },
					react.createElement("h3", { style: { margin: 0, fontSize: 16, color: "var(--dsw-alias-label-primary)" } }, "Token 用量监控"),
					react.createElement("span", { className: "tokmn-stat-sub" }, "每 3 秒自动刷新")),
				error ? react.createElement("p", { style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12 } }, "加载失败: " + error) : null,

				react.createElement("div", { className: "tokmn-grid" },
					stat("累计 Tokens（官方）", fmt(tuTotal), "未缓存输入 " + fmt(tu.uncachedInputTokens) + " · 输出 " + fmt(tu.outputTokens)),
					stat("模型输出", fmt(tu.outputTokens), "解码 " + fmt(stats.decodeTokens) + " tok · TTFT " + fmtMs(stats.ttftMs)),
					stat("缓存读取 / 写入", fmt(tu.cacheReadTokens) + " / " + fmt(tu.cacheWriteTokens), "上下文复用与持久化"),
					stat("上下文占用", ctxPct + "%", "投影 " + fmt(cp.projectedTokens) + " / 窗口 " + fmt(cp.contextWindow))),

				react.createElement("div", { className: "tokmn-sec" },
					react.createElement("div", { className: "tokmn-sec-title" }, "上下文构成（官方折叠 · 当前轮）"),
					react.createElement("div", { className: "tokmn-card" },
						segs(cbParts, cbSum),
						react.createElement("div", { style: { display: "flex", flexWrap: "wrap", marginTop: 10 } },
							cbParts.map((p) => react.createElement("span", { className: "tokmn-legend", key: p.label },
								react.createElement("span", { className: "tokmn-dot", style: { background: p.c } }),
								p.label + " " + fmt(p.v)))))),
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
					react.createElement("div", { className: "tokmn-sec-title" }, "本会话统计（官方）"),
					react.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 } },
						stat("轮次 / 步数", fmt(stats.turns) + " / " + fmt(stats.steps)),
						stat("模型 / 工具耗时", fmtMs(stats.llmMs) + " / " + fmtMs(stats.toolMs)),
						stat("TTFT / 解码", fmtMs(stats.ttftMs) + " / " + fmtMs(stats.decodeMs)),
						stat("解码 Tokens", fmt(stats.decodeTokens)))),
				react.createElement("p", { className: "tokmn-foot" },
					"口径说明：官方聚合（tokenUsage / contextPressure / sessionStats）由会话日志投影，跨进程重启、含插件启用前历史；按模型的令牌明细与工具计数由本插件实时采集，仅统计进程启动之后。")
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
