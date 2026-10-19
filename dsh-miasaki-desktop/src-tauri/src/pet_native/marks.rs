//! P1-b（2026-10-18，design/2026-10-18-pet-p1-idle-variants-and-marks.md §3.2）：
// 程序化表情标记——**零资产、零字体、可单测**。
//
// 为什么不出图：六个标记都是几何符号（心/星/泪/怒纹/Z/叹），不是文字——
//! 走 gen-bubbles 的 System.Drawing 路径要为六个小符号新建一条构建期资产链，
//! 而程序化绘制既能零资产又能把「形状判定」本身变成单测（点在内/在外）。
//! 先例：悬浮球的程序化球面渲染（`dot.rs`：径向渐变/高光/落影全手画）。
//!
//! 坐标口径：`mark_shape` 的局部坐标 (x, y) ∈ [-1, 1]²，**y 向下**（屏幕方向），
//! 原点在标记中心。窗口层按「标记盒 × 弹出缩放」映射后逐点调用。
//! 颜色是情绪硬编码（宠物原生绘制层的先例：`dot.rs` 的主题色环同样是硬编码）——
//! `--dsw-*` 令牌管的是 web 设置页，不管分层窗里的像素。

/// 表情标记词表。触发映射见 `window.rs` 的 `show_mark` 调用点。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Mark {
    /// 喜欢/开心（摸头、心情好）
    Heart,
    /// 期待/得意（任务完成）
    Star,
    /// 难过（心情差）
    Tear,
    /// 生气（被咬、出错、fleet 告警）
    Anger,
    /// 困（瞌睡期间周期性浮动——**符号**，见 Zzz）
    Zzz,
    /// 犯困（入睡那一刻的整身表情帧，P2-b；**只有 whale 有表情帧**，
    /// 其余主题回落 Zzz 符号）
    Sleepy,
    /// 惊讶/注意（审批到来）
    Bang,
    /// 害羞（双击挥手——被她逗羞）。符号 = 两团腮红。
    Shy,
    /// 疑惑（散步撞墙——「嗯？怎么过不去」）。符号 = 问号。
    Doubt,
}

/// 心形的采样映射：隐式心形自然 extent 是 x ±1.13、y(上) 1.3 / y(下) −1.0——
/// **非对称且超出 ±1 盒**。直接按比例缩放会裁瓣（按 y 缩）或裁尖（按 x 缩），
/// 故采样坐标做「各轴缩放 + 居中」：`hx = x·1.13`、`hy = −y/0.87 + 0.15`
/// （0.15 = 心形纵向中点 (1.3−1)/2 的归一化偏移）。首版用统一 0.77 缩放，
/// 瓣和尖都出盒——被 `heart_lobes_and_cleft` 当场抓住。
const HEART_SX: f32 = 1.13;
const HEART_SY: f32 = 1.0 / 0.87;
const HEART_DY: f32 = 0.15;

