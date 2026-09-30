# t-0010 上下文：本轮接线改了什么、为什么

## 一句话

fleet 的判定层（G0 写入入口 / G1 任务图 / G2 能力图 / G4 验证器）此前**只有 G2 接在派单器上**，
其余停在「Commander 可手工查询」。本轮把 **G1 可派判定**与 **G0 事件留痕**接进
`workers/dispatch/dispatch-task.ps1`。

## 改动清单（复核对象）

| 位置 | 改动 |
|---|---|
| `dispatch-task.ps1` | 新增 `Test-DispatchableGate`：调 `node workers/graph/task-ready.mjs --explain <id> --json`，按 `ready` / `reasons` 决定放行或拒绝（exit 2） |
| `dispatch-task.ps1` | 新增 assignee 一致性检查：`-Agent` ≠ 台账 `assignee` 即拒绝 |
| `dispatch-task.ps1` | 新增 `Write-BusEvent`：`task.started`（CLI 启动前）与终态事件（`task.completed` / `failure.detected`）经 `workers/bus/bus-apply.mjs` 写入 |
| `dispatch-task.ps1` | 新增 `$env:BUS_ROOT = $Workspace`：让判定器与 applier 与 `-Workspace` 对齐 |
| `task-ready.mjs` | `--explain --json` 增加结构化字段 `agent`（`{id, enabled, alive, budgetOk, state}`）——冷启动降级靠它区分「从未运行（no-status）」与「僵尸（unknown）」，**不靠 reasons 的字符串匹配** |

## 设计上刻意做的取舍（请重点攻击这几条）

1. **冷启动降级**：`status.json` 不存在 ⇒ F3 判活给 `no-status` / `alive=false` ⇒ 若照判会硬拒。
   改为**降级为告警放行**，理由是「判活的本意是防僵尸，不是防首跑」。但 `running` 且心跳过龄
   仍按僵尸硬拒。→ 请检查这个区分是否真的成立（例如 `no-status` 之外还有没有别的「假僵尸」形态）。
2. **双实现口径分歧检测**：开关判定在派单器（读 `control.json`）与 `task-graph.cjs` 各有一份，
   跨语言无法共享。设计上保留双实现在闸门处**比对并告警**（`⚠ 口径分歧`），而不是合并。
   → 请检查这个告警在什么条件下会漏报。
3. **事件是审计不是闸门**：`bus-apply` 写事件失败（例如并发超步冲突 exit 3）只打印告警、
   **不阻断派单**。→ 请检查这是否会造成「日志看起来派了、事件流里没有」的审计缺口。
4. **退出码不动**：既有 0 / 2 / 3 / 4 语义保持不变，新闸门一律用 **2 = 拒绝派单**，
   靠打印文案区分原因。→ 请检查下游（`final-state.ps1`、面板、桌宠）是否会因「同为 2 但原因不同」而误判。

## 如何自查（建议命令）

```bash
node workers/graph/task-ready.mjs --explain t-0010 --json      # 闸门的判定来源，看 agent 字段
node workers/graph/task-ready.mjs --dispatchable               # 可派集（当前真实数据：只有 t-0010）
node workers/bus/bus-apply.mjs --current-version               # 总线版本
node workers/bus/bus-apply.mjs --list-events 10                # 最近 10 条机器事件
```

读 `dispatch-task.ps1` 时注意：`-CheckOnly` 是一条**独立分支**（约在文件前 1/3），
派单主路径在文件后 2/3 —— 两条路径的闸门调用要分别核对，**不要只看一条**。

## 环境提示

- PowerShell 7+（脚本用 `??` 运算符）；本机 PS7 路径 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`
- ⚠️ 正则陷阱：脚本里用 `[^\S\r\n]*` 而非 `\s*`（.NET 的 `\s` 含换行）—— 复核时别把它当成笔误
- 本仓是 public：结论中不要写维护者用户名或本机绝对路径，用相对路径

## 交付物协议

headless 下 worker **无法落盘**（Write/Bash 被权限栈拒绝，属既定行为）：
**全部结论走 stdout**，由派单器代写 `tasks/t-0010/result/result-t-0010.md`。
若你自述受阻，请让 `result.json` 的 `status` 如实为 `blocked` 并写清 `blockers`。
