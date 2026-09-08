# CHANGELOG — dsh-miasaki-sidebar

本文件记录 `dsh-miasaki-sidebar/` 线的设计决策与变更。

## 2026-09-06

- **新线立项（路线 D 拍板）**：轻量右侧边栏，无基座完全自研。背景：调研 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（v0.18.0，MIT）后，先倾向"基座复用 + 自研审查 tab"（路线 C），用户质疑重基座问题（裁剪开关只轻界面，骨架/跟随成本仍在），重开后拍板路线 D。
- **四组件蓝图**：右栏壳（推挤/折叠/持久化/三主题令牌/桌面壳让位）、审查 tab（收尾自检清单 + 本轮 git diff）、辅助对话 tab（fork+注入侧线，复用 canvas merge 内核链路）、终端（M1 系统终端启动器 + M3 同屏内嵌规划）。
- **关键决策**：
  - 终端同屏内嵌**先规划后实现**——M3 条件立项（立项门：node-pty 安装 spike + WS 路由 spike + 启动器 2 周高频刚需观察）；M1 先做系统终端启动器（`wt.exe -d <cwd>` / pwsh 回落）；
  - 辅助对话底座复用 canvas 已验证的「fork + 首条消息注入」链路，侧线隐藏性方案待 M2 spike（origin/subagent 机制优先，元数据标记 + 列表过滤兜底）；
  - 右栏与宿主同文档（非 iframe），直接消费 `--dsw-*` 令牌；tab 框架为插件私有注册表，暂不服务化；
  - 数据隔离目录 `$DSH_HOME/miasaki-sidebar/`。
- 文档：`design/2026-09-06-sidebar-roadmap-design.md`；路线论证在跨线 `dsh-miasaki-shared-docs/cross/sidebar-plan-2026-09-06.md`。
- **M1 壳 spike 完成（同日）**：better-sidebar 的 `data-pane="conversation"` 推挤锚点在本机 DSH 0.1.2 bundle 中**不存在**（`data-dsh-frame`/`data-pane` 全 bundle 无匹配）。读 `dsh-client-ui-layout` 源码 + 本机浏览器实测后定稿：
  - 原生 AppFrame 即三列（`sidebar | center | details`），`ctx.layout` 服务存在（`openDetails`/`closeDetails`），但**原生 `details` 插槽路线否决**——官方文档明示该槽 OCCUPIED by ui-conversation's DetailsPanel，`single` 语义下注册即整体顶掉官方工具详情面板；
  - 定稿 **frame `padding-right` 推挤 + `shell.overlay` 挂载**：实测 1280px 视口 center 1000→600px，grid 1fr 正确吸收；dark 主题下 `--dsw-alias-*` 令牌跟随正确；
  - **右栏 z-index < 100**（canvas overlay z-100 实测盖住 z-60 面板，属预期专注视图行为，禁止反向提 z）；
  - **推挤下限从 1024 提到 1280**（实测 900px 视口 center 仅 444px；<1024 官方左栏自动收 56px rail）；
  - 头部 actions 插槽本机确认可用（canvas 按钮在槽内），右栏按钮 order 实现时定。
  - 详见设计文档 §3.1.1；`dsh web` host 为 spike 重启一次（无活跃会话，数据落盘无损）。
- **M1 壳实现落地（同日，v0.1.0-miasaki.1）**：`index.js`（host 骨架：`/sidebar/api` 前缀路由 + trustedHosts 围栏 + 数据目录 `miasaki-sidebar/`）+ `client.js`（壳主体）+ `package.json` / `cordis.patch.yml`（`id: sidebar` 与包名逐字一致）。已装 profile（`link:` symlink）实机验证：
  - **推挤**：frame `padding-right` 实测生效（1280px 视口 center→600px）；打开面板联动 `ctx.layout.closeDetails()` 收官方详情列 ✓；
  - **入口双环境**（用户拍板改版：不放会话头文字按钮）：桌面壳=图标按钮注入窗控胶囊内 min 钮前（`.tb-btn` 同规格），浏览器=会话头 actions 槽同款图标钮（order 30，实测排布在 canvas order 25 右侧）；同一 React 注册 + watchdog 双向跟随（假标题栏注入/移除往返实测闭环）；
  - **让位**：面板 top 跟随 `#miasaki-titlebar` 高度（桌面壳 32px / 浏览器 0，实测）；
  - 壳行为：开合/激活 tab/折叠态持久化（localStorage `miasaki-sidebar:v1`，刷新实测保留）；`sidechat` tab M2 禁用态占位；三 tab 图标条/横排两形态。
  - 待办（壳收尾项）：拖宽把手手感、<1280 浮层与 <768 抽屉实机、Esc 关浮层与 canvas Esc 优先级、桌面壳真机三主题。
