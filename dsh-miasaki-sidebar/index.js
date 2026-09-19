import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'

// `package.json` is the single source of truth for the reported version. The
// health route is the deployment contract for "did the host load the new
// bundle?" (README §验证), and a hand-copied constant silently drifted at the
// 0.6.0 migration: it kept answering 0.5.1-miasaki.1 while package.json was
// already 0.6.0-miasaki.0, which made a stale host look current.
const PLUGIN_VERSION = createRequire(import.meta.url)('./package.json').version

const execFileP = (...args) => new Promise((resolve, reject) => {
  const [cmd, params, opts] = args
  const timeout = typeof opts?.timeout === 'number' && opts.timeout > 0 ? opts.timeout : Infinity
  const child = spawn(cmd, params, { ...opts, windowsHide: true })
  let stdout = ''
  let stderr = ''
  let timer = null
  if (timeout !== Infinity) timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('command timed out')) }, timeout)
  child.stdout.on('data', d => stdout += d)
  child.stderr.on('data', d => stderr += d)
  child.on('error', err => { if (timer) clearTimeout(timer); reject(err) })
  child.on('close', code => {
    if (timer) clearTimeout(timer)
    if (code === 0) resolve({ stdout, stderr })
    else {
      const err = new Error(stderr || `exit ${code}`)
      err.code = code
      err.stdout = stdout
      err.stderr = stderr
      reject(err)
    }
  })
})
export const name = 'sidebar'
export const inject = ['webServer']

const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
// Absolute path by default: the DSH host process was observed to have no Git
// on PATH (2026-09-07), and `spawn('git')` would then fail at runtime rather
// than at config time. Overridable for a different install layout, which is
// also what the integration tests use.
export const GIT_BIN = process.env.DSH_SIDEBAR_GIT ?? 'C:\\Program Files\\Git\\cmd\\git.exe'
// Git --no-index needs an actual existing empty file as the "before" side;
// /dev/null works on Unix but not through execFile on Windows (no /dev tree),
// so resolve the platform null device at module load.
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'
// Status entries cap: beyond this the list truncates with a marker instead of
// silently cutting (better-sidebar #376 同款设界).
const STATUS_MAX_ENTRIES = 2000
// Parsed diff lines cap per request; larger diffs truncate with a marker.
const DIFF_MAX_LINES = 20_000
const CHECKLIST_PATCH_MAX_BYTES = 64 * 1024
// Review views (v0.5.0, design 2026-09-08 §4.1). The whitelist lives here so
// an unknown `view` is a 400, never a silent fallback to a different view.
export const REVIEW_VIEWS = ['unstaged', 'staged', 'all', 'last']
// untracked files have no single-call numstat in git, so the host counts them
// itself; cap the work and leave the rest stat-less (the UI shows `-`).
const UNTRACKED_STAT_MAX_FILES = 200
const UNTRACKED_STAT_MAX_BYTES = 2 * 1024 * 1024

/** Host/host:port fence for the /sidebar API (mirrors the canvas plugin): the DSH /api browser-trust fence does not cover plugin routes. */
function trustedHostSet(config) {
  return new Set(['localhost', '127.0.0.1', ...[...(config?.trustedHosts ?? [])].map(host => String(host).trim().toLowerCase()).filter(Boolean)])
}

/**
 * The three-layer browser-trust fence, shared by the HTTP routes and the WS
 * upgrade (2026-09-12: extracted so /sidebar/ws/terminal runs the exact same
 * checks). Layers: ① Host must be loopback or a configured trustedHosts entry;
 * ② the browser's own `sec-fetch-site: cross-site` verdict is refused; ③ a
 * present Origin must name our hostname (hostname, not authority — some
 * Chromium builds strip a non-default loopback port; `null` = opaque, refused).
 * These are DNS-rebinding / cross-site defense in depth, NOT authentication —
 * the embedded terminal adds a one-shot token on top (WS enjoys no same-origin
 * protection of its own, xterm.js security guide).
 */
export function fenceRequest(headers, trusted) {
  const hostname = (typeof headers.host === 'string' ? headers.host : '').replace(/:\d+$/, '').toLowerCase()
  if (!trusted.has(hostname)) return { ok: false, status: 403, error: '不被信任的 Host' }
  if (headers['sec-fetch-site'] === 'cross-site') return { ok: false, status: 403, error: '跨站请求被拒绝' }
  const origin = headers.origin
  if (typeof origin === 'string' && origin !== '') {
    let originHostname = null
    try { originHostname = new URL(origin).hostname.toLowerCase() } catch { originHostname = null }
    if (originHostname === null || originHostname !== hostname) return { ok: false, status: 403, error: '跨站来源被拒绝' }
  }
  return { ok: true }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Validate a client-supplied cwd: absolute, resolvable, a real directory. spawn args never touch a shell, so the only injection surface is a bogus path. */
export function resolveWorkdir(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new InputError('需要工作区的绝对路径')
  const cwd = raw.trim()
  // Absolute-ness must be judged BEFORE resolve(): resolve() turns a relative
  // path into an absolute one against the host process cwd, so the old
  // post-resolve check was always true and a relative cwd was silently
  // reinterpreted — it either 404'd on a bogus path or, if the path happened to
  // exist under the host cwd, launched a terminal there.
  if (!isAbsolute(cwd)) throw new InputError('需要工作区的绝对路径')
  return resolve(cwd)
}

class InputError extends Error {}
class NotFoundError extends Error {}
/** Session-cap rejection: surfaced to the client as an `error` frame with code LIMIT. */
class LimitError extends Error {}

async function runGit(cwd, args, { ignoreExit } = {}) {
  try {
    const { stdout } = await execFileP(GIT_BIN, args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true })
    return stdout
  } catch (error) {
    if (!ignoreExit) {
      const message = error instanceof Error ? error.message : String(error)
      if (/Not a git repository|not a git repository|无法找到仓库/.test(message)) throw new InputError('该目录不是 git 仓库')
      if (/fatal:|error:/.test(message)) throw new InputError(`git 执行失败：${message.replace(/^fatal:\s*/i, '').slice(0, 160)}`)
      throw error
    }
    // ignoreExit mode: return whatever stdout was captured (git --no-index
    // exits 1 when files differ, but the diff text is on stdout).
    if (error?.stdout) return error.stdout
    return ''
  }
}

/** Baseline label returned with every diff response (design 2026-09-12 §3.1): the UI says out loud WHICH comparison a diff represents. */
export const REVIEW_BASELINES = {
  unstaged: 'index', // working tree vs index
  staged: 'HEAD', // index vs HEAD
  all: 'HEAD', // working tree vs HEAD (index when the repo has no commit yet)
  last: 'HEAD^', // the HEAD commit vs its parent
}

/** Context window for `-U`: bounded so a hostile value cannot ask git for an unbounded diff. null keeps git's default (3). */
export function normalizeDiffContext(raw) {
  if (raw === null || raw === undefined) return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 64) throw new InputError('context 必须是 0–64 的整数')
  return n
}

