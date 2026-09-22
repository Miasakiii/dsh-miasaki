#!/usr/bin/env node
// DSH 设置页「模型能力增强」运行时补丁 —— 思考强度 + 逐模型连通性测试。
//
// 背景：DSH 官方设置页（`@deepseek-ai/dsh-client-ui-settings-models`）刻意不提供
// 逐模型思考强度控件，也不做逐模型连通性测试（上游取向：effort 是 per-MODEL 能力，
// 放在对话选择器里）。本补丁在已安装的 client bundle 上增量加入这两项，
// 不 fork 官方包、不重建 dist。
//
// 为什么直接改 bundle：本机无 pnpm 全量重建链路（registry 不可达 / store 被锁）。
// 代价是 **DSH 升级会覆盖该包，升级后需重新应用本补丁** —— 这正是本脚本入库的原因：
// 补丁规则与基线文件进版本控制，升级后能重建、能校验、能回退，而不是依赖某台机器上
// 的一次性产物。
//
// 补丁形态：行导向的锚点编辑。每个锚点在源文件里必须唯一（否则报错而非瞎改），
// 插入块保留目标文件自身的缩进风格。7 条编辑（5 处插入 + 2 处字典替换）见 EDITS。
//
// 用法：
//   node patch.mjs verify            # 离线自检：baseline 原始 → 重建 → 逐字节比对 + 语法闸门
//   node patch.mjs status            # 检查已安装 bundle 的补丁状态与**语法状态**
//   node patch.mjs apply [--yes]     # 备份 + 应用（幂等：已打过则跳过；打坏则拒绝静默跳过）
//   node patch.mjs resync            # 由 backup 重打（apply 幂等跳过时的正确重打姿势）
//   node patch.mjs revert            # 从 .dsh-bak 还原
//   node patch.mjs rebuild           # 改过 EDITS 后：由 baseline 原始文件重建 golden 产物
//   通用参数：--target <client.js 路径>  覆盖自动探测
//
// 出口不变量（2026-09-19 起）：任何进入安装目录的产物都必须过**语法闸门**
// （vm.Script / 经典脚本目标），因为"重建 == baseline"只证明可复现、不证明合法。
//
// 设计文档：../../dsh-miasaki-shared-docs/cross/model-settings-toolkit-design-2026-09-07.md

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(HERE, 'baseline')
const ORIGINAL_FILE = join(BASELINE, 'client.original.js')
const PATCHED_FILE = join(BASELINE, 'client.patched.js')

export const TARGET_PACKAGE = '@deepseek-ai/dsh-client-ui-settings-models'
/** DSH 版本基线：锚点文本与两份 baseline 都取自这个版本。 */
export const BASELINE_DSH_VERSION = '0.1.5-rc.1'
/** 官方原版 client.js 的 SHA-256（与安装目录的 client.js.dsh-bak 逐字节一致）。 */
export const ORIGINAL_SHA256 = 'A60FD86357F9FBC6F5276ED0393682F7F2223FAEDEC4F30C719D66E99600B1BB'
/**
 * 应用本补丁后的 SHA-256（v2 连通性探测 + locale 尾逗号修复，2026-09-19 起的状态）。
 *
 * 沿革：`E602C1F1…`（v1）→ `C6C1DCBC…`（v2，**语法非法，见下**）→ `F1717A07…`（v2 + 修复）。
 * `C6C1DCBC…` 那一版是本次事故的产物：locale 字典漏了两个尾逗号（en/zh 各一处），
 * 产物语法错误且让整份 client bundle 不注册。它之所以能通过 `verify` 并被打进生产，
 * 是因为当时的 `verify` 只做逐字节比对（可复现 ≠ 合法）——`assertParses` 因此加入。
 */
export const PATCHED_SHA256 = '7D7D8494C6B10641990845362740CB6FA9EC5F88540452E75F09644977E15B3B'
/** 补丁特征串：出现即视为已应用（用于幂等与状态判定）。 */
const PATCH_MARKER = 'const REASONING_LEVELS = '

