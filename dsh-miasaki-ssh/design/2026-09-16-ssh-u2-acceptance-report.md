# SSH 线 U2 实机验收报告（2026-09-16）

> 验收对象：U2.1 多 shell / U2.3 工作区记忆 / U2.4 精确恢复（提交 `e08d3bc`，单测 110 例、`verify-all ssh` 12/12）。
> 验收通道：真 Edge（headless=new）× **真实 DSH GUI**（真宿主 + 真插件 + 真桌面壳注入）× 真实鼠标/键盘（走 hit-test）× 本地假 sshd（真 SSH 协议、多 shell channel）。
> 驱动归档：`_refs/scripts-archive/ssh-u2-accept/`（`run-u2-accept.mjs` / `run-u2-tui.mjs` / `diag-tofu.mjs` / `fake-sshd-u2.mjs` + 结果 JSON + 截图）。
>
> ## 结论（一句话）
>
> **U2 的自动化闸门全绿，但实机验收在「首次连接」这一步就被挡住：验收共发现 4 处真实缺陷（2 处阻断级、1 处高危、1 处中危），已全部定位并修复（含 3 条新增回归断言），单测 110 → 113、`verify-all ssh` 12/12。修复与 U2.4 的 addon 都需要重启 `dsh web` 才生效 ⇒ 实机复验待重启后进行。**

## 1. 验收矩阵与本轮判定

| 项 | 门槛（U2 规划 §7） | 判定 | 证据 |
|---|---|---|---|
| 自动化 | 单测全绿 + `verify-all ssh` 12/12 | **PASS** | 110 → **113/113**（修复后新增 3 例）；`12/12` |
| 运行态核查 | 运行宿主加载的确实是 U2 代码 | **PASS（含一处发现）** | 前端三资产与磁盘 **SHA256 逐字节一致**；host 半为 U2（`/ssh/api/attach` 命中 U2 分支的 404 文案） |
| U2.4 通道 | 官方 addon 上线 | **FAIL（环境性）** | `/ssh/vendor/addon-serialize.js` 返回 **79 字节占位脚本** ⇒ 精确恢复降级为回放（见 §3） |
| A1/A2 多 shell 互不串台 | 逐标签输入按 channel 精确路由 | **FAIL → 已修** | sshd 实测三次输入**全部落在 ch-1**（`inputChannels [1,1,1]`）—— 见 §4 U2-C |
| A3 每 shell 独立尺寸 | 尺寸 per-shell 下发 | **未判定** | 首轮夹具缺陷（pty 事件早于 shell，channel 归属丢失）已修，待复验 |
| A4 写入所有权 | 单写多读 + 接管互斥 | **主判据 PASS** | 第二窗口只读条在场、原 owner 保持可写、**零新 TCP 连接**；接管后原 owner 转只读、新 owner 输入送达远端 |
| A6 关闭语义 | 关闭此 shell ≠ 断开连接 | **未判定** | 「关闭此 shell」按钮缺席（U2-C 的连锁），对话框遮挡导致后续输入未达远端 —— 驱动侧已修，待复验 |
| C1 工作区记忆 | 刷新恢复形状 + **零自动连接** | **半 PASS** | 标签数量恢复、`tcp-connect`/`shell` 事件**零增长** ✅；但恢复后的标签集合错乱（`[#3,#2,#3]`，缺 `#1`）—— U2-C 连锁 |
| C4 记忆损坏降级 | 不白屏 | **PASS** | 写入 `{oops not json` 后刷新：rail/工作区俱在、标签回默认 0、无异常 |
| A5 8 shell 上限 | 第 9 个被拒 + 可读提示 | **未判定** | 驱动未先把 selection 归位 ⇒ `+` 退化为打开导航；已修待复验 |
| D2 三主题回归 | 三主题下浮层顶栏稳定 | **未执行** | 排在连接可用的后续阶段（重启后一并跑） |
| D3 旧帧拒绝 | 明确提示刷新、不静默错乱 | **PASS** | 页面内发无 `v` 的旧帧 → 收到 `VERSION_MISMATCH`「SSH 插件已升级，请刷新页面后继续」 |
| U2.4 判据 | 刷新后 vim/top 逐行 + 光标一致（3 轮） | **未执行** | 依赖 addon 上线（重启）+ 连接可用 |

