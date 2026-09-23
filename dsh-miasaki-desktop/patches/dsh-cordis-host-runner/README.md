# dsh-cordis-host-runner 补丁 — `cordis_inspect_query`(client) 永久挂起修复

**目标包**：`@deepseek-ai/dsh-cordis-host-runner`（基线 `0.1.7-alpha.2`；2026-09-23 由 `0.1.5-rc.1` 升级重打——原版 `AC73F866…` / 产物 `D3126110…`，4 条锚点唯一命中，`EDITS` 零改）
**目标文件**：`lib/index.js`（该包 `package.json` 的 `main`/`exports` 唯一入口）
**生效条件**：应用后必须**重启 DSH host 进程** —— Node 已加载的模块不会热更新。

---

## 症状

在 Cordis 模式下用 `cordis_inspect_query` 查 **client** 平台时，工具调用**永久挂住**：
界面一直转，直到用户按 Esc / 取消回合才结束，返回
`Error: <provider>.<method>: Client inspect query ... was cancelled`。

同一工具查 **host** 平台则完全正常——同样类型的错误会**立刻**返回。
所以表象是「host 好好的，client 总卡」。

## 根因

**(1) Host 只接受成功的页面应答，把失败应答静默丢弃**

`lib/index.js` 的 `CordisInspectRegistryService.resolveClientQuery`：

```js
if (!resolution.ok) return { accepted: false };        // ← 错误应答：不 settle、不清理 pending
try { …validateOutput… } catch { return { accepted: false }; }   // ← 输出校验失败：同样丢弃
this.pending.delete(requestId); pending.settle(resolution);      // ← 只有成功才走到这里
```

**(2) 浏览器侧对一次广播只回一次，不重试**

`@deepseek-ai/dsh-cordis-client-runner` 的 `ClientCordisInspectRegistry.query()` 在 provider
抛错时发一个 `{ok:false}` 就 `active.delete()`；主机侧回执 `answered` 也无人检查。
于是「客户端拒绝了这次查询」这个信息**在链路上被彻底吞掉**。

最典型的触发条件：查一个**不在客户端目录里**的 Service key。客户端 `SERVICE_API` 只有
8 个 key —— `layout` `locale` `sessions` `slots` `theme` `timer` `uiWorkspace` `workspaces`；
查别的 key 会抛 `no catalogued Service named "X"`。
而 `conversation.*` 是 **Slot** 命名空间（30 多个），和 Service key 长得一样，极易混淆。

**(3) 没有兜底超时**

`cordis_inspect_query` 未声明 `timeoutMs`，而 `@deepseek-ai/dsh-tool-call-timeout-policy`
对未声明者直接 `return next()`。于是唯一的结束路径只剩 `exec.signal` 被中断 —— 也就是人来按 Esc。

## 实测证据

扫描 127 个持久化会话日志（13460 条工具结果），`cordis_inspect_query` 共 163 次调用，
其中 client 查询 96 次。规律 100% 吻合：

| 查询 | 结果 |
| --- | --- |
| `client/Service/listService` + `{"service":"timer"}` | 0 秒 ✅ |
| `client/Service/listService` + `{"service":"sessions"}` | 1 秒 ✅ |
| `client/Slots/listSubTree`（各种 root，含不存在的 root） | 0–4 秒 ✅ |
| `client/Service/listService` + `{"service":"conversation"}` | **1116 秒**后 cancelled ❌ |
| `client/Service/listService` + `{"service":"sessionLogDownload"}` | **13420 / 3325 / 572 / 407 秒** ❌ |

共 7 次真挂死，最长 **3 小时 43 分**（13420 秒）。key 存在就秒回、不存在就永久挂起。

## 修法（4 条编辑，均不改多页面语义）

| 编辑 | 作用 |
| --- | --- |
| `record-client-refusal` | 页面**明确拒绝**时把原因记进 `pending.lastFailure`，仍不 settle |
| `record-output-refusal` | 应答到达但输出不合 schema 时同样只记录、不 settle |
| `client-query-deadline` | 每次查询挂 **15000ms** 兜底定时器：到期结算为 `timeout` 错误，消息带出真实拒绝原因 |
| `clear-deadline` | `finally` 里 `clearTimeout`，不泄漏计时器 |

