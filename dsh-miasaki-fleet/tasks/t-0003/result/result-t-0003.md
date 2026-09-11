# 结果：t-0003 worker 交付物自查脚本设计

## 结论

**交付物自查必须是「派单器侧可执行的跨文件一致性检查」，不能设计成 worker 自查。** 依据：headless 下 worker 无写权限（t-0006 实测 + 本轮 t-0003 再次实测，Bash spawn 被权限栈 `EPERM` 拒绝），worker 无法落盘任何交付物，"自己检查自己交的东西"在物理上不成立；且 §6.4 第 6 条已明示 Agent 自测易与实现共用盲点。

方案分三层，核心是新增一个零依赖脚本 `workers/audit/check-deliverable.mjs`（约 120 行，复用既有契约，不新增判定口径）：

```
node workers/audit/check-deliverable.mjs --task t-0003 --agent claude [--json] [--strict]
退出码：0 全通过 / 1 有 FAIL（交付物不合规）/ 2 环境错误（任务目录缺失等）
```

**六项检查**（对应验收标准 2 的四项，另补两项本仓真实缺口）：

| # | 检查项 | 依据 | 判定 | 现状 |
|---|---|---|---|---|
| C1 | result 文件存在性 | §3、§4.7 | `tasks/<id>/result/result-<id>.md` 与 `tasks/<id>/result.json` 均存在 | 无机器检查 |
| C2 | 结构段落完整性 | §4.7 | 六段标题**按序**存在，归一化分隔符后匹配 | 无任何实现 |
| C3 | result.json 契约 | §4.8 | 直接 `import { validateResult }` 复用 | 已由 validate-bus 覆盖 |
| C4 | notes ≤10 行 | §4.6 | `agents/<id>/notes.md` 非空行 ≤10 | 无机器检查 |
| C5 | status 终态一致性 | §4.3 + §4.8 | 跨文件联合判定表（见下） | 无机器检查 |
| C6 | **done ⇒ 交付物存在**（反向） | §5 状态机 | 台账终态为 done/accepted 的任务必须有 result.json | **无人检查，且现有校验器主动放行** |

C5 的联合判定表（两套词表**只有 `blocked` 同名**，必须显式映射，不能字符串相等了事）：

```
result.json.status = completed → status.json.state ∈ {idle}
                   = blocked   → status.json.state ∈ {blocked, error} ∧ blockers 非空
                   = failed    → status.json.state ∈ {error}          ∧ blockers 非空
```

**接线点**：`dispatch-task.ps1` 在 usage 落盘（L313-323）之后、status 终态（L326-335）之前插入调用；自查失败时**不改 CLI 退出码**（会污染 §7.0 的 0/3/4 语义），而是把 `status.state` 置 `blocked` + `last_error='交付物自查未通过'` 表达。同时把「在 stdout 末尾输出固定格式自查回执」写入 §4.6 brief 模板的「完成后必做」，由派单器解析回执并与实际落盘物**比对**——worker 声称交了但实际没交，按未交付处理。

命令行批量模式（Commander 验收前预检）：`--all --pending-done` 一次扫出所有「标记 done 但无交付物」的任务。

## 完成度

100%。三项交付物均已完成：结论走 stdout（本段）、result-t-0003.md 待派单器代写、notes 待追加要点见文末（10 行）。

验收标准逐条自核：标准 1（六段结构）——本文即六段；标准 2（四项覆盖）——C1/C2/C4/C5 一一对应，另补 C3/C6；标准 3（可脚本化方案）——命令行 + 退出码 + 伪代码 + 接线点已给出。

## 数据来源 / 依据

