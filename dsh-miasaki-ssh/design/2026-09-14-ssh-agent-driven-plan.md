# SSH 线的 Agent 化：能力分层与实施规划

- 日期：2026-09-14
- 状态：**设计提案 v0.2，待评审；未实施业务代码**
- 范围：让 `@miasaki/dsh-ssh` 从「人的手动终端」升级为「Agent 可驱动的远程执行面」，并给出分期、门槛与安全边界。
- 上游：[SSH 设计文档](2026-09-09-ssh-design.md)（技术选型 / 安全红线）、[工作区优化规划](2026-09-12-ssh-workspace-plan.md)（U0/U1 已实施，U2/U3 未动；本文的 U3 部分取代其「选中文本送进对话 / `ssh_exec` 工具」条目）。
- 核查口径：**DSH 本体 0.1.5-rc.1 安装产物的源码与随包中文 README**（`<dsh-install>/node_modules/@deepseek-ai/*`）+ 本线源码静态核查。**本轮未运行真实 SSH、未做真实模型调用、未验证任何工具注册**；标注为「推断」的结论必须经 §11 SPIKE 验证后才能当作事实使用。
- 本文不替代 §10 的代码落点评审；评审通过前不写业务代码。

---

## 1. 建议结论

**做「Agent 的 SSH 手」，不做「SSH 里的 Agent」。**

1. **SSH 是能力提供方，不是 Agent 宿主。** DSH 已经有一整套 agent 循环——对话视图、审批 UI、工具卡、会话日志、压缩、子代理。SSH 线若自造内嵌对话，就要重复实现其中每一件，并承担双份会话状态的同步。正确形态是：SSH 把「远程执行」注册成平台能力，让**既有**的 agent 用它；SSH 页面是这件事的**观察窗**。
2. **人的交互式 PTY 与 Agent 的执行通道必须物理分离。** 现状是一连接一 PTY。Agent 若复用它会污染人的屏幕、被人打断、并冲掉回放环。Agent 走独立 exec channel，结果结构化返回，两者互不干扰。
3. **凭据永不归 Agent。** Agent 只能操作**人已显式授权**的主机；密码类主机必须在本次 host 进程内由人先连接过一次。这条红线先于任何功能。
4. **先做便宜且无风险的上下文桥，再做工具面，最后才谈自主。** 「终端选区送对话」不需要任何平台新能力，却能立刻消除信息孤岛；工具面（`ssh_exec`）是真正的形态跃迁，也是风险跃迁，必须连同授权、审批、审计一起上。

一句话的形态描述：**人在 SSH 页里干活，Agent 在旁边有手；Agent 动手时人看得见、拦得住、查得到。**

---

## 2. 现状诊断：现在是「人的工具」，缺的是三条通道

| 维度 | 现状（源码事实） | 缺口 |
|---|---|---|
| 上下文 | `app.js` 有完整工作区，但页面内没有任何「把这台主机/这段输出交给对话」的出口 | **终端 → Agent** 单向不通 |
| 能力 | `lib/runtime.js:236` 每个连接只开一个 `client.shell()` PTY；`index.js:239` 只暴露 `/ssh/api/*` REST + `/ssh/ws` 终端桥 | **Agent → 远程** 完全不存在 |
| 可见性 | `index.js:25` 插件 `inject = ['webServer']`，**不认识 tools / approval / agent 任何服务** | Agent 若在远程做事，SSH 页面一无所知 |
| 治理 | 现有安全模型是「浏览器围栏 + TOFU + 凭据不落盘」（`index.js:9–18`），全部面向**人的操作** | 没有针对**模型发起**的操作的授权、分级、审批、审计 |
| 复用 | `SshRuntime` 已有连接保活、generation 绑定、回放环、背压（`lib/runtime.js`） | 这些是资产，工具面应**复用同一 Client**，而不是另建一套连接 |

**结论**：不是要重写 SSH 线，而是要在它上面补三条通道——**给 Agent 的手（工具）、给人的眼（可见性）、给人的闸（审批）**。既有的连接管理、指纹、TOFU、围栏全部保留。

---

## 3. 平台事实：0.1.5-rc.1 给了什么

以下每条都来自安装产物，附证据位置；标「⚠ 推断」的尚未实证。

### 3.1 工具注册表 `ctx.tools`

| 能力 | 接口 | 证据 |
|---|---|---|
| 注册工具 | `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))` | `dsh-tools/README.zh.md` §注册工具 |
| 参数 schema DSL | `{ type: 'string'\|'number'\|'integer'\|'boolean'\|'null'\|'array'\|'object'\|'json'\|'oneOf', required?, description? }` | 同上 |
| 结果呈现 | `output: { schema, render(args, value) => [{type:'text', text}] }` | 同上 |
| 执行上下文 | `execute(args, exec)`；`exec` 是 `ToolRunContext`，含 `callId` / `name` / `arguments`（已解析深冻结）/ `agent?` / `signal` / `token` / `rootCallId` | `lib/types/index.d.ts:190–284`；`signal` 为调用方拥有的协作取消信号 |
| 按 agent 收窄 | `ctx.tools.restrict(filter)` 返回取消时失效的掩码 | 同上 §按 agent 限制工具 |
| 单调守卫 | `ctx.tools.guard(guard)` —— 返回理由即拒绝，后续监听器**无法翻案** | 同上 §对调用实施策略 |
| 执行流水线 | `tools/pre-execute`（允许/拒绝/询问）→ guard → `tools/execute` → `tools/post-execute` → `finalizeContent` → `tools/result`（只观测） | 同上 §设计理念 / §扩展点 |

**注册即得 schema 进系统提示词**（原文：「注册一个工具就足以让它可见——注册表会自动把其 schema 送入系统提示词组装」）。

### 3.2 审批 seam `ctx.approval`

