# M2 辅助对话设计：page 型官方右栏 tab + fork 侧线 + 官方会话工厂复用

- 日期：2026-09-27（**2026-09-28 修订：核对底本换代 + ZCode 源码级复核，见 §2.0**）
- 状态：设计定稿（2026-09-28 复核修订 + S1/S2/S7–S9 实机取证后仍为定稿；**设计成立性已无未证假设**，待用户拍板 §8 **六项**后实施）
- 上游依据（**底本已于 2026-09-28 换代，见 §2.0；下表行号一律以 0.1.7 线为准**）：
  - **部署目标（权威）**：本机全局实装的 **DSH 0.1.7-rc.2**（`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`，含各 client 包的 `lib/types/**/*.d.ts` 契约声明与 `lib/client.js` 打包产物）
  - **源码级阅读底本**：`vendor/deepseek-harness-0.1.7-alpha.2`（0.1.7 线，与 rc.2 契约措辞逐字一致）
  - ~~`vendor/deepseek-harness`~~ —— **该副本实为 0.1.6-alpha.2，不是 0.1.7**，本设计初稿的行号引用全部出自它，已作废（见 §2.0）
  - 官方右栏契约：`packages/client/ui-sidebar-right/src/client/{service.ts,index.ts,persistence.ts,shell/SidebarRight.tsx,tabs/guide/GuideBody.tsx}` 与 `README.zh.md`
  - **右栏嵌会话的官方先例**：`packages/client/ui-subagent/src/client/sidebar-chat/index.tsx`（subagent chat 即「资源地址 → retain → SessionProvider → 官方 conversation 工厂」）
  - fork 契约：`packages/api/session-controller/src/client/contract/sessions.ts:122-132`（alpha.2）/ `lib/types/client/contract/sessions.d.ts:113-128`（rc.2）
  - canvas 线已验证链路：`dsh-miasaki-canvas/design/2026-09-05-m1-spike-findings.md` SPIKE-1/2/4
  - 对标调研：`dsh-miasaki-sidebar/design/2026-09-08-tavern-sidebar-comparison.md` 与 ZCode（zai-org/ZCode，本地克隆 `_refs/zcode` @ v3.14.3 / commit `29628c9`）SelectionSideChat
- 与本文关系：本文取代 `2026-09-06-sidebar-roadmap-design.md` §5 的**实现路径**（定位、边界、红线不变，差异逐条列于 §5）

---

## 0. 结论（TL;DR）

**辅助对话 = 一个 page 型官方右栏 tab（kind `sidechat`）+ 内部侧线树 + 嵌入式官方会话。**

- 侧线创建 = `ctx.sessions.fork({ sessionId: parentId, increaseTitle: true })`——**DSH 原生 fork 自动切在「最后一个已完成轮次」边界**（0.1.7-rc.2 契约 `lib/types/client/contract/sessions.d.ts:113-128`），主会话运行中开侧线不打断、不带入进行中的增量，这正是 ZCode 花一整棵 `selectionSideChatHistoryMessages` 手搓的语义，我们免费获得；**但 ZCode 还有一条我们拿不到的边界声明（偏差④，见 §5.1）**；
- 侧线渲染 = **零自研聊天 UI**：复用官方 `conversation.content` 工厂的 `embedded` 变体（官方 subagent chat 同款套路；`phase` 三值 + `hero` 必填，见 C8），输入框 / 流式 / 工具确认全部原生；
- 侧线生命周期 = `ctx.sessions.retain(childId, { source: 'miasaki-sidechat', signal: tab.signal })`，关 tab / 换侧线即 release；**`tab.signal` 不会因隐藏或切会话而 abort**（C3），故 `tab.visible` 性能门是必需品；
- 侧线登记表 = client localStorage 索引（parent → children）——**官方右栏会还原 tab 但还原不了 `params`**（C14），所以它不只是对账索引，而是**刷新后唯一的侧线身份来源**（§4.3）。
- **取证结论（2026-09-28 实测，§7.1）**：**S1/S2/S7 全部通过**——动态插件能声明自名 child slot、能复用官方 `conversation.content` 工厂、子槽确实绑定到 child（而非主会话）、刷新两段还原成立且不重复 fork；**S8 复现风险**：一句「继续」就让侧线接着做父任务；**S9 证实** fork 会连 goal / plan 一起继承（§5.2）。设计的成立性已无未证假设，**待拍板项集中在产品取舍而非可行性**。

---

## 1. 定位与边界（沿用 2026-09-06 §5，不变）

- **本质**：上下文隔离 + 不打断主任务的轻量侧线追问（Codex `/side` 同款）。五类正确用法（并行提问 / 文档确认 / 假设验证 / 多文件协调 / 进度规划）与四条失败模式（侧线跑重任务 / 结果自动回主对话 / 队列堆积 / 模型混乱）依旧有效，见路线设计 §5 与 `cross/sidebar-plan-2026-09-06.md` §2.1。
- **红线不变**：不改系统提示 / 模型请求 / 工具 schema；DSH 原生会话是唯一事实来源；插件不直接调模型（侧线内对话由 DSH 正常驱动）。
- **M2 边界**：单层侧线（侧线内不再 fork）；模型 / preset / 权限跟随父会话（fork 天然继承）；侧线转录只读呈现（官方工厂即只读呈现 + 原生 composer）。

## 2. 官方契约事实（实施照此写，逐条带依据）

### 2.0 版本底座（2026-09-28 修订，**实施前必读**）

**问题**：本文初稿把核对底本写成「`vendor/deepseek-harness`，DSH 0.1.7 线」。**该副本实为 `0.1.6-alpha.2`**（`vendor/deepseek-harness/package.json`），
而本机部署目标（全局实装、桌面壳与 `dsh web` 共同加载）是 **`0.1.7-rc.2`**（`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`）。
两份底本的 **5 个关键契约文件全部不同**（`api/session-controller` 的 `contract/sessions.ts`、`ui-sidebar-right/service.ts`、`ui-sidebar-right/persistence.ts`、
`ui-subagent/sidebar-chat/index.tsx`、`ui-conversation/apply.ts`，逐一哈希比对 DIFF）。

**这不是纸面问题，已经咬到语义层**：同一个 `fork({ atSeq })` 参数，两版的契约措辞是**互相冲突**的——

| 版本 | `atSeq` 落在开放轮次时的行为（JSDoc 原文） |
|---|---|
| 0.1.6-alpha.2（初稿核对底本） | `an in-log anchor in an open turn is **unavailable rather than clipped backward**` |
| **0.1.7-rc.2 / 0.1.7-alpha.2（部署目标）** | `a cut inside an open turn is **balanced Host-side with synthetic closers**` |

好消息：本设计的核心赌注（**不传 `atSeq`** ⇒ 取最后一个已完成轮次边界）两版措辞一致（`omission selects the latest completed-turn prefix`），**不受影响**；
坏消息：初稿 C1 抄的是 0.1.6 的措辞，对部署版本是**错的**（见下表订正）。

**自此确立的取证纪律**（沿用本线 2026-09-27 终端根因那条的做法）：

