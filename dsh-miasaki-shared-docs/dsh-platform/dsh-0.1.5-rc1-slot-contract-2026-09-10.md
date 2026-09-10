# DSH 0.1.5-rc.1 Web 插件 Slot 契约钉死（只读调研）

- 日期：2026-09-10
- 取证对象：`deepseek-ai/deepseek-harness` tag `dsh-v0.1.5-rc.1`（npm `@deepseek-ai/dsh@0.1.5-rc.1`）
- 本机现状：`@deepseek-ai/dsh@0.1.2-rc.1`（全局 npm）
- 性质：**只读调研，未改动任何代码**。所有结论均来自官方源码，非猜测；无法从源码确证的一律进 §8「待实测项」。

---

## 0. 摘要（先看这三条）

1. **三条 web 插件线的 slot 注册名，一个都不用改。** release note 里那句「原 `conversation` Slot 迁移为 `main` 的 `conversation` key」只影响**承载整个会话界面的那一个 slot**；`conversation.*` 命名空间下的子 slot（`conversation.session.header.actions`、`conversation.view`、`conversation.session.header.utilities` …）名字与 kind/scope 全部未变。
2. **唯一确定失效的是 sidebar 线的 DOM 主锚点 `[data-slot="conversation"]`**，等价替代是 `[data-slot="main"]`。该文件已有特征查询兜底，因此**不会崩**，只会静默退到 fallback。
3. **0.1.5 新增了三条正式扩展通道**，正好覆盖我们此前靠 DOM hack 实现的能力：全局面板（`main` keyed + `sidebar.panellist`）、官方右栏 tab 类型、`ctx.layout` 几何/导航接口。这是重估 sidebar 线与 canvas 线形态的窗口。
4. **第 1–3 条已在本机 0.1.5-rc.1 隔离实例上实测复现**（见 §8）：推挤精确压下 300px 且可还原、三条 frame 解析路径全部命中且一致、`label` thunk 合法并会显示为 `SSH`。**升级到 0.1.5 时，三条线的 web 插件客户端代码目前没有一处是必须改的**；唯一值得改的是把 sidebar 的主锚点补成兼容写法。

---

## 1. 取证范围

| 文件（tag `dsh-v0.1.5-rc.1`） | 用途 |
|---|---|
| `packages/client/ui-layout/src/client/index.ts` | root 四个子 slot 的声明（权威） |
| `packages/client/ui-layout/src/client/AppFrame.tsx` | 三栏 DOM、frame 的 `data-*`、`main` 渲染方式 |
| `packages/client/ui-layout/src/client/service.ts` | `ctx.layout` 接口（`ILayout`）、`MainPanelId`、`PanelInfo` |
| `packages/client/ui-layout/README.zh.md` | 三栏语义、`main` keyed slot 说明 |
| `packages/client/ui-conversation/src/client/contract/slots.ts` | `conversation.*` 全部 slot key 与 owner props（权威） |
| `packages/client/ui-conversation/src/client/contract/views.ts` | `ViewTab` 形状 |
| `packages/client/ui-conversation/README.zh.md` | 会话壳占位说明 |
| `packages/client/ui-sidebar/src/client/contract/slots.ts` | `sidebar.*` 全部 slot key 与 owner props（权威） |
| `packages/client/ui-sidebar/README.zh.md` | `sidebar.panellist` 注册契约 |
| `packages/client/ui-sidebar-right/README.zh.md` | 官方右栏、tab 类型注册契约、`ctx.sidebarRight` |
| `packages/client/ui-settings/src/client/contract/slots.ts` | `settings.*` 全部 slot key 与 owner props |
| `packages/client/ui-renderer/src/client/scoped-slots.tsx` | `data-slot` 取值规则、`ANCHOR_STYLE`、keyed 分发 |
| `packages/client/README.zh.md` | 客户端包地图 |

---

## 2. `main` keyed slot：确切结构

### 2.1 root 的子 slot 变了

