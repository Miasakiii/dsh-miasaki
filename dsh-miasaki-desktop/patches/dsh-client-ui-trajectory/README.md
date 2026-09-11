# DSH 轨迹页「首 token 计时可恢复」运行时补丁

> 现象（2026-09-10 用户截图）：轨迹页计时面板里 **首 token 延迟 / 生成 / 吞吐量三行
> 同时**显示「首 token 时间不可用」，而同一次会话「统计」对话框里的平均 TTFT 一直正常。
>
> 三行不是三个故障 —— 它们共用一个前置条件 `firstTokenTime`。本补丁让轨迹节点在实时值
> 缺位时，从 `assistant/message` 自带的紧凑 stream 里恢复首 token 时间，
> 于是刷新页面、回看历史步骤也能看到这三行数字。2026-09-10 首次落地。

## 根因（三条独立证据）

**1. 显示层：三行共用一个前置条件。** `lib/client.js` 里计时面板的三个格式化函数：

```js
function ttft(metrics, t) {            // 「首 token 延迟」
  if (!metrics.timingRecorded) return t("timing.notRecorded")
  if (metrics.stepStartTime === null) return t("timing.stepStartUnavailable")
  if (metrics.firstTokenTime === null) return t("timing.firstTokenUnavailable")   // ← 你看到的这句
  ...
}
function generationTime(metrics, t) {  // 「生成」——同样先查它
  if (!metrics.timingRecorded || metrics.firstTokenTime === null) return t("timing.firstTokenUnavailable")
  ...
}
function throughput(metrics, t) {      // 「吞吐量」——还是先查它
  if (!metrics.usageProvided) return t("timing.usageUnavailable")     // ← 这句没出现，说明用量在
  if (metrics.outputTokens === null) return t("timing.outputTokensUnavailable")
  if (!metrics.timingRecorded || metrics.firstTokenTime === null) return t("timing.firstTokenUnavailable")
  ...
}
```

三行同时是同一句，只可能是 `firstTokenTime === null`（若 `stepStartTime` 也缺，前两行会报
「步骤开始时间不可用」；若用量缺，吞吐量会先报「用量不可用」——截图两者都没出现）。

**2. 数据层：这个时间戳只从实时 chunk 折叠。** 同一文件里，只有 `assistant/live-chunk`
事件才会写入它，`assistant/message` 的 settle 路径不碰：

```js
// updateChunk（约 722 行）
...isTokenDelta(chunk) && state.firstTokenTime === void 0 ? { firstTokenTime: time } : {}
// finalNode（约 776–780 行）
timing: { stepStartTime: ..., firstTokenTime: state.firstTokenTime ?? null, completedTime: event.time }
```

**3. 事件层：`assistant/live-chunk` 从不落盘。** 它是**浏览器端** session controller 在流式
过程中合成的 transient 事件（`dsh-api-session-controller/lib/client.js` 1386 / 1447 行），
且只有「重连时该 attempt 仍在进行中」才会由 `ClientAssistantStream.replace()` 从 reconnect
baseline 重建（1381–1398 行）。于是：

- 该步**正在流式**时 → 有实时 chunk → 三行有值；
- 刷新 / 重开会话 / 切走再切回 → 事件窗口重建，已结束的步骤只剩 durable 事件 →
  `firstTokenTime` 永远是 null → 三行一起「首 token 时间不可用」。

**实测证据**（本机 2026-09-10，会话 `session-0c660801-…`）：解压会话日志得 155 条事件，
`assistant/live-chunk` = **0 条**；23 条 `assistant/message` 每条都带 `data.stream`
（紧凑记录，text-chunks / reasoning-chunks / tool-call-chunks / chunk，每条都带时间戳），
用官方 `assistantStreamFirstTokenTime` 能逐步算出首 token 时间（1/1 = 6.70s，其余
0.69–1.49s）。**数据一直在日志里**——官方 host 侧统计投影 `dsh-session-stats` 正是这么算的，
所以「统计」对话框正常，只有轨迹面板没做这条恢复。

## 为什么是「运行时补丁」而不是插件

节点 timing 在官方包的 `finalNode()` 里构造，插件无从介入（插件只能往 Slot 里加自己的 UI，
改不了官方节点的字段）。本机也没有 fork 官方包 + 重建 dist 的条件（registry 不可达 /
安装目录由全局安装管理），因此**直接改写已安装包的编译产物** `lib/client.js`。

**代价必须说清楚**：DSH 升级会覆盖该包，补丁随之消失，需要重新应用。这就是本目录入库的
原因——补丁规则 + 基线进版本控制后，升级后能**重建、能校验、能回退**。

## 目录内容

| 文件 | 作用 |
|---|---|
| `patch.mjs` | **补丁规范**：2 条锚点编辑 + CLI（verify / status / apply / revert） |
| `rebuild-baseline.mjs` | **升级专用**：以当前安装的官方原版重建 baseline，并打印待同步进 `patch.mjs` 的三个常量（只写 baseline/，不改常量） |
| `baseline/client.original.js` | DSH **0.1.5-rc.1** 官方原版 client.js（392,863 B，SHA-256 `73A878B4…`） |

