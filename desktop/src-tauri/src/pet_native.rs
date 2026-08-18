// pet_native.rs — 原生 Win32 分层窗口桌宠（UpdateLayeredWindow 逐像素 alpha）
// 纯 FFI + #[repr(C)] 结构体（x64 布局自控），与 Tauri 同进程、Arc<Mutex> 同步。
use std::{
    collections::HashMap,
    os::raw::{c_int, c_void},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager};

const WIN_W: i32 = 220;
const WIN_H: i32 = 300;
const CELL_W: usize = 192;
const CELL_H: usize = 208;
const DOT_SIZE: i32 = 26;

pub struct PetShared {
    pub mode: String,
    pub intensity: String,
    pub hide: bool,
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
    fn SetTimer(h: isize, id: usize, ms: u32, cb: usize) -> usize;
    fn PostQuitMessage(c: i32);
    fn CreatePopupMenu() -> isize;
    fn AppendMenuW(menu: isize, flags: u32, id: usize, item: *const u16) -> i32;
    fn TrackPopupMenu(menu: isize, flags: u32, x: i32, y: i32, rsv: i32, h: isize, rect: usize) -> i32;
    fn DestroyMenu(menu: isize) -> i32;
    fn SetForegroundWindow(h: isize) -> i32;
    fn GetModuleHandleW(n: *const u16) -> isize;
    fn DrawTextW(dc: isize, s: *const u16, n: i32, r: *mut Rect, f: u32) -> i32;
}

#[link(name = "gdi32")]
extern "system" {
    fn CreateCompatibleDC(h: isize) -> isize;
    fn DeleteDC(h: isize) -> i32;
    fn DeleteObject(o: isize) -> i32;
    fn SelectObject(dc: isize, o: isize) -> isize;
    fn CreateDIBSection(h: isize, bmi: *const BmiHeader, usage: u32, bits: *mut *mut c_void, section: isize, offset: u32) -> isize;
    fn CreateSolidBrush(c: u32) -> isize;
    fn Ellipse(dc: isize, l: i32, t: i32, r: i32, b: i32) -> i32;
    fn SetBkMode(dc: isize, m: i32) -> i32;
    fn SetTextColor(dc: isize, c: u32) -> u32;
    fn CreateFontW(h: i32, w: i32, e: i32, o: i32, wt: i32, i: u32, u: u32, s: u32, cs: u32, op: u32, cq: u32, pa: u32, name: *const u16) -> isize;
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
const TRANSPARENT: i32 = 1;
const FW_NORMAL: i32 = 400;
const DEFAULT_CHARSET: u32 = 0x86;
const DT_NOCLIP: u32 = 0x0100;
const DT_SINGLELINE: u32 = 0x0020;
const DT_VCENTER: u32 = 0x0004;
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

/* ---------------- 帧图 ---------------- */

struct Image {
    w: usize,
    h: usize,
    bgra: Vec<u32>, // 预乘 alpha，0xAARRGGBB
}

fn load_png(path: &std::path::Path) -> Option<Image> {
    let file = std::fs::File::open(path).ok()?;
    let decoder = png::Decoder::new(file);
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
    inverse: HashMap<String, Vec<Image>>,
    whale_states: HashMap<String, Image>,
}

fn load_frames(base: &std::path::Path) -> Frames {
    let mut f = Frames::default();
    let pets_root = base.join("ui").join("pets");
    if let Ok(txt) = std::fs::read_to_string(pets_root.join("frames.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            for mode in ["kurumi", "inverse"] {
                if let Some(rows) = v.get(mode).and_then(|m| m.get("rows")).and_then(|r| r.as_object()) {
                    for (row, files) in rows {
                        let mut imgs = Vec::new();
                        if let Some(arr) = files.as_array() {
                            for name in arr {
                                let p = pets_root.join(mode).join("frames").join(name.as_str().unwrap_or(""));
                                if let Some(img) = load_png(&p) {
                                    imgs.push(img);
                                }
                            }
                        }
                        if mode == "kurumi" {
                            f.kurumi.insert(row.clone(), imgs);
                        } else {
                            f.inverse.insert(row.clone(), imgs);
                        }
                    }
                }
            }
            if let Some(states) = v.get("whale").and_then(|m| m.get("states")).and_then(|s| s.as_object()) {
                for (s, name) in states {
                    let p = pets_root.join("whale").join(name.as_str().unwrap_or(""));
                    if let Some(img) = load_png(&p) {
                        f.whale_states.insert(s.clone(), img);
                    }
                }
            }
        }
    }
    f
}

