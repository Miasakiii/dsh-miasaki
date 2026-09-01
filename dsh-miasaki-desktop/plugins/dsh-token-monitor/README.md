## DSH 插件：Token 用量监控（`plugins/dsh-token-monitor/`）

会话视图「对话 / 轨迹」右侧的第三 Tab **「用量」**（`conversation.view`，id `token-monitor`，
order 15），实时监控本会话的 token 消耗：

- **官方持久聚合**（覆盖全会话日志、跨进程重启）：`sessionProjections` 的
  `tokenUsage`（未缓存输入 / 输出 / 缓存读 / 缓存写）、`contextPressure`
  （压力 / 投影 / 窗口）、`contextBreakdown`（系统 / 工具 / 消息）、`sessionStats`
  （轮次 / 步数 / 耗时），以及 `tokenMeter.measure` 的总口径。
- **实时明细**（进程启动起）：host 半监听 `llm/stream`（waterfall 透传包装，
  按 `sessionId|provider|model` 累计 provider 实报 `inputTokens / outputTokens /
  cacheReadTokens / reasoningTokens`）与 `tools/result`（按会话 × 工具名计数）。
- **通信**：host 半 **必须 `inject: ['webServer']` 声明等待**（插件行激活时
  `ctx.get('webServer')` 可能尚不可用而静默跳过，表现为路由 404），
  经 `webServer.register`（`kind: 'exact'`）暴露
  `GET /dsh-token-monitor/summary?sessionId=…` JSON 路由；client 半（手写
  `window.__ModuleLoader__.load` bundle，无 `host.call`）同源 `fetch` 每 3 秒拉取。
- **UI**：主题令牌化（`--dsw-alias-*` 明暗自适应）：顶部四统计卡、上下文构成堆叠条、
  按模型明细条形（输入/输出/缓存读/推理四段）、工具徽章、性能小卡、口径说明。

安装：同其它 profile bundle —— `%USERPROFILE%\.dsh\profiles\web\package.json` 的
`dependencies` + `dsh.profile.bundles` 加 `dsh-token-monitor`（file: 依赖），profile 目录
`pnpm install` 后 **host 重启**生效（web bundle 图重建；动态插件版本的重复注册已停止，
避免同 id Tab冲突）。
