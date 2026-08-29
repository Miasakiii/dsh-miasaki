// pet_native.rs — 原生 Win32 分层窗口桌宠（UpdateLayeredWindow 逐像素 alpha）
// 纯 FFI + #[repr(C)] 结构体（x64 布局自控），与 Tauri 同进程、Arc<Mutex> 同步。
use std::{
    collections::HashMap,
    os::raw::c_void,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager};

const WIN_W: i32 = 286;
const WIN_H: i32 = 390;
const CELL_H: usize = 270;
const DOT_SIZE: i32 = 30;
// 预渲染气泡帧:生成于 scripts/gen-bubbles.ps1(系统字体在构建期出图,
// 运行时只做像素叠加 —— 规避 Win11 多线程 GDI 字体堆损坏导致 CreateFontW 崩溃)
const BUBBLE_W: i32 = 240;
const BUBBLE_H: i32 = 56;
const BUBBLE_COUNT: usize = 17;

// —— v2 动作丰富化参数(2026-08-22,见 design/pet-v2-phase-a-execution.md) ——
const WAVE_MS: u64 = 1300; // 双击挥手时长(wave 4 帧×8fps≈500ms,留余量)
const HOP_HOLD_MS: u64 = 200; // 跳跃落地:末帧定格时长
const AMBIENT_PLAY_MIN_MS: u64 = 1200; // ambient 表演下限
const AMBIENT_PLAY_VAR_MS: u64 = 1000; // ambient 表演随机幅度(1.2~2.2s)
const AMBIENT_REST_MIN_MS: u64 = 8000; // ambient 休息下限
const AMBIENT_REST_VAR_MS: u64 = 10000; // ambient 休息随机幅度(8~18s)
const AMBIENT_FIRST_DELAY_MS: u64 = 5500; // 首次表演延迟(4~7s 中点)
const AMBIENT_JUMP_PCT: u32 = 15; // 偶发 jump 概率(%)
const WANDER_PX_PER_FRAME: i32 = 9; // 滑步修正:每帧移动(90px/s ÷ 10fps)

pub struct PetShared {
    pub mode: String,
    pub intensity: String,
    pub hide: bool,
    /// 面板「位置重置」请求：窗口线程 compose 消费后清 false。
    pub pending_reset: bool,
}

pub struct NativePet {
    shared: Arc<Mutex<PetShared>>,
    _thread: Option<std::thread::JoinHandle<()>>,
}

/* ---------------- Win32 FFI（user32/gdi32） ---------------- */

type WndProc = unsafe extern "system" fn(isize, u32, usize, isize) -> isize;

#[repr(C)]
struct WndClassW {
    style: u32,
    lpfn: Option<WndProc>,
    cb_cls_extra: i32,
    cb_wnd_extra: i32,
    instance: isize,
    icon: isize,
    cursor: isize,
    background: isize,
    menu_name: *const u16,
    class_name: *const u16,
}

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

#[repr(C)]
struct Size {
    cx: i32,
    cy: i32,
}

#[repr(C)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

/// MONITORINFO（GetMonitorInfoW 输出；rcWork = 工作区，含任务栏偏移）。
#[repr(C)]
struct MonitorInfo {
    cb_size: u32,
    rc_monitor: Rect,
    rc_work: Rect,
    dw_flags: u32,
}

#[repr(C)]
struct Msg {
    hwnd: isize,
    message: u32,
    wparam: usize,
    lparam: isize,
    time: u32,
    pt: Point,
    lprivate: u32,
}

#[repr(C)]
struct BlendFn {
    blend_op: u8,
    blend_flags: u8,
    src_alpha: u8,
    alpha_format: u8,
}

#[repr(C)]
struct BmiHeader {
    size: u32,
    width: i32,
    height: i32,
    planes: u16,
    bit_count: u16,
    compression: u32,
    size_image: u32,
    x_ppm: i32,
    y_ppm: i32,
    clr_used: u32,
    clr_important: u32,
}

#[link(name = "user32")]
extern "system" {
    fn RegisterClassW(c: *const WndClassW) -> u16;
    fn SetProcessDpiAwarenessContext(v: isize) -> i32;
    fn GetLastError() -> u32;
    fn CreateWindowExW(
        ex: u32, cls: *const u16, name: *const u16, style: u32,
        x: i32, y: i32, w: i32, h: i32,
        parent: isize, menu: isize, inst: isize, param: *mut c_void,
    ) -> isize;
    fn ShowWindow(h: isize, c: i32) -> i32;
    fn UpdateLayeredWindow(
        h: isize, dc_dst: isize, ppt_dst: *const Point, psize: *const Size,
        dc_src: isize, ppt_src: *const Point, key: u32, blend: *const BlendFn, flags: u32,
    ) -> i32;
    fn GetMessageW(m: *mut Msg, h: isize, min: u32, max: u32) -> i32;
    fn TranslateMessage(m: *const Msg) -> i32;
    fn DispatchMessageW(m: *const Msg) -> isize;
    fn DefWindowProcW(h: isize, m: u32, w: usize, l: isize) -> isize;
    fn GetWindowLongPtrW(h: isize, i: i32) -> isize;
    fn SetWindowLongPtrW(h: isize, i: i32, v: isize) -> isize;
    fn GetCursorPos(p: *mut Point) -> i32;
    fn MoveWindow(h: isize, x: i32, y: i32, w: i32, ht: i32, repaint: i32) -> i32;
    fn GetWindowRect(h: isize, r: *mut Rect) -> i32;
    fn GetSystemMetrics(idx: i32) -> i32;
    fn SetTimer(h: isize, id: usize, ms: u32, cb: usize) -> usize;
    fn PostQuitMessage(c: i32);
    fn EnumDisplayMonitors(
        hdc: isize,
        clip: *const Rect,
        cb: unsafe extern "system" fn(isize, isize, *mut Rect, isize) -> i32,
        data: isize,
    ) -> i32;
    fn GetMonitorInfoW(mon: isize, info: *mut MonitorInfo) -> i32;
    fn CreatePopupMenu() -> isize;
    fn AppendMenuW(menu: isize, flags: u32, id: usize, item: *const u16) -> i32;
    fn TrackPopupMenu(menu: isize, flags: u32, x: i32, y: i32, rsv: i32, h: isize, rect: usize) -> i32;
    fn DestroyMenu(menu: isize) -> i32;
    fn SetForegroundWindow(h: isize) -> i32;
    fn GetModuleHandleW(n: *const u16) -> isize;
}

