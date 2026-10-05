# 九线统一回归矩阵（smoke-test-matrix）

> 建立于 2026-09-07（**八线 → 九线：2026-09-28 新增第九线 `dsh-miasaki-free-model`**，
> 由 desktop 线迁出并更名）。各线代码零耦合，但共用一个 DSH host 与一个桌面壳，
> 回归必须分层：能脚本化的进 `scripts/verify-all.mjs`，需要真机/真 host 的留在本文档手动执行。

## 0. 分层定义

| 层 | 内容 | 载体 | 可自动化 |
|---|---|---|---|
| **L0** 静态检查 | 语法（`node --check`）、令牌完备性、令牌漂移 | `node scripts/verify-all.mjs` | 是 |
| **L1** 单线单测 | 下列数字为 **2026-09-26 快照**；本次改动过的三条线**当前实测**为 Canvas **105 例 / 10 文件**、Sidebar **66 例**、SSH **299 例 / 18 文件**（2026-09-27 逐文件实跑汇总）——**2026-10-05 复核：这三条线现为 Canvas 116 / Sidebar 104 / SSH 310**（逐文件 `node <file>` 汇总，见 §1 表），上面那组 09-27 数字保留作历史快照 —— 旧值：Canvas 100 项、Sidebar 62 项、SSH 225 项、双模型 33 项、外观 114 项、Fleet 119 项、**用量统计 3 项**（第八线 `dsh-token-monitor`：host 半语法 + 数据修复工具语法 + client bundle 装载契约）、Desktop 127 例（含 2026-09-25 新增的 57 例：主题来源 8 / hash 字段级 8 / 契约 v1 11 / 窗口底色回传 10 / console 旁路 12 / 材质分层 8；2026-09-26 新增 hash 同步判重 7 例 + **`plugins/dsh-session-log-move` 契约 4 例**）+ `cargo test` **86 例**（2026-09-27：原 85 + T7 pulse 三级回退 1；**2026-10-05 实为 155 例**） | `node scripts/verify-all.mjs` | 是 |
| **L2** 插件加载 | 装 profile → 重启 host → 页面刷新 → 插件生效/停用可恢复 | 本文档 §2 | 否（需重启 host） |
| **L3** 实机冒烟 | 桌面壳启动、窗口、主题、桌宠、Canvas、Sidebar、SSH、双模型、外观 | 本文档 §3 | 否（需真机） |
| **L4** 跨线联动 | Fleet pulse → 桌宠；主题 → Canvas/Sidebar；标题栏让位 | 本文档 §4 | 否 |

## 1. L0 + L1：一条命令

```bash
node scripts/verify-all.mjs            # 九线 + 仓库级治理闸门全量
node scripts/verify-all.mjs sidebar    # 只跑一条线（sidebar / canvas / fleet / desktop / ssh / dual-model / appearance / usage / free-model / repo）
```

**全量基线**（**九线 + 仓库级治理闸门**；**静态全量 2026-09-30 实测 179 项、十类全 PASS**
—— sidebar 13 / canvas **14** / **fleet 21** / desktop **39** / ssh 31 / **dual-model 15** / appearance 18 / **usage 7** /
**free-model 15** / **repo 6**；**内核已升到 DSH `0.2.0-rc.2`**；**Node v24.15.0 与 v22.19.0（CI 版本）各自实跑 179/179 全 PASS**。
下表各项标注的是建表时的快照）：

> **2026-09-30（本轮）口径 168 → 173**：三处静默缺口（K3/K4/K5）与两道缺席闸门（I5 围栏 / I1 账本身份）同批落地 ——
> **fleet 17 → 18**（+K4 派单终态测试项）、**usage 3 → 7**（+`lib/fence.js` 与 13 例围栏测试、
> +`lib/ledger-dir.js` 与 5 例账本身份闸门）。另：**J5 上游补丁 live 审计**同批闭环 ——
> `patch-live-audit.mjs` 由 10 → **11 个目标**（本线补丁首次入册，含布局候选与 drift 判定两处修正）。
> 同批 `silent-guards` 基线**核销 2 类（57 → 55）**：两条都是本批主动修掉的静默断链
> （`verifier-pick.mjs` 读一个从不存在的厂商表、`validate-bus.mjs` 对缺失交付物 `continue`），
> 新增 0 —— 核销前逐条复核过「是修掉了，不是扫不到」（本仓曾把「没去扫」误读成「已干净」）。
> 详见 [ENGINEERING.md](../../docs/ENGINEERING.md) 当日条与各线 `CHANGELOG.md`。

> **2026-09-30（续·派单器接线）口径 173 → 175**：**G1 可派判定与 G0 事件留痕接进派单器**
> （判定层此前「已落地但停在可查询」，只有 G2 能力闸门在役）——
> **fleet 18 → 20**（+`dispatch 可派闸门接线` 纯文本断言 12 项、+`tests/dispatch-gate.test.mjs` 夹具 10 例）。
> 接线后：任务不可派（状态非 queued / 依赖未满足）/ `-Agent` 与台账 `assignee` 不一致 → **拒绝派单 exit 2**；
> 派单开始（CLI 启动前）与终态各写一条机器事件（`task.started` / `task.completed`·`failure.detected`）。
> **K2 状态更新**：接线已完成，但「真实 3 路 fan-out → reduce → verify」仍需真实钻石图任务（见 §3 K2）。
> 规划与分档依据：`_refs/fleet-dispatch-wiring-plan-2026-09-30.md`（规划类，按仓库纪律不入库）。
> **当日终值（续十二后）**：该批之后还有五批（复核收口 / G4 挂载 / 判活口径统一 / P1 面板 / B5 写入收敛），
> 2026-09-30 全天收工口径为**全量 179 项 / fleet 21 项 / 可派闸门断言 37 项 / `dispatch-gate` 26 例** ——
> 上文的 175 / 20 / 12 / 10 是该批**当时的**时点数字，保留以显演进。

> **2026-09-30 `repo` 4 → 5（新增 `lock-sync` 闸门）**：CI 曾因「改了 `package.json` 没同步锁文件」
> 连续 **11 次**推送全红（`8181b89` … `f610ef3`，2026-09-29 20:44 起），而每次红的都不是测试 ——
> 第 7 步 `pnpm install --frozen-lockfile` 以 `ERR_PNPM_OUTDATED_LOCKFILE` 退出，后续步骤
> （安装 ssh / desktop 依赖、**九线统一回归**）全部 `skipped`，**那 3 小时里一个测试都没跑**。
> 新闸门把同一判定提前到推送前：比对锁文件（`importers['.']` / `packages['']`）四个依赖段与
> `package.json` 的直接依赖 specifier。**pnpm 侧跨字段合并比对** —— `autoInstallPeers: true` 时
> peerDependencies 在锁文件里登记进的是 `dependencies` 段，按字段名对齐会误报。
> 实测两条：拿 `f610ef3` 的历史文件 `--root` 复现，报出的两条缺登记与 CI 日志**逐字相同**；
> 当前树 4 个锁文件 / 19 条登记全 PASS（`dsh-miasaki-canvas/pnpm-lock.yaml` 是动态枚举发现的
> 第 4 个 —— 照 CI 那三条线硬编码会漏掉）。判据、边界与内置自证见 `scripts/check-lock-sync.mjs` 头部；
> 全量基线 167 → **168**。

> **2026-09-29（深夜）本批的实际口径**：本机复跑 **166 PASS + 1 项沙箱阻塞** —— `repo/md-links` 内部
> `execFileSync('git')` 走默认管道 stdio，在本机 DSH 沙箱下 EPERM；已用等价快照数据源喂**真脚本**
> 复核 **PASS**（184 个入库文档 / 426 个相对链接全部解析到已入库目标），CI 上可正常执行。
> **三处口径变化**（都不是退化）：① `dsh-cordis-host-runner` 补丁**退役出册** —— 官方 `0.2.0-rc.2`
> 自行实现了同一修复（`pending.failure ??=` 记录拒绝原因、`clientQueryTimeoutMs` 可配超时、
> `finally { clearTimeout }` 清理，外加「无活动页面时立刻失败」守卫），本补丁 4 条编辑的锚点在 rc.2 上
> **全部命中 0 次**（在 rc.1 baseline 上 4/4，证明规则本身未坏）⇒ desktop −1；② `dsh-pet-panel` 补闸门
> （此前只靠 `package.json` 的 build 脚本检查、回归里看不见）⇒ desktop +3；③ `md-links` 闸门接线
> ⇒ repo +1。合计 **164 → 167**（desktop 36 → **38**、repo 3 → **4**）。判据与证据见
> `dsh-platform/dsh-0.2.0-rc2-upgrade-assessment-2026-09-29.md` §3.1。

> **2026-09-29（续）dual-model 12 → 15（闸门补漏 + 静默丢图链修复）**：用户判断「先别急着分发，逐线完善」，
> 本条线是逐线完善的第一条。① **代码审计抓到一条全程零信号的静默丢图链** —— 准入侧只看
> 「是否启用 + 是否配置」，路由侧还要看 `hasImage`，两段判据不同源 ⇒ `attach` 失败或 pre-step 判错时
> **图片交给不支持图的主模型而用户以为发出去了**；修法是新增 `lib/admission.js`，
> **只有图片执行通道确实建立时才接管控入**（通道没建好就让本体给出可见拒绝）。② **闸门补漏**：
> `verify-all.mjs` 的语法清单只有 6 个文件而 `package.json` 的 build 有 8 个 —— `lib/invalidation.js`
> 长期没进闸门；新模块 `lib/admission.js` 与 `test/admission.test.js` 同批入册（+2 语法 +1 测试）。
> ③ **实机前置查明**：本体准入补丁**此前不在位**（`status` 报 `original`）——
> 「任一支持图片即可发图」这条核心能力**当时是失效的**，这正是 §3.10 第 5 项从未闭环的原因；已应用。

> **2026-09-29 收尾复跑（161 项全 PASS）**：第九线迁出**收尾**时的全量实跑。desktop **40 → 36**
> 是口径变化而非退化（4 项随插件迁入 `free-model`，该线 **15/15** 首次入账）。
> 同批修掉**两处真缺陷**（都属「迁移时漏登记」）：`check-silent-guards.mjs` 的 `LINES` 与
> `check-message-sources.mjs` 的 `REPO_TARGETS` 都没补第九线 ⇒ 整条线对两道仓库级闸门**不可见**；
> 修后 `silent-guards` 扫描根 10 → 11、命中 59、新增 0 / 可回收 0（基线 58 → 57 类，核销了
> free-model 那条 `existsSync` 欠账），`message-sources` 仓库内 198 → 215 文件、命中 0。
> **教训**：闸门报「可回收」时**先核扫描清单再动基线** —— 照提示删条目会把「没去扫」固化成「已干净」。

> **2026-09-28 内核升级复验（0.1.7-rc.2 → 0.2.0-rc.1）**：`free-model` 线逐项复验契约面
> **零适配**（`settings` 无 `get`、有 `describe`/`update`；`settings.section` 与
> `settings.models.provider-card` 逐字节未变；`llm` 五个方法全在；`agentDefaultModel` 与
> `connection.requestRejection` 未变），并起临时 web host 打通业务层：`/status`（settings 双轨）、
> `/default-model`（官方服务）、`/scan`（llm 契约枚举 + 免费判定）三条全部 200 且返回真实数据。
> **同批复验抓到一个真缺陷**：webServer 的 exact 路由**按 path 去重**，同路径注册两条会抛
> `duplicate exact route` ⇒ **整个插件不激活**（已修 + 加"路径唯一"闸门，详见
> `dsh-miasaki-free-model/design/CHANGELOG.md` 2026-09-28（续四））。
> 升级后静态复跑：`free-model` **11/11**、`repo` **3/3**。

> **2026-09-28 局部复跑（M2.1 落地后）**（**已被顶部 161 项基线取代**，仅作过程记录）：sidebar **13/13 PASS**——新增 `test/sidechat-registry.test.js`（7 例纯函数 + 6 例源码契约），
> 该线单测合计 **86 通过**；`repo` 仍为 **2/3**，失败项 `silent-guards` 的 2 处新增命中属 **desktop 线在途未提交的
> `plugins/dsh-computer-use/lib/code-agent.js:237,240`**（非本次改动）。其余线未复跑，全量总数仍以最近一次八线跑为准。

> **2026-09-28 第九线接入 + M1**：`dsh-free-model-pool` 由 desktop 线迁出、更名 `@miasaki/dsh-free-model`、
> 独立成第九线，同批补**路由信任围栏**并落地 **M1（扫描面升级到官方 `llm` 契约）**。
> `verify-all.mjs` 的 `LINES` 新增 **`free-model` 类别 15 项**（**5 语法**：index / trust /
> settings-read / profile / scan ＋ **上游增量补丁 3 件语法 + 1 件自证** ＋ **6 个测试文件**：trust 15 例 / **scan 15 例** /
> **client-bundle 9 例** / **default-model 7 例** / settings-read 10 例 / routes **6 例**）；原 desktop 类里的 4 项随迁。
> 实测 `verify-all free-model` **15/15 PASS**、`verify-all repo` **3/3 PASS**
> （silent-guards 的冻结项路径已同步为新线路径）。desktop 项数相应减 4（40 → 36）。

| 线 | 项数 | 内容 | 结果 |
|---|---:|---|---|
| sidebar | 13 | `index.js`/`client.js` 语法 + 11 个测试文件（review-data 5 / review-view 10 / review-grouping 3 / review-view-store 6 / rightbar-guide 4 / terminal-launcher 7 / api-routing 12 / terminal-hub 15 / session-cwd / titlebar-button / **sidechat-registry 31**（含 M2.1 辅助对话登记表 13 例 + 侧线 goal 补偿 6 例 + **不占列表声明 5 例** + **继承段判据 5 例** + **折叠 CSS 与作用域契约 2 例**，2026-09-30），共 **104 例**） | PASS |
| canvas | 14 | 三入口语法 + 10 个测试文件共 **116 例**（**2026-09-30 实测**；旧记「9 文件 100 例」是历史口径失真 —— 本轮 +11 例，其余差额来自此前漏记。含 mergeStale 失效、external-views 外部视图槽、header-adaptive 会话头自适应、**store-retention 存储治理**：载荷截断保头+标记 / `result` 保持 `null` / 窗口只留最近 50 条 / ★ 裁剪水位防 replay 复活 / 老 store 载入即迁移并落盘 / 已合规文件不重写；**同步体量预算**（2026-09-26）：全量 `sessions/sync` 独占 2MiB 预算、超限报错带实际字节数、client 侧失败只留痕一次；**DSH 0.1.7 会话导航适配**（2026-09-27）：`ctx.uiWorkspace.openSession` 取代已删除的 `ctx.sessions.open`、画布发消息先打开再借 scope、bridge 失败留痕且 toast 带真实原因；**辅助对话标注**（2026-09-30，`sidechat-badge.test.js` 9 例 + `conversation-cards` +2 例）：声明缺失/命中/坏 JSON 只留痕一次/形态容错/缓存失效/三处标注源码契约/storage 而非轮询/样式明暗两套/解耦契约） | PASS |
| fleet | **21** | 各层判定与接线（liveness **9 例**（含首跑口径 `isFirstRun`）/ bus-contract **26** / bus-apply 15 / bus-integration **17** / task-graph 13 / capability-graph 17 / verifier **29**（含首跑豁免四条边界），共 **126 例**，及 `task-ready` `agent-pick` `verifier-pick` 的 `--check`、**dispatch 能力闸门接线**、**dispatch 可派 + 验证闸门接线（2026-09-30 新增，**37 项**纯文本断言：G1 闸门函数 / 两处**调用点** / 复用判定器 / assignee 一致性 / 冷启动降级 / 两侧成对的判活文案 / BUS_ROOT 对齐 / CLI 存在性预检 / 崩溃残留恢复入口 / 终态判定失败不静默回退 / 预算口径分歧 / 台账坏行拒绝 / **G4 验证闸门函数与调用点 / 风险声明解析 / 等级映射不猜 / 验证任务书生成 / 未声明即跳过** / **首跑口径单点与两个消费方（5 项）** / 事件函数与两类事件 / 事件不阻断 / 判定器结构化字段 `agent` 与 `bus_bad_lines`）**）+ server.js 语法 + **fence.cjs 语法 + fleet-monitor 信任围栏 **16 例**（2026-09-26 新增三道判定 / 403 不带 CORS 头 / 过围栏才进业务分支；2026-09-30 P1 增判定层端点与区块四例）** + **dispatch-state 9 例（K4 终态判定 + 两个 ps1 的语法闸门）** + **dispatch-gate 26 例（G1 可派 + G4 验证闸门夹具：放行 / 状态非 queued / assignee 不一致 / 依赖未满足 / 开关未关 / 冷启动降级 / 僵尸 / 任务不在台账 / 台账坏行 / `-ResetStatus` 六态 / **G4 六态** / 预检不写总线 / `-ShowCommand` 只读 / 命令构造两例 / 语法——2026-09-30 新增）+ **fleet-monitor 判定层区块 (P1) 7 项断言**（2026-09-30）—— 连同上面各测试文件，全线用例 **177 例**** + validate-bus + publish-pulse + validate-bus --strict | PASS |
| desktop | 39 | gen-init（令牌校验 + **W0 三道产物自校验**：样式 JSON 可解析且键集一致 / 目录下 `.js` 必须全部登记进 `MANIFEST.order`（漏登记＝静默不打包）/ 写盘字节一致）+ tokens:diff（无漂移）+ **注入脚本语法闸门**（`syntax injected/theme-init.js`——`themes/src/*.js` 拼接产物，WebView2 每个文档都跑）+ **鉴权 cookie 兜底链行为闸门**（6 例：已有 cookie 只按原值续期 / 401 熔断上限与可见提示 / document_start 不误清计数）+ **启动页契约**（11 例：S4a 视觉层 10——动画只准 transform/opacity、扫描线 opacity ≤ .06、零新增色、reduced-motion 全静止、类名纪律、就绪回弹 VM 驱动幂等；S3 拖放安全网 1——只拦文件拖放、官方已消费与文本链接不碰）+ **桌宠资产链完整性闸门**（frames 引用齐全 / 再生源在位 / 无孤儿派生，故障注入四分支自证）+ **patch verify ×6**（模型设置 / 会话头溢出保护 / 轨迹计时恢复 / 消息气泡计时恢复 / cordis client 查询挂起修复 / **消息画廊多图 tile 宽高比**）＋ `plugins/dsh-model-probe` 语法 3 项 + 探测判定表 20 例 + settings 读取双轨 12 例 + `plugins/dsh-free-model-pool` 语法 2 项 + settings-read 10 例 + routes 5 例 + **`plugins/dsh-session-log-move` 语法 2 项 + 槽声明契约 4 例（2026-09-26 新增，合计 33 项）** + **主题来源优先级闸门**（8 例：`__MIA_THEME__` > URL > localStorage > pure，含"非壳环境不报错"与"localStorage 抛异常不崩"两条边界——W0-T0.1）+ **hash 字段级读写闸门**（8 例：精确增删不误伤并发字段 / 保真 `%20` 原始编码 / seq 覆盖保护——W0-T0.2）+ **桌面契约 v1 闸门**（15 例：子 frame 只给空壳 / 能力表与暴露面一致 / 只读纪律不得开 hash 写通道 / **v1.1 写能力**：theme.set 与 window.controls 只派发内部事件、白名单拒绝、人话名不透 `min`/`max`、寄生侧监听静态断言——W1）+ **窗口底色回传闸门**（10 例：半透明底合成到不透明 / 拿不到不透明底即如实放弃不猜色——W4.3）+ **渲染层 console 旁路闸门**（12 例：只旁路不改原生调用 / 只顶层 frame / 环形上限 50 条 / ResizeObserver 调度噪声与红条同判据过滤——W2 收尾）+ **hash 同步判重闸门**（7 例：目标 hash 与当前逐字节一致时一次 `replaceState` 都不发 / 任何真字段变化必须照写 / 心跳同值重发不写入 / `force` 重算 diag 落地 / 判重不得退化成「永不写」——2026-09-26「一直在刷新」修复 P3）+ cargo test **85 例**（2026-09-26 深夜实测；下方括号内明细为历史累计口径，以实测总数为准）（launcher 图标 6 + 桌宠状态机与持久化 16 + 启动链 pulse stale / backend backoff / netstat 解析 6 + 隐藏态主题头像悬浮球 `dot.rs` 7 + **W2 新增**：diag 诊断格式化与 10 份轮转 / 看门狗状态机 / panic hook 12 + recovery sanitizeProfile 备份与中止 / 分级停机状态机 11 + Job 参数与真机 `KILL_ON_JOB_CLOSE` / hex 解析 3 ＋ **2026-09-26 新增**：帧签名剔除心跳（`fragment_signature` 对仅 `petts` 变化的判别，含 8 类真变化不得被吞与 `pettool`/`petkey` 不误伤）1） | PASS（MSVC 环境）※ |
| ssh | 31 | 13 个入口语法（index / client / app / session / sftp-ui / lib/store / lib/runtime / lib/diagnose / lib/exec / lib/paths / lib/sftp / lib/limits / lib/sshConfig —— 2026-09-26 U2.2 等 6 个新模块同批补进静态闸门）+ 18 个测试文件共 **310 例**（2026-10-05 实测：`dsh-miasaki-ssh/test/*.test.js` 逐文件 `node <file>` 汇总 = 310 例；其下明细为 2026-09-26 历史口径）（app 21 / client 38 / **diagnose 11** / http 10 / runtime 34 / session 34 / store 10；**2026-09-26 新增 `lib/diagnose.js` + `test/diagnose.test.js` 11 例**：banner 解析 / socket 错误词汇 / DNS 字面量短路 / 真 socket 三形态（零字节 ≠ 超时）/ 真 `ssh2.Server` 验「只发 `none`、服务端看不到密码」/ 出口 IP 逐个回退 / verdict 全分支 / 端到端组装；**2026-09-26 对标 zcode 方案落地新增 6 文件 67 例**：exec 11（POSIX 包装 / exit 早于 data / 排空窗口 / 超时 / 协议行扫描）/ paths 12（词法归一 / NUL / 控制字符 / `~` 展开）/ sftp 14（状态词汇 / 进度节流 / 列目录映射 / 上传降级链 sftp→exec pipe / 下载计数）/ http-sftp 12（真实 HTTP 端到端：票据失效 / teardown 作废 / `..` 归一 / 409 / 413 / execOnly 直降 / 会话打不开自动降级 / op 全分支 / fence 先于票据）/ sftp-ui 9（vm 加载 / 纯函数 / 接线契约）/ sshConfig 9（解析器 / `ssh -G` 合并 / 缓存 / 回退通道）；runtime 29 → 34（keepalive 与错误词汇 / 连接配置纯函数 / SFTP 票据与会话缓存）；U0 故障注入：指纹保存失败 / 跨代确认隔离 / viewer 输入归属 / 尺寸限界 / 背压淘汰 / 重附着预算；U1：分组过滤 / 粘贴守卫 / 颜色合成 / 缓冲查找 / 主题下发 / 会话头列宽手柄隐藏；D2：顶栏消息闭环 / 浮层契约 / `ready`·`status` 帧必须喂状态模型（D-2 回归）/ `canvasAvailable` 段数双向变化（hero 两段）/ 「保存并连接」形态护栏（D-1 回归）；U2：v2 帧契约与 `VERSION_MISMATCH` / 一次性 attach 票据生命周期 / 多 shell 隔离与写权接管 / 关闭语义三分 / 工作区快照恢复与损坏降级 / 序列化快照三路恢复；**U2 实机验收回归：未绑定 shell 不发帧 / 就绪补绑 / 按 `shellSeq` 精确匹配**；**B1/B2 launcher 判据：只在主页（`[data-slot="main.conversation"]` 锚点）**且**本线胶囊不在场（`.dsh-ssh-switch`）时才渲染 —— 与会话头胶囊结构性互斥，旧「推演官方 `useSessions.blank`」判据已删**；**2026-09-26 实机四修：弹层由贴边抽屉改居中悬浮窗（主题球不再压确认键）/ 只读条未连接时常驻修复 / 主机栏连端口一起填不再 `getaddrinfo ENOTFOUND`（`splitHostPort` 就地修正并回写）/ password 分支开 `tryKeyboard`（只开 keyboard-interactive 的服务器密码不再白填）**） | PASS |
| dual-model | 15 | 6 个入口语法 + 5 个测试文件共 33 例（routing 10 / store 7 / content 7 / **invalidation 5**——0.1.7 双轨失效信号 / **client 4**——触发钮在 `/state` 失败态不得禁用）+ 图片准入补丁 `patch verify` | PASS |
| appearance | 18 | 8 个入口语法（index / client / lib-config / lib-splash / lib-avatar / lib-icon-presets / lib-store / lib-fence）+ 9 个测试文件共 143 例（含 M2.6 风格契约、M2.7 预设渲染与落盘、primitives 引用闭环与渲染树签名、2026-09-26「与通用页不重复」去重闸门、V1「选择丸 + Menu」控件闸门、P2 splash 门控/注入安全/退场链路、M3 动效层 CSS 合规、「无可见效果」提示（2026-09-30 补全为全量判定）、**M4 会话效果层 CSS 合规 + 六行控件 + 三态应用行为闸门 + 锚点失配提示**、**P4 每板块恢复默认（默认值只来自 host 下发）**）+ `derive-skins --check`（M2 皮肤表可复算） | PASS |
| free-model | 15 | 第九线（**2026-09-28 由 desktop 线迁出、更名 `@miasaki/dsh-free-model`**，同批补信任围栏并依次落地 **M1 扫描面升级 / M2 统一页 + 就地入口 / M3 实测与默认模型**）：`lib/{index,trust,settings-read,profile,scan}.js` 语法 **5** 项 + **上游增量补丁 3 件语法 + 1 件自证** ＋ **6 个测试文件（合计 62 例）** —— **trust 15 例**（围栏两层语义：`connection` 401/403/放行/抛错回落与**逐请求读取**；结构层：回环放行 / 非回环 403 / Host 缺失 fail closed / 跨站 403 / 异源与 `Origin: null` 403；路由级：非回环 Host 进不了业务 handler、**围栏先于 method 检查（跨站 POST 得 403 而非 405）**）、**scan 15 例**（来源 A 三条纪律：逐 provider 隔离失败 / 逐调用失败回落 / **能力只到能被证明的程度**；L0 provider 级免 Key 车道与 L1 后缀分层；解析缓存与 refresh；`/scan` 端到端四项）、**client-bundle 9 例**（`node:vm` 真实装载：模块 id = 包名 / 导出面 / **条件注册**（上游在场→让位、不在场→兜底页）/ **绝不注册 `settings.models.*`**（边界闸门：那个槽在编辑面板也会被 dispatch，occupant 一出问题就整树白屏 —— 走的是风险论证，2026-09-28 那次白屏事故的真凶已查明是别的包上的补丁）/ 旧命名零残留 / **样式全走官方主题令牌且无写死色值** / **M3 接线**：实测与默认模型端点 + 探活门控）、**default-model 7 例**（官方写路径四态：成功 / 服务缺席语义化错误 / 参数不合法不碰服务 / 官方抛错透传）、settings-read 10 例（读取双轨 helper 契约）、routes **6 例**（0.1.6/0.1.7 双世界真实路由接线 ＋ **路径唯一闸门**：同路径注册两条 exact 路由会让 webServer 抛 `duplicate exact route`、**整个插件不激活** —— 0.2.0-rc.1 真机教训前移） | PASS |
| usage | 7 | DSH web 插件 `dsh-token-monitor`（第八线，2026-09-26 由 desktop 线迁出）：`lib/index.js` 与 `scripts/dedupe-usage-ledger.mjs` 语法闸门 + client bundle 装载契约自检（把 client.js 当脚本真实执行并喂 react stub，能抓出「CSS 模板字符串被反引号提前闭合」那类整包加载失败） | PASS |
| repo | 6 | **仓库级治理闸门**（2026-09-26 新增，跨九线生效、不属于任何单线）：**`silent-guards`** —— 守卫必须显式失败（R1 静默跳过守卫 / R2 构建链静默吞错 / R3 静默回退读取 / R4 声明清单缺口；存量 **57 类**冻结在 `scripts/silent-guard-baseline.json`，**新增即失败**，`// guard-ok: <理由>` 可就地豁免）+ **`doc-versions`** —— 根 README 的版本台账与九线 `package.json` 逐字一致 + **`message-sources`**（**2026-09-27 新增**）—— 会话消息的 `source.kind` 不得用 DSH 0.1.7 起退役的 v3 写法（`{ kind: "plugin", … }` ⇒ v4 准入硬拒 ⇒ 整轮运行失败）：扫仓库内源码 **215 文件** + 本机已装插件 **13309 文件 / 7 个 profile**（CI 无 `~/.dsh` 时**显式打印跳过**）；脚本内置自证（正例必命中 / 反例必不误报），故障注入实测 `exit 1` 并点名文件:行，豁免 `// source-ok: <理由>` + **`style`**（**2026-09-30 新增**）—— 入库文本的**文件形态**（LF / 无 BOM / 末行换行）与**公开仓库脱敏**（`C:\Users\<真名>\…` 绝对路径；`<…>`/`%…%`/`…` 占位放行）：两条都是**成文但此前无闸门**的纪律（`.editorconfig`/`.gitattributes` 写着形态约定、脱敏是 2026-09-29 起的公开仓库要求）。存量 **54 处**（BOM 10 / CRLF 17 / 末行无换行 27）冻结在 `scripts/style-baseline.json`（BOM 多为 PowerShell 写回产物、CRLF 是文档记明「不批量转换」的历史文件、末行无换行多为逐字节校验的补丁基线），**脱敏类刻意无基线**（用户名泄漏不该有「存量」）：路径形态（`C:\Users\<段>` 必须是占位）**永远生效**，裸词形态的词表来自 **`_refs/identity-terms.txt`（本地不入库，CI 缺席时显式打印跳过）**；脚本内置自证（四类必命中 + 占位不误报 + 裸词大小写敏感），故障注入实测 `exit 1` 并点名文件 | PASS |

> ※ **本表口径（2026-09-30 订正）**：**项数列**已对齐当日全量基线（**168 项 / 十类全 PASS**，见 §3.0 顶部）；
> **「内容」列**是 2026-09-26/27 时点写下的闸门详述，其内的用例数与文件数**不再逐项同步**
> （例：sidebar 当时 8 个测试文件 62 例，现为 11 个测试文件 86 例）——逐项最新清单以
> [`scripts/verify-all.mjs`](../../scripts/verify-all.mjs) 与各线 `CHANGELOG.md` 为准。

> ※ **desktop 的 `cargo test` 项在非 MSVC 环境是环境假阴性**（2026-09-11 实测）：Git Bash 的 `PATH` 中
> `/usr/bin/link.exe`（GNU coreutils 的 `link`）会遮蔽 MSVC 链接器，报
> `link: missing operand` / `link.exe returned an unexpected error`。
> 判据：`cargo check --bin miasaki --tests` 仍能通过（编译无误，仅链接阶段失败）。
> 正确跑法是在 VS 2022 的 x64 开发者环境（`vcvars64.bat` / x64 Native Tools）或带 MSVC 的 PowerShell 中执行。
> 2026-09-12 全量重跑即在带 MSVC 的 PowerShell 中执行，该项 **PASS**（10 例全绿）。

> ※※ **【2026-09-19 已修，本条判定作废】** sidebar 的 `terminal-hub.test.js` 曾在受限沙箱下整片失败
> （2026-09-12 首次归因，当时基线 sidebar 9/10）：该文件的注释与本线 README 都写着「fake pty 注入，
> 不需要真实 shell」，但 `_spawn` 里的 `resolvePtyBin` 会走 `where.exe` 解析 shell 的**绝对路径**
> （T2 spike 纪律：conpty 拒绝裸名）——**子进程 + 管道捕获**，而受限沙箱禁止管道捕获子进程输出
> （`EPERM`）⇒ 落入 catch 后抛 `未安装或找不到 powershell.exe`，用例在到达被测分支前就失败。
> **判据**（当时）：同一环境里 `where.exe powershell.exe` 以 `stdio: 'inherit'` 运行退出码 0 且打印
> `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` —— PATH 里有、只是不能捕获。
> **修法**：`TerminalHub` 构造函数新增 `resolveBin` 选项（默认仍是 `resolvePtyBin`，**生产行为不变**），
> `_spawn` 改调 `this._resolveBin(shellDef)`；测试的 `makeHub()` 注入绝对假路径 ⇒ 单测与宿主 shell
> 彻底解耦，名副其实。**现状**：受限沙箱下直接
> `node dsh-miasaki-sidebar/test/terminal-hub.test.js` → **15/15 全绿**，**无须再切普通终端**。
> 保留本注记仅为记录归因过程与「模块级硬引用漏在注入点之外」这一测试设计教训。

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
| host 半生效 | 重启 `dsh web` | `GET /sidebar/api/health` 返回当前 `version`（sidebar 现为 `0.10.0-miasaki.0`） |
| client 半生效 | 重启 host **后**刷新页面 | 会话头 / 标题栏出现按钮 |
| 停用可恢复 | 移除插件 → 重启 host | DSH 原生界面无残留（右栏推挤复位、会话头按钮消失） |
| 运行时补丁在位（5 个） | 对 `dsh-miasaki-desktop/patches/*/patch.mjs` 逐个 `node … status`（settings-models / conversation / trajectory / chat / cordis-host-runner） | 输出 `patched`；**DSH 升级后变 `unknown` 即需按该目录 README 重打**；trajectory 与 chat 两个计时补丁**必须一起重打**（同一个 `firstTokenTime` 的两处显示）；cordis-host-runner 是唯一作用于 **host 侧 Node 包**的补丁，改完必须**重启 host**（其余四个作用于浏览器 bundle，刷新页面即生效） |
| 运行时补丁在位（attachment，第 6 个） | `node dsh-miasaki-desktop/patches/dsh-client-ui-attachment/patch.mjs status` | 输出 `patched`（多图 tile 宽高比保持，纯 CSS，刷新页面即生效） |
| **补丁 live 状态一键审计（2026-09-23）** | `node scripts/patch-live-audit.mjs`（`--json` 机器可读） | 七行全部 `patched` 且退出码 0。判定分两档：**live dsh 版本 == 补丁 baseline 却未 patched → 🔴 回归（退出码 1）**；版本已漂移导致未打 → 🟡 待重打（退出码 0，属升级后预期）。存在的意义：`verify-all` 的 `patch verify` 是**离线自证**（升级覆盖后仍 PASS），回答不了「补丁此刻在不在 live 安装里」——0.1.7 升级后六个补丁曾全部静默 `unknown` 数日（dual-model 发图被拒即在位发生），本工具把这类盲区变成一条命令 |
| 双模型准入补丁在位 | `node dsh-miasaki-dual-model/patches/dsh-api-session-controller/patch.mjs status` | 输出 `patched`；**该补丁与 dual-model 插件必须同版本上线**——补丁负责放行、插件负责真的有人能处理图片，只打前者会让图片被静默丢弃 |
| 计时面板可恢复 | 刷新页面 → 打开任一**已结束**步骤的轨迹计时面板 / 悬停消息耗时面板 | 首 token 延迟、生成、吞吐量三行与气泡「首 token 用时（TTFT）」均为数字（修复前为「首 token 时间不可用」） |
| 外观线 host 半生效 | 重启 `dsh web` → `curl -s http://127.0.0.1:3080/appearance/api/state` | 返回 `{"config":{…},"revision":N,"persistent":true}`；`persistent:false` 表示 `cordis.patch.yml` 的 `dataDir` 没传进 config（改动只存在于内存） |
| 模型探测插件 host 半生效（连通性 v2） | 重启 `dsh web` → `curl -s http://127.0.0.1:3080/model-probe-api/health` | 返回 `{"ok":true,"version":"0.1.0","protocols":[…],"timeoutMs":15000}`。**404 = 插件未被 host 加载**——此时设置页按钮会自动降级为目录探测并附提示（功能不缺失，但口径变旧） |
| 用量统计 host 半生效（第八线） | 重启官方桌面端 → `curl -s http://127.0.0.1:3080/dsh-token-monitor/global` | 返回 JSON 且含 `"profile":"desktop"`；**404 = 该插件未被 host 加载**。账本按 profile 分区（`~/.dsh/plugins-data/dsh-token-monitor/<profile>/`）——官方桌面端只记载官方消耗，实机判据见 §3.8 |

