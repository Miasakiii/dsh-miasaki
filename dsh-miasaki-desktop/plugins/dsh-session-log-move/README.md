## DSH 插件：会话日志下载入口迁移（`plugins/dsh-session-log-move/`）

DSH web bundle。把「Session 日志」下载按钮从**主界面会话头部**迁移到**轨迹页工具栏搜索栏左侧**。

| 项 | 值 |
|---|---|
| 服务 id | `dsh-session-log-move` |
| 平台 | client only（web） |
| host 半 | 无职责（空壳） |
| 依赖服务 | `slots`、`timer`、`sessions`（client 端） |

### 行为

1. **主界面隐藏**：向 `conversation.session.header.utilities` 注册同 id
   `session-log-download` 空条目 —— 平台 slot 语义”同 id 复用即替换该 cell”，
   官方「Session 日志」胶囊按钮不再渲染；插件停用后官方按钮自动恢复。
2. **轨迹页注入**：在 `[role="toolbar"]` 内 `input[type="search"]` 的容器
   **左侧**插入同功能「Session 日志」按钮（toolbar 无官方 slot，采用 DOM 注入：
   `MutationObserver` 跟随挂载/卸载 + 500ms 重试兜底约 30s，React 重渲染冲掉后自动补挂）。
3. **下载链路**：优先复用官方 client 服务 `sessionLogDownload.download(sessionId)`
   （自带按会话去重）；服务不可用时降级为 `<a download>` 直接触发
   `/api/session.export?sessionId=…&includeDescendants=true`（浏览器流式下载，
   不经 fetch）。
4. **反馈**：按钮内联文案 —— 准备中… / 已开始下载 / 下载失败，重试，随后自动复位。

### 安装

同其它 profile bundle —— `%USERPROFILE%\.dsh\profiles\web\package.json` 的
`dependencies` + `dsh.profile.bundles` 加 `dsh-session-log-move`（file: 依赖），
profile 目录 `pnpm install` 后 **host 重启**生效（web bundle 图重建）。

改动源码后按 token-monitor 的同步顺序：
file: 依赖在 profile 顶层 node_modules 是普通拷贝 —— 小改动直接 `cp` 覆盖顶层对应
文件（或删顶层目录再 `pnpm install`），**落盘完成后再重启 host**，避免新旧混搭。

### 文件

- `lib/client.js` — 全部逻辑（替换 + 注入 + 下载 + 反馈）
- `lib/index.js` / `lib/index.d.ts` — host 空壳与类型
- `cordis.patch.yml` — bundle 挂载声明