1. **契约以「运行版」为准**：`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<pkg>\lib\types\**\*.d.ts`（带 JSDoc 的公开契约）与 `lib\client.js`（实现）；
2. **源码级阅读用 `vendor/deepseek-harness-0.1.7-alpha.2`**（0.1.7 线，与 rc.2 关键措辞逐字一致），**不再使用 `vendor/deepseek-harness`（0.1.6）**；
3. 每条契约事实标注**取证版本**，只写 0.1.6 依据的条目在实施前必须对 rc.2 复验（下表「取证」列）。

| # | 事实 | 依据 |
|---|---|---|
| C1 | `sessions.fork({ sessionId, atSeq?, increaseTitle? })`：不传 `atSeq` ⇒ 边界 = **最新一个已完成轮次前缀**（本设计的核心赌注，**0.1.7 措辞已复验**）；传 `atSeq` 且落在开放轮次 ⇒ 宿主侧**补合成收尾**（`balanced Host-side with synthetic closers`，**0.1.6 的「unavailable」措辞已作废**）；完成后 child 已入 catalog 可 retain；**`increaseTitle` 改名失败会在 child 已创建之后抛错**（孤儿风险见 §4.7）；**`increaseTitle` 的产物已在 rc.2 打包产物里实读确认**：无尾号的标题从 ` (1)` 起、已有尾号则自增（`foo(3)` → `foo(4)`），半角/全角括号各自保持 | **rc.2**：`lib/types/client/contract/sessions.d.ts:113-128`；**alpha.2**：`contract/sessions.ts:122-132`；`SessionForkError` 由 `client/index.ts:7` 导出 |
| C2 | fork 出的 child 是**真会话**：`SessionSummary` 带 `parentId / title / displayTitle / running / blank / updatedAt`，host 列表 store 承载每一行 | `api/session-controller/src/client/sessions/service.ts:27-50` |
| C3 | 官方右栏 `sidebar.right.pane.tab` 是 **keyed + session 作用域**席位：正文经 `useTabInfo()` 读 `{ sidebar, panel, tab }`；`tab.visible / navigation / signal / actions`；session 作用域意味着正文直接拿到**所在（主）会话**的标准 props | `ui-sidebar-right/src/client/index.ts:162`；`README.zh.md` §类型/正文；**rc.2 订正三条**：① 席位按**类型定义的 `id`** 键控（**不是 `kind`**——同一 kind 可被别的扩展顶替），故注册 `key` 必须用 id；② `tab.visible` = 「只有**前台会话**可见；停靠正文需面板展开且本 tab 被选中，展开态下非活动 tab 也在内；浮窗不随折叠消失」；③ `tab.signal` **只在记录消失或本插件卸载时 abort——隐藏、切会话都不 abort**，⇒ `visible` 性能门（tavern 对比 §3.6）**不是可选项，是必需品**；**rc.2 依据**：`contract/slots.d.ts:6-8`、`:53-58`、`:169-191`（`visible` 原文 `:181-185`、`signal` 原文 `:187-188`）；`tab-registry.d.ts:76-83` |
| C4 | **page 型 tab（按 kind 开）在同一停靠格内天然去重**——重复点火引导胶囊聚焦已有 tab；资源型 tab（带地址）按 (kind, contentId) 去重 | `ui-sidebar-right/src/client/service.ts:123-126` |
| C5 | `ctx.sidebarRight` = **具体类** `SidebarRightController`（不是接口，所以 `tabsIn` / `registerCloseHandler` 也在）。可用方法：`openTab(kind, options?)` / `openResource(address, options?)` / `focus` / `tabsIn` / `close` / `registerCloseHandler(kind, handler)`。**注意两处易错**：① 控制器侧 `replaceTab` 是 **`TabId` 字符串**，而引导页用的是 **tab 自身动作** `tab.actions.openTab(kind, { replaceTab: true })`（此处 `replaceTab` 是**布尔**）——两条路径类型不同，勿混写；② `registerCloseHandler` **同 kind 重复注册直接抛错**（须只注册一次并在 effect 内持 disposer） | **0.1.6**：`ui-sidebar-right/src/client/service.ts:150-213`（`tabsIn:261-263`、`registerCloseHandler:228-232`、`openTab` 的 `replaceTab: TabId` 在 `:121`）；`index.ts:79-86`（ctx 声明为具体类）；`contract/slots.ts:121` + `tab-domain.ts:154-158`（tab 动作的布尔口径）；`GuideBody.tsx:96` |
| C6 | `useResource` 是**全局标准钩子**，抵达每个 slot 组件（资源协议是可选优化，不是必需） | `client/resources/src/client/index.ts:27` |
| C7 | 注册时声明 session 作用域 children 的组件，框架自动下发 `SessionProvider`（收 `session` 目标即切换绑定） | `client/ui-slots/src/index.ts:395-397` |
| C8 | **`conversation.content` 是已注册工厂**，输入 props = `{ variant: 'main' 或 'embedded'; phase: 'settling' 或 'hero' 或 'active'; hero: boolean }` —— **`phase` 只有三值、`hero` 必填**（初稿 §4.4 写的 `'engaging'` / `'blank'` **不存在**，直传会失败，代码示意已订正）；本地槽位 `views`（session 作用域）/ `widthControls`（root 作用域） | **rc.2**：`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:280-326`（工厂声明）、`:509-513`（输入 props）、`lib/client.js:18073-18109`（注册）；官方的二次折叠写法见 `dsh-client-ui-subagent/lib/client.js:777-786` |
| C9 | **官方先例**：subagent chat 把子会话嵌进右栏 tab——`SessionProvider(session=reference)` 包 `renderSlot('sidebar.chat.conversation')`，后者 `renderFactorySlot('conversation.content', { variant:'embedded', phase, hero }, { slots:{ views } }`，views 只渲染 `conversation.session` 的 chat 视图 | `ui-subagent/src/client/sidebar-chat/index.tsx:123-171` |
| C10 | `session.prompt(content, 'queue' 或 'steer', signal?, requestId?)` 在 `binding.session` 上（首问注入后备通道；composer 在位时不需要） | `api/session-controller/src/client/contract/session.ts:86-91` |
| C11 | `sessions.retain(target, { source, signal })` 的 `source` 是字典键，消费方 `declare module` 扩表——第三方插件可扩自己的 key（如 `miasaki-sidechat`） | `contract/sessions.ts:36-39` + `client/index.ts:80-88` |
| C12 | `sidebar.right.tab.menu.item` 是官方 list 席位：在套件布局动作之后追加**内容级** tab 菜单动作 | `ui-sidebar-right/README.zh.md` §另有两个席位 |
| C13 | 旧自研壳的 tab 组件签名 `{ tabId, visible }` 已废，正文读 `useTabInfo()`；本插件 `visible` 性能门（与 `tab.visible` 相与）继续有效 | `design/2026-09-10-migrate-to-official-rightbar.md` §2 |
| **C14** | **右栏布局按会话持久化到 localStorage**（键 `dsh.sidebar-right.v1.<sessionId>`），**tab 会被还原**；但持久化的 tab 记录只有 `{ id, kind, contentId, title }` —— **不含 `params`**，还原时 occurrence 取 `params: undefined`。⇒ 「刷新后侧线 tab 回来，但**不知道自己该显示哪条侧线**」，登记表（§4.3）是**唯一还原通道**，不是可选优化 | **rc.2（本轮实读）**：`lib/client.js:4914`（键名）、`:4941-4946`（schema，无 params）、`:6090-6094`（还原即 `params: void 0`）、`:6216`（启动发现）；`lib/types/client/persistence.d.ts:3-20` |
| **C15** | 往 `sidebar.right.pane.tab` 注册正文：**两种写法实测都可行**——① 官方先例的 `ctx.slots.inject(父槽, () => ctx.slots.register(...))`；② 本线审查 tab 现有的裸 `ctx.slots.register({name, key, children}, Body)`（**S1 实测 `ok:true`，无报错**）。**⚠ 2026-09-28 订正**：本条初稿写的「注册方必须自带 `inject: { hooks: { tabInfo } }`，否则取不到 `useTabInfo`」**是错的**——`inject` 属于**槽声明本身**（官方自己声明 `sidebar.right.pane.tab` 时就带了 `inject: SidebarRightTabInjected`），注册方**不需要也不应该**再写。另：`renderFactorySlot` 是常驻席位，无需声明 | **rc.2**：`lib/types/client/contract/slots.d.ts:53-58`（槽声明的 `inject`）、`:169-191`（正文 props）；**实测**：§7.1（S1-A/S1-B + `propKeys`）；**官方先例**：`ui-subagent/src/client/sidebar-chat/index.tsx:196-203` |
| **C16** | 三条易踩的签名事实：① `registerCloseHandler(kind, handler)` **同 kind 重复注册直接抛错**，须只注册一次并持 disposer；② `ctx.uiWorkspace.openSession(target: SessionTarget): void` —— **返回 void，不是 Promise**；③ page 型 tab 的 `tab.contentId` 恒为 `pageAddress(kind)`，**不是 child 会话 id**，深链接只能走 `navigation.params` | **0.1.6**：`ui-sidebar-right/src/client/service.ts:222-232`、`:370`；`ui-workspace/src/client/navigation.ts:25-30,161-163` |
| **C17** | **「更新已开 tab 的 params」是有通道的**：对已开的 page 型 tab 再调一次 `openTab(kind, { params })`，地址确定（page 型恒为 `pageAddress(kind)`）⇒ 落回同一 tab，并走 `navigate(...)` **覆盖 `params`、自增 `revision`**（没有独立的 setParams API）。⇒ 会话内可把「活动侧线」同步进 tab；但**仍然救不了刷新**（C14，持久化里没有 params）。**顺带订正**：本线 `client.js` 顶部注释写的「**没有**『更新当前 tab 参数』的通道」与 rc.2 实读不符，实施 M2 时一并改正 | **rc.2**：`lib/client.js:6470`（page 地址不随机）、`:6493-6496`（place → navigate）、`:6123-6135`（navigate 覆盖 params / revision 自增）；`lib/types/client/contract/slots.d.ts:113-124`（`navigation.revision` 语义） |
| **C18** | `sidebar.right.tab.menu.item` 的 owner props = `{ tab, dismiss }`，**动作必须调用 `dismiss()`**（菜单是 kit 的，只对 kit 自己的动作自动关闭） | **rc.2**：`lib/types/client/contract/slots.d.ts:105-109`（席位声明）、`:204-215`（owner props 与 `dismiss` 的 MUST 要求） |

