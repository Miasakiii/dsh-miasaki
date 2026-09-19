# CHANGELOG — dsh-miasaki-sidebar

本文件记录 `dsh-miasaki-sidebar/` 线的设计决策与变更。

## 2026-09-19

- **收尾验证补记：`terminal-hub.test.js` 与宿主环境解耦（`resolveBin` 可注入）** —— 全量
  `verify-all` 在受限沙箱下报 `sidebar: 9/10`（`terminal-hub.test.js` 15 项里 9 项失败）。
  - **根因不是本次多标签改动**：该文件的注释与本线 README 都写着「fake pty 注入，不需要真实 shell」，
    但 `_spawn` 里的 `resolvePtyBin()` 走的是 `where.exe` —— **子进程 + 管道 stdio**。受限沙箱对
    Node 子进程管道 stdio 一律 `spawn EPERM`（同环境下 shell 明明装着：`where.exe powershell.exe`
    手工可解析），于是 9 个用例全部倒在「未安装或找不到 powershell.exe」。**是环境的假阴性，
    但暴露了测试的真实脆弱点**：`hub._pty` 注入了，`resolvePtyBin` 却是模块级硬引用，漏在外面。
  - **修法（最小侵入、生产行为不变）**：`TerminalHub` 构造函数新增 `resolveBin` 选项（默认仍是
    `resolvePtyBin`），`_spawn` 改调 `this._resolveBin(shellDef)`；测试在 `makeHub()` 里注入
    `async shell => 'C:\\fake-shells\\<bin>.exe'`（断言只要求「是绝对路径」，故仍成立）。
  - **复跑**：`node test/terminal-hub.test.js` **15/15 全绿**，`verify-all` 全仓 **7/7 线 PASS**
    （sidebar 恢复 10/10）。**注意区分**：本线的 `node --test` 多进程隔离在受限沙箱下另有 EPERM
    问题（见 README「验证」段），那是运行方式限制，与本次修复无关。
  - 触摸点：`index.js`（构造函数 + `_spawn`）、`test/terminal-hub.test.js`（`makeHub`）、本文件、`README.md`。

- **v0.9.0-miasaki.0：M3.1 内嵌终端「标签栏多开」落地**（按[补充设计](2026-09-19-terminal-multi-tab-plan.md)
  §9 的推荐项全部实施，P0 协议加维 + P1 标签栏 + P2 无障碍与刷新恢复一次做完；P3 OSC 动态标题留待按需）。
  - **host 半**（`index.js`）：`TerminalHub` 由单会话改为**会话集合**——`sessions: Map<sessionId, session>`、
    `viewers: Map<ws, {sessionId, cols, rows}>`（ws 有了身份才可能不串台）、`broadcastTo(sessionId, frame)`
    定向广播、`write/resize` 按 ws 寻址、`bind/detach/arbitrate/close/list/snapshot/status` 一套新 API；
    `ensureSession` 支持 `sessionId`（给了就定位、没给就新建，未知 id 按新建处理并回带真 id）；
    **最小尺寸仲裁** `pty.cols = min(viewer.cols)`（结果变化才 `resize`，TUI 不反复重排），`detach` 后重算；
    会话上限 **8**（`TERMINAL_MAX_SESSIONS`，超限抛 `LimitError` → 前端 `LIMIT` 提示）；
    `close()` = kill + 摘会话 + 广播 `closed` + 解绑 viewer；`dispose()` 遍历全部会话 kill（不再只 kill 一个）。
  - **帧协议 v2**：`attach/input/resize/close` 全带 `sessionId`，回包 `ready/replay/output/status/closed/error`
    全带 `sessionId`；`input`/`resize` 不带 `v:2` 的旧帧一律拒收并回 `VERSION_MISMATCH`（不做双栈，对齐 ssh 线 U2.1）。
  - **路由**：`GET /sidebar/api/terminal/session` 改为回 `{ sessions, limit }`（原 `{ session }` 的旧字段废弃）；
    新增 `POST /sidebar/api/terminal/close`（无 WS 可用的孤儿清理兜底）。`token` 仍**不绑会话**——
    `sessionId` 只寻址不授权（三道围栏 + 一次性 token 不变）。
  - **client 半**（`client.js`）：`terminalClient` 改为会话集合镜像（`sessions`/`order`/`active{bottom,right}`），
    每 viewer 绑一个 `sessionId`、输出按 `sessionId` 过滤（绝不写进别的 xterm）；`_snapshot` 仍是稳定引用
    （emit 时重建，2026-09-12「终端空白」教训延续）；新增 `terminalTabs` 命令式组件（**底部面板与右栏 tab
    共用同一套实现**，避免两套行为漂移）：标签栏 + pane 栈、懒挂载（首次激活才建 xterm）、隐藏 pane 只藏不拆、
    零尺寸守卫（`display:none` 不发 resize）、`＋`/`×`/中键关闭/双击重命名/右键菜单/`▾` 溢出下拉、空态与退出态、
    每容器活动标签（sessionStorage 记忆）、`refreshFromHost()` 刷新恢复（host 存活的 pty 补成可见标签 ⇒ 不再有孤儿）。
    快捷键：`Ctrl+Shift+`` 新建、`Ctrl+PageUp·PageDown` 切换、`Alt+1..8` 跳转、`Delete`/`F2`（焦点在标签上）、
    方向键/Home/End；`Ctrl+`` 切底部面板保持不变。**WT 默认的 `Ctrl+Shift+T/W` 是浏览器保留键，页面上拿不到**，
    故不采用（设计 §7.3 矩阵）。shell 胶囊语义改为「新标签默认 shell」，换 shell 收进标签右键「重启」。
  - **两处被测试逮住的真 bug**（都在 host 半，已修）：① `close()` 原先「先解绑 viewer 再广播」⇒ `closed` 帧
    没有任何接收者，前端标签不会被摘掉；② `detach()` 后不重算尺寸 ⇒ 剩下的 viewer 仍被已消失的最小尺寸压着。
  - **前端验证**（本线前端无 DOM 单测，惯例是实机验证）：本次多标签链路用**一次性 DOM 桩探针**做了冒烟
    （刷新恢复 → 懒挂载 → attach 带 sessionId → 临时 id 换真 id → close → closed 摘除 → 活动项回落 → pane 回收，
    16 项断言全过，探针即弃）。探针另逮到一个真 bug：`fitPane` 只判了 `viewer === undefined`，而 `pane.viewer`
    初值是 `null`（xterm 要等 `ensureAssets` 之后才挂上）⇒ 新建标签的首次渲染会抛 TypeError（已修）。
  - **与设计的偏差**（如实记录）：WS `list` 帧未实现——客户端刷新恢复一律走 `GET /sidebar/api/terminal/session`，
    少一条路径、也让「恢复」与「孤儿清理」同源；设计 §5.2 的帧表按此收敛。
  - **单测 54 → 62 项全绿**：`test/terminal-hub.test.js` 重写为多会话形状并新增 8 项（会话隔离 / 未知 id 静默
    丢弃 / 上限与回收 / 关闭回收 + 广播 / 最小尺寸仲裁 / 背压按会话 / dispose 全杀 / 常量）。
  - 触摸点：`index.js`（TerminalHub / 帧协议 / WS 接线 / 路由）、`client.js`（terminalClient / terminalTabs /
    bottomPanel / TerminalTab / 样式 / 快捷键）、`package.json`（0.9.0-miasaki.0）、`test/terminal-hub.test.js`、
    `README.md`、本文件。**待重启 `dsh web` 实机验证**：多标签互不串台、两容器同看一会话不错行、刷新后标签恢复、
    8 上限提示、三主题配色。

- **同日四次修正（用户实机反馈：「新建标签页的逻辑也有问题」，确认症状 = 右栏开第二个终端标签页后先前那个白掉）**：
  - **根因**：`terminalTabs.instances` 按 **kind**（`'bottom'` / `'right'`）键控，`mount()` 第一句是
    `unmount(key)` + `instances.set(key, inst)` ⇒ 官方右栏里开出**第二个终端标签页**（分栏 / 浮窗，
    官方对「页类型」只在同一 pane 内去重）时，第二次 mount 会把第一个实例顶掉：`unmount` 清空它的
    `tabHost.textContent`、并 `dropPane` 掉它的 xterm（dispose + 关 WS）⇒ 那个标签页直接白掉。
  - **修法**：实例 id 唯一（`kind#N`，`terminalTabs.seq`），`unmount(id)` 按 id 拆；活动标签仍按 kind
    （`active.bottom` / `active.right`），同类实例共享同一活动项（两个终端标签页镜像显示同一活动会话）。
    新增 `primaryOf(kind)` / `hasKind(kind)` 供「底部面板 / 主右栏实例」的调用点使用（面板 dispose、
    标题栏「新建终端标签」、`showInBottom` / `showInRight`、快捷键 stepTab/Alt+N 共 6 处改用它）。
    底部面板改存 `mount()` 返回的卸载函数（`bottomPanel.unmountTabs`）。
  - 复跑：单测 62 项全绿 + DOM 桩冒烟 **12 断言全过**（两个右栏实例共存 / 先开的不被清空且 pane 完好 /
    共享同一会话集合不重复开终端 / `primaryOf` 指向首个 / 按 id 拆掉一个另一个不受影响），探针即弃。
  - 说明：官方 `+` 菜单里的「辅助对话」不是本插件注册的（本插件只注册 `审查` / `终端`，见 `RIGHT_BAR_TABS`），
    插件侧无需改动。

- **同日三次调整（用户实机反馈）：「侧边栏终端应该是一整块，不需要分下半部分」**：
  - **终端整块化**：此前标签栏 / xterm / 状态条各自成盒（各有 `.5px` 边框 + 8px 圆角 + 10px 间距），
    观感是「三块拼起来」。现在由外壳 `.dsh-sidebar-term` 承担**唯一的一圈边框 + 圆角 + 裁切**，
    三块之间 `gap:0`、不再各自带边框与圆角 —— 对齐 Windows Terminal「标签条 + 内容是一整块」的观感。
  - **状态条改为条件可见**：`terminalStatus()` 新增 `visible`，只在**有话说**时占一行
    （会话级报错 / 已退出 / 工作区变更 / 全局错误）；正常运行状态下终端就是「标签栏 + 内容」两块，
    没有底部条。常规信息（`N/8 个会话` · shell 名）只在状态条出现时一并带上，不再常驻——
    shell 名在标签栏左标题里已有，路径 / pid 在标签 tooltip 里。
  - 底部面板同步：`bottomPanel.statusEl` 按 `visible` 切 `display`（首次 `ensureDom` 就置位，无闪烁）。
  - 能力不丢：`[重启]` / `[移到当前工作区]` / `[在底部打开 ↧]` 仍在状态条里（该出现时才出现），
    且标签右键菜单里各有一份常驻入口。
  - 复跑：单测 62 项全绿 + DOM 桩冒烟 **10 断言全过**（正常态无状态条 / 退出态出现并带重启 /
    恢复后再次隐藏 / 报错态出现 / 外壳下只有标签栏与 panes 两块），探针即弃。

