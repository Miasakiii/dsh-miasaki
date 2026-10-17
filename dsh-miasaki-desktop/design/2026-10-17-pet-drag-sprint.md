# 桌宠拖动专项：悬浮球拖动从 0 到 1 + 拖动反馈（2026-10-17）

> 状态：**已实施完毕（单测/静态回归/反向验证全过），待构建部署 + 用户实机走查**。
> 触发：用户「桌宠拖动和悬浮球拖动是最近发现的明显问题」。
> 关联：[`pet-v5-motion-plan.md`](pet-v5-motion-plan.md)（L1 动效与 M4 弹簧尾随）、
> [`pet-reference-benchmark.md`](pet-reference-benchmark.md)（R13/R16 与参考实现证据）、
> [`CHANGELOG.md`](CHANGELOG.md) 2026-10-12/13（R16/R17/E30/E31 四次拖动障故）。
> 参考仓库快照：`_refs/coopanion/`、`_refs/garfield-whale/`、`_refs/whale-icon/`、`_refs/whale-resources/`（一次性浅克隆，本专项结束后可删）。

---

## 0. 结论先行

1. **悬浮球拖动是硬断链，不是手感问题**：[`dot_proc`](../src-tauri/src/pet_native/window.rs)（`window.rs` 内）
   只处理 `WM_LBUTTONUP`（恢复桌宠）与 `IDT_HIT`（悬停/穿透轮询）——**没有任何拖动代码、
   没有独立位置**（球的位置恒等于桌宠 `pos`）。用户现在的真实体验：按住球拖 ⇒ 球不动；
   松手 ⇒ 桌宠在**原位**弹出。本轮从 0 到 1 补上。
2. **桌宠主窗拖动的崩溃类缺陷已全部修复且有日志证据**（R13 合帧 / M4 弹簧 / R16 三修 /
   R17 捕获判据 / E30+E31 推出量，10-14 部署版 `pet.log` 最近 10 次拖动全部
   `drag start`→`drag end` 成对、停靠正常）。本轮**不重工**，只补两处：
   ① 拖动反馈空白（拖动时姿态零变化，参考实现都有专属拖动态）；
   ② 松手前跳（`end_drag` 直接对齐目标，快速甩动后弹簧残余滞后被一步抹掉）。
3. **参考实现的共同模式**（本轮核对四个仓库的原文）：
   **阈值起手 → 显式持有鼠标 → 拖动态专属视觉反馈 → 松手有结局语义**。
   我方已做到前两步（R16/R17），本轮补第三步（零素材形变）与第四步的优化（滑停放置）。

## 1. 范围与明确不做

| 档 | 内容 | 理由 |
|---|---|---|
| **P0** | 悬浮球拖动（新能力）+ 位置持久化 + 出屏兜底 | 硬断链；不依赖任何新素材 |
| **P1** | 桌宠拖动反馈（速度驱动倾斜 + 拉伸 + 拎起式微抬升）+ 松手滑停 + 阈值常量化 | 反馈空白是参考实现与我方最大差项；滑停消前跳 |
| **P2（不做）** | 「谁持有鼠标」判据收敛成独立模块（照 Coopanion `mouse-lease.cjs`） | 收益是架构整洁，非用户可感；无事故催生 |
| **L2（不做）** | 拎起悬挂姿态（抓后颈皮垂挂）、扔出重力物理 | 需素材组合或大量调参；本文只留形变层的对应物 |
| **不做** | 球停靠/磁吸、拖动跟手度设置页可调项 | 无真实需求催生；设置页要走官方控件规格，不为假设开口子 |

## 2. P0 · 悬浮球拖动设计

### 2.1 现状与交互契约

| 现状（代码事实） | 位置 |
|---|---|
| `dot_proc` 仅 `WM_LBUTTONUP` → `show_self()`、`IDT_HIT` → `update_dot_hit()` | `window.rs` 悬浮球窗口过程 |
| 球位置 = 桌宠 `pos`（窗口左上角对齐），无独立持久化 | `blit_dot(dot_hwnd, self.pos, …)` |
| 球命中/穿透查 `dot_buf` alpha（阈值 `CLICK_THROUGH_ALPHA`），悬停放大 1.08 | `dot_transparent_at` / `update_dot_hit` |
| 显隐切换时主窗只 `ShowWindow`，**不移动** | `compose` 显隐分支 |

**交互契约（新）**：

