# result-t-0010：派单器可派闸门接线的独立复核

> **代写说明（Commander，2026-09-30）**：headless 下 worker 无法落盘（`Write`/`Bash` 被权限栈拒绝，
> 设计 §11.2 既定行为），本文件由**派单器/Commander 代写**：正文**逐字**取自 worker `pi` 的
> stdout（原始证据：`agents/pi/logs/t-0010-stdout.log`），未做语义改写。
> 派单事实：`pi -p {prompt}`，exit 0，回合数与计量见 `agents/pi/usage.jsonl`（`unknown` 源 ⇒ 显式未计量行）。
>
> **本轮接线的事实背景**：t-0010 复核的对象是 2026-09-30 落地的「G1 可派判定 + G0 事件留痕接入
> `dispatch-task.ps1`」。复核结论中的 F2 / F3 / F4 三条已在复核后**当批修复**（见文末「复核后处置」），
> 故其行号指向的是复核时点的版本。

---

## 一、结论

**Q1 是否存在「该派却被拒」？——存在两条，但都不是 `no-status` 那条。**
① **崩溃残留**：`status.json` 的**唯一写者**就是派单器（`:381-382` 派单前写 running，`:462` 终态写、只有脚本走到末尾才会执行）⇒ 派单器被 Ctrl-C / 机器重启 / 断电打断后，文件永停 `running`；`liveness.cjs:73-79` 判 `unknown/alive=false` ⇒ `task-graph.cjs:244` 硬拒，**且仓库内没有任何重置入口**（`workers/`、`fleet-monitor/`、README grep `reset` 零命中；monitor 唯一的写端点 `/api/toggle` 只写 `control.json`）⇒ 该 agent 此后**永久派不出任务**，只能人工手改文件。
② **假僵尸（实测）**：派单器运行期间不刷新心跳（只有 `:381-382` 一次写）⇒ 任何 > `heartbeat_ms×3`=90s 的派单都会让「正在干活的 agent」被报成僵尸。本任务 14:42:21Z 派单，14:45:38Z 实测已 `state=unknown / alive=false / 心跳已停 198s`，真实工作区 `-CheckOnly` 随即 exit 2「agent pi 判活失败（心跳过龄，F3）」——而该 agent 正在正常执行（面板与桌宠同样被这条 stale 影响）。
`status.json` 缺失 + `control.json` 开着 ⇒ **确实降级放行**（实测 exit 0 + 告警文案）；`no-status` 之外的硬拒形态还有 `running 但无 heartbeat_at`（`liveness.cjs:71`）与 `心跳超前`（`:84`），二者同样无法与真僵尸区分。

**Q2 `-Agent` ≠ 台账 `assignee` 的拒绝，与 reassign 既有做法闭环吗？——闭环成立，提示指向的做法在代码里真的可行，有真实先例。**
`reassign` 是合法台账 op（`validate-bus.mjs:137`）；`append` 到 `state/tasks.jsonl` 在可写白名单内（`bus-contract.cjs:422`）；`foldTasks` 会消费 `row.assignee`（`task-graph.cjs:59-60`）。t-0010 的那条 reassign 行**恰好 497 字节 = 14:41:42 superstep 事件的 `bytes:497`**，改派后 pi 的派单在 14:42:21 放行（`state/graph-events.jsonl` 有 `task.started`）。
唯一缺口（低危）：文案里的「**带 reason**」无任何机器强制 —— `validate-bus` 不校验 reason（grep 零命中），`bus-apply` 的 `append` 补丁也不要求 reason（`bus-contract.cjs:462` 只对 set/merge 强制），三条历史记录都属自觉。

**Q3 两个时点能否覆盖 ①非零退出 ②自述 blocked？——能，但有一个孪生形态漏了。**
① 有真实证据：`state/graph-events.jsonl` 14:37:35Z `failure.detected` reason `"CLI exit 1"`（claude 首次派单）。
② 链路单点贯通：`final-state.ps1:45-46` → `dispatch-task.ps1:447-450` → `:466-470`（`state≠idle` ⇒ failure.detected）；但 **派单器这一侧的终态事件映射没有任何自动化断言**（`tests/` 里 `Write-BusEvent` 零命中，`bus-apply.test.mjs` 只测 applier）。
漏掉的孪生形态：**CLI 根本起不来**时 `$exitCode` 停在 0 ⇒ 记成 `task.completed`（见 findings 建议-2）；另 `final-state.ps1` 调用失败时回退 `exitCode==0→idle`（`:448`），blocked 会被同时写成 `idle` + `completed`。

