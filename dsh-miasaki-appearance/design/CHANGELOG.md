# CHANGELOG — dsh-miasaki-appearance

本文件记录 `dsh-miasaki-appearance/` 线的设计决策与变更。

## 2026-09-26（深夜·续）· 修：`package.json` 的 `files` 缺 `assets/` —— 位图预设会在安装时静默丢失

**缺陷**（由同批新落地的仓库级闸门 `scripts/check-silent-guards.mjs` 的 **R4「声明清单缺口」首跑抓出**）：
`lib/icon-presets.js` 的三款位图预设引用 `assets/presets/{portrait,illustration,current}.png`，
而 `package.json` 的 `files` 白名单里**没有 `assets/`** —— 仓库里文件在、`test/icon-presets.test.js`
也断言了「位图预设的资源必须入库」，但**按 `files` 打包 / 安装时这三个文件不会进包**：
L0 回归全绿、单测全绿，症状只会在「装进 profile 后预设格退化成程序化几何图案」时才出现。

**为什么此前没有任何检查发现它**：`files` 与代码引用是两份互不相干的事实 ——
前者只在 npm 打包时被消费，`node --check` 与任何单测都不读它；而 `icon-presets.test.js` 查的是
**仓库磁盘**（`existsSync(join(root, ...))`），查的是另一半。**两半都对，中间空了。**

**修法**：`files` 补 `"assets/"`。闸门侧 R4 做的正是两向校验 ——
正向「`files` 列了就必须在磁盘上」与反向「host 半代码引用的资源必须被 `files` 覆盖」，本例命中反向那条。

**验证**：`node scripts/verify-all.mjs repo` → R4 由 3 处归零、`repo` 2/2 PASS；`appearance` 16/16 不变。

## 2026-09-26（深夜）· 修：配置写盘失败被吞掉却回报 200 成功（用户改动静默回滚）

**缺陷**（2026-09-14 评审点名、本次修复）：`POST /appearance/api/config` 的写盘链是
`writeChain.then(save).catch(logger.error)`，紧接着**无条件** `200 + changed: true`。而 `store.save` 抛错时
`current` / `revision`（赋值在 `await` 之后）保持旧值 ⇒ 响应体里的 `config` 是**旧配置**却自称 `changed: true`。
客户端（`client.js` 的 save 流程）据此 `setState` 旧值、按旧值重写门控属性、`setError(null)` ——
**用户改设置静默回滚，界面上没有任何提示**。

- **触发边界**：`dataDir` 缺失时不触发（`lib/store.js` 直接返回，不落盘）；需 `dataDir` 在位而
  `mkdir` / `writeFile` / `rename` 失败（权限、磁盘满、路径被同名文件占据）。
- **修法（host 半）**：把成败显式带回 —— 写盘失败一律 **`500 + error:'persist-failed' + changed:false`**
  + 当前（未生效的旧）配置 + 人类可读 `message`（`配置写入失败：<OS 原因>`）。`writeChain` 仍保持 resolved
  （一次失败不得让后续写入永久卡死）。
- **修法（client 半）**：`requestJson` 的文案优先级改为 **`message` > `error` 枚举 > `HTTP <status>`**，
  面板因此直接显示 OS 原因而不是 `persist-failed` 这种机器枚举。
- **加固（`lib/store.js`）**：原子写的临时名由固定 `${file}.tmp` 改为 `${file}.<pid>-<ts>.tmp` ——
  桌面壳 / 浏览器 GUI / 官方桌面端可能同时挂本插件各写一份配置，固定名会让两个进程互相截断半截 JSON。
- **回归闸门**（`test/host.test.js` 新增 1 例，该文件 16/16）：把 `dataDir` 指向一个**普通文件**造出可复现的
  EEXIST，钉死三件事 —— ①失败必须 500 且 `changed:false`；②内存配置与修订号**不得**变动（失败写入不生效）；
  ③失败后链路仍可继续（第二次仍如实失败，而不是卡死或转成假成功）。
  注：`apply` 的异步 `store.load()` 完成时也会把 `revision +1`（那是「加载」不是「写入」），
  用例因此先等加载落定再取基准，否则比较会假失败。
- 验证：`node scripts/verify-all.mjs appearance` **16/16 PASS**（95 例单测 + 皮肤表复算闸门）。

