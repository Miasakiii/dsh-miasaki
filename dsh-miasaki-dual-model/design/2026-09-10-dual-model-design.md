# Miasaki 双模型设计（主模型 + 辅助模型）

- 日期：2026-09-10
- 状态：**准入路线已拍板（路线 1：一行本体补丁）**，其余设计待评审；未写代码
- 取证对象：本机 `@deepseek-ai/dsh@0.1.2-rc.1`（全局 npm）实际安装产物
- 性质：第 2 章全部结论来自**逐行读取已安装源码**，均标注文件与行号；无法从源码确证的一律进第 8 章「待验证清单」，不混入结论。

---

## 0. 摘要（先看这四条）

1. **痛点根源已定位到一行代码**：`session.prompt` 在 host 侧按「当前会话模型是否声明支持图片」硬拒整条消息（`dsh-api-session-controller/lib/index.js:745-751`），而客户端**完全不拦**（`canAcceptDrop` 与模型能力无关）。这就是「图片能拖进来、发送才失败」的确切成因。
2. **只放宽准入、不做路由，比现在更糟**：`dsh-llm` 在 dispatch 前会把不受支持的图片**静默替换成一行占位文本**（`[image omitted because this model accepts text only; attachment sha256:…]`），不报错。用户会以为图发出去了，模型只看到一个哈希。**准入放宽与路由必须同版本上线。**
3. **路由机制的落点官方已经趟好**：`agent/request` waterfall 每步可替换 `LlmCallConfig`，官方自己就用它实现每会话模型选择（`dsh-agent/lib/types/model-selection.js`）。逐步换模型会写 durable log 的 `request/header`（`reason: 'change'`），**天然可审计**。
4. **⚠️ 准入是唯一需要碰本体的地方，路线与补丁形态已拍板**：「副驾驶语义」与「零补丁」不可兼得（准入校验是 host 私有、无插件钩子）。选定的补丁形态是**可选服务探测**——未装插件时行为与今天**完全一致（零退化）**，装插件才改变准入。详见 §3.3–§3.4。

---

## 1. 需求

用户诉求原文要点：

- 会话可配置**两个模型**：主模型 + 辅助模型
- **只要其中一个支持图片，就可以上传图片**
- 在**输入框右下角**快速配置

已拍板的方向（2026-09-10）：

| 决策项 | 选择 |
|---|---|
| 辅助模型角色 | **副驾驶**：含图的整步交给辅助模型 |
| 准入路线 | ~~客户端分流、零补丁~~ → **复议为路线 1：一行本体补丁**（§3.3–§3.4） |
| 落地位置 | 新开一条线 `dsh-miasaki-dual-model/` |

---

## 2. 现状取证

### 2.1 三层结构：准入 / 路由 / 配置

需求表面上是一个「上传按钮」，实际是三个必须分开处理的层次。三者**唯一必须共享的是能力真值源**（`llm.resolveModelInfo(provider, model).inputModalities`）——目前它们不一致，于是产生了当前症状。

| 层 | 问题 | 实现位置 |
|---|---|---|
| 准入 | 能不能传 | `dsh-api-session-controller` |
| 路由 | 谁来看图 | `dsh-llm` dispatch + `agent/request` waterfall |
| 配置 | 在哪配、存哪 | `session/selectModel` durable 投影 + `settings` |

### 2.2 准入层：客户端不拦，host 拦

**客户端**（`dsh-client-ui-conversation/lib/client.js:15448`）：

```js
const canAcceptDrop = !locked && !machineBusy && addImages !== void 0;
```

与模型能力**完全无关** —— 图片随便拖入。

**Host**（`dsh-api-session-controller/lib/index.js:745-751`）：

```js
const hasImage = request.content.some((part) => part.type === "image");
if (hasImage) {
  const current = this.agents.selectionFor(agent).current;
  const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model);
  if (model.inputModalities !== void 0 && !model.inputModalities.includes("image"))
    throw new RemoteError("session/attachment-invalid",
      `Model "${current.model}" does not support image input.`,
      { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });
}
```

两个细节必须注意：

- **只有「显式声明了 `inputModalities` 且不含 image」才拦**。未声明（`undefined`）一律放行 —— 这是「unknown ≠ negative capability」的官方口径。
- 校验依据是**提交那一刻**的 `selectionFor(agent).current`。

同构校验还出现在另外四个入口，说明这是系统性策略而非疏漏：

