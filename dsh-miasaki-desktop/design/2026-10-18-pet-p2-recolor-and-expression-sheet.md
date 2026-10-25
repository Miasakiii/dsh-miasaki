# 桌宠 P2：配色重着色（P2-a）+ 表情精灵表（P2-b 8/8 已交付）（2026-10-18）

> 状态：**已实施完毕（单测 13 例 + 反向验证八类全转红 + 静态回归 44/44），待构建部署 + 用户实机走查（E38）**。
> **2026-10-19 追记**：用户报障「变换表情脸上会有线」⇒ 8 张表情帧用面区蒙版重合成、
> exDoubt 补回头顶问号（asset-only，判据与脚本见 §4「表情帧重合成」）。
> P2-b 的 8 张表情帧全部入链；exSleepy 于账号充值后补生成，exShy / exDoubt 为用户追加。
> 触发：用户对 P0–P3 批次规划「开工」⇒ 执行 P2 批。P0/P1 已于同日落地
> （[`2026-10-18-pet-p0-interaction-emote.md`](2026-10-18-pet-p0-interaction-emote.md)、
> [`2026-10-18-pet-p1-idle-variants-and-marks.md`](2026-10-18-pet-p1-idle-variants-and-marks.md)）。

---

## 0. 结论先行

1. **P2 拆成两半，因为两半的阻塞性质完全不同**：P2-a（配色）是**纯代码**——对我们自己
   的 MIT 鲸鱼图集做加载期重着色，现在就能完整交付；P2-b（表情精灵表）的阻塞是
   **素材**——盘上没有已获授权的表情资产（§4 有完整盘点），生成需要用户定源。
2. **重着色放在加载期，不在每帧**：`Image.bgra` 是预乘像素，逐帧做 hue 旋转要给
   33ms 主路径每像素加 9 乘 + 反预乘；加载期一次性做（约 80 帧 × 4 万像素 ≈ 几十 ms），
   运行期**零开销**——与「主路径零分配/零新增计算」的铁律同向。
3. **配色只对 whale 生效**：kurumi（狂三）与 inverse 的发色/瞳色是角色设定的一部分，
    hue 旋转会把她们变成另一个人；whale 是吉祥物性质的通用形象，换色是装扮而非篡改。
   Coopanion 的配色同样只作用于它自己的 mascot（Coo/大肥鱼）。
4. **P2-b 的三条路都有硬伤**（§4）：garfield-whale 的状态图许可未核实（其 README
   自己警示）、我们自己的图集没有表情行、本会话没有图像生成能力。**需要用户拍板源**。

## 1. P2-a · 配色重着色

### 1.1 设置与预设

`PetSettings.color: u32`（0..=5，默认 0 = 原色），经 hash `psclr=` 上报、
`normalize()` 夹取。预设表（`config.rs`，`(hue_deg, sat)`）：

| # | 面板名 | hue | sat | 读感 |
|---|---|---|---|---|
| 0 | 原色 | 0° | 1.00 | 深蓝鲸鱼娘（默认） |
| 1 | 樱粉 | +120° | 1.00 | 蓝 → 品红 |
| 2 | 青碧 | +300° | 1.00 | 蓝 → 青绿 |
| 3 | 紫萄 | +55° | 1.00 | 蓝 → 紫 |
| 4 | 暖橘 | +150° | 1.00 | 蓝 → 橘红 |
| 5 | 霜白 | 0° | 0.30 | 去饱和的银白 |

hue 旋转用**绕灰度轴的矩阵**（保亮度）：内部色彩关系不变，只是整体转色相；
霜白是饱和度缩放（向亮度灰色插值），不是转相。

### 1.2 实现（加载期，`image.rs`）

```rust
/// 单像素重着色（纯函数，直存 RGB、非预乘）。保亮度 hue 矩阵 + 饱和度插值。
pub(crate) fn recolor_pixel(r: u8, g: u8, b: u8, hue_deg: f32, sat: f32) -> (u8, u8, u8);

/// 对一张（预乘）帧图原地重着色：反预乘 → recolor_pixel → 预乘（四舍五入同 load_png）。
pub(crate) fn recolor_image(img: &mut Image, hue_deg: f32, sat: f32);

/// 只重着色 whale 的行集与三态立绘（kurumi/inverse 不动——角色设定色）。
pub(crate) fn recolor_frames(f: &mut Frames, color: u32);

/// 加载 + 按预设重着色（冷启动与运行期改设置共用一条路）。
pub(crate) fn load_frames_colored(color: u32) -> Frames;
```

