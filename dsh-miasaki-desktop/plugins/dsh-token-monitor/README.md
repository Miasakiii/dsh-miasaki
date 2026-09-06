## DSH 插件：Token 用量监控（`plugins/dsh-token-monitor/`）

**一刀切信息架构（v0.4.0）**：会话内的一切 → 会话视图「用量」Tab；跨会话的一切 →
左侧边栏脚部「用量统计」入口的全局浮窗。两个视图互不掺和。同一插件同一账本，
client 半注册三个槽位条目：

| 槽位 | id | 职责 | 轮询 |
|---|---|---|---|
| `conversation.view`（order 15，对话/轨迹之后） | `token-monitor` | 会话「用量」Tab：纯当前会话视角 | `/session` 每 3 秒 |
| `sidebar.footer.action`（设置按钮旁脚部动作位） | `usage-stats` | 「用量统计」入口按钮（展开态全宽钮，收起态 36px 圆形图标钮） | — |
| `shell.overlay`（全帧浮层，root 作用域） | `usage-stats-overlay` | 全局用量统计浮窗：与当前会话解耦，开着时切会话不受影响 | `/global` 每 5 秒 + `/heatmap` 每 60 秒，关闭即停 |

按钮与浮层的开合状态经插件内模块级极简发布订阅 store 共享（`useSyncExternalStore`，
无新依赖）；浮窗关闭途径：右上关闭按钮 / Esc / 点击背板空白处。

**client 半样式挂载契约（v0.4.0 目检修复的教训）**：三个槽位条目是三个独立挂载点，
样式 `CSS` 必须由每个根组件**各自自带**一份 `<style>`（会话页嵌在根 div 内；侧栏
按钮与浮窗的根返回 `[style, …]` 数组）。曾有 `return createElement(style),
createElement(div)` 逗号表达式写法——`<style>` 被求值后丢弃，按钮裸奔成浏览器默认
样式（自带边框、与「设置」不谐）、浮窗整体无样式堆叠在 overlayLayer 左上角。
按钮形态对齐宿主设置触发钮（`dsh-client-ui-settings-general` 的 `_trigger` /
`_rail`：42px 高 / 12px 圆角 / 透明底 / hover `--dsw-alias-interactive-bg-hover` /
padding 0 10px 0 8px / 14px·22px；展开态 `flex:1` 撑满 footerActions——list 槽位
renderSlot 输出 Fragment 无包裹层，本元素即 flex 子项；收起态 36px 圆形）。

数据三通道：

- **官方持久聚合**（覆盖全会话日志、跨进程重启）：`sessionProjections` 的
  `tokenUsage`（未缓存输入 / 输出 / 缓存读 / 缓存写）、`contextPressure`
  （压力 / 投影 / 窗口）、`contextBreakdown`（系统 / 工具 / 消息）、`sessionStats`
  （轮次 / 步数 / 耗时），以及 `tokenMeter.measure` 的总口径。会话 Tab 数据源。
- **实时明细**（进程启动起）：host 半监听 `llm/stream`（waterfall 透传包装，
  按 `sessionId|provider|model` 累计 provider 实报 `inputTokens / outputTokens /
  cacheReadTokens / reasoningTokens`）与 `tools/result`（按会话 × 工具名计数），
  另记每会话本进程活跃跨度（first/last，会话 Tab「会话活跃时长」卡，实时口径）。
  **v0.4.0 修复**：v0.3.3 的 `/summary` 把 `live.calls` / `live.tools` 全量返回、
  未按 `sessionId` 过滤，会话页混入了同进程其他会话的数据——现按会话过滤后再下发。
- **跨会话账本**（插件首次部署起、跨 host 重启持久，全局浮窗数据源）：与实时明细
  同口径的增量按日累计，5s 节流追加写 `usage-log.jsonl`（进程退出兜底 flush；保留
  **380 天**，启动只载窗口内尾部、文件超 8MB 只解析尾 8MB）；条目另带 `calls`
  （当日实报次数 ≈ 轮消息）与 `type:'span'` 会话活跃跨度快照（min first / max last
  合并，推进 ≥60s 才落盘，支撑「最长聊天时长」）。限额配置存 `config.json`。
  数据目录优先宿主插件数据目录服务，否则 `~/.dsh/plugins-data/dsh-token-monitor/`。

通信（host 半 **必须 `inject: ['webServer']` 声明等待**，否则插件行激活时
`ctx.get('webServer')` 可能尚不可用而静默跳过，表现为路由 404；`{ok, error}` 包装
对齐 dsh-free-model-pool）：

- `GET /dsh-token-monitor/session?sessionId=…`——当前会话：官方聚合 +
  **按 sessionId 过滤后**的实时明细（calls / tools / activeSpan / sampledAt），
  会话 Tab 专用，3 秒轮询，载荷瘦身；
- `GET /dsh-token-monitor/global`——跨会话：总览统计 `stats`、今日 `today`、
  近 30 天趋势 `trend`（含按模型明细）、**会话用量 Top N** `sessions.rows`
  （近 30 日按账本 `sessionId` 聚合 tokens + 轮消息 + 活跃跨度，Top 10，
  会话标题尽力解析、失败降级 ID）、`since`、限额配置，全局浮窗 5 秒轮询；
- `GET /dsh-token-monitor/heatmap`——稀疏每日账单 `{date, total, calls}`（热力图
  数据源，仅含有活动的日子，空日由客户端按日历补齐），浮窗开启期间 60 秒轮询；
