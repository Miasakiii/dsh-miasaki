# 任务 t-0010：派单器可派闸门接线的独立复核

## 目标

fleet 派单器（`workers/dispatch/dispatch-task.ps1`）刚完成一轮**接线**：把此前只能手工查询的
G1 任务图判定（任务该不该派）与 G0 机器事件留痕，接进了唯一的执行路径。

本任务是**独立复核**——由没有参与该改动的执行者，带着**对抗立场**去找「改错了 / 改漏了」的地方。
目标不是确认它是对的，而是**尝试证伪它**。

## 复核范围（只读，勿修改任何文件）

1. `workers/dispatch/dispatch-task.ps1` —— 新增的 `Test-DispatchableGate`（可派闸门）与 `Write-BusEvent`（事件留痕）
2. `workers/graph/task-ready.mjs` —— 闸门判定来源（`--explain <id> --json`）
3. `workers/dispatch/final-state.ps1` —— 终态判定（闸门的下游消费者）
4. `workers/lib/liveness.cjs` —— 判活口径（冷启动降级依赖它）

## 复核问题（逐条回答，不可跳过）

- **Q1** 是否存在「**该派却被拒**」的路径？特别是：agent 从未运行过（无 `status.json`）时的
  冷启动降级逻辑是否**真的**生效？如果 `status.json` 缺失但 `control.json` 开着，会发生什么？
- **Q2** `-Agent` 与台账 `assignee` 不一致时的拒绝，是否与「改派走 `reassign` 补丁（带 reason）」
  的既有做法闭环？提示文案指向的做法，在代码里真的可行吗？
- **Q3** 事件留痕的两个时点（`task.started` / 终态），能否覆盖这两种情况：
  ① worker 进程崩溃（非零退出）② worker 自述受阻（`result.json` 的 `status=blocked`）？
- **Q4** 闸门失败时的退出码语义（0 / 2 / 3 / 4）是否与既有约定一致？**有没有静默放行的路径**
  ——即某个分支出错后仍然继续派单？

## 约束

requires: coding

- 预算：40K tokens；超时：15 分钟
- **只读执行**：headless 下 Bash / Write 权限被权限栈自动拒绝（设计 §11.2 既定行为）——
  不要把结论写成文件，**全部产出走 stdout**
- 依赖任务：无
- 派单方式：**真实 CLI**（`claude -p {prompt} --output-format json`），非 mock
- **判据优先于观点**：每条结论必须带 `文件:行号`；无证据的判断请显式标注「推测」

## 验收标准

1. Q1–Q4 逐条给出结论（每条 ≤3 行）
2. 全文 findings ≤6 条，按严重度排序（阻断 / 建议 / 观察）
3. **未发现问题也要明说**——不要为凑数编造问题；报「未发现」时说明查了哪几处
4. 结论必须可在 10 分钟内被人工复核（给出行号与可 grep 的关键词）

## 完成后必做

1. 把结论按 §4.7 六段结构完整输出到 stdout —— 段落依序为：
   **结论 / 完成度 / 数据来源·依据 / 遇到的问题 / 广播建议 / 下一步建议**
   （派单器据此代写 `result-t-0010.md`）
2. 在 stdout 末尾用 ≤10 行给出 `notes.md` 待追加要点（派单器追加）
