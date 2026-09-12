# M2 实施设计：主题皮肤下沉 + 壁纸层与玻璃档位

- 日期：2026-09-12
- 状态：**设计定稿，待拍板后开工**（本文不含实现代码）
- 上游：[规划设计与方向选型](2026-09-11-appearance-settings-plan.md) §6 的 M2 行、§7 让位协议、§9-2 取证
- 前序：[M1 实施](2026-09-11-appearance-m1-design.md)（已实机验证，基线 38 例 / `appearance` 10/10）
- 目标（源自规划 §6）：三皮肤转为 token 表并下沉；参数层（强调色 / 不透明度 / 遮罩 / 晕影）；
  壁纸层与图源；玻璃档位；预览
- 本轮的三个指定交付：**色阶清单**（§2）、**让位判定**（§4）、**boot style 防闪色**（§6）

---

## 0. 一页结论

> **2026-09-12 大修正（S3 开工前复核）**：本文初版 §1.1/§1.2 对官方 token 定义位置的取证
> **有误**（误记 alias 定义在 `:root`）。S3 开工前复读 vendor 源码 + 实机实验定案：
> **官方全部 token（static 与 alias）都声明在 `body` 上**，body inline 覆盖 static **能**
> 回溯影响同元素上声明的 alias —— 规划 §5.4 的原始设想「皮肤 = 73 个 static 单值」
> **成立**，且远比初版的 alias 派生方案简单。被推翻的原论证已归档 git 历史。

| # | 结论 | 依据 |
|---|---|---|
| **1** | **「只下沉 73 个 `--dsw-static-*` 单值」成立**——alias 与 static 同声明在 body，`var()` 替换读同一元素的级联值，body inline 覆盖 static 后 alias **即时跟随** | §1.2 实机实验：覆盖 `-950` 后 `--dsw-alias-bg-base` 从 `#151517` → `#ff0000`，清理即恢复 |
| **2** | static 色阶**基本明度中立**（官方 dark 段 73 个里仅 `-60` 一个有值差、属明度微调）——皮肤单套色阶覆盖双明暗，明暗语义由 alias 层端点选择承载 | §1.4 实测 diff：72/73 同值 |
| **3** | **S3 = skin.css 直接编译**（73 static + 25 组件自有 + 6 半透明 alias + 1 品牌 alias ≈ 105 token → `{light,dark}` 同值对），**无 alias 派生**；初版 A/B/C 分类作废（§2 存档于 git） | §2 修正版 |
| **4** | 让位判据 = `html[data-mia-appearance="on"]` **且** `data-mia-skin ≠ pure`；desktop 侧只需**停注入 skin CSS + 停明暗锁定**，装饰层与 `--ms-*` 全保留 | §4：desktop 的 `apply()` 本就是整块替换 `styleEl.textContent`，拆分后让位是"少注入一段"而非"改一套逻辑" |
| **5** | boot style 用**属性选择器覆盖双明暗**（`body` / `body[data-ds-dark-theme]`），零 JS 时序依赖 | §6：官方明暗由 `body` 属性驱动，CSS 选择器天然动态匹配，不需要在首帧脚本里猜偏好 |

**一句话方案（修正版）**：把 desktop 的 `*.skin.css` **直接编译**为 `overrideTokens` 的
`{light,dark}` 同值对，皮肤以 `overrideTokens` 两层（skin / params）落地，首帧由
`index-inject` 的 `style` 行注入同一份 token 文本防闪色；desktop 注入层按判据让出
色阶与明暗所有权，保留装饰与窗口能力。

---

## 1. 取证：官方主题层的真实结构（2026-09-12 修正版）

### 1.1 四个顶层块全在 `body` 上（实读 vendor 源码）

`ui-theme/src/styles/design-platform.css`（338 行）：

| 块 | 选择器 | 行 | 内容 |
|---|---|---|---|
| 1 | `body` | L4–78 | `--dsw-static-*` 色阶（light 基准）**73 个** |
| 2 | `body[data-ds-dark-theme]` | L80–154 | 同一批 static 的 dark 覆盖（73 个，**与 light 仅 1 个值差**，见 §1.4） |
| 3 | `body` | L156–246 | `--dsw-alias-*` + `--dsw-specific-*`（light 套，值含 `var(--dsw-static-*)`） |
| 4 | `body[data-ds-dark-theme]` | L248–338 | 同上的 dark 套 |

**没有 `:root` 段**。实机佐证：`getComputedStyle(html).getPropertyValue('--dsw-alias-bg-base')`
= 空串（alias 不在 html 上）；`getComputedStyle(body)` 读得到全部 token。

### 1.2 解析机制与实机定案（推翻初版 §1.2）

`ThemePresenter.apply()`（`ui-layout/src/client/theme-presenter.ts:37-51`）把 `overrideTokens`
层写成 **`body.style`（inline）**。

**关键机制**：CSS 自定义属性的 `var()` 替换发生在**声明元素**的计算值阶段——alias 与 static
**同声明在 body** 时，alias 的 `var(--dsw-static-X)` 读的是 **body 元素上级联后的 static 值**
（inline style > stylesheet 声明）。因此 body inline 覆盖 static **能**回溯影响 alias。

**实机实验（2026-09-12，DSH 0.1.5-rc.1 真页）**：

