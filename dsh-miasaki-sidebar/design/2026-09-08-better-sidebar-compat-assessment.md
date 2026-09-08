# betterSidebar 兼容层评估（2026-09-08）

> 用户拍板「sidebar 下一站：先评估 betterSidebar 兼容层」。本文是**纯评估**，不含实施。
> 全部 API 事实来自只读核对 `_refs/dsh-better-sidebar`（v0.18.0，MIT）与 `_refs/dsh-tavern`
> 源码，以及本项目既有调研（`2026-09-08-tavern-sidebar-comparison.md`）。

---

## 1. 要评估什么

**兼容层** = 在 `@miasaki/dsh-sidebar` 的 client 半注册 cordis 服务 `ctx.betterSidebar`，
实现 dsh-better-sidebar 的 API 表面，使**基于该基座开发的第三方插件**（如 dsh-tavern）
无需改动即可把 tab 注册进我们的右栏并渲染。

与既有路线的边界：

| 事项 | 是否发生 |
|---|---|
| 引入 better-sidebar 的代码/依赖 | **否**（只实现其 API 表面，路线 D 红线不破） |
| 改 DSH 本体 | 否 |
| 我们的 tab 框架被替换 | 否（兼容层是适配器，注册表仍是我们自己的） |

---

## 2. API 表面实测

### 2.1 `TabDescriptor`（注册一个 tab 的入参，共 **16 字段**）

来源：`_refs/dsh-better-sidebar/src/client/service.ts:162-243`

| 字段 | 语义 | 兼容层必要性 |
|---|---|---|
| `id` | 唯一 id，同时是 `SidebarTab.type` | **必需** |
| `title` | `string \| () => string` | **必需** |
| `icon` | `ReactNode \| (size) => ReactNode` | 需要（tab 栏渲染） |
| `order` | + 菜单排序，默认 100 | 需要 |
| `hidden` | 不出现在 + 菜单 | 低 |
| `available(ctx, scope, state)` | + 菜单禁用谓词 | 低 |
| `single` | `true` ≡ `dedupeKey: () => id` | **必需**（tavern 用了） |
| `dedupeKey(tab)` | 去重键 | 需要 |
| `createTab(state)` | 自定义 tab 铸造 + 状态补丁 | 需要（tavern 用了） |
| `urlTarget(url)` | 外链认领（v0.13+） | 低 |
| `settings` | 声明式设置（开关/嵌套） | 低 |
| `badge(ctx, scope, state)` | tab 栏徽章 | 低 |
| `onOpen/onActivate/onClose` | 生命周期（仅服务路径触发） | 中 |
| `component(props)` | 渲染函数 | **必需** |

### 2.2 `BetterSidebarService`（**16 方法 + 2 只读属性**）

来源：`service.ts:347-429`

`registerTab` / `registerFileViewer` / `getTabs` / `getFileViewers` / `getTab` /
`isTabEnabled` / `isViewerEnabled` / `matchFileViewer` / `openTab` / `closeTab` /
`subscribe` / `subscribeState` / `getSnapshot` / `updateTab` / `activateTab` / `openFile`
+ `readonly version` / `readonly features`（能力清单，消费者按成员判断是否可用）。

### 2.3 数据形状

来源：`state.ts:31-46 / 85-120 / 1106-1115`、`service.ts:143-159`

- `SidebarTab`：`{ id, type, title, path?, diff?, meta?, pin? }`——`meta` 是插件自有 JSON，随布局持久化；
- `SidebarState`：含 `panelOpen / width / activePane / nextTerminal / nextBrowser /
  expanded / revealed / splits / bottomOpen / bottomHeight / bottomOpenedOnce /
  bottomSplits / floats`——**`splits` 是递归树**（`{kind:'leaf', tabs[], active}` 或 `{kind:'split', dir, sizes, children}`）；
