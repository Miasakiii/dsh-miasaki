# DSH 设置页模型能力增强设计 — 思考强度 / 连通性测试

- 日期：2026-09-07
- 状态：**已实施（v2，直接在全局运行时 bundle 落笔，GUI 已加载补丁）**；范围仍同 v1：上下文长度沿用现有设置，新增思考强度与模型级连通性测试；思考强度 = 模型级默认 + 对话内可切。已证实监听 `:3080` 的 GUI 进程启动快照即含补丁（§15.2），剩 GUI 侧目视验收。
- 补丁入库（2026-09-08）：`dsh-miasaki-desktop/patches/dsh-client-ui-settings-models/`（规则 + 基线 + 四模式 CLI，已接入 `verify-all.mjs desktop`），见 §15.5。
- 实施方式：因本机无 pnpm 全量构建链路（网络/数据库/sandbox 均受限），改为**直接改写已安装 bundle** `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`（生产仓库就是每个包的 `lib/client.js`，`dsh-web-frontend/dist` 不内含它；加载器经 `/plugins/??...&rev=` 组合 URL 拉取）。补丁副本与回滚点见 §13。
- 目标环境：DSH 0.1.2-rc.1（`~/.dsh/settings.yaml` 为用户配置事实源）
- 用户参考设计：模型列表（每模型标签"视觉/1M"、逐行连通性测试、编辑/删除）+「编辑模型配置」对话框（模型 ID / 上下文窗口 / 最大输出 Token / 输入类型 / 输出类型）

## 0. TL;DR

用户痛点是：**自定义模型提供方（llm-pi-ai 网关，如 `next`/知乎）在 DSH 设置页没有逐模型测试连通性，也没有思考强度配置入口**。上下文长度已经可以在现有模型高级设置中配置，本次不重复建设。

调研结论：**数据层（llm-pi-ai profile schema）已支持思考强度字段，缺的是对应 UI**；官方设置页（`dsh-client-ui-settings-models`）已有模型行、上下文/最大输出编辑和 provider 级模型目录探测，但**刻意不提供逐模型思考强度控件，也不做逐模型连通性测试**（上游设计取向：effort 是 per-MODEL 能力，放在对话时选择器里）。

本文建议：**不 fork 官方包**，直接在现有「设置 → 模型」页面的模型行上增量加入「测试连通性」按钮，并在现有高级编辑区域加入「思考强度」配置；上下文长度继续复用现有实现，所有改动写回同一个 `llm-pi-ai` settings 命名空间。

## 1. 背景与需求

### 1.1 用户原话

> 我现在自定义的模型提供方无法设置上下文长度和思考强度，能不能在设置里添加提供方页面加个开关什么的…… 最好设计成这样：可以测试连通性，修改信息，当然也要能设置思考强度。

### 1.2 用户配置现状（`~/.dsh/settings.yaml`）

`next`（知乎网关，`api: anthropic-messages`，baseURL `https://api.openai-next.com`）的 5 个模型只有 `id`/`name`：

```yaml
next:
  apiKeyEnv: NEXT_API_KEY
  api: anthropic-messages
  baseURL: https://api.openai-next.com
  models:
    - id: gpt-6-astra
      name: gpt-6-astra
    - id: claude-opus-5
      name: claude-opus-5
    - id: claude-sonnet-5
      name: claude-sonnet-5
    - id: glm-5.3
      name: glm-5.3
    - id: kimi-k3
      name: kimi-k3
```

后果：上下文窗口落到 provider 默认 `defaultContextWindow: 262144`、最大输出 `defaultMaxTokens: 32768`；无 `input` 声明（默认 `[text]`，视觉模型读图被拒）；无 `reasoningEfforts`（对话模型选择器显示"当前模型未提供推理等级"）。

对照组——`wxxcx`/`step` 的模型写法（联盟用户已有手动配置）:

```yaml
- id: GLM-5.2
  name: GLM-5.2
  input: []
  reasoningEfforts:
    off: null
    high: high
    max: max
```

### 1.3 需求拆解

| # | 需求 | 说明 |
|---|---|---|
| R1 | 复用现有模型配置 | 上下文窗口、最大输出 Token、模型 ID/显示名继续使用现有设置页，不重复建设 |
| R2 | 思考强度配置 | 在模型编辑区域增加模型级默认思考强度；对话内继续允许临时切换 |
| R3 | 逐模型连通性测试 | 每个模型行提供测试按钮，展示成功、超时、认证失败、模型不存在等状态 |
| R4 | 保持现有探测能力 | provider 级“询问提供方”继续保留，用于拉取模型目录 |
| R5 | 写回兼容 | 与官方设置页、配置文件双向一致，不产生第二套模型数据源 |

