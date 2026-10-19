# 桌宠 P0：互动分级 + Emote 动作族 + 甩出抛掷 + 心情系统（2026-10-18）

> 状态：**已实施完毕（单测 27 例 + 反向验证三类全转红 + 静态回归 44/44），待构建部署 + 用户实机走查（E36）**。
> 触发：用户放入三个参考仓库（`_refs/coopanion/` / `_refs/garfield-whale/` / `_refs/whale-resources/`，
> 2026-10-17）后要求「要一些新功能，动作表情什么的」，本文对标后提出 P0–P3 批次，
> 用户拍板**先做 P0 四件套**（互动分级 + 咬手 / Emote 动作族 / 甩出抛掷 / 心情 ambient）。
> 前置文档：[`pet-v5-motion-plan.md`](pet-v5-motion-plan.md)（L0/L1 已落地，L2 新姿态语义不在本文）、
> [`2026-10-17-pet-drag-sprint.md`](2026-10-17-pet-drag-sprint.md)（R16–R19 拖动，本文 F3 的直接前置）、
> [`2026-10-17-pet-fullscreen-sfx-sprint.md`](2026-10-17-pet-fullscreen-sfx-sprint.md)（R20-a/b/c，程序化音效链在本文复用）。

---

## 0. 结论先行

1. **P0 四件全部零素材**：不出一张图、不录一个音频文件，靠**绘制层编舞**（`xform.rs` 纯函数）、
   **程序化音效**（`gen-sfx.mjs` 参数表 +5）与**窗口层状态机**（既有定时器节拍）实现。
   参考仓库最好玩的四个玩法（摸头咬手 / 表情动作 / 甩出去 / 性格反馈）全部落在我们已有的架构长处上。
2. **「转圈」经几何核算后不做**（记录理由，§3.2.2）：角色 270px 高、pivot 在底边中心，
   旋转 θ 的水平伸出 = `w/2·cosθ + h·sinθ`，窗口半宽仅 143px ⇒ **旋转上限 ≈3.7°**。
   这正是 SWAY 取 2°、DRAG_LEAN 取 2.5° 的根因；完整旋转需把角色缩到 ~50% 才不裁，观感代价过大。
   Emote 的旋转类动作一律 ≤3.0°（单测钉死），「转身」改用**镜像翻转**实现（`blit` 加 flip 参数）。
3. **F1 咬手是零素材复刻 garfield-whale 的王牌彩蛋**：连续摸头 5 次 ⇒ 桌宠「咬住光标」
   跟随 1.2s（颤抖 + chomp 音）+ 60s 冷却。跟随 = 窗口跟着光标走，不占新定时器
   （搭 `IDT_HIT` 10ms 轮询）。
4. **心情值（mood）不落盘**：会话级 i32，进 `pet.json` schema 的收益不抵迁移成本；
   作用面 = ambient 加权与 emote 触发（纯函数可单测）。

## 1. 参考出处与差距

| 参考玩法 | 出处 | 我方现状 | P0 对策 |
|---|---|---|---|
| 戳/摸头/拎起/甩出互动分级 | Coopanion §互动、garfield-whale §相处 | 单击=跳、双击=挥、拖动=拎；**无摸头、无抛掷** | F1 悬停摸头 + F3 甩出 |
| 连续摸 5 次咬住手 + 冷却 | garfield-whale（用户验证最好玩） | 无 | F1 咬手状态机 |
| 表情 18 / 动作 14（LLM 词表驱动） | Coopanion `pet_say`/`pet_act` | 六态姿态 + jump/wave/wander/ambient | F2 Emote 族 7 种（绘制层编舞子集；LLM 驱动版不做——信号源用本地事件） |
| 性格反馈（回应模式/记忆） | Coopanion 记忆 PARTNER.md | 无 | F4 心情值 → ambient 加权（本地印象，不进 LLM） |
| 待机动作轮盘（5 态） | garfield-whale 双击轮盘 | 无 | 不在 P0（UI 需要预制图标；whale r7–r10 变体池在 P1） |
| 表情气泡标 / 头顶工具图标 / 语音 / OBS / 装扮 | Coopanion / garfield-whale | 无 | P1–P3（见 §2） |

