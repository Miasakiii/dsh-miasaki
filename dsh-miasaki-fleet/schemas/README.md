# schemas/ — 文件总线契约（F1）

`agents/registry.json`、`agents/<id>/{manifest,control,status}.json`、
`state/{tasks,ledger,events}.jsonl`、`agents/*/usage.jsonl`、
`state/fleet-pulse.json`（X1）的 JSON Schema。

校验（零依赖）：

```bash
node workers/validate-bus.mjs            # 全量校验
node workers/validate-bus.mjs --strict   # 额外要求 fleet-pulse.json 存在
```

注意：本机 PowerShell 生成的 JSON 常带 UTF-8 BOM，校验器已自动剥离；
`agents/archive/` 下历史标本跳过；被 `.gitignore` 忽略的运行时文件缺失时跳过。
`control.json` 必须含 `force_kill`（`operator-panel` 写入时注意，见 agent-browser 补字段先例）。
