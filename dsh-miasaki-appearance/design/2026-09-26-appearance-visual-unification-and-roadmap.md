# 外观设置页：视觉统一（对齐官方设计语言）+ 功能完善路线

- 日期：2026-09-26
- 范围：`dsh-miasaki-appearance/`（client 半面板为主，含功能 roadmap）
- 触发：用户「外观设计页现在不够美观，和 dsh 设置页面的设计语言不够统一。功能也不完善，
  准备推进，看一下怎么弄」。
- 前序：[2026-09-26 对照去重](2026-09-26-appearance-page-dedup-and-roadmap.md)（明暗/字号已移交
  官方「通用」页，本文接续其后）。

## 0. 一页结论

1. **不统一的根因不是颜色或间距，而是控件形态选错**：官方设置行的单选标准控件是
   **36px 圆角选择丸 + 下拉菜单**（`LanguageRow` / `PermissionRow` 的 `.selector`），
   而本线把皮肤 / 玻璃 / 壁纸图源 / 头像清单全做成了**一排 Pill**——Pill 在官方是
   view switcher / filter 用的（primitives README 原话），放在设置行里既不对题、
   一多就换行刷屏。这是「看起来像另一个应用」的最大单点。
2. 其余差距：分组标题无官方对应物（官方通用页是**纯行列**，models/plugins 才用
   16px/500 页标题）；应用图标九宫格是自绘语言（应对齐 plugins 的卡片先例）；
   M3/M4 占位是一行 hint（官方「空」的先例是 **dashed 卡片**）；运行信息块没有官方形态。
3. 方案分两块：**V1 视觉统一**（控件替换 + 布局重排，行为逻辑零变化，可一轮落地）
   与**功能完善路线**（M3 动效 → Boot Splash 实施 → M4 会话效果 → 恢复默认/导入导出）。
4. V1 全部复用官方词汇：`Menu` 下拉、`.selector` 选择丸、stepper、官方 Switch/Button、
   plugins 的 rowCard 卡片语言、models 的 dashed 空态卡；**零新自绘控件、零新依赖**。

## 1. 官方设计语言取证（vendor 源码，逐条带 CSS 值）

### 1.1 容器与页架

| 元素 | 出处 | 规格 |
|---|---|---|
| 设置弹窗 | `ui-settings-general/SettingsRoot.module.css` | 800px 宽、`border-radius:32px`、`bg-layer-2` + `elevation-prominent`；左导航 188px、右内容列；内容 `.options` `padding:0 24px 24px` 且滚动 |
| 栏内容宽 | `ui-settings-models/ModelsSection.module.css` `.section` | `flex-column; gap:12px; max-width:720px`（plugins 760px）——本线 720px 已对齐 |
| 页标题 | models `.title` | `16px/24/500 label-primary`；`.intro` `14px/22 label-tertiary`；`.notice` `12px/18 state-warn-label` |

**通用页本身没有页头也没有组标题**——它就是 6 行平铺的行列，section 只负责
「最后一行去掉分隔线」（`GeneralSection.module.css`）。

### 1.2 行（本线已对齐，保持）

`ui-theme/FontSizeRow.module.css` `.row`：`display:flex; align-items:center; gap:8px;
padding:16px 0; border-bottom:0.5px solid var(--dsw-alias-border-l2)`；
左 `.rowText`（flex:1、column、gap:4、padding-right:48px）= `.title` 14px/22/400 +
`.desc` 12px/18/400 tertiary；右 `.control` inline-flex gap:8。
（`LanguageRow` / `PermissionRow` / `AppearanceRow` 逐字同款。）

### 1.3 控件词汇表（官方设置行实际在用的四种右置控件）

