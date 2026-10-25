# 外观 M5「文字」板块设计（字重 + 排版四件套 + 吸底预览确认制）

- 日期：2026-10-19
- 状态：已实施
- 触发：用户分享社区插件 `dsh-font-probe`（<https://github.com/lohana20061023-29/dsh-font-probe>）并提问「是不是可以加载我们外观设置里」。分析结论见本文 §1。

## 1. 背景与范围决策

### 1.1 社区插件分析（2026-10-19）

`dsh-font-probe` v1.5.2（MIT、零运行时依赖、双半体 + bundle.patch 装载，与本线同族）提供：
中/英/代码字体分设、正文字号/代码字号、界面/标题字重、字距/行距/段距/首行缩进、吸底总预览 + 草稿确认制、Local Font Access 枚举本机字体，配置写回 profile 的 `cordis.patch.yml`。

**关键事实（已对本机实装 0.2.1-rc.2 官方源码逐条核实）**：它 README 的立论
（「DSH GUI 只内置配色与正文字号，没有字体族选项」）对 ≤0.1.x 成立，对 0.2.1-rc.2 **已过时**——
官方 `dsh-client-ui-theme` 已内置：

| 能力 | 官方 0.2.1-rc.2 |
|---|---|
| 正文字体 / 代码字体 / 侧栏终端字体 | ✅ 通用设置页三行（`settings.general.item` order 11；`textFontFamily` / `codeFontFamily` / `terminalFontFamily`，volatile 持久化） |
| 正文字号 / **代码字号** | ✅ `--dsh-content-font-size` / `--dsh-code-font-size` |
| 中英分设 | ✅ 官方输入框接受逗号分隔字体列表，用户列表排内置栈之前 |

它实现方式在 0.2.1 上有真实冲突面：`--dsw-font-family` / `--ds-font-family-code` 走
html/body inline `!important` 全覆盖，会盖过官方 ThemePresenter 写 `body.style` 的新机制
（它 v1.5.1 修过与旧机制的互斗，README 没跟上 0.2.1）——两套机制并存会互相失灵。

### 1.2 范围（用户拍板「按 B 立项」）

**做（官方没有的）**：

- 界面字重 / 标题字重（300–900 整百档，留空 = 不覆盖）
- 排版四件套：字距 0–3px（step 0.1）/ 行距 0–12px（step 1，**叠加**）/ 段距 0–24px（step 2）/ 首行缩进 0–4em（step 0.5）
- 吸底总预览 + 草稿确认制（复刻其被验证过的交互）
- 排版锚点自检（静默失效 #10 纪律的延续）

**不做**：

- 字体族 / 代码字体族 / 正文字号 / 代码字号 —— 官方通用页已有，本线 2026-09-26 立下的
  「先过通用页对照再上新设项」纪律禁止第二入口（`design/2026-09-26-appearance-page-dedup-and-roadmap.md`）。
- 本机字体枚举（Local Font Access API）—— 官方输入框已接受任意字体名；枚举是便利而非能力，
  且引入权限提示与异步状态，范围外。
- 会话三档字体（M4 `conversation.font`）**不动**：它在会话子树内覆盖 `--dsw-font-family`，
  与本板块的全局规则层叠上「指定值胜继承值」⇒ 会话内 M4 档位优先、会话外跟随全局，
  行为可预测。文案中写明这一关系。

### 1.3 与原样安装（方案 A）的取舍

不自装该插件，理由：① 用户诉求是「外观设置里」集中管理，它是独立一栏；② 它与官方 0.2.1
字体机制互斗（见 §1.1）；③ 其 v1.5.2 自修的 bug（装/卸别插件时 pnpm prune 掉 schemastery
⇒ 设置页整块消失）恰说明「写回 profile」路线在多插件 pnpm 环境下脆弱——本线自管
`config.json` 不受影响；④ 其面板是裸 `createElement` + 内联样式，不符合本线官方 primitives
风格契约，合并本来就要重写 UI。

**借鉴入账**（其 `docs/INTERNALS.md` 七条踩坑记录，本设计逐条采纳）：
`.volatile()` 才可写 / `configForms` 懒视图 / `set()` 单字段 / 有界重试 / 令牌自引用禁令 /
行高叠加公式 / 「界面显示-实际生效-已落盘」三层分离。

## 2. 配置模型（v7 → v8）

新增顶层板块 `text`（纯新增，旧配置由 sanitize 补默认 = 全原生档 ⇒ 升级零行为变化）：