> **部署契约（易踩）**：sidebar/canvas 改代码后，只刷新页面无效、强刷也无效——
> **必须重启 `dsh web`**。`/sidebar/api/health` 的 `version` 字段是判断 host 是否已加载新 bundle 的
> 唯一可靠信号（版本号与 `package.json` 同步维护）。

> **sidebar cwd 守卫自检**（2026-09-08 修复后应保持，重启 host 即可用 curl 复验）：
> `curl -s -X POST -H "content-type: application/json" -d '{"shell":"cmd","cwd":"relative"}' http://127.0.0.1:3080/sidebar/api/terminal/open`
> 应返回 **400**「需要工作区的绝对路径」——修复前该请求返回 404（相对路径被 resolve 到 host 进程 cwd）。
> 自动化覆盖见 `dsh-miasaki-sidebar/test/api-routing.test.js`（**12 项**，走真实 HTTP；2026-10-05 实测 `node dsh-miasaki-sidebar/test/api-routing.test.js` → tests 12 / pass 12）。

## 3. L3：实机冒烟

### 3.0 实机验收台账（可勾选 · 2026-09-26 建立）

> **为什么单列一节**：L0/L1 能自动跑，红了就是红了；L2–L4 只能人工执行，**不做成可勾选项就无法度量**。
> 2026-09-26 实测本文件 checkbox 数为 **0** —— 也就是说「六条线的实机验收全部积压」这件事，
> 在文档里是**不可见的**，没有任何机制保证它会发生。本节唯一用途：让这笔债务**可数、可勾、可交接**。
>
> **勾选口径**：验完一项把 `- [ ]` 改成 `- [x]`，行尾补日期与一句结论（可指向截图/证据路径）。
> 判据正文在各 §（括号内标注），本节只做登记、不重复判据。
>
> **状态：9 / 114 项已验收**（**分母口径 = §3.0 台账里的 checkbox 总数**）。
> **2026-10-05 机器对账订正**：原文写「7 / 109」，逐条数出来是「9 / 114」——
> 勾选数少记 2（**K2a / K2b-1** 两个子项已勾但没计入），分母少记 5（其中本批新增 **E18 M4.1 边缘停靠**
> 与 **E23 启动片头** 两项，其余 3 项是 09-30 之后补立未同步的存量漂移）。
> **核对命令**（分母/已勾一律以机器统计为准，不用手数）：
> `Select-String -Path dsh-miasaki-shared-docs/cross/smoke-test-matrix.md -Pattern '^\s*- \[[ x]\]'`。
> **2026-09-30 增勾 3 项**：
> **K3**（交付物反向存在性）、**K5**（厂商表断链）、**J5**（上游补丁 live 审计）—— 三项都是
> 「修完即由自动闸门验证」的形态，证据与判据写在各行内（K3 首跑即抓到存量 7/9 任务「已验收却无交付物」；
> K5 有「真实表存在且合法」的用例；J5 有故障注入三态自证 + 11 目标 live 审计）。
> 同批**补立 1 项**（**I6**，静默失效 #18）⇒ 分母 **102 → 103**：此前「拿不到 profile 名就落共享兜底桶、
> 页面却宣称完全隔离」这条债务**在文档里没有编号**（无编号 = 不可见，与本仓 09-29 补账的教训同源）。
> **如实保持未勾的两项**：**K4** 判定逻辑已由 9 例覆盖、语法闸门有故障注入自证，但**端到端仍需一次真实派单**
> （worker 交付 `status=blocked` ⇒ `status.json` 应落 `blocked`）；**I5** 围栏已补并 13 例覆盖，
> 但**待重启 `dsh web` 后复验两轴 403**（此前实测 200）。建立于 2026-09-26（当日 1/49，
> 唯一勾选项 SSH A16）；2026-09-27 增 F3 / E9 / D8 / H1 四项；**2026-09-29 补账 —— 第一次让债务数字反映真实**：
>
> ① **补勾 3 项（逐项核过结果文件，不是照方案点名）**：**A6**（D3 四档响应式，2026-09-15 实机全过）、
>    **A22 / A23**（G1 SFTP 自愈 + G2 慢 viewer 背压，2026-09-28 实机 **23/23**，证据
>    `_refs/scripts-archive/ssh-g1g2-live/evidence.txt`）。
> ② **否定一笔拟补勾**：U2 实机验收的结果文件是 `allPassed:false`（2026-09-16 逮到 4 处产品缺陷，
>    含「同主机多 shell 输入全落 ch-1」高危），修复后**复验未跑** ⇒ A10/A11 按「需按当前版本重跑」记。
>    D2（24 项全 PASS）/ D4（6 项全 PASS）为真，但只覆盖部分台账项，且 2026-09-25/26 起入口判据、
>    连接表单、弹层形态有多批改动 ⇒ 其余 SSH 项同样按「需按当前版本重跑」记（行内注 Partial 证据）。
> ③ **新立 53 个编号**：此前「判据在各 §3.x / §2、台账无号」的债务全部编号 —— sidebar M2.1 四项（C6–C9）、
>    appearance Boot Splash ×2 / 动效 ×2 / 修订冲突 / 面板契约（D9–D14）、usage 五项（I1–I5）、
>    desktop 十一项（E11–E21）、ssh 七项 + U3（A17–A24）、canvas 功能主链路（F4）、dual-model §3.10 余五行
>    （B4–B8）、free-model 专节（J1–J5）、fleet 专节（K1–K5）、补丁与装卸契约三项（M1–M3）。其中 **U3
>    同步补 §3.6 判据行**（此前无编号也无判据，是 25 条静默失效的第 1/2 位）；free-model / fleet 标注
>    「专节待立」；fleet 的 K3–K5 是「先修后验」项（未修的静默缺口，修后在此验收）；**I5 是补账代跑时
>    新发现的缺口**（usage 是唯一没有同源围栏的线，实测两轴 200）。至此 §2 与 §3.0–§3.11 的每一行
>    判据都有台账编号。
> ④ §1 顶部同步 rc.2 适配（**工作区 14 文件、待提交**）后的口径：desktop 36 → 35、全量 164 → **163**
>    （cordis-host-runner 补丁退役出册，**口径变化不是退化**；2026-09-29 实跑 163 项全 PASS 复核）。
>
> **可代跑项已代跑（2026-09-29，3080 实例当前加载 bundle）**：围栏 403 四线实测（ssh / appearance /
> dual-model 两轴 403 ✅，usage **200 ❌ ⇒ 立 I5**）；`patch-live-audit.mjs` **10/10 patched**（M1）；
> free-model 上游补丁 **5/5 applied**（J5）。重启后需按新 bundle 复跑的项不受影响（围栏判据与代码均未在途变更）。
>
> **前置**：`dsh web` 重启 + 桌面壳重启 + 浏览器强刷（各节另有前置说明）；**E10 另有硬前提**：
> `npm run deploy` 重编 exe —— 2026-09-29 二进制级实测，E10 修复**未进用户双击的那个 exe**
> （exe 内无 `--ms-titlebar-clearance`、源码侧更新），不重编则勾了也是假象。

**A. SSH（§3.6，M1 + U0/U1/A0 + D2–D4 + U2 + U3 + G1/G2）**

- [ ] A1 真实连接：新建主机（用户名必填、不默认 root）→ 密码/私钥/agent 连接成功且**终端有输出**
      （**对账 2026-09-29**：连接核心两度实证 —— 09-16 U2 验收 P0（`connected=true` + 终端 43 行）、09-26 A16 页面路径（终端出现 Welcome + 提示符）；09-26 同日「实机四修」改过连接表单（端口回填 / tryKeyboard / 居中弹层）⇒ 整项按当前版本复跑）
- [ ] A2 指纹闭环：首连 TOFU → 指纹变更 mismatch（无「仍然继续」）→ 忘记 → 重连重新 TOFU
      （**对账 2026-09-29**：U2 验收 P0b 曾 FAIL —— TOFU 入口被 `STALE_SHELL` 横幅覆盖（已修未复验）；mismatch / 忘记 / 重信全环从未实机跑过。安全红线级）
- [ ] A3 attach 恢复：切对话/画布再回来 scrollback 回放；同主机重复打开不重复 connect
      （**对账 2026-09-29**：D2「真协议零损失」覆盖「重复打开不重复连接 + iframe 未重载 + 30 次开关零帧」；scrollback 回放未单独判 ⇒ 复跑）
- [ ] A4 标签语义三分：仅关闭查看 / 关闭此 shell（连接保留）/ 断开整个连接
      （**对账 2026-09-29**：U2 验收 P2a FAIL ——「关闭此 shell」按钮缺席（U2-C 多 shell 串台的连锁），已修未复验）
- [ ] A5 终端功能：Ctrl+Shift+C/V（Ctrl+C 仍中断）、查找 n/m、字号 12–20 且 PTY 跟随、多行粘贴先确认
      （**对账 2026-09-29**：U0/U1 期「待实机合并验收」积压至今，未跑）
- [x] A6 响应式三档：≥960 双栏 / 720–959 紧凑 / <720 抽屉（Esc 关闭、焦点归还）、零横向溢出 —— **2026-09-15 已验（D3 四档宽度实机：1280 rail 232 / 960 rail 208 / 720·480 抽屉，四档零横向溢出 + 三主题 × 1280/480；驱动 `_refs/scripts-archive/ssh-d3-accept/`）**；其后改动仅涉弹层形态（09-26）与运行时背压（09-27），未动响应式布局
- [ ] A7 主题桥接：pure 亮/暗 + 刻刻帝 + 狂狂帝四种组合换肤；**亮色强刷不闪黑底**；切换不断 SSH
      （**对账 2026-09-29**：D2/D3 覆盖「三主题切换不断 SSH + 顶栏 reserve 消费」；「亮色强刷不闪黑底」未单独判 ⇒ 复跑）
- [ ] A8 入口去重（B1/B2）：会话窗口右上角**不得**有独立 SSH 按钮；首屏 hero **有**且点得开；设置/轨迹页**不出现**
- [ ] A9 A0 三种意图：送出选中内容 / 最近 40 行 / 让 Agent 看这个错误 —— 首行 `[SSH <标签> · <用户>@<主机>:<端口>]` 格式正确
      （**对账 2026-09-29**：D3 覆盖剪贴板首行格式与状态栏文案；三项意图完整流未跑）
- [ ] A10 U2 多 shell 与写权：同主机多开互不串扰、接管后原 owner 转只读、某 shell 退出不影响其余
      （**对账 2026-09-29**：**09-16 实机验收 FAIL** —— 三标签输入实测全落 ch-1（U2-C 高危）+ 首连 TOFU 入口被覆盖等 4 处产品缺陷，已修（单测 110 → 113）但**复验未跑**（`_refs/scripts-archive/ssh-u2-accept/u2-accept-result.json` `allPassed:false`）。这是「回归无声地作用到错误 shell」的静默失效形态，**必须复跑**）
- [ ] A11 U2 工作区记忆 + 精确恢复：同标签页刷新恢复形状、新标签页不继承；`vim`/`top` 刷新后逐行一致
      （**对账 2026-09-29**：同上轮 FAIL 项 —— P5a 半 PASS（标签数恢复但集合错乱 `[#3,#2,#3]`）、P5b/P5c FAIL 已修未复验；U2.4「vim/top 逐行一致」当时因 addon 未上线**未执行**）
- [ ] A12 **U2.2 SFTP 往返**：文件面板列目录（`.`/`..` 不显示、大小/时间正确）→ 上传小文件 → 下载回本地字节一致；覆盖上传 409；超过 512MiB 413
- [ ] A13 **exec pipe 降级实机**：在有网关/跳板（exec 与 sftp 两个文件系统视图）的机器上上传，面板自动走命令通道并提示 transport=exec；再次上传仍直走 exec（`execOnlyUpload` 记忆）；mid-stream 失败后重试成功
- [ ] A14 **ssh config 导入**：编辑器「SSH 配置导入」下拉出现本机 `~/.ssh/config` 直连 alias，选中回填 host/port/user；含 ProxyJump 的 alias 禁选且不消失；显式 IdentityFile 的 alias 切「私钥」并填路径
- [ ] A15 **keepalive 长连接**： NAT/防火墙静默断开场景（或对端 `sleep` 模拟）约 60s 内连接报 TIMEOUT 而不是挂在「已连接」；终端有输出时连接不断
- [x] A16 **A1 工具面实机** —— **2026-09-26 已验（三轮：Agent 路径 → 页面路径 → `ssh_session_read`）**：`agentTools: true` 后三工具真进模型工具面（会话 `request/header` 的 54 个工具含 `ssh_exec` / `ssh_hosts` / `ssh_session_read`）；`ssh_hosts` 行首 `id` 可直接当 `hostId`；L0 免审批直通（`uname -a` exit 0）；L1 弹卡「允许」→ 远端收到且 exit 0、「拒绝」→ `APPROVAL_REJECTED` 且**远端 sshd 零新增记录**；人在页面连接主机（终端出现 Welcome + 提示符）后 `ssh_session_read` **读回该终端原文**（含手敲 `ls` 的输出），紧接着 `ssh_exec` 在同一连接上跑通（远端日志 `shell: opened` → `exec: "uname -a"`，**J2 通道分离实证**）；审计落盘 `dataDir/exec-audit.jsonl` 可跨重启查。**页面路径必须与 Agent 路径同口径实测**（本轮靠人工复验才照出 REST 404 / attach 400 两处 connId 口径漂移 —— Agent 走 store 直查永远照不到）。基座 `_refs/scripts-archive/ssh-a1-live/`（真 `ssh2.Server` + 隔离 dataDir + 一次性密钥）
- [ ] A17 工作区布局：SSH 页 = 左主机导航（搜索 + 分组 +「N 个连接保留中」）+ 右标签区 + 底部状态栏，**无整页连接库**（§3.6「工作区布局」行；U1 期（2026-09-12）待实机合并验收积压至今）
- [ ] A18 围栏不回归：非环回 Host / 跨站打 `/ssh/api/*` → **403**；伪造 origin 的 WS upgrade 被拒（§3.6「围栏不回归」行；HTTP 层**可代跑**）
      （**2026-09-29 代跑已核**：伪造 `Host: evil.example.com` 与跨站 `Origin` 两轴打 `/ssh/api/state` 均 **403**（3080 实例当前加载 bundle）；WS upgrade 轴需浏览器环境，未代跑）
- [ ] A19 弹层形态：新建 / 编辑主机、连接密码、TOFU 确认全部为**居中悬浮窗**——1540×1042 / 640×820 / 480×640 三档 + 连接密码 + 无壳五场景下与右下角主题球**重叠面积为 0**、确认键点得到（§3.6「弹层形态」行；2026-09-26 探针 5/5 过 —— 宿主页加载真实壳注入产物，**live 未验**）
- [ ] A20 连接诊断：主机菜单 `⋯` →「连接诊断」与编辑弹窗「测试连接」开出诊断面板——结论条五态（可达 / 不是 SSH / 超时 / 拒绝 / 认证方式受限）+ 事实格；「查询公网出口 IP」**不点不查**、「探测认证方式」**不点不发**（点了也只发协议自带 `none`，服务器侧无失败密码记录）；「复制报告」是可粘贴纯文本（§3.6「连接诊断」行）
- [ ] A21 只读条：**未连接 / 已断开 / 未开 shell 时不出现**「只读：另一个窗口正在此终端输入」黄条（旧版常驻）；仅会话活着且被其他窗口接管时出现，点「接管写入」能夺回（§3.6「只读条」行；2026-09-26 修复未 live 验）
- [x] A22 **G1 SFTP 自愈** —— **2026-09-28 已验**（关子系统后 list 仍 200 且服务端子系统计数再 +1；真实例 × 真协议 sshd × 真实路由，23/23 中的 G1 十二项；证据 `_refs/scripts-archive/ssh-g1g2-live/evidence.txt`）
- [x] A23 **G2 慢 viewer 背压** —— **2026-09-28 已验**（洪水 33.5MB 过 WS、慢 consumer 收 `output.paused` 且零 1011、drain 后 `output.resumed`、连接全程 connected；**状态栏文案的视觉层待下次重启顺手复验**）
- [ ] A24 **U3 跳板与本地转发**（§3.6 判据行 2026-09-29 补立）：① **跳板**：主机编辑器「经由跳板」选一条**已受信任**主机 → 目标连接经其 `forwardOut` direct-tcpip 通道建连成功且终端有输出；跳板从未连过 / 未就绪 / 正在等指纹 ⇒ `JUMP_UNAVAILABLE` 结构化可读拒绝（**不挂死、不静默失败** ——「不把发起认证暴露成隐式能力」）；② **本地转发**：编辑主机加规则（本机 `127.0.0.1:localPort` → 远端 `remoteHost:remotePort`）→ 连接建立后自动监听、**本机端口字节级往返通**、断开自动撤下；端口被占（`EADDRINUSE`）/ 服务端拒绝转发 ⇒ 状态栏可见异常且**连接状态不翻 error**（终端照常可用）；③ **反例（静默失效红线）**：端口在听 ≠ 转发通 —— 必须字节往返判据。**需外部资源**（跳板 + 目标两台真实机器，或本地假 sshd + 真 echo 服务的等效环境）

**B. 双模型（§3.10 —— 2026-09-26 才补上判据节）**

- [ ] B1 控件出现：输入框右下角出现「双模型」触发钮（`conversation.input.right`）
- [ ] B2 路由生效：配好辅助模型后拖入图片 → 状态行显示「图片将由「X」处理」
- [ ] B3 纯文本主模型仍可传图：切到纯文本主模型后发送带图消息 → **发得出去且模型读到了图**（不是静默丢图）
- [ ] B4 辅助模型配置：点开面板只列**支持图片**的模型；选中保存后重开面板值仍在（配置落盘）
- [ ] B5 零退化：未配辅助模型时拖入图片 → 行为与未装本线一致（准入走官方原生分支，不额外拦截、不报错）
- [ ] B6 无副作用：发送纯文本消息时当前模型不被切换（`keep` 路径不抖配置）；发过图之后的历史引用旧图仍能正确路由
- [ ] B7 失效信号：在别处改动模型设置后本线缓存被击穿（0.1.7 双轨失效事件），面板不显示陈旧值
- [ ] B8 同源围栏：非环回 `Host`，或 `Origin` 与 `Host` 不一致时打本线 `/state` → **403**（`index.js` 的 `fenceOk`，两道判定；HTTP 层**可代跑**）
      （**2026-09-29 代跑已核**：伪造 Host / 跨站 Origin 两轴打 `/dual-model/api/state` 均 **403**、环回正常请求 **200**，`fenceOk` 两轴实测有区分力）

> **与 `dsh-miasaki-dual-model/design/2026-09-29-live-acceptance-checklist.md` 的关系**：那份清单分
> A1–A4（可代跑：围栏 403 / 能力目录 / 图片归属 / 控件注册）与 B1–B4（需人眼）两张；**以本节为勾选口径**，
> 清单作为「谁能代跑」的分工参考。B3 是本线「绝不静默降级」硬契约的实机判据（2026-09-29 准入修复后仍未闭环）。

**C. Sidebar（§3.4，v0.7.0–v0.10.0 四版积压）**

- [ ] C1 插件加载 + 入口胶囊：`GET /sidebar/api/health` 返回现行版本；引导页出现「审查」与「辅助对话」**两个**胶囊
      （**口径订正 2026-09-29**：原文写「一个」，那是 2026-09-28 M2.1 落地**之前**的状态，与 §3.4 的两胶囊判据冲突 —— 照原文验会误判）
- [ ] C2 审查 tab：四视图切换即拉取、目录分组统计 = 组内求和、点名往返持久化、单文件 diff 行级展开
- [ ] C3 审查视图持久化：切到「上一轮更改」→ 关 tab / 刷新 → 重开仍是该视图
- [ ] C4 底部终端面板：Ctrl+` 唤起、多标签多开、cwd 跟随当前会话、刷新后存活会话恢复为可见标签
- [ ] C5 共存与门：canvas 全屏 overlay 盖住右栏为预期；切窗口 60s+ 回来不因隐藏期 TTL 重复拉取
- [ ] C6 **辅助对话 tab（M2.1）**：点「辅助对话」胶囊 → 右栏出 tab（页型，同格去重）；点「新建侧线」→ fork 出侧线，面板里渲染官方 embedded 会话 + 原生 composer；侧线头显示「主会话：<标题>」与提示条「说『继续』等于接着做主线未完成的活」
      （**口径订正 2026-09-30**：原文写「面板里渲染出主会话继承来的历史」，那是继承段折叠**之前**的形态；自 C12 起继承段默认不画 —— 照原文验会把「干净」误判成缺陷。模型侧仍继承全文，见 C7）
- [ ] C7 **侧线不打断主任务（M2.1 核心）**：主会话**正在跑**时点「新建侧线」→ 侧线立刻可用、**主会话继续跑完不中断**；侧线继承的历史**止于上一个已完成轮次**；反例：主会话首轮运行中（0 个完成轮次）→ 出人话引导「先让主会话跑完一轮」，不是宿主错误串
- [ ] C8 **侧线登记表与刷新还原（M2.1）**：开侧线后 localStorage 出现 `miasaki-sidebar:sidechat:v1`（`{父会话: {activeChildId, lines[]}}`，fork 成功即写盘）；**刷新页面**后官方右栏自动还原 tab、且面板显示的是**同一条侧线**（childId 不变、不重复 fork）——官方持久化里没有 `params`，这条身份只能靠登记表
- [ ] C9 **多侧线切换（M2.1）**：同一主会话开第二条侧线 → 侧线头出现「侧线 1 / 侧线 2」切换器；来回切换不报错，正文各自对应
- [ ] C10 **侧线 goal 补偿（决策⑥ / S9，2026-09-30 补立）**：`fork` 零类型过滤拷贝日志前缀 ⇒ child 继承父会话 goal / plan / todo。**判据**：① 主会话有活动 goal 时新建侧线 ⇒ 侧线头与正文**不显示父会话目标**；② 侧线里再建 goal 不报 `GOAL_ALREADY_EXISTS`；③ 侧线会话记录里能看到一条 `goal/change{operation:'clear'}`（代价如实记账）；④ **plan / todo 无客户端 API** ⇒ 文档如实声明，不做假承诺。**2026-09-30 已修**：`clearInheritedGoal(ctx, childId)` 模块级函数（官方 `goals.get` → `clear` 同款调用），fork 成功后**不 await**（不阻塞、不污染返回链路），服务缺席静默返回、失败仅 `console.warn` 留痕不外抛；`test/sidechat-registry.test.js` **13 → 19 例**。**待实机**：上述 ①②③
- [ ] C11 **辅助对话不占会话记录（2026-09-30 补立，用户报障点）**：新建/已有侧线**不出现在**左侧会话列表与会话搜索里。**判据**：① 开一条侧线 → 刷新页面（**必须刷新**：补丁作用于客户端 bundle）→ 左侧列表与搜索里**都没有**那条侧线，主会话仍在原位；② localStorage 出现声明键 `miasaki-sidebar:sidechat:hidden:v1`（JSON 字符串数组，含侧线 childId），登记表 `miasaki-sidebar:sidechat:v1` 仍在；③ **反例（判据的判据）**：清掉声明键再刷新 ⇒ 侧线重新出现在列表里（证明「不显示」确实由声明驱动，而不是碰巧）；④ **官方原状**：未装本插件的环境里该键不存在、列表行为一字不变（补丁 fail-safe）。实现与代价见 desktop 线 `patches/dsh-client-ui-workspace/README.md`。**待实机**：①②③
- [ ] C12 **侧线继承段不显示（2026-09-30 补立）**：侧线面板打开即只有**本侧线自己的问答**，从主会话 fork 继承来的历史不画；侧线头显示「上文已折叠 N 轮，**模型仍然看得见**」。**判据**：① 主会话跑完 ≥2 轮后开侧线 ⇒ 面板里看不到那 2 轮，只看到侧线自己问的；② N 与主会话已完成轮数一致；③ **模型侧仍继承**：不问任何背景，直接问「我刚才让你做什么」⇒ 侧线能答出主会话的事（证明折叠是**显示层**的，不是丢上下文）；④ 主会话与官方 subagent 会话的时间线**零变化**（折叠 CSS 作用域限定 `.dsh-sidebar-sidechat-body`）；⑤ 轮数 > 200 时**放弃折叠**而非生成上千条选择器（宁可不折叠，不拖慢页面）。**待实机**：①②③④

**D. 外观（§3.5 / §3.5b，M2 视觉矩阵 + M2.5/M2.7 图标 + 2026-09-26 去重）**

- [ ] D1 M2 视觉矩阵：皮肤 × 明暗 × 玻璃四档逐组目检（12 组）
- [ ] D2 **关掉即原生**：总开关关闭后与未装本线**可见像素一致**。
      **口径订正（2026-09-29）**：原判据写「无残留样式与属性」，但实现是**首帧无条件写 4 个
      `data-mia-*` 门控属性**（`appearance` / `skin` / `glass` / `wallpaper`，关闭时取值 `off`/`pure`）
      —— 按字面该判据**必然失败**。属性是设计如此（CSS 选择器据此匹配，关闭态无消费者 ⇒ 零视觉影响），
      故比对只看**渲染结果**：截图 diff 为空即可，不要求属性缺席
- [ ] D3 首帧不闪：强刷不出现「先原生、后跳外观」
- [ ] D4 越权防护：非环回 Host / 跨站打 `/appearance/api/state` → 403；未定义路径 → 404
      （**2026-09-29 代跑已核**：伪造 Host / 跨站 Origin 两轴均 **403**（3080 实例）；「未定义路径 → 404」分支未同批测）
- [ ] D5 应用图标：预设点选 → 1.5–2s 内任务栏 / 窗口左上角 / 托盘三处跟随；上传 / 清单 / 清除回退 / 坏文件不崩
- [ ] D6 桌面壳让位协议：`data-miasaki-theme-yield` 免刷新翻转；切换条双入口；aurora×壁纸叠加
- [ ] D7 **与通用页去重复核**：外观栏**不出现**「明暗偏好（浅/深/跟随系统）」与「正文字号」两行（它们在官方「通用」设置页）；`document.documentElement` 上**无** `data-mia-scheme` 属性；「皮肤」行仍在且说明指向「通用」页
- [ ] D8 **M4 会话效果**（§3.5 两行判据）：六行控件在位且总开关关闭时整组禁用；密度「紧凑」可见消息流收紧；宽度设非 0 会话列跟随且输入卡片不变、改回 0 交还官方；正文字体 / 流式光标（流式中可见、reduced-motion 不闪）/ 引用与代码块三档各见其效。**2026-09-30 补「锚点失配提示」**：官方升级改了会话内部锚点（`[data-chat-flow]`）时密度 / 宽度会**静默失效**（面板可点、保存成功、界面零变化）—— 现由面板自检，**能确定失配时显式提示**（判据见 §3.5；`test/client.test.js` 四例覆盖失配 / 正常 / 无法判定 / 未开启四态）
- [ ] D9 **Boot Splash 出现与淡出（P2）**：冷启动（后端已热）可见全屏启动画——皮肤底色 + 纹章双环旋转（刻刻帝顺 / 狂狂帝逆 / 纯净静止）+ MIASAKI wordmark + 三点流动；shell 挂载后 **≤400ms 淡出**、无「splash → 原生 → 外观」三段跳；三主题 × 明暗下底色/强调色随之；系统开「减少动画效果」后全部静止、功能不变；`~/.dsh/miasaki-appearance/config.json` 的 `version` 为 5、`motion.bootSplash` 为 `auto`（§3.5「Boot Splash」行）
- [ ] D10 **Boot Splash 硬用例**：① 未认证访问（URL 未带 token）首帧非 shell ⇒ splash **2.5s 内淡出**、不挡住「重新打开 URL」提示；② 总开关关闭或 `motion.bootSplash:'off'` ⇒ 首帧与原生 **diff = 0**（无 splash 三行、无 `#mia-splash` 节点、无 `data-mia-splash-done` 残留）（§3.5「Boot Splash 硬用例」行）
- [ ] D11 **动效板块与容器入场（M3；设置面板锚点 2026-09-29 修正）**：「动效」三控件在位（官方 Switch 总开关 + 预设选择丸 流畅/优雅/极简 + 强度步进器 0.5×–1.5×）；开总开关后切会话 / 开右栏 / 打开本设置面板可见容器入场——会话表面竖向浮起 + 轻微缩放，侧栏 / 右栏窄高竖条横向滑入（不缩放）；强刷可见加载错峰（侧栏 → 会话 → 右栏先后入场）；切预设与调强度即时改变观感；关总开关后入场消失。**设置页内**：打开设置 ⇒ 面板整块入场一次；八个页签之间连点 ⇒ **一律瞬切、无单页浮起**（§3.5「动效」行）
- [ ] D12 **动效降级硬用例**：系统「减少动画效果」（`prefers-reduced-motion: reduce`）⇒ 所有入场收敛为 **100ms 淡入**、无位移无错峰，功能不变（**设置面板同样降级**，不与其余页签拉开差异）；DevTools 渲染面板模拟 reduce 同效（§3.5「动效降级硬用例」行）
- [ ] D13 **修订冲突可复现**：两个标签页都开面板——A 改一次后，B 用旧修订提交 → B 显示「配置已被其它窗口修改，已载入最新值」，**不静默覆盖**（§3.5「修订冲突可复现」行）
- [ ] D14 **面板与契约条 + V1 控件形态**：设置左栏「外观」在「通用」之后、「模型」之前（`settings.section` 的 `order: 5`）；面板顶部绿色「契约自检通过」（有降级项显黄条并逐条列出）；皮肤 / 壁纸图源 / 玻璃档位 / 我的上传四行全是**选择丸 + 下拉**（与官方「通用」页语言行同规格，**不是一排胶囊**），长文件名在选择丸内截断 + 悬停 title 给全名；总开关往返：开 ⇒ `document.documentElement.dataset.miaAppearance === 'on'` 且 config `enabled: true`，关 ⇒ `'off'` 且 `false`（§3.5 首四行 +「控件形态（V1）」+「总开关往返」行）
- [ ] D15 **每板块恢复默认（P4，2026-09-30 补立）**：主题 / 壁纸 / 应用图标 / 动效 / 会话效果各一行「恢复…的默认设置」。**判据**：① 改掉某板块的任一项 ⇒ 该板块出现该行，点一下回到**出厂值**（含把该板块旧版本残留字段一并收窄掉）；② 板块已是默认 ⇒ **不出现**；③ 旧 host 不下发 `defaults` ⇒ 出现「重启宿主后即可用」提示而不是静默失效。**2026-09-30 已修**：`/state` 新增下发 `defaults`（`lib/config.js` 的 `DEFAULT_CONFIG` 是唯一来源，客户端不另存一份）；`test/client.test.js` **32 → 36 例**。**待实机**：上述 ①②③（一次 `dsh web` 重启即可验）
- [ ] D16 **配置导入 / 导出（P5，2026-09-30 补立）**：**判据**：① 导出得到 `miasaki-appearance-config-v6.json`，内容含 `kind` / `version` / `config`；② **导入 = 整体替换** —— 导出后把配置改乱（改皮肤 + 开动效 + 调宽度），再导入该文件 ⇒ **完全还原**（含「文件里没写的板块回到出厂默认」这一条）；③ **二次确认**：点取消 ⇒ 配置**一个字段都不变**；④ 拖入一个普通 JSON（非本线格式）⇒ 人话错误且不写；⑤ 裸配置对象（手写只有 `theme` 的 JSON）也能导入。**2026-09-30 已修并自动验证**：host 侧 `POST /config` 支持 `replace:true`（`sanitizeConfig` 整体收窄替换；非对象 400 显式拒绝，不静默清空），`/state` 下发 `defaults`；client 侧导出/导入按钮 + 二次确认门（无法确认则取消）；`test/host.test.js` **18 → 24 例**、`test/client.test.js` **36 → 41 例**。**待实机**：上述 ①②③④⑤（需重启 `dsh web`）

**E. 桌面端（§3.1 / §3.2）**

