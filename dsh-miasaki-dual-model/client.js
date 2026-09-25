// @miasaki/dsh-dual-model — Client half.
//
// 在输入框右下角（`conversation.input.right`，提交按钮之前的加法槽）渲染双模型控件：
// 折叠态一个 pill 按钮（主 ▸ 辅短名 + 状态点），展开态是与官方 ContextMeter 面板
// 同款表面的轻量配置面板（主/辅模型能力对照 + 图片归属状态条）。
//
// 形态说明：正式插件的 client bundle 由 `window.__ModuleLoader__.load` 装载，
// **没有** `host.call`（那是动态插件的 builtin），因此与 Host 的通信走同源
// JSON 路由 `/dual-model/api/*`。也不能 require 第三方包 —— 只用 `react`。
//
// 样式约定（2026-09-22 UI 优化）：
//   · 弹层表面 `--dsw-specific-menu` + `--dsw-elevation-prominent`，对齐官方
//     ContextMeter 面板（`JObwrW_panel`，与本槽位同处输入栏 trailing 区）；
//   · 折叠按钮 28px / 999px 圆角 / `--dsw-specific-selector` 底，hover 走
//     `--dsw-alias-interactive-bg-hover-solid`，对齐官方紧凑控件（`.add`）；
//   · 全部配色走 `--dsw-alias-*` / `--dsw-static-*` 真实令牌（浅/深主题自适应），
//     不再使用硬编码色（旧实现的 `--dsw-static-surface` 等令牌在 DSH 本体不存在，
//     背景恒回退 GitHub 深色，浅色主题下不可读）。
//
// 设计文档：design/2026-09-10-dual-model-design.md §5

