# CHANGELOG — dsh-miasaki-canvas

本文件记录 `dsh-miasaki-canvas/` 线的设计决策与变更。

## 2026-09-10

- **外部视图槽：让别的插件把入口长在画布页面自己的「对话 / 会话布」旁边（同日新增）**：
  - **起因**：SSH 线希望它的入口出现在**画布页面内部**那组切换按钮旁边。那组按钮属于画布自己的 iframe 文档（`/canvas/` 的 `topbar > .view-switch`），宿主 DOM 碰不到 —— 对方曾在浮层之上补整条工具条，被用户否掉（「只是让加一个 SSH 按钮，为什么会多出一整个上栏」）。
  - **做法**（通用，不含任何具体视图知识）：① 插件把 `{ id, label }` 写进**页面级注册表** `window.__DSH_CANVAS_VIEW_ITEMS__` 并派发 `dsh-canvas:view-items`；② 本线 client 半把它转成 `canvas:views` 下发给画布页面（**iframe `load` / 浮层打开 / 注册表变化**三处都发，覆盖"插件晚于画布加载"）；③ 画布页面在 `.view-switch` 里多渲染一个按钮，点击广播 `canvas:view`；④ **注册方自己**监听那条广播去切视图 —— 本包不解释 id 的语义、也不回调任何人，所以两线之间没有代码耦合，只有一份页面级约定。
  - **纪律**：只校验形状（`id` / `label` 都是字符串），不校验具体 id；收到 `canvas:views` 时守 `canReplaceView()` 再重渲染，不打断正在输入的用户；`app.js` / `client.js` 里**不得出现任何具体视图名**（连 "SSH" 字样都被测试锁死）。
  - **测试**：新增 `test/external-views.test.js`（3 例）—— 下发时机与解绑、画布页面的渲染与广播接线、跨线红线（无具体视图名 / 不引用别的线）。
  - 触摸点：`client.js`、`app.js`、`test/external-views.test.js`（新）、本文件、README。
  - **实机复验点**：装了 SSH 插件时，画布页面「对话 / 会话布」旁多一个「SSH」按钮，点它关闭浮层并切到 SSH 视图；卸载 SSH 后该按钮消失（注册表变化即下发）。

- **会话头部窄宽度自适应（展开右栏不再压叠）**：用户报告「展开右侧边栏会挤压」，截图显示「对话 / 会话布」切换器被右侧图标按钮压住、会话标题消失。归因、宽度预算与方案对比见 [设计](2026-09-10-conversation-header-crowding-fix.md)：
  - **根因**（读官方 `dsh-client-ui-conversation` 的真实 CSS 得出）：会话头一行里 `headerUtilities` / `headerCorner` 是 `flex:none`（不收缩），`titleCluster` 是 `flex:1; min-width:0`（可被一路压到 0），而它内部的 `headerActions` 又是 `flex:none` —— 中栏被右栏推窄到放不下时，actions 无处安放、**溢出**并与同样从 x≈0 起画的 utilities 重叠（DOM 靠后者在上层）。标题被 `crumbs` 的 `overflow:hidden` 裁没、`…` 仍稳在最右，都是同一机制的自证。画布切换器（≈116px）是 actions 里最宽的一项，让坏点显著提前；固定项合计 ≈411px，即中栏窄于 ≈410px 必然重叠。
  - **现场佐证**：用户把窗口拉宽后重叠消失、标题回归 —— 与「宽度不足」的归因一致。
  - **修复（本线）**：`ViewSwitch` 增加运行时自适应。`ResizeObserver` 观察 **`node.closest('header')`**（**不能观察自身**：自身是 `flex:none`，被挤压时宽度不变，观察自身检测不到溢出），判据是「自身左边界到 header 内容区左边的距离 = 留给标题的余量」，余量不足时降级为**图标形态**（≈116px → ≈64px）；图标形态下按钮无可见文字，`aria-label` / `title` 是唯一可访问名，必须保留。
  - **滞回**：进入 120px / 退出 200px。两种形态宽度差 ≈52px，滞回带必须大于它，否则形态切换自身改变的占宽会把判定推回去、来回抖动 —— 这条不变量已写成单测断言（`assert.ok(RELEASE - ENTER > 52)`）。
  - **测试**：新增 `test/header-adaptive.test.js`（4 项）。按本线既有手法从源码锚点截取 `compactDecision` 与两个阈值后 `new Function` 求值，覆盖判定边界、滞回、观察对象与卸载清理、紧凑形态接线与 CSS；另有一条反向断言 `doesNotMatch(/observer\.observe\(node\)/)` 防止改回观察自身。锚点改名或挪位会**响亮失败**。
  - **平台层兜底（desktop 线，同日）**：新增本体补丁 [`dsh-client-ui-conversation`](../dsh-miasaki-desktop/patches/dsh-client-ui-conversation/README.md) —— 把 `headerActions` 从 `flex:none` 改为 `flex:0 1 auto; min-width:0; overflow-x:auto`（+ 滚动条隐藏），溢出从「压叠」退化为「可横向滚动」。**canvas 侧保住可用性，补丁保证任何插件 / 任何窄窗口都不会再出现不可用状态**；两者独立，任一单独生效都有明显改善。
  - **验证**：`node --check client.js` 通过；canvas 单测 4 项全绿；`verify-all.mjs canvas` 与 `desktop`（含新补丁 verify）全绿。**实机复验点**：右栏展开时切换器收成图标、标题至少可见；拉宽后自动恢复完整形态。
  - 触摸点：`client.js`（本线为 link 安装，client bundle 在 host 启动时载入内存 —— **重启 `dsh web` 生效**）、`test/header-adaptive.test.js`（新）、本文件、README。

