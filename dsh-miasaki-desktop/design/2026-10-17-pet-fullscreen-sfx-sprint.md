# 桌宠专项 R20：全屏自动隐藏 + 程序化音效（2026-10-17）

> 状态：**已实施完毕（单测/反向验证/静态回归全过），待构建部署 + 用户实机走查**。
> 触发：用户「这几个仓库有其他好的可借鉴的点吗」→ 对 Coopanion（351★，浅克隆留档
> `_refs/coopanion/`）做拖动之外的专项对标后，用户拍板「可以，规划设计一下」。
> 关联：[`2026-10-17-pet-drag-sprint.md`](2026-10-17-pet-drag-sprint.md)（R18/R19 拖动专项，
> 本文件沿用其流程：设计 → 判据 → 实施 → 外部终端构建部署 → 实机走查）。

## 0. 拍板记录（2026-10-17，用户「按你建议，先把计划定下来」）

| 问题 | 我的建议 | 拍板结果 |
|---|---|---|
| 范围 | R20-a + R20-b 主做，R20-c 候选可顺延 | ✅ 按建议 |
| 音效默认开还是默认关 | 默认开（新能力无感接入） | ✅ 默认开 |
| 音效档位 | v1 只做总开关（分类静音留给真实需求） | ✅ 只做总开关 |

---

## 0-1. 结论先行

1. **R20-a 全屏自动隐藏**：前台窗口「真全屏」覆盖桌宠所在显示器时，自动把桌宠藏起来；
   退出全屏恢复。**我方当前完全没有这个**——看片/打游戏/全屏演示时桌宠浮在台上，
   是经典桌宠恼人点，且社区参考实现（Coopanion）已把判据做得很细
   （`WS_CAPTION` 区分「最大化」与「真全屏」、排除桌面本身窗口、按显示器判定）。
   Win32 判据现成、纯函数可单测、**零素材零新依赖**。
2. **R20-b 程序化音效**：全部音效在**构建期用代码合成** WAV（振荡器+包络+噪声，
   照搬 Coopanion `web/sound.js` 的合成器思路）并编译期内嵌；运行期 winmm 播放。
   **我方桌宠至今完全没声音**——跳跃/挥手/拎起/审批到来/完成庆祝各配一个，
   delight 极高，且不引入任何音频资产文件依赖（生成脚本 + 哈希闸门，沿用
   `gen-bubbles` / `intro-clips` 的既有模式）。
3. **R20-c 背景对比 halo（候选，判据从宽）**：采样桌宠身后桌面像素，宠物颜色与桌面
   接近时自动加一圈浅色 halo，防「宠物融进背景」。实现路径已探明（GDI StretchBlt
   降采样 + 构建期预渲染环 PNG），但视觉参数需要实机调，列为本批第三位，
    若前两项超预算可整项顺延。

## 1. 范围与明确不做

| 档 | 内容 | 理由 |
|---|---|---|
| **R20-a** | 全屏自动隐藏（轮询 + 纯函数判据 + 设置开关 + 日志） | 用户每天会感知的缺失；判据可完全单测 |
| **R20-b** | 程序化音效（构建期合成 8 个 WAV + 嵌入 + 播放 + 6 个触发点 + 设置开关） | 桌宠无声是完成度缺口；零音频资产、零新第三方依赖 |
| **R20-c** | 背景对比 halo（采样 + 判据 + 预渲染环） | 候选：视觉调参不确定，超预算可顺延 |
| **不做** | 骨骼 rig、本地 ASR（sherpa-onnx）、扔出物理、形象包沙箱系统、OBS 导出、交互响应模式 | 分别是 L2 素材层 / 重量级依赖 / 产品层 / 架构级，均不适合本批 |

## 2. R20-a · 全屏自动隐藏

### 2.1 参考判据（Coopanion，原文已核对）

