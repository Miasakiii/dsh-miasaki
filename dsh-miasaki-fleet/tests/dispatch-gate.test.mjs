// dispatch-gate.test.mjs — G1 可派闸门接线单测（2026-09-30）
//
// 覆盖 workers/dispatch/dispatch-task.ps1 新增的 Test-DispatchableGate：
//   派单前判「这个任务现在该不该派」—— 任务状态 / 依赖满足 / assignee 一致性（W1/W2）。
// 修的是什么：派单器此前只判「档案 / 开关 / 预算 / 能力」，**不判任务本身该不该派** ——
//   状态不是 queued、依赖未满足、assignee 指向别人，三种情况都能一路派下去。
//
// 为什么必须用夹具：真实台账 9 个任务**全部终态**（`task-ready --dispatchable` → 可派 0），
//   靠真实数据只能覆盖「拒绝」，覆盖不到「放行」—— 而闸门的第一风险恰恰是**误拒**。
//
// 做法：临时目录伪造最小 fleet 结构（state/tasks.jsonl + agents/<id>/ + tasks/<id>/brief.md），
//   以 -Workspace 指向夹具、-CheckOnly 跑闸门（不 spawn worker CLI、不写总线）。
//   输出与退出码经 pwsh 内部重定向落盘后回读，spawnSync 用 stdio:'ignore' ——
//   受限沙箱下捕获子进程管道会 EPERM（本仓已有教训，见 dispatch-state.test.mjs 头注）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const FLEET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(FLEET_DIR, 'workers', 'dispatch', 'dispatch-task.ps1')

/**
 * 找一个可用的 PowerShell（顺序与 dispatch-state.test.mjs 一致）：
 * PS7 已知安装路径 → PATH 里的 pwsh → Windows PowerShell 5.1。
 * 一律带 -ExecutionPolicy Bypass：默认策略拒绝执行未签名脚本（机器策略问题，非脚本问题）。
 * ⚠️ dispatch-task.ps1 用 PS7 语法（`??`），5.1 下会解析失败而**不是**闸门逻辑报错 ——
 * 故下方用例要求 PS7；只有 5.1 时整组 skip（不假装通过）。
 */
function detectPwsh() {
  const candidates = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    'pwsh',
  ].filter(Boolean)
  for (const exe of candidates) {
    const r = spawnSync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'exit 0'], { stdio: 'ignore' })
    if (!r.error && r.status === 0) return exe
  }
  return null
}
const PWSH = detectPwsh()

const NOW = '2026-09-30T00:00:00Z'

/**
 * 造一个最小 fleet 夹具。
 *
 * 目录布局刻意与真实 fleet 一致 —— 派单器与 task-ready.mjs 都按这个布局读盘，
 * 布局不一致会让测试测的是假东西。
 *
 * @param t 测试上下文（清理临时目录）
 * @param opts.status    任务状态（默认 queued）
 * @param opts.assignee  台账里的 assignee（默认 alpha）
 * @param opts.enabled   assignee 的 control.json 开关（默认 true）
 * @param opts.liveness  'idle' 有心跳的空闲 | 'running-stale' 僵尸 | 'running-fresh' 正在跑 | 'none' 从未运行（无 status.json）
 * @param opts.dependsOn 依赖的上游任务（自动建为 queued，用于覆盖「依赖未满足」）
 * @param opts.corruptLedger 往台账追加一行坏 JSON（覆盖「坏行 ⇒ 判定不可信」）
 * @param opts.peerEnabled 同侪 agent（beta）的 control.json 开关（覆盖 G4「候选存在但都不可用」）
 * @param opts.risk 在 brief 里追加 `risk: <值>` 行（覆盖 G4 验证闸门）
 */
