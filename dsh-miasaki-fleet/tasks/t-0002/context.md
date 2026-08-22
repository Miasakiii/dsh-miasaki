# 上下文捆绑包：t-0002

## 背景
- M3.5 worker 自动化里程碑的 keyless 验证轮（M3 已定 dsh-subagent-dsh-sdk 为 runtime，worker 包装层直接使用其底层 SDK 客户端）。
- 子运行时 = 官方 examples/jsonrpc-agent 组合（dsh-sdk-jsonrpc-server + llm-deepseek + bash + fs + sessions + subagent + token-meter），本轮 llm 指向本地 mock 服务器。
- 协议依据：docs/multi-agent-cli-orchestrator-design.md（§4 文件总线、§7 worker 行为、§10 故障恢复）。

## 关键文档
- docs/m3-official-runtime-eval-2026-08-16.md（M3 实测结论）
- workers/worker-cli/worker.mjs（本轮被测对象）