| 控件 | 出处 | 规格 | 用途 |
|---|---|---|---|
| **选择丸 + Menu** | `LanguageRow`（`.selector` + `Menu` primitive） | `h36; padding:0 14px; border-radius:18px; background:var(--dsw-alias-bg-module-platform); gap:12px`；尾缀 `IconChevronDownOutline14`；`Menu` 带 `selectedId` / `align="end"` / `portal` | **单选（3–N 项）的标准答案**：语言、权限预设都用他 |
| **步进器** | `FontSizeRow.stepper` | 本线已实现（72px min-width、r18、module 底、hover 露箭头） | 数值 |
| **立方组** | `AppearanceRow.themeCube` | `flex:1 1 180px; r20; padding:20px 32px; 图标在上文案在下; gap:4`；选中 = `bg-module-platform` + `neutral-bluish-400` 边 | 3 项且**每项值得一张图**的视觉选择（明暗） |
| **Switch** | primitives `Switch` | 36×20，`label` 必填 | 布尔 |

### 1.4 卡片 / 空态 / 按钮（models 与 plugins 两个先例）

| 元素 | 出处 | 规格 |
|---|---|---|
| 配置卡 | `ModelsSection.rowCard` | `border:0.5px solid border-l4; border-radius:16px; padding:12px 14px; gap:12`；`rowName` 14px/500 |
| 添加空态 | `ModelsSection.addButton` | `flex:1 1 0; min-width:180px; h44; border:1px dashed var(--dsw-alias-border-l3); border-radius:16px`——**「这里可以加东西」的官方说法** |
| 次级按钮 | models `.secondaryButton` | `h36; padding:0 14px; r18; border:0.5px border-l3; hover: interactive-bg-hover`；行内紧凑态 h28/r14/12px |
| 字段重置 | models `.linkButton` | `h28; r14; 12px/18; label-tertiary; hover 变 secondary`——**「恢复默认」的官方说法** |
| 双列字段网格 | models `.modelAdvanced` | `grid-template-columns:repeat(2,minmax(0,1fr)); gap:8`——本线表面四旋钮 2×2 有官方先例 |

## 2. 现状差距逐项对照

| 板块 / 控件 | 现状 | 官方对应 | 差距判定 |
|---|---|---|---|
| 启用 → 总开关 | 官方 Switch | `Switch` | ✅ 已统一 |
| 主题 → 皮肤 | 一排 Pill（3 项） | 选择丸 + Menu | ❌ **换控件**：3 项且带说明语义，选择丸一行收尾；Pill 排是 filter 语言 |
| 壁纸 → 图源 | 一排 Pill（无/3 内置/本地长文件名） | 选择丸 + Menu | ❌ 最严重：本地文件名是长串，Pill 排会换行成两三行；Menu 里放得下且不炸布局 |
| 壁纸 → 玻璃档位 | 一排 Pill（4 项） | 选择丸 + Menu | ❌ 同上；四档是「一滚定音」不是「并列比较」 |
| 壁纸 → 遮罩 / 晕影 | stepper | `FontSizeRow.stepper` | ✅ 已统一 |
| 壁纸 → 表面不透明度 | 自绘 2×2 旋钮网格 | models `.modelAdvanced` 双列 | ⚠️ 形似神不似：缺官方字段语言（12px/500 secondary 标签 + 行距）；改为官方双列字段网格规格 |
| 应用图标 → 九宫格 | 自绘 `.mia-iconCell`（r12、56px 图） | plugins/models 卡片语言（r16、border-l4、pad 12/14）+ `AppearanceRow` 选中态 | ⚠️ 圆角/描边/内边距全不对；选中态已接近官方（module 底 + bluish-400 边），保留 |
| 应用图标 → 自定义行 | 官方 Button | models 按钮 | ✅ 基本统一（outline/ghost） |
| 应用图标 → 我的上传 | 一排 Pill（文件名） | 选择丸 + Menu | ❌ 文件可能很多，Pill 排灾难；且「不使用」不该和文件并列 |
| 动效 / 会话效果 | 一行 hint 占位 | dashed 添加卡 | ❌ 官方「未配置/可添加」有专门形态，不是灰字 |
| 运行信息 | 三级灰字块 | 无官方对应 | ⚠️ 调试信息不该占一个「组」；收敛为面板底部一行 12px tertiary |
| 契约 / 错误条 | 12px notice | models `.notice` / `.error` | ✅ 已统一（仅间距要收敛） |
| 分组标题 | 自绘 14px/500 + 20px 上距 | 通用页**无组标题**；models 16px/500 页标题；plugins tabs | ⚠️ 保留分组（7 组平铺会糊），但规格靠拢官方：组标题 14px/22/500 label-primary（官方 `editorTitle` 同款），组间距统一 24px |

