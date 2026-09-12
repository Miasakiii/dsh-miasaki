# 右侧边栏优化规划设计 — 审查可读性 + 内嵌终端

- 日期：2026-09-12
- 状态：**P0 / P1 / P2 均已实现（v0.8.0-miasaki.0，待重启 `dsh web` 实机验证；实现偏差与拍板记录见
  CHANGELOG 同日条目与 §6）**
- 范围：`@miasaki/dsh-sidebar` 两个官方右栏 tab（审查 / 终端）的**内容层**与 **host 数据面**；不动官方右栏壳、不动其它线
- 取证环境：本机 DSH `0.1.5-rc.1`（`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`）
- 取代关系：本文**取代** `2026-09-09-sidebar-launcher-design.md` 的**形态决策**（底部面板 + 标题栏按钮）——该设计的两条前提（标题栏按钮注入、`--ms-titlebar-reserve` 量测写入）已随 2026-09-10 自研壳退役作废；其 §4.3 pty 生命周期与 §4.4 帧协议、安全纪律继续有效

---

## 0. 结论摘要

三条事实，均已核到代码行或宿主产物：

1. **「审查看不到改动代码」不是渲染问题，是数据问题。** 列表按所选视图取数，详情却固定走 `git diff HEAD`；两者基线不一致，且详情请求不带视图参数、effect 只依赖 `path`，切视图不会重取。已提交且工作树干净的文件在「上一轮更改」下必然显示「无行级变更」。
2. **终端不是内置的，是 M1 的既定形态。** 当前只 spawn 系统终端，无 PTY、无 I/O、无回放。而 DSH 0.1.5-rc.1 **自带完整 PTY 栈**，其中 `node-pty@1.2.0-beta.15` 已随宿主安装且带 win32-x64 预编译产物——旧设计里「Windows 编译 node-pty」这道**硬门已不存在**。
3. **行级 diff 的数据其实够用，是渲染丢掉了。** 解析器已产出 hunk 起始行号与每行新旧行号，UI 只画了 `line.s`，所以既无行号也无 hunk 头。

推进建议分三层：**P0 修数据一致性**（缺陷级，优先级最高）→ **P1 重做 diff 阅读器** → **P2 内嵌终端**。

---

## 1. 现状核查

### 1.1 审查：列表与详情基线不一致（确证）

客户端 `client.js`：

- 列表：`GET /review/status?view=<view>`（L423）
- 详情：`POST /review/diff`，body **只有** `{ path }`（L569–572）
- 详情 effect 依赖 **仅** `[path]`（L576）

宿主 `index.js`：

- 详情路由只读 `body.cached === true`（L665）
- 其余情况一律 `diffForFile(cwd, rel, false)` → `git diff HEAD -- <path>`（L110–128）

后果矩阵：

| 视图 | 列表基线 | 详情实际基线 | 后果 |
|---|---|---|---|
| 未暂存 | 工作树 vs 索引 | 工作树 vs HEAD | 混入已暂存改动，`+N/-M` 与内容对不上 |
| 已暂存 | 索引 vs HEAD | 工作树 vs HEAD | **完全不是暂存内容** |
| 全部分支更改 | 工作树 vs HEAD | 工作树 vs HEAD | 一致（唯一正确项） |
| 上一轮更改 | `git show HEAD` | 工作树 vs HEAD | 已提交且干净的文件显示「无行级变更」 |

同源缺陷（一并确证）：

- **切视图不重取**：展开状态保留时，`DiffViewer` 的 `[path]` 未变 → 不重新拉取。
- **刷新不重取**：列表刷新（`refreshTick`）不进详情依赖。
- **重命名丢内容**：列表带 `from`（L281、L285），详情不传 → 旧路径侧不参与 diff，重命名文件常显示为空。
- **错误被吞**：列表失败静默（L433 `.catch(() => setLoading(false))`），用户看到的是「无改动」而非「host 不可达」。这正是「简陋」体感的主要来源之一。

### 1.2 审查：主操作与点名冲突（确证）

文件行主点击 = **点名**（写 checklist，L538–543），展开 diff 是旁边一个独立小 `+`（L548–554）。在「审查」语境下，行点击的默认预期是「让我看变更」；点名是收尾自检的附加动作，却占了主操作位。

### 1.3 审查：渲染信息量不足（确证）

`parseUnifiedDiff` 已产出 `hunk.oldStart/newStart` 与每行 `{ t, a, b, s }`（index.js L342–381），而 `DiffViewer` 只渲染 `line.s`（client.js L583–587）：

