## DSH 插件：Token 用量监控（`plugins/dsh-token-monitor/`）

会话视图「对话 / 轨迹」右侧的第三 Tab **「用量」**（`conversation.view`，id `token-monitor`，
order 15）。UI 信息架构参考 ZCode 用量面板——**剩余视角优先**（上下文剩余、限额剩余），
已用数据退居次级；阈值 45 / 75 / 95% 三档变色（success → brand → warn → error）。

数据三通道：

- **官方持久聚合**（覆盖全会话日志、跨进程重启）：`sessionProjections` 的
  `tokenUsage`（未缓存输入 / 输出 / 缓存读 / 缓存写）、`contextPressure`
  （压力 / 投影 / 窗口）、`contextBreakdown`（系统 / 工具 / 消息）、`sessionStats`
  （轮次 / 步数 / 耗时），以及 `tokenMeter.measure` 的总口径。
- **实时明细**（进程启动起）：host 半监听 `llm/stream`（waterfall 透传包装，
  按 `sessionId|provider|model` 累计 provider 实报 `inputTokens / outputTokens /
  cacheReadTokens / reasoningTokens`）与 `tools/result`（按会话 × 工具名计数）。
- **跨会话账本**（插件首次部署起、跨 host 重启持久）：与实时明细同口径的增量
  按日累计，5s 节流追加写 `usage-log.jsonl`（进程退出兜底 flush；启动只载最近
  8 天，文件超 4MB 只解析尾部）；限额配置存 `config.json`。数据目录优先宿主
  插件数据目录服务，否则 `~/.dsh/plugins-data/dsh-token-monitor/`。

通信（host 半 **必须 `inject: ['webServer']` 声明等待**，否则插件行激活时
`ctx.get('webServer')` 可能尚不可用而静默跳过，表现为路由 404）：

- `GET /dsh-token-monitor/summary?sessionId=…`（webServer 精确路由）——官方聚合 +
  实时明细 + 账本（`ledger.today` / `ledger.trend` 近 7 天 / `ledger.since`）+ 限额
  配置，client 半 3 秒轮询；
- `GET|POST /dsh-token-monitor/config`——读取 / 设置 `{dailyTokenLimit: number|null}`
  （正数 ≤1e12 或 null；`{ok, error}` 包装对齐 dsh-free-model-pool）。

UI 区块（client 半手写 `window.__ModuleLoader__.load` bundle，无 JSX；主题令牌化
`--dsw-alias-*` 明暗自适应）：

1. **上下文剩余 hero**：大字号剩余百分比 + 全宽分段条（**分母 = contextWindow**，
   已用超窗时以已用和为分母、剩余归零）+ 未使用图例；无投影数据时占位。
2. **今日用量 · 全部会话**：账本当日累计大数字 + 输入/输出/缓存读分项；
   自定义日限额进度条（未设置时可就地设置：数字 + K/M 单位；已设置可编辑/清除）；
   近 7 天趋势迷你柱图（纯 CSS，今日柱品牌色高亮，悬浮出明细）。
3. 统计卡组（模型输出 / 缓存读写 / 官方累计 / 轮次步数）+ 性能小卡（TTFT /
   解码耗时 / 解码速度 / 模型与工具耗时）。
4. 按模型明细条形（输入/输出/缓存读/推理四段）、工具调用徽章、三通道口径脚注。

安装：同其它 profile bundle —— `%USERPROFILE%\.dsh\profiles\web\package.json` 的
`dependencies` + `dsh.profile.bundles` 加 `dsh-token-monitor`（file: 依赖），profile 目录
`pnpm install` 后 **host 重启**生效（web bundle 图重建；动态插件版本的重复注册已停止，
避免同 id Tab 冲突）。改动插件代码后同样需 profile 目录重跑 `pnpm install`（file: 依赖
为拷贝/硬链接时不会自动跟随源码）再重启 host。
