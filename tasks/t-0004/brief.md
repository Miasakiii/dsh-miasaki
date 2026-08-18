# 任务 t-0004：collective-memory 精简索引

## 目标
审阅 shared/collective-memory.md，产出一份 ≤15 行的精简索引（主题 + 一行要点），供后续任务的 context.md 快速引用。

## 交付物
- [ ] tasks/t-0004/result/result-t-0004.md（§4.7 结构）
- [ ] agents/analyst/notes.md 追加要点

## 约束
- 预算：50K tokens；超时：15 分钟
- 只写自己的目录与 tasks/t-0004/；不修改 workspace 其他文件
- 依赖任务：无
- 本轮为双 worker 并行隔离验证（mock 模型应答）

## 验收标准
1. result 结构符合 §4.7
2. 索引覆盖 collective-memory 全部主题节
3. 每行一条要点，总计 ≤15 行

## 完成后必做
1. 结论写入 result-t-0004.md
2. notes.md 更新 ≤10 行
