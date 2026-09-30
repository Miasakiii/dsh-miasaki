# t-0011 上下文：这轮「写入收敛」到底改了什么

## 一句话

fleet 此前对「哪些文件必须经唯一写入入口（`workers/bus/bus-apply.mjs`）」只有一句笼统的
README 声明，**实现与声明长期不符**。本轮把它拆成一条可判定的口径：
**真相类文件进总线，派生态文件明确豁免**。

## 三件事

| # | 改动 | 落点 |
|---|---|---|
| 1 | **计量经唯一入口**：`agents/<id>/usage.jsonl` 加进可写白名单（只允许 `append`），派单器改为经 applier 落盘 | `bus-contract.cjs` 的 `PATCH_PATH_RULES` + `dispatch-task.ps1` 的 `Write-UsageRow` |
| 2 | **`status.json` 登记为派生态缓存**：**刻意**不进白名单（理由三条见 brief 的 Q2），写者唯一（派单器） | 同上 + 契约注释 |
| 3 | **`tasks.jsonl` 写者归属统一**：此前文档里有**四说**（Commander / worker / 派单器），现在收敛成一张权责表 | 主协议 §2 / §4.5 / §5 / §7.0 |

## 为什么 `status.json` 不进总线（这条最容易被误读成「漏了」）

设计时的关键判断：**把 `status.json` 塞进总线是错的**。

- 它含**高频**字段（`heartbeat_at` 每 30s 一次、`tokens` 每次派单累计）⇒ 走总线就是每次心跳一条补丁 + 一条事件；
- 它的**状态迁移已经被事件流完整记录**：`task.started`（置 running）、`task.completed` / `failure.detected`
  （置终态）—— 再走一次总线是**重复记账**；
- 强行走总线只有两种结局：要么事件风暴，要么「写了文件却不产生事件」的**畸形补丁**（违背「一切变更经 applier + 事件」的契约）。

⇒ 收敛口径是「**真相类文件进总线，派生态明确豁免**」，**不是**「所有文件都进总线」。
这与图工程 §5.2 的设计哲学一致：**事件流是唯一真相，其余是派生态**。

> 这条判断**欢迎攻击** —— 如果你能找出「某次状态迁移在事件流里没有对应记录」的真实反例，
> 那 Q2 的第②条就不成立，`status.json` 的豁免也就站不住了。

## 一个刻意的不对称（Q3 的对象）

applier 失败时 `Write-UsageRow` **回退直写并告警**。理由是两种缺口不对称：

- **计量数据丢失** ⇒ 成本账的**不可再生**缺口（worker 已经跑完，那条 usage 不会再产生一次）；
- **未经唯一入口** ⇒ **可追认**的治理缺口（文件还在，事后能补登记）。

所以选「保住数据 + 显式告警」，而不是「宁可不写也不违反流程」。这是**有意的取舍**，
不是疏忽 —— 但它确实留下了「审计缺口」，值得你评估。

## 如何自查（建议命令）

```bash
node workers/bus/bus-apply.mjs --current-version      # 当前总线版本
node workers/bus/bus-apply.mjs --list-events 12       # 最近 12 条机器事件（看 paths 里出现过哪些文件）
node workers/validate-bus.mjs                         # 总线全量校验
grep -n "PATCH_PATH_RULES" -A 20 workers/lib/bus-contract.cjs
```

读 `dispatch-task.ps1` 时注意：`-CheckOnly` 是**独立分支**（不写总线也不写 usage），
`Write-UsageRow` 只在**真派单**路径上被调用 —— 别把「预检没写 usage」当成缺陷。

## 环境提示

- PowerShell 7+（脚本用 `??` 运算符）；本机 PS7 路径 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`
- 本仓是 public：结论中不要写维护者用户名或本机绝对路径，用相对路径

## 交付物协议

headless 下 worker **无法落盘**：**全部结论走 stdout**，由派单器/Commander 代写
`tasks/t-0011/result/result-t-0011.md`。若你自述受阻，请让 `result.json` 的 `status` 如实为
`blocked` 并写清 `blockers`。
