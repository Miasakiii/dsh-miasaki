# CHANGELOG — dsh-miasaki-canvas

本文件记录 `dsh-miasaki-canvas/` 线的设计决策与变更。

## 2026-09-26（深夜）· 死代码清理（零行为变更）

仓库级死代码审计后的第一批清理，五项均为「生产路径零引用」。验证：`node scripts/verify-all.mjs canvas`
**12/12 PASS**（9 个测试文件 98 例全过）。

| 项 | 位置 | 判定证据 |
|---|---|---|
| 前端投影第二份实现 `messagesFromEvents()` | `app.js:194-203` | 生产零调用；唯一引用是测试的源码切片（**测试遮蔽型死代码**）。该语义由 host 侧 `index.js` 的 `projectableEvent` 单一口径承担，覆盖见 `workspace-store.test.js`「does not persist the DSH runtime context as a user conversation turn」 |
| DOM 读数版连线 `connectorPathFromElements()` | `app.js:741-749` | 全仓 1 命中＝定义本身；活体是同文件 `connectorPath(fromPosition, toPosition)`（由 `canvasConnectors` / `refreshCardConnectors` 调用）。LOD/虚拟化改造后端点一律走数据对象（`refreshCardConnectors` 注释：「counterpart card may be unmounted… its position is still authoritative」），DOM 读数版与现行架构相反 |
| 永不触发的 `open-current` 分支 | `app.js:2107` | 该值不在 42 个 `data-action` 标记值中 ⇒ 无 UI 能产生；对照 `open-dsh` 在 footer 与检查器中均有标记 |
| 死标记 `brand-mark` | `app.js` 模板 + `styles.css:38` | 规则为 `display:none` 且无任何媒体查询/主题分支改回可见；品牌区现状是 `deepseek-mark.svg`（`.brand::before`）+ 文字（`.brand strong`）+ 徽标（`.brand::after`）三件套。**`deepseek-mark.svg` 与其路由保留**（被 CSS `url()` 引用，删了品牌标记变空白） |
| 退役「对比页」样式族与孤儿类 | `styles.css` 共 22 处 | `.compare-*` / `.top-actions` / `.detail-actions` 在 `app.js`、`client.js`、`index.js` 全为零命中；`.detail-actions` 已被 `.detail-head-actions`（`app.js:1522`）取代；这批规则仍写死旧视觉（7px 圆角、15px 字阶）与本线 16px `--node-radius` 令牌体系冲突 |

`test/message-projection.test.js` 同步改写：切片锚点从被删的 `messagesFromEvents` 移到**仍被生产路径调用**的
`isInternalTurnText`（`app.js:616` 详情视图渲染前过滤运行期上下文），用例由 1 例扩为 4 条断言
（runtime context / `<system-reminder>` / 普通提问 / 非字符串输入）。测试文件数与用例总数不变（9 文件 98 例）。

**复核中推翻的两条审计结论**（记录以儆效尤）：
- `mergePanelCard()` 曾被判「被 `.merge-panel` 取代的旧实现」——实测它正是由 `render()` 模板的
  `${mergePanelCard()}` 调用、渲染合并面板对话框（配套 `submitMergePanel`），**保留**；
- `LEGACY_CARD_POSITIONS_KEY` / `dsh-canvas:card-positions:v2` 的 `removeItem` 是**迁移代码**而非死代码，
  **保留**。

**未做（留待决议）**：`loadThreadHistory()` 是空实现（`async function loadThreadHistory() {}`）却仍被 9 处
`void` / `await Promise.all` 调用；删除需改 9 个调用点、触及渲染路径，收益低，本次不动。

## 2026-09-26（晚）· 全量 `sessions/sync` 恒 400：32 KiB 全局请求体上限撞上 239 个会话

**症状（怎么发现的）**：桌面端启动排查的无头实载里，页面每次加载都带 **9 次** 400 —— 去重后
全部指向同一个 URL：`POST /canvas/api/sessions/sync`。

**根因（两个数一乘）**：该接口是**全量快照**语义（`client.js` 每次把整个会话列表
`{ id, title, cwd, parentId, blank }` 发上去），体积随会话总数线性增长；而 `readJson` 对所有
POST 路由用同一个 `MAX_BODY_BYTES = 32 * 1024`。本机 `$DSH_HOME/sessions` 已有 **239 个会话**
（≈40 KB），约 **190 个会话**就越界 ⇒ 每次同步都抛 `InputError('请求内容过大')` → 400。

**为什么藏了这么久**：client 侧 `fetch(...).catch(() => {})` 把失败**吞得干干净净** ——
画布里的 DSH 会话节点长期不更新，界面上没有任何信号，日志里也没有。

**修复（三条，各修一层）**：
1. `index.js`：新增 `MAX_SYNC_BODY_BYTES = 2 MiB`（≈1 万个会话），`readJson(req, limit)` 接受
   按路由预算；只有全量 sync 路由用大预算，其余 CRUD 仍守 32 KiB（上限是防御性的，
   不为一处全量接口抬高全部面）；
2. `index.js`：超限报错带**实际字节数与上限**（`请求内容过大（64129 > 32768 字节）`）——
   旧文案只有一句「请求内容过大」，排查时分不清是请求畸形还是预算太小；
3. `client.js`：HTTP 非 2xx 与网络层异常两条路径都**限频留痕一次**（`console.warn`），
   失败不再无声。

**验证（本机实测）**：
- 直接 POST 一个 **64,129 字节**的 body（`sessions` 全为无 id 条目 ⇒ 逐条跳过、零写入）
  → 旧版 400，新版 **HTTP 200**；小 body 对照同样 200；
- 无头 Edge 实载 ⇒ `HTTP >= 400` **归零**，启动屏正常、会话列表 / 插件入口 / SSH 胶囊全在；
- `test/canvas-runtime.test.js` 增 2 条断言（预算分层 + 失败留痕），canvas 用例 **96 → 98**，
  `node ../scripts/verify-all.mjs canvas` **12/12 PASS**。

## 2026-09-26 · 存储治理：84MB `workspaces.json` 的根因与修复

**背景（症状）**：桌面端「一直在刷新」排查中发现 `$DSH_HOME/miasaki-canvas/workspaces.json` 已涨到
**84,209,057 字节**，且任何会话事件都会触发一次**整体重写** —— 诊断期间采样显示它每 3 秒仍在写盘。

**体积构成（实测：8 工作区 / 203 线程 / 14843 条消息 / 17629 个 process 条目）**：

| 字段 | 体积 | 占比 |
|---|---|---|
| `process.result`（工具结果全文） | 43.73 MB | 54% |
| `messages.text`（消息正文，已有 8000 上限） | 15.48 MB | 19% |
| `process.arguments`（工具参数） | 14.35 MB | 18% |
| `process.error` + 骨架 + 其它 | ≈ 0.1 MB | <1% |

**根因**：`foldToolProcess` 写入的 `arguments` / `result` / `error` 是投影里**唯一没有上限**的三个字段
（消息正文有 `MAX_PROJECTION_LENGTH = 8000`，标题/笔记也各有上限），单条实测最大 59.0KB
（`job_output` 结果）/ 76.8KB（`write` 参数）；消息条数同样从未设限（单线程最大 619 条）。二者相乘即 84MB。