## 2026-09-25 · 玻璃 `mica` 档与原生材质分层（消除双层模糊，规划 W4.2）

- **问题**：`mica` 档的产品语义是「**用系统云母**」，但实现是页面侧 `backdrop-filter: blur(40px) saturate(1.6)`。Win11 上壳的原生 Mica（`DWMWA_SYSTEMBACKDROP_TYPE`）同时生效 ⇒ 两层模糊叠在一起：更糊、更耗电，且与档位语义自相矛盾（M2 设计文档里那句"web 近似、非 Win11 真 Mica"正是这个矛盾的注脚）。此前 `data-mia-glass` 与壳的 `MIASAKI_NO_MICA` **互不知情**。
- **修法**（跨线契约：**壳说事实、页面选分支**）：`lib/config.js` 的 `buildGlassBootCss` 里，`mica` 档的选择器加条件
  `html[data-mia-glass="mica"]:not([data-mia-native-mica="on"])` —— 原生云母生效时**不输出**页面侧模糊。
  事实来源：壳注入预判值（Win11 且未禁用 ⇒ true）+ 页面就绪后用 DWM 实际结果广播修正，
  由 `dsh-miasaki-desktop/themes/src/12-material.js` 落到 `html[data-mia-native-mica]`。
- **为什么首帧即正确**：该属性在 `document_start` 就位，**早于** boot style 的解析期 —— 不需要"先叠一层再撤"的过渡。
- **不波及 `light`/`frost`**：它们是「页面自己做玻璃」的独立档位，与原生材质叠加属用户选择，语义不冲突；测试显式断言这两个档位的 CSS **不含** `data-mia-native-mica`。
- **回归**：`verify-all appearance` **16/16**（`test/config.test.js` 新增 W4.2 断言：mica 档必须带 `:not(...)`、light/frost 不得带）。
- **待实机**：Win11 选 `mica` 档应只有一层模糊；`MIASAKI_NO_MICA=1` 时应回落页面侧模糊。详见 desktop 线 CHANGELOG 同日 W4.2 条目。

## 2026-09-25 · 首帧注入行加官方 kind 白名单（规划 W4.1）

- **由来**：官方 `dsh-host-webserver`（实测 0.1.7-rc.2）的 `renderRow` 只认六种注入行
  （`global` / `script` / `script-src` / `script-preload` / `style` / `html`），而 DSH 前端应用注入行时
  对未知 kind 是 **`throw new Error("web boot: unknown index injection row")`** —— 这是
  **启动期抛错、整页起不来**，不是静默降级。产出侧写错一个字符串，代价是前端白屏。
- **修法**：`index.js` 的 `webserver/index-inject` 订阅里改为经 `pushRow()` 产出，
  kind 不在白名单即 `ctx.logger.error` 并**丢弃该行**（宁可少注入一层样式，不可让前端启动失败）。
  白名单常量与官方 `renderRow` 六种行一一对应，注释里写明对应关系。
- **闸门**：`test/host.test.js` 新增「注入行 kind 必须落在官方六种行白名单内」——
  正向断言每次实际产出的每一行都合法，另断言 `style` 行不得自带与官方冲突的 `placement`。
- **回归**：`node scripts/verify-all.mjs appearance` **16/16 PASS**。
- **依据**：[`official-desktop-adoption-plan-2026-09-25.md`](../../dsh-miasaki-shared-docs/cross/official-desktop-adoption-plan-2026-09-25.md) §4 W4/T4.1
  与 [`dsh-official-desktop-analysis-2026-09-25.md`](../../dsh-miasaki-shared-docs/dsh-platform/dsh-official-desktop-analysis-2026-09-25.md) §1.1（injections kind 白名单实测）。

## 2026-09-23 · 修：`renderPreset` 对位图预设静默画黑徽记（二轮复审 P3）

- **发现**（第二轮独立复审报出，核实**属实**）：`lib/icon-presets.js` 的
  `renderPreset(preset, size)` 是底层渲染器，`compileFill(undefined)` 会落到末行
  `return () => [0, 0, 0]` 兜底 —— 位图预设（`portrait` / `illustration` / `current`，
  只有 `asset` 没有 `mark`）被直调时会画出一张「黑徽记」脏图。公开入口 `renderPresetPng`
  已提前 `return null`（并已有单测），故仅**越过公开入口的直调**可达 —— 防御性瑕疵，
  非当前缺陷，但静默画错比崩溃更难发现。
