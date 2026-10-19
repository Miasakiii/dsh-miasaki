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
/// R18（2026-10-17，design/2026-10-17-pet-drag-sprint.md §2.5）：悬浮球拖动起手阈值
/// （Manhattan 距离和，px）。
///
/// **比主窗 `DRAG_THRESHOLD`（4）保守**：球的单击 = 恢复桌宠，是比「撸一下」更重的语义，
/// 误触代价更高；口径对齐 Coopanion 参考实现的 6px 起拖。
pub(crate) const DOT_DRAG_THRESHOLD: i32 = 6;
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
/// R13（2026-10-05）：拖动合帧定时器 —— 消费「最新拖动目标」的节拍。
///
/// **为什么需要它**：`WM_MOUSEMOVE` 是**逐事件**派发的，1000Hz 鼠标 = 每秒 1000 次
/// `MoveWindow`。这有两个问题：① 每个 `MoveWindow` 都会触发一次窗口重定位与重绘调度；
/// ② 更要紧的是它是 M4「拖动尾随」的**硬前置** —— 弹簧插值要估计「窗口位置对目标的滞后」，
/// 而**同一帧内的重复样本会污染滞后估计**（`GetCursorPos` 在 8ms 内可能返回同一位置多次，
/// 算出的速度为 0，插值退化成静止）。
///
/// **口径**（照参考实现 `tests/test_drag_move_coalescing.py` 同款思路）：
/// ① `WM_MOUSEMOVE` 只**记最新绝对目标**，不移动窗口；
/// ② 8ms 定时器消费最新目标（≈125Hz），同一节拍内的多个事件只算一次；
/// ③ 松手时**强制 flush**（否则最后一帧可能还没消费，窗口会停在旧位置一拍）。
///
/// **8ms 的由来**：与 33ms compose 周期解耦（compose 是画面刷新、这个是窗口移动），
/// 8ms 在「跟手」与「省调用」之间；参考实现用的是同一量级。
pub(crate) const IDT_DRAG: usize = 4;
pub(crate) const DRAG_COALESCE_MS: u32 = 8;
/// R18（2026-10-17）：拖动起手阈值（Manhattan 距离和，px）。
///
/// 位移超过它才算「开始拖动」；没超过就是手抖的点击（走单击语义：撸一下 / 唤起主窗）。
/// **抽常量的理由**：原实现是 `WM_MOUSEMOVE` 分支里的字面量 `4`，而同处注释早已引用一个
/// **不存在的** `DRAG_THRESHOLD` —— 注释漂移（说有你没有），补上常量让引用为真。
pub(crate) const DRAG_THRESHOLD: i32 = 4;
/// R18：悬浮球拖动合帧定时器 id（主窗 `IDT_DRAG` 给桌宠；球是另一个 hwnd，
/// 另起一个 id 让 `pet.log` 与契约测试的归属清晰）。节拍复用 `DRAG_COALESCE_MS`。
pub(crate) const IDT_DOT_DRAG: usize = 6;
/// R20-a（2026-10-17，design/2026-10-17-pet-fullscreen-sfx-sprint.md §2.2）：全屏覆盖
/// 轮询定时器 id。节拍 250ms（与 `IDT_PEEK` 同频不同责）——参考实现 Coopanion 用
/// 200ms；全屏判定是「状态切换」不是连续动画，250ms 的进入延迟不可感知，
/// 再快只是白烧轮询（`GetForegroundWindow` + 几次矩形查询）。
pub(crate) const IDT_FULLSCREEN: usize = 7;
pub(crate) const FULLSCREEN_POLL_MS: u32 = 250;

