# @miasaki/dsh-sidebar

DSH（DeepSeek Harness）web 插件：**接入官方右侧 Sidebar**（`@deepseek-ai/dsh-client-ui-sidebar-right`），贡献审查、终端两类实在工具（辅助对话待 M2）。自研右栏壳已于 2026-09-10 退役、**2026-09-11 完成第二阶段清理**（壳代码已删除，不再留死代码）。

- 路线 D（2026-09-06 拍板）：不安装 `dsh-better-sidebar` 基座，完全自研；与 canvas 线同构技术栈，零代码耦合；
- 产品理念参考：Codex `/side` 侧边对话、GitHub Copilot 右栏范式、CHI'25 常显侧面板研究（详见设计文档 §2 调研来源）；
- 红线沿用 canvas：不改系统提示/模型请求/工具 schema；DSH 原生会话是唯一事实来源；插件不直接调模型。

## 状态

**当前形态：官方右栏的两个 tab 类型**（2026-09-11 第二阶段清理完成）

| 维度 | 事实 |
|---|---|
| 接入方式 | `ctx.sidebarRightTabs.register`（类型声明 + `guide` 入口胶囊）+ `ctx.slots.register({ name: 'sidebar.right.pane.tab', key })`（正文） |
| 打开入口 | 官方 tab 条的「添加控件」→ 引导页 → 本插件注册的入口胶囊（审查 / 终端） |
| 状态归属 | 面板开合 / 宽度 / 分栏 / 全屏 / 标签栏**全部由官方框架负责**，本线不介入 |
| 自研持久化 | 只剩一处：审查视图（`miasaki-sidebar:review-view`，全局单值）。官方不持久化 tab 状态，且 `tabActions` 只有 openResource / openTab / close，**没有**「更新当前 tab 参数」通道，故视图选择自管 |
| 窗口可见性 | 官方 `tab.visible` 与本插件记录的窗口可见性**相与**，隐藏时跳过 60s TTL 轮询 |

### 迁移与清理时间线

- **2026-09-10 迁移**：DSH `0.1.5-rc.1` 内置官方右侧 Sidebar（分栏 / 全屏 / 浮窗 / 文件树 / 文档预览 / 模型交付文件），
  用户拍板「官方做了侧边栏就用官方的」。壳层（推挤 / `shell.overlay` 挂载 / 自研 tab 栏 / 空态选择页 /
  抽屉手势与遮罩 / 桌面壳标题栏注入 / 两处自研开关 / 按会话持久化）全部停用。
  设计见 [design/2026-09-10-migrate-to-official-rightbar.md](design/2026-09-10-migrate-to-official-rightbar.md)。
- **2026-09-10 实机修复**：首次打开官方右栏是**一片空白**，引导页没有任何入口胶囊。根因不是注册失败
  （两个 `sidebar.right.pane.tab` 正文都在册），而是 `sidebarRightTabs.register` 的 `guide` 条目把
  `title` / `description` 当**字符串**传了 —— 官方 GuideBody 按**函数**读取（`entry.title()` /
  `entry.description?.()`），渲染时抛 TypeError，React 随即放弃整棵引导页子树。
  已修复为函数形态（模块级 `rightBarGuideEntry`），由 `test/rightbar-guide.test.js` 锁死契约；
  同期把 `/sidebar/api/health` 的 `version` 改为直接读 `package.json`（手抄值会让陈旧 host 看起来是新的）。
- **2026-09-11 第二阶段清理**：删除全部壳代码（`Shell` / `EmptyState` / `TABS` 等 237 行组件，以及推挤、抽屉、
  壳常量与壳样式），退役 `test/drawer-gesture.test.js`（9 项）与 `test/client-tabs.test.js` 的持久化部分（7 项），
  并把审查视图从「壳的 tabs 数组」迁到自管存储 —— 这**修复了一个迁移遗留缺陷**：
  修复前 `setTabView` 写的是壳的 tabs 数组，而该数组在官方右栏下恒为空，**视图下拉点了没有反应**。

### 历史（M1，2026-09-09，v0.5.1-miasaki.1）

审查改版与设计语言统一均已完成实机复验，内容层沿用至今：

- **审查改版**（v0.5.0）：视图下拉（**切换即拉取**）+ 目录分组列表（组头默认折叠、组内 `+N -M` 合计）
  + 类型图标 + 行级 diff 展开；点名交互、未点名红描边、60s TTL、可见性门全部保留。
- **设计语言统一**（v0.5.1）：字体与几何对齐 DSH 原生 —— 字体走 `--dsw-font-*` shorthand 令牌
  （家族 `--dsw-font-family`、字重 500、等宽 `--ds-font-family-code`），圆角 / 控件高度 / 内边距归入 DSH 阶梯，
  列表行采用官方行范式（32px + 8px 圆角 + `6px 8px` 内边距），语义色与滚动条走令牌，
  面板边框改官方详情列同款 `.5px + border-l3`。详见 [CHANGELOG](design/CHANGELOG.md)。