- [ ] E1 P10 鉴权：改走官方 token 后冷启动可进 DSH 页，401/404 分支给出可读提示
- [ ] E2 桌宠六态：切会话/发问 → thinking/done 立绘与气泡正确；FleetBlocked 与 DSH 等待审批优先级正确
- [ ] E3 让位与主题：W4 窗口底色跟随主题；W4.2 材质分层（`mica` 档只一层模糊）；标题栏让位不叠压
- [ ] E4 W0/W1 主题来源与契约：loading 页与 DSH 页主题一致（无「先深后浅」闪窗）；`miasakiDesktop.protocolVersion === 1`
- [ ] E5 W2 取证与可靠性：挂起取证报告、托盘隐藏不假报、恢复三按钮、Job 回收、报告轮转 10 份
- [ ] E6 W3 关闭语义：首次弹原生确认（取消可回退）→ 再点直隐；托盘「退出」确实停后端
- [ ] E7 P7 心跳通道 / URL 不再抖动：静置 3 分钟后 `History` 文件不再持续增长、`pet.log` 的 `doc-boot` 停在个位数
- [ ] E8 P9 后端拉起不依赖 `cmd.exe`：启动页不再「未检测到 dsh」、失败页自证两行都在
- [ ] E9 **契约 v1.2 + 让位量归壳**（2026-09-27）：`chrome.bounds()` 返回 `.tb-group` 矩形且 `width+20` == `--ms-titlebar-reserve`（108→128 / 136→156）；DevTools 里往组里插一个 `.tb-btn` ⇒ 变量自动变 184、移除后回落（**无刷新、无需插件配合**）；**`--ms-titlebar-reserve` 必须始终 ≥ 组实宽 + 8** —— 否则官方「打开右侧边栏」ExpandButton（28px 盒）压住 sidebar 的终端键（2026-09-27 用户报障的实机事件）；写者两条路径须分清：新壳（有 `chrome.bounds`）自动算、**sidebar 不写**；旧壳（无该能力）由 sidebar 按同源公式补位；画布与 SSH 的让位在插键后不叠压（判据见 §3.1 表同名行）
- [ ] E10 **顶部安全区：官方页面标题行不落进窗控带**（2026-09-29，重编 exe 后）：打开插件页 → 右上角「＋ 添加插件」胶囊**完整可见**，与 `- □ ×` 三键 / 主题徽记无叠压；DevTools 里 `getComputedStyle(document.querySelector('#root [class*="_pageHead"]')).marginTop === '21px'` 且「动作区上沿 − 窗控组下沿」≥ 8px（实测 12px）；再打开日程页（自动化任务）同一条规则生效（`_pageHeading`）；浏览器直开 `http://127.0.0.1:3080`（无壳）时该 margin 不存在、页面与官方一致（自动化侧已在一次性实例上跑通 **27/27**，本项验的是**真实 miasaki 桌面端 + 用户 profile**；详细判据见 §3.1 同名行）
- [ ] E11 窗口与壳基础项（§3.1 前六行）：`dsh` 未安装 / 启动失败 / 3080 被占 ⇒ 加载页显示恢复动作组（检查 dsh / 打开终端 / 日志目录 / 导出诊断）；DSH 已运行 ⇒ 直接复用不重复拉起；二次启动 ⇒ 单实例锁唤起已有窗口；最小化 / 最大化 / 还原 / 双击顶部空白 ⇒ 状态正确、标题栏按钮同步；顶部空白拖动跟手且页签 / 输入框照常可点；关闭确认取消可回退
- [ ] E12 桌宠基础交互（§3.2 首行）：拖动 / 单击 / 双击 / 右键菜单 / 隐藏与恢复 / 屏幕外位置找回 / 分辨率变化 / 主题切换换角色
- [ ] E13 新素材上屏三行（§3.2.1）：部署 `C:\ProgramData\MiasakiApp\ui\pets\frames.json` 与仓库 SHA256 相同 + `whale/frames/` 46 帧；部署 exe 晚于素材 mtime；`pet.log` 出现 `tick0 … whale_rows=7`（旧 `frames.json` 下恒为 0，是「素材真的上屏了」唯一可靠的运行时判据）。**2026-09-28 已验（SHA + whale_rows=7 实测）；09-29 21:32 `assets.rs` / `injected/theme-init.js` 又改过且未进 exe（E10 同因）⇒ `npm run deploy` 后第三行必须复跑**（磁盘 `ui/` 优先于编译期内嵌，旧素材会静默遮蔽新素材）。**2026-09-30 新增第四行机器判据**（启动摘要「有分裂必有行」）+ 逃生门 `MIASAKI_ASSETS_SOURCE=embedded`；判定逻辑已从生成的 `assets.rs` 搬进手写 `asset_source.rs`（`cargo test` 109 → 117 例，§3.2.1 表末行）。**当日机器核对：部署目录 139 素材与仓库逐字节一致 ⇒ 该行应安静**
- [ ] E14 桌宠 v5 动效六行走查（§3.2.2）：呼吸覆盖全姿态（`idle` 外也有 ±2~3px 起伏）；切 `kurkuriel` 后 inverse `idle`/`work` 绕底边 ±2° 摇摆（此前三态彻底静止）；摇摆不吃掉底部留白（极值时脚尖不被窗口下沿切）；双击 / Done 庆祝各一次「横向拉伸 + 纵向压扁」回弹（220ms）；摇摆 / 挤压中途光标移出轮廓穿透、移回可点（无「隐形挡板」）；GDI 对象列不增、`pet.log` 的 `ULW failed` 计数与改前持平
- [ ] E15 拖拽上传附件十项（§3.1「拖拽上传附件」行）：对话页拖 PNG → 官方遮罩 → 松手 → composer 缩略图 → 发送成功；多文件混合拖入各自入轨；生成中 / 子代理视图拖文件 = 拒绝态遮罩、松手无副作用；拖选中文字 / 链接无反应；轨迹 / 用量 / 设置页拖文件 → SPA 不被导航走（安全网）；loading 页拖文件无导航无报错；超大图 → 官方 toast；窗口拖动 / 双击最大化 / 三主题 / 桌宠回归（清单十项见 desktop `design/drag-drop-attachment-upload.md` §6）
- [ ] E16 启动加载 S4a 视觉层（§3.1「启动加载视觉层」行）：三主题下纹章外环 24s 缓旋 + 光晕呼吸 + 舞台扫描线（≤.06 不刺眼）；就绪瞬间（文案「已就绪，正在进入…」）纹章 1.06 回弹一次、计时收起；等待期间「已等待 N s」读数 250ms 推进；系统开「减少动画效果」后全部静止、功能不变；失败路径（恢复动作组 / 重试）零回归（S4b 日志流待 S3 tee，不在本项）
- [ ] E17 Computer Use L3 七步（清单在 `dsh-miasaki-desktop/plugins/dsh-computer-use/README.md`）：① 主窗口「设置 → 模型」确认 **step-5-preview**（视觉模型）可用；② 新建会话 → 模式选择器出现 **「Computer Use 模式」**（preset 注册成功的 UI 判据）；③ 工具目录含 13 个 GUI 工具 + `code_agent` / `code_agent_status` / `code_agent_stop`；④ 只读验：「截个图看看当前窗口」→ screenshot 执行、图落桌面 + 剪贴板；⑤ 写入验：「打开记事本，输入 hello」→ 记事本被拉起并键入；⑥ 异常路径：以管理员运行的窗口应被拒绝输入且如实报错（不假装成功）；⑦ 背景轨：「做个贪吃蛇小游戏」→ `code_agent` 派发后台会话、立即返回、完成通知回会话。**未沙箱化真实桌面控制，写入项围观时做；HID 输入类工具在 L3 前保持未触发态**
- [ ] E18 M4.1 边缘停靠与探头（§3.2.3 八行）：拖到边 ≤18px 自动吸附（距边恰 18px）；静置 5s 缩边露 ~55%（300ms）；压上/点击拉直 ~82%（250ms）、再静置退回常驻档（300ms）；缩边态点击 = 拉直而非跳跃；探头态重启 = 全可见吸附位不回默认；探头期间无 wander 滑步、拖动即脱停靠；气泡出现同帧弹回吸附位且按钮不被裁；副屏与混合 DPI 待验
- [ ] E22 契约 v1.1 写能力七条（§3.1「契约 v1.1」行；**编号 2026-10-05 订正** —— 本项原也编号 E18，与上一行「M4.1 边缘停靠」重复，勾选时曾产生歧义）：`theme.set('kurkuriel')` 切主题；`window.controls.minimize()` 最小化；`.maximize()` 最大化 / 还原切换；`.close()` **隐藏到托盘**（不是退出）；`theme.set('bogus')` 返回 `false` 且无任何副作用；`controls.min` / `.max` 为 `undefined`（内部协议名不外泄）；SSH / 画布 iframe 内该对象仍只有三字段（写能力不泄漏到子 frame）
- [ ] E19 W5 自更新降级五条（§3.1「W5」行）：未配置 ⇒ 提示配置文件路径且**不发网络请求**；配真实 `feed` ⇒ 弹「发现新版本」选「是」打开系统默认浏览器到 `page`；`feed` 写 `0.1.0` ⇒ 提示「已是最新版本」；断网 / `feed` 不可达 ⇒ **可读的失败提示**（不静默、不假装已最新）；全程**不出现**任何下载写盘或安装动作
- [ ] E20 模型连通性探测面板（§3.7 八项）：`step` 的 `step-5-preview` 点「测试连通性」⇒ 绿色「可用 · Nms」（v1 误报文案不再出现即达标）；错 key ⇒ 「认证失败」且握手档 401 即终止（不产生生成调用）；错模型 ID ⇒ 「模型 ID 未注册或拼写错误」（不是 401、不是原始错误串）；`https://127.0.0.1:9` ⇒ 「无法连接」；挂起地址 ⇒ 「连接超时（15s）」；移除插件重启 ⇒ 降级目录探测并附提示（**不白屏、不永久「测试中…」**）；`api` 属三种协议之外 ⇒ 「暂不支持探测」不发请求；各项执行后 `~/.dsh/settings.yaml` 内容未被改动
- [ ] E21 分组账本全局侧回填生效（§3.9b 唯一 ⏳ 行）：`--merge-intent` 已写入、待 web host 重启生效 —— 生效判据：全局 `workspace.json` 的 `workspaceIds` `0 → 2`、`initialized` 回 `true`、`dsh-miasaki` 分组由 5 条扩到该 cwd 下全部会话
- [ ] E23 启动片头视频（§3.1「启动片头」行，2026-10-05）：**先看磁盘配置** —— `~/.dsh/miasaki-appearance/config.json` 的 `version` 为 **7** 且含 `boot` 板块（`intro` 为四段之一 / `audio` 布尔）。桌面壳读的是**文件**、不是外观插件内存里的迁移结果 —— 这正是 2026-10-05 修掉的那条裂缝（只迁移不落盘 ⇒ 片头永不播，根因见 desktop `design/2026-10-04-boot-intro-video.md` §10.9）；重启桌面端 ⇒ 加载页全屏播所选段（默认 `brand`）、**播完自动回落纹章层**（无「视频 → 黑屏 → 原生」跳变）；面板「设置 → 外观 → 启动」换段 / 开声音 ⇒ **下次启动**生效（不轮询）；选「关闭」⇒ 与原生一致；删掉 `boot` 板块 ⇒ 静默退化为纹章层、启动照常**且不报错**；系统开「减少动画效果」⇒ 不播片头（`ui/loading.html` 的 reduced-motion 分支）

**F. Canvas（§3.3）**

- [ ] F1 V1–V4 视觉走查 **18 张**：三主题（pure / zafkiel / kurkuriel）× 明暗 × 三档缩放（0.5 / 0.8 / 1.0），逐张比对圆角·阴影·边框·线宽·字阶（截图清单见 `dsh-miasaki-canvas/design/2026-09-12-canvas-visual-refinement.md` §10）
- [ ] F2 字重决议素材：截 720 vs 600 对比图，拍板是否下调（`styles.css` 现存 **5 处** `font-weight: 720`）
      （**口径订正 2026-09-29**：原文写「6 处」—— 第 6 个 `grep 720` 命中来自 `.card-inspector-head h2` 的颜色
      `#172033`，该行字重实为 680。按原文清点会多算一处）
- [ ] F3 **会话导航三连（DSH 0.1.7 适配，2026-09-27）**：画布里点任一卡片 → DSH 当前会话随之切换、**画布不关且不弹红条**；卡片/检查器里的回跳按钮 → 跳到对应 DSH 会话并关闭画布；画布内对某会话发消息 → 消息真的落到该会话（DSH 主区可见该提问）。console 无 `dsh-canvas: * 失败` 告警；反例（删掉一个会话后点它的卡）→ 红条带**真实原因**（`sessions.retain: unknown session …`）而不是空文案
- [ ] F4 会话布功能主链路（§3.3 首段）：切按钮 → 画布渲染 → 分支血缘 → 合并（选线 / 注入形式 / 执行）→ 菱形卡长出内容 → 原线「已被吸收 ◇」标记
      （**对账 2026-09-29**：M3/M4 期（0.1.2-rc.1）实机验过真实合并 / Ctrl 多选 / 血缘详情；其后 0.1.7 导航适配 + 2026-09-26 存储治理改过数据层 ⇒ 主链路按当前版本复跑，与 F3 同批）
- [ ] F5 **辅助对话在会话布里照旧显示并带标注（2026-09-30 补立）**：sidebar 的侧线**不在官方会话列表**显示（那是「不占会话记录」），但**画布必须照旧画出来**。**判据**：① 开一条辅助对话 → 切到「会话布」⇒ 该线**出现在画布上**（作为主会话的分支，血缘连线在位）；② 它的**线头卡**带青色「辅助对话」徽标、**血缘侧栏**那一行显示「辅助对话」（不是「分支」）、**详情页** badge 也是「辅助对话」；③ **反例（判据的判据）**：清掉 localStorage 键 `miasaki-sidebar:sidechat:hidden:v1` 再刷新 ⇒ 标注消失、**但线还在画布上**（证明「显示」不依赖标注，「标注」才依赖声明）；④ 主会话与用户自己拉的分支**零变化**；⑤ 新建第二条侧线后无需刷新，画布标注**即时跟上**（跨文档 `storage` 事件）。**解耦契约**：画布走宿主 `ctx.sessions.list()` 建线，**不读**官方列表的可见性判据（源码级禁用 `sessionVisible` / `origin === 'subagent'`），也不 import 别线包

**G. 跨线联动（§4）**

- [ ] G1 Fleet pulse → 桌宠 / pulse stale 回落 / worker 心跳过龄降级
- [ ] G2 主题 → Canvas / 标题栏 → Canvas·Sidebar 让位
- [ ] G3 DSH 审批 → 桌宠 `wait` 姿态 + 常驻气泡

**H. 平台与插件生态（§3.11）**

- [ ] H1 **记忆插件的 v4 消息来源准入**（2026-09-27 用户报障「本轮运行失败 format v4 message requires a producer-owned source kind」的修复验证）：重启 miasaki 桌面端（或 `dsh web`）后触发一轮记忆召回 → **不再出现该错误行**；`node scripts/inspect-session-sources.mjs` 能看到新写入消息的 source kind 为 `plugin:openviking-memory`；`node scripts/check-message-sources.mjs` PASS（判据正文见 §3.11）

**I. 用量统计（§3.8，第八线 `dsh-token-monitor`）**

- [ ] I1 **包名 + scope 运行时确认**：三 profile（官方桌面端 / 自制壳 / 浏览器 GUI）各重启一次，路由带 scope 后仍通；**账本目录名仍为 `dsh-token-monitor`、不得跟随包名 / scope 变**（变了 = 全量历史统计清零，静默失效第 17 位 —— 2026-09-29 已用 `LEDGER_DIR_NAME` 解耦但**无闸门**）；`/dsh-token-monitor/global` 返回的 `profile` 字段各自正确；历史统计连续（一个数字都不丢）。**2026-09-30 闸门已补**：目录名与解析抽成 `lib/ledger-dir.js` 单点，`test/ledger-dir.test.mjs` **5 例**钉住「目录名冻结为历史值」+「目录身份与包身份无派生关系」（源码不得读 `package.json` / 不得把插件名拼进路径）；`verify-all usage` **5 → 7 项**。**运行时部分仍待验**：三 profile 各重启一次、路由带 scope 仍通、历史统计连续 —— 闸门只保证「代码不会改名」
- [ ] I2 插件加载 GUI 层目视：侧栏脚部出现「用量统计」入口；会话页出现「用量」Tab（§3.8 实测记录中两项 ⏳ 待目视的数据面已过，余视觉确认）
- [ ] I3 会话 Tab 不受影响：上下文剩余 / 会话用量总览 / 按模型明细 / 工具调用正常（纯会话口径、与会话绑定，与账本分区无关）
- [ ] I4 v0.6.1 性能复看：全局浮窗首屏 ~2ms、稳态每请求 0–1ms（「立即出数」；修复前首屏 2761ms、稳态 327ms）
- [ ] I5 **围栏不回归（2026-09-29 补账代跑时新发现）**：非环回 Host / 跨站打 `/dsh-token-monitor/*` 应 **403**。**实测返回 200** —— 本线是九线里**唯一没有同源围栏**的（`lib/index.js` 无 Host / Origin 判定；appearance / ssh / free-model / dual-model 四线同批实测两轴均 403）。**定级**：响应**无 CORS 头** ⇒ 浏览器页面读不到响应体，实际暴露面限于本机进程 —— 而本机进程本就能直接读账本文件 ⇒ **纵深防御缺失，非当场可利用漏洞**。处置二选一：按四线同款补围栏（低成本），或显式登记「本线不做围栏」的决策（现在是第三种：谁都没决定过）。**2026-09-30 已修**：按四线同款补围栏 —— 新增 `lib/fence.js`（`structuralFence` + `trustFence` + `fenceHandler`）并在 **register 一处**统一包装覆盖五条路由（新增路由不会漏挂），`inject` 仍只有 `webServer`、`connection` 逐请求求值，**零 miasaki 耦合不变**；`test/fence.test.mjs` **13 例**（含「围栏先于业务」：跨站 POST 得 403 而非 405、handler 调用次数为 0）、`verify-all usage` **3 → 5 项**。**待实机复验**：重启 `dsh web` 后同样两轴应得 **403**（HTTP 层可代跑）
- [ ] I6 **未识别 profile 时不得宣称隔离（静默失效 #18，2026-09-30 补立）**：宿主既没有 `profileContext` 服务、环境也没有 `DSH_PROFILE` 时，账本落在**共享兜底桶** `default`（**不是隔离区** —— 多个环境会写进同一个桶），而此前页面照常宣称「与其它 profile 的账本完全隔离」。**判据**：`/dsh-token-monitor/global` 的 `profileSource` 为 `'unknown'`，且浮窗顶部口径显示「未能识别当前 profile … 可能与其它环境混账，并非真隔离」（**不得**出现「完全隔离」字样；底部长说明同款分支）。**2026-09-30 已修**：`resolveProfileKey` 返回 `{ name, source }` —— `unknown` 档目录仍为 `default`（**不搬账本**，与 I1 同一纪律），页面按 `source` 分支如实告知；`test/ledger-dir.test.mjs` **5 → 9 例**（含四种「三档全空」输入形态）。**待实机**：在缺 profile 信息的宿主上打开浮窗看文案

**J. 免费模型（第九线 `@miasaki/dsh-free-model`）**

> **台账缺口 2026-09-29 补账时补**：本线 2026-09-28 迁出后**没有 §3.x 专节、也没有 §3.0 编号** ⇒ 实机债务在文档里不可见。**2026-10-02 已补 §3.12 专节**（判据正文首次收进矩阵）—— 此前判据暂引本线 `design/CHANGELOG.md` 各条「实机待验」与 README；**注意 CHANGELOG 里 2026-09-28 之前那批「模型页底部应看到免费模型面板」的验收指引是撤销前形态**（`settings.models.footer` / `provider-card` 两个落点已全部撤销），照它验会误判。

- [ ] J1 统一页与上游让位：重启 miasaki ⇒ 设置左栏**只剩「免费模型」一页**（无公告中心分区、无首启 5 页弹窗、nav-label 已改）；模型清单后出现「本机自配平台」分区
- [ ] J2 scan 真实数据：`POST /freemodel-api/scan` 的 `models[]` 含 our-free-model 的 11 个模型（`source:"adapter"` / `writable:false` / `freeReason` 含「免 Key 车道」）；真实数据上 L1 判定命中（如 openrouter 24 模型 / 21 免费）
- [ ] J3 模型页就地入口 + 主题跟随：Our Free Model 卡片下出现「扫描该提供方的免费模型」行 + 命中数与模型 id；切换明暗主题时面板配色跟随（官方 `--dsw-alias-*` 令牌生效）
- [ ] J4 M3 实测与默认模型：模型卡「实测」给出「可用（…）+ 耗时」；**未装 `dsh-model-probe` 时按钮整块隐藏**（不给点了报 404 的按钮）；「设为默认」后新建会话的选择器默认模型就是它（官方写路径、下一次会话立即生效）
- [x] J5 **上游补丁 live 闸门（本线最重要的一项）**：`node dsh-miasaki-free-model/patches/dsh-our-free-model/patch.mjs status` 报 **5/5 applied** —— 上游应用内升级**必覆盖**补丁文件 ⇒ 那栏悄悄退化成上游原样（公告中心与首启弹窗回来了），而本线**不崩不报错、`verify-all` 照常 15/15**（离线自证不查 live）。静默失效第 6 位。**2026-09-29 代跑已核：5/5 applied**（目标 `~/.dsh/local-plugins/dsh-our-free-model/client.js`；同批 `scripts/patch-live-audit.mjs` 10/10 patched）。本项是**常驻闸门**（上游每次自升级都要重跑），不是一次性验收。**2026-09-30 已接入 `scripts/patch-live-audit.mjs`**：`PATCH_ROOTS` 补本线补丁目录 + 布局候选补 `~/.dsh/local-plugins` + drift 判定加「须有 DSH 基线」前提（无基线者「未打上」判**真回归**）；**故障注入自证三态**（上游原版 ⇒ `original`、锚点漂移 ⇒ `unknown`、真实安装 ⇒ `patched`）均 exit 1/1/0，审计总量 **11 目标 / 10 件在册补丁**。自证顺带修掉一处真缺陷：审计侧原先只解构 `state`、丢掉 `detail` ⇒「原版」与「漂移」在输出上完全一样（处置方式却不同）

**K. Fleet（多 Agent 编排线）**

> **台账缺口 2026-09-29 补账时补**：fleet 此前**没有专节**，面板与派单判据只散在 §4 两行 + L1 自动回归里 ⇒ 实机债务不可见。**2026-10-02 已补 §3.13 专节**（判据正文首次收进矩阵）。
> K3–K5 是「**先修后验**」项：三处未修的静默缺口，修完后在此验收（修前验不了）。

- [ ] K1 fleet-monitor 面板走查（**判据 2026-09-30 已立** —— P1 判定层上屏；自动闸门 `verify-all fleet` 的
      `fleet-monitor 判定层区块 (P1)` **7 项断言**已覆盖「区块 + 三个端点 + 口径同源」，下列为**实机**判据）：
      ① 起面板（本机 `127.0.0.1`）⇒ 页面上出现**可派集 / 能力断层 / 机器事件**三块，数字与
      `node workers/graph/task-ready.mjs --dispatchable --json`、`agent-pick.mjs --gaps --json`、
      `state/graph-events.jsonl` 尾部**逐条对得上**（口径同源：面板 spawn 现成 CLI，不自己实现判定）；
      ② `GET /api/dispatchable` 的不可派任务**带出原因**（不是只给计数）；`GET /api/events?limit=N` 返回尾部 N 条；
      ③ **降级不白屏**：临时让判定层 CLI 不可用（改名/换目录）⇒ 端点返回 `ok:false`、面板**不整页 500**、其余区块照常显示；
      ④ **三道信任围栏仍在**：非本机来源 ⇒ 403（且 403 响应**不带** CORS 头）、过围栏才进业务分支。
      **反例（判据的判据）**：改一条判定层输出（如临时给某任务加依赖）⇒ 面板数字跟着变，证明它**真的在读判定层**
      而不是页面里写死的快照
- [ ] K2 派单器消费判定层：真实 3 路 fan-out → reduce → verify 跑通（G1/G2/G4 判定层已齐，缺的是派单器接线 —— 治理能力「看起来有了」，实际全靠人记得用）
  - [x] **K2a（2026-09-30）派单器接线已落地**：G1 可派判定 + G0 事件留痕接入 `workers/dispatch/dispatch-task.ps1`（G2 能力闸门 2026-09-11 已接）。判据：任务不可派（状态非 queued / 依赖未满足）/ `-Agent` 与台账 `assignee` 不一致 → **拒绝派单 exit 2** 并打印全部原因；派单开始（CLI 启动前）与终态各写一条机器事件，经 `bus-apply` 唯一入口。**真实派单闭环**：t-0010 首派 claude 失败 —— **非 fleet 侧问题**：claude 经 **ccswitch** 路由模型，当时 ccswitch 未启动 ⇒ 默认模型解析成不可用的 `step-5-preview[1m]` 而返 404；ccswitch 启动后已实测恢复（`claude-sonnet-5[1M]`、exit 0）。这轮失败**恰好实证**了事件流失败分支 `failure.detected`；经 `reassign` 补丁改派 pi → exit 0 → `task.completed`，交付契约与台账终态**同一超步**（总线 v11），`tasks/<id>/result.json` **首次经唯一入口落盘**（此前该路径全是直接写盘）。**独立复核**：t-0010 的任务内容即「由一个异构 agent 复核本次接线」，产出 6 条 findings、无阻断级，F2（CLI 起不来 ⇒ 假成功入事件流）/ F3（主路径调用点零覆盖）/ F4（文案匹配与文档表述矛盾）**当批修复**；F1（崩溃残留 ⇒ 永久硬拒且无重置入口）/ F5（口径分歧只比 `enabled`）/ F6（台账坏行静默跳过）/ Q3 附带的 F7（`final-state.ps1` 调用失败静默回退成 `idle`）**已在同日第二批收口**（新增 `-ResetStatus`（心跳新鲜时拒绝执行）/ 预算纳入分歧比对 / `bus_bad_lines` 有坏行即拒绝 / 终态判定失败保守记 `error`），`dispatch-gate` 夹具 **10 → 17 例**、接线断言 **12 → 20 项**。回归 `verify-all fleet` **20/20**。报告：`dsh-miasaki-fleet/tasks/t-0010/result/result-t-0010.md`；规划与分档：`_refs/fleet-dispatch-wiring-plan-2026-09-30.md`（规划类，不入库）
  - [x] **K2b-1（2026-09-30 第三批）G4 验证挂载已落地**：`Test-VerifierGate` —— brief 声明风险（`risk:` / `需要验证：` 行，或 `-Risk`）即要求**可用**的异构验证者，**无可用候选直接拒绝派单**（比原计划的「告警」更强：派单前判定本就是闸门位）；值非法即拒绝（**不猜**，`none` 属禁止项）；**未声明即跳过**（零行为变更）；派单后生成 `tasks/<id>/verify-brief.md`（**不自动派发**）。**判据是可用候选数而非退出码**（`--all` 语义下候选可能全不可用）。实测 `--for pi --min-level vendor` → bl / opencode 两个 vendor 级可用候选。夹具 17 → **23 例**、断言 20 → **26 项**。**顺带发现并当场收口一处判定层不一致**（同日第四批）：G4 把 `alive=false` 判不可用，而「无 `status.json`」正是 `alive=false`；G1 对同形态是**降级放行** ⇒ 从未运行过的 agent 永远当不了验证者（**同族形态**）。现口径**单点**在 `liveness.cjs` 的 `isFirstRun`，两侧引用它；**豁免不外溢**（真僵尸 / 开关未开 / 字段缺席照旧不可用）。实测 `--for pi --min-level vendor` 的候选由 2 个 → **3 个**；`liveness` 7 → **9 例**、`verifier` 25 → **29 例**
  - [ ] **K2b-2 仍待**：真实 **3 路 fan-out → reduce → verify** 钻石图（需真实多任务派单，与接线无关）+ 验证任务的**自动派发**（本批刻意不做：会引入新的任务生命周期）
- [x] K3 **C6 交付物缺失不得放行** —— **2026-09-30 已修并自动验证**：`validate-bus.mjs` 改为**反向存在性检查**（台账 done+accepted ⇒ `result.json` 必须存在），且**驱动源是台账而非 `tasks/` 目录**（用例驱动出的修正：目录不存在属同族形态）。首跑即抓到存量 **7/9 任务**「已验收却从未产出交付契约」（t-0001/0002/0005/0006/0007/0008/0009），7 份 `result.json` 已按契约**补记**（evidence 指向原始 `result-*.md` 或派单器代写的 `transcript.md`，artifacts 带真实 sha256，结论标注「契约补记 2026-09-30」）；`tests/bus-integration.test.mjs` **+4 例**覆盖三形态（终态缺交付物必失败 / 终态有交付物通过 / 在途不报错 / done 未验收不越界）。**实盘复核**：`validate-bus` 33 文件 0 错误。判据：缺交付物必须**显式失败**并点名，「验收通过」不得是空的
- [ ] K4 **`blocked` 不得记成 `idle`** —— **2026-09-30 已修（判定逻辑已自动验证；端到端待一次真实派单）**：判据不引入新约定 —— 受阻的载体就是**交付契约本身**（`tasks/<id>/result.json` 的 `status = blocked | failed`）。新增 `workers/dispatch/final-state.ps1`（判定**单点**、纯函数、支持 `-OutFile` 回读以便受限沙箱下测试），`dispatch-task.ps1` 改为经它落账终态（退出码语义 0/3/4 不动）；`tests/dispatch-state.test.mjs` **9 例**（exit 三分支 / blockers 带出 / blocked 但 blockers 为空仍如实标注 / 坏 JSON 回退不抛错 / **两个 ps1 的语法闸门** —— PowerShell 侧此前没有任何自动化检查）。**故障注入自证**：注入语法错误 ⇒ 闸门 exit 1 并点名 `dispatch-task.ps1:357`，还原后复跑通过。**仍待**：跑一次真实派单（worker 交付 `status=blocked`）确认 `agents/<id>/status.json` 落 `blocked` 而非 `idle`。**2026-09-30 进展**：派单器接线后跑了两次真实派单 —— t-0010 首派 claude 以 CLI exit 1 结束（claude 经 **ccswitch** 路由模型，当时 ccswitch 未启动 ⇒ 默认模型 `step-5-preview[1m]` 返 404；**非 fleet 侧问题**，ccswitch 启动后已实测恢复），`status.json` 落 `error` 且事件流写 `failure.detected`（**非零退出分支已实机验证**）；经 reassign 改派 pi 后 exit 0 ⇒ `idle` + `task.completed`。**`blocked` 分支（exit 0 且契约 `status=blocked`）仍需一个真实受阻样本**
- [x] K5 **`loadVendors()` 断链** —— **2026-09-30 已修**（选「真读 + 显式告知」，不选「删宣称」—— 覆盖能力本身是设计意图）：新增真实文件 `shared/agent-vendors.json`（内置表的镜像，改它即覆盖）；加载逻辑抽到 `workers/lib/vendors.mjs`，**文件缺失 / 结构非法两条回退路径都留痕**（此前静默回退 ⇒ 默认表与实际归属不符时给出**假异构**结论而不报错）；`tests/verifier.test.mjs` **+5 例**（含「仓库里那份真实表存在、合法，且覆盖内置表登记的全部 agent」），`verifier-pick --check` 实测通过（10 个 agent 可参与选取）。判据：要么真读、要么显式移除该宣称

**M. 补丁与插件装卸契约（§2，补账时补）**

- [ ] M1 补丁 live 审计（**常驻闸门**）：`node scripts/patch-live-audit.mjs` 全部 `patched` 且退出码 0 —— **DSH 升级 / profile 依赖重装后必跑**（离线 `patch verify` 绿 ≠ live 在位：0.1.7 升级后六个补丁曾全部静默 `unknown` 数日、dual-model 发图被拒）。**2026-09-29 代跑已核：10 个目标 / 9 件在册补丁全 patched**（含 playwright 双半；cordis-host-runner 已退役不计）
- [ ] M2 计时面板可恢复：刷新页面 → 打开任一**已结束**步骤的轨迹计时面板 / 悬停消息耗时面板 ⇒ 首 token 延迟、生成、吞吐量三行与气泡「首 token 用时（TTFT）」均为数字（trajectory 与 chat 两个计时补丁**必须一起重打** —— 同一个 `firstTokenTime` 的两处显示；rc.2 重打后未验）
- [ ] M3 停用可恢复：移除任一插件 → 重启 host ⇒ DSH 原生界面**无残留**（右栏推挤复位、会话头按钮消失、插件树无 `did not activate` / `pending`、无启动屏报错）

> **与 `dsh-platform/dsh-0.1.7-rc2-upgrade-and-refit-plan-2026-09-25.md` §验收清单的关系**：那份是
> **升级批次**的验收登记（rc.2 适配相关项），本节是**回归矩阵口径的长期台账**（含升级之外的历史积压）。
> 两者覆盖有重叠但不完全相同；**以本节为勾选口径**，避免两处各勾一半。

### 3.1 桌面壳启动与窗口

| 场景 | 通过判据 |
|---|---|
| `dsh` 未安装 / 启动失败 / 3080 被占 | 加载页显示恢复动作组（检查 dsh / 打开终端 / 日志目录 / 导出诊断） |
| DSH 已运行 | 直接复用，不重复拉起 |
| 二次启动 | 单实例锁唤起已有窗口 |
| 最小化 / 最大化 / 还原 / 双击顶部空白 | 状态正确，标题栏按钮同步 |
| 顶部空白拖动 vs 点击页面按钮 | 拖动跟手；页签/输入框照常可点 |
| 关闭确认 | 取消可回退；确认后停止本应用 spawn 的后端 |
| 拖拽上传附件到会话（S1–S3，2026-09-24） | 对话页拖 PNG → 官方遮罩 → 松手 → composer 缩略图 → 发送成功；多文件混合拖入各自入轨；生成中/子代理视图拖文件 = 拒绝态遮罩、松手无副作用；拖选中文字/链接无反应；轨迹/用量/设置页拖文件 → SPA 不被导航走（安全网）；loading 页拖文件无导航无报错；超大图 → 官方 toast；窗口拖动/双击最大化/三主题/桌宠回归。清单十项见 desktop `design/drag-drop-attachment-upload.md` §6 |
| 启动加载视觉层（S4a+S4a-2，2026-09-24） | 冷启动 loading 页：三主题下纹章外环 24s 缓旋 + 光晕呼吸 + 舞台扫描线（≤.06 不刺眼）；就绪瞬间（文案「已就绪，正在进入…」）纹章 1.06 回弹一次、计时收起；等待期间「已等待 N s」读数 250ms 推进；系统开「减少动画效果」后全部静止、功能不变；失败路径（恢复动作组/重试）零回归。日志流与四阶段进度（S4b）待 S3 tee 钩子，不在本项 |
| 主题来源与桌面契约（W0/W1，2026-09-25） | ① **loading 页与进入后的 DSH 页主题一致**（把 `prefs.json` 主题设为 kurkuriel 后冷启动，两页均为浅色，无"先深后浅"闪窗；再改回 zafkiel 复验）；② 页面控制台 `window.miasakiDesktop.protocolVersion === 1`、`has('theme.onChange') === true`、`assets.baseUrl` 为 39800；③ **SSH / 画布 iframe 内**该对象只有 `protocolVersion`/`isDesktop`/`isLocalPage`（`capabilities`/`theme`/`window` 均为 `undefined`）；④ 连续快速点窗控（min/max/close）+ 切主题 + 桌宠状态上报，三者互不干扰（`location.hash` 上 `int=/act=/wait=/pet=/diag=` 字段不丢）——W0-T0.2 的竞态回归 |
| W2 取证与可靠性（2026-09-25） | ① **挂起取证**：人为阻塞主窗消息泵（DevTools 里跑 5s+ 死循环）→ `%LOCALAPPDATA%\miasaki\` 出现 `crash-<ISO>-watchdog.log`，含心跳缺失时长 / 最后 hash / 后端存活性；② **托盘隐藏不假报**：窗口隐藏/最小化到托盘后静置 2 分钟 → **不得**生成 watchdog 报告（已加阈值防御：不可见时判定阈值 5s→90s，此条转为「确认防御生效」）；③ **恢复对话框**：失败页点「恢复选项」→ 原生三按钮；选「停用」后 `~/.dsh/profiles/web/` 出现 `cordis.patch.yml.bak-<ms>`，且 `package.json` 的 bundles 只剩 base + web-app；④ **Job 回收**：任务管理器强杀 Miasaki → 自拉后端随之消失（`tasklist` 无孤儿 node）；⑤ **报告轮转**：连造 12 次报告 → 只留 10 份，`server.log`/`pet.log` 未被动；⑥ **手动入口**：托盘右键「生成诊断报告」→ 原生信息框回显完整路径，该文件确实存在且含事实头与 `--- renderer console ---` 段；连点 11 次后目录内报告数仍为 10 |
| W3 关闭语义（2026-09-25） | ① 点标题栏 ×（或 Alt+F4）→ 首次弹**原生**确认：**取消** → 窗口保持可见；**确定** → 窗口消失但进程仍在托盘；② 再点 × → 直接隐藏、不再询问（marker 生效）；③ 删 `%LOCALAPPDATA%\miasaki\background-close-confirmed` → 回到首次确认态（可重放）；④ 托盘「退出」→ 前端确认弹窗 → 确认后后端被停（`dsh` 进程消失）；⑤ 托盘「显示 / 隐藏主窗口」能召回被隐藏的窗口 |
| W4 表现层（2026-09-25） | ① `MIASAKI_NO_MICA=1` 启动（等价 Win10）→ 依次切三主题，窗口边缘/半透明处底色**跟随主题**（不再停在启动时那一档）；② DevTools 确认 `location.hash` 含 `bg=xxxxxx`（6 位十六进制、无 `#`）；③ Mica 生效（不设该环境变量）时窗口材质保持透明、**不被底色覆盖**；④ `console.error('probe')` → 2s 后诊断报告出现该行；⑤ `ResizeObserver loop …` 类噪声**既不显示红条也不进报告** |
| W4.2 材质分层（2026-09-25，跨 desktop × appearance） | ① **Win11**：外观线选 `mica` 档 → 侧栏 / 对话 / 右栏**只有一层模糊**（与 `frost` 档对比，不应更糊、更"奶"）；② `MIASAKI_NO_MICA=1` 启动 → `mica` 档回落到页面侧 `backdrop-filter`（此时它是唯一模糊来源，视觉应与改动前一致）；③ DevTools 执行 `document.documentElement.getAttribute('data-mia-native-mica')` —— 与是否设了 `MIASAKI_NO_MICA` 一致（未设且 Win11 ⇒ `"on"`）；④ 切 `light` / `frost` 两档不受影响（它们的 CSS 不含该条件）；⑤ 冷启动首帧不出现"先双层再单层"的可见跳变 |
| W5 自更新降级方案（2026-09-25） | ① **未配置**时点托盘「检查更新」→ 提示配置文件路径（`%LOCALAPPDATA%\miasaki\update-source.json`），**不发网络请求**；② 配真实 `feed`（纯文本版本号 > 0.1.0）→ 弹「发现新版本」→ 选「是」应打开系统默认浏览器到 `page`；③ `feed` 内容写 `0.1.0` → 提示「已是最新版本」；④ 断网 / `feed` 不可达 → **可读的失败提示**（不得静默、不得假装已最新）；⑤ 全程**不出现**任何下载写盘或安装动作（本方案边界） |
| 契约 v1.1 写能力（2026-09-25） | DevTools 里（DSH 页）执行 ① `window.miasakiDesktop.theme.set('kurkuriel')` → 应切主题（等价于点切换条）；② `window.miasakiDesktop.window.controls.minimize()` → 窗口最小化；③ `.maximize()` → 最大化/还原切换；④ `.close()` → **隐藏到托盘**（W3.1 语义，不是退出）；⑤ `theme.set('bogus')` → 返回 `false`、**无任何副作用**；⑥ `window.miasakiDesktop.window.controls.min` / `.max` 应为 `undefined`（内部协议名不外泄）；⑦ SSH / 画布 iframe 内该对象仍只有三字段（写能力不泄漏到子 frame） |
| **契约 v1.2 chrome 几何 + 让位量归壳（2026-09-27）** | ① DevTools（DSH 页）：`miasakiDesktop.has('chrome.bounds') === true`；`chrome.bounds()` 返回 `.tb-group` 的矩形，`width` 与页面实际一致（**未装 sidebar 时 108、装了终端键后 136**）；`chrome.bounds().width + 20` 应等于 `getComputedStyle(document.documentElement).getPropertyValue('--ms-titlebar-reserve')`（128 / 156）；② **让位量自动跟随**：DevTools 里 `document.querySelector('#miasaki-titlebar .tb-group').appendChild(document.createElement('div'))` 并给它 `className='tb-btn'` → 组宽 +28 ⇒ `--ms-titlebar-reserve` 在数百毫秒内自动变 184（无刷新、无需任何插件配合）——**这是 T1 的核心判据**；移除该节点后回落；③ **写者归属可分（2026-09-27 实机重叠事件后改写）**：新壳（`miasakiDesktop.has('chrome.bounds') === true`）下该值来自 `documentElement` 的 **inline style** 且**只能是壳写的**（sidebar 不写；判据：装卸终端键时值不出现双写痕迹）；旧壳（能力缺席）下由 **sidebar 按同源公式补位**（值同为「组实宽 + 20」）—— 两条路径的值必须一致，且**任何路径下都必须满足 `reserve ≥ 组实宽 + 8`**（否则官方 ExpandButton 压住终端键，即本次报障）；④ 画布：打开「会话布」→ 让 sidebar 插入终端键 → 画布工具条**不叠压**（契约 `chrome.onChange` 触发的重测；改动前会少让 28px 且不自愈）；⑤ SSH 浮层同理（其口径①走契约、口径②仍量官方 DOM）；⑥ **降级**：浏览器直开 `http://127.0.0.1:3080`（无壳）时画布与 SSH 行为与改动前一致（DOM 探针路径，reserve=0） |
| **顶部安全区：官方页面标题行下移一格（2026-09-29，插件页报障）** | ① **主判据（目检 + DevTools）**：重编 exe 后打开插件页（侧栏「插件」）→ 右上角「＋ 添加插件」胶囊与「⟳ 刷新」**完整可见且可点**，与右上 `- □ ×` 三键 / 主题徽记**无任何叠压**（改动前实测重叠 10px 高 × 71px 宽）；② DevTools：`getComputedStyle(document.querySelector('#root [class*="_pageHead"]')).marginTop === '21px'`，`getComputedStyle(document.documentElement).getPropertyValue('--ms-titlebar-clearance').trim() === '21px'`；动作区上沿 − `.tb-group` 下沿 = **12px**（≥8px 即达标）；③ 日程页（自动化任务）同一条规则命中 `.t-XoWW_pageHeading`（`_pageHead` 子串），同样不落进窗控带；④ **降级**：浏览器直开 `http://127.0.0.1:3080`（无壳，无注入脚本）⇒ 该 `margin-top` 计算值为 `0px`、页面与官方逐像素一致；⑤ **自动化**（2026-09-29 已在一次性 `dsh --profile web` 实例上实跑，`DSH_HOME` 隔离）：`verify-themes.mjs` §6.6 三项 —— 旧产物 **22/27**（三项如实失败，判据有区分力）→ 新产物 + 干净 profile **27/27**；`verify-all desktop` **36/36**、`repo` **3/3**；探针截图与复跑说明归档 `_refs/scripts-archive/pagehead-clearance-2026-09-29/` |
| P7 心跳通道 / URL 不再抖动（2026-09-26 下午） | ① 打开任一会话静置 3 分钟后切走再回来：`%LOCALAPPDATA%\com.miasaki.desktop\EBWebView\Default\History` 的**文件大小与修改时间不再持续增长**（改动前实测 87MB、1.2–1.5s 一轮 URL 变更）；② `%LOCALAPPDATA%\miasaki\pet.log` 里 `doc-boot #N` 与 `page-load #N` **都停在个位数**（`doc-boot` 涨 = 页面真被重载；两者都不涨 = 修复生效）；③ 桌宠六态照常 —— 切会话/发问 → `thinking`/`done` 立绘与气泡正确，证明心跳经事件通道被 `set_official_state` 消费（DevTools 里 `window.__TAURI_INTERNALS__` 存在即可走该通道）；④ 断网/无 IPC 场景（浏览器直开 `http://127.0.0.1:3080`）行为与历史一致：心跳仍走 hash、页面上不报错；⑤ F5 刷新后桌宠状态在 1–2 秒内恢复（`on_page_load` 只在文档级导航补注入主题脚本，同文档导航不再重解析 120KB） |
| P9 后端拉起不依赖 `cmd.exe`（2026-09-26 晚） | ① 冷启动 `miasaki.exe`：启动页**不再**出现「未检测到 dsh」，`pet.log` 出现 `spawn-dsh: node 直启后端（绕开 cmd.exe）pid …`；② 失败页点「检查 dsh」→ 自证里 `cmd.exe：可执行（C:\WINDOWS\System32\cmd.exe）`（**绝对路径，不再是裸名**）与 `node 直启：可用（…\node.exe → …\dsh\lib\bin.js）` 两行都在；③ 后端确实起来（`http://127.0.0.1:3080` 有响应、壳进入 DSH 页）；④ 关闭应用后自拉后端随之退出（Job 兜底仍有效）；⑤ 反例验证（可选）：把 node 从 PATH 摘掉再启动 → 自动回落 `cmd /C dsh …`，错误信息带「node 直启不可用（…）」而非静默失败 |
| **启动片头视频（2026-10-05，跨 desktop × appearance）** | ① **配置侧（机器判据，先看这条）**：`~/.dsh/miasaki-appearance/config.json` 的 `version` 为 **7** 且含 `boot` 板块（`intro` ∈ `brand`/`cyberpunk`/`awakening`/`startup`，`audio` 为布尔）—— **判据必须落在磁盘上**：桌面壳 `boot_intro.rs` 直接读这个文件，外观插件内存里的迁移结果对它不可见（2026-10-05 修复的正是这条裂缝，根因见 desktop `design/2026-10-04-boot-intro-video.md` §10.9）；② **播放**：重启桌面端（快捷方式指向 `C:\ProgramData\MiasakiApp\Miasaki.exe`）⇒ 加载页出现全屏视频片头（出厂档 `brand`、静音），播完**自动回落**到既有纹章层（S4a），无「视频 → 黑屏 → 原生」跳变；③ **换段 / 开声音**：设置 → 外观 → 启动 → 换一段 / 开音轨 ⇒ **下次启动**生效（片头刻意不轮询）；选「关闭」⇒ 与原生一致；④ **降级**：删掉 `boot` 板块（或整份配置 / 写坏 JSON）⇒ 静默退化为纹章层、启动照常**且不报错**；系统开「减少动画效果」⇒ 不播片头（`ui/loading.html` 的 reduced-motion 分支）；⑤ **署名义务**：`ui/intro/THIRD-PARTY-NOTICE.md` 随部署目录就位（第三方素材 BSD-3） |