- **切换器把会话头撑高、连带整行下移 4px（同日修复）**：用户报告「展开右侧边栏是对齐的，收起时不在同一水平线」。对用户两张截图逐控件做像素切分（连通列分组 + y 范围）量出垂直中心：展开态**全部**控件 19.5~20.0（齐）；收起态会话头控件 21.5~22.0 而桌面窗控 17.5~18.0 —— **差 4px**。
  - **根因**：`.dsh-canvas-switch` = `padding:3px×2 + border:1px×2 + 按钮 28px` = **36px**，而官方 `titleRow` 的 `min-height` 只有 30px —— 被撑到 36px 后，行内**所有**控件（含官方 open-in-app、日志菜单、右栏展开按钮）居中后整体下移 (36−28)/2 = 4px；桌面窗控是 `position:fixed`，不跟着动，于是分成两组。
  - **修复**：`padding:3px` → `padding:0 3px`（并补 `align-items:center`），总高 36 → **30px**，正好等于 titleRow 的 min-height，不再撑高。视觉上只是去掉胶囊上下各 3px 的内边距，内部 28px 按钮不变。
  - **防回归**：`test/header-adaptive.test.js` 增一条契约断言 —— 胶囊上下 padding 必须为 0（`assert.doesNotMatch(/padding:3px/)`）。「控件总高 ≤ 30px」是与会话头行高绑定的**隐式契约**，靠注释守不住：它一旦被破坏，受害的是**同一行里别人的控件**（官方那三个也会一起偏）。
  - **余下 1px**（官方 titleRow 中心 25px vs 窗控/dockkit chrome 的 24px）是官方两处的固有差，由 desktop 线在常驻 CSS 里补 `top:-1px`，本线不介入。
  - **教训**：插件往官方行内塞控件时，**高度**和宽度一样会破坏宿主布局 —— 宽度不够是压叠（同日另一条），高度超标是把整行撑高、把别人的控件一起顶偏。

- **余下 1px 基线差：改由页面级注入补齐（同日再修）**：上一处修复后实测会话头控件仍比右栏 chrome / 桌面窗控低 **1px**（新截图逐控件切分：左 `[📁⌄]` cy=**23.5**、`⋯` cy=**24.0**；右 `⊙` 22.5、`[ ]`/`□|` 23.0、窗控三键 23.0）。
  - **性质**：这是**官方两处的固有差** —— 会话头 `titleRow`（`padding-top:10px + min-height:30px`，28px 控件居中）中心 **25px**；右栏 dockkit chrome（`10px + 28px`）与桌面壳窗控（`top:11px + 26px`）都是 **24px**。**它在纯浏览器里同样成立**（这张图的右侧并没有窗控做参照，一样差 1px），不是桌面壳专属。
  - **落点选择**：desktop 线 `themes/src/03-switcher.js` 已有同源规则，但那条走**桌面壳主题注入**，而 `src-tauri/src/main.rs` 用 `include_str!("../injected/theme-init.js")` **编译期内嵌** —— 改了必须**重建壳**才生效（实测证据：壳 21:01 启动、注入产物 21:41 重建，规则没进去）。本线改为**页面级注入**：支持 client-hmr 热更，**刷新页面即生效**。
  - **实现**：注入样式追加 `#root [class*="_headerActions"],#root [class*="_headerUtilities"],#root [class*="_headerCorner"]{position:relative;top:-1px}` —— `#root` 提权压过官方 CSS Module（对方注入更晚，同特异性会反超），`[class*="_xxx"]` 子串锚点对 hash 漂移稳健。只位移不改布局，不参与 flex 计算。
  - **同源契约**：两处**值必须一致**，测试双向锁住（断言本线注入含该规则 + desktop 那条未被移除），两处注释互指。
  - 另注：本线的 client 改动**不需要重启 `dsh web`** —— `dsh-client-modules` 的 client-hmr 每 500ms stat 一次 bundle，命中变化即经 SSE 推 rebuilt 帧。本次 4px 修复就是这样生效的（host 进程 21:01 启动、本线源码 21:40 才改，而实测已是修好后的 1px）。
  - 触摸点：`client.js`、`test/header-adaptive.test.js`。

