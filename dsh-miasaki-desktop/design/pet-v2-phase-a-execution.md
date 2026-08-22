# 桌宠 v2 · 阶段 A 执行方案（动作丰富化 A0–A6）

> 2026-08-22。总览与决策见 [`pet-v2-roadmap.md`](pet-v2-roadmap.md)（§7 已拍板）。
> 本文件是**可开工粒度**的执行设计：改动点、数据结构、参数表、顺序、验证。
> 约束回顾：零依赖（FFI 全裸）、GDI 铁律（持久表面/句柄恢复/预乘 alpha）、
> 33ms 主路径零分配、frames.json v1 兼容向上。

## 0. 优先序运行时设计（compose 中行为判定自上而下）

```
1  hop_until      → jump 行（单击）
2  hop_hold       → jump 末帧定格（跳落地过渡，A4）
3  wave_until     → wave 行（双击 / ambient 偶发，A1+A5）
4  wander         → run 行 + frame-synced 位移（A5 滑步修正）
5  ambient        → wave / review / wait / jump（随机短演，A5；仅 intensity==idle）
6  focus(work/deep) → wait 行或 idle 慢放（A2）
7  idle           → idle 行 + 呼吸 bob（A3）
```

任何状态进入时 `frame_idx = 0`；`WM_LBUTTONDOWN`（含拖拽起点）打断 3/5（清 wave_until/ambient）。

## A0 — 素材全行切出（`scripts/cut-frames.mjs`）

改动：`NEEDED` 由 4 行扩为全 9 行：

```js
const NEEDED = ['idle', 'runRight', 'runLeft', 'wave', 'jump', 'failed', 'wait', 'run', 'review']
```

- 非空探测逻辑（alpha>24 采样、hit>8 才算有帧）保留；空行自动省略不入 manifest；
- 输出 `ui/pets/kurumi/frames/r{r}c{c}.png` 新增行文件；frames.json 新增键（纯增量，v1 键不变）；
- 参数：CELL_W/CELL_H 不变（192×208）。

**验收**：重跑后 frames.json 含 9 行键（每行非空列数 ≥1）；`git status` 中新帧文件可点名。

## A1 — 交互语义修复（`src-tauri/src/pet_native.rs`）

**新增字段（PetWin）**：

```rust
wave_until: Option<std::time::Instant>,   // 双击/ambient wave 播放期
```

**wnd_proc 修改**：

```rust
WM_LBUTTONDBLCLK => {
    if (*pet).main_needs_wake() { (*pet).focus_main(); }   // 决策1：最小化/隐藏 → 唤起
    else { (*pet).do_wave(); }                             // 其余 → 挥手（修复从未触发）
}
WM_LBUTTONDOWN => { /* 现有逻辑 */ (*pet).cancel_ambient(); /* 新增：打断 A5 */ }
```

**新增方法**：

```rust
fn main_needs_wake(&self) -> bool {
    self.app.get_webview_window("main")
        .map(|w| !w.is_visible().unwrap_or(true) || w.is_minimized().unwrap_or(false))
        .unwrap_or(false)
}
fn do_wave(&mut self) {                    // 与 do_hop 对称
    self.wave_until = Some(now + 1300ms);  // wave 4帧×8fps≈500ms，留余量播完一轮后回 idle
    self.frame_idx = 0;
}
```

compose 中 wave 分支：`row = "wave"`（fps 8），结束后 `wave_until=None` 自然回 idle。
注意 README「双击=挥手」描述与现状（跳+唤起）不符——本改动使文档与实现归位：
单击=跳+气泡+（最小化时）唤起，双击=挥手或唤起，右键菜单不变。

## A2 — 强度语义修正（kurumi 分支）

现状（行 467–471）：`intensity != "idle"` → `run`（原地跑，违和）。

改为：

```rust
} else if intensity == "idle" {
    "idle".to_string()
} else {
    "wait".to_string()                     // 专注/思考中：wait 行
}
```

- 对 wait 行**慢放**（见 A3 档位表）；若 frames.json 无 wait 键 → fallback 链（`map.get("wait").or_else(|| map.get("idle"))` 已隐含，显式化）→ idle 慢放；
- **run 行从此只属于 wander**（行 464–466 不变）。

## A3 — 呼吸与节奏常量（kurumi 分支）

**A3-1 呼吸 bob**：kurumi 基线（idle/wait/focus 且非行动状态）加垂直呼吸：

```rust
let bob = if row_is_calm(&row) {
    let phase = (now_ms % 3200) as f32 / 1600.0 * std::f32::consts::PI;  // 复用 whale 实现
    phase.sin() * 2.0
} else { 0.0 };
```

`row_is_calm = row ∈ {idle, wait}`；jump/wave/run 时 bob=0（动作权威，不叠加）。

**A3-2 双档位调带**（扩展现有 fps match，行 472–476）：

```rust
let fps = match row.as_str() {
    "run" | "runRight" | "runLeft" => 10,
    "jump" => 11,
    "wave" => 8,
    "wait" | "review" | "failed" => 6,     // Codex 规格值 6/6/7 → 取 6 保守
    _ => 8,
};
```

专注态慢放：`if row == "wait" && intensity != "idle" { anim_ms = 1000/4 }`（4fps 慢放档）。

## A4 — 跳跃落地过渡（无硬切）

**新增字段**：`hop_hold_until: Option<std::time::Instant>`。

compose：`hop_until` 到期时（行 461–463 分支）不直接清 None，改为：

```rust
} else if now >= until {
    if self.hop_hold_until.is_none() {
        self.hop_hold_until = Some(now + 200ms);   // 末帧定格 200ms
    }
    "jump".to_string()                              // 定格期间继续画 jump 末帧
} else { ... }
```