```ts
ctx.approval.request({
  agent: Agent,          // 谁的会话
  toolName: string,      // 呈现与审计用
  callId?: ToolCallId,   // 关联已流式呈现的工具调用
  reason?: string,       // 提问方对人类可读的解释：为什么问
  signal?: AbortSignal,  // 中止即撤回问题
}) => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
```

来源：`dsh-user-approval/lib/types/index.d.ts:60–127`。

**三条必须写进设计的硬约束**：

1. **`allowed-once` 是唯一授权**——没有 `allow-always`、没有记忆规则、没有撤销。（README「已知限制」）
2. **请求只在尚未结束的轮次内有效**——空闲时或轮次之间调用会在审计前抛异常。（同上 / `request()` JSDoc：*"The request requires an open turn … an idle ask rejects before appending anything"*）
3. **请求不携带工具参数**——应答者只看到工具名、原因、可选 callId。命令细节要么写进 `reason`，要么靠 `callId` 关联到已呈现的工具调用卡。

**审计白拿**：`request()` 先写 `approval/asked`、再写 `approval/decided`，两者进**发起请求的会话日志**（`dsh-user-approval/README.zh.md` §审计）。SSH 不需要自建审计表即可获得「谁在何时批准了什么工具」的持久记录。

**Web 端应答者已就位**：`dsh-web-app/cordis.patch.yml:252` 挂着 `ui-approval`，即官方审批 UI 存在且是默认应答者。

### 3.3 终端抽象 `ctx.terminals`——**看起来对口，实际是陷阱**

`dsh-terminal` 的设计确实诱人：「同一个注册表可用于不同的终端基底」，后端只负责启动/就绪/保留输出/关闭。但把 SSH 塞进去会在三处语义上打架：

| 冲突点 | `TerminalBackend` 契约 | SSH 现实 |
|---|---|---|
| 会话定位 | `TerminalSpawnRequest = { type, name?, cwd? }` —— **没有主机标识** | 开远程会话必须先知道连哪台主机；塞进 `name` 是滥用元数据 |
| 进程模型 | `pid?: number`、`TerminalSignalResult.targetPgid: number`、`TerminalSignal = SIGINT\|SIGTERM\|SIGKILL\|SIGTSTP\|SIGHUP` | 远程没有本地 pid/pgid；信号要映射成远程 `kill -SIGINT`，`targetPgid` 无从填起 |
| 沙箱前提 | `dsh-terminal-bash` 要求沙箱、沙箱策略与子进程提供方（README §组合方式） | 远程主机**不受本地沙箱管辖**——这是一次信任域的更换，不是换个进程 |

来源：`dsh-terminal/lib/types/types.d.ts:37–153`。

**结论：不走 `ctx.terminals` 后端路线。** SSH 注册自己的工具。这个判断值一次 SPIKE 的钱（§11 S5），但方向上不应把方案押在这里。

### 3.4 子代理注册表 `ctx.subagents`（Host 平面，可编程）

- 服务是**具名提供方注册表**：`start()` 启动、生命周期事件、按名路由（`dsh-subagent/README.zh.md` §设计理念）。
- 「成功时运行被发布、**所有权转移给调用方**」（同上 §生命周期）。
- 发现面：服务列举直接子级与完整后代树，**不加载任何子 agent**。
- **注册表与后端留在 Host 平面**——`dsh-web-app/cordis.patch.yml:436–441` 只把**委派工具行**（`tool-subagent*`）`disabled`，服务本体不动。

⇒ ⚠ 推断：profile bundle 层的插件**有可能**编程式驱动子代理。这是「任务级自主」（D 层）的官方通道，但也是本方案里最重的一块，不进第一版。

### 3.5 对话流里的工具卡 `tool.call.toolview`

```js
ctx.slots.inject('tool.call.toolview', () =>
  ctx.slots.register({ name: 'tool.call.toolview', /* 按 wire 工具名键控 */ }))
```

来源：`dsh-client-ui-tool/README.zh.md` §注册业务工具视图。

- 未注册的工具名走通用卡片；**注册后该工具在对话里有专属渲染**。
- owner 载荷 `ToolCallOwnerProps`：`callId`、`toolName`、冻结的 `block`、可选 `cwd`/`home`、`loadImage`、`openFile`/`inspect`。
- 官方已把**前台 `bash`/`pwsh`/`terminal_send` 渲染成 terminal 卡片**（同 README §内置展示）——SSH 的 `ssh_exec` 有现成的视觉语言可对齐。

⇒ 这是「Agent 在远程做了什么」在对话里的落点，也是 §8.3 的实现基础。

### 3.6 平面归属：工具行写在哪，由「谁读这个 Service」决定

`dsh-web-app/cordis.patch.yml:351–484` 是这一节的唯一权威来源，原文两条判据值得逐字记住：

> *"a Service a row outside its realm READS belongs to the plane both can see"*
> *"deployment-level providers — repository plugins, a host skill-filesystem row — register into its global layer"*

- **Host 平面（`dsh-base` 提供）**：`session`(:33)、`user-questions`(:64)、`agent`(:67)、`sandbox`(:205)、**`approval`(:224)**、**`subagent`(:328)**、**`tools`(:460)**。
- **Agent 平面（每个 preset realm）**：具体工具行（`tool-bash`、`tool-pwsh`、`tool-fs`、`tool-todo`、`tool-web`…）在 Web 面被 `disabled: true`，改由每会话挂载的 preset 提供。

⇒ ⚠ 推断（**高置信**，2026-09-14 复核）：`@miasaki/dsh-ssh` 作为 **profile bundle 行**，可 `inject` `tools` / `approval`，并**注册进全局层**，从而对每个会话的 agent 可见。复核证据：`dsh-base/cordis.patch.yml` 里 `tools`(:460) 与 `approval`(:224) 都是**顶层平铺的 insert 行、没有任何 `isolate` 包裹**，而本线现有的 `webServer` 依赖走的正是同一条可见性路径（`index.js:25`）。

