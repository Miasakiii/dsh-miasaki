// SFTP 传输层（U2.2，design/2026-09-26-ssh-zcode-benchmark-plan.md §4-P0-2）。
// 大框架沿用 U2 规划 §4.2：REST 流式 + host 端零本机 IO；本文件补上对标 zcode 的降级链：
//
//  1. SFTP → exec pipe 降级：某些网关 / 跳板 SSH 把 exec 与 SFTP 落到不同的文件系统
//     视图 —— `mkdir -p`（shell 视图）成功，SFTP 往同一路径写却报 NO_SUCH_FILE。
//     不降级就会把「网关不支持 SFTP 直写」误判成路径错误（zcode ssh-backend.ts 同款教训）。
//  2. 单次 HTTP 请求的源流不可回放 ⇒ 降级触发点限定在「一个字节都没送上之前」
//     （会话打不开 / 目标目录在 sftp 视图中不存在）；已开始传输后的失败只结构化报错，
//     由调用方把连接标记为 execOnly，下一次尝试直接走 exec。
//  3. 进度节流 1s / 5% / 终点（zcode sshUploadProgress.ts 同款）；失败瞬间停两端流，
//     不刷虚假进度；AbortSignal 取消语义一致。
import { quotePosixShellArg, buildPosixShellExecCommand } from './exec.js'
import { SFTP_PROGRESS_INTERVAL_MS, SFTP_PROGRESS_PERCENT_STEP, SFTP_OP_TIMEOUT_MS } from './limits.js'

// ssh2 SFTP status code → 可读标签（zcode 同款词汇表：数字 code 对排障者无意义）。
const SFTP_STATUS_LABELS = {
  0: 'OK', 1: 'EOF', 2: 'NO_SUCH_FILE', 3: 'PERMISSION_DENIED', 4: 'FAILURE',
  5: 'BAD_MESSAGE', 6: 'NO_CONNECTION', 7: 'CONNECTION_LOST', 8: 'OP_UNSUPPORTED',
}

export function sftpStatusLabel(code) {
  if (typeof code !== 'number') return null
  return SFTP_STATUS_LABELS[code] ?? `UNKNOWN(${code})`
}

/** 把 SFTP 数字 code 的错误文案收成「标签 + 原句」。 */
export function formatSftpError(error) {
  const code = error?.code
  const label = sftpStatusLabel(typeof code === 'number' ? code : undefined)
  const message = String(error?.message ?? error ?? '')
  return label !== null ? `${label}(${label === message ? '' : message})` : message
}

/** sftp-session / sftp-write 两类是「通道能力缺失」，可降级；其余（权限等）不降级。 */
export function isSftpCapabilityFailure(error) {
  const kind = error?.uploadFailureKind
  return kind === 'sftp-session' || kind === 'sftp-write'
}

function markFailure(error, kind, fallbackMessage) {
  const normalized = error instanceof Error ? error : new Error(String(error?.message ?? error ?? fallbackMessage))
  normalized.uploadFailureKind = kind
  return normalized
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message ?? `SFTP 操作超时（${timeoutMs}ms）`)), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * 进度节流 reporter（zcode 同款口径）：1s 或 5% 或到达终点才回调；force 时去重。
 * @returns {(transferredBytes: number, opts?: {force?: boolean}) => void}
 */
export function createProgressReporter({ onProgress, totalBytes, intervalMs = SFTP_PROGRESS_INTERVAL_MS, percentStep = SFTP_PROGRESS_PERCENT_STEP, now = Date.now } = {}) {
  const startedAt = now()
  let lastAt = 0
  let lastPercent = 0
  let lastBytes = -1
  return (transferredBytes, { force = false } = {}) => {
    if (typeof onProgress !== 'function') return
    const at = now()
    const percent = typeof totalBytes === 'number' && totalBytes > 0
      ? Math.min((transferredBytes / totalBytes) * 100, 100)
      : null
    const byInterval = at - lastAt >= intervalMs
    const byPercent = percent !== null && percent - lastPercent >= percentStep
    const reachedEnd = percent !== null && percent >= 100
    if (!force && !byInterval && !byPercent && !reachedEnd) return
    if (force && transferredBytes === lastBytes && (percent === null || percent <= lastPercent)) return
    lastAt = at
    lastBytes = transferredBytes
    if (percent !== null) lastPercent = percent
    const elapsedSeconds = Math.max((at - startedAt) / 1000, 0.001)
    onProgress({
      transferredBytes,
      totalBytes: totalBytes ?? null,
      percent,
      bytesPerSecond: Math.round(transferredBytes / elapsedSeconds),
    })
  }
}