/// 形状判定：(x, y) ∈ [-1, 1]²（y 向下）是否在标记内。
///
/// 全部是隐式/参数化判据（不用字体、不用位图）——「点在内在外」因此可单测，
/// 且缩放/平移不会让形状断裂（与位图放大糊边相反）。
pub(crate) fn mark_shape(m: Mark, x: f32, y: f32) -> bool {
    if !x.is_finite() || !y.is_finite() {
        return false;
    }
    match m {
        Mark::Heart => {
            // 经典心形隐式：(x²+y²−1)³ − x²y³ ≤ 0（数学系 y 向上 ⇒ 传入 −y）；
            // 采样坐标先按 HEART_SX/SY/DY 映射把非对称的心形收进 ±1 盒
            let (hx, hy) = (x * HEART_SX, -y * HEART_SY + HEART_DY);
            let t = hx * hx + hy * hy - 1.0;
            t * t * t - hx * hx * hy * hy * hy <= 0.0
        }
        Mark::Star => {
            // 五角星精确极坐标边界：r ≤ cos(π/5)/cos((θ mod 2π/5) − π/5)，
            // 整体旋转 −π/2 让一个角朝上。中心与远点都在判据外/内可锚定。
            let r = (x * x + y * y).sqrt();
            if r > 1.0 {
                return false;
            }
            let theta = y.atan2(x) + std::f32::consts::FRAC_PI_2;
            let step = std::f32::consts::PI / 5.0;
            let m = theta.rem_euclid(2.0 * step);
            let boundary = (std::f32::consts::PI / 5.0).cos() / (m - step).cos();
            r <= boundary
        }
        Mark::Tear => {
            // 上圆 + 下尖（泪滴）：圆 (0, 0.08) r 0.58 ∪ 三角（尖朝下 (0, 1.02)）
            let in_circle = (x * x + (y - 0.08) * (y - 0.08)) <= 0.58 * 0.58;
            if in_circle {
                return true;
            }
            point_in_triangle(x, y, (-0.58, 0.08), (0.58, 0.08), (0.0, 1.02))
        }
        Mark::Anger => {
            // 漫画怒纹：四段短斜线组成的 ╳ 形（中间留空），线段距离场 ≤ 半宽
            let hw = 0.17;
            for &(ax, ay, bx, by) in &[
                (-0.95, -0.95, -0.34, -0.34),
                (0.95, -0.95, 0.34, -0.34),
                (-0.95, 0.95, -0.34, 0.34),
                (0.95, 0.95, 0.34, 0.34),
            ] {
                if seg_dist(x, y, ax, ay, bx, by) <= hw {
                    return true;
                }
            }
            false
        }
        Mark::Zzz => {
            // 三个递减的 Z（每 Z = 顶/斜/底三条线段），向右上方变小
            let hw = 0.13;
            for &(cx, cy, s) in &[(-0.34, 0.34, 0.72), (0.08, -0.08, 0.5), (0.44, -0.44, 0.34)] {
                let (hx, hy) = ((x - cx) / s, (y - cy) / s);
                for &(ax, ay, bx, by) in &[
                    (-0.5, -0.5, 0.5, -0.5),
                    (0.5, -0.5, -0.5, 0.5),
                    (-0.5, 0.5, 0.5, 0.5),
                ] {
                    if seg_dist(hx, hy, ax, ay, bx, by) <= hw {
                        return true;
                    }
                }
            }
            false
        }
        // Sleepy 的形状 = Zzz：它只在「没有表情帧的主题」上落到符号路径，
        // 共用 Zzz 画形；whale 上演 exSleepy 表情帧，根本不到这里
        Mark::Sleepy => mark_shape(Mark::Zzz, x, y),
        // Shy：两团腮红（左 + 右两个小椭圆，脸颊高度）
        Mark::Shy => {
            for &cx in &[-0.55_f32, 0.55] {
                let ex = (x - cx) / 0.28;
                let ey = (y - 0.35) / 0.16;
                if ex * ex + ey * ey <= 1.0 {
                    return true;
                }
            }
            false
        }
        // Doubt：问号 = 弧钩（圆心 (0,-0.35) r0.42，角范围 [-π, π/6]，即从左侧
        // 经顶部到右下——screen 坐标 y 向下，atan2 的这个区间正好是「上半圈到右下」）
        // + 竖笔 + 圆点
        Mark::Doubt => {
            let dx = x;
            let dy = y + 0.35;
            let d2 = dx * dx + dy * dy;
            if d2 >= 0.31 * 0.31 && d2 <= 0.53 * 0.53 {
                // atan2 把「正左方」返回 +π、把「略偏上的左方」返回 -π（±π 折叠），
                // 而钩子要的是「从正左方经顶部」⇒ 把贴 +π 的角折到 -π 一侧，
                // 否则最左端那一点会被误判成「钩子下方的开口」
                let mut ang = dy.atan2(dx);
                if ang > std::f32::consts::PI - 1e-4 {
                    ang -= 2.0 * std::f32::consts::PI;
                }
                if ang >= -std::f32::consts::PI && ang <= std::f32::consts::PI / 6.0 {
                    return true;
                }
            }
            if seg_dist(x, y, 0.36, -0.14, 0.12, 0.38) <= 0.10 {
                return true;
            }
            let px = x - 0.06;
            let py = y - 0.66;
            px * px + py * py <= 0.15 * 0.15
        }
        Mark::Bang => {
            // 感叹号：竖条 + 圆点
            let in_bar = x.abs() <= 0.17 && y >= -0.88 && y <= 0.22;
            if in_bar {
                return true;
            }
            (x * x + (y - 0.6) * (y - 0.6)) <= 0.17 * 0.17
        }
    }
}

