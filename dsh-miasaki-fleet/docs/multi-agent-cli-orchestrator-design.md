# 多 Agent CLI 协作模式 — 设计文档

- 版本：v0.14
- 日期：2026-08-24
- 状态：Draft
- 作者：总指挥（Miasaki 会话）

> 变更记录：
> - v0.1 初稿。
> - v0.2 引入 **Operator（人类操作员）角色**：人类决定启动哪些 CLI（开关），总指挥只在**已开启的 fleet** 内做任务适配与分配；新增 `control.json` 协议、fleet 适配规则、面板开关 UI、进程托管规则。
> - v0.3 依据官方仓库调研（`docs/dsh-official-repo-review-2026-08-16.md`）重写 §12 runtime 选型：官方 `dsh-subagent-*` 四件套 + ACP 协议成为 M3 首选评估对象，自研薄壳降级为兜底；§4.1 新增 `metering` 字段；§7.2/§9.1/§10/§11.2 补充 ACP 对应能力；§13 路线图调整。
> - v0.4 M3 实测完成（`docs/m3-official-runtime-eval-2026-08-16.md`）：`dsh-subagent-dsh-sdk` 在 Windows 全链路通过（协议 4/4、SDK 客户端 3/4 + 平台缺口、进程外后端 1/1），定为 M3.5 worker runtime，自研薄壳退役；§10/§12/§13 回写实测结论。
> - v0.10 依据官方仓库复查（`docs/dsh-official-repo-review-2026-08-17-rc7.md`）与官方决策笔记（production-dsh-excludes / background-subagent-tasks / subagent-capability-seam 等）修订 §12/§13：**rc.7 已发布（npm `next`，latest 仍 rc.6）**；产品提供方（Codex/Claude Code）支持后台 Job 且为显式 opt-in 安装、ACP 支持图片桥接、Web 设置面板支持插件自有配置；§12 增补版本线/Job 语义/面板配置结论，§13 增补 M3.5 回归冒烟与 M6 异构候选路径。
> - v0.11 方向修正（Operator 指令，2026-08-17）：worker 定位改为**编排本机已安装的 agent CLI**（扫描发现 → 开关 → 派单），废弃自研 worker CLI 与 dsh-sdk 常驻子进程 worker 路线（等价于重复造 subagent，无增量价值）；新增 §2 发现层、§4.1 `runtime:"cli"` 档案扩展、§7 派单式执行、§9.1/§12/§13 回写。本机已扫描发现 8 个 CLI（bl / claude / gemini / opencode / dsh / pi / mimo / agent-browser），扫描器 = `workers/discovery/scan-agents.ps1`。
> - v0.12 M3.5 派单器落地（2026-08-17）：`workers/dispatch/dispatch-task.ps1` 上线——预算预检（当日 cost vs budget_per_day，80% 预警 / 熔断拒绝 exit 4）+ usage 自动解析（json-cost-usd 解析器，实测与手填记录逐字段一致）+ 退出码语义（0/2/3/4）+ 免执行验证模式（-CheckOnly/-ParseOnly）；t-0005（bl 资源查询，blocked→reopen→done 首次真实走通）与 t-0006（claude 21 回合，真实计量 $0.414 首账，permission_denials 验证交付物代写）双闭环；§7.0/§9.1/§13 回写。
> - v0.13 校准批次与并发验证（2026-08-17）：8 档案补齐 `skills` + `preflight`（扫描器仅空时填充）；校准报告 `docs/cli-calibration-2026-08-17.md`——**fleet 4/8 立即可用**（claude/bl/opencode/pi），gemini 半可用（模型区域受限 403）、mimo 语法待校准、agent-browser 命令型、dsh 缺 headless profile；**并发派单验证通过**（opencode+pi 并行互不干扰，两者均 deepseek-v4-flash → 同模型对照素材）；t-0001~t-0008 八任务闭环；§13 回写。
> - v0.5 依据腾讯技术工程《DeepSeek Harness 实测｜模型之外的那一半，到底带来了什么》（2026-08-15，归档于 `docs/ref-tencent-dsh-review-2026-08-15.md`）补充：§4.1 `tool_allowlist`；§4.4 计量字段扩展（cache_read/cache_write/step/takeover）；§4.5/§6.4 台账聚合字段；§6.3 效率维度；§7.5 工具面收窄；§7.6 上下文隔离；§8.1 治理指标；§9 计量来源；§12.1 架构自检三问。
> - v0.6 依据 Datawhale《最新！DeepSeek Harness 插件教程来了！》（2026-08-14，归档于 `docs/ref-datawhale-dsh-plugin-tutorial-2026-08-14.md`）补充：§7.5 视觉领域扩展示例（dsh-vision-toolkit）；§11.2 第三方插件治理清单；§12 插件开发实操坑（pnpm run build / 插件须放 Harness 仓库内）。
> - v0.7 依据 Datawhale《国产之光！GLM 5.3 + DeepSeek Harness 实测来了》（2026-08-15，归档于 `docs/ref-datawhale-glm53-dsh-review-2026-08-15.md`）补充：§6.3 模型特性画像（GLM-5.3 工程完备 vs GPT-5.6-Sol 视觉表现、视觉反馈回路风险）；§6.4 生产级验收必查项；§12 ZCode 异构候选。
> - v0.8 依据 GitHub 社区仓库 [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)（2885★ 两阶段锚定预设，2026-08-16 分析）补充：§6.3「工具面是第一杠杆」证据；§7.5 三层工具目录 v2 方向；§7.6 轨迹扰动证据与技能按需加载；§12 社区参考实现与插件工程纪律；§13/§14 M6 参考与复测开放问题。
> - v0.9 依据 Datawhale《最新！DeepSeek Harness 桌面版和 CLI 来了！》（2026-08-16，归档于 `docs/ref-datawhale-dsh-desktop-cli-2026-08-16.md`）补充：§8.3 TUI / 桌宠形态社区先例（dsh-TUI 1.8k★、DSH Desktop 11.1k★）；§12 入口形态与 Headless 一次性任务入口；§11.2 凭证卫生；§7.6 工作区范围。
> - v0.14 依据腾讯技术工程《DeepSeek Harness 规模化踩坑实录：耗时、成本、失败到底该怎么查》（2026-08-24，归档于 `../dsh-miasaki-shared-docs/dsh-platform/ref-tencent-agent-obs-2026-08-24.md`）补充：DSH 可观测生态情报——腾讯云官方插件 `tencentcloud-agentobs-sdk-dsh`（支持 DSH >=0.1.0-rc.6 <0.2.0）以状态树+延迟发射把 DSH 事件流还原为五层调用树（entry/agent/step/chat/tool，OpenTelemetry GenAI 语义约定；一次 turn 一条 trace、`gen_ai.session.id` 横向关联、重试不合并 `dsh.llm.attempt`、中断补发带错误码 Span）；结论：与 fleet 现有任务级文件总线观测互补而非替代（插件仅覆盖 dsh 单 CLI、需云凭证、captureContent 默认上送会话内容），五层 schema 作为未来 dsh worker step 级观测参考；dsh 缺 headless profile 仍为非活动 worker，暂不接入。

---

## 0. 文档目的

本模式的目标：**一个总指挥（大会话）+ N 个 worker CLI（小会话）**，实现：

1. **人类（Operator）决定 fleet**：通过开关决定启动/关闭哪些 agent CLI；总指挥不擅自增删进程，只能建议；
2. worker 之间**互相不可见**，一切协作通过总指挥路由；
3. 总指挥拥有**全局总览**：每个小会话的状态、进度、会话内容、token 消耗；
4. 总指挥依据 **agent 特性（人设/技能）及其搭配的模型**，在**已开启的 CLI 集合内**做任务分配；
5. 一个**监控面板**：开关、状态灯、进度、token/成本、心跳、告警。

本文档定义所有跨进程协议与数据结构，是后续实现的唯一依据。**worker = 本机已安装的 agent CLI**：总指挥扫描发现它们、Operator 开关它们、Commander 按特性派单（spawn CLI 进程执行任务）。**不自研 worker 运行时**——自研薄壳与 dsh-sdk 常驻子进程路线已废弃（等价于重复造 subagent，无增量价值；评估结论归档于 `docs/m3-official-runtime-eval-2026-08-16.md`，仅供 dsh 原生任务参考）。

### 术语

| 术语 | 含义 |
|---|---|
| Operator / 操作者 | **人类**。唯一有权开关 agent CLI 的角色（通过面板开关或命令） |
| Commander / 总指挥 | 大会话（本 DSH 会话）。任务分解、分配、验收、仲裁、知识策展 |
| Worker / 小会话 | **本机已安装的一个 agent CLI**（bl / claude / gemini / opencode / pi / dsh / mimo / agent-browser 等，由扫描器发现）。每个任务派单时 spawn 一次进程，CLI 的 stdout/会话即小会话内容 |
| Discovery / 扫描器 | `workers/discovery/scan-agents.ps1`：探测 PATH 上的已知 agent CLI → 生成 `agents/<id>/manifest.json`（runtime:"cli"）与 `agents/registry.json`；只刷新 cli 元数据，不覆盖 Operator 编辑 |
| Fleet | 当前 **enabled=true 且进程存活** 的 worker 集合 |
| Workspace | 所有协作文件的根目录（本项目即 `dsh-miasaki`） |
| Bus | 文件总线：所有跨进程通信机制的总称 |
| Ledger | 成本台账：token → 金额的聚合记录 |

