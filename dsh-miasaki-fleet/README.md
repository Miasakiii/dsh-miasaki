# dsh-miasaki-fleet — 多 Agent CLI 编排线

**一个总指挥（大会话）+ N 个 worker CLI（小会话）**，以文件总线为唯一协调通道：
人类 Operator 决定 fleet 开关 → 总指挥发现/校准/派单 → worker CLI 执行 →
计量与心跳落盘 → 监控面板/桌宠联动展示。完整协议见
[docs/multi-agent-cli-orchestrator-design.md](docs/multi-agent-cli-orchestrator-design.md)。

## 目录

| 目录 | 职责 |
|---|---|
| `agents/` | agent 档案（manifest/control/status/usage，运行时产物已 ignore） |
| `state/` | 任务台账 / 成本账本 / 事件流 / `fleet-pulse.json`（运行时产物） |
| `tasks/` | 任务书 brief 与交付物 |
| `workers/` | 扫描器（discovery）、派单器（dispatch）、总线校验（validate-bus.mjs）、脉冲发布（pulse/publish-pulse.mjs） |
| `fleet-monitor/` | 监控面板（panel.html + server.js，本地 HTTP） |
| `schemas/` | 文件总线 JSON Schema（F1 契约） |
| `docs/` | 设计文档与调研/校准报告 |
| `tests/` | 回归冒烟与样本 |

## 常用命令

```bash
node workers/validate-bus.mjs            # 文件总线全量校验（零依赖）
node workers/validate-bus.mjs --strict   # 额外要求 fleet-pulse.json 存在
node workers/pulse/publish-pulse.mjs     # 发布 fleet-pulse.json v2（A×B 联动契约）
npm run validate / validate:strict / pulse
```

## 关键机制（2026-09-04 批次）

- **F1 总线校验**：`schemas/*.schema.json` + `workers/validate-bus.mjs` 对
  registry/manifest/control/status/tasks/ledger/events/usage 全量校验，坏行报行号；
  PowerShell 生成的 UTF-8 BOM 自动剥离，`agents/archive/` 标本跳过，被 ignore 的
  运行时文件缺失时跳过。
- **F2 计量全源覆盖**：派单器按 `metering_source` 注册表解析（`json-cost-usd` /
  `session` / `console-usage` / 未知），无机器可读计量时写**显式未计量行**
  （`cost: 0, metered: false`），杜绝静默缺口。
- **X1 脉冲发布**：`workers/pulse/publish-pulse.mjs` 聚合 fleet 五计数 +
  当日成本写 `state/fleet-pulse.json`（原子写），供桌面端桌宠 Fleet 指示器
  2s 轮询（契约见
  [`../dsh-miasaki-shared-docs/cross/ab-linkage-pulse-v2-2026-09-04.md`](../dsh-miasaki-shared-docs/cross/ab-linkage-pulse-v2-2026-09-04.md)）。
- **BOM/CRLF 容错**：`fleet-monitor/server.js` 与脉冲发布器读取 JSON/JSONL
  均剥离 BOM、按 `\r?\n` 分行，兼容本机 PowerShell 产物。

## Graph Engineering（G 系列，**G0–G2、G4 判定层已落地；调度层与 G3 设计中**）

2026-09-10：完成调研与方案，并落地 **G0（契约与事件流）** 与 **G1 判定层（任务图就绪度）**。

| 文档 | 内容 |
|---|---|
| [docs/graph-engineering-survey-2026-09-10.md](docs/graph-engineering-survey-2026-09-10.md) | 调研：概念框架（综述 arXiv:2608.21156 的三层）、可迁移工程模式、生态全景、fleet 差距实证（`depends_on` 从未使用、`events.jsonl` 全为人工里程碑） |
| [docs/graph-engineering-fleet-design.md](docs/graph-engineering-fleet-design.md) | 方案：G0 契约与事件流 → G1 任务图 → G2 能力图 → G4 验证器 → G3 失败归因，字段级设计 |

一句话概括：**在现有文件总线上叠加四张显式图，不引入框架**——任务图（DAG / 钻石结构）、能力图（多模型选型）、状态图（事件流为唯一真相）、验证器（异构验证）。