```js
getComputedStyle(body).getPropertyValue('--dsw-alias-bg-base')   // '#151517'（dark 基准）
body.style.setProperty('--dsw-static-neutral-bluish-950', '#ff0000')
getComputedStyle(body).getPropertyValue('--dsw-alias-bg-base')   // '#ff0000' ← 回溯成立
body.style.removeProperty('--dsw-static-neutral-bluish-950')
getComputedStyle(body).getPropertyValue('--dsw-alias-bg-base')   // '#151517' ← 恢复
```

**初版论证错在哪（一句话存档）**：初版依据「alias 定义在 `:root`、其 `var()` 在 html 上已解析完」
推出「body 覆盖 static 无法回溯」——该前提是按 `:root` 关键字 grep 造成的误读，四个块全在 body。
由此推出的「必须下沉 alias 层 / A 类 67 个派生」整套复杂化作废。desktop 线
`html[z], html[z] body` 双目标选择器的真实作用：html 上的 static 定义在 web 侧无 alias 可影响，
属注入层的历史冗余保险。（官方注释 *"third-party themes register alias-layer overrides"*
（`ui-theme/src/client/index.ts:140-144`）描述的是**建议形态**，不是机制限制——
`validateOverrides` 对 token 名零白名单，写 static 同样合法生效。）

### 1.3 `overrideTokens` 的运行时语义（源码确证，不变）

`ui-theme/src/client/index.ts:281-359`：

| 事实 | 影响 |
|---|---|
| `validateOverrides` **只校验形状**：每个值必须是 `{light: string, dark: string}`，裸字符串抛教学错误 | token 名**零白名单**（任意名可覆盖）；值必须是双值对 |
| `composeActive`：`tokens[name] = modes[active.colorScheme]` | 双值按**当前生效明暗**取单值；`system` 偏好下由 `matchMedia` 解析后再取 |
| 层按 `seq` 升序合成，**后者赢 per-token** | 先注册 skin、后注册 params ⇒ params 优先 |
| 同 `source` 再调 = **替换整层并重新置顶**（seq 递增），旧 disposer 变 no-op | skin / params 必须用**两个 source**，否则互相顶掉 |
| presenter 每次 `apply` 先 `removeProperty` 全部上次写入的 token 再重写 | 明暗切换**无残留**；我们的覆盖层随官方 revision 全量重写 |
| `dispose()` 回收 `color-scheme` / `body[data-ds-dark-theme]` / 全部 token / 自有 meta | 停用插件即整层回收 ✅ |

### 1.4 static 色阶基本明度中立（修正：dark 段存在但 72/73 同值）

实测 diff `body` 段与 `body[data-ds-dark-theme]` 段的 static：73 个中**仅**
`--dsw-static-neutral-bluish-60`（`rgb(245,246,247)` → `rgb(249,250,251)`，明度微调）不同。
→ 皮肤**单套色阶**即可覆盖两段（`{light,dark}` 同值），明暗语义由 alias 层端点选择承载。

两张皮肤色阶表两端都在（00 最亮 → 1000 最暗的同向梯度）——zafkiel 在 light 下自动呈现
「浅紫白底 + 深紫黑字」，kurkuriel 在 dark 下自动呈现「暖褐黑底 + 骨白字」
（**刻刻帝·昼 / 狂狂帝·夜**，无需额外设计，12 组矩阵零设计成本）。

---

## 2. S3 编译清单（修正版——初版 A/B/C 分类作废）

> 初版按「值含 `var(--dsw-static-*)`」把官方 alias 分为 A（67 自动派生）/ B（2 显式）/
> C（18 沿用官方）三类并设计派生算法——该路线基于 §1.2 的错误前提，**整套作废**
> （原文见 git 历史；其「24 个组件自有变量需显式设计」的清单仍然有效，并入下表）。

**修正后的 S3 = skin.css 直接编译**（无需 design-platform.css 做派生源，只做校验参照）：

| 组 | 数量 | 来源 | 编译产物 |
|---|---|---|---|
| static 色阶 | 73 | `{skin}.skin.css` 主体块 | `{light: v, dark: v}` 同值对 |
| 组件自有（shiki 11 + json-tree 7 + scrollbar 2 + hovercard 1 + think 渐变 2 + code-banner 1 + state-ongoing 1） | 25 | 同上 | 同值对 |
| 半透明 alias（`bg-base` / `sidebar-fill` / `bg-layer-1/2` / `bg-module-platform` / `bg-overlay`） | 6 | `{skin}.skin.css` 尾块 | 同值对（无壁纸时的默认表面透明度；有壁纸时被 params 层旋钮覆盖） |
| 品牌 alias 重定向（`--dsw-alias-brand-primary-new-colorprimary-new-color`） | 1 | 同上主体块（var 形态） | **编译时把 var 替换为皮肤值**后输出 |
| **合计** | **105** | | |

**为什么 static 覆盖足以整体换肤（三条证据链）**：
① §1.2 实机实验——body static 覆盖回溯 alias；
② S1b 统计——官方组件直接引用 static 仅 13 处（ChatView 渐变 5 / TrajectoryTable 2 /
ContextMeter 2 / Tooltip 文字色 1 / StateDot 1 / AppearanceRow 1 / ansi 1），全部被 static
层直接命中，其中 Tooltip 文字色（次阵营对比度风险）是必须兜的一处；
③ desktop 线既有实践——桌面壳单套 static 注入在强制明暗下已稳定运行。

