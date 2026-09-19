# 内嵌终端「标签栏多开」补充设计（sidebar 线 M3.1）

- **状态**：~~规划设计（待拍板）~~ → **2026-09-19 已按 §9 推荐项全部实施（v0.9.0-miasaki.0，待重启 `dsh web`
  实机验证）**。实施记录见 [CHANGELOG.md](CHANGELOG.md) 同日条目；本文保留为设计依据。
- **落点**：`dsh-miasaki-sidebar` 内嵌终端（底部面板 + 官方右栏 tab 两个 viewer 的那一个终端）。
- **参考图**：用户 2026-09-19 提供的 Windows Terminal 标签栏截图（本地 Windows PowerShell，见 §2 拆解）。
- **上游设计**：[2026-09-12 右栏优化规划](2026-09-12-rightbar-optimization-plan.md) §4（内嵌终端）/ §6（形态拍板）——本文**补充**其未覆盖的「多会话」维度，§4.3 的单实例纪律在本文 §4.1 被改写。
- **同族对照**：`../../dsh-miasaki-ssh/`（远程 shell，U2.1 已交付多 shell 标签栏）——本文沿用其已验证的协议形状与交互语义，细节见 §12 附表。
- **可视原型**：[2026-09-19-terminal-tabs-mockup.html](2026-09-19-terminal-tabs-mockup.html)（可交互，含决策对照）。

> **实施偏差（如实记录）**：① WS 的 `list` 帧未实现——客户端刷新恢复一律走
> `GET /sidebar/api/terminal/session`（与孤儿清理同源，少一条路径）。§5.2 帧表中的 `list` 行按此收敛。
> ② 原型里右栏形态的 `×` 与「跨容器移位」原本只能 toast（原型自身未接线）——实施时核实到官方
> `SidebarRightTabActions.close()` 与 `ctx.sidebarRight.openTab(kind)` 都可调用，已按原型的**语义**真做：
> 右栏 `×` 关闭整个右栏 tab，右键菜单「在底部 / 右栏显示此终端」做容器间移位（另补了状态条 `N/8 个会话` 计数）。
> 详见 CHANGELOG 同日「按原型对齐」条目。
> 另有两处实现细节由测试反向修正（`close()` 必须先广播后解绑；`detach()` 后必须重算最小尺寸），
> 均记录在 CHANGELOG 同日条目。
>
> **容器模型补充（2026-09-19 四次修正）**：§6.3 写的是「两个容器（底部面板 / 右栏 tab）各挂一个实例」，
> 但官方右栏的**页类型只在同一 pane 内去重**——分栏 / 浮窗还能再开一个终端标签页。故实例身份必须
> **每 mount 唯一**（`kind#N`），`active` 仍按 kind 记（同类实例共享活动项）。按 kind 键控会让第二个
> 实例把第一个顶掉（清空其标签栏 + 销毁其 xterm），已在实现中修正并加测。

---

## 0. 结论摘要

| # | 结论 | 依据 |
|---|---|---|
| 1 | 现状是**单 pty 会话 + 多 viewer**：`TerminalHub` 只持有 `this.session`，`viewers` 是无身份的 `Set<ws>`，`input` / `resize` 帧**不带会话标识**——多开的第一障碍是协议而非 UI | `index.js` L685–785 / L1041–1071 |
| 2 | 因此本次改造是**协议加维**：`attach/input/resize` 全部带 `sessionId`，广播按会话**定向**（现在是全连接广播，多开后会串台） | 同上；ssh 线 U2.1 同款教训（`app.js` L873–891） |
| 3 | 「单实例纪律」升级为**单集合纪律**：会话集合仍是 host 唯一事实源，但**两个容器各自记住自己的活动标签**（底部放构建 shell、右栏放服务器 shell 是真实需求） | §4.2；与现「同一终端在两容器移位」并不冲突（两容器指向同一会话 ⇔ 原有的移位体验） |
| 4 | 顺带修掉一个**现存缺陷**：同一会话被两个 viewer 同时 attach 时，`pty.resize` 是「最后一次获胜」，先 attach 的容器会折行错乱。改为**最小尺寸仲裁** | §5.4 |
| 5 | 标签栏本身是**纯前端新增**（`+` / `×` / 中键关闭 / 溢出滚动 / 右键菜单），host 侧只需要「多会话 + 定向广播 + 会话列表 + 显式关闭」四件事 | §5 / §6 |
| 6 | **浏览器保留键不可拦截**是硬约束：`Ctrl+T/W/N`、`Ctrl+Shift+T/W`、`Ctrl+Tab` 一律拿不到，快捷键必须重排（见 §7.3 的可拦截性矩阵），默认关闭键位留给「中键 / × / 右键菜单」 | §7.3 |
| 7 | 会话上限 **8**（对齐 ssh 线 U2.1），`sessionId` 只做**寻址**、不做授权（WS 仍走一次性 token + 三道围栏） | §5.5 / §5.6 |
| 8 | 刷新后 host 侧仍存活的 pty 会变**孤儿**（现在无任何入口能再看到它们）——本次一并给出「列出 → 一键接管 / 一键清理」的收口 | §5.5 |

