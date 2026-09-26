# 变更记录 — dsh-miasaki-dual-model

## 2026-09-26（深夜）· 死代码清理（2 项；其余 4 项待随 M2 一并处理）

仓库级死代码审计结论：本线文件级零冗余（21 个追踪文件 == 21 个磁盘文件，无备份/空目录/探针/误入库产物），
只做两处**零读取字段**的删除。验证：`node scripts/verify-all.mjs dual-model` **12/12 PASS**
（33 例单测 + 图片准入补丁离线自证）。

| 项 | 位置 | 判定证据 |
|---|---|---|
| `/state` 响应字段 `stickWithinTurn` | `index.js:259` | client.js 与 test 全仓零读取；设计文档 `2026-09-10-dual-model-design.md:474` **自陈该配置项「不需要实现」**（M1 简化决策），只是把它留在了响应体里 |
| `resolveRouteCapability()` 返回的 `known` 字段 | `lib/capability.js:107` | 返回值唯一消费点 `index.js:248-249` 只读 `.vision` 与 `.name`；全仓 `known` 仅 JSDoc 与赋值两处，JSDoc 同批订正 |

**留待 M2 处理（低风险死码，但涉及契约或数据链，不在实机验收前动）**：
`lib/routing.js:83-92` 的 `selectVisionModels()`（生产零调用，仅 `test/routing.test.js` 引用；JSDoc 说是给 client
下拉用，但 client 半结构上无法 `require lib/`，属**未接线的实现**，删则须同批删该测试用例）；
`index.js:267` 透传的 `providers`（client 与 test 零读取，删除须连带 `lib/capability.js` 的 providerEntries 链）；
`client.js:85` 的 `shortModel` 兜底分支（4 处调用全传 `''`，不可达）；`lib/capability.js:70-73` 的
`snapshot(force)` 强制刷新分支（唯一调用点无参调用）。

## 2026-09-23（二轮复审）

### Client 半回归修复 — 触发钮死件（`/state` 失败后错误面板不可达）+ client 契约测试

**发现**：第二轮独立复审报出 P2-A —— 触发钮被写成 `disabled: state === null`
（UI 令牌化批次 `8583adf` 引入，旧版 button 无 `disabled`），而 `load()` 的失败路径只
`setError`、**`state` 保持 null**，错误行又只渲染在**面板内部**。链条：

> `/state` 请求失败 → `state=null` + `error≠null` → 触发钮 disabled → 面板打不开 →
> 错误永远不可见 → 控件成死件（只能刷新页面）

旧实现失败时至少能点开看到错误 —— 属 UI 改版引入的功能回归。核实**属实**。

**修复**：判据改为 `loading = state === null && error === null`（**加载中才禁、出错放行**），
`disabled = busy || loading`；同时把失败原因带上 `title`（`双模型 · 读取失败：<msg>`），
悬停即可见。展开面板本就会重新 `load()`（`useEffect` 依赖 `open`），故点开即等于重试入口。

**回归闸门**：新增 `test/client.test.js` 4 例（本线首个 client 半测试）：

1. 装载契约 —— 在**无 `module` 的 VM 上下文**里跑 factory，控件注册在
   `conversation.input.right`（与 appearance 线同一范式，钉死「module is not defined」那类整包失败）；
2. 失败态触发钮**不得**被禁用 + 失败原因进 `title`；
3. 失败态展开后 `.dsh-dual-model-error` 真的渲染（死件链条末端）；
4. 成功态可点 + 折叠标签走「主 ▸ 辅」。

react stub 支持跨渲染 state 槽位与手动 flush 的 effect，故能驱动「挂载 → fetch 失败 →
重渲染」这条真实路径。**区分力已验证**：临时把判据回退成 `state === null` → 用例 2 变红；
还原 → 4/4 绿。

**验证**：`node test/client.test.js` 4/4；`node scripts/verify-all.mjs dual-model` **12/12**
（6 语法 + 5 个测试文件共 **33 例** + 补丁自证）；本线 README 与根 README 的项数/例数同步。

## 2026-09-23

### 0.1.3-miasaki.0 — DSH 0.1.7 兼容：设置失效信号新旧双轨（行为零变化）

