# 任务 t-0009：OpenViking 记忆链路哨兵验证

## 目标
一句话回答「OpenViking 是什么」，并在回答末尾**原样输出**哨兵词 `OV-PEER-SENTINEL-0924`（不要改动任何字符）。本任务只用于验证 worker 会话记忆被 OpenViking 捕获、提取并可检索。

## 交付物
- [ ] 答案直接输出在 stdout（claude -p headless 模式），由派单器捕获
- [ ] 回答末尾含原样哨兵词 `OV-PEER-SENTINEL-0924`

## 约束
- 只读任务：不修改任何文件
- 预算：极低；超时：10 分钟
- 依赖任务：无

## 验收标准
1. claude CLI 进程真实执行（headless -p，json 输出含成本字段）
2. stdout 中哨兵词原样出现
3. 后续 `ov find "OV-PEER-SENTINEL-0924"` 可检索到本任务内容（OpenViking 捕获/提取/检索链路）

## 完成后必做
1. Commander 用 ov CLI 验证哨兵可检索
