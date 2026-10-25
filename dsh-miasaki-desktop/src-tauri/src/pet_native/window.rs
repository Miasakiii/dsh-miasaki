//! 桌宠窗口：PetWin compose/交互 + 窗口过程 + 启动（D2 拆分）
use std::os::raw::c_void;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use super::config::*;
use super::backdrop;
use super::dot;
use super::ffi::*;
use super::image::*;
use super::marks::*;
use super::model::*;
use super::persist::*;
use super::xform::*;
use super::{PetShared, PetState};
pub(crate) struct PetWin {
    hwnd: isize,
    dot_hwnd: isize,
    app: AppHandle,
    shared: Arc<Mutex<PetShared>>,
    frames: Frames,
    buf: Vec<u32>,
    frame_idx: usize,
    anim_ms: u64,
    last_tick: std::time::Instant,
    /// M1.1(v3):一次性/环境动作统一槽位——到期即清,状态姿态(waiting/fleet_alert)在
    /// 行选择链中优先于它(pick_state_row)。旧 hop_until 无复位路径的卡死缺陷就此铲除。
    action: Option<ActionSlot>,
    /// M1.3:单击去抖挂起中(UP 已落、250ms 内待判定是否双击)
    click_pending: bool,
    /// M1.3:双击序列的第二次 WM_LBUTTONUP 待吞(防「挥一次+跳一次」)
    swallow_next_up: bool,
    /// M2:Done 庆祝已播(一次性 review,不循环;state 离开 Done 后复位)
    done_celebrated: bool,
    /// L1(v5,2026-09-28):挤压脉冲起始时刻。两个触发点——Done 庆祝挂 `review` 槽时、
    /// `Jump` 到期转 `JumpHold`（落地）时。**到期即清**（compose 内清 None），
    /// 与 `ActionSlot` 同哲学：绝不留残留形变（`squash_scales` 两端恒回中性）。
    squash_start: Option<std::time::Instant>,
    next_ambient: std::time::Instant,
    /// R4(2026-09-16):提醒（气泡）——取代 v3 的单槽 `Option<(usize, Instant)>`，
    /// 带稳定 id + 优先级 + 常驻标记（模型见 `model.rs::Alert`）。
    alert: Option<Alert>,
    /// R7:当前气泡的展示起点（最小驻留防抖；审批/告警不受其约束）。
    alert_shown_at: std::time::Instant,
    /// R5:审批决策单调序号（防重放；随 eval 事件一起下发，插件侧据此去重）。
    decision_seq: u64,
    /// R5:最近一次用户决策（官方 key → 发起时刻）——用于「点了但没生效」的回落提示。
    last_decision: Option<(String, std::time::Instant)>,
    press_pt: (i32, i32),
    /// R13（2026-10-05）：拖动合帧 —— `WM_MOUSEMOVE` 只记**最新绝对目标**，
    /// 由 `IDT_DRAG`（8ms）消费。`None` = 本节拍无新目标（已消费过或未在拖动）。
    ///
    /// **为什么存绝对目标而不是增量**：原实现每次 `MoveWindow` 后把 `press_pt` 推到当前光标
    /// （增量式）。合帧后 `MoveWindow` 由定时器做，`WM_MOUSEMOVE` 里不再移动窗口 ⇒ 若仍沿用
    /// 增量式，`press_pt` 会停留在按下点不动，`dx/dy` 变成「按下点 → 当前光标」的**累计位移**，
    /// 反复叠加会飞掉。存绝对目标从根上避开。
    drag_target: Option<(i32, i32)>,
    /// M4（2026-10-05）：拖动尾随的弹簧状态（x / y 各一份）。
    /// `None` = 当前不在尾随中（或刚开始拖动尚未初始化）⇒ 用 `pos` 与零速度起跳。
    ///
    /// **为什么存两份而不是一个 `[DragSpring; 2]`**：`Option` 的 `None` 能表达
    /// 「未初始化」这个第三态，数组做不到（得再加一个 bool 标志位）。
    drag_spring_x: Option<DragSpring>,
    drag_spring_y: Option<DragSpring>,
    /// M4：上一拍 `IDT_DRAG` 的时刻 —— 弹簧积分要用**真实经过的时间**而非写死 8ms
    /// （写死的话，帧间隔抖动会让弹簧的刚度随负载漂移；且无法单测「dt 参数正确性」）。
    last_drag_tick: std::time::Instant,
    /// R13：`IDT_DRAG` 是否已挂上（`WM_MOUSEMOVE` 里只挂一次，不每事件重挂）。
    /// 为什么要显式记而不用 `GetTimer` 反查：`SetTimer` 同 id 会**替换**计时周期，
    /// 逐事件重挂等于把节拍永远往后推 ⇒ 合帧失效。
    /// M4.1：当前停靠的边（ = 未停靠）。随拖动更新，也随 `pet.json` 落盘。
    ///
    /// **为什么要单独存而不能每次重算**：显隐切换时也会 `save_pet_pos`，那时位置未变、
    /// 判定结果也相同，但**多屏枚举在某些时刻会失败**（`monitor_workspaces` 返回空 ⇒
    /// 兜底成主屏 ⇒ 可能算出不同的边）。存住最后一次判定结果更稳。
    docked_edge: Option<DockEdge>,
    /// M4.1：peek 状态机（相位 + 当前外移量）。纯逻辑在 `model.rs`，窗口层只驱动节拍——
    /// 相位推进搭 compose 33ms 节拍（真实 dt），边界检测（静置/光标压上）走 `IDT_PEEK` 轮询。
    peek: PeekState,
    /// M4.1：吸附基准位（slide=0 的窗口位置）。peek 动画以它为原点沿边外移，
    /// 这样工作区几何在探头途中变化时只需重算 `dock_push_out`，动画位移不叠在旧位置上。
    dock_base: (i32, i32),
    /// DPI(2026-10-05)：窗口所在显示器的 DPI（`GetDpiForWindow` 的返回值，96 = 100%）。
    /// 窗口物理尺寸、present 用的 DIB、以及**素材绘制时的缩放**全部由它推出
    /// （`model::dpi_scale` / `scaled_window_size`），判据与单测见 `model.rs` 的 DPI 段。
    ///
    /// **为什么必须存而不是每次问系统**：`buf` 按物理尺寸分配、DIB 按物理尺寸创建，
    /// 两者在 DPI 变化时都必须**重建**（尺寸变了），重建代价不小 ⇒ 只在
    /// `WM_DPICHANGED` 时算一次。`0` = 尚未取值（首个 compose 前会补上）。
    dpi: u32,
    /// M4.1：最近一次用户交互（光标压上角色 / 按下 / 拖动）——peek「静置 5s」判定的时钟。
    /// 光标一直停在角色上时它持续刷新 ⇒ 桌宠不会从用户手底下缩走。
    last_interaction: std::time::Instant,
    /// M4.1：peek 相位推进的上一拍时刻（compose 内积分真实 dt 用）。
    last_peek_tick: std::time::Instant,
    dragging_timer_on: bool,
    dragged: bool,
    /// R18（2026-10-17）：松手滑停中——`WM_LBUTTONUP` 不清目标、不 snap，
    /// `IDT_DRAG` 续跑到弹簧双轴到位后由 `drag_settle_tick` 收尾落盘。
    /// 存在理由：快速甩动后弹簧还剩几十 px 残余滞后，旧实现松手瞬间 `MoveWindow`
    /// 到目标 = 可见前跳。
    drag_settling: bool,
    /// R18：弹簧当前速度（px/s，x/y）——`flush_drag_target` 每拍写入，compose 据此算
    /// 拖动倾斜/拉伸（`xform::drag_lean`）。未拖动/滑停收尾后恒 `(0,0)`。
    drag_vel: (f32, f32),
    /// R18：悬浮球拖动合帧的最新绝对目标（球**无弹簧**、直跟手；合帧只为省 MoveWindow）。
    dot_drag_target: Option<(i32, i32)>,
    /// R18：悬浮球是否已越过拖动阈值——`WM_LBUTTONUP` 的分流判据：
    /// 拖过 ⇒ `end_dot_drag` 落盘留在新点；未拖过 ⇒ `show_self` 恢复桌宠（原语义）。
    dot_dragged: bool,
    /// R18：悬浮球拖动的按下点（屏幕坐标）。与主窗 `press_pt` 分立——两个 hwnd
    /// 不会同时收到鼠标消息（球可见时主窗隐藏），但共用一个 `PetWin`，必须分开存。
    dot_press_pt: (i32, i32),
    /// R18：`IDT_DOT_DRAG` 是否已挂（同主窗 `dragging_timer_on`：只挂一次，
    /// 逐事件重挂会把节拍永远往后推 ⇒ 合帧失效）。
    dot_dragging_timer_on: bool,
    pos: (i32, i32),
    /// 主窗口当前实际显示状态（与 shared.hide 同步；show/hide 切换由 compose 单线程执行）。
    shown: bool,
    /// 2026-09-29：悬浮球**当前是否可见**（影子状态）。
    /// 为什么不每次问系统 `IsWindowVisible`：命中轮询每 10ms 一次，而那是个系统调用；
    /// 这里只在**显隐切换**与**托盘档位变化**两个点上改，读起来与系统状态一致。
    dot_shown: bool,
    next_quote: std::time::Instant,
    next_wander: std::time::Instant,
    // 持久 GDI 表面:创建一次,终身复用(消除高频 CreateDIBSection,防 gdi32full 崩溃)
    present_dc: isize,
    present_dib: isize,
    present_bits: *mut c_void,
    /// D3 GDI 兜底:ULW 连续失败计数（成功清零；达阈值触发表面重建）
    ulw_fail_streak: u32,
    /// D3 GDI 兜底:表面无效连续计数（创建失败/句柄丢失时低频重试重建）
    surface_fail_streak: u32,
    /// D3 GDI 兜底:累计重建次数（诊断用，pet.log 可见）
    surface_rebuilds: u32,
    /// R2:当前是否已置位「鼠标穿透」扩展样式（缓存，避免每次轮询都读写窗口样式）
    click_through: bool,
    /// R2:穿透样式切换累计次数（诊断；每 CLICK_THROUGH_LOG_EVERY 次打一行）
    ct_switches: u32,
    /// 2026-09-24:隐藏态悬浮球的球面缓冲（`DOT_SIZE²` 预乘，`dot::render` 的最终合成结果）。
    /// 同时是悬浮球的命中共据——hover 与鼠标穿透都直接查它（与 R2 主窗同范式）。
    dot_buf: Vec<u32>,
    /// 悬浮球当前已渲染的主题名：与 `shared.theme` 比对，变化即重绘（隐藏态可见时立即换面）。
    dot_theme: String,
    /// 光标是否悬停在悬浮球上（悬停 → 放大 + 光晕增强；离散两态，不做插值动画）。
    dot_hover: bool,
    /// 悬浮球窗口当前是否已置位穿透（与主窗 `click_through` 各自独立——两个 hwnd 各自持有样式）。
    dot_click_through: bool,
    /// R20-a（2026-10-17）：全屏规则是否当前持有隐藏（瞬态，不落盘）。
    /// `true` = 桌宠因「前台全屏覆盖本显示器」被规则藏起来，退出全屏即还原。
    fs_hidden: bool,
    /// R20-c：上一帧画出的角色框（窗口局部物理像素：x, y, w, h）。
    /// 背景 halo 的定位（贴在框外扩）与桌面采样带（框两侧）都以它为基准；
    /// `w == 0` = 尚无有效帧。halo 只在**静态**时画（拖动/滑停期角色在动，
    /// 环会滞后一帧显得脱节），故静态期这个框本来就是稳的。
    last_char_box: (i32, i32, i32, i32),
    /// R20-c：下一次背景采样的时刻（compose 节拍里判断，不新开定时器）。
    next_backdrop: std::time::Instant,
    /// R20-c：背景对比柔光的带回差状态（判据见 `backdrop`）。
    halo: backdrop::HaloState,
    /// R20-c（2026-10-19 重做）：轮廓柔光的三个复用缓冲（角色 alpha / 水平模糊 / 垂直模糊）。
    /// 尺寸 = 窗口物理像素；首次启用时按窗分配（`apply_halo` 内 resize）。
    halo_mask: Vec<u8>,
    halo_tmp: Vec<u8>,
    halo_blur: Vec<u8>,
    /// R20-a 修正（2026-10-18）：上一拍的 `want_hide`（显隐意图影子），
    /// 仅供本拍算「true→false 下降沿」——全屏规则隐藏期的用户逃逸必须**边沿触发**，
    /// 电平触发会让 compose 与 `fs_poll` 互相拆台（桌宠每 ~250ms 眨一次，
    /// 实机 2991 条 auto-hidden / 0 条 restored）。判据见
    /// `model::show_branch_should_run` 的四例单测。
    last_want_hide: bool,
    /// P0-F1（2026-10-18）：摸头判定状态（纯逻辑在 `model::petting_tick`，
    /// 本文件只在 `IDT_HIT` 轮询里喂事实：光标位置 + 是否命中角色）。
    petting: Petting,
    /// P0-F1：咬手「咬住光标」期间的偏移（光标 − 窗口左上角）。
    /// `Some` = 正咬着，窗口每 `IDT_HIT` 拍跟随光标移到 `cursor - offset`。
    bite_follow: Option<(i32, i32)>,
    /// P0-F1：咬合结束时刻（`BITE_CLING_MS` 后自然松口）。
    bite_until: Option<std::time::Instant>,
    /// P0-F3：抛掷飞行状态（`Some` = 正飞着，`IDT_DRAG` 节拍驱动 `fly_step`）。
    /// 松手速度 ≥ `THROW_VEL_MIN` 时由 `release_drag` 进入；慢放仍走 R18 滑停。
    flying: Option<FlyState>,
    /// P0-F4：心情值（[-100, 100]，会话级**不落盘**——进 pet.json schema 的收益
    /// 不抵迁移成本）。作用面：ambient 加权与 emote 触发（`model::mood_band`）。
    mood: i32,
    /// P0-F4：下一次「被冷落」检查（`MOOD_NEGLECT_EVERY_MS`）。
    next_mood_tick: std::time::Instant,
    /// P0-F2：下一次睡眠时段检查（`SLEEP_CHECK_MS`，compose 时间戳，不新开定时器）。
    next_sleep_check: std::time::Instant,
    /// P1-b：当前播放的表情标记（`None` = 无；到期即清，见 compose 的标记段）。
    mark: Option<MarkPlay>,
    /// P1-b：瞌睡期间 Zzz 的下一次浮动时刻。
    next_zzz: std::time::Instant,
    /// P2-b：是否处于睡眠时段（30s 节拍读一次时钟的缓存）——「瞌睡续觉」钩子
    /// 每拍用它，不能每拍读时钟。入睡/醒来两处更新。
    sleep_night: bool,
    /// P0-F2 审查修正（2026-10-18）：用户交互把桌宠叫醒后的**免睡冷却截止时刻**。
    /// 没有它时，「瞌睡续觉」钩子会在点击/抚摸打断 Sleep 槽后的**下一拍**立刻补回
    /// 睡姿——「点击即醒」实际只醒了一个 compose 拍（判据 E36⑤ 不可达）。
    wake_sleep_until: Option<std::time::Instant>,
    /// P2-a：当前 frames 已按哪个配色预设加载。与 `shared.settings.color` 比对，
    /// 不一致 ⇒ 整份重载 + 重着色（一次性，设置变更才发生）。初值 = 冷启动预设。
    loaded_color: u32,
    /// A 批：当前 frames 已按哪个**形象**加载（whale 换装；其余主题恒 "default"）。
    /// 与 `shared.settings.appearance`（经 mode 门控）比对，不一致 ⇒ 整份重载。
    /// 与 `loaded_color` 合成一个加载键——`load_frames_for(color, appearance)`。
    loaded_appearance: String,
}
impl PetWin {
    fn compose(&mut self) {
        static TICKS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let tick = TICKS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let now = std::time::Instant::now();
        let mut dirty = false;

        // —— 外部命令消费（设置面板 hash 通道 → shared 标志；UI 仅在窗口线程执行）——
        {
            let (want_hide, do_reset, want_theme, want_color, want_appearance) = {
                let mut s = self.shared.lock().unwrap();
                let h = s.hide;
                let r = s.pending_reset;
                let t = s.theme.clone();
                let c = s.settings.color;
                // A 批：形象**只对 whale 生效**（kurumi/inverse 的发型服装是角色设定，
                // 与 P2-a 配色同口径）。mode 取当前 shared 值——钉选/主题变化后
                // 下一次重载判定自然修正（非 whale 时 appearance 恒 default）。
                let a = if s.mode == "whale" {
                    s.settings.appearance.clone()
                } else {
                    super::settings::APPEARANCE_DEFAULT.to_string()
                };
                s.pending_reset = false;
                (h, r, t, c, a)
            };
            // P2-a + A 批：配色/形象变更 ⇒ 整份重载（一次性；两者在 load_frames_for
            // 汇成一个加载键）。重新走 assets::read 保证磁盘 ui/ 覆盖层语义与冷启动一致，
            // 且无状态可漂移。重载约百 ms 的卡顿只发生在用户主动改设置的那一刻——可接受；
            // 改完加载键对齐，之后每拍只是一次整数/字符串比对。
            let color_changed = want_color != self.loaded_color;
            let appearance_changed = want_appearance != self.loaded_appearance;
            if color_changed || appearance_changed {
                self.frames = super::image::load_frames_for(want_color, &want_appearance);
                self.loaded_color = want_color;
                self.loaded_appearance = want_appearance.clone();
                self.last_tick = now - std::time::Duration::from_secs(10); // 强制重绘
                dirty = true;
                // 两条日志分开写：E38 判据读 `recolor -> N` 行；形象切换读 `appearance -> X`。
                if color_changed {
                    pet_log_line(&format!("[native-pet] recolor -> {want_color}\n"));
                }
                if appearance_changed {
                    pet_log_line(&format!("[native-pet] appearance -> {want_appearance}\n"));
                }
            }
            // 2026-09-24:主题变化 → 悬浮球换面（球面头像 + 主题色环/发光）。
            // 先于 reset/显隐切换落地：这样随后那两处的 render_dot 直接带上新主题，
            // 不会先画一帧旧球面再被覆盖。仅当球当前可见（= 桌宠隐藏）时才立即重绘；
            // 球不可见时只更新 dot_theme，留给显隐切换那次渲染。
            if want_theme != self.dot_theme {
                self.dot_theme = want_theme;
                if !self.shown {
                    self.render_dot();
                }
            }
            if do_reset {
                let p = default_pos();
                self.pos = p;
                // DPI：位置重置不动尺寸，但 MoveWindow 的尺寸参数必须仍是当前物理尺寸
                let (ww, wh) = self.win_size();
                unsafe {
                    MoveWindow(self.hwnd, p.0, p.1, ww, wh, 1);
                }
                self.render_dot();
                pet_log_line(&format!("[native-pet] position reset -> {},{}\n", p.0, p.1));
                // M4.1：位置重置不是拖动 ⇒ 无停靠语义（dock=None）；peek 同步归零
                peek_reset(&mut self.peek);
                self.docked_edge = None;
                self.dock_base = p;
                save_pet_pos(p, want_hide, None);
                self.last_tick = now - std::time::Duration::from_secs(10); // 强制重绘
                dirty = true;
            }
            // 目标隐藏状态(want_hide)与当前显示状态(self.shown)语义相反但布尔可比：
            // want_hide=false(显示) 且 shown=true(已显示) → 语义一致，无需切换；
            // want_hide==self.shown(布尔相等) 正是"语义相反需切换"的情形：
            //   (false,false)=想显示但已隐藏 → 显示；(true,true)=想隐藏但已显示 → 隐藏。
            // 2026-09-29 托盘档位可能在「桌宠已隐藏」时被改（面板切成 `tray`/`dot`）。
            // 那条路径不经过上面的显隐切换（状态没变），所以要在这里**每帧对齐一次**。
            // 只在影子状态与设置不符时才调 ShowWindow（该调用不便宜），正常帧零开销。
            if !self.shown {
                let want_dot = self.dot_enabled();
                if want_dot != self.dot_shown {
                    unsafe {
                        ShowWindow(self.dot_hwnd, if want_dot { SW_SHOW } else { SW_HIDE });
                    }
                    self.dot_shown = want_dot;
                    pet_log_line(&format!(
                        "[native-pet] dot visibility -> {} (tray setting)\n",
                        if want_dot { "shown" } else { "hidden" }
                    ));
                }
            }
            // R20-a（2026-10-17）：全屏规则隐藏期（`fs_hidden`）用户要求显示 ⇒ 也要走
            // 切换分支。原条件 `want_hide == self.shown` 在这种情形下恒为 false
            // （影子状态 shown=true 而 want_hide=false，布尔相等判断认为「无需切换」），
            // 用户的「显示」会被规则态**吞掉」——面板点了没反应。
            // **R20-a 修正（2026-10-18 实机事故）**：逃逸必须是**边沿触发**。
            // 首版补的 `fs_hidden && !want_hide` 是电平触发——规则藏着桌宠时
            // `want_hide` 恒 false ⇒ compose 每拍都「显示 + 清规则态」、fs_poll 下一拍
            // 再藏 ⇒ 桌宠在全屏应用上每 ~250ms 眨一次（实机 2991 条 auto-hidden /
            // 0 条 restored）。现只在 `want_hide` 出现 true→false **下降沿**（用户主动
            // 取消隐藏）时放行一次；常驻意图不触发。判据与回归见
            // `model::show_branch_should_run` 的四例单测（R20a-F3 是防线）。
            // 逃逸后规则下一拍重新生效（Coopanion 同口径；要常驻请关「全屏时隐藏」）。
            let want_hide_falling_edge = !want_hide && self.last_want_hide;
            if show_branch_should_run(want_hide, self.shown, self.fs_hidden, want_hide_falling_edge) {
                unsafe {
                    if want_hide {
                        // M4.1：隐藏前先回吸附位——悬浮球按 pos 定位，peek 外移量会让
                        // 半颗球在屏外找不回；且重启恢复也应是「全可见的吸附位」。
                        if self.peek.phase != PeekPhase::Off {
                            peek_reset(&mut self.peek);
                            self.pos = self.dock_base;
                        }
                        ShowWindow(self.hwnd, SW_HIDE);
                        // 2026-09-29 托盘设置：`dot` / `both` 显示悬浮球；`tray` 只留托盘。
                        // `tray=tray` 时的找回入口是系统托盘菜单（`hide_to_tray` 那条路径）。
                        if self.dot_enabled() {
                            ShowWindow(self.dot_hwnd, SW_SHOW);
                        } else {
                            ShowWindow(self.dot_hwnd, SW_HIDE);
                        }
                    } else {
                        ShowWindow(self.dot_hwnd, SW_HIDE);
                        ShowWindow(self.hwnd, SW_SHOW);
                        // R20-a：用户（或规则解除）在这里显示主窗 ⇒ 规则态让位
                        self.fs_hidden = false;
                    }
                }
                self.dot_shown = want_hide && self.dot_enabled();
                self.shown = !want_hide;
                // M1.4:显隐切换同步悬浮球(want_hide=true 时 dot 即将可见,必须先定位到当前 pos)
                self.render_dot();
                pet_log_line(&format!(
                    "[native-pet] {} (hide persisted)\n",
                    if want_hide { "hidden" } else { "shown" }
                ));
                // M4.1：显隐切换**位置未变** ⇒ 必须保留既有 dock，不能顺手清成 None
                save_pet_pos(self.pos, want_hide, self.docked_edge);
                dirty = true;
            }
            // R20-a 修正：每拍记录 `want_hide`，供下一拍算**下降沿**（边沿检测的唯一状态）。
            // 必须在分支外无条件更新——只在分支里更新会漏掉「没执行分支的那些拍」，
            // 沿检测随即失灵（要么永远假、要么把一次真实切换判成连续沿）。
            self.last_want_hide = want_hide;
        }

        // —— M2(v3):六态合成(官方契约优先,DOM 兜底,fleet 叠加) ——
        // 优先级:Waiting > FleetBlocked > Error > Done > Thinking > Idle(roadmap M2.1,
        // 继承 M1.2「审批 > 告警」次序)。官方通道(pet= hash,白名单归一化)5s 内有心跳
        // 才采信;静默回落 DOM 扫描(activity/waiting_approval,来自 act=/wait= 字段)。
        // fleet_running(有任务在跑)不改六态,只影响 eff 立绘与 BUSY 气泡(沿用 X2 语义)。
        let (state, fleet_running) = {
            let s = self.shared.lock().unwrap();
            let fresh = s
                .official_at
                .map(|t| now.duration_since(t) < std::time::Duration::from_millis(OFFICIAL_FRESH_MS))
                .unwrap_or(false);
            let mut st = if fresh {
                s.official_state.unwrap_or(PetState::Idle)
            } else if s.waiting_approval {
                PetState::Waiting
            } else if s.activity == "busy" {
                PetState::Thinking
            } else {
                PetState::Idle
            };
            if st != PetState::Waiting && s.fleet_alert {
                st = PetState::FleetBlocked; // M1.2 次序:审批 > 告警
            }
            (st, s.fleet_running)
        };
        // Done 庆祝:一次性 review 槽 + 常驻「完成了」气泡(10s,由 JS 侧 doneHold 归 idle 收尾)
        if state == PetState::Done && !self.done_celebrated {
            self.done_celebrated = true;
            self.action = Some(ActionSlot {
                action: Action::Ambient { row: "review".to_string() },
                started: now,
                duration: std::time::Duration::from_millis(DONE_REVIEW_MS),
            });
            self.frame_idx = 0;
            self.last_tick = now - std::time::Duration::from_secs(10);
            // L1(v5) M3:庆祝起手挤压一次 —— whale 图集没有 review 行（Done 按回退链落 idle，
            // 见 image.rs 的 whale_row_shares_fallback_chain），挤压脉冲正是给它的零素材庆祝表达。
            self.squash_start = Some(now);
            // R20-b：完成庆祝琶音（与挤压脉冲同一拍，视听同庆）
            self.sfx("done");
            // P0-F4：任务完成，与有荣焉（心情 +）
            self.mood = mood_apply(self.mood, MoodEvent::Done);
            // P1-b：星星（得意/期待）——与庆祝琶音同拍的「面上有光」
            self.show_mark(mark_for_done(), now);
            dirty = true;
        } else if state != PetState::Done {
            self.done_celebrated = false;
        }

        // —— M1.1(v3):动作槽统一到期清理(先于一切触发门与行选择) ——
        // 到期即清;Jump 先转 JumpHold 落地定格。旧实现的 hop_until 只有写入没有复位,
        // 单击一次后每帧重挂 hold → 永久 jump 并遮蔽审批/告警姿态(D1/D3)。
        if let Some(slot) = self.action.take() {
            if slot.expired(now) {
                match slot.action {
                    Action::Jump => {
                        self.action = Some(ActionSlot {
                            action: Action::JumpHold,
                            started: now,
                            duration: std::time::Duration::from_millis(HOP_HOLD_MS),
                        });
                        // L1(v5) M3:落地挤压一次（与 Done 庆祝共用同一脉冲通道）。
                        self.squash_start = Some(now);
                        // R20-b：落地「噗」（与起跳音成对；用户感知为一次完整的跳）
                        self.sfx("land");
                    }
                    Action::Wander { .. } => {
                        // M1.4:散步自然结束同步悬浮球,隐藏后恢复入口不脱节
                        self.render_dot();
                    }
                    _ => {}
                }
            } else {
                self.action = Some(slot);
            }
        }

        // —— P2-b：瞌睡续觉（每拍）——
        // exSleepy 犯困表情走的是 `Ambient` 动作槽（单槽互斥），它把 Sleep 慢呼吸
        // 槽换掉了；到期即清后在这里**立即补回** Sleep——否则「犯困脸闪一下就
        // 精神了」，后面整晚只剩普通待机。夜间判定用 30s 节拍缓存的
        // `sleep_night`（不在此处读时钟）；准入条件与入睡门一致。
        if self.sleep_night
            && self.action.is_none()
            && state == PetState::Idle
            && self.alert.is_none()
            && !self.dragged
            && !self.drag_settling
            && self.flying.is_none()
            && self.bite_follow.is_none()
            && !self.sleep_wake_blocked(now)
        {
            self.action = Some(ActionSlot {
                action: Action::Emote { kind: EmoteKind::Sleep },
                started: now,
                duration: std::time::Duration::from_millis(SLEEP_MS),
            });
        }

        // —— 待机随机行为：定时气泡台词 + 定时散步（有行走帧的主题才散步,左右移动贴边吸附） ——
        if now >= self.next_quote && self.alert.is_none() {
            self.next_quote = now + std::time::Duration::from_millis(rand_range(40000, 90000));
            let (idx, bubble_ms) = {
                let s = self.shared.lock().unwrap();
                (pick_quote(&s.mode), s.settings.bubble_ms)
            };
            // R4:定时台词是最低优先级限时项——不覆盖任何常驻提醒（状态/审批/告警）
            // 2026-09-29:驻留时长改由用户设置（`settings.bubble_ms`），默认即原 `QUOTE_MS`。
            self.alert = Some(Alert::timed("quote", idx, ALERT_PRI_QUOTE, bubble_ms));
            self.alert_shown_at = now;
            self.last_tick = now - std::time::Duration::from_secs(10); // 立即触发重绘
            dirty = true;
        }
        if self.action.is_none() && now >= self.next_wander {
            // v2026-08-30:waiting 期间禁止散步(强制桌宠站定在审批气泡旁)
            // X2:fleet 指示期间同样站定;M2(v3):非 Idle 六态(工作/告警/出错/庆祝)全部站定
            // v5 L0-3:散步的准入从「kurumi 专属」改为「该主题是否具备散步行」——
            // whale 图集接入后同样有 runRight/runLeft，散步对它才第一次可触发；
            // inverse 无图集恒 false（否则会"平移但只能播 idle"，表现为滑步假位移）。
            let (can_walk, fleet_running) = {
                let s = self.shared.lock().unwrap();
                (self.frames.can_wander(&s.mode), s.fleet_running)
            };
            let blocked = state != PetState::Idle || fleet_running;
            // M4.1（R14 实机教训②）：停靠/探头期间必须**拦住全部位移来源**——
            // wander 是拖动之外唯一的窗口位移源，缺一处就会出现「挂着探头姿态被平移出屏」。
            // R16（2026-10-12）：**再补 `!self.dragged`** —— 原先只闸了 `docked_edge`，
            // 于是拖动恰好跨过 45–120s 的散步时点时会出「桌宠自己横向走」：
            // wander 每帧直接改 `self.pos.0`（`WANDER_PX_PER_FRAME`×2 处），
            // 而拖动读的也是 `self.pos` ⇒ 两者抢同一个量。
            // R18（2026-10-17）：**再补 `!self.drag_settling`** —— 松手滑停的 ≤300ms 内
            // `dragged` 已清零，但 `IDT_DRAG` 还在按弹簧推窗口；此时起 wander 就是
            // 「两个位移源抢 `self.pos`」（与 R16 同型，只是窗口从起手换成了滑停）。
            if can_walk
                && !blocked
                && self.docked_edge.is_none()
                && !self.dragged
                && !self.drag_settling
                && self.flying.is_none()
            {
                let dir = if rand_u32() % 2 == 0 { 1 } else { -1 };
                self.action = Some(ActionSlot {
                    action: Action::Wander { dx: dir },
                    started: now,
                    duration: std::time::Duration::from_millis(rand_range(1100, 2400)),
                });
                // L0-1(v5):散步行按 dx 选 runRight/runLeft,左右切换时从该行首帧起播
                // ——否则沿用上一行的相位,回头瞬间步态错位(ambient 分支同款复位)。
                self.frame_idx = 0;
                dirty = true;
            }
            self.next_wander = now + std::time::Duration::from_millis(rand_range(45000, 120000));
        }
        // —— v2 环境编排：idle 基线低频随机小动作(手势打断见 wnd_proc) ——
        // P0-F4（2026-10-18）：选池改走心情加权（`pick_ambient_choice`）——emote 概率由
        // `mood_band(self.mood)` 决定，行池与行权重视主题而定（P1-a：whale 池含待机变体）。
        // C 批（2026-10-19）：再叠加时段档（`time_band(local_hour())`）——深夜/傍晚
        // 压低活跃行、安静行抬升、High 档不跳舞（纯函数 + 单测，见 model.rs）。
        if self.action.is_none() && now >= self.next_ambient {
            let (idle_intensity, mode) = {
                let s = self.shared.lock().unwrap();
                (s.intensity == "idle", s.mode.clone())
            };
            // M2(v3):非 Idle 六态(含 fleet_running)不开小动作(触发必能播,不挂空槽)
            let blocked = state != PetState::Idle || fleet_running;
            if idle_intensity && !blocked && self.alert.is_none() {
                let band = mood_band(self.mood);
                // C 批（2026-10-19）：时段档——`GetLocalTime` 是廉价的用户态调用，
                // ambient 点火 8–18s 一次，直接现取不缓存（睡眠块 30s 一拍的门控
                // 与这里不同步，缓存反而要多养一条失效路径）。
                let time = time_band(local_hour());
                // A 批：可用性过滤——当前生效形象缺的行永不上场（P1-a 空转槽纪律的
                // 推广：新形象未必有 wave/idle2–idle5 全部行）。过滤后池空时
                // pick_ambient_choice 回落未过滤池，不回 blank。
                let has = |row: &str| self.frames.rows_have(&mode, row);
                let (action, dur_ms) = match pick_ambient_choice(band, &mode, time, &has) {
                    AmbientChoice::Row(row) => (
                        Action::Ambient { row },
                        rand_range(AMBIENT_PLAY_MIN_MS, AMBIENT_PLAY_MIN_MS + AMBIENT_PLAY_VAR_MS),
                    ),
                    // P0-F2：抽中 emote——时长走词表（`emote_duration`），与行内 ambient 二选一
                    AmbientChoice::Emote(kind) => (Action::Emote { kind }, emote_duration(kind)),
                };
                self.action = Some(ActionSlot {
                    action,
                    started: now,
                    duration: std::time::Duration::from_millis(dur_ms),
                });
                self.frame_idx = 0;
                // P1-b：心情的「面上」表达——High 档偶尔冒爱心、Low 档偶尔冒泪滴。
                // 与行/emote 抽样独立（各自的 rand），概率见 `MARK_PCT_*`；
                // Mid 档不挂（平常脸不需要符号）。
                let mark_pct = match band {
                    AmbientBand::High => MARK_PCT_HIGH,
                    AmbientBand::Low => MARK_PCT_LOW,
                    AmbientBand::Mid => 0,
                };
                if mark_pct > 0 && rand_u32() % 100 < mark_pct {
                    let kind = if band == AmbientBand::High { Mark::Heart } else { Mark::Tear };
                    self.show_mark(kind, now);
                }
                dirty = true;
            }
            self.next_ambient = now + std::time::Duration::from_millis(
                rand_range(AMBIENT_REST_MIN_MS, AMBIENT_REST_MIN_MS + AMBIENT_REST_VAR_MS),
            );
        }

        // —— P0-F4：被冷落检查（10min 无交互 ⇒ 心情 -4）——
        // 时钟源 = `last_interaction`（光标压上/按下/拖动都会刷新它，peek 同源）。
        if now >= self.next_mood_tick {
            self.next_mood_tick = now + std::time::Duration::from_millis(MOOD_NEGLECT_EVERY_MS);
            if now.duration_since(self.last_interaction)
                >= std::time::Duration::from_millis(MOOD_NEGLECT_EVERY_MS)
            {
                self.mood = mood_apply(self.mood, MoodEvent::Neglect);
            }
        }

        // —— P0-F2：睡眠时段检查（30s 一拍；深夜自动打瞌睡，早晨/交互醒来）——
        // Sleep 占住动作槽 ⇒ wander/ambient 的 `action.is_none()` 门自动压制（免费互斥）；
        // 点击/摸头/咬手经 WM_LBUTTONDOWN 的 interrupt 清单叫醒（见该分支）。
        if self.shown && !self.fs_hidden && now >= self.next_sleep_check {
            self.next_sleep_check = now + std::time::Duration::from_millis(SLEEP_CHECK_MS);
            let hour = local_hour();
            let night = hour >= SLEEP_START_HOUR || hour < SLEEP_END_HOUR;
            // 缓存夜间判定：下面的「瞌睡续觉」钩子每拍跑，不能每拍读时钟
            self.sleep_night = night;
            let has_sleep = matches!(
                &self.action,
                Some(s) if matches!(s.action, Action::Emote { kind: EmoteKind::Sleep })
            );
            if night && !has_sleep && state == PetState::Idle && self.alert.is_none()
                && !self.dragged && !self.drag_settling && self.flying.is_none()
                && self.bite_follow.is_none()
                // 2026-10-18 审查修正：刚被叫醒的免睡冷却内不再挂睡姿
                && !self.sleep_wake_blocked(now)
            {
                self.action = Some(ActionSlot {
                    action: Action::Emote { kind: EmoteKind::Sleep },
                    started: now,
                    duration: std::time::Duration::from_millis(SLEEP_MS),
                });
                // R20-b/P0：起始一个哈欠（听觉上的「去睡了」）
                self.sfx("yawn");
                // P1-b/P2-b：进入瞌睡先演一次**犯困表情帧**（whale；其余主题落
                // Zzz 符号）——表情走动作槽会把下面刚挂的 Sleep 槽换掉，到期后
                // 由「瞌睡续觉」钩子补回（见 compose 动作清理段）
                self.show_mark(Mark::Sleepy, now);
                self.sleep_night = true;
                self.next_zzz = now + std::time::Duration::from_millis(ZZZ_EVERY_MS);
                pet_log_line("[native-pet] sleep: 进入瞌睡（深夜时段）\n");
                dirty = true;
            } else if !night && has_sleep {
                self.action = None;
                self.sleep_night = false;
                pet_log_line("[native-pet] sleep: 早晨醒来\n");
                dirty = true;
            }
        }
        // —— P1-b（2026-10-18 审查修正）：瞌睡 Zzz 周期浮动 ——
        // 原实现把它放在上面的 30s 睡眠检查门内，实际每 30s 才检查一次 `next_zzz`
        // （设计写「每 3s 浮动一次」，判据 E37/E38 不可达）。现改为每拍检查：
        // 只在**确实处于 Sleep 槽**时刷（入睡瞬间的犯困表情帧把槽占住 1.4s，
        // 那段不刷 Zzz——表情优先，续觉钩子补回 Sleep 后自然恢复）。
        if self.shown && !self.fs_hidden && self.sleep_night && now >= self.next_zzz {
            let sleeping = matches!(
                &self.action,
                Some(s) if matches!(s.action, Action::Emote { kind: EmoteKind::Sleep })
            );
            if sleeping {
                self.next_zzz = now + std::time::Duration::from_millis(ZZZ_EVERY_MS);
                self.show_mark(Mark::Zzz, now);
            }
        }

        // —— M4.1：peek 状态机节拍（相位推进）——
        // 边界检测（静置 5s / 光标压上）在 `IDT_PEEK`（`peek_poll`）；这里只做两件事：
        // ① 气泡在场 ⇒ 立即弹回吸附位：气泡画在窗口上部、随窗口平移，探头会把它裁出屏外
        //    （审批按钮不可点 = 功能回归）。瞬移 + 气泡同帧出现，读感是「它跳出来汇报」；
        // ② 推进过渡动画：真实 dt ⇒ 隐藏/挂起不吃进度（R14 pause/resume 口径），
        //    slide 变化即置 dirty（present 的 ULW 按新 pos 落窗——缩边零绘制改动的落点）。
        if self.shown && self.docked_edge.is_some() {
            let edge = self.docked_edge.unwrap();
            if self.alert.is_some() {
                if self.peek.phase != PeekPhase::Off {
                    peek_reset(&mut self.peek);
                    self.pos = self.dock_base;
                    dirty = true;
                }
            } else {
                // dt 夹到 100ms：单拍被拖长（系统忙）时动画放缓而不是跳帧
                let dt = now.duration_since(self.last_peek_tick).as_millis().min(100) as u32;
                let before = self.peek.slide;
                // DPI(2026-10-05)：role 用物理像素、margin 同步缩放（否则探头跨距算错）
                let role = self.role_local_phys();
                let m = self.dock_margin();
                peek_advance(&mut self.peek, role, edge, m, dt);
                if self.peek.slide != before {
                    self.pos = peek_window_pos(self.dock_base, edge, self.peek.slide);
                    dirty = true;
                }
            }
        }
        self.last_peek_tick = now;

        if now.duration_since(self.last_tick).as_millis() >= self.anim_ms as u128 {
            self.last_tick = now;
            // —— wander 滑步修正(v2):位移与 run 帧同步(每帧 9px),步频一致 ——
            // (自然到期由 compose 前段统一清理处理;此处只处理撞墙中断)
            let wander_dx = match &self.action {
                Some(s) => match s.action {
                    Action::Wander { dx } => Some(dx),
                    _ => None,
                },
                None => None,
            };
            if let Some(dx) = wander_dx {
                self.pos.0 += dx * WANDER_PX_PER_FRAME;
                // DPI(2026-10-05)：每帧步长按 DPI 放大（200% 下 9px/帧会是原速的一半），
                // 撞墙钳制用**物理窗宽**（窗口已按 DPI 放大，用基准值会提前停）。
                let step = scaled_px(WANDER_PX_PER_FRAME, self.dpi);
                let (pw, _) = self.win_size();
                let (sw, _) = screen_size();
                self.pos.0 += dx * (step - WANDER_PX_PER_FRAME);
                if self.pos.0 <= 0 {
                    self.pos.0 = 0;
                    self.action = None;
                } else if self.pos.0 >= sw - pw {
                    self.pos.0 = sw - pw;
                    self.action = None;
                }
                if self.action.is_none() {
                    // M1.4:散步撞墙中断同步悬浮球(本段结尾统一置 dirty,present 会应用新 pos)
                    self.render_dot();
                    // P0-F2：撞墙 ⇒ 回头张望一下（零素材的性格表达；800ms 后自然回 idle）
                    self.action = Some(ActionSlot {
                        action: Action::Emote { kind: EmoteKind::Look },
                        started: now,
                        duration: std::time::Duration::from_millis(LOOK_MS),
                    });
                    self.frame_idx = 0;
                    // P2-b：撞墙还带一脸疑惑（whale 演 exDoubt 表情帧并覆盖上面
                    // 的 Look 姿态槽；其余主题 Look 照演 + 头顶飘问号符号）
                    self.show_mark(Mark::Doubt, now);
                }
            }
            // 清空画布只在帧更新时进行,避免 33ms 心跳把中间帧清成空白
            // R20-c：背景采样与判据必须在**清空前**跑——身体平均色从上一帧的
            // 合成缓冲算（buf 此刻还是上一帧）。一帧（33ms）的滞后对 2s 节拍的
            // 判据无感，却省掉「先采样再重画」的顺序死结。
            if self.shown && !self.fs_hidden && self.docked_edge.is_none()
                && !self.dragged && !self.drag_settling
                && now >= self.next_backdrop
            {
                self.next_backdrop = now + std::time::Duration::from_millis(BACKDROP_EVERY_MS);
                self.backdrop_tick();
            }
            for p in self.buf.iter_mut() {
                *p = 0;
            }
            // R20-c（2026-10-19 重做）：轮廓柔光不再在清空后预画——它必须**基于
            // 本帧角色画完后的 alpha 轮廓**生成，所以改在下方两个绘制分支之后调用
            // `apply_halo`（见那里）。绘制时机与闸门（静态期才画）不变。
            let (mode, intensity, fleet_running, motion) = {
                let s = self.shared.lock().unwrap();
                (s.mode.clone(), s.intensity.clone(), s.fleet_running, s.settings.motion)
            };
            // —— L1(v5,2026-09-28)：本帧动效值（design/pet-v5-motion-plan.md §3）——
            // **单值来源**：整帧只算一次，行集分支与三态立绘分支共用同一份 ⇒ 绘制与命中天然一致
            // （`is_transparent_at` 查的就是本段写出的 `buf`，无需任何配套改动；订正说明见 xform.rs 头部）。
            // 相位函数都是纯函数（入参只有毫秒数），此处只负责取时刻与推进脉冲状态。
            let t_ms = now_ms();
            // R18：拖动拎起抬升按物理像素折算（与 `blit_center_bottom` 里
            // `sway_layout_margin(fw) * dpr` 同一口径——mix 逻辑/物理会差一个缩放）。
            let dpr = dpi_scale(self.dpi);
            // M3 挤压脉冲：Done 庆祝 / jump 落地各起一次，`SQUASH_MS` 内推进；**到期即清**。
            let squash_p = match self.squash_start {
                Some(t0) => {
                    let p = now.duration_since(t0).as_secs_f32() * 1000.0 / SQUASH_MS as f32;
                    if p < 1.0 { Some(p) } else { None }
                }
                None => None,
            };
            if squash_p.is_none() {
                self.squash_start = None;
            }
            let (sq_sx, sq_sy) = match squash_p {
                Some(p) => squash_scales(p, motion),
                None => (1.0, 1.0),
            };
            // —— P0-F2：本帧的表演动作（若有）——槽内进度 p 由 compose 现成的事实算
            // （started/duration 都在 ActionSlot 上），编舞值全部来自 `emote_xform` 纯函数。
            // 2026-10-18 审查修正：**六态压制必须同时压编舞**——`pick_state_row` 只换行
            // （wait/failed/run），若这里的变换照旧施加，审批/告警/思考时桌宠会以状态
            // 姿态「点头/发抖/呼吸」（设计 §5.1 明写「Emote 被状态压住，与 jump/wave
            // 同命运」；E36⑥「不抢戏」）。故只在 Idle（槽真正上场）时施加。
            let emote: Option<(EmoteKind, f32)> = if state == PetState::Idle {
                match &self.action {
                    Some(s) => match s.action {
                        Action::Emote { kind } => {
                            let d = s.duration.as_secs_f32().max(1e-6);
                            let p = (now.duration_since(s.started).as_secs_f32() / d).clamp(0.0, 1.0);
                            Some((kind, p))
                        }
                        _ => None,
                    },
                    None => None,
                }
            } else {
                None
            };
            // 挤压期间**必须**关摇摆：`sx = 1.10` 与 ±2° 叠加会让包围盒横向越出 `WIN_W`
            // （xform.rs 的 `squash_plus_sway_would_overflow_so_is_forbidden` 钉住了这件事）。
            // 语义上也自洽：脉冲是「压扁—弹回」的纵向动效，此刻不摆。
            // P0-F2：emote 与挤压同样互斥，且**挤压赢**（Done 庆祝/落地那一拍是大事）——
            // rot 3° 与 squash 1.10 叠加会横向越窗约 6px（xform.rs 的几何账）。
            let can_sway = squash_p.is_none() && emote.is_none();
            // —— M2(v3):六态 → whale/inverse 三态立绘映射 ——
            // Waiting/Error/Done/FleetBlocked → work 立绘(会话有事发生);
            // Thinking → 沿用推理强度(intensity=idle 时升 work);Idle → intensity(fleet_running 例外升 work)
            let eff_intensity = match state {
                PetState::Waiting | PetState::Error | PetState::Done | PetState::FleetBlocked => "work",
                PetState::Thinking => {
                    if intensity == "idle" { "work" } else { intensity.as_str() }
                }
                PetState::Idle => {
                    if fleet_running { "work" } else { intensity.as_str() }
                }
            };
            // —— R4(2026-09-16):提醒（气泡）合流 ——
            // ① 派生「期望项」want（审批 0 > fleet 告警 1 > 状态 2）；
            // ② **同 id 就地更新**（帧变了才换，不重置计时 → 状态抖动不闪）；
            // ③ **高优先级抢占**；④ 低优先级受**最小驻留**保护（R7，防 waiting↔fleet 交替闪烁）；
            // ⑤ 状态类项在状态消失时清除；台词项由超时段清理（见下方）。
            // 注：want 每轮构造含一次短 String 分配，量级与既有 `pick_state_row` 的
            //     `to_string()` 相同，不引入集合增长（沿用「33ms 主路径不新增增长性分配」口径）。
            let want: Option<Alert> = {
                let s = self.shared.lock().unwrap();
                let key = s.official_key.trim();
                // R5:若用户刚点过这个审批、但它仍在（决策没生效：插件缺失/answer 抛错/超时）
                // → 换成 stale 项提示去 DSH 界面处理，**绝不假装成功**。
                let stale = self
                    .last_decision
                    .as_ref()
                    .map(|(k, at)| {
                        k == key
                            && now.duration_since(*at)
                                >= std::time::Duration::from_millis(DECISION_FALLBACK_MS)
                    })
                    .unwrap_or(false);
                match state {
                    PetState::Waiting if !key.is_empty() && stale => Some(Alert::sticky(
                        &format!("approval-stale:{key}"),
                        BUBBLE_NEED_APPROVE,
                        ALERT_PRI_APPROVAL,
                    )),
                    PetState::Waiting if !key.is_empty() => Some(Alert::sticky(
                        &format!("{APPROVAL_ID_PREFIX}{key}"),
                        BUBBLE_WAITING, // 绘制时按 id 前缀改走 approval.png（含两按钮）
                        ALERT_PRI_APPROVAL,
                    )),
                    PetState::Waiting => Some(Alert::state("state:waiting", BUBBLE_WAITING)),
                    PetState::FleetBlocked => {
                        Some(Alert::sticky("fleet:alert", BUBBLE_NEED_APPROVE, ALERT_PRI_ALERT))
                    }
                    PetState::Error => Some(Alert::state("state:error", BUBBLE_ERROR)),
                    PetState::Done => Some(Alert::state("state:done", BUBBLE_DONE)),
                    PetState::Thinking => Some(Alert::state("state:busy", BUBBLE_BUSY)),
                    PetState::Idle => {
                        if fleet_running {
                            Some(Alert::state("state:busy", BUBBLE_BUSY))
                        } else {
                            None
                        }
                    }
                }
            };
            {
                let dwell_ok = now.duration_since(self.alert_shown_at)
                    >= std::time::Duration::from_millis(ALERT_MIN_DWELL_MS);
                let mut apply: Option<Option<Alert>> = None; // Some(None) = 清除
                match (&want, self.alert.as_ref()) {
                    (Some(w), Some(cur)) if same_alert(w, cur) => {
                        if cur.frame != w.frame {
                            apply = Some(Some(w.clone()));
                        }
                    }
                    (Some(w), Some(cur)) if alert_preempts(w, cur) => {
                        // 审批(0)/告警(1) 不受最小驻留约束（可读性优先）；低优先级需驻留期满
                        if w.priority <= ALERT_PRI_ALERT || dwell_ok {
                            apply = Some(Some(w.clone()));
                        }
                    }
                    (Some(w), None) => apply = Some(Some(w.clone())),
                    (None, Some(cur)) if cur.priority <= ALERT_PRI_STATE => apply = Some(None),
                    _ => {}
                }
                if let Some(next) = apply {
                    // R20-b：审批(0)/fleet 告警(1)这类**需要用户行动**的气泡出现时叮咚一声
                    // ——状态气泡(2)/台词(3)不响（那是不用行动的通知，响了就是噪音）。
                    // Done 庆祝有自己的音（在挂 review 槽处），不走这条。
                    if next.as_ref().map_or(false, |a| a.priority <= ALERT_PRI_ALERT) {
                        self.sfx("alert");
                    }
                    // P1-b：需要行动的提醒挂情绪标——**映射是纯函数**
                    // （`mark_for_alert_priority`，单测在 marks.rs）：审批 = 感叹
                    // （「看我看我」），fleet 告警 = 怒纹；Error 是状态档(2)不挂
                    // （它没有「叮咚」，也不该有个符号一直飘——错误已有 failed
                    // 姿态 + 红气泡）。
                    if let Some(a) = next.as_ref() {
                        if let Some(kind) = mark_for_alert_priority(a.priority) {
                            self.show_mark(kind, now);
                        }
                    }
                    self.alert = next;
                    self.alert_shown_at = now;
                    // 帧更新块末尾已无条件置脏（见下方 `dirty = true`），此处不重复赋值
                }
            }
            // —— v5 L0-3:whale 图集接入后的绘制分流（design/pet-v5-motion-plan.md）——
            // whale 有行集（`whale_rows` 非空）⇒ 与 kurumi 走同一条**行选择**路径，
            // 六态与动作姿态第一次对 whale 也可读（此前只有三态立绘 = 非 idle 态近乎静止）。
            // 两个例外（都需要"立绘"这个更重的表达）：
            //   ① whale `intensity == "deep"`：深度推理档，图集无语义对等的强度指示，保留立绘；
            //   ② inverse：没有图集（真素材缺口），维持三态立绘。
            let whale_atlas = mode == "whale" && !self.frames.whale_rows.is_empty();
            let whale_deep_overlay = whale_atlas && intensity == "deep";
            if mode == "inverse" || whale_deep_overlay {
                let key = if whale_deep_overlay || eff_intensity == "deep" {
                    "deep"
                } else if eff_intensity == "work" {
                    "work"
                } else {
                    "idle"
                };
                let states = if mode == "whale" {
                    &self.frames.whale_states
                } else {
                    &self.frames.inverse_states
                };
                // 三态立绘对应三个思考等级(小/中/大或不同姿态),强度来自 DSH 推理等级,切换稳定
                // frames 加载后不可变:裸指针解引用安全(同时规避 self 借用冲突)
                // D2:缺行时回退 idle(与 Frames::atlas_row 同哲学,仅一层,避免误用它态语义)
                let list_ptr = states.get(key).or_else(|| states.get("idle")).map(|l| l as *const Vec<Image>);
                if let Some(ptr) = list_ptr {
                    let list = unsafe { &*ptr };
                    // L1(v5) M1：呼吸覆盖**全部三态** —— 此前只有 idle 会呼吸，work/deep 是彻底静止的
                    // 死图，「反转狂三是一张不会动的画」说的正是这条。立绘分支**不看动作槽**：
                    // 动作槽在这条分支上没有任何视觉表达（inverse 不可散步、ambient 行也不被消费），
                    // 看它只会让呼吸莫名其妙地停一拍。
                    let mut bob = breath_offset(t_ms, BREATH_PX_STATES, motion);
                    // L1(v5) M2：摇摆给 idle / work —— inverse 因此第一次真正「活起来」。
                    // deep 档**只呼吸不摇摆**：那是深度推理档，取「凝神」语义，与 whale deep
                    // 保留立绘覆盖同一取舍（强度档优先表达档位，不再叠姿态噪声）。
                    // R18：拖动中 lean **顶替**摇摆 + 拎起微抬升（零素材反馈，见
                    // `drag_lean_now` / `xform::drag_lean`；不叠加的理由见该函数注释）。
                    let (lean_xf, lifting) =
                        if can_sway { self.drag_lean_now(motion) } else { (DrawXform::IDENTITY, false) };
                    let sway = if can_sway && !lifting && matches!(key, "idle" | "work") {
                        sway_angle(t_ms, motion)
                    } else {
                        0.0
                    };
                    // P0-F2：emote 顶替呼吸+摇摆（表演帧的动效归编舞；挤压在场时挤压赢，
                    // 见上方 `can_sway` 处的互斥纪律）。inverse 三态立绘因此第一次能
                    // 「转身/发抖/跳舞」——它没有图集，绘制层变换是它唯一的动作来源。
                    let emote_xf = emote.filter(|_| squash_p.is_none()).map(|(k, p)| emote_xform(k, p, t_ms, motion));
                    if let Some((_, bob_e)) = emote_xf {
                        bob = bob_e;
                    }
                    if lifting {
                        bob -= DRAG_LIFT_PX * dpr;
                    }
                    // P0-F2：转身的镜像翻转在中点发生（sx 蓄力到最低那一下）
                    let flip = matches!(emote, Some((EmoteKind::Turn, p)) if p >= 0.5);
                    let xf = if lifting {
                        lean_xf
                    } else if let Some((xe, _)) = emote_xf {
                        xe
                    } else {
                        DrawXform::new(sway, sq_sx, sq_sy)
                    };
                    if list.len() > 1 {
                        // v2:帧序列状态(idle.gif 拆帧),6fps 循环 + bob
                        self.anim_ms = 1000 / 6;
                        let idx = self.frame_idx % list.len();
                        self.frame_idx += 1;
                        // R20-c：记下本帧角色框（halo 定位/采样带的基准）
                        self.last_char_box = self.blit_center_bottom(&list[idx], bob, 1.0, &xf, flip);
                    } else if let Some(img) = list.first() {
                        // 单帧:静态 + bob + 摇摆
                        self.anim_ms = 1000;
                        // 2026-10-18 审查修正：单帧分支也必须记角色框——halo/表情标记的
                        // 定位都基准 `last_char_box`，漏写会沿用上一帧框（冷启时甚至
                        // 是 (0,0,0,0) ⇒ 首帧不画环/标记）。
                        self.last_char_box = self.blit_center_bottom(img, bob, 1.0, &xf, flip);
                    }
                }
            } else {
                // M2(v3) 行选择:六态(pick_state_row,优先级 Waiting > FleetBlocked > Error
                // > Done > Thinking > Idle,单测钉死)压制动作槽;Idle 时槽可播。
                let row = pick_state_row(state, self.action.as_ref());
                let fps = match row.as_str() {
                    "run" | "runRight" | "runLeft" => 10,
                    "jump" => 11,
                    "wave" => 8,
                    "wait" | "review" | "failed" => 6,
                    _ => 8,
                };
                self.anim_ms = 1000 / fps;
                // v5 L0-3:帧集按主题分流(kurumi / whale),回退链共用 Frames::atlas_row
                let map =
                    if mode == "whale" { &self.frames.whale_rows } else { &self.frames.kurumi };
                // D2 fallback 链:请求行 → idle → wave → jump → run → 首个可用;
                // 返回实际命中行名(旧代码回退后仍用请求行名重查 → 查不到 → 空白,现修复)。
                // 一次性把「命中帧组的裸指针 + 下标」取出,随后 blit 需要 &mut self,
                // 沿用既有范式(frames 加载后不可变 ⇒ 裸指针解引用安全)规避借用冲突。
                let picked: Option<(*const Vec<Image>, usize)> = match Frames::atlas_row(map, &row) {
                    Some((l, _row_key)) => {
                        // 落地定格窗口:JumpHold 槽期间锁定 jump 末帧,不推进
                        // (Ambient 恰好抽中 jump 行时 kind 不是 JumpHold,照常推进)
                        let holding_jump =
                            matches!(&self.action, Some(s) if matches!(s.action, Action::JumpHold));
                        let idx = if holding_jump { l.len() - 1 } else { self.frame_idx % l.len() };
                        if !holding_jump {
                            self.frame_idx += 1;
                        }
                        Some((l as *const Vec<Image>, idx))
                    }
                    None => None,
                };
                if let Some((ptr, idx)) = picked {
                    let list = unsafe { &*ptr };
                    // L1(v5) M1：呼吸从「仅 idle/wait」放宽到**全部静止姿态**（无动作槽即可）——
                    // 工作态的坐姿打字、wait、failed 此前都是完全静止的死图。
                    // 有动作槽（jump/wave/ambient/wander）时不呼吸：动作本身已经在动，
                    // 且此时的 `bob` 会与帧内位移叠加成抖。
                    let calm = self.action.is_none();
                    let mut bob = if calm { breath_offset(t_ms, BREATH_PX_ROW, motion) } else { 0.0 };
                    // L1(v5) M2：摇摆给 idle（长静置）与 run（打字时轻微起伏）；
                    // 其余是限时动作/事件帧（jump/wave/failed/wait/runRight/runLeft），
                    // 帧内自带位移，再叠旋转会与动作打架，故不接。
                    // R18：拖动中 lean 顶替摇摆 + 拎起微抬升（同立绘分支口径）。
                    let (lean_xf, lifting) =
                        if can_sway { self.drag_lean_now(motion) } else { (DrawXform::IDENTITY, false) };
                    let sway = if can_sway && !lifting && calm && matches!(row.as_str(), "idle" | "run") {
                        sway_angle(t_ms, motion)
                    } else {
                        0.0
                    };
                    // P0-F2：emote 顶替呼吸+摇摆（同立绘分支口径；emote 的基础行是 idle，
                    // 帧内无位移，编舞的 bob/rot 是这一帧唯一的动效来源）。
                    let emote_xf = emote.filter(|_| squash_p.is_none()).map(|(k, p)| emote_xform(k, p, t_ms, motion));
                    if let Some((_, bob_e)) = emote_xf {
                        bob = bob_e;
                    }
                    if lifting {
                        bob -= DRAG_LIFT_PX * dpr;
                    }
                    let flip = matches!(emote, Some((EmoteKind::Turn, p)) if p >= 0.5);
                    let xf = if lifting {
                        lean_xf
                    } else if let Some((xe, _)) = emote_xf {
                        xe
                    } else {
                        DrawXform::new(sway, sq_sx, sq_sy)
                    };
                    // R20-c：记下本帧角色框（halo 定位/采样带的基准）
                    self.last_char_box =
                        self.blit_center_bottom(&list[idx % list.len()], bob, 1.0, &xf, flip);
                }
            }
            // R20-c（2026-10-19 重做）：**角色画完之后**再合成轮廓柔光——光晕的
            // 形状来源就是上一步写进 `buf` 的角色 alpha（贴合任何轮廓，不再是几何椭圆环）。
            // 闸门与首版一致：拖动/滑停期不画（角色在动，光晕会滞后一帧显得脱节，
            // 且「在手上」的桌宠没有融进桌面这个问题）；停靠/peek 与全屏规则隐藏期
            // 同样不画（采样侧早已用 `docked_edge.is_none()` 闸住，绘制侧必须同口径，
            // 否则「采样跳过、绘制照画旧光」）。
            // 开关（`pshl`，设置面板「背景反差光」）与判据是**与**关系：判据说「该画」、
            // 用户说「可以画」才画。设置每帧从 shared 读（与 motion 同口径，不缓存——
            // 缓存就要维护失效路径，而这里一次加锁的成本远低于一条失效链）。
            let halo_enabled = self.shared.lock().map(|s| s.settings.halo).unwrap_or(true);
            if halo_enabled && self.halo.on
                && !self.dragged && !self.drag_settling
                && self.docked_edge.is_none() && !self.fs_hidden
            {
                self.apply_halo();
            }
            // 气泡与角色同帧绘制(帧更新清空 buf 后重画,避免每 tick 文本渲染)
            // R5:审批提醒走独立位图（帧高 84，含「拒绝 / 允许一次」两按钮）；其余仍走 22 帧精灵表
            let is_approval = self
                .alert
                .as_ref()
                .map(|a| a.id.starts_with(APPROVAL_ID_PREFIX))
                .unwrap_or(false);
            if is_approval {
                self.blit_approval();
            } else if let Some(frame) = self.alert.as_ref().map(|a| a.frame) {
                self.blit_bubble(frame);
            }
            // P1-b：表情标记画在气泡之后（在气泡之上、角色头顶上方）——它是这一帧
            // 最后叠上去的「小情绪」，不参与气泡的优先级/驻留体系（独立小状态机）。
            self.blit_mark(now);
            dirty = true;
        }
        // 气泡:超时检查每 tick;绘制只在帧更新后(避免每 33ms 图像合成)
        // R4:常驻项(sticky)不参与超时,须被更高优先级抢占或按 id 移除;
        //     限时项(定时台词/单击反馈)到期即清——取代原先「状态帧不参与 3s 过期」的散列判定。
        if self.alert.as_ref().map(|a| a.expired(now)).unwrap_or(false) {
            self.alert = None;
            dirty = true;
        }
        // P1-b：标记到期即清（与气泡同哲学——绝不留一个永久挂在头顶的符号）。
        // 标记只在帧更新块里画，到期的那一拍若不在帧更新节拍上，下一帧开头就不画
        // （blit_mark 内部对过期项直接返回），这里负责把字段清掉。
        if self.mark.as_ref().map(|m| m.expired(now)).unwrap_or(false) {
            self.mark = None;
            dirty = true;
        }
        if tick < 3 {
            let s = self.shared.lock().unwrap();
            let non_zero = self.buf.iter().filter(|p| **p != 0).count();
            pet_log_line(&format!(
                "[native-pet] tick{} mode={} int={} whale_states={} whale_rows={} kurumi_rows={} buf_nonzero={}\n",
                tick, s.mode, s.intensity,
                self.frames.whale_states.len(),
                // v5 L0-3:whale 图集行数（0 = 图集未内嵌/未切，运行时回落三态立绘）——实机判据
                self.frames.whale_rows.len(),
                self.frames.kurumi.get("idle").map(|v| v.len()).unwrap_or(0),
                non_zero
            ));
        }
        // 脏标记:内容变化才 present,静止时 GDI 频率从 33ms 降到帧更新周期(≥125ms)
        if dirty {
            self.present();
        }
    }

