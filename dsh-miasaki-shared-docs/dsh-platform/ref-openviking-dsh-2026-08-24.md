# OpenViking（volcengine/OpenViking）调研归档 — 对 DSH 相关系列的价值评估

- 归档日期：2026-08-24
- 仓库：https://github.com/volcengine/OpenViking （火山引擎 / ByteDance 出品）
- 获取方式：gh CLI（README / Release / PR / contents API）+ 官方文档 raw 文件抓取
- 关联文档：`fleet/docs/multi-agent-cli-orchestrator-design.md`（记忆层对照）、
  `desktop/README.md`（桌宠人格会话对照）
- 归档者：Miasaki 会话（总指挥）

---

## 0. 一句话结论

**对我们是"直接有用"层面：OpenViking 对 DSH（我们正在用的 DeepSeek Harness）有一等官方集成**——
`@openviking/dsh-memory-plugin`，一条命令 `dsh plugin --profile web add` 即可装上，
本机 DSH `0.1.1-rc.1` 满足其 peer 范围（`>=0.1.0-rc.6 <0.2.0`）。给 DSH 补上
**跨项目/跨会话长期记忆**（自动 recall + 自动 commit + 15 个 MCP 记忆工具 + 官方 skill），
这正是当前 DSH 原生缺的一环。fleet 与桌宠线均有可落地的结合点（见 §5）。

## 1. 仓库元数据（2026-08-24 抓取）

| 项 | 值 |
|---|---|
| 定位 | Self-evolving Context Database for AI Agents —— Unify Agent Memory, Knowledge RAG and Skills |
| Star / Fork | 32.8k / 2.5k（2026-01-05 创建，增长极快） |
| 最新版 | v0.4.16（2026-08-21 发布，活跃度极高） |
| 协议 | **AGPL-3.0**（开源版无功能裁剪、无需账号/激活码） |
| 主体语言 | Python（server / 核心）17.8MB、Rust 3.3MB（ov CLI）、TS/JS（插件族） |
| 商业模式 | Managed SaaS（火山引擎）+ Self-Managed（BYOC / 离线）；开源版可自行生产部署 |

## 2. 核心概念

- **viking:// 虚拟文件系统**：memories / resources / skills 统一挂在一个
  "文件系统"下，agent 用 `ls`/`tree`/`find` 而不是黑盒向量库查询；
  每目录自带 `.abstract`（L0 ~100 token）/ `.overview`（L1 ~2k token），
  正文 L2 按需读取 → **分层加载省 token**。
- **目录级递归检索**：向量检索先定位最高分目录，再逐层下钻，结果带上下文完整性；
  每次检索保留"浏览轨迹"，可观测可调试。
- **会话即记忆**：会话 commit 后异步抽取用户偏好与 agent 经验进长期记忆
  （内存侧 `keep_recent_count`、双阶段 commit：Phase1 归档同步 / Phase2 抽取后台）。
- **Benchmark**（v0.3.22，LoCoMo + tau2-bench）：
  LoCoMo 用户记忆准确率 Claude Code 57.21%→80.32%、OpenClaw 24.20%→82.08%、
  Hermes 33.38%→82.86%，输入 token 降 34.3–91.0%、查询延迟降 58.45–66.10%；
  tau2-bench 经验记忆提升任务成功率 +6.87pp（retail）/ +11.87pp（airline）。
- 学术背景：VikingMem 论文（arXiv:2605.29640，VLDB 2026 接收）。

## 3. DSH 官方集成（最相关，v0.4.16 引入）

文档：`docs/zh/agent-integrations/17-dsh.md`；源码：`examples/dsh-memory-plugin/`；
npm：`@openviking/dsh-memory-plugin`（无运行时 npm 依赖，peer 复用 DSH 自带包）。

### 3.1 安装（两条路）

```bash
# 官方统一安装器（交互式，选 dsh，默认装进 web profile；国内可用 TOS 镜像）
bash <(curl -fsSL https://raw.githubusercontent.com/volcengine/OpenViking/main/examples/memory-plugin-shared/install.sh)

# 或直接手动（等价）
dsh plugin --profile web add @openviking/dsh-memory-plugin
dsh --profile web --dump-config   # 应出现 openviking-memory 插件组
```

前置：`openviking-server init`（Python 3.10+，provider 支持火山/OpenAI/Kimi/GLM/Ollama，
登录态可走 Codex OAuth + 本地 Ollama 纯离线）+ `~/.openviking/ovcli.conf`；
**纯本地模式默认 `http://127.0.0.1:1933`、无认证，零配置可用**。

### 3.2 工作方式（Cordis 原生，非外部 hook）

