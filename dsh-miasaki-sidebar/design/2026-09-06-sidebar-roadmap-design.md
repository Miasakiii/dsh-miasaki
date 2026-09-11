# 路线 D 总设计 — @miasaki/dsh-sidebar（无基座轻量右栏）

- 日期：2026-09-06
- 状态：设计定稿（未写代码）
- 上游调研与路线论证：[跨线文档 `sidebar-plan-2026-09-06.md`](../../dsh-miasaki-shared-docs/cross/sidebar-plan-2026-09-06.md)

## 1. 目标与红线

### 1.1 目标

在 DSH web 端提供轻量右侧边栏，三张 tab + 壳：

1. **审查**（M1）——收尾自检清单 + 本轮改动 diff；
2. **终端**（M1 启动器 / M3 内嵌规划）——先系统终端启动器，同屏内嵌后续立项；
3. **辅助对话**（M2）——上下文隔离的侧线追问，不打断主任务。

### 1.2 红线（沿用 canvas 线）

- 不改系统提示 / 模型请求 / 工具 schema；**DSH 原生会话是唯一事实来源**；
- 插件**不直接调模型**：辅助对话 = fork 后由 DSH 正常驱动；
- git 只调 CLI、**绝不设置身份**；
- 数据隔离目录 `$DSH_HOME/miasaki-sidebar/`（与 canvas / synapse 不共用）。

### 1.3 三条设计铁律（调研结论，[来源 §2](https://github.com/omdsh-dev/DSH-better-sidebar/blob/main/README.md) 与 Codex /side 实践）

1. **侧聊保持轻**：只做轻量问答定位，不做重任务、不做输入队列；侧聊结论提供"带回主对话"入口；
2. **审查是常显上下文面板**：常显性来自"本轮改动自动刷新"，不做重型 Git 客户端；
3. **终端只服务验证**：cwd 跟随会话、单会话保活即可；启动器形态下该职责交给系统终端。

## 2. 架构总览

### 2.1 双半结构与数据流

```
┌─────────────────────────── DSH host（Node 进程） ───────────────────────────┐
│ index.js（host 半）                                                          │
│   ├─ SidebarStore    会话级状态与投影（复用 canvas WorkspaceStore 模式）        │
│   ├─ /sidebar/api    自建路由族：                                             │
│   │     git.status / git.diff / git.逐条点名      （spawn git CLI，只读）       │
│   │     checklist.*                              （收尾自检清单）               │
│   │     terminal.launch                          （spawn 系统终端）             │
│   │     sidechat.*（M2）                         （fork/注入/侧线元数据）        │
│   └─ 数据落盘 $DSH_HOME/miasaki-sidebar/                                     │
└───────────────────────────────────────────────────────────────────────────┘
        ▲ fetch（同文档同源；与 better-sidebar /sidebar/api 同构思路）
┌───────┴─────────────────── DSH client（浏览器页面） ──────────────────────┐
│ client.js（client 半）                                                      │
│   ├─ 壳挂载：头部 actions 官方插槽「侧栏」按钮 + 右缘把手（复用 canvas 插槽经验） │
│   ├─ 面板容器：fixed 右栏 + 主区推挤变量（--dsh-sidebar-width 同思路）          │
│   └─ tab 框架：三 tab 组件注册表（本插件私有，非 better-sidebar 服务）          │
└───────────────────────────────────────────────────────────────────────────┘
```

要点：

- **与宿主同文档**（canvas 的 iframe 是画布特殊需要，右栏不需要）：client 直接消费 `--dsw-*` 主题令牌（天然跟随三主题，比 canvas 的 iframe 桥简单），host 路由直接 fetch；
- **与 canvas 零代码耦合**：两条线独立挂载、独立版本。canvas 的"会话布"是对话区视图，右栏是旁挂面板，布局上仅需共存验证（见 §8）；
- 参考 better-sidebar 的架构（host 路由族 + client 面板）与 MIT 源码思路，但**不装、不 fork、不复制依赖树**。

