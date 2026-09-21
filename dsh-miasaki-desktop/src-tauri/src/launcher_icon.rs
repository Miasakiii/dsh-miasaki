//! 软件头像 → 启动器图标（appearance 线的桌面消费端）。
//!
//! 外观线（`@miasaki/dsh-appearance`，见 `dsh-miasaki-appearance/lib/avatar.js`）把用户选的
//! 图片归一化成 PNG 落在 `<dshHome>/miasaki-appearance/avatars/`，并在
//! `<dshHome>/miasaki-appearance/config.json` 的 `avatar.source` 里记下文件名。
//! 本模块读同一份配置，把图片应用到**主窗口图标**与**托盘图标** —— Windows 的任务栏、
//! 窗口左上角、托盘随之更新，无需重建 EXE。
//!
//! ## 跨线契约（改一处必须同时改 lib/avatar.js）
//!
//! | 项 | 值 |
//! |---|---|
//! | 配置路径 | `<dshHome>/miasaki-appearance/config.json` |
//! | 字段 | 顶层 `avatar.source`（字符串） |
//! | 取值 | 空串 = 不设置；否则 `/appearance/avatar/<文件名>` |
//! | 文件名 | `^[\w][\w.-]{0,80}\.png$`（大小写不敏感），且不含路径分隔符 |
//! | 图片目录 | `<dshHome>/miasaki-appearance/avatars/` |
//!
//! ## 边界
//!
//! * **只读本地文件，绝不联网** —— source 不是本线头像路由的路径就整条作废。
//! * **任何异常都回退出厂图标**：配置缺失/损坏、文件不存在、PNG 解码失败都只写一行日志，
//!   绝不让「一个坏头像」拖住启动或崩掉桌面端。
//! * EXE 文件自身与桌面/开始菜单快捷方式的静态图标是**构建期资源**（`make-icons.mjs` +
//!   `npx tauri icon`），运行时改不了；本模块改的是运行中的窗口与托盘图标。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use tauri::image::Image;
use tauri::{AppHandle, Manager};

/// 配置相对 dshHome 的路径（与 cordis.patch.yml 的 `dataDir` 对齐）。
const CONFIG_REL: &str = "miasaki-appearance/config.json";
/// 头像目录相对 dshHome 的路径。
const AVATAR_DIR_REL: &str = "miasaki-appearance/avatars";
/// 头像 URL 前缀（跨线契约，对应 lib/avatar.js 的 AVATAR_URL_PREFIX）。
const AVATAR_URL_PREFIX: &str = "/appearance/avatar/";
/// 头像边长上限：Windows 图标最大按 256px 取，再大只是白费 CPU 与内存。
const MAX_EDGE: u32 = 256;
/// 巡检间隔：与既有的 pulse / hash 巡检同一量级，改完头像 1–2 秒内跟随。
const POLL_INTERVAL: Duration = Duration::from_millis(1500);
/// 「当前用的是出厂图标」的哨兵键（避免每轮都把默认图标重设一遍）。
const DEFAULT_KEY: &str = "(default)";
/// 最近一次已应用的键：`<文件名>|<mtime_ms>|<len>` 或哨兵；None = 尚未应用过。
static LAST_APPLIED: Mutex<Option<String>> = Mutex::new(None);

/* ---------------- dshHome 解析 ---------------- */

/// 解析 dshHome，口径与官方 `@deepseek-ai/dsh-home-paths` 一致：
/// 非空白 `$DSH_HOME` 优先，否则 `~/.dsh`。
/// @returns Some(绝对路径)；两个来源都拿不到时 None。
pub fn dsh_home() -> Option<PathBuf> {
    if let Some(raw) = std::env::var_os("DSH_HOME") {
        let text = raw.to_string_lossy().trim().to_string();
        if !text.is_empty() {
            return Some(PathBuf::from(text));
        }
    }
    for key in ["USERPROFILE", "HOME"] {
        if let Some(home) = std::env::var_os(key) {
            let text = home.to_string_lossy().trim().to_string();
            if !text.is_empty() {
                return Some(PathBuf::from(text).join(".dsh"));
            }
        }
    }
    None
}

/* ---------------- 契约解析（纯逻辑，可单测） ---------------- */

/// 百分号解码（等价 `decodeURIComponent` 的 ASCII 子集）。
/// @returns Some(解码结果)；`%` 后不足两位或不是十六进制时 None。
fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 文件名白名单：等价 JS 侧 `/^[\w][\w.-]{0,80}\.png$/i`。
fn valid_avatar_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.len() < 5 || bytes.len() > 85 {
        // 最短 `a.png`（5）；最长 = 首字符 + 80 + ".png"
        return false;
    }
    if !(bytes[0].is_ascii_alphanumeric() || bytes[0] == b'_') {
        return false;
    }
    if !name.to_ascii_lowercase().ends_with(".png") {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'.' || *b == b'-')
}