- **修法**：`renderPreset` 开头三分支显式拒绝 —— 非对象预设 / 位图预设（`asset !== undefined`）
  / 缺 `mark` 字段，一律抛 `TypeError`（**响亮失败**）。公开入口的 `null` 契约不变。
- **回归闸门**：`test/icon-presets.test.js` 新增 1 例 —— 三款位图预设逐个断言抛错 +
  缺 `mark` 的合成预设 + `null`；单测 94 → **95 例**（icon-presets 7 → 8）。
- 触摸点：`lib/icon-presets.js`、`test/icon-presets.test.js`、`README.md`、本文件。

## 2026-09-23 · 修：外观设置页整栏空白（primitives 图标名漂移，实机首崩）

- **现象**（用户 21:58 重启 `dsh web` 后报告）：设置页「外观」栏点开是**空白**的；同泳道的
  「自定义 agent」也不见踪影（后者是 0.1.7  preset 机制变更，见下节「关联发现」）。
- **根因**：`client.js` 引用 5 个**前端壳 seed 里不存在**的 primitives 图标导出——
  明暗立方用 `IconLightOutline16` / `IconDarkOutline16` / `IconFollowsystemOutline16`，
  字号/旋钮步进器用 `IconChevronUpOutline14` / `IconChevronDownOutline14`。当前
  primitives 的唯一运行时来源是前端壳 staticModules seed
  （`dsh-web-frontend/dist/assets/index-*.js` 的冻结导出表），其命名约定是
  **`Icon<名称>Outline<Medium|Regular>`（尺寸走 props，不进名字）**——官方
  `dsh-client-ui-theme` 的 AppearanceRow / FontSizeRow 用的就是这套名字。
  上述 5 个名字求值为 `undefined` → `React.createElement(undefined, …)` 在面板
  **首渲染即抛** → 槽位错误边界把 `settings.section` 的 appearance entry 罚下
  （abdicate）→ 内容区只剩一个空 `data-slot-error` stub（导航行仍在，因为 nav 读的是
  原始账本 `entries()` 而非投影 `entriesOfSlot()`）。
- **为什么测试全绿却没拦住**：与 2026-09-12 那次空白事故同型——`test/client.test.js`
  的 primitives stub 用**同错名**字符串顶替（`IconLightOutline16: 'IconLightOutline16'`），
  stub 冒烟永远绿；注册期契约测试又不执行 `slots.inject` 回调。M2.6 引入官方原语改名后
  「实机视觉待验收」一直没验收，直到本次重启第一次真机渲染才爆。
- **修法**：5 处图标名改为 seed 实际导出——`IconLightOutlineMedium` /
  `IconDarkOutlineMedium` / `IconFollowsystemOutlineMedium` /
  `IconChevronUpOutlineRegular` / `IconChevronDownOutlineRegular`（chevron 的
  `size: 9`  props 与官方 FontSizeRow 逐字一致）。
- **回归闸门**（三条新测试，把盲区堵死）：
  1. **引用闭环**——client.js 里每个 `primitives.X` 都必须在 stub 白名单里（白名单即
     seed 导出名的本仓镜像）；
  2. **命名合规**——stub 里每个图标名必须匹配 `/^Icon\w+Outline(?:Medium|Regular)$/`，
     尺寸后缀名（`*Outline16` / `*Outline14`）直接红；
  3. **渲染树签名**——驱动到「配置已加载 + 图标板块就绪」完整路径后走查整棵元素树，
     出现 `undefined`/`null` 元素类型即失败（React 整棵抛错的直接签名）。
- **验证**：单测 **94 例全绿**（config 30 / client 15 / host 14 / icon-presets 7 / avatar 8 /
  skins 7 / fence 6 / store 7；runner spawn 在 Windows 沙箱 EPERM，逐文件直跑）。
  并行会话同期为 `lib/icon-presets.js` 补 1 例 fail-loud 守卫测试（见上条），全文件现 **95 例**；
  `node --check` 七文件通过。**待用户硬刷新（Ctrl+F5）后验收**——外观栏应恢复完整面板
  （启用/主题/壁纸/应用图标四组 + 契约状态条）。
