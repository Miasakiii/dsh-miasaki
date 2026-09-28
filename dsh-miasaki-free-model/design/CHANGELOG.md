# 变更记录 — dsh-miasaki-free-model（第九线）

> 本线 2026-09-28 由 `dsh-miasaki-desktop/plugins/dsh-free-model-pool/` 迁出、独立成线。
> 迁出之前的改动记录在 [`../../dsh-miasaki-desktop/design/CHANGELOG.md`](../../dsh-miasaki-desktop/design/CHANGELOG.md)
> （搜索「免费模型池」）；本文件从迁出之后的改动开始记。

---

## 2026-09-29 · 迁出收尾：全量 161 项 PASS + 核销一条守卫基线欠账

> 第九线迁出（09-28）之后的**收尾轮**：仓库级闸门复跑 + 文档归一。本线代码只动了一行注释。

### 一、抓出两处「迁移漏登记」—— 本线当时对两道仓库级闸门**不可见**

| 闸门 | 漏在哪 | 后果 |
|---|---|---|
| `scripts/check-silent-guards.mjs` | `LINES` 数组只有八条线（**注释当时已写成「九线」**，实现没跟上） | 本线**整条不被扫描**；且基线里那条本线条目被判「**可回收**」 |
| `scripts/check-message-sources.mjs` | `REPO_TARGETS` 同理没补 `dsh-miasaki-free-model` | 本线的 `lib/**` 与 `patches/**` 不在退役 v3 写法检查范围内 |

**为什么危险**：闸门对「可回收」的提示语只说「基线有、当前无」—— 照提示删掉基线，
等于把「**没去扫**」固化成「**已干净**」，而且这条线里此后的真回归再也不会被抓住。
**判据**：见到「可回收」先核**扫描清单**（`LINES` / `REPO_TARGETS` / `SKIP_PATH_PREFIXES`），再决定动不动基线。

修后实测 `[实测]`：`silent-guards` 扫描根 10 → **11**、命中 59、**新增 0 / 可回收 0**；
`message-sources` 仓库内 198 → **215** 个源码文件、命中 0。

### 二、核销基线里那条 `existsSync` 欠账（58 → 57 类）

`lib/index.js` 的 `for (const id of PRESETS)` 里 `if (!existsSync(p)) continue;` ——
三个预设（`kurumi` / `whale` / `inverse`）**各自独立安装**，未装的那个**本就不该被写**：
这里的 `existsSync` 是**判据本身**，不是「输入缺件却继续跑」的守卫（与 desktop 线
`uniqueDirectory()` 那条同族的**规则局限误报**）。
处置：就地写 `// guard-ok: <理由>` + 从 `scripts/silent-guard-baseline.json` 移除该条。

**踩到的口径坑（入纪律）**：`guard-ok` 判定只认**命中行或紧邻的上一行** ——
第一版写成三行注释块、`guard-ok` 落在首行 ⇒ 豁免**静默不生效**（闸门仍报「新增 1」）。
**多行注释块时，`guard-ok` 必须落在最后一行。**

### 三、同批文档归一

根 `README.md` 新增 2026-09-29 基线（161 项 / 九线）；回归矩阵全量 157 → 161、
`free-model` 11 → 15、repo 行改「跨九线」；`AGENTS.md` 八线 → 九线并写入
**加线/迁线必须同改的七处清单**。

**验证**：全量 `node scripts/verify-all.mjs` → **161 项全 PASS**（`free-model` **15/15**、`repo` 3/3）；
`check-silent-guards` / `check-message-sources` 单独复跑亦全绿。

---

## 2026-09-28（续六）· 事故复盘：模型页供应商编辑白屏 —— **不是本线造成的**（并撤掉模型页入口）

用户报「**设置模型页改出问题了，供应商无法编辑了，点击编辑就是白屏无法返回**」。
时间上紧挨着我刚动过模型页相关的东西，**我第一反应认定是自己的锅**，先撤了代码。
**随后用浏览器自动化取证，结论是：与本线无关。**

### 一、真实根因（实测证据链）

用 playwright 起临时 host（web profile）复现「设置 → 模型 → 点编辑」：

| 实验 | 结果 |
|---|---|
| **① 撤掉本线 occupant 后**，点 `opencode` 的编辑 | **仍然白屏**，同一个错误 |
| ② 点 `DeepSeek 账号` 的编辑 | 正常 |
| ③ 崩点 | `TypeError: (0 , react_jsx_runtime.jsx)(...) is not a function` **at `ModelListEditor`**（`@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`），控制台另有一条 `slot entry crashed in 'settings.section'` |

**⇒ 崩的是官方模型页组件 `ModelListEditor`** —— 只有"平台型"供应商（opencode / 微信小程序大赛 / step）
的编辑面板用到它；`DeepSeek 账号` 走另一条路径，所以只有那些行会白屏。

**它为什么坏了**：那个包里躺着 desktop 线的运行时补丁产物 ——

```
[patch] 状态   patched  (SHA-256 950BE2350D9C6850…)
[patch] 语法   合法
client.js         202,111 B   （补丁产物）
client.js.dsh-bak 186,641 B   （DSH 0.2.0-rc.1 官方原版）
```

