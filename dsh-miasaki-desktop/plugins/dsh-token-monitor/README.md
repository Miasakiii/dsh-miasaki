## DSH 插件：Token 用量监控（`plugins/dsh-token-monitor/`）

**一刀切信息架构（v0.4.0）**：会话内的一切 → 会话视图「用量」Tab；跨会话的一切 →
左侧边栏脚部「用量统计」入口的全局浮窗。两个视图互不掺和。同一插件同一账本，
client 半注册三个槽位条目：

> **v0.5.0**：全局浮窗内的「会话用量 Top N」升级为「**会话活跃分布**」，并把会话
> 身份（标题 / 工作目录）从会话日志折叠出来——修的是"整列 `session-<uuid>`、认不出
> 是哪个会话"。**会话「用量」Tab 无改动**。设计依据与根因见
> `../../design/usage-stats-redesign.md` §12。
>
> **v0.5.1**：①修掉 span 快照在 host 退出时被重复回写（本机实测账本 19% 是纯冗余，
> 详见下文「账本纪律」）；②分布条改柱状、修正口径标注、加行分隔线等显示优化。

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
- **会话身份折叠**（v0.5.0 新增，全局浮窗会话排行的标题来源）：账本只存
  `sessionId`，而 `session-<uuid>` 排成一列等于没有信息；且 `ctx.sessions.get`
  是**内存 store**，只认当前活着的会话，已归档会话一律 `undefined`（旧实现在这里
  整列降级成截断 ID——这正是"认不出是哪个会话"的根因）。改为向宿主
  `ctx.sessionQuery.readTitleSnapshots(ids[])` 批量折叠**会话日志**：支持已持久化
  会话、按会话隔离失败，返回标题（来源 `provider` / `fallback` / `user`）与 header
  的 `cwd` / `createdAt` / `origin` / `agentPreset`。实测 10 个真实历史会话
  **10/10** 取到标题，**冷读 ≈0.3s/会话**，故：TTL 缓存（有标题 30 分钟、无标题
  2 分钟重试）+ 单飞任务 + 账本载入后启动预热 + `/global` 首屏等待上限 2.5s
  （超时先用截断 ID，后台补完，下一轮 5s 轮询即有）。降级链：缓存 → 内存 store →
  截断 ID，**绝不编造标题**。`sessionQuery` 缺失时整条链路静默跳过，功能不受影响。

**账本纪律：载入路径绝不标脏（v0.5.1 修复）**。`touchSpan` 增了 `dirty` 形参，
`loadLedger()` 载入 `type:'span'` 行时传 `false`：磁盘上的存量快照已经写过了，
再标脏会让 `process.on('exit')` 的**强制** `flushLedger(true)`（刻意绕过节流判断）
把它们当成本次推进重写一遍 —— 每次 host 正常退出都追加一批重复 span 行。
对照实测（真实退出路径）：未修复 +46 行（45 存量 + 1 真实推进），修复后 +1 行
（只有真实推进的会话，功能未削弱）。本机账本曾因此积 947 行纯冗余（占 19%、
单键最多重复 82 次），已用 `scripts/dedupe-usage-ledger.mjs` 清理
（默认预演，`--apply` 才写，写前做**语义等价校验**、写前自动备份）。
**同类改动注意**：任何"载入即写回"的路径都要先问一句"这是本次产生的，还是磁盘上本来就有的"。

**写入节流窗口的取值依据（v0.5.1 实测，结论：不动）**。`SPAN_FLUSH_MS = 60s`：
span 实测只占账本体积 **1.1%**（76 行 / 12 KB）、实际写入间隔中位 **66s**（说明 60s
节流几乎不额外触发写盘），且消费端是**日粒度**（身份行"最后活跃日"）与历史最大值
（「最长聊天时长」），调大省不到 1% —— 故维持。增长主因是**用量行**：`flushLedger`
每 5s 把 `pending` 每个键写成一行，活跃时段约 8 行/分钟；但当前 1.0 MB / 30 天，
离 `TAIL_BYTES = 8MB` 的启动解析窗口尚远，也维持 5s。极端情形（长时满负荷会话）
与逼近 8MB 时的处置见 `../../design/usage-stats-redesign.md` §13.3。