**为什么不「第一个失败就 settle」**：多个标签页会同时收到广播，某个页面没有该 provider
不代表另一个页面也没有 —— 先到先得只对**成功**应答成立。所以失败仍然不抢答，只记录；
由超时兜底负责收场。于是「永久挂起」退化为「15 秒后带准确原因的报错」，
而多标签页抢答语义原样保留。

**为什么是 15 秒**：实测成功的 client 查询耗时 0–4 秒（页面内内存操作），15 秒留足余量，
又远小于人类感知的「卡住了」。

## 用法

```bash
node patch.mjs verify          # 离线自检（不碰安装目录）
node patch.mjs status          # 看安装目录里是 original / patched / unknown
node patch.mjs apply           # 备份 + 应用（幂等）
node patch.mjs revert          # 从 index.js.dsh-bak 还原
# 通用参数：--target <lib/index.js 路径>，或环境变量 MIASAKI_DSH_CORDIS_HOST_RUNNER
```

`verify` 做四件事，全部离线、不读安装目录：

1. 由 `baseline/index.original.js` 重建产物，SHA 必须等于记录的 `PATCHED_SHA256`；
2. `node --check` 校验重建产物是合法 ESM（本补丁注入的是代码，语法破了必须响亮失败）；
3. **拒绝应答行为断言**：把重建产物里真实的 `resolveClientQuery` 抠出来，用最小假 registry
   跑「客户端拒绝」这一路，断言拒绝原因被记录、pending 不被清理、不被抢答 settle；
   并对 **baseline 原版**跑同一断言要求「不记录」—— 反例证明断言有区分力，不是恒真绿灯；
4. **超时兜底行为断言**：把注入的超时块抠出来注入**假的 `setTimeout`**（不真等 15 秒），
   手动触发回调，断言结算为 `timeout`、消息带出此前的拒绝原因、广播 resolved，
   且已结算的查询上回调是安全 no-op。

## 升级后怎么办

DSH 升级会覆盖 `lib/index.js`，补丁随之失效（`status` 报 `unknown` 或 `original`）。流程：

```bash
node patch.mjs status                 # 确认已被覆盖
node rebuild-baseline.mjs             # 以新版官方文件重建 baseline，并打印三个常量
# 手动把三个常量同步进 patch.mjs（脚本刻意不代劳）
node patch.mjs verify                 # 必须 PASS
node patch.mjs apply                  # 重打
# 然后重启 DSH host 进程
```

`rebuild-baseline.mjs` 会先试跑 `applyPatch`：锚点缺失或多重命中时**抛错而不瞎改**。
本补丁锚点是打包产物里的 tab 缩进代码 —— DSH 若改动打包缩进或该段实现，锚点会失配，
这正是想要的行为：宁可失败，也不瞎改。

## 已知边界

- **只覆盖「有人应答但被拒」**：页面**根本没连接**（关闭/刷新窗口、连在别的浏览器）时的挂起，
  同样由第 3 条编辑的超时兜底救回，但错误消息会是 `no page answered`——这是预期行为。
- **不改客户端**：`dsh-cordis-client-runner` 侧「只回一次、不重试」与「回执无人检查」保持原样，
  属上游设计；本补丁只在 Host 端把失败的后果从「永久挂起」改成「有原因的超时」。
- **不修 stale manifest**：Host 的 client provider 目录是页面镜像，页面断开不会清空，
  因此仍可能对一个已消失的页面发查询 —— 同样由超时兜底收场。
- **上游建议**：`resolveClientQuery` 在有明确拒绝且无其他候选页面时直接 settle、以及给
  `cordis_inspect_query` 声明 `timeoutMs`，都是更根本的修法，适合反馈给 DSH 上游。

## 验证状态

- 离线自证：`node patch.mjs verify` → **4/4 PASS**（SHA 自证 + ESM 语法 + 2 组行为断言）。
- 已由 `scripts/verify-all.mjs` 的 desktop 线常驻（DSH 升级覆盖补丁后该项仍应 PASS，
  它证明的是「补丁规则与基线自洽」，而不是「补丁此刻在安装目录里」）。
- 实机生效验证：应用补丁并**重启 DSH host** 后，重复一次此前必挂的查询
  （`client/Service/listService` + 一个不存在的 key，例如 `conversation`），
  预期 **15 秒内**返回 `Error: … timed out after 15000ms … (the client refused it: no catalogued Service named "conversation")`，
  而不是永久挂起。