**代价**是每个会话的模型都固定多出这些工具的 schema token（`dsh-tools/README.zh.md` §Token 影响：「每次请求的固定成本与可见定义成正比」）。这条代价直接推演出 §6.1 的「工具要少而正交」和 §9 的「默认关闭」。

---

## 4. 五条核心设计判断

### J1 不做第二个 Agent

复用既有 agent 循环的四件套：工具（能力）、审批（闸门）、工具卡（呈现）、会话日志（审计）。SSH 只贡献**能力**和**现场**。

反面做法（明确否决）：在 `/ssh/` iframe 内自建对话面板、自建消息列表、自建审批弹窗、自建上下文管理。它会带来：两份会话状态、审批 UI 二义性（人在 SSH 页批了，对话页不知道）、上下文双份计费、以及一个永远追不上官方 UI 的界面。

### J2 通道分离：人的 PTY ≠ Agent 的 exec

`lib/runtime.js:236` 的 `client.shell()` 是**人的终端**，它承载全屏 TUI、bracketed paste、回放环、多 viewer attach 等一整套交互语义。Agent 的输出是**另一种东西**：结构化、有退出码、量大、需要截断与审计。

**Agent 走 `client.exec(command)`，同一个 `Client` 下的独立 channel**：
- 复用已建立的连接 ⇒ 不重复认证、不重复指纹确认、不额外占用连接数；
- 不触碰 `rc.stream` ⇒ 人的屏幕不被污染，人的输入不混进 Agent 的判读，256KiB 回放环不被 Agent 的巨量输出冲掉；
- 输出是 `{ exitCode, stdout, stderr, durationMs }` ⇒ 天然可审计、可截断、可结构化呈现。

**唯一例外是 §6.4 的「接管模式」**：显式开启后允许 Agent 向人的 PTY 发送按键（复用 `runtime.viewerInput` 的绑定路由），默认关闭。

### J3 凭据与授权先于功能

- Agent **永远不接触**密码、私钥口令；（沿用既有红线：`index.js:14–17`）
- 每台主机新增 `agentAccess: 'none' | 'readonly' | 'full'`，**默认 `none`**——「已保存」不等于「已授权给 Agent」；
- 密码认证的主机，Agent 只能操作**人在本次 host 进程内已经连接过**的连接（凭据在 `SshRuntime` 内存中存活期间）；key/agent 认证的主机可自行发起连接；
- **可见面即授权面**：`ssh_hosts` 只列出 `agentAccess !== 'none'` 的主机，模型看不到未被授权的主机 id。

### J4 审批走官方 seam，且必须诚实说明它拦得住什么

危险命令走 `ctx.approval.request()`：拿到官方审批 UI、官方审计、官方失败关闭（无应答者 ⇒ `unavailable` ⇒ 拒绝）。

**但必须诚实**：基于命令文本的分级（§7.2）**不是安全边界**。shell 是图灵完备的，`bash -c "$(curl …)"`、`python -c …`、变量拼接、base64 解码都能绕过正则。分级的作用是**降低误伤、把人的注意力引导到该看的地方**，真正的边界是三条：

1. **主机授权**（哪些机器 Agent 碰得到）；
2. **人在环**（变更级操作必须有人按一次）；
3. **审计**（事后能查，`approval/asked|decided` 已在会话日志里）。

不要在任何文档或 UI 里把命令正则写成「安全防护」。这与既有文档「围栏不是身份鉴权，不能宣称防住同机所有进程」（plan §8）是同一种诚实。

### J5 可见性即安全

Agent 在远程执行时，**人必须能看见**。远程资源是共享的：Agent 跑 `apt upgrade` 会让人的 shell 卡住，Agent 重启服务会打断人的调试。技术上的通道分离（J2）解决了「互相污染」，但解决不了「互相影响」。

因此 SSH 页面需要一个 **Agent 活动时间线**（§8.1）：每条 Agent 执行以事件形式（**不写 PTY**）推送到页面，显示主机、命令、状态、耗时、退出码，可展开看输出。这不是锦上添花，是 J4 之外的第二道人的感知闸门。

---

## 5. 目标形态

```text
                    ┌─────────────────────────────────────────┐
                    │  DSH Agent 循环（官方，不重造）           │
                    │  对话视图 · 审批 UI · 工具卡 · 会话日志    │
                    └───────────────┬─────────────────────────┘
              ┌─────────────────────┼─────────────────────┐
              │  ctx.tools          │  ctx.approval       │
              │  （能力注册）        │  （一次性审批 + 审计）│
              └─────────┬───────────┴──────────┬──────────┘
                        │                      │
        ┌───────────────▼──────────────────────▼──────────────────┐
        │            @miasaki/dsh-ssh（Host 平面，本线）            │
        │  ┌──────────────┐  ┌───────────────┐  ┌───────────────┐ │
        │  │ 工具层        │  │ 治理层         │  │ 事件总线       │ │
        │  │ ssh_hosts    │  │ 主机授权       │  │ agent 活动广播 │ │
        │  │ ssh_exec     │  │ 命令分级       │  │ （→ 页面/WS）  │ │
        │  │ ssh_session_ │  │ 审批路由       │  │               │ │
        │  │   read       │  │ 执行台账       │  │               │ │
        │  └──────┬───────┘  └───────┬───────┘  └───────┬───────┘ │
        │         │                  │                  │         │
        │  ┌──────▼──────────────────▼──────────────────▼───────┐ │
        │  │            SshRuntime（既有，U0/U1 资产）            │ │
        │  │  连接保活 · generation 绑定 · TOFU · 回放环 · 背压   │ │
        │  │  ┌────────────────┐      ┌────────────────────┐    │ │
        │  │  │ shell PTY      │      │ exec channel（新）  │    │ │
        │  │  │ ＝ 人的终端     │      │ ＝ Agent 的通道     │    │ │
        │  │  └────────┬───────┘      └─────────┬──────────┘    │ │
        │  └───────────┼────────────────────────┼───────────────┘ │
        └──────────────┼────────────────────────┼─────────────────┘
                       │ WS /ssh/ws             │ WS /ssh/ws（同一桥，多一种帧）
              ┌────────▼────────────────────────▼────────┐
              │  /ssh/ 页面（人）                         │
              │  主机导航 · 终端标签 · 【Agent 活动时间线】│
              │  【选区 → 送对话】                        │
              └──────────────────────────────────────────┘
```

