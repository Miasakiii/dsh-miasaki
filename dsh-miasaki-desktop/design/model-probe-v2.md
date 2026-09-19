# 「测试连通性」v2 设计 — 真实可用性探测（B 档）

- 日期：2026-09-19
- 状态：**实施中**（设计定稿，host 插件与补丁升级同步落地）
- 前作：[`../../dsh-miasaki-shared-docs/cross/model-settings-toolkit-design-2026-09-07.md`](../../dsh-miasaki-shared-docs/cross/model-settings-toolkit-design-2026-09-07.md)（v1，落地 A 档；本文是它 §6.1-B 档与 §6.2 六分类的兑现）
- 归属：desktop 线（补丁 `patches/dsh-client-ui-settings-models/` + 插件 `plugins/dsh-model-probe/`）

## 1. 问题：A 档探测会把「能用的模型」报成错误

v1 补丁给设置页加了逐模型「测试连通性」按钮，实现是复用官方目录探测：

```js
operations.discoverModels(probe.settingsNs, { provider, baseURL, api, apiKey })
  → GET {baseURL}/v1/models?limit=1000   （api: anthropic-messages）
```

这问的是「网关能不能列出模型目录」，而按钮的语义是「这个模型能不能用」。两者不等价：

| 实例 | 对话（POST /v1/messages） | 目录探测（GET /v1/models） | 按钮显示 |
|---|---|---|---|
| `step`（StepFun Step Plan 订阅网关） | ✅ 200，有输出 | ❌ 401 | 「…answered 401; check the API key」 |
| `next`（知乎网关，anthropic-messages） | ✅ 可用 | 大概率 refused | 原样错误文案 |

用户在 `step/step-5-preview` 上正常对话，点「测试连通性」却得到 401 —— 这不是 key 的问题，是**探测端点与网关能力不匹配**。v1 设计稿 §6.2 已经写明「不能因 A 档失败就认为不通」，但当时只落地了两档文案，没有 B 档能力。

## 2. 目标与非目标

### 2.1 目标

1. 「测试连通性」测的是**对话可用性**：发一次真实的最小模型请求，成功即证明这条路能对话；
2. 结果是**六分类**可解释文案（v1 §6.2 的原目标），不再是原始 HTTP 报错串；
3. 探测**默认零消耗**：先用不产生生成的握手请求判定鉴权与端点，只有确认「鉴权通过」才发 1-token 生成请求；
4. 插件缺失时**自动降级**回 v1 的 A 档行为，补丁不打白；
5. 不改 DSH 本体包的服务端代码（只延续既有的 client bundle 补丁）。

### 2.2 非目标

- 不做批量体检/定时巡检（逐模型点按触发）；
- 不改「获取可用模型」按钮（A 档留在它该在的地方，语义正确）；
- 不引入思考强度、上下文等其他字段的校验（v1 已有）；
- 不写回任何配置（探测结果只存在于页面运行态）。

## 3. 架构

沿用本仓库已跑通的范式（`plugins/dsh-free-model-pool` 的 host 路由 + `dsh-miasaki-sidebar` 的信任栅栏）：

```
设置 → 模型 → 某模型行「测试连通性」（补丁改写的官方 client.js）
   │  POST /model-probe-api/probe   {provider, model, baseURL?, api?, apiKey?}
   ▼
host 插件 dsh-model-probe（Node 侧，inject: settings + webServer + credentials）
   ├─ 信任栅栏（Host/Origin/sec-fetch-site 三层，拒绝跨站与 DNS rebinding）
   ├─ 解析目标：客户端草稿值优先，缺省回落 settings.yaml 的 provider profile
   ├─ 取凭据：表单临时 key 优先，否则 credentials.resolve(apiKeyEnv)（再回落 process.env）
   └─ 两段式探测（Node fetch + AbortSignal.timeout）
   ▼
第三方网关  POST {root}/v1/messages | {base}/chat/completions | {base}/responses
   ▼
{ok, kind, status, latencyMs, detail, stage} → 客户端映射为本地化文案
```

为什么走 HTTP 路由而不是 typert remote：`registerModelDiscovery` 对同名命名空间**拒绝重复注册**（`DUPLICATE_DISCOVERY`），无法接管官方探测；而新增 remote 方法需要补丁 `dsh-llm` 核心服务类，补丁面与升级成本都远大于一个 host 路由。HTTP 路由是本仓库四条插件线已验证的形态（零构建、纯 JS、同源免 CORS）。

## 4. 探测协议（两段式）

### 4.1 请求构造

**URL 规则**（与 `dsh-llm-pi-ai` 的 `listingUrl()` 同源，保证与真实对话路径一致）：

