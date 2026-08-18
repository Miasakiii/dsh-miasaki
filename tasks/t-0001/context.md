# 上下文捆绑包：t-0001

## 背景
- 本任务属于「多 Agent CLI 协作模式」项目的 M1 里程碑（协议手动闭环验证）。
- 你（analyst）是该模式下第一个 worker，由总指挥用 subagent_fork 手动扮演。
- 你的角色规则：只读 inputs 与 shared/，只写自己的 result/ 与 notes.md、status.json。

## 关键文档
- docs/dsh-official-repo-review-2026-08-16.md —— 官方仓库调研（2026-08-16 完成）
- docs/multi-agent-cli-orchestrator-design.md —— 协作模式设计文档 v0.3（§12 已按调研重写，你的任务是为 M3 决策提供对照依据）

## 协议要点（摘自设计文档）
- 交付物固定结构见设计文档 §4.7
- 你是 worker，唯一路由规则见 agents/analyst/manifest.json 的 persona_prompt
- 本阶段 metering=false，usage.jsonl 豁免
