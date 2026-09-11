# 结果：t-0004 collective-memory 精简索引

## 结论

`shared/collective-memory.md` 共 **5 个主题节**（建库 / runtime 选型要点 / 运维踩坑 / 未决事项 / 新方向：扫描编排本机 agent CLI），精简为 **15 行**索引如下。每行「主题 | 要点」，**⚠️ 标记项为已过期或口径待复核**，下游 `context.md` 引用时须原样带上标记。

```
01 建库 | 本文件是 Commander 唯一写者、全体只读的跨 agent 知识区；源头两份文档 = 设计文档（写此节时为 v0.3）+ docs/dsh-official-repo-review-2026-08-16.md
02 runtime 选型(t-0001) | 双版本线隔离原则：主包 0.1.0-rc.6 与 subagent 线 0.0.1-rc.1 并行，任何官方包测试必须用独立 profile（建议 m3-test），不得污染主配置
03 runtime 选型(t-0001) | ACP 单槽语义：每 session 单 prompt slot ⇒ 单任务串行天然成立，协议层原子领取无需 rename 技巧
04 runtime 选型(t-0001) | 审批桥通路 = ACP session/request_permission + dsh-permission-presets；codex/claude-code 无人值守下自动拒绝权限 ⇒ 只派只读任务
05 runtime 选型(t-0001) | 官方教材入口：docs/cookbook/、docs/capability-seams.md、docs/subsystems/* 为面板插件直接教材
06 runtime 选型(t-0001) | ⚠️已过期：M3 首选 @deepseek-ai/dsh-subagent-dsh-sdk（完整 DSH runtime 子进程）+ 协议层候选 dsh-subagent-acp + 自研薄壳兜底 —— 该路线 2026-08-17 已整体废弃（设计 §12 v0.11）
07 运维踩坑 | vendor/deepseek-harness 重跑带脚本的 pnpm install 时 lefthook postinstall 会再次把转发钩子写入全局 git hooks（C:\Users\Asakii\.git-hooks）；规避 = 装前设 $env:LEFTHOOK='0' 或装后清理
08 运维踩坑 | 该仓库的安装（koffi/node-pty 原生构建）与测试（vitest spawn 子进程）都会被沙箱拦截，需 full-access 授权
09 运维踩坑 | 官方快照测试在 Windows 需本地热补丁（反斜杠 JSON 转义），已反馈上游 Discussions #2477
10 未决事项 | ①②③ 面板不可见 / 监控形态决策（独立控制台 vs 悬浮窗）/ M2 开关拨动到 control.json 落盘未验证 —— ⚠️三项均以旧 Cordis 悬浮窗形态为语境，与现行 fleet-monitor + pulse 形态疑已脱节，引用前须 Commander 复核
11 未决事项 | ④ M3.5 真实模型接入（自研 worker）方向已修正（2026-08-17，Operator 指令）：编排本机已装 agent CLI，不自研 worker
12 未决事项 | ⑤ npm 发布的 dsh-sdk-client 0.0.1-rc.1 peer（dsh-type-meta 等）未公开、独立安装不可行 ⇒ 旧方案依赖 vendor 仓库 tsx + tsconfig paths 源码解析 —— 随 ⑥ 路线废弃降为历史注记
13 未决事项 | ⑥ 动态插件/后台任务都是进程级（2026-08-17 验证）：DSH 重启后 fleet 插件丢失、mock 服务器与后台 worker 全终止 ⇒ 每次新进程三步重建（插件 / llm-mock-server 或真实 key / 托管器 spawn）
14 新方向(2026-08-17) | 扫描器 workers/discovery/scan-agents.ps1 探测 PATH 上 agent CLI → 生成 agents/<id>/manifest.json（runtime:"cli" 含 cli.invoke 派单模板）+ registry.json；只刷新 cli 元数据、不覆盖 Operator 编辑
15 新方向(2026-08-17) | 已发现 8 个 CLI（bl/claude/gemini/opencode/dsh/pi/mimo/agent-browser）及各自派单语法；派单模型 = Commander 按任务匹配 CLI 特性 → spawn CLI → stdout 存 transcript → usage 按各 CLI 来源解析（claude json / bl console / 其他 unknown）
```

**可直接使用的一句话**：该文件 5 节中，第 2 节（runtime 选型）的第 6 行已因 2026-08-17 的方向修正而失效，第 4 节的 ①②③ 条疑为旧形态残留；其余（运维踩坑、进程级易失结论、扫描器与派单模型）在 2026-09-11 时点仍与现行设计一致。

---

## 完成度

**100%**。三项验收标准逐条：

| # | 标准 | 结果 |
|---|---|---|
| 1 | stdout 结论符合 §4.7 六段结构 | ✅ 六段齐备（结论/完成度/数据来源·依据/遇到的问题/广播建议/下一步建议） |
| 2 | 索引覆盖 collective-memory 全部主题节 | ✅ 5/5 节覆盖（建库 1 行、runtime 选型 5 行、运维踩坑 3 行、未决事项 4 行、新方向 2 行） |
| 3 | 每行一条要点，总计 ≤15 行 | ✅ 15 行，未超限 |

约束遵守情况：只读执行 ✅（未产生任何写操作）；预算 50K tokens ✅（实际读取 2 份文档，约 12K tokens 输入）；依赖任务：无 ✅。

---

## 数据来源 / 依据

