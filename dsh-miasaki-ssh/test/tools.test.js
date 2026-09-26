// Unit tests for the A1 tool layer (createSshTools). Runtime/store/approval are
// stubs; the exec channel is an EventEmitter driven exactly like the ssh2 channel
// (exit-before-data ordering included).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createSshTools } from '../lib/tools.js'
import { createAuditRing } from '../lib/audit.js'

function makeChannel() {
  const channel = new EventEmitter()
  channel.stdin = new EventEmitter()
  channel.stdin.write = () => true
  channel.stderr = new EventEmitter()
  channel.end = () => setImmediate(() => { channel.emit('exit', 0, null); channel.emit('close') })
  return channel
}

/** exec 替身：按脚本回数据（支持先 exit 后 data 的乱序）。 */
function makeClient({ stdout = 'out\n', exitCode = 0, script } = {}) {
  return {
    exec(_command, cb) {
      const channel = makeChannel()
      cb(null, channel)
      if (typeof script === 'function') { script(channel); return }
      setImmediate(() => {
        channel.emit('data', Buffer.from(stdout))
        if (exitCode !== 0) channel.emit('data', channel.stderr ? Buffer.from('') : Buffer.from(''))
        channel.emit('exit', exitCode, null)
        channel.emit('close')
      })
      return undefined
    },
  }
}

function harness({ connections = {}, userQuestions, runtimeOverrides = {}, readyWaitMs }) {
  const audit = createAuditRing({ now: () => 't' })
  const runtime = {
    listState: () => [],
    isConnected: id => false,
    runtimeOf: () => null,
    connect: async () => ({ id: 'x', state: 'connecting' }),
    readShellText: () => null,
    ...runtimeOverrides,
  }
  const store = {
    listConnections: async () => Object.values(connections),
    getConnection: async id => connections[id] ?? null,
  }
  const api = createSshTools({ runtime, store, audit, userQuestions, ...(readyWaitMs === undefined ? {} : { readyWaitMs }) })
  const byName = Object.fromEntries(api.tools.map(tool => [tool.name, tool]))
  return { api, byName, audit }
}

const host = (over = {}) => ({
  id: 'h1', label: 'web-01', host: 'web.example.com', port: 22, username: 'ops',
  auth: { method: 'key', keyPath: '/k' }, agentAccess: 'full', ...over,
})

test('ssh_hosts: 只返回 agentAccess≠none 的主机，filter 生效', async () => {
  const { byName } = harness({
    connections: {
      h1: host(),
      h2: host({ id: 'h2', label: 'db-01', host: 'db', agentAccess: 'none' }),
      h3: host({ id: 'h3', label: 'cache-01', host: 'cache', agentAccess: 'readonly' }),
    },
  })
  const all = await byName.ssh_hosts.execute({})
  assert.deepEqual(all.hosts.map(h => h.label).sort(), ['cache-01', 'web-01'])
  const filtered = await byName.ssh_hosts.execute({ filter: 'web' })
  assert.deepEqual(filtered.hosts.map(h => h.label), ['web-01'])
})

test('ssh_exec: ACCESS_DENIED —— none 档连执行都不进', async () => {
  const { byName, audit } = harness({ connections: { h1: host({ agentAccess: 'none' }) } })
  const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'ls' })
  assert.equal(result.error, 'ACCESS_DENIED')
  assert.equal(audit.list().at(-1).decision, 'denied-access')
})

test('ssh_exec: readonly 档的 L1 命令连审批机会都不给', async () => {
  const { byName, audit } = harness({ connections: { h1: host({ agentAccess: 'readonly' }) } })
  const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'echo x > /srv/a' })
  assert.equal(result.error, 'ACCESS_DENIED')
  assert.match(result.message, /只读/)
  assert.equal(audit.list().at(-1).decision, 'denied-risk')
})