| 入口 | 位置 | 行为 |
|---|---|---|
| 用户消息 | `dsh-api-session-controller/lib/index.js:751` | 拒绝整条消息 |
| `read_image` 工具 | `dsh-tool-fs/lib/index.js:978` | 工具报错（"switch to an image-capable model to read images"） |
| 子代理 | `dsh-subagent/lib/index.js:1470` | 拒绝 |
| MCP / ACP | `dsh-mcp-client/lib/index.js:331`、`dsh-acp/lib/index.js:68` | 拒绝 |

### 2.3 执行层：静默丢图

`dsh-llm/lib/index.js:1684` 在 adapter dispatch 前：

```js
const projectedOptions = modelInfo.inputModalities !== void 0
  && !modelInfo.inputModalities.includes("image")
  && resolvedOptions.messages.some((message) => contentHasImage(message.content))
    ? { ...resolvedOptions, messages: projectImagesForTextModel(resolvedOptions.messages) }
    : resolvedOptions;
```

替换文案（`dsh-llm/lib/types/content.js:47-50`）：

```
[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]
```

**不抛错、不告警、图片内容完全消失。** 这直接决定了：放宽准入必须与路由同版本上线。

注意 `contentHasImage` 会**递归下钻 tool-result 的嵌套内容**（`content.js:88-91`），所以工具返回的图片同样受这条路径影响。

### 2.4 路由层：`agent/request` 是官方认可的路由入口

**事件契约**（Inspect Provider 实时读取）：

```
'agent/request' — waterfall — "Replace the frozen call configuration."
(this: Scoped<Agent>, payload: { agent; turn; step; signal },
 next: () => Promise<LlmCallConfig>) => Promise<LlmCallConfig>
```

```ts
interface LlmCallConfig {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffortId;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}
```

**官方自用先例**（`dsh-agent/lib/types/model-selection.js`，逐行读过）：

```js
export function installModelSelection(agentCtx, selection) {
  // ① 提示词组装时快照模型，并把 provider/model 注入模板变量
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_a, _c, next) => {
    const selected = selection.current;
    const assembled = await next();
    selection.assembled = selected;          // ← 快照
    return { ...assembled, variables: { ...assembled.variables,
      provider: selected.provider, model: selected.model } };
  });
  // ② 请求组装时应用快照
  const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next();
    const selected = selection.assembled;
    if (selected === undefined) return resolved;
    const { reasoningEffort: _inherited, ...rest } = resolved;   // ← 必须清掉继承的 effort
    return { ...rest, provider: selected.provider, model: selected.model,
      ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort } };
  });
  return () => { disposeAssembly(); disposeRequest(); };
}
```

三个可直接照抄的设计要点：

1. **快照语义**：在 prompt 组装时快照，而非请求时读实时值。官方注释原话——"so a concurrent switch takes effect on a later step instead of splitting the two surfaces"。避免提示词与路由用了不同模型。
2. **必须清掉继承的 `reasoningEffort`**：`resolveCallConfig` 对「不支持的努力等级」是硬拒（"reject before provider I/O"），不清会直接报错。
3. **换模型会写 durable log**：`agent-loop/lib/index.js:747` 在 header 变化时 append `request/header`（`reason: 'change'`）。**逐步换模型天然可审计**，轨迹里能看到每步用了哪个模型。

**Scoped 约束**：`dsh-scope/lib/invariant.js:17` 写明 `"agent/request": (args) => args[0]["agent"]` —— 事件按 Agent 分域，监听必须挂在该 agent 的 context 上。`Agent` 接口暴露 `readonly ctx: Context`（`dsh-agent/lib/types/runtime-types.d.ts:75`），所以路径是 `ctx.agents.list()` → `agent.ctx.on('agent/request', …)`。

**同族的另两个可干预点**：

| 事件 | 可改什么 | 适用场景 |
|---|---|---|
| `agent/pre-step` | `messages: UserMessage[]`（进入这一步的消息） | 替换/注入消息内容（仅影响本步请求，不改已落盘 log） |
| `llm/stream` | `GenerateOptions`（含 `provider`/`model`/`messages`） | 最外层兜底路由；官方描述含 "routing" |

### 2.5 配置层：模型选择是 per-session durable 的

```ts
interface ModelSelection { provider: string; model: string; reasoningEffort?: string }
interface ModelSelectionProjectionState { lastUsed: ModelSelection | null; pending: ModelSelection | null }
```

- 每会话选择经 `remote.session.selectModel` 提交，落 **durable log**，投影出 `lastUsed` / `pending`。
- 全局默认由 `agentDefaultModel` 服务拥有（`currentSelection()` / `saveSelection()`）。
- 两个入口（`/model` 弹窗 + composer 座位）**共享同一个 per-session `ModelDirectory`**（`dsh-client-ui-model-selection/lib/types/client/service.ts`）。

