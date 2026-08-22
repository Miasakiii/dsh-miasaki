# 上下文捆绑包：t-0005

## 背景
- M3.5「本机 CLI 派单闭环」首跑（设计文档 v0.11 §7.0 派单式执行）。
- worker = 本机 bl CLI（扫描器发现的 8 个 agent CLI 之一），任务属于 bl 自有域（用量/额度），符合「按 CLI 特性分配」原则。
- 派单器 = Commander（本轮手动代理）：spawn CLI → 捕获 stdout → 落盘 transcript → 代写 result → 台账验收。

## 关键文档
- docs/multi-agent-cli-orchestrator-design.md（v0.11，§4.1/§7.0/§9.1）
- agents/registry.json（发现清单）
