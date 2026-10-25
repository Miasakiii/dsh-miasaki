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
| `workers/` | 扫描器（discovery：`scan-agents` / **`scan-models`** / **`agent-drift`**）、派单器（dispatch）、总线校验（validate-bus.mjs）、脉冲发布（pulse/publish-pulse.mjs） |
| `fleet-monitor/` | 监控面板（panel.html + server.js + **fence.cjs 三道信任围栏**，本地 HTTP；2026-09-26 起所有路由先过围栏，跨站请求 403 且不带 CORS 头） |
| `plugins/dsh-fleet-panel/` | **DSH 入口插件（2026-10-19，P0）**：会话视图 tab「Fleet」（排在「用量」后，每会话独立实例、**原生渲染**面板）；host 半确保 fleet-monitor 在跑并注册 `/dsh-fleet/*` 代理路由，见 [README](plugins/dsh-fleet-panel/README.md) |
| `schemas/` | 文件总线 JSON Schema（F1 契约） |
| `shared/` | 跨文件共享参考：`collective-memory.md`（经验沉淀）、**`agent-vendors.json`（厂商归属表 —— G4 异构验证的 vendor 级依据；缺省回退内置表并**显式告知**）**、**`agent-adapters.json`（P0-B 只读模型来源适配器：每个 coding agent 的配置文件与模型字段）** |
| `docs/` | 设计文档与调研/校准报告 |
| `design/` | **设计决策与判据**（P0-A 起）：[`2026-10-20-fleet-agent-taxonomy-and-borrowed-designs.md`](design/2026-10-20-fleet-agent-taxonomy-and-borrowed-designs.md)（coding agent 判据 / 三仓库定位 / P0–P2 批次） |
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
| `tests/bus-{contract,apply,integration}.test.mjs` | 59 项测试：契约判定 26 / applier 超步 16 / 图校验闭环 17 |

