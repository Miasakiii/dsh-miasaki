# DS Bot（社区 DSH 多 Agent 插件）可迁移设计点

- 日期：2026-10-12
- 调研者：总指挥（Miasaki 会话）
- 对象：`Fei2411/DeepSeek-Bot`（npm 包 `ds-bot` v0.1.2，2026-10-11 发布），main 分支在线通读
- 本地快照：**无**——本次未克隆，全程 `gh api` 在线读（根目录零落盘）
- 口径：`[实测]` = 在线逐文件读到（含 host 28 模块 / client 51 模块两级 subagent 通读，证据到 `文件:函数` 级）；`[推断]` = 基于实测事实的判断，未实测
- 同类前置：[`dsh-0.2.0-rc2-upgrade-assessment-2026-09-29.md`](dsh-0.2.0-rc2-upgrade-assessment-2026-09-29.md)（本机 DSH 版本基线）、[`dsh-official-repo-review-2026-09-28.md`](dsh-official-repo-review-2026-09-28.md)（DSH 本体评审）
- 本文回答：**ds-bot 有哪些设计值得我们搬**、**哪些明确不搬**、**每一条落在哪条线**、**将来要试用时的事实备忘**

---

## 0. 摘要

1. **它是「纯插件契约能力上限」的探针** `[实测]`：ds-bot 只用官方插件 API（inject 9 个服务、20+ 槽位、21 个 `ctx.tools.register` 工具、2 个 systemPrompt 槽、1 条 HTTP 路由、9 类事件监听），
   实现了多 Agent 团队 / 群聊轮替调度 / 长期记忆 / 上下文管家 / secrets 管理 / 用量统计。它自己的 AGENTS.md 第一条硬规则即「绝不 patch DSH」——
   **本仓桌面线「补丁唯一住处」之外的第三条路（不打补丁也能做到很多）被它实证了**。
2. **最值得搬的五项** `[实测]`：① usage 双口径统计 + 账本可重建（§3.1，落 usage 线）；② 记忆「会话开始冻结快照 + 每轮模型自动 review」（§3.2，落将来任何做记忆的线）；
   ③ `fake-ctx` 注册序冻结 + `node:vm` 校验打包产物两类测试基建（§3.3，落全仓）；④ 上下文 steward「一次决策」condense/handoff 二选一（§3.4，落 desktop 线长对话）；
   ⑤ AUTH 失败抹消息（§3.5，落全仓）。
3. **一个立刻有用的坑备忘** `[实测]`：`ctx.sessionController.selectModel` 会顺带把选择**写成 profile 默认模型**；ds-bot 的解法是先读 `ctx.get('agentDefaultModel').currentSelection()`、选完 `saveSelection(before)` 写回、串行 promise 保序（§3.8）。
   **我方任何线调这个 API 前先读这条**。
4. **明确不搬它的界面路线** `[实测]`：配色以自家 `--bt-*` 为主（834 处引用，只借 6 个 `--dsw-*` 令牌）、表单控件全自绘（官方 primitives 只用 `MarkdownText`/`FishLogo` 两个组件）、
   探测式钩挂官方 DOM（MutationObserver 钩官方 class、`margin-right !important`、`Nothing` 组件遮蔽官方 UI 六类）——**与 2026-09-29「对齐官方设计语言」纪律正相反**（§4）。
5. **兼容性前提** `[实测]`：ds-bot 只在 DSH `0.2.1-alpha.1` 上验证过（作者明言 alpha 期版本敏感）；本机 `0.2.0-rc.2` 差一个预发布版本，试用前先升 DSH（§6）。

---

## 1. 对象与规模 `[实测]`

| 项 | 值（2026-10-12） |
|---|---|
| 仓库 / 许可 | `Fei2411/DeepSeek-Bot` / **Apache-2.0**（NOTICE 列第三方） |
| 描述 | A team of long-lived bots for DeepSeek Harness, with main bots, bot-to-bot messages and group chats |
| Star / Fork | **1,089** / 99 |
| 创建 / 最后推送 | 2026-10-07T15:37Z / 2026-10-12T07:25Z |
| 发布节奏 | 10-10 首发 0.1.0 → 10-11 连发 0.1.1 / 0.1.2，**5 天 3 版**；npm 共 4 个版本（含 `0.0.0-stage`） |
| 验证基线 | DSH `0.2.1-alpha.1`，作者主要在 Linux + DSH Web 测 |
| 代码规模 | host 24 模块 + client 51 模块 + **48 个测试文件**；`client.js` 760 KB（esbuild 产物，入库且 `npm test` 校验与源码一致） |
| 运行时依赖 | **零**（仅 devDependency esbuild）；官方包走 peerDependencies（`cordis`/`dsh-llm`/`dsh-tools`/`dsh-web`） |
| 分发 | npm `ds-bot`；或 `github:Fei2411/DeepSeek-Bot#v0.1.2&path:/ds-bot`；或 Releases 的 tgz |

