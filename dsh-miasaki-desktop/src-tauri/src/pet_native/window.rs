//! 桌宠窗口：PetWin compose/交互 + 窗口过程 + 启动（D2 拆分）
use std::os::raw::c_void;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use super::config::*;
use super::ffi::*;
use super::image::*;
use super::model::*;
use super::persist::*;
use super::PetShared;
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
    hop_until: Option<std::time::Instant>,
    hop_hold_until: Option<std::time::Instant>, // 落地过渡:跳完末帧定格(v2)
    wave_until: Option<std::time::Instant>, // 双击挥手(v2)
    ambient: Option<Ambient>, // 环境编排(v2)
    next_ambient: std::time::Instant,
    bubble: Option<(usize, std::time::Instant)>,
    press_pt: (i32, i32),
    dragged: bool,
    pos: (i32, i32),
    /// 主窗口当前实际显示状态（与 shared.hide 同步；show/hide 切换由 compose 单线程执行）。
    shown: bool,
    wander: Option<Wander>,
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
                pet_log_line(&format!(
                    "[native-pet] {} (hide persisted)\n",
                    if want_hide { "hidden" } else { "shown" }
                ));
                save_pet_pos(self.pos, want_hide);
                dirty = true;
            }
        }

        // —— 待机随机行为：定时气泡台词 + 定时散步（kurumi 专属,左右移动贴边吸附） ——
        if now >= self.next_quote && self.bubble.is_none() {
            self.next_quote = now + std::time::Duration::from_millis(rand_range(40000, 90000));
            let idx = {
                let s = self.shared.lock().unwrap();
                pick_quote(&s.mode)
            };
            self.bubble = Some((idx, now));
            self.last_tick = now - std::time::Duration::from_secs(10); // 立即触发重绘
            dirty = true;
        }
        if self.wander.is_none() && self.hop_until.is_none() && self.hop_hold_until.is_none()
            && self.ambient.is_none() && now >= self.next_wander
        {
            // v2026-08-30:waiting 期间禁止散步(强制桌宠站定在审批气泡旁)
            // X2:fleet 指示期间同样站定(running/alert 姿态可读，不被散步打断)
            let (is_kurumi, is_waiting) = {
                let s = self.shared.lock().unwrap();
                (s.mode == "kurumi", s.waiting_approval || s.fleet_running || s.fleet_alert)
            };
            if is_kurumi && !is_waiting {
                let dir = if rand_u32() % 2 == 0 { 1 } else { -1 };
                self.wander = Some(Wander {
                    until: now + std::time::Duration::from_millis(rand_range(1100, 2400)),
                    dx: dir,
                });
                dirty = true;
            }
            self.next_wander = now + std::time::Duration::from_millis(rand_range(45000, 120000));
        }
        // —— v2 环境编排：idle 基线低频随机小动作(手势打断见 wnd_proc) ——
        if self.ambient.is_none() && self.hop_until.is_none() && self.hop_hold_until.is_none()
            && self.wave_until.is_none() && self.wander.is_none() && now >= self.next_ambient
        {
            let idle_intensity = {
                let s = self.shared.lock().unwrap();
                s.intensity == "idle"
            };
            if idle_intensity && self.bubble.is_none() {
                let row = pick_ambient_row();
                self.ambient = Some(Ambient {
                    row,
                    until: now + std::time::Duration::from_millis(
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
            if let Some(w) = &mut self.wander {
                self.pos.0 += w.dx * WANDER_PX_PER_FRAME;
                let (sw, _) = screen_size();
                if self.pos.0 <= 0 {
                    self.pos.0 = 0;
                    self.wander = None;
                } else if self.pos.0 >= sw - WIN_W {
                    self.pos.0 = sw - WIN_W;
                    self.wander = None;
                } else if now >= w.until {
                    self.wander = None;
                }
            }
            // 清空画布只在帧更新时进行,避免 33ms 心跳把中间帧清成空白
            for p in self.buf.iter_mut() {
                *p = 0;
            }
            let (mode, intensity, activity, waiting, fleet_running, fleet_alert) = {
                let s = self.shared.lock().unwrap();
                (s.mode.clone(), s.intensity.clone(), s.activity.clone(), s.waiting_approval, s.fleet_running, s.fleet_alert)
            };
            // —— 状态映射优先级（X2）：fleet_alert > waiting > fleet_running > busy > DOM intensity ——
            // fleet_alert → kurumi failed 行 + NEED_APPROVE 常驻气泡（去面板处理）
            // waiting 强制 work 立绘/kurumi wait 行 + 常驻审批气泡
            // fleet_running → work 立绘 + BUSY 常驻气泡（kurumi 保持 idle 行，不原地跑步）
            // busy 等效 work(已切 work/intensity)
            // idle 退回 intensity(原逻辑)
            let eff_intensity = if waiting || fleet_running {
                "work"
            } else if activity == "busy" {
                if intensity == "idle" { "work" } else { intensity.as_str() }
            } else {
                intensity.as_str()
            };
            // 状态气泡（常驻，不参与 3s 过期）：alert > waiting > running 优先级替换
            {
                let want = if fleet_alert {
                    Some(BUBBLE_NEED_APPROVE)
                } else if waiting {
                    Some(BUBBLE_WAITING)
                } else if fleet_running {
                    Some(BUBBLE_BUSY)
                } else {
                    None
                };
                let is_status = matches!(self.bubble, Some((idx, _)) if idx == BUBBLE_BUSY || idx == BUBBLE_WAITING || idx == BUBBLE_NEED_APPROVE);
                match (want, self.bubble.clone()) {
                    (Some(w), Some((cur, _))) if cur == w => {}
                    (Some(w), _) => self.bubble = Some((w, std::time::Instant::now())),
                    (None, Some((cur, _))) if is_status && [BUBBLE_BUSY, BUBBLE_WAITING, BUBBLE_NEED_APPROVE].contains(&cur) => {
                        self.bubble = None
                    }
                    _ => {}
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
                // v2 优先序:hop → hopHold(落地) → wander → ambient → wave → focus(wait) → idle
                // v2026-08-30:waiting 强制选 wait 行(并锁定 wait_hold_until 防止 ambient 打断)
                let row = if let Some(until) = self.hop_until {
                    if now < until {
                        "jump".to_string()
                    } else {
                        // 落地过渡:跳完末帧定格 HOP_HOLD_MS 再回 idle,消除硬切
                        if self.hop_hold_until.is_none() {
                            self.hop_hold_until =
                                Some(now + std::time::Duration::from_millis(HOP_HOLD_MS));
                        }
                        "jump".to_string()
                    }
                } else if let Some(until) = self.hop_hold_until {
                    if now < until {
                        "jump".to_string()
                    } else {
                        self.hop_hold_until = None;
                        if waiting { "wait".to_string() } else { "idle".to_string() }
                    }
                } else if self.wander.is_some() {
                    // 散步:播放 run 行帧(双向移动共用);waiting 期间不允许散步
                    if waiting { "wait".to_string() } else { "run".to_string() }
                } else if let Some(a) = &self.ambient {
                    if now >= a.until {
                        self.ambient = None;
                        if waiting { "wait".to_string() } else { "idle".to_string() }
                    } else {
                        a.row.clone()
                    }
                } else if let Some(until) = self.wave_until {
                    if now < until {
                        "wave".to_string()
                    } else {
                        self.wave_until = None;
                        if waiting { "wait".to_string() } else { "idle".to_string() }
                    }
                } else if waiting {
                    // 等待审批:播 wait 行(偶发语义,起伏大但语义对)
                    "wait".to_string()
                } else if fleet_alert {
                    // X2:fleet 告警(blocked/error):播 failed 行(缺行由 kurumi_row 回退链兜底)
                    "failed".to_string()
                } else if eff_intensity == "idle" {
                    "idle".to_string()
                } else {
                    // 思考中/busy=静默守候(同 idle 姿态;ambient 仅在 idle 强度触发,自动安静)。
                    // wait 行留给审批等待(waiting 分支)——曾用 wait 行表示思考,
                    // 其帧组起伏较大 + 慢放 → 真机观感「一直跳动」(2026-08-22 用户反馈修正)。
                    "idle".to_string()
                };
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
                            // 落地定格窗口:锁定 jump 末帧,不推进
                            let holding_jump = row == "jump"
                                && self.hop_until.is_none()
                                && match self.hop_hold_until {
                                    Some(hu) => now < hu,
                                    None => false,
                                };
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
                        // v2 呼吸 bob:基线(idle/wait)且无行动状态时 ±2px 上下呼吸
                        let calm = (row == "idle" || row == "wait")
                            && self.hop_until.is_none()
                            && self.hop_hold_until.is_none()
                            && self.wave_until.is_none()
                            && self.ambient.is_none()
                            && self.wander.is_none();
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
            if let Some((idx, _)) = self.bubble.clone() {
                self.blit_bubble(idx);
            }
            dirty = true;
        }
        // 气泡:超时检查每 tick;绘制只在帧更新后(避免每 33ms 图像合成)
        // v2026-08-30:状态帧(BUBBLE_BUSY/WAITING/NEED_APPROVE)不参与 3s 过期,常驻
        if let Some((idx, t0)) = self.bubble.clone() {
            let is_status = idx == BUBBLE_BUSY || idx == BUBBLE_WAITING || idx == BUBBLE_NEED_APPROVE;
            if !is_status && now.duration_since(t0).as_secs() > 3 {
                self.bubble = None;
                dirty = true;
            } else {
                // 若本 tick 未重绘(帧未更新),气泡已在上一帧的 buf 上,无需重复绘制
            }
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

    fn do_hop(&mut self) {
        self.hop_until = Some(std::time::Instant::now() + std::time::Duration::from_millis(900));
        self.hop_hold_until = None;
        self.wave_until = None;
        self.ambient = None; // 手势打断环境编排
        self.frame_idx = 0;
        self.last_tick = std::time::Instant::now() - std::time::Duration::from_secs(10);
        let idx = {
            let s = self.shared.lock().unwrap();
            pick_quote(&s.mode)
        };
        self.bubble = Some((idx, std::time::Instant::now()));
    }

    /// v2 双击挥手:播 wave 行(约 500ms 内容,余量 1300ms 收尾),任何指针事件可打断
    fn do_wave(&mut self) {
        self.wave_until = Some(std::time::Instant::now() + std::time::Duration::from_millis(WAVE_MS));
        self.ambient = None;
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
            SetForegroundWindow(self.hwnd);
            let cmd = TrackPopupMenu(m, TPM_RETURNCMD | TPM_RIGHTBUTTON, x, y, 0, self.hwnd, 0);
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
            SetTimer(hwnd, 1, 33, 0);
            0
        }
        WM_TIMER => {
            (*pet).compose();
            0
        }
        WM_LBUTTONDOWN => {
            let mut p = Point { x: 0, y: 0 };
            GetCursorPos(&mut p);
            (*pet).press_pt = (p.x, p.y);
            (*pet).dragged = false;
            // v2:指针按下即打断环境编排/挥手(拖拽与动作互斥)
            (*pet).ambient = None;
            (*pet).wave_until = None;
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
            if !(*pet).dragged {
                // v2026-08-30:waiting 中点击桌宠 = 唤起主窗口去批准(跳过 hop,免破坏等待观感)
                let waiting = (*pet).shared.lock().map(|s| s.waiting_approval).unwrap_or(false);
                if waiting {
                    (*pet).focus_main();
                } else {
                    (*pet).do_hop();
                    (*pet).focus_main(); // 点击桌宠 → 唤起/聚焦主窗口
                }
            } else {
                let hide = (*pet).shared.lock().map(|s| s.hide).unwrap_or(false);
                save_pet_pos((*pet).pos, hide);
            }
            0
        }
        WM_LBUTTONDBLCLK => {
            // v2 决策1:主窗最小化/隐藏 → 唤起;否则 → 挥手(修复 wave 行从未触发的漂移)
            if (*pet).main_needs_wake() {
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
            hop_until: None,
            hop_hold_until: None,
            wave_until: None,
            ambient: None,
            next_ambient: std::time::Instant::now() + std::time::Duration::from_millis(AMBIENT_FIRST_DELAY_MS),
            bubble: None,
            press_pt: (0, 0),
            dragged: false,
            pos: (x, y),
            shown: !restore_hide,
            wander: None,
            next_quote: std::time::Instant::now() + std::time::Duration::from_secs(12),
            next_wander: std::time::Instant::now() + std::time::Duration::from_secs(8),
            present_dc: 0,
            present_dib: 0,
            present_bits: std::ptr::null_mut(),
            ulw_fail_streak: 0,
            surface_fail_streak: 0,
            surface_rebuilds: 0,
        });
        let pet_ptr = &mut *pet as *mut PetWin;
        let inst = GetModuleHandleW(std::ptr::null());

        let cls = wide("MiasakiPetWin");
        let wc = WndClassW {
            style: CS_HREDRAW | CS_VREDRAW,
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

        let ex = WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW;
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
        SetTimer(hwnd, 1, 33, 0);

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
