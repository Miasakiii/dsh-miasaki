# 七线统一回归矩阵（smoke-test-matrix）

> 建立于 2026-09-07。四条线代码零耦合，但共用一个 DSH host 与一个桌面壳，
> 回归必须分层：能脚本化的进 `scripts/verify-all.mjs`，需要真机/真 host 的留在本文档手动执行。

## 0. 分层定义

| 层 | 内容 | 载体 | 可自动化 |
|---|---|---|---|
| **L0** 静态检查 | 语法（`node --check`）、令牌完备性、令牌漂移 | `node scripts/verify-all.mjs` | 是 |
| **L1** 单线单测 | Canvas 89 项、Sidebar 62 项、SSH 113 项、双模型 24 项、外观 81 项、Fleet 108 项、Desktop 18+25 项 | `node scripts/verify-all.mjs` | 是 |
| **L2** 插件加载 | 装 profile → 重启 host → 页面刷新 → 插件生效/停用可恢复 | 本文档 §2 | 否（需重启 host） |
| **L3** 实机冒烟 | 桌面壳启动、窗口、主题、桌宠、Canvas、Sidebar、SSH、双模型、外观 | 本文档 §3 | 否（需真机） |
| **L4** 跨线联动 | Fleet pulse → 桌宠；主题 → Canvas/Sidebar；标题栏让位 | 本文档 §4 | 否 |

## 1. L0 + L1：一条命令

```bash
node scripts/verify-all.mjs            # 七线全量
node scripts/verify-all.mjs sidebar    # 只跑一条线（sidebar / canvas / fleet / desktop / ssh / dual-model / appearance）
```

**2026-09-19 实测基线**（七线全量重跑，共 **81 项检查**；DSH 0.1.5-rc.1 / Node v24.15.0）：

| 线 | 项数 | 内容 | 结果 |
|---|---:|---|---|
| sidebar | 10 | `index.js`/`client.js` 语法 + 8 个测试文件（review-data 5 / review-view 10 / review-grouping 3 / review-view-store 6 / rightbar-guide 4 / terminal-launcher 7 / api-routing 12 / terminal-hub 15，共 62 例） | PASS |
| canvas | 11 | 三入口语法 + 8 个测试文件共 89 例（含 mergeStale 失效、external-views 外部视图槽、header-adaptive 会话头自适应） | PASS |
| fleet | 15 | 图与总线判定 10 项（liveness 7 例 / bus-contract 23 / bus-apply 15 / bus-integration 13 / task-graph 13 / capability-graph 17 / verifier 20，共 108 例，及 `task-ready` `agent-pick` `verifier-pick` 的 `--check`、**dispatch 能力闸门接线**）+ server.js 语法 + validate-bus + publish-pulse + validate-bus --strict | PASS |
| desktop | 11 | gen-init（令牌校验）+ tokens:diff（无漂移）+ patch verify ×5（模型设置 / 会话头溢出保护 / 轨迹计时恢复 / 消息气泡计时恢复 / cordis client 查询挂起修复）+ `plugins/dsh-model-probe` 语法 2 项 + 连通性探测判定表 18 例 + cargo test 25 例（pulse stale 语义 + 立绘回落链 + 桌宠 Alert 提醒模型 3 例 + 软件头像契约 6 例） | PASS（MSVC 环境）※ |
| ssh | 12 | 6 个入口语法（index / client / app / session / lib-store / lib-runtime）+ 6 个测试文件共 113 例（U0 故障注入：指纹保存失败 / 跨代确认隔离 / viewer 输入归属 / 尺寸限界 / 背压淘汰 / 重附着预算；U1：分组过滤 / 粘贴守卫 / 颜色合成 / 缓冲查找 / 主题下发 / 会话头列宽手柄隐藏；D2：顶栏消息闭环 / 浮层契约 / `ready`·`status` 帧必须喂状态模型（D-2 回归）/ `canvasAvailable` 段数双向变化（hero 两段）/ 「保存并连接」形态护栏（D-1 回归）；U2：v2 帧契约与 `VERSION_MISMATCH` / 一次性 attach 票据生命周期 / 多 shell 隔离与写权接管 / 关闭语义三分 / 工作区快照恢复与损坏降级 / 序列化快照三路恢复；**U2 实机验收回归：未绑定 shell 不发帧 / 就绪补绑 / 按 `shellSeq` 精确匹配**） | PASS |
| dual-model | 10 | 6 个入口语法 + 3 个测试文件共 24 例 + 图片准入补丁 `patch verify` | PASS |
| appearance | 14 | 6 个入口语法（index / client / lib-config / lib-avatar / lib-store / lib-fence）+ 7 个测试文件共 81 例（含 M2.6 风格契约）+ `derive-skins --check`（M2 皮肤表可复算） | PASS |

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
| host 半生效 | 重启 `dsh web` | `GET /sidebar/api/health` 返回当前 `version`（sidebar 现为 `0.6.0-miasaki.0`） |
| client 半生效 | 重启 host **后**刷新页面 | 会话头 / 标题栏出现按钮 |
| 停用可恢复 | 移除插件 → 重启 host | DSH 原生界面无残留（右栏推挤复位、会话头按钮消失） |
| 运行时补丁在位（5 个） | 对 `dsh-miasaki-desktop/patches/*/patch.mjs` 逐个 `node … status`（settings-models / conversation / trajectory / chat / cordis-host-runner） | 输出 `patched`；**DSH 升级后变 `unknown` 即需按该目录 README 重打**；trajectory 与 chat 两个计时补丁**必须一起重打**（同一个 `firstTokenTime` 的两处显示）；cordis-host-runner 是唯一作用于 **host 侧 Node 包**的补丁，改完必须**重启 host**（其余四个作用于浏览器 bundle，刷新页面即生效） |
| 双模型准入补丁在位 | `node dsh-miasaki-dual-model/patches/dsh-api-session-controller/patch.mjs status` | 输出 `patched`；**该补丁与 dual-model 插件必须同版本上线**——补丁负责放行、插件负责真的有人能处理图片，只打前者会让图片被静默丢弃 |
| 计时面板可恢复 | 刷新页面 → 打开任一**已结束**步骤的轨迹计时面板 / 悬停消息耗时面板 | 首 token 延迟、生成、吞吐量三行与气泡「首 token 用时（TTFT）」均为数字（修复前为「首 token 时间不可用」） |
| 外观线 host 半生效 | 重启 `dsh web` → `curl -s http://127.0.0.1:3080/appearance/api/state` | 返回 `{"config":{…},"revision":N,"persistent":true}`；`persistent:false` 表示 `cordis.patch.yml` 的 `dataDir` 没传进 config（改动只存在于内存） |
| 模型探测插件 host 半生效（连通性 v2） | 重启 `dsh web` → `curl -s http://127.0.0.1:3080/model-probe-api/health` | 返回 `{"ok":true,"version":"0.1.0","protocols":[…],"timeoutMs":15000}`。**404 = 插件未被 host 加载**——此时设置页按钮会自动降级为目录探测并附提示（功能不缺失，但口径变旧） |

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

