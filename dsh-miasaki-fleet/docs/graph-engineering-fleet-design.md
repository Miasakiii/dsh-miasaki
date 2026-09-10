# fleet × Graph Engineering 搭建方案（G 系列）

- 版本：v0.6
- 日期：2026-09-10
- 状态：**G0 / G1 判定层 / G2 判定层 / G4 判定层已落地；调度层与 G3 为设计，待评审**
- 隶属：`dsh-miasaki-fleet` 多 Agent CLI 编排线
- 上游调研：[graph-engineering-survey-2026-09-10.md](graph-engineering-survey-2026-09-10.md)（概念框架、社区工程模式、生态全景）
- 主协议：[multi-agent-cli-orchestrator-design.md](multi-agent-cli-orchestrator-design.md) v0.20（本方案是对它的**增量扩展**，不推翻任何既有原则；G0 已并入其 §4.8，G1/G2 已并入其 §5 与 §6.2，G4 已并入其 §6.4）

> 变更记录：
> - v0.1 初稿（2026-09-10）：定位与总体架构、四张图（任务图 G1 / 能力图 G2 / 状态图 G3 / 验证器 G4）的字段级设计、边界与分期。
> - v0.2 依据学术前沿调研（12 篇主线 + 3 篇反证）修订（2026-09-10）：**① 单一写者由"放宽"改为"收紧"**——吸收 PatchBoard 的"受 schema 约束的补丁 + 单一 applier"，新增 §2.2 与 G0 的 `bus-apply.mjs`；**② 新增 §5.2「事件流是唯一真相，其余是派生态」**（The Log is the Agent），并补渐进路径；**③ §5.5 立"不建 LLM 归因器"纪律**（Who&When 实测步级仅 14.2%），引入 MAST 三类 14 种失败模式作为可机器判定维度表；**④ 优先级调整为"契约先于拓扑"**（2502.02533），`result.json` 契约前移到 G0；**⑤ 边界新增"不为能力加 Agent，只为独立验证加"**（Multi-Agent Teams Hold Experts Back / Drop the Hierarchy and Roles）；**⑥ 风险表补 applier 单点、契约敷衍填充、多 Agent 负收益三项**。
> - v0.3 依据框架横向对比补入（2026-09-10，八家框架 + 2026 新候选逐家核对官方文档/PyPI）：得出核心判断——**fleet 缺的不是图抽象，而是四样机制**（fold 纯函数化 / 超步提交语义 / checkpoint 与 interrupt 分层 / 动态边与边契约）；**新增 §5.4「超步提交边界」（解决并发产出导致重放不可复现）+「稳定逻辑 ID 硬约束」**、**§5.6「checkpoint 与事件流分层」+「可落盘中断点」**、§5.3 事件的 `trace_id/span_id` 公共字段；§1.2 补横向对比结论与三条明确不吸收项（CrewAI 隐式图 / GPTSwarm 边优化 / MASFactory Vibe Graphing）。
> - v0.4 **G0 落地**（2026-09-10）：§8 的 G0 由设计转为实现并附验收证据（58 项本线单测 / `verify-all fleet` 8/8 PASS / 真实数据 23 文件 0 错误 / CLI 退出码实测）；主协议升 v0.17 并新增 §4.8 登记总线写入入口；§2.2 的 applier 补充"核心逻辑抽为 `bus-apply-core.cjs`"的实现说明（不调 `process.exit`，可测且可被非 CLI 消费者调用）；G1–G4 状态不变（设计）。
> - v0.4.1 **G1 判定层落地**（2026-09-10）：§8 的 G1 由设计转为**部分实现**——`task-graph.cjs`（就绪度判定唯一实现）+ `task-ready.mjs`（CLI）+ 13 项测试（含**真实台账新旧规则逐字一致**的零行为变更证明）；关键修正：调研发现 **`dispatch-task.ps1` 此前没有任何依赖判定代码**，§5 的规则只靠 Commander 自觉，故 G1 是"新增可执行判定"而非"替换旧逻辑"，并以「`depends_on` 保持旧语义作为回退路径、`graph.consumes` 用严格数据依赖口径」守住零行为变更；主协议升 v0.18（§3 目录 / §5 依赖规则 / §4.8 注释）。
> - v0.5 **G2 判定层落地**（2026-09-10）：§8 的 G2 由设计转为**部分实现**——`capability-graph.cjs`（能力规范化 + 替代查找 + 选型打分 + 缺口诊断）+ `agent-pick.mjs`（CLI）+ 17 项测试（数据取自真实档案快照）；主协议升 v0.19（§6.2 分配流程②③④ 首次有可执行实现）。**首次运行即产出本节最重要的发现**：`research` / `comparative-analysis` / `engineering` / `zh-report` **四个能力断层**（无任何活动 agent 提供），这正是 `t-0003`/`t-0004` 长期卡在 queued 的根因；另报出 8 个活动 agent 的 `model` 全为 `cli-default`（多模型选型缺乏真实数据）。
> - v0.6 **G4 判定层落地**（2026-09-10）：§8 的 G4 由设计转为**部分实现**——`verifier.cjs`（异构判定 / 验证者选取 / 任务书生成 / 结论汇总）+ `verifier-pick.mjs`（CLI）+ 20 项测试；`verdict.json` 契约落地并接入 applier 写入校验与 `validate-bus` 巡检；主协议升 v0.20（§6.4 验收清单第 6 条首次有可执行形态）。**关键应对**：8 个活动 agent 的 `model` 全是 `cli-default`，「不同模型」一级无法判定；改以「agent → 厂商」静态映射作为**不依赖 manifest 数据**的异构依据——这是 G4 在当前数据下仍可落地的原因，厂商未登记时**保守降级并说明原因**，绝不假装异构。

---

## 0. 摘要（七条）

1. **不替换总线，只叠加图。** fleet 的文件总线（进程独立、崩溃可重启、人类可审计、单一写者）是差异化资产，**本方案不引入 LangGraph / AutoGen 等进程内框架**，全部以"协议字段扩展 + 派单器改造 + Commander 行为规范"落地。

2. **GE 的三层与 fleet 已有的三件事一一对应**，本方案只是把它们从"隐式"变"显式"：

   | 综述的 Graph Engineering | fleet 现状 | 本方案 |
   |---|---|---|
   | Task Organization | `tasks.jsonl` 平铺 + `depends_on`（**空置未用**） | **G1 任务图** |
   | Agent Coordination | `manifest.skills` 扁平数组 + §6.3 人工决策表 | **G2 能力图** |
   | Runtime State Management | JSONL 追加日志 + `events.jsonl`（**全是人工里程碑**） | **G3 状态图** |
   | （综述 §1.3② 的人类参与 / 验证责任） | Commander 身兼拆解与验收 | **G4 验证器节点** |

3. **实证前提（2026-09-10 实测）**：`state/tasks.jsonl` 33 行中 `depends_on` 出现 9 次但**全为空数组**——该字段自设计以来从未被使用；`state/events.jsonl` 的 22 类事件**全部是人工里程碑**（`m1_kickoff` / `cli_calibration_batch` …），不是机器事件流。**所以 G1 不是"升级已有功能"，而是让一个已声明但从未生效的字段真正工作；G3 不是"改造事件流"，而是 fleet 实际上还没有机器事件。**

4. **四张图共用一条总线，互相通过 `task_id` 连接**：任务图的节点有能力需求 → 在能力图上求解 assignee → 执行产生机器事件 → 事件支撑失败归因与恢复边界。**任何一张图单独存在都没有价值**，这是本方案与"给 fleet 加个 DAG 字段"的根本区别。

