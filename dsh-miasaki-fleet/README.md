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
| `fleet-monitor/` | 监控面板（panel.html + server.js + **fence.cjs 三道信任围栏**，本地 HTTP；2026-09-26 起所有路由先过围栏，跨站请求 403 且不带 CORS 头） |
| `schemas/` | 文件总线 JSON Schema（F1 契约） |
| `shared/` | 跨文件共享参考：`collective-memory.md`（经验沉淀）、**`agent-vendors.json`（厂商归属表 —— G4 异构验证的 vendor 级依据；缺省回退内置表并**显式告知**）** |
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

## 终态契约与自述受阻（2026-09-30，K3/K4/K5）

三个「**失效时不报错、界面看起来正常**」的缺口收口，判据都落在可测的闸门上：

- **终态必须有交付物（K3）**：台账判 `done + accepted` 的任务必须有 `tasks/<id>/result.json`。
  此前 `validate-bus.mjs` 对缺失文件 `continue`（注释还写着「是正常的」）⇒ 静默放行；
  首跑实测 **9 个任务全部已验收、其中 7 个从未产出交付契约** ——「验收通过」当时可以是空的。
  检查的**驱动源是台账**而非 `tasks/` 目录（目录不存在属同族形态，同样要拦）。
  存量 7 份按契约**补记**（evidence 指向原始 `result-*.md` 或派单器代写的 `transcript.md`）。
- **自述受阻必须如实落账（K4）**：派单器不再把 `exit 0` 一律当「健康空闲」——
  worker 自述受阻的载体就是**交付契约本身**（`result.json` 的 `status = blocked | failed`）。
  判定单点在 `workers/dispatch/final-state.ps1`：`status.json` 落 `blocked`（此前恒为 `idle`），
  `last_error` 记 blockers 摘要；退出码语义（0/2/3/4）不变。
- **厂商表真读（K5）**：`shared/agent-vendors.json` 此前**只被文档宣称存在、实际从不曾存在**
  （读不到就静默回退内置表 ⇒ 默认表与实际厂商归属不符时会给出**假异构**结论）。
  现为真实文件，加载逻辑在 `workers/lib/vendors.mjs`，缺失 / 结构非法两条回退路径都留痕。

回归：`tests/bus-integration.test.mjs`（+4 例）、`tests/dispatch-state.test.mjs`（**9 例**，
含两个 PowerShell 脚本的**语法闸门** —— 该侧此前没有任何自动化检查）、`tests/verifier.test.mjs`（+5 例）。

## Graph Engineering（G 系列，**G0–G2、G4 判定层已落地；G1 派单调度、G0 事件留痕与 G4 验证闸门均已接线（2026-09-30）；G3 设计中**）

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
| `tests/bus-{contract,apply,integration}.test.mjs` | 58 项测试：契约判定 26 / applier 超步 15 / 图校验闭环 17 |