#[link(name = "gdi32")]
extern "system" {
    fn CreateCompatibleDC(h: isize) -> isize;
    fn DeleteDC(h: isize) -> i32;
    fn DeleteObject(o: isize) -> i32;
    fn SelectObject(dc: isize, o: isize) -> isize;
    fn CreateDIBSection(h: isize, bmi: *const BmiHeader, usage: u32, bits: *mut *mut c_void, section: isize, offset: u32) -> isize;
}

const WS_POPUP: u32 = 0x8000_0000;
const WS_EX_LAYERED: u32 = 0x0008_0000;
const WS_EX_TOPMOST: u32 = 0x0000_0008;
const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
const CS_HREDRAW: u32 = 0x0002;
const CS_VREDRAW: u32 = 0x0001;
const GWLP_USERDATA: i32 = -21;
const SW_SHOW: i32 = 5;
const SW_HIDE: i32 = 0;
const ULW_ALPHA: u32 = 0x02;
const DIB_RGB_COLORS: u32 = 0;
const MF_STRING: u32 = 0;
const TPM_RETURNCMD: u32 = 0x0100;
const TPM_RIGHTBUTTON: u32 = 0x0002;
const WM_CREATE: u32 = 0x0001;
const WM_DESTROY: u32 = 0x0002;
const WM_TIMER: u32 = 0x0113;
const WM_LBUTTONDOWN: u32 = 0x0201;
const WM_LBUTTONUP: u32 = 0x0202;
const WM_LBUTTONDBLCLK: u32 = 0x0203;
const WM_RBUTTONDOWN: u32 = 0x0204;
const WM_MOUSEMOVE: u32 = 0x0200;
const MK_LBUTTON: usize = 0x0001;
const MENU_HIDE: usize = 101;
const MENU_MIN: usize = 102;
const MENU_EXIT: usize = 103;
const MENU_SHOW: usize = 104;
const SM_CXSCREEN: i32 = 0;
const SM_CYSCREEN: i32 = 1;

/* ---------------- 随机数（LCG，无外部依赖） ---------------- */

fn rand_u32() -> u32 {
    static S: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0x9E37_79B9);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let x = S.fetch_add(0x9E37_79B9, std::sync::atomic::Ordering::SeqCst) ^ t;
    x.wrapping_mul(0x85EB_CA6B).wrapping_add(0xC2B2_AE35)
}

fn rand_range(lo: u64, hi: u64) -> u64 {
    lo + (rand_u32() as u64) % (hi - lo)
}

fn screen_size() -> (i32, i32) {
    unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) }
}

/* ---------------- 帧图 ---------------- */

struct Image {
    w: usize,
    h: usize,
    bgra: Vec<u32>, // 预乘 alpha，0xAARRGGBB
}

impl Clone for Image {
    fn clone(&self) -> Self {
        Image { w: self.w, h: self.h, bgra: self.bgra.clone() }
    }
}

fn load_png(bytes: &[u8]) -> Option<Image> {
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
        bgra[i] = (a << 24) | ((r * a / 255) << 16) | ((g * a / 255) << 8) | (b * a / 255);
    }
    Some(Image { w, h, bgra })
}

#[derive(Default)]
struct Frames {
    kurumi: HashMap<String, Vec<Image>>,
    // v2:三态值统一为帧组(单帧=长度1);idle 可为帧序列(whale idle.gif 拆分)
    whale_states: HashMap<String, Vec<Image>>,
    inverse_states: HashMap<String, Vec<Image>>,
    bubbles: Vec<Image>,
}

fn load_frames() -> Frames {
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

/* ---------------- 窗口状态 ---------------- */

struct Wander {
    until: std::time::Instant,
    dx: i32,
}

// v2:环境编排拍(低频随机小动作,wave/review/wait + 偶发 jump)
struct Ambient {
    row: String,
    until: std::time::Instant,
}

fn quote_pool(mode: &str) -> &'static [&'static str] {
    match mode {
        "kurumi" => &["ふふふ…", "啊啦，你来了呢", "时间，可是很宝贵的哦", "刻刻帝在看着你", "（轻笑）", "今晚的时间也归我哦"],
        "inverse" => &["选好了吗？", "别让我等太久", "（冷笑）", "效率。现在。", "你的时间，归我支配", "（眯起赤瞳）"],
        _ => &["咕噜咕噜…", "（吐泡泡）", "呜~ 我在听", "今天的代码也拜托了", "（摇尾巴）"],
    }
}

/// 台词在气泡精灵表(bubbles.png)中的起始帧号,数组顺序必须与 gen-bubbles.ps1 一致。
fn quote_base(mode: &str) -> usize {
    match mode {
        "kurumi" => 5,
        "inverse" => 11,
        _ => 0,
    }
}

fn pick_quote(mode: &str) -> usize {
    let pool = quote_pool(mode);
    quote_base(mode) + rand_u32() as usize % pool.len()
}

