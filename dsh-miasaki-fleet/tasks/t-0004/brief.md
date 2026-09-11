# 任务 t-0004：collective-memory 精简索引

## 目标
审阅 shared/collective-memory.md，产出一份 ≤15 行的精简索引（主题 + 一行要点），供后续任务的 context.md 快速引用。

## 交付物
- [ ] **索引完整输出到 stdout**（headless `claude -p`，派单器捕获 JSON 的 `result` 字段）
- [ ] tasks/t-0004/result/result-t-0004.md（§4.7 六段结构；**派单器/Commander 代写**）
- [ ] agents/claude/notes.md 追加要点（**派单器代写**；worker 在 stdout 给出待追加内容）

## 约束
requires: analysis
- 预算：50K tokens；超时：15 分钟
- **只读执行**：headless 下 Bash/Write 权限被权限栈自动拒绝（设计 §11.2 既定行为，实测见 t-0006）——不要把索引写成文件，全部产出走 stdout
- 依赖任务：无
- 派单方式：**真实 CLI**（`claude -p {prompt} --output-format json`），非 mock；按真实仓库内容作答

## 验收标准
1. stdout 结论符合 §4.7 六段结构（结论 / 完成度 / 数据来源·依据 / 遇到的问题 / 广播建议 / 下一步建议）
2. 索引覆盖 collective-memory 全部主题节
3. 每行一条要点，总计 ≤15 行

## 完成后必做
1. 把索引与结论按 §4.7 六段输出到 stdout —— 派单器据此代写 result-t-0004.md
2. 在 stdout 末尾用 ≤10 行给出 notes.md 待追加要点（派单器追加）

## 改派记录（2026-09-11，Commander）
- 原 assignee analyst 已归档；G2 报 research / comparative-analysis / zh-report 三项零活动提供者。
- 改派 claude，依据同上（t-0006 实测交付过同仓中文报告）。
- ⚠️ 源文档时效：shared/collective-memory.md 最后更新 2026-08-16，内容停留在建库期（含已废弃的 dsh-sdk 路线）。本轮仅做只读快照索引；文档本身的策展（Commander 职责）与索引同步列为后续项。

## 修订记录（2026-09-11，Commander）
- **执行语境修正**：原文「本轮为双 worker 并行隔离验证（mock 模型应答）」是 2026-08-17 的语境，与本次真实 CLI 派单矛盾 → 改为真实 `claude -p` 派单。
- **交付物协议对齐**：原文要求 worker 自己写 result/notes；实测（t-0006，设计 §11.2）headless 下 Write/Bash 权限被自动拒绝 → 按既定「派单器代写」协议改写，worker 只负责 stdout 产出。
- 未改动：`requires: analysis`（能力闸门依赖它）、预算/超时、验收标准 2/3 条、源文档时效的处置结论。