**四条通道**：
- **上行能力**：`ctx.tools` → `SshRuntime.exec` → 远程（Agent 的手）
- **下行上下文**：SSH 页面选区 → 对话（人的嘴）
- **旁路可见**：`SshRuntime` 事件 → WS 帧 → SSH 页面时间线（人的眼）
- **闸门**：`ctx.approval` ↔ 官方审批 UI（人的闸）

---

## 6. 执行面：工具设计

### 6.1 工具清单（v1 三个，少而正交）

| 工具 | 参数 | 输出 | 分级 | 存在理由 |
|---|---|---|---|---|
| `ssh_hosts` | `{ filter?: string }` | `{ hosts: [{ id, label, address, agentAccess, state, lastConnectedAt }] }` | 只读，免审批 | 让模型知道手在哪，**杜绝主机幻觉**；只返回已授权主机 |
| `ssh_exec` | `{ hostId, command, cwd?, timeoutMs? }` | `{ exitCode, stdout, stderr, truncated, durationMs, host, command }` | 按 §7.2 分级 | 核心能力 |
| `ssh_session_read` | `{ hostId, lines? }` | `{ text, truncated, cols, rows }` | 只读，免审批 | 「你看我这个报错」——读**人正在用的**终端回放，无需 Agent 执行任何东西 |

**为什么 v1 不做 `ssh_connect`**：连接是人的授权动作。Agent 需要某主机时，`ssh_exec` 在「已授权 + 已有连接或可自主认证」时隐式建立连接；否则返回可行动的失败（`NOT_CONNECTED` / `ACCESS_DENIED`），由人在页面上连接。**不把「发起认证」暴露成模型可调用的能力**。

**后续（v2+，对应 U2/U3）**：`ssh_put` / `ssh_get`（SFTP，U2）、`ssh_tunnel`（转发，U3）。每个都需独立安全评审，不预先占用 schema token——因为**每个工具对每个会话都是固定成本**（§3.6）。

### 6.2 exec 通道

在 `lib/runtime.js` 上新增，挂在同一个 `RuntimeConn` 上：

```js
// 形状示意，非最终代码
class ExecChannel {
  async run({ command, cwd, timeoutMs, signal }) {
    // 1. 并发闸门：每连接最多 N 个在跑（默认 2），超出排队或直接拒绝
    // 2. rc.client.exec(command, { pty: false }) —— 独立 channel，不碰 rc.stream
    // 3. 双上限：单流字节上限（默认 256KiB）+ 时间上限（默认 30s，上限 300s）
    // 4. signal → 远程 SIGINT；超时 → 关 channel 并标记 timedOut
    // 5. 返回 { exitCode, stdout, stderr, truncated, durationMs, timedOut }
  }
}
```

要点：
- **复用同一 `Client`**：不新增连接、不重复认证、不动 TOFU 状态；
- **不写 `rc.stream`**：`rc.push()` / `rc.sbChunks` 完全不被 Agent 触碰；
- **协作取消**：工具收到 `exec.signal` 必须传递下去（`dsh-tools` 的取消约定要求工具主体观测信号）；
- **连接死亡**：`rc.disposed` / `rc.client` 结束时，在跑的 exec 必须以明确错误码结算，不能挂起。

### 6.3 输出预算

远程输出可以无限大，模型上下文有限。三道处理：

1. **硬上限截断**（单流 256KiB）+ `truncated: true`；
2. **首尾保留策略**：超限时保留头部 N 行 + 尾部 M 行，中间以 `… (省略 X 行) …` 标记（错误通常在尾部，上下文在头部）；
3. **落盘 + 引用**：超大输出写入 `dataDir/exec-logs/`，工具结果只返回路径与摘要。⚠ 需对齐官方 shell 工具的 spill 约定（`dsh-tools`/`dsh-client-ui-tool` 提到「以已识别的 spill 策略提示结尾的 shell 输出」），避免自造一套与官方视觉不一致的截断语义（§11 S6）。

### 6.4 接管模式（v2，默认关闭）

允许 Agent 向**人的 PTY** 发送按键（复用 `runtime.viewerInput` 的 viewer 绑定路由，天然继承 `STALE_VIEWER` 防护）。

- 默认关闭；开启需在页面上显式操作，且有超时（如 5 分钟后自动收回）；
- 开启期间页面必须有**不可忽略的指示**（「Agent 正在操作你的终端」）；
- 用于「这个 TUI 我进不去，你帮我看看」这类场景；
- **不进入第一版**——它把 J2 的隔离主动打破，必须建立在 J4/J5 已被验证可信之后。

---

## 7. 治理面

### 7.1 主机授权（默认拒绝）

`lib/store.js` 的连接模型新增字段：

| 字段 | 取值 | 默认 | 语义 |
|---|---|---|---|
| `agentAccess` | `'none' \| 'readonly' \| 'full'` | `'none'` | Agent 对该主机的权限上限 |

- `none`：模型看不到该主机（`ssh_hosts` 不返回），`ssh_exec` 直接 `ACCESS_DENIED`；
- `readonly`：允许 §7.2 的 L0 只读命令，L1/L2 一律拒绝（**连审批机会都不给**，这才叫只读）；
- `full`：全分级可用（L1/L2 需审批）。

