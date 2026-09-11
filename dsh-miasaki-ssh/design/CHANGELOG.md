# CHANGELOG — dsh-miasaki-ssh

本文件记录 `dsh-miasaki-ssh/` 线的设计决策与变更。

## 2026-09-10

- **修复：client 半加载失败 `invalid plugin … received undefined`（`client.js` 工厂漏 `return module.exports`）**。
  - **现象**：宿主重启后前端报 `Failed to load plugins` / `failed to apply loader entry <8 位随机 id> (@miasaki/dsh-ssh): invalid plugin, expect function or object with an "apply" method, received undefined`。
  - **定位**（DSH 0.1.2-rc.1 源码逐层核实）：
    - 报错出自 **浏览器端 cordis**，不是 host 半：`packages/client/web/src/boot.tsx` 的插件启动对每个客户端模块执行 `loader.create({ name })`——只传 `name` 不传 `id`，故 entry id 是 `ensureId()` 生成的随机 8 位十六进制（即错误里的 `2f010b31`）；随后 `EntryTree.import` → `internal.import`（ClientModuleLoader）物化 `client.js` 注册的工厂，把返回值交给 `registry.plugin()`。
    - host 半无恙：`dsh web --dump-config` 中 `id: ssh` 一行完整；profile 目录直接 `import('@miasaki/dsh-ssh')` 也拿得到 `apply` / `inject` / `name`。
  - **根因**：`client.js` 的 `factory` 结尾漏了 `return module.exports`（canvas / sidebar 两线均有此行）。工厂返回 `undefined` ⇒ cordis 判定 `invalid plugin`。
  - **修复**：补 `return module.exports`。
  - **防回归**：新增 `test/client.test.js`——在 `node:vm` 里执行 `client.js`，捕获 `window.__ModuleLoader__.load` 的 descriptor，断言工厂返回含 `inject`/`apply` 的对象、`apply` 注册 `conversation.view`（id `ssh` / order 20 / label `SSH`，视图为 `src='/ssh/'` 的 iframe）、幂等守卫与 effect 复位可重挂载。单测 20 例全绿。
  - **待复核**：宿主重启 + 浏览器刷新后确认 tab 出现、无插件加载失败横幅（M1 真实连接验收清单不变）。
- **纳入统一回归（六线）**：`scripts/verify-all.mjs` 新增 `ssh` 线，登记 5 项语法检查（`index.js` / `client.js` / `app.js` / `lib/store.js` / `lib/runtime.js`）+ 4 个单测文件，**9/9 通过**（含 20 例单测）。
  - 纳入口径：单测不触真实 SSH 连接（store 的三道围栏与归一化、runtime 的 TOFU 与错误分类、http 路由、client 工厂返回契约），**任何机器可复现**；真实连接验收仍是实机项，留在 `dsh-miasaki-shared-docs/cross/smoke-test-matrix.md`。
  - 同步：根 `README.md` 由「五线统一回归」改为六线，`AGENTS.md` 扩为六线登记（补 dual-model 行）。
