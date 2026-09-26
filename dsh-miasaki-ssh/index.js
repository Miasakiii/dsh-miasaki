// @miasaki/dsh-ssh — Host half.
//
// Mounts on the DSH web WebServer:
//   /ssh/                 page (served inside the conversation.view iframe)
//   /ssh/app.js|styles.css|vendor/...  static assets (xterm served from deps)
//   /ssh/api/*            REST management API (connections, fingerprints, attach tickets)
//   /ssh/ws               WebSocket terminal channel (U2.1: v2 frames + attach tickets)
//
// Security model (mirrors the canvas/sidebar approach, tightened for a
// remote-shell surface):
//   * every HTTP + WS request passes fenceCheck() — Host header must be a
//     loopback literal or an entry in config.trustedHosts, cross-site
//     requests rejected, Origin hostname must equal Host
//   * connections persist in dataDir/connections.json; auth secrets never go
//     into JSON — passwords live in the runtime session only, keys stay at a
//     path the user owns (or under dataDir/keys/); fingerprints are stored
//     separately in dataDir/known_hosts.json
//   * host keys follow TOFU with mismatch => refuse (runtime layer)
//   * U2.1（design/2026-09-15-ssh-u2-plan.md §3.2）：运行实例 id 不作授权证明 ——
//     WS attach 帧必须携带 POST /ssh/api/attach 签发的一次性短期票据；
//     无 v:2 的旧帧直接拒绝并提示刷新（方案 §3.3 不做双栈）
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { SshStore, InputError, NotFoundError, fenceCheck, sanitizeConnection } from './lib/store.js'
import { SshRuntime } from './lib/runtime.js'
import { diagnose } from './lib/diagnose.js'
import {
  listDirectory,
  statRemote,
  makeDir,
  renameRemote,
  removeFile,
  removeDir,
  downloadToWritable,
  uploadResilient,
  uploadViaExecPipe,
  ssh2ExecOpener,
  formatSftpError,
  sftpStatusLabel,
} from './lib/sftp.js'
import { normalizeRemotePath } from './lib/paths.js'
import { listSshConfigAliases } from './lib/sshConfig.js'
import { SFTP_MAX_UPLOAD_BYTES, SFTP_TICKET_TTL_MS } from './lib/limits.js'

export const name = 'ssh'
export const inject = ['webServer']

const MAX_BODY_BYTES = 64 * 1024
const MAX_WS_FRAME_BYTES = 256 * 1024 // input/resize frames are tiny; anything bigger is abuse
const PAGE_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
const WS_PING_INTERVAL_MS = 30_000

/**
 * SFTP 操作错误 → HTTP 状态码（NO_SUCH_FILE→404 / PERMISSION_DENIED→403 /
 * TARGET_EXISTS→409）。模块级：路由段与外层 catch 共用同一处判据。
 */
function sftpErrorStatus(error) {
  if (error?.code === 'TARGET_EXISTS') return 409
  const label = sftpStatusLabel(error?.code)
  if (label === 'NO_SUCH_FILE') return 404
  if (label === 'PERMISSION_DENIED') return 403
  return 500
}

function sendHtml(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function sendFile(res, contentType, body) {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
  res.end(body)
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > MAX_BODY_BYTES) throw new InputError('请求体过大')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new InputError('请求不是有效 JSON') }
}