`_refs/coopanion/packages/cortico-world-desktop-pet/host/electron-main.cjs:184-219`
（浅克隆留档，不入库）
的 `fullscreen(own)`：前台窗口满足**全部**条件才算「全屏覆盖」——
① 不是自己、不是 0；② `GWL_STYLE & WS_CAPTION == 0`（**带标题栏的窗口不算**——
最大化窗口会被误判，这条是精华）；③ 窗口类名不在 `{Progman, WorkerW}`（桌面本身）；
④ 与桌宠**同一显示器**（`MonitorFromWindow` 比对）；⑤ `GetWindowRect` 四边**覆盖**
`GetMonitorInfo` 的 rcMonitor。轮询 200ms；设置关闭时隐藏、恢复时 `showInactive()`；
用户手动显隐会解除规则的「所有权」（`releaseAutoHidden`）。

### 2.2 我方设计

**新增纯函数**（`model.rs`，判据与 Win32 分离，照 `classify_taskkill` 先例）：

```rust
/// 前台窗口是否「真全屏」覆盖了桌宠所在显示器。
/// `same_monitor` 由调用方先比好（MonitorFromWindow(fg) == MonitorFromWindow(own)）——
/// 显示器句柄不该进纯函数。`fg_class` 为 UTF-16 解码后的类名。
pub(crate) fn foreground_is_fullscreen_cover(
    fg: isize, own: isize, same_monitor: bool,
    fg_style: u32, fg_class: &str,
    fg_rect: Rect, own_mon: Rect,
) -> bool
```

规则逐条对应 §2.1（`WS_CAPTION = 0x00C0_0000`；桌面类名集合 `{Progman, WorkerW}`）。

**窗口层**（`window.rs`）：

| 项 | 设计 |
|---|---|
| 轮询 | 新定时器 `IDT_FULLSCREEN`（id=7，250ms，挂在主窗；与 `IDT_PEEK` 同频不同责） |
| 状态 | 新字段 `fs_hidden: bool`——「因全屏被规则隐藏」。**不落盘、不碰 `shared.hide`**（否则退出全屏后桌宠会停在用户没要的隐藏态） |
| 判定 | `fs_hidden == false && shown && cover` ⇒ `ShowWindow(SW_HIDE)` + `fs_hidden=true` + 日志 `fullscreen: auto-hidden (class=…)` |
| 恢复 | `fs_hidden == true && (!cover \|\| !shown)` ⇒ 仅当 `shown` 时 `SW_SHOW`；`fs_hidden=false` + 日志 `fullscreen: restored` |
| 与显隐的竞争 | 用户手动隐藏（托盘/面板）⇒ `shown=false` ⇒ 规则不会把它show回来；用户在全屏期间手动显示 ⇒ 下一拍规则重新生效（规则所有权，Coopanion 同口径） |
| 命中轮询 | `update_click_through` 早退加 `fs_hidden`（隐藏窗不该再跑 10ms 光标轮询） |
| 多显示器 | 只判「桌宠所在显示器」——副屏开游戏、主屏桌宠照常露脸（判据⑤） |

**FFI 新增**（`ffi.rs`，user32 块）：`MonitorFromWindow`、`GetClassNameW`；
`GWL_STYLE` / `WS_CAPTION` 常量。`GetWindowLongPtrW` / `GetWindowRect` / `GetForegroundWindow` 已在场。

**设置**（`settings.rs` + hash `psfs` + 面板一行 switch，照 `through` 现成模式）：

- `PetSettings.fs_hide: bool`，**默认 true**（开着比关着更符合预期；
  关掉的人本来就少，且关闭路径必须存在——这是硬契约）。
- 面板「外观与行为」组加一行「全屏时隐藏」（官方 `Switch`，`client.js` 现成 `switchCtl`）。
- `main.rs` 的 `ps*` 解析 + 下发（`miasaki-pet-state` 的 settings 块）各加一个字段。

**单测**（`model.rs`，≥6 例）：最大化窗口（带 caption）不算 / 无 caption 且四边覆盖算 /
 桌面类名（Progman/WorkerW）不算 / 自己不算 / 部分覆盖不算 / 差一边不算。

### 2.3 验收判据（并入 E34，见 §5）

