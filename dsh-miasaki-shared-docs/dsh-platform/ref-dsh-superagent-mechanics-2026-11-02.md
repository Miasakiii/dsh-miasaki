# dsh-superagent 机制解读：一个 DSH bundle 的内部运转

- 日期：2026-11-02
- 调研者：总指挥（Miasaki 会话）
- 对象：`deepseek-ai/dsh-superagent-prototype`（v0.1.0，2026-10-31 首发，MIT，官方**研究原型**；截至 2026-11-02 仍为单 commit，`pushed_at` 未变）
- 本地快照：`_refs/dsh-superagent-prototype/`（gitignored **不入库**）。体量 `[实测]`：`src/` 110 个 `.ts/.tsx` 共 14,860 行；`tests/` 59 个 spec 共 13,537 行（目录内共 65 个文件，含 fixtures）；`docs/` 000–008 共 1,431 行；`prompts/` 15 份
- 口径：`[实测]` = 逐文件读盘读到（证据到 `文件:行号` 或文档小节）；`[推断]` = 基于实测事实的判断，未实测；`[存疑]` = 与既有文档冲突或本次未复核
- 姊妹文档（**分工，不重复**）：
  - [ref-dsh-superagent-prototype-2026-11-01.md](ref-dsh-superagent-prototype-2026-11-01.md)：文章 vs 原型对账、A–E 组可迁移清单、fleet 12 维差距、明确不搬项、试跑备忘与 7 条已知缺陷 —— 回答「**值不值得搬、搬到哪**」
  - 本文回答「**它到底怎么运转、为什么这样设计**」：状态机、节拍、事务与并发、幂等、失败与恢复、授权流水线、提示词装配、扩展协议、数据模型、代码阅读地图
- 取证分工：`src/core`（状态机与生命周期）由只读取证员逐文件核查；`src/app` 运行机制与 `src/executor` + `src/sources` 由总指挥与另外两路取证员交叉核对；`[实测]` 行号由总指挥抽查复核，个别仅来自原文档的条目会标 `[推断]`

> **路径约定**：`src/…` `docs/…` `prompts/…` `tests/…` 一律相对本地快照 `_refs/dsh-superagent-prototype/`；因该目录不入库，**刻意不使用 markdown 相对链接**（否则 `repo/md-links` 的 R2「目标已入库」判据会红）。只有本文引用的**已入库**文档才用 markdown 链接。

---

## 0. 五分钟版

1. **形态**：一个 DSH profile 里跑一个 bundle，就一个进程（Web 面板同进程，端口来自 profile 的 `webserver`）、一份 SQLite（`<stateDir>/orchestrator.sqlite`）、一个 2 秒节拍。**没有独立 daemon、没有消息队列服务、没有第二套存储。**
2. **领域核心是「事务门面」**：`Engine`（`src/core/engine.ts`）是 Trigger/Thread/Decision/Ticket/Assignment 的**唯一写者**，25 个写方法各包一个事务；五个内部部件（Intake / Evals / Tickets / Assignments / Replies）对外不可见。`src/core` 零 I/O、零 DSH 依赖。
3. **节拍只有一处**：`Passes` 每 2 秒单飞一拍，一拍只做两件事——`effects.kick()` 与 `engine.evaluateDue()`。所有「决定之后要做的事」先写成 `effect` 行再执行，所以进程重启不会丢活。
4. **状态几乎全是显式枚举**（Report 6 态、Decision 5 态、TicketOutcome 5 态…），但 **Ticket 的「阶段」不是存储字段**，而是 `stage.ts` 里 7 行规则按顺序推导——因为一张票会被交接、恢复、换 Assignment。`[实测]`
5. **幂等有四个单位**：Trigger（内容哈希）、accept（trigger 级）、effect（kind+key 唯一行）、outbox（receipt id 唯一）。任一环重复到达都不会产生第二份副作用。
6. **授权是流水线**：Gate（纯同步确定性）→ strength/basis →（explicit 直接路由，**永不进模型**；inferred 才走 Assessment）→ Mandate（不可变 + Policy 版本快照）→ 恢复前 `revalidate`。
7. **并发分两层**：slot 管 worker（人的消息可越限 +1 槽、唤醒优先于新启动）；effect 队列管投递（按 kind 限流、同 kind 保序、指数退避）。
8. **提示词可编辑，权限不可编辑**：团队文本在 `prompts/` + override 版本化，但 gate、Mandate、工具校验、账号 wrapper 全在代码里；外部文本永远只是数据。

---

## 1. 运行时骨架

`[实测]` 一个进程内五层单向依赖（`docs/007-architecture.md:255-258`）：

```
                 ┌─────────────────────────────────────────────┐
   web 面板 ───►  │ client/  React 面板（3 个 DSH 插槽）          │
                 └───────────────┬─────────────────────────────┘
                                 │ 只取 app 的类型与纯值
                 ┌───────────────▼─────────────────────────────┐
   HTTP 管理 API ►│ app/   组合根 Runtime + Store/Effects/Passes │
   Session 工具 ─►│        Sessions/Prompts/Settings/Assessment  │
                 │        Outbox/views/tools/http               │
                 └───────┬───────────────────────┬─────────────┘
                         │ 端口（ports.ts）        │ 端口
                 ┌───────▼────────┐      ┌────────▼─────────────┐
                 │ core/  Engine  │      │ sources/  SourceKind │
                 │ 5 个部件·零 I/O│      │ executor/ DshExecutor│
                 └───────┬────────┘      └────────┬─────────────┘
                         └──────── 不反向依赖 ─────┘
```

- **组合根**：`Runtime`（`src/app/runtime.ts`）构造全部部件；构造期先锁 stateDir、开 Store；启动顺序是「注册路由 → 跑 Setup → 装 Session/Executor 钩子 → 建主 Session → Policy sync → 恢复被中断的 Assignment → 启动 Passes 与 Effects」，`ready` 标记完成（`docs/007-architecture.md:31-33`）。
- **角色化接口**：调用方拿到的不是完整 Engine，而是 `EngineForSources` / `EngineForMainSession` / `EngineForPeople` / `EngineForSettings` / `EngineForExecutor` 五种 `Pick`（`docs/007-architecture.md:64`）。**能调什么由类型决定，不由提示词叮嘱。**
- **三个插件入口**：`dsh-superagent`（主插件）、`dsh-superagent/github-watch`、`dsh-superagent/feishu-watch`（默认 disabled），由 `cordis.patch.yml` 插入；另注册两个 agent preset（worker/router）。
- **面板**：React，注入 `main` / `sidebar.panellist` / `plugins.row.config` 三个槽，六页 Overview / Source / Trigger / Eval / Execution / Settings。

