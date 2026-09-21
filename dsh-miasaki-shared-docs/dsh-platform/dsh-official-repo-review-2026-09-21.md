# 官方仓库复查（增量）：0.1.6-alpha.2 与 rc.2 升 `latest`

- 日期：2026-09-21
- 调研者：总指挥（Miasaki 会话）
- 上一份同类：[`dsh-official-repo-review-2026-09-16.md`](dsh-official-repo-review-2026-09-16.md)（09-16，0.1.6-alpha.1）
- **配套（同日实测）**：[`dsh-0.1.6-upgrade-assessment-2026-09-21.md`](dsh-0.1.6-upgrade-assessment-2026-09-21.md)
  —— 本文回答「0.1.6-alpha.2 变了什么、影响哪几条线」，该文回答「**现在就升要花多大力气**」（6 个本体补丁
  在 alpha.2 真实产物上逐个跑 `apply` 的实测结果）。
- 口径：`[实测]` = 本次拉 GitHub API / 本地跑命令核到；`[推断]` = 基于证据的判断，本次未做隔离实例实测
- **本轮的方法升级** `[实测]`：`vendor/deepseek-harness` 已同步到 `0.1.6-alpha.2`，且**旧快照（alpha.1）被并排保留**
  在 `vendor/deepseek-harness-0.1.6-alpha.1/`。因此本轮所有「两版之间变没变」都是**本地逐字节 diff**，
  不再依赖 GitHub API 反推或 release note 转述——上一轮的 `[实测，取自 release note]` 一类口径本轮全部升级为源码级。

---

## 0. 摘要

1. **`latest` 抬了一格**：`0.1.5-rc.1` → **`0.1.5-rc.2`**。上次复查把它列为「低风险但低收益、不值得单独升一次」的那一版，
   现在它已是 npm 默认安装版本。实测其**真实代码改动只有 4 个 commit、6 个包**（其余 260+ 文件是版本号联动），**零破坏性变更**。
2. **`alpha` 走到 `0.1.6-alpha.2`**，但 `next` 轨**仍是 `0.1.5-rc.2`**——上次定的升级触发条件（`next` 出现 `0.1.6-rc.*`）**仍未触发**。
3. **五条 web 线的 slot 契约全部未变**：逐项核对（§4）**13 个注册点零命中破坏性变更**。alpha.2 对 `packages/client`
   的 663 个文件改动里，**没有一处动到我们注册的任何一个槽的 kind / scope / owner**。
4. **本轮最重要的新发现是「机制」而非「变更」**：`SidebarRightTabRegistry` 的 kind 裁决规则（§5）——
   一个 kind 最多容纳 `builtin` + `extension` 各一个、**extension 压过 builtin**、**同 band 撞 kind 直接抛错**。
   我们的 `kind: 'terminal'` 与官方内置终端同 kind ⇒ **官方终端被我们遮蔽**。这是 09-16 那次遗漏的关键点。
5. **官方又新增了 4 个与我们撞卖地的包**（`ui-plugin-manager` / `ui-sidebar-browser` / Office 预览 / 侧边栏 Subagent 会话），
   侧边栏的「撞车面」比 09-16 又扩大一圈。
6. **事件契约零漂移** `[实测]`：六条线用到的 10 个事件，alpha.1 与 alpha.2 的签名**逐字全等**（§6）。

---

## 1. 仓库动态 `[实测]`

| 项 | 值（2026-09-21） | 相对 09-16 |
|---|---|---|
| 仓库 | `deepseek-ai/deepseek-harness`（MIT / TypeScript / 默认分支 `master`） | — |
| 最新 Release | **`dsh-v0.1.6-alpha.2`**，published `2026-09-17T13:30:16Z`，prerelease | alpha.1 → alpha.2 |
| master HEAD | `ddefc45fbc7f8e46dd73185e68295696d1297887`（2026-09-17，`release(dsh): 0.1.6-alpha.2`） | **自 09-17 起无新提交** |
| npm dist-tags | `latest = 0.1.5-rc.2`；`next = 0.1.5-rc.2`；`alpha = 0.1.6-alpha.2` | **latest 抬升**（原 0.1.5-rc.1） |
| Star / Fork / Watcher | **231,870** / 27,808 / 996 | +6,222 star（5 天） |
| 对外形态 | Issues 与 PR 均禁用，反馈只走 Discussions | 未变 |