---

## 1. 现状核查（代码级，2026-09-19）

### 1.1 会话模型：单实例

```js
// index.js L685–692（节选）
export class TerminalHub {
  constructor({ replayBytes = 1024 * 1024, viewers = new Set(), logger = console } = {}) {
    this.viewers = viewers   // websocket set；输出扇出用
    this.session = null      // ← 全局唯一会话
  }
```

- `ensureSession({shell, cwd, cols, rows, restart})`：单会话语义——**运行中的会话永不按新参数重 spawn**（cwd 变化只在 UI 提示），只有 `restart:true` 或会话已 `exited` 才重开（L717–723）。
- `write(data)` / `resize(cols,rows)` 都作用在 `this.session` 上（L764–772）——**没有寻址参数**。
- 回放环 `ScrollbackRing` 挂在会话对象上（L734–738），1MB 上限。

### 1.2 两个 viewer 的共享与尺寸争用（现存缺陷）

- 客户端每个 viewer = 一个 xterm + 一条 WS（`client.js` L169–204）；底部面板展开时 `attachViewer(body)`（L318–325），右栏 tab 挂载时同样 `attachViewer(el)`（L1276–1278）。
- host 对每条连接各回一次 `ready` + `replay`（L1073–1091），输出**广播到所有连接**（L753–762）。
- 结论：**两个容器同时打开时，两个 xterm 各自 fit、各自发 `resize`，后到的覆盖先到的**；窗口变窄的那一侧随后折行错乱。这是本次多开必须一并修的既有缺陷（§5.4）。

### 1.3 协议与安全

| 层 | 现状 | 出处 |
|---|---|---|
| HTTP 三道围栏 | Host 白名单 / `sec-fetch-site` / 外部 Origin（`fenceRequest`） | `index.js` L72–83、L1097–1108 |
| WS 一次性 token | `POST /sidebar/api/terminal/token` 签发、升级时消费即废（TTL 60s） | L787–806、L975–976 |
| 帧上限 | 单帧 ≤ 256KB，超出丢弃 | L1037、L1044 |
| shell 纪律 | 只报 id，绝对路径由 host `where.exe` 解析；`wt.exe` 是窗口容器，不入 PTY 表 | L617–646 |
| 输出 | 交 xterm 渲染，不拼 `innerHTML` | 规划 §4.4 |

### 1.4 测试与验收基线

- `test/terminal-hub.test.js`（7 项）：枚举纪律 / 尺寸夹紧 / 回放环 / 一次性 token / 围栏；`ensureSession` 用 **fake pty 注入**，无需真实 shell（README 用例表）。
- 浏览器侧无 DOM 单测：前端行为靠实机验证（本线既有惯例）。
- 版本基线 `0.8.1-miasaki.0`；本次多开落地后升 `0.9.0-miasaki.0`。

---

## 2. 参考图拆解 → 语义映射

参考图（920×92，深色 Windows Terminal）自左至右：

| 图中元素 | 视觉 | 语义 | 本设计对应 |
|---|---|---|---|
| `终端 PowerShell` | 灰色小字，位于标签栏最左 | 窗口**标题**（终端 + 当前 shell 名） | 标签栏左侧的**面板标题**（"终端"）+ 当前 shell 名 |
| `default` 胶囊 | 亮一档的圆角块 + 右侧 `×`，无边框 | **活动标签**（profile 名），`×` 关闭该标签 | 标签条的活动项；标题取 shell label（可重命名） |
| 右侧 `+` | 独立图标按钮 | **新建标签**（同 profile 再开一个） | 新建终端标签（默认沿用当前标签的 shell） |
| 右侧 `×` | 独立图标按钮 | 关闭窗口 | 底部面板形态 = 收起面板；右栏形态 = 关闭该 tab |
| 标签栏下方 | 终端正文，等宽灰字 | xterm 视口 | 现有 `.dsh-sidebar-term-embed-body` |

要点：**参考图的标签栏是与内容区同为深色的一整条**，活动标签用「亮一档的底 + 圆角 + 白字」表达，非活动项无底、无边框。本设计在 DSH 三主题下用 `--dsw-*` 令牌复刻这套层级（§8），不引入第二套色板。

---

## 3. 设计目标与非目标

**目标**

1. 一个容器内可同时存在 **1–8 个终端会话**，以标签栏切换，互不串台（输入 / 输出 / 尺寸 / 退出状态严格按会话隔离）。
2. 底部面板与官方右栏 tab 两个形态**共享同一会话集合**：在任一容器新建的标签，另一容器立刻可见并可接管；原有的「同一终端在两容器移位」体验不退化为回归。
3. 标签栏观感贴合参考图，且在三主题下由令牌驱动。
4. 刷新 / 重连后不产生无法回收的孤儿 pty。
5. 不新增运行时依赖（仍为 `node-pty` + `ws` + `@xterm/*`），不改官方右栏契约。

**非目标（本轮不做）**