背景：DSH 0.1.7-alpha.2 重写设置机制，`settings/updated` 事件在全树移除
（grep 两版源码：0.1.6 19 处 → 0.1.7 **0 处**），取而代之的是 RAW 文档层的
`settings/document-updated(ns, revision)`（语义更敏感：不比较 resolved 值）。
若不适配，本线能力目录缓存会少一路击穿信号——最坏退化是用户改 llm 设置后
能力索引最多延迟 5 分钟（TTL）自然过期，不报错、不显示错误能力。
影响评估见 `dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.7-upgrade-assessment-2026-09-23.md` §7.3。

改动：

- 新增 `lib/invalidation.js`：`SETTINGS_INVALIDATION_EVENTS`（旧名在前、新名在后）
  + `watchSettingsInvalidation(ctx, invalidate)`（注册双轨、返回合并 disposer）。
- `index.js:184`：原 `ctx.on('settings/updated', …)` 单监听改为 `ctx.effect(() => watchSettingsInvalidation(ctx, …))`。
- `lib/capability.js` 头注、设计文档 §4.4 同步双轨描述。

**为什么双轨而不是按版本探测** `[实测]`：Cordis 的 `ctx.on()` 监听一个没有任何提供方
发出的事件是无害空操作——cordis 4.0.2（0.1.5-rc.1）与 4.0.4（0.1.7-alpha.2）实测均
不抛错、正常返回 disposer（探针脚本验证）。因此两个名字无条件并监：0.1.5/0.1.6 上前者
命中、0.1.7+ 上后者命中，升级前后零改动。新事件更敏感导致的多余 invalidate 只是清缓存，
无正确性影响。

测试：新增 `test/invalidation.test.js` 5 例（双注册 / 任一发出都击穿含新事件 payload 形状 /
dispose 后不再触发 / 重复 dispose 幂等 / 事件名常量契约）。`node --test` 29 例全过，
`node scripts/verify-all.mjs dual-model` 11/11 PASS，补丁离线自证不受影响。

## 2026-09-22（晚）

### 0.1.2-miasaki.0 — 右下角选择框 UI 优化（主题令牌化 + 信息设计 + 交互补全）

用户反馈「双模型这个选择框优化一下」。本次只重写 `client.js` 的 UI 呈现层，
**host 契约（`/dual-model/api/*`）与路由逻辑零改动**，刷新页面即可生效（link: bundle
由 host 从磁盘serve，实测重载即加载新 client.js，无需重启）。

**一、配色主题化（核心修复）**

- 根因：旧实现的 `var(--dsw-static-surface, #1c2128)` / `--dsw-static-text` /
  `--dsw-static-border` 三个令牌在 DSH 本体**不存在**（已逐个在
  `dsh-client-ui-theme/lib/client.js` 取证）；面板背景因此恒回退硬编码
  GitHub 深色 `#1c2128`，浅色主题下成为"深色孤岛"且文字为继承的深色，基本不可读。
  状态色同样是 GitHub 硬编码三色（`#f85149` / `#3fb950` / `#58a6ff`）。
- 修复（全部换成真实令牌，已逐个校验存在）：
  - 弹层表面：`--dsw-specific-menu`（= `--dsw-alias-bg-layer-3`）+
    `--dsw-elevation-stroke-color: --dsw-alias-border-l1` +
    `box-shadow: --dsw-elevation-prominent` + 12px 圆角 + 12px/20px 字号 ——
    与隔壁官方 ContextMeter 面板（`JObwrW_panel`，同处输入栏 trailing 区）逐项对齐；
  - 折叠按钮：28px 高 / 999px 圆角 / `--dsw-specific-selector` 底，
    hover 与展开态用 `--dsw-alias-interactive-bg-hover-solid` —— 对齐官方紧凑控件（`.add`）；
  - 状态色：`--dsw-alias-state-error-primary`（无人管图）/
    `--dsw-alias-state-success-primary`（辅助管图）/ `--dsw-static-deepseek-450`（主模型管图）；
  - select：`appearance:none` + 官方同款 chevron SVG（`#81858C`）+
    `--dsw-alias-bg-layer-2` 底 + `--dsw-alias-border-l2` 边框；
  - 文字层级统一 `--dsw-alias-label-primary/secondary/tertiary`。
- 样式改由 `ctx.effect` 注入一个 `<style>`（`.dsh-dual-model-*` 前缀，与 canvas / ssh 线
  惯例一致），随插件生命周期移除；hover / :focus-visible / accent-color 等 inline style
  表达不了的状态由此覆盖。

