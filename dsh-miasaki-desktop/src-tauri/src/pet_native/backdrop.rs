//! R20-c（2026-10-17，design/2026-10-17-pet-fullscreen-sfx-sprint.md §4；**2026-10-19 重做**）：
//! 背景对比 halo —— 从「预渲染椭圆环」改为**程序化轮廓柔光**。
//!
//! 问题：桌宠身体颜色与身后桌面接近时「融进背景」（深色 whale 配深色桌面最常见）。
//! 参考实现 Coopanion 的做法（`pet-app.js:1476-1545` + `sampleBackdrop`）：采样桌面、
//! 统计与身体同色的占比、超过阈值加一圈浅灰 halo，带回差防抖。
//!
//! ## 为什么重做（2026-10-19 用户实机报「有时候会有一个白圈圈着」）
//!
//! 首版是构建期预渲染的**径向环 PNG**，blit 时拉伸到「角色包围盒 + 8px」——
//! 对非圆形轮廓（鲸鱼娘的裙摆、呆毛、双马尾）这个环与角色毫无几何关系，
//! 视觉上就是**一个套在角色外面的椭圆白圈**，不是设计想要的「反差光」。
//! 重做后：
//! ① 光晕**从本帧角色的 alpha 轮廓生成**（盒式模糊 → 只在轮廓外显形），贴合任何形状；
//! ② 颜色取**身体平均色的反差不刺眼变体**（深色身体提亮 78% / 浅色身体压暗到 25%），
//!    不再是与角色配色调无关的纯白/纯黑环（首版白环配蓝色角色，像「被圈住」）；
//! ③ 参数（模糊半径 / 强度 / gamma）集中在 `config.rs`，纯函数可单测、可实机调。
//!
//! ## 判据（沿用首版，采样与回差不动）
//!
//! **判据是「身体平均色 vs 桌面平均色」的加权距离**，带回差防抖（`HaloState::update`）——
//! 2s 采样节拍；进入用 `HALO_DIST_ON`（窄）、退出用 `HALO_DIST_OFF`（宽），
//! 距离在两阈值之间徘徊时状态不翻动（否则桌宠停在临界桌面上会 2s 一闪）。
//!
//! ## 边界
//!
//! 采样任何一步失败（DC/位图/Blt/DIBits）都返回 `None` 并**清理已建的 GDI 对象**——
//! 本仓有「GDI 对象数不增」的铁律（D3：高频 `CreateDIBSection` 曾引发崩溃）。
//! 柔光合成全程只动内存缓冲，**零新增 GDI 对象、零素材**（不再有 PNG 环）。

use super::ffi::*;
use std::os::raw::c_void;

/// Rec.601 加权 RGB 距离（0..≈255）。权重理由：人眼对绿差最敏感，
/// 等权欧氏距离会把「蓝黑 vs 黑」判得比「深绿 vs 黑」更远——与观感相反。
pub(crate) fn color_distance(a: [u8; 3], b: [u8; 3]) -> f32 {
    let dr = a[0] as f32 - b[0] as f32;
    let dg = a[1] as f32 - b[1] as f32;
    let db = a[2] as f32 - b[2] as f32;
    (0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db).sqrt()
}

/// 身体明暗（Rec.601 亮度，0..255）。< 128 算深色身体（配浅光晕）。
pub(crate) fn luminance(c: [u8; 3]) -> f32 {
    0.299 * c[0] as f32 + 0.587 * c[1] as f32 + 0.114 * c[2] as f32
}

