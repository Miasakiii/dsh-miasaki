# A×B 联动落地方案：桌宠反映 fleet 状态

- 日期：2026-08-18
- 状态：Draft（落地方案，待 Operator 评审后进入实施）
- 关联：`design/HANDOVER.md`（项目 A）、`docs/multi-agent-cli-orchestrator-design.md` v0.13（项目 B）
- 目标一句话：让桌宠从"随主题换皮的挂件"升级为**编排系统 fleet 的活体状态指示器**——有任务在跑就忙碌、等待审批就 waiting、预算熔断/出错就告警。

---

## 0. 为什么做这件事

当前两个子项目共用一个 workspace，但只是"物理同居"：

- **A（Miasaki 桌面端）**：Tauri 壳 + 三主题 + 原生桌宠，桌宠状态目前只由**主页面 DOM 变异频率**驱动（idle/work/deep 三档思考强度），与真实工作无关。
- **B（多 Agent CLI 编排）**：文件总线上的 fleet 状态齐全（`status.json` / `events.jsonl` / `ledger.jsonl`），但**只有面板一个 UI 出口**，而面板可见性还是最老的欠账。

联动的价值：**B 的真实状态借 A 已经稳定的桌宠通道显形**。桌宠是"永远在屏幕上、零点击"的环境光式指示器，即使面板不可见，Operator 也能一眼看到"claude 正在跑 / 有任务等审批 / 今天预算快烧完了"。这也正是 HANDOVER §5 P3-13 埋下的线（"fleet 健康度 → 桌宠表情"）。

---

## 1. 现有链路盘点（本方案的地基，均已核对源码）

### 1.1 A 侧同步通道（唯一且已稳定）

```
runtime.js (注入 DSH 页面)
  syncHash() / petEvalIntensity() / petHashCmd()
    → history.replaceState('#miasaki-theme=X&int=X&cmd=X&seq=N&move=dx,dy')
        ↓  （无 IPC 环境下的既定通道）
main.rs  start_hash_watchdog()  —— tokio 每 100ms 轮询 wv.url().fragment()
  parse_fragment() → (theme, int, cmd, move_xy, seq)
    → pet.set_mode(mode) / pet.set_intensity(int)
    → wv.hide()/show()/min()/max()/exit()（cmd 带 seq 去重）
```

关键事实：
- 通道是 **URL fragment 单向广播**，不依赖 IPC/invoke（远程页 invoke 被 ACL 拦截，见 HANDOVER §6）。
- `int` 当前取值：`idle` / `work` / `deep`，由 `petEvalIntensity()` 按 DOM 变异频率分档。
- `cmd` 带 `seq`（`Date.now()`）去重，`last_seq` 单调递增才执行。

### 1.2 桌宠渲染态（pet_native.rs）

```rust
pub struct PetShared { pub mode: String, pub intensity: String, pub hide: bool }
```

- `mode`：`whale` / `kurumi` / `inverse`（跟随主题）。
- `intensity`：驱动 `whale_states` 三态立绘 `idle`/`work`/`deep`（`anim_ms=1000`，idle 时正弦浮动）。
- `bubble: Option<(String, Instant)>`：气泡文本 + 时间戳，**3 秒自动过期**（已实现）。
- 动画由 `WM_TIMER` 驱动，`UpdateLayeredWindow` 逐像素 alpha。

### 1.3 B 侧状态源（文件总线，单一写者）

| 文件 | 写者 | 关键字段 | 用途 |
|---|---|---|---|
| `agents/<id>/status.json` | worker / 派单器代理写 | `state`(idle/running/error)、`progress`、`step`、`current_task`、`last_error`、`heartbeat_at` | 单 agent 实时态 |
| `agents/<id>/control.json` | Operator | `enabled` | 是否在 fleet 中 |
| `state/tasks.jsonl` | Commander | `op`(create/assign/update/reopen)、`status`(queued/running/blocked/done)、`accepted` | 任务生命周期 |
| `state/events.jsonl` | Commander | `event`、`note` | 里程碑事件流 |
| `state/ledger.jsonl` | Commander | `cost`、`model`、`metering` | 成本台账 |
| `dispatch-task.ps1` 退出码 | 派单器 | `0`成功 / `2`配置错 / `3`blocked / `4`预算熔断 | 派单结果信号 |

派单器预算逻辑（`Test-Budget`）：当日 cost `>= budget` → 熔断（exit 4）；`>= 80% budget` → 预警但放行。

---

## 2. 核心设计：一个"聚合桥"把 B 的状态喂进 A 的通道

**难点**：B 的状态在文件系统里，而 A 的桌宠只听 `main` webview 的 URL fragment。DSH 主页面是远程页，`runtime.js` 只能算它自己的 DOM 强度，**看不到 `state/` 文件**。所以需要一座桥把文件态转成桌宠能理解的信号。

