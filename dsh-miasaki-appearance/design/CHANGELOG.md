# CHANGELOG — dsh-miasaki-appearance

本文件记录 `dsh-miasaki-appearance/` 线的设计决策与变更。

## 2026-09-12（深夜）· M2 S4–S6：皮肤/壁纸/玻璃全链路落地 + 让位协议收官

- **修：外观面板空白（实机验收发现，2026-09-12 深夜）**：`reactElementWallpaperPicker`（factory 作用域）引用了组件内 useState 的 `wallpapers` → 渲染期 ReferenceError → 整个面板组件树崩掉（S5 建面板时引入；注册期契约测试抓不到——slots.inject 的回调不执行；S5 实机验证只做了协议层断言未开面板）。修法：picker 参数化（local 清单由组件传入）。连带发现并修：`mergeConfig` 对 `wallpaper.surface` 是整块浅合并——调一个旋钮会把其它三个重置回 100，改为逐旋钮合并。**回归闸门**：`test/client.test.js` 增「面板渲染冒烟」——react stub 的 useState 支持按序注入，把组件驱动到「配置已加载」的完整渲染路径（含壁纸区块与三个 picker）；故障注入回验（复现作用域错误 → 测试红 → 修复 → 绿）。


- **S4 皮肤层（appearance 侧）**
  - host：`GET /appearance/api/skin` 一次下发当前皮肤的 tokens（105）+ meta + **params 层
    表**（`buildSurfaceTokens`，见 S5）；`buildBootStyle` 落地——双段属性选择器
    （`html[data-mia-skin=x] body` / `…[data-ds-dark-theme]`）展开 token 表，head 注入防闪色
    （M2 §6）。config.js 保持纯逻辑（表作参数传入）。
  - client：`syncSkin()`——**页面加载即接管**（不等面板打开；boot style 撑首帧，这里接管
    运行时），skin / params 双 source（`appearance:skin` / `appearance:params`，同 source 再调
    = 替换整层）；选中皮肤时把官方三立方拨到 `preferredScheme`（§3.2，只此一次不锁定）；
    面板三皮肤全部解锁 + `skinSpot` 契约抽查（3 个代表 token 的期望 vs 实测 computed）。
  - 实机：刷新后绯红品牌 `#c23a2e` / 墨夜基底 `#0c0b11` / 半透明 alias / boot style 入 head
    全部生效；IAB 截图确认皮肤视觉（token 层变化不在其失真范围）。

- **S5 壁纸层与玻璃档位**
  - 配置 v1→v2：`wallpaper.{light,dark,fit,focus,glass,vignette,surface.{sidebar,conversation,
    composer,overlay}}` 纯新增，`migrateConfig` 抬版本即可（sanitize 补默认）。
  - boot style 三段产出：**壁纸伪元素**（`body::before` z-index:-1，多重背景 scrim→晕影→图；
    fit/focus 映射 background-size/position/repeat）+ **玻璃规则**（S1a 定稿的三条 slot 实盒子
    路径）+ 皮肤段；boot script 增写 `data-mia-glass` / `data-mia-wallpaper` 属性。
  - **params 层表面不透明度**：`buildSurfaceTokens` 把四旋钮映射为 6 个半透明 alias 的
    `{light,dark}` 覆盖，值用 `color-mix(in srgb, var(--dsw-static-<端点>) N%, transparent)`——
    解析发生在 body（皮肤已覆盖的字面）→ **自动跟皮肤、跟明暗**（实机证实 computed 为
    `color-mix(in srgb, #0c0b11 75%, transparent)`）。壁纸未启用时不注册 params 层
    （无壁纸时半透明透出的是空白画布而非壁纸）。
  - 图源：**内置 3 个程序化渐变**（aurora/dusk/ember，零图片资产零请求）+ **本地目录**
    `~/.dsh/miasaki-appearance/wallpapers/`（`GET /appearance/api/wallpapers` 列清单 +
    `GET /appearance/wallpaper/local/<file>` 出文件；basename + 正则白名单 + normalize 前缀
    双闸门防穿越，单测覆盖编码穿越/非法扩展）；http(s) URL 配置层已支持、面板入口按 D5 暂缓。
  - 面板：图源 picker（无/内置/本地清单）+ 玻璃四档 + 遮罩/晕影步进 + 表面四旋钮；
    契约 `glass-anchor-miss`（玻璃档位非 off 且三条锚点全未命中时黄条）。
  - 实机：伪元素多重背景 / `data-mia-glass` 属性 / 侧栏实盒子 `backdrop-filter: blur(20px)
    saturate(1.4)` / color-mix 解析全部生效。**视觉与帧率基线留用户验收**（Windows 锁屏
    阻塞了桌面浏览器截图；IAB 对 fixed 层失真不可用）。

