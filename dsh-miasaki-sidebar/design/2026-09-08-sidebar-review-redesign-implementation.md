# 审查 tab 改版 + 浏览器式标签页 — 实施方案（v0.5.0）

- 日期：2026-09-08
- 状态：方案定稿（未写代码，待用户拍板后开工）
- 参考图：用户提供（侧边栏审查面板：视图下拉 + 目录分组文件列表 + 浏览器式标签头）
- 语义拍板（2026-09-08 用户确认）：
  - **「上一轮更改」= 最近一次 git 提交（HEAD vs HEAD^，`git show HEAD` 视角）**，非会话轮次追踪；
  - **「全部分支更改」= 工作区全部改动 vs HEAD**（未暂存 + 已暂存 + 未跟踪，即现有 status 快照的全量视图）。
- 三项拍板（2026-09-08 第二轮，本文档 §10 已定）：
  - **`⌄` 标签列表菜单本期实现**（列出全部标签 + 激活态，点击切换）；
  - **视图切换即拉取**（切视图立刻重新 fetch，与手动刷新走同一条链路）；
  - **目录组头默认折叠**（初始全部折叠，展开态记在 tab 实例内存）。

## 1. 需求拆解（对照参考图）

| 参考图元素 | 现状 | 目标 |
|---|---|---|
| 标签头 `[⌄] [审查 ×] [＋]` | 标签栏是三枚固定按钮（审查/终端/辅助对话）+ 右侧 × 回空态，**单值激活** | 浏览器式：多标签并存、每标签独立 × 关闭、`＋` 新建、激活态高亮、非激活 keep-mounted 保留状态、溢出横向滚动 |
| `未暂存 ▾` 下拉（未暂存✓/已暂存/全部分支更改/上一轮更改） | 无视图概念，只有「工作区 vs HEAD」一枚快照 | 四视图切换，每视图独立数据面 |
| 文件行 = 类型图标 + 文件名 + 灰色目录 + `+N -M` + `▾` | 行 = XY 徽章 + 完整路径 + 点名 chip + 展开钮 | 目录分组（组头 = 灰色目录 + 组统计 + 折叠）+ 文件行（图标/文件名/相对目录/统计/展开） |
| `page.tsx app/result/` 行红色描边 | 未点名文件红色描边（`unnamed` class） | **保留**：未点名红描边 + 点行点名、点 `▾` 展开 diff 的既有交互不动 |

## 2. 现状盘点（实现起点，v0.4.0-miasaki.1）

- `index.js`：`/sidebar/api/review/status`（`git status --short --untracked-files=all` → `{branch, head, entries[{xy,path}], truncated, total}`，2000 条设界）、`/review/diff`（单文件 unified diff 解析，20000 行设界）、`/review/checklist`（GET/POST 点名清单）；`parseUnifiedDiff` / `verifyDocSync` / `ChecklistStore` 已导出并有单测；
- `client.js`：`TAB_IDS = ['review','terminal','sidechat']`，`store.tab` 单值；`Shell()` 只渲染激活 tab（非激活即卸载）；`ReviewTab` = 头部（「收尾自检」标题 + 徽标 + ↻）+ 平铺文件行（XY 徽章 + 路径 + 点名 chip + DiffViewer 展开）；持久化 `miasaki-sidebar:v2:<sessionId>` = `{open, width, tab}`；
- 数据约定：cwd 由 sessions 服务 + watchdog 提供；`fetchSidebar` 统一注入 cwd；git 全程只读、2000/20000 设界、`GIT_BIN` 绝对路径。

## 3. 方案总览

```
v0.5.0-miasaki.1 = 批 A 数据面（host）+ 批 B 审查 UI（client）+ 批 C 标签框架（client）+ 批 D 文档
```

- 批 A 与批 B 可分开验收（A 先落地、`/sidebar/api` 用例覆盖），批 C 独立闭环；
- 版本号：`package.json` + `index.js` health `version` 字段同步升 `0.5.0-miasaki.1`；
- 生效契约不变：`link:` 落盘即改源文件，但 host 半与 client bundle 在 `dsh web` 启动时载入内存，**须重启 host**；
- README「改完必须重启」提醒已存在；二次文件 `test/api-routing.test.js` 走真实 HTTP，注意与 `createApi` 签名协同（`createApi` 无变化，只加路由分支）。