// —— R20-c（2026-10-17，design/2026-10-17-pet-fullscreen-sfx-sprint.md §4）：背景对比 halo ——
/// 采样节拍（ms）。参考实现约 1s 一采；桌面颜色是慢变量，2s 足够且更省
/// （每次采样 = 两次 StretchBlt + GetDIBits，虽 ~1ms 也不值得高频）。
/// 搭 compose 33ms 节拍里的时间戳判断（`next_backdrop`），不新开定时器。
pub(crate) const BACKDROP_EVERY_MS: u64 = 2000;
/// 进入阈值（加权 RGB 距离，0..≈255）：身体与桌面距离小于它 ⇒ 「融进背景」⇒ 开柔光。
/// 初值 36：深色 whale（≈[20,24,40]）对纯黑桌面距离 ≈25（开）、对中灰桌面（≈128）
/// 距离 ≈100（不开）——「深色桌面才救」的口味。**需实机调**（判据从宽）。
pub(crate) const HALO_DIST_ON: f32 = 36.0;
/// 退出阈值：必须大于 `HALO_DIST_ON`（回差定义）。距离超过它才关柔光，
/// 两阈值之间的「临界桌面」不翻动——否则桌宠停在渐变桌面上 2s 一闪。
pub(crate) const HALO_DIST_OFF: f32 = 56.0;
/// 轮廓柔光的**模糊半径**（基准 96 DPI 逻辑像素，调用方按 `round(×dpr)` 换算物理像素）。
///
/// 2026-10-19 重做时定的初始值：11 逻辑像素 ⇒ 125% 屏上是 14 物理像素，与
/// 实机核对过的视觉原型（whale 249px 宽、blur 14px）同口径。这是「光晕从轮廓
/// 向外衰减多远」的唯一旋钮——太小会像描边，太大会糊成一片雾。
pub(crate) const HALO_BLUR_PX: f32 = 11.0;
/// 柔光强度（0..1，乘在「轮廓场×透明度遮罩」上）。0.95 = 深色桌面上清晰可见但
/// 不抢角色本身；配 `HALO_GAMMA` 一起调观感。
pub(crate) const HALO_STRENGTH: f32 = 0.95;
/// 柔光衰减的 gamma（< 1 把外缘小值抬起、过渡更长更柔）。0.85 是视觉原型的取值。
pub(crate) const HALO_GAMMA: f32 = 0.85;
/// 采样带几何（**基准 96 DPI 逻辑像素**，调用方按 DPI 换算）：角色带左右各一条，
/// 避开中间的角色本体（窗内那两条是透明留白，采到的是桌面不是桌宠）。
/// 带宽 48、高 24，贴在角色带垂直中线。
pub(crate) const BACKDROP_STRIP_W: i32 = 48;
pub(crate) const BACKDROP_STRIP_H: i32 = 24;

