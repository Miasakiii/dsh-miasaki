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
}