- **S6 让位协议（D2 落地，desktop 侧改动见 desktop CHANGELOG 同日条目）**
  - 协议增强：desktop 让位时置 **`data-miasaki-theme-yield="skin"` 标记**——appearance 的
    `override-conflict` 判定不再用「`data-miasaki-theme` 存在」（协议落地后它恒真，会误报），
    改为「桌面壳在位 + 本线皮肤接管中 + **无让位标记**」= 双引擎冲突（error 级，面板提示）。
  - client `syncSkin` 冲突时不注册皮肤层（desktop 继续管配色）；契约探测上报
    `desktopYield` / `mia`。
  - **自动化**：desktop `verify-themes` 增 §4.5 让位往返 4 项（模拟门控属性 → skin 停注入 +
    yield 标记 + `data-miasaki-theme` 保留 → 解除回注 + 标记移除），**22/22 全过**。
    测试前提曾因「appearance enabled 残留配置」失效——那正是协议真实工作（desktop 正确
    让位）的证据；测试 setup 已改为先经 API 关闭 appearance 并二次导航（裸 API 写入不唤醒
    client 半，必须让 boot script 首帧重读）。

- **验证**：appearance 单测 **60 例全绿**（46 + 8 + 6：S4/S5/S6 各自新增的皮肤、壁纸玻璃、让位契约用例）、verify-all **12/12**；desktop verify-themes
  **22/22**、verify-all **8/8**。验证后配置已恢复出厂。

- 触摸点：`index.js`（skin/surface 下发 + wallpapers/local 路由 + 内置渐变表）、
  `client.js`（syncSkin 双 source + 壁纸面板 + glass 契约采集 + 冲突守卫）、
  `lib/config.js`（v2 + buildBootStyle 三段 + buildSurfaceTokens + 契约两条）、
  `test/{config,host,skins}.test.js`（+13 例）、`package.json`；
  desktop：`themes/src/{00-boot,02-core,03-switcher,04-deco,08-ready}.js`、
  `scripts/verify-themes.mjs`（+让位往返）；`../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md`。

## 2026-09-12（晚）· M2 S1–S3：探针定案 + 设计大修正 + 皮肤表编译落地

> 本条**推翻**下方「M2 设计定稿」条目的核心结论（该条目的「alias 定义在 `:root`」取证有误，
> 推理过程保留作历史）；被推翻部分以修正后的
> [M2 设计](2026-09-12-appearance-m2-design.md) §0–§2 为准。

- **S1 探针（M2 设计 §11 第一步，两项结论）**
  - **S1b static 引用统计**：官方组件代码里直接引用 `var(--dsw-static-*)` 共 **13 处**
    （design-platform.css 的 133 处全是 alias 派生定义行）。明细与后果评估见 M2 设计 §2——
    Tooltip 文字色（次阵营对比度风险）与 ChatView 品牌渐变（会话区显眼残留）必须兜。
  - **S1a 玻璃命中探针**：实机枚举 167 个 `[data-slot]`——三主表面（sidebar /
    main.conversation / rightbar）的 `> *` 是**唯一实盒子**（flex + 实色背景）可直接吃
    `backdrop-filter`；`main` / composer / settings 需下钻或降级纯 alpha；全部祖先链
    无 filter/transform/contain（无 backdrop root 陷阱）。玻璃规则形态定稿为
    「alpha 走变量层 + backdrop 走三条 slot 实盒子规则」（M2 设计 §5.3）。
  - **机制视觉验证**：独立探针页（`_refs/scripts-archive/m2-glass-probe.html`）在夸克
    Chromium 实测——`body::before` 壁纸层（z-index:-1）可见，frost 档毛玻璃效果完全成立。
  - **重要副产物**：**ZCode IAB 的渲染/截图通道对全局注入层失真**（fixed 全屏层与
    backdrop-filter 在 DOM/computed 全部正确的情况下截图不可见；同页同样式在桌面浏览器
    正常）。壁纸/玻璃类视觉验收必须走桌面浏览器或桌面壳，已记 memory。

