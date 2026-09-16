# SSH 全屏浮层规划（路线丁：照会话布同构）

- 日期：2026-09-14
- 状态：**设计提案 v1.0，已获用户定向（全屏 / 路线丁），待评审；未实施业务代码**
- 上游：[独立模块化规划](2026-09-14-ssh-global-panel-plan.md)（路线甲/乙/丙的平台取证与对比；**其 §5 的 F1–F5 平台事实仍然有效**，本文件只补路线丁）
- 用户定向（原话）：「全屏，走丁方案」；此前约束：「入口就按当前的按钮就好…作为唯一的主入口」「我的问题与左侧边栏没关系」「不能通过顶栏的这个按钮切换吗」「那我现在的会话布实现形式是什么样的」
- 性质：**只读规划**。本轮完成路线丁的实现设计与风险清单，未改动业务代码。

---

## 1. 决策记录

| 项 | 决定 | 依据 |
|---|---|---|
| 形态 | **全屏浮层（`document.body` 级，`position:fixed; inset:0`）** | 用户拍板「全屏」；与会话布完全一致 |
| 结构 | **照会话布同构**（宿主 + 常驻 iframe + 页面内自绘顶栏） | 用户拍板「走丁方案」 |
| 入口 | 保留会话头第一行现有那颗 SSH 按钮，**位置与样子不变**，行为改为「打开浮层」 | 用户「入口就按当前的按钮就好，作为唯一的主入口」 |
| 左栏 | **不碰**（不注册 `sidebar.panellist`、不注册 `main` panel） | 用户「我的问题与左侧边栏没关系」 |
| 会话内顶栏 | 浮层盖住官方顶栏 ⇒ 在 **SSH 页面内部自绘一条顶栏**，放「对话｜会话布｜SSH」 | 用户「顶栏胶囊不能注册过去吗」——不能注册，只能重画（§3.2） |
| 顶栏内容 | 顶栏**只放三个切换按钮，不堆工具**；查找 / 字号 / 专注 / 送往对话留在**终端工具区原位** | 用户 2026-09-14「别把顶栏堆长了」 |
| `Esc` | **不用于关闭浮层** —— 终端聚焦时 `Esc` 必须留给远端程序 | 用户 2026-09-14 |
| 与画布的关系 | **不同屏**：两浮层互斥，开一个关一个（用户已确认接受） | 用户 2026-09-14 |
| 开关状态记忆 | **要记忆**，存 `sessionStorage`（刷新恢复浮层；关标签页/新开标签页回到对话，多标签页互不干扰） | 用户 2026-09-14 |
| 被否决 | 路线甲（全局视图模式）、乙（官方 `main` 全局面板）、丙（面板+自绘顶栏） | §2 三路对比 |

**本次仍不做**：不改官方源码；不碰 SSH 引擎 / 传输栈 / 安全边界（三道围栏、TOFU、凭据不落盘）；不碰 host 侧路由与 WS 桥。

---

## 2. 为什么丁胜出（三路对比）

| 维度 | 甲 全局视图模式 | 乙 官方全局面板 | **丁 会话布同构（选定）** |
|---|---|---|---|
| 架构真实性 | 仍是会话视图（选中态全局化） | ✅ 真正 root scope | 框架之外，**最彻底的独立** |
| 顶栏胶囊 | 保留 | **消失**（会话面板卸载） | **页面内重画**（与会话布同款） |
| 切会话 | 靠 observer 自动恢复（有闪烁窗口） | 官方 `openSession` 强制弹回对话（[F4](2026-09-14-ssh-global-panel-plan.md)） | ✅ **不消失**（与会话 DOM 无关） |
| 切走切回终端 | iframe 重建，靠 256KiB 回放（全屏 TUI 不保真） | 同左 | ✅ **零损失**（iframe 常驻，只切显隐） |
| 第二行 tab 栏 | 需 CSS 隐藏（覆盖官方 UI） | 自然没有 | ✅ 自然没有（被盖住） |
| 遗留 hack | **委托点击官方 tab 全套保留** | 全删 | ✅ **全删** |
| 依赖官方 slot | `conversation.view` | `main` + `sidebar.panellist` | ✅ **只依赖 `conversation.session.header.actions`**（唯一稳定槽） |
| 代价 | 仍依附会话 | 顶栏消失 | 盖住左/右栏；z-index/焦点/无障碍自持 |

> 丁把「第二行 tab 不存在」从**要修的问题**变成了**自然结果**——浮层盖住了一切，不存在需要隐藏的东西。同理，「切会话不消失」也不再需要 observer 纠偏。

---

## 3. 目标形态

### 3.1 分层结构

```text
┌─ 宿主文档（DSH 页面）─────────────────────────────────────────┐
│  #root → AppFrame（左栏 | 中栏 | 右栏）                        │
│     └ 会话头第一行 actions 槽：[ 对话 | 会话布 | SSH ]  ← 入口   │
│                                                                │
│  body                                                          │
│   └ div.dsh-ssh-host                          ← client.js 建   │
│      └ section.dsh-ssh-overlay                ← fixed/inset:0   │
│         └ iframe[title="SSH"][src="/ssh/"]    ← 常驻，只切显隐   │
└────────────────────────────────────────────────────────────────┘
        │ 同源 postMessage（主题 / chrome reserve / 打开通知）
        ▼
┌─ /ssh/ 文档（iframe 内，app.js 自建 DOM）──────────────────────┐
│  #ssh-root                                                     │
│   ├ 顶栏（新增）：[ 对话 | 会话布 | SSH ]  ← 仅此三个按钮，不放工具 │
│   ├ 工作区（U1 既有）：主机导航 ｜ 多主机终端标签               │
│   │    └ 终端工具区（原位不改）：查找 / 字号 / 专注 / 送往对话   │
│   └ 状态栏（U1 既有）：已连接 · 信任 · cols×rows · 字号         │
└────────────────────────────────────────────────────────────────┘
```

### 3.2 为什么顶栏必须"重画"

官方那颗胶囊是注册在 `conversation.session.header.actions` 的 **React 组件**，绑死在会话头那棵 DOM 上——**组件搬不走**，浮层里也不存在那个 slot。会话布的做法就是在自己的页面里重画一组（`/canvas/` 的 `.view-switch`），本方案照做。

**唯一性保证**：浮层 `inset:0` 盖住官方顶栏 ⇒ 屏幕上看不到两组胶囊，不会出现"两个入口"的混乱。

### 3.3 浮层内顶栏的三个按钮

| 按钮 | 行为 | 实现路径 |
|---|---|---|
| **对话** | 关闭 SSH 浮层（回到会话） | `close()` |
| **会话布** | 关闭 SSH 浮层 + 打开画布浮层 | `close()` → 委托点击 canvas 在会话头的「会话布」按钮（`dsh-canvas-switch button[aria-label="会话布"]`）—— 浮层已关，会话头可见 |
| **SSH** | 当前态（`aria-current="page"`），无动作 | — |

> 「会话布」这一跳需要跨线委托点击（canvas 未暴露"打开浮层"的 API）。**这正是线上已有的做法**（`dismissCanvasOverlay()` 就是委托点击 canvas 的「对话」按钮），不是新增耦合类型。canvas 不在场时静默跳过。

---

## 4. 与 canvas 的同构对照（含必须偏离之处）

| 机制 | canvas 现状 | SSH 照做 / 偏离 | 理由 |
|---|---|---|---|
| 宿主挂载 | `document.body.append(host)` | **照做** | 会话外常驻的前提 |
| 浮层定位 | `position:fixed; z-index:100; inset:0` | **照做**（同 z-index） | 两浮层互斥，无需争层 |
| iframe | 常驻，`hidden` 切换，不卸载 | **照做** | 终端零损失的来源 |
| **关闭时的隐藏方式** | `[hidden]{display:none}` | ⚠️ **必须偏离**：改用 `visibility:hidden; pointer-events:none` | **见 §5.1，这是本方案唯一的技术要点** |
| 打开流程 | `hidden=false` → 加 `is-opening`（`visibility:hidden`）→ rAF 发消息 → 300ms 兜底 | **照做**（兜底可简化，若 iframe 已常驻） | 防首帧闪白 |
| 入口注册 | `conversation.session.header.actions` | **照做**（现有按钮原样保留） | 唯一稳定槽 |
| 主题桥 | dark + accent 两个字段 | **增强**：沿用本线既有令牌白名单（9 个 + 字体） | 本线 U1 已做得更完整 |
| 桌面壳窗控 | `syncChrome()` 量 `#miasaki-titlebar .tb-group` 宽度 → `--canvas-chrome-reserve` | **照做**（`--ssh-chrome-reserve`） | 见 §5.2 |
| 外部视图槽 | 提供 `__DSH_CANVAS_VIEW_ITEMS__` + `canvas:view` | **消费方**（本线已在用） | 画布内那个 SSH 按钮保留 |
| 幂等守卫 | `window.__DSH_CANVAS_BOOTED__` | **照做**（本线已有 `__DSH_SSH_BOOTED__`） | HMR 不得挂两个浮层 |
| 退出清理 | fiber 卸载时回收宿主 / 监听 / 样式 | **照做** | 本线 `ctx.effect` 契约已存在 |

---

## 5. 关键技术问题与对策

### 5.1 ⚠️ xterm 尺寸保真：必须偏离 canvas 的隐藏策略（**本方案头号风险**）

canvas 关闭浮层时用 `display:none`。对画布无碍（它的困扰是 `scrollTop` 被夹回 0，已在 `open()` 注释里说明）。**但对终端是灾难**：

- `display:none` ⇒ iframe 尺寸塌成 0 ⇒ 容器宽高为 0
- `session.js` 的 `ResizeObserver` 会触发 ⇒ `fit()` 算出最小 cols/rows（限界下界是 **2×2**，见 U0 的 resize 限界）⇒ **真的会把 2×2 写进远端 PTY**
- 远端 shell 窗口被改坏；若此时远端正在跑 `vim`/`top`，画面直接乱掉

**对策（三层保险）**：

1. **浮层关闭态用 `visibility:hidden` + `pointer-events:none`，不用 `display:none`** —— 元素仍在布局中，尺寸恒等于视口；且 `visibility` 变化**不触发** `ResizeObserver`，关闭期间一次误 fit 都不会发生。
2. `session.js` 侧给 fit 加**可见性门控**：容器尺寸为 0 或不可见时**跳过 fit**（不发送 resize 帧），与 U0 既有的「rAF 合帧 + 限界」并列。
3. 打开浮层后**补一次 fit**（尺寸可能因窗口变化而变），并复用既有的「尺寸去重」避免无谓的 PTY 写入。

> 这条必须在 D0 实测：关闭 → 观察 host 侧是否收到任何 resize；打开 → 终端是否原样。
> **✅ 已实测（2026-09-14，§12）：visibility 方案成立——关闭零帧、隐藏期改视口发正确尺寸帧、重开零帧；意外发现 display:none 在本版 Chromium 里因渲染暂停而未复现 2×2 灾难（详见 §12.3，维持 visibility 方案的理由已更新）。**

### 5.2 桌面壳窗控叠压

Tauri 无边框窗口的窗控按钮组（`#miasaki-titlebar .tb-group`，fixed 右上）会零占位浮在页面右上角。SSH 顶栏右侧若有工具按钮，会被盖住。canvas 已量过并下发 `--canvas-chrome-reserve`（`canvas/client.js:239-250`），SSH 照抄一份 `--ssh-chrome-reserve`。

