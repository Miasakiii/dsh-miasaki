# 桌宠动作与形变规划（L0 接线 / L1 绘制层动效）

> 状态：**L0 四条已全部落地；L1 的 M1–M3 已于 2026-09-28 落地**（见 §5），
> M4（拖动尾随，含其前置 R13 拖动合帧）待拍板。
> **§3.3 的「命中判定必须与绘制同批改造」已按本仓架构订正为不成立** —— 详见该节，
> 该条曾把 L1 的工程量估高了一档。
> 编号说明：`v4` 已被 [`2026-09-27-pet-v4-computer-use.md`](2026-09-27-pet-v4-computer-use.md)
> （Computer Use 集成评估）占用，本文件是**与之并行的动作支线**，不构成 v4 的后续。
> 前置文档：[`pet-v3-roadmap.md`](pet-v3-roadmap.md)（M1/M2 已落地，M3–M5 待做）、
> [`pet-reference-benchmark.md`](pet-reference-benchmark.md)（R11/R13/R15 的原始清单）、
> [`ARCHITECTURE.md`](ARCHITECTURE.md)（零依赖 / 33ms 主路径零分配 / 不新增 GDI 对象铁律）。

---

## 0. 结论先行

1. **本次规划的核心判据：桌宠的问题不是"素材不够"，是"已切好的素材没接上线、已上线的不动"。**
   三条一手证据：
   - kurumi `runRight` / `runLeft` 共 **16 帧**已切好、已登记进 `frames.json`、**从未被播放过**
     （`model.rs:74` 的 `slot_row` 把 `dx` 丢了，恒返 `run`）；
   - whale 的 `spritesheet.png` 是 **1536×2288 = 8 列 × 11 行** 的完整图集（79 格非空），
     而 `cut-frames.mjs` 此前**只拆了 `idle.gif`**——11 行图集零使用。
     这是**接线缺失，不是素材缺失**；本次已接入 r0–r6（46 帧，实测 2.31 MB），
     whale 第一次拥有与 kurumi 同构的六态姿态表达；
   - inverse 三态**各只有 1 帧静图**，非 idle 态完全静止——这个是**真素材缺口**，
     但按参考实现背书（§3.1），"动起来"不靠新素材，靠绘制层变换。
2. **r7 的语义改派是本轮性价比最高的一处改动**：`Thinking` 态（= 官方 `running`，
   即 agent 真在干活）当前播 `idle`（"静默守候"），而 r7 正是**坐着敲笔记本**的一手素材
   （本次视觉核验，§2.2）。改一行，工作态**第一次有可读姿态**。
3. **一处必须先建立的新认知（本次核验查出，既有文档均未记录）**：
   **图集行号是"生成模板约定"，不是跨主题语义契约。** kurumi r7 = 坐姿打字，
   whale r7 = 站姿待机；连 r0 的帧数都不同（6 vs 7）。因此
   `cut-frames.mjs:12` 的全局 `ROW_NAMES` 只对 kurumi 成立，whale 接入**必须引入每主题行名表**
   （§2.3.2），否则会把站姿当成"打字"播出去。
4. **L1 的第一条硬约束不是"加什么动效"，而是"命中判定必须与绘制同批改造"**：
   一旦引入旋转/形变，`is_transparent_at`（`window.rs:622`）仍按未变换的缓冲查表，
   就会立刻出现参考实现踩过的坑——**看得见的像素点不到、看不见的地方反而点到**
   （`pet-reference-benchmark.md` §2.3、`_refs/pet-analysis/B-interaction.md` §2.11）。

---

## 1. 分层口径

| 层 | 内容 | 素材 | 依赖 | 状态 |
|---|---|---|---|---|
| **L0** | 接线：把已存在的素材/语义接到状态机上 | 零 | 无 | 4/4 已落地 |
| **L1** | 绘制层动效：呼吸 / 摇摆 / 挤压拉伸 / 拖动尾随 | 零 | L0（行选择先正确） | **M1–M3 已落地（2026-09-28）；M4 待做** |
| **L2** | 新素材与新姿态语义（探头/攀爬/甩出物理） | 需出图 | L1（变换管线先就绪） | 不在本文件 |

排序理由沿用 `pet-v3-roadmap.md:343` 的下半句：**不建变换管线就堆素材，新玩法会被
"没有绘制变换"这个能力缺口吃掉**；而上半句（不修状态机就堆素材）已在 v3 M1 付过学费。

---

## 2. L0 · 接线（零素材）

### 2.1 L0-1 散步按方向选行 —— `dx` 不再丢

**现状证据**

