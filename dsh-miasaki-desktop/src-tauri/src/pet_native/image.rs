//! 帧图：PNG 预乘加载 + Frames 素材集（D2 拆分）
use std::collections::HashMap;
use super::config::*;
/* ---------------- 帧图 ---------------- */

pub(crate) struct Image {
    pub(crate) w: usize,
    pub(crate) h: usize,
    pub(crate) bgra: Vec<u32>, // 预乘 alpha，0xAARRGGBB
}

impl Clone for Image {
    fn clone(&self) -> Self {
        Image { w: self.w, h: self.h, bgra: self.bgra.clone() }
    }
}

pub(crate) fn load_png(bytes: &[u8]) -> Option<Image> {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    if info.color_type != png::ColorType::Rgba {
        return None;
    }
    let w = info.width as usize;
    let h = info.height as usize;
    let mut bgra = vec![0u32; w * h];
    for i in 0..w * h {
        let r = buf[i * 4] as u32;
        let g = buf[i * 4 + 1] as u32;
        let b = buf[i * 4 + 2] as u32;
        let a = buf[i * 4 + 3] as u32;
        // 运行时兜底:a<8 视为全透(防 desync 素材被拉满)
        if a < 8 {
            bgra[i] = 0;
            continue;
        }
        // 预乘四舍五入(消除 ≤1 级整数截断偏暗)
        bgra[i] = (a << 24)
            | (((r * a + 127) / 255) << 16)
            | (((g * a + 127) / 255) << 8)
            | ((b * a + 127) / 255);
    }
    Some(Image { w, h, bgra })
}

#[derive(Default)]
pub(crate) struct Frames {
    pub(crate) kurumi: HashMap<String, Vec<Image>>,
    /// v5 L0-3（design/pet-v5-motion-plan.md）：whale 的**图集行**——此前 whale 只有三态立绘，
    /// 其 1536×2288 的 11 行图集零使用（"atlas 分支缺失，不是素材缺失"）。本次接入 r0–r6 共 7 行。
    /// 与 `kurumi` 同为「行名 → 帧组」，走同一条行选择/回退链（`atlas_row`）。
    pub(crate) whale_rows: HashMap<String, Vec<Image>>,
    // v2:三态值统一为帧组(单帧=长度1);idle 可为帧序列(whale idle.gif 拆分)
    pub(crate) whale_states: HashMap<String, Vec<Image>>,
    pub(crate) inverse_states: HashMap<String, Vec<Image>>,
    pub(crate) bubbles: Vec<Image>,
    /// R5(2026-09-16):审批气泡（240x84，含「拒绝 / 允许一次」两个按钮）。
    /// 独立于 22 帧精灵表（帧高不同），由 `scripts/gen-bubbles.ps1` 一并生成。
    pub(crate) approval: Option<Image>,
    /// 2026-09-24:隐藏态悬浮球的球面素材——主题头像徽章（96×96，键见 `dot::avatar_key`）。
    /// 与设置面板主题选择器同一批图（`scripts/make-icons.mjs` 产出，编译期内嵌）。
    pub(crate) avatars: HashMap<String, Image>,
}

