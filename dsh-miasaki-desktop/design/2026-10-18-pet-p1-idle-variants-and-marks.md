# 桌宠 P1：whale 待机变体入池 + 程序化表情标记（2026-10-18）

> 状态：**已实施完毕（单测 17 例 + 反向验证五类全转红 + 静态回归 44/44），待构建部署 + 用户实机走查（E37）**。
> 触发：用户对 P0–P3 批次规划「继续推进」⇒ 执行 P1 批。P0 四件套已于同日落地
> （[`2026-10-18-pet-p0-interaction-emote.md`](2026-10-18-pet-p0-interaction-emote.md)）。
> 关联：[`pet-v5-motion-plan.md`](pet-v5-motion-plan.md) §6 待拍板 2（r7–r10 去留）——
> R21 批已把 r7–r10 切成 `idle2`–`idle5` 登记入帧表并退役 `states/work.png`，
> 其**池接线**按约定留到 P0 落地后补做，即本文 §3.1。

---

## 0. 结论先行

1. **P1-a（r7–r10 入 ambient 池）是零新素材的「待机不重样」**：whale 的 ambient 行池从
   `[wave, review, wait]` 扩为 `[wave, wait, idle2–idle5]`（review 对 whale 不存在，
   现行池里它踩 fallback 落 idle = 空转槽——R21 批的发现）；kurumi 池不动。
   代价 = ambient 选择器从「定长 3 槽」泛化为「主题相关变长池」。
2. **P1-b（表情标记）走程序化绘制，不出图不加帧**：六个标记（Heart 爱心 / Star 星星 /
   Tear 泪滴 / Anger 怒纹 / Zzz / Bang 感叹）全部用隐式曲线 + 线段在 Rust 里画进
   合成缓冲——先例是悬浮球的程序化球面渲染（`dot.rs`）。**不走 gen-bubbles 的
   System.Drawing 路径**：那会给六个小符号新建一条构建期 PowerShell 资产链，
   而符号是几何不是文字，程序化反而可单测（点-形状判定）。
3. **P1-c（头顶工具图标）不做，降级 P3**：官方契约只透出**审批**的工具名
   （`pettool=`，来自 `pendingInteractions`）；要显示「运行中在用什么工具」需要读
   trajectory 事件流，契约面不明、收益（信息密度）低于 P0/P1 的互动与表情线。
   审批工具的 icon 化价值也有限（审批气泡本身已可读）——记录理由，不顺手做。

## 1. 范围

| 做 | 不做（记录去向） |
|---|---|
| P1-a ambient 池主题化 + 变长加权 + whale 扩池 | inverse 的 ambient（立绘分支不消费行，维持现状） |
| P1-b 六种程序化表情标记 + 触发映射 + 浮动演出 | 对白气泡文本（新台词帧）→ **P2** 随表情精灵表 |
| 标记与心情档位的联动（High 多爱心 / Low 多泪滴） | 标记的预设开关 → 无排期（动效强度滑杆已覆盖） |
| P1-c 工具图标 —— **不做** | → P3 候选（理由 §0.3） |

## 2. 现状基座（P0 落地后的相关事实）

- ambient 选择链（`model.rs`）：`pick_ambient_choice(band)` → jump 特殊概率 →
  emote 概率（`ambient_wants_emote`）→ 行池加权选行（`pick_ambient_pool_index_weighted`，
  入参 `[u32; 3]` 定长权重 + `AMBIENT_LAST` 记忆）。行池是 `const POOL: [&str; 3]`，
  **主题无关**。
- 帧表：whale 现有 `idle / runRight / runLeft / wave / jump / failed / wait`（r0–r6）
  + R21 新增 `idle2–idle5`（r7–r10，共 28 帧，站姿待机变体）；kurumi 9 行无 idle 变体。
- 绘制：compose 帧更新块内，角色画进 `buf` 后画气泡（`blit_bubble`）；`last_char_box`
  （R20-c halo 引入）记录本帧角色框——标记定位直接复用它，不新算几何。
- 程序化绘制先例：`dot.rs` 整块球面（径向渐变/高光/落影）手工逐像素合成后整块 blit。

## 3. 逐项设计

### 3.1 P1-a · ambient 池主题化 + whale 扩池