- **入口位置调整：从第二行 tab 栏迁到第一行「对话 / 会话布」旁**（用户 2026-09-10 反馈：「SSH 的入口按钮应该是和对话会话布切换按钮那里，而不是在会话用量后面」）。
  - **归因**：一条会话里有两套并行切换 UI —— canvas 的「对话 / 会话布」胶囊注册在 `conversation.session.header.actions`（会话头**第一行**，order 25）；SSH 走 `conversation.view` 被投影成官方 tab 栏（**第二行**）的 tab，order 20 正好排在 token-monitor(15) 之后，就是用户看到的位置。
  - **能力边界（源码核实，非猜测）**：DSH **未对外暴露 View 切换 API** —— `selectView` 只注入官方 `conversation.session.header` 组件（`dsh-client-ui-conversation/lib/client.js` 16705–16713），而 `conversation.session.header.actions` 子槽渲染时 owner props 是空对象 `{}`（同文件 15072）；客户端 Inspect 服务目录也只有 layout / locale / sessions / slots / theme / timer / uiWorkspace / workspaces，没有 conversation 相关服务。
  - **实现**（`client.js`）：
    - 新增注册 `conversation.session.header.actions`（id `ssh-view-switch`，order 26 —— 紧跟 canvas 的 25），渲染与 canvas 胶囊同款视觉的「SSH」按钮（主题令牌配色、999px 圆角、28px 按钮、总高 30px）；
    - `conversation.view`（id `ssh`，order 20）注册**保持不变**：页面本身、host 侧连接保活、scrollback 回放全部不动；
    - 切换**委托点击官方 tab 按钮**（官方唯一通道），全程带守卫：找不到 tab 就不动作、也**不**收起 tab —— 最坏退回「双入口」，而不是没入口；激活态读官方 `aria-selected`，由 header 上的 MutationObserver 同步；
    - 收起官方 tab 栏里那一个 tab（内联 `display:none`，tab 元素被重建后重新收起，fiber 卸载时复原）；
    - 点「SSH」前先走 canvas 自己的「对话」按钮关掉「会话布」全屏浮层（直接改 `overlay.hidden` 会让 canvas 胶囊激活态不同步）；canvas 不在场时选择器落空即跳过；
    - 继承 canvas 2026-09-10 定下的两条行内契约：**高度** 30px（上下 padding 必须为 0）、**宽度**窄时按同款判据（`leftGap` 120/200 滞回 + 观察 header）降级为 28px 终端图标；
    - tab 查询范围限定在会话头 `header` 内（用自己的按钮当锚点），避免误伤页面上其他 `role="tablist"`。
  - **二次优化（同日第二次反馈：「两个同款胶囊并排、中间一道缝，还是两组控件」）**：改为**与 canvas 胶囊合成为同一个控件**，一个胶囊里「对话 | 会话布 | SSH」三段，**全部是纯 CSS 覆盖，canvas 文件一行未改**：
    - `.dsh-canvas-switch:has(+ .dsh-ssh-switch)` 把 canvas 胶囊右端打开（去右边框 + 右圆角归零）；`.dsh-canvas-switch + .dsh-ssh-switch` 用 `margin-left:-8px` 吃掉官方 `headerActions` 的 `gap:8px`、本段左圆角归零，保留自己的左边框 ⇒ 中间那条竖线即分段线；
    - **同一控件里不同时亮两段**：停在 SSH 时用 CSS 抑制「对话」段的高亮；「会话布」全屏浮层打开时抑制本段的高亮（两条都带 `:not(:hover)`，hover 反馈照旧）；
    - **行为补齐**：canvas 的「对话」段只关它自己的浮层、管不了 DSH 的 View，停在 SSH 时点它屏幕上什么都不变。本线捕获它的 click，若当前停在 SSH 就顺带委托切回默认视图（官方 tab 栏里 order 最小的 view，`chat` order 0 恒为第一个）；`dismissCanvasOverlay()` 自己也会点这个按钮，故加 `dismissing` 标志隔离那一下，否则点「SSH」会先切 chat 再切 ssh（视图连换两次、iframe 卸两次）；
    - **退化方向**：canvas 不在场、或未来有别的插件插在两者之间 ⇒ `+` / `:has()` 不匹配 ⇒ 本段退回完整胶囊（又变回两个胶囊），功能与安全不受影响。
  - **三次优化（同日第三次反馈：「会话布页面没有按钮」）**：canvas 浮层是 `position:fixed; inset:0; z-index:100`，一打开就把会话头连同切换器一起盖住 —— 用户在画布上没有任何切换入口。**没有去跟层叠上下文斗**（要让 header 内控件压过浮层，需要 header 到根之间每个祖先都没创建层叠上下文，离线核不实，只能确认 `#root` 自身没有），改让**浮层从会话头下沿开始**：`body .dsh-canvas-overlay{top:var(--dsh-ssh-header-h,76px)}` —— 切换器留在原位、任何视图里都在，画布自适应（`/canvas/` 的 iframe 是 100% 高）。高度由 `measure()` 实测 `header` 高度写入变量（官方 header 是 `min-height` 而非固定高，主题 / 字号 / 语言都会改它），`76px` 兜底；`body` 前缀把特异性抬到 (0,1,1) > canvas 的 (0,1,0)，否则谁先 apply 谁被覆盖；卸载时撤掉变量与规则。代价：会话布顶部让出会话头高度。备选（若实机反馈「画布要全屏」）：保留全屏 + 在浮层之上挂一条 body 直接子元素的悬浮切换器（`z-index:101`，同层比较，不依赖祖先链）。
  - **四次修正（同日第四次反馈：「怎么搞成这样了」+ 截图）**：只让位不够 —— 浮层让出的 76px 露出的是**整条页面顶**（左侧栏的品牌行 / 工作区行也在里面），跟画布自己的标题栏叠成两层，看着像两个应用摞在一起。修正：在浮层之上补一条**本线自己的工具条** `body > .dsh-ssh-canvas-bar`（`position:fixed; top:0; left:0; right:0; height:var(--dsh-ssh-header-h,76px); z-index:101`，不透明底色 + 底边框，右端放与 header 里同款、同行为的三段胶囊）把露出的部分盖住；它挂在 `document.body` 下、与浮层**同处 body 的层叠上下文**，`101 > 100` 必然在上，不依赖任何祖先链。三段行为全部复用既有通道（「对话」= 委托 canvas 按钮关浮层、「SSH」= 委托官方 tab 切视图）⇒ header 与工具条是同一套逻辑的两处 UI；用原生 DOM（client 半拿不到 react-dom，没有第二个挂载点）；浮层可能晚于本插件被创建，故先盯 `document.body` 的 childList、拿到浮层后再盯它的 `hidden`。会话布视图下三层：0–76px 本线工具条 / 76px 以下 canvas 浮层（其标题栏、工具组、窗控完整保留）/ 再往下被盖住的 DSH 会话区。
  - **五次修正（同日第五次反馈的截图：工具条上的胶囊被桌面壳窗控 − □ × 压住）**：原先工具条照抄官方 header 的 `padding:0 28px`，但桌面壳会给会话头**额外的窗控让位**（desktop 线主题注入的 128px 安全区），会话头里的胶囊本来就比 28px 靠左得多，工具条这颗却贴右边 —— 正好撞进窗控。修正：**不抄常量，跟随会话头里那颗胶囊的实测位置** —— `measure()` 每轮把 `视口宽 − 会话头内胶囊.right` 写进 `--dsh-ssh-bar-right`，工具条用它当右内边距；于是纯浏览器 / 桌面壳 / 右栏推挤展开三个环境以及主题、字号、语言变化全部自动跟随，两处胶囊还逐像素对齐。
  - **六次修正（同日第六次反馈：「只是让加一个 SSH 按钮，为什么会多出一整个上栏」）——三～五次的产物全部撤掉**：需求被重新校准 —— 用户从第三次起说的「会话布页面没有按钮」，指的是**画布页面内部那组「对话 / 会话布」按钮旁边缺一个 SSH**，不是"页面上没有任何入口"。我在浮层之上补整条工具条方向错了。移除：`body .dsh-canvas-overlay{top:...}` 让位、`--dsh-ssh-header-h`、`--dsh-ssh-bar-right`、整条 `.dsh-ssh-canvas-bar`（画布浮层恢复全屏原样）。改走**画布提供的通用「外部视图槽」**：本线把 `{ id, label }` 写进页面级注册表 `window.__DSH_CANVAS_VIEW_ITEMS__` 并派发 `dsh-canvas:view-items` → canvas 的 client 半在 iframe `load` / 浮层打开 / 注册表变化时转成 `canvas:views` 下发 → 画布页面在它自己的 `.view-switch`（「对话 / 会话布」）里多渲染一个按钮 → 点击广播 `canvas:view` → **本线自己监听**并关浮层 + 切视图。canvas 侧不认识 SSH（源码里连 "SSH" 字样都被测试锁死），两侧只有这一份页面级约定、没有代码耦合。canvas 线改动：`app.js`（state.externalViews + `externalViewButtons()` + `canvas:views` 处理 + 点击广播）、`client.js`（注册表转发 + 三处下发时机 + 监听/解绑），并新增契约测试 `dsh-miasaki-canvas/test/external-views.test.js`（3 例，含"canvas 不认识具体视图"的红线断言）。
  - **测试**：`test/client.test.js` 由 4 例扩为 **12 例**（入口槽与 order 相邻性、胶囊样式与 30px 高度契约、合体规则与「单一高亮」、画布外部视图槽的注册与响应（并断言上栏产物已彻底消失）、委托切换与「找不到就收手」、点「对话」段的行为补齐与 `dismissing` 隔离、tab 收起与复原、窄宽度判据锚点截取求值等），本线 **28 例全绿**；`node scripts/verify-all.mjs canvas ssh` → **canvas 11/11、ssh 9/9 PASS**。
  - **未采纳**：在浮层之上补整条工具条 / 让浮层让位（用户明确否掉：「为什么会多出一整个上栏」）；宿主 DOM 里覆盖按钮去对齐画布内部的按钮（那组按钮在 iframe 内，位置读不到，只能猜）；让 canvas 宿主胶囊容纳「SSH」项（那是 canvas 私有的浮层开关，与 iframe 内那组不是同一处）；改 DSH 本体把 tab 栏搬到第一行（升级重打 + 第一行宽度预算放不下 4 个 tab）；直接写 per-session View 偏好（store 已物化，绕过 store 状态不一致）。理由见[设计文档 §5.5](2026-09-09-ssh-design.md)。
  - **待实机复验**：宿主重启 + 浏览器刷新后 —— ①第一行出现「SSH」段并与「对话 / 会话布」**同处一个胶囊**（中间一条分段竖线、无缝隙）；②第二行 tab 栏只剩「对话 / 轨迹 / 会话用量」；③点该段切到 SSH 页面、本段高亮而「对话」段不再高亮；④停在 SSH 时点「对话」段能回到对话视图；⑤**切到「会话布」后，画布页面内部那组「对话 / 会话布」旁边多出一个「SSH」按钮**（不多出任何栏、页面顶不再有第二条标题栏）；⑥在画布里点那个 SSH 按钮，浮层关闭并切到 SSH 页面；⑦切走再切回：连接不断、scrollback 回放正常；⑧右栏展开收窄时两段一起降级为图标且不与官方控件压叠。

