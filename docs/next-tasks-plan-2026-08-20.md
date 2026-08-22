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
2. **rc.8 回归冒烟（m36）**（✅ 2026-08-22 已完成，详见 `docs/m36-rc8-regression-smoke-2026-08-22.md`）：本机全局 CLI 实测已升到 **0.1.1-rc.1**（dist-tags 最新 rc.2）。m3-test/rc7-test 混装 profile `--dump-config` 双双 exit 0，**rc7-test 插件树与 M3.5 基线 313 行字节一致**，无回归。cordis 4.0.1 由全局 CLI 自带，混装模型成立。
3. **主题回归**（✅ 2026-08-22 已完成）：`verify-themes.mjs` 首次在真机完整跑通 **18/18**；附带修正 kurkuriel「骨白基底」一条自初版即不可满足的陈旧断言（实测值与主题声明一致，非回归）。
4. **历史会话恢复验证**（⬜ 待用户在 GUI 验证）：rc.8 明示 SQLite 存储格式不兼容——需在桌面端 GUI 抽查一个 rc.7 时期历史会话能否正常恢复/分叉；无头环境无法验证。
5. **引用资料梳理**（⬜ 按需推进）：`_refs/rc8-src.zip` 已损坏、`_refs/deepseek-harness` 仍是 rc.7 解包——需要源码参考时重新下载官方 0.1.1-rc.2 source 并更新。

### 编排线追加（2026-08-22）

- **registry 重扫**（✅ 已完成）：`workers/discovery/scan-agents.ps1` 刷新 8/8 档案 `cli` 字段；dsh 档案版本从过期 rc.6 修为 **0.1.1-rc.1**，claude 2.1.233→2.1.238，gemini 版本探测通（0.55.1，invoke 仍待校准）。日志 `tests/m3-acp/logs/m36/scan-output.log`。

## 风险与备忘

- 本次升级绕过了「升级前回归冒烟」纪律，若 m36 出现回归，优先排查混装 profile 与 cordis 版本（与 §12 版本线警告一致）。
- 桌面端首次拉起 rc.8 时 profile 初始化耗时约数分钟（实测 ~6 分钟），状态页会长时间显示「正在拉起 DSH 服务…」，属正常。