- 触摸点：`client.js`、`test/client.test.js`、本文件。

### 关联发现：0.1.7 的「自定义 agent」改由 bundle 声明，不再扫目录

- 0.1.7-alpha.2 的 `@deepseek-ai/dsh-agent-preset-registry` README 原话：**「注册表不扫描
  目录，也不接受 preset 路径」**——Web 内置定义（standard / ptc / minimal / cordis 四款）
  来自 `dsh-web-app` 的 `presets/*.patch.yml`；**新建/覆盖 preset 一律是 profile 补丁行**
  （`preset-<id>` → `@deepseek-ai/dsh-agent-preset`，Web 编辑器保存时写入
  `~/.dsh/profiles/web/cordis.patch.yml`）。
- `~/.dsh/.agent-presets/{inverse,kurumi,whale}`（8 月 27 日）是**桌宠线**的预设Store
  （`apply-presets.ps1` 同步目标），0.1.7 的 Web 注册表**不读它**——若用户的自定义 agent
  是旧机制（目录扫描 / 桌宠同步）建的，升级后自然从 Web 设置里消失；数据仍在盘上，
  需要以 bundle 补丁行重新声明才能回 Web。
- 现状核对：`~/.dsh/profiles/web/cordis.patch.yml` 当前只有 4 条配置覆盖
  （ui-settings-general / agent-default-model / ui-theme / llm-pi-ai），**没有任何
  `preset-*` 行**——即 Web 侧当前只有四款内置 preset。若用户曾在 0.1.7 的 Web 编辑器里
  建过自定义 agent，那些行应出现在此文件；不见即被 22:20 那次设置回写冲掉或是旧机制数据，
  需用户确认「自定义 agent 是在哪个界面、什么时候建的」再决定恢复路径。

## 2026-09-23 · 应用图标预设扩为四款（位图预设 1 → 3，鲸鱼娘三构图全进九宫格）

- **起因**：用户「这两个做成你的预设应用图标」并附两张图；澄清后落点是**外观设置「应用图标」
  预设九宫格扩容**——两张图**都是鲸鱼娘**，加上现行软件图标，要求**三款应用图标全部进预设
  自由选换**。（核查发现其中一张正是 2026-09-21 已入库的「头像」源图：按旧配方
  trim→裁方→512→圆角重跑，与在库 `portrait.png` 逐像素差仅 1.43/255——同图不重复劳动。）
- **新增两款位图预设**（`assets/presets/`，管线与 M2.7 一字不差）：
  - **立绘** `illustration.png`（62,545 B）：用户新提供的 1254×1254 方图，蓝天底竖构图，
    满幅无黑边 → 不 trim、居中裁方即全图 → 512 → 圆角（rx 120）→ 量化；
  - **现行** `current.png`（122,789 B）：**现行 EXE 图标同款艺术图** `src-tauri/icon-new.png`
    （desktop 线构建链输入，1024×1024）同配方重出 —— 用户点名"和现在的软件图标并不一样"，
    要把现在这一款也收进预设，换图后仍可一键换回。
- **预设表**（`lib/icon-presets.js`）：默认 / 头像 / 立绘 / 现行共四款；顺序
  default → portrait → illustration → current（「默认」居首的既有契约不变，新款追加在后）。
- **为什么不做「随主题自动切换」**：设计文档 §10 列过该方向，但用户本次明确说"自由选择替换"——
  手动选即可，不引入 theme→icon 的隐式绑定（也免掉桌面壳二次改动）。
- **零跨线影响**：新款与既有款走同一条路（同目录 / 同白名单 / 同 `GET /appearance/api/presets`
  幂等落盘），桌面壳不知道款数变化；「我的上传」pills 照旧过滤 `preset-*`。
- **一次性脚本**：`sharp` 只在 desktop 线构建链里，生成脚本**不入库**，归档
  `_refs/scripts-archive/make-icon-presets-2026-09-23.mjs`；配方与产物字节数记录在
  `assets/presets/README.md`。
