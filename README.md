# dsh-miasaki

> Miasaki 专属 DSH（DeepSeek Harness）周边项目 monorepo —— 桌面端 / 多 Agent 编排 / 画布插件 / 右侧边栏 / SSH / 双模型 / 外观 / 用量统计八条线，零耦合、单仓承载。

## 八条线

| 线 | 目录 | 定位与现状 |
|---|---|---|
| 桌面端 | [`dsh-miasaki-desktop/`](dsh-miasaki-desktop/) | Tauri 2 薄壳 + Win32 桌宠 + 三主题（pure / zafkiel / kurkuriel）+ Win11 Mica 一体；标题栏 v4 无壳裸键；四个 DSH web 插件：免费模型池、桌宠面板、会话日志下载入口迁移（dsh-session-log-move）、模型连通性真实探测（dsh-model-probe）——**用量监控已于 2026-09-26 迁出本线，见第八线**。**桌宠 v3 M2「真实工作状态」已落地（2026-09-12）**：六态 `PetState`（Idle/Thinking/Waiting/Error/Done/FleetBlocked）以**官方契约为主信号、DOM 扫描降级兜底**，Done 庆祝与出错气泡；主题 CSS 拆 `*.skin.css` / `*.deco.css`（供外观线消费，零行为变更）。**不修改 DSH 本体**，令牌层覆盖实现，DSH 升级不受影响；唯一例外是 `patches/` 下的六个运行时补丁（规则 + 基线入库，可重建 / 校验 / 回退）。**2026-09-22 启动加载 2.0 设计定稿**：cmd 闪窗归因根治（绕开 cmd 直达 node，静默回落兜底）+ loading 页内嵌启动日志流与阶段进度，跨线契约见 `cross/boot-loading-2026-09-22.md`。 |
| Fleet | [`dsh-miasaki-fleet/`](dsh-miasaki-fleet/) | 多 Agent CLI 编排（`package.json` 0.20.0）：一个总指挥 + N 个 worker CLI，以文件总线为唯一协调通道——F1 总线校验 / F2 计量全源覆盖 / F3 心跳判活（worker 崩溃后不残留「僵尸 running」）/ X1 脉冲发布（与桌宠 A×B 联动）/ G0–G4 图工程判定层（契约、图与就绪度、能力图、异构验证者选取）。 |
| Canvas | [`dsh-miasaki-canvas/`](dsh-miasaki-canvas/) | DSH web 画布插件 `@miasaki/dsh-canvas`（v0.5.0-miasaki.6，fork dsh-synapse）：「会话布」——可浏览 / 可分支 / 可合并的视觉会话工作区，含血缘侧栏、小地图、桌面端窗控与三主题品牌色适配。**2026-09-12 视觉与交互精细化 V1–V4**：令牌化圆润化（卡圆角 16px / 三级阴影）、连线端点与语义色、LOD 三档（full/compact/mini）、状态徽标统一——纯表现层，零 schema 变更、零新依赖。 |
| Sidebar | [`dsh-miasaki-sidebar/`](dsh-miasaki-sidebar/) | DSH web 侧边栏插件 `@miasaki/dsh-sidebar`（v0.10.0-miasaki.0）：**接入官方右侧 Sidebar**，只注册「审查」一个 tab 类型（辅助对话归 M2）。自研右栏壳已于 2026-09-10 退役、**2026-09-11 完成第二阶段清理**（壳代码删除）；**2026-09-25 右栏终端退役**——官方右栏已内置终端（多标签 / Shell 选择 / 刷新恢复），沿用官方策略不再自建，内嵌终端收敛为**底部面板单形态**（Ctrl+` / 标题栏按钮唤起，多标签多会话、node-pty 路线 B、一次性 token 闸门、回放环 + 背压淘汰，host 半与容器无关零改动）。单测 57 通过 / 5 环境跳过、静态回归 10/10。 |
| SSH | [`dsh-miasaki-ssh/`](dsh-miasaki-ssh/) | DSH web SSH 插件 `@miasaki/dsh-ssh`（全新自研，2026-09-09 立项）：**会话头第一行**「SSH」段（与「对话 / 会话布」同一个胶囊，三段一体）+ **画布页面内部**那组按钮旁的「SSH」（走 canvas 的外部视图槽）+ 页面内交互式连接云服务器。**M1 代码完成，已 link 安装**；U0 可靠性闭环 + U1 统一工作区（2026-09-12）、A0 上下文桥（2026-09-14）、D1–D4 全屏浮层改造与**四轮真机验收**（2026-09-15）、**U2 主体落地**（2026-09-16：U2.1 多 shell / U2.3 工作区记忆 / U2.4 精确恢复）、**主页入口判据与落点收敛**（2026-09-25 B1/B2：只在主页 + 与会话头胶囊结构性互斥；2026-09-26 B3/B4：同排官方 chrome 实测让位 + 让位量的取数时机（过渡期逐帧跟随、安全线变化的同步重测），修与官方「▭」的按钮盒叠压）均已实施。**2026-09-26 对标 zcode（zai-org/ZCode）方案落地**（[对标调研与方案](dsh-miasaki-ssh/design/2026-09-26-ssh-zcode-benchmark-plan.md)）：P0 三件套（keepalive 15s×3 + `buildConnectConfig()` 纯函数 + ssh2 `level` 错误词汇与私钥口令两码；`lib/exec.js` exec 前置；U2.2 SFTP 注入 zcode 降级链——sftp 视图无目录或会话打不开 ⇒ 零字节消耗直降 `mkdir -p && cat >`，mid-stream 失败记 `execOnlyUpload` 下次直走命令通道）+ P1-1 `~/.ssh/config` 别名导入（`ssh -G` 优先 + 自研解析回退，只导直连 alias）。单测 **225 例**、静态回归 **26/26**；U3（跳板 / 转发）未动，实机项待验收（真实主机 SFTP 往返 / 降级实机路径 / 导入回填 / keepalive 长连接）。 |
| 双模型 | [`dsh-miasaki-dual-model/`](dsh-miasaki-dual-model/) | DSH web 双模型插件 `@miasaki/dsh-dual-model`（2026-09-10 立项）：会话级「主模型 + 辅助模型」，只要其一支持图片即可上传图片，输入框右下角（`conversation.input.right`）快速配置。**M1 实现完成，待实机验证**——M0 六项技术假设实测全部成立；准入走一行本体补丁（可选服务探测，未装插件零退化，规则 + 双基线入库并可离线自证）；单测 33 例、`verify-all dual-model` 12/12。设计文档与变更记录见其 `design/`。 |
| 外观 | [`dsh-miasaki-appearance/`](dsh-miasaki-appearance/) | DSH web 外观插件 `@miasaki/dsh-appearance`（2026-09-11 立项）：设置里新增一栏**「外观」**，集中管理主题皮肤 / 壁纸 / 动效 / 会话效果。**M2 已收官（2026-09-12）**——M1 底座（设置栏 + 首帧注入 + 契约自检）实机六项全过后，S1–S6 依次落地 **皮肤层**（`derive-skins.mjs` 编译 105 token 表 + 首帧防闪色 boot style）、**壁纸与玻璃档位**（配置 v2、内置程序化渐变 + 本地图源、`color-mix` 表面透明度自动跟皮肤跟明暗）、**桌面壳让位协议**（`data-miasaki-theme-yield` 免刷新翻转、冲突自检）。走官方 `settings.section` 插槽 + `ctx.theme` 服务 + `webserver/index-inject`，**零 shell 改动、零第三方依赖**（配置自管 `~/.dsh/miasaki-appearance/config.json`）；总开关默认关闭、「关掉即原生」是硬契约。**2026-09-26 与官方「通用」设置页对照去重**：明暗偏好与正文字号是通用页 `AppearanceRow` / `FontSizeRow` 自己的行，外观页**不再做第二入口**，「主题」组只留官方没有的「皮肤」；`config.theme` 的 scheme / accent / fontSize 三个镜像字段同批删除（配置 v4），并立下「上新设项先过通用页对照」纪律（去重决策与 M3 → Boot Splash → M4 推进路线见该线 `design/2026-09-26-appearance-page-dedup-and-roadmap.md`）；同日 **V1 视觉统一**——单选控件全线换成官方「选择丸 + 下拉菜单」（`LanguageRow` 规格 + 官方 `Menu`），九宫格/表面旋钮/占位卡/运行信息同步对齐官方卡片与空态语言（见该线 `design/2026-09-26-appearance-visual-unification-and-roadmap.md`）；**2026-09-27 P1+P2 连续落地**——P2 Boot Splash 首帧启动画（`lib/splash.js` + `index-inject` 三行，首次启用官方 `html` 行 kind；配置 v5 `motion.bootSplash`；退场双信号 + 2.5s 兜底）、P1 M3 动效（纯 CSS 变量驱动层 + 三预设 + 强度倍率 + reduced-motion 降级），并加了「无可见效果」面板提示。单测 114 例、静态回归 18/18；M4 会话效果与恢复默认/导入导出待推。**2026-09-22 Boot Splash 首帧启动画设计定稿**（跨线新增项）：3080 首帧全屏启动画（三主题纹章动效 + 退场双信号 + 2.5s 超时兜底不挡错误页），与 desktop「Loading 2.0」契约见 `cross/boot-loading-2026-09-22.md`。 |
| 用量统计 | [`dsh-miasaki-usage/`](dsh-miasaki-usage/) | DSH web 插件 `dsh-token-monitor`（v0.6.0，**2026-09-26 由桌面端线迁出、独立成第八线**）：会话「用量」Tab（纯当前会话视角 —— 上下文剩余 / 官方聚合 / 按会话过滤的实时明细 / 活跃时长）+ 侧栏脚部「用量统计」入口 → 全局浮窗（总览六卡 / 年热力图 / 使用趋势 / 模型用量 + 会话活跃分布 / 今日与限额）。**两条「干净」**：**① 接入干净** —— 本仓唯一「纯官方契约、零 miasaki 耦合」的插件（host 半只用官方 `webServer` / `llm/stream` / `tools/result` / `sessionProjections` / `tokenMeter` / `sessionQuery`，client 半只用官方三个槽位 `conversation.view` / `sidebar.footer.action` / `shell.overlay`），不碰主题、不碰补丁、不依赖其它 miasaki 包，因此可单独装进任意官方 DSH profile；**② 统计干净** —— **账本按 profile 分区**（`~/.dsh/plugins-data/dsh-token-monitor/<profile>/`），官方桌面端只记载官方自己这个实例的消耗，不再与自制壳（`miasaki`）/ 浏览器 GUI（`web`）混账；分区前的混合账一次性归位到 `miasaki/`，官方侧从零累计。2026-09-26 官方桌面端 profile 隔离为纯净官方版后**只挂回这一条**；装法由 `file:` 改 `link:`（消除副本漂移）。 |
| 共享参考 | [`dsh-miasaki-shared-docs/`](dsh-miasaki-shared-docs/) | `cross/` 跨线设计契约（如 A×B 桌宠↔fleet 联动、sidebar 路线讨论）、`dsh-platform/` DSH 平台调研与升级回归记录。 |

八条线代码零耦合，仅共享 `dsh-miasaki-shared-docs/`；跨线引用使用 `../dsh-miasaki-shared-docs/…` 相对路径（同仓 clone 后不断）。

<!-- version-ledger:start — 由 `scripts/check-doc-versions.mjs` 校验；改 package.json 版本后跑 `node scripts/check-doc-versions.mjs --update` -->
**版本台账**（机器校验的唯一版本来源；上表正文里的版本号是叙述，冲突以本表为准）：

| 线 | 目录 | `package.json` |
|---|---|---|
| 桌面端 | `dsh-miasaki-desktop/` | 0.1.0 |
| Fleet | `dsh-miasaki-fleet/` | 0.20.0 |
| Canvas | `dsh-miasaki-canvas/` | 0.5.0-miasaki.6 |
| Sidebar | `dsh-miasaki-sidebar/` | 0.10.0-miasaki.0 |
| SSH | `dsh-miasaki-ssh/` | 0.1.0-miasaki.0 |
| 双模型 | `dsh-miasaki-dual-model/` | 0.1.3-miasaki.0 |
| 外观 | `dsh-miasaki-appearance/` | 0.1.0-miasaki.0 |
| 用量统计 | `dsh-miasaki-usage/` | 0.6.0 |
<!-- version-ledger:end -->

## 仓库结构

```
dsh-miasaki/
├─ dsh-miasaki-desktop/     # 桌面端线（design/ 在其内；patches/ 为 DSH 运行时补丁：规则 + 基线 + CLI）
├─ dsh-miasaki-fleet/       # Fleet 线（agents / state / tasks / workers / fleet-monitor / docs / tests）
├─ dsh-miasaki-canvas/      # Canvas 线（design/ 在其内）
├─ dsh-miasaki-sidebar/     # Sidebar 线（design/ 在其内：路线 D 总设计 / CHANGELOG）
├─ dsh-miasaki-ssh/         # SSH 线（index.js + lib/ + app.js + test/；design/ 在其内）
├─ dsh-miasaki-dual-model/  # 双模型线（index.js + client.js + lib/ + test/ + patches/；design/ 在其内）
├─ dsh-miasaki-appearance/  # 外观线（index.js + client.js + lib/ + test/；design/ 在其内）
├─ dsh-miasaki-usage/       # 用量统计线（`dsh-token-monitor` 插件本体：package.json + lib/ + scripts/ + cordis.patch.yml；design/ 在其内）
├─ dsh-miasaki-shared-docs/ # 跨线共享参考（含 cross/smoke-test-matrix.md 回归矩阵）
├─ scripts/verify-all.mjs   # 八线统一静态回归入口（L0 + L1）
└─ .gitignore               # _refs/ vendor/ dist/ .vs/ .workbuddy/ .learnings/ AGENTS.md 等均已忽略
```

## 统一回归（八线）

> 八线全部纳入统一回归；需要重启 host 或真机的实机项（插件加载 / 桌面壳冒烟 / 跨线联动）不在此脚本内。

**CI 已接入（2026-09-14）**：`.github/workflows/verify-all.yml` 在 `windows-latest` 上跑同一套回归
（push `main`/`master` + 任意 PR + 手动触发），使质量保证不再只依赖"维护者记得在本机跑一次"。
runner 自带 MSVC，因此本地 Git Bash 下 `cargo test` 的 `link.exe` 环境假阴性在 CI 中变成真信号。
CI 先装**三条有依赖的线**再跑闸门：sidebar 与 ssh 用 `pnpm install --frozen-lockfile`、
desktop 用 `npm ci --omit=dev`；canvas / fleet / dual-model / appearance / usage 已核实零依赖、无需安装。
（依赖缺失的实测后果、Node 22.19.0 与 pnpm 11 的版本取舍、45 分钟超时的理由，均写在该文件头部注释里。）

> **EOL 纪律（2026-09-14 起）**：仓库用 `.gitattributes`（`* -text`）禁止一切换行符转换。本仓多项检查做
> **逐字节比对**（desktop/dual-model 的 `patch verify` 比 SHA、appearance 的 `derive-skins --check` 重算 token 表），
> CI 首跑正是因 `windows-latest` 默认 `core.autocrlf=true` 把 LF 转成 CRLF 而失败 8 项。
> `-text` 规则优先于本机 `core.autocrlf`，因此任何机器 checkout 出的字节都一致 —— 编辑文件时请勿引入 CRLF。

```bash
node scripts/verify-all.mjs               # 八线 + 仓库级治理闸门（L0 静态检查 + L1 单线单测）
node scripts/verify-all.mjs usage         # 只跑一条线（sidebar / canvas / fleet / desktop / ssh / dual-model / appearance / usage / repo）
```

**2026-09-19 基线（全量 81 项检查，七线全 PASS）**：sidebar 10/10、canvas 11/11、fleet 15/15、desktop 11/11、ssh 12/12、dual-model 10/10、appearance 12/12
（**分母为检查项数**：syntax + 单测文件 + 补丁自证；如 ssh 的 12 项内含 113 例单测、canvas 的 11 项内含 89 例单测、appearance 的 12 项内含 60 例单测、sidebar 的 10 项内含 62 例单测）。

**2026-09-24 基线（全量 98 项检查，七线全 PASS；DSH 已实装 0.1.7-alpha.2，六个补丁全部重打、`EDITS` 零改）**：sidebar 10/10、canvas 11/11、fleet 15/15、desktop 22/22（含 6 个补丁自证 + 注入脚本语法闸门 + 鉴权 cookie 兜底链行为闸门 + 启动页 S4a 视觉层契约 + 桌宠资产链完整性闸门）、ssh 12/12、dual-model 12/12、appearance 16/16。
desktop 项含 `cargo test`（35 例 Rust 单测：launcher 图标白名单与方图缩放 6 例 + 桌宠状态机与持久化 16 例 + 启动链 pulse 陈旧语义 / backend backoff / netstat 解析 6 例 + 隐藏态主题头像悬浮球 `dot.rs` 7 例）与 `patch verify` ×6（六个运行时补丁由基线原始文件重建并与产物逐字节比对），
外加 `themes/src/*.js` 拼接产物 `injected/theme-init.js` 的语法闸门 1 项 + 鉴权 cookie 兜底链行为闸门 6 例（不覆写预置 cookie / 401 熔断上限）+ 启动页契约 11 例（S4a 视觉层 10 + S3 拖放安全网 1）+ 桌宠资产链完整性闸门 1 项（引用齐全 / 再生源在位 / 无孤儿派生）、`plugins/dsh-model-probe` 入口语法 3 项 + 连通性判定表 20 例 + settings 读取双轨 12 例、
`plugins/dsh-free-model-pool` 语法 2 项 + settings 双轨 10 例 + routes 5 例
——script 会在 `PATH` 外自动探测 `~/.cargo/bin/cargo`。dual-model 项含 33 例单测（含 client 契约 4 例）与 `patch verify`（图片准入补丁离线自证）。

**2026-09-26 增量（第八线接入）**：新增 `usage` 线 **3/3**（`lib/index.js` 与
`scripts/dedupe-usage-ledger.mjs` 语法闸门 + client bundle 装载契约自检 —— 后者把 client.js 当脚本
真实执行并喂 react stub，能抓出「CSS 模板字符串被反引号提前闭合」那类整包加载失败）。
该线由 desktop 线迁出，同批把跨会话账本改为**按 profile 分区**（官方桌面端只记载官方消耗），
设计与验证见 [`dsh-miasaki-usage/design/CHANGELOG.md`](dsh-miasaki-usage/design/CHANGELOG.md)。

**2026-09-26 深夜基线（全量 113 项检查，八线全 PASS；同批完成仓库清仓）**：sidebar 10/10、canvas 12/12、
fleet 15/15、desktop 33/33（含 `cargo test` + 6 个补丁离线自证）、ssh 12/12、dual-model 12/12、appearance 16/16、usage 3/3。
本批把 09-14 → 09-26 积压十二天的改动（usage 线迁出、desktop P7/P9/P10、canvas 存储治理与 `sessions/sync` 恒 400 修复、
ssh B1–B4 让位修复、DSH 平台调研）与仓库清仓一并提交：**删除 7 条线的 25 项死代码/冗余**（其中 usage 的
`scanTemplateLiterals` 由死代码**接线为装载闸门的第 3 项防线**），并回收 25.9 MB 测试残留。
逐条清单（含「审计误判但复核后保留」的反例）见
[`dsh-miasaki-shared-docs/repo-review-2026-09-26.md`](dsh-miasaki-shared-docs/repo-review-2026-09-26.md) §七，
各线变更记录见各自 `design/CHANGELOG.md`。
> ※ 审计纪律注记：本轮 15 名只读审计员给出的删除建议中，**有 4 条经 Lead 复核后推翻**（`mergePanelCard()`
> 实为活代码、`card-positions` 迁移代码非死代码、`states/idle.png` 归属看串行、`pet-hide/pet-show` 与
> `hide/show` 是两对值）——「零引用」结论必须写清判据，否则极易把迁移代码、兼容回退与活模板调用当垃圾清掉。

**同批修复与空间回收（2026-09-26 深夜·续）** `[实测]`：
① **appearance 配置写盘失败不再假报成功** —— 失败一律 `500 + error:'persist-failed' + changed:false` +
人类可读原因，`client.js` 文案优先级改 `message > error > HTTP <status>`；`lib/store.js` 的原子写临时名加
pid/时间戳（防多实例互踩半截 JSON）；新增 EEXIST 故障注入回归闸门 1 例（appearance 单测 95 → **98 例**、闸门 16/16）。
② **playwright 补丁基线常量对齐** —— `BASELINE_DSH_VERSION` 由 `0.1.7-alpha.2` 改为 `0.1.7-rc.2`，
此前它让 `scripts/patch-live-audit.mjs` 把本件的任何「未打上」都解释成版本漂移，`exit 1` 的真回归分支永不触发。
③ **回收 10.42 GB** 可回收空间（外部工具 tmp 缓存 / 探针项目 / 二进制与画布数据备份 / 参考克隆 / 外部会话目录）；
**刻意保留** `_refs/miasaki-codesign.pfx`（签名私钥）、`_refs/scripts-archive/`、`vendor/`（官方源码对照）、
`dsh-miasaki-desktop/dist/`（已签名发布产物）。修复后全量回归仍 **113/113 全 PASS**。

**2026-09-26 深夜·续二（全量 119 项检查，八线 + 仓库级全 PASS）** `[实测]` —— 治「逐例修不解决问题」的那一类：

- **新增仓库级治理闸门类别 `repo`（2 项，跨八线、不属于任何单线）**：
  - **`silent-guards`（守卫必须显式失败）** —— 四类形态：R1 静默跳过守卫 / R2 构建链静默吞错 /
    R3 静默回退读取 / R4 声明清单缺口。存量 **58 类冻结**在 `scripts/silent-guard-baseline.json`
    （**是债，不是背书**），**新增即失败**；确认刻意降级可在命中行或上一行写 `// guard-ok: <理由>` 就地豁免。
    扫描边界**刻意收窄**：只扫 host 半与构建链 —— 全仓空 catch 有 250+ 处，绝大多数是浏览器侧的正当降级
    （隐私模式 / 布局未定 / socket 已关），全判为问题会让闸门被自己的噪声淹没；本闸门**抓不到**的形态
    （写失败返回成功、运行时才成立的断链）已在脚本头部逐条写明。
    **闸门首跑即抓到真缺陷**：`appearance/package.json` 的 `files` 缺 `assets/`，而 `lib/icon-presets.js`
    引用 `assets/presets/*.png` ⇒ 位图预设会在安装时静默丢失（仓库里有、装完没有）。
    故障注入自证：无豁免注入 → `exit 1` 且点名位置；加 `guard-ok` → `exit 0`；清理后归零。
  - **`doc-versions`（版本台账 vs `package.json`）** —— 根 README 新增 `<!-- version-ledger -->` 台账块，
    与八线 `package.json` 逐字校验；故障注入（Fleet 改 `0.19.0`）→ `exit 1`，`--update` 精确修回。
- **fleet-monitor 补齐三道信任围栏** —— 它此前是全仓唯一「写接口零鉴权 + CORS 通配 `*`」的组合
  （`POST /api/toggle/:agentId` 直接落盘 `control.json`；**只绑 127.0.0.1 不构成鉴权**，浏览器可以代发跨站请求）。
  新增 `fleet-monitor/fence.cjs`（Host / `sec-fetch-site` / Origin 三道，与 appearance·ssh·sidebar 同构）
  + `tests/fleet-monitor.test.mjs` 11 例（围栏排在**所有**路由之前、403 不带任何 CORS 头、
  「过围栏才进业务分支」用不可写 agentId 反证），`server.js` 改为具名 `handleRequest` + `require.main` 守卫
  以便单测不起监听。**fleet 15 → 17 项**。
- **实机验收债务可度量** —— [回归矩阵 §3.0](dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)
  新增**可勾选台账 38 项**（此前该文件 checkbox 数为 **0**，「六条线实机验收全部积压」在文档里不可见、
  没有任何机制保证它会发生）；并补上矩阵里一直缺失的 **§3.10 双模型判据节**
  （2026-09-10 就完成 M1 却始终没有验收节 = 没有判据）。
- **治理层**：CI 注释「七线」→「八线」（5 处，依赖分布清单补 `usage`，删掉会先过期的 desktop 写死项数）；
  落地根 **`.editorconfig`**（默认 LF + UTF-8 无 BOM；例外只给会被外部工具写回 BOM 的 fleet 产物，
  存量 17 处 CRLF 不批量转换以免零语义 diff 淹没真实改动）。
- **仍缺**：`lint` / `format` 工具链（当前只有编辑器约定，没有 CI 级强制）；
  30+ 处文档「当前态失真」的逐条订正（版本台账闸门只覆盖版本号这一类）。

**2026-09-26 深夜·续三（外观线与官方「通用」设置页对照去重）** `[实测]`：用户「通用设置里有的，
外观设置就不需要有了」。逐行取证官方「通用」页（`settings.general.item` 槽 6 行：语言 /
外观(浅·深·跟随系统) / 字号 / 会话视图 / 回车行为 / 权限预设）后，外观页**移除明暗偏好与
正文字号两行**（M1 起的「同一 `ctx.theme` 偏好第二入口」，不做只读回显），「主题」组只留
官方三立方没有的「皮肤」；连带删除 `config.theme` 的 scheme / accent / fontSize 三个
镜像死字段（`accent` 从未接 UI）与无消费者的 `data-mia-scheme` 属性，配置 **v3 → v4**
（删字段无需搬运，sanitize 直接丢弃）。新增「与通用页不重复」回归闸门 1 例
（面板不渲染两行文本、无 `.mia-cube` 节点、无 `px` 单位节点），单测 **98 → 100 例**、
`appearance` 仍 **16/16**、`repo` **2/2**。去重决策（D1–D5）与持续推进路线
（M3 动效 → Boot Splash 实施 → M4 会话效果，及「上新设项先过通用页对照」纪律）见
[`dsh-miasaki-appearance/design/2026-09-26-appearance-page-dedup-and-roadmap.md`](dsh-miasaki-appearance/design/2026-09-26-appearance-page-dedup-and-roadmap.md)；
回归矩阵 §3.5 判据改写 + §3.0 台账外观 6 → 7 项（新增 D7 去重复核）。**实机待用户重启
`dsh web` 后验收**。

**2026-09-26 深夜·续四（外观页 V1 视觉统一已实施）** `[实测]`：用户「不够美观、和 dsh 设置页
设计语言不够统一、功能也不完善」→ 拍板「只做 V1」。根因是**控件形态选错**：官方设置行的单选
标准控件是**选择丸 + 下拉菜单**（`LanguageRow`/`PermissionRow` 规格 + 官方 `Menu`），本线却用了
一排 Pill。四处单选（皮肤 / 壁纸图源 / 玻璃档位 / 我的上传）全换**官方选择丸 + Menu**；
九宫格换官方卡片语言（r16 + border-l4）；表面四旋钮换官方双列字段网格；M3/M4 占位换官方
dashed 卡；运行信息收敛为面板底部一行；Pill 整类退场。行为逻辑与配置**零改动**，单测
**100 → 101 例**（新增「选择丸 + Menu」控件闸门）、`appearance` 仍 **16/16**。功能路线
P1 M3 动效 → P2 Boot Splash 实施 → P3 M4 会话效果 → P4 恢复默认 → P5 导入导出 →
P6 壁纸双图/URL 源，见
[`dsh-miasaki-appearance/design/2026-09-26-appearance-visual-unification-and-roadmap.md`](dsh-miasaki-appearance/design/2026-09-26-appearance-visual-unification-and-roadmap.md)。
**实机待用户重启 `dsh web` 后验收**（四个选择丸开合 / 菜单键盘 / dashed 占位 / 三主题）。

**2026-09-27（外观线 P2 Boot Splash 实施 + 「开启没效果」诊断）** `[实测]`：用户「p2 开工」并反馈
「外观设置开启了没什么效果」。诊断结论（不是失效，是默认配置下三层效果互相抵消）：皮肤停在
「纯净」= 原生配色（设计如此）；壁纸层被 **100% 不透明的官方表面**挡住（params 层全 100 ⇒
不注册半透明）；`mica` 档在 Win11 桌面壳下走系统云母、页面侧模糊被 W4.2 规则有意关掉 ⇒
可见变化趋近零。盘上配置经 `buildBootScript` / `buildBootStyle` 离线复算，`data-mia-*` 属性与
壁纸/玻璃 CSS 行**均在场**（注入没问题，是可见性条件没凑齐）。**见效方法**：换皮肤 / 玻璃换
frost·light / 表面不透明度降到 60–80（判据与复算证据记入回归矩阵 §3.5 诊断注记）。
P2 实施：新增 `lib/splash.js`（style/html/script 三纯函数 + 门控；颜色全部 var() 经 body 继承、
明暗跟随官方属性切换，纹章双环 zafkiel 顺 / kurkuriel 逆 / pure 静止，三点流动，reduced-motion
全静止，退场双信号 + 2.5s 超时 + 幂等）；`index.js` 既有 `index-inject` 订阅内追加三行（**首次启用官方 `html` 行 kind**）；
配置 **v4 → v5** `motion.bootSplash`；client `apply()` 调 `__miaSplashExit()`。S1 用 vendor
`injections.ts` 逐行取证 + 官方同款渲染逻辑离线端到端验证五行落点。单测 **101 → 111 例**
（splash 8 + host +2 + config 迁移断言）、`appearance` **16 → 18 项**、`repo` **2/2**。
**S5 实机待用户重启 `dsh web` 后验收**（启动画出现 / ≤400ms 淡出 / 401 硬用例 / 关掉即原生 diff=0）。

**2026-09-26 深夜·续五（ssh 对标 zcode 方案落地 + 静态闸门补强）** `[实测]`：用户对 ssh 线
[对标调研与方案](dsh-miasaki-ssh/design/2026-09-26-ssh-zcode-benchmark-plan.md)（智谱
zai-org/ZCode v3.14.3）拍板「按建议开工」（D1② P0 三件套全做 / D5② 降级链并进 U2.2 /
D2① ssh config 只导直连 alias）。落地：① **P0-1 连接健壮性**——keepalive 15s×3（真协议
探针 6/6 PASS：吞掉服务端外发字节模拟静默断开，60043ms 收到 `Keepalive timeout` 归
`TIMEOUT`，对照组零错误）；`buildConnectConfig()` 纯函数化（握手预算/keepalive/agent
三条口径可单测）；`classifyError()` 新增 ssh2 `level` 分级与私钥口令两码。② **P0-3 exec
前置**（`lib/exec.js`）：POSIX `/bin/sh -c` 包装、close 收尾 + exit 码优先 + 50ms 排空、
banner/motd 跳过。③ **U2.2 SFTP**（`lib/paths.js` / `lib/sftp.js` / `lib/limits.js` +
8 个 REST 端点 + `sftp-ui.js` 右抽屉）：zcode 降级链（目录在 sftp 视图不存在 / 会话打不开
⇒ 零字节消耗直降 `mkdir -p && cat >`）；**偏离登记**：单次 HTTP 源流不可回放 ⇒ mid-stream
失败不就地降级，记 `execOnlyUpload` 下次直走命令通道。④ **P1-1 ssh config 导入**
（`lib/sshConfig.js`）：`ssh -G` 优先 + 自研解析回退，只导直连 alias（含 ProxyJump 的禁选
不静默丢）。单测 **153 → 225 例**。**闸门补强（本轮整理发现的口子）**：CHANGELOG 原写
「新模块进静态闸门」，但 `planSsh` 的语法检查清单**没有**这 6 个新模块（14→20 全靠新测试
文件）⇒ 补进 `verify-all.mjs`，`verify-all ssh` **14/14 → 26/26**；回归矩阵 §1/L1/§3.0/
§3.6 与根 README SSH 行同批订正（原「126 例 / 12/12 / U2.2 未动」为失真现状），§3.0 实机
台账 **39 → 43 项**（新增 A12–A15：SFTP 往返 / 降级实机 / 导入回填 / keepalive 长连接）。
**实机待用户重启 `dsh web` 后验收**。

> ※ **【2026-09-19 已修】** sidebar 的 `terminal-hub.test.js` 曾在受限沙箱下整片失败（2026-09-12 归因）：
> `resolvePtyBin` 用 `where.exe` 解析 shell 绝对路径并**捕获其输出**，而受限沙箱禁止管道捕获
> （`EPERM`）⇒ 落入 catch 后抛「未安装或找不到 powershell.exe」。根子是 `hub._pty` 注入了、
> `resolvePtyBin` 却还是模块级硬引用。**修法**：`TerminalHub` 构造函数新增可注入的 `resolveBin`
> （默认仍是 `resolvePtyBin`，生产行为不变），测试注入假路径 ⇒ 单测与宿主 shell 彻底解耦。
> **现状**：受限沙箱下直接 `node dsh-miasaki-sidebar/test/terminal-hub.test.js` → **15/15 全绿**，
> 无须再切普通终端。归因过程与判据见
> [回归矩阵 §1 的 ※※ 注记](dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)。

历史基线：2026-09-23（全量 96 项、desktop 20/20、`cargo test` 28 例——09-24 的 S4a 视觉闸门、桌宠资产闸门与 `dot.rs` 尚未入账）；2026-09-10（DSH 0.1.5-rc.1 / Node v24.15.0）sidebar 8/8、canvas 11/11、fleet 14/14、desktop 4/4、ssh 9/9、dual-model 10/10；2026-09-11 新增外观线 `appearance` 9/9（首次实机启动即暴露 `module is not defined` 整包加载失败，已修并补 client 半装载契约测试）。
需要真机或运行中 host 的实机项（插件加载 / 桌面壳冒烟 / 跨线联动）
不在脚本内，清单见 [统一回归矩阵](dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)。

## 快速开始

### 桌面端

```bash
cd dsh-miasaki-desktop
npm install          # 安装 @tauri-apps/cli
npm run gen-init     # 内联主题 → src-tauri/injected/theme-init.js（含令牌完备性校验）
npm run tauri dev    # 开发运行
npm run tauri build  # 产出 Windows 安装包/EXE（src-tauri/target/release/）
```

### Fleet

```bash
cd dsh-miasaki-fleet
node workers/validate-bus.mjs            # 文件总线全量校验（零依赖）
node workers/validate-bus.mjs --strict   # 额外要求 fleet-pulse.json 存在
node workers/pulse/publish-pulse.mjs     # 发布 fleet-pulse.json v2（A×B 联动契约）
```

### Canvas

```bash
cd dsh-miasaki-canvas
pnpm install
pnpm run build   # node --check 三个入口文件
pnpm test        # 89 项回归测试（8 个测试文件）
# 开发模式：DSH profile 以 link 方式指向本目录，重启 dsh web + 刷新页面生效
```

### Sidebar

```bash
cd dsh-miasaki-sidebar
pnpm install
pnpm run build   # node --check 两个入口文件（index.js / client.js）
pnpm test        # 62 项单测（审查 5 / 审查视图 10 / 目录分组 3 / 视图持久化 6 / 右栏引导 4 / 终端启动器 7 / 内嵌终端 hub 15 / 路由 12）
# 开发模式：DSH profile 以 link 方式指向本目录，重启 dsh web + 刷新页面生效（client bundle 重启 host 生效）
```

## 文档

- 各线设计决策与变更记录：`dsh-miasaki-desktop/design/`、`dsh-miasaki-canvas/design/`、`dsh-miasaki-sidebar/design/`、`dsh-miasaki-appearance/design/`、`dsh-miasaki-usage/design/`、`dsh-miasaki-fleet/docs/`
- 跨线契约：`dsh-miasaki-shared-docs/cross/`；DSH 平台调研：`dsh-miasaki-shared-docs/dsh-platform/`
- 工作区纪律（缓存卫生 / 目录职责 / 提交纪律 / 会话收尾清单）由维护者以**本地 `AGENTS.md`** 维护，
  **不入库、不随 clone 分发**（已在 `.gitignore` 挡回）；仓库内可见的纪律以本文档与各线 README / `design/` 为准。

归档与外部产物（`_refs/`、`vendor/`、`dist/`、`.vs/` 等）已 gitignore，不入库。
