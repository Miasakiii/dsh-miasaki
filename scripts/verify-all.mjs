#!/usr/bin/env node
// 八线 + 仓库级统一静态回归入口（L0 静态检查 + L1 单线单测）。
//
// 只跑「无外部依赖、可在任意机器复现」的检查：语法、单测、总线校验、令牌漂移、
// 运行时补丁离线自证。需要运行中的 DSH host 或桌面壳的实机项（L2 插件加载 /
// L3 冒烟 / L4 跨线联动）不在此脚本内——它们的清单在
// dsh-miasaki-shared-docs/cross/smoke-test-matrix.md。
//
// `repo` 是**仓库级治理闸门**（跨八线生效，不属于任何单线）：见 planRepo()。
//
// 用法：
//   node scripts/verify-all.mjs                      # 全部八线 + 仓库级
//   node scripts/verify-all.mjs dual-model           # 只跑指定线
//                     （sidebar / canvas / fleet / desktop / ssh / dual-model / appearance / usage / repo）
//
// 实现注记：子进程一律 stdio: 'inherit'，不做管道捕获——受限沙箱下捕获另一个
// 程序的 stdio 会以 EPERM 失败，而 inherit 不会。因此本脚本以退出码判定成败，
// 各线的详细输出直接透传到当前终端。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LINES = ['sidebar', 'canvas', 'fleet', 'desktop', 'ssh', 'dual-model', 'appearance', 'usage', 'repo']

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
  // G4：验证器选取与异构性判定（自验必须被拒；异构等级按厂商/模型判定）。
  checks.push({ line: 'fleet', name: 'test verifier (G4 异构验证)', cmd: process.execPath, args: [join(dir, 'tests/verifier.test.mjs')], cwd: dir })
  checks.push({ line: 'fleet', name: 'verifier-pick --check (G4 契约)', cmd: process.execPath, args: [join(dir, 'workers/graph/verifier-pick.mjs'), '--check'], cwd: dir })
  checks.push({ line: 'fleet', name: 'syntax fleet-monitor/server.js', cmd: process.execPath, args: ['--check', join(dir, 'fleet-monitor/server.js')], cwd: dir })
  // 2026-09-26 审计 P1.5 的收口：fleet-monitor 原是全仓唯一「写接口零鉴权 + CORS 通配」
  // 的组合（POST /api/toggle 直接落盘 control.json）。围栏是纯函数 + 假 req/res 驱动真实
  // handler，不起监听、不碰网络，故受限沙箱同样可跑；判据三条见测试文件头。
  checks.push({ line: 'fleet', name: 'syntax fleet-monitor/fence.cjs', cmd: process.execPath, args: ['--check', join(dir, 'fleet-monitor/fence.cjs')], cwd: dir })
  checks.push({ line: 'fleet', name: 'test fleet-monitor (信任围栏)', cmd: process.execPath, args: [join(dir, 'tests/fleet-monitor.test.mjs')], cwd: dir })
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
  // 启动页 S4a 视觉层契约（design/boot-loading-terminal.md §4.2 的无 Rust 依赖部分）：
  // 动画属性只准 transform/opacity（性能预算）、扫描线 opacity ≤ .06、零新增色、
  // reduced-motion 全量静止、类名 .mia-boot-* 前缀；行为侧 VM 驱动就绪回弹触发。
  // S4b（日志流 / 阶段进度）待 S3 stdout tee 钩子，落地时同批补行为断言。
  checks.push({
    line: 'desktop',
    name: 'test loading (S4a 视觉层契约)',
    cmd: process.execPath,
    args: [join(dir, 'ui', 'test', 'loading-visual.test.js')],
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
  // `cordis_inspect_query`(client) 永久挂起修复补丁的自证。同一契约之外，它还做两组
  // **行为断言**：把重建产物里真实的 resolveClientQuery 与注入的超时块抠出来跑
  // （拒绝必须被记录且不抢答；无人应答必须结算成带原因的 timeout），并对 baseline 原版
  // 跑反例以证明断言有区分力；外加 node --check 的 ESM 语法校验。
  // 与前几项同理——纯离线、不碰安装目录，DSH 升级覆盖补丁后仍应 PASS。
  checks.push({
    line: 'desktop',
    name: 'patch verify (cordis client 查询挂起修复补丁可重建)',
    cmd: process.execPath,
    args: [join(dir, 'patches/dsh-cordis-host-runner/patch.mjs'), 'verify'],
    cwd: dir,
  })
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
  // 免费模型池（plugins/dsh-free-model-pool）：与 model-probe 同一破绽的同孪生
  // 修法——0.1.7 移除 ctx.settings.get 后，模型页面板整块报错。routes 测试用
  // fetch 打桩驱动真实 /status 与 /apply 路由（唯一外部服务是平台 /models），
  // 双世界各一遍；settings-read 测试锁 helper 契约。
  for (const entry of ['lib/index.js', 'lib/settings-read.js']) {
    checks.push({ line: 'desktop', name: `syntax plugins/dsh-free-model-pool/${entry}`, cmd: process.execPath, args: ['--check', join(dir, 'plugins/dsh-free-model-pool', entry)], cwd: dir })
  }
  for (const file of ['test/settings-read.test.js', 'test/routes.test.js']) {
    checks.push({
      line: 'desktop',
      name: `test free-model-pool (${file.replace('test/', '').replace('.test.js', '')})`,
      cmd: process.execPath,
      args: [join(dir, 'plugins/dsh-free-model-pool', file)],
      cwd: join(dir, 'plugins/dsh-free-model-pool'),
    })
  }
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
  for (const entry of ['index.js', 'client.js', 'lib/content.js', 'lib/routing.js', 'lib/capability.js', 'lib/store.js']) {
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
  // 本线 M1 的 L0/L1：语法检查 + 四组纯逻辑单测（配置模型：归一化/合并/迁移/
  // 首帧脚本/契约判定；围栏；持久化；client 半装载契约 —— 在无 `module` 的 VM 上下文里
  // 跑 factory，钉死「module is not defined」那类整包加载失败）。都不碰网络与 DSH 运行时，
  // 任意机器可复现；实机项（插件加载 / 设置栏出现 / 「关掉即原生」）见 smoke-test-matrix.md。
  for (const entry of ['index.js', 'client.js', 'lib/config.js', 'lib/avatar.js', 'lib/icon-presets.js', 'lib/store.js', 'lib/fence.js']) {
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
  checks.push({ line: 'usage', name: 'syntax scripts/dedupe-usage-ledger.mjs', cmd: process.execPath, args: ['--check', join(dir, 'scripts/dedupe-usage-ledger.mjs')], cwd: dir })
  checks.push({ line: 'usage', name: 'verify-client-bundle (client 半装载契约)', cmd: process.execPath, args: [join(dir, 'scripts/verify-client-bundle.mjs'), join(dir, 'lib/client.js')], cwd: dir })
}

/**
 * 仓库级治理闸门（跨八线生效，不属于任何单线）。
 *
 * 这两项补的是「逐例修不解决问题」的那类漏洞 —— 同类 bug 反复出现时，缺的不再是修法，
 * 而是让第 N 例无法悄悄进来的闸门（评审报告 §五.P2.10）：
 *   · silent-guards：守卫必须显式失败。四类形态（静默跳过 / 静默吞错 / 静默回退读取 /
 *     声明清单缺口），存量冻结在 scripts/silent-guard-baseline.json，**新增即失败**；
 *   · doc-versions：根 README 的版本台账必须与八线 package.json 逐字一致，
 *     治「文档说一个版本、代码是另一个版本」这类当前态失真。
 * 两项都零依赖、纯离线，受限沙箱与 CI 同样可跑。
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