- **验证**：单测 **84 例全绿**（icon-presets 7 / host 14 / client 12 / config 30 / avatar 8 /
  fence 6 / store 7；`node --test` runner 的 spawn 在 Windows 沙箱下 EPERM，逐文件直跑替代——
  与代码无关的环境边界）；`node --check` 七文件通过；`derive-skins --check` 两皮肤一致。
  测试断言随款数更新（预设表四款与顺序 / 位图三款资源在位 512×512 / host 落盘四款 /
  client 九宫格四格）。**实机待用户重启 `dsh web` 后验收**。
- 触摸点：`assets/presets/{illustration,current}.png`（新）、`assets/presets/README.md`、
  `lib/icon-presets.js`、`test/{icon-presets,host,client}.test.js`、`README.md`、本文件。

## 2026-09-22 · Boot Splash 首帧启动画（设计定稿，跨线新增项，未实施）

- **起因**：用户「现在的启动加载界面太简单不符合本项目……加载页弄酷炫一点」。同一需求的
  desktop 半（loading.html 2.0 + dsh stdout 内嵌日志流 + `cmd /C dsh web` 闪窗根治）见 desktop 线
  `design/boot-loading-terminal.md`；本文件只记 appearance 半，契约见
  `../dsh-miasaki-shared-docs/cross/boot-loading-2026-09-22.md`。
- **设计**：DSH 首帧（3080 HTML 到达 → shell 挂载）在 M2 防闪色底座之上叠一层全屏启动画
  （`#mia-splash`：三主题纹章动效 + wordmark + 流动三点进度，**不出假百分比**，遵守「不假装」约定）。
  走既有 `index-inject` 扩展三行（splash style / splash html / splash script），零新订阅点。
- **退场双信号 + 超时兜底**：主信号 = client 装载（shell 已挂载的最可靠证据）；兜底 =
  MutationObserver 观察 body；**2.5s 无条件淡出**——硬用例是 401/后端异常首帧不能被 splash
  常驻挡住（与 desktop P1「401 恢复指引」互为前后置）。幂等守卫 `data-mia-splash-done`。
- **契约**：总开关关闭 / `bootSplash:'off'` ⇒ 一行不注入（与 boot style 同门控）；
  `prefers-reduced-motion` 全静止；配置 v2→v3 仅加默认字段（v2 壁纸先例同款低风险）。
- **实施顺序**：S1 复测 index-inject placement 与 `__DSH_BOOT_READY__` 尾巴（半年前 spike 记录，
  不凭记忆写码）→ S2 `lib/splash.js` 纯函数 + 单测 → S3 host 接线 → S4 client 退场钩子 → S5 实机验收。
- 触摸点（预期）：`lib/splash.js`（新）、`lib/config.js`（motion.bootSplash 字段）、`index.js`
  （注入点扩展）、`client.js`（退场钩子）、`test/splash.test.js`（新）、`README.md`、本文件、
  `design/2026-09-22-appearance-boot-splash-design.md`（新）、cross 契约（新）。

## 2026-09-21 · M2.7：应用图标预设（九宫格 + 程序化生成 + 位图预设）

- **起因**：M2.5 上线后用户给出参考截图，要求「像这样的预设」—— 一组**内置可选的应用图标**
  （网格排列、点选即用），而不只是上传自己的图。设计见
  [M2.7 设计](2026-09-21-appearance-icon-presets-design.md)。

- **预设从哪来：程序化生成，不是塞一批 PNG 资源**。三条理由：① 本线硬纪律是**零第三方依赖**
  （不能引 sharp / canvas），而仓库里唯一现成的光栅器在 desktop 线，跨线取素材正是本仓明令避免的耦合；
  ② 图像资源一旦入库就不可参数化，而这里配色 / 圆角 / 构图全是数据；③ 交付物仍是普通 PNG，
  所以**桌面壳那侧零改动、跨线契约一个字不用改**。
  - `lib/icon-presets.js`：手写 PNG 编码（CRC32 + chunk 组装 + `node:zlib` deflate）、
    SDF 解析式抗锯齿绘制（圆角矩形 / 圆）、线性渐变填充、逐层 alpha-over 合成、圆角方遮罩裁边。
    512×512 单张毫秒级，九张一次生成不到一秒。
  - 骨架（抽象「M」：左右各一组「短块 + 长块」+ 中央两枚圆点）由 A/B/C/D 四版**渲染出来目检**后选定
    （C 版：方块 + 圆点的像素感）；配色与骨架都是数据 → 换色不换形。
  - **最终只留两款**（用户同日拍板）：**默认**（程序化几何徽记）+ **头像**（位图预设）。
    参考截图里那套通用软件风格的多配色图标（暗夜玻璃 / 素雅银 / 果冻蓝 / 缠线绿 / 蒙德里安 /
    暖橙 / 流光）**不适合本项目** —— 参考图只是"要有预设、网格可选"这一**形式**的参照。
    初版七款连同它们带出的三项渲染能力（顶部高光 `gloss` / 装饰层 `deco` / 骨架覆盖 `marks`）
    **一并撤掉**，不留死代码；将来若要加款，配色应取本仓三主题的色感而非通用软件的习惯。

