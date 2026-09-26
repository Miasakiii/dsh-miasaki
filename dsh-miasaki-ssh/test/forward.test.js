// Unit tests for local port forwarding (U3/P2-1).
// Real TCP is used end-to-end: a real echo server stands in for the *remote*
// target, and the ssh2 client's `forwardOut` is stubbed with a real net.connect
// (which is exactly what a compliant server does for direct-tcpip). The bytes
// therefore travel through real sockets, not through fakes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createLocalForward } from '../lib/forward.js'
import { normalizeForwards, MAX_FORWARDS_PER_CONNECTION } from '../lib/store.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function listenEcho() {
  const server = net.createServer(socket => {
    socket.on('data', chunk => socket.write(chunk))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

/** forwardOut 替身：直接真连目标（服务端 direct-tcpip 的正确行为）。 */
function echoClient() {
  return {
    forwardOut(_srcIP, _srcPort, dstIP, dstPort, cb) {
      const sock = net.connect({ host: dstIP, port: dstPort })
      sock.once('connect', () => cb(null, sock))
      sock.once('error', error => cb(error))
      return undefined
    },
  }
}

test('forward：真 TCP 往返 —— 本机监听经 forwardOut 送达 echo 目标并原样返回', async () => {
  const { server, port: echoPort } = await listenEcho()
  let fwd = null
  try {
    const events = []
    fwd = createLocalForward({
      client: echoClient(),
      spec: { localPort: 0, remoteHost: '127.0.0.1', remotePort: echoPort },
      onEvent: event => events.push(event),
    })
    await sleep(30)
    const listening = events.find(e => e.type === 'listening')
    assert.ok(listening !== undefined, 'listening 事件必须上报')
    // localPort:0 ⇒ OS 代管：真实端口从 stats 拿（诊断与 UI 同源）
    const actualPort = fwd.stats().actualPort
    assert.ok(Number.isInteger(actualPort) && actualPort > 0)

    // echo 回显后不断开（真实转发语义）⇒ 收到期望字节即结算，不等 end
    const response = await new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: actualPort }, () => sock.write('ping-ssh'))
      let data = ''
      sock.on('data', chunk => {
        data += String(chunk)
        if (data.length >= 'ping-ssh'.length) { sock.destroy(); resolve(data) }
      })
      sock.on('error', error => reject(error))
      setTimeout(() => reject(new Error('timeout')), 3000)
    }).catch(() => null)
    assert.equal(response, 'ping-ssh', 'forwardOut 替身走真 socket：字节必须往返')
    assert.equal(fwd.stats().connections, 1)
    assert.ok(fwd.stats().bytes >= 8, '双向字节都要计数')
    assert.equal(fwd.stats().error, null)
  } finally {
    if (fwd !== null) await fwd.close()
    server.close()
  }
})

test('forward：固定端口监听、close 后端口立即可再绑（无僵尸占用）', async () => {
  const { server, port: echoPort } = await listenEcho()
  try {
    // 先占一个确定端口再释放，拿到一个大概率可用的端口
    const probe = net.createServer()
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
    const localPort = probe.address().port
    await new Promise(resolve => probe.close(resolve))

    const fwd = createLocalForward({
      client: echoClient(),
      spec: { localPort, remoteHost: '127.0.0.1', remotePort: echoPort },
    })
    await sleep(30)
    assert.equal(fwd.stats().listening, true)
    await fwd.close()
    assert.equal(fwd.stats().listening, true, 'close 不清 listening 标志（统计事实）；端口必须已释放')

    // 端口已释放 ⇒ 能再次监听同一个端口
    const again = net.createServer()
    await new Promise((resolve, reject) => {
      again.once('error', reject)
      again.listen(localPort, '127.0.0.1', resolve)
    })
    await new Promise(resolve => again.close(resolve))
  } finally {
    server.close()
  }
})

test('forward：端口被占 ⇒ listen-error 事件（静默不生效比报错更糟）', async () => {
  const { server, port: echoPort } = await listenEcho()
  try {
    const blocker = net.createServer()
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve))
    const taken = blocker.address().port
    const events = []
    const fwd = createLocalForward({
      client: echoClient(),
      spec: { localPort: taken, remoteHost: '127.0.0.1', remotePort: echoPort },
      onEvent: event => events.push(event),
    })
    await sleep(50)
    const failure = events.find(e => e.type === 'listen-error')
    assert.ok(failure !== undefined, 'EADDRINUSE 必须产生 listen-error')
    assert.match(failure.message, /EADDRINUSE|listen/i)
    assert.equal(fwd.stats().listening, false)
    await fwd.close()
    await new Promise(resolve => blocker.close(resolve))
  } finally {
    server.close()
  }
})

