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
> 行为逻辑零变化。动效 / 会话效果分别在 M3–M4 接入同一套管线。

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
├── index.js               # Host 半：/appearance/api/* 路由 + 首帧注入
├── client.js              # Client 半：设置页「外观」（官方通用设置页风格）+ 契约自检 + 应用管线
├── lib/
│   ├── config.js          # 配置模型：默认值 / 收窄钳制 / 深合并 / 迁移 / 首帧脚本 / 契约判定
│   ├── avatar.js          # 软件头像：PNG 魔数 / data URL 解析 / 文件名白名单（跨线契约的 JS 半）
│   ├── store.js           # 配置持久化（临时文件 + rename 原子写）
│   └── fence.js           # 浏览器信任围栏（Host 头 / Origin / sec-fetch-site）
├── test/                  # 81 例纯逻辑单测（配置 / 头像 / 围栏 / 持久化 / client 契约 / host 路由契约）
├── design/                # 规划设计 + M1/M2/M2.5/M2.6 实施 + 变更记录
└── cordis.patch.yml       # web profile 的装载行（dataDir / trustedHosts）
```

## 能力

### M1（已实机验证，2026-09-12）

| 能力 | 说明 |
|---|---|
| 设置页「外观」 | `settings.section`，`id: appearance`、`order: 5`（紧跟官方「通用」，位于「模型」之前）；**M2.6 起整栏重做为官方「通用设置」页行式风格**（0.5px 分隔线行 / 14px 标题 / 12px 说明 / 明暗立方 / 步进器，控件复用官方 primitives） |
| 明暗偏好 | 直通官方 `ctx.theme.setTheme()` —— 与官方「通用 → 外观」是**同一个偏好**，改动立即生效 |
| 正文字号 | 直通官方 `ctx.theme.setFontSize()`（12–17px） |
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

### 里程碑

- **M2 主题 + 壁纸**（[设计已定稿](design/2026-09-12-appearance-m2-design.md)）：刻刻帝 / 狂狂帝皮肤
  **下沉到 alias 层**（不是直接喂 static 色阶，理由见设计 §1.2）、`overrideTokens` 双 source 参数层、
  壁纸伪元素层与图源、玻璃档位、`desktop` 注入层让位；
- **M2.5 软件头像**（[设计](design/2026-09-21-appearance-avatar-launcher-design.md)）：头像上传与存储、
  桌面壳图标消费（本线第一条跨线能力；M2 与 M3 之间插入，用户直接点名需求）；
- **M2.6 面板风格对齐**（见 [变更记录](design/CHANGELOG.md) 同日条目）：行式布局 / 官方 primitives /
  `.mia-*` 前缀 CSS 注入，行为逻辑零变化；
- **M3 动效**：CSS 动效层挂在 `[data-slot]` 稳定锚点上、三套预设、强度倍率、`prefers-reduced-motion` 强制降级；
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
- **让位协议**：桌面壳主题引擎在位时不抢 token（M2 起按 `design/` 里的协议执行，当前只做检测与提示）；
- **锚点纪律**：动效与装饰只挂 `[data-slot="…"]` 稳定锚点 + 自有 `.mia-*` 前缀，**不依赖哈希类名**；
- **不改 shell**：需要改官方源码的能力（如聊天列独立不透明度）默认不做，确需时并入
  `dsh-miasaki-desktop/patches/` 既有补丁链并单独拍板。

## 测试

```powershell
node --check index.js; node --check client.js          # 语法
node --test --test-isolation=none "test/*.test.js"     # 81 例（7 个测试文件）
node ../scripts/verify-all.mjs appearance              # 统一回归入口（14 项）
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
- [变更记录](design/CHANGELOG.md)。