### 1.3 运行期切换（`window.rs`）

compose 顶部比对 `shared.settings.color` 与缓存 `loaded_color`，不一致 ⇒
`self.frames = load_frames_colored(c)`（一次性重载 ~百 ms，设置变更才发生，
`pet.log` 留一行 `recolor -> N`）。**不增量重算**：从 `assets::read` 重新解码
保证磁盘 ui/ 覆盖层语义不变，且无状态可漂移。

### 1.4 连带正确性（免费获得）

- **halo 自动跟上**：`backdrop` 采样的是最终 `buf` 的身体平均色——重着色后身体色
  变了，环色判据（深身浅环/浅身深环）自动翻转，无需改 backdrop。
- **命中/气泡/标记不受影响**：重着色只改角色帧的 RGB，alpha 轮廓不变；
  标记是情绪色（不随装扮变——它表达情绪不是衣着）。

### 1.5 单测

| 文件 | 例 | 判据 |
|---|---|---|
| `image.rs` | ≥6 | `recolor_pixel`：0°/sat1 = 恒等 / 灰阶不受 hue 影响 / 360° 轮回 / 保亮度（相对误差有界）/ 输出恒 0..255 / NaN 安全；`recolor_frames` 只动 whale（kurumi/inverse 帧逐字节不变） |
| `settings.rs` | 1 | color 越界夹取 + 默认 0 |
| `window.rs` 源码契约 | 1 | compose 有 color 变更检测 + 重载 |

## 2. 与既有机制的关系

1. **零每帧开销**：重着色在加载期；compose 只多一次整数比对。
2. **零新 GDI 对象/零分配增长**：重载是整份换 `Frames`（既有加载路径）。
3. **设置链全同构**：`settings.rs` 字段 → `normalize` → `main.rs` ps* 解析 →
   `themes/src/02-core.js` syncHash → 面板一行（官方 `SegmentedControl`，
   照 `pet_override` 现成模式）。**不注册 `settings.models.*`**（红线不变）。
4. **磁盘覆盖层语义**：重载走 `assets::read`（磁盘 ui/ 优先），与冷启动一致。

## 3. 验收判据（并入 E38）

1. 面板「配色」依次选 6 档 ⇒ whale 立刻换色（原色/品红/青绿/紫/橘红/银白），
   其他设置不丢、位置不动；
2. 切到 kurumi / inverse 主题 ⇒ **不换色**（角色设定色不动），切回 whale 恢复所选配色；
3. 换色后 halo 判据仍正常（深色桌面该亮还亮）；
4. `pet.log` 有一行 `recolor -> N`；重启后配色保持（`pet-settings.json` 落盘）；
5. **表情帧八连发**（whale 模式）：摸头（开心笑脸）/ 五连咬手（生气）/ 任务完成（星星眼）/
   审批到来（惊讶）/ 心情差时 ambient（难过）/ **深夜静置入睡（犯困哈欠脸，演完自动接回
   慢呼吸瞌睡、Zzz 符号继续每 3s 浮动）** / **双击挥手（害羞：垂眼微笑 + 两团腮红）** /
   **等她散步撞墙（疑惑：一高一低眉 + 头顶问号）**——每个表情演约 1.4s 后回到原姿态；
6. **kurumi/inverse 不播表情帧**（落回 P1 几何符号：爱心/怒纹/星星/感叹/泪滴/Zzz/
   腮红/问号）；
7. `cargo test` / `verify-all desktop` 全绿；构建 + 签名 + **外部终端**
   `deploy-local.ps1 -Force` + 重启实机走查 1–6。

## 4. P2-b · 表情精灵表——素材源盘点与定源（8/8 已交付）

**目标**（P0 提案原样）：用表情切图把 P1 的「几何标记」升级为「角色真容」——
表情覆盖脸部、动作覆盖身体，参考实现是 Coopanion 的 18 表情词表。

**盘点**：

