# 远程连接入口搬到 SSH 页面（2026-10-25）

## 1. 背景与诉求

用户原话：「给远程连接插件入口改个位置，不要占用我用量统计的位置」；对目标位置的拍板：
「可以考虑改到 SSH 页面」。

冲突双方（都在 miasaki profile）：

| 插件 | 槽位 | 注册形态 |
|---|---|---|
| `ds-harness-remote` 0.5.18（第三方，远程连接另一台 DSH） | `sidebar.footer.action` | `id: ds-harness-remote-workspace`，**`order: -20`**（排最前） |
| `@miasaki/dsh-token-monitor`（用量统计） | `sidebar.footer.action` | `id: usage-stats`，默认 order |

侧栏脚部是**同一行**（官方 `SidebarRoot` 的 `.footerActions`，list 槽按 order 排序）。
远程 entry 的 `order: -20` 排在最前，宽形态还带文字标签（`.dshRemoteSidebarLabel`），
用量统计被挤到后面 —— 即用户说的「占用我用量统计的位置」。

## 2. 方案选择：为什么是「SSH 线搬迁」而不是「改插件」或「调顺序」

| 方案 | 结论 | 理由 |
|---|---|---|
| A. 改远程插件的注册（去掉/改槽位） | **否** | 要改 `~/.dsh/profiles/miasaki/node_modules/ds-harness-remote/` —— profile 是用户**运行环境**，动它必须先问用户；且插件一升级改动整体被覆盖，没有常驻机制 |
| B. 只把 `order` 拉开 | **否** | 用户要的是「改位置」而非「调顺序」；脚部仍是两颗丸子争一行，且用量统计未必想常驻第一 |
| C. **SSH 线做「搬迁」**（选定） | — | 见下 |

方案 C 的三条依据：

1. **不碰 profile**：本线（`@miasaki/dsh-ssh`）以 `link:` 装在 miasaki / web 两个
   profile，搬迁逻辑随插件源码走，刷新即生效；需要用户执行的只有「重启加载新版」。
2. **退化方向是「回到今天的行为」**：所有判据只认 DOM 事实（远程插件的类名
   `.dshRemoteSidebarEntry` / `.dshRemoteModeButton` / `.dshRemoteExitLink`）。
   远程插件不在场（web profile）或升级重构导致类名漂移时，CSS 规则与点击目标静默失效，
   入口回落脚部 —— 与 canvas 委托同一条纪律（`querySelector` 落空 ⇒ 静默收手）。
3. **SSH 页面是远程连接的语义近邻**：用户在该页管理「连到另一台机器」；把「连到另一台
   DSH」放同一页，脚部完整留给用量统计。

## 3. 机制（两半，零新增协议、零第三方依赖）

```
SSH 页面（iframe）                     宿主页面（client.js）
─────────────                          ──────────────────
rail 头 btn-remote                     ① CSS：.dshRemoteSidebarEntry{display:none!important}
  │ 显隐/激活态                          （脚部入口整条收起，位置还给用量统计）
  │ ← remote 消息（available/active）     ↑
  │                                     ② 状态观察者：body childList（入口整棵换节点）
  └─ 点击 → ssh:remote-open ─────────►    + 入口节点 attributes:class（isActive 切换）
                                       ③ triggerRemoteEntry()：按 DOM 事实点击
                                          · 未连接 → .dshRemoteModeButton（开远程页）
                                          · 宽态已连接 → .dshRemoteExitLink（退出）
                                          · rail 态已连接 → .dshRemoteModeButton（即退出）
                                          ↓ 远程浮层 .dshRemoteBackdrop z-index 1000
                                        ④ 越狱规则：body:has(.dshRemoteBackdrop) 在场期间
                                           摘掉侧栏实盒子的 backdrop-filter（玻璃陷阱见
                                           §3.1）⇒ 包含块回视口、1000 回根堆叠上下文
                                           ⇒ 全屏盖在 SSH 浮层（z-index 100）之上打开，
                                             关闭后回到 SSH 页面（不必关浮层）
```

### 3.1 关键事实（实现依据，均来自对方源码实测）