## 3. R20-b · 程序化音效

### 3.1 合成链（构建期，照搬 Coopanion `sound.js` 的合成器）

`_refs/coopanion/packages/cortico-world-desktop-pet/web/sound.js`（不入库）的
`tone({type,f0,f1,dur,vol,attack,vib,vibRate,filter})` + `noise({...})`：全部音效由
振荡器/噪声经包络、频率斜坡、颤音、低通合成，**零音频文件**。我方对应物：

- 新脚本 `scripts/gen-sfx.mjs`（Node，零依赖）：把同一套合成器（~120 行 JS）固化为
  参数表，输出 `ui/pets/sfx/*.wav`（PCM 16-bit 单声道 22050Hz，每个 <30KB）。
- 参数表（8 个，v1）：

| 文件 | 合成参数（初值，实机可调） | 触发点 |
|---|---|---|
| `jump.wav` |  triangle 300→720Hz，0.14s，轻 vib | 单击跳跃起跳 |
| `land.wav` |  noise bandpass 900→200Hz 0.09s + sine 160→60Hz | JumpHold 落地定格 |
| `wave.wav` |  noise bandpass 1200→400Hz 0.22s，vol 低 | 双击挥手 |
| `grab.wav` |  square 420→640Hz 0.07s（短促「啵」） | 拖动起手（主窗 + 悬浮球） |
| `drop.wav` |  square 640→380Hz 0.09s | 松手收尾（滑停到位） |
| `alert.wav` |  sine 880Hz 0.09s + 1174Hz 0.12s（两声叮咚） | 审批/告警气泡出现 |
| `done.wav` |  琶音 523/659/784Hz 各 0.09s | Done 庆祝 |
| `tick.wav` |  sine 1000Hz 0.03s，vol 极低 |  UI 反馈备用（本批可不接） |

- 幂等：重跑产物逐字节一致（与 `cut-frames.mjs` 同纪律）；字节数 + SHA256 前 16 位
  写进脚本内嵌台账，`node scripts/check-sfx.mjs --check` 进 desktop 静态回归
  （照 `intro-clips` 闸门模式——判据只依赖**入库产物**，不依赖本地缓存）。

### 3.2 嵌入与播放

- `build.rs::gen_assets` 显式登记 8 个 wav（照 `approval.png` 的先例，不扫目录）。
- 播放：新模块 `pet_native/sfx.rs`——`play(name: &str)`：从 `assets::find()` 取
  `&'static [u8]`（`'static` 生命周期 ⇒ `SND_MEMORY|SND_ASYNC` 异步播放下缓冲区
  始终有效，无生命周期风险），调 `PlaySoundW`。FFI 新增 `#[link(name = "winmm")]`
  块（`PlaySoundW`）+ `build.rs` 显式 `cargo::rustc-link-lib=winmm`（不依赖
  tauri 默认库集合的巧合）。
- **主线程纪律**：播放只在**事件驱动点**调用（交互/状态变化），不进 33ms compose
  主路径 ⇒ 不违反「主路径零分配」（缓冲区是 `'static` 的，零分配）。
- 连打防护：`PlaySoundW` 默认后者替换前者（无 `SND_NOSTOP`）——狂点桌宠时
  「最后一声赢」，不叠音不爆音。
- 设置门：`play()` 内部读 `shared.settings.sound`（照 `dot_enabled()` 的短临界区模式），
  关掉即整个模块静默（红线：**关不掉比没有更糟**）。

### 3.3 设置与触发点接线

- `PetSettings.sound: bool`，**默认 true**；hash `psnd=on/off`；面板一行
  「音效」（官方 `Switch`，说明写清「跳跃/挥手/拎起/审批/庆祝的提示音」）。
- 触发点（`window.rs`，全部在既有交互分支里，一处一行调用）：
  `do_hop` → jump；JumpHold 转定格 → land；`do_wave` → wave；拖动起手（主窗+
  悬浮球两处）→ grab；`finish_drag_settle`/`end_dot_drag` → drop；alert 应用块
  （优先级 ≥ 告警的**新**项出现时）→ alert；Done 庆祝挂槽 → done。