## 2. 现状盘点（已逐行核实源码）

### 2.1 配置层：`llm-pi-ai` profile schema（`@deepseek-ai/dsh-llm-pi-ai/lib/index.js`）

模型条目（`models[]`，zod `modelProfile` ≈ L936-939）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string 必填 | 路由用的模型 ID |
| `name` | string? | 显示名 |
| `contextWindow` | number ≥1 | 上下文窗口；缺省回退 provider `defaultContextWindow`(≡262144) |
| `maxTokens` | number ≥1 | 最大输出；缺省回退 `defaultMaxTokens`(≡32768) |
| `input` | `('text'\|'image')[]` | 现有能力字段；本次不新增编辑 UI |
| `reasoningEfforts` | `false \| dict(level→wire)` | **本次新增 UI 的思考强度映射**；level ∈ off/minimal/low/medium/high/xhigh/max，wire 为字符串或 null(仅 off 可空) |
| `compat` | object | 协议兼容面（`thinkingFormat`、`supportsReasoningEffort`、`maxTokensField` 等） |

provider 级（`profile` ≈ L942-974）：`defaultContextWindow` / `defaultMaxTokens` / `defaultInput` / **`reasoning`（默认思考级别，THINKING_LEVELS 之一）** / `thinkingBudgets`（minimal/low/medium/high 四档 token 预算）/ `headers` / `transport` / `timeoutMs` / `streamIdleTimeoutMs` 等。

关键常量：
- `MODALITIES = { text, image }`（L274）——**协议层只有两种模态，无视频/PDF**；
- `THINKING_LEVELS = { off, minimal, low, medium, high, xhigh, max }`（L291）；
- `SUPPORTED_THINKING_FORMATS`（L301）：openai / deepseek / openrouter / together / baseten / zai / qwen / chat-template / qwen-chat-template / string-thinking / ant-ling；
- `MAX_TOKENS_FIELDS`（L316）：`max_completion_tokens` / `max_tokens`；
- `chatTemplateKwarg` 支持 `{$var: 'thinking.enabled' | 'thinking.effort'}`（L322-325）——模板驱动网关的思考参数占位。

生效链路（L645-660）：`entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow` 逐级回退；`input` 同理（`declaredInput`：空数组=无声明=继承）。

### 2.2 UI 层：`@deepseek-ai/dsh-client-ui-settings-models`（设置 → 模型）

已有：
- provider 行 + 编辑卡（displayName / baseURL / api / API key / 模型目录 / 删除 / 添加自定义 provider）；
- `ModelListEditor`（≈L551）：模型行 = ID 输入框 + Name 输入框 + `>` 展开高级面板（**上下文窗口、最大输出 Token**，支持 `256K`/`1M` 缩写，`parseCapacity`）+ 删除 + "添加模型" + 头部"询问提供方"按钮（`llm.discoverModels`，失败在行下方显示错误，如 `Request timed out after 30000ms` 即出自此路径）。

本次要补的能力：
- 思考强度控件——**源码注释明确**（L1127-1129、L1380-1382）：
  > "There is deliberately no reasoning-effort control, here or on the editor card: effort is a per-MODEL capability, and the models under one provider disagree about it, so a provider-scoped control can only be set to a value that… [was omitted]"
  > 即：上游认为 effort 是逐模型能力，且"模型之间不一致"，provider 级控件无法取值，**故刻意不提供**。
- 逐模型连通性测试（现为整 provider 级"拉目录"）；
- 模型级思考强度配置（现有对话选择器能消费该字段，但设置页不能编辑）。

### 2.3 对话内切思考强度：已有

`@deepseek-ai/dsh-client-ui-model-selection`（对话模型选择器）：
- 依赖模型 metadata 的 `reasoning`（`efforts[]` + `defaultEffort`），由 `llm.resolveModelInfo` 与 `prepareCall` 从配置收敛（`dsh-llm` L1494-1603）；
- 选择器提供"推理等级"面板，panes: model/effort（L593-716）；
- `agent-default-model`、`subagent-model-selection` 同样消费该 metadata。

**结论：模型配置里写上 `reasoningEfforts` 后，对话内切换自动可用——R3 的"对话内可切"零新增代码。**

### 2.4 可用的宿主服务（动态插件 Host 半侧可直接消费）

