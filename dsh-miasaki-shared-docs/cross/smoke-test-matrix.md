# 四线统一回归矩阵（smoke-test-matrix）

> 建立于 2026-09-07。四条线代码零耦合，但共用一个 DSH host 与一个桌面壳，
> 回归必须分层：能脚本化的进 `scripts/verify-all.mjs`，需要真机/真 host 的留在本文档手动执行。

## 0. 分层定义

| 层 | 内容 | 载体 | 可自动化 |
|---|---|---|---|
| **L0** 静态检查 | 语法（`node --check`）、令牌完备性、令牌漂移 | `node scripts/verify-all.mjs` | 是 |
| **L1** 单线单测 | Canvas 79 项、Sidebar 19 项、Fleet 总线校验 | `node scripts/verify-all.mjs` | 是 |
| **L2** 插件加载 | 装 profile → 重启 host → 页面刷新 → 插件生效/停用可恢复 | 本文档 §2 | 否（需重启 host） |
| **L3** 实机冒烟 | 桌面壳启动、窗口、主题、桌宠、Canvas、Sidebar | 本文档 §3 | 否（需真机） |
| **L4** 跨线联动 | Fleet pulse → 桌宠；主题 → Canvas/Sidebar；标题栏让位 | 本文档 §4 | 否 |

## 1. L0 + L1：一条命令

```bash
node scripts/verify-all.mjs            # 四线全量
node scripts/verify-all.mjs sidebar    # 只跑一条线（sidebar/canvas/fleet/desktop）
```

**2026-09-08 基线**（DSH 0.1.2-rc.1 / Node v24.15.0，全部 PASS）：

| 线 | 项数 | 内容 | 结果 |
|---|---:|---|---|
| sidebar | 6 | `index.js`/`client.js` 语法 + review-data 4 项 + terminal-launcher 7 项 + api-routing 9 项（真实 HTTP 路由）+ drawer-gesture 9 项（client 半源码抽取） | PASS |
| canvas | 9 | 三入口语法 + 6 个测试文件共 79 项（含 mergeStale 失效 4 项） | PASS |
| fleet | 5 | liveness 单测 7 项 + server.js 语法 + validate-bus + publish-pulse + validate-bus --strict | PASS |
| desktop | 4 | gen-init（令牌校验）+ tokens:diff（无漂移）+ patch verify（模型设置补丁离线自证）+ cargo test 5 项（pulse stale 语义） | PASS |

**实现注记**：`node --test` 会为每个测试文件 spawn 子进程并用管道捕获输出，在受限沙箱下以
`EPERM` 失败。`verify-all.mjs` 因此直接 `node <file>` 逐文件执行、`stdio: 'inherit'`，以退出码判定。
各线 `package.json` 里的 `pnpm test`（`node --test test/*.test.js`）在普通终端仍可用。

**故意排除**：`dsh-miasaki-desktop/scripts/verify-themes.mjs` 需要附着运行中的 CDP target，
属 L3 实机项，不进 L0（在无 host 环境会以 `CDP target not found` 失败）。

## 2. L2：插件加载

两个 web 插件（canvas / sidebar）都以 `link:` 安装进 DSH web profile：源目录 symlink，
**改源文件即落盘，但 host 半在 host 启动时载入内存**。

| 检查项 | 步骤 | 通过判据 |
|---|---|---|
| 安装 | `dsh plugin --profile web add link:<线目录>` | profile 出现该包 |
| host 半生效 | 重启 `dsh web` | `GET /sidebar/api/health` 返回当前 `version` |
| client 半生效 | 重启 host **后**刷新页面 | 会话头 / 标题栏出现按钮 |
| 停用可恢复 | 移除插件 → 重启 host | DSH 原生界面无残留（右栏推挤复位、会话头按钮消失） |
| 运行时补丁在位 | `node dsh-miasaki-desktop/patches/dsh-client-ui-settings-models/patch.mjs status` | 输出 `patched`；**DSH 升级后变 `unknown` 即需按该目录 README 重打** |

> **部署契约（易踩）**：sidebar/canvas 改代码后，只刷新页面无效、强刷也无效——
> **必须重启 `dsh web`**。`/sidebar/api/health` 的 `version` 字段是判断 host 是否已加载新 bundle 的
> 唯一可靠信号（版本号与 `package.json` 同步维护）。

> **sidebar cwd 守卫自检**（2026-09-08 修复后应保持，重启 host 即可用 curl 复验）：
> `curl -s -X POST -H "content-type: application/json" -d '{"shell":"cmd","cwd":"relative"}' http://127.0.0.1:3080/sidebar/api/terminal/open`
> 应返回 **400**「需要工作区的绝对路径」——修复前该请求返回 404（相对路径被 resolve 到 host 进程 cwd）。
> 自动化覆盖见 `dsh-miasaki-sidebar/test/api-routing.test.js`（9 项，走真实 HTTP）。

## 3. L3：实机冒烟

### 3.1 桌面壳启动与窗口