/// M4（2026-10-05）：拖动尾随的临界阻尼弹簧刚度（1/s²）。
///
/// **口径与取值理由**（参考实现同族：`pet/physics.py` 拖拽段用阻尼弹簧跟手，
/// 但参数散在多处；此处集中成常量并由单测钉住行为）：
/// · **临界阻尼**（`ζ = 1`，即 `c = 2√k`）⇒ **不过冲**。桌宠被甩出去时若过冲，
///   观感是「弹过头再回来」= 抽搐，不是跟手。
/// · `k = 220`（ω ≈ 14.8 rad/s，周期 ≈ 0.42s）：肉眼看是「被拽着走、有一点延迟」，
///   但松手前基本追得上。**再大**会显得像贴手指（无尾随感），**再小**会像掉队。
/// · 与 `IDT_DRAG` 的 8ms 节拍配合：每拍推进 `ω·dt ≈ 0.12` 弧度，数值稳定
///   （半隐式欧拉在 `ω·dt < 1` 时不发散）。
/// · **R19（2026-10-17 续，用户报「拖拽还是有点粘滞」）**：拖动期已改为**直跟手**
///   （`window::flush_drag_target` 的拖动分支直接 `MoveWindow` 到最新目标），本弹簧
///   现在只服务滑停收尾与异常收敛 —— k 的取值**不再影响拖动跟手度**；保留常量与
///   单测是为了滑停路径与回退（若用户更偏好尾随感，可把直跟手分支关掉恢复 M4 行为）。
pub(crate) const DRAG_SPRING_K: f32 = 220.0;
/// 到位判定的位置阈值（px）。0.5 = 肉眼不可见（见 `xform::spring_at_target` 注释）。
pub(crate) const DRAG_SPRING_SETTLE_PX: f32 = 0.5;
/// 到位判定的速度阈值（px/s）。约 2px/s —— 低于此肉眼察觉不到「还在动」。
pub(crate) const DRAG_SPRING_SETTLE_VEL: f32 = 2.0;
/// R16（2026-10-12）：单拍积分允许的最大时长（ms）。
///
/// **原实现把 `last_drag_tick.elapsed()` 直接 clamp 到 100ms** —— 而这个上限**本身就是
/// 过冲的来源**：弹簧的安全区是 `ω·dt ≪ 1`（8ms ⇒ 0.119），100ms 时
/// `ω·dt = 14.83 × 0.1 = 1.48 > 1`，半隐式欧拉在该步长下会把窗口推到**目标位移的 2.2 倍**
/// （峰值 2.43 倍），再用 0.5–0.75s 慢慢飘回来。更要命的是它的**触发条件必然成立**：
/// `last_drag_tick` 只在 `flush_drag_target` 内更新，而两次拖动之间的空闲必然远超 100ms
/// ⇒ **每次起手第一拍都吃满这个上限**（实测数值见 `design/CHANGELOG.md` 2026-10-12 条）。
///
/// 现在的口径：上限仍留 100ms（长时间挂起后不该丢位移），但**必须拆子步积分**
/// （`DRAG_SPRING_MAX_SUBSTEP_MS`），并且拖动起手要重置积分时钟。
pub(crate) const DRAG_TICK_MAX_MS: u32 = 100;
/// R16：弹簧积分的子步长（ms）。`ω·dt = 14.83 × 0.008 ≈ 0.119` —— 与既有单测
/// （`xform.rs` 的 ω·dt 余量条）同一口径。任何大于它的 dt 都拆成多段推进，
/// 于是「挂起 3 秒后恢复」与「起手首拍」都不会把弹簧推入过冲区。
pub(crate) const DRAG_SPRING_MAX_SUBSTEP_MS: u32 = 8;
/// R16：抓取热区膨胀半径（px，**基准 96 DPI 口径**，调用方按 DPI 换算）。
///
/// **为什么需要**：R2 的命中是逐像素 alpha 判定，而桌宠立绘在窗口内只占中间一条 ——
/// 2026-10-12 网格扫描实测（whale 主题）：窗口 286×390 里可点区仅约 **110×180（18%）**，
/// 左右各 ~55px 留白、角色上方与底部大片区域点上去**直接穿透到桌面** ⇒ 用户报的
/// 「桌宠很难拖动 / 拖不动」。
/// 膨胀后「贴着角色轮廓的空白」也算可点（抓取容差），而远离角色的角落仍穿透 ——
/// 不引入「一整块 286×390 的隐形挡板」那种副作用。
pub(crate) const CLICK_GRAB_PAD_PX: i32 = 16;
// —— M4.1（2026-10-05，design/pet-v3-roadmap.md §M4.1 + pet-reference-benchmark.md R14）：边缘探头 ——
/// peek 状态机轮询定时器 id（边界检测：静置到期 / 光标压上）。
/// 动画推进不在这里——它搭 `IDT_COMPOSE` 的 33ms 节拍（真实 dt 积分）。
pub(crate) const IDT_PEEK: usize = 5;
/// 轮询周期。只做两类边界检测，250ms 的反应延迟不可感知；再快只是白烧轮询。
pub(crate) const PEEK_POLL_MS: u32 = 250;
/// 静置多久进入探头。R14 采纳参考口径 **5s**（取代 roadmap 初稿的 15s——实测观感 15s 太迟钝）。
pub(crate) const PEEK_IDLE_MS: u64 = 5000;
/// 常驻露出比例（对 `character_local_rect` 口径的跨距）。R14：参考项目实测 0.70「探出过多」→ 0.55。
pub(crate) const PEEK_REST_EXPOSURE: f32 = 0.55;
/// 点击/悬停「拉直」后的露出比例（R14）。仍留 18% 在屏外是刻意的：拉直态不解除停靠，
/// 用户要挪走它就拖——拖动即脱停靠，语义比「点击弹回屏幕中央」可预期。
pub(crate) const PEEK_ENGAGE_EXPOSURE: f32 = 0.82;
/// 三段过渡时长（R14 = 300/250/300）：进入缩边 / 拉直 / 退回常驻档。
pub(crate) const PEEK_ENTER_MS: u32 = 300;
pub(crate) const PEEK_STRAIGHTEN_MS: u32 = 250;
pub(crate) const PEEK_RETURN_MS: u32 = 300;
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