**为什么不照搬 Coopanion 的 LLM 词表**：我方桌宠的信号源是 DSH 官方契约（六态心跳），
表情由**本地事件**派生（互动/状态/时钟），不解析模型输出——零 LLM 依赖、零新通道、
判据全部可单测。LLM 驱动版作为 P3 候选记录（需给 persona 预设加标记协议）。

## 2. 范围

| 做 | 不做（记录去向） |
|---|---|
| F1 悬停摸头 → 点头 + pat 音；连摸 5 次 → 咬手跟随 + chomp 音 + 冷却 | 对白气泡文本（新气泡帧）→ **P1** 随表情气泡标记帧一起做 |
| F2 Emote 七种：Nod/Shake/Turn/Shiver/Dance/Look/Sleep（绘制层编舞） | 转圈（360°）——几何不可行，§3.2.2；坐下/扑腾等需素材 → **P2** 表情精灵表 |
| F3 快甩松手 → 抛掷飞行（重力 + 边缘反弹 + 落地挤压） | 抛掷咬手/投喂交互 → 无排期 |
| F4 心情值（7 类事件）+ ambient 加权 + emote 触发 | 心情落盘/心情可视化（脸色）→ 无排期 |
| 音效 +5：pat/chomp/whoosh/bounce/yawn | 分类静音 → 维持总开关（R20-b 口径） |
| 新增**零设置项**（无面板改动、无 hash 字段） | 「互动反馈」开关组 → 等真实需求 |

## 3. 逐项设计

### 3.1 F1 · 互动分级：摸头与咬手

#### 3.1.1 判定（纯函数，`model.rs`）

```rust
pub(crate) enum PetEvent { None, Stroke, Bite }

pub(crate) struct Petting {
    hold_since: Option<Instant>,   // 当前连续命中段的起点（None = 未在命中中）
    strokes: u32,                  // 计数窗口内的累计抚摸次数
    window_since: Instant,         // 计数窗口起点（BITE_WINDOW_MS 到期清零重计）
    cooldown_until: Option<Instant>, // 咬手冷却截止（Some = 冷却中，抚摸无反应）
}

/// 每个 IDT_HIT 拍（10ms）调用一次。`on_hit` = 光标命中角色不透明像素
/// （调用方用 `is_transparent_at` 的反值，与 R2 穿透判定同源）。
pub(crate) fn petting_tick(st: &mut Petting, on_hit: bool, now: Instant, hold_ms: u64) -> PetEvent
```

**实施期订正（设计稿写的「位移 ≤ 24px 才算摸」已删除）**：判据只有一条——**光标连续
命中角色 ≥ `PET_HOLD_MS`**。理由：① 「在头上来回划」正是抚摸（参考实现的摸头就是这个
动作），位移上限会把真抚摸挡掉；② 静止的手也有 ±1px 抖动，40 拍累计足以顶到上限，
判据在边界上抽风；③ 划过（离开角色）/ 按下（点击或拖动）都会打断连续性，`on_hit`
一条就够。首版测试还因此暴露一个**模拟失真**：两段抚摸之间不喂 `on_hit=false` 的拍，
回来第一拍会拿着旧的起算时刻立刻补一下——那是测试失真不是产品缺陷（真实系统里
光标离开的每一拍都在清 hold）。

规则（单测逐条钉死）：① `on_hit` 假 ⇒ 本段作废重计；② 连续命中 ≥ `hold_ms` ⇒ **一次
Stroke**，本段重新起算（摸着不放 = 一下一下地摸）；③ 窗口内累计 ≥ `BITE_STROKES` ⇒
**Bite** + 进冷却；冷却期内直接无反应。

#### 3.1.2 反应（窗口层，`window.rs`）

| 事件 | 动作 | 音效 | 心情 |
|---|---|---|---|
| Stroke | 挂 `Emote::Nod`（600ms）+ 呼吸加速不需要（点头即反馈） | `pat` | +10 |
| Bite | 脱离停靠/peek（同拖动起手口径：`peek_reset` + `docked_edge=None`）→ 记录咬合偏移 → `Emote::Shiver`（cling 全程）→ **窗口跟随光标** BITE_CLING_MS → 结束留在原地（`apply_dock` + 落盘 + `render_dot`） | `chomp` | −20 |

