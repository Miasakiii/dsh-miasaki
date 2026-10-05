#!/usr/bin/env node
// 九线 + 仓库级统一静态回归入口（L0 静态检查 + L1 单线单测）。
//
// 只跑「无外部依赖、可在任意机器复现」的检查：语法、单测、总线校验、令牌漂移、
// 运行时补丁离线自证。需要运行中的 DSH host 或桌面壳的实机项（L2 插件加载 /
// L3 冒烟 / L4 跨线联动）不在此脚本内——它们的清单在
// dsh-miasaki-shared-docs/cross/smoke-test-matrix.md。
//
// `repo` 是**仓库级治理闸门**（跨九线生效，不属于任何单线）：见 planRepo()。
//
// 用法：
//   node scripts/verify-all.mjs                      # 全部九线 + 仓库级
//   node scripts/verify-all.mjs dual-model           # 只跑指定线
//                     （sidebar / canvas / fleet / desktop / ssh / dual-model / appearance / usage / free-model / repo）
//
// 实现注记：子进程一律 stdio: 'inherit'，不做管道捕获——受限沙箱下捕获另一个
// 程序的 stdio 会以 EPERM 失败，而 inherit 不会。因此本脚本以退出码判定成败，
// 各线的详细输出直接透传到当前终端。

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LINES = ['sidebar', 'canvas', 'fleet', 'desktop', 'ssh', 'dual-model', 'appearance', 'usage', 'free-model', 'repo']

/** Run one command, inheriting stdio; resolves to the exit code. */
function run(cmd, args, cwd) {
  return new Promise(resolvePromise => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: false })
    child.on('error', error => {
      console.error(`  ! spawn ${cmd}: ${error.message}`)
      resolvePromise(-1)
    })
    child.on('close', code => resolvePromise(code ?? -1))
  })
}

/** node --test spawns one child per file and pipes it; run files directly instead so a confined sandbox cannot break the suite. */
async function testFiles(dir) {
  const testDir = join(dir, 'test')
  if (!existsSync(testDir)) return []
  const entries = await readdir(testDir)
  return entries.filter(name => name.endsWith('.test.js')).sort().map(name => join(testDir, name))
}

const checks = []

async function planSidebar() {
  const dir = join(ROOT, 'dsh-miasaki-sidebar')
  checks.push({ line: 'sidebar', name: 'syntax index.js', cmd: process.execPath, args: ['--check', join(dir, 'index.js')], cwd: dir })
  checks.push({ line: 'sidebar', name: 'syntax client.js', cmd: process.execPath, args: ['--check', join(dir, 'client.js')], cwd: dir })
  for (const file of await testFiles(dir)) {
    checks.push({ line: 'sidebar', name: `test ${file.split(/[\\/]/).pop()}`, cmd: process.execPath, args: [file], cwd: dir })
  }
}

async function planCanvas() {
  const dir = join(ROOT, 'dsh-miasaki-canvas')
  for (const entry of ['index.js', 'client.js', 'app.js']) {
    checks.push({ line: 'canvas', name: `syntax ${entry}`, cmd: process.execPath, args: ['--check', join(dir, entry)], cwd: dir })
  }
  for (const file of await testFiles(dir)) {
    checks.push({ line: 'canvas', name: `test ${file.split(/[\\/]/).pop()}`, cmd: process.execPath, args: [file], cwd: dir })
  }
}

