# Miasaki Desktop — 变更日志

> 按时间倒序。历史排查细节与决策见 `ARCHITECTURE.md`;待办见 `TODO.md`。

## 2026-09-06 · 人格会话联动改道（修复「人格会话创建失败:not found」）

依据:用户报告切换主题时 toast「人格会话创建失败:Unexpected token 'o', "not found"
is not valid JSON」。实测复现:`POST /api/session.create` → HTTP 404 `not found`。

- **根因**:注入层 `01-persona.js` 自研 RPC(`fetch('/api/'+method)` + client-request
  信封)在 dsh 0.1.2-rc.1 已失效——该版本 RPC 走 WebSocket mux(`/api/remote.mux`,
  见 `dsh-api-gateway` `registerUpgrade`),HTTP `/api/*` 路由不存在 → 404;
  官方客户端经生成的 `ctx.remote.session.*` 代理调用(实测
  `dsh-client-ui-model-selection`: `ctx.remote.session.modelCatalog()`)。
- **修复(职责迁移,版本自适应)**:注入层不再自行 RPC——`01-persona.js` 改为派发
  `miasaki-persona-request` CustomEvent(detail.theme);`plugins/dsh-pet-panel/lib/client.js`
  (桌面插件,官方客户端上下文)监听事件,经 `ctx.remote.session.create({agentPreset,
  workspaceId?})` 创建,保留 localStorage(`miasaki.petSessions`)去重与主题化 toast
  (DSH 令牌配色);`inject` 增加 `remote.session`/`workspaces`。
- 触摸点:`themes/src/01-persona.js`、`plugins/dsh-pet-panel/{lib/client.js}`(已同步
  profile `node_modules`,哈希核对一致)、`README.md`、`injected/theme-init.js`(重生成
  64KB,令牌校验 + node --check 通过)。
- 验证:release 构建通过;验证点——切换主题后 toast 不再报错,「已创建『狂三』人格
  会话」;若插件升级缺失则静默降级(无 toast、无创建),不阻断主题切换。

## 2026-09-05 深夜 · 标题栏 v3:零占位叠加 + 窗控胶囊(修复「顶部切换按钮位置/被遮」)

依据:用户连续三轮反馈「窗口栏把对话会话布局切换按钮遮住了」「最主要的问题是按钮的
位置而不是整个窗口的风格」——v1 色带/v2.1 卡片式都对页面有 32px 布局侵入,把 DSH
会话头整行(标题行 + `role=tablist` 页签「对话/轨迹/用量」)压到顶带下方,按钮位置与
web 端不一致。本轮先做**布局取证**再动手(用户要求「先定位再改」):

- **取证结论**(读 `@deepseek-ai/dsh-client-ui-conversation` 包源码):会话头 =
  `<header>`(ConversationSessionHeader,`.header{padding:12px 28px 0 20px}`)→
  `titleRow`(`titleCluster`(flex:1:面包屑 + `conversation.session.header.actions`
  槽(后台任务等)) + `headerUtilities`(`conversation.session.header.utilities` 槽,
  Session 日志等))→ `tabs`(`role="tablist"`:对话/轨迹/用量)。全部为文档流定位;
  web 端 tabs 位于 y≈46,桌面端被 32px 下推后到 y≈78——位置被顶带挤掉。
- **v3 设计(用户批准)**:
  1. **零占位叠加**:删除 32px 顶带/卡片/#root 下推与 transform——页面回到 y=0,
     所有顶部控件与 web 端同位置(视觉与交互零侵入);
  2. **窗控胶囊**:右上角悬浮胶囊(主题徽章 + 最小化/最大化/关闭,半透明 +
     `backdrop-filter` 毛玻璃,悬停变实色),胶囊外 `pointer-events:none`,不挡页面;
  3. **顶行让位**:`#root header:has([role="tablist"]){padding-right:132px}`——
     会话头右侧(headerUtilities)为胶囊预留宽度(实测胶囊 ≈114px + 余量),
     Session 日志等左移,不再与悬浮胶囊叠压(与 VSCode 等自绘标题栏应用同款让位;
     初版 104px 不足,真机叠压后加宽至 132px;选择器锚定 `role=tablist`,
     DSH 升级时随 verify-themes 复核);
  4. **空白拖动**:document 级捕获 mousedown(y<36 且事件路径无交互元素——复用
     tauri 内置 drag-region 判定口径:可点击标签/contenteditable/tabindex/交互 role)
     → `plugin:window|start_dragging`;双击 → `internal_toggle_maximize`。
     页面按钮/页签/输入框照常点击,空白处拖窗;
  5. 主题标识移入胶囊(顶部左侧不再放任何东西,不碰侧栏 logo);右下角悬浮切换条保留。
- **清理**:删除各主题 `--ms-titlebar-bg`(+ fallback/@supports)与
  `#miasaki-titlebar` 顶缘高光规则;`prefers-reduced-motion` 去掉 tb-theme 引用;
  `06-titlebar.js` 重写为胶囊 + wireDragZone;`08-ready.js` 接线 wireDragZone。
- 触摸点:`themes/src/{03,06,08}`、`themes/{pure,zafkiel,kurkuriel}.css`、
  `src-tauri/injected/theme-init.js`(重生成 67KB,令牌校验 + node --check 通过)。
- 验证:release 构建(`tauri build --no-bundle`)通过;目检点——重启后「对话/轨迹/用量」
  页签回到 web 端位置、右上角胶囊不遮任何页面按钮、顶部空白可拖窗/双击最大化、
  三主题配色正确。

## 2026-09-05 深夜 · 用量页网格/区块边界可见性修复（token-monitor v0.3.3）

依据:用户截图反馈「用量界面的网格状不明显,各个区块的边界线不清晰」。取证 host
主题令牌:浅色模式下 `--dsw-alias-border-l1` 仅 `#0000000a`(4% 黑)、
`--dsw-alias-bg-layer-2` 与 layer-1 同为 `neutral-bluish-00`(纯白)——凡以这两个
令牌做「结构线/空格底」的地方在浅色主题下全部隐形:

- **区块边界**:卡片/总览五卡/hero/悬浮提示/按钮/输入框/chip 的 1px 边框(4% 黑
  肉眼不可见)→ 换插件内自派生 `--tokmn-border`(label-secondary 34% color-mix);
  模型列表/行分隔线 → `--tokmn-hairline`(20%,弱于区块边框一档)。
- **热力图网格**:空格与未来格底色原为 layer-2(白上白,整片空白仅右端有数据格
  可见)→ `--tokmn-cell-empty`(15%,GitHub 热力图空格观感),CSS 类与 `heatStyle`
  内联双处同步。
- **同类隐形顺手修**:趋势图横向网格线(零基线用 border 档、其余虚线用 hairline
  档)、环形图底环、上下文/限额进度条轨道、分段切换轨道、「未使用」图例 dot 的
  inset 描边,均从 layer-2/border-l1 换到对应派生档。
- 派生令牌挂在 `.tokmn-pane` 作用域,基于 `label-secondary` color-mix,深色主题
  (zafkiel/kurkuriel)下同样自适应可见;`color-mix` 需 Chromium 111+,WebView2 满足。
- 触摸点:`plugins/dsh-token-monitor/{lib/client.js, package.json}`。
- 验证:`node --check` 通过;目检点——浅色主题下五卡/各区块有清晰边线,Token 活动
  空格呈浅灰网格,趋势图有横向网格线与零基线,深色主题回归不变。
- 2026-09-06 实机目检通过(profile 重装 + host 重启后,playwright 无头 Edge 取证):
  浅色下五卡/卡片/hero/按钮/chip 边线清晰(`--tokmn-border` 34% 档像素级可见),Token
  活动空格呈浅灰网格(`--tokmn-cell-empty` 15%,371 格全着底),趋势图零基线 34% 实线
  + 25M/50M/75M 20% 虚线网格线可见,环形图底环/进度条轨道/分段切换轨道同步自适;
  深色下同档派生自 label-secondary 亮色、观感与改动前一致。附带实测:`var()`
  写入 SVG 呈现属性经 Chromium 152 正确解析(computed stroke 返回实际颜色)。

## 2026-09-05 深夜 · 标题栏 v2.1:内嵌卡片式(修复「顶带遮住页面顶部控件」)

依据:用户反馈「窗口栏把对话会话布局切换按钮遮住了」「窗口栏顶栏会遮住按钮」——
v2 的固定 32px 顶带 + `margin-top:32px` 推挤方案下,DSH 页面顶部控件(会话头部行/
切换类按钮,部分为脱离文档流的 fixed/sticky 定位)会被顶带压住或紧贴带底边被裁切;
同一页面在 web 端(无顶带)顶部控件位于页面自然顶部。v2.1 改为参考图中 MiniMax 的
「chrome 面 + 内容卡片」结构,从根上消除交叠:

- **chrome 面**:`body` 底色 = `--ms-titlebar-bg`(与顶带同色,见 v2)——顶带与四周
  留边是同一张表面,带与页面无第二层覆盖关系,页面永远在带的下方。
- **内容卡片**:`body #root{margin:38px 8px 10px;border-radius:12px;overflow:hidden;
  background-color:var(--dsw-alias-bg-base);box-shadow;transform:translateZ(0)}`:
  DSH 整体作为圆角白色卡片浮在 chrome 面上(侧栏/详情面板一并入卡),页面顶部控件
  在卡片内保持 web 端的自然位置与间距。
- **fixed/sticky 隔离**:`transform:translateZ(0)` 使 `#root` 成为其内部
  fixed/绝对定位后代的包含块——页面内任何脱离文档流的控件(含用户反馈的切换按钮)
  都会被定位到卡片内,结构上不可能出现在顶带下方;popover/菜单在卡片内照常工作
  (edges 处轻微裁切,可接受)。
- **顶带**:仍为 chrome 表面的一部分(左侧主题标识 + 右侧窗控),但不再与页面内容
  有任何上下层交叠——即使 DSH 升级引入新的 fixed 顶部元素,也无法越过卡片边界。
