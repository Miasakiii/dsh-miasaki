## DSH 插件：会话日志下载入口迁移（`plugins/dsh-session-log-move/`）

DSH web bundle。把「Session 日志」下载按钮从**主界面会话头部**迁移到**轨迹页工具栏搜索栏左侧**。

| 项 | 值 |
|---|---|
| 服务 id | `dsh-session-log-move` |
| 平台 | client only（web） |
| host 半 | 无职责（空壳） |
| 依赖服务 | `timer`、`sessions`（client 端；`slots` 自 v0.1.2 起不再注入） |

### 行为

1. **主界面隐藏**（尽力而为、可逆）：DOM 层把 `button[class*="sessionLogButton"]` 置
   `display:none`（子串锚点，对 CSS hash 漂移稳健），卸载时由 disposer 还原 display，
   官方按钮复现。DSH 0.1.7-rc.2 起官方已把该入口收进会话头「**更多操作 ⋯**」菜单，
   头部不再有「Session 日志」胶囊（该锚点在 0.1.7 全库零命中）⇒ 本项退化为对旧版 DSH 的
   **无害兜底**，本插件当前的有效职责是**轨迹页注入**（见 2）。
   > **2026-10-05 更正**：本项此前写的是「向 `conversation.session.header.utilities` 注册同 id
   > `session-log-download` 空条目做替换」—— **该 slot 路线 2026-09-26（v0.1.2）已整体删除，
   > 不再是当前态**：自 DSH 0.1.5-rc.1 起官方包 `@deepseek-ai/dsh-session-log-export` 已自行
   > 注册同一 id，本插件的替换永远冲突；且 0.1.7 的槽声明是多级异步链（`apply` 时同步
   > register 必然抢跑），重试也不可能成功，只会留下 `slot … is not declared` 的启动噪声
   > （历史上 60 次重试全部 console.error，加载后 30s 持续刷屏，已随本次清理消除）。
   > 同批一并回退了 `dsh.client.inject` 的弯路。
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
`dependencies` + `dsh.profile.bundles` 加 `dsh-session-log-move`，**依赖声明用 `link:`**，
profile 目录 `pnpm install` 后 **host 重启**生效（web bundle 图重建）。

> **2026-10-05 更正**：本段此前写「`file:` 依赖」+「改完源码要 `cp` 覆盖顶层文件」。
> `file:` 会把包**复制**进 profile 的 `node_modules` —— 那是快照、**不跟源码**，
> 于是「改了代码、重启也不生效」且**不报任何错**（最费时间的一种）。
> 全线已于 2026-09-29 统一改 `link:`；本机 `web` / `miasaki` 两个 profile 实测
> `node_modules/dsh-session-log-move` 均为 `LinkType=Junction` → 指向仓内源码。
> **改完源码只需重启 host，不要再 `cp`。**

### 文件

- `lib/client.js` — 全部逻辑（隐藏 + 注入 + 下载 + 反馈）
- `lib/index.js` / `lib/index.d.ts` — host 空壳与类型
- `cordis.patch.yml` — bundle 挂载声明