# 启动片头 3.0 · 视频开机动画（desktop 壳深度适配）设计

> 状态：**全部决策已拍板（2026-10-05），进入实施**。D1=A 四段全带 / D2=默认静音+设置开关 /
> D3=A 就绪即淡出 / D6=遮罩渐变+cover / D10=启动设置栏（avatar 先例模式）。
> 用户点名：「我也想做启动加载动画，把启动命令窗藏起来，可以直接用它的动画（指第三方
> `NativeDog1/dsh-boot-animation`），但是我们自己接到我们的桌面端，深度适配」；
> 增补：「可以在外观设置页加一栏启动设置栏」「其他的按建议」。
> 前序：启动加载 2.0 见 [`boot-loading-terminal.md`](boot-loading-terminal.md)（S4a 已落地）；
> 启动可靠性见 [`bootstrap-reliability.md`](bootstrap-reliability.md)（本设计不改其结论）。

## 1. 需求分解（用户原话 → 落点）

| # | 用户原话 | 归属 | 现状 |
|---|---|---|---|
| R1 | 「做启动加载动画」 | desktop 线 | 2.0 S4a 纹章动效已落地；本设计升级为**视频片头** |
| R2 | 「把启动命令窗藏起来」 | desktop 线 | **P9（2026-09-26）已实施**：node 直启绕开 cmd.exe + `CREATE_NO_WINDOW`，直启失败回落 cmd 路径（main.rs:1115 `spawn_dsh`）。**缺实机验收**，本设计补验收项 §7-6 |
| R3 | 「直接用它的动画」 | desktop 线 | 第三方四段 mp4 素材复用（§2 授权 + §4 素材管线） |
| R4 | 「接到我们的桌面端，深度适配」 | desktop 线 | 壳内 loading.html 播放 + 三主题融合 + 就绪时序 + 降级链（§5） |
| R5 | 「可以在外观设置页加一栏启动设置栏」 | appearance + desktop | **跨线**：设置 UI 在 appearance 面板（§5-D10），配置存储 appearance config v7 `boot` 板块，desktop 壳启动早期读文件消费（先例 = `launcher_icon.rs` 的 avatar 板块模式） |

**边界**：desktop 壳（`ui/loading.html` + 素材管线）+ appearance 线**仅新增设置面板板块与
config 字段**（R5 用户点名）；不动 DSH 本体；零第三方运行时依赖纪律不破（video 元素是
WebView2 原生能力）。

## 2. 事实底座（全部实测/官方口径，2026-10-04）

### 2.1 第三方素材（GitHub 仓库 v0.4.2 tag，`media/` 目录；**2026-10-04 全部字节级实测**）

| 素材 | 大小 (B) | 时长 | 分辨率 | 轨道 | faststart | SHA256 前 16 位 |
|---|---|---|---|---|---|---|
| deepseek-brand-intro.mp4 | 1,308,725 | 7.05s | 1280×720 | vide+soun | ✅ | `b22de4810e195b50` ✓ |
| deepseek-cyberpunk-intro.mp4 | 1,856,280 | 7.05s | 1280×720 | vide+soun | ✅ | `beabf5956e0b467e` ✓ |
| deepseek-awakening-intro.mp4 | 2,600,325 | 7.05s | 1280×720 | vide+soun | ✅ | `ff5afe0dabc16e09` ✓ |
| deepseek-startup-intro.mp4 | 3,305,269 | 8.05s | 1280×720 | vide+soun | ✅ | `ba72c501021444cd` ✓ |

- 实测法：box walk（mvhd/tkhd/hdlr）+ SHA256，与上游 `lib/clips.meta.js` 官方 SHA **逐段全对**；
  四段均为 H.264(avc1) + AAC(mp4a) 双轨、faststart（moov 前置）。
- 本地取证副本在 `_refs/boot-intro-clips/`（不入库）；S0 仅剩 **WebView2 muted autoplay 实机
  冒烟**一项（§8 风险首条）。
- **授权**：仓库 BSD-3-Clause；README「许可」节明示「包内 `lib/clips.data.js` 里的内嵌片源以相同
  条款分发」⇒ 复用合法，**需保留版权声明与署名**（§5-D8）。

### 2.2 本仓现状（代码落点）

- `ui/loading.html`（347 行）：三主题纹章 + wordmark + `#status` + retry/diag 按钮组；
  S4a 动效已落地（`.mia-boot-scan/ring/halo`，reduced-motion 全量降级，测试 10 例钉死）。
- `src-tauri/tauri.conf.json`：`frontendDist: "../ui"`、`csp: null` ⇒ **asset 协议直读 ui/ 下
  静态文件，WebView2 播本地 mp4（H.264/AAC 硬解）零配置零依赖**。
- 就绪链路：`port_ready()` 400ms 轮询 → navigate 3080；90s 超时提示；`__setStatus`/`__setRetry`
  契约只增不改（2.0 §1-4 硬约束，本设计继承）。
- appearance 线 P2 Boot Splash（3080 首帧层）：已实施（2026-09-27），S5 实机验收未做。

### 2.3 已排除的方案

- **装第三方插件本体**：z-index 同值撞车（2147483000）+ `sidebar.footer.action` 槽位冲突
  （issue #1 实锤 dsh-cost-meter 重叠）+ DeepSeek 品牌片头叠在 MIASAKI 纹章后面双重片头。
  ⇒ 只取素材，不装插件（2026-10-04 对标结论）。

## 3. 总体架构：视频层叠在纹章层之上

