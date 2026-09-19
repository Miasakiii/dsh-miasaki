# 桌宠 v3 演进规划（状态真实 · 审批可达 · 边缘停靠）

> 状态：规划设计稿（2026-09-12）。**本文件只做「做什么、为什么、怎么验收」，不动代码。**
> 前置：`pet-v2-roadmap.md`（v2 阶段 A/B 已落地）、`TODO.md`、`ARCHITECTURE.md`、`README.md`。
> 触发：用户反馈四项未达预期 —— ① 立绘不准确 ② 动作太少 ③ 不能反应工作状态 ④ 不能快捷审查提权；
> 并新增诉求 ⑤ **边缘状态**（扒屏幕边缘露头 / 爬窗口边缘）。

---

## 0. 结论先行

四个抱怨里，**只有「动作太少」部分是素材问题，其余三项的主因都是代码缺陷**。其中两项是
确定性缺陷（不需要实机即可判定），且**同一处缺陷同时造成了「动作少」与「不反映状态」两个症状**：

1. **单击一次后，桌宠永久卡在 `jump` 行**（`hop_until` 无复位路径）。这不只是「多跳一下」：
   `jump` 分支在状态选择链中的优先级**高于**审批与告警分支，于是审批姿态、工作姿态**被永久遮蔽**。
2. **双击挥手是死代码**（窗口类未注册 `CS_DBLCLKS`，`WM_LBUTTONDBLCLK` 永不到达）。

因此 v3 的正确顺序是：**先修状态机（M1）→ 再把状态信号源换成官方会话契约（M2）→ 再做审批闭环（M3）
→ 最后做边缘停靠（M4）**。若跳过 M1 直接堆动作素材，新增动作同样会被这条卡死的分支吃掉。

关于边缘状态：**参考仓库并未实现「爬其他应用窗口边缘」**（其 README 描述的是屏幕/工作区边界物理 +
多屏 DPI，属于「屏幕边缘」层级）。该能力对我们是**全新能力**，必须自建，且建议先做「爬自己的主窗口」。

---

## 1. 证据盘点（已核实）

### 1.1 确定性代码缺陷

| # | 缺陷 | 证据 | 后果 |
|---|---|---|---|
| D1 | `hop_until` 只被写入、从不被复位 | `src-tauri/src/pet_native/window.rs:555`（`do_hop` 写入）与 `:867`（仅构造时为 `None`）；`grep hop_until` 全仓无第三处赋值 | 单击后 `compose` 的 `:253` 分支恒真 → 每轮重挂 `hop_hold_until`（`:258-262`）→ **永久 `jump`** |
| D2 | 上述卡死连带禁掉散步与环境编排 | `:109`（wander 门）与 `:129`（ambient 门）均以 `hop_until.is_none()` 为前提 | **「动作太少」的直接主因**：单击一次后，ambient / wander 永不触发 |
| D3 | 上述卡死连带遮蔽状态姿态 | 行选择链 `:253`（hop）→ `:271`（wander）→ `:274`（ambient）→ `:281`（wave）→ `:288`（waiting）→ `:291`（fleet_alert） | **「不能反应工作状态」的直接主因**：`waiting`/`fleet_alert` 排在 `hop` 之后，永远轮不到 |
| D4 | 双击挥手不可达 | 窗口类 `style: CS_HREDRAW \| CS_VREDRAW`（`:892`），**无 `CS_DBLCLKS`**；而 `WM_LBUTTONDBLCLK` 处理器在 `:702` | 双击的第二击只会再走一次 `WM_LBUTTONUP`（`:686`）→ 再跳一次 + 抢焦点；`do_wave()` 仅在 `:707` 被引用 |
| D5 | 单击必然抢焦点 | `:694` `do_hop()` 后无条件 `focus_main()` | 想「单纯撸一下」也做不到，交互语义过重 |
| D6 | 圆点不跟随拖动 | `:67`、`:698`、`:952` 只在启动/重置时定位 | 隐藏后恢复入口与桌宠位置脱节 |