---

## 1. 设计原则

1. **文件即总线（file-as-bus）**：所有通信走 workspace 下的文件，不用管道/内存/网络。理由：进程独立、可崩溃重启、人类可审计、总指挥可随时插入干预。
2. **单一写者（single-writer）**：每个文件/目录只有一个角色有写权限，从根上消灭并发写冲突。
3. **权力分立**：**Operator 管 fleet（开关）、Commander 管任务（分配）、Worker 管自己目录**。任何角色不得越权。
4. **崩溃安全**：任何 worker 可被 kill 并重启；所有状态只存在于文件中，进程内无关键状态。
5. **最小可见性**：worker 只读自己的目录 + 共享只读区，物理上无法"看见"其他 worker。
6. **强制的计量**：usage 上报是 worker 的义务，缺失上报视为故障而非正常。
7. **无头优先（headless-first）**：worker 是纯 CLI，不依赖 GUI；总指挥侧的监控面板是唯一 UI。

---

## 2. 架构总览

```
   ┌─────────────────┐        ┌───────────────────────────────┐
   │ Operator（人类） │        │  Commander（大会话 / DSH）     │
   │  决定 fleet 开关 │        │  · 读 fleet，任务分解与分配    │
   └───────┬─────────┘        │  · 验收与仲裁 · 知识策展        │
           │ 开关/建议          └───────┬───────────┬───────────┘
           ▼                            │ 唯一写     │ 全局读
   ┌────────────────────────────────────▼───────────▼─────────┐
   │                  Workspace（文件总线）                    │
   │  state/ · tasks/ · agents/*/ (manifest+control) · shared/│
   └──────────────────────┬───────────────────────────────────┘
                          │ 扫描发现（一次/手动触发）
   ┌──────────────────────▼───────────────────────────────────┐
   │  Discovery：workers/discovery/scan-agents.ps1            │
   │  探测本机 agent CLI → manifest(runtime:"cli")+registry   │
   └──────────────────────┬───────────────────────────────────┘
                          │ spawn 派单（Commander 按任务）
   ┌────────┬────────┬────────┬────────┬────────┬─────────────┐
   │   bl   │ claude │ gemini │opencode│  pi    │ dsh/mimo/…  │
   │ CLI进程 │ CLI进程 │ CLI进程 │ CLI进程 │ CLI进程 │（本机已装）  │
   └────────┴────────┴────────┴────────┴────────┴─────────────┘
       每任务 spawn 一次；互相不可见（各自会话 + 目录约定）
```

### 控制流（发现 → 开关 → 派单）

```
① 扫描发现（Commander 手动触发或面板按钮）
   scan-agents.ps1 → agents/<id>/manifest.json（runtime:"cli"）+ registry.json
   ▼
② Operator 拨开关
   写 agents/<id>/control.json { enabled: true/false }
   ▼
③ Commander 派单（enabled=true 的 CLI 才可被派）
   按任务特性匹配 CLI → spawn <cli> <invoke 模板，{prompt}=brief+context>
   → stdout 捕获为 transcript，usage 按 metering_source 解析
   ▼
④ 交付与验收（§5 状态机；runtime:"cli" 的 status 由派单器代理写）
```

### 消息流（一个任务的完整生命周期）

```
1. Commander 写 tasks/<id>/brief.md + context.md，追加 tasks.jsonl(create)
2. Commander 读 fleet，选择 assignee，投递至其 inbox/，追加 tasks.jsonl(assign)
3. Worker 原子领取，写 status.json(state=running)
4. Worker 执行，期间：每次模型调用后追加 usage.jsonl；
   周期性更新 status.json（心跳 + 进度）
5. Worker 写 result/ 交付物，追加 tasks.jsonl(done) —— worker 发起，Commander 复核
6. Commander 验收：通过 → done 确认；不通过 → reopen（带修改意见重新投递 inbox）
```

### 唯一路由规则（写进每个 worker 的 persona_prompt）

> 你是一个独立 worker，只通过你的 `inbox/` 接收任务、通过 `outbox/` 交付结果。
> 你不感知其他 worker 的存在，也无法与其通信。
> 所有需要协作、跨任务信息、依赖他人的诉求，一律写在 `outbox` 的结果文件里，由总指挥裁决。
> 你只读自己的目录、`control.json` 和 `shared/`，绝不读取、修改其他 agent 目录或 `tasks/`、`state/`。
> 当你的 `control.json.enabled` 变为 false 时，完成当前任务后主动退出，不领取新任务。

---

## 3. 目录结构

```
workspace/                          # 本项目根目录
├─ state/                           # ★ Commander 唯一写者（worker 只读）
│  ├─ tasks.jsonl                   # 任务台账（追加写）
│  ├─ ledger.jsonl                  # 成本台账（追加写）
│  └─ events.jsonl                  # 全局事件流（可选，Monitor 消费）
├─ tasks/
│  └─ <task-id>/                    # 每任务一目录
│     ├─ brief.md                   # 任务书（Commander 写）
│     ├─ context.md                 # 上下文捆绑包（Commander 写）
│     └─ result/                    # ★ worker 唯一写者（交付区）
│        ├─ result-<task-id>.md     # 结果报告（固定文件名）
│        └─ artifacts/              # 产物文件
├─ agents/
│  ├─ registry.json                # ★ 扫描器唯一写者（发现清单快照）
│  └─ <agent-id>/                   # 每 worker 一目录
│     ├─ manifest.json              # 档案（runtime:"cli" 由扫描器生成，Operator/Commander 可编辑）
│     ├─ control.json               # ★ Operator 唯一写者（开关 = 派单许可）
│     ├─ status.json                # ★ 派单器/worker 写者（心跳+进度）
│     ├─ inbox/                     # ★ Commander 唯一写者（投递任务文件）
│     ├─ outbox/                    # ★ worker 唯一写者（交付物）
│     ├─ usage.jsonl                # ★ 派单器写者（按 metering_source 解析后落盘）
│     ├─ transcript.md              # ★ 派单器写者（CLI stdout 捕获）
│     ├─ notes.md                   # ★ worker 唯一写者（自持久记忆）
│     └─ logs/                      # 进程 stdout/stderr 日志
├─ workers/
│  └─ discovery/scan-agents.ps1     # 扫描器：探测本机 agent CLI → manifest + registry
└─ shared/                          # ★ Commander 唯一写者，全体只读
   ├─ collective-memory.md          # 总指挥策展的跨 agent 知识
   └─ corpus/                       # 共享资料（文档、规范等）
```

> 注：`outbox/` 与 `tasks/<id>/result/` 的关系二选一，v1 采用**符号链接或直接让 worker 写 result 目录、outbox 作为约定路径**。若平台不支持 symlink（Windows 权限），则 outbox 下放 `result-<id>.md` 硬文件，artifact 放 `outbox/artifacts/<task-id>/`。**实现时二选一并写死。**

---

## 4. 文件格式规范

### 4.1 `agents/<agent-id>/manifest.json` — Agent 档案（Commander 写，创建时一次写定）

```json
{
  "id": "scout",
  "name": "调研员",
  "runtime": "cli",                   // "cli"（本机 agent CLI，v1 主路线）| "dsh" | "custom"（旧）
  "model": "qwen-max",
  "model_price": { "input": 0.0008, "output": 0.002 },   // 元/1K tokens，估算用；无计量时为 null
  "metering": true,                   // 是否强制 usage.jsonl 上报；false 的 agent 豁免 §4.4 并显示"无计量"
  "metering_source": "console-usage", // cli runtime 的计量来源（§9.1）：console-usage / json-cost-usd / session / unknown
  "skills": ["web-research", "summarize", "zh-report"],
  "cli": {                            // ★ runtime:"cli" 专属：扫描器发现的可执行体与派单模板
    "command": "bl",
    "binPath": "C:\\Users\\...\\npm\\bl.ps1",
    "version": "1.15.0",
    "invoke": "bl text chat --message {prompt}"   // {prompt} 替换为 brief+context
  },
  "tool_allowlist": ["read", "grep", "glob", "web_search"],   // 显式工具白名单（§7.5）；null = runtime 默认工具面（不推荐）
  "persona_prompt": "……（人设 + 唯一路由规则，见 §2）……",
  "limits": {
    "max_tokens_per_task": 50000,
    "max_concurrent_tasks": 1,
    "budget_per_day": 2.0,            // 元，硬性熔断
    "timeout_ms": 600000,             // 单任务硬超时
    "heartbeat_ms": 30000             // 心跳周期
  },
  "updated_at": "2026-08-16T20:44:00Z"
}
```