test('ssh_exec: full + L0 免审批直通，riskLevel 由服务端填', async () => {
  const client = makeClient({ stdout: 'file-a\nfile-b\n' })
  const { byName, audit } = harness({
    connections: { h1: host() },
    runtimeOverrides: {
      isConnected: () => true,
      runtimeOf: () => ({ id: 'rt-1', status: 'connected', client }),
    },
  })
  const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'ls /srv' })
  assert.equal(result.error, undefined)
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'file-a\nfile-b\n')
  assert.equal(result.riskLevel, 'L0')
  assert.equal(result.host, 'ops@web.example.com:22')
  assert.equal(audit.list().at(-1).decision, 'exit:0')
})

test('ssh_exec: full + L1 需审批 —— 允许即执行（官方 questions 形状）', async () => {
  const asked = []
  const client = makeClient({ stdout: 'done\n' })
  const { byName, audit } = harness({
    connections: { h1: host() },
    userQuestions: {
      // 官方契约返回形状（AskUserQuestionAnswer）
      ask: async request => { asked.push(request); return { answers: [{ id: 'ssh-exec', selected: ['允许执行'] }] } },
    },
    runtimeOverrides: {
      isConnected: () => true,
      runtimeOf: () => ({ id: 'rt-1', status: 'connected', client }),
    },
  })
  const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'echo x > /srv/a' })
  assert.equal(result.error, undefined)
  assert.equal(result.exitCode, 0)
  assert.equal(asked.length, 1, 'L1 必须问一次')
  // 入参必须是官方 AskUserQuestionRequest 形状（扁平 {title,detail,options} 会在真机上抛 TypeError）
  const question = asked[0].questions[0]
  assert.equal(asked[0].questions.length, 1)
  assert.equal(question.id, 'ssh-exec')
  assert.match(question.question, /\[L1\]/)
  assert.match(question.question, /web-01/)
  assert.equal(question.detail, 'echo x > /srv/a', 'detail 是 string：完整命令')
  assert.deepEqual(question.options, [{ label: '允许执行' }, { label: '拒绝' }])
  assert.equal(audit.list().at(-1).decision, 'allowed-once')
})

test('ssh_exec: agent/signal 透传给官方 ask；CALLER_NOT_LIVE ⇒ 失败关闭', async () => {
  const asked = []
  const agent = { id: 'session-test' }
  const controller = new AbortController()
  const { byName, audit } = harness({
    connections: { h1: host() },
    userQuestions: {
      ask: async request => {
        asked.push(request)
        throw Object.assign(new Error('human interaction requires the exact live calling agent'), { code: 'CALLER_NOT_LIVE' })
      },
    },
    runtimeOverrides: { isConnected: () => true, runtimeOf: () => ({ id: 'rt-1', status: 'connected', client: makeClient() }) },
  })
  const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'echo x > /srv/a' }, { agent, signal: controller.signal })
  assert.equal(asked[0].agent, agent, 'agent 必须透传（官方靠它做 live-root 校验与作用域水瀑）')
  assert.equal(asked[0].signal, controller.signal, 'signal 必须透传（撤回即撤回问题）')
  assert.equal(result.error, 'APPROVAL_UNAVAILABLE')
  assert.match(result.message, /CALLER_NOT_LIVE/)
  assert.equal(audit.list().at(-1).decision, 'unavailable')
})