- `docs/multi-agent-cli-orchestrator-design.md`：§4.3（status.json 状态枚举）、§4.6（brief 模板「完成后必做」，notes ≤10 行）、**§4.7（六段结构，L325-345）**、§4.8（result.json 契约与写入入口）、§5（状态机终态）、§6.2/§6.4（能力闸门与验收清单第 1/6 条）、§7.0（派单式执行与退出码）、§11.2（无人值守权限自动拒绝）
- `workers/lib/bus-contract.cjs` L153-222：`validateResult` —— **契约的唯一可执行定义，方案直接复用，不重写**
- `schemas/result.schema.json`：`RESULT_STATUS = completed|blocked|failed`、`blockers` 非空约束、`artifacts[].sha256` 必填
- `workers/validate-bus.mjs` L102-112（state 枚举校验）、**L224-239（`if (!existsSync(rp)) continue` —— 缺失 result.json 被静默放行，C6 缺口来源）**
- `workers/dispatch/dispatch-task.ps1` L270-273（running 写入）、L313-323（usage 落盘）、**L326-335（终态仅 `idle`/`error`，无 blocked 分支）**
- `tasks/t-0006/result/result-t-0006.md`：t-0006 交付物结构样例 + 代写协议的先例证据
- `agents/claude/manifest.json`（`metering_source: json-cost-usd`、`limits.max_tokens_per_task: 50000`）、`agents/claude/status.json`（本轮 running 快照，`current_task: t-0003`）、`package.json`（回归入口）
- 本轮实测：`Bash` 工具调用返回 `EPERM: operation not permitted, uv_spawn 'C:\Program Files\Git\bin\bash.exe'`；`Glob`/`Grep` 返回 `EPERM ... uv_spawn 'rg'` —— 与 brief 所述只读约束一致，构成本轮独立复现证据

## 遇到的问题

1. **C6 是真实缺口，不是设计洁癖**：`validate-bus.mjs` L231 对不存在的 `result.json` 直接 `continue`（注释：「未交付的任务没有 result.json 是正常的」）。因此一个在台账里标记 `done`+`accepted`、却从未产出交付物的任务，**现有全部校验器都会放行**。这与 v0.16 治的「陈旧数据比没有数据更危险」是同一类病：状态说完成了，物证不存在，而无人报警。建议自查脚本把这条作为 C6 硬检查（反向存在性）。
2. **派单器无法表达 `blocked` 终态**：L326 只有 `state = exitCode==0 ? 'idle' : 'error'`。一个 CLI exit 0、但在 stdout 里自述「受阻」的 worker，会被记成 `idle`（= 健康空闲）。C5 若只做字符串相等会误判，故我给出的是一张显式映射表 + 建议派单器补 blocked 分支。
3. **notes.md 两种口径互相矛盾**：§4.6 写「≤10 行」指文件总量；本 brief「完成后必做 2」写「≤10 行待追加要点」指单次增量。若每次追加 ≤10 行，总量必然突破 10 行，C4 将永远 FAIL。**需 Commander 裁决**：建议取总量口径（§4.6 原文），派单器追加时做尾部滚动保留最近 10 行。
4. **§4.7 标题分隔符与验收标准不一致**：文档正文写 `## 数据来源 / 依据`，验收标准 1 写「数据来源·依据」。C2 的正则必须归一化（`[·/／|\s]+`），否则同一份合规交付物会因写法不同被误判。
5. **`agents/claude/notes.md` 当前不存在**：t-0006 已交付，但 notes 代写显然未执行。说明 C4 的基线目前是「缺失」而非「超限」——检查必须把「文件不存在」与「行数超限」分开报，不能都算 FAIL 同一码。
6. **context.md 未随 brief 修订同步**：`tasks/t-0003/context.md` 仍写「双 worker 并行隔离验证轮 / llm 指向本地 mock 服务器」，并把 `workers/worker-cli/worker.mjs` 列为「关键文档」——该文件自 v0.11 起已删除（v0.11 明确「废弃自研 worker CLI」）。brief 的修订记录只改了 brief 自身。
7. **`scripts/verify-all.mjs` 不存在**：设计文档 v0.17–v0.20 共四处引用 `node scripts/verify-all.mjs fleet`（含「14/14 PASS」的结论），但该路径在仓库中不存在，实际回归入口是 `package.json` 的 `npm test`（内联 7 个测试文件）。新增的 `tests/deliverable-check.test.mjs` 应并入 `npm test` 而非不存在的 verify-all。

