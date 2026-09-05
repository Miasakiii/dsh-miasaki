## DSH 插件：Token 用量监控（`plugins/dsh-token-monitor/`）

会话视图「对话 / 轨迹」右侧的第三 Tab **「用量」**（`conversation.view`，id `token-monitor`，
order 15）。UI 信息架构参考 ZCode 用量面板：总览统计与可视化优先（热力图 / 趋势 /
占比），会话级剩余视角（上下文 / 限额）居次；阈值 45 / 75 / 95% 三档变色
（success → brand → warn → error）。

数据三通道：

- **官方持久聚合**（覆盖全会话日志、跨进程重启）：`sessionProjections` 的
  `tokenUsage`（未缓存输入 / 输出 / 缓存读 / 缓存写）、`contextPressure`
  （压力 / 投影 / 窗口）、`contextBreakdown`（系统 / 工具 / 消息）、`sessionStats`
  （轮次 / 步数 / 耗时），以及 `tokenMeter.measure` 的总口径。
- **实时明细**（进程启动起）：host 半监听 `llm/stream`（waterfall 透传包装，
  按 `sessionId|provider|model` 累计 provider 实报 `inputTokens / outputTokens /
  cacheReadTokens / reasoningTokens`）与 `tools/result`（按会话 × 工具名计数）。
- **跨会话账本**（插件首次部署起、跨 host 重启持久，可视化与总览统计的数据源）：
  与实时明细同口径的增量按日累计，5s 节流追加写 `usage-log.jsonl`（进程退出兜底
  flush；保留 **380 天**，启动只载窗口内尾部、文件超 8MB 只解析尾 8MB）；条目另带
  `calls`（当日实报次数 ≈ 轮消息）与 `type:'span'` 会话活跃跨度快照（min first /
  max last 合并，推进 ≥60s 才落盘，支撑「最长聊天时长」）。限额配置存 `config.json`。
  数据目录优先宿主插件数据目录服务，否则 `~/.dsh/plugins-data/dsh-token-monitor/`。

通信（host 半 **必须 `inject: ['webServer']` 声明等待**，否则插件行激活时
`ctx.get('webServer')` 可能尚不可用而静默跳过，表现为路由 404）：

- `GET /dsh-token-monitor/summary?sessionId=…`（webServer 精确路由）——官方聚合 +
  实时明细 + 账本（`ledger.today` / `ledger.trend` 近 30 天含按模型明细 /
  `ledger.since`）+ 总览统计 `stats`（累计 tokens、单日峰值、最长聊天时长、当前 /
  最长连续天数、活跃天数）+ 限额配置，client 半 3 秒轮询；
- `GET /dsh-token-monitor/heatmap`——稀疏每日账单 `{date, total, calls}`（热力图
  数据源，仅含有活动的日子，空日由客户端按日历补齐），client 半 60 秒轮询；
- `GET|POST /dsh-token-monitor/config`——读取 / 设置 `{dailyTokenLimit: number|null}`
  （正数 ≤1e12 或 null；`{ok, error}` 包装对齐 dsh-free-model-pool）；
- `POST /dsh-token-monitor/reset`——清空跨会话账本（内存聚合 + `usage-log.jsonl`，
  限额配置保留，不可恢复）。启动载入磁盘存量只进内存聚合、绝不回写（回写会使
  账本每重启翻倍，v0.3.1 修复）；历史失真数据用此路由（或 UI「重置账本」按钮）清零重计。

UI 区块（client 半手写 `window.__ModuleLoader__.load` bundle，无 JSX、无图表依赖，
趋势/环形为手写 SVG，热力图为 CSS grid；主题令牌化 `--dsw-alias-*` 明暗自适应）：

1. **总览五卡**（ZCode 头部统计行同构）：累计 Token 数 / 峰值 Token 数（单日）/
   最长聊天时长（账本单会话活跃跨度）/ 当前连续天数 / 最长连续天数；大数用中文
   单位（7亿 / 3.3亿）。
2. **Token 活动**（GitHub 风格年热力图，约 52 周、周一对齐、月标签在底部）：
   每日 / 每周 / 累计三态切换（周/累计为客户端从每日数据推导的整周高格），品牌色
   分档深浅，悬浮出「日期 + tokens + 轮消息」富提示。
3. **时间范围**（近 7 日 / 近 30 日，趋势与占比共用）：
   - **每日 Token 趋势图**：按模型多序列平滑曲线（Catmull-Rom → 贝塞尔，SVG），
     图例点选可显示/隐藏序列，坐标轴 1/2/2.5/5×10ᵏ 取整，悬浮十字 + 当日各模型
     明细；配色按 30 天总量排名分配（切换范围颜色稳定）。
   - **模型用量**：环形图（中心范围总量）+ 右侧模型列表（tokens + 百分比）。
4. **上下文剩余 hero**：大字号剩余百分比 + 全宽分段条（**分母 = contextWindow**，
   已用超窗时以已用和为分母、剩余归零）+ 未使用图例；无投影数据时占位。
5. **今日用量 · 全部会话**：账本当日累计大数字 + 输入/输出/缓存读/轮消息分项 +
   自定义日限额进度条（未设置时可就地设置：数字 + K/M 单位；已设置可编辑/清除）；
   标题行「重置账本」按钮（confirm 确认后清空账本，热力图/趋势/占比即时归零重计）。
6. 统计卡组（模型输出 / 缓存读写 / 官方累计 / 轮次步数）+ 性能小卡（TTFT /
   解码耗时 / 解码速度 / 模型与工具耗时）。
7. 按模型明细条形（输入/输出/缓存读/推理四段）、工具调用徽章、三通道口径脚注。

**与对话页列宽调节解耦**（v0.3.2）：会话页两侧的列宽拖拽手柄（调节对话页内容列与
输入框宽度，持久化 `localStorage dsh.conversation.contentWidth`）在用量 Tab 隐藏，
底部输入框固定走 DSH 默认宽度档（`clamp(680px, 64% 列宽, 920px)`），不再跟随对话页
的拖拽调节——手柄挂在会话根、输入框挂在滚动容器层，均在视图区之外，故以
`:has(.tokmn-pane)` 作用域 CSS 实现，样式随用量视图挂载/卸载、切走即恢复。

安装：同其它 profile bundle —— `%USERPROFILE%\.dsh\profiles\web\package.json` 的
`dependencies` + `dsh.profile.bundles` 加 `dsh-token-monitor`（file: 依赖），profile 目录
`pnpm install` 后 **host 重启**生效（web bundle 图重建；动态插件版本的重复注册已停止，
避免同 id Tab 冲突）。改动插件代码后同样需 profile 目录重跑 `pnpm install`（file: 依赖
为拷贝/硬链接时不会自动跟随源码）再重启 host。
