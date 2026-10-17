#!/usr/bin/env node
// check-deploy-guard.mjs — 部署脚本「自宿主防护」闸门（2026-10-17 两次「莫名闪退」事故）。
//
// 事故（实机取证见 design/CHANGELOG.md 2026-10-17 续）：agent 在 miasaki 桌面端
// 自己的会话里执行 `deploy-local.ps1 -Force`。脚本的 Stop-Process 结束「正跑着目标
// exe 的实例」—— 那个实例就是**宿主壳本身**；壳的 KILL_ON_JOB_CLOSE Job 立刻回收
// 后端与**部署脚本自身** ⇒ 复制永远不执行。用户看到「窗口莫名闪退」，而安装目录的
// exe 一直是旧版（两次都如此，部署却显示「执行过」）。
//
// 本闸门守「防护四件套」不被静默删掉 / 被挪到 Stop-Process 之后：
//   ① Get-AncestorPids 祖先链探测；
//   ② $selfHost = blocking ∩ ancestors 交集判定；
//   ③ -ProbeOnly 诊断分支（保住「先探针再部署」的排查路径）；
//   ④ 拦截（exit 1）必须出现在任何 Stop-Process **之前** —— 顺序反了防护就是死代码。
//
// 行为侧自证（真机）：`deploy-local.ps1 -ProbeOnly` 在外部终端返回 SAFE（exit 0）、
// 在壳内会话返回 SELF-HOST（exit 1）。本闸门刻意不跑 PowerShell（CI 上成本与差异
// 都大），只钉结构与顺序 —— 这一层本来就可能被「顺手清理」改坏。

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'deploy-local.ps1')
const rel = relative(ROOT, SCRIPT).replaceAll('\\', '/')

const failures = []

function fail(msg) {
  failures.push(msg)
}

if (!existsSync(SCRIPT)) {
  fail(`缺少 ${rel}（部署入口本身不见了）`)
} else {
  const text = readFileSync(SCRIPT, 'utf8')
  // 顺序判定必须在**代码行**上做：脚本头部注释里也会提到 `Stop-Process`（解释事故），
  // 直接 indexOf 会被注释骗到，得出「拦截在杀之后」的假红。
  const live = text
    .split(/\r?\n/)
    .filter(line => !line.trim().startsWith('#'))
    .join('\n')

  const structures = [
    ['祖先链探测函数 Get-AncestorPids', 'function Get-AncestorPids'],
    ['自宿主交集判定 $selfHost', '$selfHost = @($blocking | Where-Object { $ancestors.Contains($_.Id) })'],
    ['诊断开关 -ProbeOnly（param）', '[switch]$ProbeOnly'],
    ['诊断分支 if ($ProbeOnly)', 'if ($ProbeOnly)'],
    ['拦截分支 if ($selfHost.Count -gt 0)', 'if ($selfHost.Count -gt 0)'],
    ['外部终端指路文案', '外部终端'],
  ]
  for (const [name, needle] of structures) {
    if (!text.includes(needle)) fail(`缺「${name}」（未找到：${needle}）`)
  }

  // 顺序契约①：防护必须先于任何 Stop-Process。否则命中自宿主时壳已被杀，
  // 后面的 abort 分支永远走不到（防护变死代码）。取 lastIndexOf —— 主拦截分支
  // 在 ProbeOnly 诊断分支之后，是真正生效的那一个。
  const guardAt = live.lastIndexOf('if ($selfHost.Count -gt 0)')
  const killAt = live.indexOf('Stop-Process')
  if (guardAt < 0 || killAt < 0) {
    fail('找不到自宿主拦截或 Stop-Process，无法校验顺序')
  } else if (guardAt > killAt) {
    fail('顺序错误：自宿主拦截出现在 Stop-Process 之后（防护成了死代码）')
  }

  // 顺序契约②：判定必须建立在祖先链上 —— $selfHost 赋值不得早于函数定义。
  const fnAt = live.indexOf('function Get-AncestorPids')
  const assignAt = live.indexOf('$selfHost = @($blocking')
  if (fnAt < 0 || assignAt < 0) fail('找不到 Get-AncestorPids 定义或 $selfHost 赋值')
  else if (fnAt > assignAt) fail('顺序错误：$selfHost 判定早于 Get-AncestorPids 定义')
}

if (failures.length > 0) {
  for (const f of failures) console.error(`[deploy-guard] FAIL ${f}`)
  console.error('\n[deploy-guard] 自宿主防护被删/改写了。2026-10-17 连续两次')
  console.error('「窗口莫名闪退 + 部署未生效」的根因就是它：部署脚本先杀了宿主，')
  console.error('然后自己被宿主的 Job 一起回收，复制永远到不了。')
  process.exit(1)
}
console.log('[deploy-guard] PASS 防护四件套完整（探测 / 交集 / 探针 / 先拦后杀）')