- `SidebarSnapshot`：`{ sessionId, state, prefs }`；
- `TabComponentProps`：`{ ctx, store, scope, tab, visible, expanded?, revealed?,
  onToggleDir?, onReferenceFile?, onOpenFile?, onOpenDiff?, onSubagentJump? }`；
- `SidebarStore` 类（`state.ts:1433+`，12 个方法）。

> **修正既有记录**：2026-09-08 对比调研里写的「17 字段 + 17 方法」是概数，
> 实测为 **16 字段 + 16 方法 + 2 属性**。差异不大，但下面的成本判断依赖「实际被用到的子集」。

---

## 3. 第三方实际依赖面（以 dsh-tavern 为样本）

来源：`_refs/dsh-tavern/tavern-plugin/src/client/main.js`（同构产物 `lib/client.js`）

### 3.1 它真正调用的 API（只有 6 个方法）

| 调用点 | 行（src） | 用途 |
|---|---|---|
| `registerTab({...})` | 5709 / 5905 / 6110 / 6371 / 6821 / 7944 / 8094 | 注册 7 个 tab |
| `openTab({type}, {sessionId})` | 5221-5225 | 从宿主 UI 打开指定 tab |
| `updateTab(id, {meta})` / `{title}` | 6310 / 6466 / 8025 | 清 meta、纠正标题 |
| `closeTab(id, {sessionId})` | 8030 | 清理已退役 tab |
| `getSnapshot()` | 8005 | 读 `snapshot.state.splits` / `bottomSplits` 遍历 tab |
| `subscribeState(fn)` | 8105 | 状态变化时重跑标题纠正 |

**未使用**：`registerFileViewer` / `getFileViewers` / `matchFileViewer` / `openFile` /
`isTabEnabled` / `isViewerEnabled` / `getTab` / `getTabs` / `activateTab` / `subscribe` /
`urlTarget` / `settings` / `badge` / `available` / `hidden`。

### 3.2 组件侧 props 用法

- 主要用 `props.scope`（如 `appendMention(props.scope.sessionId, …)`）、`props.ctx`、`props.tab.id`；
- **没有发现 `props.store` 的使用**；
- `appendMention` 走的是宿主 `ctx.conversation.input.for(actx)`，**与 betterSidebar 无关**。

### 3.3 两条硬约束（决定了兼容层的下限）

1. **`inject` 数组包含 `betterSidebar`**（`main.js:7993`）——cordis 语义下服务缺失则
   **整个 client 插件不激活**，不是降级而是完全不加载。→ 兼容层是「能不能用 tavern」的开关。
2. **`reconcileLibraryTabTitles()` 直接遍历 `snapshot.state.splits` / `bottomSplits` 的递归树**
   （`main.js:8003-8031`），读 tab 的 `id/type/title`。→ 我们**必须提供同形状的 `state.splits`**
   （哪怕内部只有一个叶子）。它对 `bottomSplits` 有 `if (!node) return` 防御，可给 `undefined`。

它对缺失方法普遍有 `typeof !== "function"` 防御，所以**桩比缺失更安全**——但服务本身不能缺。

---

## 4. 成本分解

前提：**多标签框架已具备**（见 §5）。

| 工作项 | 量级 | 说明 |
|---|---|---|
| 服务骨架 + 注册表 | 中 | cordis 服务注册、`registerTab`/`getTabs`/`subscribe`、disposer 语义、`features`/`version` |
| tab 实例管理 | 中 | `openTab`/`closeTab`/`activateTab`/`updateTab` + `scope` 定向 + `single`/`dedupeKey` 去重 + `meta` 持久化 |
| state 形状兼容 | 低 | 用「单叶子假树」满足 `state.splits` 遍历（`{kind:'leaf', id, tabs, active}`） |
| `TabComponentProps` 组装 | 低-中 | `ctx`/`scope`/`tab`/`visible` + 回调；`store` 给最小实现（样本不用） |
| 未实现 API 的显式桩 | 低 | 抛明确错误或 no-op + 从 `features` 里缺席，**不静默假成功** |
| 兼容验证 | 中 | 装 tavern 真机跑 7 个 tab（注册、打开、标题纠正、meta） |
| **合计（档 A）** | **约 1 个批次** | 不含 FileViewer、多 pane、底部面板、自由浮窗 |

