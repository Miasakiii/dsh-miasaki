# 外观设置页 × 官方「通用」设置页对照去重 + 持续推进规划

- 日期：2026-09-26
- 范围：`dsh-miasaki-appearance/`（client 半面板 + host 半配置模型 + 单测 + 文档）
- 触发：用户「通用设置和外观设置对照一下，通用设置里有的，外观设置就不需要有了，
  规划设计，准备持续推进外观设置页完善」。

## 0. 一页结论

1. **官方「通用」设置页现有 6 行**（全部注册在 `settings.general.item` 槽，由
   `ui-settings-general` 的 `GeneralSection` 渲染），取证见 §1。
2. 外观页与之**重合的恰好两项**：**明暗偏好**（浅色/深色/跟随系统）与**正文字号**
   （12–17px）。二者自 M1 起就是「同一官方偏好的第二入口」——本次按用户要求**整行移除**。
3. 连带清理：`config.theme` 的 `scheme` / `accent` / `fontSize` 三个**镜像字段**一并移除
   （连同出厂默认值；`accent` 更是从未接过 UI 的死字段）。官方偏好由官方
   `settingsScope` 持久化，本线再存一份只会漂移。配置 **v3 → v4**，
   删除字段无需搬运（sanitize 直接丢弃）。
4. 外观页保留官方通用页**没有**的能力：皮肤、壁纸与玻璃、应用图标、总开关、
   契约自检、运行信息；动效 / 会话效果两个占位板块等 M3 / M4 落地。
5. 持续推进路线见 §6：**先过「通用页对照」再上新设项**成为本线纪律；M3 动效 →
   Boot Splash 实施 → M4 会话效果依次推进，每项落地都附「不重复」判据。

## 1. 对照取证：官方「通用」设置页有什么

不凭记忆，全部落点在 vendor 源码（`vendor/deepseek-harness/packages/client/`，
与 `scripts/check-doc-versions.mjs` 的 `BASELINE_DSH_VERSION` 同源）：

| 行（注册 id） | order | 注册方 | 界面文案（zh） |
|---|---|---|---|
| `language` | 0 | `locale` 包 `LanguageRow` | 语言 |
| `appearance` | 10 | `ui-theme` `AppearanceRow` | **外观**：浅色 / 深色 / 跟随系统 |
| `font-size` | 11 | `ui-theme` `FontSizeRow` | **字号大小**：12–17px 步进，「仅影响会话内容的字号」 |
| `transcript-view` | 12 | `ui-chat` `TranscriptViewRow` | 会话视图 |
| `composer-enter` | 20 | `ui-conversation` `EnterBehaviorRow` | 回车行为 |
| `permission` | -20 | `ui-permission-presets` `PermissionRow` | 权限预设 |

取证要点：

- 「明暗三立方」是**官方硬编码**：`AppearanceRow` 只渲染 `CUBES` 三个立方，
  不读任何皮肤注册表（本线 M2 设计 §2.2 已确证，README「两个关键决策」第 2 条有记录）。
  因此**皮肤**不会与它重合——它没有的能力才是外观页的价值。
- 「字号」同样是官方行：`FontSizeRow` 走 `setFontSize`，值持久化在官方
  `settingsScope` 的 `settings.theme` 命名空间，官方的 store 自己同步官方 `theme/change` 事件。

## 2. 外观页原来有什么、重合判定

去重前的外观页板块（M1 + M2 + M2.5 + M2.7 叠加的结果）：

| 板块 / 行 | 与官方通用页的关系 | 判定 |
|---|---|---|
| 启用总开关 | 官方无 | **保留** |
| 主题 → 明暗偏好（浅/深/跟随系统） | = 通用页 `appearance` 行（order 10），同一个 `ctx.theme` 偏好 | **移除** |
| 主题 → 正文字号（12–17px） | = 通用页 `font-size` 行（order 11），同一个 `setFontSize` | **移除** |
| 主题 → 皮肤（纯净/刻刻帝/狂狂帝） | 官方 AppearanceRow **没有**皮肤概念（三立方硬编码） | **保留** |
| 壁纸 → 图源/玻璃/遮罩/晕影/表面透明度 | 官方无 | **保留** |
| 应用图标（预设九宫格 + 上传） | 官方无（属跨线能力，桌面壳消费） | **保留** |
| 动效 / 会话效果（占位） | 官方无 | **保留**（M3 / M4 落地） |
| 运行信息 | 官方无（本线诊断） | **保留** |

M1 规划设计（`2026-09-11-appearance-settings-plan.md` §1.2）当时的决策是
「给同一偏好提供第二个入口，两个入口必须永远指向同一状态」——**本次推翻该决策**：
第二入口解决的是「找不到」，而官方通用页就在设置面板第一栏，找到它不是问题；
重复入口的真实代价是两处文案与边界各自漂移（本线的说明文字已经在描述
「选中即拨一次官方三立方」这类只有本线知道的语义），以及配置里那三个
永远在跟官方状态赛跑的镜像字段。

