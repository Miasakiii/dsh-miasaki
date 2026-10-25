// config-drift.cjs — P0-B（2026-10-21）：agent 模型来源探测与配置漂移判定
//
// 为什么存在：manifest 的 `model` 长期是 `cli-default`，`model_info` 三态字段在 P0-A 只落成
// 「unknown」。本模块把「每个 coding agent 的**真实模型**从哪读、当前配置与档案是否一致」
// 变成可判定的只读事实 —— 供 scan-models（写入 model_info）与 agent-drift（只读巡检）共用。
//
// 纪律：
//   · **只读**：只做 existsSync / readFileSync，绝不写用户配置目录（动 %USERPROFILE%\.dsh 等
//     必须先问用户，本仓已有成文纪律）；
//   · **不猜**：读不到就是 missing / parse-error / unknown，不拿 `cli-default` 或默认模型冒充；
//   · 判定口径单点在本文件：scan-models 与 agent-drift 不各写一份。
//
// 适配器表在 shared/agent-adapters.json（一个 agent 一条：配置文件 + 模型字段）。
// 支持三种格式：json / jsonc（去注释）/ yaml-regex（用正则抓标量，避免为零依赖引入 YAML 解析器）。

'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ADAPTERS_REL = path.join('shared', 'agent-adapters.json')
const FORMATS = Object.freeze(['json', 'jsonc', 'yaml-regex'])
const DRIFT_STATUSES = Object.freeze(['match', 'replaced', 'missing', 'parse-error', 'unknown'])

/** 展开 %VAR%（Windows 风格）与开头的 ~（home）。未定义的变量原样保留（不猜）。 */
function expandPath(raw, env, home) {
  const e = env || process.env
  const h = home || os.homedir()
  return String(raw == null ? '' : raw)
    .replace(/%([^%]+)%/g, (whole, name) => (Object.prototype.hasOwnProperty.call(e, name) ? e[name] : whole))
    .replace(/^~(?=$|[\\/])/, h)
}

/** 绝对路径 → 仓库相对 posix 路径；仓库外但属 home 的一律脱敏为 %USERPROFILE%。
 *  （evidence 会写进入库 manifest，公开仓库不得含真实用户名路径 —— 2026-10-21 实测踩到。） */
function displayPath(root, abs, home) {
  const rel = path.relative(root, abs)
  if (rel && !rel.startsWith('..')) return rel.split(path.sep).join('/')
  // ⚠️ 路径可能是「反斜杠 + 正斜杠」混合形态（适配器表用 /，展开后是 C:\Users\…/.claude/…）——
  // 必须先 path.normalize 再比较，否则 home 前缀匹配因分隔符不同而失败（2026-10-21 实测踩到）。
  const h = path.normalize(home || os.homedir())
  const absNorm = path.normalize(String(abs))
  const lowAbs = absNorm.toLowerCase()
  const lowHome = h.toLowerCase()
  if (lowHome && (lowAbs === lowHome || lowAbs.startsWith(lowHome + path.sep))) {
    return '%USERPROFILE%' + absNorm.slice(h.length).split(path.sep).join('/')
  }
  return absNorm.split(path.sep).join('/')
}

/**
 * 去掉 JSONC 的 // 与块注释（字符串内的 // 不误伤；转义引号亦跳过）。
 * 只处理注释，不处理尾逗号 —— 配置里出现尾逗号会让 JSON.parse 报 parse-error，
 * 这正是「不猜」的合法结果（而不是悄悄修好它）。
 */
function stripJsonComments(text) {
  const src = String(text == null ? '' : text)
  let out = ''
  let i = 0
  let inString = false
  let escaped = false
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') { inString = true; out += ch; i += 1; continue }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** 按路径段取嵌套值（段可以是字符串或数组下标）。 */
function getPath(obj, segments) {
  let cur = obj
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[seg]
  }
  return cur
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== ''
}

/**
 * 读适配器表。缺文件 / 非法 JSON / 单条非法都**显式返回 problems**（不静默回退）。
 * @returns {{adapters: object, problems: Array<{where: string, message: string}>, source: string|null}}
 */
