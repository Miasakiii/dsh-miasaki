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