---

## 2. 节拍：2 秒一拍的心脏

`Passes`（`src/app/passes.ts`）是**唯一的时间源**：

```ts
// passes.ts:28
start(): void { if (!this.stopped) this.timer = setInterval(() => { this.request() }, 2000) }
// passes.ts:56-62  单飞 + 合流：正在跑就登记「再跑一次」，不并发
// passes.ts:63-68  一拍 = effects.kick() + engine.evaluateDue()
```

- 除了定时，这些动作也会**立即请求一拍**：Source 收到 Trigger（`passes.ts:34-38`）、工具调用、设置保存、HTTP 路由（`passes.ts:17-20` 注释）。
- `evaluateDue()` 逐项开事务：到期 Eval 的推进、人消息唤醒的已结束票、待评估 Thread 的启动各占一个事务，**整体不是原子的**（`engine.ts:75-84`）。

| 节拍 / 超时 | 值 | 证据 |
|---|---|---|
| pass 周期 | 2000 ms | `src/app/passes.ts:28` |
| GitHub 轮询 | 默认 60 s（可配 60–3600），实际取 `max(本轮建议, pollSeconds)` | `src/sources/github.ts:25,144` |
| 订阅 Thread 轮询视界 | 14 天（票活着的期间 + 最后事件后 2 周） | `src/sources/poll.ts:6` |
| 轮询重叠窗口 | 5 s（游标 = started − 5000ms） | `src/sources/poll.ts:16` |
| Eval 超时 | 默认 **120 s**（可配 30–600），**从候选送达主 Session 起算** | `src/policy.ts:85`、`src/core/evals.ts:52-53` |
| Eval 连续过期重排 | 2 次（第 3 次记 `unavailable`） | `src/core/evals.ts:19,61-62` |
| effect 默认退避 | 2 s 起，翻倍至 60 s | `src/app/effects.ts:70,141` |
| reply 退避 | 5 s 起，翻倍至 300 s | `src/app/outbox.ts:24` |
| 背景工作上限 | 30 min（到点杀 shell job 并报 waiting） | `src/executor/dsh.ts:32` |
| 停机等待背景工作 | 10 s | `src/executor/dsh.ts:34` |
| prepare 超时 | 10 min | `src/executor/dsh.ts:28` |
| transient 重试 | 3 次，初始 15 s | `src/executor/dsh.ts:30` |

`[推断]` 这套节拍的意义：**它用「一拍两秒 + 持久 effect 队列」替代了消息中间件**。代价是最坏 2 秒延迟与「单进程单写者」，换来的是零外部依赖与崩溃可恢复。

---

## 3. 状态与枚举全表

`[实测]` 除 Eval 外都有具名枚举；**Eval 没有状态字段**，靠 `delivered? / pausedAt? / deadline / expired?` 表达。

| 概念 | 取值 | 证据 |
|---|---|---|
| Strength（准入强度） | `explicit` ｜ `inferred` | `src/core/model.ts:96` |
| AdmissionCell | `listedUnaddressed` ｜ `unlistedAddressed` ｜ `unlistedUnaddressed` | `src/core/model.ts:98` |
| AcceptMode | `off` ｜ `observe`（默认）｜ `auto` | `src/core/model.ts:103` |
| MandateBasis.via | `addressed` ｜ `followup` ｜ `admission` ｜ `listed` ｜ `bot` | `src/core/model.ts:116-122` |
| DecisionKind | `ignore` ｜ `accept` ｜ `reopen` ｜ `stop` ｜ `unavailable` | `src/core/model.ts:190` |
| AssignmentState | `pending` ｜ `running` ｜ `ended` | `src/core/model.ts:211` |
| ReportState | `progress` ｜ `waiting` ｜ `ready` ｜ `blocked` ｜ `failed` ｜ `dropped` | `src/core/model.ts:216` |
| TicketEndBy | `executor` ｜ `human` | `src/core/model.ts:271` |
| TicketOutcome | `completed` ｜ `merged` ｜ `closed` ｜ `dropped` ｜ `stopped` | `src/core/model.ts:273` |
| TicketStage | `person/{delivery,answer,review,blocked,failed}` ｜ `working{/queued}` ｜ `idle` ｜ `ended` | `src/core/stage.ts:5-6` |
| TicketInput.kind | `trigger` ｜ `policy-changed` ｜ `reopen` ｜ `resumed` ｜ `text` ｜ `note` | `src/core/model.ts:237-257` |
| ReplyRequest.purpose | `acknowledgement` ｜ `answer` ｜ `result` ｜ `attention` | `src/core/replies.ts:15-16` |
| OutboundMessage.kind | `acknowledgement` ｜ `reply` ｜ `notice` | `src/core/ports.ts:72` |
| ReplyStatus | `pending` ｜ `sent` ｜ `dropped` | `src/core/ports.ts:74` |
| AssessmentOutcome.kind | `ignore` ｜ `unavailable` ｜ `accept` ｜ `stop` | `src/core/ports.ts:40-46` |
| TriggerDisposition（字段集合） | `filtered?`、`evalId?`、`decisionId?`、`fanout[]`、`context?`、`requeued?`、`handbacks[]`、`acked[]`、`at` | `src/core/model.ts:42-61` |

**两处「名义存在但实际不写」的枚举** `[实测]`：

- `DecisionKind.reopen` 与 `TicketInput.reopen` 是**遗留死枚举**：core 只写 `ignore/accept/stop/unavailable`（`src/core/evals.ts:291-303`），reopen 只剩类型、面板过滤（`src/client/api.ts:102`）与迁移/SQL 引用；迁移已把它转成 `text`（`src/app/migration.ts:364`）。
- `TicketInput.reopen` 同理，只有旧数据里才有。

---

## 4. Ticket 阶段机：7 行推导，不是状态字段

`[实测]` 面板看到的「等谁、在做什么」不是存下来的，是每次从事实推导的。规则来自 `docs/003-execution.md:11-17`，实现是**顺序 if + 提前 return**（`src/core/stage.ts:9-21`）：

