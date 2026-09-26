// Unit tests for the SFTP transfer layer with the zcode-style degradation chain (U2.2).
// A stand-in SFTP wrapper + Node streams cover: status labels, progress throttling,
// directory/stat mapping, resilient upload (sftp → exec pipe), and error tagging.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import {
  sftpStatusLabel,
  formatSftpError,
  createProgressReporter,
  listDirectory,
  statRemote,
  uploadFromReadable,
  uploadViaExecPipe,
  uploadResilient,
  downloadToWritable,
  openSftpSession,
  posixDirname,
  ssh2ExecOpener,
} from '../lib/sftp.js'

// ---- fakes -----------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function fakeSftp({ entries = {}, stats = {}, writeError = null, readError = null } = {}) {
  const created = []
  return {
    created,
    stat(path, cb) {
      const item = stats[path]
      if (item === undefined) { const err = new Error('no such file'); err.code = 2; cb(err); return }
      cb(null, item)
    },
    readdir(path, cb) {
      const list = entries[path]
      if (list === undefined) { const err = new Error('no such file'); err.code = 2; cb(err); return }
      cb(null, list)
    },
    realpath(path, cb) { cb(null, path) },
    createWriteStream(path) {
      const chunks = []
      const stream = new Writable({
        write(chunk, _enc, cb2) {
          chunks.push(Buffer.from(chunk))
          // 真实时序：写完若干块之后服务端才回状态失败（不是创建即炸 ——
          // 同步排空的源流会让 stream 先 finish 自毁，destroy 落空）
          if (writeError !== null && chunks.length >= (writeError.afterChunks ?? 1)) {
            process.nextTick(() => stream.destroy(writeError.err))
          }
          cb2()
        },
      })
      stream.path = path
      stream.chunks = chunks
      if (writeError === null) {
        stream.on('finish', () => setImmediate(() => stream.emit('close')))
      }
      created.push({ kind: 'write', path, stream })
      return stream
    },
    createReadStream(path) {
      const item = stats[path]
      const stream = new Readable({ read() {} })
      stream.path = path
      if (readError !== null) {
        setImmediate(() => stream.destroy(readError))
      } else {
        const content = Buffer.from(item?.content ?? '')
        setImmediate(() => { if (content.length > 0) stream.push(content); stream.push(null) })
      }
      created.push({ kind: 'read', path, stream })
      return stream
    },
  }
}

function sourceOf(text, { chunkSize = 4 } = {}) {
  const buffer = Buffer.from(text)
  let offset = 0
  return new Readable({
    read() {
      if (offset >= buffer.length) { this.push(null); return }
      this.push(buffer.subarray(offset, offset + chunkSize))
      offset += chunkSize
    },
  })
}

function collectSink() {
  const chunks = []
  const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb() } })
  sink.text = () => Buffer.concat(chunks).toString('utf8')
  sink.bytes = () => Buffer.concat(chunks).length
  return sink
}

function fakeExecChannel({ exitCode = 0 } = {}) {
  const received = []
  const stdin = new Writable({ write(chunk, _e, cb) { received.push(Buffer.from(chunk)); cb() } })
  const listeners = []
  return {
    stdin,
    received: () => Buffer.concat(received).toString('utf8'),
    onClose(cb) { listeners.push(cb) },
    fireClose(code = exitCode) { for (const cb of listeners) cb(code) },
  }
}

// ---- tests -----------------------------------------------------------------

test('sftpStatusLabel / formatSftpError: 数字 code 变可读标签', () => {
  assert.equal(sftpStatusLabel(2), 'NO_SUCH_FILE')
  assert.equal(sftpStatusLabel(3), 'PERMISSION_DENIED')
  assert.equal(sftpStatusLabel(99), 'UNKNOWN(99)')
  assert.equal(sftpStatusLabel('x'), null)
  const err = Object.assign(new Error('failure'), { code: 3 })
  assert.match(formatSftpError(err), /PERMISSION_DENIED/)
})

test('createProgressReporter: 1s / 5% / 终点才回调，force 去重', () => {
  let now = 0
  const events = []
  const report = createProgressReporter({ onProgress: e => events.push(e), totalBytes: 1000, now: () => now })
  now = 100; report(100)                       // 10%：触发
  now = 150; report(140)                       // 14%：未到 5% 步进也未到 1s：吞
  now = 1200; report(200)                      // 到 1s：触发
  now = 1201; report(200, { force: true })     // force 但数字与百分比都没变：去重
  now = 1300; report(1000, { force: true })    // 到达终点：触发
  assert.equal(events.length, 3)
  assert.equal(events[0].transferredBytes, 100)
  assert.equal(events[2].percent, 100)
  assert.ok(events[2].bytesPerSecond >= 0)
})