// ---------------------------------------------------------------------------
// 会话与路径事实

/** 惰性打开（按连接缓存由调用方负责）一个 SFTP 会话；失败带 sftp-session 标记。 */
export function openSftpSession(client, { timeoutMs = SFTP_OP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    // 超时计时器必须随收尾清除：否则测试进程（与 host 的事件循环）被空挂的 timer 拖住。
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(markFailure(new Error('SFTP 会话打开超时'), 'sftp-session', 'SFTP session open timed out'))
    }, timeoutMs)
    timer.unref?.()
    const settle = fn => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    try {
      client.sftp((err, sftp) => {
        if (err !== null && err !== undefined) {
          settle(() => reject(markFailure(err, 'sftp-session', 'Failed to open SFTP session')))
          return
        }
        sftp.on('error', () => { /* 单项操作的错误由各 Promise 自己收；这里防 uncaught */ })
        settle(() => resolve(sftp))
      })
    } catch (error) {
      // client.sftp 在 socket 已断时同步抛 'Not connected'
      settle(() => reject(markFailure(error, 'sftp-session', 'Failed to open SFTP session')))
    }
  })
}

/** 远端 home：SFTP realpath('.')；失败回落 '/'（不猜、不写死）。 */
export async function resolveRemoteHome(sftp) {
  try {
    const resolved = await withTimeout(new Promise((resolve, reject) => {
      sftp.realpath('.', (err, path) => (err ? reject(err) : resolve(path)))
    }), SFTP_OP_TIMEOUT_MS)
    return typeof resolved === 'string' && resolved.startsWith('/') ? resolved : '/'
  } catch {
    return '/'
  }
}

// ---------------------------------------------------------------------------
// 操作（ssh2 SFTPWrapper 形状；测试替身同形）

function entryType(attrs, name) {
  if (attrs?.isDirectory?.() === true) return 'dir'
  if (attrs?.isSymbolicLink?.() === true) return 'link'
  if (attrs?.isFile?.() === true) return 'file'
  return 'other'
}

export async function listDirectory(sftp, dirPath, { timeoutMs = SFTP_OP_TIMEOUT_MS } = {}) {
  const entries = await withTimeout(new Promise((resolve, reject) => {
    sftp.readdir(dirPath, (err, list) => (err ? reject(err) : resolve(list)))
  }), timeoutMs)
  return entries.map(item => {
    const attrs = item.attrs ?? {}
    const entry = {
      name: String(item.filename ?? ''),
      type: entryType(attrs),
      size: typeof attrs.size === 'number' ? attrs.size : null,
      mtime: typeof attrs.mtime === 'number' ? attrs.mtime * 1000 : null,
      mode: typeof attrs.mode === 'number' ? attrs.mode : null,
    }
    if (entry.name === '.' || entry.name === '..') entry.type = 'other'
    return entry
  }).filter(entry => entry.name !== '.' && entry.name !== '..')
}

export async function statRemote(sftp, path, { timeoutMs = SFTP_OP_TIMEOUT_MS } = {}) {
  const stats = await withTimeout(new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => (err ? reject(err) : resolve(stats)))
  }), timeoutMs)
  return {
    path,
    type: entryType(stats),
    size: typeof stats.size === 'number' ? stats.size : null,
    mtime: typeof stats.mtime === 'number' ? stats.mtime * 1000 : null,
    mode: typeof stats.mode === 'number' ? stats.mode : null,
  }
}

export async function makeDir(sftp, path, { timeoutMs = SFTP_OP_TIMEOUT_MS } = {}) {
  return withTimeout(new Promise((resolve, reject) => {
    sftp.mkdir(path, err => (err ? reject(err) : resolve()))
  }), timeoutMs)
}

export async function renameRemote(sftp, from, to, { timeoutMs = SFTP_OP_TIMEOUT_MS } = {}) {
  return withTimeout(new Promise((resolve, reject) => {
    sftp.rename(from, to, err => (err ? reject(err) : resolve()))
  }), timeoutMs)
}

export async function removeFile(sftp, path, { timeoutMs = SFTP_OP_TIMEOUT_MS } = {}) {
  return withTimeout(new Promise((resolve, reject) => {
    sftp.unlink(path, err => (err ? reject(err) : resolve()))
  }), timeoutMs)
}

