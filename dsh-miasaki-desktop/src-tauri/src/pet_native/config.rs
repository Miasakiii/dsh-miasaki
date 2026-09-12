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
pub(crate) const BUBBLE_COUNT: usize = 22;
pub(crate) const BUBBLE_BUSY: usize = 17;
pub(crate) const BUBBLE_WAITING: usize = 18;
pub(crate) const BUBBLE_NEED_APPROVE: usize = 19;
// M2(v3) 新增状态帧:出错了(Error 态)/完成了(Done 庆祝态,10s 常驻)
pub(crate) const BUBBLE_ERROR: usize = 20;
pub(crate) const BUBBLE_DONE: usize = 21;
// M2:官方契约心跳新鲜度——超过此时长无心跳视为官方通道死亡,回落 DOM 扫描兜底
pub(crate) const OFFICIAL_FRESH_MS: u64 = 5000;
// M2:Done 庆祝 review 行播放时长(一次,不循环;气泡由 JS 侧 doneHold 10s 收尾)
pub(crate) const DONE_REVIEW_MS: u64 = 1500;

// —— v2 动作丰富化参数(2026-08-22,见 design/pet-v2-phase-a-execution.md) ——
pub(crate) const HOP_MS: u64 = 900; // 单击跳跃时长
pub(crate) const WAVE_MS: u64 = 1300; // 双击挥手时长(wave 4 帧×8fps≈500ms,留余量)
pub(crate) const HOP_HOLD_MS: u64 = 200; // 跳跃落地:末帧定格时长
// M1.3(2026-09-12):单击去抖窗——WM_LBUTTONUP 后延迟判定是否第二击(双击),避免「跳一次+挥一次」
pub(crate) const SINGLE_CLICK_DEBOUNCE_MS: u32 = 250;
// compose 33ms 心跳定时器沿用 id=1;单击去抖另用 id=2(wnd_proc 按 wp 分流)
pub(crate) const IDT_COMPOSE: usize = 1;
pub(crate) const IDT_SINGLE_CLICK: usize = 2;
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