| 事实 | 位置 |
|---|---|
| `Action::Wander { dx }` 的 `dx` 在行选择处被丢弃，恒返 `"run"` | `pet_native/model.rs:74` |
| `runRight` / `runLeft` 各 8 帧，**已在盘上、已在清单里** | `ui/pets/frames.json:28-47` |
| 步态位移与帧同步（每帧 9px / 10fps） | `window.rs:270`、`config.rs:112` |
| fps 表**已**为这两行准备好（10fps） | `window.rs:423` |

**改法**（`model.rs::slot_row`）

```rust
Action::Wander { dx } => if *dx >= 0 { "runRight" } else { "runLeft" }.to_string(),
```

`dx` 的取值域是 `±1`（`window.rs:223` 只产生这两种），`>= 0` 兼作 `0` 的兜底。

**连带核对（全部通过）**

- `kurumi_row` 的回退链 `["idle","wave","jump","run"]`（`image.rs:73`）不含 runRight/runLeft，
  但两条行现在**必然命中**，不触发回退；
- `calm` 呼吸判据是 `row == "idle" || row == "wait"`（`window.rs:457`）——散步不受影响；
- 撞墙中断 / 自然到期清理都不看行名（`window.rs:190-198`、`:262-283`）——逻辑不变。

**一处顺带修正**：挂 `Wander` 槽时没有复位 `frame_idx`（对照 ambient 分支 `window.rs:250` 有复位）。
方向反转时步态相位延续会造成"回头瞬间相位错位"。落地时一并补 `self.frame_idx = 0`。

**验收**：① 连续观察 ≥10 次散步，左右各半且朝向与行进方向一致（`runRight` 面朝右、`runLeft` 面朝左，
本次已视觉核验）；② `pet.log` 无新增 `ULW failed`。

### 2.2 L0-2 r7 改派给 Thinking 工作态 —— 工作态第一次有可读姿态

**现状证据**

| 事实 | 位置 |
|---|---|
| `PetState::Thinking => "idle"`（"静默守候"，与 idle 同姿态） | `model.rs:57-62` |
| `Thinking` 的来源 = 官方 `pet=thinking` ⇐ 插件 `agg.running`（= agent 真的在跑） | `plugins/dsh-pet-panel/lib/client.js:290`、`:283-292` |
| r7（行名 `run`）内容 = **坐着敲笔记本**，6 帧（眨眼 / 看屏幕 / 敲键） | 本次视觉核验（`ui/pets/kurumi/frames/r7c*.png`） |
| v3 M2.1 表把 thinking 定义为"静默守候 + 呼吸增强" | `pet-v3-roadmap.md:200` |

**订正理由**：v3 当时把 thinking 定为"静默守候"，是在**无可用素材**前提下取 `idle` 的妥协
（当时可用行只有 idle/wait）。现有 r7 = "坐着干活"的直译素材，而 Thinking 恰是"agent 在干活"，
语义严格对齐；同时它也解决了"工作态与 idle 态视觉无差别"这个可读性问题。

**改法**

```rust
PetState::Thinking => {
    // 工作态:r7 = 坐着敲键盘("在干活"的直译姿态)。wait 行仍留给审批等待;
    // busy 不原地跑步、不做小动作(真实工作状态:干活时站定)
    let _ = action;
    "run".to_string()
}
```

**连带核对**

- `run` 行**不再**被散步占用（L0-1 已把散步改到 runRight/runLeft）⇒ 无争用；
- `Done` 用一次性 `review` 槽、`Waiting` 用 `wait`、`Error`/`FleetBlocked` 用 `failed`
  —— 均不受影响；
- fps 表 `"run" => 10`（`window.rs:423`）已在位；
- whale/inverse 的 `eff_intensity` 在 Thinking 时已是 `work`（`window.rs:297-299`）——**语义同向**，
  两个主题族的"工作态"表达第一次一致；
- 既有单测 `busy_beats_gesture_and_ambient`（`model.rs:204`）的 3 处期望值需从 `"idle"` 改为 `"run"`
  ——这是**契约变更**，不是回归。

**验收**：① 发一条消息 → ≤1.5s 桌宠切到坐姿打字并持续到 agent 停；② 审批出现 → 立刻被 `wait` 压过；
③ 完成 → `review` 庆祝一次后回 `idle`（不循环）。

### 2.3 L0-3 whale 图集切帧 + 接进行选择

#### 2.3.1 事实：图集在盘上，零使用

