# DSH 升级评估（增量）：0.1.7-alpha.2（实测）

- 日期：2026-09-23
- 当前运行：`@deepseek-ai/dsh@0.1.5-rc.1`
- 候选：`0.1.7-alpha.2`（`alpha` 轨）／`0.1.5-rc.2`（`latest`）／`0.1.5-rc.3`（`next`）
- 上一版评估：[`dsh-0.1.6-upgrade-assessment-2026-09-21.md`](dsh-0.1.6-upgrade-assessment-2026-09-21.md)（0.1.6-alpha.2 实测，补丁/槽/事件全量核对）
- 配套（同日官方仓库复查）：本文 §2/§6/§7 即源码级结论；`gh` 只用于拉快照与 API 元数据
- 方法：与上两版同法并升级——`vendor/deepseek-harness`（= 0.1.6-alpha.2）**并排保留**、
  `vendor/deepseek-harness-0.1.7-alpha.2` 新快照（10,799 文件 / 34.4 MB zip），
  所有「两版之间变没变」为**本地逐字节 diff**；6 个补丁对 **0.1.7-alpha.2 真实 npm 产物**逐个跑 `apply`

> **【实况更新 · 2026-09-23 晚】升级已实际发生，且早于本文触发条件**：本机全局 DSH 已实装
> **0.1.7-alpha.2**（`dsh --version` 实测；`next` 轨仍为 `0.1.5-rc.3`，触发的「0.1.7-rc.*」
> 条件并未满足，用户直接升了 alpha）。代码侧两处适配（§7.3/§7.4）均已落地；第三方
> browser-playwright 补丁（§7.11）已 apply 并实机验证；**六个旧基线补丁当日全部
> `rebuild-baseline` 重打至 0.1.7-alpha.2（`EDITS` 零改，`verify` 6/6 PASS，
> live `status` 全部 `patched`）**——机械流程与逐项 SHA 见 desktop 线
> `design/CHANGELOG.md`「2026-09-23（晚）」条。剩余事项收敛为**实机验收**
> （host 侧两补丁需重启 `dsh web` 生效；注意重启会断开当前 harness 会话）与 §7.10 文档债。
> 本文以下内容为升级**前**的评估记录，除本节外未回改。

---

## 0. 结论

**评估范围从「0.1.6 要不要升」推进到「0.1.7-alpha.2」：补丁侧比 0.1.6 更便宜、代码侧出现第一个真实破坏点、
收益侧首次出现与本仓直接相关的正向项。升级触发条件仍不满足。**

| 项 | 09-21（0.1.6-alpha.2） | **09-23（0.1.7-alpha.2）** |
|---|---|---|
| 6 个补丁 apply | 5 个零改动、1 个需适配（已完成） | **6/6 零改动 apply 成功**（双代变体自动选中 0.1.6 分支） |
| 补丁 verify（离线） | 6/6 PASS | **6/6 PASS**（未再核，沿用；本次 apply 成功即证明） |
| 槽契约 | 13 注册点零命中 | **7 个关键槽逐项核对零变化** + kind 裁决规则零变化 |
| 事件签名 | 10 个事件 9 个逐字相同 | **9 个相同；`settings/updated` 在 0.1.7 被移除** → dual-model 命中（§7.3） |
| 代码必改点 | 零 | **2 处小改**：dual-model `index.js:181` 监听失效（§7.3，`a956776` 已落地）+ desktop 两插件 settings 读取双轨（§7.4，已落地）；另 desktop 有一套 **directional** 机制迁移（预设组合包化，§7.9，不绑升级） |
| 收益 | 零（撞卖地为主） | **首次出现净正向**（§9）：官方终端 Recovery/Cleanup 停止注册，09-21 登记的「半遮蔽」隐患消失 |
| 触发条件 | `next` 出现 `0.1.6-rc.*` | **改为 `next` 出现 `0.1.7-rc.*`**（当前 `next = 0.1.5-rc.3`，未触发） |

一句话：**升到 0.1.7-alpha.2 的成本比 0.1.6 更低（补丁 6/6 全过、槽零改、事件仅一处需适配），且消解了一个既有隐患；
代码侧两处小改（dual-model 监听 + desktop 两插件 settings 读取）均已双轨落地，desktop 另有一套预设机制迁移排队。alpha 轨稳定性未验、`sidebar`/`ssh` 撞卖地决策未拍板，结论仍是「等 rc」。**

---

## 1. 评估口径与本地事实 `[实测]`

| 项 | 值 |
|---|---|
| 本地运行版本 | `0.1.5-rc.1`（`~/.dsh/profiles/web` + 5 个 `link:` + 5 个 `file:` + 3 个 npm 插件） |
| npm dist-tags（09-23） | `latest = 0.1.5-rc.2`；`next = 0.1.5-rc.3`；`alpha = 0.1.7-alpha.2` |
| GitHub HEAD | `00102833d`（2026-09-22T15:25Z，release merge），**09-22 以来无新提交** |
| 本地版本 → 候选 | 5 个 release、约 3,152 次提交（`compare` API） |
| 快照 | `vendor/deepseek-harness`（0.1.6-alpha.2，未动）+ `vendor/deepseek-harness-0.1.7-alpha.2`（新） |