impl Frames {
    /// D2 fallback 链（pet-v2-roadmap §D）：请求行 → idle → wave → jump → run →
    /// 首个可用非空行（字典序最小，保证确定性）；全缺/全空 → None（调用方跳过绘制）。
    /// 空帧组视为缺失（素材切帧探测到 0 非空帧时 load_frames 可能存入空 Vec）。
    ///
    /// v5：抽为关联函数——kurumi 与 whale 两份行集共用同一条链
    /// （行名空间是 Rust 侧的，各主题的行帧素材分别映射进来，见 model.rs 与 cut-frames.mjs）。
    pub(crate) fn atlas_row<'a>(
        map: &'a HashMap<String, Vec<Image>>,
        row: &str,
    ) -> Option<(&'a Vec<Image>, String)> {
        if let Some(l) = map.get(row) {
            if !l.is_empty() {
                return Some((l, row.to_string()));
            }
        }
        for fb in ["idle", "wave", "jump", "run"] {
            if fb == row {
                continue;
            }
            if let Some(l) = map.get(fb) {
                if !l.is_empty() {
                    return Some((l, fb.to_string()));
                }
            }
        }
        let mut names: Vec<&String> = map.iter().filter(|(_, l)| !l.is_empty()).map(|(k, _)| k).collect();
        names.sort();
        names.first().map(|k| (map.get(*k).unwrap(), (*k).clone()))
    }

    /// v5 L0-3：该主题**是否具备散步行**（决定 `compose` 是否触发 wander）。
    ///
    /// 此前散步硬编码为「kurumi 专属」（`mode == "kurumi"`）——因为只有她的图集有 `runRight`/`runLeft`。
    /// whale 图集接入后它同样具备两行，散步对它才第一次可触发；
    /// inverse 无图集 ⇒ 恒 false（不产生"走了但没行走帧、只能播 idle 平移"的假位移）。
    pub(crate) fn can_wander(&self, mode: &str) -> bool {
        let map = match mode {
            "kurumi" => &self.kurumi,
            "whale" => &self.whale_rows,
            _ => return false,
        };
        let has = |row: &str| map.get(row).map(|l| !l.is_empty()).unwrap_or(false);
        has("runRight") && has("runLeft")
    }

    /// A 批：该主题**当前生效行集**（= 已烘焙进来的形象）里是否有这一行且非空。
    /// ambient 选行的可用性过滤用（P1-a 空转槽纪律的推广：形象缺的行不上场）。
    /// 无图集的主题（inverse）恒 false——它的 ambient 本就不被立绘分支消费。
    pub(crate) fn rows_have(&self, mode: &str, row: &str) -> bool {
        let map = match mode {
            "whale" => &self.whale_rows,
            "kurumi" => &self.kurumi,
            _ => return false,
        };
        map.get(row).map(|l| !l.is_empty()).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one() -> Vec<Image> {
        vec![Image { w: 1, h: 1, bgra: vec![0] }]
    }

    #[test]
    fn fallback_chain() {
        let mut f = Frames::default();
        assert!(Frames::atlas_row(&f.kurumi, "idle").is_none());
        f.kurumi.insert("run".to_string(), one());
        // 请求缺失行 → chain 末端首个可用
        assert_eq!(Frames::atlas_row(&f.kurumi, "idle").unwrap().1, "run");
        assert_eq!(Frames::atlas_row(&f.kurumi, "wait").unwrap().1, "run");
        // 空 idle 视为缺失，继续回退
        f.kurumi.insert("idle".to_string(), Vec::new());
        assert_eq!(Frames::atlas_row(&f.kurumi, "idle").unwrap().1, "run");
        // idle 恢复后优先命中；直接命中的行返回自身
        f.kurumi.insert("idle".to_string(), one());
        assert_eq!(Frames::atlas_row(&f.kurumi, "idle").unwrap().1, "idle");
        f.kurumi.insert("jump".to_string(), one());
        assert_eq!(Frames::atlas_row(&f.kurumi, "jump").unwrap().1, "jump");
    }

    /// v5 L0-3:whale 行集与 kurumi 共用同一条回退链。whale 图集**没有** `review` 行
    /// （其 r8 实为站姿待机，语义核验见 pet-v5-motion-plan.md §2.3.2）⇒ Done 庆祝按链落到
    /// **idle**（链序 idle → wave → jump → run，idle 先命中）。这是**已知且可接受的差异**：
    /// Done 的可见信号主要由 10s 完成气泡承担，庆祝表达留给 L1 的挤压脉冲（零素材）。
    /// 本测试钉住的是「不得落成空白、不得跨主题串味」，不是"庆祝要有专属帧"。
    #[test]
    fn whale_row_shares_fallback_chain() {
        let mut f = Frames::default();
        assert!(Frames::atlas_row(&f.whale_rows, "any").is_none(), "空行集不得 panic、不得伪造行");
        f.whale_rows.insert("idle".to_string(), one());
        f.whale_rows.insert("wave".to_string(), one());
        assert_eq!(Frames::atlas_row(&f.whale_rows, "idle").unwrap().1, "idle");
        // 链序：idle 优先于 wave
        assert_eq!(Frames::atlas_row(&f.whale_rows, "review").unwrap().1, "idle");
        // 两套行集互不串味：kurumi 补上 review 后，whale 侧仍回退 idle
        f.kurumi.insert("review".to_string(), one());
        assert_eq!(Frames::atlas_row(&f.whale_rows, "review").unwrap().1, "idle");
        assert_eq!(Frames::atlas_row(&f.kurumi, "review").unwrap().1, "review");
    }

    /// v5 L0-3:散步准入由「kurumi 专属」放宽为「该主题具备行走帧」——
    /// whale 图集接入后散步对它才第一次可触发；缺任一行或换来的主题恒 false
    /// （否则会"平移但只能播 idle"，表现为滑步假位移）。
    #[test]
    fn wander_admission_follows_available_rows() {
        let mut f = Frames::default();
        assert!(!f.can_wander("kurumi"), "两行都缺 ⇒ 不散步");
        assert!(!f.can_wander("whale"), "图集未接入 ⇒ 不散步");
        assert!(!f.can_wander("inverse"), "无图集主题恒不散步");
        assert!(!f.can_wander("unknown"), "未知主题不得散步");
        f.kurumi.insert("runRight".to_string(), one());
        assert!(!f.can_wander("kurumi"), "只有一行 ⇒ 仍不散步（另一方向会滑步）");
        f.kurumi.insert("runLeft".to_string(), one());
        assert!(f.can_wander("kurumi"));
        // 两主题各自独立判定：kurumi 具备不使 whale 具备
        assert!(!f.can_wander("whale"));
        f.whale_rows.insert("runRight".to_string(), one());
        f.whale_rows.insert("runLeft".to_string(), one());
        assert!(f.can_wander("whale"));
    }

    /// A 批：形象键解析——default/空 ⇒ "whale"（现有资产）；合法 variant ⇒ "whale.<name>"；
    /// 缺失键 / 非法字符 ⇒ 回落 "whale"（留痕在 pet_log_line，这里只判键本身）。
    #[test]
    fn appearance_key_resolves_default_and_variant() {
        let m: serde_json::Value = serde_json::from_str(
            r#"{"whale":{"kind":"atlas"},"whale.sakura":{"kind":"atlas"}}"#,
        )
        .unwrap();
        assert_eq!(resolve_appearance_key(&m, "default"), "whale", "default = 现有资产");
        assert_eq!(resolve_appearance_key(&m, ""), "whale", "空串按 default");
        assert_eq!(resolve_appearance_key(&m, "sakura"), "whale.sakura", "合法 variant 命中");
        assert_eq!(resolve_appearance_key(&m, "missing"), "whale", "帧表没有的形象回落 default");
        assert_eq!(resolve_appearance_key(&m, "../etc"), "whale", "非法字符回落 default");
        assert_eq!(resolve_appearance_key(&m, "SAKURA"), "whale", "大写不合 charset，回落");
        assert_eq!(resolve_appearance_key(&m, "sa ku"), "whale", "空格不合 charset，回落");
    }
}