**Q4 退出码语义与静默放行？——新闸门用 2 与既有约定一致，且下游不会误判；但退出码空间本身有撞号，静默放行找到两条。**
`:9` 已把「任务不可派」并入 2=拒绝派单，与 `:314`/`:335` 用法一致；**今天没有任何机器消费者读派单器退出码**（全仓 grep 只有文档/测试提及；面板与桌宠吃 `status.json`/pulse，`final-state` 吃的是 CLI 退出码）⇒「同为 2 原因不同」不造成下游误判，只影响人读。但 `:489 exit $exitCode` 会把 CLI 的 1/2/3/4 原样抖出去，与「2=拒绝」「4=预算熔断」撞号（真实出现过 exit 1）。
静默放行两条：(a) CLI 起不来记成成功（建议-2）；(b) 台账坏行静默跳过（观察-6）。已排除的路径：node 缺失/输出不可解析/判定器 exit 2 一律拒（`:89-104`，实测 pwsh 7.6.6 `@($null).Count == 1` ⇒ 即便 JSON 少了 `reasons` 字段也只会拒不会放）；唯一放行条件是 `:135 $reasons.Count -eq 0`——它**不看** `$parsed.ready`，当前两者等价（`task-graph.cjs:220/250` 都以 `reasons.length===0` 定义 ready），字段一旦解耦就会静默放行。

**未发现问题、明确说明（查了但没证据）**：`-CheckOnly` 确实不写总线（`:303-322` 只有读 + node 调用；夹具用例断言无 `graph-events.jsonl` 文件）；`$env:BUS_ROOT` 对齐同时覆盖判定器与 applier（`task-ready.mjs:40`、`bus-apply.mjs:45`），且 `$cli`/`$applier` 用 `$PSScriptRoot` 定位（不受 `-Workspace` 影响 = 正确）；冷启动降级在真实 task-ready 上确实生效（`tests/dispatch-gate.test.mjs` 冷启动用例实跑 exit 0）；预算双实现在日期分桶上**未找到漂移**（PS7 `ConvertFrom-Json` 把 Z 时间戳解析为 `Kind=Utc`，实测与 JS `slice(0,10)` 一致）。

## 二、完成度

- 四份复核对象**全文读完**：`dispatch-task.ps1`(489) / `task-ready.mjs`(281) / `final-state.ps1`(58) / `liveness.cjs`(89)，另追读 `task-graph.cjs`、`bus-apply-core.cjs`、`bus-contract.cjs`、`bus-apply.mjs`、`validate-bus.mjs`、`verify-all.mjs`（fleet 段）与两个测试文件。
- 上下文给的 4 条自查命令全部执行；`node --test tests/dispatch-gate.test.mjs` **10/10 通过**；真实工作区跑了一次 `-CheckOnly`（只读，未派单、未写总线）。
- 额外做了 4 组 PowerShell 语义探针（`@($null).Count`、`ConvertFrom-Json` 时间戳 Kind、缺命令时 `$LASTEXITCODE`、解析器语法检查）。
- **未做**：主派单路径的端到端实跑（会 spawn 真 CLI 并写总线，超出一轮只读复核的边界）⇒ 终态事件映射与「CLI 起不来」两条结论是**代码路径 + 隔离层语义实测**推出，非端到端观测；`verify-all` 全量未跑。
- Q1–Q4 全部作答，findings **6 条**，无阻断级。

## 三、数据来源·依据