| 项 | 事实 |
|---|---|
| 图集 | `ui/pets/whale/spritesheet.png` = **1536×2288** = 8 列 × **11 行**（192×208 网格，与 kurumi 同规格） |
| 非空格 | 79（逐格 alpha 探测，本次实测） |
| 当前切片 | `cut-frames.mjs:104-131` **只拆 `idle.gif`**（6 帧）+ 两张立绘；`frames.json` 里 whale 是 `kind: "states"` |
| 结论 | **atlas 分支缺失，不是素材缺失** |

#### 2.3.2 一手核验：行号 ≠ 语义（本次新认知）

逐行放大核验（`_refs/pet-probe/`，一次性探针，已删）：

| 行 | 帧数 | 内容（视觉核验） | 建议语义 | 与 kurumi 同行号是否一致 | 本次接入 |
|---|---|---|---|---|---|
| r0 | 7 | 站姿 + 尾鳍摆动 | `idle` | 语义同，**帧数不同**（kurumi 6） | ✅ `idle` |
| r1 | 8 | 行走，**面朝右** | `runRight` | 一致 | ✅ `runRight` |
| r2 | 8 | 行走，**面朝左** | `runLeft` | 一致 | ✅ `runLeft` |
| r3 | 4 | 举手挥 | `wave` | 一致 | ✅ `wave` |
| r4 | 5 | 双脚离地雀跃 | `jump` | 一致 | ✅ `jump` |
| r5 | 8 | 闭眼垂头（沮丧） | `failed` | 一致 | ✅ `failed` |
| r6 | 6 | 双手合十（请求 / 等待） | `wait` | 一致 | ✅ `wait` |
| r7 | 6 | **站姿 + 眨眼** | `idle` 变体 | **不一致**（kurumi r7 = 坐姿打字） | ⏸ L2 |
| r8 | 6 | 站姿 + 尾摆 + 眨眼 | `idle` 变体 | **不一致**（kurumi r8 = `review`） | ⏸ L2 |
| r9 | 8 | 站姿 + 侧头张望 | `idle` 变体 | 无对应行 | ⏸ L2 |
| r10 | 8 | 站姿 + 微动 | `idle` 变体 | 无对应行 | ⏸ L2 |

**设计结论（必须写进代码，不能只留在文档）**：

1. `cut-frames.mjs:12-14` 的全局 `ROW_NAMES` / `NEEDED` **只对 kurumi 成立**，
   必须参数化为「每主题行名表」；
2. whale 只切 **r0–r6 共 7 行 46 帧**（语义明确、覆盖六态 + 动作），r7–r10 属 idle 变体群，
   接进 ambient 池是 **L2** 的事（内嵌体积与管理面都不划算）；
3. **禁止**用"行号相同 ⇒ 语义相同"做任何推断——本次核验已经反证。

#### 2.3.3 接入方案（**档 A 已落地**）与取舍

| 档 | 内容 | 内嵌增量（**实测**） | 判定 |
|---|---|---|---|
| **A** | 切 r0–r6（46 帧），whale 与 kurumi 走同一行选择 | **2.31 MB** | **已落地** |
| B | 全切 11 行（74 帧），idle 变体进 ambient 池 | 3.64 MB | 留待 L2 |
| C | 维持三态立绘 | 0 | 与"用户抱怨动作少"直接冲突 |

> 体积口径：本次切片实测（`_refs/pet-probe/`，一次性探针已删）；kurumi 57 帧 = 2.90 MB 作基线。
> 内嵌清单在 `src-tauri/build.rs`——它是**显式登记**，本次为 whale 补上了 `pets/whale/frames` 通道
> （此前只内嵌 `states/`，图集即使切了也进不了 EXE，属"切了也不生效"的静默断链）。

**三态立绘的处置（已落地为保守方案）**

- `states` 三键（`idle` = idle.gif 拆帧 / `work` / `deep`）**全部保留在清单中**，零删除、零孤儿；
- 渲染分流（`window.rs`）：
  - whale 有行集 ⇒ 与 kurumi 同行选择（六态 + 散步 + 挥手 + 跳跃）；
  - **散步准入放宽**：由「`mode == "kurumi"` 专属」改为 `Frames::can_wander(mode)`
    ——「该主题是否具备 `runRight`+`runLeft` 两行」。whale 因此**第一次可以散步**；
    inverse 恒 `false`（否则会"平移但只能播 idle"，表现为滑步假位移）；
  - **例外：`intensity == "deep"` 且 whale 时**保留 `deep` 立绘覆盖（图集无强度语义，立绘是刻意的档位指示）；
  - `states.idle` / `states.work` 当前**无渲染用途**（被图集接管）——闸门会把它报成
    "另带立绘强度档 idle/work/deep"，是**显式登记而非隐藏 drift**；去留见 §6 待拍板 1。