> **发布节奏**：09-15 alpha.1 → 09-17 alpha.2 → **至今（09-21）4 天无新 tag**。`next` 轨停在 09-10 的 `0.1.5-rc.2`。

---

## 2. `0.1.5-rc.2` 到底改了什么 `[实测]`

拉 `compare/dsh-v0.1.5-rc.1...dsh-v0.1.5-rc.2`：**4 个 commit、300 个文件**。

| commit | 说明 |
|---|---|
| `060323d8` | `feat(web): backport feedback and file refinements to 0.1.5` |
| `2107e469` | Merge PR #3973（同上） |
| `a3053034` | `release(dsh): 0.1.5-rc.2` |
| `fb2c4b9e` | Merge PR #3978（release） |

**300 个文件里 260+ 是 `package.json` 的版本号联动**（`packages/**/package.json` 全量跟版）。真实代码改动只有 6 处：

```
packages/client/ui-message-feedback/**     （反馈对话框、提交流程、slots.ts）
packages/client/ui-deliverables/**         （交付文件卡片、TurnTail 间距）
packages/client/ui-primitives/**           （CodeFileIcon + code-file-icon-artwork 清单）
packages/client/ui-chat/**                 （TurnTailNodeView.module.css 间距）
packages/feedback/message-feedback/src/types.ts
apps/web/tests/**                          （4 个 e2e）
```

**结论**：`0.1.5-rc.2` = `0.1.5-rc.1` + 一个纯 web 层 backport。**零 slot 契约变更、零事件变更、零补丁锚点影响**
（`ui-settings-models` / `ui-chat` 的真实代码文件在这一版里**未被触碰**，只有 `package.json` 跟版）。
上次「不值得为它单独升一次」的判断在**收益侧**依然成立；变的是它现在的身份——它是 `latest`，即新装环境的默认版本。

---

## 3. `0.1.6-alpha.2` 相对 alpha.1 改了什么 `[实测]`

本地逐字节 diff：`packages/client` 下 **663 个文件变化，+30,013 / −5,677 行**。按对本仓的相关度归类：

### 3.1 新增的 4 个包（**全部落在我们的卖地上**）★★★

| 新包 | 对应 release note | 与谁撞 |
|---|---|---|
| `packages/client/ui-plugin-manager` | 「新增插件管理页，支持插件安装和修改配置，支持实时开启禁用插件」 | **七条线全部**——插件安装/配置/启停的官方入口出现 |
| `packages/client/ui-sidebar-browser` | 「支持在侧边栏以浏览器模式访问指定 URL」 | `ssh` 线（内嵌 iframe 视图） |
| `packages/client/ui-sidebar-documentpreview/src/client/office/` | 「侧边栏预览 Office 文件（Word/Excel/PowerPoint）」 | `sidebar` 线（右栏 tab 类型） |
| `packages/client/ui-subagent/src/client/sidebar-chat/` | 「支持在侧边栏打开 Subagent 会话」 | `sidebar` / `canvas` |
| `packages/deliverables/`（host 侧包组） | 「回合结束时文件改动卡片 + 侧边栏逐文件对比审阅」 | `sidebar` 线的审查 tab |

### 3.2 新增的 slot（**均为纯增量，无一与我们的注册点同名**）