function fixture(t, opts = {}) {
  const {
    taskId = 't-9001',
    status = 'queued',
    assignee = 'alpha',
    enabled = true,
    peerEnabled = true,
    liveness = 'idle',
    dependsOn = [],
    corruptLedger = false,
    risk = null,
    briefExtra = '',
  } = opts

  const dir = mkdtempSync(join(tmpdir(), 'fleet-gate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  mkdirSync(join(dir, 'state'), { recursive: true })
  mkdirSync(join(dir, 'tasks', taskId), { recursive: true })

  // ---- 台账（state/tasks.jsonl，追加式）----
  const rows = []
  for (const up of dependsOn) {
    rows.push({
      op: 'create',
      task: {
        id: up, title: '夹具上游任务', assignee, status: 'queued',
        created_at: NOW, updated_at: NOW, retries: 0, tokens: 0, cost: 0,
        depends_on: [], waiting_for: null,
      },
    })
    mkdirSync(join(dir, 'tasks', up), { recursive: true })
    writeFileSync(join(dir, 'tasks', up, 'brief.md'), `# 夹具上游 ${up}\n`, 'utf8')
  }
  rows.push({
    op: 'create',
    task: {
      id: taskId, title: '夹具任务', assignee, status: 'queued',
      created_at: NOW, updated_at: NOW, retries: 0, tokens: 0, cost: 0,
      depends_on: dependsOn, waiting_for: null,
    },
  })
  if (status !== 'queued') {
    rows.push({ op: 'update', task_id: taskId, status, updated_at: NOW })
  }
  writeFileSync(join(dir, 'state', 'tasks.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  // ---- agent 档案：alpha = 台账 assignee，beta = 用于「assignee 不一致」用例 ----
  for (const id of ['alpha', 'beta']) {
    const adir = join(dir, 'agents', id)
    mkdirSync(adir, { recursive: true })
    writeFileSync(join(adir, 'manifest.json'), JSON.stringify({
      id,
      limits: { budget_per_day: 2.0, heartbeat_ms: 30000 },
      cli: { invoke: `${id} -p {prompt}` },
      metering_source: 'unknown',
    }, null, 2), 'utf8')
    writeFileSync(join(adir, 'control.json'), JSON.stringify({
      enabled: id === assignee ? enabled : peerEnabled,
      force_kill: false,
      updated_at: NOW,
      updated_by: 'fixture',
    }, null, 2), 'utf8')
  }

  // ---- 心跳：只给 assignee 写，另一个 agent 保持「从未运行」----
  if (liveness !== 'none') {
    const isRunning = liveness === 'running-stale' || liveness === 'running-fresh'
    // 除四个预设外，`liveness` 也可直接写一个 status.json 的 state（如 `stopped` / `error`），
    // 用于覆盖 -ResetStatus 在不同状态下的分支。
    const state = isRunning ? 'running' : liveness
    const beat = liveness === 'running-stale'
      ? new Date(Date.now() - 3_600_000).toISOString()   // 1 小时前 ⇒ 远超 30s×3 的 stale 上限
      : liveness === 'running-fresh'
        ? new Date().toISOString()                       // 刚刚 ⇒ 新鲜（无法排除「真在跑」）
        : NOW
    writeFileSync(join(dir, 'agents', assignee, 'status.json'), JSON.stringify({
      version: 1,
      agent_id: assignee,
      state,
      current_task: isRunning ? taskId : null,
      progress: 1.0,
      step: '夹具',
      heartbeat_at: beat,
      tokens: { task: 0, session: 0, day: 0 },
      last_error: state === 'error' ? '夹具：上次派单失败（这条线索不该被 reset 抹掉）' : null,
    }, null, 2), 'utf8')
  }

  // ---- 同侪 agent（beta）补一份 idle 心跳 ----
  // 为什么必须补：G4 的验证者选取把 `alive=false` 判为**不可用**（verifier.cjs:154），
  // 而「无 status.json」在 liveness 里正是 `alive=false` ⇒ 不补心跳，任何候选都不可用。
  // ⚠️ 这条同时暴露一个**判定层不一致**（G1 有冷启动降级、G4 没有），已记进规划文档 §11.4。
  if (assignee !== 'beta') {
    writeFileSync(join(dir, 'agents', 'beta', 'status.json'), JSON.stringify({
      version: 1,
      agent_id: 'beta',
      state: 'idle',
      current_task: null,
      progress: 1.0,
      step: '夹具',
      heartbeat_at: NOW,
      tokens: { task: 0, session: 0, day: 0 },
      last_error: null,
    }, null, 2), 'utf8')
  }

  // ---- 台账坏行（F6 用例）：一行无法解析的 JSON，读取侧会静默跳过 ----
  if (corruptLedger) {
    appendFileSync(join(dir, 'state', 'tasks.jsonl'), '{ 这不是合法 JSON\n', 'utf8')
  }

  // ---- brief：**刻意不写 requires** —— 隔离被测闸门，不让能力闸门参与判定 ----
  // `risk` 仅在用例显式要求时写入（其余用例覆盖「未声明即跳过」）；`briefExtra` 用于注入
  // 「prompt 里含引号」这类命令构造用例的内容。
  writeFileSync(
    join(dir, 'tasks', taskId, 'brief.md'),
    `# 夹具任务 ${taskId}\n\n## 约束\n- 夹具：不声明 requires（跳过能力闸门）\n`
      + (risk ? `risk: ${risk}\n` : '')
      + briefExtra,
    'utf8',
  )

  return dir
}

/**
 * 跑一次 -CheckOnly 闸门，返回 { status, text }。
 *
 * 输出经 pwsh 内部 `*>&1 | Out-File` 落盘再回读：Write-Host 走信息流，
 * 而受限沙箱下 spawnSync 捕获管道会 EPERM —— 落盘回读两条都绕开。
 */
/**
 * 跑一次派单脚本，返回 { status, text }。
 *
 * @param args 传给脚本的参数（**不含** -Workspace，由本函数统一追加）
 */
function runScript(t, fixDir, args) {
  const outFile = join(fixDir, '_gate-out.txt')
  // 形态有讲究（两处都实测踩过）：
  //   ① `*>&1 | Out-File` 必须**紧跟被重定向的命令** —— `*>&1` 是重定向操作符，
  //      拆成独立语句非法（换行分隔时该行静默失效，输出文件空 ⇒ 断言全部读到 ''）；
  //   ② 语句用 `;` 单行分隔，别用换行（换行在 -Command 下的行为不一致）。
  // 参数名（`-Xxx`）**不能加引号** —— `'-TaskId'` 在 PowerShell 里是字符串字面量而非参数名，
  // 会让整个调用退化成位置参数（实测：13 个用例全挂）。只给取值加引号。
  const quoted = args.map((a) => (a.startsWith('-') ? a : `'${a}'`)).join(' ')
  const cmd = [
    `& '${SCRIPT}' ${quoted} -Workspace '${fixDir}' *>&1 | Out-File -FilePath '${outFile}' -Encoding UTF8`,
    'exit $LASTEXITCODE',
  ].join('; ')
  // ③ PATH 必须**前置真 node.exe 所在目录**（2026-09-30 实测踩到，假红）：
  //    派单器内部用 `& node <判定器>` 调 task-ready / agent-pick / verifier-pick，按 PATH 解析 node。
  //    而本仓钦定的「对齐 CI Node 版本」复跑方式是 `npx -y node@22.19.0 scripts/verify-all.mjs` ——
  //    此时 PATH 首位是 npx 的 `.bin`，那里**只有 `node`（sh 脚本）/`node.cmd`/`node.ps1`，没有 `node.exe`**
  //    ⇒ pwsh 的 `& node` 命中 `node.ps1`，该 shim 调向 `../node/bin/node`（Windows 下无扩展名，
  //    不是可执行文件）⇒ **零输出** ⇒ 派单器判「判定器输出无法解析」并拒绝派单 ⇒
  //    本文件全部「放行」用例假红（Node 24 直跑时 PATH 命中真 `node.exe`，故本机一直是绿的）。
  //    前置 `process.execPath` 目录后两种环境都命中真 node.exe（CI 的 setup-node 亦然），
  //    测试因此**只依赖 Node 版本、不依赖外部 PATH 形态**。
  const nodeDir = dirname(process.execPath)
  const env = { ...process.env, PATH: `${nodeDir}${delimiter}${process.env.PATH ?? ''}` }
  const r = spawnSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { stdio: 'ignore', env })
  const text = existsSync(outFile) ? readFileSync(outFile, 'utf8') : ''
  return { status: r.status, text }
}

/** 跑派单前预检（`-CheckOnly`）：本文件里全部闸门判定的入口。 */
function runGate(t, fixDir, taskId, agent = 'alpha') {
  return runScript(t, fixDir, ['-TaskId', taskId, '-Agent', agent, '-CheckOnly'])
}

test('夹具自证：真实的 fleet 台账里没有 t-9001（证明闸门读的是 -Workspace 指向的夹具）', () => {
  const real = readFileSync(join(FLEET_DIR, 'state', 'tasks.jsonl'), 'utf8')
  assert.ok(!real.includes('t-9001'), '夹具任务 id 不应与真实台账冲突')
})

test('可派任务（queued + assignee 一致 + 依赖已满足）→ 闸门放行 exit 0', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t)
  const r = runGate(t, fix, 't-9001', 'alpha')
  assert.equal(r.status, 0, `应放行；实际输出：\n${r.text}`)
  assert.match(r.text, /\[gate\] 闸门通过/)
  // 开关判定本地与 G1 一致时不应报分歧 —— 分歧告警只在真的漂移时出现
  assert.doesNotMatch(r.text, /口径分歧/)
  // -CheckOnly 是预检：绝不写总线（事件流由派单路径写，预检不落任何盘）
  assert.ok(!existsSync(join(fix, 'state', 'graph-events.jsonl')), '预检不应写事件流')
})

test('状态不是 queued（done）→ 拒绝 exit 2，且点名状态', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t, { status: 'done' })
  const r = runGate(t, fix, 't-9001', 'alpha')
  assert.equal(r.status, 2)
  assert.match(r.text, /拒绝派单/)
  assert.match(r.text, /状态为 done，不是 queued/)
})