| api | 对话路径 | 说明 |
|---|---|---|
| `anthropic-messages` | `POST {root}/v1/messages` | `root` = baseURL 去尾斜杠、再去掉一个尾部 `/v1`（gateway 两种写法都发布） |
| `openai-completions` | `POST {baseURL}/chat/completions` | baseURL 通常已含 `/v1` |
| `openai-responses` | `POST {baseURL}/responses` | — |
| 其他协议 | — | 直接返回 `unsupported`，不发请求 |

**鉴权头**：

| api | 头 |
|---|---|
| `anthropic-messages` | `x-api-key: <key>` + `anthropic-version: 2023-06-01` |
| openai 系 | `authorization: Bearer <key>` |

### 4.2 第①段：握手档（零 token 消耗）

故意发一个**必然被参数校验拒绝**的请求体（空 messages / 空 input）。绝大多数网关「先鉴权、后校验参数」，于是：

| 响应 | 结论 | 下一步 |
|---|---|---|
| 401 / 403 | key 无效或无权 | **终止**（不产生任何生成） |
| 400 | **鉴权已通过**、端点存在、参数被校验 | 进入第②段 |
| 200 | 网关不校验参数，也算可达 | 进入第②段 |
| 402 / 429 / 404 / 5xx | 额度、限流、路径、服务端问题 | 终止，按分类报 |

### 4.3 第②段：生成档（约 1 token 输出）

```json
{"model":"<id>","max_tokens":1,"messages":[{"role":"user","content":"ping"}]}
```

返回 200 即 `ok`（附耗时）；否则按同一张分类表判定。**只有握手判定「鉴权通过」才会走到这里**，所以 key 坏时全程零消耗，key 好时消耗约 1 token。

## 5. 结果分类（六分类 + 边界）

| kind | 判定 | 中文文案 | 英文文案 |
|---|---|---|---|
| `ok` | 生成档 200 | 可用 · {ms}ms | Reachable · {ms}ms |
| `unauthorized` | 401 / 403 | 认证失败——检查 API Key | Authentication failed — check the API key |
| `model-missing` | 400/404 且响应体指明模型不存在 | 模型 ID 未注册或拼写错误 | Model ID not registered or misspelled |
| `quota` | 402 | 额度不足或套餐过期 | Quota exhausted or plan expired |
| `rate-limited` | 429 | 触发限流，请稍后重试 | Rate limited — retry later |
| `timeout` | 超时（默认 15s） | 连接超时（{s}s） | Timed out after {s}s |
| `unreachable` | 连接失败 / DNS | 无法连接——检查地址与网络 | Cannot connect — check the URL and network |
| `bad-request` | 400（非模型问题） | 请求被拒——协议或参数不匹配 | Request rejected — protocol or parameters mismatch |
| `server-error` | 5xx | 网关内部错误（{status}） | Gateway error ({status}) |
| `unsupported` | 协议不支持探测 | 该协议暂不支持探测 | This protocol cannot be probed |
| `no-credential` | 无 key 可用 | 未找到 API Key，请先填写 | No API key — enter one first |
| `not-found` | 404 且响应体未提及模型 | API 地址不存在——检查地址 | Endpoint not found — check the API address |
| `unknown` | 其他状态码（418 等） | 探测未通过（HTTP {status}） | Probe did not pass (HTTP {status}) |
| `no-endpoint` | 既无草稿也无存储的 baseURL | 缺少 API 地址 | No API address configured |
| `no-model` | 模型 ID 为空 | 模型 ID 不能为空 | Model ID is required |

`detail` 字段携带原始响应体片段（截断 300 字符），供用户排查；不对 UI 主文案使用。

## 6. 降级策略（补丁侧）

```
点击测试
  ├─ POST /model-probe-api/probe
  │    ├─ 200 + {ok:true, result}      → 渲染分类结果
  │    └─ 非 200（404/403/405/5xx）/ 非 JSON / 网络失败
  │                                     → 视为「探测插件未就绪」，降级 ↓
  └─ A 档目录探测（v1 原逻辑）
       └─ 「可达 · 已在目录中列出」/「可达，但目录中未列出」/ 原样错误
```

> 判据是「HTTP 200 + 外层 `ok:true` + 存在 `result`」三者同时成立，而不是只判 404。
> 栅栏拒绝（403）、方法不符（405）、host 异常（5xx）都属「这条路走不通」，一并降级。
> 降级不是静默的：文案尾附「探测服务未就绪，已回退目录探测」，用户能看出看到的是旧口径。

## 7. 接口契约

### 7.1 `POST /model-probe-api/probe`

请求：

```jsonc
{
  "provider": "step",              // llm-pi-ai.providers 的路由键（可选）
  "model": "step-5-preview",       // 必填
  "baseURL": "https://…",          // 可选，表单草稿优先
  "api": "anthropic-messages",     // 可选，表单草稿优先
  "apiKey": "…"                    // 可选，表单里刚输入、尚未保存的 key
}
```