- **「头像」是唯一的位图预设**（用户点名：「用我前面发给你的那个头像修剪一下做第二个应用图标」）：
  - 资源 `assets/presets/portrait.png`（512×512，97 KB）。原图边缘有一圈**纯黑描边**，
    直接裁方会带黑边 —— 处理链因此是 `trim(12) → 居中裁方 420 → resize 512 → 23.5% 圆角蒙版 →
    PNG 调色板量化`（未量化 471 KB → 97 KB，肉眼无差）。参数与来源记在 `assets/presets/README.md`。
  - 生成脚本一次性（依赖 sharp，不入库）：本线零依赖，sharp 只在 desktop 线的构建链里。

- **host**：新增 `GET /appearance/api/presets` —— 一次请求里做**幂等落盘**（把预设图标写进
  `avatars/preset-<id>.png`，内容相同则跳过写入）+ 返回清单。落盘是契约的关键：预设图标与
  用户上传的图走**同一条路**（同一个目录、同一套文件名白名单、同一个文件路由），
  桌面壳对「预设」零感知。位图预设读插件资源，其余即时渲染，两者对 host 是同一个接口。

- **client**：`软件头像` 板块升级为**`应用图标`** —— 九宫格（`repeat(auto-fill, minmax(104px,1fr))`，
  选中格走官方 `bg-module-platform` + `neutral-bluish-400` 描边，与官方「通用设置」页选中态同源）
  + 「自定义」行（上传 / 清除）+「我的上传」pills（**过滤掉 `preset-*`**，用户只看自己的资产）。
  上传链路与归一化未变。

- **验证**：单测 81 → **91 例**（新增 `test/icon-presets.test.js` 7 例：预设表一致性（**断言只有两款**）、
  文件名 / URL 往返、圆角外透明与徽记可见、渲染确定性、PNG 结构（签名 + IHDR + IEND + IDAT 可解 +
  尺寸钳制）、CRC 自查、位图资源在位；host 侧 2 例：幂等落盘 + 无 dataDir 不谎报）；verify-all appearance
  14 → **16 项**。两款预设拼图目检通过（`_refs/preview/presets.png`，一次性产物）。

- 触摸点：`lib/icon-presets.js`（新）、`assets/presets/{portrait.png,README.md}`（新）、
  `index.js`、`client.js`、`test/{icon-presets,host,client}.test.js`、`package.json`、
  `README.md`、`design/2026-09-21-appearance-icon-presets-design.md`；
  `../scripts/verify-all.mjs`、`../dsh-miasaki-shared-docs/cross/{appearance-launcher-icon-2026-09-21,smoke-test-matrix}.md`。

## 2026-09-21 · M2.6：面板风格对齐官方「通用设置」页

- **起因**：用户「新加的设置也都参照通用设置页的风格优化设计」。本线面板此前的自绘卡片风
  （描边圆角盒 + 药丸按钮 + 自绘滑块）与官方「通用设置」页的行式风格不一致，视觉上像
  「另一个应用」。M2.6 把**整栏面板**（含 M2 皮肤 / 壁纸 / 玻璃与 M2.5 软件头像）重做为
  官方行式风格。

