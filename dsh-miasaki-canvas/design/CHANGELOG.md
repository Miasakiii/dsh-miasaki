# CHANGELOG — dsh-miasaki-canvas

本文件记录 `dsh-miasaki-canvas/` 线的设计决策与变更。

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