> **D1–D4 是纯代码可判定的事实**，无需实机。建议 M1 开工前用一次 30 秒实机复现（点一次 → 观察是否
> 30s 后仍在跳；`%LOCALAPPDATA%\miasaki\pet.log` 应无异常）把它钉成回归用例。

### 1.2 状态信号源错位（非崩溃，但语义错误）

- 现役实现是**整页 DOM 扫描**：`themes/src/05-sensors.js:67-98`（`scanActivity` / `scanApproval`）
  遍历全页 `button`，不绑定任何会话；`scanApproval` 的判据是「任一 dialog/modal 内同时存在允许类
  + 拒绝类按钮」（`:81-98`）。
- 官方已提供**权威且更省**的契约，本项目此前未使用：
  - **运行状态**：`SessionSnapshot.running: boolean`、`lastAgentError: string | null`、
    `queue`、`subagent` —— 见 `@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/snapshot.d.ts:71-94`。
  - **待交互（审批）**：`ctx.uiSession.pendingInteractions: HostObservable<ReadonlyMap<SessionId, …>>`
    与 `registerPendingInteraction()` —— 见 `@deepseek-ai/dsh-client-ui-session/lib/types/client/index.d.ts:96,117`。
  - **审批实体**：`PendingApproval`（含 `sessionId` / `toolName` / `callId` / `reason` / `answer()`）
    —— 见 `@deepseek-ai/dsh-client-ui-approval/lib/types/client/contract/slots.d.ts`。
  - **决策枚举**：`ApprovalDecision = 'allowed-once' | 'rejected'`（同上）。README 明确：
    *"The panel exposes transient decisions only"*，持久策略归 Host 侧审批包。
- 结论：**用官方契约替换 DOM 扫描作为主信号，DOM 仅作降级兜底**。这同时解决「口径是哪个会话」
  与「全页扫描误判」两个问题，并且把每 1.5s 的全量 `querySelectorAll` 开销从主路径移除。

### 1.3 边缘 / 多屏 / DPI 现状

| 能力 | 现状 | 证据 |
|---|---|---|
| 多屏工作区枚举 | **已有**，可复用 | `pet_native/persist.rs:52-78`（`monitor_workspaces`）、`:82-93`（`pos_visible`） |
| 屏幕边界钳制 | **仅主屏** | `pet_native/ffi.rs:181-183`（`GetSystemMetrics(SM_CXSCREEN/CYSCREEN)`）用于 `window.rs:157-163` 的 wander 钳制 → **副屏不可达，会被拉回主屏** |
| DPI | 进程级一次性声明，无变更响应 | `window.rs:855` `SetProcessDpiAwarenessContext(-4)`；全仓无 `WM_DPICHANGED` 处理 → **混合 DPI 跨屏拖动会坐标/尺寸错** |
| 窗口跟随 / 吸附模型 | **不存在** | `PetShared` 只有裸 `pos`（`pet_native.rs:19-33`），无目标窗口、无边缘锚点、无 `SetWinEventHook` |
| 渲染 | 固定 286×390 分层窗，逐像素 alpha，底部对齐缩放 | `window.rs:526-530`、`blit_center_bottom` |

### 1.4 素材现状（与「立绘不准确」相关）

- `ui/pets/frames.json`：kurumi **9 行 57 帧**（idle 6 / runRight 8 / runLeft 8 / wave 4 / jump 5 /
  failed 8 / wait 6 / run 6 / review 6）；whale 三态（idle 6 帧序列 + work/deep 单帧）；inverse 三态单帧。
- **已切但未使用**：`runRight` / `runLeft` 两行（运行时只用 `run`，`window.rs:273`）。
- **语义错配**：`r7` 行（名为 `run`）实为「坐姿用电脑」画面，却被当作「散步」播放（`window.rs:271-273`）。
- **inverse 不是滤镜**：三张独立原图经 `scripts/inverse-states.mjs:159-174` 抠图生成；且原图
  `ui/pets/inverse/raw/blue-idle.png` 与 `blue-deep.png` 的**金钟眼左右已互换**，属素材一致性问题。
  README 中「同狂三图集 + CSS 反转滤镜」的表述与实现不符，需一并订正。