- 标签**拖拽排序**、标签**分离到新窗口**、**分屏（split）**——官方右栏已有 `split()`，终端内部不做。
- SSH / 远程 shell（属 ssh 线）、串口、容器内 shell。
- 标签内命令历史、shell integration（OSC 133）、会话录制。
- 跨会话（DSH session）共享 PTY 集合：本集合的生命周期仍绑 `dsh web` 进程，不随会话切换重置。

---

## 4. 核心模型

### 4.1 会话集合（host 唯一事实源）

```
TerminalHub
├── sessions: Map<sessionId, Session>     // 上限 8，LRU 不适用（用户显式关闭）
└── viewers:  Map<ws, ViewerBinding>      // 每条 WS 绑定「一个会话 + 该 viewer 的尺寸」
```

```js
Session = {
  id, shell, bin, cwd, pid,
  ring: ScrollbackRing,          // 每会话独立 1MB 回放环
  pty, exited, exitCode,
  createdAt,
  viewers: Map<ws, { cols, rows }>,   // 该会话的 viewer 及其尺寸（尺寸仲裁用，§5.4）
}
```

**纪律变更（相对 §4.3 旧文）**：旧文写「会话在 host 侧保活，viewer 消失不杀会话」——**保持**；新增的是「会话可以有多个，且每个会话的保活与回收彼此独立」。`restart` 语义不变，但**作用域收窄到单个 sessionId**。

### 4.2 活动标签归属：**每容器独立**（推荐，待拍板 §9-1）

| 方案 | 行为 | 评价 |
|---|---|---|
| **A. 每容器独立活动项**（推荐） | 会话集合全局共享；底部面板与右栏 tab 各记各的 `activeId` | 底部放 `npm run dev`、右栏放 `git`/服务器 shell 是真实用法；两个容器可同时盯两个不同会话 |
| B. 全局共享活动项 | 切容器时活动标签跟着走 | 更接近「同一个终端移位」，但两个容器无法同时看两个会话，多开价值减半 |
| C. 各自独立会话集合 | 容器间不共享 | 直接违反「同一 pty 会话的两个 viewer」既定契约，放弃 |

选 A 后，「同一终端在两容器移位」= 把另一个容器的活动项指向同一 `sessionId`（现 UI 的「在底部打开 ↧」按钮保留，语义变为「底部打开这个会话」）。

### 4.3 标签元数据与标题

```js
Tab = {
  id,                 // = sessionId（host 生成 UUID，仅寻址）
  shell, shellLabel,  // 'pwsh' / 'PowerShell 7'
  cwd,                // spawn 时的目录（不随 DSH 会话切换而变）
  title,              // 用户可见名；默认 shellLabel，重名追加 ' (2)'
  live,               // 进程是否存活（exited=false）
  exited, exitCode,
}
```

- **默认标题**：`shellLabel`；同名第 N 个追加序号（`PowerShell 7 (2)`）。
- **重命名**：双击标签进入行内编辑（参考图未画，但多开下必需），空串回退默认名；仅前端记忆（sessionStorage），不入 host。
- **可选增强（P2，默认关）**：接 xterm `onTitleChange`（OSC 0/2），跑 `vim` / `ssh` 时显示远端标题——必须**转义 + 截断 40 字符**（§5.6 输出不可信纪律），且要有开关，避免把不可信字符串写进 UI。

---

## 5. Host 半改造（`index.js`）

### 5.1 `TerminalHub` → 多会话

| 成员 | 现在 | 改造后 |
|---|---|---|
| `session` | 单对象 | `sessions: Map` |
| `viewers` | `Set<ws>`（无身份） | `Map<ws, { sessionId, cols, rows }>` |
| `ensureSession` | 无 id，复用 `this.session` | 签名加 `sessionId?`：给了就定位，没给就**新建**（受 §5.5 上限约束） |
| `broadcast` | 全连接扇出 | `broadcastTo(sessionId, frame)`，只发给绑定该会话的连接 |
| `write` / `resize` | 全局 | 带 `sessionId` 定位；未知 id 静默丢弃（不抛，防被当作探测面） |
| `kill` | 杀唯一会话 | `close(sessionId)`：kill + 摘 ring + 解除所有 viewer 绑定 + 广播 `closed`；`dispose()` 遍历全部 |
| 新增 | — | `list()`（给前端做恢复/接管）、`create()`、`attach(ws, sessionId, cols, rows)`、`detach(ws)`、`arbitrateSize(sessionId)` |

**兼容性**：无 `sessionId` 的 `attach` 保留「新建并返回 id」语义，但**旧客户端帧（无 `v`）一律拒收并提示刷新**（对齐 ssh 线 U2.1 的 `VERSION_MISMATCH` 纪律，不做双栈）。

### 5.2 帧协议 v2

