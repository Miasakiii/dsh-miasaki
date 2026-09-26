# @miasaki/dsh-appearance

DSH Web 的**外观线**：在「设置」里新增一栏 **外观**，集中管理主题皮肤、壁纸、动效与会话效果。

- **零 shell 改动**：只用官方扩展点（`settings.section` 插槽 + `ctx.theme` 服务 + `webserver/index-inject` 首帧注入），不修改 DSH 本体、不注入压缩 bundle。
- **零第三方依赖**：host 半只用 Node 内建模块，配置自管 JSON —— 与本仓 canvas / sidebar / dual-model 三条线同一约定（理由见下）。
- **关掉即原生**：总开关默认**关闭**，未配置时对页面零影响（只写两个 `data-*` 属性）；这是本线的硬契约与验收项。

> 当前状态：**M2 已实现（S1–S6 全收官，2026-09-12）**——三皮肤（刻刻帝/狂狂帝，105 token
> 编译表）+ 壁纸层（内置渐变/本地目录图源、玻璃四档、表面不透明度四旋钮）+ desktop 让位协议。
> M1 已实机验证（六项全过）；M2 的皮肤/壁纸/玻璃链路已实机验证（绯红品牌、color-mix 表面、
> backdrop-filter 均生效），**12 组视觉矩阵、帧率基线与桌面壳同页实机项（切换条双入口 /
> aurora×壁纸）待用户验收**。设计见 [M2 设计](design/2026-09-12-appearance-m2-design.md)，
> 变更详情见 [变更记录](design/CHANGELOG.md)。
>
> **M2.5 软件头像已实现（2026-09-21）**：外观设置里可上传 / 选择一张 PNG 作为**软件头像**，
> 桌面壳 `Miasaki.exe` 读同一份配置把它用作窗口 / 任务栏 / 托盘图标（本线第一条跨线能力，
> 契约见 [M2.5 设计](design/2026-09-21-appearance-avatar-launcher-design.md)）——
> **实机验收（上传 → 任务栏图标跟随）待重启 `dsh web` 后由用户执行**。
>
> **M2.6 面板风格对齐官方「通用设置」页（2026-09-21）**：整栏面板重做为官方行式风格
> （0.5px 分隔线 + 16px 行距 / 14px 标题 / 12px 说明 / 明暗立方 / 步进器），交互控件
> 直接复用官方 primitives（`Button / Switch / Pill / 图标`，前端壳 seed 模块，零新依赖）；
> 行为逻辑零变化。（其中的明暗立方已于 2026-09-26 随去重移除，见下。）
>
> **M2.7 应用图标预设已实现（2026-09-21）**：外观设置里的「软件头像」升级为**「应用图标」**，
> 内置**两款预设** —— **默认**（本线程序化生成的几何徽记）与**头像**（用户提供的图，trim 黑边后
> 裁方 + 圆角 + 量化），点选即用。预设图标落盘后与用户上传的图同源 ⇒ **桌面壳零改动**
> （见 [M2.7 设计](design/2026-09-21-appearance-icon-presets-design.md)）。
> 参考截图只作**形式**参照：那套通用软件风格的多配色图标不适合本项目，初版七款已按用户意见撤掉。
>
> **2026-09-26（深夜·续）`files` 清单补 `assets/`**：`package.json` 的 `files` 此前缺 `assets/`，
> 而 `lib/icon-presets.js` 引用 `assets/presets/*.png` —— 仓库里有、**装进 profile 后预设位图会静默消失**
> （L0 与单测都发现不了：前者不读 `files`，后者只查仓库磁盘）。该缺陷由同批新落地的仓库级闸门
> `scripts/check-silent-guards.mjs` 的 R4「声明清单缺口」首跑抓出并修复。
> 动效 / 会话效果分别在 M3–M4 接入同一套管线。
>
> **应用图标预设扩为四款（2026-09-23）**：用户追加两张鲸鱼娘图，要求**三款应用图标**
> （现行软件图标 + 两张新图）全部进预设自由选 —— 位图预设从一款扩到三款：**头像**（原图）、
> **立绘**（新方图）、**现行**（现行 EXE 图标同款艺术图 `src-tauri/icon-new.png`）；
> 与程序化「默认」共四格。管线与 M2.7 完全一致（trim → 裁方 → 512 → 圆角 → 量化），
> 跨线契约零变更，面板零改动。
>
> **Boot Splash 首帧启动画（2026-09-22 设计定稿，2026-09-26 P2 实施，S5 实机待验收）**：
> DSH 首帧（3080 HTML 到达 → shell 挂载）叠一层全屏启动画——皮肤色即显 + 三主题纹章动效
> （刻刻帝顺时针 / 狂狂帝逆时针 / 纯净静止）+ wordmark + 流动三点，shell 挂载后 300ms 干净淡出，
> 2.5s 超时兜底不挡错误页（401 硬用例）。走既有 `webserver/index-inject` 追加三行
> （splash style / splash html / splash script），**首次启用官方 `html` 行 kind**；退场双信号
> （client 装载即退 + MutationObserver 兜底）+ 幂等守卫；配置 `motion.bootSplash`（v5），
> 总开关关闭或 `off` ⇒ 一行不注入（关掉即原生）。
> 与 desktop 线「Loading 2.0 + cmd 闪窗根治」为同一用户需求的两半，
> 契约见 [cross 文档](../dsh-miasaki-shared-docs/cross/boot-loading-2026-09-22.md)，
> 本线设计与实施记录见 [Boot Splash 设计](design/2026-09-22-appearance-boot-splash-design.md)。
>
> **修：外观栏整栏空白（2026-09-23，primitives 图标名漂移）**：M2.6 复用官方 primitives 时
> 误用旧版图标名（`IconLightOutline16` 等带尺寸后缀），而前端壳 seed 的实际导出是
> `Icon<名称>Outline<Medium|Regular>`（尺寸走 props）——引用为 `undefined`，面板首渲染即抛、
> 被槽位机制罚下成空 stub。已改为 seed 实际名（`IconLightOutlineMedium` /
> `IconChevronUpOutlineRegular` 等，对照官方 `dsh-client-ui-theme` 的 AppearanceRow/FontSizeRow），
> 并加三条回归闸门（引用闭环 / 命名合规 / 渲染树无 undefined 元素类型）。
> **教训**：官方 seed 模块的导出名以 `dsh-web-frontend` 的 `index-*.js` 冻结表为准，
> 单测 stub 必须用真实名——用同错名顶替会让冒烟永远绿、实机永远白。
> 详见 [变更记录](design/CHANGELOG.md) 同日条目。
>
> **2026-09-26 · 与官方「通用」设置页对照去重**：用户「通用设置里有的，外观设置就不需要有了」。
> 官方「通用」页（`settings.general.item` 槽）现有 6 行，其中**明暗偏好**（`AppearanceRow`）与
> **正文字号**（`FontSizeRow`）与本线重合——外观页自 M1 起的「同一偏好第二入口」**整行移除**，
> 「主题」组只留官方三立方没有的「皮肤」。连带删除 `config.theme` 的
> `scheme` / `accent` / `fontSize` 三个镜像死字段（配置 v3 → v4；官方偏好由官方
> settingsScope 持久化，本线再存一份只会漂移）与无消费者的 `data-mia-scheme` 属性。
> 对照取证、D1–D5 决策与持续推进路线（M3 动效 → Boot Splash → M4 会话效果，
> 及「上新设项先过通用页对照」纪律）见
> [去重与路线设计](design/2026-09-26-appearance-page-dedup-and-roadmap.md)。
>
> **2026-09-26 · 视觉统一 V1 已实施**：用户「不够美观、和 dsh 设置页设计语言不够统一」。
> 根因是**控件形态选错**——官方设置行的单选标准控件是**选择丸 + 下拉菜单**
> （`LanguageRow`/`PermissionRow` 规格 + 官方 `Menu`），本线却用了一排 Pill（官方 Pill 是
> view switcher/filter 用语；长文件名一多就换行）。V1 把**皮肤 / 壁纸图源 / 玻璃档位 /
> 我的上传**四处单选换成官方选择丸，九宫格换官方卡片语言（r16 + border-l4）、表面四旋钮换
> 官方双列字段网格、M3/M4 占位换官方 dashed 卡、运行信息收敛为底部一行；Pill 整类退场。
> 所需 primitives（`Menu` / `IconChevronDownOutlineRegular`）已对**本机实装 seed 冻结表**
> 逐名核实。行为逻辑与配置零变化，单测 **101 例**、静态回归 16/16；
> 功能路线（M3 动效 → Boot Splash 实施 → M4 会话效果 → 恢复默认/导入导出）见
> [视觉统一与功能路线](design/2026-09-26-appearance-visual-unification-and-roadmap.md)。
>
> **2026-09-27 · M3 动效已实施（P1）**：用户「p2 开工」后继续推。「动效」板块从占位灰字升级为
> **真控件**：总开关（官方 Switch）+ 预设选择丸（流畅 / 优雅 / 极简）+ 强度倍率步进器（0.5×–1.5×）。
> 动效层是**纯 CSS**（@keyframes + CSS 变量，配置只改变量值、不重写规则）：会话大表面（medium
> 420 档）/ 侧栏 / 右栏 / 设置面板的容器入场（位移 + 缩放，禁「只有 opacity」与 linear 缓动）；
> `prefers-reduced-motion` 一律降级 100ms 淡入；关闭即整层移除（与总开关同门控）。
> 同批落地 **「无可见效果」提示**——纯净皮 + 全不透明表面 + 云母档走系统材质时告诉用户改哪里
> （此前三叠加 = 「开启了没什么效果」）。消息级错峰贴类器（M3.1）待实机锚点取证后补。

