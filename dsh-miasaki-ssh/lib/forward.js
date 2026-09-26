// 本地端口转发（U3/P2-1，design/2026-09-26-ssh-zcode-benchmark-plan.md §5-P2-1）。
// 形态：本机 127.0.0.1:localPort 起真 TCP 监听 ⇒ 每个入连接经 SSH 的
// direct-tcpip（client.forwardOut）送到**远端视角**的 remoteHost:remotePort。
//
// 边界（本形态的诚实收缩）：
//  * 只做本地转发 —— 远程/动态转发暴露面大，DSH web 插件形态下价值低，不做；
//  * 跳板不走本文件 —— 跳板是「另一条已受信任连接经 forwardOut 提供 sock」
//    （runtime.ensureJumpRuntime），复用 TOFU/凭据/票据，不另起一套；
//  * 服务端若不允许 TcpIpForward（AllowTcpForwarding no），forwardOut 回调带错
//    ⇒ 逐连接报错并广播，监听保持（用户改配置后新连接立即生效）。
import net from 'node:net'

export const FORWARD_LISTEN_HOST = '127.0.0.1'

/**
 * @param {{ client: object, spec: { localPort: number, remoteHost: string, remotePort: number },
 *   listenHost?: string, onEvent?: (event: object) => void }} options
 * @returns {{ spec: object, close: () => Promise<void>, stats: () => object }}
 */
export function createLocalForward({ client, spec, listenHost = FORWARD_LISTEN_HOST, onEvent }) {
  const state = {
    listening: false,
    actualPort: null,
    connections: 0,
    active: 0,
    bytes: 0,
    error: null,
    closed: false,
    channels: new Set(),
    sockets: new Set(),
  }
  const port = Number(spec.localPort)

  const server = net.createServer(socket => {
    if (state.closed) { socket.destroy(); return }
    state.sockets.add(socket)
    state.connections += 1
    state.active += 1
    let channel = null
    // 入连接的 data 监听必须**先于** forwardOut 挂上：快客户端的首字节可能在
    // 通道建立回调之前就到了（回调里再挂监听会丢数据 —— 真 TCP 往返测试逮住）。
    const pending = []
    socket.on('data', chunk => {
      state.bytes += chunk.length
      if (channel === null) { pending.push(chunk); return }
      try { channel.write(chunk) } catch { socket.destroy() }
    })
    const cleanup = () => {
      state.sockets.delete(socket)
      state.active = Math.max(0, state.active - 1)
      if (channel !== null) state.channels.delete(channel)
    }
    socket.on('error', () => { cleanup(); socket.destroy() })
    socket.on('close', cleanup)
    try {
      // srcIP/srcPort 对服务端无实际意义（direct-tcpip 由服务端发起出口连接）
      client.forwardOut('127.0.0.1', 0, spec.remoteHost, spec.remotePort, (err, ch) => {
        if (state.closed) { try { ch?.close?.() } catch { /* gone */ }; socket.destroy(); return }
        if (err !== null && err !== undefined) {
          // AllowTcpForwarding no / 服务端拒绝：逐连接如实报，监听不撤
          state.error = err.message
          onEvent?.({ type: 'channel-error', localPort: port, message: err.message })
          socket.destroy()
          return
        }
        channel = ch
        state.channels.add(ch)
        ch.on('data', chunk => { state.bytes += chunk.length; socket.write(chunk) })
        // direct-tcpip 的 stderr = extended data（对 shell-ish 通道才有意义，防御性带上）
        ch.stderr?.on('data', chunk => { state.bytes += chunk.length; socket.write(chunk) })
        ch.on('error', () => socket.destroy())
        ch.on('close', () => socket.end())
        // 通道就绪前到达的字节补发（顺序即到达顺序）
        for (const chunk of pending.splice(0)) {
          try { channel.write(chunk) } catch { socket.destroy(); break }
        }
        onEvent?.({ type: 'channel-open', localPort: port })
      })
    } catch (error) {
      // ssh2 在 socket 已断时同步抛 'Not connected'
      state.error = error.message
      onEvent?.({ type: 'channel-error', localPort: port, message: error.message })
      socket.destroy()
    }
  })
  server.on('error', error => {
    // EADDRINUSE 等：监听层失败必须让人看见（转发静默不生效比报错更糟）
    state.error = error.message
    onEvent?.({ type: 'listen-error', localPort: port, message: error.message })
  })
  server.listen(port, listenHost, () => {
    state.listening = true
    // localPort 传 0 时 OS 代管：真实端口只在listen后可知（诊断与 UI 都读它）
    state.actualPort = server.address()?.port ?? port
    onEvent?.({ type: 'listening', localPort: port, actualPort: state.actualPort })
  })

  const close = () => new Promise(resolve => {
    state.closed = true
    for (const ch of [...state.channels]) {
      // ssh2 channel 有 .close()；duplex 流替身（测试）只有 .destroy() —— 都要能收
      try {
        if (typeof ch.close === 'function') ch.close()
        else ch.destroy?.()
      } catch { /* gone */ }
    }
    for (const sock of [...state.sockets]) { try { sock.destroy() } catch { /* gone */ } }
    let settled = false
    const done = () => { if (settled) return; settled = true; resolve() }
    server.close(done)
    // 兜底：异常路径下 close 永不回调时不能挂住 teardown
    setTimeout(done, 500).unref()
  })

  return {
    spec,
    close,
    stats: () => ({
      localPort: port,
      actualPort: state.actualPort,
      listening: state.listening,
      connections: state.connections,
      active: state.active,
      bytes: state.bytes,
      error: state.error,
    }),
  }
}

/** 转发状态清单（WS 帧 / REST 共用的一种形状）。 */
export function forwardSummaries(forwarders) {
  return [...forwarders.values()].map(fwd => fwd.stats())
}
