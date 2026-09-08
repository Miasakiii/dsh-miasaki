# A×B 联动契约：fleet-pulse.json v2（实施记录，2026-09-04）

前文：`ab-linkage-pet-fleet-status-2026-08-18.md`（Draft 聚合器方案）、
`ab-linkage-pet-fleet-status-impl-2026-08-30.md`（A 侧 DOM 扫描落地、B 暂缓）。
本文为 B 侧契约落地，桌宠 Fleet 指示器（X1/X2）的前置。

## 契约（唯一 A×B 文件接口）

路径：`dsh-miasaki-fleet/state/fleet-pulse.json`（运行时产物，已 ignore，不入库）。

```json
{"v":2,"ts":"2026-09-04T07:40:08Z",
 "fleet":{"online":4,"running":0,"waiting_approval":0,"blocked":0,"error":0},
 "today_cost":0.0,"top_task":null}
```

字段：`v` 恒 2；`ts` ISO；`fleet` 五计数（online=enabled+alive，
running/blocked/error 取 `status.json`，waiting_approval 为 running 中
step 命中审批关键词的启发式计数，dispatch 结构化标记落地后转精确值）；
`today_cost` 当日 usage 成本和（UTC 口径，与 monitor 一致）；
`top_task` 首个 running 任务 id 或 null。
Schema：`dsh-miasaki-fleet/schemas/pulse.schema.json`，
`node workers/validate-bus.mjs --strict` 强制存在。

## 心跳判活（F3，2026-09-07 补充）

`fleet.running` / `online` **不是直接读 status.state**，而是经
`workers/lib/liveness.cjs` 判活后的修正值：`running/draining` 若心跳过龄
（`limits.heartbeat_ms × 3`，默认 90s）则降级为 `unknown`，不再计入
running/online。原因：worker 崩溃后遗留的 `status.json` 仍是合法 `running`，
若直接计会让 fleet 永远显示在跑、桌宠永远「忙碌中…」——陈旧数据比没有数据
更危险。发布器在降级时打 `[pulse] <id>: ... → 降级为 unknown` 警告。

附加字段 `stale_agents`：本次心跳过龄被降级的 agent 数。**不改五计数契约**，
旧读者忽略即可；面板与排查用它区分「真空闲」与「疑似崩溃」。

## 写者

`dsh-miasaki-fleet/workers/pulse/publish-pulse.mjs`（node，零依赖，
聚合语义与 `fleet-monitor/server.js` 对齐，BOM 容错，原子写 temp+rename）：

```bash
node workers/pulse/publish-pulse.mjs                 # 单次发布
node workers/pulse/publish-pulse.mjs --interval-ms=5000  # 常驻发布
```

建议由 Commander 会话或计划任务常驻执行（5s 间隔）；dispatch 派单前后各发布一次亦可。

## 读者（X2 桌宠侧，已实施）

首选 Rust watchdog 直读聚合文件（路径 B，无 DOM 开销），经 `PetShared` 现有
`activity`/`waiting_approval` 字段复用；前端轮询 monitor `/api/fleet` 为备选。
优先级：`fleet_error/blocked > waiting_approval(DSH审批) > fleet_running > busy > intensity`。

### 时效语义（stale，2026-09-07 补充）

**`ts` 是消费侧的必检字段，不只是记录用。** 读者必须按龄期判定新鲜度：

| 条件 | 判定 | 桌宠表现 |
|---|---|---|
| 龄期 ≤ 30s | fresh | 按五计数正常映射 |
| 龄期 > 30s | **stale** | 等同「不可用」→ fleet 指示关闭 |
| `ts` 缺失 / 不可解析 | stale | 同上 |
| 未来时间戳（超前 > 30s） | stale | 同上（时钟回拨或跨机复制的文件不可信） |
| `v != 2` / 缺 `fleet` / 非 JSON | 不可用 | 同上 |

阈值 30s = 发布器建议间隔 5s 的 6 倍，留足抖动余量；实现见
`dsh-miasaki-desktop/src-tauri/src/main.rs` 的 `PULSE_STALE_SECS`。

**为什么必须检**：发布器（常驻 `--interval-ms`）一旦崩溃或被杀，文件仍留在盘上、
内容仍是合法 v2 JSON，此前的读者会把它当作实时状态——桌宠因此永远停在最后一帧
「忙碌中…」或「需要你的批准」，且不产生任何告警。这是「陈旧数据比没有数据更危险」
的典型情形，故 stale 与文件缺失同等处理。

日志区分两种不可用（便于排查）：`文件不存在` / `存在但不可用（stale/格式错误）` /
`未配置 MIASAKI_FLEET_PULSE`。

回归覆盖：`cargo test --bin miasaki`（4 项，含 ISO-8601 解析、五计数映射、
stale 边界 29s/31s、BOM 与畸形输入降级）。

## 附带修复

`fleet-monitor/server.js` 的 `safeReadJSON/safeReadJSONL` 未剥 BOM，
本机 PowerShell 生成的 manifest/registry 全带 BOM → 面板此前静默跳过全部
agent（`JSON.parse` 抛错被 catch 吞掉）。已加 `stripBom` + `\r\n` 切分，
与发布器同口径。
