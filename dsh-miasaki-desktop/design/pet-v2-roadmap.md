# 桌宠 v2 演进规划（Pet Life & Awareness）

> 状态：规划设计稿（2026-08-22）。依据：OpenDesign 宠物伴侣体系学习笔记
> （`dsh-miasaki-shared-docs/dsh-platform/ref-open-design-pet-companion-2026-08-22.md`）
> + 本线现状盘点。本文件是「做什么、为什么、怎么验收」，不动代码。
> 相关：`design/ARCHITECTURE.md`（实现架构）、`design/TODO.md`（任务清单）、`README.md`（能力描述）。

## 1. 目标

让 Miasaki 桌宠从「有动画的贴图」升级为「**有生活、有感知、可持续**」的形象：

- **有生活**：不操作时也会自己挥挥手、跳一跳（低频随机节拍，而非只在一成不变的呼吸帧）；
- **有感知**：感知 DSH 的「审批等待 / 任务进行中」，用姿态与气泡说出来（桌宠变成状态汇报器）；
- **可持续**：素材生产走契约 + QA 校验，新增角色/行不再靠手气。

## 2. 现状盘点（v1，事实核对过）

| 能力 | 现状 | 位置 |
|---|---|---|
| 载体 | Win32 分层窗（UpdateLayeredWindow 逐像素 alpha），286×390 置顶无边框 | `src-tauri/src/pet_native.rs`（FFI 全裸，零依赖） |
| 动画 | kurumi = Codex atlas 按行切帧（idle/wave/jump/run 四行，行索引 0/3/4/7 与 Codex 规格一致）；whale/inverse = intensity 三态单帧（idle/work/deep） | `ui/pets/frames.json` + `scripts/cut-frames.mjs` |
| 帧播放 | 33ms SetTimer compose；row 帧组 + 按行名 map 的 fps 表（已表驱动） | `pet_native.rs` compose / fps match |
| 交互 | 拖动（增量+DPR）、单击=跳+气泡、双击=挥手、右键菜单（显示/隐藏/最小化/退出） | README + wnd_proc |
| 强度联动 | MutationObserver 每 2.5s 分级 idle/work/deep → `int=` → set_intensity | `themes/runtime.js` + `pet_native.rs` |
| 气泡 | 17 帧构建期预渲染位图（quote_pool 按 mode 取） | `ui/pets/bubbles.png` + `scripts/gen-bubbles.ps1` |
| 持久化 | 位置/角色 `%APPDATA%\com.miasaki.desktop\pet.json`；主题 localStorage | main.rs / pet_native.rs |
| 人格联动 | 主题→agentPreset 会话（DSH RPC session.create）；preset 维护在 `preset-sources/` | README |
| 素材契约 | kurumi/pet.json 带 `spriteVersionNumber: 2`（Codex 契约）+ spritesheet.webp（2.3MB）；whale 为 MIT 第三方 idle.gif；inverse 单帧 png | `ui/pets/*/pet.json` |

## 3. 对照差距（vs OpenDesign 宠物体系）

| OpenDesign 要点 | 我们的差距 | 严重度 |
|---|---|---|
| 行语义化 + 交互→行声明映射 + fallback 链 | frames.json 已有语义行名，但**无声明映射表、fallback 链只有 idle 兜底**（`pet_native.rs` 行 480）；交互→行逻辑散在 wnd_proc/compose | 中（容易做） |
| 环境编排（ambient 随机节拍，手势即打断） | **完全没有**——静止时只有 idle 循环 | 高（「活」的核心） |
| waiting 姿态（45s 长闲 / 审批等待） | **无 waiting 行素材**（row6 未切），TODO P2 审批等待卡在素材 | 高 |
| 任务中心聚合（running/queued/recent、incomplete≠succeeded） | 无任何任务感知；只有强度感知 | 中（先做审批等待，任务汇报后置） |
| 素材契约 + QA（validate/contact-sheet/rubric） | 无校验脚本；素材替换靠手改 frames.json | 中（防回归） |
| 客户端防御（sanitize/钳制、坏配置优雅降级） | frames.json 解析失败会全盘无帧；行数据无钳制 | 中 |
| 自愈迁移（旧配置静默升级） | pet.json 无版本/迁移机制（位置持久化无版本字段） | 低 |