响应（HTTP 恒 200，业务结果在 body）：

```jsonc
{ "ok": true,  "kind": "ok", "status": 200, "latencyMs": 27, "stage": "generate" }
{ "ok": false, "kind": "unauthorized", "status": 401, "latencyMs": 12, "stage": "handshake",
  "detail": "invalid_api_key" }
```

### 7.2 `GET /model-probe-api/health`

`{ok: true, version: "…", protocols: ["anthropic-messages", …]}` —— 供补丁侧/运维判断插件是否已就绪。

## 8. 安全

- **信任栅栏**：Host 必须是 loopback 或配置的 `trustedHosts`；`sec-fetch-site: cross-site` 拒绝；存在 Origin 时必须与本机主机名一致（照搬 sidebar 三层实现）——防 DNS rebinding 与跨站触发；
- **凭据不回传**：host 从不把 key 写进响应；`detail` 里若出现疑似 key 一律替换为 `***`；
- **无副作用**：除一次模型调用外不改配置、不写文件（与 free-model-pool 的 `apply` 有本质区别）；
- **跨站风险余量**：即使栅栏被绕过，最坏后果是触发一次极小计费的模型调用，不泄露凭据。

## 9. 交付物

| 文件 | 作用 |
|---|---|
| `plugins/dsh-model-probe/lib/probe.js` | 纯逻辑：URL/请求体构造、状态分类（可单测） |
| `plugins/dsh-model-probe/lib/index.js` | 插件装配：栅栏、路由、凭据解析、两段式探测 |
| `plugins/dsh-model-probe/test/probe.test.js` | `node --test` 单测（URL 规则、分类表、截断与脱敏） |
| `plugins/dsh-model-probe/cordis.patch.yml` | bundle 挂载声明 |
| `patches/dsh-client-ui-settings-models/` | 补丁升级：`testModel` 改调探测端点 + 六分类文案 + A 档降级 |

## 10. 验收标准

**离线可自证**：

1. `node plugins/dsh-model-probe/test/probe.test.js` 全绿（18 例；注意不要用 `node --test`，
   受限沙箱下 runner 的 spawn 会 EPERM，见 §12.4）；
2. `node patch.mjs verify`（补丁规则从官方原版重建出逐字节一致的产物）；
3. `node scripts/verify-all.mjs desktop` 全绿。

**实机验收（用户侧）**：

1. 安装插件 + 重启 host 后，`GET /model-probe-api/health` 返回 ok；
2. `step/step-5-preview` 点「测试连通性」→ 显示**绿色「可用 · Nms」**（这正是 v1 报 401 的那一项）；
3. 故意把 API Key 改错 → 显示「认证失败——检查 API Key」，且**不产生生成调用**（握手档 401 即终止）；
4. 把模型 ID 改错 → 显示「模型 ID 未注册或拼写错误」；
5. 停用插件（或不重启）→ 按钮自动降级为 v1 的目录探测文案，并带「探测服务未就绪」提示。

## 11. 风险

| 风险 | 处置 |
|---|---|
| 个别网关对非法参数返回 401（把校验失败当鉴权失败） | 握手 401 直接判 unauthorized；若实测发现误判，可加「握手 401 后再发一次生成档确认」的兜底开关（记为后续项） |
| 计费敏感用户不愿产生任何调用 | 握手档本身零消耗；生成档仅 1 token 输出，且仅在鉴权通过后发生。后续可加「仅握手」开关 |
| 插件未随 profile 安装 | 补丁侧降级路径保证功能不缺失（见 §6） |
| DSH 升级覆盖 client bundle | 补丁已在 `patches/` 入库，`patch.mjs status` 可判别，按 README 重打 |

## 12. 实施记录（2026-09-19 落地）

### 12.1 文件清单

| 动作 | 文件 |
|---|---|
| 新增 | `plugins/dsh-model-probe/package.json`、`cordis.patch.yml`、`README.md` |
| 新增 | `plugins/dsh-model-probe/lib/probe.js`（纯逻辑）、`lib/index.js`（装配）、`lib/index.d.ts` |
| 新增 | `plugins/dsh-model-probe/test/probe.test.js`（18 例） |
| 修改 | `patches/dsh-client-ui-settings-models/patch.mjs`（edit #1/#3/#6/#7 内容 + 稀疏数组守卫 + `PATCHED_SHA256`） |
| 修改（v2.1） | `patch.mjs` 再增：locale 尾逗号修复、`assertParses` 语法闸门、`replaceLine` 字典不变量、`PATCHED_SHA256` 自洽校验、`status` 语法维度、`resync` / `rebuild` 两个模式 |
| 重生成 | `patches/dsh-client-ui-settings-models/baseline/client.patched.js` |
| 修改 | `patches/dsh-client-ui-settings-models/README.md`、`README.md`（desktop 线）、`design/CHANGELOG.md` |
| 修改 | `scripts/verify-all.mjs`（desktop 计划新增 3 项） |