    /// L1(v5)：把一帧图像**变换后**写进合成缓冲 —— 等比缩放到 `CELL_H·scale` 高、水平居中、
    /// 底部对齐，再绕**底边中心** pivot 做旋转 / 非等比缩放。
    ///
    /// 采样路径 = **逆向映射**：目标像素 → 相对 pivot 的偏移 → `xf.inverse_offset`
    /// → 未变换框内坐标 → 源图双线性采样。逆向映射（而非正向撒点）从结构上消除旋转采样空洞；
    /// 又因为写入的是**最终合成缓冲** `buf`，命中判定（`is_transparent_at` 直接查 `buf`）
    /// 天然跟随绘制、不需要任何配套改造 —— 这一点与参考实现不同，订正见 `xform.rs` 头部。
    ///
    /// 布局：遍历范围取**变换后外接包围盒**（`DrawXform::bounds`，恒包含原框）；
    /// 基准 `y0` 预先扣掉 `sway_layout_margin`（按**最大**摇摆角算，不是当前角）——
    /// 于是摇摆全程底边基线恒定（不会「边摇边上下弹」），最低点也不越过 `WIN_H − 2`。
    ///
    /// 性能：全程就地写缓冲，**零分配、零新增 GDI 对象**（motion-plan §3.6 的硬约束）。
    /// 包围盒比原框大约 11%（±2° 摇摆的最坏情况），仍在 33ms 预算内。
    ///
    /// 2026-10-19：R20-c 首版为「预渲染椭圆环」加的 `blit_scaled`（显式目标尺寸双线性）
    /// 随重做一并退役 —— 轮廓柔光直接合成到 `buf`，不再有第二张图要贴。
    fn blit_center_bottom(
        &mut self,
        img: &Image,
        bob: f32,
        scale: f32,
        xf: &DrawXform,
        // P0-F2：水平镜像（EmoteKind::Turn 转身用）。落在**源采样坐标**上
        // （`fw - ux`）而不是 DrawXform 的负缩放——那要放宽 `XF_MIN_SCALE` 的安全夹取
        // （防逆变换除零的边界），为一个动作改它不划算。翻转不改包围盒（框还是那个框），
        // 命中判定查最终 buf，天然一致。
        flip: bool,
    ) -> (i32, i32, i32, i32) {
        // DPI(2026-10-05)：以下几何全部走**物理像素**口径（`pw`/`ph`/`dpr`），
        // 素材绘制高度 = `CELL_H × scale × dpr`。此前硬编码 `WIN_W`/`CELL_H`
        // ⇒ 200% 下素材只有窗口面积的 1/4（窗放大 2× 而素材没放大）。
        let (pw, ph) = self.win_size();
        let dpr = dpi_scale(self.dpi);
        let cell_h = (CELL_H as f32 * dpr).round() as i32;
        let h = (cell_h as f32 * scale) as i32;
        let w = (img.w as f32 / img.h as f32 * h as f32) as i32;
        if w <= 0 || h <= 0 {
            return (0, 0, 0, 0);
        }
        let src_w = img.w as i32;
        let src_h = img.h as i32;
        let (fw, fh) = (w as f32, h as f32);
        let (hw, hh) = (fw / 2.0, fh);
        // 未变换框左上角（窗口坐标）。底部留白 2px 之外再让出摇摆余量：旋转让底边两端
        // 一高一低，低的那一端会低于 pivot，不让位就会被窗口下沿切掉「脚尖」。
        let x0 = (pw as f32 - fw) / 2.0;
        let y0 = ph as f32 - fh - 2.0 * dpr - sway_layout_margin(fw) * dpr + bob;
        let pivot_x = x0 + hw;
        let pivot_y = y0 + hh;
        // 外接包围盒（相对未变换框左上角）→ 窗口坐标下的整数遍历区间
        let (bl, bt, br, bb) = xf.bounds(fw, fh);
        let ix0 = (x0 + bl).floor() as i32;
        let iy0 = (y0 + bt).floor() as i32;
        let ix1 = (x0 + br).ceil() as i32;
        let iy1 = (y0 + bb).ceil() as i32;
        for dy in iy0..=iy1 {
            if dy < 0 || dy >= ph {
                continue;
            }
            for dx in ix0..=ix1 {
                if dx < 0 || dx >= pw {
                    continue;
                }
                // 目标像素中心 → 相对 pivot 的偏移 → 逆变换 → 未变换框内坐标
                let (lx, ly) =
                    xf.inverse_offset(dx as f32 + 0.5 - pivot_x, dy as f32 + 0.5 - pivot_y);
                let ux = lx + hw;
                let uy = ly + hh;
                // 框外不采样：包围盒那四个空转角正是在这里被跳过
                if ux < 0.0 || uy < 0.0 || ux >= fw || uy >= fh {
                    continue;
                }
                // 源坐标中心对齐:(目标像素中心 → 源空间),避免偏一像素的非对称采样
                // sx = (x + 0.5) * src.w / w - 0.5（`ux` 已含 +0.5）；flip 时水平取镜像
                let sxf = (if flip { fw - ux } else { ux }) * (src_w as f32) / fw - 0.5;
                let syf = uy * (src_h as f32) / fh - 0.5;
                let sx0 = sxf.floor() as i32;
                let sy0 = syf.floor() as i32;
                let fx = (sxf - sx0 as f32).clamp(0.0, 1.0);
                let fy = (syf - sy0 as f32).clamp(0.0, 1.0);
                let sx1 = sx0 + 1;
                let sy1 = sy0 + 1;
                // 边界 clamp:边缘像素只取存在的邻居
                let cx0 = sx0.clamp(0, src_w - 1);
                let cy0 = sy0.clamp(0, src_h - 1);
                let cx1 = sx1.clamp(0, src_w - 1);
                let cy1 = sy1.clamp(0, src_h - 1);
                let p00 = img.bgra[(cy0 as usize) * img.w + (cx0 as usize)];
                let p10 = img.bgra[(cy0 as usize) * img.w + (cx1 as usize)];
                let p01 = img.bgra[(cy1 as usize) * img.w + (cx0 as usize)];
                let p11 = img.bgra[(cy1 as usize) * img.w + (cx1 as usize)];
                // 预乘空间线性插值(预乘值直接插值,数学上等价于 over 合成)
                let ifx = 1.0 - fx;
                let ify = 1.0 - fy;
                let w00 = ifx * ify;
                let w10 = fx * ify;
                let w01 = ifx * fy;
                let w11 = fx * fy;
                // 通道独立插值
                let blend = |shift: u32| -> u32 {
                    let v = (((p00 >> shift) & 0xFF) as f32 * w00
                        + ((p10 >> shift) & 0xFF) as f32 * w10
                        + ((p01 >> shift) & 0xFF) as f32 * w01
                        + ((p11 >> shift) & 0xFF) as f32 * w11) as u32;
                    v.min(255)
                };
                let a = blend(24);
                if a == 0 {
                    continue;
                }
                let r = blend(16);
                let g = blend(8);
                let b = blend(0);
                let dst = &mut self.buf[(dy * pw + dx) as usize];
                let da = (*dst >> 24) & 0xFF;
                let inv = 255 - a;
                let rr = ((r + (((*dst >> 16) & 0xFF) * inv / 255)) as u32).min(255);
                let gg = ((g + (((*dst >> 8) & 0xFF) * inv / 255)) as u32).min(255);
                let bb = ((b + ((*dst & 0xFF) * inv / 255)) as u32).min(255);
                let oa = (a + da * inv / 255).min(255);
                *dst = (oa << 24) | (rr << 16) | (gg << 8) | bb;
            }
        }
        // R20-c：回报本帧画出的**未变换角色框**（窗口局部物理像素）——背景 halo 的
        // 定位（贴在框外）与桌面采样带（框两侧）都用它。调用方存入 `last_char_box`。
        (x0 as i32, y0 as i32, w, h)
    }