---

## 2. `0.1.6-alpha.2 → 0.1.7-alpha.2` 改了什么 `[实测，源码级]`

`packages/` 树 diff：**3,613 文件、+129,957 / −174,403 行**（顶层无增删包，均为重组/内容变化）。
按对本仓相关度归类：

| 类别 | 内容 | 与我们的关系 |
|---|---|---|
| 设置机制重写 | `settings/updated` 事件**全树消失**；新事件 `settings/document-updated`（RAW 文档层）；`app-boot/config-reload`；「设置改由当前 Profile 插件配置保存，旧 settings.yaml 一次性导入」 | **命中 dual-model**（§7.3）+ desktop 三插件的 `dsh-settings` peer 用法待查 |
| 会话侧栏改版 | 会话置顶/归档/筛选/搜索恢复；归档运行中会话列影响项 | 纯增量，与我们无注册冲突 |
| 新增设置分区 | 工作过程展示 / 性能与用量 / 开发者工具；设置导航独立滚动 | `settings.section` 契约未变（§6） |
| 工作过程/后台任务 | 连续思考与工具调用合并可折叠；后台命令超时转后台；工作流后台运行；后台任务展开实时输出 | 纯增量 |
| 文件审阅 | 回合结束改动卡片悬停单栏 diff；左右分栏默认 + 同步滚动 | 与 sidebar 审查 tab **并行存在**（0.1.6 已登记） |
| 预览 | Excel 只读预览（XLSX/XLS/CSV/TSV）；PDF/Office/图片统一缩放 | 0.1.6 Office 预览的延续，撞 sidebar/ssh 卖地 |
| 官方终端退场 | `ui-sidebar-terminal/src/client/index.ts` 的 `TerminalRecovery`（header.actions）与 `TerminalCleanup`（shell.overlay）**被官方自己注释掉**（`:84-85`、`:105-106`） | **净正向**：09-21 §5 登记的「半遮蔽」隐患消失 |
| 模型/API | 官方 DeepSeek 适配器 Messages-only；模型发现可读名 | 本仓 `llm-deepseek: {}` 空配置 → 无影响（§7.8） |
| vendor 管控 | Cordis 等 vendor 包自动依赖更新限制在同次版本补丁内 | 安装侧，无代码影响 |
| spill 策略 | 工具返回按 token 预算截断；`maxInlineBytes` → `maxInlineTokens` | 本仓无自定义 `spill-policy` → 零命中 |
| 会话日志 | V3 → **V4**（新批量迁移工具） | 历史会话一次性升级；**降级路径进一步变远**（§10 回退注记） |

---

## 3. 实测一：6 个补丁在 0.1.7-alpha.2 真实产物上 apply `[实测]`

目标产物来自 `npm pack`（6 包全部 `v0.1.7-alpha.2`），对**副本**运行 `patch.mjs apply --target … --yes`：

| 补丁 | 目标文件 | 0.1.7 原始 | apply 后 | 增量 | 结果 |
|---|---|---:|---:|---:|---|
| `dsh-client-ui-chat` | `lib/client.js` | 514,483 B | 516,347 B | +1,864 | ✅ 锚点全命中 |
| `dsh-client-ui-conversation` | `lib/client.js` | 701,296 B | 701,421 B | +125 | ✅ 锚点全命中 |
| `dsh-client-ui-settings-models` | `lib/client.js` | 184,096 B | 199,566 B | **+15,470** | ✅ **双代变体自动选中 `model-row` 分支** |
| `dsh-client-ui-trajectory` | `lib/client.js` | 417,494 B | 419,358 B | +1,864 | ✅ 锚点全命中 |
| `dsh-cordis-host-runner` | `lib/index.js` | 102,835 B | 103,592 B | +757 | ✅ 锚点全命中 |
| `dsh-api-session-controller`（dual-model） | `lib/index.js` | 120,880 B | 121,625 B | +745 | ✅ 锚点全命中 |

对照 09-21 记录（alpha.2 原始大小），0.1.7 的 client bundle 普遍大涨
（chat +38.2%、settings-models +31.1%、conversation +7.1%），
**锚点区域之外的增长没有波及任何一条编辑**。

> `settings-models` 是本次唯一重点：09-21 时它在 alpha.2 上锚点失效、当日完成「双代变体」适配
> （variants + probe，0.1.5 走内联 JSX、0.1.6+ 走 ModelRow props）。
> 本次 apply **未报「没有任何变体的探测锚点命中」**，说明官方 UI 结构仍在该变体已知的第二代内。
> 这与 09-21 清单 §9 第 7 步的预判一致。

## 4. 实测二：补丁离线 verify 6/6 PASS `[实测]`

`node patch.mjs verify` 逐个跑（基于 0.1.5-rc.1 baseline，纯离线）：6 个全部 PASS，
含语法闸门与行为断言（chat/trajectory 恢复逻辑 8/8、host-runner 拒绝应答 + 超时兜底两组含区分力）。
**补丁自身健康零变化**——本次 apply 成功证明「升级适配」是增量换 baseline，不是排障。