/** `--no-index` render of an untracked file: the whole file as additions. */
async function noIndexDiff(cwd, rel, context) {
  const abs = join(cwd, rel)
  const uArg = context === null ? [] : [`-U${context}`]
  // `git diff --no-index` exits 1 when files differ (not an error for us);
  // capture stdout from both the success and error paths.
  const noIndex = await runGit(cwd, ['diff', '--no-index', ...uArg, NULL_DEVICE, abs]).catch(error => {
    return typeof error?.stdout === 'string' ? error.stdout : ''
  })
  // strip the /dev/null header line to keep the parser happy
  return noIndex.replace(new RegExp('^diff --git a/' + NULL_DEVICE.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + ' b/[^\\n]+\\n'), '')
}

/**
 * Line-level diff for one file under one review view (design 2026-09-12 §3.1).
 * Replaces the pre-0.7 `diffForFile(cwd, rel, cached)`: the detail request
 * carries the view the LIST was computed with, so the two baselines can never
 * diverge — the old code always diffed working-tree-vs-HEAD, which made staged
 * entries show unrelated content and committed files under `last` show "no
 * changes".
 * `from` is the pre-rename path: handed to git alongside the new path, because
 * rename detection pairs a delete with an add only when BOTH paths are in the
 * pathspec — limiting the spec to the new path renders a rename as a
 * from-scratch add whose numbers then disagree with the list's numstat.
 * Returns { text, baseline } so the caller can echo the true baseline back
 * (the no-commit fallback under `all` really is the index, not HEAD).
 */
export async function diffForView(cwd, rel, { view = 'all', from = null, context = null } = {}) {
  if (!REVIEW_VIEWS.includes(view)) throw new InputError(`未知的审查视图：${String(view).slice(0, 20)}`)
  const ctx = normalizeDiffContext(context)
  const uArg = ctx === null ? [] : [`-U${ctx}`]
  const paths = typeof from === 'string' && from !== '' && from !== rel ? [from, rel] : [rel]
  if (view === 'staged') return { text: await runGit(cwd, ['diff', '--cached', ...uArg, '--', ...paths]), baseline: REVIEW_BASELINES.staged }
  if (view === 'last') return { text: await runGit(cwd, ['show', '--format=', ...uArg, 'HEAD', '--', ...paths]), baseline: REVIEW_BASELINES.last }
  // Working-tree views: untracked files produce no output from `git diff`;
  // use --no-index to render the full file as additions (the review tab
  // treats new files as "all added").
  const isTracked = await runGit(cwd, ['ls-files', '--error-unmatch', rel]).then(() => true, () => false)
  if (!isTracked) return { text: await noIndexDiff(cwd, rel, ctx), baseline: REVIEW_BASELINES[view] }
  if (view === 'unstaged') return { text: await runGit(cwd, ['diff', ...uArg, '--', ...paths]), baseline: REVIEW_BASELINES.unstaged }
  // `all` with no commit yet has no HEAD to compare against — fall back to
  // the index baseline, matching what reviewStatus's numstat does here.
  const hasHead = (await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim() !== ''
  const baseline = hasHead ? REVIEW_BASELINES.all : 'index'
  return { text: await runGit(cwd, ['diff', hasHead ? 'HEAD' : '--cached', ...uArg, '--', ...paths]), baseline }
}

/**
 * Undo git's C-style path quoting. `status --short` quotes paths containing
 * spaces, and with the default core.quotepath=true a non-ASCII path arrives as
 * octal UTF-8 escapes (`"\344\270\255"`). Escapes are collected as BYTES and
 * decoded once at the end — decoding each octal escape on its own would split
 * a multi-byte character into replacement characters.
 */
export function unquoteGitPath(raw) {
  const trimmed = raw.replace(/\t.*$/, '').trim()
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed
  const body = trimmed.slice(1, -1)
  const bytes = []
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue }
    const next = body[i + 1]
    if (next === undefined) break
    if (next === '\\' || next === '"') { bytes.push(next.charCodeAt(0)); i += 1; continue }
    if (next === 't') { bytes.push(9); i += 1; continue }
    if (next === 'n') { bytes.push(10); i += 1; continue }
    if (next === 'r') { bytes.push(13); i += 1; continue }
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1))
    if (octal !== null) { bytes.push(Number.parseInt(octal[0], 8) & 0xff); i += octal[0].length; continue }
    bytes.push(next.charCodeAt(0)); i += 1
  }
  return Buffer.from(bytes).toString('utf8')
}

/**
 * `git status --short` rows → [{ xy, path, from }]. A rename prints
 * `R  old -> new` (the target wins) and every path is unquoted — the pre-v0.5
 * inline version kept the surrounding quotes, so a path with a space was sent
 * to the diff route verbatim as `"a b.ts"`. `from` keeps the pre-rename path
 * so the detail diff can pair both sides (2026-09-12 §3.1); non-renames carry
 * null.
 */
export function parseStatusRows(text) {
  return text.split('\n')
    .filter(line => line.length >= 3 && line.trim() !== '')
    .map(line => {
      const raw = line.slice(3)
      const arrow = raw.indexOf(' -> ')
      if (arrow === -1) return { xy: line.slice(0, 2), path: unquoteGitPath(raw), from: null }
      return {
        xy: line.slice(0, 2),
        path: unquoteGitPath(raw.slice(arrow + 4)),
        from: unquoteGitPath(raw.slice(0, arrow)),
      }
    })
}

/**
 * `git diff|show --numstat -z` → Map(path → { add, del, binary }). The -z form
 * is used because the human format renders a rename as `old => new`, which is
 * ambiguous as soon as a path contains ` => `; in -z a rename record is
 * `add\tdel\t\0old\0new\0` and is keyed by the NEW path (probe-measured
 * 2026-09-08, design §11).
 */
export function parseNumstatZ(text) {
  const stats = new Map()
  const fields = text.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i]
    if (record === '') continue
    const firstTab = record.indexOf('\t')
    const secondTab = record.indexOf('\t', firstTab + 1)
    if (firstTab === -1 || secondTab === -1) continue
    const addRaw = record.slice(0, firstTab)
    const delRaw = record.slice(firstTab + 1, secondTab)
    let path = record.slice(secondTab + 1)
    if (path === '') {
      const oldPath = fields[i + 1] ?? ''
      path = fields[i + 2] ?? oldPath
      i += 2
    }
    if (path === '') continue
    const binary = addRaw === '-' || delRaw === '-'
    stats.set(path, { add: binary ? null : Number(addRaw), del: binary ? null : Number(delRaw), binary })
  }
  return stats
}

/** `git show|diff --name-status -z` → [{ code, path, from? }]; rename/copy records carry old then new path. */
export function parseNameStatusZ(text) {
  const rows = []
  const fields = text.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i]
    if (code === '') continue
    const letter = code[0]
    if (letter === 'R' || letter === 'C') {
      const from = fields[i + 1] ?? ''
      rows.push({ code: letter, path: fields[i + 2] ?? from, from })
      i += 2
    } else {
      rows.push({ code: letter, path: fields[i + 1] ?? '' })
      i += 1
    }
  }
  return rows
}

/**
 * Count one untracked file by reading it (additions = line count, deletions =
 * 0). Reading beats `git diff --no-index` here: that would be one spawn per
 * file, and its numstat output carries a `NUL => ` prefix. Binary (a NUL byte)
 * and oversized files report no numbers rather than a wrong count.
 */