- 无行号（`a` / `b` 未消费）
- 无 hunk 头
- 无语法高亮
- **无换行开关**——400px 面板 + 等宽字体约 40 字符宽，长行必须横向滚动，这是窄栏读 diff 的第一可读性瓶颈
- 无虚拟化：单文件上限 20000 行全部进 DOM

### 1.4 终端：当前是外部启动器（事实澄清）

`TerminalTab` 调 `/terminal/options` 探测 shell，`/terminal/open` 由 host `spawn(..., { detached: true, stdio: 'ignore' }).unref()`（index.js L502–520）。无 PTY、无输入输出流、无回放；「已启动」只代表 spawn 事件成功。

这是 M1 的既定形态，**不是缺陷**；问题在于 M3 内嵌方案未落地，且其原设计前提已失效。

---

## 2. 平台能力盘点（0.1.5-rc.1 实测）

### 2.1 宿主自带 PTY 栈（关键发现）

| 包 | 版本 | 提供 | 位置 |
|---|---|---|---|
| `@deepseek-ai/dsh-terminal` | 0.1.5-rc.1 | `ctx.terminals`：owner 作用域 PTY 注册表（spawn / startSend / read / signal / kill / list） | 宿主 `node_modules` |
| `@deepseek-ai/dsh-subprocess` | 0.1.5-rc.1 | `ctx.subprocess.spawnTerminal(spec)` → `SubprocessTerminalHandle`（pid / output / write / inspectForeground / signalForeground / terminate） | 同上 |
| `@deepseek-ai/dsh-subprocess-local` | 0.1.5-rc.1 | 上述 seam 的本地实现，依赖 `node-pty@1.2.0-beta.15` + `koffi` | 同上 |
| `@deepseek-ai/dsh-terminal-bash` | 0.1.5-rc.1 | 本地 shell 后端（`@xterm/headless`） | 同上 |

两条硬事实：

1. **node-pty 已在本机安装，且带预编译产物。** `node_modules/node-pty/prebuilds/win32-x64/` 含 `conpty.node`、`conpty_console_list.node`、`conpty/OpenConsole.exe`、`conpty/conpty.dll`（darwin arm64/x64、linux arm64/x64 亦有）。其 `package.json` 的安装脚本是
   `"install": "node scripts/prebuild.js || node-gyp rebuild"`，而 `scripts/prebuild.js` 的语义是「预编译命中即以 0 退出」，`node-gyp rebuild` 因此**不会执行**。加载器 `lib/utils.js:18-19` 的解析顺序为 `build/Release` → `build/Debug` → `prebuilds/<platform>-<arch>`。
   → 旧设计 §6 的 **S1「node-pty 在 Windows 需 VS Build Tools 编译」硬门不成立**（仍需在**插件自己的安装上下文**实测一次，见 T2）。
2. **`ctx.subprocess.spawnTerminal` 不需要 Agent。** 与 `ctx.terminals.spawn(owner: Agent, …)` 不同，它不要求 owner，插件 host 半可直接调用。后者要求精确 Agent 句柄，而 0.1.5 已移除 `ctx.agent`（见 `dsh-0.1.5-rc1-slot-contract-2026-09-10.md` §7），插件（非 tool）拿不到 Agent → **官方 owner 作用域那条路对本插件不可用**。

### 2.2 官方右栏可直接复用的扩展点

| 能力 | 说明 | 本线用途 |
|---|---|---|
| `sidebar.right.pane.tab.title`（keyed） | **动态 chip 标题**；官方注释明确举例「a terminal named after its shell, a chat after its first line」 | 终端 tab 显示 shell 名与运行态；审查 tab 显示 `12 files +340 −120` |
| `ctx.sidebarRight.split()` / `float()` / `dock()` / `focus()` | 分栏、浮窗、聚焦 | diff 需要宽视野时把审查 tab 分栏出去；终端可浮窗 |
| `tab.signal` | 仅在 tab 记录消失或插件卸载时 abort，**隐藏与切会话不 abort** | 终端 pty 可跨隐藏保活 |
| `tab.visible` | 停靠 tab 需面板展开且为激活 tab | 已有，继续做轮询门 |
| `dsh-resource://file/session/<id>/<path>` + `openResource(addr, { params: { line } })` | 官方文档预览支持定位到行（`WorkspaceFileParams`） | 从 diff 跳到官方预览对应行；**会话身份字段名待实测** |
| `ctx.webServer.registerUpgrade` | WS 升级路由 | SSH 线已验证可用（`/ssh/ws`），本线复用 |

