# Miasaki 桌面端 — 进度手账(续推入口)

- 定稿:2026-08-17;持续更新:2026-08-21
- **文档地图**:变更历史 → `CHANGELOG.md`;架构/设计决策/血泪教训 → `ARCHITECTURE.md`;待办 → `TODO.md`。
- **本文件只管桌面端**;多 Agent CLI 编排线(agents/ · state/ · tasks/ · workers/ · fleet-monitor/)的交接入口是 `HANDOVER-MULTIAGENT.md`,设计依据 `docs/multi-agent-cli-orchestrator-design.md`。

## 当前状态

- 版本:v0.1.3(2026-08-21 第六轮)— GDI 持久表面 + 窗口状态持久化 + 托盘 + 冒烟脚本 + 文档拆分。
- 交付物:`dist\Miasaki.exe` + `dist\ui\`(先删后拷更新,勿嵌套)。
- **待用户验证**:① 长时间无闪退(≥1h)② 托盘 ③ 窗口位置记忆 ④ 拖窗跟手(第五轮)。
- 里程碑:`#` 用户验收;DSH 已升级 rc.8(2026-08-20),桌面端已适配。

## 快速复查清单(每次发版前)

1. `node scripts/gen-init`(令牌完备性校验;注入包 ≈43KB)
2. `npm run verify`(verify-themes.mjs,需用户机/非沙箱)
3. `powershell -File desktop\scripts\smoke-test.ps1`(冒烟,用户机)
4. `cargo build --release --offline` + dist 先删后拷

## 关键入口(细节见 ARCHITECTURE.md)

- 桌宠绘制:`src-tauri/src/pet_native.rs`(GDI 铁律 §4)
- 主题注入:`themes/runtime.js`(apply 顺序定律 §3.1)
- hash 通道 `main.rs parse_fragment / start_hash_watchdog`(33ms)
