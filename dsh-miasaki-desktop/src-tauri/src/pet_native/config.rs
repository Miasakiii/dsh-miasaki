//! 桌宠常量：窗口几何 / 气泡帧 / v2 动作参数（D2 拆分自 pet_native.rs）
pub(crate) const WIN_W: i32 = 286;
pub(crate) const WIN_H: i32 = 390;
pub(crate) const CELL_H: usize = 270;
/// 隐藏态恢复入口悬浮球的窗口边长（2026-09-24 由 30 提到 56）。
/// 旧值是 30px 实心紫圆——够点不够看；新值 = 球面（直径 38）+ 主题色环（2）
/// + 外发光（4）+ 悬停放大余量（≈3），球心恒在窗口中心。
pub(crate) const DOT_SIZE: i32 = 56;
/// 球面（主题头像圆）半径。头像素材 96px 方形徽章缩放到直径 38。
pub(crate) const DOT_FACE_R: f32 = 19.0;
/// 头像素材相对球面的放大系数。
///
/// 不是「填满即可」：素材本身自带一圈主题环（`make-icons.mjs` 的 ringSvg，位于其半径的
/// 91.7% 处），1:1 映射时它会落在球面内侧、与我们画的主题色环之间留一条暗缝（读作
/// 「甜甜圈」）。放大 1.09 让素材自带环正好被球缘裁切、由主题色环接管，球面内只剩头像本体。
pub(crate) const DOT_AVATAR_ZOOM: f32 = 1.09;
/// 主题色环宽度（自球面外沿起算，紧贴球缘作描边）。
pub(crate) const DOT_RING_W: f32 = 2.0;
/// 外发光跨度（自环外沿起算，二次衰减到 0）。
pub(crate) const DOT_GLOW_SPAN: f32 = 4.0;
/// 悬停放大倍率：光标落在球上整体放大（离散两态，不做插值动画）。
pub(crate) const DOT_HOVER_SCALE: f32 = 1.08;
/// 悬停时外发光/高光的强度增益。
pub(crate) const DOT_HOVER_BOOST: f32 = 1.45;
/// 外发光峰值 alpha（悬停时乘 `DOT_HOVER_BOOST`，上限 255）。
pub(crate) const DOT_GLOW_ALPHA: f32 = 96.0;
/// 球面左上高光峰值 alpha（玻璃球质感）。实测 46 在 34px 球上过大，压到 34。
pub(crate) const DOT_SPEC_ALPHA: f32 = 34.0;
/// 球面高光斑半径系数（× 球面半径）。
pub(crate) const DOT_SPEC_R: f32 = 0.52;
/// 底部落影峰值 alpha（黑色，营造「悬浮」而非「贴屏」）——只作用在球体下半个环带，
/// 上半不加权：否则球顶也会蒙一层灰，发光变成「脏雾」。
pub(crate) const DOT_SHADOW_ALPHA: f32 = 72.0;
/// 落影圆心下移量（球心坐标系，随悬停倍率缩放）。
pub(crate) const DOT_SHADOW_DY: f32 = 1.8;
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
/// R2(2026-09-16):透明区域鼠标穿透的光标轮询定时器（独立于 compose）。
/// 必须独立且高频：一旦置位 `WS_EX_TRANSPARENT`，本窗口**收不到鼠标消息**，
/// 「何时恢复可点击」只能靠主动轮询光标位置（参考实现同款：常态 10ms、拖拽中降频）。
pub(crate) const IDT_HIT: usize = 3;
pub(crate) const HIT_POLL_MS: u32 = 10;
/// R2:命中判据阈值——alpha 低于此值视为「透明像素」（参考实现实机取 16）。
/// 注：`load_png` 已把 a<8 归零，取 16 可一并消除 8..15 的「看不见但能点到」窄带。
pub(crate) const CLICK_THROUGH_ALPHA: u32 = 16;
/// R2:穿透样式切换的日志节流（鼠标扫过轮廓会频繁切换，不能每次都写盘）。
pub(crate) const CLICK_THROUGH_LOG_EVERY: u32 = 500;
/// R3(2026-09-16):位置可见性阈值——角色可见区域与任一工作区的相交面积占比 ≥ 25% 视为可见。
/// 半出屏/贴边/未来的 peek 缩边都会保留；完全出屏才回默认位置。
pub(crate) const VISIBLE_MIN_PCT: i64 = 25;

// —— R4/R7（2026-09-16，design/pet-reference-benchmark.md R4/R7）：提醒（气泡）模型 ——
/// 随机台词/单击台词的限时（v3 起为 3s，改用 Alert 后显式化）。
pub(crate) const QUOTE_MS: u64 = 3000;
/// R7（按我方实际情况重塑）：**气泡最小驻留**——防止状态快速交替
/// （waiting ↔ fleet_alert ↔ busy）导致气泡高频闪烁。
/// 只约束**低优先级**项（状态 2 / 台词 3）：同档新项在窗内不替换当前项；
/// **审批(0)/告警(1) 恒可立即抢占**（可读性优先，与 v3 M1「审批 ≤2s 切过去」一致）。
/// 注：参考实现的「跨检测器 30s 节流」作用于**事件型告警源**（stuck/pattern/exploration
/// 三个检测器可能连环弹窗）；我方当前无事件型检测器（状态均为快照派生），
/// 故只取其「防抖」内核，不引入 30s 抑制窗（否则会把状态变化一并吞掉）。
pub(crate) const ALERT_MIN_DWELL_MS: u64 = 900;

// —— R5（2026-09-16，design/pet-reference-benchmark.md R5）：审批气泡（含按钮）——
// 几何必须与 `scripts/gen-bubbles.ps1` 的审批段逐值一致（该脚本生成 ui/pets/approval.png）。
pub(crate) const APPROVAL_W: i32 = 240;
pub(crate) const APPROVAL_H: i32 = 84;
pub(crate) const APPROVAL_BTN_W: i32 = 92;
pub(crate) const APPROVAL_BTN_H: i32 = 26;
/// 帧内按钮 y（脚本 `$btnY`）
pub(crate) const APPROVAL_BTN_Y: i32 = 54;
/// 帧内「拒绝」按钮 x（脚本 `$denyX`）
pub(crate) const APPROVAL_BTN_DENY_X: i32 = 24;
/// 帧内「允许一次」按钮 x（脚本 `$allowX`）——与拒绝按钮之间留 **8px 间隙**防误触
pub(crate) const APPROVAL_BTN_ALLOW_X: i32 = 124;
/// 决策失败回落窗口：点击后若该审批仍存在超过此时长 → 用户没点成 → 提示去 DSH 界面处理
/// （桌宠**绝不假装**决策已生效；参考实现同款纪律）。
pub(crate) const DECISION_FALLBACK_MS: u64 = 3000;
/// 可交互审批提醒的 id 前缀（`approval:<官方 PendingApproval.key>`）。
/// 绘制与命中选择、按 id 移除都以它为准。
pub(crate) const APPROVAL_ID_PREFIX: &str = "approval:";
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