async function statUntracked(cwd, rel) {
  if (rel.split(/[\\/]/).includes('..')) return { add: null, del: null, binary: false }
  try {
    const buffer = await readFile(join(cwd, rel))
    if (buffer.length > UNTRACKED_STAT_MAX_BYTES) return { add: null, del: null, binary: false }
    if (buffer.includes(0)) return { add: null, del: null, binary: true }
    const text = buffer.toString('utf8')
    if (text === '') return { add: 0, del: 0, binary: false }
    const lines = text.split('\n')
    return { add: lines[lines.length - 1] === '' ? lines.length - 1 : lines.length, del: 0, binary: false }
  } catch { return { add: null, del: null, binary: false } }
}

/**
 * One reviewed working tree for one view (design §4.1). Every git call is
 * read-only and bounded; a view that cannot be computed on this repo (no
 * commit yet → no HEAD) degrades to `noCommits` instead of throwing, so an
 * empty repository still renders a panel instead of a 500.
 */
export async function reviewStatus(cwd, { view = 'all', logger } = {}) {
  // `logger` is passed in from apply(): this module has no ambient ctx, and an
  // earlier version referenced one here — a git failure then threw
  // ReferenceError instead of degrading to an empty field.
  const maybe = args => runGit(cwd, args).catch(error => {
    logger?.warn?.(`sidebar:review ${args.join(' ')}: ${error instanceof Error ? error.message : String(error)}`)
    return ''
  })
  const [branch, head, statusText, headProbe] = await Promise.all([
    maybe(['branch', '--show-current']),
    maybe(['rev-parse', '--short', 'HEAD']),
    maybe(['status', '--short', '--untracked-files=all']),
    maybe(['rev-parse', '--verify', '--quiet', 'HEAD']),
  ])
  const hasHead = headProbe.trim() !== ''

  // --- 上一轮更改：最近一次提交（git show 视角） ---
  if (view === 'last') {
    if (!hasHead) return { view, branch, head: '', noCommits: true, entries: [], truncated: false, total: 0 }
    // `show` (not diff-tree) handles the root commit without extra flags and
    // enables rename detection by default; both calls are -z machine format.
    const [nameZ, numZ] = await Promise.all([
      maybe(['show', '--name-status', '-z', '--format=', 'HEAD']),
      maybe(['show', '--numstat', '-z', '--format=', 'HEAD']),
    ])
    const stats = parseNumstatZ(numZ)
    const named = parseNameStatusZ(nameZ)
    const entries = named.slice(0, STATUS_MAX_ENTRIES).map(row => {
      const stat = stats.get(row.path)
      return {
        path: row.path,
        from: row.from ?? null,
        code: row.code,
        add: stat?.add ?? null,
        del: stat?.del ?? null,
        binary: stat?.binary ?? false,
        // The commit this row was read from: the client echoes it into the
        // detail request so a HEAD advance between list and detail forces a
        // refetch instead of showing the old commit's diff.
        revision: head,
      }
    })
    return { view, branch, head, entries, truncated: named.length > STATUS_MAX_ENTRIES, total: named.length }
  }

  // --- 工作区三视图 ---
  const rows = parseStatusRows(statusText)
  const selectedAll = rows.filter(row => {
    // `??` is untracked: a working-tree change for `unstaged`, but NOT staged
    // (`xy[0]` is `?`, which would otherwise pass the staged test).
    if (view === 'staged') return row.xy !== '??' && row.xy[0] !== ' '
    return view === 'unstaged' ? row.xy[1] !== ' ' : true
  })
  const selected = selectedAll.slice(0, STATUS_MAX_ENTRIES)

  let stats
  if (view === 'staged') stats = parseNumstatZ(await maybe(['diff', '--cached', '--numstat', '-z']))
  else if (view === 'unstaged') stats = parseNumstatZ(await maybe(['diff', '--numstat', '-z']))
  // `all` compares the working tree against HEAD; with no commit yet there is
  // no HEAD, so the index becomes the baseline (everything reads as new).
  else stats = parseNumstatZ(await maybe(hasHead ? ['diff', 'HEAD', '--numstat', '-z'] : ['diff', '--cached', '--numstat', '-z']))

  const untracked = selected.filter(row => row.xy === '??' && !stats.has(row.path))
  const untrackedStats = new Map(await Promise.all(
    untracked.slice(0, UNTRACKED_STAT_MAX_FILES).map(async row => [row.path, await statUntracked(cwd, row.path)]),
  ))

  const entries = selected.map(row => {
    const stat = stats.get(row.path) ?? untrackedStats.get(row.path)
    return {
      path: row.path,
      // Staged renames keep their old path so the detail diff can pair both
      // sides (working-tree views never show rename rows — an unstaged rename
      // surfaces as two entries: the tracked deletion and the untracked file).
      ...(row.from !== null ? { from: row.from } : {}),
      xy: row.xy,
      add: stat?.add ?? null,
      del: stat?.del ?? null,
      binary: stat?.binary ?? false,
    }
  })
  return {
    view,
    branch,
    head,
    entries,
    truncated: selectedAll.length > STATUS_MAX_ENTRIES,
    total: selectedAll.length,
    untrackedTruncated: untracked.length > UNTRACKED_STAT_MAX_FILES,
    ...(hasHead ? {} : { noCommits: true }),
  }
}

/**
 * Minimal unified-diff parser: file header (---/+++/index), hunk headers, and
 * per-line { t: add|del|ctx, a, b, s } with tracked old/new line numbers.
 * M1 scope: single-file diffs only (the review tab requests one file at a
 * time); renames/binary show as meta lines. No diff library — the shapes we
 * render are exactly these three line kinds plus hunk boundaries.
 */
export function parseUnifiedDiff(text) {
  // git 的输出每行都以 \n 结尾，split 出来的最后一个 '' 是换行 artifact 而
  // 不是 diff 行——把它当上下文会多出一行假行号（a:0）的空行。真实的结尾空
  // 上下文行不受影响：'\n\n' 剥掉一个换行后仍留下一个 ''。
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  const file = { path: null, hunks: [], truncated: false, binary: false }
  let hunk = null
  let oldNo = 0
  let newNo = 0
  let lineCount = 0
  let sawFileHeader = false
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (sawFileHeader) break
      sawFileHeader = true
      continue
    }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) { file.binary = true; break }
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) continue
    if (line.startsWith('similarity index') || line.startsWith('index ')) continue
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const path = normalizeGitPath(line.slice(4))
      if (path !== '/dev/null' && file.path === null) file.path = path
      continue
    }
    if (line.startsWith('new file mode') || line.startsWith('deleted file mode') || line.startsWith('old mode') || line.startsWith('new mode')) continue
    const hunkHead = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunkHead !== null) {
      oldNo = Number(hunkHead[1])
      newNo = Number(hunkHead[3])
      // Whole header line kept (not just the numbers): the trailing string
      // after the second @@ is git's enclosing-function hint, part of what
      // makes a hunk header readable in a narrow panel.
      hunk = { oldStart: oldNo, newStart: newNo, header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (hunk === null) continue
    if (lineCount >= DIFF_MAX_LINES) { file.truncated = true; break }
    if (line.startsWith('+')) { hunk.lines.push({ t: 'add', a: null, b: newNo++, s: line.slice(1) }); lineCount++ }
    else if (line.startsWith('-')) { hunk.lines.push({ t: 'del', a: oldNo++, b: null, s: line.slice(1) }); lineCount++ }
    else if (line.startsWith(' ') || line === '') { hunk.lines.push({ t: 'ctx', a: oldNo++, b: newNo++, s: line.slice(1) }); lineCount++ }
    else if (line.startsWith('\\ No newline')) { continue }
  }
  return file
}