**编译校验（fail-closed，任一失败退出非零）**：
① 73 个 static 键与 `design/token-surface.txt` 全集一致（复用 desktop 完备性判据）；
② 输出值不残留 `var(--dsw-static-*)`（品牌 alias 重定向一并替换）；
③ 输出键集合 = 预期 105 键（两皮肤一致）；黑名单（初版 C 类 18 个中性 alias）不得出现；
④ 值均为合法字面（非空、非 `var(`）。

**为什么是"编译"而不是"运行时引用 desktop 的 CSS"**：两条线零耦合是本仓硬约定（AGENTS.md），
appearance 线不能 require desktop 线的文件；且 desktop 的 CSS 是 Tauri 注入层产物，浏览器直连时不存在。
编译产出的 JS 模块随插件分发，**两条线各自独立可用**。

---


## 3. 双明暗协同

### 3.1 官方两套映射自动给出次阵营

由 §1.4，皮肤只需提供**一套色阶**，次阵营由官方 alias 映射自动组合：

| 皮肤 | 主阵营 | dark 下的形态 | light 下的形态 |
|---|---|---|---|
| `zafkiel` | dark | 墨夜基底 + 浅紫文字（原生设计） | **浅紫白基底 + 深紫黑文字**（自动） |
| `kurkuriel` | light | **暖褐黑基底 + 骨白文字**（自动） | 骨白基底 + 深褐文字（原生设计） |

`overrideTokens` 的双值天然表达这个矩阵，**永不与官方三立方打架**（规划 §2.2 的定案继续成立）。

### 3.2 `preferredScheme` 与官方三立方的协同

皮肤声明 `preferredScheme`（zafkiel→`dark`、kurkuriel→`light`、pure→无）：

- **选中皮肤时**调一次 `ctx.theme.setTheme(preferredScheme)`，让官方三立方状态与视觉一致；
- **不持续锁定**：用户随后在官方页或外观页改明暗，皮肤给出对应阵营的取值（§3.1），**不拉回**；
- 面板上对该皮肤显示一行提示：「刻刻帝以深色为原生设计；切到浅色会使用自动派生的对应色阶」。

这与 desktop 现状（`syncDark()` 用 MutationObserver **持续锁定** `body[data-ds-dark-theme]`）语义不同——
**让位后 desktop 必须停掉锁定**（§4.3），否则两处争抢同一属性。

### 3.3 对比度风险点

次阵营是"自动组合"而非手工设计，需抽检（验收项）：

| 风险 | 判据 |
|---|---|
| 语义色在次阵营上对比不足（如 zafkiel 的 `red-400 #e06a5c` 放在浅紫白底上） | 正文/语义文本 ≥ 4.5:1，装饰 ≥ 3:1 |
| 品牌按钮文字（`--dsw-alias-button-primary-*` 的白字）在次阵营底色上 | ≥ 4.5:1 |
| shiki 语法色在代码块背景上 | ≥ 4.5:1 |

不达标时的处置顺序：① 调该 token 的次阵营值（进 `derive-skins.mjs` 的 override 表）；
② 若成片不达标，则该皮肤**声明仅单阵营**（面板隐藏明暗选择并提示），作为降级出口。

---

## 4. desktop 注入层让位协议（D2 落地）

D2 已拍板「外观线统一接管主题，desktop 注入层让位」。本轮把"让位"拆成**可判定、可回退、零回归**的三件事。

### 4.1 让位判据

desktop 侧（`themes/src/02-core.js`）在 `apply()` 与 `onReady()` 两处判定：

```js
const root = document.documentElement
const appearanceOn = root.getAttribute('data-mia-appearance') === 'on'
const appearanceSkin = root.getAttribute('data-mia-skin') || 'pure'
const yieldToAppearance = appearanceOn && appearanceSkin !== 'pure'
```

| 条件 | 行为 |
|---|---|
| `yieldToAppearance === true` | **让位**：停注入 skin CSS、停 `syncDark()`、停明暗 MutationObserver |
| 否则（属性缺失 / `off` / `skin === pure`） | **现状行为**：注入 skin CSS + 锁定明暗（桌面壳独立可用） |

**三条设计约束**：

1. **默认不让位**——只有属性**明确为 `on` 且皮肤非 pure** 才让。appearance 未安装、未启用、
   加载失败时，桌面壳行为与本轮之前逐字节一致（零回归）。
2. **时序补偿**：appearance 的 boot script 在 body 开标签后执行，而 desktop 的 init script 在
   document 创建时执行（更早）。首次判定必然读到 `null` → 必须在 `onReady()` 复判一次，
   并**新增一个 MutationObserver 监听 `html` 的 `data-mia-appearance` / `data-mia-skin`**
   （与既有的 `body[data-ds-dark-theme]` observer 分开，职责不同）。
3. **可逆**：用户在面板关掉总开关 → 属性变 `off` → desktop 的 observer 触发 → 恢复接管，
   无需刷新页面。

### 4.2 CSS 拆分：`*.skin.css` 与 `*.deco.css`

desktop 现有的 `themes/zafkiel.css`（191 行）内部已有天然分界（第 140 行 `/* —— 装饰层 —— */`），
但**注释标记是隐式契约**，本轮改为**显式文件拆分**：

```
themes/
├── zafkiel.skin.css     # 73 个 static 色阶 + 6 个半透明 alias + 品牌 alias 重定向
├── zafkiel.deco.css     # --ms-* 调色板 + ::selection / caret / h1-h3 / #miasaki-watermark / #miasaki-aurora
├── kurkuriel.skin.css
├── kurkuriel.deco.css
└── pure.css             # 保持"不覆盖任何 token"的兜底语义
```