---

## 5. 前置条件与既有决策的关系

2026-09-08 对比调研给出「不采纳兼容层」，两条理由如下：

| 原理由 | 现状复核 |
|---|---|
| 「17 字段 + 17 方法，成本与 M2 同量级」 | **高估**——样本实际只用 6 方法 + 5 字段子集；完整档才与 M2 同量级 |
| 「且需先有『多 tab 并列』UI」 | **正在消失**——审查 tab 改版（`2026-09-08-sidebar-review-redesign-implementation.md`）已定稿 `tabs[]/active` 多实例 + keep-mounted，正是该前置 |

即：**兼容层的边际成本，因为多标签框架的引入而显著下降**。这也解释了为什么用户把「评估兼容层」排在审查 tab 改版之后。

---

## 6. 收益与风险

### 收益

- **生态接入**：任何基于 `ctx.betterSidebar` 的插件可直接复用我们的右栏，不必等我们自研对应能力；
- **具体可验证标的**：dsh-tavern 的 7 个面板（酒馆状态/人物卡库/预设库/系统提示词/世界书库/剧本库/用户画像）；
- **不破红线**：不引入 better-sidebar 代码、不改 DSH 本体、不装重基座。

### 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| **tavern 未必跑得通** | 它的 `inject` 还含 `slots/sessions/workspaces/layout/connection/conversation/remote/remote.commands/tavernSessionSignals`，兼容层到位≠插件可用 | **先做 spike**（§7） |
| API 漂移 | better-sidebar 仍在演进（v0.18），字段/语义会变 | 兼容层只承诺样本用到的子集，`features` 声明能力，不做「假装完整」 |
| 定位漂移 | 兼容层让右栏越来越像「另一个基座」 | 明确档 A/档 B 边界；档 B（多 pane/split/底部面板/浮窗）不启动 |
| 维护成本 | 双份语义（我们的 + betterSidebar 的） | 兼容层隔离在独立模块，且以 tavern 回归为验收门 |

---

## 7. 建议：先 spike，再拍板

**档 A（推荐）· 最小兼容层**

- 实现样本实测依赖的 6 方法 + `state.splits` 单叶假树 + `TabComponentProps` 组装；
- 未实现 API 给显式桩（no-op / 抛错），并从 `features` 里缺席；
- 验收门：**装 dsh-tavern 后 7 个 tab 能注册、打开、渲染，标题纠正生效**；
- 成本约 1 个批次。

**档 B（不推荐现在做）· 完整兼容**

补 FileViewer + 多 pane/split + 底部面板 + 自由浮窗 + prefs 设置页——与 M2 同量级，
且与轻量右栏定位冲突，M2 之后再评估。

**spike（建议立即做，半天）**

不写生产代码，只在 sidebar 里**临时**注册一个 `ctx.betterSidebar` 桩服务，验证三件事：

1. tavern 的 `inject` 是否因此满足（插件是否激活、有无其他 inject 缺失）；
2. 7 个 `registerTab` 是否被调用（桩里打日志）；
3. 任一 tab 组件能否在我们提供的 props 下渲染（哪怕只是一个空壳）。

spike 结论决定档 A 是否立项——**成本极低，且能直接证伪**。
按项目纪律，探针用完即删（`_refs/scripts-archive/` 归档日志，不入库）。

---

## 8. 决策记录

| 日期 | 决策 |
|---|---|
| 2026-09-08 | 用户拍板「先评估 betterSidebar 兼容层」；本文产出评估结论：样本依赖面远小于既有估计（6 方法 / 5 字段子集），前置多标签框架已定稿 → **建议先 spike 再立项**，档 A 约 1 批，档 B 不做 |