| 结论 | 文件:行号 | 可 grep 关键词 |
|---|---|---|
| 闸门函数 / 调用点 | `workers/dispatch/dispatch-task.ps1:87-142`、`:314`、`:335` | `Test-DispatchableGate` |
| 判定器调用（stderr 被吞） | `:93`（`2>$null`）、`:193` | `--explain` / `--need` |
| fail-closed 分支 | `:89-104`、`:135-137` | `判定器输出无法解析` |
| assignee 一致性 | `:109-113` | `reassign 补丁` |
| 口径分歧（只比 enabled） | `:118-120`、`:335` | `口径分歧` |
| 冷启动降级（state 判 + **文案匹配**） | `:127`、`:128`、`:130` | `判活按首跑放行` / `判活失败` |
| 心跳写点（全仓唯一） | `:381-382`（running）、`:462`（终态） | `status.json` |
| 事件写点 | `:386`（started）、`:466-470`（终态） | `task.started` / `failure.detected` |
| 退出码透传 | `:414-415`、`:489` | `$LASTEXITCODE -ne 0` / `exit $exitCode` |
| 终态回退 | `:446-450` | `final-state.ps1 调用失败` |
| 判活口径 | `workers/lib/liveness.cjs:57`、`:61`、`:71`、`:73-79`、`:84` | `no-status` / `unknown` |
| 判活 reason 文案 | `workers/lib/task-graph.cjs:244` | `判活失败（心跳过龄，F3）` |
| ready≡reasons | `workers/lib/task-graph.cjs:220`、`:250` | `reasons.length === 0` |
| agent 结构化字段 | `workers/graph/task-ready.mjs:93-96`、`:118`、`:220` | `agent: agentInfo` |
| 台账/预算读取 | `task-ready.mjs:51-61`（dayCost）、`:118`（readJsonl） | `dayCost` |
| 坏行静默跳过 | `workers/lib/bus-apply-core.cjs:53` | `坏行由巡检报错，这里跳过` |
| 对照巡检会报 | `workers/validate-bus.mjs:48`、`:137` | `JSONL 解析失败` / `reassign` |
| 白名单 / reason 强制面 | `workers/lib/bus-contract.cjs:422`、`:462` | `state/tasks.jsonl` |
| BUS_ROOT 对齐 | `task-ready.mjs:40`、`bus-apply.mjs:45` | `BUS_ROOT` |
| reassign 实物证据 | `state/tasks.jsonl:34,35,42`（t-0010 行 497B = superstep `bytes:497`） | `"op":"reassign"` |
| 真实事件证据 | `state/graph-events.jsonl`（14:37:35 failure.detected "CLI exit 1"；14:42:21 task.started） | `failure.detected` |
| 静态断言不含调用点 | `scripts/verify-all.mjs:126-153`（`agent: agentInfo` 在 :145） | `dispatch 可派闸门接线` |
| 测试只用 -CheckOnly | `tests/dispatch-gate.test.mjs` 的 `runGate` | `-CheckOnly` |
| 实测命令/输出 | `node workers/graph/task-ready.mjs --explain t-0010 --json` → `agent.state=unknown,alive=false`（14:45:38Z）；`pwsh -File … -TaskId t-0010 -Agent pi -CheckOnly` → `✗ agent pi 判活失败（心跳过龄，F3）` `EXIT=2` | — |

## 四、遇到的问题（findings，按严重度：无阻断；4 建议 + 2 观察）

**F1【建议】崩溃残留 status.json ⇒ 闸门永久硬拒该 agent，且无重置入口。**
`dispatch-task.ps1:381-382/462` + `liveness.cjs:73-79` + `task-graph.cjs:244`；全仓唯一写者（grep `status.json` 仅命中派单器与测试夹具）；无 reset 入口。影响面：某能力的唯一 agent 一旦留下 stale-status，任务永远派不出去，且面板/桌宠同步显示僵尸。最小修法：加 `-ResetStatus`（或在 G1 把「stale 且 `current_task` 已终态」判为可回收），并让拒绝文案顺手给出重置命令。

**F2【建议】worker CLI 起不来时 `$exitCode` 停在 0 ⇒ exit 0 + `idle` + `task.completed`（假成功进审计流）。**
`:414-415` 只有 `$LASTEXITCODE -ne 0` 才更新 `$exitCode`；pwsh 7.6.6 实测：执行不存在的命令后 `$LASTEXITCODE` **不变**（保持前一个 `node` 调用留下的 0）⇒ G0 事件把「没跑起来」记成「成功完成」，日志里却只有「术语 … 不会被识别」。修法：spawn 前 `Get-Command $exe` 预检并 exit 2，或把这种失败显式置成非零码。