**选择器泛化**（`model.rs`）：

```rust
/// 主题的 ambient 行池（变长）。whale 无 review 行（踩 fallback = 空转槽），
/// 且有待机变体 idle2–idle5；kurumi 有 review、无待机变体。
pub(crate) fn ambient_pool(mode: &str) -> &'static [&'static str] {
    match mode {
        "whale" => &["wave", "wait", "idle2", "idle3", "idle4", "idle5"],
        _ => &["wave", "review", "wait"], // kurumi（inverse 无图集，行不被消费）
    }
}

/// 行名 → 心情权重。wave/review/wait 随档位动（现行口径），待机变体恒 1
/// ——它们的存在意义是「待机不重样」，不该被心情挤掉。
pub(crate) fn row_weight(row: &str, band: AmbientBand) -> u32 {
    match (row, band) {
        ("wave", AmbientBand::High) => 3,
        ("review", AmbientBand::High) => 2,
        ("wave" | "review", AmbientBand::Mid) => 1,
        ("wave" | "review", AmbientBand::Low) => 1,
        ("wait", AmbientBand::Low) => 3,
        ("wait", _) => 1,
        _ => 1, // idle2–idle5 与其他未列举行：中性
    }
}
```

- `pick_ambient_pool_index_weighted` 入参从 `[u32; 3]` 泛化为 `&[u32]`（E5 三例测试
  与 P0 的加权测试随call site 迁；`[1,1,1]` 同口径断言不变）。
- `pick_ambient_choice(band, mode)` 增加 mode 入参（compose 现成持有 `s.mode`）。
- **不重复纪律不变**：撞上上次时在别的门里按权重公平重抽（P0 的实现，泛化到变长）。
- **fps**：idle2–idle5 落 compose fps 表的默认档（8fps，与 whale idle 同行）——
  变体帧率略低于 kurumi 的 run(10fps) 是素材本身的性质，不特殊处理。
- 兼容：老安装缺 idle2–idle5 帧时 `Frames::atlas_row` 回退链落 idle（既有模式），
  不特殊处理；`check-pet-assets.mjs` 的 `ACTION_ROWS` **不加** idle2–idle5
  （R21 已论证：跨主题覆盖分母会出噪声缺口，其登记由 frames.json ↔ 盘上文件双向校验管）。

### 3.2 P1-b · 程序化表情标记

**新模块 `pet_native/marks.rs`**（纯逻辑 + 绘制，无 Win32/无字体/无资产）：

```rust
pub(crate) enum Mark { Heart, Star, Tear, Anger, Zzz, Bang }

/// 形状判定：局部坐标 (x, y) ∈ [-1, 1]² 是否在标记内（y 向下）。
/// 全部隐式/参数化——可单测（边界内外抽样），且零字体零资产。
pub(crate) fn mark_shape(m: Mark, x: f32, y: f32) -> bool;

/// 一帧的绘制参数：弹出缩放（前 25% 从 0.4 弹到 1.05 再回 1）、浮动 bob、透明度。
pub(crate) fn mark_frame(p: f32) -> (f32 /*scale*/, f32 /*bob_px*/, f32 /*alpha 0..1*/);
```

形状判据（每条都有单测锚点）：

| 标记 | 判据 | 读感 |
|---|---|---|
| Heart | 心形隐式 `(x²+y²−1)³ − x²y³ ≤ 0`（y 向上系，绘制时翻转） | 喜欢/开心 |
| Star | 五角星：极坐标 `r(θ) ≤ R·(0.42+0.58·\|cos(2.5θ)\|)` | 期待/得意 |
| Tear | 上圆下尖：`\|(x, y−0.35)\| ≤ 0.45` ∪ 三角（尖朝下） | 难过 |
| Anger | 怒纹：两对短斜线（漫画 vein），线段距离场 ≤ 线宽 | 生气 |
| Zzz | 三个递减 Z（每 Z = 三条线段），随高度缩小 | 困 |
| Bang | 竖条 + 圆点（感叹号） | 惊讶/注意 |

**状态机**（窗口层，`MarkState { kind, started, dur }`，与 `squash_start` 同哲学——
到期即清）：compose 帧更新块内、角色与气泡画完之后画（标记在气泡之上、角色头部上方
`last_char_box.top − 26px`；气泡在下方带不冲突——气泡底 ≈ 窗顶 60px，标记在 ≈74px 起）。
** lifetime 1.4s，同源事件刷新**（再触发同标记 = 续播不重来）。

