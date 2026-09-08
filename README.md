# dsh-miasaki

> Miasaki 专属 DSH（DeepSeek Harness）周边项目 monorepo —— 桌面端 / 多 Agent 编排 / 画布插件 / 右侧边栏四条线，零耦合、单仓承载。

## 四条线

| 线 | 目录 | 定位与现状 |
|---|---|---|
| 桌面端 | [`dsh-miasaki-desktop/`](dsh-miasaki-desktop/) | Tauri 2 薄壳 + Win32 桌宠 + 三主题（pure / zafkiel / kurkuriel）+ Win11 Mica 一体；标题栏 v4 无壳裸键；四个 DSH web 插件：免费模型池、桌宠面板、用量监控（token-monitor v0.4.0）、会话日志下载入口迁移（dsh-session-log-move）。**不修改 DSH 本体**，令牌层覆盖实现，DSH 升级不受影响；唯一例外是 `patches/` 下的设置页模型能力补丁（规则 + 基线入库，可重建 / 校验 / 回退）。 |
| Fleet | [`dsh-miasaki-fleet/`](dsh-miasaki-fleet/) | 多 Agent CLI 编排（v0.16）：一个总指挥 + N 个 worker CLI，以文件总线为唯一协调通道——F1 总线校验 / F2 计量全源覆盖 / F3 心跳判活（worker 崩溃后不残留「僵尸 running」）/ X1 脉冲发布（与桌宠 A×B 联动）。 |
| Canvas | [`dsh-miasaki-canvas/`](dsh-miasaki-canvas/) | DSH web 画布插件 `@miasaki/dsh-canvas`（v0.5.0-miasaki.5，fork dsh-synapse）：「会话布」——可浏览 / 可分支 / 可合并的视觉会话工作区，含血缘侧栏、小地图、桌面端窗控与三主题品牌色适配。 |
| Sidebar | [`dsh-miasaki-sidebar/`](dsh-miasaki-sidebar/) | DSH web 轻量右侧边栏插件 `@miasaki/dsh-sidebar`（路线 D 无基座自研，2026-09-06 拍板）：右栏壳 + 审查 tab + 终端启动器（辅助对话 tab 归 M2）。**审查改版 + 浏览器式标签页已实机复验**（v0.5.0-miasaki.1，2026-09-09 浏览器环境）——四视图（未暂存 / 已暂存 / 全部分支更改 / 上一轮更改）、目录分组折叠、多标签 keep-mounted、持久化 v3（v2/v1 一次性迁移）全部通过；单测 46 项、四线静态回归 8/8。 |
| 共享参考 | [`dsh-miasaki-shared-docs/`](dsh-miasaki-shared-docs/) | `cross/` 跨线设计契约（如 A×B 桌宠↔fleet 联动、sidebar 路线讨论）、`dsh-platform/` DSH 平台调研与升级回归记录。 |

四条线代码零耦合，仅共享 `dsh-miasaki-shared-docs/`；跨线引用使用 `../dsh-miasaki-shared-docs/…` 相对路径（同仓 clone 后不断）。

## 仓库结构

```
dsh-miasaki/
├─ dsh-miasaki-desktop/     # 桌面端线（design/ 在其内；patches/ 为 DSH 运行时补丁：规则 + 基线 + CLI）
├─ dsh-miasaki-fleet/       # Fleet 线（agents / state / tasks / workers / fleet-monitor / docs / tests）
├─ dsh-miasaki-canvas/      # Canvas 线（design/ 在其内）
├─ dsh-miasaki-sidebar/     # Sidebar 线（design/ 在其内：路线 D 总设计 / CHANGELOG）
├─ dsh-miasaki-shared-docs/ # 跨线共享参考（含 cross/smoke-test-matrix.md 回归矩阵）
├─ scripts/verify-all.mjs   # 四线统一静态回归入口（L0 + L1）
├─ AGENTS.md                # 工作区纪律（缓存卫生 / 目录职责 / 提交纪律 / 收尾清单）
└─ .gitignore               # _refs/ vendor/ dist/ .vs/ .workbuddy/ .learnings/ 等均已忽略
```

## 统一回归（四线）

```bash
node scripts/verify-all.mjs            # 四线全量（L0 静态检查 + L1 单线单测）
node scripts/verify-all.mjs sidebar    # 只跑一条线（sidebar / canvas / fleet / desktop）
```

2026-09-09 基线（DSH 0.1.2-rc.1 / Node v24.15.0）：sidebar 8/8、canvas 9/9、fleet 5/5、desktop 4/4 全绿。
desktop 项含 `cargo test`（5 项 Rust 单测，pulse stale 语义）与 `patch verify`（模型设置补丁离线自证，
由基线原始文件重建并与产物逐字节比对）——script 会在 `PATH` 外自动探测 `~/.cargo/bin/cargo`。
需要真机或运行中 host 的实机项（插件加载 / 桌面壳冒烟 / 跨线联动）
不在脚本内，清单见 [四线统一回归矩阵](dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)。

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

- 各线设计决策与变更记录：`dsh-miasaki-desktop/design/`、`dsh-miasaki-canvas/design/`、`dsh-miasaki-sidebar/design/`、`dsh-miasaki-fleet/docs/`
- 跨线契约：`dsh-miasaki-shared-docs/cross/`；DSH 平台调研：`dsh-miasaki-shared-docs/dsh-platform/`
- 工作区纪律（缓存卫生 / 目录职责 / 提交纪律 / 会话收尾清单）：[AGENTS.md](AGENTS.md)

归档与外部产物（`_refs/`、`vendor/`、`dist/`、`.vs/` 等）已 gitignore，不入库。