- `agent/session-start` → 注入 profile + 记忆可用索引（10000 token 预算，每会话一次）
- `agent/pre-step` → 按当前输入检索，以 createUserMessage 追加为
  **持久化插件消息**（不是 system prompt——绕开 `complete:true` 预设丢弃 system prompt 的坑；
  注入可随会话回放、对 compaction 可见、不进 request/header）
- `session/event` → 捕获 user/assistant/（可选）tool 消息
- `turn/end` → 挂起 token ≥ `commitTokenThreshold`（默认 20000）时 commit，留最近 10 条
- 写失败入 pending queue，下次会话启动回放（崩溃安全）
- `tools/pre-execute` → 拦截 DSH 文件系统/shell 工具误把 `viking://` 当本地路径
- 每个 DSH 会话映射 `dsh-<session-id>`；**每个 subagent 独立 session**
- 工具面：经共享 stdio MCP proxy 暴露 15 个 `mcp__openviking__*` 工具
  （search/read/list/tree/grep/glob/remember/write/edit/forget/add_resource/health 等，
  server 升级自动增量；forget 为永久删除，仅用户明确要求时使用）
- 随附 `openviking-memory` skill（独立 ctx.skills provider，不 shadow 现有 filesystem skill）
- 15s recall 超时预算，不阻塞 pre-step 主流程

### 3.3 关键配置

| 变量/字段 | 默认 | 说明 |
|---|---|---|
| `OPENVIKING_URL` | `http://127.0.0.1:1933` | server 端点 |
| `OPENVIKING_API_KEY` 等 | — | 凭证链 env → ovcli.conf → ov.conf |
| `OPENVIKING_WORKSPACE_PEER` | true | 按会话 workspace（cwd）派生 actor peer |
| `OPENVIKING_RECALL_PEER_SCOPE` | all | `actor` = 按工作区隔离 recall（防跨项目泄漏） |
| `recallTokenBudget` | 2000 | 客户端 recall 预算 |
| `scoreThreshold` | 0.35 | 相关度阈值 |

### 3.4 已知坑（官方 Troubleshooting 摘录）

- `ERESOLVE`：`@deepseek-ai/dsh-*` prerelease tag 漂移时，精确安装
  `@deepseek-ai/dsh@0.1.0-rc.6`
- pnpm 默认 24h `minimumReleaseAge` 拒绝新发 npm 包（配置 `minimumReleaseAgeExclude`）
- recall 为空：`curl http://localhost:1933/health`；查询最短 3 字符
- 多 workspace 一进程：设 `OPENVIKING_PEER_ID`；隔离 recall 用 `OPENVIKING_RECALL_PEER_SCOPE=actor`

## 4. 平台生态参考

- 支持 harness：claude-code / codex（含 trae-cli）/ cursor / trae×2 / zcode / opencode /
  pi / openclaw / hermes / **dsh** / MCP clients / LangChain-LangGraph / Agent Plugins 1.0
- DSH 与 openclaw/pi/hermes 同属 **"native in-process"** 形态（DSH 是 Cordis 插件）
- 伙伴项目：deer-flow（bytedance，长程 SuperAgent harness）、NoKV（AI 原生分布式文件系统）、
  loopx（轻量 loop 工程状态内核）、Hermes Agent
- OpenViking Helper（桌面控制台，win64/mac，beta）：可视化配置、会话轨迹检查、本地记忆/技能管理

## 5. 对我们三条线的价值评估

### 5.1 dsh-miasaki-desktop（桌宠/主题线）— 中期有价值

- 现状：人格靠 `%USERPROFILE%\.dsh\.agent-presets\` 预设（persona 静态）+ localStorage
  记录会话映射，**无跨会话语义记忆**。
- 结合点：若做"桌宠记住用户"（偏好/习惯/口味），OpenViking 的
  `viking://user/{id}/memories/preferences` + 自动提取正是 LoCoMo 那个场景
  （第三方集成测出准确率 57%→80%）；且不改 DSH 本体，Cordis 插件随会话进退。
- 代价：需要常驻 openviking-server（Python），或个人云 API key。

### 5.2 dsh-miasaki-fleet（多 Agent CLI 编排线）— 最有价值

- 现状：worker = 单次 spawn 的 CLI，任务通信走"文件即总线"（ledger/tasks/events.jsonl），
  记忆=AGENTS.md + 工作区约定 + `.learnings/` 等外部工具的私有目录，**跨任务经验无法自动沉淀/检索**。
- 结合点 A（总指挥）：本 DSH 会话装 `@openviking/dsh-memory-plugin` →
  总指挥获得跨会话记忆（多轮 fleet 任务的经验、坑、决策自动 recall），
  直接补上"Commander 知识策展"环节。
- 结合点 B（worker）：fleet 已发现 8 个 CLI（claude/opencode/pi/bl/gemini/mimo/agent-browser/dsh），
  其中 claude/opencode/pi 都有官方 OpenViking 集成——每个 worker 可在
  **各自 workspace peer 隔离**下积累领域经验（tau2-bench 证据：经验记忆 +7~12pp 成功率）。
