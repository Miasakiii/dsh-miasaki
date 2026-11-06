# dsh-context 插件机制调研：第三方 DSH 上下文可视化插件的架构、契约面与可借鉴项

- 日期：2026-11-04
- 调研者：context-scout（Lead 分派，单一执行者）
- 对象：`bowenliang123/dsh-context` v0.81.0（npm `dsh-context@0.81.0`，Apache-2.0，GitHub 4,098 star）。本地快照 commit `22929e7`（`chore(recoms): update Zilliz Cloud`，2026-11-04 11:48 +0800，晚于 v0.81.0 发布约 3.7 小时）
- 本地快照：`_refs/tmp-dsh-context/`（`git clone --depth 1`，gitignored、**不入库**；按要求保留供 Lead 复核）
- 本机状态：内核 `@deepseek-ai/dsh` **0.2.1-rc.5**；web profile 已装 `dsh-context@0.81.0`（`dependencies` 与 `dsh.profile.bundles` 两项均在，`node_modules/dsh-context/lib/` 三件产物齐全）——**安装与试用由 Lead 负责，本文不复核运行效果**（实机验证补记见 §八，Lead 追加）
- 口径：`[实测]` = 逐文件读盘/命令实测（证据到 `文件:行号` 或导出符号）；`[推断]` = 基于实测的判断，未实跑验证；`[存疑]` = 与声明/文档不一致或本次未复核
- 体量 `[实测]`：`src/` 28,290 行（host 5,008 / client 21,510 / shared 1,772；文件数 32/126/11）；`tests/` 44,554 行、192 个 spec；入库文件 474 个。npm 产物 824,976 B / 10 文件，其中 `lib/client.js` 656,504 B、`lib/index.js` 111,041 B
- **取证边界（重要）**：只做**只读源码调研**——未 `pnpm install`、未构建、未在浏览器里操作插件；凡「运行时表现」类结论一律标 `[推断]`。官方契约存在性另用本机 0.2.1-rc.5 安装闭包逐项核对（§3.5）
- 姊妹文档分工：本文回答「它有哪些机制、值不值得借鉴到我们九线」；与 `dsh-miasaki-shared-docs/dsh-platform/ref-dsh-superagent-mechanics-2026-11-02.md` 同属 `dsh-platform/` 第三方/官方实现机制解读，不重复其内容（该文调研时点尚未入库，故此处用行内路径而非相对链接）

> **路径约定**：本文 `src/…` `tests/…` `docs/…` 等一律相对本地快照 `_refs/tmp-dsh-context/`。该目录不入库，故**刻意不用 markdown 相对链接**（否则 `repo/md-links` 的「目标已入库」判据会红），只用行内代码路径；只在引用本仓已入库文件时才用 markdown 链接。

---

## 一、结论摘要

1. **它不是「一个面板」，而是一套上下文投影与可视化子系统**：28,290 行 TypeScript、3 个自注册投影单元、8 条自有 POST 路由、8 个客户端槽位名（9 处注册）、1 条 `/context` 斜杠命令、1 个提示词注入点（两个 section）；npm 包 220 KB，但客户端 bundle 是 641 KB 的 minified 单文件。
2. **标准 Cordis 双半插件**：host 半 `lib/index.js` 导出 `name / inject: ['sessionProjections'] / apply / Config`，靠 `cordis.patch.yml` 作为 bundle 行插入；client 半 `lib/client.js` 是给 `window.__ModuleLoader__` 的 CJS 经典脚本；仓库内**不含 `lib/`**，必须 `pnpm run build`（tsdown）出产物。
3. **契约面以官方服务 + 可选注入为主**：host 用 `sessionProjections / connection / sessions / sessionQuery / sessionPersistence / sessionProjectionCache / storageDomain / systemPrompt / settings / llm / credentials / skills / agentPresets / attachments`，client 用 8 个槽位 + `configForms / sidebarRightTabs / sidebarRight / inputTriggers / uiWorkspace / uiConversation / remote.session / pluginNavigation`；**本机 0.2.1-rc.5 闭包逐项核对全部存在** `[实测]`。
4. **但有四类「未文档化的内部结构」依赖**：会话事件形状（`fold.ts` 对 20+ `event.type` 做 switch）、`storageDomain('session_projcache')` 表结构、`ctx.on('internal/get')` + `Symbol.for('cordis.original')` + 打补丁 `tools.register`、以及 10 个官方 `data-*` DOM 标记（含按标签文本点击 `button[role="tab"]`）。这是它升级内核时真正的脆弱面。
5. **数据管线是「缓存只存头、明细按需从持久日志重算、revision 门控」**：head-only 投影（`stateVersion` 37）、detail 路由 4 条 payload 缓存、客户端 DetailStore（300 ms 防抖 / 首读 16 ms / 1 s 追平 / 指数退避 / 8 个 6 MB 预算）、shadow fold LRU 8 + 512 事件缓冲、冷读堆水位 2/3 的 FIFO 闸门、启动回填分片（2,000 事件/片、8 s 工作预算 + 2 s 休息）。
6. **Token 计量不另起一套：占用率与组成锚定官方投影**——同一钻取源（`contextPressure` / `contextBreakdown` / `tokenUsage`），组成按官方总量等比重标定，所以与输入框环形图数值一致；**估算密度镜像**官方 token-meter（chars/4 + 固定开销），**只有成本是自算**：models.dev 价本 + DeepSeek 峰谷 2× + 人民币 0.15 折算 + 未定价显式声明。
7. **Fleet 面：任务板读官方 `agentTeam` 投影**（`props.useProjection` / 会话行 `projectionValues`），血缘读会话列表行 `origin === 'subagent'` + `parentId`；通讯与结算记录是**自己从持久日志折叠**（含六种英文结算文案匹配）；实时性 = 官方快照订阅 + 120 ms 合并，**`src/` 内零 `setInterval`**。
8. **设置卡在 Plugins 页是官方机制**：host `Config`（schemastery）+ bundle patch → 官方 Plugins 页渲染该 bundle 的 Config 表单；client 只往 `plugins.bundle.config` 槽注册自定义卡，并用 `configForms.whileServed([ns])` 门控。**System Prompt 前缀/后缀**走 `systemPrompt.section()` + `getSectionOrder` 锚点（`HARNESS_IDENTITY − 1000` / `DEPLOYMENT_PERSONA_SUFFIX + 1000`），空文本返回 `''`、`interpolate: false`、对所有 Agent 生效。
9. **i18n 是扁平 TS 字典 + 编译期键对齐**：zh 字典导出 `DictKey`，en 用 `satisfies Record<DictKey, string>`，再加占位符对账测试；**主题以 `--dsw-*` 令牌为主**（34 个令牌 / 21 个 CSS 文件），硬编码色集中在「查找高亮」与「推广卡」；设计语言部分对齐官方（用官方 `Menu`/`Tooltip`/`StateDot`/`MarkdownText`/`JsonTree`），但分段控件、搜索框、多处行样式是自研。
10. **工程质量是它最值得抄的部分**：192 个 spec / 约 1,977 例、**100% per-file 覆盖率门槛**、3 个 vitest project、兼容性矩阵 staging **真实 dsh 源码**、worktree 指纹 stamp 的 pre-commit 闸门、客户端 bundle 纯净度构建闸门、`tag == version` + npm OIDC 发布。我们可低成本抄的是「i18n 对账测试」与「窗口化 hooks」，不是它的产品面。

---

## 二、插件能力面（五入口 + 设置）

同一份 `ContextView` 组件按摆放位置复用（`tab` / `sidebar` 两种 `host`），Fleet 是独立视图。五个入口 + 一张设置卡 `[实测]`：