### 3.2 桌宠

拖动 / 单击 / 双击 / 右键菜单 / 隐藏与恢复 / 屏幕外位置找回 / 分辨率变化 / 主题切换换角色。

#### 3.2.1 新素材上屏（2026-09-28 实测，判据来自一次真实失败）

| 检查项 | 通过判据 |
|---|---|
| 部署素材与仓库一致 | `C:\ProgramData\MiasakiApp\ui\pets\frames.json` 与仓库 `ui/pets/frames.json` SHA256 相同；`ui/pets/whale/frames/` 存在且 **46 帧**；旧 `inverse/raw/blue-*.png` 已随镜像删除 |
| 部署 exe 晚于最后一次素材改动 | `Get-Item C:\ProgramData\MiasakiApp\Miasaki.exe \| Select LastWriteTime` 晚于素材的 mtime |
| **运行时确实加载了新素材** | `%LOCALAPPDATA%\miasaki\pet.log` 出现 `tick0 … whale_rows=7`（**旧 `frames.json` 下恒为 0** —— 这是「素材真的上屏了」唯一可靠的运行时判据） |
| **遮蔽可见（2026-09-30 新增，机器判据）** | 启动时 `pet.log` 出现 `[assets] 磁盘 ui/ 与内嵌素材有 N 处内容不同（磁盘在遮蔽内嵌）：…` 行 —— 判据是「**有分裂必有该行**」，**无分裂则不应有行**。反例验法：把部署目录的 `pets/frames.json` 换成旧版 → 重启壳 ⇒ 出现该行并点名；再设 `MIASAKI_ASSETS_SOURCE=embedded` 启动 ⇒ 出现「忽略磁盘 ui/ 覆盖层」行，且界面确实用上新素材 |

> **为什么必须验第三行**：`assets.rs::read()` 是「磁盘 `ui/`（EXE 旁）优先、编译期内嵌兜底」，
> 部署目录里的旧素材会**遮蔽**新编译进去的新素材。2026-09-27/28 的 whale 图集与白军装反转狂三
> 就这样在实机上失效了一整天 —— 代码、单测、资产闸门**全绿**，只有这一行日志能戳破。
> 根因与修复见 desktop `design/CHANGELOG.md` 2026-09-28（续五）。
>
> **2026-09-30 把这条链路变成机器判据**：遮蔽判定从 `build.rs` **生成的** `assets.rs` 搬进手写模块
> `dsh-miasaki-desktop/src-tauri/src/asset_source.rs`（生成物不可单测，判据必须落在能跑测试的地方；
> 该文件与本次改动同批入库，**未入库前不做相对链接**），
> 新增「磁盘有 ∧ 内嵌有 ∧ **内容不同**」的遮蔽报告 + 启动摘要 + 逃生门 `MIASAKI_ASSETS_SOURCE=embedded`；
> `cargo test` **109 → 117 例**。**当日机器核对**：部署目录 139 个素材与仓库 `ui/` **逐字节一致**
> （内容不同 0 / 仅磁盘有 0）⇒ 该行此刻**应保持安静**。

#### 3.2.2 L1 绘制层动效走查（2026-09-28 落地；判据同 `pet-v5-motion-plan.md` §3.7）

| 检查项 | 通过判据 | 状态 |
|---|---|---|
| 呼吸覆盖全姿态 | `idle` 之外的姿态（`failed` / `wait` / 工作态 `run` / 立绘 `work`）也有 ±2~3px 起伏，不再完全静止 | 待走查 |
| **摇摆（inverse 是主收益）** | 切 `kurkuriel` 主题：反转狂三 `idle`/`work` 有绕**底边**的 ±2° 摆动（此前三态是彻底静止的死图） | 待走查 |
| 摇摆不吃掉底部留白 | 摆到左右极值时**脚尖不被窗口下沿切**（`sway_layout_margin` 的存在理由） | 待走查 |
| 挤压脉冲 | 双击桌宠（跳跃落地）与 Done 庆祝各出现一次「横向拉伸 + 纵向压扁」回弹（220ms） | 待走查 |
| 命中一致性 | 摇摆/挤压**中途**把光标移到轮廓外 → 穿透；移回本体 → 可点（旋转后轮廓变化不得长出「隐形挡板」） | 待走查 |
| 稳定纪律 | 任务管理器「GDI 对象」列不增；`pet.log` 的 `ULW failed` 计数与改前持平 | 待走查 |

> 2026-09-28 本轮**已完成**的是 3.2.1 三行（逐项 SHA256 一致 + `whale_rows=7` 实测）
> 与自动回归（desktop **40/40**、`cargo test` 100 例）；3.2.2 的六行是**目视项**，需人执行。
> （`40/40` 是**第九线迁出前**的口径；迁出后 desktop 为 **36/36** —— 4 项随免费模型池迁入 `free-model`，
> 见顶部 2026-09-29 基线。）

#### 3.2.3 M4.1 边缘停靠与探头（2026-10-05 落地；判据同 `pet-v3-roadmap.md` §M4.1 验收 + `pet-reference-benchmark.md` R14）

| 检查项 | 通过判据 | 状态 |
|---|---|---|
| 拖到边缘自动吸附 | 松手点角色可见区域距工作区边 ≤18px ⇒ 沿边推出、**距边恰 18px**（不多不少不抖动）；拖到屏幕中间松手 ⇒ 不吸附 | 待走查 |
| 静置自动缩边 | 吸附后静置 5s（期间光标不在角色上）⇒ 300ms 缓动滑向屏外、常驻露出**约 55% 角色宽度**；无跳变、无抽搐 | 待走查 |
| 感知探出（拉直） | 光标压上探头部分**或**点击 ⇒ 250ms 拉直到约 82%；光标离开再静置 5s ⇒ 300ms 退回**常驻档**（不是退回吸附位——没拖走就继续探头） | 待走查 |
| 点击语义分派 | 缩边态（含缩边/退回过渡中）点击 = 拉直（**不是**「撸一下」跳跃）；拉直态（Straightened）点击 = 原语义（跳 / 审批时唤起主窗） | 待走查 |
| 探头态重启不丢 | 探头中重启壳 ⇒ 启动恢复为**全可见吸附位**（peek 是瞬态不跨重启），静置 5s 后自然再探头；**绝不**触发「位置不可见 → 回默认」（R3 判据 ≥25% 兜底） | 待走查 |
| 位移源拦截（R14 教训②） | 吸附/探头期间**不出现** wander 滑步；拖动即脱停靠、探头立即归零，松手按新位置重判吸附 | 待走查 |
| 气泡共存 | 探头期间会话出现审批 / 告警 / 状态气泡 ⇒ 桌宠同帧弹回吸附位（读感是「跳出来汇报」），气泡完整可点（审批按钮不被窗口边缘裁切） | 待走查 |
| 副屏与 DPI（验收④⑤） | 副屏可吸附与探头（吸附到**当前屏**的边）；混合 DPI 下吸附不偏移 | 待走查（需多屏环境） |

### 3.3 Canvas

「会话布」切换按钮在会话头 actions 插槽 → 画布渲染 → 分支血缘 → 合并（选线/注入形式/执行）
→ 菱形卡长出内容 → 原线「已被吸收 ◇」标记。

**会话导航（2026-09-27，DSH 0.1.7 适配）**：点卡片联动 DSH 当前会话（画布不关）/ 回跳按钮跳到 DSH 并关画布 / 画布内发消息落到目标会话——三条都不再弹「关联的 DSH 会话已不可用」（旧 `ctx.sessions.open` 在 0.1.7 已删除，改走 `ctx.uiWorkspace.openSession`）。判据见 §3.0 F3。

### 3.4 Sidebar（官方右栏 tab 类型 + 底部内嵌终端）

> 自研壳已退役（2026-09-10 停用 / 2026-09-11 代码删除），面板的**开合、宽度、分栏、全屏、标签栏、
> 引导页全部由官方框架负责**。本线右栏只提供「审查」一个 tab 类型及其正文（**2026-09-25 起**：
> 右栏终端退役——官方右栏已内置终端，本项目沿用官方策略不再自建）；内嵌终端（多标签）收敛为
> **底部面板**单形态，由标题栏终端按钮 / Ctrl+` 唤起。

| 检查项 | 通过判据 |
|---|---|
| 插件加载 | 重启 host 后 `GET /sidebar/api/health` 返回当前版本（现为 `0.10.0-miasaki.0`） |
| 入口胶囊 | 官方 tab 条的「添加控件」→ 引导页出现「审查」「**辅助对话**」**两个**胶囊（2026-09-25 前为「审查」「终端」两个，2026-09-28 起终端位置由辅助对话接替）；**引导页空白 = `guide` 条目契约坏了**（文本字段必须是函数，见 CHANGELOG 2026-09-10） |
| **辅助对话 tab（M2.1，2026-09-28）** | 点「辅助对话」胶囊 → 右栏出 tab（页型，同格去重）；点「新建侧线」→ fork 出侧线，面板渲染官方 embedded 会话 + 原生 composer；侧线头显示「主会话：<标题>」与提示条「说『继续』等于接着做主线未完成的活」。**（2026-09-30 口径订正）**：原文写「面板里渲染出主会话继承来的历史」，那是继承段折叠前的形态 —— 现由下面的「继承段不显示」接管 |
| **侧线会话不占列表（2026-09-30 补立）** | 新建/已有侧线**不出现在**左侧列表与会话搜索里（**刷新页面后**判定：补丁作用于客户端 bundle）；localStorage 有声明键 `miasaki-sidebar:sidechat:hidden:v1`（JSON 字符串数组，含侧线 childId）。**反例（判据的判据）**：清掉该键再刷新 ⇒ 侧线重新出现在列表里 —— 证明「不显示」确由声明驱动。**fail-safe**：未装插件时该键不存在，官方列表行为一字不变（补丁 = `sessionVisible()` 里一条「声明命中即不显示」，声明缺席即原状）。代价：DSH 升级覆盖补丁需重打，见 desktop 线 `patches/dsh-client-ui-workspace/README.md` |
| **侧线继承段不显示（2026-09-30 补立）** | 侧线面板打开即只有本侧线自己的问答；侧线头显示「上文已折叠 N 轮，**模型仍然看得见**」（N = 主会话已完成轮数）。**模型侧仍继承**：直接问「我刚才让你做什么」⇒ 侧线答得出主会话的事（证明折叠在显示层，不是丢上下文）。**作用域**：折叠 CSS 限定 `.dsh-sidebar-sidechat-body` ⇒ 主会话与官方 subagent 会话时间线零变化；轮数 > 200 放弃折叠（不生成上千条选择器） |
| **侧线不打断主任务（M2.1 核心）** | 主会话**正在跑**时点「新建侧线」：侧线立刻可用，**主会话继续跑完不中断**；侧线继承的历史**止于上一个已完成轮次**，不含正在跑的增量。反例：主会话**首轮运行中**（0 个完成轮次）→ 出人话引导「先让主会话跑完一轮」，不是宿主错误串 |
| **侧线登记表与刷新还原（M2.1）** | 开侧线后 localStorage 出现 `miasaki-sidebar:sidechat:v1`（`{父会话: {activeChildId, lines[]}}`；fork 成功即写盘）；**刷新页面**后官方右栏自动还原 tab、且面板显示的是**同一条侧线**（childId 不变、不重复 fork）——官方持久化里没有 `params`，这条身份只能靠登记表 |
| **多侧线切换（M2.1）** | 同一主会话开第二条侧线 → 侧线头出现「侧线 1 / 侧线 2」切换器；来回切换不报错，正文各自对应 |
| **侧线 goal 补偿（决策⑥ / S9，2026-09-30）** | 主会话有活动 goal 时「新建侧线」⇒ 侧线头与正文**不再显示父会话目标**；在侧线里再建 goal 不报 `GOAL_ALREADY_EXISTS`；侧线会话记录里能看到一条 `goal/change{operation:'clear'}`（代价如实记账）。**已知限制（无 API，已如实声明）**：`plan` / `todo` 仍随 fork 继承 —— plan 的提示段会在 active 时自动注入，只能靠模型自己退出 plan 模式。**实现约束**：补偿**不得阻塞**侧线创建（不 await、childId 原样返回）、不得污染返回链路；服务缺席静默返回，失败仅留痕不外抛（`test/sidechat-registry.test.js` 六例） |
| 审查 tab | 四视图下拉**切换即拉取**（未暂存 / 已暂存 / 全部分支更改 / 上一轮更改；空视图显示「无改动」）、目录分组默认折叠且组统计 = 组内求和、未点名徽标、点名往返持久化、单文件 diff 行级展开 |
| **审查视图持久化** | 切到「上一轮更改」→ 关闭 tab 或刷新页面 → 重开审查 tab 仍是「上一轮更改」（键 `miasaki-sidebar:review-view`） |
| 窗口可见性门 | 切到别的窗口 60s+ 再回来，审查 tab 不因隐藏期间的 TTL 重复拉取 |
| **底部终端面板** | 标题栏终端按钮 / Ctrl+` 唤起底部面板；标签栏多开（`＋` 新建 / `×` 关闭 / 右键菜单 / `▾` 溢出）、cwd 跟随当前会话、未安装 shell 置灰、失败显示原因 + 重试；刷新后存活会话恢复为可见标签 |
| 与 canvas 共存 | canvas 全屏 overlay 盖住右栏为预期；右栏层级现由官方框架决定，本线不再声明 z-index 约束 |

### 3.5 外观（`@miasaki/dsh-appearance`，M1 + 2026-09-26 去重 + 2026-09-27 M3 动效 / M4 会话效果 + 2026-09-29 M3.2 设置面板锚点修正）

| 检查项 | 通过判据 |
|---|---|
| 设置栏出现 | 设置面板左栏出现**「外观」**，位置在「通用」之后、「模型」之前（`settings.section` 的 `order: 5`） |
| 契约状态条 | 面板顶部显示绿色「契约自检通过」；有降级项时显示黄条并逐条列出（缺插槽 / 主题接口 / 中栏锚点 / token / 桌面壳主题在位） |
| **与通用页不重复** | 外观栏**没有**「明暗偏好（浅色 / 深色 / 跟随系统）」与「正文字号」两行——它们是官方「通用」设置页 `AppearanceRow` / `FontSizeRow` 自己的行（2026-09-26 去重，两处曾是同一 `ctx.theme` 偏好的第二入口）；DevTools 里 `document.documentElement.getAttribute('data-mia-scheme')` 为 `null`（镜像属性已移除）。**回退 = 第二入口复活** |
| 皮肤（本线独有） | 纯净 / 刻刻帝 / 狂狂帝三选一（**官方选择丸 + Menu**：h36 圆角丸右缀箭头，点开下拉、键盘 ↑↓/Esc 可用，当前项有勾选）；选中刻刻帝时官方「通用」页的三立方被拨到「深色」一次（此后用户自改明暗不拉回）；`curl /appearance/api/skin` 返回 105 token 表 |
| 控件形态（V1，2026-09-26） | 皮肤 / 壁纸图源 / 玻璃档位 / 我的上传 四行全是**选择丸 + 下拉**（与官方「通用」页的语言行、权限行同规格），**不是一排胶囊**；长文件名在选择丸内截断、悬停 title 给全名；运行信息是面板底部一行小字（M3 动效板块与 M4 会话效果板块 2026-09-27 已从占位升级为真控件，见下两行） |
| Boot Splash（P2，2026-09-26） | 冷启动（后端已热）可见全屏启动画：皮肤底色 + 纹章双环旋转（刻刻帝顺 / 狂狂帝逆 / 纯净静止）+ MIASAKI wordmark + 三点流动；shell 挂载后 **≤400ms** 淡出、无「splash → 原生 → 外观」三段跳；三主题 × 明暗下底色/强调色随之；系统开「减少动画效果」后全部静止、功能不变；`~/.dsh/miasaki-appearance/config.json` 的 `version` 为 5、`motion.bootSplash` 为 `auto` |
| Boot Splash 硬用例（401 / 关掉即原生） | ① 未认证访问（dsh web 打印的 URL 未带 token）首帧非 shell ⇒ splash **2.5s 内淡出**、不挡住「重新打开 URL」提示；② 总开关关闭或 `motion.bootSplash:'off'` ⇒ 首帧与原生 **diff = 0**（无 splash 三行、无 `#mia-splash` 节点、无 `data-mia-splash-done` 残留） |
| 动效（M3，2026-09-27；设置面板锚点 2026-09-29 修正） | 「动效」板块三控件在位：官方 Switch 总开关 + 预设选择丸（流畅 / 优雅 / 极简）+ 强度步进器（0.5×–1.5×）。开总开关后：切会话 / 开右栏可见**容器入场**——会话表面竖向浮起 + 轻微缩放，**侧栏 / 右栏窄高竖条横向滑入（不缩放，贴官方折叠 rail-in 语汇）**；强刷页面可见加载错峰（侧栏 → 会话 → 右栏先后入场）；切预设与调强度倍率即时改变观感；关总开关后入场消失、页面回原生。**设置面板（2026-09-29 统一）**：打开设置时整块面板入场一次，与默认停在哪一页签无关；在通用 / 外观 / 模型 / 插件 / 代理预设 / 免费模型 / 归档会话 / 桌宠之间连点，页签切换**一律瞬切**（官方设置外壳零过渡）——**不许某一页单独浮起**（M3 起那条挂在各线面板类名 `.mia-panel` 上的旧锚点只有「外观」「桌宠」两页命中，2026-09-29 已撤除） |
| 动效降级硬用例 | 系统设置开「减少动画效果」（`prefers-reduced-motion: reduce`）⇒ 所有入场收敛为 **100ms 淡入**、无位移无错峰，功能不变（**设置面板同样降级**，不与其余页签拉开差异）；DevTools 渲染面板模拟 reduce 同效 |
| 总开关往返 | 开 → `document.documentElement.dataset.miaAppearance === 'on'` 且 `~/.dsh/miasaki-appearance/config.json` 的 `enabled` 为 `true`；关 → `'off'` 且为 `false` |
| 修订冲突可复现 | 两个标签页都开面板：A 改一次后，B 用旧修订提交 → B 显示「配置已被其它窗口修改，已载入最新值」，不静默覆盖 |
| **关掉即原生** | 总开关关闭时（或把本线移出 profile roster 重启后）：页面与未装本线时**逐像素一致**，无残留样式与属性 |
| 首帧不闪 | 强刷页面不应出现「先原生、后跳外观」的闪变（M1 只写三个 `data-*` 属性；闪色风险在 M2 皮肤落地时才会出现） |
| 越权防护 | 非环回 Host 头或跨站请求打 `/appearance/api/state` → **403**；未定义路径 → 404 |
| 会话效果（M4，2026-09-27） | 「会话效果」板块六行真控件：消息密度（舒适 / 紧凑）、会话最大宽度（步进器 0–1600px、0 = 官方默认）、正文字体（默认 / 衬线 / 等宽）、流式光标（Switch + 细条 / 方块 / 下划线）、引用与代码块（默认 / 简约 / 强调）。外观栏**不出现**「字号」步进器（那是官方「通用」页 `FontSizeRow`） |
| 会话效果行为（M4 三态） | ① 密度选「紧凑」⇒ 消息流间距收窄（`document.documentElement` 出现 `data-mia-cv-density="compact"`）；② 宽度设非 0 ⇒ 会话列变宽 / 变窄且输入卡片宽度不变（`data-mia-cv-width="on"` + `<html style>` 上 `--mia-cv-width`）；改回 0 或关总开关 ⇒ 属性与变量全清、宽度交还官方；③ 正文字体 / 流式光标 / 引用与代码块三行各切一档 ⇒ 与会话列内相应变化（光标仅在流式输出期间出现在正文末尾，系统「减少动画效果」时不闪烁） |
| **锚点失配提示（M4，静默失效 #10，2026-09-30）** | M4 的密度 / 宽度落在**官方内部锚点** `[data-chat-flow]` 与官方变量上；官方升级改了锚点名 ⇒ 设置**静默失效**（面板可点、保存成功、界面零变化）。判据：① **失配必提示** —— 会话页内 `[data-chat-flow]` 存在、但该节点读到的 `--dsh-chat-content-width` ≠ `--mia-cv-width`（或 `--dsh-chat-flow-gap` ≠ `8px`）⇒ 面板出现「注意：会话最大宽度 / 消息密度的设置未生效 —— 官方会话结构的锚点（[data-chat-flow]）在当前 DSH 版本上没命中」；② **不误报** —— 消息列尚未渲染（无 `[data-chat-flow]`）或没开这两项时**不提示**；③ 流式光标（`[data-streaming]` 仅在生成中存在）与引用 / 代码块（原生标签）**不做静态自检**，文案已说明。机器判据见 `test/client.test.js` 四例 |
| 配置版本 | `~/.dsh/miasaki-appearance/config.json` 的 `version` 为 **6**，`theme` 板块**只有** `skin` 一个字段（v3 及更早的 `scheme` / `accent` / `fontSize` 残留被丢弃，2026-09-26 去重）；`motion` 板块含 `bootSplash`（v5）；`conversation` 板块含 `density / maxWidth / font / cursor / quoteCode` 五字段（v6，出厂全首档 = 不注入任何规则） |
| **无可见效果提示**（静默失效 #8，2026-09-30 补全） | 判据是「**本线会不会产生任何可见变化**」：皮肤非纯净 / 壁纸源非空**且**至少一处表面不透明度 < 100 / 动效开着 / 会话效果有非默认档 —— 任一成立即有变化。① **全原生档**（总开关开着但什么都没配）⇒ 面板出现「当前配置下外观没有可见变化：外观总开关已开，但所有项都停在原生档…与未装本线时逐像素一致」+ 四类可操作第一步；② **壁纸被 100% 不透明表面挡住** ⇒ 改用「三层抵消」文案（不张冠李戴）；③ **任一项有可见变化 ⇒ 不提示**；④ 总开关关闭 ⇒ 不提示；⑤ **旧 host 缺 `conversation` 板块（v5 前）⇒ 面板不空白**，会话效果组显示「或宿主版本较旧——重启宿主后重试」。机器判据见 `test/client.test.js`（#8 五例） |
| **每板块恢复默认（P4，2026-09-30）** | 主题 / 壁纸 / 应用图标 / 动效 / 会话效果五个板块各自一行「恢复…的默认设置」：① 板块被改过 ⇒ 出现该行，点一下**该板块整体回到出厂值**（旧版本残留字段一并被 sanitize 收窄掉，不是「只覆盖认识的字段」）；② 板块已是默认 ⇒ **不出现**（省噪声）；③ **旧 host 不下发 `defaults` ⇒ 出现「重启宿主后即可用」提示**，而不是静默失效。**默认值的唯一来源是 host**（`/state` 的 `defaults` = `lib/config.js` 的 `DEFAULT_CONFIG`）—— 客户端硬编码一份会让「恢复默认」恢复成旧版默认值。机器判据见 `test/client.test.js`（P4 四例） |
| **配置导入 / 导出（P5，2026-09-30）** | 面板「配置」组两个按钮。**导出**：得到 `{ kind: "miasaki-appearance-config", version, exportedAt, config }` 的 JSON（文件名 `miasaki-appearance-config-v6.json`）。**导入**：① **整体替换而非合并** —— 文件里没写的板块回到出厂默认（判据：导出后把配置改乱再导入，应**完全还原**）；② **导入前二次确认**，确认框写明「没写的板块会回出厂默认」，**点取消不写任何字段**；③ 坏文件（非 JSON / 顶层非对象 / 找不到配置对象）给**人话错误**且零写入；④ 兼容**裸配置对象**（手写 JSON 可用）；⑤ 越界与未知字段一律被收窄（导入内容当不可信输入）。机器判据：`test/host.test.js` 六例 + `test/client.test.js` 五例 |

> **「开启了没什么效果」的诊断注记（2026-09-27，用户实机反馈）**：这不是失效，是**默认配置下
> 三层效果互相抵消**——① 皮肤停在「纯净」= 原生配色，本来就不变色（设计如此）；② 壁纸层
> （`body::before`，z-index -1）被**100% 不透明的官方表面**完全挡住（params 层全 100 ⇒
> `buildSurfaceTokens` 返回 null，不注册半透明），只有表面之外的缝隙露一条边；③ `mica` 玻璃档
> 的语义是「用系统云母」，Win11 桌面壳广播 `data-mia-native-mica="on"` 时页面侧模糊被
> W4.2 规则**有意关掉**（消双层模糊）⇒ 三表面仍实色。
> **立刻见效**：皮肤换「刻刻帝 / 狂狂帝」，或玻璃换「磨砂(frost) / 轻(light)」，或把
> 「表面不透明度」的会话 / 侧栏 / 输入框降到 60–80（壁纸的正确用法）。
> 复算证据：盘上 `config.json`（enabled=true、wallpaper=builtin:aurora、glass=mica）经
> `buildBootScript/buildBootStyle` 离线复算，`data-mia-*` 属性与壁纸/玻璃 CSS 行**均在场**——
> 注入没问题，是可见性条件没凑齐。（2026-09-27 提的遗留产品改进「面板可在『无可见效果』时给一行
> 提示」已落地；**2026-09-30 补全为全量判定** —— 见下方「无可见效果」判据行与台账 D2/D8。）

### 3.5b 软件头像 → 启动器图标（appearance × desktop 跨线，2026-09-21）
前置：**`dsh web` 与桌面壳都要重启**（appearance 改了 host 半——新增路由；desktop 改了 Rust）。
契约（配置路径 / 文件名白名单 / 目录）见 `appearance-launcher-icon-2026-09-21.md`。

| 检查项 | 通过判据 |
|---|---|
| 板块出现 | 设置 → 外观 → 「应用图标」显示**两个预设格**（默认 / 头像）+ 「自定义」行（上传图片…／清除）；契约条**无** `avatar-host-stale` 黄条（有 = host 未重启） |
| 预设点选即用 | 点「默认」→ 该格出现选中态（背景 + 描边），**约 1.5–2 秒内桌面端三处图标变成几何徽记**；`~/.dsh/miasaki-appearance/avatars/` 下出现 2 个 `preset-*.png` |
| 位图预设 | 「头像」格显示用户提供的那位蓝发角色（不是程序化几何图案），点选后三处图标同步 |
| 我的上传隔离 | 「我的上传」清单里**不出现** `preset-*.png`（预设是系统生成的，不属于用户资产） |
| 上传即预览 | 点「上传图片…」选一张非 PNG（如 jpg）→ 立即可选并生效；`avatars/` 出现 `avatar-<时间戳>-<随机>.png` |
| **图标跟随** | 约 1.5–2 秒内：桌面端**任务栏**、**窗口左上角**、**托盘**三处图标同时变成该图（无重启、无重开窗口） |
| 清单选择 | 目录里手动放入一张白名单命名的 PNG → 重新打开面板出现在「我的上传」里 → 选中即生效 |
| 清除回退 | 点「清除」→ 三处图标回到出厂图标（`avatar.source` 变空串） |
| 坏文件不崩 | 把 `config.json` 的 `avatar.source` 指向不存在的文件名（或写入非 PNG 内容）→ 桌面端**照常启动/运行**，图标回退出厂值，`%LOCALAPPDATA%\miasaki\pet.log` 有一行 `launcher-icon:` 说明 |
| 边界如文案所述 | EXE 文件自身图标与桌面 / 开始菜单快捷方式图标**不随设置变化**（构建期资源，面板文案已写明） |

### 3.6 SSH（`@miasaki/dsh-ssh`，U0+U1+A0+D2–D4+U2+G1/G2+U3 清单）

前置：`dsh web` 重启 + 浏览器强刷；验收矩阵细化项见 `dsh-miasaki-ssh/design/2026-09-12-ssh-workspace-plan.md` §10 与 `dsh-miasaki-ssh/design/2026-09-14-ssh-agent-driven-plan.md` §17。
**注意**：`index.js` 的 `cachedAsset` 对静态资源做进程内一次性缓存 — 改了 `app.js` / `session.js` 后**必须重启 `dsh web`**，浏览器强刷不够。