/// A 批：解析 whale 的 manifest 键（纯函数 + 留痕，单测直接喂合成 JSON）。
///
/// - `"default"` / 空串 ⇒ `"whale"`（现有资产，默认路径零变化）；
/// - 否则 `"whale.<name>"`，`name` 限 `[a-z0-9-]+`（URL/文件名安全；
///   非法字符 ⇒ 留痕回落——settings.normalize 已白名单，这里是第二道闸）；
/// - 键不在帧表 ⇒ 留痕回落（**宁可用旧形象，不空白**；但不静默——
///   pet.log 有行，排障时能看见「请求了不存在的形象」）。
fn resolve_appearance_key(manifest: &serde_json::Value, appearance: &str) -> String {
    const DEFAULT_KEY: &str = "whale";
    if appearance.is_empty() || appearance == super::settings::APPEARANCE_DEFAULT {
        return DEFAULT_KEY.to_string();
    }
    if !appearance
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        super::window::pet_log_line(&format!(
            "[native-pet] appearance {appearance} 含非法字符，回落 default\n"
        ));
        return DEFAULT_KEY.to_string();
    }
    let key = format!("whale.{appearance}");
    if manifest.get(&key).is_none() {
        super::window::pet_log_line(&format!(
            "[native-pet] appearance {appearance} 不在帧表（缺 {key} 条目），回落 default\n"
        ));
        return DEFAULT_KEY.to_string();
    }
    key
}