---

## 安装（本机）

新线以 `link:` 方式挂进 web profile，与其余四条线同构：

1. `~/.dsh/profiles/web/package.json` 的 `dependencies` 增加
   `"@miasaki/dsh-appearance": "link:C:/Users/Asakii/Desktop/dsh-miasaki/dsh-miasaki-appearance"`；
2. 同文件 `dsh.profile.bundles` 数组末尾增加 `"@miasaki/dsh-appearance"`；
3. 在 `~/.dsh/profiles/web/node_modules/@miasaki/` 下建同名的目录联接（junction）指向本目录
   （与 `dsh-canvas` / `dsh-sidebar` / `dsh-ssh` / `dsh-dual-model` 一致）；
4. **重启 `dsh web`**（roster 在启动时组装，首次装载必须重启；此后本线 client 改动可由 client-hmr 热更）。

数据落在 `~/.dsh/miasaki-appearance/config.json`（由 `cordis.patch.yml` 的 `dataDir` 指定，与本仓其余线不共享）；
上传 / 手动放入的**软件头像** PNG 落在同目录的 `avatars/`（桌面壳直读，不经 HTTP）。

## 目录

```
dsh-miasaki-appearance/
├── index.js               # Host 半：/appearance/api/* 路由 + 首帧注入（boot script/style + splash 三行）
├── client.js              # Client 半：设置页「外观」（官方通用设置页风格）+ 契约自检 + 应用管线 + splash 退场
├── assets/presets/        # 位图预设图标（portrait.png + 来源/处理链 README）
├── lib/
│   ├── config.js          # 配置模型：默认值 / 收窄钳制 / 深合并 / 迁移 / 首帧脚本 / 契约判定
│   ├── splash.js          # Boot Splash 首帧启动画：style/html/script 三个纯函数 + 门控（P2）
│   ├── avatar.js          # 软件头像：PNG 魔数 / data URL 解析 / 文件名白名单（跨线契约的 JS 半）
│   ├── icon-presets.js    # 应用图标预设：手写 PNG 编码 + SDF 绘制 + 预设表（程序化生成）
│   ├── store.js           # 配置持久化（临时文件 + rename 原子写）
│   └── fence.js           # 浏览器信任围栏（Host 头 / Origin / sec-fetch-site）
├── test/                  # 114 例纯逻辑单测（配置 / 头像 / 预设渲染 / 围栏 / 持久化 / client / host / splash 契约）
├── design/                # 规划设计 + M1/M2/M2.5/M2.6/M2.7 + 去重/视觉统一路线 + P2 Boot Splash + 变更记录
└── cordis.patch.yml       # web profile 的装载行（dataDir / trustedHosts）
```

