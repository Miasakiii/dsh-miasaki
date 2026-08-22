# 结果：t-0005 百炼账户免费额度与用量状态查询

## 结论
查询成功（Operator 完成 console 登录后重跑）。

**免费额度**（`bl usage free`，共 89 个模型，按紧急度排序，取前 15）：
- qwen3.7-plus（Text）：剩余 895,441 / 1,000,000（89.5%）
- qwen3.7-max（Text）：剩余 998,131 / 1,000,000（99.8%）
- qwen3.7-max-2026-06-08 / qwen3.7-max-preview：各 100% 满额
- 音频类（sambert-* / paraformer-* / qwen-audio-asr）：全部 100% 满额
- happyhorse-1.1-i2v（Vision）：10/10（100%）

**用量摘要**（`bl usage stats`，窗口 2026-08-10 ~ 08-17，7 天）：
- 调用模型数 6；成功调用 50 次；图像 26 张
- Input 34,308 tokens / Output 61,918 tokens / 合计 96,226 tokens，平均 1,925 tokens/请求

## 完成度
100%。CLI 进程真实执行，stdout 完整捕获（logs/t-0005-stdout-3.log），全程只读无副作用。

## 数据来源 / 依据
- `agents/bl/logs/t-0005-stdout-3.log`（本轮完整输出）

## 遇到的问题
- 首轮因 console 会话过期 blocked（exit 3）；Operator 执行 `bl auth login --console --console-site domestic` 后解除。该前置条件已写入 bl 档案的 `preflight` 字段。

## 广播建议
- 已验证「按 CLI 特性分配」原则的正面案例：资源查询类任务派给 bl（其自有域），CLI 的输出天然就是答案，无需模型调用、零 token 成本。

## 下一步建议
- M3.5 派单器脚本化：把本轮手动派单流程固化为 dispatcher（spawn + 捕获 + 落盘 + 状态机），随后接面板开关做多 CLI 并行。
