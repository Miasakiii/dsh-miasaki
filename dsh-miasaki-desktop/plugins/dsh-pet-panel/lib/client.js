window.__ModuleLoader__.load({
	id: "dsh-pet-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		/**
		 * 官方 UI 原语 —— 与「通用设置」页**同源**（前端壳 staticModules 的 seed 模块）。
		 * 交互控件一律复用官方 primitives，不自己造：自造控件是这个面板先前「与其它设置页不像」
		 * 的根因（裸 div + 内联样式，字号/行距/边距都跟官方对不上）。
		 *
		 * 名字必须与 dsh-web-frontend 的 seed 导出表**逐字一致**（2026-09-23 事故教训）。
		 * 取不到时降级为原生元素并**留痕**——面板是设置入口，不能因为原语缺席就整页白屏。
		 */
		let primitives = null;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (e) {
			console.warn("[dsh-pet-panel] 官方 UI 原语不可用，降级为原生控件", e);
		}
		const PRIM = primitives || {};
		const Switch = typeof PRIM.Switch === "function" ? PRIM.Switch : null;
		const SegmentedControl = typeof PRIM.SegmentedControl === "function" ? PRIM.SegmentedControl : null;
		const Button = typeof PRIM.Button === "function" ? PRIM.Button : null;

		/**
		 * 面板样式 —— **逐条对照官方「通用设置」页**（与 `dsh-miasaki-appearance` 同一套规格，
		 * 两线代码零耦合、各带一份 CSS，但类名与取值刻意保持一致：视觉上必须是同一个设置页家族）。
		 *
		 * 关键取值出处（照 `dsh-miasaki-appearance/client.js` 的 PANEL_CSS 头部注释）：
		 *   行 = FontSizeRow.row（0.5px 分隔线 + 16px 行距）；标题/说明 = row.title / row.desc；
		 *   数值 = FontSizeRow.stepper（悬停露出上下箭头）；单选 = 官方 SegmentedControl。
		 * token 全部走 `--dsw-*` 官方变量 ⇒ 跟着皮肤与明暗自动解析，不需要我们维护配色。
		 */
		const PANEL_CSS = `
.mia-panel{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;display:flex}
.mia-group{flex-direction:column;display:flex}
.mia-group + .mia-group{margin-top:24px}
.mia-groupTitle{color:var(--dsw-alias-label-primary);margin:0;padding:0 0 4px;font-size:14px;font-weight:500;line-height:22px}
.mia-row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}
.mia-group>.mia-row:last-child{border-bottom:none}
.mia-rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}
.mia-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.mia-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}
.mia-control{align-items:center;gap:8px;display:inline-flex}
.mia-unit{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}
.mia-stepper{background:var(--dsw-alias-bg-module-platform);border-radius:18px;justify-content:center;align-items:center;min-width:72px;height:36px;display:inline-flex;position:relative}
.mia-value{text-align:center;font-variant-numeric:tabular-nums;min-width:18px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.mia-arrows{opacity:0;flex-direction:column;gap:2px;display:flex;position:absolute;right:8px}
.mia-stepper:hover .mia-arrows,.mia-stepper:focus-within .mia-arrows{opacity:1}
.mia-arrow{background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 75%, transparent);width:17px;height:12px;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:3px;justify-content:center;align-items:center;padding:0;display:inline-flex}
.mia-arrow:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}
.mia-arrow:disabled{color:var(--dsw-alias-label-caption);cursor:default}
.mia-notice{color:var(--dsw-alias-state-warn-label);margin:0;padding:0 0 12px;font-size:12px;line-height:18px}
.mia-error{color:var(--dsw-alias-state-error-primary);margin:0;padding:0 0 12px;font-size:12px;line-height:18px}
.mia-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
.mia-runinfo{color:var(--dsw-alias-label-tertiary);margin:24px 0 0;font-size:12px;line-height:18px}
`
		const PANEL_CSS_ID = "dsh-pet-panel/panel.css"
		// 与官方 client 插件同一注入式（factory 体内、按 data-plugin-css 去重）：
		// 样式随模块物化进入 head，HMR 重挂时查询去重不重复注入。
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${PANEL_CSS_ID}"]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-pet-panel";
			tag.dataset.pluginCss = PANEL_CSS_ID;
			tag.textContent = PANEL_CSS;
			(document.head || document.documentElement).appendChild(tag);
		}

		/** 分组：组标题（官方组标题规格 14px/22/500）+ 组内行。 */
		function group(title, children) {
			return react.createElement("div", { key: `g-${title}`, className: "mia-group" }, [
				react.createElement("div", { key: "t", className: "mia-groupTitle" }, title),
				...children,
			]);
		}

		/** 设置行：左标题 + 说明，右控件（官方 FontSizeRow.row 规格）。 */
		function row(title, desc, control) {
			return react.createElement("div", { key: `r-${title}`, className: "mia-row" }, [
				react.createElement("div", { key: "l", className: "mia-rowText" }, [
					react.createElement("div", { key: "t", className: "mia-title" }, title),
					desc === undefined || desc === null ? null : react.createElement("div", { key: "d", className: "mia-desc" }, desc),
				]),
				react.createElement("div", { key: "c", className: "mia-control" }, control),
			]);
		}

		/**
		 * 数值步进器（官方 FontSizeRow.stepper 规格：悬停/聚焦才露出上下箭头）。
		 * @param value 当前值（用于边界判断）
		 * @param display 显示文本（已带单位换算，如 `1.2×`）
		 * @param onStep 收到 +step / -step
		 */
		function stepper(value, display, onStep, opts) {
			const o = opts || {};
			const atMax = o.max !== undefined && value >= o.max;
			const atMin = o.min !== undefined && value <= o.min;
			return react.createElement("div", { className: "mia-stepper" }, [
				react.createElement("span", { key: "v", className: "mia-value" }, display),
				react.createElement("div", { key: "a", className: "mia-arrows" }, [
					react.createElement("button", {
						key: "up", type: "button", className: "mia-arrow", "aria-label": "增加",
						disabled: o.disabled === true || atMax,
						onClick: () => onStep(o.step || 1),
					}, "\u25B2"),
					react.createElement("button", {
						key: "dn", type: "button", className: "mia-arrow", "aria-label": "减少",
						disabled: o.disabled === true || atMin,
						onClick: () => onStep(-(o.step || 1)),
					}, "\u25BC"),
				]),
			]);
		}

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

		/** 六态的显示名 + 说明（`idle` 不列入：关掉它等于桌宠永不动，那不是设置项）。 */
		const PET_STATE_LABELS = [
			["thinking", "思考中", "有会话正在跑时。"],
			["waiting", "等待审批", "优先级最高，会立刻切过去。"],
			["error", "出错了", "某条会话以错误收尾时。"],
			["done", "完成了", "一轮正常结束，庆祝 10 秒。"],
		];

		/**
		 * 壳侧设置的默认值 —— **必须与 Rust `PetSettings::default()` 一致**
		 * （`pet_native/settings.rs`；改一处就要同改两处，否则面板初次打开显示的
		 * 值会和壳里的真实值不一样，用户一改反而把真实值覆盖成"面板以为的默认"）。
		 * 这只是**回推到达之前**的占位；`pet-state` 一到就被真实值替换。
		 */
		const SHELL_SETTINGS_DEFAULTS = { motion: 1.0, bubbleMs: 3000, alpha: 100, pet: "", through: "auto", tray: "dot" };
		const PET_CHOICES = [["", "跟随主题"], ["whale", "鲸鱼娘"], ["kurumi", "狂三"], ["inverse", "反转狂三"]];
		const THROUGH_CHOICES = [["auto", "自动（透明处点得到下层）"], ["always", "总是可点（不穿透）"]];
		const TRAY_CHOICES = [["dot", "头像悬浮球"], ["tray", "只留托盘"], ["both", "两者都要"]];

		/**
		 * 桌宠设置面板。
		 *
		 * 分三块（2026-09-29 从「只有两个控件」扩起）：
		 *   ① 显示与位置 —— 走 hash `cmd`，由 Rust 侧执行，状态经 `miasaki-pet-state` 回推
		 *   ② 状态呈现   —— **纯客户端**，存 localStorage（六态里哪些要显示）
		 *   ③ 主题联动   —— **纯客户端**，存 localStorage
		 * ② ③ 与「壳侧绘制参数」（大小 / 透明度 / 穿透 / 动效 / 气泡…）**刻意分开**：
		 * 后者要改 Rust 并重编 exe，不在本批范围内（见设计记录）。
		 */
		function PetPanel() {
			const [hidden, setHidden] = react.useState(false);
			const [note, setNote] = react.useState(null);
			const [err, setErr] = react.useState(null);
			// ② ③ 的初值取持久值；`panelSettings`（模块级）是心跳真正读的那份，改设置要同步它。
			const [settings, setSettings] = react.useState(() => readPanelSettings());
			// 壳侧六项：初值是占位默认，`pet-state` 一到就被真实值替换（见 SHELL_SETTINGS_DEFAULTS）。
			const [shell, setShell] = react.useState(SHELL_SETTINGS_DEFAULTS);

			const isDesktop = typeof window.__MIASAKI_BOOTED__ === "boolean" && window.__MIASAKI_BOOTED__;

			react.useEffect(() => {
				const onState = (e) => {
					try {
						const d = e && e.detail;
						if (d && typeof d.hidden === "boolean") setHidden(d.hidden);
						// 壳侧设置回推（`push_pet_state` 里拼的 detail.settings）。
						// 合并而非替换：壳将来新增字段时，旧面板不会把它们变成 undefined。
						if (d && d.settings && typeof d.settings === "object") {
							const next = { ...SHELL_SETTINGS_DEFAULTS, ...d.settings };
							setShell(next);
							shellSettings = next;
							publishPanelSettings();
						}
					} catch (e2) { /* ignore */ }
				};
				window.addEventListener("miasaki-pet-state", onState);
				// 挂载即请求一次当前状态（桌面端收到 cmd=pet-state 后 eval 回推）
				sendPetCmd("pet-state");
				return () => window.removeEventListener("miasaki-pet-state", onState);
			}, []);

			/**
			 * 改一项**壳侧**设置：本地立即反映 + 挂到上报对象（`syncHash` 拼 `ps*` 传给壳）。
			 * 不回存 localStorage —— 权威在 Rust 的 `pet-settings.json`，两边都存会漂移。
			 * 若壳不在场（浏览器里打开），改动只停在本地，非桌面端横幅已经说明了这一点。
			 */
			const applyShell = (patch) => {
				const next = { ...shell, ...patch };
				setShell(next);
				shellSettings = next;
				publishPanelSettings();
			};

			/** 改一项客户端设置：立即生效 + 落盘；写盘失败**如实说**，不假装保存成功。 */
			const applySettings = (next) => {
				setSettings(next);
				panelSettings = next; // 心跳读它
				publishPanelSettings(); // 上报对象也要更新（六态/主题走这条）
				if (!writePanelSettings(next)) {
					setErr("设置已生效，但**没能保存**（浏览器私密模式？）—— 下次打开会回到默认。");
				} else {
					setErr(null);
				}
			};
			const toggleState = (key) => {
				applySettings({ ...settings, states: { ...settings.states, [key]: settings.states[key] === false } });
			};

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

			// —— 与「通用设置」页同一套排版：分组 + 行（左标题/说明，右控件）——
			// 控件优先用官方原语；原语缺席时降级为原生元素（`primitives` 缺席已在模块顶部留痕）。
			const switchCtl = (checked, onChange, label, disabled) => Switch
				? react.createElement(Switch, { checked, onChange, label, disabled: disabled === true })
				: react.createElement("input", {
					type: "checkbox", checked: checked, disabled: disabled === true, "aria-label": label,
					onChange: () => onChange(!checked),
				});
			const segmentCtl = (id, value, choices, onChange, label, disabled) => SegmentedControl
				? react.createElement(SegmentedControl, {
					id: id, value: value, label: label, disabled: disabled === true,
					options: choices.map(c => ({ value: c[0], label: c[1] })),
					onChange: onChange,
				})
				: react.createElement("select", {
					value: value, "aria-label": label, disabled: disabled === true,
					onChange: ev => onChange(ev.target.value),
				}, choices.map(c => react.createElement("option", { key: c[0], value: c[0] }, c[1])));
			const buttonCtl = (text, onClick, disabled) => Button
				? react.createElement(Button, { onClick: onClick, disabled: disabled === true }, text)
				: react.createElement("button", { type: "button", onClick: onClick, disabled: disabled === true }, text);

			return react.createElement("div", { className: "mia-panel" }, [
				react.createElement("p", { key: "lead", className: "mia-hint", style: { paddingBottom: 16 } },
					"原生透明置顶桌宠。支持拖动、单击（跳跃 + 气泡）、双击（挥手）、右键菜单。"),

				isDesktop ? null : react.createElement("p", { key: "warn", className: "mia-notice" },
					"当前页面未检测到 Miasaki 桌面端注入，「显示与位置」下的命令不会生效；其余设置仍可改，会在桌面端生效。"),

				// ① 显示与位置（走 hash cmd → Rust；隐藏后由悬浮球或托盘找回）
				group("显示与位置", [
					row("显示桌宠", hidden ? "当前为隐藏状态" : "当前为显示状态（拖动可换位置）",
						switchCtl(!hidden, () => onToggle(), "显示桌宠", !isDesktop)),
					row("重置位置", "跑到屏幕外 / 更换显示器后丢失时，回到默认位置（1200, 500）。也可直接拖动，位置自动记忆，跨分辨率按比例还原。",
						buttonCtl("重置位置", onReset, !isDesktop)),
				]),

				// ② 外观与行为（壳侧设置：经 hash `ps*` 传给 Rust，权威在 pet-settings.json）
				group("外观与行为", [
					row("动效强度", "呼吸 / 摇摆 / 挤压三条动效的统一幅度。",
						stepper(shell.motion, Number(shell.motion).toFixed(1) + "×",
							d => applyShell({ motion: Math.round((Number(shell.motion) + d) * 10) / 10 }),
							{ step: 0.1, min: 0.5, max: 1.6, disabled: !isDesktop })),
					row("气泡时长", "台词气泡的驻留时间。",
						stepper(shell.bubbleMs, (Number(shell.bubbleMs) / 1000).toFixed(1) + " 秒",
							d => applyShell({ bubbleMs: Math.min(10000, Math.max(1000, Number(shell.bubbleMs) + d)) }),
							{ step: 500, min: 1000, max: 10000, disabled: !isDesktop })),
					row("不透明度", "整只桌宠的不透明度。",
						stepper(shell.alpha, shell.alpha + "%",
							d => applyShell({ alpha: Number(shell.alpha) + d }),
							{ step: 5, min: 30, max: 100, disabled: !isDesktop })),
					row("宠物角色", "钉死某只后，切主题只换配色、不换角色。",
						segmentCtl("pet-role", shell.pet, PET_CHOICES, v => applyShell({ pet: v }), "宠物角色", !isDesktop)),
					row("鼠标穿透", "自动档下，透明像素处不挡住下层窗口的点击。",
						segmentCtl("pet-through", shell.through, THROUGH_CHOICES, v => applyShell({ through: v }), "鼠标穿透", !isDesktop)),
					row("隐藏后", "桌宠隐藏后从哪里找回来。",
						segmentCtl("pet-tray", shell.tray, TRAY_CHOICES, v => applyShell({ tray: v }), "隐藏后", !isDesktop)),
				]),

				// ③ 状态呈现（纯客户端，localStorage）
				group("状态呈现", [
					...PET_STATE_LABELS.map(([key, label, desc]) => row(label, desc,
						switchCtl(settings.states[key] !== false, () => toggleState(key), label, false))),
					react.createElement("p", { key: "hint", className: "mia-hint", style: { paddingTop: 8 } },
						"关掉某个状态只是不显示它（桌宠停在待机），不影响 DSH 本身的运行与心跳。"),
				]),

				// ④ 主题联动（纯客户端，localStorage）
				group("主题联动", [
					row("跟随主题切换角色",
						"关掉后不再随主题换角色、也不再创建人格会话。已经建好的会话不会删除（那是你的资产，删了不可逆）。",
						switchCtl(settings.followTheme !== false,
							() => applySettings({ ...settings, followTheme: settings.followTheme === false }),
							"跟随主题切换角色", false)),
				]),

				note ? react.createElement("p", { key: "note", className: "mia-notice", style: { paddingTop: 12 } }, note) : null,
				err ? react.createElement("p", { key: "err", className: "mia-error", style: { paddingTop: 12 } }, err) : null,
			]);
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
			// 关掉「跟随主题」后不再建人格会话、也不随主题换角色。
			// 注意这里**只切断创建路径**：已经建过的会话不删（那是用户资产，删了不可逆）。
			if (!panelSettings.followTheme) return;
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

		/**
		 * 面板自管设置（**纯客户端**，localStorage，零 Rust 改动、不需要重编 exe）。
		 *
		 * 与「壳侧绘制参数」（大小 / 透明度 / 穿透 / 动效 / 气泡…）**刻意分开存**：
		 * 后者是 `pet-settings.json` + Rust 的事，改一次要重编；这里两项只影响
		 * 本插件自己的产物（六态呈现与主题联动），放这里代价最低。
		 *
		 * 读取**只在 apply 时发生一次**（结果缓存在 `panelSettings`），因为
		 * `startPetStateReporter` 每 1.5s 心跳一次——把读盘/解析放进心跳会白烧 CPU，
		 * 也会让下面的告警刷屏。
		 */
		const PANEL_SETTINGS_KEY = "miasaki.petPanel.settings.v1";
		const PANEL_SETTINGS_DEFAULTS = {
			/** 六态里哪些要呈现。`idle` 恒开（关掉它等于桌宠永不动，不是设置项而是 bug）。 */
			states: { thinking: true, waiting: true, error: true, done: true },
			/** 关掉后不响应 `miasaki-persona-request`：不建人格会话、不随主题换角色。 */
			followTheme: true,
		};
		function readPanelSettings() {
			try {
				const raw = localStorage.getItem(PANEL_SETTINGS_KEY);
				if (!raw) return PANEL_SETTINGS_DEFAULTS;
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object") {
					// 留痕：形状不对就回默认，但不静默——否则「设置莫名被重置」查不出原因。
					console.warn("[dsh-pet-panel] 面板设置形状不合法，回默认值");
					return PANEL_SETTINGS_DEFAULTS;
				}
				// **逐字段合并**：坏一个字段不该把整份设置废掉（旧版本缺字段是常态）。
				const s = parsed.states && typeof parsed.states === "object" ? parsed.states : {};
				return {
					states: {
						thinking: s.thinking !== false,
						waiting: s.waiting !== false,
						error: s.error !== false,
						done: s.done !== false,
					},
					followTheme: parsed.followTheme !== false,
				};
			} catch (e) {
				// 留痕：私密模式（localStorage 抛错）或坏 JSON ⇒ 全默认。
				console.warn("[dsh-pet-panel] 面板设置读取失败，回默认值", e);
				return PANEL_SETTINGS_DEFAULTS;
			}
		}
		function writePanelSettings(next) {
			try {
				localStorage.setItem(PANEL_SETTINGS_KEY, JSON.stringify(next));
				return true;
			} catch (e) {
				console.warn("[dsh-pet-panel] 面板设置写入失败（私密模式？）", e);
				return false;
			}
		}
		/** 当前生效的面板设置（apply 时初始化；面板改动后就地更新）。 */
		let panelSettings = PANEL_SETTINGS_DEFAULTS;
		/** 读取时重置为持久值（apply 调用；也供测试注入）。 */
		function reloadPanelSettings() { panelSettings = readPanelSettings(); return panelSettings; }

		const petPanel = { ts: 0, state: "idle", tool: "", sessionId: "", reason: "", key: "" };
		window[PET_PANEL_KEY] = petPanel;
		// 把设置挂到上报对象上：`themes/src/02-core.js` 的 `syncHash` 是 hash 的**唯一写者**，
		// 它从这里读 `settings` 并拼成 `ps*` 字段 ⇒ 面板改动能传到 Rust 侧。
		// 本插件**不自己写 hash**（那是 P4 修复定下的单写者纪律）。
		//
		// **两套设置的权威来源不同**，合并后才上报：
		//   · 客户端两项（states / followTheme）—— 权威在 localStorage（`panelSettings`）；
		//   · 壳侧六项（motion / bubbleMs / alpha / pet / through / tray）—— 权威在 Rust 的
		//     `pet-settings.json`，面板经 `pet-state` 回推拿到（`shellSettings`），
		//     **本插件不回存**（两边都存会漂移，而壳是真正生效的那一边）。
		petPanel.settings = null;
		let shellSettings = null;
		/** 把当前设置同步到上报对象（apply 时 + 任一侧改动后调用）。 */
		function publishPanelSettings() {
			if (window[PET_PANEL_KEY]) {
				window[PET_PANEL_KEY].settings = {
					...(shellSettings || {}),
					states: panelSettings.states,
					followTheme: panelSettings.followTheme,
				};
			}
		}

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
				// 用户关掉的态**不呈现**（对外降级为 idle），但**内部状态机照常推进**：
				//   · 过滤放在最后一步 —— `lastRunning` / `doneHoldUntil` 已在上面更新完毕，
				//     重新打开某个态时不会卡在旧值上；
				//   · `petPanel.rawState` 保留真态，面板据此显示「当前真态 X（被你隐藏）」；
				//   · 心跳**照常发** —— 否则注入运行时 5s 判官方通道静默、回落 DOM 兜底扫描，
				//     那是功能回归，不是「少显示一个态」。
				petPanel.rawState = state;
				petPanel.state = state === "idle" || panelSettings.states[state] !== false ? state : "idle";
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
			// 客户端设置（六态开关 / 主题跟随）在 apply 时读一次并缓存到 `panelSettings`：
			// 心跳每 1.5s tick 一次，把读盘 + JSON 解析放进 tick 既费 CPU，又会让
			// `readPanelSettings` 里的告警刷屏（那是给「真的坏了」用的，不是常态噪声）。
			// 同时把设置挂到上报对象上，供 `syncHash` 拼 `ps*` 字段传给壳。
			reloadPanelSettings();
			publishPanelSettings();
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