- **风格取证（逐条对照官方包，不猜）**：
  - 行：`@deepseek-ai/dsh-client-ui-theme` 的 `FontSizeRow.module.css` ——
    `border-bottom:.5px solid var(--dsw-alias-border-l2)` + `padding:16px 0`，
    标题 14px/22 `label-primary`（weight 400），说明 12px/18 `label-tertiary`，
    控件右置（`rowText` flex:1 + `padding-right:48px`）；
  - 组标题 / 明暗立方：同包 `AppearanceRow` —— 立方 `.5px border-l4`、`border-radius:20px`、
    `padding:20px 32px`、选中态 `bg-module-platform` + `neutral-bluish-400` 边；
  - 步进器：`FontSizeRow` 的 `stepper` 胶囊（`bg-module-platform`、`radius:18px`、
    `min-width:72px`、`tabular-nums` 值、悬停/聚焦露出 9px 上下箭头）；
  - 栏宽与通知：`dsh-client-ui-settings-models` 的 `section{max-width:720px}` 与
    `notice`（12px/18，warn-label / success-primary 着色）。

- **为什么直接复用官方 primitives 而不是继续自绘**：`Button / Switch / Pill / 图标`
  经取证是**前端壳 staticModules 的 seed 模块**（`dsh-web-frontend` 的 `My()` seed 表里
  有 `@deepseek-ai/dsh-client-ui-primitives`），`require` 即得、**不产生模块图边**
  （seed 词无 external 声明也不需要，`orderByModuleGraph` 明确 seed 不加边），因此
  `package.json` 无需 `dsh.client.external`。所得即官方同款控件：Switch 是官方
  `role=switch` 实现、Pill 是官方分段选择、Button 的 outline/sm 与「打开配置文件」
  同一规格 —— 行为（键盘、焦点、禁用态、悬停色）也一并是官方的，不必各自维护。

- **为什么 CSS 走自有 `.mia-*` 前缀注入**：官方行式 CSS 在各自包的 module.css 里，
  跨包不可 import；照抄一份到本 bundle 并用 `.mia-*` 前缀（README 锚点纪律：
  不依赖官方哈希类名，官方改版不连带打脸）。注入式与官方 client 插件同构 ——
  factory 体内按 `data-plugin-css` 查询去重后 `head.appendChild`，token 全走
  `--dsw-*` 官方变量，**自动跟皮肤与明暗解析**（本线皮肤覆盖的 alias 同样生效）。

- **同步整理的文案**：玻璃档位改中文标签（关闭 / 轻 / 磨砂 / 云母，配置值不变）、
  内置渐变改「内置 · 极光/暮色/余烬」；面板不再自绘大标题（官方 section 页由导航栏
  标注「外观」，通用页本身无页头），运行信息 / 占位板块收敛为组标题 + 三级说明文字。

- **行为零变化**：配置读写、契约自检、上传链路、皮肤接管、明暗/字号直通官方 API 的
  逻辑一行未动，只换表现层。M2.5 的 `avatar-host-stale` 降级提示保留。

- **验证**：单测 **81 例全绿**（原 79 + 风格契约 2：primitives require 形态、`.mia-*`
  行式与官方 token 断言）；`node --check` 双文件通过；`verify-all appearance` **14/14**。
  实机视觉（行距 / 立方 / 步进器 / 三主题）待用户重启 `dsh web` 后验收。

- 触摸点：`client.js`（面板重写 + primitives require + `.mia-*` CSS 注入）、
  `test/client.test.js`（primitives stub / document stub `dataset`+`appendChild` /
  风格契约 2 例）、`README.md`、本文件。

## 2026-09-21 · M2.5：软件头像（外观设置 → 桌面壳启动器图标）

- **起因**：用户「外观设置里要可以设置软件头像，比如这个」（附图）。澄清后确认落点是
  **桌面壳 `Miasaki.exe` 的启动器图标**（任务栏 / 窗口 / 托盘那一处），入口仍是本线在
  设置里的「外观」栏 —— 也就是本线第一条**跨线**能力：外观线出配置与图片，桌面壳消费。
  设计见 [M2.5 设计](2026-09-21-appearance-avatar-launcher-design.md)。

- **为什么走「配置文件」而不是页面通道**：桌面壳已有 hash 巡检（页面 → Rust）与 1.5s
  自愈巡检两套机制，但头像是**文件态**——用户既可能在面板里上传，也可能直接往
  `avatars/` 里丢一张图。让 Rust 直读 `<dshHome>/miasaki-appearance/config.json`
  对两条路径一视同仁，且页面没开着也生效；代价只是每 1.5 秒一次小 JSON 读取。
  （DOM 属性 / hash 通道方案被否：多一跳、且要求页面在场。）

