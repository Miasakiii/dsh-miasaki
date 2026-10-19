//! 行为模型：动作槽 + 台词池（D2 拆分；v3 M1 统一动作槽、M2 六态行选择）
use super::config::*;
use super::PetState;
use super::ffi::rand_u32;
// M4.1：吸附判定要用 `Rect`。它是 `#[repr(C)]` 的纯数据（无 extern 块、无 Win32 符号），
// 引入它不会让本文件失去「可 `rustc --test` 直编」的资格 —— 这是把判定放 model.rs 的前提。
// R20-a：全屏判据还要 `WS_CAPTION`（同为纯常量，不是 Win32 调用）。
use super::ffi::{Rect, WS_CAPTION};
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
    /// P0-F2（2026-10-18，design/2026-10-18-pet-p0-interaction-emote.md）：表演动作。
    /// 与 Ambient 的分工：Ambient 播**图集行**（wave/review/wait/jump），Emote 的
    /// 基础姿态恒为 `idle` 行，表现全在**绘制层编舞**（`xform::emote_xform`）——
    /// 零新素材得到「点头/摇头/转身/发抖/跳舞/张望/睡觉」。
    /// 走同一动作槽 ⇒ 自动继承「到期即清」与六态压制（非 Idle 态被状态压住）。
    Emote { kind: EmoteKind },
}

/// P0-F2：表演动作种类。旋转类（Shake/Dance/Look/Shiver）的角度上限是**几何硬约束**：
/// 角色 270px 高、pivot 在底边中心，旋转 θ 的水平伸出 = `w/2·cosθ + h·sinθ`，
/// 窗口半宽仅 143px ⇒ 任何旋转 ≤ 3.7°，而布局余量只预留 `SWAY_MAX_DEG·MOTION_MAX`
/// = 3.2°（`sway_layout_margin`）。参数表在 config.rs，单测在 xform.rs 钉死上限。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum EmoteKind {
    /// 点头（摸头反馈；bob 正弦一次）
    Nod,
    /// 摇头（两次快摆）
    Shake,
    /// 转身（中点横向挤压 + 镜像翻转——「回头看一眼」）
    Turn,
    /// 发抖（高频确定性抖动；咬手期间长时抖动）
    Shiver,
    /// 跳舞（摇摆 + 节拍 bob；**不带挤压**，见 config.rs `DANCE_DEG` 注释）
    Dance,
    /// 张望（左-右-左三摆，幅度递减；撞墙后触发）
    Look,
    /// 睡觉（深慢呼吸、不摇摆；深夜自动，交互或早晨唤醒）
    Sleep,
}

/// P0-F2：emote 的时长（ms）。Sleep 由 SLEEP_MS 续期，不走这里。
pub(crate) fn emote_duration(kind: EmoteKind) -> u64 {
    match kind {
        EmoteKind::Nod => NOD_MS,
        EmoteKind::Shake => SHAKE_MS,
        EmoteKind::Turn => TURN_MS,
        EmoteKind::Shiver => SHIVER_MS,
        EmoteKind::Dance => DANCE_MS,
        EmoteKind::Look => LOOK_MS,
        EmoteKind::Sleep => SLEEP_MS,
    }
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
///   Waiting(审批) > FleetBlocked > Error > Done(庆祝让位一次性槽) > Thinking(工作态:坐姿打字) > Idle
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
            // fleet 告警(blocked/error)/会话出错:播 failed 行(缺行由 Frames::atlas_row 回退链兜底)
            let _ = action;
            "failed".to_string()
        }
        PetState::Done => match action {
            // 庆祝:让位给一次性 review 槽(挂槽一次,播完回 idle 行,不循环)
            Some(slot) => slot_row(slot),
            None => "idle".to_string(),
        },
        PetState::Thinking => {
            // 工作态 = 坐姿敲键盘(r7,行名 run)。见 design/pet-v5-motion-plan.md L0-2:
            // v3 当时取 idle 是「无可用素材」的妥协,现改为语义直译——Thinking 的来源正是
            // 官方 running(agent 真在干活),r7 是「在干活」的一手姿态。
            // wait 行仍留给审批等待;busy 不做环境小动作(槽被本分支压住)。
            let _ = action;
            "run".to_string()
        }
        PetState::Idle => match action {
            Some(slot) => slot_row(slot),
            None => "idle".to_string(),
        },
    }
}

/// 动作槽 → 行名。`Wander` 按方向选行（L0-1，见 design/pet-v5-motion-plan.md）:
/// 此前 `dx` 被丢弃、恒返 `"run"`，导致 runRight/runLeft 这 16 帧已切好却从未上场
/// （且 `run` 实为「坐姿打字」，被当散步播属语义错配——现两处各归其位：
///  散步 → runRight/runLeft，工作态 → run）。
fn slot_row(slot: &ActionSlot) -> String {
    match &slot.action {
        Action::Jump | Action::JumpHold => "jump".to_string(),
        Action::Wave => "wave".to_string(),
        // dx 取值域是 ±1（window.rs 只产生这两种），`>= 0` 兼作 0 的兜底
        Action::Wander { dx } => if *dx >= 0 { "runRight" } else { "runLeft" }.to_string(),
        Action::Ambient { row } => row.clone(),
        // P0-F2：Emote 的基础姿态恒为 idle——表现全在绘制层变换（xform::emote_xform），
        // 行选择只决定「站在什么姿态上演」。回退链对 idle 恒命中，不会串到别态语义。
        Action::Emote { .. } => "idle".to_string(),
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

// v2 环境编排:选一个 ambient 动作行。池 wave/review/wait,jump 以 AMBIENT_JUMP_PCT 概率替换。
// 候选行若在 frames.json 缺失,由 kurumi 渲染分支的 fallback 链自动兜底(idle)。
//
// **E5（2026-10-04）不重复同一条**（对齐上游 dsh-pet 的「档内轮换、避免连播同一段」）：
// 原实现是 `rand % 3` 均匀随机 ⇒ **连续两次选到同一行的概率是 1/3**，
// 而 idle 态下 ambient 是唯一的动作来源，等于每三次就有一次「刚才好像没动」。
// 修法是重抽一次而**不是**重排权重（后者会改动 `AMBIENT_JUMP_PCT` 的既有意图）。
//
// **为什么要抽成两个纯函数**：`rand_u32()` 走 Win32 FFI、**不可注入种子** ⇒ 单元测试无法验证
// 「确实避开了上次」这种时序性质。故把「选行」与「记状态」拆开：
// `pick_ambient_pool_index_weighted()`（P0-F4 起，含权重入参）是纯函数；
// 粘合层（`pick_ambient_choice`）只做取随机数、调纯函数、记状态。这样单测能直接跑纯函数，
// 顺带保证「记忆状态」这件事只有一处写（下面的 `AMBIENT_LAST`）。

// ambient 池上次选中的行下标（窗口线程独占，compose 循环单线程调用，无需原子操作）。
//
// **用 `Cell` 而非 `static mut`**：`static mut` 在 Rust 里是待裁剪的 UB 来源，
// 而 `Cell<Option<usize>>` 给出同样的「进程内可改」语义且不引入 `unsafe`。
// 33ms 主路径的写入是一次整数写，**零分配**（符合 `ARCHITECTURE.md` 铁律）。
thread_local! {
    static AMBIENT_LAST: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

/* ---------------- P0-F4（2026-10-18）：心情值与情绪化 ambient ---------------- */

/// 心情事件。全部来自**本地事实**（互动/状态/疏忽），不解析模型输出——
/// 与「官方契约为信号」的桌宠架构一致，零 LLM 依赖、判据可单测。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum MoodEvent {
    /// 被摸一下
    Stroke,
    /// 被咬（咬手彩蛋的后果——它知道错了）
    Bite,
    /// 被甩出去（它害怕）
    Throw,
    /// 单击「撸一下」
    Hop,
    /// 双击挥手
    Wave,
    /// 任务完成庆祝（与有荣焉）
    Done,
    /// 被冷落（每 MOOD_NEGLECT_EVERY_MS 无交互）
    Neglect,
}

/// 心情档位（ambient 加权与 emote 触发的依据）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum AmbientBand {
    /// 蔫（wait 多、易发抖/张望）
    Low,
    /// 平常
    Mid,
    /// 欢（wave 多、爱跳舞）
    High,
}

/// 心情值推进（纯函数，clamp 在 [`MOOD_MIN`, `MOOD_MAX`]）。
pub(crate) fn mood_apply(mood: i32, ev: MoodEvent) -> i32 {
    let d = match ev {
        MoodEvent::Stroke => MOOD_STROKE,
        MoodEvent::Bite => MOOD_BITE,
        MoodEvent::Throw => MOOD_THROW,
        MoodEvent::Hop => MOOD_HOP,
        MoodEvent::Wave => MOOD_WAVE,
        MoodEvent::Done => MOOD_DONE,
        MoodEvent::Neglect => MOOD_NEGLECT,
    };
    (mood + d).clamp(MOOD_MIN, MOOD_MAX)
}

/// 心情 → 档位。阈值对称（±25）：|mood| 够大才换档，中间带是「平常」。
pub(crate) fn mood_band(mood: i32) -> AmbientBand {
    if mood >= MOOD_HIGH {
        AmbientBand::High
    } else if mood <= MOOD_LOW {
        AmbientBand::Low
    } else {
        AmbientBand::Mid
    }
}

/// C 批（2026-10-19，design/2026-10-19-pet-c-time-aware-ambient.md）：**时段档**
/// （纯函数）——ambient 编排的「夜里也别太闹」氛围修正。
/// 边界与睡眠段常量对齐（`SLEEP_START_HOUR`–`SLEEP_END_HOUR`），渐静段是睡前的过渡。
/// 入参是本地小时（0–23）；越界值（>23）按正午处理——与 `local_hour` 的失败方向一致，
/// 「误判深夜」比「误判正午」代价大（凌晨桌宠莫名安静 vs 傍晚 slightly 闹）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum TimeBand {
    /// 白天（07:00–18:00）：现行口径，不做修正。
    Day,
    /// 傍晚渐静（18:00–23:00）：轻推安静行。
    Evening,
    /// 深夜（23:00–07:00）：活跃行压到最低、安静行抬倍。
    Night,
}

pub(crate) fn time_band(hour: u32) -> TimeBand {
    if hour > 23 {
        return TimeBand::Day; // 越界值不猜深夜（local_hour 失败方向给 12 = 正午）
    }
    if hour >= SLEEP_START_HOUR || hour < SLEEP_END_HOUR {
        TimeBand::Night
    } else if hour >= EVENING_START_HOUR {
        TimeBand::Evening
    } else {
        TimeBand::Day
    }
}

/// 加权选行（纯函数）。保留 E5 的**不重复**纪律：撞上上次时，在「别的门」里按权重
/// **公平重抽**一次——「取第一个 ≠ 上次的门」这种写法会把权重系统地吸向低索引
/// （[1,1,3] 的 wait 档实测被打压成与 wave 档持平，首版就被 `weighted_ambient_pick_*`
/// 抓住）。第二抽样用 `rnd / total`（与首抽的余数独立，纯函数仍可单测）。
/// 全零权重是退化输入（调用方不会给），落首项不死循环。
/// 全 1 权重时与 P0 前的均匀随机同口径（E5 既有口径）。
/// P1-a：入参从定长 `[u32;3]` 泛化为切片——whale 池有 6 行（含待机变体），
/// 定长会把「主题相关变长池」这个需求憋死。权重来源从 `ambient_weights`（按档位
/// 一张表）改为 `row_weight`（按行名 × 档位）——行池变长后「第 i 门的权重」
/// 不再有稳定含义，行名才有。
pub(crate) fn pick_ambient_pool_index_weighted(rnd: u32, last: Option<usize>, w: &[u32]) -> usize {
    let total: u32 = w.iter().sum();
    if total == 0 || w.is_empty() {
        return 0;
    }
    let mut r = rnd % total;
    let mut idx = 0usize;
    while idx + 1 < w.len() && r >= w[idx] {
        r -= w[idx];
        idx += 1;
    }
    match last {
        Some(prev) if idx == prev => {
            let alt_total = total - w[prev];
            if alt_total == 0 {
                return idx; // 别的门全零（退化权重表）⇒ 保持原值
            }
            let r2 = (rnd / total) % alt_total;
            let mut acc = 0u32;
            for (i, &wi) in w.iter().enumerate() {
                if i == prev {
                    continue;
                }
                acc += wi;
                if r2 < acc {
                    return i;
                }
            }
            idx
        }
        _ => idx,
    }
}

/// ambient 的一次选择：播图集行，或演一个 emote（P0-F2 的入口之一）。
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum AmbientChoice {
    Row(String),
    Emote(EmoteKind),
}

/// 心情档位 → 这次 ambient 要不要演 emote、演哪个（纯函数，概率见 `EMOTE_PCT_*`）。
/// High 爱跳舞；Low 在发抖/张望里二选一；Mid 在转身/摇头里二选一。
/// C 批：**深夜不跳舞**——High 档在 Night 换成张望（Look）。凌晨的活跃交给
/// 睡眠系统（Sleep 长槽），醒着的片刻安静点；Dance 的节拍 bob 在深夜违和。
pub(crate) fn ambient_wants_emote(band: AmbientBand, rnd: u32, time: TimeBand) -> Option<EmoteKind> {
    let pct = match band {
        AmbientBand::High => EMOTE_PCT_HIGH,
        AmbientBand::Mid => EMOTE_PCT_MID,
        AmbientBand::Low => EMOTE_PCT_LOW,
    };
    if rnd % 100 >= pct {
        return None;
    }
    Some(match (band, time) {
        (AmbientBand::High, TimeBand::Night) => EmoteKind::Look,
        (AmbientBand::High, _) => EmoteKind::Dance,
        (AmbientBand::Low, _) => {
            if rnd / 100 % 2 == 0 {
                EmoteKind::Shiver
            } else {
                EmoteKind::Look
            }
        }
        (AmbientBand::Mid, _) => {
            if rnd / 100 % 2 == 0 {
                EmoteKind::Turn
            } else {
                EmoteKind::Shake
            }
        }
    })
}

/// P1-a（2026-10-18，design/2026-10-18-pet-p1-idle-variants-and-marks.md §3.1）：
/// 主题的 ambient 行池（**变长**）。两条主题差异：
/// ① whale 没有 `review` 行——旧池里它踩 fallback 落 idle = **空转槽**
///    （R21 批的发现：池里放一个主题不存在的行，播它等于白播一次）；
/// ② whale 有 R21 切好的待机变体 `idle2`–`idle5`（r7–r10，站姿待机变体群），
///    入池后「待机不重样」第一次对 whale 成立。
/// kurumi 无待机变体、有 review ⇒ 池不变（P0 口径）。inverse 无图集，
/// 行池不被消费（立绘分支不看动作行）。
pub(crate) fn ambient_pool(mode: &str) -> &'static [&'static str] {
    match mode {
        "whale" => &["wave", "wait", "idle2", "idle3", "idle4", "idle5"],
        _ => &["wave", "review", "wait"],
    }
}

