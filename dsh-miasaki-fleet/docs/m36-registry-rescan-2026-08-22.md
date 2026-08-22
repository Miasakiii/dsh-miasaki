# M36 registry 重扫（2026-08-22）

> 从原 `docs/m36-rc8-regression-smoke-2026-08-22.md` 拆出的编排线部分。
> 平台级回归见 `../../dsh-miasaki-shared-docs/dsh-platform/m36-rc8-regression-2026-08-22.md`。

`workers/discovery/scan-agents.ps1` 重扫结果：

| id | 旧版本（HANDOVER 记） | 新版本（本次重扫） | 备注 |
|---|---|---|---|
| bl | 1.16.0 | 1.16.0 | 不变 |
| claude | 2.1.233 | **2.1.238** | 升级 |
| gemini | 启动失败 | **0.55.1** | 版本探测已通；invoke 仍待校准（403 区域限制预案不变） |
| opencode | 1.18.18 | 1.18.18 | 不变 |
| dsh | rc.6（**过期**） | **0.1.1-rc.1** | **本次主修** |
| pi | 0.84.1 | 0.84.1 | 不变 |
| mimo | 0.1.12 | 0.1.12 | invoke 语法仍待校准 |
| agent-browser | 0.34.0 | 0.34.0 | 命令型，非 prompt 型 |

- 8/8 全部发现并刷新 `cli` 字段；Operator 编辑字段未被覆盖（脚本仅刷新 discovered 元数据）。
- 日志 `tests/m3-acp/logs/m36/scan-output.log`。
