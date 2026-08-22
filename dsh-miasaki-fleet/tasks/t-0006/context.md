# 上下文捆绑包：t-0006

## 背景
- M3.5 派单器首用轮（workers/dispatch/dispatch-task.ps1）：第二支 CLI 试单，验证「一个派单器、多个 CLI、模板化 invoke」。
- worker = 本机 Claude Code CLI（2.1.233，`claude -p {prompt} --output-format json`），任务属其自有域（读文件 + 分析总结）。
- 工作目录 = 项目 workspace；只读任务，不需要写权限。

## 关键文档
- agents/registry.json（本轮研读对象）
- docs/multi-agent-cli-orchestrator-design.md（v0.11 §7.0）
