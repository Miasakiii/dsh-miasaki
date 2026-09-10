#!/usr/bin/env node
// 六线统一静态回归入口（L0 静态检查 + L1 单线单测）。
//
// 只跑「无外部依赖、可在任意机器复现」的检查：语法、单测、总线校验、令牌漂移、
// 运行时补丁离线自证。需要运行中的 DSH host 或桌面壳的实机项（L2 插件加载 /
// L3 冒烟 / L4 跨线联动）不在此脚本内——它们的清单在
// dsh-miasaki-shared-docs/cross/smoke-test-matrix.md。
//
// 用法：
//   node scripts/verify-all.mjs                      # 全部六线
//   node scripts/verify-all.mjs dual-model           # 只跑指定线
//                     （sidebar / canvas / fleet / desktop / ssh / dual-model）
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
const LINES = ['sidebar', 'canvas', 'fleet', 'desktop', 'ssh', 'dual-model']

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
  // G4：验证器选取与异构性判定（自验必须被拒；异构等级按厂商/模型判定）。
  checks.push({ line: 'fleet', name: 'test verifier (G4 异构验证)', cmd: process.execPath, args: [join(dir, 'tests/verifier.test.mjs')], cwd: dir })
  checks.push({ line: 'fleet', name: 'verifier-pick --check (G4 契约)', cmd: process.execPath, args: [join(dir, 'workers/graph/verifier-pick.mjs'), '--check'], cwd: dir })
  checks.push({ line: 'fleet', name: 'syntax fleet-monitor/server.js', cmd: process.execPath, args: ['--check', join(dir, 'fleet-monitor/server.js')], cwd: dir })
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
  for (const entry of ['index.js', 'client.js', 'app.js', 'lib/store.js', 'lib/runtime.js']) {
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
