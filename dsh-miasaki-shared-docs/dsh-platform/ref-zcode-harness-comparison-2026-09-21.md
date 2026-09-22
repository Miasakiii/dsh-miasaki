# ZCode（智谱开源 coding agent harness）机制对比与可迁移设计点

- 日期：2026-09-21
- 调研者：总指挥（Miasaki 会话）
- 对象：`zai-org/ZCode`，本地快照 HEAD `872ad960de7ec172591f7e1952f7849229f94521`（commit 时间 2026-09-20T21:14:32Z）
- 本地快照：`_refs/zcode/`（根 `.gitignore:23` 已 ignore `_refs/`，**不入库**；重建命令见 §10）
- 口径：`[实测]` = 本次拉 GitHub API 或**在本地快照逐文件读到**；`[推断]` = 基于实测事实的判断，本次未实测
- 同类前置：[`dsh-official-repo-review-2026-09-21.md`](dsh-official-repo-review-2026-09-21.md)（同日的 DSH 本体复查）、[`ref-tencent-dsh-review-2026-08-15.md`](ref-tencent-dsh-review-2026-08-15.md)（第三方视角的 DSH 定位）
- 本文回答：**ZCode 有哪些机制值得我们搬**、**哪些不要搬**、**每一条落在哪条线**

---

## 0. 摘要

1. **最大收获不是功能，是「架构治理闭环」** `[实测]`：ZCode 把架构约束写成可机检的 `architecture-policy.yaml`，
   配合四入口 CLI（`check` / `report` / `baseline:update` / `context`）、**冻结存量违规的 `.architecture-baseline.json`**，
   以及一份给 agent 看的 `architecture-governance` Skill（含 8 个决策问题与 7 个必须拒绝的形状）。
   其自述目标是"让检查器**确认**一个决策，而不是第一次**发现**它"。**本仓七线 monorepo 正缺这一层**（§2）。
2. **一个立刻可用的发现（与 ZCode 无关但由它逼出来）** `[实测]`：**DSH 本体已经有 hooks 机制**——
   `dsh-hook-protocol` + `dsh-hooks-claude-code` + `dsh-hooks-codex` 三个包就在本机安装目录里，
   读**既有的 `hooks.json`** 即可运行，把 Claude Code / Codex 的 hook 配置桥接到 DSH 的原生扩展点
   （`agent/session-start`、waterfall `agent/pre-step` / `tools/pre-execute`、`tools/post-execute`、
   serial `agent/turn-stopping`、`subagent/start|end`）；**但我们当前的 web profile 没有挂载它**（§3.4）。
3. **ZCode 的 hooks 与 DSH 的 hooks 是两种架构** `[实测]`：ZCode 是**自成一体的 7 事件协议 + 工作区信任模型**；
   DSH 是**方言桥接**——hook 只是兼容层，**原生拦截面是 waterfall 事件**。两者可互补：
   ZCode 的**信任态机**是 DSH 目前没有的，DSH 的**最严格折叠 + 成对审计**比 ZCode 更严谨（§3.3）。
4. **插件分发是两条完全不同的路** `[实测]`：ZCode 走「官方市场 + CDN zip + **强制 sha256** + 内置插件可卸载可恢复」；
   DSH 走「npm 包（自带 `cordis.patch.yml`）+ profile 的 `node_modules`」。ZCode 的**商店元数据与诊断码设计**
   可整套借用，分发管道不必照搬（§4）。
5. **远程链路的身份契约直接可搬到 `dsh-miasaki-ssh`** `[实测]`：ZCode 用
   `remote:ssh:<host>:<port>:<username>:<posixPath>` 把 `workspaceIdentity`（身份隔离）与
   `workspacePath`（文件操作）彻底分开，并支持 `ssh` / `wsl` / `docker` 三类（§5）。
6. **不要搬的**：SQLite + 迁移的会话存储（DSH 的追加式事件流 + Trajectory 投影是强项，换掉是倒退）、
   Electron 桌面壳、以及为 79 万行代码服务的治理开销（§9）。

---

## 1. 对象与规模 `[实测]`

| 项 | 值（2026-09-21） |
|---|---|
| 仓库 / 许可 | `zai-org/ZCode` / **Apache-2.0**（另有 `NOTICE.md`、`THIRD-PARTY-NOTICES.md`） |
| 描述 | Z.ai's coding agent harness. Powerful, intelligent, extensible. |
| Star / Fork / Open Issues | **5,056** / 1,421 / 11 |
| 创建 / 最后推送 | 2026-09-20T12:01:16Z / 2026-09-21T00:02:36Z |
| 提交历史 | 仅 2 笔：`Initial commit`（09-20T12:06Z）、`feat: open source`（09-20T21:14Z）——**一次性开源，无上游历史** |
| 版本 / 运行时 | 根 `package.json` version **3.14.0**，`engines.node >= 24.0.0`，`packageManager pnpm@10.33.2` |
| 规模 | **3,896** 个 `.ts/.tsx`（排除 `node_modules`），**787,551** 行；clone 后 6,973 个文件 |
| 包数 | `packages/` **14** 个 + `apps/zcode-cli/packages/` **16** 个 |

**三端一运行时** `[实测]`：Electron 桌面（`pnpm dev:desktop`）、浏览器工作台（`pnpm dev:web`，前端 5173 + 后端 3030）、
终端 TUI（`zcode`，`--web` 切 Web）。CLI 产物为 `dist/zcode.cjs`，**运行时零生产依赖**，
另留 Node **SEA** 单文件打包路径（`postject`）作可选——并在 SEA 下用隐藏子命令
（`__zcode-plugin-host`、`__zcode-dwf-child`）绕开"单文件二进制不解释 Node 旗标"的限制。

**关键包** `[实测]`：`apps/zcode-cli/packages/` 下含 `adapters` / `bootstrap` / `cli` / `contracts` / `core` /
`dynamic-workflow` / `dynamic-workflow-runtime` / `node-repl-host` / `superpowers-plugin` /
`browser-use-plugin` / `telemetry` / `tui` / `i18n` / `debug` / `shared-types` / `swift-bridge`；
`packages/` 下含 `desktop` / `web` / `server` / `ui` / `services` / `client` / `rpc` / `shared` /
`provider` / `provider-node` / `zcode-cua` / `formal-proof` / `model-option-map` / `zcode-server-cli`。