    /// 叠加一张预渲染帧，按当前 DPI 放大（100% 时即 1:1 直贴）。
    ///
    /// DPI(2026-10-05)：原实现是「无缩放直贴」，而窗口已按 DPI 放大 ⇒ 气泡/审批框
    /// 在 200% 下只有应有尺寸的一半（与素材未放大的老症状同源，只是范围小得多）。
    /// 放大用**双线性采样**而非整数倍最近邻：非整数缩放档（125% / 150% / 175%）下
    /// 最近邻会让圆角与 1px 描边出现不均匀的宽窄（气泡是圆角+描边的连续色调，
    /// 抖动比轻微模糊更难看）。
    ///
    /// 采样与 `blit_center_bottom` 同构（目标像素中心 → 源坐标 → 通道独立插值），
    /// 差别只在于**不做逆变换**（此处不涉及旋转/形变）。
    fn blit_img(&mut self, img: &Image, x0: i32, y0: i32) {
        let (pw, ph) = self.win_size();
        let dpr = dpi_scale(self.dpi);
        let (sw, sh) = (img.w as i32, img.h as i32);
        let dw = (sw as f32 * dpr).round().max(1.0) as i32;
        let dh = (sh as f32 * dpr).round().max(1.0) as i32;
        if dw == sw && dh == sh {
            // 100%：保留原直贴快路径（零插值开销，33ms 节拍的热路径）
            for y in 0..sh {
                for x in 0..sw {
                    let px = img.bgra[(y as usize) * img.w + x as usize];
                    let a = (px >> 24) & 0xFF;
                    if a == 0 {
                        continue;
                    }
                    let dx = x0 + x;
                    let dy = y0 + y;
                    if dx < 0 || dy < 0 || dx >= pw || dy >= ph {
                        continue;
                    }
                    let dst = &mut self.buf[(dy * pw + dx) as usize];
                    let da = (*dst >> 24) & 0xFF;
                    let inv = 255 - a;
                    let r = (((px >> 16) & 0xFF) + (((*dst >> 16) & 0xFF) * inv / 255)) & 0xFF;
                    let g = (((px >> 8) & 0xFF) + (((*dst >> 8) & 0xFF) * inv / 255)) & 0xFF;
                    let b = ((px & 0xFF) + ((*dst & 0xFF) * inv / 255)) & 0xFF;
                    let oa = (a + da * inv / 255) & 0xFF;
                    *dst = (oa << 24) | (r << 16) | (g << 8) | b;
                }
            }
            return;
        }
        for dy in 0..dh {
            let wy = y0 + dy;
            if wy < 0 || wy >= ph {
                continue;
            }
            // 源坐标中心对齐（同 blit_center_bottom 的注释：避免偏一像素的非对称采样）
            let syf = (dy as f32 + 0.5) * (sh as f32) / (dh as f32) - 0.5;
            let sy0 = syf.floor() as i32;
            let fy = (syf - sy0 as f32).clamp(0.0, 1.0);
            let cy0 = sy0.clamp(0, sh - 1) as usize;
            let cy1 = (sy0 + 1).clamp(0, sh - 1) as usize;
            let ify = 1.0 - fy;
            for dx in 0..dw {
                let wx = x0 + dx;
                if wx < 0 || wx >= pw {
                    continue;
                }
                let sxf = (dx as f32 + 0.5) * (sw as f32) / (dw as f32) - 0.5;
                let sx0 = sxf.floor() as i32;
                let fx = (sxf - sx0 as f32).clamp(0.0, 1.0);
                let cx0 = sx0.clamp(0, sw - 1) as usize;
                let cx1 = (sx0 + 1).clamp(0, sw - 1) as usize;
                let p00 = img.bgra[cy0 * img.w + cx0];
                let p10 = img.bgra[cy0 * img.w + cx1];
                let p01 = img.bgra[cy1 * img.w + cx0];
                let p11 = img.bgra[cy1 * img.w + cx1];
                let w00 = (1.0 - fx) * ify;
                let w10 = fx * ify;
                let w01 = (1.0 - fx) * fy;
                let w11 = fx * fy;
                let blend = |shift: u32| -> u32 {
                    let v = ((((p00 >> shift) & 0xFF) as f32) * w00
                        + (((p10 >> shift) & 0xFF) as f32) * w10
                        + (((p01 >> shift) & 0xFF) as f32) * w01
                        + (((p11 >> shift) & 0xFF) as f32) * w11)
                        as u32;
                    v.min(255)
                };
                let a = blend(24);
                if a == 0 {
                    continue;
                }
                let dst = &mut self.buf[(wy * pw + wx) as usize];
                let da = (*dst >> 24) & 0xFF;
                let inv = 255 - a;
                let r = (blend(16) + (((*dst >> 16) & 0xFF) as u32 * inv / 255)).min(255);
                let g = (blend(8) + (((*dst >> 8) & 0xFF) as u32 * inv / 255)).min(255);
                let b = (blend(0) + ((*dst & 0xFF) as u32 * inv / 255)).min(255);
                let oa = (a + da * inv / 255).min(255);
                *dst = (oa << 24) | (r << 16) | (g << 8) | b;
            }
        }
    }

    /// 绘制预渲染气泡帧(帧序 = quote 池序;不再调用任何 GDI 字体 API)。
    fn blit_bubble(&mut self, idx: usize) {
        let frame = self.frames.bubbles.get(idx).cloned();
        if let Some(img) = frame {
            // DPI(2026-10-05)：气泡位置贴着「角色区上沿」——该沿随窗口放大而移动，
            // 故布局量（宽、高、留白）全部按 dpr 换算，不能用基准常量。
            let (pw, ph) = self.win_size();
            // 帧气泡矩形位于帧内 (15,4),blit 后与旧像素布局一致:文本中心 = 原 (54,73)
            let bw = scaled_px(BUBBLE_W, self.dpi);
            let x0 = (pw - bw) / 2;
            let y0 = ph - scaled_px(CELL_H as i32, self.dpi) - scaled_px(56, self.dpi)
                - scaled_px(4, self.dpi);
            self.blit_img(&img, x0, y0);
        }
    }

    /* ---------------- P1-b / P2-b：表情反应（符号标记 + whale 表情帧） ---------------- */

    /// 播一个表情反应。**两条渲染路径，按主题与素材自动选**（P2-b）：
    /// ① **whale 且有对应表情帧** ⇒ 播 `ex*` 图集行（整身瞬时帧，AI 生成 +
    ///    差异合成的「角色真容」）——走 `Action::Ambient` 槽（继承到期即清与
    ///    六态压制），时长 `MARK_MS`；
    /// ② 其余（kurumi/inverse，或 Zzz 这种没生成的表情）⇒ 播 P1 的几何符号标记。
    ///
    /// **同源刷新**：再触发同一种 = 续播（重置计时，不重来）；不同种 = 替换。
    /// 调用方全是事件点（Stroke/Bite/Done/告警/审批/睡眠），不进 33ms 主路径。
    ///
    /// 表情帧槽位与姿态槽是**同一个**（单动作槽互斥）——调用顺序上反应在姿态之后
    /// （见 `petting_and_bite_tick`），whale 的表情因此覆盖 Nod/Shiver 姿态；
    /// 其余主题的姿态（Nod/Shiver）与符号标记并存（符号本来就不占槽）。
    fn show_mark(&mut self, kind: Mark, now: std::time::Instant) {
        if let Some(row) = expression_row_for(kind) {
            // 表情帧是 whale 资产：**当前模式必须是 whale 才行**——
            // frames 是全量加载的（三主题都在内存），不判模式会让 kurumi/inverse
            // 也播鲸鱼的表情帧（串味）。
            let mode = self.shared.lock().map(|s| s.mode.clone()).unwrap_or_default();
            let has_row = mode == "whale"
                && self.frames.whale_rows.get(row).map(|l| !l.is_empty()).unwrap_or(false);
            if has_row {
                self.action = Some(ActionSlot {
                    action: Action::Ambient { row: row.to_string() },
                    started: now,
                    duration: std::time::Duration::from_millis(MARK_MS),
                });
                self.frame_idx = 0;
                self.last_tick = now - std::time::Duration::from_secs(10);
                // 表情帧与符号二选一——播了表情就把符号收掉（避免「脸上有表情，
                // 头顶还飘同情绪符号」的重复表达）
                self.mark = None;
                return;
            }
        }
        let refresh = self.mark.as_ref().map(|m| m.kind == kind).unwrap_or(false);
        if !refresh {
            self.mark = Some(MarkPlay::new(kind, now, MARK_MS));
        } else {
            // 续播只续命不重播——同一种符号反复弹射读作「抽搐」
            if let Some(m) = self.mark.as_mut() {
                m.started = now;
            }
        }
    }

    /// 把当前标记画进合成缓冲（角色与气泡之后调用 ⇒ 符号在气泡之上、角色头顶上方）。
    ///
    /// 定位复用 `last_char_box`（R20-c halo 引入的本帧角色框）——不新算几何；
    /// 盒 = 角色宽中心 ×（框顶 − `MARK_LIFT_PX`）。**只有有标记的帧**才做逐点判定
    /// （约 34² 里形状内的少量像素），静止期零开销；隐藏/全屏隐藏期不画。
    fn blit_mark(&mut self, now: std::time::Instant) {
        if !self.shown || self.fs_hidden {
            return;
        }
        let Some(play) = self.mark.as_ref() else { return };
        if play.expired(now) {
            return; // 清字段由 compose 的到期检查做（这里只负责不画）
        }
        let (bx, by, bw, _bh) = self.last_char_box;
        if bw <= 0 {
            return; // 冷启第一帧前没有角色框——不猜位置
        }
        let (pw, ph) = self.win_size();
        let box_px = scaled_px(MARK_BOX_PX, self.dpi);
        let (scale, bob, alpha) = mark_frame(play.progress(now));
        let size = (box_px as f32 * scale).round() as i32;
        if size <= 0 || alpha <= 0.0 {
            return;
        }
        // 盒中心：角色宽中心；盒顶：框顶 − 升空 − 浮动（bob 向下为正）
        let cx = bx + bw / 2;
        let top = by - scaled_px(MARK_LIFT_PX, self.dpi) + bob.round() as i32;
        let x0 = cx - size / 2;
        let (cr, cg, cb) = mark_color(play.kind);
        let a_full = (alpha * 255.0).round().clamp(0.0, 255.0) as u32;
        let inv_size = 2.0 / size as f32; // 像素 → 局部坐标 [-1,1]²
        for dy in 0..size {
            let wy = top + dy;
            if wy < 0 || wy >= ph {
                continue;
            }
            let ly = (dy as f32 + 0.5) * inv_size - 1.0;
            for dx in 0..size {
                let wx = x0 + dx;
                if wx < 0 || wx >= pw {
                    continue;
                }
                let lx = (dx as f32 + 0.5) * inv_size - 1.0;
                if !mark_shape(play.kind, lx, ly) {
                    continue;
                }
                let dst = &mut self.buf[(wy * pw + wx) as usize];
                let da = (*dst >> 24) & 0xFF;
                let inv = 255 - a_full;
                // 2026-10-18 审查修正：buf 是**预乘**缓冲（`load_png` 预乘 + ULW
                // AC_SRC_ALPHA），源色必须先乘 alpha 再 over。直接加未预乘的 `cr`
                // 会让淡入/淡出期的 RGB 远大于 alpha（视觉上标记「瞬间全彩出现、
                // 瞬间消失」，与 `mark_frame` 的 alpha 演出设计不符）。
                let sr = (cr as u32 * a_full + 127) / 255;
                let sg = (cg as u32 * a_full + 127) / 255;
                let sb = (cb as u32 * a_full + 127) / 255;
                let r = (sr + (((*dst >> 16) & 0xFF) * inv / 255)).min(255);
                let g = (sg + (((*dst >> 8) & 0xFF) * inv / 255)).min(255);
                let b = (sb + ((*dst & 0xFF) * inv / 255)).min(255);
                let oa = (a_full + da * inv / 255).min(255);
                *dst = (oa << 24) | (r << 16) | (g << 8) | b;
            }
        }
    }

    /// R2(2026-09-16):窗口局部坐标处是否「透明」（= 可让鼠标穿透到下层窗口）。
    /// 直接查当前合成缓冲 `buf`——它已是「立绘 + 气泡」逐像素 over 之后的**最终结果**，
    /// 因此不必像参考实现那样为每种元素单独维护 mask（`pet/window.py:_sync_mask`）：
    /// 阈值 `CLICK_THROUGH_ALPHA` 之下的像素视为透明。
    ///
    /// L1(2026-09-28) 复核：**旋转/形变不需要本函数做任何配套改造**。变换在
    /// `blit_center_bottom` 写入 `buf` 时就已完成，这里查到的就是变换后的轮廓 ——
    /// 「看得见的必可点、看不见的必穿透」由「查最终缓冲」这一条架构决定自动成立。
    /// （`pet-v5-motion-plan.md` §3.3 曾把「命中必须与绘制同批改造」列为 L1 硬约束，
    ///  那是参考实现的前提：它为每元素单独维护 mask，旋转后 mask 与画面脱钩。我方无此问题。）
    /// P1-b：标记同样写进 `buf` ⇒ 光标压在标记上算命中角色（与气泡同口径，
    /// 不单独设命中层——§3.3.1 架构红利的延续）。
    fn is_transparent_at(&self, x: i32, y: i32) -> bool {
        // 2026-09-29：用户选「总是可点」⇒ **恒不穿透**，整个窗口矩形都接住鼠标。
        // 放在越界判断**之前**是刻意的：这是**策略**层（要不要参与命中），不是几何层
        // （这点是不是图像）。判据只有一处，主窗与悬浮球共用本函数 ⇒ 两处行为天然一致。
        if self.through_disabled() {
            return false;
        }
        // R16（2026-10-12）：判定外面再套一层「抓取热区」膨胀（`model::grab_hit`）。
        // 原口径是逐像素 alpha，而桌宠立绘只占窗口中间一条 —— 实机扫描 whale 主题
        // 可点区仅约 110×180 / 窗口 286×390（≈18%），抓着轮廓边上一按就穿透到桌面，
        // 用户报「拖不动」。膨胀半径按 DPI 换算（与 `buf` 同一物理像素口径）。
        // **越界与膨胀的边界语义**：窗口外的点恒穿透（`grab_hit` 里先做越界判断）
        // ⇒ 不会因为容差而吃掉窗口外的点击。
        let (pw, ph) = self.win_size();
        let pad = scaled_px(CLICK_GRAB_PAD_PX, self.dpi);
        !grab_hit(&self.buf, pw, ph, x, y, pad, CLICK_THROUGH_ALPHA)
    }

    /// P0-F1（2026-10-18 审查修正）：互动判据的**几何命中**——光标是否压在角色像素上。
    ///
    /// **不能复用 `is_transparent_at`**：它在最前面按「总是可点」设置（`through_disabled`）
    /// 早退返回「不透明」。那是**穿透策略**（要不要把点击交给下层），不是几何事实。
    /// 摸头判定若走它，该设置档下任何屏幕坐标都会被算成「命中角色」⇒ `petting_tick`
    /// 的 `on_hit` 恒真 ⇒ 桌宠每 400ms 自己摸自己（点头 + pat 音 + 心情 +10，`pet.log`
    /// 每 0.4s 一行），60s 内 5 下即咬手并把窗口瞬移到光标跟随 1.2s。
    ///
    /// 判据与 R2 的几何部分同源（`grab_hit`：窗口越界恒假 + 抓取热区膨胀），
    /// 但**刻意不看策略层**。源码契约 `petting_uses_geometric_hit_only` 钉死这一点。
    fn is_on_character(&self, x: i32, y: i32) -> bool {
        let (pw, ph) = self.win_size();
        let pad = scaled_px(CLICK_GRAB_PAD_PX, self.dpi);
        grab_hit(&self.buf, pw, ph, x, y, pad, CLICK_THROUGH_ALPHA)
    }