/// 柔光颜色：按身体明暗选**反差不刺眼**的变体。
///
/// * 深色身体（whale 平均色 ≈[100,123,165]）⇒ 向白提亮 78%：得到角色自身体系的浅色
///   （≈[221,226,235]），像「角色在暗处自发微光」，而不是中性的白圈；
/// * 浅色身体（inverse 立绘）⇒ 压暗到 25%：在浅色桌面上形成一圈柔和暗边（阴影语义）。
///
/// 不用纯白/纯黑：纯色与角色的色相无关，首版实机验证正是「白环套蓝角色」最刺眼。
pub(crate) fn glow_color(body: [u8; 3]) -> [u8; 3] {
    const LIFT: f32 = 0.78;
    const DARKEN: f32 = 0.25;
    let f = |c: u8| -> u8 {
        if luminance(body) < 128.0 {
            (c as f32 + LIFT * (255.0 - c as f32)).round().clamp(0.0, 255.0) as u8
        } else {
            (c as f32 * DARKEN).round().clamp(0.0, 255.0) as u8
        }
    };
    [f(body[0]), f(body[1]), f(body[2])]
}

/// R20-c 状态：是否开光晕 + 当前柔光颜色（2s 采样节拍更新一次）。
#[derive(Clone, Copy, Debug)]
pub(crate) struct HaloState {
    pub(crate) on: bool,
    /// 柔光颜色（`glow_color` 的结果；`on == false` 时无意义）。
    pub(crate) color: [u8; 3],
}

impl HaloState {
    pub(crate) const fn off() -> Self {
        HaloState { on: false, color: [255, 255, 255] }
    }

    /// 用新的「身体/桌面」平均色更新。返回是否发生了开关切换（调用方据此决定要不要重画）。
    ///
    /// **回差（hysteresis）是防抖的全部手段**：进入用 `HALO_DIST_ON`（窄）、
    /// 退出用 `HALO_DIST_OFF`（宽）——距离在两个阈值之间徘徊时状态不翻动。
    ///
    /// 颜色**每次都按当前身体色重算**：主题切换 / 换角色 / P2 配色预设变化后
    /// 身体平均色会变，光晕色要跟上（深 whale → 浅 inverse 时从浅光翻深光）。
    pub(crate) fn update(&mut self, body: [u8; 3], backdrop: [u8; 3]) -> bool {
        let d = color_distance(body, backdrop);
        let next = if self.on {
            d <= super::config::HALO_DIST_OFF
        } else {
            d < super::config::HALO_DIST_ON
        };
        let changed = next != self.on;
        self.on = next;
        self.color = glow_color(body);
        changed
    }
}

/// R20-c：两条采样带是否都完整落在工作区内。
///
/// **为什么必须这道闸**：采样带落在屏外时 `StretchBlt` 采到的是黑屏（或上一帧残留），
/// 平均色被拉黑 ⇒ 距离判据失真（深色身体 vs 黑背景 = 永不翻动，浅色身体 = 常亮）。
/// 贴边 / 半出屏 / peek 缩边时桌宠的留白带可能出屏，此时**跳过本轮采样**
/// （保持原状），不猜。
pub(crate) fn strips_inside(strips: (Rect, Rect), work: Rect) -> bool {
    let inside = |r: Rect| {
        r.left >= work.left && r.top >= work.top && r.right <= work.right && r.bottom <= work.bottom
    };
    inside(strips.0) && inside(strips.1)
}

