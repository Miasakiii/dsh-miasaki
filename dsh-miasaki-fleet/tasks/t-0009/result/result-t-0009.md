# 结果：t-0009 OpenViking 记忆链路哨兵验证

- 时间：2026-08-24（UTC 14:01 执行，14:26 验收）
- Worker：claude 2.1.241（claude -p headless，json 输出）
- 派单：dispatch-task.ps1 -TaskId t-0009 -Agent claude（首次含 OpenViking peer 隔离注入的真实派单）

## 结论

**全链路验证通过**：派单 → worker 执行 → OpenViking 自动捕获 → commit 提取 → 语义检索。

## 完成度

| 验收标准 | 结果 |
|---|---|
| claude CLI 真实执行（json 含成本字段） | exit 0，total_cost_usd=0.1457，1 turn |
| stdout 含原样哨兵 OV-PEER-SENTINEL-0924 | 通过 |
| ov find 可检索到任务内容 | top1：peers/C--Users-Asakii-Desktop-dsh-miasaki-dsh-miasaki-fleet/memories/events/2026/08/24/OpenViking记忆链路哨兵验证.md（score 0.360） |

## 数据来源 / 依据

- worker 会话：claude session b22c5189-17b3-409e-aed5-b94b80b79905（stdout 见 agents/claude/logs/t-0009-stdout.log）
- 计量：usage.jsonl（in 47603 / out 82 / cache-read 5376 / cost $0.1457）
- 记忆：ov find "OV-PEER-SENTINEL-0924"；提取实体 memories/entities/系统/openviking.md 已在本会话 recall 注入中可见

## 遇到的问题

- 输入 token 偏高（47603）：OpenViking 记忆注入（profile + recall）叠加在简短任务上。这是自动记忆的正常成本，需关注后续任务的注入预算（recallTokenBudget / server max_tokens）。
- 观察：DSH 插件的 uri-guard 会拦截工具参数中出现 viking URI 字面量的本地操作（写本地审计文档引用记忆路径时被误伤）——本地文档引用记忆路径建议用不带前缀写法，已在本文件实践。

## 广播建议

- peer 隔离符合预期：worker 记忆落在 peers/<cwd派生>/ 而非 user/default/；总指挥记忆在 user/default/。
- 派单器注入 OPENVIKING_RECALL_PEER_SCOPE=actor 已生效，无需在任务书中注明。

## 下一步建议

- 本会话（总指挥）已见 recall 注入与 skill；mcp__openviking__* 工具面待确认
- 后续派单观察输入 token 预算，必要时调低 recallTokenBudget 或 server max_tokens