| 序 | 条件 | 阶段 |
|---|---|---|
| 1 | `ticket.ended` | `ended` |
| 2 | `ticket.delivery`（Input 投递失败） | `person/delivery` |
| 3 | `ticket.attention`（有待答问题） | `person/answer` |
| 4 | 最新 Assignment 的 report 为 `ready` | `person/review` |
| 5 | report ∈ {`blocked`,`failed`} 且 `waitsForPerson` | `person/blocked` 或 `person/failed` |
| 6 | 无 Assignment 或 `state==='pending'` | `working/queued` |
| 7 | report 为 `waiting` 或 Assignment 已 `ended` | `idle` |
| — | 兜底 | `working` |

- `waitsForPerson` 只看**最新** Assignment 的 report，且要求此后没有「人的、非 context 的」Input（`src/core/model.ts:349-352`）。
- `canRetry = !ended && (waitsForPerson || !!delivery)`（`src/core/stage.ts:24-26`）——重试入口只在这两种停法上开。
- 为什么不用状态字段：票可以被交接、由不同 Assignment 运行、结束后再唤醒（`engine.ts:70-95`），一个存储状态字段迟早会与 report/assignment/Input 三类事实打架。

---

## 5. 一次请求的完整时序

`[实测]` 以 GitHub 评论 `@agent 做 X` 为例，标注「事务 / 异步」边界：

1. **Source 轮询**（60s 一拍）读到新评论 → 构造 Trigger。id 来自内容哈希（见 §7）。
2. `Engine.receive(trigger)`（**一个事务**）：先查 id → 已存在返 `duplicate`；不收听则落 `filtered` 并记 Source 的原因码；否则落 Trigger + disposition（`src/core/intake.ts:23,27,61`）。
3. `Intake` 在同一事务内向该 Thread 的**订阅票扇出**（带上下文、不带权限）；若是人的消息且已达某票，则那条票直接 `wake` 恢复，不进 Eval；否则把 Trigger 放进 `thread.pending`。
4. **下一拍**（≤2s）`evaluateDue()`：Thread 无 `evaluating` 则开一个 Eval，把 pending 里积压的 Trigger **整批**合并（同 Thread 串行、跨 Thread 并行）。
5. **Gate**（纯同步）定强度与依据：`strength` + `MandateBasis`（`src/policy.ts:191-212`）。
6. **explicit**：不评估，卡片投主 Session，用 `orchestrator_route` 直接路由（`src/app/assessment.ts:113` 对 explicit 直接抛错改走路由）；**inferred**：入 `assessment` effect → 候选送达主 Session → `candidateDelivered` 时**截止时间才起算**（`src/core/evals.ts:52-53`）。
7. 主 Session（模型）用 `orchestrator_eval / read / decide` 研判，产出 Decision。
8. **accept（一个事务）**：建 Decision → Mandate（含 policyVersion）→ Ticket（id = `key('ticket', evalId)`）→ 订阅 → 首 Assignment（`pending`）→ 回执（`src/core/evals.ts:306-316`、`src/core/tickets.ts:51-54`、`src/core/replies.ts:44`）。
9. `launch` effect 启动：`launchQueued` 三查（活票 / 最新 / pending，`src/executor/dsh.ts:271-273`）→ **同步 reserve 槽位**（`:274`）→ 目录不存在才跑 `prepare`（在票目录父目录 `sh -c`，10 分钟超时；成功后 `verifyDirectory` 查本仓 credential / `http.extraheader`，`:249-261`）→ `sessions.ensure`（先 resolve、仅 `session/not-found` 才建）→ 清 inbox 重复 → 首条投全文、后续只发简报 → `prompt(..., 'queue')` → `assignmentStarted`（`src/executor/dsh.ts:425-469`）。票目录名 = `<短名>-<ticketId 前 12 位>`（`:57,99`）。
10. `assignmentStarted` 把 Assignment 置 `running`（唯一写点 `src/core/assignments.ts:38`；该调用实际发生两次，靠幂等掩盖）→ 待投 Input 经 `delivery` effect 逐条 `steer` 送入（`src/executor/dsh.ts:290-343`）。
11. worker 一轮结束：要么调 `orchestrator_report` 回传结构化 Report，要么被 `workerIdle` 按 Session 最后一条 assistant 文本**补记**一条 `waiting`（见 §16-1）。
12. `engine.report`（一个事务）落 Report / 提问 / `ready` 结束判定；`reportRelay` 把问题或报告转成主 Session 消息（`relay`/`notice` effect，保序）。
13. 对外说话只走 **Outbox**：`reply` effect → `SourceRegistry.send` → 渠道 `send`，receipt 先落库、同票同会话严格保序（`docs/003-execution.md:177-191`）。
14. 结束：`ready` 且无待收 PR → `completed`；PR 全部关闭 → 以最后一次关闭结果 `merged/closed`；`dropped` → 静默结束；人 stop → 撤 Mandate。结束**不删订阅**，人再评论可直接 resume（`src/core/tickets.ts:345-363`、`docs/002-authorization.md:125-129`）。

---

## 6. 并发与原子性

### 6.1 单写者

`[实测]` 官方文档把它写成一张表（`docs/007-architecture.md:259-271`），要点：

| 状态 | 唯一写者 |
|---|---|
| Trigger / Thread / Decision / Ticket / Assignment | `Engine` |
| Source 的读位与 Thread meta | 该 Source，经 `SourceContext` |
| 设置与历史 / 提示词版本 | `Settings` / `Prompts` |
| effect 行 | `Effects` |
| outbox 回执 | `Outbox` |
| 健康条目 | `HealthBoard`，**拒绝第二次认领**（`src/infra/health.ts`） |

### 6.2 事务

- `Engine` 的 25 个写方法**各包一个 `repo.atomic`**（`src/core/engine.ts:48,55,64,100,110,127,135,140,145,150,155,160,166,175,182,190,194,198,207,215,221,228,239,246,256`）；`candidate` 只读；`evaluateDue` 例外——逐项开事务。
- **端口在事务内排队、适配器在提交后执行**：`ports.ts:59-69` 的 Executor 三方法只 enqueue，真正跑由 effect 处理器在 commit 后做（`docs/007-architecture.md:48`）。
- 「先落盘再做」的典型点：建票→启动（`tickets.ts:51→54`）、retry（`176→177-178`）、结束→通知（`359→362`）、accept→ack（`replies.ts:44`）。

### 6.3 两层并发