// —— L1（2026-09-28，design/pet-v5-motion-plan.md §3）：绘制层动效 ——
// 相位与变换的纯函数在 `pet_native/xform.rs`；本段只放参数。
/// M1 呼吸周期（沿用 v2 现值 3.2s）。
pub(crate) const BREATH_PERIOD_MS: u64 = 3200;
/// M1 呼吸幅度：**图集行**姿态（kurumi / whale）。沿用 v2 的 ±2px。
pub(crate) const BREATH_PX_ROW: f32 = 2.0;
/// M1 呼吸幅度：**三态立绘**（inverse / whale deep）。沿用既有的 ±3px。
/// 立绘比图集帧高（540 源高 vs 208），同样像素数在视觉上更弱，故留较大值。
pub(crate) const BREATH_PX_STATES: f32 = 3.0;
/// M2 摇摆周期。**刻意不等于**呼吸周期，且叠加相位偏移 ⇒ 两者错相（见 `xform::sway_angle`）。
pub(crate) const SWAY_PERIOD_MS: u64 = 5600;
/// M2 摇摆相位偏移（与呼吸错相的第二重保证：即使周期巧合接近，极值也不会撞在一起）。
pub(crate) const SWAY_PHASE_SHIFT_MS: u64 = 1300;
/// M2 摇摆幅度（度）。取区间 1.5~2.5 的中偏保守值：最宽帧（192×208 → 249.2px 宽）
/// 在 ±2° 时包围盒宽 267.8px，距 `WIN_W` 286 尚余 18px，为后续调整留出余量。
pub(crate) const SWAY_MAX_DEG: f32 = 2.0;
/// M3 挤压脉冲时长（单次，参考实现实测 220ms）。
pub(crate) const SQUASH_MS: u64 = 220;
/// M3 挤压峰值：横向拉伸 10%、纵向压缩 15%（参数取自参考实现实测）。
pub(crate) const SQUASH_DX: f32 = 0.10;
pub(crate) const SQUASH_DY: f32 = 0.15;

// —— R18（2026-10-17，design/2026-10-17-pet-drag-sprint.md §3.1）：拖动反馈（零素材）——
/// 拖动倾斜峰值（度）。**2.5° 是横向不越窗的硬上限区间**：角色宽 ≈249px 在 286px 窗内，
/// 单侧余量 ≈18.4px；旋转吃掉 `CELL_H·sinθ`（270·sin2.5° ≈ 11.8px），再叠加拉伸
/// `DRAG_LEAN_DX` 的 ≈5px ⇒ 合计 ≈16.8px，留 ≈1.6px 安全边际。
/// 不变量由 `xform::drag_lean` 的 worst-case 单测逐 DPI 钉死——调这三个数之前先跑它。
pub(crate) const DRAG_LEAN_MAX_DEG: f32 = 2.5;
/// 拖动中的「拎起」微抬升（px，向上；以负 bob 送进 `blit_center_bottom`）。
/// 两个作用：① 读作「被拎起来」；② 给倾斜腾出底部余量（倾斜底角下沉 ≈6.5px，
/// 由 2px 底留白 + `sway_layout_margin` + 本值共同覆盖）。
pub(crate) const DRAG_LIFT_PX: f32 = 6.0;
/// 达到全幅倾斜的速度参考（px/s）。参考实现一甩上千 px/s，取 1400 为「快拖常见区」。
pub(crate) const DRAG_LEAN_VREF: f32 = 1400.0;
/// 倾斜死区（px/s）：低于此不出形变。慢拖与悬停微动的速度噪声大，
/// 出形变会读作「端着发抖」——比没有反馈更糟。
pub(crate) const DRAG_LEAN_VDEAD: f32 = 120.0;
/// 沿运动方向的拉伸峰值（`DRAG_LEAN_VREF` 满速时）。
pub(crate) const DRAG_LEAN_DX: f32 = 0.04;
/// 垂直运动方向的压缩峰值（与 `DRAG_LEAN_DX` 共同构成「沿运动方向被拉长」的读感）。
pub(crate) const DRAG_LEAN_DY: f32 = 0.06;
/// 变换缩放的夹取边界。存在的硬理由：逆变换要除以 `sx`/`sy`，0 或 NaN 会污染整帧缓冲。
/// 上限 2.0 远宽于任何动效需求（`SQUASH_DX` 峰值仅 1.10），只作为「上游算错时的最后一道闸」。
pub(crate) const XF_MIN_SCALE: f32 = 0.5;
pub(crate) const XF_MAX_SCALE: f32 = 2.0;