- **咬合偏移**：Bite 时记 `cursor - pos`（光标此刻必在角色上——Stroke 的前置就是 on_hit），
  cling 期间每 `IDT_HIT` 拍 `MoveWindow(cursor - offset)`。不做「头部吸附」——P0 只做
  「整个人咬住不放跟着手跑」，头部区域判定留 P1（需要按角色分带）。
- **冷却期**（60s）抚摸无反应（`petting_tick` 内部已挡）；点击/拖动照常（咬手不是锁定）。
- cling 中被按下 ⇒ 立即结束 cling（`WM_LBUTTONDOWN` 分支），落盘收尾。
- **为什么搭 IDT_HIT 不新开定时器**：该轮询本就每 10ms 跑（R2 穿透判定），且已取光标位与
  on_hit——零新增系统开销；新增定时器要新的 id 与挂表/销毁路径，纯负担。

### 3.2 F2 · Emote 动作族（绘制层编舞）

#### 3.2.1 模型与相位

- `Action::Emote { kind: EmoteKind }`，kind ∈ `Nod | Shake | Turn | Shiver | Dance | Look | Sleep`。
  走**现有动作槽** ⇒ 自动继承「到期即清」与「六态压制」（`pick_state_row`：非 Idle 态
  Emote 被状态压住；Idle 态 `slot_row(Emote)` → `"idle"` 基础姿态 + 变换编舞）。
- 编舞纯函数（`xform.rs`）：

```rust
/// p ∈ [0,1]（调用方按 slot 已播比例算）。返回 (变换, bob 增量)。
pub(crate) fn emote_xform(kind: EmoteKind, p: f32, motion: f32) -> (DrawXform, f32)
```

| kind | 编舞 | 时长 | 旋转 | bob |
|---|---|---|---|---|
| Nod 点头 | 上下点一次（bob 正弦 + 落底微压） | 600ms | 0 | ±6px |
| Shake 摇头 | 两次快摆（正弦 ×2 频率） | 600ms | ±3.0° | 0 |
| Turn 转身 | 前半挤到 0.85 → **中点翻转** → 后半回 1（「回头看一眼」） | 700ms | 0 | 0 |
| Shiver 发抖 | 高频确定性抖动（sin 复合，非随机） | 520ms（Bite 时 1200ms） | ±1.5° | ±1px |
| Dance 跳舞 | 摇摆 ±3° + 节拍 bob + 两拍挤压 | 1600ms | ±3.0° | ±4px |
| Look 张望 | 左-右-左三摆（幅度递减） | 800ms | ±2.5° | 0 |
| Sleep 睡觉 | 呼吸周期 ×2.5、幅度 ×1.2、**关摇摆**（lasting，直到被交互/早晨打断） | 10min 续期 | 0 | ±3.6px |

- **两条硬约束（单测钉死）**：
  ① 任何 kind 任何相位 `|rot| ≤ sway_max_rad()`（= SWAY_MAX_DEG × MOTION_MAX = 3.2°）——
     布局余量 `sway_layout_margin` 只预留了这么多，超出必裁底边；
  ② **动效强度不缩放旋转幅度**（固定编舞）。motion=1.6 时若缩放，Dance 会到 4.8°
     （水平伸出 146.8px > 半窗 143px ⇒ 裁切）。motion 只缩放 bob。理由写入函数注释。
- **Turn 的 flip 落在 blit 参数而非 DrawXform**：`DrawXform::new` 的缩放夹取
  （`XF_MIN_SCALE..XF_MAX_SCALE`）是防「逆变换除零污染整帧」的安全边界，
  不为一个动作放宽到负值；flip 是源采样时一行镜像（`sx = fw - ux`），
  不改任何安全性质。`blit_center_bottom` 加 `flip: bool` 参数，三个调用点传 false。
- **Sleep 的压制是免费的**：它占住动作槽 ⇒ wander/ambient 的 `action.is_none()` 门
  自动挡住；台词气泡照常（睡话呢喃）。起始播 `yawn`；`WM_LBUTTONDOWN` 的 interrupt
  清单加 `Emote`（点击/抚摸/咬手都能叫醒）。