**二、信息设计**

- 折叠态标签：「主 ▸ 辅」双短名（补回设计文档 §5.2 的原意，此前只有辅助名且截断 22 字符、
  挤压输入框）；短名截断收紧为 16 字符；草稿有附件时尾部追加 `·N` 计数。
- 面板新增**主模型行**与「看图 / 纯文本」能力徽标（host 早已提供
  `primary` / `primaryVision` / `assistVision`，此前未展示）——"图片交给谁"终于有对照。
- 结构调整为：头部（标题 + 副标题）→ 主模型行 → 辅助模型行 → select（+ 空态提示）→
  图片归属状态条 → 底部「启用双模型」开关 + 保存中提示。
- 下拉 option 文案由 `name · id` 收俭为 `name`（完整 id 移至 option title）。

**三、交互补全**

- Esc 关闭、点击面板外关闭（mousedown capture + contains 判定），监听随 `open`
  注册/销毁，符合 effect 可逆纪律；
- `aria-haspopup="dialog"` + 面板 `role="dialog"` / `aria-label`；
- 保存中在下拉、开关、提示位三处可见。

## 2026-09-22

### 0.1.1-miasaki.0 — 修复「配置模型」控件渲染崩溃（根因：标准 hook 无 selector 调用）

**症状**：输入框右下角「双模型」控件完全不渲染，浏览器控制台持续报
`TypeError: l is not a function` → `slot entry crashed in 'conversation.input.right'`。

**根因**（堆栈定位到 bundle 第 11727 行 `a = l(a)`，即
`useSyncExternalStoreWithSelector` 内 `selector(nextSnapshot)`）：
`client.js` 以 `props.useInput()` **无参**调用标准 kit hook。cordis-client-runner 的
`bindSnapshotSelector` 把入参**原样透传**给 `useSyncExternalStoreWithSelector`
（无 identity 兜底），selector 为 `undefined`，订阅回调触发即抛
「selector is not a function」，整个控件被 error boundary 吞掉。
设计文档 §5 只列了 props 名，未记录「SnapshotSelectorHook 必须带 selector」这一契约。

**修复**：
1. `useInput` 改为带 selector 调用：`useInputHook((s) => s?.attachmentIds?.length ?? 0)`；
   缺失时以常量兜底钩子 `() => 0` 保持 Hook 调用顺序稳定。
2. 修正字段名：`InputState` 的草稿附件字段是 **`attachmentIds`**（原代码读 `imageIds`，
   恒为 undefined，附件计数永远是 0）。本槽位 kit 不提供 `resolveDraftAttachments`，
   无法细分图片/文件，文案随之由「N 张图片」改为「N 个附件」（计数可上报的上界）。
3. 设计文档 §5 追加「标准 hook 必须带 selector」的契约注记（见 2026-09-10 文档附录）。

**验证**：真实 GUI 重载后按钮渲染、面板展开、状态行与 10 个视觉模型下拉全部就位，
控制台不再出现该 TypeError；host 路由 `/dual-model/api/state`  unchanged。
`npm test`（host 侧 lib 单测）本机沙箱禁用子进程 spawn（EPERM），未跑；
本次改动仅 client.js，不触及测试覆盖的 lib/。

## 2026-09-10

### M1 实现（首次落代码）

**新增插件 `@miasaki/dsh-dual-model`**（`link:` 方式装入 DSH web profile）：

| 文件 | 职责 |
|---|---|
| `index.js` | Host 半：提供 `dualModelVisionRoute` 可选服务、每步图片上下文、`agent/request` 路由、`/dual-model/api/*` JSON 路由 |
| `client.js` | Client 半：`conversation.input.right` 控件（状态点 + 辅助模型选择 + 图片归属状态行） |
| `lib/content.js` | 图片内容检测，与官方 `contentHasImage` 同语义（含 `tool-result` 嵌套下钻） |
| `lib/routing.js` | 路由决策纯函数：`normalizeRoute` / `decideRoute` / `applyRoute` / `supportsImage` |
| `lib/capability.js` | 图片能力真值源读取 + TTL 缓存 + 事件失效 |
| `lib/store.js` | 插件自有配置的原子持久化（不依赖 DSH settings 服务） |
| `test/` | 24 项单测（路由决策 / 内容检测 / 配置归一化与往返） |