> 注意 `harness/remote/` **不是产品代码** `[实测]`：整个目录只有 `Dockerfile`、`build.sh` 和一份 3 行的 README
> （`docker run -d -p 2222:22 --rm ssh-server:latest` + `ssh-copy-id`），是**开发自测用的 SSH 容器**。
> 真正的远程能力在 `packages/server` 与 `packages/desktop`（见 §5）。

---

## 2. 架构治理闭环（★最高价值，建议整套引入）

### 2.1 可机检的策略文件 `[实测]`

根目录 `architecture-policy.yaml`，`version: 1`，15 个 module 条目。字段语义：

```yaml
modules:
  - id: storage
    roots: [packages/services/src/storage]
    managed: true                                   # 受治理；false = 存量 legacy，暂不检查
    requires: [shared, rpc, services]               # 允许的跨模块依赖白名单
    publicEntrypoints: [packages/services/src/storage/contract.ts]   # 唯一公开入口
    layers: { domain: domain, app: app, adapters: adapters }
    layerOrder: [domain, app, adapters]             # 只能由高向低依赖
    owner: desktop-settings                         # 责任人/归属
global:
  maxFileLines: 400
  maxContractLines: 300
  maxPublicMethods: 12
  forbidCycles: true
  forbidDeepImports: true
  managedOnly: true
exceptions: []                                      # 例外，可过期
```

**策略要点** `[实测]`：15 个模块里**只有 `storage` 标了 `managed: true`**，其余全是 `managed: false`。
即：**存量冻结、增量从严**——新模块或完成迁移的模块才纳入检查，不要求一次性改造 79 万行。

### 2.2 四入口 CLI 与 12 条规则 `[实测]`

```jsonc
"architecture:check":           "node scripts/architecture/architecture-check.mjs check",
"architecture:report":          "… report",
"architecture:baseline:update": "… baseline:update",
"architecture:context":         "… context",
"verify:pre-push":              "pnpm run lint && pnpm run architecture:check -- --changed"
```

实现落在 `scripts/architecture/`（`architecture-check.mjs` / `policy.mjs` / `git-file-names.mjs` / `index.mjs`）：
用 **TypeScript Compiler API 解析 AST**（`policy.mjs` 里 `ts.createSourceFile` + `importsOf` + `countPublicMethods`）
构建导入图，逐文件判定所属 module 与 layer。

规则目录（`.agents/skills/.../references/rule-catalog.md`）共 **12 条** `[实测]`：

| 规则 | 含义 |
|---|---|
| `module-dependency` | 跨模块 import 未登记在 `requires` |
| `deep-import` | 绕过模块公开入口 |
| `cycle` | 受治理依赖图有环 |
| `max-file-lines` | 超出 400 行预算（**不允许加 disable**） |
| `max-contract-lines` | 契约过宽（>300 行） |
| `max-public-methods` | 契约公开方法过多（>12） |
| `layer-direction` | 低层 import 了高层的实现 |
| `domain-io` | domain 层 import 了 process/network/fs/timer |
| `ui-implementation-import` | `ui` 层 import 了 repo/runtime/service 实现 |
| `expired-exception` | 配置的例外已过期 |
| `missing-module-artifact` | 受治理模块缺 manifest/契约样例/CONTRACT.md |
| `disable-count` | 受治理代码新增了 lint 抑制 |

**存量与增量的分离** `[实测]`：`Existing violations are suppressible only through .architecture-baseline.json;
new violations remain blocking.` 且明确 **`CI never refreshes baseline automatically`**（基线只能由人 reviewed 地更新）。

### 2.3 给 agent 的治理 Skill —— 这才是精髓 `[实测]`

`.agents/skills/architecture-governance/SKILL.md` 自述：

> It is a design guide **as well as** a gate: the goal is to make the intended architecture obvious **before**
> code is generated, so the checker **confirms a decision instead of discovering it for the first time**.

工作流（编前 → 编后）：`architecture:check --changed` 定位模块 → `architecture:context <module-id>` 生成**有界阅读包**
（只读目标契约、直接引用的契约、相关 spec 与测试，**不把整个实现拷进 prompt**）→ 先写 spec 再写码 →
做一次显式设计决策 → 改完再 check，**新增违规与基线违规分开汇报**。

三条设计决策（原文）：**One owner**（每份可变状态只有一个所有者）、**One path**（已有路径能表达就复用，不建平行 helper）、
**Explicit boundaries**（每个新文件选层、每条跨模块边先定公开契约）。分层判据给了"快速测试"：
`需要 await？那就不是 domain。知道自己是 sqlite / MessagePort / 定时器？那就是 adapters。`

`references/ai-guidance.md` 给出 **8 个编码前必须回答的问题** `[实测]`：
Behavior / Owner / Contract / Layer / Reuse / Time / Remote / Context；以及 **7 个必须在设计阶段拒绝的形状**，
其中几条几乎逐字命中本仓历史问题：

- UI 组件写持久化、runtime 状态或**第二个队列**；
- 两个 service 接受同一命令、或都声称拥有同一状态字段；
- 新增的 cache / event bus / adapter / helper **重复了已有路径**；
- domain 对象 import 文件系统、进程、网络、定时器；
- 仅为逃避定义契约而加的跨模块 deep import；
- 混用桌面 `continuous` 与移动 `replayable` 语义的远程流改动；
- 没有明确迁移边界的"顺手大重构"。

并要求补丁描述里带一段决策记录 `[实测]`：

```text
owner: <单一状态所有者>
command path: <入口 → 所有者>
derived views: <投影自哪里>
ordering/idempotency: <顺序与重复处理>
delivery: <desktop-continuous | web-remote-replayable | both>
contracts/spec/tests: <有界阅读与验证集合>
```

### 2.4 对本仓的可迁移性

**本仓已有防线（实测口径，供对照）** `[实测]`：

- `scripts/verify-all.mjs`（307 行）= 七线统一入口，跑各线 `node --check` 语法 + `test/*.test.js` 单测 +
  fleet 总线/图校验 + desktop 令牌漂移与 5 个本体补丁 `patch verify` + `cargo test`
