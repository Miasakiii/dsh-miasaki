# Miasaki 桌面端 — 进度手账(续推入口)

- 定稿:2026-08-17;持续更新:2026-08-30
- **文档地图**:变更历史 → `CHANGELOG.md`;架构/设计决策/血泪教训 → `ARCHITECTURE.md`;待办 → `TODO.md`。
- **本文件只管桌面端**;多 Agent CLI 编排线(agents/ · state/ · tasks/ · workers/ · fleet-monitor/)的交接入口是 `HANDOVER-MULTIAGENT.md`,设计依据 `docs/multi-agent-cli-orchestrator-design.md`。
- 跨线联动草案:`dsh-miasaki-shared-docs/cross/ab-linkage-pet-fleet-status-2026-08-18.md`(员工状态的方案;本期未实施,桌宠只反映总指挥)。

## 当前状态

- 版本:v0.1.4(2026-08-30 第七轮)— 桌宠边缘去噪(despeckle + 预乘空间双线性)+ 总指挥工作动态(busy/waiting)。
- 交付物:`dist\Miasaki.exe` + `dist\ui\`(先删后拷更新,勿嵌套)。
- **待用户/Operator 校准**:console 跑 `__miasakiProbe()` 校准 DSH 实际版本下的"停止生成"按钮文本与审批 dialog 容器选择器(常量集中在 `themes/runtime.js` 顶部);真机对比三角色边缘观感。
- 里程碑:`#` 用户验收;DSH 已升级 rc.8(2026-08-20),桌面端已适配。

## 快速复查清单(每次发版前)

1. `node scripts/gen-init`(令牌完备性校验;注入包 ≈43KB)
2. `npm run verify`(verify-themes.mjs,需用户机/非沙箱)
3. `powershell -File desktop\scripts\smoke-test.ps1`(冒烟,用户机)
4. 改 `cut-frames.mjs` / `inverse-states.mjs` / `gen-bubbles.ps1` 后必跑对应脚本再 `cargo build`
5. `cargo build --release --offline` + dist 先删后拷

## 关键入口(细节见 ARCHITECTURE.md)

- 桌宠绘制:`src-tauri/src/pet_native.rs`(GDI 铁律 §4 + 双线性 §4.5)
- 主题注入 + 状态扫描:`themes/runtime.js`(apply 顺序定律 §3.1 + 状态源 §3.4)
- hash 通道 `main.rs parse_fragment / start_hash_watchdog`(33ms;act=/wait= 字段见 §3.4)