- **同日二次调整（用户实机反馈）：「下半部分不太需要」+「点击终端默认打开一个终端」**：
  - **移除右栏终端 tab 的下半部分配置区**（`工作目录` / `新标签默认 SHELL` / `外部系统终端（独立窗口）`
    整块 `details`）：视图只剩 **标签栏 + xterm pane 栈 + 细状态条** 三块。随之删掉该区块的 React 状态机
    （`shells/picked/phase/result` 与 `/terminal/options` 拉取）与 **12 条死样式**
    （`.dsh-sidebar-term-cwd*` / `-copy` / `-shells` / `-shell` / `-shellname` / `-shellnote` / `-go` /
    `-result` / `-retry` / `-label`、`.dsh-sidebar-shellpick` / `-shellchip`），不留死代码。
  - **能力不丢，收进 `＋` 的右键菜单**（对应参考图 `+` 旁的 profile 下拉）：`新建：<shell>`（指定 shell 开标签）
    与 `在新窗口打开：<shell>`（原外部系统终端）；用 host 探测过的完整表（含容器型 wt 的可用性），未安装置灰。
    `＋` 左键仍是「按默认 shell 新建」，tooltip 注明右键用法。
  - **点击终端默认就有一个终端**：容器挂载后若会话集合为空、当前有工作区且未达上限，自动新建一个标签
    （先 `ensureShellPicked()`——shell 是 spawn 前提），不再让用户面对空态。两个容器（右栏 tab / 底部面板）
    共用 `mount` 的这条路径；host 已有存活会话时（刷新恢复）不重复新开。空态只在「无工作区 / 探测不到 shell」时出现。
  - **探针逮到一个真 bug**：`connectViewer` 的 attach 帧用的是全局默认 shell，**忽略了待建会话自己的 shell**
    ⇒ `＋` 右键「新建：Windows PowerShell」会静默开出默认 shell（pwsh）。改为 `pending?.shell ?? wantedShell`。
  - 顺带清掉已无引用的 `terminalClient.setDefaultShell()` 与快照里的 `wantedShell` 字段（死代码）。
  - 复跑：单测 62 项全绿 + DOM 桩冒烟 **13 断言全过**（自动开一个 / 已有存活会话不重开 / ＋ 右键菜单项
    与置灰 / 指定 shell 生效），探针即弃。

- **同日「按原型对齐」补齐（用户确认原型后逐条比对实现与原型的差异）**：
  - **右栏形态的 `×` 从「缺席」改为可用**：原型里它关闭整个右栏 tab；实现阶段因当时不确定能否调官方 API 而
    临时隐藏。核实 `@deepseek-ai/dsh-client-ui-sidebar-right` 的 `SidebarRightTabActions.close()` 后，经 slot
    注入的 `props.useTabInfo()` 拿到 `tab.actions.close()` —— 右栏标签栏最右的 `×` 现在真的关掉这个右栏 tab
    （`terminalTabs.mount('right', …, { onCloseContainer })`，与底部面板的「收起」语义分开）。
  - **右键菜单补跨容器移位**（原型 §7.1）：底部标签右键「在右栏显示此终端」经官方
    `ctx.sidebarRight.openTab('terminal')` 打开/聚焦右栏 tab，并先把 `active.right` 记为该会话（右栏首次打开时
    `mount()` 读到的就是它，天然落位）；右栏标签右键对应「在底部面板显示此终端」。此前只有状态条一个入口。
  - **状态条补会话计数** `N/8 个会话`（原型状态条要素，此前只有 bin · pid）。
  - `ctx.get('sidebarRight')` 走**软依赖**（不进 `inject`）：宿主没有该服务时降级为「请用官方添加控件」提示，
    不阻塞插件其余功能。
  - **作用域教训（差点漏进真机）**：终端区（`terminalClient`/`terminalTabs`/`showInRight`）定义在
    `module.exports.apply = ctx => {…}` **之前**，`ctx` 只是 `apply` 的形参——在那一层直接写 `ctx.get(...)`
    运行时会 `ReferenceError`。修为模块级 `let sidebarRightService = null` + `apply` 内赋值。**第一版冒烟探针
    把 `ctx` 当参数传进提取代码，把这个作用域 bug 掩盖成了「通过」** ⇒ 记一条：探针注入的依赖必须与生产代码
    **同一条取用路径**（这次改为在提取代码里照 `apply` 的写法给模块级变量赋值），否则验证是假的。
  - 复跑：单测 62 项全绿（host 未变）+ DOM 桩冒烟 **17 断言全过**（右栏 × / 底部 × / 跨容器菜单 / openTab /
    状态条计数 / 新建→ready 换真 id→关闭链路），探针即弃。

- **内嵌终端「标签栏多开」补充设计（规划设计，未改代码）**：用户以 Windows Terminal 标签栏截图为参考，
  要求内嵌终端支持标签栏多开。产出 [补充设计](2026-09-19-terminal-multi-tab-plan.md) 与
  [可交互可视原型](2026-09-19-terminal-tabs-mockup.html)。
  - **现状核查（代码级）**：`TerminalHub` 只持 `this.session`、`viewers` 是无身份 `Set<ws>`、
    `input`/`resize` 帧**不带会话标识**、`broadcast` 全连接扇出 ⇒ **多开的第一障碍是协议不是 UI**；
    且两容器同看一会话时 `pty.resize` 是「最后一次获胜」，先 attach 的一侧必然折行错乱（现存缺陷）。
  - **核心方案**：帧协议 **v2**（attach/input/resize/close/list 全带 `sessionId` + `broadcastTo` 定向广播
    + 旧帧 `VERSION_MISMATCH` 拒收不做双栈）；「单实例纪律」升级为**单集合纪律**（会话集合仍 host 唯一事实源）；
    **每容器独立活动标签**（底部跑构建、右栏盯服务器，两个 viewer 指向同一 `sessionId` 即原有「移位」体验）；
    **最小尺寸仲裁**（`pty.cols = min(viewers)`，结果变化才 `resize`，顺带修掉上述现存缺陷）；
    会话上限 **8**（对齐 ssh 线 U2.1）；刷新后存活 pty 用 `list` 列出并支持接管 / 一键清理（现在会变孤儿）；
    `sessionId` **只寻址不授权**（WS 仍走三道围栏 + 一次性 token）。
  - **交互与视觉**：标签栏复刻参考图语义（左「终端 + shell 名」标题、活动标签胶囊含 `×`、右侧 `＋`/`×`）
    + `▾` 溢出下拉 + 中键关闭 + 双击重命名 + 右键菜单；**浏览器保留键不可拦截**（`Ctrl+T/W`、`Ctrl+Shift+T/W`、
    `Ctrl+Tab` 一律拿不到）⇒ 采用 `Ctrl+Shift+`` 新建、`Ctrl+PageUp·PageDown` 切换、`Alt+1..8` 跳转，
    关闭交给 `×`/中键/`Delete`/菜单；32px 高度 + 6px 圆角，全部走 `--dsw-*` 令牌（三主题无硬编码色）。
  - **待拍板 9 项**（补充设计 §9，推荐项已在原型决策卡预选）；拍板后按 §10 分 **P0 协议加维（≈+12 例单测）
    → P1 标签栏 → P2 无障碍与刷新恢复 → P3 可选增强**，预计 2–3.5 天，落地版本 `0.9.0-miasaki.0`。
  - 触摸点：新增 `design/2026-09-19-terminal-multi-tab-plan.md`、`design/2026-09-19-terminal-tabs-mockup.html`；
    `README.md` 待办与特性表登记。**`index.js` / `client.js` 未改动**。

## 2026-09-12

- **v0.8.1-miasaki.0：v0.8.0 首轮实机反馈两修复**（用户实测：右栏终端 tab 空白 + 标题栏两按钮顺序）。
  - **终端空白根因 = React 18 契约违例**：`terminalClient.snapshot` 的 getter 每次**构造新对象**，
    `useSyncExternalStore` 的 getSnapshot 引用永不稳定 → 无限重渲染 → React 抛错卸载整个 tab 子树
    （表现为整 tab 空白；审查 tab 的 store 返回稳定值所以无恙）。修为 `_snapshot` 只在 `emit()` 时重建，
    getter 返回缓存引用。教训入库：**本插件给 `useSyncExternalStore` 的快照必须返回稳定引用**——
    reviewView（字符串）与 store（固定对象）是既有正例，新 store 一律走 emit 时重建模式。
  - **标题栏按钮顺序交换**（用户要求：侧边栏按钮在左、终端按钮在右）：实测另一注入方（侧栏开关）
    在本按钮之后、同样插到 brand 前面，把终端按钮挤左成 `[终端][侧边栏][brand]`。改为**终端按钮始终
    紧贴 brand** + MutationObserver 常驻重排（其他注入方插入后把它放回 brand 紧前；ensure 内
    「顺序已对不动 DOM」守卫防 observer 自激）→ 稳定 `[侧边栏][终端][brand]`。注入成功后不再
    disconnect observer（改为常驻轻量监听），`--ms-titlebar-reserve: 156px` 仍只在首次注入时设置。
  - 触摸点：`client.js`（terminalClient.snapshot / titlebarButton.ensure+watch）、`package.json`
    （0.8.1-miasaki.0，health 版本可区分修复前后 bundle）、本文件。**重启 `dsh web` 生效**。

- **v0.8.0-miasaki.0：P2 内嵌终端落地——拍板「底部面板 + 右栏 tab 两形态并存」**。用户以参考图
  （标题栏终端按钮带下拉、「切换终端 Ctrl+`」）拍板 §6.①②：**两个形态都要**；路线随之收敛为
  **B（自持 node-pty）**——底部面板宽度随窗口变化，路线 A 的「无 resize」硬伤在底部形态下不可缓解，
  T1（官方 seam spike）跳过，T2 仍是立项门。
  - **T2 spike 通过（路线 B 立项门）**：`node-pty@1.2.0-beta.15` 装入插件（pnpm 11 忽略 install script
    也无碍），从**插件自己的安装上下文**经 prebuilds/win32-x64 直接加载成功（零编译）；`resize(100,30)`
    实测生效（PowerShell `$Host.UI.RawUI.WindowSize.Width` 回读 100）。**新纪律：conpty 的 dll 路径
    拒绝裸名**（`spawn('powershell.exe')` 报 `File not found:`），spawn 前必须 `where` 解析绝对路径
    （`resolvePtyBin`，仍是查 PATH 不执行，启动器纪律 4 延续）。`pnpm-workspace.yaml` 显式
    `allowBuilds: { node-pty: false }`（对齐 ssh 线的 ssh2 处理，install 确定性通过）。
  - **形态与共享模型**：底部面板与右栏终端 tab 是**同一个 pty 会话**的两个 viewer——切换容器 =
    detach 旧 attach 新、1MB 回放环补齐，会话状态不丢（VS Code 同款「移位」）。**每个 viewer 一条
    独立 WS**（共享单连接会让 replay 被写进所有 xterm——设计中途纠正）。单实例纪律沿用旧 §4.3：
    运行中会话绝不因新 attach 参数重启；[重启] / 换 shell / 移动工作区走 `restart: true` 帧显式重启；
    viewer 全部消失**不杀会话**；重连固定 1.5s 退避凭回放补齐。
  - **host 半**（`index.js`）：`PTY_SHELLS`（pwsh/powershell/cmd + darwin/linux 预留，wt 是容器不进表）、
    `TerminalHub`（单会话 + `ScrollbackRing` 回放环 + viewer 广播 + `bufferedAmount > 8MB` 丢帧的
    洪泛保护 T6）、`createTokenGate`（一次性 token，60s TTL 用完即废）、`clampPtySize`、
    `fenceRequest`（三道围栏从 HTTP handler 抽成 HTTP/WS 共用）。路由：`POST /sidebar/api/terminal/token`
    （签发）、`GET /sidebar/api/terminal/session`（状态）、`/sidebar/asset/terminal/{xterm.js,xterm.css,addon-fit.js}`
    （xterm 5 UMD 懒加载 serve，T4）、`registerUpgrade('/sidebar/ws/terminal')`（围栏 → token →
    `wss.handleUpgrade`，ssh 线已验证的接线形状）。**node-pty 与 ws 均惰性加载**——依赖缺失只降级
    内嵌终端（资产 404 + 无 WS），审查 tab 与外部启动器不受影响。
  - **client 半**（`client.js`）：`terminalClient` 控制器（资产懒加载、xterm 主题实时读 `--dsw-*` 令牌
    ——T5 三主题正确、per-viewer WS、断线重连、`restart` 语义）；`TerminalView` React 组件（右栏 tab 主体）；
    终端 tab 内嵌化（工作目录 + shell 胶囊 + 内嵌主体 + 状态条「已退出 [重启] / 会话工作区已变更
    [移到当前工作区]」+ **[在底部打开 ↧]**；原外部启动器收进 `details` 折叠区完整保留）；**底部面板**
    （命令式 DOM：拖拽高度 180–80vh、状态条、[重启][关闭]；**推挤能力检测**——命中
    `#root>[data-slot="root"]>div` 则 `--miasaki-terminal-height` 让位生效，失败自动纯浮层）；**标题栏
    终端按钮**（桌面壳 `#miasaki-titlebar .tb-group` 注入「终端+▾」按钮，MutationObserver 等待挂载点，
    主点击切底部面板、▾ 菜单含新窗口启动器，注入成功同步 `--ms-titlebar-reserve: 156px` 让位）；
    **Ctrl+`** 全局快捷键（capture 拦截，xterm 聚焦时同样生效）。
  - **测试 47 → 54 项全绿**：新增 `test/terminal-hub.test.js`（7 项，fake pty 注入不需要真实 shell）：
    PTY 枚举纪律（wt 不入表）/ clampPtySize / ScrollbackRing 截断与单块保留 / token 一次性 + TTL /
    fenceRequest 三道 / 单会话语义（运行中忽略新参数、restart kill 重 spawn、exit 后 respawn、
    write/resize 对退出会话 no-op）/ 洪泛丢帧。
  - 依赖变化：`node-pty@1.2.0-beta.15`（精确锁版本，与宿主同版本预编译已验）、`ws@^8.21.3`、
    `@xterm/xterm@5.5.0`、`@xterm/addon-fit@0.10.0`（均为终端功能依赖，审查功能零依赖不变）。
  - 触摸点：`index.js`（fenceRequest 抽取 + PTY 段 + token/session 路由 + apply 的 WS/资产接线）、
    `client.js`（terminalClient / bottomPanel / titlebarButton / TerminalView / TerminalTab 内嵌化 /
    样式两块 / Ctrl+` / lifecycle 清理）、`package.json` + `pnpm-workspace.yaml`、README（待办 / 蓝图 /
    目录 / 内嵌终端与 WS 安全段 / 验证计数）、本文件。**生效条件：重启 `dsh web`**；health 返回
    `0.8.0-miasaki.0` 即已加载。
  - **实机验收清单**（静态回归覆盖不到的）：右栏 tab 内嵌终端起 pwsh/powershell 可交互；`vim`/`git log`
    等 TUI 重排正确（resize 跟手）；底部面板与右栏 tab 之间移位后回放补齐、会话不丢；viewer 全关后
    pty 保活（后台进程继续跑）；`yes` 洪泛不卡 UI；三主题配色正确；桌面壳标题栏按钮出现且让位正确、
    web 环境 Ctrl+` 生效；依赖拷贝经 link 安装后原生模块可加载（T2 是插件目录实测，profile 拷贝
    语义待实机确认——health 正常但终端报「依赖加载失败」即此环节问题）。

- **v0.7.0-miasaki.0：P0 数据一致性修复 + P1 diff 阅读器重做落地**（按上午的优化规划提案实现；
  §6 三项拍板中 ①②（终端形态 / 路线）涉及 P2 立项**本次不做**，③（点名交互重排）按提案建议方向实现，
  待用户实机确认——点名钮与主点击已解耦，不接受时可低成本回退）。
  - **P0：详情基线随视图（缺陷修复）**。`diffForFile(cwd, rel, cached)` 退役，新增导出
    `diffForView(cwd, rel, { view, from, context })` → `{ text, baseline }`：`unstaged` → `git diff`
    （工作树 vs 索引）、`staged` → `git diff --cached`、`all` → `git diff HEAD`（无 HEAD 时**回退索引基线**并
    如实标注，与列表 numstat 的兜底一致）、`last` → `git show --format= HEAD`。基线映射导出为
    `REVIEW_BASELINES`（unstaged=index / staged=HEAD / all=HEAD / last=HEAD^），响应新增 `baseline` 与
    `view` 回显，UI 在文件头显示「对比：索引 / HEAD / HEAD^」。
  - **P0：重命名有内容**。`parseStatusRows` 保留 rename 的旧路径（`from`，非 rename 恒 null），
    `reviewStatus` 工作区条目透传 `from`、`last` 条目新增 `revision`（所在提交，HEAD 前进即触发详情重取）；
    详情请求带 `from` 时旧路径与新路径一起进 pathspec——git 的 rename 配对要求两侧都在候选集，只给新路径
    会把 rename 渲染成全新增（这正是列表与详情对不上的机理之一，测试含正反对照）。
  - **P0：切视图 / 刷新 / 切会话必重取 + 错误可见化**。`DiffViewer` 入参从 `{ path }` 改为
    `{ entry, view, refreshTick }`，effect 依赖扩展为 `[path, view, entry.from, entry.revision, refreshTick,
    context, cwd]`；`fetchSidebar` 把 4xx/5xx 回包的 `{ error }` 解析成可读文案；列表与详情失败不再静默——
    区分「host 不可达（fetch 网络层 TypeError）」与「host 报错（附原文案）」两种态。
  - **P1：diff 阅读器重做**。双行号槽（`line.a` / `line.b`，右对齐、不可选中，空槽占位保证内容列对齐）；
    hunk 头渲染整行（含 git 的所在函数尾串，解析器新增 `hunk.header`）；**换行默认开**（`pre-wrap` +
    悬挂网格，面板可切回横向滚动）；上下文档位 `±3 / 10 / 25 / 64`（`context` 参数整档重取 `-U<N>`，
    **不在本地补行**）；`[↑] [↓]` 在 hunk 间滚动跳转并高亮当前；单文件超 2000 行分段渲染（「显示更多」
    按档放量，hunk 不截半行）；diff 行点击 = 复制 `path:line`（可直接喂给对话）；文件头 sticky
    （路径 + 统计 + 基线标签 + 工具钮）。语法高亮**不做**（引第三方高亮库违反零依赖纪律）。
  - **P1：交互重排（提案 §3.3）**。文件行主点击 = 展开 / 收起 diff（**手风琴，同时只开一个**）；点名降位为
    行首独立标记钮（✓ 绿色 / 未点名红描边提示与计数不变）；原行尾独立展开钮移除。行级「在官方预览打开」
    **暂不做**——`dsh-resource://file/session/<id>/…` 的会话身份字段名待实测（提案 §2.2），归入 P3。
  - **顺带修复（渲染器配套暴露）**：`parseUnifiedDiff` 此前把 `git diff` 结尾换行 split 出的空串当一行
    空上下文——旧行渲染下不可见，双行号 UI 下会显示一行假行号（`a:0`）的空行；现在剥掉结尾换行 artifact
    （真实的结尾空上下文行不受影响）。
  - **契约变化**：`POST /sidebar/api/review/diff` body 从 `{ cwd, path, cached? }` 改为
    `{ cwd, path, view?, from?, context? }`（`view` 走 `REVIEW_VIEWS` 白名单，缺省 `all` 兼容旧客户端；
    `context` 经 `normalizeDiffContext` 限 0–64 整数，`from` 与 `path` 同等相对路径约束），响应
    `{ diff, baseline, view }`。`GET /review/status` 形状不变，entries 增补 `from` / `revision`。
  - **测试 40 → 47 项全绿**：review-data 5（+hunk header）、review-view 10（+`normalizeDiffContext`、
    `REVIEW_BASELINES`、`diffForView` 真实 git 仓库集成 ×2：基线分离 / rename 正反对照 / context 收紧 /
    无 HEAD 降级）、api-routing 12（+/review/diff 400 守卫族、真实仓库 200 回显 view+baseline）。
  - 触摸点：`index.js`（diffForView / REVIEW_BASELINES / normalizeDiffContext / parseStatusRows /
    parseUnifiedDiff / reviewStatus / diff 路由）、`client.js`（fetchSidebar 错误解析 / ReviewTab 交互与
    汇总徽标 / DiffViewer 重做 / 样式块）、`package.json`（0.7.0-miasaki.0）、README（待办 / 蓝图 / 验证计数）、
    本文件。**生效条件：重启 `dsh web`**（host 半与 client bundle 都在启动时载入内存）；
    `GET /sidebar/api/health` 返回 `0.7.0-miasaki.0` 即已加载。
  - **未做（记为待办）**：P2 右栏内嵌终端（待拍板 §6.①②，含 spike T1–T6）；信息架构过滤框与分支显示
    （提案 §3.4，P2）；行级「在官方预览打开」（P3）。

