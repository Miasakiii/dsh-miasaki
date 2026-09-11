# 上下文捆绑包：t-0003

## 背景
- M3.5 真实 CLI 派单：worker = claude（headless `claude -p {prompt} --output-format json`），单任务独占执行。
- 交付方式 = **stdout 产出 + 派单器代写**：headless 下 worker 的 Bash/Write 被权限栈与进程 sandbox 拒绝（设计 §11.2 既定行为，实测 t-0006），故结论全部走 stdout，由派单器落盘。
- 协议依据：docs/multi-agent-cli-orchestrator-design.md §4.7（交付物结构）/ §7.0（派单式执行与退出码）。

## 关键文档
- docs/multi-agent-cli-orchestrator-design.md（§4.7 六段结构、§7.0 派单与退出码）
- workers/lib/bus-contract.cjs（契约的唯一可执行定义：validateResult / validateEvent）
- schemas/result.schema.json（G0 节点交付契约 result.json）