## 5. 实测三：0.1.5-rc.2（当前 latest）顺带核对

（沿用 09-21 §4：rc.2 对补丁零阻力、收益为零，本版无新事实，不重复实测。）

---

## 6. 槽契约逐项核对：7 个关键槽零变化 `[实测，源码级]`

声明源：两版 `packages/client/**`（0.1.6-alpha.2 vs 0.1.7-alpha.2）。

| 我们的注册点 | 所在线 | 0.1.6-alpha.2 契约 | 0.1.7-alpha.2 契约 | 判定 |
|---|---|---|---|---|
| `conversation.session.header.actions` | canvas / ssh | list / session | list / session（apply.ts 逐字一致） | ✅ 未变 |
| `conversation.session.header.utilities` | desktop·session-log-move | list / session | list / session | ✅ 未变 |
| `conversation.input.right` | dual-model | list / session | list / session | ✅ 未变 |
| `conversation.view` | desktop·token-monitor | list / session | list / session | ✅ 未变（owner 新增 `inspectCall` 为加法） |
| `sidebar.right.pane.tab`（key = 类型 id） | sidebar | keyed / session | keyed / session（含 `tabInfo` hook 注入，两版一致） | ✅ 未变 |
| `settings.section` | appearance / pet-panel / free-model-pool | list / root / `{close}` | **逐字节一致**（`SettingsSectionOwnerProps{ close }` 两版相同） | ✅ 未变 |
| `shell.overlay` | ssh / token-monitor | list / root | list / root | ✅ 未变 |
| `sidebar.footer.action` | token-monitor | list / root | list / root（`ui-sidebar/contract/slots.ts` 两版仅差假期无） | ✅ 未变 |
| `sidebar.right.tab.guide` 家族 | sidebar | chain / session | chain / session | ✅ 未变 |

**kind 裁决规则零变化** `[实测]`：`tab-registry.ts` 两版 diff 仅新增可选字段 `keepMounted?: boolean`；
「extension 压 builtin、同 band 撞 kind 抛错」规则未动。sidebar 线继续**遮蔽官方内置终端**
（且 0.1.7 官方主动注释掉 Recovery/Cleanup，遮蔽态比 0.1.6 更干净）。

**纯增量新槽**（我们均未使用，列出备查）：`conversation.header` / `.header.leading`（scope 改 root）、
`conversation.input.activity`、`settings.plugins.tab`、`sidebar.toggle.badge`。
**签名扩展**（加法，不影响注册）：`ComposerAttachmentsOwnerProps.onAddFiles` 增 `directories?`；
`ComposerBarProps.addFiles` 同。

---

## 7. 0.1.7 破坏性变更对本仓命中情况

### 7.1 release note 明写的 6 条逐条比对

| 变更 | 本仓命中 | 证据 |
|---|---|---|
| `spill-policy.maxInlineBytes` → `maxInlineTokens` | **零命中** | `~/.dsh/settings.yaml` 全文 597 行无 `spill-policy` 段（实测通读） |
| Session 日志 V3 → V4 | 一次性迁移，非代码命中 | 0.1.5 已从 V2→V3 迁过一次；升 0.1.7 会再迁一次（§10 注记） |
| 官方适配器 Messages-only | **零命中** | `llm-deepseek: {}` 空配置，无 protocol/baseURL 旧覆盖；本仓模型走 `llm-pi-ai` 第三方 provider（step / openrouter / opencode / xiaomi / wxxcx），与官方适配器解耦 |
| 自定义事件附件不再自动读取/导出 | **零命中** | 全仓 grep `customEvent` / `writeEvent(`：0 处 `[实测]` |
| Remote 文件接口统一 `readBytes` | **零命中** | 全仓 grep `readBytes` / `.readFile(`：仅 dual-model 补丁 baseline（@deepseek-ai 官方产物副本）命中 2 处，本仓七条线零使用 `[实测]` |
| vendor 自动更新限制补丁级 | 安装侧 | npm 锁文件层面，无代码影响 |

### 7.2 设置/预设机制迁移（nuisance 级，不是代码破坏）

| 机制 | 0.1.6 及以前 | 0.1.7 | 本仓应对 |
|---|---|---|---|
| 设置存储 | `~/.dsh/settings.yaml` | 当前 Profile 插件配置；**旧 yaml 仅一次性导入** | 用户 settings.yaml 有大量自定义（llm-pi-ai 7 个 provider、openrouter 40+ 模型、agent-default-model、subagent-model-selection）——**升级后必须逐项核对导入结果**（§10 清单） |
| Agent 预设 | 目录式（`~/.dsh/.agent-presets/<id>/preset.yml` + `agent.cordis.yml`） | **插件组合包声明**，旧目录预设需迁移 | desktop `preset-sources/`（3 套 persona + apply-presets.ps1）需重做成插件组合包；**属 directional 迁移，不是崩溃级** |
| 插件安装/管理 | profile `file:`/`link:` + 重启 | 官方插件管理页 + 运行时依赖解析/卸载 | 我们的 `file:`/`link:` 方式 0.1.7 仍支持（0.1.7-alpha.1 release note 明写「修复……支持 link 到本地开发中的插件」）→ 可继续用，但长期方向是迁移 |