function planFleet() {
  const dir = join(ROOT, 'dsh-miasaki-fleet')
  // F3 判活单测 + G0 总线契约/applier 单测 + F1 总线校验。
  checks.push({ line: 'fleet', name: 'test liveness (F3 心跳判活)', cmd: process.execPath, args: [join(dir, 'tests/liveness.test.mjs')], cwd: dir })
  // G0：契约判定（graph/result/event/patch）、applier 超步（CAS/确定性排序）、
  // 图校验闭环（validate-bus 的引用完整性/版本单调性路径）。
  // 三者都不捕获子进程管道，因此受限沙箱下同样可跑。
  checks.push({ line: 'fleet', name: 'test bus-contract (G0 契约判定)', cmd: process.execPath, args: [join(dir, 'tests/bus-contract.test.mjs')], cwd: dir })
  checks.push({ line: 'fleet', name: 'test bus-apply (G0 applier 超步)', cmd: process.execPath, args: [join(dir, 'tests/bus-apply.test.mjs')], cwd: dir })
  checks.push({ line: 'fleet', name: 'test bus-integration (G0 图校验闭环)', cmd: process.execPath, args: [join(dir, 'tests/bus-integration.test.mjs')], cwd: dir })
  // G1：任务图与就绪度判定。含「无 graph 字段的任务与旧规则逐字等价」的验证 ——
  // 这是 G1 零行为变更的证明，因此必须在回归里常驻。
  checks.push({ line: 'fleet', name: 'test task-graph (G1 图与就绪度)', cmd: process.execPath, args: [join(dir, 'tests/task-graph.test.mjs')], cwd: dir })
  // G1 CLI 冒烟：图结构完整性（真实总线上应为 0 个结构问题）。
  checks.push({ line: 'fleet', name: 'task-ready --check (G1 图结构)', cmd: process.execPath, args: [join(dir, 'workers/graph/task-ready.mjs'), '--check'], cwd: dir })
  // G2：能力图（词表规范化 / 替代查找 / 选型 / 缺口诊断）。
  // 测试数据取自真实档案快照 —— 「coder 归档后只有部分替代者」「analyst 无替代者」
  // 这类结论必须可在回归里复现。
  checks.push({ line: 'fleet', name: 'test capability-graph (G2 能力图)', cmd: process.execPath, args: [join(dir, 'tests/capability-graph.test.mjs')], cwd: dir })
  checks.push({ line: 'fleet', name: 'agent-pick --check (G2 能力图结构)', cmd: process.execPath, args: [join(dir, 'workers/graph/agent-pick.mjs'), '--check'], cwd: dir })
  // 派单能力闸门接线（P0，2026-09-11）：纯文本断言，不 spawn PowerShell、不依赖 PS7，
  // 保证任一环境都能跑。守护三件事：①闸门仍然存在；②「-Requires 显式覆盖」仍声明在
  // param 中（否则 PowerShell 前缀解析会把 -Requires 误判为 -ParseOnly）；
  // ③正则仍用行内空白类（.NET 的 \s 含换行，^\s* 会吃穿换行导致永不匹配）。
  checks.push({
    line: 'fleet',
    name: 'dispatch 能力闸门接线 (G2 → 派单器)',
    cmd: process.execPath,
    args: [
      '-e',
      [
        "const fs=require('fs'),p=require('path');",
        "const s=fs.readFileSync(p.join(process.cwd(),'workers','dispatch','dispatch-task.ps1'),'utf8');",
        "const need=[",
        "['Test-CapabilityGate','function Test-CapabilityGate'],",
        "['Resolve-RequiredCaps','function Resolve-RequiredCaps'],",
        "['-Requires 声明','[string]$Requires'],",
        "['派单分支闸门','能力闸门未通过，拒绝派单'],",
        "['未声明即跳过','跳过能力闸门'],",
        "['多行匹配','(?m)'],",
        "['行内空白类','[^\\\\S\\\\r\\\\n]*']",
        "];",
        "const miss=need.filter(x=>!s.includes(x[1])).map(x=>x[0]);",
        "if(miss.length){console.error('[dispatch-gate] 缺失：'+miss.join(' / '));process.exit(1)}",
        "console.log('[dispatch-gate] 接线完整：'+need.length+' 项断言通过');",
      ].join(''),
    ],
    cwd: dir,
  })
  // 派单可派闸门接线（G1/G0，2026-09-30）：同为纯文本断言（不 spawn PowerShell、
  // 不依赖 PS7，任何环境都能跑）。守护四件事：①G1 闸门与事件留痕仍在；②G1 闸门的
  // **两处调用点**都在（只钉函数定义会让「接线悄悄退化」全绿 —— 见下条注释）；
  // ③冷启动降级依赖的结构化字段 `agent` 仍在，且「丢弃哪条 reason」的文案与判定层
  // 那一侧**成对**存在；④冷启动降级、BUS_ROOT 对齐、CLI 存在性预检、事件不阻断仍在。
  checks.push({
    line: 'fleet',
    name: 'dispatch 可派闸门接线 (G1 + G0 事件)',
    cmd: process.execPath,
    args: [
      '-e',
      [
        "const fs=require('fs'),p=require('path');",
        "const s=fs.readFileSync(p.join(process.cwd(),'workers','dispatch','dispatch-task.ps1'),'utf8');",
        "const r=fs.readFileSync(p.join(process.cwd(),'workers','graph','task-ready.mjs'),'utf8');",
        "const g=fs.readFileSync(p.join(process.cwd(),'workers','lib','task-graph.cjs'),'utf8');",
        "const l=fs.readFileSync(p.join(process.cwd(),'workers','lib','liveness.cjs'),'utf8');",
        "const v=fs.readFileSync(p.join(process.cwd(),'workers','graph','verifier-pick.mjs'),'utf8');",
        "const c=fs.readFileSync(p.join(process.cwd(),'workers','lib','verifier.cjs'),'utf8');",
        "const b=fs.readFileSync(p.join(process.cwd(),'workers','lib','bus-contract.cjs'),'utf8');",
        "const files={s:s,r:r,g:g,l:l,v:v,c:c,b:b};",
        "const need=[",
        "['G1 闸门函数','function Test-DispatchableGate','s'],",
        // 两条**调用点**断言（2026-09-30 由 t-0010 独立复核 F3 补入）：此前只钉函数定义与
        // 函数体字面量，删掉派单主路径那处调用全仓不会变红 —— 行为用例只覆盖 -CheckOnly。
        "['预检分支调用点','Test-DispatchableGate $TaskId $Agent $localEnabled','s'],",
        "['派单主路径调用点','Test-DispatchableGate $TaskId $Agent $true','s'],",
        "['复用判定器','task-ready.mjs','s'],",
        "['单任务查询','--explain','s'],",
        "['assignee 一致性','reassign 补丁','s'],",
        "['冷启动降级','判活按首跑放行','s'],",
        // 这一对**必须同生同死**（复核 F4）：降级时「丢弃哪条 reason」只能按文案匹配
        // （reasons 目前无 code）。改任一侧文案而不同改另一侧 ⇒ 降级静默退化为硬拒首跑。
        "['判活丢弃判据（派单器侧）',\"-notmatch '判活失败'\",'s'],",
        "['判活文案（判定层侧，与上条成对）','判活失败（心跳过龄，F3）','g'],",
        "['工作区对齐','$env:BUS_ROOT = $Workspace','s'],",
        // 复核 F2：CLI 不存在时 pwsh 不改 $LASTEXITCODE ⇒ 假成功会写进事件流（唯一真相）。
        "['CLI 存在性预检','Get-Command $exe','s'],",
        // 复核 findings 收口批次（2026-09-30 第二批）：这四条各对应一个「不报错的失效形态」——
        // F1 崩溃残留无恢复入口 / F7 终态判定失败被静默记成 idle / F5 预算双实现无比对 / F6 坏行静默跳过。
        "['崩溃残留恢复入口','-ResetStatus','s'],",
        "['终态判定失败不静默回退','保守记 error','s'],",
        "['预算口径分歧比对','预算本地判定','s'],",
        "['台账坏行拒绝','bus_bad_lines','s'],",
        "['事件函数','function Write-BusEvent','s'],",
        "['开始事件','task.started','s'],",
        "['失败事件','failure.detected','s'],",
        "['事件不阻断派单','不影响派单','s'],",
        "['判定器结构化字段','agent: agentInfo','r'],",
        "['判定器坏行字段','bus_bad_lines: ctx.badLines','r'],",
        // 第三批（B4）G4 验证器挂载：声明了风险就必须有**可用**验证者；未声明即跳过（零行为变更）。
        // 同样钉住**调用点**：只钉函数定义的话，「接了却没调用」会全绿（第一批 F3 的教训）。
        "['验证闸门函数','function Test-VerifierGate','s'],",
        "['验证闸门调用点','Test-VerifierGate $Agent $verifyMinLevel','s'],",
        "['风险声明解析','function Resolve-VerifyLevel','s'],",
        "['等级映射不猜','function ConvertTo-MinLevel','s'],",
        "['验证任务书生成','function Write-VerifyBrief','s'],",
        // 形态契约（2026-09-30 由 `repo/style` 在**提交后**当场抓到）：verify-brief.md 是**入库**文本，
        // 必须 LF + 无 BOM。原先 `($parsed.brief + \"`n\") | Set-Content -Encoding UTF8` 会被 PowerShell
        // 给它写出的那一行补平台换行 `\r\n` ⇒ 产物成「47 LF + 1 CRLF」的混合行尾。改为按字节写。
        "['验证任务书按字节写（不依赖 cmdlet 隐式换行）','[System.IO.File]::WriteAllText','s'],",
        "['未声明即跳过','跳过验证闸门','s'],",
        // 首跑豁免（2026-09-30 统一两层判活口径）：判据单点在 liveness.cjs，
        // 两个消费方各自**引用**它。此前两侧各自实现同一口径、结论相反 ——
        // 派单闸门对 no-status 降级放行，验证者选取却把 alive=false 判不可用 ⇒
        // 从未运行过的 agent 永远当不了验证者（与「新 agent 永远派不出去」同族）。
        "['首跑口径单点','function isFirstRun','l'],",
        "['首跑状态字面量','FIRST_RUN_STATE = \\'no-status\\'','l'],",
        "['验证者选取消费首跑标记','firstRun: !archived && isFirstRun(live)','v'],",
        "['验证者可用性含首跑豁免','meta.firstRun === true','c'],",
        "['派单闸门同口径','agent.state -eq \\'no-status\\'','s'],",
        // B5 写入收敛（2026-09-30）：收敛口径是「**真相类文件进总线，派生态明确豁免**」——
        // 计量（usage）是真相 ⇒ 经唯一入口；status.json 是派生态缓存（真相在事件流，
        // 且心跳是高频字段，进总线会引发事件风暴）⇒ 刻意豁免。两侧都要钉住：
        // 只钉「usage 进总线」会漏掉「status 被顺手加进白名单」这种退化。
        "['usage 经唯一入口','agents/$AgentId/usage.jsonl','s'],",
        "['usage 失败回退直写','回退直写以保住计量数据','s'],",
        "['回退时显式告警','未经唯一入口','s'],",
        "['派生态豁免写进契约','派生态缓存','b'],",
        "];",
        "const miss=need.filter(x=>!files[x[2]].includes(x[1])).map(x=>x[0]);",
        "if(miss.length){console.error('[dispatch-wiring] 缺失：'+miss.join(' / '));process.exit(1)}",
        "console.log('[dispatch-wiring] 接线完整：'+need.length+' 项断言通过');",
      ].join(''),
    ],
    cwd: dir,
  })
  // G4：验证器选取与异构性判定（自验必须被拒；异构等级按厂商/模型判定）。
  checks.push({ line: 'fleet', name: 'test verifier (G4 异构验证)', cmd: process.execPath, args: [join(dir, 'tests/verifier.test.mjs')], cwd: dir })
  checks.push({ line: 'fleet', name: 'verifier-pick --check (G4 契约)', cmd: process.execPath, args: [join(dir, 'workers/graph/verifier-pick.mjs'), '--check'], cwd: dir })
  checks.push({ line: 'fleet', name: 'syntax fleet-monitor/server.js', cmd: process.execPath, args: ['--check', join(dir, 'fleet-monitor/server.js')], cwd: dir })
  // 2026-09-26 审计 P1.5 的收口：fleet-monitor 原是全仓唯一「写接口零鉴权 + CORS 通配」
  // 的组合（POST /api/toggle 直接落盘 control.json）。围栏是纯函数 + 假 req/res 驱动真实
  // handler，不起监听、不碰网络，故受限沙箱同样可跑；判据三条见测试文件头。
  checks.push({ line: 'fleet', name: 'syntax fleet-monitor/fence.cjs', cmd: process.execPath, args: ['--check', join(dir, 'fleet-monitor/fence.cjs')], cwd: dir })
  checks.push({ line: 'fleet', name: 'test fleet-monitor (信任围栏)', cmd: process.execPath, args: [join(dir, 'tests/fleet-monitor.test.mjs')], cwd: dir })
  // K4（2026-09-30）：派单终态判定 —— 「CLI exit 0」不等于「健康空闲」：
  // worker 自述受阻写在交付契约 tasks/<id>/result.json 的 status 里，过去被一律记成 idle，
  // 面板与桌宠照常显示正常。同一文件顺带覆盖 workers/dispatch/{final-state,dispatch-task}.ps1
  // 的语法（PowerShell 侧此前没有任何自动化检查）。
  checks.push({ line: 'fleet', name: 'test dispatch-state (K4 派单终态)', cmd: process.execPath, args: [join(dir, 'tests/dispatch-state.test.mjs')], cwd: dir })
  // G1 派单可派闸门（2026-09-30）：真实台账 9 个任务全终态（可派 0 个），真实数据只能覆盖
  // 「拒绝」分支 —— 故用夹具覆盖「放行」与冷启动降级，避免「闸门把该派的也拒了」这类
  // 只会在下次真派单时才暴露的缺陷。
  checks.push({ line: 'fleet', name: 'test dispatch-gate (G1 可派闸门)', cmd: process.execPath, args: [join(dir, 'tests/dispatch-gate.test.mjs')], cwd: dir })
  // P1 面板判定层区块（2026-09-30；2026-10-05 扩到 G4 验证者覆盖）：面板此前只有
  // 「在线数/任务数/成本」——判定层的事实（可派集与不可派原因、能力断层、机器事件流、
  // 验证者候选与覆盖度）一条都没上屏。这条断言钉住「区块 + 端点 + 判定口径同源 +
  // 异构降级前提上屏」都在，避免它们被后续改版静默删掉。
  //
  // **纪律：新增只读端点必须同改这份 `need` 清单**（与「跨线字段值域三处同源」同族）。
  // 清单是显式登记而非自动发现 —— 不登记的后果不是「闸门变红」，而是**下一个人改版时
  // 删掉端点也没有任何东西会红**。这正是本仓栽过多次的「静默回收」形态。
  checks.push({
    line: 'fleet',
    name: 'fleet-monitor 判定层区块 (P1)',
    cmd: process.execPath,
    args: [
      '-e',
      [
        "const fs=require('fs'),p=require('path');",
        "const h=fs.readFileSync(p.join(process.cwd(),'fleet-monitor','panel.html'),'utf8');",
        "const s=fs.readFileSync(p.join(process.cwd(),'fleet-monitor','server.js'),'utf8');",
        "const need=[",
        "['可派集区块','jDispatchable'],",
        "['能力断层区块','jGaps'],",
        "['机器事件区块','jEvents'],",
        // G4 验证者覆盖（2026-10-05）：文档原话「面板不告警就只是图表页」——
        // 验证者候选/覆盖度此前只在 CLI 输出里，面板答不出「该派谁验证」。
        "['验证者区块','jVerifiers'],",
        "['端点 dispatchable','/api/dispatchable'],",
        "['端点 gaps','/api/gaps'],",
        "['端点 events','/api/events'],",
        "['端点 verifiers','/api/verifiers'],",
        "['判定口径同源（spawn CLI 而非重写）','runJudgement'],",
        // 「模型未声明 ⇒ 模型级异构不可判定」必须上屏：本机 8 个活动 agent 的
        // manifest.model 全为 cli-default，判定层会降级到厂商级。若面板不显示这个前提，
        // Operator 会据此误判「验证一定独立」—— 即「假装异构」，与判定层的保守降级相反。
        "['异构降级前提如实上屏','agents_with_explicit_model'],",
        "];",
        "const miss=need.filter(x=>!h.includes(x[1])&&!s.includes(x[1])).map(x=>x[0]);",
        "if(miss.length){console.error('[panel] 缺失：'+miss.join(' / '));process.exit(1)}",
        "console.log('[panel] 判定层区块与端点齐全：'+need.length+' 项');",
      ].join(''),
    ],
    cwd: dir,
  })
  // Bus validation is the fleet line's regression suite (F1 contract + G0 graph/event/result).
  checks.push({ line: 'fleet', name: 'validate-bus', cmd: process.execPath, args: [join(dir, 'workers/validate-bus.mjs')], cwd: dir })
  checks.push({ line: 'fleet', name: 'publish-pulse', cmd: process.execPath, args: [join(dir, 'workers/pulse/publish-pulse.mjs')], cwd: dir })
  // --strict additionally requires fleet-pulse.json, so it must follow publish.
  checks.push({ line: 'fleet', name: 'validate-bus --strict', cmd: process.execPath, args: [join(dir, 'workers/validate-bus.mjs'), '--strict'], cwd: dir })
}