## 能力

### M1（已实机验证，2026-09-12）

| 能力 | 说明 |
|---|---|
| 设置页「外观」 | `settings.section`，`id: appearance`、`order: 5`（紧跟官方「通用」，位于「模型」之前）；**M2.6 起整栏重做为官方「通用设置」页行式风格**（0.5px 分隔线行 / 14px 标题 / 12px 说明 / 步进器 / **选择丸 + 官方 Menu**）；**2026-09-26 去重后只剩官方通用页没有的行**（皮肤 / 壁纸 / 应用图标 / 动效 / 会话效果 / 总开关 / 契约自检），运行信息收敛为面板底部一行 |
| 与官方通用页的分工 | 明暗偏好与正文字号是**官方「通用」设置页自己的行**（`settings.general.item` 槽的 `AppearanceRow` / `FontSizeRow`）——本页**不提供第二入口也不做只读回显**（去重决策 D1，`test/client.test.js` 有回归闸门）；皮肤选中时仍调一次官方 `ctx.theme.setTheme(preferredScheme)`（M2 §3.2） |
| 总开关 | 门控 `html[data-mia-appearance]`，关闭时零影响 |
| 契约自检 | 浏览器采集事实 → Host 侧判定 → 面板显示状态条（缺插槽/接口/锚点/token 时给黄条而非崩溃） |
| 让位检测 | 检测到桌面壳注入层（`html[data-miasaki-theme]`）时提示按让位协议处理 |
| 配置读写 | `GET /appearance/api/state`、`POST /appearance/api/config`（按板块深合并 + `expectedRevision` 乐观并发） |

