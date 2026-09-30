# result-t-0011：写入收敛口径的独立复核

> **代写说明（Commander，2026-09-30）**：headless 下 worker 无法落盘（`Write`/`Bash` 被权限栈拒绝，
> 设计 §11.2 既定行为），本文件由**派单器/Commander 代写**。
> 正文**逐字摘录**自 worker `pi` 的 stdout（原始证据 `agents/pi/logs/t-0011-stdout.log` ——
> 该路径被 gitignore，不入库，故关键段在此**内联**）。派单事实：`pi -p {prompt}`，exit 0。
> 行号指向复核时点的版本，与修复后的行号可能不同。

---

## 一、结论（逐字摘录）

**收敛口径（真相进总线 / 派生态豁免）本身站得住，但它在产物层尚未生效，且有两处漏网、一处误登记。**
B5 声称「usage.jsonl 经唯一入口落盘」——我找不到任何产物级证据，最新一条计量行的字节形态反而指向直写。
Q2 的豁免结论（status.json 不进总线）**成立**，但其三条理由中 ①③ 与代码现状不符、② 有两个小反例。
Q3 的取舍方向可接受，但它承诺的「可追认」目前不可操作，且回退路径引入了比审计缺口更重的新风险（重复计量）。

### Q1 白名单路径性质 + 漏网真相类（逐条）

1. `state/tasks.jsonl`(:422) / `state/graph-events.jsonl`(:423) / `state/ledger.jsonl`(:424) /
   `agents/<id>/usage.jsonl`(:434) / `tasks/<id>/{result,verdict}.json`(:435,436) = **真相（含输入类）**；
   `agents/<id>/capability.json`(:425) 按设计是**派生态派生视图**（`docs/graph-engineering-fleet-design.md:369`）
   且**全仓零写者**（`grep -rn "capability.json"` 只命中文档与历史 transcript）——白名单登记了一条没人写的路径。
2. **漏网一：`agents/<id>/control.json`** —— 派单许可（Operator 意图，**不能从事件流 fold 的输入**，
   与 usage.jsonl 同构），由 `fleet-monitor/server.js:415-421` 的 `POST /api/toggle` **直写**
   （无补丁、无事件），而 `dispatch-task.ps1:585,614` 就是拿它当派单准入门槛。
3. **漏网二：`agents/<id>/manifest.json` + `agents/registry.json`** —— 能力闸门的**实际输入**
   （`agent-pick.mjs:61,69` 读 `manifest.skills`；`dispatch-task.ps1:697` 读 `manifest.metering_source`
   决定计量通道），由 `workers/discovery/scan-agents.ps1:68,71,77` 用 `Set-Content` 直写。
   **登记的是没人写的 capability.json，真正喂闸门的 manifest 反而在总线外。**
   （`state/events.jsonl` 是人工里程碑流，全仓无程序写者，不算漏网；`status.json` / `transcript.md` /
   `logs/*.log` / `verify-brief.md` / `state/fleet-pulse.json` 属派生态或派生物，不登记合理
   但**只有 status.json 写了理由**。）

### Q2 status.json 三条豁免理由是否成立

1. **② 基本成立但非绝对**：running/终态确有事件对应；反例——`-ResetStatus` **删除** status.json（`:572`）
   零事件；事件发射是 best-effort（`:191` 注释 + `:202-206` 只告警），applier 一失败就出现
   「status 变了、事件没有」；且 `blocked` 与 `error` 在事件里**不可分**（`Write-BusEvent` 不传 state 字段，
   `:199-200`，两种终态都只是 `failure.detected`）。
2. **① 与现状不符**：status.json 每次派单只写 **2 次**（`:711` running、`:810` 终态）；全仓
   **没有任何 30s 心跳写者**，`heartbeat_ms=30000` 只是判活阈值（`workers/lib/liveness.cjs:64`、
   `dispatch-task.ps1:527-528`）。「事件风暴」是对**未来引入心跳后**的推断，不是当前事实。
3. **③ 表述不成立**：applier 成功路径**总**会补一条 `superstep.committed`（`bus-apply-core.cjs:286-296`，
   `paths` 里会带上 status.json），不存在「写了文件却不产生事件」的畸形补丁；该现象只在 partial 失败窗口
   成立（`:298-303`）。⇒ 结论保留，理由应改写为「当前 2 次/派单，低频；真值在 result.json + 事件，
   归因收益低」。

### Q3 回退直写的取舍与审计缺口

1. **取舍方向自洽（数据不可再生 > 治理可追认），但「可追认」没有落地**：回退行与总线行**字节上不可区分**
   （`usage.jsonl` 行内无 `via`/`author`/`patch_id`），唯一差别是 `Add-Content` 的 **CRLF** 与 applier 的 LF
   （`bus-apply-core.cjs:107-110`）——那是偶然，不是契约；且告警只走 `Write-Host`（`:246-247`），
   `agents/<id>/logs/` 里查不到任何 `[usage]` 行（实测 t-0010 的 22KB 日志无该串）
   ⇒ 缺口的**唯一记录在控制台，不持久**。
