//! 行为模型：动作槽 + 台词池（D2 拆分；v3 M1 统一动作槽、M2 六态行选择）
use super::config::*;
use super::PetState;
use super::ffi::rand_u32;
/* ---------------- 窗口状态 ---------------- */

/// M1.1:一次性/环境动作统一为单一枚举槽位（v3 前是 hop/hop_hold/wave/ambient/wander
/// 五个独立 Option,其中 hop_until 无任何复位路径 → 单击一次永久卡 jump,连坐遮蔽全部状态姿态）。
pub(crate) enum Action {
    /// 单击「撸一下」跳跃(HOP_MS)
    Jump,
    /// 落地过渡:jump 末帧定格(HOP_HOLD_MS),由 compose 到期清理自动从 Jump 转入
    JumpHold,
    /// 双击挥手(WAVE_MS)
    Wave,
    /// 环境编排小动作(播放 row 行)
    Ambient { row: String },
    /// 散步(dx = 每帧位移方向 ±1)
    Wander { dx: i32 },
}

/// 带到期时间的动作槽。compose 每轮「先到期即清、再行选择」,从结构上消除「忘记清理」一类缺陷。
pub(crate) struct ActionSlot {
    pub(crate) action: Action,
    pub(crate) started: std::time::Instant,
    pub(crate) duration: std::time::Duration,
}

impl ActionSlot {
    pub(crate) fn expired(&self, now: std::time::Instant) -> bool {
        now.duration_since(self.started) >= self.duration
    }
}

/// M1.2/M2(v3) 状态优先级行选择（高 → 低）:
///   Waiting(审批) > FleetBlocked > Error > Done(庆祝让位一次性槽) > Thinking(静默守候) > Idle
/// 状态由 compose 的六态合成给出（官方契约优先,DOM 兜底,fleet 叠加）;
/// 动作槽在 Idle/Waiting 态下的行为:Idle 时播放,Waiting 时被状态压住(M1.3 验收 ③)。
/// 返回 kurumi 渲染分支应播放的行名。
pub(crate) fn pick_state_row(state: PetState, action: Option<&ActionSlot>) -> String {
    match state {
        PetState::Waiting => {
            // 等待审批:播 wait 行;残留手势槽被状态压住(审批可读性优先)
            let _ = action;
            "wait".to_string()
        }
        PetState::FleetBlocked | PetState::Error => {
            // fleet 告警(blocked/error)/会话出错:播 failed 行(缺行由 kurumi_row 回退链兜底)
            let _ = action;
            "failed".to_string()
        }
        PetState::Done => match action {
            // 庆祝:让位给一次性 review 槽(挂槽一次,播完回 idle 行,不循环)
            Some(slot) => slot_row(slot),
            None => "idle".to_string(),
        },
        PetState::Thinking => {
            // 思考中/busy=静默守候(同 idle 姿态)。wait 行留给审批等待;
            // busy 不原地跑步、不做小动作(真实工作状态:干活时站定)
            let _ = action;
            "idle".to_string()
        }
        PetState::Idle => match action {
            Some(slot) => slot_row(slot),
            None => "idle".to_string(),
        },
    }
}

fn slot_row(slot: &ActionSlot) -> String {
    match &slot.action {
        Action::Jump | Action::JumpHold => "jump".to_string(),
        Action::Wave => "wave".to_string(),
        Action::Wander { .. } => "run".to_string(),
        Action::Ambient { row } => row.clone(),
    }
}

/* ---------------- R4(2026-09-16)：提醒（气泡）模型 ---------------- */

/// 提醒优先级（数字越小越高）：审批 > 告警/错误 > 状态 > 随机台词。
pub(crate) const ALERT_PRI_APPROVAL: u8 = 0;
pub(crate) const ALERT_PRI_ALERT: u8 = 1;
pub(crate) const ALERT_PRI_STATE: u8 = 2;
pub(crate) const ALERT_PRI_QUOTE: u8 = 3;