```js
text: {
  uiWeight: '',        // '' = 不覆盖；否则 '300'..'900' 整百字符串
  headingWeight: '',   // '' = 不单独覆盖（跟随界面字重）
  letterSpacing: 0,    // px，0 = 不覆盖，[0, 3]，step 0.1
  lineHeight: 0,       // px 增量，0 = 不覆盖，[0, 12]，step 1
  paragraphSpacing: 0, // px，0 = 不覆盖，[0, 24]，step 2
  firstLineIndent: 0,  // em，0 = 不覆盖，[0, 4]，step 0.5
}
```

- 字重存**字符串**（与选择丸选项 id 同形，`''` 是合法的「不覆盖」值；数字 0 会被 `clampInt`
  的 fallback 语义混淆）。host 侧白名单 `WEIGHTS = ['', '300', …, '900']`。
- 四 metric 存 **number**（0 = 不覆盖；clampNumber 保留 0.1 小数）。
- `DEFAULT_CONFIG.text` 全原生档 ⇒ 与 M4 同款硬契约：**什么都不配时对页面零影响**。
- `mergeConfig` 增 text 板块浅合并；`sanitizeConfig` 非法值回退默认（字重不在表内 ⇒ `''`；
  metric 非有限数或越界 ⇒ 钳制/回退 0）。

## 3. CSS 编译与注入

### 3.1 纯函数 `buildTextCss(config)`

host 侧 `lib/config.js` 编译整段 CSS（可单测）。总开关关闭或全原生档 ⇒ 空串。规则：

| 配置 | 规则 | 出处 |
|---|---|---|
| `uiWeight` | `body { font-weight: N }`（低特异性，只影响**继承**文本，组件自声明字重仍优先，不压平「粗体标题 vs 常规正文」层级） | font-probe v1.5.0 |
| `uiWeight` | `[class*="_markdown"] p/li/blockquote/td { font-weight: N !important }`（Markdown 段落常由 `font` 简写连带指定字重） | 同上 |
| `headingWeight` | `[class*="_markdown"] h1–h6 { font-weight: N !important }`（应用用 font 简写把字重写在类规则里） | 同上 |
| `letterSpacing` | `[class*="_markdown"] { letter-spacing: Xpx }` | 同上 |
| `lineHeight` | `[class*="_markdown"] p/li/blockquote/td/h1–h6 { line-height: calc(24px + var(--dsh-content-font-delta, 0px) + Xpx) !important }` | **叠加而非替换**：应用行高 = `24px + 字号增量`（0.2.1 base.css 实测），写死会与字号脱钩 |
| `paragraphSpacing` | `[class*="_markdown"] p { margin-block: Xpx !important }` | 0 值不可进规则（会压掉官方段距）⇒ 编译期只输出非 0 项 |
| `firstLineIndent` | `[class*="_markdown"] p { text-indent: Xem }` | em 随字号缩放 |

**作用域纪律**：排版四项只作用于 `[class*="_markdown"]`（ui-primitives Markdown 组件的
CSS Module 类名 = 哈希 + `_` + 局部名，跨构建稳定）——**刻意不用全局 `p`**，否则插件自己的
说明文字与设置面板全文被缩进。界面字重挂 `body` 是其语义本身（管界面），不在此列。

### 3.2 注入链路（host 计算、client 注册）

- `/state` 与 `/config`（成功 / 无变化 / 409 三种响应）随发 `textCss: buildTextCss(current)`
  ——与 `wallpaperLayers` 完全同款（预览与生效同源，且 client 不需要再拉一次）。
- client 半维护独立 `<style data-plugin-css="@miasaki/dsh-appearance/text.css">` 标签：
  非空 ⇒ 写入；空 ⇒ 移除。「撤销 = 标签移除 = 官方规则恢复」。
- **不进 boot style**：文字效果无首帧闪色问题（初始即原生），且 boot style 注入一次不可撤销
  （!important 规则会永久压过官方）——与 M4 会话效果同款取舍：刷新后「先原生后套上」，
  记入 CHANGELOG 已知限制。
- 保存后即时生效：`save()` 后处理链补 `applyText(next.config, next.textCss)`（M3/M4 同款位置）。

## 4. 面板设计（「文字」组）

位置：会话效果之后、启动之前。

### 4.1 控件（全部官方 primitives 纪律）

| 行 | 控件 | 说明 |
|---|---|---|
| 界面字重 | 选择丸 + Menu（默认 / 300–900 七档） | 只认整百；空 = 不覆盖 |
| 标题字重 | 选择丸 + Menu（跟随界面 / 300–900） | 空 = 不单独覆盖 |
| 字距 | 步进器 0–3 step 0.1 单位 px | 0 = 不调整 |
| 行距 | 步进器 0–12 step 1 单位 px | 在应用自身行高之上额外增加 |
| 段距 | 步进器 0–24 step 2 单位 px | 0 = 不调整 |
| 首行缩进 | 步进器 0–4 step 0.5 单位 em | 随字号缩放 |

