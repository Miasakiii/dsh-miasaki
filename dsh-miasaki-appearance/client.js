// @miasaki/dsh-appearance — Client half.
//
// 在「设置」里注册一栏「外观」（settings.section，id=appearance，order=5，紧跟官方「通用」）。
// M1 只做底座与契约自检：面板骨架 + 明暗/字号直通官方 API + 契约黄条 + 配置读写闭环；
// 皮肤 / 壁纸 / 动效 / 会话效果分别在 M2–M4 接入同一套管线。
//
// 形态说明：正式插件的 client bundle 由 `window.__ModuleLoader__.load` 装载，
// **没有** `host.call`（那是动态插件的 builtin），因此与 Host 的通信走同源
// JSON 路由 `/appearance/api/*`。也不能 require 第三方包 —— 只用 `react` 与
// 前端壳 staticModules 里的官方 seed 模块。
//
// 面板风格（2026-09-21，M2.6）：全面对齐官方「通用设置」页 —— 0.5px 分隔线 +
// 16px 行距、14px/22 标题、12px/18 三级说明、明暗立方与步进器控件，取值一律
// 照 `@deepseek-ai/dsh-client-ui-theme`（AppearanceRow / FontSizeRow）与
// `@deepseek-ai/dsh-client-ui-settings-general`（SettingsRoot）的官方 CSS；
// 交互控件直接复用官方 primitives（Button / Switch / Pill / 图标）—— 它们是
// 前端壳 seed 模块（staticModules），`require` 即得，无需 `dsh.client.external`
// 声明（seed 词不产生图边）。自有样式经 `.mia-*` 前缀 CSS 注入，不依赖官方
// 哈希类名（锚点纪律见 README）。
//
// 设计文档：design/2026-09-11-appearance-m1-design.md
window.__ModuleLoader__.load({
  id: '@miasaki/dsh-appearance',
  factory: (require) => {
    // 装载器只把 `require` 交给 factory（manifest 契约：factory(require) → exports），
    // **不注入** `module` —— 必须自己声明，否则 factory 一执行就 ReferenceError。
    const module = { exports: {} }
    const react = require('react')
    // 官方 UI 原语：与「通用设置」页同源（前端壳 staticModules 的 seed 模块）。
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Button, Switch, Pill } = primitives

    const API = '/appearance/api'
    const BOOT_FLAG = '__DSH_APPEARANCE_BOOTED__'
    // 玻璃档位白名单——与 lib/config.js 的 GLASS_LEVELS 保持一致（bundle 不能 import，
    // 两侧靠 host 白名单最终把关：非法值在 sanitizeConfig 回退 off）。
    const GLASS_LEVELS = [
      { id: 'off', label: '关闭' },
      { id: 'light', label: '轻' },
      { id: 'frost', label: '磨砂' },
      { id: 'mica', label: '云母' },
    ]
    // 内置壁纸渐变（host 侧 builtin: 前缀的展示名）。
    const BUILTIN_WALLPAPERS = [
      { id: 'aurora', label: '极光' },
      { id: 'dusk', label: '暮色' },
      { id: 'ember', label: '余烬' },
    ]
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
     * @param {object} ctx - 客户端上下文。
     * @param {object|null} state - 最近一次 /state 的响应（M2.5：判 host 半是否已认识 avatar 字段）。
     */
    function collectProbe(ctx, state) {
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
        // M2.5：host 半是否已下发 avatar 板块。client 更新而 host 未重启时这里是 false，
        // 面板据此显示「重启 dsh web」提示，而不是让头像设置静默失效（写进去也会被旧 host 丢掉）。
        avatarField: state !== null && state !== undefined && typeof state === 'object'
          && state.config !== undefined && state.config !== null
          ? state.config.avatar !== undefined
          : undefined,
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

    // ------------------------------------------------------- 软件头像（M2.5）
    /** 头像文件由 host 在同源路由下服务；面板的 <img> 直接用它做预览。 */
    const AVATAR_PREFIX = '/appearance/avatar/'
    /** 归一化后的最长边（px）：桌面壳只拿它做 16–256px 的图标，512 足够且体积可控。 */
    const AVATAR_MAX_EDGE = 512

    /**
     * 把用户选的任意图片重编码成 PNG data URL（最长边压到 AVATAR_MAX_EDGE、保持比例）。
     *
     * 归一化刻意放在浏览器侧：host 只接受 PNG（因为桌面壳只依赖 `png` crate，
     * 不引入 jpeg/webp 解码器），让浏览器做重编码比在 host 里挂解码器便宜得多，
     * 也让「面板上传」与「手动放目录」两条路径落到同一种格式上。
     * @param {File} file - 用户选中的图片文件。
     * @returns {Promise<string>} `data:image/png;base64,…`。
     */
    async function imageToPngDataUrl(file) {
      const bitmap = await createImageBitmap(file)
      try {
        const scale = Math.min(1, AVATAR_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
        const width = Math.max(1, Math.round(bitmap.width * scale))
        const height = Math.max(1, Math.round(bitmap.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const painter = canvas.getContext('2d')
        if (painter === null) throw new Error('当前浏览器不支持 canvas 2d 上下文')
        painter.drawImage(bitmap, 0, 0, width, height)
        return canvas.toDataURL('image/png')
      } finally {
        if (typeof bitmap.close === 'function') bitmap.close()
      }
    }

    /** 弹出系统文件选择框（不依赖 React ref：未挂载到文档的 input 同样能 click）。 */
    function pickImageFile(onPick, onError) {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.onchange = () => {
        const file = input.files !== null && input.files !== undefined && input.files.length > 0 ? input.files[0] : null
        if (file === null || file === undefined) return
        Promise.resolve(onPick(file)).catch(error => {
          onError(String(error !== null && error !== undefined && error.message ? error.message : error))
        })
      }
      input.click()
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

    // ------------------------------------------------------- 面板样式（M2.6）
    // 取值逐条对照官方「通用设置」页：行 = FontSizeRow.row（0.5px 分隔线 + 16px 行距）、
    // 标题/说明 = row.title / row.desc、明暗立方 = AppearanceRow.themeCube（选中态
    // bg-module-platform + neutral-bluish-400 边）、步进器 = FontSizeRow.stepper
    // （悬停露出上下箭头）。token 全部走 --dsw-* 官方变量，跟着皮肤与明暗自动解析。
    const PANEL_CSS = `
.mia-panel{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;display:flex}
.mia-group{flex-direction:column;display:flex}
.mia-groupTitle{color:var(--dsw-alias-label-primary);margin:0;padding:20px 0 0;font-size:14px;font-weight:500;line-height:22px}
.mia-group>:last-child{padding-bottom:20px}
.mia-row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}
.mia-group>.mia-row:last-child{border-bottom:none}
.mia-rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}
.mia-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.mia-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}
.mia-control{align-items:center;gap:8px;display:inline-flex}
.mia-cubeRow{flex-wrap:wrap;align-items:stretch;gap:8px;display:flex}
.mia-cube{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border-radius:20px;flex-direction:column;flex:180px;justify-content:center;align-items:center;gap:4px;padding:20px 32px;font-size:14px;line-height:22px;display:flex}
.mia-cube:hover:not(.mia-selected){background:var(--dsw-alias-interactive-bg-hover)}
.mia-cube:disabled{cursor:default;opacity:.5}
.mia-selected{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-static-neutral-bluish-400)}
.mia-stepper{background:var(--dsw-alias-bg-module-platform);border-radius:18px;justify-content:center;align-items:center;min-width:72px;height:36px;display:inline-flex;position:relative}
.mia-value{text-align:center;font-variant-numeric:tabular-nums;min-width:18px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.mia-unit{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}
.mia-arrows{opacity:0;flex-direction:column;gap:2px;display:flex;position:absolute;right:8px}
.mia-stepper:hover .mia-arrows,.mia-stepper:focus-within .mia-arrows{opacity:1}
.mia-arrow{background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 75%, transparent);width:17px;height:12px;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:3px;justify-content:center;align-items:center;padding:0;display:inline-flex}
.mia-arrow:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}
.mia-arrow:disabled{color:var(--dsw-alias-label-caption);cursor:default}
.mia-knobGrid{grid-template-columns:auto 1fr auto 1fr;gap:8px 12px;align-items:center;display:grid}
.mia-knobLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.mia-picker{flex-wrap:wrap;align-items:center;gap:8px;display:flex}
.mia-notice{color:var(--dsw-alias-state-warn-label);margin:0;padding:20px 0 0;font-size:12px;line-height:18px}
.mia-noticeOk{color:var(--dsw-alias-state-success-primary)}
.mia-error{color:var(--dsw-alias-state-error-primary);margin:0;padding:8px 0 0;font-size:12px;line-height:18px}
.mia-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
.mia-iconGrid{grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px;padding:16px 0 4px;display:grid}
.mia-iconCell{box-sizing:border-box;border:.5px solid transparent;background:0 0;border-radius:12px;flex-direction:column;align-items:center;gap:8px;padding:12px 6px 10px;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;display:flex}
.mia-iconCell:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mia-iconCell:disabled{cursor:default;opacity:.5}
.mia-iconCell.is-active{border-color:var(--dsw-static-neutral-bluish-400);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}
.mia-iconImg{border-radius:14px;width:56px;height:56px;object-fit:cover;background:0 0;display:block}
.mia-iconLabel{text-align:center;font-size:12px;line-height:18px}
`
    const PANEL_CSS_ID = '@miasaki/dsh-appearance/panel.css'
    // 与官方 client 插件同一注入式（factory 体内、按 data-plugin-css 去重）：
    // 样式随模块物化进入 head，HMR 重挂时查询去重不重复注入。
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${PANEL_CSS_ID}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@miasaki/dsh-appearance'
      tag.dataset.pluginCss = PANEL_CSS_ID
      tag.textContent = PANEL_CSS
      document.head.appendChild(tag)
    }

    // ------------------------------------------------------------- 行构造
    /** 分组：组标题（官方组标题规格 14px/22/500）+ 组内行。 */
    function group(title, children) {
      return react.createElement('div', {
        key: `g-${title}`,
        className: 'mia-group',
      }, [
        react.createElement('div', { key: 't', className: 'mia-groupTitle' }, title),
        ...children,
      ])
    }

    /** 设置行：左标题 + 说明，右控件（官方 FontSizeRow.row 规格）。 */
    function row(title, desc, control) {
      return react.createElement('div', {
        key: `r-${title}`,
        className: 'mia-row',
      }, [
        react.createElement('div', { key: 'l', className: 'mia-rowText' }, [
          react.createElement('div', { key: 't', className: 'mia-title' }, title),
          desc === undefined ? null : react.createElement('div', { key: 'd', className: 'mia-desc' }, desc),
        ]),
        react.createElement('div', { key: 'c', className: 'mia-control' }, control),
      ])
    }

    /** 三段说明文字（官方 desc / hint 规格 12px/18 三级色）。 */
    function hint(text) {
      return react.createElement('div', { key: `h-${text}`, className: 'mia-hint' }, text)
    }

    /** 官方 Pill 原语：分段选择（皮肤 / 玻璃档位 / 图源 / 头像清单）。 */
    function pill(text, active, onClick, disabled) {
      return react.createElement(Pill, {
        key: text,
        active: active === true,
        'aria-pressed': active === true,
        disabled: disabled === true,
        onClick,
      }, text)
    }

    /** 官方 Button 原语（outline = 主操作，ghost = 次操作，sm 尺寸）。 */
    function outlineButton(text, onClick, disabled) {
      return react.createElement(Button, { key: text, variant: 'outline', size: 'sm', disabled: disabled === true, onClick }, text)
    }

    function ghostButton(text, onClick, disabled) {
      return react.createElement(Button, { key: text, variant: 'ghost', size: 'sm', disabled: disabled === true, onClick }, text)
    }

    /** 官方 Switch 原语：总开关（role=switch + aria-checked，样式随皮肤）。 */
    function masterSwitch(enabled, onClick, disabled) {
      return react.createElement(Switch, {
        checked: enabled === true,
        disabled: disabled === true,
        label: '外观定制总开关',
        title: '关闭时本线对页面零影响',
        onChange: (next) => onClick(next === true),
      })
    }

    /** 明暗立方：与官方「通用 → 外观」同一控件（图标 + 文案，选中态平台底）。 */
    const SCHEME_CUBES = [
      { id: 'light', label: '浅色', Icon: primitives.IconLightOutline16 },
      { id: 'dark', label: '深色', Icon: primitives.IconDarkOutline16 },
      { id: 'system', label: '跟随系统', Icon: primitives.IconFollowsystemOutline16 },
    ]

    function schemeCubes(preference, onPick, disabled) {
      return react.createElement('div', { key: 'cubes', className: 'mia-cubeRow' }, SCHEME_CUBES.map(({ id, label, Icon }) =>
        react.createElement('button', {
          key: id,
          type: 'button',
          className: `mia-cube${preference === id ? ' mia-selected' : ''}`,
          'aria-pressed': preference === id,
          disabled: disabled === true,
          onClick: () => onPick(id),
        }, [
          react.createElement(Icon, { key: 'i' }),
          label,
        ])))
    }

    /**
     * 官方步进器：－ 值 ＋ 收进一枚平台底胶囊，悬停 / 聚焦时右缘露出上下箭头。
     * value 为 null 时显示占位符并禁用（配置未加载）。
     */
    function stepper(value, min, max, step, onStep, disabled, label) {
      const shown = value === null || value === undefined ? '—' : String(value)
      const off = disabled === true || value === null || value === undefined
      return react.createElement('div', { key: `s-${label}-${shown}`, className: 'mia-stepper' }, [
        react.createElement('span', { key: 'v', className: 'mia-value' }, shown),
        react.createElement('span', { key: 'a', className: 'mia-arrows' }, [
          react.createElement('button', {
            key: 'up', type: 'button', className: 'mia-arrow', 'aria-label': `增大${label}`,
            disabled: off || value >= max, onClick: () => onStep(Math.min(max, value + step)),
          }, react.createElement(primitives.IconChevronUpOutline14, { key: 'i', size: 9 })),
          react.createElement('button', {
            key: 'down', type: 'button', className: 'mia-arrow', 'aria-label': `减小${label}`,
            disabled: off || value <= min, onClick: () => onStep(Math.max(min, value - step)),
          }, react.createElement(primitives.IconChevronDownOutline14, { key: 'i', size: 9 })),
        ]),
      ])
    }

    // ------------------------------------------------------------------ 面板
    function AppearancePanel() {
      const [state, setState] = react.useState(null)
      const [contract, setContract] = react.useState(null)
      const [themeFacts, setThemeFacts] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [wallpapers, setWallpapers] = react.useState(null)
      // M2.5：头像目录清单（「已有头像」选择器消费）。刻意放在 state 队列末尾，
      // 让 test/client.test.js 的 stateQueue 注入顺序保持稳定。
      const [avatars, setAvatars] = react.useState(null)
      // M2.7：应用图标预设清单（九宫格消费；来自 /presets，host 会顺带把图标落进 avatars/）。
      const [presets, setPresets] = react.useState(null)

      const ctx = runtime === null ? null : runtime.ctx
      const theme = runtime === null ? undefined : runtime.theme

      const refresh = async () => {
        try {
          const next = await requestJson('/state', { method: 'GET' })
          setState(next)
          setThemeFacts(readThemeFacts(theme))
          if (ctx !== null) {
            const verdict = await requestJson('/contract', { method: 'POST', body: { probe: collectProbe(ctx, next) } })
            setContract(verdict)
          }
          requestJson('/wallpapers', { method: 'GET' }).then(setWallpapers).catch(() => setWallpapers(null))
          requestJson('/avatars', { method: 'GET' }).then(setAvatars).catch(() => setAvatars(null))
          // /presets 会顺带把预设图标落到 avatars/（幂等），因此它同时刷新了本地清单。
          requestJson('/presets', { method: 'GET' })
            .then(result => {
              setPresets(Array.isArray(result.presets) ? result.presets : null)
              if (Array.isArray(result.local)) setAvatars({ local: result.local })
            })
            .catch(() => setPresets(null))
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

      /**
       * 上传头像：浏览器归一化 → host 落盘 → 立刻启用。
       * 两步是刻意的：/avatar 只写文件不改配置，启用与否由随后的 /config 决定
       * （这样「上传了但先不启用」也是合法状态，且不会顶掉用户已选的头像）。
       */
      const uploadAvatar = (file) => {
        if (state === null) return Promise.resolve()
        setBusy(true)
        return imageToPngDataUrl(file)
          .then(dataUrl => requestJson('/avatar', { method: 'POST', body: { dataUrl } }))
          .then(result => {
            if (Array.isArray(result.local)) setAvatars({ local: result.local })
            return save({ avatar: { source: result.url } })
          })
          .catch(e => setError(String(e && e.message ? e.message : e)))
          .finally(() => setBusy(false))
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

      // ---- 契约状态条（官方 notice 规格：12px/18，warn / success 着色）
      if (contract !== null) {
        const issues = Array.isArray(contract.issues) ? contract.issues : []
        const ok = contract.ok === true
        children.push(react.createElement('div', {
          key: 'contract',
          className: `mia-notice${ok ? ' mia-noticeOk' : ''}`,
        }, ok
          ? '契约自检通过：官方插槽与主题接口均在位。'
          : `契约自检：${issues.length} 项降级（不影响页面可用性）· ` + issues.map(i => i.message).join('；')))
      }

      if (error !== null) {
        children.push(react.createElement('div', { key: 'error', className: 'mia-error' }, error))
      }

      // ---- 启用（总开关）
      children.push(group('启用', [
        row(
          '外观定制总开关',
          '关闭时本线对页面零影响：不覆盖任何 token、不注入任何样式。',
          masterSwitch(state !== null && state.config.enabled === true, (next) => {
            save({ enabled: next })
          }, state === null || busy),
        ),
      ]))

      // ---- 主题（M1 可用部分；明暗立方与步进器照官方通用设置页）
      children.push(group('主题', [
        schemeCubes(
          themeFacts === null ? 'system' : themeFacts.preference,
          applyScheme,
          theme === undefined,
        ),
        row(
          '正文字号',
          '官方字号轴 12–17px，仅影响会话内容。',
          [
            stepper(themeFacts === null ? null : themeFacts.fontSize, 12, 17, 1, stepFontSize, themeFacts === null || theme === undefined, '字号'),
            react.createElement('span', { key: 'u', className: 'mia-unit' }, 'px'),
          ],
        ),
        row(
          '皮肤',
          '刻刻帝以深色为原生设计、狂狂帝以浅色为原生设计（选中即拨一次官方三立方，此后不锁定）——切到另一明暗会使用自动派生的对应色阶（M2 §3.1）。',
          reactElementSkinPicker(state === null ? 'pure' : state.config.theme.skin, busy, save),
        ),
      ]))

      // ---- 壁纸（M2 S5）
      const wallpaper = state === null ? null : state.config.wallpaper
      children.push(group('壁纸', wallpaper === null ? [hint('配置未加载。')] : [
        row(
          '图源',
          '内置为程序化渐变（零请求）；「本地」条目来自 ~/.dsh/miasaki-appearance/wallpapers/；留空即无壁纸。',
          reactElementWallpaperPicker(wallpaper.source, wallpapers === null ? [] : wallpapers.local, busy, save),
        ),
        row(
          '玻璃档位',
          '关闭 = 原生；轻 / 磨砂 / 云母 逐级增强模糊（仅侧栏 / 会话 / 右栏三个主表面，输入框降级为纯透明分层）。',
          react.createElement('div', { key: 'glass', className: 'mia-picker' }, GLASS_LEVELS.map(level =>
            pill(level.label, wallpaper.glass === level.id, () => save({ wallpaper: { glass: level.id } }), busy))),
        ),
        row(
          '暗色遮罩',
          '0–100，压暗壁纸保证前景可读。',
          stepper(wallpaper.scrim, 0, 100, 10, v => save({ wallpaper: { scrim: v } }), busy, '暗色遮罩'),
        ),
        row(
          '晕影',
          '0–100，四角渐暗聚焦视线。',
          stepper(wallpaper.vignette, 0, 100, 10, v => save({ wallpaper: { vignette: v } }), busy, '晕影'),
        ),
        row(
          '表面不透明度',
          '100 = 不透明。会话旋钮同时是全局基底（官方会话列直读 --dsw-alias-bg-base，无独立层，M2 §5.4 粒度说明）。',
          reactElementSurfaceKnobs(wallpaper.surface, busy, save),
        ),
      ]))

      // ---- 应用图标（M2.5 自定义 + M2.7 预设）
      const avatar = state === null || state.config === null || state.config === undefined || state.config.avatar === undefined
        ? null
        : state.config.avatar
      const presetList = presets !== null && presets !== undefined && Array.isArray(presets.presets) ? presets.presets : null
      const localFiles = avatars !== null && avatars !== undefined && Array.isArray(avatars.local) ? avatars.local : []
      // 「我的上传」= avatars 目录里除预设之外的文件（预设由 host 生成，不属于用户资产）。
      const myFiles = localFiles.filter(file => !file.startsWith('preset-'))
      children.push(group('应用图标', avatar === null ? [hint(state === null
        ? '配置未加载。'
        : 'Host 半尚未认识该板块（见上方契约提示）：请重启 dsh web，否则图标设置写不进去。')] : [
        presetList === null ? hint('预设清单加载中…') : reactElementIconGrid(presetList, avatar.source, busy, save),
        row('自定义', '上传自己的图片（会自动转成 PNG、最长边 512），或把 PNG 放进 ~/.dsh/miasaki-appearance/avatars/ 后从下方清单里选。', [
          outlineButton('上传图片…', () => pickImageFile(uploadAvatar, setError), busy),
          ghostButton('清除', () => save({ avatar: { source: '' } }), busy || avatar.source === ''),
        ]),
        myFiles.length === 0 ? null : reactElementAvatarPicker(avatar.source, myFiles, busy, save),
        hint(
          '点选即用：桌面端（Miasaki.exe）读同一份配置，约 1–2 秒内窗口 / 任务栏 / 托盘图标跟着变；' +
          '「清除」回退出厂图标。注意：EXE 文件自身、桌面 / 开始菜单快捷方式的静态图标属于构建期资源，不随此处变化。',
        ),
      ]))

      // ---- 后续板块占位
      children.push(group('动效', [hint('M3：会话入场 / 侧栏 / 新会话 / 设置面板，三套预设 + 强度倍率 + 减弱动态降级。')]))
      children.push(group('会话效果', [hint('M4：消息密度与最大宽度 / 流式光标 / 代码块与引用样式 / 工具卡折叠 / 字体。')]))

      // ---- 运行信息
      children.push(group('运行信息', [hint(
        `配置修订 ${state === null ? '—' : state.revision} · ` +
        `持久化 ${state !== null && state.persistent === true ? '已启用' : '未启用（dataDir 缺失，改动仅存在于内存）'} · ` +
        `皮肤门控 ${document.documentElement.getAttribute('data-mia-appearance') ?? '—'}`,
      )]))

      return react.createElement('div', { className: 'mia-panel' }, children)
    }

    /**
     * 应用图标九宫格（M2.7）：每格一枚预设图标的预览 + 名称，点选即写 `avatar.source`。
     * 预览图直接吃 host 的同源路由（预设图标此刻已落在 avatars 目录，与用户上传的图同源）。
     */
    function reactElementIconGrid(presets, source, busy, save) {
      return react.createElement('div', { key: 'icon-grid', className: 'mia-iconGrid' }, presets.map(preset => {
        const active = source === preset.url
        return react.createElement('button', {
          key: preset.id,
          type: 'button',
          className: active === true ? 'mia-iconCell is-active' : 'mia-iconCell',
          'aria-pressed': active === true,
          disabled: busy === true,
          title: preset.label,
          onClick: () => save({ avatar: { source: preset.url } }),
        }, [
          react.createElement('img', { key: 'i', className: 'mia-iconImg', src: preset.url, alt: '' }),
          react.createElement('span', { key: 'l', className: 'mia-iconLabel' }, preset.label),
        ])
      }))
    }

    /** 头像选择器：目录里已有的文件（含手动放入的）+ 「不使用」。 */
    function reactElementAvatarPicker(source, localList, busy, save) {
      const buttons = [pill('不使用', source === '', () => save({ avatar: { source: '' } }), busy)]
      for (const file of localList) {
        const url = `${AVATAR_PREFIX}${encodeURIComponent(file)}`
        const short = file.length > 18 ? `${file.slice(0, 15)}…` : file
        buttons.push(pill(short, source === url, () => save({ avatar: { source: url } }), busy))
      }
      return react.createElement('div', { key: 'avatar-sources', className: 'mia-picker' }, buttons)
    }

    /** 壁纸图源选择器：内置渐变 + 本地文件 + 留空（无壁纸）。
     * 注意 local 清单由组件经参数传入（本函数在 factory 作用域，看不到组件的 state）。 */
    function reactElementWallpaperPicker(source, localList, busy, save) {
      const buttons = [pill('无', source === '', () => save({ wallpaper: { source: '' } }), busy)]
      for (const { id, label } of BUILTIN_WALLPAPERS) {
        buttons.push(pill(`内置 · ${label}`, source === `builtin:${id}`, () => save({ wallpaper: { source: `builtin:${id}` } }), busy))
      }
      for (const file of localList) {
        const short = file.length > 14 ? `${file.slice(0, 11)}…` : file
        const url = `/appearance/wallpaper/local/${encodeURIComponent(file)}`
        buttons.push(pill(short, source === url, () => save({ wallpaper: { source: url } }), busy))
      }
      return react.createElement('div', { key: 'wallpaper-sources', className: 'mia-picker' }, buttons)
    }

    /** 皮肤选择器（M2 S4 起三皮肤全部可选）。 */
    function reactElementSkinPicker(skin, busy, save) {
      const options = [
        { id: 'pure', label: '纯净' },
        { id: 'zafkiel', label: '刻刻帝' },
        { id: 'kurkuriel', label: '狂狂帝' },
      ]
      return react.createElement('div', { key: 'skins', className: 'mia-picker' }, options.map(option =>
        pill(
          option.label,
          skin === option.id,
          () => save({ theme: { skin: option.id } }),
          busy,
        )))
    }

    /** 表面不透明度四旋钮（2×2 网格：侧栏 / 会话 / 输入框 / 浮层）。 */
    function reactElementSurfaceKnobs(surface, busy, save) {
      const knobs = [
        { key: 'sidebar', label: '侧栏' },
        { key: 'conversation', label: '会话' },
        { key: 'composer', label: '输入框' },
        { key: 'overlay', label: '浮层' },
      ]
      const cells = []
      for (const knob of knobs) {
        cells.push(react.createElement('span', { key: `l-${knob.key}`, className: 'mia-knobLabel' }, knob.label))
        cells.push(react.createElement('span', { key: `s-${knob.key}` }, stepper(
          surface[knob.key], 0, 100, 10,
          v => save({ wallpaper: { surface: { [knob.key]: v } } }),
          busy,
          `${knob.label}不透明度`,
        )))
      }
      return react.createElement('div', { key: 'surface-knobs', className: 'mia-knobGrid' }, cells)
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
