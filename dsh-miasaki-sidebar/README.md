# @miasaki/dsh-sidebar

DSH（DeepSeek Harness）web 轻量右侧边栏插件：**无重基座**的自研右栏，内置辅助对话、审查、终端三类实在工具。

- 路线 D（2026-09-06 拍板）：不安装 `dsh-better-sidebar` 基座，完全自研；与 canvas 线同构技术栈，零代码耦合；
- 产品理念参考：Codex `/side` 侧边对话、GitHub Copilot 右栏范式、CHI'25 常显侧面板研究（详见设计文档 §2 调研来源）；
- 红线沿用 canvas：不改系统提示/模型请求/工具 schema；DSH 原生会话是唯一事实来源；插件不直接调模型。

## 状态

**M1 功能收口 + 审查改版**（2026-09-08，v0.5.0-miasaki.1）：右栏壳 + 审查 tab + 终端启动器三项全部落地；
审查 tab 按用户参考图改版为「视图下拉 + 目录分组」，标签栏改为浏览器式多标签。单测 46 项
（其中 2 项真实 git 集成用例在无法捕获子进程输出的受限环境自动跳过）、四线静态回归 8/8。
**v0.5.0 改版已实机复验**（2026-09-09，重启 host 后，浏览器环境）：四视图切换与统计、目录分组折叠、
多标签开/切/关与 keep-mounted、持久化 v2→v3 迁移（注入旧键实测）全部通过；
点名往返（8→7→8 条未点名）与行级 diff 展开（README.md 恰为 +20 -7）同时抽查通过。

- 壳：AppFrame padding 推挤（实测 center 1000→600px）、`shell.overlay` 挂载、空态标签选择页（Edge 范式）、双环境入口（桌面壳标题栏徽章左侧 / 浏览器会话头）、三主题令牌跟随；
- 审查 tab：host `/sidebar/api/review/{status,diff,checklist}`（git CLI 只读、2000 条设界、自研 unified diff 解析、按 cwd 隔离的清单持久化）+ 收尾自检清单 UI（逐条点名 / 未点名红色警示 / 行级 diff 展开 / 60s TTL 刷新）。实测本仓 16 条改动全部渲染、点名与 diff 往返正常。
- 终端启动器：host `/sidebar/api/terminal/{options,open}` + 终端 tab UI（cwd 回显与复制、终端类型单选、启动结果与重试）。见下节安全边界。
- **审查改版 + 浏览器式标签页（2026-09-08，v0.5.0，设计 [`2026-09-08-sidebar-review-redesign-implementation.md`](design/2026-09-08-sidebar-review-redesign-implementation.md)）**：
  - **四视图**：host `/sidebar/api/review/status?view=unstaged|staged|all|last`（未暂存 / 已暂存 / 全部分支更改 / 上一轮更改；非法值 400，无参保持旧语义）。统计来自 `git diff --numstat -z` 与 `git show --numstat -z --format=`（rename 按**新路径**归并、二进制标 `bin`）；未跟踪文件由 host 读文件计数（200 个设界 + `truncated` 标记）；空仓库（无 HEAD）走 `noCommits` 降级而非 500。
  - **审查 UI**：视图下拉（**切换即拉取**）+ 目录分组列表（组头**默认折叠**、组内 `+N -M` 合计）+ 类型图标 + 每文件 `+N -M` + 行级 diff 展开；**点名交互、未点名红描边、60s TTL、`visible` 门全部保留**。
  - **标签栏浏览器化**：`tabs[]` 多实例（同类型可开多份，标题自动编号）、每标签独立 × 关闭、`⌄` 全部标签菜单、`＋` 新建标签（类型选择浮层）、空态 = 新标签页选择卡；非激活标签 **keep-mounted**（切回不丢状态、不重复拉取）。
  - **持久化 v3**：`miasaki-sidebar:v3:<sessionId>` = `{open,width,tabs,active}`；v2（按会话单 tab）与 v1（全局）一次性迁移后删除。
  - **顺带修复**：`git status --short` 的引号 / 八进制 UTF-8 路径此前原样透传给 diff 路由（`"a b.ts"` 当成文件名），现统一 `unquoteGitPath()` 还原；`/health` 的 version 与 `package.json` 对齐（此前 0.4.0 / 0.4.1 不一致）。