对比两份文件的注入痕迹：官方原版 `reasoningRow=0 / REASONING_LEVELS=0 / testingAll=0`，
补丁产物 `reasoningRow=2 / REASONING_LEVELS=3 / testingAll=8` —— **补丁确实改写了
`ModelListEditor`**（它 `replaceLine` 重写的那一行在 0.2.0 上语义已变）。
产物**语法合法**（所以 `status` 报「语法 合法」、`verify` 不会红），**运行时才炸**。

**结论**：`dsh-miasaki-desktop/patches/dsh-client-ui-settings-models/` 的 baseline 是
**0.1.7-alpha.2**，在 **0.2.0-rc.1** 上「零适配」的说法**与实测不符** —— 该补丁需要
`rebuild-baseline.mjs` 重建基线并重新对齐锚点。**这属于 desktop 线的范围，本线不越线代改。**

### 二、恢复办法（两条，任选）

```powershell
# 立即恢复：还原官方原版。模型页编辑马上能用；代价是暂时失去补丁的三项功能
# （思考强度下拉 / 逐模型测试连通性按钮 / 能力徽标）
cd dsh-miasaki-desktop\patches\dsh-client-ui-settings-models
node patch.mjs revert
```

或等 desktop 线对齐 0.2.0 后重打：`rebuild-baseline.mjs` → 同步三个常量 → `verify` → `apply`。

> **本条路的执行结果（2026-09-28，经用户确认）**：`revert` 已跑 —— `client.js` 还原官方原版
> 186,641 B、`status` 报 `original`（`7674ED0B…`）；随后起临时 host 用 playwright 复验
> 「设置 → 模型 → 点 opencode 编辑」→ **编辑表单正常打开、无 TypeError**。
> **官方原版不崩** ⇒ 坏的确是补丁产物，因果闭环。

### 三、本线这一侧：两个改动，一个理由更正

1. **仍保持撤销 `settings.models.provider-card`** —— 但**理由更正**：不是"它导致了白屏"
   （实测证明不是），而是**风险**：官方模型页的**编辑面板也会 dispatch 这个槽**
   （`dsh-client-ui-settings-models/lib/client.js:2458-2463`，编辑面板与 occupant 在同一个
   children 数组里），occupant 在渲染路径上出任何问题都会让**整棵 React 树卸载成白屏**。
   而那个入口本来就不是用户要的（用户要的是"一个设置页"）。**模型页是官方的地盘，本线不碰。**
2. **闸门保留**：`client-bundle.test.js` 的「绝不往 `settings.models.*` 注册」照旧 ——
   它守的是一条**边界**，不是某一次事故。

### 四、这一课：时间上的巧合不是因果

用户报障时我刚动过模型页相关的东西，于是我把"最像"的当成"就是"，**先撤代码再取证**。
正确顺序是**先复现、先做 A/B 对照**：

- A 面（撤掉我的代码）与 B 面（放回我的代码）**都崩** ⇒ 我的代码不是变量；
- 崩点堆栈是 `at ModelListEditor`（**官方组件名**）⇒ 变量在别处；
- 最后用"官方原版 vs 补丁产物"的**注入痕迹对比**闭环。

**我撤掉的那段代码是无辜的**；"模型页不碰"这条边界本身站得住，但它该由**风险**论证，
而不是由一次**没查清的事故**论证 —— 文档里原来的因果表述已在本次更正里改掉。

### 五、验证

六份测试 **62 例**、`verify-all` **161 项全 PASS**（本线代码未因本次复盘改动）。

---

## 2026-09-28（续五）· 方案修订：不再另起一页，改为**增量进上游插件的设置页**

用户反馈三条：**「页面太丑了」**、**「我要的是对 Our Free Model 做增量」**、
**「不要 Our Free Model 和免费模型页分开，把他们合一起」**（公告去掉、设置页名字可以叫「免费模型」）。

### 一、我做错了什么（先记账）

M2 我另起了一页（`settings.section` id `free-model`），并用**内联 style + 14 个基础主题令牌**
手搓了三区。对照上游插件的页面：

| | 我的页面 | 上游页面 |
|---|---|---|
| 样式载体 | 内联 style 对象 | **109 个 CSS 类的完整设计系统**（`ofm_hero` / `ofm_card` / `ofm_pill` / `ofm_stat` / `ofm_table` / `ofm_seg` / `ofm_kvc`…） |
| 层级 | 只有 `bg-layer-1/2` | 用 **`bg-layer-3`** 抬卡片、`ofm_hero` 用渐变 |
| 文字 | primary / secondary 两级 | **三级**（含 `label-tertiary`） |
| 细节 | 无过渡、无阴影、无自适应网格 | `transition` / `box-shadow` / `grid auto-fill` / 圆角 11–18px 分级 |

更根本的是**方向**：用户要的是"在它身上加东西"，我却另起了一页 —— 于是必然出现
两个入口、两套视觉，还得靠自己从零追赶它的设计密度。这不是"没打磨"，是**出发点错了**。

（顺带记录一个事实：`Theme.listTokens` 只返回 14 个"需要明暗双份覆盖"的令牌，
上游用的 `--dsw-alias-bg-layer-3` / `--dsw-alias-label-tertiary` / `--dsw-alias-state-business-primary`
**不在那个清单里** —— 所以"照令牌抄"这条路连素材都拿不全。）

### 二、新方案：补丁式增量（`patches/dsh-our-free-model/`）

**为什么只能这么走**：上游设置页整页自绘（六个 `<Section>` 写死在 `SettingsPage` 里），
官方 slot 只允许注册**自己的** section，**没有往别人 section 插内容的通道**。
所以要么改它的文件，要么放弃"一个页面"。**不改它的源仓库**（人家的项目），只改**本机安装副本**。