### 7.3 唯一代码破坏点：dual-model 的 `settings/updated` 监听 `[实测]`——**已于 a956776 适配落地（2026-09-23 13:15）**

- 本仓：`dsh-miasaki-dual-model/index.js:181` —
  `ctx.effect(() => ctx.on('settings/updated', () => capability.invalidate()), 'dual-model: settings invalidation')`
- 0.1.5/0.1.6：`'settings/updated'(ns, next, prev, source): void`（`packages/settings/settings/src/types.ts:92`）
- 0.1.7-alpha.2：**该事件定义在全树消失**（grep `settings/updated` 两版全 packages：0.1.6 有 19 处、0.1.7 **0 处**），
  settings 包只剩 `'settings/document-updated'(ns, revision)`（RAW 文档变更语义，与旧「resolved 值深比较」语义不同）。

**影响定级：低-中（行为退化，不崩溃）**：
capability 索引的权威数据来自 `llm.listProviders()/llm.listModels()`（两版签名逐字相同，实测 §8），
`settings/updated` 只是缓存击穿信号之一（另一路 `llm/adapters-updated` 两版均在）。
最坏情况：用户改 llm 设置后能力缓存**最多延迟 5 分钟**自然过期（TTL），不会报错、不会显示错误能力。

**适配落地（commit `a956776`，版本 0.1.3-miasaki.0）**：新增 `lib/invalidation.js`
（`SETTINGS_INVALIDATION_EVENTS = ['settings/updated', 'settings/document-updated']` +
`watchSettingsInvalidation(ctx, invalidate)` 双轨监听、合并 disposer），`index.js` 单监听改为
`ctx.effect(() => watchSettingsInvalidation(ctx, () => capability.invalidate()))`。
**双轨而非版本探测的依据**：cordis 的 `ctx.on()` 监听无人发出的事件是无害空操作（实测
cordis 4.0.2 与 4.0.4 均不抛错、正常返回 disposer）——两个名字都注册，哪套机制在场就哪套命中。
新事件比旧事件更敏感（RAW 文档变更即触发）：多余的 invalidate 只是清一次缓存，下次快照自然重扫，
无正确性影响。测试 5 条（`test/invalidation.test.js`：双注册/双轨触发含 0.1.7 payload 形状/
无关事件不误触发/dispose/幂等），dual-model 全套 29/29 通过。

### 7.4 desktop `file:` 插件的 `dsh-settings` peer 用法 [实测]——**已适配（2026-09-23 当日闭环）**

profile 内 `node_modules` 实测：`dsh-free-model-pool`、`dsh-model-probe`、`dsh-pet-panel`
三个插件声明 `@deepseek-ai/dsh-settings: ^0.1.2-rc.1` peer。其中**真正调用 settings 服务
运行时 API 的是前两个**（pet-panel 的 host 半是空壳、client 半走 slots + 自有持久化，
零 settings 用法）；0.1.7 重写后 `ctx.settings.get(ns)` 全树移除，两者命中：

| 插件 | 旧用法 | 0.1.7 症状（线上实证） |
|---|---|---|
| `dsh-free-model-pool` | `ctx.settings.get(NS)` ×2 无保护（`listPlatforms` / `/apply`） | `GET /freepool-api/status` 原样返回 `ctx.settings.get is not a function`——**设置页模型栏免费模型池面板整块报错** |
| `dsh-model-probe` | `ctx.settings.get(NS)` ×1 有 try/catch（`resolveProfile`） | 异常被吞 → 已保存行档案读不到 → 探测静默退化成 `no-credential` / `no-endpoint`（ Models 页请求体只带草稿值，已保存行全靠这次读） |

**适配落地（与 dual-model 的 `a956776` 同款双轨修法）**：两插件各新增 `lib/settings-read.js`，
`readSettingsSection(ctx, ns)` 按 `typeof settings.get === 'function'` 探针分轨——≤0.1.6 走
`get(ns)`（逐字旧路，抛错 posture 不变），0.1.7+ 走 `describe().find(d => d.ns === ns).value`
（profile 条目 Config 投影；已核对 0.1.7 快照 `llm-pi-ai` 的 `Config.providers` 是 volatile
字段，写路径 `update(ns, patch)` 两代同名同义故原样保留）。版本 free-model-pool 0.3.1 /
model-probe 0.2.1；新增 27 例单测（helper 契约 + 路由级/probeModel 接线，fetch 打桩），
`verify-all desktop` 11 → 17 项全过。实机验收 = 重启桌面端后模型栏两项恢复（§10 第 8 项）。
peerDeps `^0.1.2-rc.1` 声明债维持 §7.10 结论（`link:`/`file:` 安装不触发 peer 校验）。

### 7.5 内置浏览器默认关闭：零命中 `[实测]`

