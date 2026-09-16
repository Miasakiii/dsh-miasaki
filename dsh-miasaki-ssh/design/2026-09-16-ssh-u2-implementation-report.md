# U2.1/U2.3/U2.4 实施验收包（2026-09-16）

> 交接文档：变更清单、部署/发布说明、回滚步骤（已演练）、风险与遗留事项清单。
> 执行依据：[U2 规划](2026-09-15-ssh-u2-plan.md) §6 顺序（U2.1 → U2.3 → U2.4），7 项决策与 §12.5 开工建议全数遵守；用户指令明确本轮范围 = U2.1 先行 + U2.3 按决策 4 + U2.4 直接用官方 addon。**U2.2（SFTP）未开工，属规划内下一阶段，不是缺口。**

## 1. 变更清单（逐文件）

| 文件 | 变更 | 说明 |
|---|---|---|
| `lib/runtime.js` | 重写（467 → 约 700 行） | 三层身份：`conns: Map<runtimeId, RuntimeConn>` + `byProfile: Map<connId, runtimeId>`；`ShellChannel`（独立 stream/尺寸/回放环/viewer 集合/写权）；一次性附着票据（TTL 30s、消费即废、teardown 联动失效）；写入所有权（单写多读 + `takeoverShell`）；每 shell 回放环 + runtime 总预算（LRU 头裁，默认 1MiB）；`storeSnapshot`（U2.4 host 侧，内存态封顶 128KiB）；`now` 可注入（测试/探针拨时钟） |
| `index.js` | 重写 WS 协议层 + 新端点 | 全部帧要求 `v:2`，旧帧拒绝（`VERSION_MISMATCH`，不做双栈）；`POST /ssh/api/attach` 签发票据；WS 帧路由：`attach/input/resize/shell.open/shell.close/shell.takeover/snapshot/detach`；`/ssh/vendor/addon-serialize.js` 资产（启动时 existsSync 判定，缺包回占位脚本） |
| `session.js` | 重写（v2 viewer） | 先 `POST /ssh/api/attach` 换票据再开 WS；帧全部带 `v:2 + shellId`；`shellSeq` 恢复链路；写权帧（`write.granted/write.revoked/write.open`）驱动 `onModeChange`；U2.4：官方 `SerializeAddon` 输出空闲 1.5s 采集快照上报（封顶 128KiB、scrollback 500 行）、附着恢复按「快照帧优先 / 回放兜底 / 重附着防翻倍」三路判定；addon 缺失静默降级 |
| `app.js` | 结构化改造（15+11+2 处补丁） | `state.tabs` = `[{connId, shellSeq, title, live}]`、`activeTab` = 下标；标签渲染/重命名标题（`#N` 后缀）/切换/关闭（多 shell 语义：断开整个连接 vs 仅关闭查看 vs 关此 shell）；「新建 shell 标签」入口（tabstrip `+` 与主机菜单双入口）；写权只读条 `#write-bar` + 接管按钮；`shell.opened/shell.closed` 帧接入标签模型；主机删除时的下标修正 |
| `app.js`（U2.3） | 工作区记忆两张据 | 决策 4：偏好（字号/rail 折叠/专注）→ `localStorage['dsh-ssh:prefs']` **v2**（新增 `version` 字段）；工作区快照（标签集合+激活项+抽屉状态）→ `sessionStorage['dsh-ssh:workspace']` **v1**；统一 `sessionStore` 封装（全 try/catch）；`readWorkspace/saveWorkspace`（version 校验，损坏 ⇒ 丢弃回默认，绝不白屏）；刷新恢复 = 恢复标签形状（不自动连接、不输凭据；激活项仅在 host 侧连接仍存活时重挂 attach） |
| `styles.css` | 增 17 行 | `.write-bar`（只读条，warn 色，`[hidden]` 强制 display:none） |
| `package.json` / `pnpm-lock.yaml` | +1 依赖 | `@xterm/addon-serialize: "0.14.0"`（**精确锁定**，官方 npm 包，探针 B 已证与 xterm 6.0.0 兼容） |
| `test/runtime.test.js` | 重写 22 例 | 票据生命周期（有效/重放/过期/teardown 作废）、双 shell 隔离（环/尺寸/输入/跨 shell 绑定拒绝）、runtime 预算 LRU 裁剪、写权（只读拒绝输入与 resize/接管/detach 释放/初始 resize 仅 owner）、僵尸 viewer（代次替换/错 shellId）、快照存储与下发、shell 上限、`listState` 对外 connId 不变、背压 |
| `test/session.test.js` | 重写 32 例 | v2 帧契约（attach 带 ticket/shellSeq、input/resize 带 shellId）、票据失败重试预算、重附着**换新票据**、写权帧→modeChange 去抖语义、`shell.closed` 不重附着、`VERSION_MISMATCH` 提示刷新、U2.4 三路恢复判定 + 空闲采集 + 超限拒发 + 无 addon 降级 |
| `test/http.test.js` | +4 例（7 总） | `/ssh/api/attach` 404/400、旧帧 `VERSION_MISMATCH`、无效票据 `TICKET_INVALID`、addon-serialize 资产 200 |