五处锚点（全部唯一命中才动手，见 `patches/dsh-our-free-model/patch.mjs` 的 `EDITS`）：

| id | 改动 |
|---|---|
| `nav-label` | 左栏名字 `t('nav')` → 「免费模型」 |
| `drop-news-section` | 删掉「公告中心」分区那一行 |
| `drop-onboarding` | 删掉首启那个 5 页公告弹窗（`settings.onboarding` 整块注册） |
| `inject-panel-component` | 注入 `PlatformScanPanel`（源码在 `patches/dsh-our-free-model/inject/platform-panel.js`） |
| `inject-platform-section` | 在模型清单之后挂上「本机自配平台」分区 |

**不动它的内部逻辑 / i18n 字典 / 不留新文件**（纯文本改写 → `revert` 可整文件还原）。

### 三、补丁基础设施

| 件 | 作用 |
|---|---|
| `patch.mjs` | 四模式 CLI：`status` / `apply --yes` / `verify` / `revert --yes`；核心逻辑导出（`EDITS` / `plan` / `applyTo`）供自证脚本复用 |
| `inject/platform-panel.js` | 注入组件本体（独立文件 → 可 `node --check`，已进闸门）；用上游的 `ofm_*` 类，数据走同源 `/freemodel-api/*` |
| `self-test.mjs` | **离线自证**：三种输入状态各有明确处置 —— 全 applied → 直接断言；全 pending → **在临时副本上试打一遍**（验"升级后能重打"）；**drift → exit 1**。上游不在本机时显式打印跳过（与 `check-message-sources` 对 `~/.dsh` 缺席的处置同构） |

**回退只有一条正路**：`.ofm-patchbak` 整文件还原。我第一版写过"无备份时就地逆向"的兜底，
实测**还原不逐字节**（`replace` 类要换回原串、`insert` 类只能删新增部分而不能删锚点）——
**给出半对的回退比显式失败更糟**，已删除该路径，改为失败 + 两条正路（重装 / 手工撤接入点）。

### 四、本线这一侧的调整：条件注册

`lib/client.js` 的 `settings.section` 改为**条件注册**：探测上游的只读路由
`/api/our-free-model/meta`，**在场就不注册自己的 section**（一个来源只留一个入口）；
它不在场时才用自己的页面兜底，名字同样是「免费模型」。模型页的
`settings.models.provider-card` 就地入口与"几个设置页"无关，保留。

### 五、测试与闸门

- `client-bundle.test.js` **8 → 9 例**：拆成「上游不在场 → 注册兜底页」与
  「**上游在场 → 让位，不注册第二个设置页**」两条（条件注册走 fetch 的 then/catch，
  测试改为 `async` + 等一拍微任务）。
- `verify-all.mjs` 的 `planFreeModel()`：**11 → 15 项**（+3 语法：`patch.mjs` / `self-test.mjs` /
  `inject/platform-panel.js`；+1 运行 `self-test.mjs`）。
- 本线六份测试合计 **62 例**。

**验证** `[实测]`

```
副本自证（OFM_CLIENT 指向临时副本，不动真文件）：
  status 改前 → 5/5 pending；apply --yes → 5 处写入；node --check 通过
  精确断言 → 左栏名已改 / 组件在场 / 新分区在场 / 「公告中心」那一行消失 / 首启公告注册消失 / i18n 字典未动
  revert --yes → 与原文件**逐字节一致**（SHA-256 相同）；无备份时 revert → exit 1 + 指引
真文件已打补丁（本机 ~/.dsh/local-plugins/dsh-our-free-model/client.js，备份 .ofm-patchbak）

node self-test.mjs（真文件已带补丁）      → PASS 8/8 断言
node self-test.mjs（喂原版副本，模拟被冲掉）→ PASS，且在临时副本上成功试打 5 处
node scripts/verify-all.mjs                → 161 项全 PASS（free-model 15/15）
本线六份测试                                → 62 例（9/7/6/15/10/15）
```

**实机待验（用户侧）**：重启 miasaki 桌面端后 —— ① 设置左栏只剩一栏「**免费模型**」；
② 进去**没有「公告中心」**分区，也不再弹首启公告；③ 模型清单下面出现「**本机自配平台**」
（选平台 → 检测 → 卡片 → 写入配置 / 设为子代理）；④ 顺手验一下：把本线插件停掉时，
那一栏会退化成一行"「免费模型」插件不在场"，其余分区照常。

---

## 2026-09-28（续四）· DSH 0.2.0-rc.1 升级复验：契约全绿，但真机抓到一个缺陷

用户升到 **0.2.0-rc.1** 后逐项复验。结论分两半：**契约面零适配，行为面抓到一个真缺陷**
（而且是 M3 引入的）。

### 一、契约复验（当前 Host 实测，`registrant` 缩写从 `cf` 变 `pf` 可证内核确实换了）

