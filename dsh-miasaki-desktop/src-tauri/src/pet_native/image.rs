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
    // v2:三态值统一为帧组(单帧=长度1);idle 可为帧序列(whale idle.gif 拆分)
    pub(crate) whale_states: HashMap<String, Vec<Image>>,
    pub(crate) inverse_states: HashMap<String, Vec<Image>>,
    pub(crate) bubbles: Vec<Image>,
}

impl Frames {
    /// D2 fallback 链（pet-v2-roadmap §D）：请求行 → idle → wave → jump → run →
    /// 首个可用非空行（字典序最小，保证确定性）；全缺/全空 → None（调用方跳过绘制）。
    /// 空帧组视为缺失（素材切帧探测到 0 非空帧时 load_frames 可能存入空 Vec）。
    pub(crate) fn kurumi_row(&self, row: &str) -> Option<(&Vec<Image>, String)> {
        if let Some(l) = self.kurumi.get(row) {
            if !l.is_empty() {
                return Some((l, row.to_string()));
            }
        }
        for fb in ["idle", "wave", "jump", "run"] {
            if fb == row {
                continue;
            }
            if let Some(l) = self.kurumi.get(fb) {
                if !l.is_empty() {
                    return Some((l, fb.to_string()));
                }
            }
        }
        let mut names: Vec<&String> =
            self.kurumi.iter().filter(|(_, l)| !l.is_empty()).map(|(k, _)| k).collect();
        names.sort();
        names.first().map(|k| (self.kurumi.get(*k).unwrap(), (*k).clone()))
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
        assert!(f.kurumi_row("idle").is_none());
        f.kurumi.insert("run".to_string(), one());
        // 请求缺失行 → chain 末端首个可用
        assert_eq!(f.kurumi_row("idle").unwrap().1, "run");
        assert_eq!(f.kurumi_row("wait").unwrap().1, "run");
        // 空 idle 视为缺失，继续回退
        f.kurumi.insert("idle".to_string(), Vec::new());
        assert_eq!(f.kurumi_row("idle").unwrap().1, "run");
        // idle 恢复后优先命中；直接命中的行返回自身
        f.kurumi.insert("idle".to_string(), one());
        assert_eq!(f.kurumi_row("idle").unwrap().1, "idle");
        f.kurumi.insert("jump".to_string(), one());
        assert_eq!(f.kurumi_row("jump").unwrap().1, "jump");
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
    if let Some(bytes) = crate::assets::read("pets/frames.json") {
        if let Ok(txt) = String::from_utf8(bytes) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                // 行帧图集(kurumi)
                if let Some(rows) = v.get("kurumi").and_then(|m| m.get("rows")).and_then(|r| r.as_object()) {
                    for (row, files) in rows {
                        let mut imgs = Vec::new();
                        if let Some(arr) = files.as_array() {
                            for name in arr {
                                let rel = format!("pets/kurumi/frames/{}", name.as_str().unwrap_or(""));
                                if let Some(b) = crate::assets::read(&rel) {
                                    if let Some(img) = load_png(&b) {
                                        imgs.push(img);
                                    }
                                }
                            }
                        }
                        f.kurumi.insert(row.clone(), imgs);
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