**已有「第二模型」官方先例**：`subagentModelSelection`（子代理委派模型）+ `dsh-client-ui-settings-plugins/lib/types/client/subagent-model-selection-card-controller.d.ts`（完整的设置卡片控制器）。这是辅助模型配置最直接的模板。

### 2.6 UI 层：右下角就是 `conversation.input.right`

client Slot 实时树确认：

| slot | kind | scope | replaceRisk | 说明 |
|---|---|---|---|---|
| `conversation.input.right` | list | session | **none** | **"Compact controls before the composer submit action"** ← 目标座位 |
| `conversation.input.model` | single | session | shadows-shipped-ui | 官方模型选择器（主模型） |
| `conversation.input.attachments` | single | session-maybe | shadows-shipped-ui | 草稿图栏 + 拖放目标 |
| `conversation.input.left` | list | session | none | 工具行左侧紧凑控件 |
| `conversation.input.dock` | list | session | none | 输入框上方通栏 |

`conversation.input.right` 的可用 props：`useConversation`、`useChat`、`useInput`、`inputActions`、`useSession`、`sessionId`、`useProjection`、`useTrajectory`。

**`InputActions`（公开行动面，`dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:202`）**：

```ts
interface InputActions {
  setDraft(text: string): void;
  addImages(ids: readonly DraftAttachmentId[]): boolean;   // 只收 draft id，不收 File
  removeImage(id: DraftAttachmentId): void;
  pruneImages(ids: readonly DraftAttachmentId[]): void;
  submit(): void;                                           // "adjudication / claim transaction / default sink inside"
}
```

**一个必须解决的设计缺口**：客户端**拿不到模型能力**。

```ts
interface ModelCatalogModel { id: string; name: string; description?: string; reasoning?: ModelReasoning }
```

**没有 `inputModalities`。** 所以右下角要显示「这个模型支不支持图片」，必须新增一条 host→client 能力查询通道。

**0.1.5-rc.1 兼容性已确认**（见 `../dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.5-rc1-slot-contract-2026-09-10.md` §4.1）：`conversation.input.right` / `.model` / `.attachments` 在 0.1.5 **全部不变**，本设计的 UI 落点无升级风险。

---

## 3. 核心冲突：准入校验无法零补丁绕过 ⚠️

这是开工前必须拍板的一件事。

### 3.1 冲突陈述

**「副驾驶」要求图片以 image block 形式进入那一步的模型请求；而图片以 image block 形式进入 durable log 的唯一正路是 `session.prompt`，这条路被第 2.2 节的校验堵死。**

插件能否在 host 侧旁路？必须同时满足两个条件：

| 条件 | 可行性 |
|---|---|
| 图片进 durable log | ✅ `ctx.attachments.saveImages()` 存图 + `agent.followup(带图消息)`（`Agent` 公开方法，`session.prompt:757-758` 内部用的就是它） |
| 官方提交动作被插件接管 | ❌ 见下 |

### 3.2 已推演排除的路径（避免重复踩坑）

| 路径 | 结论 |
|---|---|
| 用 `agent/pre-step` 把图片塞回消息 | ❌ 只影响本步请求，**不改已落盘 log** → 历史/轨迹看不到原图 |
| 临时把会话模型切到辅助模型再提交 | ❌ `selectForNextRequest` 是 durable 的，会污染用户可见的「当前模型」，且三次 RPC 有时序竞态 |
| 代理 adapter，谎报主模型支持图片 | ❌ `registerAdapter` 对已占用 provider 抛 `DUPLICATE_ADAPTER`，插件无法接管官方路由；且会污染 `read_image` 等全部能力消费者 |
| 提交前用 `inputActions.removeImage()` 摘图 | ❌ 需靠 `InputState.phase` 变化猜测提交时机，React 批处理下有竞态，不可靠 |
| DOM 拦截官方提交按钮 / Enter | ❌ 脆弱，且破坏官方行为 |
| 替换 `conversation.composer`（chain slot） | ⚠️ 技术上可行，但要**重写整个输入框**，代价与维护面远超收益 |

**根因**：`conversation.input.right` 是**加法槽**——只能加控件，不能接管提交。能接管提交的只有 `conversation.composer`。

### 3.3 三条可行路线

| | **路线 1：一行本体补丁** | **路线 2：眼睛模式（零补丁）** | **路线 3：替换 composer** |
|---|---|---|---|
| 做法 | 放宽 `index.js:751` 的判定条件 | 图片不进官方管道；辅助模型只做一次「看图」调用 | 整个 composer 自研 |
| 图片进 durable log | ✅ 完整（原图） | ❌ 原图不进；**描述以 plugin 消息进** | ✅ |
| 主模型保持主导 | ❌ 整步交给辅助模型 | ✅ 工具/人格/上下文全保留 | ❌ |
| 辅助模型负担 | 要扛住一整步（工具调用/窗口/人格） | 只需一次小调用，可用很便宜的模型 | 同路线 1 |
| DSH 升级代价 | 需重打补丁 | **无** | 官方 composer 改动即需跟进 |
| 仓库先例 | desktop 线已有 `patch.mjs` + 基线 + `verify` 自证机制 | 纯插件层 | — |