0.1.2 的 root 直接挂着 `conversation`（普通 slot）。0.1.5 的 root 只有四个子 slot（`ui-layout/src/client/index.ts` 的 `register({ name: 'root', children: {...} })`）：

```ts
'sidebar':      { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
'main':         { kind: 'keyed';  scope: 'root' }          // ← 会话界面挪到这里
'rightbar':     { kind: 'single'; scope: 'root'; owner: RightbarOwnerProps }
'shell.overlay':{ kind: 'list';   scope: 'root' }          // ← 仍然存在
```

`main` 的官方注释原文：

> Central panel selected by sidebar entry id. The reserved `conversation` key hosts the Conversation; other keys receive no Session binding.

### 2.2 一个必须纠正的理解偏差

**`main.conversation` 不是 `main` 这个 keyed slot 的 key。** 它是 ConversationPanel 自己声明的**子 slot 名**；keyed 的 key 值是字符串 `'conversation'`。

```ts
// ui-conversation/src/client/apply.ts
slots.inject('main', function* () {
  yield slots.register({
    name: 'main',
    key: 'conversation',
    children: { 'main.conversation': { kind: 'single'; scope: 'session-maybe' } },
  }, ConversationPanel)
  ...
})
```

```tsx
// AppFrame.tsx
const panelId = usePanelInfo(info => info.activePanelId)
return renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })
```

即三者关系是：

| 概念 | 值 |
|---|---|
| root 的子 slot 名 | `main`（kind `keyed`） |
| `main` 的 key（会话界面那一个） | `'conversation'` |
| 会话壳自己声明的子 slot 名 | `'main.conversation'`（kind `single`, scope `session-maybe`） |

所以 SlotMap 里那条 `'main.conversation': { kind: 'single'; scope: 'session-maybe' }` 是**子 slot 声明**，不是 key 定义。这个区分很重要：想注册"全局面板"，要注册的是 `main` 的**新 key**，不是新 slot 名。

### 2.3 `main` slot 的注册方式（全局面板）

```js
ctx.slots.register({ name: 'main', key: '<你的面板 id>' }, PanelComponent)
```

- keyed slot **无 `key` 时不渲染**（`entriesOfSlot(slotKey).find(e => e.options.key === opts?.entryKey)`）。
- 面板 id 的类型是 `MainPanelId`（`Branded<'MainPanelId'>`），与左栏 `sidebar.panellist` 的 list id 共用同一身份。
- 非 `conversation` 的 key **不接收 Session 绑定**（官方注释原文：other keys receive no Session binding）。

---

## 3. DOM 锚点：`[data-slot="conversation"]` 已不存在

### 3.1 取值规则（已确证）

`ui-renderer/src/client/scoped-slots.tsx` 的 `SlotOutlet` 是唯一普通 outlet 渲染点，**`data-slot` 字面等于 slot key，不做任何转换**（keyed 的 key 不拼接、不编码）：

```tsx
return (
  <div data-slot={slotKey} style={ANCHOR_STYLE}>
    {renderOutletContent(host, slotKey, ownerProps, opts, scopeBinding)}
  </div>
)
```

`ANCHOR_STYLE` 仍然存在且语义未变：

```ts
const ANCHOR_STYLE = { display: 'contents' } as const
```

> Anchor style shared by every outlet wrapper: `display:contents` keeps the wrapper out of layout …, so the anchor is purely addressable surface.

锚点存在性不随注册抖动（源码注释原文）：fallback、crash-face、undeclared-empty 都渲染在这个 wrapper 内部，所以 `[data-slot="main"]` 即使在面板切换/无 entry 时**依然存在**。

### 3.2 0.1.5 的实际 DOM 层级

```
div.frame[data-dragging?][data-sidebar-collapsed?][data-rightbar-*?]
├ div.sidebarCol      > div[data-slot="sidebar"][style="display:contents"]
├ div.centerCol
│ └ div[data-slot="main"][style="display:contents"]
│   └ div[data-slot="main.conversation"][style="display:contents"]   ← 直接子元素
│     └ ConversationRoot 输出
├ div.rightbarCol[data-rightbar-col] > div[data-slot="rightbar"]…
└ div.overlayLayer[data-shell-overlay] > div[data-slot="shell.overlay"]…
```