- 结论：「立绘不准确」有三个独立来源 —— ① D1 导致长期停在 `jump` 帧；② `r7` 语义错配；
  ③ inverse 原图左右互换。**三者要分别修，不是重画一套素材就能解决。**

### 1.5 一处「看着像 bug 但不是」的项（勿误改）

`window.rs:529` / `:785` 的 `BlendFn { blend_op: 1, … }`：按 Win32 规范 `BlendOp` 应为
`AC_SRC_OVER`（`0x00`，见 `wingdi.h:4821`），此处传 `1` 是**规范偏差**。但
`%LOCALAPPDATA%\miasaki\pet.log` 中 **`ULW failed` 出现 0 次**，且首帧 `buf_nonzero=26419`、
`first compose done` 正常 —— 说明本机实际渲染成功。
**处置：不在本轮改动它**；若未来动它，必须同时加日志断言（改前后各跑一次并比对 `ULW failed` 计数）。
把它记为「规范偏差 + 本机非致命」，避免后人凭直觉「修」出一个真故障。

### 1.6 参考仓库（PC2005-cloud/dsh-pet）评估

固定提交：`814b0e4`（2026-09-11 10:44:24Z）。仅通过 GitHub API + README 核实，未拉取源码。

| 维度 | 事实 |
|---|---|
| 架构 | 宿主为 DSH web profile 插件；浏览器叠加 + **Electron** 透明局部窗；素材为 **VP9-Alpha `.webm`**（640×360），Safari 另发 HEVC-with-Alpha `.mov` |
| 已有能力 | 100+ 透明动画、权重化动画调度、交叉淡入、拖拽弹簧/甩抛/边缘反弹、多宠物实例、余额展示、碎碎念、聊天记忆 |
| 工作状态 | **有**：监听 DSH 会话事件切「思考/工作/整理/等待/成功/出错」档位 + 常驻气泡 |
| 审批 | **只有通知**：窗口失焦时弹系统 toast（含权限申请）；**未证明**能在宠物内直接批准/拒绝 |
| 边缘 | **仅屏幕/工作区边界**（多屏、DPI、任务栏条带、屏间空洞）；**未证明**能检测其他应用窗口并攀爬 |
| 许可 | 代码 MIT；**动画/提示词/源视频禁止商用**，且二创须署名原作者 |

**借鉴结论（吸收思路，不搬架构）**：

1. **档位化状态机**（思考/工作/等待/成功/出错各一档 + 常驻气泡）→ 与本项目 M2 的六态映射同构，可直接对齐语义。
2. **权重化动画调度 + 避免连续重复**（同档位候选数组轮换）→ 用于 M5 的 ambient 池，比现在的 `pick_ambient_row()` 更耐看。
3. **双缓冲交叉淡入**（避免切换空白帧）→ 与本项目 v2 的「jump 末帧 Hold」同思路，可推广到所有状态切换。
4. **多屏 DPI / 任务栏条带 / 屏间空洞**的处理经验 → 直接对应本项目 §1.3 的两个缺口，M4.1 必读。
5. **`prefers-reduced-motion` 式降级** → 本项目可等价为「低功耗/减少动效」开关，放进设置面板。
6. **素材与代码许可分离** → 本项目**已有自建素材链**（`cut-frames` / `inverse-states` / `gen-bubbles`），
   **不引入其素材**，避免非商用条款污染。

**明确不照搬**：不引入 Electron、不引入 webm 透明视频（本项目是 Tauri 2 + Win32 原生分层窗 + PNG 图集，
换成视频解码会破坏「零依赖 / 33ms 主路径零分配」的架构铁律）；不 fork 其代码（七线零耦合）。