**真实壳实测值（补 §12.2 ③ 的「真实壳内验证留 D2」空白，2026-09-14）**：在**真实 Tauri 壳**内读取 —— `#miasaki-titlebar .tb-group` 宽 **136px**、左缘 1136、视口 1280 ⇒ `reserve = ceil(1280 − 1136 + 6) = `**`150`**。§12.2 ③ 的 111px 来自注入 `theme-init.js` 的**机制级**环境（那里窗控组只有 97px 宽），两者不矛盾但**取值不同**：**D2 实现与验收以真实壳的 150px 为准**，并仍按 canvas 的写法在运行时实测（不写死）。

另：canvas 曾踩过**桌面壳在 iframe 内重建标题栏/主题球**的坑（假窗控浮在页面右上 + 假主题球），desktop 线已在 `themes/src/08-ready.js` 加 `IS_TOP` 守卫修复（2026-09-12）。本方案的浮层 iframe 与画布同构，**D0 已复验该守卫生效**（§12.2 ⑤ 机制级 + 真实壳内实测：`/ssh/` iframe 中无 `#miasaki-titlebar`、无 `#miasaki-switcher`；普通浏览器下 reserve 取 0）。

### 5.3 两个浮层的互斥

- **点 SSH 入口** → 复用现有 `dismissCanvasOverlay()`（委托点击 canvas 的「对话」按钮）→ 再 `open()`
- **浮层内点「会话布」** → `close()` → 委托点击 canvas 的「会话布」按钮
- 反向不需要处理：任一浮层打开时都盖住会话头，另一颗入口点不到 ⇒ **天然互斥**

> **用户已确认「SSH 与会话布不用同屏」**（2026-09-14）。这是全屏方案的固有代价：两者都是 `inset:0` 的全屏空间，同屏需要分屏/平铺能力，本方案不做。若将来确有需求，属于形态重构而非增量改动。

### 5.4 响应式重校准

现有断点（`styles.css:251-266`，959 / 719 / 479）依据的是 **SSH 容器宽度**；过去容器 = 会话中栏宽度（常见 800–1200px），现在容器 = **视口宽度**（可达 1920px+）。影响：

- 大屏下主机导航常驻（本就应该）——需确认 `container-type: inline-size` 的容器在浮层内确实是视口宽
- 960 断点以下的行为（紧凑导航、模态抽屉）保持不变 ✓
- 需重跑四档宽度验收（1280 / 960 / 720 / 480）

### 5.5 焦点与键盘

- 打开浮层：焦点交给 iframe（用户多半直奔终端）
- 关闭浮层：焦点归还入口按钮（`[data-width-handle]` 时代已建立的"不得把 `body` 当恢复目标"纪律，见工作区规划 §7.1）
- **`Esc` 不关闭浮层（已定，2026-09-14）**：终端聚焦时 `Esc` 必须留给远端程序（U1 纪律），故不做"焦点在顶栏时才拦截"的方案，直接不接管。
  > **由此产生一条硬约束**：退出浮层的**唯一路径**是顶栏的「对话」按钮（官方顶栏被浮层盖住、`Esc` 不接管）。它必须始终可见、键盘可达、focus-visible 清晰，且不因任何窄宽度断点被折进菜单。D2/D3 的验收要单列这一条。
- 浮层打开时不与官方快捷键抢键（浮层在文档层，官方快捷键仍可能响应）

### 5.6 首帧与主题

- iframe 常驻 ⇒ `/ssh/` 只加载一次；首帧主题读 `window.__DSH_SSH_THEME__` 注册表（U1 既有通道，**不闪兜底色**）
- 打开浮层时补发一次快照（去重逻辑照旧），覆盖"关闭期间宿主换过主题"的情况
- 主题切换**不重建 xterm、不断 SSH**（U1 硬契约，不变）

### 5.7 A0「送往对话」的文案

浮层盖住官方顶栏 ⇒ 用户粘贴前**必须先退出浮层**。现有状态栏提示「切到对话粘贴」需改为「点左上『对话』退出后粘贴」。行为本身（只读终端 + 写剪贴板 + 不自动发送）完全不变。

### 5.8 首次打开的开销

iframe 首次 `src="/ssh/"` 时 `app.js` + `xterm` 才加载（约 260KB xterm + 本线代码）。两种策略：

- **懒加载（推荐）**：首次点 SSH 才创建/赋 `src`，之后常驻 —— 不动用 SSH 的用户零开销
- 预加载：页面加载即创建隐藏 iframe —— 首次打开无等待，但所有用户都付带宽

建议懒加载 + 首次打开显示"正在加载终端…"占位（避免 300ms 兜底窗口里看到空白）。

### 5.9 开关状态记忆（`sessionStorage`，已定 2026-09-14）

**只记一个布尔值**：浮层是开是关。浮层里的内容——连了哪些主机、开着哪些标签——本来就是 **host 侧保活**的，刷新后由既有 `refreshConnections` 路径自动回来，不需要额外记忆。

| 时机 | 动作 |
|---|---|
| `apply()` 时 | 读一次；为真则走与入口按钮相同的 `open()` 路径 |
| `open()` / `close()` | 各写一次 |
| 插件卸载 / HMR | **不清除**（它不是插件生命周期状态，是用户意图） |

**为什么选 `sessionStorage` 而不是 `localStorage`**：后者会让**每次打开 DSH 都自动弹进全屏 SSH**，包括新开标签页——想先跟 Agent 说话时得先手动退出，是打扰。`sessionStorage` 精准命中"刷新别把我踢出去"，同时天然按标签页隔离（多标签页互不干扰）。

**两个实现注意点**：

1. 自动打开发生在 `apply()` 期间，此时页面可能尚未就绪——`open()` 必须容忍"入口/宿主还没准备好"，失败静默不报错（与"找不到就收手"的降级纪律一致）。
2. 记忆态为真但**插件加载失败**时不得留下任何残影（`ctx.effect` 的回收必须覆盖这条路径）。

---

## 6. 代码改动清单

| 文件 | 改动 | 删/增 |
|---|---|---|
| `client.js` | 新增浮层宿主（`body` 上 `.dsh-ssh-host` → `.dsh-ssh-overlay` → 常驻 iframe）、`open()` / `close()`、`--ssh-chrome-reserve` 下发、打开时补发主题快照、首次打开懒加载 | **删**：`conversation.view` 注册、`ownTab()` / `hideOwnTab()` / `restoreTabs()`、`viewIsSsh()` / `selectSsh()` / `selectDefaultView()`、`onDialogClick` / `dismissing` 守卫、`div[data-phase]:has(iframe[title="SSH"]) [data-width-handle]` 规则；**留**：合体胶囊 CSS、外部视图槽消费 |
| `app.js` | 新增顶栏（三个切换按钮 + 右侧工具区）、`postMessage` 收发（`ssh:close` / `ssh:view` / chrome reserve）、A0 提示文案 | 增 |
| `styles.css` | 顶栏样式与 `--ssh-chrome-reserve` 消费；确认 `container-type` 容器在浮层内的宽度语义 | 增 |
| `session.js` | fit 加可见性门控（§5.1 第 2 层） | 增 |
| `index.js` | **不改**（路由 / REST / WS 桥 / 页面骨架全部照旧） | — |
| `test/` | `client.test.js`：删除委托点击相关断言，新增浮层契约（宿主回收、显隐策略、互斥、主题快照）；`session.test.js`：新增可见性门控 fit | 改 |
| `README.md` / `design/CHANGELOG.md` | 形态描述从「会话视图」改为「全屏浮层」；文档表加本文件 | 改 |

---

## 7. 分期

| 阶段 | 交付 | 门槛 |
|---|---|---|
| **D0 SPIKE** | ① 关闭态 `visibility:hidden` 下 xterm 尺寸是否真不变（host 侧零 resize 帧）；② 打开→关闭→打开 30 次，终端屏幕原样（含 `vim`/`htop`）；③ 桌面壳窗控 reserve 生效、iframe 内无假窗控；④ 浮层与画布互斥；⑤ `IS_TOP` 守卫在本线 iframe 内是否照旧生效 | **五项全过（2026-09-14 实测，见 §12）** |
| **D1 浮层骨架** | 宿主 + 常驻 iframe + 懒加载 + `open()`/`close()` + **开关状态记忆（§5.9）** + 入口按钮改行为；**此阶段先保留 `conversation.view` 注册作为回退**，浮层跑通再删 | **四项门槛「函数级」全过（2026-09-14，见 §13）；用户级验收发现「单向门」→ 已修复，退出按钮正式形态仍属 D2（见 §13.1）** |
| **D2 页面顶栏** | SSH 页面自绘顶栏（三个按钮 + 工具区 + chrome reserve）；「会话布」跳转；焦点归还 | 三主题下顶栏与宿主观感一致 |
| **D3 清理与回归** | 删除 `conversation.view` 注册与全部 tab 委托 hack；响应式重校准；A0 文案；单测更新 | `verify-all ssh` 全绿；四档宽度 + 三主题验收 |
| **D4（可选）** | 打开过渡动效（尊重 `prefers-reduced-motion`）、顶栏「对话」退出按钮的键盘可达性打磨 | 逐项单独验收 |

---

## 8. 验收矩阵

### A. 形态

1. 点会话头 SSH 按钮 → 全屏浮层，官方顶栏、左栏、右栏、第二行 tab 栏全部不可见。
2. 浮层内顶栏呈现「对话｜会话布｜SSH」，SSH 段为当前态；三主题下与宿主观感一致（令牌化，不硬编码色）。
3. `dialog`（点「对话」）退出浮层，回到进入前的会话与视图，焦点归还入口按钮。
4. **退出路径唯一且可靠**：`Esc` 不关闭浮层（已定）；顶栏「对话」按钮在四档宽度下始终可见、可 Tab 到达、focus-visible 清晰，不被任何断点折进菜单。
5. 顶栏内**只有**三个切换按钮，不含查找 / 字号 / 专注 / 送往对话；后者仍在终端工具区原位。
4. 点「会话布」→ SSH 浮层关闭、画布浮层打开；反向（画布里点 SSH）→ 画布浮层关闭、SSH 浮层打开。
5. 浮层与桌面壳窗控不叠压（`--ssh-chrome-reserve` 生效）；普通浏览器下无多余留白。

### B. 生命周期与状态

1. **切会话：SSH 浮层不消失**；浮层内的主机列表、多主机标签、终端内容均不变。
2. **切走切回零损失**：关闭浮层 → 打开，终端屏幕原样（含 `vim`/`htop`）；30 次开关无监听累积、无跨代串写。
3. **关闭期间零 resize 帧**：host 侧不收到任何来自该 viewer 的 resize（§5.1 判据）。
4. 关闭期间终端继续接收输出（回看时能看到关闭期间的新输出）。
5. 插件卸载 / HMR：宿主、监听、样式、iframe 全部回收，不残留浮层；再次加载可正常挂载。
6. 首次打开（懒加载）有明确加载态，无长时间空白。
7. **开关状态记忆（§5.9）**：浮层开着时刷新 ⇒ 自动恢复浮层；关闭后刷新 ⇒ 停在对话；**关掉标签页再打开 ⇒ 停在对话**（`sessionStorage` 语义，不被全屏终端突袭）；两个标签页同时开时互不干扰。

### C. 回归

1. 三主题（pure 亮/暗、刻刻帝、狂狂帝）+ 原生明暗：页面与 xterm 同步换肤、无闪底（U1 契约不退化）。
2. 四档宽度 1280 / 960 / 720 / 480：布局与容器查询行为正确（按视口宽度重校准）。
3. A0 三项意图格式不变；提示文案指向「点左上『对话』退出后粘贴」。
4. `data-width-handle`、官方 tab 栏不再被本线触碰（相关 hack 已删，`grep` 应无命中）。
5. `verify-all ssh` 全绿；`node --test-isolation=none --test test/*.test.js`（沙箱下的正确跑法）。