## 3. V1 视觉统一方案（行为逻辑零变化）

### 3.1 新控件：选择丸 + 下拉菜单（本线唯一新增自建制）

```
.mia-select                    // 照抄 LanguageRow.selector：h36 r18 module 底 gap12
  [当前值文案] [chevron]        // chevron 用官方 primitives.IconChevronDownOutlineRegular
                                //  （已对实装 seed 核对存在，见 §6）
.mia-menu                      // 官方 Menu primitive 直出；selectedId 高亮；align="end" portal
```

- **复用官方 `Menu`**（primitives 已导出，键盘 ↑/↓/Home/End/Esc 全自带），不自研下拉。
- 四个选择器统一走它：皮肤 / 壁纸图源 / 玻璃档位 / 应用图标（含「不使用」与「我的上传」合并为
  一个菜单：预设款 + 上传款 + 「不使用」——头像文件进 Menu 而不是 Pill 排）。

### 3.2 应用图标九宫格改官方卡片语言

- 格子：`border:0.5px solid var(--dsw-alias-border-l4); border-radius:16px; padding:12px 6px 10px`
  （对齐 models `rowCard` 圆角与描边；图 56px 保留，`border-radius:14px` → 12px 与卡统一）。
- 选中态不变（`bg-module-platform` + `neutral-bluish-400` 边，与 `themeCube` 同语言）。
- 网格：`repeat(auto-fill,minmax(104px,1fr))` 保留（四格一行刚好）；组间距 8px。

### 3.3 M3/M4 占位与运行信息

- 占位改 dashed 添加卡（models `addButton` 规格：h44、dashed border-l3、r16、12px/18 文案
  「M3 动效：…（未实现）」），点击不做事（`disabled` 或纯展示）——形态即「将来这里有东西」。
- 运行信息收敛为面板底部一行 `12px/18 label-tertiary`（修订号 · 持久化 · 门控属性），
  不再独占组标题。

### 3.4 布局节奏

- 组间距统一 24px（组标题上）；行内 16px 0 不变；契约条/错误条 margin 收敛为 0/8px。
- 面板 `max-width:720px` 不变（与 models 同档）。
- 「壁纸」组内 5 行 + 「表面不透明度」双列字段网格：网格标签 `12px/18/500 label-secondary`
  （models `fieldLabel`），旋钮即官方 stepper（零改）。

### 3.5 文案微调（不改变语义）

- 皮肤行说明精简为一句 + 「明暗偏好与正文字号在『通用』设置页」（去重条的迁移提示保留）。
- 各选择丸的行说明从「解释所有选项」改为「解释这一行管什么」（选项自解释，进 Menu 看全貌）。

### 3.6 回归闸门（测试同步）

1. 面板**不再出现** `.mia-picker` Pill 排用于单选（Pill 仅保留给真正并列的少项场景——
   本方案后实际为零处；`mia-picker` class 若彻底弃用，从 CSS 删除并在风格契约中断言
   「设置行单选必须走 `.mia-select` 选择丸」）。
2. 「渲染树无 undefined 元素类型」闸门继续全路径驱动（Menu anchor / chevron svg 都在树上）。
3. 新增：四个选择丸的 Menu items 数 = 配置白名单数（皮肤 3 / 玻璃 4 / 图源 1+3+本地 /
   图标 4+上传数+1），防「UI 少给选项」类静默降级。

