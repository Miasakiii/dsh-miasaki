// End-to-end tests for the SFTP REST routes (U2.2). The plugin is mounted on a
// real node:http server exactly like http.test.js, with one documented test
// seam (`config.runtime`): a fault-injected *connected* RuntimeConn whose
// `client.sftp()` / `client.exec()` are fakes. Routes, fence, tickets, path
// normalization, size caps and the exec-pipe degradation are all exercised
// through real HTTP.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { apply as applySsh } from '../index.js'
import { SshRuntime, RuntimeConn } from '../lib/runtime.js'
import { SshStore } from '../lib/store.js'

const HOST_HEADER = { Host: '127.0.0.1' }

function makeFakeSftp() {
  const files = new Map([
    ['/home/ops', null], // realpath('.') 的 home
    ['/srv', null],
    ['/srv/a.txt', 'hello'],
  ])
  const state = { lastWrite: null, lastWritePath: null, written: [] }
  const sftp = {
    state,
    on() { /* 防 uncaught 的占位 */ },
    realpath(path, cb) { cb(null, path === '.' ? '/home/ops' : path) },
    stat(path, cb) {
      if (files.has(path) && files.get(path) === null) {
        cb(null, { size: 4096, mtime: 1700000000, mode: 0o755, isDirectory: () => true })
        return
      }
      if (files.has(path)) {
        const content = files.get(path)
        cb(null, { size: content.length, mtime: 1700000001, mode: 0o644, isFile: () => true })
        return
      }
      cb(Object.assign(new Error('no such file'), { code: 2 }))
    },
    readdir(path, cb) {
      if (path === '/srv') {
        cb(null, [{ filename: 'a.txt', attrs: { size: 5, mtime: 1700000001, mode: 0o644, isFile: () => true } }])
        return
      }
      if (path === '/home/ops') {
        cb(null, [{ filename: 'notes.md', attrs: { size: 3, mtime: 1700000002, mode: 0o644, isFile: () => true } }])
        return
      }
      cb(Object.assign(new Error('no such file'), { code: 2 }))
    },
    mkdir(path, cb) { state.lastMkdir = path; cb(null) },
    rename(from, to, cb) { state.lastRename = [from, to]; cb(null) },
    unlink(path, cb) { state.lastUnlink = path; cb(null) },
    rmdir(path, cb) { state.lastRmdir = path; cb(null) },
    createReadStream(path) {
      const content = files.get(path) ?? ''
      const stream = new Readable({ read() {} })
      setImmediate(() => { stream.push(content); stream.push(null) })
      return stream
    },
    createWriteStream(path) {
      const chunks = []
      const stream = new Writable({ write(chunk, _e, cb2) { chunks.push(Buffer.from(chunk)); cb2() } })
      state.lastWritePath = path
      state.lastWrite = () => Buffer.concat(chunks).toString('utf8')
      stream.on('finish', () => setImmediate(() => stream.emit('close')))
      state.written.push(path)
      return stream
    },
  }
  return sftp
}

function makeFakeClient(sftp) {
  return {
    sftp(cb) { cb(null, sftp) },
    exec(command, cb) {
      const channel = new EventEmitter()
      const received = []
      channel.stdin = new Writable({ write(chunk, _e, cb2) { received.push(Buffer.from(chunk)); cb2() } })
      channel.stdin.received = () => Buffer.concat(received).toString('utf8')
      channel.exitCode = 0
      cb(null, channel)
      // 触发必须晚于调用方注册 onClose（openExec 的 resolve 是微任务、注册在其后）——
      // 立即/同 tick 触发会造成「关闭早于监听」的永久等待。
      setTimeout(() => {
        if (channel.fired !== true) { channel.fired = true; channel.emit('exit', channel.exitCode); channel.emit('close') }
      }, 5)
      return channel
    },
  }
}