### 2.3 能力缺口（必须自行解决或 spike）

1. **官方 handle 没有 resize。** `SubprocessTerminalHandle` 无 `resize`；`dsh-subprocess-local` 只在 spawn 时读 `rows/cols`（`lib/index.js` L1035–1036），全文无 resize 实现。而 `node-pty` 的 `IPty` **有** `resize(columns, rows)`（`typings/node-pty.d.ts` L166）。→ 这是「用官方 seam」与「自管 pty」的核心取舍点。
2. **WS 不享受浏览器同源保护。** xterm 官方安全指南明确指出 websocket 不受 origin 限制 / CORS 约束，要求自行叠加鉴权；现有 `/sidebar/api` 三道围栏不能直接照搬，需补一次性 token。
3. **输出洪泛。** `yes`、大日志会淹没前端；node-pty 提供 `handleFlowControl`（XOFF/XON）与 `pause/resume`，官方 seam 无对应开关。

---

## 3. 审查 tab 优化设计

### 3.1 P0：数据一致性（必修——属缺陷，不属增强）

契约调整：

```
GET  /sidebar/api/review/status?cwd=&view=      # 形状不变，entries 增补 revision
POST /sidebar/api/review/diff  { cwd, path, view, from?, context? }
     → { diff: { path, hunks, truncated, binary },
         baseline: 'index' | 'HEAD' | 'HEAD^' }
```

宿主按视图解析基线（白名单沿用 `REVIEW_VIEWS`，非法视图仍 400）：

| view | 详情基线 |
|---|---|
| `unstaged` | `git diff -- <path>`（工作树 vs 索引） |
| `staged` | `git diff --cached -- <path>` |
| `all` | `git diff HEAD -- <path>`；未跟踪走 `--no-index NUL <abs>`（现有逻辑保留） |
| `last` | `git show --format= HEAD -- <path>` |

配套：

- `from` 存在时把旧路径一并交给 git（`git diff HEAD -- <from> <path>`），重命名才有内容；
- 响应回 `baseline`，UI 在文件头显示「对比：索引 / HEAD / HEAD^」，从根上消除「数字对不上」的困惑；
- 客户端 `DiffViewer` 入参改为 `{ path, view, from, revision }`，effect 依赖同步扩展；
- 列表失败不再静默：区分**非 git 仓库 / 无提交 / 该视图无改动 / host 不可达（附 health 版本号）**四种态。

**验收**：同一文件在四个视图下的 `+N/-M` 与展开内容一致；切视图立即重取；重命名文件有内容；host 不可达时给出可行动文案。

### 3.2 P1：diff 阅读器重做

数据已具备，主要是消费与布局：

```
┌ 文件头（sticky）  src/index.js              +12 −4   [在预览中打开] [分栏] ┐
├ hunk 头           @@ -120,7 +120,9 @@  export function apply(ctx) {     ┤
├ 旧   新   │ 内容                                                          │
│ 120  120  │   const api = createApi({ ... })                               │
│ 121       │ − const old = legacy()                                          │
│      121  │ + const next = modern()                                         │
│ ⋯ 折叠 14 行上下文   [展开 +5]                                              │
└ [上一处] [下一处] [换行 开] [折叠未变更]                                     ┘
```

要点（按优先级）：

1. **换行默认开**：面板宽 < 560px 时强制换行 + 悬挂缩进；宽面板可关（横向滚动）。窄栏可读性第一顺位。
2. **双行号槽**：`line.a` / `line.b` 右对齐 12px、tertiary 色、不可选中；空槽留位（新增行左侧留空，保证内容列对齐）。
3. **hunk 头可读**：渲染 `@@ -a,b +c,d @@` 并保留函数上下文尾串。
4. **上下文按需扩展**：默认 `-U3`；「展开」以 `context=N` 重取该文件（`git diff -U<N>`），**不在本地补行**（避免与基线漂移）。
5. **变更跳转**：`[上一处] / [下一处]` 在 hunk 间滚动并高亮当前 hunk。
6. **虚拟化**：单文件 > 2000 行只渲染可视 hunk 窗口；列表本身保持轻量。
7. **整仓单次 diff（P3 优化）**：一次 `git diff` 取全量再按文件切分，把 N 次 spawn 降为 1 次；需权衡内存与现有 16MB 上限。