| 入口 | 落点（官方槽位 / 触发） | 提供什么 | 数据来源 |
| --- | --- | --- | --- |
| **上下文洞察页面** | `main` + `sidebar.panellist`（一级侧栏面板，与 Plugins 同级）`src/client/insightPage.ts:23-31` | KPI 栏（计费 Token / 成本 / 缓存命中 / 轮次）、7 天成对柱、8 周热力图、技能/工具/命令三个 tally、组成环形、会话卡片列表（排序/搜索/分组/跳转） | 官方会话列表快照（`props.useSessions`/`useWorkspaces`）+ 各会话 `contextActivity` 投影 + 自身 `contextTimeline` head |
| **Context 标签页** | `conversation.view`（id=`context`，order 20）`src/client/index.ts:65-68` | 9 张卡：Context Stats、Token Stats、Timing Stats、Current Context（堆叠条+压缩预留斜纹）、Context Trend（step/turn × total/delta × DNA/Adaptive/Overview/时长曲线）、Context Browser、Context Events、File Activity、Command Executions、Agent Network（仅侧栏形态） | `contextTimeline`（自建）+ `contextHeaders`（自建）+ 官方 `contextPressure/contextBreakdown/tokenUsage` + detail 路由 + `remote.session.page` 懒取内容 |
| **Fleet 标签页** | `conversation.view`（id=`fleet`，order 30）`src/client/fleetTab.ts:18-21` | Mission Pulse：Agent 网络树 + 跨 Agent 协作车道上一条时间线 + 工作队列（团队任务与子 Agent 派发合一）+ 通讯记录 + 事件检视 | 会话列表快照（血缘、`agentTeam` 投影）+ 各节点 detail 路由 + `sessions.refreshSubagents` + head 路由（跨会话 `contextTimeline`） |
| **右侧 Sidebar Context 面板** | `sidebar.right.pane.tab` + `.title` + `sidebarRightTabs.register` `src/client/sidebar.ts:17-55` | 与 Context 标签页同一仪表板（`host='sidebar'`），额外内嵌 Agent 网络；受 `tab.visible` 门控 | 同上；`useTabInfo` 不可用时回退 IntersectionObserver `src/client/components/contextView.tsx:880-891` |
| **`/context` 命令** | `inputTriggers.registerSource`（trigger `/`，order 1）`src/client/command.ts:9-41`；弹窗落 `conversation.input.overlay` `src/client/index.ts:90-99` | 居中弹窗：Current Composition + Context Browser（不离开聊天） | 同 Context 标签页 |
| **设置卡（Preferences）** | host `Config` + bundle patch → 官方 Plugins 页 Config 表单；client 卡落 `plugins.bundle.config`（`key` = namespace）`src/client/index.ts:118-132` | 摆放位置（tab/sidebar/both/hide）、洞察页入口、Fleet 开关、趋势默认值、排序默认值、洞察页时间范围、**System Prompt 前缀/后缀** | 官方 `configForms` 设置作用域（`getSnapshot`/`subscribe`/`set`）`src/client/settings.ts:9-18` |
| （辅助）回复行跳转按钮 | `conversation.chat.assistant-actions`（id=`context-jump`，order 20）`src/client/index.ts:80-86` | 从任意助手回复打开 Context（优先右栏，回退激活 tag） | `src/client/components/contextJump.tsx:58` |

> 口径澄清：README 的「五种入口」= 洞察页 / Context tab / Fleet tab / `/context` / 设置卡；右侧 Sidebar 面板是同一 Context 视图的第二个摆放位置（`placement` 设置里的 `sidebar`），不单独计一口。README 表格见 `README.md:52-60`。

---

## 三、架构与契约面

### 3.1 host / client 双半拆分

| 维度 | host 半 | client 半 |
| --- | --- | --- |
| 入口文件 | `src/host/index.ts` | `src/client/index.ts` |
| 产物 / 格式 | `lib/index.js`（ESM，node，minified 111,041 B）+ `lib/index.d.ts` | `lib/client.js`（**CJS 经典脚本**，641 KB minified，`window.__ModuleLoader__.load({id, factory})` 包裹） |
| 导出契约 | `name: 'dsh-context'`、`inject: ['sessionProjections']`、`apply(ctx, config)`、`Config` `[实测]`（`src/host/index.ts:23-28`；发布产物尾部 `export{En as Config,uo as apply,lo as inject,co as name}`） | `module.exports = { name, inject: ['slots','locale'], apply }`（`src/client/index.ts:135-139`） |
| bundle 声明 | `package.json` 的 `dsh.bundle.patch: "./cordis.patch.yml"`；patch 只有一行 `insert`，id/name 均为 `dsh-context`（`cordis.patch.yml:1-6`） | `dsh.client.inject` 声明 6 个必须先就绪的客户端包（remotes / connection / locale / ui-conversation / ui-settings / ui-sidebar-right），`platform: "web"`（`package.json:60-70`） |
| 依赖声明 | 运行时 `dependencies` 仅 `zod 4.4.3`；`peerDependencies` = cordis / dsh-session / schemastery / primitives（optional）/ react（optional）（`package.json:89-110`） | 与 host 共用同一 package.json；构建期把除平台模块外的所有依赖内联 |
| 构建 | 必须构建：仓库 `.gitignore:8` 忽略 `lib/`，npm 包才带产物；`pnpm run build` = `tsdown`（`package.json:41-55`） | 同一次构建的第二份 config；`pnpm run watch` 走 lean profile（不产出 d.ts / sourcemap）（`tsdown.config.ts:88-90`） |

### 3.2 构建手法（为什么它「不需要宿主侧构建」但自己必须构建）

- 双 config：host 走 `platform: 'node'` ESM、`dts: true`、`neverBundle` = 全部 production deps；client 走 `platform: 'browser'` CJS；依赖默认内联（平台模块除外），但 `onlyBundle: ['@opencode-ai/models','@deepseek-ai/dsh-util-workspace-path','simple-icons']` 把「**允许被内联的第三方包**」钉死为这三个，未来某个依赖开始被内联会构建失败而不是悄悄变胖（`tsdown.config.ts:238-257`）。
- **客户端 bundle 纯净度闸门**：任何 `@deepseek-ai/*` 值导入，若不属「默认平台外链 / 本包 `dsh.client.external` / inline-safe 白名单 / 生成式 `/remote`」，构建直接报错，逼开发者走 cordis 服务协作（`tsdown.config.ts:65-68, 286-298`）。
- 平台模块硬编码为 `react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives`（`tsdown.config.ts:60-63`），其余全部内联。
- CSS 不产出独立文件：3 个虚拟 CSS 通道（`.module.css` / `?inline` / 全局 `.css`）在构建期用 lightningcss 压缩 + Tailwind 4 编译，再以「运行时插 `<style data-plugin-css>`」的 JS 模块注入（`tsdown.config.ts:99-211`）。所以 641 KB 的 client bundle 里含全部样式。
- 构建产物头注释用 git 状态打 banner（commit / branch / dirty / build time，`tsdown.config.ts:14-56`），便于现场定位版本；watch 模式每轮 `gc()` 防 rolldown napi 对象堆积（`tsdown.config.ts:92-97`）。

### 3.3 依赖的官方 API 面（按用途）

| 类别 | 用到的官方面 | 插件位置 |
| --- | --- | --- |
| 投影注册 | `ctx.sessionProjections.register({key, stateSchema, init, apply, wire:{viewSchema,view}, stateVersion})` | `src/host/timeline.ts:319-333`、`src/host/headers.ts:110-125`、`src/host/activity.ts:315-335` |
| 自定义路由 | `connection.fetch.register({path, methods:['POST'], requestBody:'buffered', fetch})`（feature-detect + `ctx.effect` 自动注销） | `src/host/connection.ts:22-37` |
| 会话读取 | `sessions.get`、`sessions.prepare`、`sessions.subagentAddress`、`sessions.refreshSubagents`、`sessionQuery.observeSession(id,{projectionMode:'none'})`、`sessionQuery.listSessions`、`sessionPersistence.open(id,'read')` | `src/host/detail.ts:95-171`、`src/host/backfill.ts:185-330`、`src/client/fleetModel.ts:41-45` |
| 投影缓存 | `sessionProjectionCache.cachedSnapshot / coldSnapshot / write`；`sessionProjections.restore / hydrate`；`storageDomain('session_projcache').table('sessions')` | `src/host/backfill.ts:15-27, 226-238`、`src/host/sweep.ts:25-33` |
| 提示词组装 | `ctx.inject(['systemPrompt'])` → `systemPrompt.section({name, order, text, interpolate})` + `systemPrompt.getSectionOrder(anchor)` | `src/host/promptInjection.ts:35-53` |
| 其它 host 服务 | `settings.describe({redactSecrets:true})`、`llm.listConfigurableProviders`、`credentials.resolve`、`skills.list`、`agentPresets.serviceFor/acquireScope`、`agents.get`、`attachments.fileHostPath/imageHostPath`、`dshHomePath` | `src/host/balance.ts:40-133`、`src/host/skills.ts:66-102`、`src/host/attachment.ts:95-131`、`src/host/version.ts:105-112` |
| 事件 | `ctx.on('session/event')`、`ctx.on('session/disposed')`、`ctx.on('agent/pre-step', …, {prepend:true})`、`ctx.on('internal/get')`（私有） | `src/host/detailShadow.ts:72-82`、`src/host/stepIdentity.ts:40-53`、`src/host/attribution.ts:138-144` |
| 客户端槽位 | `conversation.view`、`conversation.input.overlay`、`conversation.chat.assistant-actions`、`main`、`sidebar.panellist`、`sidebar.right.pane.tab[.title]`、`plugins.bundle.config`（共 8 个名字 / 9 处注册） | `src/client/index.ts:46-132`、`src/client/sidebar.ts:26-44`、`src/client/insightPage.ts:23-31`、`src/client/fleetTab.ts:18-21` |
| 客户端服务（全部可选） | `configForms`、`sidebarRightTabs`、`sidebarRight`、`inputTriggers`、`uiWorkspace`、`uiConversation`、`sessions`、`remote` + `remote.session`、`pluginNavigation`、`locale` | `src/client/index.ts:118`、`src/client/sidebar.ts:17`、`src/client/command.ts:10`、`src/client/services.ts:761-916`、`src/client/historyPage.ts:164-180` |
| 会话标准 props | `useProjection(key)`、`useChat`（legacy nodes）、`useSessions`、`useWorkspaces`、`useTabInfo` | `src/client/services.ts:122-151`、`src/client/components/overviewPanel.tsx:82-83`、`src/client/components/contextView.tsx:880-891` |

