# dsh-miasaki

Miasaki 专属 DSH（DeepSeek Harness）周边项目 monorepo：单一 git 仓承载三条互不耦合的线 + 共享参考。

| 线 | 目录 | 定位 |
|---|---|---|
| 桌面端 | [`dsh-miasaki-desktop/`](dsh-miasaki-desktop/) | Tauri 2 薄壳 + Win32 桌宠 + 三主题 + 三个 DSH web 插件（免费模型池 / 桌宠面板 / 用量监控） |
| Fleet | [`dsh-miasaki-fleet/`](dsh-miasaki-fleet/) | 多 Agent CLI 编排（文件总线：发现 → 开关 → 派单 → 计量 → 监控） |
| Canvas | [`dsh-miasaki-canvas/`](dsh-miasaki-canvas/) | DSH web 画布插件 `@miasaki/dsh-canvas`（会话布：可浏览 / 可分支 / 可合并） |
| 共享参考 | [`dsh-miasaki-shared-docs/`](dsh-miasaki-shared-docs/) | `cross/` 跨线设计契约（如 A×B 桌宠↔fleet 联动）、`dsh-platform/` DSH 平台调研 |

- 三条线代码零耦合，仅共享 `dsh-miasaki-shared-docs/`。
- 工作区纪律（缓存卫生 / 目录职责 / 提交纪律）见 [AGENTS.md](AGENTS.md)。
- 归档与外部产物（`_refs/`、`vendor/`、`dist/` 等）已 ignore，不入库。
