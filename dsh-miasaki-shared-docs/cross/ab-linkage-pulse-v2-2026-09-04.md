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

## 写者

`dsh-miasaki-fleet/workers/pulse/publish-pulse.mjs`（node，零依赖，
聚合语义与 `fleet-monitor/server.js` 对齐，BOM 容错，原子写 temp+rename）：

```bash
node workers/pulse/publish-pulse.mjs                 # 单次发布
node workers/pulse/publish-pulse.mjs --interval-ms=5000  # 常驻发布
```

建议由 Commander 会话或计划任务常驻执行（5s 间隔）；dispatch 派单前后各发布一次亦可。

## 读者（X2 桌宠侧，待实施）

首选 Rust watchdog 直读聚合文件（路径 B，无 DOM 开销），经 `PetShared` 现有
`activity`/`waiting_approval` 字段复用；前端轮询 monitor `/api/fleet` 为备选。
优先级：`fleet_error/blocked > waiting_approval(DSH审批) > fleet_running > busy > intensity`。

## 附带修复

`fleet-monitor/server.js` 的 `safeReadJSON/safeReadJSONL` 未剥 BOM，
本机 PowerShell 生成的 manifest/registry 全带 BOM → 面板此前静默跳过全部
agent（`JSON.parse` 抛错被 catch 吞掉）。已加 `stripBom` + `\r\n` 切分，
与发布器同口径。
