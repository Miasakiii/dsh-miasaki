//! L1 绘制层动效（design/pet-v5-motion-plan.md §3）：变换数学 + 动效相位。
//!
//! 三条设计纪律（沿用参考实现与我方既有分层）：
//! - **纯逻辑**：无 Win32 / GDI 依赖，可 `cargo test` 单测（对齐 `model.rs` 的分层口径）；
//! - **零分配**：只做 f32 运算，不构造任何容器；采样就地写进 `buf`（`window.rs`）；
//! - **单值来源**：`compose` 每帧算一次 `DrawXform`，绘制与命中**共用同一份合成结果**。
//!
//! 最后一条是对 motion-plan §3.3 的**订正**：该处把「命中判定必须与绘制同批改造」列为硬约束，
//! 那是参考实现的前提（它为每种元素单独维护 mask，旋转后 mask 与画面脱钩）。我方 R2 的
//! `is_transparent_at` 查的是**最终合成缓冲** `buf`（见 `window.rs` 该函数注释），
//! 变换在写入 `buf` 时就已完成，命中因此天然跟随绘制，**无需逆变换副本、不构成待办**。
//!
//! 坐标口径（绘制唯一的采样路径）：目标像素（窗口坐标）→ 相对 pivot 的偏移 → **逆变换**
//! → 未变换框内坐标 → 源图双线性采样。逆向映射（而非正向撒点）从结构上避免旋转采样空洞。
use super::config::*;

/// 绘制变换：绕**底部中心** pivot 的旋转 + 非等比缩放（挤压拉伸）。
///
/// 正向 = `R(θ) · S(sx, sy)`：先把未变换框按 (sx, sy) 缩放，再整体绕 pivot 旋转；
/// 因此逆变换 = `S⁻¹ · R(−θ)`：先按 −θ 反转，再按 (1/sx, 1/sy) 反缩放。
///
/// pivot 取底边中心与 `blit_center_bottom` 的底部对齐口径一致 —— 旋转的观感是
/// 「以双脚为支点左右摇」，而不是绕腰或绕画面中心转。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct DrawXform {
    pub(crate) rot_rad: f32,
    pub(crate) sx: f32,
    pub(crate) sy: f32,
}

impl DrawXform {
    /// 中性变换（不旋转、不缩放）。仅用于**没有动效**的直通路径。
    pub(crate) const IDENTITY: DrawXform = DrawXform { rot_rad: 0.0, sx: 1.0, sy: 1.0 };

    /// 唯一构造入口：非有限值回中性，缩放夹到 `XF_MIN_SCALE..=XF_MAX_SCALE`。
    ///
    /// 夹取的硬理由：`inverse_offset` 要除以 `sx`/`sy`，0 会产出 inf/NaN 并污染整帧缓冲
    /// （NaN 比较恒 false ⇒ 越界检查失效 ⇒ 可能索引越界 panic）。夹取让**任何**上游取值
    /// 都不可能把绘制层打崩，这与 `load_png` 的 a<8 兜底、`atlas_row` 的回退链同一哲学。
    pub(crate) fn new(rot_rad: f32, sx: f32, sy: f32) -> Self {
        if !rot_rad.is_finite() || !sx.is_finite() || !sy.is_finite() {
            return Self::IDENTITY;
        }
        DrawXform {
            rot_rad,
            sx: sx.clamp(XF_MIN_SCALE, XF_MAX_SCALE),
            sy: sy.clamp(XF_MIN_SCALE, XF_MAX_SCALE),
        }
    }

    /// 正向：未变换框内**相对 pivot** 的偏移 → 变换后相对 pivot 的偏移。
    ///
    /// 绘制不用它（绘制唯一入口是 `inverse_offset`），它服务于**包围盒求解**与单测的往返自证。
    pub(crate) fn forward_offset(&self, dx: f32, dy: f32) -> (f32, f32) {
        let (s, c) = self.rot_rad.sin_cos();
        let x = dx * self.sx;
        let y = dy * self.sy;
        (x * c - y * s, x * s + y * c)
    }

    /// 逆向：变换后（相对 pivot）的偏移 → 未变换框内（相对 pivot）的偏移。
    /// **这是绘制的唯一采样入口** —— 每个目标像素经它回到源空间。
    pub(crate) fn inverse_offset(&self, dx: f32, dy: f32) -> (f32, f32) {
        let (s, c) = (-self.rot_rad).sin_cos();
        let rx = dx * c - dy * s;
        let ry = dx * s + dy * c;
        (rx / self.sx, ry / self.sy)
    }

