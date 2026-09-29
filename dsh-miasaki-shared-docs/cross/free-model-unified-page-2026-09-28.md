# 免费模型统一设置页 — 设计规划（Our Free Model × 免费模型池）

- 日期：2026-09-28
- 状态：**规划（待用户拍板路线）**，未动代码
- 范围：跨仓设计 —— 本仓 `dsh-miasaki-desktop/plugins/dsh-free-model-pool`（我们自己的扫描能力）
  × 外部仓库 `zouyuxuan122/dsh-our-free-model`（Our Free Model，本机以 junction 挂在 miasaki profile）
- 相关既有文档：[模型设置工具箱设计](model-settings-toolkit-design-2026-09-07.md)、
  [`dsh-miasaki-desktop/design/model-probe-v2.md`](../../dsh-miasaki-desktop/design/model-probe-v2.md)

---

## 0. TL;DR

**目标**：用户希望「Our Free Model」与「我们自己扫描免费模型的功能」合并到**一个设置页**里，
一次看全"这台机器上现在能用哪些免费模型"，并在同一处完成选区、写入、指派、实测。

**目标形态**：

| # | 决策 | 内容 |
|---|---|---|
| 1 | 统一页落点 | **`设置 → 免费模型`**（本仓池自己的 `settings.section`）—— 原定的"Our Free Model 那一栏"**已否决**：技术上进不去（它整页自绘，`client.js:1419-1441`），且产品承诺冲突（它公开承诺"只有一个上游、不经第三方中转"）。见 §7.2 / §7.2.1 / §7.3 |
| 2 | 扫描能力归属 | **留在本仓免费模型池的 host 半身**（单份实现，已过 0.1.7 settings 双轨适配与单测）；页面只跟自己的 host 说话 |
| 3 | 扫描面升级（本次的技术实质） | 从"只扫 `llm-pi-ai.providers` 的 HTTP `/models`"升级为"**经官方 `llm` 服务枚举所有已注册 provider**（`listProviders()` × `listModels()` × `resolveModelInfo()`）"——Our Free Model 的 Zen 网关模型与自配平台的免费模型进同一个池子，用同一套画像与动作管理，**且 ORM 一侧零改动、零配合** |
| 4 | 耦合度 | **全程无跨插件通信**：ORM 只是 llm 服务里的一条 provider 路由；它未承诺的私有路由（`/api/our-free-model/*`）只作可选增强 |
| 5 | 前置修复项 | 池的 4 条 `/freepool-api/*` 路由目前**无信任围栏**（对比 model-probe / ORM 都有）；动手前必须补齐 —— `/apply` 是**写配置**的动作 |

**目标环境**：内核 **`@deepseek-ai/dsh@0.1.7-rc.2`**（`dsh --version` 实测）。

**决策记录见 §7**（含用户对"不改人家的项目"的约束、由此得出的 P1 唯一路径、以及 §7.2.1 的产品承诺分析）。

---

## 1. 现状盘点

### 1.1 Our Free Model（`dsh-our-free-model` v1.3.1）

| 维度 | 事实 | 依据 |
|---|---|---|
| 归属 | 独立仓库 `github.com/zouyuxuan122/dsh-our-free-model`；本机 `~/.dsh/upstream-git` 是 **shallow clone（depth=1，commit `6b181e9`，2026-09-27）**，`_refs/` 被 gitignore | `git -C _refs/upstream-git log/remote -v` |
| 安装形态 | 发布文件集放在 `~/.dsh/local-plugins/dsh-our-free-model/`；miasaki profile 以 **junction** 挂载（`profiles/miasaki/node_modules/dsh-our-free-model → %USERPROFILE%\.dsh\local-plugins\dsh-our-free-model`）；**web profile 未装** | `Get-Item` 链接类型；两份 profile 的 `package.json` |
| 供给 | 注册 LlmAdapter（provider 路由 `our-free-model`），免 Key 走 OpenCode Zen 网关；选择器出现 `Our Free Model` 与 `Our Free Model · region-limited` 两个分组（后者靠第二条 provider 路由实现） | `README.md` §实现结构；上游清单 11 个 `*-free` 模型 |
| Host 面 | 60 KB `index.js`：`/api/our-free-model/*` JSON 路由（summary / meta / settings / refresh / reprobe / bench / announcement / stats / events …）、自有 JSON 存储、公告 feed（30 min 轮询）、应用内升级（SHA-256 分级校验 + 备份 + 原子替换 + 回滚）、自热重载、OpenAI 兼容本地转发端口（默认 `127.0.0.1:18899`，当前 `forward.enabled=false`） | `~/.dsh/our-free-model/*.json`、README |
| 存储 | `DSH_HOME/our-free-model/{settings,catalog,availability,feed}.json` —— **不进 settings 系统**（作者刻意选择：settings 注册 API 两版内核不一致） | 同上 |
| Client 面 | 107 KB 手写 `window.__ModuleLoader__.load` bundle；`settings.section` **id `our-free-model` order 35**、`settings.onboarding` id `our-free-model-announcement` order -50 | `client.js:1630-1643` |
| 设置页结构 | `SettingsPage`（`client.js:1382`）= hero（状态 pills + 刷新/重探）+ **六个纵向堆叠的 `<Section>`**：模型清单 / 公告中心 / 用量看板 / 本地转发 / 插件设置 / 插件升级（`client.js:1434-1441`） | 直读源码 |
| 基建 | `api()` / `post()` / `useAsync()` / `t()` i18n（`locale/zh.json`）/ `Section`·`Button`·`Pill`·`Switch`·`Roster`·`Dashboard` 组件；样式类前缀 `ofm_` + **官方主题令牌 `--dsw-alias-*`** | 同上 |
| 已有"模型卡"信息 | 可用性、视觉/纯文本、上下文窗口、最长输出、各思考档位实际下发的输出上限、实测首字延迟、单次 bench 按钮 | README §你会看到什么 |
| **扩展成本** | **加一个分区 = 加一行 `h(Section, …)` + 一个面板组件 + 若干 locale 键**（无 Tab/路由表等硬编码结构） | `client.js:1434-1441` |

### 1.2 免费模型池（`dsh-free-model-pool` v0.3.1，本仓 desktop 线）