**关键技术决策与依据**：

1. **路由判据取自 `agent/pre-step` 而非 `agent/request`**。官方 `prepareRequest` 的契约是
   "Resolve request config ... **before admitting model-visible input**"，即 `agent/request`
   触发时本步新消息尚未进入 Session，那里读不到图。`agent/pre-step` 的 payload 带本步消息，
   历史由 `session.deriveMessages()`（官方组装请求用的同一个调用）补齐。
   → 该设计同时天然覆盖了「同 turn 后续步骤」与「后续 turn 引用旧图」两种粘住场景，
   且图片被 compaction 清理后会自动回落到主模型，无需额外的粘住状态机。
2. **切换时清空继承的 `reasoningEffort`**：官方 `resolveCallConfig` 对"模型不支持的努力等级"
   是硬拒绝（reject before provider I/O），与官方 `installModelSelection` 的处理一致。
3. **不依赖 `@deepseek-ai/schemastery`**：本插件以 `link:` 装载时该包不在其模块查找链上
   （Node 按符号链接真实路径解析），一旦解析失败会拖垮整个 profile 的加载。改用自持久化，
   与 sidebar / ssh 两条线的既有约定一致。
4. **client 半无 `host.call`**：正式插件的 client bundle 由 `window.__ModuleLoader__.load` 装载，
   通信走同源 JSON 路由 `/dual-model/api/*`（`fetch`），且不能 require 第三方包。

**新增运行时补丁 `patches/dsh-api-session-controller/`**：

- 把 `session.prompt` 的图片准入判定委托给 `dualModelVisionRoute` 可选服务；
- **零退化**：服务不存在时走与原生逐字节相同的分支（含错误信息），裸 DSH 行为不变；
- 1 条编辑（`replaceRange`，2 行 → 12 行），规则 + 双基线入库，`patch.mjs verify` 离线自证；
- 基线：DSH `0.1.5-rc.1`，原始 `16ECB48F…` → 补丁后 `58574E8A…`。

**M1 落地状态**：补丁**已应用**到安装目录（`patches/dsh-api-session-controller` 的 `status` 为 `patched`，
备份 `.dsh-bak` 可 `revert`）；插件**已注册**进 `%USERPROFILE%\.dsh\profiles\web`（`link:` 依赖 + `dsh.profile.bundles`，
符号链接已建立）。**重启 `dsh web` 后 host 半与补丁同时生效**（两者都只在启动时加载）。

### M0 验证（同日早些时候）

用动态 Cordis 插件在真实运行环境实测六项技术假设，**全部成立**：

| # | 假设 | 结论 |
|---|---|---|
| 1 | `agent/request` 可被插件在 agent scope 挂上 | 6 个 live agent 全部挂上并捕获到真实触发 |
| 2 | `conversation.input.right` 可挂载渲染 | client 组件挂载并回调 host 3 次 |
| 3a | host↔client 能力通道 | `harness.handle` ↔ `host.call` 可用 |
| 3b | `ctx.provide` 作为补丁读取通道 | 可用，**异步生效**（不影响补丁：读取发生在用户交互时） |
| 4 | Agent 注入 API 存在 | `followup` / `steer` / `inject` / `send` / `cancel` 齐备 |
| 5 | 能力真值源可用 | `resolveModelInfo().inputModalities` 正常返回 |

**顺带实测出的环境事实**：9 个 provider / 59 个模型中，`openrouter` 的 **21 个免费模型全部不支持图片**
（`visionCount: 0`）—— 这正是本功能的目标场景；另有 16 个视觉模型可用。所有模型的
`inputModalities` 均非 `undefined`，即准入判定是确定性的。

### 设计定稿

- `design/2026-09-10-dual-model-design.md`：现状取证（带源码行号）、核心冲突分析、
  三条准入路线对比与补丁形态选型、架构与 UI 设计、风险清单、分期计划、M0 实测结果。

**准入路线复议记录**：最初选定「客户端分流、零补丁」，实现层推演发现不可行
（`conversation.input.right` 是加法槽，只能加控件不能接管提交；能接管提交的只有
`conversation.composer`，需重写整个输入框），遂复议为「一行本体补丁 + 可选服务探测」形态。