ssh 线的页面内交互连接全部走**自建 DOM iframe**（`dsh-miasaki-ssh/client.js` 的 body 级宿主 +
`<iframe title="SSH">` + `/ssh/` 自托管页面，懒加载），canvas 的 `/canvas/` iframe 同理（外部视图槽自托管）——
均与官方内置浏览器（`ui-sidebar-browser`）零耦合。「Web 默认关闭内置浏览器」只改变用户点聊天链接的默认打开方式，**无代码命中**。
**同向发现** `[实测，子代理线扫]`：desktop 本就以 `dsh web --no-open` 拉起 Web（`src-tauri/src/main.rs:404-405`，
与 Tauri WebView2 双窗口），0.1.7 把内置 Web 默认关掉与该现状**同向**——`--no-open` 可能变冗余但无害（[待确认] 无破坏）。

### 7.6 七条线影响总表 `[实测汇总]`

| 线 | 0.1.7-alpha.2 影响 | 级别 | 必改 |
|---|---|---|---|
| **canvas** | `session/created` / `session/event` / `header.actions` 三契约零变化；`snapshotEvents` 有 `typeof` 守卫 | 低 | 否 |
| **sidebar** | `sidebar.right.pane.tab` + guide 家族零变化；kind 裁决规则零变化（继续遮蔽官方终端，且官方 Recovery/Cleanup 已注释，遮蔽态更干净）；官方 Office/浏览器/Subagent/审阅 tab 继续撞卖地 | 低（代码）/ 中（方向） | 否（`priority: 'extension'` 显式化已于 09-21 完成） |
| **ssh** | `header.actions` / `shell.overlay` 零变化；自建 iframe 与内置浏览器解耦；官方浏览器 tab 仅撞卖地 | 低 | 否 |
| **dual-model** | `settings/updated` 移除 → 缓存击穿信号少一路（最坏 5 分钟 TTL 延迟）；`agent/*` 四事件 + `llm.*` 四方法签名逐字相同；图片准入补丁锚点（`resolveModelInfo().inputModalities`）**本次已在 0.1.7 真实产物 apply 成功**（§3），子代理标记的「补丁锚点待实测」闭环 | **低-中** | **是（1 处监听，< 1h）** |
| **appearance** | `settings.section`（含 `{close}` owner）与 `webserver/index-inject` 零变化；但本线总开关/配置在 profile 插件配置迁移后需核对 | 低 | 否 |
| **desktop** | 6 个本体补丁 apply 全过、verify 6/6；`preset-sources/` 目录式预设面临组合包化（directional）；free-model-pool / model-probe 的 settings 读取已双轨适配（§7.4，27 例单测，实机待重启验收），pet-panel 零 settings 用法不受影响 | 中 | 否（升级时）；预设迁移另立专题 |
| **fleet** | 多代理 CLI 编排线与 DSH web 插件面基本不相交（仓内文件总线，零 DSH 运行时依赖）；0.1.6 起 Ralph 默认关闭/Team `spawn_teammate` 已登记 | 低 | 否 |

### 7.8 本仓 settings.yaml 迁移核对（用户配置层，非插件代码） `[实测]`

七条线（含 desktop 五插件）的持久化**全部自管**（`~/.dsh/miasaki-*` / `~/.dsh/plugins-data` /
浏览器 localStorage / 仓内总线），无任何一线读写 DSH `settings.yaml`——dual-model 甚至刻意不注册
settings 命名空间（`lib/store.js:1-7` 注释：schemastery 符号链接解析问题）。
故「settings 改存 profile 插件配置」对**插件代码零影响**；唯一要核对的是用户自己的 DSH 配置导入结果：

| 字段 | 迁移判断 |
|---|---|
| `ui-onboarding.welcomeNoticeVersion` | onboarding 会在 0.1.7 重放（新引导）——预期行为 |
| `agent-default-model`（step / step-5-preview） | 需核对导入后仍生效 |
| `ui-theme`（preference/fontSize） | 需核对 |
| `llm-pi-ai.providers`（7 个第三方 provider、openrouter 40+ 模型明细） | **重点核对**：导入器是否完整搬运 provider 数组与模型级 compat |
| `subagent-model-selection`（deepseek-v4-flash-vision-exp） | 该模型 0.1.6 起从**默认列表**移除，自定义引用一般仍可用，**实机核对** |
| `llm-deepseek: {}` | 空配置，无旧 protocol 要清理 |

### 7.9 预设组合包化迁移（desktop directional 工程，本仓最大的机制迁移） `[实测，仓内核到；0.1.7 新格式待确认]`

现状安装链 `[实测]`：

- `dsh-miasaki-desktop/preset-sources/apply-presets.ps1`：从仓内模板 `agent.base.cordis.yml`
  （0.1.5 `standard` 底座全文 + 本仓自定义，273 行）取 `__PERSONA__` 占位符替换为 `*.persona.txt` 正文，
  写入 `~/.dsh/.agent-presets/{whale,kurumi,inverse}/agent.cordis.yml`；`*.preset.yml`（name/description/order
  三行）原样写成同目录 `preset.yml`。即安装的是**目录式预设**。