## 3. 去重决策（D1–D5）

- **D1 整行移除，不做只读回显**。只读回显仍是重复（用户要求是「不需要有」），
  且回显值还要从官方 `getTheme()` 快照里再抄一份。`client.test.js` 的去重闸门
  同时禁掉「控件形态复活」与「只读回显复活」（文本精确匹配 + class 匹配）。
- **D2 镜像字段一并删除，不做保留兼容**。`scheme` / `accent` / `fontSize` 移除后：
  - `sanitizeConfig` 的 theme 板块只剩 `skin`；旧配置里的残留**直接丢弃**
    （不是清空默认值——字段本身不存在了）。
  - `buildBootScript` 不再写 `data-mia-scheme`（该属性全仓无消费者，移除零影响；
    官方明暗由 `body[data-ds-dark-theme]` 驱动，皮肤 boot style 的双段选择器照常工作）。
  - `CONFIG_VERSION` 3 → 4，`migrateConfig` 补注释说明「删除字段不需要搬运」。
- **D3 皮肤选中时仍拨一次官方三立方**。`syncSkin(forceScheme)` 的
  `theme.setTheme(skin.meta.preferredScheme)` 不动——那是**皮肤的原生明暗建议**，
  不是重复入口：用户之后改明暗不会被拉回（M2 §3.2 语义不变）。
- **D4 「主题」组保留组名，只留皮肤行**。组名改名（如「主题皮肤」）会让回归矩阵与
  历史文档的指称失效，而单行组的辨识度由行标题「皮肤」+ 说明文字承担；
  说明文字里显式告知「明暗偏好与正文字号在『通用』设置页」（迁移提示，老用户找得到）。
- **D5 契约自检不动**。`evaluateContract` 校验的是官方主题服务四件套
  （getTheme / setTheme / setFontSize / overrideTokens）**是否在位**——那是本线皮肤层
  的地基检查，与「给不给用户第二入口」无关，全部保留。

## 4. 实施记录

**host 半（`lib/config.js`）**

- `CONFIG_VERSION` 3 → 4；`migrateConfig` 头部注释补 v3→v4 分支说明。
- 删除 `SCHEMES` / `FONT_SIZE_MIN` / `FONT_SIZE_MAX` 常量与 `toAccent()` 收窄原语
  （`accent` 移除后它零调用方，按本线「不留死代码」纪律同批删除）。
- `DEFAULT_CONFIG.theme` = `{ skin: 'pure' }`；`sanitizeConfig` 的 theme 板块同步收敛。
- `buildBootScript` 去掉 `data-mia-scheme` 属性（注释写明「明暗由官方 presenter 驱动」）。

**client 半（`client.js`）**

- 删除：`SCHEME_CUBES` 常量 + `schemeCubes()`、`readThemeFacts()`、组件 state
  `themeFacts`、`applyScheme()`、`stepFontSize()`、字号行的 `px` 单位节点、
  save 成功路径里的 `data-mia-scheme` 同步。
- `PANEL_CSS` 删除 `.mia-cube*` / `.mia-selected` / `.mia-unit` 规则（步进器规则保留——
  壁纸四个旋钮仍在用）。
- 「主题」组收敛为「皮肤」一行；文件头注释与 M2.6 风格说明同步改写。
- primitives 引用收敛为 `Button / Switch / Pill / IconChevronUpOutlineRegular /
  IconChevronDownOutlineRegular`（步进器沿用官方 chevron）。

**测试（三个文件动，八个文件复跑，100 例全绿）**

- `test/config.test.js`：theme 夹具改为「死字段进、`{skin}` 出」；
  新增「已移除镜像字段一律丢弃」与「v3→v4 丢弃死字段」两例；`mergeConfig`
  深合用例改锚 wallpaper 字段（theme 单字段后原用例失去意义）；
  `buildBootScript` 增 `data-mia-scheme` 缺席断言。30 → **32 例**。
- `test/client.test.js`：五个渲染夹具的 theme 瘦身；**stateQueue 少一格**
  （themeFacts 移除，队列改为 state / contract / error / busy / wallpapers /
  avatars / presets）；primitives stub 同步移除三枚立方图标；
  风格契约去掉立方断言、增「`.mia-cube{` 不得复活」；**新增去重闸门 1 例**
  （面板不渲染「正文字号」/「跟随系统」文本、无 `.mia-cube` 节点、无 `px` 单位节点，
  而「皮肤」与总开关必须在）。15 → **16 例**。
- `test/store.test.js`：往返与归一化两例改锚 `{ skin }`；磁盘断言
  `raw.theme` deepEqual `{ skin: 'pure' }`。
