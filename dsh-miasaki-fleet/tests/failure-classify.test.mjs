// failure-classify.test.mjs — P1-A（2026-10-21）：派单失败分类器
//
// 覆盖 workers/lib/failure-classify.cjs（纯函数）与 workers/dispatch/classify-failure.mjs（CLI）：
//   · 八类失败：timeout / rate_limit / quota / auth / unavailable / context_overflow /
//     request_error / unknown（顺序敏感：context_overflow 必须先于 request_error）
//   · retryable（同 agent 可重试）与 suggest_switch（换异构 agent 可能有帮助）的语义分开
//   · 不猜：识别不了就 unknown，retryable/suggest_switch 都为 false
//   · CLI 退出码：0 成功 / 1 日志读取失败 / 2 用法错误
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { classifyFailure, FAILURE_KINDS } from '../workers/lib/failure-classify.cjs'

const FLEET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(FLEET_DIR, 'workers', 'dispatch', 'classify-failure.mjs')

const c = (input) => classifyFailure(input)

test('timeout：timedOut 优先于文本；retryable 与 suggest_switch 都为 true', () => {
  const r = c({ timedOut: true, exitCode: 124, stderr: '' })
  assert.equal(r.kind, 'timeout')
  assert.equal(r.retryable, true)
  assert.equal(r.suggest_switch, true)
  assert.ok(r.hint.length > 0)
})

test('rate_limit：429 / too many requests / 限流 都归一类', () => {
  for (const text of ['HTTP 429 Too Many Requests', 'rate limit exceeded', '请求被限流，请稍后重试']) {
    const r = c({ exitCode: 1, stderr: text })
    assert.equal(r.kind, 'rate_limit', text)
    assert.equal(r.retryable, true)
    assert.equal(r.suggest_switch, true)
  }
})

test('quota：额度/余额不足（402）可重试但语义是换账号', () => {
  const r = c({ exitCode: 1, stdout: 'Error: 402 insufficient credits; exceeded your current quota' })
  assert.equal(r.kind, 'quota')
  assert.equal(r.retryable, true)
})

test('auth：401/403 / invalid api key 不重试同一 agent，但可换 vendor', () => {
  const r = c({ exitCode: 1, stderr: '401 Unauthorized: invalid api key' })
  assert.equal(r.kind, 'auth')
  assert.equal(r.retryable, false)
  assert.equal(r.suggest_switch, true)
})

test('unavailable：网络/5xx 可重试', () => {
  for (const text of ['connect ECONNREFUSED 127.0.0.1:443', '503 Service Unavailable', 'upstream overloaded']) {
    const r = c({ exitCode: 1, stderr: text })
    assert.equal(r.kind, 'unavailable', text)
    assert.equal(r.retryable, true)
  }
})

test('context_overflow：必须在 request_error 之前命中（否则会被 400 吞掉）', () => {
  const r = c({ exitCode: 1, stderr: '400 Bad Request: prompt is too long / context window exceeded' })
  assert.equal(r.kind, 'context_overflow', '上下文溢出换 agent 没用，不能被归成 request_error')
  assert.equal(r.retryable, false)
  assert.equal(r.suggest_switch, false)
})

test('request_error：400/422 参数问题不重试、不换 agent', () => {
  const r = c({ exitCode: 1, stderr: '422 Unprocessable Entity: invalid argument' })
  assert.equal(r.kind, 'request_error')
  assert.equal(r.retryable, false)
  assert.equal(r.suggest_switch, false)
})

test('exit 127（CLI 缺失）归 unavailable：换已安装的 agent 有效', () => {
  const r = c({ exitCode: 127, stdout: '' })
  assert.equal(r.kind, 'unavailable')
  assert.equal(r.suggest_switch, true)
})

test('不猜：无文本且非已知退出码 ⇒ unknown（两个开关都为 false）', () => {
  const r = c({ exitCode: 1, stdout: 'something odd happened', stderr: '' })
  assert.equal(r.kind, 'unknown')
  assert.equal(r.retryable, false)
  assert.equal(r.suggest_switch, false)
  assert.ok(FAILURE_KINDS.includes(r.kind))
})

test('大小写与 stdout/stderr 两侧都参与匹配', () => {
  assert.equal(c({ exitCode: 1, stdout: 'RATE LIMIT', stderr: '' }).kind, 'rate_limit')
  assert.equal(c({ exitCode: 1, stdout: '', stderr: 'ECONNREFUSED' }).kind, 'unavailable')
})

// ---- CLI：只断言退出码（受限沙箱下捕获子进程管道会 EPERM，JSON 形状由纯函数覆盖） ----

function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: FLEET_DIR, stdio: 'ignore' })
  return r.status
}

test('CLI：正常分类 exit 0；缺 --exit-code exit 2；日志不存在 exit 1', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-fail-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const log = join(dir, 'out.log')
  writeFileSync(log, 'HTTP 429 Too Many Requests\n', 'utf8')

  assert.equal(runCli(['--exit-code', '1', '--log', log]), 0)
  assert.equal(runCli(['--exit-code', '124', '--timed-out']), 0)
  assert.equal(runCli(['--log', log]), 2, '缺 exit-code 是用法错误')
  assert.equal(runCli(['--exit-code', '1', '--log', join(dir, 'nope.log')]), 1, '日志读不到要显式失败，不猜')
})