- **展开右栏时让位安全区白空 144px（同日再修）**：用户指出「左边的外部按钮和三点扩展按钮位置离展开的右侧边栏太远」。像素实测：`⋯` 右边界 x=**89**、分栏线 x=**233** ⇒ **空 144px**，正是桌面壳让位规则 `padding-right:128px` 加官方 `padding-right:28px` 的残留。
  - **根因**：desktop 线的让位规则（给桌面壳窗控留安全区）是**无条件**生效的。但官方右栏 panel 用 `transform:translate(100%)` 移出屏幕、**并未卸载**，所以 `data-sidebar-right-open`（与 `data-sidebar-right-panel="push"` 同元素、条件挂载）才是可靠的开合判据；**推挤展开时**中栏右边界已退到分栏线内、窗控压的是**右栏**头部，会话头再留 128px 就是白空。
  - **修复（第一次尝试失效，第二次才对）**：
    - ❌ **门控方案（失效）**：给让位规则加 `:not(:has([data-sidebar-right-panel="push"][data-sidebar-right-open]))` 门控，指望"展开态不覆盖 → 官方 28px 自然生效"。**实测无效** —— 用户回报「还是这样」，像素复测空隙仍是 **144px**（`⋯` 右边界 105、分栏线 249）。原因：desktop 的注入脚本是 `include_str!` **编译期内嵌**进壳二进制的，**已发布的那份无条件 128px 规则仍在页面上生效**；门控版在展开态"不匹配"，等于**没人去覆盖它**。
    - ✅ **覆写方案（有效）**：主动写一条特异性更高的规则撤回让位 —— `#root:has([data-sidebar-right-panel="push"][data-sidebar-right-open]) header:has([data-conversation-header-corner]){padding-right:28px}`，`#root:has([a][b]) header:has([c])` = (1,3,1) > 原规则 (1,1,1)。28px 即官方 header 的 padding-right（官方若改需同步），两条通道**逐字一致**，测试用同一条正则同时断言两处。
  - **教训**：**撤销一条已经"发布"出去的 CSS 规则，不能靠改原规则** —— 宿主的注入产物可能是编译期内嵌的，运行中那份不会跟着源文件变。要么覆写（特异性取胜），要么请用户重建宿主。同一个坑已记入 desktop 线 CHANGELOG。
  - **已知限制**：浮窗模式（`data-sidebar-right-float-host`）下 panel 仍带 `push`+`open`，会被判为"已展开"而撤销让位 —— 浮窗不占布局、中栏满宽，严格说仍应让位。浮窗是低频用法，留待需要时用 float-host 判据补。
  - **顺带确认上一轮已生效**：本次截图实测左侧 `[📁⌄]` cy=21.5、`⋯` cy=22.0，右侧 `⊙` 21.5、`[ ]`/`□|` 22.0、窗控三键 22.0 —— **全部落在 21.5~22.0**，1px 基线补偿已通过 client-hmr 生效。
  - 触摸点：`client.js`、`test/header-adaptive.test.js`；desktop 线 `themes/src/03-switcher.js`（同源门控，重建壳后一致）。

  > 历史脉络：2026-09-06 那次「叠压」是 **DOM 注入位置**不可控（注入 `.headerActions` 被重渲染挤掉），改走官方插槽注册后关闭；这一次是**官方插槽内部**在窄宽度下的溢出压叠 —— 层次更深，插件侧只能在自己控件的宽度上让路，根因修复需要本体补丁。

## 2026-09-07

