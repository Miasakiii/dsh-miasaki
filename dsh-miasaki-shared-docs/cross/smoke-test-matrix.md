# 九线统一回归矩阵（smoke-test-matrix）

> 建立于 2026-09-07（**八线 → 九线：2026-09-28 新增第九线 `dsh-miasaki-free-model`**，
> 由 desktop 线迁出并更名）。各线代码零耦合，但共用一个 DSH host 与一个桌面壳，
> 回归必须分层：能脚本化的进 `scripts/verify-all.mjs`，需要真机/真 host 的留在本文档手动执行。

## 0. 分层定义

| 层 | 内容 | 载体 | 可自动化 |
|---|---|---|---|
| **L0** 静态检查 | 语法（`node --check`）、令牌完备性、令牌漂移 | `node scripts/verify-all.mjs` | 是 |
| **L1** 单线单测 | 下列数字为 **2026-09-26 快照**；本次改动过的三条线**当前实测**为 Canvas **105 例 / 10 文件**、Sidebar **66 例**、SSH **299 例 / 18 文件**（2026-09-27 逐文件实跑汇总）—— 旧值：Canvas 100 项、Sidebar 62 项、SSH 225 项、双模型 33 项、外观 114 项、Fleet 119 项、**用量统计 3 项**（第八线 `dsh-token-monitor`：host 半语法 + 数据修复工具语法 + client bundle 装载契约）、Desktop 127 例（含 2026-09-25 新增的 57 例：主题来源 8 / hash 字段级 8 / 契约 v1 11 / 窗口底色回传 10 / console 旁路 12 / 材质分层 8；2026-09-26 新增 hash 同步判重 7 例 + **`plugins/dsh-session-log-move` 契约 4 例**）+ `cargo test` **86 例**（2026-09-27：原 85 + T7 pulse 三级回退 1） | `node scripts/verify-all.mjs` | 是 |
| **L2** 插件加载 | 装 profile → 重启 host → 页面刷新 → 插件生效/停用可恢复 | 本文档 §2 | 否（需重启 host） |
| **L3** 实机冒烟 | 桌面壳启动、窗口、主题、桌宠、Canvas、Sidebar、SSH、双模型、外观 | 本文档 §3 | 否（需真机） |
| **L4** 跨线联动 | Fleet pulse → 桌宠；主题 → Canvas/Sidebar；标题栏让位 | 本文档 §4 | 否 |

## 1. L0 + L1：一条命令

```bash
node scripts/verify-all.mjs            # 九线 + 仓库级治理闸门全量
node scripts/verify-all.mjs sidebar    # 只跑一条线（sidebar / canvas / fleet / desktop / ssh / dual-model / appearance / usage / free-model / repo）
```

