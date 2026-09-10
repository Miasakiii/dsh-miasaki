# schemas/ — 文件总线契约（F1 + G 系列）

本目录存放总线文件的 JSON Schema，分两批：

**F1 基础契约（2026-09-04）**

`agents/registry.json`、`agents/<id>/{manifest,control,status}.json`、
`state/{tasks,ledger,events}.jsonl`、`agents/*/usage.jsonl`、
`state/fleet-pulse.json`（X1）。

**G 系列图工程契约（2026-09-10）**

| 文件 | 契约对象 |
|---|---|
| `graph.schema.json` | `tasks.jsonl` 中 `create.task.graph` —— 任务图节点（G1） |
| `result.schema.json` | `tasks/<id>/result.json` —— 节点交付契约 |
| `verdict.schema.json` | `tasks/<id>/verdict.json` —— 验证器结论（G4） |
| `graph-event.schema.json` | `state/graph-events.jsonl` —— 机器事件流（G3） |
| `patch.schema.json` | 提交给 `workers/bus/bus-apply.mjs` 的补丁 |

## ⚠️ 权威定义在哪里

**`schemas/*.schema.json` 是人类可读的契约文档；权威校验实现在
`workers/lib/bus-contract.cjs`。**

两者由人工保持同步。之所以把可执行定义单独放一处、而不是让校验器直接读 schema 文件：
`validate-bus.mjs`（事后巡检）与 `bus-apply.mjs`（写入时拦截）必须用**同一份**判定规则，
否则会出现"写的时候放行、巡检的时候报错"这类最难排查的漂移。

新增或修改契约时：**先改 `bus-contract.cjs` 与 `tests/bus-contract.test.mjs`
（测试即规格），再同步本目录的 schema 文件**。

## 校验与写入

```bash
node workers/validate-bus.mjs            # 全量校验（事后巡检）
node workers/validate-bus.mjs --strict   # 额外要求 fleet-pulse.json 存在

node workers/bus/bus-apply.mjs --current-version       # 查当前总线版本
node workers/bus/bus-apply.mjs --patch p.json --check  # 只校验不写入
node workers/bus/bus-apply.mjs --patch p.json          # 提交一个超步
node workers/bus/bus-apply.mjs --emit-event task.started \
     --task t-0012 --author dispatcher --reason "派单给 scout"
```

自测（两者都不 spawn 子进程，受限沙箱下同样可跑）：

```bash
node tests/bus-contract.test.mjs    # 契约判定（23 项）
node tests/bus-apply.test.mjs       # applier 端到端（15 项）
```

## 其他注意事项

- 本机 PowerShell 生成的 JSON 常带 UTF-8 BOM，校验器与 applier 均已自动剥离；
- `agents/archive/` 下历史标本跳过；
- 被 `.gitignore` 忽略的运行时文件缺失时跳过；`state/graph-events.jsonl` 缺失
  表示事件流尚未启用，同样跳过；
- `control.json` 必须含 `force_kill`（见 agent-browser 补字段先例）；
- 补丁路径有**白名单**（`bus-contract.cjs` 的 `PATCH_PATH_RULES`），
  未登记路径一律拒绝 —— 总线不接受任意路径写入。