/// M2 摇摆峰值（弧度）。`f32::to_radians` 不是 const fn，故以函数形式给出
/// （小写命名遵 Rust 惯例；它不参与常量折叠，只在绘制与布局各算一次）。
pub(crate) fn sway_max_rad() -> f32 {
    SWAY_MAX_DEG.to_radians()
}

/// R18 拖动倾斜峰值（弧度）。同 `sway_max_rad` 的理由（`to_radians` 非 const fn）。
pub(crate) fn drag_lean_max_rad() -> f32 {
    DRAG_LEAN_MAX_DEG.to_radians()
}

// —— P0（2026-10-18，design/2026-10-18-pet-p0-interaction-emote.md）：
// 互动分级（摸头/咬手）+ Emote 动作族 + 甩出抛掷 + 心情系统 ——
// F1 · 摸头与咬手（`model::Petting` / `petting_tick`，窗口层搭 IDT_HIT 10ms 轮询）——

/// 光标在角色上持续多久算「摸了一下」（ms）。
/// 400ms：短于它的是「划过」，长于它的是「停留」——停留即抚摸，
/// 与 garfield-whale「摸着不放就会激发咬手」同口径。
pub(crate) const PET_HOLD_MS: u64 = 400;
/// 咬手需要的连续抚摸次数（garfield-whale 原值 5）。
pub(crate) const BITE_STROKES: u32 = 5;
/// 计数窗口（ms）：超过则重新累计——「一小时摸五下」不该触发。
pub(crate) const BITE_WINDOW_MS: u64 = 60_000;
/// 咬手后的冷却（ms）：冷却期内抚摸无反应（咬着人不放还想撸？）。
pub(crate) const BITE_COOLDOWN_MS: u64 = 60_000;
/// 咬住光标不放的时长（ms）。期间窗口跟随光标（「咬住你的手」）。
pub(crate) const BITE_CLING_MS: u64 = 1200;