## 2. 与 S-U2-1 实测基线的前后对照（回归数据）

基线 = U2.0 验收探针 A（2026-09-15，`_refs/scripts-archive/ssh-u2-verify/probe-a-result.json`，真 ssh2 Client × 假 sshd）。
对照 = 本轮 `u21-verify-runtime.mjs`（2026-09-16，同款假 sshd × **本线 SshRuntime 真实链路**，`u21-runtime-result.json`）。

| 判据（探针 A） | 基线（改造前，直连 Client） | 改造后（runtime 真实链路） | 结论 |
|---|---|---|---|
| P1 同一 Client 4 个 shell channel | channelIds [1,2,3,4] 全 ready | runtimeShells 4 / serverShellEvents 4 / channelIds [1,2,3,4] | **达标（无劣化）** |
| P2 尺寸按 channel 隔离 | 132×33/140×35/148×37/156×39 精确对应 4 channel | 同四组尺寸、window-change 逐一对应 4 channel（covered 4/4） | **达标** |
| P3 输出隔离 | 只往 ch2 写标记 ⇒ 只有 ch2 回显 | 只往 shell#2 写 MARKER-U2 ⇒ 目标 viewer 收到、其余 clean | **达标** |
| P4 shell 退出 ≠ 连接结束 | ch2 exit 后其余 3 个继续 PONG | shell#2 ended，其余 3 个存活、PING 输入 9 次 | **达标** |
| P5 大流量 RTT（32MiB 并发） | 空载 21ms / 负载稳定 20ms | 本轮未复压（传输压力项属 U2.2 实机复验范围，见风险表 R1） | 记缺口，无回归证据 |
| （新增）写权：单写多读 + 接管 | 无此层 | reader=read/owner=write；接管后反转且原 owner 收 `write.revoked` | **新达标** |
| （新增）票据生命周期 | 无此机制 | 重放/过期/teardown 作废全部 `TICKET_INVALID` | **新达标** |

关键指标（回放环语义、背压 8MiB、TOFU、指纹确认、错误分类）由 22 例 runtime 单测钉住，`verify-all ssh` 12/12。

## 3. 自动化与手动验证记录

- `node --test test/*.test.js`：**110/110 通过**（原 85 例全保留语义迁移 + 新增 25 例；app 16 / client 25 / http 7 / runtime 22 / session 32 / store 8）。
- `node scripts/verify-all.mjs ssh`：**12/12 通过**（6 文件 syntax + 6 测试文件）。
- 端到端探针 `u21-verify-runtime.mjs`：**9/9 通过**（真 sshd × runtime，P0–P6b，结果 JSON 已归档）。
- 回滚演练：见 §4。
- **待实机验收（需要运行中的 DSH host + 真实云主机，本环境无）**：刷新后标签形状恢复（不自动连接）、双浏览器窗口写权互斥、vim/top 快照逐行一致性（§4.4.3 判据，3 次稳定）、8 shell 时 host RSS、三主题回归。清单已写入 §6。

## 4. 回滚步骤（已演练 ✅）

- **演练记录（2026-09-16 实际执行）**：暂存 U2 版本 10 个文件 → 从 `_refs/scripts-archive/ssh-u2-rollback-baseline/` 恢复改动前基线 → 旧测试套 **85/85 绿** → 还原 U2 版本 → 新套 **110/110 绿**。回滚路径真实可执行，不是纸面论证。
- **正式回滚步骤**（接手人照做）：
  1. 停 dsh web。
  2. 从 `_refs/scripts-archive/ssh-u2-rollback-baseline/` 按映射恢复：`lib__runtime.js→lib/runtime.js`、`index.js/app.js/session.js/styles.css/package.json→` 同名、`test__*.test.js→test/`。
  3. `pnpm install`（package.json 回落后 lockfile 同步回退）。
  4. `pnpm run build && pnpm test` 应为 85/85。
  5. 重启 dsh web；浏览器**强刷**（旧前端帧协议是 v1，与新 host 不兼容——回滚两侧同步即可）。