test('ssh_exec: 官方答案文本四态解析（custom 自由文本拒绝优先）', async () => {
  const cases = [
    { answer: { answers: [{ id: 'ssh-exec', selected: ['允许执行'] }] }, error: undefined },
    { answer: { answers: [{ id: 'ssh-exec', selected: ['拒绝'] }] }, error: 'APPROVAL_REJECTED' },
    { answer: { answers: [{ id: 'ssh-exec', selected: [], custom: '不允许' }] }, error: 'APPROVAL_REJECTED', why: '含「允许」但先判否定词' },
    { answer: { answers: [{ id: 'ssh-exec', selected: [], custom: '可以' }] }, error: undefined },
    { answer: { answers: [{ id: 'ssh-exec', selected: [], custom: '再看一眼' }] }, error: 'APPROVAL_UNAVAILABLE', why: '解析不出 ⇒ 失败关闭' },
    { answer: { answers: [] }, error: 'APPROVAL_UNAVAILABLE' },
  ]
  for (const item of cases) {
    const { byName } = harness({
      connections: { h1: host() },
      userQuestions: { ask: async () => item.answer },
      runtimeOverrides: { isConnected: () => true, runtimeOf: () => ({ id: 'rt-1', status: 'connected', client: makeClient() }) },
    })
    const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'echo x > /srv/a' })
    assert.equal(result.error, item.error, `${JSON.stringify(item.answer)}${item.why === undefined ? '' : `（${item.why}）`}`)
  }
})

test('ssh_exec: ASK_ABORTED ⇒ APPROVAL_CANCELLED（四态里的 cancelled，不是 unavailable）', async () => {
  const { byName, audit } = harness({
    connections: { h1: host() },
    userQuestions: { ask: async () => { throw Object.assign(new Error('aborted before the user answered'), { code: 'ASK_ABORTED' }) } },
    runtimeOverrides: { isConnected: () => true, runtimeOf: () => ({ id: 'rt-1', status: 'connected', client: makeClient() }) },
  })
  const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'echo x > /srv/a' })
  assert.equal(result.error, 'APPROVAL_CANCELLED')
  assert.equal(audit.list().at(-1).decision, 'cancelled')
})

test('ssh_exec: 审批拒绝 ⇒ 结构化拒绝，不执行、不抛', async () => {
  const client = makeClient()
  const { byName, audit } = harness({
    connections: { h1: host() },
    userQuestions: { ask: async () => false },
    runtimeOverrides: {
      isConnected: () => true,
      runtimeOf: () => ({ id: 'rt-1', status: 'connected', client }),
    },
  })
  const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'rm /srv/a.txt' })
  assert.equal(result.error, 'APPROVAL_REJECTED')
  assert.equal(result.riskLevel, 'L1')
  assert.equal(result.host, 'ops@web.example.com:22', '拒绝结果也要带主机——对话流回看才知道被拒的是哪台机器')
  assert.equal(audit.list().at(-1).decision, 'rejected')
})

test('ssh_exec: 确认通道不可用 ⇒ 失败关闭（APPROVAL_UNAVAILABLE），不执行', async () => {
  const client = makeClient()
  const { byName, audit } = harness({
    connections: { h1: host() },
    // 没有 userQuestions
    runtimeOverrides: {
      isConnected: () => true,
      runtimeOf: () => ({ id: 'rt-1', status: 'connected', client }),
    },
  })
  const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'rm /srv/a.txt' })
  assert.equal(result.error, 'APPROVAL_UNAVAILABLE')
  assert.match(result.message, /需要人批准/)
  assert.equal(audit.list().at(-1).decision, 'unavailable')
})

test('ssh_exec: 确认通道抛错 ⇒ 同样 unavailable 失败关闭', async () => {
  const { byName } = harness({
    connections: { h1: host() },
    userQuestions: { ask: async () => { throw new Error('no turn is open') } },
    runtimeOverrides: { isConnected: () => true, runtimeOf: () => ({ id: 'rt-1', status: 'connected', client: makeClient() }) },
  })
  const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'systemctl restart nginx' })
  assert.equal(result.error, 'APPROVAL_UNAVAILABLE')
  assert.match(result.message, /no turn is open/)
})

test('ssh_exec: password 主机未连接 ⇒ NOT_CONNECTED（Agent 不发起密码认证）', async () => {
  const { byName, audit } = harness({ connections: { h1: host({ auth: { method: 'password' } }) } })
  const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'ls' })
  assert.equal(result.error, 'NOT_CONNECTED')
  assert.match(result.message, /密码主机/)
  assert.equal(audit.list().at(-1).decision, 'NOT_CONNECTED')
})