**架构一句话** `[实测]`：每个 Bot = 「DS Bot」workspace 里的一个 DSH 官方 Session（`bot.id` 永为首个 sessionId，`bot.sessionId` 随分段轮换）；
主管 Bot（Main Bot）持最高权限；群聊的每个成员在群里有**自己的隐藏 Session**（群永远读不到 Bot 的私聊）；全部团队状态单一 `state.json` 原子写。

---

## 2. 注册面速写 `[实测]`

入口 `index.js`：`inject = ['llm','tools','systemPrompt','sessionController','sessions','sessionTitle','workspaceRegistry','connection']`，
apply 构造 `rt` 后按固定顺序 install 24 个 host 模块（**顺序被 `install.test.js` 第一条用例逐字冻结**）。注册产出：

- **21 个工具**：`list_bots / message_bot / interrupt_bot / stop_bot / create_bot / update_bot / list_models / create_group / update_group / delete_group / post_to_group / ask_user / group_relay / read_own_chat / read_group_chat / remember / forget / recall / request_secret / list_secrets / read_browser`（最后一个仅 Desktop profile）
- **2 个提示词槽**：`bot-identity`(order 640)、`bot-memory`(order 645)，均 `interpolate:false`
- **1 条 HTTP 路由**：`POST /api/bot`（客户端唯一通道，约 45 个 endpoint；`state` 走 1.5s/10s 轮询）
- **9 类事件监听**：`session/event`、`llm/stream` ×5、`agent/created`、`agent/status`、`agent/pre-step`、`agent/request-error`、`tools/execute`、`llm/adapters-updated`
- **client 半**：`inject ['sessions','uiWorkspace','uiConversation','slots','theme','layout','configForms']` + `shortcuts`/`inputTriggers`/`locale`；esbuild 打包 external `react/react-dom/primitives`，`window.__ModuleLoader__.load` 挂载

对官方服务的调用以**只读消费**为主（`llm.listProviders/listModels/stream`、`sessionController.projections/page`、`tokenMeter.measure`、`permissionPresets`、`pluginManager`）；
写入集中在「注册」与 `sessionController.create/selectModel`、`sessions.flush`、`workspaceRegistry`、`agent.followup/steer`。

---

## 3. 可搬设计清单

### 3.1 usage 双口径统计 + 账本可重建 → 落 `dsh-miasaki-usage` `[实测]`

- **设计**：会话内请求 = `sessionController.list/projections/page` 分页读事件，`foldCalls` 按 DSH 同口径折叠成「每次计费尝试一行」
  （折叠点：`request/header`、`assistant/message`、`assistant/attempt`、`llm/retry-started`、fork 的 `session/end-seed` reset）；
  会话外请求（记忆摘要 / 读图 / compaction / steward / 标题）由 `llm/stream` 监听器在流式过程中打表（`tagUsage` 标归属）。
- **存储**：`usage.sqlite`（`node:sqlite`，WAL，calls/marks/owners/kinds 四表；**无 sqlite 时降级内存账本**）。**删除可从会话日志重建**，只丢「日志外的调用」与被删 Bot 的名字。
- **对我方价值** `[推断]`：usage 线当前走官方 `tokenMeter` 契约——ds-bot 是**第二套独立口径**，两套对不上时正是发现口径分歧的契机；
  且它实证了「折叠规则逐字对齐 DSH 官方账本」在插件侧可行（含 fork reset 这种边角）。
- **落地判据**：若要借鉴，先拿我方现有账本与它的 `usage.sqlite` 对同一会话逐日 diff，**差异归因清楚再动手**，不要直接换口径。

### 3.2 记忆「冻结快照 + 每轮自动 review」 → 落将来任何做记忆的线 `[实测]`

- **格式**：Agent Memory Repo Markdown——一行一条 bullet、行尾 `[key: value; …]` 元数据，`MEMORY.md` 的 `## Index` 列 `[[topic]]`，详情进 topic 文件。
- **冻结**：两份 MEMORY.md（Bot 私有 + 团队共享）经 `systemPrompt.section` 注入时，按 session **冻结快照**到 `snapshots/<id>.md`；新 part 或 checkpoint 后 `renewMemory` 重冻结。
  **prompt cache 与记忆鲜度兼得**——变更从下一段/下一个 checkpoint 生效，`recall` 可立即查到。