**修复（全部在 `index.js`）**：

- **载荷上限**：新增 `MAX_PROCESS_PAYLOAD_LENGTH = 2000` + `PROCESS_TRUNCATED_SUFFIX`，
  `capProcessPayload()` 在 `foldToolProcess` 的三个写点统一应用 —— 与消息正文同策（保头 + 可见标记）。
  **`null` 必须保持 `null`**（前端据此渲染「等待结果」，变成字符串会让等待中的调用伪装成「已完成」）；
  非字符串载荷走 `safeJson()`（循环引用不炸写入）。
- **线程保留窗口**：新增 `MAX_THREAD_MESSAGES = 50` + `retainThreadMessages()` —— **所有**会增长
  `messages` 的路径（事件投影 / 手动 `addMessage` / 合并吸收 `commitMerge`）收敛到这一个方法，
  避免窗口只在其中一条路径生效。
- **裁剪水位**：新增 `thread.trimmedBeforeSeq`。裁剪会连带丢弃 `sourceSeq` 去重标记，因此 replay 必须
  靠水位兜底 —— `projectEventInto` 对 `seq <= trimmedBeforeSeq` 直接拒绝，否则从更早 seq 重放会把已
  丢弃的卡片贴回来（[`test/store-retention.test.js`](../test/store-retention.test.js) 的 ★ 用例钉死）。
- **载入即迁移**：`normalizeState` 末尾对所有版本路径统一跑「载荷截断 + 窗口裁剪」，老文件载入时自动
  瘦身并落盘（`migrated` 置位）。**迁移只对真的被改写的数据置位** —— `trimmedBeforeSeq` 这类纯内存
  字段补全不触发写盘，否则会打破 `workspace-store.test.js` 的
  `does not rewrite an up-to-date v5 file on load` 契约（该闸门在实施中确实拦下了第一版）。

**参数怎么定的**（不是拍脑袋）：一次性模拟脚本对全部 203 线程跑了 N × L 矩阵 —— 消息数**中位数只有
34 条**，N=50 时一半以上线程完全不受影响；N=50 / L=2000 的理论体积 18.98MB，与实际剪裁结果
19.99MB 吻合。

**效果**：`84,209,057 → 19,992,624 字节`（**-76.3%**，省 61.2MB）；203 线程 / 8 工作区不变，
消息 14843 → 5648（= 模拟值），`maxMsgsPerThread = 50`，84 个线程带水位，超限载荷 0；
迁移**幂等**（再载入不重写）。剪裁由**产品代码自己**执行（`_refs/canvas-trim.mjs` 调 `WorkspaceStore.load`
的迁移路径），避免规则漂移；剪裁前原件备份在 `_refs/canvas-backup/`，同目录另归档了 9/16 的孤儿
原子写残留 `workspaces.json.42204.tmp`（8.9MB）。

**测试**：新增 `test/store-retention.test.js` 7 例（载荷截断保头+标记 / `result` 保持 `null` /
等待中调用不被伪装 / 窗口只留最新 N 条 / ★ 水位防 replay 复活 / 老 store 载入即迁移并落盘 /
已合规文件不重写）；canvas 线 **96 项全绿**，`node ..\scripts\verify-all.mjs` 全绿
（canvas 12/12，七线合计 107 项）。

**未做（有意）**：不自动删除用户的历史会话节点（203 个 thread 是用户数据）；不把 messages 拆到独立
文件（窗口 + 载荷上限已把稳态压到 ~20MB 量级，拆分收益抵不过 schema 变更风险）。稳态体积随**会话节点数**
线性增长（每节点约 100KB 上限）——若将来节点数继续膨胀，下一步该做的是节点归档，而不是继续压窗口。

## 2026-09-22 · 文档整理（删除冗余上游产物）

- **删除**：`docs/images/`（两张全仓零引用孤儿图 `native-webui.jpg` / `synapse-map.jpg`，运行时与构建链均无引用）；`docs/development.md`（上游 `dsh-synapse` 的发布指南，描述本仓不存在的三套 GitHub workflow 与 npm 发布流程，对本 fork 零适用性）。
- **死链修复**：zh-CN / en 用户手册「开发与发布」段原指向已删的 `../development.md`，改为指向本仓真实入口 `node ..\..\..\scripts\verify-all.mjs canvas`；`architecture.md` 的相关文档列表同步移除该链接。
- **事实修正**（`docs/architecture.md`）：按 `cordis.patch.yml` 与 README 口径，画布元数据目录 `$DSH_HOME/synapse/workspaces.json` → `$DSH_HOME/miasaki-canvas/workspaces.json`；Host 校验端点 `/synapse` → `/canvas`；文档顶部补上游改编说明横幅（与 zh-CN 手册同款）。
- 代码零改动，`node ..\scripts\verify-all.mjs canvas` 全绿；README「目录结构」对 `docs/` 的描述（上游用户手册 zh-CN / en）依然成立。

## 2026-09-12（二）