```jsonc
// Client → Host（全部带 v:2）
{ "v":2, "type":"attach", "sessionId":null|"<uuid>", "shell":"pwsh", "cwd":"C:\\...",
  "cols":120, "rows":30, "restart":false }
{ "v":2, "type":"input",  "sessionId":"<uuid>", "data":"ls\r" }
{ "v":2, "type":"resize", "sessionId":"<uuid>", "cols":120, "rows":30 }
{ "v":2, "type":"close",  "sessionId":"<uuid>" }        // 关标签 = 结束该 shell（§7.1）
```
（设计稿原有 `{ "type":"list" }` 一行：**实施时未做**，会话清单改由
`GET /sidebar/api/terminal/session` 提供——刷新恢复与孤儿清理同源，少一条 WS 路径。）

// Host → Client（全部带 v:2 与 sessionId）
{ "v":2, "type":"ready",   "sessionId":"<uuid>", "shell":"pwsh", "bin":"C:\\...\\pwsh.exe",
  "pid":1234, "cwd":"C:\\...", "spawned":true, "cols":120, "rows":30 }
{ "v":2, "type":"replay",  "sessionId":"<uuid>", "data":"..." }
{ "v":2, "type":"output",  "sessionId":"<uuid>", "data":"..." }
{ "v":2, "type":"status",  "sessionId":"<uuid>", "state":"exited", "code":0 }
{ "v":2, "type":"closed",  "sessionId":"<uuid>", "reason":"user|exited|reaped" }
{ "v":2, "type":"sessions","items":[ { "id":"...", "shell":"pwsh", "cwd":"...", "pid":1,
  "state":"running|exited", "viewers":1 } ] }
{ "v":2, "type":"error",   "sessionId":null|"<uuid>", "code":"SHELL_MISSING|CWD_INVALID|PTY_FAILED|LIMIT|VERSION_MISMATCH",
  "message":"..." }