### 2.2 命名与标识

- 插件包名 `@miasaki/dsh-sidebar`（`cordis.patch.yml` 的 `name` 与 ModuleLoader id 逐字一致——canvas 线坑 1/坑 2 教训）；
- tab 内部 id：`review` / `terminal` / `sidechat`（插件私有注册表，无第三方注册需求，暂不开放服务化——若要生态化再评估 `ctx.betterSidebar` 兼容层）。

## 3. 右栏壳设计（M1）

> **⚠️ 本节（含 §3.1 / §3.1.1 / §3.2）已被 2026-09-10 的迁移取代，仅作历史存档。**
> DSH `0.1.5-rc.1` 内置官方右侧 Sidebar，用户拍板改用官方，自研壳整体退役；
> 壳代码已于 2026-09-11 第二阶段清理时**删除**。
> 当前形态见 [README](../README.md) 与 [迁移设计](2026-09-10-migrate-to-official-rightbar.md)。
> **本文 §1（目标与红线）、§4–§6（审查 / 辅助对话 / 终端的内容设计）仍然有效。**

### 3.1 布局形态（§2.3 成熟范式落地）

| 项 | 设计 |
|---|---|
| 默认宽度 | 400px，可拖拽 300–600px，边缘把手 6px |
| 折叠态 | **取消（用户拍板 2026-09-06）**——右栏不做 48px 图标栏折叠态，开合即全部；原折叠态设计随空态标签选择页取代 |
| 响应式 | **≥1280px 推挤主区**；1024–1279px 浮层（实测推挤后 center 568–600px 过窄）；<1024px 遮罩浮层（官方左栏此时自动收 56px rail，主区压力最大）；<768px 全屏抽屉（遮罩 + 右滑关闭）。2026-09-06 spike 实测修正：原 ≥1024 推挤在 900px 视口下 center 仅 444px，弃 |
| 推挤锚点 | **AppFrame 三列 grid 容器 + `padding-right` 推挤**（2026-09-06 spike 定稿，**2026-09-08 探针实测重定锚点与载体**）。frame 自身**无稳定属性**——本机 DSH 0.1.2-rc.1 探针实测 `[data-dsh-frame]` / `[data-pane]` / `[data-slot]`（在 frame 上）全为 0，better-sidebar 的 `#root [data-dsh-frame]` 因此不匹配；官方语义锚点是 slot 宿主 div 的 `data-slot="<slotKey>"`（`dsh-client-ui-renderer` 的 `renderOutletContent` 渲染 `<div data-slot={slotKey} style="display:contents">`）。实测层级：`#root > [data-slot="root"] > div` 即 frame；`[data-slot="conversation"]` 的 `parentElement` 即 centerCol、再上一级即 frame。**定稿：主选 `[data-slot="conversation"]` → `closest('div[style*="grid-template-columns"]')`（官方锚点 + 特征校验叠加），`#root div[style*="grid-template-columns"]` 特征查询兜底**。载体改为 `<html>` 上的 `--miasaki-sidebar-width` + 常驻 CSS 规则消费（抗 React 重渲染清 inline），inline `padding-right` 同值兜底；**不加 transition**（`transition` 简写会覆盖宿主 frame 自己的 `transition:grid-template-columns`）。实测 1280px 视口下 center 1000→600px |
| 入口 | **桌面壳（用户拍板 2026-09-06，三轮迭代）：图标按钮注入标题栏按钮组（V4 `.tb-group`，旧 V3 `.tb-capsule` 兜底兼容）、位于徽章 `tb-brand` 左侧 = 窗控列首位；风格用 DSH 原生**——28px 圆形透明钮 + 原生 `.panelIcon` 16px 填充图标（`scaleX(-1)` 镜像、面板列朝右），按压态仅图标变 `label-primary` 无色块（用户拍板弃深色块方案）；**浏览器 fallback：头部 actions 官方插槽同款原生风格按钮**（order 30）。双入口同一 React 注册运行时自切换（标题栏可见→会话头按钮渲染 null；watchdog 1.5s 兜底双向跟随，实测往返闭环） |
| 桌面壳让位 | **让位 = 标题栏实测高度（当前两环境恒为 0，2026-09-09 L3 复验补正）**：`--sidebar-chrome-reserve` 取 `#miasaki-titlebar` 的 `rect.height > 0 ? Math.ceil(rect.bottom) : 0`。**V4 标题栏是零占位叠加层**（`themes/src/03-switcher.js`: `#miasaki-titlebar{height:0}`、按钮组 `position:fixed`），`#root` 无 `margin-top`，故桌面壳与浏览器**两环境都得到 0**、面板 `top:0`（2026-09-09 L3 探针以真机同款注入层实测确认：`bar.height=0` → `reserve=0` → `top:0px`）。**原设计依据的「`body #root` margin-top 32px」出自未同步的 legacy `themes/runtime.js`（构建链已改 `themes/src/` 分片），该前提在 V4 下不成立**；2026-09-08「高度 0 即让位 0」的修复依然有效，且实际覆盖两环境。让位为 0 无功能影响：标题栏层叠 100000 > 面板 60，按钮始终可点（`elementFromPoint` 实测）。canvas 的窗控胶囊水平量测思路不适用于垂直让位，直接量标题栏 |
| 主题 | 直接消费宿主 `--dsw-alias-*`（面板底 `--dsw-alias-bg-layer-1`，**不用** `--dsw-specific-sidebar-fill`）；品牌强调 `--dsw-static-deepseek-450` 派生 |
| 持久化 | localStorage `miasaki-sidebar:v2:<sessionId>`：面板开合/宽度/tab **按会话隔离**（2026-09-08 落地，原为全局单键）；旧全局键 `miasaki-sidebar:v1` 在首个读到的会话上一次性迁移并删除；无记录的会话保持当前 UI 状态、下次变更时落自己的键（切会话不闪关） |