function loadAdapters(root, warn) {
  const file = path.join(root, ADAPTERS_REL)
  const problems = []
  if (!fs.existsSync(file)) {
    problems.push({ where: ADAPTERS_REL, message: '适配器表不存在（P0-B 未安装或 clone 不完整）' })
    if (typeof warn === 'function') warn(`[config-drift] ${problems[0].message}`)
    return { adapters: {}, problems, source: null }
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    problems.push({ where: ADAPTERS_REL, message: `适配器表 JSON 解析失败：${e.message}` })
    if (typeof warn === 'function') warn(`[config-drift] ${problems[0].message}`)
    return { adapters: {}, problems, source: file }
  }
  const adapters = {}
  for (const [agentId, a] of Object.entries(raw || {})) {
    if (agentId.startsWith('$')) continue // 元数据键（$schema_version / $comment）
    const where = `${ADAPTERS_REL}#${agentId}`
    if (!a || typeof a !== 'object' || Array.isArray(a)) { problems.push({ where, message: '适配器应为 object' }); continue }
    if (!FORMATS.includes(a.format)) { problems.push({ where, message: `format 非法: ${a.format}（应为 ${FORMATS.join('|')}）` }); continue }
    if (!Array.isArray(a.paths) || a.paths.length === 0 || !a.paths.every(isNonEmptyString)) {
      problems.push({ where, message: 'paths 应为非空字符串数组' }); continue
    }
    if (a.format === 'yaml-regex') {
      if (!isNonEmptyString(a.model_regex)) { problems.push({ where, message: 'yaml-regex 需要 model_regex（含一个捕获组）' }); continue }
      try { new RegExp(a.model_regex) } catch (e) { problems.push({ where, message: `model_regex 非法：${e.message}` }); continue }
      if (a.provider_regex) {
        try { new RegExp(a.provider_regex) } catch (e) { problems.push({ where, message: `provider_regex 非法：${e.message}` }); continue }
      }
    } else if (!Array.isArray(a.model_path) || a.model_path.length === 0) {
      problems.push({ where, message: `${a.format} 需要非空 model_path 数组` }); continue
    }
    adapters[agentId] = a
  }
  return { adapters, problems, source: file }
}

function readFirstExisting(adapter, opts) {
  const o = opts || {}
  const env = o.env || process.env
  const home = o.home || os.homedir()
  for (const raw of adapter.paths) {
    const abs = expandPath(raw, env, home)
    if (fs.existsSync(abs)) {
      return { path: abs, text: fs.readFileSync(abs, 'utf8') }
    }
  }
  return { path: expandPath(adapter.paths[0], env, home), text: null }
}

function extractFromJson(text, adapter) {
  const parsed = JSON.parse(adapter.format === 'jsonc' ? stripJsonComments(text) : text)
  const model = getPath(parsed, adapter.model_path)
  const provider = adapter.provider_path ? getPath(parsed, adapter.provider_path) : undefined
  return {
    model: isNonEmptyString(model) ? model : null,
    provider: isNonEmptyString(provider) ? provider : null,
  }
}

function extractFromRegex(text, adapter) {
  const m = new RegExp(adapter.model_regex, 'm').exec(String(text))
  const p = adapter.provider_regex ? new RegExp(adapter.provider_regex, 'm').exec(String(text)) : null
  return {
    model: m && m[1] ? String(m[1]).trim() : null,
    provider: p && p[1] ? String(p[1]).trim() : null,
  }
}

/**
 * 探测单个 agent 的模型来源（只读）。
 *
 * @returns {{status: 'ok'|'missing'|'parse-error'|'unknown',
 *            model: string|null, provider: string|null,
 *            config_path: string, detail: string}}
 *   status=ok 表示**读到了模型字段**；文件在但字段不在 ⇒ unknown；文件都不在 ⇒ missing；
 *   JSON/正则失败 ⇒ parse-error。
 */
function probeAgent(adapter, opts) {
  const o = opts || {}
  const root = o.root || process.cwd()
  const found = readFirstExisting(adapter, o)
  const configPath = displayPath(root, found.path, o.home)
  if (found.text === null) {
    return { status: 'missing', model: null, provider: null, config_path: configPath, detail: `配置文件不存在：${configPath}` }
  }
  try {
    const ext = adapter.format === 'yaml-regex' ? extractFromRegex(found.text, adapter) : extractFromJson(found.text, adapter)
    if (!ext.model) {
      return { status: 'unknown', model: null, provider: ext.provider, config_path: configPath, detail: `配置存在但未找到模型字段（${adapter.model_path ? adapter.model_path.join('.') : adapter.model_regex}）` }
    }
    return { status: 'ok', model: ext.model, provider: ext.provider, config_path: configPath, detail: `读取成功：${configPath}` }
  } catch (e) {
    return { status: 'parse-error', model: null, provider: null, config_path: configPath, detail: `解析失败：${e && e.message ? e.message : String(e)}` }
  }
}

/**
 * 判定漂移：档案声明的模型（model_info.value）vs 当前配置读到的模型。
 * 语义对齐设计文档：match / replaced / missing / parse-error / unknown。
 */
function classifyDrift(declaredModel, probe) {
  const declared = isNonEmptyString(declaredModel) ? declaredModel : null
  const p = probe || {}
  if (p.status === 'missing') return { status: 'missing', detail: p.detail || '配置文件缺失' }
  if (p.status === 'parse-error') return { status: 'parse-error', detail: p.detail || '配置解析失败' }
  if (p.status !== 'ok' || !isNonEmptyString(p.model)) {
    return { status: 'unknown', detail: p.detail || '未能从配置判定模型' }
  }
  if (declared === null) return { status: 'unknown', detail: '档案未声明模型（model_info.value=null），无法比对' }
  if (declared === p.model) return { status: 'match', detail: `档案与配置一致：${declared}` }
  return { status: 'replaced', detail: `配置已改变：档案 ${declared} → 当前 ${p.model}` }
}

module.exports = {
  ADAPTERS_REL,
  FORMATS,
  DRIFT_STATUSES,
  expandPath,
  displayPath,
  stripJsonComments,
  getPath,
  loadAdapters,
  probeAgent,
  classifyDrift,
}