- 远程插件 client 半注册四个槽位，其中**只有** `sidebar.footer.action` 的
  `RemoteWorkspaceAction` 是「打开远程页」的入口；`shell.overlay` 的
  `RemoteSessionHeaderAction` 仅在 `status.mode === 'remote'` 时渲染（状态条，非入口）。
- 入口组件是 React：按钮与远程页浮层是同一 Fragment 的兄弟节点。CSS 只藏入口 div，
  浮层（`.dshRemoteBackdrop`，`position:fixed; z-index:1000`）不受影响。
- **浮层曾被困在侧栏里（2026-10-25 实机复验抓到，静态推断被推翻）**：首版按「同文档
  根堆叠上下文、1000 > 100」推断浮层会盖在 SSH 页上；**实机两面都不成立** ——
  ① 从 SSH 页点入口，SSH 页上毫无反应；② 回到会话页，远程页开着但是个**侧栏宽的
  小卡片**。根因：appearance 线玻璃档位（`lib/config.js` 的 `buildGlassBootCss`：
  `html[data-mia-glass=light|frost|mica] [data-slot="sidebar"] > * { backdrop-filter: … }`）
  —— `backdrop-filter ≠ none` **同时造出包含块 + 堆叠上下文**，而远程浮层正渲染在
  `sidebar.footer.action` 槽里 ⇒ 它的 `inset:0` 变成「填满侧栏」（宽=侧栏宽），
  `z-index:1000` 被困在侧栏的堆叠上下文内（盖不住 body 级的 SSH 浮层 z-index 100）。
  官方壳自身不给侧栏挂 backdrop-filter（模块 CSS 实测 0 处；3 个 transform 都在品牌行
  深处，不是 footer 祖先）⇒ 陷阱只有这一处。
  **修复**（SSH 线注入一条规则）：`body:has(.dshRemoteBackdrop) [data-slot="sidebar"] > *
  {backdrop-filter:none!important}` —— 远程浮层在场期间摘掉侧栏实盒子的玻璃，包含块
  回到视口、1000 回到根堆叠上下文。`!important` 必须（外观线运行时 `<style>` 注入顺序
  不由我们决定，等特异性两侧均 (0,2,1)）；`:has()` 在本环境可用有先例（本线 2026-09-10
  的 canvas 胶囊合成规则就在用 `:has(+ …)`，实机验证过）。
  **A/B 实测**（无头 Edge + CDP，复刻真实 DOM/CSS 结构的探针，6/6 PASS）：
  A 组（玻璃开·无修复）浮层宽 **232px**（=侧栏宽）、视口中心命中 `dsh-ssh-overlay`、
  侧栏实盒子 computed `blur(20px) saturate(1.4)` —— 用户两个症状逐字复现；
  B 组（玻璃开·有修复）浮层宽 **1256px**（=视口宽）、中心命中 `.dshRemotePage`、
  侧栏 computed `none`。副作用仅「远程页开着那一刻侧栏不模糊」——那一刻整屏有浮层遮罩。
- 入口 DOM 两种形态（`dist/client/workspaces.js`）：未连接时 `.dshRemoteModeButton`
  是 `button`（`onClick → show()`）；**宽形态 + 已连接时它是无回调的 `div`**，退出在
  旁边的 `.dshRemoteExitLink`。⇒ 点击目标必须按 `isActive` + 退出链存在性选择，
  否则宽态已连接时程序化点击会点在一颗死 div 上。
- 官方 `sidebar.footer.action` 是 list 槽，每 entry 经 `SlotErrorBoundary` 直接渲染
  （无额外 DOM 包裹）⇒ 入口 div 就是 `.dshRemoteSidebarEntry` 本身，类名选择器稳定。

### 3.2 为什么不把入口搬进 iframe DOM

SSH 页面是**独立文档**（`/ssh/` iframe，懒加载）。跨文档搬 DOM 不可行（React 也无法
跨文档 portal 到懒加载目标）⇒ 页面入口由本线**自绘**（自己的设计语言：rail 头
`.icon-btn`，激活态复用现成 `.is-active`），行为经既有 postMessage 协议回宿主执行。
消息带 `overlayToken`（chrome 消息同款防伪），错 token 一律拒。

## 4. 判据与退化