**路线 2 的实现链路**（零补丁，值得单独说明）：

1. client 替换 `conversation.input.attachments`：图片不进官方 draft，插件自持 bytes + 自渲染缩略图
2. 用户提交纯文本 → `session.prompt` 校验通过 ✅ → 消息正常落 log
3. host 侧辅助模型看图：直接调 `ctx.llm.stream()`（**一次独立调用，不进入 agent turn 结构**）
4. 描述回注主模型：`agent.followup()` 一条 **plugin 来源**的消息（`MessageSourceMap.plugin` + `ContextFormed.form: 'notice'`，官方为插件注入上下文设计的通道）→ **描述进 log ✅**
5. 主模型看到「用户文本 + 图片描述」，正常回答

### 3.4 决策：路线 1 —— 一行本体补丁（2026-09-10 拍板）

选路线 1 的理由：完整「副驾驶」所需的其余部分（能力查询通道、`agent/request` 路由、右下角 UI、设置持久化）**全是纯插件**，只有准入这一处需要碰本体；而仓库已有成熟的补丁自证机制（`dsh-miasaki-desktop/patches/` 的规则 + 基线 + `verify` 离线自证 + 纳入 `verify-all.mjs`），升级重打的代价是已知且可控的。

#### 3.4.1 补丁形态选型

改动点只有一处：`dsh-api-session-controller/lib/index.js:745-751`。三种形态对比过：

| 形态 | 未装插件时的行为 | 评价 |
|---|---|---|
| 直接删掉校验块（3 行） | **退化**：图片被 `projectImagesForTextModel` 静默丢弃 | ❌ 裸 DSH 行为比今天更差 |
| 读插件的 settings 命名空间 | 行为不变 | ⚠️ 本体反向依赖插件的配置键，耦合方向错 |
| **可选服务探测** | **与今天完全一致** | ✅ Cordis 标准惯用法，装/卸都自然 |

**选定：可选服务探测。**

#### 3.4.2 补丁内容

```js
// ── 现状 ───────────────────────────────────────────────
if (hasImage) {
  const current = this.agents.selectionFor(agent).current;
  const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model);
  if (model.inputModalities !== void 0 && !model.inputModalities.includes("image"))
    throw new RemoteError("session/attachment-invalid",
      `Model "${current.model}" does not support image input.`,
      { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });
}

// ── 补丁后 ─────────────────────────────────────────────
if (hasImage) {
  const current = this.agents.selectionFor(agent).current;
  // 可选服务：双模型插件在装了的时候提供；未装 → undefined → 走原逻辑，零退化
  const visionRoute = this.ctx.get("dualModelVisionRoute")?.for(agent);
  if (visionRoute !== undefined) {
    const assist = await this.ctx.llm.resolveModelInfo(visionRoute.provider, visionRoute.model);
    // union 语义：辅助模型声明支持图片即放行（未声明按 unknown 放行，与官方口径一致）
    if (assist.inputModalities !== void 0 && !assist.inputModalities.includes("image"))
      throw new RemoteError("session/attachment-invalid",
        `Neither "${current.model}" nor "${visionRoute.model}" supports image input.`,
        { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });
  } else {
    const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model);
    if (model.inputModalities !== void 0 && !model.inputModalities.includes("image"))
      throw new RemoteError("session/attachment-invalid",
        `Model "${current.model}" does not support image input.`,
        { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });
  }
}
```

#### 3.4.3 补丁的契约面（插件必须遵守）

补丁把本体的准入判定**委托**给插件的一个可选服务，因此插件的义务是：

| 契约 | 内容 |
|---|---|
| 服务名 | `dualModelVisionRoute`（名字即接口，需固定，补丁与插件两侧共用） |
| 方法 | `for(agent: Agent): ModelSelection \| undefined` —— 返回**本会话当前配置的图片执行路由**；未配置返回 `undefined` |
| 义务 1 | 返回非 `undefined` 时，该路由**必须真的能处理图片**——这是补丁放行的唯一依据 |
| 义务 2 | 路由层（`agent/request`）必须保证含图步骤**真的走这个路由**，并在两个模型都不支持时**显式报错**，绝不静默降级 |
| 义务 3 | 服务随插件卸载而消失（`ctx.effect` 管理），卸载后本体回到原逻辑 |

