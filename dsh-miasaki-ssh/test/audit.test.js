// Unit tests for the A1 audit ring (in-memory ring + append-only JSONL persistence).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditRing } from '../lib/audit.js'

test('audit: 追加按 seq 递增，list 倒序（最新在前）', () => {
  let clock = 0
  const ring = createAuditRing({ now: () => `t${++clock}` })
  ring.record({ hostId: 'a', command: 'ls', riskLevel: 'L0', decision: 'exit:0' })
  ring.record({ hostId: 'b', command: 'rm x', riskLevel: 'L1', decision: 'allowed-once' })
  const list = ring.list()
  assert.equal(list.length, 2)
  assert.equal(list[0].command, 'rm x', '最新在前')
  assert.equal(list[0].seq, 2)
  assert.equal(list[1].seq, 1)
})

test('audit: 封顶淘汰最旧（200 条）', () => {
  const ring = createAuditRing({ max: 3, now: () => 't' })
  for (let i = 1; i <= 5; i += 1) ring.record({ hostId: 'a', command: `c${i}`, riskLevel: 'L0', decision: 'd' })
  assert.equal(ring.size, 3)
  const list = ring.list()
  assert.deepEqual(list.map(item => item.command), ['c5', 'c4', 'c3'])
})

test('audit: hostId 过滤与 limit', () => {
  const ring = createAuditRing({ now: () => 't' })
  ring.record({ hostId: 'a', command: '1', riskLevel: 'L0', decision: 'd' })
  ring.record({ hostId: 'b', command: '2', riskLevel: 'L0', decision: 'd' })
  ring.record({ hostId: 'a', command: '3', riskLevel: 'L0', decision: 'd' })
  assert.deepEqual(ring.list({ hostId: 'a' }).map(item => item.command), ['3', '1'])
  assert.deepEqual(ring.list({ hostId: 'zzz' }), [])
  assert.equal(ring.list({ limit: 1 }).length, 1)
})

test('audit: clear 清空', () => {
  const ring = createAuditRing({ now: () => 't' })
  ring.record({ hostId: 'a', command: '1', riskLevel: 'L0', decision: 'd' })
  ring.clear()
  assert.equal(ring.size, 0)
  assert.deepEqual(ring.list(), [])
})

test('audit: 追加落盘，重建实例后仍可查（跨重启不失忆），seq 接续', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ssh-audit-')), 'exec-audit.jsonl')
  const first = createAuditRing({ file, now: () => 't1' })
  first.record({ hostId: 'h1', host: 'web-01', command: 'uname -a', riskLevel: 'L0', decision: 'exit:0' })
  first.record({ hostId: 'h1', host: 'web-01', command: 'rm -rf /', riskLevel: 'L2', decision: 'rejected' })
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2, '每条一行 JSONL')

  // 模拟 host 进程重启：新实例、同一文件
  const second = createAuditRing({ file, now: () => 't2' })
  const list = second.list()
  assert.equal(list.length, 2)
  assert.equal(list[0].decision, 'rejected', '最新在前（含重启前的历史）')
  assert.equal(list[0].seq, 2)
  const next = second.record({ hostId: 'h1', host: 'web-01', command: 'ls', riskLevel: 'L0', decision: 'exit:0' })
  assert.equal(next.seq, 3, 'seq 必须接续历史，不能从 1 重来')
})

test('audit: 台账只记命令与决策，不落任何输出内容', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ssh-audit-')), 'exec-audit.jsonl')
  const ring = createAuditRing({ file, now: () => 't' })
  ring.record({ hostId: 'h1', host: 'web-01', command: 'cat /etc/shadow', riskLevel: 'L1', decision: 'rejected' })
  const [entry] = ring.list()
  for (const key of ['stdout', 'stderr', 'output', 'password', 'privateKey']) {
    assert.equal(key in entry, false, `台账不得含 ${key}`)
  }
  const onDisk = readFileSync(file, 'utf8')
  assert.match(onDisk, /cat \/etc\/shadow/, '命令本身要落盘（事后可查被拒的是什么）')
  assert.equal(onDisk.includes('stdout'), false)
})

test('audit: 坏行跳过（脏数据不该让台账整体读不出来）', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ssh-audit-')), 'exec-audit.jsonl')
  writeFileSync(file, `${JSON.stringify({ seq: 1, at: 't', hostId: 'h', command: 'c1', riskLevel: 'L0', decision: 'd' })}\n{ not json\n${JSON.stringify({ seq: 2, at: 't', hostId: 'h', command: 'c2', riskLevel: 'L0', decision: 'd' })}\n`)
  const ring = createAuditRing({ file, max: 10, now: () => 't' })
  const list = ring.list()
  assert.deepEqual(list.map(item => item.command), ['c2', 'c1'])
})

test('audit: 超长文件懒加载时压回尾部（长期运行不无限增长）', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ssh-audit-')), 'exec-audit.jsonl')
  const lines = []
  for (let i = 1; i <= 1200; i += 1) lines.push(JSON.stringify({ seq: i, at: 't', hostId: 'h', command: `c${i}`, riskLevel: 'L0', decision: 'd' }))
  writeFileSync(file, `${lines.join('\n')}\n`)
  const ring = createAuditRing({ file, max: 5, now: () => 't' })
  const list = ring.list()
  assert.equal(list.length, 5)
  assert.equal(list[0].command, 'c1200', '尾部保留')
  assert.ok(readFileSync(file, 'utf8').split('\n').filter(Boolean).length <= 6, '超长文件被压回尾部')
})

test('audit: clear 只清内存，不删落盘历史', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ssh-audit-')), 'exec-audit.jsonl')
  const ring = createAuditRing({ file, now: () => 't' })
  ring.record({ hostId: 'h1', command: 'ls', riskLevel: 'L0', decision: 'exit:0' })
  ring.clear()
  assert.equal(ring.size, 0)
  assert.equal(readFileSync(file, 'utf8').includes('"decision":"exit:0"'), true, '审计不是可以随手擦掉的')
})