- **设计大修正（M2 设计 §0–§2 重写）**：初版对官方 token 定义位置的取证有误——复读
  vendor 源码确认**四个顶层块全在 body 上**（无 `:root` 段），实机实验定案：body inline
  覆盖 static **能**回溯影响 alias（覆盖 `-950` 后 `--dsw-alias-bg-base` 从 `#151517` →
  `#ff0000`，清理恢复）。→ **规划 §5.4 原始设想「皮肤 = 73 个 static 单值」成立**，
  「必须 alias 层 / A 类 67 个派生」整套作废，S3 简化为 skin.css 直接编译。
  官方 dark 段 static 与 light 仅 1 个 token 值差（`-60` 明度微调），
  「色阶明度中立」结论不变。

- **S2（desktop 侧，见 desktop CHANGELOG 同日条目）**：`{zafkiel,kurkuriel}.css` 拆为
  `*.skin.css` + `*.deco.css`，desktop `verify-all` 8/8。本线 S3 消费其 `*.skin.css` 为编译源。

- **S3 皮肤表编译（本线落地）**
  - 新增 `scripts/derive-skins.mjs`：把 desktop 的 `*.skin.css` 编译为 `lib/skins/*.js`
    （`name` / `meta{id,label,preferredScheme}` / `tokens`），**105 token = static 73 +
    品牌 alias 1（编译期 var 替换为皮肤值）+ 组件自有 25 + 半透明 alias 6**，全部
    `{light,dark}` 同值对（`validateOverrides` 直接可吃）。
  - 四条 fail-closed 校验：① desktop `token-surface.txt` 全集覆盖（EXCLUDED 同款
    `--dsh-scrollbar-width`）；② 值不残留 `var(`；③ 键集合恰 105 + 初版 C 类 18 个中性
    alias 黑名单；④ 无空值。`--check` 模式做产物可复算 diff（防手改/过期）。
  - `package.json` 增 `derive` / `derive:check`；`scripts/verify-all.mjs` appearance 计划增
    `derive-skins --check` 项。
  - 新增 `test/skins.test.js`（7 例）：产物形状 / 105 键两皮肤一致 / `{light,dark}` 同值对 /
    无 var 残留 + 品牌重定向端点值 / C 类黑名单 / 代表性端点值（与 desktop verify-themes
    同源）/ 产物未手改。

- **验证**：单测 **45 例全绿**（38 + 7）；`node ../scripts/verify-all.mjs appearance` →
  **12/12 PASS**；`node ../scripts/verify-all.mjs desktop` → **8/8 PASS**。

- 触摸点：`design/2026-09-12-appearance-m2-design.md`（§0–§2 修正 + S1 回填）、
  `scripts/derive-skins.mjs`（新增）、`lib/skins/{zafkiel,kurkuriel}.js`（新增产物）、
  `test/skins.test.js`（新增）、`package.json`（derive 脚本）、
  `../scripts/verify-all.mjs`（+1 项）、`../dsh-miasaki-desktop/themes/**`（S2 拆分）、
  `../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md`（基线）、
  `_refs/scripts-archive/m2-glass-probe.html`（探针页，归档）。

## 2026-09-12