### G0 已落地（2026-09-10）

| 新增 | 作用 |
|---|---|
| `workers/bus/bus-apply.mjs` | **总线的唯一写入入口**。各角色不再直接写文件，改为提交 `{op, path, value, author, reason, expected_version}` 补丁；applier 依次做 契约校验 → 乐观并发 → 确定性排序 → 原子应用 → 追加事件 → 提交超步版本 |
| `workers/lib/bus-contract.cjs` | **契约的唯一可执行定义**（graph / result / event / patch）。applier（写入时拦截）与 validate-bus（事后巡检）共用同一份判定 —— 避免"写时放行、巡检报错"这类漂移 |
| `workers/lib/bus-apply-core.cjs` | applier 核心逻辑。不调 `process.exit`，可被测试与非 CLI 消费者直接调用 |
| `state/graph-events.jsonl` | 机器事件流（首次写入时创建）。**总线版本号由它派生**，刻意不落独立状态文件 |
| `schemas/{graph,result,graph-event,patch}.schema.json` | 四类新契约的人类可读镜像（权威实现见 `bus-contract.cjs`） |
| `tests/bus-{contract,apply,integration}.test.mjs` | 51 项测试：契约判定 23 / applier 超步 15 / 图校验闭环 13 |

```bash
node workers/bus/bus-apply.mjs --current-version       # 查当前总线版本
node workers/bus/bus-apply.mjs --patch p.json --check  # 只校验不写入
node workers/bus/bus-apply.mjs --patch p.json          # 提交一个超步
npm test                                               # 本线全部单测（71 项）
```

> **写入纪律（G0 起）**：总线文件（`state/*.jsonl`、`agents/*/capability.json`、
> `tasks/*/result.json`、`tasks/*/verdict.json`）只经 `bus-apply.mjs` 写入，
> 路径有白名单，未登记路径一律拒绝。

### G1 判定层已落地（2026-09-10）

调研发现 `dispatch-task.ps1` **此前没有任何依赖判定代码**——主协议 §5 的依赖规则只靠 Commander 自觉。
G1 把它变成可执行的判定：

| 新增 | 作用 |
|---|---|
| `workers/lib/task-graph.cjs` | **就绪度判定的唯一实现**：台账重放、图模型、依赖双语义、图就绪 / 可派判定、就绪集与可派集 |
| `workers/graph/task-ready.mjs` | CLI：`--dispatchable` / `--explain <id>` / `--groups` / `--check` / `--json` |
| `tests/task-graph.test.mjs` | 13 项，含**零行为变更证明**（真实台账新旧规则逐字一致） |

**依赖的两种语义**（任务有 `graph.consumes` 用新语义，否则回退旧语义 —— 这是零行为变更的机制）：

| 依赖来源 | 满足条件 |
|---|---|
| `depends_on`（旧，回退路径） | 上游 `done`（与主协议 §5 原文逐字一致，不看验收） |
| `graph.consumes`（新，数据依赖） | 上游 `done` ∧ **已验收** ∧ **产物存在** |

```bash
node workers/graph/task-ready.mjs                  # 图就绪集：依赖已满足、可以开工
node workers/graph/task-ready.mjs --dispatchable   # 可派集：再叠加 assignee/开关/判活/预算
node workers/graph/task-ready.mjs --explain t-0003 # 某任务为何就绪或被挡
node workers/graph/task-ready.mjs --groups         # 各钻石图分组的进度摘要
```

> **边界**：判定目前是**可查询而非强制**——`dispatch-task.ps1` 尚未按图调度。
> 首次运行即暴露真实问题：`t-0003`/`t-0004` 仍处 queued，但 assignee 指向**已归档**的
> `coder`/`analyst`（图就绪、可派被挡）。

### G2 能力图判定层已落地（2026-09-10）

G1 暴露的 `t-0003`/`t-0004` 问题，根因在能力层：**指派的目标 agent 已归档，而当时没有任何地方
能回答"谁能替代它"**。G2 就是这个问题的基础设施。

