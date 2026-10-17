# DSH 0.2.1-rc.2 升级评估与跟进准备（2026-10-17）

- 日期：2026-10-17
- 对象：`@deepseek-ai/dsh` **`0.2.0-rc.2`**（本机现行，npm `latest` 轨）→ **`0.2.1-rc.x`**（npm `next` 轨）
- 上一份同类：[`dsh-0.2.0-rc2-upgrade-assessment-2026-09-29.md`](dsh-0.2.0-rc2-upgrade-assessment-2026-09-29.md)
- 口径：`[实测]` = 本次下载真实产物/拉官方源码/本地跑命令核到；`[推断]` = 基于证据的判断，未做隔离实例实测
- **本文起草于「跟进准备」阶段，尚未执行任何升级或补丁变更** —— 执行状态见 §6。

---

## 0. 摘要

1. **★★★ 版本已冻结，可以准备跟进**。官方 `master` HEAD = `687f282e` = tag `dsh-v0.2.1-rc.2`
   （GitHub Release `2026-10-17T08:16Z` 已发）；**npm 尚未发布 rc.2**（实测 `0.2.1-rc.2` E404，
   `next` 仍指 `0.2.1-rc.1`，后者 `2026-10-17T03:17Z` 已发）。npm 是唯一可装入口，**升级窗口 = rc.2 上架后**。
2. **★★★ 变更量一个数量级于上轮**：`0.2.0-rc.2 → dsh-v0.2.1-rc.2` **1925 个 commit / 8431 文件 / +320,407 −84,704 行**；
   上轮 rc.1→rc.2 仅 187 个 commit。官方为此写了 **36 条迁移指南**（`docs/upgrade-guide/`，其中 `v0.2.1-alpha.1` 独占 24 条）。
3. **★★ 九条线本体：零代码 breaking，1 处预设必须改**。在用官方槽位/API 逐项核到仍存在且签名兼容（§3）；
   唯一硬性改动是桌面预设的 `backgroundMode` 四行（`dsh-tool-subagent` 已删除该键，§4-P0-1）。
4. **★★ 九件本体补丁：8 件零适配，1 件需重写**。对 `0.2.1-rc.1` 真实 npm 产物干跑 `apply`：
   **8 件 `exit=0` 锚点全命中**；`dsh-client-ui-settings-models` **锚点 0 命中**（§5）。
   `dsh-cordis-host-runner` 已于 2026-09-29 退役，本轮失败属预期，不计入。
5. **★★ settings-models 补丁可「乘机缩减」**：官方 0.2.1 **原生新增**了自定义模型 API 的推理等级编辑
   （`ui-settings-models/src/client/ModelReasoningEfforts.tsx`），与本补丁的「思考强度下拉」意图重叠。
   建议重写时**退役重叠部分**，只保留官方没有的「测试连通性 / 能力徽标 / 无 Key 引导」（§5.3）。
6. **★ 会话格式未变，数据安全**：`latestFinalizedVersion: 4` / `latestReleasedVersion: 4`
   （`evidenceTag: dsh-v0.2.0-rc.2`），0.2.1 **未新增 V5、未改 V4**；0.2.0-rc.2 时代的 V4 会话可直接读。
   **反向不保证**（09-30 起 `job/registered`、`job/settled` 为必选事件，旧构建拒收）—— 一旦升到 0.2.1 即不可回退会话数据（§7）。
7. **★ 插件兼容性走 peer 规则，无需豁免**：九线（含 desktop 自身）`peerDependencies` 对官方子包统一为
   `>=0.1.2-rc.1 <0.3.0`，`0.2.1-rc.x` 落在范围内；九线均未声明 `engines.dsh`，按官方 alpha.3 起的新规
   **缺 `engines.dsh` 即回退 peer 检查**，故不被新判据拒绝。`dsh plugin --profile` 用法本仓已全部合规（§4-P2-2）。
8. **★ 官方能力扩张值得单独决策**：0.2.1 起官方内置 SSH helper 运行时、Git Worktrees、Agent Teams、
   侧栏 `sidebar.chat.conversation`（`ui-subagent` 的 sidebar-chat）、CUA 大改、插件市场（含自定义索引源）、
   会话搜索等 —— 与 `ssh` / `fleet` / `sidebar`（辅助对话）/ `desktop`（computer-use）四线存在能力重叠，
   **「跟着升级」与「线的去留」要分开决策**（§3.1、§6-阶段 3）。