| 维度 | 事实 | 依据 |
|---|---|---|
| Host 能力 | `inject: ['settings','webServer']`；4 条路由：`GET /freepool-api/status`、`POST /detect`、`POST /apply`、`POST /subagent` | `lib/index.js:255-378` |
| 扫描面 | **仅** `llm-pi-ai.providers` 中带 `baseURL` 的路由 → `GET {baseURL}/models` | `lib/index.js:213-251` |
| 免费判定 | 三层（首个命中即算）：`:free` 后缀 → `pricing` 全零 → 名称匹配 `/免费\|free/i` | `lib/index.js:38-52` |
| 能力画像 | `analyzeModel`：从端点自述（`supported_parameters` / `architecture.*` / `reasoning` / 上下文 / 输出上限）推 工具调用、tool_choice、推理、编码、视觉、结构化输出、长上下文、**子代理可用性（门槛 = tools + tool_choice）**，输出三档 verdict + warnings | `lib/index.js:77-150` |
| 写路径 | `ctx.settings.update('llm-pi-ai', { providers })`（深合并）；`/subagent` 直接改写 `~/.dsh/.agent-presets/{kurumi,whale,inverse}/agent.cordis.yml` 的 `agentOptions` | `lib/index.js:302-378` |
| **信任围栏** | **无**（路由裸注册，无 Host/Origin/`sec-fetch-site` 检查）——与 model-probe、ORM 的做法不一致 | `lib/index.js:196-210` |
| Client 面 | 13 KB 手写 bundle；**优先** `settings.models.footer`（order 10），启动 5 s 后仍无该槽则回退 `settings.section` id `free-model-pool` order 25；单面板、内联样式、无 Tab | `lib/client.js:213-257` |
| ⚠️ 注释归因有误（已核实） | 源文件注释说"模型页运行时补丁声明并渲染了 `settings.models.footer`，补丁缺席则注册抛错"——**不准确**。该槽是**官方原生**的：官方原版 `dsh-client-ui-settings-models/lib/client.js` 里 `renderSlot("settings.models.footer", {})`（baseline `:2367`）与 models section 的 `children` 声明（`:4072`）本来就在，补丁只做模型页**行内**增量（思考强度 / 连通性 / 能力徽标） | 官方 baseline `client.original.js:2367, :4072`；契约 `slot-contract.d.ts:48-52` |
| ⚠️ 回退的真实触发条件 | register 抛错 = **`slot "settings.models.footer" is not declared`**，即 models section 那一刻还没注册（声明缺席 + 装载顺序）；**不是**"补丁被升级覆盖"。所以"补丁丢了 → 面板掉回单独一栏"这条担心的场景不存在 | `dsh-client-ui-slots/lib/index.js:165`；`dsh-client-ui-renderer/lib/client.js:1343-1398` |
| 测试 | `test/routes.test.js`（5 例）+ `test/settings-read.test.js`（10 例），已进 `verify-all.mjs` desktop 类 | `scripts/verify-all.mjs:403-418` |
| 安装 | `file:` 依赖 → miasaki / web profile 的 `node_modules` 里是**真实目录副本**；改源码需重新同步（pnpm file: store 会滞后） | profile 依赖清单；`dsh-miasaki-desktop/README.md:688-692` |

### 1.3 模型探测（`dsh-model-probe` v0.2.1，可复用件）

- `POST /model-probe-api/probe`：两段式真实连通性（零 token 非法体握手 → 1 token 生成），14 类结果 kind。
- `POST /model-probe-api/capabilities`：批量 `{provider, models[]}` → `{image, reasoning}`，**零成本**，真值源是
  `llm.resolveModelInfo`（与 composer 选择器、dual-model 视觉路由同一口径）。
- 有信任栅栏；host only，无 UI。

### 1.4 官方内核可用面（本次 inspect 实测，2026-09-28）

> **内核版本 = `@deepseek-ai/dsh@0.1.7-rc.2`**（`dsh --version`；全局 npm 安装，包族版本一致）。
> 当前会话跑在 **`desktop` profile**（`DSH_PROFILE=desktop`，官方纯净档 + token-monitor），
> 因此下面的 slot 占用情况**看不到 miasaki 的第三方插件**，但契约本身是内核级的。
>
> 另：`settings.section` 自 0.1.5-rc.1 起契约**逐字节未变**（`{close}` / list / root），
> 本次设计不需要版本分叉。

**`llm` 服务（关键）**

| 方法 | 用途 |
|---|---|
| `listProviders(): LlmProviderInfo[]` | **枚举所有已注册适配器的 provider 路由**（含 `our-free-model`，也含 llm-pi-ai 下每个平台） |
| `async listModels(provider): Promise<LlmModelInfo[]>` | 发现任一已注册 provider 的模型（`{provider,id,name,description?,inputModalities?}`） |
| `async resolveModelInfo(provider, model)` | 解析元数据：`context.contextWindow`、`defaultMaxTokens`、`reasoning.efforts[]`+`defaultEffort`、`inputModalities` |
| `listConfigurableProviders(): LlmConfigurableProvider[]` | 可配置 provider 目录（`{provider,displayName,settingsNs,settingsPath,declared?,error?}`）——**含未激活/草稿平台** |
| `registerModelDiscovery(settingsNs, discover)` / `discoverModels(settingsNs, request)` | 官方"询问提供方模型目录"的注册与调用面（模型页"询问提供方"走的就是它） |

**其他写路径**

- `agentDefaultModel.currentSelection() / saveSelection({provider, model, reasoningEffort?})` —— 官方默认模型写路径。
- `subagentModelSelection.current()` —— 子代理模型选择的只读单例设置（**对照**：池现在走"改写预设 YAML"的旁路）。

**Slot 面（设置页）**

| Slot | 类型 | 现状 |
|---|---|---|
| `settings.section` | list | 已占用：`account`(-10) / `general`(0) / `models`(10) / `plugins`(15) / `agent-presets`(20)；注册项 `{id, order, label}` |
| `settings.models.footer` | list | **官方原生槽**（非补丁所造，见 §1.2）；在 desktop profile 下无人占用；"provider 行与 add 控件之后的扩展区"，注册项 `{id, order, label}`，**owner props 是空 marker（不供 `close`）**；由 models section 的 children 声明 ⇒ 随该 section 存活 |
| `settings.models.provider-card` | **keyed** | **无人占用**；"每张 provider 卡的适配器扩展区，dispatch key = `settingsNs`"，owner props `{provider, configured, keyConfigured}`（含已保存行与新增草稿卡）——**就地扫描入口的天然落点** |
| `settings.general.item` | list | 单条偏好行（不需要独立页的设置项） |
| `settings.plugins.tab` | list | 插件区的一页 |

### 1.5 重叠与缺口

| 能力 | Our Free Model | 免费模型池 | 结论 |
|---|---|---|---|
| 免费模型**供给** | ✅ 免 Key（Zen 网关，11 个 `*-free` 模型），注册为选择器分组 | ❌（只发现，不供给） | **互补** |
| 免费模型**发现** | 只发现自己上游的清单 | ✅ 扫任意自配 OpenAI 兼容平台 | 目标不同、可合并成"多来源" |
| **可用性**判定 | ✅ 真实探测（区域门 / 不可路由 / 429 分类） | ❌（不做网络判定） | 互补 |
| **能力画像** | 部分（视觉/上下文/思考档位/首字延迟，来自上游 + 实测） | ✅ 结构化画像 + 子代理可用性 verdict | **池的更完整** |
| **连通性实测** | ✅ bench（ttft / tps） | ❌ | 可复用 model-probe |
| **写配置** | ❌（不改别人配置） | ✅ 写入 llm-pi-ai provider models | 池独有 |
| **子代理指派** | ❌ | ✅（改预设 YAML） | 池独有（可升级为官方服务） |
| 运维面（公告 / 升级 / 热重载 / 转发 / 用量） | ✅ 六分区里的四个 | ❌ | ORM 独有 |
| 设置页入口 | ✅ `settings.section`（order 35） | ⚠️ 模型页底部 footer（或缺补丁时降级为独立栏 order 25） | **现在是两个入口** |

**用户痛点（推断，待确认）**：同一件事（"有哪些免费模型能用"）split 在"设置 → Our Free Model"与
"设置 → 模型 页底部"两处；两边的模型卡信息口径也不同（一边是实测可用性，一边是静态画像）。

---

## 2. 目标与非目标

**目标**

1. **一个入口**：设置里只有一个"免费模型"页，能看到全部来源的免费模型。
2. **一套口径**：免费判定、能力画像、可用性三件事在不同来源上用同一套规则与同一套 UI 表达。
3. **就地操作**：在同一页里完成 选区 / 写入 provider / 指派子代理 / 实测连通性 / 跳转到上游原生设置。
4. **零重复实现**：画像与扫描逻辑只有一份，不在两个仓库各写一遍（避免漂移）。
5. **可降级**：任一插件缺席 / 内核版本漂移 / 网络失败时，页面不整块报错（ORM 的硬契约："关掉即原生"）。

**非目标**

- 不把 ORM 的运维分区（公告 / 升级 / 转发 / 用量）搬去别处 —— 它们留在 ORM 页里。
- 不 fork 官方 `dsh-client-ui-settings-models` 包去改模型页（本仓既有纪律：走补丁 + 插件）。
- 不改变"免 Key 车道"的实现（Zen 网关指纹、思考预算、转发端口）——本次只动"发现与管理"层。
- 不替用户自动决定"哪些免费模型该被写入配置"（写入仍是显式动作）。

