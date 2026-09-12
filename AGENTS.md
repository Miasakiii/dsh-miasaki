# 工作区指令（Workspace Instructions）

- 除非用户明确要求使用其他语言，始终使用简体中文与用户交流：包括思考过程、回答、计划、总结、错误说明等所有面向用户的输出。
- 代码、命令、标识符、专有名词（如包名、工具名、API 名称）保持原文，不翻译。
- 用户用中文提问时，一律用中文回答。

## 仓库结构（monorepo，2026-08-22 重组，2026-09-10 扩为六线，2026-09-11 增为七线）

本仓 `dsh-miasaki/` 单一 git 仓承载七条互不耦合的线 + 共享参考，各居其位：

- `dsh-miasaki-desktop/` — 桌面端线（Tauri 2 薄壳 + Win32 桌宠 + 三主题；`design/` 在其内）。**2026-09-12 桌宠 v3 M2「真实工作状态」落地**（官方契约为主信号、DOM 降级兜底；Rust 六态 `PetState` 为行选择唯一口径；主题 CSS 拆 `*.skin.css` / `*.deco.css` 供外观线消费）
- `dsh-miasaki-fleet/` — 多 Agent CLI 编排线（agents/state/tasks/workers/fleet-monitor/shared/tests）
- `dsh-miasaki-canvas/` — DSH web 画布插件线（fork dsh-synapse v0.4.1 改名 `@miasaki/dsh-canvas`，会话布 MVP M1–M4 已收官；**2026-09-12 视觉与交互精细化 V1–V4 落地（v0.5.0-miasaki.6）**：令牌化圆润化 / 连线端点 / LOD 三档 / 状态徽标，纯表现层零 schema 变更；`design/` 在其内）
- `dsh-miasaki-sidebar/` — DSH web 侧边栏插件线（`@miasaki/dsh-sidebar`：**接入官方右侧 Sidebar**，提供审查 / 终端两个 tab 类型；自研壳 2026-09-10 退役、**2026-09-11 代码删除**；**2026-09-12 内嵌终端两形态落地（v0.8.1-miasaki.0：底部面板 + 右栏 tab 是同一 pty 会话的两个 viewer，自持 node-pty 路线 B），待实机验证**；`design/` 在其内）
- `dsh-miasaki-ssh/` — DSH web SSH 插件线（`@miasaki/dsh-ssh`：会话头**第一行**视图入口，与「对话 / 会话布」同一胶囊的第三段；**画布页面内部**那组按钮旁也有一个 SSH（走 canvas 的外部视图槽）+ 页面内交互式连接云服务器；**M1 代码完成，已 link 安装，待重启验证真实连接；2026-09-12 工作区规划 U0 可靠性闭环 + U1 统一工作区（主机侧栏 / 多标签 / 编辑抽屉 / 三主题桥接 / 复制粘贴查找字号 / 响应式）均已实施，单测 60 例，待实机验收；U2（SFTP/多 shell）U3（跳板/转发）未动**；`design/` 在其内）
- `dsh-miasaki-dual-model/` — DSH web 双模型插件线（`@miasaki/dsh-dual-model`：会话级「主模型 + 辅助模型」，任一支持图片即可发图，输入框右下角配置；**M1 实现完成，待实机验证**；含 `patches/dsh-api-session-controller/` 图片准入补丁；`design/` 在其内）
- `dsh-miasaki-appearance/` — DSH web 外观插件线（`@miasaki/dsh-appearance`：设置里新增一栏**「外观」**，集中管理主题皮肤 / 壁纸 / 动效 / 会话效果；**M2 已收官（2026-09-12）：皮肤层（105 token 表 + 首帧防闪色）/ 壁纸与玻璃档位（配置 v2、程序化渐变 + 本地图源）/ 桌面壳让位协议全部落地并实机验证**——走官方 `settings.section` 插槽 + `ctx.theme` 服务 + `webserver/index-inject` 首帧注入，**零 shell 改动、零第三方依赖**（配置自管 `~/.dsh/miasaki-appearance/config.json`）；总开关默认关闭、「关掉即原生」是硬契约；M3–M4 依次接动效、会话效果；`design/` 在其内）
- `dsh-miasaki-shared-docs/` — 跨线共享参考（`cross/` 跨线设计、`dsh-platform/` DSH 平台调研、仓库级评审报告 `repo-review-*.md`）
- 根级 `_refs/ vendor/ dist/ .vs/ .workbuddy/ .workbuddy-ai/ .learnings/ .monkeycode/ .freebuff/ .cluster/ .openclaw/` 均已 ignore，外部/归档/构建产物，不属于任何一线；根级 `HEARTBEAT.md / IDENTITY.md / SOUL.md / TOOLS.md / USER.md` 为外部 agent 工具（OpenClaw）的 workspace 模板，同样 ignore。

七条线代码零耦合，仅共享 `dsh-miasaki-shared-docs/`。仓库内被 git 追踪的文件可写 `../dsh-miasaki-shared-docs/…` 形式的相对引用（同仓内，clone 后不断）。

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
- **`cargo test` 必须在 MSVC 环境跑**（2026-09-11 实测教训）：Git Bash 的 `PATH` 中 `/usr/bin/link.exe`
  （GNU coreutils 的 `link`）会遮蔽 MSVC 链接器，`verify-all.mjs` 的 desktop 项随即以
  `link: missing operand` / `link.exe returned an unexpected error` 失败——这是**环境假阴性，不是代码缺陷**。
  判据：同环境下 `cargo check --bin miasaki --tests` 仍能通过（编译无误，仅链接阶段失败）。
  正确跑法：在 VS 2022 的 x64 开发者环境（`vcvars64.bat` / x64 Native Tools Command Prompt）
  或带 MSVC 的 PowerShell 中执行。回归矩阵 §1 表下亦有同一注记。

## 项目纪律（本项目落地约定）

- **桌宠预设维护材料唯一住处**：`dsh-miasaki-desktop/preset-sources/`（`*.persona.txt` + `*.preset.yml` +
  `apply-presets.ps1` 同居；改人设源文件后重跑脚本同步 `%USERPROFILE%\.dsh\.agent-presets\`）。
- **desktop 线包管理准则：npm 唯一**（2026-09-12 用户拍板）：`dsh-miasaki-desktop/` **自身依赖**只走 npm，
  `package-lock.json` 是**唯一锁文件**；`pnpm-lock.yaml` 已 `git rm` 删除并在根 `.gitignore` 挡回，**不要**在
  desktop 目录跑 `pnpm install`。根因教训：历史上两套锁文件各自漂移（pnpm 侧早已解析到 sharp 0.35.4、
  npm 侧仍锁 0.35.3），而 dependabot 只读 `package-lock.json` ⇒ 高危漏洞告警长期挂着。
  **注意区分**：各 README/CHANGELOG 里大量出现的「profile 目录 `pnpm install`」指的是 **DSH 宿主 profile**
  的 `file:` 插件依赖安装（宿主生态既定方式），与本线自身依赖无关，不受此准则约束。
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