- **自动 review**：每轮 idle 后 2s，小模型读本轮新增内容自行 keep/update/remove（`agent/status` → `queueReview` → `reviewSession` → `applyReview`）；
  **每轮最多 8 条变更、最多 4 pass**；不依赖 Bot 自觉调 `remember`。
- **安全与容量**：`looksSecret`/`KEY_PATTERNS` 正则拒绝密钥入记忆；容量硬上限（entry 300 / main 4000 / topic 16000 / topics 40），**超限即报错要求先腾挪**（不静默截断）；
  `journal.jsonl` 记每次变更前后行；删 Bot 时记忆整体移入 `archive/`。
- **落地判据**：`[推断]` 我方若做预设记忆（桌宠人设已有人设源文件），照抄「冻结 + 自动 review + 硬上限报错」三件套；「记忆是数据不是指令」的防注入提示词一并照抄。

### 3.3 两类测试基建 → 落全仓 `[实测]`

1. **注册序冻结**：`test/fake-ctx.js` 是「记录注册顺序」的假 ctx（记 `calls/listeners/sections/registeredTools`，effect 立即执行并收集 disposer，emit 只跑非中间件监听器）；
   `install.test.js` 第一条用例把 apply 全过程的 effect/监听/路由顺序**逐字冻结**——模块安装顺序被无意调整时立刻红灯。
2. **打包产物一致性**：`client-bundle.test.js` 用 `node:vm runInNewContext` 加载 `client.js`，校验它与 `src/client` 构建一致且 factory 导出 `apply/inject`——**「改了源码忘了 build」变成测试红灯**，且不需要浏览器。
- **对我方价值** `[推断]`：本仓 appearance/canvas/sidebar/free-model 等线均有 `client.js` 类生成物，目前无「产物新鲜度」闸门；`fake-ctx` 模式可直接搬到任何注册官方槽位/工具的线
  （尤其 free-model 的条件注册、sidebar 的 tab 注册）。

### 3.4 上下文 steward「一次决策」 → 落 desktop 线长对话 `[实测]`

- **设计**：双线——可用窗口 = 模型 `contextWindow` − 回复 reserve，**硬线 95%**，检查线 `checkRatio`（默认 0.8）；一轮结束越线时，**一次**小模型调用读最新消息后二选一：
  - 工作仍在进行 → 原地浓缩成 checkpoint（handoff 摘要 + **用户近期原话逐字保留**）；
  - 已到 stopping point → 写 8 段式 handoff note，开新 part 继续。
- **用户侧零痕**：不插标记；旧 part 归档但进 FTS5 索引（`chat-index.sqlite`，trigram）可由 `read_own_chat` 检索。DSH 自带 compaction 在 Bot 会话上被完全替换。
- **模型没有 `contextWindow` 时的兜底**：取适配器默认（`llm-pi-ai` 262,144），完全没报告的按 500,000。
- **落地判据** `[推断]`：与 miasaki 桌宠/长时任务线做「长会话不爆窗」时照抄「一次决策 + 用户原话逐字 + 无痕」；**它用运行时包装 compaction 引擎（`adoptEngine`，可逆）属灰区，我方若不需要完全替换 compaction 就不要学这步**。

### 3.5 AUTH 失败抹消息 → 落全仓 `[实测]`

`turns.js turnFailure` 对 AUTH 类失败**抹掉消息文本**（防 provider 在错误里回显 key），只留分类与 stack 进 diagnostics。
- **对我方价值** `[推断]`：dual-model（多 provider 路由）与 free-model（多来源聚合）两条线**多 provider 混跑**，错误回显 key 的面比单 provider 大；诊断输出前统一脱敏应成为全仓约定。

### 3.6 state.lock 单写者 → 落桌面端 + web 双端共用 home 的场景 `[实测]`

`bot/state.lock` 记 pid+host+token，**15s 心跳、60s 过期**；持锁者写，另一实例全站只读（channel 层 `READS` 白名单）并提示「open in another dsh」，前者退出后后者下一请求接管。
- **对我方价值** `[推断]`：usage 线账本按 profile 分区、appearance 配置自管 `~/.dsh/...`——**桌面壳与 web 同时跑的场景下都面临双写者**；这套「锁 + 只读降级 + 退出接管」可直接搬。

### 3.7 secrets 双重掩码 + shellEnv scope 注入 → 落 desktop 线 `[实测]`

