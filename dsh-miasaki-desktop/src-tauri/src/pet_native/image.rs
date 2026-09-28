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
}

pub(crate) fn load_frames() -> Frames {
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
                // 行帧图集(kurumi / v5:whale)——同一 schema,按主题分流到各自的行集
                for theme in ["kurumi", "whale"] {
                    if let Some(rows) =
                        v.get(theme).and_then(|m| m.get("rows")).and_then(|r| r.as_object())
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
                for mode in ["whale", "inverse"] {
                    if let Some(states) = v.get(mode).and_then(|m| m.get("states")).and_then(|s| s.as_object()) {
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