---

## 9. 风险

| 风险 | 等级 | 说明 | 对策 |
|---|---|---|---|
| **隐藏态误 fit 写坏远端 PTY** | **高** | `display:none` 会让 cols/rows 塌到 2×2 并真的写进 PTY | §5.1 三层保险；D0 首项实测 |
| 桌面壳窗控叠压 / iframe 内假窗控 | 中 | canvas 已踩过，desktop 线已修 | `--ssh-chrome-reserve` + D0 复验 `IS_TOP` |
| 跨线委托点击（canvas 按钮） | 中 | canvas 未暴露"打开浮层"API；选择器变化即失效 | 沿用"找不到就收手"降级；浮层内「会话布」失效时只关自己、不报错 |
| 浮层盖住左右栏的定位争议 | 中 | 用户已确认全屏；但官方右栏（终端线）会被盖住 | 已在决策中接受；文档明示 |
| 焦点/无障碍自持 | 中 | 浮层不在官方无障碍树内 | 参照 canvas 既有做法；`role="dialog"` + `aria-modal` + 焦点陷阱 + Esc |
| 响应式断点语义漂移 | 低 | 容器从"中栏宽"变"视口宽" | D3 重跑四档验收 |
| 首帧空白 | 低 | 懒加载 + 300ms 兜底窗口 | 加载态占位 |
| **Agent 活动不可见** | 中 | [Agent 化规划](2026-09-14-ssh-agent-driven-plan.md) A1 落地后，Agent 会经 `ssh_exec` 自行在远端执行命令；而浮层**默认关闭** ⇒ 屏幕上什么都没有，与该公司规划的核心原则 **J5「可见性即安全」** 有张力 | 倾向 **对话流工具卡为主**（`tool.call.toolview`，Agent 化规划 §16 已核实可用）+ 浮层内活动面板为辅；**不建议**"Agent 一动就自动弹浮层"（打扰）。列为本方案与 A 系列的交叉待议项（§11-5） |

---

## 10. 源码索引

**同构蓝本（`dsh-miasaki-canvas/`）**

- `client.js:72` 浮层 CSS（`fixed` / `z-index:100` / `inset:0` / `[hidden]{display:none}` / `is-opening{visibility:hidden}`）
- `client.js:92-95` 宿主创建与 `document.body.append`
- `client.js:102-160` `ViewSwitch`（会话头胶囊）与 `open()`/`close()` 绑定
- `client.js:161-171` `overlay` / `frame` 引用与 `close()`
- `client.js:178-185` 外部视图槽（本线为消费方）
- `client.js:219-250` `syncTheme()` / `syncChrome()`
- `client.js:261-289` `open()` / `showMapOverlay()` / `onFrameLoad()`（含 300ms 兜底）
- `client.js:290-300` `onMessage`（`canvas:close` / `canvas:map-ready` / `canvas:open-session`）

**本线**

- [`../client.js`](../client.js)：`36-44` 宽窄自适应判据；`57-82` 合体胶囊 CSS（保留）；`76-82` `data-width-handle` 规则（**D3 删**）；`84-125` 主题桥接（保留）；`127-232` 委托点击全套（**D3 删**）；`234-261` 外部视图槽（保留）；`263-332` 入口按钮（改 onClick）；`335-392` `SshView`（**改为浮层**）；`396-404` `conversation.view` 注册（**D3 删**）
- [`../app.js`](../app.js)：`1571` `mount()`；`627` `mountSession()`；顶栏为新增
- [`../styles.css`](../styles.css)：`72-73` `.hidden` / `[hidden]`；`85` `container-type`；`251-266` 容器查询断点
- [`../session.js`](../session.js)：`fit` 路径（§5.1 第 2 层改动点）
- [`../index.js`](../index.js)：`58-72` 页面骨架（**不改**）
- [`2026-09-14-ssh-global-panel-plan.md`](2026-09-14-ssh-global-panel-plan.md)：路线甲/乙/丙平台取证（**F1–F5 仍然有效**，尤其 [F4](2026-09-14-ssh-global-panel-plan.md) 解释了为何丁不必纠偏）
- [`2026-09-12-ssh-workspace-plan.md`](2026-09-12-ssh-workspace-plan.md)：U0/U1 契约（终端生命周期、主题桥接、响应式），本方案不改其内部契约

---

## 11. 待评审 / 待议

1. ~~**D0 是否先做**（§7）~~ **已完成（2026-09-14，五项全过，实测记录见 §12）**——尤其 §5.1：它是本方案唯一可能"写坏远端 PTY"的点，已拿到实测数据。**D1 可以开工**。
2. ~~浮层内顶栏放哪些？~~ **已定（2026-09-14，用户）**：顶栏只放「对话｜会话布｜SSH」三个切换按钮，**不堆工具**；查找 / 字号 / 专注 / 送往对话留在终端工具区原位。
3. ~~`Esc` 关闭浮层是否要？~~ **已定（2026-09-14，用户）**：**不关闭**——终端聚焦时 `Esc` 留给远端程序。由此退出浮层的唯一路径是顶栏「对话」按钮（见 §5.5 硬约束）。
4. ~~浮层开关状态是否记忆？~~ **已定（2026-09-14，用户）**：**要记忆**，存 `sessionStorage`（§5.9）。
5. **Agent 活动可见性**（与 [Agent 化规划](2026-09-14-ssh-agent-driven-plan.md) 的交叉，**待议**）：A1 落地后 Agent 会自行在远端执行命令，而浮层默认关闭 ⇒ 用户看不见，与 J5「可见性即安全」有张力。倾向"对话流工具卡为主 + 浮层内活动面板为辅"，**不建议**自动弹浮层。**不影响本方案实施**，但应在 A1 开工前定。
6. 关闭浮层时是否**断开** SSH —— 建议**不断**（连接保活在 host 侧是既有契约，浮层只是查看器）。

---

## 12. D0 SPIKE 实测记录（2026-09-14，五项全过）

**结论先行**：五项全部通过，**D1 可以开工**。实测方法：headless Edge（原生 CDP 驱动）+ 探针宿主页（复刻路线丁浮层结构）+ **真实 `index.js` / `SshStore` / `SshRuntime` / 真实 `app.js`/`session.js`/`xterm`**（原样 import，零改动）+ `ssh2.Server` 假远端（真协议握手 / 密码认证 / TOFU 指纹确认走真实 UI）。完整数据在 `_refs/scripts-archive/ssh-d0-spike/d0-result.json`，探针四件套同目录可复现。

### 12.1 实测环境与通道

| 项 | 值 |
|---|---|
| 浏览器 | Edge 152 `--headless=new`，1440×900，原生 CDP 驱动 |
| host 栈 | `dsh-miasaki-ssh/index.js` 挂本地 http server（假 webServer ctx：exact/prefix/upgrade 三注册表），dataDir 临时目录 |
| 远端 | `ssh2.Server`（ed25519 host key），密码认证，session 记录 `pty`/`shell`/`window-change` 事件 |
| 连接流程 | 真实 UI 全链路：主机行 → 「连接主机」→ 密码 sheet → **TOFU「信任并继续」** → 已连接（163×45） |
| 判据端点 | **假 sshd 的 `window-change` 事件**＝resize 帧到达「真实 PTY 语义端点」的权威记录 |

### 12.2 五项结果

| 项 | 判据 | 实测 | 判定 |
|---|---|---|---|
| **①-A（visibility:hidden）** | 关闭态零退化 resize 帧 | 关闭瞬间 **0 帧**；隐藏期改视口 → **1 帧且是新视口的正确值**（163×45→119×38）；恢复 → 1 帧回 163×45；重开 **0 帧**（xterm 尺寸去重生效）。全程无 cols≤2 的退化值 | **过** |
| **①-B（display:none 对照）** | （对照组，非判定项） | **意外结果**：Chromium 对 display:none 的 iframe **暂停渲染管线**——RO/rAF 均不触发，隐藏期零帧，重开直接恢复正确尺寸。**设计文档预测的 2×2 灾难未复现** | 见 12.3 |
| **②30 次开关零损失** | 屏幕原样、无监听累积、无跨代串写 | iframe **从未重载**（文档标记不变）、session **同一实例**、回放环内容全保留（开关前 + 开关期间 4 次 push 全在）、开关后输入回显正常、**周期内零 resize 帧**、全程单 shell 连接、状态栏恒「已连接」 | **过** |
| **③窗控 reserve** | 量法成立 | 普通浏览器（无窗控）→ **reserve=0**；注入真 `theme-init.js` 后 `#miasaki-titlebar .tb-group` 出现（fixed，left:1311/w:97）→ canvas 同款量法算出 **reserve=111px** | **过**（机制级；真实壳内的视觉验证留 D2 实机） |
| **④双浮层互斥** | 任一浮层盖住会话头 | 画布浮层开时头部按钮 `elementFromPoint` 不可达（`buttonReachable:false`）⇒「天然互斥」成立；委托关画布→开 SSH 流程通；强制双开时 SSH（DOM 后者）在上 | **过** |
| **⑤IS_TOP 守卫** | iframe 内无假窗控 | 把 desktop 线**真产物** `theme-init.js` 注入 SSH iframe：无 `#miasaki-titlebar`、无 `#miasaki-switcher`（closeDialog/aurora 按既有设计存在），`data-miasaki-theme` 属性照常下发 | **过**（机制级；真实壳内复验留实机） |

### 12.3 对设计前提的两处修正

1. **§5.1 的「display:none 会写坏 PTY」在本版 Chromium（Edge 152）未复现**——`display:none` 的 iframe 渲染管线被暂停，RO/rAF 都不跑，误 fit 根本没机会发生，重开后尺寸直接恢复。**但这不构成回退到 display:none 的理由**：①依赖的是「渲染暂停」这种浏览器实现细节（跨浏览器 / 未来版本不可依赖）；②display:none 期间 xterm 不渲染，关闭期间的新输出要等重开才绘制；③visibility 方案的「尺寸恒等视口」是 CSS 规范行为，语义正确。**丁方案维持 `visibility:hidden + pointer-events:none` 不变**，§5.1 三层保险中第 1 层照旧，第 2 层（session.js fit 可见性门控）降为可选加固（防御未来浏览器行为变化），第 3 层（重开补 fit）保留——实测证明重开后尺寸本来就正确，补 fit 是零成本去重操作。
2. **hidden 期改视口会有正确尺寸的 resize 帧发出**（iframe 仍在布局中，RO 正常触发）——这是**期望行为**（PTY 跟随真实可视尺寸，重开即所见即所得），不是缺陷；验收矩阵 B-3 的「零 resize 帧」应修正为「**零退化 resize 帧**」。