## 2026-09-09

- **立项**：在 DSH web 会话视图切换区集成 SSH 入口、页面内交互式连接云服务器，正式立项为本仓第五条线。
- **关键调研结论**（实测 DSH 0.1.2-rc.1 源码与运行时）：
  - **DSH 官方有会话视图机制**：`conversation.view`（list 插槽，scope `session`，`replaceRisk: none`）现有 `chat`(0) / `trajectory`(10) / `token-monitor`(15)；注册项被投影为 `ViewTab { id, label }`，由 `ConversationSessionHeader` 渲染成 `role="tablist"` 的 tab 栏（`tabs.length > 1` 才渲染），激活态、`aria-selected`、每会话独立记忆（`ConversationStoreState.view`）全部由 DSH 托管。
  - **canvas 的切换按钮在另一处**：`conversation.session.header.actions`（order 25，第一行标题右侧），与 DSH 原生 tab 栏（第二行）是两套并行 UI；canvas 为此背了幂等守卫 / 重渲染看门狗 / 叠压修复 / 主题令牌化等补丁。
  - **host 侧官方支持 WebSocket**：`@deepseek-ai/dsh-host-webserver` 的 `WebServer.registerUpgrade({ path, handler })` 按精确路径匹配、handler 拥有协议协商与 socket 生命周期、插件卸载时服务显式销毁 tracked upgraded socket——SSH 终端流不需要自建 HTTP 服务器。
  - **依赖形态**（registry 元数据核实）：`ssh2` 1.17.0 为纯 JS（`cpu-features` / `nan` 仅 optional 加速）；`@xterm/xterm` 6.0.0 无运行时依赖、`main: lib/xterm.js` 可直接 `<script>` 引入。
