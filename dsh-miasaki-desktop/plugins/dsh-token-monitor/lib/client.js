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
			/* host 浅色模式下 --dsw-alias-border-l1 仅 4% 黑、--dsw-alias-bg-layer-2 与
			   layer-1 同为纯白：卡片边框/趋势图网格/热力空格/进度轨道会整体隐形。
			   故以 label-secondary 为基在插件内自派生三档中性色，深浅主题自适应。 */
			.tokmn-pane {
				--tokmn-border: color-mix(in srgb, var(--dsw-alias-label-secondary) 34%, transparent);
				--tokmn-hairline: color-mix(in srgb, var(--dsw-alias-label-secondary) 20%, transparent);
				--tokmn-cell-empty: color-mix(in srgb, var(--dsw-alias-label-secondary) 15%, transparent);
			}
			.tokmn-pane { padding: 6px 20px 28px; }
			.tokmn-head { display: flex; align-items: baseline; justify-content: space-between; margin: 2px 0 14px; }
			.tokmn-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 18px; }
			.tokmn-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--tokmn-border); border-radius: 8px; padding: 12px 16px; }
			.tokmn-card-title { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0 0 10px; font-weight: 600; letter-spacing: 0.02em; }
			.tokmn-stat-value { font-size: 24px; font-weight: 700; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; line-height: 1.15; }
			.tokmn-stat-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 4px; word-break: break-all; }
			/* 总览五卡（ZCode 用量面板头部统计行） */
			.tokmn-stats5 { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 16px; }
			@media (max-width: 860px) { .tokmn-stats5 { grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); } }
			.tokmn-stat5 { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--tokmn-border); border-radius: 10px; padding: 14px 8px 12px; text-align: center; min-width: 0; }
			.tokmn-stat5-v { font-size: 21px; font-weight: 700; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			.tokmn-stat5-l { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 6px; }
			/* 分段切换（每日/每周/累计 · 近7日/近30日） */
			.tokmn-sec-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 10px; flex-wrap: wrap; }
			.tokmn-seg { display: inline-flex; background: var(--tokmn-cell-empty); border-radius: 999px; padding: 2px; gap: 2px; }
			.tokmn-seg-btn { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 4px 14px; border-radius: 999px; cursor: pointer; }
			.tokmn-seg-btn:hover { color: var(--dsw-alias-label-primary); }
			.tokmn-seg-on { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18); }
			/* 热力图（Token 活动） */
			.tokmn-heat-scroll { overflow-x: auto; }
			.tokmn-heat { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 11px); grid-auto-columns: 11px; gap: 3px; width: max-content; }
			.tokmn-heat-weekly { grid-template-rows: 95px; }
			.tokmn-heat-weekly .tokmn-heat-cell { border-radius: 4px; }
			.tokmn-heat-cell { width: 11px; height: 100%; border-radius: 3px; background: var(--tokmn-cell-empty); }
			.tokmn-heat-cell:hover { outline: 1px solid var(--dsw-alias-label-secondary); }
			.tokmn-heat-months { position: relative; height: 15px; margin-top: 6px; }
			.tokmn-heat-month { position: absolute; top: 0; font-size: 10px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
			.tokmn-heat-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; gap: 12px; flex-wrap: wrap; }
			/* 悬浮提示（热力图 / 趋势图共用） */
			.tokmn-tip { position: absolute; z-index: 20; pointer-events: none; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--tokmn-border); border-radius: 8px; padding: 7px 11px; font-size: 11px; color: var(--dsw-alias-label-primary); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25); white-space: nowrap; }
			.tokmn-tip-sub { color: var(--dsw-alias-label-secondary); margin-top: 2px; }
			/* 趋势图 */
			.tokmn-chart-wrap { position: relative; }
			.tokmn-legend-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0 14px 8px 0; cursor: pointer; user-select: none; }
			.tokmn-legend-chip:hover { color: var(--dsw-alias-label-primary); }
			.tokmn-legend-chip-off { opacity: 0.35; }
			/* 环形图 + 模型列表 */
			.tokmn-donut { display: grid; grid-template-columns: auto 1fr; gap: 28px; align-items: center; }
			@media (max-width: 720px) { .tokmn-donut { grid-template-columns: 1fr; } }
			.tokmn-model-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--tokmn-hairline); }
			.tokmn-model-row:last-child { border-bottom: none; }
			.tokmn-code { font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace; font-size: 12px; }
			.tokmn-pct { margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
			/* hero：上下文剩余（ZCode context bar 语言） */
			.tokmn-hero { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--tokmn-border); border-radius: 12px; padding: 16px 20px 14px; margin-bottom: 16px; }
			.tokmn-hero-wait { font-size: 13px; color: var(--dsw-alias-label-secondary); padding: 10px 0 6px; }
			.tokmn-hero-top { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 14px; }
			.tokmn-hero-big { font-size: 40px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
			.tokmn-hero-label { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 8px; }
			.tokmn-hero-side { margin-left: auto; text-align: right; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.9; }
			.tokmn-bar { height: 8px; border-radius: 4px; background: var(--tokmn-cell-empty); overflow: hidden; display: flex; flex: 1; }
			.tokmn-bar-lg { height: 12px; border-radius: 6px; }
			.tokmn-bar-seg { height: 100%; }
			/* 今日累计 + 限额 */
			.tokmn-today { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(220px, 1.4fr); gap: 22px; align-items: center; }
			@media (max-width: 720px) { .tokmn-today { grid-template-columns: 1fr; } }
			.tokmn-today-big { font-size: 30px; font-weight: 700; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; line-height: 1.1; }
			.tokmn-limit { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
			.tokmn-limit-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
			.tokmn-limit-pct { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
			.tokmn-limitbar { height: 10px; border-radius: 5px; background: var(--tokmn-cell-empty); overflow: hidden; }
			.tokmn-limitbar-fill { height: 100%; border-radius: 5px; }
			.tokmn-limit-edit { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
			.tokmn-btn { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--tokmn-border); border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
			.tokmn-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
			.tokmn-btn:disabled { opacity: 0.5; cursor: default; }
			.tokmn-btn-sm { padding: 2px 9px; font-size: 11px; }
			.tokmn-input { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--tokmn-border); border-radius: 6px; padding: 4px 8px; font-size: 12px; font-variant-numeric: tabular-nums; }
			.tokmn-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
			/* 行列表 / 图例 / chip / 性能 */
			.tokmn-row { display: flex; align-items: center; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--tokmn-hairline); }
			.tokmn-row:last-child { border-bottom: none; }
			.tokmn-name { flex: 1.4; min-width: 0; font-size: 13px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.tokmn-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); }
			.tokmn-num { font-size: 13px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
			.tokmn-legend { display: inline-flex; align-items: center; gap: 6px; margin-right: 16px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
			.tokmn-dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; flex: none; }
			.tokmn-chip { display: inline-flex; align-items: center; gap: 7px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--tokmn-border); border-radius: 999px; padding: 5px 14px; font-size: 12px; color: var(--dsw-alias-label-primary); margin: 0 8px 8px 0; }
			.tokmn-sec { margin-bottom: 18px; }
			.tokmn-sec-title { font-size: 13px; font-weight: 700; color: var(--dsw-alias-label-primary); margin: 0 0 10px; }
			.tokmn-perf { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; }
			.tokmn-perf-label { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-bottom: 2px; }
			.tokmn-perf-value { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
			.tokmn-foot { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.8; margin-top: 6px; }
			.tokmn-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 14px 0; }
			.tokmn-mono { font-variant-numeric: tabular-nums; }
			/* 用量 Tab 激活期间解除与对话页列宽调节的联动：两侧列宽手柄（对话页
			   「对话框大小调节」，拖拽持久化 localStorage dsh.conversation.contentWidth）
			   隐藏，避免在用量页误拖改写对话页列宽；底部输入框宽度回到 DSH 默认档
			   （clamp 680–920，随列宽伸缩），不再跟随对话页拖拽值。手柄挂在会话根、
			   输入框挂在滚动容器层（均在视图区之外），故以 :has(.tokmn-pane) 作用域化；
			   默认档表达式须与 ConversationRoot 的 --dsh-chat-content-width 回退值一致。
			   本 style 随用量视图挂载/卸载，切走即整体恢复原状。 */
			[data-phase]:has(.tokmn-pane) [data-width-handle] { display: none !important; }
			[data-conversation-scroll]:has(.tokmn-pane) {
				--dsh-chat-content-width: clamp(680px, calc(var(--dsh-conversation-column-width, 0px) * 0.64), 920px);
				--dsh-composer-card-max-width: calc(var(--dsh-chat-content-width) + 32px);
			}
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

		// ---- 格式化 -------------------------------------------------------

		function full(n) { return (typeof n === "number" && isFinite(n)) ? n.toLocaleString("zh-CN") : "—"; }

		function fmt(n) {
			if (typeof n !== "number" || !isFinite(n)) return "—";
			if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
			if (n >= 10000) return (n / 1000).toFixed(1) + "K";
			return full(n);
		}

		function stripZ(s) { return s.indexOf(".") >= 0 ? s.replace(/0+$/, "").replace(/\.$/, "") : s; }

		/** 中文大数（ZCode 风格：7亿 / 3.3亿 / 440.8万）。 */
		function fmtCn(n) {
			if (typeof n !== "number" || !isFinite(n)) return "—";
			if (n >= 1e8) return stripZ((n / 1e8).toFixed(2)) + "亿";
			if (n >= 1e4) return stripZ((n / 1e4).toFixed(1)) + "万";
			return full(n);
		}

		/** 坐标轴紧凑数（4500K / 2.5M / 1.2亿）。 */
		function fmtAxis(n) {
			if (n >= 1e8) return stripZ((n / 1e8).toFixed(1)) + "亿";
			if (n >= 1e6) return stripZ((n / 1e6).toFixed(1)) + "M";
			if (n >= 1e3) return stripZ((n / 1e3).toFixed(1)) + "K";
			return String(Math.round(n));
		}

		function fmtPct(f) { const p = f * 100; return (p >= 10 ? String(Math.round(p)) : p.toFixed(1)) + "%"; }

		function fmtDuration(ms) {
			if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "—";
			const m = Math.round(ms / 60000);
			if (m < 1) return "1 分钟内";
			if (m < 60) return m + " 分钟";
			const h = Math.floor(m / 60);
			const rm = m % 60;
			if (h < 24) return rm > 0 ? h + " 小时 " + rm + " 分钟" : h + " 小时";
			return Math.floor(h / 24) + " 天 " + (h % 24) + " 小时";
		}

		function fmtMs(n) { return (typeof n === "number" && isFinite(n)) ? full(Math.round(n)) + " ms" : "—"; }

		// ---- 日期工具 -----------------------------------------------------

		function dkey(d) {
			return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
		}

		function parseKey(k) {
			const p = String(k || "").split("-").map(Number);
			return new Date(p[0] || 1970, (p[1] || 1) - 1, p[2] || 1);
		}

		function longDate(d) { return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日"; }

		function shortDate(d) { return (d.getMonth() + 1) + "月" + d.getDate() + "日"; }

		// ---- 图表数学 -----------------------------------------------------

		/** 模型序列配色（按总量排名分配，跨时间范围稳定）。 */
		const PALETTE = ["#4aa3ff", "#3ecf72", "#8b5cf6", "#f2555a", "#f59e0b", "#22d3ee", "#ec4899", "#a3e635", "#e879f9", "#14b8a6"];

		/** 向上取整到 1/2/2.5/5×10^k，做坐标轴上限。 */
		function niceMax(v) {
			if (!(v > 0)) return 1;
			const base = Math.pow(10, Math.floor(Math.log10(v)));
			for (const m of [1, 2, 2.5, 5, 10]) if (m * base >= v) return m * base;
			return 10 * base;
		}

		/** Catmull-Rom → 三次贝塞尔平滑折线；控制点 y 夹在绘图区内防过冲。 */
		function smoothPath(pts, yMin, yMax) {
			if (!pts || pts.length === 0) return "";
			if (pts.length === 1) return "M" + pts[0].x + "," + pts[0].y;
			const cl = (y) => Math.max(yMin, Math.min(yMax, y));
			let d = "M" + pts[0].x.toFixed(1) + "," + pts[0].y.toFixed(1);
			for (let i = 0; i < pts.length - 1; i++) {
				const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
				const c1x = p1.x + (p2.x - p0.x) / 6, c1y = cl(p1.y + (p2.y - p0.y) / 6);
				const c2x = p2.x - (p3.x - p1.x) / 6, c2y = cl(p2.y - (p3.y - p1.y) / 6);
				d += "C" + c1x.toFixed(1) + "," + c1y.toFixed(1) + " " + c2x.toFixed(1) + "," + c2y.toFixed(1) + " " + p2.x.toFixed(1) + "," + p2.y.toFixed(1);
			}
			return d;
		}

		/** GitHub 风格日历：52 周 + 周一对齐，返回 weeks[列][行]，未来日期为 null。 */
		function buildCalendar(days) {
			const map = new Map();
			for (const d of days || []) if (d && d.date) map.set(d.date, d);
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const start = new Date(today);
			start.setDate(start.getDate() - 364);
			start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
			const weeks = [];
			const cur = new Date(start);
			while (cur.getTime() <= today.getTime()) {
				const col = [];
				for (let r = 0; r < 7; r++) {
					if (cur.getTime() > today.getTime()) {
						col.push(null);
					} else {
						const key = dkey(cur);
						const rec = map.get(key);
						col.push({ key, d: new Date(cur), total: rec ? (rec.total || 0) : 0, calls: rec ? (rec.calls || 0) : 0 });
					}
					cur.setDate(cur.getDate() + 1);
				}
				weeks.push(col);
			}
			return weeks;
		}

		/** 热力格颜色：0 档底色，1–4 档品牌色按分位提亮。 */
		function heatStyle(v, max, future) {
			if (future) return { background: "var(--tokmn-cell-empty)", opacity: 0.4 };
			if (!(v > 0) || !(max > 0)) return { background: "var(--tokmn-cell-empty)" };
			const r = v / max;
			const op = r < 0.08 ? 0.3 : r < 0.25 ? 0.5 : r < 0.55 ? 0.72 : 1;
			return { background: "var(--dsw-alias-brand-primary)", opacity: op };
		}

		/** 分段切换控件。 */
		function Seg(options) {
			const opts = options.options, value = options.value, onChange = options.onChange;
			return react.createElement("div", { className: "tokmn-seg" },
				opts.map((o) => react.createElement("button", {
					key: o.value,
					className: "tokmn-seg-btn" + (value === o.value ? " tokmn-seg-on" : ""),
					onClick: () => onChange(o.value)
				}, o.label)));
		}

		/**
		 * Token 用量监控视图：会话视图第三 Tab（对话/轨迹右侧）。
		 * 信息架构参考 ZCode 用量面板：总览五卡 → Token 活动热力图 →
		 * 时间范围 + 每日趋势 + 模型用量占比 → 上下文剩余 → 今日/限额 →
		 * 统计卡 → 模型/工具明细。
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
			const [resetBusy, setResetBusy] = react.useState(false);
			const [heatDays, setHeatDays] = react.useState(null);
			const [heatMode, setHeatMode] = react.useState("daily");
			const [heatTip, setHeatTip] = react.useState(null);
			const [range, setRange] = react.useState(7);
			const [hiddenModels, setHiddenModels] = react.useState(() => new Set());
			const [hoverIdx, setHoverIdx] = react.useState(null);
			const [chartW, setChartW] = react.useState(0);
			const heatCardRef = react.useRef(null);
			const chartRef = react.useRef(null);

			// 摘要（含官方聚合 / 实时明细 / 账本统计）3s 轮询。
			react.useEffect(() => {
				let alive = true;
				const load = () => fetchSummary(sessionId)
					.then((j) => { if (alive) { setData(j); setError(null); } })
					.catch((e) => { if (alive) setError(String(e && e.message || e)); });
				load();
				const timer = window.setInterval(load, 3000);
				return () => { alive = false; window.clearInterval(timer); };
			}, [sessionId]);

			// 热力图账单 60s 轮询（数据量随账本增长，不随主轮询刷）；load 挂到
			// ref 上供「重置账本」后立即刷新。
			const loadHeatmapRef = react.useRef(() => {});
			react.useEffect(() => {
				let alive = true;
				const load = () => window.fetch("/dsh-token-monitor/heatmap", { cache: "no-store" })
					.then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
					.then((j) => { if (alive && j && j.ok) setHeatDays(j.days || []); })
					.catch(() => { /* 热力图失败不打扰主视图 */ });
				loadHeatmapRef.current = load;
				load();
				const timer = window.setInterval(load, 60000);
				return () => { alive = false; window.clearInterval(timer); };
			}, []);

			// 趋势图容器宽度（ResizeObserver，SVG 随面板伸缩）。
			react.useEffect(() => {
				const el = chartRef.current;
				if (!el || typeof window.ResizeObserver !== "function") return;
				const ro = new window.ResizeObserver((entries) => {
					const cr = entries && entries[0] && entries[0].contentRect;
					if (cr && cr.width) setChartW(Math.round(cr.width));
				});
				ro.observe(el);
				setChartW(Math.round(el.getBoundingClientRect().width) || 0);
				return () => ro.disconnect();
			}, []);

			// 保存限额后立刻拉一次（不经 alive 守卫：能点按钮组件必然挂着）。
			const loadNow = () => fetchSummary(sessionId).then((j) => { setData(j); }).catch(() => {});

			const official = (data && data.official) || {};
			const tu = official.tokenUsage || {};
			const stats = official.sessionStats || {};
			const cp = official.contextPressure || {};
			const cb = official.contextBreakdown || {};
			const calls = (data && data.live && data.live.calls) || [];
			const tools = (data && data.live && data.live.tools) || [];
			const ledger = (data && data.ledger) || {};
			const today = ledger.today || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, total: 0, calls: 0 };
			const trend = (ledger.trend || []);
			const overview = (data && data.stats) || {
				totalTokens: 0, peakDayTokens: 0, peakDayDate: null,
				longestSessionMs: 0, currentStreakDays: 0, longestStreakDays: 0, since: null
			};
			const limit = data && data.config ? (data.config.dailyTokenLimit || null) : null;
			const sampledAt = data && data.live && data.live.sampledAt;

			// ---- 总览五卡 ----------------------------------------------------
			const stat5 = (value, label, sub) => react.createElement("div", { className: "tokmn-stat5", title: sub || label },
				react.createElement("div", { className: "tokmn-stat5-v" }, value),
				react.createElement("div", { className: "tokmn-stat5-l" }, label));

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

			// ---- 限额 --------------------------------------------------------
			const limitPct = limit ? Math.min(100, Math.round((today.total / limit) * 100)) : null;
			const limitLeft = limit ? Math.max(0, limit - today.total) : null;

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

			// 清空跨会话账本：历史统计归零、限额保留；成功后立即刷两个数据源。
			const doReset = async () => {
				if (!window.confirm("确定清空用量账本？热力图 / 趋势 / 占比等历史统计将全部归零（限额配置保留），此操作不可恢复。")) return;
				setResetBusy(true);
				try {
					await api("POST", "/dsh-token-monitor/reset", {});
					setLimitMsg({ ok: true, text: "账本已清空，从现在起重新累计" });
					await loadNow();
					loadHeatmapRef.current();
				} catch (e) {
					setLimitMsg({ ok: false, text: "重置失败: " + String(e && e.message || e) });
				} finally {
					setResetBusy(false);
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

			const showHeatTip = (e, lines) => {
				const card = heatCardRef.current;
				if (!card) return;
				const cr = card.getBoundingClientRect();
				const tr = e.currentTarget.getBoundingClientRect();
				const x = Math.max(0, Math.min(tr.left - cr.left + tr.width / 2 - 80, cr.width - 170));
				const y = (tr.top - cr.top) < 54 ? (tr.bottom - cr.top + 8) : (tr.top - cr.top - 50);
				setHeatTip({ x, y, lines });
			};

			// ---- 热力图（Token 活动）----------------------------------------
			const weeks = react.useMemo(() => buildCalendar(heatDays), [heatDays]);
			let heatMax = 0;
			for (const col of weeks) for (const c of col) if (c && c.total > heatMax) heatMax = c.total;
			let weekStats = null;
			if (heatMode !== "daily") {
				weekStats = [];
				let cum = 0;
				for (const col of weeks) {
					let t = 0, wc = 0, first = null, last = null;
					for (const c of col) if (c) { t += c.total; wc += c.calls; if (!first) first = c.d; last = c.d; }
					cum += t;
					weekStats.push({ total: t, calls: wc, cum, first, last });
				}
			}
			const weekMax = weekStats
				? Math.max(1, ...weekStats.map((w) => (heatMode === "weekly" ? w.total : w.cum)))
				: 1;
			const monthLabels = [];
			{
				let pm = -1;
				for (let ci = 0; ci < weeks.length; ci++) {
					const ref = weeks[ci].find((c) => c);
					if (!ref) continue;
					const m = ref.d.getMonth();
					if (m !== pm) { monthLabels.push({ ci, label: (m + 1) + "月" }); pm = m; }
				}
			}
			const heatCellProps = (v, max, future, lines) => ({
				className: "tokmn-heat-cell",
				style: heatStyle(v, max, future),
				onMouseEnter: lines ? (e) => showHeatTip(e, lines) : undefined,
				onMouseLeave: () => setHeatTip(null)
			});
			let heatGrid;
			if (heatMode === "daily") {
				const cells = [];
				weeks.forEach((col, ci) => col.forEach((c, ri) => {
					cells.push(react.createElement("div", Object.assign({ key: ci + "." + ri },
						heatCellProps(c ? c.total : -1, heatMax, !c,
							c ? [longDate(c.d), full(c.total) + " tokens · " + c.calls + " 轮消息"] : null))));
				}));
				heatGrid = cells;
			} else {
				heatGrid = weeks.map((col, ci) => {
					const w = weekStats[ci];
					const lines = !w || !w.first
						? null
						: heatMode === "weekly"
							? [longDate(w.first) + " ~ " + shortDate(w.last), full(w.total) + " tokens · " + w.calls + " 轮消息"]
							: ["截至 " + longDate(w.last || w.first), "累计 " + full(w.cum) + " tokens"];
					return react.createElement("div", Object.assign({ key: "w" + ci },
						heatCellProps(heatMode === "weekly" ? w.total : w.cum, weekMax, false, lines)));
				});
			}

			// ---- 时间范围 + 趋势图 + 环形图 ----------------------------------
			const slice = trend.slice(-range);
			const valMaps = slice.map((e) => {
				const mm = {};
				for (const m of e.models || []) mm[m.provider + "|" + m.model] = m.total || 0;
				return mm;
			});
			// 调色板按全窗口（30 天）总量排名分配，切换时间范围时颜色保持稳定。
			const rankTotals = new Map();
			for (const e of trend) for (const m of e.models || []) {
				const k = m.provider + "|" + m.model;
				rankTotals.set(k, (rankTotals.get(k) || 0) + (m.total || 0));
			}
			const rankedKeys = Array.from(rankTotals.keys()).sort((a, b) => (rankTotals.get(b) || 0) - (rankTotals.get(a) || 0));
			const colorOf = {};
			rankedKeys.forEach((k, i) => { colorOf[k] = PALETTE[i % PALETTE.length]; });
			const rangeSums = new Map();
			for (const e of slice) for (const m of e.models || []) {
				const k = m.provider + "|" + m.model;
				rangeSums.set(k, (rangeSums.get(k) || 0) + (m.total || 0));
			}
			const modelNameCount = {};
			for (const k of rangeSums.keys()) {
				const nm = k.split("|")[1];
				modelNameCount[nm] = (modelNameCount[nm] || 0) + 1;
			}
			const models = Array.from(rangeSums.entries())
				.filter((entry) => entry[1] > 0)
				.sort((a, b) => b[1] - a[1])
				.map((entry) => {
					const parts = entry[0].split("|");
					const nm = parts[1];
					return {
						key: entry[0], provider: parts[0],
						label: modelNameCount[nm] > 1 ? parts[0] + "/" + nm : nm,
						total: entry[1], color: colorOf[entry[0]] || PALETTE[0]
					};
				});
			const visibleModels = models.filter((m) => !hiddenModels.has(m.key));
			const rangeTotal = models.reduce((s, m) => s + m.total, 0);
			const toggleModel = (k) => setHiddenModels((prev) => {
				const n = new Set(prev);
				if (n.has(k)) n.delete(k); else n.add(k);
				return n;
			});

			// 趋势图几何：宽度自适应（回退 640），平滑曲线 + 网格 + 悬浮明细。
			const CH_H = 230, PAD_L = 52, PAD_R = 14, PAD_T = 12, PAD_B = 26;
			const chartWpx = chartW || 640;
			const plotW = Math.max(60, chartWpx - PAD_L - PAD_R);
			const plotH = CH_H - PAD_T - PAD_B;
			let visMax = 0;
			for (let i = 0; i < slice.length; i++) {
				for (const m of visibleModels) {
					const v = valMaps[i][m.key] || 0;
					if (v > visMax) visMax = v;
				}
			}
			const yMax = niceMax(visMax || 1);
			const xAt = (i) => PAD_L + (slice.length <= 1 ? plotW / 2 : (i / (slice.length - 1)) * plotW);
			const yAt = (v) => PAD_T + plotH - (Math.min(v, yMax) / yMax) * plotH;
			const seriesPath = (m) => {
				const pts = [];
				for (let i = 0; i < slice.length; i++) pts.push({ x: xAt(i), y: yAt(valMaps[i][m.key] || 0) });
				return smoothPath(pts, PAD_T, PAD_T + plotH);
			};
			const tickIdx = [];
			{
				const step = range === 7 ? 1 : 5;
				for (let i = 0; i < slice.length; i += step) tickIdx.push(i);
				const last = slice.length - 1;
				if (last >= 0 && tickIdx.indexOf(last) < 0) tickIdx.push(last);
			}
			const hoverRows = (hoverIdx !== null && hoverIdx >= 0 && hoverIdx < slice.length)
				? visibleModels
					.map((m) => ({ m, v: valMaps[hoverIdx][m.key] || 0 }))
					.sort((a, b) => b.v - a.v)
				: [];

			// 环形图分段（相邻段留 1% 缝隙）。
			const D_SIZE = 170, D_R = 60, D_CX = 85, D_CY = 85, D_SW = 22;
			const D_C = 2 * Math.PI * D_R;
			let dAcc = 0;
			const donutSegs = models.map((m) => {
				const frac = rangeTotal > 0 ? m.total / rangeTotal : 0;
				const dash = Math.max(0.004, frac - 0.01) * D_C;
				const off = -dAcc * D_C;
				dAcc += frac;
				return { color: m.color, dash, off };
			});

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
									style: { background: "var(--tokmn-cell-empty)", boxShadow: "inset 0 0 0 1px var(--tokmn-border)" }
								}),
								"未使用 " + fmt(ctxFreeV))
						])));

			return react.createElement("div", { className: "tokmn-pane" },
				react.createElement("style", null, CSS),
				react.createElement("div", { className: "tokmn-head" },
					react.createElement("h3", { style: { margin: 0, fontSize: 16, color: "var(--dsw-alias-label-primary)" } }, "Token 用量"),
					react.createElement("span", { className: "tokmn-stat-sub" },
						sampledAt ? "更新于 " + new Date(sampledAt).toLocaleTimeString("zh-CN", { hour12: false }) + " · 每 3 秒" : "每 3 秒自动刷新")),
				error ? react.createElement("p", { style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12 } }, "加载失败: " + error) : null,

				// 总览五卡
				react.createElement("div", { className: "tokmn-stats5" },
					stat5(fmtCn(overview.totalTokens), "累计 Token 数", full(overview.totalTokens) + " tokens"),
					stat5(fmtCn(overview.peakDayTokens), "峰值 Token 数",
						"单日最高" + (overview.peakDayDate ? " · " + overview.peakDayDate : "")),
					stat5(fmtDuration(overview.longestSessionMs), "最长聊天时长", "单会话活跃跨度（账本）"),
					stat5(overview.currentStreakDays + " 天", "当前连续天数", "连续有用量的天数"),
					stat5(overview.longestStreakDays + " 天", "最长连续天数", "历史最长连续天数")),

				// Token 活动热力图
				react.createElement("div", { className: "tokmn-sec", ref: heatCardRef, style: { position: "relative" } },
					react.createElement("div", { className: "tokmn-sec-head" },
						react.createElement("div", null,
							react.createElement("span", { className: "tokmn-sec-title", style: { marginRight: 10 } }, "Token 活动"),
							react.createElement("span", { className: "tokmn-meta" },
								"自 " + ((heatDays && heatDays.length && heatDays[0].date) || overview.since || "—") + " 起记录")),
						Seg({
							options: [{ value: "daily", label: "每日" }, { value: "weekly", label: "每周" }, { value: "cumulative", label: "累计" }],
							value: heatMode, onChange: setHeatMode
						})),
					react.createElement("div", { className: "tokmn-card" },
						react.createElement("div", { className: "tokmn-heat-scroll" },
							react.createElement("div", null,
								react.createElement("div", { className: "tokmn-heat" + (heatMode === "daily" ? "" : " tokmn-heat-weekly") }, heatGrid),
								react.createElement("div", { className: "tokmn-heat-months", style: { width: Math.max(1, weeks.length * 14 - 3) + "px" } },
									monthLabels.map((m) => react.createElement("span", {
										key: m.ci, className: "tokmn-heat-month", style: { left: (m.ci * 14) + "px" }
									}, m.label))))),
						react.createElement("div", { className: "tokmn-heat-foot" },
							react.createElement("span", { className: "tokmn-meta" }, "共 " + ((data && data.stats && data.stats.activeDays) || 0) + " 个活跃日 —— 悬浮查看当日明细"),
							react.createElement("span", { className: "tokmn-meta" }, "颜色深浅 = 用量多少"))),
					heatTip ? react.createElement("div", { className: "tokmn-tip", style: { left: heatTip.x, top: heatTip.y } },
						heatTip.lines.map((l, i) => react.createElement("div", { key: i, className: i === 0 ? "" : "tokmn-tip-sub" }, l))) : null),

				// 时间范围 + 每日趋势 + 模型用量
				react.createElement("div", { className: "tokmn-sec" },
					react.createElement("div", { className: "tokmn-sec-head" },
						react.createElement("div", { className: "tokmn-sec-title", style: { margin: 0 } }, "时间范围"),
						Seg({
							options: [{ value: 7, label: "近 7 日" }, { value: 30, label: "近 30 日" }],
							value: range, onChange: setRange
						})),
					react.createElement("div", { className: "tokmn-card", style: { marginBottom: 12 } },
						react.createElement("div", { className: "tokmn-sec-title" }, "每日 Token 趋势图"),
						models.length === 0
							? react.createElement("div", { className: "tokmn-empty" }, "暂无数据 —— 账本启用后的模型用量会按日绘制在这里。")
							: react.createElement("div", null,
								react.createElement("div", null,
									models.map((m) => react.createElement("span", {
										key: m.key,
										className: "tokmn-legend-chip" + (hiddenModels.has(m.key) ? " tokmn-legend-chip-off" : ""),
										onClick: () => toggleModel(m.key),
										title: m.provider + " · 点击显示/隐藏"
									},
										react.createElement("span", { className: "tokmn-dot", style: { background: m.color } }),
										m.label,
										react.createElement("span", { className: "tokmn-meta" }, fmtCn(m.total))))),
								react.createElement("div", { className: "tokmn-chart-wrap", ref: chartRef },
									react.createElement("svg", { width: chartWpx, height: CH_H, style: { display: "block" } },
										[0, 0.25, 0.5, 0.75, 1].map((f, gi) => {
											const y = PAD_T + plotH - f * plotH;
											return react.createElement("g", { key: "g" + gi },
												react.createElement("line", {
													x1: PAD_L, y1: y, x2: PAD_L + plotW, y2: y,
													stroke: f === 0 ? "var(--tokmn-border)" : "var(--tokmn-hairline)",
													strokeWidth: 1,
													strokeDasharray: f === 0 ? undefined : "3 4"
												}),
												react.createElement("text", {
													x: PAD_L - 8, y: y + 3, textAnchor: "end", fontSize: 10,
													fill: "var(--dsw-alias-label-secondary)"
												}, fmtAxis(f * yMax)));
										}),
										visibleModels.map((m) => react.createElement("path", {
											key: m.key, d: seriesPath(m), fill: "none",
											stroke: m.color, strokeWidth: 2, strokeLinecap: "round"
										})),
										(hoverIdx !== null && hoverIdx >= 0 && hoverIdx < slice.length)
											? react.createElement("g", { key: "hover" },
												react.createElement("line", {
													x1: xAt(hoverIdx), y1: PAD_T, x2: xAt(hoverIdx), y2: PAD_T + plotH,
													stroke: "var(--dsw-alias-label-secondary)", strokeWidth: 1
												}),
												visibleModels.map((m) => react.createElement("circle", {
													key: m.key, cx: xAt(hoverIdx), cy: yAt(valMaps[hoverIdx][m.key] || 0),
													r: 3.5, fill: m.color
												})))
											: null,
										tickIdx.map((i) => react.createElement("text", {
											key: "x" + i, x: xAt(i), y: CH_H - 8, textAnchor: "middle", fontSize: 10,
											fill: "var(--dsw-alias-label-secondary)"
										}, shortDate(parseKey(slice[i].date)))),
										slice.map((e, i) => react.createElement("rect", {
											key: "h" + i,
											x: xAt(i) - plotW / Math.max(1, slice.length) / 2, y: PAD_T,
											width: Math.max(1, plotW / Math.max(1, slice.length)), height: plotH,
											fill: "transparent", style: { pointerEvents: "all" },
											onMouseEnter: () => setHoverIdx(i),
											onMouseLeave: () => setHoverIdx(null)
										}))),
									(hoverIdx !== null && hoverIdx >= 0 && hoverIdx < slice.length)
										? react.createElement("div", {
											className: "tokmn-tip",
											style: {
												left: Math.max(0, Math.min(xAt(hoverIdx) + 12, chartWpx - 190)),
												top: PAD_T + 4
											}
										},
											react.createElement("div", null, longDate(parseKey(slice[hoverIdx].date)) + " · " + full(slice[hoverIdx].total) + " tokens"),
											hoverRows.map((r) => react.createElement("div", { key: r.m.key, className: "tokmn-tip-sub", style: { display: "flex", gap: 6, alignItems: "center" } },
												react.createElement("span", { className: "tokmn-dot", style: { background: r.m.color } }),
												react.createElement("span", null, r.m.label),
												react.createElement("span", { className: "tokmn-mono", style: { marginLeft: "auto", paddingLeft: 12 } }, fmtCn(r.v)))))
										: null))),
					react.createElement("div", { className: "tokmn-card" },
						react.createElement("div", { className: "tokmn-sec-title" }, "模型用量"),
						models.length === 0
							? react.createElement("div", { className: "tokmn-empty" }, "暂无数据。")
							: react.createElement("div", { className: "tokmn-donut" },
								react.createElement("svg", { width: D_SIZE, height: D_SIZE },
									react.createElement("circle", { cx: D_CX, cy: D_CY, r: D_R, fill: "none", stroke: "var(--tokmn-cell-empty)", strokeWidth: D_SW }),
									donutSegs.map((s, i) => react.createElement("circle", {
										key: i, cx: D_CX, cy: D_CY, r: D_R, fill: "none",
										stroke: s.color, strokeWidth: D_SW,
										strokeDasharray: s.dash + " " + (D_C - s.dash),
										strokeDashoffset: s.off,
										transform: "rotate(-90 " + D_CX + " " + D_CY + ")"
									})),
									react.createElement("text", {
										x: D_CX, y: D_CY - 1, textAnchor: "middle", fontSize: 20, fontWeight: 700,
										fill: "var(--dsw-alias-label-primary)"
									}, fmtCn(rangeTotal)),
									react.createElement("text", {
										x: D_CX, y: D_CY + 17, textAnchor: "middle", fontSize: 10,
										fill: "var(--dsw-alias-label-secondary)"
									}, "tokens")),
								react.createElement("div", null,
									models.map((m) => {
										const frac = rangeTotal > 0 ? m.total / rangeTotal : 0;
										return react.createElement("div", { className: "tokmn-model-row", key: m.key },
											react.createElement("span", { className: "tokmn-dot", style: { background: m.color } }),
											react.createElement("div", { style: { minWidth: 0 } },
												react.createElement("div", { className: "tokmn-name tokmn-code", title: m.provider }, m.label),
												react.createElement("div", { className: "tokmn-meta", title: full(m.total) }, fmtCn(m.total) + " tokens")),
											react.createElement("span", { className: "tokmn-pct" }, fmtPct(frac)));
									}))))),

				heroBlock,

				react.createElement("div", { className: "tokmn-sec" },
					react.createElement("div", { className: "tokmn-sec-head" },
						react.createElement("div", { className: "tokmn-sec-title", style: { margin: 0 } }, "今日用量 · 全部会话（账本）"),
						react.createElement("button", {
							className: "tokmn-btn tokmn-btn-sm", disabled: resetBusy,
							onClick: doReset, title: "清空账本历史统计（不可恢复，限额配置保留）"
						}, resetBusy ? "重置中…" : "重置账本")),
					react.createElement("div", { className: "tokmn-card tokmn-today" },
						react.createElement("div", null,
							react.createElement("div", { className: "tokmn-today-big", title: full(today.total) }, fmtCn(today.total)),
							react.createElement("div", { className: "tokmn-stat-sub" },
								"输入 " + fmt(today.inputTokens) + " · 输出 " + fmt(today.outputTokens)
								+ " · 缓存读 " + fmt(today.cacheReadTokens) + " · " + (today.calls || 0) + " 轮消息")),
						limitBlock),
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
					"口径说明：官方聚合（tokenUsage / contextPressure / sessionStats）由会话日志投影，跨进程重启、含插件启用前历史；按模型的令牌明细与工具计数由本插件实时采集，仅统计进程启动之后；总览统计、Token 活动热力图、每日趋势与模型用量占比来自跨会话账本（usage-log.jsonl，保留 380 天），自插件首次部署起累计、跨 host 重启持久，「最长聊天时长」为账本记录的单会话活跃跨度；限额为本地自定义配置（DSH 无配额接口）。")
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