3. **补充实测（同日，独立来源：动态 Cordis 探针 `sshpb-1` v1–v4，结论取出后已删除，无残留）**——为理由 ① 补一个**具体的"第二道保护"及其脆弱点**，不影响上面两处处置：

   在**真实 `/ssh/` iframe 内**并排测两种终端容器，`display:none` 下读 `getComputedStyle(holder)`：

   | 容器 CSS | `computed` W/H | `parseInt` | 布局盒 | 推出的 `fit()` 行为 |
   |---|---|---|---|---|
   | 真实 `.term-holder`（`flex:1 1 auto`，**无显式宽高**） | **`auto / auto`** | **NaN** | 0×0 | `Math.max(2, NaN)` = NaN ⇒ 被 xterm 自己的 `isNaN(dims.cols)` 拦下 ⇒ 提前 return（**第二道保护**） |
   | 写成 `width:100%;height:100%`（极常见） | **`100% / 100%`** | **100** | 0×0 | 算出 **12×5** —— "看起来完全合理"的错误尺寸，两端 `[2,1000]`/`[2,500]` 限界都会放行 ⇒ **第二道保护失效** |

   该探针同时确认：`display:none` **确实触发了一次 ResizeObserver 回调**（两种容器都从 1 次变 2 次）——这与 §12.2 ①-B 的「零帧」**不矛盾**：RO 回调跑了一次，但其后 `scheduleFit()` 里的 rAF 未执行（渲染暂停），所以 `fit()` 从未被调用、也就没有帧。而 `visibility:hidden` 下两种容器的尺寸与 RO 计数**全程完全不变**。

   **由此给出一条实施建议（供 D1 判断，不改变既有结论）**：§12.3-1 把「第 2 层 · session.js fit 可见性门控」降为"可选加固"。考虑到上面的数据——**当前工作树的安全还额外依赖"`.term-holder` 恰好没有显式宽高"这个未写进任何契约的性质**（U1 的"高度链"改动很容易把它改成 `height:100%`），建议把该门控**保留为实质性加固**而非可选，并在门控处写明它守的是什么（"不要让 xterm 的内部 NaN 检查成为唯一防线"）。成本仍是几行代码。

### 12.4 探针顺带逮到并修复的真实缺陷（阻断级）

实测首连时发现 **TOFU 首连流程死锁**：`buildSkeleton` 把 `#status-text` 嵌进 `#status-pill` 内部，而 `renderStatusbar()` 每次 `pill.replaceChildren(dot, span)` 把它从 DOM 抹掉 → 每个 WS 状态帧进 `handleSessionStatus` 就在 `$('#status-text').textContent` 上抛 TypeError → `waiting-fingerprint` 的 `onFrame` 永不执行 → **指纹确认 banner 永不出现，首连永远卡在等待确认**。修复：`#status-text` 移为 statusbar 直接子节点（pill 只留 dot），`renderStatusbar` 改为只换 dot 类名与文本、不再重建节点；`test/app.test.js` 新增骨架幂等回归用例（vm 桩驱动 buildSkeleton + 两次 renderStatusbar 断言节点存活）。单测 60 → **63 例**全绿，`verify-all ssh` **12/12**。**此缺陷意味看现工作树的「M1 真实连接」从未真正跑通过首连链路**（此前实机验收停在更早的 U1 两个阻断 bug 上，未覆盖到 TOFU 环节）。

### 12.5 复现方式

探针四件套（`fake-sshd.mjs` / `probe-host.mjs` / `probe-page.html` / `run-d0.mjs` + `host_key`）已归档 `_refs/scripts-archive/ssh-d0-spike/`。复现：`node run-d0.mjs`（自动起假 sshd + 探针 host + headless Edge，跑完写 `d0-result.json` 并清理）。约 60–90 秒。


---

## 13. D1 实施记录（2026-09-14，四项门槛实测全过）

**交付**：浮层骨架按 §6 落地——client.js（宿主 + 常驻 iframe + 懒加载 + open/close + sessionStorage 记忆 + chrome-reserve 量法下发 + 主题桥迁移到浮层 iframe + 入口/画布广播改线为「关画布→开浮层」+ 卸载整树回收），app.js（lastTab sessionStorage 记忆：openHost 写入、关标签清理、mount 尾部重挂 attach），conversation.view 与 tab 委托三件套**保留作回退**（D3 才删）。

**实测通道**：headless Edge CDP 加载 /d1/ 探针页，探针页内 apply **真实 client.js**（契约测试同款桩），连接链路走真实 /ssh/ 栈与真实 UI（密码 + TOFU）。四项门槛：

| 门槛 | 实测 | 判定 |
|---|---|---|
| 点入口进浮层 | 预置记忆=1 → dispose+重 apply → **真实 openOverlay 路径**：浮层现于 DOM、iframe src 真实赋为 /ssh/（懒加载生效）；随后在浮层 iframe 里真实 UI 走完密码 + TOFU + 已连接（67×21） | 过 |
| 点「对话」退出 | 关闭（is-closed + 记忆写 0）→ 重开 → 30 次开关：session 同一实例、零 resize 帧、回放环内容保留 | 过（**函数级可达**——探针直接操作状态／调内部函数；**用户级不可达**，见 §13.1） |
| 终端零损失 | 同上；开关前后 snapshot 与 size（67×21）不变、单 shell 连接 | 过 |
| 刷新恢复 | Page.reload 后：记忆 1 → 浮层自动重开（src=/ssh/）→ 页面侧 lastTab 重挂 → 状态栏「已连接」 | 过 |

**单测**：client.test.js 重写为浮层契约（16 例：宿主 / is-closed 初始态 / 懒加载无 src / 加载占位 / visibility 策略且不得 display:none / 记忆 0 与 1 双路径 / 入口 onClick 契约 / 画布广播改线 / chrome-reserve 量法 / 主题桥去重 / 回退期保留 / 幂等与宿主回收 / 手柄隐藏 / 胶囊合成），verify-all ssh 12/12。

**改动文件**：client.js / app.js / test/client.test.js；启动看板 design/preview/2026-09-14-ssh-d1-kickoff-board.html（Müller-Brockmann 版式，含章程/排期/台账/风险/异常预案/复核/交接七节）。探针归档 _refs/scripts-archive/ssh-d0-spike/（run-d1.mjs + d1-probe.html + d1-result.json）。

**待办移交**：实机验收（重启 dsh web：入口进浮层 / 主题桥 / 桌面壳窗控真实壳复验）→ D2 顶栏。

### 13.1 D1 验收发现：单向门（阻断级，用户实机截图确认，已修复 2026-09-14）

**判定：D1 首版不通过。** §13 表格里的「点「对话」退出 → 过」是**函数级可达**的过（探针能直接操作状态），不是**用户级可达**的过。

**现象**：点一次 SSH 按钮进浮层后，**用户没有任何办法回到会话界面**。用户实机截图确认（全屏 SSH 工作区，左上角没有胶囊，右侧只有窗控）。

**证据链**（静态，逐环独立确认）：

| 环节 | 事实 |
|---|---|
| `closeOverlay` 定义 | client.js 中有 |
| `closeOverlay` **调用点** | **0 处** —— 全仓 grep 只有定义那一行 |
| 覆盖范围 | `.dsh-ssh-overlay{position:fixed;z-index:100;inset:0}` ⇒ 会话头（含入口按钮）被盖住 |
| 浮层内控件 | 只有 `<span.dsh-ssh-loading>` + `<iframe>`，**无退出控件** |
| iframe → 宿主 | app.js 只收发 `theme`，**无关闭消息** |
| 键盘 | client.js **无任何** `keydown`/`Escape` 监听（用户 2026-09-14 已定「`Esc` 不接管」） |
| 刷新 | 记忆=1 ⇒ `apply` 末尾自动 `openOverlay()` ⇒ **刷新也被困** |

⇒ 唯一出路是关掉标签页 / 应用（`sessionStorage` 才清空）。

**为什么会"四项门槛全过"**：

1. **探针的可达性 ≠ 用户的可达性**。§13 的探针页能直接操作 DOM / 调内部函数去关闭浮层，所以"关闭"在探针里是可达的；而产品代码里**没有任何用户可达的路径**。
2. **门槛与分期自相矛盾**。§7 的 D1 门槛写「点「对话」退出」，但那颗「对话」按钮本身是 **D2 的交付物**（浮层内自绘顶栏）。实施者把 `close()` 当"给 D2 预留的 API"实现，却没在 D1 留临时出口。
3. **单测没兜住**：那几条断言测的是**源码文本**（CSS 字符串、`onClick` 字面量），没有一条测"能不能真的退出来"。

**修复**（最小，不抢 D2 的活）：

1. `client.js`：浮层内加一条 38px 的**临时退出条** `.dsh-ssh-bar`（`.dsh-ssh-exit` 按钮「← 对话」→ `closeOverlay()`）；浮层改 `display:flex; flex-direction:column`，iframe 由 `height:100%` 改为 `flex:1 1 auto; min-height:0` 让出这条高度。**D2 顶栏落地时整条删除**（代码内已注明）。
2. `test/client.test.js`：DOM 桩补 `.dsh-ssh-bar` / `.dsh-ssh-exit` 子树；**新增一条行为闭环断言**——记忆=1 → apply 自动恢复浮层 → 点退出控件 → 浮层回到 `is-closed` 且记忆写回 `0`。
3. 回归：`verify-all ssh` **12/12**（client 16 → **17 例**）。

**方法论教训（写给后续所有门槛验收）**：**探针能调到内部函数，不等于用户能触达该路径。** 门槛里写"点 X 应该 Y"时，验收必须**从用户可达的入口出发**（找到真实可点的元素并触发它），而不是在探针里直接操作状态。§13 表格中该行的判定口径已改记为「函数级可达」，与「用户级可达」区分开。

---

## 14. D1.1 规划：无会话头时的常驻入口（`shell.overlay`）

- 状态：**已实施（2026-09-14）** —— 回归 `verify-all ssh` **12/12**，client 16 → **20 例**；实施记录见 §14.9
- 触发：用户首屏观察 ——「新对话是不是也应该加个 SSH 入口」。这正是 §1/§3 诊断的 **D2「无会话即无入口」**：浮层让 SSH 的**本体**脱离了会话（body 级、host 侧保活），但**入口**仍挂在 `conversation.session.header.actions`（`session` scope）上，而 **hero 态（首屏）没有会话头 ⇒ 没有入口** ⇒ 用户必须先发一条消息（创建一个会话）才能用 SSH。

### 14.1 候选席位与排除

在 0.1.5-rc.1 现场槽树 + hero 态渲染清单上逐项核对：

| 候选 | hero 态渲染 | 结论 |
|---|---|---|
| `conversation.composer.bar` | ✅（catalog 明写 "including the no-Session inert state"） | ❌ **`single`** ⇒ 注册会顶掉整个输入框 |
| `conversation.input.attachments` | ✅ | ❌ **`single`** ⇒ 顶掉附件栏 |
| `conversation.input.left` / `.right` / `.dock` | ❌ 不渲染 | ❌ 用不上 |
| `conversation.hero.workspace` / `.agentPreset` | ✅ | ❌ `replaceRisk: shadows-shipped-ui` ⇒ 顶掉工作区／模式选择器 |
| `conversation.hero.brand.mark` | ✅ | ⚠️ `replaceRisk: none`，但那是**品牌 logo 位**，不适合放功能入口 |
| `sidebar.panellist`（用户首选） | ✅ | ❌ **硬约束，见 §14.2** |
| **`shell.overlay`** | ✅ | ✅ **采用** |

### 14.2 为什么 `sidebar.panellist` 用不了

panellist 那一行的点击是**官方写死的**（`dsh-client-ui-sidebar/lib/client.js` 的 `PanelRow`）：

```jsx
onClick={() => { selectPanel(id) }}     // injectProps: (id) => ctx.layout.selectPanel(id)
```

而 `ctx.layout.selectPanel` 对**未注册的 main key** 直接抛错（`dsh-client-ui-layout/lib/client.js`）：

```js
if (panelId !== null && !this.hasMainPanel(panelId))
  throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
```

⇒ 在 panellist 注册 `id: 'ssh'`，**图标画得出来但点了没反应**（外加控制台报错）。要用 panellist，就**必须同时注册 `main` 的 key `ssh`** —— 那等于**转路线乙（官方全局面板）**：放弃全屏、吃 F4（点会话条目被官方弹回对话）、面板切换导致 iframe 重建。**用户已明确不转**，故 panellist 出局。