- CI = `.github/workflows/verify-all.yml`（windows-latest / Node 22.19.0 / pnpm 11），**L2–L4 明示不在 CI**
- 回归矩阵 `cross/smoke-test-matrix.md` 五层 L0 静态 / L1 单测 / L2 插件加载 / L3 实机冒烟 / L4 跨线联动，
  §1 记 2026-09-19 基线 81 项全 PASS
- 根 `AGENTS.md` 把"变更同步各线 README + `design/CHANGELOG.md`、不擅自 commit、本体补丁唯一住处 +
  改后必须 `verify`"写成硬约束

`[推断]` **缺口是"结构漂移"而非"行为回归"**：现有防线全部是**行为**导向（能不能跑、跑得对不对），
没有一条在问"这个 import 该不该存在""这个文件是不是太大""这层有没有越界"。
本仓七条线零耦合、只共享 `dsh-miasaki-shared-docs/`，天然适合"每线一 module"的策略文件。
注意 ZCode 的强度是为 79 万行 / 单产品服务的，本仓应取**"增量冻结 + 决策记录"两件**，
`managed` 全 `false` 起步（只做地图不设门禁），最小落法见 §8 的 P1。

---

## 3. 拦截体系：ZCode hooks vs DSH hooks

### 3.1 ZCode：自成一体的 7 事件协议 `[实测]`

契约在 `apps/zcode-cli/packages/contracts/src/hooks/index.ts`。事件名：
`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PermissionRequest` / `PostToolUse` /
`PostToolUseFailure` / `Stop`。

- 结果态 `HookOutcome`：`success` / `blocked` / `failed` / `cancelled` / `timed_out`
- 来源 `HookSourceKind`：`user` / `plugin` / `project` / `internal`（**hook 可以来自插件**）
- 决策 `HookPermissionDecision`：`allow` / `ask` / `deny`
- 输入统一携带 `sessionId` / `turnId` / `traceId` / `cwd` / `mode`；
  `PreToolUse` 额外带 `toolName` / `toolInput` / `riskLevel` / `sideEffectScope`
- `SessionStart.source` 有 4 值：`startup` / `resume` / `clear` / `compact`（**压缩、清空也算会话开始**）
- 输出能力：`additionalContext`、`continue`、`decision: approve|block`、
  `hookSpecificOutput.permissionDecision`、`updatedInput`（**改写工具入参**）、`permissionUpdates`
- `Stop` 输入带 `stopHookActive` + `toolCallCount`，可要求再跑一步

**执行与权限的接缝** `[实测]`：`core/src/tool/executor/hook-flow.ts` 提供
`runPreToolUseHooks` / `runPostToolUseFailureHooks`，被 `call-runner.ts` 调用，
hook 的判定落成具名规则 `hook.PreToolUse.allow` / `hook.PreToolUse.ask`（见 `memory-file-permission.ts`），
即 **hook 决策与内置权限规则走同一套 ruleId 空间**，不是旁路。

**对 Claude Code 的兼容** `[实测]`：`configured-runner-input.ts` 把 hook 输入写成临时 `transcript.jsonl`
并同时提供 `transcript_path` 与 `transcriptPath`（snake/camel 双写）；
`custom-command-shell-expansion.ts` 同时展开 `CLAUDE_*` 与 `ZCODE_*` 变量族
（`CLAUDE_PLUGIN_ROOT`、`CLAUDE_PROJECT_DIR`、`CLAUDE_SKILL_DIR` 等）——**刻意承接 Claude Code 生态**。

### 3.2 工作区 hook 的信任态机（ZCode 独有的亮点）`[实测]`

`contracts/src/hooks/workspace-hook-trust.ts`。核心事实：

- **7 个信任态**：`not_applicable` / `pending_trust` / `trusted_persistent` /
  `blocked_untrusted` / `blocked_policy` / `revoked` / `stale_digest`
- **4 个准入分类**：`not_applicable` / `admitted` / `pending` / `blocked`
- **20 个 reason code**（含 `workspace_hooks_config_unreadable` 与 `..._write_failed` **刻意分开**，
  因为"读取失败曾被 mutation 在 readFile 失败时抛出，误导用户重试「写入」"——源码注释原话）
- 摘要版本 `WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION = 1`，人工审查超时 `10 分钟`
- 声明字段白名单化：`root` / `matcher` / `events` / `process` / `command` 各自的合法键写死，
  多出未知字段 → `workspace_hooks_unknown_execution_field`

**设计意图** `[推断]`：项目里的 `.zcode` 配置会加载外部进程 hook（等于任意代码执行），
所以"谁能跑 hook"必须是一个**显式信任决策 + 摘要指纹 + 可撤销**的状态机，
而不是一个布尔开关。状态到准入的映射是纯函数表（`WORKSPACE_HOOK_STATE_ADMISSION_MAP`）。

### 3.3 与 DSH 的架构对照

DSH 侧 `[实测]`（本机安装目录 `@deepseek-ai/dsh/node_modules/` 下）：

- `dsh-hook-protocol`：协议内核，含 `createDetachedRuns`（脱离运行链的跟踪与 dispose 时中止）
  与不变式伴生插件（注册在 `ctx.invariants`，拒绝"未开启轮次外追加的 `hook/*` 事件"、
  "没有 matching invoked 的结果"、"未知方言"、"非有限时长"）
