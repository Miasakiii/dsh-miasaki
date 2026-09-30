# 任务 t-0012：失败轮计量留痕的验收载体

## 目标

验证一条**阻断级修复**：派单**失败**时成本痕迹不得丢失。
（2026-09-30 由 t-0011 的独立复核指出：派单器此前只在 `exitCode -eq 0` 时解析 usage，
⇒ 失败轮「跑过但没记账」，与主协议 §9「usage.jsonl 是成本**唯一**原始来源」直接冲突。）

本任务**刻意执行一条会失败的命令**，用于产生一个可检查的失败轮 ——
它**不调用任何模型**（零成本），因此可以随时重跑。

## 约束

- **本任务不是给 worker 做的**：`cmd:` 行会让派单器直接执行该命令，不走 manifest 的 CLI 模板
- 命令：`node -e "process.exit(3)"`（必然非零退出，且不产生任何成本）
- 依赖任务：无

cmd: node -e "process.exit(3)"

## 验收标准（由 Commander 核对，非 worker 产出）

1. 派单器退出码为 **3**（非 0）
2. `agents/<assignee>/usage.jsonl` **仍新增一行** —— 显式未计量行，且 `note` 注明本轮失败
3. 事件流出现 `failure.detected`（终态如实落账）
4. `agents/<assignee>/status.json` 的 `state` 为 `error`

## 完成后必做

无 —— 本任务是**验收载体**，没有 worker 产出，因此**不需要** `result.json` 契约
（派单器不会为它代写交付物；台账按验收结果如实落 `done` 或 `failed`）。
