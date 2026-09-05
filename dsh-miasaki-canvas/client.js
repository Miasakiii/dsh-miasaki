window.__ModuleLoader__.load({
  id: '@miasaki/dsh-canvas',
  factory: (require) => {
    const module = { exports: {} }
    const react = require('react')
    const currentSession = ctx => {
      const snapshot = ctx.sessions.list.getSnapshot()
      const id = snapshot.current
      if (id === undefined) return null
      const session = snapshot.byId[id]
      return session === undefined ? null : { id, title: session.displayTitle, cwd: session.cwd ?? null }
    }
    const sessionSnapshot = ctx => {
      const snapshot = ctx.sessions.list.getSnapshot()
      return snapshot.ids.map(id => {
        const session = snapshot.byId[id]
        return session === undefined ? null : { id, title: session.displayTitle, cwd: session.cwd ?? null, parentId: session.parentId ?? null, blank: session.blank }
      }).filter(Boolean)
    }
    const workspaceSnapshot = ctx => {
      const sessions = ctx.sessions.list.getSnapshot()
      const snapshot = ctx.workspaces.list.getSnapshot()
      const accounted = new Set(snapshot.items.flatMap(workspace => workspace.sessionIds))
      return [
        ...snapshot.items.map(workspace => ({ id: workspace.workspaceId, title: workspace.title, path: workspace.path, sessionIds: workspace.sessionIds })),
        { id: 'dsh-ungrouped', title: '未分组', path: null, sessionIds: sessions.ids.filter(id => !accounted.has(id)) },
      ]
    }

    module.exports.inject = ['sessions', 'workspaces', 'slots']
    module.exports.apply = ctx => {
      // 幂等守卫：DSH HMR/页面重挂可能重复 apply，旧实例的 DOM/监听还没被回收
      // 时会叠加出两个「对话/会话布」按钮——同一页面只允许一份画布桥。
      if (window.__DSH_CANVAS_BOOTED__) return
      window.__DSH_CANVAS_BOOTED__ = true
      const prompt = async (sessionId, text) => {
        const scope = ctx.sessions.scope(sessionId)
        const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
        if (session === undefined) throw new Error('关联的 DSH 会话已不可用')
        const result = await session.prompt([{ type: 'text', text }], 'queue')
        if (!result.ok) throw new Error(result.error?.message ?? 'DSH 未接受这条消息')
      }
      const style = document.createElement('style')
      // 切换按钮走 DSH 会话头 actions 插槽（官方槽渲染、与「后台任务」同一 flex 行，
      // 结构上不可能叠压），配色全部用 DSH 主题令牌（激活胶囊随主题品牌色：
      // 原版蓝 / 刻刻帝绯红 / 狂狂帝血绯）。
      style.textContent = '.dsh-canvas-switch{display:flex;gap:2px;margin-left:2px;padding:3px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:999px;background:var(--dsw-alias-bg-overlay,rgba(255,255,255,.92));backdrop-filter:blur(10px)}.dsh-canvas-switch button{height:28px;border:0;border-radius:999px;background:transparent;padding:0 11px;color:var(--dsw-alias-label-secondary,#6b7280);font:600 12px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}.dsh-canvas-switch button:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}.dsh-canvas-switch button.active{background:var(--dsw-static-deepseek-450,#111827);color:var(--dsw-static-neutral-bluish-00,#fff)}.dsh-canvas-switch button:focus-visible{outline:2px solid var(--dsw-static-deepseek-450,#111827);outline-offset:2px}.dsh-canvas-overlay{position:fixed;z-index:100;inset:0;background:#f5f7fa}.dsh-canvas-overlay.is-opening{visibility:hidden}.dsh-canvas-overlay[hidden]{display:none}.dsh-canvas-overlay iframe{display:block;width:100%;height:100%;border:0}'
      document.head.append(style)
      const host = document.createElement('div')
      host.className = 'dsh-canvas-host'
      host.innerHTML = '<section class="dsh-canvas-overlay" hidden><iframe title="会话布" src="/canvas/"></iframe></section>'
      document.body.append(host)
      // 视图切换按钮：注册到官方会话头 actions 插槽（React 组件，DSH 渲染）
      const switchViewStore = { view: 'dialog', onChange: null }
      const setSwitchView = view => {
        switchViewStore.view = view
        if (switchViewStore.onChange) switchViewStore.onChange(view)
      }
      function ViewSwitch() {
        const [view, setView] = react.useState(switchViewStore.view)
        react.useEffect(() => {
          switchViewStore.onChange = setView
          return () => { if (switchViewStore.onChange === setView) switchViewStore.onChange = null }
        }, [])
        const showingMap = view === 'map'
        const switchTo = next => () => {
          setSwitchView(next)
          if (next === 'map') open()
          else close()
        }
        return react.createElement('div', { className: 'dsh-canvas-switch', role: 'group', 'aria-label': '视图切换' },
          react.createElement('button', { type: 'button', className: showingMap ? '' : 'active', 'aria-pressed': String(!showingMap), onClick: switchTo('dialog') }, '对话'),
          react.createElement('button', { type: 'button', className: showingMap ? 'active' : '', 'aria-pressed': String(showingMap), onClick: switchTo('map') }, '会话布'))
      }
      // 注册到官方会话头 actions 插槽（与「后台任务」同 slot 并排渲染，DSH 布局驱动，
      // 主题令牌自动适配；退出插件生命周期时由 slots 机制统一回收）
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'canvas-view-switch',
        order: 25,
      }, ViewSwitch))
      const overlay = host.querySelector('.dsh-canvas-overlay')
      const frame = host.querySelector('iframe')

      // close/open 收敛到 switchViewStore：React 按钮状态与面板行为单向同步
      const close = () => {
        window.clearTimeout(mapOpenFallback)
        mapOpening = false
        overlay.classList.remove('is-opening')
        overlay.hidden = true
        setSwitchView('dialog')
      }
      const send = (type, payload) => { frame.contentWindow?.postMessage({ source: 'dsh-canvas', type, ...payload }, location.origin) }
      let syncQueued = false
      let knownSessionIds = new Set()
      const liveUnsubscribers = new Map()
      const syncLiveSessions = () => {
        const snapshot = ctx.sessions.list.getSnapshot()
        for (const id of snapshot.ids) {
          if (liveUnsubscribers.has(id)) continue
          const scope = ctx.sessions.scope(id)
          const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
          if (session === undefined) continue
          const publish = () => {
            if (overlay.hidden) return
            const state = session.getSnapshot()
            const text = state.partial?.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n') ?? ''
            send('canvas:live-reply', { sessionId: id, running: state.running, text })
          }
          liveUnsubscribers.set(id, session.subscribe(publish))
          publish()
        }
        for (const [id, unsubscribe] of liveUnsubscribers) if (!snapshot.ids.includes(id)) { unsubscribe(); liveUnsubscribers.delete(id) }
      }
      const syncSessions = () => {
        if (syncQueued) return
        syncQueued = true
        queueMicrotask(() => {
          syncQueued = false
          const sessions = sessionSnapshot(ctx)
          const sessionIds = new Set(sessions.map(session => session.id))
          const removedSessionIds = [...knownSessionIds].filter(id => !sessionIds.has(id))
          knownSessionIds = sessionIds
          void fetch('/canvas/api/sessions/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessions, removedSessionIds }) }).catch(() => {})
        })
      }
      const syncTheme = () => {
        const dark = document.body?.hasAttribute?.('data-ds-dark-theme') === true
        send('canvas:theme', { dark })
      }
      const syncCurrentSession = () => {
        syncSessions()
        syncLiveSessions()
        syncTheme()
        if (!overlay.hidden) {
          send('canvas:workspaces', { workspaces: workspaceSnapshot(ctx) })
          send('canvas:current-session', { session: currentSession(ctx) })
        }
      }
      let mapOpenFallback = 0
      let mapOpening = false
      const showMapOverlay = () => {
        window.clearTimeout(mapOpenFallback)
        mapOpening = false
        overlay.hidden = false
        overlay.classList.remove('is-opening')
        syncCurrentSession()
      }
      const open = () => {
        window.clearTimeout(mapOpenFallback)
        mapOpening = true
        setSwitchView('map')
        // Keep the iframe laid out while hidden so its canvas can receive a
        // real scroll offset. display:none would clamp scrollTop back to zero.
        overlay.hidden = false
        overlay.classList.add('is-opening')
        window.requestAnimationFrame(() => {
          send('canvas:map-opened')
          syncCurrentSession()
        })
        mapOpenFallback = window.setTimeout(showMapOverlay, 300)
      }
      const onFrameLoad = () => {
        syncCurrentSession()
        if (mapOpening) send('canvas:map-opened')
      }
      const onMessage = event => {
        if (event.origin !== location.origin || event.data?.source !== 'dsh-canvas') return
        if (event.data.type === 'canvas:close') return close()
        if (event.data.type === 'canvas:map-ready') return showMapOverlay()
        if (event.data.type === 'canvas:request-current') {
          send('canvas:workspaces', { workspaces: workspaceSnapshot(ctx) })
          return send('canvas:current-session', { session: currentSession(ctx) })
        }
        if (event.data.type === 'canvas:open-session') {
          try { ctx.sessions.open(event.data.sessionId); close() } catch { send('canvas:bridge-error', { message: '关联的 DSH 会话已不可用' }) }
          // Best-effort anchor to the requested turn: chat nodes expose their
          // source event seq (anchorSeq) and render with data-chat-anchor-key,
          // so resolve seq -> node key -> scroll once the view materializes.
          const seq = event.data.seq
          if (Number.isInteger(seq)) {
            const tryScroll = attempt => {
              const scope = ctx.sessions.scope(event.data.sessionId)
              const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
              if (session === undefined) return
              const chat = session.getSnapshot()?.chat
              if (chat === undefined) return
              let key = undefined
              for (const node of chat.nodes.values()) {
                if (node.anchorSeq === seq) { key = node.key; break }
              }
              if (key !== undefined) {
                const row = document.querySelector(`[data-chat-anchor-key="${CSS.escape(key)}"]`)
                if (row instanceof HTMLElement) row.scrollIntoView({ block: 'start' })
                return
              }
              if (attempt < 3) window.setTimeout(() => tryScroll(attempt + 1), 500)
            }
            window.setTimeout(() => tryScroll(0), 300)
          }
          return
        }
        if (event.data.type === 'canvas:activate-session') {
          // Bidirectional current-session sync: switch DSH's current session
          // without closing the map; the sessions-list subscription re-sends
          // canvas:current-session so the map follows the new highlight.
          try { ctx.sessions.open(event.data.sessionId) } catch { send('canvas:bridge-error', { message: '关联的 DSH 会话已不可用' }) }
          return
        }
        if (event.data.type === 'canvas:fork-session') {
          const atSeq = Number.isInteger(event.data.atSeq) ? event.data.atSeq : undefined
          ctx.sessions.fork({ sessionId: event.data.sessionId, atSeq, increaseTitle: true }).then(id => {
            const snapshot = ctx.sessions.list.getSnapshot()
            send('canvas:forked-session', { requestId: event.data.requestId, session: { id, title: snapshot.byId[id]?.displayTitle ?? 'DSH 分支' } })
          }).catch(() => { send('canvas:bridge-error', { message: 'DSH 分支创建失败，请确认源会话已经完成当前轮次' }) })
          return
        }
        if (event.data.type === 'canvas:send-message') {
          const text = typeof event.data.text === 'string' ? event.data.text.trim() : ''
          if (text === '') return send('canvas:bridge-error', { requestId: event.data.requestId, message: '消息不能为空' })
          prompt(event.data.sessionId, text).then(() => {
            send('canvas:message-sent', { requestId: event.data.requestId, sessionId: event.data.sessionId })
          }).catch(error => {
            send('canvas:bridge-error', { requestId: event.data.requestId, message: error instanceof Error ? error.message : 'DSH 消息发送失败' })
          })
          return
        }
        if (event.data.type === 'canvas:create-session') {
          const workspaceId = typeof event.data.workspaceId === 'string' && event.data.workspaceId !== '' && event.data.workspaceId !== 'dsh-ungrouped' ? event.data.workspaceId : undefined
          const cwd = typeof event.data.cwd === 'string' && event.data.cwd !== '' ? event.data.cwd : undefined
          const create = workspaceId === undefined ? ctx.sessions.create(cwd === undefined ? {} : { cwd }) : ctx.sessions.create({ workspaceId })
          create.then(id => {
            const snapshot = ctx.sessions.list.getSnapshot()
            send('canvas:created-session', { requestId: event.data.requestId, session: { id, title: snapshot.byId[id]?.displayTitle ?? '新会话', cwd: snapshot.byId[id]?.cwd ?? cwd ?? null } })
          }).catch(() => { send('canvas:bridge-error', { requestId: event.data.requestId, message: 'DSH 会话创建失败，请先在 DSH 选择工作目录' }) })
        }
      }
      const onKeyDown = event => { if (event.key === 'Escape' && !overlay.hidden) close() }
      // Follow DSH's live theme switch: body[data-ds-dark-theme] is the web
      // client's dark-mode signal, mirrored into the map iframe via canvas:theme.
      const themeObserver = typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => syncTheme())
      if (themeObserver !== null && document.body) {
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
      }
      const unsubscribeSessions = ctx.sessions.list.subscribe(syncCurrentSession)
      const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(syncCurrentSession)
      frame.addEventListener('load', onFrameLoad)
      window.addEventListener('message', onMessage)
      window.addEventListener('keydown', onKeyDown)
      ctx.effect(() => () => {
        // 复位幂等守卫：允许后续（HMR 完整回收后/插件重装）重新挂载一份
        window.__DSH_CANVAS_BOOTED__ = false
        frame.removeEventListener('load', onFrameLoad)
        window.removeEventListener('message', onMessage)
        window.removeEventListener('keydown', onKeyDown)
        themeObserver?.disconnect()
        unsubscribeSessions()
        unsubscribeWorkspaces()
        for (const unsubscribe of liveUnsubscribers.values()) unsubscribe()
        host.remove()
        style.remove()
      }, 'canvas: web workspace switch')
    }
    return module.exports
  },
})