## 3. 总体架构

```
官方右栏（框架管开合/分栏/全屏）
└─ tab：辅助对话（page 型，kind=sidechat，同格去重 C4）
   ├─ 侧线头（自研）：父会话标题 · 侧线切换器 · 新建 · 在主区打开
   ├─ 侧线树条目 = localStorage 登记表（parent → [child…]），
   │   刷新后与 sessions.list 的 parentId 对账重建（C2）
   └─ 嵌入式会话（复用 official）：
      SessionProvider(session = retain(child, {source:'miasaki-sidechat'}))
      └─ 'miasaki.sidebar.sidechat.conversation'（自声明 child slot, session 作用域）
         └─ renderFactorySlot('conversation.content', { variant:'embedded', … })   ← C8/C9
            └─ views → conversation.session[chat]（官方 transcript + 原生 composer）
```

创建/保留/释放三条路径：

```
guide 胶囊 ──openTab('sidechat', {replaceTab:true})──► body 挂载
                                                      │ 读主会话 sessionId（C3）
                                                      ▼
                                    登记表有 active child？─是─► retain + 渲染
                                                      │否
                                                      ▼
                                   fork(parent, increaseTitle) ──► childId
                                                      │（并发去重：pendingCreations，ZCode 同款）
                                                      ▼
                                     写入登记表 ──► retain + 渲染
关 tab / 切换 / 父销毁 ──► registerCloseHandler + effect 清理 ──► reference.release()
```

## 4. 详细设计

### 4.1 tab 类型与入口

```js
const RIGHT_BAR_TABS = [
  { id: '@miasaki/dsh-sidebar/review',   kind: 'review',   … 现状不动 … },
  { id: '@miasaki/dsh-sidebar/sidechat', kind: 'sidechat',
    title: () => '辅助对话',
    guide: [{ kind: 'sidechat', title: '辅助对话', description: '上下文隔离的侧线追问，不打断主任务', order: 20 }] },
]
// 正文（**写法已按 C15 订正**：注册必须走 ctx.slots.inject，裸 register 进未声明槽会抛；
// 且父注册必须带 inject.hooks.tabInfo，否则组件取不到 useTabInfo）：
// ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
//   name: 'sidebar.right.pane.tab', key: '@miasaki/dsh-sidebar/sidechat',
//   inject: { hooks: { tabInfo: tabInfoFactory } },
//   children: { 'miasaki.sidebar.sidechat.conversation': { kind: 'single', scope: 'session' } },
// }, SideChatTab)))
// child 正文（本插件第二个注册，同样走 inject）：
// ctx.effect(() => ctx.slots.inject('miasaki.sidebar.sidechat.conversation', () =>
//   ctx.slots.register({ name: 'miasaki.sidebar.sidechat.conversation' }, SideChatConversation)))
// 作废的初稿写法（对照用）：ctx.slots.register({ name:'sidebar.right.pane.tab', key:'@miasaki/dsh-sidebar/sidechat',
//   children: { … } }, SideChatTab)   ← 初稿写法，会抛错；保留仅供对照（见 §2 C15）
```

- **入口 = 官方引导页胶囊**（沿用用户 2026-09-10 拍板：不自建按钮、不碰官方会话列表排序）。page 型同格去重（C4）保证重复点火不堆 tab。
- **深链接（M2.3 备选）**：`openTab('sidechat', { params: { childSessionId } })`——`navigation.params` 由 kind 声明类型（C5），用于「从别处直达某条侧线」；本期不接外部触发源，仅留通道。**注意 `params` 不持久化**（C14）：刷新后还原的 tab 拿不到 `params`，所以深链接只在本会话生命周期内有效——**它不是还原手段**，还原一律走登记表（§4.3）。
- title 静态「辅助对话」；侧线头内显示父/子标题（child 标题读 `sessions.list` 的 displayTitle，C2）。

### 4.2 侧线创建（fork）