- **worker slot**（`src/executor/dsh.ts:171` 的 `WorkerSlots`）：`starting` 是 `Map<ticketId,'launch'|'wake'|'person'>`，`used()` = running ∪ starting；`reserve` 在 `used >= max + (by==='person' ? 1 : 0)` 时抛 `Later`（5 s 后重排，`:171-198,233`）——**人的 +1 槽是真实的越限**。`launches()` = max − |running ∪ 非 launch starting|，所以唤醒与人的消息会先挤掉新 launch；慢 prepare 只拖自己的票。
- **谁算「人」**：`fromPerson` = 人的非 context Trigger **或任意 `text` 输入**（`src/executor/dsh.ts:38`）——状态查询也是 `text`，所以它也吃 +1 槽（`src/core/tickets.ts:153`）。
- **effect 队列**（`src/app/effects.ts`）：
  - 入队在调用方事务内 upsert（`:61-66`），dispatch 走微任务、只在 commit 之后真正执行（`:84-88`；`Store.atomic` 是同步 savepoint，`src/app/store.ts:140-153`）。
  - 每个 `kind+key` 只有一行；同一 waiting key 再入队只**替换 payload、立即到期、保留原队列位置**（`docs/007-architecture.md:168`）。合并键：assessment=evalId、launch=assignmentId、delivery=ticketId、relay=requestId、notice=名称、reply=messageId（`src/app/effects.ts:11-24`）。
  - 成功按 `(kind,key,seq,generation)` 删行；同 key 正在跑不重入；`generation` 防止「跑老行时删掉刚被更新的新行」（`src/app/effects.ts:38-39,63,107,113,134-135`）。
  - 按 kind 限流（assessment 4 / launch 槽位数 / delivery 4 / relay 1 保序 / notice 1 保序 / reply 1），**ordered 会把 limit 夹成 1**（`:71,108-113`）；最老一行未到期也会堵住同 kind 后续。
  - 失败按 `min(上限, 基数·2^min(attempts,16))` 无限重试（`:140-143`）；抛 `Later` 只按初始退避重排且**不计数**（`:138-139`）；停机不动行，留待下次启动（`:136-137`）；`MAX(attempts) >= 3` 就把该 kind 的健康项标红（`:151-159`）。

---

## 7. 幂等：四个单位

| 单位 | 键 | 重复到达时 | 证据 |
|---|---|---|---|
| Trigger | `sha256(JSON.stringify(values))` 前 32 hex | 返 `duplicate`，**先于**过滤与扇出，不重扇出 | `src/core/ids.ts:3-5`、`src/core/intake.ts:23` |
| accept | trigger id | 同一 Trigger 只建一张票（ticket id = `key('ticket', evalId)`） | `src/core/evals.ts:311` |
| effect | `kind + key` 单行 | 替换 payload、立即到期、保序 | `docs/007-architecture.md:168` |
| outbox | receipt id | 先落 receipt 再发；同 id 不会排第二次 | `docs/007-architecture.md:463`、`src/core/replies.ts:57-60` |

Trigger id 的实际构成（Source 侧）`[实测]`：评论 = `('github-comment', html_url 或 github:<n>, id, updated_at)`（`src/sources/github-trigger.ts:68`）；Issue/PR 正文 = `('github-issue', number)`（**不含正文与时间**，`:84`）；CI = `('github-ci', branch|number, revision)`（`:99,104`）；飞书 = `('feishu', messageId)`（`src/sources/feishu-trigger.ts:18`）。

**同一层还散着几处小幂等**：Input 按 `input.id` 去重（`src/core/tickets.ts:235`）；ticket id 幂等于 eval id（`src/core/evals.ts:311`）；`wake` 每次读最新票状态，因此可重入（`src/core/tickets.ts:253`）。

**游标**：所有 Trigger 都 `await receive` 完成后才推进，推进值 = newest − 5s 且只前进；中途停止抛错不推进（`src/sources/github.ts:224-245`）。5 秒重叠由 Trigger id 去重吸收（`src/sources/poll.ts:16`）。

---

## 8. 失败分类、退避与恢复

### 8.1 按 kind 的退避与终态

`[实测]`（`docs/007-architecture.md:172-181` + 代码常量）：

| effect | 并发 | 暂停时 | 退避 | 失败终态 |
|---|---|---|---|---|
| `assessment` | 4 | 0 | 2 s → 60 s | 候选退回/记健康 |
| `launch` | 空闲槽位 | 0 | transient：5 s → 300 s，3 次 | 非 transient 直接判票 `failed` |
| `delivery` | 4 | 0 | 2 s → 60 s | 显示在票上（不进系统问题） |
| `relay` | 1 保序 | 继续 | 2 s → 60 s | 同类后续被挡 |
| `notice` | 1 保序 | 继续 | 2 s → 60 s | 同上 |
| `reply` | 1 | 0 | 5 s → 300 s | 连续 3 次失败成为系统问题 |

### 8.2 分类规则

- **transient**（可重试）：模型 provider / 网络 / HTTP 408、429、5xx / 连接被拒、重置、超时；launch 重跑、worker turn 续跑（15/30/60 s，3 次）；**prepare 失败不重试**（`docs/003-execution.md:124`、`src/executor/dsh.ts:30`）。
- **Eval 超时**：未送达的 Eval **永不超时**（`src/core/evals.ts:43`）；送达后超时 → 重排（最多 2 次）→ 第 3 次记 `unavailable{timeout}`（`:19,61-62`）；`unavailable` 会进 `evals` 健康项，面板 24 小时内提示人处理（`docs/002-authorization.md:149-155`）。
- **Source 失败**：单条读取失败留在该 Thread、下轮重读；连续 N 次轮询失败才报 Source 错误（默认阈值可配，`src/sources/github.ts:49,123-125`）；404 也重试（可能是失去私有库权限）；持续失败的 Issue/PR 一天后丢弃（`docs/003-execution.md:162-174`）。
- **Channel 失败**：同票同会话严格保序，前一条连续失败 3 次才放行后续；只有「会话消失 / 永不达」才 drop 并留记录（`docs/003-execution.md:175-191`）。

### 8.3 恢复语义

`[实测]` 三件事决定了「崩溃后还能不能接着跑」：

1. **stored work**：决定后要做的事先写成 effect；重启后继续处理（`docs/003-execution.md:153-161`）。
2. **Assignment 中断**：运行中的 Assignment 以 "host restarted" 结束，新 Assignment 带 **recovery note** 提醒先查目录 / git 历史 / GitHub 再重复外部动作，从最老的票开始（`docs/003-execution.md:144-152`）。
3. **已读判定**：消息被 Session 取进 step **且**随后有 Report 或轮次结束才算「已读」；被 cancel/error 截断的算未读，重试时重投（`docs/003-execution.md:150-152`、`docs/007-architecture.md:85-86`）。

