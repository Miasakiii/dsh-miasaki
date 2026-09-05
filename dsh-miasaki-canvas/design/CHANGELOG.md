# CHANGELOG — dsh-miasaki-canvas

本文件记录 `dsh-miasaki-canvas/` 线的设计决策与变更。

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