#### 3.2.2 「转圈」为什么不做的几何账

角色在图集分支的绘制尺寸：高 `CELL_H=270`、宽 `270×192/208≈249`，pivot 在底边中心，
窗口半宽 143px。旋转 θ 时顶角水平伸出 = `w/2·cosθ + h·sinθ`：

| θ | 伸出 | 判定 |
|---|---|---|
| 2°（SWAY） | 124.5+9.4 = **133.9** | ✅ |
| 2.5°（DRAG_LEAN） | 124.5+11.8 = **136.3** | ✅ |
| 3.0°（Emote 上限） | 124.5+14.1 = **138.6** | ✅ |
| 3.7° | 124.5+17.4 = **141.9** | 几何极限 |
| 45° | 88+191 = **279** | ❌ 需缩到 0.51 |

⇒ 360° 旋转中段必须把角色缩到约一半才不裁，「转圈」变成「缩成球转」，读感损失大。
**P0 不做，P2 若做需连带评估「缩放补偿旋转」的观感**（记录在案，避免后来者重复推演）。

#### 3.2.3 触发源（全部本地事件）

| 源 | kind |
|---|---|
| Stroke（摸头一下） | Nod |
| Bite（咬手） | Shiver（cling 时长） |
| wander 撞墙中断 | Look（回头张望） |
| 23:00–07:00 且 Idle 无动作 | Sleep（每 10min 续期；早晨或交互打断） |
| ambient 池按心情加权（§3.4） | High：Dance / Low：Shiver·Look / Mid：Turn·Shake |

### 3.3 F3 · 甩出抛掷

- **入口**：`release_drag` 判 `|drag_vel| ≥ THROW_VEL_MIN`（600px/s）⇒ 进飞行
  （代替 R18 滑停；慢放仍走滑停，行为不变）。
- **物理**（纯函数，`xform.rs`，紧邻 `DragSpring`）：

```rust
pub(crate) struct FlyState { pub pos: (f32, f32), pub vel: (f32, f32), pub bounces: u32, pub age_ms: u32 }
pub(crate) enum FlyHit { None, X, Y } // 本拍命中的轴（触发挤压 + bounce 音）
pub(crate) fn fly_step(st: &mut FlyState, dt_ms: u32, bounds: (i32, i32, i32, i32)) -> FlyHit
```

重力 `FLY_GRAVITY=2600px/s²`；碰工作区边反弹 `FLY_RESTITUTION=0.55`（y 轴落地同样反弹）；
`bounds` = 桌宠所在显示器**工作区**（`monitor_workspaces` 取包含 pos 者，取不到回主屏），
调用方按窗口物理尺寸收窄。dt 夹 100ms 上限（同拖动口径），半隐式欧拉。
- **结束**：速度 < `FLY_END_VEL`（140px/s）且 `bounces ≥ 1`，或 `FLIGHT_MAX_MS`（2.5s）兜底
  ⇒ `finish`（`apply_dock` + 落盘 + `render_dot` + `drop` 音）。
- **互斥**：飞行是位移源 ⇒ wander/ambient 守卫加 `flying.is_none()`（同 `!drag_settling` 先例）；
  起手即 `peek_reset` + `docked_edge=None`（同拖动起手）；compose 的 `drag_lean_now`
  加飞行态（倾斜观感延续到落地）。
- 日志：`throw start v=(…)` / `bounce (…)` / `fly end (…)` 三行成对可取证。

### 3.4 F4 · 心情值与情绪化 ambient

```rust
pub(crate) enum MoodEvent { Stroke, Bite, Throw, Hop, Wave, Done, Neglect }
pub(crate) fn mood_apply(mood: i32, ev: MoodEvent) -> i32;   // clamp [-100, 100]
pub(crate) fn mood_band(mood: i32) -> AmbientBand;           // Low(≤-25) / Mid / High(≥+25)
```

| 事件 | Δ | 源 |
|---|---|---|
| Stroke | +10 | 摸一下 |
| Bite | −20 | 被咬 |
| Throw | −6 | 被甩出去（它害怕） |
| Hop / Wave | +4 / +3 | 单击 / 双击 |
| Done | +6 | 任务完成庆祝 |
| Neglect | −4 | 每 10min 无交互（`last_interaction` 判据，已有字段） |