function planDesktop() {
  const dir = join(ROOT, 'dsh-miasaki-desktop')
  // gen-init rebuilds the injected theme bundle and validates token
  // completeness; diff-tokens catches surface/alias drift. verify-themes.mjs is
  // deliberately excluded: it attaches to a live CDP target (real-machine only).
  checks.push({ line: 'desktop', name: 'gen-init (token 完备性)', cmd: process.execPath, args: [join(dir, 'scripts/build-init.mjs')], cwd: dir })
  checks.push({ line: 'desktop', name: 'tokens:diff (漂移)', cmd: process.execPath, args: [join(dir, 'scripts/diff-tokens.mjs')], cwd: dir })
  // themes/src/*.js 拼接产物是 WebView2 **每个文档**都跑的注入脚本（含鉴权 cookie 兜底
  // 与 401 熔断），分片本身不是独立语法单元（IIFE 跨片闭合），只有拼好的产物能整体解析。
  // gen-init 只验令牌完备性、不验语法，故单独补一条 —— 注入脚本语法错=实机整屏黑，
  // 这是最廉价的前置闸门（2026-09-23 加，配套 00-boot 加固）。
  checks.push({
    line: 'desktop',
    name: 'syntax injected/theme-init.js',
    cmd: process.execPath,
    args: ['--check', join(dir, 'src-tauri', 'injected', 'theme-init.js')],
    cwd: dir,
  })
  // 鉴权 cookie 兜底链的**行为**闸门：从 themes/src/00-boot.js 的 @slice:auth-cookie 段截出
  // IIFE，在 VM 里用假浏览器（cookie jar / sessionStorage / crypto.subtle / location.reload）
  // 驱动，钉死 2026-09-23 的两条契约 ——「已有 cookie 只按原值续期、绝不覆写」与「401 reload
  // 有跨文档上限、超限停止并显示提示」。实机复现要造 secret 漂移 + 预置失败，成本高且危险。
  checks.push({
    line: 'desktop',
    name: 'test themes (鉴权 cookie 兜底链)',
    cmd: process.execPath,
    args: [join(dir, 'themes', 'test', 'auth-cookie.test.js')],
    cwd: dir,
  })
  // 启动页视觉层契约（design/boot-loading-terminal.md §4.2 的无 Rust 依赖部分 +
  // design/2026-10-04-boot-intro-video.md §5 的 L2 视频片头层）：
  // S4a —— 动画属性只准 transform/opacity（性能预算）、扫描线 opacity ≤ .06、零新增色、
  // reduced-motion 全量静止、类名前缀；行为侧 VM 驱动就绪回弹触发。
  // L2 —— 段与音轨来自宿主设置（boot_intro_state ← appearance config v7 的 boot 板块），
  // 「关闭 / 未知段 / IPC 不可用 / reduced-motion ⇒ 一层都不建」的门控矩阵、退场四路
  // （就绪 / 失败 / 解码失败 / 点击跳过）幂等、遮罩走主题变量、层盖在舞台层之上。
  // S4b（日志流 / 阶段进度）待 S3 stdout tee 钩子，落地时同批补行为断言。
  checks.push({
    line: 'desktop',
    name: 'test loading (S4a 视觉层 + L2 片头层契约)',
    cmd: process.execPath,
    args: [join(dir, 'ui', 'test', 'loading-visual.test.js')],
    cwd: dir,
  })
  // 启动片头素材闸门（design/2026-10-04-boot-intro-video.md §4）：ui/intro/ 四段第三方 mp4
  // 必须与台账（字节数 + SHA256 前 16 位，对齐上游 clips.meta.js）逐段一致。
  // 素材是**快照不是依赖** —— 上游更新与本仓无关，但入库产物被改动（半截下载 / 手工替换）
  // 必须在这里拦下；重放 `node scripts/extract-intro-clips.mjs`（无 --check）可修复。
  checks.push({
    line: 'desktop',
    name: 'intro-clips (片头素材 SHA 台账)',
    cmd: process.execPath,
    args: [join(dir, 'scripts', 'extract-intro-clips.mjs'), '--check'],
    cwd: dir,
  })
  // 拖拽上传安全网（design/drag-drop-attachment-upload.md）：09-dropguard.js 分片登记 /
  // 生成产物含片 / 三判据（dragover 阻止、只认 Files、defaultPrevented 放行）/ 自包含形态。
  checks.push({
    line: 'desktop',
    name: 'test dropguard (拖放安全网注入分片)',
    cmd: process.execPath,
    args: [join(dir, 'themes', 'test', 'dropguard.test.js')],
    cwd: dir,
  })
  // W0（2026-09-25）主题来源优先级：壳经 `__MIA_THEME__` 注入 prefs 主题（main.rs:1647-1649），
  // 但此前 themes/src 全片零读取 ⇒ 本地唤醒页（tauri.localhost，localStorage 为空）退化成
  // 'pure'，而该页 :root 默认色板是 zafkiel ⇒ 启动闪窗。截段在 VM 里钉死
  // `__MIA_THEME__ > URL > localStorage > pure`，并覆盖「非壳环境不报错」「localStorage 抛异常不崩」。
  checks.push({
    line: 'desktop',
    name: 'test theme-source (主题来源优先级)',
    cmd: process.execPath,
    args: [join(dir, 'themes', 'test', 'theme-source.test.js')],
    cwd: dir,
  })
  // W0（2026-09-25）hash 字段级读写：location.hash 是页面→Rust 的唯一上行通道，此前有两个
  // 写者（02-core.syncHash / 05-sensors.petHashCmd），后者从零构造并在 1600ms 后整体清空，
  // 会抹掉并发字段。截段钉死「精确增删 + 保真原始编码（%20 不得变 +）+ seq 覆盖保护」。
  checks.push({
    line: 'desktop',
    name: 'test hash-fields (hash 字段级读写)',
    cmd: process.execPath,
    args: [join(dir, 'themes', 'test', 'hash-fields.test.js')],
    cwd: dir,
  })
  // 2026-09-26「一直在刷新」修复 P3：`syncHash` 每 1.5s 被 05-sensors 的状态扫描触发，
  // 而 pet-panel 的心跳时间戳（petts）每轮都是新值 —— 旧实现无条件 replaceState，壳侧
  // 因此每轮都判为「fragment 变化」并重设桌宠（pet.log 实测 1.32 行/秒 × 5 小时 =
  // 156945 行 / 4.7MB）。闸门钉住判重的**两侧**：逐字节一致时一次都不写；任何真字段
  // （含心跳推进）变化时必须照写 —— 防判重退化成「永不写」。
  checks.push({
    line: 'desktop',
    name: 'test hash-sync (syncHash 写入判重)',
    cmd: process.execPath,
    args: [join(dir, 'themes', 'test', 'hash-sync.test.js')],
    cwd: dir,
  })
  // W1（2026-09-25）桌面壳↔渲染层契约 v1：`window.miasakiDesktop` 给七线插件一个
  // 有版本号、可探测、可降级的能力面（对齐官方 dshDesktop 的 frame 降级语义）。闸门钉住
  // 三条纪律：子 frame 只给空壳、能力表与暴露面一致、契约内不得开写通道（否则立刻造出
  // 第三个 hash 写者——W0-T0.2 刚修掉的竞态）。
  checks.push({
    line: 'desktop',
    name: 'test contract (壳↔渲染层契约 v1)',
    cmd: process.execPath,
    args: [join(dir, 'themes', 'test', 'contract.test.js')],
    cwd: dir,
  })
  // W4.3（2026-09-25）窗口底色回传：Rust 侧窗口底/Mica 回退色是硬编码两档、只在窗口创建时
  // 算一次，运行期切主题不更新（Win10 露旧色）。本闸门钉住解析与合成，尤其两条边界——
  // 半透明底必须合成到不透明、拿不到不透明底必须**如实放弃**（不猜颜色）。
  checks.push({
    line: 'desktop',
    name: 'test native-bg (窗口底色回传)',
    cmd: process.execPath,
    args: [join(dir, 'themes', 'test', 'native-bg.test.js')],
    cwd: dir,
  })
  // W2 收尾（2026-09-25）渲染层 console 旁路：诊断报告的 `--- renderer console ---` 段
  // 此前恒为空（Rust 侧 diag_console 早已就位但无写者），而挂起类 P0 的线索正在渲染层。
  // 闸门钉住三条纪律：只旁路不改变原生行为、只顶层 frame、有界环形 + 2s 节流。
  checks.push({
    line: 'desktop',
    name: 'test console-hook (渲染层 console 旁路)',
    cmd: process.execPath,
    args: [join(dir, 'themes', 'test', 'console-hook.test.js')],
    cwd: dir,
  })
  // W4.2（2026-09-25）材质分层：外观线 `mica` 档的语义是「用系统云母」，而实现是页面侧
  // backdrop-filter —— Win11 上原生 Mica 同时生效 ⇒ 两层模糊。分工是「壳说事实、页面选分支」：
  // 本闸门钉住注入层只搬运事实（不做决策）、拿不到预判一律按 off（保守）、广播能推翻预判。
  checks.push({
    line: 'desktop',
    name: 'test material (原生材质事实落地)',
    cmd: process.execPath,
    args: [join(dir, 'themes', 'test', 'material.test.js')],
    cwd: dir,
  })
  // 桌宠资产链完整性（2026-09-10 删素材静默断链教训的常态化）：frames.json 引用齐全 /
  // 再生源（图集/gif/raw 立绘）在位 / 无孤儿派生；状态覆盖缺口与源派生新旧只提示不判失败。
  checks.push({
    line: 'desktop',
    name: 'pet assets (资产链完整性)',
    cmd: process.execPath,
    args: [join(dir, 'scripts/check-pet-assets.mjs')],
    cwd: dir,
  })
  // Computer Use 插件的产物语法（2026-09-28）：`lib/*.js` 由上游 orb 工具链编译入库
  // （本仓无源码，无法就地维护），装进 profile 后装载失败只表现为「工具不见了」——
  // 故以 `node --check` 兜住损坏的产物。该目录已被 check-silent-guards 的
  // SKIP_PATH_PREFIXES 排除（外部编译产物），**本项就是那次排除的替代检查**：
  // 排除而不加替代检查 = 把风险藏起来。
  // 动态枚举而非硬编码文件名 —— tsdown 的 chunk 名带内容 hash（backend-DNT4VCU7.js 之类），
  // 重新编译即变，硬编码＝静默断链（本仓 2026-09-10 教训）。目录本身缺失时显式失败。
  {
    const bundleDir = join(dir, 'plugins', 'dsh-computer-use', 'lib')
    const bundles = existsSync(bundleDir)
      ? readdirSync(bundleDir).filter(name => name.endsWith('.js')).sort()
      : []
    if (bundles.length === 0) {
      checks.push({
        line: 'desktop',
        name: 'computer-use bundle (产物缺失)',
        cmd: process.execPath,
        args: ['-e', "console.error('plugins/dsh-computer-use/lib/*.js 缺失——插件装不上，且本项不得静默跳过'); process.exit(1)"],
        cwd: dir,
      })
    }
    for (const bundle of bundles) {
      checks.push({
        line: 'desktop',
        name: `syntax computer-use/${bundle}`,
        cmd: process.execPath,
        args: ['--check', join(bundleDir, bundle)],
        cwd: dir,
      })
    }
  }

  // 模型设置运行时补丁的自证：由 baseline 原始文件重建补丁产物并逐字节比对。
  // 纯离线、不碰安装目录——DSH 升级覆盖补丁后这一项仍应 PASS，它证明的是
  // 「补丁规则与基线自洽」，而不是「补丁此刻在安装目录里」。
  checks.push({
    line: 'desktop',
    name: 'patch verify (模型设置补丁可重建)',
    cmd: process.execPath,
    args: [join(dir, 'patches/dsh-client-ui-settings-models/patch.mjs'), 'verify'],
    cwd: dir,
  })
  // 会话头窄宽度溢出保护补丁的自证。同一契约：锚点唯一 → 由 baseline 重建 →
  // 产物 SHA 与记录一致。同样纯离线，升级覆盖补丁后这一项仍应 PASS。
  checks.push({
    line: 'desktop',
    name: 'patch verify (会话头溢出保护补丁可重建)',
    cmd: process.execPath,
    args: [join(dir, 'patches/dsh-client-ui-conversation/patch.mjs'), 'verify'],
    cwd: dir,
  })
  // 「首 token 计时可恢复」两个补丁的自证（轨迹页计时面板 + 消息气泡 TTFT）。
  // 与前两项同一契约之外，这两个补丁的 verify 还会把注入的恢复函数从**重建产物**里
  // 抠出来编译并跑 fixture 行为断言，并做一次 ESM 语法校验 —— 因为它们注入的是代码
  // 而不是 CSS。同样纯离线，升级覆盖后仍应 PASS。
  checks.push({
    line: 'desktop',
    name: 'patch verify (轨迹计时恢复补丁可重建)',
    cmd: process.execPath,
    args: [join(dir, 'patches/dsh-client-ui-trajectory/patch.mjs'), 'verify'],
    cwd: dir,
  })
  checks.push({
    line: 'desktop',
    name: 'patch verify (消息气泡计时恢复补丁可重建)',
    cmd: process.execPath,
    args: [join(dir, 'patches/dsh-client-ui-chat/patch.mjs'), 'verify'],
    cwd: dir,
  })
  // `cordis_inspect_query`(client) 永久挂起修复补丁**已于 2026-09-29 退役**：
  // 官方 `0.2.0-rc.2` 自行实现了同一修复 —— `pending.failure ??=` 记录拒绝原因与输出校验失败、
  // `clientQueryTimeoutMs` 可配超时、`finally { clearTimeout(timer) }` 清理，外加一条
  // 本补丁没有的「无活动页面时立刻失败」守卫。本补丁 4 条编辑的锚点在 rc.2 上
  // **全部命中 0 次**（在 rc.1 baseline 上为 4/4，证明规则本身未坏）——意图被上游完整吸收。
  // 故不再入册；`patches/dsh-cordis-host-runner/` 目录与设计记录保留为历史。
  // 判据与证据见 dsh-miasaki-shared-docs/dsh-platform/dsh-0.2.0-rc2-upgrade-assessment-2026-09-29.md §3.1。
  // 消息图片画廊多图 tile 宽高比补丁（2026-09-23 新建，基线即 0.1.7-alpha.2）的自证。
  // 纯 CSS 两条替换，没有行为断言可跑，契约就是「由 baseline 重建 == 记录 SHA」+
  // 两侧语法闸门。同样纯离线。
  checks.push({
    line: 'desktop',
    name: 'patch verify (消息画廊多图 tile 宽高比补丁可重建)',
    cmd: process.execPath,
    args: [join(dir, 'patches/dsh-client-ui-attachment/patch.mjs'), 'verify'],
    cwd: dir,
  })
  // 侧边栏头部悬浮提示 portal 化补丁（2026-09-28 新建，基线 0.1.7-rc.2）的自证。
  // 6 条 JS 编辑（tooltip 加 portal: true）+ SHA 重建比对 + vm.Script 语法闸门
  // （产物是合法经典脚本才允许落盘——client bundle 坏一个包全体失效）。
  // 纯离线，升级覆盖补丁后这一项仍应 PASS。
  checks.push({
    line: 'desktop',
    name: 'patch verify (侧边栏悬浮提示 portal 化补丁可重建)',
    cmd: process.execPath,
    args: [join(dir, 'patches/dsh-client-ui-sidebar/patch.mjs'), 'verify'],
    cwd: dir,
  })
  // 品牌徽标 HARNESS → miasaki 部署名补丁（2026-09-28 新建，基线 0.1.7-rc.2）的自证。
  // 2 条 JS 编辑（插入 MiasakiBrandName 组件 + 改 OfficialBrandName 返回）+
  // SHA 重建比对 + vm.Script 语法闸门。字标 8 path 从 primitives 官方源码
  // 逐字节提取，胶囊 rect 几何不变，仅徽标文字 HARNESS→MIASAKI。
  // 纯离线，升级覆盖补丁后这一项仍应 PASS。
  checks.push({
    line: 'desktop',
    name: 'patch verify (品牌徽标 miasaki 化补丁可重建)',
    cmd: process.execPath,
    args: [join(dir, 'patches/dsh-client-ui-brand-official/patch.mjs'), 'verify'],
    cwd: dir,
  })
  // 会话浏览器「侧线会话不占列表」补丁（2026-09-30 新建，基线 0.2.0-rc.2）的自证。
  // 1 条 JS 编辑：`sessionVisible()` 的 origin 判定之后追加一条「插件声明的侧线不显示」。
  // 判据是**跨包契约** —— 读 `@miasaki/dsh-sidebar` 写入的 localStorage 声明键
  // （`miasaki-sidebar:sidechat:hidden:v1`）；声明缺席/损坏即官方原状，故这个补丁
  // 不可能把任何会话挡在列表外。SHA 重建比对 + vm.Script 语法闸门。纯离线。
  checks.push({
    line: 'desktop',
    name: 'patch verify (侧线会话不占列表补丁可重建)',
    cmd: process.execPath,
    args: [join(dir, 'patches/dsh-client-ui-workspace/patch.mjs'), 'verify'],
    cwd: dir,
  })
  // 「测试连通性 v2」的 host 侧能力（plugins/dsh-model-probe）：语法检查 +
  // 探测判定表单测（URL 规则 / 两段式档案 / 分类表 / 脱敏 / 截断）。全部是纯逻辑，
  // 不发起任何网络请求——真实探测属实机项，见 smoke-test-matrix.md。
  // settings-read 双轨（≤0.1.6 get / 0.1.7 describe）同属该插件：helper 契约
  // 10 例 + probeModel 接线 2 例，锁定 0.1.7 拆掉 ctx.settings.get 后的两个世界。
  for (const entry of ['lib/index.js', 'lib/probe.js', 'lib/settings-read.js']) {
    checks.push({ line: 'desktop', name: `syntax plugins/dsh-model-probe/${entry}`, cmd: process.execPath, args: ['--check', join(dir, 'plugins/dsh-model-probe', entry)], cwd: dir })
  }
  checks.push({
    line: 'desktop',
    name: 'test model-probe (连通性探测判定表)',
    cmd: process.execPath,
    args: [join(dir, 'plugins/dsh-model-probe/test/probe.test.js')],
    cwd: join(dir, 'plugins/dsh-model-probe'),
  })
  checks.push({
    line: 'desktop',
    name: 'test model-probe (settings 读取双轨)',
    cmd: process.execPath,
    args: [join(dir, 'plugins/dsh-model-probe/test/settings-read.test.js')],
    cwd: join(dir, 'plugins/dsh-model-probe'),
  })
  // 桌宠面板（plugins/dsh-pet-panel）：2026-09-29 **补闸门**。
  // 该插件的 lib/client.js 此前**不在任何闸门里** —— 而它承载三条真实链路
  // （六态上报 / 主题人格联动 / R5 内联审批回写），且是「设置 → 桌宠」的唯一实现。
  // 形态与 dsh-model-probe 当年相同：**只靠 package.json 的 build 脚本检查，回归里看不见**
  // （2026-09-29 加「六态开关 + 主题跟随」时才发现的，见 AGENTS.md「漏登记是复发形态」）。
  for (const entry of ['lib/index.js', 'lib/client.js']) {
    checks.push({ line: 'desktop', name: `syntax plugins/dsh-pet-panel/${entry}`, cmd: process.execPath, args: ['--check', join(dir, 'plugins/dsh-pet-panel', entry)], cwd: dir })
  }
  checks.push({
    line: 'desktop',
    name: 'test pet-panel (客户端设置层)',
    cmd: process.execPath,
    args: [join(dir, 'plugins/dsh-pet-panel/test/panel-settings.test.js')],
    cwd: join(dir, 'plugins/dsh-pet-panel'),
  })
  // 免费模型池已于 2026-09-28 迁出本线 → 独立第九线 dsh-miasaki-free-model
  // （更名 @miasaki/dsh-free-model）。原先挂在这里的三项闸门随迁，见 planFreeModel()。
  // 会话日志入口迁移（plugins/dsh-session-log-move，2026-09-26 纳入）：0.1.7 起槽声明
  // 随 entry 加载（dsh-client-ui-slots 的 register 要求 spec 已在场），要注册
  // conversation.session.header.utilities 就必须在 dsh.client.inject 里声明承载它的
  // entry —— 漏了会让 client 半整条激活失败（`slot … is not declared`，插件在 UI 上
  // 静默消失，只在 console 留一行）。契约测试钉住声明本身 + 日志分级 + 重试收手条件。
  for (const entry of ['lib/index.js', 'lib/client.js']) {
    checks.push({ line: 'desktop', name: `syntax plugins/dsh-session-log-move/${entry}`, cmd: process.execPath, args: ['--check', join(dir, 'plugins/dsh-session-log-move', entry)], cwd: dir })
  }
  checks.push({
    line: 'desktop',
    name: 'test session-log-move (槽声明契约 + 日志分级)',
    cmd: process.execPath,
    args: [join(dir, 'plugins/dsh-session-log-move/test/contract.test.js')],
    cwd: join(dir, 'plugins/dsh-session-log-move'),
  })
  // Rust 侧单测（pulse stale 语义 + 立绘回落链）。cargo 常不在 PATH，回落到
  // rustup 默认安装位置；找不到时跳过而非报失败——非 Rust 环境仍应能跑完前几项。
  const cargo = cargoBin()
  if (cargo === null) {
    console.log('[verify-all] 未找到 cargo，跳过 desktop Rust 单测（装好 rustup 后自动纳入）\n')
  } else {
    checks.push({
      line: 'desktop',
      name: 'cargo test (pulse stale 语义)',
      cmd: cargo,
      args: ['test', '--bin', 'miasaki', '--quiet'],
      cwd: join(dir, 'src-tauri'),
    })
  }
}

