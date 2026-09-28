# dsh-miasaki-free-model — 多来源免费模型聚合器（DSH web 插件 `@miasaki/dsh-free-model`）

> **第九线**：2026-09-28 由 `dsh-miasaki-desktop/plugins/dsh-free-model-pool/` 迁出、独立成线，
> 迁出同批**更名**（`dsh-free-model-pool` → `@miasaki/dsh-free-model`，路由前缀
> `/freepool-api/*` → `/freemodel-api/*`，槽 id `free-model-pool` → `free-model`）与**补上路由信任围栏**。
> 迁移理由、命名决策与后续路线（M1–M4）见 [`design/CHANGELOG.md`](design/CHANGELOG.md) 与
> [跨线设计规划](../dsh-miasaki-shared-docs/cross/free-model-unified-page-2026-09-28.md)。
>
> **为什么值得单独成线**：本插件做的事（免费模型发现 / 能力画像 / 显式写入配置）与桌面壳无关 ——
> 与用量统计 2026-09-26 从 desktop 线迁出的处境同构。迁出后本线只装一个包，有自己的 README、
> `design/`、测试闸门（`verify-all.mjs` 的 `free-model` 类别 **15 项**）、以及一份
> **上游插件增量补丁**（[`patches/dsh-our-free-model/`](patches/dsh-our-free-model/) —— 把本线的扫描
> 能力接进它的设置页，让设置里只剩一栏「免费模型」）。

## 定位：把本机的免费模型收在一处

「免费模型」在这台机器上有两个来源，本线的目标是把它们放进**同一张模型卡**、用同一套画像口径：

| 来源 | 是什么 | 取数方式 | 状态 |
|---|---|---|---|
| **① 免 Key 车道** | 例如 `dsh-our-free-model` 注册的 provider 路由（Zen 网关：装完即用、不需要任何 Key） | **官方 `llm` 契约** —— `listProviders()` → `listModels(p)` → `resolveModelInfo(p, m)` | **已实现（M1）** |
| **② 本机自配平台** | `llm-pi-ai.providers` 中带 `baseURL` 的任意 OpenAI 兼容平台（OpenRouter、自建网关…） | 直连该平台 `GET {baseURL}/models` | **已实现** |

来源 ① 走官方契约的意味：**只读、零改动、零配合** —— 第三方插件只需作为 DSH provider 存在，
本线不需要它的任何私有路由、不读它的存储、也不改变它的任何对外承诺。
两个来源的差异只在可用动作：① 是免 Key 车道**不可写入** `llm-pi-ai`（Zen 网关靠
`x-opencode-*` 指纹计免费额度，普通 provider 接入拿不到）；② 可写入、可指派。

## 已实现 · M0：迁线 + 信任围栏

### 扫描自配平台（来源 ②）

- **平台集是活的**：`llm-pi-ai.providers` 里每个带 `baseURL` 的路由都是一个扫描目标；
  新增平台只需在「设置 → 模型」页配置，面板自动出现，**零插件改动**。
- **分层免费规则**（任一命中即收录，且**标注命中依据**）：
  `id` 以 `:free`（OpenRouter 方言）或 `-free`（免 Key 清单方言）结尾 → `pricing` 字段全零 →
  名称匹配 `/免费|free/i`。规则刻意"便宜且不误伤"：前两条精确，第三条只在显式中英文标记上触发。
- **能力画像**（判定逻辑在 `lib/profile.js`，两个来源共用）：从端点自述
  （`supported_parameters` / `architecture.modality` / `reasoning` / 上下文 / 输出上限）判定
  工具调用、`tool_choice`、推理、编码、视觉、结构化输出、长上下文，产出**子代理可用性**
  （门槛 = `tools` + `tool_choice`）与三档 verdict + 警告。
  **能力只到探测能证明的程度**：端点什么都没声明的模型标 `元数据缺失：能力未验证`，不猜。