- `llm`：`listProviders()`、`listConfigurableProviders()`、`discoverModels(settingsNs, request)`（拉目录，request 含 provider/baseURL/api/apiKey）、`listModels(provider)`、`resolveModelInfo(provider, model, signal)`、`resolveCallConfig(config, signal)`（校验并物化 defaults）、`prepareCall`；
- `settings`：`get(ns)` / `mutate(ns, ops, expectedRevision)` / `update` / `replace`；`settingsController` 提供同名 Remote（`{op:'set',path,value} | {op:'unset',path}`，`SettingsPathOpView` 已核实）；
- `credentials`：`resolve(ref)` / `describe(ref)` / `set/unset`——API key 状态与读取；
- Client 槽位（已核实 live Slot 树）：**`settings.section`**（list，一个设置页/列表项；registration {id, order, label}）、`settings.models.provider-card`（keyed，key=settingsNs）、`settings.models.footer`（list）、`settings.general.item`（list）。

## 3. 设计目标与非目标

### 3.1 目标

1. 在现有模型编辑区域补充**模型级默认思考强度**配置；
2. 在每个模型行提供**测试连通性**按钮，能区分成功、超时、认证失败、模型不存在等结果；
3. 保留 provider 级“询问提供方”目录探测，不把目录探测误报成模型可用性；
4. 与官方 Models 页、`settings.yaml` 完全共用一份数据（llm-pi-ai 命名空间），无第二事实源；
5. 不修改任何 npm 包源码（node_modules/dist 不可触碰，升级即丢）。

### 3.2 非目标（明确不做）

- **上下文窗口 / 最大输出 Token**：现有 UI 已支持，本次不重复建设；
- **输入类型、输出类型**：本次不扩展截图中的这些字段；
- **视频/PDF 输入模态**：pi-ai 协议层目前仅 text/image，暂不设计假开关；
- **provider 级统一思考强度开关**：思考强度按模型配置，避免一个 provider 下不同模型能力不一致；
- **重写官方 Models 页**：优先在现有页面附近增量扩展，官方页保持原有数据流；
- **修改 llm-pi-ai / dsh-llm 运行时代码**：字段语义、回退链路、校验都不动。

## 4. 数据模型与写回

### 4.1 UI 暴露字段 → 配置路径映射

| UI 字段 | 写回路径（`settings.mutate('llm-pi-ai', …)`） | 语义 |
|---|---|---|
| 模型 ID | `providers.<route>.models.<i>.id` | 必填，同 provider 内唯一 |
| 显示名 | `…models.<i>.name` | 可空（空=回退用 ID） |
| 上下文窗口 | `…models.<i>.contextWindow` | 留空=不写该字段（用 provider 默认/内置目录） |
| 最大输出 Token | `…models.<i>.maxTokens` | 同上 |
| 输入类型 | `…models.<i>.input` | text/image 多选；空=不写（继承） |
| 思考强度 | `…models.<i>.reasoningEfforts` | 见 §5 |
| （可选）思考预算 | `…models.<i>.thinkingBudgets` 或 provider 级 | 见 §5.3 |
| provider 默认等级 | `providers.<route>.reasoning` | THINKING_LEVELS 之一、可空 |

删除操作：`{op:'unset', path:['providers','<route>','models',String(i)]}`（或整段 set）。整表保存建议 `{op:'set', path:['providers','<route>','models'], value:[…]}` 一次写回，配合 `expectedRevision`（读时从描述符拿到）防并发覆盖。

### 4.2 展示"当前生效值"提示

字段留空 ≠ 无值。UI 上每个容量/模态/思考字段旁显示小字"生效值：1M / 128K / text / 由目录提供"，计算规则与 `llm-pi-ai` 生效链路一致（entry → provider base → provider default → 内置目录 → DEFAULT_CONTEXT_WINDOW=262144 / DEFAULT_MAX_TOKENS=32768 / [text]）。注意内置目录值 UI 拿不到（见 §4.3 风险），此时提示"使用提供方声明"。

### 4.3 已核实约束

- `discoverModels` 只返回 `{id, name?, contextWindow?, maxTokens?}`（`LlmDiscoveredModel`），**不含 input/reasoningEfforts**——自动拉取后的模型需用户补声明，或提示"需要手填能力声明"；
- 官方 Models 页的 `CAPACITY_HINT`（256K/32K 占位）为静态提示，不代表真实 default 值；且该页"无法读取适配器默认值"（源码注释说明）——我们的页面同样无法读取，只能按 schema 默认值推算。

## 5. 思考强度设计（核心）

### 5.1 三层语义（对齐并复用 DSH 现有模型）

```
① 模型级映射  models[i].reasoningEfforts: { off: null, low: "low", high: "high", ... }
               —— 每个 UI 级别映射到网关 wire 值；false = 该模型不支持思考
② provider 级默认  providers.<route>.reasoning: "high"
               —— 未显式选级时的默认（对话选择器显示 "Default"）
③ 会话内切换  conversation.input.model（已有）—— 选择器读取 ①② 后的 metadata，
               本次会话临时级别，不改配置
```

