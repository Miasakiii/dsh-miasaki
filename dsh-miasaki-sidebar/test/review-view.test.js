import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GIT_BIN,
  REVIEW_BASELINES,
  diffForView,
  normalizeDiffContext,
  parseNameStatusZ,
  parseNumstatZ,
  parseStatusRows,
  parseUnifiedDiff,
  reviewStatus,
  unquoteGitPath,
} from '../index.js'

// ---------------------------------------------------------------------------
// 解析器（纯函数）：形态全部来自 2026-09-08 真实 git 探针（设计 §11）。
// ---------------------------------------------------------------------------

test('unquoteGitPath: quotes, spaces and octal UTF-8 are undone', () => {
  // git 只在需要时加引号：无空格路径原样返回。
  assert.equal(unquoteGitPath('plain/path.ts'), 'plain/path.ts')
  assert.equal(unquoteGitPath('"with space.txt"'), 'with space.txt')
  assert.equal(unquoteGitPath('"a\\"b.txt"'), 'a"b.txt')
  assert.equal(unquoteGitPath('"tab\\there.txt"'), 'tab\there.txt')
  // core.quotepath=true 下非 ASCII 是八进制 UTF-8 字节序列：必须整串按字节
  // 解码，逐转义解会把「中」拆成三个替换字符。
  assert.equal(unquoteGitPath('"\\344\\270\\255.txt"'), '中.txt')
  // 引号内的制表符分隔（status 的 -z 之外的形态）在 trim 阶段被切掉。
  assert.equal(unquoteGitPath('"x.txt"\tignored'), 'x.txt')
})

test('parseStatusRows: xy codes, rename target wins, quoted paths unquoted', () => {
  const rows = parseStatusRows([
    ' M a.ts',
    'M  b.txt',
    '?? "untracked new.ts"',
    'R  moved.txt -> "moved renamed.txt"',
    ' M "old name.txt"',
    '',
  ].join('\n'))
  assert.deepEqual(rows, [
    { xy: ' M', path: 'a.ts', from: null },
    { xy: 'M ', path: 'b.txt', from: null },
    { xy: '??', path: 'untracked new.ts', from: null },
    { xy: 'R ', path: 'moved renamed.txt', from: 'moved.txt' },
    { xy: ' M', path: 'old name.txt', from: null },
  ])
})

test('normalizeDiffContext: bounds the -U window (null keeps the git default)', () => {
  assert.equal(normalizeDiffContext(null), null)
  assert.equal(normalizeDiffContext(undefined), null)
  assert.equal(normalizeDiffContext(0), 0)
  assert.equal(normalizeDiffContext('12'), 12)
  for (const bad of [65, -1, 1.5, 'abc', {}]) {
    assert.throws(() => normalizeDiffContext(bad), /0–64/, `应拒绝非法 context：${String(bad)}`)
  }
})

test('REVIEW_BASELINES: the view → baseline label mapping the UI spells out', () => {
  assert.deepEqual(REVIEW_BASELINES, { unstaged: 'index', staged: 'HEAD', all: 'HEAD', last: 'HEAD^' })
})

test('parseNumstatZ: plain, binary and rename records key on the new path', () => {
  const plain = parseNumstatZ('2\t0\ta.ts\u0000-\t-\timg.png\u0000')
  assert.deepEqual(plain.get('a.ts'), { add: 2, del: 0, binary: false })
  assert.deepEqual(plain.get('img.png'), { add: null, del: null, binary: true })

  // rename：`add\tdel\t\u0000old\u0000new\u0000`——人类可读格式的 `old => new` 一旦路径
  // 含 ` => ` 就有歧义，这正是选 -z 的原因。
  const renamed = parseNumstatZ('0\t0\t\u0000moved.txt\u0000moved renamed.txt\u0000')
  assert.deepEqual([...renamed.keys()], ['moved renamed.txt'])
  assert.deepEqual(renamed.get('moved renamed.txt'), { add: 0, del: 0, binary: false })

  // 混合：rename 之后的普通记录不能被错位吃掉。
  const mixed = parseNumstatZ('4\t0\tbrand new.ts\u00000\t0\t\u0000old.txt\u0000new.txt\u00001\t1\ttail.ts\u0000')
  assert.deepEqual([...mixed.keys()], ['brand new.ts', 'new.txt', 'tail.ts'])
  assert.deepEqual(mixed.get('tail.ts'), { add: 1, del: 1, binary: false })

  assert.equal(parseNumstatZ('').size, 0)
})

