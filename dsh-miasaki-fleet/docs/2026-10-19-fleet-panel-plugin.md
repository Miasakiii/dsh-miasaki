# fleet 面板的 DSH 入口插件（P0：看得见）

- 日期：2026-10-19 建文；**2026-10-20 形态调整**（用户反馈：不要挤占侧栏「用量统计」，改为会话级入口）
- 状态：P0 已实现（host 9 例 + client 6 例；`verify-all fleet` 25/25）
- 前置：`fleet-monitor/`（面板数据层，P1 判定层上屏 + 三道信任围栏已验收，见 README「总控制面板」节）

## 1. 问题

面板**已经存在**（`fleet-monitor/panel.html` + `server.js`，127.0.0.1:39801：agent 卡片 / 成本报表 /
可派集 / 能力断层 / 事件流 / 验证者覆盖），但用户的实际结论是「没面板，看不到情况」。三个原因：

1. **不常驻**：要手动 `node fleet-monitor/server.js`，无自启、无守护；
2. **无入口**：它是独立网页，不在日常 DSH 界面里，也没有桌面/托盘入口；
3. **无主动提醒**：P2 告警（心跳丢失 / 预算 80% / 硬超时 / 开关与进程不一致）尚未实现。

P0 只解决第 1、2 条：**让面板常驻跟随 DSH，并给它一个随手可点的入口**。数据层与判定口径一律不动。

**2026-10-20 形态调整（用户反馈）**：第一版入口是「侧栏脚部按钮 + 全局浮窗」，实测挤占了侧栏
「用量统计」按钮的位置，被用户否掉。现改为**会话视图 tab「Fleet」**（`conversation.view`，
`order: 16`，排在「用量」的 15 之后），每个会话各自渲染一个独立视图实例。

## 2. 目标与非目标

**目标**：在 miasaki 桌面端打开 DSH 后，会话视图 tab 栏出现「Fleet」（位于「用量」之后）；
点开 ≤2s 看到与 `fleet-monitor` **同源**的实时数据；monitor 不在跑时自动拉起；挂掉时可重试、有可读原因；
**每个会话都能各自打开一个独立实例**（切会话不共享同一个 iframe）。

**非目标（P0 明确不做）**：

- 不重写面板 UI（iframe 复用 panel.html；视觉统一留 P1）；
- 不合并服务、不替代 `fleet-monitor`（浏览器直连 39801 的旧用法保留）；
- 不实现告警（P2）；
- **不做 per-session 数据隔离**：fleet 数据层仍是全局单例（一套文件总线 / agent 池 / 台账），
  本 tab 是「每个会话独立的查看入口」；真正的「每会话专属 fleet」需给台账与派单加 session 维度，
  属独立设计。

## 3. 方案对比与选择

| 方案 | 形态 | 改动 | 判定 |
|---|---|---|---|
| A 独立页 + 启动项/书签 | 现成 panel.html | 极低 | 能看到，但要切窗口、无 DSH 内入口；仅作兜底 |
| B 桌面壳托盘 + 自动 spawn | 托盘入口 + 浏览器页 | Rust + 重编/签名/部署 | 体验好但部署链长；留 P2 |
| **C DSH 插件 + iframe（选中）** | **会话视图 tab（用量之后）+ 每会话独立实例** | 仅插件 + profile 安装 | **不重编壳、打开会话即见、复用已验收 UI、不占侧栏** |
| D DSH 原生面板（官方 primitives 重绘） | 同 C，视觉统一 | 1–2 天 UI | 正确终态，但 P0 不做（先解决「看不到」） |

选 C 的额外理由：仓库已有同类范式 —— [usage 线](../../dsh-miasaki-usage/lib/client.js) 的
`conversation.view` 会话 tab（`order: 15`，label「用量」），以及 host 半的
`ctx.webServer.register`（`kind: 'prefix' | 'exact'`，原生 `(req, res)` handler）。
本插件沿用同一对范式，只是 tab 排在用量之后；视图在 2026-10-20 由 iframe 改为**原生渲染**。

## 4. 架构

