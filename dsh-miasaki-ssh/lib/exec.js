// exec 通道前置（P0-3，对标 zcode packages/server/src/remote/ssh-backend.ts 与 handshake.ts，
// 见 design/2026-09-26-ssh-zcode-benchmark-plan.md §4-P0-3）。
//
// 三条用教训换来的口径，一次固化，供 A1 `ssh_exec` 与 SFTP 的 exec 降级链共用：
//  1. POSIX 包装：SSH exec 先交给远端用户的默认 shell，fish 会把 `download=` 这类
//     POSIX 语法当错误 ⇒ 一律包一层 `/bin/sh -c`，保证任何默认 shell 下语义一致。
//  2. 收尾协议：ssh2 短命令可能先发 `exit` 再异步派发 stdout `data`，只在 `close`
//     统一收尾、优先用 `exit` 记录的退出码；`close` 之后再给 50ms 排空窗口，
//     迟到数据照样收进 stdout（zcode execSimple / preflight 同款）。
//  3. banner/motd 跳过：远端 shell profile（.bashrc/.zshrc 里的 echo）会在协议输出
//     前打印欢迎行 ⇒ 协议行扫描按行推进，非协议行原样保留在 stdout 里、不参与判定。
import { EventEmitter } from 'node:events'

export const DEFAULT_EXEC_TIMEOUT_MS = 30_000
// close 之后的排空窗口：迟到 stdout data 的最大等待（到窗口内最后一次数据再顺延一次）。
export const EXEC_DRAIN_WINDOW_MS = 50
// stdout/stderr 回收上限：exec 面只服务短命令（uname / command -v / 运维片段），
// 长输出由调用方传更大的值或改用 SFTP 读文件。
export const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** 单引号包裹一个 POSIX shell 参数；内部单引号按 '\'' 转义。 */
export function quotePosixShellArg(arg) {
  const text = String(arg ?? '')
  return `'${text.replaceAll("'", "'\\''")}'`
}

/**
 * 把一条命令包成 `/bin/sh -c '<command>'`：无论远端默认 shell 是 fish、csh 还是
 * 别的，实际执行者都是 POSIX sh，命令语义只取决于我们写的这一层。
 */
export function buildPosixShellExecCommand(command) {
  return `/bin/sh -c ${quotePosixShellArg(command)}`
}

/**
 * 在一条 exec channel 上跑命令并按「close 收尾 + 排空窗口」协议收集结果。
 * 绝不 reject（超时 / exec 失败都从结果对象上反映），调用方统一处理。
 *
 * @param {{ exec: Function }} client ssh2 Client（或测试替身）
 * @param {string} command 原始命令（内部自动 POSIX 包装）
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string,
 *   stderr: string, timedOut?: boolean, error?: string}>}
 */
export function execCommand(client, command, {
  timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_EXEC_MAX_OUTPUT_BYTES,
  drainWindowMs = EXEC_DRAIN_WINDOW_MS,
} = {}) {
  return new Promise(resolve => {
    const wrapped = buildPosixShellExecCommand(command)
    let settled = false
    let exitCode = null
    let exitSignal = null
    let stdout = ''
    let stderr = ''
    let closeSeen = false
    let drainTimer = null
    let channel = null
    let timeoutTimer = null

    const cap = (text, extra) => (text.length + extra.length > maxOutputBytes ? text + extra.slice(0, Math.max(0, maxOutputBytes - text.length)) + '\n…[输出过长已截断]' : text + extra)

    const finish = (patch = {}) => {
      if (settled) return
      settled = true
      if (drainTimer !== null) { clearTimeout(drainTimer); drainTimer = null }
      if (timeoutTimer !== null) { clearTimeout(timeoutTimer); timeoutTimer = null }
      try { channel?.end?.() } catch { /* already gone */ }
      resolve({ code: exitCode, signal: exitSignal, stdout, stderr, ...patch })
    }

    // 排空：close 之后若还有迟到数据，每次数据把窗口顺延一次；窗口静默才收尾。
    const armDrain = () => {
      if (drainTimer !== null) clearTimeout(drainTimer)
      drainTimer = setTimeout(() => finish(), drainWindowMs)
    }

    client.exec(wrapped, (err, ch) => {
      if (err) { finish({ code: null, error: err.message }); return }
      if (settled) { try { ch.close?.() } catch { /* gone */ }; return }
      channel = ch
      ch.on('data', chunk => { stdout = cap(stdout, chunk.toString('utf8')); if (closeSeen) armDrain() })
      ch.stderr?.on('data', chunk => { stderr = cap(stderr, chunk.toString('utf8')); if (closeSeen) armDrain() })
      ch.on('exit', (code, signal) => {
        // 只记录，绝不在这里收尾 —— 先 exit 后 data 是真实时序（zcode 同款教训）。
        exitCode = code ?? null
        exitSignal = signal ?? null
      })
      ch.on('close', () => {
        // 一律走排空窗口收尾：退出码已经在 exit 里记下，但 close 之后仍可能有
        // 迟到数据（短命令的异步派发），窗口内每次数据顺延一次。
        closeSeen = true
        if (!settled) armDrain()
      })
      ch.on('error', error => finish({ code: exitCode, error: error.message }))
      // 客户端侧超时：命令可能永远不退出（等输入的死循环反馈）。
      timeoutTimer = setTimeout(() => {
        try { ch.end?.() } catch { /* gone */ }
        finish({ timedOut: true })
      }, timeoutMs)
      timeoutTimer.unref?.()
    })
  })
}

/**
 * 从一段 stdout 里逐行找第一个可解析的 JSON 对象（协议行扫描）：SSH banner、
 * motd、shell profile 的欢迎行会被自然跳过，非 JSON 行原样留在 stdout 中。
 * @returns {object|null}
 */
export function scanJsonLine(text) {
  if (typeof text !== 'string') return null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('{')) continue
    try {
      const value = JSON.parse(line)
      if (value !== null && typeof value === 'object') return value
    } catch { /* not a protocol line: banner or motd */ }
  }
  return null
}

// 供测试注入的 EventEmitter 通道替身（不是产品代码路径）。
export function createFakeChannel() {
  const channel = new EventEmitter()
  channel.stdin = new EventEmitter()
  channel.stderr = new EventEmitter()
  channel.end = () => channel.emit('end')
  return channel
}