/// 一条提醒 = 当前展示的气泡。取代 v3 之前的单槽 `Option<(usize, Instant)>`。
///
/// 三条语义直接来自参考实现的踩坑记录（`pet/window_alerts.py:68-160`）：
/// ① **同 id 就地更新**——状态抖动（running 快速翻转、心跳抖动）不重建气泡、不重置计时，
///    避免「气泡闪烁」；
/// ② **高优先级抢占**——审批(0) > 告警(1) > 状态(2) > 台词(3)；随机台词**永不覆盖**常驻项；
/// ③ **按 id 精确移除**（`resolve_alert`）——多会话并发审批按官方 `PendingApproval.key`
///    移除对应项，而不是「关掉当前气泡」误伤别人的提醒（参考实现 PR 修复的正是这个 bug）。
///
/// **未采纳**其「被抢占的 sticky 项回队首、稍后恢复」：我方同时只展示一个气泡，
/// 被抢占的低优先级项要么是台词（可丢弃）、要么是状态派生项（状态仍在，下一轮自然回来）。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Alert {
    /// 稳定身份：审批 = 官方 `PendingApproval.key`；状态 = `state:<态名>`；台词 = `quote`。
    pub(crate) id: String,
    /// 气泡帧索引（`bubbles.png`）
    pub(crate) frame: usize,
    /// 优先级（数字越小越高，见 `ALERT_PRI_*`）
    pub(crate) priority: u8,
    /// 常驻：不参与超时，须被更高优先级抢占、或被同源状态变化清除
    pub(crate) sticky: bool,
    /// 限时项的截止时刻（`sticky == false` 时有效）
    pub(crate) until: Option<std::time::Instant>,
}

impl Alert {
    /// 状态派生的常驻项（由 compose 每轮按当前六态给出，状态变了自然被换掉）。
    pub(crate) fn state(id: &str, frame: usize) -> Self {
        Alert { id: id.to_string(), frame, priority: ALERT_PRI_STATE, sticky: true, until: None }
    }

    /// 常驻项（审批 / fleet 告警）：必须显式 `resolve_alert(id)` 或被更高优先级抢占。
    pub(crate) fn sticky(id: &str, frame: usize, priority: u8) -> Self {
        Alert { id: id.to_string(), frame, priority, sticky: true, until: None }
    }

    /// 限时项（随机台词等）。
    pub(crate) fn timed(id: &str, frame: usize, priority: u8, ms: u64) -> Self {
        Alert {
            id: id.to_string(),
            frame,
            priority,
            sticky: false,
            until: Some(std::time::Instant::now() + std::time::Duration::from_millis(ms)),
        }
    }

    pub(crate) fn expired(&self, now: std::time::Instant) -> bool {
        !self.sticky && self.until.map(|t| now >= t).unwrap_or(false)
    }
}

/// `want` 是否**抢占** `cur`（严格更高优先级才抢；同优先级保留当前项，避免同类互相顶）。
pub(crate) fn alert_preempts(want: &Alert, cur: &Alert) -> bool {
    want.priority < cur.priority
}

/// 同 id = 同一条提醒的更新（就地替换帧，不重置计时）。
pub(crate) fn same_alert(want: &Alert, cur: &Alert) -> bool {
    want.id == cur.id
}

pub(crate) fn quote_pool(mode: &str) -> &'static [&'static str] {
    match mode {
        "kurumi" => &["ふふふ…", "啊啦，你来了呢", "时间，可是很宝贵的哦", "刻刻帝在看着你", "（轻笑）", "今晚的时间也归我哦"],
        "inverse" => &["选好了吗？", "别让我等太久", "（冷笑）", "效率。现在。", "你的时间，归我支配", "（眯起赤瞳）"],
        _ => &["咕噜咕噜…", "（吐泡泡）", "呜~ 我在听", "今天的代码也拜托了", "（摇尾巴）"],
    }
}

/// 台词在气泡精灵表(bubbles.png)中的起始帧号,数组顺序必须与 gen-bubbles.ps1 一致。
pub(crate) fn quote_base(mode: &str) -> usize {
    match mode {
        "kurumi" => 5,
        "inverse" => 11,
        _ => 0,
    }
}

pub(crate) fn pick_quote(mode: &str) -> usize {
    let pool = quote_pool(mode);
    quote_base(mode) + rand_u32() as usize % pool.len()
}