| 部分 | 归属 | 让位时 | 理由 |
|---|---|---|---|
| `--dsw-static-*`（73） | skin | **停注入** | 由 appearance 的 alias 覆盖接管 |
| 半透明 alias（6：`bg-base` / `sidebar-fill` / `bg-layer-1/2` / `bg-module-platform` / `bg-overlay`） | skin | **停注入** | 同上；M2 由壁纸的「表面不透明度」参数层提供 |
| `--dsw-alias-brand-primary-new-colorprimary-new-color` 重定向 | skin | **停注入** | A 类自动派生覆盖 |
| `--ms-*`（切换条 / 标题栏 / 关闭弹窗自有色） | deco | **恒注入** | 桌面自有命名空间，与 DSH 主题无耦合 |
| 装饰规则（水印 / 光晕 / caret / 标题字族 / `::selection`） | deco | **恒注入** | 桌面壳专属视觉，不属"配色" |

**配套改动**：

- `scripts/build-init.mjs`：读 4 个 CSS 文件，产出 `STYLES[skin] = { skin: '…', deco: '…' }`；
  **令牌完备性校验只作用于 `*.skin.css`**（deco 不含色阶）。
- `scripts/diff-tokens.mjs`：同步改为只扫 `*.skin.css`。
- `scripts/verify-themes.mjs`：现有断言中「zafkiel: 强制暗色」一条**必须改**（让位后不再锁定），
  新增两条：`data-mia-appearance=on` 时 desktop 不注入 skin CSS、`off` 时恢复注入。

### 4.3 runtime 改动清单（`themes/src/02-core.js`）

| 函数 | 现状 | 让位后 |
|---|---|---|
| `apply(t)` | `styleEl.textContent = STYLES[t]` | `styleEl.textContent = yield ? STYLES[t].deco : STYLES[t].deco + STYLES[t].skin` |
| `syncDark()` | 按 `FORCE_DARK[current]` **锁定** `body[data-ds-dark-theme]` | `if (yield) return`（官方 presenter 全权管理） |
| `startObserver()` | 监听 `body[data-ds-dark-theme]` 并再断言 | `if (yield) return`；新增 `html[data-mia-appearance]` / `[data-mia-skin]` observer |
| `onReady()` | 首次应用 + 自愈巡检 | 增加 `recomputeYield()`，变化时重跑 `apply(current)` |

**不改动**：`setAttr('data-miasaki-theme')`（装饰层与切换条仍依赖它）、桌宠通道、标题栏、关闭弹窗、
安全区几何、`localStorage` 持久化——让位只影响"配色与明暗"两件事。

### 4.4 切换条成为第二入口

desktop 的悬浮切换条（`#miasaki-switcher`）继续存在，但点击行为分两种：

| 模式 | 点击行为 |
|---|---|
| 未让位 | 现状：`apply(t)` 换本地 CSS + 写 `localStorage` |
| 已让位 | `fetch('/appearance/api/config', { method:'POST', body:{ patch:{ theme:{ skin } } } })`，成功后**自行同步** `html[data-mia-skin]`（与 appearance client 半 `save()` 的同步逻辑同源、幂等） |

**为什么由 desktop 同步属性而不是等 appearance 推送**：host 半改不了已发出的 HTML，
client 半不知道外部写入（无 SSE/轮询）。两处写同样的属性是幂等的，代价最小。
这条协议写进两线 README（§4.5）。

### 4.5 回归影响与文档同步

| 项 | 动作 |
|---|---|
| desktop `verify-themes.mjs` | 改 1 条断言 + 增 2 条（§4.2） |
| desktop `design/themes.md` | §1.3「注入与优先级」补让位协议；§2.0 pure 语义不变 |
| desktop `design/CHANGELOG.md` | 记本轮拆分与让位 |
| appearance `README.md` | 「与 desktop 的接口」一节写让位判据与切换条协议 |
| `smoke-test-matrix.md` | desktop 项数变化；新增"让位往返"实机项 |

---

## 5. 壁纸层与玻璃档位

### 5.1 分层与 z-index 契约

**用伪元素而非独立 DOM 节点**——零 DOM、零 JS、首帧即生效、天然 `pointer-events: none`：

```css
body::before {                     /* 壁纸层 */
  content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background-image: var(--mia-wallpaper-scrim, none), var(--mia-wallpaper, none);
  background-size: cover; background-position: center;
}
```

层叠关系（负 z-index 的定位元素画在**元素背景之上、内容之下**）：

```
body 背景（--dsw-alias-bg-base，被表面不透明度调成半透明）
  └─ body::before（壁纸层，z-index:-1）      ← 壁纸可见于此
       └─ #root 及各表面（背景半透明后透出壁纸）
            └─ canvas 全屏层（z-index:100）    ← 仍高于壁纸 ✅ 与规划 §7 一致
                 └─ desktop 标题栏（100000）/ 切换条（99990）
```

**暗色遮罩（scrim）**：并入同一伪元素的**多重背景**（`linear-gradient` 在前、`url()` 在后），
不额外开层。**晕影（vignette）**同理（径向渐变）。

**与 desktop 装饰层的关系**：desktop 的 `#miasaki-aurora`（z-index:0）在壁纸启用时**视觉叠加**。
让位协议约定：`data-mia-wallpaper="on"` 时 desktop 的 aurora 透明度降为 0（由 `04-deco.js` 读属性处理），
避免"两层氛围互相打架"。

