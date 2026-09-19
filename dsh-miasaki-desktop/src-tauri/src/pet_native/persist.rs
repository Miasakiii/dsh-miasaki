//! pet.json 持久化：v2（角色中心比例 + 屏幕几何身份 + 绝对坐标兜底）+ 原子写 + 角色可见性校验
//!
//! R3（2026-09-16，design/pet-reference-benchmark.md R3）两处改造：
//! ① **位置改为比例化持久化**：存「角色可见区域中心相对**所在显示器工作区**的比例」（rx/ry）
//!    + 该工作区的几何（作为屏幕身份）+ 绝对坐标兜底。分辨率/缩放变化后位置仍成立；
//!    工作区几何完全一致才用比例还原，否则退回绝对坐标校验。
//! ② **可见性判据改为「角色可见区域 ∩ 工作区」的面积占比**（不再用窗口中心点）——
//!    这是 M4.1（peek 缩边）的前置：peek 时窗口中心会落在屏外，旧判据会误判「不可见」
//!    并把桌宠拉回默认位置（即「桌宠丢了」回归）。参考实现同款结论见
//!    `pet/window_placement.py:183-200`（以角色 alpha 轮廓而非透明画布为可见性口径）。
use super::config::*;
use super::ffi::*;
use super::window::pet_log_line;

/* ---------------- pet.json v2 ---------------- */

/// v1 旧结构：仅用于读取迁移（新写入一律 v2）。
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetStateV1 {
    pub(crate) version: u32,
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) hide: bool,
}

/// 显示器工作区几何（作为「屏幕身份」：与当前枚举到的某块工作区**完全一致**才算同一块屏）。
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkRect {
    pub(crate) left: i32,
    pub(crate) top: i32,
    pub(crate) right: i32,
    pub(crate) bottom: i32,
}

impl WorkRect {
    fn of(r: &Rect) -> Self {
        WorkRect { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    }
    fn width(&self) -> i32 {
        self.right - self.left
    }
    fn height(&self) -> i32 {
        self.bottom - self.top
    }
}

/// v2 结构：比例（主）+ 绝对坐标（兜底）+ 屏幕几何身份。
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetStateV2 {
    pub(crate) version: u32,
    /// 角色可见区域中心相对所在工作区的比例（0..1）
    pub(crate) rx: f64,
    pub(crate) ry: f64,
    /// 绝对坐标兜底（工作区几何不匹配时使用）
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) hide: bool,
    pub(crate) work: WorkRect,
}

pub(crate) enum LoadedPetState {
    V1(PetStateV1),
    V2(PetStateV2),
}

pub(crate) fn pet_state_path() -> std::path::PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("com.miasaki.desktop").join("pet.json")
}

/// 读取 pet.json；损坏/版本不符 → None（调用方回默认，不猜、不静默零值）。
/// 先按 `version` 字段分流，再逐版本反序列化（v1 可无缝读取并迁移）。
pub(crate) fn load_pet_state() -> Option<LoadedPetState> {
    let txt = std::fs::read_to_string(pet_state_path()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&txt).ok()?;
    match v.get("version").and_then(|x| x.as_u64()) {
        Some(1) => serde_json::from_value::<PetStateV1>(v).ok().map(LoadedPetState::V1),
        Some(2) => serde_json::from_value::<PetStateV2>(v).ok().map(LoadedPetState::V2),
        _ => None,
    }
}

/// 仅取隐藏状态（启动早期使用；位置的恢复在 `initial_pet_state` 内完成）。
pub(crate) fn load_hide() -> bool {
    match load_pet_state() {
        Some(LoadedPetState::V1(s)) => s.hide,
        Some(LoadedPetState::V2(s)) => s.hide,
        None => false,
    }
}

