# M1 基线 SPIKE 结论（§7.3 四项验证）

- 状态：已完成（2026-09-05）
- 环境：`@deepseek-ai/dsh@0.1.1-rc.2`，Windows 11，`dsh web` 于 `127.0.0.1:3080`
- 结论可信度：SPIKE-1/2/4 基于 `dsh-client-runtime/lib/client.js`（392 KB 打包源码，行号即该文件）与 dsh-synapse v0.4.1 源码；SPIKE-3 为本机实跑。

---

## SPIKE-1：fork API 形态与 seed 边界语义 ✅

fork 由**客户端**发起（Host 端只被动收投影事件），两层形态如下。

### 客户端 API（dsh-client-runtime，canvas 要调的）

```js
const childId = await ctx.sessions.fork({ sessionId, atSeq, increaseTitle: true })
```

- `atSeq`：**wire 只接受整数**（内部 `Math.floor`，`client.js:9089`）；`undefined` = 切到当前末尾。画布上取自锚点卡消息的 `sourceSeq`（投影事件 seq）。
- `increaseTitle: true`：自动给源会话标题加尾号（"标题 2"），并要求 fork 后子会话**立即可寻址**（`binding(childId)`）。
- 失败抛 `SessionForkError`（含 `fork-unavailable` 等结构化 code；源会话正在跑当前轮时会失败）。
- resolve 返回 `childId`（字符串）。

### Host 侧投影形态（index.js 依赖）

- fork 会话以 `session/created` 事件到达，`session.header.parentSession` = 父会话 id（DSH 原生单亲血缘），`session.header.seedLength` = seed 边界整数（**durable**，会话 restore 后仍在，`firstLiveSeq` 则会漂移——上游注释明确此点）。
- `session.firstLiveSeq`：子会话自有事件起点；投影 fork 会话时只投影 `seq >= firstLiveSeq` 的尾部（父历史已由父卡表达）。
- fork 与投影竞速：fork 的浏览器响应与 `session/created` 可能任一先到，`WorkspaceStore.branch()` 已做幂等合并（按 `dshSessionId` 认同节点），M2 merge RPC 直接复用该模式。

## SPIKE-2：注入首条消息走哪个 API ✅

```js
// client.js (canvas) 现成 prompt() 封装，M2 直接复用：
const scope = ctx.sessions.scope(sessionId)
const session = ctx.sessions.sessionOf(scope)
const result = await session.prompt([{ type: 'text', text }], 'queue')
// result.ok === false 时 result.error.message 可直接展示
```

- runtime `Session.prompt(content, mode, signal)`（`client.js:7196`）：`content` 是 blocks 数组（`{type:'text', text}` / `{type:'image',…}`）；`mode: 'queue'` 追加到当前轮之后排队，`'steer'` 打断当前轮。失败镜像进 snapshot 的 `promptError`。
- blank 会话（从未发过消息）首条 prompt 有专门处理（`firstPromptPendingTurn` + `onEngaged`），走同一 API 即可——**fork 出的新会话是 blank，prompt('queue') 就是其首条消息，无需任何额外初始化调用**。

## SPIKE-3：link 安装闭环 ✅（实跑通过，踩了两个坑）

```powershell
dsh plugin --profile web add link:C:\Users\Asakii\Desktop\dsh-miasaki\dsh-miasaki-canvas
dsh web   # link 模式改代码后重启 dsh web + 刷新页面
```

- `dsh plugin` 底层是 pnpm 管理 `~/.dsh/profiles/web`（pnpm 11.22），`link:` 直接注册为 pnpm link 依赖（`plugin list` 可见 `@miasaki/dsh-canvas link:C:/…`）。
- **坑 1**：`cordis.patch.yml` 的 `name` 字段是 **loader 用来 import 的 npm 包名**，不是显示名——写成 `canvas` 会让 dsh 启动即崩（`Cannot find package 'canvas'`）。必须填完整包名 `@miasaki/dsh-canvas`（scoped 名实跑可正常 import）。`id` 才是服务标识（与 index.js `export const name` 一致即可）。
- **坑 2**：client bundle 的 ModuleLoader 注册 `id` 必须**逐字等于包名**（`client.js:2`），否则前端启动报 `loaded without registering "@miasaki/dsh-canvas" via __ModuleLoader__.load`，整个插件不加载。
- 注入机制实测：前端 `window.__DSH_BOOT__.entries` 清单自动收录插件 client bundle（`/plugins/@miasaki/dsh-canvas/client.js?rev=…`），无需手改任何 DSH 侧配置。

