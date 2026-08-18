# 任务 t-0001：官方 dsh-subagent 四件套 vs 自研薄壳 — 选型对照分析

## 目标
产出一份 runtime 选型对照报告，为设计文档 M3 里程碑的决策提供依据。

## 交付物
- [ ] tasks/t-0001/result/result-t-0001.md（固定结构，见设计文档 §4.7）
- [ ] agents/analyst/notes.md（≤10 行要点）
- [ ] agents/analyst/status.json（开始时置 running，结束时置 idle）

## 输入（只读）
- docs/dsh-official-repo-review-2026-08-16.md
- docs/multi-agent-cli-orchestrator-design.md（重点 §4.7、§9、§10、§11、§12）

## 约束
- 预算：50K tokens 以内；超时：15 分钟
- 只写自己的目录（tasks/t-0001/result/ 与 agents/analyst/），不修改 workspace 中任何其他文件
- 依赖任务：无
- 本 agent metering=false（M1 手动阶段），不需要写 usage.jsonl

## 验收标准
1. result-t-0001.md 结构符合设计文档 §4.7（结论/完成度/数据来源/遇到的问题/广播建议/下一步建议）
2. 对照维度覆盖：协议标准度、usage 计量、进程管理、故障恢复、审批桥、维护成本、版本线风险
3. 每个关键结论标注出处（调研报告章节或设计文档章节）
4. 给出 M3 的明确建议（先测哪个包、用什么 profile、成功/失败两条路径）

## 完成后必做
1. 结论写入 tasks/t-0001/result/result-t-0001.md
2. 用 ≤10 行要点更新 agents/analyst/notes.md
3. 如有值得全体知晓的发现，在 result 中单列 "## 广播建议"
4. 把 agents/analyst/status.json 置为 state=idle（progress=1.0）
