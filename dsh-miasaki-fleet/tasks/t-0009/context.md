# 上下文捆绑包：t-0009

## 背景
- 2026-08-24 OpenViking 试点收尾轮：派单器 peer 隔离注入（OPENVIKING_RECALL_PEER_SCOPE=actor）落地后的首次真实派单。
- worker = 本机 Claude Code CLI（2.1.241，`claude -p {prompt} --output-format json`），已装 `openviking-memory@openviking` v0.4.4 插件。
- 验证点：worker 会话（cc-*）被 OpenViking 自动捕获 → commit 提取 → `ov find` 哨兵词命中 → 证明「派单器注入 + OpenViking 记忆链路 + peer 隔离」整链有效。
- 工作目录 = 项目 workspace（fleet 根）；只读任务。

## 关键文档
- ../dsh-miasaki-shared-docs/dsh-platform/ref-openviking-dsh-2026-08-24.md（试点归档）
- docs/multi-agent-cli-orchestrator-design.md（v0.15 §12.2 记忆层选型）