| 依赖 | 0.2.0-rc.1 | 用在哪 |
|---|---|---|
| `settings` 服务：无 `get`、有 `describe()` / `update()` | ✅ 未变 | `settings-read.js` 的双轨探针（`typeof get === 'function'` → 走 `describe()`）仍正确 |
| `settings.section`（list/root，`{id, order, label}`，owner `{close}`） | ✅ 逐字节未变 | M2 的统一页 |
| `settings.models.provider-card`（keyed，key 必填，keyDomain 开放） | ✅ 仍在 | M2 的就地入口 |
| `llm`：`listProviders` / `listModels` / `resolveModelInfo` / `listConfigurableProviders` / `registerModelDiscovery` | ✅ 五个方法全在，签名逐字一致 | M1 的来源 A |
| `agentDefaultModel`：`currentSelection` / `saveSelection` | ✅ 未变 | M3 的默认模型 |
| `connection.requestRejection` → `401｜403｜undefined` | ✅ 未变 | M0 的围栏第一层 |

**顺带发现（未采纳，记下来）**：0.2.0-rc.1 的 `dsh-llm` 有一个 `llm/providers` 事件
——"provider 拓扑变化（适配器注册/注销、可配置目录增减）时触发，消费者应重读
`listProviders()` / `listModels()` / `listConfigurableProviders()`"。它是"来源变化时自动
失效扫描缓存"的现成钩子，比现在的手动 `refresh` 更准；留作后续（本线现在按需刷新，够用）。

### 二、真机抓到的缺陷：webServer 的 exact 路由**按 path 去重**

```
dsh: warning: 1 entry did not activate
free-model (@miasaki/dsh-free-model): Error: webserver: duplicate exact route "/freemodel-api/default-model"
    at registerRoute (lib/index.js:185)
    at new apply (lib/index.js:464)
```

M3 给 `default-model` 分了 GET 与 POST **两条** exact 路由 —— webServer 的表按 path 去重，
第二条 `register` 直接抛错；而这是 **apply 期抛错**，后果是**整个插件不激活**
（启动日志只留一行 `1 entry did not activate`，面板、路由全没）。

**为什么单测没抓到**：离线 mock 的 `webServer.register` 只往数组/Map 里塞，没有去重语义；
`default-model.test.js` 甚至因为"后注册的覆盖前者"而**通过了一条错误的 handler**（当时
只当成测试适配问题，见 M3 条目 §四）。**这条约束只有真机能暴露。**

**修复**：`registerRoute` 改为接受方法数组，一个路径的多个方法在**同一条**路由内分派
（`allowed.includes(req.method)`）；`route.methods` 一并挂在 handler 上供离线测试取用。

**加闸门（把真机约束前移）**：`test/routes.test.js` 新增一条 —— 驱动 `apply()` 收集
注册项，断言 **path 唯一**，重复即失败：

> `route table: 每个路径只注册一条 exact 路由（webServer 按 path 去重）`

### 三、修复后真机复验（web profile，临时 host，端口 3221）

```
启动输出：只有一行 URL，**没有 warning**（修复前是 `1 entry did not activate`）
/freemodel-api/status        → 401（无 cookie，围栏生效）→ 带 cookie 200 + 平台清单
/freemodel-api/default-model → 200 {"supported":true,"selection":{"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"max"}}
/freemodel-api/scan          → 200 {"adapterAvailable":true,"sources":[…]}
    openrouter：24 模型 / **21 免费**（L1 后缀判定在真实数据上命中）
    opencode  ：19 模型 / **6 免费**
    wxxcx / step / openai / xiaomi：来源 A 枚举正常
Host: evil.example           → 403（非回环 Host 被拒）
/model-probe-api/health      → 200（对照：它的围栏是结构层，只读探测不要求 cookie）
/api/health                  → 401（对照：内核自己也这样）
```

**这三条 200 分别证明**：settings 的 `describe()` 双轨读通、官方 `agentDefaultModel`
可达且返回真实选择、`llm` 契约枚举与免费判定在真实 provider 上跑通 —— 即
**M0–M3 的功能在 0.2.0-rc.1 上真的能用**，不只是"契约还在"。

### 四、测试与闸门

`test/routes.test.js` **5 → 6 例**（新增路径唯一闸门）；本线六份测试合计 **61 例**。
`verify-all free-model` 仍 **11 项**（测试文件数未变）。

**验证** `[实测]`：六份测试 8/8 · 7/7 · **6/6** · 15/15 · 10/10 · 15/15；
`verify-all free-model` 11/11；web profile 临时 host 三路由全通（见上）。

---

## 2026-09-28（续三）· M3：实测接 model-probe + 默认模型走官方写路径

M1 把数据接齐、M2 把界面摆好，M3 补上"**能用**"的三件事：能实测一个模型到底通不通、
能把选中的模型设为默认、以及把"子代理指派"这条唯一还靠文件改写的路径核实清楚。

### 一、「实测」——接 `dsh-model-probe` 的两段式探测

模型卡右侧新增「实测」按钮，调 `POST /model-probe-api/probe {provider, model}`：
零 token 握手判鉴权 → 1 token 生成确认，结果按 kind 就地显示（可用/不可用 + 耗时）。

- **探活门控**：进页面先 `fetch('/model-probe-api/health')`，只有 `res.ok` 才渲染按钮 ——
  那是个**可选的独立插件**，缺席时不该给用户一个点了报 404 的按钮（用裸 `fetch` 而不是
  本线的 `api()`，因为后者要求信封 `ok`，而 404 回的不是那个形状）。
- 两个来源共用：适配器来源（路由已注册）与自配平台（凭据与 baseURL 由 model-probe
  自己经 settings 双轨读）都能实测。

### 二、「设为默认」——官方写路径 `agentDefaultModel`