**是否依赖官方 experimental 包**：**声明层面不依赖**——`package.json` 的 peer / `dsh.client.inject` / imports 里都没有 experimental 包。**功能层面 Fleet 任务板依赖 experimental Agent Teams 的 `agentTeam` 投影**：`projectionOf(props, 'agentTeam', teamOf)` 与行级 `row.projectionValues.agentTeam`（`src/client/components/fleetView.tsx:49-50`、`src/client/fleetModel.ts:18-28`）。该投影由 `@deepseek-ai/dsh-experimental-agent-team` 提供（本机 0.2.1-rc.5 闭包存在；本机 web profile 的 bundles 也已含 `@deepseek-ai/dsh-experimental-agent-team-profile` `[实测]`）。缺失时的降级是「任务板/成员角色为空、血缘与通讯仍在」`[推断]`。

### 3.4 脆弱点与升级风险评级

评级只针对「内核升级时可能静默失效/算错」的面，不评产品价值。

| # | 依赖面 | 评级 | 依据 / 失效形态 |
| --- | --- | --- | --- |
| 1 | 投影注册（3 单元 + `stateVersion`） | **低** | 官方 `register/stateOf/restore/hydrate` + `stateVersion` 校验在本机 rc.5 齐备；版本不匹配走「丢弃重建」而非崩溃 |
| 2 | 自有 POST 路由（`connection.fetch.register`） | **低** | 官方 buffered 路由形态本机 rc.5 多处存在；插件自己 feature-detect，注册失败只是无能力（`src/host/connection.ts:12-16, 30-35`） |
| 3 | 会话读取服务组合（`sessionQuery`/`sessionPersistence`/`sessionProjectionCache`） | **中** | 服务稳定但返回形状多；插件全部 `asRecord` 后按字段取值，形状漂移 = 静默少数据 |
| 4 | **持久日志事件形状**（`fold.ts` 的 `event.type` switch） | **中高** | 20+ 事件类型、含 `job/*`、`tool/ptc-dispatch*`、`request/header.config` 等内部数据形状；fold 设计成 TOTAL（未知事件原样返回，`src/host/fold.ts:870-881`）⇒ 改名不报错、只是少算 |
| 5 | 流式计时形状（`logShapes.ts`） | **中高** | 读 `record.time0 / texts / dt`、`chunk.type==='block-start'`、`blockType` 推导 TTFT/TPS（`src/host/logShapes.ts:54-102`）；这些是内部流记录格式 |
| 6 | `storageDomain('session_projcache')` 表结构 | **高** | 直接遍历/`update` `sessions` 表的行结构做 ver36→37 迁移（`src/host/sweep.ts:25-33, 45-76`）；表名/行结构变即失效，失败只 `logger.warn` |
| 7 | `systemPrompt.section()` + 锚点名 | **低** | 本机 rc.5 核对：`HARNESS_IDENTITY` −1000、`DEPLOYMENT_PERSONA_PREFIX` 0、`DEPLOYMENT_PERSONA_SUFFIX` 10200、`getSectionOrder` 存在 `[实测]`；升级若改锚点，前缀/后缀会落到错位（不崩） |
| 8 | `agent/pre-step` prepend 钩子 | **中高** | 属内部事件；签名变更即静默失效（钩子内 try/catch 后原样返回，`src/host/stepIdentity.ts:40-53`） |
| 9 | 工具归属：`internal/get` + `Symbol.for('cordis.original')` + 改写 `tools.register` | **高（私有）** | 事件名即「内部」；还改写共享服务实例的方法（`src/host/attribution.ts:95-165`），兼容性最差 |
| 10 | 官方 DOM 标记 + 全局存储 | **中高** | `[data-conversation-scroll]`、`[data-composer-seat]`、`[data-width-handle]`、`[data-approval-key]`、`[data-sidebar-right-open]`、`[data-ds-dark-theme]` 等 10 个属性；`base.css:85-87` 直接按属性选择器隐藏 composer 与拖宽手柄；`viewFocus.ts:70-77` 按**标签文本**匹配 `button[role="tab"]` 并 `.click()`；`services.ts:875-887` 直接写 `localStorage['dsh.conversation.<id>']` 的 `view` 字段。本机 rc.5 官方客户端产物抽样命中上述其中 6 个标记串 `[实测]`，但都无文档契约 |
| 11 | experimental Agent Teams（`agentTeam`） | **中** | 官方 experimental 包提供；缺失时任务板降级 `[推断]` |
| 12 | `remote.session.page`（历史分页读内容） | **中** | 官方 remote 贡献面，插件按 `records` 数组 + `ok/value` 包装解析（`src/client/historyPage.ts:164-233`） |

### 3.5 与本机 0.2.1-rc.5 的对照

- 插件自述支持集：`engines.dsh` 三档 + `dsh.compatibility.dshReleases` 只列 `0.2.0-rc.2` / `0.2.1-rc.2` / `0.2.2-alpha.3`（`package.json:16-19, 71-77`）。
- 它的兼容矩阵只 stage 这三个 tag（`tests/baselines.ts:1`、`.github/workflows/release.yml:38-47`）⇒ **0.2.1-rc.5 从未被它自己的 CI 验证过**；但 rc.5 属同一 `0.2.1` 线且高于 rc.2，语义应兼容 `[推断]`。
- 本机核对（官方闭包 `@deepseek-ai/*@0.2.1-rc.5`）`[实测]`：`sessionProjections.register/stateOf/restore/hydrate` 与 `stateVersion` 校验、buffered 路由、`configForms` + `plugins.bundle.config`（被 `dsh-client-ui-plugin-manager` 消费）、`systemPrompt` 三个锚点、`contextPressure/contextBreakdown/tokenUsage`（`dsh-token-meter`）、`agentTeam`（`dsh-experimental-agent-team`）、`dsh-session` 导出 `deriveEventMessage` / `interruptedTurnClosers`、以及 `data-conversation-scroll` / `data-composer-seat` / `data-width-handle` / `data-plan-review-key` / `data-json-expander` / `data-sidebar-right-open` 六个 DOM 标记串——**未发现静态契约阻断项**。
- 残余风险收敛为三条：① 它的 CI 未覆盖 rc.5；② `storageDomain` 表结构与 DOM 标记无契约（静默失效）；③ 8 条自定义 POST 路由不经内核 `/api` 服务级准入链，信任边界取决于 `connection` 通道本身（与 usage 线既有判断同源，见 `dsh-miasaki-usage/lib/index.js` 头部注释）。
- 试用关注点（给 Lead，若尚在试用期）：浏览器 console 是否有 `dsh-context` 前缀报错；`/context` 与 Context/Fleet 两 tab 是否出现；投影缓存目录（`~/.dsh/storages/session_projcache/sessions/`）是否出现 `contextTimeline` ver=37 行 `[推断]`。

---

## 四、关键机制拆解

### a. 打包与运行形态

- **标准双半**：host = Cordis 插件 `[name, inject, apply, Config]`；client = 由宿主 `__ModuleLoader__` 加载的 CJS 工厂（`tsdown.config.ts:299-305`）。宿主侧零构建、零额外安装步骤——README 明说「无需构建，也无需重启」（`README.md:48`）。
- **对 repo 的读者**：`lib/` 被忽略（`.gitignore:8`），必须 `pnpm run build`；构建需要 `@tailwindcss/node` + `@tailwindcss/oxide` + `lightningcss` 原生依赖（`package.json:111-158`），因此**在受限环境里构建会踩原生 binding**。
- **产物形态**：host ESM 单文件（111 KB，含全部 zod schema 与 fold 逻辑）；client 641 KB 单文件（组件 + 20 份 CSS 字符串 + Tailwind）；
- **官方 experimental 依赖**：无声明层依赖；Fleet 任务板功能依赖（见 §3.3）。