- **单测**：合成器输出的 WAV 头校验（脚本内自证：RIFF/WAVE/fmt/data 四块、
  采样率/位深/时长与参数表一致）；`play()` 的设置门与未知名静默（sfx.rs 2 例）。

### 3.4 验收判据（并入 E34，见 §5）

## 4. R20-c · 背景对比 halo（候选）

**参考**（Coopanion，原文已核对）：`_refs/coopanion/packages/cortico-world-desktop-pet/web/pet-app.js:1476-1545`
+ `electron-main.cjs` 的 `sampleBackdrop`（GDI `StretchBlt` 把桌面降采样到 ≤1500 点，
OKLab 色差统计「与身体同色的背景占比」，带回差 `HALO_ON`/`HALO_OFF` 防抖）——
身体融进背景时加一圈浅灰 halo（`setHalo`）。其注释还记了一个性能教训：
halo 用 CSS filter 整窗模糊，在 Mac 上常开能把 GPU 占到 60–90%。

**我方路径**（若做）：

| 步 | 设计 |
|---|---|
| 采样 | `sfx.rs` 同款新模块 `backdrop.rs`：`GetDC(NULL)` + `CreateCompatibleBitmap(24×24)` + `StretchBlt` 降采样 + `GetDIBits` 求平均色（FFI 新增 4 个 gdi32 函数；Coopanion 实测一patch ≈1ms） |
| 判据 | 纯函数 `halo_needed(body_avg: [u8;3], backdrop_avg: [u8;3]) -> bool`（加权 RGB 距离 + 回差防抖：开/关两个阈值，防边界闪烁） |
| 绘制 | 构建期预渲染一枚柔环 PNG（`scripts/gen-halo.mjs`，256×256 径向渐变，<8KB），启用时在角色**背后**多一次 `blit_img`（复用既有 blit，alpha 随判据淡入淡出） |
| 节拍 | compose 内 2s 一次采样（`next_backdrop` 时间戳，照 `next_quote` 模式），不新开定时器 |

**风险明示**：判据阈值与环的观感需要实机调；「身体平均色」对三主题（pure/zafkiel/
kurkuriel）要各调一遍。**本项判据从宽**（「融进深色桌面时可见分隔圈」即可），
若前两项超预算整项顺延到 R21。

## 5. 验收判据（实施后入回归矩阵，编号 E34）

**全屏自动隐藏**：

1. 打开一个**真全屏**应用（游戏/视频全屏/PPT 放映，桌宠所在显示器）⇒ 桌宠**自动消失**；
   退出全屏 ⇒ 桌宠**回到原位置出现**（`pet.log` 有 `fullscreen: auto-hidden` /
   `fullscreen: restored` 成对行）；
2. **最大化窗口不算全屏**（把浏览器拉满，桌宠**不动**）——防误判的核心判据；
3. **副屏全屏、主屏桌宠** ⇒ 桌宠不动；把桌宠拖到副屏再全屏 ⇒ 桌宠隐藏、拖回主屏 ⇒ 不动；
4. 全屏期间从托盘/面板**手动隐藏** ⇒ 退出全屏后桌宠**不会**自己出现（规则不抢用户的所有权）；
5. 关闭「全屏时隐藏」设置 ⇒ 全屏应用下桌宠**保持可见**（开关是硬契约，关不掉比没有更糟）。

**程序化音效**：

6. 依次触发：单击（跳+落两声）/ 双击（挥）/ 拎起放下（grab+drop）/ 等一个审批
   （叮咚）/ 等一次任务完成（庆祝琶音）⇒ 每个都能听到、且**不重叠成噪音**；
7. 狂点桌宠 10 次 ⇒ 不叠音、不卡顿（后一声替换前一击）；
8. 关掉「音效」设置 ⇒ **全静默**（红线判据）；重开恢复；
9. `node scripts/check-sfx.mjs --check` PASS（8 个 WAV 字节数 + 哈希与台账一致）。