编辑抽屉（`app.js` 的 `openEditor`）增加该字段，配「Agent 可操作此主机」的说明文案。**新增字段必须同步 `store.js` 的归一化与迁移测试**（沿用 plan §9 的既有纪律）。

### 7.2 命令分级（诚实版）

| 级 | 判据（示例） | 处理 |
|---|---|---|
| **L0 只读** | `cat, ls, head, tail, grep, find, ps, top, df, free, uptime, systemctl status, journalctl, docker ps/logs, kubectl get, git status/log/diff, ss, netstat` | `full` 主机免审批；`readonly` 主机允许 |
| **L1 变更** | 写文件、`systemctl restart`、`apt install`、`docker run/rm`、`kubectl apply/delete`、`git push` | 需审批 |
| **L2 危险** | `rm -rf`、`dd`、`mkfs`、`shutdown`/`reboot`、`iptables -F`、`chmod -R 777 /`、`curl … \| sh`、`:(){ :\|:& };:`、`> /dev/sd*` | 需审批 + **在审批理由中显式标注危险等级** |
| **未知** | 未命中以上任何规则 | **按 L1 处理**（保守默认） |

**实现要点**：
- 分级是**保守猜测**，不是解析器。命中即按更高级处理（`rm -rf /tmp/x` 与 `rm -rf /` 同归 L2——宁可多问）；
- 管道与复合命令**逐段分析**，任一段命中 L2 则整体 L2；
- 分级结果写进 `ssh_exec` 的**工具调用参数**（新增 `riskLevel` 由服务端填，不接受模型传入）与 `reason` 文本——因为审批请求不携带参数（§3.2），`reason` 是人能看到命令细节的主要通道；
- 规则表放 `lib/policy.js`（可单测、可配置）。

### 7.3 审批接入

```js
// ssh_exec 执行体的形状
const decision = await ctx.approval.request({
  agent: exec.agent,                       // 由工具执行上下文给出
  toolName: 'ssh_exec',
  callId: exec.callId,
  reason: `在 ${host.label} 上执行 ${riskLevel} 级命令：\n${command}`,
  signal: exec.signal,
})
if (decision !== 'allowed-once') return { refused: decision }
```

**四个必须处理的分支**：`allowed-once`（放行）、`rejected`（返回结构化拒绝，不抛异常——工具失败不应中止轮次）、`cancelled`（用户撤回）、`unavailable`（无应答者，失败关闭）。

**✅ 已核实（2026-09-14）：审批所需两个字段都在。** `execute(args, exec)` 的 `exec` 是 `ToolRunContext extends ToolExecution`，含 `callId`(:198)、`name`、`arguments`（已解析、已深冻结、无损 JSON，:206）、`agent?`(:208)、`signal`(:220)、`token`、`rootCallId`（`dsh-tools/lib/types/index.d.ts:190–284`）。

**但 `agent` 是可选字段**——注释写明「set by the agent loop」，即非 agent 发起路径（PTC 子分发、程序化调用）可能没有。因此执行体必须显式处理：

```js
if (exec.agent === undefined) return refuse('NO_AGENT_CONTEXT')  // 无 agent ⇒ 无从审批 ⇒ 需审批的操作一律拒绝
```

**默认拒绝**，绝不「没 agent 就放行」。

**「不携带参数」不等于「人看不到命令」**：官方审批 UI「按需渲染关联的 Tool 详情」（`dsh-client-ui-approval/README.zh.md`:11），即它会顺着 `callId` 找到那次工具调用并把参数呈现出来。因此有两条互补通道——`reason`（人类可读的自述，**必须**含主机与命令摘要）与工具调用详情（原始参数，**服务端填的 `riskLevel` 也在其中**）。两条都要给足，不要指望其中一条。

**⚠ 审批可用性取决于会话的 permission preset（2026-09-14 核实）**：`dsh-base/cordis.patch.yml:224–241` 把 `dsh-user-approval` 的 `policy` 绑在 `DSH_PERMISSION_MODE` 上——`danger-full-access` ⇒ `never`，其余 ⇒ `ask`；并由 `dsh-permission-presets`（`:229`）把 read-only / workspace-write / danger-full-access 三档映射到 sandbox + approval。

而 `never` 的语义是「**在交互式分发之前确定性地拒绝每个请求**」（§3.2），**不是放行** ⇒ 在 `danger-full-access` 会话中，SSH 的 L1/L2 命令会**全部被自动拒绝**，Agent 只剩只读能力。这不是缺陷，是既有安全姿态在 SSH 上的自然投影，但必须两件事：

1. 工具结果要给出**可行动的失败信息**（`APPROVAL_UNAVAILABLE`：说明当前会话的权限模式不允许审批，建议切到 workspace-write 或由人在 SSH 页面手动执行），而不是一句干巴巴的拒绝；
2. 把「`never` 下 L1/L2 全部被拒不执行」写进 §12 B-5 作为**期望行为**，不当作 bug 修。

### 7.4 凭据红线（不变，但适用面扩大）

- Agent 永不接触密码 / 私钥口令 / 私钥内容；
- 密码认证的主机，Agent 只能操作**人本次已连接**的连接（凭据在 `SshRuntime` 内存存活期内）；
- key/agent 认证的主机，若主机 `agentAccess !== 'none'`，允许 `ssh_exec` 隐式建连（此路径不产生任何秘密的人机传递）；
- **任何情况下，Agent 不能读取、导出、修改连接配置里的凭据字段**——没有 `ssh_set_password` 这类工具，也不会有。

### 7.5 执行台账

除官方 `approval/asked|decided`（自动进会话日志）之外，SSH 侧记一份自己的执行台账：