约束：
- `id` 全局唯一，创建后不可变；**manifest 不含 enabled 字段——开关归属 §4.2 的 control.json，由 Operator 独有**；
- `runtime:"cli"` 的档案由扫描器生成（只刷新 `cli`/`updated_at`，不覆盖 Operator 编辑的 skills/persona/limits 等字段）；`cli.invoke` 是派单模板，Commander 派单时把 `{prompt}` 替换为 brief+context 全文；
- `persona_prompt` 必须内嵌 §2 的唯一路由规则与"排空退出"规则（cli runtime 无主循环，该规则主要约束派单器不向未开启的 CLI 派单）；
- `model_price` 是估算单价，v1 不做实时报价查询（见 §9）；`metering=false` 或 `metering_source:"unknown"` 的 agent 豁免 §4.4 上报义务，面板显示"无计量"。
- `tool_allowlist` 是 worker 可见工具的白名单（领域收窄，见 §7.5）；null = 用 runtime 默认工具面（约 25 项，固定前缀可达 1 万+ token，不推荐，见 §7.6）。cli runtime 的工具面由该 CLI 自身配置决定，白名单语义迁移到 §7.5 的 CLI 配置层。

### 4.2 `agents/<agent-id>/control.json` — 开关（★ Operator 唯一写者）

```json
{
  "enabled": true,                    // 开关：true=启动/保持 worker，false=排空退出
  "force_kill": false,                // 关闭时是否立即终止当前任务（true=不等排空）
  "updated_at": "2026-08-16T20:50:00Z",
  "updated_by": "operator"
}
```

- **唯一合法的写入者是 Operator**（通过监控面板开关或显式命令）。Commander 只读此文件来判定 fleet，**不得修改**；想调整 fleet 只能向 Operator 提建议；
- 进程托管器（Monitor 进程 / DSH Host 插件）订阅此文件变化：
  - `enabled=true` 且进程未存活 → spawn；
  - `enabled=false` → 让 worker 排空退出；`force_kill=true` 则立即终止进程；
- 开关的**意图**（enabled）与**现实**（进程存活）可能不一致，面板需同时展示两者（见 §8.1）。

### 4.3 `agents/<agent-id>/status.json` — 心跳与进度（worker 唯一写者）

```json
{
  "version": 1,
  "agent_id": "scout",
  "state": "running",                 // idle | running | draining | blocked | error | stopped
  "current_task": "t-0012",
  "progress": 0.62,                   // 0.0 - 1.0
  "step": "正在整理第三部分资料",
  "heartbeat_at": "2026-08-16T20:44:30Z",
  "tokens": { "task": 12345, "session": 12345, "day": 12345 },
  "last_error": null
}
```

- worker 每次模型调用后、或至少每 `heartbeat_ms` 更新一次（含 `idle` 时的保活心跳）；
- `draining` = 收到关闭指令后仍在完成当前任务的状态；
- `last_error` 非空时 state 必须为 `blocked` 或 `error`。

### 4.4 `agents/<agent-id>/usage.jsonl` — 每次模型调用的计量（worker 唯一写者，追加写）

每行一条 JSON：

```json
{"ts":"2026-08-16T20:44:30Z","task":"t-0012","model":"qwen-max",
 "input_tokens":1200,"output_tokens":300,
 "cache_read_tokens":11500,"cache_write_tokens":1200,
 "step":3,"takeover":0,
 "cost":0.00156,"note":""}
```

- `cost = input_tokens/1000 * model_price.input + output_tokens/1000 * model_price.output`，由 worker 按自己的 manifest 计算后写入（cache 命中 token 的单价若与普通 input 不同，v2 起按 provider 实际报价拆分）；
- `cache_read_tokens` / `cache_write_tokens`：**必填**（无 cache 概念的 runtime 填 0）。DSH runtime 可直接从 session usage 事件读取。实测依据：长任务中 cache-read token 可达 1.3 万/次（腾讯技术工程实测），是上下文前缀成本的大头，缺失该项会严重低估固定成本（见 §7.6、§9.2）；
- `step`：本次调用发生在任务内的第几步（供 §6.3 / §9.2 步数效率聚合）；
- `takeover`：本步是否发生人工接管/审批介入（0/1，验收时聚合进台账）；
- **强制义务**：一次模型调用完成后 10 秒内必须落盘。缺失上报 = 故障（见 §9）；
- 该文件是成本数据的唯一原始来源。

### 4.5 `state/tasks.jsonl` — 任务台账（Commander 唯一写者，追加写）

每条一行 JSON，`op` 取值 `create | assign | reassign | update | reopen | cancel`：

```json
{"op":"create","task":{"id":"t-0012","title":"调研 X 平台评价","assignee":"scout",
 "status":"queued","created_at":"2026-08-16T20:44:00Z","updated_at":"2026-08-16T20:44:00Z",
 "retries":0,"tokens":0,"cost":0.0,"steps":0,"takeovers":0,"depends_on":[],"waiting_for":null}}
{"op":"assign","task_id":"t-0012","assignee":"scout","updated_at":"..."}
{"op":"reassign","task_id":"t-0012","from":"scout","to":null,
 "reason":"scout 已被 Operator 关闭","updated_at":"..."}
{"op":"update","task_id":"t-0012","status":"running","updated_at":"..."}
{"op":"reopen","task_id":"t-0012","reason":"结论缺少数据来源","updated_at":"..."}
```

- 台账是追加式日志：**当前状态 = 按 task_id 重放最后一条相关记录**；
- `status` 取值见 §5 状态机；`waiting_for` 用于"无匹配 agent"的暂存任务（值 = 缺失的技能名）；
- `tokens`/`cost`/`steps`/`takeovers` 字段由 Commander 在验收时从 usage.jsonl 聚合回填（`update` 操作）。

### 4.6 `tasks/<id>/brief.md` — 任务书模板（Commander 写）

```markdown
# 任务 <task-id>：<标题>

## 目标
<一句话可验证的目标>

## 交付物
- [ ] <可检查的文件/内容>

## 约束
- 预算：<N> tokens 以内；超时：<M> 分钟
- 不修改 workspace 中自己目录以外的任何文件
- 依赖任务：<task-id 或 无>

## 验收标准
1. <逐条可检查的标准>

## 完成后必做
1. 将结论写入 result/result-<id>.md（含：结论 / 完成度 / 数据来源 / 遇到的问题 / 给总指挥的建议）
2. 用自己的要点更新 notes.md（≤10 行）
3. 如有值得全体知晓的发现，在 result 中单列 "## 广播建议"
```

### 4.7 交付物 `result-<task-id>.md` — 固定结构（worker 写）

```markdown
# 结果：<task-id> <标题>

## 结论
<总指挥可直接使用或转交的结论>

## 完成度
<100% 或未完成项清单>

## 数据来源 / 依据
<引用、文件路径、链接>

## 遇到的问题
<阻塞点、需要总指挥裁决的事项>

## 广播建议
<可选：建议总指挥写入 collective-memory 的知识>

## 下一步建议
<可选>
```

---

## 5. 任务状态机

```
                 ┌────────┐   reopen(Commander, 附意见)
      ┌─────────▶│ queued │◀───────────────┐
      │          └───┬────┘                 │
      │     assign  │ (Commander 在 fleet 内 │
      │             │  选 assignee 投递 inbox) │
      │          ┌──▼────┐                  │
      │          │running│──blocked(worker)─▶│
      │          └──┬──┬─┘                  │
      │    done(worker│ │ failed(worker)────▶┤
      │    +Commander │ │ (含 error)         │
      │      验收)     │ └────────────────────┘
      │          ┌──▼────┐   验收不通过
      └──────────│ done  │◀─────────────────┘
                 └───────┘
```

| 迁移 | 发起者 | 触发条件 |
|---|---|---|
| queued → running | Commander 写 assign + worker 领取 | brief 已投递 inbox，worker 开始执行 |
| running → blocked | worker | 缺依赖、需裁决、等外部条件；附 `last_error` |
| running → failed | worker | 执行异常/超时/预算耗尽；附 `last_error` |
| running → done（待验收） | worker | 交付物落盘 |
| done → done（确认） | Commander | 验收标准逐条通过 |
| done → queued（reopen） | Commander | 验收不通过，附具体修改意见，`retries+1` |
| * → queued（reassign） | Commander | **assignee 被 Operator 关闭**（见 §6.5） |
| * → cancel | Commander | 任务作废（依赖失效、方向变更） |

规则：
- **交付与验收终态区分**（M1 实测修正）：worker 交付写 `status:"done"`（待验收）；Commander 验收通过后追加 `status:"done", accepted:true`（确认）。台账重放时以最后一条 `accepted` 记录为终态；
- **同一任务同时只有一个 assignee**，`parallel_limit` 默认 1（v1 不支持一个任务多 worker 并行）；
- `blocked` 的任务由 Commander 补充 context 后重新投递（reopen 到 queued）；
- `retries ≥ 3` 且仍不通过 → Commander 换 agent 或降级为人工介入；
- 依赖（v1）：`depends_on` 中的任务全部 `done` 后，Commander 才允许 assign。

---

## 6. Commander（总指挥）行为规范

### 6.1 任务分解原则
- 每个子任务：**单一交付物、可在 30 分钟内完成、验收标准可逐条检查**；
- 分解粒度由总指挥判断：粒度过粗 → 验收困难；过细 → 协调开销大。

### 6.2 分配流程（fleet 内适配）