| 新增槽 | kind / scope | 声明处 |
|---|---|---|
| `sidebar.toggle.badge` | single / root | `ui-sidebar/src/client/contract/slots.ts:18` |
| `conversation.session.header.leading` | single / session | `ui-conversation/src/client/contract/slots.ts:161` |
| `sidebar.right.tab.guide.entry`（alpha.1 已有，alpha.2 起被官方终端使用） | keyed / session | 同上家族 |
| `plugins.item` / `plugins.bundle.config` / `plugins.row.config` | list / keyed / keyed（均 root） | `ui-plugin-manager/src/client/slot-contract.ts` |

### 3.3 破坏性变更（**逐条与我们比对，命中 0**）★

| 变更 | 位置 | 我们是否命中 |
|---|---|---|
| `conversation.chat.turnTail`：**`chain` → `list`** | `ui-chat/src/client/contract/slots.ts:213` | ❌ 未用（无人注册该槽） |
| `conversation.hero.agentPreset`：scope **`root` → `session-maybe`** | `ui-conversation/.../slots.ts:186` | ❌ 未用 |
| `conversation.session`：新增 `owner: { view?: string }` | 同上 `:129` | ❌ 未用（我们注册的是 `.header.actions`） |
| `ui-conversation/src/client/contract/queue.ts`：**删除** | — | ❌ 未引 |
| `ui-slots/src/index.ts`、`ui-renderer/src/client/scoped-slots.tsx`：改动 | — | ⚠️ 见 §4 结论（我们用的槽类型行为未变） |
| `SlotFactoryMap` / `conversation.content` factory 机制**新增** | `ui-conversation/.../slots.ts:213` | ❌ 未用；`conversation.view` 仍由 `PropsRenderSlots` 渲染，**未受影响** |

### 3.4 未变（**这是本轮最关键的「没变」清单**）

- `ui-sidebar-right/src/client/contract/slots.ts`：**唯一改动是给 `SidebarRightTabPlacement` 加了 `preferNewPane?: boolean`**。
  `sidebar.right.pane.tab` / `.title` / `sidebar.right.tab.guide` / `.guide.entry` / `.menu.item` **五槽全未动**。
- `ui-sidebar/src/client/contract/slots.ts`：唯一改动是新增 `sidebar.toggle.badge`。`sidebar.footer.action` 未动。
- `ui-sidebar-right/src/client/tab-registry.ts`：**与 alpha.1 逐字节一致**（`git diff --no-index` 无输出）——
  kind 裁决规则在 alpha.1 就已存在，09-16 未发现的是规则本身，不是规则变了。
- `ui-layout/src/client/index.ts` 的 `shell.overlay`（list / root）：仍在此声明。
- `webserver/index-inject`：`packages/host/webserver/src/index.ts:34` 声明、`:349` emit，未变。

---

## 4. 五条 web 线（+ desktop 插件）slot 逐项核对 `[实测]`

核对源：`vendor/deepseek-harness/`（= `0.1.6-alpha.2`）源码；每行的「alpha.2 契约」是直接读声明处所得。

| 线 | 注册点（源码位置） | alpha.2 契约 | 判定 |
|---|---|---|---|
| **canvas** | `client.js:156` → `conversation.session.header.actions` | `ui-conversation/.../contract/slots.ts:143` — `list` / `session` / `ConversationHeaderActionOwnerProps` | ✅ 未变 |
| **sidebar** | `client.js:2268` → `ctx.sidebarRightTabs.register()` ×2 | registry 规则未变（§5） | ⚠️ **kind 撞车**，见 §5 |
| **sidebar** | `client.js:2275` → `sidebar.right.pane.tab`（key = 类型 id） | `ui-sidebar-right/.../contract/slots.ts:50` — `keyed` / `session` / `TabHookContext` | ✅ 未变 |
| **ssh** | `client.js:459` → `conversation.session.header.actions`（order 26） | 同 canvas 行 | ✅ 未变 |
| **ssh** | `client.js:473` → `shell.overlay`（order 40） | `ui-layout/src/client/index.ts:91` — `list` / `root` | ✅ 未变 |
| **dual-model** | `client.js:250` → `conversation.input.right`（id `dual-model`，order 100） | `ui-conversation/.../slots.ts:196` — `list` / `session`；`SessionStandardProps.useInput` 在 `:241-248` 仍在 | ✅ 未变 |
| **appearance** | `client.js:561` → `settings.section`（id `appearance`，order 5） | `ui-settings/.../contract/slots.ts:54` — `list` / `root` / `SettingsSectionOwnerProps{close}` | ✅ 未变 |
| **appearance** | `index.js:107` → `webserver/index-inject`（host 事件） | `packages/host/webserver/src/index.ts:34` | ✅ 未变 |
| desktop·token-monitor | `conversation.view` / `sidebar.footer.action` / `shell.overlay` | 三槽均未变 | ✅ 未变 |
| desktop·session-log-move | `conversation.session.header.utilities` | `ui-conversation/.../slots.ts:149` — `list` / `session` | ✅ 未变 |
| desktop·pet-panel / free-model-pool | `settings.section` | 同上 | ✅ 未变 |
| desktop·token-monitor（host） | `llm/stream` / `tools/result` 事件 | 存在，签名与 alpha.1 全等（§6） | ✅ 未变 |

