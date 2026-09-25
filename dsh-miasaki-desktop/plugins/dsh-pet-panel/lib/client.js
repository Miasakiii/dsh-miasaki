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
					setNote(next ? "已发送「隐藏」命令…（主题头像悬浮球可点击恢复）" : "已发送「显示」命令…");
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
						hidden ? "桌宠当前为隐藏状态（主题头像悬浮球可点击恢复）" : "桌宠当前为显示状态")),
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
		 * 桌宠六态上报（官方契约通道；M2 于 2026-09-12 落地，R0 于 2026-09-16 改为跨会话聚合）：
		 * 读官方 ClientSessions（`list.ids`/`byId` 的 SessionSnapshot：running/lastAgentError）
		 * 与 UiSession.pendingInteractions（审批等待），合成六态
		 * idle/thinking/waiting/error/done 写 window.__miasakiPetPanel；
		 * 由桌面端注入运行时（themes/src/02-core.js syncHash）合并进 URL hash
		 * （pet=/pettool=/petts=）——hash 单写者仍是注入运行时，本插件不直接写 hash。
		 * 心跳 1.5s；官方通道 5s 无心跳时注入运行时自动回落 DOM 扫描兜底。
		 * 会话口径（R0 起）：**跨会话聚合**——审批遍历全部会话的 `pendingInteractions`，
		 * 运行态「任一（非子代理）会话 running = 忙」（旧实现只读 `list.current`，会漏报
		 * 后台会话的待审批、且先完成的会话会把仍在干活的顶成 idle）；subagent 会话仍不入选。
		 * 安全：只读官方快照，绝不调用 answer()（决策权归 M3 且仅在用户显式点击时）。
		 */
		/**
		 * R0-① 跨会话读待审批（2026-09-16，design/pet-reference-benchmark.md R0）：
		 * `pendingInteractions` 本身就是 `ReadonlyMap<SessionId, PendingApproval>`，直接遍历即可——
		 * 旧实现只读 `list.current`，用户切走会话后别的会话的待审批**完全不可见**，
		 * 而「快捷提权」的价值前提正是「不用切窗口」。
		 * R0-② 身份透出：除 toolName 外带出 sessionId 与 reason（截断），供 M3 决策链路使用。
		 * R0-③ 身份门禁：拿不到任何稳定身份的审批**一律不显示**（宁可不报，
		 * 也不挂一个永远等不到 resolved 的常驻态——参考实现在此处踩过坑）。
		 */
		function readPendingApproval(ctx) {
			try {
				const pi = ctx.uiSession && ctx.uiSession.pendingInteractions;
				if (!pi) return null;
				let snap = null;
				if (typeof pi.get === "function") snap = pi.get();
				else if (typeof pi.getSnapshot === "function") snap = pi.getSnapshot();
				if (!snap) return null;
				let found = null;
				const consider = (key, it) => {
					if (found !== null || !it || it.kind !== "approval") return;
					const fromItem = it.sessionId === undefined || it.sessionId === null ? "" : String(it.sessionId);
					const fromKey = key === undefined || key === null ? "" : String(key);
					const sessionId = fromItem || fromKey;
					// R5：官方不透明身份（PendingApproval.key）——决策链路的幂等键与按 id 移除的依据
					const identity = it.key === undefined || it.key === null ? "" : String(it.key);
					if (sessionId === "" && identity === "") return; // R0-③ 身份门禁
					found = {
						tool: String(it.toolName || ""),
						sessionId: sessionId,
						key: identity || sessionId,
						reason: String(it.reason || "").slice(0, APPROVAL_REASON_MAX),
					};
				};
				if (typeof snap.forEach === "function") snap.forEach((v, k) => consider(k, v));
				else if (typeof snap.entries === "function") { for (const pair of snap.entries()) consider(pair[0], pair[1]); }
				return found;
			} catch (e) { return null; /* 官方 API 缺失 → 注入运行时 DOM 兜底 */ }
		}

		/**
		 * R0-① 跨会话聚合运行态：任一（非子代理）会话 `running` 即视为「忙」。
		 * 旧实现只读 `list.current`——先完成的会话会把仍在干活的会话顶成 idle（参考实现同款教训）。
		 * `lastAgentError` 只对 materialize 过的会话可读（`sessions.get()` 可能返回 null），
		 * 故按「当前会话优先 + 探测上限」读取。
		 */
		function readRunningAggregate(ctx) {
			let running = false;
			let agentError = null;
			try {
				const ls = ctx.sessions.list.getSnapshot();
				const ids = Array.isArray(ls.ids) ? ls.ids : [];
				const byId = ls.byId || {};
				for (const id of ids) {
					const row = byId[id];
					if (!row) continue;
					// M2.3 会话口径：subagent 会话不计入主态
					if (row.projectionValues && row.projectionValues.subagent) continue;
					if (row.running) running = true;
				}
				const probe = [];
				if (ls.current !== undefined && ls.current !== null) probe.push(ls.current);
				for (const id of ids) {
					if (probe.length >= ERROR_PROBE_MAX) break;
					if (id !== ls.current) probe.push(id);
				}
				if (typeof ctx.sessions.get === "function") {
					for (const id of probe) {
						try {
							const f = ctx.sessions.get(id);
							const s = f && typeof f.getSnapshot === "function" ? f.getSnapshot() : null;
							if (s && s.lastAgentError) { agentError = s.lastAgentError; break; }
						} catch (e2) { /* 未 materialize → 无 error 信号 */ }
					}
				}
			} catch (e) { /* ignore */ }
			return { running: running, agentError: agentError };
		}

		const PET_PANEL_KEY = "__miasakiPetPanel";
		const PET_HB_MS = 1500;
		const DONE_HOLD_MS = 10000; // done 庆祝期：气泡常驻 10s 后回 idle（roadmap M2.1）
		/** R0：reason 截断长度（对齐参考实现 agent_link.py 的 160 字符口径） */
		const APPROVAL_REASON_MAX = 160;
		/** R0：lastAgentError 探测的会话上限（避免每心跳遍历过多会话） */
		const ERROR_PROBE_MAX = 6;
		const petPanel = { ts: 0, state: "idle", tool: "", sessionId: "", reason: "", key: "" };
		window[PET_PANEL_KEY] = petPanel;

		function startPetStateReporter(ctx) {
			let lastRunning = false;
			let doneHoldUntil = 0;
			const tick = () => {
				// —— 审批等待（优先级最高）：跨会话遍历 pendingInteractions（R0）——
				const approval = readPendingApproval(ctx);
				// —— 运行状态：跨会话聚合（R0；list row 自带 running，探针实证 2026-09-12）——
				const agg = readRunningAggregate(ctx);
				// —— 六态合成：waiting > error > done(边沿,10s) > thinking > idle ——
				const now = Date.now();
				let state;
				if (approval !== null) state = "waiting";
				else if (agg.agentError) state = "error";
				else if (lastRunning && !agg.running && now >= doneHoldUntil) { state = "done"; doneHoldUntil = now + DONE_HOLD_MS; }
				else if (now < doneHoldUntil && !agg.running) state = "done";
				else if (agg.running) state = "thinking";
				else state = "idle";
				if (agg.running) doneHoldUntil = 0;
				lastRunning = agg.running;
				petPanel.ts = now;
				petPanel.state = state;
				// R0：审批身份随态透出（非审批态清空）；sessionId/reason 供 M3 决策链路使用
				petPanel.tool = approval === null ? "" : approval.tool;
				petPanel.sessionId = approval === null ? "" : approval.sessionId;
				petPanel.reason = approval === null ? "" : approval.reason;
				// R5：稳定身份（官方 key）——Rust 侧据此挂可交互审批气泡并幂等移除
				petPanel.key = approval === null ? "" : approval.key;
			};
			tick();
			return setInterval(tick, PET_HB_MS);
		}

		/**
		 * R5（2026-09-16，design/pet-reference-benchmark.md R5）：桌宠内联审批的**唯一回写点**。
		 *
		 * 链路：用户点击桌宠审批气泡的「拒绝 / 允许一次」→ Rust 记 seq 并经
		 * `wv.eval` 派发 CustomEvent `miasaki-approval-decision`（detail: {key, decision, seq}）
		 * → 本函数调用官方 `PendingApproval.answer(decision)`。
		 * 桌宠侧不持有任何 DSH API，插件侧不做任何自主决策。
		 *
		 * 红线（与 pet-v3-roadmap.md M3.2 / 对标 R5 一致）：
		 * ① **协议收窄**：只接受 `allowed-once` / `rejected` 两个枚举，其余一律忽略；
		 * ② **幂等/防重放**：按 seq 去重（用集合而非单调比较——壳重启后 seq 会从头计）；
		 * ③ **先本地收起、再异步确认**：await `answer()`，失败**不假装成功**
		 *    （写 `decisionError` 供面板/日志；桌面端另有 3s stale 回落提示）；
		 * ④ **只在事件到来时决策**——本插件没有任何定时器或自动决策路径。
		 */
		const DECISION_ENUM = { "allowed-once": true, rejected: true };
		const seenDecisionSeq = new Set();
		function handleApprovalDecision(ctx, detail) {
			try {
				if (!detail || typeof detail !== "object") return;
				const decision = String(detail.decision || "");
				if (DECISION_ENUM[decision] !== true) return; // ① 协议收窄
				const key = String(detail.key || "");
				if (key === "") return;
				const seq = Number(detail.seq || 0);
				if (seenDecisionSeq.has(seq)) return; // ② 防重放
				seenDecisionSeq.add(seq);
				if (seenDecisionSeq.size > 64) { // 有界：避免长会话下无限增长
					seenDecisionSeq.clear();
					seenDecisionSeq.add(seq);
				}
				// 在跨会话 map 中找匹配的待审批项（key 为官方不透明身份）
				let target = null;
				try {
					const pi = ctx.uiSession && ctx.uiSession.pendingInteractions;
					let snap = null;
					if (pi) {
						if (typeof pi.get === "function") snap = pi.get();
						else if (typeof pi.getSnapshot === "function") snap = pi.getSnapshot();
					}
					if (snap && typeof snap.forEach === "function") {
						snap.forEach((it) => {
							if (target !== null || !it || it.kind !== "approval") return;
							const ik = it.key === undefined || it.key === null ? "" : String(it.key);
							if (ik === key) target = it;
						});
					}
				} catch (e) { /* ignore */ }
				if (target === null) return; // 已被处理/已 resolved/身份不匹配 → 不动作
				if (typeof target.answer !== "function") {
					petPanel.decisionError = "官方 answer() 不可用";
					return;
				}
				// ③ 先本地收起（乐观），再异步确认；失败如实记录，不假装成功
				petPanel.decisionError = "";
				Promise.resolve()
					.then(() => target.answer(decision))
					.then(() => {
						petPanel.lastDecision = { key: key, decision: decision, ts: Date.now(), ok: true };
					})
					.catch((e) => {
						petPanel.lastDecision = { key: key, decision: decision, ts: Date.now(), ok: false };
						petPanel.decisionError = (e && e.message) ? String(e.message) : "answer() 调用失败";
					});
			} catch (e) { /* 决策链路异常绝不阻断插件 */ }
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
			// R5:桌宠内联审批的决策回写（Rust eval 派发 → 官方 answer()）
			ctx.effect(() => {
				const onDecision = (e) => handleApprovalDecision(ctx, e && e.detail);
				window.addEventListener("miasaki-approval-decision", onDecision);
				return () => window.removeEventListener("miasaki-approval-decision", onDecision);
			}, "dsh-pet-panel: approval decision wiring");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
