# 七线统一回归矩阵（smoke-test-matrix）

> 建立于 2026-09-07。四条线代码零耦合，但共用一个 DSH host 与一个桌面壳，
> 回归必须分层：能脚本化的进 `scripts/verify-all.mjs`，需要真机/真 host 的留在本文档手动执行。

## 0. 分层定义

| 层 | 内容 | 载体 | 可自动化 |
|---|---|---|---|
| **L0** 静态检查 | 语法（`node --check`）、令牌完备性、令牌漂移 | `node scripts/verify-all.mjs` | 是 |
| **L1** 单线单测 | Canvas 89 项、Sidebar 54 项、SSH 60 项、双模型 24 项、外观 60 项、Fleet 108 项 | `node scripts/verify-all.mjs` | 是 |
| **L2** 插件加载 | 装 profile → 重启 host → 页面刷新 → 插件生效/停用可恢复 | 本文档 §2 | 否（需重启 host） |
| **L3** 实机冒烟 | 桌面壳启动、窗口、主题、桌宠、Canvas、Sidebar、SSH、双模型、外观 | 本文档 §3 | 否（需真机） |
| **L4** 跨线联动 | Fleet pulse → 桌宠；主题 → Canvas/Sidebar；标题栏让位 | 本文档 §4 | 否 |

## 1. L0 + L1：一条命令

```bash
node scripts/verify-all.mjs            # 七线全量
node scripts/verify-all.mjs sidebar    # 只跑一条线（sidebar / canvas / fleet / desktop / ssh / dual-model / appearance）
```

**2026-09-12 实测基线**（七线全量重跑，共 **78 项检查**；DSH 0.1.5-rc.1 / Node v24.15.0）：

| 线 | 项数 | 内容 | 结果 |
|---|---:|---|---|
| sidebar | 10 | `index.js`/`client.js` 语法 + 8 个测试文件（review-data 5 / review-view 10 / review-grouping 3 / review-view-store 6 / rightbar-guide 4 / terminal-launcher 7 / api-routing 12 / terminal-hub 7，共 54 例） | 9/10 ※※ |
| canvas | 11 | 三入口语法 + 8 个测试文件共 89 例（含 mergeStale 失效、external-views 外部视图槽、header-adaptive 会话头自适应） | PASS |
| fleet | 15 | 图与总线判定 10 项（liveness 7 例 / bus-contract 23 / bus-apply 15 / bus-integration 13 / task-graph 13 / capability-graph 17 / verifier 20，共 108 例，及 `task-ready` `agent-pick` `verifier-pick` 的 `--check`、**dispatch 能力闸门接线**）+ server.js 语法 + validate-bus + publish-pulse + validate-bus --strict | PASS |
| desktop | 8 | gen-init（令牌校验）+ tokens:diff（无漂移）+ patch verify ×5（模型设置 / 会话头溢出保护 / 轨迹计时恢复 / 消息气泡计时恢复 / cordis client 查询挂起修复）+ cargo test 10 例（pulse stale 语义 + 立绘回落链） | PASS（MSVC 环境）※ |
| ssh | 12 | 6 个入口语法（index / client / app / session / lib-store / lib-runtime）+ 6 个测试文件共 60 例（U0 故障注入：指纹保存失败 / 跨代确认隔离 / viewer 输入归属 / 尺寸限界 / 背压淘汰 / 重附着预算；U1：分组过滤 / 粘贴守卫 / 颜色合成 / 缓冲查找 / 主题下发 / 会话头列宽手柄隐藏） | PASS |
| dual-model | 10 | 6 个入口语法 + 3 个测试文件共 24 例 + 图片准入补丁 `patch verify` | PASS |
| appearance | 12 | 5 个入口语法（index / client / lib-config / lib-store / lib-fence）+ 6 个测试文件共 60 例 + `derive-skins --check`（M2 皮肤表可复算） | PASS |