/// v2 环境编排:选一个 ambient 动作行。池 wave/review/wait,jump 以 AMBIENT_JUMP_PCT 概率替换。
/// 候选行若在 frames.json 缺失,由 kurumi 渲染分支的 fallback 链自动兜底(idle)。
fn pick_ambient_row() -> String {
    if rand_u32() % 100 < AMBIENT_JUMP_PCT {
        return "jump".to_string();
    }
    const POOL: [&str; 3] = ["wave", "review", "wait"];
    POOL[(rand_u32() as usize) % POOL.len()].to_string()
}

struct PetWin {
    hwnd: isize,
    dot_hwnd: isize,
    app: AppHandle,
    shared: Arc<Mutex<PetShared>>,
    frames: Frames,
    buf: Vec<u32>,
    frame_idx: usize,
    anim_ms: u64,
    last_tick: std::time::Instant,
    hop_until: Option<std::time::Instant>,
    hop_hold_until: Option<std::time::Instant>, // 落地过渡:跳完末帧定格(v2)
    wave_until: Option<std::time::Instant>, // 双击挥手(v2)
    ambient: Option<Ambient>, // 环境编排(v2)
    next_ambient: std::time::Instant,
    bubble: Option<(usize, std::time::Instant)>,
    press_pt: (i32, i32),
    dragged: bool,
    pos: (i32, i32),
    /// 主窗口当前实际显示状态（与 shared.hide 同步；show/hide 切换由 compose 单线程执行）。
    shown: bool,
    wander: Option<Wander>,
    next_quote: std::time::Instant,
    next_wander: std::time::Instant,
    // 持久 GDI 表面:创建一次,终身复用(消除高频 CreateDIBSection,防 gdi32full 崩溃)
    present_dc: isize,
    present_dib: isize,
    present_bits: *mut c_void,
}

/* ---------------- pet.json v1：(位置 + 隐藏状态) —— 原子写 + 版本化 ---------------- */

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetState {
    version: u32,
    x: i32,
    y: i32,
    hide: bool,
}

fn pet_state_path() -> std::path::PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("com.miasaki.desktop").join("pet.json")
}

/// 读取 pet.json；损坏/版本不符 → None（调用方回默认，不猜、不静默零值）。
fn load_pet_state() -> Option<PetState> {
    let txt = std::fs::read_to_string(pet_state_path()).ok()?;
    let s: PetState = serde_json::from_str(&txt).ok()?;
    if s.version != 1 {
        return None;
    }
    Some(s)
}