有两条可选路径，本方案**推荐路径 B（Rust 原生读文件），路径 A 作为零改 Rust 的降级备选**。

### 路径 A（备选，纯前端）：runtime.js 轮询本地素材服务
- 素材服务已在 `127.0.0.1:39800` 提供 `ui/`（CORS 已开）。
- 扩展一个 `GET /fleet-status.json` 端点（或直接把聚合文件放进 `ui/`），`runtime.js` 每 1~2s fetch，转成 `int=` / `cmd=fleet:*` 写进 hash。
- 优点：零改 Rust。缺点：把 B 的关注点塞进主题运行时，职责混杂；且素材服务当前只服务静态文件，要加动态端点。

### 路径 B（推荐）：Rust watchdog 直接读聚合文件 → 直接调 pet API
- 桌宠状态本就由 Rust 持有（`Arc<Mutex<PetShared>>`）。让 Rust **新增一个 fleet watchdog**，直接读 workspace 下的聚合文件，直接调 `pet.set_intensity()` / `pet.set_bubble()`，**完全绕开 hash 与主页面**。
- 优点：职责干净（B 的状态不污染主题运行时）；不依赖主页面在焦点/存活；`Arc<Mutex>` 直连零延迟。
- 缺点：需改 Rust（新增一个 watchdog 线程 + 一个 pet 命令）。改动可控。

```
┌──────────────── 项目 B（编排，文件总线） ────────────────┐
│ agents/*/status.json · state/tasks.jsonl · ledger.jsonl │
└───────────────────────┬─────────────────────────────────┘
                        │ ① 聚合器（单一写者：Commander/派单器）
                        ▼
        state/fleet-pulse.json   ← 唯一"桌宠可读"的聚合快照
                        │ ② Rust fleet_watchdog 每 1s 读（mtime 变才解析）
                        ▼
   pet_native.rs  PetShared{ mode, intensity, hide, + fleet_state, bubble }
                        │ ③ WM_TIMER 渲染：立绘态 + 气泡 + 告警辉光
                        ▼
                   桌宠显形（环境光式状态指示）
```

**为什么额外造一个 `fleet-pulse.json` 而不让 Rust 直接读 5 个文件**：
1. **单一写者原则**（B §1 铁律）：聚合逻辑归 Commander/派单器一处写，Rust 只读一个文件，不越权、不解析多源。
2. **解耦上游演进**：`tasks.jsonl` 结构以后若变，只改聚合器，Rust 契约不动。
3. **降级友好**：文件不存在时 Rust 退回纯"思考强度"模式，联动缺失不影响 A 的既有功能。

---

## 3. 数据契约：`state/fleet-pulse.json`

聚合器（PowerShell，随派单器/Commander 每次状态变更时刷新，或一个 1s 心跳脚本）写出：

```jsonc
{
  "version": 1,
  "updated_at": "2026-08-18T22:00:00Z",
  "fleet_state": "busy",        // 见 §4 状态优先级：idle|busy|waiting|warn|alert
  "running": 1,                  // state=running 的 agent 数
  "enabled": 4,                  // control.enabled=true 的 agent 数
  "blocked": 0,                  // status=blocked / exit3 的任务数
  "waiting_approval": 0,         // 等待 Operator 审批的任务数（预留）
  "budget": { "day_cost": 0.41, "day_budget": 2.0, "ratio": 0.21, "tier": "ok" },
  // tier: ok | warn(>=0.8) | over(>=1.0，熔断)
  "active": [                    // 当前在跑的 agent 摘要（气泡取材）
    { "id": "claude", "task": "t-0006", "step": "21 回合执行中", "progress": 0.6 }
  ],
  "last_error": null,            // 最近一次派单 error/blocked 摘要
  "bubble": "claude 正在跑 t-0006"  // 可选：聚合器直接给一句气泡文案
}
```

- **写者唯一**：聚合器（隶属 Commander / 派单器）。桌宠只读。
- **原子写**：先写 `fleet-pulse.json.tmp` 再 `rename`，避免 Rust 读到半截 JSON。
- **mtime 门控**：Rust 记录上次 mtime，未变则跳过解析（对齐 hash watchdog 的 `last_fragment` 去重思路）。

---

## 4. 状态映射表：fleet → 桌宠表现

**优先级（高 → 低）**：`alert` > `warn` > `waiting` > `busy` > `idle`。多态并存时取最高优先级作为 `fleet_state`，气泡可附带次要信息。

