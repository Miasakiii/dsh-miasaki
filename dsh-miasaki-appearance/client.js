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
    // 玻璃档位白名单——与 lib/config.js 的 GLASS_LEVELS 保持一致（bundle 不能 import，
    // 两侧靠 host 白名单最终把关：非法值在 sanitizeConfig 回退 off）。
    const GLASS_LEVELS = ['off', 'light', 'frost', 'mica']
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
      // M2 §8 皮肤抽查：runtime.skin.spot 是 override 注册时记录的代表 token 期望值，
      // 这里补读实测 computed 值——判定（期望 vs 实测）在 host 侧 evaluateContract。
      const spot = runtime !== null && runtime.skin !== null && Array.isArray(runtime.skin.spot)
        ? runtime.skin.spot.map(s => ({ ...s, actual: safeTokenRead(s.name) }))
        : []
      // M2 S5：玻璃锚点命中事实（S1a 探针定稿的三条 slot 实盒子路径）。
      const glassSlot = (slot) => {
        const el = document.querySelector(`[data-slot="${slot}"]`)
        return el !== null && el.firstElementChild !== null
      }
      const safeGlass = document.documentElement.getAttribute('data-mia-glass') ?? 'off'
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
        glass: safeGlass,
        glassAnchors: {
          sidebar: glassSlot('sidebar'),
          mainConversation: glassSlot('main.conversation'),
          rightbar: glassSlot('rightbar'),
        },
        tokens: {
          aliasBgBase: read('--dsw-alias-bg-base'),
          staticDeepseek500: read('--dsw-static-deepseek-500'),
        },
        skinSpot: spot,
        desktopTheme: document.documentElement.hasAttribute('data-miasaki-theme'),
        // M2 S6：desktop 按协议让位时会置 data-miasaki-theme-yield 标记（02-core 的 setAttr）。
        // 「桌面壳在位却无让位标记」+ 本线皮肤接管 = 双引擎同时写 token，唯一不可接受的冲突。
        desktopYield: document.documentElement.getAttribute('data-miasaki-theme-yield') === 'skin',
        mia: document.documentElement.getAttribute('data-mia-appearance') ?? 'off',
      }
    }

    /** 读单个自定义属性的 computed 值；读不到返回空串（与期望值必然不等 → 契约降级黄条）。 */
    function safeTokenRead(name) {
      try {
        return getComputedStyle(document.body).getPropertyValue(name).trim()
      } catch {
        return ''
      }
    }

    // M2 S4 皮肤抽查的代表 token（背景最深端 / alias 跟随 / 品牌），期望值在注册时从表里取。
    const SPOT_NAMES = ['--dsw-static-neutral-bluish-950', '--dsw-alias-bg-base', '--dsw-static-deepseek-450']

    /**
     * 皮肤接管同步：按「总开关 + 配置皮肤」决定 overrideTokens 层的注册与回收。
     * 页面加载即调用（不等面板打开——boot style 撑首帧，这里接管运行时）；
     * 面板每次 save 成功后也调用（幂等：同皮肤已接管则不动）。
     * 同时维护 params 层（'appearance:params'，表面不透明度）——仅壁纸启用时生效，
     * 否则半透明表面透出的是空白画布而非壁纸（M2 §5.4）。
     * @param {boolean} forceScheme - 选中新皮肤时把官方三立方拨到皮肤原生明暗（M2 §3.2：
     *   只在**选中动作**时调一次，不持续锁定——用户随后改明暗不拉回）。
     */
    async function syncSkin(forceScheme) {
      try {
        const state = await requestJson('/state', { method: 'GET' })
        const skin = await requestJson('/skin', { method: 'GET' })
        const r = runtime
        if (r === null) return
        const theme = r.theme
        if (theme === undefined || typeof theme.overrideTokens !== 'function') return
        // M2 S6 双向保险：桌面壳在位却未让位（无 yield 标记）→ 不注册皮肤层，
        // 让 desktop 继续管配色；冲突原因经契约自检（override-conflict）在面板显示。
        const conflict = document.documentElement.hasAttribute('data-miasaki-theme')
          && document.documentElement.getAttribute('data-miasaki-theme-yield') !== 'skin'
        const want = state.config.enabled === true && skin.id !== 'pure' && skin.tokens !== null && !conflict
        // ---- skin 层
        if (!want) {
          if (r.skin !== null && r.skin.disposer !== null) {
            try { r.skin.disposer() } catch { /* 层已随主题服务回收 */ }
            r.skin = null
          }
        } else if (r.skin === null || r.skin.id !== skin.id) {
          if (r.skin !== null && r.skin.disposer !== null) {
            try { r.skin.disposer() } catch { /* ignore */ }
            r.skin = null
          }
          const disposer = theme.overrideTokens('appearance:skin', skin.tokens)
          r.skin = {
            id: skin.id,
            disposer,
            spot: SPOT_NAMES
              .filter(n => skin.tokens[n] !== undefined)
              .map(n => ({ name: n, expected: skin.tokens[n].light })),
          }
          if (forceScheme === true && skin.meta !== null && typeof theme.setTheme === 'function') {
            try { theme.setTheme(skin.meta.preferredScheme) } catch { /* 三立方拨动失败不阻断 */ }
          }
        }
        // ---- params 层（表面不透明度）：壁纸启用才有「透出壁纸」的意义
        const wantParams = want === true && skin.wallpaperActive === true && skin.surface !== null
        if (!wantParams) {
          if (r.params !== null && r.params.disposer !== null) {
            try { r.params.disposer() } catch { /* ignore */ }
            r.params = null
          }
        } else if (r.params === null || r.params.json !== JSON.stringify(skin.surface)) {
          if (r.params !== null && r.params.disposer !== null) {
            try { r.params.disposer() } catch { /* ignore */ }
          }
          const disposer = theme.overrideTokens('appearance:params', skin.surface)
          r.params = { json: JSON.stringify(skin.surface), disposer }
        }
      } catch {
        /* 皮肤接管失败保持原生观感（不打断页面，也不打断面板） */
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
      const [wallpapers, setWallpapers] = react.useState(null)

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
          requestJson('/wallpapers', { method: 'GET' }).then(setWallpapers).catch(() => setWallpapers(null))
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
          // 与 lib/config.js 的 buildBootScript 同源：配置写入成功后即时同步
          // <html> 门控属性，不等下次首帧（「开关往返」验收要求属性立即翻转）。
          try {
            const r = document.documentElement
            const config = next.config
            r.setAttribute('data-mia-appearance', config.enabled ? 'on' : 'off')
            r.setAttribute('data-mia-skin', config.theme.skin)
            r.setAttribute('data-mia-scheme', config.theme.scheme)
          } catch { /* 属性同步不允许影响面板 */ }
          // 皮肤相关的写入（总开关/皮肤选择）变化后重同步 override 层；
          // 选了新皮肤时把官方三立方拨到皮肤原生明暗（M2 §3.2，只此一次不锁定）。
          void syncSkin(patch != null && typeof patch === 'object'
            && patch.theme != null && typeof patch.theme === 'object'
            && patch.theme.skin !== undefined)
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
        '刻刻帝以深色为原生设计、狂狂帝以浅色为原生设计（选中即拨一次官方三立方，此后不锁定）——切到另一明暗会使用自动派生的对应色阶（M2 §3.1）。',
      ))

      // ---- 壁纸（M2 S5）
      children.push(sectionTitle('壁纸'))
      const wallpaper = state === null ? null : state.config.wallpaper
      if (wallpaper === null) {
        children.push(hint('配置未加载。'))
      } else {
        children.push(row(
          '图源',
          reactElementWallpaperPicker(wallpaper.source, wallpapers === null ? [] : wallpapers.local, busy, save),
          '内置为程序化渐变（零请求）；「本地」条目来自 ~/.dsh/miasaki-appearance/wallpapers/；留空即无壁纸。',
        ))
        children.push(row(
          '玻璃档位',
          react.createElement('div', { style: { display: 'flex', gap: '6px' } }, GLASS_LEVELS.map(level =>
            pillButton(level, wallpaper.glass === level, () => save({ wallpaper: { glass: level } }), busy))),
          'off = 原生；light/frost/mica 逐级增强模糊（仅侧栏 / 会话 / 右栏三个主表面，输入框降级为纯透明分层）。',
        ))
        children.push(row(
          '暗色遮罩',
          stepper(wallpaper.scrim, 0, 100, 10, v => save({ wallpaper: { scrim: v } }), busy),
          '0–100，压暗壁纸保证前景可读。',
        ))
        children.push(row(
          '晕影',
          stepper(wallpaper.vignette, 0, 100, 10, v => save({ wallpaper: { vignette: v } }), busy),
          '0–100，四角渐暗聚焦视线。',
        ))
        children.push(row(
          '表面不透明度',
          react.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px', alignItems: 'center' } }, [
            react.createElement('span', { key: 'l1', style: { fontSize: '12px', color: COLORS.text } }, '侧栏'),
            react.createElement('span', { key: 'v1' }, stepper(wallpaper.surface.sidebar, 0, 100, 10, v => save({ wallpaper: { surface: { sidebar: v } } }), busy)),
            react.createElement('span', { key: 'l2', style: { fontSize: '12px', color: COLORS.text } }, '会话'),
            react.createElement('span', { key: 'v2' }, stepper(wallpaper.surface.conversation, 0, 100, 10, v => save({ wallpaper: { surface: { conversation: v } } }), busy)),
            react.createElement('span', { key: 'l3', style: { fontSize: '12px', color: COLORS.text } }, '输入框'),
            react.createElement('span', { key: 'v3' }, stepper(wallpaper.surface.composer, 0, 100, 10, v => save({ wallpaper: { surface: { composer: v } } }), busy)),
            react.createElement('span', { key: 'l4', style: { fontSize: '12px', color: COLORS.text } }, '浮层'),
            react.createElement('span', { key: 'v4' }, stepper(wallpaper.surface.overlay, 0, 100, 10, v => save({ wallpaper: { surface: { overlay: v } } }), busy)),
          ]),
          '100 = 不透明。会话旋钮同时是全局基底（官方会话列直读 --dsw-alias-bg-base，无独立层，M2 §5.4 粒度说明）。',
        ))
      }

      // ---- 后续板块占位
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

    /** 通用数字步进（M2 S5 壁纸旋钮用）：－ 值 ＋ 一行，越界自动禁用。 */
    function stepper(value, min, max, step, onStep, disabled) {
      return react.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, [
        pillButton('－', false, () => onStep(Math.max(min, value - step)), disabled || value <= min),
        react.createElement('span', { key: 'v', style: { fontSize: '12px', color: COLORS.text, minWidth: '30px', textAlign: 'center' } }, String(value)),
        pillButton('＋', false, () => onStep(Math.min(max, value + step)), disabled || value >= max),
      ])
    }

    /** 壁纸图源选择器：内置渐变 + 本地文件 + 留空（无壁纸）。
     * 注意 local 清单由组件经参数传入（本函数在 factory 作用域，看不到组件的 state）。 */
    function reactElementWallpaperPicker(source, localList, busy, save) {
      const buttons = [pillButton('无', source === '', () => save({ wallpaper: { source: '' } }), busy)]
      for (const id of ['aurora', 'dusk', 'ember']) {
        buttons.push(pillButton(`内置·${id}`, source === `builtin:${id}`, () => save({ wallpaper: { source: `builtin:${id}` } }), busy))
      }
      for (const file of localList) {
        const short = file.length > 14 ? `${file.slice(0, 11)}…` : file
        buttons.push(pillButton(short, source === `/appearance/wallpaper/local/${encodeURIComponent(file)}`,
          () => save({ wallpaper: { source: `/appearance/wallpaper/local/${encodeURIComponent(file)}` } }), busy))
      }
      return react.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, buttons)
    }

    /** 皮肤选择器（M2 S4 起三皮肤全部可选）。 */
    function reactElementSkinPicker(skin, busy, save) {
      const options = [
        { id: 'pure', label: '纯净' },
        { id: 'zafkiel', label: '刻刻帝' },
        { id: 'kurkuriel', label: '狂狂帝' },
      ]
      return react.createElement('div', { style: { display: 'flex', gap: '6px' } }, options.map(option =>
        pillButton(
          option.label,
          skin === option.id,
          () => save({ theme: { skin: option.id } }),
          busy,
        )))
    }

    module.exports.inject = ['slots']

    module.exports.apply = (ctx) => {
      // 幂等守卫：DSH HMR / 重复 apply 不得叠加第二个设置栏。
      if (window[BOOT_FLAG] === true) return
      window[BOOT_FLAG] = true

      // theme 必须惰性取：client bundle 的 apply 早于官方主题服务挂载，
      // apply 时快照 ctx.get('theme') 会固化为 undefined（明暗/字号按钮全部
      // disabled，而契约自检每次重新 get 却显示通过——2026-09-12 实机所见）。
      // skin 是 overrideTokens 层的运行态（id/disposer/契约抽查期望值），syncSkin 维护。
      runtime = {
        ctx,
        skin: null,
        params: null,
        get theme() { return ctx.get('theme') },
      }
      // 页面加载即按配置接管皮肤（不等面板打开）。
      void syncSkin(false)

      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'appearance', order: 5, label: '外观' },
        AppearancePanel,
      ))

      ctx.effect(() => () => {
        window[BOOT_FLAG] = false
        if (runtime !== null) {
          for (const layer of [runtime.skin, runtime.params]) {
            if (layer !== null && layer.disposer !== null) {
              try { layer.disposer() } catch { /* 层已随主题服务回收 */ }
            }
          }
        }
        runtime = null
      }, 'appearance: boot flag')
    }

    return module.exports
  },
})
