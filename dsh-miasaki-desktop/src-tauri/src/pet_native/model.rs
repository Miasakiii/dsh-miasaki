//! 行为模型：动作槽 + 台词池（D2 拆分；v3 M1 统一动作槽、M2 六态行选择）
use super::config::*;
use super::PetState;
use super::ffi::rand_u32;
// M4.1：吸附判定要用 `Rect`。它是 `#[repr(C)]` 的纯数据（无 extern 块、无 Win32 符号），
// 引入它不会让本文件失去「可 `rustc --test` 直编」的资格 —— 这是把判定放 model.rs 的前提。
use super::ffi::Rect;
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
///
/// **E5（2026-10-04）不重复同一条**（对齐上游 dsh-pet 的「档内轮换、避免连播同一段」）：
/// 原实现是 `rand % 3` 均匀随机 ⇒ **连续两次选到同一行的概率是 1/3**，
/// 而 idle 态下 ambient 是唯一的动作来源，等于每三次就有一次「刚才好像没动」。
/// 修法是重抽一次而**不是**重排权重（后者会改动 `AMBIENT_JUMP_PCT` 的既有意图）。
///
/// **为什么要抽成两个纯函数**：`rand_u32()` 走 Win32 FFI、**不可注入种子** ⇒ 单元测试无法验证
/// 「确实避开了上次」这种时序性质。故把「选行」与「记状态」拆开：
/// `pick_ambient_pool_index()` 是纯函数（给定随机数与上次索引，返回新的且必不等于上次）；
/// `pick_ambient_row()` 只做粘合（取随机数、调用纯函数、记状态）。这样单测能直接跑纯函数，
/// 顺带保证「记忆状态」这件事只有一处写（下面的 `AMBIENT_LAST`）。
pub(crate) fn pick_ambient_pool_index(rnd: u32, last: Option<usize>) -> usize {
    const POOL_LEN: usize = 3;
    let first = (rnd as usize) % POOL_LEN;
    match last {
        // 池只有 1 项时无「别的可選」——去重在此无意义（且不能死循环）。
        Some(prev) if POOL_LEN > 1 && first == prev => (first + 1 + (rnd as usize) / POOL_LEN % (POOL_LEN - 1)) % POOL_LEN,
        _ => first,
    }
}