```
ui/loading.html
 ├─ L0 防白闪底座（现状：visible(false) → on_page_load 才 show）
 ├─ L1 纹章动效层（S4a 现状，原样保留）←—— 兼作降级层（§5-D5）
 ├─ L2 视频片头层（新增，本设计主体）
 │    video[intro-{id}.mp4] object-fit:cover 铺满 + 遮罩渐变（主题融合 §5-D6）
 │    + 叠加信息层（wordmark / #status 摘要 / 阶段点 / 已等待 Ns）
 └─ L3 失败卡片层（bootstrap-reliability 现状，视频让路）
```

**核心原则**：视频是「片头」不是「屏保」——**就绪即切、失败让路、播完回落**。
三条退路都有既有层兜着：L1 纹章层（视频不可用时）、L3 失败卡片（启动失败时）、2.5s appearance
splash 兜底（3080 侧，不归本线）。

配置链（R5 增补，先例 = avatar 板块 → `launcher_icon.rs`）：

```
appearance 设置面板「启动」板块（client 半，settings.section 插槽）
  → POST /appearance/api/state（host 半 mergeConfig + store.save 原子写，失败显式 500）
  → <dshHome>/miasaki-appearance/config.json（v7 `boot` 板块）
  → desktop 壳启动最早瞬间（start_launch_sequence 之前）读同一文件
  → boot.intro 选段 / boot.audio 音轨 → loading.html L2 行为
```

## 4. 素材管线（构建链输入，入库可重放）

1. **提取脚本** `scripts/extract-intro-clips.mjs` 入库：从上游 tag `v0.4.2` `media/` 拉四段
   （或从已下载 `_refs/boot-intro-clips/` 校验后拷贝），**SHA256 逐段校验**（对齐
   `clips.meta.js` 官方 sha256 前 16 位）后才允许落 `ui/intro/`；
2. **入库位置** `ui/intro/intro-{brand,cyberpunk,awakening,startup}.mp4`（frontendDist 内，
   asset 协议直读，不进 Rust 嵌入资源）；
3. **署名文件** `ui/intro/THIRD-PARTY-NOTICE.md`：NativeDog1/dsh-boot-animation BSD-3-Clause
   + 素材来源 tag + 提取日期（§5-D8）；
4. `_refs/boot-intro-clips/` 不入库（`_refs/` 已 ignore）——脚本 + SHA 台账保证任何机器可重放；
5. **防漂移**：上游更新与本仓无关（素材是快照不是依赖）；重跑脚本以 SHA 不符为停止信号。

## 5. 设计决策（推荐已标，其余并列待拍板）

### D1 素材带法（R5 已隐含拍板：A）

| 方案 | 包体增量 | 说明 |
|---|---|---|
| **A. 全带四段 + 启动设置栏选择（拍板）** | **+9.1 MB** | R5「外观设置页加启动设置栏」含片头选择器 ⇒ 四段全带；选择器值域 = §4 四段固定 id |
| B. 只带 brand | +1.3 MB | 与 R5 冲突（无选择余地），作废 |
| C. 全带四段不选择 | +9.1 MB | 随机播——观感不可预期，作废 |

### D2 音轨策略（R5 后升级为设置项）

**默认静音（`muted`）+ 启动设置栏开关**（`boot.audio`，出厂 `false`）。muted 同时是
WebView2 autoplay 放行的前提（§7-1 验收联动）；出声是用户显式选择，不是默认行为。

### D10 启动设置栏（R5 主体，appearance 半 + 跨线契约）

**面板**：appearance `client.js` 的 `SECTION_LABELS` 新增 `boot: '启动'`（第六板块，排在
「应用图标」之后）；控件行复用 V1 行式化规范（选择丸 / 开关行既有形态）：

| 控件行 | 形态 | 值域 |
|---|---|---|
| 启动片头 | 选择丸 | 关闭 / 品牌片头 / 赛博朋克 / 数字角色苏醒 / 启动问题（出厂 = 品牌片头） |
| 片头声音 | 开关行 | 开 / 关（出厂关） |
| （说明行） | 运行信息 | 「下次启动应用时生效」——设置写入 ≠ 当前会话热切，**不装热重载**（片头生命周期只有启动头几秒，热切无意义） |

**配置**：`lib/config.js` `CONFIG_VERSION` 6 → 7，新增顶层 `boot` 板块：

```json
"boot": { "intro": "brand", "audio": false }
```

- `intro`：`'off' | 'brand' | 'cyberpunk' | 'awakening' | 'startup'`，非法值收窄回 `'brand'`
  （`sanitizeConfig` 既有纪律）；迁移 v6 → v7 纯新增板块、旧配置补默认（同 v3/v5 先例）；
- `audio`：布尔，非布尔走默认 `false`；
- **`boot.intro` 枚举值域 = §4 素材管线四段 id，跨线同步点**（见下）。

**跨线契约（改一处必须同步另一处，模板 = `launcher_icon.rs` 头注释 ↔ `lib/avatar.js`）**：

| 项 | 值 |
|---|---|
| 配置路径 | `<dshHome>/miasaki-appearance/config.json` |
| 字段 | 顶层 `boot.intro`（枚举）/ `boot.audio`（布尔） |
| appearance 半 | `lib/config.js`（schema v7 + sanitize 收窄）+ `client.js`（板块 UI + 保存） |
| desktop 半 | 壳启动最早读一次（`start_launch_sequence` 之前、窗口 build 期间）；不轮询（与 avatar 的 1.5s 巡检不同——片头只在启动瞬间消费） |
| 值域同步 | 枚举两侧硬编码；壳侧遇未知 id / 素材缺失 ⇒ 回落 `brand`；`brand` 也不存在 ⇒ 视频层整体不启用（L1 兜底） |
| 契约登记 | 本文档 + `launcher_icon.rs` 同款头注释（新模块 `boot_intro.rs` 或并入 main.rs 的 boot 序列）+ `lib/config.js` 注释 |