**工程**：

10. `cargo test` 全绿（新增 ≥8 例：fullscreen 判据 6 + sfx 门 2）；
11. `verify-all desktop` PASS（含新 sfx 闸门，desktop 项数 +1）；
12. 构建 + 签名 + 外部终端 `deploy-local.ps1 -Force` + 重启后按 1–9 实机走查。

## 6. 落地顺序

1. `model.rs`：`foreground_is_fullscreen_cover` + 6 例单测；
2. `ffi.rs`：`MonitorFromWindow` / `GetClassNameW` / winmm `PlaySoundW` / gdi32 采样四件套
   （R20-c 若顺延则采样四件套一并顺延）；`build.rs`：winmm 链接 + sfx 登记；
3. `scripts/gen-sfx.mjs` + 8 个 WAV + `--check` 一致性闸门（生成器即台账，无独立 check 脚本）；
4. `settings.rs`：`fs_hide` / `sound` 两字段 + normalize + 单测；
5. `window.rs`：`fs_hidden` 状态机 + `IDT_FULLSCREEN` + `update_click_through` 早退；
6. `pet_native/sfx.rs` + 6 个触发点接线；
7. `main.rs`：`psfs` / `psnd` hash 解析与下发；`plugins/dsh-pet-panel/lib/client.js`：
   面板两行 switch（官方 primitives，照 `through` 现成模式）；
8. `cargo test` → `verify-all desktop` → 构建签名部署（**外部终端**，R18 的部署纪律）
   → 实机走查；
9. 文档同步：`README.md` 桌宠段、`design/CHANGELOG.md`、矩阵 E34、`pet-reference-benchmark.md`
   补 R20 节（参考证据：fullscreen 判据五条 / sound.js 合成器 / backdrop 采样与 GPU 教训）。

## 7. 参考证据留档（本轮核对原文的结论）

| Coopanion 位置 | 事实 | 本轮采纳 |
|---|---|---|
| `host/electron-main.cjs:184-219` `fullscreen()` | 五条判据（caption/桌面类名/同显示器/四边覆盖）+ 200ms 轮询 + `releaseAutoHidden` 所有权语义 | **全盘采纳**（判据抽纯函数，轮询 250ms，所有权语义照抄） |
| `host/electron-main.cjs:386-391` | 设置关闭时不隐藏、恢复时 `showInactive()` | 采纳（我方对应 `shown` 语义） |
| `web/sound.js`（全文） | 振荡器+噪声合成、六类可分别静音、`document.hidden` 时不播、音量/主开关 | 采纳合成器与触发分类；**不采纳**分类静音（v1 只做总开关，产品复杂度留给真实需求） |
| `web/kit/body.js` 的 `play(...)` 调用点 | 动作/触摸/表情/鼾声/对话五类各配合成音 | 触发点映射的参照（我方 6 个触发点） |
| `web/pet-app.js:1476-1545` + `sampleBackdrop` | OKLab 背景采样 + 回差 + GPU 教训（整窗 filter 模糊 60–90% GPU） | **候选采纳**（我方改为预渲染环 + 单次 blit，规避其 GPU 教训） |
| `web/stage.js:33-58` `lightWall` | 设置窗预览的光晕跟随（只 transform 不重排） | 不采纳（我方无设置窗预览）；但其「合成层只动 transform」的纪律可借鉴 |

## 8. 落地记录（2026-10-17）与三条实施期决策

