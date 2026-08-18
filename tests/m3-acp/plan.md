# M3 官方 runtime 评估 — 验证方案（t-0001 结论的执行计划）

- 日期：2026-08-16
- 目标：验证 `@deepseek-ai/dsh-subagent-dsh-sdk`（0.0.1-rc.1）+ ACP/SDK 协议线能否替代自研薄壳，作为 worker runtime。
- 方法：跑官方仓库自带的 **keyless 测试**（无需 DEEPSEEK_API_KEY，mock LLM），全部在 workspace 沙箱内执行。
- 前置：`vendor/deepseek-harness` 已克隆；`pnpm install` 完成；m3-test profile 已装 SDK 包（Operator 已授权）。

## 测试矩阵（三个层级，从协议到产品）

| # | 测试文件 | 验证层级 | 关键断言 | 命令（在 vendor/deepseek-harness 下） |
|---|---|---|---|---|
| A | examples/jsonrpc-agent/tests/keyless-smoke.e2e.ts | 子运行时协议（裸 stdio JSON-RPC） | initialize 握手 / session.prompt / turn/end(max-tokens) / 工具清单（bash,edit,read,subagent,todo_write,write）/ shutdown / zstd 会话持久化 | `pnpm vitest run --config vitest.e2e.config.ts examples/jsonrpc-agent/tests/keyless-smoke.e2e.ts` |
| B | examples/jsonrpc-agent/tests/sdk.snapshot.ts | SDK 客户端（真实 dsh-sdk-client 驱动真实 runtime，replay 模式） | text-turn / bash-tool 真实工具执行 / subagent-spawn-in-process 委派，RunResult + 通知流 + 会话日志全量钉死 | `pnpm vitest run --config vitest.snapshot.config.ts examples/jsonrpc-agent/tests/sdk.snapshot.ts` |
| C | packages/subagent/subagent-dsh-sdk/tests/loader-composition.e2e.ts | **进程外后端全链路**（父 harness 经 Loader 组合 SDK 后端 → spawn 子 harness → 委派 → 子进程回显 cwd → 双侧会话日志） | 父 tool/result 携带子回显 = 父会话 cwd；子进程有自己的 user/message + assistant/message；cwd 继承而非启动目录 | `pnpm vitest run --config vitest.e2e.config.ts packages/subagent/subagent-dsh-sdk/tests/loader-composition.e2e.ts` |

## 判定标准（对应 t-0001 的成功/失败双路径）

- **成功路径**：A/B/C 全部通过 → 官方 dsh-sdk 定为 M3.5 worker runtime；文件总线降级为审计层；§4 协议骨架不变。
- **失败路径**：任一失败 → 记录失败点 → 换 `dsh-subagent-acp` 重测（更薄协议层）；仍失败 → 自研薄壳兜底。

## Windows 关注点（调研 §4.5 风险项）

- dispose 阶梯（stdin EOF → SIGTERM/SIGKILL）在 Windows 的行为：C 测试间接覆盖（进程退出干净度）；
- 官方示例 bash 语法 vs 本机 pwsh：测试通过 `tsx` 源启动，不依赖 bash；
- 双版本线 cordis 兼容：monorepo 内版本自洽；与主包 rc.6 的混装兼容性仍待 §12 版本线警告约束（m3-test profile 实测项）。

## 执行记录要求

- 每个测试的 stdout/stderr 存档到 `tests/m3-acp/logs/`；
- 结论回写 `docs/m3-official-runtime-eval-2026-08-16.md` + 设计文档 §12/§13 + `state/events.jsonl`。

## 运维备注

- 在 vendor/deepseek-harness 下重跑带脚本的 `pnpm install` 前，先设 `$env:LEFTHOOK='0'`，避免 lefthook postinstall 再次污染全局 git hooks 目录（C:\Users\Asakii\.git-hooks）；
- 安装（原生构建）与测试（子进程 spawn）命令需要 full-access 授权；
- 官方 sdk.snapshot 测试在 Windows 需要本地热补丁（反斜杠 JSON 转义），上游反馈见 Discussions #2477。