- **右栏实现加固（2026-09-08，对照 dsh-tavern/better-sidebar 调研，见 `design/2026-09-08-tavern-sidebar-comparison.md`）**：
  - **推挤锚点**改走官方语义锚点 `[data-slot="conversation"]` → `closest('div[style*="grid-template-columns"]')`（探针实测：frame 自身无 `data-dsh-frame`/`data-pane`，`#root > [data-slot="root"] > div` 即 frame），特征查询保留兜底；
  - **推挤载体**改为 `<html>` 的 `--miasaki-sidebar-width` + 常驻 CSS 规则（React 重渲染不再丢推挤），inline `padding-right` 同值兜底；
  - **host 围栏**由「仅 Host」补齐为三道：Host → `sec-fetch-site: cross-site` 拒绝 → `Origin` hostname 比对；
  - **`visible` 性能门**：tab 组件接收 `visible`，窗口切后台时审查 tab 的 60s TTL 刷新跳过；
  - **持久化按会话**：`miasaki-sidebar:v2:<sessionId>`（旧全局 `v1` 一次性迁移），切会话不闪关；
  - **修复**：`#miasaki-titlebar` 在浏览器环境存在但高度为 0 时，旧式 `: 32` 兜底会让面板顶部多出 32px 空白——已改为高度 0 即让位 0。
- **抽屉右滑关闭（2026-09-08 补齐，设计 §3.1）**：<768px 抽屉此前只有遮罩点击关闭，与设计「遮罩 + 右滑关闭」不符——补齐右滑手势：8px 轴锁定（垂直意图释放回标签页滚动、不 `preventDefault`）、位移门 `max(64px, 宽度 × 30%)` 或快滑门 `≥32px 且 ≥0.6px/ms`、拖动跟手 + 松手回弹/关闭；判定抽为纯函数 `drawerCloseDecision`，`test/drawer-gesture.test.js` 9 项覆盖；抽屉模式下推宽把手隐藏。

## 组件蓝图（M1–M3）

| 组件 | 定位 | 里程碑 | 状态 |
|---|---|---|---|
| 右栏壳 | AppFrame padding 推挤 + shell.overlay 挂载 + 浏览器式标签栏（多实例 / 独立关闭 / ⌄ 列表 / ＋ 新建）+ 空态标签选择页 + 三主题令牌 + 桌面壳让位 | M1 / v0.5.0 | **已实机验证**（2026-09-06；v0.5.0 标签栏 2026-09-09 浏览器环境复验通过） |
| 审查 tab | 四视图（未暂存 / 已暂存 / 全部分支更改 / 上一轮更改）+ 目录分组列表 + 收尾点名 + 行级 diff | M1 / v0.5.0 | **已实机验证**（2026-09-07；v0.5.0 改版 2026-09-09 浏览器环境复验通过） |
| 终端启动器 | host spawn 系统终端到会话 cwd（wt / pwsh / powershell / cmd） | M1 | **已实机验证**（2026-09-08：cwd 回显、类型探测与置灰、启动按钮渲染；启动动作本身仍以 host 路由 HTTP 用例覆盖） |
| 辅助对话 tab | fork+注入侧线（复用 canvas merge 内核链路）+ 侧线树 + 保存为新会话 | M2 | 设计完成 |
| 内嵌终端 | xterm + node-pty + 自建 WS 路由（同屏） | M3（条件立项） | 仅规划，见设计 §6 |

## 目录结构