keyed slot **没有 per-key 包装 div**；ConversationPanel 自身与正常态的 `SlotErrorBoundary` 都不产 DOM —— 所以两个锚点是直接父子关系。

### 3.3 对 `dsh-miasaki-sidebar` 的结论

现状（`dsh-miasaki-sidebar/client.js:37-46`）：

```js
const FRAME_ANCHOR_SELECTOR = '[data-slot="conversation"]'   // ← 0.1.5 失效
const FRAME_FINGERPRINT = 'div[style*="grid-template-columns"]'
const FRAME_FALLBACK_SELECTOR = '#root ' + FRAME_FINGERPRINT  // ← 0.1.5 仍然命中
```

`resolveFrame()` 是「主锚点 → 兜底」两段式，所以 0.1.5 上表现为：主锚点 `querySelector` 返回 null → 走 `FRAME_FALLBACK_SELECTOR` → **拿到 frame**（AppFrame 仍以 inline `style={{ gridTemplateColumns: ... }}` 渲染，特征查询成立）。**功能不会崩，但主锚点那一环已死。**

最小改动（位置语义完全等价：仍挂在 centerCol 下、仍是 `display:contents`、`parentElement` 仍是中栏容器）：

```js
// 兼容 0.1.2 与 0.1.5 两版
const FRAME_ANCHOR_SELECTOR = '[data-slot="main"], [data-slot="conversation"]'
```

若需确认「会话面板确已激活」，用 `[data-slot="main.conversation"]`，但要取中栏需在它之上再 `.parentElement` 一次；其它主面板激活时它不存在，故**容器定位首选 `[data-slot="main"]`**。

### 3.4 frame 上的 `data-*`（重要：恒存 vs 条件）

`AppFrame.tsx` 的 frame 根节点：

| 属性 | 恒存？ | 说明 |
|---|---|---|
| `data-sidebar-collapsed` | ❌ 条件 | 写成 `sidebarCollapsed \|\| undefined`，**只在折叠时挂载** |
| `data-rightbar-collapsed` | ❌ 条件 | `cols.rightbar === 0 \|\| undefined` |
| `data-rightbar-fullscreen` | ❌ 条件 | 仅全屏时 |
| `data-rightbar-instant` | ❌ 条件 | 退场瞬时态 |
| `data-dragging` | ❌ 条件 | 仅拖拽中 |

恒存属性只在别处：

| 选择器 | 位置 |
|---|---|
| `[data-rightbar-col]` | 右栏容器（恒存） |
| `[data-shell-overlay]` | overlay 层（恒存） |
| `[data-side]` | 拖拽手柄（`sidebar` / `rightbar`） |
| `[data-slot="…"]` | 每个 slot 宿主 |

**中栏容器没有任何专属 data 属性**，CSS Module 类名（`centerCol`）是哈希值不可依赖；中栏唯一的稳定锚点是 `[data-slot="main"]`，其 `parentElement` 即中栏容器。

> 注意：`data-*` 条件是 `|| undefined` 写法，所以**不能用 `[data-sidebar-collapsed="false"]` 之类反推状态** —— 属性不存在就是 false。

### 3.5 其它顺带改名

0.1.2 → 0.1.5 列语义也改了：`details` slot / `DetailsColumn` → `rightbar` / `RightbarColumn`；`data-details-collapsed` → `data-rightbar-collapsed`。

---

## 4. slot key 存活对照表

### 4.1 `conversation.*`（`ui-conversation/src/client/contract/slots.ts`，全部仍在）

