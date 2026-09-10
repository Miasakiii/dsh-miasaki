# 变更记录 — dsh-miasaki-dual-model

## 2026-09-10

### M1 实现（首次落代码）

**新增插件 `@miasaki/dsh-dual-model`**（`link:` 方式装入 DSH web profile）：

| 文件 | 职责 |
|---|---|
| `index.js` | Host 半：提供 `dualModelVisionRoute` 可选服务、每步图片上下文、`agent/request` 路由、`/dual-model/api/*` JSON 路由 |
| `client.js` | Client 半：`conversation.input.right` 控件（状态点 + 辅助模型选择 + 图片归属状态行） |
| `lib/content.js` | 图片内容检测，与官方 `contentHasImage` 同语义（含 `tool-result` 嵌套下钻） |
| `lib/routing.js` | 路由决策纯函数：`normalizeRoute` / `decideRoute` / `applyRoute` / `supportsImage` |
| `lib/capability.js` | 图片能力真值源读取 + TTL 缓存 + 事件失效 |
| `lib/store.js` | 插件自有配置的原子持久化（不依赖 DSH settings 服务） |
| `test/` | 24 项单测（路由决策 / 内容检测 / 配置归一化与往返） |

**关键技术决策与依据**：

1. **路由判据取自 `agent/pre-step` 而非 `agent/request`**。官方 `prepareRequest` 的契约是
   "Resolve request config ... **before admitting model-visible input**"，即 `agent/request`
   触发时本步新消息尚未进入 Session，那里读不到图。`agent/pre-step` 的 payload 带本步消息，
   历史由 `session.deriveMessages()`（官方组装请求用的同一个调用）补齐。
   → 该设计同时天然覆盖了「同 turn 后续步骤」与「后续 turn 引用旧图」两种粘住场景，
   且图片被 compaction 清理后会自动回落到主模型，无需额外的粘住状态机。
2. **切换时清空继承的 `reasoningEffort`**：官方 `resolveCallConfig` 对"模型不支持的努力等级"
   是硬拒绝（reject before provider I/O），与官方 `installModelSelection` 的处理一致。
3. **不依赖 `@deepseek-ai/schemastery`**：本插件以 `link:` 装载时该包不在其模块查找链上
   （Node 按符号链接真实路径解析），一旦解析失败会拖垮整个 profile 的加载。改用自持久化，
   与 sidebar / ssh 两条线的既有约定一致。
4. **client 半无 `host.call`**：正式插件的 client bundle 由 `window.__ModuleLoader__.load` 装载，
   通信走同源 JSON 路由 `/dual-model/api/*`（`fetch`），且不能 require 第三方包。

**新增运行时补丁 `patches/dsh-api-session-controller/`**：

- 把 `session.prompt` 的图片准入判定委托给 `dualModelVisionRoute` 可选服务；
- **零退化**：服务不存在时走与原生逐字节相同的分支（含错误信息），裸 DSH 行为不变；
- 1 条编辑（`replaceRange`，2 行 → 12 行），规则 + 双基线入库，`patch.mjs verify` 离线自证；
- 基线：DSH `0.1.5-rc.1`，原始 `16ECB48F…` → 补丁后 `58574E8A…`。

**M1 落地状态**：补丁**已应用**到安装目录（`patches/dsh-api-session-controller` 的 `status` 为 `patched`，
备份 `.dsh-bak` 可 `revert`）；插件**已注册**进 `%USERPROFILE%\.dsh\profiles\web`（`link:` 依赖 + `dsh.profile.bundles`，
符号链接已建立）。**重启 `dsh web` 后 host 半与补丁同时生效**（两者都只在启动时加载）。

### M0 验证（同日早些时候）

用动态 Cordis 插件在真实运行环境实测六项技术假设，**全部成立**：

| # | 假设 | 结论 |
|---|---|---|
| 1 | `agent/request` 可被插件在 agent scope 挂上 | 6 个 live agent 全部挂上并捕获到真实触发 |
| 2 | `conversation.input.right` 可挂载渲染 | client 组件挂载并回调 host 3 次 |
| 3a | host↔client 能力通道 | `harness.handle` ↔ `host.call` 可用 |
| 3b | `ctx.provide` 作为补丁读取通道 | 可用，**异步生效**（不影响补丁：读取发生在用户交互时） |
| 4 | Agent 注入 API 存在 | `followup` / `steer` / `inject` / `send` / `cancel` 齐备 |
| 5 | 能力真值源可用 | `resolveModelInfo().inputModalities` 正常返回 |

**顺带实测出的环境事实**：9 个 provider / 59 个模型中，`openrouter` 的 **21 个免费模型全部不支持图片**
（`visionCount: 0`）—— 这正是本功能的目标场景；另有 16 个视觉模型可用。所有模型的
`inputModalities` 均非 `undefined`，即准入判定是确定性的。

### 设计定稿

- `design/2026-09-10-dual-model-design.md`：现状取证（带源码行号）、核心冲突分析、
  三条准入路线对比与补丁形态选型、架构与 UI 设计、风险清单、分期计划、M0 实测结果。

**准入路线复议记录**：最初选定「客户端分流、零补丁」，实现层推演发现不可行
（`conversation.input.right` 是加法槽，只能加控件不能接管提交；能接管提交的只有
`conversation.composer`，需重写整个输入框），遂复议为「一行本体补丁 + 可选服务探测」形态。