- **合并草稿失效标记（mergeStale，版本升至 `0.5.0-miasaki.5`，异常恢复）**：此前 `removeThread` 只清理 `absorbedBy` 反向引用，无人清理 `mergeFrom.sources` 正向引用——源线被删/会话在 DSH 侧消失后，草稿仍留在画布上、看起来可执行，直到点「执行合并」才在 `prepareMergeMessage` 里失败（晚失败，且用户已承诺手势）。修复四层：
  - `sweepMergeDrafts(workspace)` 共享清扫：`draft` 的来源线若节点消失或 `dshSessionId === null`，把缺失 id 记入新字段 `mergeStale`；
  - 挂点：`removeThread`、`syncSessions`（DSH 侧删会话）、加载迁移后重算（host 停机期间失效的草稿，首渲即正确，不靠下次删除补）；
  - 执行边界：`prepareMergeMessage` 前置 re-sweep + 拒绝（`来源线已被删除，无法执行`），多客户端并发改动也不漏；
  - UI：草稿卡 `mergeStale` 非空时禁用「执行合并」+ 红色说明条（`.merge-plan-stale`，亮/暗主题双色）。
  - 测试：`test/merge-store.test.js` 增 4 项（删除源线即失效、DSH 侧删会话同步失效、加载时重算不信任文件、失去 DSH 会话即失效）→ 合计 14 项全绿。触摸点：`index.js`、`app.js`、`styles.css`、`test/merge-store.test.js`、本文件。

- 以下为既有条目——**跟进桌面端标题栏 v4 改名（版本升至 `0.5.0-miasaki.4`）**：桌面端 2026-09-06 标题栏 v4 去胶囊化把窗控容器类名 `.tb-capsule` 改为 `.tb-group`，而本线 `syncChrome()` 只查 `.tb-capsule`——v4 下量不到窗控组，`--canvas-chrome-reserve` 恒为 0，画布工具条与桌面端窗控组右上角叠压回归（v0.5.0-miasaki.2 修过的问题）。修复：选择器改为 `.tb-group` 优先 + `.tb-capsule` 兜底（与 sidebar 线同款兼容做法）。触摸点：`client.js`（host 侧代码，重启 `dsh web` 生效）、`package.json` 版本、`README.md`（桌面端适配段）。

## 2026-09-06（五）

- **画布品牌色不随桌面端主题切换（用户报告，版本升至 `0.5.0-miasaki.3`）**：桌面端主题切换器是**热切换**——`html[data-miasaki-theme]` 属性 + 热替换主题 style 层（`runtime.js` setAttr/syncDark，无 reload）；而画布 `themeObserver` 只监听 `body[data-ds-dark-theme]`，且 sessions/workspaces 订阅只在列表变化时触发——切品牌主题（pure↔zafkiel↔kurkuriel）时既不触发 observer 也无 tick，画布停在旧品牌色。修复：同一 MutationObserver 实例加挂 `documentElement[data-miasaki-theme]` 观察（亮度三档切换走 body 属性本就触发）；防御性收窄——令牌瞬时读空（主题 style 层被页面重渲染清掉后的 ~1s 自愈窗口期）时只发明暗不下发，保留画布现有品牌色，避免被打回兜底蓝且无人再触发重发。验证：浏览器注入测试 CSS 模拟桌面切换（`html[data-miasaki-theme="zafkiel"]` 令牌覆盖 + 热设属性），画布 `--canvas-accent` 实时 `#5686fe → #c23a2e →` 移除属性回落 `#5686fe`；`pnpm run build` + `pnpm test` 75/75。触摸点：`client.js`（host 侧代码，重启 `dsh web` 生效）。

## 2026-09-06（四）