### b. 契约面（除 §3.3 表格外的三个细节）

1. **「能力全可选、只有装配面是硬 inject」**：host 硬 `inject: ['sessionProjections']`（`src/host/index.ts:25`）；其余全部 `ctx.inject([...])` / `ctx.get(...)` + face 检测，失败即降级——这正是它 compat 文档 §5 rule 1 的「Every capability rides an OPTIONAL seam」`[实测]`（`docs/compatibility.md:79`）。client 侧硬 `inject: ['slots','locale']`（`src/client/index.ts:137`），其余同法。
2. **8 条自有路由**：`/api/dsh-context/{detail,fleet,commands,backfill,attachment,balance,skills,recom}`（`src/client/apiRoutes.ts:1-15` 与 host 各 `*_ROUTE` 常量一一对应）。全部 POST + `body` 自行 JSON 解析 + `{ok, value}` / `{ok:false,error:{code,message}}` 包装 + `cache-control: no-store`。**信任边界自持**：读面是「任意 sessionId 的会话摘要/明细」，没有自己的鉴权检查 `[推断]`（依赖 connection 通道）。
3. **私有/半私有面清单**（判断「升级脆弱」的直接依据）：`internal/get` 事件、`Symbol.for('cordis.original')`、`tools.register` 方法改写、`storageDomain` 表结构、`agent/pre-step` 事件、`remote.session.page` 记录形状、10 个 `data-*` DOM 标记、`localStorage` 视图偏好键、附件 `v1/attachments` 目录结构（`src/host/attachment.ts:79-83` 通过 `dirname` 三次上溯推出 `cache/dsh-context/previews` 别名目录）。

### c. 数据管线与性能手法

**三层结构**（host 折叠 → 投影缓存 → client 数据层）：

1. **折叠层**：`applyTimeline(state, event, bounds)` 是**纯函数式增量折叠**，只在真正变化时才克隆被触碰的键（`ensure(keys)`，`src/host/fold.ts:293-309`），未命中事件原样返回同一引用（`src/host/fold.ts:870-881`）。一个 `TimelineState` 含 surface 节点、分类合计、请求 slim 记录、事件、命令/文件操作、计时 span、成本桶、跨步骤工作记忆（`src/host/foldState.ts:137-187`）。
2. **投影缓存：只存头**。`contextTimeline` 注册时用 `headBounds = {...bounds, headOnly:true}`（`src/host/timeline.ts:319-332`），于是持久化行里：surface 节点被瘦身（`slimSurfaceNode`，`foldState.ts:11-19`）、requests 只留 slim 字段（`fold.ts:751-763`）、`spans/fileOps/archived` 不落（`fold.ts:82-85, 95-98, 567`）、`stateVersion` 37。上限与 README 一致：步骤 1500 / 轮次 300 / 事件 400 / surface 节点 2000 / 存档 400 / 文件操作 400 / 命令 400，另加命令文本 4096 字符（`src/host/config.ts:4-13`；README 未列最后一项），`trimState` 逐类裁剪并记录 floor（`foldState.ts:217-270`）。
3. **明细按需从持久日志重算**：
   - host：detail 路由（`src/host/detail.ts:87-173`）对**活会话**走 per-session shadow fold——`DetailShadow` 用 `sessionQuery.observeSession(id,{projectionMode:'none'})` 播种全量日志，之后由 `session/event` 增量推进，播种期间事件进 512 缓冲、播种后再回放（`src/host/detailShadow.ts:62-165`）；LRU 8 个会话，`foldLog` 每 1000 事件 `await setTimeout(0)` 让出事件循环（`detailShadow.ts:9, 41-60`）。对**冷会话**用 revision 键的 payload 缓存（最多 4 条，`detail.ts:13, 127-152`）。
   - client：`DetailStore`（`src/client/timelineSource.ts:53-264`）以 head 投影的 `detailRev` 为门：300 ms 防抖、首读 16 ms 抢跑、失败指数退避（上限 3 次翻倍）、rev 下降即清账、可「追平」（catch-up 1 s）、无订阅者时 park 并释放；字节预算 8 个会话 / 6 MB / entries 64（`timelineSource.ts:266-321`），字节按条数×经验系数估（`:270-279`）。
   - 回填：应用启动后由页面触发 `backfill` 路由（一次性），遍历 `listSessions`，跳过活会话与已有缓存行，冷读整份日志后条件走**分片折叠**（每片 2,000 事件；8 s 工作预算后暂停 2 s；每片后至少 25 ms 让出）；>2,000 事件时用 `sessionProjections.restore/hydrate` + `sessions.prepare` + `sessionProjectionCache.write` 写回（`src/host/backfill.ts:40-45, 125-167, 240-315`）。
   - 迁移：启动扫表把 `stateVersion` 36 的旧行**原地**改写成 head-only 形状（纯派生、不重算，`src/host/sweep.ts:8, 45-76`）。
4. **冷读总闸**：`makeColdReadGate` 用 `v8.getHeapStatistics()` 判「已用 < 上限 2/3」才放行，且用 promise 尾串成 FIFO 单并发；不满足时返回 `undefined`，调用方走「无数据」路径（`src/host/coldRead.ts:12-39`）。写日志注释里的设计意图是「跳过的读等下一次活活动再打折」。
5. **前端具体手法**：
   - 固定行高窗口化 `useRowWindow`（rAF 合帧 + ResizeObserver + overscan 8，`src/client/components/useRowWindow.ts:1-94`）；变高行用 `useMeasuredWindow`（按 key 量高 + 前缀和 + 二分定位 + 240 px overscan，`:107-275`）。
   - 懒挂载 `useLazyMount`：`IntersectionObserver`（root 为会话滚动容器，`rootMargin:200px`）→ `requestIdleCallback(timeout 200ms)`（`src/client/components/useLazyMount.ts:5-43`）；Context 页的浏览器卡、下半区、命令面板都走它（`contextView.tsx:803-861`）。
   - 趋势图**横向**窗口化：>`TREND_WINDOW_MIN=240` 根柱才启用，overscan 36 根、滞回 8 根，只渲染窗口内柱子并用左右 padding 撑住滚动条（`src/client/components/trendWindow.ts:1-39`；`trendChart.tsx:543-545`）；入场动画封顶 `RISE_CAP=200` 根（`trendChart.tsx:21`）。
   - 推导缓存：WeakMap 按数据对象 memo（`derivedCache.ts:5-40`）；预热：900 ms 后再拉 detail（`prefetch.ts:5-34`）；动画段数上限 256（`stackedBar.tsx:8`）。
   - 大数据量实证（release notes，非本机实测）：225 agents/2,700 消息从 16,566 → 1,748 DOM 节点（−89%），481 agents 从 32,933 → 1,897（−94%），live refresh 25.4 → 6.4 ms（v0.81.0 release body）。

**成本结论**：这套手法的核心不是「缓存更多」，而是「**缓存小头 + 明细可弃 + 冷读限速 + 前端只渲染视口**」。它把「长会话/多会话」这一维度的成本从「随日志线性」压到「随视口线性」。

### d. Token 计量与成本估算

