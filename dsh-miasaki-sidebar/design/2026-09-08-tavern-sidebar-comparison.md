# dsh-tavern 右侧边栏实现对比调研

- 日期：2026-09-08
- 状态：调研定稿（未动代码）
- 参考对象：[flizzywine/dsh-tavern](https://github.com/flizzywine/dsh-tavern) `main@0c5bb33`（v1.5.0）+ 其右栏基座 [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（v0.18.1）
- 本机环境：DSH `0.1.2-rc.1`（`@deepseek-ai/dsh` 全局包），与 better-sidebar v0.18.0 起的适配基线一致
- 对位产物：本线 `@miasaki/dsh-sidebar` v0.3.0-miasaki.2（M1 已收口）

## 0. 结论摘要（TL;DR）

1. **dsh-tavern 没有自研右栏**。它右侧的 7 个面板全部由第三方基座 `dsh-better-sidebar` 承载，tavern 只调用 `ctx.betterSidebar.registerTab()` 注册；左栏则是整槽替换官方 `sidebar.workspaces`。所以"参考它的右侧边栏实现"，实际参考的是 **better-sidebar 的服务化框架 + tavern 的接入用法**。
2. **推挤思路与我们相同，落地方式不同**。better-sidebar 用"CSS 变量 + 常驻样式规则"（`<html>` 上写 `--dsh-sidebar-width`，由 CSS 规则消费）；我们目前是"JS 直写 `frame.style.paddingRight`"。
3. **发现一个我们没用上的官方锚点**（已真机实测，§6）。DSH 会给每个 slot 宿主渲染 `<div data-slot="<slotKey>">`（`dsh-client-ui-renderer` 的 `renderOutletContent`）。因此 `[data-slot="conversation"]` 是稳定语义锚点，其 `parentElement` 就是 AppFrame 的 centerCol，再上一级即 frame。我们现在的 `#root div[style*="grid-template-columns"]` 仍可用，但语义弱一档、且依赖宿主内联样式写法。
4. **它的服务契约比我们私有注册表厚得多**（17 字段 `TabDescriptor` + 17 方法服务），但那是"基座"的必然成本；路线 D 明确不要这层，**不建议照搬**。
5. **三项可低成本吸收**：① 锚点换官方 `data-slot` 链（含兜底）；② tab 组件补 `visible` 性能门（M2 必需）；③ 围栏补 `sec-fetch-site` / `Origin` 检查（我们目前只比 Host）。

## 1. 调研对象与方法

| 项 | dsh-tavern | dsh-better-sidebar | @miasaki/dsh-sidebar |
|---|---|---|---|
| 定位 | 酒馆类游戏 Agent（消费方） | 服务化侧边栏基座（框架方） | 自研轻量右栏（本线） |
| 规模 | `tavern-plugin/src/client/main.js` 8169 行 | `src/` 约 160 个 TS/TSX | `client.js` 752 行 + `index.js` 482 行 |
| 右栏来源 | `ctx.betterSidebar`（依赖声明） | 自研 | 自研 |
| 许可证 | MIT | MIT | 仅调研参照，不装、不 fork |

调研方法：两个仓库 `--depth 1` 克隆到 `_refs/`（本机 git 需 `-c http.sslBackend=openssl`，默认 schannel 报 `SEC_E_NO_CREDENTIALS`）；对 DSH 本机安装包做静态取证（`~/.npm-global/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-{layout,renderer,conversation}/lib/client.js`）。

## 2. dsh-tavern 右侧边栏的真实构成

### 2.1 依赖关系（不是自研）

`tavern-plugin/package.json` 的 `dsh.client.inject` 里明写 `"dsh-better-sidebar"`，`dependencies` 亦声明；`cordis.patch.yml` 的 `inject` 列表含 `shell`、`agentPresets` 等宿主服务，但右栏服务来自基座。

### 2.2 七个注册 tab

| tab id | 标题 | order | single | 入口 |
|---|---|---|---|---|
| `dsh-tavern:cards` | 人物卡库 | 3 | ✓ | 左栏工作台按钮 |
| `dsh-tavern:user-profile` | 用户画像 | 3 | ✓ | 设置/左栏 |
| `dsh-tavern:presets` | 预设库 | 4 | ✓ | 左栏 |
| `dsh-tavern:system-prompts` | 系统提示词 | 5 | ✓ | 设置区 |
| `dsh-tavern:worldbooks` | 世界书库 | 6 | ✓ | 左栏（可带 `meta.worldBookSource` 定向打开） |
| `dsh-tavern:status` | 酒馆状态 | 7 | ✓ | 会话头 actions + 左栏，`createTab` 返回 `{patch:{panelOpen:true}}` 自动展开面板 |
| `dsh-tavern:resources` | 剧本库 | 7 | ✓ | 左栏 |

注册形态（`main.js:7944`）：

```js
ctx.effect(() => ctx.betterSidebar.registerTab({
  id: 'dsh-tavern:status',
  title: '酒馆状态',
  order: 7,
  single: true,
  createTab: () => ({ tab: { id, type, title }, patch: { panelOpen: true } }),
  component: props => React.createElement(TavernStatusTab, {
    sessions: ctx.sessions, uiConversation, sessionId: props.scope.sessionId, executeSlash,
  }),
}), 'dsh-tavern: Better Sidebar status tab')
```

要点：① `ctx.effect()` 包住注册，返回 disposer（HMR 安全）；② 组件通过 `props.scope.sessionId` 拿会话，自身再订阅 `ctx.sessions` / `uiConversation` 取实时数据；③ `createTab` 用 `patch` 顺带把面板打开。

### 2.3 左栏整槽替换

`main.js:5205` 用 `slots.inject("sidebar.workspaces", …)` 把官方左栏工作区槽整体换成 `TavernSidebar`，并在其中放打开各右栏 tab 的按钮（`openStatusTab` / `openCardLibraryTab` / …）。`toggleSidebar` 走 `props.wide ? ctx.layout.toggleSidebar() : props.expandSidebar()`——即宽屏折叠原生左栏、窄屏展开抽屉。

### 2.4 与服务化 tab 配套的两件事

- **标题协调**（`main.js:8004`）：`ctx.betterSidebar.subscribeState()` 里遍历 `state.splits` / `state.bottomSplits`，按 `expectedTitles` 用 `updateTab(id, {title})` 纠正标题，并 `closeTab()` 清退旧版本遗留 tab。这暴露了服务化 tab 的一个固有代价：**tab 状态与插件语义可能漂移，需要消费者主动 reconcile**。
- **输入框注入**（`appendMention`）：用 `conversation.input.for(actx).setDraft(...)` 往主会话输入框塞 `@"path"` / `@[label](tavern-worldbook:...)` 引用 chip——这条链路与本线 M2"带回主对话"设计（§5.1）同源，可复用。

## 3. better-sidebar 基座实现拆解

### 3.1 挂载：body portal + 守卫 + 几何自检

- **不用官方槽**：`index.tsx:280` 自己 `document.body.appendChild(host)`（`host[data-dsh-better-sidebar]`）+ `createRoot`，并在 `<body>` 上挂 `MutationObserver(childList)` 守护 host 被页面移除时重挂。
- **面板宿主**：`[data-dsh-panel-host]` 为 `fixed inset-0 z-40` 的含块层，用于免疫桌面套壳中间层 `transform` 对 `position:fixed` 含块的劫持。
- **几何自检降级**：挂载后一帧量测宿主 rect，与视口不符（>8px）即打 `data-dsh-panel-host-degraded` 并逐帧补 `translate` 抵消祖先变换，直到祖先变换真正消失才退出（避免"修正后看起来已修复"的抖动）。

我们对比：面板挂官方 `shell.overlay` 槽（`overlayLayer` 是 `absolute inset-0; z-20`），面板本体 `fixed` + `--sidebar-chrome-reserve` 让位桌面壳标题栏（实测 32px/0）。**官方槽更合规，但缺少"祖先 transform 劫持"的自检**——桌面壳若给 `#root` 加 transform，我们的 fixed 面板会错位且无告警。

### 3.2 推挤：CSS 变量 + 三类规则（与我们的差异核心）

better-sidebar（`layout.css`）：

```css
/* 尺寸只写变量，规则常驻 */
#root [data-dsh-frame],
#root > [data-slot="root"] > div {
  box-sizing: border-box;
  padding-right: var(--dsh-sidebar-width, 0px);
  transition: padding-right var(--ds-transition-duration-slow) var(--ds-ease-in-out);
}
#root [data-dsh-frame] > [data-side="details"],
#root > [data-slot="root"] > div > [data-side="details"] {
  transform: translateX(calc(0px - var(--dsh-sidebar-width, 0px)));  /* 详情列把手跟随 */
}
#root [data-dsh-center-col] { margin-bottom: var(--dsh-sidebar-height, 0px); }  /* 底部面板只压会话列 */
body[data-dsh-sidebar-collapsed] [data-slot="conversation.session.header"] > header { padding-right: 78px; }
body[data-dsh-sidebar-dragging] … { transition: none; }  /* 拖拽期禁用过渡 */
```

变量由 shell 写在 `<html>` 上（`Sidebar.tsx:436`）：`--dsh-sidebar-width` / `--dsh-sidebar-height`；`layoutPushSize()` 在窄屏返回 `{0,0}`（抽屉不推挤），底部面板高度另按"至少给会话列留 `PANEL_MIN`"裁剪。

我们对比（`client.js:77-91`）：

```js
const FRAME_SELECTOR = '#root div[style*="grid-template-columns"]'
const pushFrame = () => {
  const frame = document.querySelector(FRAME_SELECTOR)
  const push = state.open && state.viewport >= PUSH_MIN_VIEWPORT ? state.width : 0
  if (frame.style.paddingRight !== wanted) frame.style.paddingRight = wanted
}
```

| 维度 | better-sidebar | 我们 |
|---|---|---|
| 载体 | CSS 变量 + 常驻规则 | JS 直写内联 style |
| 抗 React 重渲染 | 强（规则不在 inline style diff 上） | 弱（靠 MutationObserver + 1.5s watchdog 重写） |
| 拖拽期 | 只改变量，一次 DOM 写 | 每次 `store.set` 都重查 DOM 并写 style |
| 详情列 | 平移把手随推挤移动 | `ctx.layout.closeDetails()` 联动收列（另一条让步链） |
| 过渡 | 推挤边与面板均走 CSS transition，`data-dragging` 与 `prefers-reduced-motion` 双关闭 | 面板宽度有 `transition:width .18s` + `[data-dragging]` 关闭；**推挤边无过渡**，且缺 `prefers-reduced-motion` |

### 3.3 定位与恢复（三层保险）

`resolveCenterColumn()`（`center-column.ts`）：锚点 `#root [data-slot="conversation"]`，取 `parentElement` = AppFrame centerCol；缓存已连接节点，仅在①缓存节点脱离 ②`<html style>` 变化（HMR 重同步信号）③距上次全量校验超过 1.5s 时才重查全文档。

恢复机制（`use-center-column.ts`）：`#root` 子树 `MutationObserver`（rAF 去抖，流式输出期不打爆）+ `<html style>` 属性观察（HMR 原地换节点时 childList 不变，只有 style 重写能被看见）+ 1.5s 无条件兜底 interval；命中新节点时把 `[data-dsh-center-col]` 标签随之迁移（CSS 规则锚在该标签上，一次写、终身免查）。

我们对比：单层 `MutationObserver(document.body, {childList,subtree,attributes,attributeFilter:['style']})` + 1.5s interval 重跑 `syncAll()`；锚点每次重查 `document.querySelector`。

### 3.4 服务契约（`ctx.betterSidebar`）

`TabDescriptor` 字段（`service.ts:162`）：`id` / `title` / `icon` / `order` / `hidden` / `available(ctx,scope,state)` / `single` / `dedupeKey(tab)` / `createTab(state)` / `urlTarget(url)` / `settings` / `badge(ctx,scope,state)` / `onOpen` / `onActivate` / `onClose` / `component(props)`。

`TabComponentProps`：`ctx` / `store` / `scope` / `tab` / `visible` / `expanded` / `revealed` / `onToggleDir` / `onReferenceFile` / `onOpenFile` / `onOpenDiff` / `onSubagentJump`。

服务方法：`registerTab` / `registerFileViewer` / `getTabs` / `getTab` / `isTabEnabled` / `isViewerEnabled` / `matchFileViewer` / `openTab(seed, scope?)` / `closeTab(id, scope?)` / `subscribe` / `version` / `features` / `getSnapshot` / `subscribeState` / `updateTab` / `activateTab` / `openFile`。

语义细节值得记：`openTab` 的 `scope` 可**定向到非当前会话**（不改 UI 激活会话）；`single: true` 是 `dedupeKey: () => id` 的语法糖；内容型打开（带 `path`/`url`）会自动展开承载面板，纯类型打开不会；`features` 是单调能力清单，消费者据此做版本兼容。

我们对比：`TABS` 是 `client.js:584` 的硬编码数组（`id` / `label` / `note` / `icon`），`TAB_BODIES` 映射组件；无 order、无 scope、无 badge、无生命周期回调、不对外开放。

### 3.5 状态与持久化

better-sidebar：按会话持久化布局/tab/面板几何（`state.ts`，localStorage），会话切换加载对应状态，陈旧状态自动净化；`getSnapshot()` 暴露 `{sessionId, state, prefs}`。

我们：`localStorage['miasaki-sidebar:v1']` 单键，只存 `{open, width, tab}`（`client.js:29`），**未按会话隔离**。目前 tab 内容（审查 cwd）已随会话切换，但"每个会话记住各自的面板开合/宽度/tab"是缺的。

### 3.6 性能门

- `visible` prop：非激活或面板收起时 live 视图暂停轮询。
- `tabContentCompare()`（`tab-content-memo.ts`）：把 tab 单元的 memo 比较字段收敛成纯函数，防止 shell 的几何重渲染牵连每个已挂载 tab 的 xterm/CodeMirror 子树（其 #315 的性能事故来源）。

我们：审查 tab 有 60s TTL + 手动刷新，终端无轮询，暂未暴露 `visible`；M2 辅助对话会引入订阅/轮询，**必须**先有这道门。

### 3.7 安全边界

better-sidebar `trust-fence.ts`：Host 必须 loopback 或命中 `trustedHosts`（端口可选语义）→ 再拒 `sec-fetch-site: cross-site` → 若带 `Origin` 则其 hostname 必须等于 Host 的 hostname（比较 hostname 而非 host，规避 Edge 151 对非默认端口 Origin 的序列化差异；`Origin: null` 直接拒）。文件 API 另按会话 cwd 边界（`path-security.ts`）。

我们 `index.js:407`：只做 Host hostname 比对（`trustedHostSet` = `localhost` / `127.0.0.1` / 配置项），加自带 CORS OPTIONS 应答。**缺 sec-fetch-site / Origin 两道**——对 DNS-rebinding 的纵深防御少一层，属于低成本可补项。

## 4. 逐项对比总表

| 维度 | dsh-tavern + better-sidebar | @miasaki/dsh-sidebar | 判断 |
|---|---|---|---|
| 壳来源 | 基座（第三方） | 自研 | 保持自研（路线 D） |
| 挂载点 | body portal + `[data-dsh-panel-host]` | 官方 `shell.overlay` 槽 | 保持官方槽；补几何自检 |
| 推挤载体 | CSS 变量 + 常驻规则 | JS 直写 `paddingRight` | **可改**（见 §5-B） |
| 推挤锚点 | `#root [data-dsh-frame]` → 兜底 `#root > [data-slot="root"] > div` | `#root div[style*="grid-template-columns"]` | **可改**（见 §5-A） |
| centerCol 锚点 | `[data-slot="conversation"]` 的 parent | 无（不区分列） | 采用（做底部面板时） |
| 定位恢复 | 缓存 + 三观察者 + 1.5s | 全量重查 + 1.5s | 可优化（低优先） |
| tab 框架 | 服务化注册表（17 字段） | 私有硬编码数组 | **不照搬**（见 §5-D） |
| 会话绑定 | `scope.sessionId` + 按会话持久化 | 单键持久化，tab 内容随会话 | 持久化可细化（见 §5-E） |
| 性能门 | `visible` + memo 比较器 | 无 | **采纳**（见 §5-C） |
| 围栏 | Host + sec-fetch-site + Origin | 仅 Host | **采纳**（见 §5-F） |
| 形态 | 多 tab + 分栏 + 底部面板 + 浮窗 | 单面板 + 三 tab 单页 + 空态选择页 | 不追（定位差异） |
| 生态 | 28+ 插件可注册 | 不开放 | 视需求再评估 |

## 5. 可借鉴项与取舍

### A. 锚点换官方 `data-slot` 链 —— 建议采纳（低风险）

**证据**：`dsh-client-ui-renderer/lib/client.js` 的 `renderOutletContent` 返回

```js
jsx("div", { "data-slot": slotKey, style: ANCHOR_STYLE, children: … })
```

即每个 slot 宿主 div 都带 `data-slot="<slotKey>"`；`dsh-client-ui-conversation/lib/client.js` 的 CSS 亦直接写 `[data-slot=conversation\.session]`，反证该属性真实存在于页面。

**层级**（`dsh-client-ui-layout/lib/client.js:239-258`）：

```
#root > [data-slot="root"] > div           ← AppFrame frame（inline grid-template-columns 的那个）
  ├ div.sidebarCol
  ├ div.centerCol  ← [data-slot="conversation"] 的 parentElement
  ├ div.detailsCol
  └ div.overlayLayer[data-shell-overlay]   ← 我们的面板所在槽
```

**结论**：AppFrame frame **自身没有**稳定语义属性（无 `data-dsh-frame`、无 `data-slot`），但可以从官方锚点反查：

```js
// 首选：官方 conversation 锚点向上找 frame
const col = document.querySelector('[data-slot="conversation"]')
const frame = col?.closest('div[style*="grid-template-columns"]')
// 兜底：现有特征选择器
const fallback = document.querySelector('#root div[style*="grid-template-columns"]')
```

`closest()` 把"官方语义锚点"与"特征校验"叠在一起，比单用任一个都稳；且 better-sidebar 的 `#root [data-dsh-frame]` 在本机确实不匹配（frame 无该属性），说明**不能照抄它的选择器**。

> **2026-09-08 真机实测确认**（见 §6）：`#root > [data-slot="root"] > div` 就是 frame、`conv.closest(...)` 同样命中、`[data-dsh-frame]` / `[data-pane]` / `[data-side="details"]` 三个基座选择器计数全为 0。本条结论已从"代码推断"升级为"实测成立"。

### B. 推挤改 CSS 变量 —— 建议采纳（中等改动）

把 `frame.style.paddingRight` 换成 `<html>` 上的 `--miasaki-sidebar-width` + 一段常驻 CSS 规则，收益：抗 React 重渲染（不再依赖 watchdog 抢救）、拖拽期只改变量、过渡交给 CSS。代价：需处理"规则选择器失效"（选择器要同时覆盖官方锚点与兜底），以及与我们已有的 `closeDetails()` 联动、`prefers-reduced-motion` 对齐。

若暂不改，至少应把 `FRAME_SELECTOR` 的注释从"spike 定稿"更新为"特征选择器 + 官方锚点兜底"，并补一次真机确认。

### C. `visible` 性能门 + tab 级 memo —— 建议采纳（低成本，M2 前置）

我们的 tab 组件目前不接收可见性信号。M2 辅助对话一旦引入会话订阅/轮询，非激活 tab 会持续空转。做法可极简：`Shell` 给 `TabBody` 传 `visible = state.open && tab 激活`，组件据此暂停订阅。

### D. 服务化 tab 框架 / betterSidebar 兼容层 —— 暂不建议

`registerTab` 的 17 个字段 + 17 个服务方法，意味着我们同时要背上 dedupe、定向 open、分栏/底部面板、tab 标题协调、`features` 版本协商、按会话持久化等一整套语义。路线 D 的立项理由正是"不背基座成本"。

若要考虑，唯一值得立项的形态是**兼容层**：实现 `ctx.betterSidebar` 的子集（`registerTab` / `openTab` / `updateTab` / `getSnapshot` / `subscribeState` / `closeTab` / `features`），让 dsh-tavern 这类现成插件把 tab 注册进我们的右栏。但它需要：① 承载"每个 tab 一个实例、可并列"的 UI（我们当前是单面板单 tab）；② 覆盖 `scope` 定向与 `createTab` 补丁语义；③ 决定持久化格式冲突。**成本与 M2/M3 同量级，建议在 M1 收尾验收后再评估，不并入本轮。**

### E. 按会话持久化 —— 可选（低成本）

把 `miasaki-sidebar:v1` 升级为 `v2` 并按 `sessionId` 分键（`{open,width,tab}` per session），与 better-sidebar 的会话隔离对齐。注意迁移：老键读到即回填到"当前会话"或作为全局默认。

### F. 围栏补 `sec-fetch-site` / `Origin` —— 建议采纳（低成本）

在 `createApi` 的 Host 判定之后追加：

- `sec-fetch-site === 'cross-site'` → 403；
- 若带 `Origin`，其 `hostname` 必须等于 Host 的 hostname（比较 hostname，兼容非默认端口的 Origin 序列化差异；`Origin: null` 拒绝）。

### G. 不采纳项（明确记录）

- **多 tab 并列 / 拖拽拆分 / 底部面板 / 自由浮窗 / 移动端合并抽屉**：是"重工作台"形态，与"轻量右栏 + 三 tab 单页 + 空态选择页"的定位冲突，且会显著抬升布局维护面。
- **body portal 挂载**：官方 `shell.overlay` 槽已满足需求且更合规；仅保留其"几何自检"思想（见 §3.1）。
- **左栏整槽替换**：tavern 需要替换左栏是因为它把左栏当"工作台列表"；我们不替换官方左栏。

## 6. 真机实测（2026-09-08，一次性 Cordis 探针）

§0 第 3 条与 §5-A 的锚点结论，已用一次性 Cordis client 探针在真实页面（DSH `0.1.2-rc.1`，viewport 1280×800）只读验证。探针原始输出：

```
#root yes children=1
sel #root>[data-slot=root] n=1 firstChild: div cls=pI_x6G_frame attrs[data-details-collapsed=true] style=grid-template-columns: 280px minmax(0px, 1fr) 0px;
sel #root>[data-slot=root]>div n=1 -> div cls=pI_x6G_frame attrs[data-details-collapsed=true] style=grid-template-columns: 280px minmax(0px, 1fr) 0px;
sel [data-slot=conversation] n=1 -> div cls= attrs[data-slot=conversation] style=display: contents;
conv.parent -> div cls=pI_x6G_centerCol attrs[] style=
conv.parent.parent -> div cls=pI_x6G_frame attrs[data-details-collapsed=true] style=grid-template-columns: 280px minmax(0px, 1fr) 0px;
conv.closest(frame) -> div cls=pI_x6G_frame attrs[data-details-collapsed=true] style=grid-template-columns: 280px minmax(0px, 1fr) 0px;
sel #root div[style*=grid-template-columns] n=1
sel [data-dsh-frame] n=0 / [data-pane] n=0
sel [data-side=details] n=0
  frame.child[0] -> div cls=pI_x6G_sidebarCol attrs[] style=
  frame.child[1] -> div cls=pI_x6G_centerCol attrs[] style=
  frame.child[2] -> div cls=pI_x6G_detailsCol attrs[] style=
  frame.child[3] -> div cls=pI_x6G_overlayLayer attrs[data-shell-overlay=true] style=
  frame.child[4] -> div cls=pI_x6G_handle attrs[data-side=sidebar] style=left: 280px;
sidebar-panel absent
titlebar yes h=0
overlayLayer -> div cls=pI_x6G_overlayLayer attrs[data-shell-overlay=true] style=
viewport w=1280 h=800
```

逐条结论：

1. ✅ **`#root > [data-slot="root"] > div` 直接命中 AppFrame frame**——`#root` 只有一个子元素 `[data-slot="root"]`，其 `firstElementChild` 就是 `div.pI_x6G_frame`（inline `grid-template-columns`）。原"待确认"的层级推断成立。
2. ✅ **官方锚点链完整**：`[data-slot="conversation"]` 自身是 `display: contents` 的锚点 div（即 `ANCHOR_STYLE`），`parentElement` = `div.pI_x6G_centerCol`，再上一级 = frame；`closest('div[style*="grid-template-columns"]')` 同样得到 frame。三种写法等价。
3. ✅ **基座选择器在本机确实不匹配**：`[data-dsh-frame]` 与 `[data-pane]` 计数均为 0，印证 2026-09-06 spike 结论；基座靠 `#root > [data-slot="root"] > div` 兜底才生效。**照抄它的 `#root [data-dsh-frame]` 会完全失效。**
4. ✅ **基座的详情列平移规则在本机失效**：`[data-side="details"]` 计数为 0——`frame.child[2]`（detailsCol）没有任何 `data-side` 属性，页面里唯一带 `data-side` 的是拖拽把手（`data-side=sidebar`）。即 better-sidebar 的 `… > [data-side="details"] { transform: translateX(...) }` 在本机选不中详情列，其"把手跟随推挤"不生效。
5. **附带观察（待复核，非本次结论）**：探针运行时 `.dsh-sidebar-panel` 不存在（面板未打开，符合预期）；但 `#miasaki-titlebar` **元素存在且 `height=0`**。按 `client.js` 现有分支 `reserve = Math.ceil(rect.height > 0 ? rect.bottom : 32)`，此时会取兜底 32px 而非 0，与 README「浏览器无壳时为 0」的记载不符。建议改为「元素不存在**或**高度为 0 都按 0 让位」，并在桌面壳与浏览器两环境下各复验一次。

探针与输出文件已在验证后删除（`cordis_undefine` + 删除 `_refs/sidebar-anchor-probe.txt`），不留残留。

## 7. 落地状态（用户 2026-09-08 拍板「按建议批次开工」）

| 序号 | 动作 | 成本 | 状态 |
|---|---|---|---|
| 1 | 锚点改造（§5-A）+ 围栏补两道（§5-F） | 低 | **已实施**（v0.4.0-miasaki.1） |
| 2 | 推挤改 CSS 变量（§5-B） | 中 | **已实施**（保留 inline 同值兜底；不加 transition，理由见 §5-B 与代码注释） |
| 3 | `visible` 性能门（§5-C） | 低 | **已实施** |
| 4 | 按会话持久化 v2（§5-E） | 低 | **已实施**（含 v1 一次性迁移） |
| 5 | betterSidebar 兼容层（§5-D） | 高 | 未启动（M1 实机验收后再评估） |
| — | §6 附带发现：`#miasaki-titlebar` 高度 0 误让位 | 低 | **已修复** |

设计 §3.1.1 的既有结论（原生 `details` 槽否决、z-index < 100、推挤下限 1280px）**全部仍然成立**，本调研增补了锚点、推挤载体、性能门、会话级持久化、围栏三道共五处。
