# 会话头部在右栏展开时被挤压重叠 —— 归因与修复方案设计

- 日期：2026-09-10
- 触发报告：用户截图（288×44 裁剪）——「展开右侧边栏会挤压」，可见「对话 / 会话布」分段控件被
  文件夹图标压住、会话标题消失
- 主责线：canvas（控件宽度贡献方）；平台层兜底归属 desktop 线 `patches/`
- 状态：**已实施**（2026-09-10，用户拍板「canvas 自适应 + 平台层溢出保护补丁」两条都做）
  - canvas：`ViewSwitch` 运行时降级（`ResizeObserver` 观察 header + 进入/退出滞回），
    测试 `test/header-adaptive.test.js` 4 项，全量 83 项全绿
  - desktop：新增本体补丁 [`patches/dsh-client-ui-conversation`](../../dsh-miasaki-desktop/patches/dsh-client-ui-conversation/README.md)，
    1 条 CSS 片段替换，`verify` 离线自证已并入 `verify-all.mjs desktop`
  - 现场佐证：用户拉宽窗口后重叠消失、标题回归 ⇒ §3 的宽度归因成立
  - 待实机复验：右栏展开时切换器收成图标且标题至少可见；拉宽后自动恢复完整形态

## 1. 现象

浏览器环境、会话已选中、官方右侧边栏展开后，会话头部（`conversation.session.header`）一行内的控件互相重叠：
canvas 的「对话 / 会话布」分段控件被右侧的图标按钮与下拉压住，文字被遮挡；**同排的会话标题完全不见**。

## 2. 已核实的现场事实

### 2.1 头部两个 list 槽的实时占用者

| 槽 | 占用者（id @ order） | 归属 |
|---|---|---|
| `conversation.session.header.actions` | `agent-preset` @ -10、`job-list` @ 20、**`canvas-view-switch` @ 25** | 官方 ×2 + **canvas** |
| `conversation.session.header.utilities` | `open-in-app` @ -10、`session-log-download` @ 0 | 官方 ×2 |
| `conversation.session.header.corner` | （空） | — |

`canvas-view-switch` 由 `dsh-miasaki-canvas/client.js` 的 `ViewSwitch` 注册，就是截图里的「对话 / 会话布」。

### 2.2 官方头部的结构与 CSS（`@deepseek-ai/dsh-client-ui-conversation`）

```
<header class="header">                      padding:10px 28px 0 20px; min-height:76px; border-bottom:.5px
  <div class="titleRow">                     display:flex; align-items:center; gap:0; min-height:30px
    <div class="titleCluster">               flex:1; min-width:0; gap:10px; display:flex   ← 可收缩
      <nav class="crumbs">                   min-width:0; overflow:hidden; white-space:nowrap ← 标题可裁
      <div class="headerActions">            flex:none; gap:8px; display:flex                ← 不收缩
    </div>
    <div class="headerUtilities">            flex:none; margin-left:20px; gap:8px            ← 不收缩
    <div class="headerCorner">               flex:none; margin-left:8px; margin-right:-16px  ← 不收缩
  </div>
  {视图 tab 行：tabs.length > 1 时渲染}
</header>
```

### 2.3 排除项

- **sidebar 线残留推挤**：`pushFrame` / `pushClear` 只剩定义、**全文件无调用点**；常驻 CSS 规则
  `padding-right:var(--miasaki-sidebar-width,0px)` 的变量迁以后无人写入，缺省 `0px` —— 不参与本次现象。
- **右栏自身**：官方右栏占 grid 第三列并由框架让轨（`ctx.layout.openRightbar(track)`），中栏变窄是设计行为，
  不是缺陷来源；缺陷在于**中栏变窄后头部的降级策略缺失**。

## 3. 根因

`titleRow` 是一行 flex，其中 `headerUtilities` 与 `headerCorner` 是 `flex:none`（宽度固定、不可压缩），
`titleCluster` 是 `flex:1; min-width:0`（可以一路压到 0）。当

```
中栏内容宽 W  <  U(utilities) + C(corner) + A(headerActions)
```

时：`titleCluster` 被压到 **0 宽**，而其内部的 `headerActions` 是 `flex:none` —— 它不缩小，只能**溢出**
`titleCluster` 的边界。此时 `titleCluster` 左边缘与 `headerUtilities` 起点重合（x≈0），两者于是在同一位置绘制，
DOM 顺序靠后的 utilities 覆盖在上层 —— 这就是截图里「文件夹图标压住『会话布』」的形态。

**截图自证**（三处吻合，非猜测）：