export async function removeDir(sftp, path, { timeoutMs = SFTP_OP_TIMEOUT_MS } = {}) {
  return withTimeout(new Promise((resolve, reject) => {
    sftp.rmdir(path, err => (err ? reject(err) : resolve()))
  }), timeoutMs)
}

// ---------------------------------------------------------------------------
// 流式传输

/** 停止两端流（zcode 同款：失败瞬间不停，本地流会继续读到 100% 刷虚假进度）。 */
function destroyQuietly(stream) {
  try { stream?.destroy?.() } catch { /* already gone */ }
}

export async function downloadToWritable(sftp, path, writable, { signal, onProgress, totalBytes } = {}) {
  const report = createProgressReporter({ onProgress, totalBytes })
  const readStream = sftp.createReadStream(path)
  let transferred = 0
  let settled = false
  const abortOnce = () => { destroyQuietly(readStream) }
  signal?.addEventListener('abort', abortOnce, { once: true })

  return new Promise((resolve, reject) => {
    const done = patch => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abortOnce)
      if (patch?.error !== undefined) { destroyQuietly(readStream); reject(patch.error) }
      else { report(transferred, { force: true }); resolve({ transferredBytes: transferred }) }
    }
    readStream.on('data', chunk => {
      transferred += chunk.length
      report(transferred)
    })
    readStream.on('error', error => done({ error: markFailure(error, 'sftp-read', `Failed to read ${path} over SFTP`) }))
    readStream.on('close', () => done())
    writable.on('error', error => done({ error }))
    readStream.pipe(writable)
    if (signal?.aborted === true) abortOnce()
  })
}

/**
 * SFTP 上传（前提：调用方已确认目录在 sftp 视图中存在 —— 见 uploadResilient）。
 * 失败统一带 uploadFailureKind；调用方据此决定是否降级 / 标记 execOnly。
 */
export async function uploadFromReadable(sftp, path, source, { signal, onProgress, size, overwrite } = {}) {
  if (overwrite !== true) {
    // 覆盖前存在性检查（零字节消耗）。NO_SUCH_FILE 是上传前的正常状态直接放行；
    // 其余 stat 错误（权限等）如实抛 —— 不能把「探不到」当成「不存在」而覆盖。
    const existing = await new Promise((resolve, reject) => {
      sftp.stat(path, (err, stats) => {
        if (err !== null && err !== undefined) {
          if (sftpStatusLabel(err.code) === 'NO_SUCH_FILE') { resolve(null); return }
          reject(err)
          return
        }
        resolve(stats)
      })
    })
    if (existing !== null) {
      const error = new Error('目标已存在')
      error.code = 'TARGET_EXISTS'
      throw error
    }
  }
  const writeStream = sftp.createWriteStream(path)
  const report = createProgressReporter({ onProgress, totalBytes: size })
  let transferred = 0
  let settled = false
  return new Promise((resolve, reject) => {
    const abortOnce = () => { destroyQuietly(source); destroyQuietly(writeStream) }
    const finish = error => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abortOnce)
      if (error !== undefined) {
        destroyQuietly(source)
        destroyQuietly(writeStream)
        reject(markFailure(error, 'sftp-write', `Failed to write ${path} over SFTP`))
        return
      }
      report(transferred, { force: true })
      resolve({ transferredBytes: transferred })
    }
    signal?.addEventListener('abort', abortOnce, { once: true })
    source.on?.('data', chunk => { transferred += chunk.length; report(transferred) })
    writeStream.on('close', () => finish())
    writeStream.on('error', error => finish(error))
    source.on?.('error', error => finish(error))
    // 源流暂停后 pipe 不会预取数据 ⇒ 早失败窗口内一个字节都不会送上远端
    source.pause?.()
    source.pipe(writeStream)
    source.resume?.()
    if (signal?.aborted === true) abortOnce()
  })
}

/**
 * zcode 降级链的 exec pipe 段：`mkdir -p <dir> && cat > <path>`，本地流 pipe 进 stdin。
 * 通道形状：{ stdin: Writable, onClose(cb): () => void }（ssh2 channel 的适配由调用方包）。
 * 只有在源流未被消耗过时才会走到这里（见 uploadResilient 的前置判定）。
 */