| slot key | kind | scope | 状态 |
|---|---|---|---|
| `main.conversation` | single | session-maybe | **新增**（子 slot，取代旧 root 级 `conversation`） |
| `conversation.session` | single | session | 不变 |
| `conversation.session.header` | single | session | 不变 |
| `conversation.session.header.lineage` | single | session | 不变 |
| `conversation.session.header.actions` | list | session | **不变** ← canvas / sidebar 在用 |
| `conversation.session.header.utilities` | list | session | **不变** ← desktop/session-log-move 在用 |
| `conversation.session.header.corner` | single | session | 新增/仍在 ← 官方右栏展开按钮的席位 |
| `conversation.view` | list | session | **不变** ← ssh / token-monitor 在用 |
| `conversation.composer` | chain | session | 不变 |
| `conversation.hero.workspace` / `.brand.mark` / `.agentPreset` | single | root | 不变 |
| `conversation.input.dock` / `.overlay` / `.left` / `.right` / `.plan` / `.model` / `.attachments` | list/single | session(-maybe) | 不变 |
| `conversation.composer.dock` / `.bar` | list/single | session(-maybe) | 不变 |

### 4.2 `sidebar.*`（`ui-sidebar/src/client/contract/slots.ts`，全部仍在）

| slot key | kind | scope | owner props |
|---|---|---|---|
| `sidebar.brand.mark` | single | root | `{ size: number }` |
| `sidebar.brand.name` | single | root | marker |
| `sidebar.panellist` | list | root | `{ size: number; active: boolean }` |
| `sidebar.workspaces` | single | root | `{ wide: boolean; expandSidebar: () => void }` |
| `sidebar.settings` | single | root | `{ wide: boolean }` |
| `sidebar.footer.action` | list | root | `{ wide: boolean }` ← token-monitor 在用 |

> `sidebar.workspaces` 的官方注释警告：注册到它**是整槽替换**（"registering here replaces the navigation column outright … To add something to the sidebar, register into one of those inner seats instead."）。dsh-tavern 式的整槽替换语义在 0.1.5 未变。

### 4.3 `settings.*`（`ui-settings/src/client/contract/slots.ts`，全部仍在）

| slot key | kind | scope | owner props |
|---|---|---|---|
| `settings.trigger` | single | root | `{ wide: boolean }` |
| `settings.header` | single | root | marker |
| `settings.action` | list | root | marker |
| `settings.close` | single | root | marker |
| `settings.section` | list | root | `{ close: () => void }` ← pet-panel / free-model-pool 在用 |
| `settings.plugins.tab` | list | root | marker |
| `settings.onboarding` | list | root | `{ stepId; complete; openSection }` |
| `settings.general.item` | list | root | marker |

### 4.4 layout 层

| slot key | kind | scope | 状态 |
|---|---|---|---|
| `root` | — | — | 不变（唯一 `renderSlot('root')` 入口） |
| `sidebar` | single | root | 改名自旧的 `sidebar`（语义扩大为整条左栏，占用方为 ui-sidebar） |
| `main` | **keyed** | root | **取代旧 root 级 `conversation`** |
| `rightbar` | single | root | **新增/改名**（旧的 `details`） |
| `shell.overlay` | list | root | **不变** ← sidebar / token-monitor 在用 |

> `shell.overlay` 官方定位：frame 级浮层，位于所有列之上、各列滚动容器之外，**层本身 click-through**，条目需自己 opt-in 指针事件。官方明说这是「给你自己的 frame 级表面」的**增量席位**（fresh `id` 与已交付条目并列，而非替换）。

---

## 5. 三条线逐条迁移清单

### 5.1 canvas（`dsh-miasaki-canvas`）

| 位置 | 现状 | 0.1.5 结论 | 处置 |
|---|---|---|---|
| `client.js:77-81` | `conversation.session.header.actions`，`id: 'canvas-view-switch'`，`order: 25` | slot 仍在，kind `list`/scope `session`，owner props 为 marker（无值） | **不用改** |

可选升级（非必须）：把「会话布」从 header 的一个切换按钮升级为**一等全局面板** —— 注册 `main` 的一个 key + `sidebar.panellist` 一项，左栏就出现图标，点击经 `ctx.layout.selectPanel` 切换，面板占满中栏。收益是会话布不再挤在 header，且不接收 Session 绑定（canvas 需要的正是「非会话视图」语义）。