| 检查项 | 通过判据 |
|---|---|
| 入口不变 | 第一行胶囊「对话 \| 会话布 \| SSH」三段一体；画布内部按钮旁的 SSH 入口可用；第二行 tab 栏无 SSH |
| 工作区布局 | SSH 页 = 左主机导航（搜索框 + 分组 + 底部「N 个连接保留中」）+ 右标签区 + 底部状态栏；无整页连接库 |
| 主题桥接 | pure 亮 / pure 暗 / 刻刻帝 / 狂狂帝四种实装组合下：页面表面、边框、强调色与 xterm 背景/前景/光标同步换肤；**亮色主题强刷不闪黑底**；主题切换不断 SSH、不重建终端 |
| 真实连接 | 新建主机（用户名必填、不默认 root；**主机栏直接粘贴 `8.138.243.30:25112` 这类带端口的地址也能存对** —— 端口自动落到「端口」栏）→ 密码/私钥/agent 连接成功且**终端有输出**（U0 前的版本终端无输出）；连接中横幅可取消；历史记录若主机栏带端口，点「重新连接」会就地修正并提示「已移到「端口」栏」，不再报 `getaddrinfo ENOTFOUND` |
| 指纹闭环 | 首连弹指纹 sheet → 信任并继续；改/host 变更 → mismatch 横幅（无「仍然继续」）→ 信任记录 sheet → 忘记 → 重连重新 TOFU |
| attach 恢复 | 已连接主机一键回终端；切对话/画布再回来 scrollback 回放；同主机重复打开不重复 connect |
| 标签语义 | 关闭标签默认「仅关闭查看」（连接保留、可从导航恢复）；「断开并关闭」才 teardown；状态栏区分查看器失联（自动重附着）与 SSH 已结束 |
| 终端功能 | Ctrl+Shift+C/V 复制粘贴（Ctrl+C 仍中断）；查找行 Enter/Shift+Enter 导航、n/m 计数；字号 12–20 且 PTY 跟随；清屏只清本地；多行粘贴先确认 |
| 响应式 | 官方右栏展开挤压 SSH 容器：≥960 双栏 / 720–959 紧凑 / <720 导航改抽屉（Esc 关闭、焦点归还）、无横向溢出 |
| 围栏不回归 | 非环回 Host / 跨站请求打 `/ssh/api/*` → **403**；伪造 origin 的 WS upgrade 被拒 |
| **入口去重（B1/B2）** | ① 任意**会话窗口**看右上角（桌面壳里即窗控左侧）：**不得**出现独立的 SSH 按钮 —— 会话内只要会话头那段胶囊就够了；② 回到首屏 / 新会话（hero）右上角：**有** SSH 且点得开浮层；③ 设置页 / 轨迹页 / 用量浮层等非主页界面：**不出现**；④ 从会话切回首屏后入口**能恢复**（判据可逆，不是被写死成"一律不显示"） |
| **A0 · 按钮启用态** | 未连接时工具区「送往对话」按钮置灰；连上后可用；点击弹出三项菜单（送出选中内容 / 送出最近 40 行 / 让 Agent 看这个错误） |
| **A0 · 三种意图** | ① 终端选中文本 → 「送出选中内容」→ 状态栏报字符数；粘贴到对话，**首行为 `[SSH <标签> · <用户>@<主机>:<端口>]`**，其后是选中文本，无多余空行；② 「送出最近 40 行」→ 正文为最近输出且**末尾空白行已被裁掉**；③ 「让 Agent 看这个错误」→ 首行在来源标记后追加「帮我看下这段终端输出有什么问题：」，正文为最近输出 |
| **A0 · 右键菜单与边界** | 终端内右键弹出同一份三项菜单（不再弹浏览器默认菜单）；**空缓冲区/未选中时给出明确提示而非静默**；全程**终端内容不变、不向远端发送任何字节**（可对照远端 `history`/`echo` 验证）；复制后不自动发送，需人工粘贴 |
| **U2 · 多 shell 与写权** | 标签栏「+」与主机菜单都能新建 shell；同主机可开多个 shell（上限 8）且**尺寸 / 输出互不串扰**；非 owner 的输入与 resize 被拒（写权只归一个 viewer）、接管后原 owner 立即转只读并在状态栏提示；关闭对话框三分语义正确（仅关闭查看 / 关闭此 shell（连接保留）/ 断开整个连接）；**某个 shell 退出后同连接其余 shell 继续存活**；WS 旧帧 / 过期票据一律拒收并给可操作提示 |
| **U2 · 工作区记忆** | 偏好（字号 / rail 折叠 / 专注）刷新后保留；工作区快照（标签集合 + 激活项 + 抽屉状态）在**同一标签页刷新**后恢复形状、**新开标签页不继承**；host 侧已失效的连接**不自动重连、不填凭据**，静默丢弃并提示；快照损坏 / 无痕模式下回默认、不白屏 |
| **U2 · 精确恢复** | 页面刷新后 `vim` / `top` 等 alt-screen 全屏程序**逐行一致**（快照优先路径）；重附着不重复整段回放（防翻倍）；addon 缺失时降级为回放恢复；长时间大输出后刷新不卡顿（快照封顶 128KiB / 500 行） |
| **弹层形态（2026-09-26 新）** | 新建 / 编辑主机、连接密码、TOFU 指纹确认等**全部是居中悬浮窗**（遮罩 + 圆角卡片 + 底部右侧按钮区），不再是右侧贴边抽屉；桌面壳内**卡片与右下角主题球不叠压**、确认键点得到（含把窗口拉窄到 ~640px、~480px 两档）；卡片顶部落在壳窗控带之下（右上角不出现第二个 ✕）；浏览器（无壳 chrome）下卡片仍居中、无多余留白 |
| **连接诊断（2026-09-26 新）** | 主机菜单 `⋯` →「连接诊断」与编辑主机弹窗「测试连接」都能打开诊断面板；面板给出**结论条**（可达 / 不是 SSH / 超时 / 拒绝 / 认证方式受限）与事实格（本机网卡、DNS、TCP、SSH banner、认证方式）；**「查询公网出口 IP」不点不查**（点了才外呼，界面写明数据去向）；**「探测认证方式」不点不发**（点了也只发协议自带的 `none`，服务器侧不应出现失败密码记录）；「复制报告」拿到的是可粘贴的纯文本 |
| **只读条（2026-09-26 修复）** | **未连接 / 已断开 / 未开 shell 时不出现**「只读：另一个窗口正在此终端输入」黄条（旧版常驻）；只有在**会话活着且本查看器被其他窗口接管**时才出现，点「接管写入」能夺回控制权 |
| **U2.2 文件面板（2026-09-26 新）** | 主机菜单「远程文件面板」/ 工具区文件夹钮开右抽屉：面包屑可点、列表无 `.`/`..`、目录可进可回；上传小文件成功后下载回本地**字节一致**；覆盖上传报 409、超 512MiB 报 413；单项取消不刷虚假进度；断开连接抽屉自动收起；窄屏（≤720）整幅覆盖 |
| **U2.2 降级链（2026-09-26 新）** | 在 exec 与 sftp 两个文件系统视图的网关/跳板机器上上传：**面板自动走命令通道**（`mkdir -p && cat >`）且结果可见；第二次上传直走命令通道（连接记忆 `execOnlyUpload`）；中途失败后有可操作提示，**重试即成功**（不会把「网关不支持 SFTP 直写」误判成路径错误） |
| **P1-1 ssh config 导入（2026-09-26 新）** | 新建/编辑主机弹窗「SSH 配置导入」下拉（ focus/点开才加载）列出本机 `~/.ssh/config` 的直连 alias，选中回填 host/port/user；含 ProxyJump/ProxyCommand 的 alias **禁选但不消失**；本机无 config 时给出明确空态；读取失败显示原因 |
| **P0-1 keepalive（2026-09-26 新）** | 对端静默断开（NAT/防火墙/拔网线模拟）约 60s（15s×4）内连接报 TIMEOUT 并给出排查提示，**不是挂在「已连接」**；终端正常有输出期间连接不断 |
| **G1 SFTP 自愈（2026-09-27 新）** | 文件面板使用中让服务端关掉 SFTP 子系统（或通道超时）后再列目录/上传/下载：**自动重开会话并成功**，错误不整条连接生命周期复现；无需手动断开重连。**✅ 2026-09-28 已实机验收**（真实例 × 真协议 sshd × 真实路由，23/23 中的 G1 十二项：关子系统后 list 仍 200 且服务端子系统计数再 +1；证据 `_refs/scripts-archive/ssh-g1g2-live/evidence.txt`） |
| **G2 背压暂停（2026-09-27 新）** | 弱网 / 休眠恢复 / `top` 狂刷等大数据量滚动时：状态栏出现「输出已暂停（对端繁忙）」后自动恢复，**终端不掉线、不弹 1011 重连**；暂停超 30s 仍不 drain 或缓冲超 8MiB 才走原兜底断开。**✅ 2026-09-28 已实机验收**（G2 十项：洪水 33.5MB 过 WS、慢 consumer 收 `output.paused` 且零 1011、drain 后 `output.resumed`、echo 回环、连接全程 connected；状态栏文案的视觉层待下次重启顺手复验） |
| **U3 · 跳板与本地转发（2026-09-26 落地；判据行 2026-09-29 补立）** | ① **跳板建连**：主机编辑器「经由跳板」选一条**已受信任**的主机 → 目标连接经其 `forwardOut` direct-tcpip 通道建连成功且**终端有输出**；跳板从未连过 / 未就绪 / 正在等指纹确认 ⇒ `JUMP_UNAVAILABLE` 结构化**可读拒绝**（不挂死、不静默失败 ——「不把发起认证暴露成隐式能力」，password 跳板必须人先单独连一次）；② **本地转发**：编辑主机加规则（本机 `127.0.0.1:localPort` → 远端 `remoteHost:remotePort`，每连接上限见 `lib/store.js`）→ 连接建立后自动监听、**本机端口字节级往返通**、断开自动撤下（僵尸端口比没有端口更糟）；端口被占（`EADDRINUSE`）/ 服务端拒绝转发（`Administratively prohibited`）⇒ 状态栏**可见异常**且**连接状态不翻 error**（转发层故障，终端照常可用）；③ **反例（静默失效红线）**：端口在监听甚至能连上 ≠ 转发通 —— 判据必须是**字节级往返**。**需外部资源**：跳板 + 目标两台真实机器（或本地假 sshd + 真 echo 服务的等效环境，骨架可借 `_refs/scripts-archive/ssh-g1g2-live/` 改造） |

**D2 全屏浮层实机验收（2026-09-15，真实 GUI **20 项门槛全过**）**：驱动 `_refs/scripts-archive/ssh-d2-accept/run-accept.mjs`（真浏览器 × **真实 GUI** × 真实鼠标/键盘事件 + 本地假 sshd 真协议端点；约 6 分钟可复现，证据 `accept-result.json` + `shots/*.png`）。与「探针宿主页」验收的本质区别：**从用户能点的元素出发、走 hit-test**（D1「单向门」教训）。已验：hero launcher / 会话头胶囊两条入口真实点击开浮层；浮层五点采样 hit-test 全落浮层内（官方 UI 不可达）；顶栏三段胶囊 + SSH `aria-current="page"` + **宿主文档零顶栏**；顶栏只三按钮（工具区控件不在其中）；「对话」退出 + 焦点归还入口；`Esc` 不关闭；Shift+Tab 反向可达「对话」且 focus-visible solid 2px；SSH↔画布**双向**互斥；记忆语义（开着刷新恢复 / 关后刷新停在对话）；**真协议零损失**（关闭期间零 resize 帧、重开 iframe 未重载、30 次开关零帧且 SSH 侧 shell 恒为 1）；三主题切换 + 顶栏 reserve 消费（`padding-right = 14 + 150`）；壳内入口与窗控不叠压。
**同轮附带两条非 D2 发现（已于同日修复，用户定向「两条一起修」）**：**D-1**（阻断）「保存并连接」从不发起连接（意图标记曾挂在按钮 `event` 上 ⇒ 解析到全局 `window.event`，`dispatchEvent` 后读不到；改走闭包变量）；**D-2**（体验）指纹确认后状态栏/横幅不追平（`session.js` 曾只把 `ready`/`status` 帧写成文案、不喂状态模型；现统一转发 `onFrame`）。另：hero 态无画布入口 ⇒ 顶栏「会话布」**已按诚实降级收口**（宿主下发 `canvasAvailable`，hero 态只渲染「对话｜SSH」两段、进入会话后三段回归）。**当日修复后重启 host 复验：`allPassed=true`，24 项门槛全 PASS、0 FAIL**。详见 `dsh-miasaki-ssh/design/2026-09-14-ssh-fullscreen-overlay-plan.md` §16。

**D3 全屏浮层清理与回归实机验收（2026-09-15，8 项门槛 7 PASS）**：驱动 `_refs/scripts-archive/ssh-d3-accept/run-d3-accept.mjs`（同 D2 通道：真 GUI × 真实事件 × 假 sshd 真协议）。**通过项**：① **四档宽度按视口语义落位**（1280 rail 232 / **960 rail 208 —— 恰在断点值落紧凑档** / 720、480 抽屉；四档零横向溢出）；② 三主题 × 1280/480 零溢出 + 顶栏稳定 + reserve `padding-right:164px`；③ A0 文案「点左上「对话」退出后粘贴」+ 剪贴板首行格式正确；④ 官方 tab 栏无 SSH；⑤ 会话态官方 `[data-width-handle]` 正常显示（本线未再隐藏）；⑥ 回退视图面零残留（`.dsh-ssh-view` / 临时退出条）；⑦ 真实连接链路。**D3-F1 已闭环**（用户定向「现在就删」）：`client.js` 注入样式里那条 `div[data-phase]:has(...) [data-width-handle]` 死规则已删除（回退视图已删 ⇒ `:has()` 永不命中），旧断言改写为「零残留/零触碰」并新增回归断言 ⇒ 本节「`grep` 应无命中」判据达标。单测 **81 例**、`verify-all ssh` **12/12**。详见方案 §18。

**D4 尾项清理实机验收（2026-09-15，6 项门槛全 PASS）**：驱动 `_refs/scripts-archive/ssh-d4-accept/run-d4-accept.mjs`（同通道；**尾项①②取运行态证据**）。**①`renderBanner` 隐藏即清空**：可见态 `hidden:false / childCount:3` → 连接完成后 `hidden:true / display:none / **childCount:0**`（旧实现只设 `hidden`，节点残留）；断开后横幅再现 `childCount:4` ⇒ 清空未破坏功能。**③过渡区间落位**：1280 → rail 232 / 860 → rail 208（紧凑档）/ 600 → 抽屉 / **500 → 抽屉且 `.tools .optional` 可见（480 档未触发）** / 480 → 隐藏（480 档命中）；五档零横向溢出。**②运行态**：30 次开关零异常 + iframe 未重载 + 远端零 resize 帧；静态侧 `observe(header,{childList,subtree})`、`aria-selected` 仅剩注释。**附带**：注入样式零 `width-handle`（D3-F1 实机复核）。单测 **82 例**、`verify-all ssh` **12/12**。详见方案 §20。

**U2 主体实施（2026-09-16，实机验收待跑）**：`dsh-miasaki-ssh/design/2026-09-15-ssh-u2-plan.md` §6 的 **U2.1 多 shell / U2.3 工作区记忆 / U2.4 精确恢复**已落地（**U2.2 SFTP** 留待真实主机补验后开工）。单测 **85 → 110 例**（runtime 22 / session 32 / http 7 重写适配 v2 契约，app 16 / client 25 / store 8 无回归）、`verify-all ssh` **12/12**；端到端探针（真 sshd × 本线 `SshRuntime`）**9/9**；**回滚演练实际执行**（基线恢复 85/85 绿 → U2 还原 110/110 绿）。上表 **U2 四行**即本轮实机验收判据，明细见 `dsh-miasaki-ssh/README.md` 与 `dsh-miasaki-ssh/design/CHANGELOG.md` 第十二批（含「规划决策 5 的 `app.js` 纯搬迁拆分未执行」的偏离登记）。

**入口判据两连修（2026-09-25，B1 越界 + B2 去重）**：用户两次报障驱动 —— ①「右上角 SSH 按钮应该只在主页显示，而不是每个界面都有」（B1：`shell.overlay` 是 root 级浮层、每屏都渲染，补「在主页」这一维，锚 `[data-slot="main.conversation"]`）；②「会话窗口右上角不应该有 SSH 按钮 —— **重复了，胶囊有 SSH 按钮入口**」（B2：旧判据推演官方 `useSessions` 的 `SessionSummary.blank`，而官方决定会话头 chrome 渲不渲染的是 `blank = session === void 0 || conversation === void 0 || (session.blank && conversationPhase(...) === 'blank')` —— 两个 blank **语义不同**，summary 仍为 provisional blank 但会话阶段已不是 blank 时，官方 `hideChrome = false` ⇒ 胶囊在、旧判据也返回 hero ⇒ launcher 同时在场）。**修法**：launcher 判据收敛为 `onConversationHome() && !ownEntryPresent()`（`.dsh-ssh-switch` 不在 DOM 才渲染），探的是**本线自己的产物**（与 `syncChrome()` 用 `.dsh-canvas-switch` 算 `canvasAvailable` 同源），不受官方 blank / conversationPhase 语义漂移影响；两层组件合并为一层（不再消费官方 prop）。单测 **115 → 117 例**、`verify-all ssh` **12/12**。**实机复验即上表「入口去重（B1/B2）」行**，明细见 [CHANGELOG](../../dsh-miasaki-ssh/design/CHANGELOG.md)（B1 / B2 两节）。

**弹层形态改造：右侧抽屉 → 居中悬浮窗（2026-09-26，实机反馈 + 探针实测）**：用户截图 —— 桌面壳右下角主题球（`#miasaki-switcher .ms-btn`，fixed `right/bottom 16px` 的 46px 圆 + 6px 光晕，`z-index 99990`）盖住贴边抽屉右下角的「确认」键。**修法是改形态而非再加一条让位**（贴边形态的右下角与球必然共享同一块像素）：`.sheet` 改为居中悬浮窗（遮罩口径照官方设置面板、24px 圆角、`max-height: calc(100% − 64px)`），并新增第二条让位口径 `--ssh-shell-fab-safe-right`（球左缘距 iframe 右缘 + 光晕 + 呼吸）→ 卡片宽度 `min(560px, 100% − 2×max(32px, 安全线))`，窄窗口自动缩窄避球；`--ssh-chrome-clearance` 保留（改挂在遮罩层 `padding-top`），`--ssh-chrome-avoid-right` 与 `openSheet` 的 `wide` 死参数退役。**探针实测（归档 `_refs/scripts-archive/ssh-modal-verify/`，宿主页加载真实壳注入产物自建窗控组与主题球 + 真实 `app.js`/`styles.css`）五场景全过**：1540×1042 新建主机 / 640×820 / **480×640 极窄** / 1540×1042 连接密码 / 无壳 chrome 浏览器形态；「保存并连接」「确认」与球的**重叠面积全为 0**。单测 **127 例**、`verify-all ssh` **12/12**。**上表新增行即本轮实机判据**（需重启 `dsh web`，改的是 `app.js` / `styles.css`）。

**对标 zcode 方案落地：P0 三件套 + U2.2 SFTP + P1-1 ssh config 导入（2026-09-26，用户拍板「按建议开工」）**：详见 [dsh-miasaki-ssh/design/CHANGELOG.md](../../dsh-miasaki-ssh/design/CHANGELOG.md) 同名条目与 [zcode 对标调研与方案](../../dsh-miasaki-ssh/design/2026-09-26-ssh-zcode-benchmark-plan.md)（v1.1）。① **P0-1 连接健壮性**：keepalive 15s×3（真协议探针 6/6 PASS：60043ms 报 `Keepalive timeout` 归 `TIMEOUT`）；`buildConnectConfig()` 纯函数化；`classifyError()` 新增 ssh2 `level` 分级与私钥口令两码。② **P0-3 exec 前置**（`lib/exec.js`）：POSIX `/bin/sh -c` 包装 / close 收尾 + exit 码优先 + 50ms 排空 / banner 跳过。③ **U2.2 SFTP**：8 个 REST 端点 + `sftp-ui.js` 右抽屉 + zcode 降级链（sftp 视图无目录/会话打不开 ⇒ 零字节消耗直降 `mkdir -p && cat >`；mid-stream 失败记 `execOnlyUpload` 下次直走命令通道——**偏离登记**：单次 HTTP 源流不可回放，不就地降级）；路径安全收敛 `lib/paths.js` 一处。④ **P1-1 ssh config 导入**：`ssh -G` 优先 + 自研解析回退，只导直连 alias。单测 **153 → 225 例**；**闸门同步补强**：6 个新模块进静态语法闸门，`verify-all ssh` **14/14 → 26/26**（此前新模块只靠 `package.json` 的 build 脚本检查，回归里看不见）。**上表新增四行即本轮实机判据**（需重启 `dsh web`）。

**dsh-web 引擎层加固 G1/G2（2026-09-27，方案 [2026-09-27-ssh-dshweb-engine-gap-plan.md](../../dsh-miasaki-ssh/design/2026-09-27-ssh-dshweb-engine-gap-plan.md)）**：① **G1 SFTP 自愈**——`sftpSession()` 挂 close 监听清死引用 + `isSftpTransportFailure()` + `withSftp()` 当次重开一次（仅一次）；② **G2 背压暂停**——`ShellChannel.pauseOutput/resumeOutput` + 水位（2MiB 暂停 / 512KiB 恢复 / 30s 超时或 8MiB 兜底断开），新帧 `output.paused`/`output.resumed` 只做 host→browser 状态栏展示。单测 **299 → 310 例**、`verify-all ssh` **31/31**；真协议探针归档 `_refs/scripts-archive/ssh-g1-g2-probe/`（G1 关子系统自动重开 7/7、G2 慢 consumer 暂停而非断开 11/11）。**上表新增两行即本轮实机判据**（需重启 `dsh web`，改的是 `lib/` 与 `session.js`/`app.js`）。

### 3.7 模型连通性探测（desktop 线 `plugins/dsh-model-probe/`，2026-09-19）

「测试连通性 v2」的实机判据。补丁侧已生效（`settings-models` = `patched / F1717A07…`，
即 v2.1 —— v2 首版的产物曾因 locale 尾逗号而语法非法、导致整页插件不注册，
详见该补丁 README 的「事故记录」），插件是补丁的**可选**依赖——缺席时按钮走降级路径。
设计见 `dsh-miasaki-desktop/design/model-probe-v2.md`。

| 检查项 | 步骤 | 通过判据 |
|---|---|---|
| host 就绪 | `curl -s http://127.0.0.1:3080/model-probe-api/health` | `{"ok":true,…}`（见 §2 表） |
| **误报修复（本次主目标）** | 设置 → 模型 → `step` 的 `step-5-preview` 点「测试连通性」 | **绿色「可用 · Nms」**。v1 在这一项报 `…/step_plan/v1/models?limit=1000 answered 401; check the API key`——该文案不再出现即达标 |
| 错 key 零消耗 | 临时在表单里填一个明显错误的 key 后测试 | 「认证失败——检查 API Key」，且**握手档 401 即终止**（不产生生成调用，套餐用量无变化） |
| 错模型 ID | 把模型 ID 改成 `no-such-model-xyz` 后测试 | 「模型 ID 未注册或拼写错误」——**不是** 401，也不是原始错误串 |
| 地址不可达 | 把 baseURL 改成 `https://127.0.0.1:9` 后测试 | 「无法连接——检查地址与网络」 |
| 超时 | 指向一个会挂起的地址 | 「连接超时（15s）」（15s 内返回，不无限「测试中…」） |
| **降级路径** | 从 profile 移除该 bundle → 重启 host → 刷新页面 → 再测试 | 显示 v1 目录探测结果并附「（探测服务未就绪，已回退目录探测）」；**不得白屏、不得永久停在「测试中…」** |
| 协议不支持 | 对 `api` 不属于三种协议之一的路由测试 | 「该协议暂不支持探测」（不发请求） |
| 无副作用 | 上述各项执行后检查 `~/.dsh/settings.yaml` | 内容未被改动（探测只读配置，结果只存在于页面运行态） |

### 3.8 用量统计（第八线 `dsh-token-monitor` v0.6.0，2026-09-26）

**两条「干净」的实机判据**：① 官方桌面端 profile 隔离为纯净官方版后**只挂回这一条**插件；
② **账本按 profile 分区**，官方桌面端统计只记载官方消耗。装法与口径隔离设计见
[dsh-miasaki-usage/README.md](../../dsh-miasaki-usage/README.md)。

| 检查项 | 步骤 | 通过判据 |
|---|---|---|
| 插件加载 | 重启官方桌面端（`desktop` profile）→ 刷新页面 | 侧栏脚部出现「用量统计」入口；会话页出现「用量」Tab |
| host 半生效 | `curl -s http://127.0.0.1:<host 端口>/dsh-token-monitor/global`（官方桌面端当前为 19387，自制壳固定 3080 —— 端口随实例而变，别照抄） | 返回 JSON 且含 `"profile":"desktop"`（**404 = host 半未加载**） |
| **口径隔离（本次主目标）** | 打开「用量统计」浮窗 | 内容顶部显示「口径：本页只统计当前 profile（desktop）的消耗 · 与其它 profile 的账本完全隔离」；**数字只含官方桌面端自己的消耗** —— 自制壳 / 浏览器 GUI 跑过的会话不计入 |
| **分区落盘** | 看 `~/.dsh/plugins-data/dsh-token-monitor/` | 出现 `desktop/` 分区（首次为空登账、随用随增）；`miasaki/` 分区在自制壳下次启动后出现，内含分区前那份历史账本 |
| 历史归位 | 启动一次自制壳（`miasaki` profile） | `usage-log.jsonl` + `config.json` + `.bak-*` 已从数据根目录搬进 `miasaki/`；自制壳统计页数字**与迁移前一致**（一个数字都不丢） |
| 隔离未被破坏 | 探针 profile（复制 `desktop` 清单 + junction 复用其 `node_modules`）跑 `dsh --profile <探针名> --dump-config` | 输出里 `token-monitor` 出现，而 `@miasaki` / pet-panel / model-probe / free-model-pool / session-log-move **计数为 0** |
| 会话 Tab 不受影响 | 任一官方桌面端会话 → 「用量」Tab | 上下文剩余 / 会话用量总览 / 按模型明细 / 工具调用正常（纯会话口径、与会话绑定，与账本分区无关） |

#### 实测记录（2026-09-26，官方桌面端 `desktop` profile）

| 判据 | 状态 | 证据 |
|---|---|---|
| host 半生效 | ✅ 通过 | `GET http://127.0.0.1:19387/dsh-token-monitor/global` → **HTTP 200**；响应顶层含 `"profile":"desktop"`（404 才是未加载） |
| **口径隔离** | ✅ 通过（数据面） | `note` 原文含「账本按 profile 分区 —— 本页只统计当前 profile（desktop）的消耗，官方桌面端与自制壳 / 浏览器 GUI 各记各的账、互不混入」；`stats.since = 2026-09-26`、`activeDays = 1` —— 官方侧**从零累计**，未掺入自制环境消耗 |
| **分区落盘** | ✅ 通过 | `~/.dsh/plugins-data/dsh-token-monitor/desktop/usage-log.jsonl` 存在且持续续写（当日 11:10 仍在写，43,894 B） |
| 历史归位 | ✅ 通过（数据面） | `miasaki/` 下已有 `usage-log.jsonl`（3,419,914 B）+ `config.json` + `usage-log.jsonl.bak-20260910101548`；数据根目录**无散落账本**（归位完整）。自制壳统计页数字与迁移前一致 —— 待下次启动自制壳目视 |
| 隔离未被破坏 | ✅ 通过 | 探针 profile `--dump-config` 1290 行：`token-monitor` 3 处，其余自制插件计数全 0（见本文件变更记录 2026-09-26 行） |
| 插件加载（GUI 层） | ⏳ 待目视 | 侧栏脚部「用量统计」入口、会话页「用量」Tab —— 需在页面上确认 |
| 会话 Tab 不受影响 | ⏳ 待目视 | 同上（纯会话口径，与账本分区无关） |

> 数据面五项已闭环；剩余两项是**视觉确认**，不阻塞本线收尾。

### 3.9 会话存储按 profile 隔离（desktop 线，2026-09-26）

| 检查项 | 判据 | 结果 |
|---|---|---|
| 读取侧 | 无头 Edge 实载 `dsh --profile miasaki --no-open --port 31877`，捕获全部会话载荷 | ✅ 180 个会话 id 中 **179 个属新 root**；唯一属全局 root 的经上下文核对出自 canvas 工作区数据（`sessionIds`），非会话列表 |
| 写入侧 | 后端运行期间新建会话落哪个 root | ✅ 落**新 root**（11:27:16 `session-0cfe7de0…`）；同一时段全局 root **零新增**（最新会话仍停在 11:17:28） |
| 差分标记 | 复制时**刻意排除** <工作区-1> 项目（7 个会话）：若列表来自全局 root，这 7 个 id 必然出现 | ✅ 6 个出现 0 次；第 7 个仅出现在 canvas 的工作区引用里 |
| 启动 | 插件树无 `did not activate` / `pending`、无启动屏报错、console 错误 0 | ✅ |
| 官方侧边界 | `profiles/desktop` 的 `cordis.patch.yml` / `package.json` 哈希前后一致 | ✅ `8948F53D…` / `963CB662…` |
| 语法闸门 | 补丁层改动过 `dsh --profile miasaki --dump-config`（DSH 自身解析器） | ✅ exit 0，覆盖条目在场 |
| 历史完整性 | 新 root 与全局 root 对账 | ✅ 两侧均 8 个项目目录 / 231 个会话 |
| 回滚路径 | `~/.dsh/profiles/miasaki/cordis.patch.yml.bak-20260926-112206-before-sessionsplit` | ✅ 在场（19438 B） |

> **判据为何必须做成「差分标记」**：新 root 是全局 root 在 11:22 的**超集快照**，
> 所以「列表里有没有某个常见会话」根本区分不出两者 —— 只有**刻意不复制**的那部分才能当判据。
> 同理：会话 header 无来源标记 ⇒ 历史无法事后分类，本项验收**只覆盖「从现在开始隔离」**。
> **操作纪律三条**（踩坑换来的，详见 desktop 线 CHANGELOG 同条）：
> ① 不要用 PowerShell here-string 拼含反引号的 YAML（PS 的反引号是转义符）；
> ② 补丁层改动的验收必须走 `--dump-config`（离线 YAML 校验会漏掉「CR 落在注释行内」这类损坏）；
> ③ **`--dump-config` 不是只读操作** —— `prepareProfile` 会重写该 profile 的 `cordis.yml`。

### 3.9b 分组账本按 profile 隔离（desktop 线，2026-09-27 补齐）

> **为什么要补这一节**：§3.9 只隔离了**会话正文**，而 `storage-json`（侧边栏工作区分组账本 +
> 会话投影缓存）仍用官方默认的全局 `dshHomePath('storages')`。三个实例同写一份账本 ⇒ 各自登记的
> 会话在对方实例里 `session header is missing`，被 `sessionIds` 实时过滤 ⇒ **重启后会话没丢、
> 却整批掉进「未分组」**（用户 2026-09-27 报障）。账本 `initialized:true` 后不再全量回填，
> 所以「只重置 initialized」只是权宜、必然复发。

| 检查项 | 判据 | 结果 |
|---|---|---|
| 配置生效 | `profiles/miasaki/cordis.patch.yml` 新增 `storage-json` 条目，`config.root = dshHomePath('profiles','miasaki','storages')` | ✅ |
| 账本落位 | 新 root 生成自己的 `workspace.json` | ✅ 2026-09-27 **21:43:47**（改配置 21:43:44，运行中的实例热重载即建） |
| 全量回填 | 新账本按会话 `cwd` 自动归组 | ✅ 242 个会话归位 **237**：dsh-miasaki 227 / <工作区-1> 7 / <工作区-2> 2 / <用户主目录> 1 |
| 余 5 个未归组的解释 | 其 `cwd` 目录是否存在 | ✅ 全部已不存在（Prism / 新建文件夹 / 正大 / 临时目录）——官方按 `realpath(cwd)` 归组，目录没了本就不归组 |
| 归档意图不丢 | 全局账本 11 条 `archivedSessionIds` 合并进新账本 | ✅ 合并后 `archived=11`，`initialized` 与 4 个工作区原样保留（幂等去重） |
| 对侧不被写 | 全局 `~/.dsh/storages/workspace.json` 的 mtime | ✅ 停在 21:26:24（本壳新 root 建立后零改动） |
| 双份分叉 | 231 个同 id 会话逐字节比对 | ✅ 一致 228 / 分叉 3（清单：`_refs/audit-2026-09-27/session-fork-report.md`） |
| **全局侧**（web + 官方桌面端共用账本） | 同一脚本 `--write` 重置 `initialized` → 任一实例启动时回填 | ⏳ **已写入、待 web host 重启生效**（2026-09-27 21:53 重置，60 秒未被覆盖）。生效判据：`workspaceIds` `0 → 2`、`initialized` 回 `true`、`dsh-miasaki` 分组由 5 条扩到该 cwd 下全部会话 |
| 回滚路径 | 删 `storage-json` 条目 + 删 `profiles/miasaki/storages/` | ✅ 备份在 `_refs/audit-2026-09-27/backup/` |

> **判据的排他性**（为什么这组数字能证明是「本次 bootstrap 的产物」）：旧全局账本 `initialized:true`
> ⇒ 打开它**不会**触发回填；而它总共只登记 6 条会话。新账本里出现 **237** 条，只可能来自
> `initialized:false` 路径下的 `bootstrap`，无法由「把旧账本复制过去」造成。
> **执行纪律**：`--merge-intent` 必须在**目标实例关闭时**执行（storage-json 的内存态是权威，
> 运行中的实例写一次文件即覆盖外部改动）；复跑工具见 desktop 线 CHANGELOG 2026-09-27（续二）。

### 3.10 双模型（`@miasaki/dsh-dual-model`，2026-09-26 补节）

> **为什么此前没有这一节**：本线 M1 实现完成于 2026-09-10，但验收矩阵一直**没有它的专节** ——
> 也就是**没有判据**，「未验收」这件事在文档层面无从表达（评审报告连续两轮点名此缺口）。
> 本节按 README 的实机验证点与 `index.js` 的实际实现补齐判据。
>
> **前置**：`dsh web` 重启（host 半新增路由，且图片准入补丁在 host 侧）；浏览器强刷。
> 补丁在位判据：`node dsh-miasaki-dual-model/patches/dsh-api-session-controller/patch.mjs status` 报 `patched`。

| 检查项 | 通过判据 |
|---|---|
| 控件出现 | 输入框右下角（`conversation.input.right`）出现「双模型」触发钮，标签为「主 ▸ 辅」形态 |
| 辅助模型配置 | 点开面板只列**支持图片**的模型；选中保存后重开面板值仍在（配置落盘） |
| 零退化（未配置时） | 未配辅助模型时拖入图片 → 行为与未装本线一致（准入走官方原生分支，不额外拦截、不报错） |
| 路由生效 | 配好辅助模型后拖入图片 → 状态行显示「图片将由「X」处理」 |
| **纯文本主模型仍可传图** | 把主模型切到纯文本模型 → 带图消息**发得出去**且模型**读到了图**。这是本线「绝不静默降级」硬契约的实机判据（设计文档自陈，至今未闭环） |
| 无副作用 | 发送**纯文本**消息时模型选择器上的当前模型不被切换（`keep` 路径不抖动配置）；发过图之后的历史引用旧图仍能正确路由 |
| 失效信号 | 在别处改动模型设置后，本线缓存被击穿（0.1.7 双轨失效事件），面板不显示陈旧值 |
| 同源围栏 | 非环回 `Host`，或 `Origin` 与 `Host` 不一致时打本线 `/state` → **403**（`index.js` 的 `fenceOk`，两道判定） |

> **实机判据与单测的分工**：单测已覆盖路由判定（`decideRoute` 10 例）、内容判图（7 例）、
> 失效双轨（5 例）与 client 装载契约（4 例，含「`/state` 失败时触发钮不得被禁用」的死件回归）；
> 本节八项是**只有真 host + 真模型**才能回答的部分 —— 台账 B1–B3 即其中三条核心验证点。

### 3.11 平台与插件生态（第三方插件的 v4 消息来源，2026-09-27 补节）

> **为什么有这一节**：2026-09-27 用户在 miasaki 桌面端报「本轮运行失败 format v4 message
> requires a producer-owned source kind」。它**不是任何一条自制线的缺陷**，而是**第三方插件**
> （`@openviking/dsh-memory-plugin@0.2.1`）仍在用 v3 的消息来源写法，被 DSH 0.1.7 的 v4 准入
> 在**落盘前**拒绝（所以磁盘与 host 日志里都查不到痕迹）—— "插件生态兼容"此前在矩阵里没有位置。
> 完整判据、取证方法与日志取证坑（多帧 zstd）见
> [`dsh-platform/dsh-0.1.7-session-v4-source-admission-2026-09-27.md`](../dsh-platform/dsh-0.1.7-session-v4-source-admission-2026-09-27.md)。
>
> **前置**：重启 miasaki 桌面端（或 `dsh web`）—— 插件在 host 半，只在启动时加载。

| 检查项 | 通过判据 |
|---|---|
| 静态闸门 | `node scripts/check-message-sources.mjs` PASS（仓库内 + 本机已装插件零命中）；`node scripts/verify-all.mjs repo` 应 **3/3** |
| 修复落位 | `~/.dsh/profiles/{miasaki,web}/package.json` 的 `@openviking/dsh-memory-plugin` ≥ `^0.5.8`，且 `node_modules` 里实装版本为 **0.5.8**（0.2.1 硬编码 `kind: "plugin"`，必中招） |
| 生效（重启后） | 触发一轮记忆召回 → **不再出现**「本轮运行失败 format v4 message requires a producer-owned source kind」 |
| 落盘形态 | `node scripts/inspect-session-sources.mjs` 在**新**会话里能看到 `plugin:openviking-memory` 的 source kind。旧文件里的 `plugin` 是 v3 历史资产（迁移器认它），**不受影响、也不应批量改** |
| 回滚 | 新版引入其他问题时：版本约束改回 `^0.2.1` 并 `pnpm install`（记忆功能失效但不再报该错），或把该插件从 `dsh.profile.bundles` 移除 |

