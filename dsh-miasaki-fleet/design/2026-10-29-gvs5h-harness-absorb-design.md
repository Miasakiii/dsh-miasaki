# 吸收 GVS5H：fleet 编排层的三个断点与五条设计决策

- 日期：2026-10-29
- 状态：设计（**未实施**）。D1–D5 已于 2026-10-29 由 Operator 拍板定稿（记录见 §9），按 §6 的依赖序分批落地；本文不含排期。
- 触发：调研 `slee-persis/GVS5H`（同一模型多角色、以共享文件系统为账本的多 Agent 编排 benchmark 报告）后，按「只吸收可审计的工程事实、不吸收其结论」的原则对照 fleet 现状——五条候选机制四条「部分覆盖」、一条「不建议照搬」，真正要做的是接上三个断点。
- 调研报告（本地、不入库）：`_refs/research-gvs5h/`（01 论文精读 / 02 代码解剖 / 03 数据对账 / 04 外部反响）、`_refs/gvs5h-absorb/`（gap-matrix 现状与缺口矩阵 / gate-impact 闸门与测试约束）。
- 上位协议：[docs/multi-agent-cli-orchestrator-design.md](../docs/multi-agent-cli-orchestrator-design.md)。本文只收紧「派单终态判定」「交付契约代写」与「巡检判据」，不改写文件总线、G0–G4 与派单协议本身。

---

## 0. 结论摘要

1. **要吸收的不是「N 个并发实例」。** GVS5H 的实际机制是同一模型每次全新上下文的角色循环（manager / worker / verifier / finalizer），**单进程串行**、每题中位 5 次调用；「Five … Models」是它的包装语，5 实为重复实验次数。值得吸收的是三条工程事实：**自述完成不可信**、**记忆必须有界**、**终止条件必须是 harness 硬逻辑而不是模型或操作者自觉**。
2. **fleet 不需要新框架。** 五条候选机制实测：T1 部分覆盖、T2 不建议照搬、T3 部分覆盖、T4 部分覆盖、T5 部分覆盖。fleet 在「单写落盘 / 乐观并发 / 纯函数判定 + 单测」上已经强于被调研对象，缺的是**三处接线**。
3. **三个断点（本文要修的东西）**：
   - **B1 交付契约代写未接线**：上位协议 §7.0 写「交付物由派单器代写 result/」，代码里 dispatcher 零写入——异构 CLI 无人值守时契约只能靠人手工补。
   - **B2 验收链最后一米**：派单终态只看 exit code + `result.json` 自述；`verdict.json` 无反向存在性（`t-0011` 已 done+accepted 却没有 verdict，`validate-bus` 仍 0 错误）；WORK-01 确定性闸只写进验证任务书，不进派单路径。
   - **B3 截断不可判定**：`stop_reason` 只进 usage 行的 note，`exit 0 + stop_reason=max_tokens` 会被记成 `idle + task.completed`——**假完成**。
4. **五条决策**：D1 验收闸（P0）· D2 截断即失败（P0）· D3 交付契约代写（P1）· D4 收敛守卫两处（P1）· D5 上下文有界告警（P2，可选）。
5. **边界**：零第三方依赖；不改派单退出码语义（0 成功 / 2 拒绝派单 / 3 执行失败 / 4 预算熔断）；新增判定一律「默认关闭或严格模式先行 + 存量迁移清单显式」；闸门增量与四条同步义务见 §5。

---

## 1. 背景与问题

### 1.1 触发

用户给出一个外部仓库链接，团队按「论文 / 代码 / 数据 / 外部反响」四路并行核查后得到的结论是：**真实工程原型 + 营销化包装**——数字可复算（118 个 arm 逐格复算零差异），但其头条结论在它自己的统计下不显著（对比臂不对等、判分修正单向加分、无同预算采样基线）。本文只取其中**工程事实**层，不引用它的任何结论性数字。

### 1.2 只吸收可审计的工程事实