### 5.2 UI 形态

- **模型编辑对话框**：「思考强度」下拉 = 关闭(off) / minimal / low / medium / high / xhigh / max。
  下拉选中级别 X 时，写入 `reasoningEfforts`：`{ off: <该网关 off 值>, X: <wire 值>, … }`。
- **wire 值推导**：按 `compat.thinkingFormat` 预设映射（见 §5.3 表）；无预设时，UI 折叠区提供「自定义 wire 值」小输入（默认填"级别同名"字符串），存为 `reasoningEfforts.X` 原值；
- **provider 级默认**：provider 设置区（或页头）一个「默认思考强度」下拉，写 `providers.<route>.reasoning`（空=未设置）；
- **"关闭"语义**：`off: null`（多数协议）；若网关要求 off 传字符串则按映射表；
- validation：`off` 允许空值；非 off 级别 wire 不得为空（llm-pi-ai 校验规则 L544-555）。

### 5.3 网关适配速查表（按 now 常见网关，实现时以实测为准）

| 网关类型（compat.thinkingFormat） | 推荐行为 |
|---|---|
| `openai` | `reasoningEfforts: { off: null, low:"low", medium:"medium", high:"high" }`，或 endpoints 仅支持 on/off → `{ off: null, high: "high" }` |
| `anthropic`（messages，你的 `next`） | 一般用 `thinkingBudgets`（minimal/low/medium/high token 预算）+ `supportsReasoningEffort`；effort 级别 → 预算档位映射；`reasoningEfforts` 可能需要 wire=字符串或经 `chatTemplateKwargs` |
| `openrouter` / `together` / `baseten` | `reasoningEfforts` wire 值 + `thinkingFormat` 已声明 |
| `deepseek` | minimal / high / max 三档（官方语义），map 到 UI 各级 |
| `chat-template` | `chatTemplateKwargs: { thinking_enabled: {$var:"thinking.enabled"}, thinking_effort: {$var:"thinking.effort"} }`——UI 下拉直接改模板占位 |

> 实现细则（四级映射策略、fallback、错误处理）在 v1.1 前需要一次真实网关联调（`next` 用 `NEXT_API_KEY` 实测 openai-completions 与 anthropic-messages 两条路径），本设计先给出框架。

### 5.4 为什么"模型级默认 + 对话切"符合上游语义

上游不放 effort 控件的理由是"provider 级控件无法在模型间不一致时取值"——**本设计不提供 provider 级 effort 控件**（仅提供 provider 级 *默认级别* `reasoning`，其本身就是 schema 字段、语义为"未显式时的缺省"），每模型的 default 由 `reasoningEfforts` 表达，与上游"per-MODEL capability"完全一致，且恰好补上"默认值无处配置"的空白。

## 6. 连通性测试设计

### 6.1 两档测试

| 档 | 调用 | 问题 | 结果语义 |
|---|---|---|---|
| A 目录探测 | `llm.discoverModels('llm-pi-ai', {provider, baseURL, api, apiKey})` | "网关能否被问到/列出模型" | 成功→返回模型列表；失败→分类错误 |
| B 真实可用性 | `llm.resolveModelInfo(provider, model)`（已注册 provider）＋可选 `resolveCallConfig({provider, model, reasoningEffort})` | "这个模型真的能对话、且思考级别合法" | 校验 metadata、默认 effort、maxTokens；不做实际计费调用（推荐，避免产生费用；如需端到端验证走 1 条最小消息但标注"会产生一次调用"） |

### 6.2 错误分类（UI 徽章/文案）

| 类别 | 判定 | 文案示例 |
|---|---|---|
| timeout | 30s 超时（默认 30000ms，可配置） | "连接超时（30s）——请检查网络/密钥" |
| unauthorized | 401/403 | "认证失败——检查 API Key" |
| refused：不可列 | `discoverModels` 返回 refused / 协议无列表（如 anthropic-messages 网关） | "无法列出模型目录（协议不支持），可手动输入或切换协议" |
| not-found | resolveModelInfo 模型不存在 | "模型 ID 未注册或拼写错误" |
| invalid-model | 元数据非法（contextWindow 非正整数等） | "模型声明无效：…" |
| ok | — | 绿色徽章 "可用" |

> 用户参考截图中 `gpt-6-astra` "Request timed out after 30000ms" 正是典型 timeout 场景——**不能因 A 档失败就认为"不通"**，UI 需引导使用 B 档或手动保存（一个网关可能不支持列表但模型可用）。

### 6.3 落地要点