9. **★ 本机无模型配置阻塞**：`%USERPROFILE%\.dsh\profiles\*` 中未发现 `llm-deepseek-account.models` 残留
   （官方该项已废弃、残留即停载整组账号模型）；`miasaki`/`web` profile 的 pi-ai 路由 `wxxcx` 等依赖
   `apiKeyEnv`（如 `WXXCX_API_KEY`），凭据缺失时官方新版模型发现会返回**空目录**（预期行为，非故障），升级前宜先确认可用。

---

## 1. rc 线状态与发布节奏 `[实测]`

| 事实 | 值 | 取证 |
|---|---|---|
| 本机全局 dsh | `0.2.0-rc.2` | `dsh --version` |
| npm dist-tags | `latest=0.2.0-rc.2` / `next=0.2.1-rc.1` / `alpha=0.2.1-alpha.5` | `npm view @deepseek-ai/dsh dist-tags` |
| `0.2.1-rc.1` npm 发布时间 | `2026-10-17T03:17:24Z` | npm registry `time` |
| `0.2.1-rc.2` GitHub Release | `2026-10-17T08:16:33Z`（prerelease） | `gh api .../releases` |
| `0.2.1-rc.2` npm | **未发布**（E404，`next` 仍指 rc.1） | `npm view @deepseek-ai/dsh@0.2.1-rc.2` |
| 官方 `master` HEAD | `687f282e` = tag `dsh-v0.2.1-rc.2`（版本冻结） | `git ls-remote` / 本地 shallow clone |
| 官方分支 | 仅 `master`（rc 线 = tag 序列，无独立 rc 分支） | `git ls-remote --heads` |
| 本轮变更量 | 1925 commits / 8431 files / +320,407 −84,704 | `git diff --shortstat dsh-v0.2.0-rc.2 HEAD` |

**发布节奏判读**：rc.1 是「npm 先发（03:17Z）→ GitHub Release 后补（05:22Z）」；rc.2 目前是「Release 已发（08:16Z）→ npm 未跟」。
**rc.2 的 npm 上架时间不可推定**，跟进动作以此为准（§6 阶段 0/1 按 npm 状态分叉）。

---

## 2. 0.2.1 变更总览（官方口径）

### 2.1 Release Notes 要点（`dsh-v0.2.1-rc.1` 社区版说明）

新增功能（与本仓相关的加粗）：

- **插件管理**：自定义插件索引源发现/安装；「让 Agent 创建插件」入口；启停卸更后的依赖同步 + 可热重载插件直接生效；可选插件极简模式、Official 插件按需安装 Claude Code/Codex 组合包（可用于 headless/SDK/ACP profile）。
- **实验性 Session 状态记录接口**（供插件写入/读取自己的会话记录）；**Claude Code Mods 兼容层**；**开发者工具组合包**（会话原始日志、双向定位、内嵌 NodeJS 调试）；**思考过程机器翻译**；**Git Worktrees 插件**。
- **自定义模型 API 支持 UI 配置推理等级**；pi-ai 路由按模型能力处理系统提示词更新、工具动态增删。
- **极简模式支持读取图片与自动压缩**；Web/桌面端 `/compact`。
- **全局指令支持 `DSH_AGENTS_HOME`**。
- **新增 `working_directory` 工具**，TS/Python SDK 提供会话工作目录读取/切换。
- **SSH 新增独立可执行 helper 运行时**（远端文件、进程、终端、沙箱、Node PTC）。
- **Web 版本机 HTTP 访问支持登录 DeepSeek 账号**；**消息中密钥/令牌识别与默认脱敏**。
- 新会话预填未发送提示；工作步骤收起时机设置；Markdown YAML 头部元数据展示。

`dsh-v0.2.1-rc.2`（本次目标）增量主要是：

- 适配 **DeepSeek-V4.1-Flash-1017**（新包 `ui-deepseek-model-label-1017`）；
- 适配 **DeepSeek Search 与 Fetch API**（新包 `web/web-deepseek-api` + `web-search-deepseek` 适配，网页搜索设置中开启）。