- **右侧边栏优化规划设计（用户提出「审查简陋、看不到改动代码；终端不是内置的」）**。产出设计提案
  [`2026-09-12-rightbar-optimization-plan.md`](2026-09-12-rightbar-optimization-plan.md) 与界面示意
  [`2026-09-12-rightbar-mockup.html`](2026-09-12-rightbar-mockup.html)，**未写代码**。核查结论按「已确证 / 待实测」分级：
  - **审查「看不到改动代码」是数据问题，不是渲染问题（已确证）**：列表按所选视图取数（`client.js:423`），
    详情却固定 `git diff HEAD`——客户端只发 `{ path }`（`client.js:569-572`），宿主只认 `body.cached`
    （`index.js:665`），其余一律 `diffForFile(cwd, rel, false)` → `git diff HEAD -- <path>`（`index.js:110-128`）。
    后果：`staged` 视图详情给的是工作树对 HEAD（完全不是暂存内容）；`last` 视图里已提交且工作树干净的文件
    必然显示「无行级变更」。同源缺陷：详情 effect 只依赖 `[path]`（`client.js:576`）→ **切视图不重取**；
    列表带 `from` 但详情不传 → **重命名文件无内容**；列表请求失败静默（`client.js:433`）→ 用户看到
    「无改动」而非「host 不可达」。
  - **行级 diff 数据够用，是渲染丢掉了（已确证）**：`parseUnifiedDiff` 已产出 `hunk.oldStart/newStart` 与
    每行 `{t,a,b,s}`（`index.js:342-381`），而 `DiffViewer` 只渲染 `line.s`（`client.js:583-587`）——
    无行号、无 hunk 头、无换行开关（400px 面板等宽约 40 字符宽，长行必须横滚）、无虚拟化
    （单文件 20000 行全部进 DOM）。
  - **主操作位给错对象（已确证）**：文件行主点击 = 点名（`client.js:538-543`），展开 diff 是旁边独立小 `+`
    （`client.js:548-554`）。审查语境下主点击应是「看变更」。
  - **关键发现：宿主已自带 PTY 栈，旧设计的编译硬门不成立（本机 0.1.5-rc.1 实测）**。宿主
    `node_modules` 内已有 `@deepseek-ai/dsh-terminal`（`ctx.terminals`，owner 作用域）、
    `@deepseek-ai/dsh-subprocess`（`ctx.subprocess.spawnTerminal`）、`dsh-subprocess-local`（依赖
    `node-pty@1.2.0-beta.15` + `koffi`）、`dsh-terminal-bash`。其中 **`node-pty` 已带
    `prebuilds/win32-x64/`（`conpty.node` / `OpenConsole.exe` / `conpty.dll`）**，安装脚本
    `node scripts/prebuild.js || node-gyp rebuild` 在预编译命中时**跳过 node-gyp** ——
    `2026-09-09-sidebar-launcher-design.md` §6 的 **S1 硬门（Windows 需 VS Build Tools 编译）不成立**。
    另：`spawnTerminal` **不需要 Agent**（与 `ctx.terminals.spawn(owner: Agent, …)` 不同），而 0.1.5 已移除
    `ctx.agent`，故 owner 作用域那条路对本插件不可用。
  - **唯一真缺口：官方 handle 无 resize（已确证）**。`SubprocessTerminalHandle` 无 `resize`，
    `dsh-subprocess-local` 只在 spawn 时读 `rows/cols`（`lib/index.js:1035-1036`）；而 `node-pty` 的 `IPty`
    有 `resize(columns, rows)`（`typings/node-pty.d.ts:166`）与 `handleFlowControl`。这是「用官方 seam」与
    「自持 pty」两条路线的取舍点。
  - **终端形态改判建议**：旧设计的底部面板方案前提（标题栏按钮注入 + `--ms-titlebar-reserve` 量测）已随
    2026-09-10 壳退役作废；右栏内嵌所需的分栏 / 浮窗由官方 `ctx.sidebarRight.split()/float()` 白给，
    且官方 `sidebar.right.pane.tab.title` 槽的注释原文就以「a terminal named after its shell」举例。
    → 建议改判为**右栏内嵌**；旧设计 §4.3 生命周期与 §4.4 帧协议、shell 枚举纪律继续沿用。
  - **待用户拍板三项**：① 终端形态是否改判为右栏内嵌；② 终端路线 A（官方 seam，零依赖无 resize）优先
    spike 还是直接 B（自持 node-pty）；③ 是否接受「主点击 = 展开 diff，点名移到行首」的交互重排。
  - **新增 spike 清单 T1–T6**（官方 seam 冒烟 / node-pty 预编译命中 + resize / WS 路由共存 / xterm 懒加载 /
    三主题配色 / 输出洪泛），**T1、T2 为立项门**。
  - 文档同步：README 目录结构补两份新文档；组件蓝图的「标题栏启动器组」行标注形态已被本提案取代。