> 原壳层能力（推挤锚点 / 抽屉右滑关闭 / 桌面壳让位 / 持久化 v2→v3）的完整设计记录保留在
> [CHANGELOG](design/CHANGELOG.md) 与 `design/2026-09-06-sidebar-roadmap-design.md` 中，**均已被官方右栏取代**，
> 仅作历史存档，不再描述当前行为。

## 组件蓝图（M1–M3）

| 组件 | 定位 | 里程碑 | 状态 |
|---|---|---|---|
| 审查 tab | 四视图（未暂存 / 已暂存 / 全部分支更改 / 上一轮更改）+ 目录分组列表 + 收尾点名 + 行级 diff | M1 / v0.5.0 | **已实机验证**（2026-09-07；v0.5.0 改版 2026-09-09 复验通过）；2026-09-10 迁移为官方右栏 tab 类型 |
| 终端启动器 | host spawn 系统终端到会话 cwd（wt / pwsh / powershell / cmd） | M1 | **已实机验证**（2026-09-08：cwd 回显、类型探测与置灰、启动按钮渲染；启动动作本身仍以 host 路由 HTTP 用例覆盖）；2026-09-10 迁移为官方右栏 tab 类型 |
| 辅助对话 tab | fork+注入侧线（复用 canvas merge 内核链路）+ 侧线树 + 保存为新会话 | M2 | 设计完成（待实现后再注册官方 tab 类型） |
| 标题栏启动器组 | 外部程序跳转按钮（explorer / VS Code / VS Code Insiders 菜单，✓ 默认持久化）+ 终端展开按钮（底部内嵌终端面板：xterm + node-pty + WS 回放） | M3（用户拍板立项） | **设计定稿 2026-09-09**，见 [设计](design/2026-09-09-sidebar-launcher-design.md)；前置 spike：node-pty 编译（硬门）+ 底部推挤 + xterm 服务 |
| ~~右栏壳~~ | ~~推挤 / overlay 挂载 / 标签栏 / 空态 / 抽屉 / 桌面壳让位~~ | 已退役 | **2026-09-10 停用、2026-09-11 代码删除** —— 官方右栏接管（见上方时间线） |

## 目录结构

```
dsh-miasaki-sidebar/
├── README.md
├── package.json            # @miasaki/dsh-sidebar（dsh.client web 声明）
├── cordis.patch.yml        # 插件身份（id: sidebar / 数据目录 / trustedHosts）
├── index.js                # host 半：/sidebar/api 路由族（review + terminal + health）
├── client.js               # client 半：官方右栏 tab 类型注册（审查 / 终端）+ 两个 tab 的正文实现
│                           #   壳层已于 2026-09-11 全部删除，不再留死代码
├── test/
│   ├── review-data.test.js      # diff 解析器 / 文档同步检测 / checklists 持久化单测（4 项）
│   ├── review-view.test.js      # host 半四视图解析器 + 真实临时 git 仓库集成（6 项，其中 2 项集成用例受限环境自动跳过）
│   ├── review-grouping.test.js  # 审查列表目录分组与组内统计求和（源码抽取，3 项）
│   ├── review-view-store.test.js # 审查视图持久化：默认值 / 非法回退 / 订阅通知 / 私有模式降级（源码抽取，6 项）
│   ├── rightbar-guide.test.js   # 官方右栏 guide 条目契约：title / description 必须是函数（源码抽取，4 项）
│   ├── terminal-launcher.test.js # argv 构造 / 枚举校验 / cwd 校验 / 探测 / 启动失败（7 项）
│   └── api-routing.test.js       # 真实 HTTP 路由：cwd 守卫 / Host 围栏 / 浏览器信任三道 / 视图白名单（10 项）
└── design/
    ├── 2026-09-06-sidebar-roadmap-design.md   # 路线 D 总设计（**§3 壳设计 / §3.2 tab 框架已被 2026-09-10 迁移取代**，§1 红线与 §4–§6 内容设计仍有效）
    ├── 2026-09-08-tavern-sidebar-comparison.md # 对照 dsh-tavern/better-sidebar 的实现调研
    ├── 2026-09-08-better-sidebar-compat-assessment.md # betterSidebar 兼容层评估（用户拍板项）
    ├── 2026-09-08-sidebar-review-redesign-implementation.md # 审查改版 + 浏览器式标签页实施方案（v0.5.0；标签栏部分随壳退役）
    ├── 2026-09-09-sidebar-launcher-design.md # 标题栏启动器组：外部程序跳转 + 终端展开（内嵌终端面板，M3 立项）
    ├── 2026-09-10-migrate-to-official-rightbar.md # 迁移官方右栏：壳退役映射表 + 官方契约要点 + 丢失能力补偿（当前形态的设计依据）
    └── CHANGELOG.md                            # 本线变更记录
```

## 终端启动器的安全边界

启动器只 spawn 系统终端，不代执行任何命令，四条约束都在 host 侧强制：

1. **shell 固定枚举**：客户端只能报 `TERMINAL_SHELLS` 里的 id（`wt` / `pwsh` / `powershell` / `cmd`，
   另有 darwin/linux 预留项）；任意 executable 路径一律拒绝，不存在"客户端指定二进制"的口子。