- `GET|POST /dsh-token-monitor/config`——读取 / 设置 `{dailyTokenLimit: number|null}`
  （正数 ≤1e12 或 null）；
- `POST /dsh-token-monitor/reset`——清空跨会话账本（内存聚合 + `usage-log.jsonl`，
  限额配置保留，不可恢复）。启动载入磁盘存量只进内存聚合、绝不回写（回写会使
  账本每重启翻倍，v0.3.1 修复）；历史失真数据用此路由（或浮窗「重置账本」按钮）
  清零重计。
- **旧 `GET /dsh-token-monitor/summary` 于 v0.4.0 退役移除**（插件自用、无外部
  消费者；职责拆入 `/session` + `/global`）。

## 会话「用量」Tab（纯会话视角）

上下文剩余 hero（大字号剩余 % + 全宽分段条，分母 = contextWindow，45/75/95 三档
变色，已用超窗时以已用和为分母、剩余归零，无投影数据时占位）→ 会话用量总览卡组
（官方累计 Tokens 含 tokenMeter 计量 / 模型输出 / 缓存读写 / 轮次与步数 /
**会话活跃时长**（本进程实时口径））→ 按模型明细条形（输入/输出/缓存读/推理四段，
仅本会话）→ 工具调用徽章（仅本会话）→ 性能小卡（TTFT / 解码耗时 / 解码速度 /
模型与工具耗时）→ 口径脚注（本页不含任何跨会话累计，全局统计见侧栏入口）。
Tab 保留 `:has(.tokmn-pane)` 列宽解耦 CSS（v0.3.2，见下）。

## 全局「用量统计」浮窗（跨会话视角）

头部（标题 + 「跨会话总量 · 与当前会话无关」 + 关闭钮）→ 总览六卡（累计 Token 数 /
峰值 Token 数 / 活跃天数 / 最长聊天时长（账本单会话活跃跨度）/ 当前连续 /
最长连续；大数中文单位）→ **Token 活动**（GitHub 风格年热力图，约 52 周、周一对齐、
月标签，网格 max-content 水平居中——固定 730px 宽的网格左对齐会在全宽卡片右侧留白；
**每日=格点深浅，每周/累计=变高柱**（柱高 ∝ 当周用量 / 逐周累计，零周 3px 空柱做
基线，底部对齐；数据集中单周时两模式柱形相同、由模式脚注区分口径，跨多周后累计呈
爬坡形态自然分化），悬浮富提示）→ **使用趋势**（近 7/30 日
切换，按模型多序列平滑曲线（Catmull-Rom → 贝塞尔 SVG），图例点选显隐，坐标轴
1/2/2.5/5×10ᵏ 取整，悬浮十字 + 当日明细，配色按 30 天总量排名分配；**趋势容器
无条件渲染**——`chartW` 依赖首挂 ResizeObserver 测量，等数据到了才挂容器会让
测量落空、宽度永远回退 640px 在宽面板右侧留白）→ **使用分布**
两列：模型用量环形图（中心范围总量 + 模型列表 tokens/百分比）| **会话用量 Top N**
（近 30 日按会话排行，占比条以榜首为满刻度，标题解析失败显示截断 ID）→
**今日用量 · 全部会话**（当日大数字 + 分项 + 日限额进度条（未设置就地设置 K/M，
已设置可编辑/清除）+ 标题行「重置账本」按钮（confirm 后清空，热力图/趋势/占比即时
归零重计））→ 口径脚注（账本口径 + 380 天保留 + 部署前历史不在其中 + 限额为本地
自定义配置）。

client 半仍为手写 `window.__ModuleLoader__.load` bundle：无 JSX、无图表依赖、
热力图 CSS grid；主题令牌化 `--dsw-alias-*` 明暗自适应，浮层中性色自派生三档
（`--tokmn-*`，作用域 `.tokmn-pane` 与 `.tokmn-ov`），深浅主题边界可见。

**与对话页列宽调节解耦**（v0.3.2）：会话页两侧的列宽拖拽手柄（调节对话页内容列与
输入框宽度，持久化 `localStorage dsh.conversation.contentWidth`）在用量 Tab 隐藏，
底部输入框固定走 DSH 默认宽度档（`clamp(680px, 64% 列宽, 920px)`），不再跟随对话页
的拖拽调节——手柄挂在会话根、输入框挂在滚动容器层，均在视图区之外，故以
`:has(.tokmn-pane)` 作用域 CSS 实现，样式随用量视图挂载/卸载、切走即恢复。

安装：同其它 profile bundle —— `%USERPROFILE%\.dsh\profiles\web\package.json` 的
`dependencies` + `dsh.profile.bundles` 加 `dsh-token-monitor`（file: 依赖），profile 目录
`pnpm install` 后 **host 重启**生效（web bundle 图重建；动态插件版本的重复注册已停止，
避免同 id Tab 冲突）。

**改动源码后的同步与重启顺序（v0.4.0 目检踩坑，顺序错了会出新旧混搭）**：
file: 依赖在 profile 顶层 node_modules 是普通拷贝，且 `pnpm install` 对其是
no-op（lockfile directory resolution 无内容指纹，`--force` 亦无效）——小改动直接
`cp` 覆盖顶层对应文件（或删掉顶层目录再 `pnpm install` 重拷）。**host 半在 boot 时
import、client 半按请求读盘**：必须等拷贝动作完全落盘后再重启 host，否则会出现
「新 client + 旧 host 半」——按钮/浮窗都在但 `/session`、`/global` 404（host 路由
未注册）。