## 2026-09-11

- **第二阶段清理：壳代码删除 + 迁移遗留缺陷修复**。上一阶段（2026-09-10）只**停用**了壳，代码作为未调用的死代码留在文件里；本阶段按迁移设计 §3 的删除清单执行，并在清理过程中暴露并修复了一处**真实功能缺陷**。
  - **删除**（`client.js` 988 → 756 行）：
    - 壳组件 237 行：`cardIcon` / `TABS` / `tabMeta` / `tabLabel` / `EmptyState` / `TAB_BODIES` / `Shell`；
    - 壳常量与函数：`STORAGE_PREFIX` / `LEGACY_PREFIX_V2` / `LEGACY_KEY_V1` / `WIDTH_MIN|MAX|DEFAULT` / `PUSH_MIN_VIEWPORT` / `DRAWER_MAX_VIEWPORT` / `DRAWER_SWIPE_AXIS_PX` / `FRAME_ANCHOR_SELECTOR` / `FRAME_FINGERPRINT` / `FRAME_FALLBACK_SELECTOR` / `resolveFrame` / `clampWidth` / `drawerCloseDecision`；
    - 壳持久化：`normalizeTab` / `normalizePersisted` / `sessionStorageKey` / `loadPersisted` / `savePersisted` / `applySessionState` / `currentSessionId`；
    - 壳推挤：`measureChromeReserve` / `pushWidth` / `pushFrame` / `pushClear` 及 `PUSH_VAR`；
    - 壳 tab 操作：`mkTab` / `openTab` / `activateTab` / `closeTab` / `setTabView` / `useTabView`；
    - 壳样式：`dsh-sidebar-toggle*` / `tb-sidebar` / 推挤常驻规则 / `scrim` / `panel*` / `tabs` / `tab*` / `newtab` / `panes` / `pane` / `empty*` / `card*` / `resize`。
  - **store 精简**：`open` / `width` / `tabs` / `active` / `sessionId` / `viewport` / `dragging` / `drawerOffset` / `drawerDragging` / `chromeReserve` / `titlebarVisible` 全部移除，只留 `reviewCwd` 与 `pageVisible`。
  - **修复（迁移遗留缺陷）**：`ReviewTab` 的视图此前经 `useTabView(tabId)` / `setTabView(tabId, view)` 读写**壳的 tabs 数组**，而该数组在官方右栏下恒为空（只有已退役的壳会填充它）——**视图下拉点了没有反应**，永远停在「未暂存」。改为模块级 `reviewView` 存储（`useSyncExternalStore` + `localStorage`，键 `miasaki-sidebar:review-view`，全局单值）。
    - **为什么不用官方通道**：`SidebarRightTabActions` 只有 `openResource` / `openTab` / `close`，**没有**「更新当前 tab 参数」的方法；`navigation.params` 只在打开时写入，而 `openTab` 是「打开一个页面类型」而非原地更新。故视图状态只能自管，语义降级为「上次查看的视图」（官方 tab id 由框架生成且刷新即变，按 id 记录没有意义）。
    - 抽取官方类型定义核对的过程记录：`lib/types/client/contract/slots.d.ts`（TabActions / TabNavigation）、`tab-info.d.ts`（TabHookContext）。
  - **可见性门**：新增 `usePageVisible()`，与官方 `tab.visible` **相与**（窗口隐藏时审查 tab 跳过 60s TTL 轮询）；补 `visibilitychange` 监听（此前只有初值，切后台再回来不会更新）。
  - **测试**：
    - 删除 `test/drawer-gesture.test.js`（9 项，被测函数已随壳删除）；
    - `test/client-tabs.test.js` 拆解：7 项持久化用例随壳退役，3 项分组统计迁至新的 `test/review-grouping.test.js`；
    - 新增 `test/review-view-store.test.js`（6 项）：默认值 / 非法值回退 / 写入与订阅通知 / 全集往返 / localStorage 抛错降级 —— 这是上述缺陷修复的回归证明。
  - **验证**：`node --check` 通过；单测 **40 项**（审查 4 + 四视图 6 + 分组 3 + 视图持久化 6 + guide 契约 4 + 终端 7 + 路由 10）；`verify-all.mjs sidebar` **9/9 PASS**。
  - **实机待验**：重启 `dsh web` 后确认官方右栏「审查」tab 的视图下拉**切换即拉取**（修复前无反应）。
  - **文档**：README 重写（失效的壳描述全部替换为当前形态 + 迁移/清理时间线 + 退役行标注）；`2026-09-06-sidebar-roadmap-design.md` 的 §3 / §3.2 标注已被迁移取代。

## 2026-09-10

- **DSH 0.1.5-rc.1 兼容：推挤锚点补 0.1.2/0.1.5 双写**。官方 0.1.5 把 root 的子槽从 root 级 `conversation` 改为 keyed 的 `main`（key = `'conversation'`），会话宿主 DOM 相应从 `[data-slot="conversation"]` 变为 `[data-slot="main"]`。本线主锚点在 0.1.5 上匹配数为 0，仅靠特征查询兜底仍能工作，但语义锚点这一环已死。
  - **改动**：`client.js` 的 `FRAME_ANCHOR_SELECTOR` 改为 `'[data-slot="main"], [data-slot="conversation"]'`（两版各匹配其一，爬升路径无歧义）；同时重写该段注释。推挤载体（`#root > [data-slot="root"] > div` + `<html>` 上的 `--miasaki-sidebar-width`）经实测**无需改动**。
  - **实测依据**（0.1.5-rc.1 隔离实例 = 私有 `DSH_HOME` + 端口 3099，Playwright 无头 chromium + 临时探针插件）：`[data-slot="conversation"]` 计数 **0**；`[data-slot="main"]` 计数 **1**、`display:contents`、`parentElement` 即 centerCol；三条 frame 解析路径（root 锚点链 / 内联样式指纹 / `main.closest(...)`）**指向同一节点**（`frame-three-paths-agree = true`）；给 frame 加 `padding-right:300px` 后中栏 1160→**860**px、撤销复 1160px。
  - **连带结论**：frame 在 0.1.5 新增的 `data-sidebar-collapsed` / `data-rightbar-collapsed` / `data-rightbar-fullscreen` / `data-rightbar-instant` 全部是**条件属性**（写法 `|| undefined`，仅真值挂载），**不可作为恒存选择器**；官方 0.1.5 的 `rightbar` 槽即 0.1.2 的 `details` 槽改名（`data-details-collapsed` → `data-rightbar-collapsed`）。
  - 本轮**只动锚点一处**：三条 web 插件线的 slot 注册名（`conversation.session.header.actions`、`conversation.view`、`shell.overlay`、`sidebar.footer.action`、`settings.section` 等）在 0.1.5 上全部未变，`ctx.slots.inject(key, cb)` 签名与 disposer 语义未变，故其余代码零改动。
  - 详细取证与逐条影响见跨线文档 `dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.5-rc1-slot-contract-2026-09-10.md`（§8 含完整实测数据表与复现步骤）。
- **官方右栏落地后的路线重估（待拍板）**：官方 0.1.5 内置了 `@deepseek-ai/dsh-client-ui-sidebar-right`（分栏/全屏/浮窗/拖拽重排 + 文件树/文档预览/模型交付文件 + `ctx.sidebarRightTabs` tab 类型扩展点），详见 `design/2026-09-10-official-rightbar-reeval.md`。要点：
  - 该槽 `kind: 'single'` 且已被官方占用，**注册即整体顶掉官方右栏**——与 2026-09-06 否决 `details` 槽的理由同构，故"占用 `rightbar` 做自研壳"路线**否决**；
  - 当年否决"重基座"（分栏/浮窗/自由窗口）的成本前提已消失（如今是官方免费能力），但走官方 tab 类型会丢三项本线产品决策：**按会话持久化**（官方明写状态只在内存、刷新回折叠）、**窄屏抽屉 + 右滑关闭**、**桌面壳标题栏入口**；
  - **本线需新增"官方右栏共存"处理**：0.1.2 无官方右栏，0.1.5 下用户同时打开两者会出现**推挤叠加**（官方占 grid 第三列 + 自研再加 `padding-right`，主区被压两次）。
  - **推荐：保持自研壳 + 共存检测**。检测信号用 `[data-rightbar-col]` 的宽度（恒存属性）；**不可**用 frame 的 `data-rightbar-collapsed` / `data-rightbar-fullscreen`（均为 `|| undefined` 条件属性）；`ctx.layout` 只有占位方报告接口，**没有查询右栏是否打开的读接口**。待用户拍板是否接受"两者互斥（官方打开时自研自动收起）"。
- **用户拍板：走官方右栏，自研壳退役**（同日晚于上条）。原话：「官方做了侧边栏就用官方的，不自己做了，准备更新」。**审查 / 终端 / 辅助对话三个 tab 保留**，改为官方 `sidebar.right.pane.tab` 类型接入；自研壳整体退役（推挤 + `shell.overlay` 挂载 + tab 栏 + 空态选择页 + 抽屉手势 + 桌面壳标题栏入口 + 按会话持久化）。
  - 设计见 `design/2026-09-10-migrate-to-official-rightbar.md`（含自研→官方逐项映射、丢失能力的补偿讨论、代码改动清单、实施顺序）。
  - **前置条件：必须先升级到 DSH 0.1.5-rc.1** —— `ctx.sidebarRightTabs` 与 `sidebar.right.pane.tab` 在 0.1.2 上不存在，本迁移无法在旧版本开发或验证。升级方案见 `dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.5-rc1-upgrade-plan-2026-09-10.md`。
  - 上一条的**推荐路线（A）被用户否决**；`design/2026-09-10-official-rightbar-reeval.md` 保留三条路的对比与分析作为决策依据，其 §4「建议」以本条为准。
  - 同日已落的锚点双写改动（`FRAME_ANCHOR_SELECTOR`）随壳一起退役，迁移时删除；它的价值是保证**迁移窗口期内**旧壳在 0.1.5 上仍可用。
- **迁移已实施（v0.6.0-miasaki.0）**：审查与终端改为官方右栏 tab 类型，自研壳停用。
  - **代码**：`inject` 改为 `['slots', 'sessions', 'sidebarRightTabs']`；新增 `RIGHT_BAR_TABS` 与两阶段注册（`ctx.sidebarRightTabs.register` + `sidebar.right.pane.tab`，正文 key 用**类型 id** 而非 kind）；`ReviewTab` 改为 `function ReviewTab(props)`，经 `props.useTabInfo()` 取 `tab.id` / `tab.visible`（该 hook 由 slot 的 inject face 注入，**无需 import**）；`TerminalTab` 同样接收 props。
  - **删除**：Toggle entry 整段 79 行（`SIDEBAR_ICON_PATH` / `SIDEBAR_ICON_SVG` / `toggleFrom` / `ToggleButton` / 会话头 `sidebar-toggle` 注册 / `syncTitlebarButton`）；尾部 70 行的 `shell.overlay` 注册 + 推挤/watchdog/chrome-reserve 生命周期。
  - **保留**：host API 访问层、popover、审查 UI、终端 UI、`REVIEW_VIEWS` 等内容层；样式元素（含审查层 CSS）保留。
  - **第二阶段待办**：壳函数（`pushFrame` / `resolveFrame` / `drawerCloseDecision` / `measureChromeReserve` / `applySessionState` / tab 列表操作 / `Shell` / `EmptyState` / `TABS` / `TAB_BODIES`）与壳 CSS 仍作为**未调用的死代码**留在文件里，不再产生任何副作用；`test/drawer-gesture.test.js` 与 `client-tabs.test.js` 的持久化部分随之退役。
  - **验证**：`node --check` 通过；`sidebarRightTabs.register` / `sidebar.right.pane.tab` / `useTabInfo` 就位，`shell.overlay` / `sidebar-toggle` / `syncTitlebarButton` **清零**；44 项单测全绿（壳测试因死代码仍在而暂时保留）。
  - **待实机验证**：官方右栏「添加控件」→ 引导页出现「审查 / 终端」两个入口胶囊；打开后审查四视图与终端启动器正常；辅助对话仍缺席（M2）。