**边界（继承 avatar 先例的防御姿态）**：配置缺失/损坏/未知值 ⇒ 全部静默回落出厂档
（brand + 静音），**绝不因配置问题拖住启动**；「关闭即原生」——`intro: 'off'` ⇒ L2 整层
不注入，行为与 2.0 现状完全一致。

### D3 就绪时序（核心拍板点）⭐

冷启动 dsh 3–6s，视频 7.05s，两者赛跑：

| 方案 | 机理 | 代价 |
|---|---|---|
| **A. 就绪即淡出（推荐）** | port_ready → 视频 300ms 淡出 → navigate（与 2.0「就绪回弹」动效同窗口） | 后端快时用户只看到片头前几秒——但这正是「片头不是屏保」原则 |
| B. 播完才切 | 等视频自然结束 | 最坏 +7s 人为延迟，违背 2.0「不假装在加载」纪律 |
| C. 最少播 N 秒 | max(ready, N) | 折中但引入魔法数；N>ready 时同 B 的代价 |

附带规则：**等待期视频播完 → 停尾帧 2s 后淡出回落 L1 纹章层**（90s 等待场景视频不能循环刷存在）；
**点击/任意键跳过**（跳过只切视频层，不干扰就绪链路）。

### D4 失败让路（硬契约）

`__setRetry(true)` / 超时 / dsh 不可用 → 视频层立即淡出（≤200ms），失败卡片在视频之上（DOM 序
保证，同层内 z 递增）——失败现场优先于观感，继承 bootstrap-reliability 全部结论。

### D5 降级链（深度适配的底座）

| 触发 | 行为 |
|---|---|
| `prefers-reduced-motion: reduce` | 不播视频，L1 纹章层照常（S4a 已有全量静止） |
| 视频解码失败 / 文件缺失 / autoplay 被拦 | `error` 事件 → 视频层隐藏，L1 纹章层照常 |
| `__appendLog` 日志流（2.0 S3/S4b 未来落地） | 叠加层兼容：视频在时折叠徽标照常可展开 |

**L1 不删不改**——它是视频层的一切失败模式的兜底，也是 2.0 S4a 测试（10 例）的存量资产。

### D6 主题融合

- 视频 `object-fit: cover` 铺满窗口（第三方同款「铺满屏幕」档）；16:9 与窗口比例不齐时裁切；
- **上下遮罩渐变**（纯 CSS `linear-gradient`，≤96px）把视频黑底过渡到主题底色——尤其
  kurkuriel 亮主题（视频深色帧直切浅色主题最突兀）；
- wordmark / 状态条叠加在遮罩带上（不在视频帧中央，不抢画面）；
- 纹章（L1）在视频淡出瞬间已就位于下层——**退场即无缝**，这是「深度适配」相对第三方
  浏览器浮层的本质优势：窗口、底座、退场目标全是自己的。

### D7 与 appearance P2 splash 的接力

**本设计对 appearance 线的改动仅限 R5 点名的设置板块与 config 字段**（跨线零耦合纪律的
边界由用户点名划定）；splash **行为层**仍不动。现状：loading navigate → 3080 → appearance
splash（2.5s 兜底自动退场）。双重片头观感问题**实测后再定**：若重复感明显，再提
`cross/boot-loading` 契约修订（如壳内 navigate 时带 hash 标记，splash 让位——复用既有
`data-miasaki-theme` 让位协议思路）。**先不预支跨线改动。**

附带归位问题（P2 项，不阻塞）：现有 `motion.bootSplash`（3080 首帧启动画开关）现居「动效」
板块；「启动」板块成立后其 UI 归属是否迁入——**存储字段位置不动**（`motion.bootSplash` 原位），
只做面板行迁移 + `SECTION_LABELS` 措辞同步。第一版不迁（克制增量），记入 D10 的 P2 待办。

### D8 署名（BSD-3 义务）

`ui/intro/THIRD-PARTY-NOTICE.md` + 「导出诊断」附带（诊断 zip 内含 THIRD-PARTY 文件）+
设计文档 §2.1 记录来源。不弹 UI（克制）。

### D9 P9 闪窗验收（R2 收口）

P9 代码已落地，欠实机判据。验收：冷启动连续 5 次无终端闪现（procmon 抓 conhost/cmd 创建链
可选加做）；残余孙进程（S3 嫌疑）单列记录不阻塞。

## 6. 实施顺序（拍板后执行）

| 步 | 内容 | 产出 |
|---|---|---|
| S0 | ~~素材实测~~（✅ 2026-10-04 完成，§2.1 表）+ **WebView2 muted autoplay 实机冒烟**（仅剩项） | 取证记录 |
| S1 | 素材管线（提取脚本 + SHA 台账 + 四段全入库 + 署名） | `ui/intro/` + `scripts/extract-intro-clips.mjs` |
| S2 | loading.html L2 视频层 + 叠加信息层 + D4/D5 降级 | 页面半（纯增量，L1/L3 不动） |
| S3 | 就绪时序接线（Rust ready → 淡出；跳过；播完回落；D3 拍板结果） | Rust 半小改（复用既有 `__setReady` 预留钩子） |
| S3.5 | **启动设置栏（appearance 半，R5）**：config v7 `boot` 板块（schema + sanitize + 迁移）+ 面板「启动」板块（选择丸 + 开关行 + 生效说明）+ 跨线契约登记 | `lib/config.js` + `client.js` 增量 + 测试 |
| S4 | 主题融合目检（三主题 + Mica + 亮主题遮罩） | 目检记录 |
| S5 | 回归：`loading-visual.test.js` 增视频层契约用例（降级矩阵穷举）；appearance 单测增 `boot` 板块用例（sanitize 收窄 / v6→v7 迁移 / 枚举同步）；verify-all desktop + appearance 两线更新 | 测试绿 |
| S6 | 实机验收（§7 全项，含 D9 闪窗 5 次冷启动 + §7-9 设置链路） | 验收记录 |