新增 `GET|POST /freemodel-api/default-model`：

| 方法 | 行为 |
|---|---|
| GET | `agentDefaultModel.currentSelection()` → `{supported, selection}`；服务缺席 `supported:false`；**读失败按"读不到"处理**（默认模型不是本面板的核心功能，不该因此整块报错） |
| POST | `agentDefaultModel.saveSelection({ provider, model })` → `{provider, model}`；只传这两个字段，不替官方补别的；服务缺席给**语义化错误**而不是 500；参数不合法在碰服务之前就被拒 |

client 侧模型卡加「设为默认」按钮，成功后就地提示"官方写路径，下一次会话生效"。
**这与 `/subagent` 有本质区别**：那条是文件级改写、要等新会话且依赖预设文件格式；
这条是官方写路径，立即生效。

### 三、核实结论：「子代理指派」官方**没有**写路径（故保留文件改写）

M3 的任务之一是核实它。结论：`subagentModelSelection` 服务**只有 `current()`**（只读，
"Singleton settings owner read when delegation tools are composed for a Session"），
没有对应的 set。因此 `/subagent` 那条**保留现状**（改写三个预设的 `agentOptions`），
并把这条核实结果写进本节与 README —— 它是"为什么这里还在改文件"的答案，
也标出了将来值得重看的位置（预设一旦组合包化，这条要重做）。

### 四、一处为测试而做的小改动

`registerRoute` 现在把 `method` 挂在生成的 handler 上（`route.method = method`）。
原因：`default-model` 在**同一路径**上按 GET/POST 注册两条，离线测试的路由表若只按 path
建索引，后者会覆盖前者 —— 第一版新测试正是这样"通过"了错误的 handler。
挂一个字段比让测试猜注册顺序可靠；生产路径行为零变化。

### 五、测试与闸门

- `test/default-model.test.js`（**7 例，新增**）：读三态（在场 / 缺席 / 抛错）与写四态
  （成功 / 服务缺席 / 参数不合法不碰服务 / 官方抛错原因透传）。
- `test/client-bundle.test.js` **7 → 8 例**：新增「M3 接线」——bundle 必须引用
  `/model-probe-api/health`、`/model-probe-api/probe`、`/freemodel-api/default-model`，
  且**实测按钮必须受探活结果门控**（正则钉住 `probeAvailable ? createElement("button")`）。
- 本线六份测试合计 **60 例**；`verify-all free-model` **10 → 11 项**。

**验证** `[实测]`

```
node test/trust.test.js          → 15/15
node test/scan.test.js           → 15/15
node test/client-bundle.test.js  →  8/8
node test/default-model.test.js  →  7/7
node test/routes.test.js         →  5/5
node test/settings-read.test.js  → 10/10
node scripts/verify-all.mjs free-model → PASS 11/11
```

**实机待验（用户侧）**：① 模型卡上的「实测」按钮点了给"可用（…）+ 耗时"（且未装
model-probe 时按钮不出现）；②「设为默认」后，新建会话的选择器默认模型就是它。

---

## 2026-09-28（续二）· M2：统一页三区 + 模型页就地入口（footer 双路退役）

M1 让**数据**多来源了，M2 让**界面**跟上：一页看全两个来源，并且把"扫这个提供方"
放到用户本来就在看模型的地方。

### 一、主页面：`settings.models.footer` → `settings.section`

M0 沿用迁出前的双路注册（优先模型页底部 footer、5 s 后回退自有 section）。M2 **删掉这条
双路逻辑**，只保留 `settings.section`（id `free-model`、order 25、label「免费模型」）：

- 三区面板（免 Key 车道 / 本机自配平台 / 决策摘要 + 来源清单）是**完整一页**，
  塞在别人页面底部既挤又难找；
- "在模型页就手"的需求由 provider-card 就地入口更好地满足（就在对应那张卡片下面，
  而不是页面最底部）；
- **少一条回退路径 = 少一个失败模式**：不再需要"5 s 延迟判定 + inject watcher 兜底"
  那套规避装载顺序竞态的机制，也不再需要"失败只记一次"的日志纪律来兜底。

三区内容：

| 区 | 内容 |
|---|---|
| ① 免 Key 车道 | 来源 A 的模型卡（id / 提供方 / verdict / strengths·warnings 标签 / ctx / max），右下角标注「免 Key 车道」不可写入 |
| ② 本机自配平台 | 平台选择 + 检测 + 逐条/全部写入 + 子代理指派 + 当前已配置清单（原面板能力全保留） |
| ③ 决策摘要 | 优先用当前平台的检测结果，无检测结果时用多来源扫描的汇总 |
| 附：来源清单 | 扫到哪些来源、各自模型数/免费数、以及**逐来源的失败原因**（隔离失败的可视化） |

### 二、新增：官方 keyed 槽 `settings.models.provider-card` 的就地入口

官方模型页渲染**每张 provider 卡片**时 dispatch `settings.models.provider-card`，
**key = 该卡片的 `settingsNs`**，owner props 为
`{ provider: { provider, displayName, settingsNs, settingsPath, active }, configured, keyConfigured }`
（实装取证：`dsh-client-ui-settings-models/lib/client.js:2393-2397`、目录行构造 `:1141-1161`）。

于是「扫描该提供方的免费模型」可以**长在它自己的那张卡片底下** ——
**官方插槽、零改第三方、不触任何人的承诺**。Our Free Model 的卡片 key 就是它的
loader entry id。