| 场景 | 通过判据 |
|---|---|
| `dsh` 未安装 / 启动失败 / 3080 被占 | 加载页显示恢复动作组（检查 dsh / 打开终端 / 日志目录 / 导出诊断） |
| DSH 已运行 | 直接复用，不重复拉起 |
| 二次启动 | 单实例锁唤起已有窗口 |
| 最小化 / 最大化 / 还原 / 双击顶部空白 | 状态正确，标题栏按钮同步 |
| 顶部空白拖动 vs 点击页面按钮 | 拖动跟手；页签/输入框照常可点 |
| 关闭确认 | 取消可回退；确认后停止本应用 spawn 的后端 |

### 3.2 桌宠

拖动 / 单击 / 双击 / 右键菜单 / 隐藏与恢复 / 屏幕外位置找回 / 分辨率变化 / 主题切换换角色。

### 3.3 Canvas

「会话布」切换按钮在会话头 actions 插槽 → 画布渲染 → 分支血缘 → 合并（选线/注入形式/执行）
→ 菱形卡长出内容 → 原线「已被吸收 ◇」标记。

### 3.4 Sidebar

| 检查项 | 通过判据 |
|---|---|
| 右栏开合 | ≥1280px 推挤（center 缩窄）；<1280 浮层 + scrim；<768 抽屉 |
| 空态选择页 | `tab: null` 显示三张卡片，点击进入对应 tab |
| 审查 tab | status 全量渲染、未点名徽标、点名往返持久化、单文件 diff 行级展开 |
| **终端 tab** | cwd 回显与复制、终端类型探测（未安装置灰）、启动到 cwd、失败显示原因 + 重试 |
| 与 canvas 共存 | canvas 全屏 overlay（z-100）盖住右栏（z-60）为预期，不得反向提 z |

## 4. L4：跨线联动

| 链路 | 步骤 | 通过判据 |
|---|---|---|
| Fleet pulse → 桌宠 | 设 `MIASAKI_FLEET_PULSE` 指向 `dsh-miasaki-fleet/state/fleet-pulse.json`，跑 `publish-pulse.mjs` | 桌宠 2s 内按 `fleet 告警 > DSH 等待审批 > fleet 运行中 > busy > intensity` 映射 |
| pulse 缺失 / 损坏 | 删除或写坏该文件 | 联动静默关闭，不误报（BOM/CRLF 容错） |
| **pulse stale（文件在但过龄）** | 发布器停止后 31s+（阈值 30s）看桌宠 | 桌宠从「忙碌中…」回落，不再停帧；日志显示 `存在但不可用（stale/格式错误）` |
| **worker 心跳过龄** | 手把手：写 `status.json` 令某 agent 的 `state: running` + 旧 `heartbeat_at`，然后跑 `publish-pulse.mjs` | 控制台打 `[pulse] <id>: ... → 降级为 unknown`；`fleet.running` 不含该 agent；pulse 带 `stale_agents` |
| 主题 → Canvas | 桌面壳切三主题 | 画布强调色/激活胶囊随品牌色变化 |
| 标题栏 → Canvas/Sidebar | 桌面壳 V4 标题栏 | Canvas 工具条左移让位；Sidebar 面板 top 跟随 32px |
| DSH 审批 → 桌宠 | 触发一次工具审批 | 桌宠转 `wait` 姿态 + 常驻「等待审批」气泡；单击唤起主窗口 |

## 5. 已知边界

- **L0 对 client 半的覆盖有限**：`client.js` 主体只做 `node --check` 语法校验，React 行为依赖真实
  DSH 页面，只能在 L3 验证。**唯一例外**是抽屉右滑关闭的判定——它是无 DOM 依赖的纯函数
  `drawerCloseDecision`，由 `test/drawer-gesture.test.js` 按源码抽取求值（9 项），因此进了 L1。
- **fleet 生命周期自动化仍不全**：F1 总线 + F3 心跳判活已有测试；worker 调度级
  （超时 / 重试 / orphan 回收）尚无自动化覆盖。
- **Desktop `compose` 优先级映射靠 L3/L4 人工核对**：`main.rs` 已有 pulse stale 判活
  单测，但桌宠姿态/气泡的优先级编排（fleet 告警 > 等待审批 > busy > 强度）尚未自动化。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-07 | 建立本矩阵与 `scripts/verify-all.mjs`；记录首个四线全绿基线（sidebar 4 / canvas 9 / fleet 3 / desktop 2） |
| 2026-09-07(晚) | 异常恢复批次：fleet 增加 liveness F3 单测（5 项）、desktop 增加 `cargo test`（3 项）；canvas 79 用例（mergeStale）；矩阵更新基线（sidebar 4 / canvas 79 / fleet 5 / desktop 3），L4 增补 stale 检查项 |
| 2026-09-08 | desktop 增加 `patch verify`（模型设置补丁离线自证，desktop 3/3 → 4/4）；sidebar cwd 守卫修复 + 浏览器信任围栏补两道（api-routing 8 → 9 项）；基线更新为 **sidebar 5 / canvas 9 / fleet 5 / desktop 4**（本表 §1） |
| 2026-09-08(晚) | sidebar 增加 `drawer-gesture`（client 半纯函数源码抽取 9 项，L1 首次覆盖 client.js 逻辑）→ 基线 **sidebar 6/6**；§5 已知边界补该例外说明 |