| 手势 | 行为 |
|---|---|
| 单击球（位移 ≤ 阈值） | **恢复桌宠**（现语义原样保留） |
| 按住拖过阈值 | 球跟手移动；松手后球**留在新点**，不恢复 |
| 拖动中 | 悬停/穿透轮询暂停（光标「拿着」球，态冻结）；主窗保持隐藏 |
| 拖到出屏松手 | 球回默认可见位并落盘（E30 教训：出屏 = 用户弄不回来） |
| 拖到别屏 | 随光标过去（球尺寸固定 56px，不参与 DPI 换算） |

### 2.2 状态与消息面

**新增字段**（`PetWin`）：

```rust
dot_drag_target: Option<(i32, i32)>,   // R18：球拖动合帧的最新绝对目标（同主窗 drag_target 口径）
dot_dragged: bool,                     // 球是否已越过拖动阈值
dot_press_pt: (i32, i32),              // 球拖动按下点（屏幕坐标）
dot_dragging_timer_on: bool,           // IDT_DOT_DRAG 是否已挂
```

**`dot_proc` 新消息分支**（判据全部照 R17 主窗同款，源码契约测试钉住）：

| 消息 | 行为 |
|---|---|
| `WM_LBUTTONDOWN` | `last_interaction` 刷新；记 `dot_press_pt`；`dot_dragged=false`；**`if GetCapture() != dot_hwnd { SetCapture(dot_hwnd) }`** |
| `WM_MOUSEMOVE`（`MK_LBUTTON`） | 未起手：`dx.abs()+dy.abs() > DOT_DRAG_THRESHOLD` ⇒ 起手（`dot_dragged=true`，`dot_drag_target = pos + delta`，挂 `IDT_DOT_DRAG`，记 `dot_last_tick`，日志 `dot drag start`）；已起手：`dot_drag_target = advance_drag_target(dot_drag_target, pos, delta)`（**复用主窗纯函数**） |
| `WM_LBUTTONUP` | 拖过 ⇒ `end_dot_drag()`（见 2.4）；未拖过 ⇒ `show_self()`（原语义）。**所有出口统一 `ReleaseCapture()`**（标签块，照主窗 R16 写法） |
| `WM_TIMER`/`IDT_DOT_DRAG` | `flush_dot_drag_target()`：消费最新目标，`MoveWindow(dot_hwnd)` + **`MoveWindow(hwnd)`（隐藏中的主窗同步，保证恢复时桌宠出现在新点）** + `self.pos` 更新；无新目标不移动 |
| `WM_CAPTURECHANGED` | `dot_dragged && GetCapture() != dot_hwnd` ⇒ 兜底收尾（UP 永不到达的唯一补偿路径；自我重发判据照 R17） |
| `WM_DESTROY` | `KillTimer(dot_hwnd, IDT_DOT_DRAG)` |

**`update_dot_hit` 增闸**：`dot_dragged` 时直接返回（镜像主窗 `update_click_through` 的
`!shown || dragged` 早退）——否则光标拖离球体时 10ms 轮询会把球设成穿透态。

### 2.3 为什么球不叠弹簧（与主窗的刻意分歧）

主窗 M4 弹簧（k=220 临界阻尼）服务「被拽着走」的角色物理感；**球是 56px 的功能入口**，
用户要的是「指哪打哪」的精确放置，弹簧滞后在小球上读作发飘。故球走**直接跟手**
（8ms 合帧只做「同拍重复事件合掉 + 省 MoveWindow」，不做插值）。参考侧同口径：
GarfieldZhung 主进程 16ms 光标轮询直设位置、Coopanion 页面拖拽指针锚定，均无弹簧。

### 2.4 松手分流与持久化

```text
WM_LBUTTONUP（球）
├─ dot_dragged == false ──► show_self()                 // 单击恢复（原语义）
└─ dot_dragged == true  ──► end_dot_drag():
      ① 停 IDT_DOT_DRAG
      ② 目标落在任何工作区内（containing_work(球心) == Some）
         ├─ 是 ──► save_pet_pos(self.pos, hide=true, dock=None)；日志 dot drag end -> (x,y)
         └─ 否 ──► self.pos = default_pos()；移动两窗；save_pet_pos(…)；
                    日志 dot drag end -> default x,y (offscreen fallback)
```