### 5.2 图源与字节路由

| 源 | 形态 | 实现 |
|---|---|---|
| 内置 | `builtin:<id>` | 随插件分发 `assets/wallpapers/*.webp`（2–4 张原创，建议 ≤ 2MB/张）；host 半注册 `/appearance/wallpaper/builtin/<id>` 同源路由 |
| 本地目录 | `/appearance/wallpaper/local/<file>` | 扫描 `~/.dsh/miasaki-appearance/wallpapers/`；**白名单目录内 + 文件名白名单正则**（防路径穿越）；列表经 `/state` 返回 |
| 远程 URL | `http(s)://…` | 默认隐藏，需显式开启并提示隐私/离线代价（D5） |

配置里 `wallpaper.source` 的三种形态 M1 已实现（`lib/config.js:102-109`）。M2 增量：
`wallpaper.light` / `wallpaper.dark`（双壁纸，`system` 偏好下随 OS 切换）。

**`autoAccent`（从壁纸派生强调色）**：必须显式 `crossOrigin='anonymous'` 并处理失败分支（规划 R10）；
本地/内置图同源，无此问题。

### 5.3 玻璃档位

| 档位 | 表面 alpha | `backdrop-filter` | 备注 |
|---|---|---|---|
| `off`（默认） | 100% | 无 | 原生观感 |
| `light` | ~92% | `blur(8px)` | |
| `frost` | ~78% | `blur(20px) saturate(1.4)` | 毛玻璃 |
| `mica` | ~65% | `blur(40px) saturate(1.6)` + 噪点层 | **web 近似**，非 Win11 真 Mica |

**技术难点（诚实标注）**：`backdrop-filter` 必须作用在**生成盒子的元素**上，而官方 `[data-slot]`
锚点是 `display: contents`（规划 §2.5：`ANCHOR_STYLE = { display: contents }`），**对它本身无效**。
可行路径是命中锚点的**子元素或 `parentElement`**。

→ **S1a 玻璃命中探针结论（2026-09-12，实机盒模型枚举 + 真 Chromium 视觉验证）**：

| 锚点 | 实测 display | `> *` 首子元素 | 命中结论 |
|---|---|---|---|
| `sidebar` | contents | **实盒子**（flex + 实色 `rgb(27,27,28)`） | ✅ `> *` 直接命中 |
| `main.conversation` | contents | **实盒子**（flex + 实色 `rgb(21,21,23)`） | ✅ `> *` 直接命中 |
| `main` | contents | contents（无盒子） | ❌ 改用 `main.conversation > *` |
| `rightbar` | contents | （同 sidebarCol 构型） | ✅ `> *`（右栏未开时无元素，规则天然失配无害） |
| `conversation.composer.bar` / `sidebar.settings` | contents | 无背景小盒子 | ❌ 玻璃降级为纯 alpha（视觉卡片在更深层，规则化命中会引入哈希类风险） |

- **全部祖先链**（sidebarCol/centerCol/rightbarCol/AppFrame/#root）实测 `filter/transform/contain/backdrop-filter` 均为 none
  —— **无 backdrop root 边界陷阱**。
- **机制视觉验证**（独立探针页 `_refs/scripts-archive/m2-glass-probe.html`，夸克 Chromium 实测）：
  `body::before` 壁纸层（`z-index:-1`，多重背景 scrim+图）**可见**；表面半透明 +
  `backdrop-filter: blur(20px) saturate(1.4)` 下条纹被柔和模糊 —— **frost 档机制完全成立**。
  ⚠️ 注意：**ZCode IAB 的截图/渲染通道对这类全局注入层失真**（fixed 全屏层与 backdrop-filter 均
  不显示，DOM/computed 却全部正确）——壁纸/玻璃的视觉验收必须走桌面浏览器（或桌面壳），
  不能以 IAB 截图为准。

**玻璃规则形态定稿（混合式）**：alpha 走**变量层**（§5.4 四旋钮映射 6 个半透明 alias），
`backdrop-filter` 走**少量结构规则**，只挂三个主表面的 slot 实盒子：

```css
html[data-mia-glass="frost"] [data-slot="sidebar"] > *,
html[data-mia-glass="frost"] [data-slot="main.conversation"] > *,
html[data-mia-glass="frost"] [data-slot="rightbar"] > * {
  backdrop-filter: blur(20px) saturate(1.4);
}
```

composer / settings 等小表面**降级为纯 alpha 分层**（不加 backdrop 规则）；
契约自检的 `glass-anchor-miss`（§8）按上表实装。

**性能纪律**（规划 R4）：只在上述 5 个主容器启用；`will-change` 绝不全局；M2 内建帧率基线
（原生 vs 壁纸 vs 壁纸+毛玻璃，长会话滚动 60s 的 p95 帧时长）。

### 5.4 表面不透明度

`wallpaper.surface` 四个旋钮（0–100，100 = 不透明）映射到 6 个半透明 alias：

| 旋钮 | 映射 token |
|---|---|
| `sidebar` | `--dsw-specific-sidebar-fill` |
| `conversation` | `--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1`、`--dsw-alias-bg-layer-2` |
| `composer` | `--dsw-alias-bg-module-platform` |
| `overlay` | `--dsw-alias-bg-overlay` |

