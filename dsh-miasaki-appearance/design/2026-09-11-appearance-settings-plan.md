# DSH Web「外观」设置页 —— 规划设计与方向选型

- 日期：2026-09-11
- 状态：**方向已定并已开工** —— D1/D2/D3 均取推荐项；M1 底座已实现（见 [M1 实施](2026-09-11-appearance-m1-design.md)），待重启 `dsh web` 实机验证
  - D1 = 新开一条线 `dsh-miasaki-appearance`
  - D2 = 外观线统一接管主题，desktop 注入层让位
  - D3 = 下沉 desktop 已有的三主题（§9-2 已源码 + 实测双路确证）
- 落点：`dsh-miasaki-appearance/`（本文已迁入其 `design/`）
- 需求原文：「在设置页加一栏『外观』页，可以开关主题按钮，设置壁纸，设置动效，会话效果等设置」
- 参考对象：`plolpl789/dsh-raw-html`、`feitangyuan/motion-web`、`yoli-mi/dsh-client-ui-custom`
- 取证基础（四路）：
  1. 本机 **活体 Inspect** 查询（slot 树 / theme token / Host+Client Service 契约），运行中的 GUI 回答；
  2. 本机 `@deepseek-ai/dsh@0.1.5-rc.1` 官方包源码逐份核对（`dsh-client-ui-theme`、`dsh-api-settings-controller`、`dsh-client-ui-settings`、`dsh-host-webserver`）；
  3. 本仓 `dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.5-rc1-slot-contract-2026-09-10.md` 与既有五线源码；
  4. 三个参考仓库的源码级深读（含 `dsh-client-ui-custom` 的 `apply.ts` / `custom.module.css` / `motion.ts`）。

---

## 0. 一页结论

**能做，而且不用改 shell 一行、不用打 bundle 补丁、不占用任何官方 id。**

官方 0.1.5 已把四条通道开好，且**本机已有第三方插件跑通同一套写法**：

| 我们要的能力 | 官方通道 | 本机先例 / 取证 |
|---|---|---|
| 设置页新增一栏 | slot `settings.section`（`{ id, order, label }`，owner props `{ close }`） | `dsh-pet-panel`（order 26）、`dsh-free-model-pool`（order 25）已在跑 |
| 配置持久化与实时读写 | Host `ctx.settings.register(ns, schema)` + Client **`ctx.settingsScope.bind({ namespace })`** | 官方 `ui-theme` 自用同款；**0.1.5 无命名空间白名单**（见 §2.3） |
| 配色/壁纸/不透明度落地 | `ctx.theme.overrideTokens(source, { light, dark })`（叠加层 + disposer，不污染注册表） | 官方为此设计，第三方未占用 |
| 首帧不闪烁 | Host 事件 `webserver/index-inject` 注入内联脚本 | 官方 `ui-theme` 正是这么做的（`bootThemeInjection`） |

**推荐方向（一句话）**：新开一条**纯 web 侧**的线 `dsh-miasaki-appearance`，沿用本仓既有
`index.js`(host) + `client.js`(browser) + `cordis.patch.yml` 范式；设置页注册 `order: 5` 的「外观」栏
（紧跟官方「通用」）；**皮肤不注册进 `ctx.theme` 注册表，而是走 `overrideTokens` 双层 token 表**
（理由见 §2.2，这是本次调研最重要的修正）；主题内容**复用 desktop 线既有的刻刻帝/狂狂帝/纯净三主题**；
动效只做 CSS 层 + `data-slot` 稳定锚点，不碰 React 内部与 hashed class。

**四个"因地制宜"的关键判断**（外部三个仓库都不会告诉你，因为他们没有第二个前端、也没看过官方源码）：

1. **皮肤不能走 `ctx.theme.register`**。官方「通用 → 外观」那一行是**硬编码的 light/dark/system 三个立方**
   （`dsh-client-ui-theme/lib/client.js:52-68`、`AppearanceRow` 只渲染 `CUBES` + `preference`），
   **不读注册表**。所以注册进去的皮肤：① 不会出现在官方 UI；② 用户点官方三立方会把 `preference`
   改成 light/dark/system，皮肤当场被顶掉。→ 皮肤改用 `overrideTokens` 的 `{ light, dark }` 双值层，
   天然支持"同一皮肤在明暗两种模式下各有一套色阶"，且**永不与官方偏好打架**。
2. **0.1.5 已经没有设置命名空间白名单了**。`settingsController.describe()` 直接
   `settings.describe({ redactSecrets: true }).map(namespaceView)`（`dsh-api-settings-controller/lib/index.js:429`），
   **枚举全部已注册命名空间，无过滤**。`dsh-client-ui-custom` README 里那句
   「`ui-custom` 必须加进 `WEB_SETTINGS_NAMESPACES`」是**旧版本**的约束，在 0.1.5 已不存在
   （全包 grep 无此符号）。→ 我们的配置走官方 scope 即可，**零补丁**。
3. **首帧必须自己防闪烁**。官方主题在 index HTML 里注入内联脚本（在 body 开标签后、shell 挂载前）
   写 `color-scheme` / `data-ds-dark-theme` / `--dsh-content-font-size`。我们的壁纸与皮肤层若等
   client 插件挂载后才写，会先闪一下原生界面。→ 必须同样用 `webserver/index-inject`。
4. **不往压缩 bundle 注入，但可并入本仓既有的官方包补丁链**。`dsh-raw-html` 那条路（往
   `dist/assets/index-*.js` 注入渲染模块）每升一次 dsh 就要重打、锚点会漂、还要维护两代压缩形态——不取。
   但本仓 `dsh-miasaki-desktop/patches/` 已有另一套**稳得多**的补丁工程：改的是**官方包自身的
   `lib/client.js` 模块文件**（不是压缩产物），锚点唯一性校验（不唯一即报错）+ baseline 重建 SHA 自证 +
   幂等标记 + `.dsh-bak` 回退 + `rebuild-baseline.mjs` 升级流程，已接入 `scripts/verify-all.mjs`。
   → 外观线**默认不新增补丁**；仅在"官方 token 缺读取方"这类明确缺口上，**并入已存在的补丁目录**
   （如已有的 `dsh-client-ui-conversation`），并逐条拍板（见 D8）。

### 0.1 M1 spike 结论（2026-09-11 实测完成）

源码逐份核对 + 运行期探针（动态 Cordis 插件，本机 0.1.5-rc.1）双路取证，**方案无需修改**；
两项因动态探针的环境限制顺延到 M1 实施期：

