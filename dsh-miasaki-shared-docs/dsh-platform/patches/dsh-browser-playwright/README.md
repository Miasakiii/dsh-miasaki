# `@yeesy369/dsh-browser-playwright` 兼容补丁（已迁移，历史入口）

> **2026-10-17：本补丁已迁移到桌面端线的补丁目录**
> [`dsh-miasaki-desktop/patches/dsh-browser-playwright/`](../../../../dsh-miasaki-desktop/patches/dsh-browser-playwright/README.md)。
>
> 依据仓库纪律「DSH 运行时补丁唯一住处 = `dsh-miasaki-desktop/patches/`」，这里不再保留
> 可执行补丁与基线：`patch.mjs`（40 KB，含 verify / status / apply / revert / freeze /
> rebuild-baseline 六个命令与 32 项双世界断言）连同 `baseline/` 四个文件已整体迁移，
> **字节与 SHA 常量未变**（迁移当天 `node patch.mjs verify` 全绿），并首次接入
> `scripts/verify-all.mjs` 的 desktop 回归（此前只有 `patch-live-audit.mjs` 的 live 审计）。
>
> 本文件保留为历史入口：2026-09-23 的 0.1.7 升级评估、2026-09-25 的 rc.2 评估、
> 2026-09-26 的 miasaki 复发记录等文档里指向本目录的链接仍可打开。补丁的完整背景、
> 0.1.7 契约细节、双轨机制与用法见新位置的 README。

## 决策背景（原文保留）

2026-09-23 本机 DSH 升到 0.1.7-alpha.2 后，web UI 停在启动屏：

```
HARNESS
Failed to load plugins
web boot: 1 entry did not activate
@yeesy369/dsh-browser-playwright: pending (waiting for service: settingsScope)
```

根因是 0.1.7 重写设置机制，该插件 host / client 两半各自踩雷：

- **client 半**（`lib/client.js`）：`inject` 里的 `settingsScope` 服务被移除 → cordis 纤维
  永远 pending；而 web 前端 boot loader 对任何非 active 的 client 条目**直接抛错停启动屏**，
  于是整个 web UI 打不开。替代服务是 `configForms`（写路径变批量 `mutate(ops)`，卡片槽从
  `settings.plugin.item` 迁到 `plugins.item`）。
- **host 半**（`lib/index.js`）：`settings.register(...)` 被移除 → `apply` 抛
  `TypeError`，provider 纤维失败、`ctx.browser` 不 provide → `@yeesy369/dsh-tool-browser`
  整条 pending（浏览器工具全灭）。

补丁把两半都改成**双轨**（0.1.7 新路 / ≤0.1.6 老路，缺服务安静降级不崩），上游作者直到
2026-10-17 仍未发兼容版（npm `latest` 仍是 0.8.1）。

**2026-09-26 二次复发**：`miasaki` profile 在重装依赖时冲掉了两半补丁，而当时的探测只认
`web` 一个 profile ⇒ 桌面端一开就停在上面那张启动屏。处置：探测改为遍历所有装了该插件的
profile，并把两个 profile 都重打到位。

## 迁移后的操作入口

```powershell
cd dsh-miasaki-desktop/patches/dsh-browser-playwright
node patch.mjs verify   # 离线自证（已并入 verify-all desktop）
node patch.mjs status   # 遍历所有 profile 的 patched / original / unknown
node patch.mjs apply    # 备份 + 应用（幂等）
node patch.mjs revert   # 从 .dsh-bak 还原
```

本目录随迁移**只保留说明，不保留代码**；若在新位置找不到对应文件，说明补丁已被上游兼容版
取代并退役（见新位置 README「作者发兼容版后」一节）。