### 3.3 P1：交互语义重排

| 元素 | 现状 | 建议 |
|---|---|---|
| 文件行主点击 | 点名 | **展开 / 收起 diff**（手风琴，同时只开一个） |
| 点名 | 主点击 | 行首独立标记钮（保留原「未点名」红描边提示与计数） |
| 展开钮 `+` | 独立小按钮 | 移除（并入主点击），保留 `aria-expanded` |
| 行级动作 | 无 | 「复制 `path:line`」（可直接喂给对话）、「在官方预览打开」 |

理由：审查面板的第一职责是「让我看懂改了什么」；点名属收尾自检的附加动作，不应占据主操作位。

### 3.4 P2：信息架构

- 头部一行：视图选择 + 分支 / HEAD + 汇总（`12 files  +340 −120`）+ 刷新 + 快照时间；
- **过滤框**（路径子串）——大改动集必备；
- 目录分组保留（已实现），组头默认折叠策略维持；
- 底部状态条：`未点名 3 / 文档未同步 2`，点击定位。

### 3.5 与既有红线的关系

- 不改系统提示 / 模型请求 / 工具 schema —— 本设计只读 git 与自建 WS，**无冲突**；
- git 只调 CLI、绝不设置身份 —— 新增基线调用沿用 `runGit`（只读参数），**无冲突**；
- 「DSH 原生会话是唯一事实来源」—— 审查数据来自 git 工作区，不经会话改写，**无冲突**。

---

## 4. 终端 tab 优化设计（M3 改版）

### 4.1 形态决策：右栏内嵌（取代底部面板）

| 维度 | 旧设计（底部面板） | 本提案（右栏内嵌） |
|---|---|---|
| 入口 | 标题栏按钮（`syncTitlebarButton`） | 官方右栏 tab 类型（**已有**） |
| 前提 | 需 desktop 让位变量 + 标题栏注入 | **无跨线改动** |
| 前提状态 | **已作废**（2026-09-10 壳退役，标题栏注入删除） | 成立 |
| 分栏 / 浮窗 | 需自研推挤 + 高度变量 + spike S3 | 官方 `split()` / `float()` 白拿 |
| 与审查并排 | 需自研布局 | 官方分栏，天然成立 |
| 窗口级占用 | 全宽横贯，压扁对话区 | 只在右栏内，不侵占对话区 |
| 实现量 | 推挤 + 高度拖拽 + 让位变量 + 三主题校准 | tab 正文 + WS 路由 |

**结论**：旧设计的形态前提已失效，且右栏内嵌所需能力**全部由官方提供**，建议改判。旧设计 §4.3 的 pty 生命周期（收起保活、重连回放、退出重启、切会话不自动重启）与 §4.4 帧协议、§4.2 的 shell 枚举纪律**继续沿用**。

### 4.2 实现路线：两条，需拍板

**路线 A —— 用官方 `ctx.subprocess.spawnTerminal`（建议先 spike）**

- 优点：不新增依赖；复用官方进程管理与沙箱策略；与宿主生命周期一致。
- 缺点：**无 resize** —— 面板宽度变化后 pty 尺寸不可变，只能保持固定 `cols/rows`，或重开进程（丢状态）。
- 缓解：初始 `cols` 按当前面板宽度算；宽度变化时提示「终端尺寸已变 — [重启以适配]」；同时向上游提 resize 需求。

**路线 B —— 插件自持 `node-pty`（能力最全）**

- 优点：`resize` / `onData` / `pause` / `resume` / `handleFlowControl` 全可用；窗口自适应跟手；输出洪泛可背压。
- 缺点：新增原生依赖；需在插件自己的安装上下文验证预编译命中（本机已有同版本预编译产物，风险可控但**必须实测**）。
- 缓解：精确锁 `node-pty@1.2.0-beta.15`；安装脚本 `prebuild.js || node-gyp rebuild` 在预编译命中时不编译。

**建议**：先做 A 的 spike（半天量级）。若 resize 缺失导致体验不可接受，转 B。理由：A 零依赖、风险最低，而「终端宽度不跟手」在窄栏中是明显但可容忍的降级。

### 4.3 帧协议与生命周期

沿用 SSH 线已验证形状（语义本地化）：