**F3【建议】主路径接线点零行为覆盖：删掉 `:335` 全仓不会变红。**
行为断言只覆盖 `-CheckOnly`（`:314`）；`verify-all.mjs:126-153` 的静态断言只找函数定义与函数体字面量，**不含任何调用点**；`dispatch-state.test.mjs` 只做语法解析。本任务复核的就是「接线」，建议静态断言补两条（`:314`/`:335`），或加一条「夹具里让闸门必然拒绝、断言在任何 CLI spawn 之前 exit 2」的主路径用例。

**F4【建议】冷启动降级的丢弃判据确实是 reasons 文案匹配，与 README/design 的「不靠字符串匹配」断言相反。**
`:127` 用结构化 `state` 决定「要不要降级」，`:128/:130` 却用 `-match '判活失败'` 决定「丢哪条」；文案源 `task-graph.cjs:244`；`README.md:239-242` 与 `docs/multi-agent-cli-orchestrator-design.md:43` 明写「不靠 reasons 的字符串匹配」。后果：改一个字的文案 ⇒ 降级静默退化为硬拒首跑（好在 `tests/dispatch-gate.test.mjs` 冷启动用例会红，所以是文档失真 + 耦合未被静态断言钉住，不是线上静默失效）。

**F5【观察】「口径分歧」告警覆盖不到真正的双实现漂移面。**
`:118` 只比 `enabled`；预算是一对独立双实现（`dispatch-task.ps1:47-70 Get-DayCost` ↔ `task-ready.mjs:51-61 dayCost`）却无任何比对；主路径本地值是常量 `$true`（`:335`），故该告警只能发现「两套 JSON 解析器对同一份 control.json 的解释差异」；`$parsed.agent` 为 null（无 manifest）时整条比对被跳过。未找到实际漂移（PS7 时间戳 Kind=Utc，与 JS slice 一致），且更严一方先拦 = fail-closed，故仅为观察。

**F6【观察】判据所依赖的台账读取会静默跳坏行，而判定器 stderr 又被派单器丢弃。**
`bus-apply-core.cjs:53` 坏行 `catch` 后**无任何输出**；`dispatch-task.ps1:93` 的 `2>$null` 即使有告警也看不到；对照巡检 `validate-bus.mjs:48` 会 fail，但不在派单路径上跑。真实形态：`tasks.jsonl` 里一条 `update status=done` 的行被截断 ⇒ 该任务在闸门眼里仍是 `queued` ⇒ 放行。建议派单前跑一次 `validate-bus`，或让 `task-ready` 输出「跳过的坏行数」并由闸门拒绝。

## 五、广播建议

1. 这条「判定在 node、闸门在 PS」的接线模式会被 G4/verifier 复用：**请把 F3 的做法定为模板**——每接一个闸门，必须同时钉住「主路径调用点」与「拒绝分支」两条断言，否则「函数存在」会被误当成「接线生效」。
2. 给 pulse/panel/desktop 线的提醒：`status.json` 的 `running-stale` 从今天起不只是显示问题，而是**派单硬闸门的输入**（F1）——桌宠/面板把它画成僵尸时，请把「如何恢复」一并给出。
3. `status.json` 是运行时唯一心跳载体、却只由派单器写：任何把 worker 执行改成「非派单器触发」（如并行扇出）的方案，都必须同时接管心跳刷新，否则新路径必然自锁。

## 六、下一步建议

1. 先修 F1+F2（都在 20 行内）：`-ResetStatus`/自愈判据 + spawn 前 CLI 存在性预检。这两条把「永久派不出去」和「假成功入审计流」两个最难人工发现的形态关掉。
2. 再补 F3 的调用点断言（改动最小、防的是「接线悄悄退化」）。
3. F4 二选一：改文档措辞，或让 `task-ready` 直接吐 `agent.firstRun` 布尔，代码只认标记（推荐后者，顺手把耦合变成结构化）。
4. F5/F6 并入下一批：预算比对纳入分歧告警（或直接合并实现）、派单前 `validate-bus` 门。