- **占用率与组成复用官方投影**：`useContextSession` 同时取 `contextTimeline`（自建）+ `contextPressure` + `contextBreakdown` + `tokenUsage`（官方）（`src/client/sessionData.ts:8-24`）。`headlineOf` 的 token 取 `pressure.projectedTokens ?? pressureTokens ?? (last.prompt + Δfold) ?? current.total`，窗口取 `pressure.contextWindow ?? data.contextWindow`，占用率 `min(100, round(tokens/window*1000)/10)`——与官方输入框环形图同一公式、同一数据源（`src/client/headline.ts:13-47`；插件 compat 文档明确该公式镜像自 `dsh: packages/client/ui-conversation/src/client/context-occupancy.ts`，见 `docs/compatibility.md:62`）。
- **组成如何与环形图对齐**：先 `officialParts` 用官方 `breakdown.systemTokens/toolsTokens/messageTokens` 拿三大块，再把 messageTokens **按自建 fold 的各类占比**分给 user/inject/skill/assistant/tool（最大类吸收取整误差）（`src/client/categories.ts:32-60`）；最后 `anchoredParts` 把整条按官方占用总量**等比缩放**，保证「分段之和 = 官方占用数」（`:62-71`）。所以卡片里的占比是与环形图一致的口径，只是类内细分来自估算。
- **估算密度镜像官方**：chars/4 + 固定开销（system 角色 4、block 4、role 4）；`estimateSystemContent` 对非文本块退化为 JSON 长度（`src/shared/estimate.ts:1-32`、`src/host/pricing.ts:4-96`）。它**不 import** 官方 token-meter 的实现，而是在 compat 文档里逐条列出「镜像了哪一处源码」，并要求差分对账（`docs/compatibility.md:54-65`）——理由是那些是内部实现、无稳定导出。
- **成本是自算的**：折叠时按 `(provider, model, period)` 累计四类桶（uncached / cacheRead / cacheWrite / output），period 由「是否 DeepSeek 供应商 × 是否北京时间高峰」决定（`src/host/foldMetering.ts:37-57`；`isBeijingPeak` = 周一至周五 9:00–12:00、14:00–18:00，`foldMetering.ts:29-35`）。前端 `estimateSessionCost` 用 models.dev 价本逐桶乘价，DeepSeek 高峰 ×2，人民币按 `1 CNY = 0.15 USD` 折算（`src/client/cost.ts:17-19, 86-88, 371-388, 446-457`；高峰 2× 的文案在 `src/client/i18nZh.ts:52`）。
- **价本来源与解析**：`@opencode-ai/models` 的 `Models.make().providers()` 拉 models.dev 数据（`src/client/modelPrices.ts:11-53`），30 s 起步、2^n（上限 3 次）退避重试（`:55-72`）；解析算法是**多级回退**：精确 → provider 后缀 → 规范化 → provider 别名 → 组织分支 → canonical 厂商 → 模型家族 → 全局一致价，任一步出现「多候选不同价」就判 unpriced 并在 tooltip 说明原因（`src/client/cost.ts:168-380`、`src/client/priceIdentity.ts:1-114`）；映射规则、编码计划（$0 订阅权益）与边界另有一篇专门文档 `docs/model-pricing-mapping.md:1-82`。
- **缓存命中率口径**：`cacheRead / (uncachedInput + cacheRead + cacheWrite)`，从官方 `tokenUsage` 投影取数（`src/client/components/statsTokens.tsx:34-40`、`src/client/format.ts:18-22`）。
- **诚实性设计**：趋势卡固定某一步后，明细会并列「估算 vs 服务商实报 actual prompt/output/cache」；Token 卡把「≈ 估算占比」与「精确计费总量」并置（`README.md:131, 230`）。这说明作者清楚「自算组成 + 官方总量」两套数的边界。

### e. 上下文浏览器 / DNA 模式 / 趋势图

- **数据模型（可复用度最高的部分）**：`assemble(data, headers, seq)` 把「第 seq 个请求时窗口里有什么」算出来：`seq=null` 表 Live；否则取 `node.seq < seq` 的节点 + 命中存档区间（`gone > seq`）的归档节点，排序后给出 `{live, header, system, nodes, missingLive, approximate}`（`src/client/assemble.ts:40-69`）。`headerAt/systemAt` 用二分/后向扫描找「该步生效的工具表与系统提示」（`:12-38`）。`assembleCached` 以 `(timeline对象, headers对象, seq)` 为键做 WeakMap 缓存（`derivedCache.ts:21-40`）。**这套「按请求位点重建窗口快照」的模型与 UI 解耦，是本插件最值得单独抽出来的部分。**
- **上下文浏览器（Browser）**：7 个可折叠类别 → 逐项列表（每项 token 数）→ 再展开看实际内容（系统提示、工具 schema、消息文本/推理/工具参数/工具结果）。内容**按需取**：`useFetchOnMiss` 在展开某行时才调 `fetchContent(seq)`（`components/fetchOnMiss.tsx:12-43`），fetcher 来自 `remote.session.page` 的按 seq 分页读，客户端 128 条 LRU（`historyPage.ts:207-224`）；内容缺失/失败都有明确提示与重试，不是死 spinner。
- **DNA 模式**：把「窗口内容」展平成有序色带（`dnaOf`：system → 工具定义 → surface 节点，`src/client/dna.ts:10-30`）；条形图按「模型读取顺序」逐项绘制，下方是同一份数据的平铺列表（倒序，最新在上），行高 30 px 走 `useRowWindow`（`components/browser.tsx:712-714`）；另有 treemap 视图（`treemap.ts:102 squarify`）与「与上一轮对比」的有符号差异带（`deltaBandsOf`，`dna.ts:78-103`）。DNA 模式与趋势图联动（`dnaBands` 从同一 assemble 结果派生，`contextView.tsx:622-728`）。
- **趋势图**：每请求一根堆积柱（比「按消息」更细），支持 step/turn 聚合、total/delta、DNA 色带、Adaptive、Overview（把整段压成一条连续色带，含四分量位与范围，`components/trendOverview.tsx`）、时长曲线、事件标记（压缩/清理/模型切换/模式）、悬停预览联动浏览器、点击固定明细。几何与交互都在 `components/trendChart.tsx:54-198`；窗口化见 §4c。
- **可复用性判断**：`assemble` + `dna` 两个纯数据模块**不依赖 UI**，可直接移植到任何「会话快照可视化」场景；`stackedBar` / `trendChart` 是重几何实现（约 1.1 万 + 3.7 万字符），移植成本高、收益一般。

### f. Fleet / Agent Teams 面

- **父子关系发现**：不调 team 服务，读**会话列表行**的 `parentId` 且要求 `origin === 'subagent'`（`src/client/agentTree.ts:99-101`）；`agentForestOf` 从当前会话向上回溯到根、再向下遍历子节点，环检测，兄弟排序用「服务端 catalog 顺序 → running → updatedAt → id」（`:228-319`）。fork 出来的会话没有 `origin`，因此自成一家（这也写进了它的 compat 文档 §5 rule 12）。
- **任务板与角色**：读官方 **`agentTeam` 投影**——`props.useProjection('agentTeam')`，或从会话行 `projectionValues.agentTeam` 兜底（`components/fleetView.tsx:49-50`、`fleetModel.ts:18-28`）；`teamOf` 逐字段白名单校验 members/tasks/blockedBy/writeScopes/ready/warnings（`fleetTeam.ts:31-95`）。
- **通讯记录**：**自己从持久日志折叠**——host `FleetFold` 识别 `subagent/catalog`、`subagent/descriptor`、`team/member`、`user/message`（source.kind = `agent-message` / `team-message` / `subagent-settled`）与 `assistant/message`（`src/host/fleet.ts:254-359`）；三类消息分别是「relay / mailbox / settled」，文本用固定前缀正则剥离（`fleet.ts:63-64`），settled 再解析「Its closing message: / Structured result: / 诊断余段」（`fleet.ts:66-133`）；前端还有一套**六种英文结算结尾文案**的匹配（`client/fleetDetail.ts:244-255`）。这是它最脆的一处 i18n 依赖，compat 文档自己把「结算报告拆分」列为 limitation（`docs/compatibility.md:99`）。
- **实时性**：**零轮询**（`src/` 内 `setInterval` 0 处 `[实测]`）。靠官方 `sessions.list.subscribe` 快照推送 + 120 ms 合并再触发渲染（`fleetModel.ts:37-71`、`agentHeads.ts:50-76`），挂载时 `sessions.refreshSubagents(currentId)` 主动补一次子会话（`fleetModel.ts:41-45`）；每节点按 `updatedAt` 变化发 detail 请求，**并发 4、750 ms 刷新延迟**（`fleetView.tsx:51`、`fleetModel.ts:99-273`）；`FleetDetailCache` 64 条预览 / 4 条全量 / 4 MB 字节预算，离开页面即释放。
- **判定**：血缘与实时性是「纯官方面 + 事件驱动」，值得学；通讯/结算是「私有日志形状 + 英文文案正则」，不值得学。

### g. 设置与注入（对我们「部署级角色设定」最直接相关）

- **为什么设置卡在官方 Plugins 页**：host 导出 schemastery `Config`（含全部默认值 + `promptPrefix/promptSuffix`，`src/host/config.ts:30-52`），package 声明 `dsh.bundle.patch` 指向 `cordis.patch.yml`，于是该包以 **bundle 行**身份进 profile；官方 Plugins 页为每个 bundle 渲染其 Config 表单。客户端不重造表单，只往 `plugins.bundle.config` 槽注册**一张自定义卡**，用 `key: NS` 绑定到本插件 namespace，并用 `configForms.whileServed([NS])` 保证「只有该 bundle 的配置面被打开时才挂卡」（`src/client/index.ts:118-132`）；`settings.attach(forms.get(NS))` 把官方设置作用域接到自管 store（`src/client/settings.ts:148-156`），写失败时按「真值回滚」而不是乐观假显示（`:157-169`）。
- **System Prompt 前缀/后缀的注入点**：`ctx.inject(['systemPrompt'])` → 注册两个 section（`src/host/promptInjection.ts:33-53`）：
  - prefix：`order = getSectionOrder('HARNESS_IDENTITY') - 1000`；
  - suffix：`order = getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 1000`；
  - `interpolate: false`（不做 `{{var}}` 插值）；文本用 getter 实时读配置（`liveText`），空/全空白时返回 `''`（空 section 不产出内容）；
  - 因为 section 在每次提示词组装时被读取，所以「改设置从下一轮生效」，且对**所有 Agent（含子 Agent）**生效（`README.md:221`）。