- **桌面端画布页三问题修复**（版本升至 `0.5.0-miasaki.2`；用户截图 + 视觉模型复核定位，修复全部落在画布线，不动桌面端）：
  - **右上角叠压遮挡**：桌面端标题栏 v3 的窗控胶囊 `#miasaki-titlebar .tb-capsule`（`fixed; top:5px; right:8px`，零占位浮层）盖住画布工具条（`.canvas-controls`，同为 fixed 右上）的缩放按钮。修复：`client.js` 新增 `syncChrome()`——量出胶囊左缘到视口右缘距离 + 6px 余量，经 `canvas:chrome` 下发；`app.js` 写入 iframe 根变量 `--canvas-chrome-reserve`，`.canvas-controls` 与 `.status-message` 的 `right` 改为 `calc(16px + var(--canvas-chrome-reserve))` 整体让位。胶囊宽度与 right 偏移固定、不随窗口尺寸变化，故不监听 resize；普通浏览器无胶囊恒传 0，行为不变。
  - **主题没对应**：画布 iframe 是独立文档不继承 DSH 令牌，此前 `client.js` 只同步明暗布尔，iframe 内 `#3478f6/#5b8def/#7ea6f5/#2563eb` 等强调色全部硬编码蓝系——绯红主题下画布仍是蓝。修复：`syncTheme()` 扩展读父文档 `--dsw-static-deepseek-450`（pure=`#3964fe` 原生 / kurkuriel=`#9e1b1b` / zafkiel=`#c23a2e`，pure 不覆盖令牌时读 DSH 原生值；格式校验防脏值）随 `canvas:theme` 下发；`app.js` 写入 iframe 根 `--canvas-accent`，styles.css 派生变量组——`--canvas-accent-hover`（color-mix 加深，替 #2563eb）、`--canvas-accent-ink`（暗色下 color-mix 提亮做文字/线条色，替 #5b8def/#7ea6f5——深红原值在暗底上不可读）、`--canvas-accent-soft`（品牌淡底，替 #eef4ff/#eaf0fa/#eaf1ff/#1e2a44 系）；约 60 处硬编码替换为变量/color-mix：tabs 激活、连接线（含草稿虚线）、选中卡阴影、框选、小地图选中/视口框、focus 轮廓、主按钮（亮 #111827/暗 #3478f6 双套）、「对话/会话布」激活胶囊（暗色由白底黑字改品牌底白字）。**语义色不动**：live 绿、merge 紫、错误红、警示橙、中性灰阶；`brand::after` 徽章保留黑底。
  - **滚动条突兀**：此前仅 `.thread-answer` 有自定义滚动条（灰色硬编码常显），侧边栏/详情/检查器/对比页等裸奔系统条。统一规则覆盖全部 15 个滚动容器（`.thread-answer`、`.thread-tree`、`.card-inspector-scroll`、`.detail-scroll`、`.compare-view`、`.merge-plan`、`.process-args/result/error` 及三处代码块/表格横向滚动）：6px、透明轨道、胶囊圆角、thumb 色走 `--canvas-scroll-thumb`（亮中性灰半透/暗半透白，随主题）、thumb hover 变品牌色；**默认隐藏，容器 hover/focus-within 时显现**（卡片上不再常驻灰条）；Firefox 以 `scrollbar-width:thin + scrollbar-color` 常显兜底。
  - **顺手**：暗色下 `.dsh-canvas-overlay` 遮罩层同步深色（`body[data-ds-dark-theme]` 选择器，消除亮色壳套暗色画布的一圈亮边）。
  - 测试同步：`canvas-runtime.test.js` 两条 connectors 颜色断言改断变量形式。`pnpm run build`（node --check 三文件）+ `pnpm test` 75/75 通过。
- 触摸点：`styles.css` / `client.js` / `app.js` / `test/canvas-runtime.test.js`（link 开发模式，重启 `dsh web` + 刷新页面生效）。

## 2026-09-06（三）

- **切换按钮改为官方插槽注册（叠压问题彻底关闭）**：上一版 DOM 注入 `.headerActions`
  仍被用户报告「变成一个了但还是遮盖重叠」——注入位置/重渲染时序不可控。改为
  `ctx.slots.inject("conversation.session.header.actions", …register, ViewSwitch)`
  （React 组件，`order:25`，紧随「后台任务」(order 20) 之后）——与 DSH 头部动作同一
  flex 行由 DSH 自己渲染，**结构上不可能叠压**，随头部重渲染自动重挂（删除 1.5s
  看门狗/浮空回退）；幂等守卫 `window.__DSH_CANVAS_BOOTED__` 保留（防 HMR 重复
  apply 出现双按钮，回收时复位）；视图状态经 `switchViewStore`（React state ↔
  open/close 单向同步）。`inject` 增加 `slots`；无需 react/jsx（用 createElement）。
- 触摸点：`client.js`（link 开发模式，刷新页面即生效）。

## 2026-09-06（二）