**抽屉右滑关闭（2026-09-08 补齐）**：<768px 抽屉此前只有遮罩点击关闭，与本表「遮罩 + 右滑关闭」不符——已按设计补齐。要点：

- **手势**：面板 `touch-action: pan-y`（水平手势交给 pointer 处理，代价是抽屉内横向滚动被抑制——窄视口以垂直滚动为主，可接受）；8px 轴锁定，垂直意图一律释放回标签页滚动（不 `preventDefault`），拖动期间面板 `translateX` 跟手，松手后回弹或关闭；
- **判定为纯函数** `drawerCloseDecision({dx, dy, width, elapsedMs})`：只认向右 → 垂直意图优先 → 位移门 `max(64px, 宽度 × 30%)` → 快滑门 `≥32px 且 ≥0.6px/ms`；`elapsedMs ≤ 0` 不参与速度门（不做除零）；
- **回归**：`test/drawer-gesture.test.js` 9 项（client.js 无导出，按源码抽取方式覆盖——与 desktop 线验证注入层的做法一致）；
- 抽屉模式下推宽把手隐藏（`[data-drawer] .dsh-sidebar-resize{display:none}`），宽度拖拽仍只在推挤模式生效。

### 3.1.1 spike 实测结论（2026-09-06，本机 DSH 0.1.2，bundle 静态分析 + 浏览器实测）

**原生三列布局的发现与决策**：