> ※ **desktop 的 `cargo test` 项在非 MSVC 环境是环境假阴性**（2026-09-11 实测）：Git Bash 的 `PATH` 中
> `/usr/bin/link.exe`（GNU coreutils 的 `link`）会遮蔽 MSVC 链接器，报
> `link: missing operand` / `link.exe returned an unexpected error`。
> 判据：`cargo check --bin miasaki --tests` 仍能通过（编译无误，仅链接阶段失败）。
> 正确跑法是在 VS 2022 的 x64 开发者环境（`vcvars64.bat` / x64 Native Tools）或带 MSVC 的 PowerShell 中执行。
> 2026-09-12 全量重跑即在带 MSVC 的 PowerShell 中执行，该项 **PASS**（10 例全绿）。

> ※※ **sidebar 的 `terminal-hub.test.js` 两条用例在受限沙箱下是环境假阴性**（2026-09-12 实测）：
> 该用例断言 `ensureSession` 的 cwd 校验与背压淘汰，链路里 `resolvePtyBin` 会用 `where.exe`
> 解析 shell 的**绝对路径**（T2 spike 纪律：conpty 拒绝裸名），而受限沙箱**禁止管道捕获子进程输出**
> （`EPERM spawnSync where.exe EPERM`）⇒ 落入 catch 后抛 `未安装或找不到 powershell.exe`，
> 用例在到达被测分支前就失败。**判据**：同一环境里 `where.exe powershell.exe` 以
> `stdio: 'inherit'` 运行退出码 0 且打印 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
> ——PATH 里有、只是不能捕获。**正确跑法**：在普通终端执行
> `node dsh-miasaki-sidebar/test/terminal-hub.test.js` → 应为 **7/7**。其余 8 个测试文件不受影响。

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
| host 半生效 | 重启 `dsh web` | `GET /sidebar/api/health` 返回当前 `version`（sidebar 现为 `0.6.0-miasaki.0`） |
| client 半生效 | 重启 host **后**刷新页面 | 会话头 / 标题栏出现按钮 |
| 停用可恢复 | 移除插件 → 重启 host | DSH 原生界面无残留（右栏推挤复位、会话头按钮消失） |
| 运行时补丁在位（5 个） | 对 `dsh-miasaki-desktop/patches/*/patch.mjs` 逐个 `node … status`（settings-models / conversation / trajectory / chat / cordis-host-runner） | 输出 `patched`；**DSH 升级后变 `unknown` 即需按该目录 README 重打**；trajectory 与 chat 两个计时补丁**必须一起重打**（同一个 `firstTokenTime` 的两处显示）；cordis-host-runner 是唯一作用于 **host 侧 Node 包**的补丁，改完必须**重启 host**（其余四个作用于浏览器 bundle，刷新页面即生效） |
| 双模型准入补丁在位 | `node dsh-miasaki-dual-model/patches/dsh-api-session-controller/patch.mjs status` | 输出 `patched`；**该补丁与 dual-model 插件必须同版本上线**——补丁负责放行、插件负责真的有人能处理图片，只打前者会让图片被静默丢弃 |
| 计时面板可恢复 | 刷新页面 → 打开任一**已结束**步骤的轨迹计时面板 / 悬停消息耗时面板 | 首 token 延迟、生成、吞吐量三行与气泡「首 token 用时（TTFT）」均为数字（修复前为「首 token 时间不可用」） |
| 外观线 host 半生效 | 重启 `dsh web` → `curl -s http://127.0.0.1:3080/appearance/api/state` | 返回 `{"config":{…},"revision":N,"persistent":true}`；`persistent:false` 表示 `cordis.patch.yml` 的 `dataDir` 没传进 config（改动只存在于内存） |

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

### 3.4 Sidebar（官方右栏 tab 类型）

> 自研壳已退役（2026-09-10 停用 / 2026-09-11 代码删除），面板的**开合、宽度、分栏、全屏、标签栏、
> 引导页全部由官方框架负责**，本线只提供两个 tab 类型（审查 / 终端）及其正文。