```

**为什么 `input`/`resize` 必须带 `sessionId`**：现在它们不带，是因为只有一个会话；多开后不带就是 ssh 线 U2.1 实机逮到的「多 shell 串台」同一类缺陷（键控失效 ⇒ 输入写进别的 shell）。这条是本次改造的**第一红线**。

### 5.3 与会话相关的路由

| 路由 | 方法 | 现状 | 改造 |
|---|---|---|---|
| `/sidebar/api/terminal/options` | GET | 启动器 + PTY shell 可用性 | 不变（客户端仍用它挑默认 shell） |
| `/sidebar/api/terminal/token` | POST | 签发一次性 WS token | 不变（token **不绑会话**，只证明「本页合法」，避免把 id 当授权） |
| `/sidebar/api/terminal/open` | POST | spawn 系统终端窗口 | 不变 |
| `/sidebar/api/terminal/session` | GET | 单会话状态 | **扩展**为 `{ sessions: [...], limit: 8 }`（旧字段 `session` 保留一个版本，便于灰度） |
| `/sidebar/api/terminal/close` | POST | — | **新增**：`{ sessionId }` → 结束指定会话（HTTP 侧兜底，主路径走 WS `close` 帧） |

### 5.4 尺寸仲裁：**最小尺寸优先**（待拍板 §9-2）

同一会话被 N 个 viewer attach（底部面板 + 右栏 tab 同时打开同一标签）时，pty 只能有一个 `cols/rows`：

```
pty.cols = min(viewer.cols for viewer in session.viewers)   // 同理 rows
```

- 触发点：`attach` 后、每次 `resize` 后；**结果与当前 pty 尺寸不同才真正调用** `pty.resize()`（避免抖动）。
- 理由：取最小保证**没有任何一个 viewer 出现折行错乱**（另一侧只是右侧留白）；取最大则窄的那侧必然错乱，取「最近一次」则两侧都可能错乱。
- 单 viewer 时退化为「就是它自己的尺寸」，与现状一致。

### 5.5 生命周期、上限与回收

| 事件 | 行为 |
|---|---|
| 新建标签 | `ensureSession` 无 id 分支 → `resolvePtyBin` + `assertDirectory` + spawn；超过 **8** 个返回 `error.code=LIMIT`，前端提示并可关闭旧标签后重试 |
| 会话退出 | 标记 `exited` + 广播 `status`；**ring 与会话对象保留**（供「重启」与回看输出），直到用户关标签 |
| 关标签（`close` 帧 / `×` / 中键） | `kill` + 广播 `closed`；**已 exited 的会话直接摘除**（无进程可杀） |
| viewer 消失（面板收起 / 切 tab / 断线） | 只解除绑定，**不杀会话**（沿用旧 §4.3） |
| 刷新页面 | 客户端首帧发 `list`；host 回存活会话清单 → 前端恢复标签条（`live` 标记），用户点选接管；提供「全部关闭」收口孤儿 |
| 插件 dispose（`ctx.effect` 清理） | 遍历 `sessions` 全部 kill（现在只 kill `this.session`，多开后必须遍历） |

**孤儿会话口径**：host 侧存活但无任何 viewer 绑定的会话，**不自动回收**（用户可能只是切走了容器），仅通过 `list` 暴露给前端，由用户显式接管或关闭。

### 5.6 安全边界（沿用 + 新增）

沿用（全部保持现状）：三道 HTTP 围栏、一次性 WS token、单帧 256KB 上限、shell 枚举 + 绝对路径解析、`cwd` 必须存在且为目录、输出交 xterm。

新增：

1. **`sessionId` 只寻址不授权**：未知 / 过期 id 的 `input`/`resize` 静默丢弃；`close` 对未知 id 幂等成功（避免用错误码当存在性探针）。WS 建立时仍只认一次性 token。
2. **数量上限即拒绝服务防线**：`LIMIT` 在 host 侧强制，客户端 UI 只是提示。
3. **不新增任何「按 id 直接杀进程」的 HTTP 入口**：`/terminal/close` 走同一套围栏 + JSON body 校验。
4. **标题类字符串不可信**（若启用 OSC 标题增强）：转义 + 截断，绝不进 `innerHTML`。

---

## 6. Client 半改造（`client.js`）

### 6.1 `terminalClient` → 会话集合 + 每容器活动项

```js
terminalClient = {
  sessions: Map<sessionId, {                    // 前端镜像（真实状态在 host）
    id, shell, shellLabel, cwd, title, live, exited, exitCode,
    xterm: null|Terminal, fit: null|FitAddon, ws: null|WebSocket,
    el: null|HTMLElement, mounted: false, reconnectTimer, disposed,
  }>,
  order: [sessionId, ...],                      // 标签顺序（新建追加；重命名/关闭就地更新）
  active: { bottom: sessionId|null, right: sessionId|null },   // 每容器独立（§4.2）
  listeners, assetsPromise,
  _snapshot: { tabs: [...], active: {...}, lastError },        // 仍是稳定引用（L91–106 的教训）
}
```

- **快照稳定性红线保留**：`useSyncExternalStore` 的 getSnapshot 必须返回缓存引用，`emit()` 内重建（2026-09-12「终端空白」根因，`client.js` L91–96 注释）。多开后快照含 `tabs` 数组 → 每次 `emit()` 新建数组即可，但**不得在 getSnapshot 里计算**。
- `pendingRestart` / `wantedShell` 的全局语义收敛：`wantedShell` 变成「**新建标签时的默认 shell**」，`requestRestart` 改为 `restart(sessionId)`。

### 6.2 xterm 实例池：每标签一实例一 WS（推荐，待拍板 §9-4）

| 方案 | 切换开销 | 内存 | 滚动位置 | 评价 |
|---|---|---|---|---|
| **A. 常驻池 + 懒挂载**（推荐） | 瞬时（仅 CSS 切换） | 每标签一个 xterm（scrollback 5000 行） | 保留 | VS Code 同款；8 标签量级内存可控 |
| B. 单实例复用 | 每次切换清屏 + 重放 | 最低 | 丢失 | 切换有明显闪烁；回放环 1MB 重放有卡顿风险 |
| C. 常驻池但非活动标签释放 xterm | 中 | 中 | 丢失 | 复杂度高于收益 |

方案 A 细节：

- **懒挂载**：首次成为活动标签时才 `new Terminal()` + `attachViewer`（避免一次开 8 个实例）；已挂载的实例在容器切换 / 标签切换时保留 DOM（`display:none`），**不 dispose**。
- **零尺寸守卫**：`display:none` 时 `ResizeObserver` 会报 0 尺寸——`fit()` 必须在 `el.clientWidth === 0 || el.clientHeight === 0` 时跳过；激活瞬间再 `fit()` + 发一次 `resize` 帧（现有 `try/catch` 兜底保留，再加显式守卫）。
- **每标签一条 WS**：沿用现有「一 viewer 一连接」形状，`attach` 带自己的 `sessionId`；断线 1.5s 退避重连（现有 L258–269）按标签各自进行。
- **DOM 池**：容器（底部面板 / 右栏 tab）内一个栈式容器，每个标签一个 `<div class="…-pane">`，活动项 `display:block`，其余 `display:none`。

### 6.3 标签栏组件（两容器复用）

一个纯 DOM 组件（底部面板是命令式 DOM；右栏 tab 是 React，但标签栏两者共用同一实现，避免两套行为漂移）：

```html
<div class="miasaki-term-tabs" role="tablist">
  <span class="miasaki-term-tabs-title">终端</span>          <!-- 参考图左标题 -->
  <div class="miasaki-term-tabs-strip">                      <!-- 可横向滚动 -->
    <button class="miasaki-term-tab is-active" role="tab" aria-selected="true">
      <span class="miasaki-term-tab-label">PowerShell 7</span>
      <span class="miasaki-term-tab-close" role="button" aria-label="关闭">×</span>
    </button>
    …
  </div>
  <button class="miasaki-term-tabs-add" aria-label="新建终端标签">＋</button>
  <button class="miasaki-term-tabs-more" aria-label="所有标签">▾</button>