**契约 1 是这套设计的信任根**：补丁信任插件"说能处理就真能处理"。义务 2 是补齐这份信任的执行侧保证——**两者必须同版本上线**，否则会出现"准入放行了、路由没跟上"→ 图片被静默丢弃（§2.3）的失败模式。

#### 3.4.4 补丁的落位

补丁规则与基线按 desktop 线既有惯例放在本线的 `patches/dsh-api-session-controller/`（`patch.mjs` + `baseline/` 原始与产物 + README 写明 DSH 升级后重打流程 + `patch.mjs verify` 离线自证），并纳入 `scripts/verify-all.mjs`。

> ⚠️ 与 desktop 线现有补丁（`patches/dsh-client-ui-settings-models`）作用于**不同的包**，互不冲突，但两者都需在 DSH 升级后重打——建议在升级检查清单里合并成一处。

---

## 4. 架构设计（与路线选择无关的公共部分）

无论第 3 章选哪条，以下四块**完全相同**。

### 4.1 模块划分

```
dsh-miasaki-dual-model/
├─ index.js            # host 半：settings 命名空间 + 能力查询 + 路由 waterfall + 准入适配
├─ client.js           # client 半：右下角控件 + 附件栏接管（视路线）+ 能力缓存
├─ lib/
│  ├─ capability.js    # 图片能力真值源（含缓存与失效）
│  ├─ routing.js       # 路由决策（纯函数，可单测）
│  └─ settings.js      # 配置 schema 与读写
├─ styles.css
├─ test/
├─ cordis.patch.yml    # 载入 profile
└─ design/
```

### 4.2 配置数据模型

```ts
// settings 命名空间：miasaki-dual-model
interface DualModelSettings {
  assist?: ModelSelection;          // 全局默认辅助模型 { provider, model, reasoningEffort? }
  policy: {
    visionRouting: 'auto' | 'assist-first' | 'primary-only';
    stickWithinTurn: boolean;       // 本轮出现图片后粘住辅助模型，避免 prompt cache 抖动（建议 true）
  };
}
```

**作用域建议：全局默认（settings）+ 会话内覆盖（durable log）**。

- 全局默认：仿 `subagentModelSelection` 注册 settings 命名空间 → 新会话开箱可用。
- 会话覆盖：右下角改的是**本会话**的辅助模型，**必须进 durable log**——否则回放 / 轨迹 / 用量统计会把「哪一步是谁跑的」算错。

### 4.3 路由算法（路线 1/3 适用）

```
每步（agent/request waterfall）：
  1. 取本步消息，递归检测是否含 image（用官方同款 contentHasImage 语义，含 tool-result 嵌套）
  2. 若不含图                      → 主模型
  3. 若含图：
     a. 辅助模型已配置且支持图片？
        ├─ 是 → 辅助模型（并按 stickWithinTurn 在本 turn 内粘住）
        └─ 否 → 主模型支持图片？
                ├─ 是 → 主模型
                └─ 否 → 报错（绝不静默丢图）
  4. 切换时务必清空继承的 reasoningEffort（见 §2.4 要点 2）
```

**硬约束清单**（写进实现，逐条对应风险）：

| # | 约束 | 依据 |
|---|---|---|
| 1 | 同 turn 内不来回切（一旦出现图片就粘住到 turn 结束） | 模型反复切换会破坏前缀缓存，成本反升 |
| 2 | 切换时清空 `reasoningEffort` | 否则 `resolveCallConfig` 硬拒 |
| 3 | 路由失败必须显式报错，禁止静默降级 | §2.3 的静默丢图是比报错更糟的失败模式 |
| 4 | 图片能力判定要在 prompt 组装时快照 | 官方 `installModelSelection` 的快照语义 |
| 5 | `read_image` 工具是第二条图片路径 | 不一并处理会产生「用户传图能用、agent 读本地图报错」的割裂 |

### 4.4 能力真值源与失效

- 权威：`llm.resolveModelInfo(provider, model).inputModalities`（host）
- 失效信号：`llm/adapters-updated` 事件（"The provider topology changed"）+ 设置变更。
  设置变更自 2026-09-23 起为**双轨**：`settings/updated`（0.1.5/0.1.6）+ `settings/document-updated`
  （0.1.7+ 的 RAW 文档层事件）—— DSH 0.1.7 移除旧事件后本线无需改动，实现见 `lib/invalidation.js`。
- 客户端需要一条 host→client 查询通道（形态视新线的插件加载方式而定：`host.call` 或同源 JSON 路由）

---

## 5. UI 设计

### 5.1 落点