**粒度限制（D8 已定）**：「会话列独立不透明度」需要 `dsh-client-ui-conversation` 补丁才能做到
（规划 §9-10：`ConversationRoot` 直读 `--dsw-alias-bg-base`，无中间层）。M2 **不做补丁**，
`conversation` 旋钮的实际效果是**全局基底**（会连带侧栏/浮层）。面板上以提示文案说明这一粒度。

---

## 6. 首帧防闪色（boot style）

### 6.1 双明暗属性选择器（零 JS 时序依赖）

> **修正注记（§0 大修正后）**：token 表 `{light,dark}` 为**同值对**（§2），因此双段
> 选择器产出的两段内容相同——保留双段写法是为对冲官方将来在 dark 段恢复 per-token 差异
>（现仅 `-60` 一处），代码按同值处理、不手工维护两套。

`buildBootStyle()`（M1 恒返回空串）在 M2 产出：

```css
html[data-mia-skin="zafkiel"] body { <A 类 + 组件自有的 light 值> }
html[data-mia-skin="zafkiel"] body[data-ds-dark-theme] { <A 类 + 组件自有的 dark 值> }
```

**为什么这是最优解**：

- 官方明暗由 `body[data-ds-dark-theme]` 驱动（`theme-presenter.ts:41-42`），**CSS 选择器动态匹配**——
  属性何时被官方写上，样式何时生效，**首帧脚本不需要猜偏好、不需要读 localStorage**；
- `system` 偏好下的 OS 明暗切换同样自动跟随；
- 注入行是 `{ kind: 'style' }`（head 位置，规划 §9-8 已确证支持），**早于 shell 挂载**，无闪色窗口。

**与运行时的一致性**：boot style 是 head 里的 `<style>`（特异性 (0,2,1)），官方 presenter 写的是
**body inline style（特异性最高）**。presenter 写的 `snapshot.active.tokens` **已包含我们的 override 层**
（`composeActive` 合并），所以两者值相同、presenter 覆盖 boot style 后**视觉无跳变**。
boot style 的职责只是"填满 presenter 首次 apply 之前的空窗"。

**体积**：67 个 alias + 73 个 static + 24 个组件自有 ≈ 164 个 token × 2 阵营 ≈ 16–20KB 内联 CSS。
解析开销可忽略（<1ms）。若需压缩，可只注入"首屏可见"的 ~20 个（bg/label/brand/sidebar-fill），
其余留给运行时——**M2 默认全量**（一致性优先，避免首屏后跳变）。

### 6.2 壁纸首帧

壁纸同样走 boot style（§5.1 的伪元素规则 + `--mia-wallpaper` 变量值），
由 `buildBootStyle()` 一并产出。**总开关关闭时不注入任何内容**（硬契约）。

壁纸字节的加载是异步的（浏览器解码），首帧仍可能有短暂空窗 → 用 `background-color` 兜底
（取皮肤 `bg-base`），避免"先白后图"。

### 6.3 一致性纪律

`buildBootStyle()` 与运行时 `overrideTokens` 必须**消费同一份 token 表**（`lib/skins/*.js`），
否则会出现"首帧一套色、挂载后另一套"的跳变。做法：两处都从 `lib/skins/<skin>.js` 读，
boot style 侧只做「对象 → CSS 文本」的序列化。**新增单测**：对同一配置，
`buildBootStyle()` 解析出的 token 集合与 `skin.tokens` 的键集合相等（防漏项）。

---

## 7. 配置模型增量（v1 → v2）

`lib/config.js` 的 `DEFAULT_CONFIG` 增量（`CONFIG_VERSION` 1 → 2，`migrateConfig` 补一条分支）：

| 板块 | 新增字段 | 类型 / 范围 | 默认 |
|---|---|---|---|
| `theme` | （无新增；`skin` 白名单在 M2 由 1 项扩为 3 项） | | |
| `wallpaper` | `light` / `dark` | 同 `source` 的三种形态 | `''` |
| | `fit` | `cover` / `contain` / `tile` | `cover` |
| | `focus` | `center` / `top` / `bottom` / `left` / `right` | `center` |
| | `glass` | `off` / `light` / `frost` / `mica` | `off` |
| | `vignette` | 0–100 | 0 |
| | `surface.sidebar` / `.conversation` / `.composer` / `.overlay` | 0–100 | 100 |
| | `builtin` | 只读（host 扫描结果，不落盘） | — |

**迁移纪律**：v1 → v2 无破坏性变更（纯新增字段，`sanitizeConfig` 已对缺失字段回退默认）。
`migrateConfig` 的 v2 分支只需补 `version` 并保证 `wallpaper.surface` 对象存在。

---

## 8. 契约自检增量

M1 的 `evaluateContract` 增加三条判定（`lib/config.js`）：

| 级别 | code | 触发 | 面板行为 |
|---|---|---|---|
| `warn` | `glass-anchor-miss` | 玻璃档位非 `off` 但目标锚点命中失败 | 提示"该容器不支持毛玻璃，已降级为纯透明分层" |
| `warn` | `skin-token-miss` | 皮肤层注册后，抽查 3 个代表 token 的计算值与期望不符 | 提示"皮肤可能未完全生效，请重启 dsh web" |
| `error` | `override-conflict` | 检测到 `html[data-miasaki-theme]` 存在**且** `data-mia-appearance="on"` 且 skin 非 pure（即 desktop 未按协议让位） | 面板禁用皮肤板块并说明冲突原因 |