</div>
```

- 键盘可达性：`role="tablist"` + 左右方向键移动、`Delete` 关闭、`Enter` 激活（对齐 WCAG，见 §7.3）。
- 右栏 tab 形态下，`TerminalTab`（`client.js` L1299–1424）现有头部（工作目录行 + shell 胶囊）**收进「设置/更多」折叠区**，主视图让位给标签栏 + xterm；`TerminalView`（L1270–1295）改造成「多 pane 容器」。

### 6.4 状态条 / 空态 / 退出态

| 状态 | 表现 |
|---|---|
| 空态（0 个标签） | 标签栏只剩标题 + `＋`；正文区显示「＋ 新建终端」大按钮与当前 cwd（右栏形态）；底部面板空态保留面板（用户可能立刻开新的），但可一键收起 |
| 会话已退出 | 该标签左侧加状态点（`--dsw-alias-state-error-primary`）；正文保留最后输出 + 「已退出（code N）」与 `[重启]`（现有 L1388–1398 语义平移为**按标签**） |
| 连接中 / 错误 | 标签内联小字（现有 `lastError` 语义按标签拆分）；`LIMIT` 提示「已达 8 个上限，关闭一个再新建」 |
| 工作区变更 | 每个标签各自比对 `session.cwd` 与当前 `reviewCwd`；不一致的标签在 tooltip 与状态条提示，**不自动重启**（红线延续） |

---

## 7. 交互规范

### 7.1 新建 / 关闭 / 切换 / 重命名

| 动作 | 触发 | 语义 |
|---|---|---|
| 新建 | 标签栏 `＋` / `Ctrl+Shift+`` / 右键菜单「新建标签」 | 以**当前标签的 shell**（无标签时用 `options.fallback`）在 `reviewCwd` spawn；超出上限 → 提示 |
| 关闭 | 标签内 `×` / 中键点击标签 / `Delete`（焦点在标签上）/ 右键菜单「关闭」 | **结束该 shell**（kill pty）。本地终端不存在「仅关闭查看」的第三种选择：host 侧没有再次看到该 pty 的入口，保留即是泄漏 |
| 关闭全部 / 关闭其他 | 右键菜单 | 标签数 > 1 时先确认（对齐 Windows Terminal `confirmCloseAllTabs` 的默认行为） |
| 切换 | 点击标签 / `Ctrl+PageUp`·`Ctrl+PageDown` / `Alt+1..8` / `▾` 下拉 | 只改该容器的活动项；不重建 xterm（§6.2） |
| 重命名 | 双击标签 / 右键菜单「重命名」 | 行内编辑；空串回退默认名；写入 sessionStorage（仅前端） |
| 移位 | 「在底部打开」/ 右栏打开该会话 | 另一容器活动项指向同一 `sessionId`（§4.2） |

### 7.2 溢出与窄栏

- 标签最小宽度 **96px**、最大 **200px**（超出省略号 + tooltip 显示完整标题与 cwd）。
- 宽度不足时条内**横向滚动**（隐藏滚动条；`Shift+滚轮` / 触控板横滑 / 中键拖拽）。
- 始终保留尾部 `＋` 与 `▾`；`▾` 下拉列出全部标签（含 `pid` / `cwd` / 状态），窄栏下的主入口。

### 7.3 键盘：浏览器保留键的可拦截性矩阵（**硬约束**）

| 候选键 | 浏览器行为 | 能否拦截 | 采用 |
|---|---|---|---|
| `Ctrl+T` / `Ctrl+W` / `Ctrl+N` | 新标签 / 关标签 / 新窗口 | ❌ | 不用 |
| `Ctrl+Shift+T` / `Ctrl+Shift+W` | 恢复关闭的标签页 / 关闭窗口 | ❌（Windows Terminal 的默认值，浏览器内不可用） | 不用 |
| `Ctrl+Tab` / `Ctrl+1..9` | 切换浏览器标签 | ❌ | 不用 |
| `Ctrl+`` | 无（本插件已用：切换底部面板） | ✅ | 保留现状 |
| `Ctrl+Shift+`` | 无 | ✅ | **新建标签**（VS Code 同键） |
| `Ctrl+PageDown` / `Ctrl+PageUp` | 无 | ✅ | **下一个 / 上一个标签**（VS Code 同键） |
| `Alt+1..8` | 无（部分扩展占用） | ✅ | **跳到第 N 个标签** |
| `Delete`（焦点在标签上） | 无 | ✅ | 关闭标签（键盘可达） |
| `F2`（焦点在标签上） | 无 | ✅ | 重命名 |

拦截方式沿用现有热键实现（`document.addEventListener('keydown', handler, true)` 捕获阶段，`client.js` L1501–1509），并需在 xterm 聚焦时同样生效（捕获阶段先于 xterm 的 textarea 监听）。

### 7.4 右键菜单

复用现有轻量 popover（`dsh-sidebar-popover` / `dsh-sidebar-menuitem`，L466–524）：新建 / 关闭 / 关闭其他 / 关闭全部 / 重命名 / 复制 cwd / 重启 / 在底部打开（或右栏打开）。

---

## 8. 视觉规范（令牌化，三主题）