`conversation.input.right`（**加法槽，replaceRisk none**，位置正是「提交按钮之前的紧凑控件」）。

### 5.2 形态

- **折叠态**：一个紧凑按钮，显示主/辅模型短名（如 `V4 ▸ Flash`），辅助模型未配置时显示单模型态
- **展开态**：轻量面板
  - 主模型选择器（复用官方 `/model` 的目录数据源与 `session.selectModel` 提交路径）
  - 辅助模型选择器
  - 状态行：`图片将交给 ⟨辅助模型名⟩ 处理` / `两个模型都不支持图片` （后者必须明确禁用上传）
- **图片拖入时的反馈**：附件栏或控件上的显式提示 —— 把隐式降级变成**显式契约**，这正是「有一个能看就行」的可感知形态

### 5.3 加法优先原则

先不动官方 `conversation.input.model`（single slot）。理由：替换它会 shadow 官方 UI，DSH 升级需持续跟进（desktop 那个补丁就是这类代价）。跑顺后再评估是否合并为单一复合控件。

### 5.4 设置页

- `settings.general.item`：一行开关（启用/停用双模型）
- 或 `settings.section`：完整卡片（可抄 `subagent-model-selection-card-controller` 的结构）

---

## 6. 风险与边界

| 风险 | 影响 | 处置 |
|---|---|---|
| 静默丢图 | 用户以为图发出去了 | 路由失败显式报错；两个模型都不支持时在 UI 层禁止上传 |
| 逐步换模型冲击 prompt cache | 成本上升 | `stickWithinTurn` 粘住策略 |
| 回放一致性 | 恢复会话时第一步就可能要走辅助模型 | 辅助模型选择进 durable log；路由决策必须可由 log 重放 |
| 补丁与 DSH 升级（路线 1） | 升级覆盖 | 复用 desktop 的 `patch.mjs` 机制（规则入库 + 基线 + `verify` 自证 + 纳入 `verify-all.mjs`） |
| `reasoningEffort` 继承 | 硬拒请求 | 切换时显式清空（§2.4 要点 2） |
| 辅助模型能力不足 | 整步失败 | 路由前做能力预检（是否声明 tools 支持）；文档化推荐配置 |
| `read_image` 割裂 | 体验不一致 | 与准入/路由同期处理（约束 5） |

---

## 7. 分期计划

### M0：验证 ✅ 已完成（2026-09-10）
用动态 Cordis 插件在真实运行环境验证技术假设，结论见 §8。**五项确认成立，路由与补丁设计均通过校验**；仅剩「`conversation.input.right` 真实渲染位置」一项待 client 授权后闭环（§8.4）。

### M1：最小闭环 ✅ 已完成（2026-09-10）
- ✅ `patches/dsh-api-session-controller/` 补丁（§3.4）+ `patch.mjs verify` 离线自证 + 纳入 `verify-all.mjs`；
  已应用到安装目录（`58574E8A…`，备份 `.dsh-bak` 可 revert）
- ✅ 插件提供 `dualModelVisionRoute` 可选服务（契约见 §3.4.3）
- ⚠️ **配置持久化改为插件自管**（`lib/store.js`，原子写 `config.json`），**未**注册 DSH settings 命名空间 ——
  理由：`settings.register` 需要 schemastery schema，而 `link:` 装载的插件解析不到
  `@deepseek-ai/schemastery`（Node 按符号链接真实路径解析）；为它引入独立安装，一旦解析失败会
  **拖垮整个 profile 加载**。该取舍与 sidebar / ssh 两条线的既有约定一致。
  → **M2 若要接入 settings 命名空间，需先解决该依赖的解析问题**
- ✅ host→client 能力查询通道（`/dual-model/api/*` 同源 JSON 路由；正式 client bundle 无 `host.call`）
- ✅ `conversation.input.right` 控件（辅助模型选择 + 图片归属状态行）
- ✅ 路由：`agent/pre-step` 记录图片上下文 + `agent/request` 替换调用配置
- ✅ **补丁与路由同版本上线**（§3.4.3 义务 2）
- ✅ 24 项单测；`node scripts/verify-all.mjs dual-model` 10/10

**实现相对设计的一处简化**：原计划的 `stickWithinTurn` 粘住配置项**不需要实现** ——
路由判据同时读取本步消息与完整会话历史（`session.deriveMessages()`），因此「同 turn 后续步骤」
与「后续 turn 引用旧图」两种粘住场景天然成立，且图片被 compaction 清理后自动回落主模型，
无需额外状态机。