---

## 3. 方案空间

| 路线 | 统一页落点 | 扫描能力在哪 | 改动面 | 优 | 劣 |
|---|---|---|---|---|---|
| **A. 纯本仓聚合** | 设置 → 模型 页底部（池的 footer 面板升级） | 池 host（本仓） | 只改本仓 | 完全可控、可回归、零外部依赖 | 入口仍在"模型"页，不是 ORM 栏；ORM 六分区仍独立 |
| **B. 统一页在 ORM，扫描后端在池**（**❌ 已否决**：技术 + 产品双重不可行，§7.2 / §7.2.1） | 设置 → Our Free Model 新增「免费模型扫描」分区 | 池 host（本仓），ORM 客户端同源 fetch | 本仓 + ORM（一个分区） | 表面上"真正一个设置页" | 进不去别人的自绘页面；与它"单一上游"承诺冲突；跨插件运行时依赖；ORM 要发版 |
| **C. 能力移植进 ORM**（❌ 否决：同 §7.2.1） | 设置 → Our Free Model 新增分区 | **ORM host 内新实现** | ORM 单仓 | 单插件自洽 | 画像/扫描逻辑**双份实现**（漂移）；且同样改它的承诺 |
| **D. 最小改动（只加只读分组）** | 保持现状两个入口，池面板里加"来源：Our Free Model"分组 | 池 host | 本仓小改 | 半天工作量、风险最低 | 不满足"一个设置页" |

**最终结论（2026-09-28 二轮后）：路线 A 的强化版** —— 本仓统一页 + 扫描面升级到官方 `llm` 服务 + 围栏前置修复。

最初推荐的 B/B+ 出局，两条硬约束：

1. **技术上**：进不去别人的页面 —— Our Free Model 的设置页整页自绘，官方 slot 只允许注册"自己的" section（§7.2）。
2. **产品上**（用户提出，成立且更硬）：它公开承诺"只有一个上游、不经第三方中转"，
   把"扫描你自配的平台"放进它的页面等于替它改对外承诺（§7.2.1）。

把 A 做强反而更好：取数走**官方 llm 契约**后，本方案**零跨插件通信、零改第三方、也不需要它的作者做任何事**。

---

## 4. 方案详设（P1：本仓统一页 + 官方契约取数）

### 4.1 信息架构

统一页 = **`设置 → 免费模型`**（池自己的 section；`id` 沿用 `free-model-pool` 以免影响既有安装，`label` 改为「免费模型」）：

```
设置 → 免费模型
├── ① 免 Key 车道（Our Free Model）   ← 经官方 llm 服务只读枚举，ORM 零感知、零改动
│     muse-spark-1.3-contributor-free · 视觉 · ctx 256K · 思考档 4K/16K/32K   [实测]
├── ② 本机自配平台的免费模型           ← 池现有能力（扫描/画像/写入/指派）+ 扫描面升级
│     openrouter: xxx:free · 子代理可用 · ctx 1M                              [写入][指派]
└── ③ 决策摘要                        ← 最佳子代理 / 编码类 / 超长上下文 / 多模态
```

> **原"在 Our Free Model 六个分区里加第七个"的形态已否决**（技术不可行 + 产品承诺冲突，见 §7.2 / §7.2.1）；
> 本节的 P1 形态是最终形态，细节见 §7.3.1。

- 两个来源走**同一张模型卡**与**同一套画像口径**（§4.3），差异只在可用动作：
  ① 是免 Key 车道，**不可写入 `llm-pi-ai`**（Zen 网关靠 `x-opencode-*` 指纹计免费额度，普通 provider 接入拿不到）；
  ② 可写入、可指派。
- 卡上动作：`实测`（model-probe 两段式）/ `写入`（仅 ②）/ `设为子代理` / `在模型页打开`（深链，实现方式待定）。
- ORM 自己那一栏**原样保留**（公告 / 升级 / 转发 / 用量仍是它的主场）。

### 4.2 数据流与接口契约

```
┌ 池 client（统一页，手写 __ModuleLoader__ bundle） ────────────┐
│  api('/freepool-api/scan')      → 池 host                    │
│  api('/model-probe-api/probe')  → 探测 host（可选，实测按钮） │
└──────────────────────────────────────────────────────────────┘
        │ 同源 fetch（页面自带 authority cookie）
        ▼
┌ 池 host（scanner，单份实现） ─────────────────────────────────┐
│  来源 A  官方 llm 服务：listProviders() → listModels(p)       │
│          → resolveModelInfo(p, m) 取上下文/思考档/模态         │
│          含 our-free-model（Zen 免 Key 车道）、llm-pi-ai 各平台 │
│  来源 B  llm-pi-ai.providers 的 HTTP /models（现有逻辑，补充）  │
│  来源 C  listConfigurableProviders()（未激活/草稿 → 引导）     │
│  免费判定 → 能力画像（官方真值优先，端点自述兜底）             │
│  写路径：settings.update('llm-pi-ai', {providers})｜指派       │
└──────────────────────────────────────────────────────────────┘

★ 关键：**全程没有跨插件通信**。ORM 那一侧只是"官方 llm 服务里的一条 provider 路由"，
   我们不需要它的任何私有路由、不需要它的配合、也不改变它的任何对外承诺（§7.2.1）。
```

**新增/改造的 host 路由（池）**

| 路径 | 方法 | 入参 | 返回 |
|---|---|---|---|
| `/freepool-api/scan` | POST | `{ provider?: string }`（省略 = 全部来源） | `{ sources: [{ id, kind: 'adapter'\|'pi-ai'\|'draft', displayName, free, models: [...] }], summary }` |
| `/freepool-api/status` | GET | — | 扩展：每个平台增加 `kind` 与 `providerRoute`（官方 llm 路由名） |
| `/freepool-api/detect` `/apply` `/subagent` | — | 保持现有契约（向后兼容） | — |

**跨插件通信：本方案不需要（调研结论备查）**

| 结论 | 证据 |
|---|---|
| 本方案取数路径**完全在池内部闭合**：池 client → 池 host → 官方 `llm` 服务 | 见上方数据流；ORM 只是 llm 服务里的一条 provider 路由 |
| 若**将来**想补 ORM 的私有状态（可用性探测结果、思考档位预算、用量看板）：同源 fetch `/api/our-free-model/*` 可行且无需手工凭据 | 页面自带 connection 铸造的 authority cookie；池自己就是这么调 `/freepool-api/*` 的（`lib/client.js:14-23`） |
| 但那是它**未承诺的内部契约**，且**插件↔插件互读在本仓零先例** → 只可作可选增强，按"404/异常即整块不显示"降级，绝不作为主路径 | 全仓 grep：各插件只命中自己的路由前缀；唯一先例是**本体补丁**牵线（模型页补丁 → `/model-probe-api/*`，补丁 README `:283-285`） |
| ORM 的信任栅栏对同源 fetch 透明 | 要求 loopback Host + 非跨站 `sec-fetch-site` + Origin/Referer 与 Host 同 authority（`src/trust.js:62-82`）；`dsh web` 与 miasaki 桌面壳满足。**反例预警**：`file://` 承载的官方桌面端可能因"没有 HTTP origin"被 403（待实测） |
| 反向依赖（ORM 直接 `require` 池的 client）**技术上可行但不要用** | 插件 client 共享同一 `window.__ModuleLoader__`，可 require 对方（需自己的 `dsh.client.external` 声明对方包名）；本仓自研插件 `external` 零使用 ⇒ 未踩过的路，且会把两插件钉死在同一次装载顺序上 |

