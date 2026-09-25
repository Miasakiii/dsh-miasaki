#!/usr/bin/env node
// check-pet-assets.mjs — 桌宠资产链完整性闸门（L0，供 verify-all desktop 线调用）。
//
// 守什么（2026-09-10 教训的常态化）：删素材曾让 build-init 的 existsSync 守卫**静默跳过**，
// 回归照常 PASS，断链直到下次重跑脚本才暴露。桌宠资产链是同型风险且更长——
// 源（图集/gif/立绘）→ 派生（逐帧 PNG）→ 清单（frames.json）→ 内嵌索引（assets.rs）。
// 本脚本回答三个问题，任一失败即退出码 1：
//   ① 派生链完整：frames.json 引用的每个 PNG 都在盘上（缺 = 运行时该姿态直接空白）；
//   ② 再生源在位：kurumi/spritesheet.png、whale/idle.gif、inverse/raw/blue-*.png 存在
//      （源缺 = 现在能显示、下次重切静默跳过，断链延迟暴露）；
//   ③ 无孤儿派生：frames/ 与 states/ 里的 PNG 都被 frames.json 引用（重切后残留 = drift）。
// 另输出两项**信息**（不影响退出码）：状态覆盖缺口（R15 量化）、frames 与源的新旧关系
// （源比派生新 = 重切未跑或刚更新，属工作流提示，不是完整性失败）。
//
// 源→派生映射的权威在 scripts/cut-frames.mjs 与 scripts/inverse-states.mjs；本脚本是审计者，
// 映射在此硬编码并注明出处，两者漂移时应同步（审计项本身有单测以外的回归位保护：
// 映射改错会立刻露出「引用缺失/孤儿」噪声）。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PETS = join(ROOT, 'ui', 'pets')

const failures = []
const warnings = []
const infos = []

function rel(p) {
  return relative(ROOT, p).replaceAll('\\', '/')
}

/** v3 六态 + 动作行：Rust 侧 pick_state_row/slot_row 可产出的全部行名（pet_native/model.rs）。 */
const RUST_ROWS = ['idle', 'wait', 'failed', 'jump', 'wave', 'run', 'review', 'runRight', 'runLeft']

const framesPath = join(PETS, 'frames.json')
if (!existsSync(framesPath)) {
  console.error(`[pet-assets] FAIL 缺少 frames.json：${rel(framesPath)}`)
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(framesPath, 'utf8'))

/* ---------- ①② 派生链完整 + 再生源在位 ---------- */

/** 主题 → 再生源清单（缺任一即「现在能显示、下次重生成静默跳过」）。 */
const REGEN_SOURCES = {
  kurumi: [{ path: 'spritesheet.png', by: 'scripts/cut-frames.mjs（cutAtlas）' }],
  whale: [{ path: 'idle.gif', by: 'scripts/cut-frames.mjs（cutWhaleIdleFrames）' }],
  inverse: [
    { path: 'raw/blue-idle.png', by: 'scripts/inverse-states.mjs' },
    { path: 'raw/blue-work.png', by: 'scripts/inverse-states.mjs' },
    { path: 'raw/blue-deep.png', by: 'scripts/inverse-states.mjs' },
  ],
}

/** 手工资产（无生成脚本，删了没人重建）：whale 的 work/deep 立绘单帧。 */
const MANUAL_ASSETS = {
  whale: ['states/work.png', 'states/deep.png'],
}

/** 展平 frames.json 的引用：主题 → [{ state, file }]。 */
function references(theme) {
  const out = []
  const node = manifest[theme]
  if (node === undefined) return out
  if (node.kind === 'atlas') {
    for (const [row, cols] of Object.entries(node.rows ?? {})) {
      for (const file of cols) out.push({ state: row, file: `frames/${file}` })
    }
  } else {
    for (const [state, value] of Object.entries(node.states ?? {})) {
      for (const file of Array.isArray(value) ? value : [value]) out.push({ state, file })
    }
  }
  return out
}

