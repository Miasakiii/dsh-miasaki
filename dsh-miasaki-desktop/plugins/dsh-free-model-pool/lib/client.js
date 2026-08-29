window.__ModuleLoader__.load({
	id: "dsh-free-model-pool",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		/** Required services: the slot registry is the only hard dependency. */
		const inject = ["slots"];

		//#region panel component
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

		/** Free-model pool settings panel (multi-platform). */
		function FreeModelPoolPanel() {
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [notice, setNotice] = react.useState(null);
			const [platforms, setPlatforms] = react.useState([]);
			const [selected, setSelected] = react.useState("");
			const [detected, setDetected] = react.useState(null);
			const [presetState, setPresetState] = react.useState(null);

			const refresh = async () => {
				try {
					const r = await api("GET", "/freepool-api/status");
					const list = r.platforms || [];
					setPlatforms(list);
					setSelected((cur) => (cur && list.some((p) => p.id === cur) ? cur : (list[0] ? list[0].id : "")));
				} catch (e) {
					setError(String(e && e.message ? e.message : e));
				}
			};

			react.useEffect(() => {
				refresh();
			}, []);

			const current = platforms.find((p) => p.id === selected) || null;

			const detect = async () => {
				if (!selected) { setError("请先选择平台"); return; }
				setBusy(true); setError(null); setNotice(null);
				try {
					const r = await api("POST", "/freepool-api/detect", { platform: selected });
					setDetected(r);
				} catch (e) {
					setError(String(e && e.message ? e.message : e));
				} finally {
					setBusy(false);
				}
			};

			const applyAll = async () => {
				if (!selected) { setError("请先选择平台"); return; }
				setBusy(true); setError(null); setNotice(null);
				try {
					const r = await api("POST", "/freepool-api/apply", { platform: selected });
					await refresh();
					setNotice("已写入 " + r.written + " 个免费模型（" + r.platform + "）");
				} catch (e) {
					setError(String(e && e.message ? e.message : e));
				} finally {
					setBusy(false);
				}
			};

			const applySelected = async (id) => {
				setBusy(true); setError(null); setNotice(null);
				try {
					const r = await api("POST", "/freepool-api/apply", { platform: selected, ids: [id] });
					await refresh();
					setNotice("已写入 1 个模型: " + id);
				} catch (e) {
					setError(String(e && e.message ? e.message : e));
				} finally {
					setBusy(false);
				}
			};

			const setSubagent = async (modelId) => {
				if (!selected) { setError("请先选择平台"); return; }
				setBusy(true); setError(null); setNotice(null);
				try {
					const r = await api("POST", "/freepool-api/subagent", {
						provider: selected,
						model: modelId,
						maxTokens: 32768,
					});
					setPresetState(r);
					setNotice("子代理后端已切换为 " + r.provider + " / " + r.model + "（预设: " + r.updated.join(", ") + "），新会话生效");
				} catch (e) {
					setError(String(e && e.message ? e.message : e));
				} finally {
					setBusy(false);
				}
			};

			const rowStyle = { display: "flex", gap: 10, alignItems: "baseline", padding: "6px 0", borderBottom: "1px solid var(--border-color, rgba(128,128,128,.25))" };
			const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12 };
			const dim = { color: "var(--text-color-secondary, #888)", fontSize: 12 };
			const tag = (text, ok) => react.createElement("span", { style: Object.assign({ padding: "1px 6px", borderRadius: 4, fontSize: 11, whiteSpace: "nowrap" }, ok ? { background: "rgba(70,160,100,.18)", color: "#5c9" } : { background: "rgba(160,120,60,.15)", color: "#c85" }) }, text);

			const modelList = (detected && detected.models) || [];
			const summary = (detected && detected.summary) || null;

			const detectedRows = modelList.map((m) => {
				const p = m.profile || {};
				return react.createElement("div", { key: m.id, style: rowStyle },
					react.createElement("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 2 } },
						react.createElement("span", { style: mono }, m.id),
						react.createElement("span", { style: dim }, p.verdict || ""),
						react.createElement("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
							(p.strengths || []).map((s) => tag(s, true)),
							p.warnings && p.warnings.length > 0 ? p.warnings.map((w) => tag(w, false)) : null,
						),
					),
					react.createElement("span", { style: dim }, "ctx=" + String(m.contextWindow ?? "?")),
					react.createElement("span", { style: dim }, "max=" + String(m.maxTokens ?? "?")),
					react.createElement("button", { onClick: () => applySelected(m.id), disabled: busy }, "写入"),
				);
			});

			const configuredRows = ((current && current.configured) || []).map((c) => react.createElement("div", { key: c.id, style: Object.assign({ padding: "2px 0" }, mono, dim) }, c.id));

			const presetRows = modelList.map((m) => react.createElement("option", { key: m.id, value: m.id }, m.id + (m.profile && m.profile.canAgent ? "（子代理可用）" : "（仅问答）")));

			const platformOptions = platforms.map((p) => react.createElement("option", { key: p.id, value: p.id },
				p.displayName + "（" + p.id + " · 已配置 " + p.configuredCount + " · " + p.endpoint + "）"));

			const summaryBlock = summary ? react.createElement("div", { style: { border: "1px solid var(--border-color, rgba(128,128,128,.3))", borderRadius: 6, padding: 10, display: "flex", flexDirection: "column", gap: 4 } },
				react.createElement("strong", {}, "决策摘要"),
				react.createElement("div", { style: { fontSize: 13 } }, "检测到 " + summary.total + " 个免费模型，子代理可用（工具调用完整）" + summary.agentCount + " 个，仅问答/批处理 " + summary.qaOnly + " 个。"),
				summary.bestAgent ? react.createElement("div", { style: { fontSize: 13 } },
					"最佳子代理：", react.createElement("code", { style: mono }, summary.bestAgent.id), " — ", summary.bestAgent.verdict) : null,
				summary.codingAgent ? react.createElement("div", { style: { fontSize: 13 } },
					"编码类：", react.createElement("code", { style: mono }, summary.codingAgent)) : null,
				summary.longContextAgent ? react.createElement("div", { style: { fontSize: 13 } },
					"超长上下文：", react.createElement("code", { style: mono }, summary.longContextAgent)) : null,
				summary.visionAgent ? react.createElement("div", { style: { fontSize: 13 } },
					"多模态：", react.createElement("code", { style: mono }, summary.visionAgent)) : null,
			) : null;

			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 800 } },
				react.createElement("p", { style: { margin: 0, fontSize: 13 } },
					"扫描 DSH 已配置的 OpenAI 兼容平台（llm-pi-ai.providers 中带 baseURL 的路由），按免费规则（:free 后缀 / 定价全零 / 名称含免费、free）检出免费模型；每个模型给出能力画像与适用判定（子代理可用 / 仅问答），可一键写入该平台 models 并切换子代理后端。新增平台只需在设置 → 模型页配置，本面板自动出现。"),
				react.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
					react.createElement("select", {
						id: "freepool-platform-select",
						style: { minWidth: 340 },
						disabled: busy,
						value: selected,
						onChange: (e) => { setSelected(e.target.value); setDetected(null); },
					}, platformOptions.length > 0 ? platformOptions : react.createElement("option", { value: "" }, "（无可用平台）")),
					react.createElement("button", { onClick: detect, disabled: busy || !selected }, "检测免费模型"),
					react.createElement("button", { onClick: applyAll, disabled: busy || !selected || !detected || !detected.models || detected.models.length === 0 }, "写入全部检测结果"),
					react.createElement("button", { onClick: refresh, disabled: busy }, "刷新平台"),
				),
				error ? react.createElement("div", { style: { color: "#f66", fontSize: 12 } }, error) : null,
				notice ? react.createElement("div", { style: { color: "#6c6", fontSize: 12 } }, notice) : null,
				busy ? react.createElement("div", { style: { fontSize: 12 } }, "处理中…") : null,
				summaryBlock,
				modelList.length > 0 ? react.createElement("div", {},
					react.createElement("h4", { style: { margin: "8px 0 4px" } }, "检测结果（" + modelList.length + " 个）"),
					react.createElement("div", {}, detectedRows),
				) : null,
				current && current.configured.length > 0 ? react.createElement("div", {},
					react.createElement("h4", { style: { margin: "8px 0 4px" } }, "当前已配置（" + current.configured.length + " 个）"),
					react.createElement("div", {}, configuredRows),
				) : null,
				modelList.length > 0 ? react.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", paddingTop: 8 } },
					react.createElement("select", {
						id: "freepool-subagent-select",
						style: { minWidth: 320 },
						disabled: busy,
						defaultValue: "",
					}, [react.createElement("option", { key: "_", value: "", disabled: true }, "选择子代理默认模型…"), ...presetRows]),
					react.createElement("button", {
						onClick: () => {
							const sel = document.getElementById("freepool-subagent-select");
							if (sel && sel.value) setSubagent(sel.value);
						},
						disabled: busy,
					}, "设为子代理后端"),
				) : null,
				presetState ? react.createElement("div", { style: Object.assign({ paddingTop: 4 }, dim) },
					"最近一次切换：" + presetState.provider + " / " + presetState.model + "（" + presetState.updated.join(", ") + "）") : null,
			);
		}
		//#endregion

		/**
		 * Client plugin body: register the settings section.
		 */
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "free-model-pool",
				order: 25,
				label: "免费模型池",
			}, FreeModelPoolPanel));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
