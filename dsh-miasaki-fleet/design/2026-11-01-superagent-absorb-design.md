# 吸收官方 Super-agent 原型：fleet 触发层的四个断点与五条设计决策

- 日期：2026-11-01
- 状态：设计（**未实施**）。五条决策 E1–E5 待 Operator 拍板（§8）。
- 触发：调研 DeepSeek 官方开源研究原型 `deepseek-ai/dsh-superagent-prototype` 后，按「只吸收可审计的工程事实、不照搬它的形态」原则对照 fleet 现状得出的结论。
- 调研报告：[ref-dsh-superagent-prototype-2026-11-01.md](../../dsh-miasaki-shared-docs/dsh-platform/ref-dsh-superagent-prototype-2026-11-01.md)（文章 vs 原型对账、A–E 组可迁移清单、fleet 12 维差距）
- 上位协议：[docs/multi-agent-cli-orchestrator-design.md](../docs/multi-agent-cli-orchestrator-design.md)
- **前置设计**：[2026-10-29-gvs5h-harness-absorb-design.md](2026-10-29-gvs5h-harness-absorb-design.md)（GVS5H 批的 D1–D5，**同样未实施**）。本文与它是**承接关系不是并列关系**：D 管「终态判得准」，E 管「任务从哪来」；**E 必须排在 D1 + D2 之后**（理由见 §6）。
- 本文回答：**要不要给 fleet 加自动触发**、**加的话最小形态是什么**、**代价与判据是什么**、**哪些明确不做**

---

## 0. 结论摘要

1. **不搬形态，只搬判定顺序。** 原型是「常驻 Source → Trigger → Gate → Assessment → Worker Session」，fleet 是「人工派单 → 文件总线 → 外部 CLI 一次性进程」。两者形态相斥：照搬会引入 daemon、LLM 常驻与 DSH Session 依赖，**与本线既定的「搬语义不搬 daemon」原则正面冲突**（`workers/lib/schedule.cjs:3-8` 头部原话）。真正可搬的只有三条判定顺序：**确定性先于语义**、**observe 先跑**、**幂等靠同一次超步**。
2. **骨架已经存在，缺的是触发条件。** `state/schedules.json` + `workers/scheduler/enqueue-due.mjs`（P2-D，2026-10-21）已经跑通「外部触发器 + 一次性 CLI + bus-apply 幂等超步 + 错过窗口只补一次」。它证明这条无 daemon 的路子能走；它缺的只是**触发条件只有「时间到」，没有「信号命中」**。
3. **四个断点**：① 触发只有时间轴，没有信号轴（schedule 的 `task` 是静态写死的 title/assignee/brief，到点无条件建任务）；② 没有准入层与观察期（到点即建，不可「先记录不动手」）；③ 没有候选幂等（同一信号持续命中会按 interval 反复建任务）；④ `result.json` 缺 `waiting`/`dropped` 两态与结构化提问（与 D3 同批）。
4. **五条决策**：**E1** Source 定义文件 + 一次性 tick CLI（P0）· **E2** 确定性准入 + observe 模式（P0）· **E3** 候选幂等与冷却（P0）· **E4** 接线与事件作者（P1）· **E5** `result.json` 语义增量（P1，**必须与 D2/D3 合并实施**）。
5. **硬边界**：零 daemon、零 LLM 常驻、零第三方依赖、**不改派单退出码语义（0/2/3/4）**、不接 GitHub/飞书、不新增第二套判定实现。
6. **一句话**：这不是「把 super-agent 装进 fleet」，而是**把 fleet 已经有的定时触发器，从「看钟」扩展成「看信号」**，并给它加一层原型验证过的观察期与准入。
7. **实施是五批，不是两批。** D1–D5（2026-10-29 拍板、未实施）与 E1–E5（本文待拍板）共 **10 条决策排成一条统一依赖序**（§6）：**批次 0** D1+D2 → **批次 1** E1+E2+E3 → **批次 2** E5→D3（先契约、后提取器）→ **批次 3** D4+E4（事件契约合并）→ **批次 4** D5。fleet 检查项 **32 → 37**；必须串行的是 `0 → 1 → 3`，批次 1 与 2 可并行。

---

## 1. 背景与判定口径

### 1.1 为什么不能照抄原型

| 维度 | 官方原型 `[实测]` | fleet 现状 `[实测]` | 冲突点 |
|---|---|---|---|
| 节拍 | `setInterval(2000)` 常驻 pass（`src/app/passes.ts:28`） | 一次性 CLI + 外部触发器（Windows 任务计划） | 引入常驻进程即需进程托管，而 fleet 自承「进程托管器/自动重启未做」 |
| 执行单元 | DSH Session（稳定 id 复用，`src/app/sessions.ts:138-155`） | 外部 coding-agent CLI 子进程 | fleet 的 worker 是异构 CLI，不是 DSH Session |
| 来源 | Source 抽象，接 GitHub 通知/PR/CI 与飞书事件 | 无任何外部集成 | fleet 不是对外服务，接 GitHub 是错误场景 |
| 状态 | 单进程 + SQLite WAL + 文件锁 | Windows 文件总线（JSONL + bus-apply 超步） | 存储形态不同，不得引入第二套 |

