# 结果：t-0001 官方 dsh-subagent 四件套 vs 自研薄壳 — 选型对照分析

## 结论

### 一句话总判

官方已发布的 **ACP（Agent Client Protocol，JSON-RPC over stdio）+ 进程外 subagent 四件套** 已实现设计文档中"自研薄壳 CLI + 文件总线 + 进程托管器"工程的大半，且协议更标准、生命周期更稳（调研报告 §3.1）。**M3 首选评估对象为 `@deepseek-ai/dsh-subagent-dsh-sdk`**（完整 DSH runtime 子进程，最贴近设计文档"小会话"语义）；`dsh-subagent-acp` 为协议层候选；**自研薄壳降级为兜底**，仅在官方包实测不满足协议需求时启用。此判断与设计文档 v0.3 §12 已重写的选型表一致。

### 总评矩阵

| runtime | 总评 | 定位（依据设计 §12） |
|---|---|---|
| @deepseek-ai/dsh-subagent-dsh-sdk | ★★★★☆ | **M3 首选评估对象**；通过则 v1.5 直接采用 |
| @deepseek-ai/dsh-subagent-acp | ★★★★☆ | M3 协议层候选（sdk 的薄退路） |
| @deepseek-ai/dsh-acp | ★★★★☆ | 协议基础设施层（上两者依赖它） |
| @deepseek-ai/dsh-subagent-codex | ★★★☆ | v2 异构 worker（仅只读类任务） |
| @deepseek-ai/dsh-subagent-claude-code | ★★★☆ | v2 异构 worker（仅只读类任务） |
| 自研薄壳 CLI | ★★★☆ | 兜底（官方包实测失败时才启用） |
| （参考）subagent_fork | ★★☆ M1 专用 | M1 手动闭环（本任务即此形态） |
| （参考）bl CLI | ★★★☆ | 备选异构 worker |

### 七维对照矩阵

评分 1–5，5 = 该维度最强/风险最低。**维度 ⑦"版本线风险"分数含义反置：5 = 风险低（优），1 = 风险高（劣）**。评分基于文档证据的推断（未实测，见"数据来源"局限声明），M3 实测后应回写修正。

| runtime | ①协议标准度 | ②usage 计量 | ③进程管理 | ④故障恢复 | ⑤审批桥 | ⑥维护成本 | ⑦版本线风险 |
|---|---|---|---|---|---|---|---|
| dsh-subagent-dsh-sdk | 4 JSON-RPC(DSH) | 5 回执+telemetry | 5 dispose 阶梯 | 5 取消映射 | 5 全通路 | 4 官方维护 | 2 双版本线 |
| dsh-subagent-acp | 5 标准 ACP | 4 随 Result 返回 | 5 dispose 阶梯 | 5 取消映射 | 5 经 ACP 桥 | 4 官方维护 | 2 双版本线 |
| dsh-acp（协议层） | 5 标准 ACP | 3 未证实 | —（被 spawn 方） | 4 session/cancel | 5 request_permission | 4 官方维护 | 2 双版本线 |
| dsh-subagent-codex | 3 上游协议 | 4 上游回执 | 5 统一回收 | 5 取消映射 | 2 自动拒绝 | 3 上游依赖 | 1 双重版本线 |
| dsh-subagent-claude-code | 3 上游协议 | 4 上游回执 | 5 统一回收 | 5 取消映射 | 2 自动拒绝 | 3 上游依赖 | 1 双重版本线 |
| 自研薄壳 CLI | 2 自定协议 | 3 需自提取 | 2 自建 | 3 自建 §10 全表 | 1 无桥只能规避 | 2 全自维护 | 5 无版本依赖 |
| subagent_fork（参考） | 1 prompt 约定 | 1 无回执 | 2 非独立进程 | 3 会话可续接 | 4 同会话审批栈 | 5 零安装维护 | 5 随主包 rc.6 |
| bl CLI（参考） | 2 文本输出解析 | 4 usage 回执 | 2 自建 | 2 自建 | 2 未调研 | 3 版本跟进 | 3 独立版本线 |

