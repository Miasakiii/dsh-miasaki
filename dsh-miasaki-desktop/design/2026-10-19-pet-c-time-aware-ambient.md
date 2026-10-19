# 桌宠 C：时段感知 ambient 编排（2026-10-19）

> 状态：**已实施（cargo test 294 → 298 例），待构建部署 + 用户实机走查（E41）**。
> 触发：用户「桌宠鲸鱼娘是不是可以有多个形象，把参考仓库纳进来？」讨论后的路线拍板 ——
> **先 C（零素材）解决眼前单调，A（多形象架构）作主干道随后**。
> 关联：参考仓库实物核查（下 §2）、[`pet-reference-benchmark.md`](pet-reference-benchmark.md) §8
> （上游本体评估，「不引入其素材」原决策）、A 批设计（`2026-10-19-pet-a-appearance.md`，另文）。

---

## 0. 结论先行

1. **时段档 `TimeBand`（Day / Evening / Night）是纯函数**，边界与睡眠段常量对齐
   （`SLEEP_START_HOUR`–`SLEEP_END_HOUR` = 23–07 为 Night；`EVENING_START_HOUR` = 18 起渐静）；
   越界小时（>23）按正午处理 —— 与 `local_hour` 失败方向一致（12），
   「误判深夜」比「误判正午」代价大（凌晨桌宠莫名安静 vs 傍晚 slightly 闹）。
2. **`row_weight` 增加时段第三入参**：深夜把 `wave`（全池最活跃）无条件压到 1
   （心情加成让位给时辰）；深夜/傍晚把安静行（`wait` 双手合十 / `idle2` 双手交叠 /
   `idle5` 尾翼弧度）抬到 2。修正**只改概率不改节目单**——任何行任何时段权重永不为 0，
   也永不新增行（池里没有的行权重多高都上不了场，P1-a 空转槽纪律）。
3. **`ambient_wants_emote` 增加时段入参**：深夜 High 档的 Dance 换张望（Look）——
   凌晨的活跃交给睡眠系统（Sleep 长槽），醒着的片刻安静点。
4. **表情帧（`ex*`）明确不入 ambient 池**——代码判据：图集分支 `calm = action.is_none()`，
   带动作槽时呼吸/摇摆全关 ⇒ 单帧行入池 = 1.2–2.2s **完全定格**，
   正是 L1(v5) M1/M2 一直在消除的「死图」（与「表情帧走 marks 1.4s 事件通道」不冲突）。
5. **「节日/时节切换」不在 C 批**——whale 帧表没有节日行，切换无对象；
   等 A 批的形象资产（自建素材链）落地后随形象一并做。

## 1. 范围

| 做 | 不做（记录去向） |
|---|---|
| `TimeBand` 纯函数 + 边界对齐睡眠段 | 节日/时节切换 → **后续形象批次**（需形象资产；A 只搭架构，未实现节日） |
| `row_weight` 时段修正（深夜降压/安静行抬升） | 表情帧入池 → **否**（§0.4 代码判据） |
| `ambient_wants_emote` 深夜不跳舞 | emote 概率随时段调整 → 不做（概率门保持心情单源） |
| 窗口层接线（ambient 点火处现取时段） | kurumi/inverse 专属时段池 → 不需要（池按主题已分流，修正按行名命中即生效） |

## 2. 现状基座（C 前的相关事实）

- **ambient 选择链**（`model.rs`，P0-F4 + P1-a 落地态）：`pick_ambient_choice(band, mode)`
  → jump 特殊概率（15%）→ emote 按心情概率（`ambient_wants_emote`）→ 主题行池 +
  行级心情权重（`row_weight(row, band)`）+ E5 不重复记忆（`AMBIENT_LAST`）。
  whale 池 = `[wave, wait, idle2–idle5]`；kurumi 池 = `[wave, review, wait]`。
- **时段基础设施已在**：`window.rs::local_hour()`（`GetLocalTime`，用户态廉价调用）+
  睡眠段判定（23–07 自动 Sleep 长槽）。**C 只是把已有的时段感知引进 ambient 编排**。
- **表情帧用途**（P2-b，2026-10-18）：`marks.rs::expression_row_for(Mark)` 事件驱动
  （摸头→exHappy 等 8 种，1.4s），与 ambient 行池是两套入口。
- **安静行的视觉核验**（2026-10-19 实图）：`r6c0` = 双手合十、`r7c0`（idle2）= 双手交叠，
  与 R21 批（2026-10-18）逐行核验记录的 `idle5`（r10）= 尾翼弧度，三者是站姿待机
  变体群中动静最低的档；`idle3`（侧身）/ `idle4`（微张双臂）居中，**不参与**时段修正。

## 3. 逐项设计

### 3.1 时段档（`model.rs`，纯函数）

```rust
pub(crate) enum TimeBand { Day, Evening, Night }

pub(crate) fn time_band(hour: u32) -> TimeBand {
    if hour > 23 { return TimeBand::Day; }              // 越界不猜深夜
    if hour >= SLEEP_START_HOUR || hour < SLEEP_END_HOUR { TimeBand::Night }
    else if hour >= EVENING_START_HOUR { TimeBand::Evening }
    else { TimeBand::Day }
}
```

新常量 `EVENING_START_HOUR = 18`（`config.rs`，与 `SLEEP_*` 相邻登记）。
**为什么 Evening 与 Night 分两档**：睡眠段桌宠真睡（动作槽被占，ambient 本就播不到），
渐静段（18–23 点）才是时段修正的**主要生效窗**——睡前不闹腾，但还没到「该睡」。

### 3.2 行权重的时段修正（`model.rs`）