    /// 未变换框（宽 `w`、高 `h`，pivot 在底边中心）经本变换后的**最小外接包围盒**。
    ///
    /// 返回值相对**未变换框左上角**（left/top/right/bottom，y 轴向下）。求解 = 四角正向变换取极值，
    /// 每帧只算一次（不在像素循环里），故用逐角法而非解析式 —— 短且不可能推错。
    ///
    /// **横向是不对称的，不要用「±半扩」去写**：底边（相对 pivot 的 y=0）只随旋转平移
    /// `±sx·w/2·cosθ`，而顶边（y=−h）整体还会横移 `sy·h·sinθ` —— 正角时顶边右移、负角时左移。
    /// 首版解析式就是漏了这一点，被 `bounds_never_clips_content_and_is_minimal` 当场抓住。
    /// 纵向同样不对称：底边下扩仅 `sx·w/2·|sinθ|`，顶边上扩还多一项 `sy·h·cosθ` 的高度投影 ——
    /// 这是 pivot 在底边、旋转像钟摆的几何后果，布局侧的 `sway_layout_margin` 正为底边下扩预留。
    ///
    /// 另注：本函数**不保证包含未变换的原框**。`sy < 1`（挤压的纵向压缩）时包围盒顶边会下移，
    /// 原框上部本来就没有内容 —— 不包含是对的。真正的硬判据是「不裁内容」（见同名单测）。
    pub(crate) fn bounds(&self, w: f32, h: f32) -> (f32, f32, f32, f32) {
        let (hw, hh) = (w * 0.5, h);
        let (mut l, mut t, mut r, mut b) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for &dx in &[-hw, hw] {
            for &dy in &[-hh, 0.0] {
                let (ox, oy) = self.forward_offset(dx, dy);
                let (px, py) = (hw + ox, hh + oy);
                if px < l {
                    l = px;
                }
                if py < t {
                    t = py;
                }
                if px > r {
                    r = px;
                }
                if py > b {
                    b = py;
                }
            }
        }
        (l, t, r, b)
    }
}

/// 布局余量：**最大**摇摆幅度下图像最低点低于未变换框底边的距离（px）。
///
/// 取 `SWAY_MAX_DEG`（而非当前相位角）是刻意的：若按当前角补偿，pivot 会随相位上下浮动，
/// 摇摆就变成「上下弹跳 + 摆动」的复合运动。固定 margin ⇒ 底边基线恒定，只有姿态在摇。
///
/// 方向：布局侧把 pivot **上移**该量，保证摇摆全程不越出窗口下沿
/// （`WIN_H - 2` 是 `blit_center_bottom` 的底部留白，不可再被旋转吃掉）。
///
/// 2026-09-29：按 `MOTION_MAX`（用户可设的**最大**强度）算，而不是当前 motion ——
/// 理由与「取最大角而非当前角」同一条：layout 余量必须覆盖整个可设范围，
/// 否则用户把强度拉满时底边会被旋转吃掉，而这个 bug 只在极端档位出现、很难复现。
pub(crate) fn sway_layout_margin(w: f32) -> f32 {
    let max_rad = (SWAY_MAX_DEG * crate::pet_native::settings::MOTION_MAX).to_radians();
    (w * 0.5) * max_rad.sin()
}

/* ---------------- 动效相位（纯函数，参数见 config.rs） ---------------- */

/// 三角波相位：`t_ms` → `sin` 值，周期 `period_ms`。返回 `[-1, 1]`。
fn wave(t_ms: u64, period_ms: u64, shift_ms: u64) -> f32 {
    if period_ms == 0 {
        return 0.0;
    }
    let half = (period_ms / 2).max(1) as f32;
    let phase = ((t_ms.wrapping_add(shift_ms)) % period_ms) as f32 / half * std::f32::consts::PI;
    phase.sin()
}

/// M1 呼吸：正弦垂直位移（px），周期 `BREATH_PERIOD_MS`。
/// `amp` 由调用方按姿态给（图集行 / 三态立绘沿用各自既有幅度，见 config.rs）。
/// `scale` = 用户设的动效强度倍率（`settings.motion`）；`1.0` 即改造前的手感。
pub(crate) fn breath_offset(t_ms: u64, amp: f32, scale: f32) -> f32 {
    wave(t_ms, BREATH_PERIOD_MS, 0) * amp * scale
}

/// M2 摇摆：绕底部 pivot 的旋转角（弧度）。
/// 周期与呼吸不同、并叠加 `SWAY_PHASE_SHIFT_MS` 相位偏移 ⇒ 两者**错相**，
/// 避免「呼吸到顶点时恰好也摆到极值」造成的机械同步感（motion-plan §3.4 M2 要求）。
/// `scale` 同 `breath_offset`。
pub(crate) fn sway_angle(t_ms: u64, scale: f32) -> f32 {
    wave(t_ms, SWAY_PERIOD_MS, SWAY_PHASE_SHIFT_MS) * sway_max_rad() * scale
}

