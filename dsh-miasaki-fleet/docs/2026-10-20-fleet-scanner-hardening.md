# Fleet 线 · monkeyscan 核实后修复批次（2026-10-20）

> 来源：`_refs/monkeyscan-2026-10-19/`（扫描报告）+ `verify/C-fleet.md`（核实结论）+ `FIX-SPEC.md` §4 fleet。
> 范围：只改 `dsh-miasaki-fleet/workers/`、`fleet-monitor/` 与对应 `tests/`；**未动**用户未提交的
> `plugins/dsh-fleet-panel/`、`README.md`、`package.json`、`scripts/verify-all.mjs`（变更记录因此落本文件，
> 而非 README 的变更记录节）。
> 纪律：零第三方依赖、未 commit/stash/reset、未启动服务、未发网络请求。

## 1. 修了什么（5 条）

### 1.1 0cbb0 — 原子写的临时文件名唯一化（P2）

- **问题**：`writeJsonAtomic` 恒用 `<target>.tmp`。applier 是「每次调用一个短生命周期 node 进程」
  （monitor / dispatcher / discovery 各起一个），并发写同一目标时共享临时文件 ⇒ 一方 rename 会发布
  另一方的字节，另一方 rename ENOENT → partial（exit 4）；两次都成功时还会静默丢更新。
- **修法**（`workers/lib/bus-apply-core.cjs`）：新增 `tmpPathFor()`，临时名改为
  `<target>.<pid>.<uuid>.tmp`（`crypto.randomUUID`）；失败路径在 `catch` 里 `unlink` 自己的临时文件。
- **测试**（`tests/bus-apply.test.mjs`）：临时名唯一（pid+UUID 形态、两次不同）；串行覆盖写内容正确且
  无 `.tmp` 残留；rename 失败（目标为目录）时异常上抛且不残留临时文件。

### 1.2 e5a4b — applier 超步加跨进程锁（P2）

- **问题**：`applyPatches` 的「读版本 → expected_version 检查 → 应用 → 追加 superstep.committed」
  全程无锁、无 CAS。两个 applier 进程都读到版本 N 就会都提交 N+1（重复 bus_version ⇒ `validate-bus`
  判事件流损坏），同路径 set/merge 还会静默丢更新。`expected_version` 是顺序场景的过期检测器，不是锁。
- **修法**（`workers/lib/bus-apply-core.cjs`）：
  - 新增 `state/.bus-apply.lock` 锁：`fs.openSync(..., 'wx')` 原子创建，锁内写 `{pid, ts}`；
    拿不到就每 10ms 重试，5s 超时（`BUS_LOCK_TIMEOUT` → `applyPatches` 返回 code 4，不抛到 CLI 顶层）；
    mtime 超过 60s 视为崩溃残留并回收；`finally` 删除。
  - 抽出 `withBusLock(root, fn, opts)`（测试可注入 `timeoutMs/staleMs/retryMs`），导出 `lockPath`。
  - `applyPatches` 拆为「① 契约校验（纯 CPU，锁外）→ ② `withBusLock(applySuperstep)`」；
    `--check` 是纯 dry-run，不占锁（不产生锁文件副作用）。
  - 等锁用 `Atomics.wait` 同步短睡（不引入 async，避免满核自旋）。
- **测试**（`tests/bus-apply.test.mjs`）：真起一个持锁子进程（`stdio: 'ignore'`，不捕获管道）验证
  「持锁期间 applyPatches 阻塞等待、释放后才提交」；回调抛错也释放锁；过期锁可回收；锁被长期持有
  时返回结构化 exit 4 且不误删他人锁。
- **CLI 文案**（`workers/bus/bus-apply.mjs`）：非契约类失败（如锁超时）不再误报「契约校验失败」，
  按 `code === 2 ? 契约校验失败 : 环境/IO 失败` 区分。

### 1.3 75975 — fleet-monitor 请求体 64 KiB 上限（P3）