test('parseNameStatusZ: status letter plus path; renames carry old then new', () => {
  const rows = parseNameStatusZ('A\u0000brand new.ts\u0000M\u0000first.ts\u0000R100\u0000moved.txt\u0000moved renamed.txt\u0000D\u0000gone.txt\u0000')
  assert.deepEqual(rows, [
    { code: 'A', path: 'brand new.ts' },
    { code: 'M', path: 'first.ts' },
    { code: 'R', path: 'moved renamed.txt', from: 'moved.txt' },
    { code: 'D', path: 'gone.txt' },
  ])
  assert.deepEqual(parseNameStatusZ(''), [])
})

// ---------------------------------------------------------------------------
// 真实 git 仓库集成：四视图的行集与统计。
// ---------------------------------------------------------------------------

// 沙箱/受限环境下 Node 无法通过管道捕获子进程输出（spawn EPERM），此时被
// 测的 reviewStatus() 本身也跑不起来——跳过而不是误报失败。用「能否捕获
// 输出」而不是「git 是否存在」做判据，因为 git 存在但捕获被禁正是该场景。
const canCaptureGit = () => {
  const probe = spawnSync(GIT_BIN, ['--version'], { encoding: 'utf8', windowsHide: true })
  return probe.status === 0 && probe.error === undefined
}
const skipIntegration = canCaptureGit() ? false : `无法捕获 git 子进程输出（${GIT_BIN}），跳过集成用例`

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'sidebar-review-'))
  const git = (...args) => {
    const result = spawnSync(GIT_BIN, args, { cwd: dir, encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr || result.stdout}`)
    return result.stdout
  }
  git('init', '-q')
  git('config', 'user.email', 'sidebar-test@local')
  git('config', 'user.name', 'sidebar-test')
  // 关掉换行转换：否则 writeFile 的 LF 会被提交成 CRLF，numstat 统计漂移。
  git('config', 'core.autocrlf', 'false')
  return { dir, git }
}

test('reviewStatus: the four views partition a real working tree', { skip: skipIntegration }, async () => {
  const { dir, git } = await makeRepo()
  try {
    // --- root commit（同时覆盖「上一轮更改 = 最近一次提交」在首提交上的行为） ---
    await writeFile(join(dir, 'first.ts'), '1\n2\n3\n')
    await writeFile(join(dir, 'moved.txt'), 'moved\n')
    await writeFile(join(dir, 'with space.txt'), 'old\n')
    await mkdir(join(dir, 'sub'), { recursive: true })
    await writeFile(join(dir, 'sub', 'c.json'), '{"a":1}\n')
    await writeFile(join(dir, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]))
    git('add', '-A')
    git('commit', '-q', '-m', 'root')

    // --- 制造四种状态 ---
    await writeFile(join(dir, 'first.ts'), '1\n2\n3\n4\n5\n')            // 未暂存 M（+2）
    await writeFile(join(dir, 'moved.txt'), 'moved staged\n')            // 已暂存 M（+1 -1）
    git('add', 'moved.txt')
    await writeFile(join(dir, 'untracked new.ts'), 'n1\nn2\nn3\n')       // 未跟踪（+3）
    git('mv', 'with space.txt', 'renamed file.txt')                      // 已暂存 R
    await writeFile(join(dir, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff]))

    const byPath = entries => new Map(entries.map(entry => [entry.path, entry]))

    const unstaged = await reviewStatus(dir, { view: 'unstaged' })
    assert.equal(unstaged.view, 'unstaged')
    assert.deepEqual([...byPath(unstaged.entries).keys()].sort(), ['first.ts', 'img.png', 'untracked new.ts'])
    assert.deepEqual(
      [byPath(unstaged.entries).get('first.ts').add, byPath(unstaged.entries).get('first.ts').del],
      [2, 0],
      '未暂存修改的行数来自 git diff --numstat -z',
    )
    assert.equal(byPath(unstaged.entries).get('img.png').binary, true, '二进制文件标 binary 且无行数')
    assert.equal(byPath(unstaged.entries).get('untracked new.ts').add, 3, '未跟踪文件由 host 读文件计数')

    const staged = await reviewStatus(dir, { view: 'staged' })
    // `??` 的 xy[0] 是 '?'：未跟踪文件绝不能被算进已暂存。
    assert.deepEqual([...byPath(staged.entries).keys()].sort(), ['moved.txt', 'renamed file.txt'])
    assert.deepEqual(
      [byPath(staged.entries).get('moved.txt').add, byPath(staged.entries).get('moved.txt').del],
      [1, 1],
    )
    assert.deepEqual(
      [byPath(staged.entries).get('renamed file.txt').add, byPath(staged.entries).get('renamed file.txt').del],
      [0, 0],
      'rename 记录按新路径归并，统计为 0/0',
    )

    const all = await reviewStatus(dir, { view: 'all' })
    assert.deepEqual(
      [...byPath(all.entries).keys()].sort(),
      ['first.ts', 'img.png', 'moved.txt', 'renamed file.txt', 'untracked new.ts'],
      '全部分支更改 = 未暂存 + 已暂存 + 未跟踪',
    )

    const last = await reviewStatus(dir, { view: 'last' })
    assert.equal(last.noCommits, undefined)
    assert.deepEqual(
      [...byPath(last.entries).keys()].sort(),
      ['first.ts', 'img.png', 'moved.txt', 'sub/c.json', 'with space.txt'],
      '上一轮更改 = 最近一次提交（root commit 也要能读出来）',
    )
    assert.equal(last.entries.every(entry => entry.code === 'A'), true, 'root commit 全部是新增')
    assert.equal(byPath(last.entries).get('first.ts').add, 3)
    assert.equal(last.entries.every(entry => entry.revision === last.head), true, 'last 条目携带所在提交，详情据此感知 HEAD 前进')

    // --- 第二次提交：rename / 删除 / 修改都要在 last 视图里正确归并 ---
    git('add', '-A')
    git('commit', '-q', '-m', 'second')
    const last2 = await reviewStatus(dir, { view: 'last' })
    const last2Map = byPath(last2.entries)
    assert.equal(last2Map.get('renamed file.txt')?.code, 'R', 'git show 默认带 rename 检测')
    assert.equal(last2Map.get('renamed file.txt')?.from, 'with space.txt')
    assert.equal(last2Map.get('first.ts')?.code, 'M')
    assert.equal(last2Map.get('img.png')?.binary, true)
    assert.equal(last2Map.get('untracked new.ts')?.code, 'A')
    assert.notEqual(last2.head, last.head, 'HEAD 前进后 revision 必须变化——否则详情不会重取')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('diffForView: the detail baseline follows the view, not always HEAD', { skip: skipIntegration }, async () => {
  const { dir, git } = await makeRepo()
  try {
    await writeFile(join(dir, 'app.ts'), 'one\ntwo\nthree\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'root')

    // 制造「索引 ≠ 工作树」的分层状态：暂存一份修改，工作树再追加一行。
    await writeFile(join(dir, 'app.ts'), 'one\nTWO\nTHREE\nfour\nFIVE staged\n')
    git('add', 'app.ts')
    await writeFile(join(dir, 'app.ts'), 'one\nTWO\nTHREE\nfour\nFIVE staged\nSIX worktree\n')
    const changedLines = text => parseUnifiedDiff(text).hunks.flatMap(h => h.lines).filter(l => l.t !== 'ctx').map(l => l.s)

    const staged = await diffForView(dir, 'app.ts', { view: 'staged' })
    assert.equal(staged.baseline, 'HEAD')
    assert.equal(changedLines(staged.text).includes('FIVE staged'), true)
    assert.equal(changedLines(staged.text).includes('SIX worktree'), false, '已暂存详情不得混入未暂存改动（缺陷修复前混入的是工作树 vs HEAD）')

    const unstaged = await diffForView(dir, 'app.ts', { view: 'unstaged' })
    assert.equal(unstaged.baseline, 'index')
    assert.equal(changedLines(unstaged.text).includes('SIX worktree'), true)
    assert.equal(changedLines(unstaged.text).includes('FIVE staged'), false, '未暂存详情不得混入已暂存改动')

    const all = await diffForView(dir, 'app.ts', { view: 'all' })
    assert.equal(all.baseline, 'HEAD')
    assert.equal(changedLines(all.text).includes('FIVE staged'), true, '全部分支更改 = 工作树 vs HEAD，两层都要在')
    assert.equal(changedLines(all.text).includes('SIX worktree'), true)

    git('add', '-A')
    git('commit', '-q', '-m', 'second')
    const last = await diffForView(dir, 'app.ts', { view: 'last' })
    assert.equal(last.baseline, 'HEAD^')
    assert.equal(changedLines(last.text).includes('FIVE staged'), true, '上一轮更改 = HEAD 提交本身（git show）')
    assert.equal(changedLines(last.text).includes('SIX worktree'), true)

    // --- rename：from 与新路径一起进 pathspec，旧路径侧才有内容 ---
    git('mv', 'app.ts', 'renamed.ts')
    // R100 的纯 rename 只有 rename from/to 头、没有 ---/+++ 内容行；再改一
    // 行让相似度低于 100%，rename diff 才携带旧路径侧的实际内容。
    await writeFile(join(dir, 'renamed.ts'), 'one\nTWO\nTHREE\nfour\nFIVE staged\nSIX worktree\nSEVEN\n')
    git('add', '-A')
    const rename = await diffForView(dir, 'renamed.ts', { view: 'staged', from: 'app.ts' })
    assert.equal(rename.text.includes('--- a/app.ts'), true, '带 from 的 rename diff 必须包含旧路径侧（修复前旧路径不参与，重命名常显示为空）')
    // 对照：pathspec 不含旧路径时配对不成立，同一文件被渲染成全新增——
    // 这正是「重命名文件的详情与列表对不上」的机理。
    const noFrom = await diffForView(dir, 'renamed.ts', { view: 'staged' })
    assert.equal(noFrom.text.includes('--- a/app.ts'), false)

    // --- context：-U0 收紧上下文，行数必须少于默认 ---
    await writeFile(join(dir, 'renamed.ts'), 'one\nTWO\nthree\nfour\nFIVE staged\nSIX worktree\n')
    const wide = parseUnifiedDiff((await diffForView(dir, 'renamed.ts', { view: 'unstaged' })).text)
    const tight = parseUnifiedDiff((await diffForView(dir, 'renamed.ts', { view: 'unstaged', context: 0 })).text)
    const sum = parsed => parsed.hunks.reduce((n, h) => n + h.lines.length, 0)
    assert.equal(sum(wide) > sum(tight), true, 'context=0 的 diff 行数必须少于默认 -U3')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('diffForView: a repo with no commit degrades honestly (index baseline, untracked via --no-index)', { skip: skipIntegration }, async () => {
  const { dir, git } = await makeRepo()
  try {
    await writeFile(join(dir, 'new.ts'), '1\n2\n')
    git('add', '-A')
    const all = await diffForView(dir, 'new.ts', { view: 'all' })
    assert.equal(all.baseline, 'index', '无 HEAD 时 all 的详情基线如实标注为索引（列表 numstat 的兜底同款）')
    assert.equal(parseUnifiedDiff(all.text).hunks[0].lines.every(l => l.t === 'add'), true)

    git('reset', '-q')
    const untracked = await diffForView(dir, 'new.ts', { view: 'all' })
    assert.equal(parseUnifiedDiff(untracked.text).hunks[0].lines.length, 2, '未跟踪文件经 --no-index 渲染为全增')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reviewStatus: a repository with no commit degrades instead of throwing', { skip: skipIntegration }, async () => {
  const { dir } = await makeRepo()
  try {
    await writeFile(join(dir, 'new.ts'), '1\n2\n')
    const last = await reviewStatus(dir, { view: 'last' })
    assert.equal(last.noCommits, true, '无 HEAD 时 last 视图降级而不是 500')
    assert.deepEqual(last.entries, [])

    const all = await reviewStatus(dir, { view: 'all' })
    assert.equal(all.noCommits, true)
    assert.equal(all.entries.length, 1)
    assert.equal(all.entries[0].path, 'new.ts')
    assert.equal(all.entries[0].add, 2, '无 HEAD 时 all 以索引为空基线，未跟踪仍要计数')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
