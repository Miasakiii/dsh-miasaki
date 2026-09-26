// Runtime layer for @miasaki/dsh-ssh — U2.1 三层身份（design/2026-09-15-ssh-u2-plan.md §3/§4.1）
//
// connId（profile，持久，store.js）
//   └─ runtimeId（一次 SSH 连接实例 = 一个 ssh2 Client，rt-<uuid>，含 generation 语义）
//        ├─ shellId #1（ShellChannel：stream + 尺寸 + 独立回放环 + viewer 集合 + 写入所有权）
//        ├─ shellId #2 …（上限 MAX_SHELLS_PER_RUNTIME）
//        └─（U2.2 预留）sftp：惰性 SFTPWrapper，连接级共享
//
// 安全前置（工作区规划 §8）：运行实例 id 不作授权证明 —— 浏览器先经
// POST /ssh/api/attach 换取一次性短期附着票据，WS attach 帧消费之。
// 票据过期 / 重放 / runtime teardown 一律拒绝（TICKET_INVALID）。
//
// U0 契约保持：输入/尺寸按 ws 绑定路由（绝不按 connId 查表）；慢 viewer 背压淘汰；
// 秘密只存在于调用链；TOFU 指纹确认与 generation 绑定不变。
import { Client } from 'ssh2'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostKeyOf, fingerprintOf, splitHostPort } from './store.js'
import { openSftpSession, resolveRemoteHome } from './sftp.js'
import { createLocalForward, forwardSummaries } from './forward.js'
import { SFTP_TICKET_TTL_MS } from './limits.js'

// One time budget shared by the ssh2 handshake (readyTimeout) and the
// fingerprint confirm window: while hostVerifier is pending the handshake
// clock keeps ticking, so the two windows MUST be the same or a user who
// confirms at t=30s would confirm a connection that died at t=15s (plan §5.3).
const HANDSHAKE_BUDGET_MS = 60_000
// SSH 级 keepalive（对标 zcode sshAuth.ts 同款口径）：NAT / 防火墙 / 服务端静默断开时
// stdio channel 不一定立刻 close —— 没有 keepalive，连接会一直挂在 'connected'，
// 终端不再有任何输出，用户只能手动重连。15s 探一次、连续 3 次无响应即报错。
const KEEPALIVE_INTERVAL_MS = 15_000
const KEEPALIVE_COUNT_MAX = 3
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32
const MAX_COLS = 1000
const MAX_ROWS = 500
const MAX_WS_BUFFERED_BYTES = 8 * 1024 * 1024 // drop a viewer whose send buffer exceeds this
const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

// U2 决策 1（2026-09-15 拍板）：同 runtime shell 上限 8，超出拒绝并给可读提示。
export const MAX_SHELLS_PER_RUNTIME = 8
// 附着票据 TTL：只够建立 WS，不够复用（方案 §3.2）。
export const ATTACH_TICKET_TTL_MS = 30_000
// 每连接（runtime）回放总预算（方案 §4.1.4）：shell 间先到先得 + LRU 头裁剪。
export const DEFAULT_SCROLLBACK_BYTES_PER_RUNTIME = 1024 * 1024

