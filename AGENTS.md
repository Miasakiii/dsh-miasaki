# 工作区指令（Workspace Instructions）

- 除非用户明确要求使用其他语言，始终使用简体中文与用户交流：包括思考过程、回答、计划、总结、错误说明等所有面向用户的输出。
- 代码、命令、标识符、专有名词（如包名、工具名、API 名称）保持原文，不翻译。
- 用户用中文提问时，一律用中文回答。

## 仓库结构（monorepo，2026-08-22 重组，2026-09-10 扩为六线）

本仓 `dsh-miasaki/` 单一 git 仓承载六条互不耦合的线 + 共享参考，各居其位：

- `dsh-miasaki-desktop/` — 桌面端线（Tauri 2 薄壳 + Win32 桌宠 + 三主题；`design/` 在其内）
- `dsh-miasaki-fleet/` — 多 Agent CLI 编排线（agents/state/tasks/workers/fleet-monitor/shared/tests）
- `dsh-miasaki-canvas/` — DSH web 画布插件线（fork dsh-synapse v0.4.1 改名 `@miasaki/dsh-canvas`，会话布 MVP M1–M4 已收官；`design/` 在其内）
- `dsh-miasaki-sidebar/` — DSH web 轻量右侧边栏插件线（路线 D 无基座自研 `@miasaki/dsh-sidebar`：壳 / 审查 / 辅助对话 / 终端启动器；`design/` 在其内）
- `dsh-miasaki-ssh/` — DSH web SSH 插件线（`@miasaki/dsh-ssh`：会话视图 tab 入口 + 页面内交互式连接云服务器；**M1 实现中：store/runtime/路由/WS/前端/单测（20 例）已完成并已 link 安装，待重启验证真实连接**；`design/` 在其内）
- `dsh-miasaki-dual-model/` — DSH web 双模型插件线（`@miasaki/dsh-dual-model`：会话级「主模型 + 辅助模型」，任一支持图片即可发图，输入框右下角配置；**M1 实现完成，待实机验证**；含 `patches/dsh-api-session-controller/` 图片准入补丁；`design/` 在其内）
- `dsh-miasaki-shared-docs/` — 跨线共享参考（`cross/` 跨线设计、`dsh-platform/` DSH 平台调研）
- 根级 `_refs/ vendor/ dist/ .vs/ .workbuddy/ .learnings/ .monkeycode/ .freebuff/` 均已 ignore，外部/归档/构建产物，不属于任何一线。

六条线代码零耦合，仅共享 `dsh-miasaki-shared-docs/`。仓库内被 git 追踪的文件可写 `../dsh-miasaki-shared-docs/…` 形式的相对引用（同仓内，clone 后不断）。

## 工作区卫生（2026-08-21 起生效）

- **缓存不进工作区**：pnpm 11 默认 store 是项目内 `.pnpm-store`（会反复增生），已把用户级 `store-dir` 固化到
  `%LOCALAPPDATA%\pnpm\store`（`pnpm config set store-dir`）。npm 用默认缓存（`%LOCALAPPDATA%\npm-cache`），
  不要用 `--cache .npm-cache` / `--cache .npm-cache-tmp` 之类的临时路径。
- **外部工具私有数据目录**（`.freebuff/`、`.monkeycode/`、`.learnings/`、`_refs/`、`vendor/`）全员 ignore，
  不属于本项目；归档类产物（zip/tgz/一次性脚本/截图）一律放 `_refs/`（散落根目录会连累 git status）。
- **一次性诊断脚本不进 `dsh-miasaki-desktop/scripts/`**：那是构建链目录（cut-frames / inverse-states / make-icons /
  build-init / verify-themes / smoke-test / capture-all）；一次性产物归档 `_refs/scripts-archive/`。
- **大二进制入库前必查** `git check-ignore`：`*.zip` / `*.tgz` 已在根 `.gitignore` 通配。
- **删素材前必查脚本输入**（2026-09-10 教训）：判断一个素材"能不能删"要同时核两条链——
  ①运行时引用（`assets.rs` / 打包清单）；②**构建链输入**（`scripts/*.mjs` 里的 `join(root, …)`）。
  只核①会漏：`build-init.mjs` 的 webp→png 转换带 `existsSync(src)` 守卫，源被删会**静默跳过**，
  回归照常 PASS，断链直到下次要重跑脚本才暴露。素材源（切图输入、图集 webp）与其派生物
  （`frames/`、`states/`、`spritesheet.png`）**分属两链，不可互相顶替**。
- 验证方式：`git status --short` 里不应出现任何 `_.*test` / 缓存 / DB / 压缩包路径。

## 项目纪律（本项目落地约定）

- **桌宠预设维护材料唯一住处**：`dsh-miasaki-desktop/preset-sources/`（`*.persona.txt` + `*.preset.yml` +
  `apply-presets.ps1` 同居；改人设源文件后重跑脚本同步 `%USERPROFILE%\.dsh\.agent-presets\`）。
- **DSH 本体补丁唯一住处**：`dsh-miasaki-desktop/patches/<包名>/`（补丁规则 `patch.mjs` + `baseline/` 原始与产物
  + README 写清升级后重打流程）。**禁止**只在 `vendor/`（不入库）留补丁产物；新增/修改补丁后必须
  `node patch.mjs verify` 自证，并同步 `verify-all.mjs` 与设计文档。
- **临时/探针产物即时清理**：会话中为验证而写的探针插件（cordis）、一次性输出文件，任务结束即删；
  确有留存价值的进 `_refs/scripts-archive/`，不留在根或构建链目录。
- **收尾自检清单**（每个会话结束前）：
  1. `git status --short` 每一条 M/?? 都能点名（属于哪个功能、为何未提交）；无来历不明的文件。
  2. 代码/行为变更同步更新对应线的 README 与变更记录：desktop/canvas/sidebar 更新各自
     `README.md` 与 `design/CHANGELOG.md`；fleet 更新 `README.md` 与 `docs/` 设计文档变更记录（设计决策进各线 `design/`）。
  3. 最终回复点名本次变更文件（可点击路径），并给出需用户执行的下一步（构建/验证）。
