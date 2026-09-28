# M4 会话效果：设计 + 实施记录

- 日期：2026-09-27（设计与实施同日）
- 范围：`dsh-miasaki-appearance/`（host 半配置模型 + client 半 CSS 层与面板 + 单测 + 文档）
- 触发：用户「继续推进外观线」——按 [视觉统一与功能路线](2026-09-26-appearance-visual-unification-and-roadmap.md)
  §4 的 P3 开工（P1 动效、P2 Boot Splash 已实施）。
- 前序：[M3 动效](2026-09-26-appearance-visual-unification-and-roadmap.md)（同一注入与锚点纪律）、
  [与通用页去重](2026-09-26-appearance-page-dedup-and-roadmap.md)（「上新设项先过通用页对照」纪律）。

## 0. 一页结论

1. **M4 落地方式：全部走官方 CSS 变量与属性锚点，零自建规则、零官方类名**。vendor 取证
   （`packages/client/`，逐条带出处）确认每个子项都有官方稳定事实可挂：
   密度 = `--dsh-chat-flow-gap`、宽度 = `--dsh-chat-content-width`、字体 = `--dsw-font-family`、
   流式光标 = `[data-streaming]`、引用/代码块 = markdown 原生 `blockquote` / `pre`。
2. **原生档不注入**：每行首档（comfortable / system / off / default / 0）一律不写 html 属性，
   属性缺席即规则不命中 ⇒ 官方观感；总开关关闭 ⇒ 属性 / 变量 / style 三层全清。
   「关掉即原生」硬契约与皮肤 / 动效层同门控。
3. **配置 v5 → v6**：`conversation` 新增 `font` / `cursor` / `quoteCode`（纯新增；
   `density` / `maxWidth` 是 v5 起就预留但从未接 UI 的死字段，本次接上控件）。
4. **范围决策（D4）**：「工具卡折叠」不纳入本轮——官方工具卡的展开是受控 React state，
   默认折叠属产品行为决策而非外观参数；见 §5。
5. **已知限制**：M4 层与 M3 动效层同为客户侧注入（boot style 撑首帧只服务皮肤），
   重启后会话列「先原生、后套用」；若将来要消此跳变，需把本层 CSS 并入 boot style
   （纯增量，配置面不变）。

## 1. 官方取证（vendor 源码，逐条可复核）

取证对象 `vendor/deepseek-harness/packages/client/`（与 `check-doc-versions.mjs` 的
`BASELINE_DSH_VERSION` 同源）。**不凭半年前 spike 记录写码**，每条附文件与行为。

| M4 子项 | 官方事实 | 出处 | 落地方式 |
|---|---|---|---|
| 消息密度 | 消息流间距变量 `--dsh-chat-flow-gap`（fallback 16px）；官方自己在 process-answer 紧邻档用 8px | `ui-chat/src/client/chat/ChatView.module.css` `.column > :not([hidden])…{margin-top:var(--dsh-chat-flow-gap,16px)}`、`.flowItem[data-turn-process-answer]{--dsh-chat-flow-gap:8px}` | 变量覆盖（compact ⇒ 8px；comfortable = 不写） |
| 会话最大宽度 | 内容宽度链 `--dsh-chat-content-width: var(--dsh-chat-user-width, clamp(680px, calc(var(--dsh-conversation-column-width,0px)*0.64), 920px))` 定义在 `.body` | `ui-conversation/src/client/skeleton/ConversationRoot.module.css` L358–361 | 在**更深的**官方属性锚点 `[data-chat-flow]`（`ChatView.tsx` L771 的消息列自身）上覆盖 ⇒ 赢层叠 |
| 宽度竞争面 | 官方拖拽手柄经 `ConversationWidthControls` 写 `--dsh-chat-user-width`（localStorage `dsh.conversation.contentWidth`） | `ui-conversation/src/client/skeleton/ConversationWidthControls.tsx` L131–166 | M4 接管期间手柄自然让位（覆盖在更深层）；改回 0 即交还。**面板文案明示** |
| 正文字体 | 全局字体族变量 `--dsw-font-family` / `--ds-font-family-code`；所有 `--dsw-font-*` shorthand 引用前者 | `ui-theme/src/styles/base.css` L7–9、`gradient-shadow-text.css` 全表 | slot 子树内覆盖 `--dsw-font-family`（解析发生在使用处 ⇒ 只影响会话内容） |
| 字号（禁区） | `--dsh-content-font-size` 由官方设置页 `FontSizeRow`（`setFontSize`）经 ThemePresenter 发布 | `ui-theme/src/styles/gradient-shadow-text.css` L46–57；通用页 `font-size` 行 order 11 | **一行不碰**（去重纪律：通用页已有） |
| 流式状态 | `AssistantMarkdown` 流式时为根节点写 `data-streaming={streaming\|\|undefined}` | `ui-chat/src/client/chat/AssistantMarkdown.tsx` L135 | `[data-streaming] > *:last-child > *:last-child::after` 挂光标（root > body > 末块） |
| 流式取色 | 官方流式状态行 shimmer 用品牌静态端 `--dsw-static-deepseek-500` | `ui-chat/src/client/chat/ChatView.module.css` L96–112 | 同色取 `--dsw-static-deepseek-500` |
| 引用样式 | markdown 渲染器输出**原生** `<blockquote>`（默认 2px caption 左边框） | `ui-primitives/src/markdown/render.tsx` L274–281、`MarkdownText.module.css` L151–155 | `blockquote` 语义标签选择器 + 档位属性 |
| 代码块 | 非空 fence 走 `CodeBlock`（`pre.shiki` + banner），样式在 `.block :where(pre)`（特异性 0,1,0） | `ui-primitives/src/markdown/CodeBlock.tsx`、`CodeBlock.module.css` L78–95 | `pre` 语义标签选择器（0,2,2 赢）+ 档位属性；banner 不动 |
| 工具卡 | `ToolRow` 展开态是受控 React state（`expanded` prop + `aria-expanded`），非原生 `<details>`；有稳定属性 `data-tool` / `data-state` / `data-variant` | `ui-tool/src/client/tool/components/ToolRow.tsx` L158–206 | 本轮**不做**（D4，见 §5） |