test('ssh_exec: key 主机未连接 ⇒ 隐式建连并等真就绪（无秘密传递）', async () => {
  const client = makeClient({ stdout: 'ok\n' })
  let connectArgs = null
  let rc = null
  const { byName } = harness({
    connections: { h1: host() },
    runtimeOverrides: {
      isConnected: () => rc !== null && rc.status === 'connected',
      connect: async (id, options) => {
        connectArgs = { id, options }
        // 真机时序：connect() 返回时握手还在飞（status=connecting），就绪是稍后的事
        rc = { id: 'rt-1', status: 'connecting', client }
        setTimeout(() => { rc.status = 'connected' }, 40)
        return { id, state: 'connecting' }
      },
      runtimeOf: () => rc,
    },
    readyWaitMs: 2000,
  })
  const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'ls' })
  assert.equal(result.error, undefined, 'connect 返回 connecting 不得被误判成 NOT_CONNECTED')
  assert.equal(result.exitCode, 0)
  assert.equal(connectArgs.options.openShell, false, '隐式建连不开 shell')
})

test('ssh_exec: 已有在飞连接 ⇒ 等它而不是再 connect 一次（别拆掉正在握手的连接）', async () => {
  const client = makeClient({ stdout: 'ok\n' })
  const rc = { id: 'rt-1', status: 'connecting', client }
  setTimeout(() => { rc.status = 'connected' }, 30)
  let connects = 0
  const { byName } = harness({
    connections: { h1: host() },
    runtimeOverrides: {
      isConnected: () => false,
      connect: async () => { connects += 1; rc.status = 'connected'; return { id: 'h1' } },
      runtimeOf: () => rc,
    },
    readyWaitMs: 2000,
  })
  const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'ls' })
  assert.equal(result.error, undefined)
  assert.equal(connects, 0, '重复 connect 会 retire 掉前一条 runtime')
})

test('ssh_exec: 等待期一直是 connecting ⇒ 预算内结算 NOT_CONNECTED（不挂死）', async () => {
  const rc = { id: 'rt-1', status: 'connecting', client: null }
  const { byName } = harness({
    connections: { h1: host() },
    runtimeOverrides: {
      isConnected: () => false,
      connect: async () => ({ id: 'h1', state: 'connecting' }),
      runtimeOf: () => rc,
    },
    readyWaitMs: 200,
  })
  const started = Date.now()
  const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'ls' })
  assert.equal(result.error, 'NOT_CONNECTED')
  assert.match(result.message, /未在/)
  assert.ok(Date.now() - started < 3000, '预算一到就结算')
})

test('ssh_exec: 首次连接等指纹 ⇒ FINGERPRINT_REQUIRED（立刻给可照做的指引，不空等预算）', async () => {
  const rc = { id: 'rt-1', status: 'waiting-fingerprint', client: null }
  let connects = 0
  const { byName, audit } = harness({
    connections: { h1: host() },
    runtimeOverrides: {
      isConnected: () => false,
      connect: async () => { connects += 1; return { id: 'h1' } },
      runtimeOf: () => rc,
    },
    readyWaitMs: 60_000,
  })
  const started = Date.now()
  const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'ls' })
  assert.equal(result.error, 'FINGERPRINT_REQUIRED')
  assert.match(result.message, /指纹/)
  assert.ok(Date.now() - started < 1000, '不能把工具挂在 60s 预算上')
  assert.equal(connects, 0)
  assert.equal(audit.list().at(-1).decision, 'FINGERPRINT_REQUIRED')
})