- `dock=None`：球**不停靠**（停靠/peek 是桌宠的空间语义，球是临时入口）。
- 持久化复用 `pet.json` v2 的 `hide=true` 形态：恢复桌宠时桌宠直接出现在球的新位置
  （`show_self` → compose 显隐分支 `ShowWindow(hwnd, SW_SHOW)`，主窗位置已被 2.2 的
  `MoveWindow(hwnd)` 同步）。
- 出屏兜底的另一半在启动侧**已存在**：`initial_pet_state` 对不在任何工作区的位置
  回默认位（`pet.json v1/v2` 两条路径都有）。

### 2.5 常量（`config.rs`，集中口径）

| 常量 | 落地值 | 理由 |
|---|---|---|
| `DOT_DRAG_THRESHOLD` | 6（Manhattan 和） | 球的单击 = 恢复桌宠是重语义，误触代价高于主窗；对齐 Coopanion 的 6px |
| `DRAG_THRESHOLD` | 4（Manhattan 和） | 主窗现值抽常量——`window.rs` 的注释已引用一个**不存在的** `DRAG_THRESHOLD`，是现存注释漂移 |
| `IDT_DOT_DRAG` | 新定时器 ID（6） | 球窗口独立挂表；节拍复用 `DRAG_COALESCE_MS`（8ms） |
| `drag_should_start(delta, threshold)` | 纯函数（`model.rs`） | 主窗与球**共用同一判定形**（初稿计划给球单写一个 `dot_drag_should_start`，实施时合并——两个调用点分家会让「球比桌宠难起手」这类差异无从解释） |

### 2.6 持久化锚点切换（实施中新发现的必需配套，`persist.rs`）

**问题**：球会被拖到**角色矩形（286×390 的底部带）放不下的合法位置**——屏幕底角、副屏顶端。
而 `pet.json` v2 的比例还原与可见性判据（`save_pet_pos` / `initial_pet_state` / `pos_visible`）
全部锚在**角色中心**：球拖到底角后重启，角色中心落在工作区外 ⇒ 位置被判「不可见」⇒
球被搬回默认位（E30 一族「位置丢失」的新形态）。

**改动**（存/恢复两侧必须同批，否则 round-trip 断裂）：

| 函数 | `hide = false`（现状） | `hide = true`（R18 新增） |
|---|---|---|
| `save_pet_pos` 的比例中心 | 角色矩形中心 | **球心**（`pos + DOT_SIZE/2`） |
| `initial_pet_state` 的还原偏移/clamp/可见性 | 角色带 | **球矩形**（56×56，窗口左上角）；`ball_pos_visible`（球心在工作区内即可见） |
| `dock` 恢复 | 生效 | **不生效**（球不停靠；球拖动落盘恒 `dock=None`） |

### 2.7 单测与契约测试

- `model.rs`：`drag_should_start`（主窗/球共用）2 例（严格大于的曼哈顿和 / 方向无关）；
  `advance_drag_target` 既有 4 例自动覆盖球的推进（同一函数）；
- `persist.rs`：`ball_pos_visible` 与锚点切换的逻辑（纯函数部分；`monitor_workspaces`
  走 FFI 不在单测内，实机判据入矩阵）；
- `window.rs` 源码契约（扩展现有 R17 测试，4 条）：
  ① `every_setcapture_is_guarded_by_getcapture_check` 改为**形态无关**扫描
  （`SetCapture(` 全扫、每处前 240 字符内必须有 `GetCapture() } != hwnd`、至少 3 处）；
  ② `dot_capturechanged_settles_only_when_capture_is_really_gone`（dot 的收尾判据必须同时含
  `dot_dragged` 与捕获归属）；③ `dot_up_splits_drag_from_click_and_always_releases_capture`
  （UP 分流 + 统一 `ReleaseCapture`）；④ `dot_drag_end_persists_and_never_leaves_the_ball_offscreen`
  （出屏判据 + 默认位 + 落盘三件套）。
  **反向验证**：注入三类旧缺陷（去掉 dot 的捕获判据 / 收尾只凭 `dot_dragged` /
  `DRAG_LEAN_MAX_DEG` 放大到 8°）⇒ 三条判据精确转红、其余 209 例不受影响。

## 3. P1 · 桌宠拖动反馈与手感

### 3.1 速度驱动的倾斜 + 拉伸 + 拎起微抬升（零素材）

新纯函数（`xform.rs`，零分配、可单测）：

```rust
/// 拖动中的「被拎着走」形变：窗口速度 → 倾斜（向运动方向）+ 拉伸 + 压缩。
/// 低速（< DRAG_LEAN_VDEAD）回中性；幅度受 DRAG_LEAN_MAX_DEG / DX / DY 限幅。
pub(crate) fn drag_lean(vx: f32, vy: f32, scale: f32) -> DrawXform
```