- 位置：`dataDir/exec-audit.jsonl`（追加写，与 `connections.json` 同目录族）；
- 每条：`{ ts, hostId, command, riskLevel, decision, exitCode, durationMs, truncated, agentSessionId? }`；
- **不记输出内容**（避免把远程敏感数据落到本地磁盘）；
- 用途：SSH 页面时间线的重放来源、跨会话的「这台机器最近被 Agent 动过什么」。

---

## 8. 协作面：UI

### 8.1 SSH 页面内的 Agent 活动时间线（J5 的落点）

工作区右侧新增一个可折叠的「Agent」面板（`app.js` 的骨架 + `styles.css` 的容器查询一并处理四档宽度）：

- 每条 = 一次 Agent 执行：`主机 · 命令（等宽、单行截断、可展开）· 状态 · 耗时 · 退出码`；
- 状态：`待审批 / 执行中 / 成功 / 失败 / 被拒 / 已取消`；
- 数据源：host 侧事件广播（新 WS 帧类型 `agent-activity`，走既有 `/ssh/ws` 桥）；
- **不写 PTY、不占终端标签**——它是独立的时间线，不是终端的第二路输出；
- 未读标记：Agent 在页面未激活时执行了操作，切回来能看见。

### 8.2 终端 → 对话（上下文桥，最便宜的第一步）

三处入口，复用官方既有的「引用/发送到对话」机制（不要自造）：

1. **选区发送**：终端选中文本 → 右键/快捷键 → 送进对话输入框（带主机名与来源标注）；
2. **错误一键追问**：状态横幅或终端右键「让 Agent 看看这个错误」→ 自动附上最近 N 行输出 + 主机身份；
3. **主机上下文**：在 SSH 页面发起的对话消息，自动带上 `{ host: label, address, agentAccess }` 元信息。

**⚠ 已核验（2026-09-14）：没有现成的公开通道。** `dsh-client-ui-reference` 的对外注册面只有「一个 slash source」（`dsh-client-ui-reference/README.zh.md`:104），服务的是 `@` 补全菜单的**固定候选领域**（文件 / 文件夹 / 会话），不是「插入任意文本」；`ui-input-trigger` 是该 source 注册进的行内建议机制，语义同样为 `@` / `/` 服务。因此 A0 有三条路：

1. **退化（推荐先做）**：复制到剪贴板 + 页面提示「已复制，粘贴到对话即可」——零依赖、零风险、今天就能用；
2. **注册一个 SSH 引用 source**：往 `ui-input-trigger` 加 `@ssh` 域（候选 = 主机 / 当前选区），语义上勉强自洽，但需 SPIKE 确认是否越界（§11 S7）；
3. **写对话输入框**：需要 DOM 桥，稳定性差，**不推荐**——沿用 canvas/sidebar 的跨线纪律，不碰官方组件内部。

### 8.3 对话流里的 SSH 工具卡

为 `ssh_exec` 注册 `tool.call.toolview` 视图（§3.5）：

- 视觉对齐官方 terminal 卡片（同一套语义：命令行、输出区、退出码徽标）；
- 头部加**主机标识**（`label` + `user@host`）——这是 SSH 卡片区别于本地 bash 卡片的唯一必要差异；
- 折叠时一行摘要：`web-01 · systemctl status nginx · exit 0`；
- 危险级别高时在头部加警示标记；
- 注册项**不收 React node、不收 runtime service**（§3.5 原文限制），只能从 `block` 派生——数据必须在工具结果里带齐。

### 8.4 审批发生在哪（必须拍板的取舍）

Agent 触发的危险命令，审批卡出现在**官方对话流**里（`ui-approval` 的落点），**不在 SSH 页面里**。用户可能正在 SSH 页面看终端，却要在对话页点确认。

三个选项：

| 选项 | 做法 | 代价 |
|---|---|---|
| **A（推荐）** | 接受官方位置；SSH 页面时间线把该条标为「等待你在对话中审批」，点击跳转到对话视图 | 需要一次上下文切换 |
| B | SSH 页面另做确认 UI，批完再调 `ctx.approval` 走个形式 | **绕过官方审计语义**，且审批 UI 二义（两个地方都能批）；不推荐 |
| C | 等官方开放「审批 UI 可挂任意 slot」 | 不可控 |

第一版做 A。

**已核验的补充（2026-09-14）**：`dsh-client-ui-approval` 是「基于 Agent-scoped Remote Event waterfall 的浏览器审批界面」，它**接管 Conversation composer**、并「按需渲染关联的 Tool 详情」（`dsh-client-ui-approval/README.zh.md`:11）。两个推论：

- 审批是**抢占输入区**的呈现方式；人在 SSH 视图时 composer 不可见 ⇒ §8.1 的「点击跳转到待审批处」不是锦上添花而是**必需项**；
- 不要假设审批卡一定长着 SSH 的脸：工具详情走的是 §8.3 的卡片（未落地前是通用卡片）。所以**命令与主机必须同时出现在工具参数和 `reason` 里**。

---

## 9. 分期与门槛

| 阶段 | 交付 | 依赖 | 门槛 |
|---|---|---|---|
| **A0 上下文桥** | 选区送对话、错误一键追问、主机身份随消息 | 无平台新能力 | 纯前端 + 既有 API；不触碰 host 侧 |
| **A1 工具面 v1** | `ctx.tools` 注册、`ssh_hosts` + `ssh_exec` + `ssh_session_read`、exec 通道、输出预算 | SPIKE S1–S4 | **默认关闭**，config 显式开启；只读工具先跑通 |
| **A2 治理闭环** | 主机授权字段、命令分级、`ctx.approval` 接入、执行台账 | A1 | 危险命令拦得住、拒绝有结构化回执、审计可查 |
| **B 协作面** | Agent 活动时间线、对话流 SSH 卡片 | A2 | Agent 执行时人在 SSH 页面看得见 |
| **C 自主面** | 子代理承接多步运维任务、任务级目标 | B + §3.4 核验 | **独立安全评审**；不进第一版 |
| **D 接管模式** | Agent 驱动人的 PTY | C | 独立评审；默认关闭 + 强制指示 + 超时 |