**ORM 的 HTTP 路由全清单（主代理自查：`index.js:1049-1159` 的 `routePath` 分派）**

| 只读（若做可选增强，只用这一列） | 写（**绝对不碰**） |
|---|---|
| `GET /summary`（模型清单 + 可用性 + 设置 + egress）<br>`GET /stats`（用量看板数据）<br>`GET /meta`（版本 / 热重载计数）<br>`GET /announcement`、`GET /announcements`<br>`GET /update/status`<br>`GET /events`（SSE 推送，exact 路由） | `POST /settings`、`/refresh`、`/reprobe`、`/bench`<br>`POST /announcement/ack`、`/announcements/ack`、`/announcements/refresh`<br>`POST /update/check`、`/update/apply`、`/reload`<br>`POST /forward/rotate` |

> ⚠️ **`GET /forward/key` 是只读但敏感**（返回本地转发端口的 API Key，`index.js:1153`）——
> 如果将来真的做可选增强，**明确排除这一条**，不要读、不要缓存、不要进任何 UI。

**扫描面升级的实现要点**

- 来源 A 不需要配置、不需要凭据、不需要 `settings` —— 纯 `llm` 服务调用，因此**天然覆盖 Our Free Model**。
- 来源 A 的元数据来自适配器自述，比 HTTP `/models` 的 OpenRouter 方言更权威（与 model-probe 的
  capabilities 同一真值源 `llm.resolveModelInfo`）。
- **已核实 ORM 侧无需任何改动即可被枚举**：它的适配器 `listModels` 就是返回清单里的
  `{ id, name, contextWindow, inputModalities }`（`index.js:254-256`，`vision` 决定
  `['text','image']`），并且它用 `ctx.llm.registerAdapter([ROUTE_MAIN, ROUTE_REGION], adapter)`
  注册了两条路由（`index.js:237`）→ `llm.listProviders()` 会看到 `our-free-model` 路由，
  `llm.listModels('our-free-model')` 会拿到 11 个模型。
- 免费判定在来源 A 上需要新增一层：**provider 级"已知免 Key 车道"**（`our-free-model` 整路由免费）
  + 模型级 `-free` 后缀。现有三规则里的 `:free` 是 OpenRouter 方言，覆盖不到 `-free` 后缀的 Zen 清单。
- 来源 B 保留：某些网关（自建 chatapi 等）不在 provider 目录里，或适配器未声明模型。

### 4.3 免费判定与能力画像的统一口径

**免费判定（分层，命中即算，逐层标注依据）**

| 层 | 规则 | 适用 |
|---|---|---|
| L0 | provider 级：已知免 Key 车道（`our-free-model`） | Zen 网关整路由 |
| L1 | 模型 id 后缀：`:free`（OpenRouter 方言）/ `-free`（Zen 清单方言） | 精确 |
| L2 | `pricing.*` 字段全零 | OpenRouter 及其镜像网关 |
| L3 | 名称匹配 `/免费\|free/i` | 兜底 |
| L4 | 未判定 → **不标免费、不隐藏** | 与 ORM"能力只到探测能证明的程度"一致 |

**能力画像（真值优先级）**

1. 官方适配器自述：`llm.resolveModelInfo(provider, model)` → context / maxTokens / reasoning.efforts / inputModalities。
2. 端点自述：`supported_parameters` / `architecture.modality` / `reasoning` / `top_provider.max_completion_tokens`（池现有逻辑）。
3. 静态规则：编码/长上下文/预览模型识别（池现有）。
4. 实测（可选、用户触发）：model-probe 的两段式连通性；ORM 的 bench（ttft / tok/s）。

产出 verdict 三档（子代理可用 / 仅问答·批处理 / 需实测）保持不变 —— **口径不变，只扩数据源**。

### 4.4 动作与写路径

| 动作 | 现状 | 建议 |
|---|---|---|
| 写入 provider models | `settings.update('llm-pi-ai', {providers})` | 保持；但**只对来源 B/llm-pi-ai 平台开放**；来源 A 的免 Key 车道不可写（Zen 网关要 `x-opencode-*` 指纹，普通 provider 接入拿不到免费额度） |
| 设为子代理后端 | 改写 3 个预设的 `agent.cordis.yml`（旁路，会绕开设置系统与预设组合包） | **建议改用官方 `subagentModelSelection` / 预设服务**；YAML 直改在"预设组合包化"（0.1.7 冒烟矩阵提到的方向）下会失效 |
| 设为默认模型 | 无 | 新增：`agentDefaultModel.saveSelection({provider, model})`（官方写路径） |
| 实测连通性 | 无（池）/ bench（ORM，仅自家模型） | 复用 `/model-probe-api/probe`，两个来源通用 |
| 深链 | 无 | 让用户跳到"设置 → 模型"页对应 provider 卡（`settings.section` 的 `only` 过滤由 shell 拥有，深链需确认可行方式） |

### 4.5 降级矩阵（硬要求：任一格都不能整页报错）

| 缺失/失败 | 期望表现 |
|---|---|
| **Our Free Model 缺席**（没装 / 未激活） | ①「免 Key 车道」区整块不渲染；②③ 照常 —— `llm.listProviders()` 里没有它就没有这一组，不需要探测、不会报错 |
| `llm` 服务不可用 | 来源 A 跳过，只显示来源 B（HTTP 扫描）；①区整块隐藏 |
| `llm-pi-ai` 命名空间读不到（版本漂移） | 复用池现有的 `settings-read.js` 双轨；两代都读不到时只显示来源 A |
| model-probe 缺席 | `实测` 按钮隐藏（不报错） |
| ORM 自升级（与本页无关） | 本页**零感知** —— 我们不读它的文件、不注入它的产物，它升级只是换了它自己的实现 |
| 扫描网络失败 | 分区内逐来源标注失败原因，不弹全局错误 |

### 4.6 安全与信任

- **前置修复（M0）**：池的 4 条路由补信任围栏（loopback Host / 非跨站 `sec-fetch-site` / 同源 Origin），
  与 model-probe、ORM 的 `src/trust.js`、sidebar / canvas 的栅栏同构。现状 = 任意本地网页可
  `POST /freepool-api/apply` 改写模型配置（**写操作**），这是动手前必须清掉的洞。
- 凭据：来源 B 读 `apiKeyEnv` 对应环境变量；**不回传 key**（沿用 model-probe 的双遍脱敏口径）。
- 来源 A 不涉及任何凭据（免 Key 车道），也不写任何配置 —— ①区只有"实测"这一个出网动作。

---

## 5. 分期实施计划

| 期 | 内容 | 产出 | 验收判据 |
|---|---|---|---|
| **M0 前置** | 池路由补信任围栏 + 单测（403/401 分支） | 本仓改动 + 测试 | 新单测 ≥6 例；`verify-all` desktop 类通过；异源 Origin 403、跨站 `sec-fetch-site` 403 |
| **M1 扫描面升级** | 池新增"来源 A（官方 llm 服务枚举）"；`/freepool-api/scan` 路由；免费判定加 L0；画像真值优先级调整 | 本仓改动 + 单测 | 单测覆盖：provider 枚举、`-free` 后缀判定、llm 服务不可用时降级；**在 miasaki profile 实机看到 `our-free-model` 的 11 个模型** |
| **M2 统一页** | 池的 section 升级为「免费模型」统一页（①免 Key 车道 ②自配平台 ③决策摘要）；footer 面板退出/条件注册 | 本仓改动 | 实机看到统一页三个分区；ORM 那一栏保持原样、互不干扰；池缺席时页面自身不报错 |
| **M3 动作统一** | 设为默认模型（`agentDefaultModel.saveSelection`）；子代理指派改官方服务；`实测`按钮接 model-probe；决策摘要一键指派 | 本仓改动 | 实机点击逐项验证；预设文件与设置系统不再有两套真值 |