**实现相对设计的一处修正**：路由判据点从 `agent/request` 改为 `agent/pre-step`。
官方 `prepareRequest` 的契约是 "Resolve request config ... **before admitting model-visible input**"，
即 `agent/request` 触发时本步新消息尚未进入 Session，那里读不到图（详见 §2.4 与 `lib/content.js` 注释）。

### M2：完善
- `read_image` 工具统一处理
- 双模型能力徽标（模型选择器内标注是否支持图片）
- 设置页完整卡片

### M3：策略扩展
- `visionRouting` 策略可选（整步切换 / 转译）
- 「这次交给辅助模型」的按次强制

---

## 8. M0 实测结果（2026-09-10）

用动态 Cordis 插件（host 半 + client 半）在真实运行环境实测。**六项假设全部确认成立，M0 闭环。**

### 8.1 已验证成立

| # | 假设 | 结论 | 实测证据 |
|---|---|---|---|
| 1 | `agent/request` 可被插件在 agent scope 挂上 | ✅ **成立** | 6 个 live agent 的 `agent.ctx` 全部 present，**6 个监听器全部挂上**并真的捕获到触发（`turn/step/provider/model/effort`）；多会话并行各自独立；Package update 后重新挂载正常 |
| 2 | `conversation.input.right` 可挂载渲染 | ✅ **成立** | client 组件成功挂载**并向 host 回调 3 次**（`host.call` 往返实测成功），`verdict: CLIENT MOUNTED AND CALLED BACK`；slot 实测提供 13 个 props（见 §8.4） |
| 3a | host→client 能力查询通道 | ✅ **成立** | `harness.handle(method, handler)` ↔ `host.call(method, args)` 双半通道可用 |
| 3b | `ctx.provide` 作为补丁读取通道 | ✅ **成立（异步生效）** | `apply` 内立即读返回 `UNDEFINED`，若干 step 后读返回 `OK typeof=object`——**注册异步可见，但确实成功** |
| 4 | Agent 注入 API 存在 | ✅ **成立** | Agent 暴露 `followup` / `steer` / **`inject`** / `send` / `cancel` / `preStep` / `buildRequest`，arity 均为 1 |
| 5 | 能力真值源可用 | ✅ **成立** | `llm.resolveModelInfo` 正常返回 `inputModalities` |

### 8.2 §3.4 补丁设计经 M0 校验后仍然成立

3b 的「异步生效」性质**不影响补丁设计**：补丁的 `ctx.get("dualModelVisionRoute")` 只在用户提交带图消息时被调用——那是插件激活很久之后，服务早已可见。唯一不可读的窗口是「插件刚激活的同一 tick」，而它不是补丁的调用时刻。

### 8.3 重要环境事实（影响产品设计）

**能力声明是确定性的**：全部 9 个 provider、59 个模型的 `inputModalities` **无一为 `undefined`**。§2.2 中「unknown 放行」的分支在当前环境不存在，准入判定完全确定。

**视觉能力分布**（M0 实测）：

| provider | 模型数 | 支持图片 |
|---|---|---|
| `opencode` | 19 | **10**（claude-*、gpt-5.6-*、grok-build-0.1、mimo-v2.5-free、minimax-m3） |
| `openai` | 3 | **3**（gpt-5.6-luna / sol / terra） |
| `deepseek-official` | 4 | **2**（`deepseek-flash`、`deepseek-v4-flash-vision-exp`） |
| `xiaomi` | 3 | **1**（`mimo-v2.5`） |
| **`openrouter`** | **21** | **0** ← 免费模型池全部为纯文本 |
| `wxxcx` / `step` / `next` / `gpt6` | 9 | 0 |

> **这条直接印证了需求的真实性**：`openrouter` 的 21 个免费模型**全部不支持图片**。以免费池模型为主力时图片上传完全不可用——这正是本功能的目标场景。
> 同时辅助模型候选充裕（16 个视觉模型），成本梯度清晰：`mimo-v2.5-free`（免费）→ `deepseek-flash` → `claude-*`。

**当前默认模型**：`deepseek-official/deepseek-flash` = DeepSeek-V41-Flash，`text|image`，上下文 1,000,000，4 档 reasoning effort。

**附件限制**（`attachments.imageLimits`，M1 的 UI 需遵守）：单图 20 MB、单条消息 20 张、消息总量 200 MB、单图 6400 万像素、单边 8192 px。

### 8.4 `conversation.input.right` 实测 props 清单（M1 直接依据）

client 半实测该 slot 提供 **13 个 props**：

`usePanelInfo`、`useSessions`、`useSessionPendingInteraction`、`useWorkspaces`、`useResource`、`sessionId`、`inputActions`、`useSession`、`useConversation`、`useInput`、`useTrajectory`、`useChat`、`useProjection`