| 路 | 盘点结论 |
|---|---|
| A. `_refs/garfield-whale/assets/whale/` 的 11 张状态图 | 内容对口但**许可未核实**（其 README 自警：MIT 不覆盖图片、衍生图受基础图权利约束），入公开仓即复刻它警示的风险；且与我们自己的鲸鱼画风不一致 |
| B. 我们自己的 `ui/pets/whale/spritesheet.png`（8×11，79 格） | 许可最干净（deepseek-whale-pet，MIT），但 11 行全是**单姿态行**，行内无表情变化 |
| C. `_refs/whale-resources/` 的 chibi 设定图 + 站点友情链接的 AATINF 93 张素材包 | 两者都**实图核验**过：chibi 设定图是三视图 + 细节标注（生成参考），AATINF 包是全身立绘/姿势集——都不是「同姿态不同表情」的表情矩阵 |
| D. **AI 生成（定源）** | 用户 2026-10-18 拍板「看看这里有没有参考，不行就生成吧」⇒ bailian-gen（qwen-image-3.0 图像编辑），以**我们自己的 idle 帧 r0c0 为参考图**保姿势/服装/构图，prompt 只改脸部表情 |

**生成管线（可复现；脚本 `_refs/p2b-gen/probe-align.mjs`，目录已 gitignore）**：
1. `bl image edit --image ref-idle.png --prompt "<表情描述>。保持完全相同的姿势、服装、构图、背景和画风，只改变脸部表情，身体其余部分与原图完全一致。" --size 512*555 --watermark false`
   （水印必须关——带水印的图不能切进精灵表；512×555 保持 192:208 宽高比，
   API 的 i2i 下限 512×512）；
2. `probe-align.mjs`：生成图缩到 192×208 后与原帧逐像素比差，**差异 >24 的像素**
   （实测 ≈50% 实心像素、包围盒几乎覆盖全身——qwen-image 是整体重绘而非局部换脸）
   经 3×3 软边遮罩贴到**原帧**上，**alpha 一律保留原帧的** ⇒ 输出透明底 192×208
   PNG：身体结构/透明区与原图集一致，只有脸变了（白底不泄漏——差异遮罩天然
   只在原帧实心区内取值）；
3. 落盘 `ui/pets/whale/frames/ex*.png` + `frames.json` 的 whale 行登记。

**表情帧重合成（2026-10-19，用户报障「变换表情脸上会有线」后换蒙版）**：首版
散点蒙版（步骤 2 的「差异 >24 逐像素 + 3×3 软边」）把 AI **全图细微重排**也贴回帧
——实测差异像素 ≈50% 实心、散点遍布头发/裙边/全身（刘海垂落带连续、四肢裙摆零星），
叠加处的混合缝在实机上读作「脸上的线/噪边」。真正的表达差异只在脸部（眼/眉/嘴/
腮红），故 8 张全部用**面区蒙版**重合成（脚本 `_refs/p2b-gen/recomposite-face.mjs`，
头注释写明判据）：

1. 感知误差（sRGB 伽马² + 类红均值加权）> 7 的实心像素 → 膨胀 1px（只许进实心区）
   → 最大 4-连通块 = 脸（实测 2400–3000px，含刘海垂落带）；
2. 腐蚀 1px 取核心 → 包络 bbox 外扩（左2/右2/上4/下3）∩ 实心区 = **矩形面区**
   （袋帽下沿～颈部）——矩形是刻意的：AI 在脸周头发上有大面积 8–25 级轻微重排，
   凸边界必穿头发留线，矩形边界落在「逐像素 ≤7 级」的带上，3×3 两遍羽化后不可见；
3. `out = orig·(1−m) + gen·m`，**alpha 一律用原帧**（命中测试 / halo / 轮廓三链不变）；
4. **exDoubt 专属补回**：头顶问号在生成图里是「白底深色、原帧透明」像素，步骤 1
   天然丢弃（首版成品其实也没有问号——设计意图「头顶问号」从未真正交付）。补回法 =
   深色(max<130) ∧ 原帧近透明(<128) ∧ x≥110 ∧ y≤40 的连通像素为核心，覆盖率
   α=(255−lum)/160 反预乘白底还原颜色，alpha 取覆盖率（**全表唯一破例改 alpha 处**，
   区域悬空于头顶、不触头发，命中测试增量 ≈ 一个 16×19 符号，与 P1 几何符号同理）。
   alpha 契约的完整口径：只有「原帧透明 + 悬空新内容」才允许破例，任何碰实心轮廓的
   破例都会破坏 halo/命中的逐帧一致性。