test('ssh_exec: exec.signal 取消 ⇒ CANCELED 且 channel 已结束', async () => {
  const controller = new AbortController()
  const client = {
    exec(_c, cb) {
      const channel = makeChannel()
      let ended = false
      channel.end = () => { ended = true }
      channel.wasEnded = () => ended
      cb(null, channel)
      return undefined
    },
  }
  const { byName, audit } = harness({
    connections: { h1: host() },
    runtimeOverrides: { isConnected: () => true, runtimeOf: () => ({ id: 'rt-1', status: 'connected', client }) },
  })
  // L0 命令（免审批），让执行体走到 channel 层再取消
  const promise = byName.ssh_exec.execute({ hostId: 'h1', command: 'cat /var/log/big' }, { signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort()
  const result = await promise
  assert.equal(result.error, 'CANCELED')
  assert.equal(audit.list().at(-1).decision, 'canceled')
})

test('ssh_exec: 超时 ⇒ TIMEOUT（命令不退出时不能挂死工具）', async () => {
  const client = {
    exec(_c, cb) {
      const channel = makeChannel()
      channel.end = () => {} // 永不退出
      cb(null, channel)
      return undefined
    },
  }
  const { byName } = harness({
    connections: { h1: host() },
    runtimeOverrides: { isConnected: () => true, runtimeOf: () => ({ id: 'rt-1', status: 'connected', client }) },
  })
  const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'cat /var/log/forever', timeoutMs: 1000 })
  assert.equal(result.error, 'TIMEOUT')
  assert.match(result.message, /1000ms/)
})

test('ssh_exec: cwd 经 POSIX 引用前置', async () => {
  const commands = []
  const client = {
    exec(command, cb) {
      commands.push(command)
      const channel = makeChannel()
      cb(null, channel)
      setImmediate(() => { channel.emit('exit', 0, null); channel.emit('close') })
      return undefined
    },
  }
  const { byName } = harness({
    connections: { h1: host() },
    runtimeOverrides: { isConnected: () => true, runtimeOf: () => ({ id: 'rt-1', status: 'connected', client }) },
  })
  await byName.ssh_exec.execute({ hostId: 'h1', command: 'ls', cwd: '/srv/my dir' })
  assert.equal(commands[0], "/bin/sh -c 'cd '\\''/srv/my dir'\\'' && ls'")
})

test('ssh_exec: 输出截断标记', async () => {
  const client = makeClient({ stdout: 'x'.repeat(40 * 1024) })
  const { byName } = harness({
    connections: { h1: host() },
    runtimeOverrides: { isConnected: () => true, runtimeOf: () => ({ id: 'rt-1', status: 'connected', client }) },
  })
  const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'cat big' })
  assert.equal(result.truncated, true)
  assert.match(result.stdout, /输出已截断/)
})

test('ssh_session_read: 只读免审批，读当前 shell 回放尾部', async () => {
  const { byName } = harness({
    connections: { h1: host({ agentAccess: 'readonly' }) },
    runtimeOverrides: {
      runtimeOf: () => ({ id: 'rt-1', status: 'connected' }),
      readShellText: () => ({ text: 'l1\nl2\nl3', truncated: false, cols: 120, rows: 32, title: 'web-01', live: true }),
    },
  })
  const result = await byName.ssh_session_read.execute({ hostId: 'h1', lines: 2 })
  assert.equal(result.error, undefined)
  assert.equal(result.text, 'l1\nl2\nl3')
  assert.equal(result.cols, 120)
})

test('ssh_session_read: 未连接 ⇒ NOT_CONNECTED（不隐式建连——只读人的终端，不碰远端）', async () => {
  const { byName } = harness({ connections: { h1: host() } })
  const result = await byName.ssh_session_read.execute({ hostId: 'h1' })
  assert.equal(result.error, 'NOT_CONNECTED')
})

test('ssh_exec: 未知主机 / 空命令 ⇒ 结构化错误', async () => {
  const { byName } = harness({ connections: {} })
  assert.equal((await byName.ssh_exec.execute({ hostId: 'nope', command: 'ls' })).error, 'NOT_FOUND')
  const { byName: byName2 } = harness({ connections: { h1: host() } })
  assert.equal((await byName2.ssh_exec.execute({ hostId: 'h1', command: '  ' })).error, 'BAD_INPUT')
})

