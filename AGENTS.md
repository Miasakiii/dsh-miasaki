# 工作区指令（Workspace Instructions）

- 除非用户明确要求使用其他语言，始终使用简体中文与用户交流：包括思考过程、回答、计划、总结、错误说明等所有面向用户的输出。
- 代码、命令、标识符、专有名词（如包名、工具名、API 名称）保持原文，不翻译。
- 用户用中文提问时，一律用中文回答。

## 工作区卫生（2026-08-21 起生效）

- **缓存不进工作区**：pnpm 11 默认 store 是项目内 `.pnpm-store`（会反复增生），已把用户级 `store-dir` 固化到
  `%LOCALAPPDATA%\pnpm\store`（`pnpm config set store-dir`）。npm 用默认缓存（`%LOCALAPPDATA%\npm-cache`），
  不要用 `--cache .npm-cache` / `--cache .npm-cache-tmp` 之类的临时路径。
- **外部工具私有数据目录**（`.freebuff/`、`.monkeycode/`、`.learnings/`、`_refs/`、`vendor/`）全员 ignore，
  不属于本项目；归档类产物（zip/tgz/一次性脚本/截图）一律放 `_refs/`（散落根目录会连累 git status）。
- **一次性诊断脚本不进 `desktop/scripts/`**：那是构建链目录（cut-frames / inverse-states / make-icons /
  build-init / verify-themes / smoke-test / capture-all）；一次性产物归档 `_refs/scripts-archive/`。
- **大二进制入库前必查** `git check-ignore`：`*.zip` / `*.tgz` 已在根 `.gitignore` 通配。
- 验证方式：`git status --short` 里不应出现任何 `_.*test` / 缓存 / DB / 压缩包路径。

## 项目纪律（本项目落地约定）

- **桌宠预设维护材料唯一住处**：`desktop/preset-sources/`（`*.persona.txt` + `*.preset.yml` +
  `apply-presets.ps1` 同居；改人设源文件后重跑脚本同步 `%USERPROFILE%\.dsh\.agent-presets\`）。
- **临时/探针产物即时清理**：会话中为验证而写的探针插件（cordis）、一次性输出文件，任务结束即删；
  确有留存价值的进 `_refs/scripts-archive/`，不留在根或构建链目录。
- **收尾自检清单**（每个会话结束前）：
  1. `git status --short` 每一条 M/?? 都能点名（属于哪个功能、为何未提交）；无来历不明的文件。
  2. 代码/行为变更同步更新 `desktop/README.md` 与 `design/CHANGELOG.md`（设计决策进 `design/`）。
  3. 最终回复点名本次变更文件（可点击路径），并给出需用户执行的下一步（构建/验证）。