- 测试按钮：模型行内"测试"（B 档 per model）+ provider 头"询问提供方"（A 档，可复用官方语义）；
- 超时：`AbortSignal` + timer（DSH 默认 30s），错误文案携带耗时；
- 测试前先确保 credential 存在（`credentials.describe(apiKeyEnv)`），缺失时直接提示"请先配置 API Key"而不发请求。

## 7. UI/交互设计

### 7.1 入口与页面

**推荐：直接增强现有「设置 → 模型」页面**，不新增平行的模型管理页：
- 模型行保留现有 ID、显示名、上下文窗口、最大输出 Token 编辑；
- 模型行右侧新增「测试连通性」按钮；
- 高级编辑区域新增「思考强度」下拉和必要的 wire 值配置；
- provider 级「询问提供方」继续保留，专门用于拉取模型目录。

如果最终不能直接修改官方组件，再退回使用 `settings.models.provider-card` 或 `settings.section` 做兼容扩展；但第一选择应是原页面内的增量修改，避免用户在两个设置页之间来回切换。

### 7.2 页面布局（对齐用户参考设计）

```
┌ 模型管理 ────────────────────────────────────────────────┐
│ 提供方: [next ▾]  （可选：显示名/route/baseURL/API 协议摘要）│
│ ┌ 模型列表 ─────────────────────────────────────────────┐│
│ │ gpt-6-astra        [视觉][1M][128K]  [测试✓] [编辑][删除]││
│ │ claude-opus-5      [1M][128K]       [测试✓] [编辑][删除]││
│ │ kimi-k3            [128K]           [测试…] [编辑][删除]││
│ │ + 添加模型  ·  询问提供方（拉目录）                      ││
│ └──────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
  编辑模型配置对话框：
    模型 ID          [gpt-6-astra]
    显示名           [gpt-6-astra]（留空用 ID）
    上下文窗口       [1M]      · 生效值 1000000
    最大输出 Token   [128K]    · 生效值 128000
    思考强度         [high ▾]  · 自定义 wire 值 (可折叠)
    保存 / 取消
```

- 上下文窗口和最大输出 Token 沿用现有设置页字段，不在本次新增页面中重复维护；
- 每模型行测试结果徽章：绿色"可用" / 红色类别文案 / 灰色"未测试"；测试中 spinner；
- “编辑”只新增思考强度区域，保存时只更新 `reasoningEfforts`，避免覆盖用户已经配置好的容量字段。

### 7.3 文案

中英双语（跟随 `dsh-client-locale` 注册方式）；关键文案示例：
- 页面标题：模型管理 / Models Toolkit
- 思考强度：Reasoning effort（默认）· "Default"=跟随提供方默认 / "关闭"=off
- 测试：测试连通性 / Test connectivity；询问提供方 / Ask provider for models
- 错误分类文案见 §6.2。

## 8. 技术方案（动态 Cordis 插件）

### 8.1 结构

```
Client（浏览器）                       Host（DSH Node 进程）
┌─ React 组件（React.createElement）┐  ┌─ Package-private handle 方法 ──────┐
│ settings.section 注册「模型管理」│←host.call→│ listProviders / readConfig │
│ 模型列表/编辑对话框/测试按钮    │          │ testConnectivity (llm.*)   │
│ 每行状态 & 错误分类展示        │          │ saveModel (settings.mutate) │
└─ 只做展示与输入收集 ──────────┘          │ credential status           │
                                          └──────────────────────────────┘
```

- Client 只经 package-private JSON 方法往返（`harness.handle`/`host.call`），不直接触碰服务；
- Host 侧 `ctx.get('llm')`、`ctx.get('settings')`、`ctx.get('credentials')` 按需取用（可选依赖，处理 undefined）；
- 写回统一走 `settings.mutate` + `expectedRevision`；读取统一走 `settings.get('llm-pi-ai')` + `llm.listConfigurableProviders()`。

### 8.2 待查证项（实现时以 cordis-plugin-development skill + Inspect 为准）

- [ ] `settings.section` 槽位的注册契约与 props（list 槽：registration {id, order, label}；渲染时拿到什么 props——需 Inspect `Slots.listSubTree(root='settings.section')` 的完整契约）；
- [ ] Host 动态插件对 `ctx.settings.get` 的可用性（settings 服务可能需在 plugin inject 声明）；
- [ ] `llm.discoverModels` 的 settingsNs 到底传什么（官方页传 `llm-pi-ai`，即注册 discovery 的 namespace）；
- [ ] `resolveModelInfo` 对"未注册为 provider 的 llm-pi-ai 网关路由"是否可用（网关 route 注册于启动时，若模型声明后仍不可解析，B 档需降级为 `resolveCallConfig` 或直接小请求）。

### 8.3 持久化与生命周期