```rust
pub(crate) fn row_weight(row: &str, band: AmbientBand, time: TimeBand) -> u32 {
    let w = match (row, band) { /* 现行心情权重原样 */ };
    match (row, time) {
        ("wave", TimeBand::Night) => 1,                                    // 深夜不老挥手
        ("wait" | "idle2" | "idle5", TimeBand::Night | TimeBand::Evening) => 2, // 安静行抬倍
        _ => w,
    }
}
```

- 覆盖而非相乘：`wave` 在深夜恒为 1（High 档的心情 3 让位给时辰）；其余行走心情权重。
- **永不为 0**（单测锚定全行全时段）：归零 = 从节目单删除，凌晨也可能想挥手。
- 修正按**行名**命中，与主题池天然正交：kurumi 池里没有 idle2/idle5，那些臂管不到它；
  `wait` 两主题都有，修正对两主题一致生效（合理：wait 的语义两主题相通）。

### 3.3 emote 的时段修正（`model.rs`）

```rust
Some(match (band, time) {
    (AmbientBand::High, TimeBand::Night) => EmoteKind::Look,  // 深夜不跳舞
    (AmbientBand::High, _) => EmoteKind::Dance,
    /* Low / Mid 原样 */
})
```

只动 High 档的词（Dance → Look），**概率门不变**（仍按 `EMOTE_PCT_HIGH`）——
时段调节目不调节奏，与行权重同哲学。

### 3.4 窗口层接线（`window.rs`）

compose 的 ambient 点火块内现取：`let time = time_band(local_hour());`
传给 `pick_ambient_choice(band, &mode, time)`。**不缓存**：睡眠块 30s 一拍的门控
（`shown && !fs_hidden`）与 ambient 块不同步，缓存反而多养一条失效路径；
`GetLocalTime` 是用户态调用，ambient 8–18s 点火一次，开销可忽略。

## 4. 与既有机制的关系

1. **心情与时段的正交**：心情（P0-F4）调「活跃/低落」的权重，时段（本批）调「时辰合适度」。
   两者都只改概率，节目单（行池）不变。
2. **睡眠系统不受影响**：Night 档修正是给「醒着的片刻」的；睡眠段桌宠睡自己的。
3. **E5 不重复纪律不变**：`AMBIENT_LAST` 仍是唯一写点；权重修正不改变其语义。
4. **零资产、零构建链、零新模块**：三处纯函数 + 一处接线 + 一个常量。

## 5. 单测清单（实施后实况）

| 文件 | 例 | 判据 |
|---|---|---|
| `model.rs` | 3（新）+ 3（随签名迁） | `time_band` 边界含头不含尾 + 越界归正午；`row_weight` 深夜 wave 压 1 / 安静行抬 2 / 未点名行不搭车 / **全行全时段全心情权重 ≥1**；`ambient_wants_emote` 深夜 High 恒不 Dance 且换 Look、白天傍晚 Dance 不回归、Low/Mid 词表不受时段影响；既有 `row_weight_follows_band_*` / `pick_ambient_choice_never_returns_*` / `ambient_emote_chance_*` 三测以 `TimeBand::Day` 入参保持原断言逐字通过（**Day = 现行口径**，防时段修正搭车改坏白天行为） |

**反向验证**：`time_band(99)` 越界分支首版漏写（`>= 23` 先命中 Night）⇒
`time_band_splits_day_evening_night` **当场转红**（实测，非构设）——边界测试有齿。

## 6. 验收判据（实施后入回归矩阵 E41）

1. **傍晚渐静**：18:00–23:00 静置（intensity=idle，ambient 8–18s 一次）⇒ 小动作里
   双手合十（wait）/ 双手交叠（idle2）/ 尾翼弧度（idle5）的出现频率**可见地**比白天高，
   挥手（wave）变少；白天（07–18 点）行为与本批升级前一致。
2. **深夜不跳舞**：23:00–07:00 之间、桌宠醒着时（刚交互过/免睡冷却内）⇒ 心情 High 也
   **不播跳舞**，偶尔改演张望；Wave 同样变少。深睡行为（Zzz/慢呼吸）不变。
3. **kurumi 不回退**：切狂三主题重走 1 ⇒ 行为与升级前一致（修正按行名命中，
   `wait` 共享但权重方向一致，无空转槽、无新行）。
4. **工程**：`cargo test` **298 例**全绿；`verify-all desktop` PASS；
   构建 + 签名 + **外部终端**部署 + 重启后按 1–3 实机走查。

## 7. 落地记录（2026-10-19）

| 项 | 文件 | 验证 |
|---|---|---|
| 时段档纯函数 | `model.rs`（`TimeBand` / `time_band`）+ `config.rs`（`EVENING_START_HOUR`） | `time_band_splits_day_evening_night`（Day/Evening/Night 三档边界 + 越界按正午——首实现漏写越界分支被测试当场打红） |
| 行权重时段修正 | `model.rs`（`row_weight` 第三入参） | `row_weight_follows_band_and_keeps_variants_neutral`（Day 档零修正 / 变体权重恒中性）+ `row_weight_calms_down_at_night`（含「不为 0」全量扫描） |
| emote 时段修正 | `model.rs`（`ambient_wants_emote` 第三入参） | `ambient_wants_emote_never_dances_at_night` |
| 窗口层接线 | `window.rs`（ambient 点火块现取时段） | 既有源码契约不受影响（接线点是既有调用点） |

**回归证据**：`cargo test --bin miasaki` 294 → **298 例**（297 passed + 1 ignored 手动项；
**新增 4 例**：时段边界 1 + 行权重 2 + 深夜不跳舞 1；3 个既有测随签名迁移不增例）；越界分支修复后复跑全绿。