**总开关设计**（沿用 appearance 线的硬契约风格）：

```yaml
- id: ssh
  name: "@miasaki/dsh-ssh"
  config:
    dataDir: ...
    agentTools: off        # off | readonly | full   —— 默认 off
    agentApproval: ask     # ask | never
    execTimeoutMs: 30000
    execMaxBytes: 262144
```

**`off` 时插件不注册任何工具**（不进 schema、不占 token、模型完全不知道 SSH 存在）。这与「关掉即原生」是同一条纪律。

---

## 10. 技术落点

| 文件 | 改动 |
|---|---|
| `index.js` | `inject` 增加 `tools`（可选读，`ctx.get`）；`agentTools` 开关分支；注册 `ssh_*` 工具；WS 桥新增 `agent-activity` 帧类型；新增 `/ssh/api/agent-audit`（读台账） |
| `lib/runtime.js` | 新增 `ExecChannel`（同 Client 多 channel、双上限、协作取消、并发闸门）；`RuntimeConn` 新增活动事件发射 |
| `lib/policy.js` | **新增**：命令分级规则表（纯函数，可单测） |
| `lib/store.js` | 连接模型新增 `agentAccess`；归一化 + 向后兼容（旧数据默认 `none`） |
| `lib/audit.js` | **新增**：`exec-audit.jsonl` 追加写与读取（无输出内容） |
| `lib/tools.js` | **新增**：`defineTool` 三个工具的声明与执行体（把工具定义从 `index.js` 拆出来，避免 `index.js` 继续膨胀） |
| `app.js` | Agent 活动时间线面板；选区发送；编辑器加 `agentAccess` 字段 |
| `session.js` | 无改动（保持「一个查看器独占一个 xterm + 一个 WS」的契约） |
| `client.js` | ⚠ 若 §8.3 的工具卡需要 client 侧 slot 注册，则在此增加；其余不动 |
| `styles.css` | 时间线面板样式 + 四档容器断点适配 + `--ssh-*` 令牌复用 |
| `test/` | policy 分级表、exec 通道（双上限/取消/连接死亡/并发）、store 迁移、工具 schema 形状、审批分支四态 |

**边界纪律**：工具定义放 `lib/tools.js` 而不是 `index.js`，与本线既有「纯数据层可单测」的分层一致（`lib/store.js` / `lib/runtime.js` 的模式）。

---

## 11. SPIKE 清单（评审通过后先做，全部失败即回退方案）

| 编号 | 验证项 | 失败后果 |
|---|---|---|
| **S1** | profile bundle 层的插件 `inject: ['tools']` 能否拿到服务、`register` 是否真的对**会话内的 agent** 可见 | 工具面整条路走不通；退守 A0 + B |
| **S2** | ✅ **已静态核实（2026-09-14）**：`exec.callId` 与 `exec.agent?` 均在（`dsh-tools/lib/types/index.d.ts:197–284`）。**剩余待验**：运行时 SSH 工具的常规调用路径上 `agent` 是否总被填充 | 若常为空，需另找 agent 关联通道；执行体已按「无 agent 即拒绝需审批操作」处理 |
| **S3** | `ctx.approval.request()` 在**插件自有工具**里的调用是否满足「open turn」前提、Web 端 `ui-approval` 是否确实应答 | A2 的审批退化，只能自建确认 UI（并失去官方审计） |
| **S4** | 同一 `Client` 上 `shell()` 与 `exec()` 并存是否稳定（多 channel、退出互不影响、连接死亡时 exec 正确结算） | 通道分离（J2）不成立，需改用独立 Client（成本大增） |
| **S5** | （对照实验）`ctx.terminals.registerBackend` 是否对外可用、SSH 后端是否真如 §3.3 判断那样别扭 | 若意外顺手，可重新评估是否复用官方会话语义 |
| **S6** | 官方 shell 工具的 **spill 约定**（超大输出如何落盘与提示），以便对齐 | 自造截断语义，与官方视觉不一致 |
| **S7** | 能否往 `ui-input-trigger` 注册 `@ssh` 引用 source（§8.2 路径 2） | A0 走剪贴板退化（路径 1），仍可用 |
| **S8** | `ctx.tools.restrict()` 能否把 SSH 工具收窄到指定 agent / 会话 | 只能全局注册，token 成本无法按会话裁剪 |

**S1 与 S4 是命门**：S1 决定「Agent 有没有手」，S4 决定「手干不干净」。这两个先做。

---

## 12. 验收矩阵

### A. 工具面

1. `agentTools: off` 时，模型上下文中**不存在**任何 `ssh_*` schema（用一次真实请求的前缀核对）；
2. `ssh_hosts` 只返回 `agentAccess !== 'none'` 的主机；`none` 主机即使模型猜到 id 也 `ACCESS_DENIED`；
3. `ssh_exec` 在已连接主机上执行成功，返回退出码与输出；**人的终端无任何变化**（同屏对照）；
4. 命令输出超过上限时正常截断并标 `truncated`；超大输出按 S6 的约定落盘；
5. 执行中取消（`exec.signal`）→ 远程收到 SIGINT、工具结算为取消态、无孤儿 channel；
6. Agent 执行期间人主动断开 SSH → 在跑的 exec 以明确错误码结算，不挂起、不泄漏。

### B. 治理