function page() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">
<title>SSH</title>
<link rel="stylesheet" href="/ssh/vendor/xterm.css">
<link rel="stylesheet" href="/ssh/styles.css">
</head><body>
<div id="ssh-root"></div>
<script src="/ssh/vendor/xterm.js"></script>
<script src="/ssh/vendor/addon-fit.js"></script>
<script src="/ssh/vendor/addon-serialize.js"></script>
<script src="/ssh/sftp-ui.js"></script>
<script src="/ssh/session.js"></script>
<script src="/ssh/app.js"></script>
</body></html>`
}

/** Serve a dependency-resolved static file once, then from an in-memory cache. */
function cachedAsset(url, contentType) {
  let cache = null
  return async () => {
    if (cache === null) cache = await readFile(new URL(url, import.meta.url))
    return cache
  }
}

export function apply(ctx, config) {
  const dataDir = config?.dataDir
  const scrollbackBytes = Number.isSafeInteger(config?.scrollbackBytes) && config.scrollbackBytes > 0 ? config.scrollbackBytes : 256 * 1024
  const trustedHosts = new Set(['localhost', '127.0.0.1', ...[...(config?.trustedHosts ?? [])].map(h => String(h).trim().toLowerCase()).filter(Boolean)])

  const store = new SshStore(dataDir)
  // `config.runtime` 是测试注入点（与 diagnose.js 的 deps 参数同一惯例）：让 http 层的
  // 端到端测试用故障注入的「已连接 rc + 假 sftp client」驱动真实路由，不起真 sshd。
  // 产品路径（cordis patch 配置）不可能带上它 ⇒ 不存在被配置面利用的面。
  const runtime = config?.runtime instanceof SshRuntime ? config.runtime : new SshRuntime(store, { scrollbackBytes })

  ctx.effect(() => () => void runtime.shutdown?.(), 'ssh: runtime shutdown')

  // ------------------------------------------------------------- assets
  const appAsset = cachedAsset('./app.js')
  const sessionAsset = cachedAsset('./session.js')
  // U2.2：文件面板前端（自包含 IIFE，window.SshFiles）
  const sftpUiAsset = cachedAsset('./sftp-ui.js')
  const stylesAsset = cachedAsset('./styles.css')
  const xtermAsset = cachedAsset('./node_modules/@xterm/xterm/lib/xterm.js')
  const xtermCssAsset = cachedAsset('./node_modules/@xterm/xterm/css/xterm.css')
  const fitAsset = cachedAsset('./node_modules/@xterm/addon-fit/lib/addon-fit.js')
  // U2.4：官方 @xterm/addon-serialize（探针 B 已证 0.14.0 与 xterm 6.0.0 兼容）。
  // 启动时判定一次（依赖随包安装，正常恒存在）；缺失则回占位脚本，前端按
  // SerializeAddon 缺失降级为回放恢复（方案 §4.4 路线 C 的兜底）。
  const serializePath = new URL('./node_modules/@xterm/addon-serialize/lib/addon-serialize.js', import.meta.url)
  const hasSerializeAddon = existsSync(serializePath)
  const serializeAsset = hasSerializeAddon ? cachedAsset('./node_modules/@xterm/addon-serialize/lib/addon-serialize.js') : null
  const serializePlaceholder = Buffer.from('/* @xterm/addon-serialize 未安装：U2.4 精确恢复降级为回放恢复 */')

  const asset = (getter, contentType) => async (_req, res) => {
    try {
      sendFile(res, contentType, await getter())
    } catch (error) {
      ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
      sendJson(res, 500, { error: '静态资源不可用' })
    }
  }

  // ------------------------------------------------------------- REST API
  const api = async (req, res) => {
    const fence = fenceCheck(req.headers, trustedHosts)
    if (!fence.ok) return sendJson(res, 403, { error: `不被信任的请求来源（${fence.reason}）` })
    try {
      const path = new URL(req.url ?? '/', 'http://dsh.local').pathname

      if (path === '/ssh/api/state' && req.method === 'GET') {
        return sendJson(res, 200, { connections: runtime.listState() })
      }

      // 连接诊断（DNS → TCP → SSH banner → 可选认证方法）。默认不发任何凭据：
      // 诊断按钮要是每次都记一次失败登录，用户会被 fail2ban / 云主机安全封 IP。
      // `resolveEgress` 是**逐次显式**的：只有用户点了「查询公网出口 IP」才会外呼第三方服务。
      if (path === '/ssh/api/diagnose' && req.method === 'POST') {
        const body = await readJson(req).catch(() => ({}))
        const record = typeof body?.connectionId === 'string' ? await store.getConnection(body.connectionId) : null
        const draft = body?.draft ?? null
        const target = record ?? draft
        if (target === null || typeof target !== 'object') return sendJson(res, 400, { error: '缺少诊断目标（connectionId 或 draft）' })
        const report = await diagnose({
          host: record !== null ? record.host : draft?.host,
          port: record !== null ? record.port : Number(draft?.port),
          username: record !== null ? record.username : draft?.username,
          label: record !== null ? record.label : (typeof draft?.label === 'string' ? draft.label : null),
          probeAuth: body?.probeAuth === true,
          resolveEgress: body?.resolveEgress === true,
        })
        return sendJson(res, 200, { report })
      }

      // U2.1 附着票据（方案 §3.2）：一次性 + TTL 30s；WS attach 帧消费之。
      if (path === '/ssh/api/attach' && req.method === 'POST') {
        const body = await readJson(req)
        const connId = String(body?.connId ?? '')
        if (!/^[0-9a-f-]+$/i.test(connId)) return sendJson(res, 400, { error: 'connId 不合法' })
        const runtimeId = runtime.byProfile.get(connId)
        if (runtimeId === undefined || runtime.conns.get(runtimeId) === undefined) {
          return sendJson(res, 404, { error: '连接不存在或未在运行' })
        }
        const { ticket, expiresAt } = runtime.issueAttachTicket(connId)
        const rc = runtime.conns.get(runtimeId)
        return sendJson(res, 200, {
          ticket,
          expiresAt,
          runtimeId,
          state: rc.status,
          shells: (rc.shells ? [...rc.shells.values()] : []).map(sh => ({
            shellId: sh.id, shellSeq: sh.seq, title: sh.title, state: sh.ended ? 'ended' : 'live', cols: sh.cols, rows: sh.rows,
          })),
        })
      }

      // ------------------------------------------------------------- SFTP（U2.2）
      // 票据族：POST /sftp/ticket 签发（10 分钟可续期 Bearer，与 WS attach 的 30s 一次性
      // 是两种生命周期，方案 §4.2.4）；teardown 同批作废；围栏与全 API 共用。
      /** 票据 → { rc }（不含 sftp 会话：会话打不开时上传要降级，由调用方处理）。 */
      const sftpContext = ticket => {
        const item = runtime.checkSftpTicket(String(ticket ?? ''))
        if (item === null) return { error: 'SFTP 票据无效或已过期', status: 401 }
        const rc = runtime.runtimeOf(item.connId)
        if (rc === null || rc.status !== 'connected') return { error: '连接不存在或未在运行', status: 404 }
        return { rc }
      }

      /** 路径归一（~ 用 home 结算；非法输入 ⇒InputError → 400）。 */
      const sftpPath = async (rc, raw, fallbackHome) => {
        const home = await runtime.sftpHome(rc).catch(() => fallbackHome ?? '/')
        const text = typeof raw === 'string' && raw.length > 0 ? raw : home
        const normalized = normalizeRemotePath(text, { homeDir: home, baseDir: home })
        if (normalized.error !== undefined) throw new InputError(normalized.error)
        return { home, path: normalized.path }
      }

      if (path === '/ssh/api/sftp/ticket' && req.method === 'POST') {
        const body = await readJson(req)
        const connId = String(body?.connId ?? '')
        if (!/^[0-9a-f-]+$/i.test(connId)) return sendJson(res, 400, { error: 'connId 不合法' })
        const rc = runtime.runtimeOf(connId)
        if (rc === null || rc.status !== 'connected') return sendJson(res, 404, { error: '连接不存在或未在运行' })
        const { ticket, expiresAt } = runtime.issueSftpTicket(connId, { ttlMs: SFTP_TICKET_TTL_MS })
        return sendJson(res, 200, { ticket, expiresAt })
      }

      if (path === '/ssh/api/sftp/renew' && req.method === 'POST') {
        const body = await readJson(req)
        const renewed = runtime.renewSftpTicket(String(body?.ticket ?? ''), { ttlMs: SFTP_TICKET_TTL_MS })
        if (renewed === null) return sendJson(res, 401, { error: '票据无效或已过期，请重新打开文件面板' })
        return sendJson(res, 200, renewed)
      }

      if (path === '/ssh/api/sftp/list' && req.method === 'GET') {
        const query = new URL(req.url ?? '/', 'http://dsh.local').searchParams
        const ctx = sftpContext(query.get('ticket'))
        if (ctx.error !== undefined) return sendJson(res, ctx.status, { error: ctx.error })
        const { home, path: dirPath } = await sftpPath(ctx.rc, query.get('path'))
        const sftp = await runtime.sftpSession(ctx.rc)
        const entries = await listDirectory(sftp, dirPath)
        return sendJson(res, 200, { path: dirPath, home, entries })
      }

      if (path === '/ssh/api/sftp/stat' && req.method === 'GET') {
        const query = new URL(req.url ?? '/', 'http://dsh.local').searchParams
        const ctx = sftpContext(query.get('ticket'))
        if (ctx.error !== undefined) return sendJson(res, ctx.status, { error: ctx.error })
        const { path: filePath } = await sftpPath(ctx.rc, query.get('path'))
        const sftp = await runtime.sftpSession(ctx.rc)
        return sendJson(res, 200, { stat: await statRemote(sftp, filePath) })
      }

      if (path === '/ssh/api/sftp/download' && req.method === 'GET') {
        const query = new URL(req.url ?? '/', 'http://dsh.local').searchParams
        const ctx = sftpContext(query.get('ticket'))
        if (ctx.error !== undefined) return sendJson(res, ctx.status, { error: ctx.error })
        const { path: filePath } = await sftpPath(ctx.rc, query.get('path'))
        const sftp = await runtime.sftpSession(ctx.rc)
        let stats
        try {
          stats = await statRemote(sftp, filePath)
        } catch (error) {
          return sendJson(res, sftpErrorStatus(error), { error: formatSftpError(error) })
        }
        if (stats.type !== 'file') return sendJson(res, 400, { error: '目标不是文件' })
        const fileName = encodeURIComponent(filePath.slice(filePath.lastIndexOf('/') + 1) || 'download')
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(stats.size ?? 0),
          'content-disposition': `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`,
          'cache-control': 'no-store',
        })
        // 头已发出：mid-stream 失败只能断流（客户端看到截断的文件），错误进 host 日志
        await downloadToWritable(sftp, filePath, res, { totalBytes: stats.size ?? undefined }).catch(error => {
          ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
          try { res.destroy() } catch { /* gone */ }
        })
        return undefined
      }

      if (path === '/ssh/api/sftp/upload' && req.method === 'POST') {
        const query = new URL(req.url ?? '/', 'http://dsh.local').searchParams
        const ctx = sftpContext(query.get('ticket'))
        if (ctx.error !== undefined) return sendJson(res, ctx.status, { error: ctx.error })
        const overwrite = query.get('overwrite') === '1'
        const declared = Number(query.get('size') ?? req.headers['content-length'] ?? 0)
        if (Number.isFinite(declared) && declared > SFTP_MAX_UPLOAD_BYTES) {
          return sendJson(res, 413, { error: `文件超过单次上传上限（${Math.floor(SFTP_MAX_UPLOAD_BYTES / 1024 / 1024)} MiB）` })
        }
        const { path: filePath } = await sftpPath(ctx.rc, query.get('path'))
        const controller = new AbortController()
        // 客户端断连（导航/取消）⇒ 中止传输，不挂着远端半文件
        res.on('close', () => { if (res.writableEnded !== true) controller.abort() })
        const onProgress = ({ transferredBytes }) => {
          if (transferredBytes > SFTP_MAX_UPLOAD_BYTES) controller.abort()
        }
        const openExec = ssh2ExecOpener(ctx.rc.client)
        const runUpload = async () => {
          if (ctx.rc.execOnlyUpload === true) {
            // 这台机器的 SFTP 写不通（上次 mid-stream 失败记住的）⇒ 直接 exec pipe
            return uploadViaExecPipe({ openExec, path: filePath, source: req, signal: controller.signal, onProgress })
          }
          try {
            const sftp = await runtime.sftpSession(ctx.rc)
            return await uploadResilient({ sftp, path: filePath, source: req, signal: controller.signal, onProgress, size: Number.isFinite(declared) && declared > 0 ? declared : undefined, overwrite, openExec })
          } catch (error) {
            // sftp 会话打不开 ⇒ 源流未被消费 ⇒ 直接降级 exec（zcode 同款第一道降级）
            if (error?.uploadFailureKind === 'sftp-session') {
              return uploadViaExecPipe({ openExec, path: filePath, source: req, signal: controller.signal, onProgress })
            }
            // mid-stream 失败：单次 HTTP 源流不可回放 ⇒ 记住 execOnly，告诉用户重试
            if (error?.uploadFailureKind === 'sftp-write') runtime.markExecOnlyUpload(ctx.rc)
            throw error
          }
        }
        try {
          const result = await runUpload()
          return sendJson(res, 200, { ok: true, transport: result.transport, transferredBytes: result.transferredBytes })
        } catch (error) {
          if (controller.signal.aborted === true) return sendJson(res, 499, { error: '传输已取消' })
          if (error?.code === 'TARGET_EXISTS') return sendJson(res, 409, { error: '目标已存在' })
          if (error?.uploadFailureKind === 'sftp-write') {
            return sendJson(res, 502, { error: `SFTP 通道写入失败：${formatSftpError(error)}；请重试（将自动改用命令通道上传）` })
          }
          return sendJson(res, sftpErrorStatus(error), { error: formatSftpError(error) })
        }
      }

      if (path === '/ssh/api/sftp/op' && req.method === 'POST') {
        const body = await readJson(req)
        const ctx = sftpContext(body?.ticket)
        if (ctx.error !== undefined) return sendJson(res, ctx.status, { error: ctx.error })
        const op = String(body?.op ?? '')
        const { path: opPath } = await sftpPath(ctx.rc, body?.path)
        const sftp = await runtime.sftpSession(ctx.rc)
        if (op === 'mkdir') {
          await makeDir(sftp, opPath)
          return sendJson(res, 200, { ok: true })
        }
        if (op === 'rename') {
          const { path: toPath } = await sftpPath(ctx.rc, body?.to)
          await renameRemote(sftp, opPath, toPath)
          return sendJson(res, 200, { ok: true })
        }
        if (op === 'unlink') {
          await removeFile(sftp, opPath)
          return sendJson(res, 200, { ok: true })
        }
        if (op === 'rmdir') {
          await removeDir(sftp, opPath)
          return sendJson(res, 200, { ok: true })
        }
        return sendJson(res, 400, { error: `不支持的操作: ${op}` })
      }

      // P1-1：~/.ssh/config 别名导入（只读本机 config；host 半解析，页面只渲染）
      if (path === '/ssh/api/ssh-config/aliases' && req.method === 'GET') {
        const { aliases, from } = await listSshConfigAliases()
        return sendJson(res, 200, { aliases, from })
      }

      if (path === '/ssh/api/fingerprint' && req.method === 'POST') {
        const body = await readJson(req)
        const result = await runtime.confirmFingerprint(String(body?.token ?? ''), body?.accept === true)
        return sendJson(res, result.ok ? 200 : 400, result)
      }

      if (path === '/ssh/api/hosts' && req.method === 'GET') {
        return sendJson(res, 200, { hosts: await store.listHosts() })
      }
      const forgetHost = /^\/ssh\/api\/hosts\/(.+)\/forget$/i.exec(path)
      if (forgetHost !== null && req.method === 'POST') {
        await store.forgetHost(decodeURIComponent(forgetHost[1]))
        return sendJson(res, 200, { ok: true })
      }

      if (path === '/ssh/api/connections') {
        if (req.method === 'GET') {
          const live = new Map(runtime.listState().map(item => [item.id, item.state]))
          const connections = (await store.listConnections()).map(item => ({ ...item, state: live.get(item.id) ?? 'idle' }))
          return sendJson(res, 200, { connections })
        }
        if (req.method === 'POST') {
          const record = await store.createConnection(await readJson(req))
          return sendJson(res, 201, { connection: record })
        }
      }
      const one = /^\/ssh\/api\/connections\/([0-9a-f-]+)$/i.exec(path)
      if (one !== null) {
        const id = one[1]
        if (req.method === 'GET') {
          const record = await store.getConnection(id)
          if (record === null) return sendJson(res, 404, { error: '连接不存在' })
          return sendJson(res, 200, { connection: sanitizeConnection(record), state: runtime.listState().find(item => item.id === id)?.state ?? 'idle' })
        }
        if (req.method === 'DELETE') {
          await runtime.disconnect(id)
          const removed = await store.removeConnection(id)
          return sendJson(res, removed ? 200 : 404, { ok: removed })
        }
        if (req.method === 'PUT') {
          try {
            const record = await store.updateConnection(id, await readJson(req))
            return sendJson(res, 200, { connection: record })
          } catch (error) {
            if (error instanceof NotFoundError) return sendJson(res, 404, { error: error.message })
            throw error
          }
        }
      }
      const op = /^\/ssh\/api\/connections\/([0-9a-f-]+)\/(connect|disconnect)$/i.exec(path)
      if (op !== null && req.method === 'POST') {
        const id = op[1]
        if (op[2] === 'disconnect') return sendJson(res, 200, await runtime.disconnect(id))
        const body = await readJson(req).catch(() => ({}))
        const result = await runtime.connect(id, {
          password: typeof body?.password === 'string' ? body.password : undefined,
          passphrase: typeof body?.passphrase === 'string' ? body.passphrase : undefined,
        })
        if (result?.error) return sendJson(res, 400, { error: result.error })
        // `repaired`：主机栏里带端口的历史记录已在连接时就地修正（runtime.connect），
        // 把「改了什么」如实回给页面，由页面提示用户（不静默改数据）。
        return sendJson(res, 200, { ok: true, state: result.state, ...(result.repaired === undefined ? {} : { repaired: result.repaired }) })
      }
      return sendJson(res, 404, { error: '接口不存在' })
    } catch (error) {
      if (error instanceof InputError) return sendJson(res, 400, { error: error.message })
      if (error instanceof NotFoundError) return sendJson(res, 404, { error: error.message })
      // SFTP 操作错误走状态码映射（NO_SUCH_FILE→404 / PERMISSION_DENIED→403 / …），
      // 否则列目录/stat 的「文件不存在」会落进 500，排障时看不出来。
      if (error?.code === 'TARGET_EXISTS' || sftpStatusLabel(error?.code) !== null) {
        return sendJson(res, sftpErrorStatus(error), { error: formatSftpError(error) })
      }
      ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
      return sendJson(res, 500, { error: 'SSH 服务暂时不可用' })
    }
  }

  // ------------------------------------------------------------- WebSocket
  const wss = new WebSocketServer({ noServer: true })
  const sockets = new Set() // for pings + cleanup

  /** 旧帧（无 v:2）：不做双栈（方案 §3.3）——明确让前端刷新。 */
  function rejectOldFrame(ws) {
    try { ws.send(JSON.stringify({ type: 'error', code: 'VERSION_MISMATCH', message: 'SSH 插件已升级，请刷新页面后继续' })) } catch { /* gone */ }
    try { ws.close() } catch { /* gone */ }
  }

  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.shellId = null
    ws.mode = 'read'
    ws.on('message', data => {
      if (data.length > MAX_WS_FRAME_BYTES) return
      let msg
      try { msg = JSON.parse(String(data)) } catch { return }
      if (msg === null || typeof msg !== 'object' || typeof msg.type !== 'string') return
      if (msg.v !== 2) { rejectOldFrame(ws); return }
      switch (msg.type) {
        case 'attach':
          runtime.attach(ws, {
            ticket: typeof msg.ticket === 'string' ? msg.ticket : '',
            shellId: typeof msg.shellId === 'string' && msg.shellId.length > 0 ? msg.shellId : undefined,
            shellSeq: Number.isSafeInteger(msg.shellSeq) ? msg.shellSeq : undefined,
            cols: Number.isSafeInteger(msg.cols) ? msg.cols : undefined,
            rows: Number.isSafeInteger(msg.rows) ? msg.rows : undefined,
          })
          break
        case 'input':
          if (typeof msg.data === 'string') runtime.viewerInput(ws, typeof msg.shellId === 'string' ? msg.shellId : null, msg.data)
          break
        case 'resize':
          runtime.viewerResize(ws, typeof msg.shellId === 'string' ? msg.shellId : null,
            Number.isSafeInteger(msg.cols) ? msg.cols : undefined,
            Number.isSafeInteger(msg.rows) ? msg.rows : undefined)
          break
        case 'shell.open':
          runtime.openShellForViewer(ws, {
            cols: Number.isSafeInteger(msg.cols) ? msg.cols : undefined,
            rows: Number.isSafeInteger(msg.rows) ? msg.rows : undefined,
          })
          break
        case 'shell.close':
          if (typeof msg.shellId === 'string') runtime.closeShellByViewer(ws, msg.shellId)
          break
        case 'shell.takeover':
          if (typeof msg.shellId === 'string') runtime.takeoverShell(ws, msg.shellId)
          break
        case 'snapshot':
          if (typeof msg.shellId === 'string') runtime.storeSnapshot(ws, msg.shellId, typeof msg.data === 'string' ? msg.data : '')
          break
        case 'detach':
          runtime.detach(ws)
          break
        default:
          break // 未知类型静默忽略（前向兼容窗口内的新帧不炸旧会话）
      }
    })
    ws.on('close', () => { runtime.detach(ws); sockets.delete(ws) })
    ws.on('error', () => { runtime.detach(ws); sockets.delete(ws) })
  })

  const pingTimer = setInterval(() => {
    for (const ws of sockets) { try { ws.ping() } catch { sockets.delete(ws) } }
  }, WS_PING_INTERVAL_MS)

  ctx.effect(() => () => {
    clearInterval(pingTimer)
    for (const ws of sockets) { try { ws.terminate() } catch { /* noop */ } }
    sockets.clear()
  }, 'ssh: ws lifecycle')

  // ------------------------------------------------------------- routes
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ssh', handler: (_req, res) => { res.writeHead(302, { location: '/ssh/' }); res.end() } }), 'ssh: redirect')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ssh/', handler: (_req, res) => { sendHtml(res, page()) } }), 'ssh: page')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ssh/app.js', handler: asset(appAsset, 'text/javascript; charset=utf-8') }), 'ssh: app')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ssh/session.js', handler: asset(sessionAsset, 'text/javascript; charset=utf-8') }), 'ssh: session')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ssh/sftp-ui.js', handler: asset(sftpUiAsset, 'text/javascript; charset=utf-8') }), 'ssh: sftp-ui')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ssh/styles.css', handler: asset(stylesAsset, 'text/css; charset=utf-8') }), 'ssh: styles')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ssh/vendor/xterm.js', handler: asset(xtermAsset, 'text/javascript; charset=utf-8') }), 'ssh: xterm')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ssh/vendor/xterm.css', handler: asset(xtermCssAsset, 'text/css; charset=utf-8') }), 'ssh: xterm css')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ssh/vendor/addon-fit.js', handler: asset(fitAsset, 'text/javascript; charset=utf-8') }), 'ssh: addon-fit')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/ssh/vendor/addon-serialize.js',
    handler: (req, res) => {
      if (serializeAsset !== null) return asset(serializeAsset, 'text/javascript; charset=utf-8')(req, res)
      sendFile(res, 'text/javascript; charset=utf-8', serializePlaceholder)
    },
  }), 'ssh: addon-serialize')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/ssh/api', handler: api }), 'ssh: api')

  // WS upgrade gate: fence first, then hand the socket to the WSS.
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/ssh/ws',
    handler: (req, socket, head) => {
      const fence = fenceCheck(req.headers, trustedHosts)
      if (!fence.ok) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
    },
  }), 'ssh: websocket')
}