### 1.2 为什么骨架已经存在

`workers/scheduler/enqueue-due.mjs` 的头部注释已经把设计原则写死：

> 真相 = `state/schedules.json`；本 CLI 是**一次性触发器**：外部（Windows 任务计划 / 手动 / DSH 定时插件）周期调用；**幂等**：任务行 append 与 `next_fire_at` 推进在**同一次超步**提交；错过多个窗口只补一次（不雪崩补跑）。

`[实测]` 这套语义与原型 `docs/003-execution.md` 的「串行 Eval + 批处理」在**幂等与不雪崩**上同构，但用「无常驻」实现。**所以本次要做的不是新机制，是给同一个机制换触发条件。**

### 1.3 判定口径

沿用 [2026-10-29-gvs5h-harness-absorb-design.md](2026-10-29-gvs5h-harness-absorb-design.md) §1.3 的四档：**已覆盖 / 部分覆盖 / 完全缺失 / 不建议落地**。

### 1.4 原型里真正值得搬的四条（其余见调研报告 §6）

| 编号 | 原型机制 | 为什么可搬 | 落在本文哪条 |
|---|---|---|---|
| P1 | 两级 Eval：Gate 确定性先于语义研判（`src/policy.ts:167-241`；`src/app/assessment.ts:113` explicit 永不进模型） | 「先用代码筛掉大部分，再花模型的钱」是通用原则，与 fleet「闸门链先廉价后昂贵」完全一致 | E2 |
| P2 | accept mode `off/observe/auto`，默认 observe（`src/policy.ts:84,55-58`） | **观察期**是自动化的安全上线路径，fleet 目前没有任何观察期概念 | E2 |
| P3 | Trigger 幂等 + 同一次超步（`src/core/ids.ts:3-5`、`src/core/intake.ts:23`） | 与 fleet `bus-apply` 超步同构，可直接搬语义 | E3 |
| P4 | Report 五态里的 `waiting` / `dropped` 与结构化提问 `human_action`（`src/core/model.ts:216`；`docs/004-prompts.md:84`） | 直接补 fleet `result.json` 的两态缺口与「问人」通道 | E5 |

---

## 2. 四个断点（现状实测）

### 2.1 断点① 触发条件只有时间，没有信号

- **事实**：`schemas/schedule.schema.json` 的必填字段是 `id / interval_seconds / next_fire_at / task{title, assignee, brief}`——**task 是静态写死的**，`enqueue-due.mjs` 到点无条件建任务，全程没有任何条件判断（`:199-228`）。
- **后果**：fleet 只能表达「每 N 秒做某件事」，无法表达「**当 X 出问题时**做某件事」。当前唯一能自动产生的任务是定时任务，而 `state/schedules.json` 实为空清单（`schedules: []`）——**这条能力实际上从未被使用过**。

### 2.2 断点② 没有准入层与观察期

- **事实**：`enqueue-due.mjs` 的准入只有 `enabled !== false` 与 `next_fire_at <= now` 两条（`schedule.cjs:86-93`）。一个被误配置的 schedule 会**立刻**开始建任务。
- **后果**：自动化要么关着、要么全开。没有「先跑一周看看它会干什么」的中间态——而这正是原型 `observe` 模式的价值。

### 2.3 断点③ 没有候选幂等与冷却

- **事实**：幂等只保证「同一时刻重复调用不重复建任务」（靠 `next_fire_at` 推进）。若一个信号**持续存在**（例如 `verify-all` 连续 5 次红灯），按 `interval_seconds` 会每轮各建一个任务，**5 个任务干同一件事**。
- **对照**：原型用「Trigger 内容哈希 + 已存在即 duplicate」去重（`src/core/intake.ts:23`），配合 Thread 串行保证同一议题不重复开票。

### 2.4 断点④ `result.json` 缺两态与结构化提问

- **事实（2026-11-01 核实并订正调研报告）**：`result.json` 的 status **已经**是有穷三态 `completed | blocked | failed`（`workers/lib/bus-contract.cjs:150` 的 `RESULT_STATUS`，校验在 `:165-255`，且 `status ∈ {failed, blocked}` 时 `blockers` 不得为空 `:250-252`）。**缺的不是枚举化**，而是：
  - `waiting`（等人工）——现在只能挤进 `blocked`，但「等一个人回话」与「被外部依赖卡住」是两种不同的停；
  - `dropped`（无需处理）——「这个问题复现不了 / 已被别处解决 / 用户已撤回」现在无处可放，只能写 `completed`（假完成）或 `blocked`（假受阻）；
  - **结构化提问通道完全没有**——worker 想让人拍板只能写进 `conclusion` 自由文本。