1. **DSH 原生 AppFrame 就是三列**：`sidebar | center | details`（`dsh-client-ui-layout`），且有跨插件 `ctx.layout` 服务（`openDetails()` 0→360px / `closeDetails()` / `toggleSidebar()`）。曾考虑直接注入原生 `details` 插槽借用整列——**否决**：官方槽位文档明示该槽 OCCUPIED by ui-conversation's DetailsPanel（工具调用详情面板），`kind:"single"` 语义下注册即**整体替换列内容并连带顶掉官方工具详情 seat**（"registering here replaces the column and takes that seat with it"），破坏原生功能，触碰红线；
2. **宽度约束也否决了 details 槽路线**：原生 clamp 300–520px（本设计要 300–600）；切会话自动 `closeDetails()`；空白会话强制关闭——均与本右栏"常显上下文面板"定位冲突；
3. **定稿方案**：`shell.overlay` 官方槽挂面板容器（`kind:"list"` 多条目共存、全帧 overlayLayer、props 空对象——token-monitor 浮窗已验证该槽）+ frame `padding-right` 推挤（实测数据见上表）。开合用自有按钮 + `ctx.layout.closeDetails()` 联动（右栏打开时收起官方详情列，避免双右栏挤压主区——两条让步链互不知晓）；
4. **与 canvas 共存的 z 序约束**：canvas overlay 是 fixed inset 0 + `z-index:100`，实测盖住 z-60 的右栏面板。**定稿：右栏 z-index 必须低于 100**——canvas 全屏打开盖住右栏是正确行为（专注视图语义），关闭后右栏自然露出，零额外处理；反向提 z 会让右栏悬浮在画布上叠压其工具条/小地图，禁止；
5. **主题令牌跟随实测通过**：dark 主题下模拟面板消费 `--dsw-alias-bg-layer-1` / `--dsw-alias-border-l2` / `--dsw-alias-label-primary` 渲染正确；
6. **头部 actions 插槽可用性**：本机实测 canvas「对话/会话布」按钮正常渲染于会话头（`conversation.session.header.actions`），注册法沿用；右栏按钮的 `order` 值实现时实测定；
7. **桌面壳窗控胶囊让位**：量测思路复用 canvas `syncChrome`（`#miasaki-titlebar .tb-capsule` getBoundingClientRect），浏览器 spike 无法覆盖，M1 实现后进桌面壳联调验证。

**2026-09-08 探针实测补充**（一次性 Cordis client 探针，DSH 0.1.2-rc.1，1280×800）：

8. **`data-slot` 锚点链**：`#root` 只有一个子元素 `[data-slot="root"]`，其 `firstElementChild` 即 `div.pI_x6G_frame`；`[data-slot="conversation"]` 自身 `display:contents`，`parentElement` = `div.pI_x6G_centerCol`、再上一级 = frame；`closest('div[style*="grid-template-columns"]')` 同样得到 frame。
9. **基座选择器在本机全数落空**：`[data-dsh-frame]` / `[data-pane]` / `[data-side="details"]` 计数均为 0——frame 的五个子元素是 `sidebarCol / centerCol / detailsCol / overlayLayer[data-shell-overlay] / handle[data-side=sidebar]`，**detailsCol 自身没有 `data-side`**，故 better-sidebar 的详情列平移规则在本机选不中（其"把手跟随推挤"不生效）。结论：**不能照抄基座选择器**。
10. **`#miasaki-titlebar` 在浏览器环境存在但 `height===0`**：旧式兜底 `rect.height > 0 ? rect.bottom : 32` 会误让位 32px（见 §3.1 桌面壳让位行）。

### 3.2 tab 框架

私有注册表（`{ id, title, icon, component, badge?, onOpen?, onClose? }`），壳负责：tab 栏渲染（图标 + 标题 + 角标 + 关闭）、激活切换、`visible` 信号（非激活 tab 暂停轮询——better-sidebar 同款性能门）、右键菜单（关闭/关闭其他）。不做拖拽重排/分栏/自由窗口（重基座的教训：M1 不做，需要再说）。

**`visible` 门（2026-09-08 落地）**：壳向 tab 组件传 `visible = open && pageVisible`（`pageVisible` 来自 `visibilitychange`）。本线只渲染激活 tab、面板关闭即整体卸载，故"非激活暂停"天然成立；`visible` 额外覆盖"面板开着但窗口被切到后台"的场景，审查 tab 的 60s TTL 刷新据此跳过。