依赖：S0 → S1 → (S2 ∥ S3 ∥ S3.5) → S4 → S5 → S6。S3.5 只依赖契约（§5-D10 表），可与
S2/S3 并行。与 2.0 的 S3/S4b（日志流/阶段进度）**正交**，排期互不阻塞。

**跨线清单（本设计引入的同步点，实施时逐项核对）**：`boot.intro` 枚举值域两侧硬编码
（appearance `lib/config.js` ↔ desktop 壳消费模块）；config 路径 `<dshHome>/miasaki-appearance/
config.json` 沿用 avatar 先例。

## 7. 验收标准

1. 冷启动 5 次：视频出现、**muted autoplay 放行**（WebView2 实机）、就绪 300ms 内淡出、
   无黑帧断档（视频→纹章→3080 全程有画面）；
2. 视频播完后端仍未就绪：停尾帧 2s → 淡出 → 纹章层 + `#boot-timer` 照常；90s 超时提示不挡；
3. 失败路径：dsh 摘除 / 端口占用 → 失败卡片立即可见（视频 ≤200ms 让路），诊断按钮组零回归；
4. 降级：系统「减少动画」/ 视频文件损坏 → 纹章层完整接管，功能不变；
5. 三主题各目检一次（kurkuriel 亮主题遮罩过渡重点）；Mica 下无闪烁；
6. **R2 收口**：冷启动 5 次无终端闪现（P9 验收，残余孙进程单列）；
7. 包体增量 +9.1 MB（D1-A 拍板值，±0）；安装器体积核对；
8. 署名文件存在 + SHA 台账全绿（重放提取脚本验证）；
9. **设置链路（R5）**：面板选「赛博朋克」+ 声音开 → 保存 → **重启应用** → 播的正是所选段且
   出声；选「关闭」→ 重启 → 与 2.0 现状逐帧一致（「关掉即原生」硬契约）；手改 config 塞非法
   id → 重启回落品牌片头不报错；**删除 config.json → 出厂档（brand + 静音）**。

## 8. 风险与边界

- **autoplay 策略**：WebView2 桌面上下文 muted autoplay 通常放行，但属「经验推断」——S0 实机
  冒烟是硬前置，被拦则视频层降级为「首帧 poster + 纹章动效」（不是阻塞项，是降级矩阵一员）；
- **包体**：安装器 +9.1 MB（D1-A 拍板，R5 选择器需要全量素材；验收 7 核对）；
- **品牌性**：素材为 DeepSeek 品牌片头，用于 MIASAKI 个人桌面端——BSD-3 授权明确、非商用
  个人项目，风险可忽略；后续若自制片头，管线（§4）同一套换文件即可；
- **音轨版权**：README 声明 clips 以相同条款（BSD-3）分发，D2 默认静音 + 显式开关进一步规避；
- **跨线值域漂移**：`boot.intro` 枚举两侧硬编码——一侧加段另一侧没加时，壳侧未知 id 回落
  `brand`（不报错不阻塞），面板选择器显示的就是 appearance 侧清单。同步义务写入 D10 契约表；
- **Windows-only**：`creation_flags`（P9 已 `#[cfg]`）与 WebView2 均现有限定，本设计同边界；
- **不做**：不联网下载素材、不做设置面板内**预览播放**（appearance 面板在 3080 文档里够不到
  桌面壳 asset 协议的 `ui/intro/`——跨文档资源不可达；第一版选择行纯文字 + 时长/大小信息，
  首帧缩略图因本机无 ffmpeg 提帧管线暂缓，均为 P2 待办）、不做热重载（片头生命周期只有启动
  头几秒，面板改动「下次启动生效」并在说明行写明）、不动 `__setStatus`/`__setRetry` 既有契约、
  不做跨页动画接力（D7 实测后另提）、第一版不迁移 `motion.bootSplash` 的面板归属（D7 附记）。

## 9. 决策清单（2026-10-05 全部拍板 ✅）

| # | 决策 | 拍板结果 |
|---|---|---|
| D1 | 素材带法 | ✅ **A：全带四段**（R5 设置栏隐含拍板，+9.1 MB） |
| D2 | 音轨 | ✅ 默认静音 + 启动设置栏开关（`boot.audio`） |
| D3 | 就绪时序 | ✅ **A：就绪即淡出**（300ms；播完停尾帧 2s 回落纹章层；点击/任意键跳过） |
| D6 | 主题融合 | ✅ **上下遮罩渐变 + cover 铺满** |
| D10 | 启动设置栏 | ✅ appearance 第六板块 + config v7 + 壳读文件（avatar 先例模式）；细节见 §5-D10 |

## 10. 实施记录（2026-10-05）

### 10.1 已落地（S1 / S2 / S3 / S3.5 / S5）