- **后果**：自动建任务会放大这个缺口——人工派单时人会看；自动派单时**没人在看第一眼**。

---

## 3. 设计决策 E1–E5

> 每条给出：问题 → 决策 → 契约与事件 → 失败语义（退出码不变）→ 不做什么 → 验收判据。
> 验收判据一律「命令 + 期望输出」；测试例数以当前基线为准，实施后以新增后数字为准。

### E1 Source 定义文件 + 一次性 tick CLI（P0）

**问题**：见 §2.1。

**决策**：

1. 新增 `state/sources.json`（schema v1，与 `state/schedules.json` **并列**而非合并）：每个 source 声明**触发条件**，字段与 schedule 同构再加 probe：
   ```
   id                 s-src-<name>        （与 schedule 的 s-<name> 前缀区分，防混淆）
   enabled            boolean
   kind               "probe"             （首批只此一种）
   interval_seconds   ≥60                 （同 schedule 口径）
   next_fire_at       ISO                 （冷却到期时刻，由 tick 推进）
   last_fired_at      ISO|null
   fire_count         integer
   mode               "observe"|"auto"    （默认 observe，见 E2）
   cooldown_seconds   integer             （默认 3600）
   task               { title, assignee, brief }   （命中后要建的任务）
   probe              { command, args[], cwd, timeout_ms, hit_when }
   ```
2. 新增 `workers/sources/tick.mjs`（一次性 CLI，与 `enqueue-due.mjs` 同风格）：读 sources → 校验 → 取到期 → **逐个跑 probe** → 判定命中 → 走 E2 准入 → observe 记事件 / auto 建任务 → **同一次 bus-apply 超步**提交（任务 append + sources 推进）。
3. **probe 只认退出码，禁止解析 stdout。** `hit_when` 首批只支持两个值：`exit_nonzero`（命令失败 = 有信号）与 `exit_zero`（命令成功 = 有信号）。判定逻辑要更复杂时，写法是**再写一个会判断的脚本**并把结论编码进退出码——这正是 fleet 现有闸门的通用形态（`verify-all` / `validate-bus` / `agent-drift.mjs` 全是这样）。这不是省事，是纪律：原型 `docs/004-prompts.md` 的强弱五档把「工具强制的事实」列为最强，解析自由文本是最弱的。
4. **probe 必须是只读判定命令**（写进 schema 的 description 与 README）：禁止在 probe 里写盘、派单、改台账。要做副作用就让它建任务，别让它自己动手。

**契约与事件**：新增 `schemas/source.schema.json`（给人看）+ `workers/lib/source.cjs`（权威校验实现，与 `schedule.cjs` 同构：纯函数 + CLI 只做 IO）。**不新增真相文件之外的东西**：任务仍只在 `state/tasks.jsonl`，票仍只在 `tasks/<id>/`。

**失败语义**：tick 退出码 **0 成功（含无到期）/ 1 校验或写入失败 / 2 用法错误**（与 `enqueue-due.mjs:17` 同口径）。**不碰派单器退出码 0/2/3/4。**

**不做什么**：不做 daemon；不做 2 秒 pass；不做批处理（probe 逐个跑，`--max` 限制单次最多几个）；不合并 `schedules.json`（职责不同：schedule = 时间驱动，source = 信号驱动）。

**验收判据**：

```text
① node workers/sources/tick.mjs --check
   → exit 0；列出到期 source 与其 probe 命令（不写盘、不建任务）
② node workers/sources/tick.mjs --now <注入时刻> --json（夹具：source 到期 + probe 命中 + mode=observe）
   → exit 0；stdout 恰一行 JSON；state/tasks.jsonl 无新增；事件流新增 candidate.observed
③ 同夹具 --now 不变再跑一次
   → exit 0；不重复产生候选（next_fire_at 已推进 ⇒ 未到期）
④ node workers/lib/source.cjs --validate state/sources.json
   → exit 0；非法夹具（interval<60 / hit_when 未知 / probe.command 空）→ exit 1 并点名
⑤ node workers/validate-bus.mjs
   → [validate] done: <N> 文件通过，0 错误（新增 sources 校验后仍 0）
```

### E2 确定性准入 + observe 模式（P0）

**问题**：见 §2.2。

**决策**：

1. 新增 `workers/lib/source-gate.cjs`（**纯函数、零 IO**），`decide({source, now, probeResult, registry, counters})` → `{action: 'probe'|'build'|'observe'|'skip'|'unknown', reasons[]}`。判定顺序**短路**、先廉价后昂贵：
   | 序 | 判据 | 不通过时 |
   |---|---|---|
   | 1 | `enabled !== false` | `skip:disabled` |
   | 2 | `now ≥ next_fire_at` | `skip:not_due` |
   | 3 | `now ≥ last_fired_at + cooldown_seconds` | `skip:cooldown` |
   | 4 | 本小时该 source 建任务数 < `max_tasks_per_hour`（默认 3） | `skip:rate` |
   | 5 | probe 可执行且未超时 | `unknown:probe_failed`（**推进 next_fire_at，不建任务**） |
   | 6 | `hit_when` 满足 | `skip:no_signal`（推进 next_fire_at） |
   | 7 | `mode === 'observe'` | `observe`（写事件，**不建任务**） |
   | 8 | assignee 在 registry 且 `present !== false` | `skip:assignee_missing`（**显式失败，不静默**） |
   | 9 | 其余 | `build` |