- **问题**：`POST /api/toggle/:agentId` 的 `readBody` 无上限、无 Content-Length 校验、无 error/aborted
  处理；任意本地进程带 `Host: 127.0.0.1` 就能流式打爆 monitor 内存（CWE-400）。围栏只挡浏览器，不担认证。
- **修法**（`fleet-monitor/server.js`）：`MAX_BODY_BYTES = 64 * 1024`（与 dual-model/ssh 同口径）；
  `readBody` 累计字节，超限即 `req.pause()` + 拒绝 `code: 'BODY_TOO_LARGE'`；补齐 `'error'/'aborted'`
  让 Promise 必定落定；路由把超限映射为 **413**（响应发出后销毁连接），客户端中止则不再写响应。
- **测试**（`tests/fleet-monitor.test.mjs`）：超 64 KiB → 413 且不调用 applier；恰好 64 KiB 合法请求
  仍放行（边界不误伤）；客户端中途断开不崩不写响应。
- 说明：2026-10-19 新增的 `plugins/dsh-fleet-panel` 代理层自带 1 MiB 上限，但 monitor 直连端口此前
  无上限 —— 本次补的是直连端口这一层（插件未改动）。

### 1.4 6e766 — 任务产物名路径穿越（写入侧 + 读取侧，P3 加固）

- **问题**：① 写入侧 `validateValueForPath` 完全不校验 `state/tasks.jsonl` 的 append 行 ⇒ 可注入
  任意形态任务行（穿越 artifact、任意 task id）；② 读取侧 `task-ready.artifactExists` 把
  `tasks/<id>/<artifact>` 直接 `path.join` 后 `fs.existsSync`，`artifact='../../..'` 可探测工作区外
  文件是否存在，并把结果编码进「上游产物缺失」原因（存在性预言机）。
- **修法**：
  - 写入侧（`workers/lib/bus-apply-core.cjs`）：新增 `validateTaskRow()` —— 行必须是已登记 op；
    create 行要求 `isTaskId(task.id)` + `contract.validateGraph(task.graph)`（缺失 graph 仍合法）；
    update 行要求 `task_id` 形态 + `status` 枚举；其余行要求 `task_id` 形态。
  - 枚举收敛：`TASK_ROW_OPS` / `TASK_ROW_STATUSES` 移入 `workers/lib/bus-contract.cjs` 并导出
    （经 `bus-contract.mjs` 门面），`validate-bus.mjs` 与 applier 共用一份定义（不再两处硬编码漂移）。
  - 读取侧（`workers/graph/task-ready.mjs`）：artifact 用 `path.resolve` 解析后以 `path.relative`
    做包含性检查（必须在 `tasks/<id>` 或 `tasks/<id>/result` 内，`..`/绝对路径/跨盘符一律判不存在）；
    `taskId` 也先过 `isTaskId`（旁路改台账同样不留预言机）。
- **测试**：`tests/bus-apply.test.mjs`（create 穿越 id 被拒且不落盘、非法 graph 写入即拒、
  update status 枚举、非法 op/task_id 被拒、合法 create+update 照常写入）；
  `tests/task-graph.test.mjs`（起 task-ready CLI + 文件重定向抓输出：穿越 artifact 指向**真实存在**的
  工作区文件也必须判「缺失」；合法 `tasks/<id>/result/` 产物不被误伤；非法 taskId 不许拼路径）。

### 1.5 da827 — validate-bus 日志净化（P3 加固）

- **问题**：`validate-bus` 的 `fail()` 把总线数据（tasks.jsonl 的 `op` / `status`、status.json 的
  `state` 等）直接插进 `console.error`；JSON 里 `\n`/`\u001b` 转义经 `JSON.parse` 还原成真控制字符，
  可伪造日志行 / 注入 ANSI 控制序列（CWE-117）。