**另需登记的一处「坑仍在」**：`sidebar.right.tab.guide` 的 `title` / `description` **仍要求函数**
（`ui-sidebar-right/src/client/tabs/guide/GuideBody.tsx:49,62,91` 处 `entry.description?.()` / `entry.title()`）。
我们 sidebar 线的 `rightBarGuideEntry(...)` 写法正确，**继续保持**。

**结论**：alpha.2 的 663 个文件改动**没有命中我们任何一个注册点**。五条 web 线的 slot 面在 alpha.2 上是**零必改**——
唯一需要决策的是 §5 的 kind 撞车（那是 alpha.1 就存在的问题，不是 alpha.2 引入的）。

---

## 5. 本轮新发现：`SidebarRightTabRegistry` 的 kind 裁决规则 ★★★

`[实测]` 读 `packages/client/ui-sidebar-right/src/client/tab-registry.ts`（**该文件 alpha.1→alpha.2 逐字节未变**）：

```
一个 kind 的槽（KindSlot）最多容纳两条注册：
  - 一条 builtin + 一条 extension，各自最多一条
  - extension 恒为 in force（生效方），builtin 被 shadow（遮蔽）
  - extension 注销后 builtin 自动恢复
除此之外，任何撞 kind 的组合**直接抛错**：
  - 同 band 的第二条 → throw `tab kind "X" is already registered (band)`
  - 与 fallback 撞 → throw
  - id 重复 → throw `tab type id "X" is already registered`
默认 band：**extension**（`DEFAULT_BAND`，即"不声明 priority 就当作外部扩展"）
`guide()` 只列 **in force** 的类型 ⇒ 被 shadow 的那条**不出现在引导页**
```

### 对我们的影响

我们（`dsh-miasaki-sidebar/client.js:2268`）注册两个类型，**均未声明 `priority`**：

| 我们的类型 | kind | 生效 band | 官方同 kind 者 | 裁决结果 |
|---|---|---|---|---|
| `@miasaki/dsh-sidebar/review` | `review` | extension | **无**（官方改动审阅用 `changes-review`） | ✅ 独占 |
| `@miasaki/dsh-sidebar/terminal` | `terminal` | extension | `ui-sidebar-terminal`（**builtin**） | ⚠️ **我们胜出，官方终端被遮蔽** |

`[实测]` 官方全部 tab 类型的 kind 清单（生产代码 7 处 `sidebarRightTabs.register`）：

| 官方包 | kind | priority |
|---|---|---|
| `ui-sidebar-terminal` | `terminal` | `builtin` |
| `ui-deliverables` | **`changes-review`** | `builtin` |
| `ui-plan` | `plan` | `builtin` |
| `ui-subagent` | `subagentchat` | `builtin` |
| `ui-sidebar-files` | `files` | `builtin`（推断） |
| `ui-sidebar-browser` | `browser` | `builtin`（推断） |
| `ui-sidebar-documentpreview` | `text` | `builtin`（推断） |