### 5.2 sidebar（`dsh-miasaki-sidebar`）

| 位置 | 现状 | 0.1.5 结论 | 处置 |
|---|---|---|---|
| `client.js:37` | `FRAME_ANCHOR_SELECTOR = '[data-slot="conversation"]'` | **实测失效**（选择器计数 0） | 改 `'[data-slot="main"], [data-slot="conversation"]'` |
| `client.js:38-39` | 指纹 + `#root` 兜底 | **实测命中**，与主锚点链等价的第三条路径同样命中 | 保留（主锚点改后成为冗余的第二道保险） |
| `client.js:318` | 常驻 CSS `#root > [data-slot="root"] > div,${FRAME_FALLBACK_SELECTOR}{padding-right:…}` | **实测通过**：`#root > [data-slot="root"] > div` 就是 frame；推挤精确压下 300px 且可还原 | 保留，**无需改动** |
| `client.js:504-508` | `conversation.session.header.actions`，`id: 'sidebar-toggle'`，`order: 30` | slot 仍在 | **不用改** |
| `client.js:1278-1281` | `shell.overlay`，`id: 'sidebar-shell'` | slot 仍在，kind `list`/scope `root`，**无 owner props** | **不用改** |

**路线级重估点**：0.1.5 官方自带右侧 Sidebar（`ui-sidebar-right`），能力与我们高度重叠 —— 多标签、分栏（最多左右两格、默认均分、分隔条 20%~80%）、全屏、Markdown/代码/HTML/PDF/图片预览、模型交付文件、默认应用打开/文件管理器定位。它通过官方 `ctx.layout.openRightbar(track, fullscreen)` 报告呈现，由框架负责让出轨道 —— **这正是我们靠 `padding-right` 推挤手写的那件事**。

因此两条路可选：

- **A（保守）**：保留自研右栏，只修锚点。继续自持推挤、z-index、chrome reserve、会话级持久化等全部逻辑；代价是与官方右栏能力重复且要跟框架几何变化。
- **B（推荐评估）**：把 sidebar 线的三个 tab（审查 / 辅助对话 / 终端启动器）改为**官方右栏的 tab 类型**，白拿推挤、分栏、全屏、拖拽、折叠；代价是右栏形态与官方一致（没有独立浮窗之外的自由度），且官方明言「状态只在内存中，刷新回到折叠态」——我们现在的会话级持久化会丢失。

### 5.3 ssh（`dsh-miasaki-ssh`）

| 位置 | 现状 | 0.1.5 结论 | 处置 |
|---|---|---|---|
| `client.js:36-44` | `conversation.view`，`id: 'ssh'`，`order: 20`，`label: () => 'SSH'` | slot 仍在，kind `list`/scope `session` | **完全不用改**：`SlotLabel = string \| (() => string)`，thunk 是官方设计，投影时被调用，tab 显示 `SSH` |

`conversation.view` 的 owner props 在 0.1.5 是 `ConvViewOwnerProps`：

```ts
interface ConvViewOwnerProps {
  viewRequest: ConversationViewRequest | null   // 一次性焦点请求
  openView: (view: string, focus: string) => void
  completeViewRequest: () => void
}
```

—— `SshView` 是**无参函数声明**（`function SshView()`），不消费 owner props，故 owner 形状变化对它无影响。`ViewTab` 由 `resolveSlotLabel(entry.options.label) ?? entry.options.id` 投影为 `{ id: string; label: string }`。

### 5.4 desktop 线的 web 插件（顺带核对）

| 插件 | 位置 | slot | 0.1.5 |
|---|---|---|---|
| `dsh-token-monitor` | `lib/client.js:1155` | `conversation.view`（`label: "用量"` 字符串） | 不变 |
| `dsh-token-monitor` | `lib/client.js:1161` | `sidebar.footer.action` | 不变 |
| `dsh-token-monitor` | `lib/client.js:1165` | `shell.overlay` | 不变 |
| `dsh-session-log-move` | `lib/client.js:99,110` | `conversation.session.header.utilities` | 不变 |
| `dsh-pet-panel` | `lib/client.js:184` | `settings.section` | 不变 |
| `dsh-free-model-pool` | `lib/client.js:207` | `settings.section` | 不变 |