- **决策摘要**：最佳子代理 / 编码类 / 超长上下文 / 多模态，可一键指派。
- **显式写路径**：`apply` 把检测结果深合并写进目标 provider 的 `models`
  （`settings.update('llm-pi-ai', …)`，保留其它 provider 与字段）；`subagent` 重写三个预设
  （`kurumi` / `whale` / `inverse`）中 `tool-subagent` / `tool-subagent-fork` 的 `agentOptions`。

### 路由信任围栏（M0 新增）

本插件的路由是 `kind: 'exact'` 注册，**不经过**内核 `/api` 的准入链（exact 分发优先于前缀）。
此前 4 条路由裸奔，而 `/apply` 是**写配置**的动作 —— 任何能解析到回环地址的页面都能直接调用。
`lib/trust.js` 关掉这个口子，两层按序：

1. composition 挂了 `connection` 服务时，用它的 `requestRejection`（与内核 `/api` 完全同级：
   信任围栏 + 浏览器鉴权 cookie）。**逐请求读取**，不做 apply 时快照 —— 该服务可能比本插件晚
   provide，快照会让围栏整轮退化成第 2 层。
2. 没有该服务时用结构化复刻：只允许回环 Host、拒绝 `sec-fetch-site: cross-site`、
   `Origin`/`Referer` 存在时必须与本机 Host 同名；**Host 缺失或为空一律拒绝**（fail closed）。

顺序是契约的一部分：**围栏先于 method 检查、也先于业务** —— 未通过的请求连"这个路径存不存在"
都不该问出来（`test/trust.test.js` 有一条专门的 403-而非-405 断言钉住它）。

## 已实现 · M1：多来源（来源 ① 走官方 `llm` 契约）

```
llm.listProviders()  →  逐 provider  llm.listModels(id)  →  逐 model  llm.resolveModelInfo(id, model)
```

- **免 Key 车道与自配平台同构**：一个 DSH 插件只要注册了适配器，它的 provider 路由就出现在
  `listProviders()` 里 —— 本线不需要它的任何私有接口、不读它的存储、也不改变它的对外承诺。
  对方**零改动、零配合**（其实测 `listModels` 本来就返回 `{id,name,contextWindow,inputModalities}`）。
- **三条纪律**：逐 provider 隔离（一个平台挂了只进 `partial[]`）／逐调用超时 + 失败回落
  （`resolveModelInfo` 挂了条目仍产出、元数据留空）／解析结果缓存 + `refresh: true` 才重扫。
- **免费判定加 L0**：provider 的 id 或显示名命中 `/free/i` ⇒ 整路由免费（"疑似免 Key 车道"）。
  **刻意不硬编码任何插件名** —— 任何免 Key 车道都适用，第三方改名也不失效。
  L0 判出的模型带 `writable: false`：免 Key 车道靠上游指纹计额度，普通 provider 接入拿不到。
- **画像收成一份实现**（`lib/profile.js`）：端点方言与适配器方言各自翻译成 `buildProfile()` 的入参，
  两个来源不会给出互相矛盾的 verdict。
- **工具能力在来源 ① 上是"未知"而不是"不支持"**：适配器自述不提供 `supported_parameters`，
  于是 `toolsUnknown: true`、`canAgent` 保持 false，但 verdict 明写
  「需实测验证：该来源不声明工具参数」、warning 写「工具参数未声明：子代理可用性需实测」。
  **不猜一个 false 了事。**

## 动作（M3）