> **2026-09-16 补充**：以上评估针对的是**上游** `PC2005-cloud/dsh-pet`（Electron 版）。
> 其下游 fork `MerZlin/dsh-pet-indesktop`（Python + PySide6，v4.2.0）已做完整对标，见
> [`pet-reference-benchmark.md`](pet-reference-benchmark.md)。**注意两点订正**：① 上表「审批只有通知」
> **不适用于该 fork**——它已实现完整的可点击审批（同意/拒绝 + 回写），是我方 M3.2 的直接参照；
> ② 该 fork 还有本表未涵盖的可借鉴项：提醒队列、逐像素鼠标穿透、`WS_EX_NOACTIVATE`、
> 位置比例化持久化、边缘探头参数口径、以及「旋转/形变在绘制层做、不依赖素材」这条
> **改变 M5 顺序**的架构判断。

---

## 2. 设计原则

1. **先修状态机，再加动作与素材**：任何新动作都必须能被状态机正确调度，否则会被 D1 吃掉。
2. **状态信号以官方契约为唯一事实来源**：`SessionSnapshot` / `uiSession.pendingInteractions` 为主，
   DOM 扫描降级为兜底（官方 API 缺失或页面非 DSH 时）。
3. **单向依赖不变**：注入 JS 只写 hash，Rust 只读 hash（沿用 `ARCHITECTURE.md` 的定律）；
   Rust 侧继续对入参做白名单归一化（现有范式见 `pet_native.rs:82-88`）。
4. **安全红线**：桌宠**永不自动决策**审批；只允许 `allowed-once` / `rejected`；不写持久策略；
   不代答 OS UAC（UAC 是独立安全边界，桌宠不触碰）。
5. **零依赖 / 主路径零新增分配**：不引入 crate，不在 33ms compose 路径分配（沿用 v2 铁律）。
6. **边缘能力分级**：先「屏幕边缘」后「自己的主窗口」，第三方窗口作为可选 M5 —— 收益/风险比最高。
7. **不新增 GDI 对象**：鉴于 `TODO.md` P0 仍有未收敛的「偶发全黑无响应」挂起，任何新渲染分支
   必须复用现有持久表面。

---

## 3. 里程碑

### M0 · 前置探针（先做，避免在错误前提上开工）

| 编号 | 探针 | 通过判据 | 失败时的退路 |
|---|---|---|---|
| S1 | 实机复现 D1 | 单击一次后 30s 仍在 `jump`；`pet.log` 无异常 | 若不复现，说明另有清空路径，M1 重新评估（先读代码再动） |
| S2 | 在 `dsh-pet-panel` 里能否订阅 `ctx.uiSession.pendingInteractions` | 探针插件能打印出 `PendingApproval.toolName` | 退回 DOM 扫描 + 增强容器判定（保留现状） |
| S3 | `ctx.sidebarRight.openTab(<审查 kind>)` 在非当前会话下是否可用 | 能展开右栏并落到审查 tab | 降级为「唤起主窗口 + 提示用户手动打开」 |
| S4 | `PendingApproval.answer('allowed-once')` 端到端可用 | 点一次即放行，Host 侧收到决策 | 审批只做「提示 + 跳转」，不做内联决策（M3 降级） |

> 探针插件按项目纪律**跑完即删**，不入库、不进 `plugins/`。

### M1 · 动作状态机修复（P0，纯代码）

**M1.1 一次性动作统一为带到期时间的槽位**

```
现状：hop_until / hop_hold_until / wave_until / ambient.until / wander.until —— 5 个独立 Option，
      各自维护，只有 hop_until 没有清理点。
目标：单一 ActionSlot { kind: Jump|Wave|Ambient|Wander|Dock, started: Instant, duration: Duration }
      compose 每轮先做「到期即清」，再做行选择 —— 从结构上消除「忘记清理」这一类缺陷。
```

**M1.2 状态优先级重排（关键）**

```
新优先级（高 → 低）：
  approval(等待审批) > fleet_alert > busy/work > 用户手势动作(jump/wave) > wander > ambient > idle
```

