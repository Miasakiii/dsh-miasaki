# @miasaki/dsh-token-monitor — 用量统计

> DSH（DeepSeek Harness）插件：**看清每个会话烧了多少 token**。

两个入口，一条信息架构：

- **会话内的一切** → 对话页的「**用量**」Tab（纯当前会话视角）；
- **跨会话的一切** → 侧栏脚部的「**用量统计**」入口 → 全局浮窗。

## 会话内：「用量」Tab

- **上下文剩余**：当前会话还能装多少；
- **官方聚合**：DSH 自己报的 token 用量；
- **实时明细**：按会话过滤的逐次调用；
- **活跃时长**：这个会话实际聊了多久。

## 全局：用量统计浮窗

| 板块 | 看什么 |
|---|---|
| **总览** | 六张卡：总量 / 调用次数 / 会话数 / 工具调用 / 缓存命中 / 日均 |
| **年热力图** | 一年里每天的消耗密度 |
| **使用趋势** | 近 30 天曲线，含按模型明细 |
| **模型用量** | 各模型占比与绝对量 |
| **会话活跃分布** | 哪些会话在烧（标题与工作目录折叠自会话日志，含近 30 日逐日分布） |
| **今日与限额** | 今日消耗 + 自设的每日 token 限额进度条 |

浮窗开启期间按 5 秒（总览）/ 60 秒（热力图）轮询，**关闭即停**。

## 安装

```bash
dsh plugin add @miasaki/dsh-token-monitor
```

装完**重启 DSH**并刷新页面。

**要求 DSH 0.1.7 及以上。**

## 为什么它可以单独装

这是本仓**唯一「纯官方契约、零 miasaki 耦合」**的插件：

- host 半只用官方 `webServer` 服务 + `llm/stream` / `tools/result` 事件 +
  `sessionProjections` / `tokenMeter` / `sessionQuery` 投影；
- client 半只用官方三个槽位（`conversation.view` / `sidebar.footer.action` / `shell.overlay`）；
- **不碰主题、不碰桌面壳补丁、不依赖任何其它 miasaki 插件**。

所以它可以单独装进**任意官方 DSH profile**（官方桌面端隔离成纯净版之后，挂的就是这一条）。

## 账本

数据落在 `~/.dsh/plugins-data/dsh-token-monitor/`，**按 profile 分区**：

```
dsh-token-monitor/
├── desktop/usage-log.jsonl   # 官方桌面端只记官方自己的消耗
├── miasaki/usage-log.jsonl   # 自制壳
└── web/usage-log.jsonl       # 浏览器 GUI
```

**「统计要干净」**：官方桌面端的「今日用量 / 热力图 / 趋势 / 模型占比」里不会混进自制环境或浏览器调试的消耗。
分区之前三个 profile 混写同一个 `usage-log.jsonl`，这正是要修的东西。

> **目录名不跟随包名**（`dsh-token-monitor`，而非 `@miasaki/dsh-token-monitor`）——
> 目录名是**数据身份**：跟着包名改，等于让既有账本「搬家」、历史统计凭空清零。

## 边界

- 不改系统提示、不改模型请求、不改工具 schema；
- 插件不直接调模型：数字全部来自官方投影与事件；
- 账本只记计数与归属，不记对话内容。

## 开发

```bash
pnpm test  # 无第三方依赖；闸门见下方
```

仓库级统一回归：`node ../scripts/verify-all.mjs usage`（语法 + client bundle 装载契约自检）。

设计决策与逐条变更见 [`design/`](design/)。