## 4. 批 A —— 审查数据面（host，index.js）

### 4.1 视图枚举与 git 命令映射

| view | 语义 | 行集来源 | 统计来源 |
|---|---|---|---|
| `unstaged` 未暂存 | 工作区改动（含未跟踪） | status 行 `XY[1] !== ' '` 或 `XY === '??'` | `git diff --numstat`（工作区 vs 索引）+ untracked 逐文件 `git diff --no-index --numstat > NUL file` |
| `staged` 已暂存 | 暂存区 | status 行 `XY[0] !== ' '` | `git diff --cached --numstat` |
| `all` 全部分支更改 | 工作区 vs HEAD（全量） | status 全部行 | `git diff HEAD --numstat` + untracked 逐文件 |
| `last` 上一轮更改 | HEAD 提交 vs HEAD^ | `git diff-tree --name-status --no-commit-id -r HEAD` | `git diff-tree --numstat --no-commit-id -r HEAD`（同一次调用族，与 name-status 合并） |

要点：

1. **路径归一**：三视图共用 `status` 行（含 rename 目标路径提取，沿用 `renameTarget()`）；last 视图由 diff-tree 解析，两行各自读取。
2. **统计合并**：numstat 输出 `add\tdel\tpath`（`-` 表示二进制；rename 输出格式以**真实 git 实测校准**并写进单测——预期 `add\tdel\tnewpath`，测试覆盖 rename/quoted-path 两种形态）；按 path 归并进 entry `{add, del, binary}`。
3. **untracked 统计**：`git diff --no-index --numstat > NUL <abs>` 逐文件——**设界 200 个**：超过 200 的 untracked 条目只保证行存在，`add/del` 置 `null`，列表头标 `truncated`（沿用 2000 条整体设界语义，不逐文件 spawn 爆时长）。
4. **降级矩阵**（不落 500，参照现有 InputError/NotFoundError 风格）：
   - 非 git 仓库：既有 `InputError` 400（不变）；
   - **空仓库（无 HEAD）**：`staged`/`all` 正常（无 HEAD 时 `git diff HEAD` 会失败）→ `all` 视图降级为「status 行集 + untracked 统计 + staged 统计」并 `noCommits: true`；`last` 返回 `{ entries: [], noCommits: true }`，UI 显示「尚无上一轮更改（仓库还没有提交）」；
   - untracked 统计失败：`add/del = null`，行保留（统计列显示 `-`，不吞行）。
5. **响应结构**（`GET /review/status?view=<v>`，无 view 参数保持旧语义 = `all`，向后兼容旧 client）：
   ```js
   {
     status: {
       view, branch, head, noCommits?,       // noCommits 仅 last/无 HEAD 时出现
       entries: [{ path, xy?, code?, add, del, binary }],
       truncated, total,
     },
     docSync: { pending: [] },                // 不变
   }
   ```
   `code` 仅 last 视图存在（diff-tree 状态字母 A/M/D/R…），供列表徽章/图标降级用。
6. **纯函数导出（可单测）**：`parseNumstat(text)`、`parseDiffTree(text, nameText)`、`filterStatusByView(rows, view)`、`parseUntrackedNumstat(text)`（若实测 --no-index 输出形态与普通 numstat 一致则合并实现）。

### 4.2 路由改动

`/sidebar/api/review/status`：`view` query 参数白名单校验（`unstaged|staged|all|last`，非法 → 400）；其余路由零改动。`createApi` 签名不变。

## 5. 批 B —— 审查 UI 改版（client.js）

### 5.1 组件树