## 4. 功能完善路线（接在 V1 之后）

| # | 事项 | 内容 | 依赖 |
|---|---|---|---|
| P1 | **M3 动效** | ✅ **已实施（2026-09-27）**：面板三控件（Switch + 预设选择丸 + 强度步进器，masterSwitch label 参数化）+ 纯 CSS 动效层（`--mia-mo-*` 变量、时长梯 160/300/420、位移+缩放入场、禁 linear、reduced-motion 降级 100ms 淡入、关闭即整层移除、**不碰官方 transition**）；消息级错峰贴类器留 M3.1（`.mia-mo-tagged` 槽位 CSS 已在层内，贴类器待实机锚点取证） | V1 的选择丸；M1 规划 §5.5 设计 |
| P2 | **Boot Splash 实施** | ✅ **已实施（2026-09-26，§5.1）**：`lib/splash.js` 三纯函数 + host `index-inject` 三行（首次启用官方 `html` 行 kind）+ client 退场钩子（双信号 + 2.5s 兜底 + 幂等）；配置 v5 `motion.bootSplash`；S5 实机待验收 | 跨线契约 `cross/boot-loading-2026-09-22.md` |
| P3 | **M4 会话效果** | 密度 / 最大宽度 / 流式光标 / 代码块与引用样式 / 工具卡折叠 / 字体；面板每行一个选择丸或步进器；密度与宽度**不得**与通用页「会话视图」混淆（那是视图模式） | V1；M3 的注入与锚点纪律 |
| P4 | **每板块恢复默认** | models `linkButton` 形态（h28/r14/12px tertiary）；按板块重置（theme/wallpaper/avatar/motion/conversation） | V1 |
| P5 | **配置导入 / 导出** | M5 规划项：一段 JSON 下载/上传，sanitize 全量收窄后整体替换；导入前二次确认 | V1 |
| P6 | 壁纸亮暗双图 + URL 源入口 | 配置面早已支持（`wallpaper.light/dark`、http(s) 源），面板按需开放（URL 源有外链风险，入口加确认） | V1 |

**明确不做**：不做语言/会话视图/回车行为/权限预设入口（通用页已有）；不动官方三立方语义；
不为动效引入 JS 动画库（纯 CSS transition/keyframes）。

## 5. 实施顺序与验证

1. ~~**S1 V1 视觉统一**~~ ✅ **已实施（2026-09-26 同日）**：`client.js` 面板重排 +
   `.mia-select` 选择丸（官方 `LanguageRow.selector` 规格）+ 官方 `Menu` 下拉；九宫格换官方
   卡片语言（r16 + border-l4）；表面四旋钮换官方双列字段网格（`mia-fieldGrid` / 12px/500
   标签）；M3/M4 占位换官方 dashed 卡；运行信息收敛为面板底部一行；组间距统一 24px、
   组内末行去分隔线（同官方 `GeneralSection` 的 last-child 规则）。
   **`lib/config.js` 零改动**（行为不变）；Pill 整类退场（`pill()` 与 `.mia-picker` 删除）。
   测试：三个冒烟路径全绿 + 风格契约改写（选择丸/dashed 在位、Pill 排退场）+
   **新增 V1 闸门 1 例**（三个单选行走 Menu；菜单项 = 配置白名单：皮肤 3 / 玻璃 4 /
   图源 1+3+本地；长值 title 给全名；无 `.mia-picker` 复活）+ 「渲染树无 undefined 元素
   类型」走查全路径（Menu anchor 在 props.anchor 上，新增 `collectMenuAnchors` 遍历）。
   单测 **100 → 101 例**（client 15 → 17）；`verify-all appearance` **16/16**、
   `repo` **2/2**。**实机待用户重启 `dsh web` 验收**。
2. **S2 P1 M3 动效** → ~~**S3 P2 Boot Splash**~~ ✅ **已实施（2026-09-26，见 §5.1）** → **S4 P3 M4**，各自带单测与 CHANGELOG。