通信（host 半 **必须 `inject: ['webServer']` 声明等待**，否则插件行激活时
`ctx.get('webServer')` 可能尚不可用而静默跳过，表现为路由 404；`{ok, error}` 包装
对齐 dsh-free-model-pool）：

- `GET /dsh-token-monitor/session?sessionId=…`——当前会话：官方聚合 +
  **按 sessionId 过滤后**的实时明细（calls / tools / activeSpan / sampledAt），
  会话 Tab 专用，3 秒轮询，载荷瘦身；
- `GET /dsh-token-monitor/global`——跨会话：总览统计 `stats`、今日 `today`、
  近 30 天趋势 `trend`（含按模型明细）、**会话活跃分布** `sessions`
  （`windowDays` / `limit` / `dates[]` / `rows[]` / `totalAll` / `callsAll` /
  `matched`，近 30 日按账本 `sessionId` 聚合 tokens + 轮消息 + 活跃跨度 +
  **逐日分布 `daily[]`**，并贴会话身份 `title` / `cwdName` / `cwd` / `subagent` /
  `agentPreset` / `titleSource`；`byCwd` = 第二维度，按工作目录把同项目会话叠加
  （`rows[]` / `unresolved` / `matched` / `totalAll` / `callsAll` / `limit`）；
  两个维度的下发上限均为 Top 50，排序/搜索/条数/维度切换由客户端在其上做）、
  `since`、限额配置，全局浮窗 5 秒轮询；
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
两列（`minmax(300px,380px) 1fr`）：模型用量环形图（中心范围总量 + 模型列表
tokens/百分比）| **会话活跃分布**（v0.5.0 由「会话用量 Top N」升级）→
**今日用量 · 全部会话**（当日大数字 + 分项 + 日限额进度条（未设置就地设置 K/M，
已设置可编辑/清除）+ 标题行「重置账本」按钮（confirm 后清空，热力图/趋势/占比即时
归零重计））→ 口径脚注（账本口径 + 380 天保留 + 部署前历史不在其中 + 限额为本地
自定义配置）。

### 「会话活跃分布」（v0.5.0，参照"工作空间活跃分布"设计路径）

密集排行，一行回答四件事：**是哪个会话/项目** / 用了多少 / 占多少比重 / 哪几天在活跃。

**两个维度**（左上「按会话 / 按工作目录」切换，共用同一套控件与行结构）：

| 维度 | 行是什么 | 名称列 | 身份行 |
|---|---|---|---|
| 按会话（默认） | 一个会话 | 会话标题 | `工作目录 · 最后活跃日`（+ 子会话标签） |
| 按工作目录 | 一个工作目录下全部会话的叠加 | 目录名 | `N 个会话 · 最后活跃日` |

| 列 | 内容 |
|---|---|
| 序号 | 当前排序键下的排名 |
| 名称（两行） | 标题（13px）+ 身份行（11px）；hover 给完整标题 / sessionId / cwd / 预设名（目录行为完整路径 + 会话数） |
| 数值 | 窗口内 tokens 总量（中文大数：亿 / 万） |
| 占比 | `占比% · N 轮`；会话维度分母 = 窗口内**全部**会话合计（含未列出的长尾会话），目录维度分母 = **已归入目录的**合计（两者互不混用） |
| 分布条 | 近 30 日逐日**一柱**（宽 5px、间距 2px、底部对齐）：空日只留 3px 基线，有量按**该行自身峰值**给 5–18px 高柱（高度 + 透明度双编码），柱上 hover 给「日期 · 用量」 |

- **为什么必须有目录维度**（实测驱动，不是照抄参考图）：近 30 日窗口里**单会话的
  时间跨度天生很短**——真实账本回放显示 45 个会话 / 1350 格**只有 50 格非零（4%）**、
  单行最多活跃 2 天，条带几乎全空；按工作目录把同项目会话叠加后是 **21/120（18%）**、
  单行最多活跃 6 天，形态才立得住。未解析出目录的会话计入 `unresolved` 如实提示，
  **不塞进"未知目录"假分组**。
- **为什么是柱不是等高条带**（v0.5.1，用户截图反馈）：填充率只有 4% 时，等高条带
  每行都渲染成"一整条灰带 + 右侧一个深块"——既看不出趋势，灰底还是纯噪声；空日
  退成 3px 基线后，活跃日才立得出来，形态变成可直接横向扫读的"基线 + 柱"。