| fleet_state | 触发条件 | 桌宠立绘/姿态 | 气泡文案（示例） | 视觉强调 |
|---|---|---|---|---|
| `idle` | 无 running、无 blocked、预算 ok | `idle` 三态（正弦浮动，现状） | 无（或随机待机台词） | 无 |
| `busy` | ≥1 agent running | `work`（或 `deep`，按 running 数/progress） | 「claude 跑 t-0006 · 60%」 | 轻微呼吸感（复用 anim） |
| `waiting` | ≥1 任务等待审批（`waiting_approval>0`） | 新增 `wait` 姿态（v1 复用 work 立绘 + 问号气泡兜底） | 「t-0007 等待审批」 | 气泡常驻（延长过期） |
| `warn` | 预算 `tier=warn`（≥80%）或有 blocked | `work` + 告警色调 | 「预算已用 83%」/「t-0005 blocked」 | 暖黄辉光边 |
| `alert` | 预算熔断(`over`) 或 status=error | `deep`/专属告警帧 + 抖动 | 「预算熔断，已拒绝派单」/「claude exit 4」 | 绯红辉光 + 短抖动 |

### 与"思考强度"如何共存
- 桌宠 `intensity` 现由主页面 DOM 频率驱动（A 自有）。fleet 联动**优先级更高**：当 `fleet_state != idle` 时，以 fleet 态覆盖 DOM 强度；fleet 空闲时回退到 DOM 强度。
- 实现上：`PetShared` 增加 `fleet_state: String`；渲染时 `effective = if fleet_state != "idle" { map(fleet_state) } else { intensity }`。

### 按角色差异化文案（复用 B P2 台词体系）
- `whale`（鲸鱼娘）：中性提示，「有 1 个任务在跑」。
- `kurumi`（狂三）：「时之精灵在为你调度…」。
- `inverse`（反转狂三）：告警时更冷冽，「预算见底了，收手吧」。
- v1 先做统一文案，角色差异化归到 §7 阶段 3。

---

## 5. 分阶段实施（最小可用 → 完整）

### 阶段 0 · 聚合器最小实现（半天，纯 B 侧，零改 A）
- 新增 `workers/pulse/build-pulse.ps1`：读 `agents/*/status.json`+`control.json`、`ledger.jsonl` 当日 cost、`tasks.jsonl` 尾态，按 §4 优先级算 `fleet_state`，原子写 `state/fleet-pulse.json`。
- 接入点：`dispatch-task.ps1` 在写 status running/终态后各调一次 `build-pulse.ps1`；再加一个可选 1s 心跳（`workers/pulse/pulse-loop.ps1`）兜底 running 期间的 progress 刷新。
- **验收**：手动改一个 `status.json` 的 state → `fleet-pulse.json` 的 `fleet_state` 随之变化。此阶段可独立自证，不阻塞 A。