### M2.5 软件头像（2026-09-21，跨线：外观设置 → 桌面壳启动器图标）

| 能力 | 说明 |
|---|---|
| 设置页「软件头像」 | 面板内**上传图片…**（浏览器 canvas 归一化成 PNG、最长边 512）或从 `avatars/` 目录清单里选；预览 + 清除 |
| 头像存储 | `~/.dsh/miasaki-appearance/avatars/<avatar-时间戳-随机>.png`（文件名由 host 生成，绝不覆盖既有文件） |
| 上传接口 | `POST /appearance/api/avatar`（`data:image/png;base64,` 形态，上限 4MB；只写文件，不改配置）；`GET /appearance/api/avatars` 清单；`GET /appearance/avatar/<file>` 预览 |
| 桌面壳消费 | `Miasaki.exe` 读同一份 `config.json` 的 `avatar.source` → 窗口 / 任务栏 / 托盘图标（1.5s 巡检跟随；契约见 [M2.5 设计](design/2026-09-21-appearance-avatar-launcher-design.md)） |
| 契约自检 | `avatar-host-stale`：client 已更新而 host 未重启时给黄条 + 重启提示（旧 client 不误报） |

> 边界：**EXE 文件自身、桌面 / 开始菜单快捷方式的静态图标是构建期资源**
> （`make-icons.mjs` + `npx tauri icon`），任何运行时设置都改不了它们。

