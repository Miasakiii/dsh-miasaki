# DSH 消息气泡「首 token 计时可恢复」运行时补丁（chat 侧）

> 轨迹页那个缺口的**同源第二处**：聊天区的消息气泡同样用 `node.timing.firstTokenTime`
> 渲染「首 token 用时（TTFT）」，窗口重建后该字段为 null，气泡里这一行就消失。
> 本补丁让 chat 的 assistant 节点在实时值缺位时，从 `assistant/message` 自带的紧凑 stream
> 恢复首 token 时间。2026-09-10 与轨迹补丁同日落地。

根因、三条独立证据、实测数据与官方统计投影为何不受影响，**完整写在姊妹补丁的 README 里**：
[`../dsh-client-ui-trajectory/README.md`](../dsh-client-ui-trajectory/README.md)。
简要版：`firstTokenTime` 只在实时 `assistant/live-chunk`（浏览器端合成的 transient 事件，
从不落盘）里记录；窗口重建后只剩 durable 事件，而官方 `settleMessage()` 不恢复该字段。

## chat 侧特有的两个受触点

| 位置 | 症状 |
|---|---|
| `assistantStepReading(node)`（约 3790 行） | 读 `node.timing.firstTokenTime`；为 null 时 `ttftMs = null` → 消息气泡的 turnTime 面板不渲染「首 token 用时（TTFT）」行 |
| `deriveStats(nodes)`（约 3872 行） | **窗口口径兜底**统计：`reading.ttftMs === null` 时不累加，`ttftSteps` 保持 0 → 兜底面板整块显示「不可用」 |

> 主路径（host 侧 `sessionStats` 投影）不依赖这个字段，它直接用
> `assistantStreamFirstTokenTime(event.data.stream)` —— 所以「统计」对话框一直正常。
>
> 顺带一提：本包其实**已经在读** `data.stream`，只是用来恢复**用量**
> （`streamUsage(event.data.stream)`，约 6928 / 7063 / 7083 行），没有顺带恢复时间。
> 本补丁补上的正是这条对称的缺口。

## 为什么是「运行时补丁」而不是插件

气泡的计时面板与节点 timing 都由官方包 `@deepseek-ai/dsh-client-ui-chat` 渲染/构造，
插件没有介入点（只能加自己的卡片，改不了官方消息节点的字段）。故与本项目其他本体补丁
同一路径：改写已安装包的编译产物 `lib/client.js`。

**代价必须说清楚**：DSH 升级会覆盖该包，补丁随之消失，需要重新应用。

## 目录内容

| 文件 | 作用 |
|---|---|
| `patch.mjs` | **补丁规范**：2 条锚点编辑 + CLI（verify / status / apply / revert） |
| `rebuild-baseline.mjs` | **升级专用**：以当前安装的官方原版重建 baseline，并打印待同步进 `patch.mjs` 的三个常量（只写 baseline/，不改常量） |
| `baseline/client.original.js` | DSH **0.1.7-alpha.2** 官方原版 client.js（514,483 B，SHA-256 `CCC14F1E…`）。2026-09-23 由 0.1.5-rc.1（370,078 B，`4F9CFFF8…`）升级重打，两条锚点仍唯一命中，`EDITS` 零改；产物 `1594AC3C…` |

> 与轨迹补丁同一取舍：**不存 patched 全文**（目标 361KB），产物以 `PATCHED_SHA256` 记录；
> `verify` 除 SHA 比对，还会从重建产物里抠出注入的函数跑 8 条 fixture 行为断言，
> 并做一次 ESM 语法校验（`node --check`）。

## 补丁做了什么

两条编辑，全部按「锚点唯一」定位（不唯一或缺失即报错）：

| # | 位置 | 内容 |
|---|---|---|
| 1 | 产物里 `function isTokenDelta(chunk) {` 之前 | 注入自包含的 `dshPatchedFirstTokenTime(stream)`（与轨迹补丁同名同语义，两边各自独立注入，互不依赖） |
| 2 | chat 节点 timing 构造处 | `firstTokenTime: state.firstTokenTime ?? null,` → `firstTokenTime: state.firstTokenTime ?? dshPatchedFirstTokenTime(event.data.stream) ?? null,` |

实时值优先，不影响流式过程中的现有行为；紧凑流里确实没有 token 时仍返回 null
（真正的不可用保持原样）。

## 用法

```powershell
cd dsh-miasaki-desktop/patches/dsh-client-ui-chat

node patch.mjs verify            # 离线自检：baseline 原始 → 重建 → SHA + 行为断言 + 语法校验
node patch.mjs status            # 检查已安装 bundle 的状态（original / patched / unknown）
node patch.mjs apply             # 备份 + 应用（幂等：已打过则跳过）
node patch.mjs revert            # 从 .dsh-bak 还原
node rebuild-baseline.mjs        # 升级后：用当前安装的官方原版重建 baseline

# 通用参数：--target <client.js 路径> 覆盖自动探测（默认探测 %APPDATA%\npm 全局安装）
```

`verify` 纯离线、不碰安装目录，已接入仓库级统一回归：

```powershell
node ..\..\..\scripts\verify-all.mjs desktop
```

## 验收（刷新页面后）

1. 刷新 DSH Web 页面；
2. 把鼠标移到任一轮助手回复的耗时面板上 —— 应出现「首 token 用时（TTFT）」行，
   数值与轨迹页同一步骤的「首 token 延迟」一致；
3. 若仍不显示，先用 `node patch.mjs status` 确认安装包处于 `patched` 态。

## DSH 升级后怎么办

与轨迹补丁同流程：`status` 报 `unknown` → 用 baseline diff 核对两条锚点 →
必要时更新 `EDITS` 与 baseline、跑 `rebuild-baseline.mjs` 取新常量 → `verify` 自证 →
`apply` 重打 → 刷新页面。

## 边界（勿越线）

- 补丁只改 `dsh-client-ui-chat` 这一个包的 client 产物，**不动 DSH 源码、不动其他包**；
- 与 [`../dsh-client-ui-trajectory`](../dsh-client-ui-trajectory/README.md)、
  [`../dsh-client-ui-conversation`](../dsh-client-ui-conversation/README.md)、
  [`../dsh-client-ui-settings-models`](../dsh-client-ui-settings-models/README.md) 同属
  「不修改 DSH 本体」原则的**例外**，代价同样明确（升级覆盖、需重打）；
- 两个计时补丁**必须一起重打**才完整：轨迹页三行与气泡 TTFT 是同一个字段的两处显示。

设计归因与实测记录见 [`../../design/trajectory-ttft-restore.md`](../../design/trajectory-ttft-restore.md)。