- **按行内峰值归一化是刻意的**：分布回答"这行哪几天在活跃"，跨行量级已由数值列
  表达；若按全局峰值归一化，小行会整条褪成底色、形态不可读。
- **四组控件**（维度 / 排序键「按 Token / 按轮消息」/ 搜索框 / 条数「Top 10/20/30/50」）
  全部在客户端本地集合上即时生效（主机已下发 Top 50 候选），交互不回主机取数，
  5s 轮询照常刷新；搜索匹配标题 / sessionId / 工作目录。
- **标题取不到时**不编造：退回截断 ID，并把 ID 补进身份行，hover 仍是完整 ID。
- 列表限高 **420px**：默认 Top 10 恰好一屏放满（行高约 42px），切更大条数才内滚；
  行间有极细分隔线，两行式文本连排时不串行。
- **口径标注**（v0.5.1 修正）：`近 N 日` 只挂在**模型用量**卡标题旁 —— 环形图按
  趋势窗口（7/30 日）切片，而会话活跃分布固定近 30 日；此前挂在「使用分布」区
  头部，会被误读成整块的口径。
- **布局约束：窄列必须能收缩**（v0.5.1 二轮回修，踩过坑）。`.tokmn-dist` 两列与
  `.tokmn-donut` 的列表列都要写成 `minmax(0, …)`，`.tokmn-pct` / `.tokmn-tip-val`
  要 `flex: none`，卡头标题区要 `min-width: 0`。原因是 grid 项默认 `min-width: auto`
  —— 长模型名（`deepseek-v4.1-flash-expires-on-0910`）会把列撑到 min-content，
  `.tokmn-pct` 的 `margin-left: auto` 于是被推出卡片、叠到右列上（曾把左列收成
  300–380px 定宽，立刻复现）。同理 `.tokmn-tip` 需 `max-width` + 名字 ellipsis，
  否则 `nowrap` 的长模型名会把提示框撑到面板外、数字被裁掉；趋势图与热力图的
  tooltip 定位都按这个上限留位（`- 366`），不再是旧的硬编码 `- 190` / `- 170`。
- **悬浮提示只列当日有量的模型**（v0.5.1）：`hoverRows` 加了 `.filter((r) => r.v > 0)`
  —— hover 明细回答的是"这天用了什么"，列出 0 值行既占地又会把提示框撑宽。
- **模型用量的 hover 要给完整模型名**（v0.5.1）：`models` 保留 `model` 字段（`label` 是显示名，
  同名跨供应商时带 provider 前缀），列表名称 / 趋势图图例 / **环形图扇区**三处 hover 统一给
  「模型名 · 供应商」，扇区另给用量与占比（走 SVG 原生 `<title>`，此前扇区 hover 无任何信息）。
  原因是窄列必然截断模型名（`deepseek-v4.1-flash-exp…`），而原先列表 hover 只给 `provider`，
  悬浮看不到全名等于没给。**改 `models` 字段时注意**：`m.model` 已被三处引用；趋势数据的
  `e.models`（host 侧 `ledgerTrend` 下发）本就带 `{provider, model, total}`，两者别混。

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

**排障：`failed to import loader entry …: X is not defined`（v0.5.1 事故）**：
症状是插件整块加载失败、报一个**看不懂的裸标识符**，且 V8 给出的行号**落在 CSS
注释里**——不是那行真的有问题，而是 **CSS 模板字符串被提前闭合**：`const CSS = \`…\``
的注释里写了 `` `.tokmn-pct` `` 这类**带反引号的类名**，第 2 个反引号在此处结束了
字面量，紧随其后的 `pct` 于是变成裸标识符被求值。**规则：CSS 模板字符串内的注释
引用类名不要加反引号**（直接写 `.tokmn-pct` 或用中文引号）。定位与自检：

```bash
# 加载前自检（语法 + 真实 factory 执行 + 可选的安装副本同步）
node dsh-miasaki-desktop/plugins/dsh-token-monitor/scripts/verify-client-bundle.mjs \
  dsh-miasaki-desktop/plugins/dsh-token-monitor/lib/client.js --sync
```

脚本在**修复前**会精确报出 `ReferenceError: pct is not defined at …client.js:65:46`，
修复后显示 `[OK] factory 执行通过`；改动 client 半后建议先过一遍再重启 host。