/// A 批（2026-10-19，design/2026-10-19-pet-a-appearance.md §3.2）：按**形象**加载。
///
/// whale 的 manifest 键 = `"whale"`（default，现有资产）或 `"whale.<appearance>"`
/// （新形象，自包含条目）；kurumi / inverse 恒 default（换装不涉及其角色设定）。
/// 形象缺失/非法 ⇒ **留痕 + 回落 default**（`resolve_appearance_key`）——
/// 宁可用旧形象，不空白；但不静默（pet.log 有行）。
/// 加载期烘焙：当前形象的行/states 装进**现有字段**（`whale_rows` / `whale_states`…），
/// 于是 compose / `can_wander` / 回退链对形象零感知（与 P2-a 配色同一条重载路径）。
pub(crate) fn load_frames_appearance(appearance: &str) -> Frames {
    // 素材经 crate::assets 读取：磁盘 ui/（EXE 旁）优先，编译期内嵌兜底 ——
    // 单文件拷贝 EXE 也能完整显示桌宠（图标/气泡/帧图集），不再强制 ui/ 外置。
    let mut f = Frames::default();
    // 预渲染气泡精灵表(帧序 = quote_pool 顺序;构建期经 gen-bubbles.ps1 生成)
    if let Some(bytes) = crate::assets::read("pets/bubbles.png") {
        if let Some(sheet) = load_png(&bytes) {
            let stride = BUBBLE_W as usize;
            let rows = BUBBLE_H as usize;
            if sheet.w >= stride * BUBBLE_COUNT && sheet.h >= rows {
                for i in 0..BUBBLE_COUNT {
                    let mut frame = Image { w: stride, h: rows, bgra: Vec::with_capacity(stride * rows) };
                    for y in 0..rows {
                        let src = y * sheet.w + i * stride;
                        frame.bgra.extend_from_slice(&sheet.bgra[src..src + stride]);
                    }
                    f.bubbles.push(frame);
                }
            }
        }
    }
    // R5:审批气泡（240x84，含「拒绝 / 允许一次」两按钮）——帧高与 22 帧精灵表不同，故独立文件。
    // 素材缺失 → Frames.approval = None → 运行时不画审批气泡（宁可不显示，也不画空按钮）。
    if let Some(bytes) = crate::assets::read("pets/approval.png") {
        f.approval = load_png(&bytes);
    }
    // 2026-09-24:隐藏态悬浮球的主题头像徽章（键与 `dot::avatar_key` 对齐；素材名 ≠ 主题名，
    // kurkuriel 用 theme-inverse.png）。缺失 → 运行期回落为主题色实心球，不影响其余功能。
    for (key, rel) in [
        ("pure", "icons/theme-pure.png"),
        ("zafkiel", "icons/theme-zafkiel.png"),
        ("inverse", "icons/theme-inverse.png"),
    ] {
        if let Some(bytes) = crate::assets::read(rel) {
            if let Some(img) = load_png(&bytes) {
                f.avatars.insert(key.to_string(), img);
            }
        }
    }
    if let Some(bytes) = crate::assets::read("pets/frames.json") {
        if let Ok(txt) = String::from_utf8(bytes) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                // A 批：whale 的 manifest 键按形象解析（default ⇒ "whale"；
                // 否则 "whale.<name>"，缺失/非法留痕回落）。行与立绘两段共用。
                let whale_key = resolve_appearance_key(&v, appearance);
                // 行帧图集(kurumi / v5:whale)——同一 schema,按主题分流到各自的行集
                for theme in ["kurumi", "whale"] {
                    let key = if theme == "whale" { whale_key.as_str() } else { theme };
                    if let Some(rows) =
                        v.get(key).and_then(|m| m.get("rows")).and_then(|r| r.as_object())
                    {
                        for (row, files) in rows {
                            let mut imgs = Vec::new();
                            if let Some(arr) = files.as_array() {
                                for name in arr {
                                    let rel = format!(
                                        "pets/{theme}/frames/{}",
                                        name.as_str().unwrap_or("")
                                    );
                                    if let Some(b) = crate::assets::read(&rel) {
                                        if let Some(img) = load_png(&b) {
                                            imgs.push(img);
                                        }
                                    }
                                }
                            }
                            if theme == "kurumi" {
                                f.kurumi.insert(row.clone(), imgs);
                            } else {
                                f.whale_rows.insert(row.clone(), imgs);
                            }
                        }
                    }
                }
                // 立绘三态(whale / inverse);v2:值可为帧组数组(idle 帧序列)或单帧字符串
                // A 批：whale 段同样按形象键取（variant 可以是纯立绘 kind——那时
                // whale_rows 为空，compose 的 whale_atlas 判据自然走立绘分支）。
                for mode in ["whale", "inverse"] {
                    let key = if mode == "whale" { whale_key.as_str() } else { mode };
                    if let Some(states) = v.get(key).and_then(|m| m.get("states")).and_then(|s| s.as_object()) {
                        for (s, name) in states {
                            let names: Vec<String> = if let Some(arr) = name.as_array() {
                                arr.iter().filter_map(|n| n.as_str().map(|x| x.to_string())).collect()
                            } else {
                                let n = name.as_str().unwrap_or("");
                                if n.is_empty() { Vec::new() } else { vec![n.to_string()] }
                            };
                            let mut imgs = Vec::new();
                            for n in &names {
                                let rel = format!("pets/{mode}/{n}");
                                if let Some(b) = crate::assets::read(&rel) {
                                    if let Some(img) = load_png(&b) {
                                        imgs.push(img);
                                    }
                                }
                            }
                            if imgs.is_empty() {
                                continue;
                            }
                            if mode == "whale" {
                                f.whale_states.insert(s.clone(), imgs);
                            } else {
                                f.inverse_states.insert(s.clone(), imgs);
                            }
                        }
                    }
                }
            }
        }
    }
    f
}