即：**审批与告警可抢占一次性动作**（拖动进行中除外）。现状顺序恰好相反，这是 D3 的根因。

**M1.3 交互语义修正**

- 单击：默认「撸一下」（jump + 气泡），**不再无条件抢焦点**；仅在「等待审批」或「主窗口最小化/隐藏」
  时单击 = 唤起主窗口（保留现有有用语义）。
- 双击：窗口类补 `CS_DBLCLKS` 后挥手才真正可达；双击与单击需去抖（`WM_LBUTTONUP` 先到，
  需延迟 ~250ms 判定是否第二击），避免「双击 = 跳一次 + 挥一次」。
- 拖动：释放时按释放位置做边缘吸附判定（为 M4.1 预留钩子）。

**M1.4 圆点跟随**：圆点位置改为随桌宠位置更新（拖动结束 + 隐藏时同步），修复 D6。

**验收**：① 单击后 ≤1.5s 回到基线行；② 连续单击 20 次不卡；③ 审批态出现时 ≤2s 内切到审批姿态
（即使刚点过桌宠）；④ 双击能挥手；⑤ `pet.log` 无新增 `ULW failed`。

### M2 · 真实工作状态（P0）

**M2.1 六态统一模型**（Rust 侧单一枚举，替换现有 `activity: String` + `waiting_approval: bool` 的松散组合）

| 态 | 来源 | 立绘/姿态 | 气泡 |
|---|---|---|---|
| `idle` | `running=false` 且无待交互 | idle 行 / 三态 idle | 随机台词 |
| `thinking` | `SessionSnapshot.running === true` | 静默守候（沿用 v2 决策 3）+ 呼吸增强 | 可选「思考中…」 |
| `waiting` | `pendingInteractions` 含 `kind==='approval'` | kurumi `wait` 行 / whale·inverse work 立绘 | 常驻「等待审批」+ **工具名/原因** |
| `error` | `lastAgentError !== null` | kurumi `failed` 行 | 常驻「出错了」+ 可点击跳转 |
| `fleet-blocked` | fleet pulse `blocked/error>0` | kurumi `failed` 行 | 常驻「需要你的批准」 |
| `done` | `running` 由 true→false 且无 error | `review` 行短暂庆祝（1 次，不循环） | 「完成了」（10s 后消失） |

> 与参考仓库的档位语义对齐（思考/工作/等待/成功/出错），但**不引入其实现**。

**M2.2 信号通道**：hash 参数从 `act=busy|idle` 扩展为 `act=<六态枚举>`，Rust 侧白名单归一化，
未知值一律回 `idle`（防篡改，沿用 `pet_native.rs:82-88` 范式）。DOM 扫描保留为兜底分支，
且**仅在官方 API 不可用时启用**。

**M2.3 会话口径**：明确绑定「当前选中会话」；`subagent` 会话不计入主态（避免子代理抢戏）。

> **2026-09-16 订正（R0 已落地）**：此口径**升级为跨会话聚合**——只读当前会话会**漏报**
> 后台会话的待审批，而「快捷提权」的价值前提正是「不用切窗口」。现为：遍历全部会话的
> `pendingInteractions` 找审批（带出 `sessionId`/`reason`，**无稳定身份不显示**）+ 运行态
> 「任一非子代理会话 `running` = 忙」。详见 `pet-reference-benchmark.md` R0 与 CHANGELOG 2026-09-16。

**验收**：① 发一条消息 → 桌宠 ≤1.5s 进 `thinking`；② 完成 → 进 `done` 后回 `idle`；
③ 请求审批 → ≤1.5s 进 `waiting` 并显示工具名；④ 断网/官方 API 缺失 → 自动回落 DOM 扫描且不报错。

### M3 · 快捷审查与提权（P0/P1）

**M3.1 审批提示（必做，低风险）**

- `dsh-pet-panel` 订阅 `uiSession.pendingInteractions`，把 `toolName` / `reason` / `sessionId`
  经 hash 上报 → 桌宠气泡显示「**等待审批：<toolName>**」。
