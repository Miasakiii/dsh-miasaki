// Unit tests for the exec groundwork (P0-3, design/2026-09-26-ssh-zcode-benchmark-plan.md §4-P0-3).
// Channel behaviour is driven through an EventEmitter stand-in so the ssh2 exit/data
// ordering bugs are covered without a real server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  quotePosixShellArg,
  buildPosixShellExecCommand,
  execCommand,
  scanJsonLine,
} from '../lib/exec.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('quotePosixShellArg: 单引号包裹，内部单引号转义', () => {
  assert.equal(quotePosixShellArg('plain'), "'plain'")
  assert.equal(quotePosixShellArg('a b'), "'a b'")
  assert.equal(quotePosixShellArg("it's"), "'it'\\''s'")
  assert.equal(quotePosixShellArg('$(rm -rf /) `id` ${PATH}'), "'$(rm -rf /) `id` ${PATH}'")
  assert.equal(quotePosixShellArg(''), "''")
})

test('buildPosixShellExecCommand: 一律包 /bin/sh -c，命令不再受默认 shell 影响', () => {
  assert.equal(
    buildPosixShellExecCommand('command -v curl'),
    "/bin/sh -c 'command -v curl'",
  )
  // fish 会把外层未加引号的 `download=` 当错误；包装后这是 sh 的普通字符串
  const wrapped = buildPosixShellExecCommand('download=curl; echo $download')
  assert.match(wrapped, /^\/bin\/sh -c /)
  assert.match(wrapped, /download=curl; echo \$download/)
})

// 可驱动的客户端：exec 回调交出 channel，测试按任意时序发事件
function drivingClient() {
  let ready = null
  const client = {
    command: null,
    exec(command, cb) {
      const channel = new EventEmitter()
      channel.stdin = new EventEmitter()
      channel.stderr = new EventEmitter()
      let ended = false
      channel.end = () => { ended = true; channel.emit('end') }
      channel.wasEnded = () => ended
      client.command = command
      ready = { channel }
      cb(null, channel)
    },
    get channel() { return ready?.channel ?? null },
  }
  return client
}

test('execCommand: data → exit → close 收集 stdout 与退出码', async () => {
  const client = drivingClient()
  const promise = execCommand(client, 'uname -s', { drainWindowMs: 5 })
  const ch = client.channel
  ch.emit('data', Buffer.from('Linux\n'))
  ch.emit('exit', 0, null)
  ch.emit('close')
  const result = await promise
  assert.equal(result.stdout, 'Linux\n')
  assert.equal(result.code, 0)
  assert.equal(result.error, undefined)
})

test('execCommand: exit 早于 data（zcode 同款时序坑）不丢 stdout', async () => {
  const client = drivingClient()
  const promise = execCommand(client, 'uname -s', { drainWindowMs: 10 })
  const ch = client.channel
  ch.emit('exit', 0, null)
  ch.emit('data', Buffer.from('Linux'))
  ch.emit('close')
  const result = await promise
  assert.equal(result.stdout, 'Linux', '先 exit 后 data 也不能把输出吞了')
  assert.equal(result.code, 0)
})

test('execCommand: close 之后窗口内的迟到数据照样收进 stdout', async () => {
  const client = drivingClient()
  const promise = execCommand(client, 'echo hi', { drainWindowMs: 30 })
  const ch = client.channel
  ch.emit('data', Buffer.from('hi'))
  ch.emit('exit', 0, null)
  ch.emit('close')
  await sleep(10)
  ch.emit('data', Buffer.from('!')) // close 后迟到：排空窗口内
  const result = await promise
  assert.equal(result.stdout, 'hi!')
})

test('execCommand: stderr 单独收集，非零退出码如实带回', async () => {
  const client = drivingClient()
  const promise = execCommand(client, 'exit 3', { drainWindowMs: 5 })
  const ch = client.channel
  ch.emit('data', Buffer.from('out'))
  ch.stderr.emit('data', Buffer.from('boom'))
  ch.emit('exit', 3, null)
  ch.emit('close')
  const result = await promise
  assert.equal(result.stdout, 'out')
  assert.equal(result.stderr, 'boom')
  assert.equal(result.code, 3)
})

test('execCommand: 超时结束 channel 并标记 timedOut', async () => {
  const client = drivingClient()
  const promise = execCommand(client, 'read forever', { timeoutMs: 20, drainWindowMs: 5 })
  const ch = client.channel
  ch.emit('data', Buffer.from('partial'))
  await sleep(60) // 永远不发 exit/close
  const result = await promise
  assert.equal(result.timedOut, true)
  assert.equal(result.code, null)
  assert.equal(ch.wasEnded(), true, '超时必须主动结束 channel，不能挂着')
})

test('execCommand: exec 打开失败从结果对象回报，不 reject', async () => {
  const client = { exec(_cmd, cb) { cb(new Error('open failed')) } }
  const result = await execCommand(client, 'x')
  assert.equal(result.error, 'open failed')
  assert.equal(result.code, null)
})

test('execCommand: 输出超长截断且带标记', async () => {
  const client = drivingClient()
  const promise = execCommand(client, 'cat big', { drainWindowMs: 5, maxOutputBytes: 10 })
  const ch = client.channel
  ch.emit('data', Buffer.from('0123456789ABCDEFG'))
  ch.emit('exit', 0, null)
  ch.emit('close')
  const result = await promise
  assert.match(result.stdout, /0123456789/)
  assert.match(result.stdout, /\[输出过长已截断\]/)
})

test('scanJsonLine: 跳过 banner/motd/欢迎行找协议行，非 JSON 行留在 stdout', () => {
  const text = 'SSH-2.0-OpenSSH_9.6 banner\nWelcome, ops!\n{"type":"hello","v":1}\ntrailer\n'
  assert.deepEqual(scanJsonLine(text), { type: 'hello', v: 1 })
  assert.equal(scanJsonLine('no json here'), null)
  assert.equal(scanJsonLine('{broken'), null)
  assert.equal(scanJsonLine('[1,2,3]'), null, '数组不是协议对象')
})

test('execCommand: 命令经 POSIX 包装后才到 client.exec', async () => {
  const client = drivingClient()
  const promise = execCommand(client, "it's fine", { drainWindowMs: 5 })
  const ch = client.channel
  ch.emit('exit', 0, null)
  ch.emit('close')
  await promise
  assert.equal(client.command, "/bin/sh -c 'it'\\''s fine'")
})