```
dsh-miasaki-sidebar/
├── README.md
├── package.json            # @miasaki/dsh-sidebar（dsh.client web 声明）
├── cordis.patch.yml        # 插件身份（id: sidebar / 数据目录 / trustedHosts）
├── index.js                # host 半：/sidebar/api 路由族（review + terminal 均已落地）
├── client.js               # client 半：壳面板 + 审查 tab + 终端 tab + 双环境入口 + 推挤/空态/持久化
├── test/
│   ├── review-data.test.js      # diff 解析器 / 文档同步检测 / checklists 持久化单测（4 项）
│   ├── review-view.test.js      # 四视图解析器 + 真实临时 git 仓库集成（6 项，其中 2 项集成用例受限环境自动跳过）
│   ├── client-tabs.test.js      # client 侧纯函数（持久化 v3 迁移 / 目录分组统计，源码抽取，10 项）
│   ├── terminal-launcher.test.js # argv 构造 / 枚举校验 / cwd 校验 / 探测 / 启动失败（7 项）
│   ├── api-routing.test.js       # 真实 HTTP 路由：cwd 守卫 / Host 围栏 / 浏览器信任三道 / 视图白名单（10 项）
│   └── drawer-gesture.test.js    # 抽屉右滑关闭判定（源码抽取，9 项）
└── design/
    ├── 2026-09-06-sidebar-roadmap-design.md   # 路线 D 总设计（§3.1.1 spike 结论 + §3.1 入口定稿）
    ├── 2026-09-08-tavern-sidebar-comparison.md # 对照 dsh-tavern/better-sidebar 的实现调研
    ├── 2026-09-08-better-sidebar-compat-assessment.md # betterSidebar 兼容层评估（用户拍板项）
    ├── 2026-09-08-sidebar-review-redesign-implementation.md # 审查改版 + 浏览器式标签页实施方案（v0.5.0）
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
# 本线单测（46 项：审查 4 + 审查视图 6 + client 纯函数 10 + 终端 7 + 路由 10 + 抽屉手势 9）
node test/review-data.test.js
node test/review-view.test.js     # 四视图解析器 + 真实临时 git 仓库集成（无子进程输出捕获的环境自动跳过 2 项）
node test/client-tabs.test.js     # 持久化 v3 迁移 / 目录分组统计（从 client.js 抽取纯函数求值）
node test/terminal-launcher.test.js
node test/api-routing.test.js     # 真实 HTTP（随机端口），覆盖 cwd 守卫、Host 围栏、两道浏览器信任检查与视图白名单
node test/drawer-gesture.test.js  # 抽屉右滑关闭判定（从 client.js 抽取纯函数求值）

# 四线统一静态回归（含本线）
node ..\scripts\verify-all.mjs sidebar
```

改完 `index.js` / `client.js` 后**必须重启 `dsh web`**——本线以 `link:` 装入 profile，源码即时落盘，
但 host 半与 client bundle 都在启动时载入内存，刷新/强刷页面均无效。`GET /sidebar/api/health` 的
`version` 字段是判断 host 是否已加载新 bundle 的可靠信号（本次应为 `0.5.0-miasaki.1`）。

## 规划来源

- [四线统一回归矩阵（跨线共享文档）](../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)
- [路线讨论与调研（跨线共享文档）](../dsh-miasaki-shared-docs/cross/sidebar-plan-2026-09-06.md)
- [dsh-tavern 右侧边栏实现对比调研](design/2026-09-08-tavern-sidebar-comparison.md)（2026-09-08：tavern 右栏实为
  `dsh-better-sidebar` 基座 + 7 个注册 tab；本线据其结论落地官方锚点 / 围栏两道 / `visible` 性能门 / 会话级持久化，
  详见报告 §7 落地状态）
- 上游参考（仅调研/架构参照，不装、不 fork）：[DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT）、
  [dsh-tavern](https://github.com/flizzywine/dsh-tavern)（MIT）