- ambient 加权（纯函数 `pick_ambient_pool_index_weighted(rnd, last, [u32;3])`，
  **保留不重复规则**——E5 纪律）：Low=[1,1,3]（wait 多，蔫）/ Mid=[1,1,1]（现状）/
  High=[3,2,1]（wave 多，欢）。`AMBIENT_JUMP_PCT=15` 保留。
- emote 进 ambient：High 25% Dance、Low 25% Shiver/Look、Mid 15% Turn/Shake
  （与行内 ambient 二选一，纯函数 `ambient_wants_emote(band, rnd) -> Option<EmoteKind>`）。
- mood 不落盘、无 UI（P0 只通过行为间接可感）；日志行 `mood=<n> band=<b>` 随 stroke/bite 落盘 ⇒ 实机可取证。

## 4. 音效新增（+5，gen-sfx.mjs 参数表）

| 文件 | 参数（初值） | 触发 |
|---|---|---|
| `pat.wav` | square 900→1400Hz 0.06s（橡胶鸭吱）+ noise bp 2000→1200 | Stroke |
| `chomp.wav` | seq：noise bp 800→300 q2 0.05s + 0.08s 处第二口 + sine 120→60 0.08s | Bite |
| `whoosh.wav` | noise bp 300→1800 q0.7 0.25s vol 0.12 | 抛掷起手 |
| `bounce.wav` | sine 240→120 0.08s + noise bp 600→250 | 飞行撞边 |
| `yawn.wav` | sine 420→170 0.5s vol 0.10 + noise lp 400 | Sleep 起始 |

`SFX_NAMES` 8→13；`assets.rs` 登记 +5；`gen-sfx.mjs --check` 闸门自动覆盖（生成器即台账）。

## 5. 与既有机制的关系（不变量清单）

1. **六态优先级不变**：Emote 是动作槽的一种，`pick_state_row` 的
   `Waiting > FleetBlocked > Error > Done > Thinking > Idle` 链条零改动；审批/告警在场
   Emote 被压（与 jump/wave 同命运）。
2. **命中判定零改动**：Emote 的旋转/flip 全部写进最终合成缓冲 ⇒ `is_transparent_at`
   天然一致（v5 §3.3.1 架构红利的延续）。**不得**为 Emote 引入独立于 buf 的命中层。
3. **位移源互斥**：dragged / drag_settling / flying / peek 四者守恒——
   wander 与 ambient 的守卫随 F3 增加 `flying.is_none()`；Bite 起手照拖动起手清 peek/dock。
4. **主线程纪律**：`petting_tick` / `fly_step` / `emote_xform` 全是纯函数或局部量，
   33ms 主路径零新增分配；音效只在事件点播（R20-b 口径）。
5. **零新 GDI 对象、零新定时器**：咬手跟随搭 `IDT_HIT`，飞行搭 `IDT_DRAG`，
   睡眠搭 compose 时间戳（照 `next_quote` 模式）。
6. **零设置项**：不碰 `settings.rs` / `main.rs` ps* / 面板 client.js ⇒ 无 hash 契约风险。

## 6. 性能与稳定

- `petting_tick`：每 10ms 一次、几微秒级整数比较；
- `fly_step`：每 8ms 一次、f32 运算（与弹簧同量级）；
- `emote_xform`：每帧一次（仅 Idle 且有 Emote 槽时才算，其余早退）；
- mood 衰减：10min 一次时间戳比较；
- 抖动/编舞全部用 sin 复合（确定性）——**不用随机**：随机抖动不可单测、
  且 `rand_u32` 在 33ms 路径上每次调用是 FFI。

## 7. 单测清单（实施后实况）