/// M3 挤压拉伸：脉冲进度 `p ∈ [0, 1]` → `(sx, sy)`。
/// `sin(πp)` 在两端为 0 ⇒ **到期即回中性**（与 `ActionSlot` 的「到期即清」同哲学，
/// 不残留形变）；中段最大。参考实现实测参数见 `pet-reference-benchmark.md` §2.10。
/// `scale` 同 `breath_offset`——**不含位移的形变也要受强度影响**，否则「强度调低」时
/// 挤压仍是满幅，观感不一致。
pub(crate) fn squash_scales(p: f32, scale: f32) -> (f32, f32) {
    let k = (std::f32::consts::PI * p.clamp(0.0, 1.0)).sin() * scale;
    (1.0 + SQUASH_DX * k, 1.0 - SQUASH_DY * k)
}

/* ---------------- M4 · 拖动尾随（弹簧插值） ---------------- */

/// 拖动尾随的一维弹簧状态。
///
/// **为什么是「状态 + 纯步进函数」而不是一个闭式公式**：闭式解需要知道整段历史，
/// 而窗口层每拍只该记住上一拍的 `(pos, vel)`（`ARCHITECTURE.md` 的「33ms 主路径零分配」
/// 允许有状态、不允许每帧重算历史）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct DragSpring {
    /// 当前位置（窗口左上角，px）。
    pub(crate) pos: f32,
    /// 当前速度（px/s）。
    pub(crate) vel: f32,
}

/// M4 拖动尾随：把弹簧状态朝目标推进 `dt_ms`，返回新状态。
///
/// **模型**：临界阻尼弹簧（`ζ = 1`）。相比欠阻尼的好处是**不过冲**——
/// 桌宠被甩出去时若过冲会「弹过头再回来」，观感是抽搐而非跟手。
/// 参考实现用的是「阻尼弹簧跟手」这一族（`pet/physics.py` 的拖拽段），
/// 但它把参数散在多处；此处集中成两个常量并由单测钉住。
///
/// **半隐式欧拉**：先更新速度、再用新速度更新位置。显式欧拉在这种刚度下会
/// 「越追越抖」（能量注入），半隐式是这类弹簧的标准稳定写法。
///
/// **为什么不用固定步长**：窗口层由 `IDT_DRAG`（8ms）驱动，帧间隔本身有抖动；
/// 把 `dt` 传进来做参数（而不是写死 8ms）才让「参数正确性」可被单测验证。
/// `dt_ms` 夹到 `[1, 100]`：0 会除零、过大（调试时长时间挂起后恢复）会让弹簧炸开。
pub(crate) fn spring_step(s: DragSpring, target: f32, dt_ms: u32) -> DragSpring {
    let dt = (dt_ms.clamp(1, 100) as f32) / 1000.0;
    // 半隐式欧拉：a = k(target - pos) - c·vel，其中 c = 2√k（临界阻尼）
    let accel = DRAG_SPRING_K * (target - s.pos) - 2.0 * DRAG_SPRING_K.sqrt() * s.vel;
    let vel = s.vel + accel * dt;
    let pos = s.pos + vel * dt;
    DragSpring { pos, vel }
}

/// 弹簧是否已「到位」（尾随该退场了）。
///
/// **两个条件都要满足**：
/// · 位置：目标与当前位置之差 < `DRAG_SPRING_SETTLE_PX`（0.5px）——
///   小于半个像素的滞后肉眼不可见（192px 宽的帧在 33ms 合成周期里走不到 1px）；
///   但若不设阈值，弹簧会**永远在追**（浮点收敛很慢）⇒ 拖动结束后桌宠仍有微幅抖动、
///   `IDT_DRAG` 永不停止。
/// · 速度：`DRAG_SPRING_SETTLE_VEL` —— 位置到了但速度很大意味着**还会过冲**，必须继续积分。
///
/// 顺序无所谓，两者都是「小于阈值」的合取。
pub(crate) fn spring_at_target(s: DragSpring, target: f32) -> bool {
    s.vel.abs() < DRAG_SPRING_SETTLE_VEL && (target - s.pos).abs() < DRAG_SPRING_SETTLE_PX
}


#[cfg(test)]
mod tests {
    use super::*;
    // 动效强度的上限（`sway_layout_margin` 按它算余量，见下方那条测试）。
    use crate::pet_native::settings::MOTION_MAX;

    /// 最宽帧：kurumi / whale 图集帧统一 192×208（实测，`frames.json` 全部行），
    /// 等比缩放到 `CELL_H` 高后的宽度。包围盒与摇摆余量都以它为最坏情况。
    fn widest_frame_w() -> f32 {
        192.0 / 208.0 * CELL_H as f32
    }

