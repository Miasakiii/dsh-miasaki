# 多 Agent CLI 编排线 — 交接文档（续推入口 · 骨架）

- 定稿：2026-08-21（骨架版，与桌面端 `design/HANDOVER.md` 并列）
- 状态：**骨架**——现状事实已核对，标注「⚠️ 待补」的段落按后续会话补全
- 上级文档：协议/设计唯一依据 = `docs/multi-agent-cli-orchestrator-design.md`（**v0.13**，2026-08-17）
- 本文件管这条线；桌面端（Tauri 桌宠）的一切看 `design/HANDOVER.md` + `ARCHITECTURE.md` + `CHANGELOG.md` + `TODO.md`

> **两条线的关系（新读者先看这个）**：本仓库同时承载两条互不依赖的线——
> `desktop/` + `design/*（桌面）` 是 **Miasaki 桌面端**（Tauri 2 + 原生 Win32 桌宠）；
> `agents/` + `state/` + `tasks/` + `workers/` + `fleet-monitor/` + `docs/multi-agent-cli-orchestrator-design.md`
> 是**多 Agent CLI 编排线**（本文件）。唯一共享点是同一 git 仓库与 `docs/` 目录；代码零耦合。
> 仓库里其余带点的目录（`.freebuff/`、`.monkeycode/`、`.learnings/`、`_refs/`、`vendor/`）均为
> **外部工具/参考数据，已全员 ignore，不属于任何一线**（边界表见 §2.1）。

---

## 1. 现状快照（2026-08-21 时点）

| 项 | 状态 |
|---|---|
| 设计文档 | `docs/multi-agent-cli-orchestrator-design.md` v0.13（2026-08-17，Draft） |
| 主路线 | **worker = 本机已安装的 agent CLI**：扫描发现 → Operator 开关 → Commander 派单（v0.11 起；自研 worker 运行时已废弃） |
| 扫描器 | `workers/discovery/scan-agents.ps1` — ✅ 已落地（8 个 CLI 档案） |
| 派单器 | `workers/dispatch/dispatch-task.ps1` — ✅ 已落地（预算预检 / usage 解析 / 退出码 0/2/3/4） |
| 监控面板 | `fleet-monitor/server.js` — ✅ v1 独立 node 服务（默认 39801）；**未 DSH 插件化**（= M2 未完成） |
| 任务闭环 | **t-0001 ~ t-0008 全部 done**（最后一次活动 2026-08-17 14:45） |
| fleet 可用性 | **4/8 立即可用**：claude / bl / opencode / pi；gemini 半可用（403 区域限制）；mimo 语法待校准；dsh 缺 headless profile；agent-browser 命令型（非 prompt 型） |
| 计量通道 | 仅 bl（console-usage）与 claude（json-cost-usd）真实计量过；其余 unknown（待校准） |
| 已花成本 | 唯一实账 t-0006：claude `$0.4140524`（59681 tokens，sonnet-4-6[1M]，cache-read 60 万计大头） |
| 相关外因 | DSH 主包 2026-08-20 升 0.1.0-rc.8，本机随后再升至 **0.1.1-rc.1**（dist-tags 最新 rc.2）。**m36 回归冒烟已补**（2026-08-22，详见 `docs/m36-rc8-regression-smoke-2026-08-22.md`：profile 混装加载无回归、三主题 18/18）。`agents/registry.json` 已重扫，dsh 档案版本修为 0.1.1-rc.1（claude→2.1.238、gemini→0.55.1） |

## 2. 组件地图

### 2.1 目录边界（回答「这堆目录是什么关系」）

| 路径 | 归属 | 写者 | git 状态 |
|---|---|---|---|
| `agents/<id>/`（manifest / control / status / usage / transcript / logs / sessions / inbox） | **本线核心** | 见 §5 各字段 | manifest/control 入库存档；status/usage/transcript/logs/sessions/inbox 已 ignore |
| `agents/registry.json` | 本线 | Discovery 只刷新发现元数据 | 入库存档 |
| `state/`（tasks.jsonl / ledger.jsonl / events.jsonl） | 本线 | Commander（唯一写者） | 入库存档（`fleet-pulse.json` 已 ignore） |
| `tasks/<id>/`（brief.md / context.md / result/） | 本线 | Commander 写 brief，worker 交付 result | 入库存档 |
| `workers/`（discovery / dispatch / worker-cli） | 本线脚本 | — | 入库存档 |
| `fleet-monitor/`（server.js + panel.html） | 本线面板 | — | 入库存档（git 未 add ⚠️ 待提交） |
| `shared/` | 本线共享只读区 | — | 入库存档 |
| `desktop/` + `design/{HANDOVER,ARCHITECTURE,CHANGELOG,TODO,themes,token-surface}.md` | **桌面端线** | — | 见 HANDOVER.md |
| `.freebuff/` `.monkeycode/` `.learnings/` | 外部工具私有数据（Freebuff 桌面代理 / monkeycode 截图工具 / DSH learnings） | 外部工具 | **已 ignore**，不属于本项目 |
| `_refs/`（deepseek-harness 克隆、rc8-src.zip、smoke-patch-backup 等） | 官方源码快照与归档（重扫描参考素材） | — | 已 ignore |
| `vendor/deepseek-harness` | 官方仓库实验 clone | — | 已 ignore |