- **空态标签选择页（同日，用户拍板 Edge 侧边栏范式）**：`tab: null` 状态（首次打开/关闭最后 tab）面板显示居中「打开标签页」引导 + 三张图标卡片（审查/终端/辅助对话，sidechat 禁用态），点卡片激活对应 tab；tab 栏新增 × 关闭钮回空态。实测闭环：卡片→tab→×→空态，`tab: null` 正确持久化。设计 §3.2 已补记。
- **取消折叠态（同日，用户拍板）**：右栏不做 48px 图标栏折叠——开合即全部，空态选择页承担"暂不进入某个 tab"的轻量形态。client.js 移除 `collapsed` 状态/持久化字段/fold 钮/[data-collapsed] 样式，实测开合与持久化正常（`{"open":true,"width":400,"tab":...}`）。设计 §3.1 已改。
- **标题栏入口对齐 V4 + 徽章左侧（同日，用户拍板第二轮）**：desktop 线并行会话把标题栏改 V4 去胶囊（`.tb-capsule`→`.tb-group` 浮动按钮组），sidebar 注入锚点同步迁移并兜底兼容 V3；按钮位置按用户指定改为**组内首位（徽章 `tb-brand` 左侧）**；按压态从品牌色胶囊改为**通高深色块 + 白图标**（参考图形态）。V4 假标题栏实测：注入顺序 `[tb-sidebar, tb-brand, min, max, close]`、按压切换、移除后会话头按钮回归，全部通过。
- **按钮风格改 DSH 原生（同日，用户拍板第三轮，弃深色块）**：图标换 DSH 原生 `.panelIcon` 16px 填充字形（dsh-client-ui-sidebar，`fill=currentColor` evenodd path），`scaleX(-1)` 镜像使面板列朝右；按钮 = 28px 圆形透明底（label-secondary 墨色、hover `interactive-bg-hover` 提亮，与 dsh-client-ui-sidebar `.iconButton` 同规格）；按压态仅图标变 `label-primary`，无任何色块。桌面壳版沿用壳 `.tb-btn` 基础规格只覆盖图标尺寸与按压态。实测 28×28/50% 圆角/16px 镜像图标/按压变色全部到位。
- **tab 选中态去品牌蓝（同日，用户反馈第四轮）**：pure 亮色主题下 tab `[aria-selected="true"]` 底色令牌 `--dsw-alias-interactive-bg-selected` 解析为亮蓝，观感过重——改用 `--dsw-alias-interactive-bg-hover` 中性灰（与 DSH 左侧边栏选中/悬停同款），文字保持 primary。client.js 注释记录选型依据；`node --check` 过；真机复验（host 重启后）选中态呈中性灰、与未选中 tab 对比温和，通过。部署契约备忘：sidebar 为 `link:` 依赖（源目录 symlink），改源文件即落盘、无需 pnpm install，但 client bundle 在 host 启动时载入内存——**生效必须重启 DSH host**，页面刷新/强刷均无效。

## 2026-09-07

- **审查 tab 数据面 + UI（v0.2.0-miasaki.1，M1 第二项）**：
  - host `/sidebar/api/review/*`：`status`（branch/HEAD/`git status --short --untracked-files=all`，2000 条设界 + `truncated` 标记 + rename 目标路径）、`diff`（单文件：tracked `git diff HEAD` / staged `--cached` / untracked `--no-index` 全量视为新增；自研 unified diff 解析：hunk 头 + add/del/ctx 行列号，20000 行设界、binary/truncated 标记）、`checklist`（GET/POST，按 cwd hash 文件隔离、notes 按路径点名字典 + docsSynced/finalMentioned 开关，原子写临时文件 + rename）；doc-sync 检测按仓库 AGENTS.md 收尾约定（四线根 README + CHANGELOG/docs 比对）；
  - client 审查 tab：当前会话 cwd 驱动（sessions 快照 + watchdog 兜底 0.1.2 懒恢复）、60s TTL 自动刷新 + 手动刷新、「N 条未点名」徽标（未点名红色描边 + 点行即点名往返）、单文件行级 diff 展开（红绿 add/del）、文件状态码 XY 徽章；
  - **实机验证**（本仓真实 16 条改动）：status 全量渲染 ✓、未点名徽标 15 ✓、点名往返（点击→「已点名」→持久化）✓、README.md diff 展开 25 行（11 增/7 删）✓；
  - **途中修复**：① 浏览器 fetch 传参链——统一 `URL/searchParams` + diff 路由 cwd 改从 POST body 注入（host 端）；② untracked diff：`git diff --no-index` 需 `NUL`（Windows 无 /dev/null）且 exit 1 时仍要 stdout（自写 spawn 封装）；③ git 二进制绝对路径（`dsh web` 进程 PATH 无 Git dir）；④ checklist 原子写 await 完成后才返回（早期 fire-and-forget 导致二次读取陈旧）；⑤ 0.1.2 会话懒恢复——cwd 订阅可能不触发，并入 1.5s watchdog 轮询。
  - 单测 4/4（diff 解析器三形态、doc-sync 规则、checklist 持久化往返）。`test/review-data.test.js` 入仓。