/// 标记颜色（RGB，直存 alpha 满）。情绪色——宠物分层窗的硬编码先例见 `dot.rs`。
pub(crate) fn mark_color(m: Mark) -> (u8, u8, u8) {
    match m {
        Mark::Heart => (0xFF, 0x5A, 0x7A), // 粉红
        Mark::Star => (0xFF, 0xC9, 0x4D),  // 金
        Mark::Tear => (0x7E, 0xC8, 0xFF),  // 浅蓝
        Mark::Anger => (0xE0, 0x4B, 0x4B), // 怒红
        Mark::Zzz => (0xB9, 0xA8, 0xE0),   // 薰衣草
        Mark::Sleepy => (0xB9, 0xA8, 0xE0), // 同 Zzz（符号路径共用）
        Mark::Shy => (0xFF, 0x8A, 0xA8),   // 腮红粉
        Mark::Doubt => (0x8A, 0x90, 0xA8), // 问号灰蓝
        Mark::Bang => (0xFF, 0x9A, 0x3D),  // 橙
    }
}

/// 标记播放状态（窗口层持字段；纯逻辑在本模块，与 `ActionSlot` 同分工）。
/// **到期即清**——compose 每拍检查，绝不留一个永久挂在头顶的符号。
pub(crate) struct MarkPlay {
    pub(crate) kind: Mark,
    pub(crate) started: std::time::Instant,
    pub(crate) dur: std::time::Duration,
}
impl MarkPlay {
    pub(crate) fn new(kind: Mark, now: std::time::Instant, dur_ms: u64) -> Self {
        MarkPlay { kind, started: now, dur: std::time::Duration::from_millis(dur_ms) }
    }

    pub(crate) fn expired(&self, now: std::time::Instant) -> bool {
        now.duration_since(self.started) >= self.dur
    }

    /// 播放进度 p ∈ [0, 1]（夹取；到期后恒 1，由调用方清字段）。
    pub(crate) fn progress(&self, now: std::time::Instant) -> f32 {
        if self.dur.is_zero() {
            return 1.0;
        }
        (now.duration_since(self.started).as_secs_f32() / self.dur.as_secs_f32()).clamp(0.0, 1.0)
    }
}

/// 一帧演出参数：`p ∈ [0, 1]`（播放进度）→ `(弹出缩放, 浮动 bob px, alpha 0..1)`。
///
/// 弹出 = 0.4 → 1.15（过冲）→ 1.0（落定）；bob = 上下浮动 3px；alpha 两端淡入淡出
/// （p=1 时归零 ⇒ 标记消失的那一帧不留残影）。退化入参（NaN/越界）夹取回中性。
pub(crate) fn mark_frame(p: f32) -> (f32, f32, f32) {
    let p = if p.is_finite() { p.clamp(0.0, 1.0) } else { 0.0 };
    let scale = if p < 0.3 {
        let t = p / 0.3;
        0.4 + 0.75 * (1.0 - (1.0 - t) * (1.0 - t)) // ease-out，落点 1.15（过冲）
    } else {
        1.15 - 0.15 * ((p - 0.3) / 0.7) // 回落到 1.0
    };
    let bob = (2.0 * std::f32::consts::PI * p).sin() * 3.0;
    let alpha = (p / 0.15).min(1.0) * ((1.0 - p) / 0.2).min(1.0);
    (scale, bob, alpha.clamp(0.0, 1.0))
}

/* ---------------- 内部几何工具 ---------------- */

/// 点到线段的距离（线段距离场——怒纹/Zzz 的「线宽」由它给出）。
fn seg_dist(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let (dx, dy) = (bx - ax, by - ay);
    let len2 = dx * dx + dy * dy;
    if len2 <= 1e-9 {
        return ((px - ax) * (px - ax) + (py - ay) * (py - ay)).sqrt();
    }
    let t = (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0);
    let (cx, cy) = (ax + t * dx, ay + t * dy);
    ((px - cx) * (px - cx) + (py - cy) * (py - cy)).sqrt()
}