2. **`observe` 是默认值**，与原型一致（`src/policy.ts:84`）。`observe` 时**不建任务、不派单、不产生任何写盘副作用**，只落一条 `candidate.observed` 事件 + `sources.json` 推进。面板/巡检从事件流读它。
3. **准入判定必须复用既有单点，不得复制**：assignee 是否可派单**复用** `workers/graph/task-ready.mjs` / registry 校验的现有实现（与 D1「复用 `verifier.cjs` 的 gate 函数」同一纪律）。

**契约与事件**：新增事件类型 **`candidate.observed`**（唯一新增），字段 `{task:false, reason:true}`，`author` 用 `source`（见 E4）。**不新增** `candidate.rejected` / `source.tick` 之类——拒绝原因写进 reason 文本，tick 本身不发事件（`superstep.committed` 已覆盖）。

**失败语义**：准入拒绝**不写 `failure.detected`**（那不是失败，是正常筛选）；只有 `assignee_missing` 这种配置错误进 stderr + 事件 reason，仍不影响 tick 退出码 0（无副作用）。

**不做什么**：不做 LLM 语义研判（Assessment）——第一批只用确定性 probe；不做「谁批准了这条规则」的授权对象（那是 E6 级别，见 §7 边界）。

**验收判据**：

```text
① 夹具矩阵：mode=observe / auto × probe 命中 / 未命中 / 超时 / assignee 缺失
   → decide() 返回 action 与 reasons[] 逐格断言（≥8 例）
② observe 夹具 → state/tasks.jsonl 无新增；graph-events.jsonl 新增 1 条 candidate.observed
③ auto + assignee 缺失夹具 → 不建任务；stderr 点名；tick exit 0
④ node tests/source-gate.test.mjs → pass ≥8, fail 0
```

### E3 候选幂等与冷却（P0）

**问题**：见 §2.3。

**决策**：

1. **幂等单位是「窗口」不是「内容」**：同一 source 的同一 `next_fire_at` 窗口**最多产生一个候选**。理由是 probe 是外部不确定命令，内容哈希没有稳定语义；而窗口幂等与 `schedules.json` 完全同构，复用已验证的语义。
2. **同一次超步提交**：`state/tasks.jsonl` append（create）+ `state/sources.json` set（推进 `next_fire_at` / `last_fired_at` / `fire_count`）在**一次 `bus-apply` 调用**里，要么都生效要么都不动（`enqueue-due.mjs:192-238` 是现成范例）。
3. **probe 失败也推进**：超时 / 无法 spawn / 非预期退出 → 记 `unknown:probe_failed`、**照常推进 `next_fire_at`**。否则一个卡死的 probe 会每分钟重试并刷爆事件流。错过多个窗口只补一次（同 schedule）。
4. **冷却与间隔是两个旋钮**：`interval_seconds` 是探测频率，`cooldown_seconds` 是**命中后**的最小建任务间隔；两者独立，允许「每分钟探测、每小时最多建一次」。

**契约与事件**：零新增事件类型（复用 E2 的 `candidate.observed` 与 `task.created`）。`sources.json` 的 `next_fire_at` 是幂等判据的**唯一真相**，不得在别处再存一份。

**失败语义**：`bus-apply` 失败 ⇒ tick exit 1，**不推进、不建任务**，修复后重跑即幂等。

**验收判据**：

```text
① 同一窗口重复 tick（--now 相同）3 次 → 只产生 1 个任务（auto）或 1 条 candidate.observed（observe）
② probe 超时夹具 → tick exit 0；不建任务；next_fire_at 已推进；事件/日志点名 probe_failed
③ bus-apply 注失败夹具 → tick exit 1；state/tasks.jsonl 与 sources.json 均无变化
④ 跨越 3 个窗口后再 tick → 只补 1 个（不雪崩），与 enqueue-due 的「错过只补一次」一致
```

### E4 接线与事件作者（P1）

**问题**：Source 产生的事件要有合法作者；外部触发器要有明确形态。

**决策**：

1. **`EVENT_AUTHORS` 新增 `source`**（`workers/lib/bus-contract.cjs:355`），与既有 `scheduler` 并列。四处同源（见 §5.3）。
2. **外部触发器形态不变**：继续用 Windows 任务计划，`enqueue-due.mjs` 与 `tick.mjs` **各配一条**，不合并成一个入口——职责单一、失败隔离、不重构已验证路径。
3. **建任务时发 `task.created`**（该类型**已注册未发射**，`bus-contract.cjs:330`），`author: 'source'`。这是激活一条已有契约，不是新增类型。