- **视觉与交互精细化 V1–V4 实施（版本升至 `0.5.0-miasaki.6`）**：按 [设计文档](2026-09-12-canvas-visual-refinement.md)（同日草案 v0.1，状态已更新为"已实施"）落地四阶段，全部纯表现层，**零 schema 变更、零新依赖、`CARD_WIDTH/HEIGHT/GAP_Y` 未动**：
  - **V1 令牌化与圆润化**：新增令牌组——`--canvas-border`（亮 `#d8e0e8` / 暗 `#2c3138`）、`--node-radius: 16px`、`--btn-radius: 8px`、`--float-radius: 14px`、三级阴影 `--node-shadow-rest/-hover/-drag`（拖动态由 `bindDragHandle` 挂 `.is-dragging` 类触发）、`--edge-width/-width-active/-color`、`--motion-fast/-base/-ease`。卡片圆角 7→16px、内层按钮 8px 两档结构；边框混入 `--thread-color`（静置 14% / 悬停 28%），每条会话线在画布上带自己的身份色；暗色改走"表面提亮（`#1b1c1f`→`#1b2028`）+ 边框提亮"，不靠加重阴影；字阶上调（标题 13→14px、meta/徽标 10→11px、正文 12→12.5px/1.65），卡片头内边距与正文边距放宽；**字重保持 720 未动**（§6.4 待实机确认项：先截三主题对比图再定 600/650）。
  - **V2 连线语义与端点**：连线 1.5px 裸值 → `var(--edge-width)` 2px + `stroke-linecap: round` + 降对比色（亮 `#c3cdd9` / 暗 `#3a4048`）；活动路径 2.5px；草稿虚线 `5 4`→`6 4`。**端点**用 `.thread-card::before/::after` 伪元素实现（出点右缘/入点左缘，6px 圆、常态 `.35`、hover/选中/拖动 `.8`、`pointer-events: none`）——比草案的卡内 span 更省，`conversationCard` 零 DOM 变更。**配套改动：`zoomCanvas` 下限 0.6→0.5**，否则 LOD `mini` 档（`zoom < 0.5`）永远不可达。
  - **LOD 内容分级**：`applyCanvasTransform`（单一出口）按 zoom 写 `.canvas-content[data-lod]`（full ≥0.8 / compact 0.5–0.8 / mini <0.5）；compact 隐藏 footer、正文收 6 行 clamp（滚动容器临时变 clamp 盒，全文仍走检查器）；mini 只留卡头（色点+标题+徽标）、卡高 56px、隐藏浮钮与拖动手柄。几何常量、命中检测、`visibleCardIds` 判据全部未动。
  - **V3 状态徽标与信息层次**：合并草稿卡卡头新增 `merge-state-badge` 状态带（待执行/执行中/已失效，状态点+文案，紫/品牌/红三语义色，含暗色）——此前失效与禁用信息在 plan 底部需滚动才见；与既有 `◆ 合并`（committed）、`重发合并请求`（failed）在卡头层级形成完整状态判读。四个既有徽标（工具数/合并/已被吸收/重发）统一为 999px 胶囊、11px、18px 高（类名未动，测试锚点契约保持）。
  - **V4 收口**：检查器/动作按钮/fold 的过渡时长全部收敛到动效令牌（180/150/140ms → `--motion-base/--motion-fast`）；`prefers-reduced-motion: reduce` 从仅检查器扩展为**全局瞬时化**（脉冲动画停在可见终态）；浮层圆角统一（小地图 12px、多选条/手势气泡/合并面板 14px）；`tree-row i`、`brand::after` 两处遗留 10px 提到 11px，**全文件无 10px 以下字号**。
  - **测试**：`canvas-runtime.test.js` 两条 active-connector 逐字断言按红线改为令牌形式（活动边现在带 `--edge-width-active`，"颜色走 accent 令牌"契约不变）。`node ..\scripts\verify-all.mjs canvas` 全绿（三入口语法 + 8 文件 89 项）。
  - **未实施（待决议/待实机）**：①字重 720→600（先截三主题对比图，偏细回落 650）；②§6.6 操作按钮方案乙"卡外只留追问、其余进 footer"（未排进四阶段，需单独决议）。
  - **实机复验点**：三主题 × 明暗 × 0.5/0.8/1.0 缩放的圆角/阴影/边框/线宽/端点/LOD 走查（设计文档 §10 的 18 张截图清单）；拖拽时第三级阴影浮现；合并草稿卡卡头状态带；0.5 缩放下 mini 卡头形态与框选/合并手势仍可用。
  - 触摸点：`styles.css`、`app.js`（`canvasLod` / `applyCanvasTransform` / `zoomCanvas` 下限 / `bindDragHandle` / `mergeDraftCard`）、`test/canvas-runtime.test.js`、`package.json` 版本、本文件、README、设计文档。**画布 iframe 是独立文档：刷新页面即生效，无需重启 `dsh web`**（styles/app 由 `/canvas` 路由直出）。

## 2026-09-12