1. L0 命令在 `full` 主机免审批直通；
2. L1/L2 命令弹出官方审批卡，`reason` 中可见**主机与完整命令**；
3. 审批拒绝后工具返回结构化拒绝（**不抛异常、不中止轮次**）；
4. `agentAccess: 'readonly'` 主机上 L1/L2 **直接被拒**（不是「审批后放行」）；
5. 无应答者（`never` 策略）时失败关闭，操作为 `unavailable`；
6. `approval/asked|decided` 在会话日志中成对出现；
7. SSH 执行台账逐条可查，且**不含输出内容**；
8. 密码主机在无人连接过的情况下，Agent 发起 `ssh_exec` 得到 `NOT_CONNECTED` 而非任何凭据交互。

### C. 协作与可见性

1. Agent 执行时，SSH 页面时间线**实时**出现该条（含主机/命令/状态）；
2. 页面未激活时的执行，切回后有未读标记；
3. 对话流中 `ssh_exec` 渲染为专属卡片，头部有主机标识，折叠摘要一行可读；
4. 终端选区送对话带主机身份；粘贴/发送不触发任何执行。

### D. 回归（不得破坏 U0/U1）

1. 既有 60 例单测全绿；`verify-all ssh` 仍 12/12；
2. 三主题桥接、四档容器断点、焦点归还等 U1 验收项全部不回归；
3. 人的终端在主路径（连接/多标签/复制粘贴/查找/字号/专注）行为与改动前一致。

---

## 13. 待评审的取舍

1. **要不要做 A0（上下文桥）？** 它不依赖任何平台能力、风险最低、立刻消除信息孤岛；但它不属于严格意义上的「Agent 驱动」，可能被视为「不够解渴」。**推荐做**——它是后续所有层的地基，且单独就有价值。
2. **工具注册的默认姿态：`off` 还是 `readonly`？** `off` 最稳妥（零 token、零暴露），但需要用户改配置才能体验到；`readonly` 开箱即有感知，但每个会话都多付 schema token。**推荐 `off`**，与 appearance 线的「默认关闭、关掉即原生」一致。
3. **审批只能发生在对话页（§8.4 选项 A）能否接受？** 若不能接受，就必须自建确认 UI，代价是失去官方审计语义与单一审批真相。**推荐接受 A**，并把「跳转到待审批处」做顺。
4. **`ssh_exec` 是否允许隐式建连（key/agent 认证 + 已授权主机）？** 允许则 Agent 真正自主（人在授权时已经决策过），不允许则每次都要人先连。**推荐允许**，且把「允许隐式建连」做成主机级可选字段而非全局。
5. **v1 的工具数量**：三个（本方案）还是先只上 `ssh_hosts` + `ssh_exec` 两个？`ssh_session_read` 的价值（读人的现场）很高，但它是唯一「读人终端」的能力，需要单独想清楚隐私边界。**推荐三个一起上**，但 `ssh_session_read` 的输出在页面时间线里要显式标注「Agent 读取了你的终端」。

---

## 14. 明确不做

- **不在 `/ssh/` 内自建 Agent 对话**（J1）；
- **不让 Agent 共享人的交互式 PTY**（J2，除非 D 阶段的显式接管模式）；
- **不把连接凭据暴露成任何模型可调用的能力**（J3）；
- **不把命令正则宣传成安全边界**（J4）；
- **不做 `ctx.terminals` 后端**（§3.3，除 S5 意外翻案）；
- **不做服务器仪表盘**（沿用 plan §6：「CPU/内存/延迟均须有可靠数据源，不能伪装成免费静态信息」）；
- **不修改 DSH 本体、不改系统提示、不改模型请求、不篡改工具 schema**（沿用 canvas 红线）；
- **不在 v1 做子代理编排**（C 层，需独立安全评审）。

---

## 15. 证据索引

本线源码（相对本文所在的 `design/`）：

- [`../index.js`](../index.js)：`:25` `inject = ['webServer']`（现状唯一依赖）；`:9–18` 安全模型注释；`:110–189` REST API；`:192–228` WS 桥；`:230–249` 路由注册。
- [`../lib/runtime.js`](../lib/runtime.js)：`:47–149` `SshRuntime.connect`；`:151–229` TOFU 与 generation 绑定；`:231–261` `onReady` / `shell()`；`:263–292` `attach`；`:299–327` viewer 绑定路由（接管模式可复用）；`:387–467` `RuntimeConn`（回放环 / 背压）。
- [`../app.js`](../app.js)：`:383` `openEditor`（加 `agentAccess` 字段处）；`:1251` `buildSkeleton`（加时间线面板处）；`:1181` `pasteWithGuard`（选区发送的邻居）。
- [`2026-09-12-ssh-workspace-plan.md`](2026-09-12-ssh-workspace-plan.md)：§5 生命周期契约、§6 功能分层、§8 安全与错误恢复、§9 分期。

DSH 本体 0.1.5-rc.1（安装产物，`<dsh-install>/node_modules/@deepseek-ai/`）：

- `dsh-tools/README.zh.md`：注册 / schema DSL / restrict / guard / 执行流水线 / Token 影响。
- `dsh-user-approval/README.zh.md` + `lib/types/index.d.ts:60–127`：`ApprovalRequest` 形状、`allowed-once` 唯一授权、open-turn 前提、参数不随请求传递、审计对。
- `dsh-terminal/README.zh.md` + `lib/types/types.d.ts:37–153`：`TerminalBackend` 契约与 §3.3 的冲突依据。
- `dsh-subagent/README.zh.md`：具名提供方注册表、start/继续 API、所有权转移、发现面。
- `dsh-client-ui-tool/README.zh.md`：`tool.call.toolview` keyed slot、`ToolCallOwnerProps`、官方 terminal 卡片先例。
- `dsh-web-app/cordis.patch.yml`：`:224` approval、`:328` subagent、`:460` tools 的 host 平面归属；`:351–484` Agent 平面迁移与两条平面判据原文；`:252` `ui-approval` 挂载。
- `dsh-base/cordis.patch.yml`：`:33` session、`:67` agent、`:205` sandbox、`:224` approval、`:460` tools。