async function planSsh() {
  const dir = join(ROOT, 'dsh-miasaki-ssh')
  // 单测不碰真实 SSH 连接（store 围栏/归一化、runtime 的 TOFU 与错误分类、
  // http 路由、client 工厂返回契约），因此可在无 sshd 的机器上复现；
  // 真实连接验收仍是实机项，见 smoke-test-matrix.md。
  // 2026-09-26 U2.2/P0-3/P1-1 新模块同批进静态闸门（此前只有 7 个入口，SFTP/exec/sshConfig
  // 等新文件只靠 package.json 的 build 脚本检查，回归里看不见——「闸门报了 PASS」与
  // 「新文件确实被检查」是两件事，缺的口子就在这里补上）。
  for (const entry of [
    'index.js', 'client.js', 'app.js', 'session.js', 'sftp-ui.js',
    'lib/store.js', 'lib/runtime.js', 'lib/diagnose.js',
    'lib/exec.js', 'lib/paths.js', 'lib/sftp.js', 'lib/limits.js', 'lib/sshConfig.js',
  ]) {
    checks.push({ line: 'ssh', name: `syntax ${entry}`, cmd: process.execPath, args: ['--check', join(dir, entry)], cwd: dir })
  }
  for (const file of await testFiles(dir)) {
    checks.push({ line: 'ssh', name: `test ${file.split(/[\\/]/).pop()}`, cmd: process.execPath, args: [file], cwd: dir })
  }
}

