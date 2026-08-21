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
