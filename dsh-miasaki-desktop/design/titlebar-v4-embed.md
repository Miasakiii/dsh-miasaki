# 标题栏 v4：窗控去胶囊化 · 嵌入右上角（设计方案）

> 状态：**A 已实施并真机验收收官（2026-09-06）**——无壳裸键路线满意即收尾，A+（几何嵌入）与
> B（官方 Slot 真嵌入）留作 roadmap 不再实施（验收记录见 `design/CHANGELOG.md` 2026-09-06 条目）
> 承接：标题栏 v1 → v2 → v2.1 → v3 演进（历史见 `design/CHANGELOG.md` 2026-08-23 ~ 2026-09-05 各条）
> 关联现状：`design/ARCHITECTURE.md` §6 已知约束（v3 零占位叠加）

## 1. 目标

- **主目标**：去掉右上角悬浮胶囊外壳（半透明圆角底 + 毛玻璃 + 徽章包裹），窗控三键
  （最小化/最大化/关闭）以「裸键」形态直接落在窗口右上角，观感接近标准无边框应用的
  标题栏按钮。
- **不变约束**（v3 既定，本方案不突破）：
  - 不修改 DSH 本体；零布局侵入（页面 y=0 起渲染，顶部控件与 web 端同位置）；
  - 远程页无 IPC 权限（capability 只授 `start-dragging`），窗控命令走 URL hash → Rust；
  - Win11 Mica 底座 + 三主题（pure/zafkiel/kurkuriel）令牌化；
  - 拖动 / 双击最大化 / 关闭确认弹窗 / 最大化状态同步链路行为不变。

## 2. 现状速览（v3 胶囊机制）

| 关注点 | 现状 | 位置 |
|---|---|---|
| DOM | `#miasaki-titlebar`（fixed、height:0、`pointer-events:none`）> `.tb-capsule`（fixed `top:5px; right:8px`）> 徽章 img + `.tb-btn`×3 | `themes/src/06-titlebar.js` `buildTitlebar()` |
| 胶囊壳样式 | 半透明 `--ms-panel` + `backdrop-filter:blur(12px)` + 圆角 999px + 边框，hover 变实色 | `themes/src/03-switcher.js` SWITCHER_CSS 标题栏段（50–75 行） |
| 按钮样式 | 26×26 命中区、10×10 视口 SVG 线图标、hover 底 + 关闭 hover 红底 | 同上（66–75 行） |
| 页面让位 | `#root header:has([role="tablist"]){padding-right:132px}`（胶囊实测 ≈114px + 余量） | `03-switcher.js` 78 行 |
| 命令链 | hash `cmd=min/max/close` → Rust watchdog；max 状态经 `wv.eval` 派发 `miasaki-max-state` 回推 | `06-titlebar.js` + `src-tauri/src/main.rs` |
| 拖动 | document 级 mousedown，顶部 36px 空白 → `start_dragging`；事件路径含 `#miasaki-titlebar` 即放行点击 | `06-titlebar.js` `wireDragZone()` |
| 主题变量 | `--ms-panel/--ms-accent/--ms-danger/--ms-hover/--ms-border/--ms-text` 定义于三主题 CSS（`:root` 主题选择器内） | `themes/{pure,zafkiel,kurkuriel}.css` |

## 3. 总路线

```
A（无壳裸键，先行）──真机验收──► 满意即收尾
        │ 不满足「悬浮感」
        ▼
A+（几何嵌入：对齐会话头部行）──真机验收──► 满意即收尾
        │
        ▼
B（真·布局嵌入：官方 Slot，roadmap，需重新立项评估）
```

## 4. 方案 A：无壳裸键（推荐先做）

### 4.1 设计要点

- 删除胶囊壳（背景/边框/圆角/`backdrop-filter`/box-shadow/padding），保留
  `position:fixed; top:5px; right:8px` 的裸按钮组；hover 底色保留在单按钮上
  （现状 `.tb-btn:hover` 已是 Win11 风格，无需新增）。
- **徽章去向：保留为按钮组左侧小圆图标（默认）**。理由：
  1. 启动页（`ui/loading.html`）没有右下角主题切换条，徽章是其唯一的主题标识；
  2. 保留徽章后按钮组宽 ≈108px，与胶囊 114px 接近，让位宽度只小幅收窄，叠压风险最小。
  备选（用户可改主意）：整体移除徽章，让位收窄到 96px，视觉更纯粹。
- DOM 类名 `tb-capsule` → `tb-group`（语义化；改名不影响拖动排除——排除靠
  `#miasaki-titlebar` id，不靠类名；`05-sensors.js` 也只按 id 排除）。