### 七维关键发现（逐维，标注出处）

**① 协议标准度**
- ACP 五原语齐全：`session/new`、`session/prompt`、`session/update`（committed 文本流）、`session/cancel`、`session/request_permission`；stdout 纯协议帧，一条连接多 session，每 session 独立 prompt slot（调研 §2.1）。
- **单槽会话天然串行 → 设计 §7.2"原子领取"语义自动成立，无需 rename 技巧**（设计 §7.2 ACP 例外注）。
- dsh-sdk 子进程 = 完整 DSH runtime（dsh-jsonrpc-agent），协议同为 JSON-RPC 家族，非标准 ACP（调研 §2.1）。
- codex / claude-code 协议由上游 CLI 决定，仅共享统一 SubagentResult 契约（调研 §2.1）。
- 自研薄壳协议自定，无互操作性；除非自实现 ACP client，否则与官方生态脱节（调研 §3.1）。

**② usage 计量**
- providers 的 usage **随 SubagentResult 返回**，可直接读官方回执而非手算（调研 §3.2 对照 §4.4 行）。
- dsh-sdk 子进程自带会话持久化与 `session-telemetry`（调研 §2.1、§2.3），计量数据最全；对应设计 §9.1 `dsh` 行。
- 自研薄壳须自行从 API 响应提取，否则该 agent 标记"无计量"（设计 §9.1 `custom` 行）。
- subagent_fork 无 usage 回执 → `metering=false` 豁免（设计 §9.1 `fork` 行）——本任务即此情形。
- bl CLI 有官方 usage/quota 输出可解析（设计 §9.1 `bl` 行）。
- **待实测**：ACP 协议层本身是否透传 usage，调研报告未证实（本报告标注为未知项）。

**③ 进程管理**
- 官方 provider 的 `dispose()` 幂等阶梯：关 stdin → 优雅宽限 → SIGTERM/SIGKILL → **整进程树退出证明**（调研 §2.1）——正是设计 §2 控制流"进程托管器"的现成实现。
- 四件套共享统一契约：cwd = 父会话 workspace、取消映射、幂等回收（调研 §2.1）。
- 自研薄壳需自建 spawn/kill/重启策略；DSH 内形态 = 动态 Cordis Host 插件（spawn/kill 注册进 ctx.effect disposer，插件停止全部回收——设计 §12）。
- **待实测**：SIGTERM 语义与"进程树退出证明"在 Windows 上的行为，官方示例为 bash 语法而本机为 pwsh（调研 §4.5；本报告推断 Windows 为 M3 重点验证项）。

**④ 故障恢复**
- 取消映射三态：aborted / error / max-tokens（调研 §2.1），直接对应设计 §10 表的 kill、异常、预算耗尽场景。
- 设计 §10 注明确：官方 provider 已覆盖 kill/重启/崩溃检测各项的大半，采用官方 runtime 时直接复用，不重复实现（设计 §10、调研 §3.2）。
- ACP `session/cancel` 是协议级取消原语（调研 §2.1）。
- 自研薄壳需自行实现设计 §10 全表（心跳超时 3×heartbeat_ms、自动重启 3 次/10 分钟、重启包）；注意 **重启包机制与 runtime 无关，无论选哪个方案 Commander 侧都要实现**（设计 §10）。

**⑤ 审批桥**
- ACP `session/request_permission`：一次性 allow/reject，客户端可自动应答（调研 §2.1）——是设计 §11.2 v2"审批汇总到监控面板"的现成通路（调研 §3.2 §11.2 行、设计 §11.2）。
- dsh 生态配套：`dsh-permission-presets` 权限预设（调研 §2.4）+ approval 子系统文档（调研 §2.3）。
- **codex / claude-code 的权限请求在无人值守下自动拒绝**（调研 §4.4）→ 审批桥不通，只适合只读类任务。
- 自研薄壳无审批体系，v1 只能靠"不执行需审批操作"规避（设计 §11.2）。
- subagent_fork 继承父会话审批栈（调研 §2.4）。