function normalizeGitPath(raw) {
  const trimmed = raw.replace(/\t.*$/, '').trim()
  return trimmed.replace(/^"(.*)"$/, '$1').replace(/\\\\/g, '\\').replace(/^[ab][/\\]/, '')
}

/**
 * Docs-sync detection for this monorepo's convention (workspace AGENTS.md):
 * code changes under a line root require that line's README + change log in
 * the same changeset. Returns the suspected-missing list; unknown layouts get
 * no findings rather than noise. Fleet uses docs/, the others design/CHANGELOG.
 */
export function verifyDocSync(entries) {
  const changed = new Set(entries.map(entry => entry.path.replace(/\\/g, '/')))
  const lineRoots = [
    { dir: 'dsh-miasaki-desktop/', docs: ['dsh-miasaki-desktop/README.md', 'dsh-miasaki-desktop/design/CHANGELOG.md'] },
    { dir: 'dsh-miasaki-canvas/', docs: ['dsh-miasaki-canvas/README.md', 'dsh-miasaki-canvas/design/CHANGELOG.md'] },
    { dir: 'dsh-miasaki-sidebar/', docs: ['dsh-miasaki-sidebar/README.md', 'dsh-miasaki-sidebar/design/CHANGELOG.md'] },
    { dir: 'dsh-miasaki-fleet/', docs: ['dsh-miasaki-fleet/README.md', 'dsh-miasaki-fleet/docs/'] },
  ]
  const pending = []
  for (const root of lineRoots) {
    const codeChanged = [...changed].some(path => path.startsWith(root.dir) && !/\.md$/.test(path))
    if (!codeChanged) continue
    const missing = root.docs.filter(doc => {
      if (doc.endsWith('/')) return ![...changed].some(path => path.startsWith(doc))
      return !changed.has(doc)
    })
    if (missing.length > 0) pending.push({ root: root.dir.replace(/\/$/, ''), missing })
  }
  return { pending }
}

// --- Terminal launcher (design §6.1) ---------------------------------------
// Fixed shell registry: the client may only name a key from here. No
// client-supplied executable, no shell string interpolation — every launch is
// an argv array handed to spawn(), so a hostile cwd cannot become a command.
export const TERMINAL_SHELLS = [
  { id: 'wt', label: 'Windows Terminal', bin: 'wt.exe', platform: 'win32' },
  { id: 'pwsh', label: 'PowerShell 7', bin: 'pwsh.exe', platform: 'win32' },
  { id: 'powershell', label: 'Windows PowerShell', bin: 'powershell.exe', platform: 'win32' },
  { id: 'cmd', label: '命令提示符', bin: 'cmd.exe', platform: 'win32' },
  { id: 'terminal-app', label: 'Terminal.app', bin: 'open', platform: 'darwin' },
  { id: 'x-terminal', label: 'x-terminal-emulator', bin: 'x-terminal-emulator', platform: 'linux' },
]

/** Fallback order used when the requested shell is missing: design §6.1 wt → pwsh → powershell → cmd. */
export const TERMINAL_FALLBACK_ORDER = ['wt', 'pwsh', 'powershell', 'cmd']

export function shellsForPlatform(platform = process.platform) {
  return TERMINAL_SHELLS.filter(shell => shell.platform === platform)
}

/**
 * Build the argv for one launch. Returns { bin, args } — never a command
 * string. `cwd` only ever lands in a dedicated argument slot, so quoting and
 * metacharacters are the OS's problem, not a shell's.
 */
export function terminalCommand(shellId, cwd) {
  const shell = TERMINAL_SHELLS.find(entry => entry.id === shellId)
  if (shell === undefined) throw new InputError(`未知的终端类型：${String(shellId).slice(0, 40)}`)
  if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) throw new InputError('终端工作目录必须是绝对路径')
  switch (shell.id) {
    case 'wt': return { bin: shell.bin, args: ['-d', cwd] }
    // -WorkingDirectory only applies to a new pwsh session, so keep it as the
    // first arg and hold the window open with -NoExit (a launcher window that
    // exits immediately is useless).
    case 'pwsh': return { bin: shell.bin, args: ['-NoLogo', '-NoExit', '-WorkingDirectory', cwd] }
    // Windows PowerShell 5 has no -WorkingDirectory; it inherits spawn's cwd,
    // so no path argument is needed at all (one less place a path could be
    // reinterpreted). Same for cmd: /K keeps the window open, `cd` just echoes
    // the inherited directory as confirmation.
    case 'powershell': return { bin: shell.bin, args: ['-NoLogo', '-NoExit'] }
    case 'cmd': return { bin: shell.bin, args: ['/K', 'cd'] }
    case 'terminal-app': return { bin: shell.bin, args: ['-a', 'Terminal', cwd] }
    case 'x-terminal': return { bin: shell.bin, args: ['--working-directory', cwd] }
    default: throw new InputError(`未知的终端类型：${shell.id}`)
  }
}

/**
 * Probe by PATH lookup, not by executing the shell: running `wt.exe -v` or
 * `cmd /c` to test availability flashes real windows on the user's desktop.
 * `where`/`which` exits non-zero when the name is unknown.
 */
async function probeShell(shell) {
  const [probeBin, probeArgs] = process.platform === 'win32'
    ? ['where.exe', [shell.bin]]
    : ['/usr/bin/which', [shell.bin]]
  try {
    const { stdout } = await execFileP(probeBin, probeArgs, { timeout: 4000, windowsHide: true })
    return stdout.trim() !== ''
  } catch { return false }
}

/** Available terminals for the current platform, each with an `available` flag (probe result). */
export async function terminalOptions(platform = process.platform) {
  const candidates = shellsForPlatform(platform)
  const probed = await Promise.all(candidates.map(async shell => ({
    id: shell.id,
    label: shell.label,
    bin: shell.bin,
    available: platform === process.platform ? await probeShell(shell) : false,
  })))
  const fallback = probed.find(entry => entry.available)?.id ?? null
  return { platform, shells: probed, fallback }
}

/** cwd must be an existing directory; a missing/file path is a user error, not a 500. */
async function assertDirectory(cwd) {
  let info
  try { info = await stat(cwd) } catch { throw new NotFoundError(`工作目录不存在：${cwd}`) }
  if (!info.isDirectory()) throw new InputError(`不是目录：${cwd}`)
}

/**
 * Launch a system terminal at `cwd`. Detached + unref'd so the terminal
 * outlives this request and never blocks the DSH host; a spawn error surfaces
 * as a 4xx/5xx with the shell that failed, never a silent success.
 */
export async function launchTerminal({ shellId, cwd, logger }) {
  await assertDirectory(cwd)
  const { bin, args } = terminalCommand(shellId, cwd)
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false })
    let settled = false
    child.on('error', error => {
      if (settled) return
      settled = true
      logger?.warn?.(`sidebar:terminal spawn ${bin}: ${error instanceof Error ? error.message : String(error)}`)
      if (error?.code === 'ENOENT') reject(new NotFoundError(`未安装或找不到 ${bin}`))
      else reject(new InputError(`终端启动失败：${error instanceof Error ? error.message : String(error)}`))
    })
    child.on('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolvePromise({ ok: true, shell: shellId, bin, cwd, pid: child.pid ?? null })
    })
  })
}