### 4.2 吸底总预览 + 草稿确认制

- **草稿态**：`textDraft` + `textDirty` 两个 useState（**追加在 panel state 队列末尾**，
  不破坏既有 8 项顺序——test/client.test.js 的 stateQueue 纪律）。控件只改草稿；
  `effectiveDraft = textDirty ? textDraft : config.text`（外部改动/恢复默认后自动跟随，
  无需 syncedFrom 指纹——font-probe INTERNALS.md §7 教训的简化正确解）。
- **确认制**：底部操作栏（官方 Button）「确认应用」⇒ `save({ text: draft })`；「还原草稿」
  清 dirty。确认/保存成功后 dirty 归位。**刻意的与其它板块不同**：字体排版是「试了才知道」
  的场景，滑块误触即全局生效 + 落盘很烦；其余板块保持即时保存不变。
- **预览卡**（普通块）+ **吸底确认栏**（`position:sticky;bottom:0`）：拖滑块 / 滚动看预览时
  「确认应用」永远在场（dsh-font-probe 验证过的交互）。预览卡本身**不 sticky**——它约
  200px 高（标题样张 + 中英文样例 + 代码样例），整卡吸底太占地。预览内容：标题样张
  （近似官方 `--dsw-font-markdown-h2` 规格）+ 中文正文样例 + 拉丁数字样例 + 代码样例
  （`--ds-font-family-code`）。样式按草稿**内联计算**（草稿是动态值，静态类表达不了）；
  颜色一律 `--dsw-*` 令牌。卡底注明「预览为近似，真实生效以会话正文为准」。
- 总开关关闭时控件禁用、预览照显（草稿态），确认后不生效——与其它板块门控一致。

### 4.3 锚点自检（静默失效 #10 延续）

`probeTextAnchors()`：任一项非默认 ⇒ 检查 `[data-slot="main.conversation"]` 与
`[data-chat-flow]` 在位、且 flow **有子节点**（= 有消息）却找不到 `[class*="_markdown"]`
容器 ⇒ `mismatch`（确定性失配，面板黄条提示官方结构可能变了）。无消息 / 会话页不在 ⇒
`unknown` 不提示（与 M4 同款「只在能确定的时候说话」）。

### 4.4 无可见效果判定

`effectVisibility()` 增补：text 任一项非默认 ⇒ `visible: true`；native 文案补一句
「或把『界面字重』改成非默认」。

## 5. 兼容与已知限制

- **只影响 Web GUI**（设置面板与浏览器注入），Native 窗口/菜单不涉及（字体族本来就不涉及）。
- 排版四项只对**对话正文**生效，不改侧栏/按钮等界面文字（`[class*="_markdown"]` 作用域）；
  界面字重按语义影响全局继承文本。
- 行距为叠加：用户改官方字号时行高仍等比变化（`--dsh-content-font-delta` 联动）。
- 刷新后「先原生后套上」（不进 boot style，§3.2）。
- 首行缩进对代码块/列表不生效（只压 `p`）——刻意：代码与列表缩进会破坏结构观感。
- 某些字体只有单一字重（选中后整体偏粗）是字体本身性质，非本线问题（官方字体行同款）。

## 6. 验收判据（入回归矩阵）

1. config v7 → v8 迁移：旧配置升级后 text 全原生档，页面零变化。
2. 全原生档 + 总开关开 ⇒ `buildTextCss` 空串、无 style 标签（「关掉即原生」）。
3. 总开关关闭 ⇒ 文字层整层移除（标签移除 = 官方恢复，无残留）。
4. 各单项规则文本（字重两条 + 标题 + 四 metric；行距为 calc 叠加公式；段距/缩进只输出非 0 项）。
5. 非法值收窄：字重 `'450'`/`'abc'`/`1000` ⇒ `''`；metric 越界钳制、非数回退 0。
6. 预览确认制：控件只改草稿（不发请求）；「确认应用」才写盘；外部改动后草稿自动跟随。
7. 锚点 mismatch 提示（flow 有消息但无 `_markdown` 容器）；无消息不误报。
8. 风格契约：控件全部官方 primitives（Menu/Button/步进器）；文字规则不碰官方类名；
   预览卡颜色只走 `--dsw-*` 令牌；文案不漏 `**`。
9. 实机：miasaki 桌面端 + `dsh web` 各跑一遍（用户验收项）。