- **实机验证发现并修复：官方右栏引导页整页渲染失败（同日）**。重启 host 后打开官方右栏，用户反馈「侧边栏怎么什么都没有」——右栏能打开，但**一片空白**，引导页里没有任何入口胶囊。
  - **排查证据链**：① client `Slots.listSubTree` 的实时 occupants 显示 `sidebar.right.pane.tab` 槽内 `@miasaki/dsh-sidebar/review` 与 `/terminal` 两个 key 均 `active: true` ⇒ client 半 apply **确实执行**，两阶段注册没有被 waiting 拦住；② 读官方 `lib/client.js` 的 `SidebarRightTabRegistry.register()`——它在 `ids.has(id)` / kind 冲突时**抛错**，而 body 注册排在类型注册之后却仍存在，反证类型注册同样成功；③ 定位到 `GuideBody`/`EntryBox` 的取值形态是 **`entry.title()` / `entry.description?.()`**（函数调用），而本线 `guide` 条目传的是字符串 ⇒ 渲染抛 TypeError，React 放弃整棵引导页子树。
  - **根因**：`sidebarRightTabs.register` 的 `guide` 条目契约抄错。官方自身写法见 `@deepseek-ai/dsh-client-ui-sidebar-files`：`guide: [{ order, title: () => …, description: () => … }]`——文本字段一律是**函数**。
  - **修复**：新增模块级 `rightBarGuideEntry(title, description, order)` 集中构造该条目（两字段以函数暴露；`kind` 由官方 `refresh()` 从 `definition.kind` 注入，不重复传），注册处改为 `guide: [rightBarGuideEntry(...)]`。
  - **防回归**：新增 `test/rightbar-guide.test.js`（4 项）——按本线既有手法从源码锚点抽取 `rightBarGuideEntry` 求值，断言两字段是函数、官方调用路径不抛错，并留一条「字符串形态必抛 TypeError」的对照用例证明断言有区分力，末尾再锁一条源码断言（注册处必须调用 `rightBarGuideEntry`）。
  - **顺带修复**：`/sidebar/api/health` 的 `version` 由手抄常量改为读 `package.json`（`PLUGIN_VERSION = createRequire(import.meta.url)('./package.json').version`）。迁移到 0.6.0 时手抄值停在 `0.5.1-miasaki.1`，而 README 把该字段当作「host 是否加载了新 bundle」的判据——陈旧 host 会被误判为已更新。
  - **验证**：`node --check` 双半通过；单测 **50 项**（48 通过 + 2 项受限环境自动跳过；新增 4 项全绿）。**待重启复验**：官方右栏引导页出现「审查 / 终端」两个胶囊，点开后审查四视图与终端启动器正常。
  - **教训**：接入第三方扩展点时，契约要**读官方实现**（这里是 `entry.title()` 的调用形态）而不是照着字段名猜；「注册成功」与「渲染成功」是两条独立的链，只验证前者会把渲染期错误留到用户面前。

## 2026-09-06

- **新线立项（路线 D 拍板）**：轻量右侧边栏，无基座完全自研。背景：调研 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（v0.18.0，MIT）后，先倾向"基座复用 + 自研审查 tab"（路线 C），用户质疑重基座问题（裁剪开关只轻界面，骨架/跟随成本仍在），重开后拍板路线 D。
- **四组件蓝图**：右栏壳（推挤/折叠/持久化/三主题令牌/桌面壳让位）、审查 tab（收尾自检清单 + 本轮 git diff）、辅助对话 tab（fork+注入侧线，复用 canvas merge 内核链路）、终端（M1 系统终端启动器 + M3 同屏内嵌规划）。
- **关键决策**：
  - 终端同屏内嵌**先规划后实现**——M3 条件立项（立项门：node-pty 安装 spike + WS 路由 spike + 启动器 2 周高频刚需观察）；M1 先做系统终端启动器（`wt.exe -d <cwd>` / pwsh 回落）；
  - 辅助对话底座复用 canvas 已验证的「fork + 首条消息注入」链路，侧线隐藏性方案待 M2 spike（origin/subagent 机制优先，元数据标记 + 列表过滤兜底）；
  - 右栏与宿主同文档（非 iframe），直接消费 `--dsw-*` 令牌；tab 框架为插件私有注册表，暂不服务化；
  - 数据隔离目录 `$DSH_HOME/miasaki-sidebar/`。
- 文档：`design/2026-09-06-sidebar-roadmap-design.md`；路线论证在跨线 `dsh-miasaki-shared-docs/cross/sidebar-plan-2026-09-06.md`。
- **M1 壳 spike 完成（同日）**：better-sidebar 的 `data-pane="conversation"` 推挤锚点在本机 DSH 0.1.2 bundle 中**不存在**（`data-dsh-frame`/`data-pane` 全 bundle 无匹配）。读 `dsh-client-ui-layout` 源码 + 本机浏览器实测后定稿：
  - 原生 AppFrame 即三列（`sidebar | center | details`），`ctx.layout` 服务存在（`openDetails`/`closeDetails`），但**原生 `details` 插槽路线否决**——官方文档明示该槽 OCCUPIED by ui-conversation's DetailsPanel，`single` 语义下注册即整体顶掉官方工具详情面板；
  - 定稿 **frame `padding-right` 推挤 + `shell.overlay` 挂载**：实测 1280px 视口 center 1000→600px，grid 1fr 正确吸收；dark 主题下 `--dsw-alias-*` 令牌跟随正确；
  - **右栏 z-index < 100**（canvas overlay z-100 实测盖住 z-60 面板，属预期专注视图行为，禁止反向提 z）；
  - **推挤下限从 1024 提到 1280**（实测 900px 视口 center 仅 444px；<1024 官方左栏自动收 56px rail）；
  - 头部 actions 插槽本机确认可用（canvas 按钮在槽内），右栏按钮 order 实现时定。
  - 详见设计文档 §3.1.1；`dsh web` host 为 spike 重启一次（无活跃会话，数据落盘无损）。
- **M1 壳实现落地（同日，v0.1.0-miasaki.1）**：`index.js`（host 骨架：`/sidebar/api` 前缀路由 + trustedHosts 围栏 + 数据目录 `miasaki-sidebar/`）+ `client.js`（壳主体）+ `package.json` / `cordis.patch.yml`（`id: sidebar` 与包名逐字一致）。已装 profile（`link:` symlink）实机验证：
  - **推挤**：frame `padding-right` 实测生效（1280px 视口 center→600px）；打开面板联动 `ctx.layout.closeDetails()` 收官方详情列 ✓；
  - **入口双环境**（用户拍板改版：不放会话头文字按钮）：桌面壳=图标按钮注入窗控胶囊内 min 钮前（`.tb-btn` 同规格），浏览器=会话头 actions 槽同款图标钮（order 30，实测排布在 canvas order 25 右侧）；同一 React 注册 + watchdog 双向跟随（假标题栏注入/移除往返实测闭环）；
  - **让位**：面板 top 跟随 `#miasaki-titlebar` 高度（桌面壳 32px / 浏览器 0，实测）；
  - 壳行为：开合/激活 tab/折叠态持久化（localStorage `miasaki-sidebar:v1`，刷新实测保留）；`sidechat` tab M2 禁用态占位；三 tab 图标条/横排两形态。
  - 待办（壳收尾项）：拖宽把手手感、<1280 浮层与 <768 抽屉实机、Esc 关浮层与 canvas Esc 优先级、桌面壳真机三主题。
- **空态标签选择页（同日，用户拍板 Edge 侧边栏范式）**：`tab: null` 状态（首次打开/关闭最后 tab）面板显示居中「打开标签页」引导 + 三张图标卡片（审查/终端/辅助对话，sidechat 禁用态），点卡片激活对应 tab；tab 栏新增 × 关闭钮回空态。实测闭环：卡片→tab→×→空态，`tab: null` 正确持久化。设计 §3.2 已补记。
- **取消折叠态（同日，用户拍板）**：右栏不做 48px 图标栏折叠——开合即全部，空态选择页承担"暂不进入某个 tab"的轻量形态。client.js 移除 `collapsed` 状态/持久化字段/fold 钮/[data-collapsed] 样式，实测开合与持久化正常（`{"open":true,"width":400,"tab":...}`）。设计 §3.1 已改。
- **标题栏入口对齐 V4 + 徽章左侧（同日，用户拍板第二轮）**：desktop 线并行会话把标题栏改 V4 去胶囊（`.tb-capsule`→`.tb-group` 浮动按钮组），sidebar 注入锚点同步迁移并兜底兼容 V3；按钮位置按用户指定改为**组内首位（徽章 `tb-brand` 左侧）**；按压态从品牌色胶囊改为**通高深色块 + 白图标**（参考图形态）。V4 假标题栏实测：注入顺序 `[tb-sidebar, tb-brand, min, max, close]`、按压切换、移除后会话头按钮回归，全部通过。
- **按钮风格改 DSH 原生（同日，用户拍板第三轮，弃深色块）**：图标换 DSH 原生 `.panelIcon` 16px 填充字形（dsh-client-ui-sidebar，`fill=currentColor` evenodd path），`scaleX(-1)` 镜像使面板列朝右；按钮 = 28px 圆形透明底（label-secondary 墨色、hover `interactive-bg-hover` 提亮，与 dsh-client-ui-sidebar `.iconButton` 同规格）；按压态仅图标变 `label-primary`，无任何色块。桌面壳版沿用壳 `.tb-btn` 基础规格只覆盖图标尺寸与按压态。实测 28×28/50% 圆角/16px 镜像图标/按压变色全部到位。
- **tab 选中态去品牌蓝（同日，用户反馈第四轮）**：pure 亮色主题下 tab `[aria-selected="true"]` 底色令牌 `--dsw-alias-interactive-bg-selected` 解析为亮蓝，观感过重——改用 `--dsw-alias-interactive-bg-hover` 中性灰（与 DSH 左侧边栏选中/悬停同款），文字保持 primary。client.js 注释记录选型依据；`node --check` 过；真机复验（host 重启后）选中态呈中性灰、与未选中 tab 对比温和，通过。部署契约备忘：sidebar 为 `link:` 依赖（源目录 symlink），改源文件即落盘、无需 pnpm install，但 client bundle 在 host 启动时载入内存——**生效必须重启 DSH host**，页面刷新/强刷均无效。

## 2026-09-07