- `dsh-hooks-claude-code`：桥接 Claude Code 方言，支持 **7 个点**——
  `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `SubagentStart` / `SubagentStop`；
  Claude Code 当前 30 个事件中的其余 **23 个明确不支持**（配置在解析前被忽略，不会让配置失效）
- `dsh-hooks-codex`：桥接 Codex 方言，支持 **5 个点**（无 `PermissionRequest`、无 `PostToolUseFailure`）

| 维度 | ZCode | DSH |
|---|---|---|
| 架构 | 自有 7 事件协议 | **兼容层 + 原生扩展点**（hook 是桥，拦截面是 waterfall） |
| 配置来源 | `~/.zcode/cli/config.json` 的 `hooks.events`（默认关闭） | **读既有 `hooks.json`**（Claude Code 格式），默认未挂载 |
| 事件数 | 7（含 `PermissionRequest`、`PostToolUseFailure`） | claude-code 桥接 7 个事件名 / codex 桥接 5 个 |
| 扩展点映射 | 未在本次调研中确认 | `SessionStart`→`agent/session-start`；`UserPromptSubmit`+`PreToolUse`→`agent/pre-step`、`tools/pre-execute`；`PostToolUse`→`tools/post-execute`；`Stop`→`agent/turn-stopping`；子代理→`subagent/start\|end` |
| 多 hook 冲突 | 串行、最严格折叠（同 DSH） | **最严格折叠且顺序无关：`deny > ask > allow`** |
| 审计 | 未在本次调研中确认 | **`hook/invoked` 与 `hook/result` 成对落 session 日志且相邻** |
| 输入改写 | `updatedInput` 是**一等能力** | claude-code 侧 `updatedInput` **记录并告警但不生效**（有 `pre-tool-input-rewrite` 提案） |
| 信任模型 | **有**（7 态 + 摘要指纹 + 可撤销） | 本次未在 DSH 侧发现同类态机 `[推断]` |
| 会话开始 | `startup/resume/clear/compact` 四源 | `SessionStartSource` 同四值，但 `clear`/`compact` **保留尚无发出方** |
| 能力边界 | 7 事件均为自有能力 | 明确未支持 Claude Code 30 事件中的 **23 个**（配置在解析前忽略，不会让配置失效） |

`[推断]` **可互相借鉴的两点**：
① ZCode 的**信任态机**适合补到 DSH 的 hook 桥接层（尤其 hook 声明来自项目目录时）；
② DSH 的**最严格折叠 + 成对审计 + 不变式伴生插件**（`ctx.invariants` 拒绝"未开启轮次外追加的 `hook/*` 事件"
这类畸形记录）比 ZCode 更严谨，ZCode 侧可参考。

### 3.4 立刻可做的一件事 `[实测]`

**DSH 的 hooks 能力已在本机，但没有启用**：对 `~/.dsh/**/*.yml` 全量检索 `hooks` / `dsh-hook` **零命中**，
`profiles/web/cordis.yml` 未挂载 hook 插件。也就是说——这是一项**零开发成本的可用能力**，
只差一次 composition 变更（§8 P0）。

两点必须同时理解，否则会用错层：

1. **hook 是兼容层，不是原生机制** `[实测]`：DSH 的原生拦截面是**事件**，且事件有 5 种分发模式
   `emit` / `waterfall` / `parallel` / `serial` / `bail`；`waterfall` 是 around-middleware，
   监听器**必须调 `next()` 委派，不调即短路**。hook 桥接只是把上游方言翻译到这些点上。
2. **回合时序是可枚举的** `[实测]`：
   `turn/start` → `agent/pre-step` → `step/start` → `agent/request` → `llm/stream` → `assistant/message` →
   `tool/call` → `tools/pre-execute` → `tools/execute` → `tools/post-execute` → `tool/result` →
   `step/end` → `agent/turn-stopping` → `turn/end`；
   其中 `turn/*`、`step/*`、消息类与 `tool/*` **落盘**，其余为 live 扩展点。

ZCode 值得对照的是它把 `PermissionRequest` 单列成一个**可被 hook 介入的审批事件**，
而 DSH 的 claude-code 桥接明确不支持该事件（30 个里的 23 个未支持之一）。
`[推断]` 若本仓需要在审批链路上做文章（例如桌面线/双模型线的准入补丁），
**优先走原生事件而非新增 hook 方言**。

---

## 4. 扩展体系与分发

### 4.1 插件清单与组件 `[实测]`

`contracts/src/plugins/index.ts` 的 `PluginManifest` 字段（19 项）：
`name` / `version` / `description` / `author` / `license` / `homepage` / `repository` / `keywords` /
`agents` / `commands` / `skills` / `hooks` / `mcpServers` / `lspServers` / `channels` /
`outputStyles` / `settings` / `dependencies` / `userConfig`。

组件展示分组固定 5 类：`agent` / `command` / `skill` / `hook` / `mcp`（顺序即展示顺序）。

**插件状态** `[实测]`（`PluginConfig`）：`dirs` / `enabled` / `enabledPlugins` /
`extraKnownMarketplaces` / `options` / `suppressedBuiltins`。目录约定
`~/.zcode/cli/plugins/` 下分 `cache/`（市场插件代码）、`data/<plugin-id>/`（插件持久数据）、
`marketplaces/zcode-plugins-official/`（内置 + CDN 分片与合并元数据）。

**变量展开** `[实测]`：`${ZCODE_PLUGIN_ROOT}` / `${ZCODE_PLUGIN_DATA}` / `${ZCODE_PROJECT_DIR}` /
`${user_config.key}` / `${ZCODE_*}`；**仅 `ZCODE_` 前缀的环境变量会被展开**，
缺失变量 → 停用受影响的 MCP server 并产生诊断（不是静默失败）。

### 4.2 市场来源与商店元数据 `[实测]`

`PluginMarketplaceSourceConfig` 支持 **6 种来源**：`url`（可带 headers）/ `github`（可 sparsePaths）/
`git` / `npm` / `file` / `directory`。

商店展示层 `PluginStoreListing` 独立于功能清单（14 个字段）：`displayName` / `displayNameI18n` /
`descriptionI18n` / `icon` / `category` / `author` / `authorUrl` / `homepage` / `privacyPolicy` /
`termsOfService` / `heroImage` / `examplePrompts` / `examplePromptsI18n` / `requiresPaidPlan`。

> `requiresPaidPlan` 的注释值得抄 `[实测]`：它表达"使用条件"，**不代表插件本身是收费商品**，
> 因此不参与安装门禁与计费，且命名不绑定具体套餐名——"套餐改名不会让字段过期"。
> 另有"字段全可选，缺失时 UI 按降级矩阵处理（字母头像 / 隐藏区块 / 省略信息行）"。

### 4.3 诊断码即产品 `[实测]`

`PluginDiagnosticCode` **26 个**，覆盖 manifest/组件/MCP/hook/依赖/市场/变量/重名全链路。
其中几条体现了真实踩坑：

- `plugin_dependency_cross_marketplace`（跨市场依赖）
- `plugin_marketplace_declaration_reserved`（保留字段被占用）
- `plugin_validation_deferred`（延后校验）
- `plugin_ambiguous_name`（名字有歧义）
- `plugin_archive_fetch_failed` / `plugin_git_unavailable`（分发链路失败可归因）

Skill 侧契约 `[实测]`（`contracts/src/skills/index.ts`）：`SkillScope` 4 值
`project` / `user` / `system` / `admin`；`SkillSource` 5 值 `agents` / `zcode` / `bundled` / `plugin` / `remote`
（`agents` 即 `.agents/skills/` 约定，呼应 `.agents Protocol`）；**13 个 Skill 诊断码**；
`SkillMetadata` 带 `qualifiedName`、`safeToAutoLoad`、`frontmatterKeys`、`policy.allowImplicitInvocation`。

### 4.4 与 DSH 的分发对照 `[实测]`

| 维度 | ZCode | DSH（本机现状） |
|---|---|---|
| 分发单位 | 市场条目（zip/git/npm/目录/URL） | **npm 包 + `link:`/`file:` 本地路径** |
| 接入方式 | `.zcode-plugin/plugin.json` 清单 | 包内自带 **`cordis.patch.yml`**；写进 profile `package.json` 的 dependencies 并登记进 `dsh.profile.bundles` 有序列表 |
| 安装入口 | `zcode plugins list/enable/disable` | **`dsh plugin --profile <n> <pnpm args>`**（转发 pnpm） |
| 落盘位置 | `~/.zcode/cli/plugins/{cache,data,marketplaces}` | `~/.dsh/profiles/<profile>/node_modules/` |
| 完整性 | **zip 源强制 sha256（64 位 hex）**，下载后重算比对，不匹配抛错 | 由 npm 完整性机制承担 |
| 官方市场 | 有（`zcode-plugins-official`，内置 + CDN 两分片，含 `featured` 远程策展） | **[未找到]**——vendor 源码与 docs 检索 `marketplace` / `plugin registry` 零命中（0.1.6-alpha.2 的 `ui-plugin-manager` 是 GUI 入口，非注册表） |
| 可卸载内置 | **可卸载并抑制重播种**（`suppressedBuiltins`），状态叫 `Restorable Builtin` | 无对应概念 |
| 领域词汇表 | `CONTEXT.md` 把商店术语（Public/Personal Segment、Installed Strip、Store Listing…）**逐词定义并列出禁用词** | 无 |

DSH 侧实例 `[实测]`：`~/.dsh/profiles/web/node_modules/` 下已有 `@openviking/dsh-memory-plugin`、
`dsh-pet-panel`、`dsh-token-monitor`、`dsh-model-probe`、`@yeesy369/dsh-tool-browser` 等第三方插件包，
每个都自带 `cordis.patch.yml`——**这就是 DSH 事实上的插件市场**，只是缺目录与检索。

`[推断]` **可迁移的是"呈现层"而非"管道"**：ZCode 的 `PluginStoreListing` 字段设计、
26 个诊断码、`CONTEXT.md` 式领域词汇表，可以直接用来给 DSH 的插件加一层目录/描述/检索，
分发仍走 npm。**不建议**为了 ZCode 的 CDN 管道去自建下载与校验体系。

### 4.5 意外收获：两个 harness 都吃 `.agents/skills`（建议立刻利用）

**ZCode** `[实测]`：`SkillSource` 五个取值里第一个就是 **`agents`**，`SkillScope` 分
`project` / `user` / `system` / `admin`；本仓快照里 `.agents/skills/` 下确实躺着 `ai-elements`、
`agent-browser`、`architecture-governance` 三套 skill（共 240+ 文件）。

**DSH** `[实测]`：Skill 是 `<name>/SKILL.md` 目录包或顶层 `<name>.md` 平铺文件 + YAML frontmatter
（必填 `name` / `description`），**嵌套的 `**/SKILL.md` 故意不发现**；发现优先级为

```text
100  项目 .dsh/skills
200  项目 .agents/skills      ← 与 ZCode 同源
300  customSkillDirs
400  <dshHome>/skills
500  <agentsHome>/skills
```

加载走 `ctx.skills` 注册表合并各 provider，`tool-skill` 下发会话目录与 skill 工具，支持 `/name` 直调；
Skill body 每次加载重读，仅**目录发现**靠 watch。

`[推断]` **这是本次调研最具杠杆的一条**：`.agents/skills/` 正在成为跨 harness 的事实约定，
**写一次可以两边用**。对本仓的直接含义是——把各线的"操作手册"（例如：
侧边栏终端两种形态怎么验、桌面线三主题令牌怎么加、本体补丁升级后怎么重打）写成
`.agents/skills/<name>/SKILL.md`，既能被 DSH 会话直接调用，也天然符合 ZCode 的发现规则，
且**这正是本仓当前最缺的"agent 可接手性"**（`apps/zcode-cli/AGENTS.md` 原话：
"agent 友好的项目，留好日志或者接口，让 agent 能完全接手操作"）。

注意 DSH 的两个约束：**必填 `name` + `description` 的 frontmatter**，以及**嵌套不被发现**——
skill 必须放在 `.agents/skills/<name>/SKILL.md` 这一层，不能再往下套目录。

---

## 5. 远程链路（直接对应 `dsh-miasaki-ssh`）

`[实测]` ZCode 的远程把"身份"与"路径"彻底分开，这是本仓 SSH 线最该抄的一条：

**身份契约**（`packages/shared/src/remote-workspace-identity.ts`）：

```text
remote:ssh:<host>:<port>:<username>:<posixPath>
```

- 支持三类远端：`ssh` / `wsl` / `docker`（`AUTHORITY_SEGMENTS`：ssh 占 3 段，其余各 1 段）
- `buildRemoteWorkspaceIdentity` 对 host 做 `trim().toLowerCase()`、port 缺省 22
- host key 指纹带版本前缀：**`ssh:v1`**（`remoteSshHostKey.ts`）
- 环境键：`ssh:<hostkey>`（`remoteEnvironmentKey.ts`）

**身份 vs 路径的分工** `[实测]`（根 `AGENTS.md` 明文）：
`workspaceIdentity` 用于身份隔离，`workspacePath` 用于文件操作 / 命令 cwd / Git / 路径展示；
身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`，适用于去重、绑定、缓存、队列、持久化与请求关联；
且**远程链路必须贯穿传递 `workspaceIdentity` 与 `remoteSessionId`，不得仅按路径匹配**。

