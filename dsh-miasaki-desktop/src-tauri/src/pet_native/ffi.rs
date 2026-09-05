//! Win32 FFI：user32/gdi32 裸声明 + LCG 随机数（D2 拆分）
use std::os::raw::c_void;
/* ---------------- Win32 FFI（user32/gdi32） ---------------- */

pub(crate) type WndProc = unsafe extern "system" fn(isize, u32, usize, isize) -> isize;

#[repr(C)]
pub(crate) struct WndClassW {
    pub(crate) style: u32,
    pub(crate) lpfn: Option<WndProc>,
    pub(crate) cb_cls_extra: i32,
    pub(crate) cb_wnd_extra: i32,
    pub(crate) instance: isize,
    pub(crate) icon: isize,
    pub(crate) cursor: isize,
    pub(crate) background: isize,
    pub(crate) menu_name: *const u16,
    pub(crate) class_name: *const u16,
}

#[repr(C)]
pub(crate) struct Point {
    pub(crate) x: i32,
    pub(crate) y: i32,
}

#[repr(C)]
pub(crate) struct Size {
    pub(crate) cx: i32,
    pub(crate) cy: i32,
}

#[repr(C)]
pub(crate) struct Rect {
    pub(crate) left: i32,
    pub(crate) top: i32,
    pub(crate) right: i32,
    pub(crate) bottom: i32,
}

/// MONITORINFO（GetMonitorInfoW 输出；rcWork = 工作区，含任务栏偏移）。
#[repr(C)]
pub(crate) struct MonitorInfo {
    pub(crate) cb_size: u32,
    pub(crate) rc_monitor: Rect,
    pub(crate) rc_work: Rect,
    pub(crate) dw_flags: u32,
}

#[repr(C)]
pub(crate) struct Msg {
    pub(crate) hwnd: isize,
    pub(crate) message: u32,
    pub(crate) wparam: usize,
    pub(crate) lparam: isize,
    pub(crate) time: u32,
    pub(crate) pt: Point,
    pub(crate) lprivate: u32,
}

#[repr(C)]
pub(crate) struct BlendFn {
    pub(crate) blend_op: u8,
    pub(crate) blend_flags: u8,
    pub(crate) src_alpha: u8,
    pub(crate) alpha_format: u8,
}

#[repr(C)]
pub(crate) struct BmiHeader {
    pub(crate) size: u32,
    pub(crate) width: i32,
    pub(crate) height: i32,
    pub(crate) planes: u16,
    pub(crate) bit_count: u16,
    pub(crate) compression: u32,
    pub(crate) size_image: u32,
    pub(crate) x_ppm: i32,
    pub(crate) y_ppm: i32,
    pub(crate) clr_used: u32,
    pub(crate) clr_important: u32,
}

#[link(name = "user32")]
extern "system" {
    pub(crate) fn RegisterClassW(c: *const WndClassW) -> u16;
    pub(crate) fn SetProcessDpiAwarenessContext(v: isize) -> i32;
    pub(crate) fn GetLastError() -> u32;
    pub(crate) fn CreateWindowExW(
        ex: u32, cls: *const u16, name: *const u16, style: u32,
        x: i32, y: i32, w: i32, h: i32,
        parent: isize, menu: isize, inst: isize, param: *mut c_void,
    ) -> isize;
    pub(crate) fn ShowWindow(h: isize, c: i32) -> i32;
    pub(crate) fn UpdateLayeredWindow(
        h: isize, dc_dst: isize, ppt_dst: *const Point, psize: *const Size,
        dc_src: isize, ppt_src: *const Point, key: u32, blend: *const BlendFn, flags: u32,
    ) -> i32;
    pub(crate) fn GetMessageW(m: *mut Msg, h: isize, min: u32, max: u32) -> i32;
    pub(crate) fn TranslateMessage(m: *const Msg) -> i32;
    pub(crate) fn DispatchMessageW(m: *const Msg) -> isize;
    pub(crate) fn DefWindowProcW(h: isize, m: u32, w: usize, l: isize) -> isize;
    pub(crate) fn GetWindowLongPtrW(h: isize, i: i32) -> isize;
    pub(crate) fn SetWindowLongPtrW(h: isize, i: i32, v: isize) -> isize;
    pub(crate) fn GetCursorPos(p: *mut Point) -> i32;
    pub(crate) fn MoveWindow(h: isize, x: i32, y: i32, w: i32, ht: i32, repaint: i32) -> i32;
    pub(crate) fn GetWindowRect(h: isize, r: *mut Rect) -> i32;
    pub(crate) fn GetSystemMetrics(idx: i32) -> i32;
    pub(crate) fn SetTimer(h: isize, id: usize, ms: u32, cb: usize) -> usize;
    pub(crate) fn PostQuitMessage(c: i32);
    pub(crate) fn EnumDisplayMonitors(
        hdc: isize,
        clip: *const Rect,
        cb: unsafe extern "system" fn(isize, isize, *mut Rect, isize) -> i32,
        data: isize,
    ) -> i32;
    pub(crate) fn GetMonitorInfoW(mon: isize, info: *mut MonitorInfo) -> i32;
    pub(crate) fn CreatePopupMenu() -> isize;
    pub(crate) fn AppendMenuW(menu: isize, flags: u32, id: usize, item: *const u16) -> i32;
    pub(crate) fn TrackPopupMenu(menu: isize, flags: u32, x: i32, y: i32, rsv: i32, h: isize, rect: usize) -> i32;
    pub(crate) fn DestroyMenu(menu: isize) -> i32;
    pub(crate) fn SetForegroundWindow(h: isize) -> i32;
    pub(crate) fn GetModuleHandleW(n: *const u16) -> isize;
}