| 参数（`config.rs` `L1` 段） | 落地值 | 理由 |
|---|---|---|
| `DRAG_LEAN_MAX_DEG` | 2.5 | **横向不越窗的硬上限区间**：角色宽 ≈249px 在 286px 窗内，单侧余量 ≈18.4px；旋转吃掉 `CELL_H·sinθ`（270·sin2.5° ≈ 11.8px），再叠拉伸 `DRAG_LEAN_DX` 的 ≈5px ⇒ 合计 ≈16.8px，留 ≈1.6px 安全边际（初稿写 4°，实施时按真实几何压下——4° 时最坏情况右沿 306.5 > 286，角色顶部会被窗口切掉） |
| `DRAG_LIFT_PX` | 6 | 拖动 = 「被拎起来」：整姿上移 6px，同时给倾斜腾出底部余量（倾斜底角下沉 ≈5.4px，由 2px 底留白 + `sway_layout_margin` + 本值共同覆盖） |
| `DRAG_LEAN_VREF` | 1400 px/s | 达到全幅倾斜的速度参考（快拖常见区） |
| `DRAG_LEAN_VDEAD` | 120 px/s | 死区：慢拖/悬停微动不出形变，防「端着发抖」 |
| `DRAG_LEAN_DX` / `DRAG_LEAN_DY` | 0.04 / 0.06 | 沿运动方向拉伸、垂直方向压缩（轴分解 `DX·ax − DY·ay`；对角运动两轴相抵 ≈ 无形变，只留倾斜） |

**接入点**（`compose` 的两个 `DrawXform::new` 站点：三态立绘分支、行集分支）：

```text
dragged || drag_settling 时：
  sway ← 0（lean 顶替摇摆，不叠加）
  bob  ← bob - DRAG_LIFT_PX（拎起微抬升；blit_center_bottom 的 bob 正向下）
  xf   ← drag_lean(drag_vel.0, drag_vel.1, motion)     // 新字段，flush_drag_target 写入弹簧速度
  squash 脉冲仍最高优先（can_sway 同门：脉冲期间不出 lean）
```

`drag_vel: (f32, f32)` 新字段由 `flush_drag_target` 每拍写入（弹簧真实速度），
未拖动时恒 `(0,0)` ⇒ 非拖动路径零开销、零行为变化。

### 3.2 不变量（单测钉死，照 `xform.rs` 既有最坏情况测试同口径）

1. `drag_lean(0,0,_)` = 中性；`|v| < VDEAD` = 中性；
2. `|rot| ≤ DRAG_LEAN_MAX_DEG`，`sx/sy` 在 `XF_MIN_SCALE..=XF_MAX_SCALE` 内；
3. **最坏情况不越窗**：`DRAG_LEAN_MAX_DEG` + `DRAG_LIFT_PX` + 既有 `sway_layout_margin`
   下，最低点 ≥ 窗口底 `WIN_H - 2`、最高点不撞窗口顶、横向不越 `WIN_W`
   （含 200% DPI 口径——`blit_center_bottom` 全部按物理像素换算，比例守恒）；
4. `scale`（用户动效强度）生效：`scale=0` 时 lean 归零。

### 3.3 松手滑停（消前跳）

**现状问题**：`WM_LBUTTONUP` 的 `end_drag()` 直接 `MoveWindow` 到 `drag_target`。
快速甩动后弹簧还剩几十 px 残余滞后 ⇒ 松手瞬间**前跳**；且落盘位置与「看到的停止位置」
在滑停语义下才一致。

**新状态机**：

```text
WM_LBUTTONUP（dragged）
├─ dragged = false；drag_settling = true；保 IDT_DRAG；**不** MoveWindow、**不**落盘
│    （ReleaseCapture 照旧在出口统一执行）
└─ IDT_DRAG 每拍：flush_drag_target() 继续收敛
     └─ 双轴 spring_at_target ⇒ 停表；drag_settling=false；
        apply_dock() → save_pet_pos() → render_dot()；日志 drag end -> (x,y) dock=…
```

- **正常路径不 snap**：窗口自然滑到目标停止（k=220 时 250ms 内残余 <1px），
  落盘 = 滑停位置（新不变量：「落盘位置 = 用户看到的停止位置」，取代 R13 的
  「落盘 = 逻辑目标」——两者差 ≤1px，但滑停无前跳）。