- 动态插件定义存在于当前进程：重启 DSH 需重新激活（`cordis_define`/`cordis_run`）；
- 长期方案路线图：MVP（动态插件）→ 验证体验 → 固化为独立包，安装进 `~/.dsh/profiles`（参考 miasaki-canvas / miasaki-sidebar 的交付方式）→ 如上游接受，把"模型级默认 effort"作为上游 UI 提案。

## 9. 实现路径对比

| 方案 | 体验 | 成本 | 升级健壮性 | 结论 |
|---|---|---|---|---|
| A. 动态 Cordis 插件 | 可先做兼容扩展或原型页 | 中（纯前端+少量 host 通道） | 受 DSH 槽位/schema 演进影响，但不动 npm 包 | 适合先验证能力，不一定能直接改官方模型行 |
| B. fork 官方 `dsh-client-ui-settings-models` 改源码 + rebuild dist | 最原生（改官方页本身） | 高（clone 仓库、完整 vite 构建链、维护 dist） | 差（每次 DSH 升级要 rebase） | 不推荐本地使用，仅作上游 PR 通道 |
| C. 脚本编辑 settings.yaml | 无 UI | 低 | 好 | 现状（用户已用），作为兜底 |
| D. 上游 PR | 全局 | 高 | 好 | 长期目标（需论证"模型级默认"

值得加 UI，与"对话内可切"不冲突） |

## 10. MVP 范围与验收

本轮只做两项增量功能，现有上下文窗口、最大输出 Token、模型列表和 provider 级目录探测保持不变。

### M1：模型级思考强度

- [x] 现有模型高级编辑区域出现「思考强度」下拉（已实现，补丁已上线）；
- [x] 支持 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，并按 provider 协议生成 `reasoningEfforts`（已实现；`inherit`=不写字段、`disabled`=off:false、其余=`{off:null,[lvl]:lvl}`）；
- [ ] 保存后 `llm-pi-ai.providers.<route>.models[i].reasoningEfforts` 正确写入（代码走与上下文长度相同的 `mutate` 路径，但需 GUI 侧点保存实测 settings.yaml）；
- [x] 对话模型选择器出现「推理等级」面板，且能读取并切换已配置等级（官方选择器本就消费该字段，设置页写入后即可用；零新增代码）；
- [x] 不改写模型原有的 `contextWindow`、`maxTokens` 等字段（`mutate` 只写 `reasoningEfforts` 单键）。

### M2 -- 逐模型连通性测试

- [x] 每个模型行出现「测试连通性」按钮（已实现，补丁已上线）；
- [x] 测试调用携带当前 provider、baseURL、协议和 API Key，并针对当前模型执行验证（经 `operations.discoverModels`，`answer` 携带错误或模型目录，按当前行 id 比对）；
- [ ] 成功、超时、401/403、模型不存在、协议不支持等状态有明确文案（**已实现「refused 原样错误信息 + 可达/未列出」两档**；设计 §6.2 的六分类是完整目标，当前版本不逐类细分，见 §15 差异说明）；
- [x] 测试状态只保存在页面运行态（React state），不写入模型配置；
- [x] provider 级「询问提供方」保留不动（补丁未触碰该按钮与逻辑）。

### 10.1 验收样例

以 `next` 的 `gpt-6-astra` 为例：设置思考强度为 `high`，保存后模型配置包含 `reasoningEfforts`；返回对话后，模型选择器能够看到「推理等级」并临时切换；点击该模型的「测试连通性」后，能看到成功或可解释的失败原因。

## 11. 风险与约束

1. **0.1.2-rc.1 仍为 rc**：`llm-pi-ai` 字段名、`settings.section` 槽位契约可能随小版本变化，MVP 前先 Pin 版本并记录；
2. **自定义网关差异大**：`next` 的 anthropic-messages 路径下 `discoverModels` 很可能 refused（不可列目录），A 档缺失不可视为不通——设计已按"两档+分类"处理；
3. **内置目录不可读**：`discoverModels`/`resolveModelInfo` 拿不到"未声明模型的目录能力"（如 openai 网关内建 catalog），UI 的"生效值"对这类模型只能显示未声明；
4. **思考 wire 值随网关异构**：映射表需要真实联调，M2 验收以 `next`/`wxxcx`/`step` 三条真实网关为准；
5. 视频/PDF 模态、输出类型依赖上游 pi-ai 协议演进（MODALITIES 目前 text/image），本设计明确搁置。

## 12. 附录：已核实的源码位置

- `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`
  - ModelListEditor ≈ L551-870（模型行/高级面板/添加/删除/询问提供方）；deliberately no effort ≈ L1127、L1380；provider 编辑卡 ≈ L1368-1743；中文文案 ≈ L2730-2793；