// F2 · Emote 动作族（`xform::emote_xform` 编舞；旋转一律 ≤ SWAY_MAX_DEG·MOTION_MAX
// 的布局余量 3.2°，见设计文档 §3.2.2 的几何账）——
/// 各 emote 的时长（ms）。Sleep 例外（10min 续期，见 `SLEEP_MS`）。
pub(crate) const NOD_MS: u64 = 600;
pub(crate) const SHAKE_MS: u64 = 600;
pub(crate) const TURN_MS: u64 = 700;
pub(crate) const SHIVER_MS: u64 = 520;
pub(crate) const DANCE_MS: u64 = 1600;
pub(crate) const LOOK_MS: u64 = 800;
pub(crate) const SLEEP_MS: u64 = 600_000;
/// 点头的垂直幅度（px）。
pub(crate) const NOD_PX: f32 = 6.0;
/// 摇头角度（度）。**3.0 是旋转类 emote 的上限**（≤ 布局余量 3.2°，单测钉死）。
pub(crate) const SHAKE_DEG: f32 = 3.0;
/// 跳舞的摇摆角（度）。同受 3.2° 余量约束；**不带挤压**——rot 3° 与 squash
/// 1.10 叠加会横向越窗约 6px（设计文档 §3.2.2 的账），与「挤压期关摇摆」同族纪律。
pub(crate) const DANCE_DEG: f32 = 3.0;
/// 跳舞的节拍 bob（px）。
pub(crate) const DANCE_BOB_PX: f32 = 4.0;
/// 张望的角度（度）。
pub(crate) const LOOK_DEG: f32 = 2.5;
/// 发抖的角度（度）+ 微颤 bob（px）。高频确定性抖动（sin 复合，不用随机）。
pub(crate) const SHIVER_DEG: f32 = 1.5;
pub(crate) const SHIVER_BOB_PX: f32 = 1.0;
/// 发抖一个完整时长的抖动次数（频率随时长缩放，520ms 与咬合 1200ms 都适用）。
pub(crate) const SHIVER_CYCLES: f32 = 6.0;
/// 转身中点时的横向挤压（「蓄力—翻转—回弹」的最低点）。
pub(crate) const TURN_SQUEEZE: f32 = 0.15;
/// 睡眠呼吸：周期 = `BREATH_PERIOD_MS × 2.5`（≈8s 一次，深而慢）。
pub(crate) const SLEEP_BREATH_PERIOD_MUL: f32 = 2.5;
/// 睡眠呼吸幅度 = 图集行呼吸幅度 × 1.2（比醒着略深）。
pub(crate) const SLEEP_BREATH_AMP: f32 = 1.2;
/// 睡眠时段（本地小时，含头不含尾）：23:00–07:00。
pub(crate) const SLEEP_START_HOUR: u32 = 23;
pub(crate) const SLEEP_END_HOUR: u32 = 7;
/// C 批（2026-10-19）：**傍晚渐静段**起点（本地小时，含头不含尾）：18:00–23:00。
/// 与睡眠段是两回事——睡眠段桌宠真睡（动作槽被 Sleep 占住），渐静段只是
/// ambient 编排的氛围修正（睡前不闹腾）。见 `model::time_band`。
pub(crate) const EVENING_START_HOUR: u32 = 18;
/// 睡眠状态续期检查间隔（ms）——也是「早晨醒来看时钟」的节拍。
pub(crate) const SLEEP_CHECK_MS: u64 = 30_000;
/// P0-F2 审查修正（2026-10-18）：用户交互把桌宠叫醒后的**免睡冷却**（ms）。
/// 没有它时「瞌睡续觉」钩子会在打断后的下一拍立刻补回睡姿（点击即醒不可达）。
/// 60s：够用户摸/点/拖一轮，又不会把整夜睡眠永久打断（冷却过后仍在深夜就再睡）。
pub(crate) const SLEEP_WAKE_MS: u64 = 60_000;

// F3 · 甩出抛掷（`xform::FlyState` / `fly_step`，窗口层搭 IDT_DRAG 8ms 节拍）——
/// 触发抛掷的松手速度阈值（px/s）。低于它走 R18 滑停（行为不变）。
/// 600 ≈ 慢速甩动的常见区；参考实现 GarfieldZhung/Coopanion 同量级。
pub(crate) const THROW_VEL_MIN: f32 = 600.0;
/// 重力加速度（px/s²）。2600 ≈ 0.28g 的桌面观感（太快像砸地、太慢像飘）。
pub(crate) const FLY_GRAVITY: f32 = 2600.0;
/// 边缘反弹的能量保留（0.55）：弹跳可见地衰减，3–4 次内停稳。
pub(crate) const FLY_RESTITUTION: f32 = 0.55;
/// 飞行最长时间（ms）兜底——速度判据失灵时绝不让桌宠永远飞。
pub(crate) const FLY_MAX_MS: u32 = 2500;
/// 飞行结束的速度阈值（px/s）：至少弹过一次且慢于此 ⇒ 落地收尾。
pub(crate) const FLY_END_VEL: f32 = 140.0;

