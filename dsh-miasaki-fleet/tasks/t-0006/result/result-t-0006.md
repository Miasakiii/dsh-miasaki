# 结果：t-0006 本机 agent CLI 阵容总结

## 结论
（claude 2.1.233 headless 执行，21 回合，exit 0；结论摘自其 stdout，原文见 agents/claude/logs/t-0006-stdout.log）

本机部署了一支由 **8 个 agent CLI** 组成的多模型编排阵容，覆盖通用编码（claude / pi / opencode / gemini / mimo / dsh）、平台 API 对话（bl / Bailian）与浏览器自动化（agent-browser）三类能力，统一经 M3.5 派单器按模板 invoke 接入。**claude 是唯一支持结构化 JSON 输出且按 token 计价（json-cost-usd）的 runner**，成本核算以它为主锚；其余多为 unknown/session/console-usage 计费。

| id | 名称 | 版本 | 计费 | 主打用途 |
|----|------|------|------|----------|
| claude | Claude Code | 2.1.233 | json-cost-usd | 通用全能 agent，唯一 JSON 输出+token 计价 |
| bl | Bailian CLI | 1.16.0 | console-usage | 百炼文本对话/应用/用量配额 |
| gemini | Gemini CLI | 探测失败（启动错误） | unknown | Google 对话，当前不可用需修复 |
| opencode | opencode | 1.18.18 | unknown | 终端通用编码 agent |
| dsh | DSH CLI | 0.1.0-rc.6 | session | 项目自有 headless 编排 shell |
| pi | pi coding agent | 0.84.1 | unknown | 通用 coding agent |
| mimo | MiMo CLI | 0.1.12 | unknown | 轻量对话/编码（早期版） |
| agent-browser | agent-browser | 0.34.0 | unknown | 浏览器自动化（导航/表单/截图/抓取） |

**任务类型 → 首选 CLI 建议**（claude 输出）：
- 结构化 JSON + 成本核算关键任务 → **claude**（唯一 --output-format json 且按 token 计价）
- 读文件/分析/总结/多步工具调用 → **claude**（备选 opencode/pi）
- 百炼模型对话/应用/用量 → **bl**（派单前核对 console 登录）
- 通用编码备用/并发容灾 → **opencode**（备选 pi/mimo）
- 本机 headless 编排自测 → **dsh**
- 网页导航/表单/截图/抓取 → **agent-browser**

## 完成度
100%（交付物落盘由派单器代写——headless 模式下 claude 的 Write/Bash 权限被其自身权限栈自动拒绝，permission_denials 已记录，符合设计 §11.2 对异构 CLI 无人值守自动拒绝的预期）。

## 数据来源 / 依据
- `agents/claude/logs/t-0006-stdout.log`（完整 stdout JSON：session_id、usage、permission_denials、result）
- agents/registry.json + agents/<id>/manifest.json（claude 只读）

## 遇到的问题
- claude 尝试 Bash（列目录）与 Write（写 result 文件）均被权限拒绝——headless 派单下交付物必须由派单器代写，已确认入协议。
- 成本实报：**$0.414（total_cost_usd）**，大头是 sonnet-4-6[1M] 的 cache-read 608,768 tokens——真实计量首次落账，说明 cache-read 字段（§4.4）对成本核算的必要性。

## 广播建议
- CLI 派单的计量通道验证：claude 的 `--output-format json` 含 total_cost_usd + 分模型 usage，可作为派单器 usage 解析的模板实现（json-cost-usd 来源）。

## 下一步建议
- 派单器增加 usage 解析插件（claude json → usage.jsonl 自动化，本轮为 Commander 手动回填）。