- 单击桌宠 = 唤起主窗口并聚焦到该审批（现有行为，保留）。

**M3.2 桌宠内一键审批（可选，取决于 S4）**

- 气泡升级：从「纯位图」到「位图 + 2 个原生命中区」（`允许一次` / `拒绝`）。
  - 命中区在 `wnd_proc` 内用矩形判定（不新增 GDI 对象）；气泡为预渲染位图，
    **按钮文字沿用 `gen-bubbles.ps1` 预渲染**，避免踩 README 记载的 GDI 字体崩溃区。
- 链路：`WM_LBUTTONUP` 命中按钮 → hash `cmd=approve-once` / `cmd=deny`（带 `seq` 防重放）
  → 插件调用 `PendingApproval.answer('allowed-once' | 'rejected')`。
- **红线**：只在用户显式点击时决策；只发这两种枚举；不做「全部允许」「记住选择」等持久化语义。

**M3.3 快捷打开审查**

- 桌宠右键菜单加「打开审查」→ hash `cmd=open-review` → 插件 `ctx.sidebarRight.openTab(<kind>)`
  + `toggleExpanded()`（kind 由 S3 确定）。
- 桌面线**只通过官方 `ctx.sidebarRight` 调用**，不 import sidebar 线代码，保持七线零耦合。

**验收**：① 审批出现 → 气泡 2s 内显示工具名；② 点「允许一次」→ 会话继续；
③ 桌宠全程不自动决策（无点击时决策数恒为 0）；④ 审查 tab 能被桌宠唤起并展开。

### M4 · 边缘状态（用户核心新诉求）

**M4.1 屏幕边缘停靠（露头）**

- 新增 `Dock { edge: Left|Right|Top|Bottom, anchor: f32 (0..1), peek: bool }`，随 `pet.json` 持久化
  （需 `version: 2` + 迁移，旧 v1 静默升级）。
- 行为：拖动松手点距屏幕工作区边缘 ≤ 24px → 吸附；静置 ≥ 15s → 自动缩边（只露 ~35% 宽度）；
  鼠标进入感应区或点击 → 探出。
- 实现要点：
  - 复用 `monitor_workspaces()`（`persist.rs:52`）替换 `screen_size()` 做主屏钳制，**顺带修掉副屏不可达**。
  - 需要新增「按边缘裁剪的 blit」（现有 `blit_center_bottom` 不做裁剪）。
  - **必须同步修改 `pos_visible` 判定**：peek 状态下窗口中心点在工作区外，
    现行 `persist.rs:82-93` 会判定「不可见」→ 重启后把桌宠拉回默认位置（即「桌宠丢了」回归）。
    这是 M4.1 最容易漏的一个坑。
    > **2026-09-16 R3 已先行修复**：判据改为「**角色可见区域 ∩ 工作区 ≥ 25%**」，
    > `pet.json` 同时升 v2（角色区域中心相对工作区的比例 `rx/ry` + 工作区几何 + 绝对坐标兜底）。
  - 多屏 DPI：补 `WM_DPICHANGED` 处理，否则混合 DPI 下吸附坐标会偏。

**M4.2 爬自己的主窗口边缘（推荐先做这个）**

- 目标限定为**本应用主窗口**（DSH 主窗）：范围可控、收益明确、不涉及第三方窗口权限问题。
- 需要新增：`GetForegroundWindow` / `GetWindowRect` 跟踪 + 边缘锚点 + `SetWinEventHook`
  （`EVENT_OBJECT_LOCATIONCHANGE` / `EVENT_SYSTEM_FOREGROUND`）——现有窗口线程已有消息循环，可挂。
- 行为：吸附到主窗口左/右边缘并随其移动同步；主窗口最小化/关闭 → 自动回到屏幕边缘或桌面。

**M4.3 第三方窗口边缘（可选 M5）**