test('assignee 不一致（台账 alpha，-Agent beta）→ 拒绝 exit 2，并提示走 reassign 补丁', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t)
  const r = runGate(t, fix, 't-9001', 'beta')
  assert.equal(r.status, 2)
  assert.match(r.text, /台账 assignee=alpha，本次 -Agent=beta/)
  assert.match(r.text, /reassign 补丁/)
})

test('依赖未满足（上游仍 queued）→ 拒绝 exit 2，且点名上游', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t, { dependsOn: ['t-9000'] })
  const r = runGate(t, fix, 't-9001', 'alpha')
  assert.equal(r.status, 2)
  assert.match(r.text, /t-9000 未完成/)
})

test('开关未开启 → 拒绝 exit 2（开关检查随 G1 闸门一并生效）', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t, { enabled: false })
  const r = runGate(t, fix, 't-9001', 'alpha')
  assert.equal(r.status, 2)
  assert.match(r.text, /开关未开启/)
  // 本地判定与 G1 判定都读到同一份 control.json ⇒ 不应出现分歧告警
  assert.doesNotMatch(r.text, /口径分歧/)
})

test('冷启动：agent 从未运行过（无 status.json）→ 放行 exit 0，并显式降级为告警', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t, { liveness: 'none' })
  const r = runGate(t, fix, 't-9001', 'alpha')
  assert.equal(r.status, 0, `判活的本意是防僵尸、不是防首跑；实际输出：\n${r.text}`)
  assert.match(r.text, /无 status\.json（从未运行过），判活按首跑放行/)
})