### 5.1 P2 Boot Splash 实施记录（2026-09-26）

- **S1 取证**：vendor `packages/host/webserver/src/injections.ts` 逐行核对（六 kind / head·body
  两组按 table 顺序 / 官方 `READY_MARKUP` 在最后一个 body 行后），并用官方同款渲染逻辑离线
  端到端验证本线五行落点（splash DOM 先于退场脚本、splash script 先于 READY_MARKUP）。
- **S2 产出** `lib/splash.js`（新）：`buildSplashStyle` / `buildSplashHtml` / `buildSplashScript`
  三纯函数 + `splashEnabled` 门控；容器 `#mia-splash`（fixed / z-index 2147483000 /
  pointer-events:none）、**颜色全部 var() 经 body 继承**（不读皮肤 token 表——静态色阶明度中立，
  踩坑与正解见设计 §6.1）、纹章双环旋转（zafkiel 顺 / kurkuriel 逆 / pure 静止）+ 呼吸 +
  三点流动、`prefers-reduced-motion` 全静止；退场双信号（client 主信号 / MutationObserver 兜底）
  + 2.5s 超时 + `dataset.miaSplashDone` 幂等。
- **S3 host**：`index.js` 既有 `webserver/index-inject` 订阅内追加三行；配置 **v4 → v5**
  `motion.bootSplash`；`verify-all.mjs` 语法清单 + `package.json` build 同步补 `lib/splash.js`。
- **S4 client**：`apply()` 内 `window.__miaSplashExit()`（try/catch）。
- **验证**：`test/splash.test.js` **8 例** + host **+2 例**（行序 / off 门控）+ config 迁移断言；
  单测 **101 → 111 例**；`verify-all appearance` **16 → 18 项**、`repo` **2/2**。
- **S5 实机待用户重启 `dsh web` 验收**（判据：出现 / ≤400ms 淡出无三段跳 / 关掉即原生
  diff=0 / 401 硬用例 2.5s 让位 / reduced-motion 静止 / 三主题 × 明暗）。
3. 每步落地后更新回归矩阵 §3.5（D 组台账同步加项）。

## 6. 风险

- **Menu / 图标可用性已实机核对（不是推断）**：从**本机实装的 seed 产物**
  （`@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js` 的 `qb=Object.freeze(...)`
  冻结导出表）逐名确认存在：`Menu` / `Pill` / `Switch` / `Button` / `Tag` / `Toast` /
  `Tooltip` / `Modal` / `Checkbox` / `Input` / `DisclosureRow` / `HoverCard` / `StateDot` /
  `useAnchoredPosition` / `useDismissOnOutsidePointer`，以及
  `IconChevronDownOutlineRegular`、`IconChevronsUpDownOutlineRegular`、
  `IconSlidersTwoOutlineRegular`（动效板块可用）、`IconPlusOutlineRegular`、
  `IconDownloadOutlineRegular`（导入导出可用）、`IconTrashOutlineRegular`。
  **命名规律与 2026-09-23 事故结论一致**：`Icon<名称>Outline<Medium|Regular>`，无尺寸后缀。
  stub 白名单仍按此表镜像，`client.test.js` 的「引用闭环 + 命名合规」两条闸门继续守。
- **chevron 图标**：用官方 `IconChevronDownOutlineRegular`（已核实），不再走内联 SVG 兜底；
  若 DSH 升级后 seed 改名，引用闭环闸门先红，不会重演「整栏空白」。
- **纯表现层改动**：V1 不动任何配置字段与行为路径，「关掉即原生」契约不受影响；
  单测的 stateQueue 会随面板结构微调（组件内 state 集合不变：7 个）。
- **美观主观性**：V1 全部规格有官方出处（本文 §1 表），做完后与「通用」页并排应读不出
  两个应用；若用户想更进一步（如页标题 16px、tabs 分组），在 P4 之后单独拍板。