**触发映射**（全部本地事件，零 LLM）：

| 事件 | 标记 |
|---|---|
| Stroke（摸头） | Heart |
| Bite（咬手） | Anger |
| Done（完成庆祝） | Star |
| Error / FleetBlocked | Anger |
| 审批到来（Waiting） | Bang |
| Sleep 在场 | Zzz（每 3s 浮动一次，不阻塞） |
| ambient 且 mood High | Heart（25%） |
| ambient 且 mood Low | Tear（25%） |

**性能**：标记 32×32 内、约 800 像素的逐点判定（其余透明跳过）——只有**有标记的帧**
多这 800 次浮点判定，静止期零开销；不新增 GDI 对象（写进现有 buf）。

## 4. 与既有机制的关系

1. **命中判定零改动**：标记画进最终 `buf` ⇒ 光标压在标记上算「命中角色」——
   与气泡同口径（气泡本就可点区域内）。若将来要「标记穿透」，需与 R2 一起评估，
   P1 不做。
2. **不抢戏**：标记画在角色上方小区域、1.4s 即逝；审批/告警气泡的可读性优先
   （标记在气泡**之下**的窗区，不遮挡按钮）。
3. **六态/动作槽零改动**：标记是独立小状态机，不走 ActionSlot（它不该被
   `pick_state_row` 压制——Error 时愤怒纹正是要显示的）。
4. **零设置项**：强度走 `settings.motion`（标记的弹出缩放与 bob 随之缩放；
   motion=0 时静态小标记仍显示——它现在是**信息**不只是装饰）。

## 5. 单测清单（实施后实况）

| 文件 | 例 | 判据 |
|---|---|---|
| `marks.rs` | 12 | 六形状各自锚点（中心在内/盒外在外/心形 cleft 与对称/星星五角五谷/泪滴尖底/怒纹空心/Zzz 递减/感叹断缝）+ `mark_frame` 过冲落定淡入淡出 + 退化入参 + 扫描连续性 + **事件映射三例**（pet_event/alert_priority/done——纯函数 seam，契约抓不到「调用被注掉」，映射查得到） |
| `model.rs` | 3（+1 泛化） | `ambient_pool` 主题分流；`row_weight` 档位方向与变体中性；粘合层主题纪律（whale 永不回 review、变体真能上场）；加权选行测试泛化到任意长度（5 张权重表含 whale 6 槽） |
| `window.rs` 源码契约 | 2 | 标记在气泡之后绘制 + 每拍过期清理 + 定位复用 `last_char_box`；触发点走纯函数 seam（`mark_for_*`） |

## 6. 验收判据（实施后入回归矩阵 E37）

1. **待机不重样**：whale 主题静置几分钟，idle 小动作里能观察到**站姿待机变体**
   （双手交叠/侧身/微张双臂/尾翼差异的四种姿态）与挥手、双手合十轮番出现，
   不再只播 `wave/review/wait` 三条（review 对 whale 是空转槽，已从池中移除）；
   kurumi 主题行为与升级前一致（池未变）；
2. **表情标记六连发**：摸头（爱心）/ 五连咬手（怒纹）/ 任务完成（星星）/
   审批到来（感叹）/ fleet 告警（怒纹）/ 深夜瞌睡（Zzz 每 3s 浮动）——逐个触发，
   每个标记在角色头顶上方弹出（0.4→1.15→1.0 过冲）+ 浮动 + 淡出，约 1.4s 消失；
3. **心情的面上表达**：连续互动十几次后（心情转 High）ambient 小动作偶尔带爱心；
   被咬/被甩几次后（心情转 Low）偶尔带泪滴；
4. **不遮挡不抢戏**：标记不挡审批气泡的两个按钮（标记在角色头顶、气泡在窗顶）；
   拖动/飞行中标记照常但不影响操作；
5. **三主题全覆盖**：切到 inverse / kurumi 重走 2 的触发链——立绘主题同样能冒标记
   （绘制层与主题无关）；