- `const childId = await ctx.sessions.fork({ sessionId: parentId, increaseTitle: true })`。
- **不传 `atSeq`**：边界自动取最后一个已完成轮次（C1）。主会话 running 时同样可 fork（切入点是已完成的过去，不是现在）——S3 实机确认一次。
- `increaseTitle: true` 让孩子在官方会话列表里可辨——**命名产物已实读确认**（rc.2 `lib/client.js:3062-3071`）：无尾号标题得 ` (1)`、已有尾号则自增（`foo(3)`→`foo(4)`），半角/全角括号各自保持——初稿 §2 的「标题 2」写法作废，**S3 实测时按「` (1)` 起」判据验收**。
- **空白父会话不能 fork（2026-09-28 实测）**：父会话还没有任何完成轮次时，`fork` 抛
  `session/fork-unavailable: … has no completed turn to fork from`。⇒ 入口必须把「主会话 0 轮」当**常态**处理
  （引导文案：「主会话完成一轮后才有可切的边界」），而不是当异常弹错误条——**新建会话立刻开侧线是这个功能最先被尝试的路径**。
- **创建后的补偿（S9，§5.2）**：child 会继承父会话的 goal / plan，按 §8 决策⑥ 决定是否调
  `ctx.remote.goals.get(childId)` → `goals.clear(...)`。plan 无 API，只写已知限制。
- **并发去重**：`pendingCreations: Map<pendingKey, Promise>`（ZCode `selectionSideChatRuntime.ts` 同款），同一次用户手势只 fork 一次；**resolve 后立即删除 key**（不能退化成单例——下次点火要能开新侧线）。
- fork 失败（`SessionForkError`）/ child retain 失败：侧线头出可读错误条，不留半截登记。**但「fork 抛错」≠「没建出 child」**：C1 明示改名失败发生在 **child 已创建之后**才抛，会留下「已建但未登记」的孤儿。收尾动作 = fork 抛错后**不立刻判死**，拉一次 `sessions.list` 用 `parentId` 对账（复用 §4.3 同一套逻辑），把已落盘的 child 收进登记表，或明确报「已创建但命名失败」。

### 4.3 侧线登记表与刷新重建

- **定位（2026-09-28 上修为关键路径）**：官方还原 tab 骨架时**不带 `params`**（C14），所以**登记表是刷新后唯一能回答「这条侧线是哪条」的地方**——它是**身份存储，不是缓存**。写入时机 = `fork` resolve 之后**立即**写盘（`activeChildId` 同批落盘），不得延迟到首次交互。
- localStorage 键 `miasaki-sidebar:sidechat:v1`，形态：
  `{ [parentSessionId]: { activeChildId, lines: [{ childSessionId, createdAt }] } }`（**实施时去掉了 `workspaceKey` 一层**：sessionId 全局唯一，那层是冗余的）
- **索引不是事实来源**：每次挂载 / `sessions.list.subscribe` 时，用 `byId[child].parentId === parent` 对账（C2）——
  - 登记表有、列表无（被归档/外部删）→ 摘除该行；
  - 列表有 `parentId === parent`、登记表无（刷新后重建 / 别的途径 fork）→ 补行，`displayTitle` 取自列表；
  - activeChild 失效 → 回退到最近一行，没有则提示新建。
- 仿审查视图存储的既有模式（`useReviewView` 同款 `useSyncExternalStore` 小 store，私有模式降级）。

### 4.4 嵌入式会话渲染（零自研聊天 UI）

```js
function SideChatTab({ useTabInfo, SessionProvider, renderSlot, sessionId /* 主会话，C3 */ }) {
  const { tab } = useTabInfo()
  const activeChild = useSideChatActive(sessionId, tab.visible)
  return react.createElement('div', { className: 'dsh-sidebar-sidechat' },
    侧线头(…),
     activeChild
       ? react.createElement(SessionProvider, { session: activeChild.reference },
           renderSlot('miasaki.sidebar.sidechat.conversation'))
       : 空态(…))
}
// child slot 正文（本插件第二个注册）：
function SideChatConversation({ useSession, useConversation, useSessions, renderFactorySlot }) {
  const session = useSession(v => v); const conversation = useConversation(v => v)
  const active = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
  // phase 只有三值 settling/hero/active，且 hero 是**必填**——初稿的 'engaging' / 'blank' 不存在（C8 订正）
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, { slots: { views: FixedChatView } })
}
```

- `FixedChatView` = 只渲染 `conversation.session` 的 chat 视图（抄官方 `FixedChatConversationView`，C9）。
- phase 算法照抄官方 `ConversationSlotPanel`，**剔除 subagent 专属分支**（`parentAvailabilityPending` 等与我们无关）。**但取值域必须守住 C8**：`phase` 只有 `settling` / `hero` / `active` 三值，且 `hero` **必填**——官方是「先算 shellPhase 再折叠成三值」，本轮草图里自造的 `'engaging'` / `'blank'` 已作废。
- composer 是原生的：侧线里直接输入即对 child 会话排队/发送（C9 推论）——**本期不做 prompt 注入入口**（S6 备选：`binding.session.prompt([{type:'text',text}], 'queue')`，C10）。
- 门禁沿用审查 tab 的 `visible` 性能门：嵌入式会话的流式订阅收 `tab.visible` 管辖（tavern 对比 §3.6 的前置块在此兑现）。

### 4.5 侧线树 UI 与 tab 菜单动作

- 侧线头（参考 files tab 头部行的复制范式，不共享官方组件）：父标题（灰）· 侧线计数；左侧切换器列出该父的侧线（displayTitle + running 点 + 最后活动），右侧动作：**新建侧线** / **在主区打开**（`ctx.uiWorkspace.openSession(childId)`）/ 关闭。
- **「保存为新会话」废止**：fork child 本就是官方列表里的真会话（C2），ZCode 那个动作的存在前提（隐藏 child）在我们这里不成立——「提升」动作降级为「在主区打开」，差额写进 CHANGELOG（见 §5）。
- `sidebar.right.tab.menu.item`（C12）注册两个内容动作：`新建侧线`、`在主区打开`——与侧线头动作同源，不新增第二套逻辑；**两个动作都必须调用 owner props 的 `dismiss()`**（C18：菜单是 kit 的，不调则不关）。
- 侧线内**不提供** retry/fork/edit 的改写入口：官方 composer/工具栏是原生事实来源，我们不包一层（红线：唯一事实来源）。

### 4.6 生命周期

| 事件 | 动作 |
|---|---|
| tab 关闭（框架 close / `registerCloseHandler('sidechat', …)`，C5） | release 当前 retain；登记表保留（侧线是 durable 会话，关 tab ≠ 删会话）。**注册约束（C16）**：`registerCloseHandler` 同 kind **重复注册直接抛错**，必须在 effect 内只注册一次并持有 disposer |
| 切换侧线 | release 旧 child 引用（effect 依赖 activeChildId 自然重建） |
| 父会话被归档 / 销毁 | `subscribeTaskLifecycle` 无对等物——改用 `sessions.list` 对账：父行消失时把该父登记整体置灰（不删，父可能恢复），并停止 retain |
| 页面刷新 | **两段还原**：① tab 骨架——官方右栏按会话持久化布局，`sidechat` tab 会自己回来（**C14，初稿「官方右栏不持久化 tab」的说法已作废**）；② 侧线身份——还原时 `params` 恒为 `undefined`，**活动侧线只能由登记表给出**（§4.3）。⇒ 登记表必须在 fork 成功时**同步写盘**，不能等首次交互 |
| retain 引用归零 | child 会话留在 host（等同 fork 分支既有语义，不额外清理——DSH 没有 closeSession 对等物，archive 会连带停活动，误用） |

