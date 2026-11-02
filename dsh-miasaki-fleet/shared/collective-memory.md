# Collective Memory（总指挥唯一写者，worker 只读）

## 建库（2026-08-16）
- 本项目「多 Agent CLI 协作模式」协议见 docs/multi-agent-cli-orchestrator-design.md（当前 v0.3）
- 官方仓库调研报告见 docs/dsh-official-repo-review-2026-08-16.md

## runtime 选型要点（来源 t-0001，2026-08-16）
- 双版本线隔离原则：主包 0.1.0-rc.6 与 subagent 线 0.0.1-rc.1 并行；任何官方包测试必须用独立 profile（建议名 m3-test），不得污染主配置。
- ACP 单槽语义：每 session 单 prompt slot ⇒ 单任务串行天然成立，协议层原子领取无需 rename 技巧。
- 审批桥通路：ACP session/request_permission + dsh-permission-presets 是 v2 审批汇总面板的现成通路；codex / claude-code 无人值守自动拒绝权限，只派只读任务。
- 官方教材入口：docs/cookbook/、docs/capability-seams.md、docs/subsystems/* 是 M2 面板插件的直接教材。
- M3 首选评估 @deepseek-ai/dsh-subagent-dsh-sdk（完整 DSH runtime 子进程）；协议层候选 dsh-subagent-acp；自研薄壳兜底。

## 运维踩坑（2026-08-16）
- vendor/deepseek-harness 下重跑带脚本的 `pnpm install` 时，lefthook postinstall 会再次把转发钩子写进全局 git hooks 目录（%USERPROFILE%\.git-hooks）。规避：安装前设 `$env:LEFTHOOK='0'`，或装完后清理。
- 该仓库的安装（koffi/node-pty 原生构建）与测试（vitest spawn 子进程）都会被沙箱拦截，需要 full-access 授权。
- 官方快照测试在 Windows 需本地热补丁（反斜杠 JSON 转义），已反馈上游 Discussions #2477。

## 未决事项（下次会话推进，2026-08-16 记录）
1. **面板不可见问题**：fleet-1/pkg-5 运行健康（Host 4 方法全在、Client running、slot 注册活跃：shell.overlay occupants 有 m2-fleet-monitor active:true），但用户页面右下角看不到悬浮窗。已建议刷新页面/确认是否桌面壳旧窗口，用户尚未验证。下一步：①刷新后确认；②若仍不可见，读 client-render 诊断或改挂独立页签（settings.section / conversation.input.dock）。
2. **监控形态决策**：用户提出「要有控制监控页面」（独立控制台：对话框内容、任务列表、审批区），与悬浮窗的关系待定；倾向升级为独立页签 + 悬浮气泡速览。
3. **M2 开关拨动测试欠账**：Operator 面板开关 → control.json 落盘闭环未验证（面板不可见阻塞了此项）。
4. ~~M3.5 真实模型接入（自研 worker）~~ → **方向已修正（2026-08-17，Operator 指令）**：编排本机已装 agent CLI，不自研 worker。
5. 已知技术事实：npm 发布的 dsh-sdk-client 0.0.1-rc.1 的 peer（dsh-type-meta 等）未公开，独立安装不可行——worker 依赖必须走 vendor 仓库 tsx + tsconfig paths 源码解析（`node --import tsx workers/worker-cli/worker.mjs <agentId>`，cwd=vendor/deepseek-harness）。
6. **动态插件/后台任务都是进程级**（2026-08-17 验证）：DSH 进程重启后 fleet 插件丢失（需重建 define/run + 重新授权）、mock 服务器与后台 worker 全部终止。每次新进程：①重建面板插件；②重启 llm-mock-server（keyless 阶段）或注入真实 key；③worker 由面板开关 ON 时托管器自动 spawn。

## 新方向：扫描编排本机 agent CLI（2026-08-17）
- 扫描器：`workers/discovery/scan-agents.ps1` → 探测 PATH 上的已知 agent CLI，生成 `agents/<id>/manifest.json`（runtime:'cli'，含 cli.invoke 派单模板）+ `agents/registry.json`；只刷新 cli 元数据、不覆盖 Operator 编辑。
- 已发现 8 个：bl（bl text chat --message，bailian-cli 技能权威语法）、claude（claude -p --output-format json，json 含成本）、gemini（沙箱下自重启失败，派单需 full-access）、opencode（opencode run）、dsh（需 headless profile）、pi（pi -p；写 %USERPROFILE%\.pi 需 full-access）、mimo、agent-browser。
- 派单模型：Commander 按任务匹配 CLI 特性 → spawn CLI 进程执行 prompt → stdout 存 transcript → usage 按 CLI 各自来源解析（claude json / bl console / 其他 unknown）。
- 面板自动列出 agents/ 下所有档案（无需改动），开关启用后由 Commander 或托管器派发真实 CLI 任务。

## Operator 定过的事（拍板记录，Commander 代笔）

> 来源：卡兹克《折腾了整整1年，毫无保留地分享一下我这套Agent自动化系统》§5「我定过的事，Agent 不会问第二遍」
> （借鉴评估：_refs/article-borrow-2026-11-02-kazike-agent-automation.md，🟢 真缺口 2）。
> **消费方式**：Commander 写 brief 前先读本节——命中过的事项直接按结论执行，不再升级询问。
> **形态说明（轻形态）**：本文件是 Commander 唯一写者、worker 只读的共享知识区，本节零契约变更。
> 刻意**不放进** `agents/*/notes.md`——那是 worker 自述记忆（≤10 行口径），2026-10-29 D5 拍板
> 「不改 agents/*/notes.md 人工口径」同样适用于此；重形态（`state/decisions.jsonl` 走 bus-apply、
> `EVENT_AUTHORS` 已含 `operator`）待 E5 契约批次同源时再评估，不先行引入第 N 个真相文件。

- 2026-11-02：批准实施卡兹克文章借鉴四增量——G5 语义分级闸门 / 决策账（本节）/ 只读 review 档案 / D4 判据并入 Anthropic 收敛四招。原话：「可以」。
- 2026-10-29：D4 `escalate` **只提示不硬拒**（最终裁决权仍在 Commander / Operator；`loop.guard` 的 `reason` 枚举 = `no_progress` / `retries_exceeded` / `transition_illegal`）。G5 闸门（`workers/lib/escalation-policy.cjs`）即按此口径实施：命中不改派单退出码 0/2/3/4。

## Operator 拒绝过的事（再碰到直接照答，不再重提）

> 消费方式同上：Commander 写 brief / 做方案前先对一遍——命中项按既有结论处理，不重复提请裁决。

- 2026-09-29：拒绝**未经请示**修改 `web` profile 的 `node_modules` 装配（同批 `miasaki` 的未问先改事后被追认，`web` 这次被拒）。此后动 `~/.dsh/profiles/*`（package.json / install）必须先问用户，先读 `LinkType` 再决定改不改。
