# dsh-miasaki 工程记录

> **本文是仓库的工程记录，不是项目介绍。**
> 2026-09-29 由根 `README.md` 迁出 —— 根 README 改为面向用户的插件目录页，
> 工程流水（线级现状长表、统一回归的全部历史基线、开发命令）原样保留在这里，逐字未删。
> **迁出原因**：项目进入插件对外分发阶段，根 README 的读者从维护者变成陌生用户；
> 维护者视角的工程流水继续由本文承载，两边职责分开，内容一份不丢。
>
> 找项目介绍与安装方式：见 [根 README](../README.md)。

## 九条线现状

| 线 | 目录 | 定位与现状 |
|---|---|---|
| 桌面端 | [`dsh-miasaki-desktop/`](../dsh-miasaki-desktop/) | Tauri 2 薄壳 + Win32 桌宠 + 三主题（pure / zafkiel / kurkuriel）+ Win11 Mica 一体；标题栏 v4 无壳裸键；四个 DSH profile 插件：桌宠面板、会话日志下载入口迁移（dsh-session-log-move）、模型连通性真实探测（dsh-model-probe）、Computer Use GUI 工具（dsh-computer-use，桌宠 v4 能力底座）——**用量监控已于 2026-09-26 迁出本线（见第八线），免费模型池已于 2026-09-28 迁出并升级为多来源聚合器（见第九线）**。**桌宠 v3 M2「真实工作状态」已落地（2026-09-12）**：六态 `PetState`（Idle/Thinking/Waiting/Error/Done/FleetBlocked）以**官方契约为主信号、DOM 扫描降级兜底**，Done 庆祝与出错气泡；主题 CSS 拆 `*.skin.css` / `*.deco.css`（供外观线消费，零行为变更）。**2026-09-27/28 桌宠 v4–v5**：whale 图集接入（`cut-frames.mjs` 按主题行名表切 7 行，行号语义不跨主题共享）、反转狂三白军装重画（`inverse-states.mjs` 背景色四角采样，蓝底白底通吃）、`pet_native/xform.rs` 绘制变换层（逆向映射采样 + M1 呼吸 / M2 摇摆 / M3 挤压，cargo 100 例单测）。**不修改 DSH 本体**，令牌层覆盖实现，DSH 升级不受影响；唯一例外是 `patches/` 下的**九个**运行时补丁（规则 + 基线入库，可重建 / 校验 / 回退）——最新一件是 **2026-09-30 的 `dsh-client-ui-workspace`**（会话浏览器「侧线会话不占列表」，让 `@miasaki/dsh-sidebar` 的辅助对话不进官方列表；判据是跨包 localStorage 声明，声明缺席即官方原状）。**2026-09-22 启动加载 2.0 设计定稿**：cmd 闪窗归因根治（绕开 cmd 直达 node，静默回落兜底）+ loading 页内嵌启动日志流与阶段进度，跨线契约见 `cross/boot-loading-2026-09-22.md`。 |
| Fleet | [`dsh-miasaki-fleet/`](../dsh-miasaki-fleet/) | 多 Agent CLI 编排（`package.json` 0.20.0）：一个总指挥 + N 个 worker CLI，以文件总线为唯一协调通道——F1 总线校验 / F2 计量全源覆盖 / F3 心跳判活（worker 崩溃后不残留「僵尸 running」）/ X1 脉冲发布（与桌宠 A×B 联动）/ G0–G4 图工程判定层（契约、图与就绪度、能力图、异构验证者选取）。 |
| Canvas | [`dsh-miasaki-canvas/`](../dsh-miasaki-canvas/) | DSH web 画布插件 `@miasaki/dsh-canvas`（v0.5.0-miasaki.7，fork dsh-synapse）：「会话布」——可浏览 / 可分支 / 可合并的视觉会话工作区，含血缘侧栏、小地图、桌面端窗控与三主题品牌色适配。**2026-09-12 视觉与交互精细化 V1–V4**：令牌化圆润化（卡圆角 16px / 三级阴影）、连线端点与语义色、LOD 三档（full/compact/mini）、状态徽标统一——纯表现层，零 schema 变更、零新依赖。 |
| Sidebar | [`dsh-miasaki-sidebar/`](../dsh-miasaki-sidebar/) | DSH web 侧边栏插件 `@miasaki/dsh-sidebar`（v0.10.0-miasaki.0）：**接入官方右侧 Sidebar**，注册**两个** tab 类型（「审查」+「辅助对话」，后者 2026-09-28 落地）。自研右栏壳已于 2026-09-10 退役、**2026-09-11 完成第二阶段清理**（壳代码删除）；**2026-09-25 右栏终端退役**——官方右栏已内置终端（多标签 / Shell 选择 / 刷新恢复），沿用官方策略不再自建，内嵌终端收敛为**底部面板单形态**（Ctrl+` / 标题栏按钮唤起，多标签多会话、node-pty 路线 B、一次性 token 闸门、回放环 + 背压淘汰，host 半与容器无关零改动）。单测 **86 例**（81 通过 / 5 环境跳过）、静态回归 **13/13**（11 个测试文件）；**M2.1 辅助对话已落地（2026-09-28）**——右栏第二个 tab（侧线 = `ctx.sessions.fork` 不传 `atSeq`，主会话运行中可开；嵌入式官方会话，零自研聊天 UI），实机验收 7/7，M2.2/M2.3 未做。**2026-09-30 回退「只带最近 3 轮」**：09-29 曾传 `atSeq` 截到倒数第 3 个 `turn/start`，但把方向读反了 —— `atSeq` 是**保留 `0..atSeq` 的头部前缀上界**（`dsh-session/lib/types/fork.js:19` 的 `events.slice(0, boundary + 1)`），**只能截尾、不能截头** ⇒ 「只带最近 N 轮」用 `fork` 做不到，真触发时反而丢最近的轮次、留更早的历史；侧线已回到官方默认的全文前缀（`client.js` 与测试 `git restore` 回 09-29 之前，单测 18 → **13** 例）。契约事实见该线设计文档 **C1b**、原因与 ZCode 官方复核见 `design/CHANGELOG.md` 2026-09-30 条。 |
| SSH | [`dsh-miasaki-ssh/`](../dsh-miasaki-ssh/) | DSH web SSH 插件 `@miasaki/dsh-ssh`（全新自研，2026-09-09 立项）：**会话头第一行**「SSH」段（与「对话 / 会话布」同一个胶囊，三段一体）+ **画布页面内部**那组按钮旁的「SSH」（走 canvas 的外部视图槽）+ 页面内交互式连接云服务器。**M1 代码完成，已 link 安装**；U0 可靠性闭环 + U1 统一工作区（2026-09-12）、A0 上下文桥（2026-09-14）、D1–D4 全屏浮层改造与**四轮真机验收**（2026-09-15）、**U2 主体落地**（2026-09-16：U2.1 多 shell / U2.3 工作区记忆 / U2.4 精确恢复）、**主页入口判据与落点收敛**（2026-09-25 B1/B2：只在主页 + 与会话头胶囊结构性互斥；2026-09-26 B3/B4：同排官方 chrome 实测让位 + 让位量的取数时机（过渡期逐帧跟随、安全线变化的同步重测），修与官方「▭」的按钮盒叠压）均已实施。**2026-09-26 对标 zcode（zai-org/ZCode）方案落地**（[对标调研与方案](../dsh-miasaki-ssh/design/2026-09-26-ssh-zcode-benchmark-plan.md)）：P0 三件套（keepalive 15s×3 + `buildConnectConfig()` 纯函数 + ssh2 `level` 错误词汇与私钥口令两码；`lib/exec.js` exec 前置；U2.2 SFTP 注入 zcode 降级链——sftp 视图无目录或会话打不开 ⇒ 零字节消耗直降 `mkdir -p && cat >`，mid-stream 失败记 `execOnlyUpload` 下次直走命令通道）+ P1-1 `~/.ssh/config` 别名导入（`ssh -G` 优先 + 自研解析回退，只导直连 alias）。单测 **310 例**、静态回归 **31/31**；**U3（跳板 / 本地转发）与 A1 工具面已于 2026-09-26 实施**（真协议探针 8/8，A1 工具面已实机验收）；**G1 SFTP 会话自愈 + G2 慢 viewer 背压暂停/恢复 2026-09-28 实机验收 23/23**（真 DSH 实例 × 真协议 sshd × 真实路由/票据/围栏，隔离 dataDir）。**仍待验**：真跳板建连 / 本地转发实机、真实云主机 SFTP 往返。 |
| 双模型 | [`dsh-miasaki-dual-model/`](../dsh-miasaki-dual-model/) | DSH web 双模型插件 `@miasaki/dsh-dual-model`（2026-09-10 立项）：会话级「主模型 + 辅助模型」，只要其一支持图片即可上传图片，输入框右下角（`conversation.input.right`）快速配置。**M1 实现完成，待实机验证**——M0 六项技术假设实测全部成立；准入走一行本体补丁（可选服务探测，未装插件零退化，规则 + 双基线入库并可离线自证）；单测 33 例、`verify-all dual-model` 12/12。设计文档与变更记录见其 `design/`。 |
| 外观 | [`dsh-miasaki-appearance/`](../dsh-miasaki-appearance/) | DSH web 外观插件 `@miasaki/dsh-appearance`（2026-09-11 立项）：设置里新增一栏**「外观」**，集中管理主题皮肤 / 壁纸 / 动效 / 会话效果。**M2 已收官（2026-09-12）**——M1 底座（设置栏 + 首帧注入 + 契约自检）实机六项全过后，S1–S6 依次落地 **皮肤层**（`derive-skins.mjs` 编译 105 token 表 + 首帧防闪色 boot style）、**壁纸与玻璃档位**（配置 v2、内置程序化渐变 + 本地图源、`color-mix` 表面透明度自动跟皮肤跟明暗）、**桌面壳让位协议**（`data-miasaki-theme-yield` 免刷新翻转、冲突自检）。走官方 `settings.section` 插槽 + `ctx.theme` 服务 + `webserver/index-inject`，**零 shell 改动、零第三方依赖**（配置自管 `~/.dsh/miasaki-appearance/config.json`）；总开关默认关闭、「关掉即原生」是硬契约。**2026-09-26 与官方「通用」设置页对照去重**：明暗偏好与正文字号是通用页 `AppearanceRow` / `FontSizeRow` 自己的行，外观页**不再做第二入口**，「主题」组只留官方没有的「皮肤」；`config.theme` 的 scheme / accent / fontSize 三个镜像字段同批删除（配置 v4），并立下「上新设项先过通用页对照」纪律（去重决策与 M3 → Boot Splash → M4 推进路线见该线 `design/2026-09-26-appearance-page-dedup-and-roadmap.md`）；同日 **V1 视觉统一**——单选控件全线换成官方「选择丸 + 下拉菜单」（`LanguageRow` 规格 + 官方 `Menu`），九宫格/表面旋钮/占位卡/运行信息同步对齐官方卡片与空态语言（见该线 `design/2026-09-26-appearance-visual-unification-and-roadmap.md`）；**2026-09-27 P1+P2 连续落地**——P2 Boot Splash 首帧启动画（`lib/splash.js` + `index-inject` 三行，首次启用官方 `html` 行 kind；配置 v5 `motion.bootSplash`；退场双信号 + 2.5s 兜底）、P1 M3 动效（纯 CSS 变量驱动层 + 三预设 + 强度倍率 + reduced-motion 降级），并加了「无可见效果」面板提示。单测 **120 例**、静态回归 **18/18**；M4 会话效果与恢复默认/导入导出待推。**2026-09-22 Boot Splash 首帧启动画设计定稿**（跨线新增项）：3080 首帧全屏启动画（三主题纹章动效 + 退场双信号 + 2.5s 超时兜底不挡错误页），与 desktop「Loading 2.0」契约见 `cross/boot-loading-2026-09-22.md`。 |
| 用量统计 | [`dsh-miasaki-usage/`](../dsh-miasaki-usage/) | DSH web 插件 `dsh-token-monitor`（v0.6.1，**2026-09-26 由桌面端线迁出、独立成第八线**）：会话「用量」Tab（纯当前会话视角 —— 上下文剩余 / 官方聚合 / 按会话过滤的实时明细 / 活跃时长）+ 侧栏脚部「用量统计」入口 → 全局浮窗（总览六卡 / 年热力图 / 使用趋势 / 模型用量 + 会话活跃分布 / 今日与限额）。**两条「干净」**：**① 接入干净** —— 本仓唯一「纯官方契约、零 miasaki 耦合」的插件（host 半只用官方 `webServer` / `llm/stream` / `tools/result` / `sessionProjections` / `tokenMeter` / `sessionQuery`，client 半只用官方三个槽位 `conversation.view` / `sidebar.footer.action` / `shell.overlay`），不碰主题、不碰补丁、不依赖其它 miasaki 包，因此可单独装进任意官方 DSH profile；**② 统计干净** —— **账本按 profile 分区**（`~/.dsh/plugins-data/dsh-token-monitor/<profile>/`），官方桌面端只记载官方自己这个实例的消耗，不再与自制壳（`miasaki`）/ 浏览器 GUI（`web`）混账；分区前的混合账一次性归位到 `miasaki/`，官方侧从零累计。2026-09-26 官方桌面端 profile 隔离为纯净官方版后**只挂回这一条**；装法由 `file:` 改 `link:`（消除副本漂移）。**2026-09-29（v0.6.1）修掉全局浮窗「打开慢」**：标题折叠加**负缓存**（账本里 69% 的会话日志已不存在，旧实现只在成功时写缓存 ⇒ 折叠路径永不收敛、每 5 秒轮询都重跑一遍并付两次全量 `persistence.list()`）+ **首屏不再为折叠排队**（折叠整读会话日志、4 并发独占事件循环 3.3–4.5 秒，任何"等一小段"的定时器都会被饿死）—— 端到端实测首屏 **2761ms → 2ms**、稳态每请求 **327ms → 0–1ms**。 |
| 免费模型 | [`dsh-miasaki-free-model/`](../dsh-miasaki-free-model/) | DSH web 插件 `@miasaki/dsh-free-model`（v0.4.0，**2026-09-28 由桌面端线迁出、独立成第九线** —— 原 `plugins/dsh-free-model-pool`，迁出同批更名并扩容职责）：**多来源免费模型聚合器**。**① 免 Key 车道（M1 已落地）**：经**官方 `llm` 契约**枚举本机所有已注册 provider 路由（`listProviders × listModels × resolveModelInfo`），`dsh-our-free-model` 这类免 Key 车道与自配平台进**同一张模型卡、同一套 verdict** —— 只读官方契约、零改第三方、对方零配合；三条纪律：逐 provider 隔离失败（一个平台挂了只进 `partial[]`）／逐调用超时与失败回落／**能力只到能被证明的程度**（适配器不声明工具参数就标"未声明·需实测"，不猜 false）；免费判定含 **L0 provider 级免 Key 车道**（`/free/i` 命中，刻意不硬编码插件名）。**② 本机自配平台**：扫 `llm-pi-ai.providers` 中带 baseURL 的路由，分层规则（`:free` / `-free` 后缀 · 定价全零 · 名称含「免费·free」）检出免费模型并标注命中依据，给出能力画像（工具调用、tool_choice、视觉、推理、编码、长上下文、**子代理可用性**）与决策摘要，可显式写入 provider models、切换子代理后端。**路由信任围栏**：composition 的 `connection` 准入优先且**逐请求读取**，缺席时结构层复刻；围栏**先于 method 检查与业务**（此前 4 条 `/freemodel-api/*` 路由裸奔，而 `/apply` 是写配置的动作）。**界面**：M2 曾往模型页挂过两个落点（`settings.models.footer` 与 `settings.models.provider-card`），**都已撤销** —— 前者是"塞在别人页面底部"的设计问题；后者是**风险**问题（官方模型页的编辑面板也会 dispatch 那个槽，occupant 一出问题就整树白屏；闸门见 `client-bundle.test.js`）。⚠️ 2026-09-28 那次「点供应商编辑白屏」经浏览器自动化复盘确认**真凶是 desktop 线 `patches/dsh-client-ui-settings-models` 在 0.2.0-rc.1 上的运行时补丁产物**（`ModelListEditor` 运行时报 `react_jsx_runtime.jsx is not a function`），与本线无关。当前形态见下条。**界面（续五修订）**：设置里那一栏「**免费模型**」就是上游插件 `dsh-our-free-model` 的设置页本身 —— 本线用 [`patches/dsh-our-free-model/`](../dsh-miasaki-free-model/patches/dsh-our-free-model/) 在它里面做**增量**（去掉公告分区与首启弹窗、左栏改名、模型清单后挂「本机自配平台」；五处锚点改写本机安装副本，可重放 / 可自检 / 可回退，它自升级后重打即可）。本线自己的 `settings.section` 改为**条件注册**：上游在场就让位（保证只有一个入口），它不在场时才顶上。**动作（M3）**：模型卡可「实测」（接 `dsh-model-probe` 的两段式探测，那个可选插件缺席时整块隐藏按钮）与「设为默认」（走**官方** `agentDefaultModel.saveSelection`，下一次会话立即生效）；**子代理指派的核实结论是"官方没有写路径"**（`subagentModelSelection` 只有只读 `current()`），故那条保留文件级改写并在 README 标注。闸门 `verify-all free-model` **15/15**（trust 15 / scan 15 / client-bundle **9** / default-model 7 / settings-read 10 / routes 6，合计 **62 例**；另含上游增量补丁的 3 件语法 + 1 件自证）。**2026-09-28 内核升到 `0.2.0-rc.1` 后复验**：契约面零适配（`settings.section` 与 `settings.models.provider-card` 逐字节未变、`llm` 五方法全在、`agentDefaultModel` 与 `connection.requestRejection` 未变），并起临时 host 打通三条业务路由；同批抓到并修掉一个真缺陷（webServer 的 exact 路由**按 path 去重**，同路径注册两条会让**整个插件不激活** —— 已加"路径唯一"闸门把该约束前移）。设计规划（M0–M4、来源取数与与第三方插件的边界）见 [`cross/free-model-unified-page-2026-09-28.md`](../dsh-miasaki-shared-docs/cross/free-model-unified-page-2026-09-28.md)。 |
| 共享参考 | [`dsh-miasaki-shared-docs/`](../dsh-miasaki-shared-docs/) | `cross/` 跨线设计契约（如 A×B 桌宠↔fleet 联动、sidebar 路线讨论）、`dsh-platform/` DSH 平台调研与升级回归记录。 |

九条线代码零耦合，仅共享 `dsh-miasaki-shared-docs/`；跨线引用使用 `../dsh-miasaki-shared-docs/…` 相对路径（同仓 clone 后不断）。

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
├─ dsh-miasaki-free-model/  # 免费模型线（`@miasaki/dsh-free-model` 插件本体：package.json + lib/ + test/ + cordis.patch.yml；design/ 在其内）
├─ dsh-miasaki-shared-docs/ # 跨线共享参考（含 cross/smoke-test-matrix.md 回归矩阵）
├─ scripts/verify-all.mjs   # 九线统一静态回归入口（L0 + L1）
└─ .gitignore               # _refs/ vendor/ dist/ .vs/ .workbuddy/ .learnings/ AGENTS.md 等均已忽略
```

## 统一回归（九线）

> 九线全部纳入统一回归；需要重启 host 或真机的实机项（插件加载 / 桌面壳冒烟 / 跨线联动）不在此脚本内。

**CI 已接入（2026-09-14）**：`.github/workflows/verify-all.yml` 在 `windows-latest` 上跑同一套回归
（push `main`/`master` + 任意 PR + 手动触发），使质量保证不再只依赖"维护者记得在本机跑一次"。
runner 自带 MSVC，因此本地 Git Bash 下 `cargo test` 的 `link.exe` 环境假阴性在 CI 中变成真信号。
CI 先装**三条有依赖的线**再跑闸门：sidebar 与 ssh 用 `pnpm install --frozen-lockfile`、
desktop 用 `npm ci --omit=dev`；canvas / fleet / dual-model / appearance / usage / free-model 已核实零依赖、无需安装。
（依赖缺失的实测后果、Node 22.19.0 与 pnpm 11 的版本取舍、45 分钟超时的理由，均写在该文件头部注释里。）

> **EOL 纪律（2026-09-14 起）**：仓库用 `.gitattributes`（`* -text`）禁止一切换行符转换。本仓多项检查做
> **逐字节比对**（desktop/dual-model 的 `patch verify` 比 SHA、appearance 的 `derive-skins --check` 重算 token 表），
> CI 首跑正是因 `windows-latest` 默认 `core.autocrlf=true` 把 LF 转成 CRLF 而失败 8 项。
> `-text` 规则优先于本机 `core.autocrlf`，因此任何机器 checkout 出的字节都一致 —— 编辑文件时请勿引入 CRLF。

```bash
node scripts/verify-all.mjs               # 九线 + 仓库级治理闸门（L0 静态检查 + L1 单线单测）
node scripts/verify-all.mjs usage         # 只跑一条线（sidebar / canvas / fleet / desktop / ssh / dual-model / appearance / usage / free-model / repo）
```

仓库级治理闸门**六项**（`node scripts/verify-all.mjs repo` 一把跑）也可单独跑：`check-silent-guards.mjs`
（守卫必须显式失败）、`check-doc-versions.mjs`（版本台账）、**`check-message-sources.mjs`**（会话消息来源
—— DSH 0.1.7 起 v4 要求 producer-owned kind，禁止退役的 `{ kind: "plugin", … }`；同时体检本机已装插件）、
**`check-md-links.mjs`**（入库文档的相对链接必须解析到**已入库**目标）、**`check-lock-sync.mjs`**
（锁文件与 `package.json` 的直接依赖 specifier 必须一致 —— 把「CI 红在装依赖那一步」提前到推送前）、
**`check-style.mjs`**（**2026-09-30 新增**：入库文本的**文件形态**（LF / 无 BOM / 末行换行）与
**公开仓库脱敏**（`C:\Users\<真名>\…` 绝对路径）—— 这两条都是成文但此前无闸门的纪律；
存量 54 处冻结在 `scripts/style-baseline.json`，**脱敏类刻意无基线**（新增即失败）。
会话日志取证用 **`inspect-session-sources.mjs`**（按帧解压多帧 zstd，报告每条 durable 消息的 `source.kind`；
会话日志逐帧追加，整文件解压只能读出第一帧）。

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
设计与验证见 [`dsh-miasaki-usage/design/CHANGELOG.md`](../dsh-miasaki-usage/design/CHANGELOG.md)。

**2026-09-26 深夜基线（全量 113 项检查，八线全 PASS；同批完成仓库清仓）**：sidebar 10/10、canvas 12/12、
fleet 15/15、desktop 33/33（含 `cargo test` + 6 个补丁离线自证）、ssh 12/12、dual-model 12/12、appearance 16/16、usage 3/3。
本批把 09-14 → 09-26 积压十二天的改动（usage 线迁出、desktop P7/P9/P10、canvas 存储治理与 `sessions/sync` 恒 400 修复、
ssh B1–B4 让位修复、DSH 平台调研）与仓库清仓一并提交：**删除 7 条线的 25 项死代码/冗余**（其中 usage 的
`scanTemplateLiterals` 由死代码**接线为装载闸门的第 3 项防线**），并回收 25.9 MB 测试残留。
逐条清单（含「审计误判但复核后保留」的反例）见
[`dsh-miasaki-shared-docs/repo-review-2026-09-26.md`](../dsh-miasaki-shared-docs/repo-review-2026-09-26.md) §七，
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
- **实机验收债务可度量** —— [回归矩阵 §3.0](../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)
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
[`dsh-miasaki-appearance/design/2026-09-26-appearance-page-dedup-and-roadmap.md`](../dsh-miasaki-appearance/design/2026-09-26-appearance-page-dedup-and-roadmap.md)；
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
[`dsh-miasaki-appearance/design/2026-09-26-appearance-visual-unification-and-roadmap.md`](../dsh-miasaki-appearance/design/2026-09-26-appearance-visual-unification-and-roadmap.md)。
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
[对标调研与方案](../dsh-miasaki-ssh/design/2026-09-26-ssh-zcode-benchmark-plan.md)（智谱
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
> [回归矩阵 §1 的 ※※ 注记](../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)。

**2026-09-27（桌面端适配整改 A 批 + B 批 T7：契约 v1.2 与让位量归壳）** `[实测]`：上游是同日的
[全线审查](../dsh-miasaki-shared-docs/repo-review-2026-09-27.md)（八线对桌面端的适配现状）与
[整改方案](../dsh-miasaki-shared-docs/cross/desktop-adaptation-plan-2026-09-27.md)。
审查的核心判断：**壳与插件的契约面已从 1 项长到 12 项，只有 1 项被文档化，而恰恰是那一项零消费**；
真正在用的 8 项（`data-miasaki-theme`、`--ms-titlebar-reserve`、`.tb-group` …）全是隐式契约，
且「窗控组实宽」这**一个事实有三方各自取数**（sidebar 写死常量 / canvas 量 DOM / ssh 实测）。

- **T1 让位量归壳**（`themes/src/06-titlebar.js`）：`ResizeObserver` 观测 `.tb-group` 实宽，自动写
  `--ms-titlebar-reserve = 组宽 + 8 + 12`（108→128、136→156）⇒ **壳成为该变量唯一写者**，sidebar 两处硬编码写入删除。
  **同日续修（实机重叠事件）**：迁移的两半生效速度不同 —— 插件删写入**刷新即生效**，壳接写入要**重编 exe**
  （`include_str!` 内嵌），空档期变量无人写 ⇒ 回落到照「无终端键」定的静态兜底 `128px`、整整少让一格 28px，
  官方 ExpandButton 压住 sidebar 终端键（用户报障）。两处订正：兜底改按**注入形态上界**取 `156px`（`03-switcher.js`）；
  sidebar 改**能力门控兜底**（`chrome.bounds` 在位不写 / 缺席按 `.tb-group` 实宽补位）。**根因与换算取证见
  [desktop/design/CHANGELOG.md 当日续条](../dsh-miasaki-desktop/design/CHANGELOG.md)** 与
  [sidebar/design/CHANGELOG.md 同日条](../dsh-miasaki-sidebar/design/CHANGELOG.md)。
  `verify-themes` 新增 2 项端到端断言（注入一格按钮 ⇒ 自动 +28、移除 ⇒ 回落），**本轮实跑 23/23 PASS** —
  顺带解开该脚本在 P10（改走官方 token）之后的一个死结：未鉴权页面的 `localStorage` 访问被拒会**崩掉整个脚本**，
  改为该项 skip、其余照跑（此前它一项都验不到）。
- **T2 契约 v1.2**（`themes/src/10-contract.js`）：新增**只读** `chrome.bounds()` / `chrome.onChange()`
  （壳窗控组视口矩形 + 变更订阅）。**`protocolVersion` 仍为 1** —— 按契约 §4，增量能力只追加 `capabilities`；
  子 frame 仍只给空壳（canvas / ssh 都是主帧量、iframe 消费，无需开口子）。闸门 **15 → 19 例**，
  并补上「**未知命名空间即失败**」的守卫（原先对未知 ns 静默跳过，等于该纪律一直没有闸门）。
- **消费侧三处**：canvas 让位取数契约化 + 订阅（`verify-all canvas` **13/13**、单测 100 → 105）；
  ssh 口径①契约化、**口径② 与 `rootObserver` 不动**（`verify-all ssh` **31/31**、`client.test.js` 38 → 43 例，
  顺带修掉测试夹具一个**假阴性**：桩节点是纯对象、`instanceof HTMLElement` 恒 false ⇒ DOM 兜底路径从未真被执行过）；
  sidebar 让位量改**能力门控兜底**（见上 T1 续修；`verify-all sidebar` **11/11**、单测 62 → **66**）。
- **T7 fleet 联动**（`src-tauri/src/main.rs`）：`MIASAKI_FLEET_PULSE` 补**三级回退**（环境变量 →
  `%LOCALAPPDATA%\miasaki\config.json` 的 `fleetPulsePath` → 关闭）。此前只认环境变量，而全仓
  **没有任何脚本或安装步骤设置过它**（2026-09-27 实测：用户级/机器级/进程级全空）⇒ 脉冲文件每分钟都在更新、
  桌宠从来不读，这条联动等于不存在。同批订正 README 里**写反的优先级**（实为「等待审批 > fleet 告警」）。
  `cargo test` **86 例**。
- **同批落地**：`themes/src/10-contract.js` 头部纪律同步 v1.1/v1.2（此前仍写「只读 + 不提供写通道」，
  与同文件实现自相矛盾）；`design/desktop-contract.md` 补 v1.2 契约面与三条边界；回归矩阵 §3.1 新增
  「契约 v1.2 + 让位量归壳」判据行 + 台账 **E9**（台账总数 45 → 47 项，分母口径已在文件里写明）。
- **顺带修掉一处闸门假阳性**：`verify-themes.mjs` 的无头 Edge profile 原落在工作区
  `dsh-miasaki-desktop/.edge-test-profile/`（跑一次 747 文件 / 34MB），而 `check-silent-guards.mjs`
  按目录遍历、**不读 `.gitignore`** ⇒ 全量回归凭空报「190 处新增静默降级」。已把 profile 改到系统
  临时目录，并在 `SKIP_DIRS` 兜一道防历史残留（该目录 2026-09-26 清仓时删过一次，会反复长出来）。
- **仍待办**：① **T6 跨线契约闸门**（`check-pulse-contract`，B 批）未做 —— 本批只落了 T7；
  ② 实机项 E9 等（一次桌面壳重启 + 一次 `dsh web` 重启即可同批验 §3.0 的 D1+D2 共 25 项）。

**2026-09-27（仓库级第三道闸门：会话消息来源 · 平台兼容）** `[实测]`：用户截图报 miasaki 桌面端
「本轮运行失败 format v4 message requires a producer-owned source kind」。定位结论：**不是会话损坏、
不是模型问题**，而是第三方记忆插件 `@openviking/dsh-memory-plugin@0.2.1` 仍在用 **v3 的消息来源写法**
`{ kind: "plugin", plugin: … }`，被 DSH 0.1.7 的 **v4 准入**（`assertV4SourceRowAdmission`）在**落盘前**硬拒
—— 它挂在 `agent/pre-step`、**每轮**注入记忆召回消息，于是每轮必失败；而磁盘与 host 日志里查不到任何痕迹
（被拒的消息根本不落盘）。**两个排查坑已入纪律**：① 会话日志是**逐帧追加的 zstd**，
`zstdDecompressSync` 读整文件**只解得出第一帧**（就是 header 那一行，看起来"日志是空的"），必须按帧 magic 切分；
② 该错误不进 host 日志，只以 turn error 形式顶到 UI（`message.turnError`）。
**修复**：两个 profile（`miasaki` / `web`）该插件 `^0.2.1 → ^0.5.8`（0.5.8 改成 `plugin:openviking-memory`，
peer 已声明支持 `^0.1.7-rc.2`；0.2.1 的 peer 范围 `>=0.1.0-rc.6 <0.2.0` 把 0.1.7 判为兼容，**peer 不保证协议兼容**）。
离线验证：实装 0.5.8 + 插件真实 `pluginMessage()` 产出过 v4 编码器 + 入口模块可导入；
**待重启后端生效**（host 半只在启动时加载）。
**新增仓库级闸门第 3 项 `repo/message-sources`**：`scripts/check-message-sources.mjs`（扫仓库内源码 +
本机已装插件；**内置自证**正例必命中 / 反例必不误报；故障注入实测 `exit 1` 并点名文件:行；豁免 `// source-ok: <理由>`），
配 `scripts/inspect-session-sources.mjs`（多帧 zstd 会话日志取证，报告每条 durable 消息的 `source.kind`）
—— **闸门管写入方，工具管已落盘的数据**。`verify-all repo` **2 → 3 项**（**2026-09-27 全量实测 142 项**：sidebar 12 / canvas 13 / fleet 17 /
desktop 33 / ssh 31 / dual-model 12 / appearance 18 / usage 3 / repo 3）；
闸门首跑覆盖本机 6 个 profile / 11572 个源码文件，零命中。归档见
[`dsh-platform/dsh-0.1.7-session-v4-source-admission-2026-09-27.md`](../dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.7-session-v4-source-admission-2026-09-27.md)，
回归矩阵新增 **§3.11** 与台账 **H1**。

**2026-09-28 基线（全量 150 项检查，八线 + 仓库级全 PASS）**`[实测]`：sidebar 13/13、canvas 13/13、fleet 17/17、
desktop **40/40**（含 `cargo test` **100 例** + 8 个运行时补丁离线自证 + computer-use 产物语法 5 项）、ssh 31/31、
dual-model 12/12、appearance 18/18、usage 3/3、repo 3/3。单测例数（本轮实跑）：sidebar **86**（81 过 / 5 环境跳过）、
canvas **105**、fleet **119**、ssh **310**、dual-model **33**、appearance **120**、desktop `cargo test` **100**。
**同批的两件仓库级事**：① `dsh-computer-use` 的产物（上游 orb 编译入库，本仓无源码、重生成会整体覆盖）接入
`desktop` 语法闸门 —— 它同时被 `check-silent-guards` 新增的 `SKIP_PATH_PREFIXES` 按目录排除，
**那几个语法项就是这次排除的替代检查**（排除而不加替代检查＝把风险藏起来）；② 静默守卫闸门的新增命中已就地闭环
（2 处 `rebuild-baseline.mjs` 的向上探测 catch 写 `guard-ok` 理由；2 处是 `uniqueDirectory()` 的**目标路径可用性探测**
被 R1 误判，随目录排除一并消失），命中 64 → 60、新增 0、可回收 0。

**2026-09-29（续）基线（全量 164 项检查，九线 + 仓库级全 PASS）**`[实测]`：sidebar 13/13、canvas 13/13、
fleet 17/17、desktop 36/36、ssh 31/31、**dual-model 15/15**（12 → 15：+2 语法 +1 测试）、
appearance 18/18、usage 3/3、free-model 15/15、repo 3/3。**本批只动 dual-model 一条线** ——
用户判断「先别急着分发，逐线完善」，查 [实机验收台账](../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)
得 **1 / 49 项已验**（48 项积压），而 dual-model 的 §3.10 里「纯文本主模型仍可传图」
是**唯一「功能性可能出错」**的一条，故从它开始。

**① 代码审计抓到一条全程零信号的静默丢图链**：准入侧（本体补丁 `for()`）只看
「是否启用 + 是否配置了辅助模型」，而路由侧（`decideRoute`）还要看 `hasImage`（`agent/pre-step` 实测）
—— **两段判据不同源**。于是 `attach()` 失败或 pre-step 判定抛错 ⇒ `hasImage=false` ⇒ 不切辅助模型
⇒ **图片交给不支持图的主模型，而用户以为发出去了**。四处静默点：`attach` 三条早退、
`pre-step` 的 `catch` 把失败当成"确实无图"、`agents.list()` 的 try 包住整个循环、`disposed` 不清通道标记。
**另有一处注释与实现不一致**：`lib/routing.js` 的 JSDoc 引用 `routeNeedsVision` —— 该函数**全仓不存在**。
**修法**：新增 `lib/admission.js` 的 `decideAdmission()` —— **只有图片执行通道确实建立时才接管控入**
（`channelReady` 集合，两个监听都挂上才算就绪）；通道没建好时不接管，本体走原生分支给出
**可见的**拒绝 —— *可见的失败优于静默的错误*。同批把判定失败改为**保守取 true** 并留痕、
`attach` 三条早退全部 `console.warn`、`agents.list()` 逐 agent 兜底、订正那句 JSDoc。

**② 顺带补两处闸门漏登记**（「清单与实现不一致」这一族，本项目已复发三次）：
`verify-all.mjs` 的 dual-model 语法清单只有 6 个文件，而 `package.json` 的 `build` 有 8 个 ——
**`lib/invalidation.js` 长期没进仓库级静态闸门**；新模块 `lib/admission.js` 同批进两处。

**③ 实机验收前置查明**：本体准入补丁**此前不在位**（`patch.mjs status` 报 `original`）——
即「任一支持图片即可发图」这条核心能力**当时是失效的**（准入走原生分支，主模型不支持图即拒绝），
这正是 §3.10 第 5 项「纯文本主模型仍可传图」从未闭环的原因。已应用（`status` → `patched`）；
DSH **0.2.0-rc.2** 的该包与基线版本（rc.1）**逐字节一致**（SHA 相同），锚点未漂移。

**2026-09-29 基线（全量 161 项检查，九线 + 仓库级全 PASS）**`[实测]`：sidebar 13/13、canvas 13/13、fleet 17/17、
desktop **36/36**（免费模型池迁出后 40 → 36 —— 那 4 项随插件迁入第九线）、ssh 31/31、dual-model 12/12、
appearance 18/18、usage 3/3、**free-model 15/15**（新线首次入账）、repo 3/3。
**本次收尾抓到两处真缺陷，同属「迁移时漏登记」这一族**：

① **两个仓库级闸门都漏了第九线** —— `check-silent-guards.mjs` 的 `LINES` 与 `check-message-sources.mjs` 的
`REPO_TARGETS` 在 2026-09-28 第九线迁出时都没补 `dsh-miasaki-free-model`，而前者的注释**已经写成「九线」**
（注释与实现不一致，正是这类缺口的典型签名）⇒ 整条线对两道闸门**不可见**；连带把基线里那条 free-model
条目报成「可回收」（判据是「当前命中里没有」，真相是「没去扫」）。
**纪律**：这类「可回收」预警**不能照着提示删基线**，要先核扫描清单 —— 删了就等于把不可见固化成干净。
修后复跑：`silent-guards` 扫描根 10 → **11**、命中 59、新增 0、可回收 0；`message-sources` 仓库内
198 → **215** 个源码文件、命中 0。

② **核销一条基线欠账** —— 上条 free-model 的 `if (!existsSync(p)) continue;`（三个 agent 预设各自独立安装，
跳过未装的那个是**业务判据本身**，不是「缺件静默降级」）就地写 `guard-ok` 豁免并从基线移除，
存量 **58 → 57 类**（这是债不是背书，核销才让基线将来真能抓住回归）。

③ **修掉自 2026-09-26 起持续的 CI 红** —— 本机 161 项全绿而 CI 每次 push 都红（Actions 日志需 admin，本机读不到）。
按「空 `DSH_HOME` → `git clone --local` 干净树 → **对齐 CI 的 Node 版本**」三步在本机复现，根因是
`ssh/test/tools.test.js` 踩了 **`unref()` 定时器 + Node 22 test runner** 的组合：`lib/exec.js` 的
`timeoutTimer.unref()` 是刻意设计（真实 host 常驻另有 ref 句柄），但**测试进程里它是唯一句柄** ⇒
事件循环立刻变空 ⇒ Node 22 判 `Promise resolution is still pending…` 且**不再等待**（用例 0.5ms 即报错、
不等满 1000ms），连累后续 13 例。**修在测试侧**（补一个 ref 保活句柄），产品的 `unref()` 不动。
Node **22.19.0** 与 **24.15.0** 各自 `tools.test.js` **31/31**、全量 **161 项全 PASS**。
**纪律**：CI 固定 Node **22.19.0** 而本机常是 24.x ——「**本机全绿 ≠ CI 绿**」，
改动后用 `npx -y node@22.19.0 scripts/verify-all.mjs` 复跑一次。

**2026-09-29（深夜）基线（全量 167 项检查，九线 + 仓库级；本机 166 PASS + 1 项沙箱阻塞）**`[实测]`：
sidebar 13/13、canvas 13/13、fleet 17/17、desktop **38/38**（含 `cargo test` **109 例**）、ssh 31/31、
dual-model 15/15、appearance 18/18、usage 3/3、free-model 15/15、**repo 4/4**。
唯一未执行项是 `repo/md-links`：它内部 `execFileSync('git')` 走默认管道 stdio，在本机 DSH 沙箱下
`EPERM`（沙箱边界，非缺陷）—— 已用**等价快照数据源喂真脚本**复核 **PASS**（184 个入库文档 / 426 个
相对链接全部解析到已入库目标），CI 侧可正常执行。**本批四线工作 + 两处闸门接线一并入账**：

① **DSH 0.2.0-rc.2 适配**（desktop）：七件补丁重打 —— attachment / brand-official / settings-models /
trajectory / api-session-controller 五件常量不变（rc.2 原版逐字节相同）、chat 与 conversation 换
baseline + 回填三常量、sidebar 删 1 条编辑（品牌区 Tooltip 已被官方移除，幂等标记同步换锚）；
`dsh-cordis-host-runner` **整件退役**（官方 rc.2 自行实现同一修复且更完整，本补丁 4 条编辑的锚点在
rc.2 上**全部命中 0 次**、在 rc.1 baseline 上 4/4）⇒ desktop **−1**，同时新增 `RETIRED` 标记供
`patch-live-audit` 跳过（否则「未重打」会被误报成待办）。

② **桌宠设置扩起 + 设置页视觉重做**（desktop）：设置项 2 → **12**（新增壳侧六项：动效强度 / 气泡时长 /
不透明度 / 宠物钉选 / 鼠标穿透 / 隐藏后形态；新增 `pet_native/settings.rs` 独立持久化 —— 刻意不塞进
`pet.json`，后者被拖动路径高频重写），`cargo test` 100 → **109**；设置页从裸 `div` + 内联样式改为
**官方 primitives + `.mia-*` 行式规格**（对齐官方「通用设置」页），并落 **风格契约 5 条闸门**。
**顺带补上一道漏掉的闸门**：`plugins/dsh-pet-panel/lib/client.js` 此前**不在任何闸门里**（只靠
`package.json` 的 build 脚本检查，回归里看不见）⇒ desktop **+3**。

③ **sidebar 侧线改为只带最近 3 轮**：原先 `fork` 不传 `atSeq`，而官方对「省略」的语义是
**继承主会话全部已完成轮次** ⇒ 用户看到的是「把主会话又复制一遍」。改为传 `atSeq` 截到倒数第 3 个
`turn/start`（`atSeq` 是 inclusive 前缀边界）；拿不到绑定或不足 3 轮时**退回全文 fork 并如实标注**
（侧线头显示「完整历史」vs「最近 3 轮」），不猜、不静默。单测 13 → **18 例**，并改掉两条与新语义
直接冲突的旧硬断言。

> **2026-09-30 订正 —— 本条已回退，勿当现状引用。** `atSeq` 被读反了：它是**保留 `0..atSeq` 的头部前缀上界**
> （`dsh-session/lib/types/fork.js:19` = `events.slice(0, boundary + 1)`），**只能截尾、不能截头** ⇒
> 「只带最近 N 轮」用 `fork` 实现不了；真触发时反而会把**最近的轮次丢掉、留下更早的历史**。
> `client.js` 与 `test/sidechat-registry.test.js` 已 `git restore` 回 `b064720^`（单测 18 → **13** 例），
> 侧线回到官方默认的全文前缀。契约事实见 `dsh-miasaki-sidebar/design/2026-09-27-sidebar-m2-sidechat-design.md` 的 **C1b**，
> 回退原因与实机证据见该线 `design/CHANGELOG.md` 2026-09-30 条；同日 ZCode 官方复核（该文 §5.1(D)）另行证明
> 「干净」靠**可见性**（模型可见 / UI 不画）而非少带上下文 —— DSH 侧三者（消息级可见性 / fork 边界注入 / child 不入列表）全部缺席。

④ **appearance M3.2 设置页动效统一**：动效层里设置面板那条挂在 `.mia-panel` —— 一个**各线各带一份
CSS 复制出来的面板类名**，实际只有 appearance 与 pet-panel 用 ⇒ 设置里**只有「外观」「桌宠」两页**
整块上浮、其余六页瞬切；而官方设置外壳本身零 `animation` / 零 `transition`，连 `reduced-motion`
分支也仍只剩那两页淡入。改为挂**官方设置面板容器**（`[role="presentation"] > [role="dialog"]
[aria-modal="true"][aria-labelledby]`，按 dsh 0.2.0-rc.2 **实际安装产物**取证：该组合在全量 client 包中
**全局唯一**，官方 Modal / 图片灯箱走 `aria-label`、usage 浮窗走 `aria-label`、ssh 面板 sheet 父级不是
`[role="presentation"]`，均不命中）⇒ 打开设置时整块入场一次，页签之间切换复用同一 DOM 节点**不重播**、
与官方瞬切一致。

**两处闸门接线（本批的真实发现）**：`md-links` 的脚本 `scripts/check-md-links.mjs` 已于 `5a1e91d`
入库、但 `verify-all.mjs` 里**没有挂载** —— 闸门存在却从不执行，正是本仓反复出现的
「**注释/说明声称覆盖、实现没覆盖**」形态（与第九线迁移时两道闸门漏登记同族）；
`dsh-pet-panel` 同理（见 ②）。两者本批都已接线。**取证纪律补一条**：锚点类改动必须按
**运行版**（本机实际安装产物）取证 —— vendor 开发版的 `SettingsRoot.tsx` 与 rc.2 实装产物有差异
（实装多一个 `data-shortcut-modal="settings"`），照源码猜会选错锚点。

**CI 自 09-29 20:44 起红已修（「本机绿 ≠ CI 绿」的第二个实例）**：`8181b89`（其后 `2ef10fa` 又动过同一批文件）
给各 web 插件补 `peerDependencies`（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-host-webserver`）时只改了
`package.json`、没同步 `pnpm-lock.yaml` ⇒ CI 的 `pnpm install --frozen-lockfile` 以
`ERR_PNPM_OUTDATED_LOCKFILE` 失败（日志原文：`* 2 dependencies were added: @deepseek-ai/cordis@^4.0.2,
@deepseek-ai/dsh-host-webserver@>=0.1.2-rc.1 <0.3.0`），**后续步骤（安装 ssh 线依赖 / desktop 线依赖 /
运行 verify-all）全部被 skip —— 那 3 小时里一个测试都没跑**；连续 **11 次** push（`8181b89` … `f610ef3`）
都红，而本机每次都全绿（本地 `pnpm install` 不带 `--frozen-lockfile`，会**自动把 lock 补齐**
—— 越是顺手跑过 install 越看不见）。已用 `pnpm install --lockfile-only` 同步 sidebar / ssh 两条线
（pnpm 默认 `auto-install-peers`，故 peer 依赖记入 `dependencies` 并展开依赖树，与本仓 canvas 线既有
lock **逐字同格式**）；两条线 `pnpm install --frozen-lockfile` 各自 exit=0，推送后
**CI 转绿（3m27s，167 项全绿，desktop 38/38 含 `cargo test` 109 例）**。
**纪律**：CI 红的判据**先看红在哪一步**（`gh run view <id>` 直接给步骤名与注释）——
本次失败步骤是「安装 sidebar 线依赖」，一眼排除「Node 版本 / 测试挂起」那类成因；
另附一条认知纠正：`gh run view --log-failed` **本机可读**，此前记录的「Actions 日志 API 需 admin」不成立。

**2026-09-30 基线（全量 168 项，十类全 PASS）**`[实测]`：sidebar 13/13、canvas 13/13、fleet 17/17、
desktop **38/38**（含 `cargo test` 109 例）、ssh 31/31、dual-model 15/15、appearance 18/18、usage 3/3、
free-model 15/15、**repo 5/5**。口径变化：repo 4 → 5 = 新增 `lock-sync` 闸门（见下）；`repo/md-links`
在本轮 file policy（`danger-full-access`）下不再被沙箱阻塞 ⇒ 本机首次**无阻塞项**（受限沙箱下它仍会
因 `execFileSync('git')` 走管道 stdio 而 EPERM，那是沙箱边界不是缺陷）。

**同一基线的受限沙箱口径（提交前复核复跑）**`[实测]`：file policy = `workspace-write` 下全量
**167 PASS + 1 阻塞**（唯一阻塞仍是 `repo/md-links`，同上 EPERM），其余九类与 `repo` 其余四项全 PASS
—— **与 168/168 是同一棵树、同一判据，差异只来自沙箱能否 spawn `git`**。复核 sidebar 回退 +
`lock-sync` 接线这批改动时以此口径为准，别把沙箱边界误读成回归失败。

**新增闸门 `repo/lock-sync`（把上面那类红拦在推送前）**`[实测]`：判据是锁文件（`pnpm-lock.yaml` 的
`importers['.']` / `package-lock.json` 的 `packages['']`）里四个依赖段与 `package.json` 的直接依赖
specifier 逐项一致。**pnpm 侧刻意跨字段合并比对** —— `autoInstallPeers: true` 时 `package.json` 的
peerDependencies 在锁文件里登记进的是 `dependencies` 段（sidebar 实测：2 个 peer 落在 dependencies，
其余 4 个普通依赖也在同一段），按字段名逐段对齐会立刻误报。闸门**自带 fixture 正反例 + specifier 漂移
+ npm 侧共四项自证**并随每次运行执行 —— 防的是「解析器坏掉 ⇒ 永远绿」这个闸门最坏的失效形态
（首版 fixture 少写一个依赖，正是被自证当场抓出的）。**验证两条**：① 拿 `f610ef3` 的历史
`package.json` + `pnpm-lock.yaml` 放进临时目录用 `--root` 复现，报出的两条缺登记与 CI 日志**逐字相同**
（`@deepseek-ai/cordis@^4.0.2`、`@deepseek-ai/dsh-host-webserver@>=0.1.2-rc.1 <0.3.0`）；
② 当前树 4 个锁文件 / 19 条直接依赖登记全 PASS。**动态枚举的收益**：闸门扫 `dsh-miasaki-*` 下全部锁文件，
首次运行即发现 `dsh-miasaki-canvas/pnpm-lock.yaml` 同样在管 —— 照 CI 那三条线硬编码会漏掉它。

**2026-09-30（本轮）· 三处静默缺口收口 + 一道缺席围栏（K3/K4/K5/I5）**`[实测]`：触发是用户
「规划设计修复方案并开始修复」。方案（规划类，按入库边界落 `_refs/internal-plans/fix-plan-2026-09-30.md`，不推送）
**不新增判据**，只落地既有台账 —— 其中 K3 的判据来自**仓库自己的历史交付物**：
`tasks/t-0003/result.json` 早在 2026-09-11 就点名了 `validate-bus.mjs` L231 的静默放行，并给出不变式
「任何被标记为终态的对象都必须有一条反向存在性检查（done ⇒ result.json；accepted ⇒ verdict.json；
running ⇒ 心跳新鲜）」。**本批即该结论的落地**。

- **K3（fleet）终态必须有交付物**：`validate-bus.mjs` 对缺失 `result.json` 由 `continue` 改为
  **反向存在性检查**，且**驱动源是台账而非 `tasks/` 目录** —— 这是被测试用例驱动出的修正：
  原写法以目录为入口，「已验收、但连 `tasks/<id>/` 目录都不存在」这一同族形态仍会静默通过。
  **首跑即抓到存量 7/9 任务**（9 个任务全部 done+accepted，只有 t-0003 / t-0004 真有交付契约），
  「验收通过」当时确实是空的。7 份 `result.json` 按契约**补记**：evidence 指向原始 `result-*.md`
  或派单器代写的 `transcript.md`（t-0007 / t-0008 的交付形态就是 stdout），artifacts 带真实 sha256，
  conclusion 逐字摘自已交付材料并标注「契约补记 2026-09-30」。同批把 `tasks.jsonl` 的折叠口径
  **改为复用 `foldTasks`**（此前是本文件里的第二份重放实现）。闸门：`tests/bus-integration.test.mjs`
  **+4 例**（终态缺交付物必失败 / 有交付物通过 / 在途不报错 / done 未验收不越界）；实盘 33 文件 0 错误。
- **K4（fleet）自述受阻必须如实落账**：`dispatch-task.ps1` 过去把 `exit 0` 一律当「健康空闲」
  ⇒ 自述受阻的 worker 在面板与桌宠上照常显示正常。判据不引入新约定：受阻的载体就是**交付契约本身**
  （`tasks/<id>/result.json` 的 `status = blocked | failed`）。新增 `workers/dispatch/final-state.ps1`
  （判定**单点**、纯函数、`-OutFile` 可回读），派单器经它落终态，**退出码语义（§7.0 的 0/3/4）不动**；
  `tests/dispatch-state.test.mjs` **9 例**，含**两个 ps1 的语法闸门** —— PowerShell 侧此前没有任何
  自动化检查。**故障注入自证**：注入语法错误 ⇒ 闸门 exit 1 并点名 `dispatch-task.ps1:357`，还原后复跑通过。
  测试里记下一个环境事实（否则下次还会踩）：本机 `pwsh` 常不在 `PATH`、且默认执行策略会拒绝未签名脚本
  （`SecurityError`），故探测顺序为「PS7 已知路径 → PATH 的 pwsh → 5.1」并统一带 `-ExecutionPolicy Bypass`。
- **K5（fleet）厂商表不再是空宣称**：`verifier-pick.mjs` 的 `loadVendors()` 读 `shared/agent-vendors.json`，
  而该文件**从不存在**（v0.23 附注登记在案），读不到就静默回退内置表 —— 默认表与实际厂商归属不符时
  会给出**假异构**结论且无提示。处置选「**真读 + 显式告知**」而非「删宣称」（覆盖能力本身是设计意图）：
  新增真实文件 + `workers/lib/vendors.mjs`（缺失 / 结构非法两条回退路径都留痕）；测试 **+5 例**。
- **I5（usage）同源围栏**：本线此前是九线里**唯一没有围栏**的一条（2026-09-29 实测非环回 Host /
  跨站两轴均 **200**，而同批四线均 403，且 `POST /reset` 是清空账本的写操作）。新增 `lib/fence.js`
  （`structuralFence` + `trustFence` + `fenceHandler`），在 **register 一处**统一包装五条路由
  ⇒ 新增路由不会漏挂；`inject` 仍只有 `webServer`、`connection` 逐请求求值，**零 miasaki 耦合不变**。
  `test/fence.test.mjs` **13 例**，含「围栏先于业务」的顺序断言（跨站 POST 得 403 而非 405、handler 零调用）。
- **口径与收尾**：全量 **168 → 171**（fleet 17→18、usage 3→5），十类全 PASS；`silent-guards` 基线
  **核销 2 类（57 → 55）**、新增 0 —— 两条正是本批主动修掉的静默断链，核销前逐条复核
  「是修掉了，不是扫不到」（本仓曾把「没去扫」误读成「已干净」）。台账勾选 **4 → 6 / 102**；
  **未勾的实机项如实保留**：K4 端到端待一次真实派单、I5 待重启 `dsh web` 复验两轴 403。

**2026-09-30（续）·「只有注释、没有闸门」再收两处（I1 / J5）**`[实测]`：用户「继续」⇒ 按
「**静默失效优先于视觉确认**、可独立验证」的纪律继续推进。两项都不新增判据，只把矩阵里**已经写着**
的纪律变成机器判定 —— 它们的共同形态是「规则写在文档与注释里，但没有任何东西会拦下违反」。

- **I1 账本目录名（usage）**：矩阵原话「2026-09-29 已用 `LEDGER_DIR_NAME` 解耦但**无闸门**」。
  失效形态是「一次顺手统一命名 ⇒ 三个 profile 的历史账本全部失联」，而界面照常、数字归零、不报错。
  把目录名与解析抽成单点 `lib/ledger-dir.js`（`LEDGER_DIR_NAME` + `resolveDataDir`），
  `test/ledger-dir.test.mjs` **5 例**：目录名**冻结为历史值**（写死字面量断言）/ **目录身份与包身份无派生关系**
  （源码不得读 `package.json`、不得把插件名拼进路径；反向佐证：包名带 scope 而目录名不带）/
  宿主服务三形态（字符串 / `{resolve}` / `{dir}`）与优先级 / 异常回退不丢账本。`verify-all usage` **5 → 7 项**。
- **J5 上游补丁 live 审计（free-model）**：矩阵写着「常驻闸门」，但它**只在你记得手跑
  `patch.mjs status` 时才存在**；而上游的应用内升级**必覆盖**清单内文件 ⇒ 那栏悄悄退化成上游原样
  （公告中心与首启弹窗回来了），而本线不崩不报错、`verify-all` 照常全绿（离线 `verify` 只证「规则与基线自洽」）。
  三处接线：① 补丁导出 live 契约（`TARGET_PACKAGE` / `TARGET_RELATIVE` / `classify`，**刻意不导出
  `BASELINE_DSH_VERSION`** —— 它的基线是上游插件版本而非 DSH 版本）；② `patch-live-audit.mjs` 的
  `PATCH_ROOTS` 补该补丁目录、布局候选补 `~/.dsh/local-plugins`（不补这条，即使入册也会误报 `missing`）；
  ③ **drift 判定加「须有 DSH 基线」前提** —— 无基线者「未打上」判**真回归**而不是「升级待重打」
  （playwright 补丁当初的审计盲区正是此形态）。
  **故障注入自证**（用真实的上游原版备份 `client.js.ofm-patchbak` 造一个假 `local-plugins` 根）：
  上游原版 ⇒ `original` + exit 1；垃圾文本（锚点漂移）⇒ `unknown` + exit 1；真实安装 ⇒ `patched` + exit 0。
  **自证顺带抓到一处真缺陷**：审计侧原先 `const { state } = await target.classify(...)` ——
  **只取 `state`、丢掉 `detail`**，于是「上游原版」与「锚点漂移」在输出上完全一样，而两者的处置方式不同
  （**重打** vs **重新对齐锚点**）；已改为解构 `detail` 并显示。**该缺陷只在故障注入下暴露**（正常路径恒 `patched`）。
- **口径**：全量 **171 → 173**（usage 5 → 7）；live 审计 **10 → 11 个目标 / 10 件在册补丁**；
  台账勾选 **6 → 7 / 102**（J5 的判据「5/5 applied」已实测满足且已自动化；I1 的运行时部分仍待三 profile 重启）。

**2026-09-30（续二）· 静默失效 #18：拿不到 profile 名时不再假装隔离**`[实测]`：用户第二次「继续」⇒
按上一轮给出的排序取下一条（同域、成本低、可独立验证）。问题在 `resolveProfileName` 的**兜底档**：
三档（宿主 `profileContext` → 环境 `DSH_PROFILE` → 兜底）全空时它返回裸字符串 `'default'`，
账本落 `…/default/`，而页面照常宣称「本页只统计当前 profile（default）· 与其它 profile 的账本
**完全隔离**」—— 那句话是假的：这个桶是**共享兜底区**，宿主既没给 profileContext、环境也没有
DSH_PROFILE 时，**多个不同环境会写进同一个桶**。失效形态正是本仓最警惕的那类：
**不报错、界面正常、账在混**。

**修法（不假装，而不是换桶）**：目录名仍为 `default` —— 既有账本不能丢（换桶等于「搬家」，
与 I1 那条纪律同一个道理）；改的是**口径的如实性**：`resolveProfileKey(ctx, env)` 返回
`{ name, source }`（`source ∈ profileContext | env | unknown`），`unknown` 档随 `/global` 下发
`profileSource`，浮窗顶部口径与底部那段长说明**双双按 `source` 分支**
（unknown ⇒ 明确写「未识别当前 profile … 可能与其它环境混账，并非真隔离」）。
`resolveProfileName` / `safeProfileDir` 一并移入 `lib/ledger-dir.js`（与账本根目录名同属「账本身份」，
抽在一起才测得到）。

**闸门**：`test/ledger-dir.test.mjs` **5 → 9 例**（+4）：`profileContext` 优先且 trim / 环境变量档 /
**三档全空 ⇒ `unknown`**（四种输入形态，含服务抛错与非字符串 name）/
`safeProfileDir` 是**安全边界**（`@miasaki/dsh-x` ⇒ `_miasaki_dsh-x`、`../../etc` ⇒ `.._.._etc`）。

**台账补立 I6** —— 这条债务此前**在文档里没有编号**（无编号 = 不可见，与 09-29 补账的教训同源），
分母 **102 → 103**；勾选仍 **7 / 103**（I6 待实机看文案）。
**测试自身踩的一坑已写进注释**：`resolveProfileKey(ctx, undefined)` 会回落到 `process.env`
（这是生产路径的正确行为），而本机环境恰好带 `DSH_PROFILE` ⇒ 用例拿到 `'desktop'` 而失败；
测试里 env 一律**显式传表**。

**2026-09-30（续三）· 素材遮蔽链变成机器判据（静默失效 #20）**`[实测]`：用户第三次「继续」⇒
按建议排序取下一条。选它是因为**它有真实用户影响面** —— 2026-09-27/28 whale 图集与白军装反转狂三
**在实机上失效了一整天**，而代码、单测、资产闸门**全绿**，只有 `pet.log` 里一行 `whale_rows=7`
能戳破；根因是素材两层解析（EXE 旁磁盘 `ui/` 覆盖层优先、编译期内嵌兜底）下，
**磁盘上的旧素材静默遮蔽内嵌的新素材**。

**为什么此前加不了闸门**：判定逻辑写在 `build.rs` **生成的** `assets.rs` 里 —— 生成物不可单测，
于是它只以矩阵 §3.2.1 的**三行人工走查**存在（部署 SHA 一致 / exe 晚于素材 mtime / `whale_rows=7`）。

**改法**（判据搬到能跑测试的地方，生成物只留薄封装）：

- **手写** `src-tauri/src/asset_source.rs`：`Asset` / `Source` / `Resolved` / `Shadow` 类型 +
  `resolve()`（来源判定）+ `shadow_report()`（遮蔽报告）+ `shadow_summary()`（一行摘要）+ 逃生门
  `MIASAKI_ASSETS_SOURCE=embedded`（`OnceLock` 缓存 —— `read()` 会被每个素材各调一次）。
  **遮蔽的口径**：磁盘有 ∧ 内嵌有 ∧ **内容不同**；内容相同不算（同份副本），磁盘独有不算（那是新增）。
- **生成物** `src/assets.rs`：`pub use crate::asset_source::Asset;` + `read()`（**签名不变**，
  5 处调用点零改动）/ `read_with_source()` / `ui_dir()` / `disk_shadow_report()`。
- **`main.rs`**：asset-server 监听成功后打一行摘要；**无分裂则不写**（本仓有过 `pet.log` 1.32 行/秒
  持续 5 小时的教训，日志噪声本身就是问题）。
- **测试**：`cargo test` **109 → 117 例**（+8）。**测试自身踩的一坑已写进注释**：临时目录原用
  `std::env::temp_dir()`，**5 个用例一起挂在 `Os { code: 5, PermissionDenied }`**（该目录在本机
  cargo test 的运行环境里不可写）⇒ 改用在测试可执行文件所在目录（`target/**/deps/`，cargo 刚往那写产物）。

**当前实况（机器核对）**：部署目录 `C:\ProgramData\MiasakiApp\ui` 的 **139 个素材与仓库逐字节一致**
⇒ 新判据此刻应保持安静。矩阵 §3.2.1 新增第四行判据（「**有分裂必有行**」+ 反例验法），台账 E13 同步。

**2026-09-30（续四）· M4 锚点失配提示（静默失效 #10，appearance）**`[实测]`：用户第四次「继续」⇒
按建议排序取下一条。M4 的密度 / 最大宽度落在**官方内部 DOM 与 CSS 变量**上
（`[data-chat-flow]` / `--dsh-chat-content-width` / `--dsh-chat-flow-gap`）—— 官方升级改了锚点名时，
本插件**不报错、面板照常可点、保存也成功，但设置毫无效果**：用户只能说「开了没用」，
而面板看起来一切正常。

**判据只在能确定时说话**（把「会话还没有消息」误判成失配，是这类自检最常见的翻车方式）：
未开启依赖该锚点的项 ⇒ `idle`；会话页或 `[data-chat-flow]` 不在 ⇒ `unknown`；
锚点在、但**读不到我们写进去的覆盖值** ⇒ `mismatch` ⇒ 面板显式提示并点名。

**实现**：`probeConversationAnchors()` 纯读 DOM、**不引入 state**（面板 state 数不变，既有
「队列长度 = 8」的断言不受影响）；「会话效果」组的行数组提取为 `convRows` 后条件追加提示行，并
**保留 `conversation === null` 的短路语义** —— 这一点是刻意的：改成无条件数组字面量后，配置未加载时
会去读 `conversation.density` 而抛错、整面板空白（与 2026-09-12 那次空白面板事故同型）。
流式光标（`[data-streaming]` 仅生成中存在）与引用 / 代码块（原生标签）**不做静态自检**，文案里已说明。

**闸门**：`test/client.test.js` **23 → 27 例**（+4 覆盖三态）；夹具 `capture()` 增加**可选**的
`querySelector` / `getComputedStyle` 注入，默认行为不变（既有一律 `null` / 空串）⇒ 既有用例零改动。
`appearance` 仍 **18/18**。台账 D8 补「锚点失配提示」判据，§3.5 新增一行判据。

**2026-09-30（续五）·「无可见效果」补全为全量判定（静默失效 #8，appearance）**`[实测]`：
用户第五次「继续」⇒ 按建议排序取下一条。2026-09-27 那条提示只覆盖**一种**形状
（纯净皮 + 壁纸 + 表面全不透明 ⇒ 三层互相抵消），而有一条更常见的形态当时没覆盖：
**总开关开着、所有项都停在原生档** —— 页面上同样是零变化，却没有提示，用户只能以为功能坏了。

**判据从「某几项开着」换成「本线会不会产生任何可见变化」**：皮肤非纯净 / 壁纸源非空**且**至少一处
表面不透明度 < 100（否则被不透光表面盖住）/ 动效开着 / 会话效果有非默认档，任一成立即有变化；
否则按成因分两种文案（`native` 什么都没配 / `covered` 配了壁纸却看不见）。**玻璃档位不再参与判定** ——
它只改变壁纸的模糊观感，而壁纸不可见时它本身也不可见；首版把它算进去是把*解释性细节*与*判据*混在了一起，
同批移除对 `data-mia-native-mica` 广播的依赖。

**顺带修掉一处旧 host 白屏隐患（本次用例照出）**：会话效果组原本只判 `conversation === null`，
而旧 host（v5 前配置没有这个板块）给的是 `undefined` ⇒ 走进渲染后读 `conversation.density`
⇒ 整面板空白 —— 与 2026-09-12 空白面板事故**同族**，此前没有任何用例覆盖 undefined 形态。
现改为「**非对象即不在场**」（null / undefined / 坏值一律走提示分支），提示文案同时说明
「或宿主版本较旧（本板块需要 v6 配置）——重启宿主后重试」。

**闸门**：`test/client.test.js` **27 → 32 例**（+5），`appearance` 仍 **18/18**；
§3.05 的「遗留产品改进」注记同批核销，§3.5 新增判据行、台账 D2 / D8 补记。

**2026-09-30（续六）· 决策⑥落地：侧线创建后清掉继承来的 goal（sidebar，S9）**`[实测]`：用户第六次
「继续」⇒ 取下一条。这条在 M2 设计文档 §8 / S9 取证里早写了「建议做最小补偿」，**但一直没落地**
（内部计划的说法是「已拍板未落地」）。`fork` 是**零类型过滤**的日志前缀拷贝（官方 `buildForkSeed`），
goal / plan / todo / preset 全部带进 child（官方测试逐字断言
`inherits the completed-turn goal prefix through SessionStore.fork`）；不补偿的后果一是
**侧线显示并携带父目标**（用户以为侧线是干净新线，模型也可能接着做父任务的活 —— 正是 S8 复现的温床），
二是侧线内 `create_goal` 会因 `GOAL_ALREADY_EXISTS` 失败。

**实现**（`clearInheritedGoal(ctx, childId)`，决策放在**模块级**而非 apply 闭包 —— 判据必须可测）：官方 API
同款调用 `ctx.remote.goals.get(childId)` → `goals.clear(childId, { id, revision })`；**不 await**（补偿是附带
动作，绝不拖慢/拖死「新建侧线」，`childId` 原样返回）；**失败两档**：服务缺席 = 正常形态，静默返回；
服务在场而调用失败 ⇒ `console.warn` 留痕但**不外抛**。代价如实记账：child 日志留一条
`goal/change{operation:'clear'}` tombstone。**做不到的如实写明**：`plan` / `todo` 没有客户端 API
（内部计划原文即如此），写进注释与已知限制，不做假承诺。

**闸门**：`test/sidechat-registry.test.js` **13 → 19 例**（+6：调 clear 且参数含 id+revision /
child 无 goal 不调（含「有 revision 无 id」的残缺形态）/ 两种失败只留痕不外抛 / 服务缺席零告警 /
源码契约「不 await、不污染返回链路、必须是模块级函数」/ plan·todo 限制写明）。
`verify-all sidebar` 仍 **13/13**，**11 个测试文件合计 92 例全绿**（§1 表同步更新）。
台账补立 **C10**（此前「goals.clear 该调没调」在台账里没有编号）⇒ 分母 **103 → 104**。

**2026-09-30（续七）· P4 每板块「恢复默认」（appearance）**`[实测]`：用户第七次「继续」⇒ 取下一条。
路线里 P4 早就定形（官方 models `.linkButton` 形态、按板块重置），代码零命中。此前配置改乱了
只能手动逐项改回。

**默认值只有 host 一份**：`/state` 响应新增 `defaults`（= `lib/config.js` 的 `DEFAULT_CONFIG`）。
客户端**不另存一份** —— 两份默认值必然漂移，而漂移的后果恰恰是「恢复默认」把配置恢复成**旧版**默认值，
比不提供恢复更糟（用户以为回到了出厂态）。反向闸门直接钉在源码上：client.js 不得出现自造的
`DEFAULT_CONFIG` 形态，且必须读 `state.defaults`。

**三条路径**：板块已是默认 ⇒ 不渲染按钮；旧 host 不下发 defaults ⇒ 渲染「重启宿主后即可用」提示
（与 M2.7「host 未下发 avatar 字段给重启提示」同一处理，而不是静默失效）；其余 ⇒ 官方 `Button`
（ghost 次操作变体）走**既有 save 路径**（`POST /config` + `expectedRevision`）。语义上等价于
**整板块重置**：host 侧 `mergeConfig` 是板块级浅合并 + `sanitizeConfig` 收窄 ⇒ 旧版本残留字段被丢弃。

**过程中的两处自纠**（都写进注释，都是这类改动的典型坑）：
① `masterLive` / `resetRow` 首版定义在各组**之后**，而「主题」组先用到 ⇒ **TDZ 崩溃**（`node --check`
照出 `Identifier 'masterLive' has already been declared` —— 我移动定义时忘了删旧的那份）；
② 测试夹具 `nativeConfig` 的 `bootSplash: 'off'` 与出厂值 `'auto'` 不一致 ⇒「全原生档」被 P4 判成
非默认，**两个夹具就此不自洽**。

**闸门**：`test/client.test.js` **32 → 36 例**（+4：非默认必给入口且点击发出的是 host 下发的默认值 /
全默认时零按钮 / 旧 host 给提示 / 客户端不得硬编码默认值）。`appearance` 仍 **18/18**（host 测试
未被 `/state` 新字段破坏）。台账补立 **D15** ⇒ 分母 **104 → 105**，§1 用例数 132 → **136**。

**2026-09-30（续八）· P5 配置导入 / 导出（appearance）**`[实测]`：用户第八次「继续」⇒ 取下一条。
路线原文：「一段 JSON 下载/上传，sanitize 全量收窄后**整体替换**，导入前**二次确认**」。

**关键设计**：导入是**整体替换**而不是合并 —— 文件里没写的板块回到出厂默认。用 merge 的话，
「导入一份只写了主题的 JSON」会变成「只改主题」，与「导入配置」这个词的预期不符。host 侧
`POST /config` 新增 `replace: true` ⇒ `sanitizeConfig(raw)`；**非对象一律 400 显式拒绝**，
而不是让 sanitize 把它当空对象 ⇒ 静默清空配置。

**其余四条**：① 导出带自描述包装（`kind` / `version` / `exportedAt` / `config`，文件名带版本）；
② **二次确认**写明「没写的板块会回出厂默认」，**无法弹确认框时取消导入**（不静默继续）；
③ 四类坏输入（非 JSON / 顶层非对象 / 找不到配置对象 / 无法确认）一律**人话错误 + 零写入**；
④ 兼容**裸配置对象**（手写 JSON 可用）。导入复用既有 `save()`（只多一个 `replace: true` 报文位），
所以属性同步 / override 重算 / 三层应用等后处理完全共用，乐观并发同样生效。

**闸门**：`host.test.js` **18 → 24 例**（`defaults` 与 `config` 同源下发 / 整体替换确实打回出厂 /
非对象 400 且配置不动 / 409 冲突不写盘 / 内容等价 ⇒ `changed:false` / 越界与未知字段被收窄），
`client.test.js` **36 → 41 例**（导出报文与文件名 / 导入走 `replace:true` / **取消·无法确认·坏文件
三种零写入** / 四类人话错误 / 裸配置对象兼容）。`appearance` 仍 **18/18**。
台账补立 **D16** ⇒ 分母 **105 → 106**，§1 用例数 136 → **143**。

**过程中的一处自纠（值得记）**：我用 PowerShell 的 `Set-Content -Encoding UTF8` 改了两处文本，
**Windows PowerShell 5.1 会写 BOM** —— 立刻按字节复验才发现（`EF BB BF`），已用
`UTF8Encoding($false)` 写回。**结论**：改入库文本一律走编辑工具；非要用 shell，必须按字节验 BOM 与行尾。

**2026-09-30（续九）· 仓库级第 6 道闸门 `check-style.mjs`（文件形态 + 公开仓库脱敏）**`[实测]`：
用户第九次「继续」⇒ 治理层的最后一个大口子（`lint`/`format` 工具链缺失）。

**为什么不是 ESLint / Prettier**：本仓的硬约束是**零第三方依赖** + 插件零 shell 改动，引入格式化器
既加依赖、又会产生**巨量零语义 diff**（本仓明确记着「存量 17 处 CRLF 不批量转换，以免零语义 diff
淹没真实改动」）。所以落点是**一个仓库级闸门**，判据只取**能客观判定、且假阳性可控**的几条。

**判据四类**：① 无 BOM；② 只有 LF（无 CRLF）；③ 末行有换行；④ **脱敏** —— 两种形态：
**路径形态** `C:\Users\<段>\…`（含正斜杠）里必须是占位写法（`<…>` / `%…%` / `...` / `…`），
以及**裸词形态**（词表来自 `_refs/identity-terms.txt`，**本地、不入库**，`#` 注释；CI 没有该文件时
**显式打印「跳过裸词检查」**而不是静默）。**刻意不把维护者名字写进脚本本身** —— 那本身就违反脱敏纪律。
1–3 类**存量冻结**（BOM 10 / CRLF 17 / 无末行换行 27，共 54 条进 `scripts/style-baseline.json`，
条目消失报「可回收」）；**脱敏类刻意没有基线** —— 用户名泄漏不该有「存量」这一说，上线即零命中、
新增即失败。