```
ReviewTab (props: visible, tabId)
├─ ReviewHead
│  ├─ ViewMenu  ← 视图下拉：button「未暂存 ▾」+ 浮层菜单（fixed 定位，绕开列表 overflow 裁剪）
│  └─ 刷新 ↻（沿用）
├─ ReviewList（目录分组）
│  └─ FileGroup ×N（组头：灰色目录 + 组统计 +N -M + 折叠 ▾）
│     └─ FileRow ×N（类型图标 + 文件名 + 灰色相对目录 + +N -M + 展开 ▾）
│        └─ DiffViewer（复用，零改动）
└─ 空态分支（无会话 cwd / 工作区干净 / 尚无上一轮更改，沿用现有 emptyhint 样式）
```

### 5.2 视图切拉

- `ViewMenu`：`role="menu"` + `menuitemradio`（`aria-checked`），↑↓/Enter/Esc 键盘支持；浮层 `position: fixed`（由按钮 getBoundingClientRect 定位），点外部关闭；选中项 ✓；
- 视图切换 → `setView(view)` → 重新 `fetchSidebar('/review/status', { view })`（复用现有效果链，60s TTL/visible 门/手动刷新全部沿用）；
- 视图状态属于 **tab 实例级**（存 tab 记录 `view` 字段，随持久化 v3 一起落盘），切换标签互不干扰。

### 5.3 目录分组与文件行

- `groupEntries(entries)`：按 `path` 的 dirname 分组（Windows/Unix 分隔符统一为 `/`），组内按 path 字典序；组统计 = 组内 `add/del` 求和（`binary`/null 置 `-`）；
- 组头：`目录/`（灰色、等宽），右侧组统计 `+N`（绿）`-M`（红）+ 折叠箭头 `▸/▾`；**默认折叠**（用户拍板：初始全部折叠，展开集合存 tab 实例内存，切标签保留、刷新重置）；
- 文件行：左侧扩展名图标（内联 SVG，按扩展名着色：ts/tsx 蓝 `#3178c6`、tsx 亦可紫、js 黄 `#f1e05a`、json 黄 `#cbcb41`、md 青 `#519aba`、css/scss 紫 `#563d7c`、yaml 灰、其他灰——颜色表集中一处，主题下微调对比度）；文件名（primary）；灰色相对目录（dirname，置灰）；右侧 `+N -M`（绿/红，null 显示 `-`）+ 展开 `▾`（DiffViewer 复用）；
- **未点名红描边保留**（截图 `page.tsx app/result/` 行）：
  - 行主体点击 = 点名 toggle（沿用现状交互与 checklist 持久化）；
  - `▾` 点击 = 展开/收起 diff（沿用）；
  - 未点名 = 红色描边 + 文件名旁保留点状警示语义与 docSync ⚠；
- 徽标：头部保留「N 条未点名 / 全部点名 / 工作区干净」徽标（现状能力，视觉移到分组列表头下方一行，避免与视图下拉争行）。

### 5.4 视觉规格（改动面）

- 新增 CSS：`.dsh-sidebar-viewmenu*`（下拉与浮层）、`.dsh-sidebar-group*`（组头）、`.dsh-sidebar-fileicon*`（图标着色）、`.dsh-sidebar-stat-add/del`（绿/红统计）、`.dsh-sidebar-tab-close`（标签 ×）；
- 全部颜色走 `--dsw-alias-*` 令牌（沿用现有约定，三主题跟随），分类图标颜色为设计专用色（深/浅主题各配一档）；
- 布局：ReviewHead 两行（视图下拉 + 刷新在第二行右侧，贴近参考图）；列表 `flex:1; overflow:auto` 不变。

## 6. 批 C —— 浏览器式标签页框架（client.js）

### 6.1 状态模型（store 扩展）

```js
// state.tab: string|null        → 弃用
// state.tabs: [{ id, type, view? }]   // id = `${type}-${seq}` 递增；type ∈ review|terminal|sidechat
// state.active: string|null           // 激活 tab id；无 tab 时 null（空态）
```