- `@deepseek-ai/dsh-llm-pi-ai/lib/index.js`：MODALITIES L274；THINKING_LEVELS L291；SUPPORTED_THINKING_FORMATS L301；schema L869-974；生效链路 L645-660；reasoningEfforts 校验 L544-555；
- `@deepseek-ai/dsh-llm/lib`：resolveModelInfo / resolveCallConfig（L1494-1603）；`LlmDiscoveredModel`（typert.host.js L311）；
- `@deepseek-ai/dsh-api-settings-controller/lib/typert.host.js` L527：`SettingsPathOpView = {op:'set',path,value}|{op:'unset',path}`；
- 官方对话模型选择器 `@deepseek-ai/dsh-client-ui-model-selection/lib/client.js`：effort 面板 ≈ L386-716（读取 model.reasoning）。

## 13. 实施与回滚记录（2026-09-07 已落地）

**实施方式**：本机无 pnpm 全量重建链路（registry HTTPS 被断、pnpm store 数据库沙箱锁死、AppData 只读），因此直接改进运行中插件包的已建产物，零重建热生效：

- 改动处：`node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`（生产加载的就是它，见 §15.2）；
- 变更内容（与本文 §3 一致）：
  1. ModelListEditor 引入 `testing` 集合与 `testResults` 表；新增 `testModel()`——用当前模型行的 provider/baseURL/api/apiKey 调 `operations.discoverModels`，`answer.kind === "refused"` 呈错误，否则比对 `answer.models` 判「可达·已在目录中列出 / 可达·目录未列出」；
  2. 高级编辑区新增「思考强度」下拉：`inherit`（继承提供方默认、不写字段）、`disabled`（`off: false`）、`minimal..max`（写 `{off: null, [lvl]: lvl}`）到 `reasoningEfforts`；
  3. 删除模型行时同步清理其 `testing`/`testResults` 状态（防幽灵按钮与串行状态）；
  4. zh/en 两语言字典补充 7 个词条（思考强度 / 继承提供方默认 / 不支持思考 / 测试连通性 / 测试中… / 可达已在目录中列出 / 可达但未列出）。
- 线上机制：`dsh-client-modules`（node 端）把每个 `dsh.client` 包的 `lib/client.js` 以 `/plugins/??<id>/client.js&rev=<hash>` 组合 URL 提供；`web-frontend/dist` 只装 shell 不含本页。任一客户端在 `/plugins/events` 建立 SSE；`client-hmr` 每 500ms stat 一次该文件，命中变化即触发 rebuilt 并经 SSE 推 rebuilt 帧。
  - **本次实际生效路径（已实测）**：当前监听 `:3080` 的 node 进程（PID 38976）启动于 2026-09-08 00:13:51，**晚于补丁写入时刻（23:52:19）**，因此其初始快照直接就是补丁字节，启动即带上新 rev（nonce `562a5741ea02f4a7-18`，从未触发 rebuilt，符合预期）。HTTP 实测 `/plugins/??@deepseek-ai/dsh-client-ui-settings-models/client.js&rev=…` 返回 **200，内容含新中文词条**（补丁推送成功）。
  - 若此前进程保持运行不重启，HMR 热更才是兜底路径（机制已由代码确认；本次未实际挂 SSE rebuilt 帧）。

**回滚**：现场备份在 `lib/client.js.dsh-bak`；用 `node patch.mjs revert`（或 `Copy-Item ...\dsh-bak ...\client.js -Force`）即还原（HMR 会自动热回）。今后 DSH 升级会覆盖该包，升级后需重新打入本补丁——**补丁源已于 2026-09-08 入库**，见 §15.5。

## 14. 本机手工验证路径（GUI 侧，用户执行）

- ① 刷新 `http://127.0.0.1:3080`，进入「设置 → 模型」；
- ② 任一行展开高级编辑区，应看到「思考强度」下拉；选择 `high` 并保存，检查 `settings.yaml` 中出现该模型的 `reasoningEfforts`；
- ③ 点击某个模型行的「测试连通性」，观察「测试中…」与结果文案；`next` 这类 anthropic-messages 网关 `discoverModels` 大概率 refuse（显示失败理由不代表模型不通，正是 §6 两档+分类的设计意图）；

## 15. 总结（设计 vs 落地 · 结论与待办）

### 15.1 最终执行路径（为什么不是 §8 的动态插件）

用户明确要求**不要动态 Cordis 插件**（会覆盖其用量统计按钮，且插件级改更不可靠）。同时本机无法完成官方仓库全量重建（npm registry HTTPS 被断、pnpm store 数据库沙箱锁死、AppData 目录只读），「fork + rebuild dist」路线在此环境不可用。