- **决策**：
  - SSH 协议实现走**方案 A（ssh2 + ws + xterm.js）**，规避 node-pty 在 Windows 的 VS Build Tools 依赖（sidebar 线 M3「内嵌终端」长期未立项的主因）；「spawn 系统 ssh.exe」作为 M2 补充按钮，复用 `~/.ssh/config` 处理复杂认证；
  - 入口走 **`conversation.view` 官方机制**（用户 2026-09-09 拍板，方案 1）：SSH 成为会话 tab 栏的一个 tab，与「对话 / 轨迹 / Token 监控」并列；**本次不改 canvas**；
  - 页面形态 = iframe（`/ssh/`）内嵌在视图组件里，沿用 canvas 的隔离策略（client bundle 由 `__ModuleLoader__` 加载、无法 `require` 第三方包）；
  - 连接在 **host 侧全局持有**（视图切换 / 页面刷新不断连），凭据只存在于 host 进程内存；
  - 安全红线：三道浏览器围栏（Host / `sec-fetch-site` / Origin）**HTTP 与 WS upgrade 都要过**、默认只连回环、主机指纹 TOFU + 变更拒绝、密码不落盘、私钥不进前端存储；
  - M1 范围 = 纯终端 + 连接管理（不含 SFTP / 跳板机 / agent 联动）；
  - 项目位置 = `dsh-miasaki-ssh/`，包名 `@miasaki/dsh-ssh`。
