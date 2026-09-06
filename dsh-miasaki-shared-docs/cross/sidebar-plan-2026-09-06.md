# 右侧边栏（Sidebar）规划设计 v2 — 轻量路线讨论版

- 日期：2026-09-06（v1 同日重写）
- 状态：已拍板路线 D；M1 壳 spike 已完成（2026-09-06，结论见 `dsh-miasaki-sidebar/design/2026-09-06-sidebar-roadmap-design.md` §3.1.1），进入 M1 实现
- 上游参考：[omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT，v0.18.0 正式版）

## 0. v1 → v2 变化

v1 曾推荐「基座复用 + 自研审查 tab」（方案 B）。用户反馈：**上游内容太重、功能太多，不需要**。v2 补充两项关键调研后重开路线讨论：

1. **上游可裁剪**：v0.4.1 起设置页支持**逐 tab 开关**（`tabsEnabled` / `viewersEnabled` 开放字典），每个内置 tab 一张开关卡片，缺省全开——理论上可关到只剩「侧边对话 + 终端」两个；
2. **业界高效使用模式**（Codex /side、Claude Code sidechat、GitHub Copilot 右栏范式、CHI 研究）——先回答"什么样的右侧边栏是高效的"，再倒推路线。

## 1. 需求重述

"辅助对话、审查、终端等**实在工具**"，且**要轻**。约束沿用 canvas 线红线：不改系统提示/模型请求/工具 schema；DSH 原生会话是唯一事实来源。

## 2. 调研一：右侧边栏的高效使用方式（业界共识）

### 2.1 Side chat（辅助对话）的本质与正确用法

来源：Codex `/side` 官方指南与实战解析（[掘金长文 §Side chat](https://juejin.cn/post/7654092605076881417)、[Uravation /side 完全指南](https://uravation.com/media/codex-side-conversation-mode/)、[Claude Code sidechat issue #48099](https://github.com/anthropics/claude-code/issues/48099)）。

**本质价值 = 上下文隔离 + 不打断主任务**：

- 主会话上下文被源码/工具结果/日志填满时，"查资料、问概念"类提问丢进主对话会污染上下文、推高 token、误导方向；
- Side chat 用**独立上下文、独立历史**并行提问，不打断主任务（中断恢复成本≈23 分钟，UCI 研究）；Codex 实测：大量查阅型提问分流后**主会话平均 Context 占用显著下降**，任务完成时间几乎不变。

**正确的使用模式（5 类）**：

| 模式 | 例子 |
|---|---|
| 并行提问 | 主任务重构中，侧问 `axios interceptors 怎么用` |
| 文档/注释确认 | `把 README 的认证流程 3 行总结` |
| 错误假设事前验证 | `Postgres ON CONFLICT 无唯一约束会怎样` |
| 多文件并行作业管理 | `主任务生成的组件需要哪些 CSS 命名` |
| 进度确认与规划 | `接下来任务按 API→测试→文档排优先级` |

**失败模式（反面教训，直接指导设计红线）**：

1. **用侧聊跑重任务** → 侧聊必须保持轻量问答定位；
2. **以为侧聊结果会自动反映主对话** → 不会；结果靠用户"带回"主对话（设计上应提供带回入口）；
3. **无限制堆积输入** → 侧聊不做队列；
4. **与主对话模型混淆** → 侧聊应继承当前 preset/model 而非可乱选。

### 2.2 审查/终端在右栏的角色

- **审查**：CHI'25（[Xavier 论文](https://dl.acm.org/doi/10.1145/3706598.3714239)）结论——**常显侧面板让用户对上下文保持觉察、同时最小化打断**。审查 tab 的定位应是"本轮改动的常显上下文面板"，不是重型 Git 客户端；
- **终端**：右栏终端的唯一刚需是**快速验证 agent 产物**（跑测试/看日志/手动确认），cwd 跟随会话工作区；重型终端能力（多终端管理、远程、复杂 shell 配置）不是必需。

### 2.3 右栏布局的成熟范式（[leanspec 右栏重设计 spec](https://github.com/codervisor/leanspec/blob/18931885d2e03f543f80ad04fffbdd748e7124c5/specs/234-ai-chat-right-sidebar-redesign/README.md)，GitHub Copilot / Cursor / Linear 模式）

- 默认宽 400px（可拖拽 300–600px），折叠态 48px 图标栏；
- 桌面**推挤**内容 / 平板遮罩 / 移动全屏，三档响应式；
- 打开/宽度/折叠状态持久化；快捷键开关；
- 上下文感知（当前 spec/会话注入 systemMessage）。

## 3. 调研二：上游"重"在哪、能裁到什么程度

### 3.1 重的构成

- **功能面**：8 内置 tab + 6 文件预览器 + 自由窗口 + 底部面板 + 浏览器 tab + 模型工具注入（terminal_*/sidebar_open）+ 19 语言 i18n + 沙箱体系；
- **运行面**：`/sidebar/api` 路由族、`/sidebar/ws/terminal` WebSocket、git 轮询进程、mermaid ~7MB chunk、xterm/monaco 懒加载、node-pty（Windows 预编译失败需 VS Build Tools）；
- **跟随面**：大版本频繁（v0.4→v0.18），peer 依赖随 DSH 版本线走，v0.18.0 已放弃旧 DSH 支持。

### 3.2 裁剪能力（关键新发现）

上游 `PrefsSchema`（`src/config.ts`）：

```ts
tabsEnabled: z.dict(z.boolean()).default({}),     // 按 tab id 逐个开关，缺省=启用
viewersEnabled: z.dict(z.boolean()).default({}), // 同上
```

- 设置页「侧边卡片」把每个内置 tab 渲染为**一张开关卡片**（v0.4.1 起），关闭后：不出现在 + 菜单、不预置、拦截器让位、`openTab` 拒绝、已打开 tab 保留但不影响新布局；
- 理论裁剪形态：只留「侧边对话(sidechat) + 终端(terminal)」两张卡，其余全关 → 界面即"2 tab 轻量右栏"；
- 但**包体积/路由/WS 仍在**（懒加载 + 开关后实际运行时开销小，node-pty 仍要装）。

### 3.3 绕过上游的轻量替代是否存在

- `dsh-sidenote`（Codex 风格侧聊 + 划选注释）：描述自认 **"Thin consumer of dsh-better-sidebar"**——代码轻，但**依赖基座**；
- `dsh-sidebar-qa`（划选追问）等同类插件均列在基座 Tab 插件目录中，同样依赖基座；
- **结论：DSH 生态里"侧边对话"能力目前全部聚合在 better-sidebar 平台上，想要侧聊又不装基座，只剩自研一条路。**

## 4. 路线讨论（重开）

### 路线 A —— 上游裁剪使用（零开发起步）

装 `dsh-better-sidebar`，设置页只开「侧边对话 + 终端」（审查用内置「文件变动」tab 的本轮文件视角替代或直接不装审查）。

| 优点 | 代价 |
|---|---|
| 零开发即得成熟侧聊 + 终端；后续想加能力随时开一张卡 | 包体积/路由/node-pty 仍在；DSH 大版本跟随成本；自研 Tauri 壳适配要调「自定义方案」（CSS + 下移距离，canvas 有让位经验可复用） |
| 侧聊已实现业界正确用法（独立上下文、可保存为新会话） | 界面风格是通用 DSH 风格，无 mia 品牌感 |

### 路线 B —— 自研极简右栏（3 tab：辅助对话 / 审查 / 终端）

完全自研一个轻量右栏插件，只做三张 tab，不装上游。

工作量现实评估（基于上游踩坑史与 canvas 线已有经验）：

| 部件 | 难度 | 说明 |
|---|---|---|
| 右栏壳（推挤/折叠/持久化/三主题令牌） | 低 | 可直接套 §2.3 范式；canvas 线已有 DSH 主题令牌与桌面壳适配经验 |
| 辅助对话 tab | 中 | DSH `fork` + 首条消息注入 canvas 已打通（merge 内核）；侧聊继承上下文 = 复用该链路，增量做"侧线树 + 保存为新会话"；不调模型红线自然满足（fork 后由 DSH 正常跑） |
| 审查 tab | 低–中 | 本轮 git diff + 自检清单化（v1 §4 草图）；canvas 宿主侧已有 workspace 投影经验 |
| 终端 tab | **高** | 真正的大坑：xterm 前端 + node-pty 后端 + WS 会话级路由 + Windows shell 解析/字体/resize 容错 + 跨会话保活——上游为终端单独修了十几个版本的 bug（README v0.12–v0.18 修复节选全是这些） |

**路线 B 的现实判断**：三 tab 中「终端」占八成工作量且无差异化价值；若砍掉终端，则右栏只剩侧聊 + 审查（这反而与"实在工具"里的终端刚需冲突）。

### 路线 C —— 分步演进（推荐）

1. **第 0 步（本周，零开发）**：装上游 + 裁剪开关只留「侧边对话 + 终端」，立即验证：终端/侧聊在桌面壳三主题下可用性、node-pty 能否装、与 canvas 共存——**用最小的成本实测"侧聊 + 终端"这套组合到底值多少**；
2. **第 1 步（按需自研审查 tab）**：若实测好用，自研 `@miasaki/sidebar-review` 注册进 `ctx.betterSidebar`（v1 §4 草图：本轮改动清单 + 收尾自检 + 行级 diff）——审查是差异化点，握在自己手里；
3. **第 2 步（可选，长期）**：若对基座体积/跟随成本不满意，届时**只替换终端**（最难的部件已经用熟，明确要什么再自研），侧聊与审查独立出来。

**决策逻辑**：先零成本拿到"侧聊 + 终端"的实测价值判断，把"是否值得自研"从猜测变成数据；自研投资只投在差异化（审查）上；最重的终端自研被无限期推迟、且被裁剪使用验证后再决定。

### 不推荐的路线

- **全量自研（路线 B 一步到位）**：终端是巨大时间黑洞，且在拿到实测价值判断前就重造轮子；
- **完全不用右栏、只用 DSH 原生 fork/多会话替代辅助对话**：顺序会话做不到"主任务运行中并行咨询"（Claude Code `--resume` 同款限制），失去 §2.1 的核心价值——保留为无插件时的兜底用法，不作目标形态。

### 4.1 重基座问题的四种解法（用户质疑后重开，2026-09-06 晚）

用户质疑：路线 C 第 0 步仍要安装整个基座——裁剪开关只轻了界面，骨架（包体积 / 路由族 / node-pty / WS / DSH 版本跟随）原样保留；且第 1 步审查 tab 经 `ctx.betterSidebar` 注册，会把 mia 侧栏能力**永久绑定在重基座上**。四种解法评估：

| 解法 | 结论 |
|---|---|
| ① 开关裁剪 | 只轻界面不轻骨架——不解决 |
| ② fork 上游做裁剪版 | 活跃上游（v0.4→v0.18 十四个大版本、日更 PR）的 fork = 维护地狱。canvas fork synapse 能成立是因为上游近乎停滞，不可类比——不推荐 |
| ③ 接受重基座 | 用户已否决 |
| ④ 无基座自研 + 终端形态取舍 | 唯一真轻的路线（= 路线 D） |

### 4.2 终端取舍决定整体重量

内嵌终端（xterm + node-pty + WS）是"重"的最大来源：上游 v0.12–v0.18 修复大头全在终端（Windows shell 解析、resize 容错、字体解析、跨会话保活、WSL 路径……）。终端形态三选一：

| 形态 | 成本 | 体验 |
|---|---|---|
| 内嵌 pty | 极高（自研 ≈ 重走上游半年踩坑史） | 同屏 |
| **系统终端启动器**（host spawn `wt -d <cwd>` / pwsh 到会话工作区） | 极低（约 2 天） | 单独窗口（Windows 用户 Alt-Tab 习惯可接受） |
| 两段式（先启动器、后内嵌） | 先低后高 | 届时走"参考 MIT 源码自研"或"重新评估装基座"岔路 |

### 4.3 路线 D —— 无基座自研（重开后的新推荐）

自研 `@miasaki/sidebar`（新线 `dsh-miasaki-sidebar/`）四组件：**右栏壳 + 辅助对话 tab + 审查 tab + 系统终端启动器**。全部复用 canvas 已验证链路：

- 辅助对话底座 = merge 内核同款「fork + 首条消息注入」链路（canvas 已实机验证）；
- 主题令牌 + 桌面壳让位（`--canvas-chrome-reserve` 测量思路）；
- host RPC 模式（插件自建 `/sidebar` 路由，canvas WorkspaceStore 同构）；
- 官方插槽注册（conversation header actions 经验）。

工作量（业余节奏诚实估算）：壳 ~1 周；辅助对话 ~2-3 周（侧线树 / 保存为新会话 / 转录呈现）；审查 ~1-2 周（git diff 渲染 + 自检清单）；终端启动器 ~2 天。**合计约 1 个月**。

路线 D 的取舍诚实声明：放弃"同屏内嵌终端"（单独窗口）；换来零重基座、零跟随成本、与 canvas 同构的技术栈、布局完全自控（不会出现第三方面板与画布 iframe 抢布局）。

## 5. 高效使用方式落到设计的三条铁律（无论哪条路线）

1. **侧聊保持轻**：只做轻量问答定位，不做重任务、不做队列（§2.1 失败模式 1/3）；结果提供"带回主对话"入口（失败模式 2）；
2. **审查是常显上下文面板**：常显性来自"本轮改动自动刷新"，不做重型 Git 客户端（§2.2）；
3. **终端只服务验证**：cwd 跟随会话、单会话保活即可，不追求多终端/远程/复杂配置（§2.2）。

## 6. 决策记录（已拍板，2026-09-06 晚）

1. **路线 D**（无基座自研）——用户拍板；路线 C 因重基座问题否决（§4.1）；
2. **终端形态**：同屏内嵌终端**先规划后实现**——M1 先做系统终端启动器，内嵌终端走 M3 条件立项（node-pty spike + WS 路由 spike + 高频刚需观察）；
3. **审查 tab 归属**：独立新线 `dsh-miasaki-sidebar/`（已拍板，线骨架与总设计已落地）；
4. **「文件变动」能力**：由自研审查 tab 的 git diff 视角承担，不装上游；
5. **开源策略**：与 better-sidebar 生态无耦合，待功能成型后再定；
6. **壳 spike 定稿（2026-09-06）**：better-sidebar 的 `data-pane` 推挤锚点在本机 DSH 0.1.2 不存在；实测定稿 AppFrame frame `padding-right` 推挤 + `shell.overlay` 挂载；原生 `details` 插槽否决（single 槽注入即顶掉官方工具详情面板，官方文档明示 OCCUPIED）；右栏 z-index < 100；推挤下限 1280px。详见线设计文档 §3.1.1。

详细设计见 `dsh-miasaki-sidebar/design/2026-09-06-sidebar-roadmap-design.md`。

## 7. 参考链接

- [DSH-better-sidebar 仓库](https://github.com/omdsh-dev/DSH-better-sidebar)（README / `src/config.ts` / `docs/plans/2026-08-11-declarative-sidebar-settings-design.md`）
- [Codex /side 完全指南（Uravation）](https://uravation.com/media/codex-side-conversation-mode/)
- [Codex 从 0 到 1 §Side chat（掘金）](https://juejin.cn/post/7654092605076881417)
- [Claude Code sidechat 只读侧聊 feature issue #48099](https://github.com/anthropics/claude-code/issues/48099)
- [leanspec AI Chat 右栏重设计 spec](https://github.com/codervisor/leanspec/blob/18931885d2e03f543f80ad04fffbdd748e7124c5/specs/234-ai-chat-right-sidebar-redesign/README.md)
- [CHI'25 Xavier：常显侧面板研究](https://dl.acm.org/doi/10.1145/3706598.3714239)
- [dsh-sidenote（薄消费插件示例）](https://github.com/g-yixuan/dsh-sidenote)