**Pause 语义**：暂停时停派单、停新 Eval、停 Eval 超时、停投递与回复；已在跑的 worker turn 不打断；Source 继续记账；Eval 截止时间在恢复时整体后移（`docs/003-execution.md:192-200`）。

---

## 9. 授权流水线（代码级）

`[实测]` 一条 Trigger 只有两条路：

```
Trigger ─┬─► Gate（纯同步确定性）──┬─ explicit ──► 主 Session 直接 route（永不进模型）
         │        src/policy.ts:191 │
         │                          └─ inferred ──► Assessment（模型）→ Decision
         └─► Subscription 扇出（绕过 Gate，**不授新权**，只给上下文）
```

- **Gate**：输入 Trigger + Thread + 该 Thread 上的票，输出强度与依据（`src/policy.ts:191-212`）；强度只有 `explicit / inferred`，**没有第三种**，bot 永远最高 `inferred`（`docs/002-authorization.md:46-54`）。
- **准入表**：每个收信范围一行、最多三格（名单内未 @ / 名单外已 @ / 名单外未 @），各格选 `explicit` / `inferred` / `ignore`（`docs/002-authorization.md:58-75`）。
- **accept mode**：`off` 下 inferred 不成候选；`observe` 下照常评估但正评落成 `ignore + would accept`；`auto` 才真接单（`src/core/model.ts:103`、`docs/002-authorization.md:91-101`）。
- **Mandate**：`{strength, policyVersion, basis, actor, scope}`，不可变（`src/core/model.ts:126-133`）；版本 = 规则 + accept mode + 各 Source 的 Policy 部分，前缀常量 `mandate-v3`（`src/policy.ts:111,116`）。
- **只有三个操作能改变 Mandate**：accept 创建、人 stop 撤回、revalidation 失败撤销（`docs/002-authorization.md:129`）。
- **恢复前 revalidate**：按 basis 逐类重算（addressed 通过；inferred 需 auto + 规则仍启用；admission 需今日表格仍给到原强度；bot 需仍在机器人名单；其余需人仍在名单）（`src/policy.ts:213`、`docs/002-authorization.md:131-141`）。
- **Policy 变更**：不撤销在跑的票；`policyEffects` 算出受影响的票，逐票投递一条 `policy-changed` Input（规则变了 / 请求人不再有权限 / 主动工作不再被接受），运行中的 Eval 丢弃并重排（`src/policy.ts:155-158`、`docs/002-authorization.md:107-117`）。

**三条反直觉**（`docs/002-authorization.md:143-145`）：① 人在 Thread 里说 "stop" 只是普通 Trigger，由 Eval 判；**面板的 Stop 才是命令**。② 订阅扇出能到票，但**永不授予权限**。③ Eval **从不等待**——「等 N 小时无人处理」这类条件应该写成一个新的 Source 自己轮询，而不是让 Eval 挂起。

---

## 10. 提示词机制

`[实测]` 系统提示按固定顺序拼装（`docs/004-prompts.md:46-59`）：

1. 共享指令 + 角色 → 2. 团队三段（Communication / Ticket scope / Delivery requirements）→ 3. 订阅与回复 → 4. Dispatch（主 Session）或工作指令（Executor）→ 5. `runtime/admission`（仅主 Session）→ 6. 交接 → 7. `runtime/environment` → 8. `runtime/policy`（仅主 Session）。

- **可覆盖的 key（五组）**：`runtime/{shared,orchestrator,worker}`、`runtime/{subscriptions,replies,dispatch,work,admission}`、`runtime/handoff/*`、`skill/{feishu,github}`、生成段 `runtime/{environment,policy,policy/none}`（`docs/004-prompts.md:20-34`）。
- **生成段每次模型请求重算**：Policy 段（版本/模式/规则清单）排在**最后**，所以改规则只影响尾段文本，前面的提示词缓存不失效（`docs/004-prompts.md:59`）。
- **强弱五档**：工具与 host 强制的事实 > 内置/生成段 > 主动票命中规则 > 团队文本与技能 > **外部文本（消息、评论、文档、引用）——永远是数据**（`docs/004-prompts.md:65-71`）。
- **override 版本化**：每次保存生成不可变版本；升级后默认值变了会在面板标 **Default updated** 并给 diff，团队可「保留我的 / 用新默认」（`docs/004-prompts.md:38-41`、`docs/007-architecture.md:227-231`）。
- **门禁仍在代码**：「编辑某段只改变模型读到的指令，不改变 gate、Mandate、工具校验或账号 wrapper」（`docs/004-prompts.md:36`）。
- **角色分工**：主 Session 只路由（路由注记 ≤30 词、不读代码、不做技术决定）；Executor 才读源码、实施、验证（`docs/004-prompts.md:73-90`）。主 Session 的 `noWait` 守卫拒绝 `sleep`、`timeoutMs > 30s`、job 等待 > 5s（`docs/007-architecture.md:513`）。

---

## 11. 执行环境与隔离边界

`[实测]` 三层，全是 **POSIX 假设**：

1. **命令 shim**：`<stateDir>/worker-bin/` 下原子写 `#!/bin/sh` + marker + body（`chmod 0o755`），拒覆盖外来文件；每条 shim 先把自身目录从 `PATH` 剔除再 `exec` 真程序。`gh` → agent CLI、`lark-cli` → bot CLI、被禁命令的 shim 直接失败（`src/infra/environment.ts:61-69,79-105`、`docs/006-deployment.md:222-227`）。
2. **独立 git 配置**：`worker-gitconfig` 用 `useConfigOnly` 断掉用户配置、credential helper 写成 `!<quoted cli> auth git-credential`、SSH 地址重写为 HTTPS、定义 Git LFS filter（`src/infra/environment.ts:23,106-115`、`docs/006-deployment.md:225`）。
3. **进程环境**：Setup 会直接改**当前进程**的 `process.env`（前置 worker-bin、删/设变量），返回恢复闭包；校验失败当场 restore（`src/app/setup.ts:92-95`），优雅停机最后一步 restore（`src/app/runtime.ts:244-246`），**异常退出会污染整个 DSH host**。host 自身的命令调用用不带 shim 的 PATH（`src/app/setup.ts:34,38`）。

**明确不是安全边界**：`docs/003-execution.md:78-80` 与 `docs/006-deployment.md:19` 自述 wrapper 与目录只建立默认值——worker 仍可按绝对路径执行程序、读 operator 的 home。要隔离只能上独立 OS 账号。