## 3.5 僵硬诊断（2026-08-22 用户反馈「动作少、僵硬」后补，证据已核对代码）

| # | 根因 | 证据 |
|---|---|---|
| 1 | **素材只用 4/9 行**：`cut-frames.mjs` 的 `NEEDED=['idle','wave','jump','run']`，`runRight/runLeft/failed/wait/review` 全躺在 spritesheet（2.3MB）里未切 | scripts/cut-frames.mjs 行 10-12 |
| 2 | **wave 行实际不可达（文档漂移）**：单击/双击都只 `do_hop + focus_main`，无任何代码播放 wave；README「双击=挥手」与实现不符 | pet_native.rs 行 733-745 |
| 3 | **「思考中=原地跑步」违和**：intensity work/deep → 直接播 run 行且**无位移**（原地跑腿），这是平常最容易看到的状态，也是「僵」的最大来源 | pet_native.rs 行 467-471 |
| 4 | **whale/inverse 为静态立绘 + 3px sin bob（3200ms 周期）**：近乎静止；whale 有 76KB 的 idle.gif（多帧）却未被拆用 | pet_native.rs 行 444-452 + ui/pets/whale/idle.gif |
| 5 | **kurumi 无垂直呼吸**：kurumi 分支 `blit_center_bottom(…, 0.0, 1.0)` bob 恒 0，只有帧循环一种节奏 | pet_native.rs 行 494 |
| 6 | **无过渡动画**：跳（900ms）结束瞬时硬切回 idle；所有状态切换无缓冲帧/延迟 | pet_native.rs 行 457-463 |
| 7 | **wander 存在但「滑步」**：随机散步 45-120s 一次、3px/33ms 移动，帧速 10fps 与位移速率未对齐，跑动帧与位移节奏脱节 | pet_native.rs 行 393-415 |

结论：「少」= 素材利用率 + 不可达行；「僵」= 原地跑步 + 静态立绘 + 无呼吸 + 硬切。阶段 A 因此**重组为动作丰富化**（见 §5）。

## 4. 设计原则（含「不照搬」声明）

1. **保持帧组模型，不搬 atlas 切片渲染**：web 端用 background-position 是因为浏览器；原生已按行切帧 + blit，性能与清晰度都已到位。吸收的是**语义行 + 状态机 + 参数**，不是格式。
2. **零依赖不变**：pet_native.rs 的 FFI 全裸是架构底线（GDI 铁律 §4），新增逻辑不得引入 crate、不得在 33ms 主路径分配内存。
3. **兼容向上**：frames.json v1 格式继续可读；v2 纯增量字段；缺字段走默认/降级，不炸。
4. **无新素材也能先落地**：阶段 A/B 全代码可达；需要 waiting 行/新台词时再走阶段 C 的素材链。
5. **素材可缺省**：任何语义行缺失 → fallback 链兜底（idle → wave → jump → run → 第一个可用帧组），永不空白。

## 5. 路线图

### 阶段 A：动作丰富化（回应「动作少、僵硬」，纯代码 + 素材全行切出）

**A0 素材全行切出**（`cut-frames.mjs` 的 `NEEDED` 扩为全部 9 行；非空探测逻辑已在）：

```
idle(6) / runRight(8) / runLeft(8) / wave(4) / jump(5)
/ failed(8) / wait(6) / run(6) / review(6)
```

- 切出后用 `validate-frames`（阶段 C1）清点每行非空帧数，非空才进 frames.json；
- frames.json v1 的既有行名（idle/wave/jump/run）保持不变，新增行纯增量——兼容向上。

**A1 修复不可达行 + 交互映射表**（声明式）：

```
单击     → jump + 气泡（现状保留）；主窗口最小化/隐藏时单击 → 唤起（现状）
双击     → wave；主窗口最小化/隐藏时双击 → 唤起（合并 TODO P2，见决策点 1）
拖拽中   → 冻结 ambient；释放 → idle
ambient  → wave / review / wait（低频随机短演）
长闲45s  → wait 行（无素材则 idle 慢速，渐进式）
```