/// P1-a：行名 → 心情权重。`wave/review/wait` 随档位动（P0-F4 口径原样）；
/// 待机变体 `idle2`–`idle5` 与一切未列举行恒 1——它们的存在意义是
/// 「待机不重样」，不该被心情权重挤掉（心情只调节奏不调节目量）。
///
/// C 批（2026-10-19）：叠加**时段修正**（第三入参 `time`，纯函数可单测）——
/// ① 深夜把 `wave`（挥手，全池最活跃）无条件压到 1：心情再好，凌晨三点
///    不该老挥手（睡眠系统占槽时本就播不到，这里管的是「醒着的片刻」）；
/// ② 深夜/傍晚把安静行（`wait` 双手合十 / `idle2` 双手交叠 / `idle5` 尾翼弧度，
///    2026-10-19 逐帧视觉核验确认是站姿待机变体群中动静最低的三档）抬到 2。
/// 修正**只改概率不改节目单**：永不为 0——凌晨也可能想挥手，只是不该老挥；
/// 也永不新增行——池里没有的行权重多高都上不了场（P1-a 空转槽纪律）。
pub(crate) fn row_weight(row: &str, band: AmbientBand, time: TimeBand) -> u32 {
    let w = match (row, band) {
        ("wave", AmbientBand::High) => 3,
        ("review", AmbientBand::High) => 2,
        ("wait", AmbientBand::Low) => 3,
        _ => 1,
    };
    match (row, time) {
        ("wave", TimeBand::Night) => 1,
        ("wait" | "idle2" | "idle5", TimeBand::Night | TimeBand::Evening) => 2,
        _ => w,
    }
}

/// P0-F4 的 ambient 粘合层（取代 `pick_ambient_row` 的直接调用方）：
/// jump 特殊概率（AMBIENT_JUMP_PCT）保留 → emote 按心情概率 → 否则按**主题行池** +
/// 行级心情权重选行。「记忆状态」仍只有一处写（AMBIENT_LAST，E5 纪律）。
/// P1-a：`mode` 入参决定行池与行权重（主题相关）。
/// C 批：`time` 入参决定时段修正（深夜不跳舞、活跃行降压、安静行抬升）。
/// A 批：`has` 入参按**当前生效行集**过滤行池（P1-a 空转槽纪律的推广——
/// 新形象未必有全部行，如节日形象可能没有 `wave`；jump 特殊支同样受过滤）。
/// 过滤后池空 ⇒ 回落未过滤池（degenerate 形象至少维持 default 节奏，不回 blank）。
pub(crate) fn pick_ambient_choice(
    band: AmbientBand,
    mode: &str,
    time: TimeBand,
    has: &dyn Fn(&str) -> bool,
) -> AmbientChoice {
    if has("jump") && rand_u32() % 100 < AMBIENT_JUMP_PCT {
        return AmbientChoice::Row("jump".to_string());
    }
    if let Some(kind) = ambient_wants_emote(band, rand_u32(), time) {
        return AmbientChoice::Emote(kind);
    }
    let declared = ambient_pool(mode);
    let avail: Vec<&str> = declared.iter().copied().filter(|r| has(r)).collect();
    let pool: &[&str] = if avail.is_empty() { declared } else { &avail };
    let w: Vec<u32> = pool.iter().map(|r| row_weight(r, band, time)).collect();
    let rnd = rand_u32();
    let picked = AMBIENT_LAST.with(|c| {
        let next = pick_ambient_pool_index_weighted(rnd, c.get(), &w);
        c.set(Some(next));
        next
    });
    AmbientChoice::Row(pool[picked].to_string())
}

/// P0-F3：松手是否触发抛掷（纯函数）。速度 = `drag_vel`（R19 直跟手期每拍更新的
/// 窗口速度）；阈值 `THROW_VEL_MIN`（px/s）。抽成纯函数的理由：窗口层的分支
/// （依赖 hwnd/光标）只能靠源码契约查「文本在不在」，而「门被 `false &&` 掉」
/// 这类退化文本断言抓不到——判定本身必须可单测。
/// NaN 速度（理论不存在，但窗口层的值不该被信任）⇒ 不触发（失败方向取「不飞」）。
pub(crate) fn throw_triggered(vel: (f32, f32)) -> bool {
    let speed = (vel.0 * vel.0 + vel.1 * vel.1).sqrt();
    speed.is_finite() && speed >= THROW_VEL_MIN
}

/* ---------------- P0-F1（2026-10-18）：摸头与咬手 ---------------- */

/// 一次 `petting_tick` 的事件（纯数据，窗口层据此反应）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PetEvent {
    /// 无（持续中 / 未开始 / 冷却期）
    None,
    /// 摸了一下（光标在角色上连续停留 ≥ PET_HOLD_MS）
    Stroke,
    /// 咬手（窗口内累计 BITE_STROKES 次抚摸）——桌宠咬住光标不放
    Bite,
}

/// 摸头判定状态。**判据只有一条：光标连续命中角色不透明像素 ≥ PET_HOLD_MS**——
/// 刻意不设位移上限：「在头上来回划」正是抚摸（参考实现的摸头就是这个动作），
/// 而划过（离开角色）/ 按下（拖动或点击）都会打断连续性。
/// 参考：garfield-whale「连续摸头 5 次 → 咬住手进入冷却」。
pub(crate) struct Petting {
    /// 当前连续命中段的起点（None = 未在命中中）
    hold_since: Option<std::time::Instant>,
    /// 计数窗口内的累计抚摸次数
    strokes: u32,
    /// 计数窗口起点（BITE_WINDOW_MS 到期清零重计）
    window_since: std::time::Instant,
    /// 咬手冷却截止时刻（Some = 冷却中，抚摸无反应）
    cooldown_until: Option<std::time::Instant>,
}

impl Petting {
    pub(crate) fn new(now: std::time::Instant) -> Self {
        Petting { hold_since: None, strokes: 0, window_since: now, cooldown_until: None }
    }

    /// 冷却是否仍在（窗口层也可用来决定要不要播放「没空理你」的反应——P0 不播）。
    pub(crate) fn in_cooldown(&self, now: std::time::Instant) -> bool {
        self.cooldown_until.map(|t| now < t).unwrap_or(false)
    }
}

/// 每个命中轮询拍（10ms）调一次。`on_hit` = 光标命中角色不透明像素
/// （调用方用 `is_transparent_at` 的反值，与 R2 穿透判定同源）。
///
/// 三条规则（单测逐条钉死）：
/// ① `on_hit` 假 ⇒ 本段作废重计（划过去了不算摸）；
/// ② 连续命中 ≥ `hold_ms` ⇒ **一次 Stroke**，本段重新起算（摸着不放 = 一下一下地摸）；
/// ③ 窗口内累计 ≥ `BITE_STROKES` ⇒ **Bite** + 进冷却；冷却期内直接无反应。
pub(crate) fn petting_tick(
    st: &mut Petting,
    on_hit: bool,
    now: std::time::Instant,
    hold_ms: u64,
) -> PetEvent {
    // 冷却优先：咬着人不放的时候，抚摸不计数也不反馈
    if st.in_cooldown(now) {
        st.hold_since = None;
        return PetEvent::None;
    }
    if !on_hit {
        st.hold_since = None;
        return PetEvent::None;
    }
    let t0 = match st.hold_since {
        Some(t0) => t0,
        None => {
            st.hold_since = Some(now);
            return PetEvent::None;
        }
    };
    if now.duration_since(t0) < std::time::Duration::from_millis(hold_ms) {
        return PetEvent::None;
    }
    // —— 一次抚摸成立 ——
    st.hold_since = None;
    // 计数窗口过期 ⇒ 清零重计（「一小时摸五下」不触发）
    if now.duration_since(st.window_since) >= std::time::Duration::from_millis(BITE_WINDOW_MS) {
        st.strokes = 0;
        st.window_since = now;
    }
    st.strokes += 1;
    if st.strokes >= BITE_STROKES {
        st.strokes = 0;
        st.window_since = now;
        st.cooldown_until = Some(now + std::time::Duration::from_millis(BITE_COOLDOWN_MS));
        return PetEvent::Bite;
    }
    PetEvent::Stroke
}

/* ---------------- DPI 缩放判据（纯函数） ---------------- */

/// 基准 DPI。Win32 的 96 DPI 记为 100% 缩放，所有 scale 由它推出。
pub(crate) const DPI_BASE: u32 = 96;

/// 由 DPI 求缩放倍数（96 → 1.0、192 → 2.0）。
///
/// **为什么不能直接 `dpi as f32 / 96.0`**：结果是小数（125% → 1.25、175% → 1.828），
/// 而窗口尺寸必须是整数像素 ⇒ 浮点结果必须在这里一次性取整，**且取整方向要固定**。
/// 取整散落在各调用点时，窗口宽与 DIB 宽可能各自取整到不同值
/// （`UpdateLayeredWindow` 会静默拉伸填满，两者不一致就是「画面被拉扁一像素」）。
///
/// 判据四条（`dpi_scale` 的单测逐条钉住）：
/// ① `dpi == 0`（`GetDpiForWindow` 在无效 hwnd 上返回 0）⇒ 回落 1.0，**不返回 0**
///    ——0 会让窗口尺寸塌成 0×0，桌宠直接消失且无任何报错；
/// ② 下限 1.0：小于基准的 DPI 不缩（素材按 1:1 绘制即可，放到 0.5 只会糊）；
/// ③ 取整在**换算成像素时**做（见 `scaled_window_size`），**scale 本身保持精确**。
///    ——这里曾把 scale 量化到 0.5 档，被单测当场抓住：175%（dpi 168）被抬成 2.0、
///    144 与 168 撞成同一档，等于「两档不同缩放渲染成同样大小」。
///    量化是错的：DPI 档位由系统给定，不该由我们改写。
pub(crate) fn dpi_scale(dpi: u32) -> f32 {
    if dpi == 0 {
        return 1.0;
    }
    let s = dpi as f32 / DPI_BASE as f32;
    if s < 1.0 { 1.0 } else { s }
}

/// 把**素材基准尺寸**（`WIN_W`/`WIN_H`）换算成当前 DPI 下的**窗口物理尺寸**。
///
/// 这是 DPI 适配的唯一入口：`MoveWindow` / `CreateWindowExW` / DIB 的
/// `width`/`height` / `buf` 长度 / `Size` 全部走它，**保证四处永远同值**。
/// 分两处取整（先缩放后各自取整）是**故意**的：DIB 与 `Size` 必须逐字相等，
/// 而 `buf` 只需 ≥ 两者，取整方式不影响正确性。
pub(crate) fn scaled_window_size(base_w: i32, base_h: i32, dpi: u32) -> (i32, i32) {
    let s = dpi_scale(dpi);
    let w = (base_w as f32 * s).round() as i32;
    let h = (base_h as f32 * s).round() as i32;
    (w.max(1), h.max(1))
}

/// 把**逻辑像素量**（`DOCK_MARGIN_PX` 这类与 `character_local_rect` 配对推导的常量）
/// 换算成当前 DPI 下的物理像素量。
///
/// 与 `scaled_window_size` 分开是因为**它必须能被独立测试**：M4.1 的整套吸附/探头
/// 判据都建立在「`DOCK_MARGIN_PX` 恰等于帧内单侧留白」这个前提上
/// （`config.rs` / `model.rs` 的推导）。不缩放它，200% 下吸附时留白会从
/// 18 逻辑像素塌成 9 —— 桌宠「陷进」屏幕边缘，而不是设计里的「恰好贴边」。
pub(crate) fn scaled_px(px: i32, dpi: u32) -> i32 {
    (px as f32 * dpi_scale(dpi)).round() as i32
}

/* ---------------- R13：拖动目标推进（合帧的纯逻辑） ---------------- */

/// 把一个鼠标事件的位移**推进到逻辑目标**上。
///
/// **为什么抽成纯函数**（R13，2026-10-05）：合帧让 `pos` 滞后于事件流，于是「窗口该移到哪」
/// 变成一个**有状态的递推**——而递推的正确性无法靠肉眼核对（我方第一版就写错过：
/// 基准取 `GetWindowRect` 会丢位移、取按下点会变累计位移飞掉，见本函数注释）。
/// 抽出来才能单测。
///
/// **基准的选择是这个函数的全部要点**：
/// - 用「上一个逻辑目标」（`prev_target` 优先，为 `None` 时才回落窗口实际位置 `cur`）；
/// - **不能**用 `GetWindowRect` 的实时位置 —— 合帧下它滞后，被 flush 走的那段位移会丢；
/// - **不能**用按下点 —— 那会让 `dx/dy` 退化成累计位移，第二次事件就飞出去。
///
/// 同一次拖动内多次调用，末次结果应等于「按下点 → 末次光标」的**总位移**（可加性）。
#[inline]
pub(crate) fn advance_drag_target(
    prev_target: Option<(i32, i32)>,
    cur: (i32, i32),
    delta: (i32, i32),
) -> (i32, i32) {
    let base = prev_target.unwrap_or(cur);
    (base.0 + delta.0, base.1 + delta.1)
}

/* ---------------- R18：拖动起手阈值判定（纯逻辑） ---------------- */

/// 位移是否越过拖动起手阈值（**Manhattan 距离和**，严格大于）。
///
/// 主窗与悬浮球共用同一判定形（窗口层各传常量：`DRAG_THRESHOLD` /
/// `DOT_DRAG_THRESHOLD`）。抽成纯函数的理由：阈值比较是最容易写错边界的比较
/// （`>` 还是 `>=`、曼哈顿和还是欧氏距离），且 R18 起有两个调用点 ——
/// 口径分叉会让「球比桌宠难起手」这类差异无从解释。
#[inline]
pub(crate) fn drag_should_start(delta: (i32, i32), threshold: i32) -> bool {
    delta.0.abs() + delta.1.abs() > threshold
}

/* ---------------- R20：全屏覆盖判据（纯逻辑） ---------------- */

/// R20（2026-10-17，design/2026-10-17-pet-fullscreen-sfx-sprint.md §2.2）：前台窗口是否
/// 「真全屏」覆盖了桌宠所在显示器。
///
/// **五条判据逐条对应 Coopanion**（`electron-main.cjs:184-219` 的 `fullscreen()`，
/// 快照 `_refs/coopanion/`）——它把「最大化窗口被误判成全屏」这个经典坑用
/// `WS_CAPTION` 判据堵掉，是本条 worth-copy 的核心：
/// ① 前台有效且不是自己；② 无标题栏（`WS_CAPTION`）——带标题栏的普通窗口不算，
///    否则桌宠会在用户最大化浏览器时消失；③ 类名不是桌面本身（Progman / WorkerW）——
///    它们覆盖整个显示器但不是应用；④ 与桌宠同显示器（`same_monitor` 由调用方比好
///    HMONITOR 再传入——显示器句柄不进纯函数）；⑤ 四边**覆盖**显示器矩形。
///
/// Win32 依赖（取前台/样式/类名/矩形）全部留在窗口层，本函数只吃「已经取到的事实」，
/// 与 `classify_taskkill`（停机判据）同一分层先例。
pub(crate) fn foreground_is_fullscreen_cover(
    fg: isize,
    own: isize,
    same_monitor: bool,
    fg_style: u32,
    fg_class: &str,
    fg_rect: Rect,
    own_mon: Rect,
) -> bool {
    // ① 前台无效或是自己 ⇒ 不覆盖
    if fg == 0 || fg == own {
        return false;
    }
    // ② 带标题栏 ⇒ 普通窗口（最大化也算），不是全屏
    if fg_style & WS_CAPTION != 0 {
        return false;
    }
    // ③ 桌面本身的窗口（覆盖屏幕但不是应用）
    if fg_class == "Progman" || fg_class == "WorkerW" {
        return false;
    }
    // ④ 不同显示器 ⇒ 与「桌宠所在屏被盖」无关
    if !same_monitor {
        return false;
    }
    // ⑤ 四边覆盖（少一边都不算——贴边的视频窗口不算全屏）
    fg_rect.left <= own_mon.left
        && fg_rect.top <= own_mon.top
        && fg_rect.right >= own_mon.right
        && fg_rect.bottom >= own_mon.bottom
}

/* ---------------- R16：抓取热区（命中容差，纯逻辑） ---------------- */