| 文件 | 例 | 判据 |
|---|---|---|
| `model.rs` | 11 | petting_tick 四条（持续命中才一下 / on_hit 断档重计 / 5 下咬手 + 冷却 / 窗口过期清零）+ `throw_triggered` 边界（含等号/竖直/NaN/斜向）+ mood 两条（clamp 与符号 / 档位边界）+ 加权选行两条（**首抽分布严格等于权重表** / 不重复）+ emote 概率有界 + 时长表 + Emote 行选择 |
| `xform.rs` | 11 | emote 七条（旋转 ≤ 预留余量含 load-bearing 峰值断言 / 两端回中性 / **motion 只缩放 bob 不缩放旋转** / Turn 中点蓄力 / Sleep 深慢呼吸有界 / 退化入参 / **逐 DPI 最坏情况不越窗**）+ fly 四条（重力反弹衰减且恒在界内 / 侧墙 X 反弹 / 结束判据要求先弹过 / dt 边界） |
| `sfx.rs` | 0（名表契约测试自动覆盖 +5） | `every_declared_sfx_resolves_to_an_embedded_asset` 随 `SFX_NAMES` 扩展 |
| `window.rs` 源码契约 | 5 | 咬合跟随与收尾落盘 / throw 分流（调纯函数门）/ DOWN 松口 + interrupt 含 Emote / flying 闸 wander 与穿透 / 两绘制分支消费 emote + flip 三处 |
| `gen-sfx.mjs --check` | 闸门 | 13 个 WAV 与生成器逐字节一致 |

## 8. 验收判据（实施后入回归矩阵 E36）

> 编号说明：**E35 已被同日的 R20-c halo 占用**（见矩阵 2026-10-18 条），本批取 E36。

1. 光标停在角色上约 0.5s ⇒ 桌宠点头一下 + 吱一声；心情+（`pet.log` 有 `stroke mood=` 行）；
2. 连续摸头 5 次（60s 内）⇒ 桌宠咬住光标跟随 1.2s（颤抖 + 咬合声），松手留在原地；
   随后 60s 内再摸无反应（冷却）；
3. 掐住宠物快速甩动（≥600px/s）松手 ⇒ 抛飞出 + 撞边弹跳（挤压 + 嘭声），落地停住；
   慢拖慢放行为与 R18/R19 完全一致（滑停，不前跳）；
4. wander 撞墙 ⇒ 回头张望一次；
5. 23:00–07:00 静置 ⇒ 打瞌睡（呼吸变慢、哈欠一声）；点击即醒；
6. Done 庆祝 / 审批等待等六态行为不回退（优先级链未被 Emote 破坏）；
7. **主题全覆盖**：切到 inverse（三态立绘）重走 ①②③④ ⇒ 立绘同样能转身/发抖/被咬/被甩
   （绘制层编舞对三个主题一致生效）；
8. **whale 待机不重样（R21 × P1-a 合环）**：切到 whale 主题静置 ≥3 分钟 ⇒ idle 期自发小动作
   里能看到**两种以上不同站姿**（r7–r10 待机变体）；只会反复同一个姿势即红；
9. `cargo test` 全绿（新增 27 例：228 → 255）；`verify-all desktop` PASS（44/44 不变——
   音效走既有 `gen-sfx` 闸门，不增项）；
10. 构建 + 签名 + **外部终端** `deploy-local.ps1 -Force` + 重启实机走查 1–8。

> 2026-10-18 验收审查补记：实施期举证 27 例 + 反向验证三类成立；审查另修掉 6 处真缺陷
> （详见 `CHANGELOG.md` 2026-10-18（验收审查）条）——其中与本批直接相关的三条是：摸头命中
> 误用穿透策略判据（`through=always` 档自摸）、摸头 hold 在早退路径未清零（松手补出 Stroke）、
> 瞌睡 Zzz 3s 节拍被 30s 门包住。判据 ③⑤ 的实机走查请按修后行为验。

## 9. 落地记录（2026-10-18）