注册策略是**数据驱动**的，不硬编码任何插件 id：

1. 空串 key 兜底 —— 官方对"注册了适配器但不在目录里"的 provider 用 `settingsNs: ""` 派发
   （`:1153-1161`），这个 key 覆盖它们；
2. 启动后拉一次 `/scan`，为每个带 `settingsNs` 的来源再注册一个 key（如 `our-free-model`）。

拿不到路由 id 时组件返回 `null`：**宁可没有入口，也不在别人的卡片里抛错**。

### 三、样式改走官方主题令牌

M0 用的是内联色值（`#f66` / `#6c6` / `rgba(...)`）。M2 全部换成官方令牌
（清单取自 `client/Theme.listTokens` 实测的 14 个）：`--dsw-alias-label-primary` /
`-secondary`、`--dsw-alias-border-l1` / `-l2`、`--dsw-alias-bg-layer-1` / `-2`、
`--dsw-alias-state-{success,warn,error}-primary`。**不写死色值**是硬约束 —— 否则换主题 /
切明暗时，这一块会是页面上唯一不跟着变的地方。测试里有一条闸门直接扫源码里的十六进制色值。

### 四、测试

`test/client-bundle.test.js` **4 → 7 例**：新增「apply 注册到 settings.section（id/order/label）」、
「provider-card 注册空串兜底 key」、「M2 起不再注册 footer」、「样式全走官方令牌且无写死色值」；
原「旧命名零残留」保留。本线五份测试合计 **52 例**。

**验证** `[实测]`

```
node test/trust.test.js          → 15/15
node test/scan.test.js           → 15/15
node test/client-bundle.test.js  →  7/7
node test/routes.test.js         →  5/5
node test/settings-read.test.js  → 10/10
node scripts/verify-all.mjs free-model → PASS 10/10
```

**实机待验（用户侧）**：重启 miasaki 桌面端后 —— ① 设置左栏出现「免费模型」一栏，
三区内容正确；② 「设置 → 模型」页里 Our Free Model 那张卡片下面出现
「扫描该提供方的免费模型」；③ 切一次深色/浅色主题，面板配色跟着变（令牌生效的判据）。

---

## 2026-09-28（续）· M1：扫描面升级到官方 `llm` 契约 —— 多来源聚合真正成立

**这一条是本线存在的理由落地**：迁线与围栏只是把插件搬正、把口子堵上；M1 才让它从
"扫自配平台"变成"**多来源免费模型聚合器**"——免 Key 车道（如 `dsh-our-free-model`
注册的 provider 路由）与自配平台进同一个池子、同一张模型卡、同一套 verdict。

### 一、来源 A：经官方 `llm` 服务枚举（`lib/scan.js`，新增）

```
llm.listProviders()  →  逐 provider  llm.listModels(id)  →  逐 model  llm.resolveModelInfo(id, model)
```

**为什么走官方契约而不是读对方插件的私有路由**：一个 DSH 插件只要注册了适配器，
它的 provider 路由就出现在 `listProviders()` 里，模型与元数据经 `listModels()` /
`resolveModelInfo()` 可得。于是免 Key 车道与自配平台**在同一个抽象下同构** ——
本线不需要它的任何私有接口、不读它的存储、也不改变它的任何对外承诺。
**对方零改动、零配合**（实测其 `listModels` 本来就返回 `{id,name,contextWindow,inputModalities}`）。

三条纪律，每条都有明确失败形态：

| 纪律 | 不这么做会怎样 |
|---|---|
| **逐 provider 隔离**：一个平台挂只进 `partial[]` | 一个配错的平台把整个免费模型视图打成错误页 |
| **逐调用超时 + 失败回落**：`resolveModelInfo` 挂了条目仍产出（元数据留空） | 一次元数据查询失败让整轮扫描消失 |
| **缓存 + 手动刷新**：解析结果缓存在请求间复用，`refresh: true` 才清 | 一轮扫描打 N 次 `resolveModelInfo`，每次都慢 |

### 二、免费判定加 **L0**（provider 级免 Key 车道）

```
L0  provider 的 id 或显示名命中 /free/i  ⇒ 整路由免费（"疑似免 Key 车道"）
L1  模型 id 以 :free（OpenRouter 方言）或 -free（免 Key 清单方言）结尾
```

**刻意不硬编码任何插件名** —— 任何免 Key 车道都适用，第三方改名也不会让规则失效。
L0 判出的模型带 `writable: false`：免 Key 车道靠上游指纹计免费额度，
用普通 provider 接入拿不到，**不该被写进 `llm-pi-ai.providers`**。

### 三、画像收成一份实现（`lib/profile.js`，新增）

M1 之前 verdict 逻辑长在 `analyzeModel` 里；两个来源共用它必然漂移，用户会在
免 Key 车道与自配平台看到互相矛盾的结论。现抽出 `buildProfile(input)`，两个来源
只负责把各自方言翻译成入参：

- **端点来源**（`analyzeModel`，已瘦身为薄封装）：OpenRouter 方言的
  `supported_parameters` / `architecture` / `top_provider`；
- **适配器来源**（`adapterProfile`）：官方真值 `inputModalities` / `reasoning.efforts` /
  `context.contextWindow` / `defaultMaxTokens`。