test('forward：forwardOut 失败（服务端拒绝）⇒ channel-error，监听不撤', async () => {
  const events = []
  const fwd = createLocalForward({
    client: {
      forwardOut(_s, _sp, _d, _dp, cb) { setImmediate(() => cb(new Error('Administratively prohibited'))) },
    },
    spec: { localPort: 0, remoteHost: '10.0.0.9', remotePort: 80 },
    onEvent: event => events.push(event),
  })
  await sleep(30)
  const sock = net.connect({ host: '127.0.0.1', port: fwd.stats().actualPort })
  const outcome = await new Promise(resolve => {
    sock.on('error', () => resolve('destroyed'))
    sock.on('close', () => resolve('destroyed'))
    setTimeout(() => resolve('hang'), 2000)
  })
  assert.equal(outcome, 'destroyed', '通道失败必须销毁入连接，不能挂着')
  await sleep(30)
  assert.ok(events.some(e => e.type === 'channel-error'), 'channel-error 必须上报')
  assert.equal(fwd.stats().listening, true, '单连接失败不撤监听（改配置后新连接立即可用）')
  await fwd.close()
})

test('forward：client 未连接（forwardOut 同步抛）⇒ channel-error，不崩', async () => {
  const events = []
  const fwd = createLocalForward({
    client: { forwardOut() { throw new Error('Not connected') } },
    spec: { localPort: 0, remoteHost: 'x', remotePort: 1 },
    onEvent: event => events.push(event),
  })
  await sleep(30)
  const sock = net.connect({ host: '127.0.0.1', port: fwd.stats().actualPort })
  const outcome = await new Promise(resolve => {
    sock.on('error', () => resolve('destroyed'))
    sock.on('close', () => resolve('destroyed'))
    setTimeout(() => resolve('hang'), 2000)
  })
  assert.equal(outcome, 'destroyed')
  await sleep(20)
  assert.ok(events.some(e => e.type === 'channel-error' && /Not connected/.test(e.message)))
  await fwd.close()
})

// ---- store 归一化（规则一处）----

test('normalizeForwards：端口/主机校验、去重、上限、缺省空数组', () => {
  assert.deepEqual(normalizeForwards(undefined), [])
  assert.deepEqual(normalizeForwards([]), [])
  const ok = normalizeForwards([{ localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80, label: 'web' }])
  assert.deepEqual(ok, [{ localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80, label: 'web' }])
  assert.throws(() => normalizeForwards([{ localPort: 0, remoteHost: 'a', remotePort: 1 }]), /1–65535/)
  assert.throws(() => normalizeForwards([{ localPort: 1, remoteHost: 'a', remotePort: 99999 }]), /1–65535/)
  assert.throws(() => normalizeForwards([{ localPort: 1, remoteHost: '  ', remotePort: 1 }]), /远端主机不能为空/)
  assert.throws(() => normalizeForwards([{ localPort: 1, remoteHost: 'a', remotePort: 1 }, { localPort: 1, remoteHost: 'b', remotePort: 2 }]), /重复/)
  const many = Array.from({ length: MAX_FORWARDS_PER_CONNECTION + 1 }, (_, i) => ({ localPort: 20000 + i, remoteHost: 'h', remotePort: 80 }))
  assert.throws(() => normalizeForwards(many), new RegExp(`最多 ${MAX_FORWARDS_PER_CONNECTION}`))
  assert.throws(() => normalizeForwards('nope'), /数组/)
})

// ---- 编辑器与连接记录接线（静态契约）----

test('U3 接线：编辑器有跳板选择与转发行，提交体带 jumpHostId / forwards', async () => {
  const { readFile } = await import('node:fs/promises')
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  assert.match(app, /id = 'edit-jump'/)
  assert.match(app, /id = 'edit-forwards'/)
  assert.match(app, /jumpHostId: jumpSelect\.value/)
  assert.match(app, /forwards: forwardRows/)
  assert.match(app, /fieldNode\('本地端口转发', forwardList\)/)
  // 身份行如实标注跳板与转发
  assert.match(app, /经 \$\{jump\?\.label \?\? '跳板'\}/)
  assert.match(app, /转发 \$\{conn\.forwards\.length\} 条/)
})

test('U3 接线：normalizeConnection 落盘 forwards / jumpHostId，sanitize 不外泄秘密', async () => {
  const { normalizeConnection, sanitizeConnection } = await import('../lib/store.js')
  const record = normalizeConnection({
    label: 'via-jump', host: 'target.example.com', port: 22, username: 'ops',
    auth: { method: 'password' },
    jumpHostId: 'a1b2c3d4-0000-4000-8000-000000000009',
    forwards: [{ localPort: 18080, remoteHost: '127.0.0.1', remotePort: 8080 }],
  })
  assert.equal(record.jumpHostId, 'a1b2c3d4-0000-4000-8000-000000000009')
  assert.equal(record.forwards.length, 1)
  const clean = sanitizeConnection(record)
  assert.deepEqual(clean.forwards, [{ localPort: 18080, remoteHost: '127.0.0.1', remotePort: 8080, label: '' }])
  assert.equal(clean.jumpHostId, 'a1b2c3d4-0000-4000-8000-000000000009')
  // 没有跳板/转发时不落这两个键的脏值
  const plain = normalizeConnection({ label: 'plain', host: 'h', username: 'u', auth: { method: 'agent' } })
  assert.equal('jumpHostId' in plain, false)
  assert.deepEqual(plain.forwards, [])
})