### 3.5b 软件头像 → 启动器图标（appearance × desktop 跨线，2026-09-21）

前置：**`dsh web` 与桌面壳都要重启**（appearance 改了 host 半——新增路由；desktop 改了 Rust）。
契约（配置路径 / 文件名白名单 / 目录）见 `appearance-launcher-icon-2026-09-21.md`。

| 检查项 | 通过判据 |
|---|---|
| 板块出现 | 设置 → 外观 → 「软件头像」显示预览位 + 「上传图片…／清除」+ 已有文件选择器；契约条**无** `avatar-host-stale` 黄条（有 = host 未重启） |
| 上传即预览 | 点「上传图片…」选一张非 PNG（如 jpg）→ 面板预览立刻显示该图；`~/.dsh/miasaki-appearance/avatars/` 出现 `avatar-<时间戳>-<随机>.png` |
| **图标跟随** | 约 1.5–2 秒内：桌面端**任务栏**、**窗口左上角**、**托盘**三处图标同时变成该图（无重启、无重开窗口） |
| 清单选择 | 目录里手动放入一张白名单命名的 PNG → 重新打开面板出现在选择器里 → 选中即生效 |
| 清除回退 | 点「清除」→ 三处图标回到出厂图标（`avatar.source` 变空串） |
| 坏文件不崩 | 把 `config.json` 的 `avatar.source` 指向不存在的文件名（或写入非 PNG 内容）→ 桌面端**照常启动/运行**，图标回退出厂值，`%LOCALAPPDATA%\miasaki\pet.log` 有一行 `launcher-icon:` 说明 |
| 边界如文案所述 | EXE 文件自身图标与桌面 / 开始菜单快捷方式图标**不随设置变化**（构建期资源，面板文案已写明） |

### 3.6 SSH（`@miasaki/dsh-ssh`，U0+U1+A0+D2–D4+U2 清单）