```
① 读 fleet：control.json.enabled == true 且 status.json 心跳存活的 agent 集合
② 技能匹配：任务所需技能 ∩ agent.skills 得分排序
③ fleet 内有匹配 → 按决策表（§6.3）选出 assignee → 投递
④ fleet 内无匹配 → 任务暂存（status 保持 queued，waiting_for = 缺失技能），
   并产生一条"开启建议"：在面板提示 Operator「建议开启具备 X 技能的 agent」
   —— Commander 绝不擅自开启，也不擅自把任务塞给明显不匹配的 agent
⑤ 例外降级：仅当任务低风险（可回滚、无副作用）且 Operator 已认可
   "无匹配时可降级分配"的全局偏好时，Commander 才可把任务降级给
   次优 agent，并在 brief 中显式声明降级原因与风险
```

### 6.3 分配决策表（决策依据，按优先级）

| 优先级 | 依据 | 说明 |
|---|---|---|
| 1 | 技能匹配 | 任务类型 ↔ `manifest.skills`（如调研 → scout） |
| 2 | 模型能力/成本 | 核心决策与终稿用强模型；侦查、格式化、翻译等杂活用便宜模型 |
| 3 | 当前负载 | `status.json` 为 idle 才可派单（避免积压） |
| 4 | 历史表现 | `retries` 高 / 频繁 blocked / 步数-产出效率低（steps 高、takeover 多）的 worker 降级使用 |
| 5 | 预算余量 | `budget_per_day` 已触顶的 worker 不派单 |

> 模型特性画像（Datawhale 同题实测，2026-08-15）：同一 Harness 下 GLM-5.3 与 GPT-5.6-Sol 核心功能打平，工程细节分层——GLM-5.3 默认带登录限流 / 安全响应头 / 会话清理（**安全敏感任务优先考虑**）；GPT-5.6-Sol 视觉表现更强。另注意：有视觉能力的模型做前端易被平庸的需求描述带跑偏（"AI 味"清单全中），无视觉模型靠代码惯例反而克制——派前端/设计类任务时按需决定是否给 worker 配视觉反馈回路，并把"风格约束"写进 brief。
>
> 工具面配置是第一杠杆（dsh-anchored-standard 实验，2026-08）：同模型（V4 Pro）同 Harness 同任务，仅预设不同，Project2 得分 91/92（Standard/PTC）→ 99/96（Minimal）。给 worker 配什么工具面（§7.5）的收益可能大于换什么模型——白名单不只是省 token，还直接改变输出质量；该结果单机单环境、多环境复测 85–90，仅作方向线索。

### 6.4 验收清单（每次验收必查）
1. `result-<id>.md` 存在且结构完整（§4.7）；
2. 验收标准逐条核对，任何一条不满足 → reopen，附具体意见；
3. `usage.jsonl` 有本任务的计量记录且未超预算；
4. 广播建议（如有）审阅后决定是否写入 `collective-memory.md`；
5. 验收通过后回填台账 `tokens`/`cost`/`steps`/`takeovers`（从 usage 聚合）；
6. 涉及 UI / 浏览器 / 真实环境的产物**不得只信 worker 自测**：Agent 写的测试易与实现共用盲点（实测案例：DSH 与 Kimi Code 均出现自测通过、真实浏览器失败），须独立运行验证，必要时 Operator 人工试玩确认；
7. 生产级任务按 **A1 可运行 → A9 项目文档** 的九条式标准逐条验收（Datawhale 生产级抠图实测模式）；安全必查项至少含：登录限流（连续错误应返回 429）、安全响应头（X-Content-Type-Options / X-Frame-Options / Referrer-Policy）、会话过期清理、可访问性对比度、交互语义正确性（如对比视图须两侧分别采样）。

### 6.5 fleet 变化应对（Operator 关闭某 agent 时）
1. 该 agent **queued 状态的任务** → Commander 写 `reassign` 回 queued（`assignee=null`），按 §6.2 重新适配；
2. 该 agent **running/blocked 的任务** → 默认等它排空完成（`draining`）；若 Operator 用了 `force_kill`，Commander 将任务 reopen 回 queued 并携带"已产出的中间产物路径"（见 §10 重启包）；
3. 若因此出现"无匹配 agent"的暂存任务 → 走 §6.2④ 的开启建议流程。

### 6.6 知识策展（总指挥核心职责）
- `collective-memory.md` 只收录**跨任务通用**的知识：接口约定、关键发现、踩坑记录、全局决策；
- 收录格式：`## <主题>（<task-id> 来源）` + 3-5 行要点；
- worker 之间的知识流动**只允许**经由此文件（Commander 写入 → 后续 brief 的 context.md 引用），保持"互相不可见"的完整性。

---

## 7. Worker 行为规范

### 7.0 派单式执行（runtime:"cli"，v1 主路线）

本机 agent CLI **没有常驻主循环**——每次任务派单 spawn 一次进程，任务结束进程即退出：

```
Commander 派单（派单器 workers/dispatch/dispatch-task.ps1）：
  0. 派单许可：control.json.enabled=true 才可派；preflight 提示（档案字段，如 bl 的 console 会话检查）
  0.5 预算预检：当日 cost（usage.jsonl 按 ts 聚合）vs limits.budget_per_day
      —— ≥80% 预警放行；≥100% 熔断拒绝（exit 4）
  1. 读 agents/<id>/manifest.json 的 cli.invoke 模板
  2. prompt = brief.md + context.md（§4.6；上下文隔离 §7.6）；
     命令构造：brief 中 `cmd:` 行优先（命令型任务），否则 invoke 模板替换 {prompt}
  3. spawn CLI（cwd=workspace），捕获 stdout/stderr → logs/<task>-stdout.log
  4. 期间：status.json 置 running + 心跳（进程存活即新鲜）
  5. 结束：usage 自动解析按 metering_source（§9.1；json-cost-usd 已实现）
     写入 usage.jsonl + status tokens 累计；stdout 追加 transcript.md；
     status 置 idle（exit 0）或 error（last_error=CLI exit N）；
     交付物由派单器代写 result/（§4.7 结构；异构 CLI 无人值守权限自动拒绝，实测见 t-0006）
  6. 退出码语义：0 成功 / 2 拒绝派单（开关未开、无模板）/ 3 CLI 执行失败 / 4 预算熔断；
     免执行验证：-CheckOnly（只跑预算预检）/ -ParseOnly（只跑 usage 解析，打印将写入的行）
```

- **开关 = 派单许可**：`control.json.enabled=false` 的 CLI 不派新单；正在执行的进程允许跑完（= 排空语义）；force_kill 则终止进程；
- **status.json 由派单器代理写**（CLI 进程自身不感知协议）；"进程存活"告警（§8.4）直接以派单期间进程状态为准；
- **互相不可见**：CLI 天然各开各的进程与会话；目录约定 + prompt 内路由规则（§2）约束文件访问。

### 7.1 主循环（仅常驻型 runtime：dsh / custom，旧路线参考）
```
loop:
  1. 读 manifest.json 与 notes.md（若存在）
  2. 读 control.json：
     - enabled=false → 无当前任务则退出；有当前任务则完成它（置 draining）后退出
     - enabled=true  → 继续
  3. 检查 inbox/ 是否有投递给自己的任务；有 → 原子领取 → 执行 → 交付
  4. 无任务 → 置 idle，保活心跳，sleep 一个心跳周期
```

### 7.2 原子领取
- inbox 中每个任务文件名为 `<task-id>.json`（Commander 投递时生成，内容含 `{task_id, priority, assigned_at}`）；
- worker 领取 = 将文件**重命名**为 `<task-id>.json.claimed`（rename 在单机文件系统上原子）；
- 实现注记：若 worker runtime 无法 rename，则退化为"Commander 投递时直接写 `assigned` 状态"，worker 只读 `assigned` 任务——**两方案实现时二选一写死**；
- **ACP 运行时例外**：`dsh-subagent-acp` / `dsh-subagent-dsh-sdk` 每 session 只有单 prompt slot，天然单任务串行，"原子领取"语义自动成立，无需 rename 技巧。

### 7.3 执行期义务（强制的）
1. 每次模型调用完成 → 10 秒内追加 `usage.jsonl`；
2. 每 `heartbeat_ms` → 更新 `status.json`（进度 + 步骤描述）；
3. 遇到阻塞 → 立即置 `blocked` + `last_error`，**不空转等待**；
4. 会话记录追加到 `transcript.md`（供总指挥事后审计）。

### 7.4 交付义务
- 按 brief 的"完成后必做"执行（结果文件 + notes.md + 广播建议）。

### 7.5 工具面收窄（领域收窄原则）

> 依据：腾讯技术工程 DSH 实测（2026-08-15）——插件/Preset 真正的生产价值是"删掉什么、替换什么"。默认工具面（约 25 项）让"回复 PONG"首轮都消耗 1.3 万 token；社区 Data Agent 收窄为 read/edit/write + sqlcmd 替换 bash 后，既省 token 也让模型少选错工具。