/// 局部坐标 `(x, y)` 的 `± pad` 邻域内是否存在「不透明像素」（`alpha >= alpha_min`）。
///
/// **背景（R16，2026-10-12）**：R2 的命中判定是**逐像素 alpha**。而桌宠立绘在窗口内只占
/// 中间一条 —— 实机网格扫描（whale 主题）显示：窗口 286×390 里可点区只有约 **110×180
/// （≈18%）**，左右各 ~55px 留白与角色上方/底部大片区域点上去**直接穿透到桌面** ⇒
/// 用户报的「桌宠很难拖动 / 拖不动」。
///
/// **为什么是「膨胀」而不是「放宽阈值」**：把 `CLICK_THROUGH_ALPHA` 从 16 降到 8 只能多出
/// 抗锯齿的那 1–2px —— 抓不住的根因是「角色旁边**真的没有像素**」，不是「像素太淡」。
/// 膨胀 pad 像素才能把「贴着轮廓的空白」纳入可点区，同时**不**把远离角色的角落变成
/// 隐形挡板（那会让桌宠挡住整块桌面的点击，比抓不住更糟）。
///
/// **越界即穿透**：窗口外恒 `false`，膨胀不会让桌宠吃窗口外的点击。
///
/// 纯逻辑（只读 `buf` 切片，不碰 Win32）⇒ 与 `pick_dock_edge` 同口径，可直编单测。
/// `buf` 是预乘 `0xAARRGGBB`（与 `load_png` / `blit_*` / `is_transparent_at` 同源）。
pub(crate) fn grab_hit(
    buf: &[u32],
    w: i32,
    h: i32,
    x: i32,
    y: i32,
    pad: i32,
    alpha_min: u32,
) -> bool {
    if w <= 0 || h <= 0 || x < 0 || y < 0 || x >= w || y >= h {
        return false;
    }
    if buf.len() < (w as usize) * (h as usize) {
        return false;
    }
    let pad = pad.max(0);
    let x0 = (x - pad).max(0);
    let x1 = (x + pad).min(w - 1);
    let y0 = (y - pad).max(0);
    let y1 = (y + pad).min(h - 1);
    for yy in y0..=y1 {
        let row = (yy * w) as usize;
        for xx in x0..=x1 {
            if ((buf[row + xx as usize] >> 24) & 0xFF) >= alpha_min {
                return true;
            }
        }
    }
    false
}

/* ---------------- R20-a 修正 · 显隐分支的触发条件（纯函数） ---------------- */

/// compose 的显隐切换分支**这一拍要不要执行**（R20-a 2026-10-18 实机闪烁事故的修正）。
///
/// **事故与根因**：原条件是 `want_hide == shown || (fs_hidden && !want_hide)`。后半段
/// 是**电平触发**——全屏规则藏着桌宠时用户的常驻意图 `want_hide` 恒为 `false`
/// （影子 `shown` 仍是 true），于是 compose 每拍都执行「显示 + 清规则态」，
/// `fs_poll` 下一拍再藏 ⇒ 桌宠在全屏应用上每 ~250ms 眨一次
/// （实机 2.3 小时刷出 2991 条 `auto-hidden`、0 条 `restored`——
/// 恢复日志永远不出现，因为规则态每拍就被 compose 清掉，fs_poll 轮不到恢复分支）。
///
/// **修正**：逃逸必须是**边沿触发**——只在 `want_hide` 出现「true → false」下降沿
/// （用户主动把「隐藏」关掉）时放行一次。常驻的 `want_hide == false` 不再触发。
/// 逃逸后规则按既定语义在下一拍重新生效（Coopanion 同口径），但不再循环。
///
/// 判据（逐条有单测）：
/// ① 影子与意图不符（`want_hide == shown`）⇒ 执行（原语义，自清除：跑完 shown 对齐即假）；
/// ② 规则隐藏中 + 用户**刚**取消隐藏（下降沿）⇒ 执行一次（逃逸出口）；
/// ③ 规则隐藏中 + 常驻「想显示」但**无下降沿** ⇒ **不执行**（闪烁根因，本例是回归防线）；
/// ④ 其余稳态 ⇒ 不执行。
pub(crate) fn show_branch_should_run(
    want_hide: bool,
    shown: bool,
    fs_hidden: bool,
    want_hide_falling_edge: bool,
) -> bool {
    want_hide == shown || (fs_hidden && want_hide_falling_edge)
}

/* ---------------- M4.1 · 边缘停靠（吸附，纯逻辑） ---------------- */

/// 屏幕边缘（M4.1）。`None` = 不贴边。
///
/// **派生 serde**：M4.1 起要随 `pet.json` 落盘（记住停靠在哪条边），
/// 序列化形态是字符串（`"Left"` / `"Right"` / …）。旧文件缺该字段时由
/// 字段上的 `#[serde(default)]` 兜成 `None`（见 `persist::PetStateV2`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DockEdge {
    Left,
    Right,
    Top,
    Bottom,
}

/// 贴边时窗口与工作区边缘的**预留间距**（px）。
///
/// **为什么不是 0**：角色帧在窗口内有左右留白（实测渲染宽 249 / 窗口宽 286 ⇒ 每侧约 18px，
/// 见 `window.rs::blit_center_bottom` 的居中口径）。贴死边缘会让那 18px 留白也贴到屏幕上，
/// 观感是「桌宠悬在屏幕外沿」而不是「靠在边上」。取 18 恰好等于单侧留白 ⇒ 角色本体贴边。
pub(crate) const DOCK_MARGIN_PX: i32 = 18;

/// 判定该吸附到哪条边；不满足条件返回 `None`。
///
/// **判据 = 角色可见区域与工作区边缘的距离 ≤ `DOCK_MARGIN_PX`**，
/// 而不是「窗口原点距边缘」—— 后者会把那 18px 留白算进去，导致角色本体离屏幕还有 18px。
///
/// **四条边独立判定、最多命中一条**：窗口尺寸远小于任一工作区，
/// 实践中不可能同时贴两条边；若真同时命中（上例：角落），按 `Left/Right` 优先
/// （横向贴边观感最明确，且 probe 那侧的手势是水平拖动）。
///
/// **纯函数**：入参是「角色可见区域」与「工作区」，都已是窗口坐标 —— 不碰 Win32，
/// 故可 `rustc --test` 直编单测。
///
/// DPI(2026-10-05)：`margin` 是**物理像素**下的吸附阈值（`scaled_px(DOCK_MARGIN_PX, dpi)`），
/// 由调用方传入而非本函数读常量 —— 纯函数层不该知道 DPI，且便于单测直接喂任意阈值。
/// 传 `DOCK_MARGIN_PX` 即 100% 缩放下的原值。
pub(crate) fn pick_dock_edge(role: Rect, work: Rect, margin: i32) -> Option<DockEdge> {
    // 角色区域完全在工作区外 ⇒ 不该吸附（那是「屏幕外」，由 pos_visible 兜底回默认位置）
    if role.right <= work.left || role.left >= work.right || role.bottom <= work.top
        || role.top >= work.bottom
    {
        return None;
    }
    let d_left = role.left - work.left;
    let d_right = work.right - role.right;
    let d_top = role.top - work.top;
    let d_bottom = work.bottom - role.bottom;
    let m = margin;
    // 先横向再纵向（见上方注释的理由）
    if d_left <= m {
        return Some(DockEdge::Left);
    }
    if d_right <= m {
        return Some(DockEdge::Right);
    }
    if d_top <= m {
        return Some(DockEdge::Top);
    }
    if d_bottom <= m {
        return Some(DockEdge::Bottom);
    }
    None
}

/// 把已吸附的窗口位置沿指定边**推出**工作区，使角色可见区域与边缘的距离恰为 `DOCK_MARGIN_PX`。
///
/// **契约（2026-10-13 订正，实机障故 E30）**：
/// · `role` 是角色可见区域的**绝对（屏幕）矩形**（调用方 `pos + 局部矩形` 得到），
///   **不是**窗口局部矩形 —— 局部口径下本函数对工作区的交集检查会恒真、失去保护意义；
/// · 返回值是**目标窗口位置**（左上角），**不是**位移。
///
/// 旧实现把返回值写成 `pos + dx`，而 `dx` 本身已是「目标窗口坐标」⇒ 旧 `pos` 被**多加一份**，
/// 贴边松手时窗口被整体推飞一个「旧坐标」的量：Right 边横向飞出 ≈ 旧 x、Bottom 边纵向
/// 飞出 ≈ 旧 y。实机日志两例与公式逐像素吻合（`design/CHANGELOG.md` 2026-10-13 条）：
/// 松手点 (2257,917) 判 Right ⇒ 落盘 (4513,917)（= 2257 + (2560−18−286)，飞出主屏右侧）；
/// 松手点 (2241,1036) 判 Bottom ⇒ 落盘 (2241,2068)（= 1036 + (1440−18−390)，整窗出屏）。
/// 飞出后光标够不着、运行中无兜底 ⇒ 用户体感「一碰边缘就消失、回不来」。
///
/// **为什么旧单测全绿**：四条 `dock_push_out` 单测**一律用 `pos = (0,0)`** ——
/// 该基准下「目标位置」与「位移」恒等，夹具把缺陷喂饱了全部绿灯
/// （与 appearance 线「夹具喂饱了 bug」同族；判据必须能在**非零基准**上区分两种语义）。
///
/// **为什么是「恰好等于」而不是「至少」**：贴边后若仍有多余外移量，角色会明显悬在屏幕外
/// （用户看到的是"桌宠有一截在屏外"，而 R3 的 `pos_visible` 只按**角色区域**判可见，
/// 不会把它拉回来）。
///
/// **依赖 `pick_dock_edge` 的不变量**：调用方必须先判过边 —— 本函数只负责「推出多少」，
/// 不判断「该不该推」（混在一起会让「角落同时贴两边」的情形无法表达）。
///
/// 返回 `None` 表示 `role` 与该工作区无交集（推出去会跑错屏）——调用方应保持原位。
///
/// DPI(2026-10-05)：`margin` 语义同 `pick_dock_edge`（物理像素，由调用方按 DPI 换算）。
pub(crate) fn dock_push_out(
    pos: (i32, i32),
    role: Rect,
    work: Rect,
    edge: DockEdge,
    margin: i32,
) -> Option<(i32, i32)> {
    // 角色区域与工作区无交集 ⇒ 跨屏推算无意义（会出现窗口跑掉一整屏）
    if role.right <= work.left || role.left >= work.right || role.bottom <= work.top
        || role.top >= work.bottom
    {
        return None;
    }
    // role 是绝对矩形 ⇒ 减出「角色在窗口内的偏移」，再据边求**目标窗口坐标**
    let lx = role.left - pos.0;
    let rx = role.right - pos.0;
    let ty = role.top - pos.1;
    let by = role.bottom - pos.1;
    let target = match edge {
        // 角色左边要距工作区左边 m ⇒ 窗口 x = work.left + m − 角色在窗内的左偏移
        DockEdge::Left => (work.left + margin - lx, pos.1),
        DockEdge::Right => (work.right - margin - rx, pos.1),
        DockEdge::Top => (pos.0, work.top + margin - ty),
        DockEdge::Bottom => (pos.0, work.bottom - margin - by),
    };
    Some(target)
}

/* ---------------- M4.1 · 边缘探头（peek）状态机 ---------------- */

/// peek 相位。照参考实现的六态（`pet/edge_probe.py:32-39`）逐字对齐：
/// `OFF / ENTERING / PEEKING / STRAIGHTENING / STRAIGHTENED / RETURNING`。
///
/// 与参考的差异只有一处：我方先不做 ±45° 旋转姿态（无旋转帧素材，会暴露预乘插值边缘问题，
/// 见 benchmark §2.4 结论），「拉直」在本实现里 = 从常驻档（0.55）探出到 engage 档（0.82），
/// 旋转留待素材就绪后再叠加。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PeekPhase {
    /// 吸附位（全可见），静置计时中。
    Off,
    /// 静置到期，正滑向常驻档（0.55）。
    Entering,
    /// 常驻缩边（露出 0.55）。
    Peeking,
    /// 光标压上/点击，正滑向 engage 档（0.82）。
    Straightening,
    /// 已拉直（露出 0.82），等待光标离开后再静置。
    Straightened,
    /// 拉直后再次静置，正退回常驻档。
    Returning,
}

/// peek 状态：相位 + 当前沿停靠边的**外移量**（px）。
///
/// **为什么存 `slide`（px）而不是 exposure（比例）**：吸附位本身带 `DOCK_MARGIN_PX`
/// 预留间距，「露出比例」与「外移量」之间差着这一段（推导见 `peek_slide_target`）——
/// 若在比例上插值，e=1 会对应 slide=18px 的假位移（动画起步先空走 18px）。
/// 在外移量上插值，0 = 吸附位，语义干净。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct PeekState {
    pub(crate) phase: PeekPhase,
    /// 当前沿停靠边的外移量（px；0 = 吸附位，越大越出屏）。
    pub(crate) slide: f32,
    /// 本段过渡的起点外移量（kick 时锁定，支持「过渡中途被打断」——
    /// 例如 Entering 走到一半光标压上，Straightening 必须从当前 slide 起步，不能跳变）。
    pub(crate) from: f32,
    /// 本段过渡已推进的毫秒。
    pub(crate) elapsed: f32,
}

impl PeekState {
    pub(crate) fn off() -> Self {
        PeekState { phase: PeekPhase::Off, slide: 0.0, from: 0.0, elapsed: 0.0 }
    }
}

/// 垂直于停靠边的「角色可见区域」跨度——**露出比例的分母**。
///
/// R14 的关键口径「分母 = 当前姿态投影 bbox 跨度」在本实现的对应物：
/// `character_local_rect()` 的宽（Left/Right）或高（Top/Bottom）。我方无旋转姿态，
/// 该矩形就是当前姿态的投影 bbox（保守取整窗宽，见其注释）——分母口径同源复用。
pub(crate) fn peek_extent(role: Rect, edge: DockEdge) -> i32 {
    match edge {
        DockEdge::Left | DockEdge::Right => role.right - role.left,
        DockEdge::Top | DockEdge::Bottom => role.bottom - role.top,
    }
}

/// 露出 `exposure` 比例时，角色区域应沿停靠边**越出工作区多少**（px）。
///
/// 推导（以 Left 边为例，slide 为外移量）：吸附位把角色区域顶在离工作区边
/// `DOCK_MARGIN_PX` 处，外移 slide 后角色区域可见带宽 = `extent + M − slide`
/// （slide ≤ M 时未开始裁切，全可见）⇒ 令可见 = exposure×extent：
/// `slide = (1 − exposure) × extent + M`。
/// 「+M」就是那 18px 预留间距：外移要先吃掉它，角色本体才开始没入屏外。
/// peek 的目标外移量。`margin` 语义同 `pick_dock_edge`（物理像素，由调用方按 DPI 换算）。
pub(crate) fn peek_slide_target(role: Rect, edge: DockEdge, exposure: f32, margin: i32) -> f32 {
    (1.0 - exposure) * peek_extent(role, edge) as f32 + margin as f32
}

/// smoothstep 缓动（两端零速度）。300ms 的短过渡用线性会有「撞墙」感，
/// smoothstep 是最短的表达；严格单调 ⇒ 动画不会回退。
fn peek_ease(p: f32) -> f32 {
    let p = p.clamp(0.0, 1.0);
    p * p * (3.0 - 2.0 * p)
}