/// 点在三角形内（重心坐标法，含边界）。泪滴的尖角由它给出。
fn point_in_triangle(px: f32, py: f32, a: (f32, f32), b: (f32, f32), c: (f32, f32)) -> bool {
    let cross = |u: (f32, f32), v: (f32, f32)| u.0 * v.1 - u.1 * v.0;
    let d1 = cross((px - a.0, py - a.1), (b.0 - a.0, b.1 - a.1));
    let d2 = cross((px - b.0, py - b.1), (c.0 - b.0, c.1 - b.1));
    let d3 = cross((px - c.0, py - c.1), (a.0 - c.0, a.1 - c.1));
    let neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(neg && pos)
}

// ── P1-b：事件 → 标记的纯函数映射 ──────────────────────────────────────────────
//
// 为什么抽成纯函数（P0 的 `throw_triggered` 同款纪律）：源码契约只能查
// 「调用在不在文本里」，查不到「调用被 `if false` 掉 / 被注释」——反向验证
// 当场证明过。映射本身（哪个事件配哪个符号）必须有单测 seam；窗口层的触发点
// 只是「调用它」的胶水，由契约锚定存在性、实机走查定感性。

use super::model::PetEvent;

/// 互动事件 → 表情标记。`None` = 该事件不挂符号（没反应也是一种反应）。
pub(crate) fn mark_for_pet_event(ev: PetEvent) -> Option<Mark> {
    match ev {
        PetEvent::Stroke => Some(Mark::Heart), // 摸一下 = 喜欢
        PetEvent::Bite => Some(Mark::Anger),   // 咬手 = 生气
        PetEvent::None => None,
    }
}

/// 提醒优先级 → 表情标记：需要行动的才挂（审批感叹 / fleet 告警怒纹）；
/// 状态档(2)/台词档(3)不挂——那是不用行动的通知，挂了就是视觉噪音
/// （与 R20-b「状态气泡不响」同一族口径）。
pub(crate) fn mark_for_alert_priority(priority: u8) -> Option<Mark> {
    match priority {
        super::model::ALERT_PRI_APPROVAL => Some(Mark::Bang),
        super::model::ALERT_PRI_ALERT => Some(Mark::Anger),
        _ => None,
    }
}

/// 完成庆祝 → 星星（得意/期待）。单独一个函数是因为它不在 PetEvent/优先级
/// 两条线上（Done 是六态派生，不是互动事件）——但同样需要可单测的 seam。
pub(crate) fn mark_for_done() -> Mark {
    Mark::Star
}