第三条是**让位协议的双向保险**：desktop 侧判定失败时，appearance 侧主动退让，
**绝不允许两个引擎同时写 token**（规划 §7 的"唯一不可接受"）。

---

## 9. 验收矩阵

### 9.1 视觉矩阵（12 组）

3 皮肤（pure / zafkiel / kurkuriel）× 2 明暗（light / dark）× 2 壁纸（无 / 有）= 12 组截图。

| 组 | 判据 |
|---|---|
| 全 12 组 | 无 console error / pageerror；无"原蓝色残留"（zafkiel / kurkuriel 下抽查品牌按钮、链接、焦点环） |
| 6 组非 pure | 对比度抽检 ≥ 4.5:1（正文、语义文本、代码块语法色） |
| 2 组有壁纸 | 帧率基线：长会话滚动 60s 的 p95 帧时长不低于原生基线的 90% |
| pure × 2 | 与原生截图 diff = 0 |

### 9.2 让位协议（新增 4 项）

| 项 | 判据 |
|---|---|
| 让位生效 | 总开关开 + skin=zafkiel → `#miasaki-theme-layer` 文本长度 ≈ 仅 deco 部分；`body[data-ds-dark-theme]` 由官方 presenter 管理（切 light 后属性被移除） |
| 让位回退 | 关总开关 → desktop 恢复注入 skin CSS 与明暗锁定；页面无残留 appearance token |
| 双向冲突防护 | 手动构造"desktop 未让位 + appearance 开启" → 面板显示 `override-conflict` 黄条，皮肤板块禁用 |
| 切换条双入口 | 让位态下点 desktop 切换条 → `/appearance/api/config` 收到 skin 变更，`html[data-mia-skin]` 同步，视觉切换生效 |

### 9.3 首帧无闪色

录屏逐帧核（规划 §6 的 M2 判据）：从导航开始到 shell 挂载完成，
**不出现原生蓝白配色帧**（即第 1 帧即为皮肤配色）。

### 9.4 关掉即原生（硬契约，每期必验）

总开关关闭 → 全文档零条本线样式注入、html 无 mia 内联样式、与原生截图 diff = 0。

---

## 10. 风险与未决

| # | 风险 / 未决 | 处置 |
|---|---|---|
| R1 | ~~玻璃锚点命中路径未知~~ **已解决（S1a）**：三主表面 `> *` 实盒子命中、composer/settings 降级纯 alpha、无 backdrop root 陷阱；机制经真 Chromium 视觉验证（§5.3） | 已回填 §5.3 |
| R2 | 次阵营对比度可能成片不达标 | 抽检；不达标走"单阵营降级出口"（§3.3） |
| R3 | boot style 体积（16–20KB 内联） | 默认全量；若实测首帧受影响再改"关键 token 子集" |
| R4 | desktop 让位后，桌面壳"启动页主题"仍需色阶 | 启动页（`ui/loading.html`）不在 3080 页面内，**不受让位影响**——它由 `__MIA_THEME__` 注入，走既有链路 ✅ |
| R5 | appearance 线新增 `lib/skins/*.js`（约 2×8KB）与 `assets/wallpapers/`（≤8MB） | 仓库体积可控；壁纸按需从 2 张起步 |
| R6 | 派生脚本依赖官方 `design-platform.css` 的行号结构 | **按内容解析而非行号**（用 `:root` / `body[data-ds-dark-theme]` 块选择器定位），避免升级后行号漂移 |
| R7 | `verify-themes.mjs` 的"强制暗色"断言在让位后失效 | 已列入改动清单（§4.5） |
| R8 | 强调色派生（`color-mix` 10 级）与皮肤色阶的优先级 | 定为 **params 层（后注册）覆盖 skin 层**，即强调色优先于皮肤品牌色 |

---

## 11. 实施顺序（建议 6 步）