| 新增 | 作用 |
|---|---|
| `workers/lib/capability-graph.cjs` | **能力图的唯一实现**：能力规范化词表、图构建（provides / costs 边 + confidence）、替代查找（完全/部分两级）、选型打分（可解释加权和）、缺口诊断 |
| `workers/graph/agent-pick.mjs` | CLI：`--need` / `--substitute` / `--gaps` / `--check` / `--json` / `--all` |
| `tests/capability-graph.test.mjs` | 17 项，数据取自**真实档案快照** —— 让"找不到替代者"这类结论可在回归里复现 |

**能力规范化先行**：真实数据第一次跑就断裂 —— 归档的 `coder` 声明 `code`，活动 agent 声明
`coding`，字符串不等导致替代关系找不到人。故引入 canonical 能力 id（`cap:coding`）。
**别名表保守且可审计**：只收明确同义的（`code`/`scripting` → `coding`），**不猜相似度**；
待确认项由 `--gaps` 报出交人决定。

```bash
node workers/graph/agent-pick.mjs --need coding,zh-report   # 按能力需求选型
node workers/graph/agent-pick.mjs --substitute coder        # 谁能在 coder 归档后顶上
node workers/graph/agent-pick.mjs --gaps                    # 能力断层与词表诊断
```

> **⚠️ 首次运行的诊断结论（G2 最重要的产出）**：工具发现**四个能力断层**——
> `research` / `comparative-analysis` / `engineering` / `zh-report` **没有任何活动 agent 提供**，
> 只有已归档的 `coder`/`analyst` 提供。这正是 `t-0003`/`t-0004` 长期卡在 queued 的根因。
> 在此之前，这件事没有任何地方会报出来——它只表现为两个任务永远躺在队列里。
>
> 另报出：8 个活动 agent 的 `model` 全为 `cli-default`（**多模型选型目前缺乏真实数据**）。

### G4 验证器判定层已落地（2026-09-10）

主协议 §6.4 第 6 条早就写明「**不得只信 worker 自测**——Agent 写的测试易与实现共用盲点」，
但当时验证者与拆解者是同一个（都是 Commander），而 Commander 是"想让它过"的一方。
G4 把「谁来验证」变成可判定的问题。

| 新增 | 作用 |
|---|---|
| `workers/lib/verifier.cjs` | **异构验证的唯一实现**：异构性判定、验证者选取、验证任务书生成、结论汇总 |
| `workers/graph/verifier-pick.mjs` | CLI：`--for` / `--brief` / `--status` / `--check` / `--min-level` |
| `verdict.json` 契约 | `bus-contract.validateVerdict`，已接入 applier 写入校验与 `validate-bus` 巡检 |

**异构等级**（由弱到强）：`none`（同一 agent = 自验，**禁止**）< `agent` < `model` < `vendor`。

**一个现实约束与它的应对**：8 个活动 agent 的 `model` 全是 `cli-default` → 「不同模型」这一级
**无法判定**（把 `cli-default` 当真值会产生虚假的异构结论）。但 fleet 有本机 8 个 CLI
**天然来自不同厂商**这一独特条件，故以「agent → 厂商」静态映射作为**不依赖 manifest 数据**的
异构依据。厂商未登记时**保守降级为 agent 级并说明原因，绝不假装异构**。

```bash
node workers/graph/verifier-pick.mjs --for claude     # 挑验证者（按异构强度排序）
node workers/graph/verifier-pick.mjs --brief t-0013 --producer claude   # 生成验证任务书
node workers/graph/verifier-pick.mjs --status t-0013  # 查看验证结论（含驳回历史）
```

实测：`--for claude` 给出 3 个 **vendor 级**候选（bl/alibaba、opencode/sst、pi/earendil-works）；
`--for coder --all` 因 coder 厂商未登记而**保守降级为 agent 级**，并打印原因。

> **边界**：验证器目前是 Commander **可查询**的能力，派单流程尚未强制挂载
> （高风险任务应挂而未挂时无告警）。

### 派单能力闸门已接线（P0，2026-09-11）