### 4.7 竞态与失败

- **fork 竞速**：fork resolve 时 child 已在 catalog（C1），`retain` 可立即串行调用，无需轮询（canvas SPIKE-4 同款时序，0.1.7 复验列 S3）。
- **双击/连点 guide**：`pendingCreations` 去重（§4.2）。
- **切侧线竞速**：切换只改 store 的 activeChildId，retain effect 依赖它是 React 单线程语义，不存在双挂；旧引用 release 放在 effect cleanup。
- **父会话正跑时创建**：允许（C1），S3 实测一次留证；若实测失败，降级 = 入口置灰 + 提示「等当前轮结束」（ZCode 的 blocked 态同款）。
- **失败可见**：fork/retain 失败在侧线头出可读原因（对齐审查 tab 2026-09-12 §3.1 的错误可见化约定）。

## 5. 隐藏性：对标 ZCode 的落地与偏差声明

ZCode 四层隐藏（会话级 taskType / 消息级 model-only / 投影策略 / 命令门禁）依赖宿主侧的会话类型与可见性字段。**DSH 把这些能力留在宿主手里**：第三方插件不能写会话元数据、不能改官方列表投影、不能拦别人对 child 的命令。据此逐层对账：

| ZCode 层 | 我们的对等 | 结论 |
|---|---|---|
| 会话级 `taskType: selection_side_chat` | 无对等（DSH fork child 就是普通会话，`origin` 仅 subagent 专用） | **偏差①**：侧线在官方会话列表**可见**，靠 `increaseTitle` 命名可辨。接受——官方列表不是我们的画布，干预它违反「壳让位」原则。**ZCode 侧的判据也印证这不是小事**：其列表可见性由 `taskType` 白名单决定，源码注释明写「列表可见性不能用 `parent_id is null` 的层级查询代替……可见性必须由 taskType 决定」（`_refs/zcode/.../task-list-session-membership.ts:3-24`）——我们没有写 taskType 的位置 |
| 消息级 `visibility: model-only`（UI 空白起步 **+ 尾部边界声明**） | **无对等——初稿判「无差异」是错的**。ZCode 在继承历史尾部**必插一条 model-only 的边界声明**（正文见 §5.1），没有它模型会把父任务当成自己的活继续做；DSH 的 `sessions.fork` 不提供任何对等注入位 | **偏差④（2026-09-28 新增，本设计最大缺口，见 §5.1）** |
| 投影策略排除侧线消息 | 无对等；侧线消息只属于 child 自己的日志，父投影天然不含 | 无差异 |
| 命令门禁（禁 goal/fork/retry/edit） | DSH 侧线是原生会话：fork/retry/edit 在副屏里同样是原生能力。侧线内再 fork 由用户自发进行时——**不拦**（拦截等于包一层壳，违反唯一事实来源红线）；仅在文档与 UI 上声明「单层侧线」约定 | **偏差②** |
| 「保存为新会话」 | child 本就是真会话，「提升」= `uiWorkspace.openSession(childId)` | **偏差③**：动作降级为「在主区打开」 |
| **任务态继承**（goal / plan / todo） | 无剥离手段：`fork` 整段拷贝日志前缀 ⇒ child 继承父目标（官方测试逐字断言）、`plan:policy` 提示段会在 active 时自动注入 | **偏差⑤（2026-09-28 新增，S9 取证）**：goal 可调官方 `goals.clear` 补偿（留 tombstone），**plan 无客户端 API**——见 §5.2 与 §8 决策⑥ |

对 2026-09-06 §5 的订正（原文两处待 spike + 一项能力）：

- 「侧线不在主会话列表出现」→ **不承诺**（偏差①）；
- 「隐藏性方案二选一（origin/subagent vs 元数据标记+列表过滤）」→ 两个都不做，改为 §4.3 的**登记表索引 + parentId 对账**；
- 「保存为新会话」→ 降级为「在主区打开」（偏差③）；
- 「带回主对话（composer 注入 @引用）」→ DSH 无对等注入 API（M2 spike 二的结论前置到设计期）：本期提供**复制到剪贴板**兜底（侧线消息行已有行级复制的 diff 先例），正式带回入口留 M3 重新评估。

### 5.1 ZCode 源码级复核（2026-09-28，底本 `_refs/zcode` @ v3.14.3 / commit `29628c9`）

初稿只做了「对标调研」；本节是把 ZCode 侧聊源码逐层读完后**必须回改本设计**的部分。三条硬结论：

**(A) 边界声明（偏差④·本设计最大缺口）。** ZCode 在 child 继承历史的尾部**无条件插入**一条 `role: user`、`synthetic: true`、`visibility: model-only` 的消息
（对模型可见、对 UI 与 transcript 隐藏），正文三句：

```
The preceding conversation was inherited from the parent task for reference only.
Do not continue the parent's active work automatically; answer only new questions sent in this side chat.
Modify the workspace only when the user explicitly asks you to do so in this side chat.
```

它解决的是**真实问题**，不是修辞：① 子会话继承父正文，不声明则模型会把父任务当成自己的活接着干；② 工作区是共享的，需限制副作用。
位置敏感——必须落在新问题**之前**（ZCode 为此把它登记进 `NON_MID_CONVERSATION_SYSTEM_SOURCES`，否则会被系统提醒机制搬到问题之后）。

**我们拿不到这一层**：插件不能写会话日志、不能改模型请求（红线），`sessions.fork` 也没有注入位。

**S8 实测（2026-09-28，隔离实例 + 无头 Edge）把这条从「理论风险」打成「可复现缺陷」**：

- **S8a（无关问题）→ 不越界**：侧线问「中国的首都是哪里？只回答这一个问题」→ 答「中国的首都是北京。（只回答这一个问题，不涉及此前计划的其他步骤。）」；
- **S8b（只说「继续」）→ 越界**：父会话留下的三步计划里第二、三步尚未做，侧线收到一个「继续」就答
  **「按之前的三步计划，"继续"即进入下一步。我按"每轮一步"的节奏执行第二步」**——**它接着做父任务了**。

⇒ 结论：ZCode 那句「Do not continue the parent's active work automatically」在 DSH 侧线里**确有对价**，
而触发它只需要一个常用词。**UI 提示必须写具体行为**（「说『继续』= 接着做主线未完成的活」），不能只写「这是侧线」。可选应对（**§8 新增拍板项②**）：

| 方案 | 做法 | 代价 |
|---|---|---|
| a. 只做 UI 提示（保底） | 侧线头常驻提示「这是侧线：它继承的是父会话已完成的历史，不会替主任务干活」 | 零成本，但**管不住模型**——误续主任务的风险仍在 |
| b. 首问注入边界（近似） | 用 `session.prompt([...], 'queue')`（C10）把边界当**用户消息**发进去，紧接着才是用户真问题 | 会**污染 transcript**（用户看见一条自己没写的话），且这笔注入会触发一轮模型运行——语义不等价 |
| c. 改写产品形态 | 侧线不 fork 父历史（或只 fork 到某轮），改由用户在首问里自带上下文 | 丢掉「继承上下文」这一核心价值，等于放弃侧线的主要卖点 |
| d. 向上游提需求 | 请 DSH 提供 fork 时的 synthetic 边界注入位（ZCode 的 `selection_side_chat` / `conversation_fork` 就是官方机制） | 周期不可控；可作为 M3 的独立事项 |