| 检查项 | 通过判据 |
|---|---|
| 插件加载 | 重启 host 后 `GET /sidebar/api/health` 返回 `0.6.0-miasaki.0` |
| 入口胶囊 | 官方 tab 条的「添加控件」→ 引导页出现「审查」「终端」两个胶囊；**引导页空白 = `guide` 条目契约坏了**（文本字段必须是函数，见 CHANGELOG 2026-09-10） |
| 审查 tab | 四视图下拉**切换即拉取**（未暂存 / 已暂存 / 全部分支更改 / 上一轮更改；空视图显示「无改动」）、目录分组默认折叠且组统计 = 组内求和、未点名徽标、点名往返持久化、单文件 diff 行级展开 |
| **审查视图持久化** | 切到「上一轮更改」→ 关闭 tab 或刷新页面 → 重开审查 tab 仍是「上一轮更改」（键 `miasaki-sidebar:review-view`） |
| 窗口可见性门 | 切到别的窗口 60s+ 再回来，审查 tab 不因隐藏期间的 TTL 重复拉取 |
| **终端 tab** | cwd 回显与复制、终端类型探测（未安装置灰）、启动到 cwd、失败显示原因 + 重试 |
| 与 canvas 共存 | canvas 全屏 overlay 盖住右栏为预期；右栏层级现由官方框架决定，本线不再声明 z-index 约束 |

### 3.5 外观（`@miasaki/dsh-appearance`，M1）

| 检查项 | 通过判据 |
|---|---|
| 设置栏出现 | 设置面板左栏出现**「外观」**，位置在「通用」之后、「模型」之前（`settings.section` 的 `order: 5`） |
| 契约状态条 | 面板顶部显示绿色「契约自检通过」；有降级项时显示黄条并逐条列出（缺插槽 / 主题接口 / 中栏锚点 / token / 桌面壳主题在位） |
| 明暗偏好 | 点「浅色 / 深色 / 跟随系统」→ 官方「通用 → 外观」的三立方**同步选中**（同一个 `ctx.theme` 偏好，不是第二套状态），界面即时切换 |
| 正文字号 | `－ / ＋` 在 12–17px 间步进，会话正文即时变化，官方同页字号行同步 |
| 总开关往返 | 开 → `document.documentElement.dataset.miaAppearance === 'on'` 且 `~/.dsh/miasaki-appearance/config.json` 的 `enabled` 为 `true`；关 → `'off'` 且为 `false` |
| 修订冲突可复现 | 两个标签页都开面板：A 改一次后，B 用旧修订提交 → B 显示「配置已被其它窗口修改，已载入最新值」，不静默覆盖 |
| **关掉即原生** | 总开关关闭时（或把本线移出 profile roster 重启后）：页面与未装本线时**逐像素一致**，无残留样式与属性 |
| 首帧不闪 | 强刷页面不应出现「先原生、后跳外观」的闪变（M1 只写三个 `data-*` 属性；闪色风险在 M2 皮肤落地时才会出现） |
| 越权防护 | 非环回 Host 头或跨站请求打 `/appearance/api/state` → **403**；未定义路径 → 404 |

### 3.6 SSH（`@miasaki/dsh-ssh`，U0+U1 待验收清单）

前置：`dsh web` 重启 + 浏览器强刷；验收矩阵细化项见 `dsh-miasaki-ssh/design/2026-09-12-ssh-workspace-plan.md` §10。

