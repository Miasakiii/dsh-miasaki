// @miasaki/dsh-dual-model — Client half.
//
// 在输入框右下角（`conversation.input.right`，提交按钮之前的加法槽）渲染双模型控件：
// 折叠态一个按钮 + 状态点，展开态配置辅助模型并显示"图片将由谁处理"。
//
// 形态说明：正式插件的 client bundle 由 `window.__ModuleLoader__.load` 装载，
// **没有** `host.call`（那是动态插件的 builtin），因此与 Host 的通信走同源
// JSON 路由 `/dual-model/api/*`。也不能 require 第三方包 —— 只用 `react`。
//
// 设计文档：design/2026-09-10-dual-model-design.md §5

window.__ModuleLoader__.load({
  id: '@miasaki/dsh-dual-model',
  factory: (require) => {
    const module = { exports: {} }
    const react = require('react')

    const API = '/dual-model/api'
    const BOOT_FLAG = '__DSH_DUAL_MODEL_BOOTED__'

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

    /** 把 provider/model 显示成人类可读的短名。 */
    function shortName(model, fallback) {
      const value = typeof model === 'string' && model !== '' ? model : fallback
      return value.length > 22 ? `${value.slice(0, 21)}…` : value
    }

    /** 状态点颜色：图片有人管用绿、没人管用红、未配置用黄。 */
    function statusColor(state) {
      if (state === null) return 'var(--dsw-static-neutral-500, #8b949e)'
      if (state.enabled !== true) return 'var(--dsw-static-neutral-500, #8b949e)'
      if (state.imageOwner === 'none') return '#f85149'
      if (state.imageOwner === 'assist') return '#3fb950'
      return '#58a6ff'
    }

    /** 折叠态的按钮文字。 */
    function buttonLabel(state) {
      if (state === null) return '双模型'
      if (state.enabled !== true) return '双模型 关'
      const assist = state.assist && state.assist.model ? String(state.assist.model) : ''
      if (assist === '') return '双模型'
      return `双模型 ▸ ${shortName(assist, '辅助')}`
    }

    /** 状态行文案 —— 把"隐式降级"变成显式契约。 */
    function statusLine(state, draftImages) {
      if (state === null) return '正在读取状态…'
      if (state.enabled !== true) return '已关闭：图片只由主模型处理'
      const assistName = state.assistName || (state.assist && state.assist.model) || '辅助模型'
      if (state.imageOwner === 'none') return '两个模型都不支持图片输入'
      if (state.imageOwner === 'assist') {
        return draftImages > 0
          ? `${draftImages} 张图片将由「${assistName}」处理`
          : `图片将交给「${assistName}」处理`
      }
      return draftImages > 0 ? `${draftImages} 张图片由主模型直接处理` : '主模型可直接读图'
    }

    function DualModelControl(props) {
      const sessionId = props && props.sessionId !== undefined ? String(props.sessionId) : ''
      // `useInput` 是 conversation.input.right 的标准 props（实测恒在），故无条件调用。
      const input = typeof props.useInput === 'function' ? props.useInput() : null
      const draftImages = input && Array.isArray(input.imageIds) ? input.imageIds.length : 0

      const [open, setOpen] = react.useState(false)
      const [state, setState] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [busy, setBusy] = react.useState(false)

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

      const save = react.useCallback((patch) => {
        setBusy(true)
        requestJson(`/settings?sessionId=${encodeURIComponent(sessionId)}`, { method: 'POST', body: patch })
          .then((next) => { setState(next); setError(null) })
          .catch((cause) => setError(cause.message))
          .then(() => setBusy(false))
      }, [sessionId])

      const color = statusColor(state)
      const disabled = busy || state === null

      const button = react.createElement('button', {
        type: 'button',
        title: state === null ? '双模型' : statusLine(state, draftImages),
        'aria-expanded': open,
        onClick: () => setOpen(!open),
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          height: '28px', padding: '0 8px', margin: '0 2px',
          background: 'transparent', border: '1px solid transparent', borderRadius: '6px',
          color: 'inherit', font: 'inherit', fontSize: '12px', cursor: 'pointer',
          opacity: state !== null && state.enabled !== true ? 0.55 : 1,
        },
      },
        react.createElement('span', {
          style: { width: '7px', height: '7px', borderRadius: '50%', background: color, flex: '0 0 auto' },
        }),
        react.createElement('span', null, buttonLabel(state)),
      )

      if (!open) return button

      const children = []
      children.push(react.createElement('div', {
        key: 'head',
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' },
      },
        react.createElement('strong', { style: { fontSize: '12px' } }, '双模型'),
        react.createElement('button', {
          type: 'button',
          onClick: () => setOpen(false),
          style: { background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '14px', lineHeight: 1, opacity: 0.7 },
        }, '×'),
      ))

      // 启用开关
      children.push(react.createElement('label', {
        key: 'enabled',
        style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', marginBottom: '8px' },
      },
        react.createElement('input', {
          type: 'checkbox',
          checked: state !== null && state.enabled === true,
          disabled,
          onChange: (event) => save({ enabled: event.target.checked }),
        }),
        '启用双模型',
      ))

      // 状态行
      children.push(react.createElement('div', {
        key: 'status',
        style: { fontSize: '11px', lineHeight: '1.5', color, marginBottom: '8px' },
      }, statusLine(state, draftImages)))

      // 辅助模型选择
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
          }, `${model.name} · ${model.id}`)),
        ))
      }

      children.push(react.createElement('label', {
        key: 'assist',
        style: { display: 'block', fontSize: '12px', marginBottom: '4px' },
      }, '辅助模型（支持图片的模型）'))
      children.push(react.createElement('select', {
        key: 'assist-select',
        disabled,
        value: currentValue,
        onChange: (event) => {
          const value = String(event.target.value)
          if (value === '') { save({ assistProvider: '', assistModel: '' }); return }
          const [provider, model] = value.split('\u0000')
          save({ assistProvider: provider, assistModel: model })
        },
        style: {
          width: '100%', boxSizing: 'border-box', padding: '4px 6px', fontSize: '12px',
          background: 'transparent', color: 'inherit', borderRadius: '6px',
          border: '1px solid var(--dsw-static-border, rgba(128,128,128,0.35))',
        },
      }, optionNodes))

      if (visionModels.length === 0) {
        children.push(react.createElement('div', {
          key: 'empty',
          style: { fontSize: '11px', opacity: 0.7, marginTop: '6px' },
        }, '未发现支持图片的模型 —— 请在「设置 → 模型」中配置带视觉能力的平台。'))
      }

      if (error !== null) {
        children.push(react.createElement('div', {
          key: 'error',
          style: { fontSize: '11px', color: '#f85149', marginTop: '8px', wordBreak: 'break-word' },
        }, error))
      }

      const panel = react.createElement('div', {
        key: 'panel',
        style: {
          position: 'absolute', bottom: 'calc(100% + 6px)', right: '0', zIndex: 40,
          width: '300px', padding: '10px 12px',
          background: 'var(--dsw-static-surface, #1c2128)',
          color: 'var(--dsw-static-text, inherit)',
          border: '1px solid var(--dsw-static-border, rgba(128,128,128,0.35))',
          borderRadius: '10px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          textAlign: 'left',
        },
      }, children)

      return react.createElement('div', { style: { position: 'relative', display: 'inline-flex' } }, button, panel)
    }

    module.exports.inject = ['slots']

    module.exports.apply = (ctx) => {
      // 幂等守卫：DSH HMR / 重复 apply 不得叠加第二个控件。
      if (window[BOOT_FLAG] === true) return
      window[BOOT_FLAG] = true

      ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
        { name: 'conversation.input.right', id: 'dual-model', order: 100, label: '双模型' },
        DualModelControl,
      ))

      ctx.effect(() => () => { window[BOOT_FLAG] = false }, 'dual-model: boot flag')
    }

    return module.exports
  },
})
