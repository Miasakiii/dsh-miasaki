# 迁移到官方右栏：自研壳退役，三个 tab 接入 `sidebar.right.pane.tab`

- 日期：2026-09-10
- 决策（用户拍板）：**官方做了侧边栏就用官方的，自研壳不做**；审查 / 终端 / 辅助对话三个 tab 保留，改为官方右栏的 tab 类型接入
- 前置条件：**必须先升级到 DSH 0.1.5-rc.1** —— `ctx.sidebarRightTabs` 与 `sidebar.right.pane.tab` 在 0.1.2 上不存在，本方案无法在旧版本开发或验证
- 上游依据：`packages/client/ui-sidebar-right/README.zh.md`（tag `dsh-v0.1.5-rc.1`）；契约细节另见 `dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.5-rc1-slot-contract-2026-09-10.md` §6.2
- 取代关系：本文取代 `design/2026-09-06-sidebar-roadmap-design.md` 的 §3（右栏壳设计）与 §3.2（tab 框架）；§1 红线与 §4–§6 的 tab **内容**设计继续有效

---

## 1. 迁移映射

| 自研实现（现 `client.js`） | 官方对应 | 处置 |
|---|---|---|
| `shell.overlay` 注册 `Shell` 面板（`client.js:1278`） | 官方 `rightbar` 停靠面 | **删** |
| frame `padding-right` 推挤 + `<html>` 的 `--miasaki-sidebar-width` + 常驻 CSS | 框架原生轨道（`openRightbar(track, fullscreen)`） | **删**（连同 `FRAME_ANCHOR_SELECTOR` / `FRAME_FINGERPRINT` / `resolveFrame` / `pushFrame`） |
| 自研 tab 栏（标签胶囊 / × 关闭 / ⌄ 全部标签 / ＋ 新建） | 官方 tab 条（胶囊 + 添加控件 + 分栏控件 + 形态/折叠按钮） | **删** |
| 自研空态选择页（`EmptyState`，Edge 范式） | 官方引导页 + 每类型一个 `guide` 入口胶囊 | **删**，改为注册 `guide` 条目 |
| `TABS` 数组（`client.js:1053`，三个 `{id,label,note,icon}`） | `ctx.sidebarRightTabs.register(...)` × 2 | **改写**（sidechat 无实现，暂不注册） |
| `TAB_BODIES = { review: ReviewTab, terminal: TerminalTab }`（`client.js:1102`） | `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: <类型 id> }, Body)` | **改写** |
| tab 组件入参 `{ tabId, visible }`（`client.js:1281`） | 正文经 `useTabInfo()` 读 `{ sidebar, panel, tab }`；`tab.visible` | **改写** |
| 拖宽把手 / 抽屉手势 `drawerCloseDecision` / 遮罩 / 右滑关闭 | 官方拖拽区 + 全屏（<768px 自动全屏） | **删**（`test/drawer-gesture.test.js` 随之退役） |
| 桌面壳标题栏按钮注入 + `--sidebar-chrome-reserve` 让位 | 官方展开按钮在 `conversation.session.header.corner` | **删**（见 §4 的补偿讨论） |
| 按会话持久化 `miasaki-sidebar:v3:<sessionId>` | 官方**不持久化**（刷新回折叠） | **保留存储层**，改作"自动重开"用途（见 §4.1） |
| popover 定位（`client.js:614`）/ 视图菜单 / 审查 UI（848–1010）/ 终端启动器（1009） | —— | **保留**（内容层，与壳无关） |
| host 半 `index.js`（`/sidebar/api/*`：review 四视图、terminal 启动器、围栏） | —— | **完全不动** |
| `conversation.session.header.actions` 的 `sidebar-toggle` 按钮（`client.js:504`） | 仍是合法 slot | **删除**（用户拍板：官方右栏自带展开按钮，不再保留自研入口） |

**一句话**：删掉整个"壳"（推挤 + 挂载 + tab 栏 + 空态 + 抽屉 + 桌面壳集成），保留"内容"（审查 UI、终端启动器、popover）与 host 半。

---

## 2. 官方契约要点（实施时照此写）

两阶段注册，都在各自的 `ctx.effect` 里（注册与创建它的插件同生共死）：

```js
// ① 类型声明：静态，无运行时钩子
ctx.sidebarRightTabs.register({
  id: '@miasaki/dsh-sidebar/review',   // 全局唯一身份（包名是天然取值）；同 id 二次注册 throw
  kind: 'review',                       // 打开时用的 kind
  title: () => '审查',                  // tab chip 文字，**打开时被捕获**
  guide: [{ kind: 'review', title: '审查', description: '收尾自检清单 + 本轮改动 diff', order: 10 }],
})

// ② 正文：key 是**类型 id**，不是 kind
ctx.slots.register({ name: 'sidebar.right.pane.tab', key: '@miasaki/dsh-sidebar/review' }, ReviewBody)
```

正文内取上下文：

```js
const { sidebar, panel, tab } = useTabInfo()
// sidebar：开合与全屏信息
// panel.id：所在停靠格的 id
// tab：原记录字段 + tab.visible + tab.navigation + tab.signal + tab.actions
```

其它要点：

- **页类型不给 `patterns`**（`patterns` 是给 `dsh-resource://` 资源地址用的 glob）。审查/终端都是"按 kind 打开"的页类型。
- 打开：`ctx.sidebarRight.openTab('review')`；`openTab`/`openResource` 都会**自动展开右栏**（"用户看不到的内容不算打开"）。
- 独占关闭规则的例外：作为**唯一停靠 tab 的引导页**不可关闭；关闭其它唯一 tab 会**连同整列一起收起**。
- 最多左右两格、默认均分、分隔条 20%~80%；宽度不足时不允许新分栏。
- 全屏：`sidebar-right` 的形态切换是面板自己的控件，**不在** `ctx.sidebarRight` 接口上。