test('listDirectory: 映射类型/大小/时间，跳过 . 与 ..', async () => {
  const sftp = fakeSftp({
    entries: {
      '/srv': [
        { filename: '.', attrs: { size: 0, mtime: 1, mode: 0o755, isDirectory: () => true } },
        { filename: '..', attrs: { size: 0, mtime: 1, mode: 0o755, isDirectory: () => true } },
        { filename: 'logs', attrs: { size: 4096, mtime: 1700000000, mode: 0o755, isDirectory: () => true } },
        { filename: 'a.txt', attrs: { size: 12, mtime: 1700000001, mode: 0o644, isFile: () => true } },
        { filename: 'link', attrs: { size: 7, mtime: 1700000002, mode: 0o777, isSymbolicLink: () => true } },
      ],
    },
  })
  const list = await listDirectory(sftp, '/srv')
  assert.deepEqual(list.map(e => e.name), ['logs', 'a.txt', 'link'])
  assert.deepEqual(list.map(e => e.type), ['dir', 'file', 'link'])
  assert.equal(list[1].mtime, 1700000001 * 1000)
})

test('statRemote: 单条元信息映射', async () => {
  const sftp = fakeSftp({ stats: { '/srv/a.txt': { size: 12, mtime: 1700000001, mode: 0o644, isFile: () => true } } })
  const stats = await statRemote(sftp, '/srv/a.txt')
  assert.equal(stats.type, 'file')
  assert.equal(stats.size, 12)
})

test('uploadFromReadable: 顺利路径 —— 计数、强制收尾进度、写流收到全部字节', async () => {
  const sftp = fakeSftp({ stats: { '/srv': { isDirectory: () => true } } })
  const events = []
  const result = await uploadFromReadable(sftp, '/srv/a.txt', sourceOf('hello world'), { onProgress: e => events.push(e), size: 11, overwrite: true })
  assert.equal(result.transferredBytes, 11)
  const write = sftp.created.find(c => c.kind === 'write')
  assert.equal(Buffer.concat(write.stream.chunks).toString(), 'hello world')
  assert.ok(events.at(-1).percent === 100, '收尾必须有一次强制进度')
})

test('uploadFromReadable: overwrite=false 且目标存在 ⇒ TARGET_EXISTS（零字节消耗）', async () => {
  const sftp = fakeSftp({ stats: { '/srv/a.txt': { size: 1, isFile: () => true } } })
  await assert.rejects(
    uploadFromReadable(sftp, '/srv/a.txt', sourceOf('x'), { overwrite: false }),
    error => error.code === 'TARGET_EXISTS',
  )
  assert.equal(sftp.created.filter(c => c.kind === 'write').length, 0, '不该创建写流')
})

test('uploadFromReadable: stat 报 NO_SUCH_FILE 放行，其余 stat 错误如实抛', async () => {
  const ok = fakeSftp({ stats: { '/srv': { isDirectory: () => true } } })
  const r = await uploadFromReadable(ok, '/srv/a.txt', sourceOf('x'), { overwrite: false })
  assert.equal(r.transferredBytes, 1)
  const denied = fakeSftp({ stats: {} })
  // stats 为空 ⇒ 任何 stat 都是 NO_SUCH_FILE；换成权限错要用自定义 fake
  denied.stat = (path, cb) => { const err = new Error('permission denied'); err.code = 3; cb(err) }
  await assert.rejects(
    uploadFromReadable(denied, '/srv/a.txt', sourceOf('x'), { overwrite: false }),
    /permission denied/,
  )
})

test('uploadFromReadable: 写流中断 ⇒ sftp-write 结构化失败', async () => {
  const sftp = fakeSftp({ writeError: { afterChunks: 1, err: Object.assign(new Error('NO_SUCH_FILE'), { code: 2 }) } })
  await assert.rejects(
    uploadFromReadable(sftp, '/srv/a.txt', sourceOf('xxxxx'), { overwrite: true }),
    error => error.uploadFailureKind === 'sftp-write',
  )
})

test('uploadViaExecPipe: mkdir -p && cat > 的降级通道，exit 0 记 transport:exec', async () => {
  const channel = fakeExecChannel({ exitCode: 0 })
  const promise = uploadViaExecPipe({
    openExec: async command => { assert.match(command, /^mkdir -p '\/srv\/new\/deep' && cat > '\/srv\/new\/deep\/a\.txt'$/); return channel },
    path: '/srv/new/deep/a.txt',
    source: sourceOf('payload'),
    onProgress: () => {},
  })
  await sleep(10) // 等源流排空
  channel.fireClose(0)
  const result = await promise
  assert.equal(result.transport, 'exec')
  assert.equal(result.transferredBytes, 7)
  assert.equal(channel.received(), 'payload')
})

test('uploadViaExecPipe: 非零 exit ⇒ 拒绝且带退出码', async () => {
  const channel = fakeExecChannel()
  const promise = uploadViaExecPipe({
    openExec: async () => channel,
    path: '/srv/a.txt',
    source: sourceOf('payload'),
  })
  await sleep(10) // 等 openExec 的 await 完成、onClose 注册
  channel.fireClose(1)
  await assert.rejects(promise, /exit code 1/)
})