1. worker 工具集必须是**显式白名单**（`manifest.tool_allowlist`）：从 minimal preset 出发按需添加，而不是从 standard 全量删除；
2. 白名单只留与 worker 技能直接相关的工具（调研类 → read/grep/glob/web；写码类 → read/edit/write/bash + 测试工具）；禁止"可能用得上就配上"；
3. 执行器按领域**替换**而非叠加：数据分析 worker 用 sqlcmd 替换 bash（DSH Data Agent 社区实践）；
4. runtime 映射：DSH worker 在 Preset 层实现；bl / custom worker 在各自工具配置层实现；白名单语义跨 runtime 一致（§12）。
5. 领域能力扩展示例（视觉）：视觉类 worker = `dsh-vision-toolkit` 的 vision_* 工具 + 独立视觉模型 endpoint + 独立凭据（`dsh credentials set`，**与文本模型 Key 分离**）；视觉工具只进视觉 worker 的白名单，其余 worker 不加载（插件按 Profile 挂载、按 Skill `/vision-tools` 启用，见 Datawhale 教程归档）。
6. v2 方向（三层目录，参考 dsh-anchored-standard）：bootstrap 对（bash + str_replace_editor）→ 晋升后常驻集（bootstrap + 发现工具 + 已解锁工具）→ 重型工具经 dev_tool_search / skill_load 按需解锁；晋升信号从持久化会话事件推导（与 §4.4/§9 事件流天然兼容），压缩边界后回落常驻集（compaction-epoch）。v1 维持固定白名单，不做动态晋升。

### 7.6 上下文隔离（worker 启动规范，强制）

> 依据：腾讯技术工程实测——"回复 PONG"首轮请求消耗 13,467 input token，主要来自默认系统提示、工具说明、仓库规则（AGENTS.md / CLAUDE.md）与技能目录摘要的注入。多 worker 架构下每个 worker 都重复付这笔前缀成本，必须显式隔离。dsh-anchored-standard 实验进一步证明：注入不只是费 token，还会改变推理轨迹（技能目录提醒在场时，Minimal 锚定 0/9 完全不复现）——worker 继承全局技能目录摘要属于**质量扰动源**，而不只是成本问题。

1. **独立 Git 根**：worker 工作目录不得嵌套在大仓库内（防止自动发现并注入 AGENTS.md / CLAUDE.md）；每个 worker 用独立子目录或独立 clone；
2. **独立 DSH_HOME / DSH_AGENTS_HOME**：DSH runtime worker 显式设置，不继承全局技能目录与配置；
3. **minimal composition 优先**：上下文只允许经 `brief.md + context.md`（§4.6）注入，其余一律视为污染；评测、对比、敏感任务强制 minimal；
4. context.md 是 worker 上下文的**唯一入口**，Commander 对其内容与大小负责。
5. **技能按需加载**：worker 不继承全局技能目录摘要（自动注入的 skill-catalog 一律剥离）；技能经 skill_search / skill_load 按需注入。instruction 文件（AGENTS.md / CLAUDE.md）不自动注入摘要，改为晋升后一次性提示"存在 instruction 文件，动手前自行读取"。
6. **工作区范围**：worker/会话工作区必须是新建或专用目录，绝不选用户主目录、下载目录等含私人文件的位置——既防误读隐私文件，也防无关文件进入上下文。

---

## 8. 监控面板（Monitor）

### 8.1 指标清单

| 指标 | 来源 | 刷新频率 | 优先级 |
|---|---|---|---|
| **开关（Operator 可拨动）** | `control.json` | 实时 | **P0** |
| 进程存活（enabled 但未存活 = 红） | 进程托管器 | 2s | P0 |
| 状态灯（idle/running/draining/blocked/error/stopped） | `status.json` | 2s | P0 |
| 当前任务 + 进度 % + 步骤描述 | `status.json` | 2s | P0 |
| 心跳新鲜度（距今秒数） | `status.json.heartbeat_at` | 2s | P0 |
| token：本任务 / 本会话 / 当日 | `usage.jsonl` 聚合 | 5s | P1 |
| 估算成本：本任务 / 当日 / 累计 | `usage.jsonl` × 单价 | 5s | P1 |
| 会话尾部预览（最后 N 行） | `transcript.md` | 手动/10s | P2 |
| 任务队列深度、各状态计数、暂存（waiting_for）计数 | `state/tasks.jsonl` | 5s | P1 |
| **fleet 覆盖度**：enabled 技能并集 vs 队列需求 → 缺口建议 | 面板计算 | 5s | P1 |
| 治理状态：工具白名单命中 / preset 与配置 diff / 外发数据审计 | 面板计算 | 5s | P2 |
| 告警：心跳超时 / 预算 ≥80% / 连续失败 / 开关与进程不一致 | 面板计算 | 2s | P0 |

> 治理指标行（P2）是本文档相对其他 orchestrator 的差异化价值。DSH 的生产治理缺口（插件来源、配置 diff、凭证边界、日志保留、数据外发）由部署方承担（腾讯技术工程实测结论）：面板至少展示"worker 当前生效的工具白名单与 preset 版本"（配置 diff）、"插件加载来源"与"外发域名/数据去向"，Operator 可据此审计。

### 8.2 面板布局（每个 agent 一行/卡片）
```
[ 开关 ● ] scout · qwen-max · 状态:running · 任务:t-0012(62%) · 今日 12.3K tok/¥0.018 · 心跳 3s
   步骤: 正在整理第三部分资料        [看会话尾部] [kill] [重启]
```

- 开关 = Operator 专属控件，Commander 侧显示为只读；
- `kill`/`重启` 按钮对应 `force_kill` 语义，触发前需 Operator 确认；
- 顶部一行 fleet 摘要：`在线 2/4 · 暂存任务 1（缺 skill: 视频分析）→ 建议开启 video-agent`。

### 8.3 形态（二选一或共存，实现期决定）
- **TUI 版**：Node CLI（ink 或 blessed 类），键位：`空格` 拨开关、`↑↓` 选 agent、`Enter` 看详情、`k` kill、`r` 重启、`q` 退出；社区先例 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)（1.8k★，Claude Code 风）：`/doctor` `/cost` `/permissions` 命令面可参考其 UX，`/doctor` 的"凭据只显示已配置/未配置"直接可抄。注意其定位是交互式终端（Operator 侧），与 §1.7 无头 worker 互补；
- **Web 版**：DSH 动态 Cordis 插件——Host 插件提供 `list-agents / get-status / get-usage / set-switch / kill / restart` 等 JSON 方法（其中写方法仅 `set-switch/kill/restart` 且属于 Operator 操作），Client 插件在 GUI Slot 渲染实时面板与开关。**这是本会话可直接落地的形态。**
- **聚合形态（方向，v3）**：桌面宠物（桌宠）——面板折叠为一个常驻小形象，把任务状态、进度、审批请求聚合到其上（参考 Codex 风格）。M2 已实现雏形：气泡聚合态（fleet 状态色点 + 计数，颜色语义：绿=空闲/蓝=执行/橙=阻塞/红=异常）与完全隐藏态（角落小启动钮）。审批类事件接入桌宠需等审批桥（§11.2）落地后实施。社区先例 [DSH Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)（11.1k★，anywhere-labs）：Electron 把 Harness 服务一起打包、应用负责服务启停与恢复，定位"桌面本身也是插件"——与本形态"常驻应用 + 折叠面板"同构，v3 可评估复用其打包与生命周期方案。

### 8.4 告警规则（v1）
| 告警 | 条件 | 动作 |
|---|---|---|
| 心跳丢失 | `now - heartbeat_at > 3 × heartbeat_ms` | 面板红色告警 → 总指挥介入（§10） |
| 开关-进程不一致 | `enabled=true` 但进程未存活（超 30s） | 红色告警 → 托管器自动重启或上报 |
| 预算预警 | 当日 cost ≥ 80% × `budget_per_day` | 面板黄色 + 提示 |
| 预算熔断 | 当日 cost ≥ `budget_per_day` | worker 停止接新单，总指挥裁决 |
| 任务硬超时 | `running` 时长 > `timeout_ms` | 面板红色告警 → 总指挥介入 |

---

## 9. Token 计量与成本

### 9.1 计量来源（按 runtime）
| runtime | usage 来源 | 说明 |
|---|---|---|
| `cli`（bl） | `bl usage` / console 用量回执 | 派单后由派单器查询 console usage 增量；v1 可先标记"无计量" |
| `cli`（claude） | `claude -p --output-format json` 的 costUSD/token 字段 | **已实现**：派单器 json-cost-usd 解析器自动落盘 usage.jsonl（t-0006 实测：cache_read 608,768 是成本大头） |
| `cli`（opencode / pi / gemini / mimo / agent-browser） | 待校准（`--help` 或官方文档确认） | 校准前 `metering_source:"unknown"`，面板显示"无计量" |
| `dsh` | 会话用量记录 | 读取 DSH 持久化的 usage 事件（含 cache_read / cache_write token，见 §4.4） |
| `custom` | 薄壳自行从 API 响应提取 | 旧路线，已废弃（§0） |
| `fork`（M1 手动阶段） | subagent_fork 无 usage 回执 | `metering=false`，豁免 §4.4，面板显示"无计量" |

### 9.2 写入义务
- `usage.jsonl` 是成本唯一原始来源；worker **漏报 = 故障**，面板对"运行中但 60s 无新 usage 记录"的 worker 给出黄灯提示；
- 单价：v1 用 `manifest.model_price` 静态值（估算性质）；v2 可接入实时报价；
- 聚合：Commander 验收时回填台账（tokens / cost / steps / takeovers）；面板按 task/agent/day 三维聚合，并单列 cache-read 占比——它是 §7.6 上下文隔离效果的直观度量。

