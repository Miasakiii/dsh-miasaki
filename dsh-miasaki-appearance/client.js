// @miasaki/dsh-appearance — Client half.
//
// 在「设置」里注册一栏「外观」（settings.section，id=appearance，order=5，紧跟官方「通用」）。
// M1 只做底座与契约自检：面板骨架 + 明暗/字号直通官方 API + 契约黄条 + 配置读写闭环；
// 皮肤 / 壁纸 / 动效 / 会话效果分别在 M2–M4 接入同一套管线。
//
// 形态说明：正式插件的 client bundle 由 `window.__ModuleLoader__.load` 装载，
// **没有** `host.call`（那是动态插件的 builtin），因此与 Host 的通信走同源
// JSON 路由 `/appearance/api/*`。也不能 require 第三方包 —— 只用 `react`。
//
// 设计文档：design/2026-09-11-appearance-m1-design.md
window.__ModuleLoader__.load({
  id: '@miasaki/dsh-appearance',
  factory: (require) => {
    // 装载器只把 `require` 交给 factory（manifest 契约：factory(require) → exports），
    // **不注入** `module` —— 必须自己声明，否则 factory 一执行就 ReferenceError。
    const module = { exports: {} }
    const react = require('react')

    const API = '/appearance/api'
    const BOOT_FLAG = '__DSH_APPEARANCE_BOOTED__'
    /** apply 时写入、卸载时清空 —— 组件靠它拿主题服务（slot props 里没有 ctx）。 */
    let runtime = null

    /** 同源 JSON 请求；非 2xx 一律抛出可读错误（409 单独标记以便上层处理）。 */
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
        const error = new Error(payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`)
        error.status = response.status
        error.payload = payload
        throw error
      }
      return payload
    }

    /**
     * 采集契约事实 —— 只采事实、不做判定：判定规则在 host 侧的 lib/config.js
     * （client 半不能 import，所以这段必须留在浏览器侧，但只负责读数）。
     */
    function collectProbe(ctx) {
      const theme = ctx.get('theme')
      const slots = ctx.get('slots')
      const body = document.body
      const read = (name) => {
        try {
          return getComputedStyle(body).getPropertyValue(name).trim() !== ''
        } catch {
          return false
        }
      }
      return {
        services: { theme: theme !== undefined, slots: slots !== undefined },
        themeMethods: {
          getTheme: theme !== undefined && typeof theme.getTheme === 'function',
          setTheme: theme !== undefined && typeof theme.setTheme === 'function',
          setFontSize: theme !== undefined && typeof theme.setFontSize === 'function',
          overrideTokens: theme !== undefined && typeof theme.overrideTokens === 'function',
        },
        anchors: {
          main: document.querySelector('[data-slot="main"]') !== null,
        },
        tokens: {
          aliasBgBase: read('--dsw-alias-bg-base'),
          staticDeepseek500: read('--dsw-static-deepseek-500'),
        },
        desktopTheme: document.documentElement.hasAttribute('data-miasaki-theme'),
      }
    }

    /** 读取官方主题快照里的叶子字段（不整体复制 live 对象）。 */
    function readThemeFacts(theme) {
      if (theme === undefined || typeof theme.getTheme !== 'function') return null
      try {
        const snapshot = theme.getTheme()
        return {
          preference: String(snapshot.preference),
          fontSize: Number(snapshot.fontSize),
          activeId: String(snapshot.active.id),
        }
      } catch {
        return null
      }
    }

    // ------------------------------------------------------------- 样式常量
    const COLORS = {
      text: 'var(--dsw-alias-label-primary, #e6e6e6)',
      sub: 'var(--dsw-alias-label-secondary, #9aa0a6)',
      border: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.28))',
      surface: 'var(--dsw-alias-bg-layer-1, #1c2128)',
      accent: 'var(--dsw-alias-brand-primary, #4176e6)',
    }

    function sectionTitle(text) {
      return react.createElement('div', {
        key: `t-${text}`,
        style: { fontSize: '13px', fontWeight: 600, color: COLORS.text, margin: '18px 0 8px' },
      }, text)
    }

    function hint(text) {
      return react.createElement('div', {
        key: `h-${text}`,
        style: { fontSize: '12px', lineHeight: '18px', color: COLORS.sub, marginTop: '6px' },
      }, text)
    }

    function row(label, control, note) {
      return react.createElement('div', {
        key: `r-${label}`,
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
          padding: '10px 12px', border: `1px solid ${COLORS.border}`, borderRadius: '10px',
          background: COLORS.surface, marginBottom: '8px',
        },
      }, [
        react.createElement('div', { key: 'l', style: { minWidth: 0 } }, [
          react.createElement('div', { key: 'n', style: { fontSize: '13px', color: COLORS.text } }, label),
          note === undefined ? null : react.createElement('div', {
            key: 'd', style: { fontSize: '11.5px', color: COLORS.sub, marginTop: '3px' },
          }, note),
        ]),
        react.createElement('div', { key: 'c', style: { flex: 'none' } }, control),
      ])
    }

    function pillButton(text, active, onClick, disabled) {
      return react.createElement('button', {
        key: text,
        type: 'button',
        disabled: disabled === true,
        onClick,
        style: {
          padding: '5px 12px', fontSize: '12px', borderRadius: '999px', cursor: disabled === true ? 'default' : 'pointer',
          border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
          background: active ? 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4176e6) 18%, transparent)' : 'transparent',
          color: active ? COLORS.text : COLORS.sub,
          opacity: disabled === true ? 0.5 : 1,
        },
      }, text)
    }

    /** 总开关：一个自绘滑块（避免依赖官方开关组件）。 */
    function toggle(enabled, onClick, disabled) {
      return react.createElement('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': enabled,
        disabled: disabled === true,
        onClick,
        style: {
          width: '42px', height: '24px', borderRadius: '999px', cursor: disabled === true ? 'default' : 'pointer',
          border: `1px solid ${enabled ? COLORS.accent : COLORS.border}`,
          background: enabled ? COLORS.accent : 'transparent',
          position: 'relative', padding: 0, opacity: disabled === true ? 0.5 : 1,
        },
      }, react.createElement('span', {
        style: {
          position: 'absolute', top: '2px', left: enabled ? '20px' : '2px', width: '18px', height: '18px',
          borderRadius: '50%', background: '#fff', transition: 'left .15s ease',
        },
      }))
    }

    // ------------------------------------------------------------------ 面板
    function AppearancePanel() {
      const [state, setState] = react.useState(null)
      const [contract, setContract] = react.useState(null)
      const [themeFacts, setThemeFacts] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [busy, setBusy] = react.useState(false)

      const ctx = runtime === null ? null : runtime.ctx
      const theme = runtime === null ? undefined : runtime.theme

      const refresh = async () => {
        try {
          const next = await requestJson('/state', { method: 'GET' })
          setState(next)
          setThemeFacts(readThemeFacts(theme))
          if (ctx !== null) {
            const verdict = await requestJson('/contract', { method: 'POST', body: { probe: collectProbe(ctx) } })
            setContract(verdict)
          }
          setError(null)
        } catch (e) {
          setError(String(e && e.message ? e.message : e))
        }
      }

      react.useEffect(() => {
        refresh()
      }, [])

      /** 写配置：带 expectedRevision，冲突时拉取服务端状态并提示重试。 */
      const save = async (patch) => {
        if (state === null) return
        setBusy(true)
        try {
          const next = await requestJson('/config', {
            method: 'POST',
            body: { patch, expectedRevision: state.revision },
          })
          setState(next)
          setError(null)
        } catch (e) {
          if (e && e.status === 409) {
            setState(e.payload)
            setError('配置已被其它窗口修改，已载入最新值，请重试本次修改。')
          } else {
            setError(String(e && e.message ? e.message : e))
          }
        } finally {
          setBusy(false)
        }
      }

      /** 明暗与字号直通官方 API —— 它们是官方偏好的第二个入口，不受总开关约束。 */
      const applyScheme = (scheme) => {
        if (theme === undefined || typeof theme.setTheme !== 'function') return
        try {
          theme.setTheme(scheme)
        } catch (e) {
          setError(String(e && e.message ? e.message : e))
          return
        }
        setThemeFacts(readThemeFacts(theme))
        save({ theme: { scheme } })
      }

      const stepFontSize = (delta) => {
        if (themeFacts === null || theme === undefined || typeof theme.setFontSize !== 'function') return
        const next = Math.min(17, Math.max(12, themeFacts.fontSize + delta))
        try {
          theme.setFontSize(next)
        } catch (e) {
          setError(String(e && e.message ? e.message : e))
          return
        }
        setThemeFacts(readThemeFacts(theme))
        save({ theme: { fontSize: next } })
      }

      const children = []

      children.push(react.createElement('div', {
        key: 'title',
        style: { fontSize: '15px', fontWeight: 600, color: COLORS.text },
      }, '外观'))

      // ---- 契约状态条
      if (contract !== null) {
        const issues = Array.isArray(contract.issues) ? contract.issues : []
        const ok = contract.ok === true
        children.push(react.createElement('div', {
          key: 'contract',
          style: {
            marginTop: '10px', padding: '8px 12px', borderRadius: '10px', fontSize: '12px', lineHeight: '18px',
            border: `1px solid ${ok ? 'var(--dsw-alias-state-success-primary, #3fb950)' : 'var(--dsw-alias-state-warn-primary, #d29922)'}`,
            color: ok ? COLORS.text : 'var(--dsw-alias-state-warn-primary, #d29922)',
          },
        }, ok
          ? '契约自检通过：官方插槽与主题接口均在位。'
          : `契约自检：${issues.length} 项降级（不影响页面可用性）· ` + issues.map(i => i.message).join('；')))
      }

      if (error !== null) {
        children.push(react.createElement('div', {
          key: 'error',
          style: { marginTop: '8px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #f85149)' },
        }, error))
      }

      // ---- 总开关
      children.push(sectionTitle('启用'))
      children.push(row(
        '外观定制总开关',
        toggle(state !== null && state.config.enabled === true, () => {
          save({ enabled: !(state !== null && state.config.enabled === true) })
        }, state === null || busy),
        '关闭时本线对页面零影响：不覆盖任何 token、不注入任何样式。',
      ))

      // ---- 主题（M1 可用部分）
      children.push(sectionTitle('主题'))
      const preference = themeFacts === null ? 'system' : themeFacts.preference
      children.push(row(
        '明暗偏好',
        react.createElement('div', { style: { display: 'flex', gap: '6px' } }, [
          pillButton('浅色', preference === 'light', () => applyScheme('light'), theme === undefined),
          pillButton('深色', preference === 'dark', () => applyScheme('dark'), theme === undefined),
          pillButton('跟随系统', preference === 'system', () => applyScheme('system'), theme === undefined),
        ]),
        '与官方「通用 → 外观」是同一个偏好（底层同为 ctx.theme.setTheme），改动立即生效。',
      ))
      children.push(row(
        '正文字号',
        react.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
          pillButton('－', false, () => stepFontSize(-1), themeFacts === null || themeFacts.fontSize <= 12),
          react.createElement('span', { key: 'v', style: { fontSize: '12px', color: COLORS.text, minWidth: '38px', textAlign: 'center' } },
            `${themeFacts === null ? '—' : themeFacts.fontSize} px`),
          pillButton('＋', false, () => stepFontSize(1), themeFacts === null || themeFacts.fontSize >= 17),
        ]),
        '官方字号轴 12–17px，仅影响会话内容。',
      ))
      const skin = state === null ? 'pure' : state.config.theme.skin
      children.push(row(
        '皮肤',
        reactElementSkinPicker(skin, busy, save),
        'M2 接入：刻刻帝 / 狂狂帝（复用 desktop 线既有色阶）。当前仅「纯净」= 不改任何颜色。',
      ))

      // ---- 后续板块占位
      children.push(sectionTitle('壁纸'))
      children.push(hint('M2：图源 / 玻璃档位 / 表面不透明度 / 暗色遮罩 / 晕影。'))
      children.push(sectionTitle('动效'))
      children.push(hint('M3：会话入场 / 侧栏 / 新会话 / 设置面板，三套预设 + 强度倍率 + 减弱动态降级。'))
      children.push(sectionTitle('会话效果'))
      children.push(hint('M4：消息密度与最大宽度 / 流式光标 / 代码块与引用样式 / 工具卡折叠 / 字体。'))

      // ---- 运行信息
      children.push(sectionTitle('运行信息'))
      children.push(hint(
        `配置修订 ${state === null ? '—' : state.revision} · ` +
        `持久化 ${state !== null && state.persistent === true ? '已启用' : '未启用（dataDir 缺失，改动仅存在于内存）'} · ` +
        `皮肤门控 ${document.documentElement.getAttribute('data-mia-appearance') ?? '—'}`,
      ))

      return react.createElement('div', {
        style: { padding: '4px 2px 24px', font: '13px/1.6 system-ui, "Segoe UI", sans-serif', color: COLORS.text },
      }, children)
    }

    /** 皮肤选择器（M1 只有纯净可选，其余按钮禁用并标注里程碑）。 */
    function reactElementSkinPicker(skin, busy, save) {
      const options = [
        { id: 'pure', label: '纯净', ready: true },
        { id: 'zafkiel', label: '刻刻帝', ready: false },
        { id: 'kurkuriel', label: '狂狂帝', ready: false },
      ]
      return react.createElement('div', { style: { display: 'flex', gap: '6px' } }, options.map(option =>
        pillButton(
          option.ready ? option.label : `${option.label}·M2`,
          skin === option.id,
          () => { if (option.ready) save({ theme: { skin: option.id } }) },
          !option.ready || busy,
        )))
    }

    module.exports.inject = ['slots']

    module.exports.apply = (ctx) => {
      // 幂等守卫：DSH HMR / 重复 apply 不得叠加第二个设置栏。
      if (window[BOOT_FLAG] === true) return
      window[BOOT_FLAG] = true

      runtime = { ctx, theme: ctx.get('theme') }

      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'appearance', order: 5, label: '外观' },
        AppearancePanel,
      ))

      ctx.effect(() => () => {
        window[BOOT_FLAG] = false
        runtime = null
      }, 'appearance: boot flag')
    }

    return module.exports
  },
})
