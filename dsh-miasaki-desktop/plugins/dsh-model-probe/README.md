## DSH 插件：模型连通性探测（`plugins/dsh-model-probe/`）

DSH web profile bundle，**host only**（无 client 半侧）。为设置页「测试连通性」按钮提供
**真实可用性探测**：发一次真实的最小模型请求，而不是问网关要模型目录。

| 项 | 值 |
|---|---|
| 服务 id | `model-probe` |
| 包名 | `dsh-model-probe` |
| 平台 | host only（无 client bundle、不注册 slot） |
| 注入服务 | `settings`、`webServer`（`credentials` / `llm` 经 `ctx.get` 可选获取） |
| 单测 | `node test/probe.test.js`（45 例：判定表 / `sameOrigin` 凭据边界 / 围栏与路由准入，假 fetch 不出网）+ `node test/settings-read.test.js`（12 例：双轨 helper 契约 + probeModel 存储档案解析接线） |

### 为什么需要它

v1 的「测试连通性」复用官方目录探测（`GET {baseURL}/v1/models`），问的是
「网关能不能列出模型目录」，而按钮的语义是「这个模型能不能用」。两者不等价：

| provider | 对话 `POST /v1/messages` | 目录 `GET /v1/models` | v1 按钮显示 |
|---|---|---|---|
| `step`（StepFun Step Plan） | ✅ 正常 | ❌ 401 | 「…answered 401; check the API key」 |
| `next`（知乎网关） | ✅ 正常 | refused | 原样错误串 |

本插件把按钮改成问对的问题，并把答案分成可解释的类别。设计与判定表见
[`../../design/model-probe-v2.md`](../../design/model-probe-v2.md)。

### 行为：两段式探测

```
POST /model-probe-api/probe  {provider, model, baseURL?, api?, apiKey?}
  │
  ├─ ① 握手档（零 token 消耗）
  │     body 故意非法：messages: [] / input: ""
  │     401/403 → unauthorized     ← 到此结束，不产生任何生成
  │     400     → 鉴权已通过、端点存在、参数被校验 → 进入 ②
  │     其他    → 按分类返回
  │
  └─ ② 生成档（约 1 token 输出）
        {model, max_tokens: 1, messages: [{role:"user", content:"ping"}]}
        200 → ok（附耗时）
```

**key 坏时全程零消耗**——这是把它做成两段而不是一次生成请求的全部理由。

**响应契约**：外层 `ok` 表示「探测执行了」，内层 `result.ok` 表示「模型可用」。
两者刻意分开：客户端必须能区分「插件没装（HTTP 404）」与「模型回了 401」，
否则就会在另一个地方重建 v1 的那个 bug。

```
GET /model-probe-api/health
  → {ok: true, version, protocols: [...], timeoutMs}
```

### 批量能力查询（v0.2.0，2026-09-22）

```
POST /model-probe-api/capabilities  {provider, models: ["id", ...]}
  → {ok: true, models: {"<id>": {image: bool, reasoning: bool}, ...}}
```

为模型页补丁的**能力徽标**（视觉 / 推理）供数。读法与 composer 选模型的器、
dual-model 的视觉路由**同一真值源**——`llm.resolveModelInfo(provider, model)`：
`inputModalities` 含 `image` 即视觉，适配器声明了 `reasoning` 块即有可调思考强度。

- **零成本**：适配器本地解析，不发任何提供商请求、不需要凭据；
- **缺元数据不猜**：解析不到 / 适配器抛错 → `{image:false, reasoning:false}`（无徽标）；
- **可选依赖**：`llm` 经 `ctx.get` 获取；host 没有该服务或路由 404（插件未装 / 未重启）时
  客户端静默不渲染徽标，与探测降级同构；
- 批量上限 200 个 id，顺序解析（适配器本地操作，无需并发）；
- 准入围栏（connection 准入 + 结构围栏）与脱敏同上（本路由其实不需要凭据）。