**A2 强度语义修正**（消除「原地跑步」）：

- work/deep 不再播 run；改为 **wait 行（或 idle 慢放）** 表示的「专注」姿态 + bob 呼吸增强；
- run 行只用于 wander（有位移）与未来拖拽方向动画——**移动才有跑步**是铁律；
- whale/inverse 沿用三态立绘（idle/work/deep 语义本就正确），仅补 bob。

**A3 呼吸与节奏**：

- kurumi 增加垂直呼吸 bob（±2px，~3s 周期相位；复用 whale 分支的 sin 相位算法）；
- idle 循环档位：6fps（常态）/ 4fps（专注态慢放），避免恒定节奏的机械感。

**A4 过渡（消除硬切）**：

- jump 结束 → 末帧 Hold ~200ms → 回 idle（hop_until 结束时不清零进 idle，加短缓冲）；
- 状态切换统一走「目标行 + 帧索引重置」（AtlasSprite 同款行为语义，原生侧对应 `frame_idx=0`）。

**A5 环境编排 + 滑步修正**：

```
首次延迟  4–7s       表演 1.2–2.2s（随机）   休息 8–18s（随机）
动作池    wave / review / wait（柔） + jump（偶发弹跳）；run 不进池
打断     任何 pointerdown / 拖拽 / 单击 / 双击
wander    位移速率与帧速对齐（3px/33ms ≈ 90px/s 对 6 帧循环走 6 帧 = 步频同步，或减速至帧速匹配）
```

**A6 whale/inverse 活度**（低成本先做，素材已有）：

- whale：拆 `idle.gif` 为帧序列循环播放（76KB 素材已存在，仅建链）；
- inverse：静态立绘 + bob 增强（动画帧生成仍在 C2，不阻塞本阶段）。

**验收**：

1. 静止 60s 内随机出现 1–2 次小动作，且拖拽/点击中不触发；
2. work/deep 状态下无任何「原地跑步」——只有 wait/慢速 idle + 呼吸；
3. wander 时步频与位移无明显脱节（无滑步感）；
4. compose 主路径零新增分配、GDI 对象数不增（复用现有 compose/blit 分支）；

### 阶段 B：状态感知（桌宠开始「有用」）

**B1 审批等待**（对标 OpenDesign taskTotal>0 → waiting）：
- 探针先行：确认 DSH rc.x 审批 UI 的稳定性特征（DOM 选择器/状态标记），写一次性探测脚本 → 定特征后接入常驻扫描；
- 常驻扫描复用 runtime.js 现有 MutationObserver 强度分级旁路（同一扫描器加 `st=wait|task` 输出）；
- hash 新参数 `st=`（watchdog 解析 → set_state）——注意 ARCHITECTURE.md 的单向依赖定律，只从注入 JS 发、Rust 读；
- 等待姿态 = waiting 行（无素材则 idle 慢速）+ 气泡切换为「等待主人审批…」台词。

**B2 气泡与台词**：优先从现有 quote_pool 挑选语境帧，**不新增预渲染帧**（新增需重跑 gen-bubbles.ps1，且 GDI 字体崩溃风险区——只有确有必要才进素材链）。

**B3 任务进行中汇报**（后置可选）：DOM 内 run 事件特征成熟后再做；届时标注 **incomplete ≠ succeeded** 语义（OpenDesign #1247 教训：成功但声明工作未完成，不得按成功报喜）。

**验收**：进入审批 → 5s 内桌宠转 waiting/慢速姿态 + 气泡提示；审批完成 → 恢复 idle；DTO 数据流只走 hash 一个方向，Rust 侧零新增写路径。

### 阶段 C：素材契约与 QA（与 A/B 可并行，资产链独立）

**C1 validate-frames.mjs**（对标 validate_atlas.py + qa-rubric 思想）：
- 校验：行帧数 vs 声明值、帧尺寸一致、透明通道有效（无半透明杂边）、行名在语义表内；
- 输出 contact-sheet.png（对标 make_contact_sheet.py）+ 报告；
- 接入构建链（build-init 或独立 npm script，不阻塞主构建，失败仅告警）。

