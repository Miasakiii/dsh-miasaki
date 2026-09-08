#!/usr/bin/env node
// 四线统一静态回归入口（L0 静态检查 + L1 单线单测）。
//
// 只跑「无外部依赖、可在任意机器复现」的检查：语法、单测、总线校验、令牌漂移。
// 需要运行中的 DSH host 或桌面壳的实机项（L2 插件加载 / L3 冒烟 / L4 跨线联动）
// 不在此脚本内——它们的清单在 dsh-miasaki-shared-docs/cross/smoke-test-matrix.md。
//
// 用法：
//   node scripts/verify-all.mjs            # 全部四线
//   node scripts/verify-all.mjs sidebar    # 只跑指定线（sidebar/canvas/fleet/desktop）
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
const LINES = ['sidebar', 'canvas', 'fleet', 'desktop']

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
  // F3 判活单测（本线首个自动化测试）+ F1 总线校验。
  checks.push({ line: 'fleet', name: 'test liveness (F3 心跳判活)', cmd: process.execPath, args: [join(dir, 'tests/liveness.test.mjs')], cwd: dir })
  checks.push({ line: 'fleet', name: 'syntax fleet-monitor/server.js', cmd: process.execPath, args: ['--check', join(dir, 'fleet-monitor/server.js')], cwd: dir })
  // Bus validation is the fleet line's regression suite (F1 contract).
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

/** 定位 cargo：优先 CARGO_HOME，其次 rustup 默认安装位置（PATH 里常没有）。 */
function cargoBin() {
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