- `test/host.test.js`：零改动（本就只写 `theme.skin`），全量复跑 16 例绿。
- 回归：`node ../scripts/verify-all.mjs appearance` **16/16 PASS**（100 例单测 +
  derive-skins --check）；`verify-all.mjs repo` **2/2 PASS**。

## 5. 去重后的外观页信息架构

```
设置 → 外观                                    [ id: appearance, order: 5 ]
├─ 启用     外观定制总开关
├─ 主题     皮肤（纯净 / 刻刻帝 / 狂狂帝）          ← overrideTokens 层（官方通用页没有）
│           （明暗偏好与正文字号在「通用」设置页）
├─ 壁纸     图源（内置渐变 / 本地目录）/ 玻璃四档 / 暗色遮罩 / 晕影 / 表面不透明度四旋钮
├─ 应用图标 预设九宫格（默认 / 头像 / 立绘 / 现行）+ 自定义上传 + 我的上传
├─ 动效     M3 占位
├─ 会话效果 M4 占位
└─ 运行信息 修订号 / 持久化状态 / 皮肤门控属性
```

## 6. 持续推进规划（外观设置页完善路线）

**纪律（本次新增，适用于后续每一个设项）**：上新任何设置项之前，先与官方
「通用」页（`settings.general.item` 槽现有 6 行，§1 表）对照——
官方有的不做第二入口；官方有的但语义不同的（如皮肤 vs 三立方），要在行内说明里
写清分工，并在 PR/CHANGELOG 里留下对照结论。DSH 升级后重跑一次 §1 取证
（vendor 源码为准），新版本可能往通用页加行。

按优先级：

| # | 事项 | 要点 | 前置 / 依赖 |
|---|---|---|---|
| P1 | **M3 动效** | ✅ **已实施（2026-09-27）**：纯 CSS 动效层（`--mia-mo-*` 变量 + `mia-mo-rise` 入场）挂 `[data-slot]` 锚点，三套预设 + 强度倍率 + `prefers-reduced-motion` 强制降级（100ms 淡入）；消息级错峰贴类器留 M3.1 | 无（设计在 M1 规划 §5.5 已定稿） |
| P2 | **Boot Splash 首帧启动画** | ✅ **已实施（2026-09-26）**：`lib/splash.js` 三纯函数 + `index-inject` 三行（splash style / html / script，首次启用官方 `html` 行 kind）+ client 退场钩子；退场双信号（client 装载 / MutationObserver）+ 2.5s 超时 + 幂等守卫；配置 v5 `motion.bootSplash`。S5 实机待验收（实施记录见 [视觉统一与功能路线](2026-09-26-appearance-visual-unification-and-roadmap.md) §5.1） | 跨线契约 `cross/boot-loading-2026-09-22.md` |
| P3 | **M4 会话效果** | 消息密度 / 最大宽度 / 流式光标 / 代码块与引用样式 / 工具卡折叠 / 字体；**密度与宽度不得与通用页的「会话视图」行混淆**（那是视图模式，不是密度） | M3 的动效层管线（同一注入与锚点纪律） |
| P4 | **实机验收清偿** | 去重后的面板 + M2 视觉矩阵 + M2.5/M2.7 图标链，一次 `dsh web` + 桌面壳重启同批验完（`cross/smoke-test-matrix.md` §3.0 D 组 + §3.5 更新后的判据） | 用户执行 |
| P5 | （观察项）**壁纸亮暗双图 / URL 图源** | 配置面早已支持（`wallpaper.light` / `dark` / http(s) 源），面板入口按 M1 D5 暂缓；若 P4 验收中用户提出再开 | — |

**明确的「不做」**（去重后写死，防止范围膨胀）：

- 不做语言 / 会话视图 / 回车行为 / 权限预设的任何入口——通用页已有（§1 表）。
- 不做「明暗 / 字号」的只读回显（D1）。
- 不动官方三立方的硬编码语义；不注册 `ctx.theme.register`（M2 结论不变）。

## 7. 风险与边界

- **旧配置兼容**：v3 配置带 scheme/accent/fontSize，加载时 sanitize 直接丢弃，
  下次任一写入即以 v4 清净落盘；无迁移代码=无迁移 bug。桌面壳只读
  `avatar.source`（跨线契约字段，本批未动）。
- **`data-mia-scheme` 移除**：全仓检索确认无消费者（client 只写不读、desktop 不读）；
  官方明暗驱动源 `body[data-ds-dark-theme]` 不变，皮肤 boot style 双段选择器不受影响。
- **实机影响面**：面板少两行 + 属性少一个；「关掉即原生」硬契约不受影响
  （总开关关闭时本线仍零注入）。**待用户重启 `dsh web` 后验收**（§6 P4）。