- **视觉与交互精细化设计（设计草案，未实施）**：用户提出「界面感觉可以优化一下，节点要美观高级圆润」，并给出两个外部仓库供参考。产出 [设计文档](2026-09-12-canvas-visual-refinement.md) 与 [概念稿](preview/2026-09-12-node-visual-concept.html)：
  - **两个参考仓库的核查结论（静态源码审查，未克隆/未运行）**：
    - [`chen-985211/cleancode`](https://github.com/chen-985211/cleancode)（`main` @ `d318af9`，MIT）是 Electron + React Flow 的本地开发工作台，**其连线语义是"终端启动依赖"**，不传递 stdout/结构化产物 —— 与会话 fork/merge 谱系不同构。**只借鉴表现层**：节点圆角 20px / 按钮 8px 的两档结构、语义化表面 token（亮 `#e8eaeb`+白 / 暗 `#17191b`+`#1b2028`）、阴影分层（拖动提升）、连接点常态 `.4` 悬停增强、边 2px 圆帽低对比 + 活动态加粗、反馈统一 150ms。
    - [`fandc520/dsh-comfyui`](https://github.com/fandc520/dsh-comfyui)（`master` @ `b0a4e31`，MIT）是 DSH 驱动 ComfyUI 的**服务/工具集成插件**，非节点编辑器。**只借鉴任务状态呈现**：五态模型（`pending/in_progress/completed/failed/cancelled`）+ 活跃队列/历史分区 + 按状态显示的操作入口 + 运行记录与产物引用分离。
    - **共同判断**："高级感"来自一致性（统一圆角档、语义 token、分层阴影、克制连接点、统一节奏），全部可在原生 CSS 内实现，**不需要任何新依赖**。
  - **现状盘点（带行号证据）**：卡片圆角 7px、边框与线色无关、阴影仅"有/无"两态、meta 10px、连线 1.5px 无落点、4 个浮钮 `right:-12px`、无内容分级（LOD）。根因是上游默认观感，与功能完备度无关。
  - **提案要点**：圆角 7→16px（内层按钮 8px 两档结构）；阴影三级（静置/悬停/拖动）+ 暗色改走"表面提亮"而非阴影；边框混入 `--thread-color` 14% 让每条线带身份；字阶上调（标题 14px、meta 11px、正文 12.5px/1.65）；连线 2px 圆帽 + 活动 2.5px + 卡片左右缘 6px 端点（"节点感"的关键项）；操作按钮三方案对比后推荐"卡外只留追问、其余进 footer"；LOD 三档（full/compact/mini）**只改 CSS 表现，不改 `CARD_HEIGHT` 常量**。
  - **四阶段计划**：V1 令牌化与圆润化（纯 CSS）→ V2 连线语义与端点 → V3 状态徽标与信息层次 → V4 收口与动效统一。V5（任务/产物呈现适配）列为可选、需单独决议。
  - **红线**：DSH 唯一事实源不变、零新依赖、`CARD_WIDTH/CARD_HEIGHT/CARD_GAP_Y` 不变、`--canvas-accent` 派生链与三主题兼容不破、语义色不挪用；既有测试锚点（connectors 颜色断言 / 胶囊高度契约 / 跨线红线）**不得为视觉改动放宽，只能改断令牌形式**。
  - **待实机确认项**：字重 720 → 600 的前提是字体支持可变字重；非可变字体下浏览器取最近档 700，改 600 会变细 —— 先截三主题对比图再定，偏细则回落 650。此项不阻塞 V1 其余改动。
  - 触摸点：`design/2026-09-12-canvas-visual-refinement.md`（新）、`design/preview/2026-09-12-node-visual-concept.html`（新）、本文件、`README.md`。**本线代码零改动，89 项测试未运行（无代码变更）。**

## 2026-09-10

- **外部视图槽：让别的插件把入口长在画布页面自己的「对话 / 会话布」旁边（同日新增）**：
  - **起因**：SSH 线希望它的入口出现在**画布页面内部**那组切换按钮旁边。那组按钮属于画布自己的 iframe 文档（`/canvas/` 的 `topbar > .view-switch`），宿主 DOM 碰不到 —— 对方曾在浮层之上补整条工具条，被用户否掉（「只是让加一个 SSH 按钮，为什么会多出一整个上栏」）。
  - **做法**（通用，不含任何具体视图知识）：① 插件把 `{ id, label }` 写进**页面级注册表** `window.__DSH_CANVAS_VIEW_ITEMS__` 并派发 `dsh-canvas:view-items`；② 本线 client 半把它转成 `canvas:views` 下发给画布页面（**iframe `load` / 浮层打开 / 注册表变化**三处都发，覆盖"插件晚于画布加载"）；③ 画布页面在 `.view-switch` 里多渲染一个按钮，点击广播 `canvas:view`；④ **注册方自己**监听那条广播去切视图 —— 本包不解释 id 的语义、也不回调任何人，所以两线之间没有代码耦合，只有一份页面级约定。
  - **纪律**：只校验形状（`id` / `label` 都是字符串），不校验具体 id；收到 `canvas:views` 时守 `canReplaceView()` 再重渲染，不打断正在输入的用户；`app.js` / `client.js` 里**不得出现任何具体视图名**（连 "SSH" 字样都被测试锁死）。
  - **测试**：新增 `test/external-views.test.js`（3 例）—— 下发时机与解绑、画布页面的渲染与广播接线、跨线红线（无具体视图名 / 不引用别的线）。
  - 触摸点：`client.js`、`app.js`、`test/external-views.test.js`（新）、本文件、README。
  - **实机复验点**：装了 SSH 插件时，画布页面「对话 / 会话布」旁多一个「SSH」按钮，点它关闭浮层并切到 SSH 视图；卸载 SSH 后该按钮消失（注册表变化即下发）。

- **会话头部窄宽度自适应（展开右栏不再压叠）**：用户报告「展开右侧边栏会挤压」，截图显示「对话 / 会话布」切换器被右侧图标按钮压住、会话标题消失。归因、宽度预算与方案对比见 [设计](2026-09-10-conversation-header-crowding-fix.md)：
  - **根因**（读官方 `dsh-client-ui-conversation` 的真实 CSS 得出）：会话头一行里 `headerUtilities` / `headerCorner` 是 `flex:none`（不收缩），`titleCluster` 是 `flex:1; min-width:0`（可被一路压到 0），而它内部的 `headerActions` 又是 `flex:none` —— 中栏被右栏推窄到放不下时，actions 无处安放、**溢出**并与同样从 x≈0 起画的 utilities 重叠（DOM 靠后者在上层）。标题被 `crumbs` 的 `overflow:hidden` 裁没、`…` 仍稳在最右，都是同一机制的自证。画布切换器（≈116px）是 actions 里最宽的一项，让坏点显著提前；固定项合计 ≈411px，即中栏窄于 ≈410px 必然重叠。
  - **现场佐证**：用户把窗口拉宽后重叠消失、标题回归 —— 与「宽度不足」的归因一致。
  - **修复（本线）**：`ViewSwitch` 增加运行时自适应。`ResizeObserver` 观察 **`node.closest('header')`**（**不能观察自身**：自身是 `flex:none`，被挤压时宽度不变，观察自身检测不到溢出），判据是「自身左边界到 header 内容区左边的距离 = 留给标题的余量」，余量不足时降级为**图标形态**（≈116px → ≈64px）；图标形态下按钮无可见文字，`aria-label` / `title` 是唯一可访问名，必须保留。
  - **滞回**：进入 120px / 退出 200px。两种形态宽度差 ≈52px，滞回带必须大于它，否则形态切换自身改变的占宽会把判定推回去、来回抖动 —— 这条不变量已写成单测断言（`assert.ok(RELEASE - ENTER > 52)`）。
  - **测试**：新增 `test/header-adaptive.test.js`（4 项）。按本线既有手法从源码锚点截取 `compactDecision` 与两个阈值后 `new Function` 求值，覆盖判定边界、滞回、观察对象与卸载清理、紧凑形态接线与 CSS；另有一条反向断言 `doesNotMatch(/observer\.observe\(node\)/)` 防止改回观察自身。锚点改名或挪位会**响亮失败**。
  - **平台层兜底（desktop 线，同日）**：新增本体补丁 [`dsh-client-ui-conversation`](../dsh-miasaki-desktop/patches/dsh-client-ui-conversation/README.md) —— 把 `headerActions` 从 `flex:none` 改为 `flex:0 1 auto; min-width:0; overflow-x:auto`（+ 滚动条隐藏），溢出从「压叠」退化为「可横向滚动」。**canvas 侧保住可用性，补丁保证任何插件 / 任何窄窗口都不会再出现不可用状态**；两者独立，任一单独生效都有明显改善。
  - **验证**：`node --check client.js` 通过；canvas 单测 4 项全绿；`verify-all.mjs canvas` 与 `desktop`（含新补丁 verify）全绿。**实机复验点**：右栏展开时切换器收成图标、标题至少可见；拉宽后自动恢复完整形态。
  - 触摸点：`client.js`（本线为 link 安装，client bundle 在 host 启动时载入内存 —— **重启 `dsh web` 生效**）、`test/header-adaptive.test.js`（新）、本文件、README。

- **切换器把会话头撑高、连带整行下移 4px（同日修复）**：用户报告「展开右侧边栏是对齐的，收起时不在同一水平线」。对用户两张截图逐控件做像素切分（连通列分组 + y 范围）量出垂直中心：展开态**全部**控件 19.5~20.0（齐）；收起态会话头控件 21.5~22.0 而桌面窗控 17.5~18.0 —— **差 4px**。
  - **根因**：`.dsh-canvas-switch` = `padding:3px×2 + border:1px×2 + 按钮 28px` = **36px**，而官方 `titleRow` 的 `min-height` 只有 30px —— 被撑到 36px 后，行内**所有**控件（含官方 open-in-app、日志菜单、右栏展开按钮）居中后整体下移 (36−28)/2 = 4px；桌面窗控是 `position:fixed`，不跟着动，于是分成两组。
  - **修复**：`padding:3px` → `padding:0 3px`（并补 `align-items:center`），总高 36 → **30px**，正好等于 titleRow 的 min-height，不再撑高。视觉上只是去掉胶囊上下各 3px 的内边距，内部 28px 按钮不变。
  - **防回归**：`test/header-adaptive.test.js` 增一条契约断言 —— 胶囊上下 padding 必须为 0（`assert.doesNotMatch(/padding:3px/)`）。「控件总高 ≤ 30px」是与会话头行高绑定的**隐式契约**，靠注释守不住：它一旦被破坏，受害的是**同一行里别人的控件**（官方那三个也会一起偏）。
  - **余下 1px**（官方 titleRow 中心 25px vs 窗控/dockkit chrome 的 24px）是官方两处的固有差，由 desktop 线在常驻 CSS 里补 `top:-1px`，本线不介入。
  - **教训**：插件往官方行内塞控件时，**高度**和宽度一样会破坏宿主布局 —— 宽度不够是压叠（同日另一条），高度超标是把整行撑高、把别人的控件一起顶偏。

- **余下 1px 基线差：改由页面级注入补齐（同日再修）**：上一处修复后实测会话头控件仍比右栏 chrome / 桌面窗控低 **1px**（新截图逐控件切分：左 `[📁⌄]` cy=**23.5**、`⋯` cy=**24.0**；右 `⊙` 22.5、`[ ]`/`□|` 23.0、窗控三键 23.0）。
  - **性质**：这是**官方两处的固有差** —— 会话头 `titleRow`（`padding-top:10px + min-height:30px`，28px 控件居中）中心 **25px**；右栏 dockkit chrome（`10px + 28px`）与桌面壳窗控（`top:11px + 26px`）都是 **24px**。**它在纯浏览器里同样成立**（这张图的右侧并没有窗控做参照，一样差 1px），不是桌面壳专属。
  - **落点选择**：desktop 线 `themes/src/03-switcher.js` 已有同源规则，但那条走**桌面壳主题注入**，而 `src-tauri/src/main.rs` 用 `include_str!("../injected/theme-init.js")` **编译期内嵌** —— 改了必须**重建壳**才生效（实测证据：壳 21:01 启动、注入产物 21:41 重建，规则没进去）。本线改为**页面级注入**：支持 client-hmr 热更，**刷新页面即生效**。
  - **实现**：注入样式追加 `#root [class*="_headerActions"],#root [class*="_headerUtilities"],#root [class*="_headerCorner"]{position:relative;top:-1px}` —— `#root` 提权压过官方 CSS Module（对方注入更晚，同特异性会反超），`[class*="_xxx"]` 子串锚点对 hash 漂移稳健。只位移不改布局，不参与 flex 计算。
  - **同源契约**：两处**值必须一致**，测试双向锁住（断言本线注入含该规则 + desktop 那条未被移除），两处注释互指。
  - 另注：本线的 client 改动**不需要重启 `dsh web`** —— `dsh-client-modules` 的 client-hmr 每 500ms stat 一次 bundle，命中变化即经 SSE 推 rebuilt 帧。本次 4px 修复就是这样生效的（host 进程 21:01 启动、本线源码 21:40 才改，而实测已是修好后的 1px）。
  - 触摸点：`client.js`、`test/header-adaptive.test.js`。

- **展开右栏时让位安全区白空 144px（同日再修）**：用户指出「左边的外部按钮和三点扩展按钮位置离展开的右侧边栏太远」。像素实测：`⋯` 右边界 x=**89**、分栏线 x=**233** ⇒ **空 144px**，正是桌面壳让位规则 `padding-right:128px` 加官方 `padding-right:28px` 的残留。
  - **根因**：desktop 线的让位规则（给桌面壳窗控留安全区）是**无条件**生效的。但官方右栏 panel 用 `transform:translate(100%)` 移出屏幕、**并未卸载**，所以 `data-sidebar-right-open`（与 `data-sidebar-right-panel="push"` 同元素、条件挂载）才是可靠的开合判据；**推挤展开时**中栏右边界已退到分栏线内、窗控压的是**右栏**头部，会话头再留 128px 就是白空。
  - **修复（第一次尝试失效，第二次才对）**：
    - ❌ **门控方案（失效）**：给让位规则加 `:not(:has([data-sidebar-right-panel="push"][data-sidebar-right-open]))` 门控，指望"展开态不覆盖 → 官方 28px 自然生效"。**实测无效** —— 用户回报「还是这样」，像素复测空隙仍是 **144px**（`⋯` 右边界 105、分栏线 249）。原因：desktop 的注入脚本是 `include_str!` **编译期内嵌**进壳二进制的，**已发布的那份无条件 128px 规则仍在页面上生效**；门控版在展开态"不匹配"，等于**没人去覆盖它**。
    - ✅ **覆写方案（有效）**：主动写一条特异性更高的规则撤回让位 —— `#root:has([data-sidebar-right-panel="push"][data-sidebar-right-open]) header:has([data-conversation-header-corner]){padding-right:28px}`，`#root:has([a][b]) header:has([c])` = (1,3,1) > 原规则 (1,1,1)。28px 即官方 header 的 padding-right（官方若改需同步），两条通道**逐字一致**，测试用同一条正则同时断言两处。
  - **教训**：**撤销一条已经"发布"出去的 CSS 规则，不能靠改原规则** —— 宿主的注入产物可能是编译期内嵌的，运行中那份不会跟着源文件变。要么覆写（特异性取胜），要么请用户重建宿主。同一个坑已记入 desktop 线 CHANGELOG。
  - **已知限制**：浮窗模式（`data-sidebar-right-float-host`）下 panel 仍带 `push`+`open`，会被判为"已展开"而撤销让位 —— 浮窗不占布局、中栏满宽，严格说仍应让位。浮窗是低频用法，留待需要时用 float-host 判据补。
  - **顺带确认上一轮已生效**：本次截图实测左侧 `[📁⌄]` cy=21.5、`⋯` cy=22.0，右侧 `⊙` 21.5、`[ ]`/`□|` 22.0、窗控三键 22.0 —— **全部落在 21.5~22.0**，1px 基线补偿已通过 client-hmr 生效。
  - 触摸点：`client.js`、`test/header-adaptive.test.js`；desktop 线 `themes/src/03-switcher.js`（同源门控，重建壳后一致）。

  > 历史脉络：2026-09-06 那次「叠压」是 **DOM 注入位置**不可控（注入 `.headerActions` 被重渲染挤掉），改走官方插槽注册后关闭；这一次是**官方插槽内部**在窄宽度下的溢出压叠 —— 层次更深，插件侧只能在自己控件的宽度上让路，根因修复需要本体补丁。

## 2026-09-07

- **合并草稿失效标记（mergeStale，版本升至 `0.5.0-miasaki.5`，异常恢复）**：此前 `removeThread` 只清理 `absorbedBy` 反向引用，无人清理 `mergeFrom.sources` 正向引用——源线被删/会话在 DSH 侧消失后，草稿仍留在画布上、看起来可执行，直到点「执行合并」才在 `prepareMergeMessage` 里失败（晚失败，且用户已承诺手势）。修复四层：
  - `sweepMergeDrafts(workspace)` 共享清扫：`draft` 的来源线若节点消失或 `dshSessionId === null`，把缺失 id 记入新字段 `mergeStale`；
  - 挂点：`removeThread`、`syncSessions`（DSH 侧删会话）、加载迁移后重算（host 停机期间失效的草稿，首渲即正确，不靠下次删除补）；
  - 执行边界：`prepareMergeMessage` 前置 re-sweep + 拒绝（`来源线已被删除，无法执行`），多客户端并发改动也不漏；
  - UI：草稿卡 `mergeStale` 非空时禁用「执行合并」+ 红色说明条（`.merge-plan-stale`，亮/暗主题双色）。
  - 测试：`test/merge-store.test.js` 增 4 项（删除源线即失效、DSH 侧删会话同步失效、加载时重算不信任文件、失去 DSH 会话即失效）→ 合计 14 项全绿。触摸点：`index.js`、`app.js`、`styles.css`、`test/merge-store.test.js`、本文件。

- 以下为既有条目——**跟进桌面端标题栏 v4 改名（版本升至 `0.5.0-miasaki.4`）**：桌面端 2026-09-06 标题栏 v4 去胶囊化把窗控容器类名 `.tb-capsule` 改为 `.tb-group`，而本线 `syncChrome()` 只查 `.tb-capsule`——v4 下量不到窗控组，`--canvas-chrome-reserve` 恒为 0，画布工具条与桌面端窗控组右上角叠压回归（v0.5.0-miasaki.2 修过的问题）。修复：选择器改为 `.tb-group` 优先 + `.tb-capsule` 兜底（与 sidebar 线同款兼容做法）。触摸点：`client.js`（host 侧代码，重启 `dsh web` 生效）、`package.json` 版本、`README.md`（桌面端适配段）。

## 2026-09-06（五）

- **画布品牌色不随桌面端主题切换（用户报告，版本升至 `0.5.0-miasaki.3`）**：桌面端主题切换器是**热切换**——`html[data-miasaki-theme]` 属性 + 热替换主题 style 层（`runtime.js` setAttr/syncDark，无 reload）；而画布 `themeObserver` 只监听 `body[data-ds-dark-theme]`，且 sessions/workspaces 订阅只在列表变化时触发——切品牌主题（pure↔zafkiel↔kurkuriel）时既不触发 observer 也无 tick，画布停在旧品牌色。修复：同一 MutationObserver 实例加挂 `documentElement[data-miasaki-theme]` 观察（亮度三档切换走 body 属性本就触发）；防御性收窄——令牌瞬时读空（主题 style 层被页面重渲染清掉后的 ~1s 自愈窗口期）时只发明暗不下发，保留画布现有品牌色，避免被打回兜底蓝且无人再触发重发。验证：浏览器注入测试 CSS 模拟桌面切换（`html[data-miasaki-theme="zafkiel"]` 令牌覆盖 + 热设属性），画布 `--canvas-accent` 实时 `#5686fe → #c23a2e →` 移除属性回落 `#5686fe`；`pnpm run build` + `pnpm test` 75/75。触摸点：`client.js`（host 侧代码，重启 `dsh web` 生效）。

## 2026-09-06（四）

- **桌面端画布页三问题修复**（版本升至 `0.5.0-miasaki.2`；用户截图 + 视觉模型复核定位，修复全部落在画布线，不动桌面端）：
  - **右上角叠压遮挡**：桌面端标题栏 v3 的窗控胶囊 `#miasaki-titlebar .tb-capsule`（`fixed; top:5px; right:8px`，零占位浮层）盖住画布工具条（`.canvas-controls`，同为 fixed 右上）的缩放按钮。修复：`client.js` 新增 `syncChrome()`——量出胶囊左缘到视口右缘距离 + 6px 余量，经 `canvas:chrome` 下发；`app.js` 写入 iframe 根变量 `--canvas-chrome-reserve`，`.canvas-controls` 与 `.status-message` 的 `right` 改为 `calc(16px + var(--canvas-chrome-reserve))` 整体让位。胶囊宽度与 right 偏移固定、不随窗口尺寸变化，故不监听 resize；普通浏览器无胶囊恒传 0，行为不变。
  - **主题没对应**：画布 iframe 是独立文档不继承 DSH 令牌，此前 `client.js` 只同步明暗布尔，iframe 内 `#3478f6/#5b8def/#7ea6f5/#2563eb` 等强调色全部硬编码蓝系——绯红主题下画布仍是蓝。修复：`syncTheme()` 扩展读父文档 `--dsw-static-deepseek-450`（pure=`#3964fe` 原生 / kurkuriel=`#9e1b1b` / zafkiel=`#c23a2e`，pure 不覆盖令牌时读 DSH 原生值；格式校验防脏值）随 `canvas:theme` 下发；`app.js` 写入 iframe 根 `--canvas-accent`，styles.css 派生变量组——`--canvas-accent-hover`（color-mix 加深，替 #2563eb）、`--canvas-accent-ink`（暗色下 color-mix 提亮做文字/线条色，替 #5b8def/#7ea6f5——深红原值在暗底上不可读）、`--canvas-accent-soft`（品牌淡底，替 #eef4ff/#eaf0fa/#eaf1ff/#1e2a44 系）；约 60 处硬编码替换为变量/color-mix：tabs 激活、连接线（含草稿虚线）、选中卡阴影、框选、小地图选中/视口框、focus 轮廓、主按钮（亮 #111827/暗 #3478f6 双套）、「对话/会话布」激活胶囊（暗色由白底黑字改品牌底白字）。**语义色不动**：live 绿、merge 紫、错误红、警示橙、中性灰阶；`brand::after` 徽章保留黑底。
  - **滚动条突兀**：此前仅 `.thread-answer` 有自定义滚动条（灰色硬编码常显），侧边栏/详情/检查器/对比页等裸奔系统条。统一规则覆盖全部 15 个滚动容器（`.thread-answer`、`.thread-tree`、`.card-inspector-scroll`、`.detail-scroll`、`.compare-view`、`.merge-plan`、`.process-args/result/error` 及三处代码块/表格横向滚动）：6px、透明轨道、胶囊圆角、thumb 色走 `--canvas-scroll-thumb`（亮中性灰半透/暗半透白，随主题）、thumb hover 变品牌色；**默认隐藏，容器 hover/focus-within 时显现**（卡片上不再常驻灰条）；Firefox 以 `scrollbar-width:thin + scrollbar-color` 常显兜底。
  - **顺手**：暗色下 `.dsh-canvas-overlay` 遮罩层同步深色（`body[data-ds-dark-theme]` 选择器，消除亮色壳套暗色画布的一圈亮边）。
  - 测试同步：`canvas-runtime.test.js` 两条 connectors 颜色断言改断变量形式。`pnpm run build`（node --check 三文件）+ `pnpm test` 75/75 通过。
- 触摸点：`styles.css` / `client.js` / `app.js` / `test/canvas-runtime.test.js`（link 开发模式，重启 `dsh web` + 刷新页面生效）。

## 2026-09-06（三）

- **切换按钮改为官方插槽注册（叠压问题彻底关闭）**：上一版 DOM 注入 `.headerActions`
  仍被用户报告「变成一个了但还是遮盖重叠」——注入位置/重渲染时序不可控。改为
  `ctx.slots.inject("conversation.session.header.actions", …register, ViewSwitch)`
  （React 组件，`order:25`，紧随「后台任务」(order 20) 之后）——与 DSH 头部动作同一
  flex 行由 DSH 自己渲染，**结构上不可能叠压**，随头部重渲染自动重挂（删除 1.5s
  看门狗/浮空回退）；幂等守卫 `window.__DSH_CANVAS_BOOTED__` 保留（防 HMR 重复
  apply 出现双按钮，回收时复位）；视图状态经 `switchViewStore`（React state ↔
  open/close 单向同步）。`inject` 增加 `slots`；无需 react/jsx（用 createElement）。
- 触摸点：`client.js`（link 开发模式，刷新页面即生效）。

## 2026-09-06（二）

- **切换按钮：头部行内化 + 主题令牌化（修复「不适配/遮住/叠压」）**：桌面端标题栏
  v3 后用户报告三件事——①「对话/会话布」切换按钮在暗色主题下仍是白色药丸（不适配）；
  ②切换按钮仍与「后台任务」胶囊叠压；③历史问题：按钮 `position:fixed; top:12px;
  left:50%` 悬浮顶部，曾被桌面端旧顶带整体盖住（即「被遮住的切换按钮」本体）。
  - **主题令牌化**（`client.js` 样式）：硬编码 `#fff/#d1d5db/#6b7280/#111827` 全部
    改为 DSH 令牌 + 回退——`--dsw-alias-bg-overlay`（胶囊底色）、`--dsw-alias-border-l2`、
    `--dsw-alias-label-secondary/primary`、`--dsw-alias-interactive-bg-hover`、激活胶囊
    `--dsw-static-deepseek-450`（主题品牌色：原版蓝 / 刻刻帝绯红 / 狂狂帝血绯）+
    `--dsw-static-neutral-bluish-00`；
  - **行内化**：切换按钮优先注入 DSH 会话头 `.headerActions`（`#root header
    [role="tablist"]` 所在 header 内，`[class*="headerActions" i]`），与「后台任务」
    等头部动作并排（flex + gap），**结构上不可能叠压**；会话头不可用（欢迎页/设置页）
    回退旧右上悬浮（`--float` 修饰类）；1.5s 看门狗在 DSH 重渲染摘掉按钮后自动重挂；
    插件卸载清理看门狗与 DOM。
- 触摸点：`dsh-miasaki-canvas/client.js`（link 开发模式，profile 直接生效）。
- 验证：`node --check` 通过；目检——三主题下胶囊随主题色、与后台任务胶囊并排无遮挡。

## 2026-09-06（一）

- **切换按钮与 DSH 顶部会话 header 重叠修复（用户报告）**：DSH 原生对话顶部的「对话/会话布」切换按钮原本 `position:fixed; left:50%` 悬浮在视口正上角，在窄窗口（约 400px 宽）下与同一水平带的会话 header 内容（预设名「创造模式」、子代理计数下拉「3」等）贴边乃至叠住，视觉上挤成一团。修复：锚点改为 `left: calc(50% + 30px)`（仍用 `translateX(-50%)` 保持真居中），整体右移 30px，给左侧 header 内容让出间距；宽窗下 30px 偏移相对不可感知，仍然居中布置。改动仅 `client.js` 一处 CSS。

## 2026-09-05（八）

- **侧边栏滚动跳顶修复（用户报告排查）**：前端是整页 `app.innerHTML` 全量重建式渲染，详情/卡片回答的滚动位置均有保存恢复，唯独侧边栏 `.thread-tree` 没有；而重建触发源很多（每秒投影轮询、DSH 侧 `canvas:current-session` 推送、流式回复结束等），滚动到侧边栏中部后 1 秒内任一触发到来即被拽回顶部。修复：`render()` 开头保存 `.thread-tree` scrollTop、重建后同步恢复（与卡片回答同模式）。另削减一个无谓重建源：`canvas:current-session` 在会话未切换且 title/cwd 未变时跳过 render（DSH 侧每次 sessions-list 订阅 tick 都会重发该消息）。
- **侧边栏「会话」栏逻辑重构**：原先平铺列表仅靠「分支」小角标区分，树点颜色硬编码灰色再被 CSS `!important` 统一覆盖，无活动状态、无排序逻辑。现改为：
  - **树状缩进**：按 `parentId` 构树，分支嵌套在父线之下（与画布血缘一致），根线按最近活动（`updatedAt`）降序；父线已归档的孤儿分支提升为根但仍标「分支」；
  - **会话线颜色**：树点与画布卡片统一改用 thread 自身的 `color` 字段（TOPIC_COLORS），删除硬编码与 `!important` 覆盖，侧边栏与画布同线同色；
  - **状态标识**：流式回复中的线显示绿色脉冲树点 +「回复中」角标（`state.liveReplies`）；合并节点显示紫色 ◆；被吸收线整行弱化；
  - 行内边距/圆角补齐，暗色主题适配（live 绿 / merge 紫的暗色变体 + 独立脉冲 keyframe 用 CSS 变量传光晕色）。
- **测试**：75/75 通过，`node --check` 三文件通过。

## 2026-09-05（七）

- **小地图（缩略图）**：画布右下角显示全部节点缩影（普通/合并/选中/当前线四色区分）+ 当前视口框；点击或拖拽任意位置相机即跳转定位；顶栏新增「缩略图」开关（active 高亮，状态持久化 `localStorage`，默认开）。视口框随平移/缩放实时跟随（挂在 `applyCanvasTransform` 单一出口上）。实机验收：72 节点渲染、点击远端跳转、开关切换均通过。

## 2026-09-05（六）——MVP 收官

- **M4 打磨完成**，版本升至 `0.5.0-miasaki.1`（合并能力完整的第一个里程碑版本）：
  - **`summary` 注入形式**（§5.3）：合并面板新增注入形式选择（全文引用/摘要提炼）。summary 对引用结论做有损头段截断（1200 字符）并在模板中标注「摘要形式」，实现取舍与设计的「多一轮 token」表述不同：未做两段式对话提炼（插件不调模型红线下需 fork 会话内连发两轮，收益存疑），选择纯文本压缩——同样满足「省上下文、有信息损失」的形式语义；草稿卡与执行流全链路支持，`PATCH merge` 可在草稿期切换形式，带回归测试；
  - **发送失败重试**（§5.2 状态机 failed→重试）：commit 成功但首条消息发送失败时，合并卡 meta 区出现「重发合并请求」徽标（从 pendingReplies 取回原文重发，成功即清除）；fork/prepare/commit 阶段失败草稿保持 draft 天然可重试；
  - **文档同步**：docs/zh-CN 顶部加改编说明（上游原文与本插件差异对照），README 补「合并怎么用」；
  - 全量测试 75/75 通过。

## 2026-09-05（五）

- **产品名变更（用户定）**：入口与视图名「会话地图」改为「**会话布**」。覆盖：DSH 原生对话顶部的切换按钮、iframe title、画布内「布/详情」视图 tab 及其 aria-label。侧栏英文品牌 `Canvas` 保留不变。

## 2026-09-05（四）

- **M3 画布交互完成** + 两个地基件：
  - **多选/框选**：Ctrl/⌘ 点选多卡（再点取消；普通点选或平移自动清除）、Ctrl+空白拖拽画 marquee 矩形框选（世界坐标命中）；选中 ≥2 条可合并线时底部浮出动作条「合并这两条线」→ 打开预填的合并面板；
  - **拖拽并置合并手势**（§6.2）：卡片拖放与他线卡片重叠（最近者）→ 弹「合并这两条线？」确认气泡 → 确认后打开预填面板（source=被拖线尾锚点、target=被叠线）；Escape 取消；
  - **吸收态标记**（§5.5）：被合并吸收的源线线尾卡显示弱化「已被吸收 ◇」徽标（不消失、可追问可再分支），点击跳转到吸收它的菱形合并卡并定位相机；
  - **详情血缘视图**（§5.5 D 方案）：合并线详情页显示「合并来源」直达按钮 + 「传递血缘」按需展开（沿 parentId 与 mergeFrom.sources 递归祖先，防环）；被吸收线详情页显示反向跳转；
  - **system-reminder 过滤**：0.1.2 会话流里的 `<system-reminder>` 提示轮不再投影为伪问题卡（Host 投影、前端渲染、存量迁移三处同判定），带回归测试；
  - **0.1.2 存量回填（受限落地）**：勘察确认 `sessions.get(id)` 只是内存查找、无法从磁盘恢复——Host 插件没有批量读存量会话的通道。保留 30s 低频 tick：会话一旦变 live（用户原生打开、其他插件恢复）即自动补投影；纯内存历史回填列为等 DSH 上游开放 persistence 读接口的待办。
- **测试**：74/74 通过。实机验收（浏览器真交互）：Ctrl 多选→动作条→预填面板 ✓、cua 真实拖拽→气泡→预填 ✓、吸收徽标渲染与跳转 ✓、合并详情页血缘 ✓、reminder 卡清零 ✓。

## 2026-09-05（三）

- **M2 合并内核完成**（含 DSH 0.1.2 适配）：
  - **store v5**：thread 新增 `mergeFrom`（sources/forkSource/anchorSeqA/anchorSeqB/injectedForm/userIntent）、`mergeState`（draft/committed）、`absorbedBy` 反向索引；v4→v5 load 迁移补字段；
  - **merge RPC**：`POST /canvas/api/workspaces/:id/merge`（建草稿）、`PATCH /canvas/api/threads/:id/merge`（编辑草稿）、`POST …/merge/prepare`（构造注入文本，锚点交换 + 8000 截断 + fork 切点解析）、`POST …/merge/commit`（绑定 fork 会话 + parentId=forkSource + 双 source 写 absorbedBy + **fork 竞速幂等**：投影先到开的孤儿节点并入后移除）；
  - **合并 UI**：线尾卡菱形入口按钮 → 合并面板（目标线/指令）→ 画布草稿卡（计划预览 + 执行/取消）→ 执行流（prepare → fork → commit → send-message）→ 菱形合并卡（紫色边框 + ◆ 徽标 + B 线实线入边，fork 链入边沿用 parentId）；
  - **测试**：新增 test/merge-store.test.js 9 项（迁移/校验/文本构造/fork 切点切换/截断/commit/竞速合并/编辑/absorbedBy 清理），全量 73/73 通过；
  - **实机验收**（DSH 0.1.2-rc.1）：两条真实会话线合并产出真实 DSH 会话（fork 会话 seed=12025 投影回画布 10 条消息），菱形卡与双入边渲染正确，数据层 absorbedBy/parentId/seedLength 全部就位。
- **DSH 0.1.2-rc.1 升级适配**（环境被另一会话升到 0.1.2，被迫提前做了 SPIKE 文档预言的适配）：
  - `projectSession`：`session.events` 数组已移除 → 改用 `session.snapshotEvents(fromSeq)`（0.1.1 的 events 路径保留兼容）；
  - `sourceSeedLength`：Host 侧 header 只有 `isSeeded` 布尔 → fallback 读 `session.inheritedEventCount`（wire 层才保留 seedLength 整数）；
  - 启动 replay `ctx.sessions.list()` 在 0.1.2 返回空（懒恢复）——无害：存量在磁盘、增量走 session/created + session/event 事件（实测均正常到达）；
  - **已知限制（待办）**：0.1.2 下历史会话的存量投影不再回填（启动 replay 空），旧会话多为骨架卡（无消息内容），仅进程存活期内活跃的会话有完整投影；待后续找 0.1.2 的存量回填通道（如 syncSessions 时按需 snapshotEvents 回放）。
- **环境变更记录**（非本线代码，点名备查）：本机 DSH 升至 0.1.2-rc.1（另一会话的升级脚本执行）；web profile 三个社区插件升级（web-permission 0.6.1 / tool-browser 0.7.0 / browser-playwright 0.8.1）；`@yeesy369/dsh-web-permission` 因与 0.1.2 不兼容（`settingsNamespace` 导出移除）已从 profile 临时移除，待其发兼容版后装回。

## 2026-09-05（二）

- **M1 基线完成**：
  - fork 上游 dsh-synapse v0.4.1（commit 56935dc）进本目录，MIT `LICENSE` 保留，上游 `docs/`、`test/` 随包搬入；
  - 改名换标识：包名 `@miasaki/dsh-canvas`（`0.4.1-miasaki.1`）、服务名/patch id `canvas`、路由 `/canvas`、postMessage `canvas:*`、数据目录 `$DSH_HOME/miasaki-canvas/`、localStorage 前缀 `dsh-canvas:`（完整清单见 SPIKE 文档）；
  - link 安装实跑通过：`dsh plugin --profile web add link:…` → `dsh web` → 画布原功能全部正常，上游测试套件 64/64 通过；
  - **SPIKE 结论**（[2026-09-05-m1-spike-findings.md](2026-09-05-m1-spike-findings.md)）：
    - fork API = 客户端 `ctx.sessions.fork({ sessionId, atSeq, increaseTitle })`，`atSeq` 必须整数，Host 侧血缘形态 `header.parentSession` + `header.seedLength`；
    - 注入首条消息 = `session.prompt([{type:'text',text}], 'queue')`，blank 会话直接可用；
    - fork resolve 后子会话立即可 prompt（`projectList()` 同步并入），无需轮询；runtime 对 prompt 文本无长度上限，注入文本长度由 L2 自控；
    - 两个实跑坑入档：patch `name` = loader import 的包名；ModuleLoader `id` 必须逐字等于包名；
    - 升级风险注记：DSH 0.1.2 起 `session.events` / `firstLiveSeq` / `seedLength` API 变更将命中投影层（当前基线 0.1.1-rc.2 不受影响）。

## 2026-09-05

- **立项**：画布模式（画布 + 分支 + 合并）正式立项为本仓第三条线。
- **决策**：
  - 落点 = DSH web profile 插件，二开 [dsh-synapse](https://github.com/liangmianya/dsh-synapse)（MIT）；
  - 合并语义 = 真实会话产物（fork + 首条消息注入另一线内容）；
  - 首版范围 = 合并 + 画布增强；
  - 项目位置 = `dsh-miasaki-canvas/`，可独立成 npm 包；
  - 包名 = `@miasaki/dsh-canvas`；
  - 画布数据文件 = 独立目录 `$DSH_HOME/miasaki-canvas/`（不与上游 `$DSH_HOME/synapse/` 共用）；
  - 合并后原线默认保留（合并是衍生不是销毁）；
  - 再合并血缘 = D 方案（默认直连直接来源 + 详情面板传递血缘视图）；
  - 吸收态标记 = 被后续合并吸收的合并卡显示弱化小标记（不消失、可点击跳转）。
- **参考**：微软 Huabu（产品理念）、dsh-synapse v0.4.1（技术实现，源码已通读）。
- **产出**：[设计文档](2026-09-05-canvas-merge-design.md) 草案 v0.1。
