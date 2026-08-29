window.__ModuleLoader__.load({
	id: "dsh-pet-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		/** Required services: the slot registry is the only hard dependency. */
		const inject = ["slots"];

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
		 * Client plugin body: register the settings section.
		 */
		function apply(ctx) {
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