fn save_pet_state(s: &PetStateV2) {
    let p = pet_state_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // 原子写：temp + rename，任何时刻不存在半写文件（与 bootstrap.json 同一铁律）
    let tmp = p.with_extension("tmp");
    if let Ok(text) = serde_json::to_string(s) {
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}

pub(crate) fn default_pos() -> (i32, i32) {
    (1200, 500)
}

/// R3：**角色可见区域**（窗口局部坐标）——与 `blit_center_bottom` 的几何一致：
/// 高 = `CELL_H`、底部对齐（y0 = WIN_H - CELL_H - 2）、水平取整窗宽（保守，含帧内透明边）。
/// 它排除了窗口上方的气泡带与左右留白，是「桌宠实际占用的可见范围」。
pub(crate) fn character_local_rect() -> Rect {
    Rect { left: 0, top: WIN_H - CELL_H as i32 - 2, right: WIN_W, bottom: WIN_H }
}

/// 两个矩形的相交面积（无交集 → 0）。
fn overlap_area(a: &Rect, b: &Rect) -> i64 {
    let l = a.left.max(b.left);
    let t = a.top.max(b.top);
    let r = a.right.min(b.right);
    let btm = a.bottom.min(b.bottom);
    if r <= l || btm <= t {
        0
    } else {
        (r - l) as i64 * (btm - t) as i64
    }
}

/// 枚举全部显示器的「工作区」（work rect，含任务栏偏移）。
pub(crate) fn monitor_workspaces() -> Vec<Rect> {
    let mut out: Vec<Rect> = Vec::new();
    unsafe extern "system" fn cb(
        mon: isize,
        _hdc: isize,
        _rect: *mut Rect,
        data: isize,
    ) -> i32 {
        if data != 0 {
            let v = &mut *(data as *mut Vec<Rect>);
            let mut info = MonitorInfo {
                cb_size: std::mem::size_of::<MonitorInfo>() as u32,
                rc_monitor: Rect { left: 0, top: 0, right: 0, bottom: 0 },
                rc_work: Rect { left: 0, top: 0, right: 0, bottom: 0 },
                dw_flags: 0,
            };
            if unsafe { GetMonitorInfoW(mon, &mut info) } != 0 {
                v.push(info.rc_work);
            }
        }
        1 // 继续枚举
    }
    unsafe {
        EnumDisplayMonitors(0, std::ptr::null(), cb, &mut out as *mut Vec<Rect> as isize);
    }
    out
}

/// 角色可见区域的全局矩形。
fn character_global_rect(pos: (i32, i32)) -> Rect {
    let c = character_local_rect();
    Rect {
        left: pos.0 + c.left,
        top: pos.1 + c.top,
        right: pos.0 + c.right,
        bottom: pos.1 + c.bottom,
    }
}

/// R3：位置可见性——以**角色可见区域**与工作区的相交面积占角色区域的比例判定
/// （阈值 `VISIBLE_MIN_PCT`）。半出屏/贴边/未来的 peek 缩边都会保留；
/// 完全出屏（拔掉副屏、显示器布局变化遗留坐标）才判不可见 → 回默认位置。
pub(crate) fn pos_visible(pos: (i32, i32)) -> bool {
    let ch = character_global_rect(pos);
    let area = ((ch.right - ch.left) as i64) * ((ch.bottom - ch.top) as i64);
    if area <= 0 {
        return false;
    }
    let need = area * VISIBLE_MIN_PCT / 100;
    let ws = monitor_workspaces();
    if ws.is_empty() {
        // 枚举失败兜底：主屏尺寸（单屏环境）
        let (sw, sh) = screen_size();
        let screen = Rect { left: 0, top: 0, right: sw, bottom: sh };
        return overlap_area(&ch, &screen) >= need;
    }
    ws.iter().any(|m| overlap_area(&ch, m) >= need)
}

/// 角色可见区域中心所在的工作区（找不到 → None，调用方兜底主屏）。
fn containing_work(cx: i32, cy: i32) -> Option<WorkRect> {
    monitor_workspaces()
        .into_iter()
        .find(|r| cx >= r.left && cx < r.right && cy >= r.top && cy < r.bottom)
        .map(|r| WorkRect::of(&r))
}

/// 初始状态（位置 + 是否隐藏）：
/// - v2 且工作区几何匹配 → 按比例还原（分辨率/缩放变化安全），clamp 回工作区内
/// - v2 但工作区已变 → 绝对坐标 + 角色可见性校验
/// - v1 → 绝对坐标 + 角色可见性校验（读旧文件后下次保存即升级为 v2）
/// - 位置不可见（屏外遗留坐标）→ 回默认位置，保留隐藏设置
/// - 损坏/版本不符 → 全部默认并重建
pub(crate) fn initial_pet_state() -> (i32, i32, bool) {
    match load_pet_state() {
        Some(LoadedPetState::V2(s)) => {
            let c = character_local_rect();
            let cx_off = (c.left + c.right) / 2;
            let cy_off = (c.top + c.bottom) / 2;
            // ① 同一块屏（工作区几何完全一致）→ 比例还原
            if let Some(w) = monitor_workspaces().into_iter().find(|w| {
                w.left == s.work.left && w.top == s.work.top
                    && w.right == s.work.right && w.bottom == s.work.bottom
            }) {
                let cx = w.left as f64 + s.rx * (w.right - w.left).max(1) as f64;
                let cy = w.top as f64 + s.ry * (w.bottom - w.top).max(1) as f64;
                let mut x = cx as i32 - cx_off;
                let mut y = cy as i32 - cy_off;
                // clamp：角色区域尽量落在工作区内（工作区比窗口小时以左上对齐兜底）
                let x_lo = w.left - c.left;
                let x_hi = (w.right - c.right).max(x_lo);
                let y_lo = w.top - c.top;
                let y_hi = (w.bottom - c.bottom).max(y_lo);
                x = x.clamp(x_lo, x_hi);
                y = y.clamp(y_lo, y_hi);
                if pos_visible((x, y)) {
                    pet_log_line(&format!(
                        "[native-pet] pet.json v2 restored by ratio rx={:.3} ry={:.3} -> {},{}\n",
                        s.rx, s.ry, x, y
                    ));
                    return (x, y, s.hide);
                }
            }
            // ② 工作区已变 → 绝对坐标兜底
            if pos_visible((s.x, s.y)) {
                pet_log_line(&format!(
                    "[native-pet] pet.json v2 workarea changed -> absolute {},{}\n",
                    s.x, s.y
                ));
                return (s.x, s.y, s.hide);
            }
            pet_log_line(&format!(
                "[native-pet] pet.json v2 pos ({},{}) not visible -> default pos\n",
                s.x, s.y
            ));
            let (dx, dy) = default_pos();
            (dx, dy, s.hide)
        }
        Some(LoadedPetState::V1(s)) => {
            if pos_visible((s.x, s.y)) {
                (s.x, s.y, s.hide)
            } else {
                pet_log_line(&format!(
                    "[native-pet] pet.json v1 pos ({},{}) not on any visible workarea -> default pos\n",
                    s.x, s.y
                ));
                let (dx, dy) = default_pos();
                (dx, dy, s.hide)
            }
        }
        None => {
            let (dx, dy) = default_pos();
            (dx, dy, false)
        }
    }
}

/// R3：保存——按「角色可见区域中心」求比例与屏幕身份；同时写入绝对坐标作兜底。
pub(crate) fn save_pet_pos(pos: (i32, i32), hide: bool) {
    let c = character_local_rect();
    let cx = pos.0 + (c.left + c.right) / 2;
    let cy = pos.1 + (c.top + c.bottom) / 2;
    let (work, rx, ry) = match containing_work(cx, cy) {
        Some(w) => {
            let ww = w.width().max(1) as f64;
            let wh = w.height().max(1) as f64;
            (
                w,
                ((cx - w.left) as f64 / ww).clamp(0.0, 1.0),
                ((cy - w.top) as f64 / wh).clamp(0.0, 1.0),
            )
        }
        None => {
            // 角色中心不在任何工作区内（半出屏/拖动中）→ 退回主屏口径，仍可恢复
            let (sw, sh) = screen_size();
            let w = WorkRect { left: 0, top: 0, right: sw, bottom: sh };
            (
                w,
                (cx as f64 / (sw.max(1) as f64)).clamp(0.0, 1.0),
                (cy as f64 / (sh.max(1) as f64)).clamp(0.0, 1.0),
            )
        }
    };
    save_pet_state(&PetStateV2 { version: 2, rx, ry, x: pos.0, y: pos.1, hide, work });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(l: i32, t: i32, r: i32, b: i32) -> Rect {
        Rect { left: l, top: t, right: r, bottom: b }
    }

    #[test]
    fn overlap_area_basics() {
        assert_eq!(overlap_area(&rect(0, 0, 10, 10), &rect(5, 5, 20, 20)), 25);
        assert_eq!(overlap_area(&rect(0, 0, 10, 10), &rect(10, 0, 20, 10)), 0);
        assert_eq!(overlap_area(&rect(0, 0, 10, 10), &rect(2, 2, 8, 8)), 36);
    }

    #[test]
    fn character_rect_is_bottom_band() {
        // 角色区域 = 底部 CELL_H 高的一条带（不含上方气泡带）
        let c = character_local_rect();
        assert_eq!(c.left, 0);
        assert_eq!(c.right, WIN_W);
        assert_eq!(c.bottom, WIN_H);
        assert_eq!(c.top, WIN_H - CELL_H as i32 - 2);
        assert!(c.top > 0, "角色带不应覆盖整窗（气泡在更上方）");
    }

    #[test]
    fn character_global_rect_offsets_by_pos() {
        let c = character_local_rect();
        let g = character_global_rect((300, 200));
        assert_eq!(g.left, 300);
        assert_eq!(g.top, 200 + c.top);
        assert_eq!(g.bottom, 200 + WIN_H);
    }

    #[test]
    fn v1_json_parses_and_hides() {
        let v1 = r#"{"version":1,"x":1200,"y":500,"hide":true}"#;
        let v: serde_json::Value = serde_json::from_str(v1).unwrap();
        assert_eq!(v.get("version").and_then(|x| x.as_u64()), Some(1));
        let s: PetStateV1 = serde_json::from_value(v).unwrap();
        assert_eq!(s.version, 1);
        assert_eq!((s.x, s.y), (1200, 500));
        assert!(s.hide);
    }

    #[test]
    fn v2_roundtrip() {
        let s = PetStateV2 {
            version: 2,
            rx: 0.25,
            ry: 0.75,
            x: 111,
            y: 222,
            hide: false,
            work: WorkRect { left: 0, top: 0, right: 1920, bottom: 1040 },
        };
        let txt = serde_json::to_string(&s).unwrap();
        let v: serde_json::Value = serde_json::from_str(&txt).unwrap();
        assert_eq!(v.get("version").and_then(|x| x.as_u64()), Some(2));
        let back: PetStateV2 = serde_json::from_value(v).unwrap();
        assert_eq!(back.work, s.work);
        assert!((back.rx - 0.25).abs() < 1e-9 && (back.ry - 0.75).abs() < 1e-9);
        assert_eq!((back.x, back.y), (111, 222));
    }

    #[test]
    fn unknown_version_is_rejected() {
        // 版本分流：0/3 等未知版本一律 None（调用方回默认，不猜）
        for ver in [0_u64, 3, 99] {
            let txt = format!(r#"{{"version":{},"x":1,"y":2,"hide":false}}"#, ver);
            let v: serde_json::Value = serde_json::from_str(&txt).unwrap();
            let parsed = match v.get("version").and_then(|x| x.as_u64()) {
                Some(1) => serde_json::from_value::<PetStateV1>(v).ok().map(LoadedPetState::V1),
                Some(2) => serde_json::from_value::<PetStateV2>(v).ok().map(LoadedPetState::V2),
                _ => None,
            };
            assert!(parsed.is_none(), "version {} 不应被接受", ver);
        }
    }
}