**(B) goal / 计划不随侧线继承。** ZCode 对 side chat **显式剥离**父会话的 goal：goalBoundary 逐条 strip、verifier 集合置空、goal 快照 `[]`、goal 提交 `undefined`
（否则 strict clone 会因找不到 child-local identity 而抛错）。**DSH 侧 `fork` 是否把 goal／plan 状态带进 child，本设计从未核对**——若带，
侧线会继承父会话的目标，模型「替主任务干活」的倾向更强（与偏差④叠加）。**列为 S9 必测**，结论决定 §4.2 是否需要「创建后先清 goal」的补偿动作。

**(C) 命令门禁的具体名单（偏差②的取材）。** ZCode 在 side chat 里禁 7 条命令：`sendGoalCommand` / `pauseGoal` / `resumeGoal` / `editUserQuery` / `retryTurn` / `forkAssistant` / `discardSharedContext`，
并在 UI 上抑制 goal 面板、隐藏 retry/fork/edit 动作。我们**拦不了**（红线），但有两个低成本对等物：
① 侧线头的文案里点明「retry / edit 会作用在**这条侧线自己的副本**上，不动主会话」；② 单层侧线约定写进 UI（偏差②的既有决定）。

**其余对照（不改变设计，避免以后重复调研）：**

- **UI 与生命周期**：ZCode 的 side pane 状态在 renderer 模块级 Map（LRU 50，**不落 localStorage、刷新即丢**）——我们在这一点上**比它强**（C14 官方右栏会还原 tab），**不要照抄它的「不恢复」**；
- **子会话编号**：ZCode 用「辅助对话 N」（按 `(workspace, parent)` 取最小空闲号，且**老数据迁移给缺 ordinal 的 tab 回填**）；我们的官方右栏 **tab 标题在打开时被捕获且没有「改 tab 标题」通道**，故沿用静态标题，多侧线区分放在**侧线头内部**；
- **选区开侧聊**（ZCode 的主入口）：它把选区序列化成 `# userselect:` 围栏块随首条消息带进 child（限额 8000 字符 / 8 条 / 总 16000）。
  这是**纯前端逻辑、可移植**，但依赖「往 child 追加引用」的注入通道——**归 M3 评估**，不进 M2 范围；
- **阻塞态**：ZCode 在父会话有待处理交互时禁用「带选区开侧聊」（tooltip：请先处理主任务或辅助对话中的待处理请求），固定入口仍可用。我们**没有**等价的三态注册表（拿不到官方 focused pane 权威），退化为 §4.7 的「fork 失败才置灰」；
- **关闭链**：ZCode 关 tab = 清运行时 + 清引用 scope + `closeSession`；我们只能 release retain（DSH 无 closeSession 对等物，且 archive 会连带停活动，见 §4.6）——**child 会留在官方列表**，这正是偏差①必须用户点头的原因。



### 5.2 fork 会连「任务态」一起继承（S9 取证，2026-09-28）

**结论先行：`fork` ≠「干净子会话」。** 宿主侧实现是 `buildForkSeed` = **整段事件日志前缀的物理拷贝、零类型过滤**（rc.2 `dsh-session/lib/types/fork.js:18-27`），
而 DSH 把任务态**全部存在会话日志事件里**，投影层又从 seq 0 全量折叠（`dsh-session-projection/lib/index.js:368-376`）⇒ child 完整继承父的下列状态：

| 继承项 | 证据 | 对侧线的影响 |
|---|---|---|
| **goal** | 事件 `goal/change`；官方测试逐字断言 `inherits the completed-turn goal prefix through SessionStore.fork with child activation disarmed` | child 会**显示并携带**父目标；在 child 里 `create_goal` 会因 `GOAL_ALREADY_EXISTS` 失败（除非先 clear/complete） |
| **plan mode** | 事件 `plan/mode`；active 时 child 会自动注入 `plan:policy` 提示段（`dsh-plan-mode/lib/index.js:171-178`） | **改变侧线行为**，且**没有客户端 API 可关** |
| **todo** | 事件 `todo/write` | 影响小：child 自己第一次 `turn/start` 即清空 |
| preset / 权限 / 模型选择 | `composeAgent(presetForObservation(source))` 显式继承；`pinInitialPermission` 明写「seeded sessions 保留既有开关值」 | **这是我们想要的**（§1「模型 / preset / 权限跟随父会话」由此落实，不是缺陷） |
| inbox 未领取队列 | `agent/inbox/spliced` 是日志事件，inbox 投影无 fork 感知 | 缺省切点会在 `agent/inbox/spliced` 处停，一般落不进来；若将来给 M2 加显式 `atSeq`，需重新评估 |
| **唯一被剥离** | goal 的 `activation`（进程本地 WeakMap，恒 `disarmed`） | **不会自动续跑**——但注意模型侧指引写着「人类说继续/恢复，就 resume」，这正是 S8 复现的那条路径 |

**补偿手段（实施用）**：

- **goal**：✅ 有官方 API —— `ctx.remote.goals.get(childId)` → `ctx.remote.goals.clear(childId, { id, revision })`（官方 UI 同款调用）；
  代价是 child 日志里留一条 `goal/change{operation:'clear'}` tombstone。
- **plan mode**：❌ 无客户端 API（`dsh-plan-mode` 没有 Remote 面）；只能接受，或向 child 投 `/plan off` 文本走 commands。**列为已知限制。**
- **todo**：不需要动（自清）。
- **preset**：不建议动（继承是需求）。

⇒ 见 §8 决策⑥。



## 6. 里程碑与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| M2.1 最小闭环 | tab 类型 + guide 入口 + fork 创建 + 嵌入式官方会话 + 单侧线切换 | **✅ 已实施并验收（2026-09-28，§7.2）**：主会话运行中开侧线不打断、继承历史止于完成轮次、关 tab 随组件卸载 release |
| M2.2 侧线树 | 登记表 + parentId 对账 + 多侧线 + 新建/切换 + running 徽标 + 刷新重建 | 刷新后侧线树自动重建且标题正确；父会话消失时置灰不误删；连点 guide 只建一条 |
| M2.3 体验收口 | tab 菜单动作 + 「在主区打开」+ 复制兜底 + 深链接 params 通道 + 三主题走查 | 三主题下与审查 tab / canvas 全屏共存无叠压；复制带回可用 |

工作量估计（业余节奏）：M2.1 ≈ 3–5 天（含 S1/S2 spike），M2.2 ≈ 2–3 天，M2.3 ≈ 2 天。

## 7. Spike 清单（实施前必须逐条实机留证）