6. **工程**：`cargo test` 全绿（P1 新增 17 例）；`verify-all desktop` PASS；
   构建 + 签名 + **外部终端** `deploy-local.ps1 -Force` + 重启实机走查 1–5。

## 7. 落地记录（2026-10-18）

| 项 | 文件 | 验证 |
|---|---|---|
| P1-a 池主题化 + 变长加权 | `model.rs`（`ambient_pool(mode)` / `row_weight(row, band)` / `pick_ambient_pool_index_weighted` 泛化为 `&[u32]` / `pick_ambient_choice(band, mode)`；删除定长的 `ambient_weights`）+ `window.rs`（compose 的 ambient 块多读一个 mode） | 加权测试泛化到任意长度（5 张权重表含 whale 6 槽）+ 3 例新测（池分流 / 权重方向 / 粘合层主题纪律） |
| P1-b 形状库 | `marks.rs`（新模块：`Mark` 六种 / `mark_shape` 隐式判定 / `mark_frame` 演出 / `mark_color` / `MarkPlay` 状态） | 10 例（六形状内外锚点 / 心形 cleft 与对称 / 星星五角五谷 / 泪滴尖底 / 怒纹空心 / Zzz 递减 / 感叹断缝 / 演出过冲落定淡入淡出 / 退化入参 / 扫描连续性） |
| P1-b 事件映射纯函数 | `marks.rs`（`mark_for_pet_event` / `mark_for_alert_priority` / `mark_for_done`） | 3 例（映射锚定 / 只有「需要行动」的才挂 / Done→星星） |
| P1-b 参数 | `config.rs`（`MARK_MS` / `MARK_BOX_PX` / `MARK_LIFT_PX` / `ZZZ_EVERY_MS` / `MARK_PCT_*`） | 被上述测试与窗口层引用 |
| P1-b 窗口层接线 | `window.rs`：`mark`/`next_zzz` 两字段；`show_mark`（同源刷新=续命不重播）；`blit_mark`（复用 `last_char_box` 定位、逐点判定、over 合成）；compose 帧更新块尾绘制 + 每拍到期清理；触发点：摸头/咬手（`mark_for_pet_event`）、Done（`mark_for_done`）、审批/告警（`mark_for_alert_priority`）、瞌睡 Zzz 周期浮动、ambient 心情标记（High 爱心 / Low 泪滴）；`pet_native.rs` 注册模块 | 2 例源码契约（气泡后绘制 + 到期清理 + 定位复用角色框 / 触发点走纯函数 seam） |

**回归证据**：`cargo test --bin miasaki` **P0 收线时 255 → 276 例全绿**（P1 新增 17：
marks 12 / model 3 / window 契约 2；净差 21 中另 4 例为并行批次的
`show_branch_*`（R20-a 续三全屏闪烁修复）入账——本批 276 的实测含它们）；
`verify-all desktop` **44/44**。
**反向验证**（五类注入全部精确转红后恢复）：① 心形采样映射改错（统一 0.77 缩放）
⇒ 心形 cleft、扫描连续性、盒外三测**同时红**；② `mark_for_pet_event` 的 Stroke 映射成
Tear ⇒ 映射测试红；③ `mark_for_alert_priority` 的审批分支置空 ⇒ 映射测试红。
**实施期两项决策（设计稿之后拍的，留档）**：

1. **心形采样映射不能统一缩放**：隐式心形自然 extent 非对称（x ±1.13、y 上 1.3 下 1.0），
   按 y 缩裁瓣、按 x 缩裁尖——必须各轴缩放 + 居中（`HEART_SX/SY/DY` 三常量）。
   首版统一 0.77 被 `heart_lobes_and_cleft` 当场抓住（瓣和尖都出盒）。
2. **标记映射纯函数化（第二次踩同一个坑）**：首版触发点是内联 `show_mark(Mark::Heart)`，
   反向验证时把它注掉，**源码契约全绿**（文本还在）——与 P0 的 `throw_triggered`
   同款教训。抽成 `mark_for_*` 纯函数后，「谁配谁」有单测 seam；契约只锚「调用在不在」。
   这条现已成本仓第二条纪律实例：**窗口层事件 → 参数的映射，一律过纯函数**。

**待实机（归用户，E37 判据）**：§7 各条。**未构建部署**（部署纪律：外部终端执行）。