test('ssh_exec: exec 打开失败带 /bin/sh 双栈提示（远端 Windows 无可照着做）', async () => {
  const client = { exec(_c, cb) { cb(new Error('exec: /bin/sh: no such file or directory')) } }
  const { byName } = harness({
    connections: { h1: host() },
    runtimeOverrides: { isConnected: () => true, runtimeOf: () => ({ id: 'rt-1', status: 'connected', client }) },
  })
  const result = await byName.ssh_exec.execute({ hostId: 'h1', command: 'ls' })
  assert.equal(result.error, 'EXEC_FAILED')
  assert.match(result.message, /Windows/)
})

test('工具 schema 形状：参数表与 required', () => {
  const { byName } = harness({})
  for (const name of ['ssh_hosts', 'ssh_exec', 'ssh_session_read']) {
    assert.ok(byName[name] !== undefined, `${name} 必须注册`)
    assert.equal(byName[name].parameters.type, 'object')
    assert.equal(typeof byName[name].execute, 'function')
    assert.ok(byName[name].description.length > 10)
  }
  assert.deepEqual(byName.ssh_exec.parameters.required.sort(), ['command', 'hostId'])
  assert.deepEqual(byName.ssh_session_read.parameters.required, ['hostId'])
  assert.equal(byName.ssh_exec.parameters.additionalProperties, false)
})

test('A1 接线：agentTools 默认 off，注册走 cordis 依赖注入（不再同步 ctx.get）', async () => {
  const { readFile } = await import('node:fs/promises')
  const index = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(index, /config\?\.agentTools === true/, '开关判据在 host 半')
  assert.match(index, /ctx\.inject\(\['tools'\]/, '等 tools 服务就绪再注册（apply 时它还没就绪）')
  assert.match(index, /ssh: agentTools 已开启，但本进程没有 tools 服务/)
  assert.match(patch, /agentTools: false/, 'patch 配置默认 off —— 不注册即不进 schema')
})

test('A1 接线（行为）：off 不注册；on 等服务就绪注册三工具；服务缺席只告警不报错', async () => {
  const { registerAgentTools } = await import('../index.js')
  const sshTools = { tools: [{ name: 'ssh_hosts' }, { name: 'ssh_exec' }, { name: 'ssh_session_read' }] }
  const makeCtx = ({ tools }) => {
    const state = { injects: 0, warns: [], errors: [] }
    const scope = { get: name => (name === 'tools' ? tools : undefined) }
    return {
      state,
      get: scope.get,
      inject: (deps, callback) => { state.injects += 1; assert.deepEqual(deps, ['tools']); callback(scope); return Promise.resolve() },
      logger: { warn: message => state.warns.push(message), error: error => state.errors.push(error) },
    }
  }

  const off = makeCtx({ tools: { register: () => {} } })
  const offReport = registerAgentTools({ config: { agentTools: false }, ctx: off, sshTools })
  assert.equal(offReport.enabled, false)
  assert.equal(off.state.injects, 0, 'off 时连 inject 都不碰（不进 schema、不占 token）')

  const registered = []
  const on = makeCtx({ tools: { register: tool => registered.push(tool.name) } })
  const reports = []
  const onReport = registerAgentTools({ config: { agentTools: true }, ctx: on, sshTools, onReport: report => reports.push(report) })
  assert.equal(on.state.injects, 1)
  assert.deepEqual(registered, ['ssh_hosts', 'ssh_exec', 'ssh_session_read'])
  assert.equal(onReport.toolsService, true)
  assert.deepEqual(onReport.registered, ['ssh_hosts', 'ssh_exec', 'ssh_session_read'])
  assert.equal(reports.length, 1, '自证快照交给调用方落盘')
  assert.match(String(onReport.at), /^\d{4}-/)

  const missing = makeCtx({ tools: undefined })
  const missingReport = registerAgentTools({ config: { agentTools: true }, ctx: missing, sshTools })
  assert.equal(missingReport.toolsService, false)
  assert.deepEqual(missingReport.registered, [])
  assert.equal(missing.state.warns.length, 1)
  assert.match(missing.state.warns[0], /没有 tools 服务/)
  assert.equal(missing.state.errors.length, 0, '可选依赖缺席不是错误')
})

test('工具定义形状：官方 register 要求的 output { schema, render } 必须齐备（A1 实测根因回归）', async () => {
  const sshTools = createSshTools({ runtime: {}, store: {}, audit: { record: () => {} } })
  assert.equal(sshTools.tools.length, 3)
  for (const tool of sshTools.tools) {
    assert.equal(typeof tool.name, 'string')
    assert.equal(typeof tool.execute, 'function')
    // 实机根因：缺少 output 声明时 ctx.tools.register() 抛
    // `tool "<name>" must declare output { schema, render, presentationMeta? }`，三个工具全被拒。
    assert.notEqual(tool.output, undefined, `${tool.name} 必须声明 output（否则 register 抛错）`)
    assert.equal(tool.output.schema?.type, 'object', `${tool.name} 的 output.schema 必须是 object`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name} 的 output.render 必须是函数`)
    const blocks = tool.output.render({}, { error: 'X', message: '说明' })
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${tool.name} 的 render 必须返回 ContentBlock[]`)
    assert.ok(blocks.every(block => block.type === 'text' && typeof block.text === 'string'), `${tool.name} 的 render 块必须是 text`)
  }
})

