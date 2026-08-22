# 官方仓库复查增补：0.1.0-rc.7 与本地快照

- 日期：2026-08-17
- 调研者：总指挥（Miasaki 会话）
- 增补对象：docs/dsh-official-repo-review-2026-08-16.md

---

## 1. 今天仓库动了：0.1.0-rc.7 已发布

| 项 | 值 |
|---|---|
| 最新推送 | 2026-08-17T12:01:58Z |
| master HEAD | 99f6f02fe（= Merge PR #2620 release/dsh-0.1.0-rc.7） |
| npm dist-tags | latest = 0.1.0-rc.6；next = 0.1.0-rc.7（rc.7 暂未转正） |
| rc.6 → rc.7 | 106 个提交（15148dbd9a1d...bb4ca698d） |
| star 数 | 145,447（昨天 125,824，一天 +2 万） |
| 其他 | Issues 和 Pull Requests 均对外禁用（镜像式仓库，反馈只能走 Discussions）；仍无 tag/Releases |

## 2. rc.7 里的关键新东西（按对你的项目的重要度排序）

### 2.1 Codex / Claude Code 子 agent 支持后台运行（★最重要）

- feat(agent-presets)：subagent_codex / subagent_claude_code 工具支持 run_in_background: true → 走通用后台 Job 运行时，返回父级拥有的 Job id，用 job_output / job_list / job_kill 收集与取消，完成时发通知。
- 产品提供方是显式 opt-in：生产 dsh 不打包它们；Profile 安装 dsh-subagent-codex / dsh-subagent-claude-code，在 host plane 挂载一次；Agent Preset 通过工具行暴露（删掉 disabled 即可）。加载不会启动产品进程；第一次委派才 spawn。
- 生命周期闭环：Job 取消信号覆盖提供方启动与执行 → run.dispose() → 进程树完全停稳。

### 2.2 ACP 富内容桥接（rich-content bridge）

- feat(acp)：ACP 现在可以桥接持久化图片 prompt 与 reply（session/request_permission 也参与图片入场审批）；配套修复了 attachment 的「入场 vs 存储失败」区分、code mode 嵌套图片结果转发、MCP 图片结果经持久化附件。

### 2.3 Web 插件自有设置面板

- feat(settings)：注册过的每个 namespace/key 都会在 Web 设置里得到自己的插件卡片（plugin-owned settings surface）。对 M2 面板插件意味着：面板配置项可以直接落在官方设置 UI 里，不用自建设置页。

### 2.4 其他

- fix(web)：pwsh 终端 overlay 重复 loader（Windows 相关修复）
- node-pty 1.2-beta、persistent bash 受控提示符修复、max-token 重放状态对齐修复
- python SDK 模型可见表面断言；CI 增加原生 Windows PR 流水线

## 3. 本地快照（已可离线查阅）

- 位置：_refs/deepseek-harness（master @ 99f6f02 = rc.7 合并点；45.9MB；49 个 packages；含全部中英文文档）
- 沙箱限制说明：git/curl 的 schannel TLS 被环境拦截，快照是经 gh api zipball 下载解压的，不含 .git 历史（需要 diff/历史时继续用 gh api 或 web）。
- 建议先看的路径：
  - docs/capability-seams.zh.md（含 subagent/codex/claude-code 的架构图）
  - docs/config-catalog.zh.md（dsh-subagent-acp / dsh-subagent-dsh-sdk 的完整配置项）
  - docs/subsystems/（subagent / approval / jobs / goal / sandbox 子系统参考）
  - acp/README.zh.md、examples/（acp-agent / headless-agent / jsonrpc-agent）
  - .agents/notes/implemented/（每个功能一篇决策笔记，中英文齐全——官方「设计文档」库）

## 4. 对你现有工作的增量影响

1. M3 worker 自动化有了官方直通车：你的 fleet worker = Codex/Claude Code/DSH 子 agent 当后台 Job 跑；「进程托管器（spawn/排空/kill）」≈ 官方的 Job 注册表 + provider dispose 阶梯。自研薄壳的必要性进一步下降。
2. Operator 开关的映射更清晰：面板开关 → job_kill（force_kill 语义）/ preset 工具行 disabled（fleet 裁剪）；本 GUI 已经直接显示 Job 状态。
3. ACP 支持图片：如果你的 worker 要做多模态任务（截图、图表验收），ACP 通道现在能带图了——你的 §4.6 brief/context.md 设想可以包含图片附件。
4. 注意版本节奏：rc.7 挂在 next，npm i @deepseek-ai/dsh@next 才能拿到；升级前先确认本地 profile 的 cordis 4.x 兼容。产品提供方仍需本机装有 codex / claude CLI 并完成各自登录。

## 5. 行动建议更新

1. 【P0 保持】用本会话 subagent_fork + 文件总线跑 M1 手动闭环。
2. 【P0 新增】把 _refs/deepseek-harness/docs/capability-seams.zh.md 与 .agents/notes/implemented/feature/2026-08-12-product-subagent-one-shot-background-tasks.zh.md 读一遍，修订设计文档 §12/§13 的 runtime 选型与 M3 方案。
3. 【P1】测试 profile 安装 dsh-subagent-codex（若本机有 codex）验证 opt-in 与后台 Job 路径。
4. 【P1】跟踪 rc.7 转正（latest）的时点，再决定是否整体升级本地 dsh。