**落地前置（构建链安全，已通过）**：`cut-frames.mjs` 是全量重生成。落地前实测：重跑后
**kurumi 57 帧 + whale idle 6 帧 + frames.json 共 66 个文件逐字节一致**（幂等），
故本次改动只产生"新增 whale/frames/ + frames.json 增量"，未波及任何既有素材。

#### 2.3.4 whale 的两处已知差异（预期，不是缺陷）

| 差异 | 原因 | 现状 |
|---|---|---|
| `Thinking` 在 whale 上落到 `idle`（非坐姿打字） | whale 图集 r7 是**站姿待机**，没有「坐姿工作」这一姿态（§2.3.2） | whale 的 Thinking 由图集 `idle` + `work` 强度立绘表达；kurumi 才有坐姿打字 |
| `Done` 庆祝落到 `idle`（非 `review`） | whale 图集无 `review` 行；回退链序为 `idle → wave → jump → run`，`idle` 先命中 | 可见信号由 10s 完成气泡承担；真正的庆祝表达留给 L1 挤压脉冲（零素材） |

两条都由单测 `whale_row_shares_fallback_chain` 钉住（钉的是「不落空白、不跨主题串味」）。

**验收**：① `frames.json` 中 whale 的 atlas 行数与盘上帧数一致（7 行 / 46 帧）✅；
② `check-pet-assets.mjs` PASS，whale 报 `7/9 行在位，缺 run/review` ✅；
③ 实机：whale **散步左右朝向正确**（准入已放宽，见上）且六态姿态可读（**待走查**）；
④ exe 体积增量 ≈ 2.3 MB ✅（与切片体积同量级）。

### 2.4 L0-4 订正 `check-pet-assets.mjs` 的行名声明

**现状缺陷**：`scripts/check-pet-assets.mjs:35`

```js
/** v3 六态 + 动作行：Rust 侧 pick_state_row/slot_row 可产出的全部行名（pet_native/model.rs）。 */
const RUST_ROWS = ['idle', 'wait', 'failed', 'jump', 'wave', 'run', 'review', 'runRight', 'runLeft']
```

两个问题：

1. **声明与代码不符**：修 L0-1 之前，`slot_row` 恒返 `run`，`runRight`/`runLeft` **不可产出**；
2. **两套行名空间混用（根因）**：同一个 `RUST_ROWS` 既用于 atlas 主题的覆盖报告（`:132`），
   又用于 states 主题（`:128`）——而 states 型主题（whale/inverse）的行名空间是 `idle/work/deep`，
   与 Rust 行名根本不同源，这个比对**恒为噪声**。

**改法**

- 拆成两个常量并写明出处：
  - `STATE_ROWS` = `pick_state_row` 可产出的**状态行**（`idle` / `wait` / `failed` / `run` / `review`）；
  - `ACTION_ROWS` = `slot_row` 可产出的**动作行**（`jump` / `wave` / `runRight` / `runLeft`）
    ∪ ambient 池（`wave` / `review` / `wait` / `jump`，`model.rs:177`）；
- atlas 覆盖报告用 `STATE_ROWS ∪ ACTION_ROWS`；
- states 报告**不再做行名比对**，改为一句提示（该主题为立绘三态，行名空间不同源）；
- 注释点明：行名是 **Rust 侧行名空间**，落到素材需经每主题行名表（§2.3.2），
  **二者相等是巧合、不等是常态**。

**验收**：改后 `node dsh-miasaki-desktop/scripts/check-pet-assets.mjs` 退出码 0，
且报告里 runRight/runLeft 的"可产出"与 `model.rs` 逐字对应。

---

## 3. L1 · 让静图活起来（零素材，绘制层）

### 3.1 依据

参考实现在**三个独立文件**里重复同一句架构判断（`pet-reference-benchmark.md` §2.8）：

> 旋转 / 形变**在绘制层完成、不依赖素材、不改动帧缓存与解码链**。

> 证据出处注记：参考仓库源码快照 `_refs/dsh-pet-indesktop/` 已在 2026-09-26 的空间回收中删除，
> 但逐条证据（`window_effects.py:18-95` / `golden_spin.py:5` / `throw_egg.py:34` 的原文引用）
> 已沉淀在 [`pet-reference-benchmark.md`](pet-reference-benchmark.md) §2.8 与
> `_refs/pet-analysis/B-interaction.md`，可回溯核对。