- **终端启动器落地（v0.3.0-miasaki.1，M1 第三项 / M1 功能收口）**：设计 §6.1 的启动器形态实现完毕。
  - host `/sidebar/api/terminal/options`：按平台列出终端候选并标 `available`。探测方式**改为 PATH 查询**
    （`where.exe` / `which`）而非执行终端——原设计的 `wt.exe -v` 式探测会在用户桌面闪出真实窗口；
    跨平台查询（如 Windows 上问 linux 项）一律返回 `available: false`，不做无意义 spawn。
  - host `/sidebar/api/terminal/open`：`launchTerminal()` 先校验 cwd（不存在 → 404 / 是文件 → 400），
    再由 `terminalCommand()` 按固定枚举产出 `{ bin, args }` 交给 `spawn`（`detached + stdio:'ignore' + unref`）。
    **四条安全约束**：① shell 只能是 `TERMINAL_SHELLS` 里的 id，客户端无法指定任意 executable；
    ② 全程参数数组、不经 shell，cwd 只占独立参数位（`powershell` / `cmd` 干脆不接路径参数，直接继承
    spawn 的 cwd，恶意路径连 argv 都进不去）；③ cwd 必须绝对且为已存在目录；④ 未安装的终端在 UI 置灰，
    **不静默回落**到用户没选的终端（回落顺序 `wt→pwsh→powershell→cmd` 仅用于默认选中项）。
  - client 终端 tab：显式状态机 `checking → idle → opening → opened | failed`——启动失败绝不显示成功；
    cwd 回显 + 复制、终端类型单选（未安装项 disabled 并标注）、启动中禁用按钮、失败面板带原因与重试。
  - **途中修复**：`reviewStatus()` 内引用了模块作用域不存在的 `ctx`，git 命令失败时会抛
    `ReferenceError` 而非降级为空字段——改为从 `apply()` 显式传入 `logger`。
  - **重命名**：`fetchReview`/`REVIEW_PREFIX` → `fetchSidebar`/`API_PREFIX`（前缀收到 `/sidebar/api`），
    四处调用点同步带上 `/review` 段。
  - 单测 7/7（`test/terminal-launcher.test.js`：argv 构造、恶意路径原样落参数位、未知 shell id 与
    非绝对 cwd 拒绝、平台过滤与回落链、跨平台探测、cwd 三类错误、缺失二进制报名不挂起）；
    本线合计 11/11。**实机验收待用户重启 `dsh web`**——已确认运行中 host 仍是 `0.2.0-miasaki.1`
    旧 bundle，新路由返回 404，符合 `link:` 部署契约。
  - 顺带修正 README 里 `../../dsh-miasaki-shared-docs/…` 越级链接为同仓 `../`。

## 2026-09-08