### 3.12 免费模型（第九线 `@miasaki/dsh-free-model` v0.4.0，2026-10-02 补节）

> **为什么有这一节**：本线 2026-09-28 由 desktop 线迁出并扩容职责后，**既没有 §3.x 专节、也没有
> §3.0 编号** ⇒ 实机债务在文档里不可见（「待验」只散在各线 CHANGELOG 的「实机待验」条目里，
> 无法勾选、无法交接）。台账 J1–J5 此前引的就是这些散落条目，**判据正文第一次收进矩阵**。
> 逐条设计决策见 [`design/CHANGELOG.md`](../../dsh-miasaki-free-model/design/CHANGELOG.md)。
>
> **前置**：重启 `dsh web` 或 miasaki 桌面端（插件 host 半只在启动时加载）+ 浏览器强刷。
> **上游依赖**：本线界面是上游插件 `dsh-our-free-model` 的**增量补丁**（五处锚点改写本机安装副本），
> 上游自升级后须重打（台账 J5 = live 闸门，非一次性验收）。

| 检查项 | 通过判据 |
|---|---|
| 统一页与上游让位 | 设置左栏**只剩一栏「免费模型」**（无公告中心分区、无首启弹窗、左栏 nav-label 已改）；模型清单后出现「本机自配平台」分区（选平台 → 检测 → 卡片 → 写入配置 / 设为子代理）。**反例（判据的判据）**：停用本线插件后该栏退化为一行「『免费模型』插件不在场」，其余分区照常 |
| scan 真实数据 | `POST /freemodel-api/scan` 的 `models[]` 含免 Key 车道的模型（`source:"adapter"` / `writable:false` / `freeReason` 含「免 Key 车道」）；自配平台侧真实数据上判定命中（命中数与模型 id 与面板一致） |
| 能力画像 | 模型卡能力项**只到能被证明的程度**：适配器未声明即标「未声明 · 需实测」，**不得出现未经实测的 false** |
| 模型卡实测 | 「实测」给出「可用（…）+ 耗时」；**未装 `dsh-model-probe` 时按钮整块隐藏**（不给点了报 404 的按钮） |
| 设为默认 | 走官方 `agentDefaultModel.saveSelection` ⇒ **下一次会话**立即生效（不是当前会话） |
| 围栏不回归 | 非环回 `Host` / 跨站打 `/freemodel-api/*` → **403**（围栏**先于 method 检查**：跨站 POST 得 403 而非 405）。**注意** `/apply`（写配置）与 `/subagent`（改预设文件）是写动作，此前裸奔 |

> **两条形态纪律（照旧文档验会误判）**：① 本线**绝不注册 `settings.models.*` 槽位** ——
> 官方模型页的编辑面板也 dispatch 那个槽，occupant 出问题就**整树白屏**（用一次事故换来的纪律）。
> 模型页的两个落点（`settings.models.footer` / `provider-card`）已于 2026-09-28 **全部撤销**，
> CHANGELOG 里仍留有「模型页底部应看到免费模型面板」的旧验收指引 —— **那是撤销前的形态，不是现状**。
> ② 上游在场时本线让位（只有一个入口），上游不在场才由本线 `settings.section` 顶上（条件注册）。

### 3.13 Fleet（多 Agent 编排线，2026-10-02 补节）

> **为什么有这一节**：同 §3.12 —— fleet 线此前也没有专节，面板与派单判据只散在 §4 两行 + L1
> 自动回归里。台账 K1–K5 的判据正文第一次收进矩阵。协议与设计见
> [`docs/multi-agent-cli-orchestrator-design.md`](../../dsh-miasaki-fleet/docs/multi-agent-cli-orchestrator-design.md)。
>
> **前置**：本机起 `fleet-monitor` 面板（`127.0.0.1`）；派单类判据需真实 agent CLI（headless）。
> **K3–K5 是「先修后验」项**：三处静默缺口修完后才在此验收（修前验不了）。

| 检查项 | 通过判据 |
|---|---|
| 判定层上屏（K1） | 面板出现**可派集 / 能力断层 / 机器事件**三块，数字与 `task-ready.mjs --dispatchable --json`、`agent-pick.mjs --gaps --json`、`graph-events.jsonl` 尾部**逐条对得上**（面板 spawn 现成 CLI，不自实现判定）；不可派任务**带出原因**（不是只给计数）；**降级不白屏**（判定层 CLI 不可用 ⇒ 端点返回 `ok:false`、面板不整页 500）。**反例（判据的判据）**：临时给某任务加依赖 ⇒ 面板数字跟着变，证明它真在读判定层 |
| 派单消费判定层（K2） | 真实 **3 路 fan-out → reduce → verify** 钻石图跑通（G1 可派 / G2 能力 / G4 验证三层判定已接线，缺的是多任务实跑的端到端） |
| 终态如实落账（K4） | 构造一个**真实受阻样本**（worker exit 0 但契约 `status=blocked`）⇒ `agents/<id>/status.json` 落 `blocked` 而非 `idle`，事件流写 `failure.detected` 带 `state`。**反例**：非零退出已实机验证（t-0010 首派 claude 因 ccswitch 未启动返 404 ⇒ `error`），但 `blocked` 分支仍需真实样本 |
| 交付物反向存在性（K3） | 台账 done+accepted ⇒ `tasks/<id>/result.json` 必须存在，缺失**显式失败**并点名（`validate-bus` 实盘 0 错误） |
| 厂商表真读（K5） | `shared/agent-vendors.json` 存在且合法，覆盖内置表登记的全部 agent；`verifier-pick --check` 通过 |

