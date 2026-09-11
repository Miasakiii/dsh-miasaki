# dsh-miasaki

> Miasaki 专属 DSH（DeepSeek Harness）周边项目 monorepo —— 桌面端 / 多 Agent 编排 / 画布插件 / 右侧边栏 / SSH / 双模型 / 外观七条线，零耦合、单仓承载。

## 七条线

| 线 | 目录 | 定位与现状 |
|---|---|---|
| 桌面端 | [`dsh-miasaki-desktop/`](dsh-miasaki-desktop/) | Tauri 2 薄壳 + Win32 桌宠 + 三主题（pure / zafkiel / kurkuriel）+ Win11 Mica 一体；标题栏 v4 无壳裸键；四个 DSH web 插件：免费模型池、桌宠面板、用量监控（token-monitor v0.4.0）、会话日志下载入口迁移（dsh-session-log-move）。**不修改 DSH 本体**，令牌层覆盖实现，DSH 升级不受影响；唯一例外是 `patches/` 下的设置页模型能力补丁（规则 + 基线入库，可重建 / 校验 / 回退）。 |
| Fleet | [`dsh-miasaki-fleet/`](dsh-miasaki-fleet/) | 多 Agent CLI 编排（v0.16）：一个总指挥 + N 个 worker CLI，以文件总线为唯一协调通道——F1 总线校验 / F2 计量全源覆盖 / F3 心跳判活（worker 崩溃后不残留「僵尸 running」）/ X1 脉冲发布（与桌宠 A×B 联动）。 |
| Canvas | [`dsh-miasaki-canvas/`](dsh-miasaki-canvas/) | DSH web 画布插件 `@miasaki/dsh-canvas`（v0.5.0-miasaki.5，fork dsh-synapse）：「会话布」——可浏览 / 可分支 / 可合并的视觉会话工作区，含血缘侧栏、小地图、桌面端窗控与三主题品牌色适配。 |
| Sidebar | [`dsh-miasaki-sidebar/`](dsh-miasaki-sidebar/) | DSH web 轻量右侧边栏插件 `@miasaki/dsh-sidebar`（路线 D 无基座自研，2026-09-06 拍板）：右栏壳 + 审查 tab + 终端启动器（辅助对话 tab 归 M2）。**审查改版 + 浏览器式标签页已实机复验**（v0.5.0-miasaki.1，2026-09-09 浏览器环境）——四视图（未暂存 / 已暂存 / 全部分支更改 / 上一轮更改）、目录分组折叠、多标签 keep-mounted、持久化 v3（v2/v1 一次性迁移）全部通过；单测 46 项、四线静态回归 8/8。 |
| SSH | [`dsh-miasaki-ssh/`](dsh-miasaki-ssh/) | DSH web SSH 插件 `@miasaki/dsh-ssh`（全新自研，2026-09-09 立项）：**会话头第一行**「SSH」段（与「对话 / 会话布」同一个胶囊，三段一体）+ **画布页面内部**那组按钮旁的「SSH」（走 canvas 的外部视图槽）+ 页面内交互式连接云服务器。**M1 实现中：store/runtime/路由/WS/前端/单测（28 例）已完成并已 link 安装，待重启验证真实连接**（2026-09-10 入口由第二行 tab 栏迁到第一行并合成同一控件）——页面走 DSH 官方 `conversation.view` 插槽、入口走 `conversation.session.header.actions` 槽并委托官方 tab 切换，SSH 走 `ssh2` + `ws` + `xterm.js`，终端桥用官方 `webServer.registerUpgrade`，凭据只存 host 内存、三道浏览器围栏。 |
| 双模型 | [`dsh-miasaki-dual-model/`](dsh-miasaki-dual-model/) | DSH web 双模型插件 `@miasaki/dsh-dual-model`（2026-09-10 立项）：会话级「主模型 + 辅助模型」，只要其一支持图片即可上传图片，输入框右下角（`conversation.input.right`）快速配置。**M1 实现完成，待实机验证**——M0 六项技术假设实测全部成立；准入走一行本体补丁（可选服务探测，未装插件零退化，规则 + 双基线入库并可离线自证）；单测 24 例、`verify-all dual-model` 10/10。设计文档与变更记录见其 `design/`。 |
| 外观 | [`dsh-miasaki-appearance/`](dsh-miasaki-appearance/) | DSH web 外观插件 `@miasaki/dsh-appearance`（2026-09-11 立项）：设置里新增一栏**「外观」**，集中管理主题皮肤 / 壁纸 / 动效 / 会话效果。**M1 底座已实现，待重启 `dsh web` 实机验证**——走官方 `settings.section` 插槽 + `ctx.theme` 服务 + `webserver/index-inject` 首帧注入，**零 shell 改动、零第三方依赖**（配置自管 `~/.dsh/miasaki-appearance/config.json`）；总开关默认关闭、「关掉即原生」是硬契约；M1 含明暗/字号直通官方 API、契约自检、配置读写闭环；单测 29 例、`verify-all appearance` 8/8。 |
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
├─ AGENTS.md                # 工作区纪律（缓存卫生 / 目录职责 / 提交纪律 / 收尾清单）
└─ .gitignore               # _refs/ vendor/ dist/ .vs/ .workbuddy/ .learnings/ 等均已忽略
```

## 统一回归（七线）

> SSH 线 M1 代码已落地并有 28 例单测，外观线 M1 底座亦有 34 例单测，与其余线一并纳入统一回归；真实连接与实机外观验收仍属实机项。

```bash
node scripts/verify-all.mjs               # 七线全量（L0 静态检查 + L1 单线单测）
node scripts/verify-all.mjs appearance    # 只跑一条线（sidebar / canvas / fleet / desktop / ssh / dual-model / appearance）
```

2026-09-10 基线（DSH 0.1.5-rc.1 / Node v24.15.0）：sidebar 8/8、canvas 11/11、fleet 14/14、desktop 4/4、ssh 9/9、dual-model 10/10（**分母为检查项数**：syntax + 单测文件 + 补丁自证；如 ssh 的 9 项内含 28 例单测、canvas 的 11 项内含 89 例单测）。
2026-09-11 新增外观线：`appearance` **9/9**（5 项语法 + 4 个单测文件共 34 例；首次实机启动即暴露 `module is not defined` 整包加载失败，已修并补 client 半装载契约测试）。
desktop 项含 `cargo test`（5 项 Rust 单测，pulse stale 语义）与 `patch verify`（模型设置补丁离线自证，
由基线原始文件重建并与产物逐字节比对）——script 会在 `PATH` 外自动探测 `~/.cargo/bin/cargo`。
dual-model 项含 24 例单测与 `patch verify`（图片准入补丁离线自证）。
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
pnpm test        # 79 项回归测试
# 开发模式：DSH profile 以 link 方式指向本目录，重启 dsh web + 刷新页面生效
```

### Sidebar

```bash
cd dsh-miasaki-sidebar
pnpm install
pnpm run build   # node --check 两个入口文件（index.js / client.js）
pnpm test        # 46 项单测（审查 4 / 审查视图 6 / client 纯函数 10 / 终端 7 / 路由 10 / 抽屉手势 9）
# 开发模式：DSH profile 以 link 方式指向本目录，重启 dsh web + 刷新页面生效（client bundle 重启 host 生效）
```

## 文档

- 各线设计决策与变更记录：`dsh-miasaki-desktop/design/`、`dsh-miasaki-canvas/design/`、`dsh-miasaki-sidebar/design/`、`dsh-miasaki-appearance/design/`、`dsh-miasaki-fleet/docs/`
- 跨线契约：`dsh-miasaki-shared-docs/cross/`；DSH 平台调研：`dsh-miasaki-shared-docs/dsh-platform/`
- 工作区纪律（缓存卫生 / 目录职责 / 提交纪律 / 会话收尾清单）：[AGENTS.md](AGENTS.md)

归档与外部产物（`_refs/`、`vendor/`、`dist/`、`.vs/` 等）已 gitignore，不入库。