- **切换按钮：头部行内化 + 主题令牌化（修复「不适配/遮住/叠压」）**：桌面端标题栏
  v3 后用户报告三件事——①「对话/会话布」切换按钮在暗色主题下仍是白色药丸（不适配）；
  ②切换按钮仍与「后台任务」胶囊叠压；③历史问题：按钮 `position:fixed; top:12px;
  left:50%` 悬浮顶部，曾被桌面端旧顶带整体盖住（即「被遮住的切换按钮」本体）。
  - **主题令牌化**（`client.js` 样式）：硬编码 `#fff/#d1d5db/#6b7280/#111827` 全部
    改为 DSH 令牌 + 回退——`--dsw-alias-bg-overlay`（胶囊底色）、`--dsw-alias-border-l2`、
    `--dsw-alias-label-secondary/primary`、`--dsw-alias-interactive-bg-hover`、激活胶囊
    `--dsw-static-deepseek-450`（主题品牌色：原版蓝 / 刻刻帝绯红 / 狂狂帝血绯）+
    `--dsw-static-neutral-bluish-00`；
  - **行内化**：切换按钮优先注入 DSH 会话头 `.headerActions`（`#root header
    [role="tablist"]` 所在 header 内，`[class*="headerActions" i]`），与「后台任务」
    等头部动作并排（flex + gap），**结构上不可能叠压**；会话头不可用（欢迎页/设置页）
    回退旧右上悬浮（`--float` 修饰类）；1.5s 看门狗在 DSH 重渲染摘掉按钮后自动重挂；
    插件卸载清理看门狗与 DOM。
- 触摸点：`dsh-miasaki-canvas/client.js`（link 开发模式，profile 直接生效）。
- 验证：`node --check` 通过；目检——三主题下胶囊随主题色、与后台任务胶囊并排无遮挡。

## 2026-09-06（一）

- **切换按钮与 DSH 顶部会话 header 重叠修复（用户报告）**：DSH 原生对话顶部的「对话/会话布」切换按钮原本 `position:fixed; left:50%` 悬浮在视口正上角，在窄窗口（约 400px 宽）下与同一水平带的会话 header 内容（预设名「创造模式」、子代理计数下拉「3」等）贴边乃至叠住，视觉上挤成一团。修复：锚点改为 `left: calc(50% + 30px)`（仍用 `translateX(-50%)` 保持真居中），整体右移 30px，给左侧 header 内容让出间距；宽窗下 30px 偏移相对不可感知，仍然居中布置。改动仅 `client.js` 一处 CSS。

## 2026-09-05（八）

- **侧边栏滚动跳顶修复（用户报告排查）**：前端是整页 `app.innerHTML` 全量重建式渲染，详情/卡片回答的滚动位置均有保存恢复，唯独侧边栏 `.thread-tree` 没有；而重建触发源很多（每秒投影轮询、DSH 侧 `canvas:current-session` 推送、流式回复结束等），滚动到侧边栏中部后 1 秒内任一触发到来即被拽回顶部。修复：`render()` 开头保存 `.thread-tree` scrollTop、重建后同步恢复（与卡片回答同模式）。另削减一个无谓重建源：`canvas:current-session` 在会话未切换且 title/cwd 未变时跳过 render（DSH 侧每次 sessions-list 订阅 tick 都会重发该消息）。
- **侧边栏「会话」栏逻辑重构**：原先平铺列表仅靠「分支」小角标区分，树点颜色硬编码灰色再被 CSS `!important` 统一覆盖，无活动状态、无排序逻辑。现改为：
  - **树状缩进**：按 `parentId` 构树，分支嵌套在父线之下（与画布血缘一致），根线按最近活动（`updatedAt`）降序；父线已归档的孤儿分支提升为根但仍标「分支」；
  - **会话线颜色**：树点与画布卡片统一改用 thread 自身的 `color` 字段（TOPIC_COLORS），删除硬编码与 `!important` 覆盖，侧边栏与画布同线同色；
  - **状态标识**：流式回复中的线显示绿色脉冲树点 +「回复中」角标（`state.liveReplies`）；合并节点显示紫色 ◆；被吸收线整行弱化；
  - 行内边距/圆角补齐，暗色主题适配（live 绿 / merge 紫的暗色变体 + 独立脉冲 keyframe 用 CSS 变量传光晕色）。
- **测试**：75/75 通过，`node --check` 三文件通过。

## 2026-09-05（七）

- **小地图（缩略图）**：画布右下角显示全部节点缩影（普通/合并/选中/当前线四色区分）+ 当前视口框；点击或拖拽任意位置相机即跳转定位；顶栏新增「缩略图」开关（active 高亮，状态持久化 `localStorage`，默认开）。视口框随平移/缩放实时跟随（挂在 `applyCanvasTransform` 单一出口上）。实机验收：72 节点渲染、点击远端跳转、开关切换均通过。

## 2026-09-05（六）——MVP 收官