async function withServer(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ssh-sftp-http-'))
  const dataDir = join(dir, 'data')
  const store = new SshStore(dataDir)
  await store.ready
  const runtime = new SshRuntime(store, {})
  const sftp = makeFakeSftp()
  const rc = new RuntimeConn(runtime, 'a1b2c3d4-0000-4000-8000-000000000001', { host: 'box', label: 'example' }, { runtimeId: 'rt-1' })
  rc.status = 'connected'
  rc.client = makeFakeClient(sftp)
  runtime.conns.set(rc.id, rc)
  runtime.byProfile.set('a1b2c3d4-0000-4000-8000-000000000001', rc.id)

  const httpServer = http.createServer()
  const routes = new Map()
  const upgrades = new Map()
  const disposers = []
  const webServer = {
    register({ kind, path, handler }) {
      routes.set(`${kind}:${path}`, { kind, path, handler })
      return () => routes.delete(`${kind}:${path}`)
    },
    registerUpgrade({ path, handler }) {
      upgrades.set(path, handler)
      return () => upgrades.delete(path)
    },
  }
  httpServer.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.local')
    const hit = [...routes.values()].find(route => (route.kind === 'exact' ? route.path === url.pathname : url.pathname.startsWith(route.path)))
    if (hit === undefined) { res.writeHead(404); res.end('NOT FOUND'); return }
    hit.handler(req, res)
  })
  const ctx = {
    logger: { error: () => {}, warn: () => {} },
    webServer,
    // 与 http.test.js 同一纪律：apply 注册的 effect（WS ping 定时器等）必须可释放，
    // 否则进程被定时器挂住不退出。
    effect(fn) { const disposer = fn(); if (typeof disposer === 'function') disposers.push(disposer); return () => {} },
  }
  applySsh(ctx, { dataDir, scrollbackBytes: 4096, runtime })
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const port = httpServer.address().port
  try {
    await run({ port, runtime, rc, sftp })
  } finally {
    for (const disposer of disposers) disposer()
    await runtime.shutdown()
    httpServer.closeAllConnections?.()
    await new Promise(resolve => httpServer.close(resolve))
    await new Promise(resolve => setTimeout(resolve, 30))
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function rawRequest(port, pathname, { host = HOST_HEADER.Host, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: { Host: host, ...(body !== undefined ? { 'content-type': 'application/octet-stream' } : {}) },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const postJson = (port, pathname, payload) => rawRequest(port, pathname, {
  method: 'POST',
  body: JSON.stringify(payload),
})

async function issueTicket(port, connId = 'a1b2c3d4-0000-4000-8000-000000000001') {
  const res = await postJson(port, '/ssh/api/sftp/ticket', { connId })
  assert.equal(res.status, 200)
  return JSON.parse(res.body).ticket
}

// ---- 票据族 ----

test('SFTP 票据：签发 / 校验 / 续期 / teardown 作废', async () => {
  await withServer(async ({ port, runtime }) => {
    const unknown = await rawRequest(port, '/ssh/api/sftp/list?ticket=nope&path=/srv')
    assert.equal(unknown.status, 401)

    const renewUnknown = await postJson(port, '/ssh/api/sftp/renew', { ticket: 'nope' })
    assert.equal(renewUnknown.status, 401)

    const ticket = await issueTicket(port)
    const ok = await rawRequest(port, `/ssh/api/sftp/list?ticket=${ticket}&path=/srv`)
    assert.equal(ok.status, 200)

    const renewed = await postJson(port, '/ssh/api/sftp/renew', { ticket })
    assert.equal(renewed.status, 200)
    assert.ok(JSON.parse(renewed.body).expiresAt > Date.now())

    // 连接断开 ⇒ 票据同批作废（与 attach 票据同一纪律）
    await runtime.disconnect('a1b2c3d4-0000-4000-8000-000000000001')
    const afterTeardown = await rawRequest(port, `/ssh/api/sftp/list?ticket=${ticket}&path=/srv`)
    assert.equal(afterTeardown.status, 401)
  })
})

test('SFTP 票据：未运行连接 404，非法 connId 400', async () => {
  await withServer(async ({ port }) => {
    const missing = await postJson(port, '/ssh/api/sftp/ticket', { connId: '11111111-1111-1111-1111-111111111111' })
    assert.equal(missing.status, 404)
    const bad = await postJson(port, '/ssh/api/sftp/ticket', { connId: 'not-a-uuid!' })
    assert.equal(bad.status, 400)
  })
})

// ---- 列目录 / stat / 路径归一 ----

test('SFTP list：默认落 home，显式路径归一（.. 词法结算）', async () => {
  await withServer(async ({ port }) => {
    const ticket = await issueTicket(port)
    const home = await rawRequest(port, `/ssh/api/sftp/list?ticket=${ticket}`)
    assert.equal(home.status, 200)
    const homeBody = JSON.parse(home.body)
    assert.equal(homeBody.home, '/home/ops')
    assert.equal(homeBody.path, '/home/ops')
    assert.deepEqual(homeBody.entries.map(e => e.name), ['notes.md'])

    // /srv/../etc 词法结算成 /etc（假 sftp 没有 /etc 条目 ⇒ 404 但路径确实被归一了）
    const traversal = await rawRequest(port, `/ssh/api/sftp/list?ticket=${ticket}&path=${encodeURIComponent('/srv/../etc')}`)
    assert.equal(traversal.status, 404)

    const srv = await rawRequest(port, `/ssh/api/sftp/list?ticket=${ticket}&path=${encodeURIComponent('/srv')}`)
    assert.equal(srv.status, 200)
    assert.deepEqual(JSON.parse(srv.body).entries.map(e => e.name), ['a.txt'])
  })
})

test('SFTP stat / 路径非法输入 400', async () => {
  await withServer(async ({ port }) => {
    const ticket = await issueTicket(port)
    const stat = await rawRequest(port, `/ssh/api/sftp/stat?ticket=${ticket}&path=${encodeURIComponent('/srv/a.txt')}`)
    assert.equal(stat.status, 200)
    assert.equal(JSON.parse(stat.body).stat.type, 'file')
    assert.equal(JSON.parse(stat.body).stat.size, 5)

    const missing = await rawRequest(port, `/ssh/api/sftp/stat?ticket=${ticket}&path=${encodeURIComponent('/srv/none.txt')}`)
    assert.equal(missing.status, 404)

    const nul = await rawRequest(port, `/ssh/api/sftp/list?ticket=${ticket}&path=${encodeURIComponent('/srv/a\0b')}`)
    assert.equal(nul.status, 400)
    assert.match(nul.body, /NUL/)
  })
})

// ---- 下载 ----

test('SFTP download：带头流式下发，目录 400', async () => {
  await withServer(async ({ port }) => {
    const ticket = await issueTicket(port)
    const dl = await rawRequest(port, `/ssh/api/sftp/download?ticket=${ticket}&path=${encodeURIComponent('/srv/a.txt')}`)
    assert.equal(dl.status, 200)
    assert.equal(dl.headers['content-length'], '5')
    assert.equal(dl.body, 'hello')

    const dir = await rawRequest(port, `/ssh/api/sftp/download?ticket=${ticket}&path=${encodeURIComponent('/srv')}`)
    assert.equal(dir.status, 400)
  })
})

// ---- 上传（sftp 主路 + 降级链 + 上限 + 409）----

test('SFTP upload：sftp 主路写流收到全部字节', async () => {
  await withServer(async ({ port, sftp }) => {
    const ticket = await issueTicket(port)
    const res = await rawRequest(port, `/ssh/api/sftp/upload?ticket=${ticket}&path=${encodeURIComponent('/srv/new.txt')}&overwrite=0&size=5`, { method: 'POST', body: 'hello' })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.transport, 'sftp')
    assert.equal(body.transferredBytes, 5)
    assert.equal(sftp.state.lastWritePath, '/srv/new.txt')
    assert.equal(sftp.state.lastWrite(), 'hello')
  })
})

test('SFTP upload：目标已存在 409（零字节消耗）', async () => {
  await withServer(async ({ port, sftp }) => {
    const ticket = await issueTicket(port)
    const res = await rawRequest(port, `/ssh/api/sftp/upload?ticket=${ticket}&path=${encodeURIComponent('/srv/a.txt')}&overwrite=0`, { method: 'POST', body: 'hello' })
    assert.equal(res.status, 409)
    assert.equal(sftp.state.written.length, 0, '拦截时不该创建写流')
  })
})

test('SFTP upload：超过 512MiB 上限 413', async () => {
  await withServer(async ({ port }) => {
    const ticket = await issueTicket(port)
    const res = await rawRequest(port, `/ssh/api/sftp/upload?ticket=${ticket}&path=${encodeURIComponent('/srv/big.bin')}&size=${600 * 1024 * 1024}`, { method: 'POST', body: 'x' })
    assert.equal(res.status, 413)
  })
})

test('SFTP upload：execOnly 记忆生效 ⇒ 直接走 exec pipe（cat > 落盘）', async () => {
  await withServer(async ({ port, rc, sftp }) => {
    rc.execOnlyUpload = true
    const ticket = await issueTicket(port)
    const res = await rawRequest(port, `/ssh/api/sftp/upload?ticket=${ticket}&path=${encodeURIComponent('/srv/viaexec.txt')}&overwrite=1`, { method: 'POST', body: 'payload' })
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).transport, 'exec')
    assert.equal(sftp.state.written.length, 0, 'execOnly 时 sftp 写流一个都不该建')
  })
})

