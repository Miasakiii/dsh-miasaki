//! 隐藏态「主题头像悬浮球」（2026-09-24）
//!
//! 取代 v1 的硬编码紫色实心圆（`0xB36AD9` / `DOT_SIZE = 30`）：球面 = **当前主题头像**
//! （`ui/icons/theme-*.png` 三张徽章，编译期内嵌，与设置面板主题选择器同一素材），
//! 外加**主题色环 + 外发光 + 球面高光 + 底部落影**，光标悬停时整体放大并增强光晕。
//!
//! 纪律（与桌宠合成一致）：
//! - 纯 CPU 逐像素合成，**不碰任何 GDI 绘图/字体 API**（运行期字体 API 在多线程下会崩，
//!   见 `config.rs` 气泡帧注释）；
//! - 全程预乘 alpha（`0xAARRGGBB`），与 `UpdateLayeredWindow(ULW_ALPHA)` 直接对接；
//! - **兜底不退化**：主题未知 → 按 pure 配色；头像素材缺失/解码失败 → 只画主题色球体
//!   （宁可少画头像，也绝不留空白、更不回退成紫点）；
//! - 渲染结果即命中依据：调用方把返回缓冲留作 hover / 鼠标穿透判定（与 R2 主窗
//!   「查最终合成缓冲」同一范式），无需另建 mask。

use super::config::*;
use super::image::Image;

/// 主题配色：`accent` = 环色（描边）、`glow` = 外发光、`base` = 球面底色（头像透明处透出）。
pub(crate) struct Palette {
    pub(crate) accent: (u8, u8, u8),
    pub(crate) glow: (u8, u8, u8),
    pub(crate) base: (u8, u8, u8),
}

/// 主题 → 头像素材键（`Frames.avatars`）。
///
/// 三张徽章由 `scripts/make-icons.mjs` 生成，素材名与主题名并非一一对应：
/// **kurkuriel（反转）用的是 `theme-inverse.png`**——与 `main.rs::pet_mode_for` 的
/// `kurkuriel → inverse` 同一命名口径，改素材名时两处必须同改。
pub(crate) fn avatar_key(theme: &str) -> &'static str {
    match theme {
        "zafkiel" => "zafkiel",
        "kurkuriel" => "inverse",
        _ => "pure",
    }
}

/// 主题 → 悬浮球配色。取值与 `make-icons.mjs` 的徽章环同源（银环 / 鎏金环 / 破血红环）。
pub(crate) fn palette(theme: &str) -> Palette {
    match theme {
        "zafkiel" => Palette {
            accent: (0xD9, 0xB3, 0x6A), // 鎏金（徽章金环）
            glow: (0xD9, 0xB3, 0x6A),
            base: (0x22, 0x1A, 0x1C), // 暗红底（红黑主题，防头像边缘透明露白）
        },
        "kurkuriel" => Palette {
            accent: (0xC2, 0x3A, 0x2E), // 提亮血红（徽章为 9E1B1B，作发光过暗）
            glow: (0xC2, 0x3A, 0x2E),
            base: (0x1E, 0x16, 0x18),
        },
        // pure（含未知主题兜底）：中性银（发光偏亮，浅色桌面上才不会读成「灰雾」）
        _ => Palette {
            accent: (0xA6, 0xA0, 0xB2),
            glow: (0xA9, 0xA2, 0xBA),
            base: (0x1A, 0x18, 0x22),
        },
    }
}

/// 预乘打包：入参为**非预乘**通道 + alpha（0..255 浮点），返回 `0xAARRGGBB`。
#[inline]
fn premul(r: f32, g: f32, b: f32, a: f32) -> u32 {
    let a = a.clamp(0.0, 255.0);
    let ai = a.round() as u32;
    if ai == 0 {
        return 0;
    }
    let ch = |v: f32| (((v.clamp(0.0, 255.0) * a) + 127.0) / 255.0).floor().clamp(0.0, 255.0) as u32;
    (ai << 24) | (ch(r) << 16) | (ch(g) << 8) | ch(b)
}

/// 直接打包**已预乘**的通道值（用于对既有预乘样本整体缩放 alpha 的场景）。
#[inline]
fn pack_premul(r: f32, g: f32, b: f32, a: f32) -> u32 {
    let ch = |v: f32| v.clamp(0.0, 255.0).round() as u32;
    (a.clamp(0.0, 255.0).round() as u32) << 24 | (ch(r) << 16) | (ch(g) << 8) | ch(b)
}