    #[test]
    fn identity_is_a_true_no_op() {
        let xf = DrawXform::IDENTITY;
        // 中性参数经 `new` 必须还原出同一个值（构造路径与常量口径一致）
        assert_eq!(xf, DrawXform::new(0.0, 1.0, 1.0));
        assert_eq!(xf.forward_offset(12.0, -34.0), (12.0, -34.0));
        assert_eq!(xf.inverse_offset(12.0, -34.0), (12.0, -34.0));
        // 包围盒 = 原框本身（含端点，故 right/bottom 等于 w/h 而非 w-1/h-1）
        assert_eq!(xf.bounds(100.0, 200.0), (0.0, 0.0, 100.0, 200.0));
        assert_eq!(xf.bounds(100.0, 200.0).3, 200.0);
    }

    /// 逆变换必须严格还原正向（绘制唯一采样入口的正确性基础）。
    #[test]
    fn inverse_undoes_forward() {
        let cases = [
            DrawXform::new(0.0, 1.0, 1.0),
            DrawXform::new(0.0349, 1.0, 1.0),   // 2°
            DrawXform::new(-0.0349, 1.0, 1.0),  // −2°
            DrawXform::new(0.0, 1.10, 0.85),    // 挤压峰值
            DrawXform::new(0.05, 1.04, 0.92),   // 旋转 + 形变叠加
        ];
        for xf in cases {
            for &(dx, dy) in &[(0.0, 0.0), (100.0, 0.0), (-100.0, -200.0), (37.5, -12.25)] {
                let (fx, fy) = xf.forward_offset(dx, dy);
                let (bx, by) = xf.inverse_offset(fx, fy);
                assert!((bx - dx).abs() < 1e-3, "x {dx} -> {bx} ({xf:?})");
                assert!((by - dy).abs() < 1e-3, "y {dy} -> {by} ({xf:?})");
            }
        }
    }

    /// 包围盒的两条性质：**不裁内容** + **最小**。
    ///
    /// ① 不裁内容：框内（四角 + 9×9 网格）任意点的正向变换结果都必须落在包围盒内 ——
    ///    否则绘制会漏掉该像素，视觉上就是「变换把角色切了一块」。
    /// ② 最小：四条边各自贴住至少一个变换后的角，没有多余留白（留白会白白扩大遍历范围）。
    ///
    /// **不要**断言「包围盒恒包含未变换的原框」：`sy < 1` 时顶边会下移，而原框上部本来就没有
    /// 内容，不包含才是对的 —— 首版就是这么误判的（同时漏掉横向不对称，被本测试当场抓住）。
    #[test]
    fn bounds_never_clips_content_and_is_minimal() {
        let (w, h) = (widest_frame_w(), CELL_H as f32);
        let (hw, hh) = (w * 0.5, h);
        for &(rot, sx, sy) in &[
            (0.0_f32, 1.0_f32, 1.0_f32),
            (sway_max_rad(), 1.0, 1.0),
            (-sway_max_rad(), 1.0, 1.0),
            (0.0, 1.0 + SQUASH_DX, 1.0 - SQUASH_DY),
            (0.02, 1.05, 0.95),
            (0.0, XF_MIN_SCALE, XF_MAX_SCALE),
        ] {
            let xf = DrawXform::new(rot, sx, sy);
            let (l, t, r, b) = xf.bounds(w, h);
            let mut corners = Vec::new();
            for &dx in &[-hw, hw] {
                for &dy in &[-hh, 0.0] {
                    let (ox, oy) = xf.forward_offset(dx, dy);
                    corners.push((hw + ox, hh + oy));
                }
            }
            // ① 不裁内容
            for i in 0..=8 {
                for j in 0..=8 {
                    let dx = -hw + w * (i as f32 / 8.0);
                    let dy = -hh + h * (j as f32 / 8.0);
                    let (ox, oy) = xf.forward_offset(dx, dy);
                    let (px, py) = (hw + ox, hh + oy);
                    assert!(
                        px >= l - 1e-2 && px <= r + 1e-2 && py >= t - 1e-2 && py <= b + 1e-2,
                        "{xf:?}: 点 ({dx:.1},{dy:.1}) 变换到 ({px:.1},{py:.1})，落在包围盒 \
                         ({l:.1},{t:.1},{r:.1},{b:.1}) 之外 —— 内容会被裁掉"
                    );
                }
            }
            // ② 最小：四条边各自贴住某个角（0=横坐标，1=纵坐标）
            for (name, edge, axis) in
                [("left", l, 0usize), ("top", t, 1), ("right", r, 0), ("bottom", b, 1)]
            {
                assert!(
                    corners.iter().any(|c| {
                        let v = if axis == 0 { c.0 } else { c.1 };
                        (v - edge).abs() < 1e-3
                    }),
                    "{xf:?}: {name} 边 {edge:.3} 未贴住任何角（包围盒留了多余空白）"
                );
            }
        }
    }