**契约与事件**：唯一新增事件类型是 `candidate.observed`；`task.created` 复用既有定义。**零 schema 变更**（事件 schema 的 enum 需加 `candidate.observed`，属四源同步的一部分）。

**不做什么**：不改 `enqueue-due.mjs` 的现有行为（它发 `schedule.fired`，不发 `task.created`）——两条生成路径事件不对称是**已知并记录**的，留给后续统一，不在本批顺手改已验证路径。

**验收判据**：

```text
① node tests/bus-contract.test.mjs → 现 26 例 → 新增 candidate.observed / author=source 各 1 例后全绿
② auto 夹具建任务后：graph-events.jsonl 恰好新增 1 条 task.created（author=source）
③ node workers/validate-bus.mjs → 0 错误；非法 author=sourcex 夹具 → 报错点名
④ schedule.fired 与 task.created 的不对称已写入 README「事件表」备注
```

### E5 `result.json` 语义增量（P1，**必须与 D3 合并实施**）

**问题**：见 §2.4。

**决策**：

1. `RESULT_STATUS` 扩为五态：`completed | blocked | failed | waiting | dropped`（`bus-contract.cjs:150`）。
2. 语义一致性（在 `validateResult` 末尾追加，与既有 `blocked/failed ⇒ blockers 非空` 并列）：
   - `waiting` ⇒ **必须有** `attention` 字段（结构见下），且 `blockers` 可为空（等回话不是受阻）；
   - `dropped` ⇒ **必须有** `dropped_reason`（一句话，非空）。
3. 新增字段 `attention`：`{ question: string(非空), blocking: boolean, options?: string[] }`——**一个具体问题**，对应原型 `human_action`。
4. `final-state.ps1` 映射：`waiting ⇒ status.state='blocked'`（等人工）；`dropped ⇒ status.state='idle'` 且**不得发 `task.completed`**；其余分支不变。
5. **与 D3 合并实施**：E5 改契约形态（enum + required），D3 的 `extract-result.mjs` 要按新态产出契约 ⇒ **先 E5 定契约、再 D3 写提取器**，同一份 `result.json` 只改一次。**D2 不在此列**：D2 改的是 `usage.finish_reason` / `failure-classify` / `status.json` 终态，全程不碰 `result.json`，因此随批次 0 走（2026-10-29 原 §6 把 D2 与本条捆在一起，属不必要的耦合，本文拆开）。

**契约与事件**：`schemas/result.schema.json` 的 enum 与 required 联动；`bus-contract.cjs` 的 `RESULT_STATUS` 与 `validateResult`；零新增事件类型。

**失败语义**：派单退出码不变。存量 12 份 `result.json` 全部使用旧三态 ⇒ **新态是增量，旧数据零迁移**（但需跑一次 `validate-bus` 回归自证）。

**不做什么**：不搬 `progress` / `ready` 两态——fleet 的 worker 只在结束时写契约，没有「进展」与「就绪」的中间态；`ready` 与 `completed` 在 fleet 语义上等价，硬加会造成两个字段说同一件事。

**验收判据**：

```text
① node workers/validate-bus.mjs → 存量 12 份 result.json 仍 0 错误（新态是增量）
② 夹具：status=waiting 无 attention → exit 1 点名 attention；status=dropped 无 dropped_reason → 同理
③ 夹具：status=waiting + attention{question,blocking:true} → 通过
④ final-state.ps1 夹具：result.status=waiting ⇒ state='blocked'；dropped ⇒ 'idle' 且无 task.completed
⑤ 与 D2/D3 同批交付，三者共用一次回归：dispatch-gate / failure-classify / verifier / extract-result 全绿
```

---

## 4. 不吸收清单

| 项 | 为什么不 | 依据 |
|---|---|---|
| 常驻 daemon / 2 秒 pass | fleet 已确立「搬语义不搬 daemon」（`workers/lib/schedule.cjs:3-8`）；进程托管本身是 fleet 未做项，引入 daemon 等于先把未做项变成前置依赖 | 调研报告 §6.1 |
| LLM 语义研判（Assessment） | 首批只做确定性 probe。引入 LLM 判断要同时引入模型路由、成本预算、超时与不确定性，**与「闸门先廉价后昂贵」相反** | 调研报告 §4-A1 |
| GitHub / 飞书 Source | fleet 不是对外服务。它的真实信号源是**本仓自身**：`verify-all` 红灯、`agent-drift` 漂移、pulse `error`、面板告警——这些信号已经在仓库里，只是没有「变成任务」的通道 | 调研报告 §6.2 |
| Thread / Subscription 直投 | 与「一次性 CLI + 文件总线」形态冲突（无长连接、无实时流）。留作后续，见 §7 边界 | 调研报告 §4-A3 |
| Mandate 授权对象 | 当前「人工派单」本身就是授权；自动建任务后才需要它，而那要配 Policy 版本与重验证，属下一批 | 调研报告 §4-A4 |
| 原型的 Report 五态全盘照搬 | 只取 `waiting`/`dropped`；`progress`/`ready` 在 fleet 无对应语义（见 E5-5） | 本文 §2.4 |
| 改派单器退出码语义 | 脚本 / 桌面端 / 面板依赖 0/2/3/4；tick 自带 0/1/2，互不干扰 | 上位协议 |
| 把 sources 合进 schedules | 「时间驱动」与「信号驱动」是两种触发语义，合一会造成一个文件两套语法 | 本文 E1-3 |