- **M2 设计定稿（本轮只出设计，不含实现）：主题皮肤下沉 + 壁纸层与玻璃档位**
  > ⚠️ **本条「该形态不成立 / 必须 alias 层」的结论已被同日晚间的实机复核推翻**
  > （alias 实际定义在 `body` 而非 `:root`，static 覆盖可回溯）——见上方 2026-09-12（晚）条目。
  > 「24 个组件自有变量」「让位判定」「boot style」「壁纸层」各节不受影响。

  - **推翻了规划 §5.4 的皮肤形态**。原文设想「皮肤层 = `overrideTokens` 直接喂 desktop 的 73 个
    `--dsw-static-*`」——**该形态不成立**。根因：`ThemePresenter.apply()`
    （`ui-layout/src/client/theme-presenter.ts:37-51`）只写 **`body.style`**，而官方 alias 定义在
    `:root`(html) 上，其 `var(--dsw-static-*)` **在 html 元素上就已解析为字面颜色**再继承下来；
    body 上覆盖 static 无法回溯影响已解析的 alias。→ **皮肤必须下沉到 alias 层**
    （官方注释原话即 "third-party themes register **alias-layer overrides**"）。
    反证：desktop 的 `themes/zafkiel.css:6-7` 用 `html[data-miasaki-theme=…], html[…] body` **双目标**
    选择器，正是为了让 html 上的 alias 解析时读到新色阶——web 侧拿不到 html 写入权，故必须改走 alias。

  - **第二个结论：不需要为刻刻帝另画「昼」色阶**。实测 73 个 `--dsw-static-*` **只在 `:root` 定义一处**
    （`body[data-ds-dark-theme]` 块里 0 个）→ 色阶是**明度中立的调色板**，明暗语义全由 alias 层选端点
    （light: `bg-base→neutral-bluish-00`、`label-primary→…-1000`；dark: 反向）承载。
    zafkiel 的色阶表在 light 下自动呈现「浅紫白底 + 深紫黑字」，kurkuriel 在 dark 下自动呈现
    「暖褐黑底 + 骨白字」——规划 §6 的「3 皮肤 × 明暗 = 12 组」因此是**零设计成本**的。

  - **色阶清单按值的来源分三类**（对官方 alias 层 89 个名做实测分类，脚本归档
    `_refs/scripts-archive/m2-alias-classify.mjs`）：**A 类 67 个**（值含 `var(--dsw-static-*)`）
    → 自动派生双值，是覆盖主力；**A2 类 2 个**（引用其他 alias）→ 跟随；**B 类 2 个**（品牌相关字面值）；
    **C 类 18 个**（中性字面值：遮罩/边框 alpha/交互态灰）→ **沿用官方不覆盖**（防色偏）。
    手工设计量从「73×2」降到「24 个组件自有变量 × 2 阵营」——这 24 个（`--shiki-*` 11 / `--json-tree-*` 7 /
    `--dsh-scrollbar-*` 2 / hovercard / 两条渐变 / 代码块 banner）是 M2 唯一需要设计判断的部分。

  - **让位判定（D2 落地）**：判据 = `html[data-mia-appearance="on"]` **且** `data-mia-skin ≠ pure`；
    默认**不让位**（属性缺失/off/pure 时桌面壳行为与之前逐字节一致，零回归）。
    desktop 侧改动面很小：把 `themes/*.css` 拆成 `*.skin.css`（73 色阶 + 6 半透明 alias + 品牌重定向，
    让位时停注入）与 `*.deco.css`（`--ms-*` + 装饰规则，恒注入）——因为 `apply()` 本就是整块替换
    `styleEl.textContent`，拆分后让位是"少注入一段"而非"改一套逻辑"；`syncDark()` 与明暗 observer
    在让位时 `return`（把 `body[data-ds-dark-theme]` 的所有权交还官方 presenter）。
    切换条成为**第二入口**（让位态下 POST `/appearance/api/config` 并自行同步 `data-mia-skin`）。
    新增时序补偿：init script 早于 appearance 的 boot script，故需在 `onReady()` 复判 +
    监听 `html[data-mia-appearance]` 变化。

  - **boot style 防闪色**：用**属性选择器覆盖双明暗**——`html[data-mia-skin=x] body {…light…}` +
    `… body[data-ds-dark-theme] {…dark…}`。官方明暗由 `body` 属性驱动，CSS 选择器动态匹配，
    因此**首帧脚本不需要猜偏好、不需要读 localStorage**，`system` 偏好下也自动跟随。
    与运行时的一致性由"两处消费同一份 `lib/skins/*.js`"保证：boot style 是 head 的 `<style>`，
    presenter 写的是 body inline style（已含 override 层），后者覆盖前者但值相同 → 无跳变。

  - **壁纸层**定为 `body::before` **伪元素**（零 DOM、零 JS、首帧即生效、天然 `pointer-events: none`），
    `z-index:-1` 落在"body 背景之上、内容之下"；scrim / 晕影并入同一伪元素的**多重背景**，不额外开层。
    玻璃档位需 `backdrop-filter` 作用于**生成盒子的元素**，而官方 `[data-slot]` 锚点是 `display: contents`
    —— 这是**已知技术难点**，M2 第一步先做「玻璃命中探针」，命中失败的锚点降级为纯 alpha 分层。

  - 风险与未决 8 条、实施顺序 6 步（S1 探针 → S2 desktop 拆分 → S3 派生脚本 → S4 皮肤层 →
    S5 壁纸与玻璃 → S6 让位落地；S2/S3 可并行，S6 必须在 S4 之后）均在文档内。

  - 触摸点：`dsh-miasaki-appearance/design/2026-09-12-appearance-m2-design.md`（新增）、
    `design/CHANGELOG.md`（本条）、`README.md`（设计文档索引 + 状态行）。