    /// 「总是可点」设置。每 10ms 的命中轮询会读它，故**只取一个 bool、临界区极短**；
    /// 取不到锁按 `false`（= 保持 R2 的自动穿透）——读不到设置不该让桌宠突然挡住整屏点击。
    fn through_disabled(&self) -> bool {
        self.shared
            .lock()
            .map(|s| s.settings.through == super::settings::THROUGH_ALWAYS)
            .unwrap_or(false)
    }

    /// 隐藏后是否显示悬浮球。`tray=dot|both` → 显示；`tray=tray` → 只留托盘。
    /// 取不到锁按 `true`（保持既有行为）——读不到设置不该让用户**失去找回桌宠的入口**。
    fn dot_enabled(&self) -> bool {
        self.shared
            .lock()
            .map(|s| s.settings.tray != super::settings::TRAY_TRAY)
            .unwrap_or(true)
    }

    /// R20-b（2026-10-17）：音效播放的**设置门** + 一行式调用。
    ///
    /// 门读 `settings.sound`（默认 true）；取不到锁按 `true` —— 与 `dot_enabled()`
    /// 的失败方向一致（读不到设置不该让桌宠突然变哑，除非用户明确关过）。
    /// 播放本体在 `sfx::play`（未知名/缺素材静默 + 首缺留痕）。
    fn sfx(&self, name: &str) {
        let on = self
            .shared
            .lock()
            .map(|s| s.settings.sound)
            .unwrap_or(true);
        if on {
            super::sfx::play(name);
        }
    }

    /// R20-a（2026-10-17，design/2026-10-17-pet-fullscreen-sfx-sprint.md §2.2）：
    /// 全屏覆盖轮询（`IDT_FULLSCREEN` 250ms）。
    ///
    /// 状态机（`fs_hidden` = 「规则当前持有隐藏」）：
    /// - 覆盖中且规则未隐藏且用户要显示 ⇒ 隐藏 + 置位 + 日志；
    /// - 规则已隐藏：覆盖解除或用户已手动隐藏 ⇒ 解除规则态（仅当 `shown` 才 show 回来）；
    /// - 用户在全屏期间**手动显示** ⇒ 由 compose 显隐分支清规则态（见其处注释），
    ///   下一拍规则重新生效（**参考实现同口径**：设置是常驻命令，规则所有权；
    ///   要桌宠在全屏应用上常驻，请关「全屏时隐藏」设置）。
    ///
    /// **不落盘、不碰 `shared.hide`**：这是瞬态规则，退出全屏即还原；
    /// 写进 `hide` 会让桌宠停在用户没要过的隐藏态（悬浮球常驻）。
    fn fs_poll(&mut self) {
        let fs_hide = self
            .shared
            .lock()
            .map(|s| s.settings.fs_hide)
            .unwrap_or(true);
        // 设置关闭时规则不参与；已隐藏的残留直接解除（用户可能在全屏中关设置）
        if !fs_hide {
            if self.fs_hidden {
                self.fs_hidden = false;
                if self.shown {
                    unsafe { ShowWindow(self.hwnd, SW_SHOW) };
                    pet_log_line("[native-pet] fullscreen: restored (setting off)\n");
                }
            }
            return;
        }
        let cover = self.fullscreen_covers();
        if !self.fs_hidden {
            if cover && self.shown {
                unsafe { ShowWindow(self.hwnd, SW_HIDE) };
                self.fs_hidden = true;
                pet_log_line("[native-pet] fullscreen: auto-hidden (foreground covers pet monitor)\n");
            }
            return;
        }
        // 已被规则隐藏
        if !cover || !self.shown {
            self.fs_hidden = false;
            if self.shown {
                unsafe { ShowWindow(self.hwnd, SW_SHOW) };
                pet_log_line("[native-pet] fullscreen: restored\n");
            }
            // !shown：用户手动隐藏了 —— 只清规则态，不 show（用户所有权优先）
        }
    }

    /// R20-a：取 Win32 事实（前台/样式/类名/矩形/显示器）喂给纯函数
    /// `model::foreground_is_fullscreen_cover`（判据本身在那里单测）。
    ///
    /// 覆盖判据用显示器的 **rcMonitor**（不是工作区）：全屏游戏确实盖住任务栏那条，
    /// 而按工作区判会漏掉「任务栏边上还差几像素」的真全屏窗口。
    fn fullscreen_covers(&self) -> bool {
        unsafe {
            let fg = GetForegroundWindow();
            if fg == 0 || fg == self.hwnd {
                return false;
            }
            let own_mon = MonitorFromWindow(self.hwnd, MONITOR_DEFAULTTONEAREST);
            let fg_mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
            let same = own_mon != 0 && own_mon == fg_mon;
            let style = GetWindowLongPtrW(fg, GWL_STYLE) as u32;
            let mut cls = [0u16; 64];
            let n = GetClassNameW(fg, cls.as_mut_ptr(), cls.len() as i32);
            let class = if n > 0 {
                String::from_utf16_lossy(&cls[..n as usize])
            } else {
                String::new()
            };
            let mut fr = Rect { left: 0, top: 0, right: 0, bottom: 0 };
            GetWindowRect(fg, &mut fr);
            let mut info = MonitorInfo {
                cb_size: std::mem::size_of::<MonitorInfo>() as u32,
                rc_monitor: Rect { left: 0, top: 0, right: 0, bottom: 0 },
                rc_work: Rect { left: 0, top: 0, right: 0, bottom: 0 },
                dw_flags: 0,
            };
            if own_mon == 0 || GetMonitorInfoW(own_mon, &mut info) == 0 {
                return false; // 取不到显示器几何 ⇒ 不猜（宁可不隐藏）
            }
            foreground_is_fullscreen_cover(
                fg,
                self.hwnd,
                same,
                style,
                &class,
                fr,
                info.rc_monitor,
            )
        }
    }

    /* ---------------- R20-c · 背景对比 halo ---------------- */

    /// R20-c：一拍「采样桌面 → 与身体比 → 更新环状态」（2s 节拍，compose 清 buf 前调）。
    ///
    /// 身体色 = **上一帧** buf 的角色带实心像素平均（此刻 buf 还是上一帧）；
    /// 桌面色 = 上一帧角色框**左右各一条**采样带的平均（框外 ⇒ 采到的是桌面/
    /// 窗内透明留白，不是桌宠自己——参考实现靠 skip 区域绕开自己，我方靠
    /// 「采样带在框外」这一条几何事实，更简单也更难错）。
    /// 任一侧失败/出屏 ⇒ 本拍不更新（保持原状，不猜）。
    fn backdrop_tick(&mut self) {
        let Some(body) = self.body_avg_from_buf() else { return };
        let (bx, by, bw, bh) = self.last_char_box;
        if bw <= 0 || bh <= 0 {
            return; // 还没有有效帧（冷启第一拍）
        }
        let dpr = dpi_scale(self.dpi);
        let sh = scaled_px(BACKDROP_STRIP_H, self.dpi);
        // 采样带不超过框宽的 1/3：窄角色（inverse ≈150px）时采样带随之收窄，
        // 宽角色（whale ≈249px）时也不越过 BACKDROP_STRIP_W 的上限。
        let strip_w = scaled_px(BACKDROP_STRIP_W, self.dpi).min((bw / 3).max(4));
        let gap = (4.0 * dpr).round() as i32;
        let (px, py) = self.pos;
        let top = py + by + bh / 2 - sh / 2;
        let left = Rect {
            left: px + bx - gap - strip_w,
            top,
            right: px + bx - gap,
            bottom: top + sh,
        };
        let right = Rect {
            left: px + bx + bw + gap,
            top,
            right: px + bx + bw + gap + strip_w,
            bottom: top + sh,
        };
        // 出屏闸门（纯函数 `backdrop::strips_inside`）：采到黑屏会把判据拉失真
        // （深身 vs 黑 = 永不翻动、浅身 vs 黑 = 常亮），贴边/peek 时就该跳过。
        let work = monitor_workspaces()
            .into_iter()
            .find(|r| {
                let cx = (left.left + right.right) / 2;
                let cy = top + sh / 2;
                cx >= r.left && cx < r.right && cy >= r.top && cy < r.bottom
            })
            .unwrap_or(Rect { left: 0, top: 0, right: 1, bottom: 1 });
        if !backdrop::strips_inside((left, right), work) {
            return;
        }
        let (Some(a), Some(b)) = (backdrop::sample_avg(left), backdrop::sample_avg(right)) else {
            return;
        };
        let backdrop = [
            ((a[0] as u16 + b[0] as u16) / 2) as u8,
            ((a[1] as u16 + b[1] as u16) / 2) as u8,
            ((a[2] as u16 + b[2] as u16) / 2) as u8,
        ];
        self.halo.update(body, backdrop);
    }

    /// R20-c：从合成缓冲算**身体平均色**——角色带（物理口径）内 alpha ≥ 200 的像素平均。
    ///
    /// 阈值 200 而不是 16：边缘抗锯齿像素是「身体 + 桌面」的混合色，算进去会把
    /// 身体色拉向桌面色、距离判据被系统性压低（ halo 该亮时不亮）。
    /// buf 是预乘的——alpha=255 处预乘值即原色；≥200 处的反预乘误差 ≤1 级，
    /// 对距离判据无感，不值得为此加一趟反预乘。
    fn body_avg_from_buf(&self) -> Option<[u8; 3]> {
        let (pw, _ph) = self.win_size();
        let band = self.role_local_phys();
        let (mut sr, mut sg, mut sb, mut n) = (0u64, 0u64, 0u64, 0u64);
        for y in band.top.max(0)..band.bottom.min(self.buf.len() as i32 / pw.max(1)) {
            for x in band.left.max(0)..band.right.min(pw) {
                let px = self.buf[(y * pw + x) as usize];
                if (px >> 24) & 0xFF >= 200 {
                    sr += ((px >> 16) & 0xFF) as u64;
                    sg += ((px >> 8) & 0xFF) as u64;
                    sb += (px & 0xFF) as u64;
                    n += 1;
                }
            }
        }
        if n < 256 {
            return None; // 几乎没有实心像素（空帧/角色还没画）⇒ 不猜
        }
        Some([(sr / n) as u8, (sg / n) as u8, (sb / n) as u8])
    }

    /// R20-c（2026-10-19 重做）：把本帧角色的轮廓糊开、合成成角色**下面**的柔光。
    ///
    /// 调用时机：两个角色绘制分支都已把角色写进 `buf` 之后、气泡/标记之前——
    /// 顺序是硬契约：光晕的**形状来源就是 `buf` 里角色的 alpha**（轮廓），
    /// 而气泡/标记不该参与光晕（它们不是角色身体）。
    ///
    /// 为什么不是首版那种「预渲染环 PNG + blit」：环与角色轮廓没有几何关系，
    /// 实机上就是一个套在鲸鱼娘外面的椭圆白圈（用户 2026-10-19 报障）。
    /// 现在光晕由 alpha 轮廓生成 ⇒ 贴合裙摆/呆毛/双马尾任何形状。
    ///
    /// 三个缓冲字段复用：每帧新分配 3×111KB 在 30fps 下是 ~10MB/s 的垃圾，
    /// 与本文件「静止期零分配」的既有口径相悖。
    fn apply_halo(&mut self) {
        let (pw, ph) = self.win_size();
        let (pw_us, ph_us) = (pw as usize, ph as usize);
        let n = pw_us * ph_us;
        if pw_us == 0 || ph_us == 0 || self.buf.len() < n {
            return;
        }
        if self.halo_mask.len() < n {
            self.halo_mask.resize(n, 0);
            self.halo_tmp.resize(n, 0);
            self.halo_blur.resize(n, 0);
        }
        for i in 0..n {
            self.halo_mask[i] = ((self.buf[i] >> 24) & 0xFF) as u8;
        }
        let dpr = dpi_scale(self.dpi);
        let radius = (HALO_BLUR_PX * dpr).round().max(1.0) as usize;
        backdrop::blur_alpha_box(
            &self.halo_mask[..n],
            &mut self.halo_tmp[..n],
            &mut self.halo_blur[..n],
            pw_us,
            ph_us,
            radius,
        );
        let color = self.halo.color;
        backdrop::composite_glow(
            &mut self.buf[..n],
            &self.halo_blur[..n],
            n,
            color,
            HALO_STRENGTH,
            HALO_GAMMA,
        );
    }

    /* ---------------- P0-F1（2026-10-18）：摸头与咬手 ---------------- */

    /// 每个 `IDT_HIT` 拍（10ms）调：摸头判定 + 咬合跟随 + 咬合到期。
    ///
    /// **为什么搭 IDT_HIT 不新开定时器**：该轮询本就每 10ms 跑（R2 穿透判定），
    /// 光标位置与 on_hit 都是现成事实；新增定时器要新的 id 与挂表/销毁路径，纯负担。
    /// 与 `update_click_through` 的分工：那个管穿透样式，这个管互动语义——两者都读
    /// 光标，但关注点不同（穿透问「该不该把点击交给下层」，抚摸问「摸多久了」）。
    fn petting_and_bite_tick(&mut self) {
        let now = std::time::Instant::now();
        let mut p = Point { x: 0, y: 0 };
        unsafe {
            GetCursorPos(&mut p);
        }
        // ① 咬着光标：窗口跟着光标走（「咬住你的手」），到期或被按下即松口。
        //    咬着的时候不做抚摸判定——它正忙着咬。
        if let Some(off) = self.bite_follow {
            let target = (p.x - off.0, p.y - off.1);
            if target != self.pos {
                let (ww, wh) = self.win_size();
                unsafe { MoveWindow(self.hwnd, target.0, target.1, ww, wh, 1) };
                self.pos = target;
            }
            if self.bite_until.map(|t| now >= t).unwrap_or(false) {
                self.finish_bite();
            }
            return;
        }
        // ② 以下情形不判定抚摸：隐藏 / 拖拽中 / 滑停中 / 飞行中 / 全屏规则隐藏期。
        //    （飞行与滑停期窗口在动，「摸」的判据是光标与角色的接触连续性，
        //     窗口自己在动会让判据失去意义；拖动中更不必说。）
        //    2026-10-18 审查修正：早退必须**打断抚摸段**——否则 `hold_since` 冻结在早退前
        //    的时刻，恢复第一拍立刻补出一个 Stroke（拖完松手「吱」一声、隐藏再显示也触发）。
        if !self.shown || self.dragged || self.drag_settling || self.flying.is_some() || self.fs_hidden {
            petting_tick(&mut self.petting, false, now, PET_HOLD_MS);
            return;
        }
        // 2026-10-18 审查修正：命中判据锁定**几何层**（`is_on_character`），不得复用
        // `is_transparent_at` —— 后者最前面按「总是可点」设置早退返回「不透明」，
        // 那是穿透策略；组合起来会让该档下任何屏幕坐标都算摸头（每 400ms 自摸 + 咬手）。
        let on_hit = self.is_on_character(p.x - self.pos.0, p.y - self.pos.1);
        let ev = petting_tick(&mut self.petting, on_hit, now, PET_HOLD_MS);
        match ev {
            PetEvent::Stroke => {
                // 摸一下：点头 + 吱一声 + 心情 +。表情槽会被六态压住（审批/告警优先），
                // 与 jump/wave 同命运——反馈照给，姿态让位。
                // 2026-10-18 审查修正：互动也是「叫醒」——不吃免睡冷却会下一拍回睡姿。
                self.wake_from_sleep(now);
                self.action = Some(ActionSlot {
                    action: Action::Emote { kind: EmoteKind::Nod },
                    started: now,
                    duration: std::time::Duration::from_millis(NOD_MS),
                });
                self.frame_idx = 0;
                self.last_tick = now - std::time::Duration::from_secs(10);
                self.mood = mood_apply(self.mood, MoodEvent::Stroke);
                self.sfx("pat");
                pet_log_line(&format!("[native-pet] stroke mood={}\n", self.mood));
            }
            PetEvent::Bite => {
                // 咬手：脱离停靠/peek（同拖动起手口径——窗口要跟着光标跑，
                // 停靠/探头假设窗口不动，R14 教训②：位移来源必须让位），
                // 记咬合偏移，挂全程颤抖，心情 -，进冷却。
                self.wake_from_sleep(now);
                peek_reset(&mut self.peek);
                self.docked_edge = None;
                self.bite_follow = Some((p.x - self.pos.0, p.y - self.pos.1));
                self.bite_until = Some(now + std::time::Duration::from_millis(BITE_CLING_MS));
                self.action = Some(ActionSlot {
                    action: Action::Emote { kind: EmoteKind::Shiver },
                    started: now,
                    duration: std::time::Duration::from_millis(BITE_CLING_MS),
                });
                self.frame_idx = 0;
                self.last_tick = now - std::time::Duration::from_secs(10);
                self.mood = mood_apply(self.mood, MoodEvent::Bite);
                self.sfx("chomp");
                // P1-b：怒纹在 match 前经 `mark_for_pet_event` 统一挂（见上）
                pet_log_line(&format!(
                    "[native-pet] bite cling={}ms mood={}\n",
                    BITE_CLING_MS, self.mood
                ));
            }
            PetEvent::None => {}
        }
        // P1-b/P2-b：表情反应在**姿态之后**决定——事件 → 情绪是纯函数映射
        // （`mark_for_pet_event`，单测钉死「谁配谁」；契约查不到「调用被注掉」，
        // 映射查得到——P0 `throw_triggered` 同款纪律）；`show_mark` 内部按主题
        // 选渲染路径：whale 演表情帧（覆盖上面的姿态槽），其余主题落符号标记
        // （与姿态并存——符号不占槽）。
        if let Some(kind) = mark_for_pet_event(ev) {
            self.show_mark(kind, now);
        }
    }

    /// P0-F2 审查修正（2026-10-18）：叫醒桌宠——清掉睡眠时段缓存并给一段
    /// **免睡冷却**。点击/抚摸/咬手都走这里（设计「点击/抚摸/咬手都能叫醒」）。
    ///
    /// 为什么必须有冷却：`sleep_night` 会被 30s 的夜间检查重新置 true，
    /// 而「瞌睡续觉」钩子每拍检查 `sleep_night && action.is_none()`——只清
    /// `sleep_night` 的话，下一拍检查就把它放回睡姿，用户看到的是「点一下闪一下」。
    /// 冷却期内两处挂睡眠槽的门都不放行（见 compose 的睡眠检查段/续觉段）。
    fn wake_from_sleep(&mut self, now: std::time::Instant) {
        self.sleep_night = false;
        self.wake_sleep_until = Some(now + std::time::Duration::from_millis(SLEEP_WAKE_MS));
    }

    /// P0-F2 审查修正：是否仍处于「刚被叫醒」的免睡冷却中。
    fn sleep_wake_blocked(&self, now: std::time::Instant) -> bool {
        self.wake_sleep_until.map(|t| now < t).unwrap_or(false)
    }

    /// 咬合结束（自然松口 / 被按下 / 窗口销毁路径）：一次「迷你拖动收尾」——
    /// 停靠判定 + 落盘 + 悬浮球同步。位置可能已被光标带出工作区，
    /// `apply_dock`/`save_pet_pos` 都吃钳制后的值（E30 的推出逻辑在这里同样成立）。
    fn finish_bite(&mut self) {
        self.bite_follow = None;
        self.bite_until = None;
        let docked = self.apply_dock();
        let hide = self.shared.lock().map(|s| s.hide).unwrap_or(false);
        save_pet_pos(self.pos, hide, docked);
        self.render_dot();
        pet_log_line(&format!(
            "[native-pet] bite end -> ({},{}) dock={:?}\n",
            self.pos.0, self.pos.1, docked
        ));
    }

    /* ---------------- P0-F3：抛掷飞行 ---------------- */

    /// 飞行一拍（`IDT_DRAG` 8ms 节拍）：推进物理 → 落窗 → 命中反馈 → 结束判定。
    /// dt 用 `last_drag_tick` 的真实经过时间（与弹簧同一口径：不写死 8ms）。
    fn fly_tick(&mut self) {
        let dt = self.last_drag_tick.elapsed().as_millis().min(DRAG_TICK_MAX_MS as u128) as u32;
        self.last_drag_tick = std::time::Instant::now();
        let bounds = self.fly_bounds();
        let mut st = match self.flying.take() {
            Some(s) => s,
            None => return,
        };
        let hit = fly_step(&mut st, dt, bounds);
        if hit != FlyHit::None {
            // 撞边：一次挤压脉冲（与跳跃落地共用同一通道）+ 嘭一声
            self.squash_start = Some(std::time::Instant::now());
            self.sfx("bounce");
            pet_log_line(&format!(
                "[native-pet] bounce {:?} at ({:.0},{:.0}) v=({:.0},{:.0})\n",
                hit, st.pos.0, st.pos.1, st.vel.0, st.vel.1
            ));
        }
        let (nx, ny) = (st.pos.0.round() as i32, st.pos.1.round() as i32);
        if (nx, ny) != self.pos {
            let (ww, wh) = self.win_size();
            unsafe { MoveWindow(self.hwnd, nx, ny, ww, wh, 1) };
            self.pos = (nx, ny);
        }
        // 飞行倾斜的输入 = 当前速度（与 R18 拖动倾斜同源）
        self.drag_vel = st.vel;
        let end = fly_should_end(&st);
        self.flying = Some(st);
        if end {
            self.finish_fly();
        }
    }

    /// 飞行收尾：停表、清状态、停靠判定 + 落盘 + 放下音。与 `finish_drag_settle`
    /// 同构（「落盘位置 = 用户看到的停止位置」）。
    fn finish_fly(&mut self) {
        self.flying = None;
        if self.dragging_timer_on {
            unsafe { KillTimer(self.hwnd, IDT_DRAG) };
            self.dragging_timer_on = false;
        }
        self.drag_vel = (0.0, 0.0);
        let docked = self.apply_dock();
        let hide = self.shared.lock().map(|s| s.hide).unwrap_or(false);
        save_pet_pos(self.pos, hide, docked);
        self.render_dot();
        self.sfx("drop");
        pet_log_line(&format!(
            "[native-pet] fly end -> ({},{}) dock={:?}\n",
            self.pos.0, self.pos.1, docked
        ));
    }

    /// 飞行的边界 = 桌宠所在显示器**工作区**收窄窗口物理尺寸（窗口左上角的允许范围）。
    /// 取不到所在工作区时回主屏（`screen_size`）——「不猜」只适用于判据，
    /// 边界必须有值，否则桌宠会飞进负数坐标。
    fn fly_bounds(&self) -> (i32, i32, i32, i32) {
        let (pw, ph) = self.win_size();
        let (sx, sy) = screen_size();
        let work = monitor_workspaces()
            .into_iter()
            .find(|r| {
                let cx = self.pos.0 + pw / 2;
                let cy = self.pos.1 + ph / 2;
                cx >= r.left && cx < r.right && cy >= r.top && cy < r.bottom
            })
            .unwrap_or(Rect { left: 0, top: 0, right: sx, bottom: sy });
        (
            work.left,
            work.top,
            (work.right - pw).max(work.left),
            (work.bottom - ph).max(work.top),
        )
    }
    /// R2:按光标位置切换 `WS_EX_TRANSPARENT`（由 10ms 轮询定时器驱动）。
    /// **必须轮询**：一旦置位穿透，本窗口收不到鼠标消息，「何时恢复可点击」无从由事件得知。
    /// 规则：隐藏 / 拖拽中恒不穿透（保证跟手与恢复入口可用），其余按命中结果切换。
    /// R18：滑停（松手后 ≤300ms 的自然滑行）也算「拖拽中」——那期间窗口还在动，
    /// 穿透态切换与移动叠在一起没有意义，且用户可能立刻再次按下。
    /// P0-F3：抛掷飞行同理——高速移动中切穿透会让「伸手接住它」变成抽奖。
    /// R20-a：全屏规则隐藏期同样早退——窗口都藏了，10ms 光标轮询是纯浪费。
    fn update_click_through(&mut self) {
        if !self.shown || self.dragged || self.drag_settling || self.flying.is_some() || self.fs_hidden {
            self.set_click_through(false);
            return;
        }
        let mut p = Point { x: 0, y: 0 };
        unsafe {
            GetCursorPos(&mut p);
        }
        let transparent = self.is_transparent_at(p.x - self.pos.0, p.y - self.pos.1);
        // M4.1：光标压在角色不透明像素上 = 用户交互 —— peek「静置 5s」的时钟源。
        // 「总是可点」档位下 is_transparent_at 恒 false ⇒ 整窗都算感应区（与该档位的
        // 「整个窗口矩形接住鼠标」语义一致）。
        if !transparent {
            self.last_interaction = std::time::Instant::now();
        }
        self.set_click_through(transparent);
    }

    /// R2:切换穿透样式位（只改扩展样式，**不重建原生窗口**——重建会造成可见的闪烁；
    /// 参考实现在此处踩过坑，见其 `pet/platform_win.py:79-114` 的注释）。
    fn set_click_through(&mut self, on: bool) {
        if self.click_through == on {
            return;
        }
        unsafe {
            let cur = GetWindowLongPtrW(self.hwnd, GWL_EXSTYLE) as u32;
            let next = if on { cur | WS_EX_TRANSPARENT } else { cur & !WS_EX_TRANSPARENT };
            if next != cur {
                SetWindowLongPtrW(self.hwnd, GWL_EXSTYLE, next as isize);
            }
        }
        self.click_through = on;
        self.ct_switches = self.ct_switches.wrapping_add(1);
        if self.ct_switches % CLICK_THROUGH_LOG_EVERY == 0 {
            pet_log_line(&format!(
                "[native-pet] click-through toggles={} (now={})\n",
                self.ct_switches, on
            ));
        }
    }

    /// M4.1：peek 边界检测（`IDT_PEEK` 250ms 轮询）。
    ///
    /// **只做相位迁移的边界判定，不做动画**（动画在 compose 节拍推进）：
    /// · `Off`：静置满 `PEEK_IDLE_MS` 且光标不在角色上、无气泡 → 进入缩边；
    /// · 探头侧（`Peeking/Entering/Returning`）：光标压上（感应区）→ 拉直；
    /// · `Straightened`：再次静置且光标离开 → 退回常驻档。
    ///
    /// 感应区口径与 R2 穿透判定同源（`is_transparent_at`）：光标压在角色不透明像素上。
    /// 探头态下窗口半在屏外，光标本就到不了屏外部分 ⇒ 屏外部分天然不参与感应。
    fn peek_poll(&mut self) {
        if !self.shown || self.docked_edge.is_none() {
            return;
        }
        let now = std::time::Instant::now();
        let idle =
            now.duration_since(self.last_interaction).as_millis() >= PEEK_IDLE_MS as u128;
        let mut p = Point { x: 0, y: 0 };
        unsafe {
            GetCursorPos(&mut p);
        }
        let on_pet = !self.is_transparent_at(p.x - self.pos.0, p.y - self.pos.1);
        if on_pet {
            self.last_interaction = now;
        }
        match self.peek.phase {
            PeekPhase::Off => {
                if idle && !on_pet && self.alert.is_none() {
                    peek_kick_idle(&mut self.peek);
                }
            }
            PeekPhase::Peeking | PeekPhase::Entering | PeekPhase::Returning => {
                if on_pet {
                    peek_kick_engage(&mut self.peek);
                }
            }
            PeekPhase::Straightened => {
                if idle && !on_pet {
                    peek_kick_return(&mut self.peek);
                }
            }
            PeekPhase::Straightening => {}
        }
    }

    /* ---------------- 2026-09-24:隐藏态「主题头像悬浮球」 ---------------- */

    /// 重绘悬浮球并推到 dot 分层窗口。
    ///
    /// `dot_buf` 既是画面也是命中共据（hover 与穿透都查它），故「渲染 + blit」必须成对：
    /// 任何改动球面外观的路径（主题切换 / 悬停 / 位置变化 / 显隐切换）都走这里，别单独 blit。
    fn render_dot(&mut self) {
        // frames 加载后不可变 → 裸指针解引用安全，且规避 `&mut self` 与 `&self.frames`
        // 的借用冲突（与 blit_approval 同一范式）。
        let avatar_ptr = self
            .frames
            .avatars
            .get(dot::avatar_key(&self.dot_theme))
            .map(|i| i as *const Image);
        let avatar = avatar_ptr.map(|p| unsafe { &*p });
        self.dot_buf = dot::render(&self.dot_theme, avatar, self.dot_hover);
        blit_dot(self.dot_hwnd, self.pos, &self.dot_buf);
    }

    /* ---------------- R18（2026-10-17）：悬浮球拖动 ---------------- */

    /// R18：球拖动合帧消费——把球（与隐藏中的主窗）移到最新目标。返回是否真的移动了。
    ///
    /// **球不叠弹簧**（与主窗 M4 的刻意分歧）：56px 功能入口要「指哪打哪」的精确放置，
    /// 弹簧滞后在小球上读作发飘；合帧只为省 `MoveWindow`（1000Hz 鼠标 = 每秒千次重定位）。
    /// 参考侧同口径：GarfieldZhung 主进程 16ms 光标轮询直设位置，无弹簧。
    ///
    /// **为什么主窗也要一起动**：显隐切换只 `ShowWindow` 不移动（`compose` 显隐分支）。
    /// 球拖到新点后若主窗停在旧位，单击恢复时桌宠会出现在旧位置——「球与桌宠脱节」。
    fn flush_dot_drag_target(&mut self) -> bool {
        let target = match self.dot_drag_target {
            Some(t) => t,
            None => return false,
        };
        if target == self.pos {
            return false;
        }
        let (ww, wh) = self.win_size();
        unsafe {
            MoveWindow(self.dot_hwnd, target.0, target.1, DOT_SIZE, DOT_SIZE, 0);
            MoveWindow(self.hwnd, target.0, target.1, ww, wh, 0);
        }
        self.pos = target;
        true
    }

