//! 桌宠窗口：PetWin compose/交互 + 窗口过程 + 启动（D2 拆分）
use std::os::raw::c_void;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use super::config::*;
use super::ffi::*;
use super::image::*;
use super::model::*;
use super::persist::*;
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
    dragged: bool,
    pos: (i32, i32),
    /// 主窗口当前实际显示状态（与 shared.hide 同步；show/hide 切换由 compose 单线程执行）。
    shown: bool,
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
}
impl PetWin {
    fn compose(&mut self) {
        static TICKS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let tick = TICKS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let now = std::time::Instant::now();
        let mut dirty = false;

        // —— 外部命令消费（设置面板 hash 通道 → shared 标志；UI 仅在窗口线程执行）——
        {
            let (want_hide, do_reset) = {
                let mut s = self.shared.lock().unwrap();
                let h = s.hide;
                let r = s.pending_reset;
                s.pending_reset = false;
                (h, r)
            };
            if do_reset {
                let p = default_pos();
                self.pos = p;
                unsafe {
                    MoveWindow(self.hwnd, p.0, p.1, WIN_W, WIN_H, 1);
                    draw_dot(self.dot_hwnd, p);
                }
                pet_log_line(&format!("[native-pet] position reset -> {},{}\n", p.0, p.1));
                save_pet_pos(p, want_hide);
                self.last_tick = now - std::time::Duration::from_secs(10); // 强制重绘
                dirty = true;
            }
            // 目标隐藏状态(want_hide)与当前显示状态(self.shown)语义相反但布尔可比：
            // want_hide=false(显示) 且 shown=true(已显示) → 语义一致，无需切换；
            // want_hide==self.shown(布尔相等) 正是"语义相反需切换"的情形：
            //   (false,false)=想显示但已隐藏 → 显示；(true,true)=想隐藏但已显示 → 隐藏。
            if want_hide == self.shown {
                unsafe {
                    if want_hide {
                        ShowWindow(self.hwnd, SW_HIDE);
                        ShowWindow(self.dot_hwnd, SW_SHOW);
                    } else {
                        ShowWindow(self.dot_hwnd, SW_HIDE);
                        ShowWindow(self.hwnd, SW_SHOW);
                    }
                }
                self.shown = !want_hide;
                // M1.4:显隐切换同步圆点(want_hide=true 时 dot 即将可见,必须先定位到当前 pos)
                draw_dot(self.dot_hwnd, self.pos);
                pet_log_line(&format!(
                    "[native-pet] {} (hide persisted)\n",
                    if want_hide { "hidden" } else { "shown" }
                ));
                save_pet_pos(self.pos, want_hide);
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
                    }
                    Action::Wander { .. } => {
                        // M1.4:散步自然结束同步圆点,隐藏后恢复入口不脱节
                        draw_dot(self.dot_hwnd, self.pos);
                    }
                    _ => {}
                }
            } else {
                self.action = Some(slot);
            }
        }

        // —— 待机随机行为：定时气泡台词 + 定时散步（kurumi 专属,左右移动贴边吸附） ——
        if now >= self.next_quote && self.alert.is_none() {
            self.next_quote = now + std::time::Duration::from_millis(rand_range(40000, 90000));
            let idx = {
                let s = self.shared.lock().unwrap();
                pick_quote(&s.mode)
            };
            // R4:定时台词是最低优先级限时项——不覆盖任何常驻提醒（状态/审批/告警）
            self.alert = Some(Alert::timed("quote", idx, ALERT_PRI_QUOTE, QUOTE_MS));
            self.alert_shown_at = now;
            self.last_tick = now - std::time::Duration::from_secs(10); // 立即触发重绘
            dirty = true;
        }
        if self.action.is_none() && now >= self.next_wander {
            // v2026-08-30:waiting 期间禁止散步(强制桌宠站定在审批气泡旁)
            // X2:fleet 指示期间同样站定;M2(v3):非 Idle 六态(工作/告警/出错/庆祝)全部站定
            let (is_kurumi, fleet_running) = {
                let s = self.shared.lock().unwrap();
                (s.mode == "kurumi", s.fleet_running)
            };
            let blocked = state != PetState::Idle || fleet_running;
            if is_kurumi && !blocked {
                let dir = if rand_u32() % 2 == 0 { 1 } else { -1 };
                self.action = Some(ActionSlot {
                    action: Action::Wander { dx: dir },
                    started: now,
                    duration: std::time::Duration::from_millis(rand_range(1100, 2400)),
                });
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
                let (sw, _) = screen_size();
                if self.pos.0 <= 0 {
                    self.pos.0 = 0;
                    self.action = None;
                } else if self.pos.0 >= sw - WIN_W {
                    self.pos.0 = sw - WIN_W;
                    self.action = None;
                }
                if self.action.is_none() {
                    // M1.4:散步撞墙中断同步圆点(本段结尾统一置 dirty,present 会应用新 pos)
                    draw_dot(self.dot_hwnd, self.pos);
                }
            }
            // 清空画布只在帧更新时进行,避免 33ms 心跳把中间帧清成空白
            for p in self.buf.iter_mut() {
                *p = 0;
            }
            let (mode, intensity, fleet_running) = {
                let s = self.shared.lock().unwrap();
                (s.mode.clone(), s.intensity.clone(), s.fleet_running)
            };
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
            if mode == "whale" || mode == "inverse" {
                let key = if eff_intensity == "deep" {
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
                // D2:缺行时回退 idle(与 kurumi_row 同哲学,仅一层,避免误用它态语义)
                let list_ptr = states.get(key).or_else(|| states.get("idle")).map(|l| l as *const Vec<Image>);
                if let Some(ptr) = list_ptr {
                    let list = unsafe { &*ptr };
                    let bob = if key == "idle" {
                        let phase = (std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() % 3200) as f32 / 1600.0 * std::f32::consts::PI;
                        phase.sin() * 3.0
                    } else {
                        0.0
                    };
                    if list.len() > 1 {
                        // v2:帧序列状态(idle.gif 拆帧),6fps 循环 + bob
                        self.anim_ms = 1000 / 6;
                        let idx = self.frame_idx % list.len();
                        self.frame_idx += 1;
                        self.blit_center_bottom(&list[idx], bob, 1.0);
                    } else if let Some(img) = list.first() {
                        // 单帧:静态 + bob(与历史行为一致)
                        self.anim_ms = 1000;
                        self.blit_center_bottom(img, bob, 1.0);
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
                let pick = {
                    // D2 fallback 链:请求行 → idle → wave → jump → run → 首个可用;
                    // 返回实际命中行名(旧代码回退后仍用请求行名重查 → 查不到 → 空白,现修复)
                    match self.frames.kurumi_row(&row) {
                        Some((l, row_key)) => {
                            // 落地定格窗口:JumpHold 槽期间锁定 jump 末帧,不推进
                            // (Ambient 恰好抽中 jump 行时 kind 不是 JumpHold,照常推进)
                            let holding_jump =
                                matches!(&self.action, Some(s) if matches!(s.action, Action::JumpHold));
                            let idx = if holding_jump {
                                l.len() - 1
                            } else {
                                self.frame_idx % l.len()
                            };
                            if !holding_jump {
                                self.frame_idx += 1;
                            }
                            Some((idx, row_key))
                        }
                        _ => None,
                    }
                };
                if let Some((idx, row_key)) = pick {
                    let ptr = self.frames.kurumi.get(&row_key).map(|l| l as *const Vec<Image>);
                    if let Some(ptr) = ptr {
                        let list = unsafe { &*ptr };
                        // v2 呼吸 bob:基线(idle/wait)且无动作槽时 ±2px 上下呼吸
                        let calm = (row == "idle" || row == "wait") && self.action.is_none();
                        let bob = if calm {
                            let phase = (std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() % 3200) as f32
                                / 1600.0
                                * std::f32::consts::PI;
                            phase.sin() * 2.0
                        } else {
                            0.0
                        };
                        self.blit_center_bottom(&list[idx % list.len()], bob, 1.0);
                    }
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
                "[native-pet] tick{} mode={} int={} whale_states={} kurumi_rows={} buf_nonzero={}\n",
                tick, s.mode, s.intensity,
                self.frames.whale_states.len(),
                self.frames.kurumi.get("idle").map(|v| v.len()).unwrap_or(0),
                non_zero
            ));
        }
        // 脏标记:内容变化才 present,静止时 GDI 频率从 33ms 降到帧更新周期(≥125ms)
        if dirty {
            self.present();
        }
    }

    fn blit_center_bottom(&mut self, img: &Image, bob: f32, scale: f32) {
        let h = (CELL_H as f32 * scale) as i32;
        let w = (img.w as f32 / img.h as f32 * h as f32) as i32;
        let x0 = (WIN_W - w) / 2;
        let y0 = WIN_H - h - 2 + bob as i32;
        if w <= 0 || h <= 0 {
            return;
        }
        let src_w = img.w as i32;
        let src_h = img.h as i32;
        // 源坐标中心对齐:(目标像素中心 → 源空间),避免偏一像素的非对称采样
        // sx = (x + 0.5) * src.w / w - 0.5
        for y in 0..h {
            let syf = (y as f32 + 0.5) * (src_h as f32) / (h as f32) - 0.5;
            let sy0 = syf.floor() as i32;
            let fy = (syf - sy0 as f32).clamp(0.0, 1.0);
            let sy1 = sy0 + 1;
            for x in 0..w {
                let sxf = (x as f32 + 0.5) * (src_w as f32) / (w as f32) - 0.5;
                let sx0 = sxf.floor() as i32;
                let fx = (sxf - sx0 as f32).clamp(0.0, 1.0);
                let sx1 = sx0 + 1;
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
                let dx = x0 + x;
                let dy = y0 + y;
                if dx < 0 || dy < 0 || dx >= WIN_W || dy >= WIN_H {
                    continue;
                }
                let dst = &mut self.buf[(dy * WIN_W + dx) as usize];
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

    /// 纯像素叠加一张预渲染帧(无缩放)。
    fn blit_img(&mut self, img: &Image, x0: i32, y0: i32) {
        for y in 0..img.h as i32 {
            for x in 0..img.w as i32 {
                let px = img.bgra[(y as usize) * img.w + x as usize];
                let a = (px >> 24) & 0xFF;
                if a == 0 {
                    continue;
                }
                let dx = x0 + x;
                let dy = y0 + y;
                if dx < 0 || dy < 0 || dx >= WIN_W || dy >= WIN_H {
                    continue;
                }
                let dst = &mut self.buf[(dy * WIN_W + dx) as usize];
                let da = (*dst >> 24) & 0xFF;
                let inv = 255 - a;
                let r = (((px >> 16) & 0xFF) + (((*dst >> 16) & 0xFF) * inv / 255)) & 0xFF;
                let g = (((px >> 8) & 0xFF) + (((*dst >> 8) & 0xFF) * inv / 255)) & 0xFF;
                let b = ((px & 0xFF) + ((*dst & 0xFF) * inv / 255)) & 0xFF;
                let oa = (a + da * inv / 255) & 0xFF;
                *dst = (oa << 24) | (r << 16) | (g << 8) | b;
            }
        }
    }

    /// 绘制预渲染气泡帧(帧序 = quote 池序;不再调用任何 GDI 字体 API)。
    fn blit_bubble(&mut self, idx: usize) {
        let frame = self.frames.bubbles.get(idx).cloned();
        if let Some(img) = frame {
            // 帧气泡矩形位于帧内 (15,4),blit 后与旧像素布局一致:文本中心 = 原 (54,73)
            let x0 = (WIN_W - BUBBLE_W) / 2;
            let y0 = WIN_H - CELL_H as i32 - 56 - 4;
            self.blit_img(&img, x0, y0);
        }
    }

    /// R2(2026-09-16):窗口局部坐标处是否「透明」（= 可让鼠标穿透到下层窗口）。
    /// 直接查当前合成缓冲 `buf`——它已是「立绘 + 气泡」逐像素 over 之后的**最终结果**，
    /// 因此不必像参考实现那样为每种元素单独维护 mask（`pet/window.py:_sync_mask`）：
    /// 阈值 `CLICK_THROUGH_ALPHA` 之下的像素视为透明。
    fn is_transparent_at(&self, x: i32, y: i32) -> bool {
        if x < 0 || y < 0 || x >= WIN_W || y >= WIN_H {
            return true;
        }
        let a = (self.buf[(y * WIN_W + x) as usize] >> 24) & 0xFF;
        a < CLICK_THROUGH_ALPHA
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
    fn approval_y0() -> i32 {
        WIN_H - CELL_H as i32 - APPROVAL_H - 4
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
        let x0 = (WIN_W - APPROVAL_W) / 2;
        self.blit_img(img, x0, Self::approval_y0());
    }

    /// R5:命中审批按钮 → `Some(true)`=「允许一次」/`Some(false)`=「拒绝」/`None`=未命中。
    /// 两按钮之间留 8px 间隙（见 config 常量），降低误触。
    fn approval_hit(&self, x: i32, y: i32) -> Option<bool> {
        let a = self.alert.as_ref()?;
        if !a.id.starts_with(APPROVAL_ID_PREFIX) {
            return None;
        }
        let x0 = (WIN_W - APPROVAL_W) / 2;
        let y0 = Self::approval_y0();
        let hit = |bx: i32| -> bool {
            x >= x0 + bx
                && x < x0 + bx + APPROVAL_BTN_W
                && y >= y0 + APPROVAL_BTN_Y
                && y < y0 + APPROVAL_BTN_Y + APPROVAL_BTN_H
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

    fn present(&mut self) {
        // D3 GDI 兜底:表面无效 → 低频重试重建（每 ~30 次 compose 一次 ≈1s，不刷屏不自旋）
        if self.present_dc == 0 || self.present_dib == 0 || self.present_bits.is_null() {
            self.surface_fail_streak += 1;
            if self.surface_fail_streak % 30 == 1 {
                if let Some((dc, dib, bits)) = create_present_surface() {
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
            let mut sz = Size { cx: WIN_W, cy: WIN_H };
            let mut src = Point { x: 0, y: 0 };
            let blend = BlendFn { blend_op: 1, blend_flags: 0, src_alpha: 255, alpha_format: 1 };
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
        let idx = {
            let s = self.shared.lock().unwrap();
            pick_quote(&s.mode)
        };
        // R4:单击「撸一下」是**用户主动**交互——其台词按告警档(1)展示，可短暂压过状态气泡，
        // 但**压不过审批**(0)：审批气泡必须常驻到 resolved（v3 M3 的硬约束）。
        self.alert = Some(Alert::timed("quote:click", idx, ALERT_PRI_ALERT, QUOTE_MS));
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
        WM_CREATE => {
            SetTimer(hwnd, IDT_COMPOSE, 33, 0);
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
            let mut p = Point { x: 0, y: 0 };
            GetCursorPos(&mut p);
            (*pet).press_pt = (p.x, p.y);
            (*pet).dragged = false;
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
                if dx.abs() + dy.abs() > 4 {
                    (*pet).dragged = true;
                    let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
                    GetWindowRect(hwnd, &mut r);
                    let nx = r.left + dx;
                    let ny = r.top + dy;
                    MoveWindow(hwnd, nx, ny, WIN_W, WIN_H, 1);
                    (*pet).pos = (nx, ny);
                    (*pet).press_pt = (p.x, p.y);
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
                let hide = (*pet).shared.lock().map(|s| s.hide).unwrap_or(false);
                save_pet_pos((*pet).pos, hide);
                // M1.4:拖动结束同步圆点(隐藏后恢复入口与桌宠位置不脱节,D6)
                draw_dot((*pet).dot_hwnd, (*pet).pos);
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
            let mut p = Point { x: 0, y: 0 };
            GetCursorPos(&mut p);
            (*pet).show_menu(p.x, p.y);
            0
        }
        WM_DESTROY => {
            KillTimer(hwnd, IDT_HIT); // R2:光标轮询随窗口一起停
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wp, _lp),
    }
}

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
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

/// R5:JSON 字符串字面量——把 key/decision 安全注入 eval 的 JS 片段（防注入）。
fn json_lit(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn draw_dot(dot_hwnd: isize, pos: (i32, i32)) {
    unsafe {
        // GDI 绘制不写 alpha，恢复圆点改手工逐像素填充（预乘金）
        let mut buf = vec![0u32; (DOT_SIZE * DOT_SIZE) as usize];
        let r = DOT_SIZE / 2;
        for y in 0..DOT_SIZE {
            for x in 0..DOT_SIZE {
                let dx = x - r;
                let dy = y - r;
                if dx * dx + dy * dy <= r * r {
                    buf[(y * DOT_SIZE + x) as usize] = (255 << 24) | (0xB3 << 16) | (0x6A << 8) | 0xD9;
                }
            }
        }
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
fn create_present_surface() -> Option<(isize, isize, *mut c_void)> {
    unsafe {
        let dc = CreateCompatibleDC(0);
        if dc == 0 {
            return None;
        }
        let bmi = BmiHeader {
            size: 40,
            width: WIN_W,
            height: -WIN_H,
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
        // 显式按监视器 DPI 感知，保证窗口物理尺寸正确
        SetProcessDpiAwarenessContext(-4);
        let (x, y, restore_hide) = initial_pet_state();
        let mut pet = Box::new(PetWin {
            hwnd: 0,
            dot_hwnd: 0,
            app,
            shared,
            frames,
            buf: vec![0u32; (WIN_W * WIN_H) as usize],
            frame_idx: 0,
            anim_ms: 125,
            last_tick: std::time::Instant::now() - std::time::Duration::from_secs(10),
            action: None,
            click_pending: false,
            swallow_next_up: false,
            done_celebrated: false,
            next_ambient: std::time::Instant::now() + std::time::Duration::from_millis(AMBIENT_FIRST_DELAY_MS),
            alert: None,
            alert_shown_at: std::time::Instant::now(),
            decision_seq: 0,
            last_decision: None,
            press_pt: (0, 0),
            dragged: false,
            pos: (x, y),
            shown: !restore_hide,
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
            x, y, WIN_W, WIN_H,
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
        // 关键:WM_CREATE 期间 USERDATA 尚未设置,wnd_proc 的 SetTimer 不会执行;
        // 在此(USERDATA 就位后)显式启动 33ms 动画定时器
        SetTimer(hwnd, IDT_COMPOSE, 33, 0);
        // R2:透明的光标轮询定时器（独立于 compose；穿透状态下窗口收不到鼠标消息，
        // 只能靠主动轮询恢复可点击判定）
        SetTimer(hwnd, IDT_HIT, HIT_POLL_MS, 0);

        // 持久 GDI 表面(创建一次,终身复用;避免高频 CreateDIBSection 触发 gdi32full 崩溃)
        // D3:失败不致命 → present() 低频重试重建（surface_fail_streak 路径）
        match create_present_surface() {
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

        draw_dot(dot_hwnd, (x, y));
        pet.compose();
        pet_log_line("[native-pet] first compose done\n");
        // 启动恢复隐藏状态：主窗隐藏、圆点可见；否则仅显示主窗（圆点留隐藏，等待首次显示切换）
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