/// P2-b（2026-10-18，design/2026-10-18-pet-p2-recolor-and-expression-sheet.md §4）：
/// 情绪 → **whale 表情帧行名**。表情帧是 AI 生成 + 差异合成到 idle 原帧的整身
/// 瞬时帧（生成管线与授权说明见设计文档 §4）；只有 whale 有（kurumi/inverse
/// 没有表情资产 ⇒ 落回 P1 的几何符号标记）。`None` = 该情绪没有对应表情帧。
/// **`Zzz` 恒为 `None` 是设计**（不是素材缺失）：周期性浮动用符号、不占动作槽，
/// 犯困表情只在入睡瞬间演一次（`Mark::Sleepy` → `exSleepy`）。
pub(crate) fn expression_row_for(kind: Mark) -> Option<&'static str> {
    match kind {
        Mark::Heart => Some("exHappy"),
        Mark::Anger => Some("exAngry"),
        Mark::Star => Some("exStarry"),
        Mark::Bang => Some("exSurprise"),
        Mark::Tear => Some("exSad"),
        Mark::Sleepy => Some("exSleepy"), // 犯困表情帧（2026-10-18 账号充值后补生成）
        Mark::Shy => Some("exShy"),       // 害羞（双击挥手）
        Mark::Doubt => Some("exDoubt"),   // 疑惑（散步撞墙）
        Mark::Zzz => None,                // 周期性浮动仍是符号（不占动作槽）
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 各形状的共同性质：中心在内、四角远点在外、盒外一律在外。
    /// **中心留白例外**：Zzz（三个 Z 分布在三角）/ Anger（眉 + 圆眼）/ Shy（左右
    /// 两团腮红）/ Doubt（问号中心天然空）——这四个形状的「形心」刻意不在几何
    /// 中心，写成白名单而不是把形状改坏（腮红挤到中间就不像腮红了）。
    #[test]
    fn every_mark_has_a_center_and_rejects_the_outside() {
        for m in [Mark::Heart, Mark::Star, Mark::Tear, Mark::Anger, Mark::Zzz, Mark::Sleepy, Mark::Shy, Mark::Doubt, Mark::Bang] {
            let center_empty = matches!(m, Mark::Zzz | Mark::Anger | Mark::Shy | Mark::Doubt);
            assert!(mark_shape(m, 0.0, 0.0) || center_empty,
                "{m:?} 中心应视为在内（Zzz/Anger/Shy/Doubt 中心刻意留空）");
            // 盒外（1.5 倍远处）一律不在
            for &(x, y) in &[(1.5, 0.0), (-1.5, 0.0), (0.0, 1.5), (0.0, -1.5), (1.2, 1.2)] {
                assert!(!mark_shape(m, x, y), "{m:?} 盒外点 ({x},{y}) 应在形外");
            }
        }
        // 四个「中心留白」形状各有一个明确的形内锚点（防白名单被滥用成「哪都不在」）
        assert!(mark_shape(Mark::Shy, -0.55, 0.35), "腮红左团应在内");
        assert!(mark_shape(Mark::Shy, 0.55, 0.35), "腮红右团应在内");
        assert!(mark_shape(Mark::Doubt, 0.0, -0.77), "问号弧顶应在内");
        assert!(mark_shape(Mark::Doubt, 0.24, 0.12), "问号竖笔应在内");
        assert!(mark_shape(Mark::Doubt, 0.06, 0.66), "问号点应在内");
        // 弧钩的正左端（atan2 ±π 折叠点）必须算在内——否则问号左端缺一个像素
        assert!(mark_shape(Mark::Doubt, -0.42, -0.35), "问号弧左端应在内");
    }

    /// 心形：上两瓣（y 负 = 屏幕上方的两瓣在内）、顶尖与 cleft 的读感。
    #[test]
    fn heart_lobes_and_cleft() {
        // 两瓣（屏幕上方的左右两侧）在内
        assert!(mark_shape(Mark::Heart, -0.45, -0.72));
        assert!(mark_shape(Mark::Heart, 0.45, -0.72));
        // 顶尖（屏幕下方尖端）在内
        assert!(mark_shape(Mark::Heart, 0.0, 0.85));
        // cleft 比两瓣低（心形凹口）：顶中心比顶侧瓣更靠近中心
        let mut center_top = 0.0_f32;
        for i in 0..100 {
            let y = -1.0 + 0.02 * i as f32;
            if mark_shape(Mark::Heart, 0.0, y) {
                center_top = y;
                break;
            }
        }
        let mut lobe_top = 0.0_f32;
        for i in 0..100 {
            let y = -1.0 + 0.02 * i as f32;
            if mark_shape(Mark::Heart, 0.45, y) {
                lobe_top = y;
                break;
            }
        }
        assert!(lobe_top < center_top - 0.05,
            "侧瓣应比中瓣（cleft）更高：lobe={lobe_top} center={center_top}");
        // 左右远点不在
        assert!(!mark_shape(Mark::Heart, 1.0, 0.0));
        // 对称性：x 与 −x 判定一致
        for i in 0..20 {
            let x = -1.0 + 2.0 * i as f32 / 19.0;
            for j in 0..20 {
                let y = -1.0 + 2.0 * j as f32 / 19.0;
                assert_eq!(mark_shape(Mark::Heart, x, y), mark_shape(Mark::Heart, -x, y),
                    "心形应左右对称：({x},{y})");
            }
        }
    }

    /// 星星：五角（0° 起一个角朝上）与五凹交替——角方向远、凹方向近。
    #[test]
    fn star_points_and_valleys() {
        // 朝上的角（x=0, y=−1 方向）应在内；凹谷（≈36° 方向）同半径应判外
        assert!(mark_shape(Mark::Star, 0.0, -0.95), "顶角应在内");
        assert!(!mark_shape(Mark::Star, 0.95 * (36.0_f32).to_radians().sin(), -0.95 * (36.0_f32).to_radians().cos()),
            "凹谷方向同半径应在形外");
        // 同一半径上必须有内有外（五角星的读感来源）：每 36° 采一点，五角五谷
        let (mut inside, mut outside) = (0, 0);
        for k in 0..10 {
            let ang = k as f32 * std::f32::consts::PI / 5.0;
            let (x, y) = (0.95 * ang.sin(), -0.95 * ang.cos());
            if mark_shape(Mark::Star, x, y) {
                inside += 1;
            } else {
                outside += 1;
            }
        }
        assert!(inside >= 5 && outside >= 5,
            "半径 0.95 上应五角在内、五谷在外（实测 in={inside} out={outside}）");
    }

    /// 泪滴：上圆饱满、下尖收束——尖端点在内、尖角两侧远点在外。
    #[test]
    fn teardrop_round_top_sharp_bottom() {
        assert!(mark_shape(Mark::Tear, 0.0, 0.95), "尖底应在内");
        assert!(mark_shape(Mark::Tear, 0.0, -0.3), "圆顶应在内");
        assert!(!mark_shape(Mark::Tear, 0.0, 1.3), "尖角再往下应在形外");
        assert!(!mark_shape(Mark::Tear, 0.9, 0.95), "尖角两侧应在形外");
    }

    /// 怒纹：四段斜线在、中心留空（╳ 形）。
    #[test]
    fn anger_is_a_hollow_cross() {
        assert!(mark_shape(Mark::Anger, -0.75, -0.75), "左上斜线应在内");
        assert!(mark_shape(Mark::Anger, 0.75, 0.75), "右下斜线应在内");
        assert!(!mark_shape(Mark::Anger, 0.0, 0.0), "中心必须留空（╳ 不是 ✕ 实块）");
    }

    /// Zzz：三个 Z 递减，最小一个仍在盒内、大盒角外不在。
    #[test]
    fn zzz_three_decreasing_zs() {
        assert!(mark_shape(Mark::Zzz, -0.34, 0.34), "最大的 Z 应在内");
        assert!(mark_shape(Mark::Zzz, 0.44, -0.44), "最小的 Z 应在内");
        // 远离 Z 列的点在形外（Z 列沿左下-右上对角排布；(0.9, 0) 在对列之外）
        assert!(!mark_shape(Mark::Zzz, 0.9, 0.0), "Z 列之外应在形外");
        assert!(!mark_shape(Mark::Zzz, 0.95, 0.95), "右下角应在形外");
    }

    /// 感叹号：竖条 + 点，中缝断开。
    #[test]
    fn bang_bar_and_dot_with_a_gap() {
        assert!(mark_shape(Mark::Bang, 0.0, -0.5), "竖条应在内");
        assert!(mark_shape(Mark::Bang, 0.0, 0.6), "圆点应在内");
        assert!(!mark_shape(Mark::Bang, 0.0, 0.4), "条与点之间必须有缝（否则读作棒棒糖）");
    }

    /// 演出参数：过冲落定、bob 有界、两端淡入淡出、退化入参安全。
    #[test]
    fn mark_frame_pops_floats_and_fades() {
        let (s0, _, a0) = mark_frame(0.0);
        assert!((s0 - 0.4).abs() < 1e-6, "起点应最小");
        assert!(a0.abs() < 1e-6, "起点应全透明（淡入）");
        let (s_mid, _, _) = mark_frame(0.3);
        assert!(s_mid > 1.1, "0.3 处应过冲（>{s_mid}）");
        let (s_end, _, a_end) = mark_frame(1.0);
        assert!((s_end - 1.0).abs() < 1e-6, "终点应回 1.0");
        assert!(a_end.abs() < 1e-6, "终点应全透明（淡出，不留残影）");
        for i in 0..=100 {
            let p = i as f32 / 100.0;
            let (s, bob, a) = mark_frame(p);
            assert!((0.4..=1.2).contains(&s), "缩放越界：{s}");
            assert!(bob.abs() <= 3.0 + 1e-3, "bob 越界：{bob}");
            assert!((0.0..=1.0).contains(&a), "alpha 越界：{a}");
        }
        // 退化入参：NaN / 越界 ⇒ 中性安全值
        let (s, bob, a) = mark_frame(f32::NAN);
        assert!(s.is_finite() && bob.is_finite() && a.is_finite());
        assert!((s - 0.4).abs() < 1e-6, "NaN 夹到起点（不猜）");
        let (s2, _, _) = mark_frame(5.0);
        assert!((s2 - 1.0).abs() < 1e-6, "越界进度夹到终点");
    }

    /// 缩放连续性：标记放大时形状不断裂（判据是标量的，天然成立——
    /// 这条锚「窗口层按盒映射」的口径：盒内坐标必须落在 [-1,1] 再调用）。
    #[test]
    fn shape_is_continuous_across_the_box() {
        // 沿 x 轴扫过心形，判定从外→内→外必须至少翻转两次（有进有出）
        let mut flips = 0;
        let mut prev = mark_shape(Mark::Heart, -1.0, 0.0);
        for i in 1..=200 {
            let x = -1.0 + 2.0 * i as f32 / 200.0;
            let cur = mark_shape(Mark::Heart, x, 0.0);
            if cur != prev {
                flips += 1;
            }
            prev = cur;
        }
        assert!(flips >= 2, "水平扫心应至少两次进出（实测 {flips} 次）");
    }

    /* ---------------- 事件 → 标记映射（纯函数 seam） ---------------- */

    /// 互动事件映射： Stroke→Heart / Bite→Anger / None→无。
    /// 「Stroke 映射成 Tear」这类回归由本测试抓（契约抓不到，见纯函数化注释）。
    #[test]
    fn pet_event_mapping_is_the_intended_one() {
        assert_eq!(mark_for_pet_event(PetEvent::Stroke), Some(Mark::Heart));
        assert_eq!(mark_for_pet_event(PetEvent::Bite), Some(Mark::Anger));
        assert_eq!(mark_for_pet_event(PetEvent::None), None);
    }

    /// 优先级映射：审批感叹 / 告警怒纹 / 状态与台词不挂。
    #[test]
    fn alert_priority_mapping_only_covers_actionable() {
        assert_eq!(mark_for_alert_priority(super::super::model::ALERT_PRI_APPROVAL), Some(Mark::Bang));
        assert_eq!(mark_for_alert_priority(super::super::model::ALERT_PRI_ALERT), Some(Mark::Anger));
        assert_eq!(mark_for_alert_priority(super::super::model::ALERT_PRI_STATE), None,
            "状态气泡不挂符号（不用行动的通知，挂了是视觉噪音）");
        assert_eq!(mark_for_alert_priority(super::super::model::ALERT_PRI_QUOTE), None,
            "随机台词不挂符号");
    }

    /// Done → 星星。
    #[test]
    fn done_maps_to_star() {
        assert_eq!(mark_for_done(), Mark::Star);
    }

    /// P2-b：情绪 → 表情帧行名。八者有帧、Zzz 无（周期性浮动保持符号——
    /// 符号不占动作槽，与「入睡瞬间演一次犯困表情」分工）。
    /// 这条同时是「帧名别打错」的**接口契约**（字面量锚定）；真正的跨链校验
    /// （行名必须存在于 `frames.json` 的 whale 行键）在 `check-pet-assets.mjs`
    /// 与 `gen-sfx`/`gen-halo` 同族的产物闸门里做——本单测**不读** frames.json，
    /// 因为 unit test 不依赖工作区文件是既有纪律（2026-10-18 审查订正注释口径）。
    #[test]
    fn expression_rows_match_the_registered_atlas_keys() {
        assert_eq!(expression_row_for(Mark::Heart), Some("exHappy"));
        assert_eq!(expression_row_for(Mark::Anger), Some("exAngry"));
        assert_eq!(expression_row_for(Mark::Star), Some("exStarry"));
        assert_eq!(expression_row_for(Mark::Bang), Some("exSurprise"));
        assert_eq!(expression_row_for(Mark::Tear), Some("exSad"));
        assert_eq!(expression_row_for(Mark::Sleepy), Some("exSleepy"));
        assert_eq!(expression_row_for(Mark::Shy), Some("exShy"));
        assert_eq!(expression_row_for(Mark::Doubt), Some("exDoubt"));
        assert_eq!(expression_row_for(Mark::Zzz), None,
            "周期性 Zzz 保持符号（不占动作槽；犯困表情只在入睡瞬间演）");
    }
}