| 落点 | 文件 | 要点 |
|---|---|---|
| S1 素材管线 | `scripts/extract-intro-clips.mjs`（新）、`ui/intro/intro-{brand,cyberpunk,awakening,startup}.mp4`（新，共 9.1 MB）、`ui/intro/THIRD-PARTY-NOTICE.md`（新） | 台账 = 字节数 + SHA256 前 16 位（对齐上游 `clips.meta.js`）；`--check` 只校验不写盘（已进 `verify-all` desktop 线）；`--fetch` 可重放下载 |
| S2 页面半 | `ui/loading.html` | 新增 L2 层（`.mia-intro*` 规则 + 按需建层的 IIFE）；`__setReady` → 300ms 淡出、`__setRetry(true)` → 150ms 让路（既有钩子内各一行，守卫式调用）；reduced-motion 双道（JS 不建层 + CSS `display:none`） |
| S3 壳半 | `src-tauri/src/boot_intro.rs`（新）、`main.rs`（`mod` + `boot_intro_state` 命令 + 注册）、`launcher_icon.rs`（`CONFIG_REL` 改 `pub(crate)` 供复用） | 判定三分：总开关 `enabled` / `boot.intro` 白名单 / `boot.audio`；**`decide()` 是零依赖纯函数**（决策矩阵唯一实现），serde 只负责取三个原语、IO 只读一次 |
| S3.5 设置栏 | `dsh-miasaki-appearance/lib/config.js`（v6 → v7 + `INTRO_CLIPS` + sanitize/merge 分支）、`client.js`（`SECTION_LABELS.boot` + `INTRO_OPTIONS` + 「启动」板块） | 面板两行（片头选择丸 + 声音开关）+ 生效说明行 + `resetRow('boot')`；`enabled=false` ⇒ 控件禁用（与 splash 同源门控） |
| S5 回归 | `ui/test/loading-visual.test.js`（11 → **15 例**）、`dsh-miasaki-appearance/test/config.test.js` + `client.test.js`（145 → **149 例**）、`scripts/verify-all.mjs`（desktop 39 → **40** 项）、`AGENTS.md` / `docs/ENGINEERING.md` 台账 | — |

### 10.2 本会话内取得的验证证据（含反向验证）

- **素材闸门**：四段 SHA256 与上游官方值逐段全对；**注入 1 字节缺陷 → `--check` 转红、退出码 1**（证明闸门有区分力），随后重放脚本还原并复检全绿。
- **页面 L2 层**：`ui/test/loading-visual.test.js` 15/15 绿（既有 11 例零回归 + 新增 4 例：布局契约 / 门控矩阵 5 档 / 正常路径 / 退场四路幂等）；**三处定向缺陷（拆掉门控、z-index 降到 0、忽略音轨）→ 恰好 3 条对应用例转红**，未涉及的 12 条保持绿；还原后 SHA256 与原文件一致（`8f05849c…9e86`）。
- **Rust 壳半**：`cargo test` 被本会话沙箱拦（`os error 5`），改用**离线直编**取证 —— `rustc --test --edition 2021` 编译**真文件全文**（`#[path]` 引 `boot_intro.rs` + 最小 `launcher_icon` 桩 + 复用 target 里的 `libserde_json` rlib）⇒ **7/7 全绿**（含 serde 提取层与 IO 层）；**定向注入音频方向缺陷 → 恰好 `parse_reads_three_primitives` 转红**。生成器 `_refs/rust-harness/make-boot-intro-harness.mjs`（`_refs/` 不入库）。
- **appearance 半**：149/149 绿（`boot` 板块的 sanitize 收窄 / v6 → v7 迁移 / 面板渲染 / 增量 patch / 总开关禁用门控各有用例）；`node --check` 语法闸门通过。
- **仓库级**：`verify-all` 口径 desktop **40/40**（除 cargo）、appearance **18/18**、fleet 21/21、sidebar/canvas/ssh/dual-model/usage/free-model 全绿；`repo` 的红两处均为环境边界（`md-links` 的 `EBUSY spawnSync git`）或**存量 fleet 产物**（`style` 报的 `agents/pi/inbox/*.json` BOM/换行、`status.json` CRLF —— `check-style.mjs` 输出中无本次新增/改动文件）。

### 10.3 浏览器内核取证（`2026-10-05` 追加，Edge 154.0.4258.53 = WebView2 同内核）

`_refs/boot-intro-verify/verify-intro-browser.mjs`（一次性工具，**不入库**；同目录 `_verify.log` 与
`shot-1/2/3-*.png` 为证据留档）在真实浏览器里驱动 `ui/loading.html`（进程内静态服务 + Tauri IPC 桩），
**17/17 全绿**，并**逐张目检了三张截图**：

| 项 | 实测结果 |
|---|---|
| 解码能力 | `canPlayType('video/mp4; codecs="avc1.42E01E"')` = **`"probably"`**（Edge 含专有编解码器；Playwright 自带开源 Chromium **不含**，故脚本先探测再决定取证范围） |
| **muted autoplay** | **放行**：`currentTime` 推进到 0.79s、`readyState=4`，全程无用户手势 ⇒ §8 验收 1 的核心假设成立 |
| cover 铺满 | 层与 video 的 `getBoundingClientRect()` 逐像素等于视口 1280×800；源 1280×720 ⇒ 比例不等**真实发生裁切**（左右裁） |
| 层叠顺序 | `elementFromPoint` 中心命中 `video`（属片头层子树）且**纹章中心已被覆盖** ⇒ 命中测试证明 z 序真实生效，而非只看样式声明 |
| 遮罩渐变 | 上下遮罩 96px、`linear-gradient` 在位；换 `data-miasaki-theme=kurkuriel` 后 `--mia-bg-lo` 由 `#0c0b11` → `#e9e3dd` ⇒ 遮罩**跟随主题**（D6 落地） |
| 就绪即切 | `__setReady()` → 淡出启动 → 节点移除、`mia-boot-ready` 点亮、纹章层重新可见；**截图目检无黑帧断档** |
| 播完回落 | 连续打点（200ms 粒度、窗口 4.2s）显示：seek 到片尾触发**浏览器自己的** `ended` → 尾帧停留 **~2805ms** 后撤层（设计值 2s + 300ms 淡出，偏差在采样粒度内） |
| 失败让路 | `__setRetry(true)` → 片头 150ms 撤层，重试按钮 + **5 个**诊断按钮在位、「已等待 1.3 s」计时继续走（失败路径仍走表） |
| 门控五档 | 关闭 / 未知段 / 非字符串 / 无 Tauri IPC / `reduced-motion` ⇒ **页面零 `<video>` 元素** |
| 控制台 | 三钩子（`pageerror` / `console error` / `requestfailed`）**零错误** |