对我方最直接的含义：**inverse 三态各只有 1 帧静图**这个"真素材缺口"，可以先靠绘制变换缓解，
不必等出图。用户点名"对反转狂三最划算"——她目前是一张不会动的画。

### 3.2 现状（我方绘制层能力盘点）

| 能力 | 落地前（2026-09-27） | **落地后（2026-09-28）** | 位置 |
|---|---|---|---|
| 等比缩放 + 底部居中 + bob 位移 | **有** | 有（保留，改为经变换采样） | `blit_center_bottom` |
| 呼吸 | **仅有雏形**：只给 `idle`/`wait`（行集）与 `idle`（立绘） | **全部静止姿态**（行集 ±2px / 立绘 ±3px，周期 3.2s） | `xform::breath_offset` + `window.rs` |
| 旋转 / 非等比形变 / pivot | **无**（无变换矩阵、无逆变换） | **有**：`DrawXform`（绕底边中心 pivot），逆向映射采样 | `pet_native/xform.rs`（新） |
| 命中判定 | 查**最终**合成缓冲（本就如此） | **无需任何改动** —— 订正见 §3.3 | `is_transparent_at` |
| 拖动 | `WM_MOUSEMOVE` 逐事件 `MoveWindow`（1000Hz 鼠标 = 每秒千次） | 未动（M4 的前置 R13 仍未做） | `window.rs` |

### 3.3 设计：一个变换值，一处消费（绘制）—— 命中判定**不需要**配套改造

```
        ┌──────────── DrawXform { rot_rad, sx, sy } ────────────┐
        │                                                        │
   compose 每帧算一次 ───→ blit_center_bottom                     │
                           目标像素 → 逆变换 → 源双线性采样        │
                           → 就地写进合成缓冲 buf                  │
                                    │                             │
                                    └──→ is_transparent_at 直接查 buf  ← 天然一致
```

- **单值来源**：变换值由 `compose` 每帧计算一次（`t_ms` 只取一次），行集分支与三态立绘分支
  **共用同一份**，不允许两处各自算（参考侧 `window_effects.py` 的 `begin_rotation` /
  `unrotate_point` 双端一致原则）；
- **纯逻辑分层**：新建 `pet_native/xform.rs`——只做矩阵/逆变换/包围盒与动效相位，**无 Win32 依赖**，
  与 `model.rs` 一样可 `cargo test` 单测（对齐参考侧"纯逻辑层禁 Qt"的分层纪律）；
- **pivot 默认底部中心**，与 `blit_center_bottom` 的底部对齐口径一致
  （`y0 = WIN_H − h − 2 − sway_layout_margin(w) + bob`）。观感是「以双脚为支点左右摇」，
  而不是绕腰或绕画面中心转。

#### 3.3.1 订正：本文原列的「命中硬约束」在本仓不成立

原文（2026-09-27）写道：

> **L1 的第一条硬约束不是"加什么动效"，而是"命中判定必须与绘制同批改造"**：
> 一旦引入旋转/形变，`is_transparent_at` 仍按未变换的缓冲查表，就会立刻出现
> 「看得见的像素点不到、看不见的地方反而点到」。

**这条对参考实现成立、对我不成立**，差别在两边「命中据」的来源不同：

| | 参考实现 | 本仓（R2，2026-09-16） |
|---|---|---|
| 命中据 | 每种元素**各自维护 mask**（`pet/window.py:_sync_mask`），旋转后 mask 与画面脱钩 | 直接查**最终合成缓冲** `buf` 的 alpha |
| 旋转后 | 必须同步改造 mask，否则命中错位 | `buf` 已经是旋转后的结果 ⇒ **自动一致** |

因此本轮对命中路径**零改动**：看得见的必可点、看不见的必穿透，是「查最终缓冲」这一条
架构决定的，不是这轮补上的。**这是一处架构红利，工程量为零**——
若照原文按「双端改造」估工，L1 会被高估一档。

（保留这条订正的现实意义：将来若有人为桌宠引入**独立于 `buf` 的**命中层——比如热点区域、
多边形碰撞——那时 §3.3 原文的警告就立刻成立，必须回到「双端同源」原则。）

#### 3.3.2 包围盒：横向是不对称的（首版实现缺陷）

遍历范围取**变换后外接包围盒**（`DrawXform::bounds`，四角正向变换取极值）。
首版写成对称解析式 `±(sx·w/2·cosθ + sy·h·sinθ)`，被单测证伪：

- 底边（相对 pivot 的 y=0）只随旋转平移 `±sx·w/2·cosθ`；
- 顶边（y=−h）**整体还横移** `sy·h·sinθ` —— 正角右移、负角左移。