## SPIKE-4：首条消息携带方式与时序 ✅

- **时序**：`fork()` resolve 时 child 已通过 `projectList()` 并入客户端会话列表（`client.js:9092`），`scope(childId)` / `sessionOf()` 立即可用，**fork → prompt 可以同步串行调用，无需轮询等待**。上游 app.js 的分支流（fork → 登记 → 追问）就是这个模式，M2 merge RPC 照抄时序。
- **长度上限**：客户端 runtime 对 `prompt` 文本无长度校验（blank check / image check 除外），内容直传 wire RPC。合并注入文本的实际上限由我们在 L2 构造时自控（锚点卡投影 ≤8000 字符 × 2 + 模板），无已知宿主瓶颈；Host 侧是否有隐藏上限留 M2 实测兜底（风险低）。
- **排队语义**：用 `'queue'`——fork 后立即发消息，若源线还有未完成轮次也不冲突；`'steer'` 不适合首条消息（会打断 fork 继承的生成上下文）。

## 附：改名换标识清单（M1 已落地）

| 层 | 上游 | 本插件 |
|---|---|---|
| 包名 | `dsh-synapse` | `@miasaki/dsh-canvas`（version `0.4.1-miasaki.1`） |
| patch id / 服务名 | `synapse` | `canvas` |
| 数据目录 | `$DSH_HOME/synapse/workspaces.json` | `$DSH_HOME/miasaki-canvas/workspaces.json`（决议：独立目录） |
| HTTP 路由 | `/synapse/…` | `/canvas/…` |
| postMessage 协议 | `source: 'dsh-synapse'` + `synapse:*` | `source: 'dsh-canvas'` + `canvas:*`（两端成对） |
| localStorage 前缀 | `dsh-synapse:*` | `dsh-canvas:*`（旧 key 数据自然弃用） |
| 品牌字符串 | `Synapse` | `Canvas`（UI 内仍保留「会话地图」入口名） |
| ModuleLoader id | `'dsh-synapse'` | `'@miasaki/dsh-canvas'`（= 包名，见坑 2） |

替换方式为词级机械替换（`dsh-synapse`→`dsh-canvas`、`/synapse`→`/canvas`、`synapse:`→`canvas:`、`synapse`→`canvas`、`Synapse`→`Canvas`），上游无 `synapseXxx` 复合标识符，app.js 原有 `canvas*` 标识符（canvasCamera 等）未受影响；`node --check` × 3 + 上游测试套件 64/64 通过。

## 附：DSH 升级风险注记（0.1.2+ 会破坏当前投影代码）

本机会话里对官方仓库的核对结论（画布投影可见）：官方 `v0.1.2-rc.1` 起 Session API 变更，将直接命中 index.js 三处——`session.events` 数组 → `snapshotEvents()`/`ownEvents()`；`session.firstLiveSeq` → `inheritedEventCount`；`session.header.seedLength`（整数）→ `header.isSeeded`（布尔，不再暴露位置整数）。`header.parentSession` 与 assistant/message 事件 v2 结构需升级后实测。当前基线锁定 0.1.1-rc.2 不受影响；升级 DSH 时按设计文档 §9 的对策处理（先 SPIKE 对照新包源码，改投影层适配）。

## M1 验收记录

- `npm test`：64/64 通过（含 v3→v4 迁移、fork 竞速合并、投影折叠等回归）。
- `dsh web` 启动无插件错误；`/canvas/`、`/canvas/api/*` 正常服务，旧 `/synapse/` 正确 404。
- 浏览器实测（IAB）：DSH 原生对话正常；顶部「对话 / 会话地图」切换可用；画布侧边栏（工作区/会话树）、卡片流（markdown/表格/工具折叠）、缩放/整理/定位控件、详情面板全部正常渲染；自动投影把 `~/.dsh/sessions` 的会话按 cwd 归组写入 `~/.dsh/miasaki-canvas/workspaces.json`（与上游 synapse 数据目录零共享）。