| 动作 | 走哪条路 | 说明 |
|---|---|---|
| **实测** | `POST /model-probe-api/probe`（`dsh-model-probe`） | 两段式真实探测（零 token 握手判鉴权 + 1 token 生成确认），结果就地显示 kind 与耗时。**探活门控**：进页面先问 `/model-probe-api/health`，那个插件缺席就整块隐藏按钮 —— 不给用户一个点了报 404 的按钮 |
| **设为默认** | `POST /freemodel-api/default-model` → 官方 `agentDefaultModel.saveSelection` | **官方写路径，下一次会话立即生效**；服务缺席给语义化错误而不是 500；参数不合法在碰服务之前就被拒 |
| **写入 provider** | `POST /freemodel-api/apply` → `settings.update('llm-pi-ai', …)` | 只对可写来源出现（免 Key 车道不可写入） |
| **子代理指派** | `POST /freemodel-api/subagent` → 改写三预设的 `agentOptions` | ⚠️ **文件级改写**。官方 `subagentModelSelection` 只有只读 `current()`、**没有写路径**（M3 核实结论），所以保留现状：它要等新会话，且依赖预设文件格式 —— 预设一旦"组合包化"，这条要重做 |

## HTTP 契约

所有路由都先过围栏；`ok` 为外层信封（"请求被处理了"），业务错误在 `error` 里。

| 路径 | 方法 | 入参 | 返回 |
|---|---|---|---|
| `/freemodel-api/scan` | POST | `{ provider?, refresh? }` | `{ adapterAvailable, sources[], models[], summary, partial[] }` —— 三类来源 `adapter` / `pi-ai` / `draft`；按 `provider` 过滤时只扫那一个 |
| `/freemodel-api/status` | GET | — | `{ platforms: [{ id, kind, providerRoute, displayName, apiKeyEnv, baseURL, endpoint, configuredCount, configured[], freeLane, writable }] }` |
| `/freemodel-api/detect` | POST | `{ platform }` | `{ platform, endpoint, models[], total, summary }`（条目带 `provider` / `source` / `writable` / `freeReason`） |
| `/freemodel-api/default-model` | GET | — | `{ supported, selection }` —— 官方 `agentDefaultModel.currentSelection()`；服务缺席 `supported: false`、读失败按"读不到"处理 |
| `/freemodel-api/default-model` | POST | `{ provider, model }` | `{ provider, model }` —— 官方写路径 `saveSelection`，下一次会话生效 |
| `/freemodel-api/apply` | POST | `{ platform, ids? }` | `{ written, platform, models[] }` |
| `/freemodel-api/subagent` | POST | `{ provider, model, maxTokens? }` | `{ updated[], provider, model, maxTokens }` |

## 界面：一个页面 —— **长在上游插件身上**（续五修订）

设置里那一栏「**免费模型**」就是上游插件 `dsh-our-free-model` 的设置页本身；本线用
[`patches/dsh-our-free-model/`](patches/dsh-our-free-model/) 在它里面做**增量**：
去掉公告（分区 + 首启弹窗）、左栏改名，并在模型清单后面挂上「**本机自配平台**」分区。

**为什么只能是补丁**：上游设置页整页自绘（六个 `<Section>` 写死在 `SettingsPage` 里），
官方 slot 只允许插件注册**自己的** section，**没有往别人 section 插内容的通道**。
要么改它的文件，要么放弃"一个页面"。而改**本机安装副本**（不改它的源仓库）+
"升级后重打"的补丁纪律，正是本仓 `patches/` 已经在用的做法。
**补丁一定会被它的应用内升级冲掉**（`updater.js` 会覆盖清单内文件），所以 `status` / `verify` /
`self-test` 三件都在：一眼可见当前处于哪种状态。

本线自己只出两样东西：