所以左右两侧的外扩量不同，必须分别取 min/max。现实现改为逐角求解
（每帧一次，不在像素循环里），单测同时验**不裁内容**与**最小性**两条性质。

**另一个被纠正的直觉**：包围盒**不必包含未变换的原框**。`sy < 1`（挤压的纵向压缩）时
包围盒顶边会下移，而原框上部本来就没有内容 —— 不包含才对。真正的硬判据是「不裁内容」：
框内任意点的正向变换结果都必须落在包围盒内。

**布局余量按最大角而非当前角预留**：`sway_layout_margin(w) = w/2 · sin(SWAY_MAX_DEG)`。
若按当前相位角补偿 pivot，底边基线会随相位上下浮动，摇摆就变成「边弹边摆」的复合运动；
固定余量 ⇒ 底边基线恒定，只有姿态在摇，且最低点恒不越过 `WIN_H − 2`。

### 3.4 四项动效的参数与宿主

| # | 动效 | 参数（**落地值**） | 宿主 | 状态 |
|---|---|---|---|---|
| M1 | **呼吸** | 行集 ±2px / 立绘 ±3px，周期 3.2s | **全部静止姿态**（无动作槽即可，不再只 idle/wait） | ✅ 落地 |
| M2 | **摇摆** | 绕底边中心 pivot ±2°，周期 5.6s + 相位偏移 1.3s（与呼吸错相） | 行集 `idle`（长静置）/ `run`（打字起伏）；inverse 立绘 `idle`/`work` | ✅ 落地 |
| M3 | **挤压拉伸** | `sx = 1 + 0.10·sin(πp)`、`sy = 1 − 0.15·sin(πp)`，220ms 单脉冲 | `Done` 庆祝、单击 `jump` 落地 | ✅ 落地 |
| M4 | **拖动尾随** | 位置弹簧滞后（**不改变形，改 `pos` 插值**） | 拖动全程 | ⏸ 待拍板（前置 = 拖动合帧，§3.5） |

**落地值与上表"起点值"的三处偏离（均为落地判断，不是偏差）**：

1. **摇摆取 ±2°**（1.5~2.5 区间的中间偏保守）：最宽帧（192×208 → 249.2px 宽）在 ±2° 时
   包围盒宽 258.5px，距 `WIN_W` 286 尚余 27.5px，给后续调整留余量；
2. **摇摆周期取 5.6s 并叠 1.3s 相位偏移**：与呼吸的 3.2s 既不整除、极值也不撞点——两重保证错相
   （单测 `sway_is_bounded_and_out_of_phase_with_breath` 在呼吸峰值处断言摇摆未到极值）；
3. **deep 档只呼吸不摇摆**：深度推理档取「凝神」语义，与 whale deep 保留立绘覆盖同一取舍
   （强度档优先表达档位，不再叠姿态噪声）。原表「三态立绘都摇摆」收敛为「idle/work 摇摆」——
   inverse 仍是本轮最大受益者：它此前三态**全是彻底静止的死图**。

**参数表落位**：幅度 / 周期 / 时长进 `config.rs` 的 `L1` 段（本仓常量集中处），
相位与变换的**纯函数**进 `xform.rs`，共 10 例单测（相位边界、幅度上限、脉冲两端回中性、
包围盒「不裁内容」且「最小」、最坏情况不越窗口、退化入参不打崩）——
与 `Action::*` 的「到期即清」结构同哲学。

### 3.5 拖动尾随的前置：拖动合帧（原有 R13）

现在 `WM_MOUSEMOVE` 逐事件 `MoveWindow`（`window.rs:1058-1076`）。若直接在其上叠弹簧尾随，
**同一帧的重复样本会污染滞后估计**。故顺序是：

1. 改「记最新绝对目标 + 8ms 定时器消费 + 松手强制 flush」（参考实现同款，含回归测试思路）；
2. 再用同一个目标点做弹簧插值（尾随量 = 窗口位置对目标的滞后）。

### 3.6 性能与稳定纪律（硬约束）

- **零新增 GDI 对象**：复用 `present_dib`；`TODO.md` P0「偶发全黑无响应」与频繁
  `CreateDIBSection` 强相关，不得为变换新建表面 —— ✅ 落地时未新建任何表面；
- **33ms 主路径零分配**：变换采样就地写 `buf`，不新建 `Vec` —— ✅ `blit_center_bottom`
  全程只有 f32/i32 局部量；`xform.rs` 无任何容器构造（单测里的 `Vec` 在 `cfg(test)` 内）；