**跨仓协作**：**无**。§7.2.1 的结论让 P2（本地补丁注入）与 P3（提 PR）一并出局，
四个里程碑全部落在本仓，`dsh-our-free-model` 一个字节都不动 —— 也不需要它的作者做任何事。
（`§6.1` 保留 ORM 升级器的逐行语义，作为"为什么不能改它安装副本"的存档证据。）

---

### 5.1 M0–M3 任务分解（文件级，可直接照着做）

**M0 · 池路由信任围栏**（约半天）

| 动作 | 位置 |
|---|---|
| 新增 `lib/trust.js`：`fenceRequest(ctx, req)` —— ① 优先复用 composition 的 `connection` 准入（`ctx.get('connection')` **逐请求**读取；禁用 apply 时快照，ORM 踩过这个坑）；② 缺席时退回结构化围栏：Host 必须回环（**缺失或为空也拒**，fail closed）、`sec-fetch-site: cross-site` → 拒、`Origin`/`Referer` 存在时必须与 Host 同源同端口 | `plugins/dsh-free-model-pool/lib/trust.js`（新增） |
| `registerRoute` 包装器内**先跑围栏**，未过直接 403/401，不进入业务 handler | `lib/index.js:196-210` |
| 新增 `test/trust.test.js` ≥6 例：同源放行 / 异源 Origin 403 / 跨站 `sec-fetch-site` 403 / 非回环 Host 403 / Host 缺失 403 / 有 connection 时按 admit 结果 401 | `test/trust.test.js`（新增） |

**验收**：`node test/trust.test.js` 全绿；`verify-all.mjs` desktop 类通过；异源 Origin 实测 403。

**M1 · 扫描面升级**（约 1–1.5 天）

| 动作 | 位置 |
|---|---|
| `llm` 走 **`ctx.get('llm')`**，**不**进 `inject`（声明的服务在无 llm 的 composition 里会让插件整体不激活 —— ORM README 的实测教训） | `lib/index.js:194` |
| 新增 `listAdapterSources(llm)`：`listProviders()` → 逐 provider `listModels(p)`（**每个 provider 独立 try/catch + 超时**）→ 逐 model `resolveModelInfo(p, m)`（带内存缓存，手动刷新） | `lib/index.js` |
| 免费判定新增 **L0**：provider 的 `id`/`name` 命中 `/free/i` ⇒ 整路由标记"疑似免 Key 车道"（**不硬编码 `our-free-model`**；单独分组、**默认不可写入**配置） | `lib/free-rules.js`（建议抽出） |
| 画像合并：官方真值（`context.defaultMaxTokens` / `reasoning.efforts` / `inputModalities`）优先，端点自述兜底 | `lib/index.js` 的 `analyzeModel` |
| 新增 `POST /freepool-api/scan`（`{provider?, source?}`）→ `{ sources[], models[], summary, partial[] }`；`partial` 记录**逐来源失败原因**，不整体失败 | `lib/index.js` |
| `GET /freepool-api/status` 扩展 `kind` 与 `providerRoute` | 同上 |
| 新增 `test/scan.test.js`：mock llm 服务 —— ①provider 枚举与去重 ②L0/L1 判定 ③llm 不可用降级到 HTTP 来源 ④单 provider 抛错被隔离进 `partial` ⑤`resolveModelInfo` 抛错时字段回落 | `test/scan.test.js`（新增） |

**验收**：单测全绿；miasaki 实机 `POST /freepool-api/scan` 的返回里出现 `our-free-model` 的 11 个模型与其模态/上下文。

**M2 · 统一页**（约 1 天）

| 动作 | 位置 |
|---|---|
| 面板改三区：①免 Key 车道 ②本机自配平台 ③决策摘要 | `lib/client.js` |
| 注册目标由 `settings.models.footer` 改为 **`settings.section`**（id 沿用 `free-model-pool`、label「免费模型」、order 25） | `lib/client.js:213-257` |
| **可选增强（推荐一起做）**：注册官方 keyed 槽 `settings.models.provider-card`，key = 各 provider 的 `settingsNs`（Our Free Model 的 key 是 `our-free-model`），在 provider 卡片下挂「扫描该提供方的免费模型」—— **官方机制、零改第三方、不触它的承诺**，且正好落在用户看模型的地方（§8.4） | `lib/client.js` |
| 样式从内联色值改为**官方主题令牌 `--dsw-alias-*`**（ORM 就是这么做的，主题切换时才不违和） | 同上 |
| 保留幂等守卫与"失败只记一次"日志纪律 | `lib/client.js:215-227` |

**验收**：设置里出现「免费模型」栏；三区数据正确；ORM 那一栏不受影响；`/freepool-api/*` 全挂时页面给友好错误而非白屏。

**M3 · 动作统一**（约 1 天）

| 动作 | 位置 |
|---|---|
| 「实测」按钮 → `POST /model-probe-api/probe`（404 → 隐藏按钮，不报错） | `lib/client.js` |
| 新增 `POST /freepool-api/default-model` → `agentDefaultModel.saveSelection({provider, model})`（服务缺席时返回语义化未支持） | `lib/index.js` |
| 子代理指派：先核实官方是否有**写路径**（`subagentModelSelection` 目前只见只读 `current()`）；无写路径则保留 YAML 改写，但把"预设文件不存在/结构不符"做成显式失败 | `lib/index.js:334-378` |

**验收**：实机点击逐项；设置系统里能读到新的默认模型；预设文件与设置系统不再有两套真值。

---

## 6. 风险登记册

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | （**已不适用**）"ORM 升级覆盖本地改动" | 原"改它仓库/注入它页面"路线的风险 | P1 下不改它、不注入它 ⇒ 风险归零。§6.1 作为存档保留，说明为何"改它安装副本"同样不可取 |
| R2 | （**已不适用**）"跨插件运行时依赖" | 原路线 B 的风险 | P1 取数走官方 `llm` 服务，**无任何跨插件调用**；池异常时它自己那一栏照常工作 |
| R3 | （**已不适用**）"两份画像实现漂移" | 原路线 C 的风险 | P1 单份实现（画像只在池里） |
| R4 | **池路由无鉴权**（现存，**唯一的安全项**） | 写配置能力暴露给任意本地页面 | M0 必修 |
| R5 | profile 闸门（**澄清后风险很低**） | 本机 `dsh-our-free-model` 以 **junction** 挂在 miasaki profile | ORM 的 README 警告"桌面端不要 junction"，指的是 **DSHEAC AIO / 官方桌面端**（它们的闸门只放行 `.dsh-module-fallback` 下的链接）；**miasaki 自制壳不禁 junction** —— 本仓 `dsh-miasaki-desktop/plugins/dsh-computer-use/install.ps1` 就是以 junction 为既定安装方式。故在 miasaki 上无此风险；若要装进官方桌面端 profile，必须改成真实目录 |
| R6 | （**已撤销**）"footer 依赖模型页补丁" | — | 已核实该槽是**官方原生**（§1.2），补丁被升级覆盖不会影响面板；真实风险降级为"声明缺席时的装载顺序竞态"，而池现有的 5 s 延迟 + `ctx.slots.inject` watcher 正是为它准备的（`lib/client.js:218-256`） |
| R7 | 子代理指派走 YAML 旁路 | 预设组合包化后失效 | M3 评估改用官方服务 |
| R8 | Zen 网关不可写入 llm-pi-ai | 用户误以为"扫到了就能当普通 provider 用" | UI 明确标注来源 A 为"免 Key 车道，不可写入" |

---

### 6.1 ORM 升级器对"本地改动"的精确语义（`_refs/upstream-git/src/updater.js`，逐行核实）

