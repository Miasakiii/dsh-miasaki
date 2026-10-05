//! 桌宠窗口：PetWin compose/交互 + 窗口过程 + 启动（D2 拆分）
use std::os::raw::c_void;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use super::config::*;
use super::dot;
use super::ffi::*;
use super::image::*;
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
}
impl PetWin {
    fn compose(&mut self) {
        static TICKS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let tick = TICKS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let now = std::time::Instant::now();
        let mut dirty = false;

        // —— 外部命令消费（设置面板 hash 通道 → shared 标志；UI 仅在窗口线程执行）——
        {
            let (want_hide, do_reset, want_theme) = {
                let mut s = self.shared.lock().unwrap();
                let h = s.hide;
                let r = s.pending_reset;
                let t = s.theme.clone();
                s.pending_reset = false;
                (h, r, t)
            };
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
            if want_hide == self.shown {
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
            if can_walk && !blocked && self.docked_edge.is_none() {
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
        if self.action.is_none() && now >= self.next_ambient {
            let idle_intensity = {
                let s = self.shared.lock().unwrap();
                s.intensity == "idle"
            };
            // M2(v3):非 Idle 六态(含 fleet_running)不开小动作(触发必能播,不挂空槽)
            let blocked = state != PetState::Idle || fleet_running;
            if idle_intensity && !blocked && self.alert.is_none() {
                let row = pick_ambient_row();
                self.action = Some(ActionSlot {
                    action: Action::Ambient { row },
                    started: now,
                    duration: std::time::Duration::from_millis(
                        rand_range(AMBIENT_PLAY_MIN_MS, AMBIENT_PLAY_MIN_MS + AMBIENT_PLAY_VAR_MS),
                    ),
                });
                self.frame_idx = 0;
                dirty = true;
            }
            self.next_ambient = now + std::time::Duration::from_millis(
                rand_range(AMBIENT_REST_MIN_MS, AMBIENT_REST_MIN_MS + AMBIENT_REST_VAR_MS),
            );
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
                }
            }
            // 清空画布只在帧更新时进行,避免 33ms 心跳把中间帧清成空白
            for p in self.buf.iter_mut() {
                *p = 0;
            }
            let (mode, intensity, fleet_running, motion) = {
                let s = self.shared.lock().unwrap();
                (s.mode.clone(), s.intensity.clone(), s.fleet_running, s.settings.motion)
            };
            // —— L1(v5,2026-09-28)：本帧动效值（design/pet-v5-motion-plan.md §3）——
            // **单值来源**：整帧只算一次，行集分支与三态立绘分支共用同一份 ⇒ 绘制与命中天然一致
            // （`is_transparent_at` 查的就是本段写出的 `buf`，无需任何配套改动；订正说明见 xform.rs 头部）。
            // 相位函数都是纯函数（入参只有毫秒数），此处只负责取时刻与推进脉冲状态。
            let t_ms = now_ms();
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
            // 挤压期间**必须**关摇摆：`sx = 1.10` 与 ±2° 叠加会让包围盒横向越出 `WIN_W`
            // （xform.rs 的 `squash_plus_sway_would_overflow_so_is_forbidden` 钉住了这件事）。
            // 语义上也自洽：脉冲是「压扁—弹回」的纵向动效，此刻不摆。
            let can_sway = squash_p.is_none();
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
                    let bob = breath_offset(t_ms, BREATH_PX_STATES, motion);
                    // L1(v5) M2：摇摆给 idle / work —— inverse 因此第一次真正「活起来」。
                    // deep 档**只呼吸不摇摆**：那是深度推理档，取「凝神」语义，与 whale deep
                    // 保留立绘覆盖同一取舍（强度档优先表达档位，不再叠姿态噪声）。
                    let sway = if can_sway && matches!(key, "idle" | "work") {
                        sway_angle(t_ms, motion)
                    } else {
                        0.0
                    };
                    let xf = DrawXform::new(sway, sq_sx, sq_sy);
                    if list.len() > 1 {
                        // v2:帧序列状态(idle.gif 拆帧),6fps 循环 + bob
                        self.anim_ms = 1000 / 6;
                        let idx = self.frame_idx % list.len();
                        self.frame_idx += 1;
                        self.blit_center_bottom(&list[idx], bob, 1.0, &xf);
                    } else if let Some(img) = list.first() {
                        // 单帧:静态 + bob + 摇摆
                        self.anim_ms = 1000;
                        self.blit_center_bottom(img, bob, 1.0, &xf);
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
                    let bob = if calm { breath_offset(t_ms, BREATH_PX_ROW, motion) } else { 0.0 };
                    // L1(v5) M2：摇摆给 idle（长静置）与 run（打字时轻微起伏）；
                    // 其余是限时动作/事件帧（jump/wave/failed/wait/runRight/runLeft），
                    // 帧内自带位移，再叠旋转会与动作打架，故不接。
                    let sway = if can_sway && calm && matches!(row.as_str(), "idle" | "run") {
                        sway_angle(t_ms, motion)
                    } else {
                        0.0
                    };
                    let xf = DrawXform::new(sway, sq_sx, sq_sy);
                    self.blit_center_bottom(&list[idx % list.len()], bob, 1.0, &xf);
                }
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
            dirty = true;
        }
        // 气泡:超时检查每 tick;绘制只在帧更新后(避免每 33ms 图像合成)
        // R4:常驻项(sticky)不参与超时,须被更高优先级抢占或按 id 移除;
        //     限时项(定时台词/单击反馈)到期即清——取代原先「状态帧不参与 3s 过期」的散列判定。
        if self.alert.as_ref().map(|a| a.expired(now)).unwrap_or(false) {
            self.alert = None;
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
    fn blit_center_bottom(&mut self, img: &Image, bob: f32, scale: f32, xf: &DrawXform) {
        // DPI(2026-10-05)：以下几何全部走**物理像素**口径（`pw`/`ph`/`dpr`），
        // 素材绘制高度 = `CELL_H × scale × dpr`。此前硬编码 `WIN_W`/`CELL_H`
        // ⇒ 200% 下素材只有窗口面积的 1/4（窗放大 2× 而素材没放大）。
        let (pw, ph) = self.win_size();
        let dpr = dpi_scale(self.dpi);
        let cell_h = (CELL_H as f32 * dpr).round() as i32;
        let h = (cell_h as f32 * scale) as i32;
        let w = (img.w as f32 / img.h as f32 * h as f32) as i32;
        if w <= 0 || h <= 0 {
            return;
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
                // sx = (x + 0.5) * src.w / w - 0.5（`ux` 已含 +0.5）
                let sxf = ux * (src_w as f32) / fw - 0.5;
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
    fn is_transparent_at(&self, x: i32, y: i32) -> bool {
        // 2026-09-29：用户选「总是可点」⇒ **恒不穿透**，整个窗口矩形都接住鼠标。
        // 放在越界判断**之前**是刻意的：这是**策略**层（要不要参与命中），不是几何层
        // （这点是不是图像）。判据只有一处，主窗与悬浮球共用本函数 ⇒ 两处行为天然一致。
        if self.through_disabled() {
            return false;
        }
        // DPI：`buf` 是物理尺寸缓冲 ⇒ 越界判断与索引步长必须同口径。
        let (pw, ph) = self.win_size();
        if x < 0 || y < 0 || x >= pw || y >= ph {
            return true;
        }
        let a = (self.buf[(y * pw + x) as usize] >> 24) & 0xFF;
        a < CLICK_THROUGH_ALPHA
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

    /// R2:按光标位置切换 `WS_EX_TRANSPARENT`（由 10ms 轮询定时器驱动）。
    /// **必须轮询**：一旦置位穿透，本窗口收不到鼠标消息，「何时恢复可点击」无从由事件得知。
    /// 规则：隐藏 / 拖拽中恒不穿透（保证跟手与恢复入口可用），其余按命中结果切换。
    fn update_click_through(&mut self) {
        if !self.shown || self.dragged {
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
    fn update_dot_hit(&mut self) {
        if self.shown {
            self.set_dot_click_through(false);
            self.dot_hover = false; // 球不可见：清态即可，不必重绘
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
        // 已有目标且弹簧已到位 ⇒ 本拍不动（省一次 MoveWindow）。
        if let (Some(sx), Some(sy)) = (self.drag_spring_x, self.drag_spring_y) {
            if spring_at_target(sx, target.0 as f32) && spring_at_target(sy, target.1 as f32) {
                return false;
            }
        }
        let dt = self.last_drag_tick.elapsed().as_millis().min(100) as u32;
        self.last_drag_tick = std::time::Instant::now();
        let sx = spring_step(self.drag_spring_x.unwrap(), target.0 as f32, dt);
        let sy = spring_step(self.drag_spring_y.unwrap(), target.1 as f32, dt);
        // 取整后再夹回 i32：f32 → i32 的 `as` 是截断，负坐标下会差 1px（长期累积成位置漂移）。
        let nx = sx.pos.round() as i32;
        let ny = sy.pos.round() as i32;
        self.drag_spring_x = Some(sx);
        self.drag_spring_y = Some(sy);
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
    fn end_drag(&mut self) {
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
                return None;
            }
        };
        // 推出：以**窗口位置**为基准（`dock_push_out` 内部把 role 的偏移换算回窗口位移）
        self.docked_edge = Some(edge);
        if let Some((nx, ny)) = dock_push_out(self.pos, local, work, edge, self.dock_margin()) {
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
            let s4 = enc("退出应用");
            AppendMenuW(m, MF_STRING, MENU_SHOW, s1.as_ptr());
            AppendMenuW(m, MF_STRING, MENU_HIDE, s2.as_ptr());
            AppendMenuW(m, MF_STRING, MENU_MIN, s3.as_ptr());
            AppendMenuW(m, MF_STRING, MENU_EXIT, s4.as_ptr());
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
                0
            } else if wp == IDT_DRAG {
                // R13:拖动合帧——8ms 消费最新目标。**同一节拍内无新目标时不 MoveWindow**
                // （这正是合帧省下来的开销）；也据此重画，避免无谓的 present。
                if (*pet).flush_drag_target() {
                    (*pet).render_dot();
                }
                0
            } else if wp == IDT_PEEK {
                // M4.1:peek 边界检测（静置到期 / 光标压上）；动画推进在 compose 节拍
                (*pet).peek_poll();
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
            // v2:指针按下即打断环境编排/挥手/散步(拖拽与动作互斥);跳跃保留不打折反馈
            let interrupt = matches!(
                &(*pet).action,
                Some(s) if matches!(
                    s.action,
                    Action::Ambient { .. } | Action::Wave | Action::Wander { .. }
                )
            );
            if interrupt {
                (*pet).action = None;
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
                } else if dx.abs() + dy.abs() > 4 {
                    // —— 阈值判定为「开始拖动」（沿用既有 `DRAG_THRESHOLD` 口径）
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
                    if !(*pet).dragging_timer_on {
                        (*pet).dragging_timer_on = true;
                        SetTimer(hwnd, IDT_DRAG, DRAG_COALESCE_MS, 0);
                    }
                }
            }
            0
        }
        WM_LBUTTONUP => {
            // M1.3:双击序列的第二次 UP 直接吞掉(DBLCLK 已处理,防「挥一次+跳一次」)
            if (*pet).swallow_next_up {
                (*pet).swallow_next_up = false;
                return 0;
            }
            // R5:审批按钮命中优先于拖动/单击语义——这次点击是「决策」，不是「撸一下」。
            // （命中区判定在角色本体范围内，故不会与透明穿透冲突：能点到就说明窗口可点。）
            if !(*pet).dragged {
                let mut pt = Point { x: 0, y: 0 };
                GetCursorPos(&mut pt);
                if let Some(allow) = (*pet).approval_hit(pt.x - (*pet).pos.0, pt.y - (*pet).pos.1) {
                    (*pet).decide_approval(allow);
                    return 0;
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
                return 0;
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
                // R13：**先 flush 再落盘**。顺序有讲究——`save_pet_pos` 读的是 `(*pet).pos`，
                // 若此时目标还压在 `drag_target` 里，落盘的就是上一拍的位置（松手漂移）。
                (*pet).end_drag();
                // M4.1：松手时判定边缘停靠并推出。**在落盘之前**做——落盘要记的是吸附后的位置。
                let docked = (*pet).apply_dock();
                let hide = (*pet).shared.lock().map(|s| s.hide).unwrap_or(false);
                save_pet_pos((*pet).pos, hide, docked);
                // M1.4:拖动结束同步悬浮球(隐藏后恢复入口与桌宠位置不脱节,D6)
                (*pet).render_dot();
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
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wp, _lp),
    }
}

/// 悬浮球窗口过程。
///
/// - 左键抬起 = 恢复桌宠（只写 `shared.hide`，显隐与落盘由 compose 在窗口线程统一执行）；
/// - `IDT_HIT` 定时器 = 悬停 / 穿透轮询（R2 范式：命中球面即放大，透明处即穿透）；
/// - 其余消息交默认处理（`WM_PAINT` 无意义——内容全由 ULW 推送）。
unsafe extern "system" fn dot_proc(hwnd: isize, msg: u32, wp: usize, lp: isize) -> isize {
    let pet = get_pet(hwnd);
    if pet.is_null() {
        return DefWindowProcW(hwnd, msg, wp, lp);
    }
    match msg {
        WM_LBUTTONUP => {
            (*pet).show_self();
            0
        }
        WM_TIMER => {
            if wp == IDT_HIT {
                (*pet).update_dot_hit();
                0
            } else {
                DefWindowProcW(hwnd, msg, wp, lp)
            }
        }
        WM_DESTROY => {
            KillTimer(hwnd, IDT_HIT); // 命中轮询随本窗口一起停
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
    if let Ok(base) = std::env::var("LOCALAPPDATA") {
        let dir = std::path::Path::new(&base).join("miasaki");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("pet.log")) {
            use std::io::Write;
            let _ = f.write_all(line.as_bytes());
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