---

## 6. 0.1.5 新增的三条正式扩展通道

### 6.1 全局面板（`main` keyed + `sidebar.panellist`）

两步，id 必须一致：

```js
// ① 面板本体：占用 main 的一个 key
ctx.slots.register({ name: 'main', key: 'my-panel' }, MyPanel)

// ② 左栏图标：list id 与上一步的 key 相同
ctx.slots.register({
  name: 'sidebar.panellist',
  id: 'my-panel',
  order: 10,
  label: '我的面板',        // 字符串，或随语言变化的值
}, MyPanelIcon)
```

- 图标 owner props：`{ size: number; active: boolean }`（`active` 是该面板当前是否被选中）。
- 元数据形状：`SidebarPanelMetadata { id: MainPanelId; order: number; label: string }`。
- 点击行由左栏经 `ctx.layout.selectPanel(id)` 完成；**选择不存在的主面板条目会抛错并保留当前选中态**。
- 每一行通过注入的 `usePanelInfo` 读取自己的选中态。
- 没有注册项时，列表及其间距都不渲染。

### 6.2 官方右栏的 tab 类型（`ctx.sidebarRightTabs`）

两阶段，都在自己的 `ctx.effect` 里：

```js
// ① 类型声明（静态，无运行时钩子）
const disposeType = ctx.sidebarRightTabs.register({
  id: 'my-tab-kind',          // 全局唯一，包名是天然取值；同 id 二次注册会 throw
  kind: 'my-kind',
  patterns: ['*.md'],         // 可选：dsh-resource:// 地址 glob
  priority: …,                // extension / builtin / fallback 档
  canOpen: address => …,      // 可选否决
  title: address => …,        // tab chip 文字，打开时捕获
  guide: […],                 // 可选：引导页入口
})

// ② 正文
ctx.slots.register(
  { name: 'sidebar.right.pane.tab', key: 'my-tab-kind' },
  MyTabBody,
)
```

正文经 `useTabInfo()` 读取 `{ sidebar, panel, tab }`：`sidebar` 提供开合与全屏信息，`panel.id` 命名所在格，`tab` 含原记录字段、`visible`、`navigation`、`signal`、`actions`。

另两个扩展席位：`sidebar.right.tab.guide`（chain，替换引导 tab 正文）、`sidebar.right.tab.menu.item`（list，向 tab 菜单追加内容级动作）。

### 6.3 `ctx.layout` 正式几何/导航接口

```ts
interface ILayout {
  selectPanel(panelId: MainPanelId | null): void   // null = 回到会话界面；未注册的 key 会 throw
  beginNavigation(): AbortSignal                   // 异步导航的取消信号
  toggleSidebar(): void
  openRightbar(track: boolean, fullscreen: boolean): void   // 右栏占位方报告呈现
  closeRightbar(): void
}
```

配套 owner props：

- `sidebar` slot：`SidebarOwnerProps { collapsed: boolean; width: number }`
- `rightbar` slot：`RightbarOwnerProps { width: number; viewportWidth: number; canShow: boolean }`

`rightbar` 的官方语义：**右栏是一条轨道，不是一个盒子** —— 占位方按解析出的普通宽度把自己的面板贴到 frame 右缘绘制，轨道只决定中栏是否让位；全屏保留报告的轨道但隐藏外侧拖拽手柄。

> 注意 `rightbar` 是 `single`，已被官方 `ui-sidebar-right` 占用 —— 想占用它等于替换官方右栏。与官方右栏共存的正路是 §6.2 的 tab 类型。

---

## 7. 与升级相关的其它破坏性变更（非 slot，但同期生效）

来自 `v0.1.5-rc.1` release note，尚未逐条验证，仅登记：