    /// R18：球松手收尾——停表 + 出屏兜底 + 落盘。
    ///
    /// `dock = None`：球**不停靠**（停靠/peek 是桌宠的空间语义；且 `save_pet_pos`
    /// 在 `hide = true` 时按**球心**存比例，见 persist.rs R18 段）。
    /// 出屏兜底（E30 教训）：球心不在任何工作区 ⇒ 回默认位——球是隐藏态**唯一**入口，
    /// 出屏 = 用户弄不回来（主窗还有托盘/面板兜底，球没有）。
    fn end_dot_drag(&mut self) {
        if self.dot_dragging_timer_on {
            unsafe { KillTimer(self.dot_hwnd, IDT_DOT_DRAG) };
            self.dot_dragging_timer_on = false;
        }
        let hide = self.shared.lock().map(|s| s.hide).unwrap_or(true);
        let keepable = ball_pos_visible(self.pos);
        if !keepable {
            let p = default_pos();
            self.pos = p;
            let (ww, wh) = self.win_size();
            unsafe {
                MoveWindow(self.dot_hwnd, p.0, p.1, DOT_SIZE, DOT_SIZE, 0);
                MoveWindow(self.hwnd, p.0, p.1, ww, wh, 0);
            }
        }
        self.dot_drag_target = None;
        save_pet_pos(self.pos, hide, None);
        // R20-b：放下「嗒」（球版 grab/drop 成对；出屏兜底那下也响——放置行为本身完成了）
        self.sfx("drop");
        if keepable {
            pet_log_line(&format!(
                "[native-pet] dot drag end -> ({},{})\n",
                self.pos.0, self.pos.1
            ));
        } else {
            pet_log_line(&format!(
                "[native-pet] dot drag end -> default {},{} (offscreen fallback)\n",
                self.pos.0, self.pos.1
            ));
        }
    }

    /// 悬浮球局部坐标处是否「透明」（= 让鼠标穿透到下层窗口）。
    /// 判据与 R2 主窗同口径（查最终合成缓冲 / 阈值 `CLICK_THROUGH_ALPHA`）——56px 方窗的
    /// 四角与发光外沿因此不吃点击，球从 30px 紫点放大后不会长出一片「隐形挡板」。
    fn dot_transparent_at(&self, x: i32, y: i32) -> bool {
        if x < 0 || y < 0 || x >= DOT_SIZE || y >= DOT_SIZE {
            return true;
        }
        let a = (self.dot_buf[(y * DOT_SIZE + x) as usize] >> 24) & 0xFF;
        a < CLICK_THROUGH_ALPHA
    }

    /// 悬浮球命中轮询（由 dot 窗口自己的 10ms 定时器驱动，与主窗 R2 同频同范式）。
    ///
    /// 规则：桌宠可见（球隐藏）恒不穿透——不留一个看不见却吃点击的方窗；
    /// 球可见时按命中切换穿透，并用**同一命中**更新悬停态（悬停 → 放大 + 光晕增强）。
    /// R18：球拖动中恒不穿透且**冻结悬停态**——光标「拿着」球，此时若按命中轮询
    /// 切换穿透，快速拖动会把球设成穿透态（与主窗 `update_click_through` 的
    /// `dragged` 早退同构）。
    fn update_dot_hit(&mut self) {
        if self.shown || self.dot_dragged {
            self.set_dot_click_through(false);
            if self.shown {
                self.dot_hover = false; // 球不可见：清态即可，不必重绘
            }
            return;
        }
        let mut p = Point { x: 0, y: 0 };
        unsafe {
            GetCursorPos(&mut p);
        }
        let transparent = self.dot_transparent_at(p.x - self.pos.0, p.y - self.pos.1);
        let hover = !transparent;
        if hover != self.dot_hover {
            self.dot_hover = hover;
            self.render_dot();
        }
        self.set_dot_click_through(transparent);
    }

    /// 切换悬浮球窗口的穿透样式位（与主窗 `set_click_through` 同构；两个 hwnd 各自缓存，
    /// 互不干扰）。
    fn set_dot_click_through(&mut self, on: bool) {
        if self.dot_click_through == on {
            return;
        }
        unsafe {
            let cur = GetWindowLongPtrW(self.dot_hwnd, GWL_EXSTYLE) as u32;
            let next = if on { cur | WS_EX_TRANSPARENT } else { cur & !WS_EX_TRANSPARENT };
            if next != cur {
                SetWindowLongPtrW(self.dot_hwnd, GWL_EXSTYLE, next as isize);
            }
        }
        self.dot_click_through = on;
    }

    /// R4:按 id **精确移除**一条提醒（审批 resolved / 决策失败回落时调用）。
    /// 只清匹配项——多会话并发审批时不会误伤别人的提醒（参考实现 `resolve_alert` 的核心价值）。
    /// 返回是否命中。
    fn resolve_alert(&mut self, id: &str) -> bool {
        let hit = self.alert.as_ref().map(|a| a.id == id).unwrap_or(false);
        if hit {
            self.alert = None;
            self.last_tick = std::time::Instant::now() - std::time::Duration::from_secs(10);
            true
        } else {
            false
        }
    }

    /// R5:审批气泡在窗口内的 y——帧高 84（普通气泡 56），故独立定位。
    ///
    /// DPI(2026-10-05)：改为**实例方法**（原为 `fn approval_y0() -> i32` 静态）——
    /// 布局量随窗口尺寸移动，必须知道当前 DPI。绘制与命中判定共用它，两处自然一致。
    fn approval_y0(&self) -> i32 {
        let (_, ph) = self.win_size();
        ph - scaled_px(CELL_H as i32, self.dpi) - scaled_px(APPROVAL_H, self.dpi)
            - scaled_px(4, self.dpi)
    }

    /// R5:绘制审批气泡（预渲染位图，含「拒绝 / 允许一次」两按钮）。**不调用任何字体 API**。
    /// 素材缺失（`Frames.approval = None`）→ 不画：宁可不显示，也不画一对点不到的空按钮。
    fn blit_approval(&mut self) {
        // frames 加载后不可变 → 裸指针解引用安全，且规避 `&mut self` 与 `&self.frames` 的借用冲突
        // （与 whale/inverse 立绘分支同一范式）。
        let ptr = match self.frames.approval.as_ref().map(|i| i as *const Image) {
            Some(p) => p,
            None => return,
        };
        let img = unsafe { &*ptr };
        let (pw, _) = self.win_size();
        // DPI：按钮框宽度与命中区宽度都须同比例放大，否则「画出来了但点不到」
        let x0 = (pw - scaled_px(APPROVAL_W, self.dpi)) / 2;
        self.blit_img(img, x0, self.approval_y0());
    }

    /// R5:命中审批按钮 → `Some(true)`=「允许一次」/`Some(false)`=「拒绝」/`None`=未命中。
    /// 两按钮之间留 8px 间隙（见 config 常量），降低误触。
    fn approval_hit(&self, x: i32, y: i32) -> Option<bool> {
        let a = self.alert.as_ref()?;
        if !a.id.starts_with(APPROVAL_ID_PREFIX) {
            return None;
        }
        // DPI(2026-10-05)：命中区**必须与 `blit_approval` 的绘制区逐字同源** ——
        // 两者都经 `scaled_px` + `win_size` 换算。此前绘制用基准值、命中也用基准值，
        // 窗口放大后二者仍一致；但只要有一处漏乘 scale，就会变成
        // 「按钮画在别处、点不到」（参考实现踩过同型的挂死气泡坑）。
        let (pw, _) = self.win_size();
        let x0 = (pw - scaled_px(APPROVAL_W, self.dpi)) / 2;
        let y0 = self.approval_y0();
        let bw = scaled_px(APPROVAL_BTN_W, self.dpi);
        let by = scaled_px(APPROVAL_BTN_Y, self.dpi);
        let bh = scaled_px(APPROVAL_BTN_H, self.dpi);
        let hit = |bx: i32| -> bool {
            x >= x0 + scaled_px(bx, self.dpi)
                && x < x0 + scaled_px(bx, self.dpi) + bw
                && y >= y0 + by
                && y < y0 + by + bh
        };
        if hit(APPROVAL_BTN_ALLOW_X) {
            Some(true)
        } else if hit(APPROVAL_BTN_DENY_X) {
            Some(false)
        } else {
            None
        }
    }

    /// R5:用户点击审批按钮 → ① 乐观收起气泡；② 经 eval 派发决策事件给 `dsh-pet-panel`，
    /// 由插件调用官方 `PendingApproval.answer()`（**桌宠侧不持有也不调用任何 DSH API**）。
    ///
    /// 红线（与 `pet-v3-roadmap.md` M3.2 一致）：只在用户**显式点击**时触发；只发
    /// `allowed-once` / `rejected` 两个枚举；不做「全部允许 / 记住选择」等持久化语义；
    /// 失败不假装成功——3s 内该审批仍在则由 stale 回落重新提示（见 compose 合流段）。
    fn decide_approval(&mut self, allow: bool) {
        let key = match self.alert.as_ref().and_then(|a| a.id.strip_prefix(APPROVAL_ID_PREFIX)) {
            Some(k) => k.to_string(),
            None => return,
        };
        let decision = if allow { "allowed-once" } else { "rejected" };
        self.decision_seq = self.decision_seq.wrapping_add(1);
        let seq = self.decision_seq;
        self.last_decision = Some((key.clone(), std::time::Instant::now()));
        // 乐观收起：立刻移除该审批气泡（避免「以为已经生效」）；失败时由 stale 回落重提示
        self.resolve_alert(&format!("{APPROVAL_ID_PREFIX}{key}"));
        // Rust → 页面：eval + CustomEvent（与 miasaki-pet-state / miasaki-max-state 同模式）。
        // 远程页无 IPC 权限、hash 又是单向的，故这是唯一合规的反向通道。
        let js = format!(
            "window.dispatchEvent(new CustomEvent('miasaki-approval-decision',{{detail:{{key:{},decision:{},seq:{}}}}}))",
            json_lit(&key),
            json_lit(decision),
            seq
        );
        if let Some(w) = self.app.get_webview_window("main") {
            let _ = w.eval(&js);
        }
        // 日志不打 key 明文（含 sessionId），只记长度与决策
        pet_log_line(&format!(
            "[native-pet] approval decision sent -> {decision} seq={seq} key_len={}\n",
            key.len()
        ));
        // R20-b：按钮点击的确认「嗒」——决策要走后端往返，这声先给用户「点到了」的反馈
        // （与 alert 的「叮咚」分工：那个说「有事」，这个说「收到」）
        self.sfx("tick");
    }

    /// DPI(2026-10-05)：当前 DPI 下的**窗口物理尺寸**。
    ///
    /// 唯一尺寸换算入口（`model::scaled_window_size`）。`MoveWindow` / DIB / `Size`
    /// 三处必须都走它，否则三者会不一致 —— `UpdateLayeredWindow` 遇到 DIB 与目标尺寸
    /// 不符会**静默拉伸填满**（画面被拉扁一像素，且不报错）。
    #[inline]
    fn win_size(&self) -> (i32, i32) {
        scaled_window_size(WIN_W, WIN_H, self.dpi)
    }

    /// DPI(2026-10-05)：当前 DPI 下的**角色可见区域**（窗口局部坐标，物理像素）。
    ///
    /// 与 `apply_dock` / peek 节拍共用同一份推导 —— 三处各写一遍是「口径漂移」的温床：
    /// 只要有一处忘了乘 scale，吸附判据与探头几何就会互相错位（现象是「缩边后角色不贴边」）。
    #[inline]
    fn role_local_phys(&self) -> Rect {
        let (pw, ph) = self.win_size();
        let base = character_local_rect();
        let sx = pw as f32 / WIN_W as f32;
        let sy = ph as f32 / WIN_H as f32;
        Rect {
            left: (base.left as f32 * sx).round() as i32,
            top: (base.top as f32 * sy).round() as i32,
            right: (base.right as f32 * sx).round() as i32,
            bottom: (base.bottom as f32 * sy).round() as i32,
        }
    }

    /// DPI(2026-10-05)：`DOCK_MARGIN_PX` 的物理像素值。
    /// 必须与 `role_local_phys()` 同步缩放，否则 200% 下留白从 18 塌成 9
    /// （桌宠「陷进」屏幕边缘，而不是设计里的「恰好贴边」）。
    #[inline]
    fn dock_margin(&self) -> i32 {
        scaled_px(DOCK_MARGIN_PX, self.dpi)
    }

    /// DPI(2026-10-05)：把窗口与 present 表面**重建**到新 DPI 下。
    ///
    /// 触发点只有两处：① `WM_CREATE` 后的首次取值；② `WM_DPICHANGED`。
    ///
    /// **为什么必须重建而不是只 MoveWindow**：`buf` 是按物理尺寸分配的定长 `Vec`，
    /// DIB 同理 —— 尺寸变了这两者都要重开。同时素材必须按新 scale 放大绘制
    /// （否则素材是 286×390 塞进 572×780 的窗口 = 只占左上 1/4 面积）。
    /// 顺序刻意是「先换 buf 再重建表面再 MoveWindow」：任何一步失败时，
    /// 表面与 buf 至少仍是一对（`present` 的兜底重建路径靠这个前提工作）。
    fn apply_dpi(&mut self, new_dpi: u32) {
        if new_dpi == 0 || new_dpi == self.dpi {
            return;
        }
        let old = self.dpi;
        self.dpi = new_dpi;
        let (pw, ph) = self.win_size();
        // ① buf：物理尺寸的合成缓冲。缩小时保留旧长度的下界即可（多出的尾部不会被画/不会
        //    提交到 DIB，因为 DIB 的 width/height 已按新尺寸收窄）——但为免「索引越界读到
        //    旧帧残留」，仍按新尺寸重建。
        self.buf = vec![0u32; (pw as usize) * (ph as usize)];
        // ② present 表面：尺寸变了必须重开 DIB。先删旧的（恢复→删除顺序铁律）。
        if self.present_dc != 0 || self.present_dib != 0 {
            destroy_present_surface(self.present_dc, self.present_dib);
            self.present_dc = 0;
            self.present_dib = 0;
            self.present_bits = std::ptr::null_mut();
            self.surface_fail_streak = 1; // 让 present() 的兜底路径接管重建
        }
        // ③ 窗口本体：位置不变、尺寸换新。**不复用 lParam 的建议矩形** ——
        //    那是系统按「整窗等比缩放」建议的，而本仓的素材/判据是固定基准尺寸，
        //    用系统建议会与 `scaled_window_size` 不一致 ⇒ 又一处静默拉伸。
        unsafe { MoveWindow(self.hwnd, self.pos.0, self.pos.1, pw, ph, 1); }
        pet_log_line(&format!(
            "[native-pet] DPI {old} -> {new_dpi} (scale {:.2}) 窗口尺寸 {pw}x{ph}\n",
            dpi_scale(new_dpi)
        ));
    }

    fn present(&mut self) {
        // D3 GDI 兜底:表面无效 → 低频重试重建（每 ~30 次 compose 一次 ≈1s，不刷屏不自旋）
        if self.present_dc == 0 || self.present_dib == 0 || self.present_bits.is_null() {
            self.surface_fail_streak += 1;
            if self.surface_fail_streak % 30 == 1 {
                let (pw, ph) = self.win_size();
                if let Some((dc, dib, bits)) = create_present_surface(pw, ph) {
                    self.present_dc = dc;
                    self.present_dib = dib;
                    self.present_bits = bits;
                    self.surface_fail_streak = 0;
                    self.surface_rebuilds += 1;
                    pet_log_line(&format!(
                        "[native-pet] present surface rebuilt #{}\n",
                        self.surface_rebuilds
                    ));
                } else if self.surface_fail_streak == 1 {
                    pet_log_line("[native-pet] present surface missing, retry scheduled\n");
                }
            }
            return;
        }
        unsafe {
            // 持久 DC/DIB 复用:仅在创建窗口时初始化,否则低频 GDI 交互
            std::ptr::copy_nonoverlapping(self.buf.as_ptr(), self.present_bits as *mut u32, self.buf.len());
            let mut pt = Point { x: self.pos.0, y: self.pos.1 };
            // DPI(2026-10-05)：物理尺寸而非基准尺寸（DIB 已按同值创建，见 apply_dpi）。
            let (pw, ph) = self.win_size();
            let mut sz = Size { cx: pw, cy: ph };
            let mut src = Point { x: 0, y: 0 };
            // 2026-09-29：整窗不透明度由用户设置决定（`settings.alpha`，百分比）。
            // 用 `SourceConstantAlpha` 而不是逐像素乘 —— 后者要在 33ms 的每帧里多遍历
            // 一整块 286×390 的缓冲（约 11 万像素），而这个值只影响整体透明度，交给系统合成即可。
            // 取不到锁时按 100%（不透明）——「读不到设置」不该让桌宠变半透明。
            let alpha_pct = self.shared.lock().map(|s| s.settings.alpha).unwrap_or(100).min(100);
            let blend = BlendFn {
                blend_op: 1,
                blend_flags: 0,
                src_alpha: ((alpha_pct * 255) / 100) as u8,
                alpha_format: 1,
            };
            let ok = UpdateLayeredWindow(self.hwnd, 0, &mut pt, &mut sz, self.present_dc, &mut src, 0, &blend, ULW_ALPHA);
            if ok == 0 {
                self.ulw_fail_streak += 1;
                if self.ulw_fail_streak == 1 || self.ulw_fail_streak % ULW_FAIL_LOG_EVERY == 0 {
                    pet_log_line(&format!("[native-pet] ULW failed x{}, GetLastError={}\n", self.ulw_fail_streak, GetLastError()));
                }
                // D3 GDI 兜底:连续失败达阈值 → 销毁重建表面（驱动/TDR 后 DIB 失效的恢复路径）
                if self.ulw_fail_streak == ULW_FAIL_STREAK_REBUILD {
                    destroy_present_surface(self.present_dc, self.present_dib);
                    self.present_dc = 0;
                    self.present_dib = 0;
                    self.present_bits = std::ptr::null_mut();
                    self.surface_rebuilds += 1;
                    pet_log_line(&format!(
                        "[native-pet] ULW streak {} → surface dropped, rebuild #{} scheduled\n",
                        self.ulw_fail_streak, self.surface_rebuilds
                    ));
                }
            } else if self.ulw_fail_streak != 0 {
                self.ulw_fail_streak = 0;
            }
        }
    }

    /// M1.3(v3):单击「撸一下」——jump + 气泡,不抢焦点;动作槽到期即清,不再有卡死路径。
    /// 审批/告警/busy 时本槽会被 pick_state_row 压住(状态优先),但槽照常登记。
    fn do_hop(&mut self) {
        self.action = Some(ActionSlot {
            action: Action::Jump,
            started: std::time::Instant::now(),
            duration: std::time::Duration::from_millis(HOP_MS),
        });
        self.frame_idx = 0;
        self.last_tick = std::time::Instant::now() - std::time::Duration::from_secs(10);
        let (idx, bubble_ms) = {
            let s = self.shared.lock().unwrap();
            (pick_quote(&s.mode), s.settings.bubble_ms)
        };
        // R4:单击「撸一下」是**用户主动**交互——其台词按告警档(1)展示，可短暂压过状态气泡，
        // 但**压不过审批**(0)：审批气泡必须常驻到 resolved（v3 M3 的硬约束）。
        self.alert = Some(Alert::timed("quote:click", idx, ALERT_PRI_ALERT, bubble_ms));
        self.alert_shown_at = std::time::Instant::now();
        // R20-b：起跳音（落地音在 JumpHold 转定格处，见 compose 动作槽清理）
        self.sfx("jump");
        // P0-F4：被撸一下，心情 +（与 Stroke 的 +10 区分：这是「点击」不是「抚摸」）
        self.mood = mood_apply(self.mood, MoodEvent::Hop);
    }

    /// v2 双击挥手:播 wave 行(约 500ms 内容,余量 1300ms 收尾)。
    /// M1.3:窗口类注册 CS_DBLCLKS 后此路径才真正可达(此前是死代码)。
    fn do_wave(&mut self) {
        self.action = Some(ActionSlot {
            action: Action::Wave,
            started: std::time::Instant::now(),
            duration: std::time::Duration::from_millis(WAVE_MS),
        });
        self.frame_idx = 0;
        self.last_tick = std::time::Instant::now() - std::time::Duration::from_secs(10);
        // R20-b：挥手的「咻」
        self.sfx("wave");
        // P0-F4：被打招呼，心情 +
        self.mood = mood_apply(self.mood, MoodEvent::Wave);
        // P2-b：被热情打招呼 ⇒ 害羞（whale 演 exShy 表情帧，其余主题落腮红符号）。
        // 排在姿态槽之后：表情会覆盖 wave 行（单槽互斥），符号则不占槽与 wave 并存。
        let now = std::time::Instant::now();
        self.show_mark(Mark::Shy, now);
    }

    /// v2 决策1:主窗口最小化/隐藏时双击=唤起(do_wave 的替代路径)
    fn main_needs_wake(&self) -> bool {
        self.app
            .get_webview_window("main")
            .map(|w| !w.is_visible().unwrap_or(true) || w.is_minimized().unwrap_or(false))
            .unwrap_or(false)
    }

    /// M2(v3):有效「等待审批」= DOM 兜底 waiting_approval 或官方契约 Waiting
    /// (5s 心跳内)。单击/双击唤起主窗口的判定依据(M1.3 语义)。
    fn effective_waiting(&self) -> bool {
        self.shared
            .lock()
            .map(|s| {
                let fresh = s
                    .official_at
                    .map(|t| t.elapsed() < std::time::Duration::from_millis(OFFICIAL_FRESH_MS))
                    .unwrap_or(false);
                s.waiting_approval || (fresh && s.official_state == Some(PetState::Waiting))
            })
            .unwrap_or(false)
    }

    /// R13（2026-10-05）：消费「最新拖动目标」——把窗口移到 `drag_target` 并清空。
    ///
    /// **返回值 = 是否真的移动了**。`None` 表示本节拍无新目标（同一 8ms 内的重复事件已被合掉）。
    /// 调用方据此决定要不要重画 —— 这是合帧省下来的开销的去处。
    ///
    /// **为什么必须独立成方法而不是内联进定时器分支**：松手时也要调它（强制 flush，
    /// 见 `WM_LBUTTONUP`）—— 若内联，松手路径就得复制一份 MoveWindow + pos 赋值，
    /// 而这两份一旦漂移就会出「松手后窗口停一拍」的 bug。
    fn flush_drag_target(&mut self) -> bool {
        // R13 的语义（M4 之前）：把窗口直接跳到最新目标。
        // M4 起改为**弹簧推进**（见 `spring_step`）：窗口不再死板地粘在光标上，
        // 而是「被拽着走」，松手时自然减速。
        let target = match self.drag_target {
            Some(t) => t,
            None => return false,
        };
        // 首次进入拖动（或状态被重置）时用弹簧初始化，避免从上一只宠物的残值起跳。
        if self.drag_spring_x.is_none() {
            self.drag_spring_x = Some(DragSpring { pos: self.pos.0 as f32, vel: 0.0 });
            self.drag_spring_y = Some(DragSpring { pos: self.pos.1 as f32, vel: 0.0 });
        }
        // R19（2026-10-17 续，用户报「拖拽还是有点粘滞」）：**拖动期内直跟手**。
        //
        // 为什么推翻 M4 的弹簧尾随：临界阻尼二阶系统对**匀速斜坡输入**的稳态滞后是
        // `2ζ/ω · v`（k=220 ⇒ ω≈14.8，系数≈0.135 s）：慢拖 300px/s 落后 40px、
        // 800px/s 落后 108px、快速甩 2000px/s 落后 270px —— 实机读感是「拖着一团
        // 有惯性的东西」。R18 的松手滑停又把这截滞后「补滑」出去，用户感知为二次粘滞。
        // 参考实现（Coopanion / GarfieldZhung）主进程拖动均为直跟手；R18 已把悬浮球
        // 做成直跟手，主窗统一同一口径。
        //
        // 弹簧实现**保留**：滑停收尾（`drag_settling`）与异常路径仍走下面的旧分支；
        // 直跟手时把弹簧状态同步成「已在目标上、速度 0」⇒ 松手首拍 `drag_settle_tick`
        // 立即判到位并收尾（松手即停，不再补滑）。
        if self.dragged && !self.drag_settling {
            let dt_s = self.last_drag_tick.elapsed().as_millis().max(1) as f32 / 1000.0;
            self.last_drag_tick = std::time::Instant::now();
            let (tx, ty) = (target.0 as f32, target.1 as f32);
            let (px, py) = (self.pos.0 as f32, self.pos.1 as f32);
            // 拖动反馈（R18 倾斜/拉伸）要的是窗口速度：直跟手时它等于光标速度。
            // 一阶平滑压掉逐事件抖动（形变抖比位置迟滞更显眼）。
            self.drag_vel = (
                self.drag_vel.0 * 0.6 + (tx - px) / dt_s * 0.4,
                self.drag_vel.1 * 0.6 + (ty - py) / dt_s * 0.4,
            );
            self.drag_spring_x = Some(DragSpring { pos: tx, vel: 0.0 });
            self.drag_spring_y = Some(DragSpring { pos: ty, vel: 0.0 });
            if target == self.pos {
                return false;
            }
            let (ww, wh) = self.win_size();
            unsafe { MoveWindow(self.hwnd, target.0, target.1, ww, wh, 1) };
            self.pos = target;
            return true;
        }
        // 已有目标且弹簧已到位 ⇒ 本拍不动（省一次 MoveWindow）。
        if let (Some(sx), Some(sy)) = (self.drag_spring_x, self.drag_spring_y) {
            if spring_at_target(sx, target.0 as f32) && spring_at_target(sy, target.1 as f32) {
                return false;
            }
        }
        // R16（2026-10-12）：**本拍时长必须拆成安全子步再积分**。
        //
        // 原实现是「`elapsed().min(100)` 后一次积完」，而那个 100ms 上限恰恰是过冲的来源：
        // 弹簧安全区是 ω·dt ≪ 1（8ms ⇒ 0.119），100ms 时 ω·dt = 1.48 > 1，半隐式欧拉会
        // 把窗口推到**目标位移的 2.2 倍**（实测峰值 2.43 倍）再慢慢飘回来。
        // 更糟的是它的触发条件**必然成立**：`last_drag_tick` 只在**本函数内**更新，而两次
        // 拖动之间的空闲必然远超 100ms ⇒ 每次起手第一拍都吃满上限 ⇒ 用户看到「一拖就窜」。
        //
        // 两处一起改才治本：① 拖动起手重置积分时钟（`WM_MOUSEMOVE` 的分支，让首拍 ≈ 8ms）；
        // ② 这里把任何 dt 拆成 ≤ `DRAG_SPRING_MAX_SUBSTEP_MS` 的子步（兜住挂起/低帧率）。
        // `max(1)` 保住原注释里那条理由：`elapsed()` 取整到 0 时若整拍不积分，拖动会卡住。
        let dt = self.last_drag_tick.elapsed().as_millis().min(DRAG_TICK_MAX_MS as u128) as u32;
        self.last_drag_tick = std::time::Instant::now();
        let (mut sx, mut sy) = (self.drag_spring_x.unwrap(), self.drag_spring_y.unwrap());
        let (tx, ty) = (target.0 as f32, target.1 as f32);
        let mut left = dt.max(1);
        while left > 0 {
            let step = left.min(DRAG_SPRING_MAX_SUBSTEP_MS);
            sx = spring_step(sx, tx, step);
            sy = spring_step(sy, ty, step);
            left -= step;
        }
        // 取整后再夹回 i32：f32 → i32 的 `as` 是截断，负坐标下会差 1px（长期累积成位置漂移）。
        let nx = sx.pos.round() as i32;
        let ny = sy.pos.round() as i32;
        self.drag_spring_x = Some(sx);
        self.drag_spring_y = Some(sy);
        // R18：把弹簧速度暴露给 compose——拖动倾斜/拉伸（`xform::drag_lean`）的输入。
        // 用弹簧速度而非光标速度：形变要反映**窗口真实运动**（松手滑停时光标已停，
        // 但窗口还在滑，形变应随窗口衰减而不是随光标突停）。
        self.drag_vel = (sx.vel, sy.vel);
        if nx == self.pos.0 && ny == self.pos.1 {
            return false; // 亚像素级移动 ⇒ 不惊动窗口
        }
        let (ww, wh) = self.win_size();
        unsafe { MoveWindow(self.hwnd, nx, ny, ww, wh, 1) };
        self.pos = (nx, ny);
        true
    }

    /// R13/M4.1：松手时**强制落到目标**并复位弹簧。
    ///
    /// **为什么松手不能只靠弹簧自己收敛**：临界阻尼弹簧理论上永远不到达目标
    /// （渐近逼近），而落盘位置必须**精确等于**用户看到的目标 —— 否则
    /// 「松手后桌宠停在离光标 0.4px 处」看着没事，但下次启动位置就偏了。
    /// ⇒ 松手走「直接对齐 + 速度清零」，不继续积分。
    ///
    /// **R18（2026-10-17）修订**：正常松手路径已改为 `release_drag`（滑停，见其注释），
    /// 本函数现在只服务两条**立即收尾**路径：① `WM_LBUTTONDOWN` 的残留清理；
    /// ② `WM_CAPTURECHANGED` 的捕获丢失兜底（失败路径优先 robustness，不追加滑停复杂度）。
    /// 另一处新增行为：滑停中被再次按下 ⇒ 先 `finish_drag_settle` 落盘再清状态
    /// （否则窗口停在新位置而 pet.json 还是旧值，下次启动桌宠跳回旧位）。
    fn end_drag(&mut self) {
        if self.drag_settling {
            self.finish_drag_settle();
            return; // finish 已清空目标/弹簧/定时器/滑停标志
        }
        if self.dragging_timer_on {
            unsafe { KillTimer(self.hwnd, IDT_DRAG) };
            self.dragging_timer_on = false;
        }
        if let Some((nx, ny)) = self.drag_target {
            let (ww, wh) = self.win_size();
            unsafe { MoveWindow(self.hwnd, nx, ny, ww, wh, 1) };
            self.pos = (nx, ny);
        }
        self.drag_target = None;
        self.drag_spring_x = None;
        self.drag_spring_y = None;
        self.drag_vel = (0.0, 0.0);
    }