---

## 5. 闸门与同步义务

### 5.1 本设计文档自身

新增一份 design md 只会被两道仓库级闸门咬：`repo/style`（LF / 无 BOM / 末行换行 / 脱敏）与 `repo/md-links`（相对链接必须解析到**已入库**目标）。

- 本文链接了调研报告 `../../dsh-miasaki-shared-docs/dsh-platform/ref-dsh-superagent-prototype-2026-11-01.md`，它必须**先 `git add`**，否则 md-links 的 R2 会红。
- `_refs/` 与未跟踪文件**不能**做链接目标，引用本地材料一律用反引号路径。

### 5.2 实施 E1–E5 的闸门增量

| 决策 | fleet 类别 | 仓库级闸门 | 需要同步的内容 |
|---|---|---|---|
| E1 | **+2 项**（`source.cjs` 单测 + `tick.mjs` 集成） | `silent-guards`（`workers/**` 属构建链：`parseTime` 失败不得静默回退、probe 超时不得吞错）、`style`（新源码） | `scripts/verify-all.mjs` 的 `planFleet()` 登记；`package.json` test 链；README 命令表 |
| E2 | **+1 项**（`source-gate.test.mjs`） | `silent-guards` | 同上 |
| E3 | 扩 E1 集成用例（幂等/超时/跨窗口） | `silent-guards` | 同上 |
| E4 | 扩 `bus-contract.test.mjs` | `silent-guards` | **事件四处同源**：`bus-contract.cjs` 的 `EVENT_TYPES`/`EVENT_AUTHORS`、`schemas/graph-event.schema.json` 的 enum、`tests/bus-contract.test.mjs`、README 事件表 |
| E5 | 扩 `bus-integration` / `dispatch-state` | `silent-guards` | `schemas/result.schema.json`、`RESULT_STATUS`、`validateResult`、`final-state.ps1`、README 契约说明 |

### 5.3 四条同步义务（漏一条就是「静默回收」形态）

1. `scripts/verify-all.mjs` 的 `planFleet()` **显式登记**新检查项（现 32 项；新测试不登记＝永远不跑），并更新 README 的回归清单项数。
2. `dsh-miasaki-fleet/package.json` 的 `test` 链（新测试至少进 `verify-all`；`dispatch-state` / `dispatch-gate` 刻意不在 npm 链上的现状保持不变）。
3. README 的「统一回归」清单 + 「变更记录」节（本线变更记录在 README，不在 `design/CHANGELOG.md`）。
4. `AGENTS.md` / 根 README 的全量基线数字（本设计文档不动，实施时再对账）。

### 5.4 单一真相源纪律（实现时的硬约束）

- **不新增第二套判定**：E2 的 assignee 检查复用 registry 校验；E5 复用 `validateResult`。
- **解析/校验失败必须显式**：`workers/**` 属构建链，`silent-guards` 的 R1/R2/R3 对 `!existsSync` 静默返回、空 catch、静默回退一律判红；确有正当降级须在命中行或紧邻上一行写 `// guard-ok: <理由>`。
- **`next_fire_at` 幂等真相只存一处**：`state/sources.json`，不得在事件或任务行里再存副本。
- **probe 不做副作用**：只读判定；要动手就建任务，由派单器去动。

---

## 6. 实施顺序：D 组 + E 组的统一依赖序（非排期）

### 6.0 本文与 2026-10-29 §6 的关系

GVS5H 批的 §6 只排了 D1–D5 自己的三个批次（A: D1+D2 / B: D4+D3 / C: D5）。本文把它与 E1–E5 **合成一条统一依赖序**，并补上原 §6 没有覆盖的三件事：**D 与 E 之间的交错**、**E5 与 D3 的真依赖**、**D4 与 E4 的事件契约合并**。

**权威口径**：实施时以本节 §6.2 为**总序**，以本文 §3 与 [2026-10-29-gvs5h-harness-absorb-design.md](2026-10-29-gvs5h-harness-absorb-design.md) §3 各决策的验收判据为**细节**。**2026-10-29 §6 的批次表被本节取代**；其批次划分与本文冲突处以本文为准，并在实施该批时同步订正该文档。