**全量基线**（**九线 + 仓库级治理闸门**；**静态全量 2026-09-29 实测 161 项全 PASS**
—— sidebar 13 / canvas 13 / fleet 17 / desktop 36 / ssh 31 / dual-model 12 / appearance 18 / usage 3 /
**free-model 15** / repo 3；**内核已升到 DSH `0.2.0-rc.1`**、Node v24.15.0。下表各项标注的是建表时的快照）：

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
| sidebar | 10 | `index.js`/`client.js` 语法 + 8 个测试文件（review-data 5 / review-view 10 / review-grouping 3 / review-view-store 6 / rightbar-guide 4 / terminal-launcher 7 / api-routing 12 / terminal-hub 15，共 62 例） | PASS |
| canvas | 12 | 三入口语法 + 9 个测试文件共 100 例（含 mergeStale 失效、external-views 外部视图槽、header-adaptive 会话头自适应、**store-retention 存储治理**：载荷截断保头+标记 / `result` 保持 `null` / 窗口只留最近 50 条 / ★ 裁剪水位防 replay 复活 / 老 store 载入即迁移并落盘 / 已合规文件不重写；**同步体量预算**（2026-09-26）：全量 `sessions/sync` 独占 2MiB 预算、超限报错带实际字节数、client 侧失败只留痕一次；**DSH 0.1.7 会话导航适配**（2026-09-27）：`ctx.uiWorkspace.openSession` 取代已删除的 `ctx.sessions.open`、画布发消息先打开再借 scope、bridge 失败留痕且 toast 带真实原因） | PASS |
| fleet | 17 | 图与总线判定 10 项（liveness 7 例 / bus-contract 23 / bus-apply 15 / bus-integration 13 / task-graph 13 / capability-graph 17 / verifier 20，共 108 例，及 `task-ready` `agent-pick` `verifier-pick` 的 `--check`、**dispatch 能力闸门接线**）+ server.js 语法 + **fence.cjs 语法 + fleet-monitor 信任围栏 11 例（2026-09-26 新增：三道判定 / 403 不带 CORS 头 / 过围栏才进业务分支）—— 连同上面 7 个文件，全线用例 119 例** + validate-bus + publish-pulse + validate-bus --strict | PASS |
| desktop | 33 | gen-init（令牌校验 + **W0 三道产物自校验**：样式 JSON 可解析且键集一致 / 目录下 `.js` 必须全部登记进 `MANIFEST.order`（漏登记＝静默不打包）/ 写盘字节一致）+ tokens:diff（无漂移）+ **注入脚本语法闸门**（`syntax injected/theme-init.js`——`themes/src/*.js` 拼接产物，WebView2 每个文档都跑）+ **鉴权 cookie 兜底链行为闸门**（6 例：已有 cookie 只按原值续期 / 401 熔断上限与可见提示 / document_start 不误清计数）+ **启动页契约**（11 例：S4a 视觉层 10——动画只准 transform/opacity、扫描线 opacity ≤ .06、零新增色、reduced-motion 全静止、类名纪律、就绪回弹 VM 驱动幂等；S3 拖放安全网 1——只拦文件拖放、官方已消费与文本链接不碰）+ **桌宠资产链完整性闸门**（frames 引用齐全 / 再生源在位 / 无孤儿派生，故障注入四分支自证）+ **patch verify ×6**（模型设置 / 会话头溢出保护 / 轨迹计时恢复 / 消息气泡计时恢复 / cordis client 查询挂起修复 / **消息画廊多图 tile 宽高比**）＋ `plugins/dsh-model-probe` 语法 3 项 + 探测判定表 20 例 + settings 读取双轨 12 例 + `plugins/dsh-free-model-pool` 语法 2 项 + settings-read 10 例 + routes 5 例 + **`plugins/dsh-session-log-move` 语法 2 项 + 槽声明契约 4 例（2026-09-26 新增，合计 33 项）** + **主题来源优先级闸门**（8 例：`__MIA_THEME__` > URL > localStorage > pure，含"非壳环境不报错"与"localStorage 抛异常不崩"两条边界——W0-T0.1）+ **hash 字段级读写闸门**（8 例：精确增删不误伤并发字段 / 保真 `%20` 原始编码 / seq 覆盖保护——W0-T0.2）+ **桌面契约 v1 闸门**（15 例：子 frame 只给空壳 / 能力表与暴露面一致 / 只读纪律不得开 hash 写通道 / **v1.1 写能力**：theme.set 与 window.controls 只派发内部事件、白名单拒绝、人话名不透 `min`/`max`、寄生侧监听静态断言——W1）+ **窗口底色回传闸门**（10 例：半透明底合成到不透明 / 拿不到不透明底即如实放弃不猜色——W4.3）+ **渲染层 console 旁路闸门**（12 例：只旁路不改原生调用 / 只顶层 frame / 环形上限 50 条 / ResizeObserver 调度噪声与红条同判据过滤——W2 收尾）+ **hash 同步判重闸门**（7 例：目标 hash 与当前逐字节一致时一次 `replaceState` 都不发 / 任何真字段变化必须照写 / 心跳同值重发不写入 / `force` 重算 diag 落地 / 判重不得退化成「永不写」——2026-09-26「一直在刷新」修复 P3）+ cargo test **85 例**（2026-09-26 深夜实测；下方括号内明细为历史累计口径，以实测总数为准）（launcher 图标 6 + 桌宠状态机与持久化 16 + 启动链 pulse stale / backend backoff / netstat 解析 6 + 隐藏态主题头像悬浮球 `dot.rs` 7 + **W2 新增**：diag 诊断格式化与 10 份轮转 / 看门狗状态机 / panic hook 12 + recovery sanitizeProfile 备份与中止 / 分级停机状态机 11 + Job 参数与真机 `KILL_ON_JOB_CLOSE` / hex 解析 3 ＋ **2026-09-26 新增**：帧签名剔除心跳（`fragment_signature` 对仅 `petts` 变化的判别，含 8 类真变化不得被吞与 `pettool`/`petkey` 不误伤）1） | PASS（MSVC 环境）※ |
| ssh | 26 | 13 个入口语法（index / client / app / session / sftp-ui / lib/store / lib/runtime / lib/diagnose / lib/exec / lib/paths / lib/sftp / lib/limits / lib/sshConfig —— 2026-09-26 U2.2 等 6 个新模块同批补进静态闸门）+ 13 个测试文件共 225 例（app 21 / client 38 / **diagnose 11** / http 10 / runtime 34 / session 34 / store 10；**2026-09-26 新增 `lib/diagnose.js` + `test/diagnose.test.js` 11 例**：banner 解析 / socket 错误词汇 / DNS 字面量短路 / 真 socket 三形态（零字节 ≠ 超时）/ 真 `ssh2.Server` 验「只发 `none`、服务端看不到密码」/ 出口 IP 逐个回退 / verdict 全分支 / 端到端组装；**2026-09-26 对标 zcode 方案落地新增 6 文件 67 例**：exec 11（POSIX 包装 / exit 早于 data / 排空窗口 / 超时 / 协议行扫描）/ paths 12（词法归一 / NUL / 控制字符 / `~` 展开）/ sftp 14（状态词汇 / 进度节流 / 列目录映射 / 上传降级链 sftp→exec pipe / 下载计数）/ http-sftp 12（真实 HTTP 端到端：票据失效 / teardown 作废 / `..` 归一 / 409 / 413 / execOnly 直降 / 会话打不开自动降级 / op 全分支 / fence 先于票据）/ sftp-ui 9（vm 加载 / 纯函数 / 接线契约）/ sshConfig 9（解析器 / `ssh -G` 合并 / 缓存 / 回退通道）；runtime 29 → 34（keepalive 与错误词汇 / 连接配置纯函数 / SFTP 票据与会话缓存）；U0 故障注入：指纹保存失败 / 跨代确认隔离 / viewer 输入归属 / 尺寸限界 / 背压淘汰 / 重附着预算；U1：分组过滤 / 粘贴守卫 / 颜色合成 / 缓冲查找 / 主题下发 / 会话头列宽手柄隐藏；D2：顶栏消息闭环 / 浮层契约 / `ready`·`status` 帧必须喂状态模型（D-2 回归）/ `canvasAvailable` 段数双向变化（hero 两段）/ 「保存并连接」形态护栏（D-1 回归）；U2：v2 帧契约与 `VERSION_MISMATCH` / 一次性 attach 票据生命周期 / 多 shell 隔离与写权接管 / 关闭语义三分 / 工作区快照恢复与损坏降级 / 序列化快照三路恢复；**U2 实机验收回归：未绑定 shell 不发帧 / 就绪补绑 / 按 `shellSeq` 精确匹配**；**B1/B2 launcher 判据：只在主页（`[data-slot="main.conversation"]` 锚点）**且**本线胶囊不在场（`.dsh-ssh-switch`）时才渲染 —— 与会话头胶囊结构性互斥，旧「推演官方 `useSessions.blank`」判据已删**；**2026-09-26 实机四修：弹层由贴边抽屉改居中悬浮窗（主题球不再压确认键）/ 只读条未连接时常驻修复 / 主机栏连端口一起填不再 `getaddrinfo ENOTFOUND`（`splitHostPort` 就地修正并回写）/ password 分支开 `tryKeyboard`（只开 keyboard-interactive 的服务器密码不再白填）**） | PASS |
| dual-model | 12 | 6 个入口语法 + 5 个测试文件共 33 例（routing 10 / store 7 / content 7 / **invalidation 5**——0.1.7 双轨失效信号 / **client 4**——触发钮在 `/state` 失败态不得禁用）+ 图片准入补丁 `patch verify` | PASS |
| appearance | 18 | 8 个入口语法（index / client / lib-config / lib-splash / lib-avatar / lib-icon-presets / lib-store / lib-fence）+ 9 个测试文件共 120 例（含 M2.6 风格契约、M2.7 预设渲染与落盘、primitives 引用闭环与渲染树签名、2026-09-26「与通用页不重复」去重闸门、V1「选择丸 + Menu」控件闸门、P2 splash 门控/注入安全/退场链路、M3 动效层 CSS 合规与「无可见效果」提示、**M4 会话效果层 CSS 合规 + 六行控件 + 三态应用行为闸门**）+ `derive-skins --check`（M2 皮肤表可复算） | PASS |
| free-model | 15 | 第九线（**2026-09-28 由 desktop 线迁出、更名 `@miasaki/dsh-free-model`**，同批补信任围栏并依次落地 **M1 扫描面升级 / M2 统一页 + 就地入口 / M3 实测与默认模型**）：`lib/{index,trust,settings-read,profile,scan}.js` 语法 **5** 项 + **上游增量补丁 3 件语法 + 1 件自证** ＋ **6 个测试文件（合计 62 例）** —— **trust 15 例**（围栏两层语义：`connection` 401/403/放行/抛错回落与**逐请求读取**；结构层：回环放行 / 非回环 403 / Host 缺失 fail closed / 跨站 403 / 异源与 `Origin: null` 403；路由级：非回环 Host 进不了业务 handler、**围栏先于 method 检查（跨站 POST 得 403 而非 405）**）、**scan 15 例**（来源 A 三条纪律：逐 provider 隔离失败 / 逐调用失败回落 / **能力只到能被证明的程度**；L0 provider 级免 Key 车道与 L1 后缀分层；解析缓存与 refresh；`/scan` 端到端四项）、**client-bundle 9 例**（`node:vm` 真实装载：模块 id = 包名 / 导出面 / **条件注册**（上游在场→让位、不在场→兜底页）/ **绝不注册 `settings.models.*`**（边界闸门：那个槽在编辑面板也会被 dispatch，occupant 一出问题就整树白屏 —— 走的是风险论证，2026-09-28 那次白屏事故的真凶已查明是别的包上的补丁）/ 旧命名零残留 / **样式全走官方主题令牌且无写死色值** / **M3 接线**：实测与默认模型端点 + 探活门控）、**default-model 7 例**（官方写路径四态：成功 / 服务缺席语义化错误 / 参数不合法不碰服务 / 官方抛错透传）、settings-read 10 例（读取双轨 helper 契约）、routes **6 例**（0.1.6/0.1.7 双世界真实路由接线 ＋ **路径唯一闸门**：同路径注册两条 exact 路由会让 webServer 抛 `duplicate exact route`、**整个插件不激活** —— 0.2.0-rc.1 真机教训前移） | PASS |
| repo | 3 | **仓库级治理闸门**（2026-09-26 新增，跨九线生效、不属于任何单线）：**`silent-guards`** —— 守卫必须显式失败（R1 静默跳过守卫 / R2 构建链静默吞错 / R3 静默回退读取 / R4 声明清单缺口；存量 **57 类**冻结在 `scripts/silent-guard-baseline.json`，**新增即失败**，`// guard-ok: <理由>` 可就地豁免）+ **`doc-versions`** —— 根 README 的版本台账与九线 `package.json` 逐字一致 + **`message-sources`**（**2026-09-27 新增**）—— 会话消息的 `source.kind` 不得用 DSH 0.1.7 起退役的 v3 写法（`{ kind: "plugin", … }` ⇒ v4 准入硬拒 ⇒ 整轮运行失败）：扫仓库内源码 **215 文件** + 本机已装插件 **13309 文件 / 7 个 profile**（CI 无 `~/.dsh` 时**显式打印跳过**）；脚本内置自证（正例必命中 / 反例必不误报），故障注入实测 `exit 1` 并点名文件:行，豁免 `// source-ok: <理由>` | PASS |

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
> 自动化覆盖见 `dsh-miasaki-sidebar/test/api-routing.test.js`（9 项，走真实 HTTP）。