    /// 底边下扩公式 = `sx·w/2·|sinθ|`（布局余量的依据，单测钉死以免摆动越界）。
    #[test]
    fn bottom_overhang_matches_formula() {
        let w = widest_frame_w();
        let xf = DrawXform::new(sway_max_rad(), 1.0, 1.0);
        let (_, _, _, bottom) = xf.bounds(w, CELL_H as f32);
        let expected = sway_max_rad().sin() * w * 0.5;
        assert!((bottom - CELL_H as f32 - expected).abs() < 1e-3);
        // 布局余量必须**不小于**该下扩，否则摇摆到极值时最低点越出窗口
        assert!(sway_layout_margin(w) >= expected - 1e-3);
    }

    /// 摇摆 + 挤压叠加的最坏情况仍要装得进窗口（超限只允许一次性动画，此处是常态动效）。
    ///
    /// 两条硬边界：① 横向不越 `WIN_W`；② 纵向在 `WIN_H - 2` 的底部留白 + 布局余量之内。
    #[test]
    fn worst_case_bbox_fits_window() {
        let w = widest_frame_w();
        let h = CELL_H as f32;
        for &(rot, sx, sy, label) in &[
            (sway_max_rad(), 1.0_f32, 1.0_f32, "摇摆右极值"),
            (-sway_max_rad(), 1.0, 1.0, "摇摆左极值"),
            (0.0, 1.0 + SQUASH_DX, 1.0 - SQUASH_DY, "挤压峰值"),
        ] {
            let (l, t, r, b) = DrawXform::new(rot, sx, sy).bounds(w, h);
            let bbox_w = r - l;
            let bbox_h = b - t;
            assert!(bbox_w <= WIN_W as f32, "{label}: 包围盒宽 {bbox_w:.1} 超 WIN_W");
            assert!(bbox_h <= WIN_H as f32, "{label}: 包围盒高 {bbox_h:.1} 超 WIN_H");
            // 纵向：底边基线 = WIN_H − 2 − margin，包围盒最低点 = 基线 + (b − h) ≤ WIN_H − 2
            let lowest = (WIN_H as f32 - 2.0 - sway_layout_margin(w)) + (b - h);
            assert!(lowest <= WIN_H as f32 - 2.0 + 1e-3, "{label}: 最低点 {lowest:.1} 越界");
            // 顶部不越出窗口上沿
            let highest = (WIN_H as f32 - 2.0 - sway_layout_margin(w)) + (t - h);
            assert!(highest >= 0.0, "{label}: 最高点 {highest:.1} 越界");
        }
    }

    /// 挤压 + 摇摆**同时生效**是横向最坏情况：包围盒宽约 282px，距 `WIN_W`(286) 只剩约 4px。
    ///
    /// 该组合几何上仍放得下（**不构成硬冲突**），但余量太薄，且观感是「歪着压扁」——
    /// 故 `compose` 取「挤压期间关摇摆」的保守口径。本测试把这条依据钉住：
    /// 余量一旦真的转负，说明 `SWAY_MAX_DEG` / `SQUASH_DX` 已被调到不安全区间。
    ///
    /// 订正注记：首版此处断言「叠加必然越界」，那是基于**对称**横向包围盒的错误解析式；
    /// 改成逐角求解后实测 282px。教训是「包围盒横向不对称」——
    /// 顶边随旋转整体横移 `sy·h·sinθ`，底边不动（见 `bounds` 的注释）。
    #[test]
    fn squash_plus_sway_is_the_horizontal_worst_case() {
        let w = widest_frame_w();
        let h = CELL_H as f32;
        let (l, _, r, _) =
            DrawXform::new(sway_max_rad(), 1.0 + SQUASH_DX, 1.0 - SQUASH_DY).bounds(w, h);
        let bbox_w = r - l;
        assert!(bbox_w < WIN_W as f32, "该组合已越界：{bbox_w:.1} ≥ WIN_W");
        let free = WIN_W as f32 - bbox_w;
        assert!(
            free < 6.0,
            "横向余量已回到 {free:.1}px（宽松区）——可重新评估「挤压期间关摇摆」是否还有必要"
        );
        // 单独摇摆必须显著更宽裕，否则说明摇摆幅度本身已经贴边
        let (s0, _, s1, _) = DrawXform::new(sway_max_rad(), 1.0, 1.0).bounds(w, h);
        assert!(WIN_W as f32 - (s1 - s0) > 20.0, "单独摇摆的横向余量不该这么薄");
    }

    #[test]
    fn degenerate_scales_never_reach_divide() {
        for &(rot, sx, sy) in &[
            (f32::NAN, 1.0_f32, 1.0_f32),
            (0.0, 0.0, 1.0),
            (0.0, 1.0, f32::INFINITY),
            (f32::NEG_INFINITY, 0.0, 0.0),
        ] {
            let xf = DrawXform::new(rot, sx, sy);
            let (x, y) = xf.inverse_offset(10.0, -10.0);
            assert!(x.is_finite() && y.is_finite(), "{rot} {sx} {sy} -> ({x},{y})");
            assert!(xf.sx >= XF_MIN_SCALE && xf.sx <= XF_MAX_SCALE);
            assert!(xf.sy >= XF_MIN_SCALE && xf.sy <= XF_MAX_SCALE);
        }
        // 夹取而非回中性：合法的负缩放要被夹到 MIN，不是当成非法值丢掉
        let xf = DrawXform::new(0.0, -5.0, 9.0);
        assert_eq!((xf.sx, xf.sy), (XF_MIN_SCALE, XF_MAX_SCALE));
    }