### 4.2 改动清单

| 文件 | 改动 |
|---|---|
| `themes/src/06-titlebar.js` | `buildTitlebar()` 内 `tb-capsule` → `tb-group`；徽章 img 保留（尺寸类名不动，CSS 里调） |
| `themes/src/03-switcher.js` | 标题栏样式段（50–78 行）：`.tb-capsule` → `.tb-group`，删除壳样式；徽章 18→16px、`margin:0 3px` → `0 4px`；让位 `132px` → `118px`（移除徽章方案则 `96px`）；`prefers-reduced-motion` 段同步类名 |

**不动清单（方案 A 零行为变更，回归重点）**：
- 拖动判定与 36px 命中区（按钮组仍在 `#miasaki-titlebar` 内，排除逻辑自动生效）；
- hash 命令链与关闭确认弹窗（`07-dialog.js`）；
- 最大化状态同步（`miasaki-max-state` / `want-max` / 1s 巡检 + 10s 重推）；
- `#miasaki-titlebar{pointer-events:none}` + `#miasaki-titlebar>*{pointer-events:auto}` 结构；
- 分片机制（改动落在既有分片 03/06 内，不动 `MANIFEST.json`、`build-init.mjs`）。

### 4.3 宽度核算（真机复核基准）

- 保留徽章：16 + 4×2 + 26×3 + gap 2×3 = 108px → 让位 = 108 + 8 + 2 余量 ≈ **118px**
- 移除徽章：26×3 + 2×2 = 82px → 让位 ≈ **96px**

## 5. 方案 A+：几何嵌入（A 不满意「悬浮感」时追加）

### 5.1 设计要点

在 A 的裸键组基础上，把按钮组**垂直居中对齐到会话头部行**（让位区所在行），观感从
「浮在右上角」变为「标题栏右侧的按钮」。

- 新函数 `syncTitlebarGeometry()`（放 `06-titlebar.js`）：
  1. `querySelector('#root header:has([role="tablist"])')` 取 `getBoundingClientRect()`；
  2. `top = header.top + max(0, (header.height - 26) / 2)`，clamp 下限 4px；
  3. 写入按钮组 `style.top`（覆盖 CSS 的 `top:5px` 默认）。
- 触发点：`ResizeObserver(header)`（覆盖 DSH 头高度变化/断点）+ `window.resize` +
  挂在现有 1s 巡检里兜底（巡检已重建标题栏，顺带重算几何）。
- 回退：header 不存在/不可见（本地 `loading.html`、hero 页、DSH 升级后选择器失配）
  → 固定 `top:5px`（= A 的默认行为）。回退静默，不影响窗控可用性。
- 水平定位不变（`right:8px` 相对视口；侧栏收起/展开只影响 header 左缘，不影响右对齐）。

### 5.2 改动清单

| 文件 | 改动 |
|---|---|
| `themes/src/06-titlebar.js` | 新增 `syncTitlebarGeometry()`（约 30 行）；`buildTitlebar()` 尾部与 1s 巡检（在 `08-ready.js` 的巡检回调处调用，或函数内部自挂 RO）接线 |
| `themes/src/03-switcher.js` | `.tb-group` 的 `top` 作为默认值保留，无需改 |

### 5.3 风险增项

- 新增一层对 `#root header:has([role="tablist"])` 几何的依赖（选择器本身 v3 已锚定，
  本方案只读几何、错位有兜底，风险可控）；
- 头部行高在窄窗口/断点下变化时按钮跟随——RO 已覆盖；验证点加入「窄窗」用例。

## 6. 方案 B：真·布局嵌入（roadmap，暂不实施）

### 6.1 依据（已核实官方 Slot 目录）

- `conversation.session.header.utilities`：**list**，`scope: session`，右对齐会话工具区、
  升序排列，`replaceRisk: none`；registration = `{ id, order, label }`。
- 桌面端已有三个 DSH web profile bundle 插件（`plugins/dsh-{free-model-pool,pet-panel,token-monitor}`），
  基础设施（`cordis.patch.yml` + `dsh.profile.bundles` 挂载）现成可复用。

### 6.2 目标形态

- 客户端 React 组件注册进该 Slot（`order` 取大值排最右），三键成为 header 布局流内元素，
  React 自动排列，**删除 132px CSS 让位 hack**；
- 命令链复用：点击 → `history.replaceState` 写 hash `cmd=min/max/close` → Rust watchdog
  （与 `dsh-pet-panel` 同链路）；max 状态监听 `miasaki-max-state` CustomEvent，挂载时发
  `cmd=want-max` 请求重推；