升级流程：拉清单 → 校验（semver / 路径逃逸 / 哈希格式）→ stage 逐文件 SHA-256 → `backupPackage`
→ `installStaged` → `verifyInstalled` 回读 → 失败 `restoreBackup`（`:447-486`）。

`listPackageFiles`（`:250-264`）对**顶层**做两处跳过：

- `REPOSITORY_SCAFFOLDING = ['feed','scripts','docs','promo','node_modules']`（`:240`）
- 顶层以 `.` 开头的条目（`:255`，即 `.git` / `.github` / `.gitattributes` 等）

**其余一切皆为"包文件"**：`installStaged` 先把清单内文件逐个写入（同目录 `.ofm-new` → rename，`:313-322`），
再**删除包目录里不在清单中的文件**（`:324-327`，"新版本删掉的文件不该残留"）。

推论（**存档证据**：这就是为什么"直接改它安装副本 / 打补丁注入"同样不可取 —— 不只是维护成本，而是根本不该走）：

1. **手改安装副本（`~/.dsh/local-plugins/dsh-our-free-model/`）的 `client.js` 必被覆盖** ——
   `client.js` 在发布清单内。做实验可以，交付不行。
2. 在 ORM 仓库里新增文件（例如 `lib/scan-panel.js`）**必须进发布清单**
   （`scripts/build-manifest.mjs` 递归收集，`package.json` 的 `files` 字段同步），否则升级时会被当"已删除文件"清掉。
3. 打算长期留在工作副本、不进发布物的东西（测试、探测脚本、笔记）要放进
   `feed / scripts / docs / promo / node_modules` 之一 —— 注意 `catalog/`、`vendor/`、`tsconfig.json`
   **不在**白名单里，它们会被升级器当作包文件处理。
4. 结论：**M2 的 ORM 改动是一条正常的功能提交 + 版本 + 清单 + feed 流程**，不是"改本机副本"。

---

## 7. 决策记录与剩余冲突

### 7.1 决策记录（2026-09-28，两轮）

| 轮次 | 问题 | 结论 |
|---|---|---|
| 一 | 统一页落点 | 初选"设置 → Our Free Model 新增分区" —— **后经 §7.2 / §7.2.1 推翻**，改为本仓 `设置 → 免费模型` |
| 一 | 改动范围 | **「这是人家的项目」** —— 不改 `zouyuxuan122/dsh-our-free-model` 仓库 |
| 一 | 顺手项 | ① 补池路由信任围栏 ② 接 model-probe 实测按钮 ③ 子代理指派改官方服务 ④ 以「最小可验证版本」起步 |
| 二 | 提 PR 是否合适 | 用户质疑："人家仓库主页就写着不要 key，我们的需求是不是有点违背人家，提 pr 好吗" → **顾虑成立且比"要不要 key"更深**（真正冲突是"单一上游"承诺），见 §7.2.1；**P2 / P3 一并否决** |
| 二 | 是否立即开工 | **暂不动代码** —— 用户"再想想" |
| 三 | 卡住的子代理 | 负责深挖 ORM 内部结构的 subagent **已终止且未交回结果**（`send_message` → `active teammate not found`）。其目标已由主代理自查替代（适配器注册 / `listModels` 返回 / `updater.js` 语义 / 路由全清单见 §4.2），**不需要重启该调研** —— 结论是"只用官方契约"，它的产出只服务于一个可选增强 |

### 7.2 冲突：**"落点在它那一栏" 与 "不改人家的项目" 不能同时直接成立**

Our Free Model 的设置页是它**自己整个自绘**的（`client.js:1419-1441`，六个 `<Section>` 直接写死在
`SettingsPage` 的返回值里），官方 slot 机制**只允许别的插件注册自己的 section，不允许往别人的 section 里插内容**。
所以不改它的代码，就没有官方通道把分区放进它那一栏。

（`settings.section` 的注册项文档确实写着"复用已发布 id = 顶替那一格"，但 `our-free-model` 不是官方 shipped id，
是同 id 二次注册 —— list 槽同 id 同 priority 直接抛错、不同 priority 也只是覆盖显示，**属于会顶掉他人 UI 的危险手段，不采用**。）

### 7.2.1 更深一层的冲突：**产品承诺**（用户 2026-09-28 提出的顾虑，成立且更硬）

用户原话：

> "人家仓库主页就写着不要 key，我们的需求是不是有点违背人家，提 PR 好吗"

先澄清一个不成立的部分：**"要不要 key"本身不冲突**——ORM 的设置页本来就有「插件设置」（探测间隔、默认输出上限）
与「本地转发」（生成 Key 给本机其它工具用），它不是"零配置插件"，它的承诺是**零门槛用上模型**。

真正冲突的是**模型来源的单一性叙事**。ORM 的公开文档把"只有一个上游、不经第三方中转"当成核心信任主张：

| ORM README 的公开承诺 | 与"把我们扫描到的第三方平台免费模型放进它的页面"的关系 |
|---|---|
| "上游写在明面上——**只有一个来源**：OpenCode 的 Zen 网关，不经任何第三方中转" | ❌ 直接相悖：页面里会出现"你自己配置的任意 OpenAI 兼容平台" |
| "**当前没有号池、没有中转**……上表四行就是这个插件会出网的全部目标" | ❌ 相悖：扫描会向用户自配的 baseURL 出网 |
| "谁在服务你的请求、你的数据发到哪儿" 是它要回答的问题 | ❌ 会让答案变得不确定（取决于用户配了哪些平台） |
| "能力只到探测能证明的程度" | ✅ 一致（画像口径可以对齐） |

**结论**：把"扫描自配平台的免费模型"塞进 Our Free Model 的页面，
**不是技术问题，而是替它改了对外承诺**。因此：

- **P3（提 PR）不建议** —— 我们无权替作者改它的信任叙事；被拒的概率高，且提了也是给作者出难题。
- **P2（本地补丁注入）同样不建议** —— 它只是把同一件不合定位的事藏进本机：页面是它的、内容是别人的，
  升级后还要重打；用户自己受益有限，维护成本却长期存在。
- **P1 是正解**，而且理由从"零侵入"升级为**"职责与叙事分离"**：
  - Our Free Model 保持它"**单一上游 + 零门槛**"的纯净定位，一个字节都不动；
  - 我们自己的那一页承担"**多来源免费模型统一台**"——它本来就是池的定位（扫任意平台），名正言顺；
  - 用户仍然一处看全，只是那个"一处"是我们的页，而不是它的页。

### 7.3 结论：只走 P1（本仓统一页），且**只用官方契约取 ORM 的数据**

| 路径 | 判定 | 理由 |
|---|---|---|
| **P1 本仓统一页** | ✅ **唯一推荐** | 职责与叙事分离（§7.2.1）；全部改动在本仓，可测、可回归、可回退；ORM 一字节不动 |
| P2 本地锚点补丁注入 | ❌ 不建议 | 把不合它定位的内容藏进它的页面；每次自升级要重打；维护成本长期化 |
| P3 提 PR / issue | ❌ 不建议 | 等于请作者改它的对外信任叙事，不该由我们提 |

**P1 的耦合度还能再降一级（本方案的关键优化）**：不要把"读 ORM 数据"建在它的私有路由上
（`/api/our-free-model/*` 是它未承诺的内部契约，改版即漂移），而是**经官方 `llm` 服务读**：