## 3. L3：实机冒烟

### 3.0 实机验收台账（可勾选 · 2026-09-26 建立）

> **为什么单列一节**：L0/L1 能自动跑，红了就是红了；L2–L4 只能人工执行，**不做成可勾选项就无法度量**。
> 2026-09-26 实测本文件 checkbox 数为 **0** —— 也就是说「六条线的实机验收全部积压」这件事，
> 在文档里是**不可见的**，没有任何机制保证它会发生。本节唯一用途：让这笔债务**可数、可勾、可交接**。
>
> **勾选口径**：验完一项把 `- [ ]` 改成 `- [x]`，行尾补日期与一句结论（可指向截图/证据路径）。
> 判据正文在各 §（括号内标注），本节只做登记、不重复判据。
>
> **状态：1 / 49 项已验收**（**分母口径 = §3.0 台账里的 checkbox 总数**（48 个 `- [ ]` + 已验的 A16）；
> 第 100 行「勾选口径」说明文字里那处 `- [x]` 是格式示例，不计入）。建立于 2026-09-26，同日更新；
> 外观 +1 项 D7 去重复核，SSH +5 项 A12–A15 SFTP/降级/导入/keepalive + **A16 A1 工具面实机已于同日验完并勾选**；
> **2026-09-27 新增 F3（canvas 会话导航 · DSH 0.1.7 适配）、E9（契约 v1.2 与让位量归壳）、D8（外观 M4 会话效果）
> 与 H1（记忆插件的 v4 消息来源准入 · 见 §3.11）**）。
> **前置**：`dsh web` 重启 + 桌面壳重启 + 浏览器强刷（各节另有前置说明）。

**A. SSH（§3.6，M1 + U0/U1/A0/U2 —— 至今未做过一次真实连接）**