**Windows 断层** `[实测]`：shim 是 `#!/bin/sh`、`prepare` 走 `['sh','-c',cmd]`（`src/executor/dsh.ts:254`）、`stateDir` schema 要求绝对路径以 `/` 开头——`C:/…` 直接被拒；服务脚本还是 Python + `fcntl` + `tmux`。本机**无原生路径**（详见姊妹文档 §8）。

---

## 12. 扩展协议：新增一个 Source

`[实测]` `SourceKind` 协议（`src/sources/kind.ts`，`docs/007-architecture.md:185-195`）：

| 类别 | 成员 | 用途 |
|---|---|---|
| 必填 | `kind` / `title` / `description` / `schema` / `fields` / `health`（`src/sources/kind.ts:87-96`） | 身份、配置校验、设置表单（`FieldSpec` 见 `:16-22`）、健康项 |
| 可选 | `facts` | 给 Thread 展示的事实（如 issue 号、CI 结果） |
| 可选 | `scope` | 归一化收信范围 → `{listened, observed, row?}`；缺省 `listened:true, observed:false`（`src/sources/registry.ts:131`） |
| 可选 | `channel`（`allowed` / `send` / `link`） | 能不能写、怎么写、怎么取链接 |
| 可选 | `threadContext`（`messageId` / `read` / `images?` / `image?`）+ `repliesTo` | 给评估与 worker 读的 Thread 上下文 |
| 可选 | `find` / `policy`（`schema/fields/explicit/unnamed?/rows?/sync?`） / `environment` / `refreshLabels` | 搜索、授权表、执行变量、显示名刷新 |

GitHub 与飞书的 `policy.schema` 各自定义 `allowed`（名单）与 `bots`（可选机器人名单；GitHub 允许 `xxx[bot]`、飞书允许 `cli_/ou_` 前缀）（`src/sources/github.ts:71-73`、`src/sources/feishu.ts:76-77`）。

- **入口形态**：插件 `inject` 宿主服务 `orchestrator`，拿到 `SourceHost`（registry + `context(kind)`），再取更窄的 `SourceContext`（`docs/007-architecture.md:193`）。两个 `ctx.effect`：注册 kind、起轮询循环；abort 贯穿、异常报健康。
- **登记六到七处**（漏一处就是「静默不生效」）：① 新模块里 `sources.register(kind)`；② `tsdown.config.ts` 的 entry；③ `package.json` 的 `exports`；④ 包内 `cordis.patch.yml` 的 `insert`（先 disabled）；⑤ profile 里启用；⑥ 把模块与 spec 补进 `docs/007-architecture.md` 的模块表/测试表（`tests/docs.spec.ts` 会查两张表完整）；⑦ 新游标键写进 `src/kv.ts`（`tests/store.spec.ts:133` 钉死字面量只能出现在注册表）。依据：`docs/008-cookbook.md:252-268,322,334-353`。
- **core/app 业务代码零改动**：耦合全经 `kind → SourceRegistry → SourceContext`，core 只认识 `Trigger` / `ScopeResult` / `OutboundMessage`；设置表单由 `fields` 生成、策略由 kind 的 schema 校验。
- **但有两个硬例外，另有一条专有能力不自动获得**：`src/kv.ts` 的键表必须动；若 Source 需要部署期账号探测，还要改 `src/deployment.ts` 的 `SETUP_FIELDS`（`docs/008-cookbook.md:78`）；GitHub/Feishu 专有的读取（链接解析、`readRepositoryPath` 等）不会自动获得（`docs/008-cookbook.md:125`）。

`[推断]` 这是本仓最值得抄的架构范式：**「加一个平台」= 实现一个协议 + 登记六到七处**，而不用改核心。

---

## 13. 数据模型与 stateDir

`[实测]` 单 SQLite、WAL + `synchronous=FULL`（`src/app/store.ts:64`）；库文件 0600（`src/app/store.ts:63`）、stateDir 0700（`src/app/runtime.ts:91`），启动时先 `proper-lockfile`（stale 30 s）锁 stateDir 再开库（`src/app/runtime.ts:93,98`）。**8 张业务表 + `kv`**（`src/app/store.ts:64,71-87`）：

| 表 | 存什么 |
|---|---|
| `trigger` | Trigger 本体（时间以 ISO 文本存，可直接比大小） |
| `disposition` | 每条 Trigger 的去向：过滤原因、Eval/Decision、到达的票、重排、交还、回执 |
| `trigger_thread` | Trigger↔Thread 多对多（含 `human` 位），时间线分页靠 `<at>|<id>` 游标 |
| `thread` | 订阅、context 票、待评估队列、进行中的 Eval、连续过期计数、meta |
| `ticket` | 票 + Mandate + origin + execution + assignments + inputs + follows |
| `decision` | 评估结论（按 Thread 索引） |
| `outbox` | 每条对外消息的 receipt（`pending/sent/dropped`），同 id 不二次入队 |
| `effect` | 持久副作用队列（kind/key/payload/seq/attempts/error/due） |
| `kv` | 其余全部记录（设置版本、提示词版本、主 Session id、Source 游标…） |

- **生成列 + 部分索引**把「活跃集」变成索引查询：`thread.active/subscribed`、`ticket.open/active`，pass 只扫活跃行（`src/app/store.ts:102-116`、`docs/007-architecture.md:466`）。
- **KV 家族**（`src/kv.ts:23-57`）：`store.schema`、`settings.*`、`prompts.*`、`runtime.masterId`、`sessions.prompts`、`queues.*`、`sources.labels`、`github.*`（cursor/stream/retry/ci）、`feishu.*`（chats/history/topics/seen/initialized）。
- **会话 id**：主 Session = `orchestrator-<sha256([stateDir]) 前 32 位>`，持久在 KV `master-id`（`src/app/runtime.ts:104-105`、`src/core/ids.ts:3-5`）；worker = `worker-<ticketId>`，可从 id 反解回票（`src/executor/dsh.ts:24,26`）。`resolveAgent` 先解析、**仅 `session/not-found` 才新建**，所以重启自动接回原 Session（`src/app/sessions.ts:140-147`）。
- **配置热更新的唯一重启判据**：`setupChanged(old, settings) || !setup.configured()`；`setupChanged` 只比较 GitHub 的 `repository`/`cli` 与飞书的 `cli`（`src/app/settings.ts:176`、`src/app/setup.ts:16-18`）。其余块热生效；`stateDir` 只能改配置重挂，且参与主 Session id 的哈希。
- **stateDir 布局**：`orchestrator.sqlite`、`worker-bin/`、`worker-gitconfig`、`work/`（票目录根）、锁文件；日志与控制文件在 checkout 的 `.artifacts/`（`docs/006-deployment.md:126-129`）。
- **无界增长**：官方自述旧记录从不清理——trigger/disposition/decision、已结束票、outbox 回执、KV 里所有设置/提示词版本都会涨（`docs/007-architecture.md:484`）。