### 结果类别

`ok`（附耗时）/ `unauthorized` / `model-missing` / `quota` / `rate-limited` /
`timeout`（15s）/ `unreachable` / `bad-request` / `server-error` / `unknown` /
`unsupported`（协议不支持探测）/ `no-credential` / `no-endpoint` / `no-model`。

`no-credential` 有两种成因：已存凭据读不到；或请求自带的 `baseURL` 与已保存端点
不同源又没有显式 `apiKey`（此时按凭据边界直接收手，不发请求 —— 见下节）。

host 只回稳定 `kind`，**文案在客户端本地化**（中英各一份），两语言不会漂移。

### 支持的协议

| api | 探测路径 |
|---|---|
| `anthropic-messages` | `POST {root}/v1/messages`（`root` = baseURL 去尾 `/v1`，与对话路径同规则） |
| `openai-completions` | `POST {baseURL}/chat/completions` |
| `openai-responses` | `POST {baseURL}/responses` |
| 其他 | `unsupported`，不发请求 |

### 凭据与安全

**凭据边界（2026-10-19，P1 修复）**：`probeModel()` 只在这两种情况下复用**已存凭据**
（`credentials.resolve(apiKeyEnv)` → 进程环境变量）：

1. 请求**未给** `baseURL` —— 目标只能是 profile 里已保存的端点；
2. 请求 `baseURL` 与 profile `baseURL` **同源** —— `sameOrigin()` 比较 scheme + host + port
   （默认端口规范化；URL 解析失败、非 http(s) 一律判不同源，fail closed）。

草稿 `baseURL` 指向其它源时**必须**由请求体显式带 `apiKey`；缺失则返回
`{ok:false, kind:'no-credential'}` 且**一个请求都不发**（连凭据都不读取）。修的是
「已保存的 key 被附加到调用方指定的 SSRF 目标」：修复前任何能打通 exact 路由的页面
都能让 host 带着用户的已存 key 去请求任意地址。取舍：**不禁止回环 / 私有网段** ——
本地模型探测（`http://127.0.0.1:…`）是正当用例，禁止会把主用例废掉；协议只认 http(s)。

- 凭据优先级：显式 `request.apiKey` →（边界允许时）`credentials.resolve(apiKeyEnv)`
  → 进程环境变量；
- **key 永不回传**：响应里的 `detail` 已经过两遍脱敏（精确匹配本次 key + `sk-`/长串通配）；
- **准入两层（2026-10-19，P1 修复）**：`/model-probe-api/*` 是 `kind: 'exact'` 路由，
  不经过内核 `/api` 的准入链，所以每个请求**逐请求**读 `ctx.get('connection')`：
  1. composition 提供 `connection.requestRejection` 时以它为准（与内核 `/api` 同级：
     信任围栏 + 浏览器鉴权 cookie）—— `401` / `403` 原样返回，`undefined` 放行；
     抛错或给出其它值退回结构层（异常不得开闸）；
  2. 服务缺席时退回**结构围栏**：Host 必须是 loopback 或 `trustedHosts`；
     `sec-fetch-site: cross-site` 拒绝；存在 Origin 时必须与 Host **同 hostname 且同端口**
     （2026-10-19 补端口判据：`Origin: http://127.0.0.1:5173` + `Host: 127.0.0.1:3080`
     现在拒绝）；Origin 被 Chromium 剥掉端口时退回 hostname 判据，避免误拒正常请求；
     `Origin: null`（opaque）拒绝。
  - 围栏排在 method 检查与业务之前；`connection` **不做 apply 时快照**（该服务可能
    比本插件晚 provide）。
- **无副作用**：除一次极小模型调用外，不改配置、不写文件（这与 `@miasaki/dsh-free-model`
  的 `apply` 有本质区别）。

### settings 读取双轨（v0.2.1，2026-09-23）