// ---------------------------------------------------------------------------
// 编辑规则（7 条）。lines 为该编辑插入/替换的完整行，缩进已按目标文件写定；
// anchor 按「trim 后全等」匹配，必须唯一。
// ---------------------------------------------------------------------------
const EDITS = [
  {
    id: 'reasoning-helpers',
    mode: 'insertBefore',
    anchor: "/** A row's text field, or the empty string when unset or not a string. */",
    lines: [
      '\t\t/** Reasoning levels a model row may declare, ordered by intensity. */',
      '\t\tconst REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];',
      '\t\t/** The chooser value for one row: an explicit level, "disabled", or "inherit". */',
      '\t\tfunction reasoningChoice(model) {',
      '\t\t\tconst val = model["reasoningEfforts"];',
      '\t\t\tif (val === false) return "disabled";',
      '\t\t\tif (typeof val !== "object" || val === null || Array.isArray(val)) return "inherit";',
      '\t\t\tconst chosen = REASONING_LEVELS.find((level) => Object.prototype.hasOwnProperty.call(val, level));',
      '\t\t\treturn chosen === void 0 ? "inherit" : chosen;',
      '\t\t}',
      '\t\t/** The reasoningEfforts value one chooser choice writes. */',
      '\t\tfunction reasoningPatch(choice) {',
      '\t\t\tif (choice === "inherit") return void 0;',
      '\t\t\tif (choice === "disabled") return false;',
      '\t\t\treturn { off: null, [choice]: choice };',
      '\t\t}',
      '\t\t/**',
      '\t\t * The inherit option\'s label, naming what inherit currently resolves to',
      '\t\t * for this row. The resolver comes from the card (the resolved namespace',
      '\t\t * value); an absent resolver or an absent declaration renders as "none",',
      '\t\t * because guessing a default the user cannot see is the bug this avoids.',
      '\t\t */',
      '\t\tfunction reasoningInheritLabel(model, props, t) {',
      '\t\t\tconst resolved = props.reasoningDefaultOf === void 0 ? "inherit" : props.reasoningDefaultOf(textOf(model, "id"));',
      '\t\t\tif (resolved === "disabled") return `${t("modelReasoningInherit")}（${t("modelReasoningDisabled")}）`;',
      '\t\t\tif (resolved === "inherit") return `${t("modelReasoningInherit")}（${t("modelReasoningNone")}）`;',
      '\t\t\treturn `${t("modelReasoningInherit")}（${resolved}）`;',
      '\t\t}',
      '\t\t/** CSS class for one connectivity result: the success or error tone. */',
      '\t\tfunction testResultClass(ok, stylesRef) {',
      '\t\t\treturn ok ? stylesRef["savedNotice"] : stylesRef["error"];',
      '\t\t}',
      '\t\t/**',
      '\t\t * Localized copy for one host probe result. The host answers with a stable',
      '\t\t * kind (never a sentence), so every word the user reads is translated here',
      '\t\t * and the two languages cannot drift apart. Latency is appended only when',
      '\t\t * the host actually measured a round trip (a planning failure has none).',
      '\t\t */',
      '\t\tfunction describeProbe(result, t) {',
      '\t\t\tconst ms = typeof result.latencyMs === "number" ? ` · ${result.latencyMs}ms` : "";',
      '\t\t\tswitch (result.kind) {',
      '\t\t\t\tcase "ok": return t("testProbeOk") + ms;',
      '\t\t\t\tcase "unauthorized": return t("testProbeUnauthorized");',
      '\t\t\t\tcase "model-missing": return t("testProbeModelMissing");',
      '\t\t\t\tcase "quota": return t("testProbeQuota");',
      '\t\t\t\tcase "rate-limited": return t("testProbeRateLimited");',
      '\t\t\t\tcase "timeout": return t("testProbeTimeout");',
      '\t\t\t\tcase "unreachable": return t("testProbeUnreachable");',
      '\t\t\t\tcase "bad-request": return t("testProbeBadRequest");',
      '\t\t\t\tcase "server-error": return t("testProbeServerError");',
      '\t\t\t\tcase "unsupported": return t("testProbeUnsupported");',
      '\t\t\t\tcase "no-credential": return t("testProbeNoCredential");',
      '\t\t\t\tcase "no-endpoint": return t("testProbeNoEndpoint");',
      '\t\t\t\tcase "no-model": return t("testProbeNoModel");',
      '\t\t\t\tdefault: return t("testProbeUnknown");',
      '\t\t\t}',
      '\t\t}',
      '\t\t/**',
      '\t\t * Ask the host probe plugin whether this model can actually be talked to.',
      '\t\t * Returns the result object, or null when the plugin is not serving this',
      '\t\t * route (absent / host not restarted / not JSON) — the caller\'s cue to fall',
      '\t\t * back to the catalog probe, so the button is never dead.',
      '\t\t */',
      '\t\tasync function probeViaHost(id, probe) {',
      '\t\t\tlet response;',
      '\t\t\ttry {',
      '\t\t\t\tresponse = await fetch("/model-probe-api/probe", {',
      '\t\t\t\t\tmethod: "POST",',
      '\t\t\t\t\theaders: { "content-type": "application/json" },',
      '\t\t\t\t\tbody: JSON.stringify({',
      '\t\t\t\t\t\t...probe.provider === void 0 ? {} : { provider: probe.provider },',
      '\t\t\t\t\t\t...probe.baseURL === void 0 || probe.baseURL.length === 0 ? {} : { baseURL: probe.baseURL },',
      '\t\t\t\t\t\t...probe.api === void 0 ? {} : { api: probe.api },',
      '\t\t\t\t\t\t...probe.apiKey === void 0 ? {} : { apiKey: probe.apiKey },',
      '\t\t\t\t\t\tmodel: id',
      '\t\t\t\t\t})',
      '\t\t\t\t});',
      '\t\t\t} catch {',
      '\t\t\t\treturn null;',
      '\t\t\t}',
      '\t\t\t/* 200 is the only status that means "the probe ran"; a 403 from the trust',
      '\t\t\t   fence or a 404 from a missing route both mean "ask the catalog instead". */',
      '\t\t\tif (response.status !== 200) return null;',
      '\t\t\tlet answer;',
      '\t\t\ttry {',
      '\t\t\t\tanswer = await response.json();',
      '\t\t\t} catch {',
      '\t\t\t\treturn null;',
      '\t\t\t}',
      '\t\t\treturn answer !== null && typeof answer === "object" && answer.result !== void 0 ? answer.result : null;',
      '\t\t}',
    ],
  },
  {
    id: 'test-state',
    mode: 'insertAfter',
    anchor: 'const [editing, setEditing] = (0, react.useState)(/* @__PURE__ */ new Map());',
    lines: [
      '\t\t\tconst [testing, setTesting] = (0, react.useState)(/* @__PURE__ */ new Set());',
      '\t\t\tconst [testResults, setTestResults] = (0, react.useState)(/* @__PURE__ */ new Map());',
    ],
  },
  {
    id: 'test-model',
    mode: 'insertBefore',
    anchor: 'const askable = probe.provider !== void 0 || probe.baseURL !== void 0 && probe.baseURL.length > 0;',
    lines: [
      '\t\t\tconst testModel = async (index, model) => {',
      '\t\t\t\tconst id = textOf(model, "id").trim();',
      '\t\t\t\tif (id.length === 0 || testing.has(index)) return;',
      '\t\t\t\tsetTesting((cur) => new Set([...cur, index]));',
      '\t\t\t\tsetTestResults((cur) => {',
      '\t\t\t\t\tconst next = new Map(cur);',
      '\t\t\t\t\tnext.delete(index);',
      '\t\t\t\t\treturn next;',
      '\t\t\t\t});',
      '\t\t\t\tconst settle = (ok, message) => {',
      '\t\t\t\t\tsetTestResults((prev) => new Map(prev).set(index, { ok, message }));',
      '\t\t\t\t};',
      '\t\t\t\ttry {',
      '\t\t\t\t\tconst result = await probeViaHost(id, probe);',
      '\t\t\t\t\tif (result !== null) {',
      '\t\t\t\t\t\tsettle(result.ok === true, describeProbe(result, t));',
      '\t\t\t\t\t\treturn;',
      '\t\t\t\t\t}',
      '\t\t\t\t\tconst answer = await operations.discoverModels(probe.settingsNs, {',
      '\t\t\t\t\t\t...probe.provider === void 0 ? {} : { provider: probe.provider },',
      '\t\t\t\t\t\t...probe.baseURL === void 0 || probe.baseURL.length === 0 ? {} : { baseURL: probe.baseURL },',
      '\t\t\t\t\t\t...probe.api === void 0 ? {} : { api: probe.api },',
      '\t\t\t\t\t\t...probe.apiKey === void 0 ? {} : { apiKey: probe.apiKey }',
      '\t\t\t\t\t});',
      '\t\t\t\t\tif (answer.kind === "refused") {',
      '\t\t\t\t\t\tsettle(false, answer.message);',
      '\t\t\t\t\t\treturn;',
      '\t\t\t\t\t}',
      '\t\t\t\t\tconst found = answer.models.some((candidate) => candidate.id === id);',
      '\t\t\t\t\tsettle(true, (found ? t("testSuccess") : t("testReachableNotListed")) + t("testCatalogFallback"));',
      '\t\t\t\t} catch (error) {',
      '\t\t\t\t\tconst explain = error && typeof error === "object" && "message" in error ? error.message : String(error);',
      '\t\t\t\t\tsettle(false, explain);',
      '\t\t\t\t} finally {',
      '\t\t\t\t\tsetTesting((prev) => {',
      '\t\t\t\t\t\tconst next = new Set(prev);',
      '\t\t\t\t\t\tnext.delete(index);',
      '\t\t\t\t\t\treturn next;',
      '\t\t\t\t\t});',
      '\t\t\t\t}',
      '\t\t\t};',
    ],
  },
  {
    id: 'reindex-test-state',
    mode: 'insertAfter',
    anchor: 'setEditing((current) => reindexOnRemove(current, index));',
    lines: [
      '\t\t\t\t\t\t\t\t\t\tsetTesting((current) => {',
      '\t\t\t\t\t\t\t\t\t\t\tconst next = new Set();',
      '\t\t\t\t\t\t\t\t\t\t\tfor (const at of current) {',
      '\t\t\t\t\t\t\t\t\t\t\t\tif (at < index) next.add(at);',
      '\t\t\t\t\t\t\t\t\t\t\t\telse if (at > index) next.add(at - 1);',
      '\t\t\t\t\t\t\t\t\t\t\t}',
      '\t\t\t\t\t\t\t\t\t\t\treturn next;',
      '\t\t\t\t\t\t\t\t\t\t});',
      '\t\t\t\t\t\t\t\t\t\tsetTestResults((current) => {',
      '\t\t\t\t\t\t\t\t\t\t\tconst next = new Map();',
      '\t\t\t\t\t\t\t\t\t\t\tfor (const [at, value] of current) {',
      '\t\t\t\t\t\t\t\t\t\t\t\tif (at < index) next.set(at, value);',
      '\t\t\t\t\t\t\t\t\t\t\t\telse if (at > index) next.set(at - 1, value);',
      '\t\t\t\t\t\t\t\t\t\t\t}',
      '\t\t\t\t\t\t\t\t\t\t\treturn next;',
      '\t\t\t\t\t\t\t\t\t\t});',
    ],
  },
  {
    // 思考强度选择器 + 连通性测试按钮。两个 DSH 版本的渲染结构不同，故分**变体**：
    //   · inline-jsx（0.1.5-rc.x）：model row 是 ModelListEditor 里的内联 JSX，
    //     插入点紧跟 maxTokens 输入框之后（锚点 +2 行是该 children 数组的收尾 `})]`）。
    //   · model-row（0.1.6-alpha.2 起）：官方把 model row 抽成独立的 `ModelRow` 组件
    //     （`ModelRow.tsx`），容量字段的渲染随之搬进组件内部，而 `testing` /
    //     `testResults` / `testModel` 这些状态留在 ModelListEditor —— 组件里够不着。
    //     故改为**跨组件传一个已渲染好的 ReactNode**：Editor 侧构造 `reasoningRow`
    //     （闭包仍捕获全部状态），ModelRow 侧把它摆到容量字段之后。两条子编辑成对出现。
    //   变体由 `probe` 选中：探针行在源文件里出现即采用该变体；两者都不出现则报错。
    id: 'reasoning-ui',
    variants: [
      {
        probe: 'editCapacity(index, "maxTokens", event.target.value);',
        edits: [
          {
            id: 'reasoning-ui@inline-jsx',
            mode: 'insertAfterOffset',
            anchor: 'editCapacity(index, "maxTokens", event.target.value);',
            offset: 2,
            expect: '})]',
            lines: [
              '\t\t\t\t\t\t\t}),',
              '\t\t\t\t\t\t\tcapabilities.get(textOf(model, "id")) === void 0 ? null : (0, react_jsx_runtime.jsxs)("span", {',
              '\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelField"],',
              '\t\t\t\t\t\t\t\tchildren: [',
              '\t\t\t\t\t\t\t\t\tcapabilities.get(textOf(model, "id")).image === true ? (0, react_jsx_runtime.jsx)("span", { className: `${ModelsSection_module_css_default["rowTag"]}`, title: t("capVisionTitle"), children: t("capVision") }) : null,',
              '\t\t\t\t\t\t\t\t\tcapabilities.get(textOf(model, "id")).reasoning === true ? (0, react_jsx_runtime.jsx)("span", { className: `${ModelsSection_module_css_default["rowTag"]}`, title: t("capReasoningTitle"), children: t("capReasoning") }) : null',
              '\t\t\t\t\t\t\t\t]',
              '\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsxs)("label", {',
              '\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelField"],',
              '\t\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {',
              '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelFieldLabel"],',
              '\t\t\t\t\t\t\t\t\tchildren: t("modelReasoningEffort")',
              '\t\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("select", {',
              '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["input"],',
              '\t\t\t\t\t\t\t\t\tvalue: reasoningChoice(model),',
              '\t\t\t\t\t\t\t\t\t"aria-label": `${t("modelReasoningEffort")} ${index + 1}`,',
              '\t\t\t\t\t\t\t\t\tdisabled,',
              '\t\t\t\t\t\t\t\t\tonChange: (event) => {',
              '\t\t\t\t\t\t\t\t\t\tconst next = reasoningPatch(event.target.value);',
              '\t\t\t\t\t\t\t\t\t\tif (next === void 0) patch(index, { reasoningEfforts: void 0 });',
              '\t\t\t\t\t\t\t\t\t\telse patch(index, { reasoningEfforts: next });',
              '\t\t\t\t\t\t\t\t\t},',
              '\t\t\t\t\t\t\t\t\tchildren: [...REASONING_LEVELS.map((level) => (0, react_jsx_runtime.jsx)("option", { key: level, value: level, children: level })), (0, react_jsx_runtime.jsx)("option", { value: "inherit", children: reasoningInheritLabel(model, props, t) }), (0, react_jsx_runtime.jsx)("option", { value: "disabled", children: t("modelReasoningDisabled") })]',
              '\t\t\t\t\t\t\t\t})]',
              '\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsxs)("span", {',
              '\t\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("button", {',
              '\t\t\t\t\t\t\t\t\ttype: "button",',
              '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["secondaryButton"],',
              '\t\t\t\t\t\t\t\t\tdisabled: disabled || testing.has(index) || textOf(model, "id").trim().length === 0,',
              '\t\t\t\t\t\t\t\t\t"aria-label": `${t("testModel")} ${index + 1}`,',
              '\t\t\t\t\t\t\t\t\tonClick: () => { testModel(index, model); },',
              '\t\t\t\t\t\t\t\t\tchildren: testing.has(index) ? t("testing") : t("testModel")',
              '\t\t\t\t\t\t\t\t}), testResults.has(index) ? (0, react_jsx_runtime.jsx)("span", {',
              '\t\t\t\t\t\t\t\t\tclassName: testResultClass(testResults.get(index).ok === true, ModelsSection_module_css_default),',
              '\t\t\t\t\t\t\t\t\tchildren: testResults.get(index).message',
              '\t\t\t\t\t\t\t\t}) : null]',
            ],
          },
        ],
      },
      {
        probe: 'editCapacity(index, "maxTokens", text);',
        edits: [
          {
            // Editor 侧：把两块 UI 渲染成一个 ReactNode 交给 ModelRow。闭包在这里，
            // testing / testResults / testModel / patch / t / disabled 全部可见。
            //
            // 锚点刻意不选 `onFieldChange`：ModelRow 被**两个编辑器**共用（本包与
            // DeepSeekModelsEditor/CustomProviderCard），那个锚点在 bundle 里命中 2 次，
            // 会撞上 findUnique 的唯一性要求。`inputLoading` 里的 `catalogProvider`
            // 只有本编辑器有 —— 实测唯一命中。
            id: 'reasoning-ui@model-row-prop',
            mode: 'insertBefore',
            anchor: 'inputLoading: catalogProvider !== void 0 && catalog === void 0,',
            lines: [
              '\t\t\t\t\t\t\treasoningRow: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [',
              '\t\t\t\t\t\t\t\tcapabilities.get(textOf(model, "id")) === void 0 ? null : (0, react_jsx_runtime.jsxs)("span", {',
              '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelField"],',
              '\t\t\t\t\t\t\t\t\tchildren: [',
              '\t\t\t\t\t\t\t\t\t\tcapabilities.get(textOf(model, "id")).image === true ? (0, react_jsx_runtime.jsx)("span", { className: `${ModelsSection_module_css_default["rowTag"]}`, title: t("capVisionTitle"), children: t("capVision") }) : null,',
              '\t\t\t\t\t\t\t\t\t\tcapabilities.get(textOf(model, "id")).reasoning === true ? (0, react_jsx_runtime.jsx)("span", { className: `${ModelsSection_module_css_default["rowTag"]}`, title: t("capReasoningTitle"), children: t("capReasoning") }) : null',
              '\t\t\t\t\t\t\t\t\t]',
              '\t\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsxs)("label", {',
              '\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelField"],',
              '\t\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {',
              '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["modelFieldLabel"],',
              '\t\t\t\t\t\t\t\t\tchildren: t("modelReasoningEffort")',
              '\t\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("select", {',
              '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["input"],',
              '\t\t\t\t\t\t\t\t\tvalue: reasoningChoice(model),',
              '\t\t\t\t\t\t\t\t\t"aria-label": `${t("modelReasoningEffort")} ${index + 1}`,',
              '\t\t\t\t\t\t\t\t\tdisabled,',
              '\t\t\t\t\t\t\t\t\tonChange: (event) => {',
              '\t\t\t\t\t\t\t\t\t\tconst next = reasoningPatch(event.target.value);',
              '\t\t\t\t\t\t\t\t\t\tif (next === void 0) patch(index, { reasoningEfforts: void 0 });',
              '\t\t\t\t\t\t\t\t\t\telse patch(index, { reasoningEfforts: next });',
              '\t\t\t\t\t\t\t\t\t},',
              '\t\t\t\t\t\t\t\t\tchildren: [...REASONING_LEVELS.map((level) => (0, react_jsx_runtime.jsx)("option", { key: level, value: level, children: level })), (0, react_jsx_runtime.jsx)("option", { value: "inherit", children: reasoningInheritLabel(model, props, t) }), (0, react_jsx_runtime.jsx)("option", { value: "disabled", children: t("modelReasoningDisabled") })]',
              '\t\t\t\t\t\t\t\t})]',
              '\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsxs)("span", {',
              '\t\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("button", {',
              '\t\t\t\t\t\t\t\t\ttype: "button",',
              '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["secondaryButton"],',
              '\t\t\t\t\t\t\t\t\tdisabled: disabled || testing.has(index) || textOf(model, "id").trim().length === 0,',
              '\t\t\t\t\t\t\t\t\t"aria-label": `${t("testModel")} ${index + 1}`,',
              '\t\t\t\t\t\t\t\t\tonClick: () => { testModel(index, model); },',
              '\t\t\t\t\t\t\t\t\tchildren: testing.has(index) ? t("testing") : t("testModel")',
              '\t\t\t\t\t\t\t\t}), testResults.has(index) ? (0, react_jsx_runtime.jsx)("span", {',
              '\t\t\t\t\t\t\t\t\tclassName: testResultClass(testResults.get(index).ok === true, ModelsSection_module_css_default),',
              '\t\t\t\t\t\t\t\t\tchildren: testResults.get(index).message',
              '\t\t\t\t\t\t\t\t}) : null]',
              '\t\t\t\t\t\t\t})] }),',
            ],
          },
          {
            // ModelRow 侧：把它摆到两个容量字段之后（map 结果与 ModelInputTypes 之间），
            // 与 inline-jsx 变体的视觉位置一致。
            //
            // 用 replaceLine 而不是 insertBefore：这一行**行内**同时装着上一项的收尾
            // （`.map(...)` 的 `)`）与下一项的开头（ModelInputTypes），插不进独立一行 ——
            // 在它之前插入会落进 `.map()` 的参数里，在它之后插入会落进 ModelInputTypes
            // 的 props 里，两者都是语法错误（都实测撞过 applyPatch 出口的语法闸门）。
            // 整行重写把我们的节点放在两者之间，正是那个 children 数组的第二项。
            //
            // 另一处 ModelRow 调用点（DeepSeekModelsEditor）不传 `reasoningRow`，
            // 值为 undefined —— React 对 undefined 子节点不渲染任何东西，安全。
            id: 'reasoning-ui@model-row-slot',
            mode: 'replaceLine',
            anchor: '}, field)), (0, react_jsx_runtime.jsx)(ModelInputTypes, {',
            lines: [
              '\t\t\t\t\t\t}, field)), props.reasoningRow, (0, react_jsx_runtime.jsx)(ModelInputTypes, {',
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'locale-en',
    mode: 'replaceLine',
    anchor: 'keyRequired: "Enter an API key to continue."',
    lines: [
      '\t\t\tkeyRequired: "Enter an API key to continue.",',
      '\t\t\tmodelReasoningEffort: "Reasoning effort",',
      '\t\t\tmodelReasoningInherit: "Inherit provider default",',
      '\t\t\tmodelReasoningDisabled: "No reasoning",',
      '\t\t\ttestModel: "Test connectivity",',
      '\t\t\ttesting: "Testing…",',
      '\t\t\ttestSuccess: "Reachable · listed",',
      '\t\t\ttestReachableNotListed: "Reachable, but not listed in catalog",',
      '\t\t\ttestProbeOk: "Reachable",',
      '\t\t\ttestProbeUnauthorized: "Authentication failed — check the API key",',
      '\t\t\ttestProbeModelMissing: "Model ID not registered or misspelled",',
      '\t\t\ttestProbeQuota: "Quota exhausted or plan expired",',
      '\t\t\ttestProbeRateLimited: "Rate limited — retry later",',
      '\t\t\ttestProbeTimeout: "Timed out (15s)",',
      '\t\t\ttestProbeUnreachable: "Cannot connect — check the URL and network",',
      '\t\t\ttestProbeBadRequest: "Request rejected — protocol or parameters mismatch",',
      '\t\t\ttestProbeServerError: "Gateway error",',
      '\t\t\ttestProbeUnsupported: "This protocol cannot be probed",',
      '\t\t\ttestProbeNoCredential: "No API key found — enter one first",',
      '\t\t\ttestProbeNoEndpoint: "No API address configured",',
      '\t\t\ttestProbeNoModel: "Model ID is required",',
      '\t\t\ttestProbeUnknown: "Probe did not pass",',
      '\t\t\ttestCatalogFallback: " (probe service unavailable — fell back to the catalog)",',
      '\t\t\tcredentialMissingHint: "No API key configured — enter one above, or set the environment variable ",',
      '\t\t\tcredentialMissingTail: " before launch. Without it this provider\'s models are unusable, and a connectivity test fails for lack of a credential.",',
      '\t\t\tmodelReasoningNone: "none declared",',
      '\t\t\ttestAllModels: "Test all",',
      '\t\t\ttestingAll: "Testing…",',
      '\t\t\tcapVision: "vision",',
      '\t\t\tcapReasoning: "reasoning",',
      '\t\t\tcapVisionTitle: "This model declares image input",',
      '\t\t\tcapReasoningTitle: "This model declares selectable reasoning effort"',
    ],
  },
  {
    id: 'locale-zh',
    mode: 'replaceLine',
    anchor: 'keyRequired: "请输入 API 密钥后继续。"',
    lines: [
      '\t\t\tkeyRequired: "请输入 API 密钥后继续。",',
      '\t\t\tmodelReasoningEffort: "思考强度",',
      '\t\t\tmodelReasoningInherit: "继承提供方默认",',
      '\t\t\tmodelReasoningDisabled: "不支持思考",',
      '\t\t\ttestModel: "测试连通性",',
      '\t\t\ttesting: "测试中…",',
      '\t\t\ttestSuccess: "可达 · 已在目录中列出",',
      '\t\t\ttestReachableNotListed: "可达，但目录中未列出",',
      '\t\t\ttestProbeOk: "可用",',
      '\t\t\ttestProbeUnauthorized: "认证失败——检查 API Key",',
      '\t\t\ttestProbeModelMissing: "模型 ID 未注册或拼写错误",',
      '\t\t\ttestProbeQuota: "额度不足或套餐过期",',
      '\t\t\ttestProbeRateLimited: "触发限流，请稍后重试",',
      '\t\t\ttestProbeTimeout: "连接超时（15s）",',
      '\t\t\ttestProbeUnreachable: "无法连接——检查地址与网络",',
      '\t\t\ttestProbeBadRequest: "请求被拒——协议或参数不匹配",',
      '\t\t\ttestProbeServerError: "网关内部错误",',
      '\t\t\ttestProbeUnsupported: "该协议暂不支持探测",',
      '\t\t\ttestProbeNoCredential: "未找到 API Key，请先填写",',
      '\t\t\ttestProbeNoEndpoint: "缺少 API 地址",',
      '\t\t\ttestProbeNoModel: "模型 ID 不能为空",',
      '\t\t\ttestProbeUnknown: "探测未通过",',
      '\t\t\ttestCatalogFallback: "（探测服务未就绪，已回退目录探测）",',
      '\t\t\tcredentialMissingHint: "未配置 API Key —— 请在上方填写，或在启动前设置环境变量 ",',
      '\t\t\tcredentialMissingTail: " 。未配置时该提供方下的模型不可用，「测试连通性」也会因缺少凭据而失败。",',
      '\t\t\tmodelReasoningNone: "未声明",',
      '\t\t\ttestAllModels: "测试全部",',
      '\t\t\ttestingAll: "测试中…",',
      '\t\t\tcapVision: "视觉",',
      '\t\t\tcapReasoning: "推理",',
      '\t\t\tcapVisionTitle: "该模型声明支持图片输入",',
      '\t\t\tcapReasoningTitle: "该模型声明可调思考强度"',
    ],
  },
  {
    // A-1 无 Key 引导（行级）：缺失小点的 tooltip 点明环境变量名。
    // 「API key missing」单独看不出来缺的是哪一个、以及后果。
    id: 'no-key-row-hint',
    mode: 'replaceLine',
    anchor: 'title: t("credentialMissing")',
    lines: [
      '\t\t\t\t\t\t\t\t\t\t\t\t\ttitle: `${t("credentialMissing")}（${row.apiKeyEnv}）`',
    ],
  },
  {
    // A-2 无 Key 引导（卡片级）：编辑卡片里，凭据未配置且用户还没粘 key 时，
    // 在密钥输入区下方给一行可操作提示（点名 ref + 说明后果）。
    // 锚点是密钥失败段落的首行（该数组最后一个元素、无尾逗号）—— 插在它**之前**，
    // 新元素自带尾逗号，数组结构不变。
    id: 'no-key-card-hint',
    mode: 'insertBefore',
    anchor: 'shownKeyFailure === void 0 ? null : (0, react_jsx_runtime.jsx)("p", {',
    lines: [
      '\t\t\t\t\t\tkeyState !== void 0 && keyState.configured !== true && keyValue.length === 0 ? (0, react_jsx_runtime.jsx)("p", {',
      '\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["advancedHint"],',
      '\t\t\t\t\t\t\tchildren: `${t("credentialMissingHint")}${keyRef}${t("credentialMissingTail")}`',
      '\t\t\t\t\t\t}) : null,',
    ],
  },
  {
    // D 思考强度细化（数据侧）：catalogProps 增加 reasoningDefaultOf 解析器 ——
    // 按模型 id 在**解析后的**命名空间值里找同 id 条目，返回其声明的等级。
    // 「继承」因此能回答「继承到什么」而不是一句空话。
    id: 'reasoning-default-resolver',
    mode: 'insertBefore',
    anchor: 'onReset: () => {',
    lines: [
      '\t\t\t\t\treasoningDefaultOf: (id) => {',
      '\t\t\t\t\t\tconst route = namespace !== void 0 && namespace.value !== void 0 && namespace.value.providers !== void 0 ? namespace.value.providers[props.provider] : void 0;',
      '\t\t\t\t\t\tconst found = route !== void 0 && Array.isArray(route.models) ? route.models.find((entry) => entry !== void 0 && entry !== null && entry.id === id) : void 0;',
      '\t\t\t\t\t\treturn found === void 0 ? "inherit" : reasoningChoice(found);',
      '\t\t\t\t\t},',
    ],
  },
  {
    // B 能力徽标 + 批量测试（状态侧）：徽标 Map 与「测试全部」进行态。
    // 锚点是 edit #2 插入的 testResults state 行 —— 后发编辑可以锚在前发编辑的产物上。
    id: 'capabilities-state',
    mode: 'insertAfter',
    anchor: 'const [testResults, setTestResults] = (0, react.useState)(/* @__PURE__ */ new Map());',
    lines: [
      '\t\t\tconst [capabilities, setCapabilities] = (0, react.useState)(/* @__PURE__ */ new Map());',
      '\t\t\tconst [testingAll, setTestingAll] = (0, react.useState)(false);',
    ],
  },
  {
    // B（行为侧）：能力加载 effect + testAllModels。锚点是 edit #3 插入点前的
    // askable 行 —— 插在 testModel 之后、askable 之前，闭包里两者都够得着。
    id: 'capabilities-effect-and-testall',
    mode: 'insertBefore',
    anchor: 'const askable = probe.provider !== void 0 || probe.baseURL !== void 0 && probe.baseURL.length > 0;',
    lines: [
      '\t\t\tconst capabilityKey = models.map((model) => textOf(model, "id").trim()).filter((id) => id.length > 0).join("\\u0000");',
      '\t\t\tconst loadCapabilities = async () => {',
      '\t\t\t\tif (capabilityKey.length === 0) return;',
      '\t\t\t\ttry {',
      '\t\t\t\t\tconst response = await fetch("/model-probe-api/capabilities", {',
      '\t\t\t\t\t\tmethod: "POST",',
      '\t\t\t\t\t\theaders: { "content-type": "application/json" },',
      '\t\t\t\t\t\tbody: JSON.stringify({',
      '\t\t\t\t\t\t\tprovider: probe.provider === void 0 ? void 0 : probe.provider,',
      '\t\t\t\t\t\t\tbaseURL: probe.baseURL === void 0 || probe.baseURL.length === 0 ? void 0 : probe.baseURL,',
      '\t\t\t\t\t\t\tapi: probe.api === void 0 ? void 0 : probe.api,',
      '\t\t\t\t\t\t\tmodels: capabilityKey.split("\\u0000")',
      '\t\t\t\t\t\t})',
      '\t\t\t\t\t});',
      '\t\t\t\t\tif (response.status !== 200) return;',
      '\t\t\t\t\tconst answer = await response.json();',
      '\t\t\t\t\tif (answer === null || typeof answer !== "object" || answer.ok !== true || answer.models === void 0) return;',
      '\t\t\t\t\tsetCapabilities(new Map(Object.entries(answer.models)));',
      '\t\t\t\t} catch {',
      '\t\t\t\t\t/* 探测插件缺席（404/未重启）：不显示徽标，其余功能不受影响 */',
      '\t\t\t\t}',
      '\t\t\t};',
      '\t\t\t(0, react.useEffect)(() => {',
      '\t\t\t\tloadCapabilities();',
      '\t\t\t}, [capabilityKey]);',
      '\t\t\tconst testAllModels = async () => {',
      '\t\t\t\tconst targets = models.map((model, at) => ({ at, id: textOf(model, "id").trim() })).filter((row) => row.id.length > 0);',
      '\t\t\t\tif (targets.length === 0 || testingAll) return;',
      '\t\t\t\tsetTestingAll(true);',
      '\t\t\t\ttry {',
      '\t\t\t\t\tfor (const target of targets) await testModel(target.at, models[target.at]);',
      '\t\t\t\t} finally {',
      '\t\t\t\t\tsetTestingAll(false);',
      '\t\t\t\t}',
      '\t\t\t};',
    ],
  },
  {
    // B（UI 侧）：「测试全部」按钮，挂在模型列表头「获取可用模型」右侧。
    // 锚点是获取按钮的 children 行；+1 是其 `})`，插后即落在头部 children 数组内。
    id: 'test-all-button',
    mode: 'insertAfterOffset',
    anchor: 'children: busy ? t("fetching") : t("fetchModels")',
    offset: 1,
    expect: '})',
    lines: [
      '\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("button", {',
      '\t\t\t\t\t\t\t\ttype: "button",',
      '\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["linkButton"],',
      '\t\t\t\t\t\t\t\tdisabled: disabled || busy || testingAll || !askable || props.probeBlocked !== void 0 || models.length === 0,',
      '\t\t\t\t\t\t\t\ttitle: t("testAllModels"),',
      '\t\t\t\t\t\t\t\tonClick: () => {',
      '\t\t\t\t\t\t\t\t\ttestAllModels();',
      '\t\t\t\t\t\t\t\t},',
      '\t\t\t\t\t\t\t\tchildren: testingAll ? t("testingAll") : t("testAllModels")',
      '\t\t\t\t\t\t\t}),',
    ],
  },
]

/** 一份 bundle 文本的 SHA-256（大写十六进制），与三个常量同一口径。 */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase()
}

/**
 * 语法闸门：产物必须是可解析的**经典脚本**。
 *
 * 按 script 目标解析而不是 ESM（`node --check` + `.mjs`）：这些 client bundle 的真实形态是
 * `window.__ModuleLoader__.load({ id, factory })`，浏览器按普通脚本求值。用 `vm.Script`
 * 与加载路径一致，V8 报出的行号能直接对回文件行，排查不必二次换算。
 *
 * **为什么必须有这道闸门（2026-09-19 事故）**：`verify` 原本只做「重建产物 == baseline 产物」
 * 的逐字节比对——它证明的是**可复现**，不是**合法**。locale 字典里漏掉一个尾逗号时，
 * 重建产物与 baseline 逐字节一致、`verify` 照常 PASS，但产物是语法错误。
 * 代价远不止少一个按钮：client bundle 是多包合并产物，一个包语法坏了会让**整份 bundle
 * 全部不注册**，浏览器直接报 `failed to import loader entry … loaded without registering`，
 * 页面里所有插件一起失效。语法闸门是这条链上唯一能挡住它的东西。
 *
 * @param {string} source 待校验的 bundle 全文
 * @param {string} label 出错时用于指名对象（如「重建产物」/ 目标文件路径）
 */
export function assertParses(source, label) {
  try {
    new Script(source, { filename: 'bundle.js' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} 不是合法 JavaScript：${message}${locateSyntaxError(error, source)}`)
  }
}

/**
 * 语法判定的非抛错版本：合法返回 null，非法返回一句可读的原因（含行号）。
 * `status` / `apply` 需要的是「能报出来」而不是「当场炸」，故与 assertParses 并存。
 */
export function parseVerdict(source) {
  try {
    new Script(source, { filename: 'bundle.js' })
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : ''
    const hit = /bundle\.js:(\d+)/.exec(stack)
    return hit === null ? message : `${message}（第 ${hit[1]} 行）`
  }
}

/** 从 SyntaxError 的调用栈里抠出 `bundle.js:<行号>`，附上该行 ± 2 行上下文。 */
function locateSyntaxError(error, source) {
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : ''
  const hit = /bundle\.js:(\d+)/.exec(stack)
  if (hit === null) return ''
  const line = Number(hit[1])
  const lines = source.split('\n')
  const from = Math.max(0, line - 3)
  const to = Math.min(lines.length, line + 2)
  const context = []
  for (let i = from; i < to; i += 1) {
    context.push(`       ${i + 1 === line ? '>>' : '  '} ${i + 1}: ${lines[i]}`)
  }
  return `\n       出错行 ${line}：\n${context.join('\n')}`
}

/**
 * 字典替换的结构不变量：`replaceLine` 是「一行 → 多行」的字典展开，除最后一行外，
 * 每个词条行都必须以逗号结尾，否则整个对象字面量缺分隔符。
 *
 * 这是针对上述事故的**定点补强**：语法闸门能兜住，但它报的是 V8 在几百行之外撞到
 * 裸标识符（`Unexpected identifier`），极具误导性；这里能直接点名是哪条编辑的第几行、
 * 少了哪个逗号。
 *
 * 注意：发出的逗号写在**字符串内部**（`'… "value",'` —— 逗号在单引号之内），
 * 行尾那个逗号只是数组元素分隔符，二者不可混淆。
 */
function assertDictionaryContinued(edit) {
  if (edit.mode !== 'replaceLine') return
  for (let i = 0; i < edit.lines.length - 1; i += 1) {
    if (!edit.lines[i].trimEnd().endsWith(',')) {
      throw new Error(`${edit.id}: 第 ${i + 1} 行词条缺尾逗号（除最后一行外都必须以逗号结尾）：${JSON.stringify(edit.lines[i])}`)
    }
  }
}

/** 定位唯一的锚点行；不唯一即报错（宁可失败，也不瞎改）。 */
function findUnique(lines, anchor) {
  const hits = []
  for (let i = 0; i < lines.length; i += 1) if (lines[i].trim() === anchor) hits.push(i)
  if (hits.length !== 1) throw new Error(`锚点必须唯一：${anchor}（命中 ${hits.length} 次）`)
  return hits[0]
}

/**
 * 把一条 EDITS 项解析成**具体编辑**列表。
 *
 * 两种形态：
 * - 单条：`{ id, mode, anchor, lines, … }` —— 自身即一次编辑。
 * - 变体：`{ id, variants: [{ probe, edits: [...] }, …] }` —— 同一处 UI 在 DSH 两代里结构不同时用。
 *   `probe` 是一行源码文本，trim 后全等且在源文件里出现即选中该变体。
 *
 * 没有任何 probe 命中就报错：「两个已知版本都不匹配」必须响亮失败，不能静默跳过——
 * 静默跳过的后果是补丁"成功"了但 UI 不在位，而那要等用户打开设置页才发现。
 *
 * @param lines - 源文件切分后的行数组（只读，仅用于探测）。
 * @param edit - EDITS 里的一项。
 * @returns 要按顺序施加的编辑。
 */
function resolveEdits(lines, edit) {
  if (edit.variants === undefined) return [edit]
  const chosen = edit.variants.find((variant) => lines.some((line) => line.trim() === variant.probe))
  if (chosen === undefined) {
    const probes = edit.variants.map((variant) => JSON.stringify(variant.probe)).join('、')
    throw new Error(`${edit.id}: 没有任何变体的探测锚点命中（试过：${probes}）——DSH 版本已超出本补丁已知的两代，需人工适配`)
  }
  return chosen.edits
}

/** 施加一条具体编辑：锚点唯一命中后按 mode 插入或替换。 */
function applyOne(lines, edit) {
  const at = findUnique(lines, edit.anchor)
  if (edit.mode === 'insertBefore') {
    lines.splice(at, 0, ...edit.lines)
  } else if (edit.mode === 'insertAfter') {
    lines.splice(at + 1, 0, ...edit.lines)
  } else if (edit.mode === 'insertAfterOffset') {
    const target = at + edit.offset
    const actual = lines[target] === undefined ? null : lines[target].trim()
    if (actual !== edit.expect) {
      throw new Error(`${edit.id}: 期望锚点 +${edit.offset} 行为 ${JSON.stringify(edit.expect)}，实际 ${JSON.stringify(actual)}`)
    }
    lines.splice(target + 1, 0, ...edit.lines)
  } else if (edit.mode === 'replaceLine') {
    lines.splice(at, 1, ...edit.lines)
  } else {
    throw new Error(`${edit.id}: 未知的编辑模式 ${edit.mode}`)
  }
}

/**
 * 把补丁应用到一份 bundle 文本上，返回新文本。
 * 纯函数：不碰文件系统，便于 `verify` 与单测直接调用。
 */
export function applyPatch(source) {
  if (source.includes(PATCH_MARKER)) throw new Error('该文件已包含补丁标记，拒绝重复应用')
  // 稀疏数组守卫：`[a,,b]` 语法合法但会在 lines 里留一个 undefined 空洞，
  // 随后以 `Cannot read properties of undefined (reading 'trim')` 的形式
  // 在几百行之外炸开，极难定位。编辑规则是手写的，就在这里当场拦住。
  // 变体形态下逐个检查其子编辑，守卫不因分层而漏。
  for (const edit of EDITS) {
    for (const one of (edit.variants ?? [edit]).flatMap((entry) => entry.edits ?? [entry])) {
      if (one.lines.some((line) => typeof line !== 'string')) {
        throw new Error(`${one.id}: lines 含非字符串项（多半是数组里多写了一个逗号，形成空洞）`)
      }
      assertDictionaryContinued(one)
    }
  }
  const lines = source.split('\n')
  for (const edit of EDITS) {
    for (const one of resolveEdits(lines, edit)) applyOne(lines, one)
  }
  // 语法闸门放在纯函数出口，verify / apply / rebuild 三条路径全部自动继承——
  // 任何"能产出、但产不出合法 JS"的编辑规则都出不了这个函数（详见 assertParses 注释）。
  const output = lines.join('\n')
  assertParses(output, 'applyPatch 产物')
  return output
}

/** 判定一份 bundle 的状态：original / patched / unknown。 */
export function classify(text) {
  const sha = sha256(text)
  if (sha === ORIGINAL_SHA256) return { state: 'original', sha }
  if (text.includes(PATCH_MARKER)) return { state: 'patched', sha }
  return { state: 'unknown', sha }
}

/** 定位已安装的 client.js：环境变量 → npm 全局目录 → 常见 POSIX 路径。 */
function defaultTarget() {
  const candidates = []
  if (process.env.MIASAKI_DSH_BUNDLE) candidates.push(process.env.MIASAKI_DSH_BUNDLE)
  // TARGET_PACKAGE 已含 scope，故这里只补「dsh 包内的嵌套 node_modules」前缀。
  const rel = join('@deepseek-ai', 'dsh', 'node_modules', TARGET_PACKAGE, 'lib', 'client.js')
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', rel))
  candidates.push(join('/usr/local/lib/node_modules', rel))
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

function parseArgs(argv) {
  const args = { mode: argv[0] ?? 'status', yes: false, target: null }
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--yes') args.yes = true
    else if (argv[i] === '--target') { args.target = argv[i + 1] ?? null; i += 1 }
  }
  return args
}

/**
 * verify：baseline 原始文件 → 重建 → 与 baseline 产物逐字节比对，两侧都过语法闸门。
 *
 * 两侧都查是刻意的：只查重建产物会漏掉「golden 被手工改过」的情形——
 * 那种情况下的症状是"重建与 baseline 不一致"，但真正的原因是 baseline 坏了。
 */
async function cmdVerify() {
  const original = await readFile(ORIGINAL_FILE, 'utf8')
  const patched = await readFile(PATCHED_FILE, 'utf8')
  assertParses(patched, 'baseline/client.patched.js')
  const rebuilt = applyPatch(original)
  const sha = sha256(rebuilt)
  if (rebuilt !== patched) {
    console.error(`[patch] FAIL 重建结果与 baseline 产物不一致`)
    console.error(`  重建 SHA-256: ${sha}`)
    console.error(`  baseline     : ${sha256(patched)}`)
    console.error(`  长度 重建=${Buffer.byteLength(rebuilt, 'utf8')} baseline=${Buffer.byteLength(patched, 'utf8')}`)
    process.exitCode = 1
    return
  }
  console.log(`[patch] PASS 由 baseline 原始文件重建出逐字节一致的补丁产物（${EDITS.length} 条编辑，SHA-256 ${sha.slice(0, 16)}…）`)
  console.log('[patch] PASS 两侧产物的语法闸门通过（vm.Script / 经典脚本目标）')
  // 常量自洽性：只比对「重建 vs 磁盘 golden」的话，改了 EDITS 又重生成 golden 却不更新
  // PATCHED_SHA256，verify 依然 PASS —— 常量会长期漂移而无人察觉（本补丁曾吃过同类亏）。
  if (sha !== PATCHED_SHA256) {
    console.error(`[patch] FAIL PATCHED_SHA256 常量与产物不一致`)
    console.error(`  产物  : ${sha}`)
    console.error(`  常量  : ${PATCHED_SHA256}`)
    console.error(`  修法  : 把上面「产物」那行写回 patch.mjs 的 PATCHED_SHA256`)
    process.exitCode = 1
    return
  }
  console.log('[patch] PASS PATCHED_SHA256 常量与产物一致')
}

async function cmdStatus(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_BUNDLE）')
    process.exitCode = 2
    return
  }
  const text = await readFile(target, 'utf8')
  const { state, sha } = classify(text)
  const backup = `${target}.dsh-bak`
  console.log(`[patch] 目标   ${target}`)
  console.log(`[patch] 状态   ${state}  (SHA-256 ${sha.slice(0, 16)}…)`)
  console.log(`[patch] 备份   ${existsSync(backup) ? backup : '（无）'}`)
  // 语法状态是**独立于补丁状态**的一维：文件可以"打过了"却依然语法错误
  // （2026-09-19 事故即如此：状态 patched、SHA 与常量一致，产物却是坏的）。
  const broken = parseVerdict(text)
  console.log(`[patch] 语法   ${broken === null ? '合法' : `非法 —— ${broken}`}`)
  if (broken !== null) {
    console.log('[patch] 警告   该文件正在让整份 client bundle 无法注册（页面所有插件失效）')
    console.log('[patch] 处置   先修规则与 baseline（改 EDITS → node patch.mjs rebuild → verify），再 node patch.mjs resync')
  }
  if (state === 'unknown') {
    console.log(`[patch] 提示   该文件既非 ${BASELINE_DSH_VERSION} 原版也非补丁版——DSH 很可能已升级，需先核对锚点再适配`)
  }
}

async function cmdApply(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_BUNDLE）')
    process.exitCode = 2
    return
  }
  const text = await readFile(target, 'utf8')
  const { state } = classify(text)
  if (state === 'patched') {
    // 幂等跳过前先看一眼语法：补丁标记在场 ≠ 产物合法。
    // 若这里是坏的，静默跳过等于把一个已经打坏的文件留在生产路径上。
    const broken = parseVerdict(text)
    if (broken === null) {
      console.log('[patch] 已应用，跳过（幂等）')
      return
    }
    console.error(`[patch] 已应用但产物语法非法：${broken}`)
    console.error('[patch] 幂等跳过会把它继续留在页面上；请用 `node patch.mjs resync` 由 backup 重打')
    process.exitCode = 1
    return
  }
  if (state === 'unknown' && !args.yes) {
    console.error('[patch] 目标文件不是已知的原始版本，可能已被其他改动或 DSH 升级过；确认无误后加 --yes 强制应用')
    process.exitCode = 2
    return
  }
  const patched = applyPatch(text)
  const backup = `${target}.dsh-bak`
  if (!existsSync(backup)) await copyFile(target, backup)
  await writeFile(target, patched, 'utf8')
  const sha = sha256(patched)
  console.log(`[patch] 已应用 → ${target}`)
  console.log(`[patch] 备份   ${backup}`)
  console.log(`[patch] 结果   ${Buffer.byteLength(patched, 'utf8')} 字节，SHA-256 ${sha.slice(0, 16)}…${sha === PATCHED_SHA256 ? '（与 baseline 产物一致）' : ''}`)
  console.log('[patch] 提示   浏览器侧生效需刷新页面；若 DSH host 启动早于本次写入，client-hmr 会热推 rebuilt 帧')
}

/**
 * resync：备份 → 重打，一步到位。
 *
 * 存在意义：`apply` 对"已打过标记"的文件是幂等跳过的，于是**规则修好后无法直接重打**
 * ——必须先 `revert` 再 `apply`。这是 2026-09-19 修语法错误时踩到的操作坑，固化成命令。
 * 安全性：只有备份确实是已知官方原版（SHA == ORIGINAL_SHA256）才动手；否则拒绝，
 * 因为那种情况的正确处理是 rebuild-baseline 重新适配锚点，而不是拿一份来历不明的备份覆盖。
 */
async function cmdResync(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_BUNDLE）')
    process.exitCode = 2
    return
  }
  const backup = `${target}.dsh-bak`
  if (!existsSync(backup)) {
    console.error(`[patch] 没有备份可用：${backup}——无法 resync（该文件从未被本补丁改过？直接用 apply）`)
    process.exitCode = 2
    return
  }
  const backupText = await readFile(backup, 'utf8')
  if (sha256(backupText) !== ORIGINAL_SHA256) {
    console.error('[patch] 备份不是已知的官方原版，拒绝 resync（避免拿来历不明的备份覆盖）')
    console.error(`[patch] 备份 SHA-256 ${sha256(backupText).slice(0, 16)}…，期望 ${ORIGINAL_SHA256.slice(0, 16)}…`)
    console.error('[patch] 提示   若 DSH 已升级，请改走 rebuild-baseline 重新适配锚点')
    process.exitCode = 2
    return
  }
  const patched = applyPatch(backupText)
  await writeFile(target, patched, 'utf8')
  const sha = sha256(patched)
  console.log(`[patch] 已由备份重打 → ${target}`)
  console.log(`[patch] 结果   ${Buffer.byteLength(patched, 'utf8')} 字节，SHA-256 ${sha.slice(0, 16)}…${sha === PATCHED_SHA256 ? '（与 baseline 产物一致）' : '（注意：与 PATCHED_SHA256 常量不一致，记得同步）'}`)
  console.log('[patch] 提示   浏览器侧生效需刷新页面')
}

/** rebuild：由 baseline 原始文件重新生成补丁产物，并打印待同步的常量。 */
async function cmdRebuild() {
  const original = await readFile(ORIGINAL_FILE, 'utf8')
  const rebuilt = applyPatch(original)
  await writeFile(PATCHED_FILE, rebuilt, 'utf8')
  const sha = sha256(rebuilt)
  console.log(`[patch] 已由 baseline 原始文件重建 ${PATCHED_FILE}`)
  console.log(`[patch] 产物   ${Buffer.byteLength(rebuilt, 'utf8')} 字节，SHA-256 ${sha}`)
  if (sha === PATCHED_SHA256) {
    console.log('[patch] 与 patch.mjs 的 PATCHED_SHA256 常量一致，无需同步')
  } else {
    console.log('[patch] 与常量不一致——请同步（本脚本刻意不代劳，改常量是有语义的决策）：')
    console.log(`        export const PATCHED_SHA256 = '${sha}'`)
  }
}

async function cmdRevert(args) {
  const target = args.target ?? defaultTarget()
  if (target === null) {
    console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_BUNDLE）')
    process.exitCode = 2
    return
  }
  const backup = `${target}.dsh-bak`
  if (!existsSync(backup)) {
    console.error(`[patch] 没有备份可还原：${backup}`)
    process.exitCode = 2
    return
  }
  await copyFile(backup, target)
  console.log(`[patch] 已还原 ${target} ← ${backup}`)
}

// 仅在直接执行时跑 CLI（被 import 时不执行）。
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2))
  const commands = { verify: cmdVerify, status: cmdStatus, apply: cmdApply, revert: cmdRevert, resync: cmdResync, rebuild: cmdRebuild }
  const command = commands[args.mode]
  if (command === undefined) {
    console.error(`[patch] 未知模式：${args.mode}（可选 verify / status / apply / resync / revert / rebuild）`)
    process.exitCode = 2
  } else {
    // 锚点缺失/不唯一时给出可读结论，而不是抛裸栈——这是 DSH 升级后最可能的失败点。
    try {
      await command(args)
    } catch (error) {
      console.error(`[patch] 失败：${error instanceof Error ? error.message : String(error)}`)
      console.error('[patch] 提示：锚点失效通常意味着 DSH 已升级；请按 README「升级后怎么办」核对锚点并更新 EDITS 与 baseline。')
      process.exitCode = 1
    }
  }
}