重合成后逐张目检 8/8：脸部为新表情、面外与 r0c0 逐像素一致（≤6 级）、无残留散点缝；
exDoubt 头顶问号 235px 在位。

**交付与中断**：**8 张全部入链**——exHappy / exAngry / exSad / exSurprise /
exStarry / **exSleepy** / **exShy** / **exDoubt**（摸头/咬手/完成/审批/mood-Low/
入睡/双击挥手/散步撞墙八路触发）。前 6 张 2026-10-18 下午生成（第 6 张 exSleepy
遇百炼账号 `overdue-payment` 欠费中断，当晚充值后补生成入链）；**exShy（害羞：
垂眼微笑 + 两团腮红）与 exDoubt（疑惑：一高一低眉 + 侧视 + 头顶问号）为用户
「可以」后追加的两张**。生成管线完全脚本化（`_refs/p2b-gen/probe-align.mjs`），
补图/加新表情的边际成本 = 一次 `bl image edit` + 一次合成 + frames.json 一行 +
映射一行。

**来源与权利（2026-10-18 验收审查补记）**：8 张表情帧全部由 bailian-gen（qwen-image-3.0 图像编辑）
在**我们自有的 MIT 鲸鱼图集 idle 帧**上生成，prompt 只改脸部表情，**未使用任何第三方受限素材**
（§4 盘点里 A/C 两条路已实图核验并排除）；生成时关闭水印（`--watermark false`），入链前逐张目检
无水印残留（生成命令记录 + PNG 无 tEXt/水印元数据）；合成后 body 与 alpha 全部保留原帧（只有脸部
像素来自生成图）⇒ 与 `deepseek-whale-pet`（MIT）图集同仓分发。

**渲染路由（`window.rs::show_mark`）**：情绪 → 表情帧行（`marks::expression_row_for`
纯映射）→ **当前模式是 whale 且该行已加载** ⇒ 播 `Action::Ambient { row: "ex*" }`
（整身瞬时帧，`MARK_MS` 1.4s，继承到期即清与六态压制）；否则落 P1 的几何符号
（kurumi/inverse 与 Zzz 走这条）。表情与符号**二选一**（播了表情就收掉符号）。
反应调用排在姿态槽**之后**（单槽互斥，反序会被 Nod/Shiver 覆盖）。

**瞌睡的两段式（P2-b 深夜补 exSleepy 时的设计）**：表情帧走 Ambient 槽会把
Sleep 慢呼吸槽**换掉**（单槽互斥），因此入睡 = 「演一次犯困脸（`Mark::Sleepy` →
exSleepy，1.4s）→ 到期后由**瞌睡续觉钩子**（`sleep_night && action.is_none()` ⇒
补回 Sleep 慢呼吸槽）续上」；周期性浮动仍是 **Zzz 符号**（不占槽，P1 行为）。
没有续觉钩子的表现是「犯困脸闪一下就精神了，后半夜只剩普通待机」。

## 5. 落地记录（2026-10-18）