/// 从 `avatar.source` 解析出文件名；不是本线头像路由的路径一律 None。
///
/// 这是跨线契约的另一半（JS 侧 `avatarFileFromSource`）：两端都必须只认
/// `/appearance/avatar/<白名单文件名>`，任何外链在这里就出局 —— 桌面端永远不联网取图。
/// @param source - 配置里的图源字符串。
/// @returns Some(文件名) 或 None。
pub fn avatar_file_from_source(source: &str) -> Option<String> {
    let rest = source.strip_prefix(AVATAR_URL_PREFIX)?;
    if rest.is_empty() || rest.contains('/') || rest.contains('\\') {
        return None;
    }
    let decoded = percent_decode(rest)?;
    if !valid_avatar_name(&decoded) {
        return None;
    }
    Some(decoded)
}

/// 读配置里的头像文件名。
/// @param config - config.json 的绝对路径。
/// @returns Some(文件名)；文件缺失/损坏/未设置一律 None（= 用出厂图标）。
pub fn read_avatar_file_name(config: &Path) -> Option<String> {
    let text = fs::read_to_string(config).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let source = value.get("avatar")?.get("source")?.as_str()?;
    avatar_file_from_source(source)
}

/* ---------------- PNG → 方形 RGBA ---------------- */

/// 把 PNG 字节解码成**方形** RGBA（中心裁方；超过 MAX_EDGE 时盒式降采样）。
///
/// 图标必须是方的：任务栏/托盘会按正方形渲染，非方图会被拉伸变形。
/// 用户头像多为任意长宽比，因此这里统一走「中心裁方」而不是拉伸。
/// @param bytes - PNG 文件字节。
/// @returns Ok((rgba, side)) 或 Err(原因)，调用方只记日志。
pub fn square_rgba(bytes: &[u8]) -> Result<(Vec<u8>, u32), String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    // EXPAND：调色板/tRNS 展开成真彩；STRIP_16：16 位深降到 8 位。
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| format!("PNG 头解析失败: {e}"))?;
    let mut buffer = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buffer).map_err(|e| format!("PNG 解码失败: {e}"))?;
    let (width, height) = (info.width, info.height);
    if width == 0 || height == 0 {
        return Err("PNG 尺寸为 0".into());
    }
    let rgba = to_rgba8(&buffer, info.color_type, width, height)?;
    let side = width.min(height);
    let ox = (width - side) / 2;
    let oy = (height - side) / 2;
    let cropped = crop_square(&rgba, width, side, ox, oy);
    if side <= MAX_EDGE {
        return Ok((cropped, side));
    }
    Ok((downsample_box(&cropped, side, MAX_EDGE), MAX_EDGE))
}

/// 把任意色彩类型的 8 位样本铺成 RGBA8。
fn to_rgba8(samples: &[u8], color: png::ColorType, width: u32, height: u32) -> Result<Vec<u8>, String> {
    let pixels = (width as usize) * (height as usize);
    let mut out = Vec::with_capacity(pixels * 4);
    match color {
        png::ColorType::Rgba => {
            if samples.len() < pixels * 4 {
                return Err("RGBA 样本不足".into());
            }
            out.extend_from_slice(&samples[..pixels * 4]);
        }
        png::ColorType::Rgb => {
            if samples.len() < pixels * 3 {
                return Err("RGB 样本不足".into());
            }
            for px in samples[..pixels * 3].chunks_exact(3) {
                out.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
        }
        png::ColorType::Grayscale => {
            if samples.len() < pixels {
                return Err("灰度样本不足".into());
            }
            for v in &samples[..pixels] {
                out.extend_from_slice(&[*v, *v, *v, 255]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            if samples.len() < pixels * 2 {
                return Err("灰度+alpha 样本不足".into());
            }
            for px in samples[..pixels * 2].chunks_exact(2) {
                out.extend_from_slice(&[px[0], px[0], px[0], px[1]]);
            }
        }
        // EXPAND 之后调色板已被展开；真出现说明变换没生效，明确报错而不是猜。
        png::ColorType::Indexed => return Err("调色板 PNG 未被展开".into()),
    }
    Ok(out)
}

/// 从 (width × side) 的画布里按偏移裁出 side × side 的方块。
fn crop_square(rgba: &[u8], width: u32, side: u32, ox: u32, oy: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((side as usize) * (side as usize) * 4);
    for y in 0..side {
        let row_start = (((oy + y) * width + ox) * 4) as usize;
        out.extend_from_slice(&rgba[row_start..row_start + (side as usize) * 4]);
    }
    out
}

/// 盒式平均降采样（面积平均，比最近邻少锯齿；头像尺寸小，开销可忽略）。
fn downsample_box(src: &[u8], side: u32, target: u32) -> Vec<u8> {
    let mut out = vec![0u8; (target as usize) * (target as usize) * 4];
    for ty in 0..target {
        let y0 = ((ty as u64) * (side as u64) / (target as u64)) as u32;
        let y1 = (((ty + 1) as u64) * (side as u64) / (target as u64)).max(y0 as u64 + 1) as u32;
        for tx in 0..target {
            let x0 = ((tx as u64) * (side as u64) / (target as u64)) as u32;
            let x1 = (((tx + 1) as u64) * (side as u64) / (target as u64)).max(x0 as u64 + 1) as u32;
            let (mut r, mut g, mut b, mut a, mut n) = (0u64, 0u64, 0u64, 0u64, 0u64);
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (((y * side) + x) * 4) as usize;
                    r += src[i] as u64;
                    g += src[i + 1] as u64;
                    b += src[i + 2] as u64;
                    a += src[i + 3] as u64;
                    n += 1;
                }
            }
            let o = (((ty * target) + tx) * 4) as usize;
            out[o] = (r / n) as u8;
            out[o + 1] = (g / n) as u8;
            out[o + 2] = (b / n) as u8;
            out[o + 3] = (a / n) as u8;
        }
    }
    out
}

/* ---------------- 应用到窗口与托盘 ---------------- */

/// 把一张图标同时设到主窗口与托盘（任务栏图标跟窗口图标走）。
fn set_icons(app: &AppHandle, image: Image<'_>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_icon(image.clone());
    }
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_icon(Some(image));
    }
}