**连接生命周期** `[实测]`（`packages/shared/src/channels.ts` 等）：
命令通道 `ConnectRemoteWorkspace` / `CancelRemoteWorkspaceConnect` / `BindRemoteWorkspaceContext` /
`DisposeRemoteWorkspaceSession` / `ListSSHConfigAliases`；
事件 `RemoteWorkspaceConnectionLog` / `RemoteWorkspaceConnected` / `RemoteWorkspaceConnectFailed` /
`RemoteWorkspaceClosed` / `RemoteWorkspaceAcquired`；
连接触发归因 `connectTrigger: "new" | "reconnect" | "restore"`；
错误分类用正则族 `/(connect|network|socket|ssh|wsl|docker|server|timeout|timedout|econn)/`。

**可测性** `[实测]`：`packages/shared/src/test-ids.ts` 为 SSH 对话框定义了完整 test-id 常量族
（`TID_SSH_DIALOG` / `TID_SSH_HOST_INPUT` / `TID_SSH_PORT_INPUT` / `TID_SSH_AUTH_PRIVATE_KEY` /
`TID_SSH_CONNECT_BUTTON` / `TID_SSH_ERROR` / `TID_SSH_SUCCESS` …），说明交互被 E2E 覆盖。

**与 DSH 两侧的远程现状对照** `[实测]`：