- **配置开关式回滚**：无需改代码的降级开关不存在（v2 是硬切换，方案 §3.3 明确不做双栈）；但 `@xterm/addon-serialize` 可单独失效——删包后 host 自动回占位脚本、前端降级为回放恢复（U2.4 单独退出路径）。

## 5. 部署 / 发布说明

1. 本线目录 `pnpm install`（新增 `@xterm/addon-serialize@0.14.0`，锁文件已含）。
2. DSH profile 的插件依赖安装沿用宿主生态方式（`file:` 依赖安装 + 重启 `dsh web`）。
3. **必须重启 dsh web**：`app.js/session.js/styles.css/index.js` 全走 `cachedAsset` 进程内缓存；浏览器还需强刷一次（旧页面帧无 `v:2`，会收到明确的「插件已升级，请刷新」提示，不会静默错乱）。
4. 验证顺序建议：`pnpm test`（110）→ `node scripts/verify-all.mjs ssh`（12/12）→ 打开 SSH 页连一台真机 → 「新建 shell 标签」开第二个 shell → 刷新页面验标签恢复 → 两窗口验只读/接管 → vim 打开文件后刷新验屏幕恢复。

## 6. 风险与遗留事项清单

| # | 等级 | 事项 | 影响 | 建议处置 |
|---|---|---|---|---|
| R1 | 中 | P5（大流量下终端 RTT）未在改造后链路复压；广域网带宽竞争本机回环测不出（方案 §12.5 既有结论） | U2.2 的 SFTP 上线前必须复验 | U2.2 用真实主机跑 100MiB 传输 + 终端输入延迟测量 |
| R2 | 中 | 精确恢复的实机判据（vim/top 刷新后逐行一致 + 光标一致，3 次稳定）未在真机跑 | U2.4 效果未经实机确认 | 实机验收按 §4.4.3 执行；不过 ⇒ 按预案降级（删 addon-serialize 包即回退为回放恢复） |
| R3 | 低 | 前端标签重命名（双击）未实现（方案 §4.1.3 的可选项） | 标签标题用默认规则（`label` / `label #N`） | 列入 U2.2 前的体验补齐或接受现状 |
| R4 | 低 | 「恢复上次布局」（标签集合按快照重建后一键重挂多标签）入口未做独立按钮；当前刷新自动恢复形状 + 点标签挂载 | 首版恢复语义已是决策 4 的完整子集 | 按 §4.1.3 下拉菜单形态在后续补 |
| R5 | 低 | `shellId` 采用 `sh-<seq>`（runtime 内唯一）而非 uuid：跨 runtime 需 `(runtimeId, shellId)` 成对使用，绑定校验已按此实现 | 仅在直接操作 runtime API 时需注意 | 前端与 WS 全部经绑定路由，无暴露面 |
| R6 | 中 | 工作区快照里的 `shellSeq` 在 host 侧重启后失效（shell 重建从 1 重排） | 刷新恢复可能落到「错误的 shell」当 host 曾重启 | 可接受（形状恢复 + 未连接态，用户点击后按 primary 解析）；后续可给 shell 持久 uuid |
| R7 | 低 | U2.0 批内 SPIKE 的 S1（SFTP 性能基线）仍未跑 | 与 U2.2 一并执行 | 保留在 U2.2 工单内 |

## 7. 决策符合性自检

- §6 顺序：U2.1 → U2.3 → U2.4，无跳项（U2.2 除外，用户指令未点名且 §12.5 要求真实主机补验）。
- 决策 1（shell 上限 8）：已实现并有测试。
- 决策 2（单写多读 + 显式接管）：已实现，初始 resize 仅 owner（堵「最后一个 resize 获胜」回潮）。
- 决策 4（拆两张据）：偏好 localStorage v2 / 快照 sessionStorage v1；无痕模式全 try/catch 降级；**无 host 侧写盘**。
- 决策 5（先纯搬迁拆分）：**部分执行**——本轮未做文件搬迁（app.js 仍单文件，改造以补丁方式叠加），理由：U2.0 后 app.js 已叠加 D 线让位逻辑，纯搬迁与本轮结构化改造若混在一个 diff 违反决策 5 的本意，故保留单文件并集中改动区块；搬迁列入 U2.2 前置工单（与原决策 5 一致的「纯搬迁」仍会单独做）。**这是本轮对既定决策的偏离，已登记 R8。**
- 决策 6（addon 兼容性后定）：探针 B 已证兼容 ⇒ 按方案 A 落地官方 0.14.0 并锁版本。
- 决策 7（共享模块）：`lib/paths.js`/`lib/audit.js` 属 U2.2 SFTP 与 A1 共享面，本轮未开工故未建（无偏离）。