- **本机 rc.5 核对**：三个锚点存在且该 API 形态一致 `[实测]`（官方 `dsh-system-prompt`）。**已知限制**：若部署注册了 `complete` section，则只保留该 section，普通 section（含本插件前缀/后缀）被丢弃（`docs/compatibility.md:98`；本机 rc.5 源码里也能看到 `complete` 冲突即抛错的逻辑）。
- **对我们的意义**：这是一条「不改 agent preset 文件、不碰 shell、纯官方契约」的部署级角色设定通道；比我们现有「改 `%USERPROFILE%\.dsh\.agent-presets\` 的 persona 文件」侵入更小、可热改、对子 Agent 一致。代价是它和 agent preset 的 persona 会叠加，需要约定谁管什么（前缀=部署级硬规则，preset=人格）。

### h. 国际化 / 主题 / 设计语言

- **i18n 组织**：命名空间 `dsh-context`，`ctx.locale.register(NS, {zh: DICT_ZH, en: DICT_EN})` + `ctx.locale.bind(NS)`（`src/client/index.ts:52-54`）；两本**扁平 TS 字典**（各约 740 行），zh 为权威：`DICT_ZH` 用 `satisfies Record<string,string>` 后导出 `DictKey = keyof typeof DICT_ZH`（`src/client/i18nZh.ts:739-741`），en 用 `satisfies Record<DictKey, string>` 编译期强制键齐全（`src/client/i18nEn.ts:1, 741`）；插值用 `{n}` 占位，测试逐键比对**两侧占位符集合一致**（`tests/client/i18n.spec.ts:15-30`）。
- **插件元信息**：`locale/{zh,en}.json` 提供插件标题/描述（`locale/zh.json:1-6`），由官方插件管理器读取。
- **主题令牌**：34 个 `--dsw-*` 令牌、21 个 CSS 文件、760+ 处引用；`base.css:1-16` 把官方令牌派生成 `--lc-*` 局部变量（亮暗两套）；卡片圆角 10/12、0.5 px 分隔线、字号 13 px 根（`base.css:17-31`）；容器查询 `@container lc-card / lc-head` 驱动响应式（`base.css:24, 71-75`）；官方 `Menu`/`Tooltip`/`StateDot`/`MarkdownText`/`JsonTree`/`writeClipboard`/`useCodeHighlighter`/图标都用 primitives（`components/settingsCard.tsx:2`、`components/richText.tsx:2`、`components/commandPanel.tsx:2`、`components/contextJump.tsx:2`）。
- **和我们 appearance 纪律的差异**（有参考价值）：
  - 令牌纯度**基本达标但有例外**：查找高亮 `#ffff00/#ff9632`（`styles/detailSections.css:41-42`）、推广卡品牌蓝 `#4d6bfe/#7c96ff/#383c46`（`styles/recom.css:1,7,14,18,20,22-23`）、`fleet.css:97` 用 Tailwind 紫色 fallback；其余都走令牌（fallback 字面量在 `var()` 内，属规范写法）。
  - **官方 primitives 覆盖不全**：分段控件 `.lc-gran-btn`（`base.css:42-48`）、搜索框、按钮、textarea 行都是自研 DOM + 自研 CSS；设置卡用官方 `Menu` 但没走官方 `Switch/SegmentedControl/Input` 形态——按我们 appearance 线的「设置页必须用官方 primitives + 行式规格」纪律，这一页**不合格**（它是 Plugins 页的插件卡，不属官方设置页规格）。
  - 有一处**官方 DOM 依赖**：`base.css:85-87` 用 `[data-conversation-scroll][data-lc-surface] > [data-composer-seat]` 隐藏输入区、隐藏拖宽手柄——这是为了在 Context 视图里让出整页空间，属技巧但脆弱。
- **结论**：它的 i18n 形态可以直接抄；它的视觉策略「大量手写 CSS + 局部官方 primitives」不建议抄到 appearance（我们已有 `PANEL_CSS` + 官方 primitives 的更强范式）。

### i. 工程质量与发布流程（可借鉴项按成本排序）

- **目录结构**：`src/{host,client,shared}` + `tests/` 镜像 + `docs/`（只放面向用户文档）+ `scripts/` + `.github/`；`AGENTS.md` 写死硬规则：源码/测试**零注释**、单文件 <1000 行、**100% per-file 覆盖率**、i18n 双语齐全、禁止浅缓存（每项都可复核）。
- **类型/断言**：`tsconfig` `strict: true` + `verbatimModuleSyntax` + `isolatedModules`（`tsconfig.json:8-13`）；所有外部输入先 `asRecord` 再逐字段类型守卫（几乎每个 host 文件都有私有 `asRecord`），zod schema 用 `.strict()` 且分别约束「持久化 state」与「wire view」（`src/host/timeline.ts:12-315`）。
- **测试与闸门**：3 个 vitest project（host node / client jsdom `vmThreads` / compat 需真实 dsh 源码）（`vitest.config.ts:7-42`）；覆盖率 `perFile: true, 100%`（`:43-57`）；`scripts/check.sh` 并行跑 lint/typecheck/coverage，**用临时 index 树指纹做 stamp**（TTL 60 分钟、跑完再取一次指纹防「边跑边改」）（`scripts/check.sh:1-91`）；pre-commit 走同一闸门（husky）。
- **兼容性工程**：`docs/compatibility.md` 用「Rule（不变量）/ Limitation（接受的缺口）/ Check（怎么证）/ Procedure（怎么做）」四种条目写成单一行事实源（`docs/compatibility.md:1-9`）；`tests/baselines.ts` 为每个官方 tag 钉死「seam 面」（文件 + needle + 布尔能力位），compat 测试 **stage 真实 dsh 源码**并断言「已退役的 seam 必须不存在」（`docs/compatibility.md:127`、`.github/workflows/pr-checks.yml:38-47`）。
- **发布**：push `v*` tag 触发 GitHub Actions：先用 `dsh-plugin-checker@v1` 校验、装依赖、build、lint、typecheck、**fetch 三个 dsh baseline tag 后跑测试**、校验 `tag == package.version`、最后 npm **OIDC trusted publishing**（无需长效 token，自动 provenance）（`.github/workflows/release.yml:1-70`）；本地 `scripts/publish.sh` 作为手工兜底（token 只从环境读、重复发布自动 no-op）。
- **发布节奏**：155 个 npm 版本，2026-08-14 首版 → 2026-11-04 v0.81.0（约 82 天，日均近 2 版）`[实测]`（`npm view dsh-context time`）。这解释了它为何对「当前 dsh 开发线」跟得紧，也解释了为何兼容矩阵只钉三个 tag。

---

## 五、可借鉴候选清单

**筛选原则**：只写「我们确实缺、且成本可接受、且不与九线零耦合原则冲突」的点；已有替代的明确写「不抄」。

### 5.1 值得抄（按优先级）