async function planDualModel() {
  const dir = join(ROOT, 'dsh-miasaki-dual-model')
  // 份量与 package.json 的 `build` 保持一字不差：此前这里只有 6 个文件，而 build 有 8 个
  // ——`lib/invalidation.js` 长期没进静态闸门（2026-09-29 补）。新增模块必须同时进两处。
  for (const entry of ['index.js', 'client.js', 'lib/content.js', 'lib/routing.js', 'lib/admission.js', 'lib/capability.js', 'lib/invalidation.js', 'lib/store.js']) {
    checks.push({ line: 'dual-model', name: `syntax ${entry}`, cmd: process.execPath, args: ['--check', join(dir, entry)], cwd: dir })
  }
  for (const file of await testFiles(dir)) {
    checks.push({ line: 'dual-model', name: `test ${file.split(/[\\/]/).pop()}`, cmd: process.execPath, args: [file], cwd: dir })
  }
  // 图片准入补丁的自证：由 baseline 原始文件重建补丁产物并逐字节比对。
  // 与 desktop 那一项同理——纯离线、不碰安装目录；它证明的是「补丁规则与基线自洽」，
  // 而不是「补丁此刻在安装目录里」（DSH 升级覆盖后这一项仍应 PASS）。
  checks.push({
    line: 'dual-model',
    name: 'patch verify (图片准入补丁可重建)',
    cmd: process.execPath,
    args: [join(dir, 'patches/dsh-api-session-controller/patch.mjs'), 'verify'],
    cwd: dir,
  })
}