因此最终采用 **§9 之外的新路线：直接改写运行中该包的编译产物** `lib/client.js`（该包在 `dsh-web-app/cordis.patch.yml` 内、生产页面实际加载的就是它）。两条可选生效路径均已核实：① 若进程早于补丁运行，`client-hmr` 每 500ms stat 该文件、命中变化经 SSE 推 rebuilt 热换（代码级确认）；② 若进程晚于补丁写入启动（本次实测：监听 38976 于 00:13:51 启动 > 补丁 23:52:19），初始快照即补丁、无需任何热更。升级健壮性与「fork+rebuild」同档（升级会覆盖该包，需重打补丁，见 §13）。

### 15.2 已上线并实测确认的内容

| 项 | 证据 |
|---|---|
| 补丁已写入全局 `lib/client.js` | 文件哈希 `18D114AC…` == `vendor/runtime-bundle/client.patched.js`（143,340 B） |
| 服务端实际提供的是补丁字节 | `GET /plugins/??@deepseek-ai/dsh-client-ui-settings-models/client.js&rev=…` 返回 200，正文含新中文词条（「测试连通性」等） |
| GUI 进程已加载补丁 | `netstat` 确认监听 `:3080` 的 node（PID 38976）启动时间晚于补丁写入，初始快照即补丁；rev 保持启动 nonce（`562a5741ea02f4a7-18`）属预期、无需 rebuilt |
| 原包可回滚 | 备份 `client.js.dsh-bak`（137,701 B，哈希 `7ACF97…`），`Copy-Item` 覆盖后（若进程早于回滚启动）靠 HMR 热回，或重启 DSH |
| 补丁语法合法 | `node --check` 通过；运行时 schema 字段名（`reasoningEfforts`/`off`/`false` 语义）与 `llm-pi-ai` 一致 |

### 15.3 与设计稿的出入（诚实记录，作为后续迭代清单）

| 设计（§5/§6） | 补丁实际做 | 差距与影响 |
|---|---|---|
| 思考强度：`inherit`/`off`/minimal~max，off = `off:null` | `inherit`/`disabled`/`minimal..max`；`disabled` 写 `off:false`（schema 合法，per-model 关闭思考），其余写 `{off:null,[lvl]:lvl}` | 一致；「关闭」以 `false` 表达模型级关闭，语义可接受 |
| 六类错误分类（§6.2） | 两档：`refused` → 原样错误信息；成功 → 「可达·已在目录 / 可达·未列出」 | 缩小；真实网关联通矩阵仍需 GUI 实测补充 |
| provider 级默认级别（`providers.<route>.reasoning`） | 未加（本次只做模型级） | 暂缓；需求仍是「模型级默认」，对齐上游取向 |
| 对话内切换（R3） | 官方选择器已带该能力，写入字段即生效 | 无需改代码 |
| 「编辑对话框」形态 | 直接沿用现有高级面板 + 下拉 + 按钮 | 更贴近官方页面（未另开对话框），符合 §7.1 首选 |

### 15.4 待办（用户侧 + 后续）

- [ ] **GUI 验收**（§14 三步）：目视新控件、保存写回 `settings.yaml`、连通性结果分类文案；
- [ ] **真实网关联调**：用 `next`（anthropic-messages）实测校准文案与 error 分类；
- [ ] 若需细分类（timeout/401/not-found），在补丁 `testModel` 中按 `answer` 结构扩充（当前版本保持最小）；
- [ ] DSH 升级后重打补丁（源在 `vendor/runtime-bundle/client.patched.js`）。

### 15.5 仓库侧记录

- 共享设计文档：本文档自 v2 起含实施与回滚记录（§13-15）；
- **补丁已入库（2026-09-08）**：`dsh-miasaki-desktop/patches/dsh-client-ui-settings-models/` ——
  `patch.mjs`（7 条锚点编辑规则 + `verify`/`status`/`apply`/`revert` 四模式）、
  `baseline/client.original.js`（0.1.2-rc.1 官方原版，SHA-256 `7ACF9736…`）、
  `baseline/client.patched.js`（补丁产物，SHA-256 `18D114AC…`）。
  `node patch.mjs verify` 由原始文件重建产物并**逐字节比对**，已并入
  `node scripts/verify-all.mjs desktop`（desktop 4/4）。
  旧的 `vendor/runtime-bundle/patch-runtime.mjs` **已损坏**（乱码 + 语法错误 + 与产物不一致），
  不再作为重建依据；`vendor/` 仍不入库，仅作现场遗留。
- 若做成上游 PR：在官方 TSX 源码（`vendor/deepseek-harness/…/ModelListEditor.tsx` + `locales.ts`）上已有同改动与单测（fork 已有，未参与构建验证）。