test('僵尸（running 但心跳过龄 1 小时）→ 拒绝 exit 2（降级只对首跑生效）', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t, { liveness: 'running-stale' })
  const r = runGate(t, fix, 't-9001', 'alpha')
  assert.equal(r.status, 2)
  assert.match(r.text, /判活失败/)
})

test('任务不在台账 → 拒绝 exit 2（判定器 exit 2 不得被当成放行）', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t)
  const r = runGate(t, fix, 't-9999', 'alpha')
  assert.equal(r.status, 2)
  assert.match(r.text, /判定器无法给出结论/)
})

test('台账存在坏行 → 拒绝 exit 2，并指向 validate-bus（复核 F6）', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t, { corruptLedger: true })
  const r = runGate(t, fix, 't-9001', 'alpha')
  assert.equal(r.status, 2, `坏行台账不得被当成可信判定；实际：\n${r.text}`)
  assert.match(r.text, /台账有 1 行无法解析/)
  assert.match(r.text, /validate-bus/)
})

test('F1 · 无 status.json → -ResetStatus 是空操作（exit 0）', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t, { liveness: 'none' })
  const r = runScript(t, fix, ['-Agent', 'alpha', '-ResetStatus'])
  assert.equal(r.status, 0)
  assert.match(r.text, /本就按「首跑」判定/)
})

test('F1 · 崩溃残留（running + 心跳过龄）→ -ResetStatus 清除成功', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t, { liveness: 'running-stale' })
  const r = runScript(t, fix, ['-Agent', 'alpha', '-ResetStatus'])
  assert.equal(r.status, 0, `应清除成功；实际：\n${r.text}`)
  assert.ok(!existsSync(join(fix, 'agents', 'alpha', 'status.json')), '残留档案应被删除')
  assert.match(r.text, /已清除 status\.json/)
})