- **事实一：把「完成」交给模型自述会错。** 它的 verifier 用公开样例测试硬否决 manager 的 done；这条机制还反过来暴露了其判分器 mock 的缺陷（样例通过、正式判分判错）。
- **事实二：外部记忆必须被策展与限长。** 它的 plan 上限 4,000 字符、notes 上限 8,000 字符，且 notes 每轮**整份重写**（prompt 明写 "This REPLACES the file"）——不是追加。
- **事实三：终止 / 重试 / 预算必须是 harness 代码。** done 必须有产物、样例失败否决 done、同一任务被原样重发即判无进展并停机、轮预算硬上限。
- **反用（不吸收其结论）**：它的**度量方式**有四处陷阱（对比臂不对等、判分修正单向加分、无同预算采样基线、污染未排除）。这四条恰好是 fleet 验收纪律要防的，见 §8。

### 1.3 判定口径

| 判定 | 含义 |
|---|---|
| 已覆盖 | 有实现 + 契约 + 测试，且在派单 / 巡检路径上真实执行 |
| 部分覆盖 | 基础件在，缺关键一环（本文的处理对象） |
| 完全缺失 | 无代码无契约 |
| 不建议落地 | 已有更强替代，或照搬会破坏现有不变量 |

### 1.4 五条候选机制的实测判定

| 编号 | 外部机制 | 判定 | 关键证据（fleet 侧） |
|---|---|---|---|
| T1 | 结构化输出解析 + 单写落盘 | 部分覆盖 | 单写落盘 / 原子写 / 乐观并发已强于对方（`workers/lib/bus-apply-core.cjs`）；但 **CLI stdout → `result.json` 的解析与「派单器代写」在代码里不存在**（dispatcher 只落 `logs/*-stdout.log` 与 `transcript.md`，终态只读 `result.json` 的 `status`） |
| T2 | notes 有界全量重写 | **不建议照搬** | fleet 无「轮」概念、worker headless 无写盘能力；再引入 per-task notes 会与 `context.md` / `collective-memory.md` 构成第三真相源。只借「有界」到 brief / context |
| T3 | 每轮确定性校验 + done 否决 | 部分覆盖 | G4 异构验证契约与 WORK-01 确定性闸都在（`workers/lib/verifier.cjs`），但验证任务从不自动派发；`verdict.json` 只在存在时校验；派单终态不跑闸 |
| T4 | 调用级失败分层 + 截断检测 | 部分覆盖 | 八态分类 / 超时重试 / 预算熔断已覆盖（`workers/lib/failure-classify.cjs`）；**截断完全不可判定**；checkpoint 不建议落地（一次性进程模型无步骤级重入语义） |
| T5 | 收敛守卫纯函数化 | 部分覆盖 | 纯函数 + 单测已是 fleet 强项（`task-graph` / `liveness` / `final-state`）；缺**状态迁移合法性**与 **`retries` 上限**两处机器判定 |

### 1.5 本文范围

- **包含**：三个断点的设计决策、契约与事件影响、验收判据、闸门增量与同步义务、依赖序（非排期）。
- **不包含**：代码实施；自动派发验证任务（会引入新任务生命周期与成本归属，独立议题，见 §4）；引用 `_refs/` 材料入库；排期与人力分配。

---

## 2. 三个断点（现状实测）

### 2.1 B1 交付契约代写未接线

- **上位协议承诺**：§7.0 写着「交付物由派单器代写 result/（§4.7 结构；异构 CLI 无人值守权限自动拒绝，实测见 t-0006）」。
- **代码事实**：`workers/dispatch/dispatch-task.ps1` 全程不写 `result.json` / `result-*.md` / `notes.md`；stdout 只落日志（`:1101-1102`）与 `transcript.md`（`:1291-1304`）；终态只读 `result.json` 的 `status`（`final-state.ps1:38-54`）。真实台账里 `result.json` 是 Commander 经 applier 手工构造补丁写进去的。
- **后果**：异构 CLI 无人值守时，契约的完整性依赖人工；§4.7 的六段结构没有任何机器校验。

### 2.2 B2 验收链最后一米