> 与 settings-models 补丁的差别：**不存 patched 全文**（目标 384KB，再存一份不划算），
> 产物以 `PATCHED_SHA256` 常量记录，`verify` 用「由原始 baseline 重建出的 SHA 是否等于该常量」
> 自证。比 conversation 补丁多两道自证：**从重建产物里抠出注入的函数跑 fixture 行为断言**
> （8 条），以及**重建产物的 ESM 语法校验**（`node --check`）—— 本补丁注入的是代码，不是 CSS。

## 补丁做了什么

两条编辑，全部按「锚点唯一」定位（不唯一或缺失即报错，宁可失败也不瞎改）：

| # | 位置 | 内容 |
|---|---|---|
| 1 | 产物里 `function isTokenDelta(chunk) {` 之前 | 注入自包含的 `dshPatchedFirstTokenTime(stream)`：按 `dsh-llm` 的 `assistantStreamFirstTokenTime` 语义从紧凑流记录恢复首 token 时间 |
| 2 | 轨迹节点 timing 构造处 | `firstTokenTime: state.firstTokenTime ?? null,` → `firstTokenTime: state.firstTokenTime ?? dshPatchedFirstTokenTime(event.data.stream) ?? null,` |

语义与官方一致：`{type:'chunk',time,chunk}` 取首个 token delta 的 time；
`text-chunks` / `reasoning-chunks` 按 `time0 + dt 前缀和` 取首个**非空**成员；
`tool-call-chunks` 带 `name` 时整段从 `time0` 起算，否则取首个非空 `args` 成员；
其余记录（usage / finish / 未知类型）一律跳过。**没有 token 时仍返回 null**，
即「真正的不可用」保持原样，不编造数字。

实时值优先（`state.firstTokenTime ?? …`），因此不影响流式过程中的现有行为。

## 用法

```powershell
cd dsh-miasaki-desktop/patches/dsh-client-ui-trajectory

node patch.mjs verify            # 离线自检：baseline 原始 → 重建 → SHA + 行为断言 + 语法校验
node patch.mjs status            # 检查已安装 bundle 的状态（original / patched / unknown）
node patch.mjs apply             # 备份 + 应用（幂等：已打过则跳过）
node patch.mjs revert            # 从 .dsh-bak 还原
node rebuild-baseline.mjs        # 升级后：用当前安装的官方原版重建 baseline（见下）

# 通用参数：--target <client.js 路径> 覆盖自动探测（默认探测 %APPDATA%\npm 全局安装）
```

`verify` 是纯离线检查，不碰安装目录，已接入仓库级统一回归：

```powershell
node ..\..\..\scripts\verify-all.mjs desktop
```

## 验收（刷新页面后）

1. 刷新 DSH Web 页面（或重开会话）；
2. 打开任一**已结束**步骤的计时面板 —— 首 token 延迟 / 生成 / 吞吐量三行应是数字；
3. 对照「统计」对话框的平均 TTFT：同一批步骤的两处数字应互相吻合（本机 2026-09-10
   的 23 步实测区间 0.69–6.70s，均值约 1.1s）。

> 生效机制：`dsh-client-modules` 以 `/plugins/??<id>/client.js&rev=<hash>` 提供该文件，
> `client-hmr` 每 500ms stat 一次，命中变化即经 SSE 推 rebuilt 帧热更；若 host 启动晚于
> 补丁写入，则启动快照即补丁，无需热更。

## DSH 升级后怎么办

1. `node patch.mjs status` —— 若显示 `unknown`，说明安装的是新版本，补丁已被覆盖；
2. 用 `baseline/client.original.js` ↔ 新版 client.js 做 diff，核对两条锚点是否仍在
   （`patch.mjs` 会在锚点缺失或多重命中时明确报错，不会静默改错）；
3. 锚点漂移则更新 `EDITS` 与 baseline，再跑 `node rebuild-baseline.mjs` 取新常量、
   `node patch.mjs verify` 自证；
4. `node patch.mjs apply` 重新应用，刷新页面生效。

## 边界（勿越线）

- 补丁只改 `dsh-client-ui-trajectory` 这一个包的 client 产物，**不动 DSH 源码、不动其他包**；
- 与本项目其他本体补丁（[`../dsh-client-ui-chat`](../dsh-client-ui-chat/README.md) 消息气泡 TTFT、
  [`../dsh-client-ui-conversation`](../dsh-client-ui-conversation/README.md) 会话头溢出保护、
  [`../dsh-client-ui-settings-models`](../dsh-client-ui-settings-models/README.md) 设置页增强）
  同属「不修改 DSH 本体」原则的**例外**，代价同样明确（升级覆盖、需重打）；
- 各补丁彼此独立：各自的锚点、baseline、CLI 与 `verify` 互不依赖，升级后分别重打即可；
- 本目录不含任何宿主服务调用，改动全部发生在浏览器侧 UI 的计时字段构造上。

设计归因与实测记录见 [`../../design/trajectory-ttft-restore.md`](../../design/trajectory-ttft-restore.md)。