/* ---------------- P2-a：配色重着色（加载期，design/2026-10-18-pet-p2-* §1） ---------------- */

/// 单像素重着色（**纯函数**，直存 RGB、非预乘）：保亮度 hue 矩阵 + 饱和度插值。
///
/// hue 矩阵绕灰度轴旋转（内部色彩关系不变，只是整体转色相）；`sat` 向 Rec.601
/// 亮度灰插值（1.0 = 不动，0 = 全灰）。`0° + sat 1.0` 恒等——冷启动默认路径
/// 因此零失真。灰度像素（r=g=b）不受 hue 影响（矩阵对灰度轴不动）——单测锚定。
pub(crate) fn recolor_pixel(r: u8, g: u8, b: u8, hue_deg: f32, sat: f32) -> (u8, u8, u8) {
    if hue_deg == 0.0 && sat == 1.0 {
        return (r, g, b); // 恒等快路径（默认预设，零失真零开销）
    }
    if !hue_deg.is_finite() {
        return (r, g, b); // NaN 不猜
    }
    let sat = if sat.is_finite() { sat.clamp(0.0, 2.0) } else { 1.0 };
    let (rf, gf, bf) = (r as f32, g as f32, b as f32);
    // 保亮度 hue 旋转矩阵（经典 HSV 旋转公式）
    let a = hue_deg.to_radians();
    let (c, s) = (a.cos(), a.sin());
    let k = 1.0 / 3.0;
    let sq = (1.0 / 3.0_f32).sqrt();
    let m = [
        [c + k * (1.0 - c), k * (1.0 - c) - sq * s, k * (1.0 - c) + sq * s],
        [k * (1.0 - c) + sq * s, c + k * (1.0 - c), k * (1.0 - c) - sq * s],
        [k * (1.0 - c) - sq * s, k * (1.0 - c) + sq * s, c + k * (1.0 - c)],
    ];
    let hr = m[0][0] * rf + m[0][1] * gf + m[0][2] * bf;
    let hg = m[1][0] * rf + m[1][1] * gf + m[1][2] * bf;
    let hb = m[2][0] * rf + m[2][1] * gf + m[2][2] * bf;
    // 饱和度：向 Rec.601 亮度灰插值
    let luma = 0.299 * rf + 0.587 * gf + 0.114 * bf;
    let out = |v: f32| (luma + (v - luma) * sat).round().clamp(0.0, 255.0) as u8;
    (out(hr), out(hg), out(hb))
}