- 边界：OpenViking 解决**记忆层**，不解决任务总线；与我们"文件即总线、人可审计"原则
  不冲突（记忆库可独立于 jsonl 总线存在）。注意 AGPL 传染边界（见 §6）。
- 关联：fleet 已吸收腾讯 agentobs 插件（`tencentcloud-agentobs-sdk-dsh`）作为
  "DSH 第三方插件先例"——OpenViking 是第二个官方亲和先例，且本次语义不同（记忆 vs 观测）。

### 5.3 dsh-miasaki-shared-docs — 无直接价值，仅作为生态情报

- 本归档即产出。

## 6. 风险与注意事项

1. **AGPL-3.0**：个人本地使用、作为工具安装官方插件无问题；若将来把 OpenViking
   组件嵌入自有成品对外分发（桌面端打包进安装包等），存在传染条款，需商用版/免开源自部署评估。
2. **部署成本**：server 为 Python 服务，可用云 API（火山/OpenAI/Kimi/GLM）或本地 Ollama
   （纯离线可行）；embedding/VLM 是主要开销，本地模式需确认硬件。
3. **版本线**：peer 范围 `0.1.x`（`>=0.1.0-rc.6 <0.2.0`），我们 0.1.1-rc.1 在范围内；
   升级 DSH 到 0.2.0 线前需同步确认插件适配（插件会跟 DSH prerelease tag 漂移）。
4. **数据边界**：recall 默认 `peer_scope=all`（跨 workspace），多项目机器上应设 `actor`；
   工具面 `forget` 为永久删除，需在 prompt/规范中限制。
5. **观测性**：DSH 插件 recall 无客户端 digest（与 claude-code/codex 不同），
   服务器 `rewrite` digest 参数对三方调用开放——若 recall 注入挤占上下文可后续启用。
