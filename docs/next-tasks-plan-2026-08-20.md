# 后续任务规划

- 日期：2026-08-20（DSH rc.8 升级会话收尾）
- 状态：备忘稿，下次会话按此推进（优先级自上而下）

## 本次已完成（基线变化）

- DSH 全局升级 0.1.0-rc.7 → **0.1.0-rc.8**（npm `@next` 标签，2026-08-20）；重启后新实例验证通过（3080 监听、当前会话跨升级恢复、npm 旧版残留目录清理）。
- npm dist-tags 实测：`latest=0.1.0-rc.7`、`next=0.1.0-rc.8`。
- rc.8 web 应用参数实测：`--host / --no-open / --port / --trusted-host`（**无** `--dsw-static-*` CLI 参数，主题走客户端 CSS 令牌覆盖）。
- rc.8 发布说明要点：多模态图文输入、`web_search` 并发、`@` 引用文件/会话、本地 `dsh web` 自动开浏览器、Claude Code/Codex 可作 Profile Bundle、SQLite 存储格式不兼容。

## P0 — 文档更新（✅ 2026-08-20 已完成：设计文档 §12）

1. `docs/multi-agent-cli-orchestrator-design.md` §12 已更新：
   - 版本线状态改为 `latest=0.1.0-rc.7`、`next=0.1.0-rc.8`；
   - 补记 2026-08-20 全局主包已按 next 升级至 rc.8，并注明**本次未走「升级前回归冒烟」纪律**（流程偏差，m36 待补）；
   - §12 核心判断引文补 rc.8 与本节省相关内容（Profile Bundle、持久 PowerShell、web_search 并发、SQLite 格式）；
   - subagent 线仍 0.0.1-rc.1，未见新版本（已记录）。

## P1 — 关联待办（待确认后推进）

1. **桌面启动器加 `--no-open`**（✅ 2026-08-21 已完成）：`desktop/src-tauri/src/main.rs:74` 的 `cmd.args(["/C", "dsh", "web"])` 已追加 `"--no-open"`（rc.8 本地启动会自动打开默认浏览器，与 Tauri WebView 导航重复，产生双窗口）。同次会话顺带清理 runtime.js 内页宠物死代码（-426 行，注入包 56KB→38KB）并删除 `ui/pet.html/css/js`，`dist\Miasaki.exe` 已重建（8/21）。
2. **rc.8 回归冒烟（m36）**：参照 `docs/m35-rc7-regression-smoke-2026-08-17.md` 模板；重点验证 `.dsh/profiles/{m3-test,rc7-test}` 混装（`dsh-base@0.1.0-rc.7` + subagent 线 `0.0.1-rc.1`）在 rc.8 全局 CLI 下的 `--dump-config` 加载与 cordis 4.x 兼容。
3. **主题回归**：重跑 `desktop/scripts/verify-themes.mjs`（rc.8 UI 布局改动，三套主题可能有视觉漂移）。
4. **历史会话恢复验证**：rc.8 明示 SQLite 存储格式不兼容——抽查一个 rc.7 时期历史会话能否在 rc.8 GUI 正常恢复/分叉。
5. **引用资料梳理**：`_refs/rc8-src.zip` 已损坏、`_refs/deepseek-harness` 仍是 rc.7 解包——需要源码参考时重新下载官方 rc.8 source 并更新。

## 风险与备忘

- 本次升级绕过了「升级前回归冒烟」纪律，若 m36 出现回归，优先排查混装 profile 与 cordis 版本（与 §12 版本线警告一致）。
- 桌面端首次拉起 rc.8 时 profile 初始化耗时约数分钟（实测 ~6 分钟），状态页会长时间显示「正在拉起 DSH 服务…」，属正常。