- 触摸点:`themes/src/03-switcher.js`(SWITCHER_CSS 的 body/#root/带规则)、
  `src-tauri/injected/theme-init.js`(重生成,68KB,令牌校验 + node --check 通过)。
- 验证:release 构建(`tauri build --no-bundle`)通过;目检点——三主题下顶部为
  灰 chrome 色带 + 圆角白色内容卡片,「对话/轨迹/用量」页签与头部控件在卡片内
  完整可见可点,web 端与桌面端顶部布局一致;窗控/拖动/关闭确认行为不变。

## 2026-09-05 晚 · 标题栏 v2:应用化「色带」(对齐 MiniMax Design 参考)

依据:用户给出 MiniMax Design 截图,要求「窗口栏能自然融合到主页面,像第二张图一样
差不多的效果,现在我们的桌面端还不行」。对照参考图像素取证:顶部菜单区采样 `#EFEFF2`、
页面底 `#FAFAFA` —— 参考实现是**全宽约 32px 的统一色带**(与页面同色系、略深一线),
菜单在带内左侧、窗控在带内右侧,带与页面零分界。v1 做法(色带 = DSH 基底令牌,与页面
零色差 + `::before/::after` 侧栏色块/详情分隔线模拟)在纯色/侧栏收起态下带完全隐形,
窗控像浮在页面上的裸图标,观感未达参考。v2 按参考重做:

- **标题带 = 应用 chrome 表面**(`themes/src/03-switcher.js` SWITCHER_CSS):
  `--ms-titlebar-bg` 由各主题定义,三主题均用 `color-mix` 以页面基底混少量分色
  (pure:`label-secondary`;kurkuriel:枪铁 `#6a6159`;zafkiel:蓝灰 `#d6cfe4`)→
  亮色主题略深一线、暗色主题略亮一线(≈12~16% 分量);`@supports` 守卫 + 各主题
  显式 fallback 色,保证 color-mix 不可用的环境回退到近似旧观感而非透明。
  移除 `::before`(侧栏色块)/`::after`(详情分隔线)与 `data-details-open`/`data-local`
  规则——不再依赖 DSH DOM 网格几何(见 ARCHITECTURE 契约废弃)。
- **主题文字常显**:左侧品牌徽 + 主题名/副标题即「应用级内容」(对齐 MiniMax 菜单位),
  不再随侧栏收起淡出;收起态规则与 `data-sidebar-collapsed` 删除。
- **窗控升级**:SVG 10px→12px,按钮 28px 命中区、hover 圆角 999px→8px(Win11/Fluent
  手感,原圆形贴角偏「浮空」);关闭 hover 红色保持;拖动/双击最大化/最大化图标同步
  行为不变。
- **清理与结构性变更**:
  - `themes/src/06-titlebar.js`:删除 `data-local` 标记与 `syncTitlebarGeometry()` 调用;
  - `themes/src/07-dialog-geom.js`:删除几何同步块(ResizeObserver、多信号收起判定、
    诊断写 diag 尾两位),文件名改 `07-dialog.js`(职责=关闭确认弹窗);
  - `themes/src/02-core.js`:hash `diag` 尾两位固定 `.0.0`,注释同步;
  - `themes/src/08-ready.js`:巡检去掉 `syncTitlebarGeometry()` 调用;
  - `themes/src/MANIFEST.json`:order 更新(07-dialog.js),note 标注 slices 行段为
    legacy 切分参考(运行时与 legacy runtime.js 已非逐字节一致);
  - `themes/{pure,zafkiel,kurkuriel}.css`:新增 `--ms-titlebar-bg`(+ fallback);
  - 重生成 `src-tauri/injected/theme-init.js`(68KB):`npm run gen-init` 令牌校验通过、
    `node --check` 语法通过、grep 无残留旧符号。
- 触摸点:`themes/src/{02,03,06,07-dialog.js,08}`、`themes/{pure,zafkiel,kurkuriel}.css`、
  `themes/src/MANIFEST.json`、`design/ARCHITECTURE.md`、`README.md`。
- 验证:沙箱内无页面渲染手段(无头 Edge 被命名管道限制,同 verify-themes TODO)→
  release 构建经 `tauri build --no-bundle`(产物 `target/release/miasaki.exe`);
  视觉验证点:重启桌面端后三主题顶部均为与页面同色系的 32px 色带,左侧主题标识常显、
  右侧窗控 8px 圆角 hover;拖动/双击最大化/窗控按钮/关闭确认弹窗/最大化图标同步
  与 v1 行为一致。

## 2026-09-05 · 标题栏与主界面融为一体（Win11 Mica + 圆角 + 零分界）

依据:用户「怎么把桌面端窗口栏和主界面融为一体做到一块」。

- **架构确认**（只读盘点，无改动）:窗口已 `decorations(false)` 无边框;自绘 32px
  `#miasaki-titlebar`（`themes/src/06-titlebar.js`）与 DSH 主界面的融合此前靠令牌对齐
  （背景 `--dsw-alias-bg-base`、`::before` 侧栏色块 `--dsw-specific-sidebar-fill`、
  `::after` 详情分隔线 `--ms-details-left` + ResizeObserver 帧级几何同步,
  `themes/src/07-dialog-geom.js`）。剩余缺口:直角窗口、标题栏独立色带/装饰底线分界、
  无材质纵深。
- **窗口层**（`src-tauri/src/main.rs` + `Cargo.toml`）:
  1. `.shadow(true)`:Win11 无边框窗口恢复 DWM 圆角 + 阴影 + 1px 描边（tauri 官方文档确认
     `set_shadow` 行为——注明:对接验证过本地 tauri 2.11.5 源码,shadow 语义与 2.9.5
     文档一致）;
  2. `.background_color(0,0,0,0)`:WebView2 默认背景透明（loading.html 自带实色渐变,
     无加载期白闪）;
  3. 新增 `apply_mica()`:直调 DWM `DwmSetWindowAttribute(DWMWA_SYSTEMBACKDROP_TYPE=38,
     DWMSBT_MAINWINDOW=2)`（windows-sys 0.59 已确认常量;hwnd 经 tauri `hwnd()` 字段
     访问,零新增依赖）。**不用 tauri `set_effects` 的原因**:其内部把 window-vibrancy
     错误吞掉（`let _ =`）,无法探测 Win10 回退;DWM 直调按 HRESULT 判定——失败时
     `set_background_color` 回退主题实色底,避免页面半透明处露出 tao 默认白底。
- **主题层**（`themes/{zafkiel,kurkuriel,pure}.css`,经 `build-init.mjs` 重生成
  `src-tauri/injected/theme-init.js`）:
  - zafkiel:`--dsw-alias-bg-base` .86→.8,新增 `--dsw-specific-sidebar-fill:
    rgba(18,16,25,.8)`(此前侧栏实色,不透 Mica);
  - kurkuriel:bg-base .88→.93(亮主题防系统暗色 Mica 偏灰),新增 sidebar-fill
    rgba(252,250,248,.93);
  - 三主题删除 `--ms-deco-line`(标题栏装饰底线)→ 标题栏与主界面零分界;
    zafkiel/kurkuriel 的 `box-shadow` 底部内线去掉,仅留窗口顶缘 1px 高光;
  - pure 保持原版实色(不覆盖 DSH 令牌的设计原则),Mica 仅 zafkiel/kurkuriel 透出。
- **验证**:`cargo check` 通过;`npm run gen-init` 令牌校验通过(73KB);`npm run verify`
  需 CDP 运行时(target 未启动,留给 `tauri dev` 后执行)。
- 触摸点:`src-tauri/src/main.rs`（shadow/Mica/透明底）、`src-tauri/Cargo.toml`
  （Win32_Graphics_Dwm feature）、`themes/*.css` + `src-tauri/injected/theme-init.js`。
- 验证点:用户 `npm run tauri dev` 后——Win11 窗口有圆角/阴影;zafkiel 下标题栏与
  主界面无分界线,窗口边缘透出系统 Mica 材质(主题色盖在其上);切换 kurkuriel 观感
  一致(略实);pure 保持原版。Win10 用户:无圆角/Mica,回退实色底,功能不受影响。

## 2026-09-05 · 修复:「桌面端黑屏」——dsh web 鉴权 cookie 失效自动恢复

依据:用户「桌面端打不开了」，排查确认主窗口黑屏（进程/桌宠/素材服务均正常）。

- **根因链**（全程证据见 `_refs/scripts-archive/diag-2026-09-05-black-screen.md`）:
  1. 今日 dsh 平台适配 0.1.2-rc.1 期间多次重启（17:39/20:43/21:31），17:54
     升级重写了 `~/.dsh/.credentials.yaml` 里 `client-connection/browser-session`
     的签名 secret；
  2. dsh web 鉴权 = 进程级 launchToken 换**secret 签名 cookie**（`dsh-auth-*`，
     `dsh-client-connection` BrowserAuth）。secret 轮换后桌面端 WebView2 里的旧
     cookie 全部失效；
  3. 桌面端再启动 → `GET /` 401（`dsh web authentication required`）→ 纯文本
     错误页在深色窗口背景下呈现为**黑屏**（仅注入标题栏/水印可见），且 loading
     流程对 401 无任何恢复分支；
  4. 排查中一度被 DSH 沙箱文件系统视图误导（Program Files 下 WebView2 目录对
     沙箱不可见），最终经 UAC 管理员视角与 WebView2 对照实验（MIASAKI_REMOTE 指向
     microsoft.com 渲染正常）排除 WebView2/驱动问题。
- **修复**（`themes/src/00-boot.js`，D1 运行时新增职责「鉴权 cookie 注入」）:
  3080 页面加载时用持久 secret（硬编码于注入脚本，见 TODO 的自动化改进项）经
  Web Crypto 动态签 30 天 `dsh-auth-*` cookie（v1.HMAC-SHA256 格式与
  dsh-client-connection 一致），检测到 401 纯文本页后延迟 `location.reload()`
  （延迟 400ms 因 init script 运行于 document_start、body 未就绪）。
- **验证**:debug 版经 UAC 启动实测——注入前窗口区域亮像素 4.4%（黑屏），注入后
  58.1%（DSH 界面正常）；窗口内容经 MiMo 视觉模型确认恢复会话视图。
- **触摸点**:`themes/src/00-boot.js`（运行时新增分片逻辑，经 build-init 重生成
  `src-tauri/injected/theme-init.js`）；`src-tauri` 需 `cargo build --release` 并
  用 `target/release/miasaki.exe` 替换 `dist/Miasaki.exe`（用户快捷方式目标）。
- **验证点**:双击 `Miasaki-dsh` 快捷方式 → 主窗口显示 DSH 会话页（无黑屏）；
  `pet.log` 出现 `asset-server listening` + `hash-diag`。

## 2026-09-05 · 修复:用量 Tab 映射对话页列宽调节（token-monitor v0.3.2）

依据:用户「用量界面会映射对话页面的对话框大小调节」。

- **根因**（查 DSH `dsh-client-ui-conversation` bundle 确认）:会话页两侧列宽拖拽
  手柄（`[data-width-handle]`，调对话页内容列 + 输入框宽度，持久化
  `localStorage dsh.conversation.contentWidth`，实测用户已拖到 760）与底部输入框
  都挂在 `ConversationRoot` / 滚动容器层——**视图区之外**，三个 Tab 共享；输入框
  卡片 `max-width` 派生自 `--dsh-chat-content-width`（= 拖拽偏好经
  `resolveContentWidth` 夹紧）。于是对话页拖宽 → 用量页输入框跟着变（映射），
  用量页两侧的隐形 `col-resize` 条误拖也会改写对话页列宽。
- **修复**（纯 client 半 CSS，v0.3.2）:用量 Tab 激活期间
  `[data-phase]:has(.tokmn-pane) [data-width-handle] { display:none }` 隐藏两侧
  手柄；`[data-conversation-scroll]:has(.tokmn-pane)` 重声明
  `--dsh-chat-content-width` / `--dsh-composer-card-max-width` 回 DSH 默认档
  `clamp(680px, 64% 列宽, 920px)`（表达式须与 ConversationRoot 回退值一致），
  输入框不再跟随拖拽偏好。style 随用量视图挂载/卸载，切走即整体恢复。
- **验证**:DevTools 实测注入——注入前 `contentW: 640px / composerMax:
  calc(640px+32px) / handles: 2`，注入后 `handles: ["none","none"] / cardW: 680`
  （默认档），选择器与变量链路全部生效；临时注入即删，未留残留。
- 触摸点:`plugins/dsh-token-monitor/{lib/client.js, package.json, README.md}`。
- 验证点:`node --check` 通过;Windows 机需 profile 目录重跑 `pnpm install`（或
  等价拷贝）+ 重启 host 后目检:用量 Tab 两侧拖拽条消失、输入框宽度不随对话页调节。

## 2026-09-05 · 官方 dsh 0.1.2-rc.1 适配（三插件 + canvas 盘点）

依据：官方 dsh 升至 0.1.2-rc.1（npm latest，本机 host 已更新），用户要求评估插件适配面。

- **逐项 API 对照结论（全部兼容，无需改代码）**：profile bundles / `dsh.bundle.patch`
  （insert 格式）、`dsh.client.platform: "web"` + `exports["./client"]`、
  `window.__ModuleLoader__.load`、`settings.get(ns)/update(ns, patch)`（新增可选
  `expectedRevision`）、`webServer.register({kind, path, handler})`、`sessions.get`、
  `sessionProjections.snapshot`（tokenUsage/contextPressure/contextBreakdown/sessionStats
  字段名逐一对上）、`tokenMeter.measure`、`llm/stream`（usage 字段）、`tools/result`、
  `~/.dsh/.agent-presets/*/agent.cordis.yml` 的 `agentOptions` 三行结构。
- **实测**：`/dsh-token-monitor/heatmap` 与 `/canvas/` 在 0.1.2 host 上 200 正常；
  `/freepool-api/status` 曾返回空平台列表，根因是 `llm-pi-ai` settings 节整体
  校验失败（0.1.2 `assertServiceable` 拒绝 catalog 不认识的模型 id 且路由未声明
  `api`/`baseURL`，opencode 平台首当其冲）→ llm-pi-ai 注册 fiber failed →
  `settings.get('llm-pi-ai')` 无记录。`settings.yaml` 中 opencode 已补
  `api: openai-completions` + `baseURL`，官方 schema 校验全绿；**host 重启后
  llm-pi-ai 重新挂载、免费模型池平台列表恢复**（watcher 不复活 failed fiber）。
- **变更**：三个插件 `peerDependencies` 对齐 `@deepseek-ai/cordis ^4.0.2`、
  `dsh-settings/dsh-host-webserver ^0.1.2-rc.1`；`@miasaki/dsh-canvas` 删除
  `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime"]`（0.1.2 已无此包，幽灵依赖）。
- **诊断脚本**（用后即删，未归档）：`_refs/scripts-archive/diagnose-llm-pi-ai-schema.mjs`、
  `repro-llm-pi-ai-mount.mjs`、`migrate-settings-llm-pi-ai.mjs` —— 用官方
  `llm-pi-ai` Config/apply 复现校验报错（opencode 模型缺 api/baseURL）。
- 验证点：profile 目录重跑 `pnpm install` + **重启 host** 后，GUI「设置 → 免费模型池」
  平台列表恢复 6 平台；「用量」Tab 与桌宠面板目检正常。

## 2026-09-05 · 修复:账本重启翻倍污染 + 账本重置（token-monitor v0.3.1）

依据:用户「用量显示有问题，数据失真」。

- **根因（唯一）**:`loadLedger()` 复用 `addToLedger()`，把磁盘载入的历史存量
  也塞进 `pending` 落盘队列，5s flush 后原样追加回 `usage-log.jsonl` ——
  **每重启一次 host，账本精确翻倍**（`addToLedger` 增 `toPending` 参数，
  载入路径传 `false` 只进内存聚合）。文件证据:全部 session 行呈精确 ×2ᵏ
  几何序列（如 55944→111888→223776→447552），与用户当天反复重启 host 的
  节奏吻合;旧会话行达千亿级即多次重启的指数重放。
- **排除项（查 dsh 源码确认，不改）**:`llm/stream` waterfall 下 DeepSeek 适配器
  的 `usage` chunk 在 `[DONE]` 哨兵处仅 yield 一次（每请求全量口径，`pendingUsage`
  覆盖式暂存），流式逐 chunk 累加语义无误;`TokenUsage` 各字段互斥
  （inputTokens=未缓存输入，billed input=三段之和），账本四段累加无双计。
- **配套**：新增 `POST /dsh-token-monitor/reset` 清空账本（内存 + 文件，
  限额保留）;UI「今日用量」卡标题行加「重置账本」按钮（confirm 确认，
  成功后立即刷 summary + heatmap）;热力图轮询 load 挂 ref 供重置后即时刷新。
- **数据修复**：被污染的 `usage-log.jsonl` 已删除（真实值不可恢复，
  config.json 不存在无损失）;重启 host 后从零重计。
- 触摸点:`plugins/dsh-token-monitor/{lib/index.js, lib/client.js,
  cordis.patch.yml, package.json, README.md}`;验证脚本同步扩展并归档
  `_refs/scripts-archive/test-token-monitor-v030.mjs`。
- 验证点:`node --check` 通过;mock 测试 33 项全过（新增「载入不回写：重启后
  文件行数稳定」与 reset 全链路「归零→保留限额→文件删除→从零重计」）;
  Windows 机需 profile 目录重跑 `pnpm install` + 重启 host 后目检数字回归合理。

## 2026-09-05 · 「用量」Tab 补全可视化（总览五卡 / 年热力图 / 每日趋势 / 模型用量占比，token-monitor v0.3.0）

依据：用户「热力图、趋势图、用量图什么的也都要有」（继续对照 ZCode 用量面板三截图）。

- **总览五卡**（ZCode 头部统计行同构）：累计 Token 数 / 峰值 Token 数（单日）/
  最长聊天时长 / 当前连续天数 / 最长连续天数；大数中文单位（7亿 / 3.3亿）。
- **Token 活动年热力图**（GitHub 风格，周一对齐 ~52 周、月标签在底部）：每日 /
  每周 / 累计三态切换（周/累计为客户端从每日数据推导的整周高格），品牌色分档
  深浅，悬浮富提示（日期 + tokens + 轮消息）。
- **时间范围（近 7 日 / 近 30 日，趋势与占比共用）**：每日 Token 趋势图为按模型
  多序列平滑曲线（Catmull-Rom→贝塞尔手写 SVG，图例点选显隐、悬浮十字 + 当日各
  模型明细，配色按 30 天总量排名分配、切范围颜色稳定）；模型用量环形图（中心
  范围总量 + 右侧模型列表 tokens/百分比）。全部纯 SVG/CSS，无新依赖。
- **账本扩展（host 数据面）**：保留窗 8 天 → 380 天（撑热力图年视图）、尾部解析
  4MB → 8MB；条目增 `calls`（当日实报次数 ≈ 轮消息）与 `type:'span'` 会话活跃
  跨度快照（min/max 合并、推进 ≥60s 才落盘 → 支撑「最长聊天时长」）；`/summary`
  增 `stats`（累计/峰值/跨度/连续天数），`trend` 扩为 30 天且每日带按模型明细
  （趋势图与环形图共用）；新路由 `GET /dsh-token-monitor/heatmap` 稀疏每日账单
  （client 60s 轮询，不拖累 3s 主轮询）。
- 原「近 7 天迷你柱图」移除（被大趋势图取代）；今日用量卡保留并加轮消息分项；
  上下文剩余 hero 与既有明细区顺延至可视化区块之后。
- 触摸点：`plugins/dsh-token-monitor/{lib/index.js, lib/client.js, package.json,
  README.md}`、`README.md`；一次性验证脚本归档
  `_refs/scripts-archive/test-token-monitor-v030.mjs`。
- 验证点：`node --check` 两文件通过；mock 测试 25 项全过（host 账本聚合 / 统计 /
  三路由 / 5s 节流落盘跨重启持久化 + client shim 空数据与造数两遍渲染）；Windows
  机需 profile 目录重跑 `pnpm install` + 重启 host 后目检三块新可视化。

## 2026-09-04 · 双线优化 P0–P2（运行时拆分 / 桌宠模块化 / Fleet 指示器）

依据：双线并进 + 中度重构 + 桌宠恢复 Fleet 指示器。

- **D1 注入运行时拆分**：`themes/runtime.js` 1100 行按序切 9 片
  `themes/src/{00-boot,01-persona,02-core,03-switcher,04-deco,05-sensors,06-titlebar,07-dialog-geom,08-ready}.js`
 （拼接与 legacy 逐字节一致）+ `src/README.md` 分片说明；
  `scripts/build-init.mjs` 按 `src/MANIFEST.json` 拼接，缺 src 时回退 legacy；
  `npm run gen-init` 与令牌校验已验证通过，产物语法 `node --check` 通过。
- **D2 桌宠模块化 + fallback**：`src-tauri/src/pet_native.rs` 转 facade，
  实现入 `src-tauri/src/pet_native/{config,ffi,image,model,persist,window}.rs`
 （`#[path]` 子模块，`main.rs` 零改动）；stub harness `cargo check` 零错误；
  新增 `Frames::kurumi_row` 回退链（请求行→idle→wave→jump→run→首个可用，
  修复旧代码回退后用请求行名重查致空白）+ whale/inverse 缺行回退 idle；
  单测 `fallback_chain` 通过。Windows 机仍需 `npm run tauri build` 终验（链接）。
- **D3 GDI 兜底 + smoke 三用例**：`present()` 改 `&mut`，ULW 连续失败计数
  （首失败 + 每 300 次日志，10 连败销毁表面）+ 表面无效每 ~30 compose 重试重建
  （`create/destroy_present_surface`，创建期复用同一函数）；`scripts/smoke-test.ps1`
  新增 §0b 三用例 WARN 预检（dsh 未安装/3080 被非 DSH 占用/单实例冲突，跨平台探针）。
- **D4 令牌漂移报告**：`scripts/diff-tokens.mjs`（`npm run tokens:diff`），
  缺失复述 + static 死覆盖告警（alias 融合引用单列忽略）；现况零缺失零死覆盖。
- **X2 Fleet 指示器**：`PetShared` 增 `fleet_running/fleet_alert` + `set_fleet`；
  `main.rs` 脉冲看门狗（环境变量 `MIASAKI_FLEET_PULSE`，2s 轮询 pulse v2，
  未设静默关闭）；compose 优先级 fleet 告警 > waiting > fleet 运行中 > busy > intensity
 （告警=failed 行 + NEED_APPROVE 常驻气泡，运行中=work 立绘 + BUSY 常驻气泡，
  kurumi 不原地跑步；指示期间禁散步）。联动契约见
  `dsh-miasaki-shared-docs/cross/ab-linkage-pulse-v2-2026-09-04.md`。
- 触摸点：`themes/src/`、`scripts/build-init.mjs`、`scripts/diff-tokens.mjs`、
  `scripts/smoke-test.ps1`、`src-tauri/src/pet_native.rs`、`src-tauri/src/pet_native/`、
  `src-tauri/src/main.rs`、`package.json`、`README.md`。
- 验证点：`npm run gen-init` + `node --check` 注入产物；harness `cargo check`
  零错误 + `cargo test fallback_chain` 通过；`npm run tokens:diff` 无漂移；
  fleet `node workers/validate-bus.mjs --strict` 通过；Windows 机补
  `npm run tauri build` + smoke 全绿 + 设变量后跑 pulse 看桌宠切换。

## 2026-09-03 · 优化:「用量」Tab 参照 ZCode 用量面板重构(UI + 数据面)

依据:用户「优化本项目'用量'页面,参考 zcode 的用量页面设计面板」。

- **设计语言对齐(ZCode 用量面板)**:由"已用视角"翻转为**剩余视角优先**——
  1. 上下文剩余 hero(大字号剩余% + 全宽分段条**分母 = contextWindow**(原实现
     以已用和为分母,看不到未使用段)+ 未使用图例;已用超窗时以已用和为分母、
     剩余归零);2. 阈值 45/75/95% 三档变色(success→brand→warn→error,ZCode 分档
     惯例);3. "更新于 HH:MM:SS" as-of 时间戳替代静态刷新文案。
- **数据面新增跨会话账本**(DSH 走 API Key 无配额接口,ZCode 的限额视角只能
  本地建账):host 半在 `llm/stream` 累计处双写——`ledgerDays`(内存聚合权威,
  仅最近 8 天)+ `pending`(增量);5s 节流追加写 `usage-log.jsonl`,`process.on('exit')`
  同步 flush 兜底;启动载入最近 8 天(文件 >4MB 只解析尾部、丢弃不完整首行)。
  账本与实时明细**同口径**(同为 chunk.usage 增量累计,不引入新偏差)。
- **限额配置**:`config.json`(`{dailyTokenLimit: number|null}`),新路由
  `GET|POST /dsh-token-monitor/config`(`{ok, error}` 包装对齐 dsh-free-model-pool);
  summary 路由向后兼容扩展 `ledger{today,trend,since}` + `config` 字段。
  数据目录优先宿主插件数据服务,否则 `~/.dsh/plugins-data/dsh-token-monitor/`。
- **UI 重构**(client 半,`tokmn-*` 令牌化):上下文剩余 hero → 今日用量卡
  (账本累计大数字 + 限额进度条/就地设置(K/M 单位) + 近 7 天纯 CSS 柱图,今日柱
  品牌色)→ 统计卡组 → 性能小卡(TTFT/解码耗时/解码速度 tok·s⁻¹/模型与工具耗时,
  由原独立小卡降级合并)→ 按模型明细/工具徽章(结构保留)→ 三通道口径脚注。
  舍弃成本估算(定价表易过时,用户确认不做)。
- 触摸点:`plugins/dsh-token-monitor/lib/index.js`、`lib/client.js`、
  `package.json`(v0.2.0)、`README.md`(插件+desktop 目录树注释)。
- 验证点:profile 目录重跑 `pnpm install`(file: 依赖不自动跟随源码)并重启
  host 后——hero 阈值色分档;发起对话 3s 内今日累计增长;设置/清除限额生效;
  `usage-log.jsonl` 行合法;**重启 host 后今日累计仍在**;趋势图 7 柱含今日;
  三主题 × 明暗无样式破损。

## 2026-09-01 · 修复:启动页左上角闪烁黑块

依据:用户反馈「启动页左上角闪烁黑块」。

- **根因**:标题栏 `::before` 模拟侧栏色块的回退色为深色 `#1e1a27`
  (`background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#1e1a27))`)。
  `--dsw-specific-sidebar-fill` 是 DSH 页面自身的令牌,DSH 样式加载完成前无值 →
  色块按回退色渲染成 280px×32px 深色块,悬在左上角;DSH 渲染完成后令牌生效变
  主题色 → 视觉上"闪烁黑块"(亮色主题尤其明显)。
- **修复**:
  - `themes/runtime.js`:`::before` 回退色改 `transparent`——DSH 令牌未就绪时
    不显示色块,DSH 渲染完成后色块与侧栏同时出现,无缝衔接;
  - `src-tauri/src/main.rs`:主窗口 `background_color` 随主题设置(kurkuriel 浅色
    #f7f4f1 / 其余深色 #0c0b11),页面加载期(loading → DSH 渲染完成前)底色不再
    是默认白底,消除深色注入层悬在白色页面上的反差闪烁。
- 触摸点:`themes/runtime.js`、`src-tauri/src/main.rs`、
  `src-tauri/injected/theme-init.js`(build-init 重新生成)。
- 验证点:重启桌面端(深/浅主题各试一次)——启动到 DSH 渲染完成的整个过程,
  左上角不再出现深色块闪烁,页面加载期无白底反差。

## 2026-09-01 · 修复:启动界面画面不统一（IS_LOCAL 判定回归）

依据:用户反馈「启动界面又出了小问题」。

- **根因**:`IS_LOCAL` 判定回归——2026-08-29 曾修复(Windows 上 Tauri 2 本地页
  协议为 `http://tauri.localhost`,单协议判定 `location.protocol === 'tauri:'`
  恒 false → 本地页出现重复标题栏 + 切换条,即当时的「画面不统一」),后于重构
  中丢失。回归后果:启动页被当作远程页,右下角主题切换条、主题水印、光晕、
  标题栏左侧 280px 模拟侧栏色块全部出现在启动画面。
- **修复**(`themes/runtime.js`):
  - `IS_LOCAL` 恢复 protocol + hostname 双重判定(`tauri:` / `tauri.localhost`);
  - `buildTitlebar` 不再因 IS_LOCAL 跳过(本地页同样需要拖动区与窗口按钮),
    本地页构建时打 `data-local` 标记,CSS 隐藏模拟侧栏/详情分隔线
    (`::before/::after`),标题栏保持纯净;
  - `buildSwitcher` 加 IS_LOCAL 拦截,巡检同步加条件(本地页无切换条);
  - 水印/光晕原有 IS_LOCAL 拦截恢复生效;`wireMaxState`/`requestMaxState`
    移出 `!IS_LOCAL` 块(本地页窗口按钮状态同样需要同步)。
- 触摸点:`themes/runtime.js`、`src-tauri/injected/theme-init.js`(build-init 重新生成)。
- 验证点:重启桌面端——启动画面仅标题栏(左侧无侧栏色块/分隔线)+ 居中纹章,
  无右下角切换条、无水印/光晕;标题栏三按钮同 SVG 线形、最大/还原同步;
  进入 DSH 页后装饰层完整(切换条/水印/光晕/侧栏色块)不受影响。

## 2026-09-01 · 修复:侧栏收起/展开时标题栏切换不连贯（帧级同步 + 过渡动画）

依据:用户反馈「左上角切换不连贯、视觉不统一」。根因:DSH 侧栏收起/展开是 CSS
动画,而标题栏几何此前靠 1s 巡检 + `display:none` 瞬间切换——动画播完文字才
突然消失/出现,节奏滞后且生硬。

- **ResizeObserver 帧级同步**:`syncTitlebarGeometry` 找到布局容器后,对首列元素
  (sidebarCol)挂 ResizeObserver——收起/展开动画期间轨道宽逐帧变化,RO 每帧驱动
  标题栏几何(`--ms-sidebar-w`/`--ms-details-left`/文字状态),与 DSH 动画完全
  同步;容器缓存(`_frameCache`,isConnected 失效重扫)避免动画期间每帧全量
  querySelector;1s 巡检降级为兜底(重建/重绑定/RO 不可用环境)。
- **文字过渡动画**:`#tb-theme`/`.tb-sub` 的收起态由 `display:none` 改为
  `opacity/max-width/margin` 过渡淡出(0.18s),原 `.tb-title` 的 flex gap 改为
  子元素 margin 承担(收起态 margin 归零,无残留空隙);prefers-reduced-motion
  下禁用过渡。
- **收起判定方向驱动**:RO 逐帧采样下,收窄方向第一帧即置 `data-sidebar-collapsed`
  (文字随收起动画同步淡出)、展开方向立即恢复(文字随展开动画同步淡入);无方向
  变化时按隐藏/归零/窄于 100px 稳态兜底。
- 触摸点:`themes/runtime.js`、`src-tauri/injected/theme-init.js`(build-init 重新生成)。
- 验证点:真机验证——收起侧栏时标题栏文字与侧栏动画同步淡出、展开同步淡入,
  色块分隔线逐帧贴合,无滞后跳变。

## 2026-09-01 · 修复:窗口按钮统一 SVG 化 + 最大化状态同步 + 侧栏收起判定加固

依据:用户反馈「左上角问题依旧」(排查为只重启旧 EXE——注入脚本编译期嵌入二进制,
未重建即不生效);另三个窗口按钮(–/□/✕ 字符)大小不一、视觉不统一。

- **按钮 SVG 化落地**:`TB_ICONS` 四枚 10×10 视口内联 SVG(stroke-width 1、
  currentColor、圆头端帽、Fluent 线形)——最小化=横线、最大化=圆角方框、还原=错位
  双框、关闭=对角叉;CSS 统一 `.tb-btn svg` 描边样式,三按钮视觉重量一致。
  2026-08-29 记录的「SVG 化」从未真正落地(远程页无 IPC 权限,wireMaxState 架构
  上走不通),本次按新通道重做。
- **最大化↔还原同步(新通道)**:远程页 capability 只授 start-dragging → 不走
  `__TAURI__` IPC,改 Rust eval 派发 CustomEvent `miasaki-max-state`(与桌宠状态
  推送同构):main.rs 新增 `push_max_state` + on_window_event Resized 150ms 防抖 +
  页面 load 后延迟推 + hash cmd=want-max 请求重推;runtime.js 监听事件切换图标,
  标题栏被重渲染重建/推送丢失时 10s 间隔请求兜底;非 Tauri 浏览器预览点击本地翻转。
- **侧栏收起判定加固(多信号)**:信号 A grid 轨道声明 / B 首列实测宽 / C
  `[class*="sidebar"]` 元素可见性,宽度采用 B>A>C(实测优先,含 0);收起判定 =
  C 隐藏或零宽 / 实测或轨道归零 / 窄于 100px(DSH 展开态侧栏 ≥100,固定阈值
  优于相对基线——用户拖窄侧栏不误判)。比单一轨道解析抗 DSH 布局演进。
- **可观测闭环**:hash diag 尾追加 `sidebarW.collapsed`,Rust watchdog diag 变化
  时落一行 `hash-diag` 日志 → 托盘「导出诊断」可见,同类问题可远程定位不再靠猜。
- 触摸点:`themes/runtime.js`、`src-tauri/src/main.rs`、
  `src-tauri/injected/theme-init.js`(build-init 重新生成)。
- 验证点:cargo check/build --release 通过;真机验证——三按钮同尺寸同粗细;最大化
  (点击/Win+↑/双击标题栏)后按钮变「还原」;收起侧栏左上角只留图标且色块对齐。

## 2026-09-01 · 修复:侧栏收起后标题栏主题文字与窗口栏不协调

依据:用户反馈 DSH 左侧边栏收起后,自绘标题栏左上角的主题名/副标题文字仍
横跨在窗口栏上,与收窄的侧栏区错位、观感不协调。

- **收起态藏字**:`syncTitlebarGeometry` 解析到侧栏轨道宽为 0 或窄于 120px
  (展开态默认 280px)时,给标题栏打 `data-sidebar-collapsed`,CSS 隐藏
  `#tb-theme`/`.tb-sub`,仅留 20px 主题图标;`::before` 模拟侧栏分隔线同步
  透明,与收起后的页面布局对齐。
- **几何残留修复**:轨道声明值解析去掉 `>0` 过滤(0px 直接应用)——此前侧栏
  收起为 0px 时 `--ms-sidebar-w` 残留旧宽 280px,标题栏侧栏色块与页面错位;
  首列实测兜底同样直接采用含 0 值。
- **图标悬浮提示**:标题栏徽记加 `title`(主题名 · 副标题),收起态文字隐藏后
  悬停图标即可知当前主题。
- 触摸点:`themes/runtime.js`、`src-tauri/injected/theme-init.js`(build-init 重新生成)。
- 验证点:桌面端重启后收起/展开左侧边栏——收起态左上角仅主题图标(悬浮见提示),
  展开态文字恢复;标题栏侧栏色块与页面侧栏始终对齐。

## 2026-08-30 · 新增:DSH 会话视图「用量」Tab(dsh-token-monitor 部署级插件)

依据:用户要求 DSH Web GUI 在「对话/轨迹」旁新增 token 监控入口(工具/模型/用量)。

- **动态插件探针 → 部署级插件落地**:先以动态 Cordis 插件(probe pkg-1..5,正式器
  pkg-6/7 UI)探明:① `llm/stream` options 含 sessionId/provider/model,chunk
  `{type,usage}` 实报 `inputTokens/outputTokens/cacheReadTokens/reasoningTokens`;
  ② `tools/result` exec.name/agent.id;③ 官方 `sessionProjections` 已有
  `tokenUsage/contextPressure/contextBreakdown/sessionStats` + `tokenMeter.measure`
  总口径(全历史、跨重启)。因 **dynamic list 槽条目 priority 由宿主强制分配且
  恒低于内置**(`allocatePriority: --nextPriority`,非 chain 槽不可覆盖),动态
  `conversation.view` Tab 恒排最左、无法经 order 置于轨迹右侧 → 定稿为
  **profile bundle 部署级插件**(与 ui-trajectory 同层,bundle 插件 priority 正常,
  order 15 生效于轨迹右侧)。
- **产物**:`plugins/dsh-token-monitor/` —— package.json(dsh.bundle.patch +
  dsh.client web)、cordis.patch.yml(insert)、host `lib/index.js`(llm/stream
  waterfall 透传包装 + tools/result + webServer 精确路由
  `GET /dsh-token-monitor/summary?sessionId=…` 返回官方聚合+实时明细)、
  client `lib/client.js`(手写 `window.__ModuleLoader__.load` bundle,主题令牌
  化 UI,3 秒轮询)。
- **接线**:`%USERPROFILE%\.dsh\profiles\web\package.json` dependencies+bundles 加
  `dsh-token-monitor`(file:),profile 目录 `pnpm install` 完成;**需 host 重启(重建
  web bundle 图)后生效**。
- **清理**:动态插件 `tokmn-1`(pkg-1..7)已 `cordis_stop`(定义保留以备回滚);与
  部署版同 id `token-monitor` 的重复注册冲突已消除。
- 触摸点:`plugins/dsh-token-monitor/`(新增)、
  `%USERPROFILE%\.dsh\profiles\web\package.json`、README.md(目录树+插件章节)。

## 2026-08-30 · 优化:桌宠边缘噪点修复 + 总指挥工作动态 + 权限申请提示

依据:用户「桌宠边缘有噪点,也不显示工作状态或提示权限申请」。

- **噪点根因**(已核实源码,见 `dsh-miasaki-shared-docs/cross/ab-linkage-pet-fleet-status-2026-08-18.md` 现状盘点):
  1. 运行时 `pet_native.rs` 对像素**零过滤**(`a>0` 即上屏,`load_png` 整数预乘截断 ≤1 级偏暗);
  2. 素材端清理粗糙:`cut-frames.mjs` kurumi 切格完全不清理、whale `stripGreenEdge`
     只杀绿色主导像素(非绿色半透明光晕满 alpha 残留);
  3. `inverse-states.mjs` 人造 2px alpha=150 环带且颜色是残留底色(噪点本体);
  4. 叠加 `blit_center_bottom` 非整数最近邻缩放(208→270 ×1.298)把单点杂色撕成锯齿簇,
     inverse 540→270 隔行丢弃破坏抗锯齿。
- **修复**:
  - 素材端治本(`scripts/cut-frames.mjs` + `scripts/inverse-states.mjs`):新增共用
    `despeckle(buf)` —— `a<24` 阈值 + `0<a<128` 像素 8 邻域无强前景(a≥128)→ 0
    (杀散点本体+半透明光晕浮雾);kurumi/whale 接入 despeckle(whale 串在
    `stripGreenEdge` 之后);inverse 环带 2px→1px、颜色取邻近前景均值替代残留底色,
    despeckle 兜底。重跑 `node scripts/cut-frames.mjs` + `node scripts/inverse-states.mjs`。
  - 运行时保险(`src-tauri/src/pet_native.rs`):`load_png` 加 `a<8 → 0` 兜底,
    预乘改四舍五入 `(c*a+127)/255` 消除 ≤1 级偏暗;`blit_center_bottom`
    最近邻→**预乘空间双线性采样**(中心对齐源坐标,4 邻域按权重混合预乘值,数学上
    正确且 ULW 兼容),对 kurumi/whale ×1.298 放大起平滑、对 inverse 540→270
    等效 2×2 均值下采样保住边缘抗锯齿。
  - **总指挥工作动态 + 权限申请提示**:
    - 范围:桌宠**只反映 DeepSeek 总指挥(主会话)** 的工作动态,agent 员工状态
      后续归 `dsh-miasaki-fleet/fleet-monitor/` 工作面板。
    - `themes/runtime.js`:新增 `scanActivity()`(查找"停止生成"按钮 → 'busy')和
      `scanApproval()`(在 dialog/modal/approve 容器内同时存在"允许"+"拒绝"类
      按钮 → true);act 防抖 2 次连续确认、wait 出现立即上报/消失 2 次确认;
      `syncHash` 拼 `&act=Z&wait=0|1` 字段;**临时探针** `window.__miasakiProbe()`
      输出当前候选按钮文本便于 Operator 校准选择器。
    - `scripts/gen-bubbles.ps1`:台词池尾部追加 3 帧状态文案("忙碌中…"/"等待审批"/
      "需要你的批准"),`bubbles.png` 17→20 帧。
    - `src-tauri/src/pet_native.rs`:`PetShared` 增 `activity`/`waiting_approval` 字段;
      `NativePet` 增 `set_activity()`/`set_waiting_approval()`;`compose` 映射优先级
      **waiting > busy > intensity** —— waiting 强制 kurumi `wait` 行 / whale·inverse
      `work` 立绘 + **常驻"等待审批"气泡**(状态帧跳过 3s 过期),禁止 ambient/wander;
      waiting 中单击桌宠 = 唤起主窗口(跳过 hop,免破坏等待观感)。
    - `src-tauri/main.rs`:`parse_fragment` 增 `act=`/`wait=` 解析;
      `start_hash_watchdog` 分发到 `set_activity`/`set_waiting_approval`。
- **构建验证**:`cargo build --release --offline` 27.52s 通过,启动 Miasaki 8s
  验证进程存活 + 桌宠窗口创建 + 帧加载(`whale_states=3, kurumi_rows=6`),
  hash 通道 `set_mode whale` + `set_intensity idle` 正常;runtime.js 解析+执行验证通过。
- **待真会话校准**(用户/Operator 跑时):console 执行 `__miasakiProbe()` 看
  `act=`/`wait=` 候选按钮文本是否匹配,按需微调 `ACT_BTN_TEXT` / `APPROVE_TEXT` /
  `DENY_TEXT` / `APPROVE_CONTAINER_SEL` 常量(集中在 runtime.js 顶部)。
- 触摸点:`scripts/cut-frames.mjs`、`scripts/inverse-states.mjs`、
  `scripts/gen-bubbles.ps1`、`ui/pets/**`(重生成产物)、`themes/runtime.js`、
  `src-tauri/src/pet_native.rs`、`src-tauri/src/main.rs`。
- 后续阶段:桌宠内一键审批(Rust→JS eval 点页面"允许"按钮,通道现成;依赖
  当前校准的选择器) + 员工状态监控(fleet-monitor 工作面板增强),本期仅留接口。

## 2026-08-30 · 修饰:软件图标倒角改圆润（直角 → 圆角矩形）

依据:用户「把软件图标倒角改圆润点」。

- **根因**:`scripts/make-icons.mjs` 的应用图标段(icon-new.png → app-icon-source.png /
  app.png)只有 resize,无任何圆角处理——全套图标(icon.png 512 实测四角 alpha 全 255)
  为纯直角方形,Windows 任务栏/桌面呈现生硬。
- **修复**(`scripts/make-icons.mjs`):新增 `roundedRectMaskSvg(size, ratio)` 圆角矩形
  蒙版(默认半径 24% 边长,≈ Windows 11 风格更圆润,可调),应用图标两处输出
  (1024 `app-icon-source.png`、128 `ui/icons/app.png`)均经 `dest-in` 蒙版合成,
  四角透明;主题徽章(pure/zafkiel/inverse)本就是圆形裁切,不受影响。
- **全链路重生成**:`node scripts/make-icons.mjs` → `npx tauri icon
  src-tauri/app-icon-source.png` 重生成全套(`icon.ico`/`icon.icns`/32-256 png/
  StoreLogo/Square*/ios/android)。
- 触摸点:`scripts/make-icons.mjs`、`src-tauri/app-icon-source.png`、
  `src-tauri/icons/*`(全套)、`ui/icons/app.png`。
- 验证点:四角 alpha 校验通过(icon.png/128/32/app.png center=255、corners=0);
  重新 `npm run tauri build` 后 EXE/安装包/加载页图标均为圆角。

## 2026-08-29 · 修复:右上角关闭按钮无反应（cmd 名不匹配 + 关闭弹窗模块丢失）

依据:用户「桌面端右上角关闭没反应」。

- **根因(双断点)**:
  1. `themes/runtime.js` 标题栏关闭按钮发送 `cmd=exit`,而 Rust 侧
     `start_hash_watchdog` 的 match 只有 `"close" => request_close` 分支,
     `exit` 落入 `_ => {}` → 无任何反应;
  2. 前端关闭确认弹窗模块(`buildCloseDialog` + `window.__miasakiOpenCloseDialog`)
     在 11:33→14:04 的重构中整体丢失——Rust `request_close` 经
     `eval("window.__miasakiOpenCloseDialog && ...()")` 唤起弹窗,函数不存在 → 弹窗不出。
     现状为"点 X 完全静默"。
- **修复**(`themes/runtime.js`):
  - 标题栏按钮 `petHashCmd('exit')` → `petHashCmd('close')`(与 Rust match 对齐);
  - 从 debug EXE(11:33 构建版)提取并恢复完整弹窗实现:弹窗 CSS
    (`#miasaki-close-mask`/`#miasaki-close-dialog` 主题自绘)、
    `buildCloseDialog()`(取消/确认按钮、mask 点击关闭)、
    `window.__miasakiOpenCloseDialog` 导出(本地页确认走 invoke `shutdown`,
    失败回退 hash 通道;远程页走 hash `cmd=shutdown`);
  - onReady 无条件构建弹窗(本地唤醒页 Alt+F4 同样可用),1s 巡检补
     `#miasaki-close-dialog` 重建。
- 触摸点:`themes/runtime.js`(→ `npm run gen-init` 后 `src-tauri/injected/theme-init.js`,
  → 重编 EXE 并同步 `dist/Miasaki.exe`)。
- 验证点:重启桌面端后点右上角 X → 弹出「关闭 Miasaki?」弹窗(随主题配色)→
  取消仍在运行 / 确认后 DSH 停止 + 应用退出;Alt+F4 与托盘退出同路径。

## 2026-08-29 · 修复:反转狂三主题图标裁切失真（立绘换版后固定窗口失效）

依据:用户「dist 下 exe 打开的反转狂三图标有问题」。

- **根因**:`scripts/make-icons.mjs` 的 inverse 图标按旧立绘尺寸假设取
  「中上部 92×92」固定窗口;8-23 反转狂三立绘换成 332×540 的 Q 版全身构图后
  窗口失效,图标只裁到脸的中上一条(缺头顶/下巴/肩部),13:16 生成起即失真。
- **修复**(`scripts/make-icons.mjs`):自适应头部定位两代迭代——
  初版按全图亮区(lum>90)bbox 定位,但被衣服高光拉满整幅
  (side clamp 成全宽、top=97 → 头顶整段被切,用户复报);
  最终版改为**仅在立绘顶部 35% 高度内统计 alpha bbox 与最大行宽**——
  方形窗口以该 bbox 居中、顶边取内容起始(留 1% 余量)、宽含发梢
  (本次实测:窗口 left=56 top=1 side=228 → 头顶/双眼/下巴/肩部完整入徽章);
  检测失败时显式抛错(不产出静默坏图)。
- 触摸点:`scripts/make-icons.mjs` → `ui/icons/theme-inverse.png`(已同步
  `dist/ui/icons/theme-inverse.png`;图标经素材服务读磁盘/内嵌,无需重编桌面端)。
- 验证点:重启桌面端后切换狂狂帝,右下角按钮与面板图标显示完整头部徽章;
  pure/zafkiel 图标不受影响(其源图尺寸未变)。

## 2026-08-29 · 素材内嵌:图标与桌宠帧编译期打进 EXE（无需再外置 ui/）

依据:用户「这些图标素材必须外置吗」。

- **改造**:素材读取从「仅磁盘 ui/(EXE 旁)」改为**磁盘优先 + 内嵌兜底**——
  - `build.rs`:构建时扫描 `ui/` 生成 `src/assets.rs`(build.rs 产物,gitignore),
    以 `include_bytes!` 内嵌运行时素材全套:icons(pure/zafkiel/inverse/app)、
    `pets/frames.json`、`pets/bubbles.png`、kurumi 63 帧、whale/inverse 立绘 11 帧
    (共 76 项,EXE 增加约 6MB);
  - `main.rs` 素材服务(39800)与 `pet_native.rs` 的桌宠帧加载统一走
    `assets::read()`:先读 EXE 旁 `ui/`,无则回退内嵌;
  - dist/NSIS 安装布局(EXE + ui/)不受影响(磁盘仍在;单文件拷贝 EXE
    图标/桌宠素材完整,不再强制外置)。
- 触摸点:`src-tauri/build.rs`、`src-tauri/src/main.rs`、`src-tauri/src/pet_native.rs`、
  `.gitignore`(ignore `src-tauri/src/assets.rs`);产物 `dist/Miasaki.exe` 已更新。
- 验证点:单拷 `dist/Miasaki.exe` 到任意空目录启动——主题按钮图标、标题栏徽记、
  桌宠三形态帧与气泡全部正常(此前图标/桌宠素材 404 全部缺失)。

## 2026-08-29 · 修复:主题切换条巡检重建死锁（按钮消失后无法自愈）

依据:用户「桌面端右下角主题切换按钮到底怎么回事」。排查确认用户当日实际运行的是
11:33 构建的 debug EXE,其内嵌脚本仍是「title 内嵌」坏版(HTML 字符串拼接 `title="…"`
属性,在真实 Chromium 中使 `switcher.innerHTML = html` 抛
`TypeError: html is not a function`,被 onReady 的 try/catch 吞掉后切换条整体消失,
该坏版已由 14:04 修复产物 + 14:05 release EXE 取代,但用户尚未验证新 EXE)。

- **根因(本次修复)**:`buildSwitcher()` 开头 `if (switcher || !document.body) return`。
  switcher 元素一旦被页面重渲染移除(或构建中途抛错、元素未挂载),`switcher` 变量
  仍非空 → 1s 巡检发现 DOM 无 `#miasaki-switcher` 调 `buildSwitcher()` 时直接 return,
  **永远无法重建**,按钮永久消失直到页面刷新。
- **修复**(`themes/runtime.js`):判断标准从「变量非空」改为「真实挂载」——
  `if (switcher && switcher.parentNode) return`。元素被移除后 parentNode=null,
  巡检下一轮即可重建;构建中途抛错时(新元素未挂载)同样可重试,不再死锁。
- 触摸点:`themes/runtime.js`(→ `npm run gen-init` 后 `src-tauri/injected/theme-init.js`)。
- 验证点:`gen-init` 令牌校验通过;需重新构建 EXE(`npx tauri build --bundles nsis` 或
  `cargo build --release`)后验证:DSH 页右下角按钮出现;若页面重渲染移除按钮元素,
  1s 巡检应自动重建(此前为永久消失)。

## 2026-08-29 · 标题栏窗口控制按钮图标优化（SVG 化 + 最大化状态同步）

依据:用户「优化一下桌面端右上角最小化最大化关闭图标」。

- **根因(旧实现)**:三个按钮用 Unicode 字符(– / □ / ✕)当图标——en-dash 偏细偏短、
  `□` 实心方块块面感过强、`✕` 笔画粗细不可控,三者字形基线不一致、风格不统一;
  且最大化按钮无状态区分,窗口最大化后仍显示「最大化」方框。
- **修复**(`themes/runtime.js`):
  - 新增 `TB_ICONS` 常量:四枚内联 SVG(16×16 视口,`currentColor` 描边、圆头端帽,
    Windows 11 Fluent 线形)——最小化=水平短线、最大化=矩形+加粗顶边、
    还原=双框错位(右上后框+左下前框)、关闭=X 交叉线;按钮 hover 变色自动跟随主题。
  - **最大化↔还原状态同步**:`wireMaxState()` 经 `window.__TAURI__.window.getCurrentWindow()`
    的 `onResized`(120ms 防抖)+ `isMaximized()` 驱动图标切换——双击标题栏、
    Win+↑ 等系统路径改变窗口状态同样同步,而非仅凭自己的点击;监听仅注册一次,
    标题栏被页面重渲染重建(1s 巡检)后 `syncMaxBtn()` 立即补查真实状态,图标不丢失。
  - 非 Tauri 环境(普通浏览器调试预览)点击最大化按钮时本地翻转图标兜底。
- 触摸点:`themes/runtime.js`(→ `npm run gen-init` 后 `src-tauri/injected/theme-init.js`)。
- 验证点:`node scripts/build-init.mjs` 令牌校验通过;sharp 渲染四态图标(常规/hover/
  close-hover)目检线条粗细一致、还原图标错位形态正确;构建 EXE 后窗口最大化时
  按钮显示「还原」图标,还原后回「最大化」。

## 2026-08-29 · 软件图标更换:DeepSeek 娘(用户提供图)

依据:用户「用这个做软件图标」+ 附 DeepSeek 娘立绘(960x960,底部黑底
「DeepSeek」文字条),选择「裁掉文字条,聚焦人物」方案。

- **源图处理**(一次性,`_refs/prepare-icon.mjs`):黑条从 y~808 起 → 裁
  `(left:154, top:0, 806x806)` 方形主体(内容中心 570 / 方形中心 557,构图
  基本居中;比耶手势右缘 941 完整保留),lanczos3 放大 1024x1024 写入
  `src-tauri/icon-new.png`(旧「时钟蔷薇」艺术图仍在 git 历史,可回退)。
- **全链路重生成**:`node scripts/make-icons.mjs`(icon-new.png →
  `app-icon-source.png` + `ui/icons/app.png` 128 加载页图标)→
  `npx tauri icon src-tauri/app-icon-source.png` 重生成全套
  (`icon.ico`/`icon.icns`/32-256 png/StoreLogo/Square*/ios/android)。
- **安装包图标**:`tauri.conf.json` 新增 `bundle.windows.nsis.installerIcon`/
  `uninstallerIcon`(均指向 `icons/icon.ico`)——原先 NSIS 安装包默认用
  NSIS 自带图标,首轮构建验证时发现后补齐。
- 触摸点:`src-tauri/icon-new.png`、`src-tauri/app-icon-source.png`、
  `src-tauri/icons/*`(全套)、`src-tauri/tauri.conf.json`、`ui/icons/app.png`。
- 构建说明:本机 MSI 打包(light.exe)因 Windows Installer 服务访问受限失败,
  改用 `npx tauri build --bundles nsis` 产出安装包(已验证)。
- 验证点:重新 `npm run tauri build` 后,EXE/安装包/加载页标题栏图标均为
  DeepSeek 娘;小尺寸(32px)下人物聚焦、无文字黑带残留。

## 2026-08-29 · 桌面端:修复右下角主题切换条悬浮介绍全部相同

依据:用户「右下角选择主题模式鼠标悬浮介绍都是鲸鱼娘主题的介绍」。

- **根因**:`themes/runtime.js` 的 `buildSwitcher()` 为每个主题选项 `.ms-opt` 渲染
  名称/副标题,但未设置各自 `title` 属性;而 `refreshSwitcher()` 给整个
  `#miasaki-switcher` 设置 `title = TIPS[current]`(当前主题提示)。浏览器 hover
  无 `title` 的子元素时向上取最近祖先前缀 → 三个主题选项悬浮提示全部显示
  **当前主题**(如 pure/鲸鱼娘)的一句文案,看起来"都是鲸鱼娘主题的介绍"。
  **注意**:曾尝试在 HTML 字符串内嵌 `title` 属性,但在完整内联主题 STYLES
  环境下会使 `switcher.innerHTML = html` 抛 `TypeError: html is not a function`
  (真实 Chromium 复现;构建失败被 try/catch 吞掉,1s 巡检因 `switcher` 变量
  已占位无法重建 → 切换条整体消失)。最终实现改在 DOM 构建后 `setAttribute` 设置。
- **修复**:
  - 每个 `.ms-opt` 在 `switcher.innerHTML` 赋值后经 `setAttribute('title', …)`
    设置独立提示(缺失回退 `META[t].name · META[t].sub`),
    hover 选项时原生悬浮提示显示该主题自己的介绍;
  - 面板底部 `.ms-tip` 增加 hover 联动:`mouseenter` 显示对应主题提示、
    `mouseleave` 恢复当前主题提示(`TIPS[current]`);
  - 切换条整体 `title`(按钮/空白区)仍为当前主题提示,行为不变。
- 触摸点:`themes/runtime.js`(→ `npm run gen-init` 后 `src-tauri/injected/theme-init.js`)。
- 验证点:真实 Chromium(Edge 151 headless)加载构建产物,`#miasaki-switcher`
  构建成功且三选项 `title` 分别为「原版 DSH · 简约纯净」/
  「ふふふ,今晚的时间也属于我呢」/「选好了吗?我讨厌犹豫的人」,
  不再全部是当前主题的介绍;桌面端 EXE 构建部署后同效。

## 2026-08-29 · 修复:桌宠显隐切换条件反转（边缘杂色跳动 + 日志刷屏）

依据:用户现场「桌宠边缘有杂色跳动」。

- **根因**:显示/隐藏切换比较条件写反 —— `want_hide != self.shown` 应为
  `want_hide == self.shown`。初始态(want_hide=false 想显示 / shown=true 已显示)
  语义一致但布尔不等 → 进入分支,每 33ms tick 重复执行 ShowWindow +
  UpdateLayeredWindow(dirty 置位) + pet.json 原子写 → 分层窗口高频重提交,
  合成器边缘出现杂色抖动;pet.log 同步刷屏(每秒 ~30 行「shown (hide persisted)」)。
  切换后的 `self.shown = !want_hide` 幂等(不再变化),故日志只有 show 无 hide,
  无用户操作也持续触发。
- **修复**:条件改为 `want_hide == self.shown`(目标隐藏态==实际显示态才需切换,
  含 (true,true)=想藏但已显、(false,false)=想显但已藏 两种)。
  JS 状态机模拟验证:修复前 10/10 tick 触发,修复后稳定 0 触发;隐藏操作只切 1 次且结果正确。
- 触摸点:`src-tauri/src/pet_native.rs`(compose 命令消费块)。

## 2026-08-29 · 桌面端:桌宠位置屏外修复 + 设置面板(设置 → 桌宠)

依据:用户「桌宠没启动,而且应该在设置里有桌宠设置选项」。

- **「桌宠没启动」根因定位**:桌宠窗口实际随应用正常创建(pet.log
  `window created at 2902,930`),但位置保存在 `pet.json` → 屏幕 2560×1440 下
  (2902,930) 完全位于屏幕外(显示器布局变化/历史遗留坐标),用户看不到。
- **位置可见性校验**(`pet_native.rs`):新增 `EnumDisplayMonitors` +
  `GetMonitorInfoW` FFI 枚举全部显示器工作区;`initial_pet_state()` 要求位置
  中心点落在任一工作区,否则回默认 (1200,500) 并保留隐藏设置,pet.log 记录回退。
- **pet.json 版本化 v1**:`{version:1, x, y, hide}` + 原子写(temp+rename);
  损坏/版本不符 → 全部默认重建(不静默零值,兑现 bootstrap-reliability.md §4.1
  遗留项);`hide` 持久化,重启保持隐藏状态,恢复时圆点可见、可点击显示。
- **显隐/重置命令统一到窗口线程**:右键菜单「隐藏桌宠」与面板命令只写
  `PetShared` 标志,UI 切换 + pet.json 落盘由 compose(窗口线程)消费执行,
  避免多线程 user32 调用;`PetWin` 增加 `shown` 镜像字段。
- **hash 通道扩展**(`main.rs`):`cmd=pet-show/pet-hide/pet-reset/pet-state`;
  新增 `push_pet_state()` 经 eval 下发 `miasaki-pet-state` CustomEvent(状态回显)。
- **新增 DSH bundle `plugins/dsh-pet-panel/`(桌面端设置面板)**:
  settings.section「桌宠」(order 26,client bundle 手写 `__ModuleLoader__` 格式):
  显示/隐藏开关、位置重置、状态回显;非桌面端(无 `window.__MIASAKI_BOOTED__`)
  降级提示。host 侧空壳(职责全在 hash 通道);安装入
  `%USERPROFILE%\.dsh\profiles\web\package.json`(dependencies + bundles)。
- 触摸点:`src-tauri/src/pet_native.rs`、`src-tauri/src/main.rs`、
  `plugins/dsh-pet-panel/`(新增)、`%USERPROFILE%\.dsh\profiles\web\package.json`、
  `README.md`、`design/TODO.md`。
- 验证点:重启桌面端后桌宠出现在默认位置(而非屏外空窗);设置 → 桌宠
  (host 重启后生效):开关隐藏/显示(重启保持)、位置重置回到 (1200,500)、
  右键菜单显隐与面板状态一致;桌宠拖到屏外后重启自动回默认。

## 2026-08-29 · 桌面端:关闭确认弹窗 + 启动画面主题统一

依据:用户「桌面端启动画面需要优化,画面不统一」「关闭桌面端应弹窗提醒是否关闭应用,选择关闭应用
应该同步关闭后端」。

- **关闭确认弹窗(主题自绘,所有关闭入口收敛)**:标题栏 X / 系统关闭(Alt+F4)/ 托盘「退出」/
  桌宠右键「退出应用」统一走 `request_close` → 唤起主窗口并显示确认弹窗(`runtime.js` 注入
  `#miasaki-close-dialog`,色板随三主题 `--ms-*` 变量)。「关闭应用」→ hash `cmd=shutdown`
  → `shutdown_app`:**停止由桌面端拉起的 DSH 后端**(按 spawn 时记录的 PID `taskkill /T /F`
  杀进程树)再退出;「取消」仅收起弹窗。非本应用拉起的后端(用户手动 `dsh web` / 端口已在运行
  时接入)不触碰。兜底:仅 Alt+F4 连击(5s 内二次系统关闭,前端无响应)强制退出(不杀后端,服务保持)。
- **启动画面统一**:
  - `loading.html` 移除自带标题栏(`.tb`),统一由 `runtime.js` 构建 `#miasaki-titlebar`
    (本地唤醒页与 DSH 页同款画面);本地页不再构建切换条/水印/光晕,保持启动画面简洁。
  - 修复 `IS_LOCAL` 判定:Windows 上 Tauri 2 协议为 `http://tauri.localhost`,
    原 `location.protocol === 'tauri:'` 恒 false → 本地页出现重复标题栏 + 切换条
    (这正是「画面不统一」);现以 protocol + hostname + pathname 三重判定,并修正巡检
    在本地页重建切换条的问题。
  - 启动画面随主题换肤:主题偏好由 DSH 页 hash 通道同步 Rust 落盘
    `%APPDATA%\com.miasaki.desktop\prefs.json`(原子写),启动时经 `__MIA_THEME__` 注入
    initial script;`loading.html` 按 `html[data-miasaki-theme]` 渲染三套色板 + 主题纹章
    (刻刻帝钟面 / 狂狂帝破裂表盘 / 原版简约环)。
- **命令收敛**:移除 `exit_app` / `minimize_main`(标题栏按钮改走 hash `cmd=close` / `min`);
  hash `cmd=exit`(直接退出)移除,防绕过确认。
- **素材服务提前**:`start_asset_server` 移至 setup 开头(启动页标题栏图标同源加载,防 404 竞态)。
- 触摸点:`themes/runtime.js`、`ui/loading.html`、`src-tauri/src/main.rs`、
  `src-tauri/src/pet_native.rs`、`src-tauri/injected/theme-init.js`(构建产物)、
  `README.md`、`design/themes.md`。
- 验证点:标题栏 X → 弹窗(随三主题配色)→ 取消仍在运行 / 确认后 DSH 停止 + 应用退出;
  DSH 页切换主题后重启桌面端,启动画面同主题;托盘、桌宠退出弹窗同路径;本地页无切换条。

## 2026-08-24 · 启动可靠性(Bootstrap Reliability)第 1 部分

依据:`design/bootstrap-reliability.md`(设计定稿,借鉴 deepseek-harness-desktop 的
启动恢复/健康标记/可靠性矩阵思路)。

- **bootstrap.json 健康标记(v1)**:`%LOCALAPPDATA%\miasaki\bootstrap.json`,记录每次启动的
  `lastAttempt{at,phase,detail,dshAvailable}` 与 `lastOk`;阶段流水
  bootstrap → spawn(失败,语义化错误) → waiting(3s 低频心跳) → up(3080 页面加载成功);
  90s 未就绪仅提示一次(端口占用排查指引)。损坏/版本不符 → 删除重建默认(不猜不静默)。
- **失败恢复页(loading.html)**:失败时显示恢复动作组——检查 dsh / 打开终端 / 打开日志目录 /
  导出诊断;页面初始化读取上次启动状态,上次失败(spawn/waiting)会提前提示且不阻塞本次启动;
  上次成功显示「已进入」时间。恢复动作仅本地页可 invoke(远程 3080 页受 remote-dsh.json 限制,不暴露)。
- **dsh 安装检测**:spawn 前 `where dsh` 探测 → 未安装时提示安装指引(而非笼统的"启动失败")。
- **重试换代修复(既有 bug)**:原「重试」按钮在 spawn 失败后实际无效(LAUNCHING 已置位且旧循环
  不再 spawn);引入 `BOOTSTRAP_GEN` 代际计数,retry 时换代,旧序列检测到代际变化退出,
  新序列完整重跑(bootstrap/spawn/探活)。
- **导出诊断**:聚合 server.log/pet.log 尾部(各 ≤512KB)+ bootstrap.json + window.json + pet.json
  + OS 信息 → `%APPDATA%\com.miasaki.desktop\diagnostics-<ts>.txt`(只读副本,不触碰原日志)。
- **原子写铁律落地**:bootstrap.json 与 window.json 均改为 temp+rename(原 window.json 直接
  `fs::write`,崩溃/断电可半写)。
- 触摸点:`src-tauri/src/main.rs`、`ui/loading.html`、`design/bootstrap-reliability.md`(新增)、
  `design/TODO.md`、`README.md`。
- 验证:`cargo check --offline` 通过;`gen-init` 令牌校验通过;loading.html 内嵌 JS 语法检查通过。
  真机待验:三条失败用例 + 正常启动回归(见设计文档 §6 验收标准)。

## 2026-08-22 · DSH 插件:免费模型池(Free Model Pool) v0.2 — 多平台扫描 + 能力画像

依据:用户要求「以后可能不仅 OpenRouter,其他平台也会有」+「边界明确:这些模型能干什么、
适合干什么,都要快速分析决策怎么使用」。

- **多平台化**:扫描对象从写死 OpenRouter 改为 `llm-pi-ai.providers` 中**所有带 baseURL 的
  OpenAI 兼容平台路由**;detect/apply/subagent 全部带 `platform` 参数,新平台配置后自动出现,
  零插件改动。status 返回平台列表(displayName/endpoint/apiKeyEnv/configuredCount)。
- **免费判定分层**:`:free` 后缀 → pricing 全零 → 名称含 免费/free;三层任一命中即收录,
  避免单规则漏检(真实 OpenRouter 列表:17 个 `:free` + 零定价预览 2 + `openrouter/free`
  特殊路由 1 = 21)。实测无误报付费模型。
- **能力画像 `analyzeModel`**:从端点自述提取 工具调用/tool_choice/推理/编码/视觉/结构化输出/
  超长上下文/预览标记,产出三档 verdict:
  `首选(复杂|编码|多模态)子代理` / `可用:通用子代理` / `仅问答、批处理(无工具调用)` /
  `需实测验证(有 tools 无 tool_choice)`;warnings 标出 缺 tool_choice/预览模型/输出上限低/上下文小。
  子代理门槛 = tools + tool_choice(DSH agent loop 依赖工具循环)。
- **决策摘要 summary**:bestAgent(评分排序首位)/codingAgent/longContextAgent/visionAgent
  (仅子代理可用者计)/agentCount/qaOnly;面板顶部直接呈现,子代理切换默认推荐最佳。
- 判定原则:画像从端点自述而非 benchmark ELO,无自述者标「元数据缺失」而非猜测。
- **持久化机制修正**:pnpm `file:` 依赖按包版本缓存 store 副本,改源码后 `pnpm install`
  不会刷新(实测 DIFF);需 `--force` 或直接复制 `lib/*` 到 node_modules 并核对哈希;
  本版随功能升 0.2.0 并同步部署副本。
- 验证:离线冒烟(fake hub:三免费标记、付费不误报、canAgent/code/vision/tools-only 四类画像、
  排序与摘要语义)全 PASS;真实 OpenRouter 审计 21 模型 verdict/warnings 全部一致,无误报。
- 触摸点:`plugins/dsh-free-model-pool/lib/index.js`(analyzeModel + 多平台路由)、
  `lib/client.js`(平台选择器 + 画像行 + 摘要块)、`lib/index.d.ts`/`lib/types/detect.d.ts`、
  `package.json`(0.2.0)、`README.md`。

## 2026-08-22 · DSH 插件:免费模型池(Free Model Pool)

依据:用户在 DSH web 会话「配置聚合平台API检测免费模型」需求——从聚合平台(OpenRouter)
检测免费模型并用于子代理,首轮手工落地(settings.yaml 注册 openrouter 路由 + 预设
agentOptions),本轮把该能力固化为可重复使用的 DSH web profile bundle。

- **`plugins/dsh-free-model-pool/`(新增)**:host 插件 + 手写 client bundle 的 DSH bundle 包。
  - 面板:DSH「设置 → 免费模型池」(settings.section, order 25),
    检测结果列表(含 ctx/maxTokens)、写入全部/单个模型、一键切换子代理后端。
  - host 路由(webServer 注册,client 浏览器同源 fetch):
    `GET /freepool-api/status`(读 llm-pi-ai openrouter 配置)、
    `GET /freepool-api/detect`(拉 OpenRouter /v1/models,`:free` 后缀 + pricing 全零判定)、
    `POST /freepool-api/apply`(settings.update 深合并,保留其他 provider/字段,写入 openrouter.models)、
    `POST /freepool-api/subagent`(重写三预设 tool-subagent/tool-subagent-fork 的 agentOptions)。
  - 通信选型:client bundle 无动态 runner 的 `host.call`,故 host 侧走 `webServer.register`
    同源 JSON 路由(与官方 client-connection 的浏览器 fetch 一致);
    host 为普通 ESM(Node 全局 fetch 可用),不受动态插件 fetch 陷阱约束。
  - client bundle 为手写 `window.__ModuleLoader__.load({id, factory})` 格式(本机无 tsdown),
    遵循官方产物同构:`inject` 数组 + `apply` + `module.exports`;
    面板纯 `React.createElement`,无 JSX/import。
- **安装**:`%USERPROFILE%\.dsh\profiles\web\package.json` 以 `file:` 依赖引入并加入
  `dsh.profile.bundles`;pnpm install 后需重启 host 生效;改源码后重跑 pnpm install 同步。
- **验证**:离线冒烟(status/detect/apply/subagent 四路由,真 http 服务 + 假 settings/
  假预设目录副本)全 PASS;detect 命中 17 个 `:free` 模型;apply 保留 xiaomi 等其他 provider;
  subagent 正确更新 kurumi/whale/inverse 三预设。真机验证点:重启后面板渲染、写入后模型选择器出现、
  子代理实际切换模型。
- 触摸点:`plugins/dsh-free-model-pool/*`(新增)、
  `%USERPROFILE%\.dsh\profiles\web\package.json`(bundle 注册)、`README.md`。

## 2026-08-23 · 标题栏 × DSW 布局融合 + 主题装饰

- **标题栏与 DSH 页面融合**：背景/文字改走 DSH 本体令牌（`--dsw-alias-bg-base` / `--dsw-alias-label-*`），
  按钮 28px 圆形 + 圆底 hover，对齐 DSW 原生 UI 手感；新增 `syncTitlebarGeometry()` 模拟
  「侧栏色块向上延伸 + 详情面板分隔线向上延伸」，制造标题栏是页面一部分的错觉；loading.html 同步同款样式。
- **逐条对照 DSH 本体源码验证**（0.1.1-rc.1 前端包）：`--dsw-specific-sidebar-fill` 为 DSH 官方令牌
  （`dsh-client-ui-theme`，明暗双值 = sidebarCol 背景色），三主题经 `--dsw-static-*` 覆盖自动跟随；
  几何探测目标 = `dsh-client-ui-layout` AppFrame 的内联网格
  （`"${cols.sidebar}px minmax(0,1fr) ${cols.details}px"`），首列=侧栏/末列=详情/折叠=0px 全部吻合；
  全 DSH 前端仅此一处内联 `gridTemplateColumns`，首个命中无歧义；
  `::before/::after` 复用的 `--dsw-alias-border-l1/-l2` 与 DSH `sidebarCol`/`detailsCol` 的分隔线令牌同源。
- **P1 修复（1px 对齐）**：`::before` 加 `box-sizing:border-box`——grid item 默认 stretch 下
  border-box 宽 == 轨道宽，DSH 的 `sidebarCol` 分隔线画在轨道右缘**内侧 1px**，而原 `::before`
  为 content-box 时 border 画在轨道右缘外侧 1px → 双线错位 2px；改 border-box 后逐像素重合。
- **探测防御**：`--ms-details-left` 末列仅在网格声明 ≥2 列时取（防未来两列结构把侧栏宽误判为
  详情宽）；轨道 px 声明值优先、实测列宽降级为兜底（二者在 stretch 语义下相等）。
- **契约记档**：对 DSH 内部 DOM 的依赖（AppFrame 内联网格/首末列语义/折叠 0px）为隐性契约，
  上升为 `design/ARCHITECTURE.md` 已知约束（DSH 升级时需复核）。
- **标题栏装饰（用户需求「美化」）**：左端主题徽记（复用主题图标 20px 圆 + `--ms-glow` 主题光晕 +
  3.2s 呼吸，`prefers-reduced-motion` 禁用）+ 主题副标（`Zafkiel · XII` 等）；底部 1px 主题渐变底线
  （`--ms-deco-line` 独立声明 + 逐层回退，装饰失效不拖垮基底）：zafkiel 金→暗红檐线 + 金表圈内高光
  （inset）、kurkuriel 右重血红渐变 + 上下血红内线、pure 跟随 `--ms-border` 弱线保持极简。
  徽记清理链：加载失败字形兜底按 `data-glyph` 定位清除、onerror 用 JS 挂载（切主题后始终引用最新
  `current`）。
- 触摸点：`themes/runtime.js`（CSS + `syncTitlebarGeometry` + buildTitlebar/updateTitlebar）、
  `ui/loading.html`、`themes/{pure,zafkiel,kurkuriel}.css`、`README.md`。
- 验证：`build-init.mjs` 通过（令牌校验 + 53KB theme-init.js 产出，js 语法检查通过）；
  几何同步与装饰待真机验收（三主题切换 + 拖拽详情分隔线 + 侧栏折叠 + 窗口 resize + 徽记呼吸/底线观感）。

## 2026-08-22 · 桌宠 v2 阶段 A：动作丰富化（针对「动作少、僵硬」整改）

- 规划链路：学习 OpenDesign 宠物体系 → `design/pet-v2-roadmap.md`（总览+诊断+决策）→
  `design/pet-v2-phase-a-execution.md`（可开工执行方案）。僵硬诊断七条根因详见 roadmap §3.5。
- **反转狂三立绘清晰化（用户反馈「不像」）**：形象核查（高清源 1728×2368：银发、金钟眼 12:05、
  红瞳尖线、黑金哥特裙、血红内衬——形象本身正确）；根因是素材链退化 + v1 遗留断层：
  `inverse-states.mjs` 输出名为 `blue-*.png` 与 frames.json 引用的 `states/{idle,work,deep}.png` 错位，
  桌宠一直渲染 8/21 产的 128×208 旧图（钟眼糊成色块、形象沦为普通异色瞳少女）。
  修复：输出名统一 `{idle,work,deep}.png` + 输出档位 208 → 540 高（渲染 270 的 2 倍超采样）。
  三态现为 332/313/381 × 540，钟眼可辨认。
- **whale 帧拆分 bug（真机「缩放跳动」修复）**：`sharp(gif, {animated:true, page:p})` 的语义
  是「输出从第 p 页起的堆叠塔」而非单帧——拆出帧尺寸为 192×1248/1040/832/624/416/208，
  渲染按各帧宽高比缩放 → 每帧忽大忽小（真机截图可见「微型三连叠影」）。修复：整动画图
  用 `extract` 逐段切（顶部=帧 0），全部帧固定 192×208。教训：sharp animated 输出为垂直堆叠图，
  `page` 与 `animated` 组合语义反直觉，帧序列务必校验输出尺寸（`ui/pets/whale/states/idle-*.png` 已验）。
- **whale 绿色描边净化（真机反馈「绿边不好看」）**：`idle.gif` 为「透明替代色残留」型 GIF——
  制图用纯绿（0,254,0 / 0,126,0 等）当透明区而未标 alpha，帧边缘呈绿色系实色描边。
  新增 `stripGreenEdge()` 后处理（绿色主导像素 → alpha 0）接入 whale 拆帧链路，
  复检剩余绿色像素 0。素材审计原图/像素抽样两步确认非渲染 halo（半透明像素 0）。
- **专注态语义修正（真机反馈「狂三一直跳动」）**：强度分级实为 DSH 页面模型标签解析
  （`Max→deep / High→work`，runtime.js `CUR_INT`），页面常驻时 intensity 长期非 idle；
  v2 初版把思考中映射到 wait 行 + 4fps 慢放，wait 帧组帧间起伏（眨眼/下沉）被慢放放大 →
  观感「一停一顿的跳动」。修正：思考中=静默守候（idle 姿态，ambient 仅在 idle 强度触发自动安静），
  wait 行专属阶段 B 审批等待。决策 3 修订记录于 `design/pet-v2-roadmap.md` §7。
- 用户机体验反馈触点：真机验收发现跳动 → 截图取证（角色区/背景区对照差分 + 肉眼核查）→
  定位 whale 帧尺寸不一 → 修复后三张抽查帧尺寸一致，动画闭环正常。
- **素材全行切出（A0）**：`cut-frames.mjs` 的 `NEEDED` 4 行 → 全 9 行（idle/runRight/runLeft/wave/jump/failed/wait/run/review），
  kurumi 帧组 21 → 57 帧；wait/review/failed 行此前躺在 spritesheet 中未用（僵硬 #1）。
- **whale 帧序列（A6）**：`idle.gif`（192×1248 六帧条）拆为 `states/idle-00~05.png`；
  `frames.json` 三态值支持「帧组数组 | 单帧字符串」双形态；渲染侧统一为帧组（`Frames.states: HashMap<String, Vec<Image>>`），
  帧组 6fps 循环 + bob，单帧行为与历史一致。
- **修复 wave 不可达（A1）**：双击此前永远 `do_hop+focus_main`（README 声称的「双击=挥手」实为漂移）；
  现按决策改为：主窗最小化/隐藏 → 唤起，否则 → `do_wave()`（wave 行 1300ms）。
- **强度语义修正（A2）**：work/deep 不再原地播 run（僵硬 #3），改 `wait` 行守候（慢放 4fps），
  run 行只归属有位移的 wander——「移动才有跑步」。
- **呼吸与过渡（A3/A4）**：kurumi 基线（idle/wait 且无行动）加 ±2px 3200ms 呼吸 bob；
  跳跃落地加 200ms 末帧定格（`hop_hold_until`），消除硬切。
- **环境编排 + 滑步修正（A5）**：idle 基线低频随机小动作（池 wave/review/wait，jump 15% 偶发；
  表演 1.2~2.2s / 休息 8~18s / 首演 5.5s；指针按下即打断）；wander 滑步修正：位移从「每 tick 3px」
  改为「每帧 9px」（帧同步，90px/s 速度不变）；wander 改为 kurumi 专属（whale/inverse 不再无声滑行）。
- 触摸点：`src-tauri/src/pet_native.rs`（常量表/PetWin 字段/compose 状态机/FFI 交互）、
  `scripts/cut-frames.mjs`、`ui/pets/frames.json`、`ui/pets/kurumi/frames/`（+34 帧）、
  `ui/pets/whale/states/idle-*.png`（+6 帧）。
- 验证：`cargo check --offline` 通过；沙箱内冒烟通过——进程存活、`MiasakiPetWin` 286×390 物理尺寸正确、
  金点窗/托盘/单实例窗齐备；角色区像素活性对照差分成立（角色区 23K~32K px 变化 vs 背景区 0~5.4K，
  9/9 帧对变化，`_refs/scripts-archive/pet-pixdiff*.ps1` 可复用）。用户机验收清单见执行方案 §验证。

## 2026-08-22 · monorepo 重组（仓库结构）

- 仓库重组为三文件夹 monorepo（umbrella `dsh-miasaki` 仍是唯一 git 仓）：本目录 `dsh-miasaki-desktop/`（原 `desktop/` + `design/` 内移）、`dsh-miasaki-fleet/`（编排线）、`dsh-miasaki-shared-docs/`（跨线/DSH 平台参考）。
- `design/` 从仓库根移入本目录内部 → `build-init.mjs` 令牌面路径由 `join(root,'..','design',...)` 改 `join(root,'design',...)`（gen-init 验证通过，令牌校验 + 46KB theme-init.js 产出）。
- `README.md` 设计规范引用 `../design/` → `design/`；`.gitignore` 锚定路径前缀 `desktop/`→`dsh-miasaki-desktop/`。
- 安全网：tag `pre-reorg-2026-08-22` @ `10f8baa`；era tag `0.1.1-rc.1-era` 落在重组+修复后的 `bee066d`。

## 2026-08-22 · m36 冒烟收尾（工程）

- **`verify-themes.mjs` 断言修正**：`kurkuriel: 骨白基底令牌` 原检查 `--dsw-static-neutral-bluish-950 === '#e9e5e1'`，
  但 `kurkuriel.css` 自初版（4f07bd9）起该令牌即声明为 `#0f0d0b`——骨白实际走「DSH 亮色语义」亮端令牌
  （`--dsw-static-neutral-bluish-50=#fcfaf8`）+ `--dsw-alias-bg-base=rgba(247,244,241,.88)`。
  该断言从首次提交即不可满足，因 `verify-themes` 此前从未在真机跑通而潜伏。
  改为：亮端令牌 + alias 基底含 `247, 244, 241`，并新增「深端令牌同步覆盖 = `#0f0d0b`」佐证覆盖链路健康。
  真机首次完整跑通 **18/18**（0.1.1-rc.1 全局 CLI）。属测试断言修复，非主题代码回归。
- **m36 回归冒烟**：详见 `docs/m36-rc8-regression-smoke-2026-08-22.md`——m3-test/rc7-test 混装 profile
  `--dump-config` 双双 exit 0，rc7-test 插件树与 M3.5 基线 313 行字节一致，三主题端到端通过。

## 2026-08-22 · v0.1.4(第七轮)

- **桌宠 Agent 预设(三个)**:standard 底座复制 + 中文 persona。
  人设按桌宠贴合成角色(鲸鱼娘/狂三/反转狂三),调用偏好区分:鲸鱼娘先本地后网页、
  狂三复杂任务先规划后动手、反转狂三默认直接动手改动面大才计划;
  每条 persona 带硬性「入戏边界」——工具调用、错误报告、审批/凭证一律标准语气(中档扮演)。
  三个预设经 `standingKeyFor` 挂载校验通过;RPC 通道经真实创建验证。
- **主题→人格会话联动**:切换主题自动用对应桌宠的 Agent 预设开启新会话
  (官方 RPC `session.create` 的 `agentPreset`;优先挂当前 workspace)。
  每主题仅自动创建一次(localStorage 去重),RPC 失败静默降级不阻断切换。
- **三桌宠灵魂文件(pet.json)补全**:whale/kurumi/inverse 三份中文人设
  (inverse 新增 manifest + spritesheet.png/webp 图集,由 `scripts/make-inverse-sheet.mjs` 生成)。

## 2026-08-21 · v0.1.3(第六轮)

- **闪退根治(关键)**:GDI 高频创建改为**持久 DC/DIB 表面**(创建一次终身复用);
  气泡文本渲染从 33ms 心跳降到帧更新时;BmiHeader `biSize` 44 → 40 标准值。
  此前 gdi32full+0x2ae13 固定偏移崩溃连续出现 5 次(22:16/22:25/22:47/23:16…)。
- **主窗口位置/大小持久化**:关闭时保存 `%APPDATA%\com.miasaki.desktop\window.json`(物理坐标),启动时恢复(负坐标/过小尺寸防御)。
- **托盘菜单**:显示/隐藏主窗口、退出(`tray-icon` feature;左键点击不弹菜单)。
- **冒烟测试脚本**:`desktop/scripts/smoke-test.ps1`(交付物完整性 / 进程存活 / 桌宠窗口 / 素材加载 tick0)。

## 2026-08-21 · v0.1.2(第五轮)

- **GDI 句柄泄漏修复**:`present()`/`draw_text()`/`draw_dot()` 的 `SelectObject` 后未恢复原对象即 `DeleteObject`,
  33ms 高频下句柄耗尽 → gdi32full 崩溃;全部改为先恢复再删除,DC/DIB 创建失败提前返回。
- **防复发**:compose 加脏标记,静止时 `present` 频率 33ms → ≥125ms。
- **桌宠放大**:窗口 220×300 → 286×390,角色 208 → 270 高;气泡 170×36 → 210×48;金点 26 → 30;散步 2 → 3px。
- **拖窗跟手**:JS 发「按下起点累计物理增量(×DPR)」+ Rust 差值应用 + `move=reset` + 轮询 100ms → 33ms + pointercancel。

## 2026-08-21 · v0.1.1(第四轮)

- **桌宠动画循环真相**:`WM_CREATE` 期间 `GWLP_USERDATA` 未设置 → `wnd_proc` 的 `SetTimer` 从未执行
  → 桌宠自 v0.1 起只画一帧、永不刷新;修复:USERDATA 就位后显式 `SetTimer`。
- 二次根因:`compose` 每 33ms 清空 buf 但帧更新间隔 ≥125ms → 空帧闪烁;修复:清空移入帧更新分支。
- 明暗锁定修复:pure/system 切换时移除残留 `data-ds-dark-theme`(切回原版不再残留暗色)。
- 标题栏 36→32px 低调化、去阴影;切换条 hover 展开 + 300ms 延迟关闭 + 面板 hover 保活。
- `set_mode`/`set_intensity` 日志埋点。

## 2026-08-21 · v0.1.0 增补(第三轮)

- **apply() 核心同步优先**:syncHash/refreshSwitcher/updateTitlebar 提到装饰层之前并 try-catch,
  消除"装饰层异常 → 图标不换+桌宠不切换"连锁失败;自愈巡检 5s → 1s。
- 切换条交互重做(见上);标题栏按钮 `--ms-danger` 主题化。
- **软件图标重设计**:百炼生成「暗夜紫 + 鎏金时钟 10:10 + 绯红蔷薇」艺术图(icon-new.png),
  `npx tauri icon` 重生成全套;make-icons.mjs 换源并修复 inverse 徽章引用。
- set_mode 日志埋点;启动器 `--no-open`(rc.8 双窗口问题)。

## 2026-08-21 · 第二轮

- 桌宠待机随机行为(18-42s 气泡 / 22-50s 散步 + 贴边吸附)。
- **反转狂三全新立绘**:qwen-image-3.0 生成 3 态 + 深蓝背景 flood-fill 抠图(`scripts/inverse-states.mjs`);
  inverse 从「kurumi 重着色 atlas」改为立绘三态。
- 滚动锁死(`html,body overflow:hidden` + `#root calc(100% - 32px)`);aurora 光晕层 + 面板半透明化;水印增强。
- 清理:pet_native.rs 死代码、50+ 诊断截图、测试 profile、旧状态帧/inverse 图集。
- `inputModalities` 修复使 read_image 可用;百炼 skills 刷新 1.17.0。

## 2026-08-21 · 第一轮(rc.8 适配)

- 启动器加 `--no-open`(rc.8 起 `dsh web` 自动开浏览器 → 双窗口)。
- runtime.js 内页宠物死代码清理(-426 行,注入包 56KB → 38KB);删除 ui/pet.html/css/js。
- rc.8 令牌面核对:`--dsw-static-*` 73 个与 token-surface.txt 一致;`--json-tree-*` 等 8 个失效(死覆盖,无害)。

## 2026-08-17 · v0.1.0 初始

- Tauri 2 薄壳 + 三主题(纯色/刻刻帝/狂狂帝)+ 原生 Win32 分层窗桌宠(鲸鱼娘/狂三/反转狂三)。
- 用户验收通过("好了")。