/// R20-c：采样一块屏幕区域的平均色（降采样到 24×24 再平均，参考实现同款量级）。
///
/// 任何一步失败（DC/位图/Blt/DIBits）都返回 `None` 并**清理已建的 GDI 对象** ——
/// 本仓有「GDI 对象数不增」的铁律（D3：高频 `CreateDIBSection` 曾引发崩溃），
/// 采样路径虽 2s 一次，泄漏仍是泄漏。
pub(crate) fn sample_avg(r: Rect) -> Option<[u8; 3]> {
    let w = r.right - r.left;
    let h = r.bottom - r.top;
    if w <= 0 || h <= 0 {
        return None;
    }
    unsafe {
        let screen = GetDC(0);
        if screen == 0 {
            return None;
        }
        let mem = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, 24, 24);
        if mem == 0 || bmp == 0 {
            if mem != 0 {
                DeleteDC(mem);
            }
            if bmp != 0 {
                DeleteObject(bmp);
            }
            ReleaseDC(0, screen);
            return None;
        }
        let old = SelectObject(mem, bmp);
        if old == 0 || old == -1 {
            // SelectObject 失败（0 = 失败、-1 = HGDI_ERROR）：清理已建对象后放弃。
            // 本仓「失败不猜」口径——采样失败只是本拍不更新判据，不画柔光比画错强。
            DeleteObject(bmp);
            DeleteDC(mem);
            ReleaseDC(0, screen);
            return None;
        }
        let ok = StretchBlt(
            mem, 0, 0, 24, 24, screen, r.left, r.top, w, h, SRCCOPY,
        );
        // **2026-10-18 审查修正（MSDN 契约）**：`GetDIBits` 要求 `hbm` **不得处于
        // 选中状态**（Remarks 原文："must not be selected into a device context"）。
        // 原实现在位图仍选入 `mem` 时取像素——违规调用可能返回 0，而本路径所有
        // 失败都静默 `None` ⇒ halo 永不出现且日志无痕（整个 R20-c 静默失效）。
        // 修法：`StretchBlt` 完成后先恢复 DC 的旧位图，再 `GetDIBits`。
        SelectObject(mem, old);
        let mut avg = None;
        if ok != 0 {
            let mut bmi = BmiHeader {
                size: 40,
                width: 24,
                height: -24,
                planes: 1,
                bit_count: 32,
                compression: 0,
                size_image: 0,
                x_ppm: 0,
                y_ppm: 0,
                clr_used: 0,
                clr_important: 0,
            };
            let mut bits = vec![0u8; 24 * 24 * 4];
            let got = GetDIBits(
                mem,
                bmp,
                0,
                24,
                bits.as_mut_ptr() as *mut c_void,
                &mut bmi,
                DIB_RGB_COLORS,
            );
            if got == 24 {
                let n = (24 * 24) as u32;
                let (mut sr, mut sg, mut sb) = (0u32, 0u32, 0u32);
                for i in 0..n as usize {
                    // 32 位 DIB 行主序，BGRA
                    sb += bits[i * 4] as u32;
                    sg += bits[i * 4 + 1] as u32;
                    sr += bits[i * 4 + 2] as u32;
                }
                avg = Some([(sr / n) as u8, (sg / n) as u8, (sb / n) as u8]);
            }
        }
        DeleteObject(bmp);
        DeleteDC(mem);
        ReleaseDC(0, screen);
        avg
    }
}

/// 单通道盒式模糊（两趟可分离：水平写 `scratch`、垂直写 `dst`）。
///
/// 这是轮廓柔光的**形状来源**：把本帧角色的 alpha 通道糊开，糊出来的差值就是
/// 「角色轮廓外面一圈的衰减场」。用盒式而不是高斯：O(n) 与半径无关（滑窗），
/// 而 33ms 的 compose 节拍里每帧都要跑一遍（静态期待机也跑——它决定那一帧画不画光）。
/// 单趟盒式的方形核在 256 级 alpha 上肉眼看不出与高斯的差别，成本却低一个量级。
///
/// 边界按 clamp 处理（窗口边缘之外视为同值）——角色永远在窗口内部，
/// 边缘 alpha 恒 0 ⇒ 不会在窗口边缘凭空糊出一圈。
pub(crate) fn blur_alpha_box(
    src: &[u8],
    scratch: &mut [u8],
    dst: &mut [u8],
    w: usize,
    h: usize,
    radius: usize,
) {
    if w == 0 || h == 0 {
        return;
    }
    let n = w * h;
    debug_assert!(src.len() >= n && scratch.len() >= n && dst.len() >= n);
    let max_r = w.max(h).saturating_sub(1);
    let r = radius.min(max_r) as isize;
    if r <= 0 {
        // 半径退化 ⇒ 原样拷贝（调用方不该传 0，但别让这里静默产出垃圾）
        scratch[..n].copy_from_slice(&src[..n]);
        dst[..n].copy_from_slice(&src[..n]);
        return;
    }
    let win = (2 * r + 1) as u32;
    let last_x = w as isize - 1;
    let last_y = h as isize - 1;
    // —— 水平 ——
    for y in 0..h {
        let row = y * w;
        let mut sum: u32 = 0;
        for k in -r..=r {
            let xx = k.clamp(0, last_x) as usize;
            sum += src[row + xx] as u32;
        }
        for x in 0..w {
            scratch[row + x] = (sum / win) as u8;
            let xo = (x as isize - r).clamp(0, last_x) as usize;
            let xn = (x as isize + r + 1).clamp(0, last_x) as usize;
            sum += src[row + xn] as u32;
            sum -= src[row + xo] as u32;
        }
    }
    // —— 垂直 ——
    for x in 0..w {
        let mut sum: u32 = 0;
        for k in -r..=r {
            let yy = k.clamp(0, last_y) as usize;
            sum += scratch[yy * w + x] as u32;
        }
        for y in 0..h {
            dst[y * w + x] = (sum / win) as u8;
            let yo = (y as isize - r).clamp(0, last_y) as usize;
            let yn = (y as isize + r + 1).clamp(0, last_y) as usize;
            sum += scratch[yn * w + x] as u32;
            sum -= scratch[yo * w + x] as u32;
        }
    }
}