| 检查项 | 通过判据 |
|---|---|
| 入口不变 | 第一行胶囊「对话 \| 会话布 \| SSH」三段一体；画布内部按钮旁的 SSH 入口可用；第二行 tab 栏无 SSH |
| 工作区布局 | SSH 页 = 左主机导航（搜索框 + 分组 + 底部「N 个连接保留中」）+ 右标签区 + 底部状态栏；无整页连接库 |
| 主题桥接 | pure 亮 / pure 暗 / 刻刻帝 / 狂狂帝四种实装组合下：页面表面、边框、强调色与 xterm 背景/前景/光标同步换肤；**亮色主题强刷不闪黑底**；主题切换不断 SSH、不重建终端 |
| 真实连接 | 新建主机（用户名必填、不默认 root）→ 密码/私钥/agent 连接成功且**终端有输出**（U0 前的版本终端无输出）；连接中横幅可取消 |
| 指纹闭环 | 首连弹指纹 sheet → 信任并继续；改/host 变更 → mismatch 横幅（无「仍然继续」）→ 信任记录 sheet → 忘记 → 重连重新 TOFU |
| attach 恢复 | 已连接主机一键回终端；切对话/画布再回来 scrollback 回放；同主机重复打开不重复 connect |
| 标签语义 | 关闭标签默认「仅关闭查看」（连接保留、可从导航恢复）；「断开并关闭」才 teardown；状态栏区分查看器失联（自动重附着）与 SSH 已结束 |
| 终端功能 | Ctrl+Shift+C/V 复制粘贴（Ctrl+C 仍中断）；查找行 Enter/Shift+Enter 导航、n/m 计数；字号 12–20 且 PTY 跟随；清屏只清本地；多行粘贴先确认 |
| 响应式 | 官方右栏展开挤压 SSH 容器：≥960 双栏 / 720–959 紧凑 / <720 导航改抽屉（Esc 关闭、焦点归还）、无横向溢出 |
| 围栏不回归 | 非环回 Host / 跨站请求打 `/ssh/api/*` → **403**；伪造 origin 的 WS upgrade 被拒 |

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
  DSH 页面，只能在 L3 验证。**例外**是三处无 DOM 依赖的纯逻辑，按源码抽取求值后进了 L1：
  目录分组统计（`test/review-grouping.test.js`，3 项）、审查视图持久化
  （`test/review-view-store.test.js`，6 项，注入 mock `localStorage`）与官方 `guide` 条目契约
  （`test/rightbar-guide.test.js`，4 项）。
  > 2026-09-11：原 `drawer-gesture.test.js`（9 项）与 `client-tabs.test.js` 的持久化部分（7 项）
  > 随自研壳退役 —— 被测函数已从 `client.js` 删除。**例外之二**：bundle 的**装载契约**可在 L1 全覆盖 ——
  用 VM 造一个只有 `window.__ModuleLoader__` 的上下文跑 `client.js`，再调 `factory(require)`
  断言导出形状（`ssh/test/client.test.js`、`appearance/test/client.test.js`）。React 组件内部逻辑
  仍只能在 L3 验证。
- **client bundle 必须自声明 `module`**：DSH 客户端装载器只把 `require` 交给 factory
  （`factory(require) => exports`），**不注入 `module`**。bundle 里要写 `module.exports`
  就得自己起头 `const module = { exports: {} }`，否则 factory 一执行即
  `ReferenceError: module is not defined`，症状是「设置/入口整块不出现」而**不报具体文件**，
  且 `node --check` 与 `verify-all` 的 L0 全部照常 PASS。五条 web 线同一范式，改动 client 半时
  必须带对应的 `client.test.js` 契约测试兜底（2026-09-10 ssh、2026-09-11 appearance 各踩一次）。
