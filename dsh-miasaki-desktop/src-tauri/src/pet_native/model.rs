//! 行为模型：ambient/wander 状态 + 台词池（D2 拆分）
use super::config::*;
use super::ffi::rand_u32;
/* ---------------- 窗口状态 ---------------- */

pub(crate) struct Wander {
    pub(crate) until: std::time::Instant,
    pub(crate) dx: i32,
}

// v2:环境编排拍(低频随机小动作,wave/review/wait + 偶发 jump)
pub(crate) struct Ambient {
    pub(crate) row: String,
    pub(crate) until: std::time::Instant,
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