/// 把模糊后的轮廓场合成为**角色下面的柔光**（就地改 `buf`，预乘 BGRA）。
///
/// 合成公式（预乘 over：光晕在下、角色在上）：
/// `out = role_over(glow)` —— 角色像素原样保留，角色外的透明区按光晕 alpha 填色，
/// 角色边缘的抗锯齿像素按 alpha 混合（不会出现一圈硬边）。
///
/// `ext = mask * (1 - a)`：只在**角色没盖住的地方**显形，所以角色内部绝不会被染色
/// （这正是不再出现「白圈套在身体上」的几何原因）。
/// `ga = strength * ext^gamma`：gamma < 1 把外缘的小值抬起来，过渡更长更柔。
pub(crate) fn composite_glow(
    buf: &mut [u32],
    mask: &[u8],
    count: usize,
    color: [u8; 3],
    strength: f32,
    gamma: f32,
) {
    let n = count.min(buf.len()).min(mask.len());
    let strength = strength.clamp(0.0, 1.0);
    let gamma = if gamma.is_finite() { gamma.clamp(0.05, 4.0) } else { 1.0 };
    for i in 0..n {
        let px = buf[i];
        let a = ((px >> 24) & 0xFF) as f32 / 255.0;
        if a >= 0.999 {
            continue; // 角色实心处：光晕完全被盖住，省掉一次 powf
        }
        let m = mask[i] as f32 / 255.0;
        let ext = (m * (1.0 - a)).clamp(0.0, 1.0);
        if ext <= 0.0 {
            continue;
        }
        let ga = (strength * ext.powf(gamma)).clamp(0.0, 1.0);
        if ga <= 0.0 {
            continue;
        }
        let inv = 1.0 - ga;
        let r = ((px >> 16) & 0xFF) as f32 * inv + color[0] as f32 * ga;
        let g = ((px >> 8) & 0xFF) as f32 * inv + color[1] as f32 * ga;
        let b = (px & 0xFF) as f32 * inv + color[2] as f32 * ga;
        let oa = (ga + a * inv).clamp(0.0, 1.0);
        buf[i] = (((oa * 255.0).round() as u32) << 24)
            | (((r.min(255.0)).round() as u32) << 16)
            | (((g.min(255.0)).round() as u32) << 8)
            | ((b.min(255.0)).round() as u32);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R20-c-1：同色 ⇒ 一定开柔光，且颜色按明暗选反差变体（深身浅光、浅身深光）。
    #[test]
    fn same_color_always_opens_with_contrast_glow() {
        let mut s = HaloState::off();
        assert!(s.update([20, 24, 40], [22, 26, 42]), "深身体贴深桌面必须开柔光");
        assert!(s.on);
        // 深色身体 ⇒ 提亮：每个通道都不低
        assert!(s.color[0] >= 180 && s.color[1] >= 180 && s.color[2] >= 180, "深身配浅光: {:?}", s.color);
        let mut s2 = HaloState::off();
        assert!(s2.update([230, 230, 235], [228, 232, 236]), "浅身体贴浅桌面必须开柔光");
        assert!(s2.on);
        for c in s2.color {
            assert!(c <= 70, "浅身配深光: {:?}", s2.color);
        }
    }

    /// R20-c-2：差距大 ⇒ 不开（身体与桌面分得开，不需要光）。
    #[test]
    fn distinct_colors_never_open() {
        let mut s = HaloState::off();
        assert!(!s.update([20, 24, 40], [200, 200, 205]), "深身浅桌不开");
        assert!(!s.on);
        // 距离略超退出阈值（60 > OFF=56）⇒ 保持关
        assert!(!s.update([60, 60, 60], [0, 0, 0]), "刚过退出阈值不得开");
        assert!(!s.on);
    }

    /// R20-c-3：**回差防抖**——距离在 ON/OFF 之间徘徊时状态不翻动（否则临界桌面 2s 一闪）。
    #[test]
    fn hysteresis_prevents_boundary_flicker() {
        let on = super::super::config::HALO_DIST_ON;
        let off = super::super::config::HALO_DIST_OFF;
        assert!(off > on, "退出阈值必须宽于进入阈值（回差的定义）");
        // 用同灰度构造精确距离：body=(d,d,d) vs backdrop=(0,0,0) ⇒ 距离 = d
        let mk = |d: u8| ([d, d, d], [0u8, 0u8, 0u8]);
        let mut s = HaloState::off();
        let (b, k) = mk((on - 1.0) as u8);
        assert!(s.update(b, k), "进入阈值内必须开");
        // 中间徘徊：不关
        let (b, k) = mk(((on + off) / 2.0) as u8);
        assert!(!s.update(b, k), "中间区不得翻动（回差起作用的唯一证据）");
        assert!(s.on, "中间区状态保持开启");
        // 超过退出阈值才关
        let (b, k) = mk((off + 4.0) as u8);
        assert!(s.update(b, k), "超过退出阈值必须关");
        assert!(!s.on);
    }

    /// R20-c-4：光晕颜色随身体明暗**重算**（主题切换后从浅光翻深光）。
    #[test]
    fn glow_color_follows_body_luminance() {
        let mut s = HaloState::off();
        s.update([20, 24, 40], [22, 26, 42]); // 深身 ⇒ 浅光
        let light = s.color;
        // 换成浅色身体（仍是「融进」的同色桌面）⇒ 光翻深
        s.update([235, 235, 238], [233, 237, 240]);
        assert!(s.on);
        assert!(luminance(s.color) < luminance(light), "浅身必须翻深光: {:?} -> {:?}", light, s.color);
    }

    /// R20-c-5：采样带出屏闸门——缺一条完整落进工作区就不采（贴边/peek 场景）。
    #[test]
    fn strips_guard_requires_both_strips_fully_inside() {
        let work = Rect { left: 0, top: 0, right: 2560, bottom: 1440 };
        let ok = (
            Rect { left: 8, top: 100, right: 56, bottom: 124 },
            Rect { left: 2504, top: 100, right: 2552, bottom: 124 },
        );
        assert!(strips_inside(ok, work));
        // 右带出屏 1px ⇒ 不采
        let out = (
            ok.0,
            Rect { left: 2504, top: 100, right: 2561, bottom: 124 },
        );
        assert!(!strips_inside(out, work));
        // 负坐标副屏
        let work2 = Rect { left: -2560, top: 0, right: 0, bottom: 1440 };
        let neg = (
            Rect { left: -2552, top: 100, right: -2504, bottom: 124 },
            Rect { left: -56, top: 100, right: -8, bottom: 124 },
        );
        assert!(strips_inside(neg, work2));
    }

    /// R20-c-6：退化矩形 ⇒ 采样直接 None（不碰 GDI）。
    #[test]
    fn sample_rejects_degenerate_rect() {
        assert!(sample_avg(Rect { left: 10, top: 10, right: 10, bottom: 40 }).is_none());
        assert!(sample_avg(Rect { left: 10, top: 10, right: 40, bottom: 10 }).is_none());
    }

    /// R20-c-7：盒式模糊把单个亮点摊开到半径 2 的范围，且总能量守恒（平均值不变）。
    ///
    /// 注意断言口径：两趟盒式（可分离）后**峰值处仍是局部最大**（只是被拉低到 255/25
    /// 量级），所以不能断言「原像素变 0」——首版就这么写错，被真跑当场抓出。
    #[test]
    fn blur_spreads_single_peak_and_keeps_mean() {
        let (w, h, r) = (9usize, 7usize, 2usize);
        let mut src = vec![0u8; w * h];
        src[3 * w + 4] = 255; // 中心偏左一点
        let mut scratch = vec![0u8; w * h];
        let mut dst = vec![0u8; w * h];
        blur_alpha_box(&src, &mut scratch, &mut dst, w, h, r);
        let peak = dst[3 * w + 4];
        assert!(peak > 0, "峰值处必须仍有残留（摊开不是抹掉）");
        assert!(peak < 255, "峰值必须被摊薄（得到 {peak}）");
        assert!(dst[3 * w + 2] > 0, "半径内的邻居必须有值（水平扩散）");
        assert!(dst[1 * w + 4] > 0, "半径内的邻居必须有值（垂直扩散）");
        assert_eq!(dst[0], 0, "远离峰值处为零");
        let mean_in: f64 = src.iter().map(|v| *v as f64).sum::<f64>() / (w * h) as f64;
        let mean_out: f64 = dst.iter().map(|v| *v as f64).sum::<f64>() / (w * h) as f64;
        assert!((mean_in - mean_out).abs() <= 1.0, "模糊不该改变平均亮度: {mean_in} vs {mean_out}");
    }

    /// R20-c-8：合成只在**角色透明处**显形——角色内部一个像素都不许变。
    #[test]
    fn composite_never_tints_opaque_body() {
        // 3×1：左透明、中半透明、右完全不透明
        let mut buf = vec![0u32, (128u32 << 24) | (10u32 << 16) | (10u32 << 8) | 10u32,
                          (255u32 << 24) | (50u32 << 16) | (60u32 << 8) | 70u32];
        let opaque_before = buf[2];
        let mask = vec![255u8, 255u8, 255u8];
        composite_glow(&mut buf, &mask, 3, [200, 210, 240], 0.95, 0.85);
        assert_eq!(buf[2], opaque_before, "不透明角色像素必须原样保留");
        assert_ne!(buf[0], 0, "透明处必须被柔光填上");
        assert!((buf[0] >> 24) & 0xFF > 0);
    }

    /// R20-c-9：没有轮廓（mask 全 0）⇒ 一个像素都不改（不凭空画圈）。
    #[test]
    fn composite_noop_on_empty_mask() {
        let mut buf = vec![0u32; 16];
        let mask = vec![0u8; 16];
        composite_glow(&mut buf, &mask, 16, [255, 255, 255], 0.95, 0.85);
        assert!(buf.iter().all(|p| *p == 0), "空轮廓不得产生任何柔光");
    }

    /// R20-c-10：轮廓场越强的地方柔光越亮（单调性——不然「贴轮廓」就不成立）。
    #[test]
    fn composite_brightness_follows_mask() {
        let mut a = vec![0u32];
        let mut b = vec![0u32];
        composite_glow(&mut a, &[64u8], 1, [255, 255, 255], 0.95, 1.0);
        composite_glow(&mut b, &[192u8], 1, [255, 255, 255], 0.95, 1.0);
        assert!((b[0] >> 24) & 0xFF > (a[0] >> 24) & 0xFF, "mask 更亮处柔光必须更强");
    }
}