1. 会话标题消失 —— `crumbs` 是 `min-width:0; overflow:hidden`，被裁到 0；
2. 控件从头部最左侧开始画 —— `titleCluster` 宽 0，actions 从 x≈0 溢出；
3. `…` 按钮仍在最右 —— `headerCorner` 是 `flex:none`，始终保留自己的固定宽度。

### 3.1 宽度预算（按官方与 canvas 现有 CSS 估算）

| 项 | 估算宽 |
|---|---|
| header 左右内边距（20 + 28） | 48 |
| `agent-preset`（图标 + 「创造模式」） | ~95 |
| `job-list`（图标钮） | ~32 |
| **`canvas-view-switch`**（padding 3×2 + border 1×2 + gap 2 + 按钮 46/58 + margin-left 2） | **~116** |
| actions 内 gap（8 × 2） | 16 |
| `headerUtilities`（2 个图标钮 + gap 8 + margin-left 20） | ~84 |
| `headerCorner`（margin-left 8 + 图标 28 + margin-right −16） | ~20 |
| **固定项合计** | **~411** |

结论：**中栏窄于 ≈410px 时必然重叠**；窄于 ≈530px（给标题留 ~120px 可读宽度）即开始明显挤压。

canvas 的 116px 让坏点显著提前，但**即使没有 canvas**，官方自身（agent-preset + job-list + utilities + corner
≈ 295px）在中栏足够窄时同样会重叠 —— 这是平台层的溢出保护缺失。

## 4. 候选修复方案

### 方案 A —— 平台层溢出保护补丁（治本，desktop 线 `patches/`）

对 `@deepseek-ai/dsh-client-ui-conversation` 的编译产物做一处 CSS 覆写：

- **A1 裁剪**：`.titleCluster` 加 `overflow:hidden` → 溢出变为裁剪，**不再压叠**，但 canvas 控件会被裁掉一部分；
- **A2 可滚动（推荐）**：`.headerActions` 改 `flex:0 1 auto; min-width:0; overflow-x:auto; scrollbar-width:none`
  → 空间不足时 actions 自行横向滚动，控件始终可达，且不再压叠；
- **A3 换行**：`.titleRow` 加 `flex-wrap:wrap` → actions 掉到第二行；会改变头部高度（`min-height:76px`、tab 行位置），
  视觉改动最大，不建议。

- 归属与流程：沿用现有机制（先例 `dsh-miasaki-desktop/patches/dsh-client-ui-settings-models/`：`patch.mjs` +
  `baseline/` + `verify`）。补丁按 **CSS 片段原文**匹配而非 hash 类名（`wSkVaW_` 前缀随版本会变）。
- 优点：一次修根因，任何插件再往 actions 塞控件都不会压叠。
- 代价：改动 DSH 本体，升级后需重打（已有流程与自证要求）；A2 需要额外的滚动条隐藏样式。

### 方案 B —— canvas 侧自适应降级（治本，canvas 线）

`ViewSwitch` 在窄宽度下切换为紧凑形态，把 116px 压到 ~64px（两个图标钮）或 ~32px（单个下拉）：

- 判据（**运行时自适应，不硬编码窗口/中栏宽度**）：`ResizeObserver` 观察 **`el.closest('header')`**
  —— 不能观察自身，自身是 `flex:none`，被挤压时宽度不变，观察不到溢出。回调里做**溢出检测**：
  取自身与 `headerUtilities` / `headerCorner` 的边界矩形，若自身右边界越过可用区或与相邻控件矩形相交，
  即切紧凑形态（判定抽为纯函数，便于单测）；
- 固定阈值只作**快速路径**：`阈值 = 完整形态下实测的需求宽 + 余量`（本机按 §3.1 估算 ≈ 530px），
  实测刷新、不写死，主题 / 字号 / 语言变化后依然成立；
- 形态：两个 28px 图标钮（保留 `aria-label` / `aria-pressed`），会话布态用实心图标区分；
- 生命周期：`ResizeObserver` 在组件卸载时 `disconnect()`（现有 `useEffect` 清理链里补）。

- 优点：不动本体、升级零成本；canvas 自己的控件自己负责；图标形态在窄宽度下仍可点。
- 代价：只解决 canvas 一个控件；其他插件若塞控件仍会挤压（需 A 兜底或各自自律）。

### 方案 C —— 交互层迁移（不推荐，记录备查）

窄宽度时把 canvas 切换器并入 `headerCorner` 的 `…` 菜单：官方**没有**「actions 折叠」扩展点，
只能靠 canvas 自己渲染一个溢出菜单，等于把 B 的降级形态换成菜单，复杂度更高、可发现性更差。