---

## 14. 代码阅读地图

`[实测]` 建议按「先读能定义系统的，再读驱动它的」：

| 顺序 | 读什么 | 为什么 |
|---|---|---|
| 1 | `docs/000-philosophy.md` → `001-domain.md`（33 + 12KB） | 概念与「被否决概念」表，比代码更快建立边界 |
| 2 | `src/core/model.ts` + `stage.ts` + `ids.ts` | 全部类型与阶段机；`stage.ts` 只有 26 行 |
| 3 | `src/core/ports.ts` → `engine.ts` | 端口、角色化 Pick、25 个事务写方法 |
| 4 | `src/core/{intake,evals,tickets,assignments,replies}.ts` | 五个部件的生命周期（tickets 27KB 最大） |
| 5 | `src/app/passes.ts` → `effects.ts` → `store.ts` | 节拍、持久队列、持久化，三份合起来就是「运行时」 |
| 6 | `src/executor/dsh.ts`（47.6KB，全仓最大） | slot、prepare、Session 驱动、workerIdle |
| 7 | `src/sources/kind.ts` → `registry.ts` → `poll.ts` | 扩展协议本体 |
| 8 | `src/app/sessions.ts` / `delivery.ts` / `assessment.ts` | Session 复用、投递、评估 |
| 9 | `docs/008-cookbook.md` | 以「加一个 Source」串起全部扩展点 |
| 10 | `src/client/*` | 面板；先看 `app.tsx`（页头/搜索/路由）与 `provider.tsx` |

- 体量前三：`src/executor/dsh.ts` 47.6KB、`src/app/migration.ts` 46.2KB、`src/sources/github.ts` 34.8KB。
- **测试即文档**：59 个 spec / 13,537 行，与源码近 1:1；`runtime.spec.ts`（142KB）、`core-engine.spec.ts`（107KB）、`sources.spec.ts`（103KB）是三个「行为字典」。
- 另有**元测试**：`tests/docs.spec.ts` 检查文档编号连续、只许链更早的文档、007 两张表双向一致；`tests/class-docs.spec.ts` 要求每个 class 紧邻 JSDoc；`tests/model-surface.spec.ts` 钉住模型可见面。

---

## 15. 十二组反直觉与设计取舍

1. **没有 Principal / Membership 实体**：一个人只是 Trigger 的元数据；名单是某个 Source 的 Policy 一部分；跨 Source 身份映射是**提示词文本**（`docs/001-domain.md` 的 Rejected concepts 表）。
2. **Thread 里的 "stop" 不是命令**：它是普通 Trigger，只有 Eval 能判定「强度为 stop」；面板 Stop 才是直接命令（`docs/002-authorization.md:143-144`）。
3. **Policy 变更不撤单**：只给受影响票投 `policy-changed` Input，Mandate 保持不变（`src/policy.ts:155-158`）。
4. **Ticket 状态自持**：票可以被交接、恢复、由不同 Executor 跑；Session 只是实现细节（`docs/001-domain.md`）。
5. **`observe` ≠ 只读**：照常评估、照常写 Decision，只把正评落成 `ignore + would accept`（`docs/002-authorization.md:98`）。
6. **订阅能扇出、永不授权**：订阅直投绕过 Gate，但只加上下文（`docs/002-authorization.md:20`）。
7. **Eval 无状态 + Thread 串行 + Trigger 幂等**：批处理自然（积压合并），不需要分布式锁（`src/core/evals.ts`）。
8. **人优先**：槽满时人的消息走额外 +1 槽并优先拿下一空槽（`src/executor/dsh.ts:188,303`）。
9. **先落盘再做**：所有决定后的动作先写 effect 行（`docs/003-execution.md:153-161`）。
10. **文本可编辑、权限不可编辑**：overrides 只改模型读到的字，不改 gate（`docs/004-prompts.md:36`）。
11. **文档即契约**：`tests/docs.spec.ts` 把「编号连续、只链更早、模块表双向一致」变成红绿灯。
12. **阶段是推导值**：不是存储状态，避免与 report/assignment 打架（`src/core/stage.ts`）。

---

## 16. 机制层陷阱清单

`[实测]` 以下都是从代码里读出来的（对姊妹文档 §8 的机制补充；**不代表产品级结论**，是研究原型的自我暴露面）：

