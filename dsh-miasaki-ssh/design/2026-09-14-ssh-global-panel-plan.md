# SSH 独立模块化规划：从「会话视图」升级为「全局面板」

- 日期：2026-09-14
- 状态：**设计提案 v0.1，待评审；未实施业务代码**
- 用户诉求（原话）：「关于 SSH 页面，我希望的是像会话布那样的独立页面，不是切换会话 SSH 就没了，当成一个独立的功能模块」
- 性质：**只读规划**。本轮完成平台取证与方案设计，未改动任何业务代码，也未实测浏览器行为（本次会话浏览器通道无法访问 `127.0.0.1` / `localhost`）。
- 取证对象：本机 `@deepseek-ai/dsh@0.1.5-rc.1` 安装产物源码（`C:\Users\Asakii\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\`）。下文引用 `dsh-client-ui-*/lib/client.js` 均指该目录下的 `node_modules/@deepseek-ai/` 内对应包，行号为实测位置。

---

## 1. 建议结论（先看五条）

1. **诉求成立，且现状确实是「作用域错配」**：SSH 的连接库、连接保活、多主机标签在数据与生命周期上本来就是全局的，却被注册进了一个 **session scope** 的视图槽（`conversation.view`）。
2. **0.1.5 给出了官方正解，且本机已具备**：`main` 是一个 **root scope 的 keyed slot**，官方注释原文即 "selects the Conversation or a **global panel**"，并明确「非 `conversation` 的 key **不接收 Session 绑定**」。这正是「独立功能模块」的官方形态。
3. **推荐方案：全局面板（`main` key）+ 左栏常驻入口（`sidebar.panellist`）+ 宿主常驻承载**。SSH 从「会话的一个视图」变成「DSH 的一个主视图」，无会话时也可用。
4. **但有一条必须诚实说明的官方硬约束**：点左栏会话条目时，官方 `ui-workspace.openSession()` **会强制 `selectPanel(null)`** 把面板切回对话。因此「在 SSH 页面里切会话、SSH 画面保持不动」**在官方通道下做不到**——这是「点会话＝看那个会话」的既定语义，第三方无法覆盖。第 8 节给出三条出路与推荐。
5. **迁移顺带清掉一笔技术债**：现在的「委托点击官方 tab 按钮」是 DSH 未暴露 View 切换 API 时的唯一通道（含幂等守卫、合成胶囊、关画布浮层等一堆绕过逻辑）。升级为全局面板后，**官方直接给了切换 API `ctx.layout.selectPanel(id)`**，这批 hack 可以整体删除。

**本次不做**：不改官方源码；不做第二个画布式全屏浮层（除非第 8 节用户选 B2）；不碰 SSH 引擎与传输栈；不改变既有安全边界（三道围栏 / TOFU / 凭据不落盘）。

---

## 2. 诉求解读：拆成三条可验证要求

| 编号 | 要求 | 判据 |
|---|---|---|
| **R1** | **独立** | SSH 不再「寄生」在某个会话里；会话切换、会话归档、甚至完全没有会话时，入口与功能都在 |
| **R2** | **不消失** | 切会话后 SSH 依然可达；理想是画面保持，底线是**一键回到且状态零损失** |
| **R3** | **模块化** | SSH 是 DSH 的一等功能模块，而不是「会话的一个视图标签」 |

用户拿「会话布」作参照，是因为会话布在体感上已经满足 R1–R3。第 4 节会解剖它**为什么**满足——结论是它的技术实质是「会话之外的常驻宿主」，而**不是**「必须是全屏浮层」。这个区分决定了本方案不必重复 canvas 的补丁史。

---

## 3. 现状诊断：问题不是 bug，是作用域

现状注册（`dsh-miasaki-ssh/client.js:396-404`）：

```js
ctx.slots.inject('conversation.view', () => ctx.slots.register({
  name: 'conversation.view', id: 'ssh', order: 20, label: () => VIEW_LABEL,
}, SshView))
```

`conversation.view` 是 **kind `list` / scope `session`** 的槽（0.1.5 未变）。三条根因：

| 编号 | 根因 | 代码事实 | 体感 |
|---|---|---|---|
| **D1** | **作用域错配** | 主机连接库存 `~/.dsh/ssh/`、SSH 连接由 host 侧全局持有、多主机标签跨主机——**三者都是全局的**；唯独承载它们的 UI 是 session scope | 「SSH 怎么会属于某一个会话？」 |
| **D2** | **无会话即无入口** | 空会话（hero）态下 `conversation.view` **整个槽不渲染**（[slot 契约调研 §8.1](../../dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.5-rc1-slot-contract-2026-09-10.md) 实测的 slot 宿主清单里没有它） | 没有会话时**根本进不去 SSH** |
| **D3** | **每会话一份视图状态** | `conversation.view` 的选择与记忆都是 per-session 的 | 必须「记住 SSH 在哪个会话里」，这就是「切会话就没了」的直接来源 |

**一句话**：把一件全局的事，挂在了一个会话级的钩子上。

---

## 4. 参照物解剖：会话布为什么「切会话不消失」

会话布的浮层创建（`dsh-miasaki-canvas/client.js:94-95`）：

```js
host.innerHTML = '<section class="dsh-canvas-overlay" hidden><iframe title="会话布" src="/canvas/"></iframe></section>'
document.body.append(host)
```

配合 `styles`：`.dsh-canvas-overlay{position:fixed;z-index:100;inset:0}`。

于是：

| 性质 | 机制 |
|---|---|
| 切会话画面不消失 | 浮层挂在 `document.body` 上，**完全在 React / 会话 DOM 之外**；会话面板重建与它无关 |
| 画布状态零损失 | iframe `/canvas/` 常驻，只切 `hidden`，**从不卸载** |
| 入口自有 | 不依赖任何 slot，自己往会话头塞按钮 |

**代价**：脱离官方布局——不参与左/右栏几何计算、需要自己处理遮挡与 z-index 层级、焦点与无障碍自持。canvas 为此付过「幂等守卫 / 重渲染看门狗 / 叠压修复」的补丁史（见 `dsh-miasaki-canvas/design/CHANGELOG.md`）。

> **关键推论**：用户说的「像会话布那样」，技术实质是 **「会话之外的常驻宿主」**。这一条可以用官方面板实现（第 7 节 G2），**不必**连「全屏浮层」一起搬过来。

---

## 5. 平台事实：官方给的正解

以下五条全部来自本机 0.1.5-rc.1 安装产物逐行取证，非推断。

### F1 `main` 是 root scope 的 keyed slot

声明（`dsh-client-ui-layout/lib/client.js:532-535`）：

```js
"main": { kind: "keyed", scope: "root" }
```

官方注释（同文件 `95-96`）：

> The root-scoped main slot selects the Conversation or a **global panel**. … The reserved `conversation` key hosts the Conversation; **other keys receive no Session binding**.

渲染（同文件 `114-116`）：

```js
renderSlot("main", {}, { entryKey: usePanelInfo(info => info.activePanelId) ?? "conversation" })
```

官方注册范例（`dsh-cordis-client-runner/lib/client.js:3399`，原文）：

```js
return { inject: ['slots'], apply(ctx) {
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: '<one key the owner dispatches>' },
    () => React.createElement('div', null, 'hello'),
  ))
} }
```

同处的契约元数据（`3372-3400`）：

| 字段 | 值 |
|---|---|
| `kind` / `scope` | `keyed` / `root` |
| `keyDomain` | `open: any string the owner dispatches (no compile-time key set), already taken: conversation` |
| `occupants` | `client-ui-conversation ConversationPanel key 'conversation'`（**只有官方会话面板**） |
| `replaceRisk` | `shadows-shipped-ui` —— ⚠️ 注册已占用的 key 会**顶掉官方 UI**；用自有 key 则无风险 |
| `ownerProps` | `[]`（无） |

⇒ 我们注册 `key: 'ssh'` 是**新增一格**，不替换任何官方内容。

### F2 选中态是 root 级 store，且会自动安全降级

`panelInfo` 的定义（`dsh-client-ui-layout/lib/client.js:338-359`）——注意官方注释：**"Root-owned frame measurement, panel preferences, and presentation reports."**

```js
init: () => ({ panelInfo: { activePanelId: null }, ... })
actions: {
  selectPanel: (d, panelId) => { d.panelInfo.activePanelId = panelId },
  retainMainPanels: (d, panelIds) => {
    if (d.panelInfo.activePanelId !== null && !panelIds.includes(d.panelInfo.activePanelId))
      d.panelInfo.activePanelId = null
  },
}
```

服务面（同文件 `411-416`，注释原文 **"Select a global panel or return to the Conversation"**）：

```js
selectPanel(panelId) {
  if (panelId !== null && !this.hasMainPanel(panelId))
    throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
  ...
}
```

`hasMainPanel` 直接查实时注册表（同文件 `515`），并在 `main` 注册表变化时触发 `retainMainPanels`（同文件 `547-548`）。

三条可用结论：

1. **选中态不属于任何会话**——它是 frame 级状态，切会话本身不会重置它。
2. **入口必须先确认面板已注册**，否则 `selectPanel` 会抛错（我们自己的按钮在注册之后渲染，实际安全；但外部调用点要带守卫）。
3. **插件卸载/重载 ⇒ 面板 id 从注册表消失 ⇒ `activePanelId` 自动归零**，不会卡在一个空面板上。这是**期望的降级行为**，要写进设计。

顺带（同文件 `55-56`）：`showSessionTitle = activePanelId === null` —— 面板激活时浏览器标题不再显示会话标题。官方也把「全局面板」当**离开会话**的语义处理。

### F3 左栏有官方的「全局面板」区，且当前无人占用

渲染（`dsh-client-ui-sidebar/lib/client.js:271-282`）：

```jsx
{panels.length > 0 && (
  <nav className={panelList} aria-label={t('panels.label')}>   // 中文词典："全局面板"
    {panels.map(({ id, label }) => <PanelRow id={id} label={label} ... />)}
  </nav>
)}
```

位置（同文件 `252-302` 的顺序）：`sidebar.brand` → 「新建会话」按钮 → **`nav.panelList`** → `sidebar.workspaces`（会话列表）→ `footArea`（footer action / 设置）。

行内结构（同文件 `106-133`）：

```jsx
<button onClick={() => selectPanel(id)} aria-current={active ? 'page' : undefined}>
  <span className={panelGlyph}>{renderSlot('sidebar.panellist', { size: wide ? 16 : 18, active }, { only: id })}</span>
  {wide && <span className={panelTitle}>{label}</span>}
