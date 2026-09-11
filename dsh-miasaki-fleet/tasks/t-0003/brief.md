# 任务 t-0003：worker 交付物自查脚本设计

## 目标
为 M3.5 worker 设计一份「交付物自查清单」的脚本化方案：worker 完成任务后如何自查交付物合规（result 结构、notes 行数、status 终态）。

## 交付物
- [ ] **结论完整输出到 stdout**（headless `claude -p`，派单器捕获 JSON 的 `result` 字段）
- [ ] tasks/t-0003/result/result-t-0003.md（§4.7 六段结构；**派单器/Commander 代写**）
- [ ] agents/claude/notes.md 追加要点（**派单器代写**；worker 在 stdout 给出待追加内容）

## 约束
requires: coding
- 预算：50K tokens；超时：15 分钟
- **只读执行**：headless 下 Bash/Write 权限被权限栈自动拒绝（设计 §11.2 既定行为，实测见 t-0006）——不要把结论写成文件，全部产出走 stdout
- 依赖任务：无
- 派单方式：**真实 CLI**（`claude -p {prompt} --output-format json`），非 mock；按真实工具环境作答

## 验收标准
1. stdout 结论符合 §4.7 六段结构（结论 / 完成度 / 数据来源·依据 / 遇到的问题 / 广播建议 / 下一步建议）
2. 自查清单覆盖：result 文件存在性、结构段落完整性、notes ≤10 行、status 终态字段
3. 给出可脚本化的伪代码/命令行方案

## 完成后必做
1. 把结论按 §4.7 六段完整输出到 stdout —— 派单器据此代写 result-t-0003.md
2. 在 stdout 末尾用 ≤10 行给出 notes.md 待追加要点（派单器追加）

## 改派记录（2026-09-11，Commander）
- 原 assignee coder 已归档（G2 能力图首次运行暴露：engineering/zh-report 零活动提供者）。
- 改派 claude：提供 cap:coding，且 t-0006 实测交付过同仓中文报告（真实证据，非档案声明）。
- brief 原文中 agents/coder/notes.md 一并修正为 agents/claude/notes.md（任务书亦绑定已归档 agent，非仅 assignee 问题）。

## 修订记录（2026-09-11，Commander）
- **执行语境修正**：原文「本轮为双 worker 并行隔离验证（mock 模型应答）」是 2026-08-17 的语境，与本次真实 CLI 派单矛盾 → 改为真实 `claude -p` 派单。
- **交付物协议对齐**：原文要求 worker 自己写 result/notes；实测（t-0006，设计 §11.2）headless 下 Write/Bash 权限被自动拒绝 → 按既定「派单器代写」协议改写，worker 只负责 stdout 产出。
- 未改动：`requires: coding`（能力闸门依赖它）、预算/超时、验收标准 2/3 条。