// ambient 池上次选中的行下标（窗口线程独占，compose 循环单线程调用，无需原子操作）。
//
// **用 `Cell` 而非 `static mut`**：`static mut` 在 Rust 里是待裁剪的 UB 来源，
// 而 `Cell<Option<usize>>` 给出同样的「进程内可改」语义且不引入 `unsafe`。
// 33ms 主路径的写入是一次整数写，**零分配**（符合 `ARCHITECTURE.md` 铁律）。
thread_local! {
    static AMBIENT_LAST: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

pub(crate) fn pick_ambient_row() -> String {
    if rand_u32() % 100 < AMBIENT_JUMP_PCT {
        return "jump".to_string();
    }
    const POOL: [&str; 3] = ["wave", "review", "wait"];
    let rnd = rand_u32();
    // 记忆状态只有这一处读写（E5 纪律：避免散在多处后互相覆盖）。
    let picked = AMBIENT_LAST.with(|c| {
        let next = pick_ambient_pool_index(rnd, c.get());
        c.set(Some(next));
        next
    });
    POOL[picked].to_string()
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
pub(crate) fn pick_dock_edge(role: Rect, work: Rect) -> Option<DockEdge> {
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
    let m = DOCK_MARGIN_PX;
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
/// **为什么是「恰好等于」而不是「至少」**：贴边后若仍有多余外移量，角色会明显悬在屏幕外
/// （用户看到的是"桌宠有一截在屏外"，而 R3 的 `pos_visible` 只按**角色区域**判可见，
/// 不会把它拉回来）。
///
/// **依赖 `pick_dock_edge` 的不变量**：调用方必须先判过边 —— 本函数只负责「推出多少」，
/// 不判断「该不该推」（混在一起会让「角落同时贴两边」的情形无法表达）。
///
/// 返回 `None` 表示 `role` 不在该边的工作区内（推出去会跑错屏）——调用方应保持原位。
pub(crate) fn dock_push_out(
    pos: (i32, i32),
    role: Rect,
    work: Rect,
    edge: DockEdge,
) -> Option<(i32, i32)> {
    // 角色区域与工作区无交集 ⇒ 跨屏推算无意义（会出现窗口跑掉一整屏）
    if role.right <= work.left || role.left >= work.right || role.bottom <= work.top
        || role.top >= work.bottom
    {
        return None;
    }
    let dx = match edge {
        // 角色左边要距工作区左边 m ⇒ 窗口 x = work.left + m - role.left（role 是相对窗口的偏移）
        DockEdge::Left => work.left + DOCK_MARGIN_PX - role.left,
        DockEdge::Right => work.right - DOCK_MARGIN_PX - role.right,
        DockEdge::Top | DockEdge::Bottom => 0,
    };
    let dy = match edge {
        DockEdge::Top => work.top + DOCK_MARGIN_PX - role.top,
        DockEdge::Bottom => work.bottom - DOCK_MARGIN_PX - role.bottom,
        DockEdge::Left | DockEdge::Right => 0,
    };
    if dx == 0 && dy == 0 {
        return Some(pos);
    }
    Some((pos.0 + dx, pos.1 + dy))
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
pub(crate) fn peek_slide_target(role: Rect, edge: DockEdge, exposure: f32) -> f32 {
    (1.0 - exposure) * peek_extent(role, edge) as f32 + DOCK_MARGIN_PX as f32
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
pub(crate) fn peek_advance(st: &mut PeekState, role: Rect, edge: DockEdge, dt_ms: u32) {
    let (dur, to) = match st.phase {
        PeekPhase::Entering => (PEEK_ENTER_MS, peek_slide_target(role, edge, PEEK_REST_EXPOSURE)),
        PeekPhase::Straightening => {
            (PEEK_STRAIGHTEN_MS, peek_slide_target(role, edge, PEEK_ENGAGE_EXPOSURE))
        }
        PeekPhase::Returning => (PEEK_RETURN_MS, peek_slide_target(role, edge, PEEK_REST_EXPOSURE)),
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
    #[test]
    fn ambient_pool_never_repeats_previous() {
        for last in [None, Some(0usize), Some(1), Some(2)] {
            for rnd in 0..1000u32 {
                let idx = pick_ambient_pool_index(rnd, last);
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
            let idx = pick_ambient_pool_index(rnd, last_opt);
            if i > 0 && Some(idx) == last_opt { same_after += 1; }
            last_opt = Some(idx);
        }
        assert_eq!(same_after, 0, "去重后不得出现连播同一条");
    }

    /// E5：首次调用时无「上次」可避（原实现行为），且不得 panic。
    #[test]
    fn ambient_first_call_has_no_previous() {
        let idx = pick_ambient_pool_index(12345, None);
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
        assert_eq!(pick_dock_edge(near_left, work), Some(DockEdge::Left));
        assert_eq!(pick_dock_edge(near_right, work), Some(DockEdge::Right));
        assert_eq!(pick_dock_edge(near_top, work), Some(DockEdge::Top));
        assert_eq!(pick_dock_edge(near_bottom, work), Some(DockEdge::Bottom));
        // 远离所有边 ⇒ 不吸附
        assert_eq!(pick_dock_edge(rect(800, 400, 1050, 800), work), None);
    }

    /// M4.1-2：**完全出屏不得吸附**。角色不在工作区内时若也判「贴边」，
    /// 会把它推到另一条边上（甚至另一块屏）—— 这正是 R3 要用 `pos_visible` 兜底的场景，
    /// 两处判据不能打架。
    #[test]
    fn dock_not_detected_when_fully_outside() {
        let work = rect(0, 0, 1920, 1040);
        // 整块角色在左边外
        assert_eq!(pick_dock_edge(rect(-300, 300, -50, 700), work), None);
        // 整块角色在右边外
        assert_eq!(pick_dock_edge(rect(2000, 300, 2250, 700), work), None);
        // 整块在下方
        assert_eq!(pick_dock_edge(rect(700, 1100, 950, 1500), work), None);
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
        let pushed = dock_push_out(pos0, role0, work, DockEdge::Left).expect("应可推出");
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
        let p = dock_push_out(pos, role_r, work, DockEdge::Right).unwrap();
        // 推出后 role.right = work.right - m ⇒ 窗口 x 需 **+5**（往右推）
        assert_eq!(role_r.right + p.0, work.right - m,
            "右边推出应 +5px（把角色往屏幕内挪），实得 {}", p.0);
        let role_b = rect(700, work.bottom - m - 5 - 400, 950, work.bottom - m - 5);
        let pb = dock_push_out(pos, role_b, work, DockEdge::Bottom).unwrap();
        assert_eq!(role_b.bottom + pb.1, work.bottom - m,
            "下边推出应 +5px，实得 {}", pb.1);
    }

    /// M4.1-5：跨屏时**拒绝推出**（返回 `None`）。
    /// 角色不在该工作区内 ⇒ 推算出的偏移会跑错屏，必须让调用方保持原位。
    #[test]
    fn dock_push_refuses_when_role_outside_work() {
        let work = rect(0, 0, 1920, 1040);
        let role = rect(-300, 300, -50, 700); // 完全在左外
        assert_eq!(dock_push_out((0, 0), role, work, DockEdge::Left), None,
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
        assert_eq!(dock_push_out(pos, role, work, DockEdge::Left), Some(pos),
            "已精确贴边时必须原样返回（否则贴边会抖）");
    }

    /* ---------------- M4.1 · 边缘探头（peek）状态机 ---------------- */

    /// 测试用角色矩形：与 `character_local_rect()` 同构（宽 = WIN_W，高 = CELL_H + 2）。
    fn char_rect() -> Rect {
        rect(0, WIN_H - CELL_H as i32 - 2, WIN_W, WIN_H)
    }

    fn advance_n(st: &mut PeekState, role: Rect, edge: DockEdge, n: u32) {
        for _ in 0..n {
            peek_advance(st, role, edge, 33); // 与 compose 同节拍
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
            let t = peek_slide_target(role, edge, PEEK_REST_EXPOSURE);
            let visible = ext + m - t; // slide > M 后的可见带宽
            assert!((visible / ext - PEEK_REST_EXPOSURE).abs() < 1e-4,
                "Left/Right：可见比例应为 0.55，实得 {}", visible / ext);
        }
        for edge in [DockEdge::Top, DockEdge::Bottom] {
            let ext = peek_extent(role, edge) as f32;
            let t = peek_slide_target(role, edge, PEEK_ENGAGE_EXPOSURE);
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
        let want = peek_slide_target(role, DockEdge::Left, PEEK_REST_EXPOSURE);
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
        let engage = peek_slide_target(role, DockEdge::Right, PEEK_ENGAGE_EXPOSURE);
        assert!((st.slide - engage).abs() < 0.5, "拉直落点应是 engage 档 {engage}，实得 {}", st.slide);

        // 退回：目标是常驻档（继续探头），不是吸附位（没拖走就不该回去）
        peek_kick_return(&mut st);
        assert_eq!(st.phase, PeekPhase::Returning);
        advance_n(&mut st, role, DockEdge::Right, 12);
        assert_eq!(st.phase, PeekPhase::Peeking);
        let rest = peek_slide_target(role, DockEdge::Right, PEEK_REST_EXPOSURE);
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
        assert!(at_interrupt > 0.0 && at_interrupt < peek_slide_target(role, DockEdge::Left, PEEK_REST_EXPOSURE));
        peek_kick_engage(&mut st);
        assert_eq!(st.phase, PeekPhase::Straightening);
        advance_n(&mut st, role, DockEdge::Left, 1);
        let engage = peek_slide_target(role, DockEdge::Left, PEEK_ENGAGE_EXPOSURE);
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
        let target = peek_slide_target(role, DockEdge::Left, PEEK_REST_EXPOSURE);
        let mut st = PeekState::off();
        peek_kick_idle(&mut st);
        let mut last = st.slide;
        for _ in 0..12 {
            peek_advance(&mut st, role, DockEdge::Left, 33);
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
            peek_advance(&mut st, role, DockEdge::Left, 33);
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
            let slide = peek_slide_target(role, DockEdge::Left, exposure).round() as i32;
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
}