前置：`dsh web` 重启 + 浏览器强刷；验收矩阵细化项见 `dsh-miasaki-ssh/design/2026-09-12-ssh-workspace-plan.md` §10 与 `dsh-miasaki-ssh/design/2026-09-14-ssh-agent-driven-plan.md` §17。
**注意**：`index.js` 的 `cachedAsset` 对静态资源做进程内一次性缓存 — 改了 `app.js` / `session.js` 后**必须重启 `dsh web`**，浏览器强刷不够。

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
| **A0 · 按钮启用态** | 未连接时工具区「送往对话」按钮置灰；连上后可用；点击弹出三项菜单（送出选中内容 / 送出最近 40 行 / 让 Agent 看这个错误） |
| **A0 · 三种意图** | ① 终端选中文本 → 「送出选中内容」→ 状态栏报字符数；粘贴到对话，**首行为 `[SSH <标签> · <用户>@<主机>:<端口>]`**，其后是选中文本，无多余空行；② 「送出最近 40 行」→ 正文为最近输出且**末尾空白行已被裁掉**；③ 「让 Agent 看这个错误」→ 首行在来源标记后追加「帮我看下这段终端输出有什么问题：」，正文为最近输出 |
| **A0 · 右键菜单与边界** | 终端内右键弹出同一份三项菜单（不再弹浏览器默认菜单）；**空缓冲区/未选中时给出明确提示而非静默**；全程**终端内容不变、不向远端发送任何字节**（可对照远端 `history`/`echo` 验证）；复制后不自动发送，需人工粘贴 |
| **U2 · 多 shell 与写权** | 标签栏「+」与主机菜单都能新建 shell；同主机可开多个 shell（上限 8）且**尺寸 / 输出互不串扰**；非 owner 的输入与 resize 被拒（写权只归一个 viewer）、接管后原 owner 立即转只读并在状态栏提示；关闭对话框三分语义正确（仅关闭查看 / 关闭此 shell（连接保留）/ 断开整个连接）；**某个 shell 退出后同连接其余 shell 继续存活**；WS 旧帧 / 过期票据一律拒收并给可操作提示 |
| **U2 · 工作区记忆** | 偏好（字号 / rail 折叠 / 专注）刷新后保留；工作区快照（标签集合 + 激活项 + 抽屉状态）在**同一标签页刷新**后恢复形状、**新开标签页不继承**；host 侧已失效的连接**不自动重连、不填凭据**，静默丢弃并提示；快照损坏 / 无痕模式下回默认、不白屏 |
| **U2 · 精确恢复** | 页面刷新后 `vim` / `top` 等 alt-screen 全屏程序**逐行一致**（快照优先路径）；重附着不重复整段回放（防翻倍）；addon 缺失时降级为回放恢复；长时间大输出后刷新不卡顿（快照封顶 128KiB / 500 行） |

**D2 全屏浮层实机验收（2026-09-15，真实 GUI **20 项门槛全过**）**：驱动 `_refs/scripts-archive/ssh-d2-accept/run-accept.mjs`（真浏览器 × **真实 GUI** × 真实鼠标/键盘事件 + 本地假 sshd 真协议端点；约 6 分钟可复现，证据 `accept-result.json` + `shots/*.png`）。与「探针宿主页」验收的本质区别：**从用户能点的元素出发、走 hit-test**（D1「单向门」教训）。已验：hero launcher / 会话头胶囊两条入口真实点击开浮层；浮层五点采样 hit-test 全落浮层内（官方 UI 不可达）；顶栏三段胶囊 + SSH `aria-current="page"` + **宿主文档零顶栏**；顶栏只三按钮（工具区控件不在其中）；「对话」退出 + 焦点归还入口；`Esc` 不关闭；Shift+Tab 反向可达「对话」且 focus-visible solid 2px；SSH↔画布**双向**互斥；记忆语义（开着刷新恢复 / 关后刷新停在对话）；**真协议零损失**（关闭期间零 resize 帧、重开 iframe 未重载、30 次开关零帧且 SSH 侧 shell 恒为 1）；三主题切换 + 顶栏 reserve 消费（`padding-right = 14 + 150`）；壳内入口与窗控不叠压。
**同轮附带两条非 D2 发现（已于同日修复，用户定向「两条一起修」）**：**D-1**（阻断）「保存并连接」从不发起连接（意图标记曾挂在按钮 `event` 上 ⇒ 解析到全局 `window.event`，`dispatchEvent` 后读不到；改走闭包变量）；**D-2**（体验）指纹确认后状态栏/横幅不追平（`session.js` 曾只把 `ready`/`status` 帧写成文案、不喂状态模型；现统一转发 `onFrame`）。另：hero 态无画布入口 ⇒ 顶栏「会话布」**已按诚实降级收口**（宿主下发 `canvasAvailable`，hero 态只渲染「对话｜SSH」两段、进入会话后三段回归）。**当日修复后重启 host 复验：`allPassed=true`，24 项门槛全 PASS、0 FAIL**。详见 `dsh-miasaki-ssh/design/2026-09-14-ssh-fullscreen-overlay-plan.md` §16。

