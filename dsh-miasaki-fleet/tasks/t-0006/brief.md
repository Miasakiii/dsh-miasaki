# 任务 t-0006：本机 agent CLI 阵容总结

## 目标
读取 agents/registry.json，用一段话总结本机已安装的 agent CLI 阵容（名称 + 版本 + 各自主打用途），并给出「每个 CLI 最适合派哪类任务」的建议表。

## 交付物
- [ ] 答案直接输出在 stdout（claude -p headless 模式），由派单器捕获
- [ ] 结论写入 tasks/t-0006/result/result-t-0006.md（派单器/Commander 代写）

## 约束
- 只读任务：只读 agents/registry.json 与 agents/<id>/manifest.json，不修改任何文件
- 预算：中等；超时：10 分钟
- 依赖任务：无

## 验收标准
1. claude CLI 进程真实执行（headless -p，json 输出含成本字段）
2. 总结覆盖 registry 中全部 8 个 CLI
3. 建议表含「任务类型 → 首选 CLI」映射

## 完成后必做
1. 结论由派单器捕获并落盘 result-t-0006.md