| 项 | 文件 | 验证 |
|---|---|---|
| 预设表 | `config.rs`（`COLOR_PRESETS` 六档 `(hue, sat)` + `COLOR_MAX`） | 被 image/settings 测试引用 |
| 重着色纯函数 | `image.rs`（`recolor_pixel` 保亮度 hue 矩阵 + 饱和插值；`recolor_image` 预乘往返；`recolor_frames` **只动 whale**；`load_frames_colored`） | 6 例（默认恒等 / 灰度免疫 / 360° 轮回 + **等权均值**守恒 / 有界 + NaN 安全 / 预乘 alpha 不变 / 只动 whale） |
| 设置字段 | `settings.rs`（`color: u32` 默认 0 + `normalize` 夹取） | 2 例（默认 0 / 越界夹到 COLOR_MAX） |
| 运行期切换 | `window.rs`（`loaded_color` 字段 + compose 变更检测：重载 + 强制重绘 + 对齐 + `recolor -> N` 日志） | 1 例源码契约（含「不对齐 loaded_color ⇒ 每拍重载卡死」的锚） |
| 设置链 | `main.rs`（`psclr=` 解析 + ps_seen + apply）、`themes/src/02-core.js`（syncHash 拼装 + keep-list）、面板 `client.js`（`COLOR_CHOICES` 六档 + SegmentedControl 行 + 默认值 `color: 0`） | 面板 1 例契约（官方原语 + 默认值对齐 + Number 上报） |
| **P2-b 表情帧资产** | `ui/pets/whale/frames/ex{Happy,Angry,Sad,Surprise,Starry,Sleepy,Shy,Doubt}.png`（8 张，各 ~54KB）+ `ui/pets/frames.json` 的 whale 行登记 | `check-pet-assets` 双向校验过（desktop 44/44） |
| **P2-b 渲染路由** | `marks.rs`（`expression_row_for` 纯映射）、`window.rs`（`show_mark` 主题分流：whale 演表情帧 Ambient 槽、其余落符号；反应后置于姿态槽之后；**瞌睡续觉钩子** `sleep_night` + 每拍补 Sleep 槽） | 1 例映射测试 + 3 例源码契约（模式分流 / 顺序 / 瞌睡两段式） |
| **表情帧面区重合成（2026-10-19）** | `_refs/p2b-gen/recomposite-face.mjs`（判据见 §4「表情帧重合成」）+ 8 张 `ex*.png` 换新（asset-only，Rust 零改动；exDoubt 补回头顶问号 235px） | 逐张目检 8/8（脸部新表情、面外与 r0c0 逐像素 ≤6 级、无散点缝）+ `check-pet-assets` PASS |

**回归证据**：`cargo test` **P1 收线时 276 → 289 例全绿**（P2 新增 13：P2-a 8 +
P2-b 5）；`verify-all desktop` **44/44**。
**反向验证**（两类注入全部精确转红后恢复）：① `recolor_frames` 的 map 列表多加
`f.kurumi` ⇒ `recolor_touches_whale_only` 红（「kurumi 不得换色」——换色窜主题的
防线）；② compose 重载后去掉 `self.loaded_color = want_color` ⇒
`compose_reloads_frames_on_color_change` 红（每拍重载 = 桌面卡死的防线）。
**实施期一项订正（测试自身写错，留档）**：首版断言「保 Rec.601 亮度 ≤2 级」——
经典 hue 矩阵保的是**等权均值**（三行和均为 1），Rec.601 亮度对蓝色 palette 有
≈3.5/255 漂移（1.4%）。要 Rec.601 精确守恒须绕亮度轴旋转，但那会让灰/白着色
（女仆围裙大面积白变粉）——**灰度免疫是更重要的观感性质**，故保留经典矩阵、
把断言改成真实不变量（等权均值）。教训与「包围盒横向不对称」同族：**断言必须写
矩阵真正保证的性质，不能写「听起来该有的性质」**。

**P2-b 反向验证**（四类注入全部精确转红后恢复）：① `show_mark` 的表情路径去掉
`mode == "whale"` 判断 ⇒ `show_mark_routes_expression_frames_to_whale_only` 红
（frames 是全量加载的，不判模式 = kurumi/inverse 播鲸鱼表情，串味）；② 表情反应
调用提前到姿态 match 之前 ⇒ `petting_reaction_fires_after_the_pose_slot` 红
（单槽互斥，反序表情帧被 Nod 覆盖 = 「有表情但一闪而过」）；③ 入睡改回 Zzz
符号 + 续觉钩子失效 ⇒ `sleep_plays_drowsy_face_then_rearms_slow_breath` 红
（「犯困脸闪一下就精神了」的防线）；④ 注掉挥手/撞墙两处触发 ⇒
`shy_and_doubt_triggers_are_wired` 红（「那个互动没表情」的防线）。
**实施期两处测试自身写错（均已留档订正）**：① 首版断言「保 Rec.601 亮度」——
经典 hue 矩阵保的是**等权均值**（见 §5 P2-a 订正记录）；② 新符号（Shy 腮红 /
Doubt 问号）的几何中心天然留空，`every_mark_has_a_center_and_rejects_the_outside`
的白名单从 2 个扩到 4 个并加「形内锚点」断言（防白名单被滥用成「哪都不在」）；
问号弧最左端踩 atan2 的 **±π 折叠**（正左方返回 +π、略偏上返回 -π）——不折一下
最左端那点会被误判成「钩子下方的开口」而缺一个像素。

**待实机（归用户，E38 七条）**：§3 各条。**未构建部署**（部署纪律：外部终端执行）。