- `shared/collective-memory.md`（33 行全文，逐行通读；本索引为其唯一研读对象）
- `docs/multi-agent-cli-orchestrator-design.md` v0.21（§4.7 六段结构定义位于 L324–346；过期判定依据 §12 变更记录 v0.11「废弃自研 worker 与 dsh-sdk 常驻子进程 worker 路线」L14、L43、L716；现行监控形态依据 v0.15「fleet-monitor/server.js + pulse v2」L23）
- 过期判定的**交叉核对方式**：未采信简报结论，而是以设计文档变更记录与 collective-memory 原文逐条比对后自行判定，判定结论与简报一致但有 1 处修正（见下）

---

## 遇到的问题

1. **简报的时效描述有 1 处不准确（已自行修正）**：简报与改派记录称「collective-memory.md 最后更新 2026-08-16」，但文件实际含 `## 新方向：扫描编排本机 agent CLI（2026-08-17）` 整节，**真实末次更新为 2026-08-17**。本索引按实际内容取 08-17 为准。不构成交付阻塞，但后续 `context.md` 若沿用「08-16」会低估文档新鲜度。

2. **headless 权限拒绝的真实形态与简报措辞不一致（精度问题，建议统一口径）**：本轮 `Bash` 与 `Glob` 均返回 `EPERM: operation not permitted, uv_spawn ...`（**进程 spawn 失败**），而非「权限栈弹窗拒绝」；`Read` 正常可用，全程零写操作。这与设计 v0.21（L29）对 t-0003 的观察同型，与 t-0006 记录的「Write 被权限栈拒绝」是两类现象——§11.2 及相关 `preflight` 措辞宜统一为「headless 下 worker 无法落盘」。

3. **「未决事项」节存在格式漂移**：设计 §6.6 规定 collective-memory 收录格式为 `## <主题>（<task-id> 来源）` + 3-5 行要点，但「未决事项」节为 6 条且无 task-id 来源、「运维踩坑」节亦无来源标注。属 Commander 策展职责范围，本任务只读不改，仅登记。

4. **一项无法在只读模式下完成的动作**：源文档的策展（过期行删除/标注、格式归一）与索引同步，需要写权限，按既定协议归 Commander。本任务已按约束「不把索引写成文件，全部产出走 stdout」执行。

**无需 Operator 裁决的事项**：以上 1–3 项均为信息登记，处置权在 Commander。

---

## 广播建议

建议 Commander 将以下 2 条写入 `collective-memory.md`（本轮只读，未回写）：

- **`## collective-memory 自身的时效标注（t-0004 来源）`**：本文件第 2 节「M3 首选评估 dsh-subagent-dsh-sdk + 自研薄壳兜底」已随 2026-08-17 方向修正失效，与设计 §12 v0.11 直接矛盾；建议删除或就地加 `⚠️已废弃` 标注，否则后续 `context.md` 引用会复活已废弃路线。
- **`## 未决事项的形态漂移（t-0004 来源）`**：第 4 节 ①②③（面板不可见 / 监控形态 / 开关拨动测试）以旧 Cordis 悬浮窗为语境；若现行 fleet-monitor + pulse v2 形态已取代之，该三条应结案归档而非继续列为未决。

---

## 下一步建议

1. **Commander 侧（高优先）**：对 collective-memory 做一次策展——删除/标注第 2 节的过期 dsh-sdk 路线；复核未决事项 ①②③ 是否已由 fleet-monitor + pulse 形态解决，解决则结案。
2. **索引落地**：将本 15 行索引以「集体记忆快照（截至 2026-09-11，源文档 08-17 版）」为标题写入 `shared/` 或作为后续任务 `context.md` 的引用块，并注明「快照非全文，引用技术结论前须回源核对」。
3. **口径统一（低成本）**：按问题 2 的结论统一 §11.2 与各档案 `preflight` 的措辞为「headless 下 worker 无法落盘」。
4. **后续任务建议**：本索引可作为 t-0003 遗留的能力断层（`research` / `comparative-analysis` / `zh-report`）相关任务的上下文素材——本轮未涉及该议题，但两者同属「集体知识可用性」问题，可合并规划。

---

## 附录：被本文件取代的历史产物（2026-08-17 mock 验证轮）

> 本文件在 2026-09-11 的真实派单轮次中**取代**了 t-0004 于 2026-08-17 留下的 mock 验证产物
> （git 跟踪版本，461 字节）。原文完整保留如下，**以免历史被抹掉**。
>
> 与 t-0003 同源：2026-08-17 那轮 keyless 验证**确实跑过并落盘了产物**，但其绑定的
> `agents/analyst/sessions/t-0004` 与自研 worker CLI 自 v0.11 起已废弃；且该轮交付
> **从未被验收**——`tasks.jsonl` 中 t-0004 自 2026-08-17 创建起始终为 `queued`，
> 直到 2026-09-11 本轮真实派单才终结。

```markdown
# 结果：t-0004

## 结论
M3.5 worker mock response OK

## 完成度
100%（keyless 验证轮次：子运行时按 mock 脚本应答，交付物由 worker 包装层落盘）

## 数据来源 / 依据
- 子运行时会话日志：C:\Users\Asakii\Desktop\dsh-miasaki\agents\analyst\sessions\t-0004

## 遇到的问题
无

## 广播建议
（本轮为 M3.5 worker 自动化 keyless 验证）

## 下一步建议
真实模型轮次待 DEEPSEEK_API_KEY 注入。
```