G2 判定层此前是「Commander 可查询、派单流程不强制」；现已接入派单器：

| 项 | 内容 |
|---|---|
| 落点 | `workers/dispatch/dispatch-task.ps1` — `Resolve-RequiredCaps` + `Test-CapabilityGate` |
| 触发 | brief 的 `requires: <caps>` 行（ASCII 形式；亦接受 `需要能力：`），或 `-Requires <caps>` 显式传入 |
| 判定 | 复用 `workers/graph/agent-pick.mjs --json`（**不重复实现**，保持口径唯一） |
| 行为 | 目标 agent 不在候选内 → **拒绝派单 exit 2**；无活动提供者 → 拒绝并点名能力断层 |
| 零行为变更 | brief 未声明 `requires`（或为占位符）时**跳过闸门** —— 存量任务行为不变（全仓 `requires` 零声明时已实证） |
| 预检 | 能力闸门同时纳入 `-CheckOnly`，使其成为「能不能派」的完整判定 |

```bash
pwsh -File workers/dispatch/dispatch-task.ps1 -TaskId t-0003 -Agent claude -CheckOnly
#   [budget] 预检通过：当日 cost 0.0000 / 预算 2
#   [capability] 闸门通过：claude 覆盖 coding（score=105，候选 3 个）
```