**⑥ 维护成本**
- 官方四件套：官方维护、初期成本低；但预览期明示 API 破坏性变更 → 需持续跟进（调研 §1、§4.1）。
- codex / claude-code 额外叠加"本机需安装上游 CLI"的成本与版本面（调研 §4.4）。
- 自研薄壳：协议/计量/进程/恢复全部自维护，"官方已实现大半，重复造轮子"（调研 §3.1）。
- subagent_fork：零安装零维护，本会话内置（调研 §2.4），但形态局限于父会话内。
- bl CLI：现成，但输出解析脆弱、工具面不可控（设计 §12）。

**⑦ 版本线风险（本维分数反置，5=风险低）**
- **双版本线**：主包 `@deepseek-ai/dsh` 0.1.0-rc.6（= 本机安装版）与 subagent 线 0.0.1-rc.1 并行发布；混装前必须实测 cordis 兼容（调研 §1、§4.2）。
- README 明示 developer preview，**"THERE WILL BE COMPATIBILITY-BREAKING CHANGES"**；master 无 tag/Releases、Issues 关闭、公开后 3 天无新提交，版本节奏不可预测（调研 §1）。
- 混装测试必须用**独立测试 profile**（`dsh plugin --profile <name>`），不得污染本会话/主配置（设计 §12 版本线警告、调研 §3.4）。
- codex / claude-code 双重叠加：官方包版本线 × 上游 CLI 版本线，风险最高。
- 自研薄壳零版本线依赖（仅绑所选 API），风险最低——**这是它唯一明显占优的维度**，代价是⑥⑦两维的自建负担。

### M3 明确建议（先测哪个包 / profile 命令 / 成功与失败两条路径）

1. **先测哪个包**：主评估 `@deepseek-ai/dsh-subagent-dsh-sdk`（最接近设计"小会话 = 完整 runtime"语义：子进程自带 cordis.yml 组合、会话持久化、模型路由、工具——调研 §2.1）；同轮装 `@deepseek-ai/dsh-subagent-acp` 做协议层对照——若 sdk 耦合过重，acp 是更薄的退路（设计 §12）。
2. **profile 命令**（语法按调研 §3.4 所记 README 语法，实际以 README 为准）：
   - 独立隔离 profile：`dsh plugin --profile m3-test add @deepseek-ai/dsh-subagent-dsh-sdk`（同法再装 dsh-subagent-acp；不触碰主配置——设计 §12 版本线警告）
   - 前置兼容检查：`npm view @deepseek-ai/dsh-subagent-dsh-sdk version peerDependencies`，核对与主包 rc.6 及 `@deepseek-ai/cordis` 4.x 的兼容声明（调研 §3.4.1）
   - 克隆官方仓库，跑 `examples/acp-agent` 与 `examples/headless-agent` 两个 demo（调研 §3.4.2）
   - 阅读 `docs/subsystems/subagent.md`、`docs/subsystems/approval.md`、`docs/capability-seams.md`（调研 §3.4.3）
3. **握手验收序列**（对应设计 §13 M3 行）：`session/new → session/prompt → 收到 session/update committed 流 → session/cancel → session/request_permission` 各断言一次；再验证 dispose 阶梯（kill 后进程树退出证明，**Windows 上重点实测**，见③待实测项）。
4. **成功路径**：握手、usage 回执、dispose 三项全通过 → 官方 dsh-sdk 定为 M3.5 的 worker runtime（设计 §12"通过则 v1.5 直接采用"）；文件总线降级为审计/人工可读层（调研 §3.2），设计 §4 协议骨架不变。
5. **失败路径**：任一关键项失败（cordis 不兼容 / 握手异常 / usage 缺失 / Windows dispose 异常）→ 换 `dsh-subagent-acp` 重测（协议层更薄、耦合更小）；仍失败 → **自研薄壳兜底**（设计 §12 降级定位），§4 文件总线协议原样执行——"runtime 可替换、协议不变"原则保住（设计 §0）。