- **M4 打磨完成**，版本升至 `0.5.0-miasaki.1`（合并能力完整的第一个里程碑版本）：
  - **`summary` 注入形式**（§5.3）：合并面板新增注入形式选择（全文引用/摘要提炼）。summary 对引用结论做有损头段截断（1200 字符）并在模板中标注「摘要形式」，实现取舍与设计的「多一轮 token」表述不同：未做两段式对话提炼（插件不调模型红线下需 fork 会话内连发两轮，收益存疑），选择纯文本压缩——同样满足「省上下文、有信息损失」的形式语义；草稿卡与执行流全链路支持，`PATCH merge` 可在草稿期切换形式，带回归测试；
  - **发送失败重试**（§5.2 状态机 failed→重试）：commit 成功但首条消息发送失败时，合并卡 meta 区出现「重发合并请求」徽标（从 pendingReplies 取回原文重发，成功即清除）；fork/prepare/commit 阶段失败草稿保持 draft 天然可重试；
  - **文档同步**：docs/zh-CN 顶部加改编说明（上游原文与本插件差异对照），README 补「合并怎么用」；
  - 全量测试 75/75 通过。

## 2026-09-05（五）

- **产品名变更（用户定）**：入口与视图名「会话地图」改为「**会话布**」。覆盖：DSH 原生对话顶部的切换按钮、iframe title、画布内「布/详情」视图 tab 及其 aria-label。侧栏英文品牌 `Canvas` 保留不变。

## 2026-09-05（四）

- **M3 画布交互完成** + 两个地基件：
  - **多选/框选**：Ctrl/⌘ 点选多卡（再点取消；普通点选或平移自动清除）、Ctrl+空白拖拽画 marquee 矩形框选（世界坐标命中）；选中 ≥2 条可合并线时底部浮出动作条「合并这两条线」→ 打开预填的合并面板；
  - **拖拽并置合并手势**（§6.2）：卡片拖放与他线卡片重叠（最近者）→ 弹「合并这两条线？」确认气泡 → 确认后打开预填面板（source=被拖线尾锚点、target=被叠线）；Escape 取消；
  - **吸收态标记**（§5.5）：被合并吸收的源线线尾卡显示弱化「已被吸收 ◇」徽标（不消失、可追问可再分支），点击跳转到吸收它的菱形合并卡并定位相机；
  - **详情血缘视图**（§5.5 D 方案）：合并线详情页显示「合并来源」直达按钮 + 「传递血缘」按需展开（沿 parentId 与 mergeFrom.sources 递归祖先，防环）；被吸收线详情页显示反向跳转；
  - **system-reminder 过滤**：0.1.2 会话流里的 `<system-reminder>` 提示轮不再投影为伪问题卡（Host 投影、前端渲染、存量迁移三处同判定），带回归测试；
  - **0.1.2 存量回填（受限落地）**：勘察确认 `sessions.get(id)` 只是内存查找、无法从磁盘恢复——Host 插件没有批量读存量会话的通道。保留 30s 低频 tick：会话一旦变 live（用户原生打开、其他插件恢复）即自动补投影；纯内存历史回填列为等 DSH 上游开放 persistence 读接口的待办。
- **测试**：74/74 通过。实机验收（浏览器真交互）：Ctrl 多选→动作条→预填面板 ✓、cua 真实拖拽→气泡→预填 ✓、吸收徽标渲染与跳转 ✓、合并详情页血缘 ✓、reminder 卡清零 ✓。

## 2026-09-05（三）

- **M2 合并内核完成**（含 DSH 0.1.2 适配）：
  - **store v5**：thread 新增 `mergeFrom`（sources/forkSource/anchorSeqA/anchorSeqB/injectedForm/userIntent）、`mergeState`（draft/committed）、`absorbedBy` 反向索引；v4→v5 load 迁移补字段；
  - **merge RPC**：`POST /canvas/api/workspaces/:id/merge`（建草稿）、`PATCH /canvas/api/threads/:id/merge`（编辑草稿）、`POST …/merge/prepare`（构造注入文本，锚点交换 + 8000 截断 + fork 切点解析）、`POST …/merge/commit`（绑定 fork 会话 + parentId=forkSource + 双 source 写 absorbedBy + **fork 竞速幂等**：投影先到开的孤儿节点并入后移除）；
  - **合并 UI**：线尾卡菱形入口按钮 → 合并面板（目标线/指令）→ 画布草稿卡（计划预览 + 执行/取消）→ 执行流（prepare → fork → commit → send-message）→ 菱形合并卡（紫色边框 + ◆ 徽标 + B 线实线入边，fork 链入边沿用 parentId）；
  - **测试**：新增 test/merge-store.test.js 9 项（迁移/校验/文本构造/fork 切点切换/截断/commit/竞速合并/编辑/absorbedBy 清理），全量 73/73 通过；
  - **实机验收**（DSH 0.1.2-rc.1）：两条真实会话线合并产出真实 DSH 会话（fork 会话 seed=12025 投影回画布 10 条消息），菱形卡与双入边渲染正确，数据层 absorbedBy/parentId/seedLength 全部就位。