### M2.7 应用图标预设（2026-09-21）

| 能力 | 说明 |
|---|---|
| 设置页「应用图标」 | **四款预设**：**默认**（程序化几何徽记）/ **头像** / **立绘** / **现行**（三款鲸鱼娘位图，2026-09-23 追加），点选即写 `avatar.source`；选中格走官方 `bg-module-platform` + `neutral-bluish-400` 描边 |
| 预设从哪来 | `lib/icon-presets.js` **程序化生成**：手写 PNG 编码（CRC32 + `node:zlib`）+ SDF 解析式抗锯齿绘制 + 渐变/装饰层/顶部高光合成；**零第三方依赖、零图片资源**（仅「默认」一款；位图款不走绘制器） |
| 位图预设 | 「头像」= `assets/presets/portrait.png`、 「立绘」= `illustration.png`、 「现行」= `current.png`（用户提供的图，trim 黑边 → 居中裁方 → 圆角 → 量化；来源与参数见该目录 README） |
| 落盘接口 | `GET /appearance/api/presets` —— **幂等落盘**（`avatars/preset-<id>.png`，内容相同则跳过写入）+ 返回清单；位图与程序化对 host 是同一个接口 |
| 跨线影响 | **零**：预设图标与用户上传的图走同一条路（同目录 / 同白名单 / 同文件路由），桌面壳不知道"预设"的存在 |
| 我的上传 | 「我的上传」pills 自动过滤 `preset-*`，用户只看自己的资产 |

### M3 动效（2026-09-27 实施）

| 能力 | 说明 |
|---|---|
| 面板控件 | 总开关（官方 Switch）+ 预设选择丸（流畅 / 优雅 / 极简）+ 强度倍率步进器（0.5×–1.5×，作用于所有时长）；总开关关闭时三条禁用并注明 |
| 动效层 | **纯 CSS**（`@keyframes mia-mo-rise` + `--mia-mo-*` 变量）：会话大表面 medium 420 档、侧栏 / 右栏 / 设置面板 standard 300 档；位移 4–12px + 缩放 0.97–0.99（禁「只有 opacity」与 linear）；写入即改变量值、零重建 |
| 降级 | `prefers-reduced-motion: reduce` ⇒ 全部入场改 100ms 淡入、无位移无错峰 |
| 门控 | 与总开关同源：`enabled && motion.enabled` 才注入整层；关闭即移除（含变量清理） |
| 锚点纪律 | 只挂 `[data-slot]` 稳定锚点 + 自有 `.mia-mo-*` 前缀，不碰官方 transition、不改官方类名 |
| 未含（M3.1） | 消息级错峰贴类器（`min(i*40,320)ms`）——槽位 CSS（`.mia-mo-tagged`）已在层内，贴类器待实机锚点取证后补 |

### 里程碑

- **M2 主题 + 壁纸**（[设计已定稿](design/2026-09-12-appearance-m2-design.md)）：刻刻帝 / 狂狂帝皮肤
  **下沉到 alias 层**（不是直接喂 static 色阶，理由见设计 §1.2）、`overrideTokens` 双 source 参数层、
  壁纸伪元素层与图源、玻璃档位、`desktop` 注入层让位；
- **M2.5 软件头像**（[设计](design/2026-09-21-appearance-avatar-launcher-design.md)）：头像上传与存储、
  桌面壳图标消费（本线第一条跨线能力；M2 与 M3 之间插入，用户直接点名需求）；
- **M2.6 面板风格对齐**（见 [变更记录](design/CHANGELOG.md) 同日条目）：行式布局 / 官方 primitives /
  `.mia-*` 前缀 CSS 注入，行为逻辑零变化；
- **M2.7 应用图标预设**（[设计](design/2026-09-21-appearance-icon-presets-design.md)）：九宫格预设、
  程序化 PNG 生成、位图预设，跨线契约零变更；
