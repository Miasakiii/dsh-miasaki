# dsh-miasaki-fleet — 多 Agent CLI 编排线

**一个总指挥（大会话）+ N 个 worker CLI（小会话）**，以文件总线为唯一协调通道：
人类 Operator 决定 fleet 开关 → 总指挥发现/校准/派单 → worker CLI 执行 →
计量与心跳落盘 → 监控面板/桌宠联动展示。完整协议见
[docs/multi-agent-cli-orchestrator-design.md](docs/multi-agent-cli-orchestrator-design.md)。

## 目录

| 目录 | 职责 |
|---|---|
| `agents/` | agent 档案（manifest/control/status/usage，运行时产物已 ignore） |
| `state/` | 任务台账 / 成本账本 / 事件流 / `fleet-pulse.json`（运行时产物） |
| `tasks/` | 任务书 brief 与交付物 |
| `workers/` | 扫描器（discovery）、派单器（dispatch）、总线校验（validate-bus.mjs）、脉冲发布（pulse/publish-pulse.mjs） |
| `fleet-monitor/` | 监控面板（panel.html + server.js，本地 HTTP） |
| `schemas/` | 文件总线 JSON Schema（F1 契约） |
| `docs/` | 设计文档与调研/校准报告 |
| `tests/` | 回归冒烟与样本 |

## 常用命令

```bash
node workers/validate-bus.mjs            # 文件总线全量校验（零依赖）
node workers/validate-bus.mjs --strict   # 额外要求 fleet-pulse.json 存在
node workers/pulse/publish-pulse.mjs     # 发布 fleet-pulse.json v2（A×B 联动契约）
npm run validate / validate:strict / pulse
```

## 关键机制（2026-09-04 批次）

- **F1 总线校验**：`schemas/*.schema.json` + `workers/validate-bus.mjs` 对
  registry/manifest/control/status/tasks/ledger/events/usage 全量校验，坏行报行号；
  PowerShell 生成的 UTF-8 BOM 自动剥离，`agents/archive/` 标本跳过，被 ignore 的
  运行时文件缺失时跳过。
- **F2 计量全源覆盖**：派单器按 `metering_source` 注册表解析（`json-cost-usd` /
  `session` / `console-usage` / 未知），无机器可读计量时写**显式未计量行**
  （`cost: 0, metered: false`），杜绝静默缺口。
- **X1 脉冲发布**：`workers/pulse/publish-pulse.mjs` 聚合 fleet 五计数 +
  当日成本写 `state/fleet-pulse.json`（原子写），供桌面端桌宠 Fleet 指示器
  2s 轮询（契约见
  [`../dsh-miasaki-shared-docs/cross/ab-linkage-pulse-v2-2026-09-04.md`](../dsh-miasaki-shared-docs/cross/ab-linkage-pulse-v2-2026-09-04.md)）。
- **BOM/CRLF 容错**：`fleet-monitor/server.js` 与脉冲发布器读取 JSON/JSONL
  均剥离 BOM、按 `\r?\n` 分行，兼容本机 PowerShell 产物。

## 变更记录

设计决策与协议变更记录在
[docs/multi-agent-cli-orchestrator-design.md](docs/multi-agent-cli-orchestrator-design.md)
头部「变更记录」。