```jsonc
// Client → Host
{ "type": "attach", "shell": "pwsh", "cwd": "...", "cols": 100, "rows": 24, "token": "..." }
{ "type": "input",  "data": "ls\r" }
{ "type": "resize", "cols": 100, "rows": 24 }   // 仅路线 B 真正生效
{ "type": "detach" }

// Host → Client
{ "type": "ready",  "shell": "pwsh", "pid": 1234, "cwd": "..." }
{ "type": "replay", "data": "..." }              // 重连回放（截断到最近 200KB）
{ "type": "output", "data": "..." }
{ "type": "status", "state": "running|exited", "code": 0 }
{ "type": "error",  "code": "SHELL_MISSING|CWD_INVALID|PTY_FAILED", "message": "..." }
```

生命周期：首次 `attach` 才 spawn（懒启动）；tab 隐藏发 `detach`、**pty 保活**（`tab.signal` 不 abort）；重连回放 scrollback；`exit` 显示「已退出 [重启]」；会话 cwd 变化**不自动重启**（防误杀），显示非阻塞提示条。

### 4.4 安全边界（四道，全部 host 侧强制）

1. **shell 固定枚举**：客户端只报 id（`pwsh` / `powershell` / `cmd`，darwin/linux 预留 `bash`），不传可执行路径 —— 沿用现有 `TERMINAL_SHELLS` 纪律，`wt.exe` 这类容器不进 PTY 集合。
2. **永不拼命令字符串**：`argv` 数组直传；cwd / cols / rows 只落 option 位 —— `SubprocessTerminalSpawnSpec` 正是这个形状。
3. **WS 自建鉴权**：Host 围栏三道（Host 白名单 / `sec-fetch-site` / Origin hostname）+ **一次性连接 token**（HTTP 侧签发、WS 侧校验、用完即废），因为 WS 不享受浏览器同源保护。
4. **输出视为不可信**：xterm 渲染，不用 `innerHTML`；`onTitleChange` 与链接点击一律转义 / 外开；剪贴板写入需用户手势。

另：`cwd` 必须绝对且为已存在目录（复用 `resolveWorkdir`）；pty 只接受帧内 cwd，路由层不做路径假设。

### 4.5 Spike 清单（立项门）

| 编号 | 验证项 | 通过判据 | 失败降级 |
|---|---|---|---|
| T1 | 路线 A：`ctx.subprocess.spawnTerminal` 起 pwsh 并回吐输出 | `handle.output` 有数据、`write()` 有回显 | 转路线 B |
| T2 | 路线 B：插件安装上下文 node-pty 预编译命中 + `resize` 生效 | 无 node-gyp 编译；`resize` 后 TUI 重排 | 退回路线 A（尺寸不跟手） |
| T3 | `/sidebar/ws/terminal` 与现有 `/sidebar/api` 前缀路由共存 | 两条路由互不影响 | 换路径前缀 |
| T4 | xterm UMD 经 host 路由 serve + 懒加载 | 首次展开才拉取（约 400KB） | 内联打包 |
| T5 | 三主题下 xterm 配色由 `getComputedStyle` 读 `--dsw-*` 令牌 | 三主题均正确 | 固定双主题色 |
| T6 | 输出洪泛（`yes` / 大日志）不卡死 UI | 有背压或截断策略 | 前端限流 + 提示 |

---

## 5. 分阶段落地与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 修正** | 详情基线随视图、重命名支持、effect 依赖、错误可见化 | 四视图 `+N/-M` 与展开内容一致；切视图即时重取；错误有明确文案 |
| **P1 阅读器** | 行号 / hunk 头 / 换行默认开 / 上下文扩展 / 变更跳转 / 虚拟化 / 主点击展开 / 点名移位 | 400px 面板内可完整读懂一份 200 行 diff，无需横向滚动 |
| **P2 内嵌终端** | 路线 A 或 B + WS + xterm + 动态 chip 标题 | 在右栏内交互式跑 `git status` / `vim`；tab 隐藏后保活；三主题配色正确 |
| **P3 深化** | 与官方预览联动（`dsh-resource://file` + 行定位）、分栏并排 diff、整仓单次 diff | 从 diff 行跳预览定位正确；分栏下审查与终端并排可用 |

每阶段完成时同步 `README.md` 与 `design/CHANGELOG.md`，并把新增用例计入 `verify-all.mjs` 的 sidebar 项。

---

## 6. 待用户拍板 → **2026-09-12 已拍板**

