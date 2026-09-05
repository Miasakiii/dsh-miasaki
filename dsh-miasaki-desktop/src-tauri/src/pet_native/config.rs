//! 桌宠常量：窗口几何 / 气泡帧 / v2 动作参数（D2 拆分自 pet_native.rs）
pub(crate) const WIN_W: i32 = 286;
pub(crate) const WIN_H: i32 = 390;
pub(crate) const CELL_H: usize = 270;
pub(crate) const DOT_SIZE: i32 = 30;
// 预渲染气泡帧:生成于 scripts/gen-bubbles.ps1(系统字体在构建期出图,
// 运行时只做像素叠加 —— 规避 Win11 多线程 GDI 字体堆损坏导致 CreateFontW 崩溃)
pub(crate) const BUBBLE_W: i32 = 240;
pub(crate) const BUBBLE_H: i32 = 56;
// v2026-08-30:17 台词 + 3 状态帧(忙碌中…/等待审批/需要你的批准)
pub(crate) const BUBBLE_COUNT: usize = 20;
pub(crate) const BUBBLE_BUSY: usize = 17;
pub(crate) const BUBBLE_WAITING: usize = 18;
pub(crate) const BUBBLE_NEED_APPROVE: usize = 19;

// —— v2 动作丰富化参数(2026-08-22,见 design/pet-v2-phase-a-execution.md) ——
pub(crate) const WAVE_MS: u64 = 1300; // 双击挥手时长(wave 4 帧×8fps≈500ms,留余量)
pub(crate) const HOP_HOLD_MS: u64 = 200; // 跳跃落地:末帧定格时长
pub(crate) const AMBIENT_PLAY_MIN_MS: u64 = 1200; // ambient 表演下限
pub(crate) const AMBIENT_PLAY_VAR_MS: u64 = 1000; // ambient 表演随机幅度(1.2~2.2s)
pub(crate) const AMBIENT_REST_MIN_MS: u64 = 8000; // ambient 休息下限
pub(crate) const AMBIENT_REST_VAR_MS: u64 = 10000; // ambient 休息随机幅度(8~18s)
pub(crate) const AMBIENT_FIRST_DELAY_MS: u64 = 5500; // 首次表演延迟(4~7s 中点)
pub(crate) const AMBIENT_JUMP_PCT: u32 = 15; // 偶发 jump 概率(%)
pub(crate) const WANDER_PX_PER_FRAME: i32 = 9; // 滑步修正:每帧移动(90px/s ÷ 10fps)
// —— D3 GDI 兜底阈值 ——
pub(crate) const ULW_FAIL_STREAK_REBUILD: u32 = 10; // ULW 连续失败达此数 → 销毁重建表面
pub(crate) const ULW_FAIL_LOG_EVERY: u32 = 300; // 持续失败时每 N 次追加一行日志（防刷屏）
