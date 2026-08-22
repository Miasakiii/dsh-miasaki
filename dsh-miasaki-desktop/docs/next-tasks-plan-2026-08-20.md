# 桌面端后续任务（2026-08-20 拆分）

> 从原 `docs/next-tasks-plan-2026-08-20.md` 拆出的桌面端相关项。
> 平台级 rc.8 事实见 `../../dsh-miasaki-shared-docs/dsh-platform/rc.8-upgrade-2026-08-20.md`。

## 已完成
- [x] **桌面启动器加 `--no-open`**（2026-08-21）：`src-tauri/src/main.rs` 的 `cmd.args(["/C","dsh","web"])` 追加 `--no-open`（rc.8 本地启动会自动开浏览器，与 Tauri WebView 导航重复产生双窗口）。同次清理 runtime.js 内页宠物死代码（-426 行，注入包 56KB→38KB）并删除 `ui/pet.html/css/js`，`dist\Miasaki.exe` 已重建（8/21）。
- [x] **主题回归**（2026-08-22）：`verify-themes.mjs` 首次在真机完整跑通 18/18；附带修正 `kurkuriel: 骨白基底` 一条自初版即不可满足的陈旧断言。详见 `m36-theme-verify-2026-08-22.md`。

## 待办
- [ ] **历史会话恢复验证**（P1-4）：rc.8 SQLite 不兼容，需在桌面端 GUI 抽查一个 rc.7 时期历史会话能否正常恢复/分叉；无头环境无法验证。