---

## 3. 代码改动清单（升级到 0.1.5 之后执行）

| 文件 | 动作 |
|---|---|
| `client.js` | 删除壳层（约 1048–1288 段）：`cardIcon` 之外的 `TABS`/`tabMeta`/`tabLabel`/`EmptyState`/`Shell`；删除推挤与锚点段（29–46 附近的 `FRAME_ANCHOR_SELECTOR` 等）；删除抽屉手势 `drawerCloseDecision`；删除 `shell.overlay` 注册 |
| `client.js` | 新增 `sidebarRightTabs.register` × 2 + `sidebar.right.pane.tab` 注册 × 2；把 `ReviewTab`/`TerminalTab` 的入参从 `{ tabId, visible }` 改为 `useTabInfo()` |
| `client.js` | **删除** `sidebar-toggle` 注册、`ToggleButton` 组件与图标常量（用户拍板：不留自研入口） |
| `client.js` | 持久化键保留但降级为"上次打开的类型"（见 §4.1） |
| `package.json` | 版本号 +1；无新增依赖 |
| `test/drawer-gesture.test.js` | **删除**（被测函数随壳一起消失） |
| 其余 5 个测试文件 | 复核：`api-routing` / `review-data` / `review-view` / `terminal-launcher` 测的是 host 半与内容层 → 应全部保留；`client-tabs.test.js` 测的是自研 tab 模型 → **大概率退役** |
| `README.md` | 重写"右栏壳"相关段落（推挤锚点、抽屉、桌面壳让位、tab 栏全部失效）；保留审查/终端/辅助对话的能力描述 |
| `design/2026-09-06-sidebar-roadmap-design.md` | §3 / §3.2 标注"已被 2026-09-10 迁移取代" |
| `cordis.patch.yml` | 不动（host 半继续复用现有 DSH 服务器） |

---

## 4. 丢失的能力与补偿

### 4.1 按会话持久化（官方明确不提供）

官方原文：「状态只在内存中。刷新会让每个会话回到折叠的默认态。」

**补偿方案（可选，建议做）**：保留现有 localStorage 记录，把语义从"面板开合 + 宽度 + tab 列表"降级为"**上次打开的类型**"。插件激活后用 `ctx.sidebarRight.openTab(kind)` 自动重开，并在 `tab.actions` / 关闭事件里更新记录。

需要注意的边界：自动重开会**在每次页面加载时触发一次**，若用户当时正想用官方右栏做别的事（例如看文件树），会与我们抢焦点。建议加"仅当该会话上次确实开着"的判据，并把自动重开限制在首次挂载。

**不补偿也没问题**：这属于产品取舍，用户已拍板接受官方壳的默认行为。

### 4.2 两处自研入口（用户拍板：全部删除）

官方右栏自带的展开按钮在会话头 corner（`conversation.session.header.corner`）。用户明确要求「把我们加的右侧边栏按钮去掉」，因此**两处自研入口一并删除，不做补偿**：

- 会话头的 `sidebar-toggle`（注册在 `conversation.session.header.actions`，`order: 30`）；
- 桌面壳标题栏的注入按钮（`syncTitlebarButton` 及其 `#miasaki-titlebar .tb-btn.tb-sidebar` CSS）。

理由：官方入口已覆盖同一用途，再保留一个只会出现「两个开关同时管一列」。用户要打开审查 tab，走官方右栏的「添加控件」→ 引导页入口（我们在 `guide` 里注册了审查与终端两个入口胶囊）。

> 原方案曾建议「保留会话头按钮作为快捷入口」，**该建议已被用户否决**。

### 4.3 窄屏抽屉 + 右滑关闭

官方行为：窗口 <768px 时打开右栏**自动全屏**；窄屏退出全屏会收起右栏。

这与原抽屉形态（遮罩 + 右滑关闭 + 8px 轴锁定）体验不同，但覆盖了同一场景（窄屏查看右栏内容）。**接受官方行为，不补偿**。`drawerCloseDecision` 与其 9 项测试随之删除。

### 4.4 z-index 与 canvas 共存

原约束「右栏 z-index < 100，canvas 全屏盖住右栏是预期行为」是为自研 `shell.overlay` 浮层定的。迁移后面板由官方框架绘制在 `rightbarCol` 里，**层级由框架决定**，该约束自然失效——但需要**重新验证** canvas 全屏（z-index 100）与官方右栏的叠压关系是否仍符合预期。

---

## 5. 实施顺序（升级之后）

1. 升级到 0.1.5-rc.1，确认基础可用（`dsh web` 起得来、官方右栏能用文件树/预览）
2. 在隔离实例上先跑一次最小验证：注册一个 `sidebar.right.pane.tab` 的空正文，确认能出现在引导页并能打开
3. 迁移 `review`（先把入参改成 `useTabInfo()`，正文逻辑不动）
4. 迁移 `terminal`
5. 删除壳层代码与退役测试
6. 实机验证：三主题下的官方右栏外观、审查四视图、终端启动器、与 canvas 共存
7. 更新 README / CHANGELOG / roadmap 设计文档

---

## 6. 待确认（升级后实测）

- `useTabInfo()` 的确切字段名与 `tab.visible` 语义（本文据官方 README 推断）
- `guide` 条目的字段全集（本文用了 `{ kind, title, description, order }`）
- `ctx.sidebarRightTabs.register` 对 `title` 的调用时机（README 说"打开时捕获"，故语言切换不会更新已开 tab 的标题）
- 自动重开（§4.1）是否会与官方首次打开逻辑冲突