test('F1 · 残留清除后闸门放行（恢复闭环，而不只是删文件）', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t, { liveness: 'running-stale' })
  const before = runGate(t, fix, 't-9001', 'alpha')
  assert.equal(before.status, 2, '清除前应被闸门拒绝 —— 这正是 F1 的危害形态（永久派不出去）')
  assert.match(before.text, /判活失败/)
  // 顺带钉住「拒绝文案必须给出可复制的恢复命令」——否则用户唯一出路是手工改文件
  assert.match(before.text, /-ResetStatus/)
  assert.equal(runScript(t, fix, ['-Agent', 'alpha', '-ResetStatus']).status, 0)
  const after = runGate(t, fix, 't-9001', 'alpha')
  assert.equal(after.status, 0, `清除后应放行；实际：\n${after.text}`)
  assert.match(after.text, /判活按首跑放行/)
})

test('F1 · 心跳新鲜（无法排除真在跑）→ -ResetStatus 拒绝 exit 2 且不删文件', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t, { liveness: 'running-fresh' })
  const r = runScript(t, fix, ['-Agent', 'alpha', '-ResetStatus'])
  assert.equal(r.status, 2)
  assert.match(r.text, /心跳新鲜/)
  assert.ok(existsSync(join(fix, 'agents', 'alpha', 'status.json')), '不得误删可能正在干活的档案')
})

test('F1 · state=error（不影响派单）→ -ResetStatus 拒绝清除，保住失败线索', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t, { liveness: 'error' })
  const r = runScript(t, fix, ['-Agent', 'alpha', '-ResetStatus'])
  assert.equal(r.status, 0)
  assert.match(r.text, /无需清除/)
  assert.ok(
    existsSync(join(fix, 'agents', 'alpha', 'status.json')),
    'error 档案里的 last_error 是「上次为什么失败」的线索，不该被 reset 抹掉（真机实测踩到后收窄）',
  )
})

test('F1 · state=stopped（判活恒 false，会挡派单）→ -ResetStatus 清除成功', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t, { liveness: 'stopped' })
  const r = runScript(t, fix, ['-Agent', 'alpha', '-ResetStatus'])
  assert.equal(r.status, 0, `stopped 会挡派单，应允许清除；实际：\n${r.text}`)
  assert.match(r.text, /判活恒为 false/)
  assert.ok(!existsSync(join(fix, 'agents', 'alpha', 'status.json')))
})

test('G4 · 未声明风险 → 跳过验证闸门（零行为变更）', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t)
  const r = runGate(t, fix, 't-9001', 'alpha')
  assert.equal(r.status, 0)
  assert.match(r.text, /跳过验证闸门/)
})

test('G4 · risk: agent 且存在异构 agent → 验证闸门放行', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t, { risk: 'agent' })
  const r = runGate(t, fix, 't-9001', 'alpha')
  assert.equal(r.status, 0, `应放行；实际：\n${r.text}`)
  assert.match(r.text, /\[verifier\] 闸门通过/)
})

test('G4 · 候选存在但都不可用（同侪开关未开）→ 拒绝 exit 2', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t, { risk: 'agent', peerEnabled: false })
  const r = runGate(t, fix, 't-9001', 'alpha')
  assert.equal(r.status, 2, `「有人但都不可用」不得当成通过；实际：\n${r.text}`)
  assert.match(r.text, /无\*\*可用\*\*验证者/)
})

test('G4 · risk: high（要求 vendor 级）但厂商未登记 → 拒绝 exit 2', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t, { risk: 'high' })
  const r = runGate(t, fix, 't-9001', 'alpha')
  assert.equal(r.status, 2)
  assert.match(r.text, /无\*\*可用\*\*验证者/)
})

test('G4 · 非法等级值 → 拒绝 exit 2（不猜）', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t, { risk: '随便什么' })
  const r = runGate(t, fix, 't-9001', 'alpha')
  assert.equal(r.status, 2)
  assert.match(r.text, /无法识别的验证等级/)
})