- **产出**：[设计文档](2026-09-09-ssh-design.md)（含 §9 SPIKE 清单 S1–S5 与 §7 安全红线）。
- **SPIKE 实测（同日，动态 Cordis 探针，已清理）**：
  - **S2 通过**：`ctx.get('webServer')` 在插件里可访问，`register` / `registerUpgrade` 均可调用；注册 `/ssh-spike/ws`（upgrade）后 Node 原生 `WebSocket` 客户端连接被 handler 完整接管（拿到 `upgrade: websocket` / `connection: upgrade` / `sec-websocket-key` / `sec-websocket-version: 13`，`head` 长度 0）；普通 GET 打到 upgrade 路径返回 404（不污染普通路由表）；HTTP + upgrade 双注册无冲突。
  - **S4 通过**：注册真实 `conversation.view`（id `ssh-spike`）后 tab 栏出现第四个 tab；iframe 视口 992×596（父文档 1280×800）填满中间列、无内部滚动条；keydown 0→23 递增（含 IME 的 `Process`、`Backspace`、`Enter`），iframe 内键盘不被 DSH 抢。
  - **S4 附带发现（影响架构）**：切走再切回视图，iframe **加载次数 1→2→3、`timeOrigin` 每次变化**——`ConversationSession` 以 `renderSlot(…, { only: active.id })` 只渲染激活视图，故切换会卸载重建。设计随之新增 **host 侧 scrollback 环形缓冲 + attach 时 `replay` 帧**（§5.4，M1 强制项），并记录「常驻 `shell.overlay`」为 M2 备选。
  - **S3 部分通过**：host 路由 serve 静态页面给 iframe 已验证（探针页面即经 `/ssh-spike/page` 提供）；xterm 具体文件与体积待装包后确认。
- **未实现**：本线当前只有设计文档，无代码；M1 实现前仍需跑 SPIKE S1（ssh2 在 Windows 的安装与真实连接）与 S5（`hostVerifier` 的 TOFU 交互）。
- **M1 实现（推进中，同日）**：
  - **依赖落地（SPIKE S1 / S3 闭环）**：`pnpm install` 成功安装 `ssh2` 1.17.0、`ws` 8.21.3、`@xterm/xterm` 6.0.0（`lib/xterm.js` UMD ≈ 260KB）、`@xterm/addon-fit` 0.11.0；ssh2 的 `cpu-features` / `nan` 只编译了 optional 部分、未中断安装。S1 / S3 正式转绿。
  - **代码骨架落地**：`lib/store.js`（纯数据层：连接库 CRUD + known_hosts TOFU + 三道围栏 + JSON 原子写）、`lib/runtime.js`（ssh2 运行时：`hostVerifier` 异步 TOFU、scrollback 环形缓冲、WS 中继、错误分类）、`index.js`（host 半路由族：`/ssh/` 页面、xterm 静态资源、`/ssh/api/*` REST、`/ssh/ws` upgrade）、`client.js`（`conversation.view` 注册 + iframe）、`app.js`（前端 xterm + 连接管理 + 密码即时输入）、`styles.css`。S5（异步 TOFU）已在运行时中落地。
  - **单测全绿**：`test/store.test.js`（围栏 / 归一化 / 指纹格式 / 持久化 / 凭据不落盘）与 `test/runtime.test.js`（错误分类 / TOFU 三分支 / 变更拒绝）共 13 例全部通过；`node --test` 可复跑。
  - **与设计文档 §5.4 一致**：WS 帧为「JSON 控制帧 + 二进制输出帧」双通道；attach 时 host 先回放 scrollback 再续流，视图切换 / 页面刷新不丢屏。
  - 注：`__ModuleLoader__` 的 `client.js` 栈式注册 / `cordis.patch.yml` 的 `dshHomePath` 写法沿用 canvas 既有模式。
  - **待办**：`dsh plugin --profile web add link:…` 安装到 web profile 后，浏览器实测真实连接的验收标准（§7 清单）。
