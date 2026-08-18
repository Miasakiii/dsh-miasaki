# 任务 t-0005：百炼账户免费额度与用量状态查询

## 目标
查询本机 bl CLI（Bailian）账户的免费额度状态与用量摘要，验证「Commander → 真实 agent CLI 派单」闭环。

## 交付物
- [ ] tasks/t-0005/result/result-t-0005.md（§4.7 结构）
- [ ] agents/bl/transcript.md 追加本次 CLI stdout

## 约束
- 只读查询，不产生任何写操作/计费
- 派单 CLI：bl 1.16.0（Operator 已确认升级）；命令按 bl 家族技能路由：`bl usage free`（免费额度）+ `bl usage stats`（用量摘要，可用则执行）
- 依赖任务：无

## 验收标准
1. CLI 进程真实执行且 stdout 被完整捕获
2. result 含免费额度/用量两项状态（或明确说明某项不可用及原因）
3. 全程只读，无副作用

## 完成后必做
1. 结论写入 result-t-0005.md