6. **uri-guard 误伤（2026-08-24 实测）**：DSH 插件在 `tools/pre-execute 上拦截
   read/glob/grep/bash/edit/write 等工具，若**任意参数（含 content 正文）出现
   `viking://` 字面量即拒绝**，即使操作目标是本地文件、URI 只是正文引用。本地审计文档
   引用记忆路径建议省略前缀（如 peers/.../memories/events/...）或经 shell 通道写入；
   需要完全豁免时考虑配置项或改造 guard（源码：插件 uri-guard.mjs + shared/uri-guard.mjs）。
   **官方已有同问题 issue：[#4188](https://github.com/volcengine/OpenViking/issues/4188)
   （2026-08-21，OPEN，0 评论无回复）；本仓 2026-08-24 已实测追评
   （含 grep/bash/edit 补充场景与"路径语义匹配"修复建议），官方未答复前维持行为规避。**

## 7. 建议的下一步

**试点已完成（2026-08-24 当日晚间，本机全链路验证通过）**，要点：

- 安装：`uv tool install "openviking[local-embed]" --python 3.12`（隔离环境，不污染系统 Python；
  系统默认 Python 3.14b4 有 wheel 风险，用 uv 托管 3.12.14 规避）
- 配置 `~/.openviking/ov.conf`：`embedding.dense = {provider: local, model: bge-small-zh-v1.5-f16,
  dimension: 512}`（CPU 本地，启动自动下载 ~46MB GGUF）；`vlm = {provider: openai,
  api_base: https://api.deepseek.com/v1, model: deepseek-chat, api_key: DEEPSEEK_API_KEY}`（零新增成本复用）
- `openviking-server doctor` 全 PASS；`openviking-server` 本地 dev 模式（127.0.0.1:1933，无认证）
- `dsh plugin --profile web add @openviking/dsh-memory-plugin`（`^0.2.1`）→ `dump-config`
  确认 `openviking-memory` 插件组挂载（isolate: openvikingMemory）
- `ovcli.conf` 仅需 `{"url": "http://127.0.0.1:1933"}`
- 端到端验证：`ov add-memory` → 自动提取为结构化记忆（entities/events，DeepSeek 后台任务）→
  `ov find` 换表述中文查询命中 top1（score 0.52，L2 详情）
- **t-0009 真实派单验证（2026-08-24 晚间）**：派单器注入 `OPENVIKING_RECALL_PEER_SCOPE=actor`
  后派单 claude（哨兵任务）→ worker 会话自动捕获 → 提取为
  `peers/C--Users-Asakii-Desktop-dsh-miasaki-dsh-miasaki-fleet/memories/events/.../OpenViking记忆链路哨兵验证.md`
  （**peer 隔离生效**：worker 记忆落 peers/ 而非 user/）→ `ov find` 哨兵词命中 top1（score 0.360）；
  提取的 OpenViking 实体记忆已在本会话（DSH 插件）的自动 recall 注入中可见
- **DSH 插件已随重启生效**（profile 注入 + `openviking-memory` skill + 自动 recall 注入均已出现）
- **官方社区跟进（2026-08-24，均已发布评论）**：
  - [#4188](https://github.com/volcengine/OpenViking/issues/4188) uri-guard 误伤：实测追评
    （grep/bash/edit 补充场景 + 路径语义匹配修复建议）
  - [#4205](https://github.com/volcengine/OpenViking/issues/4205) 跨 Workspace 记忆注入噪声：
    确认作者"actor 仍泄漏全局资源/实体"的根因（我方注入块同现），补充缓解组合实测
    （actor 只隔离 peers/*、目录级 abstract 噪声 0.30–0.39、t-0009 输入 47.6k token 的成本证据）
    与"索引/检索语义层先裁剪、评分门控兜底"的设计建议
- 剩余验证项：`mcp__openviking__*` 工具面（重启后应可见）；**server 常驻**需用户自行管理
  （试点进程由会话代跑，正式使用建议手动启动或加开机任务）

## 8. 后续路线（试点通过后）

**worker 侧集成已装（2026-08-24 晚间，与 fleet 设计文档 v0.15 同步）**：

| 角色 | harness | 状态 |
|---|---|---|
| 总指挥 | dsh web profile | ✅ `@openviking/dsh-memory-plugin ^0.2.1`（openviking-memory 组已挂载） |
| worker | claude 2.1.241 | ✅ `openviking-memory@openviking v0.4.4`（plugin marketplace，enabled） |
| worker | pi 0.84.3 | ✅ 官方扩展（41 文件）复制至 `~/.pi/agent/extensions/openviking` + `pi install`（register 成功） |

其余路线：

1. **fleet 集成**：设计文档已写入 §12.2（记忆层选型 + peer 隔离纪律 + 派单器注入
   `OPENVIKING_RECALL_PEER_SCOPE=actor` 建议）；collective-memory 可由 `viking://~/memories` 支撑
2. **桌面端**：仅当"桌宠记住用户"进入路线图时再立项（OpenViking Helper 桌面控制台
   可作 UX 参考）
3. 若决定长期使用，评估本地部署（Docker）资源与 AGPL 边界；`openviking-server` 当前由试点
   会话代跑，正式使用时建议手动启动或加计划任务

## 9. 项目状态总览（2026-08-24 收盘）

| 维度 | 状态 |
|---|---|
| 决策 | ✅ **OpenViking 采纳为 fleet 记忆层**（设计文档 §12.2，v0.15），桌面端待"桌宠记住用户"立项 |
| 本机部署 | ✅ `openviking-server` 0.4.16 本地 dev（127.0.0.1:1933）；embedding 本地 bge-small-zh（CPU）+ VLM deepseek-chat（复用既有 key，零新增成本） |
| 集成装况 | ✅ 总指挥 dsh（@openviking/dsh-memory-plugin ^0.2.1）；worker claude（v0.4.4 marketplace）；worker pi（扩展 register）；opencode 待装（不在 PATH） |
| 验证结论 | ✅ 全链路（t-0009 哨兵：派单→捕获→提取→检索 top1）；✅ peer 隔离（worker 落 peers/、总指挥落 user/）；✅ DSH 插件注入/skill/recall 生效；✅ 派单器已注入 OPENVIKING_RECALL_PEER_SCOPE=actor |
| 已知问题 | ⚠️ uri-guard 误伤（2026-08-24 起按"不带前缀引用"规避）；⚠️ 跨 workspace 噪声（actor 不隔离全局根，等官方方案）；⚠️ 注入成本偏高（47.6k 输入观察，调 recallTokenBudget/scoreThreshold 待做） |
| 官方跟进 | 📌 #4188（guard）：2026-08-24 追评，**无回复**；#4205（噪声）：2026-08-24 评论，**无回复**；插件仍 0.2.1、uri-guard 无新提交（最后 2026-07-08）——无进展，维持行为规避 |
| 遗留事项 | ① server 常驻化（计划任务/手动，当前会话代跑）；② `mcp__openviking__*` 工具面观察确认；③ pi 扩展首个任务验证（建议先 takeover.enabled=false）；④ 注入参数调优（预算/阈值）；⑤ 观察 #3686（admission guard）与 #4205 走向 |
| 风险边界 | AGPL-3.0 本地使用无碍；分发嵌入前评估；peers 持久化路径在 `~/.openviking/data` |

> 结论：**试点→落地完成，进入日常使用与社区跟进阶段**。官方三个相关 issue（#4188/#4205/#3686）构成"bug 修复 + 注入治理 + 准入门控"的待观察队列。


