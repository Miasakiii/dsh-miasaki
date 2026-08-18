# 官方仓库（deepseek-ai/deepseek-harness）状态调研报告

- 日期：2026-08-16
- 调研者：总指挥（Miasaki 会话）
- 调研方式：gh CLI（已认证）+ npm registry + 本地安装包对照 + web 检索（agent-reach 技能）
- 结论速览：**本地安装的 rc.6 就是 npm 最新版；真正的“新东西”是独立发布的进程外 subagent 四件套（ACP / DSH SDK / Codex / Claude Code）与官方 examples/docs 体系——它们与《多 Agent CLI 协作模式 v0.2》的设计高度同构，可直接替换文档里“自研薄壳 CLI”的 v1 方案。**

---

## 1. 官方仓库状态

| 项 | 值 |
|---|---|
| 仓库 | deepseek-ai/deepseek-harness（GitHub） |
| 公开时间 | 2026-08-13（created_at: 2026-08-13T11:56Z） |
| 默认分支 | master（无 tag、无 Releases、**Issues 已禁用**，反馈走 Discussions） |
| 热度 | **125,824 stars / 12,509 forks**（公开 3 天） |
| 最后推送 | 2026-08-13T13:00Z（= Merge PR #2519 feat/npm-public，master HEAD 47f943859）；此后 3 天无新提交 |
| npm latest | @deepseek-ai/dsh@0.1.0-rc.6（08-13 12:35 发布）——**与本地安装版本完全一致** |
| 版本史 | 0.0.1-rc.1 → rc.2 → rc.5 → 0.1.0-rc.2 → rc.3 → rc.6（全部在 08-10 ~ 08-13 四天内发布） |
| 状态声明 | README 明示 developer preview，**“THERE WILL BE COMPATIBILITY-BREAKING CHANGES”** |

周提交活跃度（近期）：37 → 312 → 175 → 371 → 658 → 1422 → 2169 → **3646** → 1566 → 1436。开发极其活跃，峰值周 3600+ 提交；公开后回落但仍在千级。

**含义**：主 npm 包没有比本地更新的版本；若只盯 @deepseek-ai/dsh，你是最新的。新东西分布在别处（见下）。

---

## 2. 新东西清单（相对本地 rc.6 安装）

### 2.1 已发布但**未打包进默认安装**的独立能力线（npm 可装）

全部发布于 08-10 ~ 08-13，版本线 0.0.1-rc.1，与主包 rc.6 是两条线：

| 包 | 作用 |
|---|---|
| @deepseek-ai/dsh-acp | **ACP（Agent Client Protocol）服务器**：JSON-RPC over stdio。session/new、session/prompt、session/update（committed 文本流）、session/cancel、session/request_permission（一次性 allow/reject，客户端可自动应答）。stdout 纯协议帧，一条连接多 session，每 session 独立 prompt slot。 |
| @deepseek-ai/dsh-subagent-acp | **进程外 subagent**：spawn → ACP initialize → newSession → prompt → 收集 committed text；dispose() 幂等阶梯（关 stdin → 优雅宽限 → SIGTERM/SIGKILL → 整进程树退出证明）。 |
| @deepseek-ai/dsh-subagent-dsh-sdk | 子进程 = **完整 DSH runtime**（dsh-jsonrpc-agent），经 TypeScript SDK 驱动；子进程有**自己的 cordis.yml 组合、会话持久化、模型路由、工具**。 |
| @deepseek-ai/dsh-subagent-codex | 真实 **Codex app-server** 子进程（官方 codex CLI）；单线程单任务，权限请求按策略拒绝，返回最终答案。 |
| @deepseek-ai/dsh-subagent-claude-code | 真实 **Claude Code** 子进程（官方 Claude Agent SDK）；同一 SubagentResult 契约。 |

四个 provider 共享统一契约：cwd = 父会话 workspace、取消映射（aborted / error / max-tokens）、幂等回收。

### 2.2 官方 examples（仓库内，未进 npm 主包）