| 元素 | 令牌 | 参考图对应 |
|---|---|---|
| 标签栏底 | `--dsw-alias-bg-layer-2` | 比内容区亮一档的整条 |
| 活动标签底 | `--dsw-alias-bg-layer-1` + 1px `--dsw-alias-border-l2` | 亮块胶囊（图中 `default`） |
| 活动标签文字 | `--dsw-alias-label-primary` | 白字 |
| 非活动标签文字 | `--dsw-alias-label-secondary`，hover 时升为 primary + 底 `--dsw-alias-bg-layer-3` | 无底灰字 |
| 标题「终端」 | `--dsw-alias-label-tertiary` | 图中左侧 `终端 PowerShell` |
| 关闭 / 新建图标 | `--dsw-alias-label-secondary`，hover `--dsw-alias-state-error-primary`（关闭）/ `--dsw-alias-label-primary`（新建） | 右侧 `+` `×` |
| 活动标签下沿高亮（可选） | 2px `--dsw-static-deepseek-450` | 参考图无，DSH 侧增强，可关 |

- **高度**：标签栏 **32px**（对齐参考图比例）；底部面板总高不变（默认 320px，最矮 180px ⇒ 正文可用 ≥ 145px，约 7 行 × 20px，可接受）。
- **圆角**：活动标签 6px（贴合参考图的胶囊感），与 canvas 线 V1 的圆润化令牌保持一致。
- **字号**：12px / 行高 18px（复用 `--dsw-font-xxs-12`）。
- 三主题（浅 / 深 / 跟随）下不得出现硬编码色值——xterm 主题仍走 `getComputedStyle` 读令牌（现有 `theme()`，L133–147）。

---

## 9. 待拍板决策点

