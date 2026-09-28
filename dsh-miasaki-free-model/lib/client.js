window.__ModuleLoader__.load({
	id: "@miasaki/dsh-free-model",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		/**
		 * Client half — 多来源免费模型的统一页 + 模型页就地入口。
		 *
		 * 只注册**一处**：`settings.section`（id `free-model`）—— 三区：免 Key 车道
		 * （来源 A，经官方 llm 契约枚举）/ 本机自配平台（来源 B）/ 决策摘要，且**条件注册**
		 * （上游插件在场就让位，见 apply 内的注释）。
		 *
		 * ⚠️ **不要往 `settings.models.*` 下注册任何东西**：
		 * M2 曾在 `settings.models.provider-card`（keyed，key = provider 的 `settingsNs`）
		 * 挂过一个"就地扫描"入口。**那个槽在编辑态也会被 dispatch**（官方三处 `renderSlot`，
		 * 其中一处就在 `renderProviderEditor` 旁边，与 occupant 同在一个 children 数组里）
		 * —— 于是我们的 occupant 会跟着进编辑面板，而那条路径上任何一次渲染异常都会让
		 * **整棵 React 树卸载成白屏**（`data-slot-error` 兜底挡不住整树卸载）。
		 * 这是**风险论证，不是事故归因**：2026-09-28 那次「点编辑就白屏」复盘后确认真凶是
		 * 另一个包上的运行时补丁（见 `design/CHANGELOG.md` 续六），与本线无关；但边界本身
		 * 站得住 —— 那个入口本来也不是用户要的（用户要的是"一个设置页"）。
		 * **模型页是官方的地盘，本线不碰它**；
		 * `test/client-bundle.test.js` 有一条闸门钉住这件事（apply 注册的槽名里不得出现它）。
		 *
		 * 样式全部走官方主题令牌（`--dsw-alias-*`），不写死色值 —— 否则换主题时这一块
		 * 会是页面上唯一不跟着变的地方。手写 bundle、无 JSX、无构建步骤。
		 */
		const inject = ["slots"];

		//#region 基建
		/** One JSON call against the host-side route. */
		async function api(method, path, body) {
			const res = await fetch(path, {
				method,
				headers: body === undefined ? {} : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const payload = await res.json();
			if (!payload.ok) throw new Error(payload.error || "请求失败");
			return payload;
		}

		/** 官方主题令牌（只列本面板用到的；清单来自 client/Theme.listTokens 实测）。 */
		const T = {
			text: "var(--dsw-alias-label-primary)",
			dim: "var(--dsw-alias-label-secondary)",
			border: "var(--dsw-alias-border-l1)",
			border2: "var(--dsw-alias-border-l2)",
			layer1: "var(--dsw-alias-bg-layer-1)",
			layer2: "var(--dsw-alias-bg-layer-2)",
			ok: "var(--dsw-alias-state-success-primary)",
			warn: "var(--dsw-alias-state-warn-primary)",
			err: "var(--dsw-alias-state-error-primary)",
		};

		const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12 };
		const dim = { color: T.dim, fontSize: 12 };
		const row = { display: "flex", gap: 10, alignItems: "baseline", padding: "7px 0", borderBottom: `1px solid ${T.border}` };
		const card = { border: `1px solid ${T.border2}`, borderRadius: 10, background: T.layer2, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 };
		const button = { font: "inherit", fontSize: 12, padding: "5px 12px", borderRadius: 9, border: `1px solid ${T.border2}`, background: T.layer1, color: T.text, cursor: "pointer" };
		const select = { font: "inherit", fontSize: 12, padding: "5px 9px", borderRadius: 9, border: `1px solid ${T.border2}`, background: T.layer1, color: T.text, minWidth: 0, width: "100%" };
		const tag = (text, tone) => react.createElement("span", {
			key: `${tone}:${text}`,
			style: {
				padding: "1px 7px", borderRadius: 999, fontSize: 11, whiteSpace: "nowrap",
				border: `1px solid ${T.border}`,
				color: tone === "bad" ? T.warn : tone === "ok" ? T.ok : T.dim,
			},
		}, text);

		/** 一区的标题 + 说明。 */
		function Section(props) {
			return react.createElement("section", { style: { display: "flex", flexDirection: "column", gap: 10 } },
				react.createElement("header", { style: { display: "flex", flexDirection: "column", gap: 3 } },
					react.createElement("strong", { style: { fontSize: 14, color: T.text } }, props.title),
					props.hint ? react.createElement("span", { style: dim }, props.hint) : null),
				props.children);
		}
		//#endregion

		//#region 模型卡（两个来源共用）
		/**
		 * 一张模型卡。来源 A / B 的条目形状已经对齐（id / name / provider /
		 * contextWindow / maxTokens / freeReason / profile），所以这里不分支 ——
		 * 差异只在右侧那个动作按钮。
		 */
		function ModelRow(props) {
			const m = props.model;
			const p = m.profile || {};
			const chips = [];
			for (const s of p.strengths || []) chips.push(tag(s, "ok"));
			for (const w of p.warnings || []) chips.push(tag(w, "bad"));
			return react.createElement("div", { style: row },
				react.createElement("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 3 } },
					react.createElement("span", { style: mono }, m.id),
					react.createElement("span", { style: dim }, `${m.providerName || m.provider || "—"} · ${p.verdict || ""}`),
					react.createElement("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" } }, chips)),
				react.createElement("span", { style: dim }, `ctx=${m.contextWindow == null ? "?" : m.contextWindow}`),
				react.createElement("span", { style: dim }, `max=${m.maxTokens == null ? "?" : m.maxTokens}`),
				props.action === undefined ? null : props.action(m));
		}
		//#endregion

		//#region 统一页
		/** 设置 → 免费模型。三区：免 Key 车道 / 本机自配平台 / 决策摘要。 */
		function FreeModelPage() {
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [notice, setNotice] = react.useState(null);
			const [scan, setScan] = react.useState(null);
			const [platforms, setPlatforms] = react.useState([]);
			const [selected, setSelected] = react.useState("");
			const [detected, setDetected] = react.useState(null);
			const [presetState, setPresetState] = react.useState(null);
			// 实测能力来自可选的独立插件（dsh-model-probe）：缺席就整块隐藏「实测」按钮，
			// 而不是给用户一个点了报 404 的按钮。
			const [probeAvailable, setProbeAvailable] = react.useState(false);
			const [probes, setProbes] = react.useState({});

			/** 一并拉平台清单与多来源扫描（扫描在后端逐来源隔离，不会整体失败）。 */
			const refresh = async (options) => {
				setError(null);
				try {
					const status = await api("GET", "/freemodel-api/status");
					const list = status.platforms || [];
					setPlatforms(list);
					setSelected((cur) => (cur && list.some((p) => p.id === cur) ? cur : (list[0] ? list[0].id : "")));
				} catch (e) {
					setError(String(e && e.message ? e.message : e));
				}
				try {
					const reply = await api("POST", "/freemodel-api/scan", options && options.refresh === true ? { refresh: true } : {});
					setScan(reply);
				} catch (e) {
					setError(String(e && e.message ? e.message : e));
				}
			};

			react.useEffect(() => { refresh(); }, []);

			react.useEffect(() => {
				let alive = true;
				// 裸 fetch 而不是 api()：探测端点缺席时回的是 404，而 api() 要求信封 ok。
				fetch("/model-probe-api/health")
					.then((res) => { if (alive) setProbeAvailable(res.ok === true) })
					.catch(() => { if (alive) setProbeAvailable(false) });
				return () => { alive = false };
			}, []);

			const run = async (fn) => {
				setBusy(true); setError(null); setNotice(null);
				try { await fn() } catch (e) { setError(String(e && e.message ? e.message : e)) } finally { setBusy(false) }
			};

			const current = platforms.find((p) => p.id === selected) || null;
			const lanes = (scan && scan.models) || [];
			const detectedModels = (detected && detected.models) || [];
			const summary = (detected && detected.summary) || (scan && scan.summary) || null;
			const partial = (scan && scan.partial) || [];
			const sources = (scan && scan.sources) || [];

			const detect = () => {
				if (!selected) { setError("请先选择平台"); return }
				return run(async () => { setDetected(await api("POST", "/freemodel-api/detect", { platform: selected })) });
			};
			const applyAll = () => {
				if (!selected) { setError("请先选择平台"); return }
				return run(async () => {
					const r = await api("POST", "/freemodel-api/apply", { platform: selected });
					await refresh();
					setNotice(`已写入 ${r.written} 个免费模型（${r.platform}）`);
				});
			};
			const applyOne = (platformId, modelId) => run(async () => {
				const r = await api("POST", "/freemodel-api/apply", { platform: platformId, ids: [modelId] });
				await refresh();
				setNotice(`已写入 1 个模型：${modelId}`);
			});
			const setSubagent = (modelId) => {
				if (!selected) { setError("请先选择平台"); return }
				return run(async () => {
					const r = await api("POST", "/freemodel-api/subagent", { provider: selected, model: modelId, maxTokens: 32768 });
					setPresetState(r);
					setNotice(`子代理后端已切换为 ${r.provider} / ${r.model}（预设：${r.updated.join("、")}），新会话生效`);
				});
			};

			/** 实测一个模型：走 dsh-model-probe 的两段式探测（零 token 握手 + 1 token 生成）。 */
			const probeModel = (m) => run(async () => {
				const reply = await api("POST", "/model-probe-api/probe", { provider: m.provider, model: m.id });
				const result = reply.result || {};
				const key = `${m.provider}/${m.id}`;
				const text = result.ok === true
					? `可用${result.kind ? `（${result.kind}）` : ""}${Number.isFinite(result.ms) ? ` · ${result.ms}ms` : ""}`
					: `不可用：${result.kind || "unknown"}`;
				setProbes((cur) => ({ ...cur, [key]: text }));
			});

			/** 设为默认模型：官方 `agentDefaultModel` 写路径，下一次会话立即生效。 */
			const setDefaultModel = (m) => run(async () => {
				const reply = await api("POST", "/freemodel-api/default-model", { provider: m.provider, model: m.id });
				setNotice(`默认模型已设为 ${reply.provider} / ${reply.model}（官方写路径，下一次会话生效）`);
			});

			/**
			 * 模型卡右侧的动作组。两个来源共用：
			 * 「实测」只在 model-probe 在场时出现；「写入」只对可写来源出现
			 * （免 Key 车道不可写入 —— 它靠上游指纹计额度，写进 llm-pi-ai 也拿不到免费额度）。
			 */
			const actions = (m) => {
				const probe = probes[`${m.provider}/${m.id}`];
				return react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
					m.source === "adapter" ? tag("免 Key 车道", "plain") : null,
					probeAvailable ? react.createElement("button", { style: button, disabled: busy, onClick: () => probeModel(m) }, "实测") : null,
					react.createElement("button", { style: button, disabled: busy, onClick: () => setDefaultModel(m) }, "设为默认"),
					m.writable === true ? react.createElement("button", { style: button, disabled: busy, onClick: () => applyOne(m.provider, m.id) }, "写入") : null,
					probe ? react.createElement("span", { style: dim }, probe) : null);
			};

			const platformOptions = platforms.map((p) => react.createElement("option", { key: p.id, value: p.id },
				`${p.displayName}（${p.id} · 已配置 ${p.configuredCount} · ${p.endpoint}）`));

			const laneRows = lanes.map((m) => react.createElement(ModelRow, {
				key: `lane:${m.provider}:${m.id}`,
				model: m,
				action: actions,
			}));

			const detectedRows = detectedModels.map((m) => react.createElement(ModelRow, {
				key: `det:${m.id}`,
				model: m,
				action: actions,
			}));

			const sourceRows = sources.map((s) => react.createElement("div", { key: `src:${s.kind}:${s.id}`, style: row },
				react.createElement("span", { style: { flex: 1, ...mono } }, s.id),
				react.createElement("span", { style: dim }, s.kind),
				react.createElement("span", { style: dim }, s.freeLane === true ? "免 Key 车道" : ""),
				react.createElement("span", { style: dim }, `模型 ${s.modelCount == null ? "—" : s.modelCount}`),
				react.createElement("span", { style: dim }, `免费 ${s.freeCount == null ? "—" : s.freeCount}`),
				s.error ? tag(s.error, "bad") : null));

			const summaryBlock = summary ? react.createElement("div", { style: card },
				react.createElement("div", { style: { fontSize: 13, color: T.text } },
					`免费模型 ${summary.total} 个，其中子代理可用（工具调用完整）${summary.agentCount} 个，仅问答/批处理 ${summary.qaOnly} 个。`),
				summary.bestAgent ? react.createElement("div", { style: { fontSize: 13, color: T.text } },
					"最佳子代理：", react.createElement("code", { style: mono }, summary.bestAgent.id), " — ", summary.bestAgent.verdict) : null,
				summary.codingAgent ? react.createElement("div", { style: { fontSize: 13, color: T.text } }, "编码类：", react.createElement("code", { style: mono }, summary.codingAgent)) : null,
				summary.longContextAgent ? react.createElement("div", { style: { fontSize: 13, color: T.text } }, "超长上下文：", react.createElement("code", { style: mono }, summary.longContextAgent)) : null,
				summary.visionAgent ? react.createElement("div", { style: { fontSize: 13, color: T.text } }, "多模态：", react.createElement("code", { style: mono }, summary.visionAgent)) : null) : null;

			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 18, maxWidth: 860 } },
				react.createElement("p", { style: { margin: 0, fontSize: 13, color: T.text } },
					"本机免费模型的两个来源收在这一页：① 免 Key 车道（本机已注册的 provider 路由，经官方 llm 契约枚举 —— 不需要配置、也不用凭据）② 本机自配平台（llm-pi-ai.providers 里带 baseURL 的 OpenAI 兼容平台）。两者共用同一套能力画像与判定口径；来源 ① 不可写入配置（免 Key 车道靠上游指纹计额度，普通 provider 接入拿不到）。"),
				react.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
					react.createElement("button", { style: button, disabled: busy, onClick: () => run(async () => { await refresh({ refresh: true }); setNotice("已重新扫描全部来源") }) },
						busy ? "处理中…" : "重新扫描"),
					react.createElement("button", { style: button, disabled: busy, onClick: () => run(() => refresh()) }, "刷新平台")),
				error ? react.createElement("div", { style: { color: T.err, fontSize: 12 } }, error) : null,
				notice ? react.createElement("div", { style: { color: T.ok, fontSize: 12 } }, notice) : null,
				partial.length > 0 ? react.createElement("div", { style: { color: T.warn, fontSize: 12 } },
					`部分来源未能扫描：${partial.map((p) => `${p.source}（${p.error}）`).join("；")}`) : null,

				react.createElement(Section, {
					title: `① 免 Key 车道（${laneRows.length}）`,
					hint: "本机已注册的 provider 路由里判定为免费的模型；能力来自适配器自述，工具参数未声明的会明确标出",
				}, laneRows.length > 0 ? react.createElement("div", {}, laneRows)
					: react.createElement("div", { style: dim }, (scan && scan.adapterAvailable === false)
						? "本 composition 没有可用的 llm 服务，来源 ① 不可用。"
						: "暂无：本机没有判定为免 Key 车道的来源。")),

				react.createElement(Section, {
					title: "② 本机自配平台",
					hint: "扫描 llm-pi-ai.providers 中带 baseURL 的平台；新增平台只需在「设置 → 模型」页配置，这里自动出现",
				},
				react.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
					react.createElement("select", {
						style: { ...select, minWidth: 320 },
						disabled: busy,
						value: selected,
						onChange: (e) => { setSelected(e.target.value); setDetected(null) },
					}, platformOptions.length > 0 ? platformOptions : react.createElement("option", { value: "" }, "（无可用平台）")),
					react.createElement("button", { style: button, disabled: busy || !selected, onClick: detect }, "检测免费模型"),
					react.createElement("button", { style: button, disabled: busy || !selected || detectedModels.length === 0, onClick: applyAll }, "写入全部检测结果")),
				detectedModels.length > 0 ? react.createElement("div", {}, detectedRows) : null,
				current && current.configured.length > 0 ? react.createElement("div", {},
					react.createElement("div", { style: { ...dim, paddingTop: 4 } }, `当前已配置（${current.configured.length}）`),
					current.configured.map((c) => react.createElement("div", { key: `cfg:${c.id}`, style: { ...mono, ...dim, padding: "2px 0" } }, c.id))) : null,
				detectedModels.length > 0 ? react.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", paddingTop: 6 } },
					react.createElement("select", { id: "freemodel-subagent-select", style: { ...select, minWidth: 300 }, disabled: busy, defaultValue: "" },
						[react.createElement("option", { key: "_", value: "", disabled: true }, "选择子代理默认模型…"),
							...detectedModels.map((m) => react.createElement("option", { key: m.id, value: m.id },
								`${m.id}${m.profile && m.profile.canAgent ? "（子代理可用）" : "（未判定）"}`))]),
					react.createElement("button", {
						style: button,
						disabled: busy,
						onClick: () => {
							const el = document.getElementById("freemodel-subagent-select");
							if (el && el.value) setSubagent(el.value);
						},
					}, "设为子代理后端")) : null,
				presetState ? react.createElement("div", { style: dim }, `最近一次切换：${presetState.provider} / ${presetState.model}（${presetState.updated.join("、")}）`) : null),

				react.createElement(Section, {
					title: "③ 决策摘要",
					hint: "优先用当前平台的检测结果；没有检测结果时用多来源扫描的汇总",
				}, summaryBlock || react.createElement("div", { style: dim }, "先检测一个平台，或等待扫描结果。")),

				react.createElement(Section, {
					title: `来源清单（${sources.length}）`,
					hint: "扫描面覆盖哪些来源、各自扫到多少免费模型，以及失败原因（逐来源隔离，不影响其它来源）",
				}, sourceRows.length > 0 ? react.createElement("div", {}, sourceRows) : react.createElement("div", { style: dim }, "暂无来源。")));
		}
		//#endregion


		/**
		 * Client plugin body.
		 *
		 * **唯一的注册目标**：`settings.section`（id `free-model`、order 25），且是**条件注册** ——
		 * 上游插件（`dsh-our-free-model`）在场时它自己那一栏就是统一页（本线的扫描能力已经用
		 * `patches/dsh-our-free-model/` 增量进它的设置页），本线让位；它不在场时才顶上来兜底。
		 *
		 * 历史（两次都删掉的落点，别再走）：
		 *   · `settings.models.footer`（M0）：模型页底部 —— 已删（"塞在别人页面底部"是设计问题）；
		 *   · `settings.models.provider-card`（M2）：已删 —— 那个槽**在编辑面板也会被 dispatch**，
		 *     occupant 一出问题就整树白屏。这条是**风险**论证：2026-09-28 的白屏事故真凶
		 *     已查明是别的包上的运行时补丁，与本线无关（见 design/CHANGELOG.md 续六）。
		 *     **模型页是官方的地盘，本线不碰。**
		 */
		function apply(ctx) {
			// 幂等守卫：DSH HMR / 重复 apply 不得叠加第二个面板（与 dual-model 同款）。
			if (window.__DSH_FREEMODEL_BOOTED__ === true) return;
			window.__DSH_FREEMODEL_BOOTED__ = true;
			ctx.effect(() => () => { window.__DSH_FREEMODEL_BOOTED__ = false; }, "free-model: dispose guard");

			// ① 统一页 —— **条件注册**。
			//
			// 上游插件（dsh-our-free-model）在场时，它自己那一栏就是统一页 —— 本线的扫描
			// 能力已经用 `patches/dsh-our-free-model/` 增量进它的设置页（「本机自配平台」分区），
			// 所以这里**不再注册**自己的 section：一个来源只留一个入口。
			//
			// 它不在场时（未装 / 被卸载 / 被隔离 profile 排除）才用本页面兜底，名字同样是
			// 「免费模型」。探测用它的只读路由 `/api/our-free-model/meta`（裸 fetch：
			// 不在场时是 404，而 api() 要求信封 ok）。
			let sectionMounted = false;
			const mountSection = () => {
				if (sectionMounted) return;
				sectionMounted = true;
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "free-model",
					order: 25,
					label: "免费模型",
				}, FreeModelPage));
			};
			ctx.effect(() => {
				let alive = true;
				fetch("/api/our-free-model/meta", { redirect: "error" })
					.then((res) => { if (alive && res.ok !== true) mountSection() })
					.catch(() => { if (alive) mountSection() });
				return () => { alive = false };
			}, "free-model: settings section (conditional)");

		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