async function planAppearance() {
  const dir = join(ROOT, 'dsh-miasaki-appearance')
  // 本线 M1 的 L0/L1：语法检查 + 纯逻辑单测（配置模型：归一化/合并/迁移/
  // 首帧脚本/契约判定；围栏；持久化；client 半装载契约 —— 在无 `module` 的 VM 上下文里
  // 跑 factory，钉死「module is not defined」那类整包加载失败；P2 起另有 lib/splash.js 的
  // 首帧启动画契约）。都不碰网络与 DSH 运行时，
  // 任意机器可复现；实机项（插件加载 / 设置栏出现 / 「关掉即原生」）见 smoke-test-matrix.md。
  for (const entry of ['index.js', 'client.js', 'lib/config.js', 'lib/splash.js', 'lib/avatar.js', 'lib/icon-presets.js', 'lib/store.js', 'lib/fence.js']) {
    checks.push({ line: 'appearance', name: `syntax ${entry}`, cmd: process.execPath, args: ['--check', join(dir, entry)], cwd: dir })
  }
  for (const file of await testFiles(dir)) {
    checks.push({ line: 'appearance', name: `test ${file.split(/[\\/]/).pop()}`, cmd: process.execPath, args: [file], cwd: dir })
  }
  // M2 S3：皮肤表可复算闸门（产物与 skin.css 重算 diff，防手改/过期）
  checks.push({ line: 'appearance', name: 'derive-skins --check', cmd: process.execPath, args: ['scripts/derive-skins.mjs', '--check'], cwd: dir })
}