**能力只到能被证明的程度**：适配器自述**不提供** `supported_parameters`，所以工具能力
在来源 A 上是**未知**而不是"不支持" —— 新增 `toolsUnknown` 标记，`canAgent` 保持 false
但 verdict 明写「需实测验证：该来源不声明工具参数，能否做子代理未知」、warnings 写
「工具参数未声明：子代理可用性需实测」。**不猜一个 false 了事**。

### 四、新路由与形状对齐

| 路由 | 变化 |
|---|---|
| `POST /freemodel-api/scan` | **新增**。body `{ provider?, refresh? }` → `{ adapterAvailable, sources[], models[], summary, partial[] }`。`sources` 三类：`adapter`（已注册路由）/ `pi-ai`（带 baseURL 的平台，抓取仍走 `/detect`）/ `draft`（已声明未注册，UI 引导用）。按 `provider` 过滤时**只扫那一个**（不让未被请求的 provider 失败污染 `partial`） |
| `GET /freemodel-api/status` | 每个平台新增 `kind` / `providerRoute` / `freeLane` / `writable` |
| `POST /freemodel-api/detect` | 条目新增 `provider` / `providerName` / `source` / `writable` / `freeReason`；排序与决策摘要抽成共用的 `sortModels()` / `summarize()`（两个来源同口径） |

### 五、测试与闸门

- `test/scan.test.js`（**15 例，新增**）：L0/L1 分层与优先级、L0 整路由免费、
  非免 Key 车道只看后缀、`llm` 缺席降级、单 provider 隔离、`resolveModelInfo` 失败回落、
  缓存与 refresh、官方真值进画像 + 工具能力标未声明、`buildProfile` 三分支、
  `/scan` 端到端四项（汇总两来源、同一路由键不重复列、按 provider 过滤与 partial、
  `llm` 缺席仍出平台清单）。
- `verify-all.mjs` 的 `planFreeModel()`：语法 3 → **5** 项（加 `profile.js` / `scan.js`）、
  测试文件 4 → **5** 个，类别 **7 → 10 项**。

**验证** `[实测]`

```
node test/scan.test.js            → 15/15 pass
node test/routes.test.js          →  5/5  pass（重构后行为不变）
node scripts/verify-all.mjs free-model → PASS 10/10
node scripts/verify-all.mjs repo  → PASS 3/3
```

**实机待验（用户侧）**：重启 miasaki 桌面端后调用 `POST /freemodel-api/scan`，
`models[]` 里应出现 `our-free-model` 的 11 个模型（`source: "adapter"`、`writable: false`、
`freeReason` 含「免 Key 车道」），并带各自的上下文窗口与视觉/推理标记 —— 这正是
"多来源"从设计变成事实的那一步。

**已知未做（M2–M4）**：统一页三区（`settings.section` id `free-model`）+
官方 keyed 槽 `settings.models.provider-card` 的就地扫描入口；实测按钮接 `dsh-model-probe`；
默认模型走官方 `agentDefaultModel`；子代理指派核实官方写路径。

---

## 2026-09-28 · 迁出独立成第九线 + 更名扩容 + 路由信任围栏（0.3.1 → 0.4.0）

**动因**：三件事撞在同一个判断上。

1. **职责不属于桌面端线** —— 本插件做的事（免费模型发现 / 能力画像 / 显式写入模型配置）
   与桌面壳无关。本仓已有同构先例：用量统计 2026-09-26 从 desktop 线迁出、独立成第八线。
2. **名字装不下新定位** —— 它的目标从"扫本机自配平台"扩到"**多来源**免费模型聚合"：
   还要收编免 Key 车道（如 `dsh-our-free-model` 注册的 provider 路由）。"池"（pool）说的是前者，
   "聚合器"才是后者。
3. **一条真实的安全债** —— 4 条 `/freepool-api/*` 路由是 `kind: 'exact'` 注册，
   不经过内核 `/api` 的准入链（exact 分发优先于前缀）；其中 `/apply` 是**写配置**的动作、
   `/subagent` 改预设文件。任何能解析到本机回环地址的页面都能直接调用它们。
   （对照：`dsh-model-probe`、`dsh-our-free-model` 都有围栏，本插件此前没有。）

**迁移（照 usage 线先例）**

- `git mv dsh-miasaki-desktop/plugins/dsh-free-model-pool/ dsh-miasaki-free-model/`
  —— **9 个文件全部被 git 识别为重命名**（`R`），历史不断。
- desktop 线插件数 5 → 4；`dsh-miasaki-desktop/README.md` 原章节改为「已迁出」指路页
  （防该线历史 CHANGELOG 的既有引用断链）。
- 建线产物：本 `README.md` + 本 `design/CHANGELOG.md`。

**更名**（一次性做干净，避免以后二次动刀）

| 项 | 旧 | 新 |
|---|---|---|
| 包名 | `dsh-free-model-pool` | `@miasaki/dsh-free-model` |
| 版本 | `0.3.1` | `0.4.0` |
| 路由前缀 | `/freepool-api/*` | `/freemodel-api/*` |
| 槽 id / label | `free-model-pool` / 「免费模型池」 | `free-model` / 「免费模型」 |
| 幂等守卫 | `window.__DSH_FREEPOOL_BOOTED__` | `window.__DSH_FREEMODEL_BOOTED__` |
| 日志前缀 | `dsh-free-model-pool:` | `dsh-free-model:` |
| DOM id | `freepool-*-select` | `freemodel-*-select` |