/// 预乘空间 source-over（`src` 盖在 `dst` 上）。与 `window.rs::blit_img` 同算术。
#[inline]
fn over(dst: u32, src: u32) -> u32 {
    let sa = (src >> 24) & 0xFF;
    if sa == 0 {
        return dst;
    }
    if sa == 255 {
        return src;
    }
    let inv = 255 - sa;
    let ch = |shift: u32| -> u32 {
        (((src >> shift) & 0xFF) + (((dst >> shift) & 0xFF) * inv + 127) / 255).min(255)
    };
    let a = (sa + ((dst >> 24) & 0xFF) * inv / 255).min(255);
    (a << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/// 圆盘覆盖率（1px 抗锯齿）：`d` 为到圆心距离，`r` 为半径。
#[inline]
fn cover(d: f32, r: f32) -> f32 {
    (r - d + 0.5).clamp(0.0, 1.0)
}

/// 圆环覆盖率：外圆覆盖减内圆覆盖，两侧边缘各自抗锯齿。
#[inline]
fn ring_cover(d: f32, r_in: f32, r_out: f32) -> f32 {
    (cover(d, r_out) - cover(d, r_in)).clamp(0.0, 1.0)
}

/// 二次衰减：`r_in` 处为 1，`r_out` 处为 0（用于发光/落影）。
#[inline]
fn falloff(d: f32, r_in: f32, r_out: f32) -> f32 {
    let span = (r_out - r_in).max(1e-3);
    let t = ((d - r_in) / span).clamp(0.0, 1.0);
    (1.0 - t) * (1.0 - t)
}

/// 双线性采样（归一化坐标，预乘空间插值；边界 clamp）。
fn sample(img: &Image, u: f32, v: f32) -> u32 {
    let w = img.w as i32;
    let h = img.h as i32;
    if w <= 0 || h <= 0 {
        return 0;
    }
    let sxf = (u * w as f32 - 0.5).max(0.0);
    let syf = (v * h as f32 - 0.5).max(0.0);
    let sx0 = sxf.floor() as i32;
    let sy0 = syf.floor() as i32;
    let fx = sxf - sx0 as f32;
    let fy = syf - sy0 as f32;
    let cx0 = sx0.clamp(0, w - 1) as usize;
    let cy0 = sy0.clamp(0, h - 1) as usize;
    let cx1 = (sx0 + 1).clamp(0, w - 1) as usize;
    let cy1 = (sy0 + 1).clamp(0, h - 1) as usize;
    let p00 = img.bgra[cy0 * img.w + cx0];
    let p10 = img.bgra[cy0 * img.w + cx1];
    let p01 = img.bgra[cy1 * img.w + cx0];
    let p11 = img.bgra[cy1 * img.w + cx1];
    let (ifx, ify) = (1.0 - fx, 1.0 - fy);
    let (w00, w10, w01, w11) = (ifx * ify, fx * ify, ifx * fy, fx * fy);
    let ch = |shift: u32| -> f32 {
        ((p00 >> shift) & 0xFF) as f32 * w00
            + ((p10 >> shift) & 0xFF) as f32 * w10
            + ((p01 >> shift) & 0xFF) as f32 * w01
            + ((p11 >> shift) & 0xFF) as f32 * w11
    };
    pack_premul(ch(16), ch(8), ch(0), ch(24))
}

/// 渲染悬浮球到 `DOT_SIZE × DOT_SIZE` 预乘缓冲（行主序，窗口左上角为原点）。
///
/// 图层自下而上：外发光 → 底部落影 → 球面（底色 + 主题头像）→ 主题色环 → 球面高光。
/// `hover = true` 时整体按 `DOT_HOVER_SCALE` 放大、发光与高光乘 `DOT_HOVER_BOOST`。
pub(crate) fn render(theme: &str, avatar: Option<&Image>, hover: bool) -> Vec<u32> {
    let size = DOT_SIZE;
    let pal = palette(theme);
    let s = if hover { DOT_HOVER_SCALE } else { 1.0 };
    let boost = if hover { DOT_HOVER_BOOST } else { 1.0 };
    let r_face = DOT_FACE_R * s;
    let r_ring = r_face + DOT_RING_W * s;
    let r_glow = r_ring + DOT_GLOW_SPAN * s;
    let c = size as f32 / 2.0;
    let accent = (pal.accent.0 as f32, pal.accent.1 as f32, pal.accent.2 as f32);
    let glow = (pal.glow.0 as f32, pal.glow.1 as f32, pal.glow.2 as f32);
    let base = (pal.base.0 as f32, pal.base.1 as f32, pal.base.2 as f32);
    let mut buf = vec![0u32; (size * size) as usize];

    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 + 0.5 - c;
            let dy = y as f32 + 0.5 - c;
            let d = (dx * dx + dy * dy).sqrt();
            let mut px = 0u32;

            // ① 外发光（主题色）：紧贴环外沿最强，向外二次衰减
            let ga = (falloff(d, r_ring, r_glow) * DOT_GLOW_ALPHA * boost).min(255.0);
            if ga > 0.5 {
                px = over(px, premul(glow.0, glow.1, glow.2, ga));
            }

            // ② 底部落影：压暗球体下方的发光，读作「浮起来」而不是「贴在屏上」。
            // 只在球体下半个环带加权（上半为 0）——否则球顶也会蒙灰，发光变脏雾。
            let sdy = dy - DOT_SHADOW_DY * s;
            let sd = (dx * dx + sdy * sdy).sqrt();
            let lower = ((dy + 0.15 * r_ring) / r_ring).clamp(0.0, 1.0);
            let sh = falloff(sd, r_ring, r_glow) * DOT_SHADOW_ALPHA * lower;
            if sh > 0.5 {
                px = over(px, premul(0.0, 0.0, 0.0, sh));
            }

            // ③ 球面：底色圆盘 + 主题头像（圆形裁剪 + 边缘抗锯齿）
            let fc = cover(d, r_face);
            if fc > 0.0 {
                px = over(px, premul(base.0, base.1, base.2, 255.0 * fc));
                if let Some(img) = avatar {
                    // 放大 `DOT_AVATAR_ZOOM`：素材自带环落到球缘外被裁，球面内只剩头像本体
                    let r_src = r_face * DOT_AVATAR_ZOOM;
                    let u = (dx / r_src + 1.0) * 0.5;
                    let v = (dy / r_src + 1.0) * 0.5;
                    let sp = sample(img, u, v);
                    let sa = ((sp >> 24) & 0xFF) as f32;
                    if sa > 0.0 {
                        // 预乘样本整体乘 fc = 「alpha 乘 fc、颜色按比例同缩放」，
                        // 保持预乘不变量（无须反预乘），球缘即得到抗锯齿过渡。
                        let ch = |shift: u32| (((sp >> shift) & 0xFF) as f32) * fc;
                        px = over(px, pack_premul(ch(16), ch(8), ch(0), sa * fc));
                    }
                }
            }

            // ④ 主题色环：紧贴球缘的 2px 描边
            let rc = ring_cover(d, r_face, r_ring);
            if rc > 0.0 {
                px = over(px, premul(accent.0, accent.1, accent.2, rc * 255.0));
            }

            // ⑤ 球面高光：左上 45° 方向的柔和亮斑（玻璃球质感），仅球内可见
            let hx = dx + 0.34 * r_face;
            let hy = dy + 0.36 * r_face;
            let hd = (hx * hx + hy * hy).sqrt();
            let t = (1.0 - hd / (DOT_SPEC_R * r_face)).clamp(0.0, 1.0);
            let hi = (t * t * DOT_SPEC_ALPHA * boost * fc).min(255.0);
            if hi > 0.5 {
                px = over(px, premul(255.0, 252.0, 255.0, hi));
            }

            buf[(y * size + x) as usize] = px;
        }
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    fn avatar_stub() -> Image {
        // 48×48 纯红圆（预乘）：模拟圆形徽章素材
        let n = 48usize;
        let r = n as f32 / 2.0;
        let mut bgra = vec![0u32; n * n];
        for y in 0..n {
            for x in 0..n {
                let dx = x as f32 + 0.5 - r;
                let dy = y as f32 + 0.5 - r;
                if (dx * dx + dy * dy).sqrt() <= r {
                    bgra[y * n + x] = (255 << 24) | (220 << 16);
                }
            }
        }
        Image { w: n, h: n, bgra }
    }

    fn at(buf: &[u32], x: i32, y: i32) -> u32 {
        buf[(y * DOT_SIZE + x) as usize]
    }

    fn alpha(px: u32) -> u32 {
        (px >> 24) & 0xFF
    }

    #[test]
    fn avatar_key_maps_kurkuriel_to_inverse_badge() {
        assert_eq!(avatar_key("pure"), "pure");
        assert_eq!(avatar_key("zafkiel"), "zafkiel");
        // 反转主题的素材名是 theme-inverse.png —— 与 pet_mode_for 同口径
        assert_eq!(avatar_key("kurkuriel"), "inverse");
        // 未知主题兜底 → pure（绝不渲染空白球）
        assert_eq!(avatar_key("nope"), "pure");
        assert_eq!(avatar_key(""), "pure");
    }

    #[test]
    fn palette_differs_per_theme_and_falls_back() {
        let pure = palette("pure");
        let zaf = palette("zafkiel");
        let inv = palette("kurkuriel");
        assert_ne!(pure.accent, zaf.accent);
        assert_ne!(zaf.accent, inv.accent);
        assert_eq!(palette("nope").accent, pure.accent);
        // 金环（狂三）与血红环（反转）—— 与 make-icons.mjs 的徽章环同源
        assert_eq!(zaf.accent, (0xD9, 0xB3, 0x6A));
        assert_eq!(inv.accent, (0xC2, 0x3A, 0x2E));
    }

    #[test]
    fn sphere_is_opaque_in_center_and_empty_in_corners() {
        let buf = render("zafkiel", Some(&avatar_stub()), false);
        assert_eq!(buf.len(), (DOT_SIZE * DOT_SIZE) as usize);
        let c = DOT_SIZE / 2;
        assert_eq!(alpha(at(&buf, c, c)), 255, "球心必须不透明");
        // 四角：球+发光都够不到 → 全透明（否则方形窗口会挡住下层点击）
        for (x, y) in [(0, 0), (DOT_SIZE - 1, 0), (0, DOT_SIZE - 1), (DOT_SIZE - 1, DOT_SIZE - 1)] {
            assert_eq!(alpha(at(&buf, x, y)), 0, "四角 ({x},{y}) 应为全透明");
        }
    }

    #[test]
    fn avatar_missing_falls_back_to_solid_sphere() {
        let buf = render("pure", None, false);
        let c = DOT_SIZE / 2;
        assert_eq!(alpha(at(&buf, c, c)), 255, "素材缺失也要有实心球兜底");
    }

    #[test]
    fn ring_uses_theme_accent_color() {
        let gold = render("zafkiel", Some(&avatar_stub()), false);
        let blood = render("kurkuriel", Some(&avatar_stub()), false);
        let c = DOT_SIZE as f32 / 2.0;
        // 环带采样点：半径 = DOT_FACE_R + DOT_RING_W/2，取正右方像素
        let rx = (c + DOT_FACE_R + DOT_RING_W / 2.0).floor() as i32;
        let ry = DOT_SIZE / 2;
        let g = at(&gold, rx, ry);
        let b = at(&blood, rx, ry);
        assert!(alpha(g) > 200 && alpha(b) > 200, "环带应基本不透明");
        assert_ne!((g >> 16) & 0xFF, (b >> 16) & 0xFF, "两主题环色必须不同");
        let (gr, gg, gb) = ((g >> 16) & 0xFF, (g >> 8) & 0xFF, g & 0xFF);
        let (br, bg, bb) = ((b >> 16) & 0xFF, (b >> 8) & 0xFF, b & 0xFF);
        assert!(gr > gg && gg > gb, "鎏金环应为暖金（R>G>B），实测 {gr},{gg},{gb}");
        assert!(br > bg && br > bb, "血红环应以红为主，实测 {br},{bg},{bb}");
    }

    #[test]
    fn hover_grows_the_ball() {
        let idle = render("pure", Some(&avatar_stub()), false);
        let hover = render("pure", Some(&avatar_stub()), true);
        let row = DOT_SIZE / 2;
        // 中轴行上「实心」区（球面 + 环）的最右边界必须外扩
        let extent = |buf: &[u32]| -> i32 {
            (0..DOT_SIZE).rev().find(|&x| alpha(at(buf, x, row)) >= 250).unwrap_or(-1)
        };
        assert!(
            extent(&hover) > extent(&idle),
            "悬停应放大球体：idle={} hover={}",
            extent(&idle),
            extent(&hover)
        );
        // 常态为发光（半透明）、悬停已进入环带的半径上，不透明度必须升高
        let c = DOT_SIZE as f32 / 2.0;
        let probe = (c + DOT_FACE_R + DOT_RING_W + 1.5).floor() as i32;
        assert!(
            alpha(at(&hover, probe, row)) > alpha(at(&idle, probe, row)),
            "悬停时环外探测点应更实（发光→环）"
        );
    }

    #[test]
    fn edges_are_antialiased_not_hard_cut() {
        let buf = render("pure", Some(&avatar_stub()), false);
        let row = DOT_SIZE / 2;
        let mut partial = 0;
        for x in 0..DOT_SIZE {
            let a = alpha(at(&buf, x, row));
            if a > 0 && a < 255 {
                partial += 1;
            }
        }
        assert!(partial >= 4, "球缘/发光应存在半透明过渡像素，实测 {partial} 个");
        // 不变量：常态与悬停下的发光外沿都必须落在窗口内，否则球被方窗硬裁出直边
        let r_glow = DOT_FACE_R + DOT_RING_W + DOT_GLOW_SPAN;
        let half = DOT_SIZE as f32 / 2.0;
        assert!(r_glow <= half, "常态发光半径 {r_glow} 超出窗口半径 {half}");
        assert!(
            r_glow * DOT_HOVER_SCALE <= half,
            "悬停放大后发光半径 {} 超出窗口半径 {half}（放大倍率或窗口尺寸需重算）",
            r_glow * DOT_HOVER_SCALE
        );
    }
}
