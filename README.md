# dsh-miasaki

> Miasaki 专属 DSH（DeepSeek Harness）周边项目 monorepo —— 桌面端 / 多 Agent 编排 / 画布插件 / 右侧边栏 / SSH / 双模型 / 外观七条线，零耦合、单仓承载。

## 七条线

| 线 | 目录 | 定位与现状 |
|---|---|---|
| 桌面端 | [`dsh-miasaki-desktop/`](dsh-miasaki-desktop/) | Tauri 2 薄壳 + Win32 桌宠 + 三主题（pure / zafkiel / kurkuriel）+ Win11 Mica 一体；标题栏 v4 无壳裸键；四个 DSH web 插件：免费模型池、桌宠面板、用量监控（token-monitor v0.4.0）、会话日志下载入口迁移（dsh-session-log-move）。**桌宠 v3 M2「真实工作状态」已落地（2026-09-12）**：六态 `PetState`（Idle/Thinking/Waiting/Error/Done/FleetBlocked）以**官方契约为主信号、DOM 扫描降级兜底**，Done 庆祝与出错气泡；主题 CSS 拆 `*.skin.css` / `*.deco.css`（供外观线消费，零行为变更）。**不修改 DSH 本体**，令牌层覆盖实现，DSH 升级不受影响；唯一例外是 `patches/` 下的五个运行时补丁（规则 + 基线入库，可重建 / 校验 / 回退）。 |
| Fleet | [`dsh-miasaki-fleet/`](dsh-miasaki-fleet/) | 多 Agent CLI 编排（v0.16）：一个总指挥 + N 个 worker CLI，以文件总线为唯一协调通道——F1 总线校验 / F2 计量全源覆盖 / F3 心跳判活（worker 崩溃后不残留「僵尸 running」）/ X1 脉冲发布（与桌宠 A×B 联动）/ G0–G4 图工程判定层（契约、图与就绪度、能力图、异构验证者选取）。 |
| Canvas | [`dsh-miasaki-canvas/`](dsh-miasaki-canvas/) | DSH web 画布插件 `@miasaki/dsh-canvas`（v0.5.0-miasaki.6，fork dsh-synapse）：「会话布」——可浏览 / 可分支 / 可合并的视觉会话工作区，含血缘侧栏、小地图、桌面端窗控与三主题品牌色适配。**2026-09-12 视觉与交互精细化 V1–V4**：令牌化圆润化（卡圆角 16px / 三级阴影）、连线端点与语义色、LOD 三档（full/compact/mini）、状态徽标统一——纯表现层，零 schema 变更、零新依赖。 |
| Sidebar | [`dsh-miasaki-sidebar/`](dsh-miasaki-sidebar/) | DSH web 侧边栏插件 `@miasaki/dsh-sidebar`（v0.8.1-miasaki.0）：**接入官方右侧 Sidebar**，提供审查 / 终端两个 tab 类型（辅助对话归 M2）。自研右栏壳已于 2026-09-10 退役、**2026-09-11 完成第二阶段清理**（壳代码删除 232 行）；**2026-09-12 内嵌终端两形态落地**——底部面板 + 右栏 tab 是**同一个 pty 会话的两个 viewer**（切换容器不丢状态），自持 node-pty 路线 B（零编译 prebuilds）、一次性 token 闸门、回放环 + 背压淘汰。单测 54 例、静态回归 10/10。 |
| SSH | [`dsh-miasaki-ssh/`](dsh-miasaki-ssh/) | DSH web SSH 插件 `@miasaki/dsh-ssh`（全新自研，2026-09-09 立项）：**会话头第一行**「SSH」段（与「对话 / 会话布」同一个胶囊，三段一体）+ **画布页面内部**那组按钮旁的「SSH」（走 canvas 的外部视图槽）+ 页面内交互式连接云服务器。**M1 代码完成，已 link 安装**；U0 可靠性闭环 + U1 统一工作区（2026-09-12）、A0 上下文桥（2026-09-14）、D1–D4 全屏浮层改造与**四轮真机验收**（2026-09-15）、**U2 主体落地**（2026-09-16：U2.1 多 shell / U2.3 工作区记忆 / U2.4 精确恢复）均已实施，单测 **110 例**、静态回归 12/12；U2.2 SFTP 与 U3（跳板 / 转发）未动，实机项待验收。 |
| 双模型 | [`dsh-miasaki-dual-model/`](dsh-miasaki-dual-model/) | DSH web 双模型插件 `@miasaki/dsh-dual-model`（2026-09-10 立项）：会话级「主模型 + 辅助模型」，只要其一支持图片即可上传图片，输入框右下角（`conversation.input.right`）快速配置。**M1 实现完成，待实机验证**——M0 六项技术假设实测全部成立；准入走一行本体补丁（可选服务探测，未装插件零退化，规则 + 双基线入库并可离线自证）；单测 24 例、`verify-all dual-model` 10/10。设计文档与变更记录见其 `design/`。 |
| 外观 | [`dsh-miasaki-appearance/`](dsh-miasaki-appearance/) | DSH web 外观插件 `@miasaki/dsh-appearance`（2026-09-11 立项）：设置里新增一栏**「外观」**，集中管理主题皮肤 / 壁纸 / 动效 / 会话效果。**M2 已收官（2026-09-12）**——M1 底座（设置栏 + 首帧注入 + 契约自检）实机六项全过后，S1–S6 依次落地 **皮肤层**（`derive-skins.mjs` 编译 105 token 表 + 首帧防闪色 boot style）、**壁纸与玻璃档位**（配置 v2、内置程序化渐变 + 本地图源、`color-mix` 表面透明度自动跟皮肤跟明暗）、**桌面壳让位协议**（`data-miasaki-theme-yield` 免刷新翻转、冲突自检）。走官方 `settings.section` 插槽 + `ctx.theme` 服务 + `webserver/index-inject`，**零 shell 改动、零第三方依赖**（配置自管 `~/.dsh/miasaki-appearance/config.json`）；总开关默认关闭、「关掉即原生」是硬契约。单测 60 例、静态回归 12/12；M3–M4 接动效与会话效果。 |
| 共享参考 | [`dsh-miasaki-shared-docs/`](dsh-miasaki-shared-docs/) | `cross/` 跨线设计契约（如 A×B 桌宠↔fleet 联动、sidebar 路线讨论）、`dsh-platform/` DSH 平台调研与升级回归记录。 |