- 多实例允许：同 type 可开多份（`审查`、`审查 2`……），命名按 type 去重递增；
- 持久化 **v3**：`{ open, width, tabs: [{id, type, view?}], active }`，键 `miasaki-sidebar:v3:<sessionId>`；
- **v2 → v3 一次性迁移**：`tabs = tab ? [{ id: type+'-1', type, view: null }] : []`，`active` 对应；迁移后删 v2 键（v1 遗留迁移链保持现状）；无记录会话保持当前 UI 状态（现状语义不变）；
- 实例级 UI 状态（展开集合、组折叠、shell 选择、diff 展开）留在 React 内存，**不**随持久化（现状一致，刷新后回到默认视图——可接受；`view` 字段是例外，视图像「上下文」值得记住）。

### 6.2 标签栏渲染（Shell）

```
[⌄ 标签列表] [标签：标题 ×] [标签：标题 ×] … [＋]      ← overflow-x:auto，细滚动条
```

- 激活标签：选中态（复用 `--dsw-alias-interactive-bg-hover` 中性灰约定）；未激活 hover 提亮；标签统一高度 28px、圆角 8px（沿用 tab 视觉基线）；
- 每标签 `×`：移除该实例；若关闭的是激活标签 → active 切到最后关闭的相邻标签（浏览器行为）；关掉最后一个 → 空态（现状语义）；
- `＋`：新增标签 = 打开空态选择页（**空态语义重定义为「新标签页」**：`tabs.length === 0` 或点 `＋` 均落到选择页；点卡片创建对应类型新标签并激活；sidechat 卡片 M2 仍禁用）；
- `⌄` **本期实现**（用户拍板）：常驻按钮，点击弹出全部标签列表（类型图标 + 标题 + 激活态高亮），点击条目切换激活；浮层与 ViewMenu 同一套 fixed 定位机制（标签栏自身 `overflow-x:auto` 会裁剪 absolute 子元素，故必须 fixed）；
- **keep-mounted**：`Shell()` 遍历 `tabs`，每个实例渲染 `<div style={display: active ? '' : 'none'}>` 包裹 TabBody（会话状态保留，切换不回丢失 —— 这是「浏览器标签页」与现行「卸载式切换」的本质差异）；成本可控（三个类型都很轻）；
- `visible` 门调整：`tabVisible = isActive && state.open && state.pageVisible`（非激活标签暂停 TTL，与原语义一致且更强）。

### 6.3 表格（TAB 注册表扩展）

```js
TABS = [
  { id: 'review', label: '审查', note, icon, createView: () => ({ type:'review', view:'unstaged' }) },
  { id: 'terminal', label: '终端', ... },
  { id: 'sidechat', label: '辅助对话', disabled: true, ... },
]
```

- `EmptyState` 卡片点击 → `store.set({ tabs: [...tabs, mkTab(type)], active: 新id })`；
- 关闭 × 与 header 的旧 × 行为合并：header ×（现状「关闭当前标签」）语义并入标签自身 ×，面板右上不再需要全局 ×。

## 7. 测试计划

| 项 | 覆盖 | 文件 |
|---|---|---|
| `parseNumstat` | 正常三列、二进制 `-`、rename 输出形态（实测校准）、quoted path | `test/review-view.test.js`（新） |
| `filterStatusByView` | 四视图的行集过滤（M/MM/??/R/MM 组合）、untracked 归属 unstaged/all | 同上 |
| `parseDiffTree` | 状态字母与 numstat 合并、首提交（root commit）降级 | 同上 |
| **真实临时 git 仓库** | init + 配置 user + 首提交 + 制造 M/MM/??/R/二进制/空格路径 → 逐视图断言行集与统计 | `test/review-view.test.js`（新，走 repo fixture） |
| 路由 | `view` 白名单（非法 400）、四视图 200、`noCommits` 降级 | `test/api-routing.test.js`（扩） |
| 既有 | `parseUnifiedDiff` / `verifyDocSync` / `ChecklistStore` / 终端 7 项 / 路由 9 项 | 保持全绿，20 项基线不回退 |

- client 侧纯逻辑只保留「分组/图标映射」两个纯函数，**无法单测**（client.js 非模块化入口）→ 以「实机验证清单」覆盖：四视图往返、分组统计求和、点名红描边/展开 diff、多标签开关/keep-mounted 状态保持、v2→v3 迁移（localStorage 注入旧键实测）。

## 8. 实施批次与验收