**上线过程本身值两笔记录**：

- **闸门自身的假阳性**：首跑把桌面端 README 里的 `C:\Users\…\` 报成泄漏 —— 那是**合法占位**
  （Unicode 省略号 U+2026 表示「某个用户」），是我的占位判据只认 ASCII 的 `...`。已补齐四种占位形态。
  **闸门的假阳性比漏报更危险**：它让人把闸门关掉。
- **我先前的一个错误判断被自证纠正**：`grep` 扫到 fleet 归档 transcript 里 3 处 `C:\Users\<用户名>\…`，
  我一度判断为「脱敏那轮漏掉的入库文件」。**故障注入反而暴露了真相** —— 注入到那两个文件后闸门毫无反应，
  查 `.gitignore:98` 才知道它们**根本没入库**（是运行时产物），`grep` 扫的是工作区、不是入库集。
  所以：**入库文件零违规**；那 3 处与派单器的落盘脱敏仍做了（工作区产物顺手清理 + 生成器补口子，
  防的是「哪天有人把它们 un-ignore 或提交」）。

**故障注入自证**：往**入库**文件 `dispatch-task.ps1` 注入一行 `C:\Users\<探针名>\…` ⇒ 闸门 `exit 1`
并点名该文件；还原后复跑 PASS。另有脚本内的四类 fixture 自证 + 占位反例（不许误报）。

> **同日第三次自纠（这一笔最能说明闸门为什么值得有）**：写上面这段说明时，我**把真实用户名与探针名
> 原样写进了 `docs/ENGINEERING.md` 与回归矩阵** —— 闸门随即在**全量回归**里把这两处报了出来。
> 也就是说：**我在给「不许泄漏用户名」写文档时泄漏了用户名**，而机器在我提交前抓住了它。
> 教训两条：① 写「脱敏」相关说明时，示例一律用占位；② 这类检查必须**扫文档**，不能只扫代码。

**接线与基线**：`verify-all repo` **5 → 6 项**，全量 **173 → 174**。同批补上派单器的 transcript
脱敏（worker stdout 常带本机绝对路径，落盘前统一换 `%USERPROFILE%`）——否则下次派单就会写回来
（与 `scan-agents.ps1` 的 binPath 脱敏同一教训）。

**2026-09-30（fleet）· 派单器接线：把「已落地但停在可查询」的判定层接进在役执行路径**`[实测]`：
fleet 的四层判定里**只有 G2 能力闸门**（2026-09-11）真正接在 `dispatch-task.ps1` 上 ——
G0 写入入口、G1 任务图、G4 验证器都停在「Commander 可手工查询」。本轮接 G1 与 G0：

- **G1 可派闸门**：新增 `Test-DispatchableGate`，复用 `workers/graph/task-ready.mjs --explain <id> --json`
  （不重复实现）；`ready=false` → 打印**全部** reasons → 拒绝派单 exit 2；纳入 `-CheckOnly`。
  派单器此前**只判「档案 / 开关 / 预算 / 能力」，不判任务本身该不该派** —— 状态不是 queued、
  依赖未满足，两种情况都能一路派下去，且全程无提示。
- **assignee 一致性**：`-Agent` ≠ 台账 `assignee` → 拒绝并指向 `reassign` 补丁。G1 判的是**台账**里的
  assignee，而 `-Agent` 是另一个独立输入 —— 二者不等会「闸门通过、却派给了另一个人」。
- **G0 事件留痕**：`task.started`（CLI 启动**前** —— 进程崩了也留痕）+ 终态 `task.completed` /
  `failure.detected`（判据与 `final-state.ps1` 同源），经 `bus-apply` 唯一入口。
  **事件是审计不是闸门**（applier 报错只告警）。根治 `events.jsonl` 长期只有人工里程碑的一端。
- **冷启动降级**：`status.json` 是运行时产物（已 ignore），从未跑过的 agent 必然没有它
  ⇒ F3 判活给 `no-status` / `alive=false` ⇒ 照判会**硬拒首跑**（新 agent 永远派不出去）。
  故降级为告警放行；`running` 但心跳过龄仍是僵尸、照旧硬拒。两者靠 `--explain --json` 新增的
  结构化字段 `agent` 区分，**不靠 reasons 的字符串匹配**（v1 丢弃哪条仍按文案，已如实标注并成对钉住）。
- **`$env:BUS_ROOT = $Workspace`**：判定器与 applier 默认按自身文件位置推导根，与 `-Workspace`
  不一致时会出现「派单器读 A 工作区、判定器读 B 工作区」的静默错位；该对齐同时让夹具测试成为可能。

**真实闭环与独立复核（一个交付物同时承载两件事）**：派了真实任务 `t-0010`，任务内容**就是**
「由一个异构 agent 复核本次接线」（对抗立场 / 只读 / 每条结论必须带 `文件:行号`）。
首派 `claude` 失败 —— **不是 fleet 侧问题**：该 CLI 经 **ccswitch** 做模型路由，当时 ccswitch 未启动 ⇒
默认模型解析成不可用的 `step-5-preview[1m]`，接口返 404（`unrecognized_model`）；ccswitch 启动后**已实测恢复**
（`claude-sonnet-5[1M]`、exit 0）。这轮失败**恰好实证了失败分支**：
事件流 `task.started` → `failure.detected`、`status.json` 如实落 `error`；经 `reassign` 补丁改派 `pi` 后
exit 0 → `task.completed`，交付契约与台账终态**同一超步**（总线 v11）。`pi` 产出 **6 条 findings、无阻断级**：

| finding | 处置 |
|---|---|
| F2 CLI 起不来时 `$LASTEXITCODE` 滞留 0 ⇒ **假成功写进事件流** | ✅ 当批修复：spawn 前 `Get-Command $exe` 预检（记 127） |
| F3 只钉函数定义 ⇒ 删掉派单**主路径**调用点，全仓不会变红 | ✅ 当批修复：断言补**两处调用点**，并改为按文件精确匹配 |
| F4 注释/文档写「不靠字符串匹配」而实现按文案丢弃 | ✅ 当批修复：如实描述 v1 边界 + 两侧文案**成对**钉进闸门 |
| F1 崩溃残留 `status.json` ⇒ 永久硬拒该 agent 且无重置入口 | ⏸️ 待 Operator 裁决（既有缺口，本轮把它从显示问题升级为派单闸门输入） |
| F5 口径分歧只比 `enabled` / F6 台账坏行静默跳过 + stderr 被吞 | ⏸️ 下一批 |

**顺带暴露一处空文**：`tasks/<id>/result.json` 虽在 applier 白名单内，但**历史超步的 `paths` 里从未出现过它**
（t-0003 / t-0004 的契约都是直接写盘）⇒ 该路径的「唯一入口」纪律一直没被真跑过；t-0010 首次让它经唯一入口落盘。

**同日第二批 · 复核 findings 全部收口**：上面那次独立复核给出的 6 条 findings + 1 条附带发现（F7）已全部处置 ——
F2 / F3 / F4 第一批修复；第二批修的是 F1（新增 `-ResetStatus`：崩溃残留的 `status.json` 此前会让闸门**永久硬拒**
该 agent，而全仓没有任何恢复入口 —— 该开关**删除**残留而非写 `stopped`（判活对 `stopped` 同样给 `alive=false`），
且**心跳新鲜时拒绝执行**以免误删可能正在跑的档案，并在拒绝文案里给出可复制的命令）、
F5（预算那对双实现 `Get-DayCost` ↔ `dayCost` 此前完全没有纳入分歧比对）、
F6（台账坏行此前**静默跳过** ⇒ 判定可能建立在残缺台账上；现 `--explain --json` 带出 `bus_bad_lines`，
**有坏行即拒绝**并指向 `validate-bus`；判定器 stderr 仍被 `2>$null` 吞是**有意保留**——输出不可解析本身已判拒绝）、
F7（`final-state.ps1` 调用失败时此前回退成 `exitCode==0→idle`，会把一份 `status=blocked` 的契约记成
「健康空闲 + `task.completed`」；现保守记 `error`，且不复制判定逻辑以保持单点）。
夹具 **10 → 17 例**（含 `-ResetStatus` 六态：空操作 / 清残留 / 清除后闭环放行 / 心跳新鲜拒绝 / **`error` 不影响派单故拒绝清除** / `stopped` 允许清除）、接线断言 **12 → 20 项**。
**一处实现陷阱值得记**：判定「心跳新鲜」时，PS7 的 `ConvertFrom-Json` 会把 ISO-8601 字符串**自动转成 `[datetime]`**，
再 `[string]` 转换后 `[datetime]::Parse` 会按当前文化解析该字符串表示（本机 zh-CN 下实测把新鲜心跳判成「不新鲜」，
于是**误删了正在用的档案**）；修法是两条分支各取正确口径（已是 `DateTime` 直接转 UTC；字符串用
`DateTimeStyles::RoundtripKind` 按 ISO 解析）。
**对 B3 的重新判断**：`result.json` 的交付期**硬校验在派单器侧不成立** —— worker 在 headless 下不落盘、
交付契约由 Commander / 派单器**事后代写**，故「派单刚结束时没有 `result.json`」是**正常形态**；
K3 的台账驱动巡检已经是正确落点，派单器侧至多适合做提示 ⇒ **B3 建议降级或取消**。

**同日第三批 · G4 验证器挂载（判定层 → 派单路径）**：G4 的异构验证者选取此前只是 Commander「可查询」，
**高风险任务应挂而未挂时没有任何告警**（判定层落地时自陈的边界）。本批把它接进派单路径：
brief 声明 `risk:` / `需要验证：`（或 `-Risk`）即要求**可用**的异构验证者
（`verifier-pick --for --min-level --json`），**无可用候选直接拒绝派单**（比原计划的「告警」更强 ——
派单前判定本就是闸门位）；值非法即拒绝（**不猜**，`none` 自验属禁止项）；**未声明即跳过**（零行为变更）。
派单后生成 `tasks/<id>/verify-brief.md`（**不自动派发**验证任务 —— 那会引入新的任务生命周期，属独立议题）。
**两处判据细节值得记**：① 闸门判据是**可用候选数**而不是 `--for` 的退出码（`--all` 语义下候选可能全不可用）；
② **写用例时发现一处判定层不一致** —— G4 的可用性判据把 `alive=false` 判**不可用**，而「无 `status.json`」
在 `liveness.cjs` 里正是 `alive=false` ⇒ **从未运行过的 agent 不能被选为验证者**（与 G1 那次
「新 agent 永远派不出去」**同族**，只是换了判定层；G1 对同一形态是**降级放行**的）。本批边界是
「只接线、不动判定层」，故夹具里给同侪 agent 补心跳隔离它。
实测 `--for pi --min-level vendor` → bl / opencode 两个 vendor 级可用候选。夹具 17 → **23 例**（G4 六态）、
接线断言 20 → **26 项**。

**同日第四批 · 两层判活口径统一（「首跑豁免」收敛为单点）**：上一批写用例时实测发现一处
**同族形态复发** —— 「从未运行过（无 `status.json`）不算僵尸」这条口径，两个消费方**各自实现**且结论相反：
派单闸门（`dispatch-task.ps1` 冷启动降级）**放行**，验证者选取（`verifier.cjs` 的 `available` 看 `alive`）
**判不可用** ⇒ **从未运行过的 agent 永远当不了验证者**（与「新 agent 永远派不出去」同族，换了判定层）。
收敛方式：口径单点落在 `liveness.cjs` 的 `FIRST_RUN_STATE` + `isFirstRun`；
`verifier-pick.mjs` 的 agent meta 增 `firstRun` / `livenessState` —— **刻意不把 `alive` 折算成可用**
（那会让「alive」这个字段名说谎），由消费方显式看标记；`verifier.cjs` 的可用性判据加首跑豁免；
派单器以 `state -eq 'no-status'` 消费**同一状态字面量**。
**豁免刻意不外溢**：`unknown`（真僵尸）、开关未开启、`firstRun` 字段缺席（保守按非首跑）照旧不可用 ——
豁免必须是**显式事实**，不能靠默认。测试 `liveness` 7 → **9 例**、`verifier` 25 → **29 例**（+4 覆盖豁免与三条边界），
`verify-all` 加 **5 项口径断言**（单点函数 / 状态字面量 / 两个消费方 / 派单器同口径）。
**实测**：`--for pi --min-level vendor` 的候选由 2 个 → **3 个**（`claude` 因首跑标记被正确纳入）。

**接线与基线（第四批结束时）**：`verify-all fleet` **18 → 20 项**（+`dispatch 可派闸门接线` 纯文本断言
**26 项**、+`tests/dispatch-gate.test.mjs` 夹具 **23 例**）；全量 **178 项、十类全 PASS**。
用法与设计决策见 fleet README 与 `dsh-miasaki-fleet/docs/multi-agent-cli-orchestrator-design.md`（v0.25）；
规划与分档依据在 `_refs/fleet-dispatch-wiring-plan-2026-09-30.md`（规划类，按仓库纪律不入库）。

**同日第五批 · 判定层上屏（P1）**`[实测]`：总控制面板（`fleet-monitor/`）此前只有「在线数 / 任务数 / 成本」，
而判定层的事实**一条都没上屏** —— 尽管派单器早已按这些口径在判定。补三个**只读**端点 + 页面一块：

| 端点 | 内容 | 口径来源 |
|---|---|---|
| `GET /api/dispatchable` | 可派集 + **不可派原因** + 终态 | `task-ready.mjs --dispatchable --json` |
| `GET /api/gaps` | 能力断层（哪些能力只有归档 agent 提供） | `agent-pick.mjs --gaps --json` |
| `GET /api/events?limit=N` | 机器事件流尾部 | `state/graph-events.jsonl` |

**设计要点是「spawn 现成 CLI，不重复实现判定」** —— 面板显示什么，派单器就按什么判定（口径同源）；
端点是面板显示层的第三份消费者，另写一份判定必然漂移。两处判据细节：① 判定层 CLI 的**非零退出是正常语义**
（无可派任务时 exit 1，stdout 仍是合法 JSON）⇒ **先取 stdout 再解析**，不能拿退出码当失败；
② 判定层不可用时端点返回 `ok:false` 而**不让面板整页 500**。闸门 `fleet-monitor 判定层区块 (P1)` **7 项**
（区块 + 三个端点 + `runJudgement` 口径同源）。**尚未做**（P2 候选）：`/api/verifiers` 与设计 §8.4 的四条
告警规则（心跳丢失 / 预算 ≥80% / 任务硬超时 / 开关与进程不一致）—— **面板不告警就只是图表页**。
K1 的实机判据同日补立（回归矩阵 §3 K1）。

**同日第六批 · 写入收敛（B5）+ 二次独立复核（t-0011 / t-0012）**`[实测]`：口径从笼统的
「所有文件经唯一入口」改为**可判定的一条** ——「**真相进总线，派生态明确豁免**」：

- **`agents/<id>/usage.jsonl`（成本唯一原始来源）本批改经 applier**（白名单登记，仅允许 `append`），
  t-0011 实测在其 superstep 的 `paths` 里命中（总线 v20）。
- **失败语义「数据不丢优先」**：applier 失败 ⇒ 回退直写 + 告警（行内标 `[BUS_BYPASS]`、落
  `agents/<id>/logs/dispatch.log`，可 grep）；**但 partial 失败不回退** —— partial 意味「补丁可能已落盘」，
  再写一遍就是**成本双计**（这条由复核指出，属阻断级）。
- **`status.json` 明确豁免**，理由写进契约：真值在 `result.json` + 事件流；写频 **2 次/派单**、全仓无周期性
  心跳写者；归因收益低。**原「心跳风暴」论据经复核证伪后已撤回**并如实标注「事件流覆盖是有条件的
  （事件发射 best-effort）」—— 把推断当成现状写进契约，是这次复核抓到的最典型一处。
- **台账写者归属统一**：设计文档 **§4.5 的权责表为唯一定义**，消除 §2 / §5 / §7.0 的**四说**。

**复核产出与处置（t-0011，异构 agent / 对抗立场 / 只读）**：**2 条阻断 + 4 条建议全部当批处置** ——
阻断① **失败轮零计量**（usage 此前只在 `exitCode -eq 0` 时解析 ⇒ 失败轮「跑过但不记账」，与主协议 §9
「usage 是成本唯一原始来源」直接冲突）；阻断② **partial 失败回退 ⇒ 重复计量**（见上）。
建议里落地的是：终态事件补 `state`（否则 `blocked` 与 `error` 在事件流里不可分）、`-ResetStatus` 补
`agent.status.reset` 事件（**新增事件类型**，同步扩 `EVENT_TYPES` 与 schema enum）、「回退直写」的告警
不再只走控制台（此前 `logs/` 里查不到任何 `[usage]` 行 ⇒ 缺口的唯一记录不持久）。
**另修两个同族命令构造缺陷**：prompt 里的引号泄漏成 CLI 参数（实测 CLI 收到 `-A` / `20` 直接报错）；
`cmd:` 行的**成对引号**未剥离（缺它会把 `"process.exit(3)"` 字面量传给 node，JS 视其为合法字符串表达式
⇒ 命令**静默 exit 0 被记成成功**）。新增 `-ShowCommand`（打印将要执行的 argv，不派单不写盘），
与真实执行**共用** `Resolve-Argv`（各写一份必然漂移）。
**已知未收敛（登记在册，勿当成已完成）**：`agents/<id>/control.json`（fleet-monitor 的 `POST /api/toggle`
直写 —— 派单许可是**输入**不是派生态）、`agents/<id>/manifest.json` 与 `agents/registry.json`
（`scan-agents.ps1` 直写 —— 能力闸门的**实际输入**）；另 `capability.json` 虽在白名单内但**全仓零写者**。
**验收载体 t-0012**：用 `cmd:` 造一条**零成本必然失败**的轮次（`node -e "process.exit(3)"`，不调用任何模型），
验三条 —— 失败轮**仍新增一行**显式未计量行（`note` 注明本轮失败）/ 事件流 `failure.detected` 带
`state=error` / 派单器退出码为 3。可随时重跑。回归：`bus-contract` **23 → 26 例**、
`dispatch-gate` 夹具 **23 → 26 例**，可派闸门接线断言 **26 → 36 项**。

**当日最终基线（2026-09-30 收工）**`[实测]`：全量 **179 项、十类全 PASS** —— sidebar 13 / canvas 14 /
**fleet 21** / desktop 39 / ssh 31 / dual-model 15 / appearance 18 / usage 7 / free-model 15 / repo 6。
**Node v24.15.0 与 v22.19.0（CI 版本）各自实跑 179/179**，两条版本口径一致 ⇒ CI 应绿。
fleet **20 → 21**（+P1 面板判定层区块断言）；对照上一条「178 项」的差额即此项。

**同日第七件 · 口径对账（文档失真逐条订正）**：本轮收工前把「文档写的」与「实跑出来的」逐项对齐，
订正的**都不是本轮新引入的**，而是历史时点数字长期未跟上的形态（本仓最警惕的那类：注释/文档与实现不一致）：
可派闸门接线断言 **36 项**（文档曾写 12 / 20 / 26 / 31 四个值）、`dispatch-gate` 夹具 **26 例**（曾写 23）、
`bus-contract` **26 例**（曾写 23）、`bus-integration` **17 例**（曾写 13）、`fleet-monitor` **16 例**（曾写 11）、
fleet 全线用例 **177 例**（曾写 119 / 161）、dispatch 能力闸门断言 **7 项**（曾写 8 —— 实际脚本里就是 7 条，
写 8 从落地起就不成立）。根 README 的静态回归 **173 → 179**、回归矩阵 §3.0 分母 **106 → 109**
（C11 / C12 / F5 三项补立后未同步分母）。**教训与「迁移漏登记」同族**：数字类失真不会自己暴露，
**唯一可靠的订正方式是把每处数字重新实跑一遍**，而不是按上一次的记录顺手 +1。

**同日第八件 · 修掉一处「钦定复跑方式假红」**`[实测]`：用 `npx -y node@22.19.0 scripts/verify-all.mjs`
（CI 注释与本文档都推荐的「对齐 CI Node 版本」复跑方式）时，`fleet` **20/21** —— 唯一红的
`tests/dispatch-gate.test.mjs` 里全部「放行」用例挂在「判定器输出无法解析」。**根因不在 Node 版本**：
npx 的 `.bin` 目录里**只有 `node`（sh 脚本）/ `node.cmd` / `node.ps1`，没有 `node.exe`**，pwsh 的
`& node <判定器>` 命中 `node.ps1`，而该 shim 调向 `../node/bin/node`（Windows 下无扩展名、不是可执行文件）
⇒ **零输出** ⇒ 派单器（正确地）判「无法解析」并拒绝派单。修法是**测试侧**把 `process.execPath` 所在目录
**前置进子进程 PATH**（不改产品：生产环境 PATH 里是真 `node.exe`）。**CI 本身不会红**（`setup-node` 安装的
node 目录里是真 `node.exe`），但**这条要修的理由不是 CI**：一个「钦定的复跑方式」会稳定假红，下一步就是
**真红被当成假红略过** —— 那正是本仓 2026-09-26「CI 红 11 次没人看」的同族形态。

历史基线：2026-09-23（全量 96 项、desktop 20/20、`cargo test` 28 例——09-24 的 S4a 视觉闸门、桌宠资产闸门与 `dot.rs` 尚未入账）；2026-09-10（DSH 0.1.5-rc.1 / Node v24.15.0）sidebar 8/8、canvas 11/11、fleet 14/14、desktop 4/4、ssh 9/9、dual-model 10/10；2026-09-11 新增外观线 `appearance` 9/9（首次实机启动即暴露 `module is not defined` 整包加载失败，已修并补 client 半装载契约测试）。
需要真机或运行中 host 的实机项（插件加载 / 桌面壳冒烟 / 跨线联动）
不在脚本内，清单见 [统一回归矩阵](../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)。

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
pnpm test        # 86 例（审查 5 / 审查视图 10 / 目录分组 3 / 视图持久化 6 / 右栏引导 4 / 标题栏按钮 4 / 主视图会话取数 7 / 辅助对话登记表 13 / 终端启动器 7 / 内嵌终端 hub 15 / 路由 12）
# 开发模式：DSH profile 以 link 方式指向本目录，重启 dsh web + 刷新页面生效（client bundle 重启 host 生效）
```

## 文档

- 各线设计决策与变更记录：`dsh-miasaki-desktop/design/`、`dsh-miasaki-canvas/design/`、`dsh-miasaki-sidebar/design/`、`dsh-miasaki-appearance/design/`、`dsh-miasaki-usage/design/`、`dsh-miasaki-fleet/docs/`
- 跨线契约：`dsh-miasaki-shared-docs/cross/`；DSH 平台调研：`dsh-miasaki-shared-docs/dsh-platform/`
- 工作区纪律（缓存卫生 / 目录职责 / 提交纪律 / 会话收尾清单）由维护者以**本地 `AGENTS.md`** 维护，
  **不入库、不随 clone 分发**（已在 `.gitignore` 挡回）；仓库内可见的纪律以本文档与各线 README / `design/` 为准。

归档与外部产物（`_refs/`、`vendor/`、`dist/`、`.vs/` 等）已 gitignore，不入库。