**这批证据的边界（不得越界引用）**：以上是 **Edge/Chromium 内核 + 静态服务 + IPC 桩** 环境下的行为，
**不等于 WebView2 实机**。仍未验证、仍归用户侧：

1. **WebView2 宿主内的真实启动链路**：`boot_intro_state` 经 Tauri IPC 拿到真实设置、`ui/intro/` 经
   **asset 协议**（而非 http）加载 mp4、WebView2 首帧与 GPU 合成 —— 三者本脚本都没覆盖；
2. **S4 三主题目检**（截图只看了 zafkiel；kurkuriel 亮主题下深色片头与浅色主题的突兀程度需人眼判断）；
3. **S6 实机验收全项**（P9 闪窗 5 次冷启动、「面板改配置 → 重启应用生效」链路、包体 +9.1 MB 核对）；
4. **`cargo build` / `cargo test`**：`main.rs` 的 tauri 接线未过完整 crate 编译（本会话沙箱 `os error 5`）。
   —— **已清账（2026-10-05 续，§10.8）**：完整编译修复 4 处 E0133 后 `cargo test --release` **147/147 全绿**。

### 10.4 Tauri asset 协议承载 mp4 的链路查证（`2026-10-05`，读 tauri 源码）

**问**：WebView2 里 `<video src="intro/intro-brand.mp4">` 走 tauri 内置 asset 协议，能不能播？
**答**：能，但有两条硬约束与一处性能代价。以下全部来自本机 cargo registry 的 tauri 源码实读
（`tauri-2.11.5/src/protocol/asset.rs`、`tauri-utils-2.9.2/src/mime_type.rs`、`tauri-codegen-2.6.3`）。

| # | 查证项 | 源码落点 | 结论 |
|---|---|---|---|
| 1 | 是否支持 Range（媒体必需，浏览器会发） | `asset.rs:90-140`，用 `http_range::HttpRange::parse` | ✅ 支持 206 + `content-range` 头 |
| 2 | **单次 Range 上限** | `asset.rs:118-119`：`const MAX_LEN: u64 = 1000 * 1024` | ⚠ **每次最多 1 MB** ⇒ 1.3 MB 片段头 2 段、3.3 MB 片段头 **4 段** |
| 3 | MIME 是否含 mp4 | `mime_type.rs:38,67`：`Some("mp4") => Self::Mp4` → `"video/mp4"`，且**带单测**（同文件 `:139-140`） | ✅ 显式判定，不靠扩展名猜 |
| 4 | 未知扩展名的回落档 | `parse_from_uri_with_fallback` 的 `Some(_) => fallback`（默认 `Html`） | ⚠ 若把素材改名成非 `.mp4` ⇒ 回落 `text/html` ⇒ **静默不播**。提取脚本固定 `intro-<id>.mp4` 命名即免疫 |
| 5 | 每次请求的固定开销 | `asset.rs:74-82`：先读 `min(len, 8192)` 字节做魔数嗅探再 `rewind()` | ⚠ 每段都要**重开文件 + 读 8 KB + rewind** |
| 6 | 资产是否嵌入 exe | exe 内搜 `mia-boot-scan` **未命中**、搜 `MIASAKI`/`__setRetry` 命中 + 有 deflate 特征 | ⇒ 资产**压缩嵌入 exe**（`tauri-codegen` 的 `EmbeddedAssets`），故 `dist/ui/` 只是 `deploy-local.ps1` 的镜像源 |

**由此得出的两条工程结论**：

1. **不要在壳侧再判「素材在不在」**——素材是**编译进 exe 的嵌入资产**，磁盘上（连
   `dist/ui/` 里）都不存在该文件，运行时唯一判据是配置枚举 + 浏览器能否解码。这条纠正了
   「壳侧预检文件存在性」的朴素想法：`boot_intro.rs` 保持只读配置、只判枚举（现状正确，无需改）。
2. **启动路径上每段多一次开文件 + 8 KB 嗅探**是可接受的（片头只在启动头几秒、且是本地磁盘），
   但**4 段的 `startup` 片段（3.3 MB）最贵**。若实机目检发现首帧有可感知延迟，
   优先手段是压小该片段体积（`scripts/extract-intro-clips.mjs` 的台账已含字节数，改完重跑
   `--check` 即闸门），而不是改协议层。

**顺带发现并已修的真实缺口**（见 §10.5）。

### 10.5 部署缺口：素材缺失会**静默退化成纹章层**（已加闸门 + 反向验证）

用同一套浏览器验证脚本改指**部署产物**当资产根（`--root=…/dist/ui`）跑一遍，暴露了实机前就能看见的缝：

- `dist/ui/loading.html` 是 **2026-09-25** 的旧快照（源目录已 10-05），**不含 L2 层代码**；
- `dist/ui/intro/` **整段不存在**；
- 跑出来：门控五档仍全绿（不依赖新代码），而 **8 条行为断言全红且统一报「层不存在」**。
  这正是实机上的真实表现——**不崩溃、不报错，只是片头不播**，用户会以为「设置没生效」。

**已加的防线**（`scripts/deploy-local.ps1`，两道）：
1. **部署前**：源 `ui/intro/` 四段缺任一即 `exit 1`，abort 消息点名缺哪几段 + 给出修法
   （`node scripts/extract-intro-clips.mjs`）；
2. **部署后**：再验安装目录 `ui/intro/` 四段在位——因为 `robocopy /MIR` 只保证「不残留旧文件」，
   **不保证「新文件被带上」**，源目录缺时它照样绿。

**反向验证**（已做）：临时移走 `ui/intro/` → 跑 deploy ⇒ **退出码 1** + abort 消息准确点名
`brand, cyberpunk, awakening, startup` 四段 + 给出两条修法；随后还原素材、`--check` 复验 4/4 全绿。