- **M1 实机验收通过（六项全过）；过程修复两处实机 bug + 新增 host 路由契约测试**

  - **验收结论**：设计文档 §7 的六项实机项在本机（DSH 0.1.5-rc.1，`dsh web` 重启后）逐项通过——
    ① 设置栏出现且位于「通用」之后「模型」之前；② 契约自检「官方插槽与主题接口均在位」；
    ③ 明暗偏好直通官方（浅色 `--dsw-alias-bg-base` → `#fff`、跟随系统 → `#151517`，官方变量实时变化）、
    字号直通（14 → 15px 即时生效后拨回）；④ 总开关往返 `on → off → on` 即时翻转，
    `~/.dsh/miasaki-appearance/config.json` 正确落盘；⑤ 修订冲突 API 层复现（旧修订提交 →
    `409 revision-conflict` 并回带最新修订）；⑥ 关掉即原生（off 态下全文档零条本线样式注入、
    html 无 mia 内联样式）。验证完成后配置已恢复出厂（总开关默认关闭）。

  - **修①：Host 路由前缀尾随斜杠 → 全部 API 404（阻塞性，实机首发）**
    - **现象**：设置栏出现、面板结构完整，但面板顶部显示「HTTP 404」、所有控件 disabled、
      运行信息显示「持久化 未启用（dataDir 缺失）」；`curl /appearance/api/state` → 404，
      而 `sidebar/api/health` 200、`dual-model/api/state` 200。
    - **排查路径**：先核挂载三件套（link 依赖 / bundles 行 / junction，全在）→ `dsh --dump-config`
      显示 appearance 条目**在**服务树里（dump 不求值 `!!js`，只能证明 patch 被读）→
      读 vendor 源码 `packages/host/webserver/src/index.ts` 的 prefix 匹配：
      `pathname !== prefix && !pathname.startsWith(prefix + '/')` —— 本线注册的
      `path: '/appearance/api/'`（带尾斜杠）把 `/appearance/api/state` 拿去和
      `/appearance/api//` 比对，**永远失配**。sidebar 注册 `/sidebar/api`（无尾斜杠）因此正常。
    - **修法**：`index.js` 注册路径改为 `'/appearance/api'`（去尾斜杠），并在代码里写明
      webserver 匹配语义，防止后来者按「URL 目录惯例」把尾斜杠加回来。

  - **修②：`runtime.theme` apply 期一次性快照 → 明暗/字号永远 disabled**
    - **现象**：总开关打开后，明暗三个按钮与字号 ± 全部 `[disabled]`、字号显示「— px」，
      而契约自检却显示「通过」——两处矛盾。
    - **根因**：client 半 `apply(ctx)` 时执行 `runtime = { ctx, theme: ctx.get('theme') }`，
      **真实启动时序里 client bundle 的 apply 早于官方主题服务挂载**，快照固化为 `undefined`；
      契约自检（`collectProbe`）每次重新 `ctx.get('theme')`，服务就绪后自然显示通过。
      spike 动态探针里 theme 总是就绪的，所以建线时没暴露——这是「静态探针发现不了启动时序」的实例。
    - **修法**：改为惰性 getter `get theme() { return ctx.get('theme') }`，组件每次渲染重取实时服务。

  - **补：总开关翻转即时同步 `<html>` 门控属性**：原实现里 `data-mia-appearance` 只由首帧
    注入脚本在页面加载时写一次，运行中翻转开关要刷新页面才反映。现 `save()` 成功路径
    （与 `lib/config.js` 的 `buildBootScript` 同源）即时写 `data-mia-appearance` /
    `data-mia-skin` / `data-mia-scheme` —— 验收项「打开总开关 → `html[data-mia-appearance="on"]`」
    按字面成立，也为 M2 的 CSS 门控打好实时性基础（M1 内该属性尚无样式消费者，非阻塞，属顺手补齐）。

  - **回归闸门（新增 `test/host.test.js`，4 例）**：① API 路由注册为 `kind: 'prefix'` 且
    path **无尾随斜杠**；② 把 webserver 的 prefix 匹配语义照抄进测试，断言三个端点在
    `'/appearance/api'` 前缀下全部可达、相似前缀不误吞；③ 首帧注入订阅
    `webserver/index-inject` 且注入行为 `{kind:'script', placement:'body'}`；
    ④ `inject` 声明 `['webServer']` 硬依赖。连同 client 契约测试，装载与路由两侧各有兜底。

  - **验证**：`node --test test/*.test.js` → **38 例全绿**（34 + 4）；
    `node ../scripts/verify-all.mjs appearance` → **10/10 PASS**。
    回归矩阵基线同步：L1 行「外观 34 项 → 38 项」、§1 表 appearance 行 9 → **10**、
    增 2026-09-12 日志条目（`dsh-miasaki-shared-docs/cross/smoke-test-matrix.md`）。

  - 触摸点：`dsh-miasaki-appearance/index.js`（路由尾斜杠修复）、
    `dsh-miasaki-appearance/client.js`（theme 惰性 getter + save 后属性同步）、
    `dsh-miasaki-appearance/test/host.test.js`（新增）、`README.md`（状态行 + 测试段）、
    `design/2026-09-11-appearance-m1-design.md`（§7 验收结论补充）、`design/CHANGELOG.md`（本条）、
    `dsh-miasaki-shared-docs/cross/smoke-test-matrix.md`（基线 38 例 / 10 项 + 日志）。