- **`WM_CAPTURECHANGED` 兜底路径不变**（R16 语义）：立即 `end_drag` + `apply_dock` +
  落盘 + `drag aborted` 日志。失败路径优先 robustness，不追加滑停复杂度。
- **滑停中被再次按下**（`WM_LBUTTONDOWN` 的残留清理）：若 `drag_settling`，
  先 `finish_drag_settle()`（apply_dock + 落盘）再清状态——否则位置不落盘，
  下次启动桌宠跳回旧位（新引入的回归面，判据入矩阵）。
- **滑停期拦住散步**（实施中发现）：wander 触发条件原为 `!self.dragged`，而滑停的
  ≤300ms 内 `dragged` 已清零 ⇒ 补 `!self.drag_settling`。不补的后果与 R16 同型：
  wander 每帧直接改 `self.pos.0`，而 `IDT_DRAG` 的弹簧也推 `self.pos` ——
  **两个位移源抢同一个量**（桌宠边滑边自己横走）。
- 慢拖/点一下（松手时弹簧已到位）：首拍即 settle，行为与现版一致。

### 3.4 阈值常量化

`window.rs` 拖动起手分支的魔数 `4` → `DRAG_THRESHOLD`（`config.rs`），注释引用从此为真。

## 4. 验收判据（实施后入回归矩阵，编号 E33）

**悬浮球（先读 `pet.log` 的 `dot drag` 行再看屏）**：

1. 按住球拖 ⇒ 球跟手移动，松手后球留在新点、**不恢复桌宠**；日志有成对
   `dot drag start` / `dot drag end -> (x,y)`；
2. 单击球（不拖）⇒ 桌宠在球的**当前位置**恢复（原语义，`hide` 落盘同步）；
3. 把球拖出工作区松手 ⇒ 球回默认可见位并落盘，日志有 offscreen fallback 行；
4. 拖球到副屏松手 ⇒ 球在副屏正常显示（56px 固定，无 DPI 参与）；
5. 拖动中光标离开球体 ⇒ 球不变成穿透态、不被「让穿」到下层窗口（`update_dot_hit` 闸）；
6. 把球拖到屏幕底角 ⇒ **退出重启后球停在原处**（隐藏态按球心存/恢复，E30 一族
   「位置丢失」的对应判据）。

**桌宠**：

7. 拖动中桌宠向运动方向倾斜（≤2.5°）并拉伸、整姿微抬升；停止即回中立，不残留形变；
8. 快速甩动（≥1400px/s）松手 ⇒ 桌宠 ≤300ms 内自然滑停，**不前跳**；落盘位置 = 滑停位置；
9. 回归不改：轻点走单击语义、四边停靠正常（E30 六行照旧）、`through=always` 档可拖。

**工程**：

10. `cargo test` 全绿（新增 9 例：`drag_lean` 4 + `drag_should_start` 2 + 契约 3；
    基线 203 → **212**），三类旧缺陷反向验证精确转红；
11. `verify-all desktop` PASS（**40/40**）；构建 + 签名 + `deploy-local.ps1` +
    重启后按 1–9 实机走查。

## 5. 落地顺序（**已实施完毕**，2026-10-17）

1. `config.rs`：常量（`DRAG_THRESHOLD` / `DOT_DRAG_THRESHOLD` / `IDT_DOT_DRAG` / `DRAG_LEAN_*` / `DRAG_LIFT_PX`）；
2. `xform.rs`：`drag_lean` + 4 例单测（含逐 DPI 最坏情况不越窗）；
3. `model.rs`：`drag_should_start`（主窗/球共用）+ 2 例；
4. `window.rs` 主窗侧：`drag_vel` 字段 + lean 接入两处 xf 站点 + 松手滑停状态机 +
   阈值常量替换 + wander 滑停闸；
5. `window.rs` 球侧：字段 + `dot_proc` 消息面 + `end_dot_drag` / `flush_dot_drag_target` /
   `update_dot_hit` 闸 + 日志；
6. `persist.rs`：`ball_pos_visible` + 存/恢复两侧的球心锚点切换（§2.6）；
7. `window.rs` 源码契约测试 4 条（形态无关捕获扫描 + dot 收尾判据 + UP 分流 +
   出屏兜底三件套）+ 三类旧缺陷反向验证；