- [ ] A1 真实连接：新建主机（用户名必填、不默认 root）→ 密码/私钥/agent 连接成功且**终端有输出**
- [ ] A2 指纹闭环：首连 TOFU → 指纹变更 mismatch（无「仍然继续」）→ 忘记 → 重连重新 TOFU
- [ ] A3 attach 恢复：切对话/画布再回来 scrollback 回放；同主机重复打开不重复 connect
- [ ] A4 标签语义三分：仅关闭查看 / 关闭此 shell（连接保留）/ 断开整个连接
- [ ] A5 终端功能：Ctrl+Shift+C/V（Ctrl+C 仍中断）、查找 n/m、字号 12–20 且 PTY 跟随、多行粘贴先确认
- [ ] A6 响应式三档：≥960 双栏 / 720–959 紧凑 / <720 抽屉（Esc 关闭、焦点归还）、零横向溢出
- [ ] A7 主题桥接：pure 亮/暗 + 刻刻帝 + 狂狂帝四种组合换肤；**亮色强刷不闪黑底**；切换不断 SSH
- [ ] A8 入口去重（B1/B2）：会话窗口右上角**不得**有独立 SSH 按钮；首屏 hero **有**且点得开；设置/轨迹页**不出现**
- [ ] A9 A0 三种意图：送出选中内容 / 最近 40 行 / 让 Agent 看这个错误 —— 首行 `[SSH <标签> · <用户>@<主机>:<端口>]` 格式正确
- [ ] A10 U2 多 shell 与写权：同主机多开互不串扰、接管后原 owner 转只读、某 shell 退出不影响其余
- [ ] A11 U2 工作区记忆 + 精确恢复：同标签页刷新恢复形状、新标签页不继承；`vim`/`top` 刷新后逐行一致
- [ ] A12 **U2.2 SFTP 往返**：文件面板列目录（`.`/`..` 不显示、大小/时间正确）→ 上传小文件 → 下载回本地字节一致；覆盖上传 409；超过 512MiB 413
- [ ] A13 **exec pipe 降级实机**：在有网关/跳板（exec 与 sftp 两个文件系统视图）的机器上上传，面板自动走命令通道并提示 transport=exec；再次上传仍直走 exec（`execOnlyUpload` 记忆）；mid-stream 失败后重试成功
- [ ] A14 **ssh config 导入**：编辑器「SSH 配置导入」下拉出现本机 `~/.ssh/config` 直连 alias，选中回填 host/port/user；含 ProxyJump 的 alias 禁选且不消失；显式 IdentityFile 的 alias 切「私钥」并填路径
- [ ] A15 **keepalive 长连接**： NAT/防火墙静默断开场景（或对端 `sleep` 模拟）约 60s 内连接报 TIMEOUT 而不是挂在「已连接」；终端有输出时连接不断
- [x] A16 **A1 工具面实机** —— **2026-09-26 已验（三轮：Agent 路径 → 页面路径 → `ssh_session_read`）**：`agentTools: true` 后三工具真进模型工具面（会话 `request/header` 的 54 个工具含 `ssh_exec` / `ssh_hosts` / `ssh_session_read`）；`ssh_hosts` 行首 `id` 可直接当 `hostId`；L0 免审批直通（`uname -a` exit 0）；L1 弹卡「允许」→ 远端收到且 exit 0、「拒绝」→ `APPROVAL_REJECTED` 且**远端 sshd 零新增记录**；人在页面连接主机（终端出现 Welcome + 提示符）后 `ssh_session_read` **读回该终端原文**（含手敲 `ls` 的输出），紧接着 `ssh_exec` 在同一连接上跑通（远端日志 `shell: opened` → `exec: "uname -a"`，**J2 通道分离实证**）；审计落盘 `dataDir/exec-audit.jsonl` 可跨重启查。**页面路径必须与 Agent 路径同口径实测**（本轮靠人工复验才照出 REST 404 / attach 400 两处 connId 口径漂移 —— Agent 走 store 直查永远照不到）。基座 `_refs/scripts-archive/ssh-a1-live/`（真 `ssh2.Server` + 隔离 dataDir + 一次性密钥）

**B. 双模型（§3.10 —— 2026-09-26 才补上判据节）**

- [ ] B1 控件出现：输入框右下角出现「双模型」触发钮（`conversation.input.right`）
- [ ] B2 路由生效：配好辅助模型后拖入图片 → 状态行显示「图片将由「X」处理」
- [ ] B3 纯文本主模型仍可传图：切到纯文本主模型后发送带图消息 → **发得出去且模型读到了图**（不是静默丢图）

**C. Sidebar（§3.4，v0.7.0–v0.10.0 四版积压）**