1. **终端形态**：~~改判右栏内嵌？~~ → **拍板：底部终端面板与右栏内嵌 tab 两个形态并存**（用户参考图：
   标题栏终端按钮带下拉、「切换终端 Ctrl+`」tooltip——底部面板入口 = 标题栏终端按钮 + Ctrl+` 快捷键；
   右栏 tab 沿本提案）。两形态共享同一 pty 会话（单实例 + 保活 + 回放，旧 §4.3 沿用），attach/detach
   天然支持「同一个终端在底部与右栏之间移位」（VS Code 同款体验）。
   - 底部面板形态修正：壳已退役，旧「推挤 AppFrame」锚点代码已删——第一期实现为**能力检测**：
     能命中主内容容器则推挤（`padding-bottom` + `--miasaki-terminal-height`），命中失败自动降级**浮层**
     （fixed 底部 + 阴影，不遮键区）。
   - 标题栏按钮注入**重建**：注入对象（desktop 线 titlebar v4 的 `#miasaki-titlebar .tb-group` 与
     `--ms-titlebar-reserve` 让位变量）仍然健在（2026-09-12 核对 `themes/src/03-switcher.js:89`、
     `06-titlebar.js`），2026-09-10 退役的只是 sidebar 线的注入方代码。
2. **终端路线**：~~A 优先 spike？~~ → **拍板：直接路线 B（自持 node-pty）**，由形态并存推得——底部面板
   宽度随窗口变化，resize 缺失（路线 A 的硬伤）在底部形态下不可缓解；T2（预编译命中 + resize 实测）
   仍是立项门，T1（官方 seam 冒烟）跳过。node-pty 精确锁 `1.2.0-beta.15`（与宿主同版本，预编译产物已验）。
3. **点名交互**：已按提案建议实现（v0.7.0：主点击 = 展开 diff 手风琴，点名移行首独立标记钮），
   待实机确认；点名钮与主点击已解耦，不接受可低成本回退。

---

## 7. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 官方 `spawnTerminal` 无 resize | 终端尺寸不跟手 | T1 / T2 前置；提示条重启；上游提需求 |
| node-pty 在插件安装上下文需编译 | 阻塞路线 B | 同版本预编译已在宿主命中（本机证据）；T2 前置 |
| WS 鉴权不到位 | 本机 shell 暴露给同页任意脚本 | 一次性 token + 三道围栏；仅绑回环 |
| diff 虚拟化引入渲染缺陷 | 读错行 | 与现有 `parseUnifiedDiff` 单测并行加渲染快照测试 |
| 官方右栏 API 在 0.1.6 变动 | 需跟随 | 只用公开面（tab 类型 / title 槽 / `ctx.sidebarRight`），不碰官方 store 内部 |

---

## 8. 取证出处

- 本线代码：`client.js`（L14–49 视图存储 / L397–449 列表 / L563–588 DiffViewer / L595–693 终端启动器 / L698–731 tab 类型注册）、`index.js`（L110–128 `diffForFile` / L250–333 `reviewStatus` / L342–381 `parseUnifiedDiff` / L502–520 启动 / L650–688 路由）
- 本线设计：`2026-09-09-sidebar-launcher-design.md`（形态与 spike 清单）、`2026-09-10-migrate-to-official-rightbar.md`（当前形态）、`CHANGELOG.md`
- 平台契约：`../dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.5-rc1-slot-contract-2026-09-10.md`（§6.2 右栏 tab 类型 / §6.3 `ctx.layout`）
- 宿主实现（本机 0.1.5-rc.1）：
  - `@deepseek-ai/dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts`（`SidebarRightTabActions` / `sidebar.right.pane.tab.title` / `tab.signal`）
  - `@deepseek-ai/dsh-subprocess/lib/types/types.d.ts`（`SubprocessTerminalSpawnSpec` / `SubprocessTerminalHandle`，无 resize）
  - `@deepseek-ai/dsh-subprocess-local/lib/index.js`（L1028–1052 `spawnTerminal`；L1035–1036 仅 spawn 时读 rows/cols）
  - `node-pty@1.2.0-beta.15`：`package.json` 的 `install` 脚本、`scripts/prebuild.js`、`lib/utils.js:18-19` 加载顺序、`prebuilds/win32-x64/*`、`typings/node-pty.d.ts`（`resize` / `handleFlowControl`）
  - `@deepseek-ai/dsh-api-workspace-files/lib/types/client/types.d.ts`（`dsh-resource://file/...` + `WorkspaceFileParams.line`）
- 外部依据：xterm.js 官方安全指南（websocket 不享受 origin/CORS 保护、终端输出视为不可信、勿用 `innerHTML`）