/// 推进过渡动画（compose 33ms 节拍调用，`dt_ms` 用真实经过的毫秒）。
///
/// **真实 dt 的理由**（R14 的 pause/resume 口径）：窗口隐藏/系统挂起时 compose 不跑，
/// 恢复后第一拍的 dt 会很大——但相位推进只按「实际流逝的动画时间」走，
/// 隐藏时长不会偷走进度（否则恢复后姿态从半途跳完，正是 R14 点名的缺陷）。
/// 调用方负责把 dt 夹到安全区间（防挂起后首拍暴走）。
///
/// **纯函数**：入参只有状态与几何，不碰 Win32 ⇒ 可 `rustc --test` 直编单测。
///
/// DPI(2026-10-05)：`margin` 语义同 `pick_dock_edge`（物理像素）。**必须与 `role` 同源**
/// —— role 若已是物理尺寸而 margin 仍是基准值，探头跨距会算短（200% 下少露 45%）。
pub(crate) fn peek_advance(st: &mut PeekState, role: Rect, edge: DockEdge, margin: i32, dt_ms: u32) {
    let (dur, to) = match st.phase {
        PeekPhase::Entering => (
            PEEK_ENTER_MS,
            peek_slide_target(role, edge, PEEK_REST_EXPOSURE, margin),
        ),
        PeekPhase::Straightening => (
            PEEK_STRAIGHTEN_MS,
            peek_slide_target(role, edge, PEEK_ENGAGE_EXPOSURE, margin),
        ),
        PeekPhase::Returning => (
            PEEK_RETURN_MS,
            peek_slide_target(role, edge, PEEK_REST_EXPOSURE, margin),
        ),
        // 非过渡相位：slide 已停在目标上，无可推进
        _ => return,
    };
    st.elapsed += dt_ms as f32;
    let p = peek_ease(st.elapsed / dur as f32);
    st.slide = st.from + (to - st.from) * p;
    if st.elapsed >= dur as f32 {
        st.slide = to;
        st.phase = match st.phase {
            PeekPhase::Entering | PeekPhase::Returning => PeekPhase::Peeking,
            PeekPhase::Straightening => PeekPhase::Straightened,
            _ => st.phase,
        };
    }
}

/// 静置到期：`Off → Entering`。其余相位忽略（边界检测由窗口层按相位分派，双保险）。
pub(crate) fn peek_kick_idle(st: &mut PeekState) {
    if st.phase != PeekPhase::Off {
        return;
    }
    st.from = st.slide;
    st.elapsed = 0.0;
    st.phase = PeekPhase::Entering;
}

/// 光标压上 / 点击：进入拉直过渡。允许从任何「探头侧」相位发起
/// （Entering 走到一半被摸、Returning 退到一半被摸，都从当前 slide 平滑接续）。
pub(crate) fn peek_kick_engage(st: &mut PeekState) {
    match st.phase {
        PeekPhase::Peeking | PeekPhase::Entering | PeekPhase::Returning => {
            st.from = st.slide;
            st.elapsed = 0.0;
            st.phase = PeekPhase::Straightening;
        }
        _ => {}
    }
}

/// 拉直后再次静置：`Straightened → Returning`（退回常驻档，不是退回吸附位——
/// 用户没有拖走它，它就该继续探头）。
pub(crate) fn peek_kick_return(st: &mut PeekState) {
    if st.phase != PeekPhase::Straightened {
        return;
    }
    st.from = st.slide;
    st.elapsed = 0.0;
    st.phase = PeekPhase::Returning;
}

/// 脱离探头：回吸附位（slide=0、Off）。触发点：拖动开始 / 位置重置 / 气泡（尤其审批）出现。
///
/// **为什么是瞬移而不是动画**：气泡出现的同一拍窗口位置必须已经回到全可见——
/// 气泡画在窗口上部、随窗口平移，若是 300ms 滑出动画，气泡前几帧仍被裁在屏外
/// （审批按钮不可点 = 功能回归）。瞬移 + 气泡同帧出现，读感是「它跳出来汇报」，成立。
pub(crate) fn peek_reset(st: &mut PeekState) {
    *st = PeekState::off();
}

