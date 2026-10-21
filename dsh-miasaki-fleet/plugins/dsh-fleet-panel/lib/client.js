window.__ModuleLoader__.load({
	id: "@miasaki/dsh-fleet-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		/**
		 * 只依赖槽位注册表。
		 *
		 * 2026-10-20 形态：**会话视图 tab**（`conversation.view`，order 16，排在「用量」之后）
		 * + **原生渲染**（不再 iframe）。三个原因：
		 *  ① 用户反馈「不要挤占侧栏用量统计」⇒ 用会话级 tab；
		 *  ② iframe 内的 panel.html 是自带暗色主题 ⇒ 与 DSH 设计语言不统一；
		 *  ③ iframe 高度固定后里页滚不动 ⇒ 原生视图用外层滚动容器 + 官方令牌。
		 *
		 * 数据仍走 host 半的同源代理（`/dsh-fleet/api/*` → fleet-monitor），
		 * **不重写任何判定**：可派/断层/事件/验证者全部取现成端点。
		 *
		 * 「会话级」的边界：入口与视图实例是会话级的（每个会话各一份），
		 * fleet 数据层仍是全局单例（一套总线 / agent 池 / 台账）。
		 */
		const inject = ["slots"];

		const API = "/dsh-fleet";
		const HEALTH_PATH = API + "/health";
		/** 完整面板（含成本报表）仍由 fleet-monitor 提供；浏览器手动打开即可。 */
		const FULL_PANEL_URL = "http://127.0.0.1:39801/";
		const FLEET_POLL_MS = 3000;
		const JUDGE_POLL_MS = 12000;

		/* ---------- 通用工具 ---------- */

		async function getJSON(path) {
			const res = await fetch(API + path, { cache: "no-store" });
			const text = await res.text();
			// 防「非 JSON 被当对象」：代理/上游异常时把可读原因带出来，而不是静默 undefined。
			try {
				return JSON.parse(text);
			} catch (e) {
				throw new Error("非 JSON 响应（HTTP " + res.status + "）：" + text.slice(0, 120));
			}
		}

		function fmtCost(n) {
			const v = Number(n || 0);
			if (!isFinite(v)) return "$—";
			return "$" + v.toFixed(4);
		}

		function fmtNum(n) {
			const v = Number(n || 0);
			if (!isFinite(v)) return "—";
			return v >= 10000 ? (v / 1000).toFixed(1) + "K" : String(v);
		}

		function fmtClock(iso) {
			if (!iso) return "—";
			const d = new Date(iso);
			if (isNaN(d.getTime())) return "—";
			return d.toLocaleTimeString("zh-CN", { hour12: false });
		}

		function fmtAgo(iso) {
			if (!iso) return "—";
			const t = new Date(iso).getTime();
			if (!isFinite(t)) return "—";
			const diff = Math.max(0, Date.now() - t);
			const min = Math.floor(diff / 60000);
			if (min < 1) return "刚刚";
			if (min < 60) return min + " 分钟前";
			const h = Math.floor(min / 60);
			if (h < 24) return h + " 小时前";
			return Math.floor(h / 24) + " 天前";
		}

		const STATE_META = {
			running: { label: "运行中", tone: "info" },
			draining: { label: "收尾中", tone: "info" },
			idle: { label: "空闲", tone: "ok" },
			blocked: { label: "受阻", tone: "warn" },
			error: { label: "错误", tone: "bad" },
			unknown: { label: "未知", tone: "muted" },
			"no-status": { label: "未启动", tone: "muted" },
			stopped: { label: "已停止", tone: "muted" },
		};

		function stateOf(agent) {
			return STATE_META[agent && agent.state] || { label: (agent && agent.state) || "—", tone: "muted" };
		}

		function toneClass(tone) {
			return "fpanel-tone-" + tone;
		}

		/* ---------- 样式（只用官方 --dsw 令牌，跟随三主题） ---------- */

		const CSS = `
			.fpanel-view {
				display: flex; flex-direction: column;
				height: calc(100vh - 240px); min-height: 420px;
				padding: 4px 20px 10px; box-sizing: border-box; min-width: 0;
			}
			.fpanel-bar {
				display: flex; align-items: center; gap: 8px; flex: none;
				padding: 4px 2px 10px; min-width: 0;
			}
			.fpanel-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
			.fpanel-dot-on { background: var(--dsw-alias-state-success-primary); }
			.fpanel-dot-off { background: var(--dsw-alias-state-error-primary); }
			.fpanel-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
			.fpanel-sub {
				font-size: 12px; color: var(--dsw-alias-label-secondary);
				overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
				min-width: 0; max-width: 44%;
			}
			.fpanel-scope {
				margin-left: auto; flex: none; font-size: 11px;
				color: var(--dsw-alias-label-secondary); opacity: .85; white-space: nowrap;
			}
			.fpanel-iconbtn {
				display: inline-flex; align-items: center; justify-content: center;
				width: 28px; height: 28px; border: none; border-radius: 6px;
				background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
			}
			.fpanel-iconbtn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
			.fpanel-spin { animation: fpanel-spin 1s linear infinite; }
			@keyframes fpanel-spin { to { transform: rotate(360deg); } }

			.fpanel-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-right: 6px; }

			.fpanel-flash {
				margin: 0 0 10px; padding: 8px 12px; border-radius: 8px; font-size: 12px;
				background: var(--dsw-alias-bg-layer-2);
				border: 1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 22%, transparent);
				color: var(--dsw-alias-label-primary);
			}
			.fpanel-flash-bad { color: var(--dsw-alias-state-error-primary); }

			.fpanel-stats {
				display: grid; grid-template-columns: repeat(6, minmax(0, 1fr));
				gap: 10px; margin-bottom: 14px;
			}
			@media (max-width: 900px) { .fpanel-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
			.fpanel-stat {
				background: var(--dsw-alias-bg-layer-1);
				border: 1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 20%, transparent);
				border-radius: 10px; padding: 10px 12px; min-width: 0;
			}
			.fpanel-stat-v {
				font-size: 20px; font-weight: 700; line-height: 1.2;
				color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums;
				white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
			}
			.fpanel-stat-l { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 4px; }
			.fpanel-stat-sub { font-size: 10px; color: var(--dsw-alias-label-secondary); opacity: .8; margin-top: 2px; }

			.fpanel-sec { margin: 0 0 14px; }
			.fpanel-sec-head {
				display: flex; align-items: center; gap: 8px;
				margin: 0 0 8px; min-width: 0;
			}
			.fpanel-sec-title {
				font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary);
				letter-spacing: .02em;
			}
			.fpanel-sec-actions { margin-left: auto; display: flex; gap: 6px; flex: none; }
			.fpanel-grid {
				display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
				gap: 10px;
			}
			.fpanel-card {
				background: var(--dsw-alias-bg-layer-1);
				border: 1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 20%, transparent);
				border-radius: 10px; padding: 10px 12px; min-width: 0;
			}
			.fpanel-card-title {
				font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary);
				margin: 0 0 8px;
			}
			.fpanel-row {
				display: flex; align-items: baseline; gap: 6px;
				font-size: 12px; color: var(--dsw-alias-label-primary);
				padding: 3px 0; border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent);
			}
			.fpanel-row:last-child { border-bottom: none; }
			.fpanel-row-k { color: var(--dsw-alias-label-secondary); flex: none; }
			.fpanel-row-v { margin-left: auto; text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.fpanel-muted { font-size: 12px; color: var(--dsw-alias-label-secondary); }
			.fpanel-bad { color: var(--dsw-alias-state-error-primary); }
			.fpanel-ok { color: var(--dsw-alias-state-success-primary); }
			.fpanel-warn { color: var(--dsw-alias-state-warn-primary); }
			.fpanel-chip {
				display: inline-block; font-size: 10px; line-height: 1.4;
				padding: 1px 6px; border-radius: 999px;
				border: 1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 26%, transparent);
				color: var(--dsw-alias-label-secondary); margin: 0 4px 4px 0;
			}
			.fpanel-ev { display: flex; gap: 8px; font-size: 11px; padding: 3px 0; min-width: 0; }
			.fpanel-ev-time { color: var(--dsw-alias-label-secondary); flex: none; font-variant-numeric: tabular-nums; }
			.fpanel-ev-body { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

			.fpanel-agents {
				display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px;
			}
			.fpanel-agent {
				background: var(--dsw-alias-bg-layer-1);
				border: 1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 20%, transparent);
				border-radius: 10px; padding: 10px 12px; min-width: 0;
				display: flex; flex-direction: column; gap: 6px;
			}
			.fpanel-agent-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
			.fpanel-agent-name {
				font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary);
				overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
			}
			.fpanel-agent-id { font-size: 11px; color: var(--dsw-alias-label-secondary); flex: none; }
			.fpanel-agent-toggle {
				margin-left: auto; flex: none; font-size: 11px; line-height: 1.4;
				padding: 2px 10px; border-radius: 999px; cursor: pointer;
				border: 1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 30%, transparent);
				background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
			}
			.fpanel-agent-toggle:hover { border-color: var(--dsw-alias-brand-primary); }
			.fpanel-agent-toggle[disabled] { opacity: .5; cursor: default; }
			.fpanel-agent-meta {
				display: flex; flex-wrap: wrap; gap: 4px 10px;
				font-size: 11px; color: var(--dsw-alias-label-secondary); min-width: 0;
			}
			.fpanel-agent-metrics {
				display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
				gap: 6px; padding-top: 2px;
			}
			.fpanel-metric { min-width: 0; }
			.fpanel-metric-v {
				font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary);
				font-variant-numeric: tabular-nums;
			}
			.fpanel-metric-l { font-size: 10px; color: var(--dsw-alias-label-secondary); }
			.fpanel-agent-foot {
				display: flex; align-items: center; gap: 8px;
				font-size: 10px; color: var(--dsw-alias-label-secondary); min-width: 0;
			}
			.fpanel-agent-step {
				min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
			}
			.fpanel-tone-ok { color: var(--dsw-alias-state-success-primary); }
			.fpanel-tone-bad { color: var(--dsw-alias-state-error-primary); }
			.fpanel-tone-warn { color: var(--dsw-alias-state-warn-primary); }
			.fpanel-tone-info { color: var(--dsw-alias-brand-primary); }
			.fpanel-tone-muted { color: var(--dsw-alias-label-secondary); }
			.fpanel-state {
				display: inline-flex; align-items: center; gap: 4px;
				font-size: 10px; line-height: 1.4; padding: 1px 6px; border-radius: 999px;
				border: 1px solid currentColor; opacity: .9;
			}
			.fpanel-empty {
				font-size: 12px; color: var(--dsw-alias-label-secondary);
				padding: 6px 0;
			}
			.fpanel-tip { font-size: 10px; color: var(--dsw-alias-label-secondary); opacity: .85; }
		`;

		const h = react.createElement;

		/* ---------- 小组件 ---------- */

		function Stat(label, value, sub) {
			return h("div", { className: "fpanel-stat", key: "stat-" + label },
				h("div", { className: "fpanel-stat-v", title: String(value) }, value),
				h("div", { className: "fpanel-stat-l" }, label),
				sub ? h("div", { className: "fpanel-stat-sub" }, sub) : null);
		}

		function Row(key, label, value, extraClass) {
			return h("div", { className: "fpanel-row", key },
				h("span", { className: "fpanel-row-k" }, label),
				h("span", { className: "fpanel-row-v" + (extraClass ? " " + extraClass : ""), title: String(value) }, value));
		}

		function Card(title, children) {
			return h("div", { className: "fpanel-card" },
				title ? h("div", { className: "fpanel-card-title" }, title) : null,
				children);
		}

		function agentTone(agent) {
			if (!agent) return "muted";
			if (agent.alive === false || agent.state === "no-status") return "muted";
			if (agent.state === "error") return "bad";
			if (agent.state === "blocked") return "warn";
			if (agent.state === "running" || agent.state === "draining") return "info";
			if (agent.state === "idle") return "ok";
			return "muted";
		}

		function AgentCard(agent, busy, onToggle) {
			const meta = stateOf(agent);
			const disabled = busy === agent.id;
			return h("div", { className: "fpanel-agent", key: "agent-" + agent.id },
				h("div", { className: "fpanel-agent-head" },
					h("span", { className: "fpanel-dot " + (agent.alive ? "fpanel-dot-on" : "fpanel-dot-off"), title: agent.alive ? "判活通过" : "未判活" }),
					h("span", { className: "fpanel-agent-name" }, agent.name || agent.id),
					h("span", { className: "fpanel-agent-id" }, agent.id),
					h("span", { className: "fpanel-state " + toneClass(agentTone(agent)) }, meta.label),
					h("button", {
						type: "button", className: "fpanel-agent-toggle",
						disabled,
						title: agent.enabled ? "关闭该 agent（写 control.json）" : "开启该 agent",
						onClick: () => onToggle(agent, !agent.enabled)
					}, disabled ? "处理中…" : (agent.enabled ? "关闭" : "开启"))),
				h("div", { className: "fpanel-agent-meta" },
					h("span", null, (agent.runtime || "cli") + " · " + (agent.cli_version || "版本未知")),
					h("span", null, "model: " + (agent.model || "—")),
					h("span", null, "state: " + (agent.reported_state || agent.state || "—")),
					agent.stale ? h("span", { className: "fpanel-warn" }, "心跳过龄") : null),
				h("div", { className: "fpanel-agent-metrics" },
					h("div", { className: "fpanel-metric" },
						h("div", { className: "fpanel-metric-v" }, fmtCost(agent.cost_today)),
						h("div", { className: "fpanel-metric-l" }, "今日成本")),
					h("div", { className: "fpanel-metric" },
						h("div", { className: "fpanel-metric-v" }, fmtNum(agent.tokens_today)),
						h("div", { className: "fpanel-metric-l" }, "今日 tokens")),
					h("div", { className: "fpanel-metric" },
						h("div", { className: "fpanel-metric-v" }, String(agent.tasks_today || 0)),
						h("div", { className: "fpanel-metric-l" }, "今日任务"))),
				h("div", null,
					(agent.skills || []).map((s) => h("span", { className: "fpanel-chip", key: s }, s)),
					(agent.skills || []).length === 0 ? h("span", { className: "fpanel-muted" }, "档案未声明能力") : null),
				h("div", { className: "fpanel-agent-foot" },
					h("span", null, "心跳 " + fmtAgo(agent.heartbeat_at)),
					agent.current_task ? h("span", { className: "fpanel-agent-step" }, "· 任务 " + agent.current_task) : null,
					agent.step ? h("span", { className: "fpanel-agent-step" }, "· " + agent.step) : null));
		}

		/* ---------- 主视图 ---------- */

		function FleetView(props) {
			const sessionId = (props && props.sessionId) || "";
			const [fleet, setFleet] = react.useState(null);
			const [fleetError, setFleetError] = react.useState(null);
			const [health, setHealth] = react.useState(null);
			const [healthError, setHealthError] = react.useState(null);
			const [checking, setChecking] = react.useState(false);
			const [judge, setJudge] = react.useState({
				dispatchable: null, gaps: null, events: null, verifiers: null, errors: {},
			});
			const [busy, setBusy] = react.useState(null);
			const [flash, setFlash] = react.useState(null);

			const loadFleet = () => {
				return getJSON("/api/fleet")
					.then((j) => { setFleet(j); setFleetError(null); })
					.catch((e) => { setFleetError(String((e && e.message) || e)); });
			};

			const loadJudge = () => {
				const titles = { dispatchable: "可派集", gaps: "能力断层", events: "机器事件", verifiers: "验证者覆盖" };
				const paths = {
					dispatchable: "/api/dispatchable",
					gaps: "/api/gaps",
					events: "/api/events?limit=8",
					verifiers: "/api/verifiers",
				};
				const tasks = Object.keys(paths).map((key) =>
					getJSON(paths[key])
						.then((j) => ({ key, ok: true, value: j }))
						.catch((e) => ({ key, ok: false, error: String((e && e.message) || e), title: titles[key] })));
				return Promise.all(tasks).then((results) => {
					const next = { dispatchable: null, gaps: null, events: null, verifiers: null, errors: {} };
					for (const r of results) {
						if (r.ok) next[r.key] = r.value;
						else next.errors[r.key] = r.error;
					}
					setJudge(next);
				});
			};

			const checkHealth = () => {
				setChecking(true);
				return fetch(HEALTH_PATH, { cache: "no-store" })
					.then((r) => r.json())
					.then((j) => {
						setHealth(j || null);
						setHealthError(j && j.ok === true ? null : String((j && j.error) || "fleet-monitor 未就绪"));
					})
					.catch((e) => { setHealthError(String((e && e.message) || e)); })
					.finally(() => { setChecking(false); });
			};

			const refreshAll = () => {
				checkHealth();
				loadFleet();
				loadJudge();
			};

			react.useEffect(() => {
				checkHealth();
				loadFleet();
				loadJudge();
				const t1 = window.setInterval(loadFleet, FLEET_POLL_MS);
				const t2 = window.setInterval(loadJudge, JUDGE_POLL_MS);
				return () => { window.clearInterval(t1); window.clearInterval(t2); };
			}, []);

			const toggleAgent = (agent, enabled) => {
				setBusy(agent.id);
				setFlash(null);
				fetch(API + "/api/toggle/" + encodeURIComponent(agent.id), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ enabled }),
				})
					.then((r) => r.json().then((j) => ({ ok: r.ok, json: j })))
					.then(({ ok, json }) => {
						if (!ok || !json || json.ok !== true) {
							throw new Error((json && json.error) || "写 control.json 失败");
						}
						setFlash({ kind: "ok", text: agent.name + " 已" + (enabled ? "开启" : "关闭") });
						return loadFleet();
					})
					.catch((e) => { setFlash({ kind: "bad", text: "切换失败：" + String((e && e.message) || e) }); })
					.finally(() => { setBusy(null); });
			};

			const toggleAll = (enabled) => {
				const agents = (fleet && Array.isArray(fleet.agents)) ? fleet.agents : [];
				const targets = agents.filter((a) => a.enabled !== enabled);
				if (targets.length === 0) {
					setFlash({ kind: "ok", text: enabled ? "所有 agent 都已开启" : "所有 agent 都已关闭" });
					return;
				}
				setBusy("all");
				setFlash({ kind: "ok", text: "正在" + (enabled ? "开启" : "关闭") + " " + targets.length + " 个 agent…" });
				const run = (i) => {
					if (i >= targets.length) {
						setBusy(null);
						return loadFleet().then(() => setFlash({ kind: "ok", text: (enabled ? "已开启 " : "已关闭 ") + targets.length + " 个 agent" }));
					}
					const agent = targets[i];
					return fetch(API + "/api/toggle/" + encodeURIComponent(agent.id), {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ enabled }),
					})
						.then((r) => r.json())
						.then((json) => {
							if (!json || json.ok !== true) throw new Error((json && json.error) || agent.id + " 失败");
							return run(i + 1);
						});
				};
				run(0).catch((e) => {
					setBusy(null);
					setFlash({ kind: "bad", text: "批量切换中止：" + String((e && e.message) || e) });
					loadFleet();
				});
			};

			const agents = (fleet && Array.isArray(fleet.agents)) ? fleet.agents : [];
			const summary = (fleet && fleet.summary) || {};
			const online = summary.online || 0;
			const total = summary.total || agents.length;
			const monitorOnline = !!(health && health.ok === true);
			const judgeErr = {
				dispatchable: judge.errors.dispatchable,
				gaps: judge.errors.gaps,
				events: judge.errors.events,
				verifiers: judge.errors.verifiers,
			};

			const readyList = (judge.dispatchable && Array.isArray(judge.dispatchable.ready)) ? judge.dispatchable.ready : [];
			const blockedList = (judge.dispatchable && Array.isArray(judge.dispatchable.blocked)) ? judge.dispatchable.blocked : [];
			const finishedList = (judge.dispatchable && Array.isArray(judge.dispatchable.finished)) ? judge.dispatchable.finished : [];

			const statusText = monitorOnline
				? (health.reused ? "monitor 已在运行（复用现有实例）" : "monitor 已就绪")
				: (healthError || "monitor 未就绪");
			const scopeText = sessionId ? "会话级入口 · 全局编排器" : "全局编排器";

			const refreshBtn = h("button", {
				type: "button", className: "fpanel-iconbtn",
				title: "刷新（fleet " + FLEET_POLL_MS / 1000 + "s / 判定层 " + JUDGE_POLL_MS / 1000 + "s 自动轮询）",
				"aria-label": "刷新", onClick: refreshAll
			}, h("svg", {
				width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": "true",
				className: checking ? "fpanel-spin" : undefined
			}, h("path", {
				d: "M10.5 3.5A5 5 0 1 1 3.5 3.5M4.2 4.9L3.5 3.3 2.8 4.9",
				fill: "none", stroke: "currentColor", strokeWidth: 1.5,
				strokeLinecap: "round", strokeLinejoin: "round"
			})));

			const scrollChildren = [];

			if (flash) {
				scrollChildren.push(h("div", { key: "flash", className: "fpanel-flash" + (flash.kind === "bad" ? " fpanel-flash-bad" : "") }, flash.text));
			}

			if (fleetError && !fleet) {
				scrollChildren.push(h("div", { key: "fleet-error", className: "fpanel-card" },
					h("div", { className: "fpanel-card-title" }, "fleet-monitor 未就绪"),
					h("div", { className: "fpanel-muted fpanel-bad" }, fleetError),
					h("div", { className: "fpanel-tip", style: { marginTop: 8 } },
						"面板由 fleet-monitor 提供；首次打开会自动拉起它。若持续失败，可在 dsh-miasaki-fleet 目录运行：node fleet-monitor/server.js")));
			} else {
				// ① 统计行
				scrollChildren.push(h("div", { key: "stats", className: "fpanel-stats" },
					Stat("在线", online + "/" + total, monitorOnline ? "monitor 在线" : "monitor 未就绪"),
					Stat("已启用", String(summary.enabled || 0), "Operator 开关"),
					Stat("活跃任务", String(summary.tasks_active || 0), "running / draining"),
					Stat("今日成本", fmtCost(summary.cost_today), "全 agent 合计"),
					Stat("可派", judge.dispatchable ? String(readyList.length) : "—", judge.dispatchable ? "G1 可派集" : "判定层不可用"),
					Stat("终态", judge.dispatchable ? String(finishedList.length) : "—", judge.dispatchable ? "done + accepted" : "判定层不可用")));

				// ② 判定层
				const judgeCards = [];

				judgeCards.push(Card("可派集（G1）", judgeErr.dispatchable
					? h("div", { className: "fpanel-muted fpanel-bad" }, "不可用：" + judgeErr.dispatchable)
					: (readyList.length === 0 && blockedList.length === 0
						? h("div", { className: "fpanel-empty" }, "可派：无（全部 " + finishedList.length + " 个任务终态）")
						: h("div", null,
							readyList.map((t) => {
								const id = (t && t.id) || t;
								return h("div", { className: "fpanel-row", key: "ready-" + id }, h("span", { className: "fpanel-row-k" }, "可派"), h("span", { className: "fpanel-row-v" }, String(id)));
							}),
							blockedList.map((t, i) => {
								const id = (t && (t.id || t.task_id)) || ("blocked-" + i);
								const reasons = (t && Array.isArray(t.reasons)) ? t.reasons.join("；") : ((t && t.reason) || "不可派");
								return h("div", { className: "fpanel-row", key: "blocked-" + id }, h("span", { className: "fpanel-row-k fpanel-warn" }, "受阻"), h("span", { className: "fpanel-row-v", title: reasons }, String(id) + " · " + reasons));
							})))));

				const gaps = judge.gaps && judge.gaps.gaps ? judge.gaps.gaps : null;
				const archivedOnly = (gaps && Array.isArray(gaps.archivedOnly)) ? gaps.archivedOnly : [];
				const issues = (gaps && Array.isArray(gaps.issues)) ? gaps.issues : [];
				const synonyms = (gaps && Array.isArray(gaps.suspectedSynonyms)) ? gaps.suspectedSynonyms : [];
				judgeCards.push(Card("能力断层（G2）", judgeErr.gaps
					? h("div", { className: "fpanel-muted fpanel-bad" }, "不可用：" + judgeErr.gaps)
					: h("div", null,
						archivedOnly.length === 0
							? h("div", { className: "fpanel-empty" }, "无断层")
							: archivedOnly.map((g) => h("div", { className: "fpanel-row", key: "gap-" + g.capability },
								h("span", { className: "fpanel-row-k fpanel-warn" }, String(g.capability || "").replace(/^cap:/, "")),
								h("span", { className: "fpanel-row-v" }, "仅归档：" + ((g.archivedAgents || []).join(", ") || "—")))),
						issues.length ? h("div", { className: "fpanel-tip", style: { marginTop: 6 } }, "诊断 " + issues.length + " 条：" + issues.slice(0, 2).map((x) => x.agentId + " " + (x.detail || x.kind)).join("；") + (issues.length > 2 ? "…" : "")) : null,
						synonyms.length ? h("div", { className: "fpanel-tip" }, "疑似同义词 " + synonyms.length + " 组（需人工确认）") : null)));

				const verifiers = judge.verifiers || {};
				const explicitModels = Number(verifiers.agents_with_explicit_model || 0);
				const verifierAgents = Number(verifiers.agents || 0);
				judgeCards.push(Card("验证者覆盖（G4）", judgeErr.verifiers
					? h("div", { className: "fpanel-muted fpanel-bad" }, "不可用：" + judgeErr.verifiers)
					: h("div", null,
						Row("v-agents", "agent 数", String(verifierAgents)),
						Row("v-model", "显式 model", String(explicitModels)),
						Row("v-verdict", "已有 verdict", String(verifiers.verdicts || 0)),
						Row("v-problems", "问题", String((verifiers.problems || []).length)),
						explicitModels < verifierAgents
							? h("div", { className: "fpanel-tip", style: { marginTop: 6 } }, "模型级异构不可判定（多数 agent 的 model 为 cli-default）⇒ 判定层已保守降级到厂商级")
							: null)));

				const events = (judge.events && Array.isArray(judge.events.events)) ? judge.events.events : [];
				judgeCards.push(Card("最近机器事件（G0）", judgeErr.events
					? h("div", { className: "fpanel-muted fpanel-bad" }, "不可用：" + judgeErr.events)
					: (events.length === 0
						? h("div", { className: "fpanel-empty" }, "暂无事件")
						: h("div", null, events.slice(0, 8).map((ev, i) => h("div", { className: "fpanel-ev", key: "ev-" + i },
							h("span", { className: "fpanel-ev-time" }, fmtClock(ev.ts)),
							h("span", { className: "fpanel-ev-body", title: (ev.event || "") + " " + (ev.reason || "") },
								(ev.event || "—") + (ev.task_id ? " · " + ev.task_id : "") + (ev.reason ? " · " + ev.reason : ""))))))));

				scrollChildren.push(h("div", { key: "judge", className: "fpanel-sec" },
					h("div", { className: "fpanel-sec-head" },
						h("div", { className: "fpanel-sec-title" }, "判定层"),
						h("div", { className: "fpanel-tip" }, "数据源：fleet-monitor 现成端点（与派单器判定同源）")),
					h("div", { className: "fpanel-grid" }, judgeCards)));

				// ③ Agent 列表
				const canToggleAll = busy === null;
				scrollChildren.push(h("div", { key: "agents", className: "fpanel-sec" },
					h("div", { className: "fpanel-sec-head" },
						h("div", { className: "fpanel-sec-title" }, "Agent Fleet"),
						h("div", { className: "fpanel-tip" }, "开关写 control.json（经 bus-apply 唯一入口）"),
						h("div", { className: "fpanel-sec-actions" },
							h("button", {
								type: "button", className: "fpanel-agent-toggle", disabled: !canToggleAll,
								onClick: () => toggleAll(true)
							}, "全部开启"),
							h("button", {
								type: "button", className: "fpanel-agent-toggle", disabled: !canToggleAll,
								onClick: () => toggleAll(false)
							}, "全部关闭"))),
					agents.length === 0
						? h("div", { className: "fpanel-card fpanel-muted" }, "未发现 agent 档案（agents/*/manifest.json）")
						: h("div", { className: "fpanel-agents" },
							agents.map((agent) => AgentCard(agent, busy, toggleAgent)))));

				scrollChildren.push(h("div", { key: "full", className: "fpanel-tip", style: { marginTop: 2 } },
					"完整面板（含成本报表 / 年热力图）仍由 fleet-monitor 提供，可在浏览器打开：" + FULL_PANEL_URL));
			}

			return [
				h("style", { key: "css" }, CSS),
				h("div", { key: "root", className: "fpanel-view" },
					h("div", { className: "fpanel-bar" },
						h("span", { className: "fpanel-dot " + (monitorOnline ? "fpanel-dot-on" : "fpanel-dot-off"), title: statusText }),
						h("span", { className: "fpanel-title" }, "Fleet"),
						h("span", { className: "fpanel-sub" }, statusText),
						h("span", {
							className: "fpanel-scope",
							title: "fleet 是全局编排器（单一文件总线 / 一套 agent 池）；本 tab 是每个会话独立的查看入口"
						}, scopeText),
						refreshBtn),
					h("div", { className: "fpanel-scroll" }, scrollChildren))
			];
		}

		function apply(ctx) {
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "fleet-panel",
				order: 16,
				label: "Fleet"
			}, FleetView));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