### 阶段 1 · Rust fleet watchdog（1 天，A 侧核心）
- `pet_native.rs`：`PetShared` 增 `fleet_state: String`（默认 `idle`）；新增 `set_fleet_state(&self, s, bubble)`（改 intensity 覆盖逻辑 + 设置 bubble）。
- `main.rs`：仿 `start_hash_watchdog` 新增 `start_fleet_watchdog(app, workspace_dir)`：tokio 每 1s 读 `state/fleet-pulse.json`，mtime 门控，解析后调 `pet.set_fleet_state()`。
- workspace 路径来源：exe 旁定位（与素材服务 `ui/` 同源思路），或 `%LOCALAPPDATA%\miasaki\` 下配置项，避免硬编码桌面路径。
- **验收**：阶段 0 改 status → 桌宠 1~2s 内切到 busy 立绘 + 气泡。

### 阶段 2 · 告警视觉（0.5 天）
- `warn`/`alert` 的暖黄/绯红辉光：在 `UpdateLayeredWindow` 前对像素叠加辉光（复用 inverse 重着色的像素处理经验，见 `recolor-inverse.mjs` 思路）。
- `alert` 抖动：`MoveWindow` 小幅位移几帧后归位（注意 §踩坑：物理坐标、SWP_NOZORDER）。

### 阶段 3 · 深化（可选，随 B P2/M4 推进）
- 角色差异化台词体系（对齐 HANDOVER §5 P2-9）。
- `waiting_approval` 真实接入：需要 B 侧先把"等待审批"落成 `tasks.jsonl` 显式状态（当前是预留字段）。
- 托盘/双击桌宠 → 唤起面板对应任务（与 HANDOVER P0-4/5 合流）。

---

## 6. 改动文件清单

| 文件 | 动作 | 归属 | 阶段 |
|---|---|---|---|
| `workers/pulse/build-pulse.ps1` | 新增（聚合器，单一写者） | B | 0 |
| `workers/pulse/pulse-loop.ps1` | 新增（可选 1s 心跳） | B | 0 |
| `workers/dispatch/dispatch-task.ps1` | 编辑（两处状态写后各调一次 build-pulse） | B | 0 |
| `state/fleet-pulse.json` | 生成物（契约见 §3） | B | 0 |
| `desktop/src-tauri/src/pet_native.rs` | 编辑（PetShared+fleet_state、set_fleet_state） | A | 1 |
| `desktop/src-tauri/src/main.rs` | 编辑（start_fleet_watchdog + 启动时 spawn） | A | 1 |
| `desktop/scripts/build-init.mjs` | 无需改（不涉及令牌面） | — | — |
| `docs/multi-agent-cli-orchestrator-design.md` | 回写新增 §（联动通道） | B | 收尾 |
| `design/HANDOVER.md` | §5 P3-13 标记进行中/§7 文件地图补 pulse | A | 收尾 |

**构建链路**：改 Rust 后按 HANDOVER §3 固定顺序 `cargo build --release --offline` → 先删后拷 `dist\Miasaki.exe`。不改素材，无需重跑 cut-frames/make-icons（除非阶段 2 加告警帧）。

---

## 7. 复用现有资产 & 规避已知踩坑

**复用**：
- fleet watchdog 直接照抄 `start_hash_watchdog` 的 tokio 轮询 + 去重骨架。
- 气泡机制（`bubble: Option<(String, Instant)>` + 3s 过期）已存在，直接设置文本即可。
- 三态立绘 `whale_states`（idle/work/deep）已存在，v1 不需新素材。
- 辉光像素处理可参考 `recolor-inverse.mjs`（inverse 角色重着色）的像素级思路。

**规避（违反必炸，来自 HANDOVER §6 / collective-memory）**：
1. **不走 WebView2 承载桌宠**：联动只改 Rust 原生窗口 + 文件读取，不碰 webview 透明。
2. **DPI 物理坐标**：阶段 2 抖动的 `MoveWindow` 用物理坐标，进程已 DPI-aware。
3. **单一写者**：`fleet-pulse.json` 只由聚合器写，桌宠只读；不让 Rust 解析多源、不让 runtime.js 碰 state/。
4. **进程级易失性**：聚合器 1s 心跳若随 DSH 进程消亡，桌宠会停在最后一帧——`fleet-pulse.json` 需带 `updated_at`，Rust 发现超过 N 秒未更新则回退 idle（"stale 保护"），避免"假忙碌"。
5. **原子写**：tmp + rename，防半截 JSON。
6. **不硬编码桌面绝对路径**：workspace 定位走 exe 旁或配置，保证换机可用。

---

## 8. 验收标准

| 编号 | 场景 | 期望 | 自证方式 |
|---|---|---|---|
| AC-1 | 无任务空闲 | 桌宠 idle 浮动，无气泡 | 观察 + pulse.fleet_state=idle |
| AC-2 | 派单 claude（running） | 1~2s 内切 busy 立绘 + 「claude 跑 t-xxxx」气泡 | 真实派单 t-000x + pet.log |
| AC-3 | 预算达 80% | warn 暖黄辉光 + 「预算 8x%」气泡 | 人为调低 budget 后派单（-CheckOnly 亦可触发 pulse） |
| AC-4 | 预算熔断(exit 4) | alert 绯红辉光 + 抖动 + 熔断气泡 | 人为把 budget 调到低于当日 cost 派单 |
| AC-5 | 任务 blocked(exit 3) | warn/alert + blocked 气泡 | 复现 t-0005 console 过期路径 |
| AC-6 | 聚合器停摆（stale） | 超时回退 idle，不假忙碌 | 杀心跳脚本，等 N 秒观察 |
| AC-7 | 无 pulse 文件 | 桌宠退回 DOM 思考强度模式，A 功能不受损 | 删除 fleet-pulse.json 重启 |

---

## 9. 风险与开放问题

1. **`waiting_approval` 依赖 B 侧先落地"审批"显式状态**——当前是预留字段，v1 `waiting` 态可先用 blocked 兜底触发。
2. **1s 轮询功耗**：读单个小 JSON + mtime 门控，开销可忽略；如仍在意可拉长到 2s。
3. **多 workspace/多壳实例**：当前假设单实例（已有单实例锁），fleet-pulse 路径固定；多项目场景需 workspace 参数化（超出本期范围）。
4. **面板可见性欠账**：本方案**不依赖面板**，反而在面板落地前提供一个可用的状态出口——可优先于 P0 面板收尾单独交付，二者互补。

---

## 10. 落地顺序建议（给 Operator 的决策）

推荐先做 **阶段 0（纯 B，半天，可独立自证）** → 评审 `fleet-pulse.json` 契约无误 → 再做 **阶段 1（Rust watchdog）** 打通显形 → **阶段 2 告警视觉** 收尾即达到"能用且好看"。阶段 3 随 B 的 P2 台词/M4 审批流自然合流。

这样第一天结束就能看到"派单 → 桌宠变忙 → 完成回 idle"的完整闭环，是投入产出比最高的切法。