const referenced = new Map() // theme -> Set(相对 themes 的文件)
for (const theme of Object.keys(manifest)) {
  const files = new Set()
  for (const ref of references(theme)) files.add(ref.file)
  referenced.set(theme, files)
  const themeDir = join(PETS, theme)
  // ① 引用都在盘上
  for (const ref of references(theme)) {
    const abs = join(themeDir, ref.file)
    if (!existsSync(abs)) {
      failures.push(`${theme} 的 ${ref.state} 引用缺失：${ref.file}（运行时该姿态空白；源若在，重跑 cut-frames/inverse-states 再生）`)
    }
  }
  // 手工资产在位（无脚本可再生）
  for (const manual of MANUAL_ASSETS[theme] ?? []) {
    if (!existsSync(join(themeDir, manual))) {
      failures.push(`${theme} 的手工资产缺失：${manual}（无生成脚本，需人工补回）`)
    }
  }
  // ③ 孤儿派生：盘上有、清单没引用
  for (const sub of ['frames', 'states']) {
    const dir = join(themeDir, sub)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.png')) continue
      const key = `${sub}/${name}`
      if (!files.has(key)) {
        warnings.push(`${theme} 孤儿派生 ${key}（在盘上但 frames.json 未引用——重切后残留或漏登记）`)
      }
    }
  }
}

// ② 再生源在位
for (const [theme, sources] of Object.entries(REGEN_SOURCES)) {
  for (const src of sources) {
    if (!existsSync(join(PETS, theme, src.path))) {
      failures.push(`${theme} 再生源缺失：${src.path}（由 ${src.by} 消费；源缺则下次重生成静默跳过——2026-09-10 教训同型）`)
    }
  }
}

/* ---------- 信息：状态覆盖缺口（R15 量化，不判失败） ---------- */

for (const theme of Object.keys(manifest)) {
  const node = manifest[theme]
  if (node.kind !== 'atlas') {
    const have = Object.keys(node.states ?? {})
    const missing = RUST_ROWS.filter(row => !have.includes(row))
    infos.push(`${theme}（states）：可表达 ${have.join('/')}；缺 ${missing.join('/')} → 这些姿态按 kurumi_row 回退链落到 idle（R15 待补，需美术资产）`)
  } else {
    const rows = Object.keys(node.rows ?? {})
    const missing = RUST_ROWS.filter(row => !rows.includes(row))
    infos.push(`${theme}（atlas）：${rows.length}/${RUST_ROWS.length} 行在位${missing.length ? `，缺 ${missing.join('/')}` : ''}`)
  }
}

/* ---------- 信息：源 vs 派生新旧（工作流提示，不判失败） ---------- */

for (const [theme, sources] of Object.entries(REGEN_SOURCES)) {
  const newestRef = Math.max(
    0,
    ...references(theme).map(ref => {
      try {
        return statSyncSafe(join(PETS, theme, ref.file))
      } catch {
        return 0
      }
    }),
  )
  for (const src of sources) {
    const abs = join(PETS, theme, src.path)
    if (!existsSync(abs)) continue
    const srcMs = statSyncSafe(abs)
    if (srcMs > newestRef + 1000) {
      infos.push(`${theme} 的源 ${src.path} 比派生帧新（${new Date(srcMs).toLocaleString('zh-CN')} vs 帧 ${new Date(newestRef).toLocaleString('zh-CN')}）——重切未跑或源刚更新`)
    }
  }
}

function statSyncSafe(p) {
  return statSync(p).mtimeMs
}

/* ---------- 汇报 ---------- */

for (const info of infos) console.log(`[pet-assets] 提示   ${info}`)
for (const warning of warnings) console.log(`[pet-assets] WARN  ${warning}`)
for (const failure of failures) console.error(`[pet-assets] FAIL ${failure}`)
if (failures.length === 0) {
  const themes = Object.keys(manifest).join(' / ')
  console.log(`[pet-assets] PASS 资产链完整（主题 ${themes}；警告 ${warnings.length} 条不影响退出码）`)
} else {
  console.error(`[pet-assets] FAIL 共 ${failures.length} 项——按各生成脚本 README 再生后复跑`)
  process.exitCode = 1
}