| # | 决策 | 推荐 | 备选与代价 |
|---|---|---|---|
| 1 | 活动标签归属 | **每容器独立**（§4.2 A） | 全局共享（多开价值减半）/ 各自独立集合（违反既定契约） |
| 2 | 尺寸争用 | **最小尺寸优先**（§5.4） | 最近一次获胜（现状，两侧都可能错乱） |
| 3 | 关闭语义 | **直接 kill，不二次确认**；仅「关闭全部 / 其他」在 >1 标签时确认 | 每个都确认（多开下极烦）；仿 ssh 线三选一（本地终端无「保留会话」的意义） |
| 4 | xterm 实例策略 | **常驻池 + 懒挂载**（§6.2 A） | 单实例复用（切换闪烁、丢滚动位置） |
| 5 | 快捷键集合 | **§7.3 矩阵**（`Ctrl+Shift+`` 新建 / `Ctrl+PageUp·PageDown` 切换 / `Alt+1..8` 跳转 / 关闭交给 `×`·中键·`Delete`） | 强行用 `Ctrl+Shift+T/W`（浏览器保留，拿不到） |
| 6 | 会话上限 | **8**（对齐 ssh 线 U2.1） | 4（省内存）/ 无限（无上限即 DoS 面） |
| 7 | 刷新后孤儿会话 | **`list` 列出 → 用户接管 / 一键关闭**（§5.5） | 静默 kill（丢用户正在跑的进程）/ 静默自动 attach（不可预期） |
| 8 | 标签标题 | **默认 shell label + 序号**；OSC 动态标题为 P2 可选项、默认关 | 默认开 OSC 标题（不可信字符串进 UI，需转义 + 截断） |
| 9 | 旧协议兼容（无 `v` 的帧） | **拒收 + 提示刷新**（对齐 ssh 线 `VERSION_MISMATCH`，不做双栈） | 双栈（长期负担） |

---

## 10. 分阶段落地与验收

| 阶段 | 内容 | 验收判据 | 量级 |
|---|---|---|---|
| **P0 协议加维（host）** | `TerminalHub` 多会话化 + 定向广播 + 帧 v2 + `list` / `close` + 上限 + dispose 遍历 + 最小尺寸仲裁 | 单测：会话隔离 / 定向广播 / 未知 id 静默丢弃 / 上限拒绝 / 关闭回收 / 尺寸取最小 / 旧帧拒收（≈ +12 例） | 0.5–1 天 |
| **P1 标签栏（前端）** | 会话集合镜像 + 标签栏组件 + 空态/退出态 + 溢出与 `▾` + 右键菜单 + 每容器活动项 | 实机：同容器开 8 个标签互不串台；底部与右栏各看一个会话；窗口缩放两侧不错乱 | 1–1.5 天 |
| **P2 无障碍与恢复** | 键盘矩阵 + `role=tablist` 焦点管理 + sessionStorage 记忆 + 刷新后 `list` 接管 / 一键清理孤儿 | 实机：全键盘可达；刷新后标签条恢复并可接管；无孤儿残留（`tasklist` 核对 pwsh 数量） | 0.5–1 天 |
| **P3 可选增强** | OSC 标题（默认关）/ 活动标签高亮条 / 标签拖拽排序 | 按需 | — |

每阶段完成同步 `README.md` 与 `design/CHANGELOG.md`，新增用例计入 `test/terminal-hub.test.js`，并把本机 `dsh web` 重启后的实机验证结果登记进 CHANGELOG。

**回归红线（不得回退）**

1. 审查 tab 与外部启动器不受终端改造影响（node-pty / ws 惰性加载的降级路径保持：依赖缺失 ⇒ 只有内嵌终端不可用）。
2. 「会话退出不自动重启」「DSH 会话切换不自动重启终端」两条既有纪律保持。
3. WS 鉴权仍是「三道围栏 + 一次性 token」；`sessionId` 永不作为授权凭据。
4. 三主题下 xterm 与标签栏配色均由令牌驱动，无硬编码第二套色。

---

## 11. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 帧协议加维破坏现有单会话路径 | 终端整体不可用 | v2 一次性切换 + 旧帧 `VERSION_MISMATCH` 明确提示刷新；host 侧 `ensureSession` 无 id 分支保持「新建」语义 |
| 8 个 pty 的资源占用 | 内存 / 句柄压力 | 上限 8 + 空态不预 spawn + 关闭即回收；xterm 懒挂载 |
| 两容器同看一会话的尺寸抖动 | 反复 `resize` 引发 TUI 重排 | 最小尺寸仲裁 + 「结果变化才调用 `resize`」 |
| 隐藏 pane 的 `fit()` 报零尺寸 | 抛错 / 尺寸错乱 | 显式零尺寸守卫 + 激活时重 fit（§6.2） |
| React 快照引用不稳定 | 终端子树被卸载（2026-09-12 旧症） | `_snapshot` 缓存引用纪律写入代码注释 + 回归检查项 |
| 标签栏吃掉底部面板高度 | 窄面板正文只剩几行 | 32px 固定高 + 最矮 180px 约束 + mockup 内实测 |
| 官方右栏契约变动 | tab 正文渲染方式需跟随 | 只用公开面（tab 类型 / `tab.signal` / `tab.visible`），标签栏自持 DOM |

---

## 12. 取证出处

**本线代码**（行号为 2026-09-19 状态）

- `index.js`：`PTY_SHELLS` L617–628、`resolvePtyBin` L636–646、`clampPtySize` L649–653、`ScrollbackRing` L656–677、`TerminalHub` L685–785、`createTokenGate` L787–806、终端路由 L962–980、`wireEmbeddedTerminal` L1021–1116（WS 连接 L1041–1071 / `ensureAttached` L1073–1091 / 升级门 L1098–1108 / 生命周期 L1110–1115）
- `client.js`：`terminalClient` L80–298（`attachViewer` L169–204 / `connectViewer` L206–271 / `requestRestart` L274–290）、`bottomPanel` L301–407、`titlebarButton` L410–531、`TerminalView` L1270–1295、`TerminalTab` L1299–1424、tab 注册 L1464–1469、热键与清理 L1501–1525
- `test/terminal-hub.test.js`：L1–70（纯函数 + 围栏用例形状）、L71–190（fake pty 注入）

**本线设计**

- [2026-09-12-rightbar-optimization-plan.md](2026-09-12-rightbar-optimization-plan.md) §4（内嵌终端）/ §4.3（帧协议与生命周期）/ §4.4（安全四道）/ §6（形态与路线拍板）
- [CHANGELOG.md](CHANGELOG.md)、[../README.md](../README.md)（特性表与用例表）

**同族对照（ssh 线）**

- [../../dsh-miasaki-ssh/README.md](../../dsh-miasaki-ssh/README.md) L80（U2.1 多 shell：三层身份 / 8 上限 / 一次性 30s 票据 / 写入所有权 / 关闭三选一）
- `../../dsh-miasaki-ssh/app.js` L873–891（标签结构化与「按 tabIndex 定位」的串台教训）、L1310–1361（关闭对话框三选一）、L2022–2042（刷新恢复只恢复形状、不自动连接）

---

## 附：与 ssh 线的对齐表

| 维度 | ssh 线（U2.1 已交付） | 本设计（sidebar 本地终端） | 是否一致 |
|---|---|---|---|
| 会话键控 | `connId → runtimeId → shellId` 三层 | `sessionId` 一层（无连接层） | 形状一致，层级按需简化 |
| 上限 | 8 shell / 连接 | 8 会话 / 进程 | ✅ |
| 定向广播 | `ShellChannel` 独立 stream / 回放环 | `Session` 独立 ring + `broadcastTo` | ✅ |
| 输入归属 | 单写多读 + 显式接管 | 本地终端无「写权」概念（同一用户），不引入接管 | 差异（有意） |
| 新建标签 | 标签栏 `+` | 标签栏 `＋` / `Ctrl+Shift+`` | ✅ |
| 关闭语义 | 三选一（仅关闭查看 / 关闭此 shell / 断开连接） | 直接 kill（本地终端无「保留会话」意义） | 差异（有意） |
| 刷新恢复 | sessionStorage 形状 + 不自动连接 | sessionStorage + `list` 接管存活 pty | ✅（本地更强：可直接接管） |
| 版本不匹配 | `VERSION_MISMATCH` 拒收，不做双栈 | 同 | ✅ |
| 视觉 | 令牌化标签栏 | 同套令牌与 32px 高、6px 圆角 | ✅ |