| 结论 | 影响 |
|---|---|
| ✅ `overrideTokens` **接受任意 token 名**（含 `--dsw-static-*`），无白名单；写入 body inline style | **D3 成立**，desktop 三主题可下沉 |
| ✅ 层按 `seq` 叠加、**同 source 再调 = 替换整层并重新置顶**（旧 disposer 变 no-op）；停用即整层回收 | skin / params **双 source 设计成立** |
| ✅ 客户端 `settingsScope.bind({namespace})` 可用，读接口 **`getSnapshot()`** → `{status:'ready', revision, writable:true, mode:'host'}` | 配置通道走官方，**零补丁** |
| ✅ `settings.describe()` 枚举全部命名空间（实测 15 个，第三方与官方并列） | 不需要 `WEB_SETTINGS_NAMESPACES` 式白名单 |
| ✅ 用户设置文档 = `C:\Users\Asakii\.dsh\settings.yaml` | 配置可手改、可版本化 |
| ✅ `index-inject` 支持 `style`(head) / `script` / `html` 等 6 种行 | 首帧防闪烁有正解 |
| ✅ `ConversationRoot` 直读 `--dsw-alias-bg-base`（无中间层） | D8 的补丁代价确认；「会话最大宽度」**无需补丁** |
| ⏳ 动效重放（§9-6）、性能基线（§9-7） | 动态插件**无 DOM 能力**（§9.1），留 M1 实施期用正式插件 + Playwright |

---

## 1. 需求拆解与边界

### 1.1 四组能力

| 用户原话 | 能力组 | 归属板块 |
|---|---|---|
| 「开关主题按钮」 | 皮肤切换 + 明暗偏好 + 强调色 + 字号 | **主题** |
| 「设置壁纸」 | 图源、毛玻璃、各表面不透明度、暗色遮罩、渐变、晕影 | **壁纸** |
| 「设置动效」 | 会话/侧栏/新会话/设置面板/视图切换的入场与过渡、预设与强度 | **动效** |
| 「会话效果」 | 消息密度、流式光标、代码块/引用/表格样式、工具卡折叠、字体 | **会话效果** |

「会话效果」是最模糊的一项，需要先划死边界（§5.6），否则会膨胀成第二个产品。

### 1.2 与官方既有能力的边界（不重复造）

官方已有、我们**只做入口不改语义**：

- **明暗偏好**：官方「通用 → 外观」三立方（`ui-theme`）；我们外观页内提供同样的三选一，
  底层一律调 `ctx.theme.setTheme('light'|'dark'|'system')`，**不自己写 localStorage**。
- **正文字号**：官方 `ui-theme` 同页提供（12–17px，步进 1）；我们复用 `setFontSize(px)`。
- **preference 的权威在官方**：我们**不替换**官方那两行（那是 `settings.general.item`，属 `ui-theme`），
  只在自己的页里给同一偏好提供第二个入口。**两个入口必须永远指向同一状态**（都经 `ctx.theme`）。

官方**明确不做**、正是我们价值所在的：壁纸、玻璃/不透明度、动效、会话区视觉细节。

### 1.3 与 desktop 线的边界（本项目特有，必须先定）

`dsh-miasaki-desktop/themes/` 下已有 `pure.css` / `zafkiel.css` / `kurkuriel.css`（各约 7KB，覆盖
73 个 `--dsw-static-*` 色阶 + 形态语言与装饰）与 57KB 的 `runtime.js`（属性管理/切换条/过渡/持久化/
MutationObserver 锁定明暗）。它是**桌面壳注入层**，作用于同一个 3080 页面。

三种关系可选（见 §8 的 D2）：

- **A 外观线统一接管**（推荐）：主题权威移到 web 外观插件，desktop 注入层退化为「启动页主题同步 +
  窗口级能力（标题栏、桌宠、单实例）」。收益：浏览器与桌面壳**一套主题、一处配置**；
  代价：要动 desktop 线（有回归工作量）。
- **B 各管一半**：desktop 继续管颜色，外观线只做壁纸/动效/会话效果，检测到
  `html[data-miasaki-theme]` 存在即隐藏「主题」板块。收益：零回归；代价：浏览器直连时没主题，
  且桌面壳里"外观"页少一块，体验割裂。
- **C 双轨并存**：两套都改 token。**不可接受**——必然出现"壁纸在、配色半生效"的幽灵 bug。

---

## 2. 技术底座（全部有出处，非猜测）

### 2.1 设置页扩展点：`settings.section`

活体查询（运行中的 GUI）返回：

```
kind: list, scope: root, replaceRisk: none
注册参数: id (string, 必填) / order (number) / label (string | (() => string))
owner props: { close: () => void }
```

现存占用者与官方导航顺序：

| id | order | 来源 |
|---|---|---|
| `general` | 0 | 官方 |
| `models` | 10 | 官方 |
| `plugins` | 15 | 官方 |
| `agent-presets` | 20 | 官方 |
| `free-model-pool` | 25 | 第三方（本机已装） |
| `pet-panel` | 26 | 第三方（本机已装） |

→ 我们用 `id: 'appearance'`、`order: 5`：紧跟「通用」，语义上是通用偏好的视觉延伸，且不与任何
现存 id 冲突。（**复用官方 id 会替换那一栏**，务必用自有 id。）

**注册必须两段式**（0.1.5 实测：直接 `register` 会抛 `slot "..." is not declared`）：

```js
ctx.slots.inject('settings.section', () => ctx.slots.register(
  { name: 'settings.section', id: 'appearance', order: 5, label: '外观' },
  AppearancePanel,
))
```

`label` 支持 thunk（`() => '外观'`）——本仓 ssh 线已在用该形态，locale 切换无需重注册。
注册项还支持 `children`（声明自己的子 slot）与 `inject`（给页面注入 face/hooks）——
`dsh-client-ui-custom` 用 `children: { 'settings.appearance.item': {...} }` 把官方主题偏好行
**合进自己的页**；我们**不采用**（那会让官方那两行搬家，属破坏性改动）。

### 2.2 主题与皮肤：官方 `ctx.theme` 四件套 + 一条重要否认

活体查询确证的 Client Service（`ctx.theme`）：

| 方法 | 语义 | 我们怎么用 |
|---|---|---|
| `getTheme(): ThemeSnapshot` | `{ preference, fontSize, active, themes, revision }` | 读当前明暗/字号/皮肤态 |
| `setTheme(id)` | **唯一**偏好写入口；`system` 或已注册 id，否则 throw | 「明暗偏好」控件直接调 |
| `setFontSize(px)` | **唯一**字号写入口，12–17 整数，越界 throw | 「正文字号」滑块直接调 |
| `register({ id, colorScheme, tokens })` | 注册第三方主题（alias 层覆盖）；重复 id throw；**不影响官方三立方 UI** | **不使用**（见下） |
| `overrideTokens(source, tokens)` | 叠加 token 层，值为 `{ light, dark }`；返回 disposer；同 source 再调=替换整层 | **皮肤与所有外观参数都走它** |

**否认：注册的皮肤不会出现在官方 UI。**

`dsh-client-ui-theme/lib/client.js` 的 `AppearanceRow` 明确写着：

> Appearance preference row registered into the General section item slot (figma 501:30012)：
> title + three preference cubes. … **Selection follows the persisted preference, never the resolved
> active theme.**

其实现是 `CUBES.map(...)`，而 `CUBES` 是硬编码的 `[light, dark, system]`（第 52–68 行）。
`CUBES` 之外没有任何从 `themes` 数组渲染的逻辑。推论：

- 注册 `zafkiel` 后，官方行仍是三个立方，`preference === 'zafkiel'` 时**三个都不高亮**（怪态）；
- 用户点一下官方立方 → `setTheme('light')` → 皮肤被顶掉，且用户不知道发生了什么。