**D3 全屏浮层清理与回归实机验收（2026-09-15，8 项门槛 7 PASS）**：驱动 `_refs/scripts-archive/ssh-d3-accept/run-d3-accept.mjs`（同 D2 通道：真 GUI × 真实事件 × 假 sshd 真协议）。**通过项**：① **四档宽度按视口语义落位**（1280 rail 232 / **960 rail 208 —— 恰在断点值落紧凑档** / 720、480 抽屉；四档零横向溢出）；② 三主题 × 1280/480 零溢出 + 顶栏稳定 + reserve `padding-right:164px`；③ A0 文案「点左上「对话」退出后粘贴」+ 剪贴板首行格式正确；④ 官方 tab 栏无 SSH；⑤ 会话态官方 `[data-width-handle]` 正常显示（本线未再隐藏）；⑥ 回退视图面零残留（`.dsh-ssh-view` / 临时退出条）；⑦ 真实连接链路。**D3-F1 已闭环**（用户定向「现在就删」）：`client.js` 注入样式里那条 `div[data-phase]:has(...) [data-width-handle]` 死规则已删除（回退视图已删 ⇒ `:has()` 永不命中），旧断言改写为「零残留/零触碰」并新增回归断言 ⇒ 本节「`grep` 应无命中」判据达标。单测 **81 例**、`verify-all ssh` **12/12**。详见方案 §18。

**D4 尾项清理实机验收（2026-09-15，6 项门槛全 PASS）**：驱动 `_refs/scripts-archive/ssh-d4-accept/run-d4-accept.mjs`（同通道；**尾项①②取运行态证据**）。**①`renderBanner` 隐藏即清空**：可见态 `hidden:false / childCount:3` → 连接完成后 `hidden:true / display:none / **childCount:0**`（旧实现只设 `hidden`，节点残留）；断开后横幅再现 `childCount:4` ⇒ 清空未破坏功能。**③过渡区间落位**：1280 → rail 232 / 860 → rail 208（紧凑档）/ 600 → 抽屉 / **500 → 抽屉且 `.tools .optional` 可见（480 档未触发）** / 480 → 隐藏（480 档命中）；五档零横向溢出。**②运行态**：30 次开关零异常 + iframe 未重载 + 远端零 resize 帧；静态侧 `observe(header,{childList,subtree})`、`aria-selected` 仅剩注释。**附带**：注入样式零 `width-handle`（D3-F1 实机复核）。单测 **82 例**、`verify-all ssh` **12/12**。详见方案 §20。

**U2 主体实施（2026-09-16，实机验收待跑）**：`dsh-miasaki-ssh/design/2026-09-15-ssh-u2-plan.md` §6 的 **U2.1 多 shell / U2.3 工作区记忆 / U2.4 精确恢复**已落地（**U2.2 SFTP** 留待真实主机补验后开工）。单测 **85 → 110 例**（runtime 22 / session 32 / http 7 重写适配 v2 契约，app 16 / client 25 / store 8 无回归）、`verify-all ssh` **12/12**；端到端探针（真 sshd × 本线 `SshRuntime`）**9/9**；**回滚演练实际执行**（基线恢复 85/85 绿 → U2 还原 110/110 绿）。上表 **U2 四行**即本轮实机验收判据，明细见 `dsh-miasaki-ssh/README.md` 与 `dsh-miasaki-ssh/design/CHANGELOG.md` 第十二批（含「规划决策 5 的 `app.js` 纯搬迁拆分未执行」的偏离登记）。

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
| 2026-09-21 | **外观线 M2.5「软件头像」落地（本仓第一条 appearance × desktop 跨线能力）**：用户「外观设置里要可以设置软件头像」→ 澄清落点为**桌面壳启动器图标**（任务栏/窗口/托盘）。appearance 侧配置 v2 → v3（新增 `avatar.source`）+ `lib/avatar.js`（PNG 魔数 / data URL 解析 / 文件名白名单）+ 上传·清单·文件三条路由 + 面板板块（canvas 归一化 PNG ≤512）+ 契约 `avatar-host-stale`；desktop 侧新增 `src-tauri/src/launcher_icon.rs`（读同一份配置 → PNG 解码 → 中心裁方 + 盒式降采样 ≤256 → `window.set_icon` + `tray.set_icon`，1.5s 巡检跟随，失败一律回退出厂图标）。appearance **12 → 14 项**（+`lib/avatar.js` 语法；单测 60 → **81** 例 —— 其中 M2.5 头像 19 例、同批次入库的 M2.6 面板风格契约 2 例）、desktop `cargo test` 19 → **25** 例、desktop 仍 **11/11**。契约文档 `appearance-launcher-icon-2026-09-21.md`，实机判据新增 **§3.5b**（上传→三处图标跟随 / 清单选择 / 清除回退 / 坏文件不崩 / 边界如文案）。**实机验收待用户重启 `dsh web` 与桌面壳后执行** |