> 记一笔：将来若真想要"左栏顶部图标列"那个位置，唯一路径是转乙 —— 那是一次**形态返工**（§2 三路对比、§7 的 D2/D3 要全部重算），不是"加一个入口"。本节方案不为此预留任何耦合。

### 14.3 席位契约（0.1.5-rc.1 现场查询）

```
shell.overlay   kind: list   scope: root   replaceRisk: none
declaredBy: an entry in "root" (ui-layout)
occupants:  [{ id: "usage-stats-overlay" }]        ← token 用量那条，仅此一个
ownerProps: []                                     ← 无 owner props
standardProps: useResource / useWorkspaces / usePanelInfo / useSessions / useSessionPendingInteraction
```

官方 catalog 原文（两条决定性约束）：

> **The layer itself is click-through — entries opt back into pointer events — so an occupant never blocks the app underneath.**
> This is the additive seat for a frame-wide surface of your own: a fresh `id` is added beside the shipped entries instead of replacing them.

### 14.4 设计

**判据 —— 什么时候显示**：用 `useSessions`（standardProps 提供）读当前会话：

```js
const current = useSessions((state) => state.current)   // SessionId | undefined
if (current !== undefined) return null                  // 有会话 ⇒ 会话头有胶囊 ⇒ 不渲染
```

「无会话」等价于「无会话头」有源码依据：`ConversationRoot` 里 `sessionId === void 0 ? null : renderSlot('conversation.session.header', …)`。**判据统一走 `state.current`**，并在组件注释里写明它守的是什么（"hero 态没有会话头、胶囊不存在，这里必须顶上"），避免日后被改成 DOM 探测。

**位置** —— 右上角、**桌面壳窗控左侧**：
- 与「有会话时右上角的 SSH 胶囊」保持**位置连续性** —— 用户在同一个区域找 SSH，只是 hero 态下那里还没有会话头
- 复用 `syncChrome()` 已经量好的 reserve（D0 ③ 真实壳实测 **150px**）：把 reserve 同步写成宿主 CSS 变量 `--dsh-ssh-chrome-reserve`，按钮用 `right: calc(var(--dsh-ssh-chrome-reserve, 0px) + 16px)`；卸载时 `removeProperty`
- 普通浏览器无窗控 ⇒ reserve = 0 ⇒ `right: 16px`

**指针事件（官方明示的坑）**：`overlayLayer > *` 会拿到 `pointer-events: auto` ⇒ **容器若铺满就挡住整个应用**。所以：

```
容器：position:absolute; inset:0; pointer-events:none      ← 不拦任何东西
按钮：pointer-events:auto; position:absolute; top:14px; right:calc(…)
```

**形态**：复用入口胶囊 `.dsh-ssh-switch` 的同款视觉（胶囊 + 终端图标 + 「SSH」），主题令牌驱动 —— 位置换了但外观一致，用户一眼认得出来。

**点击**：与胶囊、画布广播**完全同一条路径** —— `dismissCanvasOverlay()` → `openOverlay()`。零新逻辑。

**注册**：`ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'ssh-launcher', order: 40 }, SshLauncher))`。用自有 id（官方明示"a fresh `id` is added beside the shipped entries"），不碰 `usage-stats-overlay`。

### 14.5 三条入口的覆盖关系（改完后的完整图景）

| 场景 | 入口 |
|---|---|
| 有会话 | 会话头第一行胶囊（现有） |
| **hero 态（无会话）** | **`shell.overlay` 浮动入口（本节新增）** |
| 画布浮层打开时 | 画布内外部视图槽的 SSH 按钮（现有） |
| 浮层已打开 | 浮层内临时退出条（§13.1） |

### 14.6 改动清单

| 文件 | 改动 |
|---|---|
| `client.js` | 新增 `shell.overlay` 注册 + `SshLauncher` 组件（判据 / 定位 / 指针事件 / 点击）；`syncChrome()` 顺带写 `--dsh-ssh-chrome-reserve`，卸载时移除 |
| `test/client.test.js` | +3 例：①注册契约（`shell.overlay` / id / order）；②`current !== undefined` 不渲染、`undefined` 渲染；③点击走「关画布 + 开浮层」 |
| 文档 | 本文件 §14 + CHANGELOG |

### 14.7 验收门槛

1. **hero 态**出现浮动 SSH 入口（右上角、窗控左侧），点击能进浮层。
2. **有会话（非空白）时不渲染**（`document.querySelectorAll('.dsh-ssh-launcher').length === 0`）—— 用这条锁死"绝不出现双入口"；**空白会话（首屏）必须渲染**（判据见 §14.9-5）。
3. 点击行为与胶囊一致（关画布 → 开浮层）。
4. 三主题下与胶囊同款视觉（令牌化，不硬编码色）。
5. **不挡应用**：容器 `inset:0` 但 `pointer-events:none`；hero 态下页面其余部分照常可点（用 `elementFromPoint` 验证输入框可达）。
6. 桌面壳里不被窗控压住（真实壳 reserve = 150px 生效）。
7. **键盘可达**（hero 态下它是唯一入口）；focus-visible 清晰。

### 14.8 风险

| 风险 | 等级 | 对策 |
|---|---|---|
| 容器铺满挡住应用 | **高** | 官方明示的坑：容器 `pointer-events:none`，仅按钮 opt-in；验收第 5 条用 `elementFromPoint` 实测 |
| 会话就绪与会话头渲染之间的窗口期闪烁 | 低 | 判据走 `state.current`；验收观察，确有闪烁再评估短暂延迟（不预先加复杂度） |
| 与 `usage-stats-overlay` 抢层 | 低 | 自有 id + `order: 40`；不碰它的 id |
| `--dsh-ssh-chrome-reserve` 变量泄漏 | 低 | 归 `ctx.effect`，卸载时 `removeProperty` |
| 判据被后人改成 DOM 探测 | 低 | 组件注释写明判据依据与它守的东西 |

### 14.9 实施记录（2026-09-14）

`client.js` 三处 + `test/client.test.js` 三条；回归 **12/12**（client 16 → **20 例**）。实施中有四个值得记下来的点 —— 前三个都是"照抄就会踩"：

1. **launcher 不能复用 `.dsh-ssh-switch` 类名**。`ownHeader()` 用 `document.querySelector('.dsh-ssh-switch').closest('header')` 当**会话头锚点**，回退期的 tab 三件套（`hideOwnTab` / `viewIsSsh` / `selectSsh`）全靠它。launcher 若共用一个类，`querySelector` 可能先命中浮层里那颗 ⇒ 锚点落到非 header 节点 ⇒ **三件套集体失灵**。⇒ 改用独立类 `.dsh-ssh-launcher`，视觉并列写一份（同令牌 / 同圆角 / 同 28px）。
2. **容器的 `pointer-events:none` 必须带 `!important`**。官方 overlayLayer 的规则是 `.xxx_overlayLayer>*{pointer-events:auto}`，与本条**特异性相同**（都是 `(0,1,0)`）⇒ 谁后注入谁赢，而这个顺序不由我们决定。容器一旦被设回 `auto`，`inset:0` 就**挡住整个应用**（§14.8 那条高风险）。
3. **`syncChrome()` 必须在 `apply` 期间主动调一次**。它原先只挂在 iframe 的 `load` 监听上，而 iframe 是**懒加载**的（用户没开过浮层就永远不加载）⇒ `--dsh-ssh-chrome-reserve` 永不设置 ⇒ 桌面壳里 launcher 退回 `0px` fallback，**被窗控压住**。⇒ apply 里补一次显式调用。
4. **组件拆两层**（`SshLauncher` → `LauncherButton`）：React 不允许条件调用 hook，而"有没有 `useSessions` 这个 standard prop"本身要判。⇒ 外层只判 prop、内层无条件调 hook；缺 prop 时**整层不渲染**（安全降级，**不回退成 DOM 探测**）。

测试侧同步改了两条既有计数断言（注册数 2 → 3、两次 apply 4 → 6）—— 它们正是"注册项数量"这个契约的守卫，漏改会让新入口静默逃过覆盖。

5. **判据首版写错：不能只看 `state.current`（实机验证发现，当日修正）**。首版判据是 `current === undefined`，结果**真实首屏上什么都不出现**。根因：进入首屏时工作区**已经建好一个 blank session**，`state.current` **有值**；而"会话头不渲染"的判据在 `ConversationRoot` 那里看的是 `main.conversation` 绑定的 sessionId（那里是 `undefined`）—— **两者不是一回事**。
   - **诊断路径（可复用）**：先查 `shell.overlay` 的 occupants，看到 `ssh-launcher` **已注册且 active** ⇒ 一步排除注册问题、锁定渲染判据。比在代码里猜快得多。
   - **修正**：判据改为「`current === undefined` **或** `byId[current].blank === true`」。官方字段 `SessionSummary.blank`（`client-ui-workspace/lib/types/client/tree.d.ts`：*"The provisional blank session (renderer shows the localized New Session title)"*）。
   - 同时把**不确定情形统一为显示**（状态缺失 / 摘要未就绪 ⇒ 返回 true）：**没有入口比短暂双入口更糟**，与既有的「能收才收」降级哲学一致。
   - 测试补三条边界：非空白会话不渲染 / 空白会话渲染（首屏正是这个状态）/ 摘要未就绪与状态缺失都保守显示。

6. **视觉对齐（实机反馈后优化，同日）**。用户对首屏 launcher 的评价是"不好看"，两处原因都在首版上：
   - **视觉太重**：首版是带 `1px` 边框 + `bg-overlay` 实底 + `backdrop-filter` 的 `999px` 胶囊，混在一排**线性图标 + 圆形头像**（窗控 / 主题球）里读作异物。⇒ 改为**与窗控同一视觉语言**：`border:0` + `background:transparent` + hover 才显 `interactive-bg-hover` + `border-radius:7px`（同款小圆角）。
   - **没对齐**：首版写死 `top:14px`，而窗控组是 `top:5px` ⇒ 低了 9px。⇒ **不再写死**：`syncChrome()` 顺带量窗控组的 `getComputedStyle(...).top` 与 `rect.height`，写成 `--dsh-ssh-chrome-top` / `--dsh-ssh-chrome-height`，按钮直接消费（量不到则退回 `5px` / `28px` 默认 —— 普通浏览器没有窗控，这两个值不影响任何人）。带**限界防呆**（top ∈ [0,40]、height ∈ [20,44]）：量歪了宁可退回默认，也不跟着摆歪。
   - 卸载时三个 `--dsh-ssh-chrome-*` 变量一并 `removeProperty`。回归仍 **12/12**。


---

## 15. D2 实施记录（2026-09-15，探针六项全过）

**交付**：浮层内自绘顶栏（§6 app.js/styles.css 行的 D2 部分）——