- **cwd 守卫修复（v0.3.0-miasaki.2）**：状态盘点时以真实 HTTP 负向用例实测终端启动器，发现
  README 宣称的第 3 条安全约束「cwd 必须是绝对路径」**在真实路由上从未生效**——相对路径用例返回
  404 而非 400，且错误信息里的路径已被解释为「相对 host 进程 cwd」（实测 host cwd =
  `dsh-miasaki-desktop\dist`）。
  - **根因**：`resolveWorkdir()` 先 `resolve(raw)` 再判 `isAbsolute(cwd)`；`resolve()` 会把相对路径
    补成绝对路径，于是该判断恒为真，校验形同虚设。危害不在 404——**若该相对路径恰好存在于 host
    cwd 之下，会在 host 自己的目录里真的拉起一个终端**（`test`、`dist` 这类目录名很容易撞上）。
  - **修复**：绝对性判断前置到 `resolve()` 之前（`raw.trim()` → `isAbsolute` → `resolve`），
    非绝对路径一律 400「需要工作区的绝对路径」；UNC 路径仍按绝对放行，绝对路径的既有行为
    （存在性由 `assertDirectory` 判 404 / 文件判 400）不变。
  - **可测性重构**：路由 handler 从 `apply()` 内联闭包抽为导出的 `createApi({ dataFile, trustedHosts, logger })`，
    `apply()` 只负责取配置并 `ctx.webServer.register`。理由是这条约束只在「路由确实调用了守卫」时才成立，
    单测辅助函数无法证明链路（旧单测 `terminalCommand('cmd','relative\\path')` 确实抛 400，但路由永远先 resolve，
    该断言在真实链路上不可达）。
  - **新增 `test/api-routing.test.js`（8 项，走真实 HTTP server）**：`resolveWorkdir` 形态矩阵
    （相对/驱动器相对/`.`/`..`/空/非字符串拒绝，UNC 与绝对路径放行）；`POST /terminal/open` 相对 cwd → **400**
    （回归点：修复前是 404）；**「存在但相对」的危险用例**（`cwd: 'test'` + 未知 shell id，零副作用地证明
    cwd 守卫先于 shell 枚举）；`GET /review/status` 同守卫；绝对但不存在仍 404（不误伤）；
    health 200 / 不可信 Host 403 / 未知路由 404；`trustedHosts` 并集生效。
  - 本线单测 11 → **19 项全绿**；`node ..\scripts\verify-all.mjs sidebar` 5/5（新增一个测试文件）。
  - 触摸点：`index.js`、`test/api-routing.test.js`（新）、`package.json`、`README.md`、本文件。
  - **生效条件**：host 半在启动时载入内存，须重启 `dsh web`；`GET /sidebar/api/health` 返回
    `0.3.0-miasaki.2` 即已加载（盘点时运行中 host 为 `0.3.0-miasaki.1`，终端路由本身可用）。