- **DSH 本体内建**：`packages/ssh` 四包把**整套执行面**指向远端 POSIX SSH 主机——
  `ctx.ssh`（连接/传输）、`fs-ssh`→`ctx.fs`、`subprocess-ssh`→`ctx.subprocess`、`sandbox-ssh`→`ctx.sandbox`；
  **无 UI**，只服务 headless / 自定义 profile。即官方的"远程"是**能力面整体替换**，正交于 UI。
- **`dsh-miasaki-ssh` 线**：自研不 fork，host 侧 `ssh2@1.17.0` + `ws@8.21.3`，
  前端 `@xterm/xterm@6.0.0` + addon-fit（**无 node-pty**——那是 sidebar 线内嵌终端的技术栈，两条线不同）；
  终端桥走 `ctx.webServer.registerUpgrade('/ssh/ws')`，页面挂官方 `conversation.view`（id `ssh`, order 20），
  入口挂 `conversation.session.header.actions`（id `ssh-view-switch`, order 26）。
  进度：M1 完成，U0/U1/A0 与 D0–D4 共 24 项实机门槛全过，U2.1/U2.3/U2.4 已落地（113 例单测、`verify-all ssh` 12/12），
  U2 实机验收修掉 4 处回归后**待重启复验**；未完成项为 SFTP（U2.2）、U3 跳板/端口转发、
  A1 工具面（待 SPIKE S4）、独立模块化全局面板、`app.js`（1731 行）拆分。

`[推断]` **两者不冲突而是互补**：官方给的是"把执行面搬到远端"，本仓 ssh 线补的是"官方缺失的终端 UI"。
ZCode 的 value-add 在于它把两者**收敛到同一个 workspace 身份**下——这正是本仓 ssh 线目前最缺的一环
（现有实现是 UI 侧连接，尚无"远程 workspace 会话"的统一身份形态）。

**给 `dsh-miasaki-ssh` 的四条** `[推断]`：
① 采用带版本前缀的 identity 契约（`remote:ssh:v1:…`），把"同一台机器的不同路径"与"不同机器的同路径"区分开；
② 连接触发归因（`new`/`reconnect`/`restore`）落到遥测与日志，排查"为什么又连了一次"；
③ 全字段 test-id 常量族，让实机验收可脚本化（该线当前正处于"待重启复验"节点）；
④ 若 U3 之后要做"远程 workspace"，直接对齐 DSH 官方 `workspaceIdentity` / `remoteSessionId` 口径，
**不要自造第二套身份**——与 §2.3 的 "One owner / One path" 是同一条纪律。

---

## 6. 存储路线：SQLite 与追加式事件流的分野 `[实测]`

ZCode `[实测]`：会话存储是 **SQLite + 迁移系统**（`adapters/src/storage/session-store/`）：

- `schema_migration` 表：`id` / `checksum` / `app_version` / `time_applied`
- `migrationChecksum = sha256(sql.trim())`，启动时校验，不一致直接报
  `Historical migrations are immutable; add a new migration instead.`
- 迁移文件按序编号追加（本次快照见到 `0020-provider-model-selection.ts`、`0022-backfilled-session-reasoning.ts`），
  源码注释明写"冻结的数据迁移只生成 SQL；checksum 覆盖最终 SQL"
- 另有 `transcriptVisibility: "visible" | "hidden"` 概念，区分"用户可见 transcript"与
  "provider 可见但不进 transcript"的合成消息（fork / goal / background notice）

DSH `[实测]`：落盘为 `sessions/--<cwd编码>--/<session-id>/session.v3.jsonl.zstd`，**每会话单文件**
（本次实测样本 244,782 B）；默认 zstd 是"**header 一帧 + 每 durable append 批一帧**"的独立 checksum 帧拼接、
**无分片**；`compression: 'none'` 时落纯文本行；**v0–v3 代际并排保留、永不改写**。
关键不变式：**「模型可见 ⟺ 已落盘」**——这也是 Trajectory 能从事件日志直接投影、
而不需要另埋监控数据的原因。

`[推断]` **这是路线差异，不是优劣**。ZCode 选 SQLite 是为了支撑 fork / rewind / checkpoint / 多 session 并发查询；
DSH 的追加式事件流换来的是"模型当时看见了什么"可被逐条还原（第三方评测把 Trajectory 列为 DSH 最受好评的部分）。
**不建议为对标而更换存储**；可借鉴的是 ZCode 的**不可变迁移纪律**（已在 DSH 生态另有对应）与
`transcriptVisibility` 这个**显式的可见性字段**——后者对本仓的双模型线（图片准入）与外观线（会话效果）有参考价值。

---

## 7. 工程纪律与工具链 `[实测]`

### 7.1 工具链选型

`oxlint` + `oxfmt`（Rust 实现的 lint/format，替代 eslint/prettier）、`knip`（未使用依赖与导出）、
`turbo`（任务编排）、`ts-morph` + `typescript ^6.0.2`（架构检查）、`postject`（SEA 注入）、
`release-it` + conventional-changelog（发版）、`husky` + `lint-staged`、`concurrently`、`tsx`。