    /// M1 呼吸：幅度受 `amp` 约束、周期为 `BREATH_PERIOD_MS`、半周期反相。
    /// 2026-09-29：三个相位函数都多了 `scale`（用户动效强度），此处一律传 `1.0` 保持原判据，
    /// 强度本身另有一组测试（`motion_scale_*`）。
    #[test]
    fn breath_is_bounded_and_periodic() {
        let amp = BREATH_PX_ROW;
        for t in (0..(BREATH_PERIOD_MS * 2)).step_by(37) {
            assert!(breath_offset(t, amp, 1.0).abs() <= amp + 1e-4);
        }
        assert!(breath_offset(0, amp, 1.0).abs() < 1e-4, "起点应在中性");
        // 半周期后相位相反
        let a = breath_offset(BREATH_PERIOD_MS / 4, amp, 1.0);
        let b = breath_offset(BREATH_PERIOD_MS / 4 + BREATH_PERIOD_MS / 2, amp, 1.0);
        assert!((a + b).abs() < 1e-3, "半周期应反相: {a} vs {b}");
        // 整周期回到同值
        let c = breath_offset(BREATH_PERIOD_MS / 3, amp, 1.0);
        let d = breath_offset(BREATH_PERIOD_MS / 3 + BREATH_PERIOD_MS, amp, 1.0);
        assert!((c - d).abs() < 1e-3);
    }

    /// M2 摇摆：幅度受 `SWAY_MAX_RAD` 约束，且与呼吸**错相**（周期与相位偏移共同保证）。
    #[test]
    fn sway_is_bounded_and_out_of_phase_with_breath() {
        for t in (0..(SWAY_PERIOD_MS * 2)).step_by(53) {
            assert!(sway_angle(t, 1.0).abs() <= sway_max_rad() + 1e-4);
        }
        // 错相判据：不存在固定的正比例关系 —— 在呼吸的某个峰值处，摇摆不应同时是极值
        let peak_t = BREATH_PERIOD_MS / 4;
        let s = sway_angle(peak_t, 1.0).abs();
        assert!(s < sway_max_rad() * 0.98, "呼吸峰值处摇摆不应同时到极值（错相失效）: {s}");
        // 两周期互不整除同样能防同步：断言各自周期长度不同
        assert_ne!(BREATH_PERIOD_MS, SWAY_PERIOD_MS);
    }

    /// M3 挤压：两端回中性（到期即清、不残留形变）、中段最大、方向正确（横拉伸纵压缩）。
    #[test]
    fn squash_returns_neutral_at_both_ends() {
        let (sx0, sy0) = squash_scales(0.0, 1.0);
        let (sx1, sy1) = squash_scales(1.0, 1.0);
        assert!((sx0 - 1.0).abs() < 1e-4 && (sy0 - 1.0).abs() < 1e-4, "起点须中性");
        assert!((sx1 - 1.0).abs() < 1e-4 && (sy1 - 1.0).abs() < 1e-4, "终点须中性");
        let (sxm, sym) = squash_scales(0.5, 1.0);
        assert!((sxm - (1.0 + SQUASH_DX)).abs() < 1e-4, "峰值 sx 应到上限");
        assert!((sym - (1.0 - SQUASH_DY)).abs() < 1e-4, "峰值 sy 应到下限");
        assert!(sxm > 1.0 && sym < 1.0, "挤压 = 横向拉伸 + 纵向压缩");
        // 越界进度被夹取，不产生越界形变
        assert_eq!(squash_scales(-0.5, 1.0), squash_scales(0.0, 1.0));
        assert_eq!(squash_scales(2.0, 1.0), squash_scales(1.0, 1.0));
    }

    /// 动效强度（`settings.motion`）：三条动效都**线性**受它约束，且 1.0 即改造前的手感。
    #[test]
    fn motion_scale_is_linear_and_neutral_at_one() {
        let amp = BREATH_PX_ROW;
        for t in (0..BREATH_PERIOD_MS).step_by(97) {
            let base = breath_offset(t, amp, 1.0);
            assert!((breath_offset(t, amp, 0.5) - base * 0.5).abs() < 1e-4, "呼吸应线性缩放");
            assert!((breath_offset(t, amp, 1.5) - base * 1.5).abs() < 1e-4);
            let sbase = sway_angle(t, 1.0);
            assert!((sway_angle(t, 0.5) - sbase * 0.5).abs() < 1e-4, "摇摆应线性缩放");
        }
        // 挤压：峰值随强度缩放
        let (sx_lo, _) = squash_scales(0.5, 0.5);
        assert!((sx_lo - (1.0 + SQUASH_DX * 0.5)).abs() < 1e-4, "挤压峰值应随强度减半");
        // 两端回中性与强度无关（任何强度下都不得残留形变）
        for k in [0.0, 0.5, 1.0, MOTION_MAX] {
            let (x, y) = squash_scales(0.0, k);
            assert!((x - 1.0).abs() < 1e-4 && (y - 1.0).abs() < 1e-4, "强度 {k} 下起点仍须中性");
        }
    }