**通过 6 项 / 失败或未判定 8 项 —— 全部失败项都已定位到根因，其中 4 项是产品缺陷（已修），4 项是验收夹具自身缺陷（已修）。**

## 2. 阻断现象与最小复现（`diag-tofu.mjs`）

首轮实机驱动在 P0（建立连接）即失败，截图与时间序列取证如下：

- 界面状态：标签在场、终端空白、状态栏「**指纹待确认**」、横幅「**shell 已关闭或绑定失效，请重新打开该标签**」+ 仅「编辑主机 / 重新连接」两个按钮。
- 采样（每 300ms，共 45s）：**「核对指纹」按钮从未出现**（`sawFingerprintButton=false`）；横幅在**第 3 个采样点（约 1.2s）**就已是 `STALE_SHELL` 文案。
- 远端：`tcp-connect=1 / auth-ok=0 / shell=0` —— SSH 握手停在 `hostVerifier`（等指纹确认），**认证都没开始**。
- host 侧：`state=waiting-fingerprint, shells=0`。

⇒ **首次连接一台新主机时，用户没有任何可用入口完成 TOFU 指纹确认。**

## 3. 运行态核查（与磁盘逐字节比对）

| 资产 | 运行态 | 磁盘 | 判定 |
|---|---|---|---|
| `/ssh/session.js` | 22647B · `6FF20BC8…` | 同 | **一致** |
| `/ssh/app.js` | 89197B · `1699CE06…` | 同 | **一致** |
| `/ssh/styles.css` | 21672B · `086AC645…` | 同 | **一致** |
| `/ssh/vendor/addon-serialize.js` | **79B（占位脚本）** | 包本体 16441B | **不一致** |

- host 半确认加载的是 U2：`POST /ssh/api/attach`（合法 uuid 但无该连接）返回 `{"error":"连接不存在或未在运行"}` —— 这是 U2 的 attach 分支文案，旧版会落到通用 `接口不存在`。
- **addon 未上线的根因是启动时序**：`dsh web` 于 **12:52:17** 启动，而 `@xterm/addon-serialize` 于 **12:57:17** 才装进 `node_modules`；`index.js` 的 `hasSerializeAddon` 是 **apply 时判定一次** ⇒ 运行态回占位脚本 ⇒ 前端静默降级为回放恢复。
  **这项不是代码缺陷，但它意味着 U2.4 在本次验收中根本没有上线** —— 重启即解（验收包 §5 已写明必须重启，此处给出的是实测证据）。

## 4. 缺陷登记与修复

### U2-A（阻断）· 首连的指纹确认入口被 `STALE_SHELL` 覆盖

- **因果链**：连接处于 `waiting-fingerprint`（无任何 shell）时，viewer 依 U0 契约就已 attach（「待指纹主机的主动作是打开终端，只 attach」）→ `term.onResize` 与 `term.onData` **无条件**发帧（`shellId=null`）→ host `currentShell()` 判 `rc.shells.get(null) === undefined` → 回 `STALE_SHELL` → 前端 `onStatus('error')` → `handleSessionStatus` 把它写成 `frameState` → **横幅被错误覆盖**，`renderBanner` 的 `waiting-fingerprint` 分支（唯一带「核对指纹」按钮的分支）不再有机会渲染。
- **旁证**：状态栏的「指纹待确认」按钮 onclick 是 `trustListSheet()`（打开**信任记录列表**，此时列表为空），**不是确认入口** ⇒ 用户确实无路可走。
- **修复**（`session.js`）：未绑定 shell 时**不发** input/resize；绑定后由新增的 `syncSize()` 补发一次真实尺寸（U0 契约「attach 初始尺寸送真实 PTY」不丢）。
- **回归断言**（`test/session.test.js`）：改写 `outgoing input/resize carry v:2 + shellId` → 未绑定阶段**零发帧**、绑定后 `syncSize` 补发、其后 clamp 与 `shellId` 语义不变。