- [ ] C1 插件加载 + 入口胶囊：`GET /sidebar/api/health` 返回现行版本；引导页出现「审查」**一个**胶囊
- [ ] C2 审查 tab：四视图切换即拉取、目录分组统计 = 组内求和、点名往返持久化、单文件 diff 行级展开
- [ ] C3 审查视图持久化：切到「上一轮更改」→ 关 tab / 刷新 → 重开仍是该视图
- [ ] C4 底部终端面板：Ctrl+` 唤起、多标签多开、cwd 跟随当前会话、刷新后存活会话恢复为可见标签
- [ ] C5 共存与门：canvas 全屏 overlay 盖住右栏为预期；切窗口 60s+ 回来不因隐藏期 TTL 重复拉取

**D. 外观（§3.5 / §3.5b，M2 视觉矩阵 + M2.5/M2.7 图标 + 2026-09-26 去重）**

- [ ] D1 M2 视觉矩阵：皮肤 × 明暗 × 玻璃四档逐组目检（12 组）
- [ ] D2 **关掉即原生**：总开关关闭后与未装本线**逐像素一致**，无残留样式与属性
- [ ] D3 首帧不闪：强刷不出现「先原生、后跳外观」
- [ ] D4 越权防护：非环回 Host / 跨站打 `/appearance/api/state` → 403；未定义路径 → 404
- [ ] D5 应用图标：预设点选 → 1.5–2s 内任务栏 / 窗口左上角 / 托盘三处跟随；上传 / 清单 / 清除回退 / 坏文件不崩
- [ ] D6 桌面壳让位协议：`data-miasaki-theme-yield` 免刷新翻转；切换条双入口；aurora×壁纸叠加
- [ ] D7 **与通用页去重复核**：外观栏**不出现**「明暗偏好（浅/深/跟随系统）」与「正文字号」两行（它们在官方「通用」设置页）；`document.documentElement` 上**无** `data-mia-scheme` 属性；「皮肤」行仍在且说明指向「通用」页
- [ ] D8 **M4 会话效果**（§3.5 两行判据）：六行控件在位且总开关关闭时整组禁用；密度「紧凑」可见消息流收紧；宽度设非 0 会话列跟随且输入卡片不变、改回 0 交还官方；正文字体 / 流式光标（流式中可见、reduced-motion 不闪）/ 引用与代码块三档各见其效

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

**F. Canvas（§3.3）**

- [ ] F1 V1–V4 视觉走查 **18 张**：三主题（pure / zafkiel / kurkuriel）× 明暗 × 三档缩放（0.5 / 0.8 / 1.0），逐张比对圆角·阴影·边框·线宽·字阶（截图清单见 `dsh-miasaki-canvas/design/2026-09-12-canvas-visual-refinement.md` §10）
- [ ] F2 字重决议素材：截 720 vs 600 对比图，拍板是否下调（`styles.css` 现存 6 处 720）
- [ ] F3 **会话导航三连（DSH 0.1.7 适配，2026-09-27）**：画布里点任一卡片 → DSH 当前会话随之切换、**画布不关且不弹红条**；卡片/检查器里的回跳按钮 → 跳到对应 DSH 会话并关闭画布；画布内对某会话发消息 → 消息真的落到该会话（DSH 主区可见该提问）。console 无 `dsh-canvas: * 失败` 告警；反例（删掉一个会话后点它的卡）→ 红条带**真实原因**（`sessions.retain: unknown session …`）而不是空文案

**G. 跨线联动（§4）**

- [ ] G1 Fleet pulse → 桌宠 / pulse stale 回落 / worker 心跳过龄降级
- [ ] G2 主题 → Canvas / 标题栏 → Canvas·Sidebar 让位
- [ ] G3 DSH 审批 → 桌宠 `wait` 姿态 + 常驻气泡

**H. 平台与插件生态（§3.11）**

- [ ] H1 **记忆插件的 v4 消息来源准入**（2026-09-27 用户报障「本轮运行失败 format v4 message requires a producer-owned source kind」的修复验证）：重启 miasaki 桌面端（或 `dsh web`）后触发一轮记忆召回 → **不再出现该错误行**；`node scripts/inspect-session-sources.mjs` 能看到新写入消息的 source kind 为 `plugin:openviking-memory`；`node scripts/check-message-sources.mjs` PASS（判据正文见 §3.11）

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

### 3.2 桌宠

拖动 / 单击 / 双击 / 右键菜单 / 隐藏与恢复 / 屏幕外位置找回 / 分辨率变化 / 主题切换换角色。

#### 3.2.1 新素材上屏（2026-09-28 实测，判据来自一次真实失败）

| 检查项 | 通过判据 |
|---|---|
| 部署素材与仓库一致 | `C:\ProgramData\MiasakiApp\ui\pets\frames.json` 与仓库 `ui/pets/frames.json` SHA256 相同；`ui/pets/whale/frames/` 存在且 **46 帧**；旧 `inverse/raw/blue-*.png` 已随镜像删除 |
| 部署 exe 晚于最后一次素材改动 | `Get-Item C:\ProgramData\MiasakiApp\Miasaki.exe \| Select LastWriteTime` 晚于素材的 mtime |
| **运行时确实加载了新素材** | `%LOCALAPPDATA%\miasaki\pet.log` 出现 `tick0 … whale_rows=7`（**旧 `frames.json` 下恒为 0** —— 这是「素材真的上屏了」唯一可靠的运行时判据） |

> **为什么必须验第三行**：`assets.rs::read()` 是「磁盘 `ui/`（EXE 旁）优先、编译期内嵌兜底」，
> 部署目录里的旧素材会**遮蔽**新编译进去的新素材。2026-09-27/28 的 whale 图集与白军装反转狂三
> 就这样在实机上失效了一整天 —— 代码、单测、资产闸门**全绿**，只有这一行日志能戳破。
> 根因与修复见 desktop `design/CHANGELOG.md` 2026-09-28（续五）。

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
| **辅助对话 tab（M2.1，2026-09-28）** | 点「辅助对话」胶囊 → 右栏出 tab（页型，同格去重）；点「新建侧线」→ fork 出侧线，**面板里渲染出主会话继承来的历史**（官方 embedded 会话 + 原生 composer）；侧线头显示「主会话：<标题>」与提示条「说『继续』等于接着做主线未完成的活」 |
| **侧线不打断主任务（M2.1 核心）** | 主会话**正在跑**时点「新建侧线」：侧线立刻可用，**主会话继续跑完不中断**；侧线继承的历史**止于上一个已完成轮次**，不含正在跑的增量。反例：主会话**首轮运行中**（0 个完成轮次）→ 出人话引导「先让主会话跑完一轮」，不是宿主错误串 |
| **侧线登记表与刷新还原（M2.1）** | 开侧线后 localStorage 出现 `miasaki-sidebar:sidechat:v1`（`{父会话: {activeChildId, lines[]}}`；fork 成功即写盘）；**刷新页面**后官方右栏自动还原 tab、且面板显示的是**同一条侧线**（childId 不变、不重复 fork）——官方持久化里没有 `params`，这条身份只能靠登记表 |
| **多侧线切换（M2.1）** | 同一主会话开第二条侧线 → 侧线头出现「侧线 1 / 侧线 2」切换器；来回切换不报错，正文各自对应 |
| 审查 tab | 四视图下拉**切换即拉取**（未暂存 / 已暂存 / 全部分支更改 / 上一轮更改；空视图显示「无改动」）、目录分组默认折叠且组统计 = 组内求和、未点名徽标、点名往返持久化、单文件 diff 行级展开 |
| **审查视图持久化** | 切到「上一轮更改」→ 关闭 tab 或刷新页面 → 重开审查 tab 仍是「上一轮更改」（键 `miasaki-sidebar:review-view`） |
| 窗口可见性门 | 切到别的窗口 60s+ 再回来，审查 tab 不因隐藏期间的 TTL 重复拉取 |
| **底部终端面板** | 标题栏终端按钮 / Ctrl+` 唤起底部面板；标签栏多开（`＋` 新建 / `×` 关闭 / 右键菜单 / `▾` 溢出）、cwd 跟随当前会话、未安装 shell 置灰、失败显示原因 + 重试；刷新后存活会话恢复为可见标签 |
| 与 canvas 共存 | canvas 全屏 overlay 盖住右栏为预期；右栏层级现由官方框架决定，本线不再声明 z-index 约束 |

### 3.5 外观（`@miasaki/dsh-appearance`，M1 + 2026-09-26 去重 + 2026-09-27 M3 动效 / M4 会话效果）