- **派单终态只信 exit code + 自述**：`final-state.ps1:34-54` 只有 `result.json.status ∈ {blocked, failed}` 才改判；其余 exit 0 一律 `idle`。
- **verdict 无反向存在性**：`workers/validate-bus.mjs:377-385` 只在 `verdict.json` **存在**时校验契约，缺失直接 `continue`。实测 `tasks/t-0011` 有 `verify-brief.md`、无 `verdict.json`，台账 `done + accepted`，`validate-bus` 仍 0 错误。
- **确定性闸没进派单路径**：`workers/lib/verifier.cjs:231/265` 的 `parseGateCommand` / `evaluateGate`（WORK-01）只被写进验证任务书；`dispatch-task.ps1:13,664,1285` 明写「只准备材料，不自动派发」。
- **后果**：`accepted=true` 可以永远没有独立验证结论；「验收通过」的机器判据只有「文件存在」。

### 2.3 B3 截断不可判定

- `dispatch-task.ps1:767` 把 `claude` 的 `stop_reason` 只写进 usage 行的 note 文本；`failure-classify` 八态里没有截断类。
- **后果**：worker 因输出上限被截断但进程正常退出（`exit 0 + stop_reason=max_tokens`）时，终态记 `idle`、事件发 `task.completed`——**任务被当成完成，实际交付物不完整**。这类失败目前只能靠人看日志发现。

---

## 3. 设计决策

> 每条决策给出：问题 → 决策 → 契约与事件 → 失败语义（退出码不变）→ 不做什么 → 验收判据。
> 验收判据一律是「命令 + 期望输出」；测试例数以当前基线为准，改动后以新增后数字为准。

### D1 验收闸：派单终态跑确定性检查 + verdict 反向存在性（P0）

**问题**：见 §2.2。

**决策**：

1. **派单内确定性闸**：brief 支持显式 `gate:` 行（`parseGateCommand` 已支持 `gate:` / `确定性闸：` / `闸命令：` 三种写法），dispatch 在终态判定前调用 **`verifier.cjs` 的 `evaluateGate`（复用单点，禁止复制实现）**；`exit ≠ 0` ⇒ `status.state='error'` + `status.failure={kind:'verification', retryable:false, suggest_switch:false}`，事件 `failure.detected` 附 `verify_gate:"failed"`，输出尾部按 `tailForContinuation` 截断后进 `detail`（注意事件字段 4096 字节上限）。
2. **verdict 反向存在性**：`validate-bus.mjs` 新增**独立开关** `--verdict`（**不**复用 `--strict`——`--strict` 的既有语义是「要求 `fleet-pulse.json` 存在」，不得侵占）：`accepted === true` 且该任务存在 `verify-brief.md`（风险声明标记）⇒ `verdict.json` 必须存在，否则 FAIL 并点名。
3. **存量迁移**：目前仅 `t-0011` 命中（12 个任务里唯一有 verify-brief 无 verdict）。按 K3 的先例**补记 verdict**（依据当时验收记录重建），**不建脚本白名单**；补记完成后再把 `--verdict` 纳入常规收尾命令。

**拍板（§9-1）**：flag 名即 `--verdict`；`t-0011` 由 Commander 补记、Operator 确认，补记完成即纳入常规收尾。

**契约与事件**：不新增 `schema`、不新增事件类型（`failure.detected` 允许事件特有字段）；`status.json` 无 `failure` 字段的 schema 约束（`schemas/status.schema.json` 未枚举），因此 D1 的 `failure.kind` 扩展**零 schema 变更**。

**失败语义**：派单**退出码不变**（gate 失败是「执行完成但验收不通过」，不是派单失败）；`final-state.ps1` 的 `idle → error` 改判只影响 `status.json` 与 `failure.detected` 事件。

**不做什么**：不自动派发验证任务（独立议题）；不用 gate 替代 G4 异构验证（两者不可互相顶替：gate 判「产物能不能跑」，verifier 判「结论对不对」）；不复制 WORK-01 的三条边界（只认显式声明 / exitCode 不可信时显式失败 / 尾部截断留痕），直接 import。

**验收判据**：