| 步 | 内容 | 产出 / 闸门 |
|---|---|---|
| **S1** | ~~玻璃命中探针 + static 使用面统计~~ **✅ 已完成（2026-09-12）**：static 直接引用 13 处 → 兜底层**保留**（§2.4）；三主表面 `> *` 命中、composer/settings 降级（§5.3）；机制经真 Chromium 视觉验证。⚠️ 副产物：IAB 截图通道对全局注入层失真，视觉验收必须走桌面浏览器 | 已回填 §2.4 / §5.3 / §10-R1 |
| **S2** | **desktop 侧 CSS 拆分**（`*.skin.css` / `*.deco.css`）+ build-init / diff-tokens / verify-themes 同步 | desktop `verify-all` 全绿；**此步不含让位逻辑**，零行为变更 |
| **S3** | ~~派生脚本~~ **✅ 已完成（2026-09-12，按 §2 修正版大幅简化）**：`scripts/derive-skins.mjs` 直接编译 skin.css → `lib/skins/*.js`（105 token，`{light,dark}` 同值对，无 alias 派生）；4 条 fail-closed 校验 + `--check` 可复算闸门（已入 verify-all appearance，12/12）+ `test/skins.test.js` 7 例 | 单测 45 例全绿 |
| **S4** | ✅ **已完成（2026-09-12 深夜）**：host `GET /appearance/api/skin`（skin 表 + surface 表一次下发）+ `buildBootStyle` 双段属性选择器；client `syncSkin`（页面加载即接管，skin/params 双 source：`appearance:skin` / `appearance:params`）+ preferredScheme 选中时拨一次 + 面板三皮肤解锁 + skinSpot 契约抽查。实机：绯红品牌 `#c23a2e` / 墨夜 `#0c0b11` / boot style 入 head 全过 | 单测 58 例；appearance verify-all 12/12 |
| **S5** | ✅ **已完成（2026-09-12 深夜）**：配置 v2（wallpaper.light/dark/fit/focus/glass/vignette/surface 四旋钮）；boot style 壁纸伪元素（scrim→vignette→图 多重背景）+ 三条玻璃 slot 规则 + `data-mia-glass`/`data-mia-wallpaper` 属性；params 层用 `color-mix(var(--dsw-static-端点) N%, transparent)`（自动跟皮肤跟明暗，实机证实）；内置 3 程序化渐变壁纸（零资产）+ local 图源路由（basename 白名单防穿越）+ 面板壁纸 UI。实机：伪元素/玻璃/color-mix 解析全过 | 单测 58 例（+8）；视觉帧率基线留用户验收 |
| **S6** | ✅ **已完成（2026-09-12 深夜）**：desktop `appearanceYield()` 判定 + `styleFor` 按让位挑层 + `syncDark` 让位 + `data-miasaki-theme-yield` 双向保险标记 + yieldObserver（appearance 属性翻转即重 apply，无需刷新）+ 切换条双入口（让位态 POST /appearance/api/config + 同步属性 + 桌宠联动）+ aurora 壁纸降透明；appearance 侧 `override-conflict`（error，desktop 在位却无让位标记）+ syncSkin 冲突时不注册。**verify-themes 22/22（含让位往返 4 项自动化）**；desktop 8/8。注：测试前提曾因「appearance enabled 残留配置」失效——协议真实工作时 desktop 正确让位所致，测试 setup 已改为先经 API 关闭 appearance 并二次导航 | desktop CHANGELOG 同日条目 |

**S2 与 S3 可并行**（不同仓库、无依赖）。**S6 必须在 S4 之后**（需要 `data-mia-*` 属性真实存在）。

---

## 附录 A：A 类 67 个 alias 全名单

按 §2.1 分组，供 `derive-skins.mjs` 的输出校验用（期望输出恰好包含这些键）：

```
bg:        --dsw-alias-bg-base / -bg-layer-1 / -bg-layer-2 / -bg-layer-3 / -bg-module-platform
           / -bg-multi-select / -bg-overlay
label:     --dsw-alias-label-caption / -dimmed / -primary / -primary-bluish / -primary-dimmed
           / -primary-foreground / -primary-inverted / -secondary / -tertiary
brand:     --dsw-alias-brand-primary / -brand-primary-invert / -brand-text
           / -brand-primary-new-colorprimary-new-color
button:    --dsw-alias-button-contrast-fill / -elevated-fill / -floating-fill / -floating-hover
           / -ghost-active-border / -ghost-active-fill / -ghost-active-hover / -info-fill / -info-hover
           / -primary-dimmed / -primary-hover
state:     --dsw-alias-state-error-primary / -error-secondary
           / -success-primary / -success-secondary / -success-tertiary
           / -warn-primary / -warn-secondary / -warn-tertiary / -warn-label
           / -business-primary / -business-tertiary
markdown:  --dsw-alias-markdown-citation / -code-block / -code-block-banner / -code-segment-selected
           / -code-segment-unselected / -inline-code / -placeholder / -tag
scrollbar: --dsw-alias-scrollbar-bg-l1 / -bg-l2 / -hover-l1 / -hover-l2
float:     --dsw-alias-toast-bg / -tooltip-bg
specific:  --dsw-specific-bubble / -bubble-highlight / -input-major / -login-input / -selector
           / -sidebar-fill / -sidebar-nav-item-active / -sidebar-nav-item-active-accent
           / -sidebar-nav-item-hover / -tip
```

（`--dsw-alias-interactive-bg-hover-solid` 归入 button 组派生。）

## 附录 B：取证出处

| 事实 | 出处 |
|---|---|
| static 色阶 73 个，仅定义在 `:root` | `vendor/.../ui-theme/src/styles/design-platform.css`（`:root` 段 73 处，dark 段 0 处） |
| alias 层 89 个，light/dark 各一套 | 同上（`:root` L1–247、`body[data-ds-dark-theme]` L248–338） |
| light/dark 的 alias→static 端点映射 | 同上 L157-208（light）、L249-300（dark） |
| presenter 只写 `body.style`，每次全量重写 | `ui-layout/src/client/theme-presenter.ts:37-51` |
| `validateOverrides` 只校验 `{light,dark}` 形状，无白名单 | `ui-theme/src/client/index.ts:339-359` |
| `composeActive` 按 `active.colorScheme` 取单值、seq 升序 | 同上 `:315-324` |
| 同 source 再调 = 替换整层并重新置顶 | 同上 `:265-290` |
| 「主题 = alias-layer overrides」的官方表述 | 同上 `:140-144` |
| `json-tree-*` 由组件自带明暗双套 | `ui-primitives/src/JsonTree.module.css:5,24` |
| desktop 双目标选择器（html + body） | `dsh-miasaki-desktop/themes/zafkiel.css:6-7` |
| desktop 明暗锁定与 observer | `themes/src/02-core.js:113-151` |
| desktop 令牌完备性校验 | `scripts/build-init.mjs:33-53` |
| `[data-slot]` 锚点为 `display: contents` | `dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.5-rc1-slot-contract-2026-09-10.md` §3.1–3.5 |
