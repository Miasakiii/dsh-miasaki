# CHANGELOG — dsh-miasaki-canvas

本文件记录 `dsh-miasaki-canvas/` 线的设计决策与变更。

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