| 需要的信息 | 官方取法（零耦合） | 是否够用 |
|---|---|---|
| 有哪些免 Key 模型 | `llm.listProviders()` → 找到 `our-free-model` → `llm.listModels('our-free-model')` | ✅ 已核实它注册了该路由（`index.js:237`）且 `listModels` 返回 `{id,name,contextWindow,inputModalities}`（`index.js:254-256`） |
| 上下文 / 最大输出 | `llm.resolveModelInfo(provider, model).context` / `.defaultMaxTokens` | ✅ |
| 视觉 / 思考档位 | 同上的 `inputModalities` 与 `reasoning.efforts` | ✅ |
| 它自己的可用性探测结果（region-blocked 等）、思考档位实际预算、用量看板 | 官方服务没有 —— 只能读它的私有路由 | ⚠️ **可选增强**，按"未承诺契约"对待：探测 404/异常即整块不显示，绝不作为主路径 |

这样统一页对 Our Free Model 的依赖退化为"**它作为 DSH provider 存在**"——
这是插件生态里**最正常的依赖关系**，不需要它的作者为我们做任何事，也不涉及它的任何承诺。

### 7.3.1 统一页的新定位（P1 落地形态）

`设置 → 免费模型`（池的 section 升级；id 沿用 `free-model-pool` 以免影响既有安装，label 改为「免费模型」）：

```
设置 → 免费模型
├── ① 免 Key 车道（Our Free Model）      ← 经官方 llm 服务只读枚举，ORM 零感知
│      muse-spark-1.3-contributor-free · 视觉 · ctx 256K · 思考档 4K/16K/32K   [实测]
├── ② 本机自配平台的免费模型              ← 池现有能力（扫描 / 画像 / 写入 / 指派子代理）
│      openrouter: xxx:free · 子代理可用 · ctx 1M                              [写入][指派]
└── ③ 决策摘要                           ← 最佳子代理 / 编码类 / 超长上下文 / 多模态
```

- 两个来源走**同一张模型卡**与**同一套画像口径**（§4.3），差异只在可用动作：
  ① 是免 Key 车道（**不可写入 llm-pi-ai**，Zen 网关需指纹）、② 可写入。
- ORM 自己那一栏**保持原样**（它的公告 / 升级 / 转发 / 用量仍是它的主场）；
  统一页在 ① 区给一条"打开 Our Free Model 设置"的深链（`settings.section` 的 `only` 过滤由 shell 拥有，
  实现方式待定，最差可用文案指引）。

### 7.4 路径收敛后的开工清单（**等用户点头，当前不动代码**）

| 序 | 内容 | 落点 |
|---|---|---|
| **M0** | 池的 `/freepool-api/*` 补信任围栏（loopback Host / 非跨站 `sec-fetch-site` / 同源 Origin）+ 单测（403 / 401 分支） | 本仓 |
| **M1** | 扫描面升级：官方 `llm` 服务枚举所有 provider（`listProviders` × `listModels` × `resolveModelInfo`）；新增 `/freepool-api/scan`；免费判定加 L0"免 Key 车道"层（`our-free-model` 整路由） | 本仓 |
| **M2** | 池的 section 升级为「免费模型」统一页（①免 Key 车道 ②自配平台 ③决策摘要）；`settings.models.footer` 面板退出或条件注册 | 本仓 |
| **M3** | 顺手项：model-probe 实测按钮、子代理指派改官方服务、设为默认模型（`agentDefaultModel.saveSelection`） | 本仓 |

**全部在本仓** —— 这是 §7.2.1 结论带来的额外收益：没有任何一步需要碰别人的仓库、也不需要它的作者做任何事。

### 7.5 其余待确认（不阻塞开工）

- **结合深度**：默认取"能力互补"（统一模型卡 + 统一动作），即 §4.3 / §4.4 的口径。
- **池的面板去重**：P1 下降级为"统一页自身"；P2/P3 下改为"ORM 在场时不注册 footer"。
- **profile 覆盖**：ORM 只装在 miasaki（web profile 未装）。若统一页要在 `dsh web` 也有 ORM 数据，
  需要先在 web profile 安装 ORM（`dsh plugin --profile web add …`）。

---

## 8. 对上游的建议：**逐行核查后决定不提**（2026-09-28 二轮）

### 8.1 用户判断

用户（2026-09-28）：**"我觉得可以提个 pr，说一下这种需求提一下建议，人家不接受就算了，专心搞我们自己的。"**

方向我赞成（低承诺、不成就算了），但**起草前必须把诉求核实到行号** —— 否则提一个"已经支持"的建议，
比不提更糟。核查结果如下。

### 8.2 核查结论：它已经把官方契约面做全了，**没有标的可提**

逐行核查 `~/.dsh/local-plugins/dsh-our-free-model/index.js`，原先设想的两条建议**全部不成立**：

| 原设想的建议 | 核查实况 |
|---|---|
| "建议声明 `registerModelDiscovery`" | **它已经声明了**（`index.js:246`）。而且 `discover` 做得比最低要求好：先 `await refreshCatalog({ probe: true })` 再只广告**真实可路由**的模型（`advertised` 集合过滤），返回 `{id, name, contextWindow, maxTokens, inputModalities}` |
| "建议声明 `registerConfigurableProviders`" | **也已经声明了**（`index.js:238`）：`{ provider: ROUTE_MAIN, displayName, settingsNs: <自己的 loader entry id>, settingsPath: [] }` ⇒ 官方模型页里它**有一张 provider 卡片**，且"询问提供方"可用 |
| 兼容性 | 两处都用可选调用 `?.()`，在没有这两个 API 的旧内核上安静跳过 |

**内在原因**：我们经 `llm.listModels('our-free-model')` 就能拿到它的模型，**正是因为它做得规范**。
我们的需求与它之间**不存在缺口** ⇒ 提 issue/PR 大概率被"已经支持"打回，且显得没读代码。

### 8.3 决定：**不提**（并记录理由，避免以后重复动念）

- 不是姿态问题，是**没有标的**：它不需要为我们做任何事 —— 这正是 §7.3 结论成立的技术底气。
- 唯一还站得住的候选是"把只读 JSON 接口文档化"（`/summary` 等字段稳定性承诺）。
  但那是**第三方消费它的 UI 数据**的诉求，不是它的职责；价值低，不值得为它去打扰作者。
- **保留的可提窗口**：若将来发现**真缺口**（例如它的 provider 卡片在模型页被编辑后、写入进了 entry config
  而它自己只读 `~/.dsh/our-free-model/settings.json`，两边不一致），那才值得报 —— 但必须先在 miasaki 实机复现，
  不能靠推断。

### 8.4 意外收获：官方 `settings.models.provider-card` 是可用的（比改它页面更好）

核查时发现一条**官方机制内**的路，比"改它的设置页"更合规也更就手：

- 官方模型页渲染**每张 provider 卡片**时 dispatch `settings.models.provider-card`，**key = 该卡片的 `settingsNs`**
  （`dsh-client-ui-settings-models/lib/client.js:2392, 2457, 2561`；契约 `slot-contract.d.ts:30-34`）。
- Our Free Model 的卡片 key 就是它的 loader entry id：**`our-free-model`**。
- ⇒ 我们可以在**它自己的 provider 卡片下**挂「扫描这个提供方的免费模型」——
  **官方插槽、零改第三方、不触它的任何承诺**，而且正好落在用户看模型的地方。
- 我们的插件注册这个 keyed 槽时 key 是开放的（`keyDomain: "open: any string"`），另一个插件的存在与否都不影响注册。

这条已作为 **M2 的可选增强**写入 §5.1。

### 8.5 假如将来真要提（模板纪律）

| 项 | 约定 |
|---|---|
| 先 issue 后 PR | issue 讲场景 + 可复现步骤 + 建议方案；**先确认它不是"已经支持"**（本轮教训） |
| 低姿态 | 明确写"**不接受完全没问题，我们已有替代路径**" |
| 边界 | 只动 host 侧（+ README 一节）；**不动 UI、不动它的"单一上游"任何表述**；默认零行为变化 |
| 不催、不重复 | 不设等待期限、不开工依赖它；被拒后不再就同一诉求开第二个 issue |