/* ---------------- 窗口状态 ---------------- */

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
    bubble: Option<(String, std::time::Instant)>,
    press_pt: (i32, i32),
    dragged: bool,
    pos: (i32, i32),
}

fn default_pos() -> (i32, i32) {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let p = std::path::Path::new(&appdata).join("com.miasaki.desktop").join("pet.json");
        if let Ok(txt) = std::fs::read_to_string(p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                let x = v.get("x").and_then(|x| x.as_i64()).unwrap_or(1200) as i32;
                let y = v.get("y").and_then(|y| y.as_i64()).unwrap_or(500) as i32;
                if x > -10000 && y > -10000 {
                    return (x, y);
                }
            }
        }
    }
    (1200, 500)
}

fn save_pos(pos: (i32, i32)) {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let dir = std::path::Path::new(&appdata).join("com.miasaki.desktop");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(json) = serde_json::to_string(&serde_json::json!({ "x": pos.0, "y": pos.1 })) {
            let _ = std::fs::write(dir.join("pet.json"), json);
        }
    }
}

impl PetWin {
    fn compose(&mut self) {
        for p in self.buf.iter_mut() {
            *p = 0;
        }
        static TICKS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let tick = TICKS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let now = std::time::Instant::now();
        if now.duration_since(self.last_tick).as_millis() >= self.anim_ms as u128 {
            self.last_tick = now;
            let (mode, intensity) = {
                let s = self.shared.lock().unwrap();
                (s.mode.clone(), s.intensity.clone())
            };
            if mode == "whale" {
                let key = if intensity == "deep" {
                    "deep"
                } else if intensity == "work" {
                    "work"
                } else {
                    "idle"
                };
                self.anim_ms = 1000;
                let img_ptr = self.frames.whale_states.get(key).map(|i| i as *const Image);
                if let Some(ptr) = img_ptr {
                    let bob = if intensity == "idle" {
                        let phase = (std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() % 3200) as f32 / 1600.0 * std::f32::consts::PI;
                        phase.sin() * 3.0
                    } else {
                        0.0
                    };
                    // frames 加载后不可变：裸指针解引用安全
                    self.blit_center_bottom(unsafe { &*ptr }, bob);
                }
            } else {
                let row = if let Some(until) = self.hop_until {
                    if now < until {
                        "jump".to_string()
                    } else {
                        self.hop_until = None;
                        "idle".to_string()
                    }
                } else if intensity == "idle" {
                    "idle".to_string()
                } else {
                    "run".to_string()
                };
                let fps = match row.as_str() {
                    "run" => 10,
                    "jump" => 11,
                    _ => 8,
                };
                self.anim_ms = 1000 / fps;
                let pick = {
                    let map = if mode == "kurumi" { &self.frames.kurumi } else { &self.frames.inverse };
                    let list = map.get(&row).or_else(|| map.get("idle"));
                    match list {
                        Some(l) if !l.is_empty() => {
                            let idx = self.frame_idx % l.len();
                            self.frame_idx += 1;
                            Some((idx, row.clone()))
                        }
                        _ => None,
                    }
                };
                if let Some((idx, row_key)) = pick {
                    let map = if mode == "kurumi" { &self.frames.kurumi } else { &self.frames.inverse };
                    let ptr = map.get(&row_key).map(|l| l as *const Vec<Image>);
                    if let Some(ptr) = ptr {
                        let list = unsafe { &*ptr };
                        self.blit_center_bottom(&list[idx % list.len()], 0.0);
                    }
                }
            }
        }
        if let Some((text, _)) = self.bubble.clone() {
            if now.duration_since(self.bubble.as_ref().unwrap().1).as_secs() > 3 {
                self.bubble = None;
            } else {
                self.draw_bubble(&text);
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
        self.present();
    }

    fn blit_center_bottom(&mut self, img: &Image, bob: f32) {
        let h = CELL_H as i32;
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

    fn draw_bubble(&mut self, text: &str) {
        let bw = 170i32;
        let bh = 36i32;
        let bx = (WIN_W - bw) / 2;
        let by = WIN_H - CELL_H as i32 - 46;
        for y in 0..bh {
            for x in 0..bw {
                let dx = if x < 12 { 12 - x } else if x >= bw - 12 { x - (bw - 12) + 1 } else { 0 };
                let dy = if y < 12 { 12 - y } else if y >= bh - 12 { y - (bh - 12) + 1 } else { 0 };
                if dx * dx + dy * dy > 144 {
                    continue;
                }
                let px = (bx + x) as usize;
                let py = (by + y) as usize;
                if px < WIN_W as usize && py < WIN_H as usize {
                    self.buf[py * WIN_W as usize + px] = (215 << 24) | (0x26 << 16) | (0x20 << 8) | 0x2C;
                }
            }
        }
        self.draw_text(text, bx + 14, by + 7);
    }

    fn draw_text(&mut self, text: &str, x0: i32, y0: i32) {
        unsafe {
            let w = 200i32;
            let h = 26i32;
            let dc = CreateCompatibleDC(0);
            let bmi = BmiHeader {
                size: 44,
                width: w,
                height: -h,
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
            SelectObject(dc, dib);
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, 0x00E4DEF0);
            let font_name: Vec<u16> = "Microsoft YaHei\0".encode_utf16().collect();
            let font = CreateFontW(-15, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, 0, font_name.as_ptr());
            SelectObject(dc, font);
            let t: Vec<u16> = text.encode_utf16().collect();
            let mut rect = Rect { left: 0, top: 0, right: w, bottom: h };
            DrawTextW(dc, t.as_ptr(), t.len() as i32, &mut rect, DT_NOCLIP | DT_SINGLELINE | DT_VCENTER);
            let px = bits as *const u32;
            for y in 0..h {
                for x in 0..w {
                    let c = *px.offset((y * w + x) as isize);
                    let a = (c >> 24) & 0xFF;
                    if a == 0 {
                        continue;
                    }
                    let dx = x0 + x;
                    let dy = y0 + y;
                    if dx >= 0 && dy >= 0 && dx < WIN_W && dy < WIN_H {
                        let dst = self.buf[(dy * WIN_W + dx) as usize];
                        let dr = (dst >> 16) & 0xFF;
                        let dg = (dst >> 8) & 0xFF;
                        let db = dst & 0xFF;
                        let dsta = (dst >> 24) & 0xFF;
                        let r = (((c >> 16) & 0xFF) * a / 255) + dr * (255 - a) / 255;
                        let g = (((c >> 8) & 0xFF) * a / 255) + dg * (255 - a) / 255;
                        let b = ((c & 0xFF) * a / 255) + db * (255 - a) / 255;
                        let oa = a + dsta * (255 - a) / 255;
                        self.buf[(dy * WIN_W + dx) as usize] = (oa << 24) | (r << 16) | (g << 8) | b;
                    }
                }
            }
            DeleteObject(font);
            DeleteObject(dib);
            DeleteDC(dc);
        }
    }

    fn present(&self) {
        unsafe {
            let dc = CreateCompatibleDC(0);
            let bmi = BmiHeader {
                size: 44,
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
            SelectObject(dc, dib);
            std::ptr::copy_nonoverlapping(self.buf.as_ptr(), bits as *mut u32, self.buf.len());
            let mut pt = Point { x: self.pos.0, y: self.pos.1 };
            let mut sz = Size { cx: WIN_W, cy: WIN_H };
            let mut src = Point { x: 0, y: 0 };
            let blend = BlendFn { blend_op: 1, blend_flags: 0, src_alpha: 255, alpha_format: 1 };
            let ok = UpdateLayeredWindow(self.hwnd, 0, &mut pt, &mut sz, dc, &mut src, 0, &blend, ULW_ALPHA);
            if ok == 0 {
                pet_log_line(&format!("[native-pet] ULW failed, GetLastError={}\n", GetLastError()));
            }
            DeleteObject(dib);
            DeleteDC(dc);
        }
    }

    fn do_hop(&mut self) {
        self.hop_until = Some(std::time::Instant::now() + std::time::Duration::from_millis(900));
        self.frame_idx = 0;
        self.last_tick = std::time::Instant::now() - std::time::Duration::from_secs(10);
        let quote = {
            let s = self.shared.lock().unwrap();
            let pool: &[&str] = match s.mode.as_str() {
                "kurumi" => &["ふふふ…", "啊啦，你来了呢", "时间，可是很宝贵的哦", "刻刻帝在看着你"],
                "inverse" => &["选好了吗？", "别让我等太久", "（冷笑）", "你的时间，归我支配"],
                _ => &["咕噜咕噜…", "（吐泡泡）", "呜~ 我在听", "（摇尾巴）"],
            };
            pool[(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as usize) % pool.len()].to_string()
        };
        self.bubble = Some((quote, std::time::Instant::now()));
    }

    fn show_menu(&self, x: i32, y: i32) {
        unsafe {
            let enc = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
            let m = CreatePopupMenu();
            let s1 = enc("隐藏桌宠");
            let s2 = enc("最小化主窗口");
            let s3 = enc("退出应用");
            AppendMenuW(m, MF_STRING, MENU_HIDE, s1.as_ptr());
            AppendMenuW(m, MF_STRING, MENU_MIN, s2.as_ptr());
            AppendMenuW(m, MF_STRING, MENU_EXIT, s3.as_ptr());
            SetForegroundWindow(self.hwnd);
            let cmd = TrackPopupMenu(m, TPM_RETURNCMD | TPM_RIGHTBUTTON, x, y, 0, self.hwnd, 0);
            DestroyMenu(m);
            match cmd as usize {
                MENU_HIDE => self.hide_self(),
                MENU_MIN => {
                    if let Some(w) = self.app.get_webview_window("main") {
                        let _ = w.minimize();
                    }
                }
                MENU_EXIT => self.app.exit(0),
                _ => {}
            }
        }
    }

    fn hide_self(&self) {
        unsafe {
            ShowWindow(self.hwnd, SW_HIDE);
            ShowWindow(self.dot_hwnd, SW_SHOW);
        }
        if let Ok(mut s) = self.shared.lock() {
            s.hide = true;
        }
    }

    fn show_self(&self) {
        unsafe {
            ShowWindow(self.dot_hwnd, SW_HIDE);
            ShowWindow(self.hwnd, SW_SHOW);
        }
        if let Ok(mut s) = self.shared.lock() {
            s.hide = false;
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
            } else {
                save_pos((*pet).pos);
            }
            0
        }
        WM_LBUTTONDBLCLK => {
            (*pet).do_hop();
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
        let bmi = BmiHeader {
            size: 44,
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
        SelectObject(dc, dib);
        std::ptr::copy_nonoverlapping(buf.as_ptr(), bits as *mut u32, buf.len());
        let mut pt = Point { x: pos.0, y: pos.1 };
        let mut sz = Size { cx: DOT_SIZE, cy: DOT_SIZE };
        let mut src = Point { x: 0, y: 0 };
        let blend = BlendFn { blend_op: 1, blend_flags: 0, src_alpha: 255, alpha_format: 1 };
        UpdateLayeredWindow(dot_hwnd, 0, &mut pt, &mut sz, dc, &mut src, 0, &blend, ULW_ALPHA);
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
        let (x, y) = default_pos();
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
            bubble: None,
            press_pt: (0, 0),
            dragged: false,
            pos: (x, y),
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

        {
            let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
            GetWindowRect(hwnd, &mut r);
            pet_log_line(&format!("[native-pet] window created at {},{}, {}x{}\n", r.left, r.top, r.right - r.left, r.bottom - r.top));
        }

        draw_dot(dot_hwnd, (x, y));
        pet.compose();
        pet_log_line("[native-pet] first compose done\n");
        ShowWindow(hwnd, SW_SHOW);
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
        let shared = Arc::new(Mutex::new(PetShared {
            mode: "whale".to_string(),
            intensity: "idle".to_string(),
            hide: false,
        }));
        let base = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_default();
        let frames = load_frames(&base);
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
        if let Ok(mut s) = self.shared.lock() {
            s.mode = mode.to_string();
        }
    }

    pub fn set_intensity(&self, int: &str) {
        if let Ok(mut s) = self.shared.lock() {
            s.intensity = int.to_string();
        }
    }
}