**新增：路由信任围栏（`lib/trust.js`）**

两层，按序：① composition 的 `connection` 服务在场时用它的 `requestRejection`
（与内核 `/api` 同级：信任围栏 + 浏览器鉴权 cookie）；**逐请求读取**，不做 apply 时快照
（该服务可能比本插件晚 provide）。② 缺席时用结构化复刻：回环 Host、拒跨站 `sec-fetch-site`、
`Origin`/`Referer` 与 Host 同名，**Host 缺失/为空一律拒**（fail closed）。

接入点在 `lib/index.js` 的 `registerRoute`：**围栏先于 method 检查、也先于业务** ——
`registerRoute` 顺带从 `(path, handler)` 改为 `(method, path, handler)`，未过围栏的请求
连"路径存不存在"都不问出来。

**测试（本线闸门 7 项）**

- `test/trust.test.js`（**15 例，新增**）：结构层五条边界（回环放行 / 非回环 403 /
  Host 缺失与空白 403 / 跨站 403 / 异源与 `Origin: null` 403 / 同源 Origin·Referer 放行）；
  connection 层（401、403、放行即放行、抛错回落结构层、**逐请求读取**——晚 provide 即接管）；
  路由级（非回环 Host 进不了业务 handler、
  **围栏先于 method 检查 —— 跨站 POST 得 403 而不是 405**、method 不符 405、正确调用 200）。
- `test/client-bundle.test.js`（**4 例，新增**）：把 `lib/client.js` 当脚本在 `node:vm` 里**真实执行一次**
  —— 迁线改动了 12 处字符串（模块 id / 路由前缀 / 槽 id / DOM id / 幂等守卫名 / 日志前缀），
  而 `node --check` 只验语法，语法绿 ≠ 面板挂得上。断言：ModuleLoader 模块 id = 包名、
  导出 `apply`/`inject(['slots'])`、`apply()` 在最小槽 stub 下注册到 `settings.models.footer`
  （id `free-model`、order 10）且幂等守卫落在新名字上、旧命名（`freepool` / `dsh-free-model-pool`
  / 「免费模型池」）零残留。
- `test/routes.test.js`（5 例，**适配**）：boot 补 `get: () => undefined`（围栏逐请求读 `connection`）
  与回环 `host` 请求头；断言不变。
- `test/settings-read.test.js`（10 例，未改）：settings 读取双轨 helper 契约。

**仓库级同步**

- `scripts/verify-all.mjs`：`LINES` 加 `free-model`；原 desktop 类里的 4 个检查项（2 syntax + 2 test）
  迁入新的 `planFreeModel()`，连同新增的 trust 与 client-bundle 两项共 **7 项**（同日晚 M1 起为 **10 项**，见上一条）；注释「八线 → 九线」。
- `scripts/check-doc-versions.mjs`：`LINES` 加 `['免费模型', 'dsh-miasaki-free-model']`。
- `scripts/silent-guard-baseline.json`：那条 `dsh-miasaki-desktop/plugins/dsh-free-model-pool/…`
  的冻结项路径同步为 `dsh-miasaki-free-model/lib/index.js`（行号 350 → 367）。
- 根 `README.md`：八条线 → **九条线**，线表新增本线、desktop 行改为"四个 profile 插件"，
  `version-ledger` 台账 9 条（`--update` 生成）。
- `.github/workflows/verify-all.yml`、`scripts/check-message-sources.mjs`、`scripts/check-silent-guards.mjs`
  的「八线」文案 → 「九线」。

**验证** `[实测]`

```
node test/trust.test.js           → 15/15 pass
node test/client-bundle.test.js   →  4/4  pass
node test/routes.test.js          →  5/5  pass
node test/settings-read.test.js   → 10/10 pass
node scripts/verify-all.mjs free-model → PASS 7/7
node scripts/verify-all.mjs repo  → PASS 3/3（silent-guards / doc-versions / message-sources）
```

**profile 侧落地（同批完成）** `[实测]`：`miasaki` 与 `web` 两个 profile 的 `dependencies` 键
（`dsh-free-model-pool` → `@miasaki/dsh-free-model`）与 `file:` 路径、`dsh.profile.bundles` 项同批更新，
装法改 `link:`，两处 `pnpm install` 后 `node_modules` 里已是 **junction → 新线目录**
（旧包目录已消失）；离线解析验证：`import('@miasaki/dsh-free-model')` 得到
`name=free-model`、`inject=["settings","webServer"]`、`apply` 为函数。

**已知未做（M1–M4，见跨线规划）**：① 扫描面升级到官方 `llm` 契约（枚举全部 provider，
含免 Key 车道）；② 统一页三区 + `settings.models.provider-card` 就地扫描入口；
③ 实测按钮接 `dsh-model-probe`、默认模型走官方 `agentDefaultModel`、子代理指派核实官方写路径；
④ 回归矩阵的实机判据。

**实机验收指引（用户侧）**：重启 `miasaki` 桌面端（或 `dsh web`）后，在
「设置 → 模型」页底部应看到「免费模型」面板；控制台无回退日志即说明挂的是
`settings.models.footer`（回退态会打印 `dsh-free-model: models footer slot unavailable`）。
围栏可用命令行粗验：`curl -i "http://127.0.0.1:<port>/freemodel-api/status"` 应得 401/403
（无 cookie / 非回环 Host），带浏览器 cookie 的同源请求才 200。
