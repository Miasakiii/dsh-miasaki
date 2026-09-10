# 官方右栏落地后的路线重估（DSH 0.1.5-rc.1）

- 日期：2026-09-10
- 触发：DSH 0.1.5-rc.1 内置了官方右侧 Sidebar（`@deepseek-ai/dsh-client-ui-sidebar-right`）
- 性质：**重估与待拍板**，本文不改实现；锚点兼容改动另见 `design/CHANGELOG.md` 同日条目
- 取证：`dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.5-rc1-slot-contract-2026-09-10.md`（§6.2/§6.3 为官方右栏与 `ctx.layout` 契约）

---

## 1. 事实：0.1.5 官方右栏提供了什么

官方 `ui-sidebar-right` 占据 root 的 `rightbar` 槽（`kind: 'single'`），并通过 `ctx.layout.openRightbar(track, fullscreen)` / `closeRightbar()` 向框架报告呈现。能力清单（均为官方 README 原文要点）：

| 能力 | 说明 |
|---|---|
| 停靠套件 | 分栏（最多左右两格、默认均分、分隔条 20%~80%）、拖拽重排、拖出浮窗（`float`/`dock`） |
| 两种形态 | `push`（默认，会话区让出轨道）／`fullscreen`（覆盖窗口，保留宽屏底层列宽） |
| 响应式 | 窗口 <768px 自动全屏；窄屏退出全屏会收起右栏 |
| 面板本身 | 无标题行；形态切换 + 折叠按钮搭在 tab 条末端 |
| 展开入口 | 会话头角落席位 `conversation.session.header.corner`（面板隐藏时出现） |
| tab 类型扩展 | `ctx.sidebarRightTabs.register({ id, kind, patterns, priority, canOpen, title, guide })` + 正文 `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body)` |
| 另有两个扩展席位 | `sidebar.right.tab.guide`（chain，替换引导页正文）、`sidebar.right.tab.menu.item`（list，tab 菜单追加项） |
| 随包 tab | 文件树（`ui-sidebar-files`）、文档预览 Markdown/代码/HTML/PDF/图片（`ui-sidebar-documentpreview`） |
| 资源路由 | `ctx.sidebarRight.openResource(address, options?)` / `openTab(kind, options?)`；地址是 `dsh-resource://<type>/…` |
| 模型交付 | 模型可显式交付文件，在右栏预览 / 默认应用打开 / 文件管理器定位 |
| **持久化** | **无** —— 官方明写「状态只在内存中。刷新会让每个会话回到折叠的默认态」 |
| 撤销 | 已记录布局序列，但只经 `@internal` 方法步进，**产品控件有意缺席** |

---

## 2. 与本线既定决策的关系

### 2.1 当年否决 `details` 槽的理由，同构地适用于 `rightbar`

`design/2026-09-06-sidebar-roadmap-design.md` §3.1.1 第 1 条记着：

> 曾考虑直接注入原生 `details` 插槽借用整列——**否决**：官方槽位文档明示该槽 OCCUPIED by ui-conversation's DetailsPanel（工具调用详情面板），`kind:"single"` 语义下注册即**整体替换列内容并连带顶掉官方工具详情 seat**（"registering here replaces the column and takes that seat with it"），破坏原生功能，触碰红线。

**0.1.5 的 `rightbar` 是同一情形**的升级版：`single` 语义、已被官方 `ui-sidebar-right` 占用，注册即整体顶掉官方右栏 —— 连带丢掉**文件树、文档预览、模型交付文件、分栏/全屏/浮窗**。按本线既有红线（"破坏原生功能"），**直接占用 `rightbar` 应当否决**。

### 2.2 当年否决"重基座"的成本前提已消失

§9 决策记录 2026-09-08 条写明：**不采纳**多 tab 分栏 / 底部面板 / 自由浮窗 / body portal 挂载，理由是「需先有"多 tab 并列"UI，与轻量右栏定位冲突」。

当时的分栏与浮窗是**要自己造的重基座**；现在它们是**官方壳的免费能力**，且扩展接口是官方公开的 tab 类型注册。**否决的成本前提不再成立**，需要重新评估。

### 2.3 一个 0.1.2 不存在、0.1.5 新出现的问题：双右栏推挤叠加

本线用 frame `padding-right` 推挤给自研面板让位；官方右栏用框架轨道（grid 第三列）给官方面板让位。**两者互不知晓**：

```
用户同时打开官方右栏（点会话头角落按钮）+ 自研右栏（点标题栏按钮）
→ 官方把 grid 第三列从 0 变为 ~45% 视口宽
→ 自研同时给 frame 加 padding-right = 自研宽度
→ 主区被压缩两次
```

0.1.2 上不存在这个场景（没有官方右栏）。这是本次重估**最实际的动机**——无论选哪条路，都必须处理。

---

## 3. 三条路