// --- Embedded terminal (design 2026-09-12 §4; route B — decision §6) --------
// In-panel PTY terminal: node-pty under the same argv/enum discipline as the
// launcher above, one shared session (bottom panel and right-bar tab are two
// viewers of the SAME terminal — move between them without losing state),
// scrollback replay for re-attach, and a one-shot token gate on the WS.

/** PTY-capable shells. wt.exe is a window CONTAINER, not a stream shell — never enters this table (launcher §6.1 discipline). */
export const PTY_SHELLS = [
  { id: 'pwsh', label: 'PowerShell 7', bin: 'pwsh.exe', platform: 'win32', args: ['-NoLogo'] },
  { id: 'powershell', label: 'Windows PowerShell', bin: 'powershell.exe', platform: 'win32', args: ['-NoLogo'] },
  { id: 'cmd', label: '命令提示符', bin: 'cmd.exe', platform: 'win32', args: [] },
  { id: 'bash', label: 'bash', bin: 'bash', platform: 'linux', args: [] },
  { id: 'zsh', label: 'zsh', bin: 'zsh', platform: 'darwin', args: [] },
]

export function ptyShellsForPlatform(platform = process.platform) {
  return PTY_SHELLS.filter(shell => shell.platform === platform)
}

/**
 * Resolve a shell to its ABSOLUTE path via where/which. T2 spike (2026-09-12):
 * conpty's dll path refuses bare names with `Error: File not found:` — the
 * host's own dsh-subprocess-local relies on its callers resolving first. PATH
 * lookup, never execution (launcher §6.1 discipline 4).
 */
export async function resolvePtyBin(shell) {
  const [probeBin, probeArgs] = process.platform === 'win32'
    ? ['where.exe', [shell.bin]]
    : ['/usr/bin/which', [shell.bin]]
  try {
    const { stdout } = await execFileP(probeBin, probeArgs, { timeout: 4000, windowsHide: true })
    const first = stdout.split('\n').map(l => l.trim()).find(l => l !== '')
    if (first) return first
  } catch { /* fall through */ }
  throw new NotFoundError(`未安装或找不到 ${shell.bin}`)
}