- examples/acp-agent — 面向程序化客户端的 ACP 服务器组合（含 workspace-write 沙箱 → session/request_permission 触发演示）
- examples/headless-agent — headless 编码 agent 完整组合：V4 + bash/fs + subagent 委派 + workflow + Ralph + todo + JSONL 持久化；另附 **E2B 沙箱 POC overlay**
- examples/jsonrpc-agent — Python SDK 的 JSON-RPC runtime（独立可执行，目标机无需 Node.js）
- examples/mcp-memory、examples/web-cordis、examples/web-schedule

### 2.3 文档体系（仓库 docs/）

- docs/subsystems/*：approval、goal、jobs、plan、sandbox、schedule、persistence、compaction、session-query、session-telemetry 等子系统参考
- docs/tool-catalog.md（全工具目录 + 源码位置）、docs/capability-seams.md（能力接缝）、docs/api-gateway.md、docs/config-catalog.md、docs/agent-lifecycle.md
- docs/cookbook/*：adding-a-tool / adding-a-package / adding-a-conversation-node 等（**做动态 Cordis 插件的直接教材**）
- 大部分文档有 .zh.md 中文版

### 2.4 本地 rc.6 已装但你（Miasaki 会话）可能未意识到的能力

- 本会话工具面已含：subagent / subagent_fork（可续接、可 send_message / interrupt / list_agents）、workflow（多阶段编排）、goal（自主多轮目标）、jobs（后台进程 + 输出流）、ask_user_question（人类交互）、todo_write
- Web GUI 已内置 client slot：dsh-client-ui-subagent、dsh-client-ui-goal、dsh-client-ui-jobs、dsh-client-ui-workflow-run
- dsh-api-gateway + dsh-api-remotes（API 网关/远端）、dsh-permission-presets（权限预设）、dsh-sandbox-windows-acl（Windows ACL 沙箱——设计文档 §11.2 的“v2 可选 OS ACL 强制”官方已有）

### 2.5 社区

- **Electricitysheep/dsh-handbook**（342★，今天仍在更新）：“从 0 到 1 深度手册”，含**同模型多 Agent 实测对比**——与你的多 agent 方向直接相关
- Discord 社区 + GitHub Discussions（Issues 关闭后的官方反馈渠道）+ dsh-plugin topic

---

## 3. 对现有工作（多 Agent CLI 协作模式 v0.2）的帮助

### 3.1 结论一句话

**你的设计文档里“v1 自研薄壳 CLI + 文件总线 + 进程托管器”的整套自研工程量，官方已经用 ACP + subagent providers 实现了大半，而且协议更标准、生命周期更稳。** 建议把 runtime 选型表（§12）重排，把自研从“v1 首选”降为“仅在需要文件总线审计时保留”。

### 3.2 逐节对照

| 设计文档章节 | 官方对应物 | 建议 |
|---|---|---|
| §2/§3 文件总线 + 进程托管 | ACP stdio（JSON-RPC）+ provider 的 spawn/dispose 阶梯 | 文件总线**保留为审计/人工可读层**，通信与进程托管换 ACP；不再需要自研协议 |
| §4.4 usage.jsonl 计量 | 本会话 token 计量 + session-telemetry；child 的 usage 随 SubagentResult 返回 | 计量义务仍由 worker 侧落盘，但可读官方 usage 回执而不是手算 |
| §7 worker 主循环 / inbox 领取 | ACP 每 session 一个 in-flight prompt slot；session/prompt 一次一问 | “原子领取”语义天然成立（单槽），不需要 rename 技巧 |
| §8 监控面板 M2 | 本会话 Web GUI 已内建 subagent/goal/jobs 面板 slot；cookbook + capability-seams 是动态 Cordis 插件教材 | M2 照原计划做动态 Host+Client 插件，但**先读 cookbook，别从零摸** |
| §9/§10 故障与恢复 | provider 的 dispose 幂等阶梯 + 取消映射 + 进程树退出证明 | 官方语义覆盖你 §10 表的大半：kill、重启、崩溃检测 |
| §11.2 审批传播（v2） | ACP session/request_permission + approval 子系统 + permission-presets | v2 的“审批汇总到面板”有现成通路 |
| §12 runtime 选型 | dsh-subagent-dsh-sdk = 完整 DSH runtime 子进程；codex / claude-code = 异构 CLI 子 agent | **重写选型表**：v1 直接用 dsh-sdk provider 起 worker；“bl CLI”若有 ACP 支持可走 acp provider；DSH headless 提前到 v1.5（examples/headless-agent 有现成组合） |
| §12 人设/preset | packages/preset/（agent-presets、persona），本地已装 dsh-persona | M6 “worker = DSH preset 会话”有官方 preset/persona 机制支撑 |
| §13 里程碑 | — | M1 不变（我=Commander 用本会话 subagent_fork 手动闭环）；**M3 从“自研薄壳”改为“装 dsh-subagent-acp/dsh-sdk 起 worker”**，工期大减 |

### 3.3 立刻能做的事（本会话内，不装任何东西）

1. **M1 手动闭环**：用本会话的 subagent_fork（继承会话上下文）当第一个“手动 worker”，按 §4 协议在 workspace 里落盘 brief/result/usage，走一遍“任务分解 → 派单 → 验收 → 台账”。
2. **Operator 开关原型**：ask_user_question 工具就是“人类操作员拨开关”的现成通道；jobs（后台进程）+ job_kill 近似 §4.2 control.json 的进程语义。
3. **面板 MVP**：本 GUI 已显示 jobs/todos 状态——M2 的面板可以做成覆盖这些 slot 的动态插件，先读 docs/cookbook/adding-a-tool.md + docs/web-styling.md。

### 3.4 需要装东西的验证清单（建议下一步）

1. 用 dsh plugin（README 语法：dsh plugin --profile <name> <pnpm args>）把 @deepseek-ai/dsh-subagent-acp 或 dsh-subagent-dsh-sdk 装进一个测试 profile；先 npm view 确认它们与 rc.6 主包的 cordis 版本兼容（@deepseek-ai/cordis 4.x）。
2. 克隆官方仓库跑 examples/acp-agent 与 examples/headless-agent 两个 demo 验证协议行为。
3. 读 docs/subsystems/subagent.md、docs/subsystems/approval.md、docs/capability-seams.md。

---

## 4. 风险与注意事项

1. **预览期破坏性变更**：README 明示会有 compatibility-breaking changes；rc.6 之后仓库 3 天没动，且无 tag/Releases，版本节奏不可预测。
2. **两条版本线**：主包 rc.6 vs ACP 系列 0.0.1-rc.1 并行发布，混装前必须实测 cordis 兼容性。
3. **Issues 关闭**：bug/建议走 GitHub Discussions 或 Discord。
4. **Codex / Claude Code provider 的依赖**：需要本机装有对应 CLI（codex app-server / claude），且它们把“真实产品”当子 agent 用，权限策略是“无人值守自动拒绝”，适合只读类任务。
5. **文档语言**：英文为主，中文版不全；Windows 上部分示例是 bash 语法（本地工具面为 pwsh）。

---

## 5. 行动建议（优先级排序）

1. 【P0，本会话即可】用 subagent_fork + 文件总线跑通 M1 手动闭环，验证 §4 协议细节（outbox/result 映射、台账格式先定死）。
2. 【P0】写一个 profile 测试安装 dsh-subagent-acp（或 dsh-subagent-dsh-sdk），跑 ACP 握手 demo，决定 M3 是否抛弃自研薄壳。
3. 【P1】读 cookbook（adding-a-tool / adding-a-conversation-node），把 M2 面板的插件骨架搭起来；参考本 GUI 已有的 subagent/jobs slot。
4. 【P1】订阅官方 Discussions + Discord，跟踪 0.1.0 正式版与 ACP 线是否并入主包。
5. 【P2】翻 dsh-handbook 的“同模型多 Agent 实测对比”章节，校准你 fleet 里“模型强弱搭配”的决策表（§6.3 第 2 条）。
