# 编排线后续任务（2026-08-20 拆分）

> 从原 `docs/next-tasks-plan-2026-08-20.md` 拆出的编排线相关项。
> 平台级 rc.8 事实见 `../../dsh-miasaki-shared-docs/dsh-platform/rc.8-upgrade-2026-08-20.md`。

## 已完成
- [x] **P0 设计文档 §12 更新**：`docs/multi-agent-cli-orchestrator-design.md` §12 版本线状态改为 latest=rc.7 / next=rc.8；补记本次未走「升级前回归冒烟」纪律；subagent 线仍 0.0.1-rc.1。
- [x] **rc.8 回归冒烟 m36**（2026-08-22）：详见 `m36-registry-rescan-2026-08-22.md` + 平台级 `../../dsh-miasaki-shared-docs/dsh-platform/m36-rc8-regression-2026-08-22.md`。
- [x] **registry 重扫**：`workers/discovery/scan-agents.ps1` 刷新 8/8；dsh 档案 rc.6→0.1.1-rc.1、claude 2.1.233→2.1.238、gemini 探测通（0.55.1，invoke 仍待校准）。日志 `tests/m3-acp/logs/m36/scan-output.log`。

## 待办
- [ ] gemini 换可用模型 / mimo invoke 语法 / dsh 建 headless profile / opencode+pi 计量校准。