## 2026-09-11（晚）

- **修：整包加载失败 `module is not defined`（实机启动即暴露）**

  - **现象**：重启 `dsh web` 后浏览器报 `Failed to load plugins /
    failed to import loader entry 201b625b (@miasaki/dsh-appearance): module is not defined`，
    设置里「外观」栏完全不出现。

  - **根因**：`client.js` 的 factory 里写了 `module.exports.inject` / `module.exports.apply` /
    `return module.exports`，但**没有声明 `module`**。DSH 的客户端装载器只把 `require` 交给
    factory（契约见 `@deepseek-ai/dsh-client-modules` 的 `ClientBundleRegistration`：
    `factory: (require) => exports`），`module` 不是注入项 —— factory 一执行就
    `ReferenceError: module is not defined`，`__ModuleLoader__` 拿不到导出，整个 bundle 加载失败。
    canvas / sidebar / ssh / dual-model 四条线都在 factory 首行写了
    `const module = { exports: {} }`，本线建线时漏了这一行（同一范式的复制遗漏）。

  - **为何此前自检没拦住**：`node --check` 只做语法检查，`module.exports` 在 ESM 里语法合法；
    `pnpm run build` 与 `verify-all` 的 L0 同样只到语法层。这是**运行期**才暴露的错误。
    Host 半（`index.js` 及其 `lib/`）导入正常，故障面仅限浏览器侧。

  - **修法**：`client.js` factory 首行补 `const module = { exports: {} }`，并写明「装载器不注入
    `module`」的原因，防止后来者再删。

  - **回归闸门（新增 `test/client.test.js`，5 例）**：在 **VM 上下文里刻意不提供 `module`**，
    执行 `client.js` 后调 `factory(require)`，断言 ①装载器收到的 id 为 `@miasaki/dsh-appearance`；
    ②上下文里 `module === undefined`；③factory 返回对象且 `inject === ['slots']`、`apply` 是函数；
    ④`apply` 把「外观」注册进 `settings.section`（`id: appearance`、`order: 5`）；
    ⑤`apply` 幂等 + fiber 拆除复位 `__DSH_APPEARANCE_BOOTED__`（允许 HMR 重挂）；
    ⑥通信走同源 `/appearance/api/*`、不出现 `host.call`。
    这一条与 ssh 线 2026-09-10 的 `invalid plugin … received undefined` 属同一类事故，
    现在两条线都各有契约测试兜底。

  - **顺手核对**：`webserver/index-inject` 事件与 `IndexInjection` 行类型（`{kind:'script',
    placement:'body', text}` / `{kind:'style', text}`）在本机 0.1.5-rc.1 上逐字复核通过，
    Host 半的首帧注入写法无需修改；`settings.section` 的 `label` 经 `resolveSlotLabel` 解析
    （`typeof t === 'function' ? t() : t`），传字符串 `'外观'` 合法。

  - **验证**：`node --test test/*.test.js` → **34 例全绿**（原 29 + 新增 5）；
    `node ../scripts/verify-all.mjs appearance` → **9/9 PASS**（原 8 项 + client 契约 1 项）。

  - 触摸点：`dsh-miasaki-appearance/client.js`（补一行 + 注释）、
    `dsh-miasaki-appearance/test/client.test.js`（新增）、`README.md`（测试段）、
    `design/CHANGELOG.md`（本条）、`scripts/verify-all.mjs`（L0/L1 注释）、
    `dsh-miasaki-shared-docs/cross/smoke-test-matrix.md`（基线 8/8 → 9/9）。

