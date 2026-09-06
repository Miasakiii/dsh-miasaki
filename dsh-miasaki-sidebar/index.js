import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

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
const GIT_BIN = 'C:\\Program Files\\Git\\cmd\\git.exe'
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

/** Host/host:port fence for the /sidebar API (mirrors the canvas plugin): the DSH /api browser-trust fence does not cover plugin routes. */
function trustedHostSet(config) {
  return new Set(['localhost', '127.0.0.1', ...[...(config?.trustedHosts ?? [])].map(host => String(host).trim().toLowerCase()).filter(Boolean)])
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Validate a client-supplied cwd: absolute, resolvable, a real directory. spawn args never touch a shell, so the only injection surface is a bogus path. */
function resolveWorkdir(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new InputError('需要工作区的绝对路径')
  const cwd = resolve(raw)
  if (!isAbsolute(cwd)) throw new InputError('需要工作区的绝对路径')
  return cwd
}

class InputError extends Error {}
class NotFoundError extends Error {}

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

/** One reviewed working tree: branch, short HEAD, and `git status --short --untracked-files=all` entries (XY + path). */
async function diffForFile(cwd, rel, cached) {
  // staged diff is always the simple case
  if (cached) return runGit(cwd, ['diff', '--cached', '--', rel])
  // untracked files produce no output from `git diff HEAD`; use --no-index to
  // render the full file as additions (the review tab treats new files as
  // "all added").
  const isTracked = await runGit(cwd, ['ls-files', '--error-unmatch', rel]).then(() => true, () => false)
  if (!isTracked) {
    const abs = join(cwd, rel)
    // `git diff --no-index` exits 1 when files differ (not an error for us);
    // capture stdout from both the success and error paths.
    const noIndex = await runGit(cwd, ['diff', '--no-index', NULL_DEVICE, abs]).catch(error => {
      return typeof error?.stdout === 'string' ? error.stdout : ''
    })
    // strip the /dev/null header line to keep the parser happy
    return noIndex.replace(new RegExp('^diff --git a/' + NULL_DEVICE.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + ' b/[^\\n]+\\n'), '')
  }
  return runGit(cwd, ['diff', 'HEAD', '--', rel])
}

async function reviewStatus(cwd) {
  const maybe = args => runGit(cwd, args).catch(error => {
    ctx.logger.warn(`sidebar:review status ${args.join(' ')}: ${error instanceof Error ? error.message : String(error)}`)
    return ''
  })
  const [branch, head, statusText] = await Promise.all([
    maybe(['branch', '--show-current']),
    maybe(['rev-parse', '--short', 'HEAD']),
    maybe(['status', '--short', '--untracked-files=all']),
  ])
  const lines = (statusText || '').split('\n').filter(line => line.length >= 3 && line.trim() !== '')
  const truncated = lines.length > STATUS_MAX_ENTRIES
  const entries = lines.slice(0, STATUS_MAX_ENTRIES).map(line => ({ xy: line.slice(0, 2), path: renameTarget(line.slice(3)) }))
  function renameTarget(raw) { const arrow = raw.indexOf(' -> '); return arrow === -1 ? raw : raw.slice(arrow + 4) }
  return { branch, head, entries, truncated, total: lines.length }
}

/**
 * Minimal unified-diff parser: file header (---/+++/index), hunk headers, and
 * per-line { t: add|del|ctx, a, b, s } with tracked old/new line numbers.
 * M1 scope: single-file diffs only (the review tab requests one file at a
 * time); renames/binary show as meta lines. No diff library — the shapes we
 * render are exactly these three line kinds plus hunk boundaries.
 */
export function parseUnifiedDiff(text) {
  const lines = text.split('\n')
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
      hunk = { oldStart: oldNo, newStart: newNo, lines: [] }
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
 * Mount the sidebar host half on the existing DSH Web Server. Route families
 * (roadmap design §2.1): review/* lands with the M1 review tab; terminal and
 * sidechat namespaces open with their milestones.
 */
export function apply(ctx, config) {
  const dataFile = typeof config?.dataFile === 'string' && config.dataFile !== ''
    ? config.dataFile
    : throwConfig('dataFile')
  const dataDir = dirname(dataFile)
  const checklists = new ChecklistStore(join(dataDir, 'checklists'))
  const ready = mkdir(dataDir, { recursive: true }).then(() => undefined, error => {
    ctx.logger.warn(new Error(`sidebar: data directory unavailable (${error instanceof Error ? error.message : String(error)})`))
  })
  const trustedHosts = trustedHostSet(config)
  const api = async (req, res) => {
    try {
      const hostname = (typeof req.headers.host === 'string' ? req.headers.host : '').replace(/:\d+$/, '').toLowerCase()
      if (!trustedHosts.has(hostname)) return sendJson(res, 403, { error: '不被信任的 Host' })
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
        return sendJson(res, 200, { ok: true, plugin: 'sidebar', version: '0.2.0-miasaki.1' })
      }
      if (path === '/sidebar/api/review/status' && req.method === 'GET') {
        const cwd = resolveWorkdir(new URL(req.url, 'http://dsh.local').searchParams.get('cwd'))
        const status = await reviewStatus(cwd)
        return sendJson(res, 200, { status, docSync: verifyDocSync(status.entries) })
      }
      if (path === '/sidebar/api/review/diff' && req.method === 'POST') {
        const body = await readJson(req, 64 * 1024)
        const cwd = resolveWorkdir(body.cwd)
        const rel = typeof body.path === 'string' ? body.path.trim() : ''
        if (rel === '' || rel.includes('..') || /^([A-Za-z]:)?[/\\]/.test(rel)) throw new InputError('文件路径必须是仓库内相对路径')
        const cached = body.cached === true
        const text = await diffForFile(cwd, rel, cached)
        return sendJson(res, 200, { diff: parseUnifiedDiff(text) })
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
      return sendJson(res, 404, { error: '接口不存在' })
    } catch (error) {
      if (error instanceof InputError) return sendJson(res, 400, { error: error.message })
      if (error instanceof NotFoundError) return sendJson(res, 404, { error: error.message })
      ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
      return sendJson(res, 500, { error: 'sidebar 数据暂时不可用' })
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/sidebar/api', handler: api }), 'sidebar: api')
}

function throwConfig(key) {
  throw new Error(`sidebar: config.${key} must be a non-empty path`)
}
