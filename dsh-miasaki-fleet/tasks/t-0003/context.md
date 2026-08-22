# 上下文捆绑包：t-0003

## 背景
- 双 worker 并行隔离验证轮（M3.5）：coder 与 analyst 同时各执行一个任务，互相不可见。
- 子运行时 = 官方 examples/jsonrpc-agent 组合；本轮 llm 指向本地 mock 服务器。
- 协议依据：docs/multi-agent-cli-orchestrator-design.md §4.7/§7。

## 关键文档
- docs/multi-agent-cli-orchestrator-design.md（§4.7 交付物结构）
- workers/worker-cli/worker.mjs（worker 包装层实现）