- **采样质量**：286×390 ≈ 11 万像素/帧；±2° 摇摆下包围盒约 261×279 ≈ 7.3 万像素，
  仍走既有的**预乘空间双线性**（未为性能降级为最近邻）—— 比原实现多约 11% 的采样量；
- **形变上限**：`|sx−1| ≤ 0.12`、`|sy−1| ≤ 0.16`、`|rot| ≤ 8°`（常态动效），
  超限仅允许一次性动画（挤压脉冲）—— ✅ 落地值 `SQUASH_DX=0.10` / `SQUASH_DY=0.15` /
  `SWAY_MAX_DEG=2` 全部在限内；另加 `XF_MIN_SCALE`/`XF_MAX_SCALE` 夹取，
  **任何上游算错都不可能让逆变换除零**（退化入参单测钉住）。

### 3.7 验收

| # | 判据 | 状态 |
|---|---|---|
| 1 | **命中一致性（最高优先）**：形变/旋转姿态下看得见的必可点、看不见的必穿透 | ✅ **架构保证**（查最终合成缓冲），本轮零改动 —— 见 §3.3.1 订正 |
| 2 | `pet.log` 无新增 `ULW failed`；GDI 对象数不增（任务管理器对照） | 自动回归 35/35 已过；实机走查待做 |
| 3 | 逐帧采样 ≤ 33ms 预算 | 包围盒 +11%、未新建表面（§3.6）；实机打点走查待做 |
| 4 | **inverse 三态静图获得呼吸 + 摇摆**（用户点名的收益项） | ✅ 代码已接（三态呼吸 + idle/work 摇摆）；观感走查待做 |
| 5 | 视觉走查：挤压不糊边、摇摆不「歪到底」、旋转不吃掉底部 2px 留白 | 实机走查待做 |

> 实机走查的判据写法（沿用 v3 §1.5 的"改前改后比对"范式）：
> ① `pet.log` 里 `ULW failed` 计数与改前持平；② 任务管理器「GDI 对象」列不增；
> ③ 目视：反转狂三在 idle 时**有轻微左右摆**（此前完全静止）；双击时落地有**一次压扁回弹**；
> ④ 摇摆到左右极值时**脚尖不被窗口下沿切**（这是 `sway_layout_margin` 的存在理由）。

---

## 4. 与既有文档的关系

| 本文 | 既有条目 | 关系 |
|---|---|---|
| L0-1 | `pet-reference-benchmark.md` R15① | 同一件事，本文补齐"挂槽未复位 frame_idx"这一细节 |
| L0-2 | 无 | **本文新增**：r7 从"散步语义错配修正"升级为"改派给工作态" |
| L0-3 | `pet-v3-roadmap.md:296`「whale 图集未接入的行」 | 从一句待办升为可执行方案 + 行名表设计 |
| L0-4 | 无 | **本文新增**（闸门与代码不符） |
| L1 | `pet-reference-benchmark.md` R11 + R13 | 同一批能力：本文补齐参数与宿主行；**R11 相关部分（M1–M3）已落地（2026-09-28）**，R13（拖动合帧）随 M4 仍待做；原列的「命中硬约束」**已订正为对我方不成立**（§3.3.1） |
| L2 | v3 M4.4 / M5 新动作素材 | 不在本文 |

---

## 5. 落地记录

### 5.1 L0（2026-09-27 会话）

| 项 | 文件 | 验证 |
|---|---|---|
| L0-1 散步按方向选行 | `src-tauri/src/pet_native/model.rs`（`slot_row`）、`window.rs`（挂槽复位 `frame_idx`） | 单测 `wander_picks_row_by_direction`、`working_row_is_reserved_for_thinking` |
| L0-2 r7 改派 Thinking | `src-tauri/src/pet_native/model.rs`（`pick_state_row`） | 单测 `busy_beats_gesture_and_ambient`（期望值 `idle` → `run`，属**契约变更**） |
| L0-3 whale 图集接入 | `scripts/cut-frames.mjs`（每主题行名表 + whale 图集分支）、`ui/pets/frames.json`、`ui/pets/whale/frames/`（46 帧）、`src-tauri/build.rs`（内嵌通道）、`pet_native/image.rs`（`whale_rows` + `atlas_row` + `can_wander`）、`pet_native/window.rs`（绘制分流 + 散步准入放宽） | 单测 `whale_row_shares_fallback_chain`、`wander_admission_follows_available_rows`；闸门报 `7/9 行在位` |
| L0-4 行名声明订正 | `scripts/check-pet-assets.mjs`（`STATE_ROWS` / `ACTION_ROWS` 拆分、`references()` 支持 rows+states 并存、whale 图集源登记） | 闸门 PASS；states 主题不再报噪声比对 |