8. `cargo test`（212 例全绿）→ `verify-all desktop`（40/40）→ 构建 + 签名 +
   `deploy-local.ps1` → 实机走查（判据 §4）；
9. 文档同步：`README.md` 桌宠段（悬浮球可拖）、`design/CHANGELOG.md` 本条、
   回归矩阵 §3.0 + E33 台账行、`pet-reference-benchmark.md` 补 R18（参考仓库对比证据）。

## 6. 参考仓库证据留档（本轮核对原文的结论）

| 仓库 | 拖动相关事实 | 本轮采纳 |
|---|---|---|
| Coopanion（`_refs/coopanion`，351★） | `mouse-lease.cjs`：鼠标租约（页面申报命中才持鼠、租约续期 + 重断言）；`kit/body.js`：6px 阈值、`grab()` 拎起 + 悬挂 + 拉伸 + `dragged` 表情；`electron-main.cjs`：`pet:followCursor` 拖到别屏窗口跟随 | 阈值口径（球 6px）、拖动态专属反馈的理念；mouse-lease 收敛留 P2 |
| GarfieldZhung（`_refs/garfield-whale`） | `main.cjs`：长按 360ms 起拖 + 16ms 光标轮询直设位置；`app.js`：拖动态表情 + 摇摆动画 | 直设位置（球无弹簧同构）、拖动态要有反馈 |
| fornarwhal/whale-icon（`_refs/whale-icon`） | 纯 DSH whale 图标资产 | 与拖动无关（图标线已有 `shortcut_icon.rs`） |
| TreapGoGo/deepseek-whale-girl（`_refs/whale-resources`） | 社区素材资源库，无代码 | 无 |

## 7. 落地记录（2026-10-17）与两条实施教训

| 项 | 文件 | 验证 |
|---|---|---|
| 拖动常量 | `config.rs`（`DRAG_THRESHOLD` / `DOT_DRAG_THRESHOLD` / `IDT_DOT_DRAG` / `DRAG_LEAN_*` / `DRAG_LIFT_PX` / `drag_lean_max_rad`） | — |
| 倾斜/拉伸纯函数 | `xform.rs`（`drag_lean`） | 4 例（中性+死区+非有限 / 方向与限幅 / **逐 DPI 最坏情况不越窗** / 与摇摆叠加必越窗故互斥） |
| 阈值纯函数 | `model.rs`（`drag_should_start`） | 2 例 |
| 主窗拖动 | `window.rs`（`drag_vel` 字段、两处 xf 站点接 lean、`release_drag` / `finish_drag_settle` / `drag_settle_tick`、`end_drag` 滑停中断落盘、wander 滑停闸、`update_click_through` 滑停早退、阈值常量） | 契约测试 + 回归 |
| 悬浮球拖动 | `window.rs`（5 字段、`dot_proc` 六个消息分支、`flush_dot_drag_target` / `end_dot_drag`、`update_dot_hit` 拖动闸） | 契约测试 + 回归 |
| 持久化锚点 | `persist.rs`（`ball_pos_visible`、`save_pet_pos` / `initial_pet_state` 的球心切换） | 回归（E33 判据 6 待实机） |
| 源码契约 | `window.rs` 测试模块 4 条 | **反向验证**：注入三类旧缺陷 ⇒ 3 条精确转红、209 例不受影响 |

**回归证据**：`cargo test --bin miasaki` **212 passed / 0 failed**（基线 203，净增 9）；
`node scripts/verify-all.mjs desktop` **40/40 PASS**。

**教训一（判据要形态无关，别枚举今天的形态）**：第一版契约把 needle 写死成
`SetCapture(dot_hwnd)`，而 `dot_proc` 实际写的是窗口过程形参 `SetCapture(hwnd)`
（捕获的就是球窗自己，语义正确）⇒ 0 命中，**被自己写的契约当场抓红**。改为扫描
`SetCapture(` 全形态后才既覆盖现状又覆盖将来。这与 E30「单测夹具喂饱 bug」是同族的
反面：**判据写窄了，比没有判据更危险**（它给出虚假的安全感）。

**教训二（松手滑停是新位移源，所有「抢 `self.pos`」的闸门要复查一遍）**：R16 给
wander 触发补过 `!self.dragged`；滑停把 `dragged` 提前清零 ⇒ 同一道闸在滑停的
300ms 内失效。补 `!self.drag_settling` 时才想清楚：**任何「提前清 `dragged`」的
改动，都要回头问一遍「R16 那批闸门还成立吗」**。
