# 任务 t-0003：worker 交付物自查脚本设计

## 目标
为 M3.5 worker 设计一份「交付物自查清单」的脚本化方案：worker 完成任务后如何自查交付物合规（result 结构、notes 行数、status 终态）。

## 交付物
- [ ] tasks/t-0003/result/result-t-0003.md（§4.7 结构）
- [ ] agents/coder/notes.md 追加要点

## 约束
- 预算：50K tokens；超时：15 分钟
- 只写自己的目录与 tasks/t-0003/；不修改 workspace 其他文件
- 依赖任务：无
- 本轮为双 worker 并行隔离验证（mock 模型应答）

## 验收标准
1. result 结构符合 §4.7
2. 自查清单覆盖：result 文件存在性、结构段落完整性、notes ≤10 行、status 终态字段
3. 给出可脚本化的伪代码/命令行方案

## 完成后必做
1. 结论写入 result-t-0003.md
2. notes.md 更新 ≤10 行
