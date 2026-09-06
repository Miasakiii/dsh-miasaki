import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChecklistStore, parseUnifiedDiff, verifyDocSync } from '../index.js'

test('parseUnifiedDiff: hunks, line numbers, add/del/ctx', () => {
  const sample = [
    'diff --git a/src/app.js b/src/app.js',
    'index 83db48f..bf269f4 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -1,4 +1,5 @@',
    ' const keep = 1',
    '-const gone = 2',
    '+const added = 3',
    '+const added2 = 4',
    ' const tail = 5',
    '@@ -20,3 +21,3 @@',
    ' ctx line',
    '-old tail',
    '+new tail',
  ].join('\n')
  const file = parseUnifiedDiff(sample)
  assert.equal(file.path, 'src/app.js', 'path: strip a/ b/ prefix')
  assert.equal(file.hunks.length, 2)
  const [h1, h2] = file.hunks
  assert.deepEqual(h1.lines.map(l => l.t), ['ctx', 'del', 'add', 'add', 'ctx'])
  assert.deepEqual(h1.lines.map(l => l.b), [1, null, 2, 3, 4])
  assert.deepEqual(h1.lines.map(l => l.a), [1, 2, null, null, 3])
  assert.equal(h2.oldStart, 20)
  assert.equal(h2.lines[0].t, 'ctx')
  assert.equal(h2.lines[1].s, 'old tail')
})

test('parseUnifiedDiff: new file, binary, no-newline marker', () => {
  const created = [
    'diff --git a/new.md b/new.md',
    'new file mode 100644',
    'index 0000000..e69de29',
    '--- /dev/null',
    '+++ b/new.md',
    '@@ -0,0 +1,2 @@',
    '+first',
    '+second',
  ].join('\n')
  const file = parseUnifiedDiff(created)
  assert.equal(file.path, 'new.md')
  assert.equal(file.hunks[0].lines.every(l => l.t === 'add'), true)
  assert.deepEqual(file.hunks[0].lines.map(l => l.b), [1, 2])

  const binary = parseUnifiedDiff(['diff --git a/img.png b/img.png', 'index a..b', 'Binary files a/img.png and b/img.png differ'].join('\n'))
  assert.equal(binary.binary, true)

  const noNl = parseUnifiedDiff(['diff --git a/x.txt b/x.txt', '--- a/x.txt', '+++ b/x.txt', '@@ -1 +1 @@', '-end', '\\ No newline at end of file', '+end2', '\\ No newline at end of file'].join('\n'))
  assert.deepEqual(noNl.hunks[0].lines.map(l => [l.t, l.s]), [['del', 'end'], ['add', 'end2']])
})

test('verifyDocSync: code change without doc change flags all missing docs', () => {
  // Only a code file changed → both README and CHANGELOG are missing
  const findings = verifyDocSync([{ xy: 'M ', path: 'dsh-miasaki-sidebar\\client.js' }])
  assert.deepEqual(findings.pending, [
    { root: 'dsh-miasaki-sidebar', missing: ['dsh-miasaki-sidebar/README.md', 'dsh-miasaki-sidebar/design/CHANGELOG.md'] },
  ])

  // Changing only docs/README satisfies the fleet requirement
  const clean = verifyDocSync([{ xy: 'M ', path: 'dsh-miasaki-fleet\\README.md' }])
  assert.equal(clean.pending.find(p => p.root === 'dsh-miasaki-fleet')?.missing.length ?? 0, 0)

  // Monorepo line-roots check item: paths outside known roots produce nothing
  const outside = verifyDocSync([{ xy: '??', path: 'other/file.js' }])
  assert.deepEqual(outside.pending, [])
})

test('ChecklistStore: load defaults, patch merge, persistence roundtrip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sidebar-checklist-'))
  try {
    const cwd = 'C:\\some\\workspace'

    const store = new ChecklistStore(dir)
    const fresh = await store.load(cwd)
    assert.equal(fresh.docsSynced, false)
    assert.deepEqual(fresh.notes, {})

    const patched = await store.patch(cwd, { notes: { 'a.js': '属于壳功能', 'b.js': '' }, docsSynced: true })
    assert.equal(patched.notes['a.js'], '属于壳功能')
    assert.equal('b.js' in patched.notes, false)
    assert.equal(patched.docsSynced, true)

    // A new instance must read the persisted file (not just the in-memory cache).
    const second = new ChecklistStore(dir)
    const reloaded = await second.load(cwd)
    assert.deepEqual(reloaded.notes, { 'a.js': '属于壳功能' })
    assert.equal(reloaded.docsSynced, true)

    // A different cwd gets its own isolated file.
    const other = await second.load('D:\\other\\workspace')
    assert.deepEqual(other.notes, {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