**C2 素材补齐**（按 TODO P2 落位）：
- kurumi **waiting 行（row6）**：从现有 spritesheet.webp 切出即得（素材已在，无需新画）——这是阶段 B 的素材前置；
- inverse 动画帧：立绘已换，动画帧未生（inverse-states.mjs 已有反相处理链，扩展出 idle/wave/jump 行）；
- whale：现有 idle.gif 仅单帧；跳/挥帧需授权确认（MIT 可改，但需要制作）——列入 backlog，不阻塞。

**验收**：validate-frames 在任意素材变更后跑通且准确报告缺失行；kurumi waiting 行可被 frames.json 引用并正常播放。

### 阶段 D：健壮性与迁移（收口）

- **防御性加载**：frames.json 解析失败 → 降级「纯 idle + 气泡」而非无帧；行数据钳制（帧数 1–24、fps 1–30，对标 OpenDesign 钳制范围）；行名不识别 → 跳过并告警；
- **fallback 链**：`请求行 → idle → wave → jump → run → 第一个可用帧组`；
- **配置迁移**：pet.json（%APPDATA%）与 frames.json 加 `version` 字段 + 迁移函数（旧配置静默升级，对标 migrateCustomPetAtlas 思路的本地版）；
- **文档同步**：README 桌宠段、ARCHITECTURE.md（新增 set_state 数据流）、CHANGELOG。

**验收**：手工破坏 frames.json（缺行/坏 JSON/越界帧数）→ 桌宠仍以 idle 运行，日志有告警；老配置升级启动无感。

## 6. 与既有 TODO 映射

| TODO 项 | 落位 |
|---|---|
| P2 桌宠「审批等待」状态 | 阶段 B（素材前置 = 阶段 A0 的 wait 行切出，不再依赖 C2） |
| P2 反转狂三 run/wave/jump 动画帧 | 阶段 C2 |
| P2 桌宠双击=唤起/聚焦主窗口 | 阶段 A1（与双击挥手合并策略，见决策点 1） |

## 7. 决策点（2026-08-22 已全部拍板）

1. **双击语义** ✅：**主窗口最小化/隐藏时双击=唤起，否则=挥手**（两全；修复 wave 行从未触发的漂移）。
2. **ambient 动作池** ✅：wave / review / wait（柔）+ jump 偶发（~15%）；run 不进池（移动才有跑步）。
3. **专注态素材** ✅：~~wait 行为主~~ → **2026-08-22 真机反馈修订：思考中=静默守候**（idle 姿态、无 ambient）。
   wait 行帧组起伏较大（眨眼+下沉），曾作为常驻专注态 + 4fps 慢放 → 真机观感「一直跳动」；
   修正后 wait 行专属阶段 B 审批等待（偶发、有语义），用户反馈触点记录于 CHANGELOG。
4. **气泡新增台词** ✅：审批等待提示复用现有台词池语境帧，**不新增预渲染帧**（避开 GDI 字体崩溃区）。

> 阶段 A 的完整执行方案（数据结构/参数表/函数级改动/顺序/验证）见
> [`pet-v2-phase-a-execution.md`](pet-v2-phase-a-execution.md)。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| DOM 特征误判造成姿态抖动 | B1 探针先行 + 5s 去抖（与强度分级同款节流） |
| ambient 与拖拽/气泡竞争 | 任何 pointer 事件立即打断；ambient 仅限 idle 基线 |
| GDI 回归（新代码破坏铁律） | A/D 阶段坚持「复用现有 compose 分支，不新增 GDI 对象」；验收含句柄计数 |
| wait 行素材实际不可切（row6 透明/空） | C1 校验先行：切帧脚本探测非空帧数量（README 已声明「自动探测每行非空帧」能力，可复用） |
| 强度语义修正引发观感突变（work/deep 从「跑步」变「守静」） | 用户先行确认；修正后观感应「更安静专注」，若有违和回退只需一处映射 |
| 滑步修正矫枉过正（帧速与位移强对齐导致速度变慢） | wander 帧速按位移反推（约 7fps 便匹配 90px/s 步频），允许 ±20% 容差；验收人工观察 |