### 方案 D —— 约束右栏宽度（否决）

把官方右栏推挤宽度卡在中栏可承受范围内：右栏宽度由官方控制器持有，第三方插件**没有读接口也没有写接口**
（0.1.5 只暴露 `openRightbar(track, fullscreen)` / `closeRightbar()`），无法实现；且违背「官方能力优先」的既定路线。

## 5. 推荐

**B 为主 + A2 兜底**：

1. canvas 侧自适应（B）—— 直接消除本次现象，让 canvas 控件在窄宽度下仍可用；
2. 平台层 A2 —— 保证「任何插件 + 任何窄宽度」都不再出现压叠这种不可用状态（溢出退化为可滚动）。

若用户不希望引入新的本体补丁，则**只做 B**：本次现象消除，但平台层的压叠风险仍在（其他插件或更窄的窗口会复现）。

## 6. 实施顺序（拍板后）

| 步骤 | 内容 | 线 | 验收 |
|---|---|---|---|
| 1 | canvas `ViewSwitch` 加 `ResizeObserver` + 紧凑形态 + 阈值常量 | canvas | 单测（阈值判定纯函数）+ 实机 |
| 2 | `patch.mjs` 对 conversation 包做 A2 覆写 + `baseline/` + `verify` | desktop | `node patch.mjs verify` 自证 |
| 3 | 两线的静态回归与文档同步（README / design/CHANGELOG） | canvas + desktop | `verify-all` 通过 |

## 7. 验证矩阵

窗口宽度 × 左栏 × 右栏（离线复现页 + 实机各跑一遍）：

| 场景 | 期望 |
|---|---|
| 1440 / 左栏展开 / 右栏关 | 完整形态，无重叠，标题完整 |
| 1440 / 左栏展开 / 右栏展开 | 无重叠；宽度够时完整形态 |
| 1280 / 左栏展开 / 右栏展开 | canvas 切换器降级为图标形态（或 actions 可滚动），标题至少可见 |
| 1100 / 左栏收起 / 右栏展开 | 无重叠；所有控件仍可达 |
| 任一场景 | `crumbs` 与 actions **边界矩形不相交**（可脚本断言） |

离线复现页：用官方 `wSkVaW_*` CSS 与真实结构 + canvas 的 `.dsh-canvas-switch` CSS 复刻 header，
用 Playwright 无头在多个宽度下断言「控件边界矩形两两不相交」——作为不依赖真机的回归手段。

## 8. 待确认参数

1. **窗口拉宽后重叠是否消失** —— 现场佐证 §3 的宽度归因（方案 B 已改为运行时自适应，不依赖该参数也能实施）；
2. **是否接受引入新的 DSH 本体补丁**（决定 A2 做不做）；
3. 触发时的窗口宽度与右栏宽度（仅用于校准 §3.1 的宽度预算表）。

## 9. 后续：同一行的**垂直**基线（2026-09-10 深夜，已修）

横向压叠修完后，用户报告「展开右侧边栏是对齐的，收起时不在同一水平线」。对两张截图逐控件
做像素切分（连通列分组 + y 范围）量出的垂直中心：

| 状态 | 会话头侧控件 cy | 窗控组 cy |
|---|---|---|
| 收起 | open-in-app **21.5** / 日志菜单 **22.0** / 右栏钮 **22.0** | 徽章 **17.5** / 三键 **18.0** |
| 展开 | 全屏 **20.0** / 收起 **20.0** | 徽章 **19.5** / 三键 **20.0** |

差的 4px 里 **3px 是本线的锅**：`.dsh-canvas-switch` 总高 36px 把官方 `titleRow`
（`min-height:30px`）撑到 36px，行内**所有**控件（含官方那三个）居中后整体下移
(36−28)/2 = 4px（相对 30px 基准即 3px），而 `position:fixed` 的桌面窗控不跟着动。
已把胶囊总高收敛到 **30px**（`padding:3px` → `padding:0 3px`），并加单测锁住「上下 padding
必须为 0」。余下 **1px** 是官方 `titleRow`（中心 25px）与窗控 / dockkit chrome（24px）的
固有差，由 desktop 线在常驻 CSS 里补 `top:-1px`，本线不介入。

**与 §3 合起来是同一课**：插件往官方行内塞控件，**宽度**超标会横向压叠，**高度**超标会把整行
撑高、连带把**别人的**控件一起顶偏。两个维度都要有契约，而且高度契约同样得写进测试——它破坏
时受害的是同行的其他控件，不是自己。