- 值只落 `<home>/secrets.json`（mode 600，tmp+rename 原子写；**state.json 与日志里绝无值**）；Bot 只能以 `$DSH_SECRET_<NAME>` 经 `shellEnv.register` + `resolveEnv` 按 scope（all / bot id 列表）取用。
- **双点掩码**：`tools/execute` 监听器掩码工具结果、`llm/stream` 监听器掩码出站请求——`redactDeep` 在值离开进程前替换为 `[secret:NAME]`。
- **它自认的限制**（我方若做要更进一步或明示）：Windows 上文件 mode 无效（只靠用户目录）；只掩码**精确副本**（编码/拆分/反转可绕过）；非 HTTPS 页面明文传输（卡片会警告）。
- **配套细节**：≥8 字符的值全量掩码，更短的只在「无字母数字相邻」处掩码（普通单词不误伤）；卡片字段不进 form、不 autofill；删 Bot 时从所有 secret 的允许列表移除。

### 3.8 `selectModel` 污染 profile 默认模型的坑 → 落任何调 `sessionController.selectModel` 的线 `[实测]`

`ctx.sessionController.selectModel` 在 DSH 里**会顺带改写 profile 的默认模型**。ds-bot 的解法：
`ctx.get('agentDefaultModel').currentSelection()` 先读 → 选模型 → `saveSelection(before)` 写回 → **串行 promise 保提交顺序**。
- **对我方价值** `[推断]`：这是「调一个官方 API 顺手改了用户全局配置」的典型坑，功能测试抓不到（表现为「设完某 bot 的模型，默认模型变了」）。已实测存在，**用前先读**。

### 3.9 bot 间消息与群聊的工程约束 → 落 fleet 线（活对照） `[实测]`

- **消息路由**：发送 = `message_bot` 工具 → `rt.deliver` 只负责「写入目标 Session」（构造 `kind:'bot'` 的 source，`agent.steer` 插入或 `agent.followup` + `sessions.flush`）；
  应答路由在 `turns.js`：`turn/start` 时 `claimTrigger` 记 source，`turn/end` 时 `expectsReply(info) && !answersUser(info)` 把回复回投给发送方（hop+1、replyTo 关联）。
- **约束**：`MAX_HOPS=6` 防环；`state.exchanges` 截到 600；隐藏轮次记 `exchangeTurns`（上限 400）且 UI 不渲染；**失败/中止也回送说明**——发送方永不永久等待。
- **群聊轮替**：`runRound` 一人一轮、240s 超时；@mention > admin 独答 > 全员跟；每成员每轮上限 2 轮（admin 4），`@all` 仅 admin；`[PASS]`/空回复记 passed，模型失败记 failed 继续；
  新成员看最近 12 行 + 本轮前 8 行上文，之后增量最多 24 行；bot 自发轮上限 3（用户再发言清零）。
- **对我方价值** `[推断]`：fleet 线自建 CLI 编排，ds-bot 是「全塞进官方会话模型」的另一路线——**hop 上限 / 失败必回 / 增量投喂 / PASS 静默**这四个约束与编排框架无关，可直接借鉴。

### 3.10 错误分级与 diagnostics → 落全仓 `[实测]`

`channel.js errorCode`：TypeError/ReferenceError/RangeError/SyntaxError/E* → `bot/internal`（带 stack），其余 → `bot/refused`（消息面向用户）。
`rt.warn` 统一进 diagnostics：内存 200 条 + `<home>/logs/diagnostics.jsonl`（1MB 轮转），**报告输出前再脱敏一次**（key/token/secret/home 路径移除）。
- **落地判据**：`[推断]` 与 §3.5 合并成一条全仓约定——「内部错误带栈、用户错误无栈、任何出舱文本过脱敏」。

### 3.11 其他值得一看的小设计 `[实测]`

- **i18n 零自建存储**：英文原文即 key + 单部中文词典，语言跟随官方 `locale` active 值，官方缺席保持英文；host 错误用正则表 + 翻译表回译。
- **模型目录 10s TTL 缓存** + 模型按 provider 分组防同名混淆（provider 显示名相同则显示 provider id）。
- **每 Bot 一个 Electron webview + 独立 storage partition**（`bot:<id>`，cookie 不跨 Bot；最多 6 活渲染进程 LRU；屏蔽云元数据地址）——仅 Desktop，桌宠线若做内嵌浏览器可参考其分区与限额设计。
- **21 个 SVG 三层 path 角色 + 8 状态动画 + 眼睛跟随指针**，默认形象由 bot id 哈希跨设备一致——桌宠线的「形象一致性」可参考此哈希思路。

---

## 4. 明确不搬