/// 对一张**预乘**帧图原地重着色：反预乘 → `recolor_pixel` → 预乘
/// （预乘四舍五入与 `load_png` 一致，避免重新引入 ≤1 级偏暗）。
/// a<8 的像素保持 0（与 load_png 的兜底同口径）。
pub(crate) fn recolor_image(img: &mut Image, hue_deg: f32, sat: f32) {
    for px in img.bgra.iter_mut() {
        let a = (*px >> 24) & 0xFF;
        if a < 8 {
            *px = 0;
            continue;
        }
        let pr = ((*px >> 16) & 0xFF) as u32;
        let pg = ((*px >> 8) & 0xFF) as u32;
        let pb = (*px & 0xFF) as u32;
        // 反预乘（四舍五入；a=255 时无损）
        let (r, g, b) = (
            ((pr * 255 + a / 2) / a).min(255) as u8,
            ((pg * 255 + a / 2) / a).min(255) as u8,
            ((pb * 255 + a / 2) / a).min(255) as u8,
        );
        let (nr, ng, nb) = recolor_pixel(r, g, b, hue_deg, sat);
        *px = (a << 24)
            | (((nr as u32 * a + 127) / 255) << 16)
            | (((ng as u32 * a + 127) / 255) << 8)
            | ((nb as u32 * a + 127) / 255);
    }
}

/// P2-a：按预设索引重着色一整套帧——**只动 whale**（行集 + 三态立绘）。
///
/// kurumi/inverse 不动：发色与瞳色是角色设定的一部分，hue 旋转会把狂三变成
/// 另一个人（Coopanion 的配色同样只作用于自家 mascot）。索引越界 ⇒ 不动
/// （调用方已过 `normalize()` 夹取，这里是第二道闸）。
pub(crate) fn recolor_frames(f: &mut Frames, color: u32) {
    let (hue, sat) = match COLOR_PRESETS.get(color as usize) {
        Some(&p) => p,
        None => return,
    };
    if hue == 0.0 && sat == 1.0 {
        return; // 原色：不碰任何像素（默认路径零失真）
    }
    for map in [&mut f.whale_rows, &mut f.whale_states] {
        for imgs in map.values_mut() {
            for img in imgs.iter_mut() {
                recolor_image(img, hue, sat);
            }
        }
    }
}

/// 按（配色, 形象）加载帧。冷启动（`pet_native::spawn`）与运行期改设置
/// （`window.rs` 的 `(color, appearance)` 变更检测）共用这一条路——重新走
/// `assets::read` 保证磁盘 ui/ 覆盖层语义与冷启动完全一致。
/// A 批：appearance 只影响 whale 的取键（其余主题恒 default，见加载器）。
pub(crate) fn load_frames_for(color: u32, appearance: &str) -> Frames {
    let mut f = load_frames_appearance(appearance);
    recolor_frames(&mut f, color);
    f
}