**关键澄清**：官方的「改动审阅」用 `changes-review`，**不是 `review`** —— 我们的审查 tab 与它不撞。

### 三个必须写下来的后果

1. **引导页不会出现两个终端入口**（09-16 §6.2 担心的困惑场景**不会发生**）：`guide()` 只列 in force 者，
   官方终端的 guide entry 被遮蔽后不显示。**唯一入口是我们的终端 tab。**
2. **但会出现「半遮蔽」的不一致态**：官方终端除类型注册外，还独立注册了
   `sidebar.right.pane.tab`（key = 官方包名）、`sidebar.right.pane.tab.title`、
   `conversation.session.header.actions`（`TerminalRecovery` 恢复入口）与 `shell.overlay`（`TerminalCleanup`）。
   这些**不随 kind 遮蔽而失效**——于是官方终端的"恢复"按钮与"清理失败"浮层仍在，但官方终端类型已不可用。
   `[推断]` 这大概率无害（我们自己的终端有独立恢复路径），但属于**需要实机确认的观感项**。
3. **脆性**：我们靠"extension 压 builtin"这条非显然规则取胜，且**默认 band 是 extension 不是 builtin**。
   风险有二：① 我们自己将来再注册一个同 kind 类型会**直接抛错导致插件加载失败**；
   ② 任何第三方插件若也注册 `kind: 'terminal'` 的 extension，会与我们**互相抛错**，双方都加载不了。

### 建议（需用户拍板，非本次实施）

- **短期（低风险、推荐）**：给我们的两个类型**显式声明 `priority: 'extension'`**——不改变任何裁决结果
  （默认值就是它），但把"我们有意压在官方之上"从**隐式**变成**显式**，后人读得懂，也不怕官方改默认值。
- **中期（需决策）**：把 `kind: 'terminal'` 换成一个不撞的名字（如 `miasaki-terminal`）。
  `kind` 只影响"谁被 `openTab(kind)` 打开"与 guide 分组，**不影响我们 tab 的 body 派发**
  （body 走 `sidebar.right.pane.tab` 的 **id**）。换 kind 后：官方终端与我们**并存**，
  引导页会出现两个终端入口——这正是 09-16 说的"要不要并存"的决策点，**不换 = 遮蔽官方，换 = 并存**。
  当前"遮蔽"状态其实**更好用**（无重复入口），所以这条**不急**，等 sidebar 线实机验收后再定。

---

## 6. 事件契约核对：10 个事件零漂移 `[实测]`

对六条线用到的全部事件做了**三方签名提取**（本地 0.1.5-rc.1 安装产物 / alpha.1 源码 / alpha.2 源码）：

| 事件 | 用在 | alpha.1 vs alpha.2 | 0.1.5 vs alpha.2 |
|---|---|---|---|
| `agent/created` | dual-model | **逐字全等** | **签名有变**：payload 增加 `source: SessionStartSource`（必填）与 `signal?`（可选）；返回 `void` → `undefined \| Promise<undefined>` |
| `agent/disposed` | dual-model | 逐字全等 | 实质相同 |
| `agent/pre-step` | dual-model | 逐字全等 | 实质相同 |
| `agent/request` | dual-model | 逐字全等 | 实质相同 |
| `session/created` | canvas | 逐字全等 | 实质相同 |
| `session/event` | canvas | 逐字全等 | 实质相同 |
| `llm/adapters-updated` | dual-model | 逐字全等 | 实质相同 |
| `settings/updated` | dual-model | 逐字全等 | 实质相同 |
| `llm/stream` | desktop·token-monitor | 逐字全等 | 实质相同 |
| `tools/result` | desktop·token-monitor | 逐字全等 | 实质相同 |
| ~~`agent/session-start`~~ | **未使用** | **两版均无**（0.1.5 有、0.1.6 起移除） | — |

**两条修正 09-16 的判读**：

