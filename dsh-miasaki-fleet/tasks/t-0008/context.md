# 上下文捆绑包：t-0008

- 并发派单验证（P1）：pi 与 opencode 同时各执行一个任务，验证进程隔离与协议文件互不干扰。
- 你的 agent 档案：agents/pi/manifest.json。
- 派单器：workers/dispatch/dispatch-task.ps1（本轮由 Commander 并行启动两个实例）。
