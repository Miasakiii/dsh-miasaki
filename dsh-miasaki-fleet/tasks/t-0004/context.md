# 上下文捆绑包：t-0004

## 背景
- M3.5 真实 CLI 派单：worker = claude（headless `claude -p {prompt} --output-format json`），单任务独占执行。
- 交付方式 = **stdout 产出 + 派单器代写**：headless 下 worker 的 Bash/Write 被权限栈与进程 sandbox 拒绝（设计 §11.2 既定行为，实测 t-0006），故索引与结论全部走 stdout，由派单器落盘。
- ⚠️ 源文档时效：shared/collective-memory.md 最后更新 2026-08-16，内容停留建库期（含已废弃的 dsh-sdk 路线）。本轮只做**只读快照索引**，不追认其技术结论；文档本身的策展属 Commander 职责，另项处理。
- 协议依据：docs/multi-agent-cli-orchestrator-design.md §4.7。

## 关键文档
- shared/collective-memory.md（本轮研读对象）
- docs/multi-agent-cli-orchestrator-design.md（§4.7 六段结构）