test('uploadResilient: 目录在 sftp 视图不存在 ⇒ 零字节消耗直降 exec', async () => {
  const sftp = fakeSftp({ stats: { '/srv': { isDirectory: () => true } } }) // /srv 可见，/srv/new 不可见
  const channel = fakeExecChannel()
  const promise = uploadResilient({
    sftp,
    path: '/srv/new/deep/a.txt',
    source: sourceOf('payload'),
    overwrite: false,
    openExec: async () => channel,
  })
  await sleep(10)
  channel.fireClose(0)
  const result = await promise
  assert.equal(result.transport, 'exec', 'gateway 把两个视图分开时不能误判成路径错误')
  assert.equal(channel.received(), 'payload')
  assert.equal(sftp.created.filter(c => c.kind === 'write').length, 0, 'sftp 写流一个字节都不该建')
})

test('uploadResilient: 目录可见走 sftp 主路径', async () => {
  const sftp = fakeSftp({ stats: { '/srv': { isDirectory: () => true } } })
  const result = await uploadResilient({
    sftp,
    path: '/srv/a.txt',
    source: sourceOf('payload'),
    overwrite: true,
    openExec: async () => { throw new Error('不该走到 exec') },
  })
  assert.equal(result.transport, 'sftp')
  assert.equal(result.transferredBytes, 7)
})

test('uploadResilient: 目录 stat 权限错误不降级，如实抛', async () => {
  const sftp = fakeSftp({ stats: {} })
  sftp.stat = (path, cb) => { const err = new Error('permission denied'); err.code = 3; cb(err) }
  await assert.rejects(
    uploadResilient({ sftp, path: '/srv/a.txt', source: sourceOf('x'), overwrite: true, openExec: async () => { throw new Error('不该降级') } }),
    /permission denied/,
  )
})

test('uploadResilient: 目标已存在（overwrite=false）先拦下', async () => {
  const sftp = fakeSftp({ stats: { '/srv/a.txt': { size: 1, isFile: () => true } } })
  await assert.rejects(
    uploadResilient({ sftp, path: '/srv/a.txt', source: sourceOf('x'), overwrite: false, openExec: async () => { throw new Error('不该走 exec') } }),
    error => error.code === 'TARGET_EXISTS',
  )
})

test('downloadToWritable: 计数与进度，sink 出错即拒', async () => {
  const sftp = fakeSftp({ stats: { '/srv/a.txt': { content: 'hello world', size: 11, isFile: () => true } } })
  const sink = collectSink()
  const events = []
  const result = await downloadToWritable(sftp, '/srv/a.txt', sink, { onProgress: e => events.push(e), totalBytes: 11 })
  assert.equal(result.transferredBytes, 11)
  assert.equal(sink.text(), 'hello world')
  assert.ok(events.at(-1).percent === 100)

  const broken = fakeSftp({ stats: { '/srv/a.txt': { content: 'x', size: 1, isFile: () => true } } })
  const failingSink = new Writable({ write(_c, _e, cb) { cb(new Error('client gone')) } })
  await assert.rejects(downloadToWritable(broken, '/srv/a.txt', failingSink, {}), /client gone/)
})

test('openSftpSession: 成功 / 回调错误 / 同步抛都带 sftp-session 标记', async () => {
  const session = { on() {} }
  const ok = await openSftpSession({ sftp: cb => cb(null, session) })
  assert.equal(ok, session)
  await assert.rejects(
    openSftpSession({ sftp: cb => cb(new Error('subsystem failed')) }),
    error => error.uploadFailureKind === 'sftp-session',
  )
  await assert.rejects(
    openSftpSession({ sftp() { throw new Error('Not connected') } }),
    error => error.uploadFailureKind === 'sftp-session',
  )
})

test('posixDirname: 远端路径恒 POSIX 语义', () => {
  assert.equal(posixDirname('/a/b/c'), '/a/b')
  assert.equal(posixDirname('/a'), '/')
  assert.equal(posixDirname('/'), '/')
})

test('ssh2ExecOpener: 裸命令经 POSIX 包装后才到 client.exec，并把 exit 码带给 onClose', async () => {
  const seen = []
  const channel = { stdin: null, on(ev, cb) { if (ev === 'exit') this._exit = cb; if (ev === 'close') this._close = cb } }
  const client = { exec(command, cb) { seen.push(command); cb(null, channel) } }
  const opener = ssh2ExecOpener(client)
  const settled = []
  const ch = await opener("mkdir -p '/srv' && cat > '/srv/a.txt'")
  ch.onClose(code => settled.push(code))
  assert.equal(seen[0], "/bin/sh -c 'mkdir -p '\\''/srv'\\'' && cat > '\\''/srv/a.txt'\\'''")
  channel._exit(7)
  channel._close()
  assert.deepEqual(settled, [7], 'onClose 优先采用 exit 记录的退出码')
})