- **会话数据格式升级至 V3**：受支持的旧日志经版本迁移生成新日志并保留原文件，**升级后不支持降级读取**。
- **Session 生命周期**：持久化 API 改为生命周期持有的 `SessionHandle`；`agentLoop.create()` 变异步；新增 session 锁，同一 session 至多被一个进程持有。
- **插件 Agent API**：移除 `ctx.agent`，调用方需显式传递 Agent（本仓全量 grep 无命中，暂安全）。
- **Inbox API**：`Inbox` 改为类型接口，改走 `agent.inbox`；`hasPending` / `claim` 不再是公共 API。
- **默认工具**：SDK / Headless / ACP 默认用 `read`/`write`/`edit`；Web `minimal` 与 Python `sdk-minimal` 默认只给持久 shell，`str_replace_editor` 需显式启用。
- **自定义 persona 配置拆分为前缀 + 后缀** —— 影响 `dsh-miasaki-desktop/preset-sources/` 与 `apply-presets.ps1`。
- 新增 `dsh-http-proxy`：所有出站请求遵循 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`。
- 新模型 `DeepSeek-V41-Flash`（`deepseek-flash`），支持文本、图片与历史中系统提示词更新，新会话默认使用。

---

## 8. 实测验证与剩余项

### 8.1 已实测（2026-09-10，本机 0.1.5-rc.1 隔离实例）

手段：在 `_refs/` 下用 `npm install @deepseek-ai/dsh@0.1.5-rc.1 --ignore-scripts` 装出隔离副本，
`DSH_HOME` 指向 `_refs/probe-015/dsh-home`（**完全不碰真实 `~/.dsh`**），起 `dsh web --port 3099 --no-open`，
再由临时探针插件 + Playwright 无头 chromium 回读。探针源码已归档到 `_refs/scripts-archive/probe-015/`，可复现。
（`--ignore-scripts` 是必要的：沙箱下 npm 无法 spawn，而唯一被跳过的脚本是 `@google/genai` 的
`preinstall: echo 'preinstall: no-op'`，本身就是空操作。）

| 验证项 | 实测结果 |
|---|---|
| `[data-slot="conversation"]` | 计数 **0** —— 确认失效 |
| `[data-slot="main"]` | 计数 **1**，`display: contents`，`parentElement` = `div.pI_x6G_centerCol`（与 0.1.2 的 `conversation` 锚点位置完全一致） |
| `[data-slot="main.conversation"]` | 计数 **1**（活跃会话时存在，是 `[data-slot="main"]` 的直接子元素） |
| `#root > [data-slot="root"] > div` | **命中 frame** |
| `#root div[style*="grid-template-columns"]` | **命中同一节点** |
| `main.closest('div[style*="grid-template-columns"]')` | **命中同一节点** |
| 三条路径是否一致 | **一致**（`frame-three-paths-agree = true`） |
| frame inline 样式 | `280px minmax(0px, 1fr) 0px` —— inline `grid-template-columns` 仍在 |
| frame 上的 data 属性 | `class, data-rightbar-collapsed, style` —— 印证 §3.4「条件属性」结论 |
| **推挤有效性** | 给 frame 加 `padding-right: 300px` → 中栏 1160px → **860px**；撤销后回到 1160px，**delta 精确 300** |
| `label` 形态 | 字符串与 thunk **都被接受**（`accepted (disposer returned)`） |

实测还抓到一条方法论要点：**直接 `ctx.slots.register({ name: 'conversation.view', … })` 在 apply 时会抛
`slot "conversation.view" is not declared (a parent entry's children table must declare it)`** ——
必须走 `ctx.slots.inject(key, callback)`。三条线现有代码全部用 `inject` 包裹，写法正确。

空会话（hero）态下实际渲染的 slot 宿主清单：