window.__ModuleLoader__.load({
  id: '@miasaki/dsh-dual-model',
  factory: (require) => {
    const module = { exports: {} }
    const react = require('react')

    const API = '/dual-model/api'
    const BOOT_FLAG = '__DSH_DUAL_MODEL_BOOTED__'

    // 面板/按钮样式：类名前缀 `dsh-dual-model-` 与 canvas / ssh 两线惯例一致。
    // 全部使用 DSH 真实主题令牌；圆括号内 fallback 仅在令牌缺失时兜底。
    const PANEL_CSS = [
      '.dsh-dual-model-root{position:relative;display:inline-flex}',
      '.dsh-dual-model-trigger{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:0;border-radius:999px;flex:none;cursor:pointer;font:inherit;font-size:12px;line-height:1;background:var(--dsw-specific-selector,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,inherit);transition:background-color .1s}',
      '.dsh-dual-model-trigger:hover:not(:disabled),.dsh-dual-model-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.28))}',
      '.dsh-dual-model-trigger:focus-visible{outline:2px solid var(--dsw-static-deepseek-450,#4d6bfe);outline-offset:-1px}',
      '.dsh-dual-model-trigger:disabled{opacity:.5;cursor:default}',
      '.dsh-dual-model-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;box-shadow:0 0 0 1px var(--dsw-alias-border-l3,rgba(127,127,127,.35))}',
      '.dsh-dual-model-count{color:var(--dsw-alias-label-tertiary,#9ca3af);font-variant-numeric:tabular-nums}',
      '.dsh-dual-model-panel{position:absolute;bottom:calc(100% + 8px);right:0;z-index:100;box-sizing:border-box;width:288px;padding:12px;border:0;border-radius:12px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#fff));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1,rgba(127,127,127,.2));box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18));color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;line-height:20px;text-align:left}',
      '.dsh-dual-model-head{display:flex;align-items:center;gap:6px}',
      '.dsh-dual-model-title{color:var(--dsw-alias-label-primary,#111827);font-weight:600}',
      '.dsh-dual-model-close{margin-left:auto;width:22px;height:22px;display:grid;place-items:center;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;font:inherit;font-size:14px;line-height:1}',
      '.dsh-dual-model-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#111827)}',
      '.dsh-dual-model-sub{color:var(--dsw-alias-label-tertiary,#9ca3af);font-size:11px;margin:2px 0 10px}',
      '.dsh-dual-model-row{display:flex;align-items:center;gap:8px;min-height:24px}',
      '.dsh-dual-model-key{flex:0 0 52px;color:var(--dsw-alias-label-tertiary,#9ca3af)}',
      '.dsh-dual-model-name{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary,#111827)}',
      '.dsh-dual-model-badge{flex:none;font-size:10px;line-height:14px;padding:1px 6px;border-radius:999px;white-space:nowrap;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));color:var(--dsw-alias-label-tertiary,#9ca3af)}',
      '.dsh-dual-model-badge.is-ok{color:var(--dsw-alias-state-success-primary,#16a34a);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 45%,transparent)}',
      '.dsh-dual-model-block{margin:8px 0 2px}',
      '.dsh-dual-model-select{width:100%;box-sizing:border-box;height:28px;padding:0 26px 0 8px;appearance:none;cursor:pointer;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#111827);background-color:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 12 12\' fill=\'none\'%3E%3Cpath d=\'M3 4.5L6 7.5L9 4.5\' stroke=\'%2381858C\' stroke-width=\'1.2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:8px}',
      '.dsh-dual-model-select:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,#9ca3af)}',
      '.dsh-dual-model-select:focus-visible{outline:2px solid var(--dsw-static-deepseek-450,#4d6bfe);outline-offset:-1px}',
      '.dsh-dual-model-select:disabled{opacity:.55;cursor:default}',
      '.dsh-dual-model-hint{color:var(--dsw-alias-label-tertiary,#9ca3af);font-size:11px;margin-top:6px;line-height:16px}',
      '.dsh-dual-model-status{display:flex;align-items:flex-start;gap:6px;margin:10px 0;padding:8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));font-size:11px;line-height:16px}',
      '.dsh-dual-model-status-dot{flex:0 0 auto;width:7px;height:7px;margin-top:4px;border-radius:50%}',
      '.dsh-dual-model-foot{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.dsh-dual-model-foot input[type="checkbox"]{accent-color:var(--dsw-static-deepseek-450,#4d6bfe);margin:0;cursor:pointer}',
      '.dsh-dual-model-busy{margin-left:auto;color:var(--dsw-alias-label-tertiary,#9ca3af);font-size:11px}',
      '.dsh-dual-model-error{color:var(--dsw-alias-state-error-primary,#dc2626);font-size:11px;margin-top:8px;word-break:break-word;line-height:16px}',
    ].join('')

    /** 同源 JSON 请求；非 2xx 一律抛出可读错误。 */
    async function requestJson(path, init) {
      const options = Object.assign({ headers: { 'content-type': 'application/json' } }, init)
      if (options.body !== undefined && typeof options.body !== 'string') options.body = JSON.stringify(options.body)
      const response = await fetch(`${API}${path}`, options)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        const message = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
        throw new Error(message)
      }
      return payload
    }

    /** 模型 id → 人类可读短名（折叠态「主 ▸ 辅」用，宁短勿挤）。 */
    function shortModel(model, fallback) {
      const value = typeof model === 'string' && model !== '' ? model : fallback
      return value.length > 16 ? `${value.slice(0, 15)}…` : value
    }

    /** 状态点颜色：辅助模型管图用绿、主模型管图用品牌蓝、没人管用红、未配置/关闭用灰。 */
    function statusColor(state) {
      if (state === null) return 'var(--dsw-alias-label-tertiary, #9ca3af)'
      if (state.enabled !== true) return 'var(--dsw-alias-label-tertiary, #9ca3af)'
      if (state.imageOwner === 'none') return 'var(--dsw-alias-state-error-primary, #dc2626)'
      if (state.imageOwner === 'assist') return 'var(--dsw-alias-state-success-primary, #16a34a)'
      return 'var(--dsw-static-deepseek-450, #4d6bfe)'
    }

    /** 折叠态标签：「主 ▸ 辅」双短名（设计文档 §5.2 原意）。 */
    function triggerLabel(state) {
      if (state === null) return '双模型'
      if (state.enabled !== true) return '双模型 关'
      const primary = state.primary && state.primary.model ? String(state.primary.model) : ''
      const assist = state.assist && state.assist.model ? String(state.assist.model) : ''
      const p = primary !== '' ? shortModel(primary, '') : ''
      const a = assist !== '' ? shortModel(assist, '') : ''
      if (a === '') return p !== '' ? `双模型 · ${p}` : '双模型'
      if (p === '') return `双模型 ▸ ${a}`
      return `${p} ▸ ${a}`
    }

    /** 状态行文案 —— 把"隐式降级"变成显式契约。 */
    function statusLine(state, draftAttachments) {
      if (state === null) return '正在读取状态…'
      if (state.enabled !== true) return '已关闭：图片只由主模型处理'
      const assistName = state.assistName || (state.assist && state.assist.model) || '辅助模型'
      if (state.imageOwner === 'none') return '两个模型都不支持图片输入'
      if (state.imageOwner === 'assist') {
        return draftAttachments > 0
          ? `${draftAttachments} 个附件将由「${assistName}」处理`
          : `附件将交给「${assistName}」处理`
      }
      return draftAttachments > 0 ? `${draftAttachments} 个附件由主模型直接处理` : '主模型可直接读图'
    }

    /** 能力徽标：true→「看图」（语义绿）/ false→「纯文本」/ 未知→「未知」。 */
    function visionBadge(vision) {
      if (vision === true) {
        return react.createElement('span', { key: 'badge', className: 'dsh-dual-model-badge is-ok' }, '看图')
      }
      if (vision === false) {
        return react.createElement('span', { key: 'badge', className: 'dsh-dual-model-badge' }, '纯文本')
      }
      return react.createElement('span', { key: 'badge', className: 'dsh-dual-model-badge' }, '未知')
    }

    function DualModelControl(props) {
      const sessionId = props && props.sessionId !== undefined ? String(props.sessionId) : ''
      // `useInput` 是 conversation.input.right 的标准 props（实测恒在），但**必须带
      // selector 调用**：标准 kit 的 hook 是 SnapshotSelectorHook，内部直接转发给
      // useSyncExternalStoreWithSelector（无 identity 兜底）——无参调用会在订阅回调里
      // 抛 `selector is not a function`，整个控件渲染崩溃（2026-09-22 实操修复）。
      // 用常量兜底钩子保证 Hook 调用顺序稳定（props 在条目生命周期内不变，但兜底更稳）。
      const useInputHook = typeof props.useInput === 'function' ? props.useInput : () => 0
      // InputState 的草稿附件字段名是 `attachmentIds`（不是 imageIds）；
      // 本槽位的 kit 不提供 resolveDraftAttachments，无法细分图片/文件，故按附件计数。
      const draftAttachments = useInputHook((snapshot) => (
        snapshot && Array.isArray(snapshot.attachmentIds) ? snapshot.attachmentIds.length : 0
      ))

      const [open, setOpen] = react.useState(false)
      const [state, setState] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const rootRef = react.useRef(null)

      const load = react.useCallback(() => {
        let cancelled = false
        requestJson(`/state?sessionId=${encodeURIComponent(sessionId)}`)
          .then((next) => { if (!cancelled) { setState(next); setError(null) } })
          .catch((cause) => { if (!cancelled) setError(cause.message) })
        return () => { cancelled = true }
      }, [sessionId])

      react.useEffect(() => load(), [load])

      // 展开时重新拉一次，避免长时间停留在过期能力数据上。
      react.useEffect(() => {
        if (!open) return undefined
        return load()
      }, [open, load])

      // 展开态下：Esc 关闭、点击面板外关闭 —— 监听随 open 注册/销毁（effect 可逆）。
      react.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onMouseDown = (event) => {
          const root = rootRef.current
          if (root === null) return
          const target = event.target
          if (target instanceof Node && !root.contains(target)) setOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('mousedown', onMouseDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('mousedown', onMouseDown, true)
        }
      }, [open])

      const save = react.useCallback((patch) => {
        setBusy(true)
        requestJson(`/settings?sessionId=${encodeURIComponent(sessionId)}`, { method: 'POST', body: patch })
          .then((next) => { setState(next); setError(null) })
          .catch((cause) => setError(cause.message))
          .then(() => setBusy(false))
      }, [sessionId])

      const color = statusColor(state)
      // 触发器禁用条件（2026-09-23 回归修复）：只禁「保存中」与「首次加载尚未落定」。
      // 原实现是 `state === null`，而 load() 失败路径只 setError、**state 恒为 null**
      // （见上方 catch），于是 `/state` 一失败按钮就永久 disabled → 面板打不开 →
      // 面板内的错误行（error 只渲染在面板里）永远不可见 → 控件成死件，只能刷新页面。
      // 判据改为「state 与 error 皆空」＝仍在加载；出错即放行，点开面板既能看到错误，
      // 也会顺带触发 open 时的重新 load（重试入口）。
      const loading = state === null && error === null
      const disabled = busy || loading
      const title = state !== null
        ? statusLine(state, draftAttachments)
        : error !== null ? `双模型 · 读取失败：${error}` : '双模型'

      const trigger = react.createElement('button', {
        key: 'trigger',
        type: 'button',
        className: 'dsh-dual-model-trigger',
        title,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        disabled: loading,
        onClick: () => setOpen(!open),
        style: {
          opacity: state !== null && state.enabled !== true ? 0.55 : 1,
        },
      },
        react.createElement('span', {
          key: 'dot',
          className: 'dsh-dual-model-dot',
          style: { background: color },
        }),
        react.createElement('span', { key: 'label' }, triggerLabel(state)),
        draftAttachments > 0
          ? react.createElement('span', { key: 'count', className: 'dsh-dual-model-count' }, `·${draftAttachments}`)
          : null,
      )

      if (!open) {
        return react.createElement('div', { className: 'dsh-dual-model-root', ref: rootRef }, trigger)
      }

      const children = []

      // ---- 头部 ----
      children.push(react.createElement('div', {
        key: 'head',
        className: 'dsh-dual-model-head',
      },
        react.createElement('strong', { key: 'title', className: 'dsh-dual-model-title' }, '双模型'),
        react.createElement('button', {
          key: 'close',
          type: 'button',
          className: 'dsh-dual-model-close',
          'aria-label': '关闭',
          onClick: () => setOpen(false),
        }, '×'),
      ))
      children.push(react.createElement('div', {
        key: 'sub',
        className: 'dsh-dual-model-sub',
      }, '任一模型能看图，即可随消息发图；含图步骤由它处理。'))

      // ---- 主模型行（对照的另一半：host 已提供 primary/primaryVision）----
      const primaryModel = state !== null && state.primary && state.primary.model ? String(state.primary.model) : ''
      children.push(react.createElement('div', { key: 'primary', className: 'dsh-dual-model-row' },
        react.createElement('span', { key: 'key', className: 'dsh-dual-model-key' }, '主模型'),
        react.createElement('span', {
          key: 'name',
          className: 'dsh-dual-model-name',
          title: primaryModel,
        }, primaryModel !== '' ? shortModel(primaryModel, '') : '默认模型'),
        visionBadge(state !== null ? state.primaryVision : undefined),
      ))

      // ---- 辅助模型行 ----
      const assistModel = state !== null && state.assist && state.assist.model ? String(state.assist.model) : ''
      children.push(react.createElement('div', { key: 'assist-row', className: 'dsh-dual-model-row' },
        react.createElement('span', { key: 'key', className: 'dsh-dual-model-key' }, '辅助模型'),
        react.createElement('span', {
          key: 'name',
          className: 'dsh-dual-model-name',
          title: assistModel,
        }, assistModel !== '' ? shortModel(assistModel, '') : '未配置'),
        visionBadge(state !== null ? state.assistVision : undefined),
      ))

      // ---- 辅助模型选择 ----
      const visionModels = state !== null && Array.isArray(state.visionModels) ? state.visionModels : []
      const currentValue = state !== null && state.assist && state.assist.model
        ? `${state.assist.provider}\u0000${state.assist.model}`
        : ''
      const optionNodes = [react.createElement('option', { key: '__none', value: '' }, '未配置（图片只由主模型处理）')]
      const grouped = new Map()
      for (const model of visionModels) {
        const provider = String(model.provider)
        if (!grouped.has(provider)) grouped.set(provider, [])
        grouped.get(provider).push(model)
      }
      for (const [provider, models] of grouped) {
        const label = models[0] && models[0].providerName ? String(models[0].providerName) : provider
        optionNodes.push(react.createElement('optgroup', { key: provider, label },
          models.map(model => react.createElement('option', {
            key: `${model.provider}\u0000${model.id}`,
            value: `${model.provider}\u0000${model.id}`,
            title: String(model.id),
          }, `${model.name}`)),
        ))
      }

      children.push(react.createElement('div', { key: 'assist-block', className: 'dsh-dual-model-block' },
        react.createElement('select', {
          key: 'select',
          className: 'dsh-dual-model-select',
          disabled,
          value: currentValue,
          'aria-label': '辅助模型',
          onChange: (event) => {
            const value = String(event.target.value)
            if (value === '') { save({ assistProvider: '', assistModel: '' }); return }
            const [provider, model] = value.split('\u0000')
            save({ assistProvider: provider, assistModel: model })
          },
        }, optionNodes),
        visionModels.length === 0
          ? react.createElement('div', {
            key: 'empty',
            className: 'dsh-dual-model-hint',
          }, '未发现支持图片的模型 —— 请在「设置 → 模型」中配置带视觉能力的平台。')
          : null,
      ))

      // ---- 图片归属状态条 ----
      children.push(react.createElement('div', {
        key: 'status',
        className: 'dsh-dual-model-status',
        style: { color },
      },
        react.createElement('span', {
          key: 'dot',
          className: 'dsh-dual-model-status-dot',
          style: { background: color },
        }),
        react.createElement('span', { key: 'text' }, statusLine(state, draftAttachments)),
      ))

      // ---- 底部：启用开关 + 保存中 ----
      children.push(react.createElement('label', { key: 'enabled', className: 'dsh-dual-model-foot' },
        react.createElement('input', {
          key: 'checkbox',
          type: 'checkbox',
          checked: state !== null && state.enabled === true,
          disabled,
          onChange: (event) => save({ enabled: event.target.checked }),
        }),
        '启用双模型',
        busy
          ? react.createElement('span', { key: 'busy', className: 'dsh-dual-model-busy' }, '保存中…')
          : null,
      ))

      if (error !== null) {
        children.push(react.createElement('div', {
          key: 'error',
          className: 'dsh-dual-model-error',
        }, error))
      }

      const panel = react.createElement('div', {
        key: 'panel',
        className: 'dsh-dual-model-panel',
        role: 'dialog',
        'aria-label': '双模型配置',
      }, children)

      return react.createElement('div', { className: 'dsh-dual-model-root', ref: rootRef }, trigger, panel)
    }

    module.exports.inject = ['slots']

    module.exports.apply = (ctx) => {
      // 幂等守卫：DSH HMR / 重复 apply 不得叠加第二个控件。
      if (window[BOOT_FLAG] === true) return
      window[BOOT_FLAG] = true

      // 面板样式一次注入、随插件生命周期移除（effect 可逆）。
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-dual-model', 'panel')
        style.textContent = PANEL_CSS
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'dual-model: panel styles')

      ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
        { name: 'conversation.input.right', id: 'dual-model', order: 100, label: '双模型' },
        DualModelControl,
      ))

      ctx.effect(() => () => { window[BOOT_FLAG] = false }, 'dual-model: boot flag')
    }

    return module.exports
  },
})