| 项 | 内容 |
|---|---|
| **client.js** | ① 删 D1 临时退出条（innerHTML 结构 + SWITCH_CSS 的 .dsh-ssh-bar/.dsh-ssh-exit 块）；② 顶栏消息协议 `onOverlayMessage`：`ssh:close`（closeOverlay + 焦点归还 lastOpener）/ `ssh:view view:'canvas'`（closeOverlay + 委托点击 canvas 胶囊「会话布」段，canvas 不在场静默收手）；安全：消息必须 `source === frame.contentWindow` + `overlayToken`（随机、随 chrome 消息下发、宿主校验）；③ `openOverlayFrom(el)`：入口/launcher/画布广播三个触发点都记录归焦目标；④ 卸载解绑 onOverlayMessage。 |
| **app.js** | ① `setupThemeListener` 同通道分发 chrome 消息：token 存 `overlayState`，reserve 写 `--ssh-chrome-reserve`；② `isOverlayMode()`（parent 文档有 .dsh-ssh-overlay）→ mount 时 `buildTopbar(root)`：三段胶囊「对话｜会话布｜SSH」，SSH 段 active + aria-current="page"，回退视图不渲染；③ 「对话」`sendOverlayClose`、「会话布」`sendOverlayCanvas`。 |
| **styles.css** | .topbar（--ssh-* 令牌、右内边距消费 --ssh-chrome-reserve）、.topbar-switch/.topbar-btn（与宿主入口同视觉语言）；#ssh-root 改纵向 flex（顶栏 40px 固定 + .workbench flex:1）。 |

**实测**（真浏览器 × 真 client.js × 真 app.js 顶栏，探针页 apply + 消息协议全链路）：六项全过——①顶栏渲染（三按钮、SSH 当前态 aria-current）；②「对话」退出：ssh:close → 关闭 + 记忆归 0 + launcher 重开正常；③「会话布」跳转：关自己 + 委托宿主，无 canvas 时静默收手零异常；④宿主文档无顶栏（顶栏只在浮层 iframe）；⑤30 开关零损失（session 同实例、零 resize 帧）；⑥静态回归 client 21/21 + 其余 34 例 + verify-all ssh 12/12。数据 `_refs/scripts-archive/ssh-d0-spike/d2-result.json`。

**过程异常（均已处置）**：① 探针桩 slots.inject 为纯 push，dispose+重 apply 后 find() 拿到旧代闭包（其 overlay 已出 DOM）⇒ launcher 点击无效；桩改为 cordis 同名替换语义后修正——非产品缺陷，是探针基建与 cordis 语义不一致。② 桩缺属性选择器与节点 click()，D2 契约需要；已补（matches 取选择器末段 + click 触发监听）。③ 单测两处场景流程写错（未重开浮层就断言开放态），修正为 launcher 真实重开路径。

**偏差**：2.9（A0 文案）顺延 D3——与响应式重校准、四档宽度验收同批执行更连贯。

**待办移交 D3**：删 conversation.view + tab 委托三件套并同步单测；A0 文案「点左上『对话』退出后粘贴」；响应式重校准（容器语义从中栏宽变视口宽，959/719/479 断点重跑 1280/960/720/480）；D3 收口前全量探针回归。

---

## 16. D2 实机验收记录（2026-09-15：首轮全绿 + 逮到 2 项非 D2 缺陷 → 当日修复 → 复验全绿）

**与 §15 探针的区别（这一节存在的理由）**：§15 是"真浏览器 × **探针宿主页**（桩 `slots`）"；本轮是"真浏览器 × **真实 DSH GUI**"——真宿主、`link:` 安装的真插件、真会话、真桌面壳注入，并且每条门槛都**从用户能点的元素出发**，用 `Input.dispatchMouseEvent`（走 hit-test ⇒ 验"用户可达"而非"函数可达"）与真实键盘 / 文本输入触发；另接一台本地假 sshd（`ssh2.Server`，真协议 + 密码认证 + TOFU + PTY/`window-change` 记录）作为真远端端点。这是 D1「单向门」教训的直接落地：**探针能调到内部函数，不等于用户能触达该路径**。

驱动与证据归档：`_refs/scripts-archive/ssh-d2-accept/`（`node run-accept.mjs` 可复现，约 6 分钟；结果 `accept-result.json` + `shots/*.png`；本地假 sshd 与 CDP 驱动同目录）。

### 16.1 门槛结果（**复验：24 项全 PASS、0 FAIL**；首轮 20 PASS / 2 FAIL 的两条 FAIL 是**非 D2** 的移交发现项，已于当日修复）

| # | 门槛 | 判据与关键证据 | 结果 |
|---|---|---|---|
| A1 | hero 入口（§14 `shell.overlay` launcher） | 真实鼠标点击命中自身（`hitIsSelf` / `hit=true`）→ 浮层打开、`iframe.src='/ssh/'`、rect = 视口 1416×808 | ✅ |
| A1b | 会话头胶囊入口 | 进入会话后 launcher 退场（计数 0）、胶囊在场；真实点击胶囊 → 浮层打开 | ✅ |
| A2 | 全屏覆盖、官方 UI 不可达 | 5 个采样点（左栏 / 会话头 / 输入框 / 窗控位 / 画面中央）hit-test **全部**落 `.dsh-ssh-host` | ✅ |
| A3 | hero 态顶栏两段「对话｜SSH」且**只在浮层内** | hero 态没有 canvas 入口 ⇒ 只渲染两段（`segs: ["dialog","ssh"]`），SSH 段 `active` + `aria-current="page"`；宿主文档 `#ssh-topbar` 计数 **0** | ✅ |
| A3b | 会话态顶栏三段（降级**可逆**） | 进入会话后（canvas 胶囊在场 ⇒ `canvasAvailable=true`）重开浮层 → 三段「对话,会话布,SSH」回归，SSH 段仍 `aria-current="page"` | ✅ |
| A4 | 顶栏只放切换按钮 | hero 态 `barButtons=2` / 已连接态 `barButtons=3`，查找/字号/专注/送往对话 **都不在**顶栏（`btn-search`/`btn-focus`/`btn-send` 仍在工具区） | ✅ |
| A5 | 点「对话」退出 + 焦点归还 | `closed=true`、`sessionStorage` 记忆写 `'0'`、`document.activeElement === launcher 按钮` | ✅ |
| A6a | hero 态**不渲染**「会话布」段 | `.dsh-canvas-switch = 0` ⇒ 宿主下发 `canvasAvailable=false` ⇒ 顶栏无该段（**不留死按钮**），点「对话」正常退出、零异常（§16.3 收口后） | ✅ |
| A6b | 正向互斥 | SSH 顶栏「会话布」→ SSH 关 + 画布 `display:block` | ✅ |
| A6c | 反向互斥 | 画布顶栏外部视图槽按钮 `[data-action="external-view"][data-view-id="ssh"]` → 画布关 + SSH 开 | ✅ |
| A7a | 普通浏览器无多余留白 | `--dsh-ssh-chrome-reserve: 0px`、顶栏 `padding-right: 14px`（= 基数） | ✅ |
| A9a | `Esc` 不关闭浮层 | iframe 内派发 Escape → 仍 `closed=false` | ✅ |
| A9b | 「对话」键盘可达 + focus-visible | 段内按钮 `tabIndex=0`；Tab 前进序列随段数同步（hero「对话→SSH」/ 会话态「对话→会话布→SSH」）；从工作区 Shift+Tab **反向进入顶栏**并在键盘聚焦态读到 `outline: solid 2px` | ✅ |
| B1a | 浮层开着刷新 ⇒ 自动恢复 | reload 后 `closed=false`、`memory='1'`、iframe 重载并回到 `/ssh/` | ✅ |
| B1b | 关闭后刷新 ⇒ 停在对话 | reload 后 `closed=true`、`memory='0'` | ✅ |
| B2 | 零损失（**真协议端点**） | 一次点击关闭成功 → 关闭期间远端 `window-change` **0 帧**；重开后 iframe **未重载**（`window` 标记存活）⇒ 会话未重建；30 次开关 → **0 resize 帧**、SSH 侧 `shell` 事件恒为 **1**；真实键盘输入送达远端（sshd 记录到输入），状态栏回读「已连接」 | ✅ |
| C1 | 三主题真实切换 | 点右下角主题球 → `.ms-opt[data-theme]`：pure / zafkiel / kurkuriel 逐一切换生效（`data-miasaki-theme` 一致、zafkiel 强制暗色） | ✅ |
| C2 | **三主题下顶栏一致 + 消费窗控 reserve**（D2 门槛本尊） | 三主题下均为三按钮、SSH 段 `aria-current="page"`、`padding-right: 164px = 14 + 150`（壳窗控实测 reserve） | ✅ |
| C3 | 壳内入口不与窗控叠压 | 会话头胶囊 x∈[686,741] 与窗控组 x∈[1272,1408] 同排（top 差 ≤3px）且**不重叠** | ✅ |
| P16b | 真实连接链路 | 新建主机→选中→「连接主机」→ 密码 → TOFU 信任：sshd 侧 `tcp-connect/auth-ok/pty/shell/window-change` 全记录，前端 xterm 挂载（163×43） | ✅ |
| P16a | 「保存并连接」是否真的连接 | 点后**凭据对话框被拉起**（`sheetTitle: "连接密码 · d2-accept-local"`）、主机落库 —— 证明 `connectFlow` 真的被调用（D-1 修复后） | ✅ |
| P16b | 真实连接链路 | 新建主机 →「保存并连接」→ 密码 → TOFU 信任：sshd 侧 `tcp-connect/auth-ok/pty/shell/window-change` 全记录（`tcpDelta=1`），前端 xterm 挂载（163×43） | ✅ |
| P16c | 连接成功后前端状态同步 | 状态栏「已连接」+ 横幅 `hidden:true / display:none`（D-2 修复后；修复前为「未连接」+ 常驻横幅） | ✅ |

静态回归：`node scripts/verify-all.mjs ssh` → **12/12 PASS**（单测 79 例）。

**复验（2026-09-15 15:2x，重启 host 后）**：`D2_ACCEPT_DONE allPassed=true` —— **24 项门槛全 PASS、0 FAIL**（上方表格已是修复后的复验结果）。修复前的原始失败证据保留在同目录 `accept-result.json` 的历史版本与 `diag-connected-result.json`（D-2 原始现象：状态栏「未连接」+ 横幅常驻，host 侧却是 `connected`）。

**一条探针判据教训**：判"横幅还在不在"**不能读 `innerText`** —— 按规范，元素"不被渲染"时 `innerText` 会退回 `textContent`，于是**已隐藏的横幅被误判成残留**（本轮 P16c 因此假阴性一次，多绕了一轮）。正确判据是 `hidden` 属性 + `getComputedStyle().display === 'none'`。与 D1「探针可达 ≠ 用户可达」同属"判据本身也会骗人"。

### 16.4 移交 D3 的清单（含验收期间新发现）

D3 开工时一并处理，**只重启一次 host、一次性复验**：

1. **D-3（本轮验收期间新发现，一行修法）**：`app.js` 的 `renderIdentity` 在"选中的主机被删除"时抛 `TypeError: ... reading 'group'`（`byId(state.selection)` 返回 `undefined` 而非 `null`，`conn === null` 判空失效）。修法：`byId(state.selection) ?? null`，并补一条"删主机后 renderIdentity 不抛错"的单测（用户触发路径 = UI 里删除当前选中的主机）。
2. **§15 既有待办**：删 `conversation.view` 注册与 tab 委托三件套（`ownTab`/`hideOwnTab`/`restoreTabs`/`viewIsSsh`/`selectSsh`）并同步单测；A0 文案改为「点左上『对话』退出后粘贴」；响应式重校准（容器语义从中栏宽变视口宽，959/719/479 重跑 1280/960/720/480）。
3. **可选（无害但可顺手）**：`renderBanner()` 隐藏横幅时顺带 `replaceChildren()` 清内容（当前只设 `hidden`，DOM 里留着上次的按钮节点）。

人眼证据（同目录 `shots/`）：`a1-overlay-open.png`（浮层全屏覆盖）、`p11-session-header.png`（会话头三段合体胶囊，pure 亮色）、`c2-topbar-{pure,zafkiel,kurkuriel}.png`（三主题顶栏，含窗控让位）、`p16-connected-workbench.png`（连接后的工作区 + 顶栏共存）。

