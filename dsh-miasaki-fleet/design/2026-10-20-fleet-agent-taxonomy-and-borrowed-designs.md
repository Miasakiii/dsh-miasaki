# fleet Agent 类型判定与三仓库可借鉴设计

- 日期：2026-10-20（调研）/ 2026-10-21（整理入库）
- 状态：已立项，P0-A / P0-B 待实施（本文只定义判据、决策与批次，不含代码）
- 触发：2026-10-20 用户给出三条仓库链接并纠正——「fleet 线，你要区分 CLI 工具和 agent 的区别，我要的是 coding agent」；随后指示「这几个仓库可以参考一下，借鉴优秀设计」「先把综合报告提升为 design/ 的入库设计文档、再动代码」。
- 调研报告（本地、不入库）：`_refs/research-2026-10-20/00-synthesis.md`、`magpie.md`、`cc-switch.md`、`cherry-studio.md`（`_refs/` 已 gitignore）。
- 上位协议：[`docs/multi-agent-cli-orchestrator-design.md`](../docs/multi-agent-cli-orchestrator-design.md)。该文档 v0.11 把 worker 定义为「本机已安装的 agent CLI」；本文修订这个定义的判定口径，不改变文件总线、G0–G4 与派单协议。

---

## 0. 结论摘要

1. **三个参考仓库都不是 coding agent。** cc-switch = coding CLI 的配置/供应商控制面；magpie = 本地多协议模型网关 + 配置/账号/额度编排器；Cherry Studio = GUI 优先的通用 Agent 宿主。三者都不能进入 `agents/` 当 worker。
2. **fleet 现有 8 个「agent」是 6 个 coding agent + 2 个工具型 CLI**：`claude / mimo / pi / dsh / gemini / opencode` 是 coding agent（其中 `gemini`、`opencode` 当前未安装）；`bl`、`agent-browser` 是工具型 CLI。
3. **根因是「类型」在 fleet 里不可读**：所有 manifest 只有 `runtime: "cli"`、`model: "cli-default"`，没有 `kind` / 能力 / 权限 / invoke 契约字段；派单器无法判断对方是不是 agent。
4. **本机实测已经发生事实漂移**：`gemini` / `opencode` 已不在 PATH 而 registry 仍列为已发现；5 个 CLI 版本全部落后于 manifest；`mimo` 的派单模板 `mimo {prompt}` 在当前版本会进 TUI（应为 `mimo run {prompt}`）。这证明「模型/配置事实层 + 只读漂移检测」不是假想需求。
5. **落地顺序**：先 P0-A「类型闸门 + 三态可信来源 + SSOT/派生分离」，再 P0-B「模型真实值 + 只读配置漂移检测」，然后 P1「失败分类/配额/调度/UI/交付物声明」、P2「profiles/选型策略/schema 迁移/可选 magpie 模型层」。

---

## 1. 背景与问题

### 1.1 触发与纠正