- 需要额外的窗口筛选（排除全屏/游戏/UWP/管理员窗口）、遮挡策略、异常退出兜底。
- 风险明确：全屏应用与 DWM 合成下行为不一致；管理员权限窗口不可枚举。
- **建议：先不做**，待 M4.1/M4.2 稳定运行后再评估。

**M4.4 边缘动作素材（缺口，需明确产出方式）**

- 「扒边缘 / 探头 / 攀爬」是**新动作语义**，现有 57 帧里没有对应行。
- 本项目**不具备视频生成能力**；可行路径：① 既有 AI 出图 + `cut-frames.mjs` 切图链产出新行；
  ② 手工/外包绘制；③ 先用「裁剪 + 位移」模拟（露头 = 裁剪 idle 帧，攀爬 = 沿边缘位移复用 run 行），
  把素材缺口与功能落地解耦。
- **建议先走 ③**，让 M4.1 不阻塞在素材上；新素材作为 M5 增强。

**验收**：① 拖到边缘自动吸附且重启后位置保持；② 静置后缩边、鼠标靠近探出；
③ 吸附态下重启不触发「位置不可见 → 回默认」；④ 副屏可正常漫游与吸附；⑤ 混合 DPI 下吸附不偏移。

### M5 · 立绘准确性与动作扩容（P1）

- **语义修正**：`r7`（坐姿用电脑）不再当「散步」用；散步改用 `runRight` / `runLeft` 按方向选行
  （两行已切、当前闲置）。
- **inverse 一致性**：重出原图使 `blue-idle.png` 与 `blue-deep.png` 的金钟眼方向一致；
  订正 README 中「CSS 反转滤镜」的表述（实现是独立素材）。
- **素材利用率**：whale 图集未接入的行、kurumi `failed` / `review` 行接入状态机（M2 会用到）。
- **ambient 池升级**：引入参考仓库的「权重 + 避免连续重复」策略，替换现在的均匀随机。
- **过渡**：状态切换统一加交叉淡入或末帧 Hold，消除硬切（复用 v2 的 jump Hold 机制并推广）。

**验收**：① 散步方向与朝向一致；② 连续 5 分钟观察无「同一个动作连播 3 次」；
③ 所有状态切换无空白帧；④ `validate` 脚本（若做）报告行数与声明一致。

---

## 4. 里程碑依赖与顺序

```
M0 探针 ──┬─> M1 状态机修复 ──> M2 真实状态 ──> M3 审批闭环
          │                          │
          └─> (S4 决定 M3.2 是否可做)  └─> M4.1 屏幕边缘 ──> M4.2 主窗口边缘 ──> (M4.3 可选)
                                                          └─> M5 素材与立绘（可与 M4 并行）
```

- M1 是**一切的前置**：不修 D1，M2/M3 的状态姿态依然会被 `jump` 遮蔽。
- M4 与 M5 可并行（一个动 Rust 窗口层，一个动素材与映射表，文件不重叠）。
- M3.2（桌宠内一键审批）依赖 S4，S4 不通过则只做 M3.1 + M3.3。

---

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 未收敛的「偶发全黑无响应」挂起（`TODO.md` P0） | 新增窗口跟踪/事件钩子可能加剧 | 严格「不新增 GDI 对象」；M4.2 的 `SetWinEventHook` 先做可一键关闭的开关；先在 M1/M2 阶段观察稳定性再加 M4 |
| `SetWinEventHook` 回调与 33ms compose 争用消息循环 | 卡顿 | 回调内只记录目标矩形，不做渲染；渲染仍在 compose 内 |
| peek 状态与 `pos_visible` 冲突 | 重启后「桌宠丢了」 | 明确作为 M4.1 的必测项（§3 M4.1 验收 ③） |
| 混合 DPI 跨屏坐标错 | 吸附偏移、拖动跳变 | 补 `WM_DPICHANGED`；吸附坐标一律用物理像素并在边缘处取整 |
| 审批误操作（点错、连点） | 错误放行工具调用 | 按钮命中区之间留 ≥8px 间隙；决策请求带 `seq` 防重放；决策后 300ms 内忽略重复点击 |
| DOM 兜底与官方契约同时上报导致抖动 | 姿态闪烁 | 官方契约可用时**完全关闭** DOM 分支（不是两者并存） |
| 参考仓库素材许可（禁商用 + 署名） | 法律风险 | **不引入其任何素材**；仅借鉴机制思路 |