- `verify-presets.cjs:41-80`：js-yaml 解析产物并断言 persona.config 含 prefix、`{{model}}`/`{{cwd}}` 占位、
  `tool-web.fetch=false` 等。脚本头 L7-17 留有 0.1.5 persona 拆分（prefix/suffix）的迁移教训与底座升级流程。
- **易漏命中** `[实测]`：`dsh-free-model-pool/lib/index.js:340-374` 的 `/freepool-api/subagent` 路由
  直接**行式 regex 改写** `~/.dsh/.agent-presets/<id>/agent.cordis.yml` 的 `agentOptions:` 下
  provider/model/maxTokens 三行——0.1.7 组合包声明格式若变，该补写必然失配。

迁移判断：**需要迁移（desktop）**，但不与升级绑定（0.1.5 下旧式仍可用，可升完再迁）：
① `agent.base.cordis.yml` 与产物两文件按 0.1.7 组合包声明重出；② `verify-presets.cjs` 断言重写；
③ free-model-pool 的行补写改面向新声明结构。**前置未知项**：0.1.7 `dsh-agent-presets` 的新产物格式
（官方 release note 未给样例）——**升级后第一件事是拉新包看格式**。

### 7.10 peer 依赖与文档版本声明债 `[实测]`

| 项 | 事实 | 处置 |
|---|---|---|
| web 五线 package.json | **零** `@deepseek-ai/*` 依赖（canvas/sidebar/ssh/dual-model/appearance 逐个 read 确认） | 无债 |
| desktop 五插件 peerDeps | 三插件钉 `@deepseek-ai/dsh-settings: ^0.1.2-rc.1`（+host-webserver 两枚、cordis 全体）——**已陈旧于在跑的 0.1.5-rc.1**，靠 `link:` 安装不触发 peer 校验才无事 | 升级顺带 bump（desktop README:285-287 有 0.1.2 对齐记录；0.1.7-alpha.2 作为 prerelease 按 semver 不满足该 range） |
| README 版本声明 | canvas 锁 `0.1.2-rc.1`（README:13 + zh-CN README:8，最旧）；sidebar/dual-model/desktop 五补丁 README 锁 `0.1.5-rc.1`（SHA 钉死）；ssh/appearance/fleet 无正式声明 | 升级后更新：canvas 声明 + 五补丁 README 的 baseline/SHA 段 |

### 7.11 已处置：third-party `@yeesy369/dsh-browser-playwright` 0.8.1 两半全拆（本地补丁）`[实测]`

**这不是本仓代码，但升级后第一个炸的就是它**——本机已在实际跑 0.1.7-alpha.2 的 profile 里命中并处置：

| 半 | 坏点（0.1.7） | 后果 |
|---|---|---|
| client（`lib/client.js`） | `inject` 依赖已移除的 `settingsScope` 服务 | web 前端 boot loader 对任何非 active 的 client 条目**直接抛错停启动屏**（`Failed to load plugins` / `web boot: 1 entry did not activate`）——web UI 完全打不开。host 侧同款审计只 warning（`dsh-app-boot:auditStartupEntries`），**两级严重性不同** |
| host（`lib/index.js`） | `settings.register(...)` API 没了（服务还在、inject 过得去） | `apply` 抛 TypeError，provider 纤维失败 → `ctx.browser` 不 provide → `dsh-tool-browser` 整条 pending，浏览器工具全灭 |

**新机制要点**（与 §7.2 同源，补丁实现的地基）：配置即 profile entry 的 Cordis 配置；`Config` 里 `.volatile()` 字段由 `dsh-settings` 的 `describe()` 暴露；client 侧新服务 `configForms`（`get(NS)` 读、`mutate(ops)` 写）；卡片槽 `settings.plugin.item` → `plugins.item`（侧栏「插件」面板渲染）；自带页插件按 README 在**可选** `ctx.inject(['settings'])` 子 fiber 里 `configure({auto:false}, fiber)`。

**踩坑记录（双轨方案的关键约束）**：cordis 语义实测——父 fiber 访问**未 inject** 的服务必然抛 `without inject`（哪怕服务在祖先 fiber 上）；`ctx.get(name)` 同样取不到。所以可选依赖必须用 `ctx.inject(names, factory)` 子 fiber 承载（缺失只挂起子 fiber），第一版 try/catch 直读方案线上静默失效（冒烟桩复现不了该语义）。

**另一个坑**：profile 的 schemastery 是 3.18.1（无 `.volatile()` builder；CLI 自带 3.18.4 才有），但 `volatile()` 实现就是 `meta.volatile = true`，**结构打标即可**（`dsh-settings` 只读 `meta`/`dict`，跨副本兼容）。

**处置**：本地运行时补丁（双轨：0.1.7 新路 / ≤0.1.6 老路），住处
[`patches/dsh-browser-playwright/`](patches/dsh-browser-playwright/README.md)（patch.mjs + baseline×4 + README；
verify 27 项含双世界 cordis 语义冒烟）。已应用到 profile 并实测：boot 日志干净、无头浏览器实载
web UI 正常、「浏览器窗口」卡片在插件面板完整渲染可交互。npm 上 0.8.1 仍是最新（作者未发兼容版）——
作者发版后删补丁目录、`revert`、升级即可。