- **与官方「通用」页对照去重**（[设计](design/2026-09-26-appearance-page-dedup-and-roadmap.md)，
  2026-09-26）：移除明暗偏好与正文字号两行（官方 `AppearanceRow` / `FontSizeRow` 自有），
  删除 `config.theme` 的 scheme / accent / fontSize 镜像字段（配置 v4），定下「上新设项先过
  通用页对照」纪律；
- **Boot Splash 首帧启动画**（[设计](design/2026-09-22-appearance-boot-splash-design.md)，
  跨线新增项）：2026-09-22 定稿、**2026-09-26 P2 实施**（S5 实机待验收）——`lib/splash.js` 三纯函数 + `index-inject` 三行（splash style / html / script，首次启用官方 `html` 行 kind）+ client 退场钩子；纹章动效 + 退场双信号（client 装载 / MutationObserver）+ 2.5s 超时兜底；
  配置 v5 `motion.bootSplash`（`auto` / `off`），与 desktop「Loading 2.0」契约见 cross 文档；
- **M3 动效**（2026-09-27 实施）：CSS 动效层（`--mia-mo-*` 变量 + `mia-mo-rise` 入场）挂
  `[data-slot]` 锚点、三套预设（流畅 / 优雅 / 极简）+ 强度倍率 + `prefers-reduced-motion`
  强制降级；消息级错峰（M3.1）待实机锚点取证；
- **M4 会话效果**：消息密度与最大宽度、流式光标、代码块与引用样式、工具卡折叠、字体。

## 两个关键决策（为什么这么做）

### 1. 配置自管 JSON，不注册 settings 命名空间

官方 `ctx.settings.register(ns, schema)` 需要一份 **schemastery** schema，而本线以 `link:` 装载时
`@deepseek-ai/schemastery` 不在模块查找链上（Node 按符号链接的真实路径解析，已实测 `ERR_MODULE_NOT_FOUND`）。
引入该依赖意味着插件目录必须独立安装，**一旦解析失败会拖垮整个 profile 的加载** —— 代价远大于收益。
仓库既有约定同样如此：canvas / sidebar / dual-model 三条线都自管持久化。

（官方 settings 通道本身可用 —— 客户端 `settingsScope.bind()` 已实测可读；迁移路径记在
[设计文档](design/2026-09-11-appearance-m1-design.md) 的「后续可选升级」一节。）

### 2. 主题走 `overrideTokens`，不注册 `ctx.theme.register`

官方「通用 → 外观」那一行是**硬编码的 light/dark/system 三个立方**（`dsh-client-ui-theme` 的 `AppearanceRow`
只渲染 `CUBES`，不读注册表）。注册进去的皮肤既不会出现在官方 UI，用户点官方立方还会把它顶掉。
因此皮肤以 `ctx.theme.overrideTokens(source, { light, dark })` 叠加层落地 —— 明暗偏好仍由官方三值管理，
皮肤自动适配两种色阶，且**停用插件即整层回收**。

## 纪律

- **零影响**：总开关关闭时不覆盖任何 token、不注入任何样式；
- **不让官方重复**：官方「通用」设置页已有的行（明暗偏好 / 正文字号 / 语言 / 会话视图 /
  回车行为 / 权限预设）一律不做第二入口——上新设项先过 `settings.general.item` 对照，
  DSH 升级后按 vendor 源码重跑取证（2026-09-26 立，见
  [去重与路线设计](design/2026-09-26-appearance-page-dedup-and-roadmap.md) §6）；
- **让位协议**：桌面壳主题引擎在位时不抢 token（M2 起按 `design/` 里的协议执行，当前只做检测与提示）；
- **锚点纪律**：动效与装饰只挂 `[data-slot="…"]` 稳定锚点 + 自有 `.mia-*` 前缀，**不依赖哈希类名**；
- **不改 shell**：需要改官方源码的能力（如聊天列独立不透明度）默认不做，确需时并入
  `dsh-miasaki-desktop/patches/` 既有补丁链并单独拍板。