function clampDim(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isSafeInteger(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Classify an ssh2/client error into a stable, machine-routable code. */
export function classifyError(error) {
  const message = String(error?.message ?? error ?? '')
  const text = message.toLowerCase()
  // ssh2 的 level 分级优先于文案匹配（对标 zcode normalizeSSHConnectError）：
  // 不同私钥格式 / 服务端配置下同一个语义的文案并不稳定，level 是协议层事实。
  if (error?.level === 'client-authentication') {
    return { code: 'AUTH_FAILED', message: `SSH 认证失败：请检查用户名、密码或私钥（${message}）` }
  }
  if (error?.level === 'client-timeout') {
    return { code: 'TIMEOUT', message: `${message} —— SSH 握手未在 ${HANDSHAKE_BUDGET_MS / 1000} 秒内完成：请检查网络质量、服务器 SSH 服务是否正常，以及本机与服务器的 SSH 配置差异` }
  }
  // 加密私钥的口令问题单独成码：与「认证失败」的排查动作完全不同（一个是补口令、
  // 一个是改账号密码）。模式匹配而非单一字符串 —— ssh2 对不同私钥格式
  // （OpenSSH 旧/新格式、PPK）报的文案并不一致（zcode 同款教训）。
  if (text.includes('encrypted') && text.includes('private') && text.includes('no passphrase')) {
    return { code: 'KEY_PASSPHRASE_MISSING', message: `这个私钥有口令保护：请提供私钥口令后再连接（${message}）` }
  }
  if (text.includes('bad passphrase') || text.includes('key integrity check failed') || text.includes('unable to authenticate data')) {
    return { code: 'KEY_PASSPHRASE_INVALID', message: `私钥口令错误：无法解密私钥，请检查口令是否正确（${message}）` }
  }
  if (text.includes('all configured authentication methods failed') || text.includes('authentication failed')) {
    return { code: 'AUTH_FAILED', message }
  }
  if (text.includes('no supported auth')) return { code: 'AUTH_UNSUPPORTED', message }
  if (text.includes('econnrefused')) return { code: 'CONNECTION_REFUSED', message }
  if (text.includes('ehostunreach')) return { code: 'HOST_UNREACHABLE', message }
  if (text.includes('enotfound')) {
    // 实机反馈（2026-09-26）：`getaddrinfo ENOTFOUND 8.138.243.30:25112` 出现在主机栏里
    // 连端口一起填、端口栏留默认 22 的时候。原始消息原样保留（排障要看它），前面补一句
    // 能直接照做的指引；记录本身由 connect() 就地修正，这里只服务「解析真失败」的域名。
    return { code: 'HOST_NOT_FOUND', message: `无法解析主机名（${message}）—— 请检查主机地址：只填域名或 IP，端口填在「端口」栏` }
  }
  if (text.includes('etimedout') || text.includes('timed out')) {
    // 实机反馈（2026-09-26 续）：`connect ETIMEDOUT <ip>:<port>` 是「包被丢掉」——多数是
    // 云安全组/防火墙没放行该端口，或那里根本没有服务在监听。原句保留 + 排查方向。
    return { code: 'TIMEOUT', message: `${message} —— 对端没有应答：先确认云安全组 / 防火墙是否放行了这个端口（以及服务是否在监听），再考虑网络质量` }
  }
  // 实机反馈（2026-09-26 续）：TCP 通了、但对端在本端发出 SSH banner 之前就断开
  // （实测 [host]:[port] 38ms 建连、69ms RST、零字节）。最常见的原因是「这个端口不是
  // sshd」或「安全组/端口映射没指向 sshd」。原句看不懂，补一句可照做的排查方向。
  if (text.includes('connection lost before handshake')) {
    return { code: 'HANDSHAKE_LOST', message: `${message} —— 对端在 SSH 握手前就断开：先确认这个端口是不是 SSH 服务（云安全组是否对本机放行、端口映射是否指向 sshd），再考虑网络抖动` }
  }
  if (text.includes('econnreset')) return { code: 'CONNECTION_RESET', message }
  if (text.includes('host key')) return { code: 'HOST_KEY', message }
  return { code: 'ERROR', message }
}

/**
 * 组装 ssh2 连接配置（纯函数，便于单测；凭据副作用留在 connect()）。
 * 三条口径来对标 zcode（zai-org/ZCode packages/server/src/remote/sshAuth.ts，
 * 见 design/2026-09-26-ssh-zcode-benchmark-plan.md §4-P0-1）：
 *  1. readyTimeout 与指纹确认窗口同一预算 —— hostVerifier 挂起期间握手时钟仍在走，
 *     两个窗口必须一致，否则 t=30s 确认的用户确认的是一条 t=15s 就死掉的连接。
 *  2. SSH 级 keepalive 15s×3 —— NAT / 防火墙静默断开时 stdio channel 不一定立刻
 *     close，没有它连接会挂在 'connected' 直到用户手动重连。
 *  3. agent 只认显式选择（auth.method === 'agent'）—— 带密码时隐式带上
 *     SSH_AUTH_SOCK 会让公钥阶段先耗尽 MaxAuthTries，密码永远进不了认证。
 * tryKeyboard：只开 keyboard-interactive 的服务器（新装 Ubuntu / Debian、部分云镜像
 * 的默认 `PasswordAuthentication no` + `KbdInteractiveAuthentication yes`）需要客户端
 * 显式打开它，ssh2 才把该方法列入 authsAllowed（`ssh2/lib/client.js:843`）；不开的
 * 话密码再对也只会收到 `All configured authentication methods failed`（实机反馈
 * 2026-09-26）。回填的就是本次连接的密码（PAM 单提示）；服务端若拿这个通道做二次
 * 验证，回填密码自然不通过 —— 与不说谎的失败一致，不额外猜测。
 *
 * @returns {{ cfg: object, keyboardPassword: string|null } | { error: { code: string, message: string } }}
 */
export function buildConnectConfig(record, { password, passphrase, privateKey } = {}, { agentSupported = true, agentSock } = {}) {
  const cfg = {
    host: record.host,
    port: record.port,
    username: record.username,
    readyTimeout: HANDSHAKE_BUDGET_MS,
    keepaliveInterval: KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: KEEPALIVE_COUNT_MAX,
  }
  let keyboardPassword = null
  if (record.auth.method === 'password') {
    if (typeof password !== 'string' || password.length === 0) {
      return { error: { code: 'CREDENTIAL_MISSING', message: '需要密码：尝试在新会话中为连接输入密码' } }
    }
    cfg.password = password
    cfg.tryKeyboard = true
    keyboardPassword = password
  } else if (record.auth.method === 'key') {
    if (privateKey === undefined || privateKey === null) {
      return { error: { code: 'KEY_READ_FAILED', message: '私钥读取失败：未读到私钥内容' } }
    }
    cfg.privateKey = privateKey
    if (typeof passphrase === 'string' && passphrase.length > 0) cfg.passphrase = passphrase
  } else if (record.auth.method === 'agent') {
    if (!agentSupported || typeof agentSock !== 'string' || agentSock.length === 0) {
      return { error: { code: 'AGENT_UNAVAILABLE', message: '当前环境检测不到 SSH agent（SSH_AUTH_SOCK）' } }
    }
    cfg.agent = agentSock
  } else {
    return { error: { code: 'AUTH_UNSUPPORTED', message: `不支持的认证方式: ${record.auth.method}` } }
  }
  return { cfg, keyboardPassword }
}

export class SshRuntime {
  constructor(store, {
    scrollbackBytes = 256 * 1024,
    scrollbackBytesPerRuntime = DEFAULT_SCROLLBACK_BYTES_PER_RUNTIME,
    agentSupported = true,
    now = Date.now,
  } = {}) {
    this.store = store
    this.scrollbackBytes = scrollbackBytes           // 每 shell 回放上限
    this.scrollbackBytesPerRuntime = scrollbackBytesPerRuntime // 每 runtime 总预算
    this.agentSupported = agentSupported
    this.now = now
    this.conns = new Map()      // runtimeId -> RuntimeConn
    this.byProfile = new Map()  // connId -> runtimeId（同主机仍限一运行连接）
    this.pending = new Map()    // fingerprint token -> PendingFingerprint
    this.tickets = new Map()    // attach ticket -> { connId, expiresAt, timer }
    this.sftpTickets = new Map() // sftp ticket -> { connId, expiresAt, timer }（U2.2：长 TTL 可续期）
  }

  async init() {
    await this.store.ready
  }

  // ------------------------------------------------------------------ attach tickets（方案 §3.2）
  /** 签发一次性附着票据。TTL 短，消费即作废；teardown 全部作废。 */
  issueAttachTicket(connId, { ttlMs = ATTACH_TICKET_TTL_MS } = {}) {
    const ticket = randomUUID()
    const expiresAt = this.now() + ttlMs
    const timer = setTimeout(() => this.tickets.delete(ticket), ttlMs + 1000)
    this.tickets.set(ticket, { connId, expiresAt, timer })
    return { ticket, expiresAt }
  }

  /** 消费票据：一次性。过期/重放/未知 ⇒ null。 */
  consumeTicket(ticket) {
    if (typeof ticket !== 'string' || ticket.length === 0) return null
    const item = this.tickets.get(ticket)
    if (item === undefined) return null
    clearTimeout(item.timer)
    this.tickets.delete(ticket)
    if (this.now() > item.expiresAt) return null
    return item
  }

  /** runtime teardown 时作废其名下全部票据（与 expirePendingFor 同构）。 */
  expireTicketsFor(connId) {
    for (const [ticket, item] of [...this.tickets.entries()]) {
      if (item.connId !== connId) continue
      clearTimeout(item.timer)
      this.tickets.delete(ticket)
    }
  }

  // ------------------------------------------------------------------ SFTP 票据（U2.2，方案 §4.2.4）
  // 与 WS attach 票据是两种生命周期：
  //   attach  = 30s 一次性（WS 建连即消费）
  //   sftp    = 10 分钟可续期 Bearer（一次列目录/传输会话内多次 REST 调用）
  // 共用同一道 fence（index.js 的 api handler），teardown 同批作废。
  issueSftpTicket(connId, { ttlMs = SFTP_TICKET_TTL_MS } = {}) {
    const ticket = randomUUID()
    const item = { connId, expiresAt: this.now() + ttlMs, timer: null }
    const arm = () => {
      if (item.timer !== null) clearTimeout(item.timer)
      item.timer = setTimeout(() => {
        if (this.sftpTickets.get(ticket) === item) this.sftpTickets.delete(ticket)
      }, Math.max(0, item.expiresAt - this.now()) + 1000)
    }
    arm()
    this.sftpTickets.set(ticket, item)
    return { ticket, expiresAt: item.expiresAt }
  }

  /** 校验（不消费）：未知/过期 ⇒ null。 */
  checkSftpTicket(ticket) {
    if (typeof ticket !== 'string' || ticket.length === 0) return null
    const item = this.sftpTickets.get(ticket)
    if (item === undefined) return null
    if (this.now() > item.expiresAt) {
      clearTimeout(item.timer)
      this.sftpTickets.delete(ticket)
      return null
    }
    return item
  }

  /** 续期（长传输排队中用）；未知/已过期 ⇒ null。 */
  renewSftpTicket(ticket, { ttlMs = SFTP_TICKET_TTL_MS } = {}) {
    const item = this.checkSftpTicket(ticket)
    if (item === null) return null
    item.expiresAt = this.now() + ttlMs
    if (item.timer !== null) clearTimeout(item.timer)
    item.timer = setTimeout(() => {
      if (this.sftpTickets.get(ticket) === item) this.sftpTickets.delete(ticket)
    }, ttlMs + 1000)
    return { expiresAt: item.expiresAt }
  }

  expireSftpTicketsFor(connId) {
    for (const [ticket, item] of [...this.sftpTickets.entries()]) {
      if (item.connId !== connId) continue
      clearTimeout(item.timer)
      this.sftpTickets.delete(ticket)
    }
  }

  /** connId（profile id）→ 当前 RuntimeConn；没有运行中的连接返回 null。 */
  runtimeOf(connId) {
    const runtimeId = this.byProfile.get(connId)
    return runtimeId !== undefined ? this.conns.get(runtimeId) ?? null : null
  }

  // ------------------------------------------------------------------ SFTP 会话（U2.2，连接级惰性共享）
  /** 惰性打开并缓存连接的 SFTP 会话；失败清缓存（下次重试重新打开）。 */
  async sftpSession(rc) {
    if (rc.disposed) throw Object.assign(new Error('连接已关闭'), { code: 'NOT_CONNECTED' })
    if (rc.sftp !== null && rc.sftp !== undefined) return rc.sftp
    if (rc.sftpPromise !== null) return rc.sftpPromise
    rc.sftpPromise = openSftpSession(rc.client).then(sftp => {
      rc.sftp = sftp
      rc.sftpPromise = null
      return sftp
    }).catch(error => {
      rc.sftp = null
      rc.sftpPromise = null
      throw error
    })
    return rc.sftpPromise
  }

  /** 远端 home（realpath('.')，缓存）；失败回落 '/'，不猜不写死。 */
  async sftpHome(rc) {
    if (rc.homeDir !== null && rc.homeDir !== undefined) return rc.homeDir
    const sftp = await this.sftpSession(rc)
    const home = await resolveRemoteHome(sftp)
    rc.homeDir = home
    return home
  }

  /**
   * 记住「这台机器的 SFTP 写不通」：mid-stream 失败后（单次 HTTP 源流不可回放，
   * 不能就地降级），下一次上传直接走 exec pipe（zcode execUploadOnly 同款记忆）。
   * 新连接是新 RuntimeConn ⇒ 记忆自然清零。
   */
  markExecOnlyUpload(rc) {
    rc.execOnlyUpload = true
  }

  // ------------------------------------------------------------------ 跳板（U3/P2-1，D4=②）
  /**
   * 确保跳板 runtime 已连接并返回它的 ssh2 Client。跳板必须是一条**已受信任的主机记录**：
   * 凭据与 TOFU 全走既有机制 —— key/agent 认证可隐式建连（无秘密传递），
   * password 认证在无人连过时以 CREDENTIAL_MISSING 失败 ⇒ 映射为 JUMP_UNAVAILABLE，
   * 由人在页面上先连接跳板（「不把发起认证暴露成隐式能力」与 A1 同一条纪律）。
   * 跳板**从未连过**（无指纹记录）时同样拒绝：它的 TOFU 确认窗口没有 UI 附着点
   * （没人 attach 跳板 rc），让用户先单独连一次是唯一诚实的路径。
   */
  async ensureJumpRuntime(connId) {
    const existing = this.runtimeOf(connId)
    if (existing !== null && existing.status === 'connected' && existing.client !== null) {
      return { client: existing.client }
    }
    if (existing !== null && (existing.status === 'waiting-fingerprint' || existing.status === 'connecting')) {
      return this.awaitJump(existing)
    }
    const jumpRecord = await this.store.getConnection(connId)
    if (jumpRecord === null) {
      return { error: { code: 'JUMP_UNAVAILABLE', message: '跳板主机不存在：请检查「经由跳板」配置' } }
    }
    const known = await this.store.getFingerprint(hostKeyOf(jumpRecord.host, jumpRecord.port))
    if (known === null) {
      return { error: { code: 'JUMP_UNAVAILABLE', message: '跳板机是首次连接（需要确认指纹）：请先单独连接该主机完成信任，再经它连目标' } }
    }
    const result = await this.connect(connId, { openShell: false })
    if (result?.error !== undefined) {
      return { error: { code: 'JUMP_UNAVAILABLE', message: `跳板机未连接（${result.error}）：请先连接该主机` } }
    }
    const rc = this.runtimeOf(connId)
    if (rc === null) {
      return { error: { code: 'JUMP_UNAVAILABLE', message: '跳板机连接不可用，请重试' } }
    }
    return this.awaitJump(rc)
  }

  /** 等一条跳板 rc 真正就绪（readyPromise）；等待期出现指纹确认 / 失败 ⇒ 结构化错误。 */
  async awaitJump(rc) {
    if (rc.status === 'waiting-fingerprint') {
      return { error: { code: 'JUMP_UNAVAILABLE', message: '跳板机正在等待指纹确认：请先单独连接该主机完成信任' } }
    }
    try {
      await rc.readyPromise
    } catch (error) {
      return { error: { code: 'JUMP_UNAVAILABLE', message: `跳板机连接失败：${error?.message ?? error}` } }
    }
    if (rc.status !== 'connected' || rc.client === null) {
      return { error: { code: 'JUMP_UNAVAILABLE', message: '跳板机未就绪，请重试' } }
    }
    return { client: rc.client }
  }

  /** 经跳板 client 开一条到目标 host:port 的 direct-tcpip 通道（作为新连接的 sock）。 */
  openJumpChannel(client, record, { timeoutMs = HANDSHAKE_BUDGET_MS } = {}) {
    return new Promise(resolve => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve(null)
      }, timeoutMs)
      try {
        client.forwardOut('127.0.0.1', 0, record.host, record.port, (err, channel) => {
          if (settled) { try { channel?.close?.() } catch { /* gone */ }; return }
          settled = true
          clearTimeout(timer)
          resolve(err ? null : channel)
        })
      } catch {
        settled = true
        clearTimeout(timer)
        resolve(null)
      }
    })
  }

  // ------------------------------------------------------------------ 本地转发（U3/P2-1）
  /** 连接就绪后按记录里的规则建立本地监听；重复调用幂等（按 localPort 去重）。 */
  setupForwards(rc) {
    if (rc.disposed || rc.client === null) return
    const specs = Array.isArray(rc.record?.forwards) ? rc.record.forwards : []
    for (const spec of specs) {
      if (rc.forwarders.has(spec.localPort)) continue
      const fwd = createLocalForward({
        client: rc.client,
        spec,
        onEvent: event => {
          // 监听/通道事件广播给 viewer（页面只渲染）。EADDRINUSE / 服务端拒绝转发
          // 是**转发层**故障：绝不能把连接状态翻成 error（answer() 会）——终端照常可用。
          rc.broadcast({ type: 'forward', event: event.type, localPort: event.localPort, message: event.message ?? null })
        },
      })
      rc.forwarders.set(spec.localPort, fwd)
    }
  }

  /** 关闭一个连接的全部本地转发（teardown / 手动断开共用）。 */
  closeForwards(rc) {
    for (const fwd of rc.forwarders.values()) void fwd.close()
    rc.forwarders.clear()
  }

  // ------------------------------------------------------------------ state
  listState() {    const out = []
    for (const rc of this.conns.values()) {
      out.push({
        id: rc.connId,           // profile id：REST 对外名字不变
        runtimeId: rc.id,
        state: rc.status,
        label: rc.label,
        shells: shellSummaries(rc),
        // U3/P2-1：本地转发运行态 + 跳板来源（页面渲染用；无则为空）
        forwards: forwardSummaries(rc.forwarders),
        via: typeof rc.record?.jumpHostId === 'string' && rc.record.jumpHostId.length > 0 ? rc.record.jumpHostId : null,
      })
    }
    return out
  }

  isConnected(id) {
    const runtimeId = this.byProfile.get(id)
    return runtimeId !== undefined && this.conns.get(runtimeId)?.status === 'connected'
  }

  /**
   * A1 `ssh_session_read` 的 host 侧读数口：读指定连接的当前 shell 回放环尾部。
   * 只读内存态 ring，不碰远端、不开 channel。截断在调用方（工具输出预算）。
   */
  readShellText(connId, { lines = 200 } = {}) {
    const rc = this.runtimeOf(connId)
    if (rc === null) return null
    const shell = rc.primaryShell()
    if (shell === null) return null
    const text = Buffer.concat(shell.sbChunks).toString('utf8')
    const all = text.split('\n')
    const kept = all.slice(-Math.max(1, Math.min(Number(lines) || 200, 2000)))
    return {
      text: kept.join('\n'),
      truncated: kept.length < all.length,
      cols: shell.cols,
      rows: shell.rows,
      title: shell.title,
      live: shell.ended !== true,
      runtimeId: rc.id,
    }
  }

  // ------------------------------------------------------------------ connect
  async connect(id, options = {}) {
    let record = await this.store.getConnection(id)
    if (record === null) return { error: 'NOT_FOUND' }

    // 主机栏里连端口一起填了（`8.138.243.30:25112`）：ssh2 会把它当主机名去解析
    // （getaddrinfo ENOTFOUND）。连接是这类历史记录唯一的出口，就地修正并回写一次，
    // 让用户点「重新连接」即可连上 —— 判定与拆分复用 store 的同一个纯函数（规则一处）。
    const typed = splitHostPort(record.host)
    let repaired = null
    if (typed.port !== null && typed.port !== record.port) {
      repaired = { from: record.host, host: typed.host, port: typed.port }
      record = await this.store.updateConnection(id, { host: typed.host, port: typed.port })
    }

    const existingRuntimeId = this.byProfile.get(id)
    if (existingRuntimeId !== undefined) {
      const existing = this.conns.get(existingRuntimeId)
      if (existing !== undefined) this.teardown(existing)
      // conns 以 runtimeId 键控：重连的替身是另一个键，旧实例必须显式移除
      this.conns.delete(existingRuntimeId)
    }

    const rc = new RuntimeConn(this, id, record)
    rc.openShell = options.openShell !== false // 跳板等辅助连接不开 shell
    this.conns.set(rc.id, rc)
    this.byProfile.set(id, rc.id)

    // password/key material flows only from the caller (one-time), never stored
    let privateKey
    if (record.auth.method === 'key') {
      try {
        privateKey = await readFile(record.auth.keyPath)
      } catch (error) {
        this.bail(rc, { code: 'KEY_READ_FAILED', message: `私钥读取失败：${error.message}` })
        return { id, error: 'KEY_READ_FAILED' }
      }
    }
    const built = buildConnectConfig(
      record,
      { password: options.password, passphrase: options.passphrase, privateKey },
      {
        agentSupported: this.agentSupported,
        agentSock: process.platform === 'win32' ? WINDOWS_AGENT_PIPE : process.env.SSH_AUTH_SOCK,
      },
    )
    if (built.error !== undefined) {
      this.bail(rc, built.error)
      return { id, error: built.error.code }
    }
    const cfg = built.cfg
    const keyboardPassword = built.keyboardPassword

    // U3/P2-1 跳板（D4=②）：目标连接走跳板 runtime 的 direct-tcpip 通道作为 sock。
    // 跳板必须先连上（key/agent 可隐式建连；password 必须人先连 —— 见 ensureJumpRuntime）。
    // 跳板通道挂在 rc 上，teardown 时随连接一起关闭。
    if (typeof record.jumpHostId === 'string' && record.jumpHostId.length > 0) {
      const jump = await this.ensureJumpRuntime(record.jumpHostId)
      if (jump.error !== undefined) {
        this.bail(rc, jump.error)
        return { id, error: jump.error.code }
      }
      const channel = await this.openJumpChannel(jump.client, record)
      if (channel === null) {
        this.bail(rc, { code: 'JUMP_CHANNEL_FAILED', message: '无法经跳板机建立到目标的通道：请检查跳板机是否允许转发、目标地址端口是否正确' })
        return { id, error: 'JUMP_CHANNEL_FAILED' }
      }
      rc.jumpChannel = channel
      cfg.sock = channel
      // sock 是 duplex stream：ssh2 不再自建 TCP，host/port 仅供信息展示
      cfg.host = record.host
      cfg.port = record.port
    }

    rc.connKey = hostKeyOf(record.host, record.port)

    // ssh2 calls hostVerifier(key, verify); we handle it fully asynchronously.
    cfg.hostVerifier = (key, verify) => {
      void this.handleHostKey(rc, key, verify).catch(error => {
        rc.answer('HOSTKEY_INTERNAL', String(error?.message ?? error))
        verify(false)
      })
    }

    const client = new Client()
    rc.client = client
    client.on('ready', () => this.onReady(rc))
    if (keyboardPassword !== null) {
      // 密码提示有几个就回填几个（PAM 通常是单提示）。
      client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        finish(prompts.map(() => keyboardPassword))
      })
    }
    client.on('error', err => {
      if (rc.disposed) return
      this.expirePendingFor(rc) // a dead handshake must not keep a live confirm token
      const info = classifyError(err)
      rc.answer(info.code, info.message)
    })
    client.on('close', () => {
      // reached when session ends or connection drops
      this.expirePendingFor(rc)
      for (const sh of rc.shells.values()) sh.stream = null
      // SSH 断了 ⇒ 本地转发失去通道：撤监听（僵尸端口比没有端口更糟）
      this.closeForwards(rc)
      // ready 之前就 close ⇒ 就绪门必须 reject（跳板 awaitJump 不能挂死）
      if (rc.status !== 'connected') rc.settleReady(new Error('连接已断开'))
      if (rc.disposed) return
      if (rc.status === 'connected' || rc.status === 'connecting' || rc.status === 'waiting-fingerprint') {
        rc.status = 'closed'
        rc.broadcast({ type: 'status', state: 'closed' })
      }
    })
    try {
      client.connect(cfg)
    } catch (error) {
      this.bail(rc, classifyError(error))
    }
    return { id, state: rc.status, ...(repaired === null ? {} : { repaired }) }
  }

  async handleHostKey(rc, key, verify) {
    const fingerprint = fingerprintOf(key)
    const known = await this.store.getFingerprint(rc.connKey)
    if (known === null) {
      // first-seen host key: hold the connection and ask the user
      const token = randomUUID()
      rc.status = 'waiting-fingerprint'
      rc.fp = { token, fingerprint, host: rc.label }
      const item = {
        token,
        rc, // generation binding: a confirm may only affect THIS RuntimeConn
        connId: rc.connId,
        connKey: rc.connKey,
        fingerprint,
        verify,
        timer: setTimeout(() => {
          if (this.pending.get(token) !== item) return
          this.expirePendingFor(rc)
          if (this.conns.get(rc.id) === rc && rc.status === 'waiting-fingerprint') {
            // 走 answer：同一帧形状 + 就绪门 reject（跳板 awaitJump 不能挂死）
            rc.answer('FINGERPRINT_TIMEOUT', '指纹确认超时，已断开')
          }
        }, HANDSHAKE_BUDGET_MS),
      }
      this.pending.set(token, item)
      rc.broadcast({ type: 'status', state: 'waiting-fingerprint', token, fingerprint, host: rc.label })
    } else if (known.fingerprint === fingerprint) {
      rc.status = 'connecting'
      verify(true)
    } else {
      // 主机指纹变化：拒绝连接，绝对不静默更新
      rc.status = 'error'
      rc.answer('HOST_KEY_MISMATCH', `主机指纹与已记录的(sha256:${known.fingerprint})不一致，已拒绝连接；如需信任新指纹请先在连接管理中重置该主机`)
      verify(false)
    }
  }

  /** Resolve every pending fingerprint belonging to rc: timer gone, verify(false). */
  expirePendingFor(rc) {
    for (const item of [...this.pending.values()]) {
      if (item.rc !== rc) continue
      this.pending.delete(item.token)
      clearTimeout(item.timer)
      rc.fp = null
      try { item.verify(false) } catch { /* verify must not throw, but never let it break cleanup */ }
    }
  }

  async confirmFingerprint(token, accept) {
    const item = this.pending.get(token)
    if (item === undefined) return { ok: false, error: '确认请求已过期或不存在' }
    clearTimeout(item.timer)
    this.pending.delete(token)
    const rc = item.rc
    // stale generation: the connection was re-initiated (or torn down) while
    // the user was deciding — the answer must never touch the new instance.
    // conns 以 runtimeId 键控：重连后的新实例是新 runtimeId ⇒ 查不到旧 rc 即失效。
    if (rc === undefined || rc.disposed || this.conns.get(rc.id) !== rc) {
      try { item.verify(false) } catch { /* ignore */ }
      return { ok: false, error: '该连接已重新发起，本次确认已失效' }
    }
    if (accept) {
      try {
        await this.store.recordFingerprint(item.connKey, item.fingerprint)
      } catch (error) {
        // 保存失败绝不静默放行：没有落盘的信任不能当作已确认（plan §8）
        try { item.verify(false) } catch { /* ignore */ }
        rc.answer('FINGERPRINT_SAVE_FAILED', `信任记录保存失败：${error?.message ?? error}；本次连接未继续`)
        return { ok: false, error: '信任记录保存失败' }
      }
      item.verify(true)
      if (rc.status === 'waiting-fingerprint') rc.status = 'connecting'
      return { ok: true }
    }
    item.verify(false)
    if (rc.status === 'waiting-fingerprint') {
      rc.answer('FINGERPRINT_REJECTED', '已拒绝该主机指纹，连接取消')
    }
    return { ok: true }
  }

  onReady(rc) {
    if (rc.disposed) return
    rc.status = 'connected'
    rc.settleReady() // 跳板 awaitJump 等的就是这一刻
    void this.store.touchConnected(rc.connId).catch(() => {})
    // U3/P2-1：本地转发随连接就绪建立（幂等；无规则时零动作）
    this.setupForwards(rc)
    if (rc.openShell === false) return // 跳板等辅助连接：只做通道，不开 shell
    // 连接就绪即开第一个 shell（默认 shell），其余由 viewer 显式 shell.open（方案 §4.1.3）
    this.openShell(rc, { cols: DEFAULT_COLS, rows: DEFAULT_ROWS }, (err, shell) => {
      if (rc.disposed) return
      if (err) {
        rc.status = 'error'
        rc.answer('SHELL_FAILED', `无法打开 shell: ${err.message}`)
        return
      }
      // TOFU 首连的真实时序：viewer 在「等待指纹确认」阶段就已经 attach（U0 契约：
      // 待指纹主机的主动作是打开终端、只 attach），那时还没有任何 shell ⇒ 它收到的
      // ready 帧 shellId 为 null。连接就绪、主 shell 建好后必须**补绑**这些 viewer 并
      // 逐个告知，否则前端永远拿不到 shellId ⇒ 之后每一帧 input/resize 都被
      // currentShell 判为绑定失效（实机验收逮住：指纹确认后终端仍不可用）。
      const summaries = shellSummaries(rc)
      for (const ws of [...rc.sockets]) {
        const bound = typeof ws.shellId === 'string' && rc.shells.get(ws.shellId) !== undefined
        if (!bound) this.bindShell(ws, shell)
        try {
          ws.send(JSON.stringify({
            type: 'ready', state: 'connected', runtimeId: rc.id,
            shellId: ws.shellId, mode: ws.mode, shells: summaries,
          }))
        } catch { /* gone */ }
      }
    })
  }

  // ------------------------------------------------------------------ shell channels（方案 §4.1）
  /** 在 runtime 的 ssh2 Client 上新开一个 shell channel；回调 (err, ShellChannel)。 */
  openShell(rc, { cols, rows } = {}, cb) {
    if (rc.disposed || rc.status !== 'connected' || rc.client === null) {
      cb(new Error('连接未就绪'))
      return
    }
    if (rc.shells.size >= MAX_SHELLS_PER_RUNTIME) {
      const err = new Error(`每个连接最多 ${MAX_SHELLS_PER_RUNTIME} 个 shell`)
      err.code = 'SHELL_LIMIT'
      cb(err)
      return
    }
    const seq = rc.shellSeq + 1
    rc.client.shell(
      { term: 'xterm-256color', cols: clampDim(cols, 2, MAX_COLS, DEFAULT_COLS), rows: clampDim(rows, 2, MAX_ROWS, DEFAULT_ROWS) },
      (err, stream) => {
        if (rc.disposed) return
        if (err) { cb(err); return }
        const shell = new ShellChannel(rc, seq, {
          cols: clampDim(cols, 2, MAX_COLS, DEFAULT_COLS),
          rows: clampDim(rows, 2, MAX_ROWS, DEFAULT_ROWS),
          title: shellTitle(rc, seq),
        })
        rc.shellSeq = seq
        rc.shells.set(shell.id, shell)
        shell.stream = stream
        stream.on('data', chunk => this.pushTo(shell, chunk))
        stream.stderr.on('data', chunk => this.pushTo(shell, Buffer.from(`\x1b[91m${chunk.toString('utf8')}\x1b[0m`)))
        // shell 结束 ≠ 连接结束（探针 A P4 基线）：仅关闭该 channel，
        // 标签保留为「会话已结束」，用户可在同一 runtime 重开 shell（方案 §4.1.5）
        stream.on('close', () => {
          shell.stream = null
          if (shell.ended) return
          shell.ended = true
          shell.writeOwner = null
          shell.broadcast({ type: 'shell.closed', shellId: shell.id, reason: 'exit' })
        })
        cb(null, shell)
      },
    )
  }

  /** viewer 请求新 shell：建好即把请求者切过去（写权归请求者）。 */
  openShellForViewer(ws, { cols, rows } = {}) {
    const rc = this.currentViewer(ws)
    if (rc === null) return
    if (rc.status !== 'connected') {
      ws.send(JSON.stringify({ type: 'error', code: 'NOT_CONNECTED', message: '连接未就绪，不能新建 shell' }))
      return
    }
    this.openShell(rc, { cols, rows }, (err, shell) => {
      if (err) {
        ws.send(JSON.stringify({ type: 'error', code: err.code ?? 'SHELL_FAILED', message: err.message }))
        return
      }
      // 请求者从旧 shell 解绑（写权释放），绑到新 shell
      this.unbindShell(ws)
      this.bindShell(ws, shell)
      ws.send(JSON.stringify({ type: 'shell.opened', shellId: shell.id, title: shell.title, mode: ws.mode }))
      this.replayTo(ws, shell)
    })
  }

  /** 关闭一个 shell channel（viewer 请求，owner-only；远端 exit 走 stream close 分支）。 */
  closeShellByViewer(ws, shellId) {
    const shell = this.currentShell(ws)
    if (shell === null) return
    if (shellId !== ws.shellId) {
      ws.send(JSON.stringify({ type: 'error', code: 'STALE_SHELL', message: '该 shell 不属于当前查看器' }))
      return
    }
    if (shell.writeOwner !== ws) {
      ws.send(JSON.stringify({ type: 'error', code: 'NOT_WRITE_OWNER', message: '只有写入方可关闭该 shell' }))
      return
    }
    shell.ended = true
    shell.writeOwner = null
    try { shell.stream?.end() } catch { /* gone */ }
    shell.broadcast({ type: 'shell.closed', shellId: shell.id, reason: 'closed-by-viewer' })
  }

  // ------------------------------------------------------------------ scrollback（每 shell 独立环 + runtime 总预算，方案 §4.1.4）
  pushTo(shell, chunk) {
    const u8 = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk))
    shell.sbChunks.push(u8)
    shell.sbLen += u8.length
    while (shell.sbLen > this.scrollbackBytes && shell.sbChunks.length > 1) {
      const dropped = shell.sbChunks.shift()
      shell.sbLen -= dropped.length
    }
    this.trimRuntimeBudget(shell)
    if (shell.viewers.size > 0) {
      for (const ws of [...shell.viewers]) {
        try {
          // backpressure: a viewer that stopped draining gets cut loose
          // instead of buffering the PTY forever（plan §8 洪泛有界）——按 shell 判定
          if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
            this.unbindShell(ws)
            try { ws.close(1011, 'viewer-too-slow') } catch { /* gone */ }
            continue
          }
          ws.send(u8)
        } catch { this.unbindShell(ws) }
      }
    }
  }

  /** runtime 总预算超限时，从最久未查看的 shell 环头部裁剪（不拒绝新 shell）。 */
  trimRuntimeBudget(exclude) {
    let total = 0
    for (const sh of exclude.rc.shells.values()) total += sh.sbLen
    if (total <= this.scrollbackBytesPerRuntime) return
    // LRU：lastViewedAt 最小者先裁（可裁到零；回放变短但实时输出不丢），
    // 全部裁光仍超限时才裁 exclude 自己。
    for (const sh of [...exclude.rc.shells.values()].sort((a, b) => a.lastViewedAt - b.lastViewedAt)) {
      while (total > this.scrollbackBytesPerRuntime && sh.sbChunks.length > 0) {
        const dropped = sh.sbChunks.shift()
        sh.sbLen -= dropped.length
        total -= dropped.length
      }
      if (total <= this.scrollbackBytesPerRuntime) break
    }
  }

  // ------------------------------------------------------------------ viewer binding（v2：ws ↔ (runtime, shell) 双绑定）
  bindShell(ws, shell) {
    ws.shellId = shell.id
    ws.mode = 'read'
    shell.viewers.add(ws)
    shell.lastViewedAt = this.now()
    // 写入所有权（决策 2：单写多读 + 显式接管）：空位即得写权
    if (shell.writeOwner === null && !shell.ended) {
      shell.writeOwner = ws
      ws.mode = 'write'
    }
  }

  unbindShell(ws) {
    const rc = ws.sshRc
    if (rc !== undefined && rc !== null) {
      const shell = rc.shells.get(ws.shellId)
      if (shell !== undefined) {
        shell.viewers.delete(ws)
        if (shell.writeOwner === ws) {
          shell.writeOwner = null
          // 写权空出：告知同 shell 其余只读 viewer（可接管）
          shell.broadcast({ type: 'write.open', shellId: shell.id })
        }
      }
    }
    ws.shellId = null
    ws.mode = 'read'
  }

  /** The RuntimeConn this viewer may still drive, or null (after notifying a stale one). */
  currentViewer(ws) {
    const rc = ws?.sshRc
    if (rc === undefined || rc === null) return null
    if (rc.disposed || this.conns.get(rc.id) !== rc) {
      if (ws.sshStale !== true) {
        ws.sshStale = true
        try { ws.send(JSON.stringify({ type: 'error', code: 'STALE_VIEWER', message: '该连接已重新发起，请返回连接管理重新打开终端' })) } catch { /* gone */ }
        try { ws.close() } catch { /* gone */ }
      }
      return null
    }
    return rc
  }

  /**
   * 绑定校验集中口（方案 §8 风险表）：viewer 必须仍附着、且其 shellId 绑定仍在。
   * 僵尸 viewer / 错 shellId 一律在此被拒 —— 输入/尺寸/关闭/接管四条路径都过它。
   */
  currentShell(ws) {
    const rc = this.currentViewer(ws)
    if (rc === null) return null
    const shell = rc.shells.get(ws.shellId)
    if (shell === undefined || shell.viewers.has(ws) !== true) {
      if (ws.sshStale !== true) {
        ws.sshStale = true
        try { ws.send(JSON.stringify({ type: 'error', code: 'STALE_SHELL', message: 'shell 已关闭或绑定失效，请重新打开该标签' })) } catch { /* gone */ }
      }
      return null
    }
    shell.lastViewedAt = this.now()
    return shell
  }

  attach(ws, msg) {
    const ticketItem = this.consumeTicket(msg.ticket)
    // shellSeq 由 index.js 从帧里透传（Number 或 undefined）
    if (ticketItem === null) {
      ws.send(JSON.stringify({ type: 'error', code: 'TICKET_INVALID', message: '附着票据无效、过期或已被使用；请刷新页面重试' }))
      try { ws.close() } catch { /* gone */ }
      return
    }
    const runtimeId = this.byProfile.get(ticketItem.connId)
    const rc = runtimeId !== undefined ? this.conns.get(runtimeId) : undefined
    if (rc === undefined) {
      ws.send(JSON.stringify({ type: 'error', code: 'NO_CONNECTION', message: '连接不存在或已关闭' }))
      try { ws.close() } catch { /* gone */ }
      return
    }
    // viewer binding: this socket may only drive the exact (runtime, shell) it attached to
    ws.sshRc = rc
    ws.sshStale = false
    if (!rc.sockets.has(ws)) rc.sockets.add(ws)

    let shell = null
    if (typeof msg.shellId === 'string' && msg.shellId.length > 0) shell = rc.shells.get(msg.shellId) ?? null
    // 刷新恢复路径：前端只有 shellSeq（workspace 快照），按 seq 解析
    if (shell === null && Number.isInteger(msg.shellSeq)) {
      for (const sh of rc.shells.values()) if (sh.seq === msg.shellSeq) { shell = sh; break }
    }
    if (shell === null) shell = rc.primaryShell()
    if (shell !== null) this.bindShell(ws, shell)

    ws.send(JSON.stringify({
      type: 'ready',
      runtimeId: rc.id,
      shellId: shell?.id ?? null,
      mode: ws.mode,
      state: rc.status,
      shells: shellSummaries(rc),
    }))
    // re-state current status so a fresh viewer never misses a waiting/error
    if (rc.status === 'waiting-fingerprint' && rc.fp) {
      ws.send(JSON.stringify({ type: 'status', state: 'waiting-fingerprint', token: rc.fp.token, fingerprint: rc.fp.fingerprint, host: rc.fp.host }))
    } else if (rc.status === 'error') {
      ws.send(JSON.stringify({ type: 'status', state: 'error', code: rc.lastErrorCode, message: rc.lastErrorMessage }))
    }
    // a live stream takes the viewer's initial size into the real PTY;
    // a replay of buffered output follows for both live and ended sessions
    if (shell !== null) {
      // 初始尺寸只在成为写入 owner 时才进 PTY：否则第二个 viewer 一 attach
      // 就会覆盖 owner 的尺寸（「最后一个 resize 获胜」的回潮，决策 2 禁止）。
      if (ws.mode === 'write' && shell.stream && (msg.cols !== undefined || msg.rows !== undefined)) {
        shell.cols = clampDim(msg.cols, 2, MAX_COLS, shell.cols)
        shell.rows = clampDim(msg.rows, 2, MAX_ROWS, shell.rows)
        try { shell.stream.setWindow(shell.rows, shell.cols, undefined, undefined) } catch { /* stream gone */ }
      }
      this.replayTo(ws, shell)
      // U2.4：附着即补发最近一次屏幕快照（精确恢复的 host 侧半边）
      if (shell.snapshotData !== null) {
        try { ws.send(JSON.stringify({ type: 'snapshot', shellId: shell.id, data: shell.snapshotData })) } catch { /* gone */ }
      }
    }
  }

  replayTo(ws, shell) {
    if (shell.sbChunks.length === 0) return
    try { ws.send(Buffer.concat(shell.sbChunks)) } catch { /* client gone */ }
  }

  // ------------------------------------------------------------------ viewer-bound input / resize / ownership
  // Input and size changes are routed through the ws's (runtime, shell) binding, never
  // by connId lookup — otherwise a zombie viewer from a replaced generation
  // would write into the new connection（plan §5.1 输入归属 / §8 多 shell 串写风险）。

  viewerInput(ws, shellId, data) {
    const shell = this.currentShell(ws)
    if (shell === null || typeof data !== 'string') return
    if (shellId !== ws.shellId) return // 绑定不符：忽略（currentShell 已对僵尸发过 STALE_SHELL）
    if (shell.writeOwner !== ws) {
      // 只读 viewer 的按键不进 PTY；一次性提示由 write.state 帧与 UI 常驻表达
      return
    }
    if (shell.stream) shell.stream.write(data)
  }

  viewerResize(ws, shellId, cols, rows) {
    const shell = this.currentShell(ws)
    if (shell === null) return
    if (shellId !== ws.shellId) return
    // 非 owner 的 resize 被拒绝 —— 不再「最后一个 resize 获胜」（决策 2 / 方案 §5.3）
    if (shell.writeOwner !== ws) return
    if (cols !== undefined) shell.cols = clampDim(cols, 2, MAX_COLS, shell.cols)
    if (rows !== undefined) shell.rows = clampDim(rows, 2, MAX_ROWS, shell.rows)
    if (shell.stream) {
      try { shell.stream.setWindow(shell.rows, shell.cols, undefined, undefined) } catch { /* stream gone */ }
    }
  }

  /** 显式接管写入权（决策 2）：原 owner 立即转只读并收到 write.revoked。 */
  takeoverShell(ws, shellId) {
    const shell = this.currentShell(ws)
    if (shell === null) return
    if (shellId !== ws.shellId) return
    if (shell.ended) {
      ws.send(JSON.stringify({ type: 'error', code: 'SHELL_ENDED', message: '该 shell 已结束，无法接管' }))
      return
    }
    const prev = shell.writeOwner
    if (prev === ws) return
    if (prev !== null) {
      prev.mode = 'read'
      try { prev.send(JSON.stringify({ type: 'write.revoked', shellId: shell.id })) } catch { /* gone */ }
    }
    shell.writeOwner = ws
    ws.mode = 'write'
    ws.send(JSON.stringify({ type: 'write.granted', shellId: shell.id }))
  }

  /** U2.4：viewer 上报屏幕快照（字符串，封顶 MAX_SNAPSHOT_BYTES，host 内存态不落盘）。 */
  storeSnapshot(ws, shellId, data) {
    const shell = this.currentShell(ws)
    if (shell === null || shellId !== ws.shellId) return
    if (typeof data !== 'string' || data.length === 0) return
    if (data.length > MAX_SNAPSHOT_BYTES) return
    shell.snapshotData = data
  }

  detach(ws) {
    const rc = ws.sshRc
    if (rc !== undefined && rc !== null) rc.sockets.delete(ws)
    this.unbindShell(ws)
    ws.sshRc = null
  }

  async disconnect(id) {
    const runtimeId = this.byProfile.get(id)
    const rc = runtimeId !== undefined ? this.conns.get(runtimeId) : undefined
    if (rc === undefined) return { ok: false }
    this.teardown(rc)
    this.conns.delete(rc.id)
    if (this.byProfile.get(id) === rc.id) this.byProfile.delete(id)
    return { ok: true }
  }

  // ------------------------------------------------------------------ teardown

  teardown(rc) {
    this.expirePendingFor(rc) // a discarded connection cannot keep a confirm window open
    this.expireTicketsFor(rc.connId)
    this.expireSftpTicketsFor(rc.connId)
    this.closeForwards(rc) // 本地监听先撤（否则跳板通道关了它还占着端口）
    try { rc.jumpChannel?.close?.() } catch { /* gone */ }
    try { rc.sftp?.end?.() } catch { /* ignore */ }
    try { rc.client && rc.client.end() } catch { /* ignore */ }
    for (const sh of rc.shells.values()) {
      try { sh.stream && sh.stream.end() } catch { /* ignore */ }
    }
    rc.status = 'closed'
    rc.settleReady(new Error('连接已放弃'))
    rc.broadcast({ type: 'status', state: 'closed', code: 'DISCARDED' })
    rc.dispose()
    if (this.byProfile.get(rc.connId) === rc.id) this.byProfile.delete(rc.connId)
  }

  async shutdown() {
    for (const rc of [...this.conns.values()]) {
      this.closeForwards(rc)
      rc.settleReady(new Error('runtime 已关闭'))
      try { rc.jumpChannel?.close?.() } catch { /* ignore */ }
      try { rc.sftp?.end?.() } catch { /* ignore */ }
      try { rc.client && rc.client.end() } catch { /* ignore */ }
      rc.sockets.clear()
      rc.dispose()
    }
    this.conns.clear()
    this.byProfile.clear()
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      try { item.verify(false) } catch { /* ignore */ }
    }
    this.pending.clear()
    for (const item of this.tickets.values()) clearTimeout(item.timer)
    this.tickets.clear()
    for (const item of this.sftpTickets.values()) clearTimeout(item.timer)
    this.sftpTickets.clear()
  }

  // Accepts either a raw Error (classified here) or an already-classified
  // { code, message } object passed through unchanged.
  bail(rc, error) {
    const info = error && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string'
      ? { code: error.code, message: error.message }
      : classifyError(error)
    rc.answer(info.code, info.message)
    rc.dispose()
  }
}