```bash
node workers/bus/bus-apply.mjs --current-version       # 查当前总线版本
node workers/bus/bus-apply.mjs --patch p.json --check  # 只校验不写入
node workers/bus/bus-apply.mjs --patch p.json          # 提交一个超步
npm test                                               # 本线单测入口（142 例：F3 判活 9 / G0 契约与总线 58 / G1 图与就绪度 13 / G2 能力图 17 / G4 验证者 29 / fleet-monitor 信任围栏 16）
                                                       # ⚠️ 派单器侧两组（dispatch-state 9 / dispatch-gate 26）**不在** npm test 链上，只在 `verify-all` 的 fleet 类别里跑
                                                       # ⇒ 全线用例 **177 例**（142 + 35），逐文件实测口径见回归矩阵 §1
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

> **已接线（2026-09-30）**：`dispatch-task.ps1` 已把可派判定变成**强制闸门**
> （见下节「派单可派闸门 + 事件留痕已接线」）。
> 本判定层首次运行（2026-09-10）即暴露真实问题：`t-0003`/`t-0004` 仍处 queued，但 assignee
> 指向**已归档**的 `coder`/`analyst`（图就绪、可派被挡）。

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

> **已接线（2026-09-30，第三批）**：派单器新增 `Test-VerifierGate` —— **声明了风险**的 brief 必须有
> **可用的**异构验证者，否则拒绝派单；派单结束后生成验证任务书（`tasks/<id>/verify-brief.md`，**不自动派发**）。
> 详见下节「派单验证闸门（G4）已接线」。

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

### 派单可派闸门 + 事件留痕已接线（2026-09-30，G1/G0）

判定层里「已落地但未接线」的另外两层，现已接进派单器：

| 项 | 内容 |
|---|---|
| 落点 | `workers/dispatch/dispatch-task.ps1` — `Test-DispatchableGate`（G1）+ `Write-BusEvent`（G0） |
| 判定来源 | 复用 `workers/graph/task-ready.mjs --explain <id> --json`（**不重复实现**，与能力闸门同纪律） |
| G1 闸门 | `ready=false` → 打印**全部** reasons → **拒绝派单 exit 2**；并纳入 `-CheckOnly` |
| assignee 一致性 | `-Agent` ≠ 台账 `assignee` → 拒绝，提示「改派走 `reassign` 补丁（带 reason），勿用命令行硬塞」 |
| 闸门顺序 | 档案 → 开关 → 预算 → **G1 可派** → G2 能力（先廉价后昂贵；前者拒了就不跑后者） |
| 事件留痕 | `task.started`（CLI 启动**前**）+ 终态 `task.completed` / `failure.detected`，经 `bus-apply` 唯一入口 |
| 事件不阻断 | applier 报错（如并发超步冲突 exit 3）**只告警、不阻断派单** —— 事件是审计不是闸门 |
| 退出码 | **不动**既有 0/2/3/4；新闸门一律用 2 = 拒绝派单，原因靠打印文案区分 |
| 口径分歧检测 | **开关**与**预算**的判定在派单器（读 `control.json` / `usage.jsonl`）与 `task-graph.cjs` 各有一份（跨语言无法共享）—— 二者不一致时显式打印 `⚠ 口径分歧`，**让漂移可见**而不是静默取其一 |
| 台账坏行拒绝 | 坏行在读取时被静默跳过、而巡检不在派单路径上 ⇒ 判定可能建立在**残缺台账**上（一条被截断的 `update status=done` 会让任务看起来仍可派）。`--explain --json` 现带出 `bus_bad_lines`，**有坏行即拒绝**并指向 `validate-bus` |
| 崩溃残留恢复入口 | `-ResetStatus`：`status.json` 的唯一写者就是派单器，被 Ctrl-C / 断电打断会**永停 running** ⇒ 90s 后判 stale ⇒ 闸门永久硬拒（此前只能手改文件）。该开关删除残留（**写 `stopped` 没用** —— 判活对它同样给 `alive=false`），且**心跳新鲜时拒绝执行**（无法排除真在跑） |
| 终态判定失败不静默回退 | `final-state.ps1` 调用失败时此前回退成 `exitCode==0→idle`，会把 `status=blocked` 的契约记成「健康空闲 + `task.completed`」——现保守记 `error`（判定失败本身就是要人看的异常），且**不复制判定逻辑**（`final-state.ps1` 仍是单点） |

**冷启动降级（实测暴露的真实边界）**：`agents/<id>/status.json` 是**运行时产物**（已 ignore），
从未运行过的 agent 必然没有它 ⇒ `evaluateLiveness(null, …)` 返回 `no-status` / `alive=false`
⇒ 照判会**硬拒首跑**（新 agent 永远派不出去）。故派单器把 `no-status` **降级为告警放行**；
而 `running` 但心跳过龄仍是僵尸，照旧硬拒。两者靠 `--explain --json` 新增的结构化字段
`agent`（`{id, enabled, alive, budgetOk, state}`）区分，**不靠 reasons 的字符串匹配** ——
否则改一个字的文案就会静默换语义（该字段的存在被 `verify-all` 的文本断言钉住）。

> **为什么另加 `$env:BUS_ROOT = $Workspace`**：判定器与 applier 默认按自身文件位置推导 fleet 根，
> 而派单器的 `-Workspace` 可指向别处 ⇒ 会出现「派单器读 A 工作区、判定器读 B 工作区」的静默错位。
> 该对齐同时让夹具测试成为可能（`-Workspace` 指向临时目录即可完全隔离）。

**回归**：`tests/dispatch-gate.test.mjs` **26 例**（夹具覆盖：放行 / 状态非 queued / assignee 不一致 /
依赖未满足 / 开关未关 / 冷启动降级 / 僵尸 / 任务不在台账 / 台账坏行 / `-ResetStatus` **六态**（空操作 ·
清崩溃残留 · 清除后闭环放行 · 心跳新鲜拒绝 · **`error` 不影响派单故拒绝清除** · `stopped` 允许清除）/
G4 验证闸门六态 / 预检不写总线 / `-ShowCommand` 只读 / 命令构造（prompt 引号不外泄 · `cmd:` 成对引号剥离）/
语法闸门）。
真实台账 9 个任务**全终态**（可派 0 个）⇒ 真实数据只能覆盖「拒绝」分支，
**「放行」必须靠夹具** —— 否则「闸门把该派的也拒了」这类缺陷要等下次真派单才暴露。

> **测试基建的一个坑（2026-09-30 实测，已修）**：本文件的 `runScript` 必须把
> `process.execPath` 所在目录**前置进子进程 PATH**。派单器内部用 `& node <判定器>` 调
> task-ready / agent-pick / verifier-pick，按 PATH 解析 node；而本仓钦定的「对齐 CI Node 版本」
> 复跑方式是 `npx -y node@22.19.0 …`，此时 PATH 首位是 npx 的 `.bin` —— 那里**只有
> `node`（sh 脚本）/`node.cmd`/`node.ps1`，没有 `node.exe`**，pwsh 的 `& node` 命中 `node.ps1`、
> 该 shim 又调向无扩展名的 `../node/bin/node`（Windows 下不是可执行文件）⇒ **零输出** ⇒
> 派单器判「判定器输出无法解析」并拒绝派单 ⇒ 全部「放行」用例**假红**（Node 24 直跑时 PATH
> 命中真 `node.exe`，故本机一直绿）。修复后测试**只依赖 Node 版本、不依赖外部 PATH 形态**。

```bash
# 派单前完整预检（G1 可派 + G2 能力；不派单、不写总线）
pwsh -File workers/dispatch/dispatch-task.ps1 -TaskId t-0010 -Agent pi -CheckOnly
#   [budget] 预检通过：当日 cost 0.0000 / 预算 2
#   [gate] 闸门通过：t-0010（queued）图就绪=True，assignee=pi
#   [capability] 闸门通过：pi 覆盖 coding（score=103.34，候选 3 个）
```

**独立复核（t-0010，2026-09-30）**：接线落地后派了一个**真实任务**给异构 agent `pi` ——
任务内容就是「复核本次接线」（对抗立场 / 只读 / 要求每条结论带 `文件:行号`）。
结论 **6 条 findings、无阻断级**，其中三条当批修复：

| finding | 处置 |
|---|---|
| F2 CLI 起不来时 `$LASTEXITCODE` 滞留 0 ⇒ **假成功写进事件流**（G0 接线后不再只是 status.json 的事） | ✅ spawn 前 `Get-Command $exe` 预检，记 127 |
| F3 只钉函数定义 ⇒ 删掉派单**主路径**那处调用，全仓不会变红（行为用例只跑 `-CheckOnly`） | ✅ 断言补两处**调用点**，并改为按文件精确匹配（原先「任一文件含即过」） |
| F4 注释/文档写「不靠 reasons 字符串匹配」，实现却在按文案丢弃（`-match '判活失败'`） | ✅ 改为**如实描述 v1 边界**；两侧文案**成对**钉进闸门，改任一侧即红 |
| **F1** 崩溃残留 `status.json` ⇒ 闸门**永久硬拒**该 agent，且无重置入口 | ✅ **第二批已修**：新增 `-ResetStatus`（心跳新鲜时拒绝执行，防误删在跑的档案）+ 拒绝文案给出可复制的恢复命令 |
| F5「口径分歧」只比 `enabled`（预算那对双实现无比对） | ✅ **第二批已修**：预算也纳入分歧比对 |
| F6 台账坏行静默跳过 | 🔶 **第二批修了一半**：坏行经 `task-ready` 的 `bus_bad_lines` 变成**可拒绝的事实**；判定器 stderr 仍被 `2>$null` 吞（有意保留：输出不可解析本身已判拒绝） |
| **F7**（同一份复核在 Q3 附带指出）`final-state.ps1` 调用失败时静默回退成 `exitCode==0→idle` | ✅ **第二批已修**：保守记 `error`，不静默假装健康 |

完整报告（逐字取自 worker stdout）：`tasks/t-0010/result/result-t-0010.md`。
> 此处刻意用**代码路径**而非 markdown 链接：`repo/md-links` 闸门只把「已入库（git 追踪）」的目标算作可解析，
> 而这些交付物在文档写入时尚未提交 —— 闸门提示的处置就是「目标本就不入库时改成反引号代码路径」。

> **顺带实证的一处空文**：`tasks/<id>/result.json` 本次**首次经 `bus-apply` 唯一入口落盘** ——
> 此前 t-0003 / t-0004 的契约都是**直接写盘**，历史超步的 `paths` 里从未出现过该路径，
> 即 README 自己声明的「写入纪律」在这条路径上一直是空的。现 t-0010 的契约与台账终态**同一超步**提交（v11）。

### 派单验证闸门（G4）已接线（2026-09-30，第三批）

G4 的异构验证者选取此前只是 Commander「**可查询**」，**高风险任务应挂而未挂时没有任何告警**
（判定层落地时自陈的边界）—— 现已接进派单路径：

| 项 | 内容 |
|---|---|
| 风险声明 | brief 的 `risk: <level>` 行（或 `需要验证：<level>`）；亦可 `-Risk` 显式传入 |
| 取值 | `high` ⇒ 最低异构 **vendor**；亦可直接写 `vendor` / `model` / `agent` |
| **未声明** | **跳过闸门**（零行为变更，与 `requires` 的处置同构） |
| **值非法** | **拒绝派单**并要求修正 —— **不猜**；`none`（自验）按非法处理，因为它在 §6.2 是**禁止**项 |
| 闸门判据 | `verifier-pick --for <producer> --min-level <level> --json` 的**可用候选数** |
| 无可用候选 | **拒绝派单 exit 2**（宁可不派，不假装异构）—— 打印候选总数与 warnings |
| 验证任务书 | 声明了风险时，派单结束后生成 `tasks/<id>/verify-brief.md`（**不自动派发**验证任务） |

> **判据为什么不是退出码**：`--for` 的退出码基于 `candidates.length`，而在 `--all`
> （`includeUnavailable`）语义下候选可能全是 `available=false`。故显式看 `available` 字段 ——
> 不依赖「默认路径恰好把不可用者滤掉了」这个隐含前提。

> **✅ 两层判活口径已统一（同日第四批）**：写用例时发现 G1 与 G4 对「首跑」结论**相反** ——
> 派单闸门对「无 `status.json`」**降级放行**（首跑不算僵尸），而验证者选取把 `alive=false`
> 直接判**不可用**（而「无 `status.json`」正是 `alive=false`）⇒ **从未运行过的 agent
> 永远当不了验证者**（与「新 agent 永远派不出去」**同族**，只是换了判定层）。
> 现口径**单点**在 `liveness.cjs` 的 `isFirstRun`，消费方各自引用：`verifier-pick.mjs` 提供
> `firstRun` 标记、`verifier.cjs` 的可用性判据显式含首跑豁免、派单器仍以 `state -eq 'no-status'`
> 消费同一状态字面量。**豁免刻意不外溢**：真僵尸（`unknown`）、开关未开启、`firstRun` 字段缺席
> （保守按非首跑）都照旧不可用 —— 豁免必须是**显式事实**，不能靠默认。
> **实测**：修前 `--for pi --min-level vendor` 给 2 个候选，修后给 **3 个**（`claude` 因首跑标记被正确纳入）。

```bash
# 声明了风险的 brief：预检里就会跑验证闸门（无可用验证者即拒）
pwsh -File workers/dispatch/dispatch-task.ps1 -TaskId t-00xx -Agent pi -CheckOnly
#   [verifier] 闸门通过：pi 的可用验证者 2 个（最低异构 vendor；首选 bl/vendor）
node workers/graph/verifier-pick.mjs --for pi --min-level vendor   # 判定层直接查询（真实实测）
#   ● bl       异构 vendor · 可用
#   ● opencode 异构 vendor · 可用
```

**回归**：`dispatch-gate` 夹具 **17 → 23 例**（G4 六态：未声明跳过 / 有异构 agent 放行 /
候选都不可用拒绝 / vendor 级无候选拒绝 / 非法值拒绝 / `none` 拒绝）；接线断言 **20 → 26 项**
（B5 批次后为 **37 项 / 26 例** —— 见下节「写入收敛」）。

> **验证任务书的形态契约（2026-09-30）**：`tasks/<id>/verify-brief.md` 是**入库**文本 ⇒ 必须
> **LF + 无 BOM + 末行换行**。此前用 `($parsed.brief + "`n") | Set-Content -Encoding UTF8` 写盘 ——
> `-Encoding UTF8` 在 PS7 是 no-BOM（这点没问题），但 **PowerShell 会为它写出的那一行补 `\r\n`**，
> 而内容里其余换行是 `verifier-pick` 给的 LF ⇒ 产物成了「47 个 LF + **1 个 CRLF**」的混合行尾。
> 现改为**按字节写**（`[System.IO.File]::WriteAllText` + `UTF8Encoding($false)` + 显式补末行 `\n`），
> **不依赖任何 cmdlet 的隐式行为**；该实现被接线断言钉住（可派闸门断言 **37 项**）。
> **这条是提交之后才被 `repo/style` 抓到的** —— 因为该闸门当时的扫描集只含「已 `git add` 的文件」，
> 而新写的文件恰是形态问题高发处；同日已把它的口径改为「索引 + 未跟踪未忽略」，
> 使这类问题在**提交前**暴露（详见 `../docs/ENGINEERING.md` 当日「第九件」）。

### 总控制面板：判定层已上屏（P1，2026-09-30）

面板（`fleet-monitor/`）此前只有「在线数 / 任务数 / 成本」，而判定层的事实**一条都没上屏** ——
尽管派单器早已按这些口径在判定。P1 补上三个**只读**端点 + 页面上的一块：

| 端点 | 内容 | 口径来源 |
|---|---|---|
| `GET /api/dispatchable` | 可派集 + **不可派原因** + 终态 | `task-ready.mjs --dispatchable --json` |
| `GET /api/gaps` | 能力断层（哪些能力只有归档 agent 提供） | `agent-pick.mjs --gaps --json` |
| `GET /api/events?limit=N` | 机器事件流尾部 | `state/graph-events.jsonl` |

**设计要点：spawn 现成 CLI，不重复实现判定** —— 面板显示什么，派单器就按什么判定（口径同源）。
端点全部**只读**、同样过三道信任围栏；判定层不可用时返回 `ok:false` 而**不让面板整页 500**。
判定层 CLI 的**非零退出是正常语义**（无可派任务时 exit 1，stdout 仍是合法 JSON），故先取 stdout 再解析。

```bash
# 实机查看（面板起在本机 127.0.0.1）
curl -s http://127.0.0.1:<port>/api/dispatchable | head -c 200
curl -s http://127.0.0.1:<port>/api/gaps         | head -c 200
curl -s "http://127.0.0.1:<port>/api/events?limit=5"
```

> **尚未做（P2 候选）**：`/api/verifiers`（验证者候选）与 §8.4 的四条告警规则
> （心跳丢失 / 预算 ≥80% / 任务硬超时 / 开关与进程不一致）—— 面板不告警就只是图表页。
> 形态决策：**保留独立 server 作数据层**；将来若要进 DSH GUI，加一个 thin 插件壳复用同一份 `/api/*`。

### 写入收敛：真相进总线，派生态豁免（B5，2026-09-30）

此前 README 只有一句笼统的「总线文件只经 `bus-apply.mjs` 写入」，而**实现与声明长期不符**
（`usage.jsonl` 一直直写；`result.json` 直到 t-0010 才首次经唯一入口）。本轮把口径拆成可判定的一条：

| 文件 | 性质 | 处置 |
|---|---|---|
| `state/{tasks,graph-events,ledger}.jsonl` | **真相** | ✅ 经 applier |
| `agents/<id>/usage.jsonl` | **计量原始来源**（§9「成本唯一原始来源」） | ✅ **本批改经 applier**（只允许 `append`） |
| `tasks/<id>/{result,verdict}.json` | 交付 / 验证契约 | ✅ 经 applier |
| `agents/<id>/status.json` | **派生态缓存**（真值在 `result.json` + 事件流） | ⛔ **刻意豁免**（理由写在契约里） |
| `transcript.md` / `logs/` / `verify-brief.md` / `state/fleet-pulse.json` | 派生物 | ⛔ 免登（**指不进总线**；是否入 git 另按档案惯例 —— `tasks/<id>/` 下的 `verify-brief.md` 随任务档案入库，`agents/*/logs/` 与 `transcript.md` 由 `.gitignore` 挡回） |

**失败语义「数据不丢优先」**：applier 失败 → 回退直写 + 告警（行内标 `[BUS_BYPASS]`、落 `logs/dispatch.log`，可 grep）；
但 **partial 失败不回退** —— partial 意味「补丁可能已落盘」，再写一遍就是**成本双计**。

> **✅ 三处输入类直写已收敛（2026-10-05 第二批，v0.28）**：`control.json`（monitor toggle 经 applier，
> 失败 **500/409 不回退** —— 交互式操作可重试，回退 = 复活静默绕行）、`manifest.json` + `registry.json`
> （`scan-agents.ps1` 组 N+1 个 set 补丁**一次超步**提交，失败 exit 1 重跑即重试；顺带修掉 PS 5.1
> `Set-Content` 写 BOM 的隐性缺陷）。白名单 +3 条 `set` 规则；`capability.json` 维持零写者占位登记。
> 实机判据：面板点开关 ⇒ 事件流出现带 `agents/<id>/control.json` 的超步。详见设计文档 v0.28。

**复核驱动的修复**：t-0011 的独立复核指出 **2 条阻断**（失败轮零计量、partial 重计）+ 4 条建议，全部当批处置；
另修两个**同族命令构造缺陷**（prompt 里的引号泄漏成 CLI 参数、`cmd:` 行成对引号未剥离 —— 后者会让命令
静默 `exit 0` 而被记成成功）。新增 `-ShowCommand`（打印将要执行的 argv，**不派单不写盘**）。

### 首次真实派单闭环 + 首个 result.json（2026-09-11）

闸门接线后，积压 24 天的 `t-0003` 作为**首个真实 CLI 派单试水**跑通全链路：

| 项 | 事实 |
|---|---|
| 派单 | `claude -p {prompt} --output-format json`，24 回合，exit 0，**$0.40396**（in 86805 / out 11561 / cache-read 573696） |
| 闸门 | 首次在**真实派单路径**（非 `-CheckOnly`）上生效：`claude 覆盖 coding（score=105，候选 3 个）` |
| 交付物 | 按既定「派单器代写」协议落盘：`result-t-0003.md`（§4.7 六段）+ `agents/claude/notes.md`（10 行） |
| **首个 `result.json`** | G0 节点交付契约**首次真实产出**；`validate-bus` 由 24 → **25 文件 0 错误** |
| 总线 | `bus-apply` 唯一入口一次超步提交：2 条台账补丁 + `task.completed` 事件，版本 **2 → 3** |
| 回归 | `verify-all fleet` **15/15 PASS**（当轮口径；**现为 21/21**，见上方口径块）；pulse `today_cost=0.403959` 真实计量已入面板 |

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
#  1) tests/liveness.test.mjs             F3 心跳判活（9 项，含首跑口径 isFirstRun）
#  2) tests/bus-contract.test.mjs         G0 契约判定（26 项，含事件类型与新写者枚举）
#  3) tests/bus-apply.test.mjs            G0 applier 超步（15 项）
#  4) tests/bus-integration.test.mjs      G0 图校验闭环（17 项，含 validate-bus 新路径与反向存在性）
#  5) tests/task-graph.test.mjs           G1 图与就绪度（13 项，含真实台账等价性）
#  6) task-ready --check                  G1 图结构完整性
#  7) tests/capability-graph.test.mjs     G2 能力图（17 项，含真实档案替代查找）
#  8) agent-pick --check                  G2 能力图结构完整性
#  9) dispatch 能力闸门接线               G2→派单器 纯文本断言（7 项）
# 10) dispatch 可派闸门接线               G1/G0/G4→派单器 纯文本断言（37 项，2026-09-30 新增）
# 11) tests/verifier.test.mjs             G4 异构验证（29 项，含 verdict 契约三条硬约束 + 首跑豁免及其三条边界）
# 12) verifier-pick --check               G4 验证结论契约校验
# 13) node --check fleet-monitor/server.js
# 14) node --check fleet-monitor/fence.cjs
# 15) tests/fleet-monitor.test.mjs        fleet-monitor 三道信任围栏 + P1 判定层端点（16 项）
# 16) tests/dispatch-state.test.mjs       K4 派单终态判定（9 项，含两个 ps1 的语法闸门）
# 17) tests/dispatch-gate.test.mjs        G1 可派 + G4 验证闸门夹具（26 项，2026-09-30 新增）
# 18) fleet-monitor 判定层区块 (P1)       panel.html / server.js 的区块与三个端点（7 项，2026-09-30 新增）
# 19) validate-bus                        F1 总线校验 + G0 图/事件/交付物与 G4 验证结论
# 20) publish-pulse                       X1 脉冲发布
# 21) validate-bus --strict               （要求 fleet-pulse.json 存在，故排在第 20 步后）
```