> 判读 `[实测]`：`dsh-v0.2.1-rc.1 → dsh-v0.2.1-rc.2` 实际 456 文件 / +4,921 −845（含快照/文档/锁文件），
> 但 **九件补丁目标包源码零改动**（仅 `package.json` 版本行），**九线插件依赖的 8 个 client 包源码同样零改动**；
> 产品面改动集中在上述两个新能力。因此 **§3/§5 基于 rc.1 产物的评估结论对 rc.2 直接成立**，
> 仅建议在 rc.2 产物上做一次无成本复测留痕（§6 阶段 1）。

### 2.2 迁移指南清单（36 条，`docs/upgrade-guide/`）

| 版本目录 | 条数 | 代表条目 |
|---|---|---|
| `v0.1.7-rc.2` | 2 | schedule 可选 bundle、transcript 视图 legacy normal |
| `v0.2.0-rc.2` | 6 | 账号登录错误、内嵌 Python 测试、运行时 invariant 移除、schedule bundle 退役、子路径插件清单 |
| `v0.2.1-alpha.1` | **24** | SSH helper 启动、子智能体激活（`backgroundMode` 删除）、插件选项位置、会话标题适配器、JSONL 持久化插件、job id 身份、指令目录覆盖、mock Messages 事件、Native 子智能体 bundle 工具、插件组合、team 直投收件箱、工具呈现模式、终端命令标签、Web 监听信任配置、working directory |
| `v0.2.1-alpha.2` | 9 | pi-ai 模型发现/Azure provider、凭据优先级、sdk-minimal 图片压缩、账号模型目录、operator connect、插件重装、`--from-default-profile` 覆盖语义、桌面字号快捷键 |
| `v0.2.1-alpha.3` | 1 | **插件兼容性先读 `engines.dsh`**（缺则回退 peer） |
| `v0.2.1-alpha.4` | 1 | 账号通知字段 |

**逐条与本仓的关联判定**见 §3.2 / §4；完整清单以官方目录为准。

### 2.3 持久化变更（`docs/persistence-changes/`，本轮 6 条新增 + 1 条修订）

`2026-09-30-job-session-lifecycle`（**必选事件**，不可回退）、`2026-10-05-ptc-operation-metadata`、
`2026-10-05-working-directory-attribution`、`2026-10-07-title-reasoning-effort`、
`2026-10-13-deepseek-search-thinking`、`2026-10-13-user-rpc-principal`；
`2026-09-16-session-format-v4` 仅说明文字修订，**机器声明零差异**。

- 写入器：`SESSION_FORMAT_VERSION = 4`（`packages/core/session/src/types.ts`）
- 定稿：`latestFinalizedVersion: 4`；发布：`latestReleasedVersion: 4` / `evidenceTag: dsh-v0.2.0-rc.2`
- 结论：**会话格式不动，旧会话可读；升到 0.2.1 后会话数据不可回退到 0.2.0**。

---

## 3. 九条线影响评估

### 3.1 影响矩阵（本体代码）