### 6.1 三条硬约束

1. **E 排在 D 之后。** `[实测]` D1/D2/D3 全部未实施。若 E 先上线：自动建任务 + 无终态治理 ⇒ **无人值守地批量制造「假完成」结论**。人工派单时人会看结果，自动派单时第一眼没人看。⇒ **批次 0 不可跳过。**
2. **同一份契约只改一次。** `result.json` 的形态（E5）与生成路径（D3）必须同批；`EVENT_TYPES`/`EVENT_AUTHORS`（D4 的 `loop.guard` 与 E4 的 `candidate.observed`/`source`）必须同批——事件契约要跑「四处同源」，分两次改就要同步两遍。
3. **同一文件同一区域不并行改。** `bus-contract.cjs` 被批次 2（result 段）与批次 3（event 段）先后触碰，段不重叠但文件同一；`dispatch-task.ps1` 被批次 0/2/3/4 四次触碰，均在终态段附近。⇒ 这两个文件的使用批次**默认串行**。

### 6.2 统一批次表

| 批次 | 决策 | 依赖 | 收尾判据（命令 + 期望） | 检查项 |
|---|---|---|---|---|
| **0** | **D1 + D2** | 无，可立即开工 | 该设计 §3 D1/D2 各自的判据全过；`fleet` 32/32 | 32 |
| **1** | **E1 + E2 + E3** | **批次 0**（硬约束 1） | `node tests/source-gate.test.mjs`、`node tests/source.test.mjs` 全绿；`tick.mjs --check` 零写盘；同一窗口三连跑只产生 1 个候选；`validate-bus` 0 错误；`fleet` 34/34 | 34 |
| **2** | **E5 → D3**（批内**先契约后提取器**） | 批次 0（D2 已在 0 完成） | 存量 12 份 `result.json` 零迁移；`dispatch-gate` / `verifier` / `extract-result` 全绿；`fleet` 35/35 | 35 |
| **3** | **D4 + E4**（事件契约合并） | 批次 1（E4 需 tick 在场） | 事件四处同源跑绿；`bus-contract` 用例全绿；真实 12 任务台账 `--transitions` 零回归；`fleet` 36/36 | 36 |
| **4** | **D5**（可选） | 无（可随时插队） | `brief-budget.cjs --check` 超限夹具命中但不阻断；`fleet` 37/37 | 37 |

### 6.3 每批的改动清单

| 批次 | 新增文件 | 改动文件 | 数据动作 |
|---|---|---|---|
| 0 | 无（D1 复用 `verifier.cjs` 的 `evaluateGate`） | `workers/dispatch/dispatch-task.ps1`（终态段）、`workers/dispatch/final-state.ps1`、`workers/lib/failure-classify.cjs`、`workers/dispatch/classify-failure.mjs`、`workers/validate-bus.mjs`（`--verdict`） | `tasks/t-0011/verdict.json` 补记（Commander 起草 → Operator 确认） |
| 1 | `schemas/source.schema.json`、`workers/lib/source.cjs`、`workers/lib/source-gate.cjs`、`workers/sources/tick.mjs`、`state/sources.json` | `workers/validate-bus.mjs`（sources 校验）、`scripts/verify-all.mjs`（`planFleet()` +2）、`package.json`（test 链） | 无 |
| 2 | `workers/dispatch/extract-result.mjs` | `workers/lib/bus-contract.cjs`（`RESULT_STATUS` + `validateResult` 语义）、`schemas/result.schema.json`、`workers/dispatch/final-state.ps1`（`waiting`/`dropped` 映射）、`workers/dispatch/dispatch-task.ps1`（代写分支，默认关闭） | 无（新态是增量，存量三态零迁移） |
| 3 | `workers/lib/loop-guards.cjs` | `workers/lib/bus-contract.cjs`（`EVENT_TYPES` +2 / `EVENT_AUTHORS` +1）、`schemas/graph-event.schema.json`、`tests/bus-contract.test.mjs`、`workers/validate-bus.mjs`（`--transitions`）、`workers/dispatch/dispatch-task.ps1`（`evaluateRetryPolicy`）、`workers/sources/tick.mjs`（发 `task.created` / `candidate.observed`）、`README.md` 事件表 | 无 |
| 4 | `workers/lib/brief-budget.cjs` | `workers/dispatch/dispatch-task.ps1`（组装 prompt 前调用） | 无 |

### 6.4 关键路径与并行度

- **必须串行**：`0 → 1 → 3`（E 依赖 D；E4 依赖 E1–E3 的 tick 与事件）。
- **可以并行**：批次 1 与批次 2 文件不重叠（1 碰 `validate-bus`/新增 source 系列；2 碰 `bus-contract` 的 result 段与 `result.schema.json`），可并行推进。
- **默认串行**：批次 2 与批次 3 都碰 `bus-contract.cjs`（不同段）；批次 4 与批次 3 都碰 `dispatch-task.ps1`。若并行，须在**同一提交批次内**做完整回归，不可分两次提交（否则中间态契约半改半不改）。
- **最短关键路径**：`0 → 1 → 3`；批次 2 挂靠在 0 之后任意时点插入；批次 4 随时。