function planUsage() {
  const dir = join(ROOT, 'dsh-miasaki-usage')
  // 本线（原 desktop 线内置插件 dsh-token-monitor，2026-09-26 迁出独立成线）的 L0/L1：
  // host 半语法 + client bundle 加载前自检。后者是本线的关键闸门——它把 client.js 当脚本
  // 真实执行并喂 react stub，能抓出「CSS 模板字符串被反引号提前闭合」那类**整包加载失败**
  // （2026-09-10 事故：报错落在 CSS 注释行、裸标识符看不懂）。都不碰 DSH 运行时，
  // 任意机器可复现；实机项（用量 Tab / 侧栏入口 / 账本续写）见 smoke-test-matrix.md。
  checks.push({ line: 'usage', name: 'syntax lib/index.js', cmd: process.execPath, args: ['--check', join(dir, 'lib/index.js')], cwd: dir })
  // I5（2026-09-30）：本线此前是九线里**唯一没有同源围栏**的一条 —— exact 路由不经过
  // 内核 `/api` 准入链，实测非环回 Host / 跨站两轴均返回 200，而 `POST /reset` 是
  // 清空账本的写操作。围栏包装收在 register 一处（新增路由不会漏挂）。
  checks.push({ line: 'usage', name: 'syntax lib/fence.js', cmd: process.execPath, args: ['--check', join(dir, 'lib/fence.js')], cwd: dir })
  checks.push({ line: 'usage', name: 'test fence (I5 同源围栏)', cmd: process.execPath, args: [join(dir, 'test/fence.test.mjs')], cwd: dir })
  // I1（2026-09-30）：账本目录名此前只有注释、没有闸门 —— 一次「顺手统一命名」就会让
  // 全量历史统计清零且不报错（静默失效第 17 位）。抽成 lib/ledger-dir.js 后由测试钉住。
  checks.push({ line: 'usage', name: 'syntax lib/ledger-dir.js', cmd: process.execPath, args: ['--check', join(dir, 'lib/ledger-dir.js')], cwd: dir })
  checks.push({ line: 'usage', name: 'test ledger-dir (I1 账本身份)', cmd: process.execPath, args: [join(dir, 'test/ledger-dir.test.mjs')], cwd: dir })
  checks.push({ line: 'usage', name: 'syntax scripts/dedupe-usage-ledger.mjs', cmd: process.execPath, args: ['--check', join(dir, 'scripts/dedupe-usage-ledger.mjs')], cwd: dir })
  checks.push({ line: 'usage', name: 'verify-client-bundle (client 半装载契约)', cmd: process.execPath, args: [join(dir, 'scripts/verify-client-bundle.mjs'), join(dir, 'lib/client.js')], cwd: dir })
}

/**
 * 第九线：多来源免费模型聚合器（`@miasaki/dsh-free-model`）。
 *
 * 2026-09-28 由 desktop 线迁出并更名（原 `plugins/dsh-free-model-pool`）。
 * 迁出同批补上了**路由信任围栏** —— 本插件的 exact 路由不经过内核 `/api` 的准入链，
 * 围栏是唯一口子，因此它是本线的头号闸门。
 *
 * 四类检查：
 *   · host 半语法：index.js / trust.js / settings-read.js / profile.js / scan.js；
 *   · trust.test.js：结构层五条边界（回环 Host、非回环、Host 缺失 fail closed、
 *     跨站 fetch、异源/opaque Origin）+ connection 服务两层语义（401/403/放行/抛错回落）
 *     + **逐请求读取**（晚 provide 即接管）+ 「围栏先于 method 检查」的顺序断言；
 *   · client-bundle.test.js：把 client.js 当脚本真实执行一次（迁线改动了 12 处字符串，
 *     语法绿 ≠ 面板挂得上）—— 模块 id、导出面、`apply()` 注册到 `settings.models.footer`
 *     的 id/order、以及旧命名零残留；
 *   · scan.test.js（M1）：来源 A（官方 `llm` 契约枚举）的三条纪律 —— 逐 provider 隔离失败
 *     （一个平台挂了只进 `partial[]`）、逐调用失败回落（`resolveModelInfo` 挂了条目仍产出）、
 *     **能力只到能被证明的程度**（适配器不声明工具参数 ⇒ 标"未声明/需实测"而不是猜一个 false）；
 *     外加 L0/L1 免费分层、解析缓存与 refresh、`/scan` 路由端到端；
 *   · settings-read.test.js / routes.test.js：0.1.7 移除 `ctx.settings.get` 的双轨适配
 *     与真实路由接线（随迁线平移，原 desktop 类里的同两项）；
 *   · default-model.test.js（M3）：官方写路径 `agentDefaultModel.saveSelection` 的四种
 *     失败形态 —— 服务缺席给语义化错误而不是 500、读失败按"读不到"处理、参数不合法时
 *     不碰服务、官方抛错原因透传。
 */
function planFreeModel() {
  const dir = join(ROOT, 'dsh-miasaki-free-model')
  for (const entry of ['lib/index.js', 'lib/trust.js', 'lib/settings-read.js', 'lib/profile.js', 'lib/scan.js']) {
    checks.push({ line: 'free-model', name: `syntax ${entry}`, cmd: process.execPath, args: ['--check', join(dir, entry)], cwd: dir })
  }
  // 上游插件增量补丁（patches/dsh-our-free-model）：把「本机自配平台」接进它的设置页。
  // 上游升级会覆盖 client.js、补丁一定会被冲掉，所以锚点是否仍与当前上游版本对得上
  // 必须是闸门（self-test 三种状态各有明确处置：applied / pending → 副本上试打 / drift → 红）。
  for (const entry of ['patches/dsh-our-free-model/patch.mjs', 'patches/dsh-our-free-model/self-test.mjs', 'patches/dsh-our-free-model/inject/platform-panel.js']) {
    checks.push({ line: 'free-model', name: `syntax ${entry}`, cmd: process.execPath, args: ['--check', join(dir, entry)], cwd: dir })
  }
  checks.push({
    line: 'free-model',
    name: 'ofm patch self-test (上游增量补丁锚点)',
    cmd: process.execPath,
    args: [join(dir, 'patches/dsh-our-free-model/self-test.mjs')],
    cwd: join(dir, 'patches/dsh-our-free-model'),
  })
  for (const file of ['test/trust.test.js', 'test/client-bundle.test.js', 'test/scan.test.js', 'test/default-model.test.js', 'test/settings-read.test.js', 'test/routes.test.js']) {
    checks.push({
      line: 'free-model',
      name: `test ${file.replace('test/', '').replace('.test.js', '')}`,
      cmd: process.execPath,
      args: [join(dir, file)],
      cwd: dir,
    })
  }
}

/**
 * 仓库级治理闸门（跨九线生效，不属于任何单线）。
 *
 * 这五项补的是「逐例修不解决问题」的那类漏洞 —— 同类 bug 反复出现时，缺的不再是修法，
 * 而是让第 N 例无法悄悄进来的闸门（评审报告 §五.P2.10）：
 *   · silent-guards：守卫必须显式失败。四类形态（静默跳过 / 静默吞错 / 静默回退读取 /
 *     声明清单缺口），存量冻结在 scripts/silent-guard-baseline.json，**新增即失败**；
 *   · doc-versions：根 README 的版本台账必须与九线 package.json 逐字一致，
 *     治「文档说一个版本、代码是另一个版本」这类当前态失真；
 *   · message-sources：会话消息的 `source.kind` 不得用 DSH 0.1.7 起已退役的 v3 写法
 *     （`{ kind: "plugin", plugin: … }` ⇒ v4 准入硬拒 ⇒ 整轮运行失败）。除仓库内源码外，
 *     顺带体检本机 `~/.dsh/profiles/<profile>/node_modules` 的非官方插件；CI 无该目录时显式跳过。
 *   · md-links：入库文档的相对链接必须解析到**已入库**目标（184 个文档里曾有 49 处
 *     在 GitHub 上必然 404，形态是「路径视角不统一」）；
 *   · lock-sync：锁文件与 package.json 的直接依赖 specifier 必须一致 —— 否则 CI 会红在
 *     「安装 XX 线依赖」那一步（ERR_PNPM_OUTDATED_LOCKFILE），后续步骤全部 skipped，
 *     **看起来像测试挂了，其实一个测试都没跑**（2026-09-29 实测连续 11 次）。
 *   · style：文件形态（LF / 无 BOM / 末行换行）+ 公开仓库脱敏（路径形态 + 裸词表）；
 *   · pulse-contract：fleet 脉冲的生产/消费字段集对账（消费集 ⊆ 生产集 + 协议版本两侧一致）
 *     —— 防「publish-pulse 改字段名、桌宠静默读不到、该亮不亮且无红灯」的跨线漂移。
 * 七项都零第三方依赖、纯离线，受限沙箱与 CI 同样可跑。
 *
 * 注：本段此前写「这三项」而实际已有四项 —— 加 md-links 时**漏改这段注释**，
 * 正是 AGENTS.md 记的「注释与实现不一致＝漏登记的签名」。加闸门时请连本段一并订正
 * （style 闸门落地时也漏了本段 —— 2026-10-05 加 pulse-contract 时一并对齐）。
 */
