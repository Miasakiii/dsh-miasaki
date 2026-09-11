# 轨迹页与消息气泡的「首 token 计时不可用」——归因与恢复设计

> 2026-09-10 深夜。触发：用户贴出轨迹页计时面板截图，三行值全是「首 token 时间不可用」，
> 问「轨迹里计时不可用是怎么回事」。结论：不是三个计时坏了，也不是环境/插件故障，
> 而是官方客户端**只在实时流式阶段知道首 token 时间**，窗口重建后不去日志里恢复；
> 数据一直都在。当日落地两个运行时补丁修掉。
>
> 补丁：[`../patches/dsh-client-ui-trajectory/`](../patches/dsh-client-ui-trajectory/README.md)
> 与 [`../patches/dsh-client-ui-chat/`](../patches/dsh-client-ui-chat/README.md)。

## 一、现象

轨迹页某一步的计时面板（开始时间 / 总时长 / 首 token 延迟 / 生成 / 吞吐量）里，
**后三行同时**显示同一句「首 token 时间不可用」。用户截图只截了后三行。

## 二、归因（三层证据，逐层收窄）

### 1. 显示层：三行共用一个前置条件

`@deepseek-ai/dsh-client-ui-trajectory/lib/client.js`（0.1.5-rc.1，下同）计时面板的三个
格式化函数：

- `ttft()`（约 4033 行）：`firstTokenTime === null` → `timing.firstTokenUnavailable`；
- `generationTime()`（约 4038 行）：同样先查它；
- `throughput()`（约 4042 行）：先查用量（`usageProvided` / `outputTokens`），**再**查它。

三行同为这一句，只可能是 `firstTokenTime === null`。反证：若 `stepStartTime` 也缺，前两行会
报「步骤开始时间不可用」；若用量缺，吞吐量会先报「用量不可用」——截图两者都没有。

### 2. 数据层：这个字段只从实时 chunk 折叠

同一文件里，`firstTokenTime` 的**唯一写入点**在实时 chunk 折叠里：

```js
// updateChunk（约 722 行）——只有 live-chunk 会走这里
...isTokenDelta(chunk) && state.firstTokenTime === void 0 ? { firstTokenTime: time } : {}
// finalNode（约 776–780 行）——写进节点
timing: { stepStartTime: …, firstTokenTime: state.firstTokenTime ?? null, completedTime: event.time }
```

`settleMessage()`（`assistant/message` 的沉降路径，约 725 行）**不碰**这个字段。

### 3. 事件层：`assistant/live-chunk` 从不落盘

该事件是**浏览器端** session controller 在流式过程中合成的 transient 事件
（`@deepseek-ai/dsh-api-session-controller/lib/client.js` 1386 / 1447 行），只有
「重连时该 attempt 仍在进行中」才由 `ClientAssistantStream.replace()` 从 reconnect
baseline 重建（1381–1398 行）。因此：

| 场景 | `firstTokenTime` | 面板表现 |
|---|---|---|
| 该步正在流式 | 有 | 三行都是数字 |
| 重连时该步仍在进行中 | 有（由 baseline 的 stream 重建临时 chunk） | 三行都是数字 |
| **刷新 / 重开会话 / 切走再切回后的已结束步骤** | **null** | **三行同报「首 token 时间不可用」** |

## 三、实测证据（本机 2026-09-10）

会话日志（`~/.dsh/sessions/--C-Users-Asakii-Desktop-dsh-miasaki--/session-0c660801-…/session.v3.jsonl.zstd`，
多帧 zstd，需按帧扫描解压）逐帧解出后：

- 事件总数 155，其中 **`assistant/live-chunk` = 0 条** —— 印证第 3 层：它不落盘；
- `assistant/message` 23 条，**每条都带 `data.stream`**；用官方
  `assistantStreamFirstTokenTime(stream)` 逐步可算出首 token 时间：

| step | 首 token 延迟 | 生成 | 输出 tok | 吞吐量 |
|---|---|---|---|---|
| 1/1 | 6.70s | 2.44s | 626 | 256 tok/s |
| 1/9 | 1.32s | 7.98s | 1608 | 202 tok/s |
| 1/21 | 0.74s | 12.92s | 2446 | 189 tok/s |

其余各步 0.69–1.49s（均值约 1.1s；第 1 步 6.70s 是会话首帧）。