---

## 复核后处置（Commander，2026-09-30 同批）

复核结论**不改写**（上面逐字保留），处置如下：

| finding | 处置 | 落点 |
|---|---|---|
| F2 假成功进审计流 | ✅ **已修**：spawn 前 `Get-Command $exe` 预检，命中即记 127 并跳过该 cmd 行（不再让 `$LASTEXITCODE` 滞留 0） | `dispatch-task.ps1` 循环内 |
| F3 主路径调用点零覆盖 | ✅ **已修**：`verify-all` 断言补两条**调用点**（预检分支 + 派单主路径），并改为按文件精确匹配（此前是「任一文件含即过」） | `scripts/verify-all.mjs` |
| F4 文案匹配与文档矛盾 | ⚖️ **按「改文档 + 钉住耦合」处置**（未改判定层）：代码注释与 README/设计文档改为**如实描述 v1 边界**（降级决策用结构化 `state`，丢弃哪条 reason 仍按文案匹配）；静态断言把**两侧字面量成对**钉住，改任一侧即红。给 `reasons` 加 code 的结构化改造留作下一批 | `dispatch-task.ps1` / `README.md` / `verify-all.mjs` |
| F1 崩溃残留无重置入口 | ✅ **第二轮已修**：新增 `-ResetStatus`（**删除**而非写 `stopped` —— 判活对 `stopped` 同样给 `alive=false`；**心跳新鲜时拒绝执行**，防误删可能正在跑的档案）；拒绝文案同时给出可复制的恢复命令 | `dispatch-task.ps1` |
| F5 口径分歧只比 enabled | ✅ **第二轮已修**：预算也纳入分歧比对（`Get-DayCost` ↔ `dayCost`） | `dispatch-task.ps1` |
| F6 坏行静默跳过 + stderr 被吞 | 🔶 **第二轮修了一半**：坏行经 `task-ready` 的 `bus_bad_lines` 变成**可拒绝的事实**（有坏行即拒绝并指向 `validate-bus`）；判定器 stderr 仍被 `2>$null` 吞 —— **有意保留**：输出不可解析本身已判拒绝，吞掉的只是噪声 | `bus-apply-core.cjs` / `task-ready.mjs` / `dispatch-task.ps1` |
| **F7**（本报告 Q3 附带指出）`final-state.ps1` 调用失败时静默回退成 `exitCode==0→idle` | ✅ **第二轮已修**：保守记 `error`（判定失败本身就是要人看的异常），且不复制判定逻辑（保持 `final-state.ps1` 单点） | `dispatch-task.ps1` |

> **第二轮回归**：`dispatch-gate` 夹具 **10 → 17 例**（+台账坏行 / +`-ResetStatus` **六态**：空操作 ·
> 清崩溃残留 · 清除后闭环放行 · 心跳新鲜拒绝 · **`error` 不影响派单故拒绝清除** · `stopped` 允许清除）、
> 接线断言 **12 → 20 项**；`verify-all fleet` 仍 **20/20 PASS**。
> **一个由真机实测逼出来的收窄**：`-ResetStatus` 的第一版把「非 running 新鲜」的状态一律清除 ——
> 真机跑一次就把 `claude` 的 `error` 档案清掉了，连带丢了 `last_error`（「上次为什么失败」的唯一线索）。
> 收窄为**只清会挡住派单的形态**（`stopped` / `running` 但心跳过龄），其余状态一律拒绝清除并说明原因。
> **一处实现陷阱值得记**：`-ResetStatus` 判定「心跳新鲜」时，PS7 的 `ConvertFrom-Json` 会把 ISO-8601 字符串
> **自动转成 `[datetime]`** —— 再 `[string]` 转换后 `[datetime]::Parse` 会按当前文化解析该字符串表示（本机 zh-CN 下
> 实测把新鲜心跳判成「不新鲜」，于是误删了档案）。修法是两条分支各取正确口径：已是 `DateTime` 直接转 UTC，
> 字符串则用 `DateTimeStyles::RoundtripKind` 按 ISO 解析。