---

## 10. 故障与恢复

| 场景 | 检测 | 处置 |
|---|---|---|
| worker 无响应 | 心跳超时 | Commander：① 先通过 runtime 通道询问一次；② 无响应 → kill；③ 用**重启包**重启（仅当 Operator 开关仍为 on） |
| worker 崩溃/被 kill（开关仍 on） | 进程退出 + 状态冻结 | 进程托管器自动重启（上限 3 次/10 分钟，超限则告警 Operator，不再自动重启） |
| worker 退出（开关 off） | 正常流程 | 无需处置；其未完成任务按 §6.5 处理 |
| 任务预算耗尽 | usage 聚合 | 停止该任务，评估剩余价值后 reopen（降级要求）或 cancel |
| 重启后上下文丢失 | — | 见重启包 |
| 文件写入损坏（半行 JSONL） | 读取失败 | 容错：忽略损坏行，保留前缀日志 |

> 注：官方 subagent provider 已内置 dispose 幂等阶梯（关 stdin → 宽限 → SIGTERM/SIGKILL → 进程树退出证明）与取消映射（aborted / error / max-tokens），与本表 kill/重启/崩溃检测各项对应；采用官方 runtime 时直接复用，不重复实现（见调研报告 §3.2）。**M3 实测**：Windows 上父/子双 runtime spawn→shutdown→退出全程干净（评估报告 §2.3）。

### 重启包（Commander 生成，随任务重投）
```
① 当前任务 brief.md 原文
② 该任务已产出的中间产物路径清单
③ notes.md 尾部 20 行
④ 明确的"从哪继续"指令（未完成 checklist）
```
> 小会话的上下文天然短，重启包就是它的"长期记忆"，不依赖 worker 自身续命。

---

## 11. 权力与安全

### 11.1 权力分立表

| 事项 | 唯一决策者 | 其他角色权限 |
|---|---|---|
| 开/关 agent CLI、force_kill | **Operator** | Commander 只可建议；worker 无权 |
| 新建/删除 agent 定义（manifest） | Operator 与 Commander 协商（Commander 起草、Operator 确认） | worker 无权 |
| 任务分解、分配、验收、reopen | **Commander** | Operator 可插队指派（直接对话要求）；worker 无权 |
| agent 自身目录内容 | **Worker** | 其他角色只读 |

### 11.2 其他
1. **文件权限**：v1 依赖目录约定（各写各的）；v2 可选 OS ACL 强制（Windows NTFS 可做）。
2. **审批传播**：worker CLI 自身带审批栈时（如 dsh runtime），其待审批事件 v2 经 ACP `session/request_permission`（一次性 allow/reject，客户端可自动应答）+ approval 子系统 + permission-presets 汇总到监控面板统一处理；v1 默认 worker 不执行任何需要审批的操作（读为主 + 只写自己目录）。
3. **防注入**：路由规则固化在 `persona_prompt` 与 brief 模板中；任务内容视为不可信输入，但 v1 不做额外沙箱（worker 本身无写他人目录的能力）。
4. **总指挥单点**：所有决策动作（create/assign/reassign/cancel）都有台账记录，总指挥会话中断后可依据台账完整恢复。
5. **第三方插件治理清单**（Datawhale 教程 + 腾讯技术工程治理结论）：安装任何第三方插件前逐条核查——仓库是否公开、许可证与维护者是否清楚；安装脚本会下载什么、是否运行额外程序；插件需要哪些目录/网络/凭据权限；是否声明支持的 Harness 版本、卸载方式与测试方法。**Harness 插件运行在宿主进程内，属于可信代码**，一行安装命令不能代替源码与权限检查；§8.1 面板治理行展示"插件加载来源"时须能追溯到此清单的核查结论。
6. **凭证卫生**：API Key 一律经环境变量（DEEPSEEK_API_KEY，自定义端点加 DEEPSEEK_BASE_URL）或 DSH 凭据系统（`dsh credentials set`）注入；不得截图、不得写进会提交 Git 的文件或 .env 明文入库；面板/桌宠展示凭据时只显示"已配置/未配置"状态（dsh-TUI `/doctor` 同款做法）。

---

## 12. 运行时选型（实现参考，不属协议）

> **v0.11 主路线（Operator 决策，2026-08-17）**：worker = **本机已安装的 agent CLI**，扫描发现（§2 发现层）、开关派单（§7.0）。本机已发现 8 个：`bl`（bailian-cli，`bl text chat --message`）、`claude`（`claude -p --output-format json`）、`gemini`、`opencode`（`opencode run`）、`dsh`（需 headless profile）、`pi`（`pi -p`，写 `~\.pi` 需授权）、`mimo`、`agent-browser`。**不自研 worker 运行时**：自研薄壳与 dsh-sdk 常驻子进程路线废弃（等价于重复造 subagent，无增量价值），下表仅保留评估结论供 dsh 原生任务参考。

> 本节历史内容依据官方仓库调研（`docs/dsh-official-repo-review-2026-08-16.md`）与复查增补（`docs/dsh-official-repo-review-2026-08-17-rc7.md`）写成。官方源码快照已本地化于 `_refs/deepseek-harness`（master @ rc.7 合并点，含全部中英文档与 `.agents/notes` 决策笔记），以下事实均可离线核对。
> 核心判断（2026-08-16 时点）：官方已发布 **ACP（Agent Client Protocol，JSON-RPC over stdio）** 与 **进程外 subagent 四件套**（0.0.1-rc.1），"runtime 可替换、协议不变"的工程大半已实现；文件总线保留为审计/人工可读层，通信与进程托管换 ACP。**2026-08-17 官方发布 0.1.0-rc.7（npm `next`，106 commits），2026-08-19 复查已转正 `latest`**，其中与本节直接相关三项：产品提供方后台 Job 化、ACP 富内容（图片）桥接、Web 插件自有设置面板。**2026-08-19 官方发布 0.1.0-rc.8（挂 `next`，`latest` 仍为 rc.7，2026-08-20 实测）**，与本节省相关：Claude Code/Codex 升级为可安装 Profile Bundle（M6 异构 worker 候选直接可装）、Windows PTY 持久 PowerShell、`web_search` 并发、`@` 引用与图文输入、SQLite 存储格式不兼容。

| runtime | 优点 | 缺点 | 建议 |
|---|---|---|---|
| **本机 agent CLI 扫描编排** | 发现即用、零自研、各 CLI 自带模型/会话/计量；Operator 开关 + Commander 派单 | 派单语法与计量来源需逐 CLI 校准；CLI 进程无协议感知（status/usage 由派单器代理） | **v1 主路线（v0.11 起）**：扫描器 ✅、派单闭环 M3.5 |
| **`dsh-subagent-dsh-sdk`** | 子进程 = 完整 DSH runtime（自带 cordis.yml、会话持久化、模型路由、工具）；spawn→dispose 幂等阶梯、进程树退出证明官方已实现 | 0.0.1-rc.1 预览线，破坏性变更风险；与主包 rc.6 的 cordis 兼容需实测 | ~~M3.5 worker runtime~~ **已废弃（2026-08-17）**：等价于重复造 subagent；评估结论归档于 `docs/m3-official-runtime-eval-2026-08-16.md`，仅 dsh 原生任务参考 |
| **`dsh-subagent-acp`** | 标准 ACP：`session/new`、`session/prompt`、`session/update`、`session/cancel`、`session/request_permission`；单槽会话天然串行；**rc.7 起支持持久化图片 prompt/reply 桥接**（多模态 worker 通道） | 同上预览线风险 | M3 协议层候选；worker 有图片入/出的任务优先选它 |
| **`dsh-subagent-codex` / `dsh-subagent-claude-code`** | 真实 Codex / Claude Code CLI 当子 agent，异构 worker 直接可用；统一 SubagentResult 契约；**rc.7 起支持 `run_in_background` → 通用 Job 运行时（job_output/job_list/job_kill 收集与取消）** | 依赖本机安装对应 CLI；权限请求无人值守自动拒绝（适只读任务）；**生产 dsh 不内置，需显式 opt-in（见下）** | **从 v2 提前为 M6 异构 worker 首选候选**（本机有 CLI 时提前评估） |
| **subagent_fork（本会话）** | 零安装、立即可用；`ask_user_question` 兼任 Operator 开关通道 | 无 usage 计量、非独立进程、协议靠 prompt 约定 | **M1 手动闭环 ✅（t-0001/t-0002，2026-08-16 跑通、08-17 台账收尾）** |
| 自研薄壳 CLI | 深度定制自由 | 官方已实现大半，重复造轮子 | 降级：仅当官方包无法满足协议需求 |
| `bl` CLI | 现成、多模型、有 usage 回执 | 输出解析脆弱、工具面不可控 | 备选异构 worker |
| `ZCode`（智谱桌面工作台） | Agent / 项目文件 / 终端 / 任务过程 / 代码审查一体，开箱即用（智谱官方，2026-08-15 Datawhale 实测文提及） | 桌面 GUI 为主；进程外编排能力待验证 | v2 异构候选（智谱生态任务时评估） |

