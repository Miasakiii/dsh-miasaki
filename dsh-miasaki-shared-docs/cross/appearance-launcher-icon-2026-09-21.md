# A×B 联动契约：软件头像 → 启动器图标（实施记录，2026-09-21）

前文：`../dsh-platform/` 的插件线约定、appearance 线
`dsh-miasaki-appearance/design/2026-09-21-appearance-avatar-launcher-design.md`（设计取舍）。

本文是 **appearance（web 插件，出配置与图片）× desktop（Miasaki.exe 启动器，消费）** 的
唯一文件接口契约。两端实现在不同语言（JS / Rust）里，**改任一侧都必须同步另一侧**。

## 契约（唯一 A×B 文件接口）

### 1. 配置

路径：`<dshHome>/miasaki-appearance/config.json`（外观线的 `dataDir`，运行时产物，不入库）。
`<dshHome>` 口径与官方 `@deepseek-ai/dsh-home-paths` 一致：非空白 `$DSH_HOME` 优先，否则 `~/.dsh`。

```json
{
  "version": 3,
  "enabled": false,
  "avatar": { "source": "/appearance/avatar/avatar-lz3k9q-4f2a1b.png" }
}
```

- 只有 `avatar.source` 是跨线字段，其余字段（theme / wallpaper / motion / conversation）
  与桌面壳无关；
- `avatar.source` 取值：**空串 = 不设置**（桌面壳用出厂图标）；否则必须是
  `/appearance/avatar/<文件名>`，文件名匹配 `^[\w][\w.-]{0,80}\.png$`（大小写不敏感）。
- 配置版本 `version` 由 appearance 线单方面管理；桌面壳**不校验版本号**，
  只按字段读取（缺字段 = 不设置），因此升版本不会打断桌面壳。

### 2. 图片

目录：`<dshHome>/miasaki-appearance/avatars/`；格式：**PNG**（只支持 PNG）。

- 由面板上传的文件名由 host 生成：`avatar-<unix-ms base36>-<6 位随机 hex>.png`；
- 也允许用户手动放入符合文件名白名单的 PNG，面板清单会列出；
- 桌面壳**只读这个目录**，绝不联网取图（`source` 是 http(s) 外链时整条作废）。

### 3. 语义

| 项 | 约定 |
|---|---|
| 生效条件 | `avatar.source` 非空且文件存在且能解码；**与外观总开关 `enabled` 无关** |
| 生效面 | 主窗口图标（任务栏随之）、托盘图标 |
| 生效时机 | 桌面壳 1.5s 巡检；配置或图片（文件名 / mtime / 大小）变化后 1–2 秒内跟随 |
| 不生效面 | EXE 内嵌图标、快捷方式静态图标、favicon / PWA 图标（见设计文档 §6） |
| 失败姿态 | 配置损坏 / 文件缺失 / 解码失败 → 一行日志 + 回退出厂图标，**绝不阻断启动** |
| 图片归一化 | 壳侧中心裁方（图标必须方的）+ 超过 256px 时盒式降采样 |

## 两端实现位置

| 侧 | 文件 | 职责 |
|---|---|---|
| A（appearance） | `dsh-miasaki-appearance/lib/avatar.js` | 契约的**定义**：PNG 魔数、文件名白名单、`avatarFileFromSource` |
| A | `dsh-miasaki-appearance/lib/config.js` | `avatar.source` 收窄（只放行本线路由下的白名单文件） |
| A | `dsh-miasaki-appearance/index.js` | 上传 / 清单 / 文件路由 + 落盘 |
| A | `dsh-miasaki-appearance/client.js` | 面板 UI、canvas 归一化（PNG ≤512）、启用 |
| B（desktop） | `dsh-miasaki-desktop/src-tauri/src/launcher_icon.rs` | 契约的**消费**：dshHome 解析、白名单复刻、PNG → 方形 RGBA、set_icon + 巡检 |

两侧的白名单与路由前缀**都是硬编码常量**（JS 正则 / Rust 手写判定），并各有单测钉死同一组
样本（`dsh-miasaki-appearance/test/avatar.test.js` 与 `launcher_icon.rs::tests`）——
这是刻意的重复：让「契约漂移」在两侧各自的测试里都能被抓住，而不是靠人情记得同步。

## 变更流程

1. 改契约 → 先改 A 侧 `lib/avatar.js` 与本文档，再改 B 侧 `launcher_icon.rs`（反之亦然）；
2. 两侧各自的单测样本表必须同步扩项（新增/删除的合法与非法样本）；
3. 两侧 CHANGELOG 各记一条，并在条目里互相点名（本仓跨线改动的既有做法）；
4. 实机验收：见设计文档 §7（上传 → 任务栏图标跟随 → 清除回退）。

## 验收记录

- 2026-09-21：A 侧 79 例单测、B 侧 25 例 `cargo test` 全绿（契约样本两侧一致）；
- 实机（上传 → 任务栏 / 窗口 / 托盘图标跟随）**待用户重启 `dsh web` 与桌面壳后验收**。