**因此定案：皮肤 = `overrideTokens` 层。**

```js
// 皮肤定义（数据，不是注册项）
const SKIN_ZAFKIEL = {
  id: 'zafkiel', name: '刻刻帝', preferredScheme: 'dark',
  tokens: { '--dsw-static-…': { light: '…', dark: '…' }, … },   // 双值：明暗两套
}
```

- 选中皮肤 → `ctx.theme.overrideTokens('@miasaki/dsh-appearance', skin.tokens)`；
- 若皮肤声明 `preferredScheme`，同时 `ctx.theme.setTheme('dark'|'light')`，让官方三立方状态正确；
- 用户随时在官方页切明暗 → 皮肤自动给出对应阵营的取值（`{light, dark}` 双值天然支持）；
- 「纯净」= 不设皮肤层（只留参数层），与 desktop 线 `pure` 的"兜底语义"一致。

`overrideTokens` 的官方注释（决定了它正是为此而生）：

> Stack a token override layer on top of the active theme — the token-level analogue of slot shading:
> the base theme stays untouched, layers compose in seq order with later layers winning per-token,
> and removing a layer restores whatever it covered. … one layer per source (dynamic packages pass
> their package id — the façade pins it, so it also names the layer's origin for inspection).

→ `source` 用包名 `@miasaki/dsh-appearance`：天然唯一、可被 Inspect 溯源、**停用插件即整层回收**。

活体查询列出的官方 alias token 共 13 个（`requiresLightAndDark: true`）：
`--dsw-alias-bg-base` / `-bg-layer-1` / `-bg-layer-2` / `-bg-overlay` / `-border-l1` / `-border-l2` /
`-brand-primary` / `-label-primary` / `-label-secondary` / `-state-error-primary` / `-state-success-primary` /
`-state-warn-primary` / `--dsw-specific-sidebar-fill`。

⚠️ **但 token 名不止这 13 个**：官方 client 里有
`for (const theme of this.themes) for (const name of Object.keys(theme.tokens)) if (!tokens.has(name)) tokens.set(name, dynamicToken(name))`
—— 主题注册表的 token 集合是**动态**的。desktop 三主题靠的 73 个 `--dsw-static-*` 很可能同样可覆盖，
**这是 M1 第一优先 spike（§9-2），它直接决定 D3 的工作量**。

### 2.3 配置持久化：官方 settings 命名空间（**零补丁**）

Host 侧 `ctx.settings.register(ns, schema, { base, applies, validate })` → `SettingsScope<T>`；
命名空间必须是 **lowercase-hyphenated**（否则 `TypeError`）。

Client 侧 `ctx.settingsScope.bind({ namespace })` ——`dsh-client-ui-settings/lib/client.js:1169`，
在其上派生 per-namespace scope，读走 describe 镜像、写走 `ctx.remote.settings.mutate/update/replace`，
且**带 revision 冲突检测**（`expectedRevision`）。

**白名单已不存在**（本机 0.1.5-rc.1 全包 grep `WEB_SETTINGS_NAMESPACES` **零命中**；
`dsh-api-settings-controller/lib/index.js:429` 的 `describe()` 直接枚举全部命名空间）。
→ 只要 host 半注册了 `appearance` 命名空间，客户端就能绑定读写，**不需要改官方源码**。

在本机已验证的等价范式（`dsh-free-model-pool`）：

```js
// host：export const inject = ['settings', 'webServer']
ctx.settings.register(NS, Config, { base: {...} })
ctx.settings.get(NS) / await ctx.settings.update(NS, patch)
```

**配置放哪**（D7）：`appearance` 命名空间（进用户设置文档，可手改、可版本化、可 `describe()` 列举、
有 revision 保护）**优于**自建 `state.json`。
**但壁纸图片字节例外**：静态资产仍要 host 半注册一条同源路由（或经 `webServer.register` 提供），
因为 scope 只承载 JSON 配置。

### 2.4 首帧防闪烁：`webserver/index-inject`

官方 `dsh-client-ui-theme/lib/index.js` 的 host 半（全文 96 行，可直接照抄结构）：

```js
ctx.inject(['settings'], (settingsCtx) => { settingsCtx.settings.register('ui-theme', ThemeSettingsSchema) })
ctx.on('webserver/index-inject', (table) => {
  const section = readSection(ctx)
  table.push(bootThemeInjection(section.preference, section.fontSize))
})
```

注入行形状（`{ kind: 'script', placement: 'body' | 'head', text }`，
由 `dsh-host-webserver/lib/index.js` 渲染，`head` 的进 head、其余按 placement 插入）。
官方脚本只做三件事：`document.documentElement.style.colorScheme`、`document.body.toggleAttribute('data-ds-dark-theme', dark)`、
`document.body.style.setProperty('--dsh-content-font-size', …)`。

→ 我们的外观线**必须**同样注入一段脚本，至少写入：门控属性（`html[data-mia-active="1"]`）、
壁纸 URL 与遮罩强度、皮肤的静态色阶（若皮肤走 CSS 变量）、避免"先原生后外观"的闪白/闪色。
这是 desktop 线已有的同款纪律（「document 创建即挂属性（防闪烁）」）。

### 2.5 动效与装饰的稳定锚点：`[data-slot="..."]`

本仓已有实测结论（`dsh-0.1.5-rc1-slot-contract` §3.1–3.5）：

- `data-slot` 字面等于 slot key，**不做任何转换**；`ANCHOR_STYLE = { display: contents }`
  使包装节点不进布局，是"纯可寻址表面"；
- 锚点**恒存**（fallback / crash-face / 空态都渲染在 wrapper 内部）；
- 官方 CSS Module 类名是哈希（`centerCol` → `pI_x6G_centerCol`），**不可依赖**；
- frame 上的 `data-*` 是条件属性（`|| undefined`），**不能反推状态**。

可用锚点（实施时按需扩）：

| 目标 | 锚点 |
|---|---|
| 中栏（会话列） | `[data-slot="main"]`（`parentElement` 即中栏容器） |
| 会话视图切换区 | `[data-slot="conversation.view"]` |
| 单条消息节点 | `[data-slot="conversation.chat.node"]` |
| 侧栏 / 右栏 / 浮层 | `[data-slot="sidebar"]` / `[data-slot="rightbar"]` / `[data-shell-overlay]` |
| 输入区 / 设置面板 | `[data-slot="conversation.composer.bar"]` / `[data-slot="sidebar.settings"]` |

> 对比：`dsh-client-ui-custom` 的动效用的锚点是 `[data-chat-anchor-key]` 与
> `[role="tree"] [role="treeitem"]`——**不是官方 slot 锚点**。我们的方案更抗升级。

### 2.6 不改 shell 的边界：做不到的，与"要付代价才能做"的

1. **聊天列独立不透明度**：**已确证**（`dsh-client-ui-conversation/lib/client.js:14652`）——`.wSkVaW_root` 的根 CSS 是
   `background:var(--dsw-alias-bg-base)`，**直读基底 token、没有中间层**；`dsh-client-ui-custom` 为此加了一行
   `var(--dsw-chat-surface, var(--dsw-alias-bg-base))` 造出消费方 —— **新 token 必须有读取方**，这正是那个缺口。两条路：
   ① **不补丁**：调 `--dsw-alias-bg-base`（但它同时是**全局基底**，会连带侧栏/浮层等一切消费方）→ 粒度粗一档（默认走这条）；
   ② 把那一行并入**已存在**的 `dsh-client-ui-conversation` 补丁（一条 `replaceSubstring` 编辑），代价与该补丁相同
   （升级后需 `rebuild-baseline` + 重打）。见 D8。
2. **消息正文 HTML 渲染**（`dsh-raw-html` 的核心卖点）：需要往官方前端 bundle 注入渲染模块。**不在本线范围。**
3. **让官方 General 页显示我们的皮肤**：`AppearanceRow` 的 `CUBES` 是硬编码的，
   不改官方源码就做不到。→ 我们的皮肤只在**自己的外观页**里选（§2.2 已按此定案）。

---

## 3. 三个参考仓库的取舍

> 三者不是同类竞品，而是三个**不同维度**的参考：同类竞品（信息架构与配置项全集）、
> 动效方法论、渲染与分发工程样本。各取所长，不做整体移植。

### 3.1 `yoli-mi/dsh-client-ui-custom` —— 信息架构最直接的对标

发包型单包（`src/client/` + `src/index.ts` host 半 + `src/shared.ts` 双端契约），
命名空间 `ui-custom`，七个功能模块可白名单按需装载。

**要借鉴的**：

1. **「单一属性门控 + 变量缺省即回退」**：全部覆盖写在 `<html>` inline style，门控
   `html[data-dsu-active='1']`；中性配置时 `removeAttribute` 让全部覆盖失效。
   → **我们把它作为硬契约**：未配置的外观线对页面**零影响**（这是验收项，不是口号）。
2. **色阶锚点法**：用户只选 1 个强调色，其余 10 级由 `color-mix` 从锚点派生，再映射官方
   alias（`--dsw-alias-brand-primary` / `-button-primary-fill` / `-interactive-bg-hover-accent` /
   `-scrollbar-*`）。→ 比逐 token 配置便宜且不会色偏，**直接抄**。
3. **draft / preview / save 三段分离**：改参数即写文档会导致频繁重渲染与冲突；用 staged draft +
   不落库 preview + 逐字段 `set`/`unset`，并用 `touched` 标志解决"外部刷新 vs 未保存草稿"。
   → 调参型设置页的稳妥范式。
4. **动效实现范式**（参数见 §5.5）：纯 CSS keyframes（**全局字面类，规避 CSS Modules 哈希**）+
   一个 MutationObserver 引擎在 React 提交后、绘制前贴类；不用 Web Animations API、不包 React 层。
5. **`features` 白名单**：`resolveFeatures(raw)` 纯函数，缺省/空=全集，否则取交集并丢弃未知 id；
   过滤发生在客户端 `registerFeatures()`（首个 ready 快照后一次性求值）。
   → 对外观线的价值是"防止巨石化"。

**不借鉴的**：

- 它依赖**改过的 DSH 检出**（旧版权限：白名单 1 行 + `--dsw-chat-surface` 1 行）——我们这条走不通也不需要；
- 用"更高优先级选择器硬压主题表"赢得级联（`html[data-dsu-active='1'] body`，刻意不写 `!important`）——
  **我们有官方 `overrideTokens`**，不必打优先级战争；
- `customCss` / `customVars` 逃生舱：建议保留为「高级 · 自担风险」折叠区，**默认关闭、需显式确认**，不进预设；
- 用「DOM 查询 + 中文文案匹配」回跳设置面板（它 F2 退出预览的做法）——**脆**，我们不做；
- `autoAccent` 需 `crossOrigin='anonymous'`（否则 canvas 被污染而静默失败）——这是我们必须处理的坑，
  用壁纸派生强调色时要显式设 crossOrigin 并处理失败分支。

### 3.2 `feitangyuan/motion-web` —— 动效方法论（不搬案例）

仓库自述 `Not for dashboards, admin UI`，7 个案例全是整页创意作品（Three.js/WebGL2/Canvas）。
**案例不可迁移**，但方法论可迁移：

1. **弹簧阻尼参数表**（半隐式欧拉，`v += (-k(x-target) - c·v)·dt`，临界阻尼 `c = 2√k`）：

| preset | k | c | ζ | 收敛 | 用途 |
|---|---|---|---|---|---|
| gentle | 100 | 15 | 0.75 | ~530ms | 环境揭示 |
| default | 200 | 22 | 0.78 | ~360ms | 卡片 hover、抽屉 |
| snappy | 350 | 28 | 0.75 | ~290ms | 按钮反馈 |
| heavy | 150 | 35（m=1.5） | 1.17 过阻尼 | ~430ms | 大面板 |

CSS 近似：揭示默认 `cubic-bezier(0.16, 1, 0.3, 1)`；轻过冲 `cubic-bezier(0.34, 1.56, 0.64, 1)`；
真回弹用 `linear()` 采样（`linear(0, 0.32 8%, 0.79 20%, 1.03 30%, 1.01 46%, 1)`）。
时长梯：instant 80–100 / fast 150–200（hover/按钮）/ standard 280–350（抽屉/面板）/
medium 400–500 / slow 600–800（页面入场）。**"无法用意图列解释的时长，减半"**。

2. **禁止清单（反 AI 塑料感）**：禁无意义 `opacity 0→1`、禁线性匀速缓动、禁全页 fade-up、
   禁"每张卡片 `translateY(-4px)` + 阴影"；判定语：**"关掉全部动效后，静帧还立得住吗"**。
3. **性能纪律**：只动 `transform`/`opacity`（cheap）；`filter`/`clip-path` 中档；
   `width/height/top/left` **禁**；大 blur `box-shadow`、缩放中的 `border-radius` 最贵；
   `will-change: transform` **仅动画期间加、结束移除，绝不全局**。
4. **自动化验收判据**（`verify_case.py` 不读像素，纯 DOM + `getComputedStyle` + `getBoundingClientRect`）：
   触发后 40ms 采样证明"非硬切"、900ms 内收敛（残差阈值）、"真的在动"的量化阈值、
   帧率无关性（30/60/120fps 同脚本位置漂移 <0.5）。
   三条方法论比阈值更值钱：① 只看终态会给硬切满分，**必须 pin 状态后量中途帧**；
   ② 用真 wheel/hover 事件，`scrollTo` 会跳过到达/离开窗口；③ **每个 oracle 只编码一条具体抱怨**，
   通用"质量分"比没有测试更坏。
5. **reduced-motion 是硬项**：降级阶梯 ① 仅 opacity 200ms → ② 仅 `translateY(8px→0)` → ③ 无动效直切；
   规范要求"**这是设计过的版本，不是坏掉的版本**"；`fill-mode: both` + 触发器被禁会留下
   不可见起始态，是最常见 bug。
6. **生产级打磨清单**（可直接用于「会话效果」板块）：对话框/抽屉基线 200ms +
   `opacity + translate: 0 8px`，配 `@starting-style` 免 JS 时序；弹层锁滚动加
   `scrollbar-gutter: stable` 消除横向抖动；**状态矩阵缺一即"未完成"**
   （hover / `:focus-visible` / active / disabled / loading / error / empty / success）；
   焦点环 `outline: 2px solid; outline-offset: 3px`，**禁 `outline:none` 无替代**；
   命中区 ≥44px；hover 规则包在 `@media (hover:hover) and (pointer:fine)` 内；
   `::selection` / `accent-color` / `caret-color` 都要显式定义；重场景按可见性暂停。

### 3.3 `plolpl789/dsh-raw-html` —— 工程样本（会话效果与字体）

**要借鉴的**：

- **字体分发模式**：7 款 OFL 字体（woff2 子集，共约 7.6MB）随插件分发、零配置即用，
  另有子集化工具链（Python + fonttools + brotli）。→ 我们的「会话效果 · 正文字体」复用该模式，
  但**按需从 1–2 款起步**，避免仓库膨胀。
- **双开关分层**：渲染 / 美学独立，渲染关时美学**强制关**（能力依赖链）→ 抄到我们的「总开关 → 分项」。
- **降级路径明确**：关闭即"回到普通 Markdown"，与 `dsh-client-ui-custom` 的
  「所有功能默认关闭，不配置时保持与原生界面一致」是同一承诺。
- **性能纪律**：它的 vcp-fast 引擎（块级缓存 + 增量渲染）说明渲染层性能是真问题；
  我们的壁纸 + `backdrop-filter` 同理，M2 就要建帧率基线。
- **文档纪律**：一规则一权威源，其余位置只挂指针。

**不借鉴的**：打 bundle 补丁；可信模式（放行消息正文 `<script>`，安全边界，本线不碰）。

### 3.4 三者对照

| 维度 | client-ui-custom | motion-web | raw-html | 我们的取法 |
|---|---|---|---|---|
| 设置页信息架构 | ★★★ 直接对标 | — | — | 抄架构与配置项全集 |
| 配置落地方式 | 硬压选择器 | — | 打补丁 | **换官方 `overrideTokens`** |
| 持久化 | settings 命名空间 | — | 自建 state.json | **官方 settings scope** |
| 动效 | 有实现与参数 | ★★★ 方法论与判据 | — | 参数+范式取前者，验收取后者 |
| 字体分发 | 仅 `fontFamily` 字符串 | 子集化工具 | ★★★ 随包分发 | 抄分发模式，按需起步 |
| 补丁侵入性 | 需改检出源码（2 处） | 无 | 需打压缩 bundle 补丁 | **不新增；必要时并入既有官方包补丁链** |

---

## 4. 本项目特有的冲突与风险

| # | 风险 | 说明 | 处置方向 |
|---|---|---|---|
| R1 | **主题双头** | desktop 注入层与外观线都改 token → "配色半生效"幽灵态 | 先定让位协议（§7），推荐 D2-A |
| R2 | **hashed class 不稳定** | 官方类名带哈希，依赖它升级即碎 | 只挂 `data-slot` 锚点 + 自有 `.mia-*` 前缀 |
| R3 | **动效重放** | React 复用节点时 CSS 动画不重放（切会话/切视图） | 解法已确认可用：**去类 → `void offsetWidth` 强制重排 → 加类**（client-ui-custom 的 `motion.ts` 实践）；M3 用我们的锚点复现 |
| R4 | **性能** | 壁纸 + `backdrop-filter` 在长会话滚动下易掉帧；合成层过多反向拖慢 | 只在必要层用 `backdrop-filter`；`will-change` 用完即撤（绝不全局）；M2 建帧率基线 |
| R5 | **多线共存** | canvas（z-index 100）、sidebar（官方右栏）、ssh（`conversation.view`）、dual-model（输入框右下）会与全屏壁纸层/动效层抢层级 | 定层级契约（§7）；壁纸层 `pointer-events: none` 且 z-index 最低 |
| R6 | **升级脆弱性** | dsh 升级可能改 slot key / token 名 / theme API | **启动契约自检**：探测关键 slot 与 token，缺失即降级该板块并在设置页显示黄条（不静默失败） |
| R7 | **无前端测试基建** | 本仓测试都在 node 侧；主题/动效是纯浏览器行为 | 用本机 profile 已装的 Playwright 做无头验收（§5.5），产物归档 `_refs/` |
| R8 | **无障碍与可读性** | 低对比壁纸、动效伤可读性 | 继承 desktop 线承诺：正文对比 ≥ 4.5:1、装饰不承载信息、reduced-motion **强制**降级（不可关闭） |
| R9 | **首帧闪烁** | 配置异步到达 → 先原生后外观 | §2.4 的 `index-inject` 内联脚本 |
| R10 | **`autoAccent` 静默失败** | 跨域壁纸进 canvas 会被污染 | 显式 `crossOrigin='anonymous'` + 失败分支回落到手选色 |

---

## 5. 方案设计

### 5.1 信息架构：外观页四板块

```
设置 → 外观                                    [ id: appearance, order: 5 ]
├─ 主题     皮肤（纯净 / 刻刻帝 / 狂狂帝 / …）      ← overrideTokens 层
│          明暗偏好（浅 / 深 / 跟随系统）           ← 官方 setTheme
│          强调色（色板 + 取色 + 从壁纸派生 · 色阶锚点法）
│          正文字号                              ← 官方 setFontSize
│          预览（小窗 / 全屏）
├─ 壁纸     图源（内置 / 本地目录 / URL-高级）
│          填充方式、焦点、亮暗双壁纸
│          玻璃档位（关 / 轻 / 毛玻璃 / Mica）+ 自定义模糊半径
│          暗色遮罩、渐变叠加、内嵌晕影
│          表面不透明度（侧栏 / 会话列 / 输入框 / 代码块 / 浮层）
├─ 动效     总开关 · 三套预设（流畅 / 优雅 / 极简）· 强度倍率
│          分项：会话入场 / 侧栏 / 新会话 / 设置面板 / 视图切换
│          每项：开关 + 样式选择；全局：尊重系统减弱动态（强制）
└─ 会话效果 消息密度、最大宽度
           流式光标样式、流式渐入
           代码块（主题 / 圆角 / 行号）、引用与表格样式
           工具卡折叠策略
           字体（正文 / 等宽）
```

每板块底部「恢复本板块默认」；页头「全部恢复默认」。

### 5.2 配置模型

- 命名空间：`appearance`（lowercase-hyphenated ✔）
- 三层合并：`DEFAULTS ← 预设(可选) ← 用户配置`，每字段钳制
- 结构：`{ version, theme: {…}, wallpaper: {…}, motion: {…}, conversation: {…} }`
- `applies: 'live'`（配置实时生效）；壁纸文件扫描除外（手动刷新/轮询）
- **版本迁移**：`version` 字段 + 迁移函数链（避免"旧配置 + 新字段"的空白）
- **预设导出/导入**：一段 JSON（M5）
- **写路径**：逐字段 `set`/`unset`，带 `expectedRevision`；draft/preview/save 三段分离（§3.1-3）

### 5.3 应用管线（单向下行）

```
settings 文档 ──▶ host index.js (ctx.settings.register) ──┬─▶ index-inject 内联脚本（首帧：门控 + 壁纸 + 关键色）
                                                          └─▶ client: settingsScope.bind('appearance')
                                                                   ↓
                                     client: normalize（钳制/默认值/迁移） ──▶ apply()
                                                                   ├─▶ ctx.theme.overrideTokens(pkgId, tokens)   皮肤 + 参数
                                                                   ├─▶ ctx.theme.setTheme / setFontSize          偏好
                                                                   ├─▶ <html> 上的 data-mia-* 与 --mia-* 变量
                                                                   └─▶ <style id="mia-appearance-css">            动效与装饰
```

所有副作用都在 `ctx.effect(...)` 里注册（返回 disposer）。**停用插件 → token 层回收、
样式节点移除、`data-*` 属性清除 → 界面必然回到原生**（验收项）。

### 5.4 主题引擎：参数层为主，注册表不用

| 层 | 机制 | 管什么 | 生命周期 |
|---|---|---|---|
| **皮肤层** | `overrideTokens(source, skin.tokens)` | 整套配色（刻刻帝/狂狂帝/纯净），值为 `{light, dark}` 双套 | 与插件同生共死 |
| **参数层** | `overrideTokens(source, paramTokens)` | 壁纸遮罩、表面不透明度、强调色派生链、玻璃 | 改配置即重设 |

**为什么合成一层**：`overrideTokens` 一个 source 一层，同 source 再调=**替换整层**。
所以皮肤与参数用**两个 source**（`@miasaki/dsh-appearance/skin` 与 `…/params`），
互不踩踏、可分别回收。「纯净」= skin 层设为空（等价于移除）。

**为什么不注册进 `ctx.theme.register`**：见 §2.2——注册了也不会出现在官方 UI，
还会与官方三立方产生"互顶"的怪态。

**强调色派生（色阶锚点法）**：用户只选一个强调色 → `color-mix` 派生 10 级色阶 →
映射官方 alias（`--dsw-alias-brand-primary` 等）。从壁纸取色时显式 `crossOrigin='anonymous'`，
失败回落手选色（R10）。

### 5.5 动效引擎与规格

**实现**：纯 CSS（`@keyframes` + CSS 变量），配置改的是**变量值**而不是重写规则 → 切预设零重建；
一个 MutationObserver 在 React 提交后、绘制前给目标贴类；锚点只用 `data-slot`（§2.5）。

**规格（可验收的数值，来源见 §3.1/§3.2）**：

| 项 | 取值 |
|---|---|
| 时长梯 | fast 160ms（hover/按钮）· standard 300ms（面板/抽屉/设置）· medium 420ms（新会话大表面）· 会话消息 240–300ms · 侧栏 280ms |
| 缓动 | 揭示 `cubic-bezier(0.16, 1, 0.3, 1)`；轻过冲 `cubic-bezier(0.34, 1.56, 0.64, 1)`；**禁 linear** |
| 位移/缩放 | 位移 4–12px；缩放 0.97–0.99；**不允许只有 opacity 的入场** |
| 错峰 | `staggerDelay = min(i * 40, 320)ms`，按文档序保证自上而下 |
| 强度倍率 | 用户滑块 0.5×–1.5×，作用于所有 duration（`--mia-dur-scale`） |
| 重放 | 去类 → `void offsetWidth` → 加类 |
| reduced-motion | 全部入场统一改绑 100ms 淡入、delay=0（去位移去错峰）；面板/选中框 `animation: none` |
| 性能 | 只动 `transform`/`opacity`；`will-change` 仅动画期间 |

**禁止清单**（硬约束，写进代码注释与验收）：无意义 `opacity 0→1`、线性缓动、全页统一
`0.3s ease`、每张卡片同款上浮、用动效掩盖层级问题。

**Playwright 验收断言**（M3 交付判据，取 motion-web 的 oracle 思路）：

1. **真的在动**：触发后 40ms 采样，目标元素位移 ≥ 2px 或缩放差 ≥ 0.005；
2. **会收敛**：900ms 后残留位移 ≤ 2px，且 `getComputedStyle` 无残留过渡；
3. **错峰单调**：相邻元素的实际起始时间差 > 0 且 ≤ 60ms；
4. **末态无残留**（reduced-motion 下最重要的一条）：全文档 `opacity: 0` / `visibility: hidden` 计数为 0；
5. **reduced-motion 生效**：模拟 `reduce` 时，位移为 0 且总时长 ≤ 150ms；
6. **关闭即原生**：总开关关闭后，静帧截图与原生截图 diff = 0；
7. **无 console error / pageerror**。

### 5.6 「会话效果」的界定（先划死，否则膨胀）

**属于本线**：会话区的**视觉与动效表现**——密度/宽度、流式光标、代码块与引用/表格样式、
工具卡折叠策略、字体。全部通过 CSS 与 `data-slot` 锚点实现，**不改消息数据与渲染逻辑**。

**不属于本线**（明确排除）：

- 消息内容渲染（Markdown/HTML/公式）→ 不碰（属补丁路线）；
- 工具卡的功能性（有哪些按钮、点了做什么）→ 不碰（工具插件所有）；
- 会话数据与投影（标题、用量、统计）→ 不碰（属 token-monitor / 官方）；
- 会话头第一行视图入口（ssh 线已占）、会话布（canvas 线）、右栏 tab（sidebar 线）→ 不碰。

### 5.7 壁纸管线

- **图源**：① 内置（随包分发 2–4 张原创）；② 本地目录 `~/.dsh/miasaki-appearance/wallpapers/`
  （host 半扫描 + 同源路由提供字节）；③ 远程 URL（默认隐藏，需显式开启并提示隐私/离线代价）。
- **格式**：优先 webp；单张建议 ≤ 2MB；host 半**只允许白名单目录内文件**（防路径穿越）。
- **亮暗双壁纸**：`wallpaper.light` / `wallpaper.dark`，`system` 偏好下随 OS 切换。
- **落点**：`position: fixed; inset: 0; z-index: -1; pointer-events: none` 的壁纸层（挂在 `body` 下、
  不进 frame）；半透明表面透过 `backdrop-filter` 显影。
- **层级纪律**：壁纸层 z-index 低于所有线（含 canvas 的 100）。

---

## 6. 落点与分期路线

| 期 | 内容 | 验收判据 |
|---|---|---|
| **M1 底座 + 契约自检** | 新线骨架；`appearance` 命名空间与 schema；`settingsScope` 绑定；外观页空壳挂 `order: 5`；`index-inject` 防闪烁脚本；**契约探针**（slot / theme API / token 存在性）；desktop 让位协议落地或先只做检测 | 设置里出现「外观」栏；配置读写往返一致且 revision 冲突可复现；**停用插件后页面与原生截图 diff = 0**；契约缺失时显示黄条而非崩溃 |
| **M2 主题 + 壁纸** | 三皮肤转为 `{light,dark}` token 表并下沉；参数层（强调色派生 / 不透明度 / 遮罩 / 晕影）；壁纸层与图源；玻璃档位；预览 | 3 皮肤 × 明暗 × 有/无壁纸 = 12 组截图全绿；滚动 60s 帧率 p95 不低于基线 10%；对比度抽检 ≥ 4.5:1；首帧无闪烁（录屏逐帧核） |
| **M3 动效** | CSS 动效层 + `data-slot` 锚点 + 三预设 + 强度 + 重放 + reduced-motion 降级 | §5.5 的 7 条 Playwright 断言全绿 |
| **M4 会话效果 + 字体** | 密度/宽度、流式光标、代码块/引用/表格、工具卡折叠、1–2 款字体子集 | 与四条既有线（canvas/sidebar/ssh/dual-model）联合回归截图；字体加载失败明确回落系统字体 |
| **M5 打磨** | 预设导出/导入、配置版本迁移、契约自检面板、「全部恢复默认」、README/CHANGELOG/设计文档定稿 | 升级 dsh 到下一版后跑一次契约自检与全量回归 |

**贯穿原则**：每期都必须满足「**关掉就与原生完全一致**」——这是本线的唯一硬承诺，
也是与官方长期共存的前提。

---

## 7. 与既有线的接口协议（建议写进各线 README）

| 相对方 | 协议 |
|---|---|
| **desktop 主题引擎** | 待 D2 拍板。若选 A：`runtime.js` 停止修改 `--dsw-static-*`，只保留启动页主题与窗口能力；外观线成为唯一主题权威。若选 B：外观线检测 `html[data-miasaki-theme]` 存在即隐藏「主题」板块，两引擎互斥。**唯一不可接受的是两者同时写 token。** |
| **官方 ui-theme** | 明暗与字号一律经 `ctx.theme.setTheme / setFontSize`；不写 `body[data-ds-dark-theme]`（那是官方 bootstrap 的所有权）；不注册 `ctx.theme.register`（§2.2）；不搬动官方 General 页那两行。 |
| **canvas** | 外观层 z-index 恒低于 canvas 全屏层（100）；动效不作用于 canvas 容器；壁纸层 `pointer-events: none`。 |
| **sidebar** | 不动官方右栏几何；动效只作用于 `[data-slot="sidebar"]` / `[data-slot="rightbar"]` 容器本身，不逐个 tab 正文加动画。 |
| **ssh / token-monitor** | 不接管 `conversation.view` 与 `conversation.session.header.*`；容器级动效不得影响其内部交互（过渡期间不锁 `pointer-events`）。 |
| **dual-model** | 不动 `conversation.input.right`；输入框不透明度只做背景层，不改控件可见性。 |
| **pet-panel / free-model-pool** | 同占 `settings.section`，互不影响（不同 id）；外观页不动 `settings.general.item`。 |
| **本体补丁链** | 外观线**默认不新增**补丁。若确需（D8），规则只进 `dsh-miasaki-desktop/patches/<包名>/`（本仓唯一住处），必须 `node patch.mjs verify` 自证、`rebuild-baseline.mjs` 更新基线，并同步 `scripts/verify-all.mjs` 与设计文档。 |

---

## 8. 待拍板清单（D1–D7）

| # | 抉择 | 选项 | 推荐 | 理由 |
|---|---|---|---|---|
| **D1** | 落点 | ① 新线 `dsh-miasaki-appearance` ② 并入 desktop 线 ③ 并入 sidebar 线 | ✅ **① 已拍板** | 本仓多线互不耦合；外观是 web 侧能力，与 Tauri 壳职责不同；并入任一线都会拖累那条线的节奏 |
| **D2** | 主题权威 | A 外观线接管（desktop 让位）/ B 各管一半 / C 双轨 | ✅ **A 已拍板** | 浏览器直连也有主题、一处配置；B 导致"桌面里少一块、浏览器里没主题"的割裂；C 必然出幽灵 bug |
| **D3** | 主题内容 | ① 下沉 desktop 三主题 ② 重画 web 专属 ③ 不做全色阶，只做壁纸+强调色 | ✅ **① 已拍板（以 §9-2 通过为前提）** | 三主题已完工（73 色阶 + 形态语言 + 装饰 + 对比度承诺），重画是纯浪费；**前提是 `overrideTokens` 接受 `--dsw-static-*`**，否则退回"自建样式表 + 高特异性" |
| **D4** | 动效实现 | ① 纯 CSS + 变量 ② 引入 JS 弹簧求解 | **①** | 应用内 UI 动效以入场/过渡为主，CSS 足够；且本仓 client 半**不能 require 第三方包**（只能 react），引库要额外评估 |
| **D5** | 壁纸图源 | ① 内置 + 本地目录 ② 仅 URL ③ 全要 | **①，URL 作高级可选项** | 与 desktop"零网络请求"哲学一致；URL 涉及隐私与离线可用性 |
| **D6** | 会话效果范围 | 见 §5.6 | **按 §5.6 划死** | 不划边界就会膨胀成第二个产品，并与四条既有线抢地盘 |
| **D7** | 配置持久化 | ① 官方 `ctx.settings` 命名空间 ② 自建 `state.json` | **①**（壁纸字节走同源路由） | 外观是"用户设置"而非业务数据；进设置文档可手改、可版本化、可 `describe()` 列举，且 0.1.5 已无白名单限制 |
| **D8** | 是否为「聊天列独立不透明度」打补丁 | ① 不打，接受粗粒度 ② 并入**已存在**的 `dsh-client-ui-conversation` 补丁 | **①（M2 先不做）**；M5 若确有需求再评估 ② | 补丁是「不修改 DSH 本体」原则的例外，代价明确（升级覆盖需重打）；先用粗粒度验证这个旋钮的需求是否真实，避免为一个小控件背上长期维护成本 |

---

## 9. 开放问题与 M1 spike 清单

| # | 问题 | 为什么重要 | 状态 |
|---|---|---|---|
| 1 | 官方三立方是否读注册表 | 决定皮肤走 register 还是 overrideTokens | ✅ **已确证**：硬编码 `CUBES`，不读注册表 → 走 overrideTokens |
| 2 | **`overrideTokens` 能否覆盖 `--dsw-static-*` 色阶** | **直接决定 D3 的工作量与可行性** | ✅ **源码已确证**（`dsh-client-ui-theme/lib/client.js:1364-1442`）：`validateOverrides` **只校验值的形状**（必须是 `{light,dark}` 字符串对，裸字符串会抛教学设计式错误），**对 token 名零白名单**；`composeActive` 按 `active.colorScheme` 取值合成；`ThemePresenter.apply`（`dsh-client-ui-layout/lib/client.js:466-481`）把每个 token 写成 `body.style.setProperty(name, value)` —— **inline style 压过 `body{--dsw-static-…}` 样式表**。→ **可覆盖，D3 成立**。⏳ 运行期实测进行中（探针 `probe-1`） |
| 3 | 0.1.5 是否仍要求 settings 命名空间白名单 | 决定是否需要打补丁 | ✅ **双重确证**：源码层面 `settingsController.describe()` 全量枚举无过滤；**实测**（本机探针）`settings.describe()` 返回 **15 个命名空间**，第三方 `browser-playwright` / `web-search-deepseek` / `llm-pi-ai` 与官方并列 → **零白名单，零补丁** |
| 4 | `overrideTokens` 与我们的两个 source 的叠加顺序 | 决定皮肤层与参数层谁赢 | ✅ **源码已确证**：`composeActive` 按 `layer.seq` 升序合成、**后者赢 per-token**；同 source 再调 = 替换整层并**重新置顶**（旧 disposer 变 no-op）。→ 先注册 skin、后注册 params，则 **params 优先** |
| 5 | client 半注入 `ctx.theme` / `ctx.settingsScope` 的写法与缺失时的降级 | 决定首版骨架 | ✅ **实测通过**：`ctx.get('settingsScope')` 可用，`bind({ namespace })` 返回 scope 对象，**读接口是 `getSnapshot()`** → `{ status:'ready', value, base, user, revision, writable:true, mode:'host' }`；scope 实例自有属性：`ctx, spec, mirror, persistence, schema, store, tail, writeGeneration, disposed, unsubscribe, pendingRevision`（`set`/`unset` 在原型上，首日实施时确认）。`theme` 同样可用（§9-2 实测） |
| 6 | R3 动效重放：`data-slot` 锚点下"去类→重排→加类"是否有效 | 决定动效可用性 | ⏳ 社区实践可行（§3.1），需在我们的锚点上复现 |
| 7 | R4 性能基线：壁纸 + 毛玻璃下长会话滚动帧时长 | 决定默认参数 | ⏳ 先测原生基线 |
| 8 | `index-inject` 注入行的字段与 placement | 决定防闪烁实现 | ✅ **源码已确证**（`dsh-host-webserver/lib/index.js` 的 `renderRow`/`renderIndexInjections`）：支持 6 种行 —— `global`(head) / `script`(按 `row.placement`) / `script-src` / `script-preload`(head) / **`style`(head)** / `html`(按 placement)；head 行紧跟开 head 标签、body 行紧跟开 body 标签，各组按表顺序，最后追加 `__DSH_BOOT_READY__` 尾巴。→ 我们**可用 `style` 注入首帧 CSS**（壁纸层 + 皮肤色阶，无需 JS）、用 `script` 注入门控属性 |
| 9 | 用户设置文档路径与手改后的热更新 | 决定"手改配置"体验 | ✅ **路径已实测**：`settings.prepareDocument()` → `C:\Users\Asakii\.dsh\settings.yaml`；⏳ 手改后的热更新行为待验证 |
| 10 | 官方 `ConversationRoot` 是否已有可用的表面 token 读取点 | 决定 D8 是否需要补丁 | ✅ **已确证**（`dsh-client-ui-conversation/lib/client.js:14652`）：`.wSkVaW_root{background:var(--dsw-alias-bg-base)}` —— **直读基底 token，没有中间层** → 「聊天列独立不透明度」**必须打补丁**（D8 代价确认）。**附带收获**：会话区已有官方可调变量 `--dsh-chat-content-width`（可由 `--dsh-chat-user-width` 派生）/ `--dsh-composer-card-max-width` / `--dsh-conversation-column-width` —— 「会话效果 · 最大宽度」**无需补丁**即可实现 |

### 9.1 动态探针的能力边界（本次 spike 的副产物，将来复用请先读）

用动态 Cordis 插件做外观类验证时，以下边界是**实测撞出来的**，不是文档写的：

| 边界 | 实测事实 | 后果 |
|---|---|---|
| **Client 半是强受限环境** | Builtin 只有 `ctx` / `React` / `host` / `styles` / `console` —— **没有 `document`、`window`、原生计时器、`getComputedStyle`、`requestAnimationFrame`** | 「读页面计算样式、测帧率、滚动测量、在真实 `[data-slot]` 节点上挂动画」**都做不了**；这类验证必须留给正式插件 + Playwright（§9-6/§9-7 因此顺延到 M1 实施期） |
| **受限 ctx 的服务访问规则** | `ctx.get(name)` 不要求声明；`ctx.name` 要求 `inject` 声明；未知名服务抛教学错误；只有 `slots` 与 `theme` 有专门 guard（`dsh-cordis-client-runner/lib/client.js:319-343`） | 服务可见性可探测，但不能把受限 ctx 的可见范围直接外推到正式插件 |
| **`theme.overrideTokens` 的 source 被强制改写** | 动态插件里被改写为 `${pluginId}.${packageId}`，且 disposer 被额外挂到 fiber 上（注释原文：*a dynamic package can never impersonate (or evict) another source's layer*） | **动态插件里多次 `overrideTokens` 共享同一层，后一次整体替换前一次**，无法用多 source 做分层实验；**正式插件直接拿真服务、不受此限** → 我们的 skin / params 双 source 设计**成立** |
| **Host 半 Builtin 很少** | 只有 `ctx` / `harness` / `console` / `btoa` / `atob` / `TextEncoder` / `TextDecoder` | 没有文件能力 |
| **动态 Host 的 `fs.writeText` 被沙箱拒绝** | 实测 `cannot write …: file access denied under workspace-write mode`（即使目标是工作区内路径） | 别指望探针直接落盘 |
| **取数首选：同源路由** | Host 半 `ctx.effect(() => webServer.register({ kind:'exact', path, handler }))` 起一条路由，再用本机 HTTP 读取 | ⚠️ 两条配套经验：① `web_fetch` 工具**拒绝私有 IP**，要用 pwsh 的 `Invoke-RestMethod`；② 同一路径**二次注册会抛 `duplicate exact route`**（update 新 Package 时旧路由仍在），换路径即可 |
| **服务注册必须挂 `ctx.effect`，否则泄漏** | 实测教训：某版探针直接调用 `web.register(...)`、**没有** `ctx.effect(() => …)` 包裹 → 插件 `undefine` 之后那条路由**仍在响应 200**（响应体是旧闭包里的数据），且已无 disposer 可回收，只能靠重启 dsh 清除 | **动态插件里任何 Service 注册都要 `ctx.effect(() => service.register(...))`**；技能文档那句「Retain disposers returned by Cordis Service…」是硬要求，不是建议 |

---

## 10. 下一步（D1 / D2 / D3 已拍板）

1. **M1 spike —— 下一步动作**（只读探针，不改仓库代码）。优先级：
   §9-2（`overrideTokens` 能否覆盖 `--dsw-static-*`，**决定 D3 成败**）→ §9-4（两层叠加顺序）→
   §9-5（client 半注入 `ctx.theme` / `ctx.settingsScope` 的写法）→ §9-6（`data-slot` 锚点上的动效重放）→
   §9-7（性能基线）→ §9-8（`index-inject` 的 placement 行为）。
   做法沿用 `dsh-0.1.5-rc1-slot-contract` §8.1 的既有套路：`DSH_HOME` 指向隔离实例 +
   临时探针插件 + Playwright 无头 chromium 回读；产物归档 `_refs/`，**用完即删**。
2. spike 结论回填本文 §9；若 §9-2 不通过，D3 退回"自建样式表 + 高特异性"，并重估 M2 工作量。
3. 建线 `dsh-miasaki-appearance/`：骨架（`index.js` / `client.js` / `cordis.patch.yml` /
   `package.json` / `README.md` / `design/` / `test/`）+ profile 的 `link:` 依赖与 `bundles` 行；
   同步 `AGENTS.md`（六线 → 七线）与根 `README.md`。
4. 本文迁入 `dsh-miasaki-appearance/design/`，起草 M1 实施文档后开工。