`hop_hold_until` 到期后清 None → 回 idle（该 tick 走正常分支，frame_idx 重置由状态切换统一处理）。
实现注意：定格期间 `frame_idx` 锁定为 `l.len()-1`（不再 +1）。

## A5 — 环境编排 + 滑步修正

**A5-1 ambient**（新增字段）：

```rust
struct Ambient { row: String, until: std::time::Instant }
ambient: Option<Ambient>,
next_ambient: std::time::Instant,   // 初始化 = now + 5500ms（首次延迟 4–7s 中点）
```

compose（仅当 intensity=="idle" && hop/wave/wander 均 None 时触发）：

```
到点(now >= next_ambient)
  → 选动作：池 [wave, review, wait] 均匀随机；jump 以 ~15% 概率替换（决策2）
  → ambient = Some{ row, until: now + rand_range(1200, 2200) }（表演）
  → next_ambient = now + rand_range(8000, 18000)（休息）
ambient 进行中 → 播 ambient.row（进入时 frame_idx=0）
到期 → ambient=None（回 idle 基线）
```

打断：`WM_LBUTTONDOWN`/`WM_LBUTTONDBLCLK`/拖拽/单击 → `cancel_ambient()`（清 ambient + 重置 next_ambient 为 now + rand_range(8000,18000)，避免打断后立刻再犯）。
**注意初始化**：`next_ambient` 初值在 create_window 时初始化为 now+5500ms。

**A5-2 滑步修正（wander frame-synced）**：现状（行 402–415）每 tick 移动 3px（33ms → 90px/s），run 帧速 10fps，步频与位移脱节。

改为：位移与帧同步——每**播放一帧**移动 9px（90px/s ÷ 10fps）：

```rust
// 在帧更新分支（anim_ms 到期处）执行：
if let Some(w) = &mut self.wander {
    self.pos.0 += w.dx * 9;
    // 贴边/超时逻辑照旧（行 405–413），仅把步进量从「每 tick 3px」改为「每帧 9px」
}
```

（帧更新 interval 与移动同步后，90px/s 速度不变，帧-位移相位一致。贴边吸附立即停，容忍 ±20% 视觉差。）

## A6 — whale 帧序列（`cut-frames.mjs` + `pet_native.rs` 兼容读取）

**素材侧**：whale 分支拆 `idle.gif` 帧：

```js
// sharp 需 { animated: true } 读多帧；逐页导出 states/idle-%02d.png
const meta = await sharp(gifPath, { animated: true }).metadata()   // meta.pages
for (let p = 0; p < meta.pages; p++) {
  const buf = await sharp(gifPath, { animated: true, page: p }).png().toBuffer()
  await fs.writeFile(`ui/pets/whale/states/idle-${p}.png`, buf)
}
```

frames.json：`"whale": { "kind":"states", "states": { "idle": ["states/idle-0.png", …], "work": "states/work.png", "deep": "states/deep.png" } }`。

**渲染侧（load_frames + states 分支兼容）**：

- `load_frames`：manifest 值若为数组 → Vec<Image>；若为字符串 → 单元素 Vec（统一帧组）；
- compose states 分支（行 427–455）：`states.get(key)` 为 Vec 时按帧循环（`frame_idx % len`，fps 6，与 kurumi 共用帧推进逻辑）+ idle 保留 bob；单帧行为不变；
- whale 帧数若 <2（gif 实际单帧）→ 保持静态 + bob，无感降级。

## 实现顺序与每步验证

| 步 | 内容 | 验证（本地可测） |
|---|---|---|
| 1 | A0 切帧 | 重跑 cut-frames，frames.json 9 行键齐全 |
| 2 | A6a 素材拆框 + states 兼容 | 重跑 cut-frames whale 段，frames.json whale.states.idle 为数组；`cargo check` |
| 3 | A3 呼吸 + 档位 | `cargo check`；主观：idle 有上下呼吸，动作行无叠加 |
| 4 | A4 落地过渡 | 主观：跳完尾帧定格 200ms 再回 idle |
| 5 | A1 交互修复（wave/dblclk） | 主观：双击=挥手；最小化主窗后双击=唤起 |
| 6 | A2 强度修正 | 主观：思考强度上升时无原地跑步，改守候/慢放 |
| 7 | A5 编排 + 滑步 | 主观：静止 60s 内 1–2 次小动作；wander 步频与位移一致 |
| 8 | 收口 | `npm run gen-init && cargo build --release --offline`；用户机 smoke-test 清单（见下） |

**用户机验证清单**（提权运行，对照 smoke-test.ps1 流程）：

1. 启动 → 桌宠正常显示、三主题切换角色正确；
2. 静止 60s：随机小动作 1–2 次，拖拽/点击即时打断；
3. DSH 触发一次长推理：桌宠转守候姿态（无原地跑），推理结束回 idle；
4. 最小化主窗 → 双击桌宠 = 唤起；还原主窗 → 双击 = 挥手；
5. 单击 = 跳 + 气泡；气泡 3s 自动收起（现有行为回归）；
6. 连续运行 30min：`pet.log` 无 GDI/句柄告警行（`[native-pet] ULW failed` 等）、任务管理器句柄数不持续增长。

## 边界（本阶段不做）

- 拖拽方向动画（runRight/runLeft 行本阶段仅备素材，切入 v3 拖拽动画）；
- failed 行暂不接入状态（素材先切出备案；彩蛋语义留 v3）；
- 气泡台词池不动（决策 4）；
- whale work/deep 帧序列（素材不存在）与 inverse 动画帧（归 C2）。