```bash
node workers/bus/bus-apply.mjs --current-version       # 查当前总线版本
node workers/bus/bus-apply.mjs --patch p.json --check  # 只校验不写入
node workers/bus/bus-apply.mjs --patch p.json          # 提交一个超步
npm test                                               # 本线单测入口（257 例：F3 判活 9 / G0 契约与总线 80（26+27+27）/ G1 图与就绪度 14 / G2 能力图 18 / G4 验证者 36（含 WORK-01 确定性闸 7）/ fleet-monitor 33 / P0-B 配置漂移 14 / P1-A 失败分类 11 / P2-B 合并视图 5 / P2-D 定时任务 7 / P2-E schema 版本 4 / P2-F 选型策略 5 / P2-G profiles 4 / fleet-panel host 10 + client 7）
                                                       # ⚠️ 派单器侧两组（dispatch-state 9 / dispatch-gate 43）**不在** npm test 链上，只在 `verify-all` 的 fleet 类别里跑
                                                       # ⇒ 全线用例 **311 例**（2026-10-22 实测：9+26+27+27+14+18+14+11+5+7+4+5+4+36+33+11+43+10+7），逐文件口径见回归矩阵 §1
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
| `workers/lib/verifier.cjs` | **异构验证的唯一实现**：异构性判定、验证者选取、验证任务书生成、结论汇总、**判官前置确定性闸（WORK-01）** |
| `workers/graph/verifier-pick.mjs` | CLI：`--for` / `--brief` / `--status` / `--check` / `--min-level` / `--gate` |
| `verdict.json` 契约 | `bus-contract.validateVerdict`，已接入 applier 写入校验与 `validate-bus` 巡检 |

**异构等级**（由弱到强）：`none`（同一 agent = 自验，**禁止**）< `agent` < `model` < `vendor`。

**一个现实约束与它的应对**：8 个活动 agent 的 `model` 全是 `cli-default` → 「不同模型」这一级
**无法判定**（把 `cli-default` 当真值会产生虚假的异构结论）。但 fleet 有本机 8 个 CLI
**天然来自不同厂商**这一独特条件，故以「agent → 厂商」静态映射作为**不依赖 manifest 数据**的
异构依据。厂商未登记时**保守降级为 agent 级并说明原因，绝不假装异构**。

```bash
node workers/graph/verifier-pick.mjs --for claude     # 挑验证者（按异构强度排序）
node workers/graph/verifier-pick.mjs --brief t-0013 --producer claude   # 生成验证任务书
node workers/graph/verifier-pick.mjs --brief t-0013 --producer claude --gate "npm test"   # 带判官前置确定性闸（WORK-01）
node workers/graph/verifier-pick.mjs --status t-0013  # 查看验证结论（含驳回历史）
```

实测：`--for claude` 给出 3 个 **vendor 级**候选（bl/alibaba、opencode/sst、pi/earendil-works）；
`--for coder --all` 因 coder 厂商未登记而**保守降级为 agent 级**，并打印原因。

> **已接线（2026-09-30，第三批）**：派单器新增 `Test-VerifierGate` —— **声明了风险**的 brief 必须有
> **可用的**异构验证者，否则拒绝派单；派单结束后生成验证任务书（`tasks/<id>/verify-brief.md`，**不自动派发**）。
> 详见下节「派单验证闸门（G4）已接线」。

#### WORK-01：判官前置的确定性 shell 闸（2026-10-22）

**来源**：外部逆向清单（luanyujia-workbench 09-改造参考 Hermes 05-改造清单 A-9「质量闸：判官前置的
确定性 shell 检查」）与 DSH 0.2.1-rc.2 内核对账的落地结论之一（对账报告见本次会话结论；内核实证：
`dsh-tool-ralph` README 自认 *"Completion is worker self-declaration — there is no independent
evaluator or verifier"*，`verify_on_stop` 全树零命中 —— 内核侧无此闸，fleet 侧地基已在地）。

**机制**（判据照抄其验收命令）：验证任务书的**第 0 步**是一条确定性 shell 命令
（brief 的 `gate:` 行，或 `--gate` 显式传入）—— **exit≠0 ⇒ 判官不被调用**：
不许写 `verdict.json`（pass/reject 都不行）、不许做模型判断，把闸输出的
**尾部 3000 字符**作为续跑提示退回产出者修。exit=0 才继续往下验证。

**三条边界**（各对一种真实失效，`tests/verifier.test.mjs` 各有反例自证）：

| 边界 | 防的是什么 |
|---|---|
| 只认**显式声明**（`gate:` 行 / `--gate`），不猜 | 猜出来的命令「跑错还退出 0」比不跑更危险（虚假放行） |
| `exitCode` 不可信（非整数）时**显式失败**，不给结论 | 判据本身坏了时沉默 = 放行（与 `check-silent-guards` 同口径） |
| 续跑提示**只要尾部**（截断留痕） | 全量回贴会把刚炸过上下文的生产者再次顶爆 |

未声明 `gate:` 时**不静默跳过**（那正是「没有闸」的缺陷形态）：任务书走「未声明」分支，
要求判官自行判断有无可跑的确定性命令、或在 verdict 里写明 `"gate": null` 与理由。
任务书同时内嵌 VER-01 的退出码归因教训（`npm test \| head` 的退出码属于 `head`）——
这条不依赖 VER-01 单独落地，提示词层先生效。

**顺带修掉的跨运行时陷阱**（实测炸过，已写进源码注释）：从 PowerShell/.NET 正则往 Node 抄时
① `(?m)` 顶层内联标志在 JS 里**从来不是合法语法**，必须写成 `/m` flag；
② 字符类 `[:：]` 的 `[:` 开头会被 V8 当 POSIX 类报 `Invalid group`。
（派单器 G4 的 `risk:` 解析是同款写法的 .NET 版，不受影响。）

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
| 闸门顺序 | 档案 → 开关 → 日预算 → **并发上限** → **G1 可派** → G2 能力 → G4 验证 → **任务级 token 预算**（先廉价后昂贵；前者拒了就不跑后者） |
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

### 总控制面板：判定层已上屏（P1，2026-09-30；G4 扩到第四块，2026-10-05）

面板（`fleet-monitor/`）此前只有「在线数 / 任务数 / 成本」，而判定层的事实**一条都没上屏** ——
尽管派单器早已按这些口径在判定。P1 补上三个**只读**端点 + 页面上的一块；
2026-10-05 再补 `verifiers`（第四块「验证者覆盖」）：

| 端点 | 内容 | 口径来源 |
|---|---|---|
| `GET /api/dispatchable` | 可派集 + **不可派原因** + 终态 | `task-ready.mjs --dispatchable --json` |
| `GET /api/gaps` | 能力断层（哪些能力只有归档 agent 提供） | `agent-pick.mjs --gaps --json` |
| `GET /api/events?limit=N` | 机器事件流尾部 | `state/graph-events.jsonl` |
| `GET /api/verifiers` | **验证者候选与覆盖度**（G4，2026-10-05 补）—— 无参 = `--check` 概览、`?for=<producerId>` = 该产出者的候选 | `verifier-pick.mjs` |

**设计要点：spawn 现成 CLI，不重复实现判定** —— 面板显示什么，派单器就按什么判定（口径同源）。
端点全部**只读**、同样过三道信任围栏；判定层不可用时返回 `ok:false` 而**不让面板整页 500**。
判定层 CLI 的**非零退出是正常语义**（无可派任务时 exit 1，stdout 仍是合法 JSON），故先取 stdout 再解析。

```bash
# 实机查看（面板起在本机 127.0.0.1）
curl -s http://127.0.0.1:<port>/api/dispatchable | head -c 200
curl -s http://127.0.0.1:<port>/api/gaps         | head -c 200
curl -s "http://127.0.0.1:<port>/api/events?limit=5"
```

> **已落地（2026-10-05）**：第四块「验证者覆盖」上屏（`GET /api/verifiers`）。**它如实显示前提**：
> 本机活动 agent 的 `manifest.model` 全是 `cli-default` ⇒「模型级异构」在当前数据下**不可判定**，
> 判定层降级到厂商级并留 `notes` —— 面板若不显示这个前提，Operator 会据此误判「验证一定独立」
> （即「假装异构」，与判定层的保守降级相反）。
> 闸门的 `need` 清单同步 **7 → 10 项并加数量自检**（`EXPECTED=10`）：只查「清单项还在」而不查
> 「清单本身是否被改小」时，抽掉两项仍报 PASS —— 这条由负向验证抓出后补上，实测抽项即
> `FAIL fleet: 20/21`、还原 21/21。
>
> **尚未做（P2 候选）**：§8.4 的四条告警规则（心跳丢失 / 预算 ≥80% / 任务硬超时 /
> 开关与进程不一致）—— 面板不告警就只是图表页。**其中「任务硬超时」的判定已落地**
> （2026-10-17：`manifest.limits.timeout_ms` 成为派单器执行点，超时 kill 进程树并记 error），
> 缺的只是**面板告警**这一层。**口径冲突已裁决**（2026-10-05 用户拍板）：
> 「连续失败」按 `events.jsonl` 的事件流计数（N 次内 M 次失败），**不**按 `status.json` 的 error 态
> 连续计数 —— 后者会与事件流形成两份真相。
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
> `artifacts[]` 只留任务专属、内容稳定的产物。**根治裁决（2026-10-05，Operator）**：取
> **契约显式豁免**（`evidence[]` 口径为终态，分片会引入新的任务生命周期，收益不成比例；
> 该口径已实际运转 t-0004 / t-0010 / t-0011 / t-0012 四轮）。背景见
> [docs/handover-2026-09-11.md](docs/handover-2026-09-11.md) §9.2。

> **⚠️ 口径澄清（worker 实测，勿混为一谈）**：headless 下 worker 无法落盘，但两轮
> `permission_denials` 均为 **0** —— 它们遇到的是 `Bash`/`Glob`/`Grep` 的
> `EPERM: operation not permitted, uv_spawn …`（**进程 spawn 失败**），
> 与 t-0006 的「**Write 被权限栈拒绝**」是两类现象。两者结论一致（交付物必须由派单器代写），
> 但**引用证据时不可互相顶替**。

> **worker 上报的 10 项问题**（t-0003 七项：§4.7 标题分隔符不一致、`validate-bus.mjs` L231 对缺失
> `result.json` 静默放行、派单器无法表达 `blocked` 终态、`notes.md` 口径矛盾、`context.md` 漂移等；
> t-0004 三项：shared 文档真实末次更新为 **2026-08-17** 非 08-16、措辞口径、`collective-memory`
> 格式漂移与策展归属）
> 见 [docs/handover-2026-09-11.md](docs/handover-2026-09-11.md) §8/§9。**裁决进度**：P0 各项已随
> B1–B5 与 2026-10-05 写入收敛第二批落地（见上表与设计文档变更记录）；**notes.md 两项同日裁决** ——
> ① 指纹根治取**契约显式豁免**（见上）；② 行数口径取**每次追加后总量 ≤10 行**（追加者负责压缩合并，
> 文件有界；t-0003/t-0004 撞线时的「压缩合并至 10 行」做法即为该口径）。其余建议随各批次行处置。

### DSH 入口：会话视图 tab「Fleet」（P0，2026-10-19；2026-10-20 形态调整）

背景：`fleet-monitor` 面板早已存在（127.0.0.1:39801，P1 判定层上屏 + 三道围栏均已验收），
但它**要手动起服务、也不在日常 DSH 界面里** ⇒ 实际「看不到情况」。P0 只解决「看得见」。
**2026-10-20 按用户反馈两次调整**：① 第一版「侧栏脚部按钮 + 全局浮窗」会挤占侧栏「用量统计」，
改为**会话视图 tab**（`conversation.view`，order 16，排在「用量」之后），每个会话各自一个视图实例；
② 第二版 iframe 内嵌 panel.html **主题不统一、里页无法滚动**，改为**原生渲染**（直接消费同源代理端点、
用官方 `--dsw` 令牌绘制），内容区可滚动；同时修掉判定层四块因「绝对路径未加前缀」而显示
`SyntaxError: Unexpected token 'o'` 的实机缺陷，并移除在桌面壳里无效的「在浏览器打开」按钮
（完整面板地址改为文本给出，浏览器手动打开即可）。

| 项 | 内容 |
|---|---|
| 形态 | `plugins/dsh-fleet-panel`（DSH web 插件）：会话视图 tab「Fleet」（`conversation.view`，order 16，紧跟「用量」15）→ **原生渲染**（统计 6 卡 / 判定层 4 卡 / Agent 卡片，官方令牌，内容区可滚动）；**每会话独立实例**（各自渲染、各自轮询） |
| host 半 | 探测 `127.0.0.1:39801/api/fleet`（应用层判据，不是 TCP 端口通）：在跑就复用，不在跑就隐藏窗口拉起 `fleet-monitor/server.js`；**只有自己拉起的实例才回收**（复用别人的不动） |
| 同源代理 | `prefix /dsh-fleet/api` → `/api/*` 原样代理（fleet / dispatchable / gaps / events / verifiers / toggle 全部走它）；`/dsh-fleet/health` 供探活/重试；`/dsh-fleet/panel` 仍保留（**仅供浏览器嵌入/调试**，已修判定层 4 处绝对路径前缀） |
| 围栏 | 三条路由都过 `lib/fence.js` 三道信任围栏（与六线同构）：跨站 `POST /dsh-fleet/api/toggle/*` 得到 403，不触碰 monitor 写接口 |
| 判据 | 打开会话 → tab 栏「Fleet」在「用量」后 → 内容区出数据且**可滚动**、主题跟随三主题；**切另一个会话同样可独立打开**；关 DSH 后 39801 无残留；monitor 不可用显示可读错误 + 重试；**侧栏脚部不再有 Fleet 按钮** |
| 边界 | **P0 不改数据层、不重写判定**（口径仍由 monitor spawn 现成 CLI）；完整成本报表仍在 fleet-monitor 页（浏览器打开 39801）；**会话级入口 ≠ 会话级数据**——fleet 仍是全局单例，per-session 隔离属独立设计 |

**回归**：`verify-all fleet` **21 → 25 项**（+ host/client 语法 + 两个契约测试，共 **17 例**：
host 10 / client 7）；fleet 全线 **197 → 214 例**。安装方式见
[plugins/dsh-fleet-panel/README.md](plugins/dsh-fleet-panel/README.md)（miasaki profile `link:` + `pnpm install`）。

## 统一回归

本线的 F1 总线校验、F3 心跳判活与 G0–G2、G4 各阶段单测已并入仓库级统一回归入口：

> **⚠️ 路径陷阱**：回归入口在**仓库根** `scripts/verify-all.mjs`，**本线内没有** `scripts/` 目录。
> 从 fleet 根调用必须写 `../scripts/verify-all.mjs`；只写 `scripts/verify-all.mjs` 会得到
> 「文件不存在」的误判（t-0003 的 worker 已踩过：它据此错误地断言「实际回归入口是 `npm test`」）。

```bash
node ../scripts/verify-all.mjs fleet
#  1) tests/liveness.test.mjs             F3 心跳判活（9 项，含首跑口径 isFirstRun）
#  2) tests/bus-contract.test.mjs         G0 契约判定（26 项，含事件类型与新写者枚举）
#  3) tests/bus-apply.test.mjs            G0 applier 超步（27 项）
#  4) tests/bus-integration.test.mjs      G0 图校验闭环（27 项，含 validate-bus 新路径、反向存在性、deliverables 与 observed 契约）
#  5) tests/task-graph.test.mjs           G1 图与就绪度（14 项，含真实台账等价性）
#  6) task-ready --check                  G1 图结构完整性
#  7) tests/capability-graph.test.mjs     G2 能力图（18 项，含真实档案替代查找 + kind 过滤）
#  8) tests/config-drift.test.mjs         P0-B 模型来源探测 + 配置漂移五态（14 项，2026-10-21 新增）
#  8b) tests/failure-classify.test.mjs    P1-A 失败分类八态（11 项，2026-10-21 新增）
#  8c) tests/agent-facts.test.mjs         P2-B manifest/observed 合并视图（5 项，2026-10-21 新增）
#  8d) tests/scheduler.test.mjs           P2-D 定时任务语义（7 项，2026-10-21 新增）
#  8e) tests/schema-version.test.mjs      P2-E schema 版本五态 + 迁移（4 项，2026-10-21 新增）
#  8f) tests/selection-policy.test.mjs     P2-F 选型策略（5 项，2026-10-21 新增）
#  8g) tests/profile.test.mjs              P2-G profiles 快照（4 项，2026-10-21 新增）
#  9) agent-pick --check                  G2 能力图结构完整性
# 10) dispatch 能力闸门接线               G2→派单器 纯文本断言（7 项）
# 11) dispatch 可派闸门接线               G1/G0/G4→派单器 纯文本断言（47 项，2026-09-30 新增/2026-10-21 扩）
# 12) tests/verifier.test.mjs             G4 异构验证（36 项，含 verdict 契约三条硬约束 + 首跑豁免及其三条边界 + WORK-01 确定性闸 7 项）
# 13) verifier-pick --check               G4 验证结论契约校验
# 14) node --check fleet-monitor/server.js
# 15) node --check fleet-monitor/fence.cjs
# 16) tests/fleet-monitor.test.mjs        fleet-monitor 三道信任围栏 + P1 判定层端点 + /api/drift（31 项）
# 17) tests/dispatch-state.test.mjs       K4 派单终态判定（11 项，含两个 ps1 的语法闸门 + 派单执行期间心跳刷新两组）
# 18) tests/dispatch-gate.test.mjs        G1 可派 + G4 验证 + P1-A 失败分类 + P2-A 信任闸门夹具（43 项）
# 19) fleet-monitor 判定层区块 (P1)       panel.html / server.js 的区块与三个端点（10 项，2026-09-30 新增）
# 20) node --check plugins/dsh-fleet-panel/lib/index.js
# 21) node --check plugins/dsh-fleet-panel/lib/client.js
# 22) plugins/dsh-fleet-panel/test/host.test.mjs      DSH 入口插件 host 半（10 项，2026-10-19 新增）
# 23) plugins/dsh-fleet-panel/test/client.test.mjs    DSH 入口插件 client 契约（7 项，2026-10-19 新增，2026-10-20 原生渲染）
# 24) validate-bus                        F1 总线校验 + G0 图/事件/交付物与 G4 验证结论
# 25) publish-pulse                       X1 脉冲发布
# 26) validate-bus --strict               （要求 fleet-pulse.json 存在，故排在第 25 步后）
```

> **口径**：`fleet` 类别 2026-09-30 由 17 项升至 **21 项**，2026-10-19 因 DSH 入口插件再升至 **25 项**
> （+4：host/client 语法各一、两个契约测试文件各一；插件用例 host 10 + client 7 = **17 例**）；
> 2026-10-21 P0-B 新增 `tests/config-drift.test.mjs` → **26 项**；同日 P1-A 新增
> `tests/failure-classify.test.mjs` → **27 项**；P2-B 新增 `tests/agent-facts.test.mjs` → **28 项**；
> P2-D 新增 `tests/scheduler.test.mjs` → **29 项**；P2-E/F/G 新增 `schema-version` / `selection-policy` / `profile`
> 三个测试文件 → **32 项**。
> 全量 **2026-10-05 起为 180 项**、**2026-10-19 实跑 189**、**2026-10-21 实跑 200 项**。真实台账 12 个任务全终态 ⇒ 第 18 项是「放行」分支的唯一覆盖者，不可省。
> **数字口径以实跑为准**：纯文本断言的项数就是脚本里 `need` 数组的长度（现 **47**），夹具例数就是 `node --test` 的 pass 数。
> **本条顺带订正存量失真**（2026-10-21 核对：以实跑为准）：`bus-apply` 16 → **27 例**、
> `bus-integration` 17 → **27 例**、`fleet-monitor` 31 → **33 例**、`task-graph` 13 → **14 例**、`fleet-monitor` 26 → **31 例**、
> `dispatch-gate` 35 → **40 例**、面板区块 7 → **10 项**；旧记「16/17/13/17/26/35」为迁移前口径。

实机联动项（pulse → 桌宠状态映射、pulse 缺失/损坏时静默降级）见
[统一回归矩阵](../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md) §4。

> 已知边界：判活针对「status 文件级的陈旧」；desktop 侧另有 pulse 文件级 stale 检查
> （防发布器自身死亡），两层各管一段。worker 的**调度级生命周期已落地（2026-10-17，
> gap 文档 §4② P1）**：超时 kill 进程树 + 只在超时重试一次（`RetriesOnTimeout`，默认 1）、
> `max_concurrent_tasks` 并发闸门、`max_tokens_per_task` 任务级预算熔断；**仍未做**：
> 进程托管器（跨会话常驻监督）、自动重启、面板告警。

## 变更记录

设计决策与协议变更记录在
[docs/multi-agent-cli-orchestrator-design.md](docs/multi-agent-cli-orchestrator-design.md)
头部「变更记录」。

### 2026-10-22 · 在债 P0 收口：派单执行期间刷新心跳 + WORK-01 判官前置确定性闸

两件事都源自同一场对账：用户分享外部仓库 [mashanglinyu/luanyujia-workbench](https://github.com/mashanglinyu/luanyujia-workbench)
（多场景 AI 工作台方法论；其 09-改造参考含 Hermes 37 篇 + workbudy 19 篇逆向拆解与一份
**44 条改造清单**）⇒ 对清单与 DSH 0.2.1-rc.2 内核 + 本线逐条对账（判定：已做 4 / 部分 8 /
没有 11 / 不适用 6，另点名 lyj 清单 5 处已过时 —— 对账报告见本次会话结论，可入库）。

**① WORK-01 判官前置确定性闸（G4 追加落地）**：验证任务书第 0 步 = brief 的 `gate:` 行或
`--gate` 传入的确定性 shell 命令，**exit≠0 ⇒ 判官不被调用**（不许写 verdict、不许模型判断，
闸输出尾部 3000 字符退回产出者）。三条边界各有反例自证（显式声明不猜 / exitCode 不可信显式
失败 / 续跑提示只要尾部）。内核查证：`dsh-tool-ralph` 自认 *"Completion is worker
self-declaration — there is no independent evaluator or verifier"*、`verify_on_stop` 全树零命中
⇒ 内核无此闸、本线地基已在地 ⇒ 判为清单里性价比第一。详见「G4 验证器判定层」节末小节。

**② 在债 P0：派单执行期间刷新心跳（`dispatch-task.ps1`）**：判活窗口 = 3 × heartbeat_ms
（默认 90s），而 `status.json` 旧行为只在派单开始与终态落账两处各写一次 ⇒ worker 执行
超过 90s 后心跳过龄 ⇒ **G1 对该 agent 的后续派单永久硬拒**（running + 过龄心跳的残留要
有人跑 `-ResetStatus` 才清）—— 能干活的 agent 被自己的上一次派单「僵」住，且不报错
（t-0010/t-0011 已实测的形态）。修法：`Invoke-WorkerProcess` 的等待由整段
`WaitForExit(TimeoutMs)` 改为**轮询切片 + `Update-DispatchHeartbeat`**（每 ≤heartbeat_ms
刷一次）。刷新走**原始文本正则替换**（不经过 ConvertFrom-Json —— 后者会把 UTC 串转成
Local 且数值不变，读改写会静默损坏心跳，与 `Test-HeartbeatFresh` 同款教训）；刷新失败
只静默跳过（心跳是判活输入，不是派单正确性输入）。

**回归**：`tests/dispatch-state.test.mjs` **9 → 11 例**（源码契约防回退 + pwsh 功能探针：
刷新后心跳变新、其他字段一字不变、无 status.json 静默；反向验证：移除循环内调用即精确
转红）；`tests/verifier.test.mjs` **29 → 36 例**；`verify-all fleet` **32/32**；全线 **309 → 311 例**。

**顺带修掉的跨运行时陷阱**（已写进源码注释）：从 PowerShell/.NET 正则往 Node 抄时
① `(?m)` 顶层内联标志在 JS 里**从来不是合法语法**，必须写 `/m` flag；
② 字符类 `[:：]` 的 `[:` 开头会被 V8 当 POSIX 类报 `Invalid group`。

### 2026-10-21 · P2-E/F/G 规划项收口

- **P2-E schema 版本与迁移**：manifest / observed 增 `schema_version`（当前 **2**；缺席按 1 legacy 读）；
  `workers/lib/schema-version.cjs`（五态分类 + 纯函数迁移，future 拒绝降级）；
  `workers/discovery/migrate-schema.mjs`（只标注版本，经 bus-apply；`--check` 不写盘）；
  `validate-bus` 对 future/invalid 版本显式失败。扫描器写 v2。
- **P2-F 可插拔选型策略**：`shared/selection-policy.json`（balanced / cheap / reliable / coverage 四套权重）+
  `workers/lib/selection-policy.cjs`；`agent-pick --strategy/--list-strategies`。策略**只排序**，
  不改变类型/判活/开关等硬判定；未知策略 exit 2（不静默回退默认）。
- **P2-G profiles（整套快照）**：`shared/profiles.json`（balanced / lean / review）+
  `workers/profile/apply-profile.mjs`（`--list` / `--check` / apply）。快照语义 = enabled 集合 + 每 agent
  日预算；经 bus-apply 一次超步只写 `control.enabled` 与 `manifest.limits.budget_per_day`，
  **不碰 observed 发现事实**；未知 profile exit 2、profile 引用未知 agent exit 1（打错字不静默忽略）。
- 测试：`schema-version` 4 / `selection-policy` 5 / `profile` 4；`verify-all fleet` **32/32**、
  fleet 单测 **302 例**、静态全量 **200 项**、`validate-bus` **39 文件** 0 错误。
- 顺延（需 Operator 决策/外部前提，不影响本批）：quota（无诚实读取源）、magpie 可选模型层（需拍板+安装）、
  MCP/Skills/Prompts 集中管理（按需求评估）。

### 2026-10-21 · P2-D 定时任务（无常驻 daemon）+ Schedule tab

- **真相**：新增 `state/schedules.json`（`version/schedules[]`，每项 id / interval_seconds /
  next_fire_at / task{title,assignee,brief?}，interval ≥ 60s）。
- **触发器**：新增 `workers/scheduler/enqueue-due.mjs`（一次性 CLI，**不常驻**）：外部触发器
  （Windows 任务计划 / 手动 / 未来 DSH 定时插件）周期调用；到期 schedule 转成 queued 任务。
- **幂等**：任务行 append 与 schedules 的 `next_fire_at` 推进在**同一次 bus-apply 超步**提交
  （要么都生效要么都不动）；同一时刻重复调用不重复建任务；错过多个窗口**只补一次**。
- 总线契约：白名单新增 `state/schedules.json`；新增事件 `schedule.fired`（author=scheduler）；
  `validate-bus` 校验 schedules（id 形态 / interval / ISO 时间 / task 必填）。
- **UI**：DSH Fleet tab 新增 **Schedule** section（读 `GET /api/schedules`，显示 id / title /
  assignee / interval / next / 已到期标记 + 触发器说明）；现为 6 个 section。
- **回归**：`tests/scheduler.test.mjs` **7 例**（校验收敛 / due 判定 / 补一次 / 幂等 / 坏配置）；
  fleet-monitor **+2 例**（/api/schedules）；`verify-all fleet` 28 → **29/29**；fleet 单测
  280 → **289 例**；静态全量 **197 项**。

### 2026-10-21 · P2-C UI 信息架构收敛

DSH Fleet tab 从「一页长滚动」收敛为五个 section（数据源不变，仍走 fleet-monitor 现成端点）：

- **概览**：统计 6 卡 + 判定层四卡 + **模型来源与漂移（P0-B）** 卡（match / replaced / missing /
  unknown + 适配器数，消费 `GET /api/drift`）。
- **Agents**：Agent 卡片（kind / model 来源 / 开关，写 control.json 经 bus-apply）。
- **Tasks**：可派 / 受阻 / 终态 + 当前执行（task-ready + fleet 同源）。
- **Verifiers**：验证者覆盖（G4 前提）+ drift 卡。
- **Events**：机器事件流尾部（G0）。

刻意**不**放 Schedule 入口（调度器本体属 P2 后续）；无 iframe / 无 window.open / 仍走
`/dsh-fleet/api/*` 同源代理与三道围栏。client 契约测试 7 例（含 5 个 tab 的渲染断言）；
`verify-all fleet` **28/28**、fleet 单测 **280 例**。

### 2026-10-21 · P2-B observed.json 派生分离

扫描/探测事实从 `manifest.json` 拆到 `agents/<id>/observed.json`：manifest 只留 Operator 字段
（name / runtime / model / model_price / metering / metering_source / skills / persona_prompt /
limits / updated_at），observed 承载 present / runtime_kind / kind / cli / capabilities /
capability_boundary / invoke_contract / permissions / model_info / preflight。

- 新增 **`workers/lib/agent-facts.cjs`**：所有消费方读**合并视图**（observed 覆盖 manifest；
  observed 缺席时回退 manifest —— 兼容窗口，`_facts_source` 显式标记来源）。
- 扫描器一次超步写 **17 个补丁**（8 observed + 8 manifest + registry）；`scan-models` 改为写
  observed 的 `model_info`；`agent-pick` / `verifier-pick` / `fleet-monitor` / **派单器
  （Read-AgentFacts）** 全部切换；`validate-bus` 校验 observed 契约（agent_id/observed_at/
  present/kind/cli 等）与合并语义（缺 observed 且 manifest 无 cli ⇒ 显式失败）。
- 派生边界：`agents/registry.json` 仍是**派生快照**（只用于展示/兼容）；真相 = manifest
  （Operator）+ observed（发现事实）。
- 测试：新增 **`tests/agent-facts.test.mjs` 5 例** + bus-integration **+3 例**（拆分契约 /
  observed kind 非法 / 半档案拒绝）；fleet 单测 **280 例**、`verify-all fleet` **28/28**、
  静态全量 **196 项**。

### 2026-10-21 · P2-A 权限校准 + 信任闸门

- `permissions` 从「纸面字段」变成**可判定的安全边界**：新增 `calibration`（verified / declared /
  unknown）与 `evidence`；8 档案迁移 —— **claude 唯一 verified**（t-0006：headless `-p` 下
  Write/Bash 被权限栈拒绝），其余 unknown（未做 headless 权限实测，不冒充）。
- 派单器新增 **`Test-TrustGate`**（档案 → 类型 → **权限** → 开关 → …）：
  ① 矛盾声明拒绝（`mode=workspace-write/danger-full-access` 但 `workspace_write_headless≠yes`；
  `read-only` 但 `workspace_read=no`）；② `mode/calibration=unknown` ⇒ **按只读降级并告警**
  （当前仅 claude 有实测证据，一律 fail-closed 会把 fleet 锁死；这是安全降级、不是静默放行 ——
  告警文案与 `permissions.evidence` 都可审计）。
- `validate-bus` 同步：`calibration` 枚举 + 同一组矛盾声明巡检（写时拦截与事后巡检同一口径）。
- 测试：dispatch-gate **+3**（矛盾拒绝 / unknown 只读降级 / verified read-only 通过）；
  派单接线断言 **42 → 47**。
- **回归**：fleet 单测 269 → **272 例**；`verify-all fleet` **27/27 PASS**；
  `validate-bus` 36 文件 0 错误。
- **顺延**：`observed.json` 派生分离与 UI 收敛为 P2 后续子批（见设计文档 §14）。

### 2026-10-21 · P1-A/P1-B：失败分类 + 交付物声明

- **P1-A 失败分类**：新增 `workers/lib/failure-classify.cjs`（八态：timeout / rate_limit /
  quota / auth / unavailable / context_overflow / request_error / unknown；`retryable`（同 agent
  可重试）与 `suggest_switch`（换异构 agent 可能有帮助）语义分开）+ `workers/dispatch/classify-failure.mjs`
  （PowerShell 调用；只读日志尾部 64 KiB）。派单失败时 `status.json` 增 `failure{kind,retryable,
  suggest_switch,detail}`，`failure.detected` 事件增 `error_kind/retryable/suggest_switch` 字段；
  **退出码与闸门不变**，分类器缺失/不可解析按 unknown 处理、不阻断派单。
- **P1-B 交付物声明**：`result.json` 增可选 `deliverables[]`（`{path,note?}`，工作区内相对路径）
  —— 执行者显式声明**成品清单**；契约见 `bus-contract.cjs` 与 `schemas/result.schema.json`；
  `validate-bus` 逐条核对存在性与工作区包含性（与 `artifacts[]` 的 sha256 指纹互补：
  artifacts 防篡改、deliverables 说明「交付了什么」）。
- **回归**：fleet 单测 252 → **269 例**（+failure-classify 11 / dispatch-gate +3 /
  bus-integration +3）；`verify-all fleet` 26 → **27/27 PASS**；`validate-bus` 36 文件 0 错误。
- **顺延（记录在案，不假装做完）**：权限闸门 `Test-TrustGate`（需先校准 `permissions.mode`，
  否则会误拒全部 agent）；配额三源/分档（无 magpie 时没有诚实读取源，不猜）；定时任务语义
  （需新增总线文件与调度生命周期，独立批次）；UI 收敛（P2）；`observed.json` 派生分离（P2）。

### 2026-10-21 · P0-B 模型真实值 + 只读配置漂移

P0-A 把类型变成字段后，「每个 coding agent 实际用什么模型」仍是 `cli-default` / `unknown`。
本批把模型来源变成**可复核的只读事实**：

- 新增 **`shared/agent-adapters.json`**：每个 coding agent 一条「配置文件 + 模型字段」规则
  （json / jsonc / yaml-regex 三种格式；只读，字段位置按 2026-10-21 本机实测）。
- 新增 **`workers/discovery/scan-models.mjs`**：只读探测后经 `bus-apply` 写 `model_info`
  （value/source/confidence/evidence/provider）。本机落盘结果：claude `step-5-preview[1M]`
  （`settings.env.ANTHROPIC_MODEL`）、pi `deepseek-v4-flash`、mimo `mimo-v2.5-pro`；
  dsh **missing**（`--profile headless` 未建）、gemini **missing**（未安装且无配置）、
  opencode **unknown**（配置存在但无 model 字段）。
- 新增 **`workers/lib/config-drift.cjs` + `workers/discovery/agent-drift.mjs`**：只读巡检五态
  （`match / replaced / missing / parse-error / unknown`）；漂移是**事实不是错误**（`--json` 仍 exit 0），
  `--check` 只在「适配器表坏 / coding-agent 缺适配器」时失败。
- **判定层消费真值**：`verifier-pick` / `agent-pick` 的模型改为优先读 `model_info.value`
  —— G4 的「模型级异构」第一次有真实数据；`model_info` 新增可选 `provider` 并由 `validate-bus` 校验。
- **面板**：`fleet-monitor` 新增 `GET /api/drift`（spawn 现成 `agent-drift --json`，不重复实现探测）。
- **只读纪律**：探测前后用户配置文件字节不变（单测钉住）；`scan-models` 写盘只经 `bus-apply`。
- **回归**：fleet 单测 236 → **252 例**（config-drift 14 / fleet-monitor +2）；`verify-all fleet`
  25 → **26/26 PASS**；`agent-drift --check` 适配器覆盖 6/6；真实巡检
  **match 3 / missing 2 / unknown 1**。
- **顺延 P1**：usage 行富字段（requested/served/effort/tries/err_type）——模型级异构已由
  `model_info` 打通，usage 归因留给预算/成本批次。

### 2026-10-21 · P0-A 类型闸门：worker 池只收 coding-agent

用户 2026-10-20 的纠正「fleet 线，你要区分 CLI 工具和 agent 的区别，我要的是 coding agent」
落地为**机器可读判定 + 派单闸门**（设计文档见
[`design/2026-10-20-fleet-agent-taxonomy-and-borrowed-designs.md`](design/2026-10-20-fleet-agent-taxonomy-and-borrowed-designs.md)，
调研明细在本地 `_refs/research-2026-10-20/` 不入库）：

- **manifest**：新增 `kind`（coding-agent / tool-cli / unknown）、`present`、`runtime_kind`、
  `capabilities[]`、`capability_boundary`（五维三态 yes/no/unknown）、`model_info`
  （value/source/confidence/evidence）、`invoke_contract`、`permissions`；旧字段保留（零行为变更）。
- **扫描器迁移**：8 个档案经 `bus-apply` 一次超步落盘（bus version → 34）——**6 个 coding agent**
  （claude / mimo / pi / dsh / gemini / opencode，后两者当前未安装 ⇒ `present=false`）+
  **2 个工具型 CLI**（bl / agent-browser）。顺带修正 `mimo` 的派单模板为 `mimo run {prompt}`
  （0.1.14 实测为 mimocode，旧模板会进 TUI）；registry 6 个已发现、版本刷新到本机实测。
- **派单器**：新增 `Test-AgentKindGate`（档案 → 类型 → 开关 → …），`tool-cli` / `unknown` /
  缺字段一律 exit 2（fail-closed），`-CheckOnly` 与派单主路径两处调用点。
- **判定层**：`agent-pick --kind`；能力图合并 `capabilities[]`；`verifier-pick` 不把工具型 CLI
  当验证者；`validate-bus` 加 kind 枚举、能力边界自洽与 `model_info` 禁止 `cli-default` 的交叉校验。
- **面板**：`/api/fleet` 与两处 UI 显示 kind、model 来源（unknown 不再冒充 cli-default）。
- **回归**：fleet 单测 **236 例**（bus-integration 18→21 / capability-graph 17→18 /
  dispatch-gate 35→37，其余不变）；`node ../scripts/verify-all.mjs fleet` **25/25 PASS**；
  `validate-bus` 36 文件 0 错误。P0-B（模型真实值 + 只读漂移检测）已随后落地，见上一条。

### 2026-10-20 · DSH 入口第二轮：会话视图 tab + 原生渲染

用户两次反馈：①「入口不要挤占用量统计，放到会话窗用量后面，做成会话级的」；②「界面设计语言
不统一，里页无法滚动」（截图里判定层四块还报 `SyntaxError`、「在浏览器打开」按钮无效）。

- **入口**：`sidebar.footer.action` + `shell.overlay` → 改为 **`conversation.view`**
  （order 16，排在「用量」15 之后，label「Fleet」）；**每会话独立渲染一份视图实例**。
- **渲染**：iframe 嵌 panel.html → **原生渲染**（直接消费 `/dsh-fleet/api/*`，用官方 `--dsw`
  令牌绘制统计 6 卡 / 判定层 4 卡 / Agent 卡片）；内容区 `.fpanel-scroll` 可滚动，主题跟随三主题。
- **判定层修复（实机缺陷）**：panel.html 的判定层四块用绝对路径 `j('/api/…')`，只改 API 基址时
  会打到 DSH 自身的 `/api/*`（返回 `not found` 文本 ⇒ `JSON.parse` 报
  `SyntaxError: Unexpected token 'o'`，四块全显示「不可用」）。现 `rewritePanelHtml` 一并改写为
  `j('/dsh-fleet/api/…')`，host 测试新增 4 端点断言（10 例）。
- **无效按钮**：桌面壳 WebView2 不处理 `window.open`，「在浏览器打开」按钮无效 ⇒ 移除；
  完整面板地址改为文本给出（浏览器手动打开 `http://127.0.0.1:39801/`，含成本报表）。
- **测试**：host 10 + client 7 = **17 例**（client 新增：原生渲染 / 无 iframe / 无 window.open /
  数据源路径 / 滚动容器）；fleet 全线 197 → **214 例**。集成探针实测：五个端点均 200 JSON、
  panel 页 4 处判定层路径全部改写、代理 POST 可用、跨站 403、停止后 39801 无监听。

### 2026-10-19 · DSH 入口插件（P0 首版：侧栏按钮 + 浮窗）

背景：`fleet-monitor` 面板早已存在（P1 判定层上屏 + 三道围栏均已验收），但**要手动起服务、
也不在日常 DSH 界面里** ⇒ 实际「看不到情况」。首版新增 `plugins/dsh-fleet-panel`：
侧栏脚部「Fleet」按钮（`sidebar.footer.action`）→ 全局浮窗（`shell.overlay`）→ iframe 嵌
`/dsh-fleet/panel`；host 半应用层探活/拉起 monitor、同源托管 `/dsh-fleet/panel` 与
`/dsh-fleet/api/*` 代理、三道信任围栏；**不重写判定**（数据仍由 monitor 口径单点给出）。
首版判据：`verify-all fleet` 21 → 25 项、fleet 用例 197 → 211 例（host 9 + client 5）；
集成探针实测真实拉起 monitor、面板改写命中、代理 200、跨站 403、非法路径 404。
该版入口因挤占「用量统计」、iframe 主题不统一/不可滚动，已被 2026-10-20 第二轮取代。

### 2026-10-17 · 调度级生命周期落地（fleet gap 文档 §4② P1）

`manifest.limits` 的 `timeout_ms` / `max_concurrent_tasks` / `max_tokens_per_task` 此前是
**纸面字段**（8 个 agent 档案里四个字段齐全、零消费点）。本批把它们变成执行点，全部走
`dispatch-task.ps1` 单点：

- **硬超时**：`-TimeoutMs`（0 = 取 `manifest.limits.timeout_ms` → brief「超时：M 分钟」→ 不限）。
  执行改用 `ProcessStartInfo.ArgumentList`（PS7/.NET 逐参数传递，prompt 引号不二次切分），
  超时 `Kill(entireProcessTree)`，**只在超时时重试一次**（`-RetriesOnTimeout`，默认 1；
  普通失败不重试，避免掩盖真实错误与重复花钱）。超时对外记 `exit 3`，`status.last_error`
  含「超时（Nms）」，不再永久占住 Commander 会话。
- **并发上限**：`-MaxConcurrent`（0 = 取 `manifest.limits.max_concurrent_tasks`）。该 agent
  已有 `running`/`draining` 且**心跳新鲜**（3×`heartbeat_ms`，与 `liveness.cjs` 同口径）即拒绝
  `exit 2`，并给出 `-ResetStatus` 出口；心跳过龄的僵尸仍交给 G1 判活。
- **任务级 token 预算**：取 brief「预算：N tokens」（优先）> `manifest.limits.max_tokens_per_task`。
  派单前累计该任务历史 usage，达到上限即 `exit 4`（防重试/续跑无限烧钱）；运行后超限只告警
  （钱已花，阻断会掩盖）。
- **已知坑（写进 `Test-HeartbeatFresh` 注释）**：PS7 的 `ConvertFrom-Json` 把
  `2026-10-17T13:08:52Z` 转成 **Kind=Local 且数值不变**的 DateTime，`ToUniversalTime()`
  会再减本地偏移 ⇒ 新鲜心跳被误判 stale；改为从**原始 JSON 文本**用 `DateTimeOffset.Parse` 解析。
- **判据**：`dispatch-gate` 26 → **35 例**（超时 kill / 超时重试成功 / 普通失败不重试 /
  并发拒绝 / 僵尸不由并发拒 / 任务预算熔断 / brief 超时与预算解析 / manifest 优先级），
  fleet 全线 **197 例**；`-CheckOnly` 同步输出生效超时与预算（预检与派单同口径）。

### 2026-09-26 · 死代码清理（零行为变更）

仓库级死代码审计后删掉 `tests/m3-acp/` 下两个**一次性探针脚本**（全仓零引用、无断言、不在 `package.json`
的 test 链、也不在 `scripts/verify-all.mjs` 的 fleet 15 项回归内）：

- `inspect-raw.mjs`（13 行）：查「zstd 帧后是否跟着原始 JSONL 事件」；
- `inspect-session.mjs`（24 行）：流式解压全部 zstd 帧找 usage/token 事件（M3.5 计量接通时用，使命已完成，
  其唯一输入目录现为空）。

同目录的 `plan.md` **保留**（`docs/m35-rc7-regression-smoke-2026-08-17.md`、`state/events.jsonl` 仍引用它，
是 M3 回归结论的可追溯锚点）。验证：`node scripts/verify-all.mjs fleet` **15/15 PASS**（当轮口径；**现为 26/26**）。

> 审计同时确认了本线几处「看起来可疑但必须保留」的结构，**后续清理勿误删**：
> `workers/lib/` 的 5 对同名 `.cjs`/`.mjs`（`.mjs` 是 ESM 转发门面，两侧各有真实消费者）；
> `agents/archive/`（G2 能力断层结论与 G4 选型的**活输入**）；`schemas/*.schema.json`（人类可读契约镜像，
> 权威实现在 `bus-contract.cjs`，`schemas/README.md:21-31` 有此设计的理由）；
> `tasks/t-0003|t-0004/result.json`（G0 机器契约首例，被 `validate-bus.mjs` 校验、被 `bus-apply` 写白名单覆盖）。
> 详见 `dsh-miasaki-shared-docs/repo-review-2026-09-26.md` §七（2026-10-08 移出公开仓 → 本地 `_refs/internal-plans/`）。