## 测试

```powershell
node --check index.js; node --check client.js          # 语法
node --test --test-isolation=none "test/*.test.js"     # 114 例（9 个测试文件）
node ../scripts/verify-all.mjs appearance              # 统一回归入口（16 项）
```

> 沙箱提示：受限环境里 `node --test` 会为每个测试文件 spawn 子进程而撞 `EPERM`。
> 此时用 `node --test --test-isolation=none "test/*.test.js"`（单进程内跑完，结果一致）。

`test/client.test.js` 是 client 半的**装载契约**闸门：DSH 的客户端装载器只把 `require`
交给 factory（`factory(require) → exports`），**不注入 `module`**。bundle 里写 `module.exports`
就必须自己声明 `const module = { exports: {} }`，否则整包加载失败（设置里那栏直接不出现，
浏览器控制台报 `module is not defined`）。该测试在**没有 `module` 的 VM 上下文**里执行
factory 并断言导出形状 —— 2026-09-11 的启动失败即由这一条钉死。

实机项（插件加载 / 设置栏出现 / 「关掉即原生」截图比对）见
[`../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md`](../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)；
头像 → 启动器图标的跨线契约见
[`../dsh-miasaki-shared-docs/cross/appearance-launcher-icon-2026-09-21.md`](../dsh-miasaki-shared-docs/cross/appearance-launcher-icon-2026-09-21.md)。

## 设计文档

- [规划设计与方向选型](design/2026-09-11-appearance-settings-plan.md) —— 官方契约取证、三个参考仓库的取舍、风险清单、M1–M5 路线、D1–D10 抉择、spike 结论；
- [M1 实施](design/2026-09-11-appearance-m1-design.md) —— 分层、接口、契约自检与验收；
- [M2 设计](design/2026-09-12-appearance-m2-design.md) —— 官方主题层取证（三层 token 与解析作用域）、
  色阶清单 A/B/C 三类、双明暗协同、desktop 让位协议、壁纸层与玻璃档位、boot style 防闪色、
  验收矩阵与 6 步实施顺序；
- [M2.5 软件头像设计](design/2026-09-21-appearance-avatar-launcher-design.md) —— 跨线契约（配置 / 目录 /
  文件名白名单）、为什么走配置文件而非页面通道、为什么收敛到 PNG、上传链路与边界；
- [M2.7 应用图标预设设计](design/2026-09-21-appearance-icon-presets-design.md) —— 为什么程序化生成、
  渲染管线（PNG 编码 / SDF / 合成）、骨架四版目检、位图预设的黑边坑、为什么跨线契约零变更；
- [与官方「通用」页对照去重 + 持续推进规划](design/2026-09-26-appearance-page-dedup-and-roadmap.md)
  —— 通用页 6 行取证、重合判定、D1–D5 去重决策、v4 配置迁移，以及「上新设项先过通用页对照」
  纪律与 M3 → Boot Splash → M4 推进路线；
- [视觉统一与功能完善路线](design/2026-09-26-appearance-visual-unification-and-roadmap.md)
  —— 官方设计语言取证表（行/选择丸/立方/卡片/dashed 空态，逐条带 CSS 值）、现状差距对照、
  V1 控件替换规格（已实施）、功能完善 P1–P6 路线、实装 seed 可用性核对；
- [Boot Splash 首帧启动画设计](design/2026-09-22-appearance-boot-splash-design.md) —— 跨线新增项：
  2026-09-22 定稿、2026-09-26 P2 实施（S1 index-inject 取证 / S2 `lib/splash.js` 三纯函数 /
  S3 host 三行注入 / S4 client 退场钩子；实施期偏离点 §6.1）；S5 实机验收判据见该文 §7；
- [变更记录](design/CHANGELOG.md)。