七条线代码零耦合，仅共享 `dsh-miasaki-shared-docs/`；跨线引用使用 `../dsh-miasaki-shared-docs/…` 相对路径（同仓 clone 后不断）。

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
├─ dsh-miasaki-shared-docs/ # 跨线共享参考（含 cross/smoke-test-matrix.md 回归矩阵）
├─ scripts/verify-all.mjs   # 七线统一静态回归入口（L0 + L1）
└─ .gitignore               # _refs/ vendor/ dist/ .vs/ .workbuddy/ .learnings/ AGENTS.md 等均已忽略
```

## 统一回归（七线）

> 七线全部纳入统一回归；需要重启 host 或真机的实机项（插件加载 / 桌面壳冒烟 / 跨线联动）不在此脚本内。

**CI 已接入（2026-09-14）**：`.github/workflows/verify-all.yml` 在 `windows-latest` 上跑同一套回归
（push `main`/`master` + 任意 PR + 手动触发），使质量保证不再只依赖"维护者记得在本机跑一次"。
runner 自带 MSVC，因此本地 Git Bash 下 `cargo test` 的 `link.exe` 环境假阴性在 CI 中变成真信号。
CI 先装**三条有依赖的线**再跑闸门：sidebar 与 ssh 用 `pnpm install --frozen-lockfile`、
desktop 用 `npm ci --omit=dev`；canvas / fleet / dual-model / appearance 已核实零依赖、无需安装。
（依赖缺失的实测后果、Node 22.19.0 与 pnpm 11 的版本取舍、45 分钟超时的理由，均写在该文件头部注释里。）

> **EOL 纪律（2026-09-14 起）**：仓库用 `.gitattributes`（`* -text`）禁止一切换行符转换。本仓多项检查做
> **逐字节比对**（desktop/dual-model 的 `patch verify` 比 SHA、appearance 的 `derive-skins --check` 重算 token 表），
> CI 首跑正是因 `windows-latest` 默认 `core.autocrlf=true` 把 LF 转成 CRLF 而失败 8 项。
> `-text` 规则优先于本机 `core.autocrlf`，因此任何机器 checkout 出的字节都一致 —— 编辑文件时请勿引入 CRLF。

```bash
node scripts/verify-all.mjs               # 七线全量（L0 静态检查 + L1 单线单测）
node scripts/verify-all.mjs appearance    # 只跑一条线（sidebar / canvas / fleet / desktop / ssh / dual-model / appearance）
```

**2026-09-12 最新基线（全量 78 项检查）**：sidebar 9/10 ※、canvas 11/11、fleet 15/15、desktop 8/8、ssh 12/12、dual-model 10/10、appearance 12/12
（**分母为检查项数**：syntax + 单测文件 + 补丁自证；如 ssh 的 12 项内含 60 例单测、canvas 的 11 项内含 89 例单测、appearance 的 12 项内含 60 例单测、sidebar 的 10 项内含 54 例单测）。
desktop 项含 `cargo test`（10 例 Rust 单测，pulse stale 语义 + 立绘回落链）与 `patch verify` ×5（五个运行时补丁由基线原始文件重建并与产物逐字节比对）
——script 会在 `PATH` 外自动探测 `~/.cargo/bin/cargo`。dual-model 项含 24 例单测与 `patch verify`（图片准入补丁离线自证）。

> ※ **sidebar 的 `terminal-hub.test.js` 两条用例在受限沙箱下是环境假阴性**（2026-09-12 实测）：
> `resolvePtyBin` 用 `where.exe` 解析 shell 绝对路径并**捕获其输出**，而受限沙箱禁止管道捕获
> （`EPERM spawnSync where.exe EPERM`）⇒ 落入 catch 后抛「未安装或找不到 powershell.exe」。
> 判据：同一环境里 `where.exe powershell.exe` 以 `stdio: 'inherit'` 运行**退出码 0 且打印正确路径**
> （说明 PATH 里有、只是不能捕获）。**正确跑法**：在普通终端执行
> `node dsh-miasaki-sidebar/test/terminal-hub.test.js` → 应为 **7/7**（该线在真实环境下即 10/10）。

历史基线：2026-09-10（DSH 0.1.5-rc.1 / Node v24.15.0）sidebar 8/8、canvas 11/11、fleet 14/14、desktop 4/4、ssh 9/9、dual-model 10/10；2026-09-11 新增外观线 `appearance` 9/9（首次实机启动即暴露 `module is not defined` 整包加载失败，已修并补 client 半装载契约测试）。
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
pnpm test        # 54 项单测（审查 5 / 审查视图 10 / 目录分组 3 / 视图持久化 6 / 右栏引导 4 / 终端启动器 7 / 内嵌终端 7 / 路由 12）
# 开发模式：DSH profile 以 link 方式指向本目录，重启 dsh web + 刷新页面生效（client bundle 重启 host 生效）
```

## 文档

- 各线设计决策与变更记录：`dsh-miasaki-desktop/design/`、`dsh-miasaki-canvas/design/`、`dsh-miasaki-sidebar/design/`、`dsh-miasaki-appearance/design/`、`dsh-miasaki-fleet/docs/`
- 跨线契约：`dsh-miasaki-shared-docs/cross/`；DSH 平台调研：`dsh-miasaki-shared-docs/dsh-platform/`
- 工作区纪律（缓存卫生 / 目录职责 / 提交纪律 / 会话收尾清单）由维护者以**本地 `AGENTS.md`** 维护，
  **不入库、不随 clone 分发**（已在 `.gitignore` 挡回）；仓库内可见的纪律以本文档与各线 README / `design/` 为准。

归档与外部产物（`_refs/`、`vendor/`、`dist/`、`.vs/` 等）已 gitignore，不入库。