function planRepo() {
  checks.push({
    line: 'repo',
    name: 'silent-guards (守卫必须显式失败)',
    cmd: process.execPath,
    args: [join(ROOT, 'scripts', 'check-silent-guards.mjs')],
    cwd: ROOT,
  })
  checks.push({
    line: 'repo',
    name: 'doc-versions (版本台账 vs package.json)',
    cmd: process.execPath,
    args: [join(ROOT, 'scripts', 'check-doc-versions.mjs')],
    cwd: ROOT,
  })
  // 2026-09-27 实机故障（「本轮运行失败 format v4 message requires a producer-owned
  // source kind」）的直接产物：第三方记忆插件按 v3 写法注入消息，v4 准入在落盘前硬拒，
  // 每轮必失败而磁盘上查不到任何痕迹。闸门扫仓库内源码（含自证：正例必命中、反例必不误报），
  // 并顺带体检本机已装插件 —— 后者是本机环境健康检查，CI 上显式跳过（不静默）。
  checks.push({
    line: 'repo',
    name: 'message-sources (会话消息来源不得用退役 v3 写法)',
    cmd: process.execPath,
    args: [join(ROOT, 'scripts', 'check-message-sources.mjs')],
    cwd: ROOT,
  })
  // 2026-09-29 一次性扫描发现：184 个入库文档里有 **49 处相对链接在 GitHub 上必然 404**，
  // 形态是「路径视角不统一」（少一层 / 多一层 / 根视角）。此前**没有任何闸门守链接** ——
  // `check-doc-versions.mjs` 头部写着「断链见 check-silent-guards 的 R4」，但 R4 是
  // 「声明清单缺口」，**并不覆盖文件系统层面的断链**，那 49 处就是这么逃过去的。
  // 判据两条：目标必须存在，且**必须已入库**（后者挡住「引用 _refs/」这类本机正常、
  // clone 必断的写法）。
  checks.push({
    line: 'repo',
    name: 'md-links (入库文档的相对链接必须解析到已入库目标)',
    cmd: process.execPath,
    args: [join(ROOT, 'scripts', 'check-md-links.mjs')],
    cwd: ROOT,
  })
  // 2026-09-30：锁文件同步。补的是「CI 红在装依赖、而回归根本没跑」这个盲区 ——
  // 2026-09-29 20:44 的 `8181b89`（七个插件补 peerDependencies）只改了 package.json、
  // 没同步锁文件，此后 **11 次推送全红**，每次都在第 7 步 ERR_PNPM_OUTDATED_LOCKFILE 退出、
  // 第 8/9/10 步（含**九线统一回归**）全部 skipped：3 小时里没有任何改动被 CI 验证过。
  // 本项在推送前复现同一判定（已用 f610ef3 的历史文件实测：报出的两条与 CI 日志逐字相同）。
  // 判据、边界与内置自证见 scripts/check-lock-sync.mjs 头部。
  checks.push({
    line: 'repo',
    name: 'lock-sync (锁文件与 package.json 同步)',
    cmd: process.execPath,
    args: [join(ROOT, 'scripts', 'check-lock-sync.mjs')],
    cwd: ROOT,
  })
  // 2026-09-30：文件形态（LF / 无 BOM / 末行换行）与**公开仓库脱敏**（`C:\Users\<真名>\…`）。
  // 两者都是**成文但无闸门**的纪律：`.editorconfig` / `.gitattributes` 写着形态约定
  // （ENGINEERING.md 还记着 CI 首跑因 CRLF 一次失败 8 项的旧账），脱敏则是 2026-09-29 起的
  // 公开仓库要求、审计口径「人名零命中」此前全靠人记。存量 54 处（BOM/CRLF/无末行换行）
  // 冻结在 scripts/style-baseline.json；脱敏类**刻意无基线**（新增即失败）。
  checks.push({
    line: 'repo',
    name: 'style (文件形态 + 脱敏)',
    cmd: process.execPath,
    args: [join(ROOT, 'scripts', 'check-style.mjs')],
    cwd: ROOT,
  })
  // 2026-10-05（T6，desktop-adaptation-plan-2026-09-27 §3.1）：fleet 脉冲跨线契约对账。
  // 要防的事：把 publish-pulse.mjs 的 `running` 改名，两侧回归全绿、桌宠静默读不到
  // （unwrap_or(0) 按 0）⇒「该亮不亮」无红灯。判据：消费集 ⊆ 生产集 + v/ts 两侧同现 +
  // 协议版本一致；生产集由闸门**现跑入库的发布器**取得（刻意不复用已 publish 的未跟踪文件
  // —— intro-clips 事故纪律），消费集从 main.rs 的 parse_pulse_flag 锚定抽取，抽不到即失败。
  // 判据、边界与内置自证见 scripts/check-pulse-contract.mjs 头部。
  checks.push({
    line: 'repo',
    name: 'pulse-contract (fleet 脉冲生产/消费字段对账)',
    cmd: process.execPath,
    args: [join(ROOT, 'scripts', 'check-pulse-contract.mjs')],
    cwd: ROOT,
  })
}

/** 定位 cargo：优先 CARGO_HOME，其次 rustup 默认安装位置（PATH 里常没有）。 */function cargoBin() {
  const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  const home = process.env.CARGO_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.cargo')
  const candidate = join(home, 'bin', exe)
  return existsSync(candidate) ? candidate : null
}

const requested = process.argv.slice(2).filter(arg => !arg.startsWith('-'))
const selected = requested.length === 0 ? LINES : requested
for (const line of selected) {
  if (!LINES.includes(line)) {
    console.error(`未知的线：${line}（可选：${LINES.join(' / ')}）`)
    process.exit(2)
  }
}

if (selected.includes('sidebar')) await planSidebar()
if (selected.includes('canvas')) await planCanvas()
if (selected.includes('fleet')) planFleet()
if (selected.includes('desktop')) planDesktop()
if (selected.includes('ssh')) await planSsh()
if (selected.includes('dual-model')) await planDualModel()
if (selected.includes('appearance')) await planAppearance()
if (selected.includes('usage')) planUsage()
if (selected.includes('free-model')) planFreeModel()
if (selected.includes('repo')) planRepo()

console.log(`[verify-all] ${selected.join(' / ')} — ${checks.length} 项检查\n`)

const results = []
for (const check of checks) {
  process.stdout.write(`── [${check.line}] ${check.name}\n`)
  const code = await run(check.cmd, check.args, check.cwd)
  results.push({ ...check, code })
}

const failed = results.filter(result => result.code !== 0)
console.log('\n[verify-all] 汇总')
for (const line of selected) {
  const own = results.filter(result => result.line === line)
  const bad = own.filter(result => result.code !== 0)
  console.log(`  ${bad.length === 0 ? 'PASS' : 'FAIL'}  ${line}: ${own.length - bad.length}/${own.length}`)
}
if (failed.length > 0) {
  console.log('\n失败项：')
  for (const result of failed) console.log(`  [${result.line}] ${result.name} → exit ${result.code}`)
  process.exit(1)
}
console.log('\n全部通过。实机项（插件加载 / 桌面壳 / 跨线联动）见 dsh-miasaki-shared-docs/cross/smoke-test-matrix.md')
