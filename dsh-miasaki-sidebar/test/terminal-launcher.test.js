import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TERMINAL_FALLBACK_ORDER,
  TERMINAL_SHELLS,
  launchTerminal,
  shellsForPlatform,
  terminalCommand,
  terminalOptions,
} from '../index.js'

test('terminalCommand: every shell yields an argv array, never a command string', () => {
  const cwd = 'C:\\Users\\Asakii\\Desktop\\dsh-miasaki'
  for (const shell of TERMINAL_SHELLS) {
    const { bin, args } = terminalCommand(shell.id, cwd)
    assert.equal(bin, shell.bin, `${shell.id}: bin comes from the registry, not the client`)
    assert.ok(Array.isArray(args), `${shell.id}: args must be an array`)
    for (const arg of args) assert.equal(typeof arg, 'string')
  }
})

test('terminalCommand: cwd only ever lands in a dedicated arg slot', () => {
  // A path with shell metacharacters must survive verbatim in its own slot —
  // proof that nothing is string-interpolated into a shell.
  const nasty = 'C:\\tmp\\a & calc.exe "x" | b'
  assert.deepEqual(terminalCommand('wt', nasty).args, ['-d', nasty])
  assert.deepEqual(terminalCommand('pwsh', nasty).args, ['-NoLogo', '-NoExit', '-WorkingDirectory', nasty])
  // powershell/cmd inherit spawn's cwd instead of taking a path argument, so
  // the hostile path appears nowhere in argv at all.
  assert.equal(terminalCommand('powershell', nasty).args.includes(nasty), false)
  assert.equal(terminalCommand('cmd', nasty).args.includes(nasty), false)
})

test('terminalCommand: rejects unknown shell ids and non-absolute cwd', () => {
  const cwd = 'C:\\workspace'
  // Enum-only surface: an arbitrary executable can never be requested.
  assert.throws(() => terminalCommand('bash; rm -rf /', cwd), /未知的终端类型/)
  assert.throws(() => terminalCommand('C:\\Windows\\System32\\calc.exe', cwd), /未知的终端类型/)
  assert.throws(() => terminalCommand(undefined, cwd), /未知的终端类型/)

  assert.throws(() => terminalCommand('cmd', 'relative\\path'), /绝对路径/)
  assert.throws(() => terminalCommand('cmd', ''), /绝对路径/)
  assert.throws(() => terminalCommand('cmd', null), /绝对路径/)
})

test('shellsForPlatform / fallback order', () => {
  const win = shellsForPlatform('win32').map(shell => shell.id)
  assert.deepEqual(win, ['wt', 'pwsh', 'powershell', 'cmd'])
  // The documented fallback chain (design §6.1) must stay a subset of win32.
  for (const id of TERMINAL_FALLBACK_ORDER) assert.ok(win.includes(id), `${id} must exist on win32`)
  assert.deepEqual(shellsForPlatform('darwin').map(s => s.id), ['terminal-app'])
  assert.deepEqual(shellsForPlatform('linux').map(s => s.id), ['x-terminal'])
  assert.deepEqual(shellsForPlatform('sunos'), [])
})

test('terminalOptions: reports availability per shell, foreign platform never claims available', async () => {
  const foreign = process.platform === 'win32' ? 'linux' : 'win32'
  const other = await terminalOptions(foreign)
  assert.equal(other.platform, foreign)
  assert.equal(other.shells.every(shell => shell.available === false), true, 'no probing across platforms')
  assert.equal(other.fallback, null)

  const local = await terminalOptions()
  assert.equal(local.platform, process.platform)
  for (const shell of local.shells) assert.equal(typeof shell.available, 'boolean')
  // fallback is either null or the first available shell in list order.
  const firstAvailable = local.shells.find(shell => shell.available)?.id ?? null
  assert.equal(local.fallback, firstAvailable)
})

test('launchTerminal: missing cwd is a 404-class error, a file cwd is an input error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sidebar-terminal-'))
  try {
    await assert.rejects(
      launchTerminal({ shellId: 'cmd', cwd: join(dir, 'does-not-exist'), logger: null }),
      /工作目录不存在/,
    )

    const file = join(dir, 'a-file.txt')
    await writeFile(file, 'x', 'utf8')
    await assert.rejects(launchTerminal({ shellId: 'cmd', cwd: file, logger: null }), /不是目录/)

    // cwd validation runs before the shell enum is consulted? No: the enum is
    // checked inside terminalCommand, after the directory check — an unknown
    // shell with a valid cwd must still be refused without spawning.
    await assert.rejects(launchTerminal({ shellId: 'nope', cwd: dir, logger: null }), /未知的终端类型/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('launchTerminal: a missing binary reports which one, without hanging', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sidebar-terminal-'))
  try {
    // Pick a shell that is guaranteed absent on this platform: the darwin/linux
    // entries on Windows and vice versa.
    const absent = process.platform === 'win32' ? 'x-terminal' : 'wt'
    const probe = await terminalOptions()
    const known = new Set(probe.shells.filter(s => s.available).map(s => s.id))
    if (known.has(absent)) return // 该平台意外装有此终端，跳过
    await assert.rejects(
      launchTerminal({ shellId: absent, cwd: dir, logger: null }),
      error => /未安装或找不到|终端启动失败/.test(error.message),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