```
root | sidebar | sidebar.brand.mark | sidebar.brand.name | sidebar.workspaces |
sidebar.workspaces.directoryFlow | sidebar.footer.action | sidebar.settings |
settings.trigger | settings.onboarding | main | main.conversation |
conversation.composer | conversation.hero.brand.mark | conversation.hero.workspace |
conversation.hero.workspace.directoryFlow | conversation.hero.agentPreset |
conversation.composer.bar | conversation.input.attachments | rightbar | shell.overlay
```

`shell.overlay` 与 `sidebar.footer.action` 在空会话态就已渲染；`conversation.session.*` 与
`conversation.view` 要等会话激活（与官方 README「blank Session 仍不渲染 `conversation.view` slot」一致）。

### 8.2 已由源码确证（无需实测）

- **`label` thunk 合法**：`SlotLabel = string | (() => string)`，官方注释点名 “nav rows, tabs”；
  `SlotCore.register` 对 label **零校验**（原样入账）；消费方
  `resolveSlotLabel(label) = typeof label === 'function' ? label() : label`，
  `ui-conversation/src/client/apply.ts` 的 `viewTabs()` 用
  `resolveSlotLabel(entry.options.label) ?? entry.options.id` 投影。
  **ssh 线的写在 0.1.2 与 0.1.5 上语义相同，且比字符串更规范**（locale 切换无需重新注册）。
  别被 `ui-renderer/src/client/registry.ts` 里的 `ErasedRegisterOptions { label?: string }` 误导 ——
  那是类型擦除视图，不是运行时校验。
- **list 排序规则**：先 `priority` 升序，再 `order` 升序，仍相等则保持注册顺序（稳定排序）；`order` 缺省按 `0`。canvas `25` / sidebar `30` / token-monitor `15` / ssh `20` 在同一 priority 组内按此序渲染。
- **`ctx.slots.entries(key)`** 存在，返回 ledger 顺序的缓存数组；元素的 `options.label` 是**未求值的原始值**。
- **`SshView`** 是无参函数声明，不消费 owner props。

### 8.3 剩余低风险项

- `settings.section` 的 owner props 在 0.1.5 为 `{ close: () => void }`。pet-panel / free-model-pool 分别以
  `PetPanel` / `FreeModelPoolPanel` 注册，未从 owner props 取值；React 函数组件忽略未知 prop，
  故**即便 0.1.2 的形状不同也不构成破坏**。仅当这两个组件内部确实读取了 `props.close` 之类才需核对。
- 三条线的 slot 注册名全部无需改动，因此 §7 的破坏性变更（V3 会话格式、SessionHandle、persona 前后缀拆分、
  patches 重打）才是升级的真实工作量所在。

---

## 9. 取证链接（tag `dsh-v0.1.5-rc.1`）

- 仓库：<https://github.com/deepseek-ai/deepseek-harness>
- Release：<https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1>
- [ui-layout/index.ts（root 四子 slot 声明）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-rc.1/packages/client/ui-layout/src/client/index.ts)
- [ui-layout/AppFrame.tsx（三栏与 data-*）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-rc.1/packages/client/ui-layout/src/client/AppFrame.tsx)
- [ui-layout/service.ts（ctx.layout）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-rc.1/packages/client/ui-layout/src/client/service.ts)
- [ui-conversation/contract/slots.ts（conversation.* 权威）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-rc.1/packages/client/ui-conversation/src/client/contract/slots.ts)
- [ui-sidebar/contract/slots.ts（sidebar.* 权威）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-rc.1/packages/client/ui-sidebar/src/client/contract/slots.ts)
- [ui-settings/contract/slots.ts（settings.* 权威）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-rc.1/packages/client/ui-settings/src/client/contract/slots.ts)
- [ui-renderer/scoped-slots.tsx（data-slot 规则）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-rc.1/packages/client/ui-renderer/src/client/scoped-slots.tsx)
- [ui-sidebar-right/README.zh.md（官方右栏与 tab 契约）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-rc.1/packages/client/ui-sidebar-right/README.zh.md)
- [ui-slots/README.zh.md（slot 系统模型）](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-rc.1/packages/client/ui-slots/README.zh.md)