</button>
```

契约（`dsh-cordis-client-runner/lib/client.js:4116-4158`）：

| 字段 | 值 |
|---|---|
| `kind` / `scope` | `list` / `root` |
| `summary` / `doc` | **"Global panel icons."** / "Each list id addresses the matching main panel; the sidebar owns the button and resolves its label from list metadata." |
| 必填 | `id`（**必须与 `main` 的 key 一致**）、`label`（`string \| (() => string)`，thunk 随语言变化重读） |
| ownerProps | `SidebarPanelIconOwnerProps { size: number; active: boolean }` |
| `occupants` | **`[]`（当前无人占用）** |
| `replaceRisk` | `none` |

⇒ **SSH 将是 DSH 第一个全局面板占用者**；界面上现在这块区域因为 `panels.length > 0` 不成立而完全不渲染，注册后才会出现。glyph 由**我们自己画**（接收 `size` / `active`），label 由官方渲染。

### F4 ⚠️ 官方硬约束：点会话条目会强制回到对话

`dsh-client-ui-workspace/lib/client.js:61-64`：

```js
openSession(sessionId) {
  this.sessions.open(sessionId);
  this.ctx.layout.selectPanel(null);      // ← 强制回对话
}
```

调用点（同文件）：点左栏会话条目、`openWorkspace`（切工作区）、`forkSession`；另有 `startSession()` 在无工作区时同样 `selectPanel(null)`（同文件 `88-92`）。

**含义**：SSH 面板激活时，用户点左栏任何会话，**官方都会把面板切回对话**。这不是 bug、不是可配置项，而是「点会话＝看那个会话的对话」的既定语义；第三方无法覆盖（不能改官方代码，也不应劫持官方会话列表的点击）。

**因此 R2 需要拆成两半来兑现**：

- **状态零损失**：面板切走不销毁终端（G2 常驻承载）✅ 能做到
- **画面不消失**：切会话时 SSH 仍在屏幕上 ❌ 官方通道下做不到

第 8 节给出三条出路。

### F5 面板自持布局（需 SPIKE 确认）

`ConversationPanel` 自己不产 DOM，只转发子槽（`dsh-client-ui-conversation/lib/client.js:14974-14976`）：

```js
function ConversationPanel({ renderSlot }) { return renderSlot("main.conversation", {}) }
```

真正的根是 `ConversationRoot`（同文件 `14947-14950`，`div[data-phase]` + CSS module）。

面板 entry 的 wrapper 是 `display:contents`（`data-slot="main"`），所以**我们的面板组件是 `centerCol` 的直接 flex item**，而 `centerCol` 是 `flex-direction:column; overflow:hidden`（`dsh-client-ui-layout/lib/client.js:71` 的 CSS）。

⇒ SSH 面板若用 iframe 撑满，`height:100%`（现状写法）在 flex column 里有歧义，更稳的是 `flex:1 1 auto; min-height:0`。**这一条必须实测**（G0-②），不能靠推断写进实现。

---

## 6. 方案对比

| 维度 | **A 现状**：`conversation.view` | **B 全局面板**：`main` keyed | **C body 级常驻浮层**（会话布式） |
|---|---|---|---|
| 槽位作用域 | session | **root** | 框架之外 |
| 无会话时可用 | ❌（槽不渲染） | ✅ | ✅ |
| 切会话 | 视图消失 | 官方弹回对话（**F4**） | **画面原样保留** |
| 入口常驻 | 否（挤在会话头 / 官方第二行 tab） | **左栏「全局面板」区** | 自持按钮 |
| 官方布局适配 | 会话面板内 | **完全**（占中栏，左右栏几何正常） | 需自处理遮挡 |
| iframe / xterm 保活 | 卸载重建 + host 回放 | 卸载重建 + host 回放（**G2 可消除**） | **常驻不销毁** |
| 切换 API | 无（**委托点击官方 tab**） | **官方 `ctx.layout.selectPanel`** | 自持状态 |
| 官方语义 | 会话的一个视图 | **DSH 的一个主视图** | 第三方覆盖层 |
| 主题 / 无障碍 / 焦点 | 官方生态内 | 官方生态内 | 自持 |
| 迁移成本 | — | 中（入口重注册 + 删一批 hack） | 高（重走 canvas 的补丁史） |

**推荐：以 B 为骨架，只吸收 C 的一个优点（宿主常驻）。**

即 **「全局面板 + 常驻承载 + 左栏常驻入口」**：

- **R1 独立** ✅ root scope；无会话也可用；不依赖任何会话
- **R2 不消失** ⚠️ **部分**：入口永不消失、状态零损失；画面让位给对话（F4）
- **R3 模块化** ✅ 官方口中的 "global panel"，左栏一等入口

---

## 7. 目标形态与实施分期

### 7.1 目标形态

```text
┌──────────────┬────────────────────────────────────────────┐
│ 左栏          │ 中栏：SSH 全局面板（root scope）              │
│ · 品牌        │ ┌────────────┬───────────────────────────┐ │
│ · 新建会话    │ │ 主机导航    │ 终端（多主机标签）          │ │
│ ──────────── │ │ 可收起      │ 工具区 / 查找 / 字号 / 专注  │ │
│ 【全局面板】   │ │ 搜索/分组   │                           │ │
│  ▣ SSH  ←新增 │ │ 收藏/状态点 │                           │ │
│ ──────────── │ └────────────┴───────────────────────────┘ │
│ · 会话列表    │ 状态栏：已连接 · 信任 · cols×rows · 字号      │
│ · 设置        │                                            │
└──────────────┴────────────────────────────────────────────┘
```

- **会话头第一行三段胶囊撤掉 SSH 段** —— canvas 恢复官方两段形态（连带删掉本线的合成 CSS 覆盖）
- **画布内的外部视图槽入口**语义从「切视图」改为「打开 SSH 面板」
- SSH iframe 的**内部形态完全不变**（U1 的工作区、三主题桥接、A0 上下文桥全部照旧）

### 7.2 分期

| 阶段 | 交付 | 门槛 |
|---|---|---|
| **G0 SPIKE** | 六项实测（见 §7.3） | 全过才进 G1 |
| **G1 形态迁移** | 注册 `main` key `ssh` + `sidebar.panellist` 行；面板取代 `conversation.view`；撤掉会话头 SSH 段与合成胶囊 CSS；画布入口改指面板；删除「委托点击 tab」整套逻辑 | 三主题可用；无会话态可进入；旧入口不残留 |
| **G2 常驻承载** | iframe/xterm 挂在**面板外的常驻宿主**上，面板只负责显示/隐藏 ⇒ 切走切回**零损失**（连回放都不需要，全屏 TUI 也不丢） | 切面板 30 次无状态损失、无监听累积、无跨代串写 |
| **G3 全局语义收尾** | 面板内不再有「当前会话」概念；A0「送往对话」文案改为「送到当前会话」；左栏图标显示活跃连接状态（如小圆点） | 无会话态全功能可用 |
| **G4（可选）** | **钉住小窗**：把当前终端钉成浮窗，走官方 `shell.overlay` 槽（frame 级、`z-index:20`、click-through 容器），切会话时小窗仍在 | 不与右栏 / 画布浮层 / 官方弹层冲突 |

### 7.3 G0 SPIKE 清单（必须在写业务代码前实测）

| 编号 | 验证项 | 为什么关键 |
|---|---|---|
| G0-① | `ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key:'ssh' }, Panel))` 能注册并渲染 | 整条路线的命门 |
| G0-② | 面板高度 / 滚动契约：iframe 用 `flex:1 1 auto; min-height:0` 还是 `height:100%`（**F5 未定**） | 写错就是「终端高度塌成 0」 |
| G0-③ | `sidebar.panellist` 行出现的位置、`{size, active}` 实际取值、窄栏（56px）形态 | 入口可见性 |
| G0-④ | `ctx.layout.selectPanel('ssh')` 与 `selectPanel(null)` 的实际行为；未注册时的 throw 边界 | 切换可靠性 |
| G0-⑤ | 卸载 / HMR 后 `retainMainPanels` 是否确实把 `activePanelId` 归零（**不卡死空面板**） | 失败模式安全性 |
| G0-⑥ | 面板激活时主题桥接（`postMessage` + `__DSH_SSH_THEME__`）是否照旧；`data-width-handle` 隐藏规则是否不再需要 | 视觉一致性 |

> **可行的实测通道**：本次会话浏览器工具无法访问 `127.0.0.1`（策略阻断），但 **`cordis_define` + `cordis_run` 的动态 Cordis 插件 Client 半边可以在这个真实 GUI 里跑**，配合 `cordis_inspect_query` 的 Client 查询回读 slot 树与 DOM。G0 建议走这条通道（探针按纪律用完即删）。次选是沿用本线已有的本地静态 harness 做法。

---

## 8. 待拍板：R2 的三条出路

「切会话时 SSH 画面保持不动」在官方通道下**做不到**（F4）。三条路：

| 选项 | 做法 | 满足 | 代价 |
|---|---|---|---|
| **B1（推荐）** | 接受官方语义：切会话＝回对话；SSH 靠**左栏一键回**，**状态零损失**（G2），左栏图标显示活跃连接数/状态点作为「它还在跑」的可见性 | R1 R2-状态 R3 | 切会话时画面让位（但这是「点会话」的应有之义） |
| **B2** | 用 body 级常驻浮层实现画面不消失（完全照搬会话布） | R2-画面 | 脱离官方布局；**且全屏浮层会挡住用户切过去想看的对话**——与「切会话」这个动作的意图直接冲突；重走 canvas 补丁史 |
| **B3** | B1 + **可选钉住小窗**（G4）：终端钉成右下角浮窗（官方 `shell.overlay`），切会话时小窗仍在 | R1 R2 R3 | 多一套浮窗的拖拽/收起/焦点管理；需与右栏、画布浮层协调 |

**规划建议：B1 + B3（B3 作为可选增强）**。理由：B2 看起来最贴合字面诉求，但**全屏浮层与「切会话去看对话」的意图是互斥的**；用户真正想要的多半是「SSH 一直在那儿、随时能回去、回去还是原样」——这正是 B1+B3 的组合。

---

## 9. 风险与对策

| 风险 | 说明 | 对策 |
|---|---|---|
| **F4 语义冲突** | 用户期望「切会话不消失」，官方语义是「切会话回对话」 | 明确接受并写进文档（B1）；确有需要再上 B3 |
| 顶掉官方 UI | `replaceRisk: shadows-shipped-ui`（同 key 即替换） | 用自有 key `ssh`；**绝不注册 `conversation`** |
| 注册时机竞态 | `selectPanel` 对未注册 key 会 **throw** | 入口按钮在面板注册后渲染；外部调用点（画布槽）先查再调，失败静默不报错 |
| 插件卸载 / HMR | `retainMainPanels` 会把 `activePanelId` 置 null | **期望行为**（安全降级）；迁移时同步处理 `__DSH_SSH_BOOTED__` 守卫与样式回收 |
| 双入口混乱 | 迁移期若胶囊与面板入口并存 | G1 一次性切换，不留双入口；过渡期以「找不到面板就收手」降级 |
| 常驻宿主的生命周期 | 宿主不在 React 树内，需自己管回收 | 归 `ctx.effect`，卸载即销毁；沿用 `session.js` 既有 dispose 契约（U0 已建立） |
| 面板高度契约未知 | **F5 未实测** | G0-② 先测再写 |
| 空会话态交互 | hero 态下无会话，A0「送往对话」无目标 | 面板内按「当前无会话」降级提示，不产生只有主机名的空消息（沿用 A0 既有边界） |
| 主题桥接回归 | 面板搬迁后 iframe 生命周期变化 | G0-⑥ 覆盖；桥接逻辑与 slot 无关，预期照旧 |

---

## 10. 验收矩阵（G1–G3）

### A. 形态与入口

1. 左栏「全局面板」区出现 SSH 行（宽栏 = 图标 + 文案；窄栏 56px = 仅图标 + tooltip）；`active` 态与面板选中同步。
2. **无会话（hero）态**下可进入 SSH 面板并正常连接 —— 这是现状做不到的（D2）。
3. 会话头第一行只剩「对话 | 会话布」两段（canvas 原生形态），无 SSH 残留、无合成胶囊的缝隙/圆角异常。
4. 画布内的外部视图槽按钮仍可打开 SSH 面板（先关浮层再切面板，无双层叠压）。
5. 切换会话后，左栏 SSH 入口仍在；点击可回到 SSH 面板。

### B. 状态与生命周期

1. 在 SSH 面板与对话之间来回切换 30 次：无状态损失、无监听累积、无跨代串写（G2 后应为**零损失**，非回放恢复）。
2. 面板激活时卸载插件（或 HMR）：`activePanelId` 归零、回到对话，不卡空面板。
3. 面板切走时 SSH 连接**不断**（host 侧保活不变）；切回后多主机标签与滚动位置符合 G2 契约。
4. 官方右栏开合、左栏拖拽、侧栏折叠时，终端尺寸正确跟随（沿用 U1 的容器查询与 fit 逻辑）。

### C. 回归

1. 三主题（pure 亮/暗、刻刻帝、狂狂帝）下页面与 xterm 同步换肤，无闪底（U1 契约不退化）。
2. A0 三项意图（选区 / 最近 40 行 / 看错误）在面板形态下照旧，来源首行格式不变。
3. `verify-all ssh` 全绿；单测覆盖入口注册、面板选中、宿主回收的新增路径。

---

## 11. 源码索引

行号为 2026-09-14 在本机 0.1.5-rc.1 安装产物上的实测位置。

**官方（`…/node_modules/@deepseek-ai/`）**

- `dsh-client-ui-layout/lib/client.js`
  - `95-96` main slot 官方注释（"…or a global panel"；"other keys receive no Session binding"）
  - `71` `centerCol` CSS（flex column / overflow hidden）
  - `114-116` `MainPanel` 渲染（`entryKey: activePanelId ?? 'conversation'`）
  - `55-56` `DocumentTitle`（`showSessionTitle = activePanelId === null`）
  - `338-359` `createLayoutStore`（`panelInfo.activePanelId` / `selectPanel` / `retainMainPanels`）
  - `399-416` `LayoutController.selectPanel`（未注册即 throw）
  - `515`、`547-548` `hasMainPanel` 与 `main` 注册表订阅
  - `532-535` root 四子 slot 声明
- `dsh-client-ui-sidebar/lib/client.js`
  - `106-133` `PanelRow`（glyph 自绘 + label 官方渲染 + `selectPanel`）
  - `252-302` 左栏顺序与 `nav.panelList`（`aria-label="全局面板"`）
  - `309-315` 中文词典（`panels.label: "全局面板"`）
  - `344-362` `syncPanels`（metadata `{id, order, label}`）
- `dsh-client-ui-workspace/lib/client.js`
  - `61-64` `openSession` **强制 `selectPanel(null)`**（F4）
  - `88-92` `startSession` 无工作区时同样归零
- `dsh-client-ui-conversation/lib/client.js`
  - `16823-16831` 官方 conversation 面板注册（`main` / key `conversation` / children `main.conversation`）
  - `14974-14976` `ConversationPanel`（只转发子槽）
  - `14947-14950` `ConversationRoot` 根元素
- `dsh-cordis-client-runner/lib/client.js`
  - `3372-3400` `main` 契约条目（含官方注册范例、`keyDomain`、`occupants`、`replaceRisk`）
  - `4116-4158` `sidebar.panellist` 契约条目（"Global panel icons."、`occupants: []`）

**本线**

- [`../client.js`](../client.js)：`396-404` 现状 `conversation.view` 注册；`409-416` 会话头胶囊入口；`140-232` 「委托点击官方 tab」整套绕过逻辑（G1 待删）；`29-82` 合成胶囊 CSS（G1 待删）；`84-125` 主题桥接（保留）
- [`../app.js`](../app.js)、[`../styles.css`](../styles.css)、[`../session.js`](../session.js)：SSH 面板内部实现，**形态迁移不改变其契约**
- [`../index.js`](../index.js)：host 侧路由 / REST / WS 桥，**完全不受影响**
- [`../../dsh-miasaki-canvas/client.js`](../../dsh-miasaki-canvas/client.js)：`94-95` 浮层挂 `document.body`（第 4 节参照物）
- [`2026-09-12-ssh-workspace-plan.md`](2026-09-12-ssh-workspace-plan.md)、[`2026-09-14-ssh-agent-driven-plan.md`](2026-09-14-ssh-agent-driven-plan.md)：U0/U1 与 A0 既有契约
- [`../../dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.5-rc1-slot-contract-2026-09-10.md`](../../dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.5-rc1-slot-contract-2026-09-10.md)：0.1.5 slot 契约总表（§6.1 已预告本方案）

---

## 12. 待决策项（请拍板后再实施）

| # | 问题 | 选项 | 规划建议 |
|---|---|---|---|
| **1** | **R2 怎么兑现** | B1 接受官方语义（切会话回对话 + 一键回 + 状态零损失）／ B2 全屏常驻浮层 ／ B3 = B1 + 可选钉住小窗 | **B1 + B3** |
| **2** | **会话头入口是否保留** | 完全撤出 ／ 保留一个「快捷打开」按钮 | **完全撤出**（才叫独立模块；留着就还是「会话的一个控件」） |
| **3** | **画布内入口** | 保留（改指面板）／ 去掉 | **保留**（canvas 已提供通用外部视图槽，成本为零） |
| **4** | **G2 常驻承载是否本轮做** | G1 后即做 ／ 先做 G1 验证体感再定 | **G1 先行**，G2 紧接着（它才是「零损失」的来源） |

> 本文件为规划产出，**不等于批准业务改造**（沿用本线既有约定：切到规划模式只产出方案文件）。拍板后按 G0 → G1 → G2 → G3 推进；G0 的六项 SPIKE 必须先过。