> 其中 **`usePanelInfo` 与 `useResource` 不在官方 slot 文档的 standardProps 列表内**——是本次实测的新增发现。`useResource` 对 M1 可能尤其有用（能力目录的加载/缓存或许能直接复用它，而不必自建 host 查询通道）；其确切语义待 M1 确认。

**对 §5 UI 设计的意义**：M1 的右下角控件因此可直接拿到 `sessionId`、`inputActions`（含 `submit` / `addImages` / `removeImage`）、`useInput`（`imageIds` / `draft` / `phase`）、`useConversation`。**读取会话内输入状态无需新增 host 数据通道**——host 通道只需承担「模型能力查询」这一件事。

> **契约修正（2026-09-22 实测）**：`useInput` 等 `useXxx` 属 **SnapshotSelectorHook**，
> 必须**带 selector 调用**——`bindSnapshotSelector` 把入参原样透传给
> `useSyncExternalStoreWithSelector`（无 identity 兜底），无参调用会在订阅回调里抛
> `TypeError: selector is not a function`（bundle 内表现为 `l is not a function`），
> 整个控件被 slot error boundary 吞掉、按钮完全不渲染。
> 另：`InputState` 的草稿附件字段名是 **`attachmentIds`**（本设计文档 8.4 上下文所提
> `imageIds` 不存在）；`conversation.input.right` 的 kit 不提供 `resolveDraftAttachments`，
> 无法区分图片/文件，UI 计数只能按附件口径。

### 8.5 剩余待验证

1. **plugin 来源消息注入 API 的具体签名**（路线 2 备用）—— `agent.inject` 已确认存在（arity=1），但参数结构与可用标记（`MessageSourceMap.plugin` + `ContextFormed.form`）需进一步确认。**已选定的路线 1 不依赖它。**
2. **辅助模型切换后 header 变化的 log 体积** —— 逐步切换会写多条 `request/header`，需在 M1 实测评估。

---

## 9. 取证链接（本机安装产物，0.1.2-rc.1）

| 主题 | 文件 |
|---|---|
| 准入校验 | `dsh-api-session-controller/lib/index.js:745-751` |
| 静默丢图 | `dsh-llm/lib/index.js:1684`、`dsh-llm/lib/types/content.js:47-50,88-91,158-165` |
| 官方路由先例 | `dsh-agent/lib/types/model-selection.js` |
| 请求构建与 log | `dsh-agent-loop/lib/index.js:700-756` |
| Scoped 约束 | `dsh-scope/lib/invariant.js:17` |
| Agent 接口 | `dsh-agent/lib/types/runtime-types.d.ts:65-75` |
| 模型选择投影 | `dsh-api-session-controller/lib/types/types.d.ts:60-127,257-264` |
| 调用配置 | `dsh-llm/lib/types/call-config.d.ts:16-23` |
| 工具图片校验 | `dsh-tool-fs/lib/index.js:978` |
| 输入行动面 | `dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:196-304` |
| 模型目录（无能力字段） | `dsh-api-session-controller/lib/types/types.d.ts:101-127` |
| 0.1.5 slot 兼容性 | `../dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.5-rc1-slot-contract-2026-09-10.md` §4.1 |

---

## 10. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-10 | 初稿：现状取证（三层结构 + 静默丢图定位）、核心冲突分析与三条路线对比、架构与 UI 设计、分期计划 |
| 2026-09-10 | **准入路线拍板**：复议弃「客户端分流零补丁」（§3.2 推演排除），改定路线 1 一行本体补丁；补上补丁形态选型、补丁内容、契约面与落位（§3.4） |
| 2026-09-10 | **M0 实测完成并闭环**（§8）：**六项假设全部确认成立**（`agent/request` 可挂、`conversation.input.right` 挂载并往返成功、`provide` 通道可用且异步生效、Agent 注入 API 存在、能力真值源可用、host↔client 通道可用）；实测出视觉能力分布与附件限制，证实 `openrouter` 免费池 21 个模型全部不支持图片——需求痛点场景成立；实测 slot props 13 项（含文档未载的 `usePanelInfo` / `useResource`） |
| 2026-09-10 | **M1 实现完成**（§7）：落 `@miasaki/dsh-dual-model` 插件（host + client 双半、6 个 lib 模块、24 项单测）与 `patches/dsh-api-session-controller/` 补丁（1 条编辑、双基线、离线自证）；补丁已应用到安装目录、已注册进 DSH web profile、纳入 `verify-all.mjs`（10/10）。**两处设计修正**：路由判据点改为 `agent/pre-step`（官方 `prepareRequest` 在接纳输入之前）；配置持久化改插件自管（schemastery 依赖解析不可靠） |