| 项 | 文件 | 验证 |
|---|---|---|
| 全屏判据纯函数 | `model.rs`（`foreground_is_fullscreen_cover`） | **6 例**（覆盖主路径 / 最大化不算 / 桌面类名不算 / 自己·无效·异屏·部分覆盖不算 / 负坐标副屏 / **逐条件 load-bearing 反例**） |
| Win32 事实层 | `window.rs`（`fs_poll` / `fullscreen_covers` + `IDT_FULLSCREEN` 250ms + `fs_hidden` 字段 + compose 显隐分支扩展 + `update_click_through` 早退） | 编译 + 回归 |
| FFI | `ffi.rs`（`MonitorFromWindow` / `GetClassNameW` / `GWL_STYLE` / `WS_CAPTION` / winmm `PlaySoundW` + `SND_*`；`Rect` 补 `Debug`） | 编译 |
| 音效合成器 | `scripts/gen-sfx.mjs`（振荡器+噪声+包络+颤音+双二阶滤波，种子 PRNG 确定性） | 8 个 WAV 幂等重放逐字节一致；波形体检（peak 0.07–0.21 不削顶） |
| 音效播放 | `pet_native/sfx.rs`（`resolve` 纯查找 + `play` Win32；未知名/缺素材静默 + 首缺留痕） | **2 例**（未知名静默 / **登记契约**：名表每个都能在内嵌资产里解析到，且 RIFF/WAVE/data 头四块在位） |
| 嵌入登记 | `build.rs`（8 个 wav 显式登记）+ `verify-all.mjs`（`gen-sfx.mjs --check` 闸门，desktop 40→41→**43**） | `verify-all desktop` **43/43** |
| 设置 | `settings.rs`（`fs_hide` / `sound`，默认 true）+ `main.rs`（`psfs` / `psnd` hash 解析下发）+ `themes/src/02-core.js`（ps* 拼装 + 保留键清单）+ `plugins/dsh-pet-panel/lib/client.js`（两行 switch + 默认值） | 2 例（显式 false 往返 / 默认值） |
| 触发点 | `window.rs` 8 处：jump（do_hop）/ land（JumpHold 定格）/ wave（do_wave）/ grab×2（主窗+球起手）/ drop×2（settle+球收尾）/ alert（审批·告警出现）/ done（庆祝）/ tick（审批按钮点击） | 回归 |

**回归证据**：`cargo test --bin miasaki` **213 → 222 例全绿**（fullscreen 6 + settings 1 + sfx 2，
其余为在役文件内的增量）；`verify-all desktop` **43/43**（含 sfx 闸门与内嵌 cargo test）。
**反向验证**（三类缺陷逐条注入，全部精确转红后恢复）：
① 去掉 `WS_CAPTION` 判据 ⇒ `maximized_window_with_caption_is_not_fullscreen` 红；
② 去掉桌面类名判据 ⇒ `desktop_windows_are_not_fullscreen_apps` 红；
③ 覆盖判据「与」改「或」⇒ `each_cover_condition_is_load_bearing` /
`self_invalid_other_monitor_and_partial_rect_are_not_cover` /
`cover_works_on_negative_coordinate_monitors` **三条同时红**。

**三条实施期决策（设计稿之后拍的，留档）**：

1. **`tick` 接到了审批按钮点击**（设计稿写的是「UI 反馈备用（本批可不接）」）：
   落点选 `decide_approval` 的发出处——决策要走后端往返，这一声先给「点到了」的反馈，
   与 `alert` 的「有事」分工。8 个音效至此全部有归属，没有 embed 了不响的死资产。
2. **全屏期间手动显示：规则在下一拍重新生效**（与 Coopanion 同口径，非我原设计稿的
   「用户赢到退出」）：原设计稿想让用户手动 show 赢到底，实测发现那样需要第三个状态位
   （「用户覆盖到覆盖解除」）且与「设置是常驻命令」的心智不符；现在规则态由 compose
   显隐分支清理、下一拍 `fs_poll` 重新判定，**逃逸出口是设置开关**（面板「全屏时隐藏」），
   文档与面板说明文案都按这个口径写。
3. **`gen-sfx.mjs` 的 `--check` 是「内存重建逐字节比对」，不需要外链台账**：
   与 `intro-clips` 不同——那货的源头是上游第三方产物（需要 SHA 台账钉「别被换」），
   而音效是**本仓生成器自己的输出**，生成器即台账，任何「改了参数没重跑」都会红。
   这条差别写进了两个脚本的头部注释，防止后来者给 gen-sfx 也加一份手抄台账
   （两份真相必然漂移）。