#[link(name = "gdi32")]
extern "system" {
    pub(crate) fn CreateCompatibleDC(h: isize) -> isize;
    pub(crate) fn DeleteDC(h: isize) -> i32;
    pub(crate) fn DeleteObject(o: isize) -> i32;
    pub(crate) fn SelectObject(dc: isize, o: isize) -> isize;
    pub(crate) fn CreateDIBSection(h: isize, bmi: *const BmiHeader, usage: u32, bits: *mut *mut c_void, section: isize, offset: u32) -> isize;
}

pub(crate) const WS_POPUP: u32 = 0x8000_0000;
pub(crate) const WS_EX_LAYERED: u32 = 0x0008_0000;
pub(crate) const WS_EX_TOPMOST: u32 = 0x0000_0008;
pub(crate) const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
pub(crate) const CS_HREDRAW: u32 = 0x0002;
pub(crate) const CS_VREDRAW: u32 = 0x0001;
pub(crate) const GWLP_USERDATA: i32 = -21;
pub(crate) const SW_SHOW: i32 = 5;
pub(crate) const SW_HIDE: i32 = 0;
pub(crate) const ULW_ALPHA: u32 = 0x02;
pub(crate) const DIB_RGB_COLORS: u32 = 0;
pub(crate) const MF_STRING: u32 = 0;
pub(crate) const TPM_RETURNCMD: u32 = 0x0100;
pub(crate) const TPM_RIGHTBUTTON: u32 = 0x0002;
pub(crate) const WM_CREATE: u32 = 0x0001;
pub(crate) const WM_DESTROY: u32 = 0x0002;
pub(crate) const WM_TIMER: u32 = 0x0113;
pub(crate) const WM_LBUTTONDOWN: u32 = 0x0201;
pub(crate) const WM_LBUTTONUP: u32 = 0x0202;
pub(crate) const WM_LBUTTONDBLCLK: u32 = 0x0203;
pub(crate) const WM_RBUTTONDOWN: u32 = 0x0204;
pub(crate) const WM_MOUSEMOVE: u32 = 0x0200;
pub(crate) const MK_LBUTTON: usize = 0x0001;
pub(crate) const MENU_HIDE: usize = 101;
pub(crate) const MENU_MIN: usize = 102;
pub(crate) const MENU_EXIT: usize = 103;
pub(crate) const MENU_SHOW: usize = 104;
pub(crate) const SM_CXSCREEN: i32 = 0;
pub(crate) const SM_CYSCREEN: i32 = 1;

/* ---------------- 随机数（LCG，无外部依赖） ---------------- */

pub(crate) fn rand_u32() -> u32 {
    static S: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0x9E37_79B9);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let x = S.fetch_add(0x9E37_79B9, std::sync::atomic::Ordering::SeqCst) ^ t;
    x.wrapping_mul(0x85EB_CA6B).wrapping_add(0xC2B2_AE35)
}

pub(crate) fn rand_range(lo: u64, hi: u64) -> u64 {
    lo + (rand_u32() as u64) % (hi - lo)
}

pub(crate) fn screen_size() -> (i32, i32) {
    unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) }
}