- **审查 tab 数据面 + UI（v0.2.0-miasaki.1，M1 第二项）**：
  - host `/sidebar/api/review/*`：`status`（branch/HEAD/`git status --short --untracked-files=all`，2000 条设界 + `truncated` 标记 + rename 目标路径）、`diff`（单文件：tracked `git diff HEAD` / staged `--cached` / untracked `--no-index` 全量视为新增；自研 unified diff 解析：hunk 头 + add/del/ctx 行列号，20000 行设界、binary/truncated 标记）、`checklist`（GET/POST，按 cwd hash 文件隔离、notes 按路径点名字典 + docsSynced/finalMentioned 开关，原子写临时文件 + rename）；doc-sync 检测按仓库 AGENTS.md 收尾约定（四线根 README + CHANGELOG/docs 比对）；
  - client 审查 tab：当前会话 cwd 驱动（sessions 快照 + watchdog 兜底 0.1.2 懒恢复）、60s TTL 自动刷新 + 手动刷新、「N 条未点名」徽标（未点名红色描边 + 点行即点名往返）、单文件行级 diff 展开（红绿 add/del）、文件状态码 XY 徽章；
  - **实机验证**（本仓真实 16 条改动）：status 全量渲染 ✓、未点名徽标 15 ✓、点名往返（点击→「已点名」→持久化）✓、README.md diff 展开 25 行（11 增/7 删）✓；
  - **途中修复**：① 浏览器 fetch 传参链——统一 `URL/searchParams` + diff 路由 cwd 改从 POST body 注入（host 端）；② untracked diff：`git diff --no-index` 需 `NUL`（Windows 无 /dev/null）且 exit 1 时仍要 stdout（自写 spawn 封装）；③ git 二进制绝对路径（`dsh web` 进程 PATH 无 Git dir）；④ checklist 原子写 await 完成后才返回（早期 fire-and-forget 导致二次读取陈旧）；⑤ 0.1.2 会话懒恢复——cwd 订阅可能不触发，并入 1.5s watchdog 轮询。
  - 单测 4/4（diff 解析器三形态、doc-sync 规则、checklist 持久化往返）。`test/review-data.test.js` 入仓。

- **终端启动器落地（v0.3.0-miasaki.1，M1 第三项 / M1 功能收口）**：设计 §6.1 的启动器形态实现完毕。
  - host `/sidebar/api/terminal/options`：按平台列出终端候选并标 `available`。探测方式**改为 PATH 查询**
    （`where.exe` / `which`）而非执行终端——原设计的 `wt.exe -v` 式探测会在用户桌面闪出真实窗口；
    跨平台查询（如 Windows 上问 linux 项）一律返回 `available: false`，不做无意义 spawn。
  - host `/sidebar/api/terminal/open`：`launchTerminal()` 先校验 cwd（不存在 → 404 / 是文件 → 400），
    再由 `terminalCommand()` 按固定枚举产出 `{ bin, args }` 交给 `spawn`（`detached + stdio:'ignore' + unref`）。
    **四条安全约束**：① shell 只能是 `TERMINAL_SHELLS` 里的 id，客户端无法指定任意 executable；
    ② 全程参数数组、不经 shell，cwd 只占独立参数位（`powershell` / `cmd` 干脆不接路径参数，直接继承
    spawn 的 cwd，恶意路径连 argv 都进不去）；③ cwd 必须绝对且为已存在目录；④ 未安装的终端在 UI 置灰，
    **不静默回落**到用户没选的终端（回落顺序 `wt→pwsh→powershell→cmd` 仅用于默认选中项）。
  - client 终端 tab：显式状态机 `checking → idle → opening → opened | failed`——启动失败绝不显示成功；
    cwd 回显 + 复制、终端类型单选（未安装项 disabled 并标注）、启动中禁用按钮、失败面板带原因与重试。
  - **途中修复**：`reviewStatus()` 内引用了模块作用域不存在的 `ctx`，git 命令失败时会抛
    `ReferenceError` 而非降级为空字段——改为从 `apply()` 显式传入 `logger`。
  - **重命名**：`fetchReview`/`REVIEW_PREFIX` → `fetchSidebar`/`API_PREFIX`（前缀收到 `/sidebar/api`），
    四处调用点同步带上 `/review` 段。
  - 单测 7/7（`test/terminal-launcher.test.js`：argv 构造、恶意路径原样落参数位、未知 shell id 与
    非绝对 cwd 拒绝、平台过滤与回落链、跨平台探测、cwd 三类错误、缺失二进制报名不挂起）；
    本线合计 11/11。**实机验收待用户重启 `dsh web`**——已确认运行中 host 仍是 `0.2.0-miasaki.1`
    旧 bundle，新路由返回 404，符合 `link:` 部署契约。
  - 顺带修正 README 里 `../../dsh-miasaki-shared-docs/…` 越级链接为同仓 `../`。

## 2026-09-08

- **cwd 守卫修复（v0.3.0-miasaki.2）**：状态盘点时以真实 HTTP 负向用例实测终端启动器，发现
  README 宣称的第 3 条安全约束「cwd 必须是绝对路径」**在真实路由上从未生效**——相对路径用例返回
  404 而非 400，且错误信息里的路径已被解释为「相对 host 进程 cwd」（实测 host cwd =
  `dsh-miasaki-desktop\dist`）。
  - **根因**：`resolveWorkdir()` 先 `resolve(raw)` 再判 `isAbsolute(cwd)`；`resolve()` 会把相对路径
    补成绝对路径，于是该判断恒为真，校验形同虚设。危害不在 404——**若该相对路径恰好存在于 host
    cwd 之下，会在 host 自己的目录里真的拉起一个终端**（`test`、`dist` 这类目录名很容易撞上）。
  - **修复**：绝对性判断前置到 `resolve()` 之前（`raw.trim()` → `isAbsolute` → `resolve`），
    非绝对路径一律 400「需要工作区的绝对路径」；UNC 路径仍按绝对放行，绝对路径的既有行为
    （存在性由 `assertDirectory` 判 404 / 文件判 400）不变。
  - **可测性重构**：路由 handler 从 `apply()` 内联闭包抽为导出的 `createApi({ dataFile, trustedHosts, logger })`，
    `apply()` 只负责取配置并 `ctx.webServer.register`。理由是这条约束只在「路由确实调用了守卫」时才成立，
    单测辅助函数无法证明链路（旧单测 `terminalCommand('cmd','relative\\path')` 确实抛 400，但路由永远先 resolve，
    该断言在真实链路上不可达）。
  - **新增 `test/api-routing.test.js`（8 项，走真实 HTTP server）**：`resolveWorkdir` 形态矩阵
    （相对/驱动器相对/`.`/`..`/空/非字符串拒绝，UNC 与绝对路径放行）；`POST /terminal/open` 相对 cwd → **400**
    （回归点：修复前是 404）；**「存在但相对」的危险用例**（`cwd: 'test'` + 未知 shell id，零副作用地证明
    cwd 守卫先于 shell 枚举）；`GET /review/status` 同守卫；绝对但不存在仍 404（不误伤）；
    health 200 / 不可信 Host 403 / 未知路由 404；`trustedHosts` 并集生效。
  - 本线单测 11 → **19 项全绿**；`node ..\scripts\verify-all.mjs sidebar` 5/5（新增一个测试文件）。
  - 触摸点：`index.js`、`test/api-routing.test.js`（新）、`package.json`、`README.md`、本文件。
  - **生效条件**：host 半在启动时载入内存，须重启 `dsh web`；`GET /sidebar/api/health` 返回
    `0.3.0-miasaki.2` 即已加载（盘点时运行中 host 为 `0.3.0-miasaki.1`，终端路由本身可用）。