| 批 | 内容 | 文件 | 验收 |
|---|---|---|---|
| A | view 枚举 + numstat/diff-tree + untracked 统计 + 过滤纯函数 + 路由白名单 + 单测 | `index.js`、`test/review-view.test.js`(新)、`test/api-routing.test.js` | 单测全绿；`view` 四值 curl 200、非法 400 |
| B | ViewMenu + 分组列表 + 图标 + 统计 + 未点名保留 | `client.js` | 参考图逐项对照；点名/diff/未点名红线回归 |
| C | tabs[]/active + 持久化 v3 迁移 + 标签栏（×/＋/滚动/keep-mounted）+ 空态 = 新标签页 | `client.js` | 多标签开/切/关、状态保持、刷新后恢复、v2 键迁移 |
| D | 版本号同步 + README（组件蓝图/验证清单）+ CHANGELOG + 本设计文档状态改「已落地」 | `package.json`、`README.md`、`design/CHANGELOG.md`、本文件 | 文档同步纪律自检 |

批次内顺序：A → B → C → D；A/B 可与 C 并行（A 只动 host、B/C 只动 client，但 B 依赖 A 的响应结构，故 B 在 A 后；C 独立）。

## 9. 风险与取舍

| 风险/取舍 | 处理 |
|---|---|
| numstat 对 rename/quoted-path 的确切输出形态 | 以真实 git 实测校准，单测固化；实现时先写一次真实 repo 探针跑一把再看 assert |
| untracked 统计逐文件 spawn 的时长 | 200 个设界 + `truncated` 标记；超过部分统计列显 `-` |
| 空仓库/无 HEAD | `noCommits` 降级 + UI 文案，不出 500 |
| 多标签 keep-mounted 的内存 | 三类型组件极轻，成本可忽略；若 M2 侧线体量上来再评估 lazy 策略 |
| 持久化 v3 迁移丢失 | 迁移函数幂等 + v2 键删除前先写 v3；单测覆盖迁移路径 |
| `⌄` 标签列表菜单 | P2 可选，本期占位/省略，不阻塞主结构 |

## 10. 拍板结果（2026-09-08 用户确认）

1. `⌄` 标签列表菜单：**本期实现**（列出全部标签 + 激活态，点击切换）；
2. 视图切换：**切换即拉取**（切视图立刻重新 fetch，与手动刷新同链路）；
3. 组头默认态：**默认折叠**（初始全部折叠，展开集合存 tab 实例内存）。

## 11. 实测校准（2026-09-08 探针，`_refs/git-probe`，用后即删）

方案 §4.1 的「以真实 git 实测校准」已执行，四条与初稿不同的关键结论：

| 项 | 实测结论 | 影响 |
|---|---|---|
| numstat rename 形态 | `0\t0\told => new`（非 `{old => new}`），空格路径不加引号 → `=>` 切分有歧义 | **改用 `-z` 机器格式**：rename 记录为 `add\tdel\t\0old\0new\0`，无歧义 |
| `git diff-tree` root commit | 默认输出**空**，需 `--root` | **改用 `git show --numstat -z --format=`**：root commit 与普通提交统一，且默认带 rename 检测 |
| `--no-index --numstat` | 输出 `3\t0\tNUL => untracked new.ts`（带前缀） | **untracked 统计改为 host 读文件**（行数 / NUL 字节判二进制 / 2MB 设界），零 spawn |
| 空仓库（无 HEAD） | `diff HEAD` / `diff-tree HEAD` / `rev-parse HEAD` 均退 128 | `noCommits` 降级（见 §4.1 第 4 条） |
| status 路径引号 | `?? "untracked new.ts"`、`R  a -> "b c"` | 新增 `unquoteGitPath()`（含八进制 UTF-8 字节解码），修既有 status 路径带引号的小瑕疵 |

最终 git 命令映射：`unstaged` → `git diff --numstat -z`；`staged` → `git diff --cached --numstat -z`；`all` → `git diff HEAD --numstat -z`；`last` → `git show --name-status -z --format= HEAD` + `git show --numstat -z --format= HEAD`。