已保存行的 `baseURL` / `api` / `apiKeyEnv` 从 `llm-pi-ai` 配置解析（请求体只带
草稿值——Models 页对未保存的新平台才随请求发 baseURL）。DSH 0.1.7 重写设置机制：
`ctx.settings.get(ns)` 在全树移除，服务本身还在（`inject: ['settings']` 仍过得去），
读取改走 `describe()`（每个带 volatile Config 字段的 profile 条目一项，`ns` = 条目 id、
`value` = 解析值）。`lib/settings-read.js` 按 `typeof settings.get === 'function'`
探针分轨：

| 宿主 | 读取 | 写路径 |
|---|---|---|
| ≤0.1.6 | `settings.get(ns)`（已注册命名空间） | `settings.update(ns, patch)` 同名同义 |
| 0.1.7+ | `settings.describe().find(d => d.ns === ns).value` | 同上（只受理 volatile 字段，`providers` 正是） |

双轨而非版本探测的依据与 dual-model 的失效信号双轨同源：cordis 上访问一个不存在的
服务方法是 `undefined`，`typeof` 探针在两代宿主上各自命中。**不双轨的后果**（2026-09-23
线上实测）：0.1.7 上 `ctx.settings.get is not a function` 被 `resolveProfile` 的
try/catch 吞掉 → 已保存行探测静默退化成 `no-credential` / `no-endpoint`。

### 安装

同其它 profile bundle —— `%USERPROFILE%\.dsh\profiles\web\package.json` 的
`dependencies` + `dsh.profile.bundles` 加 `dsh-model-probe`（file: 依赖），
profile 目录 `pnpm install` 后 **host 重启**生效（web bundle 图重建）。

改动源码后：file: 依赖在 profile 顶层 node_modules 是普通拷贝 —— 小改动直接
`cp` 覆盖顶层对应文件（或删顶层目录再 `pnpm install`），**落盘完成后再重启 host**。

> 补丁侧不依赖本插件是否安装：路由 404 时「测试连通性」自动降级回 v1 的目录探测，
> 并在文案尾附「探测服务未就绪，已回退目录探测」。

### 验证

```powershell
node test/probe.test.js                 # 45 例：判定表 / sameOrigin 凭据边界 / 围栏与路由准入
node test/settings-read.test.js         # 12 例双轨读取（helper 契约 + probeModel 接线）
npm test                                # 上两条
node ../../../scripts/verify-all.mjs desktop   # 已并入 desktop 线回归
```

**凭据边界与准入的对抗用例**（`test/probe.test.js`，全部用假 fetch / 假 webServer，
不出网）：不同源 `baseURL` + 无 `apiKey` → `no-credential` 且 fetch 零调用（凭据存储也
零读取）；同源 → 复用已存 key；显式 key → 照常发到指定目标；`requestRejection` 的
401/403/undefined/抛错/缺席五种判定；跨端口 Origin → 403；围栏先于 method 检查；
`connection` 晚 provide 后同一路由立即按新判定走。

实机项（插件加载 / 真实网关探测矩阵 / 降级路径）见
[`../../../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md`](../../../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)。

### 文件

- `lib/probe.js` — 纯逻辑：URL 构造、`sameOrigin()` 凭据边界判定、请求体构造、状态分类、脱敏（可单测、无 I/O）
- `lib/settings-read.js` — settings 读取双轨（≤0.1.6 `get` / 0.1.7 `describe`）
- `lib/index.js` — 插件装配：两层准入围栏（`trustFence`：connection 准入 + `structuralFence`）、路由、凭据边界、两段式探测、批量能力查询；`sameOrigin` 经此再导出
- `lib/index.d.ts` — 类型声明
- `test/probe.test.js` — 判定表 + 凭据边界 + 准入围栏单测（假 fetch / 假 webServer，不出网）
- `test/settings-read.test.js` — 双轨读取单测（含 probeModel 存储档案解析接线）
- `cordis.patch.yml` — bundle 挂载声明