| # | 现象 | 证据 |
|---|---|---|
| 1 | `workerIdle` 补记 `waiting`：worker 忘了 report 时拿 Session 最后一条 `assistant/message` 文本当 summary；没有就写死「Worker ended without a status report…」⇒「忘了报」与「真等待」数据上不可分 | `src/executor/dsh.ts:601,659-669` |
| 2 | 阻塞/失败期间自动输入**被丢弃而非暂缓**：等人工时新自动输入不进 `undelivered`，report 时再把队列中的自动输入**滤出**，且没有代码加回（文档措辞 "recorded but not delivered" 易读成暂缓） | `src/core/tickets.ts:238`、`src/core/assignments.ts:126` |
| 3 | `prepare` 幂等只靠「目录存在」：失败留下的**非空**目录会被下次 launch 当已就绪 | `src/executor/dsh.ts:41,244,278` |
| 4 | **未送达的 Eval 永不超时**：候选一直没送到主 Session 时截止时间不生效，Thread 的 `evaluating` 永久占位并挡住后续 pending | `src/core/evals.ts:43`、`src/core/engine.ts:83` |
| 5 | 主 Session 不存在时 `notice` 静默丢失：`inject` 直接 return，effect 却被当成功删除 | `src/app/sessions.ts:180-182`、`src/app/effects.ts:135` |
| 6 | `ticket.active` 只看**末位** Assignment（代码注释称「引擎保证只有末位会 pending/running」；一旦该不变量被破坏，票会从 `active()` 视野消失） | `src/app/store.ts:31-35` |
| 7 | `outbox.pending` 用**空格**拼 ticketId 与 thread：含空格时可能与他行撞键 | `src/app/store.ts:42-43` |
| 8 | ordered 的 effect 会**静默把 limit 夹成 1**：写 4 实际按 1 跑 | `src/app/effects.ts:71` |
| 9 | 投递去重非原子：`send` 先 `await history` 再查 inbox，并发同 requestId 可能双投 | `src/app/delivery.ts:69-82` |
| 10 | `report` 可以落在 pending Assignment 上（只拒绝 ended），而 `requestStatus` 要求 running | `src/core/assignments.ts:110-112`、`src/core/tickets.ts:152` |
| 11 | 票级 `end` 写 Assignment 时**不写 `endedReason`**（只有 `endAssignment` 写）⇒ 该字段在此路径恒空 | `src/core/tickets.ts:358,388` |
| 12 | `reassess` 把**正常重评**也记成 `unavailable`，于是 dismiss 面板会因 policy 变更而出现 | `src/core/evals.ts:225,195` |
| 13 | ack 只对「人的、有渠道的」Trigger 发；bot 触发的 accept 无回执；attention 回执 id 含问题原文，改一字即新 id | `src/core/replies.ts:44,79`、`src/core/assignments.ts:115` |
| 14 | `thread.subscribed` 查询强制 `INDEXED BY`：索引重建/缺失时直接报错，不回退全表扫描 | `src/app/store-read.ts:76-79` |
| 15 | `process.env` 全进程污染，异常退出不恢复（见 §11） | `src/infra/environment.ts:118-122`、`src/app/setup.ts:92`、`src/app/runtime.ts:246` |
| 16 | 首投开销 O(会话长度)：`flush()` 后按 512 事件/页扫全量历史并常驻 id 集 | `src/app/delivery.ts:40-60` |
| 17 | 单进程单写者：stateDir 文件锁 + 单 SQLite，锁损坏直接 abort runtime | `src/app/runtime.ts:91-94` |
| 18 | 强版本耦合：`peerDependencies` 钉 alpha 小版本、patch 用 `!!js`、preset id 在 `sessions.ts:48` 与 `cordis.patch.yml` 双写 | `package.json`、`cordis.patch.yml:45-74`、`src/app/sessions.ts:48` |
| 19 | 订阅不随票结束清理：结束票仍进 Gate 与候选的 tickets 列表（这是「一句人话即可 resume」的代价） | `src/core/tickets.ts:345-363`、`src/core/evals.ts:96,241` |
| 20 | 旧记录从不清理：trigger/disposition/decision、已结束票、outbox 回执、KV 里所有版本族都会无界增长 | `docs/007-architecture.md:484` |
| 21 | 票结束时**直接改** assignment 状态、不发 `assignment.ended`；只有 retry/restart 经 `endAssignment` 才发 | `src/core/tickets.ts:358,387-390` |
| 22 | `assignmentStarted` 实际调了两次，靠幂等掩盖 | `src/executor/dsh.ts:466-469`、`src/core/assignments.ts:38` |
| 23 | Session 被外部删除时：delivery 只建空 Session 再 `steer`，不带 assignment 简述（launch 路径能补发全文） | `src/executor/dsh.ts:313-316,451-453` |
| 24 | 一个 kind 只能有一个实例（id = kind）；卸载后其配置成为 orphan，并以 `source_not_installed` **静默丢弃** | `src/sources/registry.ts:46-47,50-53,127-128` |
| 25 | 5 秒重叠窗口硬编码：迟到 >5 s 的远端写入会漏；订阅相关 Thread 14 天后停止轮询 | `src/sources/poll.ts:6,16` |

---

## 17. 本次对账与未核实项

**与 11-01 报告的口径差异**（不影响其结论）：

- 该报告写「`tests` 65 个 spec」；本次实测 `tests/` 下 `*.spec.ts(x)` 为 **59** 个、目录内共 65 个文件（差额是 6 个 fixtures）。`src` 按 `.ts/.tsx` 计为 **110** 个（报告写 111，可能按含 `.d.ts`/入口的总数计）。`[实测]`
- 报告写「GitHub 轮询失败默认阈值」未给数；`docs/003-execution.md:164` 写「连续失败达阈值才报 Source 错误，默认 3 次」——本次未再核代码默认值，按文档口径记为 3。
- 报告 §4-B3 的「阻塞期间自动输入不补投」本次由代码复核确认（§16-2），并补充了「实为丢弃、无加回路径」的定性；§16 的陷阱清单从原报告 7 条扩到 **25 条**（其中 18 条为本次新增或细化）。

**未逐行核实项**（`[存疑]`，不影响正文结论）：

- `reserve` 拿到槽位后 `prompt` 一返回即释放，而 `running()` 依赖 agent status/settling：中间是否存在「已释放、尚未记 running」的短暂窗口，未确认（`src/executor/dsh.ts:284,327,406-409`）。
- `Setup.restart` 用 `setTimeout(…, 0)` 起重启、未防抖；连续保存是否会被 cordis 合并，未确认（`src/app/setup.ts:59`）。
- `settings.ts:96` 的 `wait` 是**模型预算重试等待**，与 Eval 超时无关，别混。
- 面板 74KB 双语文本、40KB CSS 的体积归因来自既有报告，本次未重测。

---

## 18. 来源

- 原型仓库：https://github.com/deepseek-ai/dsh-superagent-prototype（本地快照 `_refs/dsh-superagent-prototype/`，2026-11-01 经 `api.github.com` tarball 通道取得；2026-11-02 复核上游仍为单 commit）
- 逐份文档：`docs/000-philosophy.md` … `docs/008-cookbook.md`（本文引用到 `001/002/003/004/005/006/007/008` 的具体小节）
- 关键源文件：`src/core/{model,stage,ids,intake,evals,tickets,assignments,replies,engine,ports}.ts`、`src/policy.ts`、`src/kv.ts`、`src/app/{passes,effects,outbox,store,delivery,sessions,runtime}.ts`、`src/executor/dsh.ts`、`src/sources/{kind,registry,poll,github,github-trigger,feishu-trigger}.ts`、`src/infra/{environment,health}.ts`、`src/client/api.ts`、`tests/{docs,class-docs,model-surface,store}.spec.ts`、`cordis.patch.yml`
- 姊妹文档：[ref-dsh-superagent-prototype-2026-11-01.md](ref-dsh-superagent-prototype-2026-11-01.md)
- fleet 侧承接设计：[2026-11-01-superagent-absorb-design.md](../../dsh-miasaki-fleet/design/2026-11-01-superagent-absorb-design.md)