### 2.2 角色（一句话版，细节见设计文档 §0/§1）

- **Operator（人类）**：唯一有权开关 agent CLI（写 `agents/<id>/control.json` 的 `enabled`）。
- **Commander（总指挥 · 本 DSH 大会话）**：任务分解/分配/验收；`state/` 唯一写者。
- **Worker（小会话）**：本机 CLI 进程，每任务 spawn 一次；只读自己目录 + 共享区；互相不可见。
- **Discovery**：`scan-agents.ps1` 探测 PATH 上已知 CLI → 生成/刷新 manifest + registry。

## 3. 跑通一次闭环（命令序列）

```powershell
# ① 扫描（新增/变更 CLI 后执行；只刷新发现元数据，不覆盖 Operator 编辑）
pwsh -File workers/discovery/scan-agents.ps1

# ② Operator 拨开关（面板 POST /api/toggle/:id 或手写 control.json）
#    agents/<id>/control.json → { "enabled": true, ... }

# ③ Commander 建任务 + 派单（brief 模板见设计文档 §4.6）
pwsh -File workers/dispatch/dispatch-task.ps1 -TaskId t-0009 -Agent claude
#    退出码：0 成功；2 拒绝派单（开关未开/缺模板）；3 CLI 执行失败；4 预算熔断（默认 $2.0/日/agent）
#    验证模式：-CheckOnly（只跑预算预检） / -ParseOnly（只解析 usage，预览将写入的行）

# ④ 验收：Commander 读 stdout 日志（agents/<id>/logs/t-xxxx-stdout.log）+ 交付物 → 写
#    state/tasks.jsonl（update accepted=true）与 state/ledger.jsonl（成本入账）

# ⑤ 面板（可选）：node fleet-monitor/server.js [workspace-root] [port]   # 默认 39801
```

## 4. 关键文件格式速查（完整规范见设计文档 §4）

| 文件 | 唯一写者 | 要点 |
|---|---|---|
| `agents/<id>/manifest.json` | Discovery/Commander | id / runtime:"cli" / cli.invoke（`{prompt}` 占位）/ metering_source / limits.budget_per_day / skills / preflight |
| `agents/<id>/control.json` | **Operator** | `enabled` / `force_kill` / updated_by |
| `agents/<id>/status.json` | 派单器代理写（CLI 无协议感知） | 心跳 + 进度 |
| `agents/<id>/usage.jsonl` | 派单器按 metering_source 解析 | 每模型调用一行；缺失视为故障 |
| `state/tasks.jsonl` | Commander | append-only：create / assign / update（blocked/reopen/done+accepted） |
| `state/ledger.jsonl` | Commander | 成本台账聚合（含 metering=false 豁免记录） |
| `tasks/<id>/brief.md` | Commander | 目标/交付物/约束/验收标准/完成后必做 |

## 5. 当前 fleet 明细（8 档案，`agents/registry.json`）

| id | 版本 | invoke | metering | 备注（校准结论，`docs/cli-calibration-2026-08-17.md`） |
|---|---|---|---|---|
| bl | 1.16.0 | `bl text chat --message {p}` | console-usage | ✅ 可用；t-0005 真实闭环；需 console session |
| claude | 2.1.233 | `claude -p {p} --output-format json` | json-cost-usd | ✅ 可用；t-0006 首账；headless 下 Write 权限自动拒绝 → 交付物由派单器代写 |
| opencode | 1.18.18 | `opencode run {p}` | unknown | ✅ 可用；t-0007 并发通过；默认模型 deepseek-v4-flash |
| pi | 0.84.1 | `pi -p {p}` | unknown | ✅ 可用；t-0008 并发通过；写 `~/.pi` 需 full-access |
| gemini | 启动失败 | `gemini -p {p}` | unknown | ⚠️ 半可用：默认模型区域受限 403，需先换模型；spawn 需 full-access |
| mimo | 0.1.12 | `mimo {p}` | unknown | ⚠️ invoke 语法待校准（位置参数被当目录）；需 `mimo --help` 后更新模板 |
| dsh | (registry 记 rc.6) | `dsh --profile headless {p}` | session | ⚠️ 本机尚无 headless profile；另 registry 版本过期，待重扫 |
| agent-browser | 0.34.0 | `agent-browser {p}` | unknown | ⚠️ 命令型 CLI，非 prompt 型；任务需映射到具体命令（`skills get core` 起步） |