### 16.2 两条移交发现项（均**不属于** D2 交付物，D2 判据不受影响）—— **已修复（2026-09-15，用户定向「两条一起修」）**

- **D-1（阻断级，U1 遗留）：「保存并连接」从不发起连接。** 真实点击后主机**已落库**（`/ssh/api/connections` 可见、sheet 关闭、`state.selection` 已设），但远端**零 TCP 连接**、无凭据对话框、状态栏仍「未连接」。根因：`app.js:554` 的 `event.saveAndConnect = true` 写在**全局 `window.event`**（当前 click 事件）上，而 `form.dispatchEvent(new Event('submit'))` 使处理器 `app.js:521` 拿到的是**新派发的事件对象** ⇒ `app.js:543` 的 `connectFlow(connection)` 永不被调用。
  - **修法**：意图改走**闭包变量**（`let saveAndConnect` → `const alsoConnect = saveAndConnect` → `if (alsoConnect === true) void connectFlow(connection)`）。回归护栏见 `test/app.test.js`（不得再出现把意图挂到事件对象上的写法），行为闭环由本节验收 P16a（凭据框被拉起）覆盖。
- **D-2（体验级，U0 遗留）：指纹确认后状态栏与横幅不追平。** 连接成功后 host 侧 `state: connected`、xterm 已挂载（163×43）、信任状态已变「指纹已信任」，但状态栏停在**「未连接」**、状态横幅停在**「首次连接，需要核对主机指纹后继续」**，实测 ≥6s 不自行恢复；**刷新页面后恢复正常**。根因：`session.js:106-108` 的 `ready` 帧只调用 `onStatus`（写 `#status-text` 文案），**从不调用 `onFrame`** ⇒ `app.js` 的 `state.live` / `state.frameState` 仍停在 `idle` / `waiting-fingerprint`，随后任何 `renderAll()` 都用旧状态把文案覆盖回去。
  - **修法**：`session.js` 的 `handleControl` 把**每一帧带 `state` 的宿主帧**（`ready` 与 `status`）规范化成 `{ type: 'status', state, … }` **统一前置转发一次**给 `onFrame`，各分支只负责文案（`waiting-fingerprint` 分支原来的那次 `onFrame` 随之删除，避免重复）。回归测试见 `test/session.test.js`（`ready` / `status:connected` 必须喂 `onFrame`；waiting-fingerprint 只转发一次）。

### 16.3 D2 语义边界：hero 态「会话布」——**已按①收口（诚实降级）**

**问题**：hero 态（无会话）下顶栏「会话布」按钮必然失效 —— canvas 只注册在 `conversation.session.header.actions`，hero 态没有会话头 ⇒ 没有 `.dsh-canvas-switch` 可供委托，本线按既有纪律"找不到就收手"，用户看到的是"SSH 关掉、画布没开、回到对话页"（零异常、零报错）。

**用户定向（2026-09-15）**：选 **① hero 态不渲染该段**（本线内，诚实降级）。落地：

- **宿主**（`client.js`）：chrome 消息新增 `canvasAvailable`，判据 = 宿主文档里 `.dsh-canvas-switch` 是否存在（即 canvas 胶囊在不在场）；查询异常时保守为 `true`。**每次 `openOverlay()` 都重发** —— 浮层打开期间用户无法切换会话，所以"这一刻的取值"就是顶栏整个可见期的取值。
- **浮层**（`app.js`）：`applyChrome()` 消费该字段并写进 `overlayState.canvasAvailable`；值变化时**幂等重建**顶栏（`buildTopbar` 先移除已存在的 `#ssh-topbar`）。hero 态只渲染「对话｜SSH」两段，会话态仍是三段。**默认（未收到字段）保持三段** —— 不擅自替别的线减入口。
- **段身份**：按钮带 `data-seg="dialog|canvas|ssh"`，验收与单测按段断言（不再依赖文案顺序）。
- **测试**：`test/client.test.js` 3 例（无胶囊 ⇒ `false`／塞入胶囊 ⇒ `true`／每次打开都重发）、`test/app.test.js` 2 例（段数随字段**双向**变化、重建不叠加、SSH 段仍带 `aria-current`）。

**备选（未采纳）**：② canvas 线补 `shell.overlay` launcher（跨线改动）；③ 记为已知边界不改代码。

### 16.4 环境与通道说明（可复现所需）

- 本机 `dsh web` 由桌面壳 `Miasaki.exe` 拉起（`cmd /C dsh web --no-open`）；其激活 URL 的 token 是**每进程随机、只存在内存**（`PROCESS_LAUNCH_TOKENS` WeakMap），无头浏览器拿不到。
- 验收用 credentials 里持久化的签名 secret **离线签发本机合法会话 cookie**（`dsh-auth-<b64url(sha256(authority))>` 三段式，与 `dsh-client-connection` 同格式）进入真实 GUI；secret 只在内存中使用，**不打印、不写文件、不进日志**。
- 三主题场景：`Page.addScriptToEvaluateOnNewDocument` 注入 desktop 线真产物 `theme-init.js`（等价于 Tauri `initialization_script` 注入所有 frame；其 `IS_TOP` 守卫在 iframe 内照旧生效，浮层里不会长出假窗控）。
- **未改任何产品代码**；用户数据（`~/.dsh/miasaki-ssh/` 的连接库与 known_hosts）由脚本 `finally` 恢复为空库原状（本轮验收前后均为空）。
- 一次性浏览器 profile 每次运行独立并在结束时删除——复用 profile 会被 `localStorage` 记住"上次打开的会话"，导致起点不再是 hero 态（本轮踩过并已修）。


---

## 17. D3 实施记录（2026-09-15，清理与回归一次完成，探针 11/11 全过）

**四张核对清单（对照 §16.4）与落地情况**：

### 17.1 D-3 判空修复（6 处，含同病排查）

`byId(state.selection/activeTab)` 在主机被删后返回 `undefined`，所有 `conn === null` 判空失效。修法统一为 `?? null` 归一化（selection/activeTab 失效 = 未选中）：

| # | 位置 | 触发症状 |
|---|---|---|
| 1 | `renderIdentity` | 读 `conn.group` 抛 TypeError（§16.4-1 原始发现） |
| 2 | `emptyStateNodes` | 读 `conn.label` 抛（同病排查） |
| 3 | `renderStatusbar` | activeTab 失效 → `liveOf(conn.id)` 抛（探针 P4 实测逮到） |
| 4 | `renderBanner` | 同链 |
| 5 | `renderBody` | 同链 |
| 6 | banner「编辑主机」闭包 | 同链 |

回归护栏：`test/app.test.js` 新增「D-3 删选中主机后 renderIdentity / emptyStateNodes 不抛错且归空态」（connections 非空 + selection 指向已删 id 的真实场景）；行为闭环由探针 P4 覆盖（真页面删选中主机 → renderAll 零异常、identity 归「SSH 工作区」）。

### 17.2 删 conversation.view 与 tab 委托三件套

删除清单（client.js，净 -6.6KB）：`conversation.view` 注册块、`SshView` 组件（其主题桥职责已由浮层 iframe 共享桥承担）、`ownHeader/tabButtons/ownTab/hiddenTabs/hideOwnTab/restoreTabs/viewIsSsh/selectSsh`、`selectDefaultView/onDialogClick/bindDialogButton/unbindDialogButton/dismissing`、`sync()` 内 `hideOwnTab()/bindDialogButton()` 调用、文件头注释重写。**保留**：`dismissCanvasOverlay`（浮层互斥与消息协议仍用）、`:has()` 隐藏宽度手柄规则（官方 [data-width-handle] 与本线无关仍存在）。注册面从三项收敛为两项（会话头胶囊 + shell.overlay launcher）。全局搜索 `conversation.view` / 三件套标识符：**零残留**（仅剩 D3 清理说明注释）。

### 17.3 A0 文案

app.js「送往对话」复制成功提示：`切到「对话」粘贴（Ctrl+V）即可` → `点左上「对话」退出后粘贴（Ctrl+V）即可`。全局搜索旧文案：零命中（仅此一处出现）。

### 17.4 响应式四档重校准

`@container`（中栏宽语义）→ `@media`（视口语义），且断点改为**含端点**的 960/720/480——原 959/719/479 在典型宽度恰好等于断点值时错位一档（960 落全宽档、720 落窄档，首轮探针实测暴露）。`.workbench` 的 `container-type` 一并移除。

**四档 + 过渡区间实测**（探针 P2，rail 可见性/宽度/右缘溢出/横向滚动逐档断言）：

| 视口 | 档位 | rail | 溢出/遮挡 |
|---|---|---|---|
| 1280 | desktop | flex 232px | 无 |
| 960 | narrow | flex 208px | 无 |
| 720 | drawer | none（收起） | 无 |
| 480 | compact | none + 可选件隐藏 | 无 |
| 860/600/500（过渡） | — | 落位正确 | 无 |

### 17.5 回归总表

| 项 | 结果 |
|---|---|
| 单测（app/client/session/store） | 81/81（app 12 + client 25 + http 3 + runtime 14 + session 19 + store 8；client 含 D3 清理断言与 D3-F1 回归、app 含 D-3 回归） |
| verify-all ssh | 12/12 |
| D3 探针 | 11/11（四档 4 + 过渡 3 + 零损失 1 + D-3 行为闭环 1 + 连接 1） |

### 17.6 交付说明（变更清单 / 风险 / 回滚）

**变更范围**：`client.js`（删 view 注册 + 三件套 + 头注释重写）、`app.js`（6 处判空 + A0 文案）、`styles.css`（断点视口化 + container-type 移除）、`test/client.test.js`（3 条 D1 回退期断言改写为 D3 清理断言 + 数量修正）、`test/app.test.js`（+D-3 回归）。无 §16.4 之外的夹带改动。

**已知风险**：① 回退路径已不存在——若实机发现浮层形态不可用，只能整体回滚本批次；② `sync()` 的 MutationObserver 仍观察 `aria-selected`（三件套删除后该属性变化不再影响激活态，属无害冗余，留给 D4 观察是否移除）。

**回滚步骤**（可独立执行）：`git log --oneline -- dsh-miasaki-ssh` 找到本批 D3 commit（单 commit），`git revert <commit>` 即完整恢复 D2 收尾形态（含临时无单测断言冲突时可 `--no-commit` 后手工处理）。逐文件回滚：`git checkout <D2commit> -- dsh-miasaki-ssh/client.js dsh-miasaki-ssh/app.js dsh-miasaki-ssh/styles.css dsh-miasaki-ssh/test/`。

---

## 18. D3 实机验收记录（2026-09-15，功能门槛全过；唯一清理残留 D3-F1 已于同日删除闭环 ⇒ 完全达标）

**通道**：与 §16 同一套（真 Edge × **真实 DSH GUI** × 真实鼠标/键盘事件（走 hit-test）× 本地假 sshd 真协议端点）。驱动脚本 `_refs/scripts-archive/ssh-d3-accept/run-d3-accept.mjs`（`node run-d3-accept.mjs` 约 4 分钟可复现；结果 `d3-accept-result.json` + `shots/*.png`）。**不依赖 §17 的实施者探针** —— 验收独立重跑用户可达路径。

### 18.1 门槛结果（8 项：7 PASS / 1 FAIL）