用户提供三个仓库（[cc-switch](https://github.com/farion1231/cc-switch)、[cherry-studio](https://github.com/CherryHQ/cherry-studio)、[magpie](https://github.com/yetone/magpie)）作为「参考、借鉴优秀设计」，同时明确纠正了 fleet 线的一个范畴错误：**不是「本机所有 AI CLI」都叫 agent，worker 池要的是 coding agent**。

### 1.2 现状（2026-10-20/21 实测）

- `workers/discovery/scan-agents.ps1:12-21` 的 `$catalog` 把 8 个 CLI 一律当「agent CLI」收录，`preflight` 用散文记录差异（如 claude「headless 下 Write 被拒」、agent-browser「命令型非 prompt 型」），但这些差异没有任何字段承载。
- 8 份 manifest 的 `runtime` 全为 `"cli"`、`model` 全为 `"cli-default"`；`schemas/manifest.schema.json` 没有 `kind` / `capabilities` / `permissions` / `invoke_contract`。
- 设计文档 §4.1 已画出 `tool_allowlist` 字段，但 schema 与实现都未落地——「设计已有、机器不可读」。
- `agents/registry.json` 与各 manifest 的 `cli` 字段是同批数据的双拷贝，无派生标记；registry 只是扫描快照，却容易被消费方当成当前事实。
- 本机实测：`gemini`、`opencode` 已不在 PATH；`claude 2.1.302`（档案 2.1.238）、`pi 1.0.4`（0.84.1）、`dsh 0.2.1-rc.2`（0.1.1-rc.1）、`bl 2.2.1`（1.16.0）、`mimo 0.1.14`（0.1.12）全部版本漂移。

### 1.3 本文要回答的问题

1. 什么算 coding agent？判据必须能落到机器可校验的字段，而不是 README 文案。
2. 三个参考仓库各是什么、能不能当 worker、分别借什么？
3. fleet 的 8 个条目各自属于哪类？后续 P0–P2 怎么落、怎么验收？

### 1.4 本文范围

- **包含**：分类判据、三仓库定位、fleet 现状结论、设计决策、P0–P2 落点与验收判据、兼容/迁移/风险。
- **不包含**：代码实施（P0-A 起为后续批次）、对 `~/.dsh/profiles/*` 或各 CLI 用户配置的任何写入、对三个参考仓库的移植。

---

## 2. Coding Agent 判据

### 2.1 五条硬判据

| 编号 | 判据 | 含义 | fleet 中的用途 | 反例 |
|---|---|---|---|---|
| C1 | 自主工具循环 | 多轮调用工具（读写文件、执行命令）完成任务，而非单次文本回复 | 派单模板 `{prompt}` 假设对方能自己执行到底 | 纯聊天 CLI、配置管理 CLI |
| C2 | 代码仓读写与交付 | 能在给定 workspace 内产出可验收的代码/文档变更 | K3 终态要求 `result.json` 与交付物 | 浏览器自动化 CLI、模型网关 |
| C3 | headless 单次调用入口 | 非交互模式 + stdout/exit code 可捕获 | 派单器 spawn 一次进程、捕获 stdout、按计量来源解析 | 只有 GUI/TUI 的宿主 |
| C4 | 进程级可编排边界 | 一次任务 = 一次进程调用，可被 kill/超时/重试 | 调度级生命周期（超时 kill 进程树、并发上限） | 常驻服务、桌面 App |
| C5 | 无人值守权限模型 | 有明确的权限模式/审批语义，且可失败关闭 | 派单前的 TrustGate（P1 落地） | 权限只靠交互式弹窗 |

**界定**：

- **coding agent（worker 候选）** = C1、C2 成立，且 C3、C4 成立；C5 可以后续结构化，但不满足 C1/C3/C4 的一律不是 worker。
- **工具型 CLI** = C1 不成立（单命令/单次调用）。它是 agent 的工具或 Operator 的工具，不是 agent。
- **网关 / 控制面 / Agent 宿主** = 不产生代码交付，也不是进程级可编排的任务执行体。它们服务 coding agent，而不是成为 coding agent。

### 2.2 manifest v2 字段草案（只增不改）

> 原则：**只增字段、不删字段**；新增字段可选，缺省时行为与当前一致。字段路径与枚举在 P0-A 实施时以本机实测校准，本文只定结构。

```jsonc
{
  "id": "claude",
  "name": "Claude Code",

  "//": "—— 第一层：它是什么、能干什么 ——",
  "kind": "coding-agent",                    // coding-agent | tool-cli | unknown（非 agent 类别不进 agents/）
  "capabilities": ["cap:coding", "cap:multi-step-tools", "cap:json-output"],
  "capability_boundary": {                   // 在「本机当前 headless 派单形态」下可验证的边界
    "tool_loop": true,
    "workspace_read": true,
    "workspace_write_headless": false,       // claude headless 下 Write 被自身权限栈拒绝（t-0006 实测）
    "shell_headless": false,
    "network": true
  },
  "model_info": {                            // 三态可信来源；cli-default 不是值
    "value": null,
    "source": "unknown",                     // config | transcript | served | unknown
    "confidence": "unknown",                 // verified | declared | unknown
    "evidence": "config 缺失/未探测"
  },

  "//": "—— 第二层：怎么调用、怎么读结果 ——",
  "runtime": "cli",
  "runtime_kind": "claude-code",
  "cli": {
    "command": "claude",
    "binPath": "%USERPROFILE%\\.local\\bin\\claude.exe",
    "version": "2.1.302",
    "invoke": "claude -p {prompt} --output-format json",
    "invoke_contract": {
      "prompt_transport": "argv",            // argv | stdin
      "output_format": "json",               // json | text | ndjson
      "exit_code_semantics": { "0": "success", "non-zero": "failure" },
      "permission_flags": { "readonly": ["--permission-mode", "plan"] }
    }
  },

  "//": "—— 第三层：信任边界（P0-A 只声明，P1 加闸门）——",
  "permissions": {
    "mode": "workspace-write",
    "tool_allowlist": ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
    "denied_tools": [],
    "approval_required": ["Bash"],
    "headless_allow_delegation": false
  },

  "limits": { "budget_per_day": 2.0, "max_concurrent_tasks": 1,
              "timeout_ms": 900000, "heartbeat_ms": 30000, "max_tokens_per_task": 50000 },
  "persona_prompt": "……",
  "updated_at": "2026-10-21T00:00:00Z"
}
```

### 2.3 证据等级与「不猜」

- **三态**：`coding-agent`（有证据）／`tool-cli`（有证据）／`unknown`（证据不足）。**不存在「默认是 agent」**。
- 每条判定必须带 `source`（谁说的：扫描器 catalog / 人工核实 / 探针实测）与 `evidence`（可复核的探测结果或校准任务 id）。禁止把「声明」当「核实」。
- `cli-default` 不是模型值，只是「CLI 自带默认模型」的占位；`model_info.value = null + source = unknown` 才是未声明的正确表示（延续 `workers/lib/verifier.cjs` 对 `cli-default` 的既有保守处置）。
- **证据不足时 fail-closed**：派单器拒绝 `unknown` 的 worker，并给迁移/校准提示。宁可不派，不假装。

---

## 3. 三个参考仓库的定位

### 3.1 判定总表

| 仓库 | 实际定位 | 能否当 fleet worker | 对 fleet 的正确用法 |
|---|---|---|---|
| **cc-switch** | 10 个 agent CLI 的配置/供应商控制面 + 本机 API 网关 + 用量会话浏览器（Tauri 2，MIT） | ❌ | 借「三态可信来源」「SSOT/派生分离」「工具类型枚举 + 能力矩阵」；不搬 proxy/会话解析/SQLite |
| **magpie** | 本地多协议模型网关（`127.0.0.1:3425`）+ 配置/账号/额度编排器（Go + Wails，MIT） | ❌ | 借「agent adapter 声明层」「usage 富字段」「Drift 五类」「失败分类」「配额分档」；不搬网关本体 |
| **Cherry Studio** | GUI 优先的跨平台 AI 工作站 / Agent 宿主（Electron，AGPL-3.0） | ❌ | 借「Agent profile 与 CodeCli 两层」「权限三层 + headless fail-closed」「调度语义」「UI 信息架构」；不搬 Electron/SQLite/IM |

### 3.2 cc-switch：配置控制面

判定证据（详见本地调研报告）：

- 后端 Rust 无 agent 主循环、无工具执行器；`Command::new` 仅 38 处，全是 `--version` 探测、找 bin、`taskkill`、开终端、装卸 CLI；
- 对 CLI 的唯一交互是「改配置文件 + 起终端让用户自己跑」；写路径全在 `%USERPROFILE%\.claude`、`.codex` 等 home 配置，从不写用户代码仓；
- 它自己就在维护「工具类型元数据」，正说明控制面与执行体的边界是真实工程需求。

借鉴项：三态可信来源（Supported/Unsupported/Unknown + 声明→人工核实→未知的优先级）、SSOT 与派生视图分离、工具类型枚举与能力谓词、写前备份/写后校验。

### 3.3 magpie：模型网关 + 配置/账号/额度编排器

判定证据：

- `docs/subsystems/gateway-request-hooks.md:5` 明写「The gateway makes one model request per client request. Tool declarations, tool execution and subsequent inference rounds belong to the client.」；
- `internal/agent/agent.go:1` 自述该包描述的是「每个 coding agent 的配置放在哪、哪些字段重要」——58 个 adapter 全是配置读写；
- 唯一「跑 agent」的角落是 Claude 订阅桥（把本机 `claude` 二进制当 provider 后端，属 provider 适配），不改变分类。

借鉴项：agent adapter 声明层（配置文件 → 模型字段）、usage 富字段（requested/served/provider/account/effort/tries/errType）、配置漂移五类（unwired/replaced/bypassed/unreachable/proxied）、失败分类器、配额三源与 90%/98% 分档、profiles。**不借**多协议互译 IR、订阅凭据发现、`--dangerously-skip-permissions` 桥、Bun/Wails 等重依赖。

### 3.4 Cherry Studio：Agent 宿主

判定证据：

- `package.json` 无 `bin`，入口是 Electron `main`，**没有 headless/CI 入口**；
- v2 的 Agent 能改代码，是因为内嵌 `claude-code` / `pi` runtime（`AGENT_TYPES=['claude-code','pi']`），不是自身产品定位；
- 它自己把「Agent profile + runtime」与「CodeCli（14 个 CLI 的安装/启动/配置注入）」分成两层，并规定 headless 一次性委托的 skill 契约——这正是「agent 与 CLI 工具分层」的工程旁证。

借鉴项：Agent 档案分层（kind/capabilities/permissions/workspace）、权限三层模型 + headless 失败关闭、定时任务「搬语义不搬 daemon」、UI 信息架构、`result.json` 的 `deliverables[]` 显式声明。**不借** Electron/SQLite/JobManager/IM 通道、默认 `auto` 权限模式。

### 3.5 对 fleet 的统一结论

- 三个仓库**全部不进入 `agents/`**；它们是设计参照物与外部事实来源。
- 若未来要「用」而不是「借鉴」：magpie 只能作为可选的**模型层基础设施**（P2，需 Operator 拍板，且与 fleet 零依赖纪律冲突）；cc-switch 可作为配置事实的交叉校验来源；Cherry 不进入 fleet 架构，只借 UI/档案/权限语义。

---

## 4. fleet 现状与分类结论

### 4.1 实测表（2026-10-20/21，本机）

| registry 条目 | 本机事实 | 判定 | manifest 记录（漂移） |
|---|---|---|---|
| claude | `claude 2.1.302` | **coding-agent** | 2.1.238 |
| mimo | `mimo 0.1.14`（mimocode：ACP server / MCP / `run` / `serve` 子命令） | **coding-agent** | 0.1.12；invoke 仍为 `mimo {prompt}`（当前版本会进 TUI，应为 `mimo run {prompt}`） |
| pi | `pi 1.0.4` | **coding-agent** | 0.84.1 |
| dsh | `dsh 0.2.1-rc.2` | **coding-agent** | 0.1.1-rc.1 |
| gemini | **ABSENT**（npm 全局与 PATH 均无） | coding-agent（未安装） | 0.55.1（stale） |
| opencode | **ABSENT**（npm 全局与 PATH 均无） | coding-agent（未安装） | 1.18.18（stale） |
| bl | `bl 2.2.1` | **tool-cli**（云资源/平台 CLI hub） | 1.16.0 |
| agent-browser | `agent-browser 0.34.0` | **tool-cli**（命令型浏览器自动化） | 0.34.0 |

### 4.2 已发生的漂移（不是假想风险）

- 版本漂移：5 个在装 CLI 全部落后于 manifest；
- 存在性漂移：`gemini` / `opencode` 未安装，但 registry 仍列出（扫描器是快照，消费方却当当前事实）；
- 调用契约漂移：`mimo` 已升级为 mimocode（`mimo run` 才是非交互入口），manfest 的 `mimo {prompt}` 会启动 TUI；
- 类型漂移：`bl` / `agent-browser` 与 coding agent 共用同一个「agent」抽象，派单器无法区分。

### 4.3 分类结论

- **coding agent（worker 候选）6 个**：`claude`、`mimo`、`pi`、`dsh`、`gemini`、`opencode`；其中当前实际在装 4 个。
- **工具型 CLI 2 个**：`bl`、`agent-browser`；保留档案但 `kind: "tool-cli"`，不可被派单。
- **`gemini` / `opencode`**：类型判定不因缺失改变，但 `present: false` 必须显式；扫描器下一次运行应把它们从 registry 的「已发现」中移除，并在 manifest 保留 `observed.present=false`。

---

## 5. 设计决策

| 编号 | 决策 | 理由 | 对应批次 |
|---|---|---|---|
| **D1** | **worker 池只收 `kind = coding-agent`**；`tool-cli` 不可派单；`unknown` fail-closed 并提示迁移/校准 | 直接回应用户诉求；杜绝「派给工具 → 假完成」 | P0-A |
| **D2** | **三态可信来源**：`model_info{value,source,confidence,evidence}`；`cli-default` 不再是模型值 | `cli-default` 导致 G2 选型与 G4 模型级异构不可判定（`workers/lib/verifier.cjs` 既有保守处置的延伸） | P0-A/P0-B |
| **D3** | **SSOT 与派生分离**：manifest 只放 Operator 可编辑字段；扫描产物放 `agents/<id>/observed.json`；registry 明示「派生快照」 | registry 与 manifest.cli 双拷贝已造成事实漂移；派生视图不得冒充真相 | P0-A/P0-B |
| **D4** | **模型/配置事实层只读优先**：新增 `shared/agent-adapters.json`，只读读取各 CLI 配置；不写用户配置目录 | 踩线成本高（动 `%USERPROFILE%\.dsh` 等必须先问用户）；只读即可消除大部分漂移 | P0-B |
| **D5** | **权限/信任边界结构化**：`permissions` 字段 + headless fail-closed；P0-A 只声明，P1 加 `Test-TrustGate` | 当前 `preflight` 散文与 brief 约定无法机器校验；headless 不得默认放出写入/委派 | P0-A（声明）/P1（闸门） |
| **D6** | **P1 采纳但不进本轮**：失败分类、配额分档、定时语义、UI 收敛、`deliverables[]` | 价值高但依赖 P0 的类型/模型事实；单独批次交付 | P1 |
| **D7** | **不引入常驻网关**：magpie 仅作 P2 可选模型层评估；fleet 保持零第三方依赖 | 与仓库纪律冲突；fleet 的价值在编排层，不在模型层 | P2（需拍板） |
| **D8** | **不照搬清单**：magpie 多协议 IR/订阅凭据桥/大规模网关；cc-switch proxy 四协议/会话解析/90+ 预设/SQLite；Cherry Electron/SQLite/JobManager/IM/默认 auto 权限 | 实现规模与 fleet 定位不匹配；照搬会把零依赖脚本线变成重运行时 | 全部批次 |

---

## 6. 目标架构

```
Operator / Commander
        │
        ▼
┌──────────────────────────────────────────────┐
│ 编排层（fleet 已有）：文件总线 + G0/G1/G2/G4  │
│ dispatch gates / task-ready / agent-pick /   │
│ verifier-pick / monitor + DSH Fleet tab      │
└───────────────┬──────────────────────────────┘
                │ 只读事实 + 显式 unknown
                ▼
┌──────────────────────────────────────────────┐
│ 模型/配置事实层（借鉴，不引依赖）             │
│ agent-adapters / model_info / observed.json  │
│ config-drift / usage 富字段 / quota 快照      │
│ （可选 P2：magpie 作为模型路由层）            │
└───────────────┬──────────────────────────────┘
                │ spawn 一次进程 = 一次任务
                ▼
┌──────────────────────────────────────────────┐
│ 执行层：kind = coding-agent 的 CLI            │
│ claude / mimo / pi / dsh / …                  │
│ 工具型 CLI（bl / agent-browser）不进 worker 池 │
└──────────────────────────────────────────────┘
```

**不变量**：

1. 文件总线仍是唯一 SSOT；派生视图（registry/observed/fleet-pulse）不得被当成真相。
2. 工具型 CLI 不进执行层；需要时由 coding agent 或 Commander 直接调用。
3. 任何「未声明/未验证」的事实必须显式 `unknown`，不允许默认值冒充。
4. 零第三方依赖不变；magpie 若接入只能是外部可选服务，不能成为派单路径的硬依赖。

---

## 7. 实施批次与验收

### 7.1 P0-A：类型闸门（批次 1）

**范围**：让「是不是 coding agent」变成机器可读、可校验、可拒绝的事实。

| 落点 | 改动 |
|---|---|
| `schemas/manifest.schema.json` | 新增 `kind`、`capabilities[]`、`capability_boundary`、`model_info`、`invoke_contract`、`permissions`（可选字段，缺省零行为变更） |
| `workers/discovery/scan-agents.ps1` | `$catalog` 每条补 `kind/capabilities/boundary/invoke_contract`；修复 `mimo` 模板为 `mimo run {prompt}`；缺失 CLI 的 registry 条目显式移除、manifest 记 `observed.present=false` |
| `workers/dispatch/dispatch-task.ps1` | 新增 `Test-AgentKindGate`：`kind != coding-agent` → exit 2；`unknown` → exit 2 + 迁移提示；`-CheckOnly` 同口径 |
| `workers/graph/agent-pick.mjs` / `workers/lib/capability-graph.cjs` | 支持 `--kind coding-agent` 过滤；能力图输入扩展 `capabilities[]`（保留 `skills[]` 兼容） |
| `workers/graph/verifier-pick.mjs` / `workers/lib/verifier.cjs` | 只把 coding-agent 纳入验证者候选 |
| `fleet-monitor/server.js` + `plugins/dsh-fleet-panel` | `/api/fleet` 输出 `kind/model_info`；面板显示「coding agent / 工具」徽标 |
| `workers/validate-bus.mjs` | `kind` 枚举校验 + 交叉校验（如 `kind=coding-agent ⇒ capability_boundary.tool_loop=true`；不强制 `workspace_write_headless=true`——claude 在 headless 下写权限被自身拒绝，`t-0006` 实测） |
| `agents/*/manifest.json` + `agents/registry.json` | 一次性迁移：补 `kind` 等字段；迁移必须经 `bus-apply` 唯一入口 |
| 文档 | 本文件回写链接；`docs/multi-agent-cli-orchestrator-design.md` §4.1/§7.5 修订 worker 判据；回归矩阵补验收项 |

**验收判据**：

1. `node workers/graph/agent-pick.mjs --need coding --kind coding-agent` 只返回 coding agents；`bl` / `agent-browser` 不出现。
2. 向 `bl` / `agent-browser` 派单（含 `-CheckOnly`）exit 2，并打印「tool-cli 不是 worker」的原因。
3. `kind` 缺失的档案派单被拒绝，提示迁移命令；补齐后恢复。
4. `node workers/validate-bus.mjs` 对坏档案给文件+行号；合法档案 0 错误。
5. 旧字段行为不变（零行为变更证明：迁移前 coding agent 的派单判定逐字一致，测试钉住）。
6. `node ../scripts/verify-all.mjs fleet` 全 PASS，项数只增不减。
7. 面板 Agent 卡片可区分 coding agent / tool-cli，并显示 `model_info.source`。

### 7.2 P0-B：模型真相 + 只读漂移检测（批次 2）

| 落点 | 改动 |
|---|---|
| `shared/agent-adapters.json`（新） | 每 agent 一条只读规则：配置文件路径 + 模型字段（JSON/JSONC/TOML/YAML 各自适配）；字段路径必须本机实测，读不到写 unknown |
| `workers/discovery/scan-models`（新）或 scan 扩展 | 填 `model_info`；`cli-default` 置空并标 unknown |
| `workers/lib/config-drift.cjs` + `workers/discovery/agent-drift.mjs`（新） | 只读检测 `match/replaced/missing/parse-error/unknown`；不写任何配置 |
| `workers/dispatch/dispatch-task.ps1` | usage 行补 `provider/requested/served/effort/tries/err_type`（增量，不破旧字段） |
| `fleet-monitor/server.js` | 新增 `GET /api/drift`（照 `/api/dispatchable` 模式 spawn 现成 CLI，不重复实现） |

**验收判据**：

1. `model_info.value` 要么是真实模型，要么 `null + source=unknown`；不再出现 `cli-default` 被当模型。
2. `agent-drift` 能报出本机事实：`gemini/opencode missing`、版本落后、`mimo` 契约漂移。
3. usage 行有 rich 字段后，`verifier-pick` 的模型级异构从「不可判定」变成「可判定或显式 unknown」。
4. 只读验证：跑完 drift 检查后，用户 `%USERPROFILE%` 下配置文件 mtime/内容不变。

### 7.3 P1（批次 3+）

失败分类器与 failover 建议（magpie）；配额三源 + 90%/98% 分档（magpie，可选接 `magpie quota --json`，不强依赖）；定时任务语义（Cherry：`schedule` 行 + 幂等 fire + enqueue-due，不引 daemon）；权限/信任闸门 `Test-TrustGate`（Cherry）；`result.json` 增 `deliverables[]`（Cherry）；UI 收敛为 概览 / Agents / Tasks / Schedule / Verifiers / Events。

### 7.4 P2（批次 4）

profiles（整套快照）；可插拔选型策略（只排序不执行，`shared/selection-policy.json`）；manifest `schema_version` 与迁移机制；magpie 作为可选模型层（需 Operator 拍板）；MCP/Skills/Prompts 集中管理（cc-switch 模式，按需求评估）。

---

## 8. 兼容、迁移与回滚

- **只增字段**：P0-A 新字段全部可选；消费方缺字段时按旧路径行为（除 `kind` 的 fail-closed 决策，见下）。
- **迁移**：`agents/*/manifest.json` 与 `registry.json` 的改动经 `bus-apply` 唯一入口（一次超步或分批，视变更量）；迁移脚本输出「哪些档案补了哪些字段、证据是什么」。
- **行为变更窗口**：迁移前，缺失 `kind` 的档案派单会被拒（fail-closed）。因此迁移必须与代码同批完成；中间态不可长久保留。回滚 = 移除新字段 + 恢复旧派单行为（旧字段未被破坏）。
- **零行为变更证明**：对迁移后的 coding agent，派单判定与迁移前逐字一致；测试覆盖（可参考 `tests/task-graph.test.mjs` 的新旧规则等价性做法）。

---

## 9. 风险与开放问题

### 9.1 风险

| 风险 | 影响 | 处置 |
|---|---|---|
| 误分类：把 coding agent 判成工具 | 能力浪费、fleet 缩水 | 证据三态 + 人工复核 + 校准任务；`unknown` 不静默放行 |
| 误分类：把工具判成 agent | 假完成、浪费预算 | C1/C3 硬判据 + 类型闸门 |
| fail-closed 误伤首跑 | 新 agent 派不出去 | 迁移与代码同批；错误文案给迁移命令；`-CheckOnly` 可预检 |
| CLI 版本/契约漂移 | 派单失败或进 TUI | P0-B drift + `invoke_contract` + 校准探测 |
| 参考仓库设计过重 | 破坏零依赖纪律 | D7/D8 明确排除；只借模式 |
| 用户未提交改动混批 | 审查困难 | 实施前先与用户确认工作区状态或先提交既有批次 |

### 9.2 开放问题（需 Operator 拍板）

1. **`mimo` 模板修正**（`mimo run`）与 `gemini/opencode` 缺失登记，是否并入 P0-A 首批？
2. **magpie 是否进入 P2 评估**（本机有 2026-10-12 的配置痕迹，但二进制当前不在 PATH；接入意味着模型层依赖）？
3. **权限闸门（`Test-TrustGate`）**放在 P0-A 还是 P1？（本文建议 P1，先让类型/事实层稳定）
4. 现有 fleet 未提交改动（scanner hardening / fleet-panel 等）先在用户侧提交，还是允许 P0-A 与其共存？

---

## 10. 参考与证据

### 10.1 外部参考

- cc-switch：<https://github.com/farion1231/cc-switch>（MIT；Tauri 2；无 agent 主循环，配置控制面）
- magpie：<https://github.com/yetone/magpie>（MIT；Go + Wails；本地网关 `127.0.0.1:3425`，`docs/subsystems/gateway-request-hooks.md:5` 界定工具执行归 client）
- Cherry Studio：<https://github.com/CherryHQ/cherry-studio>（AGPL-3.0；Electron；无 `bin`/headless，Agent host）

### 10.2 本仓相关（已入库文档）

- 上位协议：[`docs/multi-agent-cli-orchestrator-design.md`](../docs/multi-agent-cli-orchestrator-design.md)
- 回归矩阵：[`../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md`](../../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)
- 本线索引：[`README.md`](../README.md)

### 10.3 本地调研报告（不入库，仅本机留档）

- `_refs/research-2026-10-20/00-synthesis.md`
- `_refs/research-2026-10-20/magpie.md`（B1–B11）
- `_refs/research-2026-10-20/cc-switch.md`（B1–B9）
- `_refs/research-2026-10-20/cherry-studio.md`（A1–A16）

### 10.4 方法与局限

- 三仓均为**浅克隆静态阅读**（未运行）；版本：magpie v0.1.1298、cc-switch v4.0.17、Cherry v2.1.7（2026-10-20）。
- fleet 侧为只读检查（manifest/registry/scanner/dispatch/monitor）＋本机 CLI 探测；未写任何配置。
- 行号与版本以调研时点为准；`gemini/opencode` 后续可能重装，`present` 需以最近一次扫描为准。