// U2.4 快照上限：单 shell 屏幕快照（serialize 串）的 host 侧内存封顶。
export const MAX_SNAPSHOT_BYTES = 128 * 1024

function shellTitle(rc, seq) {
  return seq === 1 ? rc.label : `${rc.label} #${seq}`
}

function shellSummaries(rc) {
  return [...rc.shells.values()].map(sh => ({
    shellId: sh.id,
    title: sh.title,
    state: sh.ended ? 'ended' : 'live',
    cols: sh.cols,
    rows: sh.rows,
  }))
}

// Exported for fault-injection tests (test/runtime.test.js): constructing a
// real RuntimeConn without going through ssh2 lets tests drive attach / push /
// viewer binding directly.
export class RuntimeConn {
  constructor(runtime, connId, record, { runtimeId = `rt-${randomUUID()}` } = {}) {
    this.runtime = runtime
    this.id = runtimeId       // runtimeId：内部实例标识（含 generation 语义）
    this.connId = connId      // profile id：对外名字（REST/路由不变）
    this.client = null
    this.status = 'connecting'
    this.sockets = new Set()  // 附着到本 runtime 的全部 viewer（含未绑 shell 的状态观察者）
    this.disposed = false
    this.connKey = null
    this.lastErrorCode = null
    this.lastErrorMessage = null

    // 三层身份：一个连接多个 shell，各自独立的 stream / 尺寸 / 回放环 / 写入权
    this.shells = new Map()   // shellId -> ShellChannel
    this.shellSeq = 0

    // U2.2 SFTP：连接级惰性会话 + home 缓存 + exec-only 记忆（zcode 降级链）
    this.sftpPromise = null
    this.sftp = null
    this.homeDir = null
    this.execOnlyUpload = false

    // U3/P2-1：跳板通道 + 本地转发（连接级，teardown 一并关闭）
    this.jumpChannel = null
    this.forwarders = new Map() // localPort -> forwarder
    this.openShell = true

    // 连接记录（转发规则与跳板引用的来源；listState 不直接外发它）
    this.record = record ?? null

    // 就绪门（U3/P2-1 跳板需要）：ready 时 resolve(rc)，终态（error/close/bail）时
    // reject(Error)。waiting-fingerprint 是中间态，不结算（确认窗口继续走）。
    this.readySettled = false
    this.readyPromise = new Promise((resolve, reject) => {
      this._resolveReady = resolve
      this._rejectReady = reject
    })
    // 常态下没人读就绪门（只有 awaitJump 显式等）—— 不挂 no-op catch 的话，
    // teardown/bail 的 reject 会以 unhandledRejection 炸出来。
    this.readyPromise.catch(() => { /* 见 awaitJump */ })

    this.label = record.label
  }