```
DSH 会话视图 (127.0.0.1:3080)
  ├─ tab 栏：对话 / 轨迹 / 用量(order 15) / Fleet(order 16)
  └─ client 半（lib/client.js，conversation.view → FleetView，**原生渲染**）
       ├ 每个会话各渲染一份 FleetView（各自轮询：fleet 3s / 判定层 12s）
       ├ 顶部工具条：monitor 状态点 + 刷新 + 「会话级入口 · 全局编排器」
       └ 可滚动内容区：统计 6 卡 / 判定层 4 卡 / Agent 卡片（含开关）
            fetch /dsh-fleet/{health, api/fleet, api/dispatchable, api/gaps, api/events, api/verifiers}
             │
             ▼
  host 半（lib/index.js，DSH 进程内）
   ├ /dsh-fleet/health   → 探活/拉起 monitor（应用层判据：GET /api/fleet 可解析 JSON）
   ├ /dsh-fleet/panel    → 读 panel.html 并改写（**仅供浏览器嵌入/调试**；判定层 4 处路径一并改写）
   └ prefix /dsh-fleet/api → 原样代理到 127.0.0.1:39801/api/*
        │
        ▼
  fleet-monitor（127.0.0.1:39801，独立 Node 服务，口径单点）
```

**为什么不用 iframe（2026-10-20 调整）**：iframe 内是独立文档，不继承 DSH 的 `--dsw` 主题变量
⇒ 视觉不统一；且 iframe 高度固定后里页滚不动。改为原生渲染后两个问题同时消失，数据仍走同一套
同源代理（`/dsh-fleet/api/*`），判定口径不变。`/dsh-fleet/panel` 保留给浏览器嵌入/调试，其判定层
四块原本用绝对路径 `j('/api/…')`（只改 API 基址会漏），现一并改写为 `/dsh-fleet/api/…` ——
否则请求打到 DSH 自身 `/api/*`（返回 `not found` 文本）⇒ 面板 `JSON.parse` 报
`SyntaxError: Unexpected token 'o'`，四块全显示「不可用」（2026-10-20 实机截图即此形态）。

**同源代理的理由**：直连 39801 是跨源，依赖 DSH 页面 CSP 允许 `frame-src`/`connect-src`，
且 panel.html 内 fetch 的 Origin/围栏口径要另做适配；同源代理后原生面板与 API 都是 DSH 源。
代价是 host 半多一层代理（约 100 行），但换来确定性 —— 与「静默失效优先消灭」的仓库纪律一致。

**围栏**：三条路由都过 `lib/fence.js`（与 appearance / ssh / sidebar / dual-model / free-model /
usage 同构）：Host 只认环回、拒绝 `sec-fetch-site: cross-site`、Origin/Referer 存在时必须与 Host 同名。
围栏**先于业务**：跨站 `POST /dsh-fleet/api/toggle/*` 得到 403，不触碰 monitor 的写接口（会落盘 control.json）。

## 5. 失败语义（不静默）

| 场景 | 行为 |
|---|---|
| monitor 已在跑 | health 返回 `{ok:true, reused:true}`，不重复拉起 |
| monitor 不在跑 | 隐藏窗口拉起，轮询到就绪（6s 上限）；失败时 health 返回 `ok:false` + 可读原因 |
| panel.html 锚点漂移 | `/dsh-fleet/panel` 返回 500 + 原因（**拒绝静默返回原页面** —— 否则 iframe 内数据全空） |
| 代理上游不可达/超时 | 502 + `{ok:false,error}`；超时 10s；请求体 >1MB 拒绝（413） |
| 本插件拉起的 monitor | 插件 dispose / 进程退出时回收；**复用别人的实例不动** |

## 6. 验收判据

**自动**（已并入 `verify-all fleet`，25/25）：

1. `plugins/dsh-fleet-panel/test/host.test.mjs` **10 例**：真实 panel.html 锚点改写命中、判定层
   4 处绝对路径一并改写（防 `not found` 文本 → `JSON.parse` 报 SyntaxError）、锚点缺失抛错、
   代理路径映射（含越界拒绝）、围栏矩阵、apply 注册三条路由、health 降级如实、围栏先于业务；
2. `plugins/dsh-fleet-panel/test/client.test.mjs` **7 例**：bundle 自声明 module、apply/inject、
   **只注册 `conversation.view` 且 order 16 / label Fleet**、**不再注册侧栏按钮与浮窗**（防回退）、
   **原生渲染（无 iframe、无 window.open）**、数据源路径（fleet/dispatchable/gaps/events/verifiers）、
   视图渲染含可滚动内容区与会话级提示、样式只走 `--dsw` 令牌；
