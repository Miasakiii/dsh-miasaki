// @miasaki/dsh-ssh — Host half.
//
// Mounts on the DSH web WebServer:
//   /ssh/                 page (served inside the conversation.view iframe)
//   /ssh/app.js|styles.css|vendor/...  static assets (xterm served from deps)
//   /ssh/api/*            REST management API (connections, fingerprints)
//   /ssh/ws               WebSocket terminal channel
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
import { readFile } from 'node:fs/promises'
import { WebSocketServer } from 'ws'
import { SshStore, InputError, NotFoundError, fenceCheck, sanitizeConnection } from './lib/store.js'
import { SshRuntime } from './lib/runtime.js'

export const name = 'ssh'
export const inject = ['webServer']

const MAX_BODY_BYTES = 64 * 1024
const PAGE_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
const WS_PING_INTERVAL_MS = 30_000

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
  const runtime = new SshRuntime(store, { scrollbackBytes })

  ctx.effect(() => () => void runtime.shutdown?.(), 'ssh: runtime shutdown')

  // ------------------------------------------------------------- assets
  const appAsset = cachedAsset('./app.js')
  const stylesAsset = cachedAsset('./styles.css')
  const xtermAsset = cachedAsset('./node_modules/@xterm/xterm/lib/xterm.js')
  const xtermCssAsset = cachedAsset('./node_modules/@xterm/xterm/css/xterm.css')
  const fitAsset = cachedAsset('./node_modules/@xterm/addon-fit/lib/addon-fit.js')

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
        return sendJson(res, 200, { ok: true, state: result.state })
      }
      return sendJson(res, 404, { error: '接口不存在' })
    } catch (error) {
      if (error instanceof InputError) return sendJson(res, 400, { error: error.message })
      if (error instanceof NotFoundError) return sendJson(res, 404, { error: error.message })
      ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
      return sendJson(res, 500, { error: 'SSH 服务暂时不可用' })
    }
  }

  // ------------------------------------------------------------- WebSocket
  const wss = new WebSocketServer({ noServer: true })
  const sockets = new Set() // for pings + cleanup

  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.on('message', data => {
      let msg
      try { msg = JSON.parse(String(data)) } catch { return }
      if (msg.type === 'attach') {
        ws.connId = String(msg.connId ?? '')
        runtime.attach(ws, {
          connId: String(msg.connId ?? ''),
          cols: Number.isSafeInteger(msg.cols) ? msg.cols : undefined,
          rows: Number.isSafeInteger(msg.rows) ? msg.rows : undefined,
        })
      } else if (msg.type === 'input' && typeof msg.data === 'string') {
        runtime.sendInput(ws.connId, msg.data)
      } else if (msg.type === 'resize') {
        runtime.resize(ws.connId, Number.isSafeInteger(msg.cols) ? msg.cols : undefined, Number.isSafeInteger(msg.rows) ? msg.rows : undefined)
      } else if (msg.type === 'detach') {
        runtime.detach(ws)
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
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ssh/styles.css', handler: asset(stylesAsset, 'text/css; charset=utf-8') }), 'ssh: styles')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ssh/vendor/xterm.js', handler: asset(xtermAsset, 'text/javascript; charset=utf-8') }), 'ssh: xterm')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ssh/vendor/xterm.css', handler: asset(xtermCssAsset, 'text/css; charset=utf-8') }), 'ssh: xterm css')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ssh/vendor/addon-fit.js', handler: asset(fitAsset, 'text/javascript; charset=utf-8') }), 'ssh: addon-fit')
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