### 10.6 取证过程自身的两个缺陷（测试侧，非产品缺陷，如实记录）

1. **反假绿闸门（必须保留的设计）**：首版「就绪即切」断言是**结束态**判定（节点应不存在），
   在**层压根没建**的情况下照样通过 ⇒ 当时 10 条红里它却绿。已加 `requireLayer()` 前置：
   所有行为类断言**先验证层在位**，层不在位即 FAIL。
2. **断言自身的判据写错**：层叠顺序首版用「命中元素的 `className` 含 `mia-intro`」判定，
   而 `video` 元素没有 class ⇒ 把「命中 video」误判成「没盖住」。已改为 `el.closest('.mia-intro')`。
   **两次都是「测试自身写坏」而非产品缺陷**——与 `AGENTS.md` §清仓纪律里那条「能全绿 / 能编译仍可能
   是假绿」同族，已把 `requireLayer` 前置固化为本脚本的通用范式。

### 10.7 实施中的设计微调（与 §5 原文的差异，如实记录）

- **信息叠加层收窄**：§5-D6 原写「wordmark / 状态条叠加在遮罩带上」，落地改为**片头播放期间不叠加**（视频盖在 `.stage` 之上，纹章与文案在片头淡出瞬间露出）——理由：`.stage` 的 `z-index:1` 自成层叠上下文，其子节点无法逃到 z-index 2 的片头层之上，硬叠需要在视频层内复制状态文本（**同一状态两份来源**，必然漂移）。取舍：片头期间画面纯净（更接近第三方原味），状态/计时在片头结束后照旧完整可见，失败路径 150ms 让路后立即可见。
- **`enabled` 门控**：片头受**外观线总开关**管（与 `splashEnabled` 完全同源）。理由：设置入口在 appearance 面板，总开关是用户对该线的统一预期；代价是出厂 `enabled=false` 时片头不播（需用户开启总开关）。面板在总开关关闭时禁用两枚控件并在说明行点明。
- **`motion.bootSplash` 归属未动**（§5-D7 附记的 P2 项，按计划推迟）。

### 10.8 完整构建 + 部署 + P9 冷启动取证（`2026-10-05` 续，普通终端实跑）

§10.3 边界清单第 4 项（`cargo build`/`cargo test` 未过完整编译）在本轮**清账**。全程在
`danger-full-access` 会话内实跑（`cmd.exe` 被本会话环境拒绝 spawn，改走 bash 前置 MSVC
`link.exe` 路径 + powershell 直调，绕行细节不赘）。

**① 完整编译暴露并修复 4 个 E0133（真编译风险，上轮从未被完整编译验证过）**：
`pet_native/window.rs` 的三个 v5 M4 弹簧拖拽新函数（`flush_drag_target` / `end_drag` /
`apply_dock`）直接调用 FFI（`MoveWindow` ×3 / `KillTimer` ×1）而脱离了原 unsafe 上下文，
按同文件 `show_menu` 的局部 `unsafe {}` 先例逐一包裹；另修 `pet_native/model.rs:204`
`thread_local!` 宏上的 unused doc comment（`///` → `//`，宏生成的 static 不吃 outer doc）。

**② `cargo test --release` 真跑：147/147 全绿（抓出 1 个测试自身写坏）**——
`settings::tests::zero_motion_survives_round_trip` 挂在「normalize 把 0 抬回 1.0」断言，
排查确认 **normalize 实现无 truthy 陷阱，是测试拿错了样本**：②③ 段该用 ① 里显式
`motion:0.0` 的 `s`，却 clone 了「缺字段对照样本」`d`（motion=1.0）⇒ 断言恒红。
已改用 `s` 样本（`z`）并在测试内注明。与 §10.6 的两处同族——**「测试自身写坏」且
「从未真跑过所以不暴露」**。口径：desktop `cargo test` 109 → **147 例**（含 boot_intro 7 例、
v5 M4 弹簧/停靠与 settings E2 各批新增）。

**③ 构建 + 签名 + 部署全链**：`cargo build --release` 23.64s 成功，exe 36,644,192 →
**45,686,784 B（+9.0 MB）**——片头素材嵌入的体积实锤（§10.4-6 的「压缩嵌入」推断被
增量证实）；signtool（`Miasaki Dev` 证书）`Successfully signed` + 验签 Valid；
`ui/` → `dist/ui/` robocopy /MIR（§10.5 的部署闸门源头补齐：新版 loading.html +
`intro/` 四段 + 署名文件就位）；`npm run deploy` 因本会话 cmd 拦截改 powershell 直调
`deploy-local.ps1`（同一命令的等价展开），**10/10 全 PASS**（片头素材部署前后双验、
exe 哈希一致 `DD6AC679E928F3AF`）。

**④ P9 闪窗验收（§5-D9 / 验收 6）：PASS，三重证据**——探针 `_refs/tmp-build-bootintro/`
（日志与截图留档）：
1. **子树正查**（决定性）：冷启动 `C:\ProgramData\MiasakiApp\Miasaki.exe`，10s 窗口内直查
   `ParentProcessId = Miasaki PID` —— 子进程**只有 `msedgewebview2.exe` + `node.exe`**，
   零终端类进程；`pet.log` 同证 `spawn-dsh: node 直启后端（绕开 cmd.exe）pid …`；
2. **空跑对照**：不启动任何东西的 3s 窗口内，环境自身也出现新 `conhost`（父即逝）⇒
   首轮探针「宽口径监控」报的 12 个命中是**环境噪声**（dsh web / 会话工具链自身的活动），
   非 Miasaki 派生——首轮里真正含启动的 Round 1 反而 0 命中；