**官方 host 侧统计投影 `dsh-session-stats` 走的正是这条路**（`assistant/attempt` 与
`assistant/message` 都带 stream），所以「统计」对话框的平均 TTFT 一直是正常的 ——
这既是旁证，也是用户可自查的对照点。

## 四、方案选择

| 方案 | 结论 |
|---|---|
| **A. 客户端补回退（采用）** | 在轨迹/chat 的 `finalNode()` 构造 timing 时，实时值缺位就用 `assistantStreamFirstTokenTime(语义)` 从 `event.data.stream` 恢复。改动最小、只碰两处构造点、离线可自证 |
| B. 让 host 落盘 `live-chunk` | 会让日志体积按 chunk 数爆炸，且违背现有「transient 事件不落盘、durable 事件自带紧凑流」的设计取舍 |
| C. 在 controller 的 `settleMessage` 里统一回填 | 语义更靠上游，但 `dsh-api-session-controller` 是会话/事件层的共享组件，改动面与回归风险远大于收益；且本项目对 DSH 本体的改动坚持「最小、可回退」 |
| D. 不改，等上游 | 用户已确认要修；且缺口明确、修法确定 |

选 A。实时值优先（`state.firstTokenTime ?? …`），流式过程中行为不变；紧凑流里确实没有
token 时仍返回 null —— **真正的不可用保持原样，不编造数字**。

补丁注入的 `dshPatchedFirstTokenTime(stream)` 是**自包含**的（不引用产物里任何符号），
语义与 `dsh-llm` 的 `assistantStreamFirstTokenTime` / `runFirstTokenTime` / `isTokenDelta`
逐条对齐：

- `{type:'chunk',time,chunk}`：chunk 为非空 text / reasoning delta，或带 name / 非空
  argumentsDelta 的 tool-call delta → 取 `time`；
- `text-chunks` / `reasoning-chunks`：按 `time0 + dt 前缀和` 推进，取首个**非空**成员；
- `tool-call-chunks`：带 `name` 时整段从 `time0` 起算，否则取首个非空 `args` 成员；
- 其余（usage / finish / 未知类型 / 非数组）跳过。

## 五、自证（为什么敢直接改安装产物）

两个补丁的 `verify` 是**纯离线**的三层自证，已并入 `scripts/verify-all.mjs desktop`：

1. **可重建**：`baseline/client.original.js` → 应用 EDITS → 产物 SHA-256 必须等于记录的
   `PATCHED_SHA256`（锚点缺失或多重命中直接报错，宁可失败也不瞎改）；
2. **行为正确**：把注入的函数从**重建产物**里抠出来，`new Function` 编译后跑 8 条 fixture
   （chunk / reasoning-chunks / tool-call-chunks 带 name / 不带 name / tool-call-delta /
   只有 usage-finish / 畸形记录 / undefined）；
3. **语法合法**：重建产物写临时 `.mjs` 后 `node --check`（本补丁注入的是代码，不是 CSS，
   语法破了必须响亮失败）。

安装目录侧另有 `status` / `revert` 与 `.dsh-bak` 备份可回退。

## 六、生效与验收

- 安装目录写入后，`dsh-client-modules` 以 `?rev=<hash>` 提供新产物，`client-hmr` 每 500ms
  stat 变化即热推 rebuilt 帧；**刷新页面**可确保生效。
- 验收：刷新后打开任一已结束步骤的计时面板 → 三行应为数字；鼠标悬停消息的耗时面板 →
  应出现「首 token 用时（TTFT）」，且与轨迹页同一步的「首 token 延迟」一致。
- 对照：本会话实测区间 0.69–6.70s（均值约 1.1s），可与「统计」对话框的平均 TTFT 互校。

## 七、边界与残留

- **升级即失效**：两个包被 DSH 覆盖后补丁消失，需按各自 README「升级后怎么办」重打
  （先 `rebuild-baseline.mjs` 取新常量，再 `verify` → `apply`）；
- **两处必须同打**：轨迹页三行与气泡 TTFT 是同一个字段的两处显示，只打一个会留下半截效果；
- **被中断的合成节点**没有 timing（官方即如此），本补丁不改变这一点；
- **不改 host 行为**：日志格式、事件流、统计投影全未触碰，补丁只影响浏览器侧的计时字段构造；
- 本次诊断用的临时解压脚本用完即删（`_refs/` 为忽略目录），仓库内只留补丁规则与基线。