| # | 内容 | 判据 |
|---|---|---|
| S1 | 动态插件（本线 link: 装入）能否 `ctx.slots.register` 声明**自名 child slot** 并 `renderFactorySlot('conversation.content', …)` | 副屏渲染出官方 transcript；控制台无 slot 声明冲突。**判据已按 C15 收窄**：真问题不是「能不能声明自名 child slot」（能），而是**能否在正确的时机注册**——`sidebar.right.pane.tab` 由 shell **异步声明**，裸 `register` 会抛；须先证明 `ctx.slots.inject(父槽, …)` 在本线（动态 client 半）下确实等得到声明，且 `inject.hooks.tabInfo` 能取到 `useTabInfo` |
| S2 | `SessionProvider(session=SessionReference)` + session 作用域 child 的 `useSession/useConversation` 在副屏绑定到 **child** 而非主会话 | 副屏显示 child 历史（父历史作为继承上下文），composer 发送进 child |
| S3 | 主会话 **running** 中 `fork({ sessionId, increaseTitle:true })`（不传 atSeq） | 成功且 child 历史止于上一完成轮次；若失败 → 走 §4.7 降级 |
| S4 | page 型同格去重（C4）+ guide `replaceTab` 顶掉引导 tab 的实际行为 | 连点 guide 只留一个 sidechat tab |
| S5 | fork child 出现在官方会话列表的形态与排序噪音 | 用户实机确认可接受（偏差① 的验收点） |
| S6 | blank child 的 composer 首发语义（canvas SPIKE-2 在 0.1.1 的结论在 0.1.7 仍成立） | 副屏首条消息即 child 首轮，无额外初始化 |
| **S7** | 刷新还原的**两段拼合**（C14）：官方还原 `sidechat` tab 后，插件能否凭登记表把活动侧线接回去 | 刷新页面 → tab 自动回来 → 侧线头显示正确 child（而不是空态）；且 `navigation.params` 确为 `undefined` |
| **S8** | **无边界声明的实际后果**（偏差④）：主会话跑一个明确任务，中途开侧线问一个无关问题 | 观察模型是否「接着干父任务」或改动工作区。**这是 §8 决策②的取证依据**，必须先测再定方案 |
| **S9** | **goal / plan 是否随 `fork` 进入 child**（§5.1 B） | 若继承：侧线会背着父会话的目标。结论决定 §4.2 是否需要创建后的补偿动作（或直接升格为偏差声明） |

S1/S2 是本设计**成立性的生死项**：官方先例（ui-subagent）是内置静态包，本线是动态 client 半。若 S1/S2 失败，回退方案 = 自研极简转录渲染（只读消息列表 + 原生 composer 槽位替代品），工作量 +3–5 天，且放弃原生工具确认卡片——**先 spike 再写代码**。**S8/S9 是 2026-09-28 新增的行为性风险项**（偏差④ + goal 继承）：它们不影响「能不能做」，影响「做出来会不会被当成帮倒忙」——建议与 S1/S2 同批实测，S8 的结果直接喂给 §8 决策②。

### 7.1 实测结果（2026-09-28，隔离实例 + 无头 Edge；原始证据 `_refs/spikes-m2/FINDINGS.md`）

**环境**：`dsh --profile web --patch <隔离 overlay> --no-open --port 3099`（会话/账本落 `_refs/`，不碰真实 profile），
无头 Edge + Playwright 驱动，模型 `deepseek-official / deepseek-flash`；探针为临时插入本插件 `client.js` 的 `[PROBE M2]` 块（**取证后已整块删除，文件还原 2324 行 / LF，回归 12/12 PASS**）。

| # | 结果 | 关键证据 |
|---|---|---|
| S1 | **通过** | 裸 `ctx.slots.register`（`ok:true`）与自名 child slot 声明/注册（`ok:true`）都成功，控制台零错误 |
| S2 | **通过** | `scopeSessionId === boundSessionId === childId`；子槽的 `openState` 由 loading→open、`activeTargets` 0→1；副屏渲染出官方 transcript + 原生 composer |
| S7 | **通过** | 同一上下文 reload：框架自动还原 tab（无 auto-open）、`S7-restore-hit` 命中、**未重复 fork**、childId 稳定、还原时 `revision: 0` |
| **S3** | **通过** | 主会话**运行中**点「新建侧线」：fork 成功、**主会话继续跑完**、侧线继承的历史**止于上一个完成轮次、不含正在跑的增量**——「不打断主任务」这条核心承诺实测成立 |
| S3(负例) | 行为正确 | 主会话**首轮还在跑**（0 个完成轮次）时 fork 失败，界面给的是**人话引导**（「先让主会话跑完一轮」），不是宿主错误串 |
| S8 | **风险复现** | 无关问题**不越界**；但只说一句「继续」→ 侧线**按父计划执行了第二步**（见 §5.1 A） |
| S9 | **必须补偿** | fork **零类型过滤**地拷贝日志前缀 ⇒ goal / plan / todo / preset / 权限全部继承，仅 goal 的 activation 被 disarm（官方 `goals.clear` 可补偿） |

**顺带实测到的四条硬事实**（都已按此订正前文）：

1. **C15 的一半是错的**：官方 `sidebar.right.pane.tab` 的**槽声明自带 `inject`**（`contract/slots.d.ts:53-58`），注册方**不需要**写 `inject.hooks.tabInfo`；实测裸 `register` 也成功。→ C15 行已订正，**实施按现有审查 tab 的裸写法即可**（`ctx.slots.inject` 仍是官方推荐的防御写法，二选一即可，但**别再加 inject**）。
2. **空白父会话无法 fork**：`session/fork-unavailable: … has no completed turn to fork from`。⇒ §4.7 必须覆盖「父会话还没有任何完成轮次」这一**最常见的新会话形态**（不是异常，是常态）。
3. **`increaseTitle` 的区分度不足**：同一父会话连续 fork 出三个 child，三者标题**都是「父标题 (1)」**——`increaseTitle` 是相对**父标题**自增，而父标题本身没有尾号，所以永远回到 `(1)`。⇒ 偏差①「靠命名可辨」**不成立**，侧线头必须自带区分（序号 / 时间 / 首问摘要）。
4. **tab 正文的 owner prop 已实测**：`sessionId`、`useSession`、`useConversation`、`useSessions`、`renderFactorySlot`、`renderSlot`、`SessionProvider`、`useTabInfo` 全在 props 上；`contentId` 实测为 `sidebar://<kind>`（page 地址，非 child id）。

### 7.2 M2.1 实施与验收（2026-09-28）

**用户拍板**：§8 六项按建议全部通过 ⇒ 进 M2.1。

**落地范围**（全部在本线 `client.js`，零 host 半改动）：

| 件 | 位置 |
|---|---|
| 侧线登记表（模块级 + 纯函数 + `useSyncExternalStore` 小 store） | `SIDECHAT_REGISTRY_KEY` / `readSideChatRegistry` / `sideChatRegistry` / `sideChatLinesFor·ActiveFor·AddLine·SetActive·DropLine` |
| 侧线 tab 正文（侧线头 + 提示条 + 嵌入式会话） | `SideChatTab`（含 `createSideChat` 并发去重、`sideChatForkErrorText` 人话翻译） |
| 自名子槽正文（复用官方 embedded 工厂） | `SideChatConversation` + `SideChatFixedChatView`（`phase` 三值折叠 + `hero` 必填） |
| tab 类型注册 | `RIGHT_BAR_TABS` 新增 `id '@miasaki/dsh-sidebar/sidechat'` / `kind 'sidechat'` / `children: { [SIDECHAT_CHILD_SLOT]: { kind:'single', scope:'session' } }`，子槽正文用 `ctx.slots.inject` 挂载 |