1. **`agent/created` 不是 0.1.6 新增的**。`[实测]` 它在 **0.1.5-rc.1 就已存在**，与 `agent/session-start` **并存**；
   0.1.6 做的是**移除旧名**、并把 `agent/created` 改为异步串行、扩展其 payload。
   09-16 文档「`agent/session-start` → `agent/created`」的箭头容易被读成"新事件"，实际是"旧名退役"。
   我们双模型线监听的正是 `agent/created`，**在当前 0.1.5 与目标 0.1.6 上双向有效**。
2. **唯一有实质签名变化的是 `agent/created`**，而 dual-model 只用 `payload.agent` ⇒ **零适配**。

---

## 7. 对七条线的影响（更新版）

| 线 | 影响 | 级别 | 相对 09-16 的变化 |
|---|---|---|---|
| **sidebar** | 官方 `ui-sidebar-terminal` 被我们遮蔽（§5）；官方新增 Office 预览 / 浏览器 tab / Subagent 会话 / 交付文件审阅四个 tab 类型，引导页入口变多 | **高（方向级）** | 撞车面**扩大**；新增「遮蔽」这一层认识 |
| **ssh** | 官方新增 `ui-sidebar-browser`（侧边栏浏览器模式）；官方 SSH 仍是服务层无 UI | 中 | 撞车面**略增**（浏览器 tab 与我们 iframe 视图功能相邻） |
| **dual-model** | 事件契约零适配；`agent/created` payload 扩展不影响我们 | **低** | **由「高」下调**——09-16 的 `snapshotEvents` 顾虑实测仍存在且我们有守卫，本轮事件核对又确认零漂移 |
| **appearance** | `settings.section` 与 `webserver/index-inject` 均未变；官方自己也接入 `index-inject`（`ui-theme` / `ui-sidebar-documentpreview`），说明该机制在官方路径上被持续使用 | 低 | 由「中」下调 |
| **fleet** | 0.1.6 的 Ralph 默认关闭 / Team 模式改 `spawn_teammate` 等**均为 alpha.1 已登记项**，本轮无新增 | 中 | 无新增 |
| **desktop** | 6 个本体补丁：5 个零改动、1 个（settings-models）需适配 → 详见配套文档 | **中（本轮新增）** | **09-16 判「零改动」，本轮实测出现首个失效项** |
| **canvas** | `conversation.session.header.actions` 未变；`session/created`/`session/event` 未变 | 低 | 无变化 |

---

## 8. 行动建议

**P0**

1. **升级触发条件不变**：等 `next` 轨出现 `0.1.6-rc.*`。当前 `next = 0.1.5-rc.2` ⇒ **仍未触发**。
2. **`latest` 已是 `0.1.5-rc.2`，但不必为它单独升一次**（§2：改动仅 6 个包、零破坏性）；它会在下次升级时顺带到达。
3. **`settings-models` 补丁的适配需求先登记，不急着动手**——它是升级的真实成本项，
   配套文档 §2 已给出精确到"哪一条编辑、为什么失效"的清单。**升级前必须先完成这一步**。

**P1**

4. **给 sidebar 的两个 tab 类型补显式 `priority: 'extension'`**（§5 建议）——一行改动，零行为变化，
   把隐式依赖变成显式契约。**这是本轮唯一建议立刻做的小改动。**
5. `kind: 'terminal'` 是否改名（遮蔽 → 并存）**押后**，等 sidebar 线实机验收有结论后再定。

**P2**

6. `vendor/deepseek-harness` 已同步到 `0.1.6-alpha.2`（12,073 文件 / 94 MB），
   **旧快照保留在 `vendor/deepseek-harness-0.1.6-alpha.1/`**（11,229 文件 / 87.8 MB）——
   这是本轮能做出逐字节 diff 的前提，建议**下次复查沿用"新旧并排"的做法**，用完再删旧快照。
7. `_refs/deepseek-harness`（`0.1.1-rc.1`）的 `VERSION-NOTE.md` 仍准确，无需改动。