- **dsh-tavern 右侧边栏对比调研（`design/2026-09-08-tavern-sidebar-comparison.md`，纯调研不动代码）**：
  起因是用户给出 [dsh-tavern](https://github.com/flizzywine/dsh-tavern) 作为右栏参考。调研结论：
  - **它的右栏不是自研**——`tavern-plugin/package.json` 的 client `inject` 明写 `dsh-better-sidebar`，
    右侧 7 个面板（酒馆状态/人物卡库/预设库/系统提示词/世界书库/剧本库/用户画像）全部走
    `ctx.betterSidebar.registerTab({id,title,order,single,createTab,component})`；左栏则是
    `slots.inject("sidebar.workspaces", …)` 整槽替换。所以"参考它"实际是参考基座框架 + 接入用法。
  - **推挤同思路、载体不同**：基座在 `<html>` 写 `--dsh-sidebar-width`、由常驻 CSS 规则消费
    （`layout.css` 命中 AppFrame frame 并平移 details 列），我们目前是 JS 直写
    `frame.style.paddingRight` + watchdog 抢救。前者抗 React 重渲染，后者依赖重写。
  - **新发现（本机 DSH 0.1.2-rc.1 静态取证）**：`dsh-client-ui-renderer` 给每个 slot 宿主渲染
    `<div data-slot="<slotKey>">`，故 `[data-slot="conversation"]` 是稳定语义锚点，其 parentElement
    即 AppFrame 的 `div.centerCol`、再上一级即 frame；frame 自身**无** `data-dsh-frame`/`data-slot`
    （印证 2026-09-06 spike 结论），基座的 `#root [data-dsh-frame]` 在本机不匹配，靠
    `#root > [data-slot="root"] > div` 兜底。建议我们改走
    `document.querySelector('[data-slot="conversation"]')?.closest('div[style*="grid-template-columns"]')`
    （官方锚点 + 特征校验叠加）。
  - **另外两项低成本可吸收**：tab 组件补 `visible` 性能门（M2 辅助对话的前置）；host 围栏补
    `sec-fetch-site: cross-site` 拒绝与 `Origin` hostname 比对（我们目前只比 Host，基座的
    `trust-fence.ts` 有三道）。
  - **明确不采纳**：服务化 `registerTab` 框架 / betterSidebar 兼容层（17 字段 + 17 方法，
    且需先有"多 tab 并列"UI，成本与 M2/M3 同量级，M1 验收后再评估）；多 tab 分栏 / 底部面板 /
    自由浮窗 / body portal 挂载 / 左栏整槽替换（重工作台形态，与轻量右栏定位冲突）。
  - **真机实测（同日，一次性 Cordis 探针 `probe-1`，验完已 undefine + 删输出文件）**：在真实页面
    （DSH 0.1.2-rc.1，1280×800）只读查询 DOM，报告 §6 两条待确认项全部落地：
    `#root > [data-slot="root"] > div` 即 AppFrame frame（`#root` 仅一个子元素）；`[data-slot="conversation"]`
    自身 `display:contents`，parent=centerCol、parent.parent=frame、`closest(...)` 亦命中 frame；
    `[data-dsh-frame]` / `[data-pane]` / `[data-side="details"]` 三个基座选择器计数**全为 0**
    ——基座在本机靠 `#root > [data-slot="root"] > div` 兜底，其详情列平移规则选不中 detailsCol（失效）。
    **附带发现（待复核）**：探针运行时 `#miasaki-titlebar` 元素存在但 `height=0`，按
    `measureChromeReserve()` 的 `rect.height > 0 ? rect.bottom : 32` 会取兜底 32px，与
    README「浏览器无壳时为 0」不符——建议改为「元素不存在或高度为 0 均让位 0」，两环境各复验一次。
  - 触摸点：`design/2026-09-08-tavern-sidebar-comparison.md`（新）、`README.md`、本文件。
    参考仓库克隆在 `_refs/dsh-tavern`、`_refs/dsh-better-sidebar`（均已 ignore，不入库）。

- **右栏实现加固（v0.4.0-miasaki.1，用户拍板「按建议批次开工」）**：按报告 §7 落地批 1–3 + 附带修复，
  单测 19 → **20 项全绿**，`node ..\scripts\verify-all.mjs sidebar` **5/5**。
  - **批 1-a 推挤锚点（client.js）**：`FRAME_SELECTOR`（单一特征选择器）→ `resolveFrame()`：
    主选官方语义锚点 `[data-slot="conversation"]` 的 `closest('div[style*="grid-template-columns"]')`，
    特征查询 `#root div[style*="grid-template-columns"]` 兜底。依据是同日探针实测（见上一条与报告 §6）：
    frame 自身无 `data-dsh-frame` / `data-pane`，而 `#root > [data-slot="root"] > div` 即 frame。
  - **批 1-b host 围栏（index.js）**：Host 单道 → 三道。新增 `sec-fetch-site: cross-site` → 403、
    `Origin` hostname 与 Host hostname 比对（比 hostname 不比 `host:port`；`null`/不可解析按不透明来源拒绝）。
    `test/api-routing.test.js` 新增 1 项走真实 HTTP 的正负用例（跨站标记 / 外部 Origin / `null` → 403，
    同源 Origin / 无 Origin → 200），路由测试 8 → 9 项。
  - **批 1-c 桌面壳让位（client.js）**：`measureChromeReserve()` 的 `rect.height > 0 ? rect.bottom : 32`
    在浏览器环境（`#miasaki-titlebar` 存在但高度 0）会误让位 32px → 改为高度 0 即让位 0；
    桌面壳 `rect.height > 0` 分支行为不变。
  - **批 2 推挤载体（client.js）**：`frame.style.paddingRight` 直写 → `<html>` 的
    `--miasaki-sidebar-width` + 常驻 CSS 规则 `#root > [data-slot="root"] > div, #root div[style*=...]`
    消费，React 重渲染 frame 不再丢推挤；inline `padding-right` 保留为"规则选择器漂移"时的同值兜底
    （两者同值，不会双推）。**刻意不加 transition**：`transition` 简写会覆盖宿主 frame 自身的
    `transition: grid-template-columns`，代价大于收益（已在代码注释与设计文档说明）。
  - **批 3-a `visible` 性能门（client.js）**：store 增 `pageVisible`（`visibilitychange` 驱动），
    壳向 tab 组件传 `visible = open && pageVisible`，审查 tab 的 60s TTL 回调据此跳过；
    本线只渲染激活 tab、面板关闭即卸载，"非激活暂停"天然成立，该门补的是"窗口切后台"。
  - **批 3-b 按会话持久化 v2（client.js）**：全局单键 `miasaki-sidebar:v1` → 按会话
    `miasaki-sidebar:v2:<sessionId>`；旧键在首个读到的会话上一次性迁移并删除；无记录的会话
    **保持当前 UI 状态**（切会话不闪关）并在下次变更时落自己的键。
  - **未做**：betterSidebar 兼容层（§5-D，成本与 M2 同量级，M1 实机验收后再评估）。
  - **生效条件**：host 半与 client bundle 均在 `dsh web` 启动时载入内存，**须重启**；
    `GET /sidebar/api/health` 返回 `0.4.0-miasaki.1` 即已加载。

- **M1 实机复验（浏览器环境，2026-09-08 晚）**：盘点发现运行中 host 仍是 `0.3.0-miasaki.2`——
  `/sidebar/api/health` 报旧版本，且围栏探针反推同样如此（`Origin: https://evil.example` 与
  `sec-fetch-site: cross-site` 均返回 200，属加固前行为）。即 **v0.4.0 加固当时尚未加载**，
  在它之前跑的验收轮覆盖的是旧 bundle。重启 host 后（原进程空闲：无页面连接、无在途 turn；
  新进程 detached，启动日志 `_refs/diag/dsh-web-20260908-2255.*.log`）完成复验，`health` =
  `0.4.0-miasaki.1`：
  - **host 侧**：围栏三道实测（外部 Origin / `sec-fetch-site: cross-site` / `Origin: null` → 403，
    同源 Origin 与无 Origin → 200）、cwd 守卫（相对路径 400、绝对但不存在 404）、
    `review/status` 与 `terminal/options` 200；
  - **client 侧（真实页面 1280×720，受控浏览器）**：`--miasaki-sidebar-width: 400px` 挂 `<html>`，
    frame 计算样式 `padding-right: 400px`；锚点 `[data-slot="conversation"]` →
    `closest('div[style*="grid-template-columns"]')` 命中 `div.pI_x6G_frame`（与特征查询兜底同元素）；
    面板 `top=0`（浏览器无标题栏 → 让位 0）、`z-index 60`；关闭面板后变量清空、padding 归 0，
    重开恢复 400px；
  - **按会话持久化**：两个会话各自独立键（`v2:session-3be425f7…` → `tab:"terminal"`、
    `v2:session-51a6af9d…` → `tab:"review"`），切到无记录会话时面板不闪关（保持当前 UI 状态）；
  - **响应式**：1100px 视口 → `position:fixed` 右侧浮层 + scrim、frame 不推挤；
    700px → 抽屉 + scrim（宽度 `min(viewport, 400)`）；1280px 恢复推挤；
  - **顺带发现（当晚已拍板补齐，见本段末条）**：设计 §3.1 写「<768px 全屏抽屉（遮罩 + 右滑关闭）」，
    实现为 `width = min(viewport, 持久化宽度)` 且无右滑关闭手势（遮罩点击关闭）——
    只有视口窄于面板宽度时才满宽；
  - **本轮未覆盖**：桌面壳环境（标题栏入口、32px 让位分支、三主题）未复验——未启动桌面壳；
    `visible` 性能门只做了 bundle 标记核对（后台跳过刷新需 60s TTL 观察，未做）。

- **抽屉右滑关闭补齐（v0.4.1-miasaki.1，设计 §3.1 遗留项，用户拍板）**：上条「顺带发现」列出的
  「设计写右滑关闭、实现只有遮罩点击」已按设计补齐。
  - **手势**：面板 `touch-action: pan-y` 把水平手势交给 pointer 处理（代价：抽屉内横向滚动被抑制，
    窄视口以垂直滚动为主，可接受）；8px 轴锁定——垂直意图一律释放回标签页滚动（不 `preventDefault`，
    原生滚动不受影响）；拖动期间 `translateX` 跟手，松手回弹或关闭；
  - **判定抽为纯函数** `drawerCloseDecision({dx, dy, width, elapsedMs})`：只认向右 → 垂直意图优先 →
    位移门 `max(64px, 宽度 × 30%)` → 快滑门 `≥32px 且 ≥0.6px/ms`；`elapsedMs ≤ 0` 不参与速度门
    （不做除零）。阈值刻意定义在函数内部，使其可被独立求值（client.js 是 `__ModuleLoader__`
    bundle、无导出，与 desktop 线验证注入层的做法一致）；
  - **新增 `test/drawer-gesture.test.js`（9 项，源码抽取）**：本线 20 → **29 项全绿**；
    `node ..\scripts\verify-all.mjs sidebar` **6/6**（新测试文件被目录扫描自动纳入）；
  - **顺带**：抽屉模式下推宽把手隐藏（`[data-drawer] .dsh-sidebar-resize{display:none}`），宽度拖拽
    仍只在推挤模式生效；`pointercancel`（系统手势/失焦）一律回弹，绝不代替用户关闭面板。
  - 触摸点：`client.js`、`test/drawer-gesture.test.js`（新）、`package.json`（0.4.1-miasaki.1）、
    `README.md`、`design/2026-09-06-sidebar-roadmap-design.md`（§3.1 补记）、本文件。
  - **生效条件**：client bundle 在 host 启动时载入内存，**须重启 `dsh web`**；
    `GET /sidebar/api/health` 返回 `0.4.1-miasaki.1` 即已加载。
  - **实机待验**（<768px 视口）：右滑关闭、垂直滚动不受干扰、遮罩点击与 Esc 仍可用。

- **审查 tab 改版 + 浏览器式标签页方案定稿（纯规划，未写代码）**：`design/2026-09-08-sidebar-review-redesign-implementation.md`（v0.5.0 目标形态）。
  - 参考图要求：视图下拉（未暂存/已暂存/全部分支更改/上一轮更改）+ 目录分组文件列表（类型图标 + 文件名 + 灰色目录 + `+N -M` 统计 + 展开）+ 浏览器式多标签（每标签独立 ×、`＋` 新建、keep-mounted 保留状态）；
  - **语义拍板**：「上一轮更改」= 最近一次 git 提交（`git show HEAD` 视角，非会话轮次追踪）；「全部分支更改」= 工作区全部改动 vs HEAD（未暂存 + 已暂存 + 未跟踪）；
  - 方案要点：host `review/status` 加 `view` 白名单参数 + `git diff --numstat` / `diff-tree` 统计（untracked 逐文件 `--no-index`，200 个设界）+ 空仓库 `noCommits` 降级；client `store.tab` 单值 → `tabs[]/active` 多实例、持久化 v2→v3 一次性迁移、空态重定义为「新标签页」；既有点名 / diff 展开 / 60s TTL / visible 门 / 未点名红描边全部保留；
  - 待用户拍板 3 项后按批 A（host 数据面）→ B（审查 UI）→ C（标签框架）→ D（版本/文档）实施。

- **审查 tab 改版 + 浏览器式标签页落地（v0.5.0-miasaki.1，同日拍板后开工）**：方案见
  `design/2026-09-08-sidebar-review-redesign-implementation.md`（§10 三项拍板、§11 实测校准）。
  单测 29 → **46 项**（新增 `test/review-view.test.js` 6 项 + `test/client-tabs.test.js` 10 项，
  前者含 2 项真实 git 集成用例在受限环境自动跳过），路由 9 → 10 项。
  - **批 A 数据面（index.js）**：`/review/status` 加 `view` 白名单（`unstaged|staged|all|last`，非法 400，无参保持旧语义）。
    **实测校准推翻了方案初稿的三条假设**（探针 `_refs/git-probe`，用后即删）：
    ① numstat 人类格式的 rename 是 `old => new`（不是 `{old => new}`），路径含 ` => ` 即歧义 → 改用 **`-z` 机器格式**，
    rename 记录为 `add\tdel\t\0old\0new\0`，按**新路径**归并；
    ② `git diff-tree` 对 **root commit 默认输出为空**（需 `--root`）→ 改用 `git show --numstat -z --format=`，
    首提交与普通提交统一处理且默认带 rename 检测；
    ③ `--no-index --numstat` 输出带 `NUL => ` 前缀且需逐文件 spawn → **untracked 统计改为 host 读文件**
    （行数 / NUL 字节判二进制 / 2MB 设界 / 200 个文件设界），零 spawn。
    另修：`git status --short` 对含空格路径加引号、非 ASCII 走八进制 UTF-8（`"\344\270\255"`），
    旧代码把引号原样透传给 diff 路由 —— 新增 `unquoteGitPath()`（按**字节**收集转义再一次性解码，
    否则多字节字符会被拆成替换字符）。空仓库 `diff HEAD` / `diff-tree` / `rev-parse` 均退 128 → `noCommits` 降级。
  - **批 B 审查 UI（client.js）**：视图下拉（`menuitemradio` + ✓，浮层 fixed 定位绕开列表 overflow 裁剪，
    **切换即拉取**——`view` 进 effect 依赖）+ 目录分组列表（组头**默认折叠**，组统计为组内求和）+
    扩展名配色图标 + 每文件 `+N`/`-M`（二进制显示 `bin`，无统计显示 `-`）；
    **点名、未点名红描边、DiffViewer、60s TTL、`visible` 门全部保留**（交互不变：点行点名、点 `▾` 展开 diff）。
  - **批 C 标签框架（client.js）**：`store.tab` 单值 → `tabs[]` + `active` 多实例；每标签独立 × 关闭
    （关闭激活标签时激活其左邻，浏览器行为）、`⌄` 全部标签菜单（本期实现）、`＋` 新建标签（类型选择浮层）、
    空态 = 新标签页选择卡；**非激活标签 keep-mounted**（`display:none`，切回不丢状态、不重复拉取）；
    标签标题同类型自动编号（审查 / 审查 2）。持久化 **v3**：`miasaki-sidebar:v3:<sessionId>` =
    `{open,width,tabs,active}`，v2（按会话单 tab）与 v1（全局）一次性迁移后删除。
  - **顺带对齐**：`/sidebar/api/health` 的 version 此前是 `0.4.0-miasaki.1` 而 `package.json` 已升 `0.4.1`
    （并行会话升版时漏改）——现统一为 `0.5.0-miasaki.1`。
  - 触摸点：`index.js`、`client.js`、`test/review-view.test.js`（新）、`test/client-tabs.test.js`（新）、
    `test/api-routing.test.js`、`package.json`、`README.md`、本文件、设计文档（状态改「已落地」+ §11 实测校准）。
  - **生效条件**：host 半与 client bundle 均在 `dsh web` 启动时载入内存，**须重启**；
    `GET /sidebar/api/health` 返回 `0.5.0-miasaki.1` 即已加载。
  - **实机已验（2026-09-09，重启 host 后）**：四视图切换与统计、目录分组折叠、多标签开/切/关与
    keep-mounted、v2→v3 迁移（注入旧键实测）全部通过，逐项证据见下方 2026-09-09 段。

## 2026-09-09

- **v0.5.0 改版实机复验通过（重启 `dsh web` 后，浏览器环境）**：
  - 生效确认：`GET /sidebar/api/health` → `0.5.0-miasaki.1`（重启前仍是 `0.4.0-miasaki.1`，正是本次修的对齐问题）；
    四线静态回归 `sidebar 8/8`。
  - **四视图**：下拉 4 项（✓未暂存 / 已暂存 / 全部分支更改 / 上一轮更改）切换即拉取、逐视图刷新数据——
    已暂存 = 空（本仓无暂存）→「这个视图下没有改动」；上一轮更改 = `design/ +218 -8`（与 `git show HEAD`
    两文件 +212 -0 / +6 -8 一致）；未暂存与全部分支更改 = 3 组同数（含未跟踪 391 行，符合设计 §4.1「unstaged 含未跟踪」）。
  - **目录分组折叠**：默认全折叠；展开 `dsh-miasaki-sidebar/` 得 4 行（README +20 -7 / client.js +472 -119 /
    index.js +213 -12 / package.json +1 -1），合计恰等于组头 +706 -139（组统计 = 组内求和）；再点收起。
  - **多标签 keep-mounted**：`＋` 浮层（审查 / 终端 / 辅助对话禁用）新建「审查 2」（同类型自动编号）；
    标签 2 切「上一轮更改」并展开组后，切到标签 1 再切回——视图、展开态与 DOM 节点身份（探针属性）全部保留，
    非激活 pane 为 `display:none` 而非卸载；`×` 关闭激活标签后左邻激活（浏览器行为）；`⌄` 菜单以
    `menuitemradio` 列出全部标签并带 ✓ 激活态。
  - **v2→v3 迁移**：删 v3 键并注入 `v2:<sessionId> = {open,width:360,tab:"terminal"}`，刷新后得
    `v3 = {open,width:360,tabs:[{id:"terminal-1",type:"terminal"}],active:"terminal-1"}`、v2 键被删除、
    面板宽 360px 生效、终端标签激活——形状与 `normalizePersisted` 一致。
  - **改版回归抽查**：点名往返（8 → 7 → 8 条未点名，行 `unnamed` 类与 title 同步）与行级 diff 展开
    （README.md 渲染 20 增 / 7 删，与 `git diff --numstat` 一致）均正常，检查清单已还原。
  - 环境注记：IAB 浏览器对本页侧栏节点的 Playwright 主 frame 定位器不解析（`getByRole`/CSS 均超时、坐标点击
    不达页面），交互改经页面内原生 `click()` 触发（React 事件委托），可点性另由 `elementFromPoint` 命中测试确认；
    截图归档 `_refs/sidebar-v0.5.0-verify.png`（不入库）。