test('工具结果渲染：ssh_exec 成功带主机/退出码/输出；错误也要带主机与命令', async () => {
  const sshTools = createSshTools({ runtime: {}, store: {}, audit: { record: () => {} } })
  const exec = sshTools.tools.find(tool => tool.name === 'ssh_exec')
  const okText = exec.output.render({}, { host: 'ops@h:22', command: 'uname -a', exitCode: 0, durationMs: 12, riskLevel: 'L0', stdout: 'Linux x\n', stderr: '' })[0].text
  assert.match(okText, /ops@h:22/)
  assert.match(okText, /exit=0/)
  assert.match(okText, /Linux x/)
  // 实机实测：旧的错误分支只渲染「错误码：文案」，对话流回看时看不出被拒的是哪条命令
  const errText = exec.output.render({}, { error: 'APPROVAL_REJECTED', message: '用户拒绝了这次命令执行', riskLevel: 'L1', command: 'echo x > /srv/a', host: 'ops@h:22' })[0].text
  assert.match(errText, /APPROVAL_REJECTED/)
  assert.match(errText, /ops@h:22/)
  assert.match(errText, /echo x > \/srv\/a/)
  assert.match(errText, /risk=L1/)
})

test('ssh_hosts 渲染必须首列 id（实机实测：不带 id 时模型拿 label 当 hostId 连吃 NOT_FOUND）', async () => {
  const sshTools = createSshTools({ runtime: {}, store: {}, audit: { record: () => {} } })
  const hosts = sshTools.tools.find(tool => tool.name === 'ssh_hosts')
  const text = hosts.output.render({}, {
    hosts: [{ id: 'a1-live-local', label: 'a1-local-sshd', address: 'a1tester@127.0.0.1:2222', agentAccess: 'full', state: 'idle' }],
    count: 1,
  })[0].text
  assert.match(text, /^a1-live-local · a1-local-sshd · a1tester@127\.0\.0\.1:2222/, 'id 必须在行首，且与 label / 地址并列')
  assert.match(hosts.description, /hostId/, '工具描述要指明 hostId 用返回里的 id')
  assert.match(hosts.output.schema.properties.hosts.items.properties.id.type, /string/)
})

test('A1 接线：audit 台账只读端点', async () => {
  const { readFile } = await import('node:fs/promises')
  const index = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(index, /\/ssh\/api\/agent-audit/)
  assert.match(index, /audit\.list\(\{ hostId/)
})