### 6.5 检查项计数账（口径变化不是退化）

| 基线 | 批次 0 后 | 批次 1 后 | 批次 2 后 | 批次 3 后 | 批次 4 后 |
|---|---|---|---|---|---|
| 32 | 32 | **34**（+source 单测、+source-gate 单测） | **35**（+extract-result） | **36**（+loop-guards） | **37**（+brief-budget） |

`[实测]` 与 2026-10-29 §6 的差异：原表终点是 **35**（32 → D3+D4 到 34 → D5 到 35）；本文终点 **37**，多出的 2 项是 E 系列的测试。**分母变大是因为多做了两批事**，不是原基线记错。

### 6.6 每批共同收尾

`node scripts/verify-all.mjs repo` **7/7**；`node workers/validate-bus.mjs` 0 错误；改测试后至少对齐一次 **Node 22.19.0**（本机 Node 24 全绿 ≠ CI 绿）；每批结束更新 README 的「统一回归」清单项数与「变更记录」节。

---

## 7. 风险与回退

| 风险 | 表现 | 处置 |
|---|---|---|
| 自动建任务雪崩 | probe 持续红灯，每轮一个任务 | `observe` 默认 + `cooldown_seconds` + `max_tasks_per_hour` 三重闸；先跑 observe 一周再考虑 auto |
| probe 变成「正则猜 stdout」 | 为判复杂条件去解析日志 | **明令禁止**；判定逻辑写进脚本、结论编码进退出码（E1-3） |
| 第 13 个真相文件 | sources.json 与 schedules.json 职责重叠、被混用 | 边界写进 schema description：schedules = 时间驱动，sources = 信号驱动；同一触发只允许一种 |
| 自动任务被假完成结案 | E 先于 D1/D2 上线 | **顺序硬约束**（§6.1）；批次 0 不可跳过 |
| 事件类型膨胀 | 每加一种触发就加一个事件 | 只新增 `candidate.observed`；建任务复用已注册的 `task.created` |
| probe 有副作用 | 探测命令自己写盘 / 派单 | schema + README 双处明令只读；probe 只允许判定命令 |
| Windows 任务计划未安装 | 与 enqueue-due 同样的现状（设计建议装、实际未装） | 本批只保证「手动/外部触发可跑」；是否装任务计划属部署动作，由 Operator 决定，不在本设计承诺范围 |
| 回头改派单退出码 | tick 与派单器语义被混用 | tick 固定 0/1/2，与派单 0/2/3/4 完全不同域；代码评审逐条核对 |

**回退成本**：E1–E4 全部新增文件 + 一处 `EVENT_AUTHORS` + 一处 `EVENT_TYPES` + README 登记；删除即回退，**不动既有派单链路**。E5 是契约增量（新态），回退需撤 enum 与校验分支，但存量数据不需迁移。

---

## 8. 待拍板决策点（Operator 定稿用）

| # | 决策点 | 建议 | 影响面 |
|---|---|---|---|
| 1 | 是否引入 `state/sources.json` 作为第 13 个真相文件（还是扩 `schedules.json` 加 `kind`） | **新增文件**：两种触发语义不应共用一套必填字段 | 若选扩展，E1/E2/E3 的契约形态需重写 |
| 2 | 首批 `kind` 是否只做 `probe` | **是**（不做 LLM 研判） | 决定是否需要模型路由与成本预算，量级差一个数量级 |
| 3 | `observe` 记录放哪：事件流 `candidate.observed`（新类型）还是独立文件 | **事件流**：不新增真相文件，面板本就消费事件流 | 选独立文件则又多一个真相源 |
| 4 | `enqueue-due` 是否顺带补发 `task.created`（消除两条生成路径的事件不对称） | **本批不改**，记为已知项；后续统一 | 改了要动已验证路径与其测试 |
| 5 | 是否采用 §6.2 的五批统一依赖序（D 组 + E 组共 10 条决策） | **是**（批次 0 不可跳过） | 若要先上 E，则自动任务可能被假完成结案，风险由 Operator 承担 |
| 6 | 外部触发器：两条任务计划并行，还是合并成一条统一入口 | **两条并行**：职责单一、失败隔离 | 合并则 tick 要调 enqueue，耦合两套失败语义 |
| 7 | `hit_when` 首批是否只支持 `exit_nonzero` / `exit_zero` | **是**；更复杂条件写判定脚本 | 放宽会导致 probe 语法膨胀成半个 DSL |

> 拍板后状态：**E1–E5 设计定稿，均未实施**；D1–D5 已于 2026-10-29 拍板定稿、**同样未实施**。实施按 §6.2 的五批统一依赖序推进，**批次 0（D1 + D2）先行**。