## 2. 面板信息架构（六行，全部官方控件词汇）

| 行 | 控件 | 配置字段 | 取值 | 效果 |
|---|---|---|---|---|
| 消息密度 | 选择丸 + Menu | `conversation.density` | comfortable / compact | `--dsh-chat-flow-gap:8px`（紧凑） |
| 会话最大宽度 | 步进器（0–1600，步进 40，单位 px） | `conversation.maxWidth` | 0 = 官方默认 | `--dsh-chat-content-width`（经 `--mia-cv-width` 变量） |
| 正文字体 | 选择丸 + Menu | `conversation.font` | system / serif / mono | `--dsw-font-family` 栈替换 |
| 流式光标 | Switch（label「流式光标」） | `conversation.cursor` | off / bar / block / underline | 开关 = off ↔ bar 切换 |
| 光标样式 | 选择丸 + Menu（off 时禁用） | `conversation.cursor` | bar / block / underline | 三形态 |
| 引用与代码块 | 选择丸 + Menu | `conversation.quoteCode` | default / plain / strong | blockquote / pre 两套档位 |

与 M3 同款：整组跟随总开关门控（关闭即禁用 + 三层全清）；行说明写清与官方的分工
（密度 ≠ 会话视图、字体 ≠ 字号、宽度与官方拖拽手柄的让位关系）。

## 3. 决策记录（D1–D4）

- **D1 宽度覆盖点选 `[data-chat-flow]` 而非 slot**。`--dsh-chat-content-width` 的官方定义在
  `.body`（`ConversationRoot`），比 `[data-slot="main.conversation"]` 更深 ⇒ 在 slot 上覆盖
  **不生效**（层叠输给 `.body`）。`[data-chat-flow]` 是 ChatView 消息列自身的属性锚点
  （官方写的 `data-chat-flow=""`），比 `.body` 更深 ⇒ 覆盖赢。副作用：输入卡片宽度
  （`--dsw-composer-card-max-width` 在 `.body` 定义）不随动——面板文案明示「只作用于
  会话消息列」。
- **D2 字体只覆盖 `--dsw-font-family`，不建字体 shorthand**。官方全部 `--dsw-font-*`
  shorthand 都引用该变量，会话子树内覆盖即全链路生效；`pre` 的代码字体走
  `--ds-font-family-code`（本次不做代码字体的 UI——默认栈已跨三平台，收益低）。
- **D3 光标两层 `last-child`**。`[data-streaming]` 的子结构是 root > body > 若干块；
  挂 body 会让光标在 flex column 里独占一行（display:inline-block 成 flex item）。
  两层 `> *:last-child` 命中最后一个内容块，`::after` inline 在其末尾——流式增长时
  React 复用 DOM 节点（key = block index），光标不重放动画。
- **D4「工具卡折叠」不纳入本轮**（范围决策，非遗漏）：官方工具卡的展开是受控 React
  state（非原生 `<details>`，DOM 层改不了初始态），「默认折叠」要 JS 注入改交互行为，
  且「工具卡默认收起还是展开」是产品决策而不是外观参数。已取证到稳定锚点
  （`[data-tool]` / `data-state`），留作独立子步（M4.1）单独拍板。

## 4. 实施记录

**host 半（`lib/config.js`）**

