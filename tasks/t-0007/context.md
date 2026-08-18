# 上下文捆绑包：t-0007

- 并发派单验证（P1）：opencode 与 pi 同时各执行一个任务，验证进程隔离与协议文件互不干扰。
- 你的 agent 档案：agents/opencode/manifest.json（可读取其中的 model 配置）。
- 派单器：workers/dispatch/dispatch-task.ps1（本轮由 Commander 并行启动两个实例）。