- **node:vm 浏览器模块测试里禁用 `instanceof` 跨 realm 判型**：测试框架在 node:vm 上下文里
  跑浏览器侧模块（ssh 的 `client.test.js` / `session.test.js`），从测试侧传入的对象（如
  `ArrayBuffer`）不满足 vm realm 内的 `instanceof`——症状是「注入了真数据但业务分支永远不走」。
  被测代码改用 `typeof` / duck-typing 判别（2026-09-12 ssh `session.js` 二进制帧判型踩中）。
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
| 2026-09-09 | sidebar 审查改版 + 浏览器式标签页（v0.5.0）**实机复验通过**（四视图 / 分组折叠 / 多标签 keep-mounted / v2→v3 迁移，重启 host 后浏览器环境）；单测新增 review-view 6 项 + client-tabs 10 项、api-routing 9 → 10 项 → 基线 **sidebar 8/8**（四线全绿重跑）；§2 标注 health 版本、§3.4 增补标签栏与持久化检查项、§5 例外改为两处纯函数 |
| 2026-09-10 | DSH 升级 0.1.5-rc.1，本体补丁增至 4 个：conversation（会话头溢出保护）、trajectory 与 chat（首 token 计时可恢复，二者 verify 含「重建 SHA + 从产物抠函数跑 fixture 行为断言 + ESM 语法校验」三层）→ desktop 4/4 → **7/7**；§1 基线块改标版本、§2「运行时补丁在位」扩为 4 个并新增「计时面板可恢复」实机项 |
| 2026-09-11 | 新增**外观线** `@miasaki/dsh-appearance`（M1 底座）：`verify-all.mjs` 由六线扩为七线；§2 增补外观线 host 半自检、§3 新增 **3.5 外观**实机冒烟（含「关掉即原生」逐像素比对与越权防护）。**实机首跑即暴露 `module is not defined` 整包加载失败，已修并补 client 半装载契约测试** → `appearance` **9/9**（5 项语法 + 4 个单测文件共 34 例） |
| 2026-09-11 | **§1 基线表七线化重跑**：sidebar 8 → **9**、canvas 9 → **11**、fleet 5 → **15**（含新增「dispatch 能力闸门接线」一项）、desktop 7 → **8**（`patch verify` ×4 → ×5，增 cordis client 查询挂起修复）；补齐 ssh **9** / dual-model **10** / appearance **9** 三行。desktop 的 `cargo test` 项在非 MSVC 环境属**环境假阴性**（Git Bash 的 GNU `link.exe` 遮蔽 MSVC 链接器），已在表下加注判据与正确跑法。§0 的 L1/L3 行、§1 命令注释、§2 补丁数量（4 → 5）与 sidebar health 版本同步更新 |
| 2026-09-11(晚) | **sidebar 第二阶段清理**：自研壳代码删除（`client.js` 988 → 756 行）；`drawer-gesture.test.js`（9 项）退役、`client-tabs.test.js` 拆解（7 项持久化随壳退役 + 3 项分组统计迁至 `review-grouping.test.js`），新增 `review-view-store.test.js`（6 项）→ sidebar 仍 **9/9**（共 40 例）。**§3.4 改为官方右栏形态**（壳相关检查项删除，新增「审查视图持久化」与「窗口可见性门」，并补「引导页空白 = guide 契约坏了」的判据）、§5 例外说明同步 |
| 2026-09-11(晚) | 外观线首次实机启动即失败：`failed to import loader entry (@miasaki/dsh-appearance): module is not defined` —— client 半 factory 用了 `module.exports` 却没声明 `module`（装载器只注入 `require`）。补一行 + 新增 `test/client.test.js`（在无 `module` 的 VM 上下文跑 factory，5 例）→ `appearance` **9/9**（5 项语法 + 4 个单测文件共 34 例）；§5 补记「client bundle 必须自声明 `module`」这一装载契约 |
| 2026-09-12 | **外观线 M1 实机验收六项全过**（§3.5 逐项执行）。过程暴露并修复两处实机 bug：① Host 路由前缀 `/appearance/api/` **尾随斜杠**致 webserver prefix 匹配（`pathname === prefix \|\| startsWith(prefix + '/')`）永远失配 → 全部 API 404、面板全 disabled，去掉尾斜杠并新增 `test/host.test.js`（4 例，把匹配语义钉进测试）；② client 半 `runtime.theme` 在 apply 期一次性快照，早于官方主题服务挂载 → 明暗/字号永远 disabled（而契约自检每次重新 `ctx.get` 显示通过，两者矛盾恰是定位线索），改为惰性 getter。总开关翻转现即时同步 `<html>` 门控属性（不等下次首帧）。→ `appearance` **10/10**（5 项语法 + 5 个单测文件共 38 例）。验证后配置已恢复出厂（总开关默认关闭） |
| 2026-09-12(晚) | **M2 S1–S3 落地**（appearance M2 设计 §11）：S1 探针——官方组件直接引用 static 仅 13 处、三主表面 slot 实盒子可吃 backdrop-filter（机制经夸克 Chromium 视觉验证；IAB 截图通道对全局注入层失真，已记 memory）；**设计大修正**——官方四块 token 全在 body、static 覆盖可回溯 alias（实机实验证实），初版「必须 alias 层派生」作废；S2——desktop `themes/*.css` 拆 `*.skin.css`/`*.deco.css`（desktop 8/8，零行为变更）；S3——`derive-skins.mjs` 编译 105 token 皮肤表（4 条 fail-closed 校验 + `--check` 可复算闸门）→ appearance **12/12**（5 语法 + 6 测试文件共 45 例 + derive），单测 45 例全绿 |
| 2026-09-12(深夜) | **M2 S4–S6 落地（M2 全收官）**：S4 皮肤层——`/appearance/api/skin` 一次下发 105 token + params 表，client `syncSkin` 页面加载即接管（`appearance:skin`/`appearance:params` 双 source）、boot style 双段属性选择器防闪色，实机绯红品牌/墨夜基底全过；S5 壁纸与玻璃——配置 v2、boot style 壁纸伪元素（scrim→晕影→图）+ 三条玻璃 slot 规则，params 层 `color-mix(var(--dsw-static-端点) N%, transparent)` 自动跟皮肤跟明暗（实机证实），内置 3 程序化渐变 + local 图源路由（白名单防穿越）+ 面板 UI + `glass-anchor-miss` 契约；S6 让位协议——desktop `appearanceYield`/`styleFor` 挑层/`syncDark` 交还明暗/`data-miasaki-theme-yield` 保险标记/yieldObserver 免刷新翻转/切换条双入口/aurora×壁纸降透明，appearance `override-conflict`（桌面壳在位却无让位标记）。desktop verify-themes **22/22**（含让位往返 4 项自动化）、desktop **8/8**、appearance **12/12**（58 例）。视觉矩阵与帧率基线、桌面壳同页实机项（切换条双入口/aurora 叠加）留用户验收 |
| 2026-09-12 | **SSH 线 U0 可靠性闭环**（工作区规划 §9 首阶段，故障注入测试先行验收）：新增 `session.js` 查看器实例模块（二进制输出修复、实例整体销毁、有界重附着、ResizeObserver 尺寸观察）+ `test/session.test.js`（11 例，node:vm 假终端/假 WS 驱动）；`runtime.js` 修指纹确认与握手**同一套 60s 时间预算**、确认 token **generation 绑定**、信任记录保存失败不再吞错、attach 初始尺寸送真实 PTY、resize 限界、慢 viewer 背压淘汰；`index.js` 加 WS 帧尺寸上限、输入/尺寸改走 viewer 绑定路由（防跨代串写）；`app.js` 已连接主机主动作改「打开终端」（只 attach）、私钥口令输入、取消按钮 `type=button`、新增信任记录（忘记指纹）UI。→ `ssh` **11/11**（6 项语法 + 5 个测试文件共 48 例） |
| 2026-09-12 | **SSH 线 U1 统一工作区实施**（规划 §3/§4/§6/§7，用户实机看过 U0 后反馈「界面和功能都不完善」）：前端按概念稿重写——主机导航（搜索/分组/收藏/状态点，窄容器模态抽屉）+ 多主机终端标签（关闭查看 ≠ 断开）+ 状态横幅六态 + 编辑器/凭据/指纹/断开/粘贴统一 sheet 抽屉；**三主题桥接**（client.js 读宿主最终计算样式 → postMessage + `__DSH_SSH_THEME__` 注册表双通道 → iframe `--ssh-*` 令牌 + xterm 主题，半透明宿主颜色合成实体底，首帧同源直读不闪底色）；终端补复制粘贴/缓冲原生查找（addon-search 对 xterm 6 仅 beta，未引入依赖）/字号/本地清屏/专注模式/多行粘贴确认；store 增 favorite、username 不再默认 root。→ `ssh` **12/12**（6 项语法 + 6 个测试文件共 59 例）。**U0+U1 待实机合并验收**（三主题换肤 / 窄容器 / 真实连接 / 指纹闭环） |
| 2026-09-12(收官) | **七线全量重跑定基线（78 项检查）**：sidebar 9 → **10**（新增 `terminal-hub.test.js` 7 例：PTY 枚举 / 尺寸夹紧 / 回放环 / 一次性 token / WS 三围栏 / 单会话回放背压，共 54 例）、ssh 59 → **60** 例（「会话头列宽手柄隐藏」那 1 例补记，此前只更了 client 文件数没更总数）、appearance **60** 例（测试文件 7 → **6** 的计数勘误：client 7 / config 26 / fence 6 / host 7 / skins 7 / store 7）、desktop `cargo test` 5 → **10** 例（pulse stale + 立绘回落链）且**在带 MSVC 的 PowerShell 中该项 PASS**；canvas 11/11、fleet 15/15（108 例）、dual-model 10/10 不变。**唯一失败项 sidebar 9/10（`terminal-hub.test.js` 两条）归因为受限沙箱环境假阴性**（`resolvePtyBin` 捕获 `where.exe` 输出触发 `EPERM`），已在表下加 ※※ 注记、判据与正确跑法；§0 的 L1 行同步（Sidebar 50 → 54 / SSH 59 → 60 / 外观 45 → 60 / Fleet 补 108 例） |