```text
① 夹具派单（brief 含 `gate: exit 1`）→ status.state="error"、status.failure.kind="verification"、派单退出码仍为 0；
   事件流新增 failure.detected 且 verify_gate="failed"
② node tests/dispatch-gate.test.mjs  → 现 43 例（README 口径，本批未实跑）→ 新增 2 例后 pass 45, fail 0
③ node tests/verifier.test.mjs       → pass 36（未改验证器契约）
④ node workers/validate-bus.mjs      → [validate] done: 39 文件通过，0 错误
⑤ node workers/validate-bus.mjs --verdict → 补记前对 t-0011 期望 exit 1 并点名 verdict.json；补记后 0 错误
```

### D2 截断即失败（P0）

**问题**：见 §2.3。

**决策**：

1. usage 行新增**可选**字段 `finish_reason`（usage 无 schema，`validate-bus` 只校验 ts/cost ⇒ 向后兼容）。
2. `failure-classify.cjs` 新增 `truncated` 类：`retryable=false`、`suggest_switch=false`（同 agent 重试仍会截断，正确动作是拆小任务）；`classify-failure.mjs` 新增 `--finish-reason` 入参。
3. dispatch 只在**机器可读源**上判定（如 `claude -p --output-format json` 的 `stop_reason`；其余源无此字段按 `unknown`），**不许用文本正则猜**——与 failure-classify 「不猜」的既有纪律一致。
4. 终态：`truncated` 优先于 `exit 0` ⇒ `status.state='error'` + `status.failure.kind='truncated'`，**不得发 `task.completed`**。

**拍板（§9-2）**：`truncated` 默认参与终态改判，且 `retryable=false` 的截断在面板红色告警。

**契约与事件**：不新增事件类型（沿用 `failure.detected.error_kind`）；零 schema 变更。

**失败语义**：退出码不变（0）；只改终态与事件。

**不做什么**：不做 per-task checkpoint（fleet 派单单位是「一次性 CLI 进程 + 任务级幂等」，没有步骤级契约与重入语义；GVS5H 那套适用于「100 题 × 5 pass 可重跑 benchmark」，不适用于我们的任务模型）。`checkpoint.written` / `artifact.written` 事件保持「已注册未发射」的现状，不伪造功能。

**验收判据**：

```text
① node workers/dispatch/classify-failure.mjs --exit-code 0 --finish-reason max_tokens
   → exit 0；一行 JSON {"kind":"truncated","retryable":false,"suggest_switch":false}
② node tests/failure-classify.test.mjs → 现 pass 11 → 新增 3 例后 pass 14, fail 0
③ 夹具派单（CLI exit 0 + stop_reason=max_tokens）
   → status.state="error"、status.failure.kind="truncated"、事件 failure.detected 带 error_kind="truncated"；
     事件流中不得出现该任务的 task.completed
④ node workers/validate-bus.mjs → 39 文件通过，0 错误（usage 新字段不破坏巡检）
```

### D3 交付契约代写 + 六段结构提取（P1）

**问题**：见 §2.1。

**决策**：

1. 新增 `workers/dispatch/extract-result.mjs`（纯函数 + CLI，零依赖）：输入 stdout 日志与 `task_id`，按 §4.7 的六段结构（`## 结论` / `## 完成度` / `## 数据来源` / `## 遇到的问题` / `## 广播建议` / `## 下一步建议`）提取候选字段；**解析失败显式失败**（exit 1 + `missing_sections`），不猜、不静默兜底。
2. dispatch 终态前新增**可选分支（默认关闭）**：解析成功 → 组 `result.json` 草稿 → **经 `bus-apply.mjs` 提交**（复用 `validateResult` 作为唯一契约实现），并**复用已注册未发射的 `artifact.written` 事件**留痕；解析失败只告警，不二次阻断派单（派单的失败语义与解析失败解耦）。
3. `result-*.md`（人读）与 `result.json`（机读）是双载体不是双真相：提取器只从 stdout / md 提取到 JSON，**不反向生成 md**。

**拍板（§9-3）**：先默认关闭；跑完存量 12 份 `result.json` 回归（`validate-bus` 0 错误）后再评估开启。

