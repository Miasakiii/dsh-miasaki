# 借鉴 dsh-plugin-agent-workflow：请求级指标（设计决策）

> 2026-10-20 立。借鉴源：社区插件 `xuanyuanzhifeng/dsh-plugin-agent-workflow` v0.3.0（MIT）。
> 借鉴方式：**算法与口径复刻，不依赖安装**（peerDep 锁 0.2.0-rc.2、无 v0.3.0 tag，
> 且其纯函数吃 TrajectorySnapshot，canvas 不在 conversation.view 槽位拿不到该数据源）。
>
> 规划稿（含排期）在 `_refs/canvas-borrow-request-metrics-plan.md`；本文件只承载
> **设计决策与验收判据**（入库四类之一）。
>
> **进度**：第一期（卡片 meta「调用 N 次」）、第二期（耗时拆分）、第三期
> （compaction 感知视图）均已落地。三期借鉴完成。

## 背景：为什么借鉴、借鉴什么

插件做「钻进一个会话内部看请求链」（轮次 → 模型请求 → 工具调用三级，含 token/缓存分项、
请求级耗时、真实上下文重建）；canvas 做「多会话多轮次的空间组织」。两者正交 ——
**画布拓扑无借鉴点**。可借鉴的是三处口径：

1. **卡片 meta 的「模型调用次数」**（第一期，已落地）；
2. **耗时拆分「模型等待 vs 工具执行」**（第二期，规划中）；
3. **compaction 感知的上下文视图**（第三期，调研已完成，规划中）。

## 第一期：卡片 meta「调用 N 次」（已落地 2026-10-20）

**口径**：
- `callCount` = 轮内 assistant 消息按 `turn:step` 去重后的数量；
- 同 step 的流式多条 assistant 不重复计数（host 投影已按 seq 去重，`index.js` 的
  `projectEventInto` 去重分支）；
- 只统计持久化消息（有 `sourceSeq`）；liveReplies 合成的前端 pending 消息无 step，不计入；
- error 轮（无 assistant 消息）为 0，meta 不渲染徽标。

**为什么用 `turn:step` 而不是 `replies.length`**：一轮内同 step 的流式会产生多条
assistant 消息（草稿 + 最终），按 step 去重才是「模型被调用的次数」的真实口径 ——
与插件 `deriveWorkflowModel` 按 `${turn}:${step}` 建索引同构。

**验收判据**（`test/conversation-cards.test.js`）：
- 一轮内 2 条 assistant（不同 step）→ `callCount === 2`；
- 一轮内同 step 多条 assistant → `callCount === 1`；
- live pending 消息（无 sourceSeq/step）→ 不计入；
- error 轮 → `callCount === 0` 且 meta 不渲染徽标。

## 第二期：耗时拆分（已落地 2026-10-20）

**插件口径**（复刻对象）：
- assistant 消息耗时 = `node.time − node.timing?.stepStartTime`（插件 `layout.ts`）；
- 工具耗时 = `result.time − result.callTime`；
- 一律 `Math.max(0, …)`，缺时间戳 → null → 显示「—」。

**canvas 实现**：
- host（`index.js` `foldToolProcess`）：`tool/call` 存 `calledAt`、`tool/result` 存
  `resultedAt`（ISO 字符串，与消息 `at` 同格式；老数据缺省 null，**免 store 版本迁移**）；
- 前端（`app.js`）：纯函数 `processDurationMs`（`resultedAt − calledAt`，null/非法/负 → null）、
  `formatDurationMs`（ms/s/m 三档 + 「—」）、`turnTimingSplit`（工具累计 + 模型近似）；
  `processRecords` 条目折叠行渲染单次耗时；`renderCardInspector` meta 行渲染
  「模型 Xs · 工具累计 Ys」。

**口径细节**：
- 工具累计 = process 条目耗时之和（**并行工具串行累加会高估 —— 文案「累计」+ title 注明**）；
- 模型耗时 = 轮边界近似（首条 assistant 的 `at` − user 的 `at` − 工具累计；
  canvas 无 stepStartTime，title 注明「轮边界估算」）；
- 时钟回拨 → 0（`Math.max(0, …)`），不显示负数。

**验收判据**（`workspace-store.test.js` + `conversation-cards.test.js`）：
- `tool/call` + `tool/result` → process 条目带 `calledAt`/`resultedAt`；
- 只有 `tool/call` → `resultedAt` 为 null，前端显示「—」；
- 老 fixture（无时间字段）→ `undefined`，`Date.parse` → NaN → 显示「—」，不抛错；
- 时钟回拨 → 0；格式化三档与「—」；拆分求和与半边省略。

## 第三期：compaction 感知的上下文视图（已落地 2026-10-20）

**调研结论**（`_refs/canvas-compaction-event-research.md`，证据来自本机 DSH 0.2.1-rc.2）：
- 事件面：`compaction/start`（`{ compactionId, sourceCommandId?, turn }`）、
  `compaction/summary`（`{ compactionId, summary: ContentBlock[], shadowedRange, shadowedSeqs,
  shadowedTokenCount, provider, model, usage? }`）、`compaction/end`（`{ …, error? }`）；
- **落地形态**：compaction 在事件流里的可见落地是一条 `user/message`
  （`frameSummary` 包装的摘要，带 `surfaceOp: {op:'replace', startSeq, endSeq}`）——
  canvas 此前会把它投影成普通用户消息（**现存可视化缺陷**）；
- 归属：自动 compaction 包在开放轮次内（`turn = openTurn`）；手动 compaction standalone
  （`turn: null`）；
- 订阅面：`ctx.on('session/event', …)` 全量无过滤，compaction 事件天然收得到。

**实现（方案 A，最小改动）**：
- host `projectEventInto` 加 `compaction/summary` 分支 → `kind: 'compaction'` 消息
  （text = `contentText(summary)`，另存 `shadowedCount` = `shadowedSeqs.length`；
  summary 形状做字符串防御兼容）；
- **过滤** `surfaceOp.op === 'replace'` 的 `user/message`（compaction 落地消息）；
- 前端 `threadMessage` 渲染 compaction 标记（琥珀色 + 折叠摘要 + 「压缩了 N 条旧消息」徽标）。

**验收判据**（`workspace-store.test.js`）：
- `compaction/summary` → compaction 消息（text = 摘要、shadowedCount = shadowedSeqs.length）；
- replace 型 `user/message` 被过滤（不出现「来路不明的用户消息」），真实用户消息照常；
- 无 compaction 的普通会话行为不变。

**已知限制**：`compaction/prune` 不投影（canvas 自有 trim 机制，两者独立）；
`frameSummary` 的包装文本（若有）原样显示（低风险，实机验证留待用户）。
