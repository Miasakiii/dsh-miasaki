//! pet.json v1 持久化：原子写 + 显示器可见性校验（D2 拆分）
use super::config::*;
use super::ffi::*;
use super::window::pet_log_line;
/* ---------------- pet.json v1：(位置 + 隐藏状态) —— 原子写 + 版本化 ---------------- */

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetState {
    pub(crate) version: u32,
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) hide: bool,
}

pub(crate) fn pet_state_path() -> std::path::PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("com.miasaki.desktop").join("pet.json")
}

/// 读取 pet.json；损坏/版本不符 → None（调用方回默认，不猜、不静默零值）。
pub(crate) fn load_pet_state() -> Option<PetState> {
    let txt = std::fs::read_to_string(pet_state_path()).ok()?;
    let s: PetState = serde_json::from_str(&txt).ok()?;
    if s.version != 1 {
        return None;
    }
    Some(s)
}

pub(crate) fn save_pet_state(s: &PetState) {
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

/// 位置可见性：窗口中心点落在任一显示器工作区内即认为可见
/// （半出屏保留，屏外（拔掉副屏/分辨率变化遗留坐标）→ 不可见）。
pub(crate) fn pos_visible(pos: (i32, i32)) -> bool {
    let cx = pos.0 + WIN_W / 2;
    let cy = pos.1 + WIN_H / 2;
    let ws = monitor_workspaces();
    if ws.is_empty() {
        // 枚举失败兜底：主屏尺寸（单屏环境）
        let (sw, sh) = screen_size();
        return cx >= 0 && cy >= 0 && cx < sw && cy < sh;
    }
    ws.iter()
        .any(|r| cx >= r.left && cx < r.right && cy >= r.top && cy < r.bottom)
}

/// 初始状态（位置 + 是否隐藏）：
/// - pet.json 完好且位置可见 → 直接恢复（含隐藏状态）
/// - 位置不可见（屏外遗留坐标，用户误拖/显示器布局变化）→ 回默认位置，保留隐藏设置
/// - 损坏/版本不符 → 全部默认并重建
pub(crate) fn initial_pet_state() -> (i32, i32, bool) {
    match load_pet_state() {
        Some(s) if pos_visible((s.x, s.y)) => (s.x, s.y, s.hide),
        Some(s) => {
            pet_log_line(&format!(
                "[native-pet] pet.json pos ({},{}) not on any visible workarea -> default pos\n",
                s.x, s.y
            ));
            let (dx, dy) = default_pos();
            (dx, dy, s.hide)
        }
        None => {
            let (dx, dy) = default_pos();
            (dx, dy, false)
        }
    }
}

pub(crate) fn save_pet_pos(pos: (i32, i32), hide: bool) {
    save_pet_state(&PetState { version: 1, x: pos.0, y: pos.1, hide });
}