- **dsh-tavern 右侧边栏对比调研（`design/2026-09-08-tavern-sidebar-comparison.md`，纯调研不动代码）**：
  起因是用户给出 [dsh-tavern](https://github.com/flizzywine/dsh-tavern) 作为右栏参考。调研结论：
  - **它的右栏不是自研**——`tavern-plugin/package.json` 的 client `inject` 明写 `dsh-better-sidebar`，
    右侧 7 个面板（酒馆状态/人物卡库/预设库/系统提示词/世界书库/剧本库/用户画像）全部走
    `ctx.betterSidebar.registerTab({id,title,order,single,createTab,component})`；左栏则是
    `slots.inject("sidebar.workspaces", …)` 整槽替换。所以"参考它"实际是参考基座框架 + 接入用法。
  - **推挤同思路、载体不同**：基座在 `<html>` 写 `--dsh-sidebar-width`、由常驻 CSS 规则消费
    （`layout.css` 命中 AppFrame frame 并平移 details 列），我们目前是 JS 直写
    `frame.style.paddingRight` + watchdog 抢救。前者抗 React 重渲染，后者依赖重写。
  - **新发现（本机 DSH 0.1.2-rc.1 静态取证）**：`dsh-client-ui-renderer` 给每个 slot 宿主渲染
    `<div data-slot="<slotKey>">`，故 `[data-slot="conversation"]` 是稳定语义锚点，其 parentElement
    即 AppFrame 的 `div.centerCol`、再上一级即 frame；frame 自身**无** `data-dsh-frame`/`data-slot`
    （印证 2026-09-06 spike 结论），基座的 `#root [data-dsh-frame]` 在本机不匹配，靠
    `#root > [data-slot="root"] > div` 兜底。建议我们改走
    `document.querySelector('[data-slot="conversation"]')?.closest('div[style*="grid-template-columns"]')`
    （官方锚点 + 特征校验叠加）。
  - **另外两项低成本可吸收**：tab 组件补 `visible` 性能门（M2 辅助对话的前置）；host 围栏补
    `sec-fetch-site: cross-site` 拒绝与 `Origin` hostname 比对（我们目前只比 Host，基座的
    `trust-fence.ts` 有三道）。
  - **明确不采纳**：服务化 `registerTab` 框架 / betterSidebar 兼容层（17 字段 + 17 方法，
    且需先有"多 tab 并列"UI，成本与 M2/M3 同量级，M1 验收后再评估）；多 tab 分栏 / 底部面板 /
    自由浮窗 / body portal 挂载 / 左栏整槽替换（重工作台形态，与轻量右栏定位冲突）。
  - **真机实测（同日，一次性 Cordis 探针 `probe-1`，验完已 undefine + 删输出文件）**：在真实页面
    （DSH 0.1.2-rc.1，1280×800）只读查询 DOM，报告 §6 两条待确认项全部落地：
    `#root > [data-slot="root"] > div` 即 AppFrame frame（`#root` 仅一个子元素）；`[data-slot="conversation"]`
    自身 `display:contents`，parent=centerCol、parent.parent=frame、`closest(...)` 亦命中 frame；
    `[data-dsh-frame]` / `[data-pane]` / `[data-side="details"]` 三个基座选择器计数**全为 0**
    ——基座在本机靠 `#root > [data-slot="root"] > div` 兜底，其详情列平移规则选不中 detailsCol（失效）。
    **附带发现（待复核）**：探针运行时 `#miasaki-titlebar` 元素存在但 `height=0`，按
    `measureChromeReserve()` 的 `rect.height > 0 ? rect.bottom : 32` 会取兜底 32px，与
    README「浏览器无壳时为 0」不符——建议改为「元素不存在或高度为 0 均让位 0」，两环境各复验一次。
  - 触摸点：`design/2026-09-08-tavern-sidebar-comparison.md`（新）、`README.md`、本文件。
    参考仓库克隆在 `_refs/dsh-tavern`、`_refs/dsh-better-sidebar`（均已 ignore，不入库）。

- **右栏实现加固（v0.4.0-miasaki.1，用户拍板「按建议批次开工」）**：按报告 §7 落地批 1–3 + 附带修复，
  单测 19 → **20 项全绿**，`node ..\scripts\verify-all.mjs sidebar` **5/5**。
  - **批 1-a 推挤锚点（client.js）**：`FRAME_SELECTOR`（单一特征选择器）→ `resolveFrame()`：
    主选官方语义锚点 `[data-slot="conversation"]` 的 `closest('div[style*="grid-template-columns"]')`，
    特征查询 `#root div[style*="grid-template-columns"]` 兜底。依据是同日探针实测（见上一条与报告 §6）：
    frame 自身无 `data-dsh-frame` / `data-pane`，而 `#root > [data-slot="root"] > div` 即 frame。
  - **批 1-b host 围栏（index.js）**：Host 单道 → 三道。新增 `sec-fetch-site: cross-site` → 403、
    `Origin` hostname 与 Host hostname 比对（比 hostname 不比 `host:port`；`null`/不可解析按不透明来源拒绝）。
    `test/api-routing.test.js` 新增 1 项走真实 HTTP 的正负用例（跨站标记 / 外部 Origin / `null` → 403，
    同源 Origin / 无 Origin → 200），路由测试 8 → 9 项。
  - **批 1-c 桌面壳让位（client.js）**：`measureChromeReserve()` 的 `rect.height > 0 ? rect.bottom : 32`
    在浏览器环境（`#miasaki-titlebar` 存在但高度 0）会误让位 32px → 改为高度 0 即让位 0；
    桌面壳 `rect.height > 0` 分支行为不变。
  - **批 2 推挤载体（client.js）**：`frame.style.paddingRight` 直写 → `<html>` 的
    `--miasaki-sidebar-width` + 常驻 CSS 规则 `#root > [data-slot="root"] > div, #root div[style*=...]`
    消费，React 重渲染 frame 不再丢推挤；inline `padding-right` 保留为"规则选择器漂移"时的同值兜底
    （两者同值，不会双推）。**刻意不加 transition**：`transition` 简写会覆盖宿主 frame 自身的
    `transition: grid-template-columns`，代价大于收益（已在代码注释与设计文档说明）。
  - **批 3-a `visible` 性能门（client.js）**：store 增 `pageVisible`（`visibilitychange` 驱动），
    壳向 tab 组件传 `visible = open && pageVisible`，审查 tab 的 60s TTL 回调据此跳过；
    本线只渲染激活 tab、面板关闭即卸载，"非激活暂停"天然成立，该门补的是"窗口切后台"。
  - **批 3-b 按会话持久化 v2（client.js）**：全局单键 `miasaki-sidebar:v1` → 按会话
    `miasaki-sidebar:v2:<sessionId>`；旧键在首个读到的会话上一次性迁移并删除；无记录的会话
    **保持当前 UI 状态**（切会话不闪关）并在下次变更时落自己的键。
  - **未做**：betterSidebar 兼容层（§5-D，成本与 M2 同量级，M1 实机验收后再评估）。
  - **生效条件**：host 半与 client bundle 均在 `dsh web` 启动时载入内存，**须重启**；
    `GET /sidebar/api/health` 返回 `0.4.0-miasaki.1` 即已加载。

- **M1 实机复验（浏览器环境，2026-09-08 晚）**：盘点发现运行中 host 仍是 `0.3.0-miasaki.2`——
  `/sidebar/api/health` 报旧版本，且围栏探针反推同样如此（`Origin: https://evil.example` 与
  `sec-fetch-site: cross-site` 均返回 200，属加固前行为）。即 **v0.4.0 加固当时尚未加载**，
  在它之前跑的验收轮覆盖的是旧 bundle。重启 host 后（原进程空闲：无页面连接、无在途 turn；
  新进程 detached，启动日志 `_refs/diag/dsh-web-20260908-2255.*.log`）完成复验，`health` =
  `0.4.0-miasaki.1`：
  - **host 侧**：围栏三道实测（外部 Origin / `sec-fetch-site: cross-site` / `Origin: null` → 403，
    同源 Origin 与无 Origin → 200）、cwd 守卫（相对路径 400、绝对但不存在 404）、
    `review/status` 与 `terminal/options` 200；
  - **client 侧（真实页面 1280×720，受控浏览器）**：`--miasaki-sidebar-width: 400px` 挂 `<html>`，
    frame 计算样式 `padding-right: 400px`；锚点 `[data-slot="conversation"]` →
    `closest('div[style*="grid-template-columns"]')` 命中 `div.pI_x6G_frame`（与特征查询兜底同元素）；
    面板 `top=0`（浏览器无标题栏 → 让位 0）、`z-index 60`；关闭面板后变量清空、padding 归 0，
    重开恢复 400px；
  - **按会话持久化**：两个会话各自独立键（`v2:session-3be425f7…` → `tab:"terminal"`、
    `v2:session-51a6af9d…` → `tab:"review"`），切到无记录会话时面板不闪关（保持当前 UI 状态）；
  - **响应式**：1100px 视口 → `position:fixed` 右侧浮层 + scrim、frame 不推挤；
    700px → 抽屉 + scrim（宽度 `min(viewport, 400)`）；1280px 恢复推挤；
  - **顺带发现（当晚已拍板补齐，见本段末条）**：设计 §3.1 写「<768px 全屏抽屉（遮罩 + 右滑关闭）」，
    实现为 `width = min(viewport, 持久化宽度)` 且无右滑关闭手势（遮罩点击关闭）——
    只有视口窄于面板宽度时才满宽；
  - **本轮未覆盖**：桌面壳环境（标题栏入口、32px 让位分支、三主题）未复验——未启动桌面壳；
    `visible` 性能门只做了 bundle 标记核对（后台跳过刷新需 60s TTL 观察，未做）。

- **抽屉右滑关闭补齐（v0.4.1-miasaki.1，设计 §3.1 遗留项，用户拍板）**：上条「顺带发现」列出的
  「设计写右滑关闭、实现只有遮罩点击」已按设计补齐。
  - **手势**：面板 `touch-action: pan-y` 把水平手势交给 pointer 处理（代价：抽屉内横向滚动被抑制，
    窄视口以垂直滚动为主，可接受）；8px 轴锁定——垂直意图一律释放回标签页滚动（不 `preventDefault`，
    原生滚动不受影响）；拖动期间 `translateX` 跟手，松手回弹或关闭；
  - **判定抽为纯函数** `drawerCloseDecision({dx, dy, width, elapsedMs})`：只认向右 → 垂直意图优先 →
    位移门 `max(64px, 宽度 × 30%)` → 快滑门 `≥32px 且 ≥0.6px/ms`；`elapsedMs ≤ 0` 不参与速度门
    （不做除零）。阈值刻意定义在函数内部，使其可被独立求值（client.js 是 `__ModuleLoader__`
    bundle、无导出，与 desktop 线验证注入层的做法一致）；
  - **新增 `test/drawer-gesture.test.js`（9 项，源码抽取）**：本线 20 → **29 项全绿**；
    `node ..\scripts\verify-all.mjs sidebar` **6/6**（新测试文件被目录扫描自动纳入）；
  - **顺带**：抽屉模式下推宽把手隐藏（`[data-drawer] .dsh-sidebar-resize{display:none}`），宽度拖拽
    仍只在推挤模式生效；`pointercancel`（系统手势/失焦）一律回弹，绝不代替用户关闭面板。
  - 触摸点：`client.js`、`test/drawer-gesture.test.js`（新）、`package.json`（0.4.1-miasaki.1）、
    `README.md`、`design/2026-09-06-sidebar-roadmap-design.md`（§3.1 补记）、本文件。
  - **生效条件**：client bundle 在 host 启动时载入内存，**须重启 `dsh web`**；
    `GET /sidebar/api/health` 返回 `0.4.1-miasaki.1` 即已加载。
  - **实机待验**（<768px 视口）：右滑关闭、垂直滚动不受干扰、遮罩点击与 Esc 仍可用。

- **审查 tab 改版 + 浏览器式标签页方案定稿（纯规划，未写代码）**：`design/2026-09-08-sidebar-review-redesign-implementation.md`（v0.5.0 目标形态）。
  - 参考图要求：视图下拉（未暂存/已暂存/全部分支更改/上一轮更改）+ 目录分组文件列表（类型图标 + 文件名 + 灰色目录 + `+N -M` 统计 + 展开）+ 浏览器式多标签（每标签独立 ×、`＋` 新建、keep-mounted 保留状态）；
  - **语义拍板**：「上一轮更改」= 最近一次 git 提交（`git show HEAD` 视角，非会话轮次追踪）；「全部分支更改」= 工作区全部改动 vs HEAD（未暂存 + 已暂存 + 未跟踪）；
  - 方案要点：host `review/status` 加 `view` 白名单参数 + `git diff --numstat` / `diff-tree` 统计（untracked 逐文件 `--no-index`，200 个设界）+ 空仓库 `noCommits` 降级；client `store.tab` 单值 → `tabs[]/active` 多实例、持久化 v2→v3 一次性迁移、空态重定义为「新标签页」；既有点名 / diff 展开 / 60s TTL / visible 门 / 未点名红描边全部保留；
  - 待用户拍板 3 项后按批 A（host 数据面）→ B（审查 UI）→ C（标签框架）→ D（版本/文档）实施。

- **审查 tab 改版 + 浏览器式标签页落地（v0.5.0-miasaki.1，同日拍板后开工）**：方案见
  `design/2026-09-08-sidebar-review-redesign-implementation.md`（§10 三项拍板、§11 实测校准）。
  单测 29 → **46 项**（新增 `test/review-view.test.js` 6 项 + `test/client-tabs.test.js` 10 项，
  前者含 2 项真实 git 集成用例在受限环境自动跳过），路由 9 → 10 项。
  - **批 A 数据面（index.js）**：`/review/status` 加 `view` 白名单（`unstaged|staged|all|last`，非法 400，无参保持旧语义）。
    **实测校准推翻了方案初稿的三条假设**（探针 `_refs/git-probe`，用后即删）：
    ① numstat 人类格式的 rename 是 `old => new`（不是 `{old => new}`），路径含 ` => ` 即歧义 → 改用 **`-z` 机器格式**，
    rename 记录为 `add\tdel\t\0old\0new\0`，按**新路径**归并；
    ② `git diff-tree` 对 **root commit 默认输出为空**（需 `--root`）→ 改用 `git show --numstat -z --format=`，
    首提交与普通提交统一处理且默认带 rename 检测；
    ③ `--no-index --numstat` 输出带 `NUL => ` 前缀且需逐文件 spawn → **untracked 统计改为 host 读文件**
    （行数 / NUL 字节判二进制 / 2MB 设界 / 200 个文件设界），零 spawn。
    另修：`git status --short` 对含空格路径加引号、非 ASCII 走八进制 UTF-8（`"\344\270\255"`），
    旧代码把引号原样透传给 diff 路由 —— 新增 `unquoteGitPath()`（按**字节**收集转义再一次性解码，
    否则多字节字符会被拆成替换字符）。空仓库 `diff HEAD` / `diff-tree` / `rev-parse` 均退 128 → `noCommits` 降级。
  - **批 B 审查 UI（client.js）**：视图下拉（`menuitemradio` + ✓，浮层 fixed 定位绕开列表 overflow 裁剪，
    **切换即拉取**——`view` 进 effect 依赖）+ 目录分组列表（组头**默认折叠**，组统计为组内求和）+
    扩展名配色图标 + 每文件 `+N`/`-M`（二进制显示 `bin`，无统计显示 `-`）；
    **点名、未点名红描边、DiffViewer、60s TTL、`visible` 门全部保留**（交互不变：点行点名、点 `▾` 展开 diff）。
  - **批 C 标签框架（client.js）**：`store.tab` 单值 → `tabs[]` + `active` 多实例；每标签独立 × 关闭
    （关闭激活标签时激活其左邻，浏览器行为）、`⌄` 全部标签菜单（本期实现）、`＋` 新建标签（类型选择浮层）、
    空态 = 新标签页选择卡；**非激活标签 keep-mounted**（`display:none`，切回不丢状态、不重复拉取）；
    标签标题同类型自动编号（审查 / 审查 2）。持久化 **v3**：`miasaki-sidebar:v3:<sessionId>` =
    `{open,width,tabs,active}`，v2（按会话单 tab）与 v1（全局）一次性迁移后删除。
  - **顺带对齐**：`/sidebar/api/health` 的 version 此前是 `0.4.0-miasaki.1` 而 `package.json` 已升 `0.4.1`
    （并行会话升版时漏改）——现统一为 `0.5.0-miasaki.1`。
  - 触摸点：`index.js`、`client.js`、`test/review-view.test.js`（新）、`test/client-tabs.test.js`（新）、
    `test/api-routing.test.js`、`package.json`、`README.md`、本文件、设计文档（状态改「已落地」+ §11 实测校准）。
  - **生效条件**：host 半与 client bundle 均在 `dsh web` 启动时载入内存，**须重启**；
    `GET /sidebar/api/health` 返回 `0.5.0-miasaki.1` 即已加载。
  - **实机已验（2026-09-09，重启 host 后）**：四视图切换与统计、目录分组折叠、多标签开/切/关与
    keep-mounted、v2→v3 迁移（注入旧键实测）全部通过，逐项证据见下方 2026-09-09 段。

## 2026-09-09

- **v0.5.0 改版实机复验通过（重启 `dsh web` 后，浏览器环境）**：
  - 生效确认：`GET /sidebar/api/health` → `0.5.0-miasaki.1`（重启前仍是 `0.4.0-miasaki.1`，正是本次修的对齐问题）；
    四线静态回归 `sidebar 8/8`。
  - **四视图**：下拉 4 项（✓未暂存 / 已暂存 / 全部分支更改 / 上一轮更改）切换即拉取、逐视图刷新数据——
    已暂存 = 空（本仓无暂存）→「这个视图下没有改动」；上一轮更改 = `design/ +218 -8`（与 `git show HEAD`
    两文件 +212 -0 / +6 -8 一致）；未暂存与全部分支更改 = 3 组同数（含未跟踪 391 行，符合设计 §4.1「unstaged 含未跟踪」）。
  - **目录分组折叠**：默认全折叠；展开 `dsh-miasaki-sidebar/` 得 4 行（README +20 -7 / client.js +472 -119 /
    index.js +213 -12 / package.json +1 -1），合计恰等于组头 +706 -139（组统计 = 组内求和）；再点收起。
  - **多标签 keep-mounted**：`＋` 浮层（审查 / 终端 / 辅助对话禁用）新建「审查 2」（同类型自动编号）；
    标签 2 切「上一轮更改」并展开组后，切到标签 1 再切回——视图、展开态与 DOM 节点身份（探针属性）全部保留，
    非激活 pane 为 `display:none` 而非卸载；`×` 关闭激活标签后左邻激活（浏览器行为）；`⌄` 菜单以
    `menuitemradio` 列出全部标签并带 ✓ 激活态。
  - **v2→v3 迁移**：删 v3 键并注入 `v2:<sessionId> = {open,width:360,tab:"terminal"}`，刷新后得
    `v3 = {open,width:360,tabs:[{id:"terminal-1",type:"terminal"}],active:"terminal-1"}`、v2 键被删除、
    面板宽 360px 生效、终端标签激活——形状与 `normalizePersisted` 一致。
  - **改版回归抽查**：点名往返（8 → 7 → 8 条未点名，行 `unnamed` 类与 title 同步）与行级 diff 展开
    （README.md 渲染 20 增 / 7 删，与 `git diff --numstat` 一致）均正常，检查清单已还原。
  - 环境注记：IAB 浏览器对本页侧栏节点的 Playwright 主 frame 定位器不解析（`getByRole`/CSS 均超时、坐标点击
    不达页面），交互改经页面内原生 `click()` 触发（React 事件委托），可点性另由 `elementFromPoint` 命中测试确认；
    截图归档 `_refs/sidebar-v0.5.0-verify.png`（不入库）。

- **L3 桌面壳环境复验 + 让位描述补正（同日，无头 Edge + CDP 注入真机同款 `theme-init.js`）**：
  桌面壳环境此前只做过「假标题栏」往返验证，本轮用与 WebView2 `initialization_script` 同路径的
  **真实注入层**把桌面壳分支完整跑起来，**40/40 通过**（脚本归档
  `_refs/scripts-archive/verify-sidebar-l3.mjs`、截图 `_refs/sidebar-l3-desktop-shell.png`，均不入库）。
  - **入口**：`.tb-sidebar` 注入 `.tb-group` 组内首位、位于 `.tb-brand` 左侧；沿用壳 `.tb-btn` 规格
    26×26 / 圆角 7px / 透明底，图标覆写 16×16 + `scaleX(-1)`；`aria-pressed` 开合往返正确，
    会话头按钮正确不出现（走标题栏分支）。
  - **推挤与令牌**：1440px 视口 → `--miasaki-sidebar-width: 400px`、AppFrame `padding-right: 400px`，
    关闭后变量清空、padding 归 0；三主题面板底色 pure `rgb(255,255,255)` / zafkiel `rgba(30,26,39,.9)` /
    kurkuriel `rgba(252,250,248,.94)`，品牌令牌 `#5686fe` / `#c23a2e` / `#9e1b1b`。
  - **可点性**：面板打开时标题栏按钮仍被 `elementFromPoint` 命中（标题栏层叠 100000 > 面板 60）。
  - **让位描述补正（本次发现的唯一文档问题，非功能缺陷）**：`#miasaki-titlebar` 在桌面壳环境
    **同样是 `height:0`**——V4 标题栏是零占位叠加层（`themes/src/03-switcher.js:51` 明写
    `#miasaki-titlebar{height:0}`、按钮组 `position:fixed`），`#root` 也无 `margin-top`，
    故 `--sidebar-chrome-reserve` 恒为 0、面板 `top:0px`（探针实测）。`README.md`、设计 §3.1、
    本文件 v0.1.0 段与 tavern 报告里「桌面壳 32px 让位」依据的是**未同步的 legacy
    `themes/runtime.js`**（构建链已改 `themes/src/` 分片），描述已一并修正；代码分支
    `rect.height > 0 ? Math.ceil(rect.bottom) : 0` **保持不变**（零占位下即正确行为）。
  - 触摸点：`client.js`（注释）、`README.md`、`design/2026-09-06-sidebar-roadmap-design.md` §3.1、
    `design/2026-09-08-tavern-sidebar-comparison.md`（§3.1 / §6.5 / §7）、本文件。
  - **真机人工目检（CDP 模拟覆盖不到）**：标题栏按钮 hover / 按压手感、三主题观感、
    拖动与最大化还原时面板位置跟随（真机 IPC）。

- **设计语言统一（v0.5.1-miasaki.1，用户要求「统一设计语言」）**：把面板的字体与几何从
  「自成一体的硬编码」改为**对齐 DSH 原生设计语言**。基准不靠观感，而是从 DSH 0.1.2-rc.1 的
  37 个 `dsh-client-ui-*` 包（约 275 万字符 CSS）实测提取。
  - **字体**：DSH 有完整 shorthand 令牌 `--dsw-font-xxxs-11`(11/14) → `xxs-12`(12/18) →
    `xs-13`(13/20) → `s-14`(14/22) → `base-16`(16/24)，家族 `--dsw-font-family`（系统栈，
    **无 Inter**）、强调字重 **500**；等宽走 `--ds-font-family-code`。本线此前 **21 处**硬编码
    `Inter,system-ui,sans-serif` + 字重 600，另有一处 `font-family:Inter,monospace`
    （Inter 根本不是等宽字体，属笔误）——全部改为令牌。
  - **几何**：圆角归入 DSH 阶梯 4/6/8/10/12/999/50%（`5px`/`7px` 是 DSH 不存在的值）；
    控件高度归位 24/28/32（原 `26px`/`34px`）；列表行改用 DSH 自己的行范式
    `min-height:32px; border-radius:8px; padding:6px 8px; gap:8px`（jobs/session 包实测），
    替代此前 30px 无圆角通栏行；面板左边框改官方详情列同款 `.5px solid var(--dsw-alias-border-l3)`；
    容器水平内边距统一 **12px**（= `--dsh-sidebar-inline-padding`），此前 **9 种**取值
    （2/3/4/8/9/10/14/17/20px）。
  - **语义色**：`#16a34a` / `#dc2626` / `rgba(22,163,74,.16)` / `rgba(220,38,38,.14)` →
    `--dsw-alias-state-success-primary` / `--dsw-alias-state-error-primary` + `color-mix`。
  - **滚动条**：文件列表与正文容器补 `scrollbar-width:thin` +
    `scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent`。
  - **新增离线自检：令牌引用校验**——把本线引用的全部 `--dsw-*`/`--ds-*`/`--dsh-*` 与 DSH
    theme 包的 **367 个定义**比对，发现既有缺陷 `--dsw-alias-interactive-bg-selected`
    **在 DSH 中并不存在**（`badge-ok` 一直靠 fallback 灰底生效）→ 改用
    `--dsw-alias-interactive-bg-hover`；现 **22 个引用全部有定义**。
  - **空态观感修正**（依据同日视觉审查：`deepseek-v4-flash-vision-exp` 对 L3 截图的独立复审）：
    ① 空态下**不再渲染标签栏**——零标签时顶部只剩一个无底无边的裸「＋」，像多余字形而非控件；
    ② 禁用卡（辅助对话 / M2）不再整卡 `opacity:.4`（实测对比度仅 ~2:1、与另两卡「同级不同态」），
    改为**同底色 + 右上角 `M2` 角标 + 降档文字色**，并补 `title` 说明；
    ③ 空态由垂直居中改**顶部锚定**（`padding-top:36px`），消除上方约 310px 死白；
    ④ 卡片内边距改对称 `16px 8px`（原 `18px 8px 13px`）、`gap` 9→8px。
  - 触摸点：`client.js`（样式块 + 空态/卡片 JSX）、`index.js` + `package.json`（版本）、
    `README.md`、本文件。
  - **生效条件**：client bundle 在 host 启动时载入内存，**须重启 `dsh web`**；
    `GET /sidebar/api/health` 返回 `0.5.1-miasaki.1` 即已加载。
  - **未做（记为待办）**：跟随 DSH 的**用户字号缩放**（`--dsh-content-font-delta`，定义在 `body`）
    ——本期用固定档位令牌；跟随缩放需同时处理 line-height，留待下一轮。

- **标题栏启动器组设计定稿（同日，用户参考图 + 拍板三项）**：设计
  [`2026-09-09-sidebar-launcher-design.md`](2026-09-09-sidebar-launcher-design.md)；**M3 内嵌终端从「仅规划」升为已立项**。
  - **用户拍板**：标题栏按钮组新增两按钮——**外部程序跳转**（VS Code 参考图同款：彩色图标主键直接打开默认程序 + 下拉箭头菜单：资源管理器 / VS Code（✓）/ VS Code Insiders，点菜单项 = 打开 + 设默认）+ **终端展开**（点击展开**底部内嵌终端面板**：xterm + node-pty + WS 路由，再点收起、pty 保活）；两者位于侧栏按钮**左侧**：`[外部程序跳转] [终端展开] [侧栏] [徽章] [min] [max] [close]`；
  - **落点 = sidebar 线**（标题栏按钮注入本就是本线职责、pty/WS/静态资源需要 host 运行时）；desktop 线唯一改动 = `03-switcher.js` 让位 `118px` → `var(--ms-titlebar-reserve, 118px)`（两个新键 +52px 组宽后写死值必叠压；变量本线注入、保留 118px 兜底）；
  - **外部程序安全边界沿用启动器纪律**：固定枚举三件 + `Code.exe` 静态定位（`code.cmd` 上溯，**绕开批处理与命令字符串红线**）+ argv 无 shell + cwd 复用 `resolveWorkdir`；未安装项置灰不隐藏、默认选择全局持久化；
  - **pty 生命周期 = 单实例 + 面板收起保活 + 重连回放**（1MB 环形缓冲）；会话切换**不自动重启**（防误杀运行中任务），仅提示条；内嵌 shell 用新 `PTY_SHELLS`（wt.exe 是容器、不入表）；
  - **底座推挤**：`--miasaki-terminal-height` 变量与侧栏 `padding-right` 并存、**无 1280px 下限**（高度推挤与宽度吃紧无关）；SPIKE S3 若不吸收则降级浮层；
  - **立项门（SPIKE 清单 §6）**：S1 node-pty Windows 编译（硬门——降级 = 终端按钮打开系统终端，功能语义不变）/ S3 底部推挤 / S5 xterm 服务 / S2·S4 低风险（SSH 线已证 API 可用）。**未写代码**，README 组件蓝图与目录结构已同步。

## 2026-09-12（晚）

- **标题栏终端按钮调到 tb-group 最左**（用户第二次交换要求：「终端按钮要放左边」）。第一次拍板的「紧贴 brand」实测与右栏开关的注入位置冲突（两者都插 brand 紧前、开关落在终端右侧），改为 `ensure()` 把 `#miasaki-tb-terminal` 置于 `.tb-group` 首位（`insertBefore(btn, group.firstElementChild)`，顺序已对不动 DOM 防 observer 自激）；其它注入方都往 brand 紧前插，天然落在终端之后。`terminal-launcher` 测试无顺序断言，11/11 通过。