**空态（用户拍板 2026-09-06，Edge 侧边栏范式）**：`tab: null`（首次打开/关闭最后一个 tab 后）时面板不渲染 tab 栏，显示居中「打开标签页」引导 + 每 tab 一张图标卡片（横排，点卡片激活；`sidechat` 卡片 M2 禁用态）；tab 栏常驻 × 关闭钮回空态。空态与 tab 态随持久化 `tab` 字段自然往返。

## 4. 审查 tab 设计（M1）

定位：**收尾自检 + 本轮改动 diff** 的常显上下文面板（差异化点，不与任何重型 Git 客户端竞争）。

### 4.1 数据面（host）

- `git.status`：`git status --short --untracked-files=all`，上限 2000 条（超限 `truncated` 标记——better-sidebar #376 同款设界）；响应带每条 `path / XY` 码；
- `git.diff`：单文件 `git diff`（工作区 vs HEAD）与 `git diff --cached`（暂存区），统一 diff 解析（mod 配对 + 行号 + 上下文折叠，轻量自研，不引 diff 库）；
- `checklist.*`：收尾自检清单（见 4.2）；
- 缓存与刷新：面板激活时刷新 + 手动刷新按钮 + 60s TTL（不常驻轮询，轻开销）；cwd 非 git 仓库时显示原因面板（复用 workspace 判定逻辑）。

### 4.2 收尾自检清单（mia 差异化核心）

把工作区 AGENTS.md 的收尾自检三条**结构化**为勾选卡（对应当前会话工作区，多线仓库按各线约定区分）：

1. **git status 逐条点名**：列出 M/?? 文件，每条带注释框（agent 可标"属于哪个功能"）→ 未点名的条目高亮警示；
2. **文档同步**：检测本轮改动是否触及需同步文档的路径（`*/README.md`、`design/CHANGELOG.md`、fleet `docs/`），比对本轮改动文件清单 → 疑似未同步项自动标出；
3. **变更记录点名**：勾选卡提醒最终回复点名变更文件 + 给出用户下一步。

清单状态持久化到 `miasaki-sidebar/`（跨刷新保留），按会话隔离。

### 4.3 本轮文件视角（M1 简化 / M2 增强）

- **M1**：不做会话事件追踪——"本轮改动"= git status 快照（工作区 vs HEAD 的增量已足够审查）；tab 头部显示快照时间与刷新按钮；
- **M2 增强（可选）**：宿主侧监听会话事件做写文件日志（canvas 投影模式），把"本轮模型写的文件"与 git status 并排（better-sidebar「文件变动」tab 的本轮视角同思路，但只做文件清单 + 时间线，不做完整 diff 面板）。

### 4.4 UI 骨架