## 2026-09-11

- **建线 + M1 底座落地（同日完成一次 M1 spike）**

  - **立项与方向**：用户提出「设置页加一栏『外观』页，可开关主题 / 设置壁纸 / 设置动效 / 会话效果」，
    并要求参考 `plolpl789/dsh-raw-html`、`feitangyuan/motion-web`、`yoli-mi/dsh-client-ui-custom` 三个仓库。
    完成规划后用户拍板三项：**D1 新开一条线**（而非并入 desktop / sidebar）、**D2 外观线统一接管主题**
    （desktop 注入层让位）、**D3 下沉 desktop 既有三主题**（而非重画）。
    完整规划（官方契约取证、三仓库取舍、R1–R10 风险、M1–M5 路线、D1–D10 抉择）见
    [规划设计与方向选型](2026-09-11-appearance-settings-plan.md)。

  - **M1 spike（只读探针，产物已删）**：源码逐份核对 + 运行期动态探针双路取证，**方案无需修改**。
    确证七项：① `overrideTokens` 接受任意 token 名（含 `--dsw-static-*`）且写入 body inline style
    → **D3 成立**；② 层按 `seq` 叠加、同 source 再调 = 替换整层并置顶、停用即整层回收 → **双 source 设计成立**；
    ③ 客户端 `settingsScope.bind()` 可用，读接口 `getSnapshot()`；④ `settings.describe()` 枚举全部
    15 个命名空间（第三方与官方并列）→ **无需白名单、零补丁**；⑤ 用户设置文档 = `~/.dsh/settings.yaml`；
    ⑥ `index-inject` 支持 `style`(head) 等 6 种行 → 首帧防闪烁有正解；
    ⑦ `ConversationRoot` 直读 `--dsw-alias-bg-base`（无中间层）→ D8 的补丁代价确认，
    但「会话最大宽度」有官方变量可用、**无需补丁**。
    两项顺延到实施期（动效重放、性能基线）——动态插件 Client 半**无 DOM 能力**。
    副产物：把动态探针的六条能力边界（受限 Builtin、服务访问规则、`overrideTokens` 的 source 被
    强制改写为包 ID、`fs` 被沙箱拒、取数走同源路由、**服务注册必须挂 `ctx.effect` 否则泄漏**）
    整理进规划文档 §9.1 —— 其中最后一条是本次真实踩到的坑（一条路由在插件删除后仍在响应）。

  - **M1 实现**：新线骨架 `index.js`（Host）+ `client.js`（浏览器）+ `lib/`（配置模型 / 持久化 / 围栏）
    + `test/`（29 例）+ `cordis.patch.yml`；profile 侧以 `link:` 依赖 + `bundles` 行 + junction 挂载，
    与其余四线同构。设置里新增 **「外观」栏**（`settings.section`，`id: appearance`，`order: 5`，
    紧跟官方「通用」）。M1 可用：明暗偏好与正文字号**直通官方 `ctx.theme`**
    （与官方「通用 → 外观」是同一个偏好，不是第二套状态）、总开关门控 `html[data-mia-appearance]`、
    契约自检（浏览器采事实 → Host 判定 → 面板黄条）、让位检测（`html[data-miasaki-theme]` 在位即提示）、
    配置读写闭环（`/appearance/api/state|config|contract`，按板块深合并 + `expectedRevision` 乐观并发）。
    实施细节与验收清单见 [M1 实施](2026-09-11-appearance-m1-design.md)。

  - **两条关键决策**（都写进了 README 与实施文档，避免后来者重走一遍）：
    ① **配置自管 JSON，不注册 settings 命名空间** —— `link:` 装载时 `@deepseek-ai/schemastery`
    不在模块查找链上（实测 `ERR_MODULE_NOT_FOUND`），引入依赖一旦解析失败会拖垮整个 profile 的加载；
    canvas / sidebar / dual-model 三条线同一约定。官方通道本身可用，迁移路径记在实施文档 §8。
    ② **主题将走 `overrideTokens` 而非 `ctx.theme.register`** —— 官方「外观」行是**硬编码的
    light/dark/system 三立方**（`AppearanceRow` 只渲染 `CUBES`、不读注册表），注册进去的皮肤既不会
    出现在官方 UI，用户点官方立方还会把它顶掉；改用叠加层后明暗仍归官方三值管理、皮肤自动适配两种色阶、
    且停用即回收。

  - **纪律与契约**：总开关**默认关闭**，「未配置时对页面零影响」「关掉即原生」是硬契约与验收项；
    动效与装饰只挂 `[data-slot="…"]` 稳定锚点 + 自有前缀，不依赖哈希类名；
    需要改官方源码的能力（如聊天列独立不透明度，D8）默认不做，确需时并入 desktop 线既有补丁链。

  - **测试**：`node --check` 五个文件全绿；单测 **29 例**（配置模型 16 / 围栏 6 / 持久化 7）；
    `node ../scripts/verify-all.mjs appearance` → **8/8 PASS**；`verify-all.mjs` 已从六线扩为七线入口。

  - **实机复验点**（需重启 `dsh web`）：设置里出现「外观」栏且位于「通用」之后；
    面板契约状态条显示通过或按实际降级项给黄条；切明暗时官方三立方同步、改字号时会话正文即时变化；
    总开关往返写入 `~/.dsh/miasaki-appearance/config.json`；双标签页可复现修订冲突；
    关掉总开关后页面与原生逐像素一致。

  - 触摸点：`dsh-miasaki-appearance/**`（新线）、`scripts/verify-all.mjs`（七线入口）、
    `README.md`（根，七线描述）、`AGENTS.md`（七线描述）、
    `dsh-miasaki-shared-docs/cross/smoke-test-matrix.md`（实机项）；
    profile 侧：`~/.dsh/profiles/web/package.json`（link 依赖 + bundles）与
    `~/.dsh/profiles/web/node_modules/@miasaki/dsh-appearance`（junction）。
