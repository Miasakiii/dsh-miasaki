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
			   故以 label-secondary 为基在插件内自派生三档中性色，深浅主题自适应。
			   变量同时作用于会话页（.tokmn-pane）与全局浮窗（.tokmn-ov）。 */
			.tokmn-pane, .tokmn-ov {
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
			/* 总览六卡（全局浮窗头部统计行，ZCode 用量面板同构） */
			.tokmn-stats6 { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 16px; }
			@media (max-width: 860px) { .tokmn-stats6 { grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); } }
			.tokmn-stat6 { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--tokmn-border); border-radius: 10px; padding: 14px 8px 12px; text-align: center; min-width: 0; }
			.tokmn-stat6-v { font-size: 21px; font-weight: 700; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			.tokmn-stat6-l { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 6px; }
			/* 分段切换（每日/每周/累计 · 近7日/近30日） */
			.tokmn-sec-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 10px; flex-wrap: wrap; }
			.tokmn-seg { display: inline-flex; background: var(--tokmn-cell-empty); border-radius: 999px; padding: 2px; gap: 2px; }
			.tokmn-seg-btn { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 4px 14px; border-radius: 999px; cursor: pointer; }
			.tokmn-seg-btn:hover { color: var(--dsw-alias-label-primary); }
			.tokmn-seg-on { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18); }
			/* 热力图（Token 活动） */
			.tokmn-heat-scroll { overflow-x: auto; }
			.tokmn-heat { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 11px); grid-auto-columns: 11px; gap: 3px; width: max-content; }
			.tokmn-heat-weekly { grid-template-rows: 95px; align-items: end; }
			.tokmn-heat-weekly .tokmn-heat-cell { border-radius: 4px; }
			.tokmn-heat-cell { width: 11px; height: 100%; border-radius: 3px; background: var(--tokmn-cell-empty); }
			.tokmn-heat-cell:hover { outline: 1px solid var(--dsw-alias-label-secondary); }
			.tokmn-heat-months { position: relative; height: 15px; margin-top: 6px; }
			.tokmn-heat-month { position: absolute; top: 0; font-size: 10px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
			.tokmn-heat-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; gap: 12px; flex-wrap: wrap; }
			/* 悬浮提示（热力图 / 趋势图共用）：限宽 + 名字截断 —— 模型名可以很长
			   （deepseek-v4.1-flash-expires-on-0910），nowrap 下会把提示框撑到面板外，
			   数字被边界裁掉（v0.5.1 用户截图）。 */
			.tokmn-tip { position: absolute; z-index: 20; pointer-events: none; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--tokmn-border); border-radius: 8px; padding: 7px 11px; font-size: 11px; color: var(--dsw-alias-label-primary); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25); white-space: nowrap; max-width: 340px; overflow: hidden; }
			.tokmn-tip-sub { color: var(--dsw-alias-label-secondary); margin-top: 2px; }
			.tokmn-tip-row { display: flex; gap: 6px; align-items: center; }
			.tokmn-tip-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
			.tokmn-tip-val { flex: none; margin-left: auto; padding-left: 12px; }
			/* 趋势图 */
			.tokmn-chart-wrap { position: relative; }
			.tokmn-legend-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0 14px 8px 0; cursor: pointer; user-select: none; }
			.tokmn-legend-chip:hover { color: var(--dsw-alias-label-primary); }
			.tokmn-legend-chip-off { opacity: 0.35; }
			/* 环形图 + 模型列表：1fr 写成 minmax(0,1fr) 才能收缩 —— grid 项默认
			   min-width:auto，长模型名会把列撑到 min-content，.tokmn-pct 的
			   margin-left:auto 于是被推到卡片外、叠到右列上（v0.5.1 用户截图）。 */
			.tokmn-donut { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 28px; align-items: center; }
			@media (max-width: 720px) { .tokmn-donut { grid-template-columns: 1fr; } }
			.tokmn-model-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--tokmn-hairline); }
			.tokmn-model-row:last-child { border-bottom: none; }
			.tokmn-code { font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace; font-size: 12px; }
			.tokmn-pct { flex: none; margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
			/* 使用分布两列（模型环形图 | 会话活跃分布）：右列要承载逐日分布条，故略偏右；
			   两列都写 minmax(0,…) 防溢出（同 .tokmn-donut 的理由），窄屏单列堆叠。 */
			.tokmn-dist { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: 12px; align-items: start; }
			@media (max-width: 980px) { .tokmn-dist { grid-template-columns: 1fr; } }
			/* 会话活跃分布（v0.5.0）：密集排行 —— 序号 | 标题 | 总量 | 占比·轮次 | 近 30 日逐日格 */
			.tokmn-sess { display: flex; flex-direction: column; min-width: 0; }
			/* 卡头标题区：meta 文案（"近 30 日 · 共 45 个工作目录"）在窄列下要被压缩
			   截断，而不是把卡片撑破（v0.5.1 用户截图里它被边界裁掉）。 */
			.tokmn-sess-head-l { display: flex; align-items: baseline; min-width: 0; }
			.tokmn-sess-head-l > .tokmn-sec-title { flex: none; }
			.tokmn-sess-head-l > .tokmn-meta { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.tokmn-sess-ctl { display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
			.tokmn-sess-search { width: 116px; }
			.tokmn-select { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--tokmn-border); border-radius: 6px; padding: 3px 6px; font-size: 11px; font-variant-numeric: tabular-nums; cursor: pointer; }
			.tokmn-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
			/* 默认 Top 10 恰好一屏放满（不需滚动）；切更大条数才内滚 */
			.tokmn-sess-list { max-height: 420px; overflow-y: auto; overflow-x: hidden; }
			.tokmn-sess-row { display: flex; align-items: center; gap: 10px; padding: 5px 6px; margin: 0 -6px; border-radius: 6px; }
			/* 行间极淡分隔线：10 行两行式文本连排时容易串行，给一条可跟随的引导线 */
			.tokmn-sess-row + .tokmn-sess-row { border-top: 1px solid var(--tokmn-hairline); }
			.tokmn-sess-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
			.tokmn-sess-idx { width: 16px; flex: none; text-align: right; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
			/* 名称列两行：标题（认得出是哪个会话）+ 身份行（工作目录 · 最后活跃日） */
			.tokmn-sess-name { flex: 1 1 auto; min-width: 56px; display: flex; flex-direction: column; gap: 1px; }
			.tokmn-sess-title { font-size: 13px; line-height: 1.3; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.tokmn-sess-id { font-size: 11px; line-height: 1.25; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.tokmn-sess-tag { display: inline-block; margin-right: 5px; padding: 0 5px; border-radius: 4px; background: var(--tokmn-cell-empty); font-size: 10px; line-height: 14px; }
			.tokmn-sess-num { flex: none; width: 84px; text-align: right; font-size: 13px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
			.tokmn-sess-sub { flex: none; width: 96px; text-align: right; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
			/* 逐日分布：**底部对齐的迷你柱**（空日 3px 基线、有量 5–18px 高柱，见
			   distCellStyle）。等高条带遇稀疏数据会渲染成"一整条灰带 + 右侧一个深块"，
			   既没有信息量又添视觉噪声；矮基线 + 高柱才扫得动。 */
			.tokmn-sess-spark { flex: none; display: flex; align-items: flex-end; gap: 2px; height: 18px; }
			.tokmn-sess-cell { width: 5px; border-radius: 2px; background: var(--tokmn-cell-empty); }
			@media (max-width: 720px) { .tokmn-sess-sub { display: none; } }
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
			/* 全局用量统计浮窗（shell.overlay：全帧背板 + 居中面板） */
			.tokmn-ov-backdrop { position: fixed; inset: 0; z-index: 50; background: rgba(0, 0, 0, 0.45); display: flex; align-items: center; justify-content: center; padding: 32px; }
			.tokmn-ov-panel { width: min(1120px, 100%); max-height: min(86vh, 920px); display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--tokmn-border); border-radius: 14px; box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35); overflow: hidden; }
			.tokmn-ov-head { display: flex; align-items: center; gap: 12px; padding: 13px 20px; border-bottom: 1px solid var(--tokmn-hairline); flex: none; }
			.tokmn-ov-title { font-size: 15px; font-weight: 700; color: var(--dsw-alias-label-primary); margin: 0; }
			.tokmn-ov-body { padding: 14px 20px 24px; overflow-y: auto; min-height: 0; }
			.tokmn-iconbtn { width: 30px; height: 30px; border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; flex: none; padding: 0; }
			.tokmn-iconbtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
			/* 头部「刷新」钮：刷新期间图标旋转（transform 动画，停止即回正） */
			@keyframes tokmn-spin { to { transform: rotate(360deg); } }
			.tokmn-spin { animation: tokmn-spin 0.8s linear infinite; transform-origin: 50% 50%; }
			/* 侧栏脚部「用量统计」入口（sidebar.footer.action）：形态对齐宿主设置
			   触发钮（settings trigger：42px 高 / 12px 圆角 / 透明底 / hover
			   interactive-bg-hover / padding 0 10px 0 8px / 14px·22px），展开态
			   flex:1 撑满 footerActions 行（list 槽位无包裹层，本元素即 flex 子项），
			   收起态 36px 圆形图标钮（对齐 _rail）。 */
			.tokmn-fa { flex: 1 1 0; min-width: 0; margin-top: 8px; display: flex; }
			.tokmn-fa-btn { flex: 1; min-width: 0; height: 42px; display: inline-flex; align-items: center; gap: 8px; border: none; background: transparent; border-radius: 12px; color: var(--dsw-alias-label-primary); cursor: pointer; font-family: inherit; font-size: 14px; line-height: 22px; padding: 0 10px 0 8px; overflow: hidden; }
			.tokmn-fa-btn:hover, .tokmn-fa-btn[data-active="true"] { background: var(--dsw-alias-interactive-bg-hover); }
			.tokmn-fa-label { flex: 1; min-width: 0; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			.tokmn-fa-rail { flex: none; width: 36px; justify-content: center; }
			.tokmn-fa-rail .tokmn-fa-btn { width: 36px; height: 36px; border-radius: 50%; justify-content: center; gap: 0; padding: 0; }
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

		/** 统一响应解包：先查 HTTP 状态再解析 JSON，404 等非 2xx 给出可读错误，
		    避免「Failed to execute 'json' on 'Response'」这类裸解析报错。 */
		async function readJSON(res) {
			if (!res.ok) throw new Error("HTTP " + res.status + "（" + (res.status === 404 ? "host 路由未注册 —— 请重启 dsh web 使 host 半生效" : res.statusText || "请求失败") + "）");
			const text = await res.text();
			if (!text) throw new Error("空响应（host 半未激活）");
			try {
				const j = JSON.parse(text);
				if (!j.ok) throw new Error(j.error || "请求失败");
				return j;
			} catch (e) {
				if (e instanceof SyntaxError) throw new Error("非 JSON 响应: " + text.slice(0, 80));
				throw e;
			}
		}

		/** One JSON call against the host-side route（对齐 dsh-free-model-pool 约定）。 */
		async function api(method, path, body) {
			const res = await fetch(path, {
				method,
				headers: body === undefined ? {} : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			return readJSON(res);
		}

		/** 会话路由（v0.4.0 起）：官方聚合 + 按会话过滤的实时明细。 */
		function fetchSession(sessionId) {
			const url = "/dsh-token-monitor/session?sessionId=" + encodeURIComponent(String(sessionId || ""));
			return window.fetch(url, { cache: "no-store" }).then(readJSON);
		}

		/** 全局路由（v0.4.0 起）：跨会话账本统计 + 限额。 */
		function fetchGlobal() {
			return api("GET", "/dsh-token-monitor/global");
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

		/** 毫秒时间戳 → 「今天」/「09-10」：会话身份行里的最后活跃日。 */
		function fmtDayShort(ms) {
			if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "";
			const d = new Date(ms);
			const today = new Date();
			if (d.toDateString() === today.toDateString()) return "今天";
			return String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
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

		/**
		 * 会话活跃分布格（v0.5.0 起）。
		 *
		 * 以**该行自身峰值**归一化 —— 分布回答的是"这行哪几天在活跃"，跨行的绝对
		 * 量级已由数值列表达；若按全局峰值归一化，小行会整条褪成近底色、形态不可读。
		 *
		 * v0.5.1 改为**底部对齐的柱**（空日只留 3px 基线、有量给 5–18px 高柱，高度与
		 * 透明度双编码）：实测按会话维度近 30 日只有 4% 的格非零，等高条带会渲染成
		 * "一整条灰带 + 右侧一个深块"，看不出趋势也压不住噪声；矮基线 + 高柱把
		 * "哪天在活跃、量有多大"变成可直接横向扫读的形态。
		 */
		function distCellStyle(v, max) {
			if (!(v > 0) || !(max > 0)) return { height: "3px", background: "var(--tokmn-cell-empty)" };
			const r = Math.min(1, v / max);
			const op = r < 0.1 ? 0.45 : r < 0.3 ? 0.62 : r < 0.6 ? 0.82 : 1;
			return { height: Math.round(5 + r * 13) + "px", background: "var(--dsw-alias-brand-primary)", opacity: op };
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

		/** 已删除会话等场景的 ID 降级显示（头部…尾部）。 */
		function shortId(sid) {
			const s = String(sid || "");
			return s.length > 18 ? s.slice(0, 10) + "…" + s.slice(-6) : s;
		}

		/** 浮窗开合 store：侧栏按钮（sidebar.footer.action）与浮层（shell.overlay）
		    是两个独立槽位条目，经此模块级极简发布订阅共享状态，不引入依赖。 */
		const overlayStore = (() => {
			let open = false;
			const subs = new Set();
			return {
				get: () => open,
				set(v) { if (v !== open) { open = !!v; subs.forEach((f) => f()); } },
				subscribe(f) { subs.add(f); return () => subs.delete(f); }
			};
		})();

		function useOverlayOpen() {
			return react.useSyncExternalStore(overlayStore.subscribe, overlayStore.get);
		}

		/** 浮窗「刷新」总线：头部刷新钮（GlobalUsageOverlay）跨组件通知数据组件
		    （GlobalStatsContent）立即重拉 /global 与 /heatmap，不必等 5s / 60s
		    轮询。fire() 汇合各订阅方返回的 Promise，供调用方驱动「刷新中」旋转态。 */
		const refreshBus = (() => {
			const subs = new Set();
			return {
				fire() { return Promise.all(Array.from(subs, (f) => Promise.resolve().then(f))); },
				subscribe(f) { subs.add(f); return () => subs.delete(f); }
			};
		})();

		/** 侧栏脚部「用量统计」入口按钮（sidebar.footer.action）。
		    props.wide 为宿主传入的侧栏展开态：展开 42px 全宽钮，收起 36px 圆形图标钮。 */
		function UsageStatsButton(props) {
			const wide = !!(props && props.wide);
			const open = useOverlayOpen();
			const icon = react.createElement("svg", {
				width: wide ? 15 : 17, height: wide ? 15 : 17, viewBox: "0 0 16 16", "aria-hidden": "true"
			},
				react.createElement("rect", { x: 2, y: 8, width: 3, height: 6, rx: 1, fill: "currentColor" }),
				react.createElement("rect", { x: 6.5, y: 4, width: 3, height: 10, rx: 1, fill: "currentColor" }),
				react.createElement("rect", { x: 11, y: 6, width: 3, height: 8, rx: 1, fill: "currentColor" }));
			// 注意必须返回数组：此前写成 `return createElement(style), createElement(div)`
			// 逗号表达式 —— <style> 被求值后丢弃，按钮与浮窗的 CSS 全部失效
			//（按钮裸奔成浏览器默认样式、浮窗无样式堆叠），v0.4.0 目检修复。
			return [
				react.createElement("style", { key: "css" }, CSS),
				react.createElement("div", { key: "btn", className: "tokmn-fa" + (wide ? "" : " tokmn-fa-rail") },
					react.createElement("button", {
						type: "button", className: "tokmn-fa-btn", "data-active": open ? "true" : "false",
						"aria-label": "用量统计", title: wide ? undefined : "用量统计",
						onClick: () => overlayStore.set(true)
					}, icon, wide ? react.createElement("span", { className: "tokmn-fa-label" }, "用量统计") : null))
			];
		}

		/**
		 * 会话活跃分布（全局浮窗「使用分布」右列，v0.5.0 替代原「会话用量 Top N」）。
		 *
		 * 首要解决的是**认不认得出是哪个会话**：主机折叠会话日志给出标题与工作
		 * 目录，行内以「标题 + 身份行（目录 · 最后活跃 · 子会话）」两行呈现；只有
		 * 折叠彻底失败时才退回截断 ID（此时身份行补上 ID，避免整行无信息）。
		 *
		 * 其次是**看不看得出分布**：原"单条按榜首归一化的比例条"只能回答"谁排
		 * 第一"，逐日格把时间维度摊到行内，一眼可辨"长期滴灌"与"单日爆发"。
		 *
		 * 三组控件（排序键 / 搜索 / 条数）全部在**本地集合**上即时生效：主机下发
		 * Top 50 候选（`sessions.rows`）+ 窗口分母（`totalAll` / `callsAll`），
		 * 交互不回主机取数，5s 轮询照常刷新。搜索匹配标题 / ID / 工作目录。
		 *
		 * 占比分母 = 窗口内**全部**会话合计，而非所选行之和（长尾会话会让后者虚高）。
		 */
		function SessionActivityCard(props) {
			const p = props || {};
			const rows = p.rows || [];
			const byCwd = p.byCwd || {};
			const cwdRows = byCwd.rows || [];
			const cwdUnresolved = byCwd.unresolved || 0;
			const dates = p.dates || [];
			const totalAll = p.totalAll || 0;
			const callsAll = p.callsAll || 0;
			const matched = typeof p.matched === "number" ? p.matched : rows.length;
			const windowDays = p.windowDays || dates.length || 30;
			const [dim, setDim] = react.useState("session");
			const [sortKey, setSortKey] = react.useState("tokens");
			const [query, setQuery] = react.useState("");
			const [limit, setLimit] = react.useState(10);

			// 两个维度共用同一套控件与行结构，只是数据源与"名称/身份行"的语义不同：
			// 会话维度回答"这个会话"，目录维度回答"这个项目"（把同目录多个会话叠加，
			// 单会话只有 1–2 天活跃，叠加后才看得出项目的活跃形态）。
			const isCwd = dim === "cwd";
			const srcRows = isCwd ? cwdRows : rows;
			const denom = isCwd ? (byCwd.totalAll || 0) : totalAll;
			const srcMatched = isCwd ? (byCwd.matched || cwdRows.length) : matched;

			const q = query.trim().toLowerCase();
			const shown = srcRows
				.filter((r) => !q
					|| String(r.title || "").toLowerCase().indexOf(q) >= 0
					|| String(r.sessionId || "").toLowerCase().indexOf(q) >= 0
					|| String(r.cwdName || "").toLowerCase().indexOf(q) >= 0)
				.slice()
				.sort((a, b) => (sortKey === "calls"
					? (b.calls || 0) - (a.calls || 0) || (b.total || 0) - (a.total || 0)
					: (b.total || 0) - (a.total || 0) || (b.calls || 0) - (a.calls || 0)))
				.slice(0, limit);

			const list = shown.length === 0
				? react.createElement("div", { className: "tokmn-empty" }, srcRows.length === 0
					? (isCwd
						? "暂无数据 —— 近 " + windowDays + " 日尚无可归入工作目录的会话。"
						: "暂无数据 —— 近 " + windowDays + " 日有用量的会话会按总量排在这里。")
					: "没有匹配「" + query.trim() + "」的" + (isCwd ? "目录" : "会话") + "。")
				: react.createElement("div", { className: "tokmn-sess-list" },
					shown.map((r, i) => {
						const daily = Array.isArray(r.daily) ? r.daily : [];
						const peak = Math.max(1, ...daily);
						const pct = denom > 0 ? (r.total || 0) / denom : 0;
						const cwdRow = r.kind === "cwd";
						const cells = [];
						for (let d = 0; d < windowDays; d++) {
							const v = daily[d] || 0;
							cells.push(react.createElement("span", {
								key: d, className: "tokmn-sess-cell", style: distCellStyle(v, peak),
								title: (dates[d] || ("第 " + (d + 1) + " 日")) + " · " + (v > 0 ? full(v) + " tokens" : "无用量")
							}));
						}
						// 身份行：会话维度是「工作目录 · 最后活跃日」，目录维度是「N 个会话 · 最后活跃日」；
						// 整行既无标题也无身份可用时，把截断 ID 放这里兜底（不编造名字）。
						const meta = [];
						if (cwdRow) {
							meta.push((r.sessions || 0) + " 个会话");
							if (r.last) meta.push(fmtDayShort(r.last));
						} else {
							if (r.cwdName) meta.push(String(r.cwdName));
							if (r.last) meta.push(fmtDayShort(r.last));
						}
						let metaText = meta.join(" · ");
						if (!metaText && !r.title) metaText = shortId(r.sessionId);
						const idLine = ((!cwdRow && r.subagent) || metaText)
							? react.createElement("div", { className: "tokmn-sess-id", title: r.cwd || undefined },
								(!cwdRow && r.subagent) ? react.createElement("span", { className: "tokmn-sess-tag" }, "子会话") : null,
								metaText)
							: null;
						return react.createElement("div", { className: "tokmn-sess-row", key: (cwdRow ? "cwd:" + r.key : r.sessionId) + "#" + i },
							react.createElement("span", { className: "tokmn-sess-idx" }, i + 1),
							react.createElement("div", {
								className: "tokmn-sess-name",
								title: cwdRow
									? (r.cwd || r.cwdName || "") + "\n" + (r.sessions || 0) + " 个会话"
									: (r.title ? r.title + "\n" : "") + "ID " + r.sessionId
										+ (r.cwd ? "\n目录 " + r.cwd : "")
										+ (r.agentPreset ? "\n预设 " + r.agentPreset : "")
							},
								react.createElement("div", { className: "tokmn-sess-title" },
									cwdRow ? (r.cwdName || r.title || r.key) : (r.title || shortId(r.sessionId))),
								idLine),
							react.createElement("div", { className: "tokmn-sess-num", title: full(r.total) + " tokens" },
								fmtCn(r.total)),
							react.createElement("div", {
								className: "tokmn-sess-sub",
								title: "占" + (cwdRow ? "已归入目录的" : "窗口内全部会话") + " " + full(denom) + " tokens 的 " + fmtPct(pct)
									+ "；该" + (cwdRow ? "目录 " + (r.sessions || 0) + " 个会话" : "会话") + "共 " + (r.calls || 0) + " 轮"
									+ "，窗口内共 " + full(cwdRow ? (byCwd.callsAll || 0) : callsAll) + " 轮消息"
							}, fmtPct(pct) + " · " + (r.calls || 0) + " 轮"),
							react.createElement("div", { className: "tokmn-sess-spark" }, cells));
					}));

			return react.createElement("div", { className: "tokmn-sess" },
				react.createElement("div", { className: "tokmn-sec-head" },
					react.createElement("div", { className: "tokmn-sess-head-l" },
						react.createElement("span", { className: "tokmn-sec-title", style: { marginRight: 10 } }, "会话活跃分布"),
						react.createElement("span", {
							className: "tokmn-meta",
							title: cwdUnresolved > 0
								? cwdUnresolved + " 个会话的日志尚未解析出工作目录，未计入目录维度（首轮折叠完成后自动补齐）"
								: undefined
						},
							"近 " + windowDays + " 日 · 共 " + srcMatched + " 个" + (isCwd ? "工作目录" : "会话"))),
					react.createElement("div", { className: "tokmn-sess-ctl" },
						Seg({
							options: [{ value: "session", label: "按会话" }, { value: "cwd", label: "按工作目录" }],
							value: dim, onChange: setDim
						}),
						Seg({
							options: [{ value: "tokens", label: "按 Token" }, { value: "calls", label: "按轮消息" }],
							value: sortKey, onChange: setSortKey
						}),
						react.createElement("input", {
							className: "tokmn-input tokmn-sess-search", type: "text",
							value: query, placeholder: isCwd ? "搜索目录…" : "搜索会话…",
							"aria-label": isCwd ? "搜索工作目录" : "搜索会话",
							onChange: (e) => setQuery(e.target.value)
						}),
						react.createElement("select", {
							className: "tokmn-select", value: String(limit),
							"aria-label": "显示条数", title: "显示条数",
							onChange: (e) => setLimit(Number(e.target.value) || 10)
						}, [10, 20, 30, 50].map((n) =>
							react.createElement("option", { key: n, value: String(n) }, "Top " + n))))),
				list);
		}

		/** 全局用量统计浮窗（shell.overlay，root 作用域）：关闭态返回 null、
		    开启态渲染全帧背板 + 内容面板；开启期间才挂载数据轮询，关闭即停。
		    浮层自持 <style>（不依赖侧栏按钮的那份）——overlayLayer 与侧栏脚部
		    是两个独立挂载点，任一单独挂载时样式都必须成立。 */
		function GlobalUsageOverlay() {
			const open = useOverlayOpen();
			const [refreshing, setRefreshing] = react.useState(false);
			const [lastAt, setLastAt] = react.useState(null);
			react.useEffect(() => {
				if (!open) return undefined;
				const onKey = (e) => { if (e.key === "Escape") overlayStore.set(false); };
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [open]);
			// 头部「刷新」：立即重拉两个数据源。本地请求毫秒级、又叠 5s 自动轮询，
			// 不做强反馈用户感知不到"点了有反应"——故保证 ≥0.5s 旋转可见。
			// 「更新于」只在**成功**后推进（2026-09-23 复审 P3 修复）：原实现把
			// setLastAt 放在 finally，刷新失败也照改时间戳，等于谎称"刚更新过"，
			// 用户会以为屏上还是新数据。失败时宁可保留上一次成功的时刻。
			const doRefresh = () => {
				setRefreshing(true);
				const minSpin = new Promise((res) => window.setTimeout(res, 500));
				const fired = refreshBus.fire().then(() => true, () => false);
				Promise.all([fired, minSpin]).then(([ok]) => {
					if (ok) setLastAt(new Date());
					setRefreshing(false);
				});
			};
			if (!open) return null;
			return [
				react.createElement("style", { key: "css" }, CSS),
				react.createElement("div", {
					key: "backdrop",
					className: "tokmn-ov tokmn-ov-backdrop",
					onMouseDown: (e) => { if (e.target === e.currentTarget) overlayStore.set(false); }
				},
				react.createElement("div", { className: "tokmn-ov-panel", role: "dialog", "aria-modal": "true", "aria-label": "用量统计" },
					react.createElement("div", { className: "tokmn-ov-head" },
						react.createElement("h3", { className: "tokmn-ov-title" }, "用量统计"),
						react.createElement("span", { className: "tokmn-meta" }, "跨会话总量 · 与当前会话无关",
							lastAt ? " · 更新于 " + lastAt.toLocaleTimeString("zh-CN", { hour12: false }) : null),
						// 刷新钮紧贴关闭钮左侧、关闭钮仍居最右。注意 marginLeft:auto 必须
						// 挂在**刷新钮**上：挂在关闭钮上时，flex 把剩余空间加在关闭钮之前，
						// 刷新钮会连同标题一起留在左端、两者被隔开（用户实测反馈）。
						react.createElement("button", {
							type: "button", className: "tokmn-iconbtn", "aria-label": "刷新", title: "刷新",
							style: { marginLeft: "auto" },
							onClick: doRefresh
						},
							react.createElement("svg", {
								width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": "true",
								className: refreshing ? "tokmn-spin" : undefined
							},
								react.createElement("path", {
									d: "M10.5 3.5A5 5 0 1 1 3.5 3.5M4.2 4.9L3.5 3.3 2.8 4.9",
									fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round"
								}))),
						react.createElement("button", {
							type: "button", className: "tokmn-iconbtn", "aria-label": "关闭", title: "关闭（Esc）",
							onClick: () => overlayStore.set(false)
						},
							react.createElement("svg", { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": "true" },
								react.createElement("path", { d: "M3 3l8 8M11 3l-8 8", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" })))),
					react.createElement(GlobalStatsContent, null))) ];
		}

		/** 全局统计内容：总览六卡 → 热力图 → 使用趋势 → 使用分布（模型环形 +
		    会话活跃分布）→ 使用总量（今日 + 限额 + 重置）→ 口径脚注。
		    开启期间 /global 5 秒、/heatmap 60 秒轮询；组件卸载即全部停止。 */
		function GlobalStatsContent() {
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

			// 全局账本统计 5s 轮询（挂到 ref 供「重置账本」后立即刷新）。
			const loadGlobalRef = react.useRef(() => {});
			react.useEffect(() => {
				let alive = true;
				const load = () => fetchGlobal()
					.then((j) => { if (alive) { setData(j); setError(null); } })
					.catch((e) => { if (alive) setError(String(e && e.message || e)); });
				loadGlobalRef.current = load;
				load();
				const timer = window.setInterval(load, 5000);
				return () => { alive = false; window.clearInterval(timer); };
			}, []);

			// 热力图账单 60s 轮询（数据量随账本增长，不随主轮询刷）。
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

			// 头部「刷新」钮：立即重拉 /global 与 /heatmap，两个轮询周期都不等
			// （订阅随组件卸载自动取消）。
			react.useEffect(() => refreshBus.subscribe(() => {
				const g = loadGlobalRef.current();
				const h = loadHeatmapRef.current();
				return Promise.allSettled([g, h]);
			}), []);

			// 趋势图容器宽度（ResizeObserver，SVG 随浮窗伸缩）。
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
			const loadNow = () => fetchGlobal().then((j) => { setData(j); }).catch(() => {});

			const overview = data ? (data.stats || {}) : {};
			const today = (data && data.today) || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, total: 0, calls: 0 };
			const trend = (data && data.trend) || [];
			// 会话活跃分布（v0.5.0）：主机下发 Top 50 候选 + 窗口分母，排序 / 搜索 /
			// 条数切换全部在客户端这份集合上即时完成，不额外回主机取数。
			const sess = (data && data.sessions) || {};
			const sessRows = sess.rows || [];
			const sessDates = sess.dates || [];
			const sessWindowTotal = sess.totalAll || 0;
			const sessWindowCalls = sess.callsAll || 0;
			const sessMatched = typeof sess.matched === "number" ? sess.matched : sessRows.length;
			const sessWindowDays = sess.windowDays || sessDates.length || 30;
			// 第二维度：按工作目录聚合（同目录多会话叠加，才看得出项目的活跃形态）。
			const sessByCwd = sess.byCwd || {};
			const limit = data && data.config ? (data.config.dailyTokenLimit || null) : null;
			const since = (data && data.since) || null;

			// ---- 总览六卡 ----------------------------------------------------
			const stat6 = (value, label, sub) => react.createElement("div", { className: "tokmn-stat6", title: sub || label },
				react.createElement("div", { className: "tokmn-stat6-v" }, value),
				react.createElement("div", { className: "tokmn-stat6-l" }, label));

			// ---- 限额 --------------------------------------------------------
			const limitPct = limit ? Math.min(100, Math.round((today.total / limit) * 100)) : null;
			const limitLeft = limit ? Math.max(0, limit - today.total) : null;

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
				// 右边界按提示框上限留位（max-width 340 + padding 22 + 余量），而不是
				// 早先硬编码的 170 —— 后者是"内容最多 170px"的旧假设，现已不成立。
				const x = Math.max(0, Math.min(tr.left - cr.left + tr.width / 2 - 80, Math.max(0, cr.width - 366)));
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
			// 模式相关脚注：三种模式各自说明口径。每周=逐周柱、累计=单调爬坡柱，
			// 数据跨多周后柱形自然分化；单周数据期靠文案区分口径。
			let heatFootMain, heatFootSide;
			if (heatMode === "daily") {
				heatFootMain = "共 " + ((overview.activeDays) || 0) + " 个活跃日 —— 悬浮查看当日明细";
				heatFootSide = "颜色深浅 = 用量多少";
			} else if (heatMode === "weekly") {
				const pk = weekStats.reduce((a, w) => (w.total > a.total ? w : a), { total: 0, first: null, last: null });
				heatFootMain = pk.total > 0 && pk.first
					? "峰值周 " + fmtCn(pk.total) + " tokens（" + longDate(pk.first) + " ~ " + shortDate(pk.last) + "）"
					: "暂无整周用量";
				heatFootSide = "柱高 = 当周用量 · 悬浮查看整周明细";
			} else {
				const lastW = weekStats[weekStats.length - 1];
				heatFootMain = lastW && lastW.cum > 0
					? "累计 " + fmtCn(lastW.cum) + " tokens（截至 " + shortDate(lastW.last || lastW.first) + "）"
					: "暂无累计用量";
				heatFootSide = "柱高 = 逐周累计 · 悬浮查看各周累计";
			}
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
				// 每周/累计：变高柱（高度 ∝ 值，零周画 3px 空柱当基线），底部对齐。
				// 逐周模式各柱独立取当周总量；累计模式取逐周累加值（爬坡形态）。
				heatGrid = weeks.map((col, ci) => {
					const w = weekStats[ci];
					const v = heatMode === "weekly" ? w.total : w.cum;
					const lines = !w || !w.first
						? null
						: heatMode === "weekly"
							? [longDate(w.first) + " ~ " + shortDate(w.last), full(w.total) + " tokens · " + w.calls + " 轮消息"]
							: ["截至 " + longDate(w.last || w.first), "累计 " + full(w.cum) + " tokens"];
					return react.createElement("div", {
						key: "w" + ci, className: "tokmn-heat-cell",
						style: v > 0
							? { height: Math.max(6, Math.round((v / weekMax) * 100)) + "%", background: "var(--dsw-alias-brand-primary)", opacity: 0.9 }
							: { height: "3px", background: "var(--tokmn-cell-empty)" },
						onMouseEnter: lines ? (e) => showHeatTip(e, lines) : undefined,
						onMouseLeave: () => setHeatTip(null)
					});
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
						// 显示名：同名模型跨供应商时加 provider 前缀以便区分。`model` 单独留着，
						// 供 hover 提示给出**完整模型名** —— 窄列下 label 必然被截断
						// （deepseek-v4.1-flash-expires-on-0910），提示里只给 provider 等于没给。
						model: nm,
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
			// hover 明细只列当日**有量**的模型：这天没用到的模型列出来既占地，又会用
			// 长名字把提示框撑宽（v0.5.1 用户截图：8 行里 7 行是 0，数字还被裁掉）。
			const hoverRows = (hoverIdx !== null && hoverIdx >= 0 && hoverIdx < slice.length)
				? visibleModels
					.map((m) => ({ m, v: valMaps[hoverIdx][m.key] || 0 }))
					.filter((r) => r.v > 0)
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
				// 每个扇形带一份提示文案：环形图此前只有颜色、悬浮不出任何信息。
				return {
					color: m.color, dash, off,
					tip: m.model + " · " + fmtCn(m.total) + " tokens（" + fmtPct(frac) + "）"
				};
			});

			// 会话分布条按各会话自身峰值归一化（见 distCellStyle），无需全局满刻度。

			return react.createElement("div", { className: "tokmn-ov-body" },
				error ? react.createElement("p", { style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12 } }, "加载失败: " + error) : null,

				// 口径隔离标记（2026-09-26「统计要干净」）：账本按 profile 分区，本页只统计
				// 当前 profile 的消耗 —— 官方桌面端与自制壳 / 浏览器 GUI 各记各的账。
				// 分区后首次打开本来会是空的（没有历史可混），这行让"空"是预期而不是故障。
				react.createElement("p", { className: "tokmn-meta", style: { margin: "0 0 10px" } },
					"口径：本页只统计当前 profile" + (data && data.profile ? "（" + data.profile + "）" : "") +
					"的消耗 · 与其它 profile 的账本完全隔离"),

				// 总览六卡
				react.createElement("div", { className: "tokmn-stats6" },
					stat6(fmtCn(overview.totalTokens), "累计 Token 数", full(overview.totalTokens) + " tokens"),
					stat6(fmtCn(overview.peakDayTokens), "峰值 Token 数",
						"单日最高" + (overview.peakDayDate ? " · " + overview.peakDayDate : "")),
					stat6((overview.activeDays || 0) + " 天", "活跃天数", "有用量的日历日数"),
					stat6(fmtDuration(overview.longestSessionMs), "最长聊天时长", "单会话活跃跨度（账本）"),
					stat6(overview.currentStreakDays + " 天", "当前连续天数", "连续有用量的天数"),
					stat6(overview.longestStreakDays + " 天", "最长连续天数", "历史最长连续天数")),

				// Token 活动热力图
				react.createElement("div", { className: "tokmn-sec", ref: heatCardRef, style: { position: "relative" } },
					react.createElement("div", { className: "tokmn-sec-head" },
						react.createElement("div", null,
							react.createElement("span", { className: "tokmn-sec-title", style: { marginRight: 10 } }, "Token 活动"),
							react.createElement("span", { className: "tokmn-meta" },
								"自 " + ((heatDays && heatDays.length && heatDays[0].date) || since || "—") + " 起记录")),
						Seg({
							options: [{ value: "daily", label: "每日" }, { value: "weekly", label: "每周" }, { value: "cumulative", label: "累计" }],
							value: heatMode, onChange: setHeatMode
						})),
					react.createElement("div", { className: "tokmn-card" },
						react.createElement("div", { className: "tokmn-heat-scroll" },
							// max-content + 水平居中：52 周网格约 730px 宽，卡片全宽时
							// 左对齐会在右侧留一大块空白，居中后随面板对称。
							react.createElement("div", { style: { width: "max-content", margin: "0 auto" } },
								react.createElement("div", { className: "tokmn-heat" + (heatMode === "daily" ? "" : " tokmn-heat-weekly") }, heatGrid),
								react.createElement("div", { className: "tokmn-heat-months", style: { width: Math.max(1, weeks.length * 14 - 3) + "px" } },
									monthLabels.map((m) => react.createElement("span", {
										key: m.ci, className: "tokmn-heat-month", style: { left: (m.ci * 14) + "px" }
									}, m.label))))),
						react.createElement("div", { className: "tokmn-heat-foot" },
							react.createElement("span", { className: "tokmn-meta" }, heatFootMain),
							react.createElement("span", { className: "tokmn-meta" }, heatFootSide))),
					heatTip ? react.createElement("div", { className: "tokmn-tip", style: { left: heatTip.x, top: heatTip.y } },
						heatTip.lines.map((l, i) => react.createElement("div", { key: i, className: i === 0 ? "" : "tokmn-tip-sub" }, l))) : null),

				// 使用趋势
				react.createElement("div", { className: "tokmn-sec" },
					react.createElement("div", { className: "tokmn-sec-head" },
						react.createElement("div", { className: "tokmn-sec-title", style: { margin: 0 } }, "使用趋势"),
						Seg({
							options: [{ value: 7, label: "近 7 日" }, { value: 30, label: "近 30 日" }],
							value: range, onChange: setRange
						})),
					react.createElement("div", { className: "tokmn-card" },
						react.createElement("div", { className: "tokmn-sec-title" }, "每日 Token 趋势图"),
						// 图表容器无条件渲染：chartW 来自首挂时的 ResizeObserver 测量，
						// 若等数据到了才挂载容器，测量落空、宽度永远回退 640px（右侧留白）。
						react.createElement("div", { className: "tokmn-chart-wrap", ref: chartRef },
							models.length === 0
								? react.createElement("div", { className: "tokmn-empty" }, "暂无数据 —— 账本启用后的模型用量会按日绘制在这里。")
								: react.createElement("div", null,
								react.createElement("div", null,
									models.map((m) => react.createElement("span", {
										key: m.key,
										className: "tokmn-legend-chip" + (hiddenModels.has(m.key) ? " tokmn-legend-chip-off" : ""),
										onClick: () => toggleModel(m.key),
										title: m.model + " · " + m.provider + " · 点击显示/隐藏"
									},
										react.createElement("span", { className: "tokmn-dot", style: { background: m.color } }),
										m.label,
										react.createElement("span", { className: "tokmn-meta" }, fmtCn(m.total))))),
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
												// 右边界按提示框实际最大宽度（max-width 340 + 左右 padding 22）
												// 留位，而不是早先硬编码的 190 —— 后者对长模型名不够，
												// 提示框被面板裁掉、数字看不见。
												left: Math.max(0, Math.min(xAt(hoverIdx) + 12, chartWpx - 366)),
												top: PAD_T + 4
											}
										},
											react.createElement("div", null, longDate(parseKey(slice[hoverIdx].date)) + " · " + full(slice[hoverIdx].total) + " tokens"),
											hoverRows.map((r) => react.createElement("div", { key: r.m.key, className: "tokmn-tip-sub tokmn-tip-row" },
												react.createElement("span", { className: "tokmn-dot", style: { background: r.m.color } }),
												react.createElement("span", { className: "tokmn-tip-name" }, r.m.label),
												react.createElement("span", { className: "tokmn-mono tokmn-tip-val" }, fmtCn(r.v)))))
										: null)))),

					// 使用分布：模型环形图 + 会话活跃分布（逐日柱）
					// 注：「近 N 日」只作用于模型环形图（它按趋势窗口切片），故挂在
					// 模型卡标题旁 —— 挂在区域头部会被误读成整块（含会话分布，固定
					// 近 30 日）的口径。
					react.createElement("div", { className: "tokmn-sec" },
						react.createElement("div", { className: "tokmn-sec-head" },
							react.createElement("div", { className: "tokmn-sec-title", style: { margin: 0 } }, "使用分布")),
						react.createElement("div", { className: "tokmn-dist" },
							react.createElement("div", { className: "tokmn-card" },
								react.createElement("div", { className: "tokmn-sec-head", style: { margin: "0 0 10px" } },
									react.createElement("div", { className: "tokmn-sec-title", style: { margin: 0 } }, "模型用量"),
									react.createElement("span", { className: "tokmn-meta" }, "近 " + range + " 日")),
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
											},
												// SVG 原生提示（零 JS）：扇形 hover 给出模型名 / 用量 / 占比。
												react.createElement("title", null, s.tip))),
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
														react.createElement("div", {
									className: "tokmn-name tokmn-code",
									title: m.model + " · " + m.provider
								}, m.label),
														react.createElement("div", { className: "tokmn-meta", title: full(m.total) }, fmtCn(m.total) + " tokens")),
													react.createElement("span", { className: "tokmn-pct" }, fmtPct(frac)));
											})))),
							react.createElement("div", { className: "tokmn-card" },
								react.createElement(SessionActivityCard, {
									rows: sessRows, dates: sessDates, totalAll: sessWindowTotal,
									callsAll: sessWindowCalls, matched: sessMatched, windowDays: sessWindowDays,
									byCwd: sessByCwd
								})))),

					// 使用总量：今日 + 限额 + 重置
					react.createElement("div", { className: "tokmn-sec" },
						react.createElement("div", { className: "tokmn-sec-head" },
							react.createElement("div", { className: "tokmn-sec-title", style: { margin: 0 } }, "今日用量 · 全部会话"),
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

				react.createElement("p", { className: "tokmn-foot" },
					(data && data.note) ||
					"全局统计来自跨会话账本（usage-log.jsonl，保留 380 天），自插件首次部署起累计、跨 host 重启持久，部署前的历史会话不在其中；账本按 profile 分区 —— 本页只统计当前 profile 的消耗，官方桌面端与自制壳 / 浏览器 GUI 各记各的账；会话活跃分布基于账本 sessionId 按近 30 日聚合、逐日格点按各会话自身峰值分档，标题与工作目录由 sessionQuery 折叠会话日志得出（已归档会话同样可得，取不到时降级显示截断 ID）；占比分母为窗口内全部会话合计（含未列出的长尾会话）。日限额为本地自定义配置（DSH 无配额接口），同样按 profile 分区。"));
		}

		/**
		 * 会话「用量」Tab（v0.4.0 精简为纯会话视角）：上下文剩余 hero →
		 * 会话用量总览（官方口径 + 活跃时长）→ 按模型明细（仅本会话）→
		 * 工具调用 → 性能 → 口径脚注。跨会话统计已整体迁往侧栏「用量统计」浮窗。
		 */
		function TokenMonitorView(props) {
			const sessionId = props && props.sessionId;
			const [data, setData] = react.useState(null);
			const [error, setError] = react.useState(null);

			// 会话摘要（官方聚合 + 按会话过滤的实时明细）3s 轮询。
			react.useEffect(() => {
				let alive = true;
				const load = () => fetchSession(sessionId)
					.then((j) => { if (alive) { setData(j); setError(null); } })
					.catch((e) => { if (alive) setError(String(e && e.message || e)); });
				load();
				const timer = window.setInterval(load, 3000);
				return () => { alive = false; window.clearInterval(timer); };
			}, [sessionId]);

			const official = (data && data.official) || {};
			const tu = official.tokenUsage || {};
			const stats = official.sessionStats || {};
			const cp = official.contextPressure || {};
			const cb = official.contextBreakdown || {};
			const calls = (data && data.live && data.live.calls) || [];
			const tools = (data && data.live && data.live.tools) || [];
			const activeSpan = (data && data.live && data.live.activeSpan) || null;
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

			const tuTotal = (tu.uncachedInputTokens || 0) + (tu.outputTokens || 0) + (tu.cacheReadTokens || 0) + (tu.cacheWriteTokens || 0);
			const maxCall = Math.max(1, ...calls.map((c) => c.total || 0));
			const decodeSpeed = (typeof stats.decodeMs === "number" && stats.decodeMs > 0 && typeof stats.decodeTokens === "number")
				? (stats.decodeTokens / (stats.decodeMs / 1000)).toFixed(1) + " tok/s" : "—";
			const activeMs = activeSpan ? Math.max(0, (activeSpan.last || 0) - (activeSpan.first || 0)) : null;

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
					react.createElement("h3", { style: { margin: 0, fontSize: 16, color: "var(--dsw-alias-label-primary)" } }, "Token 用量 · 当前会话"),
					react.createElement("span", { className: "tokmn-stat-sub" },
						sampledAt ? "更新于 " + new Date(sampledAt).toLocaleTimeString("zh-CN", { hour12: false }) + " · 每 3 秒" : "每 3 秒自动刷新")),
				error ? react.createElement("p", { style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12 } }, "加载失败: " + error) : null,

				heroBlock,

				// 会话用量总览（官方口径 + 活跃时长）
				react.createElement("div", { className: "tokmn-grid" },
					stat("累计 Tokens（官方）", fmt(tuTotal),
						"未缓存输入 " + fmt(tu.uncachedInputTokens) + " · 输出 " + fmt(tu.outputTokens)
						+ (official.meter && typeof official.meter.totalTokens === "number" ? " · 计量 " + fmtCn(official.meter.totalTokens) : "")),
					stat("模型输出", fmt(tu.outputTokens), "解码 " + fmt(stats.decodeTokens) + " tok"),
					stat("缓存读取 / 写入", fmt(tu.cacheReadTokens) + " / " + fmt(tu.cacheWriteTokens), "上下文复用与持久化"),
					stat("轮次 / 步数", fmt(stats.turns) + " / " + fmt(stats.steps), "本会话对话轮次与执行步数"),
					stat("会话活跃时长", fmtDuration(activeMs), activeSpan
						? "本进程内首次至最近一次活动"
						: "暂无本进程活动记录")),

				react.createElement("div", { className: "tokmn-sec" },
					react.createElement("div", { className: "tokmn-sec-title" }, "按模型明细 · 实时采集（仅本会话）"),
					react.createElement("div", { className: "tokmn-card" },
						calls.length === 0
							? react.createElement("div", { className: "tokmn-empty" }, "暂无数据 —— 本会话在本进程内发起的模型调用会显示在这里。")
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
					react.createElement("div", { className: "tokmn-sec-title" }, "工具调用 · 实时采集（仅本会话）"),
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
					(data && data.note) ||
					"官方聚合由会话日志投影、覆盖本会话全程（含插件启用前历史、跨重启），与「轨迹」页同源；按模型明细、工具计数与会话活跃时长由本插件实时采集、仅统计本进程启动之后的本会话。本页不含任何跨会话累计 —— 全局总量统计请见左侧边栏「用量统计」。")
			);
		}

		/**
		 * Client plugin body: 会话「用量」Tab + 侧栏脚部「用量统计」入口 +
		 * 全局用量统计浮窗（三个槽位条目共用同一插件与账本）。
		 */
		function apply(ctx) {
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "token-monitor",
				order: 15,
				label: "用量"
			}, TokenMonitorView));
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "usage-stats"
			}, UsageStatsButton));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "usage-stats-overlay"
			}, GlobalUsageOverlay));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