| # | 门槛 | 判据与关键证据 | 结果 |
|---|---|---|---|
| P1 | **四档宽度按视口语义落位**（§7 D3 门槛本尊） | 1280 → rail 232px（全宽档）；**960 → rail 208px（恰好在断点值上落紧凑档** —— 正是 D3 修的「等于断点值时错位一档」）；720 / 480 → rail `display:none` + 抽屉关闭钮在场；**四档均零横向溢出**（`scrollWidth ≤ innerWidth`）；顶栏四档都稳定渲染 | ✅ |
| C1+C2 | 三主题 × 1280/480 两档 | pure / zafkiel / kurkuriel 逐一切换后各测两档：零溢出、顶栏三段稳定、**reserve 消费 `padding-right: 164px`（= 14 + 150）** | ✅ |
| C3 | A0 文案指向「点左上『对话』退出后粘贴」 | 真实点击工具区「送往对话」→「送出最近 40 行」→ 状态栏读出「已复制 99 字符——**点左上「对话」退出后粘贴（Ctrl+V）即可**，首行已标注来源主机。」；剪贴板实读首行 `[SSH d3-accept-local · tester@127.0.0.1:2231] 这是终端的最近输出：` ⇒ 文案与格式双向对齐 | ✅ |
| C4b | 官方 tab 栏不再被本线触碰 | 宿主 `[role="tab"]` 列表中**无 SSH**（回退视图已删，第二行不再出现本线 tab） | ✅ |
| C4c | 官方列宽手柄回归原样 | 进入会话态（真实点击左栏历史会话）后查得 2 个 `[data-width-handle]`，`display: block` ⇒ 本线未再隐藏官方手柄 | ✅ |
| P2 | 真实连接就绪（A0 前置） | 真协议连上：`status: 已连接`、xterm 挂载（163×43）、host 侧 `connected` | ✅ |
| P5 | 回退视图面零残留 | `.dsh-ssh-view = 0`、`.dsh-ssh-bar = 0`（D1 临时退出条）、`.dsh-ssh-host = 1`（浮层宿主） | ✅ |
| **C4a** | **注入样式零 hack（`grep` 应无命中）** | **FAIL**：client.js 注入的样式里仍有 `div[data-phase]:has(iframe[title="SSH"]) [data-width-handle]{display:none!important}`（+ 5 行注释），样式表长度 2758 | ❌ |

### 18.2 发现项 D3-F1（注入样式残留**死规则** —— 已于同日删除闭环）

- **现象**：`client.js:71` 仍注入 `div[data-phase]:has(iframe[title="SSH"]) [data-width-handle]{display:none!important}`（配 L64–70 注释）。
- **判定：死代码，零运行时行为**。论证：该规则的前提是「SSH 的 iframe 挂在 `div[data-phase]` 内」——那是**回退视图**（`conversation.view`）的 DOM 形态；§17.2 已把 view 注册与 `SshView` 组件整体删除（全仓 `SshView` 零命中），浮层形态下 SSH iframe 在 `body > .dsh-ssh-host > .dsh-ssh-overlay` 内 ⇒ `:has()` **永不命中**。实测反证：C4c 在会话态读到官方手柄 `display: block`，说明本线没有隐藏它（浮层关闭时手柄本就该在）。
- **为什么仍算未达标**：§8 C 组第 4 条的判据是「相关 hack **已删**，`grep` 应无命中」——`§17.2` 的清理清单里把它列为「保留」，与验收矩阵冲突。属**判据与实施的口径分歧**，不是功能缺陷。
- **处置（用户定向「现在就删」，2026-09-15）**：删除 `client.js` 该规则与旧注释（替换为一段说明"为何删除"的注释，**不含 `width-handle` 字面量** ⇒ 全局 grep 零命中）；两条把它锁成"保留"的旧断言同步改写 —— D3 清理断言改为「死规则零残留」、2026-09-12 那条改为「官方列宽手柄不再被本线触碰」；另新增一条回归断言（注入样式表零 `width-handle` + **相邻规则链完整性**：合体胶囊 / 浮层 / `is-closed` 隐藏策略 / launcher 四条仍在 —— 删的是拼接链中间一环，拼错会静默丢掉后续样式）。单测 80 → **81 例**、`verify-all ssh` **12/12**。
- **代价**：**无需为它单独重启 host** —— 规则不参与任何运行时行为，静态证据（零残留 + 规则链完整性）已足，删除后由下一次 host 重启自然生效。

### 18.3 本轮未覆盖（留待 D4 或后续）

- **三过渡区间**（860 / 600 / 500）未复验：实施者探针 §17 覆盖过，本轮只跑了四个典型档位。
- **`sync()` 的 MutationObserver 仍观察 `aria-selected`**（§17.6 已记录为无害冗余）—— 与 D3-F1 同类，属清理尾项。
- **可选清理**（§16.4-3）：`renderBanner()` 隐藏时未清空横幅内容。

### 18.4 验收判定

**D3 功能门槛全过**（四档宽度视口语义重校准、三主题 × 两档、A0 文案、官方 tab 栏与列宽手柄回归原样、回退视图面零残留、真实连接链路）；**清理门槛的唯一未达标项 D3-F1 已于同日删除闭环** ⇒ **D3 完全达标**。删除的实机生效随下一次 host 重启自然发生（死代码，无行为差异）。

**环境与纪律**：全程未改产品代码；用户数据（连接库 / known_hosts）由脚本 `finally` 恢复为空库原状；一次性浏览器 profile 用后即删。


---

## 19. D4 实施记录（2026-09-15，D3 验收三项尾项一次清掉，探针 10/10 全过）

### 18.1 三项尾项闭环清单（对照 §16.4-3 / §17 已知风险）

| # | 尾项 | 代码位置 | 验证证据 | 状态 |
|---|---|---|---|---|
| ① | renderBanner() 隐藏时未清空横幅内容 | app.js renderBanner() 入口：`banner.hidden = true` 后追加 `banner.replaceChildren()`（隐藏态 = 空容器；显示态由 bannerNode() 完整重建，二者互不干扰） | 单测新例「D4 renderBanner 隐藏时清空横幅内容，再显示时重建」三段行为闭环（显示 3 节点 → 隐藏 children=0/text='' → 重建 3 节点）；运行态探针 P2 同判据实测：shownChildren=3 → hiddenChildren=0/hiddenText='' → reshownChildren=3 | ✅ |
| ② | sync() MutationObserver 仍观察 aria-selected | client.js SshSwitch useEffect：`observer.observe(header, { childList: true, subtree: true })`（attributes/attributeFilter 整组移除，childList 监听保留——激活态同步语义不变） | 全局检索 aria-selected：产品码零残留（仅 D4 说明注释）；单测既有 doesNotMatch 断言锁死；运行态探针 P3：aria 属性翻转 + 开关循环零异常、激活态稳定 | ✅ |
| ③ | 三过渡区间（860/600/500）复验 | 无代码变更（复验项）。**口径说明**：860/600/500 是**视口宽度 px**（D3 验收的过渡区间档位），非 goal 假设的毫秒——按 D3 验收记录口径执行 | 探针 P4：860 → narrow（rail 208px）、600 → drawer（收起）、500 → drawer（480 紧凑未触发），另加 1280/480 首尾档对照；全部零横向溢出、零遮挡、零异常 | ✅ |

### 18.2 回归总表

| 项 | 结果 |
|---|---|
| 单测（app/client/session/store） | 82/82（app 13 含尾项①行为闭环三段断言 + client 25 + http 3 + runtime 14 + session 19 + store 8；原写 65/65 为沿用旧基线的笔误，验收时实测校正） |
| verify-all ssh | 12/12 |
| D4 探针 | 10/10（尾项①运行态 1 + 尾项②运行态 1 + 尾项③过渡 5 + 零异常 1 + 零损失 1 + 连接 1） |

### 18.3 回滚与影响面

三项修复各自独立、互不依赖，可单独 revert：

| 修复 | 文件 | 影响面 | 回滚 |
|---|---|---|---|
| 尾项① | app.js renderBanner() | 仅状态横幅渲染路径（显示/隐藏互不影响） | revert 对应 commit；旧行为（隐藏留内容）无功能损害 |
| 尾项② | client.js SshSwitch useEffect | 仅入口胶囊激活态同步的触发面（childList 保留，语义不变） | revert 对应 commit |
| 尾项③ | 无代码变更 | 只读复验 | 不适用 |

**探针基建记录**：run-d4 驱动两处笔误（Cdp.on 变量名、P3 空值判断在无 header 的桩页失效）属测试脚本问题，产品码无涉。

---

## 20. D4 实机验收记录（2026-09-15，6 项门槛全 PASS）

**通道**：同 D2/D3（真 Edge × **真实 DSH GUI** × 真实鼠标/键盘事件（走 hit-test）× 本地假 sshd 真协议端点）。驱动脚本 `_refs/scripts-archive/ssh-d4-accept/run-d4-accept.mjs`（约 4 分钟可复现；结果 `d4-accept-result.json` + `shots/*.png`）。**尾项①与②都取运行态证据**，不采信静态断言 —— 这是 D1/D2/D3 三次「判据本身会骗人」教训的延续。

### 20.1 门槛结果（6/6 PASS）

| # | 门槛 | 判据与关键证据 | 结果 |
|---|---|---|---|
| P2 | **尾项①：`renderBanner` 隐藏即清空** | 真实连接流程逐帧采集横幅状态：可见态 `hidden:false / display:flex / childCount:3`（图标 + 文案 + 「核对指纹」按钮）→ **连接完成后 `hidden:true / display:none / childCount:0`**。旧实现只设 `hidden`，那 3 个节点会留在 DOM（含 onclick 闭包引用） | ✅ |
| P2b | 尾项①补充：**清空后仍能重建** | 断开连接后横幅再次出现且 `childCount:4`（文案 + 「编辑主机」/「重新连接」两个按钮）⇒ 清空逻辑没有把横幅功能弄坏 | ✅ |
| P3 | **尾项③：过渡区间落位** | 1280 → rail 232px（全宽档）/ 860 → rail 208px（紧凑档 721–960）/ 600 → 抽屉（rail 消失）/ 500 → 抽屉且 `.tools .optional` **可见**（480 档未触发）/ 480 → 抽屉且 `.tools .optional` **隐藏**（480 档命中）；**五档零横向溢出** | ✅ |
| P5 | **尾项②运行态：观察面缩小后行为不变** | 30 次开关浮层：**零 JS 异常**、iframe 未重载（window 标记存活）、远端**零 resize 帧** | ✅ |
| P4 | D3-F1 实机复核 | 注入样式长度 2674、**零 `width-handle`** ⇒ host 已加载删除后的 client.js | ✅ |
| P0 | 前置 | 浮层经 hero launcher **真实点击**打开 | ✅ |

### 20.2 静态侧证据（与运行态互补）

- `observer.observe(header, { childList: true, subtree: true })` —— `attributes` / `attributeFilter` 整组已移除；
- `aria-selected` 在产品码里**只剩一条 D4 说明注释**（零消费者）；
- `data-width-handle` 全仓 grep **零命中**。

### 20.3 例数校正（第二次同类笔误）

§19 与 CHANGELOG 第七批写的「单测 65/65」是**沿用旧基线的笔误**：实测为 **82 例**（app 13 + client 25 + http 3 + runtime 14 + session 19 + store 8），`verify-all ssh` **12/12**。已在两处就地校正。教训：**例数必须现跑现抄**，跨批次复制极易带上过期基线（D2 轮我也犯过一次 63→70 的同类错误）。

### 20.4 判定

**D4 完全达标** —— 三项尾项（横幅清空 / 观察面收窄 / 过渡区间复验）全部闭环且经运行态复核。

**环境与纪律**：未改产品代码；用户数据（连接库 / known_hosts）由脚本 `finally` 恢复为空库原状；一次性浏览器 profile 用后即删；验收期间**零 JS 异常**。