## 6. 下一步（按优先级；来源 `docs/next-tasks-plan-2026-08-20.md` P1 + 设计文档 §13/§14）

- [x] **P1-2 m36 rc.8(+) 回归冒烟**（2026-08-22 完成，见 `docs/m36-rc8-regression-smoke-2026-08-22.md`）——本机全局 CLI 已至 0.1.1-rc.1；profile 混装 `--dump-config` 双双 exit 0、rc7-test 插件树与 M3.5 基线 313 行字节一致、三主题 18/18。**仍待用户在 GUI 验证历史会话恢复（rc.8 SQLite 不兼容）。**
- [ ] **P1-5 引用资料再梳理**：`_refs/rc8-src.zip` 已损坏、`_refs/deepseek-harness` 是 rc.7 解包；需源码时重下官方 0.1.1-rc.2 source。
- [ ] **M2 监控面板 → DSH 动态 Cordis 插件**（现状是独立 node 服务；目标：Operator 开关控件 + 配置项落官方 plugin settings surface）。
- [ ] **校准遗留**：gemini 换可用模型 / mimo invoke 语法 / dsh 建 headless profile / opencode+pi 计量（`--format json` 等）。（**registry 已重扫**：dsh→0.1.1-rc.1、claude→2.1.238、gemini→0.55.1；详见 `tests/m3-acp/logs/m36/scan-output.log`）
- [ ] **M4 fleet 适配闭环**：无匹配技能 → 暂存 +「开启建议」；关闭 agent 的 reassign 流程。
- [ ] **M5 健壮性**：预算熔断（派单器已内置）、心跳告警、kill/重启包、reopen 流程演练。
- [ ] **M6 混合项目**：claude 写码 → opencode 审查 → agent-browser 验证 → bl 查配额（DAG）；**同模型对照素材已就位**（opencode/pi 均 deepseek-v4-flash）；异构候选 = dsh-subagent-codex/claude-code 后台 Job 路径。
- [ ] 设计文档 §14 开放问题（outbox 映射、原子领取、面板形态、降级分配默认值、单价来源、并行负载上限、两阶段锚定是否引入——均待评审）。

## 7. 纪律与红线（勿违反）

1. **文件即总线，单一写者**：每个文件只有一个角色能写；Commander 管 `state/`、Operator 管 `control.json`、worker 管自己目录。
2. **升级前回归冒烟**：DSH 主包升级必须先过 m3x 冒烟（本次 rc.8 已破例，m36 必须补）。
3. **预算与熔断**：manifest `limits.budget_per_day` 默认 $2.0；熔断拒绝 exit 4，禁止绕过。
4. **无头优先**：worker 纯 CLI；面板是唯一 UI。
5. **命令型/只读约束**：claude headless 下 Write/Bash 会被自动拒绝，交付物由派单器代写（这不是故障）。
6. **凭证卫生**：读取 `~/.dsh/.credentials.yaml` 的一次性脚本（`_api_connectivity_check.mjs`）不入库，已 ignore。

## 8. ⚠️ 待补（骨架占位，往后会话填）

- [ ] 面板实际操作步骤与截图（`fleet-monitor` 启动 → 浏览器 39801 → 开关联动演示）。
- [ ] 最近一次真实派单的完整走查记录（t-0009？）与新的验收结论。
- [ ] `agents/registry.json` 重扫后的差异报告（dsh 版本 → rc.8）。
- [ ] 与桌面端的联动点讨论结论（面板是否嵌入桌宠/主窗口——设计文档 §8.3 曾有桌宠聚合形态方向）。

## 9. 参考文档索引

| 文档 | 内容 |
|---|---|
| `docs/multi-agent-cli-orchestrator-design.md` | v0.13 协议与设计（**唯一依据**；含 §13 路线图 / §14 开放问题） |
| `docs/cli-calibration-2026-08-17.md` | 8 CLI 校准报告（4/8 可用） |
| `docs/m3-official-runtime-eval-2026-08-16.md` | 官方 dsh-subagent-dsh-sdk 评估（含废弃结论） |
| `docs/m35-rc7-regression-smoke-2026-08-17.md` | rc.7 回归冒烟模板（m36 参照） |
| `docs/next-tasks-plan-2026-08-20.md` | 当前待办备忘稿（P1 列表，即 §6 来源） |
| `docs/ab-linkage-pet-fleet-status-2026-08-18.md` | 桌宠与 fleet 状态联动（两线交叉点） |
| `docs/dsh-official-repo-review-2026-08-16.md` / `-rc7.md` | 官方仓库调研（已升级进度，多数结论已过时） |
| `docs/ref-*.md`（4 篇） | 外部参考（腾讯/Datawhale/社区）归档 |