- `CONFIG_VERSION` 5 → 6；`migrateConfig` 补 v5→v6 注释（纯新增、无搬运）。
- 新增白名单常量 `FONTS` / `CURSOR_STYLES`（含 off）/ `QUOTE_CODE_LEVELS`；
  `DEFAULT_CONFIG.conversation` 扩为 `{ density, maxWidth, font, cursor, quoteCode }`；
  `sanitizeConfig` 的 conversation 板块同步扩（非法值回退首档）。
- `density` / `maxWidth` 两个 v5 预留字段原样收敛（收窄原语已在）。

**client 半（`client.js`）**

- 新增 `CONV_CSS`（规则只引用 html 档位属性与 `--mia-cv-width` 变量，规则静态）
  + `convStyleTag` / `convClear` / `applyConversation` / `syncConversation`
  （与 M3 动效层同构：`data-plugin-css` 去重注入，`apply()` 与 save 成功后双调用点）。
- 档位属性五个：`data-mia-cv-density` / `-font` / `-cursor` / `-qc` / `-width`；
  原生档值不写（属性缺席 = 规则不命中）。
- 「会话效果」组六行替换 V1 的 dashed 占位；`dashedPlaceholder` 与 `.mia-dashed*` CSS
  整类删除（无消费者，不留死代码）。
- `stepper()` 加可选 `unit` 参数（动效 × 与会话宽度 px 的单位收进控件内，调用方不再
  另挂 unit 节点）。
- `masterLive`（总开关在位）替代动效组的 `motionLive` 作为 M4 组门控。

**测试（三个文件动，`test/client.test.js` +3 / `test/config.test.js` +3）**

- `test/client.test.js`：
  ① M4 CSS 合规——密度/宽度/字体各走官方变量（宽度锚点必须是 `[data-chat-flow]`）、
  光标两层 last-child + 品牌取色 + reduced-motion 禁闪、引用/代码块四档规则、
  禁 `transition` 与 `linear`、**禁 `--dsh-content-font-size`**（官方字号不碰）；
  ② M4 板块控件——六行标题、光标 Switch 无障碍名、四个 Menu 的 items =
  host 白名单（直接 import `lib/config.js` 常量比对）、宽度步进器 aria-label 与 px 单位、
  总开关关闭时 M4 组禁用；③ M4 行为——全定制档写五属性 + 宽度变量、全原生档一属性
  不写、总开关关闭（含旧 host 无 conversation 板块）三层全清。
- 既有闸门同步：V1 闸门 Menu 数 4 → 8；M3 闸门 Switch 2 → 3、步进器 7 → 8；
  去重闸门的「无 px 单位」收紧为「无字号步进器」（aria-label 判据——宽度行的 px 是
  正当消费）；风格契约的 dashed 断言反转为「占位样式必须删除」。
- `test/config.test.js`：M4 三字段白名单收窄（含 maxWidth 上下钳 0/1600 与出厂全首档）、
  v5→v6 迁移补默认、conversation 单字段深合并不被同板块污染。

**验证**：单测 **114 → 120 例**（client 23 / config 35）；`node --check` 双文件通过；
`node ../scripts/verify-all.mjs appearance` **18/18**、`repo` **2/2**、
`check-doc-versions` 一致（版本号未动）。

## 5. 不做与已知限制

- **不做**：工具卡折叠（D4）；代码字体族 UI（默认栈已覆盖三平台）；首帧注入（下条）；
  官方字号 / 明暗的任何入口（去重纪律）。
- **已知限制**：M4 层为客户侧注入，重启 dsh web 后会话列先呈现官方观感、client 装载后
  套用定制（与 M3 动效层同款）。要消此跳变需把本层 CSS 并入 boot style 行（host 半
  import 当前 client 常量或镜像一份——属独立子步，记入设计账）。

## 6. 实机判据（S5，待用户重启 `dsh web` 后执行）

判据已同步进 [回归矩阵 §3.5](../../../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)
（两行）与 §3.0 台账 **D8**。核心判据：

1. 六行控件在位，总开关关闭时整组禁用；
2. 密度「紧凑」⇒ 消息间距可见收紧（舒适 = 与现状逐像素一致）；
3. 宽度设 960 ⇒ 会话列变宽（上限内）、输入卡片宽度不变；改回 0 ⇒ 交还官方（含拖拽
   手柄恢复有效）；
4. 正文字体切「衬线 / 等宽」⇒ 会话正文（含用户气泡）随之，侧栏 / 右栏 / 输入框不变；
5. 流式光标：发问后流式输出期间正文末尾出现光标；系统「减少动画效果」下不闪烁；
6. 引用与代码块切「简约 / 强调」⇒ 引用左边框与代码块内边距按档变化，「默认」档与
   升级前一致；
7. 总开关关闭 ⇒ `html` 上五个 `data-mia-cv-*` 属性与 `--mia-cv-width` 变量全部缺席
   （DevTools 可验），页面与原生一致。