### 8.6 无论何时都不提的

- ❌ 支持用户追加来源 / 多上游聚合 —— 触它的产品叙事，且那是它的产品决策，不该由我们提。
- ❌ 在它的设置页里开扩展点 —— 它的页面整页自绘（§7.2）；官方 `settings.models.provider-card`（§8.4）已经给了合规的等价位置。
- ❌ 任何要求它读取我们插件、或依赖我们存在的东西。

**与我们自己的关系**：M0–M3 全部在本仓、**不依赖上游任何回应** —— 这正是"不接受就算了，专心搞我们自己的"的技术含义。

---


## 9. 执行计划变更：新起一条线「多来源免费模型聚合器」（2026-09-28 三轮，用户定）

> 用户：「我们自己起一条多来源免费模型聚合器新线吧怎么样」
> 结论：**赞成 —— 而且这是本仓既有演进模式的直接延续。**
> 本章**取代 §5 / §5.1** 作为最终执行计划；§5 保留为"若不迁线"的对照版本。

### 9.1 为什么新线是对的

| 判断 | 依据 |
|---|---|
| **职责对** | 现在的"免费模型池"是 desktop 线里的一个插件，但它做的事（模型发现 / 画像 / 显式写入）**与桌面壳毫无关系**。**本仓已有同构先例**：用量统计 2026-09-26 从 desktop 线迁出、独立成第八线（理由同样是"职责不属于桌面端"） |
| **名字对** | "池"= 扫自配平台；"聚合器"= 多来源（含免 Key 车道）。Our Free Model 这一来源，只有在"聚合器"语义下才装得下 |
| **边界对** | 新线只吃官方 `llm` 契约（`listProviders` / `listModels` / `resolveModelInfo`）⇒ §7.2（进不去别人页面）、§7.2.1（产品承诺冲突）、§8（提 issue 没标的）三处争论在新线下**全部不存在**，因为它们不再是问题 |
| **可验证** | 新线有自己的 README / `design/` / CHANGELOG / 测试 / `verify-all` 类别 —— 符合仓库纪律（八线零耦合、各居其位） |

### 9.2 命名（待用户确认）

| 项 | 建议 | 理由 |
|---|---|---|
| 线目录 | `dsh-miasaki-free-model/` | 与 `dsh-miasaki-usage/` 同构（线名 = 关注点） |
| 包名 | **二选一**：① 保持 `dsh-free-model-pool`（迁移面最小，完全照 usage 先例）② 改 `@miasaki/dsh-free-model`（名实相符，本体要动 profile 依赖键） | 本次是**职责升级**而非单纯搬家，我倾向 ②；① 更稳、有先例 |
| 槽 id / label | `free-model` / 「免费模型」 | 现在是 `free-model-pool` / 「免费模型池」 |
| 路由前缀 | `/freepool-api/*` → `/freemodel-api/*`（若改名则一并做） | 一次性做干净，免得以后再动 client + tests + 文档 |
| 版本 | 0.3.1 → 0.4.0 | 迁线 + 能力升级 |

### 9.3 迁移清单（照 usage 线先例，可勾选）

**A. 代码与目录**

1. `git mv dsh-miasaki-desktop/plugins/dsh-free-model-pool/ dsh-miasaki-free-model/`（保留重命名历史；usage 先例是 9 文件全部识别为 `R`）
2. desktop 线插件数 5 → 4；`dsh-miasaki-desktop/README.md` 的池章节改为「**已迁出**」提示（并指向新线）
3. `dsh-miasaki-desktop/design/CHANGELOG.md` 记录迁出；`design/free-model-pool-*.md` 之类文档随迁（原路径留转发页，防历史引用断链 —— usage 先例做法）

**B. 仓库级闸门（漏一个就红）**

4. `scripts/verify-all.mjs`：`LINES` 数组加 `free-model`；desktop 类里那 3 项（`syntax lib/index.js`、`syntax lib/client.js`、2 个 test @ `:403-418`）迁到新类别并改路径
5. `scripts/silent-guard-baseline.json`：`dsh-miasaki-desktop/plugins/dsh-free-model-pool/lib/index.js|R1|...`（`:60-62`）这条路径必须同步，否则 `repo/silent-guards` 闸门直接失败
6. 根 `README.md`：八线表 → 九线；`<!-- version-ledger -->` 用 `node scripts/check-doc-versions.mjs --update` 同步
7. `dsh-miasaki-shared-docs/cross/smoke-test-matrix.md`：§0 / §2 的类别与总数、§3 实机判据同步

**C. 运行环境**

8. `~/.dsh/profiles/{miasaki,web}/package.json`：`dependencies` 的 `file:` 路径（若改名则连键一起改）+ `dsh.profile.bundles` 项
9. profile 目录 `pnpm install` 后**核对 `node_modules` 里的文件哈希**（pnpm file: store 会滞后，desktop README 有明确提醒）
10. 装法 `file:` → `link:`（usage 先例；消除副本漂移 —— 本机 miasaki / web 都适用）

### 9.4 里程碑（取代 §5.1）

| 期 | 内容 | 验收判据 |
|---|---|---|
| **M0** | **迁线**（A/B/C 三组清单）+ **顺手补信任围栏**（新增 `lib/trust.js`、`registerRoute` 先跑围栏、≥6 例单测）—— 迁线本来就要动 `index.js`，合并做省一次往返 | `verify-all` 新类别全绿；异源 Origin 403 / 跨站 `sec-fetch-site` 403 |
| **M1** | **扫描面升级**：`ctx.get('llm')`（不进 inject）+ `listProviders × listModels × resolveModelInfo`；免费判定加 **L0**（provider id/name 命中 `/free/i`，**不硬编码**）；新增 `POST /freemodel-api/scan`；逐来源错误进 `partial[]` | 单测 5 类（枚举/去重、L0+L1、llm 缺席降级、单 provider 隔离、resolve 抛错回落）；**miasaki 实机看到 `our-free-model` 的 11 个模型** |
| **M2** | **统一页**：`settings.section` id `free-model`（三区：①免 Key 车道 ②自配平台 ③决策摘要）+ 官方 keyed 槽 `settings.models.provider-card` 就地扫描入口（key = 各 provider 的 `settingsNs`） | 实机：设置里「免费模型」栏三区正确；Our Free Model 的 provider 卡片下出现扫描入口；ORM 那一栏不受影响 |
| **M3** | **动作统一**：实测接 `/model-probe-api/probe`；默认模型走 `agentDefaultModel.saveSelection`；子代理指派先核实官方写路径 | 实机点击逐项；设置系统能读到新默认模型 |
| **M4** | **收尾**：新线 `README.md` + `design/CHANGELOG.md` 首建；根 README / 台账 / 回归矩阵同步；记录新的全量基线 | `node scripts/verify-all.mjs` 全量通过并记录项数 |

### 9.5 与 Our Free Model 的关系（一句话）

**只读、只走官方契约、零改动、零配合、零 issue。**
新线把它当作"**llm 服务里的一条 provider 路由**"对待，与对待 `llm-pi-ai` 的任一平台**完全同构** ——
这正是"聚合器"该有的姿态。

---

## 附：本次调研的验证命令

```powershell
# ORM 安装形态（junction）
Get-Item "$env:USERPROFILE\.dsh\profiles\miasaki\node_modules\dsh-our-free-model" -Force | Select-Object LinkType,Target
# ORM 上游仓库（shallow）
git -C _refs/upstream-git log -1 --format='%H %ad %s' --date=iso; git -C _refs/upstream-git remote -v
# 运行时插槽与 llm 契约
#   cordis_inspect_list → client/Slots.listSubTree(root='settings.section' | 'settings.models.footer')
#   cordis_inspect_query → host/Service.listService(service='llm' | 'agentDefaultModel')
```
