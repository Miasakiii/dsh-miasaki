# M3 官方 Runtime 评估报告

- 日期：2026-08-16
- 评估者：总指挥（Miasaki 会话）
- 对象：`@deepseek-ai/dsh-subagent-dsh-sdk@0.0.1-rc.1` + SDK/JSON-RPC 协议线（仓库 `vendor/deepseek-harness`，master 8-13 快照）
- 方法：官方仓库自带 keyless 测试（mock LLM，零 API key），在 Windows 11 本机执行
- 结论速览：**成功路径达成。官方进程外 subagent 后端在 Windows 实测通过，`dsh-subagent-dsh-sdk` 定为 M3.5 的 worker runtime；自研薄壳退役。** 同时发现 1 个官方测试工具链的 Windows bug（已本地热补丁）与 1 个平台能力缺口（终端持久化检查）。

---

## 1. 测试证据

| # | 测试 | 结果 | 验证内容 |
|---|---|---|---|
| A | examples/jsonrpc-agent/tests/keyless-smoke.e2e.ts | **4/4 通过**（21.6s） | 子运行时协议：initialize 握手 / session.prompt / turn/end（max-tokens 三种映射）/ 工具清单（bash,edit,read,subagent,todo_write,write）/ shutdown / zstd 会话持久化（魔数 28b52ffd）；非法 env 值 fail-loud |
| B | examples/jsonrpc-agent/tests/sdk.snapshot.ts | **3/4 通过**（热补丁后） | 真实 `@deepseek-ai/dsh-sdk-client` 驱动真实 runtime：text-turn ✓ / bash-tool 真实执行 ✓ / subagent-spawn-in-process 委派 ✓；persistent-tools ×（见 §2.2，平台能力缺口） |
| C | packages/subagent/subagent-dsh-sdk/tests/loader-composition.e2e.ts | **1/1 通过**（7.9s） | **进程外后端全链路**：父 harness 经真实 Loader 组合 SDK 后端（cwd 省略=继承分支）→ spawn 完整第二个 harness 运行时（stdio JSON-RPC）→ 委派一次 → 子进程回显 cwd = 父会话 workspace（断言两者一致）→ 父 tool/result 与子会话日志双侧校验 → dispose 干净退出（stderr 无 UNHANDLED） |

执行环境备注：git clone 遇 schannel TLS 凭证问题（本机环境，非仓库问题），用 openssl 后端绕过；pnpm install 需 full-access（koffi/node-pty 原生构建 spawn）；vitest 运行需 full-access（子进程管道）。日志存档：`tests/m3-acp/logs/`。**后续在 vendor 仓库重装依赖前先设 `LEFTHOOK=0`**，防止 lefthook postinstall 再次污染全局 git hooks 目录。

## 2. Windows 发现（对照 t-0001 的待实测项）

### 2.1 官方测试工具链 Windows bug（已本地热补丁，建议上游反馈）
- 位置：`examples/jsonrpc-agent/tests/sdk.snapshot.ts` `hydrateReplayFixtures`
- 症状：fixture 水合时 `replaceAll('{{cwd}}', cwd)` 未做 JSON 转义，Windows 反斜杠路径注入 JSON 头行 → `SyntaxError: Bad escaped character in JSON at position 91`，replay 模式整体不可用
- 影响面：所有 replay 快照测试在 Windows 全部失败（B 全挂的原因）；macOS/Linux 路径无此问题，所以官方未暴露
- 热补丁：`replaceAll('{{cwd}}', JSON.stringify(cwd).slice(1, -1))`（本地评估用；符合上游应走正式修复）
- 已反馈官方：GitHub Discussions [#2477](https://github.com/deepseek-ai/deepseek-harness/discussions/2477)（2026-08-16，含最小修复；检索确认此前无人反馈该问题）

### 2.2 平台能力缺口（非 bug，官方已知边界）
- persistent-tools 场景依赖 `subprocess-local` 的终端持久化检查，win32 明确不支持（`terminal inspection is unsupported on platform win32`）；官方 AGENTS.md 规定 fixture 仅保证 macOS/Linux 重放
- 对我们设计的影响：worker 子组合若含终端持久化类能力，Windows 上应排除或替换

### 2.3 dispose 阶梯（t-0001 待实测项②）
- **实测通过**：测试 C 中父/子两个完整 runtime 的 spawn→shutdown→退出全程干净（stderr 无 UNHANDLED，exit 0）。官方 shutdown 交换 + stdin-EOF→SIGTERM/SIGKILL 阶梯在 Windows 正常。

### 2.4 双版本线 cordis 兼容（t-0001 待实测项①）
- m3-test profile 装 0.0.1-rc.1 后，主包 rc.6 的本 GUI 会话持续正常运行；两条线在本机**相互独立共存**未观察到冲突。
- 正式判定仍保守：仓库内部版本自洽 ≠ 与 rc.6 主包可混装；继续遵守 §12「独立测试 profile」原则，正式混装前需一次显式的兼容冒烟（加载主包插件树 + SDK 后端同进程）。

## 3. 判定（对照 t-0001 成功/失败双路径）

- **成功路径命中**：A/B/C 主体通过 → `dsh-subagent-dsh-sdk` 定为 **M3.5 worker runtime**；`dsh-subagent-acp` 作为协议层备选保留（无需启用）；自研薄壳退役为仅审计需求时的兜底。
- 文件总线（设计 §4）**保留为审计/人工可读层**：通信与进程托管由 SDK 后端承担；worker 侧仍按协议写自己的 status/usage/transcript（计量与面板的数据源不变）。

## 4. M3.5 实施蓝图（基于实测 API）

- **进程托管器 = SDK 后端本身**：`startSdkRun(request, spec)` 即 spawn+握手；`dispose()` 即开关关闭路径。Host 插件的进程托管器只做「`control.json.enabled` → provider 启停」映射，不再自研 spawn/kill。
- spec 关键项：`command`=子运行时 bin（dsh-jsonrpc-agent）、`args`=[子进程 cordis.yml]、`cwd`=父会话 workspace、`provider/model`=子进程模型路由、`env`（凭据经显式 env，父环境自动清洗）、`maxTokens`。
- 已知限制（README 原文确认）：每次运行全新进程（无池）；不支持启动期 persona/toolFilter/outputSchema（用子进程 cordis.yml 配置）；子 transcript 留在子会话根；仅本地子进程。
- 与监控面板（M2）的接缝：面板的「进程存活」「开关-进程不一致」告警在 M3.5 接入后启用（当前 analyst 仍为 fork 手动扮演）。