| 候选机制 | 可落到我们哪条线 | 借鉴成本 | 风险 | 优先级 |
| --- | --- | --- | --- | --- |
| **A. `systemPrompt.section()` 锚点式「部署级提示词前缀/后缀」**：host 侧 ~60 行，`HARNESS_IDENTITY−1000` / `DEPLOYMENT_PERSONA_SUFFIX+1000`，空文本返回 `''`、`interpolate:false`、getter 实时读配置 | **desktop**（部署级角色设定；与 `preset-sources/` 的 persona 分层：前缀=部署硬规则、preset=人格），也可给 fleet 线做「编排级指令」 | 低 | 低（官方契约，本机 rc.5 锚点已核）；需写清两件事：`complete` section 会让它失效（官方限制）、与 agent preset persona 的职责边界 | **P0** |
| **B. i18n 类型化字典 + 占位符对账测试**：zh 字典导出 `DictKey`，en `satisfies Record<DictKey,string>`，测试逐键比对 `{占位符}` 集合 | appearance / usage / sidebar / canvas / dual-model（凡有自己 i18n 的线） | 极低（1 个测试文件 + 1 处类型约束） | 低 | **P0** |
| **C. 列表窗口化 hooks + 懒挂载**：`useRowWindow`（定高）/`useMeasuredWindow`（变高，前缀和+二分+240px overscan）/`useLazyMount`（IntersectionObserver→requestIdleCallback） | canvas（会话布大量卡片）、sidebar（审查长列表）、usage（会话活跃分布/年热力图下方列表） | 低（约 300 行纯前端，可整文件移植） | 低（纯前端；需按各自滚动容器替换 root） | **P0** |
| **D. 「头/明细分离 + revision 门控」数据层**：投影只存 head（`detailRev`）、明细走自建路由按需重算、client `DetailStore`（防抖/首读抢跑/失败退避/rev 下降清账/无订阅者释放/字节预算） | usage（全局浮窗的会话明细、长会话）、sidebar（审查面板） | 中（host 路由 + client store；可先只移植 client store 与 `detailRev` 语义） | 低-中（需自建路由；沿用我们既有「exact 路由自持围栏」纪律，不可绕过） | **P1**（usage 0.6.1 已用负缓存把首屏压到 2 ms，收益在长会话明细而非首屏） |
| **E. 冷读总闸 `makeColdReadGate`**：V8 堆 < 2/3 才放行 + FIFO 单并发 + 跳过即走「无数据」路径（约 40 行） | usage（跨会话重算）、canvas（会话布首屏）、sidebar（审查批量读） | 低 | 低 | **P1** |
| **F. Fleet 面三件套**：官方 `agentTeam` 投影读任务板 + 会话行 `origin==='subagent'`+`parentId` 血缘 + `sessions.refreshSubagents` + 快照 120 ms 合并（零轮询） | **desktop**（桌宠/家族视图展示子 Agent 状态）、sidebar（辅助对话的 subagent 视图） | 中 | 中（`agentTeam` 来自 experimental 包，需先确认 miasaki profile 是否装；**必须保留血缘降级**，不能把任务板当主路径） | **P1** |
| **G. 兼容性事实文档写法**：Rule/Limitation/Check/Procedure 四类条目 + 「只记别的产物没有的」+ 单行事实源 | shared-docs（`dsh-platform/` 升级评估）、九线升级流程 | 低 | 低 | **P1** |
| **H. 斜杠命令 + 中央弹窗**：`inputTriggers.registerSource`（`/` 触发、leading 匹配）+ `conversation.input.overlay` | sidebar（`/review` 快捷审查）、usage（`/usage` 快捷视图） | 低 | 低 | **P2** |
| **I. 两道仓库级闸门**：① per-file 覆盖率门槛（我们各线有单测但无门槛）；② 客户端产物上限（体积/纯净度——我们是源码直载，需裁剪成「client.js 体积上限 + 禁跨线 import」） | 仓库 `scripts/` + CI | 中 | 中（要防止闸门依赖未入库产物；`intro-clips` 事故同族） | **P2** |

### 5.2 明确不抄（已有替代或不适配）

| 不抄项 | 原因 |
| --- | --- |
| 洞察页（KPI/7 天图/8 周热力图/技能·工具·命令 tally/会话卡片） | **与 usage 线重叠**：`dsh-miasaki-usage` 已有全局浮窗（总览 / 年热力图 / 30 天趋势含按模型 / 会话活跃分布 / 今日限额）与会话「用量」Tab。只可取「按 step 发起日归因」的口径参考，不重做页面 |
| Token Stats / Timing Stats / 成本卡 | usage 会话「用量」Tab 已覆盖同类信息；且我们已决定「以官方投影为准」，不必引入它那套「自算组成 + 官方总量」双轨 |
| 上下文浏览器 / 事件 / 文件活动 / 命令执行四张深面板 | 价值面窄（解释单条上下文），依赖事件形状 + 英文结果 marker（见 §六.3），我们无对应产品位 |
| Plugins 页设置卡（`configForms` + `plugins.bundle.config`） | appearance 已用官方 `settings.section`（更适合独立设置栏）；README 自己承认该卡发现性差（要专门写路径说明，`README.md:219`），迁移无收益 |
| 附件「真实文件名预览别名」（hardlink 到 `cache/dsh-context/previews`） | 依赖 attachments host 私有路径 + `v1/attachments` 目录上溯（`src/host/attachment.ts:79-83`），且 sidebar 已有官方预览通道 |
| 工具归属（栈帧包名 + `internal/get` + 改写 `tools.register`） | 私有 API + 改写共享服务实例，升级必炸 |
| 推广卡 `recoms`（远程 JSON + gh-proxy 镜像 + 品牌色） | 供应链/隐私面；且硬编码品牌色违反 appearance 令牌纪律 |
| 190 KB 手写 CSS + 自研分段控件/输入框 | 与 appearance 线「官方 primitives + 行式规格 + 令牌纯度」纪律冲突；我们已有 `PANEL_CSS` 范式 |
| 兼容矩阵「staging 真实 dsh 源码 + 三方 action」 | 需 dsh 源码 checkout + CI fetch 三个 tag + 依赖作者自己的 action；我们九线是 link 安装、无 npm 发布，照搬成本远大于收益 |

---

## 六、不建议借鉴 / 反面观察

1. **体积与维护成本**：客户端 641 KB minified（我们各线客户端 22–181 KB：canvas 约 181 KB（`client.js` 32 KB + `app.js` 149 KB）、sidebar 158 KB、appearance 144 KB、usage 87 KB `[实测]`），client 半 21.5k 行 + 45k 行测试。它是「一次做深一个横切面」的合理结果，但**不符合我们九线互不耦合、单线可独立卸载的定位**；照抄产品面会把单线体积翻数倍。
2. **私有 API 面**：`internal/get`、`cordis.original`、`storageDomain` 表结构、`agent/pre-step`、`remote.session.page`、10 个 `data-*` DOM 标记、`localStorage` 视图偏好键。这些让它「即便官方没给 API 也能做出效果」，但也意味着**每次内核升级都要重验一遍**（它的 compat 文档就是为此而写）。我们唯一「纯官方契约」的 usage 线不应被这条路线污染。
3. **英文文案正则**：六种结算结尾（`client/fleetDetail.ts:244-255`）、`Its closing message:` / `Structured result:`、`Team message from X:` 前缀、命令结果的 background/exit marker。**官方任何一处文案改动都会静默降级**；它自己在 compat 文档里把它列为 limitation（`docs/compatibility.md:99`）。我们不做英文文案解析。
4. **DOM 文本匹配 + 直写 localStorage**：`activateViewTab` 按标签文字点 `button[role="tab"]`（`src/client/viewFocus.ts:70-77`）；`seedConversationViewVia` 直接改官方会话视图偏好的 localStorage（`src/client/services.ts:875-887`）。这类「看着能用」的捷径在官方重构时会静默失效，且没有 feature 检测能兜住。若我们需要跨视图跳转，应走官方导航 API（如 `uiWorkspace.openSession`）或自建状态通道。
5. **第三方远程数据**：host 主动 `fetch` 自己仓库 `data/recoms.json`，且备用镜像走 `gh-proxy.org`（`src/host/recoms.ts:1-52`、`src/shared/recoms.ts:16-18`）。这是「插件内广告位」的实现，供应链与隐私面都不可控；我们不做。
6. **性能数字不可复核**：release notes 给了 DOM 节点/mount/refresh 的合成基准（v0.81.0 body），但仓库里没有可复现脚本（bench 只在 release 文本里）。我们若引用性能数字，需带可复现脚本，否则就是叙事。
7. **双轨数字的复杂度**：它同时维护「自算估算（fold）」与「官方投影（pressure/breakdown/tokenUsage）」两套口径，并靠「等比锚定」对齐——这很诚实，但也解释了为什么它需要 28k 行与 2k 测试。我们若只读官方投影，可以用小得多的实现拿到 90% 的场景。
8. **设置卡放 Plugins 页是产品判断，不是工程最优**：发现性差（README 要专门写「侧边栏 Plugins → 该插件包 → Configuration」），而 `settings.section` 是官方给独立设置栏的正路。appearance 的选择更好。
9. **「零注释 + 100% per-file 覆盖率」不适合直接搬**：它的 `AGENTS.md` 明令源码零注释、单文件 <1000 行、覆盖率 100%，靠的是单人高频迭代 + 强工具链。我们九线是多人/多会话维护且重视「文档同步纪律」，直接照搬会制造大量无意义补齐，建议只取其中两项（i18n 对账、覆盖率门槛从「新增文件 100%」起步）。

---

## 七、参考资料