**契约与事件**：零新增事件类型、零 schema 变更；所有写入仍走唯一入口（违反 G0 等于退回三类旧故障）。

**失败语义**：默认关闭时零行为变更；打开后解析失败=告警（不进 `failure.detected`），派单退出码不变。

**验收判据**：

```text
① node workers/dispatch/extract-result.mjs --stdout <正例夹具> --task t-9001 --json
   → exit 0；stdout 恰一行 JSON；conclusion 非空、six_sections 长度 6
② 负例夹具（删掉 `## 结论`）→ exit 1；stderr 含 missing_sections
③ 默认关闭：pwsh -File workers/dispatch/dispatch-task.ps1 -TaskId t-9001 -Agent alpha -CheckOnly
   → 与基线同退出码（零行为变更）
④ node tests/extract-result.test.mjs（新增文件，登记进 verify-all）→ pass N（≥6：正例 / 缺节 / 变体标题 / 解析失败各覆盖），fail 0
⑤ node workers/validate-bus.mjs → 39 文件通过，0 错误（新增夹具若入库，文件数相应增加）
```

### D4 收敛守卫：状态迁移合法性 + retries 上限（P1）

**问题**：`bus-apply-core.cjs:310-311` 与 `validate-bus.mjs:246` 只校验 `status` 在枚举内，不校验迁移合法性（`queued → done` 这类跳变无机器判据）；「`retries ≥ 3` 换 agent / 人工介入」只写在上位协议 §5，代码没有判定（`agent-pick` 只把 retries 当历史评分输入）。

**决策**：

1. 新增 `workers/lib/loop-guards.cjs`（纯函数、零 IO）：
   - `validateTransition(prevState, row)` → `{ok, reasons[]}`：**判定模型以台账 op 语义为准，不照抄上位协议 §5 的状态机字符串图**。实测依据：真实台账 12 个任务里 21 条 `update status=done` 是 `assign` 之后**直接**到达的（`running` 只在少数任务显式写过，如 `t-0005`），若按「queued→running→done」的字符串模型判，会把绝大多数历史任务判成非法跳变。允许表按「op + 当前派生状态」定义：`create` 必须落 `queued`；`assign` 只允许非终态；`update status=running|blocked|failed|done` 必须已 assigned（`running` 行不是必需）；`reopen` 只允许 `done|blocked|failed`；`reassign` 只允许非终态。
   - `evaluateRetryPolicy({retries, lastFailure})` → `{action:'dispatch'|'escalate', reasons[]}`：`retries ≥ 3` ⇒ `escalate`；`retryable=false` 的失败重复出现 ⇒ `escalate`。
2. 接线：`validate-bus.mjs` 新增独立开关 `--transitions`（默认关，先跑真实台账证明零回归）；dispatch 在派单闸门后调用 `evaluateRetryPolicy`，`escalate` **只写事件 + 面板提示，不硬拒派单**（最终裁决权仍在 Commander / Operator，与上位协议 §6.5 一致）。
3. 事件：新增事件类型 `loop.guard`（`reason` 枚举 `no_progress` / `retries_exceeded` / `transition_illegal`）。这是本文**唯一新增的事件类型**，需四处同源（见 §5.3）。

**拍板（§9-4）**：`escalate` 只提示不硬拒；`reason` 枚举即上述三项。

**契约与事件**：`schemas/graph-event.schema.json` 的 enum、`bus-contract.cjs` 的 `EVENT_TYPES` 与 `EVENT_AUTHORS`、`tests/bus-contract.test.mjs`、README 事件表四处同步；复用台账既有 `retries`，**不另设计数器**（否则第二真相）。

**失败语义**：`escalate` 不影响派单退出码；`--transitions` 只影响巡检。

**验收判据**：

```text
① node workers/lib/loop-guards.cjs --check-ledger state/tasks.jsonl
   → exit 0；非法迁移 0（真实 12 任务台账自证；其中 t-0005 走 running→blocked→reopen→running，
     t-0001 走 assign→done 直跳——两条路径都必须判合法）
② node workers/lib/loop-guards.cjs --explain t-0011
   → exit 0；一行 JSON {"action":"dispatch","reasons":[]}