| 线 | 官方契约依赖（本次逐项核到仍存在/兼容） | 影响 | 需做的动作 |
|---|---|---|---|
| `dsh-miasaki-desktop`（Tauri 壳 + 主题 + 桌宠） | CLI 启动 `--profile … --no-open`；9 件本体补丁；`dsh-client-ui-primitives` 组件 | 壳与启动链**零改**；补丁 1 件需重写 | §4-P0-2 补丁；§4-P1-6 官方桌面端对照 |
| `dsh-miasaki-appearance` | `settings.section`（`kind:list, scope:root` ✓）、`webserver/index-inject` ✓、`ctx.theme` ✓、`--dsw-*` token | 契约兼容；官方本轮**新增字体/字号设置**（正文/代码/终端三套字体与字号） | 升级后回归；可选跟进官方字体能力（非阻塞） |
| `dsh-miasaki-sidebar` | `conversation.content` Factory（`variant:'main'\|'embedded'`、`phase`、`hero` ✓）、`conversation.session`（`{view:'chat'}` ✓）、`sidebar.right.pane.tab` ✓、`sessions.fork` ✓ | 契约兼容（`fork` 仅**新增** `onCreated`/`allowMigration`）；**官方新增 `sidebar.chat.conversation`（ui-subagent sidebar-chat）与本线辅助对话能力重叠** | 升级后回归；线定位决策（§6-阶段 3） |
| `dsh-miasaki-canvas` | `conversation.session.header.actions` ✓、`sessions.fork` ✓ | 兼容 | 升级后回归 |
| `dsh-miasaki-ssh` | `conversation.session.header.actions` / `.header` ✓、`conversation.view` ✓ | 契约兼容；**官方内置 SSH helper 运行时 + `dsh-ssh` 包**（本线自研能力重叠） | 升级后回归；与官方 SSH 的关系决策（§6-阶段 3） |
| `dsh-miasaki-dual-model` | `conversation.input.right` ✓、`sessionProjections.*`（小改）、补丁 `dsh-api-session-controller` | 补丁干跑 **PASS**；`sdk-minimal` 图片压缩为弱相关 | 升级后重打补丁 + 图片准入回归 |
| `dsh-miasaki-usage` | `conversation.view` ✓、`sidebar.footer.action` ✓、`shell.overlay` ✓、`llm`/`session`/`token-meter` 契约 | 契约兼容；`llm-streaming`/`session` 文档有增量变更（新增字段为主） | 升级后回归统计口径（token/模型） |
| `dsh-miasaki-free-model` | `settings.section`（条件注册）✓、`llm` 契约（`listProviders`/`listModels`/`resolveModelInfo`）、上游 `dsh-our-free-model@2.1.0` 补丁 | 受 4 条迁移影响：模型发现空目录语义、pi-ai 凭据前空目录、`azure-openai-responses`→`azure`、账号模型目录（本机未配置该项） | 升级后跑 `patches/dsh-our-free-model` 自检 + 设置页回归；确认 `WXXCX_API_KEY` 等凭据 |
| `dsh-miasaki-fleet` | 无 dsh web 插件依赖；子智能体预设 / `run_in_background` 文档口径 | **预设 `backgroundMode` 必删**（§4-P0-1）；文档口径已过时（代码零依赖） | 改预设 + 文档订正 |

**结论**：九条线**本体代码零 breaking**，无需为升级改任何插件源码；风险集中在「预设配置」与「本体补丁」。

### 3.2 逐条迁移指南判定（仅列与本仓有交集的）

| 迁移条目 | 判定 | 依据 |
|---|---|---|
| `v0.2.1-alpha.1/subagent-activations` | **必改** | `dsh-tool-subagent` 删除 `backgroundMode`/`enableRunInBackground`/`run_in_background`；本仓预设 `agent.base.cordis.yml:190/206/225/234` 仍带 `backgroundMode` `[实测]` |
| `v0.2.1-alpha.1/native-subagent-bundle-tools` | 低风险 | 官方 codex/claude-code bundle 新增全局行并删 `backgroundMode`；本仓预设已有同名手写行，启 bundle 前须先清理，避免撞名 |
| `v0.2.1-alpha.1/plugin-option-placement` | 已合规 | 本仓全部用法均为 `dsh plugin --profile <p> add …`（`--profile` 在 pnpm 参数前） |
| `v0.2.1-alpha.1/instruction-home-override` | 复核 | `dsh-agent-instructions` 删 `dshHome`、统一 `$DSH_HOME`→`~/.dsh`；升级后 `--dump-config` 复核预设该行（本机预设该行仅 `maxBytes`，预测零改） |
| `v0.2.1-alpha.2/deepseek-account-model-catalog` | 本机未命中 | `llm-deepseek-account.models` 已废弃、残留即停载；实测 `profiles/*` 无该配置 |
| `v0.2.1-alpha.2/pi-ai-model-discovery` / `deepseek-model-discovery` | 弱相关 | 凭据缺失时返回空目录（free-model 免 Key 车道/自配来源会「空」，非故障）；本机 `wxxcx` 依赖 `WXXCX_API_KEY` |
| `v0.2.1-alpha.2/pi-ai-azure-provider` | 本机未命中 | 仅 `azure-openai-responses`→`azure` 改名；本机无 azure 路由 |
| `v0.2.1-alpha.3/plugin-engines-dsh` | 兼容 | 九线均无 `engines.dsh`（仅 `engines.node`），按新规回退 peer 检查；peer 范围 `<0.3.0` 覆盖 0.2.1 |
| `v0.2.1-alpha.1/web-listener-trust-config` | 无需改 | `webRuntime`/`web-runtime.trustedHosts` 退役为 `webStartup`；本仓零引用，壳启动只传 `--profile`/`--no-open` |
| `v0.2.1-alpha.2/sdk-minimal-image-compaction` | 弱相关 | `read_image` + 默认自动压缩；dual-model 图片准入升级后实测一次即可 |
| `v0.2.1-alpha.2/operator-connect` | 无需改 | 非页面 Connection 默认 `interactions:'none'`；本仓零命中 |
| `v0.2.1-alpha.1/terminal-command-labels` | 无需改 | `TerminalBlockLabels` 增必填 `commandLine(line)`；本仓零 `TerminalBlock` 使用 |
| 其余（hooks/webhook/Ralph/team/job-id/session-title/jsonl 持久化、`from-default-profile`、插件重装、通知字段、字号快捷键、test auth popup 等） | 无需改 | 本仓零引用或未安装该能力 |