  /** readyPromise 的单次结算点（幂等）。 */
  settleReady(error = null) {
    if (this.readySettled) return
    this.readySettled = true
    if (error !== null && error !== undefined) this._rejectReady(error)
    else this._resolveReady(this)
  }

  /** 第一个未结束的 shell；全部结束则回最后一个（供回放）。 */
  primaryShell() {
    for (const sh of this.shells.values()) if (!sh.ended) return sh
    return [...this.shells.values()].at(-1) ?? null
  }

  broadcast(json) {
    if (this.sockets.size === 0) return
    const payload = JSON.stringify(json)
    for (const ws of this.sockets) {
      try { ws.send(payload) } catch { this.sockets.delete(ws) }
    }
  }

  answer(code, message) {
    this.status = 'error'
    this.lastErrorCode = code
    this.lastErrorMessage = message
    this.settleReady(new Error(message))
    this.broadcast({ type: 'status', state: 'error', code, message })
  }

  dispose() { this.disposed = true }
}

/** 一个 shell channel：独立 stream / 尺寸 / 回放环 / viewer 集合 / 写入所有权（方案 §4.1.1）。 */
export class ShellChannel {
  constructor(rc, seq, { cols, rows, title }) {
    this.rc = rc
    this.id = `sh-${seq}`     // runtime 内唯一（seq 单调递增）；跨 runtime 不冲突（绑定按 rc 归属）
    this.seq = seq
    this.stream = null
    this.cols = cols
    this.rows = rows
    this.title = title
    this.ended = false
    this.createdAt = Date.now()
    this.lastViewedAt = this.createdAt
    this.viewers = new Set()  // 附着到本 shell 的 viewer（ws）
    this.writeOwner = null    // 写入所有权：同一时刻至多一个 ws
    this.sbChunks = []
    this.sbLen = 0
    this.snapshotData = null  // U2.4：最近一次屏幕快照（serialize 串，内存态）
  }

  broadcast(json) {
    if (this.viewers.size === 0) return
    const payload = JSON.stringify(json)
    for (const ws of this.viewers) {
      try { ws.send(payload) } catch { this.viewers.delete(ws) }
    }
  }
}