> **已知未做（P2，不在本节验收范围）**：`/api/verifiers` 端点与设计 §8.4 的四条告警规则
> （心跳丢失 / 预算 ≥80% / 任务硬超时 / 开关与进程不一致）—— **面板不告警就只是图表页**。
> 另：验证任务的**自动派发**刻意不做（会引入新的任务生命周期，属独立议题，见 K2b-2）。

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
| 2026-09-15 | **SSH 线 D2 全屏浮层实机验收：真实 GUI 24 项门槛全过**（§3.6 新增该节；首轮 20 PASS + 2 FAIL，均为非 D2 缺陷，同日修复后复验全绿）。通道升级：真浏览器 × **真实 DSH GUI**（真宿主 + `link:` 真插件 + 真会话 + 真桌面壳注入）× **真实鼠标/键盘事件（走 hit-test）** × **本地假 sshd 真协议端点**，取代此前「探针宿主页 + 桩 slots」——D1「单向门」教训落地。覆盖形态（两条入口 / 全屏覆盖 / 三段胶囊 / 顶栏只三按钮 / 退出与焦点归还 / `Esc` / Shift+Tab 键盘可达 + focus-visible）、互斥（SSH↔画布双向）、生命周期（记忆语义 + 关闭期间零 resize 帧 + iframe 不重载 + 30 次开关零帧 + 单 shell）、三主题（逐一切换 + 顶栏消费窗控 reserve `14+150` + 壳内不叠压）→ `ssh` **12/12**。**附带逮到两条非 D2 缺陷移交**：D-1（阻断）「保存并连接」从不发起连接（事件对象作用域错位）；D-2（体验）指纹确认后状态栏/横幅不追平、刷新才恢复（`ready` 帧未喂状态模型）。证据归档 `_refs/scripts-archive/ssh-d2-accept/`（`node run-accept.mjs` 可复现）。**同日修复 + 重启 host 复验：24 项全 PASS（`allPassed=true`）**——D-1 转为"凭据框被拉起"、D-2 转为状态栏「已连接」+ 横幅 `display:none`，hero 态顶栏改为两段（`canvasAvailable` 降级） |
| 2026-09-15(晚) | **SSH 线 D3 清理与回归实机验收（独立重跑，8 项门槛 7 PASS）**（§3.6 补充该节，方案 §18）：驱动 `_refs/scripts-archive/ssh-d3-accept/run-d3-accept.mjs`（约 4 分钟可复现，`d3-accept-result.json` + `shots/`），**不依赖 D3 实施者自己的探针**。通过：**四档宽度按视口语义落位**（1280 rail 232 / **960 rail 208 = 恰在断点值落紧凑档** / 720、480 抽屉 + 关闭钮；四档零横向溢出）、三主题 × 1280/480（零溢出 + 顶栏稳定 + reserve 164px）、A0 文案（状态栏「点左上「对话」退出后粘贴」+ 剪贴板首行 `[SSH 标签 · 用户@主机:端口]`）、官方 tab 栏无 SSH、会话态官方 `[data-width-handle]` 正常显示、回退视图面零残留、真实连接链路。**D3-F1 同日闭环**：那条 `div[data-phase]:has(...) [data-width-handle]` 死规则已删（用户定向「现在就删」），旧断言改写 + 新增回归断言 ⇒ 「grep 应无命中」达标，D3 完全达标。单测 **81 例**、`ssh` **12/12** |
| 2026-09-15(深夜) | **SSH 线 D4（D3 三项尾项清理）实机验收：6 项门槛全 PASS**（§3.6 补充该节，方案 §20）：驱动 `_refs/scripts-archive/ssh-d4-accept/run-d4-accept.mjs`。**尾项①`renderBanner` 隐藏即清空**（运行态取证：可见态 `childCount:3` → 连接完成后 `hidden:true/display:none/**childCount:0**`；旧实现节点残留）**+ 清空后仍能重建**（断开后 `childCount:4`）；**尾项③过渡区间**（1280 rail 232 / 860 rail 208 / 600 抽屉 / **500 `.tools .optional` 可见** / 480 隐藏；五档零溢出）；**尾项②运行态**（30 次开关零异常 + iframe 未重载 + 零 resize 帧；静态 `observe(header,{childList,subtree})`、`aria-selected` 仅剩注释）；**附带**注入样式零 `width-handle`（D3-F1 实机复核）。单测 **82 例**（实施记录原写 65/65 为沿用旧基线的笔误，验收时校正）、`ssh` **12/12** |
| 2026-09-16 | **SSH 线 U2 主体落地（多 shell / 工作区记忆 / 精确恢复）**：U2.1 身份分层（`connId → runtimeId → shellId`）+ 一次性 30s attach 票据 + 单写多读写权接管、U2.3 偏好与工作区快照拆两张据（`localStorage` v2 / `sessionStorage` v1，只在存活连接上重挂、绝不自动重连）、U2.4 官方 `@xterm/addon-serialize` 0.14.0 精确锁定 + 空闲 1.5s 采集快照（每 shell 128KiB / 500 行，不落盘）三路恢复。**§0 的 L1 行与 §1 表 ssh 行例数同步 70/82 → 110**（旧值停在 D4 批次，属文档欠账）；§3.6 标题扩为 `U0+U1+A0+D2–D4+U2`、新增 U2 四行实机验收判据与该节小结。单测 **110 例**（app 16 / client 25 / http 7 / runtime 22 / session 32 / store 8）、`ssh` **12/12**；端到端探针（真 sshd × 本线运行时）**9/9**；**回滚演练实际执行**（85/85 → 110/110）。U2.2 SFTP 与 U3 未动 |
| 2026-09-19 | **七线全量重跑定新基线（81 项检查，七线全 PASS）**：desktop 8 → **11**（新增「测试连通性 v2」host 插件 `plugins/dsh-model-probe` 的入口语法 2 项 + 连通性判定表 18 例；`cargo test` 10 → **19** 例，含 R5 桌宠 `Alert` 提醒模型 3 例）、ssh 例数 110 → **113**（U2 实机验收 4 处回归配套的 3 条新断言）、sidebar 例数 54 → **62**（`terminal-hub.test.js` 重写为多会话形状，7 → 15 例）。**sidebar 由 9/10 转 PASS**——`terminal-hub.test.js` 的受限沙箱假阴性已**根治**：`TerminalHub` 构造函数新增可注入的 `resolveBin`（默认仍是 `resolvePtyBin`，生产行为不变），测试不再碰宿主 shell（详见 §1 表下 ※※ 注记）。§0 的 L1 行同步（Sidebar 54 → 62 / SSH 110 → 113 / 补 Desktop 18+19）。**本轮另新增 §3.7 模型连通性探测实机判据**（desktop 线 `plugins/dsh-model-probe`：两段式探测 / 误报修复 / 错 key 零消耗 / 降级路径 / 无副作用）与 §2 的 `/model-probe-api/health` 自检行 |
| 2026-09-21 | **外观线 M2.5「软件头像」落地（本仓第一条 appearance × desktop 跨线能力）**：用户「外观设置里要可以设置软件头像」→ 澄清落点为**桌面壳启动器图标**（任务栏/窗口/托盘）。appearance 侧配置 v2 → v3（新增 `avatar.source`）+ `lib/avatar.js`（PNG 魔数 / data URL 解析 / 文件名白名单）+ 上传·清单·文件三条路由 + 面板板块（canvas 归一化 PNG ≤512）+ 契约 `avatar-host-stale`；desktop 侧新增 `src-tauri/src/launcher_icon.rs`（读同一份配置 → PNG 解码 → 中心裁方 + 盒式降采样 ≤256 → `window.set_icon` + `tray.set_icon`，1.5s 巡检跟随，失败一律回退出厂图标）。appearance **12 → 14 项**（+`lib/avatar.js` 语法；单测 60 → **81** 例，含同批次入库的 M2.6 面板风格契约 2 例）、desktop `cargo test` 19 → **25** 例、desktop 仍 **11/11**。契约文档 `appearance-launcher-icon-2026-09-21.md`，实机判据新增 **§3.5b**（上传→三处图标跟随 / 清单选择 / 清除回退 / 坏文件不崩 / 边界如文案）。**实机验收待用户重启 `dsh web` 与桌面壳后执行** |
| 2026-09-21 | **外观线 M2.6「面板风格对齐官方通用设置页」**（并行会话）：整栏面板重做为官方行式风格（0.5px 分隔线行 / 16px 行距 / 14px 标题 / 12px 说明 / 明暗立方 / 步进器），交互控件复用官方 primitives（前端壳 seed 模块，零新依赖），`.mia-*` 前缀 CSS 注入，行为逻辑零变化；配套风格契约测试 2 例。与 M2.5 同批次入库（同文件混改，无法文件级拆分；提交信息已如实记录两者） |
| 2026-09-21 | **外观线 M2.7「应用图标预设」落地**：用户给出参考截图要求「像这样的预设」→ 面板 `软件头像` 升级为 **`应用图标`** 网格。预设图标由本线**程序化生成**（新增 `lib/icon-presets.js`：手写 PNG 编码 CRC32 + `node:zlib`、SDF 解析式抗锯齿、圆角遮罩；**零第三方依赖、零图片资源**），骨架由 A/B/C/D 四版渲染目检定稿；「头像」为位图预设（用户提供的图：trim 黑边 → 居中裁方 → 512 → 圆角 → 量化，97 KB，资源入库 `assets/presets/`）。host 新增 `GET /appearance/api/presets`（**幂等落盘** `avatars/preset-<id>.png` + 清单）—— 预设与用户上传同源，**跨线契约零变更、桌面壳零改动**。appearance **14 → 16 项**、单测 81 → **91** 例。实机判据 §3.5b 增补四条（预设格出现 / 点选即用 / 位图预设 / 我的上传隔离）。**同日澄清收敛**：参考截图只是**形式**参照，其通用软件风格的多配色图标不适合本项目 → 初版七款（暗夜玻璃 / 素雅银 / 果冻蓝 / 缠线绿 / 蒙德里安 / 暖橙 / 流光）连同带出的 gloss / deco / marks 三项渲染能力一并撤掉，**最终只留两款（默认 / 头像）**；将来加款的配色应取本仓三主题语汇 |
| 2026-09-23 | **DSH 0.1.7-alpha.2 适配·dual-model 线**（commit `a956776`，版本 0.1.3-miasaki.0）：0.1.7 把 `settings/updated` 事件在全树移除（0.1.6 有 19 处 → 0.1.7 **0 处**），只剩 RAW 文档层的 `settings/document-updated`。新增 `lib/invalidation.js` 双轨监听（旧名在前、新名在后；cordis `ctx.on()` 监听无人发出的事件是无害空操作，两代宿主各自命中，无需版本探测），`index.js` 单监听改为 `ctx.effect(() => watchSettingsInvalidation(...))`。影响定级**低-中**（少一路缓存击穿信号，最坏 5 分钟 TTL 延迟，不报错）。新增 `test/invalidation.test.js` 5 例 → dual-model **10 → 11 项**、单测 24 → **29** 例。评估见 `../dsh-platform/dsh-0.1.7-upgrade-assessment-2026-09-23.md` §7.3 |
| 2026-09-23 | **DSH 0.1.7-alpha.2 适配·desktop 两插件 settings 读取双轨**（free-model-pool 0.3.1 / model-probe 0.2.1，当日线上实证两处坏死后闭环）：0.1.7 移除 `ctx.settings.get(ns)` 后——免费模型池 `/freepool-api/status` 原样返回 `ctx.settings.get is not a function`（设置页模型栏面板整块报错）；model-probe `resolveProfile` 被 try/catch 吞错 → 已保存行档案读不到 → 探测静默退化为 `no-credential`/`no-endpoint`。两插件各新增 `lib/settings-read.js`（`typeof settings.get === 'function'` 探针分轨：≤0.1.6 走 `get(ns)` 逐字旧路，0.1.7+ 走 `describe().find(d => d.ns === ns).value` 条目 Config 投影；写路径 `update(ns, patch)` 两代同名同义原样保留）。新增单测 **27 例**（helper 契约 + routes/probeModel 接线，fetch 打桩，双世界各一遍）→ desktop **11 → 17 项**、verify-all 81 → **92** 项。**实机待用户重启桌面端后验收**（§3.7 增补两条：免费模型池面板列平台 / 已保存行测试连通性走真实探测） |
| 2026-09-23（晚） | **六补丁全量重打至 0.1.7-alpha.2 + attachment 补丁入回归**（「各条线适配状况」核查的收口）：本机全局 DSH 已实装 0.1.7-alpha.2（早于评估文档触发的 `0.1.7-rc.*` 条件），六个旧基线补丁（desktop 五件 + dual-model 图片准入一件）在 live 安装目录全部 `unknown`（升级覆盖、从未重打）⇒ 逐个 `rebuild-baseline` → 同步三常量 → `verify` → `apply`，**`EDITS` 全部零改**（settings-models 的双代变体 probe 自动选中 0.1.6+ 分支；图片准入锚点 `:780` 唯一命中、`expect` 两行逐字未变，走 `seal` 流程）。live `status` 全部 `patched`（`.dsh-bak` 留 0.1.7 原版可回退）；第三方 `@yeesy369/dsh-browser-playwright` 0.8.1 的本地双半补丁**已在场**（client/host 双 PATCHED，不打它 web UI 连启动屏都过不去）。`verify-all.mjs` 补入 attachment 补丁检查位（此前唯一未纳入统一回归的补丁）→ desktop **17 → 18 项**、全量 **93** 项、七线全 PASS。**生效面**：client 侧四个（settings-models / conversation / trajectory / chat）刷页面即生效；**host 侧两个（cordis-host-runner + 图片准入）需重启 `dsh web`**（重启会断开当前 harness 会话，留用户方便时执行）。逐项 SHA 与机械流程见 desktop 线 `design/CHANGELOG.md` 同日条 |
| 2026-09-23（深夜） | **补丁 live 状态一键审计 + 两处补丁缺陷修复**（本日教训的收口：离线全绿与 live 全 unknown 曾并存数日，功能静默缺失无告警）：新增 `scripts/patch-live-audit.mjs`——进程内 import 七个补丁的 `classify` 逐個分类 live 文件（不 spawn，沙箱安全），判两档：live 版本 == baseline 却未 patched → 🔴 回归（退出码 1）；版本漂移导致未打 → 🟡 待重打（退出码 0）。本机现状 7/7 patched。顺带修复：① **attachment 补丁缺 import 守卫**（`import.meta.url` 卫士，其余六件都有）——任何 import 它的工具都会以调用方 argv 误跑一次 `status`，污染输出并可能改写调用方 exitCode（本审计开发时实际踩到）；② dual-model 补丁补 `export const TARGET_RELATIVE = join('lib','index.js')`（与 host-runner 同契约，此前审计只能猜目标文件）。两补丁 `verify` 复跑 PASS、desktop 线 **19/19**（含 cargo 28 例）不变 |
| 2026-09-24 | **启动加载 S4a 视觉层落地**（boot-loading-terminal.md §9.1，用户「太简单……酷炫一点」的无 Rust 依赖部分）：`ui/loading.html` 三纹章外环缓旋 24s + 呼吸光晕 3s（`var(--mia-accent)` 零新增色）+ 舞台扫描线 4s/opacity .06 + 就绪纹章回弹 1.06/600ms（`__setStatus` 文案派生触发，`__setReady` 显式钩子预留）+ reduced-motion 全量静止；纯 CSS transform/opacity、零 JS 动画循环。新增 `ui/test/loading-visual.test.js`（动画属性白名单 / 零字面量新色 / 降级全覆盖 / 类名纪律 / 标记结构 / VM 驱动就绪触发幂等）接入 verify-all → desktop **20 → 21 项**、全量基线 **96 → 97 项**（desktop 21/21 PASS，含并行会话 dot.rs 重构后 cargo 35 例）。§3.1 增实机判据一行（三主题目检 / 就绪回弹 / 降级 / 失败零回归）。S1–S3（闪窗根治 + stdout tee + S4b 日志流/阶段进度）未动 |
| 2026-09-24（同日续） | **S4a-2 启动计时 + verify-themes 早死诊断**：① 冷启动 3~6s / 失败最坏 90s 只有静止文案 → 纯页面侧加 `#boot-timer`「已等待 N s」诚实读数（250ms tick、tabular-nums、就绪即停、失败继续走表；不出假百分比）→ loading 测试 8 → **10 例**；② `verify-themes.mjs` 排查「无头 Edge 起不来」归因——旧代码空转 30s 才报 `CDP target not found`，实测**环境性阻塞**（DSH 沙箱 workspace-write 限制 GUI 子进程创建：headless Edge ≈3s 退出、code 0x80000003，`--no-sandbox` 无效），改为即时诊断（0.6s 给出「普通终端或 danger-full-access 会话运行」结论），P3 该项标注为环境限制而非脚本缺陷 |
| 2026-09-24（续） | **桌宠资产链完整性闸门**（2026-09-10「删素材静默断链」教训的常态化）：新增 `dsh-miasaki-desktop/scripts/check-pet-assets.mjs` 并入 verify-all（desktop **21 → 22 项**、全量 **97 → 98 项**）。守三事：frames.json 引用齐全（缺=运行时该姿态空白）、再生源在位（kurumi 图集 / whale idle.gif / inverse raw 立绘——源缺则下次重生成静默跳过，断链延迟暴露）、无孤儿派生（重切残留 drift）；状态覆盖缺口（R15：whale/inverse 七个姿态回退 idle）与源派生新旧只提示不判失败。故障注入四分支自证（删引用帧/删源 → FAIL exit 1；孤儿 → WARN exit 0；原样 → PASS）。**首跑即抓到两条现存问题**：① `ui/pets/whale/states/idle.png` 孤儿（v2 六帧化后的单帧残留，assets.rs 仍嵌它，全仓无引用——留待桌宠资产负责人处置，未越权删）；② kurumi 新图集（00:04 更新）比派生帧新——重切未跑的工作流提示 |
| 2026-09-24（三轮复审） | **文档基线归位 + 两处 P3 断言修复 + live 审计纳入第八件补丁**：第三轮独立复审复跑实测 **98 项 / desktop 22 / `cargo test` 35**，与文档口径 96/20/28 矛盾且与本文档 §1 历史行自相矛盾 ⇒ §0 L1 行与 §1 表头、desktop 行同批校正为现行基线（**历史记录行的旧数字一律不改写**，只在最新基线块标注现行值）。`ui/loading.html` 就绪正则死分支码位 `\u5c31\u7ed3`（就结）→ `\u5c31\u7eea`（就绪），测试错字同步 + 新增「**仅**『已就绪』」区分力用例；`ui/test/loading-visual.test.js` 性能预算改为按花括号深度配平取**整块**（原先只截到首个 `}`，第二个及以后 stop 的布局属性全漏）。两处均做变异自证（回退即红）。**审计盲区收口**：`scripts/patch-live-audit.mjs` 新增 `shared-docs` 补丁根 + 多目标契约 `LIVE_TARGETS` + 每个 profile 的 `<profile>/node_modules` 探测 ⇒ 本机 **9 个目标 / 8 件补丁全 patched**（第八件 `@yeesy369/dsh-browser-playwright` 双半各一行；假 profile 根注入原版 → client 行判 `original … 回归！` + 退出码 1，host 仍 patched）；该补丁同批补 `import.meta.url` CLI 守卫与 `LIVE_TARGETS`，其 `verify` 的 `spawn EPERM` 由「语法校验失败」改为诚实 ⚠（shell 层 `node --check` 双半 exit 0 复核）。`00-boot` 兜底链对 `dsh-auth-*` **非 HttpOnly** 的隐式依赖，已在 desktop 线 `design/auth-cookie-prepinject.md` §3 钉为显式契约 |
| 2026-09-24（拖拽上传实施） | **拖拽上传附件到会话 S1–S3 落地**（用户点名需求，`design/drag-drop-attachment-upload.md` 定稿后实施）：S1 `main.rs` 主窗 `.disable_drag_drop_handler()`（cargo check 通过）；S2 `themes/src/09-dropguard.js` 安全网新片 + MANIFEST.order 登记 + gen-init（10 片/87KB/令牌校验过）+ `themes/test/dropguard.test.js` 4 例（登记/产物含片/三判据/自包含形态）；S3 `ui/loading.html` 最小防默认（判据与注入层逐条一致，loading 测试 10 → **11 例**）。官方上传链路全量复用、壳侧零业务逻辑。`verify-all` desktop **22 → 23 项**、全量 **98 → 99 项**。实机验收十项（§3.1 新行）待用户重启桌面壳执行 |
| 2026-09-25 | **sidebar 右栏终端退役（v0.10.0-miasaki.0，用户拍板「沿用官方策略」）**：0.1.7-rc 线官方右栏已内置终端（多标签 / Shell 选择 / 刷新恢复），本项目不再自建右栏终端——`client.js` 注销终端 tab 类型（kind `miasaki-terminal`）、删除 `TerminalTab` 组件与 `.dsh-sidebar-term*` 样式、跨容器移位菜单与右栏 `×`，`active` 收敛为 `{ bottom }`，React 快照机制随唯一消费者一并删除；**host 半零改动**（TerminalHub / WS / 路由与容器无关）。§3.4 标题与表项改版：「入口胶囊」由两个改一个、「终端 tab」行改为「底部终端面板」行（含多标签与刷新恢复判据）、「插件加载」版本号改为跟随现行版。sidebar 单测 **57 通过 / 5 环境跳过**（62 项总数不变）、`verify-all sidebar` **10/10**。**实机待重启 `dsh web` 验收**：引导页只剩「审查」；底部面板全能力不变；历史 localStorage 旧终端 tab 记录恢复时落官方终端（一次性，关掉重开） |
| 2026-09-26 | **新增第八线 `dsh-miasaki-usage`（用量统计由 desktop 线迁出）+ 账本按 profile 分区**（用户澄清「干净接入是指**统计要干净**，官方桌面端统计只记载官方消耗」）：`git mv dsh-miasaki-desktop/plugins/dsh-token-monitor/ → dsh-miasaki-usage/`（9 文件全部 R 重命名；desktop 线插件数 5 → 4）；**账本与限额按 profile 分区**（`~/.dsh/plugins-data/dsh-token-monitor/<profile>/`，profile 名取宿主 `profileContext.name` → `DSH_PROFILE` → `default` 软降级），分区前的混合账**一次性归位**到 `miasaki/`、官方桌面端从零累计；装法 `file:` → `link:`（官方 desktop / web / miasaki 三处同改，实测旧副本 `client.js` 已落后源码 262 B）；`verify-client-bundle --sync` 语义改为**核对安装点**；`dedupe-usage-ledger.mjs` 增 `--profile`；**`verify-all` 七线 → 八线**（`usage` **3/3**）、§0 L1 行与 §2 同步、**§3.8 新增实机判据七项**。验证：探针 profile `--dump-config` **1290 行**里 `token-monitor` 3 处、其余自制插件计数全 0；分区逻辑离线冒烟（双假 profile 各建独立分区、旧账本 3,419,757 B 零改动）；`usage` 3/3 PASS |
| 2026-09-26（桌面端启动故障） | **`miasaki` 桌面端停在启动屏：第三方补丁被 profile 重装冲掉 + 补丁工具只认单 profile**（用户报「miasaki 桌面端打不开了」）：现象与 2026-09-23 的 0.1.7 事故**逐字相同**（`web boot: 1 entry did not activate` / `@yeesy369/dsh-browser-playwright: pending (waiting for service: settingsScope)`），但成因不同 —— 壳走 `dsh --profile miasaki`（`backend_profile_name`），而该插件双半兼容补丁在 09-26 10:43 **该 profile 重装依赖时被覆盖**（两半哈希回到 baseline 原版 `0DA733A8…` / `3FDFD5BB…`；`web` profile 补丁仍在场 `AC63F3AD…` / `B859A6C3…`，故只有 miasaki 桌面端打不开——官方桌面端与浏览器 GUI 都正常）。**结构性原因**：`patch-live-audit` 的判据本就是对的（当时即报 `original … 需重打`），但 `patch.mjs` 的自动探测**只认 `web` 一个 profile** ⇒ 修复动作天然漏掉 miasaki。**处置**：① 给 miasaki 重打两半；② `patch.mjs` 探测改为**遍历 `~/.dsh/profiles/*` 中所有装了本插件的 profile**（status / apply / revert / rebuild-baseline 全覆盖；`--target-dir` 退化为单目标；`DSH_PROFILE_DIR` 显式优先），顺带修掉 `smokeHost` 里遗留的 `detectTargetDir()` 单目标引用（verify 会即时炸出来）；③ 补丁 README 增「多 profile 语义」与二次复发记录 + desktop 线 `design/CHANGELOG.md` 同日条。**自证**：`patch.mjs verify` **VERIFY PASS（27 项）**、`status` 两 profile 双半 **PATCHED**、`apply --yes` 两 profile 幂等跳过、`scripts/patch-live-audit.mjs` **9 个目标 / 8 件补丁全 patched**；**端到端**：`dsh --profile miasaki --no-open --port 3099` + 无头 Edge 实载 ⇒ 启动屏消失，会话列表 / 插件入口 / SSH 胶囊 / 模型选择正常渲染（`_refs/scripts-archive/bootcheck-miasaki-20260926/boot.png`）。**纪律**：任一次 profile 依赖重装后必跑 `node patch.mjs apply --yes`（补）与 `node scripts/patch-live-audit.mjs`（验） |
| 2026-09-26（会话隔离） | **会话记录按 profile 隔离**（用户「如果不能实现之前的会话分类，至少现在开始 miasaki 和 dsh 的会话得隔离开吧」）：会话 header 只有 `cwd`/`createdAt`/`agentPreset`、**无来源标记** ⇒ 历史无法事后分类，只做「从现在开始隔离」。官方 `dsh-base` 的默认 `root: !!js dshHomePath('sessions')` 是**与 profile 无关的全局目录**（三个 profile 混写一处），`root` 为单值、列表直接枚举它 ⇒ 只给 `miasaki` profile 补丁层覆写为 `profiles/miasaki/sessions`，**官方 `desktop` profile 一个字节未动**（`8948F53D…` / `963CB662…` 前后一致）；历史**整体复制**一份（8 项目目录 / 231 会话 / 约 220 MB，canvas 引用的老会话照常可开）。**实机双向验证**：捕获 180 个会话 id 中 **179 个属新 root**（唯一例外经上下文核对出自 canvas 工作区数据）；后端运行期新建会话**落新 root**、同期全局 root **零新增**；`--dump-config` exit 0、插件树无未激活项。**§3.9 新增**（含「差分标记」判据设计与操作纪律三条）。**踩坑入纪律**：PS here-string 的反引号是转义符，注释里的 `` `root: `` 变成 CR+`oot:` 把 YAML 劈坏 —— 离线 YAML 校验**漏掉**（CR 仍在注释行内）、`--dump-config` 抓到 ⇒ ① 别用 PS here-string 拼含反引号的 YAML ② 补丁验收必走 `--dump-config` ③ **`--dump-config` 会重写该 profile 的 `cordis.yml`，不是只读操作** |
| 2026-09-26（晚） | **两条既存缺陷闭环（用户点名「一并处理」）**：① **canvas 会话布同步恒 400** —— `POST /canvas/api/sessions/sync` 每次发**全量**会话列表，本机 239 个会话 ≈ 40KB 越 `MAX_BODY_BYTES = 32KiB`（≈190 条即越界），于是每次同步都 `请求内容过大`，而 client 侧的空 catch 把它吞得一干二净（画布里 DSH 节点长期不更新却毫无信号）⇒ 该路由独占 `MAX_SYNC_BODY_BYTES = 2MiB`（其余 CRUD 路由仍守 32KiB）、超限报错带**实际字节数与上限**、client 端两条失败路径限频留痕一次。实测：**64,129 B 的 POST 由 400 转 200**，无头实载 4xx 归零。② **`dsh-session-log-move` 启动警告**（`slot "conversation.session.header.utilities" is not declared`）：查实 `dsh.client.inject` 只保**模块加载顺序**，而 0.1.7 的槽声明是**多级异步链**（`conversation` 自己也在等父槽声明），插件 apply 时的同步 register **必然抢跑**；且该 id `session-log-download` 自 0.1.5-rc.1 起由官方 `dsh-session-log-export` 占用，同 id 替换**永远冲突** ⇒ 删除这条注定失败的死路（`inject` 去掉 `slots`，DOM 隐藏成为唯一路径）。**附带查明**：0.1.7 官方已把该入口改成「更多操作 ⋯」菜单（`aria-label="更多操作"` 的 `Menu` 锚点），头部**根本没有可隐藏的胶囊** —— 插件的「搬走入口」目标已由官方演进自然满足，`[class*="sessionLogButton"]` 锚点在 0.1.7 全库零命中。`verify-all` desktop **30 → 33 项**（语法 2 + 契约测试 4 例）、canvas 用例 96 → **98**、全量 **107 → 113 项**八线全 PASS（`cargo test` 实测 **81 例**）。实机：`dsh --profile miasaki --no-open --port 3099` + 无头 Edge ⇒ 启动屏消失、**console 错误 0 / 4xx 0**。证据 `_refs/scripts-archive/bootcheck-miasaki-20260926/` |
| 2026-09-26（深夜·续） | **验收债务可度量 + dual-model 补判据节 + 仓库级治理闸门入回归**（用户对上一轮报告的判断直接驱动，四项建议的落地）：① **新增 §3.0 实机验收台账（可勾选）** —— 此前本文件 checkbox 数为 **0**，「六条线的实机验收全部积压」在文档里**不可见**、也没有任何机制保证它会发生；现按 A–G 七组登记 **38 项**（SSH 11 / 双模型 3 / Sidebar 5 / 外观 6 / 桌面端 8 / Canvas 2 / 跨线 3），状态 **0 / 38**，勾选口径与前置写在该节。② **新增 §3.10 双模型判据节**（8 行）—— 本线 2026-09-10 就完成 M1，却始终没有验收节，**等于没有判据**（评审连续两轮点名）。③ **`verify-all` 新增仓库级类别 `repo`**（2 项，跨八线、不属于任何单线）：**`silent-guards`** ——「守卫必须显式失败」闸门，四类形态 R1 静默跳过守卫 / R2 构建链静默吞错 / R3 静默回退读取 / R4 声明清单缺口；**存量 58 类冻结在 `scripts/silent-guard-baseline.json`（是债不是背书），新增即失败**，`// guard-ok: <理由>` 可就地豁免；**闸门首跑即抓到真缺陷**：`appearance/package.json` 的 `files` 缺 `assets/`，而 `lib/icon-presets.js` 引用 `assets/presets/*.png`（位图预设会在安装时静默丢失）→ 已修。故障注入自证：无豁免注入 → exit 1 且点名位置，加豁免 → exit 0，清理后归零。**`doc-versions`** —— 根 README 的版本台账（新增 `<!-- version-ledger -->` 块）与八线 `package.json` 逐字一致；故障注入（Fleet 改 0.19.0）→ exit 1，`--update` 精确修回。④ **fleet-monitor 补三道信任围栏**（此前是全仓唯一「写接口零鉴权 + CORS 通配 `*`」的组合；新增 `fleet-monitor/fence.cjs` + `tests/fleet-monitor.test.mjs` 11 例，`server.js` 改为 `handleRequest` 具名 + `require.main` 守卫以便单测，围栏排在**所有**路由之前、被拒响应不带任何 CORS 头）→ **fleet 15 → 17 项**。⑤ **CI 注释「七线」→「八线」**（5 处：文件头 / job name / step name / 质量闸门注释 / 引述草稿处加注当时线数），依赖分布清单补 `usage`，并删掉写死的 desktop 分子分母（注释比代码先过期）。⑥ 落地根 **`.editorconfig`**：默认 LF + UTF-8 无 BOM + 末行换行 + 2 空格；**例外只给会被外部工具写回 BOM 的 fleet 产物**（10 个 BOM 文件全在其中），存量 17 处 CRLF **不批量转换**（零语义 diff 会淹没真实改动）。**全量回归 113 → 119 项，八线 + repo 全 PASS**（`cargo test` 实测 **85 例**，本节 §1 的 desktop 行旧值 79 已校正；ssh 由 diagnose 新增 2 项检查 12 → 14，故本行总数含 ssh 增量） |
| 2026-09-26（深夜·续三） | **外观线与官方「通用」设置页对照去重**（用户「通用设置里有的，外观设置就不需要有了」）：官方「通用」页（`settings.general.item` 槽）逐行取证 6 行——`language`(0) / `appearance`(10，浅·深·跟随系统) / `font-size`(11) / `transcript-view`(12) / `composer-enter`(20) / `permission`(-20)，其中**明暗偏好与正文字号**与外观页重合（M1 起的「同一 `ctx.theme` 偏好第二入口」）⇒ **两行整行移除**（不做只读回显），「主题」组只留官方三立方没有的「皮肤」；连带删除 `config.theme` 的 `scheme`/`accent`/`fontSize` 三个镜像死字段（`accent` 从未接 UI）与无消费者的 `data-mia-scheme` 属性，配置 **v3 → v4**（删字段无需搬运）。单测 98 → **100 例**（新增「与通用页不重复」去重闸门：面板不渲染「正文字号」/「跟随系统」文本、无 `.mia-cube` 节点、无 `px` 单位节点；另 5 处渲染夹具 theme 瘦身 + stateQueue 少一格 themeFacts）；`appearance` 仍 **16/16**。设计（D1–D5 决策 + 「上新设项先过通用页对照」纪律 + M3→Boot Splash→M4 推进路线）见 `dsh-miasaki-appearance/design/2026-09-26-appearance-page-dedup-and-roadmap.md`；§3.5 两行判据改写为「与通用页不重复」+ 皮肤行 + 配置版本行，§3.0 台账外观 **6 → 7 项**（新增 **D7 去重复核**）。**实机待用户重启 `dsh web` 后验收** |
| 2026-09-26（深夜·续四） | **外观页 V1 视觉统一实施**（用户「不够美观、和 dsh 设置页设计语言不够统一、功能也不完善」→ 拍板「只做 V1」）：根因是**控件形态选错**——官方设置行的单选标准控件是**选择丸 + 下拉菜单**（`LanguageRow`/`PermissionRow` 的 `.selector` + 官方 `Menu`），本线却用一排 Pill（官方 Pill 是 view switcher/filter 用语，长文件名一多就换行）。四处单选（皮肤 / 壁纸图源 / 玻璃档位 / 我的上传）全换**官方选择丸 + Menu**（h36/r18/module 底/右缀 `IconChevronDownOutlineRegular`，菜单项 = 配置白名单，长值 title 给全名）；九宫格换官方卡片语言（r16 + border-l4）；表面四旋钮换官方双列字段网格（models `modelAdvanced` 规格）；M3/M4 占位换官方 dashed 卡；运行信息收敛为面板底部一行；Pill 整类退场。行为逻辑与配置零改动；单测 **100 → 101 例**（新增 V1 控件闸门：三个 Menu 在位 + 菜单项 = 白名单 + 无 `.mia-picker` 复活）；`appearance` 仍 **16/16**。§3.5 皮肤行与新增「控件形态（V1）」行给出实机判据。**实机待用户重启 `dsh web` 后验收**（四个选择丸开合 / 菜单键盘 / dashed 占位 / 三主题）。设计与 P1–P6 功能路线见 `dsh-miasaki-appearance/design/2026-09-26-appearance-visual-unification-and-roadmap.md` |
| 2026-09-27（P2 Boot Splash 实施） | **外观线 P2 Boot Splash 首帧启动画实施（S1–S4）**（用户「p2 开工」；同轮反馈「外观设置开启了没什么效果」——诊断结论见 §3.5 下方注）：皮肤停在「纯净」= 原生配色（设计如此），壁纸被 100% 不透明的官方表面挡住，且 `mica` 档在 Win11 桌面壳下走系统云母（`data-mia-native-mica="on"`）时页面侧模糊被 W4.2 规则关掉 ⇒ 可见变化趋近零；**见效需换皮肤 / 玻璃换 frost·light / 表面不透明度降到 60–80**（配置已真实生效，`data-mia-*` 属性与注入行经盘上配置复算确认在场）。实施：**S1 取证** vendor `injections.ts` 六 kind 与 placement 并用官方同款渲染逻辑离线端到端验证本线五行落点；**S2** 新增 `lib/splash.js`（style/html/script 三纯函数 + 门控：颜色全部 var() 经 body 继承、明暗跟随官方属性切换，纹章双环 zafkiel 顺 / kurkuriel 逆 / pure 静止，三点流动，reduced-motion 全静止，退场双信号 + 2.5s 超时 + 幂等）；**S3** `index.js` 注入三行（**首次启用官方 `html` 行 kind**），配置 **v4 → v5** `motion.bootSplash`；**S4** client `apply()` 调 `__miaSplashExit()`。单测 **101 → 111 例**（splash 8 + host +2 + config 迁移断言）、`appearance` **16 → 18 项**、`repo` 2/2。§3.5 新增 Boot Splash 两行判据（出现/淡出 + 401/关掉即原生硬用例）。**S5 实机待用户重启 `dsh web` 后验收** |
| 2026-09-27（M3 动效实施） | **外观线 P1 M3 动效实施 + 「无可见效果」提示**（用户「继续推吧」）：① 面板——「动效」组从占位灰字升级为真控件（官方 Switch 总开关 + 预设选择丸「流畅/优雅/极简」+ 强度步进器 0.5×–1.5×），`masterSwitch` label 参数化（两个开关各带无障碍名）；② 动效层——**纯 CSS**（`--mia-mo-*` 变量，配置只改变量值不重写规则）：会话大表面 medium 420 档 / 侧栏·右栏·设置面板 standard 300 档的容器入场（位移 4–12px + 缩放 0.97–0.99，禁「只有 opacity」与 linear），`prefers-reduced-motion` 降级 100ms 淡入，门控 `enabled && motion.enabled`、关闭即整层移除，**不碰官方 transition**；③ 消息级错峰贴类器留 M3.1（`.mia-mo-tagged` 槽位 CSS 已在层内——官方消息行 DOM 形状未知，错贴会让流式每帧重放，不做没把握的 JS）；④ 「无可见效果」提示——纯净皮 + 全不透明表面 + 云母走系统材质时，面板顶部官方 notice 规格指引用户改哪里。单测 **111 → 114 例**（client 17 → 20）、`appearance` 仍 **18/18**、`repo` 2/2。§3.5 新增动效两行判据（控件/入场 + reduced-motion 降级硬用例）。**实机待用户重启 `dsh web` 后验收** |
| 2026-09-27（M4 会话效果实施） | **外观线 P3 M4 会话效果实施**（用户「继续推进外观线」）：「会话效果」组从虚线占位升级为**六行真控件**——消息密度（舒适/紧凑）、会话最大宽度（步进器 0–1600px）、正文字体（默认/衬线/等宽）、流式光标（Switch + 细条/方块/下划线）、引用与代码块（默认/简约/强调）。全部经**官方 CSS 变量与属性锚点**落地（vendor 取证，不碰官方类名与 transition）：密度 = `--dsh-chat-flow-gap`（ChatView 消息流间距）、宽度 = `--dsh-chat-content-width`（覆盖在 `data-chat-flow` 上赢 `.body` 官方定义；接管期间官方拖拽手柄让位，改回 0 交还）、字体 = `--dsw-font-family`（slot 限定只影响会话正文，**官方字号 `--dsh-content-font-size` 一行不碰**）、光标 = `[data-streaming]` 官方流式属性 + 品牌静态端取色、引用/代码块 = markdown 原生 `blockquote`/`pre` 语义标签；`prefers-reduced-motion` 禁闪烁。原生档（comfortable/system/off/default/0）一律不写属性 ⇒ 规则不命中 = 官方观感；总开关关闭三层全清。**范围决策**：路线里的「工具卡折叠」未纳入——官方工具卡展开是受控 React state（`ui-tool/ToolRow` 的 expanded prop，非原生 details），默认折叠属产品行为决策而非外观参数，留待单独取证。配置 **v5 → v6**（conversation 新增 font/cursor/quoteCode，纯新增）。dashed 占位整类退场（无消费者）；`stepper` 加可选单位参数（× / px 收进控件内）；去重闸门的 px 判据收紧为「字号步进器不得复活」（宽度行的 px 是正当消费）。单测 **114 → 120 例**（client +3：CSS 合规/六行控件/三态行为；config +3：白名单收窄/v5→v6 迁移/单字段深合并）、`appearance` 仍 **18/18**、`repo` 2/2、doc-versions 一致。§3.5 新增 M4 两行判据、§3.0 台账新增 **D8**（1/47 → 1/48）。设计（取证表 + 决策 D1–D4 + 范围）见 `dsh-miasaki-appearance/design/2026-09-27-appearance-m4-conversation-design.md`。**实机待用户重启 `dsh web` 后验收**（与 M3/P2 同批） |
| 2026-09-28（第九线迁出） | **免费模型池由 desktop 线迁出 → 独立第九线 `dsh-miasaki-free-model`（更名 + 信任围栏）**：`git mv dsh-miasaki-desktop/plugins/dsh-free-model-pool/ → dsh-miasaki-free-model/`（**9 文件全部识别为 R 重命名**；desktop 线插件数 5 → 4），同批更名 `dsh-free-model-pool` → `@miasaki/dsh-free-model`（路由前缀 `/freepool-api/*` → `/freemodel-api/*`、槽 id `free-model-pool` → `free-model`、版本 0.3.1 → 0.4.0）。**迁出理由三条**：① 职责不属于桌面壳（与 usage 2026-09-26 迁出同构）；② 名字装不下"多来源聚合"新定位（还要收编免 Key 车道）；③ **一条真实安全债** —— 4 条 exact 路由不过内核 `/api` 准入链，而 `/apply` 是**写配置**动作、`/subagent` 改预设文件。**同批补围栏** `lib/trust.js`：composition 的 `connection.requestRejection` 优先且**逐请求读取**（禁 apply 时快照——服务可能晚 provide），缺席时结构层复刻（回环 Host / 拒跨站 `sec-fetch-site` / Origin·Referer 与 Host 同名 / **Host 缺失 fail closed**）；接入点顺带把 `registerRoute` 改为 `(method, path, handler)`，**围栏先于 method 检查**（跨站 POST 得 403 而非 405，有专门断言）。**`verify-all` 八线 → 九线**：新增 `free-model` 类别 **7 项**（3 语法 + trust **15 例** / client-bundle **4 例** / settings-read 10 例 / routes 5 例；**同日晚 M1 起为 10 项** —— 加 `lib/profile.js` / `lib/scan.js` 语法与 `scan.test.js` 15 例），原 desktop 类里的 4 项随迁；`check-doc-versions` 台账 9 条；`silent-guard-baseline.json` 冻结项路径同步为新线路径；根 README 线表加第九线与 9 处"八线"文案更新。`miasaki` / `web` 两个 profile 的依赖键、`file:` 路径与 bundles 同批更新并已 `pnpm install`（`node_modules` 为 junction → 新线目录）。验证 `[实测]`：`verify-all free-model` **7/7 PASS**、`repo` **3/3 PASS**、四份单测 **34 例全绿**。跨线规划（M0–M4、来源①免 Key 车道的官方契约取数、与第三方插件的边界与不做的事）见 `cross/free-model-unified-page-2026-09-28.md`。**实机待用户在 miasaki / web profile 重装依赖后验收**（包名与路径同批变更，装法 `file:` → `link:`；**两个 profile 已重装完成**，`node_modules` 为 junction → 新线目录） |
| 2026-09-28（第九线 M1） | **扫描面升级到官方 `llm` 契约 —— 多来源聚合从设计变成事实**：新增 `lib/scan.js`（来源 A：`llm.listProviders()` → 逐 provider `listModels()` → 逐 model `resolveModelInfo()`；**逐 provider 隔离失败**进 `partial[]`、逐调用超时、解析缓存 + `refresh` 清缓存）与 `lib/profile.js`（**画像唯一实现**：端点方言与适配器方言共用 `buildProfile()`，避免两个来源给出互相矛盾的 verdict）；免费判定加 **L0 provider 级免 Key 车道**（id/显示名命中 `/free/i`，**刻意不硬编码任何插件名**；L0 来源带 `writable:false` —— 免 Key 车道靠上游指纹计额度，不该被写进 `llm-pi-ai.providers`），L1 后缀扩为 `:free` / `-free`；新增 `POST /freemodel-api/scan`（三类来源 `adapter` / `pi-ai` / `draft`；按 `provider` 过滤时**只扫那一个**，不让未被请求的 provider 失败污染 `partial`）；`/status` 加 `kind`·`providerRoute`·`freeLane`·`writable`，`/detect` 条目加 `freeReason`·`source`·`writable`，排序与决策摘要抽成两来源共用的 `sortModels()` / `summarize()`。**能力归因纪律**：适配器自述**不提供** `supported_parameters` ⇒ 工具能力标 `toolsUnknown`、`canAgent` 保持 false 但 verdict 明写「需实测验证：该来源不声明工具参数」——**不猜一个 false 了事**。测试 `test/scan.test.js` **15 例**；`verify-all free-model` **7 → 10 项**。实测 `[实测]`：`scan` 15/15、`routes` 5/5（重构后行为不变）、`free-model` 10/10、`repo` 3/3。**实机待验**：重启 miasaki 桌面端后 `POST /freemodel-api/scan` 的 `models[]` 应含 `our-free-model` 的 11 个模型（`source:"adapter"`、`writable:false`、`freeReason` 含「免 Key 车道」） |
| 2026-09-28（第九线 M2） | **统一页三区 + 模型页就地入口（footer 双路退役）**：主页面从 `settings.models.footer`（模型页底部，M0 沿用的双路注册）**改为 `settings.section`**（id `free-model`、order 25、label「免费模型」）—— 三区面板是完整一页、不该塞在别人页面底部，而"在模型页就手"由新落点更好地满足；**删掉 5 s 延迟判定 + inject watcher 兜底那套装载竞态规避**（少一条回退路径 = 少一个失败模式）。新增**官方 keyed 槽 `settings.models.provider-card`** 的就地入口：官方模型页每张 provider 卡片下多一行「扫描该提供方的免费模型」＋命中数与模型 id（实装取证 `dsh-client-ui-settings-models:2393-2397`，目录行字段 `:1141-1161`）；注册**数据驱动、不硬编码插件 id** —— 先注册空串 key 兜底（官方对"注册了适配器但不在目录里"的 provider 用 `settingsNs: ""` 派发），再按 `/scan` 返回的 `settingsNs` 逐个注册；拿不到路由 id 时组件返回 `null`（宁无入口，也不在别人的卡片里抛错）。**样式改走官方主题令牌** `--dsw-alias-*`（清单取自 `client/Theme.listTokens` 实测 14 个），M0 的内联色值全部退役。`client-bundle.test.js` **4 → 7 例**（新增 section 落点 / provider-card 空串 key / 不再注册 footer / 令牌与无写死色值四类断言），本线五份测试合计 **52 例**。实测 `[实测]`：五份测试 15/15 · 15/15 · 7/7 · 5/5 · 10/10，`verify-all free-model` **10/10**（项数不变，测试文件数未变）。**实机待验**：设置左栏出现「免费模型」三区页；模型页 Our Free Model 卡片下出现就地入口；切换明暗主题时面板配色跟随（令牌生效判据） |
| 2026-09-28（第九线 M3） | **实测接 model-probe + 默认模型走官方写路径 + 子代理指派核实**：① 模型卡新增「实测」按钮 → `POST /model-probe-api/probe`（两段式：零 token 握手 + 1 token 生成），结果就地显示 kind 与耗时；**探活门控** —— 进页面先 `fetch('/model-probe-api/health')`（裸 fetch，因为 `api()` 要求信封 `ok` 而 404 不是那个形状），`dsh-model-probe` 缺席就整块隐藏按钮，不给用户一个点了报 404 的按钮。② 新增 `GET\|POST /freemodel-api/default-model`：读 `agentDefaultModel.currentSelection()`、写 `saveSelection({provider, model})` —— **官方写路径、下一次会话立即生效**，与 `/subagent` 的文件级改写是两回事；四种失败形态（服务缺席语义化错误而非 500 / 读失败按"读不到"处理 / 参数不合法不碰服务 / 官方抛错原因透传）各有断言。③ **核实结论**：`subagentModelSelection` 服务**只有只读 `current()`、没有写路径**，故 `/subagent` 保留文件改写（并把这条写进 README，标出"预设组合包化时要重做"）。④ 为测试做的小改动：`registerRoute` 把 `method` 挂在生成的 handler 上 —— `default-model` 同路径按 GET/POST 注册两条，离线测试路由表若只按 path 建索引会拿到错的那条（第一版新测试正是这样"通过"了错的 handler），生产行为零变化。测试：新增 `default-model.test.js` **7 例**、`client-bundle.test.js` **7 → 8 例**（新增 M3 接线 + 探活门控正则），本线六份合计 **60 例**；闸门 `free-model` **10 → 11 项**。实测 `[实测]`：六份测试 15/15 · 15/15 · 8/8 · 7/7 · 5/5 · 10/10，`verify-all free-model` **11/11**。**实机待验**：模型卡「实测」给出"可用（…）+ 耗时"且未装 model-probe 时按钮不出现；「设为默认」后新建会话的选择器默认模型就是它 |
| 2026-09-28（第九线 · 白屏事故复盘） | **「点供应商编辑就白屏」查清了：不是本线造成的**（用户报障时我刚动过模型页，第一反应认定是自己的锅、先撤了代码）。**取证**：起临时 host（web profile）+ playwright 自动化复现「设置 → 模型 → 点编辑」—— **撤掉本线 occupant 后仍崩**（同一错误）；崩点是 `TypeError: (0 , react_jsx_runtime.jsx)(...) is not a function` **at `ModelListEditor`**（官方 `@deepseek-ai/dsh-client-ui-settings-models`），控制台另有 `slot entry crashed in 'settings.section'`。只有**平台型**供应商（opencode / 微信小程序大赛 / step）会触发 —— 它们的编辑面板用 `ModelListEditor`；`DeepSeek 账号` 走另一条路径所以正常。**真凶**：该包里躺着 desktop 线运行时补丁的产物 —— `patch.mjs status` 报 `patched`（`950BE235…`）且**语法合法**，但产物 202,111 B vs 官方原版 `.dsh-bak` 186,641 B，注入痕迹 `reasoningRow=2 / REASONING_LEVELS=3 / testingAll=8`（官方原版全为 0）⇒ 补丁确实改写了 `ModelListEditor`，而它的 baseline 是 **0.1.7-alpha.2**，在 **0.2.0-rc.1** 上「零适配」的说法**与实测不符**（需 `rebuild-baseline.mjs` 重对齐锚点）—— 属 **desktop 线**范围。**恢复（已执行）**：2026-09-28 经用户确认跑了 `cd dsh-miasaki-desktop/patches/dsh-client-ui-settings-models && node patch.mjs revert` —— `client.js` 还原官方原版 **186,641 B**、`status` 报 **`original`**（`7674ED0B…`），并起临时 host + playwright 复验「点 opencode 编辑」→ **编辑表单正常打开、无 TypeError**（官方原版不崩 ⇒ 坏的确是补丁产物，闭环）。代价：暂时失去补丁的思考强度 / 测试连通性 / 能力徽标。**desktop 线待办**：按 0.2.0-rc.1 重建基线后重打（`rebuild-baseline.mjs` → 同步三个常量 → `verify` → `apply`），否则重打上去模型页编辑会再次白屏。**本线侧**：`settings.models.provider-card` **保持撤销**，但理由由「事故归因」更正为**风险论证**（编辑面板也会 dispatch 该槽，occupant 一出问题就整树白屏），闸门照旧。**教训**：时间上的巧合不是因果 —— 该先复现 + A/B 对照再动手；我撤掉的那段代码是无辜的。本线六份测试 **62 例**、`verify-all` **161 项全 PASS** |
| 2026-09-28（第九线 · 方案修订） | **不再另起一页，改为增量进上游插件的设置页**（用户反馈「页面太丑」「我要的是对 Our Free Model 做增量」「不要两个页面分开」）。**错在哪**：M2 我另起了一页、用内联样式 + 14 个基础令牌手搓三区；而上游页面是 **109 个 CSS 类的设计系统**（`ofm_hero` / `ofm_card` / `ofm_pill` / `ofm_stat` / `ofm_seg` / `ofm_kvc`…）、用 `bg-layer-3` 抬卡片、三级文字色 —— 且它用的 `--dsw-alias-bg-layer-3` / `label-tertiary` / `state-business-primary` **不在 `Theme.listTokens` 的 14 项清单里**（那个接口只列"需要明暗双份覆盖"的），所以"照令牌抄"连素材都拿不全。根子上是**出发点错了**：用户要的是在它身上加东西，我却另起一页。**新方案** `patches/dsh-our-free-model/`：五处锚点改写**本机安装副本**（不改它的源仓库）—— `nav-label`（左栏改「免费模型」）/ `drop-news-section`（去掉公告中心分区）/ `drop-onboarding`（去掉首启 5 页弹窗）/ `inject-panel-component`（注入 `PlatformScanPanel`）/ `inject-platform-section`（模型清单后挂「本机自配平台」）；**不碰**它的内部逻辑与 i18n 字典，纯文本改写所以能整文件还原。配套：`patch.mjs` 四模式 CLI（status / apply / verify / revert）＋ `self-test.mjs` **离线自证**（三种状态各有处置：applied → 直接断言、pending → **临时副本上试打**验"升级后能重打"、**drift → exit 1**；上游不在本机时**显式打印跳过**）＋ `inject/platform-panel.js`（用上游的 `ofm_*` 类，数据走同源 `/freemodel-api/*`）。本线侧：`settings.section` 改**条件注册**（探测 `/api/our-free-model/meta`，上游在场就**让位** —— 保证只有一个入口）。**一条被自己否掉的兜底**：第一版写过"无备份时就地逆向"的回退，实测**还原不逐字节**（`replace` 类要换回原串、`insert` 类只能删新增部分而不能连锚点一起删）⇒ 已删除，改为显式失败 + 两条正路（重装 / 手工撤接入点）—— **半对的回退比显式失败更糟**。测试 `client-bundle` 8 → **9 例**（拆出「上游在场→让位」），本线合计 **62 例**；闸门 **11 → 15 项**（+3 补丁件语法 +1 自证）。实测 `[实测]`：副本上 apply → 精确断言 → revert **逐字节一致**（含无备份时显式失败）；真文件已打补丁（`.ofm-patchbak` 在位）；`self-test` 两种输入状态均 PASS；`verify-all` **161 项全 PASS**。**实机待验**：重启 miasaki → 左栏只剩「免费模型」、无公告分区与首启弹窗、模型清单下出现「本机自配平台」 |
| 2026-09-28（内核升级复验） | **DSH 0.1.7-rc.2 → 0.2.0-rc.1：第九线契约零适配，但真机抓到一个缺陷**。**契约面**逐项实测未变：`settings` 无 `get`、有 `describe`/`update`；`settings.section` 与 `settings.models.provider-card` 逐字节一致；`llm` 的 `listProviders` / `listModels` / `resolveModelInfo` / `listConfigurableProviders` / `registerModelDiscovery` 五个方法全在且签名逐字一致；`agentDefaultModel.currentSelection`/`saveSelection` 未变；`connection.requestRejection` → `401｜403｜undefined` 未变（内核确实换了：registrant 缩写由 `cf` 变 `pf`）。**缺陷**：M3 给 `default-model` 分了 GET/POST **两条** exact 路由，而 webServer 的表**按 path 去重**，第二条 `register` 抛 `duplicate exact route` —— 而这是 **apply 期抛错 ⇒ 整个插件不激活**（启动日志只留一行 `1 entry did not activate`，面板与路由全没）。**离线单测抓不到它**：mock 的 `register` 无去重语义，`default-model.test.js` 甚至曾因"后注册覆盖前者"而**通过了一条错的 handler**。**修法**：`registerRoute` 改为接受方法数组，一个路径的多方法在**同一条**路由内分派；并新增 **`routes.test.js` 的"路径唯一"闸门**把这条真机约束前移。**修复后真机复验**（web profile 临时 host，端口 3221）：启动输出**无 warning**；`/freemodel-api/status` 200（settings 的 `describe()` 双轨读通）、`/freemodel-api/default-model` 200（`{provider:"deepseek-official",model:"deepseek-flash",reasoningEffort:"max"}`，官方服务可达）、`/freemodel-api/scan` 200（`adapterAvailable:true`；**`openrouter` 24 模型 / 21 免费、`opencode` 19 / 6**，真实数据上 L1 判定命中）、非回环 Host **403**、无 cookie **401**。测试 `routes` 5 → **6 例**、本线合计 **61 例**；`verify-all free-model` 11/11、`repo` 3/3。**顺带记录**：0.2.0-rc.1 的 `dsh-llm` 新增 `llm/providers` 事件（provider 拓扑变化通知，"消费者应重读 listProviders/listModels/listConfigurableProviders"），是"来源变化即失效扫描缓存"的现成钩子 —— 本线现按需刷新，够用，留作后续 |
| 2026-09-27（canvas 0.1.7 适配） | **canvas 线适配 DSH 0.1.7：`ctx.sessions.open` 删除**（用户截屏报「关联的 DSH 会话已不可用」求因）：0.1.6 的 `ISessions` 契约有 `open(id)`（职责"Select a session as current"），0.1.7 起**删除该 API**，会话导航收敛到 `ctx.uiWorkspace.openSession(target)`（ui-workspace 服务，`replaceMain` 同步替换 mainView reference）——本机运行时（`dsh` CLI 0.1.7-rc.2、`@deepseek-ai/dsh-api-session-controller` 0.1.7-rc.2）的 `ClientSessions` 无 `open` ⇒ `ctx.sessions.open` 是 `undefined` ⇒ 每次调用 `TypeError` ⇒ 被桥接层空 catch 吞成固定文案「关联的 DSH 会话已不可用」（**会话其实活着**：数据面 `ctx.sessions.list` / `ctx.workspaces.list` 未受影响，坏的只有「选中并跳回 DSH 会话」；连带画布发消息——0.1.7 的 `scope()` 只对已 retain 的世代有效）。**修复**（v0.5.0-miasaki.7）：`inject` 增加 `uiWorkspace`；三处导航（`canvas:open-session` 回跳 / `canvas:activate-session` 卡片联动 / `prompt()` 画布发消息）改走 `ctx.uiWorkspace.openSession`；`prompt()` 先打开再借 scope（`materializeScope` 同步建 scope）；两处空 catch 改 `console.warn` 留痕 + toast 带真实原因；未知会话 id 时 `openSession` 抛 `sessions.retain: unknown session <id>`，成为「会话真的没了」的唯一合法出口。单测 **98 → 100 例**（新增「跳回 DSH 走 uiWorkspace」「发消息先打开再借 scope」两条契约锚点 + `doesNotMatch(ctx.sessions.open(` 全局否定）、`verify-all canvas` **12/12**（项数不变）、`repo` 2/2。§3.0 台账 Canvas **2 → 3 项**（新增 **F3**），§3.3 补会话导航判据。**实机待用户重启 `dsh web` / 桌面壳后验收**（点卡片 / 回跳 / 画布发消息三连 + console 无告警） |
| 2026-09-27（v4 消息来源闸门） | **仓库级第三道闸门 `repo/message-sources` + 平台归档**（用户截屏报 miasaki 桌面端「本轮运行失败 format v4 message requires a producer-owned source kind」求因）：结论是**第三方记忆插件** `@openviking/dsh-memory-plugin@0.2.1` 仍在用 v3 的消息来源写法 `{ kind: "plugin", plugin: … }`，被 DSH 0.1.7 的 **v4 准入**（`assertV4SourceRowAdmission` / `assertV4MessageSources`）在**落盘前**硬拒 —— 它挂 `agent/pre-step`、每轮注入记忆召回消息 ⇒ **每轮必失败**，而磁盘与 host 日志**查不到任何痕迹**（被拒的消息不落盘）。**排查两坑入纪律**：① 会话日志是**逐帧追加的 zstd**（单文件实测 3 万+ 帧），`zstdDecompressSync` 读整文件**只解得出第一帧**（header 那行，看起来「日志是空的」）⇒ 必须按帧 magic 切分；② 该错误不进 host 日志，只以 turn error 顶到 UI（`message.turnError`）。**取证**：全库 533 个会话文件里 `kind:"plugin"` 共 1976 条**全部落在 v3 / 更早代旧文件**（218 个无版本号 + 146 个 `.v3`），**v4 文件 0 条** —— 即「升级后它一次都没写成功过」；另用 v4 编码器实测：喂 `kind:"plugin"` 逐字抛出该错误、喂 `plugin:openviking-memory`（0.5.8 的写法）通过。**修复**：两个 profile（`miasaki` / `web`）该插件 `^0.2.1 → ^0.5.8` + `pnpm install`（各 `+1 -2`），再用插件真实 `pluginMessage()` 复验过编码器、入口模块可导入、宿主 peer 齐全；**待重启后端生效**（host 半只在启动时加载）。**新增闸门** `scripts/check-message-sources.mjs`（仓库内 193 文件 + 本机 6 profile / 11572 文件；内置自证 + 故障注入自证 + `source-ok` 豁免；`REPO_TARGETS` 缺失即显式失败）+ **配套工具** `scripts/inspect-session-sources.mjs`（多帧 zstd 会话日志取证，报告每条 durable 消息的 `source.kind`）；回归 `repo` **2 → 3 项**、**全量实测 142 项**（九线全 PASS），且 `silent-guards` 同批抓出我在新脚本里引入的 5 处降级（1 处改显式失败、4 处 `guard-ok` 留痕）。归档 [`dsh-platform/dsh-0.1.7-session-v4-source-admission-2026-09-27.md`](../dsh-platform/dsh-0.1.7-session-v4-source-admission-2026-09-27.md)，新增 **§3.11** 与台账 **H1**（1 / 49） |
| 2026-09-29（第九线收尾） | **迁出收尾：全量 161 项 PASS + 抓出两处「迁移漏登记」真缺陷**。全量实测 **九线 + repo 161 项全 PASS**（sidebar 13 / canvas 13 / fleet 17 / desktop **36**（迁出后口径 —— 4 项随插件迁入第九线）/ ssh 31 / dual-model 12 / appearance 18 / usage 3 / **free-model 15** / repo 3）。① **两个仓库级闸门都漏了第九线**：`check-silent-guards.mjs` 的 `LINES` 与 `check-message-sources.mjs` 的 `REPO_TARGETS` 在 09-28 迁线时都没补 `dsh-miasaki-free-model` ⇒ **整条线对两道闸门不可见**（前者注释已写成「九线」而数组只有八条 —— 注释与实现不一致是这类缺口的签名）。**连带陷阱**：不可见让基线里那条 free-model 条目被判「可回收」，而提示语只说"基线有、当前无"—— **照着提示删基线 = 把「没去扫」固化成「已干净」**。修后：`silent-guards` 扫描根 10 → **11**、命中 59、新增 0 / 可回收 0；`message-sources` 仓库内 198 → **215** 文件、命中 0。② **核销一条基线欠账**：free-model 那条 `if (!existsSync(p)) continue;`（三预设各自独立安装，跳过未装的那个是**业务判据本身**）就地写 `guard-ok` + 从基线移除，存量 **58 → 57 类**。**顺带记一个 `guard-ok` 口径坑**：判定只认命中行或**紧邻的上一行** —— 写成多行注释块时 `guard-ok` 必须落在**最后一行**，否则豁免静默不生效（本轮实测踩过一次）。同批文档归一：根 README 新增 2026-09-29 基线、本矩阵全量 157 → 161、AGENTS.md 八线 → 九线并写入「加线/迁线必须同改的七处清单」 |
| 2026-09-29（CI 持续红修复） | **CI 自 09-26 起每次 push 都红，查清了：`ssh/test/tools.test.js` 的 unref 定时器陷阱**。现象：本机 `verify-all` **161 项全绿**、CI 每次红且只有一句 `exit code 1`（Actions 日志 API 需 admin，本机读不到）。**本机复现三步**：① 空 `DSH_HOME`（模拟 CI 无 `~/.dsh`）→ 全绿；② `git clone --local` 干净树（无 `_refs/` `vendor/` `dist/`）+ 空 `DSH_HOME` → 全绿；③ **对齐 CI 的 Node 版本** `npx -y node@22.19.0 scripts/verify-all.mjs` → **复现**（`ssh 30/31`，失败项 `test/tools.test.js`）。**根因**：`lib/exec.js` 的 `timeoutTimer.unref?.()` 是**刻意设计**（真实 host 常驻另有 ref 句柄，unref 只为不拖住进程退出），但**测试进程里它是唯一句柄** ⇒ 事件循环立空 ⇒ **Node 22 的 test runner 判 `Promise resolution is still pending but the event loop has already resolved` 并且不再等待**（用例 18「超时 ⇒ TIMEOUT」在 CI 上 **0.5ms** 即报错、不等满 1000ms），随后 **19–31 共 13 例连锁失败**（`duration_ms 0`）；Node 24 对 pending promise 宽松 ⇒ 本机一直绿。**时间线吻合**：A1 工具面（`lib/tools.js` + `test/tools.test.js`）2026-09-26 12:2x 落地，而 CI 12:16 那次仍是 success。**修法**：测试侧加 **ref 保活句柄**（`setTimeout(() => {}, 5000)` + `finally clearTimeout`），**没有**去掉产品的 `unref()`（那是正确设计）。**验证** `[实测]`：Node **22.19.0** 与 Node **24.15.0** 各自 `tools.test.js` **31/31**、全量 **161 项全 PASS**。CI 工作流注释已写入「本机全绿 ≠ CI 绿 + 复跑命令」 |
| 2026-09-29（补账） | **§3.0 台账第一次对账：48 → 102 项、勾选 1 → 4（三处判据订正 + U2 一笔拟勾选被否定 + 一个新发现缺口）**。用户判断「先别急着分发，应逐线完善」⇒ 先生成**逐线完善方案**（规划类文档，按「入库边界」纪律放 `_refs/internal-plans/`，**不入库、不推送**），再按它的第一步「补账」执行：① **补勾 3 项（逐项核过结果文件）** —— A6（D3 四档响应式 09-15 实机）、A22/A23（G1/G2 09-28 实机 23/23，`_refs/scripts-archive/ssh-g1g2-live/evidence.txt`）；② **否定一笔拟补勾**：U2 实机验收结果文件实为 `allPassed:false`（09-16 逮到 4 处产品缺陷，含多 shell 输入全落 ch-1 高危，已修但**复验未跑**）⇒ A10/A11 按「需按当前版本重跑」记；D2（24 项全 PASS）/ D4（6 项全 PASS）为真但只覆盖部分台账项，且其后入口判据 / 连接表单 / 弹层形态多批改动 ⇒ 其余 SSH 项行内注 Partial 证据；③ **新立 53 个编号**（此前「判据在 §3.x / §2、台账无号」的债务全部编号，至此 §2 与 §3.0–§3.11 每行判据都有号）：sidebar M2.1 ×4（C6–C9）、appearance ×6（D9–D14）、usage ×5（I1–I5）、desktop ×11（E11–E21）、ssh ×7 + U3（A17–A24）、canvas F4、dual-model ×5（B4–B8）、free-model ×5（J1–J5）、fleet ×5（K1–K5）、补丁与装卸契约 ×3（M1–M3）；**U3 同步补 §3.6 判据行**（此前无编号无判据，是 25 条静默失效的第 1/2 位），free-model / fleet 标「专节待立」，fleet K3–K5 标「先修后验」；④ **可代跑项已代跑**：围栏 403 四线实测（ssh / appearance / dual-model 两轴 403 ✅）、`patch-live-audit` 10/10 patched、free-model 上游补丁 5/5 applied；**代跑中新发现一个缺口 ⇒ 立 I5**（usage 是九线唯一没有同源围栏的线，实测两轴 200；响应无 CORS 头 ⇒ 纵深防御缺失而非当场可利用）；⑤ §1 顶部同步 rc.2 适配（工作区待提交）口径 desktop 36 → 35、全量 164 → 163（cordis 退役出册，**不是退化**；实跑 163 项全 PASS 复核）。**方法论入账**：先对账再验收（勾选前先核结果文件，不照方案点名）、先修判据再验收、静默失效优先于视觉确认 |
| 2026-09-29（设置页动效统一） | **外观线 M3.2：设置面板动效锚点从各线面板类名迁到官方设置面板容器**（用户「设置页的动效不统一」）。诊断：MOTION_CSS 那条挂在 `.mia-panel` —— 各线各带一份 CSS 复制出的面板类名，实际只有 appearance 与 pet-panel 用 ⇒ 设置里只有「外观」「桌宠」两页整块上浮、其余六页瞬切；官方设置外壳（`ui-settings-general` 的 `SettingsRoot.module.css`）零 animation / 零 transition，reduced-motion 分支也仍只剩那两页淡入 ⇒ 两种模式下差异都在。修法：锚点改为官方**无障碍事实** `[role="presentation"] > [role="dialog"][aria-modal="true"][aria-labelledby]` —— 打开设置时整块面板入场一次，页签切换复用同一 DOM 节点 ⇒ 不重播、与官方瞬切一致；`.mia-panel{animation}` 整条删除（跨线隐式耦合解除）；reduced-motion 分支同步换锚点。**排他性按 dsh 0.2.0-rc.2 实际安装包实测**（不按 vendor 源码猜）：该三属性组合在全量 client 包里**全局唯一**、正是 `dsh-client-ui-settings-general` 的设置面板 —— 官方 Modal 与图片灯箱走 `aria-label`、usage 浮窗走 `aria-label`、ssh 面板 sheet 父级不是 `[role="presentation"]`，均不命中。**取证教训**：vendor 开发版 `SettingsRoot.tsx` 与 0.2.0-rc.2 实装产物有差异（实装多一个 `data-shortcut-modal="settings"`）⇒ 锚点以运行版为准。回归闸门：M3 合例 +4 断言（新锚点须带 `aria-labelledby` 且须为 `[role="presentation"]` 直接子级、`.mia-panel{animation}` 不得复活、降级分支须同样覆盖设置面板）。单测仍 **120 例全绿**（client 23）、`appearance` **18/18**。§3.5 动效两行改写、台账 D11/D12 补「设置页内连点一律瞬切」判据。**实机待用户重启 `dsh web` / 桌面端后验收** |
| 2026-09-30（`repo` 第 5 道闸门） | **新增 `lock-sync`：把「CI 红在装依赖那一步」拦在推送前**（用户截屏报 CI 失败求因）。**读日志定因**：截图那次是 `f610ef3`，红在第 7 步「安装 sidebar 线依赖」—— `pnpm install --frozen-lockfile` 以 `[ERR_PNPM_OUTDATED_LOCKFILE] Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with <ROOT>\package.json` 退出，`* 2 dependencies were added: @deepseek-ai/cordis@^4.0.2, @deepseek-ai/dsh-host-webserver@>=0.1.2-rc.1 <0.3.0`；第 8/9/10 步（ssh 安装 / desktop 安装 / **九线统一回归**）全部 `skipped` ⇒ **看起来像测试挂了，其实一个测试都没跑**。**按提交对齐时间线**：引入点是 `8181b89`（09-29 20:44，七个 web 插件补 peerDependencies 只改 `package.json`），修复是 `f769373`（09-30 00:21，补 sidebar / ssh 两份 `pnpm-lock.yaml`），中间**连续 11 次** push（`8181b89` … `f610ef3`）全红 —— 期间合入的改动（dual-model 静默丢图修复、七个包发布就绪等）**在 CI 侧从未被验证**；工程记录与矩阵此前写的「连续四次」是当时可见范围的失真，已订正。**新闸门判据**：锁文件（`pnpm-lock.yaml` 的 `importers['.']` / `package-lock.json` 的 `packages['']`）四个依赖段与 `package.json` 的直接依赖 specifier 逐项一致；**pnpm 侧跨字段合并比对** —— `autoInstallPeers: true` 时 package.json 的 peerDependencies 在锁文件里登记进的是 `dependencies` 段（sidebar 实测），按字段名逐段对齐会误报。**内置自证随每次运行执行**（fixture 正反例 + specifier 漂移 + npm 侧），防「解析器坏掉 ⇒ 永远绿」这个闸门最坏的失效形态（首版 fixture 少写一个依赖，当场被自证抓出）。**验证** `[实测]`：① `--root` 指向放有 `f610ef3` 历史 `package.json` + `pnpm-lock.yaml` 的临时目录 → exit 1，且报出的两条与 CI 日志**逐字相同**；② 当前树 4 个锁文件 / 19 条直接依赖登记 **PASS** —— 第 4 个是 `dsh-miasaki-canvas/pnpm-lock.yaml`，**动态枚举才看得见**（照 CI 那三条线硬编码会漏掉它）；③ `silent-guards` 对新脚本判定「新增 0」，未踩 R1/R2。全量基线 167 → **168**（`repo` 4 → 5，十类全 PASS；本轮 file policy 为 `danger-full-access`，`md-links` 不再被沙箱阻塞 ⇒ 本机首次无阻塞项）。**顺带记一条边界**：截图那条 `Node.js 20 is deprecated…` 是 GitHub 对**四个 action 自身运行时**（checkout / setup-node / cache / pnpm-action-setup 的 v4）的弃用通知，与显式声明的测试矩阵 Node 22.19.0 无关，最新绿运行里依然存在；四者当前最新主版本为 v7.0.1 / v7.0.0 / v6.1.0 / v6.1.0（本次未升级） |
| 2026-09-30（K3/K4/K5/I5） | **三处静默缺口收口 + 第九道围栏补上 —— 全部落在「修完即由闸门看住」的形态上**。触发：用户「规划设计修复方案并开始修复」；方案落 `_refs/internal-plans/fix-plan-2026-09-30.md`（规划类不入库），判据全部来自既有台账（K3–K5 / I5）与**仓库自己的历史结论** —— `tasks/t-0003` 的交付物早在 2026-09-11 就点名了 `validate-bus.mjs` L231 的静默放行，并给出不变式「任何被标记为终态的对象都必须有一条反向存在性检查」。**① K3 终态必须有交付物**：`validate-bus` 改为反向存在性检查，且**驱动源是台账而非 `tasks/` 目录**（用例驱动出的修正：目录不存在属同族形态）；首跑即抓到存量 **7/9 任务**「已验收却从未产出交付契约」，7 份 `result.json` 按契约**补记**（evidence 指向原始 `result-*.md` 或派单器代写的 `transcript.md`，artifacts 带真实 sha256，标注「契约补记 2026-09-30」）；同批把折叠口径改为**复用 `foldTasks`**，消除本文件里的第二份重放实现。**② K4 自述受阻如实落账**：新增 `workers/dispatch/final-state.ps1`（判定单点、`-OutFile` 可回读以便受限沙箱测试），`dispatch-task.ps1` 经它落终态（退出码 0/3/4 语义不动）；`tests/dispatch-state.test.mjs` **9 例**，含**两个 ps1 的语法闸门** —— PowerShell 侧此前没有任何自动化检查；故障注入自证（注入语法错误 ⇒ exit 1 并点名 `dispatch-task.ps1:357`）。**③ K5 厂商表不再空宣称**：新增真实文件 `shared/agent-vendors.json` + `workers/lib/vendors.mjs`（缺失 / 结构非法两条回退路径都留痕；此前静默回退会在默认表与实际归属不符时给出**假异构**结论）；测试 +5 例。**④ I5 usage 同源围栏**：新增 `lib/fence.js` 并在 **register 一处**统一包装五条路由（含 `POST /reset` 写操作，此前两轴实测 200），`test/fence.test.mjs` **13 例**含「围栏先于业务」顺序断言（跨站 POST 得 403 而非 405、handler 调用次数为 0）。**口径变化**：全量 **168 → 171**（fleet 17→18、usage 3→5）；`silent-guards` 基线**核销 2 类（57 → 55）**、新增 0（两条均为本批主动修掉的静默断链，核销前逐条复核「是修掉了，不是扫不到」）。**如实保持未勾**：K4 端到端待一次真实派单、I5 待重启 `dsh web` 复验两轴 403 |
| 2026-09-30（续·I1/J5） | **「只有注释、没有闸门」这一类再收两处**。用户「继续」⇒ 按「静默失效优先、可独立验证」继续推进；两项都不新增判据，只把矩阵里**已经写着**的纪律变成机器判定（共同形态：规则写在文档与注释里，但没有任何东西会拦下违反）。**① I1 账本目录名**（usage）：矩阵原话「2026-09-29 已用 `LEDGER_DIR_NAME` 解耦但**无闸门**」，失效形态是「一次顺手统一命名 ⇒ 三个 profile 的历史账本全部失联」，而界面照常、数字归零、不报错。把目录名与解析抽成单点 `lib/ledger-dir.js`，`test/ledger-dir.test.mjs` **5 例**：目录名**冻结为历史值**（写死字面量）/ **目录身份与包身份无派生关系**（源码不得读 `package.json`、不得把插件名拼进路径）/ 宿主服务三形态与优先级 / 异常回退不丢账本；`verify-all usage` **5 → 7 项**。**② J5 上游补丁 live 审计**（free-model）：矩阵写着「常驻闸门」却**无任何自动化**（只在人记得手跑 `patch.mjs status` 时存在），而上游应用内升级**必覆盖**清单内文件 ⇒ 悄悄退化成上游原样、本线不崩不报错、离线自证照常全绿。三处接线：补丁导出 live 契约（`TARGET_PACKAGE`/`TARGET_RELATIVE`/`classify`，**刻意无 DSH 基线**）、`PATCH_ROOTS` 补该目录、布局候选补 `~/.dsh/local-plugins`（否则即使入册也误报 `missing`），并给 drift 判定加「须有 DSH 基线」前提（无基线者「未打上」判**真回归** —— playwright 补丁当初的盲区正是此形态）。**故障注入自证**用真实的上游原版备份造假根：原版 ⇒ `original`+exit 1、漂移 ⇒ `unknown`+exit 1、真实安装 ⇒ `patched`+exit 0；**自证顺带抓到一处真缺陷** —— 审计侧原先只解构 `state`、丢掉 `detail` ⇒「上游原版」与「锚点漂移」输出完全一样（处置方式却不同：重打 vs 重新对齐），已改为解构并显示。**口径**：全量 **171 → 173**（usage 5→7）；live 审计 **10 → 11 目标**；台账勾选 **6 → 7 / 102**（J5 的判据「5/5 applied」已实测满足且已自动化；I1 的运行时部分仍待三 profile 重启） |
| 2026-09-30（续二·#18） | **静默失效 #18 收口：拿不到 profile 名时不再假装隔离**。用户第二次「继续」⇒ 按建议排序取本项（同域、成本低、可独立验证）。问题：`resolveProfileName` 三档（`profileContext` → `DSH_PROFILE` → 兜底）全空时返回裸字符串 `'default'`，账本落 `…/default/`，而页面照常宣称「本页只统计当前 profile（default）· 与其它 profile 的账本**完全隔离**」—— **这句话是假的**：那个桶是**共享兜底区**（多个环境会写进同一个桶）。失效形态正是本仓最警惕的那类：不报错、界面正常、账在混。**修法（不假装，而不是换桶）**：目录名仍为 `default`（既有账本不能丢，与 I1 同一纪律），改的是口径如实性 —— `resolveProfileKey(ctx, env)` 返回 `{name, source}`（`source ∈ profileContext\|env\|unknown`），`unknown` 档随 `/global` 下发 `profileSource`，浮窗顶部与底部长说明**双双按 source 分支**（unknown ⇒ 明确写「未识别 profile、可能与其它环境混账，并非真隔离」）；`resolveProfileName`/`safeProfileDir` 一并移入 `lib/ledger-dir.js`（同属账本身份，抽在一起才测得到）。**闸门**：`test/ledger-dir.test.mjs` **5 → 9 例**（+4：profileContext 优先且 trim / 环境变量档 / 三档全空 ⇒ unknown（四种输入形态）/ `safeProfileDir` 是**安全边界**：`@miasaki/dsh-x` ⇒ `_miasaki_dsh-x`、`../../etc` ⇒ `.._.._etc`）。**台账补立 I6**（此前这条债务**在文档里没有编号** ⇒ 不可见）⇒ 分母 **102 → 103**；勾选仍 **7 / 103**（I6 待实机看文案）。**测试自身踩的一坑已入注释**：`resolveProfileKey(ctx, undefined)` 会用 `process.env`（生产路径的正确行为），本机环境恰好带 `DSH_PROFILE` ⇒ 用例拿到 `'desktop'` 而失败 —— 测试里 env 一律显式传表 |
| 2026-09-30（续三·#20） | **素材遮蔽链变成机器判据（desktop）**。用户第三次「继续」⇒ 取建议排序第一条：它有真实用户影响面 —— 2026-09-27/28 whale 图集与白军装反转狂三**在实机上失效一整天**，而代码 / 单测 / 资产闸门**全绿**，只有 `pet.log` 的 `whale_rows=7` 能戳破；根因是素材两层解析（磁盘 `ui/` 覆盖层优先、编译期内嵌兜底）下旧素材**静默遮蔽**新素材。**此前加不了闸门的原因**：判定写在 `build.rs` **生成的** `assets.rs` 里（生成物不可单测），故它只以三行人工走查存在于 §3.2.1。**改法**：判据搬进手写 `dsh-miasaki-desktop/src-tauri/src/asset_source.rs`（与本次改动同批入库，未入库前不做相对链接）（`resolve` / `shadow_report` / `shadow_summary` + 逃生门 `MIASAKI_ASSETS_SOURCE=embedded`，`OnceLock` 缓存），生成物只留转发（`read()` **签名不变** ⇒ 5 处调用点零改动），`main.rs` 在 asset-server 起后打一行摘要且**无分裂不写**（避免日志噪声）；**遮蔽口径** = 磁盘有 ∧ 内嵌有 ∧ **内容不同**（内容相同是副本、磁盘独有是新增，都不算）。**测试**：`cargo test` **109 → 117 例**（+8）；**测试自身踩的坑已入注释**：临时目录用 `std::env::temp_dir()` 会 **5 例齐挂 `PermissionDenied`** ⇒ 改用测试产物目录（`target/**/deps/`）。**当日机器核对**：部署目录 **139 素材与仓库逐字节一致** ⇒ 新判据此刻应安静；§3.2.1 新增第四行判据（「有分裂必有行」+ 反例验法），台账 **E13** 同步（仍待一次实机反例走查）。**全量 desktop 38/38、`cargo test` 117 例全绿** |
| 2026-09-30（续四·#10） | **M4 锚点失配提示（appearance）—— 「不报错 ≠ 生效」的又一处收口**。用户第四次「继续」⇒ 按建议排序取下一条（内部计划 §二 #10）：M4 的密度 / 最大宽度落在**官方内部 DOM 与 CSS 变量**上（`[data-chat-flow]` / `--dsh-chat-content-width` / `--dsh-chat-flow-gap`），官方升级改锚点名时插件**不报错、面板可点、保存成功、界面零变化**（用户只能说「开了没用」）。**判据只在能确定时说话**（这类自检最常见的翻车方式是把「会话还没有消息」误判成失配）：未开启依赖项 ⇒ `idle` / 会话页或 `[data-chat-flow]` 不在 ⇒ `unknown` / 锚点在但**读不到我们写的覆盖值** ⇒ `mismatch` ⇒ 面板显式提示并点名。**实现**：`probeConversationAnchors()` 纯读 DOM、**不引入 state**（面板 state 数不变，既有「队列长度 = 8」断言不受影响）；行数组提为 `convRows` 后条件追加提示，**保留 `conversation === null` 短路**（否则配置未加载时读 `conversation.density` 会整面板空白 —— 与 09-12 空白面板事故同型）；流式光标与引用 / 代码块**不做静态自检**（前者仅生成中存在、后者用原生标签），文案已说明。**闸门**：`test/client.test.js` **23 → 27 例**（失配必提示且点名 / 正常不提示 / 无法判定不提示 / 未开启不提示），夹具 `capture()` 增**可选** `querySelector`/`getComputedStyle`（默认行为不变 ⇒ 既有用例零改动）；`appearance` 仍 **18/18**。台账 **D8** 补「锚点失配提示」、§3.5 新增一行判据（分母不变，仍 **103**） |
| 2026-09-30（续五·#8） | **「无可见效果」补全为全量判定（appearance）—— 「开着总开关却什么都没配」这一支此前无提示**。用户第五次「继续」⇒ 取建议排序第一条（用户 2026-09-27 真实报过「开启了没什么效果」）。09-27 那条提示只覆盖一种形状（纯净皮 + 壁纸 + 表面全不透明 ⇒ 三层互相抵消），漏了更常见的：**总开关开着、所有项都停在原生档** —— 页面同样是零变化却没有提示，用户只能以为功能坏了。**判据换成「本线会不会产生任何可见变化」**：皮肤非纯净 / 壁纸源非空**且**至少一处表面不透明度 < 100 / 动效开着 / 会话效果有非默认档；零变化时按成因分 `native`（什么都没配，附四类可操作第一步）与 `covered`（三层抵消）两种文案。**玻璃档位退出判定**（只改观感、不会把零变化变成有变化），同批移除对 `data-mia-native-mica` 广播的依赖。**顺带修一处旧 host 白屏隐患（本次用例照出）**：会话效果组只判 `=== null`，而旧 host（v5 前无此板块）给 `undefined` ⇒ 读 `conversation.density` 整面板空白（与 09-12 白屏事故同族，此前无用例覆盖 undefined）⇒ 改为「非对象即不在场」并给「或宿主版本较旧——重启宿主后重试」提示。**闸门**：`test/client.test.js` **27 → 32 例**（全原生档提示 / covered 不张冠李戴 / 八种「有变化」一律不提示 / 总开关关闭不提示 / 缺板块不崩），`appearance` 仍 **18/18**。§3.5 新增判据行，§3.05 遗留项注记核销，§1 用例数 120 → **132** |
| 2026-09-30（续六·决策⑥） | **侧线 goal 补偿落地（sidebar）—— 「已拍板未落地」半年的一页终于翻过去**。用户第六次「继续」⇒ 取下一条。M2 设计 §8 / S9 取证早写明「建议做最小补偿」，`:client.js` 里 `goal` 零命中。`fork` 是**零类型过滤**的日志前缀拷贝（官方 `buildForkSeed`）⇒ goal / plan / todo / preset 全进 child；不补偿的后果：侧线**显示并携带父目标**（用户以为侧线干净、模型可能接着做父任务的活 —— S8 复现的温床），且侧线内 `create_goal` 会因 `GOAL_ALREADY_EXISTS` 失败。**实现**：`clearInheritedGoal(ctx, childId)` 官方同款调用（`goals.get` → `clear({id,revision})`），**刻意不 await**（不拖慢/拖死「新建侧线」，`childId` 原样返回）；失败两档 —— 服务缺席=正常形态静默返回、在场而失败仅 `console.warn` 留痕不外抛；代价如实记账（child 日志留 `goal/change{operation:'clear'}` tombstone）。**做不到的如实写明**：`plan` / `todo` 无客户端 API。**为什么放模块级而非 apply 闭包**：判据必须可测 —— 闭包里只能靠源码正则，抓不到参数传错 / 忘 return childId。**闸门**：`test/sidechat-registry.test.js` **13 → 19 例**（+6，含两种失败只留痕不外抛、服务缺席零告警、源码契约「不 await + 必须是模块级」）；`verify-all sidebar` 仍 **13/13**，**11 文件合计 92 例全绿**（§1 表同步）。台账补立 **C10** ⇒ 分母 **103 → 104**（「该调没调」此前没有编号 = 不可见） |
| 2026-09-30（续七·P4） | **每板块「恢复默认」（appearance，路线 P4 落地）**。用户第七次「继续」⇒ 取下一条。P4 早在 2026-09-26 路线里定形（官方 models `.linkButton` 形态、按板块重置），代码零命中 —— 此前配置改乱只能手动逐项改回。**默认值只有 host 一份**：`/state` 新增下发 `defaults`（`lib/config.js` 的 `DEFAULT_CONFIG`），客户端**不另存** —— 两份必然漂移，而漂移的后果恰是「恢复默认」恢复成**旧版**默认值（比不提供恢复更糟）。**三条路径**：已是默认 ⇒ 不渲染按钮；旧 host 无 `defaults` ⇒ 提示「重启宿主后即可用」（不静默失效，与 M2.7 avatar 处理同款）；其余 ⇒ 官方 `Button`（ghost）走既有 save（`POST /config` + `expectedRevision`）。语义=**整板块重置**（host 侧 merge 是板块级浅合并 + sanitize 收窄 ⇒ 旧版残留字段被丢弃）。**两处自纠**（都入注释）：① `masterLive`/`resetRow` 首版定义在各组之后 ⇒「主题」组先用即 **TDZ 崩溃**（移动定义时忘了删旧那份，`node --check` 照出重复声明）；② 夹具 `nativeConfig` 的 `bootSplash:'off'` 与出厂 `'auto'` 不一致 ⇒「全原生档」被误判非默认，**两个夹具不自洽**。**闸门**：`test/client.test.js` **32 → 36 例**（非默认必给入口且发出的是 host 默认值 / 全默认零按钮 / 旧 host 给提示 / 客户端不得硬编码默认值）；`appearance` 仍 **18/18**。台账补立 **D15** ⇒ 分母 **104 → 105**，§1 用例数 132 → **136** |
| 2026-09-30（续八·P5） | **配置导入 / 导出（appearance，路线 P5 落地）**。用户第八次「继续」⇒ 取下一条。**核心设计**：导入是**整体替换**而非合并 —— 文件里没写的板块回出厂默认（用 merge 会让「导入一份只写了主题的 JSON」变成「只改主题」，与「导入配置」的预期不符）；host 侧 `POST /config` 新增 `replace:true` ⇒ `sanitizeConfig(raw)`，**非对象一律 400 显式拒绝**（不让 sanitize 当空对象 ⇒ 静默清空）。**其余四条**：导出带自描述包装（`kind`/`version`/`exportedAt`/`config`，文件名带版本）；**二次确认**写明「没写的板块会回出厂默认」且**无法弹确认框时取消**；四类坏输入（非 JSON / 顶层非对象 / 找不到配置对象 / 无法确认）一律**人话错误 + 零写入**；兼容**裸配置对象**。复用既有 `save()`（只多一个报文位）⇒ 属性同步 / override 重算 / 三层应用与乐观并发全部共用。**闸门**：`host.test.js` **18 → 24 例**、`client.test.js` **36 → 41 例**；`appearance` 仍 **18/18**。台账补立 **D16** ⇒ 分母 **105 → 106**，§1 用例数 136 → **143**。**同批一处自纠**：用 PowerShell `Set-Content -Encoding UTF8` 改入库文本会**写入 BOM**（PS 5.1 行为），已按字节复验并用 `UTF8Encoding($false)` 写回 —— 结论：入库文本一律走编辑工具 |
| 2026-09-30（续九·style） | **仓库级第 6 道闸门 `check-style.mjs`（文件形态 + 公开仓库脱敏）**。用户第九次「继续」⇒ 治理层最后一个大口子（缺 lint/format）。**为什么不是 ESLint/Prettier**：本仓硬约束是零第三方依赖，且格式化器会产生**巨量零语义 diff**（本仓明记「存量 17 处 CRLF 不批量转换，以免淹没真实改动」）⇒ 落点改为**一个仓库级闸门**，只取能客观判定、假阳性可控的四类判据：无 BOM / 只有 LF / 末行有换行 / **脱敏**（`C:\Users\<段>` 必须是占位写法）。前三类**存量冻结**（BOM 10 / CRLF 17 / 无末行换行 27 = 54 条进 `scripts/style-baseline.json`，条目消失报可回收）；**脱敏类刻意无基线**（用户名泄漏不该有「存量」）。**过程两笔值得记**：① 闸门自身假阳性 —— 首跑把桌面端 README 的 `C:\Users\…\` 报成泄漏，那是**合法占位**（Unicode 省略号 U+2026），我的判据只认 ASCII `...`，已补四种占位形态（**闸门假阳性比漏报更危险：它让人把闸门关掉**）；② **我先前一个错误判断被自证纠正** —— `grep` 扫到 fleet 归档 transcript 3 处 `C:\Users\<用户名>\…`，我判为「脱敏漏掉的入库文件」，但故障注入后闸门毫无反应，查 `.gitignore:98` 才知它们**根本没入库**（`grep` 扫工作区、不是入库集）⇒ **入库文件零违规**；那 3 处与派单器落盘脱敏仍做了（防「哪天 un-ignore 或提交」）。**故障注入自证**：往入库文件注入 `C:\Users\<探针名>\…` ⇒ exit 1 并点名；还原后 PASS。另有四类 fixture 自证 + 占位反例。**同日第三次自纠（最说明问题的一笔）**：写这段说明时我把**真实用户名与探针名原样写进了本文档与 `docs/ENGINEERING.md`**，闸门随即在**全量回归**里报了出来 —— 即「给『不许泄漏用户名』写文档时泄漏了用户名」，机器在提交前抓住 ⇒ 教训：**写脱敏说明时示例一律用占位，且这类检查必须扫文档、不能只扫代码**。`verify-all repo` **5 → 6**，全量 **173 → 174** |
| 2026-09-30（续十·辅助对话干净化） | **「辅助对话怎么还是有记录」收口：不占会话记录 + 继承段不显示（sidebar × desktop 两线）**。用户原话「辅助对话怎么还是有记录，会上会话记录，我要干净的侧边会话页，有一定的上下文但是不显示。不是要你参考 zcode 的官方仓库了吗」—— **上一轮的错不是判断错，是只写到文档为止**：2026-09-30 那次「参考 ZCode 官方仓库」把三条机制逐条对账成「DSH 侧全部缺席」后，把它们留在了「向上游提需求的参照物」。本轮两条都做成实现。**① 不占会话记录**：唯一生效的过滤点是客户端壳的 `sessionVisible()`（Host 侧完全不过滤 origin，只跳过「冷会话且无 cwd」）；官方**已有**「建了但不进列表」的形态（`origin === 'subagent'` 直接 false），但 `origin` 由宿主写入、`fork`/`create` 入参都没有它；归档**藏得住聊不了**（`ArchivedSessionGate` 拒任何模型步）；5 个会话行插槽没有「过滤一行」的能力 ⇒ desktop 线新增补丁 `dsh-client-ui-workspace`（1 条编辑），判据是**跨包声明**（localStorage `miasaki-sidebar:sidechat:hidden:v1`，插件登记表每次变更后全量重写、加载时发布一次）。**fail-safe**：声明缺席/损坏一律按「没有侧线」⇒ 插件没装时补丁是空操作。**② 继承段不显示**：官方**无**消息级过滤位（`conversation.content` props 只有 variant/phase/hero；`conversation.chat.node` 可遮蔽但**遮蔽即接管渲染**，而官方组件不在导出面）⇒ 边界自描述 + 显示层裁剪：官方 `buildForkSeed` 在继承前缀末尾插 `session/end-seed{inherited:true}`，插件从 `binding.eventSource` 同步读到并用两条互补判据算轮数（看得到标记取标记前最大轮号；看不到标记取首轮号 − 1）；折叠走**侧线容器内 CSS**，锚点是官方行自带的 `data-chat-turn`（经 `turnOf(node) → location.turn.turn` 核实为会话轮号），作用域限定 `.dsh-sidebar-sidechat-body` ⇒ 主会话与官方 subagent 会话零影响，失败模式是「失效」而不是「打赢官方」。**明确排除**官方 continuable subagent 路径（原生不占列表）：创建即需首条 prompt（空侧线开不出来）、权限/preset/工具作用域**不继承**（fork 是官方自动继承 —— 侧线的核心价值）、且**同样不隐藏继承段**。**闸门**：`test/sidechat-registry.test.js` **19 → 31 例**（+12，含残缺形态/残缺事件/轮数上限等反例），sidebar 全量 **104 例全绿**、`verify-all sidebar` **13/13**、`desktop` **38 → 39**（新增该补丁离线自证项）、`repo` **6/6**；补丁已 apply 到运行环境（备份在场）。台账补立 **C11 / C12** ⇒ 分母 **106 → 108**；**C6 判据口径订正**（原文「面板里渲染出继承来的历史」是折叠前的形态，照原文验会把「干净」误判成缺陷）。**待实机（需刷新 miasaki 桌面端）**：C11 ①②③、C12 ①②③④ |
| 2026-09-30（续十一·会话布标注） | **辅助对话在会话布上照旧显示并加标注（canvas）**。用户「辅助对话虽然不在主会话列表显示，在会话布里要显示并且标注」。**先复核一件事（结论写进契约）**：画布**本来就显示**侧线 —— 画布的线来自宿主 `ctx.sessions.list()`（启动 replay + `session/created` / `session/event`），与官方列表的可见性判据**无关**；「不占会话记录」的落点（补丁改 `dsh-client-ui-workspace` 的 `sessionVisible()`）只影响官方列表与搜索。**真正缺的是可辨识性**：官方 fork 出的 child 与用户自己拉的分支在 header 上**完全一样**（`parentSession` + `isSeeded`，画布早已据此记 `sourceSeedLength`）⇒ **宿主侧区分不了**，唯一判据是 sidebar 那份跨包声明。**实现**（`app.js` + `styles.css`，零 host 改动）：`sideChatSessionIds()` 读 `miasaki-sidebar:sidechat:hidden:v1`（按原始串缓存，渲染每帧都要问）；`conversationCards` 打 `sideChat` 标（渲染层零查找）；三处标注 —— 线头卡徽标（只挂 `turnIndex === 0`，LOD mini 档仍在）、血缘树行（优先于「分支」）、详情页 badge；青色 `#0d9488` / dark `#5eead4`，与合并紫、回复中绿、分支灰分开；`storage` 事件跨文档同步（sidebar 在主页面写、画布在 iframe 读）⇒ 新建侧线标注即时跟上，**刻意不轮询**。**解耦与降级写成契约**：只读这一个键（源码级仅一处 `getItem`）、不 import 别线包、不复制官方可见性判据；声明读不到/坏掉 ⇒ **只是没有标注**，画布其余行为一字不变。**闸门**：新增 `test/sidechat-badge.test.js` **9 例** + `conversation-cards.test.js` **+2 例** ⇒ canvas **13 → 14 项 / 实测 116 例**（该项是动态枚举，新文件自动进册）、全量 **177 → 178**。**顺带修一处测试基建**：`conversation-cards` 的源码切片必须把判据那段一起求值，否则 18 例齐挂 ReferenceError（切片式测试的既有代价，已写进加载器注释）。台账补立 **F5** ⇒ 分母 **108 → 109**；**待实机**：F5 ①②③④⑤ |
| 2026-09-30（续十二·fleet 写入收敛 + 面板上屏 + 口径对账） | **B5 写入收敛落地、判定层上屏，并把「文档数字」与实跑对齐**。① **写入收敛（B5）**：口径从笼统的「所有文件经唯一入口」改为可判定的「**真相进总线、派生态明确豁免**」—— `agents/<id>/usage.jsonl`（成本唯一原始来源）登记进白名单（仅 `append`）并经 `bus-apply` 落盘；**失败语义「数据不丢优先」**：applier 失败回退直写并告警（行内标 `[BUS_BYPASS]` + 落 `agents/<id>/logs/dispatch.log`），但 **partial 失败不回退**（补丁可能已落盘，再写一遍就是成本双计）；`status.json` **刻意豁免**且理由写进契约（真值在 `result.json` + 事件流、写频 2 次/派单、全仓无周期性心跳写者）；台账写者归属以设计文档 **§4.5 为唯一定义**（消除 §2 / §5 / §7.0 的四说）。② **独立复核（t-0011）**：由异构 agent 带对抗立场复核，指出 **2 条阻断**（失败轮零计量 —— usage 此前只在 `exitCode=0` 时解析；partial 失败回退 ⇒ 重复计量）+ 4 条建议，**全部当批处置**；另修两个同族命令构造缺陷（prompt 里的引号泄漏成 CLI 参数、`cmd:` 行成对引号未剥离 ⇒ 命令静默 exit 0 被记成成功），新增 `-ShowCommand`（打印 argv、不派单不写盘）。**已知未收敛（登记在册）**：`control.json`（fleet-monitor 的 `POST /api/toggle` 直写派单许可）、`manifest.json` / `registry.json`（扫描器直写，是能力闸门的实际输入）、`capability.json` 在白名单内但全仓零写者。③ **面板判定层上屏（P1）**：新增三个**只读**端点 `GET /api/{dispatchable,gaps,events}` + 页面上「可派集 / 能力断层 / 机器事件」三块 —— **spawn 现成 CLI，不重复实现判定**（面板显示什么，派单器就按什么判定）；判定层不可用返回 `ok:false` 而非整页 500；**K1 判据同日补立**（见上）。④ **验收载体 t-0012**：以 `cmd:` 造一条**零成本必然失败**的轮次，验证「失败轮也留计量痕迹 + 终态事件带 `state` + 退出码语义」三条，可随时重跑。⑤ **口径对账（本批的「整理」部分）**：全量实跑 **179 项**（fleet **21**），并逐条订正文档里的失真数字 —— 可派闸门接线断言 **36 项**（文档曾写 12 / 20 / 26 / 31）、`dispatch-gate` 夹具 **26 例**（曾写 23）、`bus-contract` **26 例**、`bus-integration` **17 例**、`fleet-monitor` **16 例**、fleet 全线 **177 例**（曾写 119 / 161）、能力闸门断言 **7 项**（曾写 8）；根 README 静态回归 **173 → 179**、§3.0 分母 **106 → 109**。⑥ **顺带修一处「复跑方式假红」**：`npx -y node@22.19.0 …`（本仓钦定的对齐 CI Node 版本方式）下 fleet 的「放行」用例全挂 —— 根因是 npx 的 `.bin` 里**没有 `node.exe`**（只有 `node` / `node.cmd` / `node.ps1`），pwsh 的 `& node` 命中 `node.ps1` 后零输出 ⇒ 派单器判「判定器输出无法解析」并拒绝派单；修法是测试把 `process.execPath` 目录**前置进子进程 PATH**。**CI 本身不受影响**（`setup-node` 的 PATH 里是真 `node.exe`），但「钦定的复跑方式会假红」本身就是要修的形态 —— 否则真红会被当成假红略过。⑦ **提交后闸门当场抓到一处形态漏网**：三个提交落地后复跑全量，`repo/style` 报 `[crlf] dsh-miasaki-fleet/tasks/t-0011/verify-brief.md` —— 该文件由派单器 `Set-Content` 写盘（PowerShell 会为它写出的那一行补 `\r\n`，而内容其余换行是 LF ⇒ 混合行尾「47 LF + 1 CRLF」）。修法两条：产物侧改**按字节写**（`WriteAllText` + `UTF8Encoding($false)` + 显式末行 `\n`，不依赖 cmdlet 隐式行为）+ 钉进断言（可派闸门断言 **36 → 37 项**）；**闸门侧**把 `check-style.mjs` 的扫描集从 `git ls-files`（索引）改为 `git ls-files --cached --others --exclude-standard`（**索引 + 未跟踪未忽略 = 将要入库的全集**）—— 此前**尚未 `git add` 的新文件根本扫不到**，而新写的文件恰是形态问题高发处；CI 口径不变，本地更严 |