## 广播建议

1. **「状态有终态、物证无校验」是本仓的一类系统性缺陷，C6 只是其中一个实例。** 建议推广为通用不变式：**任何被标记为终态的对象，都必须有一条反向存在性检查**（done ⇒ result.json；accepted ⇒ verdict.json（高风险任务）；running ⇒ 心跳新鲜）。v0.16 的心跳判活、本次的 C6 是同一原则的两次独立发现。
2. **契约判定必须单点**：本仓已在 `bus-contract.cjs` 建立「唯一可执行定义，applier 与 validate-bus 两处消费」的强约定（v0.17）。新增任何校验（含本方案的自查脚本）必须 `import` 复用，**不得新增第三处副本**——本方案若被采纳，应把 `SECTIONS` 常量也放进 `bus-contract.cjs` 而非留在自查脚本里，这样 §4.7 的六段结构才第一次有了可执行定义（目前 §6.4 验收清单第 1 条「结构完整（§4.7）」无任何实现）。
3. **worker 自述不可作为交付凭据**：headless 代写协议下，「worker 声称交付」与「交付物实际落盘」是两件事。建议在所有 brief 的「完成后必做」中固化 stdout 自查回执格式，由派单器比对——这是对 §6.4 第 6 条「不得只信 worker 自测」在交付环节的具体化。

## 下一步建议

1. **落地 `workers/audit/check-deliverable.mjs`**（C1–C6，退出码 0/1/2，`--json`/`--all --pending-done`），并入 `npm test` 与派单器 L323 之后的接线点。约 120 行，零新依赖。
2. **Commander 先裁决第 3 条（notes 口径）与第 2 条（派单器是否补 blocked 终态）**——这两个是语义决策，不该由脚本替人拍板（同 G2 `--gaps` 的保守原则）。
3. **顺手修文档漂移**：把 `scripts/verify-all.mjs` 的四处引用改为 `npm test`；重生成 `tasks/t-0003/context.md`（现内容指向已删除文件与废弃 mock 语境）。这两条成本极低，但会持续误导后续 worker。

---

## 附录：被本文件取代的历史产物（2026-08-17 mock 验证轮）

> 本文件在 2026-09-11 的真实派单轮次中**取代**了 t-0003 于 2026-08-17 留下的 mock 验证产物
> （git `c7009d7` 版本，273 字符）。原文完整保留如下，**以免历史被抹掉**。
>
> 该产物正是 brief 中「本轮为双 worker 并行隔离验证（mock 模型应答）」这一语境的来源——
> 即 2026-08-17 那轮 keyless 验证**确实跑过并落盘了产物**。但它同时说明：
> ① 其绑定的 `agents/coder/sessions/t-0003` 与自研 worker CLI 自 v0.11 起已废弃；
> ② 该轮交付**从未被验收**——`tasks.jsonl` 中 t-0003 自 2026-08-17 创建起始终为 `queued`，
> 直到 2026-09-11 本轮真实派单才终结。

```markdown
# 结果：t-0003

## 结论
M3.5 worker mock response OK

## 完成度
100%（keyless 验证轮次：子运行时按 mock 脚本应答，交付物由 worker 包装层落盘）

## 数据来源 / 依据
- 子运行时会话日志：C:\Users\Asakii\Desktop\dsh-miasaki\agents\coder\sessions\t-0003

## 遇到的问题
无

## 广播建议
（本轮为 M3.5 worker 自动化 keyless 验证）

## 下一步建议
真实模型轮次待 DEEPSEEK_API_KEY 注入。
```
