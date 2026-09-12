window.__ModuleLoader__.load({
	id: "dsh-pet-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		/** Required services: slots + 会话双通道。uiSession（审批等待）/ sessions（运行状态）
		 *  均受 cordis inject 白名单保护——未声明的属性访问直接抛错（探针实证 2026-09-12）。 */
		const inject = ["slots", "remote.session", "workspaces", "sessions", "uiSession"];

		//#region hash 命令通道
		/**
		 * 向 Miasaki 桌面端发送桌宠命令：写主窗口 URL hash（history.replaceState，
		 * 不触发刷新）。Rust 侧 start_hash_watchdog 33ms 轮询解析 cmd/seq 并执行。
		 * 保留现有 miasaki-theme/int/diag 参数（主题联动 + 诊断位），仅追加/覆盖 cmd 与 seq。
		 */
		function sendPetCmd(cmd) {
			try {
				const h = window.location.hash || "";
				const params = new URLSearchParams(h.replace(/^#/, ""));
				params.set("cmd", cmd);
				params.set("seq", String(Date.now()));
				if (history.replaceState) {
					history.replaceState(null, "", "#" + params.toString());
					return true;
				}
				return false;
			} catch (e) {
				return false;
			}
		}
		//#endregion

		/**
		 * 桌宠设置面板：显示/隐藏开关、位置重置。
		 * 状态由桌面端经 'miasaki-pet-state' CustomEvent 回推（Rust eval），
		 * 非桌面端（无 Miasaki 注入运行时）显示降级提示。
		 */
		function PetPanel() {
			const [hidden, setHidden] = react.useState(false);
			const [note, setNote] = react.useState(null);
			const [err, setErr] = react.useState(null);

			const isDesktop = typeof window.__MIASAKI_BOOTED__ === "boolean" && window.__MIASAKI_BOOTED__;

			react.useEffect(() => {
				const onState = (e) => {
					try {
						const d = e && e.detail;
						if (d && typeof d.hidden === "boolean") setHidden(d.hidden);
					} catch (e2) { /* ignore */ }
				};
				window.addEventListener("miasaki-pet-state", onState);
				// 挂载即请求一次当前状态（桌面端收到 cmd=pet-state 后 eval 回推）
				sendPetCmd("pet-state");
				return () => window.removeEventListener("miasaki-pet-state", onState);
			}, []);

			const onToggle = () => {
				if (!isDesktop) {
					setErr("当前页面未运行在 Miasaki 桌面端，命令不会生效。");
					return;
				}
				const next = !hidden;
				setHidden(next); // 乐观更新，真实状态以桌面端回推为准
				const ok = sendPetCmd(next ? "pet-hide" : "pet-show");
				if (ok) {
					setNote(next ? "已发送「隐藏」命令…（右下角圆点可点击恢复）" : "已发送「显示」命令…");
					setErr(null);
				} else {
					setErr("命令发送失败。");
				}
			};

			const onReset = () => {
				if (!isDesktop) {
					setErr("当前页面未运行在 Miasaki 桌面端，命令不会生效。");
					return;
				}
				const ok = sendPetCmd("pet-reset");
				if (ok) {
					setNote("已发送「位置重置」命令…（桌宠将回到默认位置 " + "1200,500" + "）");
					setErr(null);
				} else {
					setErr("命令发送失败。");
				}
			};

			const rowStyle = { display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border-color, rgba(128,128,128,.25))" };
			const dim = { color: "var(--text-color-secondary, #888)", fontSize: 12 };

			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10, maxWidth: 800 } },
				react.createElement("p", { style: { margin: 0, fontSize: 13 } },
					"Miasaki 桌面端的原生透明置顶桌宠，角色随主题：原版 → 鲸鱼娘 / 刻刻帝 → 狂三 / 狂狂帝 → 反转狂三。支持拖动、单击（跳跃 + 气泡）、双击（挥手）、右键菜单。"),
				!isDesktop ? react.createElement("div", { style: { border: "1px solid rgba(200,120,60,.5)", borderRadius: 6, padding: "8px 10px", fontSize: 12, color: "#c85" } },
					"当前页面未检测到 Miasaki 桌面端注入（window.__MIASAKI_BOOTED__），以下命令不会生效。请通过 Miasaki 桌面端打开 DSH。") : null,
				react.createElement("div", { style: rowStyle },
					react.createElement("label", { style: { display: "flex", gap: 8, alignItems: "center", cursor: "pointer", fontSize: 13.5 } },
						react.createElement("input", { type: "checkbox", checked: !hidden, onChange: onToggle, disabled: !isDesktop }),
						hidden ? "桌宠当前为隐藏状态（右下角圆点可点击恢复）" : "桌宠当前为显示状态")),
				react.createElement("div", { style: rowStyle },
					react.createElement("button", { onClick: onReset, disabled: !isDesktop }, "重置位置"),
					react.createElement("span", { style: dim }, "桌宠跑到屏幕外 / 更换显示器后丢失时，一键回到默认位置 (1200, 500)。也可直接拖动桌宠到任意位置，位置自动记忆。")),
				note ? react.createElement("div", { style: { color: "var(--text-color-secondary, #6c6)", fontSize: 12 } }, note) : null,
				err ? react.createElement("div", { style: { color: "#f66", fontSize: 12 } }, err) : null,
			);
		}

		/**
		 * 人格会话联动（2026-09-06 由桌面端注入运行时迁入本插件）：
		 * 桌面端注入层切换主题时派发 'miasaki-persona-request' CustomEvent
		 * （detail.theme），本插件用官方客户端 ctx.remote.session.create 建立
		 * 对应桌宠 Agent 预设的新会话——不走 fetch('/api/*')（0.1.2-rc.1 起
		 * HTTP RPC 路由已移除，改 WebSocket mux），版本自适应；每主题仅创建
		 * 一次（localStorage 'miasaki.petSessions' 去重，与旧键兼容）。
		 */
		const PERSONA_MAP = { pure: "whale", zafkiel: "kurumi", kurkuriel: "inverse" };
		const PERSONA_NAMES = { pure: "鲸鱼娘", zafkiel: "狂三", kurkuriel: "反转狂三" };
		const PERSONA_KEY = "miasaki.petSessions";
		const personaStore = { get: () => { try { const m = JSON.parse(localStorage.getItem(PERSONA_KEY) || "{}"); return m && typeof m === "object" ? m : {} } catch (e) { return {} } }, set: (m) => { try { localStorage.setItem(PERSONA_KEY, JSON.stringify(m)) } catch (e) { /* ignore */ } } };
		let personaToastTimer = null;
		function personaToast(msg) {
			try {
				let el = document.getElementById("miasaki-persona-toast");
				if (el === null) {
					el = document.createElement("div");
					el.id = "miasaki-persona-toast";
					el.style.cssText = "position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483646;" +
						"background:var(--dsw-alias-bg-overlay,#1e1a27);color:var(--dsw-alias-label-primary,#e8e2d8);" +
						"border:1px solid var(--dsw-alias-border-l2,rgba(217,179,106,.55));border-radius:10px;" +
						"padding:8px 14px;font:12.5px/1.5 'Segoe UI',system-ui,sans-serif;" +
						"box-shadow:0 4px 18px rgba(0,0,0,.35);max-width:76vw;text-align:center;pointer-events:none;opacity:0;transition:opacity .25s ease";
					document.body.appendChild(el);
				}
				el.textContent = msg;
				el.style.opacity = "1";
				if (personaToastTimer) clearTimeout(personaToastTimer);
				personaToastTimer = setTimeout(() => { el.style.opacity = "0" }, 3600);
			} catch (e) { /* ignore */ }
		}
		function ensurePersonaSession(ctx, theme) {
			const preset = PERSONA_MAP[theme];
			if (preset === undefined) return;
			const m = personaStore.get();
			if (m[theme]) {
				personaToast("「" + PERSONA_NAMES[theme] + "」人格会话已建立，可在会话列表中选择");
				return;
			}
			// 优先挂到当前工作区（workspaces.list 第一个），避免新会话落到 Host 默认目录
			let workspaceId;
			try {
				const snapshot = ctx.workspaces.list.getSnapshot();
				const items = snapshot?.items ?? [];
				workspaceId = items.length > 0 ? items[0].workspaceId : undefined;
			} catch (e) { /* 让 create 用默认 cwd */ }
			ctx.remote.session.create({ agentPreset: preset, ...(workspaceId === undefined ? {} : { workspaceId }) })
				.then((result) => {
					if (result.ok) {
						m[theme] = result.value.sessionId;
						personaStore.set(m);
						personaToast("已创建「" + PERSONA_NAMES[theme] + "」人格会话，可在会话列表打开");
					} else {
						const err = result.error ?? {};
						personaToast("人格会话创建失败:" + (err.message ?? err.code ?? "unknown"));
					}
				})
				.catch((e) => {
					personaToast("人格会话创建失败:" + ((e && e.message) ? e.message : "网络错误"));
				});
		}

		/**
		 * M2 桌宠六态上报（官方契约通道，2026-09-12，pet-v3-roadmap.md M2）：
		 * 读官方 ClientSessions（当前选中会话的 SessionSnapshot：running/lastAgentError）
		 * 与 UiSession.pendingInteractions（审批等待），合成六态
		 * idle/thinking/waiting/error/done 写 window.__miasakiPetPanel；
		 * 由桌面端注入运行时（themes/src/02-core.js syncHash）合并进 URL hash
		 * （pet=/pettool=/petts=）——hash 单写者仍是注入运行时，本插件不直接写 hash。
		 * 心跳 1.5s；官方通道 5s 无心跳时注入运行时自动回落 DOM 扫描兜底。
		 * M2.3 会话口径：只读 list.current（当前选中会话），subagent 会话不入选。
		 * 安全：只读官方快照，绝不调用 answer()（决策权归 M3 且仅在用户显式点击时）。
		 */
		const PET_PANEL_KEY = "__miasakiPetPanel";
		const PET_HB_MS = 1500;
		const DONE_HOLD_MS = 10000; // done 庆祝期：气泡常驻 10s 后回 idle（roadmap M2.1）
		const petPanel = { ts: 0, state: "idle", tool: "" };
		window[PET_PANEL_KEY] = petPanel;

		function startPetStateReporter(ctx) {
			let lastRunning = false;
			let doneHoldUntil = 0;
			const tick = () => {
				// —— 审批等待（优先级最高）：pendingInteractions 中的 approval 项 ——
				let approvalTool = null;
				try {
					const pi = ctx.uiSession && ctx.uiSession.pendingInteractions;
					if (pi) {
						let snap = null;
						if (typeof pi.get === "function") snap = pi.get();
						else if (typeof pi.getSnapshot === "function") snap = pi.getSnapshot();
						if (snap && typeof snap.values === "function") {
							for (const it of snap.values()) {
								if (it && it.kind === "approval") { approvalTool = it.toolName || ""; break; }
							}
						}
					}
				} catch (e) { /* 官方 API 缺失 → 注入运行时 DOM 兜底 */ }
				// —— 运行状态：当前选中会话（list row 自带 running;探针实证 2026-09-12）——
				// sessions.get() 仅对 materialize 过的会话返回 SessionFace,依赖它会漏报;
				// lastAgentError 只在 materialized Session 上有,尽力读、读不到则不报 error 态。
				let running = false;
				let agentError = null;
				try {
					const ls = ctx.sessions.list.getSnapshot();
					const id = ls.current;
					const row = id !== undefined ? ls.byId[id] : null;
					if (row) {
						// M2.3 会话口径:subagent 会话不计入主态
						const isSubagent = !!(row.projectionValues && row.projectionValues.subagent);
						if (!isSubagent) {
							running = !!row.running;
							try {
								if (typeof ctx.sessions.get === "function") {
									const f = ctx.sessions.get(id);
									const s = f && typeof f.getSnapshot === "function" ? f.getSnapshot() : null;
									if (s) agentError = s.lastAgentError ?? null;
								}
							} catch (e2) { /* 未 materialize → 无 error 信号 */ }
						}
					}
				} catch (e) { /* ignore */ }
				// —— 六态合成：waiting > error > done(边沿,10s) > thinking > idle ——
				const now = Date.now();
				let state;
				if (approvalTool !== null) state = "waiting";
				else if (agentError) state = "error";
				else if (lastRunning && !running && now >= doneHoldUntil) { state = "done"; doneHoldUntil = now + DONE_HOLD_MS; }
				else if (now < doneHoldUntil && !running) state = "done";
				else if (running) state = "thinking";
				else state = "idle";
				if (running) doneHoldUntil = 0;
				lastRunning = running;
				petPanel.ts = now;
				petPanel.state = state;
				petPanel.tool = approvalTool ?? "";
			};
			tick();
			return setInterval(tick, PET_HB_MS);
		}

		/**
		 * Client plugin body: register the settings section.
		 */
		function apply(ctx) {
			ctx.effect(() => {
				const onPersona = (e) => {
					try { ensurePersonaSession(ctx, e?.detail?.theme) } catch (e2) { /* 联动失败不阻断 */ }
				};
				window.addEventListener("miasaki-persona-request", onPersona);
				return () => window.removeEventListener("miasaki-persona-request", onPersona);
			}, "dsh-pet-panel: persona-session wiring");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "pet-panel",
				order: 26,
				label: "桌宠",
			}, PetPanel));
			// M2:官方契约六态上报（心跳 interval 由 cordis effect 生命周期管理）
			ctx.effect(() => {
				const timer = startPetStateReporter(ctx);
				return () => clearInterval(timer);
			}, "dsh-pet-panel: pet state reporter");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