| 项 | 文件 | 验证 |
|---|---|---|
| Emote 词表 + 时长表 | `model.rs`（`EmoteKind` / `Action::Emote` / `emote_duration` / `slot_row` 落 idle 基础行） | 单测 `emote_durations_are_positive` / `emote_uses_idle_base_row_and_yields_to_states` |
| 摸头咬手状态机 | `model.rs`（`Petting` / `PetEvent` / `petting_tick`） | **4 例**（含「5 下恰好 1 次 Bite」与冷却全静默） |
| 心情 + 加权 ambient | `model.rs`（`MoodEvent` / `mood_apply` / `mood_band` / `ambient_weights` / `pick_ambient_pool_index_weighted` / `ambient_wants_emote` / `pick_ambient_choice`；取代 `pick_ambient_row`，均匀版纯函数删除、三例旧测试迁到加权版 `[1,1,1]`） | 4 例 + E5 三例迁移后全绿 |
| 抛掷判定纯函数 | `model.rs`（`throw_triggered`） | 1 例（边界含等号 / 竖直 / NaN / 斜向合速度） |
| Emote 编舞 | `xform.rs`（`emote_xform` 七种） | 7 例（含逐 DPI 最坏情况不越窗） |
| 抛掷物理 | `xform.rs`（`FlyState` / `fly_step` / `fly_should_end`） | 4 例 |
| P0 参数 | `config.rs`（F1/F2/F3/F4 四段常量） | 被上述单测引用 |
| 音效 +5 | `scripts/gen-sfx.mjs` 参数表（pat/chomp/whoosh/bounce/yawn）+ `sfx.rs::SFX_NAMES` 8→13 + `build.rs` 显式登记 +5 | `gen-sfx.mjs --check` 13/13 一致；`every_declared_sfx_*` 自动覆盖 |
| 窗口层接线 | `window.rs`：Petting/bite/flying/mood 四组字段；`IDT_HIT` 调 `petting_and_bite_tick`（咬合跟随 + 到期松口）；`WM_LBUTTONDOWN` 松口 + interrupt 加 Emote；`release_drag` 速度门分流抛掷；`IDT_DRAG` 飞行节拍（`fly_tick`/`finish_fly`/`fly_bounds`）；compose：心情疏忽检查、睡眠时段检查、撞墙张望、ambient 走 `pick_ambient_choice`、emote 消费进两个绘制分支；`blit_center_bottom` 加 `flip` 参数；`update_click_through` 与 wander 守卫加 flying；`ffi.rs` 加 `GetLocalTime`/`SystemTime` + `local_hour()` | 5 例源码契约 |
| 触发源接线 | Stroke→Nod+pat、Bite→Shiver+chomp、Done→mood+、Hop/Wave→mood+、throw→whoosh+mood−、撞边→bounce+挤压、Sleep→yawn | 回归 |

**回归证据**：`cargo test --bin miasaki` **228 → 255 例全绿**（1 ignored 不变）；
`verify-all desktop` **44/44**（含 `gen-sfx --check` 与内嵌 cargo test）。
**反向验证**（三类缺陷注入，全部精确转红后恢复）：① `throw_triggered` 门禁用
⇒ `throw_triggered_*` 红；② interrupt 清单去掉 Emote ⇒ `button_down_releases_bite_*` 红；
③ `DANCE_DEG` 调到 6° ⇒ `emote_rotation_never_exceeds_reserved_margin` **与**
`emote_worst_case_stays_inside_window` **双红**（几何测试是旋转超限的第二道保险）。

**实施期三项决策（设计稿之后拍的，留档）**：

1. **摸头判据删掉位移上限**（见 §3.1.1 订正）：连续命中即抚摸；来回划正是摸。
2. **抛掷门抽成纯函数 `throw_triggered`**：源码契约只能查「文本在不在」，
   「门被 `false &&` 掉」这类退化它抓不到——首轮反向验证当场证明（注入后契约测试
   竟然全绿），判定本身必须可单测。
3. **加权 ambient 的重抽必须按权重公平抽**：「取第一个 ≠ 上次的门」会把权重系统性
   吸向低索引（[1,1,3] 的 wait 档实测从 60% 被打压到 40%），且**不重复约束本身**
   会改变边际分布（wait 档平稳上限 ≈3/7）——权重是否被尊重要看 last=None 的首抽，
   两件事混在一个断言里会红得莫名其妙（首版测试就这么错的）。

**待实机（归用户，E36 判据）**：§8 的 1–6 条。**构建 + 外部终端部署**未做
（部署纪律：不在 miasaki 会话内跑，见 AGENTS.md 2026-10-17 条）。

（实施后填：逐项文件、回归证据、反向验证、实机走查结果。）