- **版本线警告**：主包 `@deepseek-ai/dsh` 0.1.0-rc.8（= 本机安装版本，2026-08-20 已升）与 subagent 线 0.0.1-rc.1 是**两条版本线**；官方明示预览期会有 compatibility-breaking changes；混装测试必须用独立测试 profile（`dsh plugin --profile <name>`），不得污染本会话/主配置。M3 实测：两条线在本机独立共存（m3-test profile 与本 GUI 会话）未观察到冲突，但正式同进程混装前仍需一次显式冒烟（评估报告 §2.4）。**rc.7 状态（2026-08-19 复查更新，历史）**：npm `latest` 与 `next` 均为 0.1.0-rc.7（08-17 发布后已从 next 转正 latest）；106 commits 含 subagent 修复（保留启动清理失败、后台 ack 措辞）；subagent 线仍 0.0.1-rc.1 未见新版本。**rc.8 状态（2026-08-20 复查更新）**：rc.8 于 08-19 发布、挂 `next`（实测 dist-tags：`latest=0.1.0-rc.7`、`next=0.1.0-rc.8`，latest 尚未转正）；要点：多模态图文输入（`/goal` `/plan` 可接收、`@` 菜单引用文件/会话）、`web_search` 并发、本地 `dsh web` 自动开浏览器（`--no-open` 实测可用，桌面启动器需适配）、Claude Code/Codex 可作 Profile Bundle（与 M6 异构 worker 候选直接相关，选型可重估）、SQLite 存储格式不兼容（当前会话跨升级恢复实测成功，历史 rc.7 会话恢复待抽查）。**升级纪律**：主包升级前须过回归冒烟——rc.7 轮 **✅ 2026-08-17 已通过**（A 4/4、B 3/4、C 1/1、rc7-test profile 混装加载 exit 0，无回归，报告 `docs/m35-rc7-regression-smoke-2026-08-17.md`）；**⚠️ 2026-08-20 本机主包升至 0.1.0-rc.8 未走升级前冒烟**（经 `npm i -g @deepseek-ai/dsh@next` 直接升级；`dsh --version`=0.1.0-rc.8、GUI 重启后存活、`dsh --help` 与 web 应用 `--help` 冒烟 exit 0；流程偏差已记录，m36 冒烟待补，见 `docs/next-tasks-plan-2026-08-20.md` P1-2）。产品提供方包（codex/claude-code）与 subagent 线（0.0.1-rc.1）保持不动、再议。
- **进程托管器**：负责"开关 → spawn/stop"的执行。在 DSH 环境里 = 动态 Cordis Host 插件（spawn/kill 均注册到 ctx.effect 的 disposer，插件停止时全部回收）；官方 subagent provider 的 spawn/dispose 能力可直接复用；独立场景 = Monitor 进程。
- **后台 Job 语义（官方 background-subagent-tasks 决策笔记，M3.5 托管器直接对标）**：后台 subagent 复用**通用后台任务运行时**（与后台 bash 同一套）：`kind=subagent`、`label`、`owner=父 agent`；存活期 `job_output` 只回状态、结算后幂等回终稿；`job_kill` 取消信号同时覆盖未完成的 provider 启动与已发布 run；**拥有者销毁即任务清理**（不跨会话存续），完成通知发给启动时的确切拥有者。→ 本协议 §4.2 control.json 的 enabled/force_kill 语义，v1 可先直映射到 Job 启停，不重复实现注册表。
- 总指挥侧（本会话）：DSH + 动态 Cordis 插件实现监控面板（§8.3 Web 版）；先读官方 `docs/cookbook/` 与 `docs/capability-seams.md`，不要从零摸。另有 Datawhale 最小插件实测教程（`docs/ref-datawhale-dsh-plugin-tutorial-2026-08-14.md`）可对照，两个实测坑：① `pnpm run build` 必须执行（只装依赖会导致 Web 缺构建产物）；② 插件源码须放在 Harness 仓库内（依赖仓库内的 cordis / dsh-tools 模块解析，放外部目录会 Cannot find module）。插件工程纪律参考 dsh-anchored-standard：模式目录自包含（cordis.yml 行只引用 `./local.mjs`，不得 `../`）、共享插件单一来源 + `npm run sync` 物化、不变式 `npm run check` 进 CI——M2 面板插件沿用。rc.7 新增 plugin-owned settings surface：注册过的 namespace/key 自动获得 Web 设置面板卡片——M2 面板插件的配置项可直接落官方设置 UI，不必自建设置页。
- **社区参考实现**：[xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)（2885★）用纯插件实现「首请求 Minimal 锚定 → 持久化事件晋升 → 常驻工具集」两阶段预设，是 M6「worker = DSH preset 会话」的直接先例；其 Issue 区（#52 压缩后降智、#55 Git Bash 路径、#61 bash 延迟）是 Windows 部署的免费测试报告。注意：98/99 为单机单环境结果（多环境复测 85–90，#51），机制依赖 rc.5 内部行为（rc.6 预构建包已见 bootstrapMaxTokens 失效，#11）——M6 采纳前必须在本机复测。
- **入口形态（社区现状，2026-08-16）**：官方 Web 之外，社区两大高星入口——[DSH Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)（11.1k★，Electron 桌面应用，托管 Harness 服务生命周期）与 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)（1.8k★，交互式终端）。Operator 侧可选用；**worker 侧一律用 Headless**：`dsh --profile headless "任务"` 一次性执行、打印最终答案后退出，适合 CI / Shell 脚本 / 批处理（与 §1.7 无头优先一致）。

### 12.1 架构自检三问（本项目验收标准）

> 来源：腾讯技术工程《DSH 实测》结尾"团队设计自己的 Harness 应带走的三个问题"。DSH 已给出能跑、能核对的答法；我们的多 agent 编排协议应对齐同一标准。

| # | 问题 | DSH 的答法 | 本项目的对应 |
|---|---|---|---|
| 1 | 运行时最终加载了什么，能不能一条命令打印出来 | `--dump-config` 输出最终插件树（Web 129 行 / Headless 81 行） | manifest + control + tool_allowlist 即声明式最终配置；面板展示生效 diff |
| 2 | 模型实际看见了什么，能不能从日志完整重建 | append-only session event log + 请求前 invariant 校验（重建不一致直接 fail） | usage.jsonl + transcript.md + brief/context 必须可重建 worker 每次请求的上下文 |
| 3 | 换掉文件系统 / 沙箱 / 模型提供方，多少工具必须跟着改 | Capability Seam：fs / sandbox / provider 为可替换服务，上层工具不动 | 协议与 runtime 解耦（§12）：runtime 替换时 §4 协议、工具白名单语义不变 |

### 12.2 记忆层选型（OpenViking，2026-08-24 试点通过）