2. **永不拼命令字符串**：`terminalCommand()` 返回 `{ bin, args }` 参数数组交给 `spawn`（无 shell），
   cwd 只落在独立参数位——带 `& | "` 的恶意路径原样传递，不被任何 shell 解释；
   `powershell` / `cmd` 甚至不接路径参数，直接继承 spawn 的 cwd。
3. **cwd 必须是已存在的绝对目录**：非绝对路径 400、目录不存在 404、指向文件 400，不落到 500。
   > 2026-09-08 修复：原先 `resolveWorkdir()` 先 `resolve()` 再判 `isAbsolute`，resolve 之后恒为真，
   > 「必须绝对路径」这条约束在真实路由上形同虚设——相对路径被静默解释为「相对 host 进程 cwd」，
   > 该路径恰好存在时会在 host 自己的目录里真的拉起终端。现在绝对性判断前置（`resolveWorkdir` 导出、
   > `test/api-routing.test.js` 走真实 HTTP 覆盖，含「存在但相对」的危险用例）。
4. **探测不执行终端**：可用性用 `where.exe` / `which` 查 PATH，不去跑 `wt.exe -v`（否则会在用户桌面闪窗）；
   未安装的终端在 UI 里置灰，**不静默回落**到用户没选的终端。

启动进程 `detached + stdio: 'ignore' + unref()`，终端独立于 DSH host 存活，也不会阻塞请求。

## API 路由的浏览器信任围栏

`/sidebar/api` 落在 DSH 自身 `/api` 围栏之外，自带三道（2026-09-08 补齐后两道，对齐 better-sidebar 的
`trust-fence.ts`）：

1. **Host** 必须命中 `localhost` / `127.0.0.1` 或 `cordis.patch.yml` 的 `trustedHosts`（端口无关）；
2. **`sec-fetch-site: cross-site`** 一律 403——浏览器自己判定该请求由别的站点发起；
3. **`Origin`**（存在时）的 hostname 必须等于 Host 的 hostname：比 hostname 而非 `host:port`，因为部分
   Chromium 版本会省略非默认端口的回环 Origin 端口；`Origin: null`（沙箱 iframe / `file:`）按不透明来源拒绝。

三道都是 DNS-rebinding / 跨站纵深防御，**不是鉴权**；`test/api-routing.test.js` 走真实 HTTP 覆盖
（跨站标记、外部 Origin、`null` Origin 均 403，同源 Origin 与无 Origin 正常 200）。

## 验证

```powershell
# 本线单测（40 项：审查 4 + 四视图 6 + 目录分组 3 + 视图持久化 6 + 右栏 guide 契约 4 + 终端 7 + 路由 10）
node test/review-data.test.js
node test/review-view.test.js        # host 半四视图解析器 + 真实临时 git 仓库集成（无子进程输出捕获的环境自动跳过 2 项）
node test/review-grouping.test.js    # 审查列表目录分组与组内统计求和（从 client.js 抽取纯函数求值）
node test/review-view-store.test.js  # 审查视图持久化（抽取 client.js 的 reviewView，注入 mock localStorage）
node test/rightbar-guide.test.js     # 官方右栏 guide 条目契约：title / description 必须是函数（从 client.js 抽取求值）
node test/terminal-launcher.test.js
node test/api-routing.test.js        # 真实 HTTP（随机端口），覆盖 cwd 守卫、Host 围栏、浏览器信任三道与视图白名单

# 受限沙箱（禁止子进程管道 stdio）里 node --test 的多进程隔离会 spawn EPERM，
# 改用同进程模式：node --test --test-isolation=none <逐个测试文件>

# 统一静态回归（含本线）
node ..\scripts\verify-all.mjs sidebar
```

改完 `index.js` / `client.js` 后**必须重启 `dsh web`**——本线以 `link:` 装入 profile，源码即时落盘，
但 host 半与 client bundle 都在启动时载入内存，刷新/强刷页面均无效。`GET /sidebar/api/health` 的
`version` 字段是判断 host 是否已加载新 bundle 的可靠信号——它现在**直接读 `package.json`**（不再手抄，
2026-09-10 修正），当前应为 `0.6.0-miasaki.0`。

## 规划来源

- [统一回归矩阵（跨线共享文档）](../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)
- [路线讨论与调研（跨线共享文档）](../dsh-miasaki-shared-docs/cross/sidebar-plan-2026-09-06.md)
- [dsh-tavern 右侧边栏实现对比调研](design/2026-09-08-tavern-sidebar-comparison.md)（2026-09-08：tavern 右栏实为
  `dsh-better-sidebar` 基座 + 7 个注册 tab；本线据其结论落地官方锚点 / 围栏两道 / `visible` 性能门 / 会话级持久化，
  详见报告 §7 落地状态）
- 上游参考（仅调研/架构参照，不装、不 fork）：[DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT）、
  [dsh-tavern](https://github.com/flizzywine/dsh-tavern)（MIT）
