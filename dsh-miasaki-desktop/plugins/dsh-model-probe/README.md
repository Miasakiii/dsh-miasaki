## DSH 插件：模型连通性探测（`plugins/dsh-model-probe/`）

DSH web profile bundle，**host only**（无 client 半侧）。为设置页「测试连通性」按钮提供
**真实可用性探测**：发一次真实的最小模型请求，而不是问网关要模型目录。

| 项 | 值 |
|---|---|
| 服务 id | `model-probe` |
| 包名 | `dsh-model-probe` |
| 平台 | host only（无 client bundle、不注册 slot） |
| 注入服务 | `settings`、`webServer`（`credentials` 经 `ctx.get` 可选获取） |
| 单测 | `node test/probe.test.js`（18 例，纯逻辑、无网络） |

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

### 结果类别

`ok`（附耗时）/ `unauthorized` / `model-missing` / `quota` / `rate-limited` /
`timeout`（15s）/ `unreachable` / `bad-request` / `server-error` / `unknown` /
`unsupported`（协议不支持探测）/ `no-credential` / `no-endpoint` / `no-model`。

host 只回稳定 `kind`，**文案在客户端本地化**（中英各一份），两语言不会漂移。

### 支持的协议

| api | 探测路径 |
|---|---|
| `anthropic-messages` | `POST {root}/v1/messages`（`root` = baseURL 去尾 `/v1`，与对话路径同规则） |
| `openai-completions` | `POST {baseURL}/chat/completions` |
| `openai-responses` | `POST {baseURL}/responses` |
| 其他 | `unsupported`，不发请求 |

### 凭据与安全

- 凭据优先级：**请求体里的表单临时 key**（尚未保存的新 key）→ `credentials.resolve(apiKeyEnv)`
  （即 `.credentials.yaml`，Models 页写入处）→ 进程环境变量；
- **key 永不回传**：响应里的 `detail` 已经过两遍脱敏（精确匹配本次 key + `sk-`/长串通配）；
- **信任栅栏**：Host 必须是 loopback 或 `trustedHosts` 配置项；`sec-fetch-site: cross-site`
  拒绝；存在 Origin 时必须与本机主机名一致（与 sidebar / canvas 的 `/api` 栅栏同构）。
  防的是 DNS rebinding 与跨站触发，不是鉴权；
- **无副作用**：除一次极小模型调用外，不改配置、不写文件（这与 `dsh-free-model-pool`
  的 `apply` 有本质区别）。

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
node test/probe.test.js                 # 18 例纯逻辑单测（判定表 / URL 规则 / 脱敏）
node ../../../scripts/verify-all.mjs desktop   # 已并入 desktop 线回归
```

实机项（插件加载 / 真实网关探测矩阵 / 降级路径）见
[`../../../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md`](../../../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)。

### 文件

- `lib/probe.js` — 纯逻辑：URL 构造、请求体构造、状态分类、脱敏（可单测、无 I/O）
- `lib/index.js` — 插件装配：信任栅栏、路由、凭据解析、两段式探测
- `lib/index.d.ts` — 类型声明
- `test/probe.test.js` — 判定表单测
- `cordis.patch.yml` — bundle 挂载声明
