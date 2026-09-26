// Unit tests for ~/.ssh/config alias import (P1.1).
// Sample configs are written to a temp dir and injected via the documented
// `configPath` dependency; the ssh -G channel is stubbed through `spawnFn`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { listSshConfigAliases, runSshG, parseSshGOutput, clearAliasCache } from '../lib/sshConfig.js'

async function withConfig(content, run) {
  const dir = await mkdtemp(join(tmpdir(), 'ssh-config-'))
  const configPath = join(dir, 'config')
  await writeFile(configPath, content, 'utf8')
  try {
    await run({ dir, configPath })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const SAMPLE = `# 全局默认
Host *
  ServerAliveInterval 30

Host web
  HostName web.example.com
  Port 2222
  User ops
  IdentityFile ~/.ssh/id_ed25519

Host db
  HostName 10.0.0.9
  User pg

Host "quoted alias"
  HostName 10.0.0.10

Host jump-only
  HostName bastion.example.com
  User admin
  ProxyJump core@relay:2222

Host wildcard-*
  HostName never.example.com
`

test('sshConfig：解析器枚举直连别名，跳过 * / 通配 / 注释，Windows 路径保留反斜杠', async () => {
  clearAliasCache()
  await withConfig(`${SAMPLE}\nHost winbox\n  HostName 10.1.2.3\n  IdentityFile "C:\\Users\\me\\.ssh\\id_ed25519"\n`, async ({ configPath }) => {
    const { aliases, from } = await listSshConfigAliases({ configPath, ttlMs: 0, spawnFn: null })
    assert.equal(from, 'parser')
    const byAlias = new Map(aliases.map(a => [a.alias, a]))
    assert.deepEqual([...byAlias.keys()].sort(), ['db', 'jump-only', 'quoted alias', 'web', 'winbox'])
    const web = byAlias.get('web')
    assert.equal(web.host, 'web.example.com')
    assert.equal(web.port, 2222)
    assert.equal(web.username, 'ops')
    assert.equal(web.privateKeyPath, join(homedir(), '.ssh', 'id_ed25519'), '~ 按本机 home 展开')
    assert.equal(web.direct, true)
    // 含 ProxyJump 的别名：保留但标 direct:false（导入侧禁选，不静默丢弃）
    assert.equal(byAlias.get('jump-only').direct, false)
    assert.equal(byAlias.get('jump-only').host, 'bastion.example.com')
    // 通配 Host 不是别名
    assert.equal(byAlias.has('wildcard-*'), false)
    // 带引号的单模式 Host 能切出别名 token
    assert.equal(byAlias.get('quoted alias').host, '10.0.0.10')
    // Windows IdentityFile：反斜杠一个字都不能吞
    assert.equal(byAlias.get('winbox').privateKeyPath, 'C:\\Users\\me\\.ssh\\id_ed25519')
  })
})

test('sshConfig：Include glob 与 %d 展开', async () => {
  clearAliasCache()
  const dir = await mkdtemp(join(tmpdir(), 'ssh-config-inc-'))
  try {
    const configPath = join(dir, 'config')
    await writeFile(configPath, `Include ${dir.replace(/\\/g, '/')}/conf.d/*\nHost base\n  HostName base.example.com\n`, 'utf8')
    const { mkdir, writeFile: wf } = await import('node:fs/promises')
    await mkdir(join(dir, 'conf.d'), { recursive: true })
    await wf(join(dir, 'conf.d', 'a.conf'), 'Host alpha\n  HostName a.example.com\n  Port 2200\n', 'utf8')
    await wf(join(dir, 'conf.d', 'b.conf'), 'Host beta\n  HostName b.example.com\n', 'utf8')
    const { aliases } = await listSshConfigAliases({ configPath, ttlMs: 0, spawnFn: null })
    const names = aliases.map(a => a.alias).sort()
    assert.deepEqual(names, ['alpha', 'base', 'beta'])
    assert.equal(aliases.find(a => a.alias === 'alpha').port, 2200)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sshConfig：ssh -G 通道优先，但 privateKeyPath 只信 config 显式声明', async () => {
  clearAliasCache()
  await withConfig('Host web\n  HostName web.example.com\n  User ops\n  IdentityFile ~/.ssh/id_ed25519\nHost cli\n  HostName cli.example.com\n  User deploy\n', async ({ configPath }) => {
    const spawnFn = (_bin, args) => {
      const alias = args[args.length - 1]
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.kill = () => {}
      setImmediate(() => {
        if (alias === 'cli') { child.emit('close', 1); return } // ssh -G 失败 ⇒ 回退自研
        child.stdout.emit('data', Buffer.from('hostname resolved-by-ssh.example.com\nport 2022\nuser sshg\nidentityfile /default/id_rsa\n'))
        child.emit('close', 0)
      })
      return child
    }
    const { aliases, from } = await listSshConfigAliases({ configPath, ttlMs: 0, spawnFn })
    assert.equal(from, 'ssh-g')
    const web = aliases.find(a => a.alias === 'web')
    assert.equal(web.host, 'resolved-by-ssh.example.com', 'ssh -G 的 hostname 优先')
    assert.equal(web.port, 2022)
    assert.equal(web.username, 'sshg')
    // 教训：ssh -G 的默认 identityfile 不得盖掉「密码登录」的事实
    assert.equal(web.privateKeyPath, join(homedir(), '.ssh', 'id_ed25519'), `privateKeyPath 只信 config：${web.privateKeyPath}`)
    const cli = aliases.find(a => a.alias === 'cli')
    assert.equal(cli.host, 'cli.example.com', 'ssh -G 失败 ⇒ 自研解析值')
  })
})

test('sshConfig：TTL 内命中缓存（不重复 spawn）', async () => {
  clearAliasCache()
  let clock = 1_000_000
  await withConfig('Host a\n  HostName a.example.com\n', async ({ configPath }) => {
    let calls = 0
    const spawnFn = () => {
      calls += 1
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.kill = () => {}
      setImmediate(() => { child.stdout.emit('data', Buffer.from('hostname a.example.com\n')); child.emit('close', 0) })
      return child
    }
    await listSshConfigAliases({ configPath, ttlMs: 30_000, now: () => clock, spawnFn })
    clock += 1000
    await listSshConfigAliases({ configPath, ttlMs: 30_000, now: () => clock, spawnFn })
    assert.equal(calls, 1, 'TTL 内第二次不碰 ssh 进程')
    clock += 40_000
    await listSshConfigAliases({ configPath, ttlMs: 30_000, now: () => clock, spawnFn })
    assert.equal(calls, 2, '过期后重新解析')
  })
})

test('sshConfig：config 不存在 ⇒ 空清单，不抛', async () => {
  clearAliasCache()
  const { aliases, from } = await listSshConfigAliases({ configPath: join(tmpdir(), 'definitely-missing-ssh-config'), ttlMs: 0 })
  assert.deepEqual(aliases, [])
  assert.equal(from, 'none')
})

test('parseSshGOutput：只取 hostname / port / user，非法端口忽略', () => {
  const parsed = parseSshGOutput('hostname box.example.com\nport 22\nuser ops\nidentityfile /x\nproxyjump none\n')
  assert.deepEqual(parsed, { host: 'box.example.com', port: 22, username: 'ops' })
  assert.deepEqual(parseSshGOutput('port 99999'), { host: undefined, port: undefined, username: undefined })
  assert.deepEqual(parseSshGOutput(''), { host: undefined, port: undefined, username: undefined })
})

test('runSshG：close 非零 / error / 挂起超时都解析为 null', async () => {
  const ok = await runSshG('ssh', '/c', 'alias', {
    timeoutMs: 50,
    spawnFn: () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.kill = () => {}
      setImmediate(() => { child.stdout.emit('data', Buffer.from('ok')); child.emit('close', 0) })
      return child
    },
  })
  assert.equal(ok, 'ok')

  const nonZero = await runSshG('ssh', '/c', 'alias', {
    timeoutMs: 50,
    spawnFn: () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.kill = () => {}
      setImmediate(() => child.emit('close', 255))
      return child
    },
  })
  assert.equal(nonZero, null)

  const hang = await runSshG('ssh', '/c', 'alias', {
    timeoutMs: 30,
    spawnFn: () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.kill = () => { child.killed = true }
      return child // 永不 close
    },
  })
  assert.equal(hang, null)
})

test('sshConfig：REST 路由与 fence 契约（index.js 静态）', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /\/ssh\/api\/ssh-config\/aliases/)
})

test('sshConfig UI 契约：编辑器导入下拉、直连才可导、选中回填表单', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  assert.match(source, /id = 'edit-alias'/)
  assert.match(source, /api\('\/ssh\/api\/ssh-config\/aliases'\)/)
  assert.match(source, /opt\.disabled = alias\.direct === false/, '含跳板的 alias 禁选，不静默丢弃')
  assert.match(source, /opt\.dataset\.keypath = alias\.privateKeyPath/)
  assert.match(source, /aliasSelect\.value = ''/, '回填后下拉复位，不把别名当值提交')
})