test('SFTP upload：sftp 会话打不开 ⇒ 源流未被消费 ⇒ 自动降级 exec', async () => {
  await withServer(async ({ port, rc, sftp }) => {
    rc.client.sftp = (_env, cb) => cb(new Error('subsystem request failed'))
    const ticket = await issueTicket(port)
    const res = await rawRequest(port, `/ssh/api/sftp/upload?ticket=${ticket}&path=${encodeURIComponent('/srv/fb.txt')}&overwrite=1`, { method: 'POST', body: 'payload' })
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).transport, 'exec', '会话打不开不是路径错误，不能误报')
    assert.equal(sftp.state.written.length, 0)
  })
})

// ---- 变更操作 ----

test('SFTP op：mkdir / rename / unlink / rmdir，未知 op 400', async () => {
  await withServer(async ({ port, sftp }) => {
    const ticket = await issueTicket(port)
    const mk = await postJson(port, '/ssh/api/sftp/op', { ticket, op: 'mkdir', path: '/srv/newdir' })
    assert.equal(mk.status, 200)
    assert.equal(sftp.state.lastMkdir, '/srv/newdir')

    const mv = await postJson(port, '/ssh/api/sftp/op', { ticket, op: 'rename', path: '/srv/a.txt', to: '/srv/b.txt' })
    assert.equal(mv.status, 200)
    assert.deepEqual(sftp.state.lastRename, ['/srv/a.txt', '/srv/b.txt'])

    const rmFile = await postJson(port, '/ssh/api/sftp/op', { ticket, op: 'unlink', path: '/srv/b.txt' })
    assert.equal(rmFile.status, 200)
    assert.equal(sftp.state.lastUnlink, '/srv/b.txt')

    const rmDir = await postJson(port, '/ssh/api/sftp/op', { ticket, op: 'rmdir', path: '/srv/newdir' })
    assert.equal(rmDir.status, 200)
    assert.equal(sftp.state.lastRmdir, '/srv/newdir')

    const unknown = await postJson(port, '/ssh/api/sftp/op', { ticket, op: 'chmod', path: '/srv/a.txt' })
    assert.equal(unknown.status, 400)

    // 变更操作的路径同样过归一（~ 展开、.. 结算、NUL 拒绝）
    const homeMk = await postJson(port, '/ssh/api/sftp/op', { ticket, op: 'mkdir', path: '~/sub/../logs' })
    assert.equal(homeMk.status, 200)
    assert.equal(sftp.state.lastMkdir, '/home/ops/logs')
  })
})

// ---- 围栏 ----

test('SFTP 路由：fence 先于票据（不可信 Host 一律 403）', async () => {
  await withServer(async ({ port }) => {
    const evil = await rawRequest(port, '/ssh/api/sftp/list?ticket=x&path=/srv', { host: 'evil.example' })
    assert.equal(evil.status, 403)
    const evilPost = await rawRequest(port, '/ssh/api/sftp/op', { method: 'POST', host: 'evil.example', body: JSON.stringify({ ticket: 'x', op: 'mkdir', path: '/srv' }) })
    assert.equal(evilPost.status, 403)
  })
})
