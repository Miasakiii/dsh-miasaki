# @miasaki/dsh-fleet-panel — fleet 监控的 DSH 入口（P0）

> 2026-10-19 落地；**2026-10-20 两次调整**：
> ① 入口从「侧栏脚部按钮 + 全局浮窗」改为 **会话视图 tab**（排在「用量」之后），不挤占侧栏的
>    「用量统计」按钮，每个会话各自一个独立视图实例；
> ② 视图从 iframe 嵌 panel.html 改为 **原生渲染** —— 解决「界面设计语言不统一」与「里页无法滚动」，
>    同时修掉判定层四块因绝对路径未加同源前缀而显示 `SyntaxError` 的实机缺陷。
> **P0 只做「看得见」**：数据仍全部来自 fleet-monitor 的现成端点（判定口径单点不变）。

## 形态

- **入口**：会话视图 tab「Fleet」（`conversation.view`，`order: 16`，紧跟「用量」的 15）。
  点开即在该会话视图内渲染面板；切到其它会话时各会话各自渲染一份（各自轮询）。
- **视图（原生渲染，无 iframe）**：顶部工具条（monitor 状态点 / 刷新 / 会话级标记）+
  **可滚动内容区**：
  - 统计 6 卡：在线 / 已启用 / 活跃任务 / 今日成本 / 可派 / 终态；
  - 判定层 4 卡：可派集（带不可派原因）/ 能力断层 / 验证者覆盖 / 最近机器事件；
  - Agent 卡片：状态点 + 开关（写 `control.json`）+ model/state/版本 + 今日成本/tokens/任务 +
    skills + 心跳；支持「全部开启 / 全部关闭」。
- **样式**：只用官方 `--dsw` 令牌与设置页规格（卡片 / 行距 / 12–14px 字号），跟随三主题；
  **不使用 `window.open`**（桌面壳 WebView2 不处理，旧「在浏览器打开」按钮已移除）。
- **数据**：`/dsh-fleet/api/*` 由 host 半原样代理到 `127.0.0.1:39801/api/*`；
  **不重写任何判定** —— 可派集/能力断层/事件流/验证者的口径全部留在 `fleet-monitor`
  （它 spawn 现成 CLI，与派单器判定同源）。
- **「会话级」的边界（重要）**：入口确实是会话级的（每个会话一个视图实例），但 **fleet 数据层
  仍是全局单例**（一套文件总线 / agent 池 / 任务台账）。真正的「每个会话专属 fleet」（按会话
  隔离的任务编队）需要给台账与派单加 session 维度，属独立设计，不在本批。

## host 半职责

1. **确保 monitor 在跑**：先 `GET 127.0.0.1:39801/api/fleet` 探活（判据是应用层 JSON，不是 TCP 端口通）；
   已在跑就复用（不重复拉起）；不在跑就以隐藏窗口拉起 `fleet-monitor/server.js`。
   **只有本插件拉起的实例才由本插件回收**（复用别人的不动）；插件卸载 / 进程退出时回收。
2. **同源代理 / 托管**：
   - `prefix /dsh-fleet/api` → `/dsh-fleet/api/xxx` 映射到 `/api/xxx`，转发 method/header/body
     （原生面板的 fleet / dispatchable / gaps / events / verifiers / toggle 全部走它）。
   - `GET /dsh-fleet/health` → 探活/拉起状态（视图首屏与重试入口）。
   - `GET /dsh-fleet/panel` → 读 panel.html 并改写后返回，**仅供浏览器嵌入/调试**（原生面板不再用它）。
     改写两处：API 基址锚点 → `/dsh-fleet`；判定层四块 `j('/api/…')` → `j('/dsh-fleet/api/…')`
     （漏改会打到 DSH 自身 `/api/*`，返回 `not found` 文本 ⇒ 面板 JSON.parse 报 SyntaxError）。
3. **三道信任围栏**（`lib/fence.js`，与 appearance / ssh / sidebar / dual-model / free-model / usage 同构）：
   Host 只认环回、拒绝 `sec-fetch-site: cross-site`、Origin/Referer 存在时必须与 Host 同名；
   围栏**先于业务**（跨站 `POST /dsh-fleet/api/toggle/*` 得到 403，不会触碰 monitor 写接口）。

## 安装（miasaki profile）

`~/.dsh/profiles/miasaki/package.json`：

```json
{
  "dependencies": {
    "@miasaki/dsh-fleet-panel": "link:<仓库根>/dsh-miasaki-fleet/plugins/dsh-fleet-panel"
  },
  "dsh": { "profile": { "bundles": [ "…", "@miasaki/dsh-fleet-panel" ] } }
}
```

然后在该 profile 目录 `pnpm install`，重启桌面端（或 DSH host）生效。
`node_modules/@miasaki/dsh-fleet-panel` 的 `LinkType` 必须是 `Junction`（用 `file:` 会装成快照、改源码不生效）。

## 测试与回归

```bash
cd dsh-miasaki-fleet
node plugins/dsh-fleet-panel/test/host.test.mjs       # 10 例：锚点与判定层路径改写 / 代理路径 / 围栏 / 路由注册 / 降级
node plugins/dsh-fleet-panel/test/client.test.mjs     # 7 例：module 自声明 / conversation.view(order 16) / 原生渲染(无 iframe、无 window.open) / 数据源路径 / 滚动容器 / 令牌纯度
node ../scripts/verify-all.mjs fleet                  # 全量（含本插件 4 项检查）
```

## 边界（P0 明确不做）

- **完整报表仍在 fleet-monitor 页**：成本报表 / 年热力图等不在本 tab 内，浏览器打开
  `http://127.0.0.1:39801/` 即可（本 tab 内以文本给出地址）。
- **数据层不变**：不替代 `fleet-monitor`，不合并服务。
- **单实例只做「探测 + 复用」**：不引入锁文件；若两个 host 同时启动，后者探测到前者即复用。
- **进程托管**：monitor 由 DSH 进程生命周期携带；DSH 被壳 Job 回收时随之回收（复用实例不受影响）。
- **不做 per-session 数据隔离**：本 tab 是每个会话独立的查看入口，展示同一份全局 fleet 状态。
- **P2 告警未做**：心跳丢失 / 预算 80% / 硬超时 / 开关与进程不一致四条告警规则仍待实现。