---

## 9. 验证结论与本轮边界

### 9.1 源码级已确认（`vendor/deepseek-harness/` = alpha.2）

| # | 项 | 结论 | 证据 |
|---|---|---|---|
| 1 | `sidebar.right.pane.tab` / `.title` | ✅ 未变（keyed/session） | `ui-sidebar-right/src/client/contract/slots.ts:50,64` |
| 2 | `sidebar.right.tab.guide` / `.guide.entry` / `.menu.item` | ✅ 未变 | 同上 `:75,82,94` |
| 3 | `guide` 的 `title`/`description` 仍要求函数 | ✅ 仍是 | `.../tabs/guide/GuideBody.tsx:49,62,91` |
| 4 | `settings.section` | ✅ 未变（list/root） | `ui-settings/src/client/contract/slots.ts:54` |
| 5 | `conversation.session.header.actions` / `.utilities` | ✅ 未变（list/session） | `ui-conversation/src/client/contract/slots.ts:143,149` |
| 6 | `conversation.input.right` | ✅ 未变（list/session） | 同上 `:196` |
| 7 | `shell.overlay` | ✅ 未变（list/root） | `ui-layout/src/client/index.ts:91,154` |
| 8 | `sidebar.footer.action` | ✅ 未变（list/root） | `ui-sidebar/src/client/contract/slots.ts:52` |
| 9 | `webserver/index-inject` | ✅ 未变 | `packages/host/webserver/src/index.ts:34,349` |
| 10 | tab kind 裁决规则 | ✅ 规则本身未变（文件字节一致）；**我们正遮蔽官方终端** | `ui-sidebar-right/src/client/tab-registry.ts:18-22,176-178,248-257` |
| 11 | 10 个事件签名 alpha.1==alpha.2 | ✅ 全等 | §6（三方提取） |

### 9.2 本轮**未**做（留待后续）

1. **未做隔离实例实测**：以上全部是源码级 + 逐字节 diff 结论，**未**在隔离实例 + 无头浏览器上验证真实挂载
   （方法与 `dsh-0.1.5-rc1-slot-contract-2026-09-10.md` 相同，可复用）。
2. **未验证「半遮蔽」态的实际观感**（§5 后果 2）：官方终端的 `TerminalRecovery` / `TerminalCleanup` 与我们终端并存时
   的实际表现。**注意：这只能在真的升到 0.1.6 后才看得到**（0.1.5 没有官方终端）。
3. **未评估 `ui-plugin-manager` 对我们插件安装方式的影响**（官方插件管理页 + 运行时依赖解析 + 运行时卸载，
   是 0.1.6-alpha.2 的 release note 明写要求插件作者自查的项）——**这是一个独立课题**，建议单独立项。

---

## 附：本次核实方法

- GitHub REST API（只读）：仓库元数据、`releases`、`commits`、`compare/dsh-v0.1.5-rc.1...dsh-v0.1.5-rc.2`。
- `gh` CLI（已登录 `Miasakiii`）：`gh release download dsh-v0.1.6-alpha.2 --archive zip` 拉取快照。
- **本地逐字节 diff**：`git diff --no-index vendor/deepseek-harness-0.1.6-alpha.1/<路径> vendor/deepseek-harness/<路径>`
  —— 覆盖 `packages/client` 全树（663 文件）、4 个契约文件、`tab-registry.ts`、`api-catalog.ts`。
- 本地源码查证：§9.1 各项逐一读 alpha.2 源码确认。
- 事件签名三方提取：本地 0.1.5-rc.1 安装产物的 `dsh-tool-cordis/lib/index.js`（catalog 用双引号）
  与两版 `api-catalog.ts`（单引号 + `\'` 转义）。
- **未执行**任何安装 / 升级 / 重启；本仓受版本控制的文件中，本次仅新增本文档与配套文档，
  并在两份 09-16 旧文档顶部加了 superseded 指引。