| 检查项 | 通过判据 |
|---|---|
| 设置栏出现 | 设置面板左栏出现**「外观」**，位置在「通用」之后、「模型」之前（`settings.section` 的 `order: 5`） |
| 契约状态条 | 面板顶部显示绿色「契约自检通过」；有降级项时显示黄条并逐条列出（缺插槽 / 主题接口 / 中栏锚点 / token / 桌面壳主题在位） |
| **与通用页不重复** | 外观栏**没有**「明暗偏好（浅色 / 深色 / 跟随系统）」与「正文字号」两行——它们是官方「通用」设置页 `AppearanceRow` / `FontSizeRow` 自己的行（2026-09-26 去重，两处曾是同一 `ctx.theme` 偏好的第二入口）；DevTools 里 `document.documentElement.getAttribute('data-mia-scheme')` 为 `null`（镜像属性已移除）。**回退 = 第二入口复活** |
| 皮肤（本线独有） | 纯净 / 刻刻帝 / 狂狂帝三选一（**官方选择丸 + Menu**：h36 圆角丸右缀箭头，点开下拉、键盘 ↑↓/Esc 可用，当前项有勾选）；选中刻刻帝时官方「通用」页的三立方被拨到「深色」一次（此后用户自改明暗不拉回）；`curl /appearance/api/skin` 返回 105 token 表 |
| 控件形态（V1，2026-09-26） | 皮肤 / 壁纸图源 / 玻璃档位 / 我的上传 四行全是**选择丸 + 下拉**（与官方「通用」页的语言行、权限行同规格），**不是一排胶囊**；长文件名在选择丸内截断、悬停 title 给全名；运行信息是面板底部一行小字（M3 动效板块与 M4 会话效果板块 2026-09-27 已从占位升级为真控件，见下两行） |
| Boot Splash（P2，2026-09-26） | 冷启动（后端已热）可见全屏启动画：皮肤底色 + 纹章双环旋转（刻刻帝顺 / 狂狂帝逆 / 纯净静止）+ MIASAKI wordmark + 三点流动；shell 挂载后 **≤400ms** 淡出、无「splash → 原生 → 外观」三段跳；三主题 × 明暗下底色/强调色随之；系统开「减少动画效果」后全部静止、功能不变；`~/.dsh/miasaki-appearance/config.json` 的 `version` 为 5、`motion.bootSplash` 为 `auto` |
| Boot Splash 硬用例（401 / 关掉即原生） | ① 未认证访问（dsh web 打印的 URL 未带 token）首帧非 shell ⇒ splash **2.5s 内淡出**、不挡住「重新打开 URL」提示；② 总开关关闭或 `motion.bootSplash:'off'` ⇒ 首帧与原生 **diff = 0**（无 splash 三行、无 `#mia-splash` 节点、无 `data-mia-splash-done` 残留） |
| 动效（M3，2026-09-27） | 「动效」板块三控件在位：官方 Switch 总开关 + 预设选择丸（流畅 / 优雅 / 极简）+ 强度步进器（0.5×–1.5×）。开总开关后：切会话 / 开右栏 / 打开本设置面板可见**容器入场**——宽扁容器（会话表面 / 设置面板）竖向浮起 + 轻微缩放，**侧栏 / 右栏窄高竖条横向滑入（不缩放，贴官方折叠 rail-in 语汇）**；强刷页面可见加载错峰（侧栏 → 会话 → 右栏先后入场）；切预设与调强度倍率即时改变观感；关总开关后入场消失、页面回原生 |
| 动效降级硬用例 | 系统设置开「减少动画效果」（`prefers-reduced-motion: reduce`）⇒ 所有入场收敛为 **100ms 淡入**、无位移无错峰，功能不变；DevTools 渲染面板模拟 reduce 同效 |
| 总开关往返 | 开 → `document.documentElement.dataset.miaAppearance === 'on'` 且 `~/.dsh/miasaki-appearance/config.json` 的 `enabled` 为 `true`；关 → `'off'` 且为 `false` |
| 修订冲突可复现 | 两个标签页都开面板：A 改一次后，B 用旧修订提交 → B 显示「配置已被其它窗口修改，已载入最新值」，不静默覆盖 |
| **关掉即原生** | 总开关关闭时（或把本线移出 profile roster 重启后）：页面与未装本线时**逐像素一致**，无残留样式与属性 |
| 首帧不闪 | 强刷页面不应出现「先原生、后跳外观」的闪变（M1 只写三个 `data-*` 属性；闪色风险在 M2 皮肤落地时才会出现） |
| 越权防护 | 非环回 Host 头或跨站请求打 `/appearance/api/state` → **403**；未定义路径 → 404 |
| 会话效果（M4，2026-09-27） | 「会话效果」板块六行真控件：消息密度（舒适 / 紧凑）、会话最大宽度（步进器 0–1600px、0 = 官方默认）、正文字体（默认 / 衬线 / 等宽）、流式光标（Switch + 细条 / 方块 / 下划线）、引用与代码块（默认 / 简约 / 强调）。外观栏**不出现**「字号」步进器（那是官方「通用」页 `FontSizeRow`） |
| 会话效果行为（M4 三态） | ① 密度选「紧凑」⇒ 消息流间距收窄（`document.documentElement` 出现 `data-mia-cv-density="compact"`）；② 宽度设非 0 ⇒ 会话列变宽 / 变窄且输入卡片宽度不变（`data-mia-cv-width="on"` + `<html style>` 上 `--mia-cv-width`）；改回 0 或关总开关 ⇒ 属性与变量全清、宽度交还官方；③ 正文字体 / 流式光标 / 引用与代码块三行各切一档 ⇒ 与会话列内相应变化（光标仅在流式输出期间出现在正文末尾，系统「减少动画效果」时不闪烁） |
| 配置版本 | `~/.dsh/miasaki-appearance/config.json` 的 `version` 为 **6**，`theme` 板块**只有** `skin` 一个字段（v3 及更早的 `scheme` / `accent` / `fontSize` 残留被丢弃，2026-09-26 去重）；`motion` 板块含 `bootSplash`（v5）；`conversation` 板块含 `density / maxWidth / font / cursor / quoteCode` 五字段（v6，出厂全首档 = 不注入任何规则） |

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
> 注入没问题，是可见性条件没凑齐。（遗留产品改进：面板可在「无可见效果」时给一行提示，列入 P4。）

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

