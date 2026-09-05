window.__ModuleLoader__.load({
	id: "dsh-pet-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		/** Required services: the slot registry is the only hard dependency. */
		const inject = ["slots", "remote.session", "workspaces"];

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
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