> 结论：worker 与总指挥的**跨会话长记忆**采用 [OpenViking](https://github.com/volcengine/OpenViking)
>（开源 AI Agent 上下文数据库，火山引擎，AGPL-3.0，v0.4.16）。评估与安装细节归档于
> `../dsh-miasaki-shared-docs/dsh-platform/ref-openviking-dsh-2026-08-24.md`（含 v0.4.16 DSH 官方插件
> Release 说明、端到端验证记录）。

**本机已装实例（2026-08-24，全链路验证通过）**：

| 角色 | harness | 安装方式 | 会话/记忆隔离 |
|---|---|---|---|
| 总指挥（本会话） | dsh（web profile） | `dsh plugin --profile web add @openviking/dsh-memory-plugin`（Cordis 原生插件） | 会话映射 `dsh-<session-id>`；每个 subagent 独立 session |
| worker | claude 2.1.241 | `claude plugin marketplace add` + `plugin install openviking-memory@openviking`（v0.4.4，enabled） | cwd 派生 actor peer（`OPENVIKING_WORKSPACE_PEER`） |
| worker | pi 0.84.3 | 官方扩展复制至 `~/.pi/agent/extensions/openviking` + `pi install` | 同上；**默认 takeover 接管本地压缩**（fail-open） |

**服务端（本地 dev 模式）**：`~/.openviking/ov.conf`；embedding 本地
`bge-small-zh-v1.5-f16`（CPU，512 维，零 API 成本）＋ VLM `deepseek-chat`（复用
`DEEPSEEK_API_KEY`，OpenAI 兼容端点）；`http://127.0.0.1:1933` 无认证（auth_mode=dev）；
`ovcli.conf` 仅需 `{"url": "http://127.0.0.1:1933"}`。启动命令 `openviking-server`
（试点期间由会话代跑；正式使用建议手动启动或加计划任务预热）。

**与 §1 协议原则的关系**：

- **与任务总线正交**：§1.1 文件即总线（tasks/ledger/events.jsonl 等）保持不变；OpenViking
  只承担**跨会话语义记忆**（偏好/经验/知识），互不替代。
- **自动 recall 是注入式**：worker 每次 prompt 前检索注入（claude 15s 预算内、dsd 15s 阻塞
  pre-step），会改变模型可见上下文——**既是收益也是扰动**，验收时须注意"recall 内容进入
  工作记忆"（对应 §7.6 上下文隔离的补充约束）。
- **peer 隔离**：默认 `OPENVIKING_RECALL_PEER_SCOPE=all`（跨 workspace 共享）；多项目/多
  worker 并存时必须显式 `=actor` 或设 `OPENVIKING_PEER_ID` 防记忆串味——**已落地（2026-08-24）：
  `dispatch-task.ps1` spawn worker 时默认注入 `OPENVIKING_RECALL_PEER_SCOPE=actor`
  （保存→设置→finally 恢复，子进程继承已验证）；同 workspace 内各任务仍共享经验记忆**。
- **崩溃安全**：写失败入 pending queue，下次会话启动回放；server 不可达时集成 fail-open
  （claude 静默降级、pi takeover fail-open、DSH 插件不阻塞 pre-step 主流程）。

**边界与风险**：

- AGPL-3.0：本地工具形态无传染问题；嵌入自有成品对外分发前需评估。
- server 网络依赖：worker 离网/内网时集成自动降级（无 recall/capture），任务本身不受阻。
- pi 的 takeover **默认接管本地上下文压缩**——派单 pi 时若与原校准行为有出入，先
  `takeover.enabled=false` 对照。
- 成本：embedding 本地免费；VLM（deepseek）用于记忆提取/摘要/意图分析，产生少量 API 调用
  （试点实测：单次 add-memory → 后台提取 1 次调用）。
- **版本线**：DSH 插件 peer `>=0.1.0-rc.6 <0.2.0`（本机 0.1.1-rc.1 在范围内）；DSH 升至
  0.2.0 线前须复核插件适配（官方见过 prerelease tag 漂移导致 ERESOLVE）。

**fleet 应用方式（建议）**：

1. 总指挥长期记忆已生效；任务外的经验沉淀（验收教训、决策理由）可显式
   `mcp__openviking__remember`，不必只靠自动提取。
2. worker 派单时新会话自动带记忆 → 跨任务经验复用（官方 tau2-bench 证据：经验记忆提升任务
   成功率 +7~12pp）；M6 的 collective-memory 策展建议可直接查询 `viking://~/memories` 而非自建。
3. 兜底：无官方集成的 worker CLI（bl/gemini/mimo/agent-browser）记忆仍由总指挥代理
   （总指挥记住并随任务书转述），或按 §7.0 任务书携带。

---

## 13. 实施路线图

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M1 协议与手动闭环** | ✅ 完成（2026-08-16 跑通、2026-08-17 台账收尾）：t-0001 完整闭环（create→assign→交付→验收 4/4→台账回填+ledger）；t-0002 验收收尾（标准 1-4 通过，标准 5 开关 off 排空复核移交 M3.5）；metering=false 豁免 usage 已在台账/ledger 双落账 | 一次完整任务闭环 + 台账记录正确（metering=false，usage 标记"无计量"） |
| **M2 监控面板（含开关）** | DSH 动态 Cordis 插件：Host 读状态方法 + Client 面板；**Operator 开关控件 + control.json 读写**；配置项落官方 Web 设置面板（rc.7 plugin-owned settings surface） | 面板实时显示状态/进度/token；拨开关能正确写 control.json |
| **M3 官方 runtime 评估** | ✅ 完成（2026-08-16）：m3-test profile 装 `dsh-subagent-dsh-sdk`；克隆官方仓库跑 keyless 测试 A/B/C（协议 4/4、SDK 客户端 3/4+平台缺口、进程外后端 1/1）；详见 `docs/m3-official-runtime-eval-2026-08-16.md` | 成功路径：dsh-sdk 定为 M3.5 worker runtime，自研薄壳退役 |
| **M3.5 本机 CLI 派单闭环** | ✅ 主体完成（2026-08-17）：扫描器（8 CLI 档案+skills+preflight+registry）；派单器 dispatch-task.ps1（预算预检/usage 自动解析/退出码/验证模式）；**rc.7 回归冒烟通过**（`docs/m35-rc7-regression-smoke-2026-08-17.md`）；真实闭环五连——t-0005（bl，blocked→reopen→done）、t-0006（claude，$0.414 首账）、t-0007/t-0008（opencode+pi 并发互不干扰）；校准报告 `docs/cli-calibration-2026-08-17.md`（4/8 立即可用）。剩余：面板开关与派单联动、gemini 换模型、mimo 语法、dsh headless profile、opencode/pi 计量校准 | 多 CLI 混合派单跑一个真实多任务项目 |
| **M4 fleet 适配闭环** | 无匹配技能时的暂存任务 + "开启建议"提示；关闭 agent 后的 reassign 流程；fleet = 已发现且 enabled 的 CLI 集合 | 人为关闭唯一匹配的 agent → 任务暂存并出现建议；重新开启 → 任务自动继续 |
| **M5 健壮性** | 预算熔断、心跳告警、kill/重启包、reopen 流程 | 人为制造故障（kill、超预算），全链路自愈 |
| **M6 高级** | 多 CLI 混合项目（claude 写代码 → opencode 审查 → agent-browser 验证页面 → bl 查配额，DAG 依赖）、collective-memory 自动策展建议、成本报表、TUI；**同模型对照素材已就位**（opencode/pi 均 deepseek-v4-flash，官方手册「同模型多 Agent 实测对比」同款实验可复现）；**异构候选 = `dsh-subagent-codex` / `dsh-subagent-claude-code` 后台 Job 路径**（opt-in 三步：profile 装包 + host plane 挂载 + preset 工具行启用，本机需对应 CLI） | 3+ CLI 混合跑一个完整多任务项目 |

---

## 14. 开放问题（Open Questions，评审时讨论）

1. `outbox/` 与 `tasks/<id>/result/` 的映射方式（symlink vs 硬文件 vs 直接写 result 目录）——平台相关，实现期定；
2. 原子领取方案（worker rename vs Commander 直接写 assigned）——依赖 runtime 能力，实现期定；
3. 监控面板先做 Web（DSH 插件）还是 TUI，还是两者都做；
4. "无匹配时可降级分配"的全局偏好（§6.2⑤）默认开还是关——**这个直接决定 fleet 缺技能时任务是被暂存还是被硬塞**，建议默认关（暂存 + 建议），由 Operator 决定；
5. 单价是静态配置还是接入实时报价（影响成本面板准确度）；
6. 多 worker 并行时 Operator 的负载上限（几个 worker 是甜点区，建议从 2 个起步）。
7. worker 预设是否采用两阶段锚定（bootstrap → 常驻集，§7.5 第 6 条）——该机制高度依赖 V4 系模型与 rc 版本内部行为（dsh-anchored-standard 多环境复测未达 98/99），是否引入须以本机复测为准。

---

*本文档变更记录：v0.1 初稿 2026-08-16；v0.2 引入 Operator 角色与开关协议 2026-08-16；v0.3 按官方仓库调研重写 runtime 选型 2026-08-16；v0.3 附录：M1 实测修正（§5 交付/验收终态区分）2026-08-16；v0.3 附录2：§8.3 增补桌宠聚合形态方向 2026-08-16；v0.4 M3 实测回写（dsh-sdk 定为 M3.5 runtime，自研薄壳退役）2026-08-16；v0.5 按腾讯技术工程《DSH 实测》补充计量字段/工具面收窄/上下文隔离/治理指标/自检三问 2026-08-16；v0.6 按 Datawhale 插件教程补充视觉扩展/第三方插件治理清单/插件开发实操坑 2026-08-16；v0.7 按 Datawhale GLM-5.3 实测补充模型特性画像/生产级验收必查项/ZCode 候选 2026-08-16；v0.8 按 xiaobright/dsh-anchored-standard 分析补充工具面杠杆证据/三层目录 v2 方向/轨迹扰动与技能按需加载/社区参考实现 2026-08-16；v0.9 按 Datawhale 桌面版/CLI 教程补充 TUI 与桌宠社区先例/入口形态与 Headless/凭证卫生/工作区范围 2026-08-16；v0.10 按官方仓库复查增补（2026-08-17 rc.7）修订 §12/§13：rc.7 三条新能力（产品后台 Job / ACP 图片桥接 / 插件设置面板）、opt-in 安装模型、M3.5 回归冒烟、M6 异构候选 2026-08-17；v0.10 附录：M1 里程碑收尾（t-0002 验收裁决）2026-08-17；v0.11 方向修正：编排本机 agent CLI（扫描发现 → 开关 → 派单），废弃自研 worker 路线 2026-08-17；v0.12 派单器落地：预算预检 + usage 自动解析 + t-0005/t-0006 双闭环 2026-08-17；v0.12 附录：rc.7 回归冒烟完成（dsh 原生参考线 A/B/C 无回归 + rc7-test profile 混装加载通过，报告 docs/m35-rc7-regression-smoke-2026-08-17.md）2026-08-17；v0.13 校准批次（4/8 可用）+ 并发派单验证（opencode+pi）+ t-0001~t-0008 八任务闭环 2026-08-17；v0.15 按 OpenViking 试点结论（归档 `../dsh-miasaki-shared-docs/dsh-platform/ref-openviking-dsh-2026-08-24.md`）新增 §12.2 记忆层选型：总指挥 DSH 已挂 openviking-memory 插件、worker 侧 claude/pi 已装官方记忆集成、本地 server（bge + deepseek VLM）全链路验证通过；记忆层与文件总线正交、按 workspace peer 隔离 2026-08-24。*