### 3.6 SSH（`@miasaki/dsh-ssh`，U0+U1+A0+D2–D4+U2+G1/G2 清单）

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

**D2 全屏浮层实机验收（2026-09-15，真实 GUI **20 项门槛全过**）**：驱动 `_refs/scripts-archive/ssh-d2-accept/run-accept.mjs`（真浏览器 × **真实 GUI** × 真实鼠标/键盘事件 + 本地假 sshd 真协议端点；约 6 分钟可复现，证据 `accept-result.json` + `shots/*.png`）。与「探针宿主页」验收的本质区别：**从用户能点的元素出发、走 hit-test**（D1「单向门」教训）。已验：hero launcher / 会话头胶囊两条入口真实点击开浮层；浮层五点采样 hit-test 全落浮层内（官方 UI 不可达）；顶栏三段胶囊 + SSH `aria-current="page"` + **宿主文档零顶栏**；顶栏只三按钮（工具区控件不在其中）；「对话」退出 + 焦点归还入口；`Esc` 不关闭；Shift+Tab 反向可达「对话」且 focus-visible solid 2px；SSH↔画布**双向**互斥；记忆语义（开着刷新恢复 / 关后刷新停在对话）；**真协议零损失**（关闭期间零 resize 帧、重开 iframe 未重载、30 次开关零帧且 SSH 侧 shell 恒为 1）；三主题切换 + 顶栏 reserve 消费（`padding-right = 14 + 150`）；壳内入口与窗控不叠压。
**同轮附带两条非 D2 发现（已于同日修复，用户定向「两条一起修」）**：**D-1**（阻断）「保存并连接」从不发起连接（意图标记曾挂在按钮 `event` 上 ⇒ 解析到全局 `window.event`，`dispatchEvent` 后读不到；改走闭包变量）；**D-2**（体验）指纹确认后状态栏/横幅不追平（`session.js` 曾只把 `ready`/`status` 帧写成文案、不喂状态模型；现统一转发 `onFrame`）。另：hero 态无画布入口 ⇒ 顶栏「会话布」**已按诚实降级收口**（宿主下发 `canvasAvailable`，hero 态只渲染「对话｜SSH」两段、进入会话后三段回归）。**当日修复后重启 host 复验：`allPassed=true`，24 项门槛全 PASS、0 FAIL**。详见 `dsh-miasaki-ssh/design/2026-09-14-ssh-fullscreen-overlay-plan.md` §16。

**D3 全屏浮层清理与回归实机验收（2026-09-15，8 项门槛 7 PASS）**：驱动 `_refs/scripts-archive/ssh-d3-accept/run-d3-accept.mjs`（同 D2 通道：真 GUI × 真实事件 × 假 sshd 真协议）。**通过项**：① **四档宽度按视口语义落位**（1280 rail 232 / **960 rail 208 —— 恰在断点值落紧凑档** / 720、480 抽屉；四档零横向溢出）；② 三主题 × 1280/480 零溢出 + 顶栏稳定 + reserve `padding-right:164px`；③ A0 文案「点左上「对话」退出后粘贴」+ 剪贴板首行格式正确；④ 官方 tab 栏无 SSH；⑤ 会话态官方 `[data-width-handle]` 正常显示（本线未再隐藏）；⑥ 回退视图面零残留（`.dsh-ssh-view` / 临时退出条）；⑦ 真实连接链路。**D3-F1 已闭环**（用户定向「现在就删」）：`client.js` 注入样式里那条 `div[data-phase]:has(...) [data-width-handle]` 死规则已删除（回退视图已删 ⇒ `:has()` 永不命中），旧断言改写为「零残留/零触碰」并新增回归断言 ⇒ 本节「`grep` 应无命中」判据达标。单测 **81 例**、`verify-all ssh` **12/12**。详见方案 §18。

**D4 尾项清理实机验收（2026-09-15，6 项门槛全 PASS）**：驱动 `_refs/scripts-archive/ssh-d4-accept/run-d4-accept.mjs`（同通道；**尾项①②取运行态证据**）。**①`renderBanner` 隐藏即清空**：可见态 `hidden:false / childCount:3` → 连接完成后 `hidden:true / display:none / **childCount:0**`（旧实现只设 `hidden`，节点残留）；断开后横幅再现 `childCount:4` ⇒ 清空未破坏功能。**③过渡区间落位**：1280 → rail 232 / 860 → rail 208（紧凑档）/ 600 → 抽屉 / **500 → 抽屉且 `.tools .optional` 可见（480 档未触发）** / 480 → 隐藏（480 档命中）；五档零横向溢出。**②运行态**：30 次开关零异常 + iframe 未重载 + 远端零 resize 帧；静态侧 `observe(header,{childList,subtree})`、`aria-selected` 仅剩注释。**附带**：注入样式零 `width-handle`（D3-F1 实机复核）。单测 **82 例**、`verify-all ssh` **12/12**。详见方案 §20。

**U2 主体实施（2026-09-16，实机验收待跑）**：`dsh-miasaki-ssh/design/2026-09-15-ssh-u2-plan.md` §6 的 **U2.1 多 shell / U2.3 工作区记忆 / U2.4 精确恢复**已落地（**U2.2 SFTP** 留待真实主机补验后开工）。单测 **85 → 110 例**（runtime 22 / session 32 / http 7 重写适配 v2 契约，app 16 / client 25 / store 8 无回归）、`verify-all ssh` **12/12**；端到端探针（真 sshd × 本线 `SshRuntime`）**9/9**；**回滚演练实际执行**（基线恢复 85/85 绿 → U2 还原 110/110 绿）。上表 **U2 四行**即本轮实机验收判据，明细见 `dsh-miasaki-ssh/README.md` 与 `dsh-miasaki-ssh/design/CHANGELOG.md` 第十二批（含「规划决策 5 的 `app.js` 纯搬迁拆分未执行」的偏离登记）。