test('G4 · risk: none（自验是禁止项）→ 同样拒绝，不当作「无需验证」', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t, { risk: 'none' })
  const r = runGate(t, fix, 't-9001', 'alpha')
  assert.equal(r.status, 2)
  assert.match(r.text, /无法识别的验证等级/)
})

test('命令构造：prompt 里的引号**不泄漏**成 CLI 参数（2026-09-30 实测缺陷的闸门）', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  // brief 里写入带引号 + 形似参数的内容 —— 正是实测踩坑的形态：
  // 旧实现把 prompt 拼进命令行再手工切分，`"X"` 提前闭合引号模式，`-A` / `20` 泄漏成 CLI 参数，
  // pi 直接 `Unknown option: -A` 退出，而**没有任何地方提示「prompt 里有引号」**。
  const fix = fixture(t, {
    briefExtra: '```bash\ngrep -n "PATCH_PATH_RULES" -A 20 workers/lib/bus-contract.cjs\n```\n',
  })
  const r = runScript(t, fix, ['-TaskId', 't-9001', '-Agent', 'alpha', '-ShowCommand'])
  assert.equal(r.status, 0, `-ShowCommand 应正常退出；实际：\n${r.text}`)
  assert.match(r.text, /argc=3/, `alpha -p {prompt} 应切成 3 个 argv 元素；实际：\n${r.text}`)
  assert.match(r.text, /作为单个参数传入/)
  assert.doesNotMatch(r.text, /-A/, 'prompt 里的 -A 是**内容**，不得出现在 argv 里')
})

test('-ShowCommand 是只读入口：不派单、不写总线', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const fix = fixture(t)
  const r = runScript(t, fix, ['-TaskId', 't-9001', '-Agent', 'alpha', '-ShowCommand'])
  assert.equal(r.status, 0)
  assert.match(r.text, /\[cmd\] exe=/, '应打印将要执行的 argv')
  assert.ok(!existsSync(join(fix, 'state', 'graph-events.jsonl')), '-ShowCommand 不得写事件流')
  assert.ok(!existsSync(join(fix, 'agents', 'alpha', 'usage.jsonl')), '-ShowCommand 不得写 usage')
})

test('命令构造：cmd: 行的**成对引号**被剥离（否则命令会静默失败成 exit 0）', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  // 实测踩坑：`cmd: node -e "process.exit(3)"` 曾把字面量 `"process.exit(3)"` 传给 node ——
  // 它在 JS 里是合法的字符串表达式 ⇒ 命令静默 exit 0，派单器记成**成功**（本该 exit 3）。
  const fix = fixture(t, { briefExtra: 'cmd: node -e "process.exit(3)"\n' })
  const r = runScript(t, fix, ['-TaskId', 't-9001', '-Agent', 'alpha', '-ShowCommand'])
  assert.equal(r.status, 0, `-ShowCommand 应正常退出；实际：\n${r.text}`)
  assert.match(r.text, /\[cmd\] exe=node argc=3/, `应切成 node + -e + 表达式；实际：\n${r.text}`)
  assert.match(r.text, /\[2\] process\.exit\(3\)/, '第 2 个参数应是**不带引号**的表达式')
  assert.doesNotMatch(r.text, /\[2\] "process\.exit/, '外层引号必须被剥掉')
})

test('派单器语法闸门（含新增的 Test-DispatchableGate / Write-BusEvent）', (t) => {
  if (!PWSH) return t.skip('本机无 PS7')
  const dir = mkdtempSync(join(tmpdir(), 'fleet-gate-syntax-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const errFile = join(dir, 'errors.txt')
  // 用 PS7 解析器：dispatch-task.ps1 头部明示运行环境为 PowerShell 7+（用了 ?? 运算符）
  const cmd = [
    '$e = $null; $t = $null',
    `[System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT}', [ref]$t, [ref]$e) | Out-Null`,
    `if ($e) { $e | ForEach-Object { '{0}:{1}: {2}' -f $_.Extent.StartLineNumber, $_.Extent.StartColumnNumber, $_.Message } | Set-Content '${errFile}' -Encoding UTF8; exit 1 }`,
    'exit 0',
  ].join('\n')
  const r = spawnSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { stdio: 'ignore' })
  const detail = existsSync(errFile) ? readFileSync(errFile, 'utf8').trim() : '(无详情)'
  assert.equal(r.status, 0, `PowerShell 语法错误：\n${detail}`)
})