### U2-B（阻断）· 连接就绪时不补绑已 attach 的 viewer

- **因果链**：`onReady()` 建好主 shell 后只做 `rc.broadcast({ type:'ready', state:'connected', runtimeId, shells })` —— **不带 `shellId`，也没有把已 attach 的 viewer 绑到该 shell**。等待指纹期间 attach 的 viewer 于是永远停在 `shellId=null`：指纹确认通过、连接建立，前端却拿不到绑定 ⇒ 之后每一帧仍被拒。
- **实测旁证**：驱动在 P0 后**手动点一次标签重挂**（此时 shell 已存在，走全新 attach）才拿到绑定，终端随即有内容（`rows=43`）—— 正是本条的表现。
- **修复**（`lib/runtime.js` `onReady`）：主 shell 建好后遍历 `rc.sockets`，对**尚未绑定 shell** 的 viewer 调 `bindShell()` 并逐发带 `shellId / mode` 的 `ready`（已绑定别的 shell 的 viewer 只收状态，不动其绑定）。
- **回归断言**（`test/runtime.test.js` 新增）：等待指纹期 attach → `ready.shellId === null`；`onReady` 后 → 收到带 `shellId` 的 `ready`、`ws.shellId` 同步、写权归位、此后 `input/resize` **不再报 `STALE_SHELL`**。

### U2-C（高危 · 风险表第一条）· 同主机多 shell 输入串台

- **两处叠加根因**：
  1. `app.js openHost()` 用 `state.tabs.find(item => item.connId === id)` 找标签 —— 同主机多 shell 时**永远命中第一个标签**。于是激活第 2/3 个标签会执行 `tab.shellSeq = shellSeq`，**把第一个标签的 seq 改掉**，并把 `activeTab` 指回 0。
  2. `session.js openSocket()` 拿到票据后 `info.shells.find(sh => sh.state === 'live')` **无条件取第一个 live shell**，直接覆盖了调用方传入的 `shellSeq`。
- **实测**：三个标签逐一点击并各发一个 `MARK`，sshd 日志为 `inputChannels [1,1,1]`（全部落在 ch-1），且标签 2/3 的屏幕显示的是 ch-1 的 `MARKER`。
- **连锁表现**：刷新恢复后的标签集合变成 `["… #3","… #2","… #3"]`（**缺 `#1`、`#3` 重复**）；关闭对话框里「关闭此 shell（连接保留）」按钮缺席（其条件是 `state.activeTab === index`，而 `activeTab` 已被错置为 0）。
- **修复**：
  - `app.js`：`openHost(id, { shellSeq, tabIndex })` 支持**按索引精确定位**已有标签；`openHostAt()`、关闭标签后的接续、挂载恢复三处调用点全部传 `tabIndex`。
  - `session.js`：按记忆的 `shellSeq` **精确匹配**票据里的 shell；只有「没有 seq 的全新打开」才回退第一个 live。
  - `index.js`：`POST /ssh/api/attach` 返回的 shell 清单补 `shellSeq`（前端此前无从匹配）。
- **回归断言**（`test/session.test.js` 新增 2 例）：有记忆 seq 时选中 `sh-2`（而非第一个 live）；无 seq 时回退第一个 live 且跳过 `ended`。

### U2-D（中）· 恢复后标签错乱 / 点标签空白

- 与 U2-C 同源（标签被按 connId 定位后互相改写 seq）；随 U2-C 一并闭环，待重启复验。

### 验收夹具缺陷（非产品，已修）

| 缺陷 | 现象 | 处置 |
|---|---|---|
| 假 sshd 的 pty 归属丢失 | `pty` 事件早于 `shell` 到达 ⇒ 日志 `channel:null`，「每 shell 独立尺寸」判据误判 | 事件先入 pending，拿到 channel 号后补写 |
| 后台标签页 rAF 节流 | 读窗口 A 的 `.xterm-rows` 得到**旧内容**（B 成为活动标签后 A 停止渲染） | 读屏幕前 `Page.bringToFront` |
| 关闭对话框遮挡终端 | P2 未关 sheet ⇒ 后续 `typeTerminal` 的点击被 sheet 吃掉，`EXIT` 未达远端 | 用后即关（并以「取消」兜底） |
| `+` 前置条件 | 刷新/损坏快照阶段后 selection 失效 ⇒ `+` 退化为打开导航 | 点 `+` 前先点主机行归位 |
| prefs 判据假设错误 | 偏好**只在用户改设置时**落盘，首轮读到 `null` | 先真实点一次「增大终端字号」再断言 v2 结构 |