---

## 8. 事件签名核对：9/10 逐字相同 `[实测]`

对两版 `packages/extensions/tool-cordis/src/api-catalog.ts` 做 name→signature 集合比对：

| 事件 | 用在 | 判定 |
|---|---|---|
| `agent/created` | dual-model | ✅ 逐字相同（payload 扩展在 0.1.6 已发生，我们只读 `payload.agent`） |
| `agent/disposed` | dual-model | ✅ 相同 |
| `agent/pre-step` | dual-model | ✅ 相同 |
| `agent/request` | dual-model | ✅ 相同 |
| `session/created` | canvas | ✅ 相同 |
| `session/event` | canvas | ✅ 相同 |
| `llm/adapters-updated` | dual-model | ✅ 相同 |
| `llm/stream` | desktop·token-monitor | ✅ 相同 |
| `tools/result` | desktop·token-monitor | ✅ 相同 |
| **`settings/updated`** | dual-model | ❌ **0.1.7 移除**（§7.3） |

另核 dual-model 数据链服务方法：`llm.listProviders` / `llm.listModels` / `llm.getModel` / `llm.getProvider`
四签名两版**逐字相同**——能力索引数据链不受影响。

---

## 9. 收益侧：首次出现净正向

| 0.1.7 能力 | 对我们的价值 |
|---|---|
| 官方终端 Recovery/Cleanup 停止注册 | **净正向**：09-21 登记的「半遮蔽」不一致态（点不到的恢复按钮/空浮层风险）在官方侧消失 |
| 会话置顶/归档/搜索恢复 | 中性（我们无此功能，属体验补齐） |
| 工作过程展示 / 性能设置 / 开发者工具 | 中性 |
| 后台任务展开实时输出 / 超时转后台 | 中性（fleet 线可关注，但不紧急） |
| 文件预览自动刷新 / 改动审阅左右分栏 | 与 sidebar 审查 tab 重叠加深——**撞卖地继续** |
| Excel 预览 / 统一缩放 | 同上，撞 sidebar（右栏 tab） |
| Web 重启后重连修复 | 中性偏正（我们平时也要重启 dsh web） |
| 一次性子代理/后台命令完成不再卡会话 | 中性偏正（fleet/多代理场景） |

**关键判断更新**：0.1.6 时「收益为零、撞卖地为负」；0.1.7 起「半遮蔽隐患消除」是第一个**只升才有的**净收益，
但它尚不足以单独构成升级理由——七条线的真实瓶颈仍是**实机验收未做**，没有一项靠升级 DSH 解决。

---

## 10. 触发条件、成本与执行清单（更新版）

**触发条件（更新）**：`next` 轨出现 `0.1.7-rc.*`。当前（09-23）`next = 0.1.5-rc.3` ⇒ **未触发**。
（09-21 版本文档的 `0.1.6-rc.*` 条件作废——本版取而代之。）

**成本表（更新）**：

| 项 | 评估 |
|---|---|
| 补丁重打 | **6 个全部零改动**（apply 实测成功）；升级时仍要走 `rebuild-baseline` 同步 3 个常量 |
| 代码适配 | **已清零**：dual-model `settings/updated` 双轨监听（§7.3，commit `a956776`，29/29 测试通过）+ desktop free-model-pool / model-probe settings 读取双轨（§7.4，27 例单测，verify-all desktop 17/17） |
| 第三方插件补丁 | `@yeesy369/dsh-browser-playwright` 0.8.1 两半全拆（§7.11）——**已处置**（本地补丁 + 双世界冒烟 27 项），作者发兼容版后卸补丁升级 |
| 机制迁移（directional） | desktop 预设组合包化（§7.9：apply-presets.ps1/verify-presets.cjs/agent.base.cordis.yml + free-model-pool 行补写）——**不绑升级**，0.1.7 新格式确认后另立专题 |
| 配置迁移核对 | settings.yaml 一次性导入后逐项核对（§7.8 表格）——**本次新增的主要人工项**（用户侧配置，非插件代码） |
| 文档债 | canvas README 的 `0.1.2-rc.1` 声明 + 五补丁 README baseline/SHA + desktop 五插件 peerDeps bump（§7.10） |
| alpha 稳定性 | 未知——仍是唯一实质风险 |
| 会话数据 | 升完后**不可降级**（V3→V4 后新建会话旧版读不了）；回退只能回 `~/.dsh` 备份 + dsh 版本，00 后的新会话作废 |
| 沙箱 | 升级必须在沙箱外执行（`%APPDATA%\npm` 与安装目录都不可写）；本会话所有实测均在 `vendor/`（工作区内）完成，未碰安装目录 |

**触发后的执行清单**（在 09-21 版基础上更新）：

