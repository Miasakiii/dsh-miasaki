# 后续任务规划

- 日期：2026-08-17（会话收尾规划）
- 状态：设计稿，下次会话按此推进（优先级自上而下）

## 当前基线（v0.13 时点）

- 协议：设计文档 v0.13；扫描器（8 CLI 档案+skills+preflight）、派单器（预算预检+usage 自动解析）就绪；
- fleet：4/8 立即可用（claude/bl/opencode/pi），gemini 半可用，mimo/agent-browser/dsh 待解锁；
- 账本：t-0001~t-0008 八任务闭环，真实成本 $0.414（claude），事件流 21+ 条；
- 面板：pkg-3 二分版部署中，**可见性验证待 Operator 硬刷新**（最老欠账）。

## P0 — 面板可见性收尾（30 分钟内可决）

| 步骤 | 内容 | 判定 |
|---|---|---|
| 1 | Operator 硬刷新（Ctrl+Shift+R），看「Fleet 监控」页签的「[v3] 若看到本行」 | 有蓝字 → 渲染管线通，下一步；无 → 换挂载 |
| 2a | 通：恢复完整面板（双形态：settings.section 控制台页 + overlay 气泡），补开关/派单按钮 | 面板+开关上屏 |
| 2b | 不通：换 `sidebar.footer.action`（左侧栏底部入口，root 级）或独立路由；再不行排查桌面端（Miasaki 壳重启） | 面板出现 |
| 3 | Operator 开关闭环：拨关→拨开，验证 control.json 落盘 + 派单器预检联动 | M2 欠账清零 |

## P1 — CLI 解锁三件 + 计量两件

1. **gemini 换模型**：`gemini` 默认 gemini-3.5-flash 区域受限（403）——`gemini config` 或 `-p --model <可用模型>` 试跑，成功后更新档案 `cli.invoke`；
2. **mimo 语法校准**：位置参数被当目录（实测）——`mimo --help` 确认正确调用（交互式还是 flag 式），更新 invoke；
3. **dsh headless profile**：复用 vendor 仓库 `examples/headless-agent` 组合，或扩展 m3-test profile → `dsh --profile headless "任务"` 一次性执行；
4. **opencode 计量**：`opencode run --format json` 探测 usage 字段 → metering_source 落地 + 派单器注册解析器；
5. **pi 计量**：`pi -p --mode json` 探测 → 同上。

## P1 — 派单器补强

- 并发派单已验证；补「交付回执」：派单器输出结构化 JSON（task/exit/输出路径/usage），供 Commander 一键验收；
- 预算熔断真实触发演练（人为把 budget 调低派单 → 确认拒绝 + 面板提示）。

## P2 — 报表与面板联动

1. **成本报表脚本**（`workers/report/cost-report.ps1` 或并入面板）：ledger 按 agent/日聚合 + cache-read 占比（§7.6 度量）；当日/累计/按 CLI 三视图；
2. **面板联动**：开关 + 一键派单按钮（复用 dispatch-task.ps1）+ 实时状态/对话框查看（pkg-5/pkg-6 代码已备，改挂载即用）。

## P2 — M4/M5/M6

- **M4 fleet 适配闭环**：skills 已就位 → 无匹配暂存（waiting_for）+ 开启建议流程实现（Commander 侧 + 面板提示）；
- **M5 健壮性**：超时 kill、重启包、reopen 上限演练（人为制造故障）；
- **M6 混合项目首演**：一个真实多任务项目走 DAG——claude 写代码 → opencode 审查 → agent-browser 验证页面 → bl 查配额；同模型对照实验（opencode vs pi 同 deepseek-v4-flash）随项目顺带产出。

## 风险与备忘

- 动态插件/后台任务进程级：新会话先重建面板插件 + 重启必要后台（collective-memory §6）；
- bl/claude 派单有真实成本（claude 单任务可能 $0.4+），大任务前先 -CheckOnly；
- 面板仍不可见时，一切 UI 侧验收顺延，优先推进可自证的后端项。