- **修法**：新增 `workers/lib/log-safe.cjs`（`logSafe()`：CR/LF/TAB 转 `\r\n\t` 可见转义，其余
  C0/C1 控制字符转 `\xNN`）；`validate-bus.mjs` 的 `fail()` 在**唯一汇点**对 `where` / `msg` 统一
  转义（按「汇点」修，新增插值点不会漏）。退出码与真实摘要不变。
- **测试**（`tests/bus-integration.test.mjs`）：换行/回车/TAB/ESC 均被转义、普通中文不改写、
  与 fail() 同构的拼接行不含真实换行或 ESC。

## 2. 测试

本线测试命令（`dsh-miasaki-fleet/package.json` 的 `test` 链 = 8 个既有测试文件 + fleet-panel 两个，
fleet-panel 为用户未提交文件、本批未改）+ 线级闸门：

```bash
cd dsh-miasaki-fleet
node tests/liveness.test.mjs && node tests/bus-contract.test.mjs && node tests/bus-apply.test.mjs \
  && node tests/bus-integration.test.mjs && node tests/task-graph.test.mjs \
  && node tests/capability-graph.test.mjs && node tests/verifier.test.mjs \
  && node tests/fleet-monitor.test.mjs \
  && node plugins/dsh-fleet-panel/test/host.test.mjs && node plugins/dsh-fleet-panel/test/client.test.mjs
node workers/validate-bus.mjs
```

结果（2026-10-20 实跑）：

- 单测：liveness 9 / bus-contract 26 / **bus-apply 27**（16 → 27，+11：临时名 3 + tasks.jsonl 写入
  校验 4 + 跨进程锁 4）/ bus-integration **18**（17 → 18，+1 日志净化）/ task-graph **14**（13 → 14，
  +1 穿越用例）/ capability-graph 17 / verifier 29 / **fleet-monitor 29**（26 → 29，+3 请求体上限）
  / fleet-panel host 9 / client 5 —— **全部 PASS**。
- `node workers/validate-bus.mjs`：`[validate] done: 36 文件通过，0 错误`。
- 仓库级闸门（本批改动的文件）：`node scripts/check-silent-guards.mjs` → 新增 0 / 可回收 0；
  `node scripts/check-style.mjs` → 新增 0。
- `node scripts/verify-all.mjs fleet` → **25/25 PASS**。

## 3. 遗留 / 风险（需后续决定）

1. **锁文件未入库忽略**：`state/.bus-apply.lock` 正常在 `finally` 删除；若 applier 被强杀，会留下
   一个锁文件（60s 后按 stale 回收，功能上自愈），但 `git status` 会短暂出现未跟踪文件。建议在
   根 `.gitignore` 增加一行 `dsh-miasaki-fleet/state/.bus-apply.lock`——本批按范围纪律**未改根文件**。
2. **锁超时的调用方语义**：dispatcher 的 usage 行在 applier 非 partial 失败时会回退直写（保住计量，
   既定设计），锁超时同样走该回退；事件写入只告警（既定策略）。如需更严格，可让派单器对 exit 4
   重试一次（本批未改 PowerShell）。
3. **预期版本占位的旧窗口仍在**：CLI 在拿锁前填充 `expected_version=-1`，两个调用方可能拿到同一值；
   锁内版本检查会把它变成显式冲突（exit 3，可重试），不再产生重复 bus_version —— 这是本批要的目标；
   但「自动重读后重提」仍未做（调用方各自决定）。
4. **ee40d（围栏跨端口）按 FIX-SPEC §0 不修**：`panel.html` 回退直连 `127.0.0.1:39801` 是**设计支持
   的跨端口用法**，收紧围栏会破坏它 ⇒ 保留为设计取舍（本批未动围栏）。
5. 6e766 的写入侧校验只覆盖**经唯一入口**的写入；直接改 `state/tasks.jsonl` 的旁路仍可能写入非法行，
   但读取侧包含性检查（本批）已让该旁路无法获得存在性预言机；巡检侧仍会报（`validate-bus` 对
   `create.task.id` 只查非空 —— 若要一并收紧可复用 `isTaskId`，本批未改以避免扩大行为变更）。