| 落点 | 是什么 | 什么时候出现 |
|---|---|---|
| `settings.section`（id `free-model`、order 25、label「免费模型」） | **兜底页**：三区（① 免 Key 车道 ② 本机自配平台 ③ 决策摘要 ＋ 来源清单） | **条件注册** —— 探测上游的只读路由 `/api/our-free-model/meta`，**在场就不注册**（保证只有一个入口）；它不在场时才顶上来 |
| ~~`settings.models.provider-card`~~ | **已撤销**：官方模型页的**编辑面板也会 dispatch 这个槽**（`dsh-client-ui-settings-models:2458-2463`，编辑面板与 occupant 同在一个 children 数组里），occupant 在渲染路径上出任何问题都会让**整棵 React 树卸载成白屏**。**模型页是官方的地盘，本线不碰** —— 闸门钉在 `client-bundle.test.js`：`settings.models.*` 前缀一律不许注册。（2026-09-28 那次白屏事故复盘后确认**真凶是另一个包上的运行时补丁**，与本线无关；撤销它走的是**风险**论证，不是事故归因） | — |

**就地入口的注册是数据驱动的，不硬编码任何插件 id**：先注册空串 key 兜底（官方对"注册了适配器但不在目录里"的 provider 用 `settingsNs: ""` 派发），启动后拉一次 `/scan`，再为每个带 `settingsNs` 的来源注册一个 key。拿不到路由 id 时组件返回 `null` —— **宁可没有入口，也不在别人的卡片里抛错**。

**上游页面里那个新分区**（`patches/.../inject/platform-panel.js`）用的是上游自己的
`ofm_*` 样式类（`ofm_panel` / `ofm_card` / `ofm_badge` / `ofm_tags` / `ofm_metrics` /
`ofm_field` / `ofm_input` / `ofm_callout`），所以它和上面的模型清单看起来是同一套设计的一部分；
兜底页则走官方主题令牌 `--dsw-alias-*`，测试里有一条闸门直接扫源码里的十六进制色值。

## 安装（miasaki / web profile）

`package.json` 只有 `peerDependencies`（零运行时依赖）。profile 侧三步：

1. `dependencies` 加 `"@miasaki/dsh-free-model": "link:<本目录绝对路径>"`；
2. `dsh.profile.bundles` 末尾追加 `"@miasaki/dsh-free-model"`；
3. profile 目录 `pnpm install`，启动/重启 host 后生效。

> 装法用 `link:` 而非 `file:`：`file:` 会在 profile 的 `node_modules` 里留一份**真实目录副本**，
> 改源码后必须重新 install 且 pnpm 的 file: store 会滞后（要核对哈希）；`link:` 无副本漂移。

## 测试

```bash
node test/trust.test.js          # 15 例：围栏两层语义 + 边界 + 「围栏先于 method」顺序
node test/scan.test.js           # 15 例：来源 A 三条纪律 + L0/L1 分层 + 缓存 + /scan 端到端
node test/settings-read.test.js  # 10 例：settings 读取双轨 helper 契约
node test/client-bundle.test.js  #  9 例：client bundle 真实装载契约（两处落点 + 条件注册 + M3 接线 + 令牌闸门）
node test/default-model.test.js  #  7 例：官方写路径的四种失败形态
node test/routes.test.js         #  6 例：0.1.6 / 0.1.7 双世界接线 + 路径唯一闸门
```

上游增量补丁的自证（**离线、不改真文件**）：

```bash
node patches/dsh-our-free-model/self-test.mjs
# 真文件已带补丁 → 直接断言；真文件是原版（被升级冲掉）→ 在临时副本上试打一遍验证锚点仍成立；
# 出现 drift → exit 1（上游改了那几行的写法，照该目录 README 重新对齐）
```

或走统一回归：`node scripts/verify-all.mjs free-model`（**15 项**：5 语法 + 3 补丁件语法 +
1 补丁自证 + 6 测试文件，合计 **62 例**）。实机项见
[回归矩阵](../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)。

## 相关设计文档

- 跨线规划（本线的来龙去脉、M0–M4、与第三方免 Key 车道的边界）：
  [`../dsh-miasaki-shared-docs/cross/free-model-unified-page-2026-09-28.md`](../dsh-miasaki-shared-docs/cross/free-model-unified-page-2026-09-28.md)
- 本线变更记录：[`design/CHANGELOG.md`](design/CHANGELOG.md)