    /// R18（2026-10-17）：松手（正常路径）——**不强制对齐目标、不当拍落盘**。
    ///
    /// 旧实现在 `WM_LBUTTONUP` 里直接 `end_drag()`（`MoveWindow` 到 `drag_target`）：
    /// 快速甩动后弹簧还剩几十 px 残余滞后 ⇒ 松手瞬间**前跳**（参考实现同款做法是
    /// 「扔出去」——GarfieldZhung 直跟手无此问题、Coopanion 有 throw 物理；我方取
    /// 「滑停」这条中间路线：不引入抛掷物理，但消除前跳）。
    ///
    /// 机制：目标与弹簧保留，`IDT_DRAG` 续跑，弹簧自然收敛（k=220 时 250ms 内
    /// 残余 <1px），由 `drag_settle_tick` 在双轴到位时收尾。慢拖/点一下（松手时
    /// 已到位）首拍即收尾，行为与旧版无差异。
    /// 异常态（目标/弹簧已清）⇒ 立即按现状收尾，不留半拖状态。
    ///
    /// **P0-F3（2026-10-18）**：松手速度 ≥ `THROW_VEL_MIN` ⇒ 进**抛掷飞行**（`flying`），
    /// 代替滑停——「拎起来甩出去」（Coopanion/GarfieldZhung 同款玩法）。判据用
    /// `drag_vel`（R19 直跟手期每拍更新的窗口速度）；慢放仍走滑停，行为零变化。
    fn release_drag(&mut self) {
        self.dragged = false;
        if self.drag_target.is_some() && throw_triggered(self.drag_vel) {
            // 飞行从「当前窗口位置 + 松手速度」起跳——直跟手末期窗口就在目标附近，
            // 不需要再对齐一次（对齐反而引入一次可见跳变）。
            self.flying = Some(FlyState {
                pos: (self.pos.0 as f32, self.pos.1 as f32),
                vel: self.drag_vel,
                bounces: 0,
                age_ms: 0,
            });
            self.drag_target = None;
            self.drag_spring_x = None;
            self.drag_spring_y = None;
            // 表继续挂着（松手路径不 KillTimer）——飞行由同一个 IDT_DRAG 节拍驱动
            // P0-F4：被甩出去，它害怕（心情 -）
            self.mood = mood_apply(self.mood, MoodEvent::Throw);
            self.sfx("whoosh");
            pet_log_line(&format!(
                "[native-pet] throw start v=({:.0},{:.0}) from ({},{})\n",
                self.drag_vel.0, self.drag_vel.1, self.pos.0, self.pos.1
            ));
            return;
        }
        if self.drag_target.is_some() && self.drag_spring_x.is_some() && self.drag_spring_y.is_some() {
            self.drag_settling = true;
            return;
        }
        self.finish_drag_settle();
    }

    /// R18：滑停收尾——停表、清拖动状态、停靠判定 + 落盘。
    /// 新不变量：「**落盘位置 = 用户看到的停止位置**」（取代 R13 的「落盘 = 逻辑目标」，
    /// 两者差 ≤1px，但滑停无前跳）。`apply_dock` 在落盘**之前**——落盘要记吸附后的位置。
    fn finish_drag_settle(&mut self) {
        if self.dragging_timer_on {
            unsafe { KillTimer(self.hwnd, IDT_DRAG) };
            self.dragging_timer_on = false;
        }
        self.drag_settling = false;
        self.drag_target = None;
        self.drag_spring_x = None;
        self.drag_spring_y = None;
        self.drag_vel = (0.0, 0.0);
        let docked = self.apply_dock();
        let hide = self.shared.lock().map(|s| s.hide).unwrap_or(false);
        save_pet_pos(self.pos, hide, docked);
        self.render_dot();
        // R20-b：放下「嗒」（与起手 grab 成对；R19 直跟手下松手即停，这声就是「放置成功」）
        self.sfx("drop");
        pet_log_line(&format!(
            "[native-pet] drag end -> ({},{}) dock={:?}\n",
            self.pos.0, self.pos.1, docked
        ));
    }

    /// R18：滑停节拍检查（`IDT_DRAG` 每拍调）——弹簧双轴到位即收尾。
    /// 与 `flush_drag_target` 分工：那个管「移动」，这个管「何时结束」。
    fn drag_settle_tick(&mut self) {
        if !self.drag_settling {
            return;
        }
        let settled = match (self.drag_target, self.drag_spring_x, self.drag_spring_y) {
            (Some(t), Some(sx), Some(sy)) => {
                spring_at_target(sx, t.0 as f32) && spring_at_target(sy, t.1 as f32)
            }
            _ => true, // 目标/弹簧已清（异常路径）⇒ 按现状收尾
        };
        if settled {
            self.finish_drag_settle();
        }
    }

    /// R18：拖动反馈值（`compose` 两个绘制分支共用，见 `xform::drag_lean`）。
    ///
    /// 返回 `(xf, lifting)`：`lifting = true` 表示本帧处于拖动/滑停，调用方据此
    /// **关掉摇摆**（lean 顶替、不叠加——叠加会突破横向余量，由 `xform.rs` 的
    /// `lean_plus_sway_would_overflow_so_they_are_exclusive` 钉住）并加拎起抬升。
    /// P0-F3：抛掷飞行同样吃 lean（「飞出去时朝着运动方向倾斜」）——抬升对飞行无意义
    /// （它本来就在空中），但 6px 在高速移动中不可感知，统一走 lifting 更简单。
    fn drag_lean_now(&self, motion: f32) -> (DrawXform, bool) {
        if self.dragged || self.drag_settling || self.flying.is_some() {
            (drag_lean(self.drag_vel.0, self.drag_vel.1, motion), true)
        } else {
            (DrawXform::IDENTITY, false)
        }
    }

    /// M4.1：松手时判定边缘停靠，把窗口沿命中的边推出，返回该边（未命中则 `None`）。
    ///
    /// **架构红利（这轮最大的收获）**：缩边/吸附**不需要新增裁剪 blit**。
    /// v5-roadmap §3.4 写「需要新增按边缘裁剪的 blit（现有 `blit_center_bottom` 不做裁剪）」——
    /// **这条判断有误**：`blit_center_bottom` 一直在做**窗口边界**裁剪
    /// （`window.rs:651/655` 的 `dy/dx < 0 || >= WIN_H/WIN_W` 就 `continue`）。
    /// 而窗口是**分层窗**（`WS_EX_LAYERED`，`window.rs:1657`）⇒ 把窗口移到屏外，
    /// 超出部分自然不绘制，**零绘制改动**即可得到「只露出一截」的效果。
    ///
    /// 若当初照 roadmap 的估计去写裁剪 blit，会白花一轮且引入一个高风险点
    /// （裁剪逻辑一旦与 `xform` 的逆变换采样不一致，就会出现「看得见的点不到」）。
    ///
    /// **判据用「角色可见区域」而非窗口原点**（`character_local_rect` 排除了气泡带与左右留白）——
    /// 否则那 18px 留白会被算成「离边缘还有 18px」，角色本体永远贴不到边。
    fn apply_dock(&mut self) -> Option<DockEdge> {
        // DPI(2026-10-05)：角色区域与吸附留白都取**物理像素**口径
        // （推导见 `role_local_phys` / `dock_margin` 的注释）。
        let local = self.role_local_phys();
        let role = Rect {
            left: self.pos.0 + local.left,
            top: self.pos.1 + local.top,
            right: self.pos.0 + local.right,
            bottom: self.pos.1 + local.bottom,
        };
        // 找到角色中心所在的工作区（跨屏时吸附到「当前那块屏」的边，不是主屏）
        let work = monitor_workspaces()
            .into_iter()
            .find(|r| {
                let cx = (role.left + role.right) / 2;
                let cy = (role.top + role.bottom) / 2;
                cx >= r.left && cx < r.right && cy >= r.top && cy < r.bottom
            })
            .unwrap_or(Rect { left: 0, top: 0, right: WIN_W, bottom: WIN_H });
        let edge = match pick_dock_edge(role, work, self.dock_margin()) {
            Some(e) => e,
            None => {
                // 拖到屏幕中间 ⇒ 脱离停靠（必须清，否则显隐切换会把旧 dock 写回去）
                self.docked_edge = None;
                peek_reset(&mut self.peek);
                // E30（2026-10-13）兜底：**完全拖出所有工作区** ⇒ 拉回默认位置。
                // 两条来路：① 捕获拖动中 `GetCursorPos` 可返回越界坐标（光标抵住屏幕边缘后
                //   继续外推，桌宠被带出屏外）；② 旧版 `dock_push_out` 推出 bug 的遗留位置。
                // 判据与 R3 启动兜底**同口径**（`pos_visible`：角色与任一工作区交集 ≥25%）——
                // 贴边/半出屏/peek 缩边都不会误伤，只有「整块角色在任何工作区外」才拉回。
                // 没有这道兜底时，出屏的桌宠光标够不着、点不到、拖不回，用户只能重启
                // （实机日志：出屏后 100+ 次 5px 步进的微拖挣扎全程记录在案）。
                if !pos_visible(self.pos) {
                    let hide = self.shared.lock().map(|s| s.hide).unwrap_or(false);
                    let p = default_pos();
                    let (ww, wh) = self.win_size();
                    unsafe { MoveWindow(self.hwnd, p.0, p.1, ww, wh, 1) };
                    self.pos = p;
                    self.dock_base = p;
                    save_pet_pos(p, hide, None);
                    self.render_dot();
                    pet_log_line(&format!(
                        "[native-pet] drag end pos fully offscreen -> default {},{} (dock cleared)\n",
                        p.0, p.1
                    ));
                }
                return None;
            }
        };
        // 推出：以**窗口位置**为基准。`role` 必须是**绝对矩形**（E30：旧实现传窗口局部矩形，
        // 且 `dock_push_out` 内部把目标位置当位移叠加 ⇒ 推出量 = 旧 pos，Right/Bottom 边
        // 直接把整窗推出屏幕。契约见 `model::dock_push_out` 注释）。
        self.docked_edge = Some(edge);
        if let Some((nx, ny)) = dock_push_out(self.pos, role, work, edge, self.dock_margin()) {
            if (nx, ny) != self.pos {
                // DPI(2026-10-05)：尺寸取**当前 DPI 下的物理窗尺寸**（`win_size()` 是唯一换算入口
                // —— MoveWindow / DIB / Size 三处必须同源，否则 ULW 会静默拉伸）。
                let (ww, wh) = self.win_size();
                unsafe { MoveWindow(self.hwnd, nx, ny, ww, wh, 1) };
                self.pos = (nx, ny);
            }
        }
        // M4.1：新吸附 ⇒ peek 从头计。吸附位即 slide=0 基准；静置 5s 后状态机会再缩边。
        self.dock_base = self.pos;
        peek_reset(&mut self.peek);
        Some(edge)
    }

    fn show_menu(&self, x: i32, y: i32) {
        unsafe {
            let enc = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
            let m = CreatePopupMenu();
            let s1 = enc("显示主窗口");
            let s2 = enc("隐藏桌宠");
            let s3 = enc("最小化主窗口");
            let s4 = enc("重启 DSH 服务");
            let s5 = enc("退出应用");
            AppendMenuW(m, MF_STRING, MENU_SHOW, s1.as_ptr());
            AppendMenuW(m, MF_STRING, MENU_HIDE, s2.as_ptr());
            AppendMenuW(m, MF_STRING, MENU_MIN, s3.as_ptr());
            AppendMenuW(m, MF_STRING, MENU_RESTART, s4.as_ptr());
            AppendMenuW(m, MF_STRING, MENU_EXIT, s5.as_ptr());
            // R1 兼容：`TrackPopupMenu` 要求 owner 窗口是**前台窗口**，否则「点击菜单外不关闭」。
            // 而 R1 新加的 `WS_EX_NOACTIVATE` 会让 `SetForegroundWindow` 失效，
            // 故此处临时摘掉该样式位，菜单结束后恢复，并把前台归还给原窗口。
            let prev_fg = GetForegroundWindow();
            let ex = GetWindowLongPtrW(self.hwnd, GWL_EXSTYLE) as u32;
            SetWindowLongPtrW(self.hwnd, GWL_EXSTYLE, (ex & !WS_EX_NOACTIVATE) as isize);
            SetForegroundWindow(self.hwnd);
            let cmd = TrackPopupMenu(m, TPM_RETURNCMD | TPM_RIGHTBUTTON, x, y, 0, self.hwnd, 0);
            // MSDN 推荐：菜单结束后补一条空消息，确保菜单可靠消失
            PostMessageW(self.hwnd, WM_NULL, 0, 0);
            SetWindowLongPtrW(self.hwnd, GWL_EXSTYLE, ex as isize);
            if prev_fg != 0 && prev_fg != self.hwnd {
                SetForegroundWindow(prev_fg); // 焦点归还（R1：用完不留前台占用）
            }
            DestroyMenu(m);
            match cmd as usize {
                MENU_SHOW => self.focus_main(),
                MENU_HIDE => self.hide_self(),
                MENU_MIN => {
                    if let Some(w) = self.app.get_webview_window("main") {
                        let _ = w.minimize();
                    }
                }
                MENU_RESTART => crate::restart_backend(&self.app, "桌宠菜单"),
                MENU_EXIT => crate::request_close(&self.app),
                _ => {}
            }
        }
    }

    /// 隐藏请求：只写 shared 标志，UI 切换与落盘由 compose（窗口线程）统一执行，
    /// 避免多线程直接操作 user32 句柄。
    fn hide_self(&self) {
        if let Ok(mut s) = self.shared.lock() {
            s.hide = true;
        }
    }

    fn show_self(&self) {
        if let Ok(mut s) = self.shared.lock() {
            s.hide = false;
        }
    }

    // 点击桌宠 → 唤起/聚焦主窗口(最小化先还原:SW_SHOW 不会解除最小化,必须 unminimize)
    fn focus_main(&self) {
        if let Some(w) = self.app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }
}

/* ---------------- 窗口过程 ---------------- */

unsafe fn get_pet(hwnd: isize) -> *mut PetWin {
    GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PetWin
}

unsafe extern "system" fn wnd_proc(hwnd: isize, msg: u32, wp: usize, _lp: isize) -> isize {
    let pet = get_pet(hwnd);
    if pet.is_null() {
        return DefWindowProcW(hwnd, msg, wp, _lp);
    }
    match msg {
        WM_DPICHANGED => {
            // DPI(2026-10-05)：窗口跨到不同缩放的显示器。
            // `wParam` 低 16 位 = 新 DPI（高 16 位 = 原 DPI）。**不复用 lParam 的建议矩形**
            // —— 那是系统按「整窗等比缩放」给的，而本仓的素材与判据都锚在基准尺寸上，
            // 用系统建议会与 `scaled_window_size` 不一致 ⇒ 又一处静默拉伸。
            // `apply_dpi` 内部走唯一换算入口，并把 buf / DIB / MoveWindow 一起对齐。
            let new_dpi = (wp & 0xFFFF) as u32;
            (*pet).apply_dpi(new_dpi);
            // 位图内容需按新 scale 重画（buf 已清零 ⇒ 留空窗一帧）。置 dirty 由 compose 节拍接管，
            // 这里直接标脏以免等到下一张动画帧才补上。
            0
        }
        WM_CREATE => {
            SetTimer(hwnd, IDT_COMPOSE, 33, 0);
            // DPI(2026-10-05)：用**真实 hwnd** 复核冷启动估算的 DPI。
            // `boot_dpi` 走 `dpi_at_point`（按落点估算），而窗口实际落在哪块屏以 hwnd 为准；
            // 两者不一致时（落点跨屏 / 显示器布局在启动瞬间变化）以此为准。
            // `apply_dpi` 在 `new_dpi == self.dpi` 时直接返回，故常态零开销。
            let real = GetDpiForWindow(hwnd);
            if real != 0 {
                (*pet).apply_dpi(real);
            }
            0
        }
        WM_TIMER => {
            if wp == IDT_SINGLE_CLICK {
                // M1.3:单击去抖到期 → 确认是单击(非双击) → 撸一下(不抢焦点)
                KillTimer(hwnd, IDT_SINGLE_CLICK);
                if (*pet).click_pending {
                    (*pet).click_pending = false;
                    (*pet).do_hop();
                }
                0
            } else if wp == IDT_HIT {
                // R2:透明区域鼠标穿透——10ms 轮询光标并切换 WS_EX_TRANSPARENT
                (*pet).update_click_through();
                // P0-F1：摸头判定 + 咬手跟随（同一 10ms 拍，光标与命中事实都是现成的）
                (*pet).petting_and_bite_tick();
                0
            } else if wp == IDT_DRAG {
                // R13:拖动合帧——8ms 消费最新目标。**同一节拍内无新目标时不 MoveWindow**
                // （这正是合帧省下来的开销）；也据此重画，避免无谓的 present。
                if (*pet).flying.is_some() {
                    // P0-F3：抛掷飞行中——本拍推进物理（移动/反弹/结束判定都在 fly_tick）
                    (*pet).fly_tick();
                } else {
                    if (*pet).flush_drag_target() {
                        (*pet).render_dot();
                    }
                    // R18：滑停节拍——松手后续跑到弹簧双轴到位才收尾落盘（消前跳）。
                    // 不在拖动也不在滑停时是零开销早退。
                    (*pet).drag_settle_tick();
                }
                0
            } else if wp == IDT_PEEK {
                // M4.1:peek 边界检测（静置到期 / 光标压上）；动画推进在 compose 节拍
                (*pet).peek_poll();
                0
            } else if wp == IDT_FULLSCREEN {
                // R20-a：全屏覆盖轮询（规则瞬态隐藏/恢复，不落盘）
                (*pet).fs_poll();
                0
            } else {
                (*pet).compose();
                0
            }
        }
        WM_LBUTTONDOWN => {
            // M1.3:新按压序列开始——清去抖与吞 UP 标记(第二击的 DOWN 若成双击,由 DBLCLK 接管)
            KillTimer(hwnd, IDT_SINGLE_CLICK);
            (*pet).click_pending = false;
            (*pet).swallow_next_up = false;
            // M4.1:按下即交互（peek 静置时钟;能收到本事件说明光标在可点区域上）
            (*pet).last_interaction = std::time::Instant::now();
            let mut p = Point { x: 0, y: 0 };
            GetCursorPos(&mut p);
            (*pet).press_pt = (p.x, p.y);
            (*pet).dragged = false;
            // R13:新按压序列 —— 上一轮若有残留目标（异常路径，如拖动中窗口被销毁），
            // 在这里清掉并停表，避免下一次拖动时「跳到上一轮的目标」。
            (*pet).end_drag();
            // P0-F3：飞行中按下 = 「伸手接住」——按现状收尾（停靠判定 + 落盘），
            // 随后本按键序列照常起拖动（从当前位置）。不清这一步的话飞行状态会把
            // 「按下即抓」变成「按下后它还按物理飞」。
            if (*pet).flying.is_some() {
                (*pet).finish_fly();
            }
            // R16（2026-10-12）：**显式捕获鼠标**。
            //
            // 本仓 M1–M4 一直只依赖 Win32 的隐式捕获（「在客户区按下按钮时系统自动捕获」），
            // 实机取证发现它会丢 UP：桌宠卡在 `dragged=true`（判据 = 光标在窗口外 +
            // 窗口可见 + EXSTYLE 无 `WS_EX_TRANSPARENT` ⇒ 只可能走了 `update_click_through`
            // 的 `!shown || dragged` 提前返回）。卡住后这一整块 286×390 变成吃鼠标的挡板，
            // 而且**位置永不落盘**（pet.json 自 10/07 到 10/12 没更新过，窗口却已挪了 1000px）。
            //
            // 在 DOWN（而不是拖动起手）就捕获，是为了让「未越过拖动阈值的松手」也有 UP 可收：
            // 释放点唯一（`WM_LBUTTONUP` 末尾统一 `ReleaseCapture`），另有
            // `WM_CAPTURECHANGED` 兜底「捕获被外部夺走」这条 UP 永不到达的路径。
            //
            // R17（2026-10-13）：与起手处同一口径 —— **只在确实没持有捕获时才捕**。
            // 无脑重捕会给同一窗口重发 `WM_CAPTURECHANGED`（取证见起手处注释）。
            // 此处 `dragged` 刚被清成 false，重发只是无谓消息、无功能影响；判据化是为了让
            // 「本文件不存在第二次对同一窗口的 SetCapture」这条不变量成立，从而可被源码契约测试钉住。
            if unsafe { GetCapture() } != hwnd {
                unsafe { SetCapture(hwnd) };
            }
            // 只在**首次**未生效时记一行（本仓有「pet.log 被高频行灌满」的前科：
            // 设置面板同值 setter 曾让它以 1.32 行/秒写盘）。
            static CAPTURE_WARNED: std::sync::atomic::AtomicBool =
                std::sync::atomic::AtomicBool::new(false);
            let capture_by = unsafe { GetCapture() };
            if capture_by != hwnd
                && !CAPTURE_WARNED.swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                pet_log_line(&format!(
                    "[native-pet] drag: SetCapture 未生效（GetCapture={capture_by}）—— \
                     拖动仍可用，但丢 UP 时无捕获兜底\n"
                ));
            }
            // v2:指针按下即打断环境编排/挥手/散步(拖拽与动作互斥);跳跃保留不打折反馈
            // P0-F2：Emote 也进打断清单——点一下 = 「别演了」（睡觉被叫醒、跳舞被叫停都走这条）；
            // P0-F1：咬着光标时按下 = 「松口」（finish_bite 收尾落盘，点击本身照常走后续语义）。
            if (*pet).bite_follow.is_some() {
                (*pet).finish_bite();
            }
            let interrupted_sleep = matches!(
                &(*pet).action,
                Some(s) if matches!(s.action, Action::Emote { kind: EmoteKind::Sleep })
            );
            let interrupt = matches!(
                &(*pet).action,
                Some(s) if matches!(
                    s.action,
                    Action::Ambient { .. } | Action::Wave | Action::Wander { .. } | Action::Emote { .. }
                )
            );
            if interrupt {
                (*pet).action = None;
            }
            // 2026-10-18 审查修正：打断的是**睡眠槽** ⇒ 走「叫醒」路径（清夜间缓存 +
            // 免睡冷却）。只清动作槽的话「瞌睡续觉」钩子下一拍就把它放回睡姿（点击即醒失效）。
            if interrupted_sleep {
                (*pet).wake_from_sleep(std::time::Instant::now());
            }
            0
        }
        WM_MOUSEMOVE => {
            if wp & MK_LBUTTON != 0 {
                let mut p = Point { x: 0, y: 0 };
                GetCursorPos(&mut p);
                let dx = p.x - (*pet).press_pt.0;
                let dy = p.y - (*pet).press_pt.1;
                if (*pet).dragged {
                    // —— 已在拖动中：把本事件的增量**推进到逻辑目标**上 ——
                    // 推进规则见 `model::advance_drag_target`（那里的注释说明了
                    // 为什么基准既不能用 `GetWindowRect` 的实时位置、也不能用按下点）。
                    if dx != 0 || dy != 0 {
                        (*pet).drag_target = Some(advance_drag_target(
                            (*pet).drag_target,
                            (*pet).pos,
                            (dx, dy),
                        ));
                        (*pet).press_pt = (p.x, p.y);
                    }
                } else if drag_should_start((dx, dy), DRAG_THRESHOLD) {
                    // —— 阈值判定为「开始拖动」（口径见 `model::drag_should_start`）
                    (*pet).dragged = true;
                    // M4.1（R14 教训②）：拖动即脱离 peek/停靠——探头期间的全部位移来源
                    // 都要让位给拖动目标；松手后 `apply_dock` 按新位置重新判定吸附。
                    peek_reset(&mut (*pet).peek);
                    (*pet).docked_edge = None;
                    // R13（2026-10-05）：**只记最新绝对目标，不在这里 MoveWindow**。
                    // 逐事件 MoveWindow 在 1000Hz 鼠标下是每秒千次窗口重定位；
                    // 且同一节拍内的重复样本会污染 M4 拖动尾随要用的滞后估计。
                    // 实际移动由 `IDT_DRAG`（8ms）消费 —— 见 `config::DRAG_COALESCE_MS`。
                    let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
                    GetWindowRect(hwnd, &mut r);
                    (*pet).drag_target = Some((r.left + dx, r.top + dy));
                    (*pet).press_pt = (p.x, p.y);
                    // R16（2026-10-12）：**起手重置弹簧积分时钟**。
                    //
                    // `last_drag_tick` 只在 `flush_drag_target` 内更新，而两次拖动之间的空闲
                    // 必然 ≫ 100ms ⇒ 不重置的话，首拍 dt 必然被夹到上限（100ms），
                    // 弹簧在该步长下 ω·dt = 1.48 > 1，会把窗口推到目标位移的 **2.2 倍**
                    // 再飘回来（数值取证见 `design/CHANGELOG.md` 2026-10-12 条）。
                    // 重置后首拍 ≈ 8ms（`IDT_DRAG` 周期）⇒ 落在 ω·dt ≈ 0.12 的安全区。
                    (*pet).last_drag_tick = std::time::Instant::now();
                    // R16：捕获保险 —— DOWN 时已捕，这里再捕一次兜住「按下与起手之间被夺走」。
                    //
                    // R17（2026-10-13 实机障故）：**必须加 `GetCapture() != hwnd` 前缀**，
                    // 不能无条件重捕。对**已持有捕获**的窗口再次调用 `SetCapture`，Windows 会
                    // 向**同一窗口**重发 `WM_CAPTURECHANGED`（本机探针实测：第二次调用后收到
                    // 1 条，且收到时 `GetCapture()` 仍是本窗口 —— 对应 user32 一致性测试
                    // `test_DoubleSetCapture` 的既有行为；留档 `_refs/pet-capture-probe/`）。
                    // 而本窗口过程把该消息当作「捕获被外部夺走」，判据又是 `dragged` ——
                    // **它刚被上面第 1793 行置成 true** ⇒ 起手瞬间自我收尾
                    // （`end_drag` + `apply_dock` + 落盘），拖动完全无法进行：
                    // 实机 `pet.log` 里 `drag aborted` 733 次 / `drag end` **0 次**，
                    // 且 `aborted` 行恒排在对应 `drag start` 行**之前**（同步重入的签名）。
                    if unsafe { GetCapture() } != hwnd {
                        unsafe { SetCapture(hwnd) };
                    }
                    if !(*pet).dragging_timer_on {
                        (*pet).dragging_timer_on = true;
                        // SetTimer 返回 0 = 挂表失败。那意味着**目标永不被消费**（窗口不动），
                        // 而 `dragging_timer_on` 已是 true ⇒ 不会再重试。这条日志是「拖不动」
                        // 这类偶发故障的唯一现场记录。
                        if unsafe { SetTimer(hwnd, IDT_DRAG, DRAG_COALESCE_MS, 0) } == 0 {
                            pet_log_line("[native-pet] drag: SetTimer(IDT_DRAG) 失败 —— 本拍不会消费目标\n");
                        }
                    }
                    pet_log_line(&format!(
                        "[native-pet] drag start win=({},{}) target=({},{})\n",
                        r.left, r.top, r.left + dx, r.top + dy
                    ));
                    // R20-b：拎起「啵」（松手音在 finish_drag_settle 收尾处）
                    (*pet).sfx("grab");
                }
            }
            0
        }
        WM_LBUTTONUP => {
            // R16（2026-10-12）：本分支的**所有**出口都必须释放鼠标捕获，故在末尾统一做。
            // 用标签块而不是在每个 `return` 前各写一次：漏一处的后果是桌宠永久持有捕获
            // （整个系统的鼠标消息都归它），比多写一行严重得多。
            'up: {
                // M1.3:双击序列的第二次 UP 直接吞掉(DBLCLK 已处理,防「挥一次+跳一次」)
                if (*pet).swallow_next_up {
                    (*pet).swallow_next_up = false;
                    break 'up;
                }
                // R5:审批按钮命中优先于拖动/单击语义——这次点击是「决策」，不是「撸一下」。
                // （命中区判定在角色本体范围内，故不会与透明穿透冲突：能点到就说明窗口可点。）
                if !(*pet).dragged {
                    let mut pt = Point { x: 0, y: 0 };
                    GetCursorPos(&mut pt);
                    if let Some(allow) = (*pet).approval_hit(pt.x - (*pet).pos.0, pt.y - (*pet).pos.1) {
                        (*pet).decide_approval(allow);
                        break 'up;
                    }
                }
                // M4.1：探头中（含缩边/退回过渡）点击 = 拉直（R14：点击 → engage 档 0.82），
                // 不吃「撸一下」语义——用户点的是「出来」，不是「表演」。拉直态（Straightened）
                // 的点击走原语义（跳/唤起）。
                if !(*pet).dragged
                    && matches!(
                        (*pet).peek.phase,
                        PeekPhase::Peeking | PeekPhase::Entering | PeekPhase::Returning
                    )
                {
                    peek_kick_engage(&mut (*pet).peek);
                    (*pet).last_interaction = std::time::Instant::now();
                    break 'up;
                }
                if !(*pet).dragged {
                    // M1.3 单击语义:等待审批或主窗口不可见 → 立即唤起主窗口(保留有用语义);
                    // 否则 → 去抖 250ms 判定是否双击,到期执行「撸一下」——不再无条件抢焦点(D5)
                    let wake = (*pet).effective_waiting() || (*pet).main_needs_wake();
                    if wake {
                        KillTimer(hwnd, IDT_SINGLE_CLICK);
                        (*pet).click_pending = false;
                        (*pet).focus_main();
                    } else {
                        SetTimer(hwnd, IDT_SINGLE_CLICK, SINGLE_CLICK_DEBOUNCE_MS, 0);
                        (*pet).click_pending = true;
                    }
                } else {
                    // R16：**先清 `dragged` 再收尾**。末尾的 `ReleaseCapture` 会同步派发
                    // `WM_CAPTURECHANGED`，而那里的兜底以 `dragged` 为判据；先清掉它，
                    // 同一次松手才不会收尾两遍（重复落盘 + 重复吸附）。
                    // R18：收尾本体 = `release_drag`（滑停：不 snap、不当拍落盘，
                    // IDT_DRAG 续跑到弹簧到位由 `drag_settle_tick` 收尾）——它内部
                    // 先清 `dragged` 再起滑停，R16 的排序纪律不变。
                    (*pet).release_drag();
                }
            }
            unsafe { ReleaseCapture() };
            0
        }
        WM_CAPTURECHANGED => {
            // R16（2026-10-12）：捕获被外部夺走 —— 这是**唯一**能在「`WM_LBUTTONUP` 永不到达」
            // 时收尾拖动状态的事件。
            //
            // 实机故障（本次诊断取证）：桌宠卡在 `dragged=true` ⇒ ① `update_click_through`
            // 恒走 `!shown || dragged` 提前返回，整块 286×390 变成吃鼠标的挡板；
            // ② 位置永不落盘（pet.json 自 10/07 到 10/12 未更新，窗口却已挪了 1000px）；
            // ③ `IDT_DRAG` 8ms 定时器常驻。修法就是在这里把同一次收尾补完。
            // 正常松手路径已先清 `dragged` ⇒ 本分支在正常情况下是空操作。
            //
            // R17（2026-10-13）：**但「收到本消息」≠「捕获真丢了」**。对已持有捕获的窗口
            // 重复 `SetCapture`，Windows 会向同一窗口重发本消息（探针实测见
            // `_refs/pet-capture-probe/`）—— 那是「自我重发」，收尾就是自伤。
            // 判据 = 收到本消息时捕获是否仍在本窗口（实测双向有效）：
            //   · 同一窗口重复 SetCapture ⇒ `GetCapture() == hwnd` ⇒ 不是丢失，直接忽略；
            //   · 被别的窗口真夺走 ⇒ `GetCapture() != hwnd` ⇒ 按原语义收尾。
            // 缺这道判据的后果正是用户报障的「点一下就消失」：起手分支的捕获保险
            // 把该分支自己刚置上的 `dragged=true` 打回去，鼠标一动就收尾一次，
            // 而收尾里的 `apply_dock` 在停靠边把整窗推出屏外（E30）。
            if (*pet).dragged && unsafe { GetCapture() } != hwnd {
                (*pet).dragged = false;
                (*pet).end_drag();
                let docked = (*pet).apply_dock();
                let hide = (*pet).shared.lock().map(|s| s.hide).unwrap_or(false);
                save_pet_pos((*pet).pos, hide, docked);
                (*pet).render_dot();
                pet_log_line(&format!(
                    "[native-pet] drag aborted (capture lost) -> ({},{}) dock={:?}\n",
                    (*pet).pos.0, (*pet).pos.1, docked
                ));
            }
            0
        }
        WM_LBUTTONDBLCLK => {
            // M1.3/D4:窗口类已注册 CS_DBLCLKS,此路径才真正可达(此前双击的第二击
            // 只会再走一次 WM_LBUTTONUP → 再跳一次)。取消挂起的单击去抖;
            // 审批等待或主窗不可见 → 唤起;否则挥手。
            KillTimer(hwnd, IDT_SINGLE_CLICK);
            (*pet).click_pending = false;
            (*pet).swallow_next_up = true;
            let wake = (*pet).effective_waiting() || (*pet).main_needs_wake();
            if wake {
                (*pet).focus_main();
            } else {
                (*pet).do_wave();
            }
            0
        }
        WM_RBUTTONDOWN => {
            // M4.1:右键菜单是交互（peek 静置时钟;探头态下菜单同帧弹回吸附位,菜单全可见）
            (*pet).last_interaction = std::time::Instant::now();
            let mut p = Point { x: 0, y: 0 };
            GetCursorPos(&mut p);
            (*pet).show_menu(p.x, p.y);
            0
        }
        WM_DESTROY => {
            KillTimer(hwnd, IDT_HIT); // R2:光标轮询随窗口一起停
            KillTimer(hwnd, IDT_DRAG); // R13:合帧定时器同理（销毁时可能仍挂着）
            KillTimer(hwnd, IDT_PEEK); // M4.1:peek 边界轮询同理
            KillTimer(hwnd, IDT_FULLSCREEN); // R20-a:全屏覆盖轮询同理
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wp, _lp),
    }
}

