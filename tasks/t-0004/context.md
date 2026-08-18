# 上下文捆绑包：t-0004

## 背景
- 双 worker 并行隔离验证轮（M3.5）：analyst 与 coder 同时各执行一个任务，互相不可见。
- 子运行时 = 官方 examples/jsonrpc-agent 组合；本轮 llm 指向本地 mock 服务器。
- 协议依据：docs/multi-agent-cli-orchestrator-design.md §4.7。

## 关键文档
- shared/collective-memory.md（本轮研读对象）