> **为什么需要它**：`t-0003`/`t-0004` 因 assignee 指向已归档 agent 而积压 24 天，
> 期间**没有任何机器判定会报出来**——只表现为两个任务永远躺在 queued 里。
> 完整对标与取舍见
> [docs/agent-teams-collaboration-gap-2026-09-11.md](docs/agent-teams-collaboration-gap-2026-09-11.md)。
>
> **⚠️ 环境要求**：本脚本用 PS7 语法（`??`）。本机 harness 默认 `pwsh` 实为 **PS 5.1**，
> 必须显式调用 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`（7.6.5）。
>
> **⚠️ 正则陷阱**：`Resolve-RequiredCaps` 用 `[^\S\r\n]*` 而非 `\s*`——
> .NET 的 `\s` **含换行符**，`^\s*` 会吃穿换行锚定到下一行行首，导致永远匹配不到目标行（已实测踩坑）。

### 首次真实派单闭环 + 首个 result.json（2026-09-11）

闸门接线后，积压 24 天的 `t-0003` 作为**首个真实 CLI 派单试水**跑通全链路：

| 项 | 事实 |
|---|---|
| 派单 | `claude -p {prompt} --output-format json`，24 回合，exit 0，**$0.40396**（in 86805 / out 11561 / cache-read 573696） |
| 闸门 | 首次在**真实派单路径**（非 `-CheckOnly`）上生效：`claude 覆盖 coding（score=105，候选 3 个）` |
| 交付物 | 按既定「派单器代写」协议落盘：`result-t-0003.md`（§4.7 六段）+ `agents/claude/notes.md`（10 行） |
| **首个 `result.json`** | G0 节点交付契约**首次真实产出**；`validate-bus` 由 24 → **25 文件 0 错误** |
| 总线 | `bus-apply` 唯一入口一次超步提交：2 条台账补丁 + `task.completed` 事件，版本 **2 → 3** |
| 回归 | `verify-all fleet` **15/15 PASS**；pulse `today_cost=0.403959` 真实计量已入面板 |

**第二个任务 `t-0004` 同法闭环（5 回合，$0.22051）**，产物为 `result-t-0004.md`（15 行索引覆盖
`collective-memory.md` 5/5 主题节）+ 第二个 `result.json`（`validate-bus` → **26 文件 0 错误**），
总线版本 **3 → 4**。至此 **`task-ready --dispatchable` → 可派：无，终态 9 个** ——
**fleet 首次全部任务进入终态，24 天积压清零**；当日实测总成本 **$0.624467**。

> **⚠️ 首个 G0 指纹契约边界（t-0004 撞出）**：`agents/claude/notes.md` 是**被多任务共享、且被设计为
> 持续滚动**的追加文件，把它列进 `result.json` 的 `artifacts[]`（不可变产物指纹）后，
> **每追加一次都会让所有历史任务的指纹失效** —— 真篡改会淹没在预期内的滚动噪声里。
> 处置：把共享滚动文件从 `artifacts[]` **移到 `evidence[]`**（用 `note` 记载沿革），
> `artifacts[]` 只留任务专属、内容稳定的产物。根治选项（notes 按任务分片 / 契约显式豁免）
> 见 [docs/handover-2026-09-11.md](docs/handover-2026-09-11.md) §9.2，**待 Operator 裁决**。

> **⚠️ 口径澄清（worker 实测，勿混为一谈）**：headless 下 worker 无法落盘，但两轮
> `permission_denials` 均为 **0** —— 它们遇到的是 `Bash`/`Glob`/`Grep` 的
> `EPERM: operation not permitted, uv_spawn …`（**进程 spawn 失败**），
> 与 t-0006 的「**Write 被权限栈拒绝**」是两类现象。两者结论一致（交付物必须由派单器代写），
> 但**引用证据时不可互相顶替**。

> **worker 上报的 10 项问题**（t-0003 七项：§4.7 标题分隔符不一致、`validate-bus.mjs` L231 对缺失
> `result.json` 静默放行、派单器无法表达 `blocked` 终态、`notes.md` 口径矛盾、`context.md` 漂移等；
> t-0004 三项：shared 文档真实末次更新为 **2026-08-17** 非 08-16、措辞口径、`collective-memory`
> 格式漂移与策展归属）
> 见 [docs/handover-2026-09-11.md](docs/handover-2026-09-11.md) §8/§9，**语义决策待 Operator 裁决**。

## 统一回归

本线的 F1 总线校验、F3 心跳判活与 G0–G2、G4 各阶段单测已并入仓库级统一回归入口：

> **⚠️ 路径陷阱**：回归入口在**仓库根** `scripts/verify-all.mjs`，**本线内没有** `scripts/` 目录。
> 从 fleet 根调用必须写 `../scripts/verify-all.mjs`；只写 `scripts/verify-all.mjs` 会得到
> 「文件不存在」的误判（t-0003 的 worker 已踩过：它据此错误地断言「实际回归入口是 `npm test`」）。

```bash
node ../scripts/verify-all.mjs fleet
#  1) tests/liveness.test.mjs           F3 心跳判活（7 项）
#  2) tests/bus-contract.test.mjs       G0 契约判定（23 项）
#  3) tests/bus-apply.test.mjs          G0 applier 超步（15 项）
#  4) tests/bus-integration.test.mjs    G0 图校验闭环（13 项，含 validate-bus 新路径）
#  5) tests/task-graph.test.mjs         G1 图与就绪度（13 项，含真实台账等价性）
#  6) task-ready --check                G1 图结构完整性
#  7) tests/capability-graph.test.mjs   G2 能力图（17 项，含真实档案替代查找）
#  8) agent-pick --check                G2 能力图结构完整性
#  9) tests/verifier.test.mjs           G4 异构验证（20 项，含 verdict 契约三条硬约束）
# 10) verifier-pick --check             G4 验证结论契约校验
# 11) node --check fleet-monitor/server.js
# 12) validate-bus                      F1 总线校验 + G0 图/事件/交付物与 G4 验证结论
# 13) publish-pulse                     X1 脉冲发布
# 14) validate-bus --strict             （要求 fleet-pulse.json 存在，故排在第 13 步后）
```

实机联动项（pulse → 桌宠状态映射、pulse 缺失/损坏时静默降级）见
[四线统一回归矩阵](../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md) §4。

> 已知边界：判活针对「status 文件级的陈旧」；desktop 侧另有 pulse 文件级 stale 检查
> （防发布器自身死亡），两层各管一段。worker 的调度级生命周期（超时 / 重试 /
> orphan 回收）尚无自动化覆盖。

## 变更记录

设计决策与协议变更记录在
[docs/multi-agent-cli-orchestrator-design.md](docs/multi-agent-cli-orchestrator-design.md)
头部「变更记录」。