```
┌─ 审查 ────────────── [刷新] [快照时间] ─┐
│ ┌ 收尾自检 ─────────────────────────┐ │
│ │ ☑ git status 逐条点名 (12 未点名⚠) │ │
│ │ ☐ README/CHANGELOG 同步 (3 疑似⚠)  │ │
│ │ ☐ 最终回复点名文件                 │ │
│ └──────────────────────────────────┘ │
│ ┌ 本轮改动（工作区 vs HEAD）─────────┐ │
│ │ M  sidebar/design/x.md        [▸] │ │
│ │ ?? sidebar/README.md          [▸] │ │
│ │ （点击展开行级 diff，红绿 + 折叠）  │ │
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

## 5. 辅助对话 tab 设计（M2）

定位：Codex `/side` 同款——**上下文隔离 + 不打断主任务**的轻量侧线追问（铁律 1）。

### 5.1 底座（复用 canvas merge 内核已验证链路）

- **侧线创建** = fork 当前主会话（`ctx.sessions.fork({ sessionId, atSeq })`，atSeq 取当前冻结点）+ 首条消息注入用户侧问（merge 内核同款 API）；侧线内持续追问由 DSH 正常驱动；
- **隐藏性**：侧线不在主会话列表出现——方案待 M2 spike 二选一：①DSH fork 的 origin/subagent 机制（canvas SPIKE 结论里有 subagent descriptor 细节，优先）；②元数据标记 `sourceParentSessionId` + 列表过滤（canvas 血缘由该字段忠实记录，链路现成）；
- **侧线树**：tab 内列当前主会话的侧线（标题 + 最后活动 + 状态），可切换/新建/归档；元数据落 `$DSH_HOME/miasaki-sidebar/`；
- **保存为新会话**：把侧线提升为顶层会话（fork/重命名；canvas 有 fork 后 increaseTitle 经验）；
- **带回主对话**：侧聊内任意消息"引用回主对话"按钮 → 把内容作为 @引用/文本插入主会话输入框（铁律 1 的"带回"入口；canvas 无同款，需 M2 spike 找 DSH composer 注入方式——better-sidebar 用宿主 `onReferenceFile` 结构化引用 chip，DSH 官方 composer 注入 API 待查）。

### 5.2 边界（M2）

- 单层侧线（侧线内不再开侧线）；不做子代理树；
- 不注入自定义系统提示（红线）；模型/preset 跟随主会话 fork 继承；
- 转录呈现用 DSH 会话数据拉取，只读。

## 6. 终端设计：两段式（M1 启动器 + M3 内嵌规划）

### 6.1 M1 —— 系统终端启动器（已定实现）

- host 路由 `terminal.launch`：`spawn` 系统终端到会话 cwd——Windows：`wt.exe -d <cwd>`（Windows Terminal）失败回落 `cmd /c start pwsh -WorkingDirectory <cwd>`；非 Windows（远期）对应 `open -a Terminal` / `x-terminal-emulator`；
- tab UI：大按钮「打开系统终端」+ 当前 cwd 显示 + 复制 cwd + 启动失败原因面板；
- 语义：cwd 恒为会话工作区；不做会话保活（进程在系统终端里，天然独立）。

### 6.2 M3 —— 同屏内嵌终端（仅规划，立项条件见 6.4）

**目标形态**：tab 内 xterm 渲染 + host node-pty 进程 + 自建 WS 通道，cwd 跟随会话。

**实现路线（规划）**：

| 方案 | 内容 | 判断 |
|---|---|---|
| A（推荐） | 插件依赖 `node-pty` + 前端 `@xterm/xterm`（懒加载 chunk）+ 插件自建 `/sidebar/ws/terminal` WS 路由（better-sidebar 同构，MIT 可参照） | 主流做法；成本主要在 Windows 适配 |
| B（降级） | host spawn shell 进程 + 管道透传（无 pty：丢 raw mode/颜色/补全） | 仅作 A 不可行时的保底 |
| C | 外挂 ttyd 类服务 | 引入外部依赖，不推荐 |

**Windows 已知坑清单**（自 better-sidebar v0.12–v0.18 修复史提取，立项时逐项对照）：

1. shell 解析：`DSH_SIDEBAR_SHELL` → 探测 `pwsh.exe` → 兜底 `powershell.exe`（5.1）；shellArgs 替换默认参数；
2. node-pty 安装：优先预编译二进制；失败需 VS Build Tools（**立项前先做安装 spike**）；
3. resize 容错（cols/rows 对不上时报错吞掉）；
4. 字体解析兜底等宽；Nerd Font 图标渲染（可参考 dsh-better-sidebar-terminal-plus 思路）；
5. 跨会话切换保活：客户端卸载发 park 控制帧、跳过重连宽限（否则切会话终端被杀）；
6. WSL 会话 Linux 绝对路径处理。

**前置 spike（立项门）**：node-pty 在本机 Windows 的安装与冒烟 + DSH host 挂 WS 路由的可行性验证（canvas 已证明 host 可挂 HTTP 路由，WS 待验）。

### 6.3 两段式共用面

- tab id `terminal` 不变；M1 启动器界面与 M3 内嵌共享同一 tab 骨架（标题/图标/cwd 显示）；
- 若 M3 落地，启动器降级为内嵌终端的"备胎"按钮（保留）。

### 6.4 内嵌终端立项条件（用户拍板后）

1. 启动器使用后确认"同屏验证 agent 产物"是高频刚需（2 周观察）；
2. node-pty 安装 spike 通过；
3. WS 路由 spike 通过。

## 7. 里程碑与顺序

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M1**（约 3 周） | 线骨架 + 右栏壳 + 审查 tab + 终端启动器 | 三主题 + 桌面壳下：右栏开合/拖宽/折叠正常；审查 tab 能标出未点名与文档未同步；启动器打开系统终端到会话 cwd；与 canvas 共存无叠压 |
| **M2**（+2-3 周） | 辅助对话 tab | 主会话运行中开侧线追问不打断；侧线树/保存为新会话/带回引用可用 |
| **M3**（条件） | 内嵌终端 | 见 §6.4 立项门；验收：同屏终端 cwd 跟随、切会话保活、resize 容错 |

M1 内部顺序：壳（含桌面壳让位）→ 审查数据面 → 审查 UI → 终端启动器 → 共存验证。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| DSH DOM 结构变化（推挤锚点/插槽） | 锚点选择器集中一处 + 看门狗重挂（canvas 教训）；2026-09-06 spike 已实测固化（§3.1.1），AppFrame 结构变化属 DSH 大版本升级事项，跟踪即可 |
| 桌面壳三主题让位细节 | 复用 canvas 量测思路；右栏与画布各自独立变量，互不干扰 |
| fork 侧线隐藏性方案不可行 | 备选元数据标记 + 列表过滤；再不行则侧线可见但命名前缀区分（降级可接受） |
| composer 注入（带回引用）API 缺失 | M2 spike 前置；备选纯文本复制按钮 |
| node-pty Windows 编译失败 | 内嵌终端不立项（6.4 门）；启动器形态继续服务 |
| 与 canvas 布局共存 | 右栏推挤的是 DSH 主区，画布 iframe 随主区收窄；M1 验证画布工具条/小地图在小宽度下的表现 |

## 9. 决策记录

| 日期 | 决策 |
|---|---|
| 2026-09-06 | 路线 D：无基座自研（用户否决路线 C 重基座方案）；终端同屏内嵌**先规划后实现**（M3 条件立项），M1 先做系统终端启动器；审查 tab 独立新线 `dsh-miasaki-sidebar/`（用户拍板）；「文件变动」类能力由自研审查 tab 承担，不装上游 |
| 2026-09-06 | spike 定稿（见 §3.1.1）：better-sidebar 推挤锚点在本机 DSH 不存在，改 AppFrame frame `padding-right` 推挤 + `shell.overlay` 挂载；原生 `details` 插槽路线否决（single 槽注入即顶掉官方工具详情面板）；右栏 z-index < 100（canvas 全屏盖住右栏为预期行为）；响应式推挤下限从 1024 提到 1280 |
| 2026-09-08 | **对照 dsh-tavern/better-sidebar 的右栏调研（`2026-09-08-tavern-sidebar-comparison.md`）后落地三项改造**：① 推挤锚点改「官方 `data-slot` 链 + 特征校验」、载体改 CSS 变量 + 常驻规则（探针实测重定，见 §3.1.1 第 8–10 条）；② host 围栏补 `sec-fetch-site` / `Origin` 两道；③ tab 补 `visible` 性能门、持久化改按会话 v2（含 v1 迁移）。**不采纳**服务化 `registerTab` 框架与 betterSidebar 兼容层（17 字段 + 17 方法，且需先有"多 tab 并列"UI，与轻量右栏定位冲突），不采纳多 tab 分栏 / 底部面板 / 自由浮窗 / body portal 挂载 / 左栏整槽替换 |