/// 回退出厂图标（配置清空 / 文件坏掉时）。已处于出厂态则不重复设置。
fn apply_default(app: &AppHandle) -> bool {
    if LAST_APPLIED.lock().map(|v| v.as_deref() == Some(DEFAULT_KEY)).unwrap_or(false) {
        return false;
    }
    let Some(icon) = app.default_window_icon().cloned() else {
        return false;
    };
    set_icons(app, icon);
    if let Ok(mut slot) = LAST_APPLIED.lock() {
        *slot = Some(DEFAULT_KEY.to_string());
    }
    false
}

/// 应用一次头像配置。
///
/// 幂等：稳态下每轮只有一次配置读取；图片键（文件名 + mtime + 大小）没变就直接返回。
/// @param app - 应用句柄。
/// @returns 是否**正在使用**自定义头像（false = 出厂图标）。
pub fn apply(app: &AppHandle) -> bool {
    let Some(home) = dsh_home() else {
        return apply_default(app);
    };
    let Some(name) = read_avatar_file_name(&home.join(CONFIG_REL)) else {
        return apply_default(app);
    };
    let path = home.join(AVATAR_DIR_REL).join(&name);
    let Ok(meta) = fs::metadata(&path) else {
        // 配置指了文件但文件不在：回退出厂图标，并留下一行可诊断的日志。
        if LAST_APPLIED.lock().map(|v| v.as_deref() != Some(DEFAULT_KEY)).unwrap_or(true) {
            crate::app_log_line(&format!(
                "[{}] launcher-icon: 头像文件缺失 {} → 回退出厂图标\n",
                crate::chrono_now(),
                path.display()
            ));
        }
        return apply_default(app);
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let key = format!("{name}|{mtime}|{}", meta.len());
    if LAST_APPLIED.lock().map(|v| v.as_deref() == Some(key.as_str())).unwrap_or(false) {
        return true;
    }
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(error) => {
            crate::app_log_line(&format!(
                "[{}] launcher-icon: 读取失败 {} ({error}) → 保持原图标\n",
                crate::chrono_now(),
                path.display()
            ));
            return false;
        }
    };
    match square_rgba(&bytes) {
        Ok((rgba, side)) => {
            set_icons(app, Image::new_owned(rgba, side, side));
            if let Ok(mut slot) = LAST_APPLIED.lock() {
                *slot = Some(key);
            }
            true
        }
        Err(reason) => {
            crate::app_log_line(&format!(
                "[{}] launcher-icon: 解码失败 {} ({reason}) → 回退出厂图标\n",
                crate::chrono_now(),
                path.display()
            ));
            apply_default(app)
        }
    }
}