3. 语法闸门两项（host / client）。

**实机**（用户重启 DSH 后端 / 桌面端后）：

1. 会话视图 tab 栏出现「Fleet」，位于「用量」之后；点开显示统计卡 / 判定层 / Agent 列表；
2. 首次打开时 monitor 未运行 ⇒ 自动拉起；工具栏状态点为绿、文案「monitor 已就绪」；
3. **内容区可滚动**（agent 卡或判定层内容超出时可滚到底）；
4. **主题跟随三主题**（切换主题/明暗后卡片与文字颜色跟随，无独立暗色块）；
5. **判定层四块有数据**（不再出现 `SyntaxError: Unexpected token 'o'` 的「不可用」）；
6. 切到另一个会话 ⇒ 该会话的 Fleet tab 同样存在且能独立打开（各会话各一个实例）；
7. agent 开关可操作（经代理到 monitor 写接口），事件流出现对应超步；
8. 侧栏脚部**不再**出现 Fleet 按钮（「用量统计」原样保留）；**没有「在浏览器打开」按钮**
   （完整面板地址以文本给出）；
9. 关掉 DSH / 退出桌面端 ⇒ 39801 无残留监听；
10. 跨站请求（伪造 Origin/跨站 fetch）被 403（可用浏览器控制台或 curl 复核）。

## 7. 边界与后续

- **视觉**：2026-10-20 起为**原生渲染**（官方 `--dsw` 令牌 + 设置页规格），跟随三主题；
  剩余 **P2 四条告警**（心跳丢失 / 预算 80% / 硬超时 / 开关与进程不一致）未做。
- **完整报表**：成本报表 / 年热力图仍在 fleet-monitor 页（浏览器打开 `http://127.0.0.1:39801/`），
  本 tab 只做实时概览与开关操作（地址在视图底部以文本给出）。
- **进程生命周期**：monitor 跟随 DSH 进程；复用别人拉起的实例时不回收（多 host 场景下最后一个
  拥有者退出后由下一次 health 重新拉起）。进程托管器（跨会话常驻监督）仍不在本线范围。
- **会话级入口 ≠ 会话级数据**：tab 按会话独立渲染，但 fleet 是全局单例；若要做「每会话独立
  fleet 编队」，需要给 `tasks.jsonl` / 派单 / 面板加 session 维度并定义隔离语义，属独立设计。
- **安装边界**：改的是用户 profile（`~/.dsh/profiles/miasaki`），按仓库纪律须用户确认；
  `link:` 安装（`file:` 会装成快照、改源码不生效）。

## 8. 变更记录

- 2026-10-19 建文并落地 P0：插件骨架（host/client/fence）、两个测试文件、`verify-all fleet`
  21 → 25 项、fleet README 与回归清单更新、miasaki profile 安装指引。第一版入口为
  「侧栏脚部按钮 + 全局浮窗」。
- 2026-10-20 形态调整（用户反馈「不要挤占用量统计按钮，放到会话窗用量后面，做成会话级的」）：
  删除 `sidebar.footer.action` 与 `shell.overlay` 注册，改为 `conversation.view`（order 16，label Fleet）；
  每会话独立视图实例；client 测试 5 → 6 例（新增注册形态与防回退断言）；文档同步。
- 2026-10-20 第二轮调整（用户反馈「界面设计语言不统一，里页无法滚动」；截图另见判定层四块报
  `SyntaxError`、「在浏览器打开」按钮无效）：视图由 iframe 改为**原生渲染**（统计 6 卡 / 判定层 4 卡 /
  Agent 卡片，官方令牌，内容区可滚动）；移除无效的 `window.open` 按钮；host 半 `rewritePanelHtml`
  补判定层 4 处绝对路径改写（`/dsh-fleet/panel` 仅作浏览器嵌入/调试）；client 测试 6 → 7 例、
  host 9 → 10 例；fleet 用例 212 → 214；集成探针实测 5 端点 200 JSON、panel 页 4 处路径改写、
  POST 代理可用、停止后 39801 无监听。