## 完成度

**100%。** 交付物清单：
- [x] `tasks/t-0001/result/result-t-0001.md`（本文件，结构符合 §4.7）
- [x] `agents/analyst/notes.md`（≤10 行要点）
- [x] `agents/analyst/status.json`（开始时置 running，结束时置 idle）

验收标准逐条自检：
1. 结构符合 §4.7：结论 / 完成度 / 数据来源 / 遇到的问题 / 广播建议 / 下一步建议 ✓
2. 七维覆盖：协议标准度、usage 计量、进程管理、故障恢复、审批桥、维护成本、版本线风险 ✓（八 runtime × 七维，含官方四件套 + 自研薄壳 + fork/bl 参考）
3. 关键结论标注出处：调研报告章节或设计文档章节 ✓（全文标注）
4. M3 建议：先测包 / profile 命令 / 成功失败双路径 ✓

## 数据来源 / 依据

- `docs/dsh-official-repo-review-2026-08-16.md`（§1 仓库状态、§2.1 四件套、§2.3 文档体系、§2.4 本地能力、§3.1/§3.2 逐节对照、§3.4 验证清单、§4 风险、§5 行动建议）
- `docs/multi-agent-cli-orchestrator-design.md` v0.3（§4.1 manifest、§4.7 交付结构、§7.2 原子领取 ACP 例外、§9 计量、§10 故障恢复及注、§11.2 审批、§12 runtime 选型、§13 路线图）
- `agents/analyst/manifest.json`（runtime=custom / metering=false）

**局限声明**：本报告为文档证据下的二手分析推断，未做任何 runtime 实测；评分矩阵在 M3 实测后应回写修正（本报告已把两个关键未知项显式标注为"待实测"）。

## 遇到的问题

- 无阻塞。
- 两个待实测项已转交 M3 处理：① 双版本线（rc.6 vs 0.0.1-rc.1）的 cordis 兼容性；② Windows 上 dispose 阶梯与进程树退出证明的实际行为（官方示例为 bash 语法，本机为 pwsh——调研 §4.5）。
- 依 manifest `metering=false` 与设计 §9.1 `fork` 行豁免，本任务不写 usage.jsonl。

## 广播建议

（建议总指挥审阅后写入 `shared/collective-memory.md`）
- **双版本线隔离原则**：主包 0.1.0-rc.6 与 subagent 线 0.0.1-rc.1 并行，任何官方包测试必须用独立 profile（如 m3-test），不得污染主配置（来源：调研 §4.2、设计 §12）。
- **ACP 单槽语义**：每 session 单 prompt slot ⇒ 单任务串行天然成立，协议层原子领取无需 rename 技巧（来源：设计 §7.2 ACP 例外）。
- **审批桥通路**：ACP `session/request_permission` + `dsh-permission-presets` 是 v2 审批汇总面板的现成通路；codex / claude-code 无人值守自动拒绝权限，只派只读任务（来源：调研 §2.1/§4.4）。
- **官方教材入口**：`docs/cookbook/`、`docs/capability-seams.md`、`docs/subsystems/*` 是 M2 面板插件的直接教材，勿从零摸（来源：调研 §2.3/§3.2）。

## 下一步建议

- M3 测试 profile 固定命名 `m3-test`；测试脚本与结论落盘 workspace（如 `tests/m3-acp/`），供 Commander 复核与后续 worker 复用；
- 若 M3 通过，M3.5 worker 自动化应优先复用官方 provider 的 spawn/dispose，进程托管器只做"开关 → spawn/stop"映射（设计 §12）；
- 建议 Commander 订阅官方 Discussions/Discord，跟踪 0.1.0 正式版与 ACP 线是否并入主包（调研 §5.4）。