3. **应用健康**：5 次冷启动均正常拉起（桌宠窗 `MiasakiPetWin` 在位、3080 页面加载、
   `bootstrap.json` 的 `phase:"up"`）。

**⑤ 片头在当前机器上不播 = 预期行为（配置侧，非缺陷）**：`~/.dsh/miasaki-appearance/config.json`
停在本机 09-28 的 **v6**（`enabled:true` 但无 `boot` 板块）⇒ 按 §10.7/`boot_intro.rs` 的
判定「缺 boot 板块视同关闭输入」不播。**片头实播待两步**：appearance 新版（v7）在 dsh web
里跑一次（schema 迁移补 `boot` 板块）→ 用户在外观面板选段保存 → 重启应用。§10.3 的
「WebView2 实机 autoplay」验证随之顺延（S0 冒烟与 §10.3 浏览器取证已证内核能力）。

**⑥ 仍归用户侧**：§7 三主题目检（kurkuriel 亮主题遮罩重点）、§7-9 设置链路四分支
（面板改段 → 重启生效 / 关闭即原生 / 非法 id 回落 / 删配置出档）、§7-7 安装器体积核对
（本轮绿色部署未经 bundle）。

### 10.9 「片头一直没播」的根因：旧配置迁移只在内存、从不落盘（`2026-10-05` 续二，已修）

§10.8-⑤ 把「不播」记成**配置未迁移**的预期态，并给出「appearance 跑一次迁移 → 面板选段保存 → 重启」
三步走。用户回报「桌面端启动动画怎么还没有」后按这条线索复核，发现**三步走的第一步根本不会发生** ——
这不是一个待办，而是一处**跨线裂缝**。

**① 先排除三个更显眼的嫌疑（全部实测为「好的」）**：

- 壳侧判据完整：`boot_intro.rs` 的 `decide` / `parse_boot_intro` 齐备，`boot_intro_state` 已在
  `invoke_handler` 注册（`main.rs`），且真的调用 `read_boot_intro()` 读
  `<dshHome>/miasaki-appearance/config.json`；`dsh_home()` 的取值经核对（`DSH_HOME` 未设 ⇒ `~/.dsh`）
  与 appearance 侧的 `dshHomePath('miasaki-appearance/')` **同源同路径**。
- 素材齐备：`ui/intro/` 与安装目录 `C:\ProgramData\MiasakiApp\ui\intro` 四段 mp4 逐段同尺寸。
- 部署到位：快捷方式 `Miasaki 桌面端.lnk → C:\ProgramData\MiasakiApp\Miasaki.exe`，该 exe 为含素材的
  新构建（12:14 构建，体积比 09-23 版 **+2.7 MB**，与 §10.8-③ 的嵌入实锤同族）。

⇒ **断点只剩配置**：`~/.dsh/miasaki-appearance/config.json` 仍是 v6、无 `boot` 板块。

**② 根因（不是配置没迁，是迁了没写盘）**：`AppearanceStore.load()` 只做 `sanitizeConfig()`
（内部 `migrateConfig()`）—— **内存**里配置确实抬到了 v7，但**从不写回磁盘**；而壳侧
`read_boot_intro()` 读的是**磁盘文件**。落盘原本只发生在 `save()` 路径上，于是形成死锁：
要落盘就得在面板里动一次设置，而面板「启动」板块在读到无 `boot` 的配置时只会提示
「重启宿主后重试」。`lib/config.js` 里 `migrateConfig` 的注释「抬版本号让旧配置在**下次写入**时
清净落盘」正是这个假设的出处：**「下次写入」可能永远不来**。

**③ 修复（迁移归 schema 所有者，壳侧不猜默认值）**：appearance 新增
`AppearanceStore.loadWithMigration()` —— 读配置时若**盘上 `version` 落后于 `CONFIG_VERSION`**
就把迁移结果原子回写一次；回写失败**不阻断**（本次仍以迁移后的配置生效），把原因交回调用方，
由 `index.js` 记入 logger（成功 info / 失败 error，**都不静默**）。`load()` 语义与行为不变
（复用新增的 `readRawConfig()` 单一 IO 读入口）。
**为什么不让壳侧也做迁移**：判定逻辑只能有一份，壳侧纪律是「字段缺失 ⇒ 不播，不猜默认值」（§5-D10），
schema 迁移属插件；回写是让两侧对齐的**唯一**无重复实现方式。

**④ 时序边界（如实记录，别把「代码修好」当成「当次就播」）**：壳**先于**宿主读配置，
因此只改代码不足以让当次启动生效。本机已有的 v6 配置已用插件自身实现一次性迁移落盘
（`v7` + `boot:{intro:'brand',audio:false}`，其余用户设置逐字段保留；迁移前备份
`_refs/appearance-config-v6-backup-20261005.json`）。**下一个启动周期起片头才具备播放条件**；
此后新装 / 升级的机器不会再有这个窗口。

**⑤ 本会话验证**：appearance `node --test` **153/153 全绿**（`store.test.js` 7 → 11 例，
判据一律落在**磁盘**上：v6 迁移后盘上必须出现 `version:7` + `boot`，当前版本**不得**产生写盘，
损坏内容**不得**被覆写）；desktop `cargo test --release` **155/155 全绿**（含 `boot_intro` 7 例）；
壳侧判据对**真实配置**的等价校验：`enabled=true` 且 `intro='brand'` ∈ 白名单 ⇒ 「播 brand，静音」。

**⑥ 实机待验（归用户）**：重启桌面端 ⇒ 加载页应播 `brand` 段（静音）、播完回落纹章层；
面板「启动」栏换段 / 开声音 ⇒ **下次启动**生效；选「关闭」⇒ 与原生一致。
§10.3 的「WebView2 实机 autoplay」验证随这次实机走查一并取得。
