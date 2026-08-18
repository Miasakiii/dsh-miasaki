# 任务 t-0002：M3.5 worker 自动化 keyless 验证

## 目标
验证 M3.5 worker CLI 的完整闭环：开关检查 → inbox 领取 → 子运行时 spawn/握手 → 执行 → 交付落盘 → 状态机更新。本轮子模型为 mock 脚本应答（keyless）。

## 交付物
- [ ] tasks/t-0002/result/result-t-0002.md（由 worker 包装层按 §4.7 结构落盘）
- [ ] agents/analyst/notes.md 追加本任务要点
- [ ] agents/analyst/status.json 终态 idle（执行期为 running + 心跳）
- [ ] agents/analyst/transcript.md 追加本任务记录
- [ ] 子运行时独立会话日志（agents/analyst/sessions/t-0002/）

## 约束
- 预算：50K tokens；超时：15 分钟
- 只写自己的目录与 tasks/t-0002/；不修改 workspace 其他文件
- 依赖任务：无

## 验收标准
1. worker 进程由总指挥作为后台任务启动，非手动扮演；
2. 领取采用 rename 原子化（inbox 出现 .claimed 文件）；
3. 子运行时（完整 harness 进程）经 initialize 握手后被 SDK 客户端驱动；
4. 交付物与状态机文件齐全且格式合规；
5. 开关 off 语义：control.json.enabled=false 时 worker 排空后退出（本轮验证关→开→关）。

## 完成后必做
1. 结论写入 result-t-0002.md
2. notes.md 更新 ≤10 行
3. 广播建议如有，单列于 result