**入口判据两连修（2026-09-25，B1 越界 + B2 去重）**：用户两次报障驱动 —— ①「右上角 SSH 按钮应该只在主页显示，而不是每个界面都有」（B1：`shell.overlay` 是 root 级浮层、每屏都渲染，补「在主页」这一维，锚 `[data-slot="main.conversation"]`）；②「会话窗口右上角不应该有 SSH 按钮 —— **重复了，胶囊有 SSH 按钮入口**」（B2：旧判据推演官方 `useSessions` 的 `SessionSummary.blank`，而官方决定会话头 chrome 渲不渲染的是 `blank = session === void 0 || conversation === void 0 || (session.blank && conversationPhase(...) === 'blank')` —— 两个 blank **语义不同**，summary 仍为 provisional blank 但会话阶段已不是 blank 时，官方 `hideChrome = false` ⇒ 胶囊在、旧判据也返回 hero ⇒ launcher 同时在场）。**修法**：launcher 判据收敛为 `onConversationHome() && !ownEntryPresent()`（`.dsh-ssh-switch` 不在 DOM 才渲染），探的是**本线自己的产物**（与 `syncChrome()` 用 `.dsh-canvas-switch` 算 `canvasAvailable` 同源），不受官方 blank / conversationPhase 语义漂移影响；两层组件合并为一层（不再消费官方 prop）。单测 **115 → 117 例**、`verify-all ssh` **12/12**。**实机复验即上表「入口去重（B1/B2）」行**，明细见 [CHANGELOG](../dsh-miasaki-ssh/design/CHANGELOG.md)（B1 / B2 两节）。

**弹层形态改造：右侧抽屉 → 居中悬浮窗（2026-09-26，实机反馈 + 探针实测）**：用户截图 —— 桌面壳右下角主题球（`#miasaki-switcher .ms-btn`，fixed `right/bottom 16px` 的 46px 圆 + 6px 光晕，`z-index 99990`）盖住贴边抽屉右下角的「确认」键。**修法是改形态而非再加一条让位**（贴边形态的右下角与球必然共享同一块像素）：`.sheet` 改为居中悬浮窗（遮罩口径照官方设置面板、24px 圆角、`max-height: calc(100% − 64px)`），并新增第二条让位口径 `--ssh-shell-fab-safe-right`（球左缘距 iframe 右缘 + 光晕 + 呼吸）→ 卡片宽度 `min(560px, 100% − 2×max(32px, 安全线))`，窄窗口自动缩窄避球；`--ssh-chrome-clearance` 保留（改挂在遮罩层 `padding-top`），`--ssh-chrome-avoid-right` 与 `openSheet` 的 `wide` 死参数退役。**探针实测（归档 `_refs/scripts-archive/ssh-modal-verify/`，宿主页加载真实壳注入产物自建窗控组与主题球 + 真实 `app.js`/`styles.css`）五场景全过**：1540×1042 新建主机 / 640×820 / **480×640 极窄** / 1540×1042 连接密码 / 无壳 chrome 浏览器形态；「保存并连接」「确认」与球的**重叠面积全为 0**。单测 **127 例**、`verify-all ssh` **12/12**。**上表新增行即本轮实机判据**（需重启 `dsh web`，改的是 `app.js` / `styles.css`）。

**对标 zcode 方案落地：P0 三件套 + U2.2 SFTP + P1-1 ssh config 导入（2026-09-26，用户拍板「按建议开工」）**：详见 [dsh-miasaki-ssh/design/CHANGELOG.md](../dsh-miasaki-ssh/design/CHANGELOG.md) 同名条目与 [zcode 对标调研与方案](../dsh-miasaki-ssh/design/2026-09-26-ssh-zcode-benchmark-plan.md)（v1.1）。① **P0-1 连接健壮性**：keepalive 15s×3（真协议探针 6/6 PASS：60043ms 报 `Keepalive timeout` 归 `TIMEOUT`）；`buildConnectConfig()` 纯函数化；`classifyError()` 新增 ssh2 `level` 分级与私钥口令两码。② **P0-3 exec 前置**（`lib/exec.js`）：POSIX `/bin/sh -c` 包装 / close 收尾 + exit 码优先 + 50ms 排空 / banner 跳过。③ **U2.2 SFTP**：8 个 REST 端点 + `sftp-ui.js` 右抽屉 + zcode 降级链（sftp 视图无目录/会话打不开 ⇒ 零字节消耗直降 `mkdir -p && cat >`；mid-stream 失败记 `execOnlyUpload` 下次直走命令通道——**偏离登记**：单次 HTTP 源流不可回放，不就地降级）；路径安全收敛 `lib/paths.js` 一处。④ **P1-1 ssh config 导入**：`ssh -G` 优先 + 自研解析回退，只导直连 alias。单测 **153 → 225 例**；**闸门同步补强**：6 个新模块进静态语法闸门，`verify-all ssh` **14/14 → 26/26**（此前新模块只靠 `package.json` 的 build 脚本检查，回归里看不见）。**上表新增四行即本轮实机判据**（需重启 `dsh web`）。

**dsh-web 引擎层加固 G1/G2（2026-09-27，方案 [2026-09-27-ssh-dshweb-engine-gap-plan.md](../dsh-miasaki-ssh/design/2026-09-27-ssh-dshweb-engine-gap-plan.md)）**：① **G1 SFTP 自愈**——`sftpSession()` 挂 close 监听清死引用 + `isSftpTransportFailure()` + `withSftp()` 当次重开一次（仅一次）；② **G2 背压暂停**——`ShellChannel.pauseOutput/resumeOutput` + 水位（2MiB 暂停 / 512KiB 恢复 / 30s 超时或 8MiB 兜底断开），新帧 `output.paused`/`output.resumed` 只做 host→browser 状态栏展示。单测 **299 → 310 例**、`verify-all ssh` **31/31**；真协议探针归档 `_refs/scripts-archive/ssh-g1-g2-probe/`（G1 关子系统自动重开 7/7、G2 慢 consumer 暂停而非断开 11/11）。**上表新增两行即本轮实机判据**（需重启 `dsh web`，改的是 `lib/` 与 `session.js`/`app.js`）。

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
| 差分标记 | 复制时**刻意排除** kulumi 项目（7 个会话）：若列表来自全局 root，这 7 个 id 必然出现 | ✅ 6 个出现 0 次；第 7 个仅出现在 canvas 的工作区引用里 |
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
| 全量回填 | 新账本按会话 `cwd` 自动归组 | ✅ 242 个会话归位 **237**：dsh-miasaki 227 / kulumi 7 / Dhow 2 / Asakii 1 |
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