---

## 6. 待决策点（需用户拍板）

1. **单击语义**：改为「撸一下不抢焦点」，还是保持「单击即唤起主窗口」？
   （建议：改；「等待审批/主窗口隐藏」时才唤起，其余情况只做动作与气泡。）
2. **M3.2 桌宠内一键审批是否要做**？
   - 利：真正的「快捷提权」，不用切窗口。
   - 弊：原生窗口做可点击按钮需要命中区 + 预渲染按钮图，是新的复杂度与误操作面。
   - 建议：先做 M3.1 + M3.3（提示 + 跳转 + 唤起审查），观察使用频率后再决定 M3.2。
3. **M4.2 是否限定为「只爬本应用主窗口」**？（建议：是，第三方窗口降为 M5 可选。）
4. **边缘素材**：接受「先用裁剪+位移模拟」以解耦功能与素材，还是要先产出新动作帧再上功能？
   （建议：接受模拟。）
5. **是否顺带修 `blend_op: 1`**？（建议：本轮不动，仅记录为规范偏差。）

---

## 7. 与既有文档的映射

| 既有条目 | 落位 |
|---|---|
| `TODO.md` P2「桌宠『审批等待』状态 … 桌宠内一键审批后续阶段」 | M2.1 + M3.1 / M3.2 |
| `TODO.md` P2「桌宠双击 = 唤起/聚焦主窗口（已实现，待验证）」 | M1.3 —— **注意：双击挥手当前是死代码（D4），「已实现」需修正为「待修」** |
| `TODO.md` P2「反转狂三 run/wave/jump 动画帧」 | M5 |
| `TODO.md` P3「正式 IPC 替代 hash 通道」 | 不在本方案内；但 M2/M3 会显著增加 hash 通道的语义密度，建议随 M3 一并评估 |
| `pet-v2-roadmap.md` 阶段 A/B | 已落地，v3 在其上做修复与扩展，不推翻 |
| `README.md`「Q 版桌宠」段 | M1–M5 完成后需同步：双击语义、审批链路、边缘状态、inverse 表述订正 |
| `design/ARCHITECTURE.md` | M2 的六态数据流与 M4 的 Dock 模型需补入 |

---

## 8. 验收矩阵（回归用）

| # | 用例 | 期望 |
|---|---|---|
| 1 | 单击桌宠一次，静置 30s | 不卡在 jump；≥1 次 ambient 小动作 |
| 2 | 连续单击 20 次 | 无卡死、无动作堆积 |
| 3 | 双击桌宠（主窗口可见） | 挥手一次（不是跳一次） |
| 4 | 发送消息 | ≤1.5s 进 thinking；完成后进 done 再回 idle |
| 5 | 触发工具审批 | ≤1.5s 进 waiting，气泡含工具名 |
| 6 | 刚点过桌宠后立即触发审批 | 仍能切到审批姿态（D3 回归项） |
| 7 | 无点击情况下观察 10 分钟 | 决策数 = 0（桌宠不自动审批） |
| 8 | 拖到屏幕右缘松手 | 吸附；重启后位置保持 |
| 9 | 吸附后静置 15s | 缩边露头；鼠标靠近探出 |
| 10 | peek 状态下重启应用 | 位置保持，不回默认坐标 |
| 11 | 副屏拖动 + 漫游 | 可达副屏，不被拉回主屏 |
| 12 | 混合 DPI 双屏间拖动 | 尺寸与坐标不跳变 |
| 13 | 全程 `pet.log` | 无新增 `ULW failed`；GDI 对象数不增 |