export async function uploadViaExecPipe({ openExec, path, source, signal, onProgress }) {
  const dir = posixDirname(path)
  const command = `mkdir -p ${quotePosixShellArg(dir)} && cat > ${quotePosixShellArg(path)}`
  const channel = await openExec(command)
  const report = createProgressReporter({ onProgress, totalBytes: null })
  let transferred = 0
  let settled = false
  return new Promise((resolve, reject) => {
    const abortOnce = () => {
      destroyQuietly(source)
      try { channel.stdin?.destroy?.() } catch { /* gone */ }
    }
    const finish = error => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abortOnce)
      if (error !== undefined) {
        destroyQuietly(source)
        reject(error)
        return
      }
      report(transferred, { force: true })
      resolve({ transferredBytes: transferred, transport: 'exec' })
    }
    signal?.addEventListener('abort', abortOnce, { once: true })
    source.on?.('data', chunk => { transferred += chunk.length; report(transferred) })
    source.on?.('error', error => finish(error))
    channel.stdin?.on?.('error', error => finish(error))
    channel.onClose(code => {
      if (code === 0) finish()
      else finish(new Error(`SSH exec 上传失败：远端 exit code ${code}`))
    })
    source.pipe(channel.stdin)
    if (signal?.aborted === true) abortOnce()
  })
}

/**
 * 带降级链的上传编排（REST 层唯一入口）：
 *   ① overwrite=false 时先 stat 目标（零字节消耗）；NO_SUCH_FILE 是正常放行，
 *      其余 stat 错误如实抛
 *   ② 目标目录 sftp 视图探测：视图里不存在 ⇒ 直接 exec 降级（源流未被消费）
 *   ③ sftp 上传；mid-stream 失败抛结构化错误（调用方标记 execOnly，下次直接走 exec）
 * 另：sftp 会话打不开（④）由调用方在进入本函数前处理 —— 同样降级 exec。
 * @returns {Promise<{transport: 'sftp'|'exec', transferredBytes: number}>}
 */
export async function uploadResilient({
  sftp, path, source, signal, onProgress, size, overwrite,
  openExec,
}) {
  if (overwrite !== true) {
    const existing = await new Promise((resolve, reject) => {
      sftp.stat(path, (err, stats) => {
        if (err !== null && err !== undefined) {
          if (sftpStatusLabel(err.code) === 'NO_SUCH_FILE') { resolve(null); return }
          reject(err)
          return
        }
        resolve(stats)
      })
    })
    if (existing !== null) {
      const error = new Error('目标已存在')
      error.code = 'TARGET_EXISTS'
      throw error
    }
  }
  // ② 目录视图探测：dirname 在 sftp 视图不存在 ⇒ 这台机器的 gateway 把两个视图分开了
  // （或目录真不存在）—— 两条都该走 exec：mkdir -p 能把目录建出来并直接写。
  let dirVisible = true
  try {
    await statRemote(sftp, posixDirname(path))
  } catch (error) {
    if (isSftpCapabilityFailure(error) || sftpStatusLabel(error?.code) === 'NO_SUCH_FILE') {
      dirVisible = false
    } else {
      throw error // 权限等真实错误不降级，如实报
    }
  }
  if (!dirVisible) {
    return uploadViaExecPipe({ openExec, path, source, signal, onProgress })
  }
  // ③ sftp 主路径：失败原样上抛（带 uploadFailureKind），降级与否由调用方的
  // execOnly 记忆决定 —— 单次 HTTP 请求的源流不可回放，mid-stream 不就地降级。
  const result = await uploadFromReadable(sftp, path, source, { signal, onProgress, size, overwrite: true })
  return { ...result, transport: 'sftp' }
}

/** POSIX dirname（远端路径恒为 POSIX；不用 node:path —— Windows 上会给出反斜杠语义）。 */
export function posixDirname(path) {
  const text = String(path ?? '')
  const index = text.lastIndexOf('/')
  if (index < 0) return '/'
  if (index === 0) return '/'
  return text.slice(0, index)
}

/** exec 通道工厂（ssh2）：包装一层供 uploadViaExecPipe 使用。 */
export function ssh2ExecOpener(client) {
  return command => new Promise((resolve, reject) => {
    client.exec(buildPosixShellExecCommand(command), (err, channel) => {
      if (err) { reject(err); return }
      resolve({
        stdin: channel.stdin,
        onClose(cb) {
          let code = null
          channel.on('exit', c => { code = c ?? 0 })
          channel.on('close', () => cb(code ?? 0))
        },
      })
    })
  })
}