专用脚本 `[实测]`：`check-workspace-freshness.mjs`（开工前基线检查）、`dependency-graph.mjs`、
`dep-refs.mjs`、`deterministic-tar-archive.mjs`（**确定性打包**）、`count-lines.sh`、
`generate-third-party-notices.mjs` / `licenses.mjs`（第三方声明）、`zcode-distribution-smoke.mjs`。

### 7.2 AGENTS.md 里的硬纪律（本仓可直接抄的条目）

根 `AGENTS.md` 与 `apps/zcode-cli/AGENTS.md` `[实测]`：

- **单文件默认 ≤400 行**，超过必须按高内聚低耦合拆分，"不能用大文件继续堆职责"
- **长程任务优先**：核心 agent loop 默认面向可持续运行的复杂任务，**不用 tool call 次数做硬停止**；
  资源与安全边界交给 token/context 上限自动压缩、用户取消、权限拒绝、工具超时、输出截断、provider 重试上限
- **外部 I/O 边界收敛**：除入口层、基础设施层与 adapter 外，业务模块**不得直接调用** `fetch` / `http` /
  `fs` / `child_process` / `process.env`；子进程统一走执行入口（sandbox、审批、超时、取消、输出截断、退出码归一化）
- **工具副作用显式声明**：`none` / `workspace` / `git` / `network` / `system`，由权限系统、sandbox 与审批读取，
  **不依赖调用点临时猜测**
- **大体积工具结果不回灌上下文**：落盘或进 artifact/storage，只回摘要、预览与可追踪引用
- **traceId 体系**：`traceId` 位于 `sessionId` 之上，`sessionId`/`turnId`/`messageId`/`toolCallId`/`spanId`/`parentSpanId`
  是其结构化子标识；无法关联 `traceId` 的异步行为**视为不可观测行为，应避免引入**
- **错误是一等设计对象**：默认向上冒泡到"真正有能力处理它的层"；底层不调 `process.exit`、不决定退出码
- **配置层级**：system / user / project / session / CLI 参数 / 环境变量，且安全相关配置**要能追踪来源**
- **环境变量克制**：能用配置文件、CLI 参数或 session 配置表达的，优先不做成环境变量（统一 `ZCODE_` 前缀）
- **跨平台默认三平台**：不手写路径分隔符/换行符/临时目录；调外部命令用参数数组形式，避免 shell 字符串拼接

### 7.3 `.agents/skills/` 内嵌"给 agent 读的组件库" `[实测]`

仓库内 `.agents/skills/ai-elements/` 有 **240 个文件**：一份 `SKILL.md` + 约 55 份 `references/*.md`
（每个 UI 元素一份：`agent` / `artifact` / `canvas` / `conversation` / `plan` / `queue` / `sandbox` / `terminal` …）
+ 约 85 个 `scripts/*.tsx` 可运行示例。另有 `agent-browser`（含认证、代理、会话管理、录屏参考与 shell 模板）
与 `architecture-governance`。

`[推断]` 这是把"设计系统"做成 **agent 可消费资产**：agent 不必读 `packages/ui` 的实现，
而是读一份带可运行示例的契约文档。对本仓 canvas / sidebar / appearance 三线的 UI 工作直接有借鉴意义。

### 7.4 生态承接策略 `[实测]`

ZCode 同时展开 `CLAUDE_*` 与 `ZCODE_*` 变量族、`transcript_path`/`transcriptPath` 双写、
hook 事件名与 Claude Code 同名。`[推断]` 这是**降低迁移成本**的产品策略：
让 Claude Code 用户的现有 hook/命令配置尽量不改就能跑——**值得本仓各线在命名与契约上参考**
（例如 SSH 线的配置项命名是否兼容常见 SSH 工具的既有习惯）。

---

## 8. 可迁移设计点清单

优先级：**P0 = 零/低成本立即做**，**P1 = 一次迭代内**，**P2 = 需要设计**。

| # | 设计点 | ZCode 的做法 | 本仓现状 | 落点 | 优先级 |
|---|---|---|---|---|---|
| 1 | **启用 DSH 原生 hooks** | —（由 ZCode 逼出的发现） | 能力已在 `dsh-hook-protocol` 等包中，读既有 `hooks.json` 即可跑；profile 未挂载 | 宿主 composition（**先在测试 profile 试**） | **P0** |
| 2 | **把操作手册写成 `.agents/skills/`** | `.agents/skills/` 是 ZCode 的一等 SkillSource | 本仓无任何 skill；各线操作知识散在 README / `design/` | 仓库根 `.agents/skills/<name>/SKILL.md` | **P0** |
| 3 | 架构策略文件（**先只做地图**） | `architecture-policy.yaml`：module/roots/managed/requires/publicEntrypoints/layers/owner | 有行为回归防线（`verify-all.mjs` + CI L0/L1 + L0–L4 矩阵），**无结构漂移机检** | 仓库根 + `verify-all.mjs` | **P1** |
| 4 | 增量治理 | 存量冻结、新模块从严；`baseline:update` 只由人触发，**CI 不自动刷新基线** | 无基线概念 | 同上 | **P1** |
| 5 | 文件行数预算 | `maxFileLines: 400`，且**禁止加 disable** | 无约束——`dsh-miasaki-ssh/app.js` 已 **1731 行**，正是该规则的靶子 | 仓库根 | **P1** |
| 6 | 分层判据 | `domain`（不许 await）/ `app`（经 port 决定副作用）/ `adapters`（执行）/ `ui`（只依赖 `contract.ts`） | 各线分层口径不一 | `design/` + 策略文件 | **P1** |
| 7 | agent 决策协议 | 8 问 + 7 拒 + 决策记录模板（`ai-guidance.md`） | 有 README/CHANGELOG 纪律，无编码前决策记录 | 各线 `design/`、agent 预设 | **P1** |
| 8 | 远程身份契约 | `remote:ssh:<host>:<port>:<user>:<path>`，identity 与 path 分离 | ssh 线为 `ssh2` + `ws` 自研终端 UI，**无 workspace 身份口径** | ssh 线（U3 之后） | **P1** |
| 9 | 连接生命周期事件 | Connected / ConnectFailed / Closed / Acquired + `connectTrigger` 归因 | 未固化 | ssh 线 | **P1** |
| 10 | 交互 test-id 常量族 | `TID_SSH_*` 全字段，E2E 可脚本化 | ssh 线正处于"待重启复验"节点 | ssh 线 | **P1** |
| 11 | skill 暴露设计系统 | `.agents/skills/ai-elements`（240 文件，元素级参考 + 可运行示例） | 各线 UI 契约散在 README | canvas / sidebar / appearance | **P2** |
| 12 | 商店元数据模型 | `PluginStoreListing` 14 字段，全可选 + 降级矩阵 | 插件仅有 npm 包与各自 README | 插件生态（跨线） | **P2** |
| 13 | 诊断码即产品 | 插件 26 码 / Skill 13 码 / hook 20 reason code，可归因可测 | 各线诊断口径分散 | 跨线 | **P2** |
| 14 | 领域词汇表 | `CONTEXT.md` 逐词定义**并列出禁用词** | `design/CHANGELOG.md` 侧重变更记录 | 各线 `design/` | **P2** |
| 15 | 工具副作用声明 | `none/workspace/git/network/system` 由权限与 sandbox 读取 | 权限策略由宿主统一管理 | 宿主/插件契约 | **P2** |
| 16 | 外部 I/O 边界收敛 | 业务模块不得直调 `fetch`/`fs`/`child_process`/`process.env` | 无成文约束 | 各线 `design/` | **P2** |
| 17 | traceId 体系 | traceId > sessionId > turnId/messageId/toolCallId/spanId | DSH 有 session event log，层级口径未成文 | 跨线 | **P2** |
| 18 | 确定性打包 | `deterministic-tar-archive.mjs` | 打包产物未要求可复现 | desktop / 各线发布 | **P2** |
| 19 | 第三方声明生成 | `generate-third-party-notices.mjs` + `licenses.mjs` | 未系统化 | 发布流程 | **P2** |