/// v2 环境编排:选一个 ambient 动作行。池 wave/review/wait,jump 以 AMBIENT_JUMP_PCT 概率替换。
/// 候选行若在 frames.json 缺失,由 kurumi 渲染分支的 fallback 链自动兜底(idle)。
pub(crate) fn pick_ambient_row() -> String {
    if rand_u32() % 100 < AMBIENT_JUMP_PCT {
        return "jump".to_string();
    }
    const POOL: [&str; 3] = ["wave", "review", "wait"];
    POOL[(rand_u32() as usize) % POOL.len()].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(action: Action, ms: u64) -> ActionSlot {
        ActionSlot {
            action,
            started: std::time::Instant::now(),
            duration: std::time::Duration::from_millis(ms),
        }
    }

    /// D3 回归:审批态出现时必须立刻可读,即使刚点过桌宠(动作槽未到期)。
    #[test]
    fn waiting_and_alert_beat_gesture() {
        let jump = slot(Action::Jump, 900);
        assert_eq!(pick_state_row(PetState::Waiting, Some(&jump)), "wait");
        assert_eq!(pick_state_row(PetState::FleetBlocked, Some(&jump)), "failed");
        assert_eq!(pick_state_row(PetState::Error, Some(&jump)), "failed");
    }

    /// M2 回归:Error/FleetBlocked 播 failed;Thinking(静默守候)压过手势与环境编排。
    #[test]
    fn busy_beats_gesture_and_ambient() {
        let jump = slot(Action::Jump, 900);
        let amb = slot(Action::Ambient { row: "wave".into() }, 1500);
        assert_eq!(pick_state_row(PetState::Thinking, Some(&jump)), "idle");
        assert_eq!(pick_state_row(PetState::Thinking, Some(&amb)), "idle");
        assert_eq!(pick_state_row(PetState::Thinking, None), "idle");
    }

    #[test]
    fn action_rows_map_by_kind() {
        let amb = slot(Action::Ambient { row: "review".into() }, 1500);
        let wander = slot(Action::Wander { dx: 1 }, 1800);
        let hold = slot(Action::JumpHold, 200);
        assert_eq!(pick_state_row(PetState::Idle, Some(&amb)), "review");
        assert_eq!(pick_state_row(PetState::Idle, Some(&wander)), "run");
        assert_eq!(pick_state_row(PetState::Idle, Some(&hold)), "jump");
        assert_eq!(pick_state_row(PetState::Idle, None), "idle");
    }

    /// M2.1:Done 庆祝让位一次性 review 槽,槽死后回 idle 行(不循环庆祝)。
    #[test]
    fn done_yields_to_review_slot_then_idle() {
        let review = slot(Action::Ambient { row: "review".into() }, 1500);
        assert_eq!(pick_state_row(PetState::Done, Some(&review)), "review");
        assert_eq!(pick_state_row(PetState::Done, None), "idle");
    }

    /// M1.1 回归:到期即清(Jump 除外——它转 JumpHold 落地定格,由 window.rs compose 完成)。
    #[test]
    fn slot_expiry() {
        let started = std::time::Instant::now();
        let s = ActionSlot {
            action: Action::Wave,
            started,
            duration: std::time::Duration::from_millis(50),
        };
        assert!(!s.expired(started));
        assert!(s.expired(started + std::time::Duration::from_millis(51)));
    }

    /// R4:优先级次序——审批 > 告警 > 状态 > 台词；低优先级永不反抢，同优先级不互抢。
    #[test]
    fn alert_priority_order() {
        let appr = Alert::sticky("approval:k1", BUBBLE_WAITING, ALERT_PRI_APPROVAL);
        let alert = Alert::sticky("fleet:alert", BUBBLE_NEED_APPROVE, ALERT_PRI_ALERT);
        let state = Alert::state("state:busy", BUBBLE_BUSY);
        let quote = Alert::timed("quote", BUBBLE_BUSY, ALERT_PRI_QUOTE, 3000);
        assert!(alert_preempts(&appr, &alert));
        assert!(alert_preempts(&alert, &state));
        assert!(alert_preempts(&state, &quote));
        // 反向不成立：低优先级不抢高优先级
        assert!(!alert_preempts(&quote, &state));
        assert!(!alert_preempts(&state, &alert));
        // 同优先级不互抢（同类更新走 same_alert 分支）
        let state2 = Alert::state("state:done", BUBBLE_NEED_APPROVE);
        assert!(!alert_preempts(&state2, &state));
    }

    /// R4:同 id = 同一条提醒的更新（就地换帧，不重置计时、不走抢占）。
    #[test]
    fn same_id_updates_in_place() {
        let a = Alert::sticky("approval:k1", BUBBLE_WAITING, ALERT_PRI_APPROVAL);
        let b = Alert::sticky("approval:k1", BUBBLE_NEED_APPROVE, ALERT_PRI_APPROVAL);
        assert!(same_alert(&a, &b));
        assert!(!alert_preempts(&b, &a), "同 id 更新不是抢占");
        let other = Alert::sticky("approval:k2", BUBBLE_NEED_APPROVE, ALERT_PRI_APPROVAL);
        assert!(!same_alert(&a, &other), "不同 key 是两条独立提醒");
    }

    /// R4:只有限时项会过期；常驻项（审批/告警/状态）永不过期。
    #[test]
    fn alert_expiry_only_for_timed() {
        let now = std::time::Instant::now();
        let quote = Alert::timed("quote", BUBBLE_BUSY, ALERT_PRI_QUOTE, 50);
        assert!(!quote.expired(now));
        assert!(quote.expired(now + std::time::Duration::from_millis(51)));
        let sticky = Alert::sticky("approval:k1", BUBBLE_WAITING, ALERT_PRI_APPROVAL);
        assert!(!sticky.expired(now + std::time::Duration::from_secs(3600)));
        let state = Alert::state("state:done", BUBBLE_BUSY);
        assert!(!state.expired(now + std::time::Duration::from_secs(3600)));
    }
}