2. **新风险（比审计缺口更重）**：applier **partial 失败**（补丁已落盘、commit 事件没写 ⇒
   `bus-apply-core.cjs:298-303`，exit≠0）会触发回退**再写一遍**同一行 ⇒ **重复计量、成本双计**；
   `Write-UsageRow` 无查重（`:215-247`）。
3. **更好的做法（按性价比）**：ⓐ partial 失败（`--stdin` 返回的提示含「部分写入」）**不回退**，
   按「已写待重读」处理；ⓑ 回退前查重（同 task+ts 已在文件中则跳过）；ⓒ 行内加 `via:"direct-fallback"`
   与告警落 `agents/<id>/logs/dispatch.log`（把「显式告警」变成可检索证据）；ⓓ 姊妹缺陷同修——
   usage 只在 `$exitCode -eq 0` 时写（`:764`），**失败的派单同样烧 token 却零计量**，
   建议改为「stdout 可解析即落行，不可解析走现成的 `Parse-Unmetered`」。

### 未发现问题（已查、明确记录）

1. **op 约束准确**：`usage.jsonl` 只接受 `append`，`set`/`merge` 被 `bus-contract.cjs:461-463` 拒；
   有测试 `tests/bus-contract.test.mjs:274-283` —— 未发现「白名单过宽」。
2. **status.json 确未被误登记**（`bus-contract.cjs:421-437` 内无该模式），也没有任何调用点假装它走总线
   —— 未发现「漏进白名单」。
3. **路径穿越与乐观并发未被本轮破坏**：`bus-apply-core.cjs:119-127`（`resolveTarget` 拒绝 `..`）与
   `:242-250`（期望版本不符即 exit 3）逻辑完整。
4. **载荷一致性**：两条写路径产出的 row 语义相同（解析器一律带 `ts`，见 `dispatch-task.ps1:409,455,470`），
   applier 的 `ts` 兜底（`bus-apply-core.cjs:178-179`）不会造成字段差异 —— 差异只在行尾与治理留痕。

---

## 二、复核后处置（Commander，同日）

复核结论**不改写**（上面逐字保留）。处置如下：

| pi 的发现 | 严重度 | 处置 |
|---|---|---|
| **Q3-2 partial 失败触发回退 ⇒ 重复计量** | **阻断** | ✅ **已修**：`Write-UsageRow` 检测 applier 输出里的「部分写入」⇒ **不回退**，按「已写待重读」处理 |
| **Q3-④ 失败轮零计量**（usage 只在 `exitCode -eq 0` 时写） | **阻断** | ✅ **已修**：解析与落盘移出 exit 判断；解析不出时走 `Parse-Unmetered` 写**显式未计量行**。**实测**：t-0012 以 `node -e "process.exit(3)"` 造失败轮 ⇒ usage **新增一行**、事件 `failure.detected` |
| **Q2-1 `blocked` 与 `error` 在事件里不可分** | 建议 | ✅ **已修**：终态事件带 `--field state=<state>`。**实测**：`{"event":"failure.detected",...,"state":"error"}` |
| **Q2-1 `-ResetStatus` 是状态迁移却零事件** | 建议 | ✅ **已修**：新增事件类型 `agent.status.reset`（`task:false`），同步扩 `EVENT_TYPES` 与 `graph-event.schema.json` 的 enum。**实测**：清 `agent-browser` 残留 ⇒ 事件入流（v22） |
| **Q3-1 「可追认」没落地**（告警只在控制台、行内不可区分） | 建议 | ✅ **已修**：回退行内加 `[BUS_BYPASS]` 标记；告警落 `agents/<id>/logs/dispatch.log`（可 grep 检索） |
| **Q2-2 理由①「心跳风暴」与现状不符** | 建议 | ✅ **已订正**：撤回该现状论据（status.json 当前每派单只写 2 次，全仓无周期性心跳写者）；豁免的正当理由改为「②真值在事件流 + 归因收益低」，并**如实标注 ② 是有条件的**（事件发射 best-effort） |
| **Q2-3 理由③「畸形补丁」表述不成立** | 建议 | ✅ **已订正**：applier 成功路径总会补 `superstep.committed`；该现象只在 partial 窗口成立 |
| **Q1-1 `capability.json` 是「没人写的路径」** | 观察 | ⏸️ **保留登记 + 注释说明**（它是设计中的派生视图，移除会让未来实现被拒） |
| **Q1-2 `control.json` 漏网**（fleet-monitor 直写派单许可） | 建议 | ⏸️ **登记为已知未收敛**（需改 fleet-monitor 的写接口，属独立批次） |
| **Q1-3 `manifest.json` / `registry.json` 漏网**（能力闸门的实际输入由扫描器直写） | 建议 | ⏸️ **登记为已知未收敛**（需改 `scan-agents.ps1`，属独立批次） |
| **Q3-3-ⓑ 回退前查重** | 建议 | ⏸️ 未做（partial 不回退已消掉最主要的重计路径；查重留作加强） |