### 12.2 产物指纹

| 项 | 变化 |
|---|---|
| 官方原版 client.js | 未变（`138,937 B`，SHA-256 `A60FD863…`）——本次是补丁规则升级，不是 DSH 升级 |
| 补丁产物 | `144,576 B / E602C1F1…` → `148,922 B / C6C1DCBC…` → **`148,924 B / F1717A07…`**（v2.1 修复，见 12.4 教训 3） |
| 安装目录 | 已 `resync`（由 `.dsh-bak` 重打），`patch.mjs status` = `patched (F1717A07…)` + `语法 合法`，与 baseline 一致 |
| 回滚路径 | `<client.js>.dsh-bak` 保持为官方原版（SHA 未变），`revert` 随时可用 |

### 12.3 验证输出

```
node plugins/dsh-model-probe/test/probe.test.js   → tests 18 / pass 18 / fail 0
node patch.mjs verify                             → PASS（重建逐字节一致 + 语法闸门 + PATCHED_SHA256 自洽，F1717A07…）
node scripts/verify-all.mjs desktop               → PASS desktop: 11/11
全量语法复扫（4 个本体补丁目标 + 10 个自研插件）   → 15 个 bundle，语法不合法 0 个
```

### 12.4 实施中的三个真实教训

1. **稀疏数组陷阱**：编辑规则里手写数组时漏一个逗号会形成 `[a,,b]`——语法合法
   （`node --check` 放行），但 `applyPatch` 会在几百行之外抛
   `Cannot read properties of undefined (reading 'trim')`。已在 `applyPatch` 入口加守卫，
   当场报出「`<edit id>`: lines 含非字符串项」。
2. **单测命令不能用 `node --test`**：`--test` 的 runner 会为每个测试文件 spawn 子进程并用管道
   捕获 stdio，在受限沙箱下以 `spawn EPERM` 失败（本仓库 `verify-all.mjs` 早已为同一原因
   改成「直接跑测试文件 + `stdio: 'inherit'`」）。故插件的 test 脚本用
   `node test/probe.test.js`（同进程执行，退出码语义不变）。
3. **「可复现」不等于「合法」——最贵的一课**：locale 字典（edit #6/#7）在 en / zh 各漏一个
   尾逗号，产物在 `testProbeOk` 处语法错误。由于 `verify` 当时只做逐字节比对
   （规则错 → 产物错 → golden 也错，三者一致），**PASS 照旧、apply 照常写入**，
   而 client bundle 是多包合并产物 ⇒ 一个包语法坏了，**整份 bundle 不注册，页面所有插件一起失效**。
   已加**语法闸门**（`applyPatch` 出口 `vm.Script`，三条路径自动继承）+ `replaceLine` 字典的
   尾逗号不变量 + `verify` 的 `PATCHED_SHA256` 自洽校验 + `status` 的独立语法维度 + `resync` 模式。
   写法上要记住：**发出的逗号写在字符串内部**（`'\t\t\tkey: "value",'`），
   行尾那个逗号只是数组元素分隔符，两种写法在阅读工具里肉眼几乎相同。
   完整复盘见 [`../patches/dsh-client-ui-settings-models/README.md`](../patches/dsh-client-ui-settings-models/README.md) §产物不变量。

### 12.5 实机结果

**插件已装、待 host 重启验收**（截至 2026-09-19 本会话结束时）：

- `%USERPROFILE%\.dsh\profiles\web\package.json` 已加入 `dsh-model-probe`（`dependencies`
  的 `file:` 依赖 + `dsh.profile.bundles` 列表），profile 目录 `pnpm install` 完成（`+1` 包）；
- 落盘核对：`node_modules/dsh-model-probe/` 的 `package.json` / `lib/index.js` / `lib/probe.js` /
  `lib/index.d.ts` / `cordis.patch.yml` / `README.md` 与源目录 SHA-256 **逐一致**
  （`test/` 未随包复制，因 `files` 只声明 `lib` + `cordis.patch.yml`——这是预期，测试只在仓库内跑）；
- **重启前探测**：`GET http://127.0.0.1:3080/model-probe-api/health` → **404**
  （路由尚未注册，符合预期）。这同时确认了降级路径的现实前提：此刻点按钮会走 v1 目录探测；
- **待用户执行**：重启 `dsh web`（会中断当前 GUI 会话，故不由 agent 代劳）→ 刷新页面 →
  按 §10 实机清单验收。重启后 `health` 应返回 `{"ok":true,…}`。