| 维度 | **A 保持自研**（+共存处理） | **B 接入官方 tab 类型** | **C 占用 `rightbar` 自研壳** |
|---|---|---|---|
| 推挤机制 | 自研 `padding-right` + CSS 变量 | 官方轨道（框架算） | 官方轨道（自己调 `openRightbar` 报告） |
| 官方右栏（文件树/预览/交付文件） | **保留**（官方独立可用） | **保留**（同一壳体内并存） | **丢失**（顶掉官方占用方） |
| 分栏 / 全屏 / 浮窗 / 拖拽重排 | 无 | **白拿** | **白拿**（但要自己接管官方 tab 系统或自建） |
| 按会话持久化（开合/宽度/tab） | **保留**（v3） | **丢失**（官方只在内存，刷新回折叠） | 保留（自己实现） |
| 窄屏抽屉 + 右滑关闭 | **保留** | 丢失（官方 <768px 全屏） | 保留（自己实现） |
| 桌面壳标题栏入口 + chrome reserve | **保留** | 丢失（官方入口在会话头 corner） | 保留 |
| 空态标签选择页 | **保留** | 官方引导页替代 | 保留 |
| z-index 与 canvas 的共存约束（<100） | **保留**（已验证） | 官方层级，需重验 | 需重验 |
| host 半（`/sidebar/api/*` 审查数据面） | 不变 | 不变（tab 正文仍调自己的 host 路由） | 不变 |
| 迁移工作量 | **零**（仅共存检测） | 中（三个 tab 改为官方类型 + 重做入口/持久化降级） | 大（重写壳 + 接管 tab 系统） |
| 风险 | 跟随官方几何变化；双栏叠加（需处理） | 丢持久化的产品体验回退 | 触碰"顶掉官方功能"红线 |

### 3.1 对 A 的共存处理（最小改动）

自研壳在每次推挤前检测官方右栏是否已占轨道，若是则**让位**（收起自研面板或降级为浮层）。可用的检测信号（均已实测/源码确证）：

- `[data-rightbar-col]` 的 `getBoundingClientRect().width > 0`（该属性恒存，见 slot 契约文档 §3.4）
- frame 上 `data-rightbar-collapsed` 属性**不存在**（条件属性，仅在收起时挂载）

> 注意：`data-rightbar-collapsed` / `data-rightbar-fullscreen` 是 `|| undefined` 的条件属性，**不能写 `[data-rightbar-collapsed="false"]`**；恒存的只有 `data-rightbar-col`。
>
> 另注：`ctx.layout` 在 0.1.5 只暴露 `openRightbar`/`closeRightbar`（占位方报告用），**没有"查询右栏是否打开"的读接口**——所以只能走 DOM 信号。

### 3.2 对 B 的保留评估

若走 B，需要明确接受三项产品回退：**刷新回折叠**、**窄屏全屏而非抽屉**、**入口从桌面壳标题栏移到会话头**。其中持久化回退与 §1.1「审查是常显上下文面板」的定位冲突最直接——每次刷新都要重新打开，常显性被削弱。

---

## 4. 建议

> **后续决策（2026-09-10 同日，用户拍板）**：用户选择**走官方右栏、自研壳退役**（即本节的路线 B），否定了下面的 A 建议。原文：「官方做了侧边栏就用官方的，不自己做了」。本文保留三条路的对比与分析作为决策依据；**实施以 `design/2026-09-10-migrate-to-official-rightbar.md` 为准**。本节以下内容为当时的推荐，不再代表当前方向。

**推荐 A（保持自研壳）+ §3.1 的共存处理**，理由：

1. 本线的差异化在**内容**（审查四视图 + 收尾自检清单、辅助对话侧线、终端启动器）与**在壳上做过的产品决策**（按会话持久化、抽屉、桌面壳入口、空态选择页），官方 tab 类型只能承载内容，壳层优势会全部丢失；
2. 走 C 触碰本线既有红线（顶掉官方功能），不予考虑；
3. 走 B 是**以产品回退换免费能力**——收益是分栏/全屏/浮窗，这三项对本线"轻量右栏"定位并非刚需（当年正是因为"与轻量定位冲突"而否决自建）；
4. A 的增量成本只有一个共存检测，且信号已确证。

**待用户拍板**：是否接受"官方右栏与自研右栏互斥（官方打开时自研自动收起）"。若不接受互斥，则需要在 A 与 B 之间重选。

---

## 5. 取证出处

- 官方右栏能力与扩展契约：`packages/client/ui-sidebar-right/README.zh.md`（tag `dsh-v0.1.5-rc.1`）
- `rightbar` / `sidebar` / `main` / `shell.overlay` 槽声明：`packages/client/ui-layout/src/client/index.ts`
- 三栏 DOM 与条件 data 属性：`packages/client/ui-layout/src/client/AppFrame.tsx`（实测数据见 slot 契约文档 §8.1）
- `ctx.layout` 接口：`packages/client/ui-layout/src/client/service.ts`
- 本线既有决策：`design/2026-09-06-sidebar-roadmap-design.md` §3.1.1、§9