1. 收尾所有在跑会话；备份 `~/.dsh` → `~/.dsh-backup-0.1.7-<日期>`（09-21 复核教训：别以为备过）。
2. 沙箱外普通终端：`npm i -g @deepseek-ai/dsh@<target>` → `dsh --version` 核对。
3. 检查 `~/.dsh/settings.yaml` 的导入结果（§7.8 表格逐项）。
4. **先跑回归矩阵里的补丁 verify**（`node scripts/verify-all.mjs` 全覆盖 dual-model ×1 + desktop ×5）——
   六个 `patch.mjs verify` 若报 `unknown`（锚点探测无变体命中）即为第一信号，停下按补丁 README 增补变体，不要继续升。
   **另跑 profile 侧第三方补丁**：`node dsh-miasaki-shared-docs/dsh-platform/patches/dsh-browser-playwright/patch.mjs status`
   （期望 client/host 双 PATCHED；若插件升过版变 UNKNOWN，先 `rebuild-baseline` 再 `apply`，§7.11）。
5. 七条线逐条 `node scripts/verify-all.mjs <line>`。
6. 补丁机械流程（settings-models 已双代适配，`EDITS` 零改）：逐个 `rebuild-baseline.mjs` → 同步常量 → `verify` → `apply` → **刷页面确认「思考强度」「测试连通性」两个控件在位**。
7. **dual-model 缓存失效实机验证**——改一个 llm provider 设置，确认右下角模型能力秒级刷新（最坏等 5 分钟 TTL）。监听适配已落地（`a956776`，§7.3），本项只剩实机确认。
8. **desktop 三插件（free-model-pool / model-probe / pet-panel）设置注入实机验证**（§7.4）。**代码适配已闭环**：free-model-pool / model-probe 的 settings 读取双轨 2026-09-23 当日落地（§7.4 表 + 27 例单测）；pet-panel host 半空壳、零 settings 用法。本项剩余 = 用户重启桌面端后模型栏两项目检（免费模型池面板列平台 / 已保存行测试连通性走真实探测）。
9. 重跑 `preset-sources/apply-presets.ps1`（0.1.7 下若旧目录预设仍被读取则照旧；官方组合包化迁移按 §7.9 另立专题，**第一动作是拉新版 `@deepseek-ai/dsh-agent-presets` 看格式**）。
10. 文档收尾：canvas README 版本声明、五补丁 README baseline/SHA、desktop 五插件 peerDeps bump（§7.10）。
11. 重启 `dsh web`，按 `cross/smoke-test-matrix.md` 走 L2/L3。
12. 回退：`npm i -g @deepseek-ai/dsh@0.1.5-rc.1` + 还原 `~/.dsh` 备份；⚠️ 升级后新建会话作废（V4 不可降级）。

---

## 11. 本轮实测复现方法

```powershell
# 源码快照（新旧并排）
gh release download dsh-v0.1.7-alpha.2 -R deepseek-ai/deepseek-harness --archive zip -O vendor\dsh-v0.1.7-alpha.2.zip
# 解包后改名为 vendor\deepseek-harness-0.1.7-alpha.2

# 6 个补丁目标包（沙箱内 npm 需 --cache 重定向到 vendor/）
npm pack "@deepseek-ai/dsh-client-ui-chat@0.1.7-alpha.2" … 共 6 包 --cache vendor\.npm-offline-probe\cache016 --pack-destination vendor\_probe-0172\pkgs
# 逐包 tar -xzf 到独立子目录（不要解到同一目录——会互相覆盖，本轮踩过）

# 副本 apply + verify
node dsh-miasaki-desktop\patches\<补丁名>\patch.mjs apply --target <副本> --yes
node dsh-miasaki-desktop\patches\<补丁名>\patch.mjs verify

# 槽/事件源码级核对
git diff --no-index vendor\deepseek-harness\packages\client\ui-conversation\src\client\contract\slots.ts vendor\deepseek-harness-0.1.7-alpha.2\…\slots.ts
```

**本轮探针产物**（均在 git-ignored 的 `vendor/` 内）：
`_probe-0172/`（6 tgz + 解包 + 副本）、`.npm-offline-probe/cache016`、`dsh-v0.1.7-alpha.2.zip`。
按惯例**建议在新评估轮回开始后清理**；`deepseek-harness-0.1.7-alpha.2` 快照保留（下一轮「新旧并排」的旧侧）。

---

## 附：与 09-21 两份文档的关系

- [`dsh-0.1.6-upgrade-assessment-2026-09-21.md`](dsh-0.1.6-upgrade-assessment-2026-09-21.md)：评估对象 0.1.6-alpha.2。
  其 §2（settings-models 失效解剖）与 §8（双代变体适配）**仍是当前事实**；其升级触发条件（`0.1.6-rc.*`）已由本版 §10 作废。
- [`dsh-official-repo-review-2026-09-21.md`](dsh-official-repo-review-2026-09-21.md)：官方仓库复查 0.1.6-alpha.2。
  其 §5（kind 裁决/遮蔽规则）经本版 §6 复核**在 0.1.7 依然成立**；其 §5 后果 2（半遮蔽）因官方注释掉
  Recovery/Cleanup 而**消失**。