> **口径**：`fleet` 类别 2026-09-30 由 17 项升至 **21 项**（+ dispatch 可派闸门文本断言、+ dispatch-gate 夹具测试、
> + P1 面板判定层区块断言；全量 **179 项**，**2026-10-05 起为 180 项**）。真实台账 9 个任务全终态 ⇒ 第 17 项是「放行」分支的唯一覆盖者，不可省。
> **数字口径以实跑为准**：纯文本断言的项数就是脚本里 `need` 数组的长度（现 37），夹具例数就是 `node --test` 的 pass 数。

实机联动项（pulse → 桌宠状态映射、pulse 缺失/损坏时静默降级）见
[统一回归矩阵](../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md) §4。

> 已知边界：判活针对「status 文件级的陈旧」；desktop 侧另有 pulse 文件级 stale 检查
> （防发布器自身死亡），两层各管一段。worker 的调度级生命周期（超时 / 重试 /
> orphan 回收）尚无自动化覆盖。

## 变更记录

设计决策与协议变更记录在
[docs/multi-agent-cli-orchestrator-design.md](docs/multi-agent-cli-orchestrator-design.md)
头部「变更记录」。

### 2026-09-26 · 死代码清理（零行为变更）

仓库级死代码审计后删掉 `tests/m3-acp/` 下两个**一次性探针脚本**（全仓零引用、无断言、不在 `package.json`
的 test 链、也不在 `scripts/verify-all.mjs` 的 fleet 15 项回归内）：