/// 按当前外移量求窗口位置（`docked` = 吸附位，即 `dock_push_out` 的结果）。
///
/// 方向：Left/Top 是负向（坐标减小），Right/Bottom 是正向——**这是最容易写反的地方**，
/// 由单测逐边钉住（`peek_window_pos_moves_toward_off_screen_per_edge`）。
pub(crate) fn peek_window_pos(docked: (i32, i32), edge: DockEdge, slide: f32) -> (i32, i32) {
    let s = slide.round() as i32;
    match edge {
        DockEdge::Left => (docked.0 - s, docked.1),
        DockEdge::Right => (docked.0 + s, docked.1),
        DockEdge::Top => (docked.0, docked.1 - s),
        DockEdge::Bottom => (docked.0, docked.1 + s),
    }
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

    /// M2 回归:Error/FleetBlocked 播 failed;Thinking(工作态)压过手势与环境编排,播 run(坐姿打字)。
    #[test]
    fn busy_beats_gesture_and_ambient() {
        let jump = slot(Action::Jump, 900);
        let amb = slot(Action::Ambient { row: "wave".into() }, 1500);
        assert_eq!(pick_state_row(PetState::Thinking, Some(&jump)), "run");
        assert_eq!(pick_state_row(PetState::Thinking, Some(&amb)), "run");
        assert_eq!(pick_state_row(PetState::Thinking, None), "run");
    }

    /// L0-1(v5):散步按方向选行——`dx` 不再被丢弃,runRight/runLeft 各 8 帧首次上场。
    #[test]
    fn wander_picks_row_by_direction() {
        let right = slot(Action::Wander { dx: 1 }, 1800);
        let left = slot(Action::Wander { dx: -1 }, 1800);
        assert_eq!(pick_state_row(PetState::Idle, Some(&right)), "runRight");
        assert_eq!(pick_state_row(PetState::Idle, Some(&left)), "runLeft");
        // 兜底:dx=0(当前不产生)按向右处理,不落进非法行名
        let still = slot(Action::Wander { dx: 0 }, 1800);
        assert_eq!(pick_state_row(PetState::Idle, Some(&still)), "runRight");
    }

    /// L0-2(v5):`run`(坐姿打字)专属工作态——散步槽不再占用它,
    /// 否则「工作态可读」与「散步方向正确」会互相污染(同一行名两种语义)。
    #[test]
    fn working_row_is_reserved_for_thinking() {
        let walk = slot(Action::Wander { dx: 1 }, 1800);
        assert_eq!(pick_state_row(PetState::Thinking, Some(&walk)), "run");
        assert_eq!(pick_state_row(PetState::Idle, Some(&walk)), "runRight");
        assert_eq!(pick_state_row(PetState::Idle, None), "idle");
    }

    #[test]
    fn action_rows_map_by_kind() {
        let amb = slot(Action::Ambient { row: "review".into() }, 1500);
        let wander = slot(Action::Wander { dx: 1 }, 1800);
        let hold = slot(Action::JumpHold, 200);
        assert_eq!(pick_state_row(PetState::Idle, Some(&amb)), "review");
        assert_eq!(pick_state_row(PetState::Idle, Some(&wander)), "runRight");
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

    /// E5：ambient 池**不得连播同一条**。
    ///
    /// 遍历全部 `0..1000` 的随机数 × 全部 3 种「上次值」，断言输出**恒不等于**上次 ——
    /// 这是「去重」这件事的完整定义（只抽样几个 case 会漏掉偏移公式的边界）。
    /// P0-F4 起走加权版；此处用 `[1,1,1]`（= Mid 档权重）保持 E5 原口径。
    #[test]
    fn ambient_pool_never_repeats_previous() {
        for last in [None, Some(0usize), Some(1), Some(2)] {
            for rnd in 0..1000u32 {
                let idx = pick_ambient_pool_index_weighted(rnd, last, &[1, 1, 1]);
                assert!(idx < 3, "索引越界：{idx}（池只有 3 项）");
                if let Some(prev) = last {
                    assert_ne!(idx, prev, "rnd={rnd} 时选了 {idx}，与上次相同 —— 去重失效");
                }
            }
        }
    }

    /// E5·反向：把去重偏移抹掉（退回 `rand % 3`）时，上面那条必须转红。
    /// 钉住「测试真的在测去重」——否则一个恒真的断言也能全绿。
    ///
    /// **序列必须真无规律，不能用等差步长**（这条是被负向验证逼出来的，两轮都踩了）：
    ///  · `0..3000` 递增 ⇒ `rnd % 3` 是 `0,1,2,0,1,2…`，**恒不连续相同**（连播数恒 0）
    ///    ⇒ 对照组彻底失效、断言会绿着一个不存在的行为；
    ///  · 「换成互质步长」也不行：`i*7+1` / `i*5+2` / `i*11+3` 对 3 取模仍严格循环（连播数仍 0）。
    /// 唯一可用的是**乘法散列**（Knuth）：`(i * 2654435761) >> 0` 后取模，
    /// 实测连播数 ≈1030/3000，既有规律又覆盖各种相位。
    /// 它是纯位运算，**不引入任何 RNG 依赖**（守 `ARCHITECTURE.md` 的零新增依赖铁律）。
    #[test]
    fn ambient_repeat_probability_is_actually_reduced() {
        const POOL_LEN: usize = 3;
        // 对照：均匀随机（E5 之前的行为）—— 必须真的出现连播，否则本测试的对照无效
        let mut same = 0u32;
        let mut last = 0usize;
        for i in 0..3000u32 {
            let idx = ((i.wrapping_mul(2_654_435_761)) as usize) % POOL_LEN;
            if i > 0 && idx == last { same += 1; }
            last = idx;
        }
        assert!(same > 0,
            "对照：均匀随机在乘法散列序列上必然出现连播（实测 0 ⇒ 对照序列退化，本测试失效）");

        // 被测：去重后连续两次同行应**严格为 0 次**（「小于」不够——必须是 0）。
        let mut last_opt: Option<usize> = None;
        let mut same_after = 0u32;
        for i in 0..3000u32 {
            let rnd = i.wrapping_mul(2_654_435_761);
            let idx = pick_ambient_pool_index_weighted(rnd, last_opt, &[1, 1, 1]);
            if i > 0 && Some(idx) == last_opt { same_after += 1; }
            last_opt = Some(idx);
        }
        assert_eq!(same_after, 0, "去重后不得出现连播同一条");
    }

    /// E5：首次调用时无「上次」可避（原实现行为），且不得 panic。
    #[test]
    fn ambient_first_call_has_no_previous() {
        let idx = pick_ambient_pool_index_weighted(12345, None, &[1, 1, 1]);
        assert!(idx < 3, "首次调用仍须给出合法索引");
    }

    /// R13：拖动目标推进的**可加性** —— 合帧下最要紧的性质。
    ///
    /// 模拟真实事件流：窗口在 `(100,100)`，鼠标按下于 `(150,150)`，随后 1000Hz 移动，
    /// **每 2 个事件才 flush 一次**（合帧比 1kHz 慢 ⇒ 中间目标会被覆盖）。
    /// 断言：末次目标 == 窗口起点 + 总位移。这是「合帧不丢位移」的完整定义。
    #[test]
    fn drag_target_is_additive_across_coalesced_events() {
        let origin = (100, 100);
        let press = (150, 150);
        let mut cur = origin; // 窗口实际位置（合帧后才会跟上）
        let mut target: Option<(i32, i32)> = None;
        let mut prev_cursor = press;

        // 1000Hz 光标，每事件 1px ⇒ 合计走 100px
        for i in 1..=100 {
            let cursor = (press.0 + i, press.1); // 只走 x
            let delta = (cursor.0 - prev_cursor.0, cursor.1 - prev_cursor.1);
            target = Some(advance_drag_target(target, cur, delta));
            prev_cursor = cursor;
            // 每 2 拍 flush 一次（合帧节拍比事件率慢 ⇒ 必然发生覆盖）
            if i % 2 == 0 {
                cur = target.unwrap();
                target = None;
            }
        }
        // 末次目标（未 flush 的那一份）优先，没有则用已 flush 的窗口位置
        let final_pos = target.unwrap_or(cur);
        assert_eq!(final_pos, (origin.0 + 100, origin.1),
            "合帧丢了位移：期望 x={}，实得 {:?}", origin.0 + 100, final_pos);
    }

    /// R13·反例：基准若错用「窗口实时位置」，合帧会丢位移。
    ///
    /// 这条把「为什么不能取 `GetWindowRect`」钉成可执行断言：**真正的错误实现**
    /// （每次都以尚未 flush 的 `cur` 为基准）必须算出**错误的**总位移。
    /// 若它恰好算出正确答案，说明这个反例没测到东西（初版就踩了这个坑：
    /// 「错误实现」里每次都推进了 `cur`，位移根本没丢，对照组完全无效）。
    #[test]
    fn drag_would_lose_distance_with_live_rect_baseline() {
        let origin = (100, 100);
        let press = (150, 150);
        // 错误实现：基准恒取 `cur`，而 `cur` **只在 flush 时推进**（这就是合帧的滞后）
        let mut cur = origin;
        let mut prev_cursor = press;
        for i in 1..=100 {
            let cursor = (press.0 + i, press.1);
            let delta = (cursor.0 - prev_cursor.0, cursor.1 - prev_cursor.1);
            // ✗ 错：base = cur（未 flush 时不推进）⇒ 被覆盖的那段位移丢失
            let base = cur;
            // 每拍只算一个目标，奇数拍的那份被下一拍覆盖（合帧的滞后即由此产生）
            let target = (base.0 + delta.0, base.1 + delta.1);
            prev_cursor = cursor;
            if i % 2 == 0 {
                // 错实现里 flush 会写回 `cur`（所以它确实是「看起来能跑」的错误实现）
                cur = target;
            }
        }
        // 错实现的总位移：每 2 拍只推进 1px（第一批的第二拍被覆盖）⇒ 50px 而非 100px
        assert_eq!(cur.0 - origin.0, 50,
            "对照组失效：错误实现本应只走一半（50px），实得 {}px —— 若等于 100 则本用例测不到东西",
            cur.0 - origin.0);
    }

    /// R13：首次调用（无历史目标）必须以窗口实际位置为基准。
    #[test]
    fn drag_first_event_uses_window_position() {
        let cur = (200, 300);
        assert_eq!(advance_drag_target(None, cur, (5, -7)), (205, 293));
    }

    /// R13：零位移事件不得改变目标（避免无谓的 MoveWindow）。
    #[test]
    fn drag_zero_delta_keeps_target() {
        let cur = (10, 10);
        let t = Some((50, 60));
        assert_eq!(advance_drag_target(t, cur, (0, 0)), (50, 60),
            "零位移必须原样返回 —— 窗口层据此跳过 MoveWindow");
    }

    /* ---------------- R18 · 拖动起手阈值 ---------------- */

    /// R18-1：阈值比较是**严格大于**的曼哈顿和——和恰等于阈值时不算起手
    /// （「轻点手抖」与「开始拖」的分界必须可预测）。
    #[test]
    fn drag_should_start_uses_strict_manhattan_sum() {
        assert!(!drag_should_start((2, 2), 4), "和=4 恰等于阈值 ⇒ 未越");
        assert!(drag_should_start((2, 3), 4), "和=5 ⇒ 已越");
        assert!(!drag_should_start((0, 0), 4), "零位移恒不越");
        // 与悬浮球阈值（6）同形工作
        assert!(!drag_should_start((3, 3), 6), "球：和=6 恰等于阈值 ⇒ 未越");
        assert!(drag_should_start((3, 4), 6), "球：和=7 ⇒ 已越");
    }

    /// R18-2：方向无关（负轴同样按绝对值计），且两个调用点共用一形。
    #[test]
    fn drag_should_start_is_direction_agnostic() {
        assert!(!drag_should_start((-2, -2), 4));
        assert!(drag_should_start((-5, 0), 4));
        assert!(drag_should_start((0, 5), 4));
        // 单轴大幅也越（沿屏幕边拖的场景）
        assert!(drag_should_start((0, -100), 4));
    }

    /* ---------------- R20 · 全屏覆盖判据 ---------------- */

    /// R20 的夹具：2560×1440 显示器，无标题栏前台窗四边覆盖它。
    fn mon() -> Rect {
        Rect { left: 0, top: 0, right: 2560, bottom: 1440 }
    }

    /// R20-1：无标题栏 + 四边覆盖 ⇒ 算全屏（真游戏/视频全屏的主路径）。
    #[test]
    fn fullscreen_cover_matches_captionless_full_rect() {
        let fg = Rect { left: 0, top: 0, right: 2560, bottom: 1440 };
        assert!(foreground_is_fullscreen_cover(77, 66, true, 0, "UnityWndClass", fg, mon()));
    }

    /// R20-2：**带标题栏不算**——这条是防「最大化浏览器时桌宠消失」的核心判据。
    #[test]
    fn maximized_window_with_caption_is_not_fullscreen() {
        // 最大化窗口的矩形通常也覆盖整屏，差别就在 WS_CAPTION
        let fg = Rect { left: 0, top: 0, right: 2560, bottom: 1440 };
        assert!(!foreground_is_fullscreen_cover(
            77, 66, true, WS_CAPTION, "Chrome_WidgetWin_1", fg, mon()
        ));
        // 对照：同矩形去掉 caption 位就算（证明是 caption 在起作用，不是矩形）
        assert!(foreground_is_fullscreen_cover(
            77, 66, true, 0, "Chrome_WidgetWin_1", fg, mon()
        ));
    }

    /// R20-3：桌面本身的窗口（Progman / WorkerW）不算——它们覆盖屏幕但不是应用。
    #[test]
    fn desktop_windows_are_not_fullscreen_apps() {
        let fg = Rect { left: 0, top: 0, right: 2560, bottom: 1440 };
        assert!(!foreground_is_fullscreen_cover(77, 66, true, 0, "Progman", fg, mon()));
        assert!(!foreground_is_fullscreen_cover(77, 66, true, 0, "WorkerW", fg, mon()));
    }

    /// R20-4：前台是自己 / 无效 / 不同显示器 / 部分覆盖，全部不算。
    #[test]
    fn self_invalid_other_monitor_and_partial_rect_are_not_cover() {
        let full = Rect { left: 0, top: 0, right: 2560, bottom: 1440 };
        assert!(!foreground_is_fullscreen_cover(66, 66, true, 0, "Game", full, mon()), "自己不算");
        assert!(!foreground_is_fullscreen_cover(0, 66, true, 0, "Game", full, mon()), "前台无效不算");
        assert!(!foreground_is_fullscreen_cover(77, 66, false, 0, "Game", full, mon()), "不同显示器不算");
        // 贴边视频窗：差 2px 覆盖不到顶 ⇒ 不算（少一边都不行）
        let partial = Rect { left: 0, top: 2, right: 2560, bottom: 1440 };
        assert!(!foreground_is_fullscreen_cover(77, 66, true, 0, "Video", partial, mon()));
    }

    /// R20-5：副屏几何（负坐标显示器）同样成立——虚拟桌面左置副屏是常见布局。
    #[test]
    fn cover_works_on_negative_coordinate_monitors() {
        let m = Rect { left: -2560, top: 0, right: 0, bottom: 1440 };
        let fg = Rect { left: -2560, top: 0, right: 0, bottom: 1440 };
        assert!(foreground_is_fullscreen_cover(77, 66, true, 0, "Game", fg, m));
        // 右缘差 2px 没够到显示器右边（0）⇒ 不算（首版把 right 写成 +2，那其实覆盖得更满）
        let partial = Rect { left: -2560, top: 0, right: -2, bottom: 1440 };
        assert!(!foreground_is_fullscreen_cover(77, 66, true, 0, "Game", partial, m));
    }

    /// R20-6：**反向验证**：把五条判据逐条「打穿」都必须能观察到 false
    /// （防将来有人合并/弱化条件——每条的存在性都由这条钉住）。
    #[test]
    fn each_cover_condition_is_load_bearing() {
        let full = Rect { left: 0, top: 0, right: 2560, bottom: 1440 };
        let m = mon();
        // 条件①：fg == own
        assert!(!foreground_is_fullscreen_cover(66, 66, true, 0, "Game", full, m));
        // 条件②：caption
        assert!(!foreground_is_fullscreen_cover(77, 66, true, WS_CAPTION, "Game", full, m));
        // 条件③：桌面类名
        assert!(!foreground_is_fullscreen_cover(77, 66, true, 0, "Progman", full, m));
        // 条件④：同显示器
        assert!(!foreground_is_fullscreen_cover(77, 66, false, 0, "Game", full, m));
        // 条件⑤：四边覆盖（每边各打穿一次）
        for edge in [
            Rect { left: 1, top: 0, right: 2560, bottom: 1440 },
            Rect { left: 0, top: 1, right: 2560, bottom: 1440 },
            Rect { left: 0, top: 0, right: 2559, bottom: 1440 },
            Rect { left: 0, top: 0, right: 2560, bottom: 1439 },
        ] {
            assert!(!foreground_is_fullscreen_cover(77, 66, true, 0, "Game", edge, m),
                "少覆盖一边也不算全屏：{edge:?}");
        }
    }

    /* ---------------- R20-a 修正 · 显隐分支触发条件（2026-10-18 实机闪烁事故） ---------------- */

    /// R20a-F1：稳态「想显示且已显示」⇒ 不执行（跑完 shown 对齐后条件自假）。
    #[test]
    fn show_branch_is_quiet_in_steady_states() {
        assert!(!show_branch_should_run(false, true, false, false), "已显示且想显示 ⇒ 无操作");
        assert!(!show_branch_should_run(true, false, false, false), "已隐藏且想隐藏 ⇒ 无操作");
    }

    /// R20a-F2：影子与意图不符 ⇒ 执行（原 `want_hide == shown` 语义，自清除）。
    #[test]
    fn show_branch_runs_on_shadow_divergence() {
        assert!(show_branch_should_run(false, false, false, false), "想显示但还藏着 ⇒ 显示");
        assert!(show_branch_should_run(true, true, false, false), "想隐藏但还显示 ⇒ 隐藏");
    }

    /// R20a-F3：**闪烁根因的回归防线**——规则隐藏中、常驻「想显示」但**没有下降沿**
    /// ⇒ 必须不执行。原实现这里是电平触发（恒真），实机 2.3 小时刷了 2991 条
    /// `auto-hidden` / 0 条 `restored`（桌宠在全屏应用上每 ~250ms 眨一次）。
    #[test]
    fn show_branch_must_not_fire_on_standing_intent_while_rule_hidden() {
        assert!(!show_branch_should_run(false, true, true, false),
            "规则藏着 + 常驻想显示 + 无下降沿 ⇒ 不执行（电平触发就是这条断言红）");
        // 连续多拍都不得执行（模拟 compose 33ms 节拍连跑）
        for _ in 0..8 {
            assert!(!show_branch_should_run(false, true, true, false));
        }
    }

    /// R20a-F4：规则隐藏中、用户**刚**取消隐藏（下降沿）⇒ 放行一次（逃逸出口），
    /// 且只放行一次——下一拍无沿即假（规则按既定语义下一拍重新生效，不循环）。
    #[test]
    fn show_branch_fires_exactly_once_on_user_unhide_edge() {
        assert!(show_branch_should_run(false, true, true, true), "下降沿必须放行");
        // 同一意图的下一拍：边沿消失 ⇒ 不再执行
        assert!(!show_branch_should_run(false, true, true, false));
        // 用户取消隐藏的同时影子已经对齐（shown=true）时，靠第一判据也不误触
        assert!(!show_branch_should_run(false, true, false, false));
    }

    /* ---------------- R16 · 抓取热区（命中容差） ---------------- */

    /// R16-1：膨胀只把「贴着轮廓的空白」纳入可点，**不**吃掉远离角色的角落。
    #[test]
    fn grab_hit_expands_around_solid_pixels_only() {
        let (w, h) = (5i32, 5i32);
        let mut buf = vec![0u32; (w * h) as usize];
        buf[(2 * w + 2) as usize] = 0xFF00_0000; // 仅中心像素不透明
        assert!(grab_hit(&buf, w, h, 2, 2, 0, CLICK_THROUGH_ALPHA), "实心像素本身必须命中");
        assert!(grab_hit(&buf, w, h, 4, 4, 2, CLICK_THROUGH_ALPHA), "pad=2 时对角邻域命中");
        assert!(!grab_hit(&buf, w, h, 0, 0, 1, CLICK_THROUGH_ALPHA), "pad 之外仍是透明");
        assert!(!grab_hit(&buf, w, h, -1, 2, 8, CLICK_THROUGH_ALPHA),
            "窗口外恒穿透 —— 膨胀不得让桌宠吃到窗口外的点击");
        // 阈值是判据的一部分：半透明像素在阈值之上命中、之下不命中。
        let mut faint = vec![0u32; (w * h) as usize];
        faint[(2 * w + 2) as usize] = 0x2000_0000; // alpha = 0x20 = 32
        assert!(grab_hit(&faint, w, h, 2, 2, 0, 16), "alpha=32 ≥ 阈值 16 ⇒ 命中");
        assert!(!grab_hit(&faint, w, h, 2, 2, 0, 64), "alpha=32 < 阈值 64 ⇒ 不命中");
    }

    /// R16-2：**回归口径** —— 用实测的 whale 可点区造缓冲（窗口 286×390 内 x∈[70,180]、
    /// y∈[150,330]），钉住膨胀半径的语义：轮廓外 `pad` 内可点、`pad` 外穿透、
    /// 窗口左右留白深处仍穿透（不出现「整窗隐形挡板」）。
    #[test]
    fn grab_pad_matches_measured_whale_hit_area() {
        let (w, h) = (286i32, 390i32);
        let mut buf = vec![0u32; (w * h) as usize];
        for y in 150..=330 {
            for x in 70..=180 {
                buf[(y * w + x) as usize] = 0xFF00_0000;
            }
        }
        let pad = CLICK_GRAB_PAD_PX;
        let a = CLICK_THROUGH_ALPHA;
        assert!(grab_hit(&buf, w, h, 70, 200, pad, a), "角色本体内可点");
        assert!(grab_hit(&buf, w, h, 70 - pad, 200, pad, a), "轮廓外 pad 内应可点（抓取容差）");
        assert!(!grab_hit(&buf, w, h, 70 - pad - 1, 200, pad, a), "轮廓外 pad+1 仍穿透");
        assert!(!grab_hit(&buf, w, h, 20, 200, pad, a), "贴边留白深处仍穿透 —— 不得变成整窗挡板");
        assert!(!grab_hit(&buf, w, h, 143, 60, pad, a), "角色上方（气泡带）仍穿透");
        // 可见收益的量化：膨胀后 x 方向可抓带宽度 110 → 110 + 2×pad
        assert_eq!(110 + 2 * pad, 142, "pad={pad} 时横向可抓带应为 142px（原 110px）");
    }

    /* ---------------- M4.1 · 边缘停靠 ---------------- */

    /// 测试用矩形（`Rect` 是 `#[repr(C)]` 纯数据，可直接构造）。
    ///
    /// 刻意让四个参数都按值传：**M4.1 的测试会复用同一个 `work` 变量**
    /// （`Rect` 是 `#[repr(C)]` 的四整数、无堆无指针，语义上就是 `Copy` 的）。
    /// 改前的版本在 harness 里报「use of moved value」——**那在真仓同样会挂**。
    fn rect(l: i32, t: i32, r: i32, b: i32) -> Rect {
        Rect { left: l, top: t, right: r, bottom: b }
    }

    /// M4.1-1：四条边的吸附判定各自成立，且**距离不够时不吸附**。
    #[test]
    fn dock_edge_detected_on_all_four_sides() {
        let work = rect(0, 0, 1920, 1040);
        let m = DOCK_MARGIN_PX;
        // 角色（250 宽）分别贴到四条边
        let near_left = rect(m, 300, m + 250, 700);
        let near_right = rect(work.right - m - 250, 300, work.right - m, 700);
        let near_top = rect(700, m, 950, m + 400);
        let near_bottom = rect(700, work.bottom - m - 400, 950, work.bottom - m);
        assert_eq!(pick_dock_edge(near_left, work, DOCK_MARGIN_PX), Some(DockEdge::Left));
        assert_eq!(pick_dock_edge(near_right, work, DOCK_MARGIN_PX), Some(DockEdge::Right));
        assert_eq!(pick_dock_edge(near_top, work, DOCK_MARGIN_PX), Some(DockEdge::Top));
        assert_eq!(pick_dock_edge(near_bottom, work, DOCK_MARGIN_PX), Some(DockEdge::Bottom));
        // 远离所有边 ⇒ 不吸附
        assert_eq!(pick_dock_edge(rect(800, 400, 1050, 800), work, DOCK_MARGIN_PX), None);
    }

    /// M4.1-2：**完全出屏不得吸附**。角色不在工作区内时若也判「贴边」，
    /// 会把它推到另一条边上（甚至另一块屏）—— 这正是 R3 要用 `pos_visible` 兜底的场景，
    /// 两处判据不能打架。
    #[test]
    fn dock_not_detected_when_fully_outside() {
        let work = rect(0, 0, 1920, 1040);
        // 整块角色在左边外
        assert_eq!(pick_dock_edge(rect(-300, 300, -50, 700), work, DOCK_MARGIN_PX), None);
        // 整块角色在右边外
        assert_eq!(pick_dock_edge(rect(2000, 300, 2250, 700), work, DOCK_MARGIN_PX), None);
        // 整块在下方
        assert_eq!(pick_dock_edge(rect(700, 1100, 950, 1500), work, DOCK_MARGIN_PX), None);
    }

    /// M4.1-3：推出后**角色与边缘的距离恰为 `DOCK_MARGIN_PX`**（不多不少）。
    ///
    /// 这条钉住 `dock_push_out` 的语义：多余外移会让角色明显悬在屏外，
    /// 而不足则贴不到边。这是「恰好等于」的完整定义。
    #[test]
    fn dock_push_results_in_exact_margin() {
        let work = rect(0, 0, 1920, 1040);
        let m = DOCK_MARGIN_PX;
        // 从「离左边 100px」推到「离左边 m」
        let role0 = rect(100, 300, 350, 700);
        let pos0 = (0, 0); // 角色区域是相对窗口的偏移：此处 role0 已是窗口坐标
        let pushed = dock_push_out(pos0, role0, work, DockEdge::Left, DOCK_MARGIN_PX).expect("应可推出");
        // 推出后：role.left 应等于 work.left + m
        let new_role_left = role0.left + pushed.0;
        assert_eq!(new_role_left, work.left + m,
            "推出后角色左边距应为 {m}，实得 {new_role_left}");
    }

    /// M4.1-4：右/下两条边的推出方向**不能搞反**（这是最容易写错的地方）。
    #[test]
    fn dock_push_direction_is_correct_on_right_and_bottom() {
        let work = rect(0, 0, 1920, 1040);
        let m = DOCK_MARGIN_PX;
        // 角色右边距 work.right 还有 5px（已在阈值内，但位置没对齐）
        let role_r = rect(work.right - m - 5 - 250, 300, work.right - m - 5, 700);
        let pos = (0, 0);
        let p = dock_push_out(pos, role_r, work, DockEdge::Right, DOCK_MARGIN_PX).unwrap();
        // 推出后 role.right = work.right - m ⇒ 窗口 x 需 **+5**（往右推）
        assert_eq!(role_r.right + p.0, work.right - m,
            "右边推出应 +5px（把角色往屏幕内挪），实得 {}", p.0);
        let role_b = rect(700, work.bottom - m - 5 - 400, 950, work.bottom - m - 5);
        let pb = dock_push_out(pos, role_b, work, DockEdge::Bottom, DOCK_MARGIN_PX).unwrap();
        assert_eq!(role_b.bottom + pb.1, work.bottom - m,
            "下边推出应 +5px，实得 {}", pb.1);
    }

    /// M4.1-5：跨屏时**拒绝推出**（返回 `None`）。
    /// 角色不在该工作区内 ⇒ 推算出的偏移会跑错屏，必须让调用方保持原位。
    #[test]
    fn dock_push_refuses_when_role_outside_work() {
        let work = rect(0, 0, 1920, 1040);
        let role = rect(-300, 300, -50, 700); // 完全在左外
        assert_eq!(dock_push_out((0, 0), role, work, DockEdge::Left, DOCK_MARGIN_PX), None,
            "角色完全在屏外时不得推出（会把窗口推到错误的屏）");
    }

    /// M4.1-6：**已经是精确贴边 ⇒ 无需移动**（幂等）。
    /// 这条防的是「每次松手都微调 0~1px」的抖动 —— 若 push 总返回新坐标，
    /// 用户会看到桌宠在边缘处轻微跳动。
    #[test]
    fn dock_push_is_idempotent_when_already_exact() {
        let work = rect(0, 0, 1920, 1040);
        let m = DOCK_MARGIN_PX;
        let role = rect(work.left + m, 300, work.left + m + 250, 700);
        let pos = (0, 0);
        assert_eq!(dock_push_out(pos, role, work, DockEdge::Left, DOCK_MARGIN_PX), Some(pos),
            "已精确贴边时必须原样返回（否则贴边会抖）");
    }

    /* ---------------- E30（2026-10-13）· 非零基准：推出量判据 ---------------- */

    /// E30-1：**Right 边、非零松手点** —— 实机障故的逐像素复盘。
    ///
    /// 旧四条单测一律 `pos = (0,0)`：该基准下「目标窗口位置」与「位移」恒等，
    /// 于是 `pos + dx`（把目标当位移叠加）这类缺陷被喂成全绿。本例用实机同款几何
    /// （工作区 2560×1440、窗口 286×390、松手点 x=2257 ⇒ 角色右边距右缘 17px ≤ 18 判 Right）。
    #[test]
    fn dock_push_right_from_nonzero_baseline() {
        let work = rect(0, 0, 2560, 1440);
        let m = DOCK_MARGIN_PX;
        let pos = (2257, 917); // 实机日志：drag aborted (capture lost) -> (4513,917) dock=Some(Right)
        // 角色区域 = 窗口 + 局部矩形（绝对口径，与 apply_dock 的 role 同构）
        let role = rect(pos.0, pos.1 + 118, pos.0 + 286, pos.1 + 390);
        let p = dock_push_out(pos, role, work, DockEdge::Right, m).expect("应可推出");
        // 推出后角色右边恰为 work.right - m（2542）⇒ 窗口 x = 2542 - 286 = 2256
        assert_eq!(p, (2256, 917),
            "Right 边推出后角色右边应顶到 work.right - m，实得 {:?}", p);
        // 旧缺陷（把目标当位移叠加）会得到 pos + 2256 = 4513 —— 实机日志里的出屏坐标
        assert_ne!(p, (pos.0 + (work.right - m - 286), pos.1),
            "返回值是目标位置而非位移 —— 旧实现正是在这里把桌宠推出屏幕");
    }

    /// E30-2：**Bottom 边、非零松手点** —— 实机障故的逐像素复盘。
    /// 松手点 y=1036（角色底 1426，距工作区底 14px ≤ 18 判 Bottom）：
    /// 正确推出 = 上移 4px 让间距恰为 18；旧缺陷 = 下移 1032px 整窗出屏（日志 (2241,2068)）。
    #[test]
    fn dock_push_bottom_from_nonzero_baseline() {
        let work = rect(0, 0, 2560, 1440);
        let m = DOCK_MARGIN_PX;
        let pos = (2241, 1036); // 实机日志：drag aborted (capture lost) -> (2241,2068) dock=Some(Bottom)
        let role = rect(pos.0, pos.1 + 118, pos.0 + 286, pos.1 + 390);
        let p = dock_push_out(pos, role, work, DockEdge::Bottom, m).expect("应可推出");
        // 推出后角色底恰为 work.bottom - m（1422）⇒ 窗口 y = 1422 - 390 = 1032
        assert_eq!(p, (2241, 1032),
            "Bottom 边推出后角色底应顶到 work.bottom - m，实得 {:?}", p);
        assert_ne!(p, (2241, 2068),
            "旧缺陷把窗口推到 2068（工作区底 1440 之外）—— 这正是实机出屏坐标");
    }

    /// E30-3：**Left 边、非零松手点** —— 与 Right 对称，防「只修了一条边」。
    /// 松手点 x=612（角色左边距 612 > 18 ⇒ 本不判 Left；此处直接验推出几何）：
    /// 推出后角色左边恰为 work.left + m ⇒ 窗口 x = 18 - 0 = 18。
    #[test]
    fn dock_push_left_from_nonzero_baseline() {
        let work = rect(0, 0, 2560, 1440);
        let m = DOCK_MARGIN_PX;
        let pos = (612, 400);
        let role = rect(pos.0, pos.1 + 118, pos.0 + 286, pos.1 + 390);
        let p = dock_push_out(pos, role, work, DockEdge::Left, m).expect("应可推出");
        assert_eq!(p, (work.left + m, 400),
            "Left 边推出后角色左边应顶到 work.left + m，实得 {:?}", p);
        assert_ne!(p, (pos.0 + (work.left + m), pos.1), "不得把目标位置当位移叠加");
    }

    /// E30-4：推出结果**必然使角色贴边**（不变量，对全部四条边 × 非零基准成立）。
    /// 这条是「目标 vs 位移」语义的完整定义：无论从哪起步，推出后角色与边缘的距离
    /// 必须恰为 `margin`；旧实现在 pos≠0 时会把角色推出工作区（相交面积塌到 0）。
    #[test]
    fn dock_push_always_lands_role_exactly_on_edge_from_any_baseline() {
        let work = rect(0, 0, 2560, 1440);
        let m = DOCK_MARGIN_PX;
        for &(pos, edge) in &[
            ((2257, 917), DockEdge::Right),
            ((2241, 1036), DockEdge::Bottom),
            ((612, 400), DockEdge::Left),
            ((900, 250), DockEdge::Top),
        ] {
            let role = rect(pos.0, pos.1 + 118, pos.0 + 286, pos.1 + 390);
            let p = dock_push_out(pos, role, work, edge, m).expect("应可推出");
            let g = rect(p.0 + 0, p.1 + 118, p.0 + 286, p.1 + 390);
            let (dl, dr, dt, db) =
                (g.left - work.left, work.right - g.right, g.top - work.top, work.bottom - g.bottom);
            match edge {
                DockEdge::Left => assert_eq!(dl, m, "Left: 推出后左边距应为 m"),
                DockEdge::Right => assert_eq!(dr, m, "Right: 推出后右边距应为 m"),
                DockEdge::Top => assert_eq!(dt, m, "Top: 推出后上边距应为 m"),
                DockEdge::Bottom => assert_eq!(db, m, "Bottom: 推出后下边距应为 m"),
            }
            // 推出后角色必须仍与工作区有交（不出屏）—— 这是「回不来」故障的直接判据
            assert!(g.right > work.left && g.left < work.right && g.bottom > work.top && g.top < work.bottom,
                "推出后角色出屏：pos={:?} edge={:?} -> {:?}", pos, edge, p);
        }
    }

    /* ---------------- M4.1 · 边缘探头（peek）状态机 ---------------- */

    /// 测试用角色矩形：与 `character_local_rect()` 同构（宽 = WIN_W，高 = CELL_H + 2）。
    fn char_rect() -> Rect {
        rect(0, WIN_H - CELL_H as i32 - 2, WIN_W, WIN_H)
    }

    fn advance_n(st: &mut PeekState, role: Rect, edge: DockEdge, n: u32) {
        for _ in 0..n {
            peek_advance(st, role, edge, DOCK_MARGIN_PX, 33); // 与 compose 同节拍
        }
    }

    /// M4.1-7：露出比例的定义式 —— 可见带宽 / 跨度 == exposure。
    /// 直接钉住 `peek_slide_target` 的推导（含 +M 预留间距项），防止后人「简化」掉。
    #[test]
    fn peek_slide_target_matches_exposure_definition() {
        let role = char_rect();
        let m = DOCK_MARGIN_PX as f32;
        for edge in [DockEdge::Left, DockEdge::Right] {
            let ext = peek_extent(role, edge) as f32;
            let t = peek_slide_target(role, edge, PEEK_REST_EXPOSURE, DOCK_MARGIN_PX);
            let visible = ext + m - t; // slide > M 后的可见带宽
            assert!((visible / ext - PEEK_REST_EXPOSURE).abs() < 1e-4,
                "Left/Right：可见比例应为 0.55，实得 {}", visible / ext);
        }
        for edge in [DockEdge::Top, DockEdge::Bottom] {
            let ext = peek_extent(role, edge) as f32;
            let t = peek_slide_target(role, edge, PEEK_ENGAGE_EXPOSURE, DOCK_MARGIN_PX);
            let visible = ext + m - t;
            assert!((visible / ext - PEEK_ENGAGE_EXPOSURE).abs() < 1e-4,
                "Top/Bottom：可见比例应为 0.82，实得 {}", visible / ext);
        }
    }

    /// M4.1-8：四条边的**外移方向**（最容易写反的地方）+ slide=0 幂等。
    #[test]
    fn peek_window_pos_moves_toward_off_screen_per_edge() {
        let docked = (100, 200);
        for (edge, expect) in [
            (DockEdge::Left, (100 - 30, 200)),
            (DockEdge::Right, (100 + 30, 200)),
            (DockEdge::Top, (100, 200 - 30)),
            (DockEdge::Bottom, (100, 200 + 30)),
        ] {
            assert_eq!(peek_window_pos(docked, edge, 30.0), expect,
                "edge={edge:?} 的外移方向反了");
        }
        // slide = 0 ⇒ 原地不动（吸附位即基准）
        for edge in [DockEdge::Left, DockEdge::Right, DockEdge::Top, DockEdge::Bottom] {
            assert_eq!(peek_window_pos(docked, edge, 0.0), docked);
        }
    }

    /// M4.1-9：静置进入 —— Entering 在 300ms 内完成、落点 = 常驻档、相位转 Peeking。
    /// 节拍 33ms：第 9 拍（297ms）未到期、第 10 拍（330ms）已到期。
    #[test]
    fn peek_enter_reaches_rest_and_becomes_peeking() {
        let role = char_rect();
        let mut st = PeekState::off();
        peek_kick_idle(&mut st);
        assert_eq!(st.phase, PeekPhase::Entering);
        advance_n(&mut st, role, DockEdge::Left, 9);
        assert_eq!(st.phase, PeekPhase::Entering, "297ms < 300ms，不应提前到位");
        advance_n(&mut st, role, DockEdge::Left, 1);
        assert_eq!(st.phase, PeekPhase::Peeking, "330ms ≥ 300ms，应已到位");
        let want = peek_slide_target(role, DockEdge::Left, PEEK_REST_EXPOSURE, DOCK_MARGIN_PX);
        assert!((st.slide - want).abs() < 0.5, "落点应是常驻档 {want}，实得 {}", st.slide);
    }

    /// M4.1-10：拉直 —— 250ms 内到 engage 档；退回 —— 回常驻档**而不是吸附位**。
    #[test]
    fn peek_engage_then_return_round_trip() {
        let role = char_rect();
        let mut st = PeekState::off();
        peek_kick_idle(&mut st);
        advance_n(&mut st, role, DockEdge::Right, 12);
        assert_eq!(st.phase, PeekPhase::Peeking);

        // 拉直：250ms → 第 7 拍（231ms）未到期、第 8 拍（264ms）已到期
        peek_kick_engage(&mut st);
        assert_eq!(st.phase, PeekPhase::Straightening);
        advance_n(&mut st, role, DockEdge::Right, 7);
        assert_eq!(st.phase, PeekPhase::Straightening, "231ms < 250ms，不应提前到位");
        advance_n(&mut st, role, DockEdge::Right, 1);
        assert_eq!(st.phase, PeekPhase::Straightened);
        let engage = peek_slide_target(role, DockEdge::Right, PEEK_ENGAGE_EXPOSURE, DOCK_MARGIN_PX);
        assert!((st.slide - engage).abs() < 0.5, "拉直落点应是 engage 档 {engage}，实得 {}", st.slide);

        // 退回：目标是常驻档（继续探头），不是吸附位（没拖走就不该回去）
        peek_kick_return(&mut st);
        assert_eq!(st.phase, PeekPhase::Returning);
        advance_n(&mut st, role, DockEdge::Right, 12);
        assert_eq!(st.phase, PeekPhase::Peeking);
        let rest = peek_slide_target(role, DockEdge::Right, PEEK_REST_EXPOSURE, DOCK_MARGIN_PX);
        assert!((st.slide - rest).abs() < 0.5, "退回落点应是常驻档 {rest}，实得 {}", st.slide);
        assert!(st.slide > 0.0, "退回绝不是回吸附位（slide 必须仍 > 0）");
    }

    /// M4.1-11：**过渡中途被打断必须连续** —— Entering 走到一半光标压上，
    /// Straightening 从当前 slide 起步（首拍位移不超过全程的 5%），不跳变。
    #[test]
    fn peek_engage_from_mid_entering_is_continuous() {
        let role = char_rect();
        let mut st = PeekState::off();
        peek_kick_idle(&mut st);
        advance_n(&mut st, role, DockEdge::Left, 3); // ≈99ms，走到一半
        assert_eq!(st.phase, PeekPhase::Entering);
        let at_interrupt = st.slide;
        assert!(at_interrupt > 0.0 && at_interrupt < peek_slide_target(role, DockEdge::Left, PEEK_REST_EXPOSURE, DOCK_MARGIN_PX));
        peek_kick_engage(&mut st);
        assert_eq!(st.phase, PeekPhase::Straightening);
        advance_n(&mut st, role, DockEdge::Left, 1);
        let engage = peek_slide_target(role, DockEdge::Left, PEEK_ENGAGE_EXPOSURE, DOCK_MARGIN_PX);
        let step = (st.slide - at_interrupt).abs();
        assert!(step < (engage - at_interrupt).abs() * 0.2,
            "拉直首拍位移 {step}px 过大 ⇒ 起点没接在打断处（跳变）");
        advance_n(&mut st, role, DockEdge::Left, 12);
        assert_eq!(st.phase, PeekPhase::Straightened);
        assert!((st.slide - engage).abs() < 0.5);
    }

    /// M4.1-12：过渡动画**单调有界** —— Entering 期间 slide 单调向目标、绝不越过
    /// （smoothstep 两端零速度 + 目标夹取；越界 = 桌宠在边缘「抽搐」）。
    #[test]
    fn peek_advance_is_monotonic_and_bounded() {
        let role = char_rect();
        let target = peek_slide_target(role, DockEdge::Left, PEEK_REST_EXPOSURE, DOCK_MARGIN_PX);
        let mut st = PeekState::off();
        peek_kick_idle(&mut st);
        let mut last = st.slide;
        for _ in 0..12 {
            peek_advance(&mut st, role, DockEdge::Left, DOCK_MARGIN_PX, 33);
            assert!(st.slide >= last, "slide 回退（{} → {}）⇒ 缓动不单调", last, st.slide);
            assert!(st.slide <= target + 1e-3, "slide {} 越过目标 {target}", st.slide);
            last = st.slide;
        }
    }

    /// M4.1-13：非过渡相位推进是**空操作**；kick 的相位守卫不被绕过。
    #[test]
    fn peek_advance_and_kicks_respect_phase_guards() {
        let role = char_rect();
        // Off / Peeking 推进不改 slide（两态都手写 slide=42，断言才有区分度）
        for phase in [PeekPhase::Off, PeekPhase::Peeking, PeekPhase::Straightened] {
            let mut st = PeekState { phase, slide: 42.0, from: 42.0, elapsed: 0.0 };
            peek_advance(&mut st, role, DockEdge::Left, DOCK_MARGIN_PX, 33);
            assert_eq!(st.slide, 42.0, "相位 {phase:?} 不该被推进");
        }
        // Off 不能直接 engage；Straightened 不能再 engage（只能 return）
        let mut st = PeekState::off();
        peek_kick_engage(&mut st);
        assert_eq!(st.phase, PeekPhase::Off);
        let mut st2 = PeekState { phase: PeekPhase::Straightened, slide: 50.0, from: 0.0, elapsed: 0.0 };
        peek_kick_engage(&mut st2);
        assert_eq!(st2.phase, PeekPhase::Straightened);
        // 非 Off 不能 kick_idle（边界检测分派错了也不产生第二段动画）
        peek_kick_idle(&mut st2);
        assert_eq!(st2.phase, PeekPhase::Straightened);
        // reset 恒回 Off + slide 0
        peek_reset(&mut st2);
        assert_eq!(st2, PeekState::off());
    }

    /// M4.1-14：**peek 全程不与 R3 可见性判据打架** —— 常驻档下角色区域与工作区的
    /// 相交面积占比必须 ≥ `VISIBLE_MIN_PCT`（否则重启即「桌宠丢了」回归，roadmap 点名的坑）。
    #[test]
    fn peeked_position_stays_visible_by_r3_criterion() {
        let work = rect(0, 0, 1920, 1040);
        let role = char_rect(); // 窗口局部
        let m = DOCK_MARGIN_PX;
        // 吸附位（Left 边）：角色区域左边距边 m
        let docked_pos = (work.left + m, 300);
        for exposure in [PEEK_REST_EXPOSURE, PEEK_ENGAGE_EXPOSURE] {
            let slide = peek_slide_target(role, DockEdge::Left, exposure, DOCK_MARGIN_PX).round() as i32;
            let pos = peek_window_pos(docked_pos, DockEdge::Left, slide as f32);
            let g = rect(pos.0 + role.left, pos.1 + role.top, pos.0 + role.right, pos.1 + role.bottom);
            let l = g.left.max(work.left);
            let r = g.right.min(work.right);
            let area = ((r - l).max(0) as i64) * ((g.bottom - g.top) as i64);
            let total = ((g.right - g.left) as i64) * ((g.bottom - g.top) as i64);
            assert!(area * 100 >= total * VISIBLE_MIN_PCT,
                "露出 {exposure} 时可见占比 {}% 低于 R3 阈值", area * 100 / total);
        }
    }

    /* ---------------- DPI 缩放判据的单测 ---------------- */

    #[test]
    fn dpi_scale_maps_base_and_doubles() {
        assert_eq!(dpi_scale(96), 1.0, "基准 DPI 必须是 1.0（不缩放）");
        assert_eq!(dpi_scale(192), 2.0, "200% 必须精确 2.0");
    }

    #[test]
    fn dpi_scale_never_returns_zero_for_invalid_dpi() {
        // GetDpiForWindow 在无效 hwnd 上返回 0。若此处返回 0，窗口尺寸塌成 0×0 ⇒
        // 桌宠静默消失且无任何报错 —— 这条钉住回落分支。
        assert_eq!(dpi_scale(0), 1.0, "无效 DPI 必须回落 1.0，不得为 0");
    }

    #[test]
    fn dpi_scale_clamps_below_base_to_one() {
        // 小于 96 的 DPI（96 罕见但 API 允许）不缩：缩到 0.5 只会糊。
        assert_eq!(dpi_scale(48), 1.0);
        assert_eq!(dpi_scale(1), 1.0);
    }

    #[test]
    fn dpi_scale_keeps_fractional_dpi_exact() {
        // 系统给什么档就是什么档。**曾把 scale 量化到 0.5**（被本条 + 上一条抓到）：
        // 175%（168）被抬成 2.0、144 与 168 撞成同一档 ⇒ 两档不同缩放渲染成同样大小。
        // 量化等于替系统改写 DPI 档位，是错的。
        assert_eq!(dpi_scale(120), 1.25, "125% 必须精确 1.25");
        assert_eq!(dpi_scale(144), 1.5, "150% 必须精确 1.5");
        assert_eq!(dpi_scale(168), 1.75, "175% 必须精确 1.75，不得被抬成 2.0");
    }

    #[test]
    fn dpi_scale_is_strictly_increasing_across_real_dpi_ladder() {
        // 「严格单调」而非「不减」：量化实现会在 144/168 处出现相等（实测踩过）。
        let ladder = [96u32, 108, 120, 132, 144, 156, 168, 180, 192, 216, 240];
        for w in ladder.windows(2) {
            let (a, b) = (dpi_scale(w[0]), dpi_scale(w[1]));
            assert!(b > a, "dpi {} 与 {} 的 scale 相等（{a}）⇒ 档位被合并", w[0], w[1]);
        }
    }

    #[test]
    fn scaled_window_size_is_monotonic_in_dpi() {
        // DPI 越高窗口越大 —— 顺序错了会让桌宠随缩放设置变小。
        let mut prev = 0;
        for dpi in [96u32, 120, 144, 168, 192, 216, 240] {
            let (w, h) = scaled_window_size(286, 390, dpi);
            assert!(w > prev, "dpi {dpi} 的窗宽 {w} 未大于上一档 {prev}");
            assert!(w >= 286 && h >= 390, "dpi {dpi} 不得缩到基准以下：{w}x{h}");
            prev = w;
        }
    }

    #[test]
    fn scaled_window_size_is_never_zero_even_for_degenerate_input() {
        // buf 分配与 CreateWindowExW 都吃这个值：0 会让桌宠消失。
        assert_eq!(scaled_window_size(0, 0, 192), (1, 1), "退化输入也要保底 1×1");
        assert_eq!(scaled_window_size(286, 390, 0), (286, 390), "无效 DPI 走 1.0 回落");
    }

    #[test]
    fn scaled_px_keeps_dock_margin_proportion() {
        // 本次修复的核心判据：200% 下 DOCK_MARGIN_PX 必须同步放大，
        // 否则吸附时「角色贴边」的留白从 18 逻辑像素塌成 9（桌宠陷进屏幕边缘）。
        assert_eq!(scaled_px(DOCK_MARGIN_PX, 96), 18);
        assert_eq!(scaled_px(DOCK_MARGIN_PX, 192), 36);
        // 比例一致性：任意 DPI 下 换算后/原始 = scale
        for dpi in [96u32, 120, 144, 192] {
            let s = dpi_scale(dpi);
            let got = scaled_px(DOCK_MARGIN_PX, dpi) as f32;
            let want = DOCK_MARGIN_PX as f32 * s;
            assert!((got - want).abs() <= 0.5, "dpi {dpi}: {got} vs {want}");
        }
    }

    #[test]
    fn scaled_px_is_consistent_with_scaled_window_size() {
        // 两者必须出自同一 scale —— 分处取整会让 DIB 与 MoveWindow 尺寸不一致，
        // UpdateLayeredWindow 会静默拉伸填满 ⇒ 画面被拉扁一像素。
        for dpi in [96u32, 120, 144, 192, 240] {
            let s = dpi_scale(dpi);
            assert!((scaled_px(1, dpi) as f32 - s).abs() <= 0.5,
                "dpi {dpi}: scaled_px(1) 与 scale 不一致");
        }
    }

    /* ---------------- P0-F1 · 摸头与咬手 ---------------- */

    fn ms(n: u64) -> std::time::Duration {
        std::time::Duration::from_millis(n)
    }

    /// 连续接触模拟：从 `from` 起每 `step` ms 喂一次 on_hit=true，直到 `until`。
    /// 返回 (strokes, bites)。**为什么这样模拟**：真实抚摸 = 光标持续压在角色上，
    /// 判定状态机每个 10ms 拍进一次；中间手动清 `hold_since` 反而破坏了连续性
    /// （首版测试那么写，模拟出的是「摸一下抬一下」，与实际语义不符）。
    fn pet_run(st: &mut Petting, from: std::time::Instant, until: std::time::Instant, step: u64) -> (u32, u32) {
        let (mut s, mut b) = (0u32, 0u32);
        let mut t = from;
        while t < until {
            match petting_tick(st, true, t, PET_HOLD_MS) {
                PetEvent::Stroke => s += 1,
                PetEvent::Bite => b += 1,
                PetEvent::None => {}
            }
            t += ms(step);
        }
        (s, b)
    }

    /// P0-F1-1：命中不满 PET_HOLD_MS 不出事件；满足了才一下。
    #[test]
    fn petting_requires_sustained_contact() {
        let t0 = std::time::Instant::now();
        let mut st = Petting::new(t0);
        // 第一拍：起算（本拍就是起点，不可能当拍就满窗）
        assert_eq!(petting_tick(&mut st, true, t0, PET_HOLD_MS), PetEvent::None);
        // 差 1ms 不满窗
        assert_eq!(petting_tick(&mut st, true, t0 + ms(PET_HOLD_MS - 1), PET_HOLD_MS), PetEvent::None);
        // 期满 ⇒ 一下
        assert_eq!(petting_tick(&mut st, true, t0 + ms(PET_HOLD_MS), PET_HOLD_MS), PetEvent::Stroke);
    }

    /// P0-F1-2：on_hit 中断 ⇒ 本段作废（划过去不算摸），重新连续命中才起算。
    #[test]
    fn petting_resets_when_contact_breaks() {
        let t0 = std::time::Instant::now();
        let mut st = Petting::new(t0);
        petting_tick(&mut st, true, t0, PET_HOLD_MS);
        // 划走：中途清零
        assert_eq!(petting_tick(&mut st, false, t0 + ms(PET_HOLD_MS - 1), PET_HOLD_MS), PetEvent::None);
        // 重新命中要从头计（再等满一个 hold 才算）
        assert_eq!(petting_tick(&mut st, true, t0 + ms(PET_HOLD_MS), PET_HOLD_MS), PetEvent::None);
        assert_eq!(petting_tick(&mut st, true, t0 + ms(2 * PET_HOLD_MS), PET_HOLD_MS), PetEvent::Stroke);
    }

    /// P0-F1-3：窗口内累计 BITE_STROKES 下 ⇒ Bite；且随后进冷却、冷却期无反应。
    /// 连续接触 3s：每 400ms 一下，第 5 下（2.0s 处）升级为 Bite——前 4 下是 Stroke。
    #[test]
    fn petting_bites_after_five_strokes_then_cools_down() {
        let t0 = std::time::Instant::now();
        let mut st = Petting::new(t0);
        let (strokes, bites) = pet_run(&mut st, t0, t0 + ms(3000), 50);
        assert_eq!((strokes, bites), (4, 1), "连续摸 3s 应恰好 4 下 + 第 5 下升级为咬手");
        // 冷却期内：持续命中也不会有任何事件
        let (s2, b2) = pet_run(&mut st, t0 + ms(3000), t0 + ms(5000), 50);
        assert_eq!((s2, b2), (0, 0), "冷却期内不得有反应");
        // 冷却结束后恢复
        let after = t0 + ms(BITE_COOLDOWN_MS + 6000);
        assert!(!st.in_cooldown(after));
        let (s3, _) = pet_run(&mut st, after, after + ms(1000), 50);
        assert!(s3 >= 1, "冷却结束后应能重新摸出反应");
    }

    /// P0-F1-4：计数窗口过期 ⇒ 清零重计（「一小时摸五下」不触发）。
    #[test]
    fn petting_window_expiry_resets_the_count() {
        let t0 = std::time::Instant::now();
        let mut st = Petting::new(t0);
        // 连续摸 1.6s = 3 下（节拍 = hold 400ms + 重起 50ms ≈ 450ms；不满 5，不咬）
        let (strokes, bites) = pet_run(&mut st, t0, t0 + ms(1600), 50);
        assert_eq!((strokes, bites), (3, 0));
        assert_eq!(st.strokes, 3);
        // 中间光标离开（真实系统里这期间每拍 on_hit=false，会把 hold 段清掉——
        // 不模拟这一段的话，回来第一拍会拿着 1.6s 前的 arm 时刻立刻补一下，
        // 那是测试模拟失真，不是产品缺陷）
        for i in 0..10u64 {
            petting_tick(&mut st, false, t0 + ms(1600 + i * 10), PET_HOLD_MS);
        }
        // 歇远超窗口（> 60s）再摸 ⇒ 计数重新起算（1s 内 2 下：+400ms / +850ms），不咬
        let late = t0 + ms(BITE_WINDOW_MS + 5000);
        let (s2, b2) = pet_run(&mut st, late, late + ms(1000), 50);
        assert_eq!((s2, b2), (2, 0), "窗口过期后计数应重新起算：实测 {s2} 下 {b2} 咬");
        assert_eq!(st.strokes, 2);
    }

    /* ---------------- P0-F4 · 心情值 ---------------- */

    /// P0-F4-1：各事件符号正确 + 双向 clamp。
    #[test]
    fn mood_events_have_sign_and_clamp() {
        assert_eq!(mood_apply(0, MoodEvent::Stroke), MOOD_STROKE);
        assert!(mood_apply(0, MoodEvent::Bite) < 0, "被咬应掉心情");
        assert!(mood_apply(0, MoodEvent::Throw) < 0, "被甩应掉心情");
        assert!(mood_apply(0, MoodEvent::Neglect) < 0, "被冷落应掉心情");
        assert!(mood_apply(0, MoodEvent::Hop) > 0 && mood_apply(0, MoodEvent::Done) > 0);
        // clamp：狂撸不会溢出，狂被咬也不会
        let mut m = 0;
        for _ in 0..50 {
            m = mood_apply(m, MoodEvent::Stroke);
        }
        assert_eq!(m, MOOD_MAX);
        for _ in 0..50 {
            m = mood_apply(m, MoodEvent::Bite);
        }
        assert_eq!(m, MOOD_MIN);
    }

    /// P0-F4-2：档位边界（±25 换档，中间带是 Mid）。
    #[test]
    fn mood_band_switches_at_thresholds() {
        assert_eq!(mood_band(0), AmbientBand::Mid);
        assert_eq!(mood_band(MOOD_HIGH - 1), AmbientBand::Mid);
        assert_eq!(mood_band(MOOD_HIGH), AmbientBand::High);
        assert_eq!(mood_band(MOOD_LOW + 1), AmbientBand::Mid);
        assert_eq!(mood_band(MOOD_LOW), AmbientBand::Low);
    }

    /// P0-F3：抛掷速度门——边界含等号（600 整就飞）、斜向速度按模长、
    /// NaN 不触发（失败方向取「不飞」：误飞比不飞难收拾）。
    #[test]
    fn throw_triggered_uses_speed_magnitude_with_safe_fallback() {
        assert!(throw_triggered((THROW_VEL_MIN, 0.0)), "边界值应触发（>=）");
        assert!(throw_triggered((THROW_VEL_MIN - 1.0, 0.0)) == false, "差 1px/s 不触发");
        assert!(throw_triggered((0.0, -800.0)), "纯竖直快甩也飞（向上甩出去）");
        assert!(throw_triggered((0.0, 0.0)) == false, "静止松手不飞");
        assert!(throw_triggered((f32::NAN, 0.0)) == false, "NaN 速度不得触发");
        assert!(throw_triggered((f32::INFINITY, 0.0)) == false, "无穷速度不得触发");
        // 斜向：(425, 425) 的模长 ≈ 601 ⇒ 触发（速度是矢量，门看大小不看方向）
        let diag = 425.0_f32;
        assert!(throw_triggered((diag, diag)), "斜向合速度达标应触发");
    }

    /// P0-F4-3 / P1-a：加权选行——**首抽分布严格等于权重表**（无「上次」干扰时），
    /// 且**任何档位都不得连播同一条**（E5 纪律不随加权丢失）。
    ///
    /// 为什么分两段测：带着「上次」跑时，不重复约束本身会改变边际分布
    /// （[1,1,3] 的 wait 档平稳占比 ≈3/7——连续两个 2 被禁止，上限就低于 3/5），
    /// 那是**约束的数学后果**不是权重失真；权重是否被尊重要看 last=None 的首抽。
    /// （首版把两件事混在一个断言里，红得莫名其妙。）
    /// P1-a 起权重表变长（whale 6 槽），本测试随之泛化到任意长度。
    #[test]
    fn weighted_ambient_pick_respects_weights_and_never_repeats() {
        // ① 首抽分布 = 权重表（rnd%total 对连续 rnd 是严格均匀的，容差只防推错）
        for w in [
            vec![1u32, 1, 1],
            vec![1, 1, 3],
            vec![3, 2, 1],
            vec![1, 1, 1, 1, 1, 1], // whale Mid：六槽等权
            vec![3, 1, 1, 1, 1, 1], // whale High：wave 加权
        ] {
            let total: u32 = w.iter().sum();
            let n = w.len();
            let mut counts = vec![0u32; n];
            for rnd in 0..24000u32 {
                let idx = pick_ambient_pool_index_weighted(rnd, None, &w);
                assert!(idx < n);
                counts[idx] += 1;
            }
            for i in 0..n {
                let got = counts[i] as f32 / 24000.0;
                let want = w[i] as f32 / total as f32;
                assert!((got - want).abs() < 0.01,
                    "w={w:?} 门{i}：首抽 {got:.3} ≠ 权重 {want:.3}");
            }
        }
        // ② 不重复：带着「上次」跑，任何档位都不得连播
        for w in [vec![1u32, 1, 1], vec![1, 1, 3], vec![3, 2, 1], vec![1u32, 1, 1, 1, 1, 1]] {
            let mut last: Option<usize> = None;
            for rnd in 0..3000u32 {
                let idx = pick_ambient_pool_index_weighted(rnd, last, &w);
                if let Some(prev) = last {
                    assert_ne!(idx, prev, "w={w:?} rnd={rnd} 连播同一条");
                }
                last = Some(idx);
            }
        }
        // 退化输入：全零权重不死循环、不 panic；空池不死循环
        assert_eq!(pick_ambient_pool_index_weighted(7, Some(1), &[0, 0, 0]), 0);
        assert_eq!(pick_ambient_pool_index_weighted(7, Some(1), &[]), 0);
    }

    /// P1-a-1：主题行池分流——whale 无 review（空转槽）且含待机变体；kurumi 反之。
    #[test]
    fn ambient_pool_splits_by_theme() {
        let whale = ambient_pool("whale");
        assert!(!whale.contains(&"review"), "whale 没有 review 行——放进去 = 空转槽");
        for r in ["wave", "wait", "idle2", "idle3", "idle4", "idle5"] {
            assert!(whale.contains(&r), "whale 池缺 {r}");
        }
        let kurumi = ambient_pool("kurumi");
        assert!(kurumi.contains(&"review"));
        assert!(!kurumi.contains(&"idle2"), "kurumi 没有待机变体帧");
        // 未知主题回 kurumi 池（不猜、不空白）
        assert_eq!(ambient_pool("bogus"), kurumi);
    }

    /// P1-a-2：行权重方向——High 偏 wave、Low 偏 wait、待机变体恒中性。
    /// C 批：Day 档（默认入参）与 P1-a 口径逐字一致——时段修正只在傍晚/深夜生效。
    #[test]
    fn row_weight_follows_band_and_keeps_variants_neutral() {
        assert!(row_weight("wave", AmbientBand::High, TimeBand::Day) > row_weight("wave", AmbientBand::Low, TimeBand::Day));
        assert!(row_weight("wait", AmbientBand::Low, TimeBand::Day) > row_weight("wait", AmbientBand::High, TimeBand::Day));
        assert!(row_weight("review", AmbientBand::High, TimeBand::Day) > row_weight("review", AmbientBand::Low, TimeBand::Day));
        for r in ["idle2", "idle3", "idle4", "idle5", "jump"] {
            for band in [AmbientBand::Low, AmbientBand::Mid, AmbientBand::High] {
                assert_eq!(row_weight(r, band, TimeBand::Day), 1, "{r} 应恒中性（待机变体不被心情挤掉）");
            }
        }
    }

    /// P1-a-3：粘合层的主题纪律——whale 模式永远不返回 review（会空转），
    /// 且待机变体确实能上场（这是本项的存在意义）；kurumi 模式不返回 idle2。
    /// 判据是抽样的（`rand_u32` 不可注入种子），但样本量下「从不出现」的概率
    /// 低于 1e-30——真出现就是回归。
    #[test]
    fn pick_ambient_choice_never_returns_rows_the_theme_lacks() {
        let all = |_: &str| true; // 默认主题：池里各行都在（A 批过滤的对照基线）
        let mut saw_variant = false;
        for _ in 0..3000 {
            if let AmbientChoice::Row(r) = pick_ambient_choice(AmbientBand::Mid, "whale", TimeBand::Day, &all) {
                assert_ne!(r, "review", "whale 模式返回了不存在的 review 行（空转槽回归）");
                if r.starts_with("idle") {
                    saw_variant = true;
                }
            }
        }
        assert!(saw_variant, "3000 次抽样里待机变体一次都没上场——池接线没生效？");
        for _ in 0..1000 {
            if let AmbientChoice::Row(r) = pick_ambient_choice(AmbientBand::Mid, "kurumi", TimeBand::Day, &all) {
                assert!(!r.starts_with("idle"), "kurumi 模式返回了它没有的待机变体行");
            }
        }
    }

    /// A-1：行池按当前生效行集过滤——形象缺的行永不上场（P1-a 空转槽纪律的推广）。
    /// 判据是抽样的（`rand_u32` 不可注入种子）：3000 次里「过滤集外的行」一次都不该出现。
    #[test]
    fn ambient_pool_filters_by_available_rows() {
        // 模拟一个只有 idle/wait 的从简形象（没有 wave/idle2–idle5/jump）
        let has = |r: &str| matches!(r, "idle" | "wait");
        for _ in 0..3000 {
            if let AmbientChoice::Row(r) = pick_ambient_choice(AmbientBand::Mid, "whale", TimeBand::Day, &has) {
                assert!(matches!(r.as_str(), "idle" | "wait"),
                    "过滤后仍返回了 {r}——形象没有的行上了场（空转槽回归）");
            }
        }
    }

    /// A-2：过滤后池空 ⇒ 回落未过滤池（degenerate 形象不回 blank、不死循环、不 panic）。
    /// 「什么都不缺」与「什么都缺」两种极端下都必须有产出。
    #[test]
    fn ambient_pool_empty_filter_falls_back_to_full() {
        let nothing = |_: &str| false;
        let mut saw_row = false;
        for _ in 0..500 {
            if let AmbientChoice::Row(_) = pick_ambient_choice(AmbientBand::Mid, "whale", TimeBand::Day, &nothing) {
                saw_row = true;
            }
        }
        assert!(saw_row, "过滤空池后仍须有行产出（回落未过滤池）——否则桌宠可能无演出");
    }

    /// P0-F4-4：emote 概率有界——None 占多数、触发的都在该档的词表内。
    /// C 批：入参加 time；Day 档与 P0 口径逐字一致，Night 档的 High→Look
    /// 由专门的新测覆盖（`ambient_wants_emote_never_dances_at_night`）。
    #[test]
    fn ambient_emote_chance_is_bounded_and_in_vocabulary() {
        for band in [AmbientBand::Low, AmbientBand::Mid, AmbientBand::High] {
            let mut fired = 0u32;
            for rnd in 0..1000u32 {
                if let Some(kind) = ambient_wants_emote(band, rnd, TimeBand::Day) {
                    fired += 1;
                    let legal = match band {
                        AmbientBand::High => kind == EmoteKind::Dance,
                        AmbientBand::Low => matches!(kind, EmoteKind::Shiver | EmoteKind::Look),
                        AmbientBand::Mid => matches!(kind, EmoteKind::Turn | EmoteKind::Shake),
                    };
                    assert!(legal, "{band:?} 触发了词表外的 {kind:?}");
                }
            }
            // 触发率（‰）= fired/1000×1000，上限 = pct×10（pct 是 %）
            let pct = match band {
                AmbientBand::High => EMOTE_PCT_HIGH,
                AmbientBand::Mid => EMOTE_PCT_MID,
                AmbientBand::Low => EMOTE_PCT_LOW,
            };
            assert!(fired <= pct * 10 + 5,
                "{band:?} 触发 {fired}/1000 超过上限 {}%", pct);
            assert!(fired >= pct * 10 - 5,
                "{band:?} 触发 {fired}/1000 低于下限 {}%——概率门被谁改了？", pct);
        }
    }

    /// C-1：时段分档边界——含头不含尾，与睡眠段常量对齐；越界小时按正午（Day）。
    #[test]
    fn time_band_splits_day_evening_night() {
        assert_eq!(time_band(0), TimeBand::Night, "凌晨属深夜");
        assert_eq!(time_band(6), TimeBand::Night);
        assert_eq!(time_band(7), TimeBand::Day, "睡醒点归白天（含头）");
        assert_eq!(time_band(12), TimeBand::Day);
        assert_eq!(time_band(17), TimeBand::Day);
        assert_eq!(time_band(18), TimeBand::Evening, "渐静段含头");
        assert_eq!(time_band(22), TimeBand::Evening);
        assert_eq!(time_band(23), TimeBand::Night, "睡眠段含头");
        assert_eq!(time_band(99), TimeBand::Day, "越界值不猜深夜（失败方向取「不闹中取静」的反面：正午）");
    }

    /// C-2：深夜权重修正——wave 无条件压到 1（心情加成让位给时辰）、安静行抬到 2、
    /// 其余行不动；**任何行任何时段都不为 0**（只改概率不改节目单）。
    #[test]
    fn row_weight_calms_down_at_night() {
        assert_eq!(row_weight("wave", AmbientBand::High, TimeBand::Night), 1,
            "深夜 wave 压到 1——High 的心情加成让位给时辰");
        assert!(row_weight("wave", AmbientBand::High, TimeBand::Night)
            < row_weight("wave", AmbientBand::High, TimeBand::Day),
            "深夜必须比白天安静");
        for r in ["wait", "idle2", "idle5"] {
            assert_eq!(row_weight(r, AmbientBand::Mid, TimeBand::Night), 2, "深夜 {r} 抬到 2");
            assert_eq!(row_weight(r, AmbientBand::Mid, TimeBand::Evening), 2, "傍晚 {r} 抬到 2");
            assert_eq!(row_weight(r, AmbientBand::Mid, TimeBand::Day), 1, "白天 {r} 不动");
        }
        // 未被点名参与修正的行：三时段一致（不搭车）
        for r in ["idle3", "idle4", "review", "jump"] {
            for band in [AmbientBand::Low, AmbientBand::Mid, AmbientBand::High] {
                let d = row_weight(r, band, TimeBand::Day);
                assert_eq!(row_weight(r, band, TimeBand::Night), d, "{r} 不该被深夜修正搭车");
                assert_eq!(row_weight(r, band, TimeBand::Evening), d, "{r} 不该被傍晚修正搭车");
            }
        }
        // 节目单纪律：全行全时段全心情，权重永不为 0
        for r in ambient_pool("whale").iter().chain(ambient_pool("kurumi")) {
            for band in [AmbientBand::Low, AmbientBand::Mid, AmbientBand::High] {
                for t in [TimeBand::Day, TimeBand::Evening, TimeBand::Night] {
                    assert!(row_weight(r, band, t) >= 1, "{r} {band:?} {t:?} 权重归零=从节目单删除");
                }
            }
        }
    }

    /// C-3：深夜不跳舞——High 档在 Night 换张望（Look），Dance 只属于白天/傍晚；
    /// 概率门本身不变（仍按 EMOTE_PCT_HIGH 触发，只是换了词）。
    #[test]
    fn ambient_wants_emote_never_dances_at_night() {
        for rnd in 0..1000u32 {
            assert_ne!(ambient_wants_emote(AmbientBand::High, rnd, TimeBand::Night),
                Some(EmoteKind::Dance), "深夜不该跳舞（rnd={rnd}）");
            if let Some(k) = ambient_wants_emote(AmbientBand::High, rnd, TimeBand::Night) {
                assert_eq!(k, EmoteKind::Look, "深夜 High 档换张望");
            }
        }
        // 白天/傍晚保持 Dance（原口径不回归）
        let mut saw_dance = false;
        for rnd in 0..1000u32 {
            if let Some(EmoteKind::Dance) = ambient_wants_emote(AmbientBand::High, rnd, TimeBand::Day) {
                saw_dance = true;
            }
            if let Some(EmoteKind::Dance) = ambient_wants_emote(AmbientBand::High, rnd, TimeBand::Evening) {
                saw_dance = true;
            }
        }
        assert!(saw_dance, "白天/傍晚 High 档必须还能跳舞——原口径回归");
        // Low/Mid 档的词表不受时段影响
        for rnd in 0..500u32 {
            for t in [TimeBand::Day, TimeBand::Evening, TimeBand::Night] {
                if let Some(k) = ambient_wants_emote(AmbientBand::Low, rnd, t) {
                    assert!(matches!(k, EmoteKind::Shiver | EmoteKind::Look));
                }
                if let Some(k) = ambient_wants_emote(AmbientBand::Mid, rnd, t) {
                    assert!(matches!(k, EmoteKind::Turn | EmoteKind::Shake));
                }
            }
        }
    }

    /// P0-F2：emote 时长表——七种都有正时长，Sleep 是续期档。
    #[test]
    fn emote_durations_are_positive() {        for k in [EmoteKind::Nod, EmoteKind::Shake, EmoteKind::Turn, EmoteKind::Shiver, EmoteKind::Dance, EmoteKind::Look] {
            assert!(emote_duration(k) > 0 && emote_duration(k) < SLEEP_MS, "{k:?} 时长异常");
        }
        assert_eq!(emote_duration(EmoteKind::Sleep), SLEEP_MS);
    }

    /// P0-F2：Emote 在 Idle 态落 idle 基础行（编舞在绘制层），非 Idle 态被状态压住。
    #[test]
    fn emote_uses_idle_base_row_and_yields_to_states() {
        let nod = slot(Action::Emote { kind: EmoteKind::Nod }, NOD_MS);
        assert_eq!(pick_state_row(PetState::Idle, Some(&nod)), "idle");
        assert_eq!(pick_state_row(PetState::Thinking, Some(&nod)), "run");
        assert_eq!(pick_state_row(PetState::Waiting, Some(&nod)), "wait");
        let dance = slot(Action::Emote { kind: EmoteKind::Dance }, DANCE_MS);
        assert_eq!(pick_state_row(PetState::Idle, Some(&dance)), "idle");
    }
}