> **L0 的实机生效时间被推迟了一天**：以上四条**代码在 9-27 就绪**，但直到 9-28 的
> `npm run build` + `npm run deploy` 才真正上屏 —— 期间实机跑的是 9-26 的 exe 与 8-31 的
> 外置素材。根因与修复见 `design/CHANGELOG.md` 2026-09-28（续五）第一条。
> **教训：桌宠线的「完成」以「部署目录已刷新」为界，不以「源码改完」为界。**

### 5.2 L1（2026-09-28 会话，用户拍板 M1–M3）

| 项 | 文件 | 验证 |
|---|---|---|
| 变换数学 + 动效相位（新模块） | `src-tauri/src/pet_native/xform.rs`（`DrawXform` 正向/逆向/包围盒；`breath_offset` / `sway_angle` / `squash_scales` / `sway_layout_margin`） | 10 例单测（往返一致、包围盒不裁内容且最小、退化入参不打崩、相位有界与错相、脉冲两端回中性、最坏情况不越窗） |
| 变换采样 | `pet_native/window.rs`（`blit_center_bottom` 改为逆向映射 + 包围盒遍历 + 双线性） | `cargo test` 100 passed / 0 warning |
| 参数常量 | `pet_native/config.rs`（`L1` 段：`BREATH_*` / `SWAY_*` / `SQUASH_*` / `XF_*` + `sway_max_rad()`） | — |
| M1 呼吸 / M2 摇摆 / M3 挤压 | `pet_native/window.rs`（`compose` 帧更新块单值计算；行集与立绘两分支消费；`squash_start` 字段 + 两个触发点：Done 挂槽、Jump→JumpHold） | `verify-all desktop` 35/35 PASS |
| 命中路径 | **零改动**（查最终缓冲 ⇒ 天然一致） | §3.3.1 订正 |
| 模块注册 | `src-tauri/src/pet_native.rs`（`mod xform`） | 编译期 |

**回归证据（2026-09-28）**：`cargo test --bin miasaki` = **100 passed / 0 warning**
（原 90：新增 10 例，全部在 `xform.rs`）；`node scripts/verify-all.mjs desktop` = **35/35 PASS**；
`check-pet-assets.mjs` = PASS。
**部署证据**：`dist/` 刷新（exe 36.5 MB / `ui` 镜像）→ `deploy-local.ps1 -Force` = **9/9 PASS**；
部署目录与仓库逐项 SHA256 一致（`frames.json` / inverse 三态 / `theme-inverse.png` / whale `r0c0.png`），
`whale/frames` 46 帧、旧 `blue-*.png` 已随镜像删除。

## 6. 待拍板

1. **whale 的 `states.idle` / `states.work` 去留**：当前保留在清单、无渲染用途
   （图集接管；`deep` 仍是活跃的强度特例）。退役（连同 `MANUAL_ASSETS`/再生源登记调整）
   还是保留待用？
2. **whale 图集 r7–r10（4 行待机变体，+1.33 MB）**：进 ambient 池做"待机不重样"，
   还是就停在 r0–r6？
3. ~~**L1 范围**~~ —— **已决（2026-09-28）**：用户拍板 **M1 + M2 + M3，不含 M4**。
   M4（拖动尾随，含前置 R13 拖动合帧）仍待拍板，见 §3.5。
4. **形变是否给用户开关**：`intensity=idle` 时是否降级为"仅呼吸"（对齐 `prefers-reduced-motion` 口径）？
   —— 本轮未做，**新增动效后这个问题的分量变重了**（此前只有 ±2px 呼吸，现在有可见的摇摆）。
   倾向：接 `intensity=idle`（DSH 推理档最低）时只呼吸不摇摆，与 deep 档的处理对称。

## 7. 回归与文档同步清单

- `cargo test --bin miasaki`（`xform.rs` 新增 10 例；`model.rs` 的 L0 单测）；
- `node scripts/verify-all.mjs desktop`（含 `check-pet-assets.mjs` 资产闸门）；
- **`npm run build` → 刷新 `dist/` → `npm run deploy`**（本轮新增的必经步骤：
  桌宠线的改动不部署 = 没改，见 §5.1 注记）；
- 本次改动须同步 `README.md`「Q 版桌宠」段与 `design/CHANGELOG.md`；
- 实机走查项（本机才能验，判据见 §3.7）：散步朝向、工作态坐姿、whale 姿态、
  **inverse 三态动效、挤压脉冲、摇摆不吃掉底部留白**。