- **DSH 0.1.2-rc.1 升级适配**（环境被另一会话升到 0.1.2，被迫提前做了 SPIKE 文档预言的适配）：
  - `projectSession`：`session.events` 数组已移除 → 改用 `session.snapshotEvents(fromSeq)`（0.1.1 的 events 路径保留兼容）；
  - `sourceSeedLength`：Host 侧 header 只有 `isSeeded` 布尔 → fallback 读 `session.inheritedEventCount`（wire 层才保留 seedLength 整数）；
  - 启动 replay `ctx.sessions.list()` 在 0.1.2 返回空（懒恢复）——无害：存量在磁盘、增量走 session/created + session/event 事件（实测均正常到达）；
  - **已知限制（待办）**：0.1.2 下历史会话的存量投影不再回填（启动 replay 空），旧会话多为骨架卡（无消息内容），仅进程存活期内活跃的会话有完整投影；待后续找 0.1.2 的存量回填通道（如 syncSessions 时按需 snapshotEvents 回放）。
- **环境变更记录**（非本线代码，点名备查）：本机 DSH 升至 0.1.2-rc.1（另一会话的升级脚本执行）；web profile 三个社区插件升级（web-permission 0.6.1 / tool-browser 0.7.0 / browser-playwright 0.8.1）；`@yeesy369/dsh-web-permission` 因与 0.1.2 不兼容（`settingsNamespace` 导出移除）已从 profile 临时移除，待其发兼容版后装回。

## 2026-09-05（二）

- **M1 基线完成**：
  - fork 上游 dsh-synapse v0.4.1（commit 56935dc）进本目录，MIT `LICENSE` 保留，上游 `docs/`、`test/` 随包搬入；
  - 改名换标识：包名 `@miasaki/dsh-canvas`（`0.4.1-miasaki.1`）、服务名/patch id `canvas`、路由 `/canvas`、postMessage `canvas:*`、数据目录 `$DSH_HOME/miasaki-canvas/`、localStorage 前缀 `dsh-canvas:`（完整清单见 SPIKE 文档）；
  - link 安装实跑通过：`dsh plugin --profile web add link:…` → `dsh web` → 画布原功能全部正常，上游测试套件 64/64 通过；
  - **SPIKE 结论**（[2026-09-05-m1-spike-findings.md](2026-09-05-m1-spike-findings.md)）：
    - fork API = 客户端 `ctx.sessions.fork({ sessionId, atSeq, increaseTitle })`，`atSeq` 必须整数，Host 侧血缘形态 `header.parentSession` + `header.seedLength`；
    - 注入首条消息 = `session.prompt([{type:'text',text}], 'queue')`，blank 会话直接可用；
    - fork resolve 后子会话立即可 prompt（`projectList()` 同步并入），无需轮询；runtime 对 prompt 文本无长度上限，注入文本长度由 L2 自控；
    - 两个实跑坑入档：patch `name` = loader import 的包名；ModuleLoader `id` 必须逐字等于包名；
    - 升级风险注记：DSH 0.1.2 起 `session.events` / `firstLiveSeq` / `seedLength` API 变更将命中投影层（当前基线 0.1.1-rc.2 不受影响）。

## 2026-09-05

- **立项**：画布模式（画布 + 分支 + 合并）正式立项为本仓第三条线。
- **决策**：
  - 落点 = DSH web profile 插件，二开 [dsh-synapse](https://github.com/liangmianya/dsh-synapse)（MIT）；
  - 合并语义 = 真实会话产物（fork + 首条消息注入另一线内容）；
  - 首版范围 = 合并 + 画布增强；
  - 项目位置 = `dsh-miasaki-canvas/`，可独立成 npm 包；
  - 包名 = `@miasaki/dsh-canvas`；
  - 画布数据文件 = 独立目录 `$DSH_HOME/miasaki-canvas/`（不与上游 `$DSH_HOME/synapse/` 共用）；
  - 合并后原线默认保留（合并是衍生不是销毁）；
  - 再合并血缘 = D 方案（默认直连直接来源 + 详情面板传递血缘视图）；
  - 吸收态标记 = 被后续合并吸收的合并卡显示弱化小标记（不消失、可点击跳转）。
- **参考**：微软 Huabu（产品理念）、dsh-synapse v0.4.1（技术实现，源码已通读）。
- **产出**：[设计文档](2026-09-05-canvas-merge-design.md) 草案 v0.1。