| 情形 | 行为 |
|---|---|
| 远程插件在场、未连接 | SSH 页入口可见（「远程连接 DSH」）→ 点击开远程页 |
| 远程插件在场、已连接 | 入口激活态（「远程 DSH 已连接 · 点击退出」）→ 点击退出远程 |
| 远程插件不在场（web profile / 卸载） | 入口整颗隐藏；脚部远程入口回落可见 |
| 远程插件类名漂移（升级重构） | 同上（CSS 与点击目标同时失效）—— 需按 §5 复验 |
| SSH 插件被禁用 | CSS 规则不注入 ⇒ 远程入口留在脚部（搬迁前形态；若玻璃档位开着，从脚部打开的远程页仍是侧栏宽 —— 那是 appearance × ds-harness-remote 的既存不相容，非本次引入） |
| 玻璃档位关闭 | 越狱规则是 no-op（侧栏本就没有 backdrop-filter），远程页天然全屏 |
| iframe 未加载即收到状态 | `renderRemoteEntry` 对节点缺席静默返回；load / 开浮层时补推 |

## 5. 验收判据（实机，归用户）

1. miasaki 桌面端：侧栏脚部**只剩「用量统计」**，远程入口不再占位；
2. SSH 页主机导航头出现「远程连接 DSH」；web profile（无该插件）**不出现**；
3. 点击后远程浮层**全屏盖在 SSH 页之上**打开；关闭后回到 SSH 页面；
4. 已连接远程时入口转激活态、点击退出；退出后复位；
5. 退化：禁用远程插件后脚部入口回落（行为与搬迁前一致）。

升级 `ds-harness-remote` 后需复验 §3.1 的三个类名是否仍成立（`.dshRemoteSidebarEntry` /
`.dshRemoteModeButton` / `.dshRemoteExitLink`）—— 漂移则本搬迁静默失效（入口回落脚部），
属于已知且安全的退化，不是破版。appearance 线若改玻璃选择器（`[data-slot="sidebar"] > *`），
越狱规则需同步对齐（判据：远程页在全屏与侧栏宽两种形态间二选一，不会「静默半碎」）。

### 5.1 复验结果（2026-10-27，第二轮）

**前提变化：`ds-harness-remote` 已从本机所有 profile 卸载**（用户于 10-25 复验后移除；
各 profile `package.json` 零命中、`.pnpm` store 无包目录，仅剩 `.bin` 残留 shim）。
本机真机走查（miasaki profile web）结果：

- **通过**：判据②的插件不在场分支（`#btn-remote` 节点存在但 `hidden=true` /
  `offsetParent=null` / title 空 —— 整颗隐藏、不占位）；判据⑤退化方向（脚部无远程入口、
  行为与搬迁前一致）；判据①的退化版（脚部只剩「用量统计」）；两条新 CSS 规则真机注入
  确认；SSH 浮层打开与页面渲染正常（新增 CSS 无误伤）。
- **归用户（前提 = 重装 `ds-harness-remote`）**：判据①完整版（脚部入口被收起）、
  ③浮层越狱全屏（修复点的真机终验 —— 现有证据为 A/B 探针 6/6 + 越狱规则注入在场）、
  ④连接态切换与退出。
- web profile 不再单独走查：miasaki 当前同为插件不在场环境，与 web profile 共用同一
  代码路径与 DOM 形态（判据②后半等价覆盖）。

## 6. 测试契约（`test/`，随线回归）

- `app.test.js`：`remoteEntryPresentation` 四态纯函数（vm realm 逐字段比对）；
- `client.test.js`：CSS 让位且不误伤 `.dshRemoteBackdrop`；越狱规则（`:has` + `!important`）；
  `remoteClickTarget` 四态（含缺席与形状不符）；`ssh:remote-open` 行为闭环（含错 token 拒、
  入口退场静默）；`remote` 消息下发 + body/entry 两条观察者各司其职。
- 一次性 A/B 探针（无头 Edge + CDP，复刻真实 DOM/CSS 结构）：A 组浮层宽 232px / 中心命中
  SSH 浮层；B 组浮层宽 = 视口宽 / 中心命中远程页 / 侧栏 computed `none`。6/6 PASS，
  探针即用即删（结论已固化进本文档与 CHANGELOG）。