fn save_pet_state(s: &PetState) {
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

fn default_pos() -> (i32, i32) {
    (1200, 500)
}

/// 枚举全部显示器的「工作区」（work rect，含任务栏偏移）。
fn monitor_workspaces() -> Vec<Rect> {
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
fn pos_visible(pos: (i32, i32)) -> bool {
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
fn initial_pet_state() -> (i32, i32, bool) {
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

fn save_pet_pos(pos: (i32, i32), hide: bool) {
    save_pet_state(&PetState { version: 1, x: pos.0, y: pos.1, hide });
}

impl PetWin {
    fn compose(&mut self) {
        static TICKS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let tick = TICKS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let now = std::time::Instant::now();
        let mut dirty = false;

        // —— 外部命令消费（设置面板 hash 通道 → shared 标志；UI 仅在窗口线程执行）——
        {
            let (want_hide, do_reset) = {
                let mut s = self.shared.lock().unwrap();
                let h = s.hide;
                let r = s.pending_reset;
                s.pending_reset = false;
                (h, r)
            };
            if do_reset {
                let p = default_pos();
                self.pos = p;
                unsafe {
                    MoveWindow(self.hwnd, p.0, p.1, WIN_W, WIN_H, 1);
                    draw_dot(self.dot_hwnd, p);
                }
                pet_log_line(&format!("[native-pet] position reset -> {},{}\n", p.0, p.1));
                save_pet_pos(p, want_hide);
                self.last_tick = now - std::time::Duration::from_secs(10); // 强制重绘
                dirty = true;
            }
            // 目标隐藏状态(want_hide)与当前显示状态(self.shown)语义相反但布尔可比：
            // want_hide=false(显示) 且 shown=true(已显示) → 语义一致，无需切换；
            // want_hide==self.shown(布尔相等) 正是"语义相反需切换"的情形：
            //   (false,false)=想显示但已隐藏 → 显示；(true,true)=想隐藏但已显示 → 隐藏。
            if want_hide == self.shown {
                unsafe {
                    if want_hide {
                        ShowWindow(self.hwnd, SW_HIDE);
                        ShowWindow(self.dot_hwnd, SW_SHOW);
                    } else {
                        ShowWindow(self.dot_hwnd, SW_HIDE);
                        ShowWindow(self.hwnd, SW_SHOW);
                    }
                }
                self.shown = !want_hide;
                pet_log_line(&format!(
                    "[native-pet] {} (hide persisted)\n",
                    if want_hide { "hidden" } else { "shown" }
                ));
                save_pet_pos(self.pos, want_hide);
                dirty = true;
            }
        }

        // —— 待机随机行为：定时气泡台词 + 定时散步（kurumi 专属,左右移动贴边吸附） ——
        if now >= self.next_quote && self.bubble.is_none() {
            self.next_quote = now + std::time::Duration::from_millis(rand_range(40000, 90000));
            let idx = {
                let s = self.shared.lock().unwrap();
                pick_quote(&s.mode)
            };
            self.bubble = Some((idx, now));
            self.last_tick = now - std::time::Duration::from_secs(10); // 立即触发重绘
            dirty = true;
        }
        if self.wander.is_none() && self.hop_until.is_none() && self.hop_hold_until.is_none()
            && self.ambient.is_none() && now >= self.next_wander
        {
            let is_kurumi = {
                let s = self.shared.lock().unwrap();
                s.mode == "kurumi"
            };
            if is_kurumi {
                let dir = if rand_u32() % 2 == 0 { 1 } else { -1 };
                self.wander = Some(Wander {
                    until: now + std::time::Duration::from_millis(rand_range(1100, 2400)),
                    dx: dir,
                });
                dirty = true;
            }
            self.next_wander = now + std::time::Duration::from_millis(rand_range(45000, 120000));
        }
        // —— v2 环境编排：idle 基线低频随机小动作(手势打断见 wnd_proc) ——
        if self.ambient.is_none() && self.hop_until.is_none() && self.hop_hold_until.is_none()
            && self.wave_until.is_none() && self.wander.is_none() && now >= self.next_ambient
        {
            let idle_intensity = {
                let s = self.shared.lock().unwrap();
                s.intensity == "idle"
            };
            if idle_intensity && self.bubble.is_none() {
                let row = pick_ambient_row();
                self.ambient = Some(Ambient {
                    row,
                    until: now + std::time::Duration::from_millis(
                        rand_range(AMBIENT_PLAY_MIN_MS, AMBIENT_PLAY_MIN_MS + AMBIENT_PLAY_VAR_MS),
                    ),
                });
                self.frame_idx = 0;
                dirty = true;
            }
            self.next_ambient = now + std::time::Duration::from_millis(
                rand_range(AMBIENT_REST_MIN_MS, AMBIENT_REST_MIN_MS + AMBIENT_REST_VAR_MS),
            );
        }

        if now.duration_since(self.last_tick).as_millis() >= self.anim_ms as u128 {
            self.last_tick = now;
            // —— wander 滑步修正(v2):位移与 run 帧同步(每帧 9px),步频一致 ——
            if let Some(w) = &mut self.wander {
                self.pos.0 += w.dx * WANDER_PX_PER_FRAME;
                let (sw, _) = screen_size();
                if self.pos.0 <= 0 {
                    self.pos.0 = 0;
                    self.wander = None;
                } else if self.pos.0 >= sw - WIN_W {
                    self.pos.0 = sw - WIN_W;
                    self.wander = None;
                } else if now >= w.until {
                    self.wander = None;
                }
            }
            // 清空画布只在帧更新时进行,避免 33ms 心跳把中间帧清成空白
            for p in self.buf.iter_mut() {
                *p = 0;
            }
            let (mode, intensity) = {
                let s = self.shared.lock().unwrap();
                (s.mode.clone(), s.intensity.clone())
            };
            if mode == "whale" || mode == "inverse" {
                let key = if intensity == "deep" {
                    "deep"
                } else if intensity == "work" {
                    "work"
                } else {
                    "idle"
                };
                let states = if mode == "whale" {
                    &self.frames.whale_states
                } else {
                    &self.frames.inverse_states
                };
                // 三态立绘对应三个思考等级(小/中/大或不同姿态),强度来自 DSH 推理等级,切换稳定
                // frames 加载后不可变:裸指针解引用安全(同时规避 self 借用冲突)
                let list_ptr = states.get(key).map(|l| l as *const Vec<Image>);
                if let Some(ptr) = list_ptr {
                    let list = unsafe { &*ptr };
                    let bob = if key == "idle" {
                        let phase = (std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() % 3200) as f32 / 1600.0 * std::f32::consts::PI;
                        phase.sin() * 3.0
                    } else {
                        0.0
                    };
                    if list.len() > 1 {
                        // v2:帧序列状态(idle.gif 拆帧),6fps 循环 + bob
                        self.anim_ms = 1000 / 6;
                        let idx = self.frame_idx % list.len();
                        self.frame_idx += 1;
                        self.blit_center_bottom(&list[idx], bob, 1.0);
                    } else if let Some(img) = list.first() {
                        // 单帧:静态 + bob(与历史行为一致)
                        self.anim_ms = 1000;
                        self.blit_center_bottom(img, bob, 1.0);
                    }
                }
            } else {
                // v2 优先序:hop → hopHold(落地) → wander → ambient → wave → focus(wait) → idle
                let row = if let Some(until) = self.hop_until {
                    if now < until {
                        "jump".to_string()
                    } else {
                        // 落地过渡:跳完末帧定格 HOP_HOLD_MS 再回 idle,消除硬切
                        if self.hop_hold_until.is_none() {
                            self.hop_hold_until =
                                Some(now + std::time::Duration::from_millis(HOP_HOLD_MS));
                        }
                        "jump".to_string()
                    }
                } else if let Some(until) = self.hop_hold_until {
                    if now < until {
                        "jump".to_string()
                    } else {
                        self.hop_hold_until = None;
                        "idle".to_string()
                    }
                } else if self.wander.is_some() {
                    // 散步：播放 run 行帧（双向移动共用）
                    "run".to_string()
                } else if let Some(a) = &self.ambient {
                    if now >= a.until {
                        self.ambient = None;
                        "idle".to_string()
                    } else {
                        a.row.clone()
                    }
                } else if let Some(until) = self.wave_until {
                    if now < until {
                        "wave".to_string()
                    } else {
                        self.wave_until = None;
                        "idle".to_string()
                    }
                } else if intensity == "idle" {
                    "idle".to_string()
                } else {
                    // 思考中=静默守候(同 idle 姿态;ambient 仅在 idle 强度触发,自动安静)。
                    // wait 行留给审批等待(阶段 B,偶发且有语义)——曾用 wait 行表示思考,
                    // 其帧组起伏较大 + 慢放 → 真机观感「一直跳动」(2026-08-22 用户反馈修正)。
                    "idle".to_string()
                };
                let fps = match row.as_str() {
                    "run" | "runRight" | "runLeft" => 10,
                    "jump" => 11,
                    "wave" => 8,
                    "wait" | "review" | "failed" => 6,
                    _ => 8,
                };
                self.anim_ms = 1000 / fps;
                let pick = {
                    let map = &self.frames.kurumi;
                    let list = map.get(&row).or_else(|| map.get("idle"));
                    match list {
                        Some(l) if !l.is_empty() => {
                            // 落地定格窗口:锁定 jump 末帧,不推进
                            let holding_jump = row == "jump"
                                && self.hop_until.is_none()
                                && match self.hop_hold_until {
                                    Some(hu) => now < hu,
                                    None => false,
                                };
                            let idx = if holding_jump {
                                l.len() - 1
                            } else {
                                self.frame_idx % l.len()
                            };
                            if !holding_jump {
                                self.frame_idx += 1;
                            }
                            Some((idx, row.clone()))
                        }
                        _ => None,
                    }
                };
                if let Some((idx, row_key)) = pick {
                    let ptr = self.frames.kurumi.get(&row_key).map(|l| l as *const Vec<Image>);
                    if let Some(ptr) = ptr {
                        let list = unsafe { &*ptr };
                        // v2 呼吸 bob:基线(idle/wait)且无行动状态时 ±2px 上下呼吸
                        let calm = (row == "idle" || row == "wait")
                            && self.hop_until.is_none()
                            && self.hop_hold_until.is_none()
                            && self.wave_until.is_none()
                            && self.ambient.is_none()
                            && self.wander.is_none();
                        let bob = if calm {
                            let phase = (std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() % 3200) as f32
                                / 1600.0
                                * std::f32::consts::PI;
                            phase.sin() * 2.0
                        } else {
                            0.0
                        };
                        self.blit_center_bottom(&list[idx % list.len()], bob, 1.0);
                    }
                }
            }
            // 气泡与角色同帧绘制(帧更新清空 buf 后重画,避免每 tick 文本渲染)
            if let Some((idx, _)) = self.bubble.clone() {
                self.blit_bubble(idx);
            }
            dirty = true;
        }
        // 气泡:超时检查每 tick;绘制只在帧更新后(避免每 33ms 图像合成)
        if let Some((_, t0)) = self.bubble.clone() {
            if now.duration_since(t0).as_secs() > 3 {
                self.bubble = None;
                dirty = true;
            } else {
                // 若本 tick 未重绘(帧未更新),气泡已在上一帧的 buf 上,无需重复绘制
            }
        }
        if tick < 3 {
            let s = self.shared.lock().unwrap();
            let non_zero = self.buf.iter().filter(|p| **p != 0).count();
            pet_log_line(&format!(
                "[native-pet] tick{} mode={} int={} whale_states={} kurumi_rows={} buf_nonzero={}\n",
                tick, s.mode, s.intensity,
                self.frames.whale_states.len(),
                self.frames.kurumi.get("idle").map(|v| v.len()).unwrap_or(0),
                non_zero
            ));
        }
        // 脏标记:内容变化才 present,静止时 GDI 频率从 33ms 降到帧更新周期(≥125ms)
        if dirty {
            self.present();
        }
    }

    fn blit_center_bottom(&mut self, img: &Image, bob: f32, scale: f32) {
        let h = (CELL_H as f32 * scale) as i32;
        let w = (img.w as f32 / img.h as f32 * h as f32) as i32;
        let x0 = (WIN_W - w) / 2;
        let y0 = WIN_H - h - 2 + bob as i32;
        for y in 0..h {
            let sy = y as usize * img.h / h as usize;
            for x in 0..w {
                let sx = x as usize * img.w / w as usize;
                let px = img.bgra[sy * img.w + sx];
                let a = (px >> 24) & 0xFF;
                if a == 0 {
                    continue;
                }
                let dx = x0 + x;
                let dy = y0 + y;
                if dx < 0 || dy < 0 || dx >= WIN_W || dy >= WIN_H {
                    continue;
                }
                let dst = &mut self.buf[(dy * WIN_W + dx) as usize];
                let da = (*dst >> 24) & 0xFF;
                let inv = 255 - a;
                let r = (((px >> 16) & 0xFF) + (((*dst >> 16) & 0xFF) * inv / 255)) & 0xFF;
                let g = (((px >> 8) & 0xFF) + (((*dst >> 8) & 0xFF) * inv / 255)) & 0xFF;
                let b = ((px & 0xFF) + ((*dst & 0xFF) * inv / 255)) & 0xFF;
                let oa = (a + da * inv / 255) & 0xFF;
                *dst = (oa << 24) | (r << 16) | (g << 8) | b;
            }
        }
    }

    /// 纯像素叠加一张预渲染帧(无缩放)。
    fn blit_img(&mut self, img: &Image, x0: i32, y0: i32) {
        for y in 0..img.h as i32 {
            for x in 0..img.w as i32 {
                let px = img.bgra[(y as usize) * img.w + x as usize];
                let a = (px >> 24) & 0xFF;
                if a == 0 {
                    continue;
                }
                let dx = x0 + x;
                let dy = y0 + y;
                if dx < 0 || dy < 0 || dx >= WIN_W || dy >= WIN_H {
                    continue;
                }
                let dst = &mut self.buf[(dy * WIN_W + dx) as usize];
                let da = (*dst >> 24) & 0xFF;
                let inv = 255 - a;
                let r = (((px >> 16) & 0xFF) + (((*dst >> 16) & 0xFF) * inv / 255)) & 0xFF;
                let g = (((px >> 8) & 0xFF) + (((*dst >> 8) & 0xFF) * inv / 255)) & 0xFF;
                let b = ((px & 0xFF) + ((*dst & 0xFF) * inv / 255)) & 0xFF;
                let oa = (a + da * inv / 255) & 0xFF;
                *dst = (oa << 24) | (r << 16) | (g << 8) | b;
            }
        }
    }

    /// 绘制预渲染气泡帧(帧序 = quote 池序;不再调用任何 GDI 字体 API)。
    fn blit_bubble(&mut self, idx: usize) {
        let frame = self.frames.bubbles.get(idx).cloned();
        if let Some(img) = frame {
            // 帧气泡矩形位于帧内 (15,4),blit 后与旧像素布局一致:文本中心 = 原 (54,73)
            let x0 = (WIN_W - BUBBLE_W) / 2;
            let y0 = WIN_H - CELL_H as i32 - 56 - 4;
            self.blit_img(&img, x0, y0);
        }
    }

    fn present(&self) {
        unsafe {
            // 持久 DC/DIB 复用:仅在创建窗口时初始化,否则低频 GDI 交互
            if self.present_dc == 0 || self.present_dib == 0 || self.present_bits.is_null() {
                return;
            }
            std::ptr::copy_nonoverlapping(self.buf.as_ptr(), self.present_bits as *mut u32, self.buf.len());
            let mut pt = Point { x: self.pos.0, y: self.pos.1 };
            let mut sz = Size { cx: WIN_W, cy: WIN_H };
            let mut src = Point { x: 0, y: 0 };
            let blend = BlendFn { blend_op: 1, blend_flags: 0, src_alpha: 255, alpha_format: 1 };
            let ok = UpdateLayeredWindow(self.hwnd, 0, &mut pt, &mut sz, self.present_dc, &mut src, 0, &blend, ULW_ALPHA);
            if ok == 0 {
                pet_log_line(&format!("[native-pet] ULW failed, GetLastError={}\n", GetLastError()));
            }
        }
    }

    fn do_hop(&mut self) {
        self.hop_until = Some(std::time::Instant::now() + std::time::Duration::from_millis(900));
        self.hop_hold_until = None;
        self.wave_until = None;
        self.ambient = None; // 手势打断环境编排
        self.frame_idx = 0;
        self.last_tick = std::time::Instant::now() - std::time::Duration::from_secs(10);
        let idx = {
            let s = self.shared.lock().unwrap();
            pick_quote(&s.mode)
        };
        self.bubble = Some((idx, std::time::Instant::now()));
    }

    /// v2 双击挥手:播 wave 行(约 500ms 内容,余量 1300ms 收尾),任何指针事件可打断
    fn do_wave(&mut self) {
        self.wave_until = Some(std::time::Instant::now() + std::time::Duration::from_millis(WAVE_MS));
        self.ambient = None;
        self.frame_idx = 0;
        self.last_tick = std::time::Instant::now() - std::time::Duration::from_secs(10);
    }

    /// v2 决策1:主窗口最小化/隐藏时双击=唤起(do_wave 的替代路径)
    fn main_needs_wake(&self) -> bool {
        self.app
            .get_webview_window("main")
            .map(|w| !w.is_visible().unwrap_or(true) || w.is_minimized().unwrap_or(false))
            .unwrap_or(false)
    }

    fn show_menu(&self, x: i32, y: i32) {
        unsafe {
            let enc = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
            let m = CreatePopupMenu();
            let s1 = enc("显示主窗口");
            let s2 = enc("隐藏桌宠");
            let s3 = enc("最小化主窗口");
            let s4 = enc("退出应用");
            AppendMenuW(m, MF_STRING, MENU_SHOW, s1.as_ptr());
            AppendMenuW(m, MF_STRING, MENU_HIDE, s2.as_ptr());
            AppendMenuW(m, MF_STRING, MENU_MIN, s3.as_ptr());
            AppendMenuW(m, MF_STRING, MENU_EXIT, s4.as_ptr());
            SetForegroundWindow(self.hwnd);
            let cmd = TrackPopupMenu(m, TPM_RETURNCMD | TPM_RIGHTBUTTON, x, y, 0, self.hwnd, 0);
            DestroyMenu(m);
            match cmd as usize {
                MENU_SHOW => self.focus_main(),
                MENU_HIDE => self.hide_self(),
                MENU_MIN => {
                    if let Some(w) = self.app.get_webview_window("main") {
                        let _ = w.minimize();
                    }
                }
                MENU_EXIT => crate::request_close(&self.app),
                _ => {}
            }
        }
    }

    /// 隐藏请求：只写 shared 标志，UI 切换与落盘由 compose（窗口线程）统一执行，
    /// 避免多线程直接操作 user32 句柄。
    fn hide_self(&self) {
        if let Ok(mut s) = self.shared.lock() {
            s.hide = true;
        }
    }

    fn show_self(&self) {
        if let Ok(mut s) = self.shared.lock() {
            s.hide = false;
        }
    }

    // 点击桌宠 → 唤起/聚焦主窗口(最小化先还原:SW_SHOW 不会解除最小化,必须 unminimize)
    fn focus_main(&self) {
        if let Some(w) = self.app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }
}

/* ---------------- 窗口过程 ---------------- */

unsafe fn get_pet(hwnd: isize) -> *mut PetWin {
    GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PetWin
}

unsafe extern "system" fn wnd_proc(hwnd: isize, msg: u32, wp: usize, _lp: isize) -> isize {
    let pet = get_pet(hwnd);
    if pet.is_null() {
        return DefWindowProcW(hwnd, msg, wp, _lp);
    }
    match msg {
        WM_CREATE => {
            SetTimer(hwnd, 1, 33, 0);
            0
        }
        WM_TIMER => {
            (*pet).compose();
            0
        }
        WM_LBUTTONDOWN => {
            let mut p = Point { x: 0, y: 0 };
            GetCursorPos(&mut p);
            (*pet).press_pt = (p.x, p.y);
            (*pet).dragged = false;
            // v2:指针按下即打断环境编排/挥手(拖拽与动作互斥)
            (*pet).ambient = None;
            (*pet).wave_until = None;
            0
        }
        WM_MOUSEMOVE => {
            if wp & MK_LBUTTON != 0 {
                let mut p = Point { x: 0, y: 0 };
                GetCursorPos(&mut p);
                let dx = p.x - (*pet).press_pt.0;
                let dy = p.y - (*pet).press_pt.1;
                if dx.abs() + dy.abs() > 4 {
                    (*pet).dragged = true;
                    let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
                    GetWindowRect(hwnd, &mut r);
                    let nx = r.left + dx;
                    let ny = r.top + dy;
                    MoveWindow(hwnd, nx, ny, WIN_W, WIN_H, 1);
                    (*pet).pos = (nx, ny);
                    (*pet).press_pt = (p.x, p.y);
                }
            }
            0
        }
        WM_LBUTTONUP => {
            if !(*pet).dragged {
                (*pet).do_hop();
                (*pet).focus_main(); // 点击桌宠 → 唤起/聚焦主窗口
            } else {
                let hide = (*pet).shared.lock().map(|s| s.hide).unwrap_or(false);
                save_pet_pos((*pet).pos, hide);
            }
            0
        }
        WM_LBUTTONDBLCLK => {
            // v2 决策1:主窗最小化/隐藏 → 唤起;否则 → 挥手(修复 wave 行从未触发的漂移)
            if (*pet).main_needs_wake() {
                (*pet).focus_main();
            } else {
                (*pet).do_wave();
            }
            0
        }
        WM_RBUTTONDOWN => {
            let mut p = Point { x: 0, y: 0 };
            GetCursorPos(&mut p);
            (*pet).show_menu(p.x, p.y);
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wp, _lp),
    }
}

unsafe extern "system" fn dot_proc(hwnd: isize, msg: u32, wp: usize, lp: isize) -> isize {
    let pet = get_pet(hwnd);
    if pet.is_null() {
        return DefWindowProcW(hwnd, msg, wp, lp);
    }
    match msg {
        WM_LBUTTONUP => {
            (*pet).show_self();
            0
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn draw_dot(dot_hwnd: isize, pos: (i32, i32)) {
    unsafe {
        // GDI 绘制不写 alpha，恢复圆点改手工逐像素填充（预乘金）
        let mut buf = vec![0u32; (DOT_SIZE * DOT_SIZE) as usize];
        let r = DOT_SIZE / 2;
        for y in 0..DOT_SIZE {
            for x in 0..DOT_SIZE {
                let dx = x - r;
                let dy = y - r;
                if dx * dx + dy * dy <= r * r {
                    buf[(y * DOT_SIZE + x) as usize] = (255 << 24) | (0xB3 << 16) | (0x6A << 8) | 0xD9;
                }
            }
        }
        let dc = CreateCompatibleDC(0);
        if dc == 0 {
            return;
        }
        let bmi = BmiHeader {
            size: 40,
            width: DOT_SIZE,
            height: -DOT_SIZE,
            planes: 1,
            bit_count: 32,
            compression: 0,
            size_image: 0,
            x_ppm: 0,
            y_ppm: 0,
            clr_used: 0,
            clr_important: 0,
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        let dib = CreateDIBSection(dc, &bmi, DIB_RGB_COLORS, &mut bits, 0, 0);
        if dib == 0 || bits.is_null() {
            DeleteDC(dc);
            return;
        }
        let old = SelectObject(dc, dib);
        std::ptr::copy_nonoverlapping(buf.as_ptr(), bits as *mut u32, buf.len());
        let mut pt = Point { x: pos.0, y: pos.1 };
        let mut sz = Size { cx: DOT_SIZE, cy: DOT_SIZE };
        let mut src = Point { x: 0, y: 0 };
        let blend = BlendFn { blend_op: 1, blend_flags: 0, src_alpha: 255, alpha_format: 1 };
        UpdateLayeredWindow(dot_hwnd, 0, &mut pt, &mut sz, dc, &mut src, 0, &blend, ULW_ALPHA);
        SelectObject(dc, old);
        DeleteObject(dib);
        DeleteDC(dc);
    }
}

fn pet_log_line(line: &str) {
    if let Ok(base) = std::env::var("LOCALAPPDATA") {
        let dir = std::path::Path::new(&base).join("miasaki");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("pet.log")) {
            use std::io::Write;
            let _ = f.write_all(line.as_bytes());
        }
    }
}

fn create_window(app: AppHandle, shared: Arc<Mutex<PetShared>>, frames: Frames) {
    unsafe {
        // 显式按监视器 DPI 感知，保证窗口物理尺寸正确
        SetProcessDpiAwarenessContext(-4);
        let (x, y, restore_hide) = initial_pet_state();
        let mut pet = Box::new(PetWin {
            hwnd: 0,
            dot_hwnd: 0,
            app,
            shared,
            frames,
            buf: vec![0u32; (WIN_W * WIN_H) as usize],
            frame_idx: 0,
            anim_ms: 125,
            last_tick: std::time::Instant::now() - std::time::Duration::from_secs(10),
            hop_until: None,
            hop_hold_until: None,
            wave_until: None,
            ambient: None,
            next_ambient: std::time::Instant::now() + std::time::Duration::from_millis(AMBIENT_FIRST_DELAY_MS),
            bubble: None,
            press_pt: (0, 0),
            dragged: false,
            pos: (x, y),
            shown: !restore_hide,
            wander: None,
            next_quote: std::time::Instant::now() + std::time::Duration::from_secs(12),
            next_wander: std::time::Instant::now() + std::time::Duration::from_secs(8),
            present_dc: 0,
            present_dib: 0,
            present_bits: std::ptr::null_mut(),
        });
        let pet_ptr = &mut *pet as *mut PetWin;
        let inst = GetModuleHandleW(std::ptr::null());

        let cls = wide("MiasakiPetWin");
        let wc = WndClassW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfn: Some(wnd_proc),
            cb_cls_extra: 0,
            cb_wnd_extra: std::mem::size_of::<isize>() as i32,
            instance: inst,
            icon: 0,
            cursor: 0,
            background: 0,
            menu_name: std::ptr::null(),
            class_name: cls.as_ptr(),
        };
        let _ = RegisterClassW(&wc);

        let dot_cls = wide("MiasakiPetDot");
        let dot_wc = WndClassW {
            lpfn: Some(dot_proc),
            class_name: dot_cls.as_ptr(),
            ..wc
        };
        let _ = RegisterClassW(&dot_wc);

        let ex = WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW;
        let hwnd = CreateWindowExW(
            ex, cls.as_ptr(), cls.as_ptr(), WS_POPUP,
            x, y, WIN_W, WIN_H,
            0, 0, inst, pet_ptr as *mut c_void,
        );
        pet.hwnd = hwnd;
        let dot_hwnd = CreateWindowExW(
            ex, dot_cls.as_ptr(), dot_cls.as_ptr(), WS_POPUP,
            x, y, DOT_SIZE, DOT_SIZE,
            0, 0, inst, pet_ptr as *mut c_void,
        );
        pet.dot_hwnd = dot_hwnd;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, pet_ptr as isize);
        SetWindowLongPtrW(dot_hwnd, GWLP_USERDATA, pet_ptr as isize);
        // 关键:WM_CREATE 期间 USERDATA 尚未设置,wnd_proc 的 SetTimer 不会执行;
        // 在此(USERDATA 就位后)显式启动 33ms 动画定时器
        SetTimer(hwnd, 1, 33, 0);

        // 持久 GDI 表面(创建一次,终身复用;避免高频 CreateDIBSection 触发 gdi32full 崩溃)
        {
            let dc = CreateCompatibleDC(0);
            let bmi = BmiHeader {
                size: 40,
                width: WIN_W,
                height: -WIN_H,
                planes: 1,
                bit_count: 32,
                compression: 0,
                size_image: 0,
                x_ppm: 0,
                y_ppm: 0,
                clr_used: 0,
                clr_important: 0,
            };
            let mut bits: *mut c_void = std::ptr::null_mut();
            let dib = CreateDIBSection(dc, &bmi, DIB_RGB_COLORS, &mut bits, 0, 0);
            if dib != 0 && !bits.is_null() {
                SelectObject(dc, dib);
                pet.present_dc = dc;
                pet.present_dib = dib;
                pet.present_bits = bits;
            } else {
                // 铁律#4:dib 创建成功但 bits 空指针(理论不可达)时,先删 DIB 再删 DC,防句柄泄漏
                if dib != 0 {
                    DeleteObject(dib);
                }
                DeleteDC(dc);
                pet_log_line("[native-pet] present surface init failed\n");
            }
        }

        {
            let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
            GetWindowRect(hwnd, &mut r);
            pet_log_line(&format!("[native-pet] window created at {},{}, {}x{}\n", r.left, r.top, r.right - r.left, r.bottom - r.top));
        }

        draw_dot(dot_hwnd, (x, y));
        pet.compose();
        pet_log_line("[native-pet] first compose done\n");
        // 启动恢复隐藏状态：主窗隐藏、圆点可见；否则仅显示主窗（圆点留隐藏，等待首次显示切换）
        if restore_hide {
            ShowWindow(dot_hwnd, SW_SHOW);
            pet_log_line("[native-pet] restored hidden state (dot shown)\n");
        } else {
            ShowWindow(hwnd, SW_SHOW);
        }
        std::mem::forget(pet);

        let mut msg = Msg {
            hwnd: 0,
            message: 0,
            wparam: 0,
            lparam: 0,
            time: 0,
            pt: Point { x: 0, y: 0 },
            lprivate: 0,
        };
        while GetMessageW(&mut msg, 0, 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

impl NativePet {
    pub fn spawn(app: AppHandle) -> Self {
        let restore_hide = load_pet_state().map(|s| s.hide).unwrap_or(false);
        let shared = Arc::new(Mutex::new(PetShared {
            mode: "whale".to_string(),
            intensity: "idle".to_string(),
            hide: restore_hide,
            pending_reset: false,
        }));
        let frames = load_frames();
        let s2 = shared.clone();
        let app2 = app.clone();
        let thread = std::thread::spawn(move || {
            create_window(app2, s2, frames);
        });
        NativePet {
            shared,
            _thread: Some(thread),
        }
    }

    pub fn set_mode(&self, mode: &str) {
        pet_log_line(&format!("[native-pet] set_mode {mode}\n"));
        if let Ok(mut s) = self.shared.lock() {
            s.mode = mode.to_string();
        }
    }

    pub fn set_intensity(&self, int: &str) {
        pet_log_line(&format!("[native-pet] set_intensity {int}\n"));
        if let Ok(mut s) = self.shared.lock() {
            s.intensity = int.to_string();
        }
    }

    /// 面板/设置命令：显示或隐藏桌宠（compose 窗口线程消费并落盘）。
    pub fn set_hide(&self, hide: bool) {
        if let Ok(mut s) = self.shared.lock() {
            s.hide = hide;
        }
    }

    /// 面板/设置命令：位置重置回默认点（compose 窗口线程消费）。
    pub fn request_reset(&self) {
        if let Ok(mut s) = self.shared.lock() {
            s.pending_reset = true;
        }
    }

    /// 当前是否隐藏（面板状态同步）。
    pub fn is_hidden(&self) -> bool {
        self.shared.lock().map(|s| s.hide).unwrap_or(false)
    }
}
