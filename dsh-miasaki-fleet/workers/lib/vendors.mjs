// vendors.mjs — 厂商表加载（K5，2026-09-30）
//
// 背景（回归矩阵台账 K5 / 内部计划静默失效 #25）：
//   workers/graph/verifier-pick.mjs 过去自带一个 `loadVendors()`，读
//   `shared/agent-vendors.json` —— 而那个文件**从不存在**，读不到就**静默**回退内置表；
//   同时两处文档（verifier.cjs 的 DEFAULT_VENDORS 注释与本文件原 --help）仍宣称
//   「可由它覆盖」。失效形态很坏：默认表与实际厂商归属不符时会给出**假异构**结论
//   （「验证者独立」是虚的），而全程不报错。
//
// 处置：**真读 + 显式告知**（不选「删掉宣称」—— 覆盖能力本身是设计意图）。
//   ① 新增真实文件 `shared/agent-vendors.json`（内置表的镜像，可直接改）；
//   ② 加载逻辑抽到本模块，使「缺文件 / 结构非法」两条回退路径**可测**且**不静默**；
//   ③ 返回 `notice` 让调用方与测试都能分辨「用了哪张表、为什么」。
//
// 纪律：厂商表是 G4 异构验证的**判定依据**，因此「回退」必须留痕 ——
// 静默回退与「删素材静默跳过」同型（本仓 `check-silent-guards` 的 R3 形态）。
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/** 厂商表相对工作区根的路径（--help 与文档都引用这一处）。 */
export const VENDORS_REL = 'shared/agent-vendors.json'

/**
 * 结构判据：顶层 object（非数组），值为非空字符串。
 * `$` 开头的键是元数据（如 `$comment`），忽略。
 * @returns 错误描述，或 null 表示合法
 */
function shapeError(table) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) return '顶层应为 object（agent → 厂商）'
  for (const [k, v] of Object.entries(table)) {
    if (k.startsWith('$')) continue
    if (typeof v !== 'string' || v.trim() === '') return `键「${k}」的值应为非空字符串`
  }
  return null
}

/**
 * 读厂商表。
 *
 * @param root 工作区根
 * @param log  可选的告知通道（默认丢弃）；缺失/非法一律经它显式告知，**绝不静默**
 * @returns `{ vendors, source, notice }` ——
 *   `vendors` 为表（回退时为 `undefined`，调用方自行回退内置 DEFAULT_VENDORS）；
 *   `source` 为 `'<rel>'` 或 `'default'`；`notice` 为 `null | 'missing' | 'invalid-json' | 'invalid-shape'`
 */
export function loadVendors(root, log) {
  const warn = typeof log === 'function' ? log : () => {}
  const p = join(root, VENDORS_REL)
  const rel = (relative(root, p) || VENDORS_REL).split('\\').join('/')

  if (!existsSync(p)) {
    warn(`[vendors] 未提供 ${rel} —— 厂商归属回退内置表 DEFAULT_VENDORS（缺它属正常语义，但不再静默）`)
    return { vendors: undefined, source: 'default', notice: 'missing' }
  }

  let raw = null
  try {
    raw = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    warn(`[vendors] ${rel} 解析失败（${e.message}）—— 回退内置表`)
    return { vendors: undefined, source: 'default', notice: 'invalid-json' }
  }

  const bad = shapeError(raw)
  if (bad) {
    warn(`[vendors] ${rel} 结构非法（${bad}）—— 回退内置表`)
    return { vendors: undefined, source: 'default', notice: 'invalid-shape' }
  }

  const table = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith('$')) table[k] = v
  }
  return { vendors: table, source: rel, notice: null }
}