// F4 · 心情值（`model::mood_apply` / `mood_band`；会话级，不落盘）——
pub(crate) const MOOD_MIN: i32 = -100;
pub(crate) const MOOD_MAX: i32 = 100;
/// 心情档位阈值（|mood| ≥ 25 进 High/Low）。
pub(crate) const MOOD_HIGH: i32 = 25;
pub(crate) const MOOD_LOW: i32 = -25;
/// 疏忽检查间隔（ms）：超过此时长无交互 ⇒ 心情 -4（「被冷落」）。
pub(crate) const MOOD_NEGLECT_EVERY_MS: u64 = 600_000;
/// 各事件的心情增量（`mood_apply` 的纯数据）。
pub(crate) const MOOD_STROKE: i32 = 10;
pub(crate) const MOOD_BITE: i32 = -20;
pub(crate) const MOOD_THROW: i32 = -6;
pub(crate) const MOOD_HOP: i32 = 4;
pub(crate) const MOOD_WAVE: i32 = 3;
pub(crate) const MOOD_DONE: i32 = 6;
pub(crate) const MOOD_NEGLECT: i32 = -4;
/// ambient 池里 emote 的概率（%，按心情档）：High 爱跳舞、Low 爱发抖/张望。
pub(crate) const EMOTE_PCT_HIGH: u32 = 25;
pub(crate) const EMOTE_PCT_MID: u32 = 15;
pub(crate) const EMOTE_PCT_LOW: u32 = 25;

// P1-b（2026-10-18，design/2026-10-18-pet-p1-idle-variants-and-marks.md §3.2）：
// 程序化表情标记（零资产，形状判定在 marks.rs）——
/// 单次标记播放时长（ms）。1.4s：够读完一个符号，又不至于长期挡在角色头上。
pub(crate) const MARK_MS: u64 = 1400;
/// 标记盒边长（px，**基准 96 DPI 口径**，调用方按 DPI 换算）。34px 在 390px 窗里
/// 约 9%——「可见的小情绪」，不是占屏大头。
pub(crate) const MARK_BOX_PX: i32 = 34;
/// 标记盒底边距角色框顶边的距离（px，基准口径）——「浮在头顶上方」。
pub(crate) const MARK_LIFT_PX: i32 = 26;
/// 瞌睡时 Zzz 的浮动间隔（ms）。
pub(crate) const ZZZ_EVERY_MS: u64 = 3000;
/// ambient 行触发时附带情绪标记的概率（%，按心情档）——High 多爱心、Low 多泪滴。
pub(crate) const MARK_PCT_HIGH: u32 = 25;
pub(crate) const MARK_PCT_LOW: u32 = 25;

// P2-a（2026-10-18，design/2026-10-18-pet-p2-recolor-and-expression-sheet.md §1）：
// whale 配色预设表（hue 角度, 饱和度倍率）——**加载期**重着色（image::recolor_*），
// 运行期零开销。**只对 whale 生效**：kurumi/inverse 的发色是角色设定，不参与换色
// （Coopanion 的配色同样只作用于自家 mascot）。
/// 0 = 原色（深蓝鲸鱼娘，默认）。
pub(crate) const COLOR_PRESETS: [(f32, f32); 6] = [
    (0.0, 1.00),   // 原色
    (120.0, 1.00), // 樱粉（蓝 ≈220° → 340°）
    (300.0, 1.00), // 青碧（220° → 160°）
    (55.0, 1.00),  // 紫萄（220° → 275°）
    (150.0, 1.00), // 暖橘（220° → 10°）
    (0.0, 0.30),   // 霜白（去饱和，向亮度灰插值）
];
/// 配色预设数上限（`COLOR_PRESETS.len() - 1`，设置夹取用）。
pub(crate) const COLOR_MAX: u32 = COLOR_PRESETS.len() as u32 - 1;