#[cfg(test)]
mod recolor_tests {
    use super::*;

    /// 与 load_png 一致的预乘构造（测试专用）。
    fn px(r: u8, g: u8, b: u8, a: u8) -> u32 {
        (a as u32) << 24
            | (((r as u32 * a as u32 + 127) / 255) << 16)
            | (((g as u32 * a as u32 + 127) / 255) << 8)
            | ((b as u32 * a as u32 + 127) / 255)
    }

    /// P2-a-1：默认预设恒等——冷启动默认路径零失真（这条是「不碰默认」的契约）。
    #[test]
    fn recolor_identity_at_default_preset() {
        assert_eq!(recolor_pixel(20, 40, 90, 0.0, 1.0), (20, 40, 90));
        assert_eq!(recolor_pixel(255, 255, 255, 0.0, 1.0), (255, 255, 255));
        assert_eq!(recolor_pixel(0, 0, 0, 0.0, 1.0), (0, 0, 0));
        // 越界索引 ⇒ 整套不动
        let mut f = Frames::default();
        f.whale_rows.insert(
            "idle".to_string(),
            vec![Image { w: 1, h: 1, bgra: vec![px(20, 40, 90, 255)] }],
        );
        recolor_frames(&mut f, 99);
        assert_eq!(f.whale_rows["idle"][0].bgra[0], px(20, 40, 90, 255));
    }

    /// P2-a-2：灰度不受 hue 影响（矩阵对灰度轴不动）——霜白预设只降饱和不偏色。
    #[test]
    fn gray_pixels_are_hue_immune() {
        for v in [0u8, 64, 128, 192, 255] {
            assert_eq!(recolor_pixel(v, v, v, 120.0, 1.0), (v, v, v), "灰 {v} 不得偏色");
        }
        // 霜白：彩色去饱和后应显著靠近其亮度灰
        let (r, g, b) = recolor_pixel(20, 40, 90, 0.0, 0.30);
        let spread = r.max(g).max(b) - r.min(g).min(b);
        assert!(spread < 40, "霜白应接近灰：({r},{g},{b}) spread={spread}");
    }

    /// P2-a-3：137° + 223° = 360° 轮回（旋转整圈回原色）+ **等权均值守恒**
    /// （经典 hue 矩阵的真实不变量：三行和均为 1 ⇒ (r+g+b)/3 精确不变）。
    ///
    /// 注意：它**不**精确保 Rec.601 亮度——对蓝色为主的鲸鱼 palette 实测漂移
    /// ≈3.5/255（1.4%，肉眼不可感），但「保 Rec.601」不是该矩阵的性质，
    /// 写成断言就是假判据（首版就这么错的，红得莫名其妙）。要 Rec.601 精确守恒
    /// 得改用绕亮度轴的旋转矩阵——那会让灰/白（女仆围裙的大面积白）着色，
    /// 灰度免疫是更重要的观感性质（见 gray_pixels_are_hue_immune）。
    #[test]
    fn hue_round_trips_and_preserves_mean() {
        for &(r, g, b) in &[(20u8, 40u8, 90u8), (200, 180, 60), (90, 200, 160), (10, 10, 10)] {
            let (r1, g1, b1) = recolor_pixel(r, g, b, 137.0, 1.0);
            let back = recolor_pixel(r1, g1, b1, 223.0, 1.0);
            let orig = (r, g, b);
            assert!((back.0 as i32 - r as i32).abs() <= 2, "轮回 x：{back:?} vs {orig:?}");
            assert!((back.1 as i32 - g as i32).abs() <= 2, "轮回 y：{back:?} vs {orig:?}");
            assert!((back.2 as i32 - b as i32).abs() <= 2, "轮回 z：{back:?} vs {orig:?}");
            // 等权均值精确守恒（取整误差 ≤1）
            let m0 = (r as f32 + g as f32 + b as f32) / 3.0;
            let (r2, g2, b2) = recolor_pixel(r, g, b, 120.0, 1.0);
            let m1 = (r2 as f32 + g2 as f32 + b2 as f32) / 3.0;
            assert!((m1 - m0).abs() <= 1.0, "均值漂移：{m0} -> {m1}");
        }
    }

