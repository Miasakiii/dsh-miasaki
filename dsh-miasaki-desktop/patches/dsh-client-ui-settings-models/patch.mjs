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
//   node patch.mjs verify            # 离线自检：baseline 原始 → 重建 → 与 baseline 产物逐字节比对
//   node patch.mjs status            # 检查已安装 bundle 的补丁状态
//   node patch.mjs apply [--yes]     # 备份 + 应用（幂等：已打过则跳过）
//   node patch.mjs revert            # 从 .dsh-bak 还原
//   通用参数：--target <client.js 路径>  覆盖自动探测
//
// 设计文档：../../dsh-miasaki-shared-docs/cross/model-settings-toolkit-design-2026-09-07.md

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(HERE, 'baseline')
const ORIGINAL_FILE = join(BASELINE, 'client.original.js')
const PATCHED_FILE = join(BASELINE, 'client.patched.js')

export const TARGET_PACKAGE = '@deepseek-ai/dsh-client-ui-settings-models'
/** DSH 版本基线：锚点文本与两份 baseline 都取自这个版本。 */
export const BASELINE_DSH_VERSION = '0.1.5-rc.1'
/** 官方原版 client.js 的 SHA-256（与安装目录的 client.js.dsh-bak 逐字节一致）。 */
export const ORIGINAL_SHA256 = 'A60FD86357F9FBC6F5276ED0393682F7F2223FAEDEC4F30C719D66E99600B1BB'
/** 应用本补丁后的 SHA-256（安装目录 2026-09-10 起的状态）。 */
export const PATCHED_SHA256 = 'E602C1F1518F5436D8624B30A4295ECBB525655C8CA004AD264F04EC84DBED45'
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
      '\t\t/** CSS class for one connectivity result: the success or error tone. */',
      '\t\tfunction testResultClass(ok, stylesRef) {',
      '\t\t\treturn ok ? stylesRef["savedNotice"] : stylesRef["error"];',
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
      '\t\t\t\ttry {',
      '\t\t\t\t\tconst answer = await operations.discoverModels(probe.settingsNs, {',
      '\t\t\t\t\t\t...probe.provider === void 0 ? {} : { provider: probe.provider },',
      '\t\t\t\t\t\t...probe.baseURL === void 0 || probe.baseURL.length === 0 ? {} : { baseURL: probe.baseURL },',
      '\t\t\t\t\t\t...probe.api === void 0 ? {} : { api: probe.api },',
      '\t\t\t\t\t\t...probe.apiKey === void 0 ? {} : { apiKey: probe.apiKey }',
      '\t\t\t\t\t});',
      '\t\t\t\t\tif (answer.kind === "refused") {',
      '\t\t\t\t\t\tsetTestResults((prev) => new Map(prev).set(index, { ok: false, message: answer.message }));',
      '\t\t\t\t\t\treturn;',
      '\t\t\t\t\t}',
      '\t\t\t\t\tconst found = answer.models.some((candidate) => candidate.id === id);',
      '\t\t\t\t\tsetTestResults((prev) => new Map(prev).set(index, {',
      '\t\t\t\t\t\tok: true,',
      '\t\t\t\t\t\tmessage: found ? t("testSuccess") : t("testReachableNotListed")',
      '\t\t\t\t\t}));',
      '\t\t\t\t} catch (error) {',
      '\t\t\t\t\tconst explain = error && typeof error === "object" && "message" in error ? error.message : String(error);',
      '\t\t\t\t\tsetTestResults((prev) => new Map(prev).set(index, { ok: false, message: explain }));',
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
    // 插入点不是锚点本身，而是「maxTokens 输入框闭合」之后（锚点 +2 行），
    // 因此在锚点之外额外断言目标行内容，避免 DSH 改版后插错层级。
    id: 'reasoning-ui',
    mode: 'insertAfterOffset',
    anchor: 'editCapacity(index, "maxTokens", event.target.value);',
    offset: 2,
    expect: '})]',
    lines: [
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
      '\t\t\t\t\t\t\t\t\tchildren: [...REASONING_LEVELS.map((level) => (0, react_jsx_runtime.jsx)("option", { key: level, value: level, children: level })), (0, react_jsx_runtime.jsx)("option", { value: "inherit", children: t("modelReasoningInherit") }), (0, react_jsx_runtime.jsx)("option", { value: "disabled", children: t("modelReasoningDisabled") })]',
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
      '\t\t\ttestReachableNotListed: "Reachable, but not listed in catalog"',
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
      '\t\t\ttestReachableNotListed: "可达，但目录中未列出"',
    ],
  },
]

/** 定位唯一的锚点行；不唯一即报错（宁可失败，也不瞎改）。 */
function findUnique(lines, anchor) {
  const hits = []
  for (let i = 0; i < lines.length; i += 1) if (lines[i].trim() === anchor) hits.push(i)
  if (hits.length !== 1) throw new Error(`锚点必须唯一：${anchor}（命中 ${hits.length} 次）`)
  return hits[0]
}

/**
 * 把补丁应用到一份 bundle 文本上，返回新文本。
 * 纯函数：不碰文件系统，便于 `verify` 与单测直接调用。
 */
export function applyPatch(source) {
  if (source.includes(PATCH_MARKER)) throw new Error('该文件已包含补丁标记，拒绝重复应用')
  let lines = source.split('\n')
  for (const edit of EDITS) {
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
  return lines.join('\n')
}

/** 判定一份 bundle 的状态：original / patched / unknown。 */
export function classify(text) {
  const sha = createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase()
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

/** verify：baseline 原始文件 → 重建 → 与 baseline 产物逐字节比对。 */
async function cmdVerify() {
  const original = await readFile(ORIGINAL_FILE, 'utf8')
  const patched = await readFile(PATCHED_FILE, 'utf8')
  const rebuilt = applyPatch(original)
  const sha = createHash('sha256').update(rebuilt, 'utf8').digest('hex').toUpperCase()
  if (rebuilt !== patched) {
    console.error(`[patch] FAIL 重建结果与 baseline 产物不一致`)
    console.error(`  重建 SHA-256: ${sha}`)
    console.error(`  baseline     : ${createHash('sha256').update(patched, 'utf8').digest('hex').toUpperCase()}`)
    console.error(`  长度 重建=${Buffer.byteLength(rebuilt, 'utf8')} baseline=${Buffer.byteLength(patched, 'utf8')}`)
    process.exitCode = 1
    return
  }
  console.log(`[patch] PASS 由 baseline 原始文件重建出逐字节一致的补丁产物（${EDITS.length} 条编辑，SHA-256 ${sha.slice(0, 16)}…）`)
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
    console.log('[patch] 已应用，跳过（幂等）')
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
  const sha = createHash('sha256').update(patched, 'utf8').digest('hex').toUpperCase()
  console.log(`[patch] 已应用 → ${target}`)
  console.log(`[patch] 备份   ${backup}`)
  console.log(`[patch] 结果   ${Buffer.byteLength(patched, 'utf8')} 字节，SHA-256 ${sha.slice(0, 16)}…${sha === PATCHED_SHA256 ? '（与 baseline 产物一致）' : ''}`)
  console.log('[patch] 提示   浏览器侧生效需刷新页面；若 DSH host 启动早于本次写入，client-hmr 会热推 rebuilt 帧')
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
  const commands = { verify: cmdVerify, status: cmdStatus, apply: cmdApply, revert: cmdRevert }
  const command = commands[args.mode]
  if (command === undefined) {
    console.error(`[patch] 未知模式：${args.mode}（可选 verify / status / apply / revert）`)
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