- 降级：无 `window.__MIASAKI_BOOTED__`（普通浏览器）返回 null 不注册。

### 6.3 开放问题（立项时决策）

1. **双实现兜底**：Slot 是 `scope: session`，无会话 hero 页没有该 Slot；本地
   `loading.html` 不加载 DSH 插件。这两处仍需注入层无壳窗控（A/A+ 产物复用）。
   注入层需检测插件已渲染窗控（DOM 探针）时跳过自身构建，避免双份按钮。
2. **首屏时序**：插件挂载晚于注入层，DSH 页窗控出现晚一拍；loading→DSH 切换瞬间
   是否有空窗期需实测。
3. **Slot 稳定性**：官方 API 虽比 CSS 选择器稳，仍随 DSH 版本复核（verify-themes 扩展）。
4. **两套实现一致性**：SVG 图标常量、主题令牌变量、hover 形态需共用同源定义。
5. 成本判断：为「真嵌入」引入插件 + 兜底双实现，复杂度高于 A/A+；**等 A/A+ 真机反馈
   再决定是否立项**。

## 7. 风险与验证

### 7.1 风险清单

| # | 风险 | 缓解 |
|---|---|---|
| 1 | 让位收窄后与右上角「Session 日志/工具」按钮叠压（v3 初版 104px 有过叠压教训） | 真机截图核对；让位宽度保留 ≥8px 余量 |
| 2 | DSH 升级改变 header 结构/选择器 | 沿用 `verify-themes` 复核机制；A+ 有 top 兜底 |
| 3 | 去壳后按钮在亮色主题（kurkuriel）下对比度不足 | 保留 hover 底色 + 图标走 `--dsw-alias-label-secondary` 令牌；pure 主题复核 |
| 4 | 拖动判定误吞/漏放右上角 | 按钮组仍在 `#miasaki-titlebar` 内，回归双击最大化与按钮点击 |
| 5 | 启动页画面统一 | loading.html 与 DSH 页共用同一构建函数，天然一致；截图复核 |

### 7.2 验证清单（每阶段真机执行）

- [ ] 三键裸置右上角，hover 单键底色正常、关闭键 hover 红底正常；
- [ ] 右上角 Session 日志/工具等按钮无叠压（三主题 × 窗口最小宽度）；
- [ ] 三键点击 = 最小化/最大化（图标随状态切换，含 Win+↑、双击标题栏）/关闭确认弹窗；
- [ ] 顶部 36px 空白拖动 + 双击最大化不变；按钮区内按下不触发拖动；
- [ ] 启动页（loading.html）窗控同形态可用；
- [ ] 最大化状态同步（点击按钮 / 系统路径 / 重开窗口）；
- [ ] （A+ 追加）窗口缩放、侧栏收起展开、窄窗断点下按钮始终对齐头部行；
- [ ] 三主题 + pure 兜底全过一遍，`npm run verify` 与 `npm run gen-init` 无告警。

## 8. 实施步骤

> 已执行完毕（2026-09-06）：步骤 1（A）实施 → 真机过验证清单全过 → 步骤 2 收尾
> （README / CHANGELOG 同步）；用户对 A 满意，A+ 与 B 不再实施，留作 roadmap（§5/§6）。

1. **A**：改 `06-titlebar.js`（DOM 类名/徽章）→ 改 `03-switcher.js`（壳删除 + 让位 118px）
   → `npm run gen-init` → `npm run tauri dev` 真机过验证清单 → 截图确认。
2. 用户满意 → 收尾：README「标题栏 × 主界面一体化」段（84–98 行）与
   `design/CHANGELOG.md`（新条目「标题栏 v4:窗控去胶囊化」）同步更新，提交清单交用户。
3. 不满意「悬浮感」→ **A+**：`06-titlebar.js` 加 `syncTitlebarGeometry()` → 复跑验证清单。
4. **B**：记录于本文档 §6 作为 roadmap；待 A/A+ 稳定后单独立项（含 §6.3 决策）。

## 9. 决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| 路线 | A → A+ → B | 由浅入深，每步有真机验收门；B 复杂度收益比待观察 |
| 徽章 | 默认保留于按钮组左侧（16px 小圆） | 启动页无切换条，徽章是唯一主题标识；宽度与现胶囊接近，风险最小 |
| 类名 | `tb-capsule` → `tb-group` | 语义准确；全仓仅 03/06 两分片引用，改名成本极低 |
| 让位 | 132px → 118px（保留徽章）/ 96px（移除） | 按 4.3 核算 + ≥8px 余量 |
| B 时机 | roadmap，不随本方案实施 | slot 为 session scope 需双实现兜底，复杂度高 |
