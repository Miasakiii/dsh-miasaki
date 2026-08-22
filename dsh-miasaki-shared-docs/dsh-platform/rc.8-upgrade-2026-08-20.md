# DSH rc.8 升级记录（2026-08-20）

> 从原 `docs/next-tasks-plan-2026-08-20.md` 拆出的平台级事实，供桌面端 / 编排线共用。
> 同日另一份平台级回归证据见 `m36-rc8-regression-2026-08-22.md`。

## 基线变化（2026-08-20）
- DSH 全局升级 0.1.0-rc.7 → **0.1.0-rc.8**（npm `@next` 标签，2026-08-20）；重启后新实例验证通过（3080 监听、当前会话跨升级恢复、npm 旧版残留目录清理）。
- npm dist-tags 实测：`latest=0.1.0-rc.7`、`next=0.1.0-rc.8`。
- rc.8 web 应用参数实测：`--host / --no-open / --port / --trusted-host`（**无** `--dsw-static-*` CLI 参数，主题走客户端 CSS 令牌覆盖）。
- rc.8 发布说明要点：多模态图文输入、`web_search` 并发、`@` 引用文件/会话、本地 `dsh web` 自动开浏览器、Claude Code/Codex 可作 Profile Bundle、SQLite 存储格式不兼容。

## 风险与纪律备忘
- 本次升级**绕过了「升级前回归冒烟」纪律**，若 m36 出现回归，优先排查混装 profile 与 cordis 版本。
- 桌面端首次拉起 rc.8 时 profile 初始化耗时约数分钟（实测 ~6 分钟），状态页会长时间显示「正在拉起 DSH 服务…」，属正常。
- rc.8 SQLite 存储格式不兼容 → 历史会话恢复需用户在 GUI 抽查（rc.7 时期会话能否正常恢复/分叉）。