/// 起一个巡检任务：配置或头像文件变化后自动跟随。
///
/// 为什么用轮询而不是让页面发 hash 命令：外观配置是**文件**，用户既可能在设置面板里改，
/// 也可能直接换掉 `avatars/` 里的文件；轮询对两条路径一视同仁，且页面没开着也照样生效。
/// 稳态开销 = 每 1.5 秒一次小 JSON 读取。
pub fn spawn_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let _ = apply(&app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_accepts_only_this_line_avatar_route() {
        assert_eq!(
            avatar_file_from_source("/appearance/avatar/avatar-lz3k9q-4f2a1b.png").as_deref(),
            Some("avatar-lz3k9q-4f2a1b.png")
        );
        assert_eq!(
            avatar_file_from_source("/appearance/avatar/My_Avatar-2.PNG").as_deref(),
            Some("My_Avatar-2.PNG"),
            "扩展名大小写不敏感"
        );
        // 外链 / 其它路由 / 空 / 穿越 / 非 PNG：一律出局（桌面端永不联网取图）
        for bad in [
            "https://example.com/a.png",
            "/appearance/wallpaper/local/a.png",
            "/appearance/avatars/a.png",
            "",
            "/appearance/avatar/",
            "/appearance/avatar/../config.json",
            "/appearance/avatar/sub/a.png",
            "/appearance/avatar/a.jpg",
            "/appearance/avatar/.hidden.png",
        ] {
            assert_eq!(avatar_file_from_source(bad), None, "{bad} 必须被拒");
        }
    }

    #[test]
    fn source_decodes_percent_escapes_before_whitelisting() {
        assert_eq!(avatar_file_from_source("/appearance/avatar/avatar%2D1.png").as_deref(), Some("avatar-1.png"));
        // 编码后的穿越（%2e%2e%2f）解码后含 `/`，必须被白名单拦下
        assert_eq!(avatar_file_from_source("/appearance/avatar/%2e%2e%2fconfig.json"), None);
        assert_eq!(avatar_file_from_source("/appearance/avatar/a%2Fb.png"), None);
        // 坏转义不 panic，直接拒
        assert_eq!(avatar_file_from_source("/appearance/avatar/a%2.png"), None);
        assert_eq!(avatar_file_from_source("/appearance/avatar/a%zz.png"), None);
    }

    #[test]
    fn name_whitelist_matches_js_side() {
        assert!(valid_avatar_name("a.png"));
        assert!(valid_avatar_name("avatar-lz3k9q-4f2a1b.png"));
        assert!(valid_avatar_name("a.PNG"), "扩展名大小写不敏感");
        assert!(!valid_avatar_name(".png"), "首字符必须是 \\w");
        assert!(!valid_avatar_name("a b.png"));
        assert!(!valid_avatar_name("a/b.png"));
        assert!(!valid_avatar_name("a.jpg"));
        assert!(!valid_avatar_name(&format!("{}.png", "x".repeat(90))));
    }

    /// 用 png crate 现编一张图（宽 × 高，纯色 + 指定 alpha），供解码路径用。
    fn encode_png(width: u32, height: u32) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().expect("write header");
            let mut data = Vec::with_capacity((width * height * 4) as usize);
            for y in 0..height {
                for x in 0..width {
                    // 左红右蓝，便于断言裁剪取的是中间
                    let r = if x < width / 2 { 255 } else { 0 };
                    let b = if x < width / 2 { 0 } else { 255 };
                    data.extend_from_slice(&[r, 0, b, 200u8.wrapping_add(y as u8)]);
                }
            }
            writer.write_image_data(&data).expect("write data");
        }
        out
    }

    #[test]
    fn square_rgba_crops_center_and_keeps_alpha() {
        // 4×2 → 裁成 2×2（横向居中：取 x=1,2 两列）
        let png = encode_png(4, 2);
        let (rgba, side) = square_rgba(&png).expect("解码成功");
        assert_eq!(side, 2);
        assert_eq!(rgba.len(), 2 * 2 * 4);
        // x=1 属左半（红），x=2 属右半（蓝）
        assert_eq!(&rgba[0..4], &[255, 0, 0, 200]);
        assert_eq!(&rgba[4..8], &[0, 0, 255, 200]);
        assert_eq!(&rgba[8..12], &[255, 0, 0, 201]);
        assert_eq!(&rgba[12..16], &[0, 0, 255, 201]);
    }

    #[test]
    fn square_rgba_downscales_above_max_edge_and_stays_square() {
        let big = MAX_EDGE + 8;
        let png = encode_png(big, big);
        let (rgba, side) = square_rgba(&png).expect("解码成功");
        assert_eq!(side, MAX_EDGE, "超过上限必须降到 MAX_EDGE");
        assert_eq!(rgba.len(), (MAX_EDGE * MAX_EDGE * 4) as usize);
        // 降采样后左右两半仍是红/蓝（不是全黑或越界）
        assert!(rgba[0] > 200, "左上应仍是红");
        assert!(rgba[rgba.len() - 4 + 2] > 200, "右下应仍是蓝");
    }

    #[test]
    fn square_rgba_rejects_non_png_without_panicking() {
        assert!(square_rgba(b"not a png at all").is_err());
        assert!(square_rgba(&[]).is_err());
        // 截断的 PNG：头部可读、数据不全 → 报错而不是 panic
        let png = encode_png(8, 8);
        assert!(square_rgba(&png[..png.len() / 2]).is_err());
    }
}