**验收（隔离实例 + 无头 Edge，**走真实 UI 路径**，非探针注入）**：

| # | 判据 | 结果 |
|---|---|---|
| 1 | 官方右栏引导页出现「辅助对话」入口胶囊 → 点开 tab 正文挂载 | ✅ |
| 2 | 点「新建侧线」→ fork → 官方 embedded 会话渲染出**继承的父历史** + 原生 composer | ✅（截图 `_refs/spikes-m2/m21.png`） |
| 3 | 登记表落盘 + 官方持久化 tab（`{kind:'sidechat', contentId:'sidebar://sidechat'}`） | ✅ |
| 4 | **主会话运行中**开侧线：fork 成功、主会话继续跑完、继承历史不含进行中增量（S3） | ✅ |
| 5 | 主会话**首轮运行中**开侧线（0 完成轮次）：界面给人话引导而非宿主错误串 | ✅ |
| 6 | 审查 tab 未被注册循环改动影响 | ✅ |
| 7 | 控制台错误 / HTTP ≥400 | 零 |

**测试**：新增 `test/sidechat-registry.test.js`（13 项：登记表纯函数 7 项 + 源码契约 6 项——锁死「fork 成功即同步写盘」「pendingCreations 在 finally 释放」「phase 三值 + hero 必填」「自名子槽 + slots.inject」「提示条写明『继续』语义」「空白父会话给人话引导」）；
单测合计 **86 通过**，`verify-all sidebar` **13/13 PASS**。

**与设计的偏差（已在正文同步）**：

- 登记表**按 `parentSessionId` 直接索引**，去掉 `workspaceKey` 一层——sessionId 全局唯一，那层是冗余的（§4.3 已改）。
- 关 tab 的 release 走 **React effect cleanup**（组件卸载即 release，实测 reload 路径同构），未用 `registerCloseHandler`——M2.3 若需要「关 tab 时同步清插件侧状态」再补。
- 隐藏时释放 retain 并卸载会话（`tab.visible && pageVisible` 两道门）：这是设计原意（停订阅），代价是切回时重新加载——接受。
- 未做（按里程碑后置）：**M2.2** 侧线树 / `parentId` 对账 / running 徽标；**M2.3** tab 菜单动作 / 在主区打开 / 复制兜底 / 深链接。

**待人工复验**：本节验收跑在隔离的 `web` profile 实例上；**miasaki 桌面端 / 浏览器 GUI 刷新后复验**（同一插件，同一条 link: 安装路径）仍建议由你走一遍。





## 8. 拍板记录（2026-09-28：六项**已按建议全部通过**，用户原话「按建议的来」）

> 下列六项不再待决；实施按各条的**建议项**执行，M2.1 已落地（§7.2）。保留全文以便回溯取舍理由。

1. **偏差①**：侧线在官方会话列表可见是否接受（**命名已实测**：父标题加 ` (1)`；注意**同一父连续 fork 的三条侧线全都叫「…(1)」**，见 §7.1 事实 3——所以「命名可辨」不成立，侧线头要自带区分）？不接受则需重新评估「fork 之外的侧线承载」（如 host 半自存会话镜像，代价大）。
2. **入口唯一性**：仅引导页胶囊 + tab 菜单动作；是否需要保留 2026-09-12 已删的会话头快捷入口（用户当时拍板删，此次只问要不要回退）。
3. **带回主对话**：本期只给「复制」兜底，M3 再评估 composer 注入——是否接受。
4. **（2026-09-28 新增）偏差④ 边界声明怎么办**：见 §5.1(A)。**S8 已实测复现**：无关问题不越界，但一句「继续」就让侧线接着做父任务——这不是理论风险。**建议 = a + d 加强版**：M2 在侧线头常驻一句「侧线继承主会话历史：**说『继续』= 接着做主线未完成的活**」（把真实行为讲清楚，比泛泛的提示有用），同时把「fork 时注入 model-only 边界」记为 M3 / 上游需求；**不建议 b**（往 child 塞用户可见的假消息 + 白跑一轮模型，语义不等价）。
5. **（2026-09-28 新增）侧线里「父历史整段可见」是否接受**：ZCode 的副屏是**空白起步**（继承历史只喂模型、UI 不显示），我们复用官方会话工厂 ⇒ 侧线面板会**完整显示继承来的父历史**。这是原生语义、也符合「唯一事实来源」，但侧线一打开就是一大段旧内容。**建议接受**，并把「只显示本侧线新增消息 / 折叠继承段」列为 M2.3 体验项。
6. **（2026-09-28 新增）偏差⑤ goal 继承要不要补偿**：S9 证实 fork 会连父会话的 goal / plan / todo 一起继承（§5.2）。**建议 = 做最小补偿**：侧线创建后调官方 API 清掉 child 的 goal（`ctx.remote.goals.get` → `clear`），代价是 child 日志里多一条 `goal/change{operation:'clear'}` 痕迹；**plan 无客户端 API**，只能接受或让模型自己退出 plan 模式（写进已知限制）。若你选「不做补偿」，则侧线会显示父目标、且侧线里 `create_goal` 会因 `GOAL_ALREADY_EXISTS` 失败。

## 9. 参考

> **2026-09-28 订正**：下列 `vendor/deepseek-harness/...` 路径**全部出自 0.1.6-alpha.2**，只可用于理解，**不得作为实施依据**（§2.0）。
> 实施取证改走两处：① **运行版（权威）** = `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<pkg>\lib\types\**\*.d.ts`（带 JSDoc 的公开契约）+ `lib\client.js`（实现）；
> ② **源码级阅读** = `vendor/deepseek-harness-0.1.7-alpha.2/packages/...`（0.1.7 线）。
> ZCode 对标为源码级实读（`_refs/zcode` @ v3.14.3 / commit `29628c9`），结论见 §5.1。


- `vendor/deepseek-harness/packages/client/ui-subagent/src/client/sidebar-chat/index.tsx`（官方右栏会话先例，全文）
- `vendor/deepseek-harness/packages/client/ui-sidebar-right/{README.zh.md,src/client/service.ts}`
- `vendor/deepseek-harness/packages/api/session-controller/src/client/contract/sessions.ts`（fork/retain 契约）
- `vendor/deepseek-harness/packages/client/ui-conversation/src/client/{apply.ts,contract/slots.ts,skeleton/ConversationContent.tsx}`（embedded 工厂）
- `dsh-miasaki-canvas/design/2026-09-05-m1-spike-findings.md`（fork+prompt 链路先验，0.1.1-rc.2 时点）
- `dsh-miasaki-sidebar/design/2026-09-10-migrate-to-official-rightbar.md`（当前形态设计依据）
- `dsh-miasaki-sidebar/design/2026-09-08-tavern-sidebar-comparison.md` §3.6（visible 门 = 本设计前置块）
- ZCode 对标（2026-09-27 调研）：zai-org/ZCode `apps/zcode-cli/packages/core/src/runtime/methods/session-fork.ts`、`packages/ui/src/lib/selectionSideChatRuntime.ts`、`packages/ui/src/lib/workspaceSidePane.ts`