### 7.1 元数据（调研时点 2026-11-04）

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/bowenliang123/dsh-context |
| 快照 commit | `22929e753ca8b67517a42054700f91d1fb8d41d8`（`chore(recoms): update Zilliz Cloud`，2026-11-04 11:48:42 +0800） |
| npm | `dsh-context@0.81.0`（latest；共 155 个版本，2026-08-14 → 2026-11-04） |
| 许可证 | Apache-2.0 |
| GitHub 指标 | 4,098 star / 172 fork / 2 open issues / 仓库体积 133,974 KB（含 `docs/video/` 60 MB 演示视频） |
| npm 产物 | `dist.unpackedSize` 824,976 B / `fileCount` 10；tarball 224,794 B；`lib/client.js` 656,504 B、`lib/index.js` 111,041 B、`lib/index.d.ts` 14,036 B |
| 仓库文件 | 474 个入库文件；`src/` 28,290 行；`tests/` 44,554 行、192 spec、约 1,977 例 |
| 声明兼容 | `0.2.0-rc.2` / `0.2.1-rc.2` / `0.2.2-alpha.3`（`package.json:71-77`）；本机内核 0.2.1-rc.5 未在其矩阵内 |
| 本机安装 | web profile `dsh-context: ^0.81.0`，`node_modules/dsh-context/lib/` 三件产物齐全（Lead 安装） |

### 7.2 关键源码文件清单（相对 `_refs/tmp-dsh-context/`）

| 文件 | 作用 |
| --- | --- |
| `package.json` | exports / files / `dsh.bundle.patch` / `dsh.client.inject` / 兼容声明 / 依赖与 peer |
| `cordis.patch.yml` | bundle 行插入（host 半入口 + client 半声明） |
| `tsdown.config.ts` | 双半构建、平台模块、内联白名单、bundle 纯净度闸门、CSS 通道、git banner |
| `src/host/index.ts` | host 入口：`name` / `inject` / `apply` / `Config` 导出与装配顺序 |
| `src/host/fold.ts` | 持久事件 → `TimelineState` 的全量折叠（事件形状 switch、纯函数增量） |
| `src/host/foldState.ts` / `foldWire.ts` / `foldMetering.ts` | 状态类型与裁剪 / head 与 detail 的 wire 构造 / 计时与成本计量 |
| `src/host/timeline.ts` / `headers.ts` / `activity.ts` | 三个投影单元（zod schema + `stateVersion` 37/1/6） |
| `src/host/detail.ts` / `detailShadow.ts` / `coldRead.ts` | 明细路由、per-session shadow fold、冷读堆水位闸门 |
| `src/host/backfill.ts` / `sweep.ts` | 启动回填（分片折叠）、投影缓存行迁移 |
| `src/host/promptInjection.ts` | 提示词 section 注入（本文最推荐的借鉴点） |
| `src/host/fleet.ts` | Fleet 日志折叠：血缘目录、成员、通讯、结算解析 |
| `src/host/attribution.ts` | 工具归属（私有 API 依赖的主要来源） |
| `src/client/index.ts` / `sidebar.ts` / `insightPage.ts` / `fleetTab.ts` / `command.ts` | 8 个槽位 / 9 处注册 / 命令入口 |
| `src/client/timelineSource.ts` | client `DetailStore`（rev 门控、防抖、预算、释放） |
| `src/client/assemble.ts` / `dna.ts` / `brief.ts` | 按请求位点重建窗口快照 / DNA 色带 / 步骤摘要（纯数据、可移植） |
| `src/client/headline.ts` / `categories.ts` / `cost.ts` / `modelPrices.ts` / `priceIdentity.ts` | 官方投影锚定 / 组成拆分 / 成本与定价解析 |
| `src/client/settings.ts` / `components/settingsCard.tsx` | `configForms` 接入与插件配置卡 |
| `src/client/viewFocus.ts` / `services.ts` | 跨视图跳转与官方导航面（含 DOM 文本点击、localStorage 直写） |
| `src/client/i18nZh.ts` / `i18nEn.ts` / `tests/client/i18n.spec.ts` | 双语字典与占位符对账测试 |
| `tests/baselines.ts` / `docs/compatibility.md` | 兼容矩阵与单一事实源 |
| `scripts/check.sh` / `.github/workflows/release.yml` / `pr-checks.yml` | 闸门与发布流水线 |
| `docs/model-pricing-mapping.md` | 定价映射规则与已知边界 |

### 7.3 本机核对依据

- 本机内核 `@deepseek-ai/dsh` **0.2.1-rc.5**（全局 npm 安装）：`sessionProjections`（register/stateOf/restore/hydrate/stateVersion 校验）、`connection` buffered 路由、`configForms` 与 `plugins.bundle.config` 槽（`dsh-client-ui-plugin-manager` 消费）、`systemPrompt` 锚点（`HARNESS_IDENTITY` −1000 / `DEPLOYMENT_PERSONA_PREFIX` 0 / `DEPLOYMENT_PERSONA_SUFFIX` 10200）、`contextPressure/contextBreakdown/tokenUsage`（`dsh-token-meter`）、`agentTeam`（`dsh-experimental-agent-team`）、`dsh-session` 导出 `deriveEventMessage`/`interruptedTurnClosers`、六个 DOM 标记串——逐项 grep 命中 `[实测]`。
- 本机 web profile：`dsh-context@0.81.0` 已装（`dependencies` + `dsh.profile.bundles`），并含 `@deepseek-ai/dsh-experimental-agent-team-profile` `[实测]`。

### 7.4 未证实 / 未覆盖项

- 未构建、未运行、未做 UI 走查；「运行时表现」类判断（如 `agentTeam` 缺失时的降级形态、投影缓存行是否实际写出、自定义路由的鉴权效果）均属 `[推断]`。
- 未核 miasaki 桌面端 profile 是否装了 experimental Agent Teams（影响 Fleet 面在桌面端的可用性）。
- 未验证 `pnpm run check`（lint/typecheck/coverage）能否在本机复现全绿；测试例数按 `test(`/`it(` 正则统计，属近似值（192 个 spec 文件数为精确）。
- 未读完全部 126 个 client 文件（重点读了数据层、槽位、settings、i18n、Fleet、浏览器/趋势的数据模块；纯展示组件按抽样），个别 UI 细节可能未覆盖。

---

## 八、本机实机验证补记（Lead 追加，2026-11-04）

调研（§一–§七）是**只读源码**结论；本节记录同一时点的**实际安装与运行**证据，用补上 §3.5「试用关注点」的空缺。口径：`[实测]` 为本次命令/截图实测。

### 8.1 安装（web profile）

- 命令与解析：`dsh plugin --profile web add dsh-context` 先解析到 **0.80.2**（pnpm 11 的 `minimumReleaseAge` 把当日发布推迟），随即 `dsh plugin --profile web add dsh-context@0.81.0` 落到 latest，pnpm 在 profile 的 `pnpm-workspace.yaml` 自动追加 `minimumReleaseAgeExclude: [dsh-context@0.81.0]`。`[实测]`
- profile 落点：`~/.dsh/profiles/web/package.json` 的 `dependencies["dsh-context"] = "^0.81.0"`，`dsh.profile.bundles` 末尾追加 `dsh-context`，`node_modules/dsh-context/lib/{index.js,client.js,index.d.ts}` 三件产物齐全；`compatibility.json` **没有**新增版本豁免（说明插件预检的 dsh 兼容判定直接放行）。`[实测]`
- 说明：这是**运行时环境变更**，不改本仓任何文件；web profile 是本仓约定的「社区插件先试」环境，miasaki / desktop 两个 profile 未动。

### 8.2 启动与加载

- 启动：`dsh --profile web --port 3090 --no-open`（脱离会话的常驻实例，pid 30080），服务端 stdout 只有两条 deepseek 模型清单信息，**无 dsh-context 相关报错**。`[实测]`
- 首屏 HTML（带 token）返回 200，注入的客户端包清单里含 `dsh-context/client.js` —— 说明 host 半已作为 bundle 行加载，并把 client 半登记进前端注入表。`[实测]`
- 无头 Chrome 截图（`_refs/dsh-context-2026-11-04/web-verify-0.81.0.png`，gitignored）显示侧栏一级入口出现 **「上下文洞察」**（与「插件」「自动化任务」同级）——host + client 双半在 rc.5 上都跑起来了。`[实测]`

### 8.3 仍未验证（归用户 / 后续试用）

- Context 标签页、Fleet 标签页、`/context` 命令、洞察页的数据聚合与成本估算等**深层面板**未走查（需要打开真实会话交互）。
- 投影缓存是否实际落盘（`~/.dsh/storages/session_projcache/`）、`agentTeam` 投影缺失时的降级形态、8 条自定义 POST 路由的运行效果，均仍属 §7.4 的未证实项。
- 版本风险不变：0.2.1-rc.5 不在它自己的兼容矩阵内（§3.5），本次只证明「能装、能启动、入口能渲染」。