/// 悬浮球窗口过程（R18，2026-10-17 起支持拖动）。
///
/// - 左键**抬起**的分流（`WM_LBUTTONUP`）：拖过阈值 ⇒ `end_dot_drag`（球留在新点并落盘）；
///   没拖过 ⇒ `show_self`（恢复桌宠——原语义，只写 `shared.hide`，显隐与落盘由 compose
///   在窗口线程统一执行）；
/// - `WM_LBUTTONDOWN` / `WM_MOUSEMOVE` = 拖动（判据全部照主窗 R16/R17 同款：DOWN 捕获、
///   阈值起手、合帧消费、`WM_CAPTURECHANGED` 兜底，见各分支注释）；
/// - `IDT_HIT` 定时器 = 悬停 / 穿透轮询（R2 范式：命中球面即放大，透明处即穿透）；
/// - `IDT_DOT_DRAG` 定时器 = 拖动合帧消费（8ms，直跟手无弹簧）；
/// - 其余消息交默认处理（`WM_PAINT` 无意义——内容全由 ULW 推送）。
unsafe extern "system" fn dot_proc(hwnd: isize, msg: u32, wp: usize, lp: isize) -> isize {
    let pet = get_pet(hwnd);
    if pet.is_null() {
        return DefWindowProcW(hwnd, msg, wp, lp);
    }
    match msg {
        WM_LBUTTONDOWN => {
            // R18：拖动起点——捕获 + 记按下点。不碰任何主窗状态（球可见时主窗隐藏，
            // 两个 hwnd 不会同时交互；字段仍分立，见 PetWin::dot_press_pt 注释）。
            (*pet).last_interaction = std::time::Instant::now();
            let mut p = Point { x: 0, y: 0 };
            GetCursorPos(&mut p);
            (*pet).dot_press_pt = (p.x, p.y);
            (*pet).dot_dragged = false;
            // R17 同款判据：**只在确实没持有捕获时才捕**。无脑重捕会给本窗口重发
            // `WM_CAPTURECHANGED`（同一窗口重复 SetCapture 的系统行为，主窗 10-13 实测），
            // 而下面的兜底分支以 `dot_dragged` 为判据——自我重发会把刚置上的 true 打回去。
            if unsafe { GetCapture() } != hwnd {
                unsafe { SetCapture(hwnd) };
            }
            0
        }
        WM_MOUSEMOVE => {
            if wp & MK_LBUTTON != 0 {
                let mut p = Point { x: 0, y: 0 };
                GetCursorPos(&mut p);
                let dx = p.x - (*pet).dot_press_pt.0;
                let dy = p.y - (*pet).dot_press_pt.1;
                if (*pet).dot_dragged {
                    // 已在拖动中：增量推进到逻辑目标（纯函数见 `model::advance_drag_target`
                    // ——基准用「上一逻辑目标」而不是窗口实时位置，合帧下不丢位移）
                    if dx != 0 || dy != 0 {
                        (*pet).dot_drag_target = Some(advance_drag_target(
                            (*pet).dot_drag_target,
                            (*pet).pos,
                            (dx, dy),
                        ));
                        (*pet).dot_press_pt = (p.x, p.y);
                    }
                } else if drag_should_start((dx, dy), DOT_DRAG_THRESHOLD) {
                    // 起手：绝对目标 = 当前位置 + 本事件增量（与主窗同口径）
                    (*pet).dot_dragged = true;
                    (*pet).dot_drag_target =
                        Some(((*pet).pos.0 + dx, (*pet).pos.1 + dy));
                    (*pet).dot_press_pt = (p.x, p.y);
                    if !(*pet).dot_dragging_timer_on {
                        (*pet).dot_dragging_timer_on = true;
                        if unsafe { SetTimer(hwnd, IDT_DOT_DRAG, DRAG_COALESCE_MS, 0) } == 0 {
                            pet_log_line(
                                "[native-pet] dot drag: SetTimer(IDT_DOT_DRAG) 失败 —— 本拍不会消费目标\n",
                            );
                        }
                    }
                    pet_log_line(&format!(
                        "[native-pet] dot drag start pos=({},{}) target=({},{})\n",
                        (*pet).pos.0,
                        (*pet).pos.1,
                        (*pet).pos.0 + dx,
                        (*pet).pos.1 + dy
                    ));
                    // R20-b：拎起球的「啵」（松手音在 end_dot_drag 处）
                    (*pet).sfx("grab");
                }
            }
            0
        }
        WM_LBUTTONUP => {
            // R18：**所有出口统一释放捕获**（标签块而非每个 return 前各写一次——
            // 漏一处的后果是球永久持有捕获，整个系统的鼠标消息都归它）。
            'up: {
                if (*pet).dot_dragged {
                    // 拖过 ⇒ 留在新点（落盘），**不**恢复桌宠
                    (*pet).dot_dragged = false;
                    (*pet).end_dot_drag();
                    break 'up;
                }
                // 没拖过 ⇒ 单击恢复（原语义）
                (*pet).show_self();
            }
            unsafe { ReleaseCapture() };
            0
        }
        WM_TIMER => {
            if wp == IDT_HIT {
                (*pet).update_dot_hit();
                0
            } else if wp == IDT_DOT_DRAG {
                (*pet).flush_dot_drag_target();
                0
            } else {
                DefWindowProcW(hwnd, msg, wp, lp)
            }
        }
        WM_CAPTURECHANGED => {
            // R17 同款兜底：`WM_LBUTTONUP` 永不到达（捕获被外部夺走）时唯一的收尾路径。
            // 判据必须同时含 `dot_dragged` 与「捕获真的不在本窗口」——对已持有捕获的窗口
            // 重复 SetCapture 会向同一窗口重发本消息（自我重发），那时 `GetCapture() == hwnd`，
            // 按丢失收尾就是自伤（主窗 10-13 实测：733 次 aborted / 0 次 end）。
            if (*pet).dot_dragged && unsafe { GetCapture() } != hwnd {
                (*pet).dot_dragged = false;
                (*pet).end_dot_drag();
                pet_log_line("[native-pet] dot drag aborted (capture lost)\n");
            }
            0
        }
        WM_DESTROY => {
            KillTimer(hwnd, IDT_HIT); // 命中轮询随本窗口一起停
            KillTimer(hwnd, IDT_DOT_DRAG); // R18:拖动合帧同理（销毁时可能仍挂着）
            0
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

/// L1(v5)：动效相位用的墙钟毫秒。
///
/// 用 `SystemTime` 而非 `Instant` 是刻意的：相位函数（`xform::breath_offset` /
/// `sway_angle`）因此是**只依赖入参**的纯函数，单测无需构造时钟；且这与 v2 起既有
/// 呼吸 bob 的取时方式一致（行为连续，不因引入 L1 而改变相位基准）。
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// P0-F2：本地小时（0–23）——睡眠时段判定（`SLEEP_START_HOUR`–`SLEEP_END_HOUR`）。
/// `GetLocalTime` 失败（不失败——它无返回值）给 12（正午，永不进睡眠段），
/// 失败方向取「不睡」：误睡的代价（深夜桌宠不动）比不睡大。
fn local_hour() -> u32 {
    let mut t = SystemTime::default();
    unsafe {
        GetLocalTime(&mut t);
    }
    if t.hour > 23 {
        12
    } else {
        t.hour as u32
    }
}

/// R5:JSON 字符串字面量——把 key/decision 安全注入 eval 的 JS 片段（防注入）。
fn json_lit(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 把整块预乘缓冲推到悬浮球分层窗口（`UpdateLayeredWindow`，ULW_ALPHA）。
///
/// GDI 绘制不写 alpha，故球面一律手工逐像素合成（`dot::render`）后整块 blit（预乘金）；
/// 窗口位置即 `pos`（与桌宠窗口左上角对齐，M1.4 跟随语义不变）。
fn blit_dot(dot_hwnd: isize, pos: (i32, i32), buf: &[u32]) {
    unsafe {
        let dc = CreateCompatibleDC(0);
        if dc == 0 {
            return;
        }
        let bmi = BmiHeader {
            size: 40,
            width: DOT_SIZE,
            height: -DOT_SIZE,
            planes: 1,
            bit_count: 32,
            compression: 0,
            size_image: 0,
            x_ppm: 0,
            y_ppm: 0,
            clr_used: 0,
            clr_important: 0,
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        let dib = CreateDIBSection(dc, &bmi, DIB_RGB_COLORS, &mut bits, 0, 0);
        if dib == 0 || bits.is_null() {
            DeleteDC(dc);
            return;
        }
        let old = SelectObject(dc, dib);
        std::ptr::copy_nonoverlapping(buf.as_ptr(), bits as *mut u32, buf.len());
        let mut pt = Point { x: pos.0, y: pos.1 };
        let mut sz = Size { cx: DOT_SIZE, cy: DOT_SIZE };
        let mut src = Point { x: 0, y: 0 };
        let blend = BlendFn { blend_op: 1, blend_flags: 0, src_alpha: 255, alpha_format: 1 };
        UpdateLayeredWindow(dot_hwnd, 0, &mut pt, &mut sz, dc, &mut src, 0, &blend, ULW_ALPHA);
        SelectObject(dc, old);
        DeleteObject(dib);
        DeleteDC(dc);
    }
}

/// D3 GDI 兜底:创建持久 present 表面（DC + 32bpp 预乘 DIB）。失败 → None（调用方计数重试）。
///
/// DPI(2026-10-05)：尺寸改为**入参**（物理像素）。此前硬编码 `WIN_W`/`WIN_H`，
/// 而 PMv2 下窗口物理尺寸必须随显示器缩放放大 ⇒ 沿用基准尺寸会在高 DPI 屏上
/// 让 `UpdateLayeredWindow` 拿到「DIB 比窗口小」的组合（画面被截 / 被拉伸）。
/// 判据在 `model::scaled_window_size`（唯一尺寸换算入口）。
fn create_present_surface(w: i32, h: i32) -> Option<(isize, isize, *mut c_void)> {
    unsafe {
        let dc = CreateCompatibleDC(0);
        if dc == 0 {
            return None;
        }
        let bmi = BmiHeader {
            size: 40,
            width: w,
            height: -h,
            planes: 1,
            bit_count: 32,
            compression: 0,
            size_image: 0,
            x_ppm: 0,
            y_ppm: 0,
            clr_used: 0,
            clr_important: 0,
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        let dib = CreateDIBSection(dc, &bmi, DIB_RGB_COLORS, &mut bits, 0, 0);
        if dib != 0 && !bits.is_null() {
            SelectObject(dc, dib);
            Some((dc, dib, bits))
        } else {
            // 铁律#4:dib 创建成功但 bits 空指针(理论不可达)时,先删 DIB 再删 DC,防句柄泄漏
            if dib != 0 {
                DeleteObject(dib);
            }
            DeleteDC(dc);
            None
        }
    }
}

/// D3 GDI 兜底:销毁表面（铁律:恢复→删除顺序由调用方保证；此处 DC 独占 DIB，直接删即可）。
fn destroy_present_surface(dc: isize, dib: isize) {
    unsafe {
        if dib != 0 {
            DeleteObject(dib);
        }
        if dc != 0 {
            DeleteDC(dc);
        }
    }
}

/// DPI(2026-10-05)：取「点所在显示器」的 DPI —— **建窗前**的唯一可用路径。
///
/// **为什么不能直接 `GetDpiForWindow`**：它要 hwnd，而冷启动的尺寸分配
/// （`buf` 的长度、`CreateWindowExW` 的宽高）必须在建窗**之前**就定下来 ⇒ 循环依赖。
/// `MonitorFromPoint`（user32）+ `GetDpiForMonitor`（shcore）不需要 hwnd。
///
/// 实测（`_refs/dpi-probe/pt.rs`，本机 200%）：返回 192，与建窗后的
/// `GetDpiForWindow` 完全一致 ⇒ 两条路径不冲突。
///
/// **回落**：任何一步失败（点不在任何显示器上 / shcore 不可用 / 返回非 S_OK）
/// 一律返回 `DPI_BASE`（96 = 100%），由 `model::dpi_scale` 兜住
/// （它对 `dpi == 0` 回落 1.0，但这里直接给 96 更明确：语义是「按不缩放走」）。
pub(crate) fn dpi_at_point(x: i32, y: i32) -> u32 {
    unsafe {
        let mon = MonitorFromPoint(Point { x, y }, MONITOR_DEFAULTTONEAREST);
        if mon == 0 {
            return DPI_BASE;
        }
        let (mut dx, mut dy) = (0u32, 0u32);
        // S_OK = 0；非 0 说明该 API 在本系统不可用 ⇒ 回落
        if GetDpiForMonitor(mon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) != 0 {
            return DPI_BASE;
        }
        if dx == 0 {
            return DPI_BASE;
        }
        dx
    }
}

pub(crate) fn pet_log_line(line: &str) {
    // a859a（2026-10-20）：**公共写入入口统一转义控制字符**。`pettool=` / `petkey=` /
    // 审批工具名来自页面 hash 或 emit 事件通道，含 CR/LF/ESC 时可伪造额外日志行
    // （CWE-117 形态）。转义在这里收口，所有调用方自动受保护；末尾换行仍作为行终止符保留。
    let safe = super::escape_log_controls(line);
    if let Ok(base) = std::env::var("LOCALAPPDATA") {
        let dir = std::path::Path::new(&base).join("miasaki");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("pet.log")) {
            use std::io::Write;
            let _ = f.write_all(safe.as_bytes());
        }
    }
}

pub(crate) fn create_window(app: AppHandle, shared: Arc<Mutex<PetShared>>, frames: Frames) {
    unsafe {
        // 显式按监视器 DPI 感知（PMv2），保证窗口物理尺寸正确。
        //
        // DPI(2026-10-05)：**返回值此前未检查**。这是进程级一次性设置 ——
        // 一旦进程里已建过窗（WebView2 宿主 / 未来任何 manifest DPI 声明），
        // 本次调用返回 0 且**不生效**，而窗口仍按 PMv2 语义工作（坐标是物理像素）
        // ⇒ 素材不缩放，桌宠只有应有尺寸的一半。故落一行日志，把「声明失败」变成可观测事实。
        // 取证：`_refs/dpi-probe/ab.rs`（A/B/E 三组对照，本机无 manifest 声明 ⇒ 返回 1）。
        if SetProcessDpiAwarenessContext(-4) == 0 {
            pet_log_line(
                "[native-pet] SetProcessDpiAwarenessContext(PMv2) 返回 0：进程已有窗口或已被设过 awareness，本次调用未生效（桌宠尺寸将偏小）\n",
            );
        }
        // M4.1：第四个返回值 = 落盘的停靠边（pet.json `dock` 字段）
        let (x, y, restore_hide, restore_dock) = initial_pet_state();
        // DPI(2026-10-05)：冷启动取一次 DPI（`GetDpiForWindow` 需要 hwnd，故在建窗后补取；
        // 这里先用**光标所在显示器**的默认值建窗与分配缓冲，随后 `apply_dpi` 校准）。
        // 兜底 96 = 100%：取不到时按不缩放走，与「素材 1:1」的历史行为一致（保守）。
        let boot_dpi = dpi_at_point(x + WIN_W / 2, y + WIN_H / 2);
        let (bw, bh) = scaled_window_size(WIN_W, WIN_H, boot_dpi);
        // 悬浮球球面初值 = 当前主题（spawn 时从 prefs.json 载入）→ 隐藏态冷启动第一帧即正确球面
        let theme0 = shared.lock().map(|s| s.theme.clone()).unwrap_or_else(|_| "pure".to_string());
        // P2-a：冷启动加载时的配色预设（frames 已是该配色；之后 compose 每拍
        // 与 shared.settings.color 比对，不一致才重载）
        let color0 = shared.lock().map(|s| s.settings.color).unwrap_or(0);
        // A 批：冷启动加载时的形象（与 spawn 的 load_frames_for 同一入参；
        // 只对 whale 生效，其余主题恒 default）。与 loaded_color 合成加载键。
        let appearance0 = shared
            .lock()
            .map(|s| {
                if s.mode == "whale" {
                    s.settings.appearance.clone()
                } else {
                    super::settings::APPEARANCE_DEFAULT.to_string()
                }
            })
            .unwrap_or_else(|_| super::settings::APPEARANCE_DEFAULT.to_string());
        let mut pet = Box::new(PetWin {
            hwnd: 0,
            dot_hwnd: 0,
            app,
            shared,
            frames,
            buf: vec![0u32; (bw as usize) * (bh as usize)],
            dpi: boot_dpi,
            frame_idx: 0,
            anim_ms: 125,
            last_tick: std::time::Instant::now() - std::time::Duration::from_secs(10),
            action: None,
            click_pending: false,
            swallow_next_up: false,
            done_celebrated: false,
            squash_start: None,
            next_ambient: std::time::Instant::now() + std::time::Duration::from_millis(AMBIENT_FIRST_DELAY_MS),
            alert: None,
            alert_shown_at: std::time::Instant::now(),
            decision_seq: 0,
            last_decision: None,
            press_pt: (0, 0),
            drag_target: None,
            drag_spring_x: None,
            drag_spring_y: None,
            last_drag_tick: std::time::Instant::now(),
            docked_edge: None,
            // M4.1：peek 全 Off 起步（落盘的停靠边在窗口创建后立即恢复并吸附，见下方）
            peek: PeekState::off(),
            dock_base: (x, y),
            last_interaction: std::time::Instant::now(),
            last_peek_tick: std::time::Instant::now(),
            dragging_timer_on: false,
            dragged: false,
            drag_settling: false,
            drag_vel: (0.0, 0.0),
            dot_drag_target: None,
            dot_dragged: false,
            dot_press_pt: (0, 0),
            dot_dragging_timer_on: false,
            pos: (x, y),
            shown: !restore_hide,
        // 冷启动即恢复隐藏态时，悬浮球是否可见取决于托盘档位。
        // 这里独立读一次设置（启动期一次，不在热路径）：`PetShared` 还没被构造完，
        // 拿不到 `self.shared`——而读失败会回默认（`dot`），不会把桌宠弄丢。
        dot_shown: restore_hide
            && super::settings::load_settings().tray != super::settings::TRAY_TRAY,
            next_quote: std::time::Instant::now() + std::time::Duration::from_secs(12),
            next_wander: std::time::Instant::now() + std::time::Duration::from_secs(8),
            present_dc: 0,
            present_dib: 0,
            present_bits: std::ptr::null_mut(),
            ulw_fail_streak: 0,
            surface_fail_streak: 0,
            surface_rebuilds: 0,
            click_through: false,
            ct_switches: 0,
            dot_buf: vec![0u32; (DOT_SIZE * DOT_SIZE) as usize],
            dot_theme: theme0,
            dot_hover: false,
            dot_click_through: false,
            fs_hidden: false,
            last_char_box: (0, 0, 0, 0),
            next_backdrop: std::time::Instant::now(),
            halo: backdrop::HaloState::off(),
            // R20-c（2026-10-19 重做）：轮廓柔光缓冲——空起步，首次启用时按窗分配。
            halo_mask: Vec::new(),
            halo_tmp: Vec::new(),
            halo_blur: Vec::new(),
            last_want_hide: false,
            // P0（2026-10-18）：互动/表演/物理/心情四件的初值。
            // 心情从 0（平常）起；两个检查节拍都错开起手（不与 ambient 首次延迟撞车）。
            petting: Petting::new(std::time::Instant::now()),
            bite_follow: None,
            bite_until: None,
            flying: None,
            mood: 0,
            next_mood_tick: std::time::Instant::now()
                + std::time::Duration::from_millis(MOOD_NEGLECT_EVERY_MS),
            next_sleep_check: std::time::Instant::now()
                + std::time::Duration::from_millis(SLEEP_CHECK_MS),
            // P1-b：表情标记（头顶小符号）+ 瞌睡 Zzz 的浮动节拍
            mark: None,
            next_zzz: std::time::Instant::now()
                + std::time::Duration::from_millis(ZZZ_EVERY_MS),
            // P2-b：睡眠时段缓存（首拍由 30s 检查写入；false = 还没判过）
            sleep_night: false,
            // P0-F2 审查修正：叫醒后的免睡冷却（None = 从未被叫醒过）
            wake_sleep_until: None,
            // P2-a：与 spawn 的加载预设对齐（frames 进来时已是该配色）
            loaded_color: color0,
            // A 批：与 spawn 的加载形象对齐（frames 进来时已是该形象的行/states）
            loaded_appearance: appearance0,
        });
        let pet_ptr = &mut *pet as *mut PetWin;
        let inst = GetModuleHandleW(std::ptr::null());

        let cls = wide("MiasakiPetWin");
        let wc = WndClassW {
            // M1.3/D4:必须注册 CS_DBLCLKS,WM_LBUTTONDBLCLK 才会送达(缺它双击挥手一直是死代码)
            style: CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS,
            lpfn: Some(wnd_proc),
            cb_cls_extra: 0,
            cb_wnd_extra: std::mem::size_of::<isize>() as i32,
            instance: inst,
            icon: 0,
            cursor: 0,
            background: 0,
            menu_name: std::ptr::null(),
            class_name: cls.as_ptr(),
        };
        let _ = RegisterClassW(&wc);

        let dot_cls = wide("MiasakiPetDot");
        let dot_wc = WndClassW {
            lpfn: Some(dot_proc),
            class_name: dot_cls.as_ptr(),
            ..wc
        };
        let _ = RegisterClassW(&dot_wc);

        // R1(2026-09-16):补 WS_EX_NOACTIVATE——点击桌宠不再把前台/键盘焦点夺走
        // （否则用户在原应用的 Ctrl+C/V 会落到桌宠窗口，观感是「整机复制粘贴失效」）。
        // R2 的 WS_EX_TRANSPARENT 不入初始样式：运行时按光标命中动态切换。
        let ex = WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
        let hwnd = CreateWindowExW(
            ex, cls.as_ptr(), cls.as_ptr(), WS_POPUP,
            x, y, bw, bh,
            0, 0, inst, pet_ptr as *mut c_void,
        );
        pet.hwnd = hwnd;
        let dot_hwnd = CreateWindowExW(
            ex, dot_cls.as_ptr(), dot_cls.as_ptr(), WS_POPUP,
            x, y, DOT_SIZE, DOT_SIZE,
            0, 0, inst, pet_ptr as *mut c_void,
        );
        pet.dot_hwnd = dot_hwnd;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, pet_ptr as isize);
        SetWindowLongPtrW(dot_hwnd, GWLP_USERDATA, pet_ptr as isize);
        // M4.1：落盘了停靠边 ⇒ 启动即吸附（persist 已推回吸附位，这里再走一遍 apply_dock
        // 以防绝对兜底路径没找到工作区——它按几何重判边，判不出就清掉，行为安全）
        if restore_dock.is_some() {
            pet.docked_edge = restore_dock;
            pet.apply_dock();
        }
        // 关键:WM_CREATE 期间 USERDATA 尚未设置,wnd_proc 的 SetTimer 不会执行;
        // 在此(USERDATA 就位后)显式启动 33ms 动画定时器
        SetTimer(hwnd, IDT_COMPOSE, 33, 0);
        // R2:透明的光标轮询定时器（独立于 compose；穿透状态下窗口收不到鼠标消息，
        // 只能靠主动轮询恢复可点击判定）
        SetTimer(hwnd, IDT_HIT, HIT_POLL_MS, 0);
        // M4.1:peek 边界检测轮询（静置到期 / 光标压上）——独立低频定时器，
        // 不搭 10ms 的 IDT_HIT（那是两个窗口各挂一份的高频轮询，且 dot 窗也会触发）
        SetTimer(hwnd, IDT_PEEK, PEEK_POLL_MS, 0);
        // R20-a：全屏覆盖轮询（前台真全屏盖住本显示器 ⇒ 规则瞬态隐藏；退出恢复）。
        // 独立低频定时器，判据在 model::foreground_is_fullscreen_cover（纯函数）。
        SetTimer(hwnd, IDT_FULLSCREEN, FULLSCREEN_POLL_MS, 0);
        // 2026-09-24:悬浮球自己的命中轮询（悬停放大 + 透明处穿透）——与主窗同频的独立定时器，
        // 挂在 dot 窗口上，由 dot_proc 消费
        SetTimer(dot_hwnd, IDT_HIT, HIT_POLL_MS, 0);

        // 持久 GDI 表面(创建一次,终身复用;避免高频 CreateDIBSection 触发 gdi32full 崩溃)
        // D3:失败不致命 → present() 低频重试重建（surface_fail_streak 路径）
        // DPI(2026-10-05)：尺寸按 hwnd 所在显示器的 DPI 换算，不写死基准值。
        match create_present_surface(bw, bh) {
            Some((dc, dib, bits)) => {
                pet.present_dc = dc;
                pet.present_dib = dib;
                pet.present_bits = bits;
            }
            None => {
                pet.surface_fail_streak = 1;
                pet_log_line("[native-pet] present surface init failed, retry scheduled\n");
            }
        }

        {
            let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
            GetWindowRect(hwnd, &mut r);
            pet_log_line(&format!("[native-pet] window created at {},{}, {}x{}\n", r.left, r.top, r.right - r.left, r.bottom - r.top));
        }

        pet.render_dot();
        pet.compose();
        pet_log_line("[native-pet] first compose done\n");
        // 启动恢复隐藏状态：主窗隐藏、悬浮球可见；否则仅显示主窗（球留隐藏，等待首次显示切换）
        if restore_hide {
            ShowWindow(dot_hwnd, SW_SHOW);
            pet_log_line("[native-pet] restored hidden state (dot shown)\n");
        } else {
            ShowWindow(hwnd, SW_SHOW);
        }
        std::mem::forget(pet);

        let mut msg = Msg {
            hwnd: 0,
            message: 0,
            wparam: 0,
            lparam: 0,
            time: 0,
            pt: Point { x: 0, y: 0 },
            lprivate: 0,
        };
        while GetMessageW(&mut msg, 0, 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(test)]
mod tests {
    /// R17（2026-10-13 实机障故）：**每一次 `SetCapture` 都必须带「确实没持有捕获」的判据**。
    ///
    /// 为什么这条不能用普通单测表达：它约束的是「系统在什么条件下会重发 `WM_CAPTURECHANGED`」，
    /// 而那是 Win32 的真机行为 —— 探针取证留档 `_refs/pet-capture-probe/`（本机实测）：
    /// 对**已持有捕获**的窗口再次调用 `SetCapture`，系统会向**同一窗口**重发一条
    /// `WM_CAPTURECHANGED`，且收到时 `GetCapture()` **仍是本窗口**（对应 user32 一致性测试
    /// `test_DoubleSetCapture` 的既有行为）。而本窗口过程把该消息当作「捕获被外部夺走」⇒
    /// 起手分支的捕获保险会把该分支刚置上的 `dragged = true` 打回去：**每次起手都自我收尾**，
    /// 拖动完全无法进行（实机 `pet.log`：`drag aborted` **733** 次 / `drag end` **0** 次，
    /// 且 `aborted` 行恒排在对应 `drag start` 行**之前** —— 同步重入的签名），
    /// 收尾里的 `apply_dock` 再把整窗推出屏外 ⇒ 用户体感「点一下就消失」。
    ///
    /// 断言口径：源码里每处 `SetCapture(hwnd)` 的前 240 字符内必须出现判据
    /// `GetCapture() } != hwnd` —— 比「数一数有几个 if」更难被绕过（新增一处无判据的捕获即红）。
    #[test]
    fn every_setcapture_is_guarded_by_getcapture_check() {
        let src = include_str!("window.rs");
        // 只看生产代码：本测试模块自身含有 `SetCapture(` 字面量，不排除会自我命中
        // （本契约第一次运行就是这么红的 —— 留作教训）。
        let src = src.split("#[cfg(test)]").next().expect("源码非空");
        let guard = "GetCapture() } != hwnd";
        // R18：**形态无关**——扫生产代码里每一处 `SetCapture(`（主窗 DOWN / 主窗起手 /
        // 悬浮球 DOWN 共三处，都写窗口过程的 `hwnd` 形参，不写 dot_hwnd）。第一版曾把
        // needle 写死成 `SetCapture(dot_hwnd)`，而 dot_proc 用的是 `hwnd`（与主窗同形）
        // ⇒ 0 命中被自己抓出来：判据要覆盖「将来可能出现的形态」，不是枚举今天的形态。
        let needle = "SetCapture(";
        let mut hits = 0usize;
        for (i, _) in src.match_indices(needle) {
            hits += 1;
            let ctx = &src[i.saturating_sub(240)..i];
            assert!(
                ctx.contains(guard),
                "第 {hits} 处 `{needle}` 之前 240 字符内没有 `{guard}` 判据 —— \
                 无条件重捕会让系统向同一窗口重发 WM_CAPTURECHANGED，\
                 本窗口过程会把它当成「捕获被夺走」⇒ 起手瞬间自我收尾（见本测试注释）"
            );
        }
        assert!(
            hits >= 3,
            "捕获点应至少三处（主窗 DOWN / 主窗起手 / 悬浮球 DOWN），实得 {hits} 处 —— \
             函数被改名/重构时请同步本契约"
        );
    }

    /// R17：`WM_CAPTURECHANGED` 的收尾必须**同时**受 `dragged` 与「捕获真的不在本窗口」约束。
    ///
    /// 缺后者 ⇒ 系统的自我重发被当成捕获丢失（起手即收尾，拖动不可用）；
    /// 缺前者 ⇒ 正常松手路径末尾那句 `ReleaseCapture` 会二次收尾（重复落盘 + 重复吸附，R16 已修）。
    #[test]
    fn capturechanged_settles_only_when_capture_is_really_gone() {
        let src = include_str!("window.rs");
        let body = src
            .split("WM_CAPTURECHANGED => {")
            .nth(1)
            .and_then(|s| s.split("WM_LBUTTONDBLCLK =>").next())
            .expect("找不到 WM_CAPTURECHANGED 分支（分支名或后续分支名变了，请同步本契约）");
        assert!(
            body.contains("(*pet).dragged && unsafe { GetCapture() } != hwnd"),
            "收尾判据必须同时是 `dragged && GetCapture() != hwnd`：\
             只看 dragged 会把系统对「同一窗口重复 SetCapture」的自我重发当成捕获丢失"
        );
    }
    /// R18：`dot_proc` 的 `WM_CAPTURECHANGED` 兜底判据同构（`dot_dragged` + 捕获归属）。
    #[test]
    fn dot_capturechanged_settles_only_when_capture_is_really_gone() {
        let src = include_str!("window.rs");
        let body = src
            .split("unsafe extern \"system\" fn dot_proc")
            .nth(1)
            .and_then(|s| s.split("fn now_ms").next())
            .expect("找不到 dot_proc（函数名变了，请同步本契约）");
        assert!(
            body.contains("(*pet).dot_dragged && unsafe { GetCapture() } != hwnd"),
            "dot_proc 的收尾判据必须同时是 `dot_dragged && GetCapture() != hwnd`\
             （与主窗 R17 同构，理由见 every_setcapture_is_guarded_by_getcapture_check）"
        );
    }

    /// R18：球 `WM_LBUTTONUP` 的**分流契约**——拖过走 `end_dot_drag`（落盘留新点）、
    /// 没拖过走 `show_self`（恢复桌宠，原语义），且所有出口统一 `ReleaseCapture()`
    /// （漏一处的后果是球永久持有捕获，整个系统的鼠标消息都归它）。
    #[test]
    fn dot_up_splits_drag_from_click_and_always_releases_capture() {
        let src = include_str!("window.rs");
        let body = src
            .split("unsafe extern \"system\" fn dot_proc")
            .nth(1)
            .and_then(|s| s.split("fn now_ms").next())
            .expect("找不到 dot_proc");
        let up = body
            .split("WM_LBUTTONUP => {")
            .nth(1)
            .and_then(|s| s.split("WM_TIMER => {").next())
            .expect("找不到 dot_proc 的 WM_LBUTTONUP 分支");
        assert!(up.contains("(*pet).dot_dragged"), "UP 必须先看是否拖过阈值");
        assert!(up.contains("(*pet).end_dot_drag()"), "拖过 ⇒ 落盘留在新点");
        assert!(up.contains("(*pet).show_self()"), "没拖过 ⇒ 恢复桌宠（原语义）");
        assert!(up.contains("ReleaseCapture()"), "UP 的所有出口必须统一释放捕获");
    }

    /// R18：球拖动必须有出屏兜底与持久化（`end_dot_drag`）——球是隐藏态唯一入口，
    /// 出屏 = 用户弄不回来（主窗还有托盘/面板兜底，球没有）。
    #[test]
    fn dot_drag_end_persists_and_never_leaves_the_ball_offscreen() {
        let src = include_str!("window.rs");
        let body = src
            .split("fn end_dot_drag")
            .nth(1)
            .and_then(|s| s.split("\n    fn ").next())
            .expect("end_dot_drag 函数体解析失败");
        assert!(body.contains("ball_pos_visible"), "必须有出屏判据（球心在工作区内）");
        assert!(body.contains("default_pos()"), "出屏 ⇒ 回默认位");
        assert!(body.contains("save_pet_pos"), "收尾必须落盘（否则重启位置丢）");
    }

    /// R19（2026-10-17 续，用户报「拖拽还是有点粘滞」）：拖动期内必须**直跟手**
    /// （窗口位置 = 最新目标），不得再走弹簧尾随；松手后由 `drag_settle_tick` 当拍收尾。
    /// 判据用源码契约（该分支依赖 hwnd，纯函数测不了）：直跟手分支必须存在、必须直接
    /// MoveWindow 到 target，且必须排在「弹簧到位早退」**之前**（否则弹簧同步后会被早退吞掉）。
    #[test]
    fn drag_follows_cursor_directly_without_spring_lag() {
        let src = include_str!("window.rs");
        let body = src
            .split("fn flush_drag_target")
            .nth(1)
            .and_then(|s| s.split("fn end_drag").next())
            .expect("找不到 flush_drag_target（函数名变了，请同步本契约）");
        let follow = body
            .find("if self.dragged && !self.drag_settling")
            .expect("缺少拖动直跟手分支：会退回 M4 弹簧尾随（稳态滞后 2ζ/ω·v，用户报粘滞）");
        assert!(
            body.contains("MoveWindow(self.hwnd, target.0, target.1"),
            "直跟手分支必须把窗口直接移到最新目标"
        );
        let spring_early_exit = body
            .find("if spring_at_target(sx, target.0 as f32)")
            .expect("找不到弹簧到位早退（结构变了，请同步本契约）");
        assert!(
            follow < spring_early_exit,
            "直跟手分支必须排在弹簧早退之前，否则位置同步会被早退吞掉"
        );
    }

    /* ---------------- P0（2026-10-18）源码契约 ---------------- */

    /// P0-F1：`IDT_HIT` 拍必须同时驱动摸头判定与咬合跟随；咬合必须**跟手移动**
    /// （MoveWindow 到「光标 − 咬合偏移」）且收尾落盘（finish_bite 内含 save_pet_pos）。
    /// 为什么用源码契约：这些分支的入参是 hwnd / 光标，纯函数测不了，而
    /// 「咬合不跟手」= 彩蛋退化成「抖一下」，功能测试一条都抓不到。
    #[test]
    fn petting_and_bite_follows_cursor_and_persists_on_release() {
        let src = include_str!("window.rs");
        // IDT_HIT 分支确实调了它（接在 update_click_through 后面）
        let timer = src
            .split("WM_TIMER => {")
            .nth(1)
            .and_then(|s| s.split("WM_LBUTTONDOWN => {").next())
            .expect("找不到 WM_TIMER 分支");
        assert!(
            timer.contains("(*pet).petting_and_bite_tick()"),
            "IDT_HIT 拍必须驱动摸头/咬手（搭 R2 的 10ms 轮询，不新开定时器）"
        );
        let body = src
            .split("fn petting_and_bite_tick")
            .nth(1)
            .and_then(|s| s.split("fn finish_bite").next())
            .expect("找不到 petting_and_bite_tick");
        assert!(body.contains("MoveWindow(self.hwnd, target.0, target.1"),
            "咬合期间窗口必须跟随光标（咬着的手跑到哪它跟到哪）");
        assert!(body.contains("self.finish_bite()"), "咬合到期必须松口收尾");
        let finish = src
            .split("fn finish_bite")
            .nth(1)
            .and_then(|s| s.split("\n    fn ").next())
            .expect("找不到 finish_bite");
        assert!(finish.contains("save_pet_pos"),
            "咬合结束 = 迷你拖动收尾：位置被光标带走了，必须落盘（否则重启回旧位）");
    }

    /// P0-F3：`release_drag` 必须按**松手速度**分流：速度门（`throw_triggered`）命中
    /// 进抛掷飞行，慢放仍走 R18 滑停（行为零变化）。缺速度门 ⇒ 每次松手都飞；缺滑停
    /// 分支 ⇒ 快速甩动后前跳回归（R18 修过的缺陷复活）。**判定本身是纯函数**
    /// （`model::throw_triggered`，单测在 model.rs）——源码契约只钉「窗口层确实调它」。
    #[test]
    fn release_drag_splits_throw_from_settle_by_speed() {
        let src = include_str!("window.rs");
        let body = src
            .split("fn release_drag")
            .nth(1)
            .and_then(|s| s.split("fn finish_drag_settle").next())
            .expect("找不到 release_drag");
        assert!(body.contains("throw_triggered(self.drag_vel)"), "必须调用速度门纯函数");
        assert!(body.contains("FlyState {"), "速度够 ⇒ 构造飞行状态");
        assert!(body.contains("self.drag_settling = true"),
            "速度不够 ⇒ 仍走 R18 滑停（不得回归前跳）");
        // 顺序：抛掷判定必须排在滑停之前（反之永远进不了飞行）
        let throw_at = body.find("throw_triggered(self.drag_vel)").unwrap();
        let settle_at = body.find("self.drag_settling = true").unwrap();
        assert!(throw_at < settle_at, "抛掷判定必须排在滑停分支之前");
    }

    /// P0-F1/F2：`WM_LBUTTONDOWN` 必须①把咬合中的桌宠松口、②把 Emote 加进打断清单
    /// （点一下 = 「别演了」：睡觉叫醒、跳舞叫停）。漏②的后果：点击后睡眠/跳舞槽继续
    /// 到期自播，用户看到「点了没反应」——而单击的 jump 会被它压住（动作槽单槽互斥）。
    #[test]
    fn button_down_releases_bite_and_interrupts_emote() {
        let src = include_str!("window.rs");
        let down = src
            .split("WM_LBUTTONDOWN => {")
            .nth(1)
            .and_then(|s| s.split("WM_MOUSEMOVE => {").next())
            .expect("找不到 WM_LBUTTONDOWN 分支");
        assert!(down.contains("(*pet).finish_bite()"), "咬着时按下 = 松口收尾");
        assert!(
            down.contains("Action::Emote { .. }"),
            "interrupt 清单必须含 Emote（点击叫醒睡眠/叫停跳舞）"
        );
    }

    /// P0-F3：飞行是**位移源**——wander 守卫与点击穿透早退都必须把它和
    /// dragged/drag_settling 并列闸住。漏一处 = 飞行中桌宠自己横向走（位移源互斥破坏，
    /// R16/R18 同族纪律）或高速移动中穿透态抽变（「伸手接住它」变成抽奖）。
    #[test]
    fn flying_gates_both_wander_and_click_through() {
        let src = include_str!("window.rs");
        let compose = src
            .split("fn compose")
            .nth(1)
            .and_then(|s| s.split("fn backdrop_tick").next())
            .expect("找不到 compose");
        assert!(compose.contains("self.flying.is_none()"),
            "wander 触发必须闸飞行（位移源互斥）");
        let ct = src
            .split("fn update_click_through")
            .nth(1)
            .and_then(|s| s.split("fn set_click_through").next())
            .expect("找不到 update_click_through");
        assert!(ct.contains("self.flying.is_some()"),
            "飞行期点击穿透必须早退（窗口在动，切穿透会让接住它变成抽奖）");
    }

    /// P0-F2：两个绘制分支（三态立绘 / 图集）都必须消费 emote_xform 并下传 flip——
    /// 漏一个分支 = 该主题（inverse 或 whale/kurumi）的表演全部静默失效，
    /// 而「动作没接上」在功能测试里不可见（姿态仍是对的 idle）。
    #[test]
    fn emote_is_consumed_in_both_draw_branches() {
        // 先剥掉测试段：否则本测试自己的字面量会被 include_str! 数进去
        // （首版就踩了这个——计数 3 = 生产 2 + 测试 1）
        let src = include_str!("window.rs");
        let src = src.split("#[cfg(test)]").next().expect("源码非空");
        let n = src.matches("emote_xform(k, p, t_ms, motion)").count();
        assert_eq!(n, 2, "两个绘制分支各消费一次 emote_xform，实得 {n} 处");
        let flip_calls = src.matches("&xf, flip)").count();
        assert_eq!(flip_calls, 3, "三处 blit_center_bottom 调用都要带 flip（立绘×2 + 图集×1），实得 {flip_calls}");
        assert!(src.contains("matches!(emote, Some((EmoteKind::Turn, p)) if p >= 0.5)"),
            "Turn 的镜像翻转必须锚在中点（p ≥ 0.5）");
    }

    /* ---------------- P2-a · 配色重着色源码契约 ---------------- */

    /// P2-a-1：compose 必须有配色变更检测（`want_color != loaded_color` ⇒ 重载），
    /// 且重载后**强制重绘**（`last_tick` 回拨）——否则新配色的第一帧要等下一拍
    /// 动画节拍才上场，用户看到「改了设置宠物顿一下才变色」。
    /// 判据用源码契约：该分支依赖 shared 锁与整份重载，纯函数测不了；
    /// 但「重载入口在不在、强制重绘在不在」是结构事实，文本可锚。
    /// A 批：加载键从单 color 扩为 (color, appearance)——本测试同步锚 appearance 半边。
    #[test]
    fn compose_reloads_frames_on_color_change() {
        let src = include_str!("window.rs");
        let src = src.split("#[cfg(test)]").next().expect("源码非空");
        assert!(src.contains("let (want_hide, do_reset, want_theme, want_color, want_appearance)"),
            "compose 的 shared 消费块必须取 want_color 与 want_appearance（漏了它 = 设置永远不生效）");
        assert!(src.contains("let color_changed = want_color != self.loaded_color;"),
            "必须有配色变更检测（每拍一次整数比对，零开销）");
        assert!(src.contains("super::image::load_frames_for(want_color, &want_appearance)"),
            "变更必须整份重载 + 重着色 + 形象烘焙（重新走 assets::read，磁盘覆盖层语义不变）");
        let at = src.find("let color_changed = want_color != self.loaded_color;").unwrap();
        let block = &src[at..at + 700];
        assert!(block.contains("self.last_tick = now - std::time::Duration::from_secs(10)"),
            "重载后必须强制重绘（否则第一帧延迟到下一动画节拍）");
        assert!(block.contains("self.loaded_color = want_color"),
            "重载后必须对齐 loaded_color（否则每拍都重载 = 桌面卡死）");
    }

    /// A 批-1：形象变更检测与对齐——`appearance_changed` 判据、`loaded_appearance`
    /// 对齐、以及**只对 whale 生效**的 mode 门控，三者都是结构事实，文本可锚。
    /// 漏对齐 = 每拍重载（桌面卡死）；漏 mode 门控 = kurumi/inverse 被换成 whale 形象。
    #[test]
    fn compose_reloads_frames_on_appearance_change() {
        let src = include_str!("window.rs");
        let src = src.split("#[cfg(test)]").next().expect("源码非空");
        assert!(src.contains("let appearance_changed = want_appearance != self.loaded_appearance;"),
            "必须有形象变更检测（与配色并列的一个加载键）");
        assert!(src.contains("if color_changed || appearance_changed"),
            "配色或形象任一变化都要重载");
        assert!(src.contains("self.loaded_appearance = want_appearance.clone();"),
            "重载后必须对齐 loaded_appearance（否则每拍都重载 = 桌面卡死）");
        // mode 门控：非 whale 时 appearance 恒 default（角色设定不换装）
        assert!(src.contains("if s.mode == \"whale\""),
            "形象只对 whale 生效——mode 门控漏不得（与 P2-a 配色同口径）");
        assert!(src.contains("super::settings::APPEARANCE_DEFAULT.to_string()"),
            "非 whale 分支必须回落 APPEARANCE_DEFAULT");
    }

    /// A 批-2：ambient 选行必须带可用性过滤（形象缺的行不上场——P1-a 空转槽纪律推广）。
    /// 只锚「闭包存在且传进 pick_ambient_choice」：过滤语义本身由 model.rs 单测管。
    #[test]
    fn ambient_choice_filters_by_available_rows() {
        let src = include_str!("window.rs");
        let src = src.split("#[cfg(test)]").next().expect("源码非空");
        assert!(src.contains("let has = |row: &str| self.frames.rows_have(&mode, row);"),
            "ambient 块必须构造可用性闭包（当前生效行集）");
        assert!(src.contains("pick_ambient_choice(band, &mode, time, &has)"),
            "可用性闭包必须传进 pick_ambient_choice（第四入参）");
    }

    /* ---------------- P1-b · 表情标记源码契约 ---------------- */
    /// P1-b-1：标记必须在**气泡之后**画（在气泡之上、角色头顶）且每拍做过期清理——
    /// 画在气泡前会被气泡盖住；不清字段则头顶永久挂符号（「到期即清」铁律）。
    #[test]
    fn mark_is_drawn_after_bubble_and_expires() {
        let src = include_str!("window.rs");
        let src = src.split("#[cfg(test)]").next().expect("源码非空");
        let bubble_at = src.find("self.blit_bubble(frame);").expect("找不到气泡绘制");
        let mark_at = src.find("self.blit_mark(now);").expect("找不到标记绘制");
        assert!(mark_at > bubble_at, "标记必须画在气泡之后（否则被气泡盖住）");
        assert!(src.contains("m.expired(now)"),
            "compose 必须每拍清理过期标记（否则头顶永久挂符号）");
        // 定位复用角色框（不新算几何）——halo 的 last_char_box 是唯一基准
        assert!(src.contains("let (bx, by, bw, _bh) = self.last_char_box;"),
            "标记定位必须复用 last_char_box（与 halo 同基准，不新算几何）");
    }

    /// P1-b-2：触发映射必须在事件点上，且必须走**纯函数 seam**
    /// （`mark_for_pet_event` / `mark_for_alert_priority` / `mark_for_done`）——
    /// 直接 `show_mark(Mark::Heart)` 内联的写法契约查不到「被注掉」，
    /// 映射纯函数化后「谁配谁」有单测、「调用在不在」有本契约。
    /// 漏一处的表现是「那个事件没表情」，而姿态/音效照旧——功能测试抓不到。
    #[test]
    fn mark_triggers_are_wired_at_event_points() {
        let src = include_str!("window.rs");
        let src = src.split("#[cfg(test)]").next().expect("源码非空");
        let pet = src.split("fn petting_and_bite_tick").nth(1)
            .and_then(|s| s.split("fn finish_bite").next()).expect("找不到 petting_and_bite_tick");
        assert!(pet.contains("mark_for_pet_event(ev)"),
            "互动事件必须走 mark_for_pet_event 纯函数（内联映射不可单测）");
        assert!(pet.contains("show_mark(kind, now)"), "摸头/咬手分支必须挂标记");
        let done = src.split("self.done_celebrated = true;").nth(1)
            .and_then(|s| s.split("dirty = true;").next()).expect("找不到 Done 庆祝块");
        assert!(done.contains("mark_for_done()"), "完成庆祝必须走 mark_for_done 纯函数");
        let alerts = src.split("if let Some(next) = apply {").nth(1)
            .and_then(|s| s.split("self.alert = next;").next()).expect("找不到 alert 应用块");
        assert!(alerts.contains("mark_for_alert_priority(a.priority)"),
            "审批/告警必须走 mark_for_alert_priority 纯函数");
    }

    /* ---------------- P2-b · 表情帧源码契约 ---------------- */

    /// P2-b-1：`show_mark` 必须按主题分流——whale 演 `ex*` 表情帧（Ambient 槽），
    /// 其余主题落符号；且表情路径必须**判当前模式**（frames 是全量加载的，
    /// 不判模式会让 kurumi/inverse 播鲸鱼的表情帧——串味）。
    /// 表情帧与符号二选一（播了表情就收掉符号，避免重复表达）。
    #[test]
    fn show_mark_routes_expression_frames_to_whale_only() {
        let src = include_str!("window.rs");
        let src = src.split("#[cfg(test)]").next().expect("源码非空");
        let body = src.split("fn show_mark").nth(1)
            .and_then(|s| s.split("\n    fn ").next()).expect("找不到 show_mark");
        assert!(body.contains("expression_row_for(kind)"), "必须查情绪 → 表情帧行映射");
        assert!(body.contains("mode == \"whale\""),
            "表情路径必须判当前模式（不判 = 三主题串味）");
        assert!(body.contains("Action::Ambient { row: row.to_string() }"),
            "whale 表情走 Ambient 槽（继承到期即清与六态压制）");
        assert!(body.contains("self.mark = None;"),
            "播了表情必须收掉符号（避免「脸上有表情、头顶还飘符号」）");
    }

    /// P2-b-2：表情反应必须在**姿态之后**触发（match 之后调 show_mark）——
    /// 反序则 whale 的表情帧会被随后的 Nod/Shiver 姿态槽覆盖（单槽互斥），
    /// 表现是「摸了有表情帧但一闪而过」。
    #[test]
    fn petting_reaction_fires_after_the_pose_slot() {
        let src = include_str!("window.rs");
        let src = src.split("#[cfg(test)]").next().expect("源码非空");
        let pet = src.split("fn petting_and_bite_tick").nth(1)
            .and_then(|s| s.split("fn finish_bite").next()).expect("找不到 petting_and_bite_tick");
        let pose = pet.find("Action::Emote { kind: EmoteKind::Nod").expect("找不到摸头姿态");
        let react = pet.find("mark_for_pet_event(ev)").expect("找不到表情反应调用");
        assert!(react > pose, "表情反应必须排在姿态槽之后（否则被 Nod 覆盖）");
    }

    /// P2-b-3：瞌睡的两条新契约——① 入睡演 **Sleepy 表情**（不是 Zzz 符号：
    /// 犯困脸是「去睡了」的面部信号，Zzz 符号留给周期性浮动）；② 演完必须
    /// **续觉**（`sleep_night && action.is_none()` ⇒ 补回 Sleep 慢呼吸槽）——
    /// 表情帧走 Ambient 槽会把 Sleep 换掉，不补则「犯困脸闪一下就精神了」。
    #[test]
    fn sleep_plays_drowsy_face_then_rearms_slow_breath() {
        let src = include_str!("window.rs");
        let src = src.split("#[cfg(test)]").next().expect("源码非空");
        let onset = src.split("self.sfx(\"yawn\");").nth(1)
            .and_then(|s| s.split("pet_log_line").next()).expect("找不到入睡块");
        assert!(onset.contains("show_mark(Mark::Sleepy, now)"),
            "入睡必须演犯困表情帧（whale；Zzz 符号只做周期性浮动）");
        assert!(onset.contains("self.sleep_night = true"), "入睡必须置位夜间缓存");
        assert!(src.contains("if self.sleep_night"),
            "必须有瞌睡续觉钩子（表情演完补回 Sleep 槽）");
        let hook = src.split("// —— P2-b：瞌睡续觉（每拍）——").nth(1)
            .and_then(|s| s.split("// —— 待机随机行为").next()).expect("找不到续觉钩子");
        assert!(hook.contains("Action::Emote { kind: EmoteKind::Sleep }"),
            "续觉钩子必须补回 Sleep 慢呼吸槽");
        assert!(hook.contains("self.action.is_none()"),
            "只在动作槽空时补（不抢正在演的表情/其他动作）");
        // 醒来必须清缓存（否则早晨钩子还在补觉）
        assert!(src.contains("self.sleep_night = false"), "早晨醒来必须清夜间缓存");
    }

    /// P2-b-4：两个新触发点必须接线——① 双击挥手 ⇒ 害羞（`do_wave` 里
    /// `show_mark(Mark::Shy)`）；② 散步撞墙 ⇒ 疑惑（Look 姿态之后
    /// `show_mark(Mark::Doubt)`）。漏一处的表现是「那个互动没有表情」，
    /// 而姿态/音效照旧——功能测试抓不到（P0/P1 同款纪律的第三次实例）。
    #[test]
    fn shy_and_doubt_triggers_are_wired() {
        let src = include_str!("window.rs");
        let src = src.split("#[cfg(test)]").next().expect("源码非空");
        let wave = src.split("fn do_wave").nth(1)
            .and_then(|s| s.split("fn main_needs_wake").next()).expect("找不到 do_wave");
        assert!(wave.contains("show_mark(Mark::Shy"),
            "双击挥手必须挂害羞表情（她被你逗羞了）");
        let bump = src.split("Action::Emote { kind: EmoteKind::Look }").nth(1)
            .and_then(|s| s.split("self.frame_idx = 0;").nth(1)) // frame_idx 之后才是反应
            // 取后续若干**行**（不用字节切片——中文注释 3 字节/字，按字节切会切在
            // UTF-8 字符中间直接 panic）
            .map(|s| s.lines().take(8).collect::<Vec<_>>().join("\n"))
            .expect("找不到撞墙 Look 块");
        assert!(bump.contains("show_mark(Mark::Doubt"),
            "撞墙必须挂疑惑表情（问号脸）");
    }
}