---

## 4. 升级前必办清单

### P0（升级同批必须完成；注意时机，见每条）

1. **删除桌面预设 `backgroundMode`（4 处）** `[实测]`
   - 文件：`dsh-miasaki-desktop/preset-sources/agent.base.cordis.yml:190/206/225/234`
   - **时机：与升级 0.2.1 同批完成，不能提前** —— 该键在 `0.2.0-rc.2` 仍是有效配置（决定子智能体 `continuable`/`one-shot`），
     提前删除会改变当前版本的子智能体行为。
   - 动作：删除这 4 个键（它们是 `dsh-tool-subagent`/`tool-subagent-fork` 行的旧配置）→ 重跑
     `dsh-miasaki-desktop/preset-sources/apply-presets.ps1` → 同步 `verify-presets` 判据 → 更新本线 CHANGELOG。
   - 不做会怎样：0.2.1 的 `dsh-tool-subagent` 拒绝未知配置键，预设对应行加载失败。

2. **`dsh-client-ui-settings-models` 补丁重对齐**（唯一需重写的补丁，见 §5.3）
   - 现状：13 条锚点编辑（#5 双代变体），rc.1 产物上在锚点
     `` }, field)), (0, react_jsx_runtime.jsx)(ModelInputTypes, { `` 处 **0 命中**、apply 中止。
   - 建议：**乘机缩减** —— 官方已原生内置推理等级编辑（`ModelReasoningEfforts.tsx`），
     与本补丁「思考强度下拉」意图重叠；重写时退役重叠部分，只保留「测试连通性 / 能力徽标 / 无 Key 引导」。
   - 判据：`node patch.mjs verify` 全绿 + 在 rc.2 真实产物上 `apply` 成功 + 设置页实机截图。

### P1（升级后 24h 内完成）

3. **九件补丁全部重打 + 自证**：`verify-all.mjs desktop`（patch verify ×8）+ `dsh-miasaki-dual-model` 补丁 verify +
   `patch-live-audit`（目标 patched / 未生效 0 / 未安装 0）。
4. **free-model 上游补丁自检**：`node dsh-miasaki-free-model/patches/dsh-our-free-model/self-test.mjs`，
   并在设置页实机确认「免 Key 车道 / 本机自配平台」两来源仍枚举正常（新版模型发现语义有变，§3.2）。
5. **凭据检查**：确认 `WXXCX_API_KEY`、`STEP_API_KEY`、`OPENROUTER_API_KEY` 等 `apiKeyEnv` 对应凭据可用；
   缺失只会让对应分组「空」，不会报错，容易误判为回归。
6. **官方桌面端对照**：官方桌面端（观察窗口）升级到 0.2.1-rc.2 后，对照 `desktop` profile 的账号模型/登录行为。

### P2（跟进期处理）

7. **`engines.dsh` 决策**：暂不给九线补 `engines.dsh`（保持 peer 规则）；等官方正式切换（新规说「下一版本」生效）
   再统一补，且须覆盖全部支持版本、禁 `workspace:`。
8. **文档订正**：`dsh-miasaki-fleet` 设计文档中 `run_in_background` / `job_output` 口径已过时（代码零依赖）；
   `docs/ENGINEERING.md` 线表按本轮结果补一行。
9. **官方能力重叠评估**（决策项，非升级项）：SSH helper（ssh 线）、Worktrees/Agent Teams（fleet）、
   `sidebar.chat.conversation`（sidebar 辅助对话）、CUA 大改（desktop computer-use）、会话搜索（usage）——
   逐项判断「官方替代 / 差异化保留 / 下线」。

---

## 5. 本体补丁实测（对 `0.2.1-rc.1` 真实 npm 产物干跑）

### 5.1 方法

沿用 2026-09-29 评估的既定手法：`npm pack` 九件目标包（`--cache` 指进 `_refs/`）→ 解包 →
把产物复制到副本目录 → `node <补丁>/patch.mjs apply --target <副本> --yes` → 记录 exit 与产物 SHA。
**只读预检，未触碰本机 live 安装目录**。

### 5.2 结果 `[实测]`

| 补丁 | 线 | rc.1 产物 | 干跑结果 | 判定 |
|---|---|---|---|---|
| `dsh-client-ui-attachment` | desktop | 46,347 B | exit 0，产物 46,458 B / `446D73B6…` | ✅ 零适配 |
| `dsh-client-ui-brand-official` | desktop | 1,863 B（= baseline） | exit 0，产物 3,927 B / `250CAF78…` | ✅ 零适配 |
| `dsh-client-ui-chat` | desktop | 594,185 B | exit 0，产物 596,049 B / `7C933AB6…` | ✅ 零适配 |
| `dsh-client-ui-conversation` | desktop | 774,080 B | exit 0，产物 774,270 B / `5C481C82…` | ✅ 零适配 |
| `dsh-client-ui-sidebar` | desktop | 31,995 B | exit 0，产物 32,089 B / `E5524258…` | ✅ 零适配 |
| `dsh-client-ui-trajectory` | desktop | 398,766 B | exit 0，产物 400,630 B / `E9439E5A…` | ✅ 零适配 |
| `dsh-client-ui-workspace` | desktop | 232,668 B | exit 0，产物 234,379 B / `3A26910C…` | ✅ 零适配 |
| `dsh-api-session-controller` | dual-model | 132,150 B | exit 0，产物 132,895 B / `8A97C9BE…` | ✅ 零适配 |
| **`dsh-client-ui-settings-models`** | desktop | **211,258 B** | **exit 1，锚点 `ModelInputTypes` 0 命中** | 🔴 **需重写** |
| `dsh-cordis-host-runner` | desktop | 104,916 B | exit 1（预期） | ⚪ 已退役，不计入 |

> 注：`baseline` 登记的是 0.2.0-rc.x 原版；本轮 9 件活跃目标包中 **8 件产物有变**（仅 brand-official 逐字节未变），
> 但**锚点上下文均未变** —— 这正是「零适配」的含义：锚点仍唯一命中，只需回填 baseline 与常量。
> **rc.2 已确认这 9 个包的源码零改动**（rc.1→rc.2 只改 `package.json` 版本行），故上表结论对 rc.2 直接成立。

### 5.3 `settings-models` 补丁的缩减依据

- 失效锚点位于官方新结构：`ModelInputTypes` 的渲染点已被官方重排（0.2.1 新增 `ModelReasoningEfforts`、
  `ApiKeyInput`、`CustomProviderCard` 等组件，`ModelListEditor`/`ModelRow` 大改）。
- 官方新能力（`packages/client/ui-settings-models/src/client/ModelReasoningEfforts.tsx`）：
  自定义模型 API 的 `reasoningEfforts` 开关 + 逐级 level/value 编辑 + 校验，语义上**比本补丁的「思考强度下拉」更完整**。
- 因此本补丁建议改为「只补官方缺口」：逐模型测试连通性（host `model-probe` 路由）、能力徽标、无 Key 引导、
  继承值显示；**思考强度下拉若与官方能力重叠则退役**（与 `dsh-cordis-host-runner` 同一处置范式：
  官方吸收后不硬改锚点，避免双写）。

---

## 6. 跟进执行计划

### 阶段 0 —— 现在（npm rc.2 未发，零风险准备）

- [ ] P0-1 删除预设 `backgroundMode` 四行 + 重跑 `apply-presets.ps1` + 同步 `verify-presets` 判据
- [ ] P0-2 起草 `settings-models` 补丁缩减方案（可先基于 rc.1 产物离线重写并 `verify`）
- [ ] 备份：`~/.dsh/profiles/miasaki`、`web`、`desktop` 的 `cordis.patch.yml` 与 `package.json`（升级回滚点）
- [ ] 记录当前全局 dsh 原生文件无锁定（升级前必须退出所有 DSH 进程，见 09-28 死锁前车之鉴）

### 阶段 1 —— npm 发布 `0.2.1-rc.2` 后（在 **web 端**验证，符合「web 端先试社区插件」的分工）

- [ ] `npm i -g @deepseek-ai/dsh@next`（或精确 `@0.2.1-rc.2`），`dsh --version` 确认
- [ ] 对 rc.2 真实产物**复测九件补丁干跑**（预计与 rc.1 结论一致，rc.1→rc.2 仅 ~6 提交）
- [ ] web profile 启动冒烟：九线插件加载（`failed to import loader entry` / 槽位未声明等零报错）
- [ ] `node scripts/verify-all.mjs` 全量（目标：182 项口径 + 本轮新增项；patch verify 与 repo 闸门全绿）

### 阶段 2 —— 修完 P0 后（miasaki 桌面端升级 + 实机验收）

- [ ] 重打 9 件补丁（`apply` + `verify` + `patch-live-audit`）
- [ ] `verify-all.mjs desktop`（含 cargo test）+ dual-model / appearance / sidebar / ssh / usage / free-model 各自闸门
- [ ] 实机走查：设置页模型区（补丁缩减后的功能）、右栏 tab、辅助对话、会话布、SSH 面板、用量浮窗、外观面板
- [ ] 回归矩阵补台账项（建议新增 **E30「0.2.1 升级」**：预设加载 / 补丁命中 / 槽位不失效 / 会话可读 四条判据）

### 阶段 3 —— 跟进期（能力重叠决策）

- [ ] 官方 SSH helper vs `@miasaki/dsh-ssh`：是否 migrate 到官方 provider / 保留自研 / 双轨
- [ ] 官方 `sidebar.chat.conversation` vs sidebar 线辅助对话：去留与差异化
- [ ] 官方 Worktrees / Agent Teams / 会话搜索 vs fleet / usage：按「官方替代优先」评估
- [ ] 官方 CUA 大改 vs desktop `dsh-computer-use`：API 层面跟进（官方 CUA 已有坐标/截图/悬停能力）

---

## 7. 风险与回滚

| 风险 | 等级 | 处置 |
|---|---|---|
| **会话数据不可回退**：0.2.1 起 `job/registered`/`job/settled` 为必选事件，旧构建拒收 | 高 | 升级前备份 `~/.dsh`（至少 sessions 目录）；确认新版可读旧会话后再放弃回滚意图 |
| npm rc.2 迟迟不发 / 发版后再次热修 | 中 | 只在 npm `next` 指向目标版本后升级；不直接装 GitHub 源 |
| `settings-models` 补丁重写引入语法错误 → 整页插件全灭 | 中 | 补丁出口的 `vm.Script` 语法闸门 + 先 on-copy 干跑 + 实机截图 |
| 官方模型发现语义变化导致「模型列表空」被误判为回归 | 中 | 升级前记录各 provider 的 catalog 快照；空目录先查 `apiKeyEnv` 凭据 |
| 官方桌面端 / Web 端行为变化（update channel、字号快捷键、登录） | 低 | 官方桌面端作为对照基准，不阻塞 miasaki |
| 补丁 baseline 常量漂移 | 低 | 统一走 `rebuild-baseline.mjs`/`seal`，逐字节复现后再入册 |

**回滚路径**：`npm i -g @deepseek-ai/dsh@0.2.0-rc.2` + 恢复 profile 备份 + 补丁 `revert`（9 件均有 `.dsh-bak` 机制）；
**会话数据除外**（见上表首行）。

---

## 附：本次取证产物与路径

- 官方源码浅克隆：`_refs/official-dsh-021/`（master = `687f282e` = `dsh-v0.2.1-rc.2`）
- rc.1 真实 npm 产物与干跑副本：`_refs/probe-021rc1/`（九件包 tgz + unpacked + apply 副本）
- 官方 compare 原始数据：`_refs/tmp-021rc2/compare.json`（1925 commits / 300 files 分页）
- 官方迁移指南：`_refs/official-dsh-021/docs/upgrade-guide/`（36 条）
- 会话格式：`_refs/official-dsh-021/docs/session-format-status.zh.md`、`docs/persistence-changes/`
- 槽位契约：`_refs/official-dsh-021/docs/subsystems/slots.zh.md`、`packages/client/*/src/client/contract/`
- 本仓补丁清单与基线：`dsh-miasaki-desktop/patches/`（8 件活跃 + 1 件退役）、`dsh-miasaki-dual-model/patches/`