1. **界面自建设计语言** `[实测]`：`--bt-*` 自家令牌 834 处、只借 6 个 `--dsw-*`；Switch/Segmented/Menu/Input/Checkbox 全自绘（`role=switch` 的 button、原生 select），官方 primitives 只用 `MarkdownText`/`FishLogo`。
   **违背 2026-09-29 纪律**（控件一律官方 primitives、配色只走 `--dsw-*`、并排看要像官方一家）。功能测试抓不到这类问题，**不要因为「它这么做且很流行」就跟着做**。
2. **探测式钩挂官方 DOM** `[实测]`：MutationObserver 钩 `[data-chat-flow]`/`[class*="_toBottomSlot"]`、动态改官方会话列 `margin-right !important`、`Nothing` 组件遮蔽官方 UI 六类（模型选择器/权限/计划/活动 dock/用量 dock/Transcript view 行）、`holdFlatTranscript` 强制官方表单值、`AccountLauncher priority -10` 抢占 `settings.launcher`。
   DSH 一改官方类名/结构就碎——**与「对齐官方设计语言」和本仓补丁纪律双背**。
3. **上帝函数与巨型 CSS 模板** `[实测]`：`apply(ctx)` 约 700 行单函数 + actions 巨对象约 200 行；两段约 950 行 CSS 模板字符串。模块划分本身清晰（51 文件按区域+横切关注点），**学它的划分，别学它的单点堆积**。
4. **运行时包装 compaction 引擎** `[实测]`：`adoptEngine` 把 compaction 引擎的 summarize 换成自己的 `writeCheckpoint`（可逆）。属插件 API 内的灰区——**除非确有必要完全接管 compaction，否则不学**。
5. **secrets 不加密只掩码** `[实测]`：它自认的限制（见 §3.7）。我方若做同类能力，要么上系统钥匙串，要么在文档里明示局限，**不要照抄「只掩码」就当安全**。

---

## 5. 对我方各线的影响与待办

| 线 | 影响 | 待办（排期待用户拍板） |
|---|---|---|
| `dsh-miasaki-usage` | 多了一套独立口径可交叉验证；「删库可从日志重建」设计可借鉴 | 选一个会话拿两套口径对 diff，归因差异 |
| `dsh-miasaki-fleet` | 群聊/消息路由的活对照样本；hop 上限/失败必回/增量投喂可直接借鉴 | 评审现有编排是否缺「失败必回」与「防环」 |
| `dsh-miasaki-desktop` | selectModel 污染坑（§3.8）；长对话 steward（§3.4）；secrets 掩码（§3.7）；state.lock（§3.6） | 排查桌面线是否调过 selectModel；长时任务线评估 steward |
| 全仓 | fake-ctx / client-bundle 两类测试基建（§3.3）；AUTH 抹消息 + 错误分级（§3.5/§3.10） | 挑一条线试点 fake-ctx；产物新鲜度闸门排期 |

---

## 6. 事实备忘（将来试用时直接用）

- **兼容前提**：ds-bot 0.1.2 只在 DSH `0.2.1-alpha.1` 验证（作者明言「DSH 是 alpha，新版可能弄坏插件」）；本机基线 `0.2.0-rc.2`，**先升 DSH 再装**。
- **安装**：DSH Desktop 插件面板输 `ds-bot`（国内设镜像源）；或 `dsh plugin --profile web add ds-bot`；或 `github:Fei2411/DeepSeek-Bot#v0.1.2&path:/ds-bot`（需 Git）。
- **数据**：全部在 `~/.dsh/bot/`（`state.json`/`state.lock`/`secrets.json`/`usage.sqlite`/`chat-index.sqlite`/`memory/`/`logs/`/`workspace/`）+ `~/.dsh/sessions/`；**卸载插件不删数据**；备份 =  quit DSH 后整拷 `~/.dsh`。
- **已知坑（作者自报）**：群聊费 token（每成员各读一遍群）；Windows 上 secrets 只靠用户目录保护；同 home 单写者；bot 浏览器仅 Desktop 且只读（不能点击/输入）；legacy 包名 `dsh-bot` 需先卸载（共用插件 id `bot`）。
- **按仓规的试用路径**：社区插件先落 web 端试验，验证可行再进 miasaki 桌面端。

---

## 7. 来源

- 仓库：https://github.com/Fei2411/DeepSeek-Bot （README / ds-bot/README.md / CHANGELOG.md / AGENTS.md / cordis.patch.yml 及 host、client 全部源码，2026-10-12 在线通读）
- npm：`ds-bot` 版本历史 0.0.0-stage → 0.1.2（2026-10-10 … 10-11）