## 5. 环境适配记录（沙箱 → 真浏览器）

首轮驱动在**受限沙箱**下无法启动任何浏览器：Edge 与 Chrome 均以 `STATUS_BREAKPOINT` 退出，Edge 日志给出确凿根因 ——
`FATAL:mojo\public\cpp\platform\platform_channel.cc:183] Check failed: . : 拒绝访问。 (0x5)`。
即 **Chromium 的 Mojo IPC 需要命名管道，而受限模式禁止**。授予完整访问后浏览器正常启动，驱动全程可跑。
（记录在此是因为它会影响后续任何人复跑本驱动；D2/D3/D4 当时不受此限。）

## 6. 待重启复验清单

**前置：重启 `dsh web`**（`app.js`/`session.js`/`styles.css` 走 `cachedAsset` 进程内缓存；`lib/runtime.js`/`index.js` 随插件 ESM 加载；`hasSerializeAddon` 只在 apply 时判定一次），并强刷浏览器一次。

| 顺序 | 驱动 | 覆盖 |
|---|---|---|
| 1 | `node run-u2-accept.mjs` | P0/P0b（TOFU 入口）、P0c（补绑）、P1a/P1b（多 shell 隔离）、P3（per-shell 尺寸）、P4（双窗口写权与接管）、P2（关闭三分支 + 远端 exit）、P5（刷新恢复与两张据）、P6（损坏降级）、P7（8 shell 上限 + host RSS）、P8（旧帧） |
| 2 | `node run-u2-tui.mjs` | U2.4 判据：TUI 画面刷新后**逐行 + 光标行一致 ×3**，并记录 addon 是否真上线 |
| 3 | 三主题回归（D2 门槛本尊） | 三主题下浮层顶栏 reserve 消费与段数稳定 |

预期：P0b 由 FAIL 转 PASS（「核对指纹」按钮出现在场且不被覆盖）；P1b 的三个 channel 变为 `[1,2,3]`；P5a 恢复标签为 `[… , #2, #3]`；P2a 出现「关闭此 shell（连接保留）」。

## 7. 本轮未覆盖 / 明确边界

- **U2.2 SFTP 未开工**（规划内下一阶段，需真实主机补验 S1 性能基线），不是本轮缺口。
- **真实云主机未接入**：本环境无可用远端，全部实机项走本地假 sshd（真 SSH 协议、多 channel、真 pty/window-change/exit 语义）。广域网 RTT 与大流量传输压力项（验收包 R1）仍留待 U2.2 用真实主机复验。
- **app.js 纯搬迁拆分**（决策 5）仍未执行 —— 保持实施验收包 §7 的既有登记（R8）。
- 本轮改动**未提交**（按仓库纪律等待确认）。

## 8. 变更文件（本轮验收产生的修复）

| 文件 | 变更 |
|---|---|
| `lib/runtime.js` | `onReady` 补绑未绑定 viewer 并逐发带 `shellId/mode` 的 `ready` |
| `session.js` | 未绑定 shell 时不发 input/resize；新增 `syncSize()` 在 ready / shell.opened 后补发；票据 shell 清单按 `shellSeq` 精确匹配 |
| `app.js` | `openHost` 支持 `tabIndex` 精确定位（`openHostAt`、关闭接续、挂载恢复三处调用点同步） |
| `index.js` | `/ssh/api/attach` 返回的 shell 清单补 `shellSeq` |
| `test/runtime.test.js` | +1 例：等待指纹期 attach 的 viewer 在首个 shell 打开时补绑 |
| `test/session.test.js` | 改写 1 例（未绑定零发帧 + `syncSize` 补发）、+2 例（按 `shellSeq` 匹配 / 无 seq 回退） |