    /// P2-a-4：输出恒在 0..255（u8 构造即保证，这里锚**纯函数确定性**——
    /// 同入参必须同出；视觉假定的「不越界」由类型承担，测试不写恒真断言）、
    /// NaN 入参安全（hue NaN 回原，sat NaN 按 1.0，两个都有明确归宿）。
    #[test]
    fn recolor_is_deterministic_and_nan_safe() {
        for &(r, g, b) in &[(0u8, 0u8, 0u8), (255, 255, 255), (20, 40, 90), (250, 3, 7)] {
            for hue in [0.0_f32, 47.5, 120.0, 300.0, 359.9] {
                for sat in [0.0_f32, 0.3, 1.0, 2.0] {
                    let a = recolor_pixel(r, g, b, hue, sat);
                    let again = recolor_pixel(r, g, b, hue, sat);
                    assert_eq!(a, again, "纯函数必须确定：({r},{g},{b}) hue={hue} sat={sat}");
                }
            }
        }
        assert_eq!(recolor_pixel(20, 40, 90, f32::NAN, f32::NAN), (20, 40, 90), "NaN ⇒ 原样");
    }

    /// P2-a-5：预乘往返——半透明像素重着色后 alpha 不变、不透明像素换色。
    #[test]
    fn recolor_image_handles_premultiplied_alpha() {
        let mut img = Image {
            w: 2,
            h: 1,
            bgra: vec![px(20, 40, 90, 255), px(200, 100, 50, 80)],
        };
        let before_a1 = img.bgra[1] >> 24;
        recolor_image(&mut img, 120.0, 1.0);
        assert_eq!(img.bgra[0] >> 24, 255, "alpha 不得变");
        assert_eq!(img.bgra[1] >> 24, before_a1, "半透明像素 alpha 不得变");
        assert_ne!(img.bgra[0], px(20, 40, 90, 255), "不透明像素应已换色");
        // 全透明保持 0（load_png 同口径）
        let mut t = Image { w: 1, h: 1, bgra: vec![0] };
        recolor_image(&mut t, 120.0, 1.0);
        assert_eq!(t.bgra[0], 0);
    }

    /// P2-a-6：`recolor_frames` 只动 whale——kurumi/inverse 帧逐字节不变
    /// （角色设定色不参与换色；这条是「换色不窜主题」的契约）。
    #[test]
    fn recolor_touches_whale_only() {
        let mut f = Frames::default();
        let whale_px = px(20, 40, 90, 255);
        let kurumi_px = px(200, 180, 60, 255);
        f.whale_rows.insert(
            "idle".to_string(),
            vec![Image { w: 1, h: 1, bgra: vec![whale_px] }],
        );
        f.whale_states.insert(
            "deep".to_string(),
            vec![Image { w: 1, h: 1, bgra: vec![whale_px] }],
        );
        f.kurumi.insert(
            "idle".to_string(),
            vec![Image { w: 1, h: 1, bgra: vec![kurumi_px] }],
        );
        f.inverse_states.insert(
            "idle".to_string(),
            vec![Image { w: 1, h: 1, bgra: vec![kurumi_px] }],
        );
        recolor_frames(&mut f, 1); // 樱粉
        assert_ne!(f.whale_rows["idle"][0].bgra[0], whale_px, "whale 应已换色");
        assert_ne!(f.whale_states["deep"][0].bgra[0], whale_px, "whale 立绘也应换色");
        assert_eq!(f.kurumi["idle"][0].bgra[0], kurumi_px, "kurumi 不得换色");
        assert_eq!(f.inverse_states["idle"][0].bgra[0], kurumi_px, "inverse 不得换色");
    }
}