    /// 布局余量必须按**最大**可设强度算：用户把强度拉满时底边不能被旋转吃掉。
    /// 这条钉住 `sway_layout_margin` 与 `MOTION_MAX` 的关系（改任一个都要重新对齐）。
    #[test]
    fn sway_layout_margin_covers_max_motion() {
        let w = 192.0_f32;
        let max_rad = (SWAY_MAX_DEG * MOTION_MAX).to_radians();
        let need = (w * 0.5) * max_rad.sin();
        assert!((sway_layout_margin(w) - need).abs() < 1e-4,
            "余量应按最大强度算：{} vs {}", sway_layout_margin(w), need);
        assert!(sway_layout_margin(w) > (w * 0.5) * sway_max_rad().sin(),
            "最大强度大于 1 ⇒ 余量必须比原值大，否则满强度时越界");
    }

    /* ---------------- M4 · 拖动尾随的弹簧 ---------------- */

    /// M4-1：弹簧**收敛到目标且不过冲**（临界阻尼的定义）。
    ///
    /// 这条同时钉住两件事：① 最终到达目标；② **全程不越过目标**。
    /// ② 是选临界阻尼而非欠阻尼的唯一理由（欠阻尼会过冲 ⇒ 观感是抽搐）。
    #[test]
    fn spring_converges_without_overshoot() {
        let mut s = DragSpring { pos: 0.0, vel: 0.0 };
        let target = 300.0_f32;
        let dt = DRAG_COALESCE_MS; // 8ms，与实际节拍一致
        let mut max_pos = 0.0_f32;
        for _ in 0..600 { // 600 × 8ms = 4.8s，远超实际拖动时长
            s = spring_step(s, target, dt);
            max_pos = max_pos.max(s.pos);
        }
        assert!((s.pos - target).abs() < DRAG_SPRING_SETTLE_PX,
            "4.8s 后应收敛到目标：pos={} target={}", s.pos, target);
        assert!(max_pos <= target + 1e-3,
            "临界阻尼**不得过冲**：最大 pos={} 超过 target={}", max_pos, target);
    }

    /// M4-2：**单调不回头**。临界阻尼的速度必须全程同号（不回负）——
    /// 一旦回负就说明有振荡，即参数错了。这条比「峰值不超过」更强：它抓的是
    /// 「速度变号」这个振荡的**根因特征**。
    #[test]
    fn spring_never_reverses_direction() {
        let mut s = DragSpring { pos: 0.0, vel: 0.0 };
        let mut last_vel_sign = 0_i32;
        for i in 0..300 {
            s = spring_step(s, 200.0, DRAG_COALESCE_MS);
            let sign = if s.vel > 1e-4 { 1 } else if s.vel < -1e-4 { -1 } else { 0 };
            if sign != 0 && last_vel_sign != 0 {
                assert_eq!(sign, last_vel_sign,
                    "第 {} 拍速度变号（{} → {}）⇒ 出现振荡，临界阻尼不该发生", i, last_vel_sign, sign);
            }
            if sign != 0 { last_vel_sign = sign; }
        }
    }

    /// M4-3：到位判定在**收敛后**必须为真（否则 `IDT_DRAG` 永不停止 = 桌宠永久微抖）。
    #[test]
    fn spring_at_target_becomes_true_after_convergence() {
        let mut s = DragSpring { pos: 0.0, vel: 0.0 };
        let target = 150.0_f32;
        let mut settled_at = None;
        for i in 0..600 {
            s = spring_step(s, target, DRAG_COALESCE_MS);
            if spring_at_target(s, target) { settled_at = Some(i); break; }
        }
        assert!(settled_at.is_some(), "弹簧必须最终判定到位（否则定时器停不下来）");
        // 反之：起点就等于目标、速度为 0 ⇒ 立刻到位
        let at_rest = DragSpring { pos: 10.0, vel: 0.0 };
        assert!(spring_at_target(at_rest, 10.0), "静止且已在目标上 ⇒ 立即到位");
        // 位置到了但速度很大 ⇒ **不算**到位（还会过冲）
        let fast = DragSpring { pos: 10.0, vel: 50.0 };
        assert!(!spring_at_target(fast, 10.0), "速度高时不得判到位（否则会在目标附近抖动）");
    }

