# analyst 自持久要点（notes.md）

- 首任务 t-0001 完成：官方 subagent 四件套 vs 自研薄壳七维选型对照。
- 核心判断：M3 首选 @deepseek-ai/dsh-subagent-dsh-sdk（完整 DSH runtime 子进程），协议层备选 dsh-subagent-acp，自研薄壳降级为兜底。
- 最大风险：主包 0.1.0-rc.6 与 subagent 线 0.0.1-rc.1 双版本线，混装必须用独立 profile（建议名 m3-test）实测 cordis 兼容。
- 审批桥：ACP session/request_permission + permission-presets 是 v2 现成通路；codex/claude 权限自动拒绝，只派只读任务。
- 两处待实测：ACP 层 usage 透传；Windows 上 dispose 阶梯/进程树退出证明（官方示例 bash，本机 pwsh）。
- 本 agent metering=false（fork 无回执），不写 usage.jsonl。
- t-0002 完成（M3.5 keyless 验证轮，mock 应答）
- t-0004 完成（M3.5 keyless 验证轮，mock 应答）