---

## 9. 不建议照搬

1. **会话存储换成 SQLite** `[推断]`：DSH 的追加式事件流 + Trajectory 投影是其口碑最好的部分（第三方评测原话：
   "Trajectory 像 Agent 的 DevTools"，且"要求模型看见的内容必须已经记进日志"）。ZCode 的 SQLite 服务于
   fork/rewind/checkpoint 的查询需求，换过去等于丢掉可还原性这一强项。**只借纪律，不换底座。**
2. **Electron 桌面壳** `[推断]`：本仓 desktop 线已是 Tauri 2 薄壳 + 三主题，且桌面壳"让位协议"已落地；
   ZCode 的 Electron 结构（main/host/renderer/preload 四 tsconfig）不值得为此改栈。
3. **一次性对齐 79 万行的治理强度** `[推断]`：ZCode 的 12 条规则、26+13+20 个诊断码是**大规模团队 + 单一产品**
   的产物；本仓七线零耦合、单人主导，直接照搬会变成负担。**取其"增量冻结 + 决策记录"两件，其余按需。**
4. **自建 CDN 插件市场** `[推断]`：npm 已经是本生态的分发底座，自建下载/校验/市场只增加维护面。
5. **`harness/remote/` 的形态** `[实测]`：那只是开发自测容器，不要误读为产品能力。

---

## 10. 复现方式（本次调研的可核查性）

本机 `git clone` 走 schannel 会失败（`schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`），
可用 openssl 后端绕过：

```powershell
git -c http.sslBackend=openssl clone --depth 1 https://github.com/zai-org/ZCode.git _refs/zcode
```

`_refs/` 已被根 `.gitignore:23` 忽略，快照不入库。本次核对的起点文件：

| 主题 | 路径（相对 `_refs/zcode/`） |
|---|---|
| 架构策略 | `architecture-policy.yaml`、`scripts/architecture/policy.mjs` |
| 治理 Skill | `.agents/skills/architecture-governance/SKILL.md`、`references/rule-catalog.md`、`references/ai-guidance.md` |
| hooks 契约 | `apps/zcode-cli/packages/contracts/src/hooks/index.ts`、`workspace-hook-trust.ts` |
| hooks 执行 | `apps/zcode-cli/packages/core/src/tool/executor/hook-flow.ts`、`call-runner.ts` |
| 插件契约 | `apps/zcode-cli/packages/contracts/src/plugins/index.ts` |
| Skill 契约 | `apps/zcode-cli/packages/contracts/src/skills/index.ts` |
| zip 校验 | `apps/zcode-cli/packages/adapters/src/plugins/zip-source.ts`、`marketplace.ts` |
| 远程身份 | `packages/shared/src/remote-workspace-identity.ts`、`remoteSshHostKey.ts`、`channels.ts`、`test-ids.ts` |
| 存储迁移 | `apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts` |
| 工程纪律 | `AGENTS.md`、`apps/zcode-cli/AGENTS.md`、`package.json` |
| 领域词汇 | `CONTEXT.md` |

---

## 11. 下一步建议（供决策）

1. **P0-a｜验证一项已有能力**：在**测试 profile**（`m3-test` 或 `rc7-test`，**不动主力 `web`**）
   挂载 DSH hooks 桥接（`dsh-hooks-claude-code`），指向一份 `hooks.json`，
   用一条 `PreToolUse` 拦截规则验证"能力已在、只是没开"。成本：一次 composition 变更 + 一份配置。
2. **P0-b｜零风险且杠杆最高**：建 `.agents/skills/`，先只写**一条**操作手册进去——
   建议选"本体补丁升级后如何重打并 `verify`"（它同时牵动 desktop 补丁纪律与跨线影响面）——
   确认 DSH 能发现并加载，再把各线操作手册逐步迁入。这条同时满足 ZCode 与 DSH 两边的发现规则（§4.5）。
3. **P1｜起步做地图而非门禁**：为本仓写第一份**最小** `architecture-policy.yaml`——只登记 7 条线的
   `id` / `roots` / `owner`，`managed` 全 `false`，跑通 `report` 看到现状，
   再决定哪条线先 `managed: true`。**先把 `report` 跑出来，再谈规则。**
4. **P1｜并行**：把 §2.3 的"8 个决策问题 + 决策记录模板"落进各线 `design/`，作为 agent 编码前的固定段落。
5. **待定**：是否需要把 ZCode 的**信任态机**补到 DSH hooks（取决于是否会启用"项目级 hook"）；
   若启用，这条从"可选"升级为"必做"。