③ 夹具（retries=3）→ {"action":"escalate","reasons":[...]}
④ node tests/loop-guards.test.mjs → pass N（N ≥ 10：op 语义合法/非法、retries 边界、不可重试失败各覆盖）
⑤ node workers/graph/task-ready.mjs --check → [task-ready] --check 通过：12 个任务，0 个分组，无结构问题
⑥ node workers/validate-bus.mjs → 39 文件通过，0 错误；开启 --transitions 后仍 0 错误
```

### D5 上下文有界告警（P2，可选）

**问题**：brief / context 无大小上限；`tasks/t-0003/context.md` 曾因漂移被登记（README 的 notes.md 裁决条目）。这是 T2 里**唯一值得吸收的部分**——「有界」，而不是「全量重写 notes」。

**决策**：新增 `workers/lib/brief-budget.cjs` 纯函数：`checkContextBudget(text, limits)` → `{ok, lines, bytes, over[]}`；dispatch 组装 prompt 前调用（`dispatch-task.ps1:1026` 前后），**超限仅告警**（stderr + `status.step` 备注），不拒绝派单——避免把存量任务判红。**拍板（§9-5）**：阈值 brief ≤120 行 / context ≤80 行；本批就做，超限只告警不阻断；阈值集中在 `brief-budget.cjs` 的常量里，不在调用点多处硬编码。（存量实测：12 个任务 brief 最大 52 行、context 最大 63 行 ⇒ 阈值不会误伤存量。）

**不做什么**：不引入 per-task notes；不改 `agents/*/notes.md` 的人工口径（那是 agent 自述记忆，不是任务账本）；不把 `collective-memory.md` 纳入总线。

**验收判据**：

```text
① node workers/lib/brief-budget.cjs --check tasks/t-0011/context.md
   → exit 0；stdout `OK lines=<n> bytes=<n> (limit lines=80 bytes=...)`
② 超限夹具 → exit 1 并点名 lines= 与上限
③ node workers/validate-bus.mjs → 39 文件通过，0 错误（证明未新增真相文件）
```

---

## 4. 不吸收清单

| 项 | 为什么不 | 依据 |
|---|---|---|
| 「N 个并发实例 / 自协商」 | 对方本身也不是这样（单进程串行、每题中位 5 次调用）；fleet 是异构 CLI + 独立进程，照搬会造出不存在的东西 | §1.4 T1/T3 证据面 |
| per-task notes 全量重写 | fleet 无「轮」、worker headless 不能落盘；新增即第三真相源 | gap-matrix §2 |
| per-task checkpoint | 一次性进程 + 任务级幂等，无步骤级重入语义；收益远低于对方（可重跑 benchmark） | gap-matrix §4 |
| 精确字符串样例校验 | 会与最终验收口径不一致——对方自己就踩过「样例校验比正式判分更严」 | 02-code §7 反向清单 |
| 裸写盘 / 无锁 / 只写不读镜像 | fleet 已有 `bus-apply`（乐观并发 + 确定性排序 + 原子写） | 上位协议 §4.8 |
| 自动派发验证任务 | 引入新任务生命周期与成本归属，独立议题；当前先接「派单内 gate + 反向存在性」 | `dispatch-task.ps1:664` |
| 对方的结论性数字 | 对比臂不对等、判分修正单向加分、无采样基线；引用需三限定 | `_refs/research-gvs5h/01-paper.md` |

---

## 5. 闸门与同步义务

### 5.1 本设计文档自身

新增一份 design md 只会被两道仓库级闸门咬：`repo/style`（LF / 无 BOM / 末行换行 / 脱敏）与 `repo/md-links`（相对链接必须解析到**已入库**目标）。

- `_refs/` 与任何未跟踪文件**不能**做链接目标（R2）；引用本地材料一律用反引号路径。
- `md-links` 只扫 git 索引：新文档在被 `git add` 之前不会被扫；但**已跟踪的 README 若先链接它，会立刻 R2** ⇒ 先登记文档、再跑闸门。

### 5.2 实施 D1–D5 的闸门增量

| 决策 | fleet 类别 | 仓库级闸门 | 需要同步的内容 |
|---|---|---|---|
| D1 | 无新增检查项（扩 `dispatch-gate` 与 `verifier` 既有用例）；动 `dispatch-task.ps1` 若命中第 16/17 项的 `need` 字面量（7 / 47 条）即红 | `silent-guards`（`workers/**` 属构建链） | `final-state.ps1` 改判点、事件字段、`--verdict` 开关文档化 |
| D2 | 扩 `failure-classify` 用例 | `silent-guards` | `classify-failure.mjs` 新入参、usage 行新字段说明 |
| D3 | **+1 项**（新测试文件登记进 `planFleet()`） | `silent-guards`（解析失败禁止静默兜底）、`style`（新源码） | `package.json` test 链、README 回归清单项数 |
| D4 | **+1 项**（新测试文件）；新增事件类型 | `silent-guards` | 事件四处同源：`bus-contract.cjs` 的 `EVENT_TYPES`/`EVENT_AUTHORS`、`schemas/graph-event.schema.json` enum、`tests/bus-contract.test.mjs`、README 事件表 |
| D5 | **+1 项**（新测试文件） | `silent-guards` | 阈值写入 README 或 design |

### 5.3 四条同步义务（漏一条就是「静默回收」形态）

1. `scripts/verify-all.mjs` 的 `planFleet()` **显式登记**新检查项（现 32 项；新测试不登记＝永远不跑），并更新 README 的回归清单项数。
2. `dsh-miasaki-fleet/package.json` 的 `test` 链（新测试至少进 `verify-all`；`dispatch-state` / `dispatch-gate` 刻意不在 npm 链上的现状保持不变）。
3. README 的「统一回归」清单 + 「变更记录」节（本线的变更记录在 README，不在 `design/CHANGELOG.md`）。
4. `AGENTS.md` / 根 README 的全量基线数字（本批设计文档不动，实施时再对账）。

### 5.4 单一真相源纪律（实现时的硬约束）

- **不在脚本里建豁免白名单**：存量缺口按 K3 先例补记数据。
- **不新增第二套判定**：D1 复用 `verifier.cjs` 的 gate 函数；D4 复用台账 `retries`；D3 复用 `validateResult`。
- **解析/校验失败必须显式**：`workers/**` 属构建链，`silent-guards` 的 R1/R2/R3 对 `!existsSync` 静默返回、空 catch、静默回退一律判红；确有正当降级需在命中行或紧邻上一行写 `// guard-ok: <理由>`。

---

## 6. 实施顺序与每批验收（依赖序，非排期）

| 批次 | 决策 | 依赖关系 | 每批收尾判据 |
|---|---|---|---|
| A | D1 + D2 | 都只动「派单终态判定 + 契约复用」，零 schema；先写纯函数/单测，再接 dispatch | `node tests/dispatch-gate.test.mjs`、`node tests/failure-classify.test.mjs`、`node tests/verifier.test.mjs` 全绿；`node workers/validate-bus.mjs` 0 错误；`node scripts/verify-all.mjs fleet` 32/32 |
| B | D4 + D3 | D4 纯函数最便宜先做；D3 依赖 transcript 结构稳定（与 D1/D2 无耦合） | 新增 2 项登记后 fleet 34/34；事件四处同源跑绿；真实台账 `--transitions` 零回归 |
| C | D5 | 可选；与前两批无依赖 | fleet 35/35；超限夹具命中但不阻断 |

每批共同收尾：`node scripts/verify-all.mjs repo` 7/7；全量（含 desktop `cargo test`）由 CI 或用户侧跑；改测试后至少对齐一次 Node 22.19.0（本机 Node 24 全绿 ≠ CI 绿）。

---

## 7. 风险与回退

| 风险 | 表现 | 处置 |
|---|---|---|
| 收紧巡检判红存量 | `--verdict` / `--transitions` 让历史任务变红 | 新开关默认关闭；存量迁移清单显式（当前只有 t-0011）；补记后再纳入常规收尾 |
| 迁移校验照抄状态机字符串图 | 21 条「不写 `running`」的历史 `done` 被判非法跳变 | 判定模型按台账 **op 语义**（D4-1）；落地前用 `--check-ledger` 对真实 12 任务全量自证 |
| 派单退出码语义被顺手改动 | 脚本 / 桌面端 / 面板依赖 0/2/3/4 | D1/D2 一律只改 `status` 与事件，**不动退出码**；代码评审时逐条核对 |
| 事件字段超长 | gate 输出塞进 `detail` 超过 4096 字节 | 复用 `tailForContinuation` 截尾，`verify_gate` 只用短枚举 |
| 解析层引入静默兜底 | 解析失败返回空对象、任务照常记完成 | 显式失败（exit 1 + `missing_sections`）；`silent-guards` 判红 |
| 第四/第五条记忆通道 | brief / context / collective-memory / transcript 之外再开一条 | 不新增；D5 只做「有界告警」 |
| 默认开启导致行为漂移 | 打开 D3 代写后 result.json 语义变化 | 默认关闭；先跑存量 12 份 result.json 回归 |

---

## 8. 顺带确立的验收纪律（不写代码，写进本线口径）

对方那套**度量方式**的四个陷阱，正好是 fleet 自己验收时要防的：

1. **对比臂必须对等**：它的「小模型追平前沿」是「穿脚手架的臂 vs 不穿脚手架的前沿单调用」。fleet 对应：**worker 自测通过 ≠ 真机通过**（上位协议 §6.4-6 已有此条，本次重申并落到验收清单）。
2. **事后修正必须声明方向**：它的判分修正只升不降且对一侧更有利。fleet 对应：判定器 / 阈值 / 口径变更时，验收记录必须写明「这次收紧还是放宽、影响哪些存量」。
3. **没有基线就不能归因**：它的提升没有同预算采样基线。fleet 对应：评估 worker 产出时，要区分「换模型 / 换工具面 / 换 scaffold」三个变量，不做单变量归因就别下结论。
4. **协议不能被绕过**：它在零工具基准上加了 agentic loop。fleet 对应：G4 验证任务不得变成「换一个 agent 重跑一遍」——验证必须是对抗立场 + 独立契约。

---

## 9. 拍板记录（2026-10-29，Operator 定稿）

| # | 决策点 | 拍板结果 | 落地约束 |
|---|---|---|---|
| 1 | D1 开关形态与存量补记 | 新 flag 命名 **`--verdict`**；**不侵占 `--strict`**；`t-0011` 的 verdict 补记完成后，`--verdict` 即纳入常规收尾命令 | 补记由 **Commander 依据当时验收记录重建并起草 verdict**，经 `bus-apply` 写入（K3 先例：缺一律 FAIL、不建豁免白名单）；Operator 只确认，不手工造结论 |
| 2 | D2 截断的终态语义 | `truncated` **默认参与终态改判**（`status.state='error'`，不得发 `task.completed`）；`retryable=false` 同时**上面板红色告警** | 告警口径复用既有失败告警通道；`truncated` 与 `context_overflow` / `request_error` 必须在 hint 里写清区别 |
| 3 | D3 代写默认开关 | **先默认关闭**；跑完存量 12 份 `result.json` 回归（`validate-bus` 0 错误）后再评估开启 | 开启前不得改派单退出码；解析失败只告警 |
| 4 | D4 escalate 语义与事件枚举 | `escalate` **只提示不硬拒**（最终裁决权仍在 Commander / Operator）；`loop.guard` 的 `reason` 枚举就 **`no_progress` / `retries_exceeded` / `transition_illegal`** 三项 | 事件四处同源；`retries` 复用台账字段，不另设计数器 |
| 5 | D5 阈值与批次 | 阈值按 **brief ≤120 行 / context ≤80 行**；**本批（P2）就做**，超限只告警不阻断 | 不改 `agents/*/notes.md` 人工口径，不新增任务级记忆通道 |

> 拍板后状态：**D1–D5 设计定稿，均未实施**。实施按 §6 的依赖序 A → B → C 分批，每批以该节判据收尾。