    /// M4-4：`dt` 的两个边界都必须安全。
    ///
    /// `dt` 来自 `Instant::elapsed()` 的真实值，被 clamp 到 `[1,100]`。
    /// 这条钉住 clamp 真的生效，两个边界的**表现完全不同**：
    /// · **dt 过大** ⇒ 单次积分步长超过 `2/ω` ⇒ 半隐式欧拉**发散**（实测几步即 NaN）。
    ///   必须**多步**才看得出来（单步可能还有限）—— 初版只调一次 ⇒ 负向验证时
    ///   「去掉 clamp」竟然全绿，是**测试自身写坏**的实例。
    /// · **dt = 0 被夹到 1ms**（不是「不动」！）⇒ 表现为「每拍仍有极小位移」。
    ///   这正是 clamp 的**目的**：`elapsed()` 取整到 ms 时可能给 0，若原样传入
    ///   弹簧就完全不动（拖动看起来卡住）。故此处断言的是「**夹到下限后仍在推进**」，
    ///   而不是「位置不变」—— 初版后者是错的（clamp 后 0 变 1ms，位置会动）。
    #[test]
    fn spring_step_is_safe_at_dt_extremes() {
        let start = DragSpring { pos: 0.0, vel: 0.0 };
        // ① dt = 0 → 被夹到 1ms：不得产生非有限值，且**仍在缓慢推进**（不能卡住）
        let mut s0 = start;
        for _ in 0..10 {
            s0 = spring_step(s0, 100.0, 0);
        }
        assert!(s0.pos.is_finite() && s0.vel.is_finite(), "dt=0 产生了非有限值：{s0:?}");
        assert!(s0.pos > 0.0,
            "dt=0 被夹到下限 1ms 后仍应推进（实得 pos={}）—— 若为 0 说明拖动会卡住", s0.pos);
        assert!(s0.pos < 10.0,
            "1ms/拍 × 10 拍的位移应很小（实得 {}），过大说明下限取得不对", s0.pos);

        // ② dt 极大：**多步**积分后仍须有限（clamp 到 100ms 时不会发散）
        let mut s_big = start;
        for _ in 0..20 {
            s_big = spring_step(s_big, 100.0, 100_000);
        }
        assert!(
            s_big.pos.is_finite() && s_big.vel.is_finite(),
            "超大 dt 产生了非有限值（发散）：{s_big:?} —— clamp 失效或步长过大"
        );
    }

    /// M4-5：**刚度与节拍必须匹配**（数值稳定性）。
    ///
    /// 半隐式欧拉在 `ω·dt` 接近或超过 1 时会发散。这条用实际参数验证 `ω·dt ≈ 0.12`
    /// —— 即**余量充足**；若有人把 `DRAG_SPRING_K` 调大两个数量级，这条会先红。
    #[test]
    fn spring_stiffness_is_stable_at_current_tick_rate() {
        let omega = DRAG_SPRING_K.sqrt();
        let dt = DRAG_COALESCE_MS as f32 / 1000.0;
        let wdt = omega * dt;
        assert!(wdt < 0.5,
            "ω·dt = {wdt:.3}（k={}, dt={}ms）逼近 1 ⇒ 半隐式欧拉会发散", DRAG_SPRING_K, DRAG_COALESCE_MS);
        // 并实测 10 秒内不发散
        let mut s = DragSpring { pos: 0.0, vel: 0.0 };
        for _ in 0..1250 {
            s = spring_step(s, 500.0, DRAG_COALESCE_MS);
        }
        assert!(s.pos.is_finite() && s.pos > 400.0,
            "10s 后应接近目标且不发散，实得 pos={}", s.pos);
    }

    /// M4·反例：把刚度调成欠阻尼（去掉 `2√k` 阻尼项）时**必须出现过冲**。
    ///
    /// 这条是「为什么选临界阻尼」的**可执行证据**，防止日后有人把阻尼项删掉
    /// 追求「更跟手」——那样观感是抽搐而不是跟手。
    #[test]
    fn underdamped_variant_would_overshoot() {
        // 对照组：同样的 k，但没有阻尼项 ⇒ 等价于无阻尼简谐振荡
        let k = DRAG_SPRING_K;
        let mut pos = 0.0_f32;
        let mut vel = 0.0_f32;
        let dt = DRAG_COALESCE_MS as f32 / 1000.0;
        let target = 300.0_f32;
        let mut max_pos = 0.0_f32;
        for _ in 0..600 {
            let accel = k * (target - pos);
            vel += accel * dt;
            pos += vel * dt;
            max_pos = max_pos.max(pos);
        }
        assert!(max_pos > target + 1.0,
            "对照组失效：无阻尼弹簧应明显过冲（实测最大 {max_pos} / 目标 {target}）");
    }
}