- `inspect-raw.mjs`（13 行）：查「zstd 帧后是否跟着原始 JSONL 事件」；
- `inspect-session.mjs`（24 行）：流式解压全部 zstd 帧找 usage/token 事件（M3.5 计量接通时用，使命已完成，
  其唯一输入目录现为空）。

同目录的 `plan.md` **保留**（`docs/m35-rc7-regression-smoke-2026-08-17.md`、`state/events.jsonl` 仍引用它，
是 M3 回归结论的可追溯锚点）。验证：`node scripts/verify-all.mjs fleet` **15/15 PASS**（当轮口径；**现为 21/21**）。

> 审计同时确认了本线几处「看起来可疑但必须保留」的结构，**后续清理勿误删**：
> `workers/lib/` 的 5 对同名 `.cjs`/`.mjs`（`.mjs` 是 ESM 转发门面，两侧各有真实消费者）；
> `agents/archive/`（G2 能力断层结论与 G4 选型的**活输入**）；`schemas/*.schema.json`（人类可读契约镜像，
> 权威实现在 `bus-contract.cjs`，`schemas/README.md:21-31` 有此设计的理由）；
> `tasks/t-0003|t-0004/result.json`（G0 机器契约首例，被 `validate-bus.mjs` 校验、被 `bus-apply` 写白名单覆盖）。
> 详见 [`../dsh-miasaki-shared-docs/repo-review-2026-09-26.md`](../dsh-miasaki-shared-docs/repo-review-2026-09-26.md) §七。