/** Cap for client-supplied pty dimensions — valid range, not a hint. */
export function clampPtySize(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** Replay buffer: append-only string chunks capped at byte length, oldest dropped whole. */
export class ScrollbackRing {
  constructor(capBytes) {
    this.capBytes = capBytes
    this.chunks = []
    this.bytes = 0
    this.dropped = false
  }

  push(text) {
    this.chunks.push(text)
    this.bytes += Buffer.byteLength(text)
    while (this.bytes > this.capBytes && this.chunks.length > 1) {
      this.bytes -= Buffer.byteLength(this.chunks[0])
      this.chunks.shift()
      this.dropped = true
    }
  }

  read() {
    return this.chunks.join('')
  }
}

/**
 * Multi-session terminal hub (2026-09-19 tabs): one pty + one replay ring per
 * session, viewers keyed by socket. Input/output/resize all carry a sessionId —
 * the single-session hub's "no address" shortcut is exactly what races two
 * tabs into one pty (ssh line U2.1 same class of bug).
 *
 * Sessions are created by an attach without a known id and killed explicitly
 * (tab close). They are never reaped behind the user's back: the pty may be
 * running something they stepped away from, so an idle session with no viewer
 * only shows up in `list()` and waits for a client to re-attach or close it.
 */
export const TERMINAL_MAX_SESSIONS = 8

export class TerminalHub {
  constructor({ replayBytes = 1024 * 1024, maxSessions = TERMINAL_MAX_SESSIONS, viewers = new Map(), logger = console, resolveBin = resolvePtyBin } = {}) {
    this.replayBytes = replayBytes
    this.maxSessions = maxSessions
    this.viewers = viewers // Map<ws, { sessionId, cols, rows }> — identity is what makes tabs safe
    this.sessions = new Map() // sessionId → session
    this.logger = logger
    this._pty = null // lazy require('node-pty')
    // Shell → absolute path. Injectable so the single-process unit tests stay
    // shell-free: the default probes PATH through `where.exe`, i.e. a child
    // process with piped stdio, which a restricted sandbox denies (spawn EPERM)
    // even though the shell is installed. Production always uses the default.
    this._resolveBin = resolveBin
  }

  _loadPty() {
    if (this._pty !== null) return this._pty
    try {
      this._pty = createRequire(import.meta.url)('node-pty')
      return this._pty
    } catch (error) {
      throw new Error(`内嵌终端依赖加载失败（node-pty）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  get(sessionId) {
    return typeof sessionId === 'string' ? this.sessions.get(sessionId) ?? null : null
  }

  /** Per-session status for the HTTP route / status frames; unknown id → idle. */
  status(sessionId) {
    const s = this.get(sessionId)
    if (s === null) return { state: 'idle' }
    return { state: s.exited ? 'exited' : 'running', id: s.id, shell: s.shell, bin: s.bin, cwd: s.cwd, pid: s.pid, exitCode: s.exitCode }
  }

  /** Every live session: what the client restores its tab bar from after a reload. */
  list() {
    return [...this.sessions.values()].map(s => ({
      id: s.id,
      shell: s.shell,
      bin: s.bin,
      cwd: s.cwd,
      pid: s.pid,
      state: s.exited ? 'exited' : 'running',
      exitCode: s.exitCode,
      viewers: this.viewerCount(s.id),
    }))
  }

  /** Route payload: the tab set plus the cap, so the client can grey out '+'. */
  snapshot() {
    return { sessions: this.list(), limit: this.maxSessions }
  }

  viewerCount(sessionId) {
    let n = 0
    for (const binding of this.viewers.values()) if (binding.sessionId === sessionId) n++
    return n
  }

  /**
   * Attach semantics, per session (design 2026-09-19 §5.5):
   * - running session + no `restart` → returns as-is, new params ignored
   *   (a live process is never killed by a parameter change; cwd moves only
   *   show a hint in the UI). Exited sessions always respawn (the [重启] path),
   *   and `restart: true` (shell change / button) kills first.
   * - unknown / absent id → brand-new session, capped by `maxSessions`.
   */
  async ensureSession({ sessionId = null, shell, cwd, cols, rows, restart = false }) {
    const existing = this.get(sessionId)
    if (existing !== null) {
      if (existing.exited || restart) {
        this._killPty(existing)
        await this._spawn(existing, shell, cwd, cols, rows)
        return { session: existing, spawned: true }
      }
      return { session: existing, spawned: false }
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new LimitError(`终端标签已达上限 ${this.maxSessions} 个，请先关闭一个再新建`)
    }
    const session = {
      id: randomUUID(),
      shell: null, bin: null, cwd: null, pid: null,
      ring: null, pty: null, exited: false, exitCode: null,
      cols: null, rows: null, createdAt: Date.now(),
    }
    await this._spawn(session, shell, cwd, cols, rows)
    this.sessions.set(session.id, session)
    return { session, spawned: true }
  }

  /** Spawn (or respawn in place) the pty for a session; a fresh ring every time. */
  async _spawn(session, shell, cwd, cols, rows) {
    const shellDef = ptyShellsForPlatform().find(entry => entry.id === shell)
    if (shellDef === undefined) throw new InputError(`未知的终端类型：${String(shell).slice(0, 40)}`)
    const bin = await this._resolveBin(shellDef)
    await assertDirectory(cwd)
    const pty = this._loadPty().spawn(bin, shellDef.args, {
      name: 'xterm-256color',
      cols: clampPtySize(cols, 16, 500, 80),
      rows: clampPtySize(rows, 4, 300, 24),
      cwd,
    })
    session.shell = shellDef.id
    session.bin = bin
    session.cwd = cwd
    session.pid = pty.pid
    session.pty = pty
    session.cols = clampPtySize(cols, 16, 500, 80)
    session.rows = clampPtySize(rows, 4, 300, 24)
    session.exited = false
    session.exitCode = null
    session.ring = new ScrollbackRing(this.replayBytes)
    pty.onData(data => {
      session.ring.push(data)
      this.broadcastTo(session.id, { type: 'output', data })
    })
    pty.onExit(({ exitCode }) => {
      session.exited = true
      session.exitCode = exitCode
      this.broadcastTo(session.id, { type: 'status', state: 'exited', code: exitCode })
    })
    this.logger?.info?.(`sidebar:terminal pty spawn ${bin} (pid ${pty.pid}) cwd ${cwd} session ${session.id}`)
  }

  /**
   * Bind a freshly attached socket to a session, then re-arbitrate its size.
   * A socket is only ever bound to ONE session — its `input` frames therefore
   * cannot reach another tab's pty.
   */
  bind(ws, session, cols, rows) {
    if (session === null || session === undefined) return
    let binding = this.viewers.get(ws)
    if (binding === undefined) {
      binding = { sessionId: null, cols: null, rows: null }
      this.viewers.set(ws, binding)
    }
    binding.sessionId = session.id
    binding.cols = clampPtySize(cols, 16, 500, 80)
    binding.rows = clampPtySize(rows, 4, 300, 24)
    this.arbitrate(session)
  }

  detach(ws) {
    const binding = this.viewers.get(ws)
    const sessionId = binding?.sessionId ?? null
    this.viewers.delete(ws)
    // 少了一个 viewer：剩下的最小尺寸可能变大，pty 该跟着放开（否则剩下的
    // 容器一直被最小的那一侧压着）。
    if (sessionId !== null) this.arbitrate(this.sessions.get(sessionId) ?? null)
  }

  /**
   * Size arbitration (design §5.4): a pty has ONE size but may be watched from
   * two containers at once (bottom panel + right tab). Take the minimum across
   * bound viewers so no viewer ever wraps early — the others just get padding.
   * Only issue `pty.resize` when the result actually changes (TUI churn).
   */
  arbitrate(session) {
    if (session === null || session.pty === null || session.exited) return
    let cols = null
    let rows = null
    for (const binding of this.viewers.values()) {
      if (binding.sessionId !== session.id) continue
      if (typeof binding.cols !== 'number' || typeof binding.rows !== 'number') continue
      cols = cols === null ? binding.cols : Math.min(cols, binding.cols)
      rows = rows === null ? binding.rows : Math.min(rows, binding.rows)
    }
    if (cols === null || rows === null) return
    if (cols === session.cols && rows === session.rows) return
    session.cols = cols
    session.rows = rows
    session.pty.resize(cols, rows)
  }

  /** Fan out to the viewers of ONE session; a backed-up socket drops the frame (T6: flood protection — terminal output is lossy by design). */
  broadcastTo(sessionId, frame) {
    const text = JSON.stringify({ v: 2, sessionId, ...frame })
    for (const [ws, binding] of this.viewers) {
      if (binding.sessionId !== sessionId) continue
      try {
        if (ws.bufferedAmount > 8 * 1024 * 1024) continue
        ws.send(text)
      } catch { /* closed sockets are reaped by their own close handler */ }
    }
  }

  write(ws, data) {
    const s = this.sessionOf(ws)
    if (s !== null && !s.exited) s.pty.write(data)
  }

  resize(ws, cols, rows) {
    const s = this.sessionOf(ws)
    if (s === null || s.exited) return
    const binding = this.viewers.get(ws)
    binding.cols = clampPtySize(cols, 16, 500, 80)
    binding.rows = clampPtySize(rows, 4, 300, 24)
    this.arbitrate(s)
  }

  sessionOf(ws) {
    const binding = this.viewers.get(ws)
    if (binding === undefined || binding.sessionId === null) return null
    return this.sessions.get(binding.sessionId) ?? null
  }

  /** Kill the pty only; the session object stays (ring + exited flag) for replay. */
  _killPty(session) {
    if (session.pty === null || session.exited) return
    try { session.pty.kill() } catch (error) { this.logger?.warn?.(`sidebar:terminal kill: ${error instanceof Error ? error.message : String(error)}`) }
  }

  /** Close a tab: kill the pty, drop the session, unbind its viewers, tell everyone. */
  close(sessionId) {
    const session = this.get(sessionId)
    if (session === null) return false
    this._killPty(session)
    this.sessions.delete(session.id)
    // 先广播后解绑：解绑之后 broadcastTo 就找不到接收者了（关闭帧会静默丢失）。
    this.broadcastTo(session.id, { type: 'closed', reason: 'user' })
    for (const binding of this.viewers.values()) if (binding.sessionId === session.id) binding.sessionId = null
    this.logger?.info?.(`sidebar:terminal session closed ${session.id}`)
    return true
  }

  dispose() {
    for (const session of [...this.sessions.values()]) this._killPty(session)
    this.sessions.clear()
  }
}

const TERMINAL_TOKEN_TTL_MS = 60_000

/** One-shot connection tokens for the terminal WS (HTTP side signs, WS side consumes, never reusable). */
export function createTokenGate({ ttlMs = TERMINAL_TOKEN_TTL_MS } = {}) {
  const pending = new Map()
  return {
    issue() {
      const now = Date.now()
      for (const [token, exp] of pending) if (exp <= now) pending.delete(token)
      const token = randomBytes(32).toString('hex')
      pending.set(token, now + ttlMs)
      return token
    },
    consume(token) {
      const exp = typeof token === 'string' ? pending.get(token) : undefined
      pending.delete(token)
      return exp !== undefined && Date.now() <= exp
    },
  }
}

/** Checklist store: one JSON per workspace (cwd hash → filename), notes keyed by file path plus two hand-checked flags. */
export class ChecklistStore {
  constructor(dir) {
    this.dir = dir
    this.serial = Promise.resolve()
    this.cache = new Map()
  }

  fileFor(cwd) {
    const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16)
    return join(this.dir, `checklist-${hash}.json`)
  }

  async load(cwd) {
    const file = this.fileFor(cwd)
    if (this.cache.has(file)) return structuredClone(this.cache.get(file))
    let state = { version: 1, updatedAt: null, notes: {}, docsSynced: false, finalMentioned: false }
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'))
      state = {
        version: 1,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
        notes: raw.notes !== null && typeof raw.notes === 'object' ? raw.notes : {},
        docsSynced: raw.docsSynced === true,
        finalMentioned: raw.finalMentioned === true,
      }
    } catch { /* 首次访问/损坏文件 → 干净清单 */ }
    this.cache.set(file, state)
    return structuredClone(state)
  }

  async patch(cwd, patch) {
    const file = this.fileFor(cwd)
    const next = await this.load(cwd)
    if (patch !== null && typeof patch === 'object') {
      if (patch.notes !== null && typeof patch.notes === 'object') {
        for (const [path, note] of Object.entries(patch.notes)) {
          const text = typeof note === 'string' ? note.trim().slice(0, 400) : ''
          if (text === '') delete next.notes[path]
          else next.notes[path] = text
        }
      }
      if (typeof patch.docsSynced === 'boolean') next.docsSynced = patch.docsSynced
      if (typeof patch.finalMentioned === 'boolean') next.finalMentioned = patch.finalMentioned
    }
    next.updatedAt = new Date().toISOString()
    await this.serial
    const writePromise = (async () => {
      await mkdir(this.dir, { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
      await rename(tmp, file)
    })()
    this.serial = writePromise.catch(error => { this.cache.delete(file); throw error })
    this.cache.set(file, next)
    await writePromise
    return structuredClone(next)
  }
}

async function readJson(req, maxBytes) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > maxBytes) throw new InputError('请求内容过大')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw new InputError('请求不是有效 JSON') }
}

/**
 * Build the `/sidebar/api` handler bound to one data directory. Route families
 * (roadmap design §2.1): review/* + terminal/* land with M1; the sidechat
 * namespace opens with its milestone.
 *
 * Exported so tests can drive the real routing layer — the cwd guard only
 * matters if a route actually reaches it, which unit-testing the helper alone
 * cannot prove.
 */
export function createApi({ dataFile, trustedHosts = [], logger = console } = {}) {
  if (typeof dataFile !== 'string' || dataFile === '') throwConfig('dataFile')
  const dataDir = dirname(dataFile)
  const checklists = new ChecklistStore(join(dataDir, 'checklists'))
  const ready = mkdir(dataDir, { recursive: true }).then(() => undefined, error => {
    logger?.warn?.(new Error(`sidebar: data directory unavailable (${error instanceof Error ? error.message : String(error)})`))
  })
  const trusted = trustedHostSet({ trustedHosts })
  // Embedded-terminal state lives with the API surface: the HTTP routes sign
  // tokens and read hub status, the WS upgrade (registered in apply()) drives
  // the hub. Attached to the handler function so apply() can reach both
  // without changing createApi's call shape (tests use it as a bare handler).
  const hub = new TerminalHub({ logger })
  const tokens = createTokenGate()
  const handler = async (req, res) => {
    try {
      // Browser-trust fence, layers 1–3 (see fenceRequest above; the WS upgrade
      // runs the same function before any socket is handed to the hub).
      const fence = fenceRequest(req.headers, trusted)
      if (!fence.ok) return sendJson(res, fence.status, { error: fence.error })
      // Browser CORS preflight (OPTIONS): the DSH /api prefix does not emit
      // CORS headers, so the sidebar API answers its own.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, x-dsh-token',
          'access-control-max-age': '600',
        })
        res.end()
        return
      }
      const path = new URL(req.url ?? '/', 'http://dsh.local').pathname
      if (path === '/sidebar/api/health') {
        await ready
        return sendJson(res, 200, { ok: true, plugin: 'sidebar', version: PLUGIN_VERSION })
      }
      if (path === '/sidebar/api/review/status' && req.method === 'GET') {
        const params = new URL(req.url, 'http://dsh.local').searchParams
        const cwd = resolveWorkdir(params.get('cwd'))
        // No `view` keeps the pre-v0.5 behaviour (full working tree vs HEAD);
        // the client always sends an explicit view.
        const view = params.get('view') ?? 'all'
        if (!REVIEW_VIEWS.includes(view)) throw new InputError(`未知的审查视图：${String(view).slice(0, 20)}`)
        const status = await reviewStatus(cwd, { view, logger })
        return sendJson(res, 200, { status, docSync: verifyDocSync(status.entries) })
      }
      if (path === '/sidebar/api/review/diff' && req.method === 'POST') {
        const body = await readJson(req, 64 * 1024)
        const cwd = resolveWorkdir(body.cwd)
        const rel = typeof body.path === 'string' ? body.path.trim() : ''
        if (rel === '' || rel.includes('..') || /^([A-Za-z]:)?[/\\]/.test(rel)) throw new InputError('文件路径必须是仓库内相对路径')
        // The view the LIST was computed with decides the detail baseline
        // (design 2026-09-12 §3.1). Missing view keeps pre-0.7 behaviour
        // (working tree vs HEAD) for any older client still calling.
        const view = body.view === undefined || body.view === null || body.view === '' ? 'all' : body.view
        if (typeof view !== 'string' || !REVIEW_VIEWS.includes(view)) throw new InputError(`未知的审查视图：${String(view).slice(0, 20)}`)
        // Optional pre-rename path, same constraints as `path`.
        const from = typeof body.from === 'string' ? body.from.trim() : ''
        if (from !== '' && (from.includes('..') || /^([A-Za-z]:)?[/\\]/.test(from))) throw new InputError('from 必须是仓库内相对路径')
        const context = normalizeDiffContext(body.context)
        const { text, baseline } = await diffForView(cwd, rel, { view, from: from === '' ? null : from, context })
        return sendJson(res, 200, { diff: parseUnifiedDiff(text), baseline, view })
      }
      if (path === '/sidebar/api/review/checklist' && req.method === 'GET') {
        const cwd = resolveWorkdir(new URL(req.url, 'http://dsh.local').searchParams.get('cwd'))
        return sendJson(res, 200, { checklist: await checklists.load(cwd) })
      }
      if (path === '/sidebar/api/review/checklist' && req.method === 'POST') {
        const body = await readJson(req, CHECKLIST_PATCH_MAX_BYTES)
        const cwd = resolveWorkdir(body.cwd)
        return sendJson(res, 200, { checklist: await checklists.patch(cwd, body.patch ?? null) })
      }
      // --- terminal launcher (design §6.1) ---
      if (path === '/sidebar/api/terminal/options' && req.method === 'GET') {
        return sendJson(res, 200, await terminalOptions())
      }
      if (path === '/sidebar/api/terminal/open' && req.method === 'POST') {
        const body = await readJson(req, 8 * 1024)
        const cwd = resolveWorkdir(body.cwd)
        const shellId = typeof body.shell === 'string' ? body.shell.trim() : ''
        // Enum-only: an unknown id never reaches spawn (terminalCommand throws).
        const result = await launchTerminal({ shellId, cwd, logger })
        return sendJson(res, 200, result)
      }
      // One-shot WS token for the embedded terminal (design §4.4): signed over
      // the fenced HTTP surface, consumed once at upgrade, 60s TTL.
      if (path === '/sidebar/api/terminal/token' && req.method === 'POST') {
        return sendJson(res, 200, { token: tokens.issue(), ttlMs: TERMINAL_TOKEN_TTL_MS })
      }
      // Tab set snapshot (2026-09-19): what the client rebuilds its tab bar from
      // after a reload, so a host-side pty that survived the page is never orphaned.
      if (path === '/sidebar/api/terminal/session' && req.method === 'GET') {
        return sendJson(res, 200, hub.snapshot())
      }
      // Close one session without holding a socket to it (orphan cleanup path;
      // the WS `close` frame is the in-app equivalent).
      if (path === '/sidebar/api/terminal/close' && req.method === 'POST') {
        const body = await readJson(req, 8 * 1024)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const closed = hub.close(sessionId)
        return sendJson(res, 200, { closed })
      }
      return sendJson(res, 404, { error: '接口不存在' })
    } catch (error) {
      if (error instanceof InputError) return sendJson(res, 400, { error: error.message })
      if (error instanceof NotFoundError) return sendJson(res, 404, { error: error.message })
      logger?.error?.(error instanceof Error ? error : new Error(String(error)))
      return sendJson(res, 500, { error: 'sidebar 数据暂时不可用' })
    }
  }
  handler.hub = hub
  handler.tokens = tokens
  handler.trusted = trusted
  return handler
}

/** Mount the sidebar host half on the existing DSH Web Server. */
export function apply(ctx, config) {
  const api = createApi({ dataFile: config?.dataFile, trustedHosts: config?.trustedHosts ?? [], logger: ctx.logger })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/sidebar/api', handler: api }), 'sidebar: api')
  wireEmbeddedTerminal(ctx, api)
}

/** Serve a dependency-resolved static file once, then from an in-memory cache (ssh line's shape). */
function cachedAsset(url, contentType) {
  let cache = null
  return async (_req, res) => {
    if (cache === null) {
      try { cache = await readFile(new URL(url, import.meta.url)) } catch { cache = false }
    }
    if (cache === false) return sendJson(res, 404, { error: '静态资源缺失（依赖未随插件安装）' })
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
    res.end(cache)
  }
}

/**
 * Embedded terminal wiring: xterm assets + the `/sidebar/ws/terminal` upgrade.
 * `ws` loads lazily — if the dependency did not survive the install/copy, the
 * plugin logs a warning and keeps every other feature (the review tab must
 * never die with the terminal), matching the hub's lazy node-pty load.
 */
function wireEmbeddedTerminal(ctx, api) {
  const xtermAsset = cachedAsset('./node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8')
  const xtermCssAsset = cachedAsset('./node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8')
  const fitAsset = cachedAsset('./node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/sidebar/asset/terminal/xterm.js', handler: xtermAsset }), 'sidebar: xterm asset')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/sidebar/asset/terminal/xterm.css', handler: xtermCssAsset }), 'sidebar: xterm css asset')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/sidebar/asset/terminal/addon-fit.js', handler: fitAsset }), 'sidebar: xterm fit asset')

  let WebSocketServer
  try {
    WebSocketServer = createRequire(import.meta.url)('ws').WebSocketServer
  } catch (error) {
    ctx.logger?.warn?.(`sidebar: embedded terminal disabled — ws dependency unavailable (${error instanceof Error ? error.message : String(error)})`)
    return
  }

  const MAX_WS_FRAME_BYTES = 256 * 1024 // input/resize frames are tiny; anything bigger is abuse
  const wss = new WebSocketServer({ noServer: true })
  const hub = api.hub

  wss.on('connection', (ws, req) => {
    void req
    // One socket = one session binding (2026-09-19 tabs). Without this identity a
    // second tab's input/resize would land in the first tab's pty.
    hub.viewers.set(ws, { sessionId: null, cols: null, rows: null })
    ws.on('message', data => {
      if (data.length > MAX_WS_FRAME_BYTES) return
      let msg
      try { msg = JSON.parse(String(data)) } catch { return }
      // Frame protocol v2: a frame without `v:2` comes from a stale bundle —
      // reject it instead of maintaining a dual stack (ssh line U2.1 discipline).
      if (msg.v !== 2) {
        try {
          ws.send(JSON.stringify({
            v: 2, type: 'error', sessionId: null, code: 'VERSION_MISMATCH',
            message: '终端协议已升级，请刷新页面后重试',
          }))
        } catch { /* closed */ }
        return
      }
      const sid = typeof msg.sessionId === 'string' ? msg.sessionId : null
      if (msg.type === 'attach') {
        // attach: { sessionId?, shell, cwd, cols, rows, restart? } — spawn or
        // re-attach one session, then replay its ring.
        const cols = clampPtySize(msg.cols, 16, 500, 80)
        const rows = clampPtySize(msg.rows, 4, 300, 24)
        Promise.resolve()
          .then(() => ensureAttached(ws, msg, cols, rows))
          .catch(error => {
            const message = error instanceof InputError || error instanceof NotFoundError || error instanceof LimitError
              ? error.message
              : `内嵌终端启动失败：${error instanceof Error ? error.message : String(error)}`
            try {
              ws.send(JSON.stringify({ v: 2, type: 'error', sessionId: sid, code: 'SPAWN_FAILED', message }))
            } catch { /* closed */ }
          })
      } else if (msg.type === 'input' && typeof msg.data === 'string') {
        hub.write(ws, msg.data)
      } else if (msg.type === 'resize') {
        hub.resize(ws, msg.cols, msg.rows)
      } else if (msg.type === 'close') {
        // Tab close: kill the pty, drop the session, tell every viewer of it.
        hub.close(sid)
      }
      // `detach` needs no frame: the pty outlives viewers by design (§4.3) and
      // socket close already drops the binding. Hiding the panel or switching
      // tabs simply closes the socket.
    })
    const drop = () => { hub.detach(ws) }
    ws.on('close', drop)
    ws.on('error', drop)
  })

  async function ensureAttached(ws, msg, cols, rows) {
    const cwd = resolveWorkdir(msg.cwd)
    const { session, spawned } = await hub.ensureSession({
      sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null,
      shell: typeof msg.shell === 'string' ? msg.shell : '',
      cwd,
      cols,
      rows,
      restart: msg.restart === true,
    })
    hub.bind(ws, session, cols, rows)
    const ready = { type: 'ready', shell: session.shell, bin: session.bin, pid: session.pid, cwd: session.cwd, spawned, cols: session.cols, rows: session.rows }
    try { ws.send(JSON.stringify({ v: 2, sessionId: session.id, ...ready })) } catch { return }
    const replay = session.ring.read()
    if (replay !== '') {
      try { ws.send(JSON.stringify({ v: 2, sessionId: session.id, type: 'replay', data: replay })) } catch { return }
    }
    if (session.exited) {
      try { ws.send(JSON.stringify({ v: 2, sessionId: session.id, type: 'status', state: 'exited', code: session.exitCode })) } catch { /* closed */ }
    }
  }

  const pingTimer = setInterval(() => {
    for (const ws of hub.viewers.keys()) { try { ws.ping() } catch { hub.detach(ws) } }
  }, 30_000)

  // WS upgrade gate: browser-trust fence, then the one-shot token, then the socket.
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/sidebar/ws/terminal',
    handler: (req, socket, head) => {
      const fence = fenceRequest(req.headers, api.trusted)
      if (!fence.ok) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return }
      let token = null
      try { token = new URL(req.url ?? '/', 'http://dsh.local').searchParams.get('token') } catch { token = null }
      if (!api.tokens.consume(token)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
    },
  }), 'sidebar: terminal websocket')

  ctx.effect(() => () => {
    clearInterval(pingTimer)
    for (const ws of hub.viewers.keys()) { try { ws.terminate() } catch { /* noop */ } }
    hub.viewers.clear()
    hub.dispose()
  }, 'sidebar: terminal lifecycle')
}

function throwConfig(key) {
  throw new Error(`sidebar: config.${key} must be a non-empty path`)
}