5. **优先级：契约与事件流先于拓扑。** 有一条来自反证的硬约束——[Multi-agent design](https://arxiv.org/abs/2502.02533) 表明**提示/契约优化的收益大于拓扑优化**，优化后的单 Agent 可胜过手搭的多 Agent 系统。因此实施顺序是 **G0（applier + 事件流埋点 + `result.json` 契约）→ G1 任务图 → G2 能力图 → G4 验证器 → G3 失败归因**：**先把"谁写哪个文件、交付物长什么样"收紧，再谈图与调度。**

6. **两处关键设计选择（来自一手调研的修正）**：
   - **单一写者不是放宽而是收紧**——吸收 [PatchBoard](https://arxiv.org/abs/2605.29313) 的"受 schema 约束的补丁 + 单一 applier"，所有角色不再直接写总线，而是提交 `{op, path, value, author, reason, expected_version}`（§2.2）。一次消灭格式写坏、并发覆盖、变更不可追溯三类故障，且**不违反主协议 §1.2**。
   - **事件流是唯一真相，其余是派生态**——吸收 [The Log is the Agent](https://arxiv.org/abs/2605.21997) 的事件溯源内核。fleet 现有 `tasks/ledger/events/status` 四份文件**互为影子真相**，这才是 G3 要治的病（§5.2）。

7. **边界（明确不做）**：不放松"worker 互不可见"（综述亦强调"更多连接不等于更好协作"）；**不为"能力"加 Agent，只为"独立验证"加**——[Multi-Agent Teams Hold Experts Back](https://arxiv.org/abs/2602.01011) 实测团队表现会**低于队内最强专家**，[Drop the Hierarchy and Roles](https://arxiv.org/abs/2603.28990) 显示自组织优于预设层级；不做自动结构演化（综述明确警告"运行时适应 ≠ 持久化系统演化"）；不把开放式探索类任务塞进图（路径需探索时应用 Agent Harness，见调研报告 §3.10）。

---

## 1. 定位：为什么是"叠加"而不是"替换"

### 1.1 三条不动的原则

| 原则 | 出处 | 本方案的态度 |
|---|---|---|
| 文件即总线 | 主协议 §1.1 | **不动**。图结构以文件持久化，不引入运行时内存图 |
| 单一写者 | 主协议 §1.2 | **强化**。每张图各有唯一写者（见 §2.2 写者表） |
| worker 互相不可见 | 主协议 §1.5 | **不动**。图的"边"描述**数据依赖**，不是通信通道 |

### 1.2 为什么不上现成框架

调研报告 §4.1 列的框架（LangGraph / Microsoft Agent Framework / AG2 / CrewAI / Google ADK / GPTSwarm / MASFactory / Apache Burr）共同点是**进程内库**：图与状态活在调用方的内存里，崩溃即丢、外部不可读、人类无法在运行中介入。fleet 的核心卖点恰恰相反。

**但横向对比后有一个更重要的判断**（详见调研报告 §4.1b 的对比表）：

> **fleet 已经具备图编排最贵的三样东西——持久事件日志、单一写者（天然无数据竞争）、可物化状态。缺的不是图抽象，而是四样机制。**

| # | 缺的机制 | 最接近的先例 | 落入本方案 |
|---|---|---|---|
| 1 | **fold 纯函数化**（状态 = `reduce(fold, 事件流)`） | AG2 `ChannelAdapter.fold` + `Hub.hydrate()` 重放 WAL | §5.2 / §5.4 |
| 2 | **超步提交语义**（收集 → 确定性排序 → 合并 → 提交 → 版本号） | LangGraph 的 Pregel/BSP 超步、MS Agent Framework 的 superstep | §5.4 |
| 3 | **checkpoint 与 interrupt 分层** | LangGraph `interrupt()`、MS AF `CheckpointStorage`/`RequestPort`、ADK `NodeInterruptedError` | §5.6 |
| 4 | **动态边与类型化边契约** | LangGraph `Send`、ADK `Event(route=…)` + `input_schema`/`output_schema` | §3.5 / §3.6 |

**补上这四样，fleet 的协调层就等价于一个自研的、面向异构 CLI 的 Pregel runtime**——而且因为它是文件持久化的，**比任何进程内先例都更耐崩溃**。

**明确不吸收的三项**（附理由）：

| 不吸收 | 理由 |
|---|---|
| CrewAI 式**隐式事件图** | 与 fleet 的显式总线重叠，且"拓扑靠装饰器推导"比显式更难调试 |
| GPTSwarm 的**边优化**（拓扑自优化） | 项目停滞 7 个月、无持久化；在 CLI 成本模型下收益不明 |
| MASFactory 的 **Vibe Graphing** | 想法好，但上游无 checkpoint/resume；**适合作为独立的上游 builder**（把自然语言需求编译成 fleet 的图规格 JSON，再由 fleet 执行），不进 fleet 本体 |

因此本方案只**借用机制**，不借用运行时：借 `Send` → 动态扇出（§3.5）；借节点契约 → `result.json`（§3.6）；借验证器节点 → G4（§6）；借能力图 → G2（§4）；借 fold/超步/checkpoint/interrupt → G3（§5）。

---

## 2. 总体架构

### 2.1 四张图叠在一条总线上

```
┌──────────────────────────────────────────────────────────────┐
│  Commander（大会话）                                          │
│   · G1 任务图：拆解 → 扇出 → 汇合 → 验收                       │
│   · 在 G2 能力图上求解 assignee                               │
└───────┬──────────────────────────────────────────────────────┘
        │ 读图/写图（单一写者）
┌───────▼──────────────────────────────────────────────────────┐
│  文件总线（不动）                                             │
│                                                              │
│  G1 任务图      state/tasks.jsonl      ← Commander 写         │
│                 tasks/<id>/graph.json  （可选，单任务图快照）  │
│  G2 能力图      agents/<id>/capability.json ← 扫描器+回填器写  │
│  G3 状态图      state/graph-events.jsonl ← 机器写（多写者分域）│
│  G4 验证        tasks/<id>/verdict.json ← 验证器 agent 写      │
│                                                              │
│  （原有）state/ledger.jsonl · state/events.jsonl · status.json│
└───────┬──────────────────────────────────────────────────────┘
        │ spawn / 派单（不动）
┌───────▼──────────────────────────────────────────────────────┐
│  worker CLI：claude · opencode · pi · bl · gemini · …          │
│  产出 result.json（G1 契约）+ result-<id>.md（人类可读）        │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 写者表与"补丁 + 单一 applier"

主协议 §1.2 的**单一写者原则不动摇**。但本方案需要解决一个新问题：G3 的机器事件流由**多个角色**产生（Commander 派单、派单器执行、验证器出 verdict）。

**做法不是放宽单一写者，而是把它收紧成一个明确入口**——吸收 [PatchBoard](https://arxiv.org/abs/2605.29313) 的"Agent 不直接写状态、提交受 schema 约束的补丁"机制：

```
任何角色都不再直接写总线文件，而是向唯一 applier 提交补丁：

  { "op": "append" | "set" | "merge",
    "path": "state/tasks.jsonl",          // 目标
    "value": { … },                        // 补丁内容
    "author": "commander" | "dispatcher" | "verifier:<agent-id>",
    "reason": "assign t-0012 → scout",     // 人类可读的变更理由
    "expected_version": 17 }               // 乐观并发（MemTX 轻量版）

applier（workers/bus/bus-apply.mjs，唯一总线写入入口）：
  ① 校验 value 是否符合该 path 的 JSON Schema
  ② 校验 expected_version 是否等于当前版本（不等 → 拒绝并返回最新值，调用方重读重试）
  ③ 原子写目标文件
  ④ 追加一条 graph-events.jsonl 事件（含 author / reason / diff 摘要）
```

| 文件 | 写入路径 | 说明 |
|---|---|---|
| `state/tasks.jsonl` | Commander → applier | `graph` 字段随现有 `create/assign/…` 一起提交 |
| `agents/<id>/capability.json` | 扫描器（结构）+ 回填器（confidence）→ applier | 两者都走同一入口，不直接落盘 |
| `state/graph-events.jsonl` | **仅 applier** | 所有事件由 applier 代写，**它自己是唯一写者** |
| `tasks/<id>/verdict.json` | 验证器 → applier | 与 `result/` 同级的交付区 |
| `tasks/<id>/result.json` | worker / 代写派单器 → applier | 与 `result-<id>.md` 并列 |

**这一改动一次消灭三类高频故障**：格式写坏（schema 校验在前）、并发覆盖（expected_version CAS）、变更不可追溯（每条补丁带 author + reason）。

**与现有工具的关系**：
- applier 提供 **CLI 形态**（`node workers/bus/bus-apply.mjs --patch patch.json`），PowerShell 派单器调用它，**不引入常驻进程**；
- 现有 `models/validate-bus.mjs`（F1）从"**事后**全量校验"升级为"**写入时**校验 + 事后抽检"，两者并存——事前拦截比事后发现便宜得多。

> **为什么不直接放宽为多写者追加？** 追加式 JSONL 确实能靠 O_APPEND 原子性支撑多写者，但那样只能保证**行不交错**，不能保证① 内容合 schema、② 不覆盖他人刚写的版本、③ 变更有理由可查。fleet 的定位是"可审计"，用 applier 换这三项保证是划算的。

### 2.3 四张图如何连接

```
       G2 能力图
       （capability）
            ▲ 查询：谁能做 cap:X？
            │
  G1 任务图 ─┼──────────────────────────────► 派单器
  （task）   │  assignee 解出
            │                                  │
            │                                  ▼
            │                          执行 → 写 G3 事件
            ▼                                  │
       G4 验证器 ◄──── 产出物 + 验收标准 ───────┘
            │
            └─ verdict → 回填 G2 的 confidence → 影响 G1 下一次选型
```

**闭环**：G1 选人依赖 G2 → G2 的 confidence 由 G4 的 verdict 回填 → G4 由 G1 派出。**这是"系统演化"的最小可运行闭环，也是本方案与静态编排的本质区别。**

---

## 3. G1：任务图（Task Graph）

### 3.1 问题陈述

主协议 §5 现状规则：

> 依赖（v1）：`depends_on` 中的任务全部 `done` 后，Commander 才允许 assign。

两个缺陷：

1. **只表达时序，不表达数据**——按调研报告 §3.1 的"边真实性检验"（*下一步是否真的读取上一步的输出？*），凡是"不读上游输出"的依赖都**不该等**，当前规则把可并行的任务串行化了。
2. **没有父子/分组结构**——扇出的 N 个子任务无法表达"我们同属一个钻石图"，也无法表达"全部子任务完成后汇合"。

### 3.2 数据结构（`tasks.jsonl` 的 task 对象扩展）

```json
{
  "op": "create",
  "task": {
    "id": "t-0012",
    "title": "整理 X 平台评价",
    "assignee": "scout",
    "status": "queued",
    "created_at": "2026-09-10T09:00:00Z",
    "updated_at": "2026-09-10T09:00:00Z",
    "retries": 0, "tokens": 0, "cost": 0.0, "steps": 0, "takeovers": 0,
    "depends_on": [],
    "waiting_for": null,

    "graph": {
      "node_kind": "work",
      "group": "g-0003",
      "parent": "t-0009",
      "consumes": [
        { "task": "t-0010", "artifact": "result.json", "required": true }
      ],
      "produces": { "artifact": "result.json", "schema": "result.schema.json" }
    }
  }
}
```

**向后兼容**：无 `graph` 字段的旧记录一律按 `node_kind: "work"`、无分组、无 consumes 处理——**现有 33 行台账无需迁移**。

#### 字段语义

| 字段 | 取值 | 语义 |
|---|---|---|
| `node_kind` | `work` \| `fan_out` \| `reduce` \| `verify` \| `gate` | 节点在图中的角色 |
| `group` | `g-XXXX` | 所属钻石图。**同一 group 内的 `work` 节点全部 `accepted` 后，`reduce` 节点就绪** |
| `parent` | `task_id` | 扇出来源（`fan_out` 节点的 id），用于"最早无效状态"的逆向回溯 |
| `consumes[]` | `{task, artifact, required}` | **数据依赖**：本任务真的要读谁的哪个产物 |
| `produces` | `{artifact, schema}` | 本任务的产出契约（供下游 `consumes` 引用、供校验） |

#### `depends_on` 与 `consumes` 的关系（重要）

- **`depends_on` 语义收紧为"仅时序偏好"**，就绪判定**不再使用**它；
- **`consumes` 是唯一的数据依赖依据**，它同时声明了"读谁的输出"和"读哪个文件"；
- 迁移期两者可并存，校验器在发现 `depends_on` 非空但 `consumes` 为空时给出 **warning**（提示可能漏声明数据依赖）。

### 3.3 边的两种语义对照

| | 旧 `depends_on` | 新 `consumes` |
|---|---|---|
| 表达 | "先做 A 再做 B" | "B 读 A 的 `result.json`" |
| 判定 | 全部 `done` | 上游 `accepted` **且产物文件存在且 schema 校验通过** |
| 可并行 | 否 | **是**（无 `consumes` 边 = 无依赖 = 可并行） |
| 可机械校验 | 否 | **是**（声明了 `consumes` 却读不到文件 → 校验期报错） |
| 命名依据 | 顺序 | **数据类型**（调研报告 §3.3：边应按数据命名） |

### 3.4 就绪度算法（替换主协议 §5 的依赖规则）

```
ready(t, now) :=
     status(t) == "queued"
  ∧  ∀ c ∈ t.graph.consumes :
        status(c.task) == "done" ∧ accepted(c.task) == true
      ∧ exists(artifact_path(c.task, c.artifact))
      ∧ (c.required == false ∨ schema_ok(c.artifact))
  ∧  assignee(t) != null ∧ control(assignee(t)).enabled == true
  ∧  liveness(assignee(t)) != "unknown"            // 复用 F3 判活
  ∧  budget_ok(assignee(t))                        // 复用 §7.0 预算预检
```

**注意末两项**：就绪不只是图的问题，还必须叠加 fleet 的现实约束（开关、判活、预算）。这正是"图叠加在总线上"的意义——**图说"可以做了"，fleet 说"现在能不能做"**。

#### 钻石图完整示例

```
t-0009 (fan_out, group=g-0003, 拆解任务)
   ├─→ t-0010 (work, consumes: 无)               ─┐
   ├─→ t-0011 (work, consumes: 无)               ─┼─→ t-0013 (reduce, group=g-0003,
   └─→ t-0012 (work, consumes: 无)               ─┘       consumes: t-0010/11/12 的 result.json)
                                                          → t-0014 (verify, consumes: t-0013/result.json)
```

- `t-0010/11/12` **三方并行**（彼此无 `consumes` 边）——这是旧规则做不到的；
- `t-0013` 在三者全部 `accepted` 且产物齐备后才就绪；
- `t-0014` 是 G4 的验证器节点，**必须由与 `t-0013` 不同厂商的 agent 执行**（§6.2）。

### 3.5 动态扇出（运行时才知道 N）

调研报告 §3.9 记录的 LangGraph 关键机制：**有时节点在运行时才知道要创建多少工作**（map-reduce 的 N 取决于输入），LangGraph 用 `Send` 在运行时动态路由。

**fleet 的对应实现**（无需新机制，用现有 `create` 操作即可）：

```
① Commander 创建 t-0009 (node_kind: "fan_out", produces: {artifact: "plan.json"})
② t-0009 执行完毕 → plan.json 里声明 N 个待办项
③ Commander 读 plan.json，据 N 生成 N 条 `create` 记录：
     t-0010 … t-001(N+9)，均带 group=g-0003 / parent=t-0009
④ Commander 预创建 t-00XX (reduce, group=g-0003) —— 此时据 N 写定 consumes 列表
⑤ 就绪度算法自然地把 N 个子任务并行放行
```

**关键点**：`reduce` 节点的 `consumes` 列表在 ③ 时动态写定——**这就是"动态转换"**，且因为是文件持久化的，**崩溃重启后依然成立**（进程内框架需要 checkpoint 才能做到这一点，文件总线天然具备）。

### 3.6 节点契约：`result.json`

调研报告 §3.2 的"节点要有契约"在 fleet 的落点：**在人类可读的 `result-<id>.md` 之外，增加机器可读的 `result.json`**。

```json
{
  "task_id": "t-0012",
  "status": "completed",
  "conclusion": "一句话可被下游直接引用或转交的结论",
  "completeness": { "done": ["项A","项B"], "missing": [] },
  "evidence": [
    { "type": "url", "ref": "https://…", "note": "…" },
    { "type": "file", "ref": "artifacts/xxx.csv", "sha256": "…" }
  ],
  "blockers": [],
  "broadcast": "可选：值得写入 collective-memory 的发现",
  "artifacts": [ { "path": "artifacts/xxx.csv", "bytes": 12345, "sha256": "…" } ]
}
```

- `result-<id>.md` **保持不变**（人类可读、审计用），`result.json` 是**增量**；
- 派单器在交付阶段做 **schema 校验**；校验失败 → 按调研报告 §3.2 的做法**自动重试一次**（带校验错误信息重投），仍失败则 `reopen`；
- `evidence` 让 §6.4 验收清单第 2 条"验收标准逐条核对"的部分工作可以自动预检；
- `artifacts[].sha256` 让 §3.4 的 `consumes` 校验能发现"上游产物被事后篡改"。

### 3.7 schema 与校验扩展

- 新增 `schemas/graph.schema.json`（`graph` 子对象）与 `schemas/result.schema.json`（节点产出契约）；
- `schemas/tasks.schema.json` 增加对 `graph` 的可选引用；
- 全部并入现有 `workers/validate-bus.mjs`（F1），**新增结构性校验**：
  1. `consumes[].task` 必须指向存在的 task；
  2. `group` 内必须有且仅有一个 `reduce` 节点（钻石图完整性）；
  3. `parent` 必须指向 `node_kind == "fan_out"` 的 task；
  4. `consumes` 与 `depends_on` 不一致时给 warning（迁移期）。

---

## 4. G2：能力图（Capability Graph）

### 4.1 问题陈述

现状 `manifest.skills: ["web-research", "summarize", "zh-report"]` 是**扁平字符串数组**，只能回答"会什么"。综述 §1.3② 要求能力边至少记录**能力归属、资源访问、权限、可靠性**；§1.4 更把"图原生能力底座"列为第一挑战：

> 随着能力数量增长，系统选择某项能力时，不仅要看它"能不能做"，还要考虑它依赖什么、能否被替代、如何组合、需要哪些权限，以及在当前运行条件下是否适用。

**fleet 的当务之急**：`model` / `model_price` / `skills` 三个字段各自独立，无法回答"要图片能力 + 预算 0.5 元 + 中文报告，谁最合适"。

### 4.2 数据结构（`agents/<id>/capability.json`）

```json
{
  "version": 1,
  "agent_id": "scout",
  "generated_at": "2026-09-10T09:00:00Z",
  "nodes": [
    { "id": "agent:scout",            "kind": "agent" },
    { "id": "cap:web-research",       "kind": "skill" },
    { "id": "cap:zh-report",          "kind": "skill" },
    { "id": "mod:image-input",        "kind": "modality" },
    { "id": "tool:web_search",        "kind": "tool" },
    { "id": "res:network",            "kind": "resource" },
    { "id": "model:deepseek-v4-flash","kind": "model" }
  ],
  "edges": [
    { "from": "model:deepseek-v4-flash", "to": "mod:image-input", "type": "provides",
      "confidence": 1.0, "source": "llm.resolveModelInfo" },
    { "from": "agent:scout", "to": "cap:web-research", "type": "provides",
      "confidence": 0.91, "evidence": ["t-0003", "t-0007"], "updated_at": "2026-09-10T…" },
    { "from": "agent:scout", "to": "res:network", "type": "requires", "scope": "https" },
    { "from": "agent:scout", "to": "agent:opencode", "type": "substitutable_by", "quality_delta": -0.1 },
    { "from": "agent:scout", "to": "ledger", "type": "costs", "usd_per_1k_input": 0.0008 }
  ]
}
```

**与 `manifest.json` 的分工**：`manifest` 保留为**人类编辑的静态档案**（人设、限额、开关联动），`capability.json` 是**机器生成的派生视图**（扫描器写结构、回填器写 confidence）。两者同目录，互不覆盖。

### 4.3 边的类型清单

| 边类型 | 方向 | 语义 | 用途 |
|---|---|---|---|
| `provides` | agent/model → 能力 | 提供某能力（带 confidence） | **路由**的输入 |
| `requires` | agent → 资源 | 依赖网络/凭据/目录 | **预检**（对应 manifest 的 `preflight`） |
| `substitutable_by` | agent → agent | 可被替代（带 quality_delta） | **缺能力替代**（替换 §6.2④ 的"暂存"） |
| `costs` | agent → ledger | 单位成本 | 预算求解 |
| `conflicts` | agent ↔ agent | 互斥（如共用同一 API key 触发限流） | 并发派单前检查 |
| `verified_by`（G4） | 产出 agent → 验证 agent | **禁止自验**的约束边 | 验证器选取 |

> `conflicts` 边是 fleet 的现实需求：本机多个 CLI 可能共用同一个 `DEEPSEEK_API_KEY` 或同一 provider 的限流池。主协议 §6.3 决策表第 3 条只看 `status.json` 的 idle，**看不到"两个 agent 同时跑会互相限流"**。

### 4.4 confidence 的自动回填

**这是能力图"活起来"的关键**：综述 §1.3④ 要求"执行结果还应更新能力的可靠性与适用范围"。

- **来源**：`tasks.jsonl` 里该 agent 的历史任务（`accepted` / `reopened` / `failed` / `retries`）；
- **公式（v1，简单且可解释）**：

```
confidence(agent, cap) = (accepted + α) / (accepted + reopened + failed + α + β)
    α = 1, β = 1                      # Laplace 平滑，无历史时返回 0.5
仅统计 required(task) 包含 cap 的任务
```

- **回填时机**：**复用主协议 §6.4 验收清单第 5 条**（验收通过后回填 `tokens/cost/steps/takeovers`）——**同一次动作顺带更新 capability.json**，不新增流程；
- **证据留痕**：每次回填把 `task_id` 追加进 `evidence[]`，**confidence 的每个数值都可追溯到具体任务**（这是可审计性与综述 §1.3③"状态变化的内容、来源、版本"要求的统一）。

### 4.5 选型算法（替换主协议 §6.3 决策表）

现状 §6.3 是**五条按优先级的人工依据表**（技能匹配 → 模型能力/成本 → 当前负载 → 历史表现 → 预算余量）。在能力图上的对应形式：

```
score(agent, task) :=
      Σ_{c ∈ required_caps(task)} w_c · provides(agent, c).confidence
    − λ_cost   · normalized_cost(agent, est_tokens(task))
    − λ_load   · load(agent)                          # 来自 status.json
    − λ_retry  · retry_rate(agent)                    # 来自 tasks.jsonl
    − ∞        · [∃ conflicts 边且对方正在运行]
    − ∞        · [budget_exceeded(agent) ∨ ¬enabled(agent) ∨ liveness = unknown]
```

- **保留人工兜底**：§6.3 的规则降级为"图求解失败时的 fallback"，**不是删除**；
- **§6.2④ 的改进**：任务暂存前，先在能力图上查 `substitutable_by`——**有替代者就不该暂存**，而是派给替代者并在 brief 里声明 `quality_delta` 与风险（沿用 §6.2⑤ 的"显式声明降级原因"纪律）；
- **多模型维度的落点**：能力图让调研报告 §3.7 的三种多模型模式（分层路由 / 并行聚合 / 异构验证）从"人工判断"变成"图上可求解"——这是"多模型协作"真正的工程形态。

### 4.6 与 `dual-model` 线的能力真值源统一

`dsh-miasaki-dual-model` 线（会话内主+辅模型路由）已把 `llm.resolveModelInfo(provider, model).inputModalities` 确立为**图片能力的权威真值源**，并明确"unknown ≠ negative capability"（未声明一律放行）。

**fleet 沿用同一口径**：`mod:image-input` 的 `provides` 边由该真值源生成，confidence 取 1.0 并标注 `source: "llm.resolveModelInfo"`；未声明的模型**不产生负边**，而是缺边（求解时按"未知"处理并允许降级，与 dual-model 线一致）。

---

## 5. G3：状态图与机器事件流

### 5.1 问题陈述：四份文件互为影子真相

`state/events.jsonl` 现有 22 类事件**全部是人工里程碑**（`m1_kickoff`、`m2_panel_deployed`、`cli_calibration_batch`、`dsh_upgrade_rc7` …）。它是一份**项目日志**，不是**机器事件流**：

- 无法重放出系统状态；
- 无法自动定位失败；
- 无法证明"边被真实穿越过"（`consumes` 只是**声明**）。

但更深的问题不是"events.jsonl 不够机器化"，而是：**fleet 现在有四份文件各自记录同一件事的不同侧面**——`tasks.jsonl` 记任务状态、`status.json` 记 agent 状态、`ledger.jsonl` 记成本、`events.jsonl` 记里程碑。它们**互为影子真相**：谁对谁错没有仲裁者，一旦不一致（例如 `tasks.jsonl` 说 `running` 而 `status.json` 已 `idle`），只能靠人去比对。

这正是 [The Log is the Agent: Event-Sourced Reactive Graphs](https://arxiv.org/abs/2605.21997) 要治的病。**本方案把它列为 G3 的核心判断，而不是把 G3 降格为"加一份新日志"。**

### 5.2 核心判断：事件流是唯一真相，其余是派生态 ★

> **追加式事件日志即唯一真相；状态 = `fold(日志)` 的派生态。**

- **真相层**：`state/graph-events.jsonl`——只追加、永不改写、只由 applier 写（§2.2）；
- **派生层**：`tasks.jsonl` / `ledger.jsonl` / `status.json` 都是**可以从事件流重建**的物化视图；
- **一致性不变式**：`fold(graph-events) == 物化视图`，不一致即为总线损坏信号（可自动化校验，见 §5.4）。

这条判断的**直接收益**（也是它排在 G1 之前做 G0 埋点的原因）：

| 有了唯一真相 | 没有它 |
|---|---|
| 失败可以沿事件链回溯到最早的无效状态 | 只能靠 LLM 读全文猜（**实测准确率仅 ~14%**，见 §5.5） |
| 崩溃后的恢复有确定的起算点 | 四份文件互相矛盾，无法判断"重放到哪里" |
| 图结构的变化可审计（哪一步改的、谁改的、为什么） | 只能看到最终图，看不到演化过程 |
| 自演化有数据前提（结构归因） | 自演化只会把噪声固化进规范 |

**渐进路径（不推翻既有协议）**：

```
G0：让事件流「完整到足以重放」（先埋 3 类事件 + applier）
G3：实现 fold，让物化视图可由事件流重建，并跑一致性不变式
未来（不在本方案分期）：tasks.jsonl 降级为缓存/索引，读路径切到事件流
```

> **为什么现在不直接切**：`tasks.jsonl` 是 Commander 与人共同阅读的接口（主协议 §4.5），立刻改读路径会波及面板、脉冲发布器、验证脚本。**先建立"事件流正确且完整"的事实，再谈切换**——顺序反了会同时失去两套记录的信任。

### 5.3 设计：新增 `state/graph-events.jsonl`（不改动 `events.jsonl`）

**保留 `events.jsonl` 作为人工里程碑日志**（它对项目叙事有价值），**新增独立的机器事件流**。理由：混在一起会让人工记录污染机器可重放的保证。

#### 事件类型（v1 最小集）

| 事件 | 写者 | 载荷 | 用途 |
|---|---|---|---|
| `task.created` | Commander | `task_id, node_kind, group, parent` | 图变更留痕 |
| `task.assigned` | Commander | `task_id, assignee, score, why` | **路由决策可审计** |
| `task.started` | 派单器 | `task_id, agent_id, pid, started_at` | 执行开始 |
| `artifact.written` | 派单器 | `task_id, path, bytes, sha256` | **数据依赖的物证** |
| `edge.consumed` | 派单器 | `from_task, to_task, artifact, sha256_match` | **证明边被真实穿越** |
| `task.completed` | 派单器 | `task_id, exit_code, usage_row_ref` | 交付 |
| `task.verified` | 验证器（G4） | `task_id, verdict, findings[]` | 验收结论 |
| `task.reopened` | Commander | `task_id, reason, retry_count` | 环（图需要环，见调研报告 §3.9） |
| `failure.detected` | 任一 | `task_id, kind, evidence_ref` | 失败归因入口 |
| `checkpoint.written` | Commander | `group_id, snapshot_path` | 恢复边界 |
| `interrupt.raised` / `interrupt.resumed` | 任一 | `task_id, reason, resume_value` | **可落盘的中断点**（§5.6） |
| `superstep.committed` | applier | `bus_version, patch_count` | 确定性提交边界（§5.4） |

**每条事件必带的公共字段**：

| 字段 | 用途 |
|---|---|
| `author` | 谁提交的（commander / dispatcher / verifier:\<id\> / applier） |
| `reason` | 人类可读的变更理由（可审计性的最小单位） |
| `trace_id` / `span_id` / `parent_span_id` | **层级视图与跨 CLI 排障**——JSONL 本身已是天然的 span 素材，补齐这三个字段即可接任意 OTel 后端（采用 OpenTelemetry GenAI 语义约定；本线已归档的腾讯云 `tencentcloud-agentobs-sdk-dsh` 五层调用树情报可直接对齐） |
| `bus_version` | 该事件所属的超步版本号 |

**写入约束**：**所有事件由 applier 代写**（§2.2），写者不直接落盘。applier 保证：只追加、单行 < 4096 字节、必带 `author` 与 `reason`。

### 5.4 事件 → 状态重放与一致性不变式

```
state(now) = fold(graph-events.jsonl, initial_state)
```

- 与主协议 §4.5 的"当前状态 = 按 task_id 重放最后一条相关记录"**同构**，只是数据源从 `tasks.jsonl` 扩到机器事件流；
- **强不变式（可自动化）**：`fold(graph-events) == 物化视图`（`tasks.jsonl` / `status.json` / `ledger.jsonl`）。不一致即**总线损坏信号**，并入 `validate-bus.mjs`；
  - ⚠️ 该不变式**只有在事件流完整之后才成立**——这正是 G0 必须先埋点的原因，否则它会在迁移期持续误报；
  - 迁移期降级为 warning，事件覆盖完整后升级为 error。

#### 超步提交边界：确定性的来源 ★（本方案必须正面回答的问题）

**问题**：多个 worker CLI 并发产出时，事件到达 applier 的顺序不确定 → **同样的执行，重放出来的状态可能不同**。这是**框架引入的额外噪声**（叠加在 LLM 本身的非确定性之上），也是最该先消掉的一类——**重放不可复现，归因与恢复就都失去意义**。

借鉴 LangGraph 的 Pregel/BSP 超步与 Microsoft Agent Framework 的 superstep 语义：

```
超步（superstep）：
  ① 收集：本轮所有待提交补丁进入缓冲区（由 applier 持有）
  ② 排序：按**确定性键**排序（task_id → author → op），**不依赖到达时间**
  ③ 合并：按每类数据声明的 reducer 语义合并
       · 事件流      → append（天然幂等）
       · 任务状态    → last-write-wins + expected_version 保护
       · 计数类(net) → sum（tokens / cost）
  ④ 提交：原子写入 + 递增总线版本号
  ⑤ 广播：写一条 `superstep.committed` 事件（含版本号与补丁数）
```

**收益**：同一组补丁无论以什么顺序到达，`fold` 出来的状态**完全一致**。

**代价**：写入有延迟（等一个超步窗口）。v1 采用**短窗口 + 阈值触发**（200ms 或补丁数达阈值即提交）——fleet 的任务粒度是秒级到分钟级，200ms 无感。

#### 一条硬约束：节点身份必须是稳定逻辑 ID

来自 Microsoft Agent Framework 的实测踩坑：**重建工作流时必须复用相同的 executor id，否则恢复直接失败**。

**因此**：fleet 的 `task_id` / `agent_id` 是稳定逻辑 ID（正确）；**禁止把 PID 或 CLI session id 写进图结构的任何字段**——它们只能出现在事件载荷里作为诊断信息。违反这条会导致"恢复时事件与节点对不上号"。

### 5.5 失败归因：最早无效状态

**先立一条纪律：不建 LLM 归因器。**

依据是 [Which Agent Causes Task Failures and When?](https://arxiv.org/abs/2505.00212)（ICML 2025）的实测结论——把归因形式化为"责任 Agent 级"与"关键错误步级"两个任务后，**当时最好的方法也仅约 53.5% / 14.2% 准确率**。也就是说：**让 LLM 读全文猜责任方，在步级上基本等于随机猜**。

**因此归因必须降维成证据链回溯**——先用结构化记录把候选范围缩小，再（可选地）用模型在**小范围**内做判断：

```
locate_first_invalid(failed_task) :=
  沿 graph.consumes 逆向 BFS，收集可达上游集合 U
  返回 U 中满足以下任一条件、且 created_at 最早者：
     ① artifact schema 校验失败
     ② exit_code != 0
     ③ task.verified 的 verdict == "reject"
     ④ sha256 与 edge.consumed 记录不符
  输出 { first_invalid, reason, affected: [下游集合] }
```

- 综述 §1.3③ 的措辞必须遵守：**"图关系可以缩小排查范围，但不能直接证明因果关系"**——因此 v1 只做**基于依赖图的范围收缩**，输出字段叫 `first_invalid` 而**不叫 `root_cause`**；
- 输出写入 `state/` 的归因报告（或写一条 `failure.detected` 事件）；
- 就绪集与调度：本算法与 §3.4 的就绪度算法合起来，即 [DynTaskMAS](https://scholar.google.com/scholar?q=Dyntaskmas)（ICAPS 2025）的"**就绪集（ready set）**"抽象——**worker 的认领依据是依赖满足，而不是轮次同步**。该抽象不需要任何引擎，`graph.consumes` + 就绪度函数两样东西就够。

#### 失败模式标签（MAST 作检测维度表）

[MAST — Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657)（NeurIPS 2025 D&B）给出 **3 大类 14 种**失败模式（标注一致性 κ≈0.88）：

| 类 | 失败模式 | fleet 侧**可机器判定**的信号 |
|---|---|---|
| **FC1 规格与系统设计** | 违反任务规格 / 违反角色规格 / 步骤重复 / 丢失对话历史 / 不知终止条件 | brief 缺必填字段；同一 `(agent,task,action)` 三元组重复 > N；任务无 `done_when` 断言 |
| **FC2 智能体间错位** | 对话重置 / 不追问澄清 / 任务脱轨 / 信息隐瞒 / 忽略他人输入 / 推理-行动不一致 | 下游 `result.json.evidence` 未引用上游 `task_id`；声明与产物哈希不符 |
| **FC3 验证与终止** | 过早终止 / 无验证或不完整验证 / **错误验证** | 无独立 verifier；`verdict.json` 缺失；**自验**（产出者 == 验证者） |

- **高频项**是"错误验证、步骤重复、违反任务规格、验证缺失"——**这四项全部可以在结构上拦截**（`result.json` 契约 + §6 验证器 + 幂等键），**不必等模型判断**；
- **样本不足的现状必须承认**：`t-0001`~`t-0008` 仅一条真实 blocked→reopen 案例。因此 G0/G1 先落"**可判定的信号**"，标签统计与回流（自演化的数据前提）留到样本足够之后。

### 5.6 恢复边界与补偿

| 失效类型 | 恢复动作 | 依据 |
|---|---|---|
| 上游产物损坏/篡改 | 从 `first_invalid` 的**上游 checkpoint 重放**，`affected` 集合全部降级为 `queued` | 综述"回放计算" |
| 节点执行失败 | 保留已 `accepted` 的上游，只重跑 `first_invalid` 及其下游 | 综述"保留有效工作的同时修复受影响部分" |
| **不可回滚的外部操作**（如已调用的付费 API、已发送的通知） | **补偿（compensation）**——记录补偿动作而非撤销 | 综述明确要求"补偿无法直接回滚的外部操作" |

- **与主协议 §10「重启包」的关系**：重启包是**单任务粒度**的上下文恢复（brief + 中间产物路径 + notes 尾部），本方案补充的是**图粒度**的恢复边界（从哪一层 fork）。两者互补，不替代。

#### checkpoint 与事件流分层：快照做性能，日志做审计

借鉴 LangGraph 的 checkpointer 与 Microsoft Agent Framework 的 `CheckpointStorage`：

- 每 N 个超步落一个 `checkpoint.json`（含各 worker 状态 + 未投递消息 + 待应答请求）；
- 恢复时**只回放 checkpoint 之后的事件**，不必重放整条 JSONL；
- **checkpoint 粒度（v1）**：按 `group`（钻石图）写，一条 `checkpoint.written` 事件指向该组的快照清单，**不做全量快照**。

长任务的 JSONL 会持续增长，**分层是可扩展性的前提，不是优化项**。

#### 把"等人批准"建模成可落盘的中断点 ★

**当前 fleet 的真实痛点**：worker CLI 遇到需要人工确认的操作时，只能挂住进程等待，或按主协议 §7.0 的实测结论"异构 CLI 无人值守权限自动拒绝"。前者挂死资源，后者直接失败——**两条路都不好**。

借鉴 LangGraph `interrupt()` + `Command(resume=)`、MS AF `RequestPort` + `ctx.request_info()`、ADK `NodeInterruptedError`：

```
① 节点需要人工决策 → 写 interrupt.raised 事件（含原因与所需输入）
② 落 checkpoint → **进程可以退出**（不阻塞、不占资源）
③ Operator / Commander 在任意时刻（可跨天）提供 resume_value
④ 写 interrupt.resumed 事件 → 从该 checkpoint 恢复执行
```

- 与主协议 §4.2 的 `control.json` 审批语义**天然对齐**——`enabled/force_kill` 已是 Operator 的显式决策通道，interrupt 是它的**任务级扩展**；
- 收益：跨天等待、不占进程、**审批过程本身可审计**（谁在何时批准了什么）；
- **v1 范围**：只做"raised → 落盘 → 人工写 resume 文件 → 恢复"，**不做图形化审批 UI**（面板后续再接）。

---

## 6. G4：验证器节点（Verifier）

### 6.1 问题陈述

主协议 §6.4 第 6 条已经发现了病灶：

> 涉及 UI / 浏览器 / 真实环境的产物**不得只信 worker 自测**：Agent 写的测试易与实现共用盲点（实测案例：DSH 与 Kimi Code 均出现自测通过、真实浏览器失败），须独立运行验证。

但当前**验证者与拆解者是同一个**（都是 Commander），且 Commander 是"想让它过"的一方。调研报告 §3.4 的验证器节点与 §3.7③ 的异构验证给出了正解，而 **fleet 具备零成本实施的独特条件：本机 8 个 agent CLI 天然来自不同厂商、跑不同模型**。

### 6.2 设计要点

1. **禁止自验**：产出者与验证者必须是**不同 agent**，且在能力图上用 `conflicts`/`verified_by` 边显式约束。同一模型的不同 CLI 不算异构（**需在能力图上按 `model:` 节点判定，而非按 `agent:` 判定**）。
2. **对抗立场**：验证器的 brief 明确其目标是**推翻**结论——"找不到反例才给 pass"（调研报告 §3.4 的"杀手"角色）。这与 §6.4 现有的"逐条核对"是不同性质的检查。
3. **独立契约**：验证器**只读**产出物 + **原始验收标准**，不看执行者的推理过程（避免被叙事带偏）。
4. **结构化结论**：写 `tasks/<id>/verdict.json`：

```json
{
  "task_id": "t-0013",
  "verifier": "opencode",
  "verifier_model": "deepseek-v4-flash",
  "producer_model": "claude-sonnet-4-6",
  "verdict": "reject",
  "findings": [
    { "severity": "high", "claim": "交付物声称已覆盖 X，实测未覆盖",
      "evidence": { "type": "file", "ref": "artifacts/…", "line": 42 } }
  ],
  "confidence": 0.7,
  "checked_at": "2026-09-10T…"
}
```

5. **成本**：只增加一次调用（调研报告 §3.7 判定为"三者中性价比最高"）。**不是所有任务都需要验证器**——建议按风险分级：
   - `node_kind: "verify"` 仅在**高风险任务**（不可逆操作、对外交付、生产级验收）挂载；
   - 低风险任务保留现有 Commander 验收。

### 6.3 fleet 已有的对应物

能力图上 `verified_by` 边的现实基础在 `docs/anthropic-multiagent-failure-modes-fleet-2026-08-30.md` 与本线校准报告里已有素材：`claude` / `opencode` / `pi` 的模型与厂商差异已被记录，**异构验证的选型依据现成**。

---

## 7. 边界：明确不做的事

| 不做 | 理由 |
|---|---|
| 引入 LangGraph / AutoGen 等进程内框架 | 放弃"崩溃可重启、人类可审计、外部可读"三项资产，得不偿失（§1.2）。**且调度器理论框架表明：很多所谓"图能力"本质只是调度策略**，文件总线不需要上引擎 |
| 放松"worker 互相不可见" | 综述亦强调"更多连接不一定更好协作，冗余通信会增加成本或放大错误"；fleet 的强约束是有意设计 |
| **为"能力"而增加 Agent 数量** | [Multi-Agent Teams Hold Experts Back](https://arxiv.org/abs/2602.01011)（ICML 2026）实测**团队表现低于队内最强专家**（沟通趋同让专家放弃自身判断）；[Drop the Hierarchy and Roles](https://arxiv.org/abs/2603.28990) 显示自组织优于精心设计的结构。→ **只为实现"独立验证"而增加 agent，绝不为"凑能力"**；且**禁止多数表决覆盖高置信专家** |
| 把开放式探索任务塞进图 | 路径需探索时应用 Agent Harness（调研报告 §3.10 的反证） |
| **先改拓扑、后改契约** | [Multi-agent design](https://arxiv.org/abs/2502.02533)：**提示/契约优化收益大于拓扑优化**。fleet 的第一杠杆是任务卡与 handoff 契约，不是更复杂的图 |
| 自动结构演化（改图不过夜） | 综述明确警告"运行时适应 ≠ 持久化系统演化"，且需要版本化/回放/回滚基础设施（[AgentGit](https://arxiv.org/abs/2511.00628) 方向，**且只需抄其"单写者日志 + 命名检查点"，全量 Git 语义过重**）——**留到有足够执行历史之后** |
| 全量 checkpoint | v1 按 `group` 粒度做，避免日志膨胀 |
| **立刻把读路径切到事件流** | §5.2 的渐进路径：先建立"事件流正确且完整"的事实，再谈切换。顺序反了会同时失去两套记录的信任 |
| 建 LLM 归因器 | [Who&When](https://arxiv.org/abs/2505.00212) 实测最好方法在步级仅 **14.2%** 准确率（§5.5） |

---

## 8. 分期与验收

### G0：契约与事件流（前置，必做）—— ✅ 已落地（2026-09-10）

**这一步是整个方案的地基**——它决定后面三张图能不能被验证。按 §0 第 5 条（契约先于拓扑），G0 的范围比"埋点"更宽：

- **`workers/bus/bus-apply.mjs`（唯一总线写入入口）**：补丁提交 + 契约校验 + `expected_version` 乐观并发 + 确定性排序 + 事件代写（§2.2）；提供 CLI 形态（`--patch <file>` / `--emit-event`），PowerShell 派单器调用它，**不引入常驻进程**；
- **`workers/lib/bus-contract.cjs`（契约的唯一可执行定义）**：graph / result / event / patch 四类判定，applier 与 validate-bus 共用；
- **`workers/lib/bus-apply-core.cjs`（applier 核心）**：不调 `process.exit`，可被测试与非 CLI 消费者直接调用；
- **`result.json` 契约**：schema + 校验（§3.6）——**"节点契约"，先于图落地**；
- 新增 `schemas/{graph,result,graph-event,patch}.schema.json`（人类可读镜像）；
- `state/graph-events.jsonl`：机器事件流，**总线版本号由它派生**（不落独立状态文件）；
- `validate-bus.mjs` 扩校验：任务图引用完整性 / 分组 reduce 唯一性 / 事件版本单调性 / result.json。

**落地状态**

| 项 | 状态 |
|---|---|
| 写入入口与契约层 | ✅ 全部实现（`bus-apply.mjs` + `bus-contract.cjs` + `bus-apply-core.cjs`） |
| 新增 schema | ✅ 四类（graph / result / graph-event / patch） |
| 测试 | ✅ **51 项**：契约判定 23 / applier 超步 15 / 图校验闭环 13；本线合计 58 项 |
| 仓库级回归 | ✅ `node scripts/verify-all.mjs fleet` → **8/8 PASS** |
| 真实数据巡检 | ✅ `validate-bus.mjs` 23 文件 0 错误（新旧数据均未破坏） |
| CLI 退出码实测 | ✅ 版本冲突 → exit 3；未登记路径 → exit 2；`--check` 不写入（已确认真实总线未被触碰） |
| 主协议登记 | ✅ v0.17 §4.8 |

**原验收标准逐条对照**：

1. ✅ `verify-all fleet` 全绿（8/8）
2. ⏳ 「跑一个真实任务后有机器事件产出」——**待首次真实派单**：事件流的写入路径已由集成测试以闭环方式验证（applier 写入 → validate-bus 立即通过），但尚未有真实任务产生事件。这是 G1 的前置动作，不是 G0 的实现缺口。
3. ✅ 非法补丁被拒且返回可读原因——已由单测覆盖（未登记路径 / 非法事件 / result 契约不符 / 版本冲突），并有 CLI 实测证据。

> **G0 未做的部分（有意为之）**：只落实"能写、写得可审计、坏数据进不来"，**不改变任何现有调度行为**——
> `depends_on` 语义、派单流程、状态机均未动。图结构的引入从 G1 开始。

### G1：任务图 —— 🔶 算法与查询已落地（2026-09-10），派单器改造待做

- ✅ **`workers/lib/task-graph.cjs`（就绪度判定的唯一实现）**：台账重放（`foldTasks`）、图模型（`buildGraph` / `groupSummary`）、依赖的两种语义（`effectiveDeps`）、图就绪（`evaluateReadiness`）、可派判定（`evaluateDispatchable`）、就绪集与可派集（`readySet` / `dispatchableSet`）；
- ✅ **`workers/graph/task-ready.mjs`（CLI）**：`--dispatchable` / `--explain <id>` / `--groups` / `--check` / `--json`；
- ✅ `result.json` 契约 + 校验（已在 G0 完成）；
- ⏳ 派单器支持"按图就绪度调度"、并行扇出——**尚未改动 `dispatch-task.ps1`**；
- ⏳ `result.json` 交付期校验与失败重试一次——**尚未接入派单器**。

**G1 的关键实现决策（与 §3.4 略有修正，以实际落地为准）**

调研发现 `dispatch-task.ps1` **此前没有任何依赖判定代码**——主协议 §5 的规则只靠 Commander 自觉。因此 G1 不是"替换旧逻辑"，而是**新增一个此前不存在的可执行判定**。为守住"零行为变更"：

| 依赖来源 | 满足条件 | 理由 |
|---|---|---|
| `depends_on`（旧，回退路径） | 上游 `status === 'done'` | 与主协议 §5 原文**逐字一致**，不看验收 |
| `graph.consumes`（新，数据依赖） | 上游 done ∧ **已验收** ∧ **产物存在** | 下游要读的是文件，状态 done 不等于产物可用 |

任务**有** `graph.consumes` 时用后者，**没有**时回退前者 —— 这条回退规则让无 graph 字段的旧任务行为完全不变。

**验收进度**

| 验收项 | 状态 |
|---|---|
| 就绪度算法与两种依赖语义 | ✅ 13 项单测（`tests/task-graph.test.mjs`） |
| **零行为变更证明** | ✅ 两层验证：① 手工穷举 6×2×6 种状态组合，新判定与旧规则逐字一致；② **真实台账**（`state/tasks.jsonl`）上逐任务比对一致 |
| CLI 可用性 | ✅ 真实总线上跑通，并当场暴露历史问题（`t-0003`/`t-0004` 已排队但派给了已归档的 agent） |
| 仓库级回归 | ✅ `verify-all fleet` **10/10 PASS** |
| ⏳ 真实 3 路 fan-out → reduce → verify 钻石图 | **待做**（需真实多任务派单） |
| ⏳ 派单器按图调度 | **待做** |

> **为什么先做算法而不动派单器**：派单器是正在服役的组件，改它会立刻影响现有 worker 的派单流程。
> 先在库里落判定并用真实台账证明等价，再改派单器，是代价最低的顺序——而且判定逻辑独立成库后，
> 派单器、Commander、未来的面板都能消费同一份口径。

### G2：能力图 —— 🔶 判定层已落地（2026-09-10），capability.json 持久化与派单接入待做

- ✅ **`workers/lib/capability-graph.cjs`（能力图的唯一实现）**：能力规范化（词表）、图构建（provides / costs 边 + confidence）、替代查找（完全/部分覆盖分级）、选型打分（可解释的加权和）、缺口诊断；
- ✅ **`workers/graph/agent-pick.mjs`（CLI）**：`--need` / `--substitute` / `--gaps` / `--check` / `--json`（含 `--all`）；
- ⏳ `agents/<id>/capability.json` 持久化（当前为**运行时派生**，不落盘）；
- ⏳ 「扫描器生成 + 验收回填 confidence」流程接入；
- ⏳ `substitutable_by` 接入 §6.2④（暂存前先查替代）——**目前是 Commander 可查询，非强制**。

**G2 的关键实现决策**

| 决策 | 内容 | 理由 |
|---|---|---|
| **能力规范化先行** | 技能名经别名表收敛为 canonical 能力 id（`cap:coding`） | 真实数据第一次跑就断裂：归档的 `coder` 声明 `code`，活动 agent 声明 `coding`，字符串不等 → 替代关系找不到人 |
| **别名表保守 + 可审计** | 只收明确同义的（`code`/`scripting` → `coding`）；**不猜相似度** | 能力词表收敛是语义决策，应由人确认。工具负责**显式化并报出**待确认项（`--gaps` 的"疑似同义"），而不是替人决定 |
| **替代查找分两级** | 分「完全覆盖」与「部分覆盖（带 missing 清单）」 | 真实情况下常常没有完全替代者，"覆盖 1/3、缺 engineering,zh-report"对 Commander 才有决策价值 |
| **confidence 为 agent 级** | `(accepted+1)/(accepted+reopened+failed+2)`，无历史 = 0.5 | 能力级 confidence 需要任务声明能力需求（当前 brief 无此字段），v2 再做——**这是有意的简化，不是遗漏** |
| **选型可解释** | 加权和：覆盖度(100) + confidence(20) − 成本(10) − 负载(5) | §6.3 的人工决策表降级为**兜底**而非删除 |

**⚠️ 真实数据诊断（2026-09-10 首次运行，这是 G2 的直接产出）**

工具在真实档案上跑出的结果解释了 `t-0003`/`t-0004` 为何长期卡住：

| 能力 | 活动提供者 | 归档提供者 |
|---|---|---|
| `comparative-analysis` | **0** | analyst |
| `engineering` | **0** | coder |
| `research` | **0** | analyst |
| `zh-report` | **0** | analyst, coder |
| `coding` | 3（claude/opencode/pi） | coder |

- **四个能力断层**：`t-0004` 指派给 `analyst` 需要的 research / comparative-analysis / zh-report，`t-0003` 指派给 `coder` 需要的 engineering / zh-report —— **现在没有任何活动 agent 提供**；
- `--substitute coder` 的结论：无完全替代者，3 个部分替代者（claude / opencode / pi）各覆盖 1/3，缺 `engineering` 与 `zh-report`；
- `--substitute analyst` 的结论：**完全没有替代者**（`analysis ≠ research`，工具不猜）；
- **`model` 字段缺失**：8 个活动 agent 的 `model` 全是 `cli-default` → **多模型选型目前没有真实数据**，成本项无法产生区分度；
- `coder` 档案里 `code` 与 `scripting` 规范后撞成同一能力（归档标本，不计失败）。

**验收进度**

| 验收项 | 状态 |
|---|---|
| 能力图库与算法 | ✅ 17 项单测（`tests/capability-graph.test.mjs`，数据取自真实档案快照） |
| CLI 可用性 | ✅ 真实档案上跑通四种模式 |
| 仓库级回归 | ✅ `verify-all fleet` **12/12 PASS** |
| ⏳ 「关闭唯一匹配 agent → 自动选出替代者」 | **部分达成**：能选出候选并声明缺口，但**候选都不完整**（真实数据里确实没有完全替代者），且未接入派单流程 |
| ⏳ `capability.json` 持久化 | **待做**（当前运行时派生） |

> **G2 最重要的产出不是算法，而是把「能力断层」变成了可见事实。** 在此之前，
> 「analyst 归档后没人做 research」这件事没有任何地方会报出来——它只是表现为
> 两个任务永远躺在 queued 里。

### G3：失败归因与恢复边界

- `locate_first_invalid` 实现（§5.5）；
- checkpoint 写入与按图恢复（§5.6）。

**验收**：人为破坏中间产物，系统正确定位 `first_invalid` 并只重跑受影响子图（上游 `accepted` 任务不重跑）。

### G4：验证器 —— 🔶 判定层已落地（2026-09-10），派单挂载待做

- ✅ **`workers/lib/verifier.cjs`（异构验证的唯一实现）**：异构性判定、验证者选取、验证任务书生成、结论汇总；
- ✅ **`workers/graph/verifier-pick.mjs`（CLI）**：`--for` / `--brief` / `--status` / `--check` / `--min-level` / `--json`；
- ✅ **`verdict.json` 契约**（`bus-contract.validateVerdict`）已接入 applier 写入校验与巡检；
- ⏳ 派单流程按风险等级自动挂载验证器（当前是 Commander 可查询，非强制）。

**异构等级**（本方案的判定口径）

| 等级 | 含义 | 处置 |
|---|---|---|
| `none` | 同一 agent | **禁止**（自验） |
| `agent` | 不同 agent | 下限；同源盲点可能重合 |
| `model` | 不同模型 | 盲点大概率不重合 |
| `vendor` | 不同厂商 | **最强** |

**一个现实约束与它的应对（G4 能在当前数据下落地的关键）**

勘察发现：**8 个活动 agent 的 `manifest.model` 全是 `cli-default`** → 「不同模型」这一级**无法判定**（把 `cli-default` 当成真值会产生虚假的异构结论，故 `normalizeModel` 将其视为未声明）。

但 fleet 有一个别处没有的条件：**本机 8 个 agent CLI 天然来自不同厂商**。因此本模块以「agent → 厂商」静态映射作为**不依赖 manifest 数据**的异构依据 —— 即使模型字段缺失，厂商级异构仍可判定。

```bash
$ node workers/graph/verifier-pick.mjs --for claude
  ● bl               异构 vendor · 可用        # alibaba   vs anthropic
  ● opencode         异构 vendor · 可用        # sst       vs anthropic
  ● pi               异构 vendor · 可用        # earendil  vs anthropic

$ node workers/graph/verifier-pick.mjs --for coder --all
  ● claude           异构 agent · 可用
  说明：模型未声明；厂商归属未知（coder 未登记），无法按厂商判定   ← 保守降级并说明原因
```

**厂商未登记时保守降级为 `agent` 级并说明原因，绝不假装异构。**

**验收进度**

| 验收项 | 状态 |
|---|---|
| 异构判定与验证者选取 | ✅ 20 项单测（`tests/verifier.test.mjs`） |
| `verdict.json` 契约三条硬约束 | ✅ 署名 / 拒绝须有依据 / findings 须有证据 |
| 写入与巡检接入 | ✅ applier 校验 + `validate-bus` 巡检 |
| 真实数据可用性 | ✅ 活动 agent 两两之间均可判定为 `vendor` 级异构 |
| ⏳ 「自测通过但实际失败」的产物被 reject | **待做**——需要真实挂载一次验证任务 |
| ⏳ 派单流程按风险自动挂载验证器 | **待做** |

### 依赖关系

```
G0（契约 + 事件流 + applier）── 地基，无它则后续皆不可验证
 ├─► G1 任务图 ──► G3 失败归因与恢复（需要图结构才能做逆向回溯）
 ├─► G2 能力图 ──► G4 验证器（异构判定依赖能力图的 model 节点）
 └─► G4 验证器（也可与 G2 并行，但异构判定需 G2）
```

**两点安排理由**：

1. **G0 承担了原属 G1 的 `result.json` 契约**——按 [Multi-agent design](https://arxiv.org/abs/2502.02533) 的结论（契约优化 > 拓扑优化），**节点契约的收益不依赖图的存在**，因此提前到 G0 独立交付；
2. **G3 排在最后不是因为不重要，而是因为它需要真实失败样本**——当前仅有 1 条 blocked→reopen 案例，先落"可判定的信号"（MAST 的机器可判定子集，§5.5），统计与回流等样本。

---

## 9. 风险

| 风险 | 说明 | 处置 |
|---|---|---|
| **applier 成为单点** | 所有写入经 `bus-apply.mjs`，它故障则总线停写 | ① 它是**纯函数 + 文件操作**，无常驻状态，崩了重跑即可；② 提供 `--check` 只校验不写入模式；③ 保留现有 `validate-bus.mjs` 作为事后兜底；④ **它不阻塞读**——worker 执行不受影响 |
| **契约被敷衍填充** | worker 为通过校验而编造 `result.json` | ① `evidence[]` 必填且需可解析引用；② G4 验证器核对 claim 与证据；③ 校验失败重试仅一次，二次失败转人工 reopen |
| 事件流膨胀 | 每任务多类事件 | v1 只埋 4 类；< 4096B 上限；按 group 归档 |
| **多 Agent 负收益** | 团队表现可能低于队内最强专家；自组织可能优于预设结构 | **只为独立验证而增加 agent**，不为凑能力；禁止多数表决覆盖高置信专家；保持 §6.3 的实测纪律，每笔多 Agent 的收益/成本落 `ledger.jsonl` |
| 图设计过度 | 社区共识："大部分任务一个 Loop 就够" | **无 `graph` 字段 = 等同现状**，增量式采用；不强制所有任务入图 |
| 能力图 confidence 失真 | 样本少时统计不可靠 | Laplace 平滑（无历史返回 0.5）+ 保留人工兜底 |
| 归因过度声明因果 | 综述明确禁止 | v1 只做依赖图范围收缩，输出用 `first_invalid` 而非 `root_cause` |
| 自演化固化噪声 | 无验证的结构变化会跨任务传播 | G3 之后才谈；且必须配套版本化/回放/回滚 |
| 验证器成本 | 每次多一次调用 | 仅高风险任务挂载（§6.2 第 5 条） |
| 与主协议冲突 | 本方案扩展了 §1.2/§4.5/§5/§6.3/§6.4/§10 | **评审通过后合并进主协议并升版**，不长期并行两套规则 |

---

## 10. 与主协议的关系（待合并清单）

本方案评审通过后，需对 `multi-agent-cli-orchestrator-design.md` 做以下**增量修订**（升 v0.17）：

| 主协议章节 | 修订内容 |
|---|---|
| §1.2 单一写者 | **收紧为"补丁提交 + 单一 applier"**（§2.2）：所有角色不再直接写总线，改为提交带 schema 与 `expected_version` 的补丁 |
| §3 目录结构 | 新增 `state/graph-events.jsonl`、`agents/<id>/capability.json`、`workers/bus/bus-apply.mjs` |
| §4.1 `manifest.json` | 增加对 `capability.json` 的引用（静态档案 vs 机器派生视图的分工） |
| §4.5 `tasks.jsonl` | 增加 `graph` 子对象（`node_kind` / `group` / `parent` / `consumes` / `produces`） |
| §4.7 交付物 | 增加 `result.json` 契约（`result-<id>.md` **保留**） |
| §5 任务状态机 | `depends_on` 语义收紧为"时序偏好"；依赖规则替换为**就绪度算法**（§3.4） |
| §6.3 分配决策表 | 升级为**能力图求解**（人工表降为 fallback）；`substitutable_by` 接入 §6.2④ 的暂存流程 |
| §6.4 验收清单 | 增加"回填 capability confidence"与"高风险任务挂验证器"；引入 MAST 可机器判定项 |
| §10 故障与恢复 | 增加图粒度的失败归因（`first_invalid`，**不称 root_cause**）与恢复边界/补偿 |
| 新增章节 | G0–G4 的完整定义（或直接引用本文档）；§1.2 的 applier 条款与三条写入约束 |

---

## 11. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-10 | v0.1 初稿：定位（叠加不替换）、四张图架构与写者表、G1 任务图（字段/就绪度算法/动态扇出/结果契约）、G2 能力图（边类型/confidence 回填/选型算法）、G3 状态图（机器事件流/归因/恢复边界）、G4 验证器（异构约束）、边界、五期规划与验收、风险、待合并清单 |
| 2026-09-10 | v0.2 学术前沿修订：写者机制改为"补丁 + 单一 applier"（PatchBoard）；新增"事件流为唯一真相"（The Log is the Agent）；立"不建 LLM 归因器"纪律并引入 MAST 14 类作可判定维度表（Who&When 反面证据）；优先级改为"契约先于拓扑"（2502.02533）；边界新增"不为能力加 Agent"（两篇反证）；风险表补三项 |
| 2026-09-10 | v0.3 框架横向对比补入：确认"缺的不是图抽象而是四样机制"；新增超步提交边界（确定性重放）、稳定逻辑 ID 硬约束、checkpoint 分层、可落盘中断点（interrupt）、事件的 trace/span 字段；§1.2 补三条明确不吸收项 |