- **契约收敛到唯一一种格式：PNG**。桌面壳只依赖 `png` crate（不引入 jpeg/webp 解码器），
  所以浏览器侧用 canvas 把任意格式重编码成 PNG（最长边压到 512）后上传；host 只做
  「真 PNG？多大？」的最终把关。好处是三处受益：壳侧零新依赖、上传体积可控、
  「面板上传」与「手动放目录」落到同一种文件上。

- **host（`index.js` + `lib/`）**
  - 配置 v2 → v3：新增 `avatar.source`（纯新增字段，旧配置补空串 = 不设置）。
  - `lib/avatar.js`（新）：`isPng` 魔数校验、`parseAvatarDataUrl`（只收
    `data:image/png;base64,`，上限 4MB）、`avatarFileFromSource`（文件名白名单 +
    percent 解码 + 单段路径）、`makeAvatarName`（时间戳 + 随机后缀，绝不覆盖）。
  - 路由：`GET /appearance/api/avatars`（清单）、`POST /appearance/api/avatar`（上传，
    只写文件不改配置）、`GET /appearance/avatar/<file>`（预览）；上传 body 上限单独放宽到
    8MB，文件路由与壁纸共用同一套「目录 + 文件名白名单 + normalize 前缀」防穿越。
  - `config.avatar.source` 的收窄**比壁纸严得多**：只接受本线头像路由下的白名单文件
    （外链、其它路由、非 PNG、穿越路径一律清空）——因为它是跨线输入，壳侧必须永远只读
    自己那一个本地目录、永不联网。

- **client（`client.js`）**
  - 面板新增「软件头像」板块：预览（44px）+「上传图片…／清除」+ 已有文件选择器。
  - 上传链路：`createImageBitmap` → canvas 重编码 PNG（≤512）→ `POST /avatar` →
    `PATCH /config` 启用。**两步是刻意的**：上传只落盘、启用由配置决定，
    这样「上传了先不用」是合法状态，也不会顶掉用户已选的头像。
  - 契约自检新增 `avatar-host-stale`：client 更新而 host 未重启时配置里根本没有
    `avatar` 字段（写进去会被旧 sanitize 丢掉），面板给黄条 + 重启提示，
    而不是让设置静默失效。**只在探针明确报 `false` 时判定**，旧 client 不上报该字段
    → 不误报。

- **desktop（消费端，见 desktop CHANGELOG 同日条目）**：新增 `launcher_icon` 模块 ——
  读同一份配置 → PNG 解码 → 中心裁方（图标必须方的，非方图会被拉伸）+ 盒式降采样到
  ≤256px → `window.set_icon` + `tray.set_icon`。任何异常（配置坏、文件缺失、解码失败）
  都只写一行日志并回退出厂图标，绝不阻断启动。

- **边界（明确不做）**：EXE 文件自身、桌面 / 开始菜单快捷方式的静态图标是**构建期资源**
  （`make-icons.mjs` + `npx tauri icon`），运行时改不了 —— 面板文案已写明，
  避免用户以为是 bug。

- **验证**：appearance 单测 **79 例全绿**（原 60 + 头像 19：`lib/avatar.js` 纯逻辑 8、
  配置收窄与契约 4、host 路由 4、client 渲染冒烟 2、既有断言随 v3 调整），
  覆盖「伪装成 PNG 的其它内容」「编码穿越」「host 未更新时的面板降级」三条主风险；
  desktop `cargo check --tests` 通过 + `cargo test` 新增 6 例（白名单/百分号解码/中心裁方/
  降采样/坏 PNG 不 panic）。**实机验收（上传 → 任务栏图标跟随）待用户重启 dsh web 后执行**。

- 触摸点：`index.js`、`client.js`、`lib/{config,avatar}.js`、`test/{avatar,config,host,client}.test.js`、
  `README.md`、`design/2026-09-21-appearance-avatar-launcher-design.md`；
  desktop：`src-tauri/src/{main,launcher_icon}.rs`、`design/CHANGELOG.md`、`README.md`；
  `../dsh-miasaki-shared-docs/cross/appearance-launcher-icon-2026-09-21.md`（跨线契约）。

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
