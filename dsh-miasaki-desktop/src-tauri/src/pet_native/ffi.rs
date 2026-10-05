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

/// M4.1（2026-10-05）：加 `Copy` —— 它是 `#[repr(C)]` 的四个 `i32`、无堆无指针，
/// 语义上就是值类型；而 M4.1 的吸附判定要按值传 `work`（几何运算全部只读它）。
/// 不加则复用同一个 `work` 会报 `use of moved value`（该错误在 harness 里先暴露过）。
#[repr(C)]
#[derive(Clone, Copy)]
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
    /// DPI(2026-10-05)：取窗口所在显示器的 DPI，基址 96 = 100% 缩放。
    /// **Win10 1607+ 才有**。本仓最低目标 Win10 1803+（`update.rs` 的 `curl.exe` 依赖同一档），
    /// 直接用它，不必走 `GetDeviceCaps` 的设备上下文分支。
    /// 无效 hwnd 返回 0 ⇒ 调方必须回落（`model::dpi_scale` 已按此设计，见其注释①）。
    pub(crate) fn GetDpiForWindow(h: isize) -> u32;
    pub(crate) fn GetSystemMetrics(idx: i32) -> i32;
    pub(crate) fn SetTimer(h: isize, id: usize, ms: u32, cb: usize) -> usize;
    pub(crate) fn KillTimer(h: isize, id: usize) -> i32;
    pub(crate) fn PostQuitMessage(c: i32);
    pub(crate) fn EnumDisplayMonitors(
        hdc: isize,
        clip: *const Rect,
        cb: unsafe extern "system" fn(isize, isize, *mut Rect, isize) -> i32,
        data: isize,
    ) -> i32;
    pub(crate) fn GetMonitorInfoW(mon: isize, info: *mut MonitorInfo) -> i32;
    /// DPI(2026-10-05)：取**指定点所在显示器**的 DPI —— 建窗前就要用（`buf` 分配与
    /// `CreateWindowExW` 的尺寸都得先知道 DPI，而 `GetDpiForWindow` 要 hwnd ⇒ 循环依赖）。
    /// `MonitorFromPoint` 属 user32；`GetDpiForMonitor` 属 **shcore**（Win8.1+）。
    /// 取不到时回落 96（100%），由 `model::dpi_scale` 兜住。
    pub(crate) fn MonitorFromPoint(p: Point, flags: u32) -> isize;
    pub(crate) fn CreatePopupMenu() -> isize;
    pub(crate) fn AppendMenuW(menu: isize, flags: u32, id: usize, item: *const u16) -> i32;
    pub(crate) fn TrackPopupMenu(menu: isize, flags: u32, x: i32, y: i32, rsv: i32, h: isize, rect: usize) -> i32;
    pub(crate) fn DestroyMenu(menu: isize) -> i32;
    pub(crate) fn SetForegroundWindow(h: isize) -> i32;
    pub(crate) fn GetForegroundWindow() -> isize;
    pub(crate) fn PostMessageW(h: isize, m: u32, w: usize, l: isize) -> i32;
    pub(crate) fn GetModuleHandleW(n: *const u16) -> isize;
}

// DPI(2026-10-05)：`GetDpiForMonitor` 在 **shcore.dll**（Win8.1+），不在 user32。
// `MDT_EFFECTIVE_DPI = 0`。**与 `GetDpiForWindow` 的区别**：本 API 在建窗前即可用
// （`MonitorFromPoint` 给显示器句柄），而后者要 hwnd —— 冷启动的尺寸分配正需要前者。
// 取不到时返回非 0（S_OK = 0），调用方回落 96。
// 注：此处刻意用 `//` 而非 `///` —— rustdoc 不为 `extern` 块生成文档，会报 unused_doc_comments。
#[link(name = "shcore")]
extern "system" {
    pub(crate) fn GetDpiForMonitor(mon: isize, t: i32, dpi_x: *mut u32, dpi_y: *mut u32) -> i32;
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
/// R1(2026-09-16，design/pet-reference-benchmark.md R1)：**不接收激活**——点击桌宠不再
/// 把前台与键盘焦点夺走。参考实现记录该缺陷会让用户随后的 Ctrl+C/V「整机失效」
/// （键盘输入全落到桌宠窗口，点回原窗口才恢复；其 issue #98）。
/// 只改扩展样式位、不重建原生窗口；鼠标与键盘消息照常送达（点击/拖动/双击不受影响）。
pub(crate) const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
/// R2(2026-09-16)：命中测试判定为透明像素时置位，让鼠标穿透到下层窗口。
/// `HTTRANSPARENT` 只能继续命中同线程窗口、无法穿透到其它应用，故必须用该扩展样式位。
/// 注意：置位后本窗口**收不到鼠标消息**，恢复只能靠独立定时器轮询光标位置。
pub(crate) const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
/// Get/SetWindowLongPtrW 的扩展样式索引（64 位下必须用 Ptr 版本）。
pub(crate) const GWL_EXSTYLE: i32 = -20;
pub(crate) const CS_HREDRAW: u32 = 0x0002;
pub(crate) const CS_VREDRAW: u32 = 0x0001;
pub(crate) const CS_DBLCLKS: u32 = 0x0008;
pub(crate) const GWLP_USERDATA: i32 = -21;
pub(crate) const SW_SHOW: i32 = 5;
pub(crate) const SW_HIDE: i32 = 0;
pub(crate) const ULW_ALPHA: u32 = 0x02;
pub(crate) const DIB_RGB_COLORS: u32 = 0;
pub(crate) const MF_STRING: u32 = 0;
pub(crate) const TPM_RETURNCMD: u32 = 0x0100;
pub(crate) const TPM_RIGHTBUTTON: u32 = 0x0002;
pub(crate) const WM_CREATE: u32 = 0x0001;
pub(crate) const WM_NULL: u32 = 0x0000;
pub(crate) const WM_DESTROY: u32 = 0x0002;
pub(crate) const WM_TIMER: u32 = 0x0113;
pub(crate) const WM_LBUTTONDOWN: u32 = 0x0201;
pub(crate) const WM_LBUTTONUP: u32 = 0x0202;
pub(crate) const WM_LBUTTONDBLCLK: u32 = 0x0203;
pub(crate) const WM_RBUTTONDOWN: u32 = 0x0204;
pub(crate) const WM_MOUSEMOVE: u32 = 0x0200;
/// DPI(2026-10-05)：窗口跨越到不同缩放的显示器时系统发此消息。
/// `wParam` 低 16 位 = 新 DPI（高 16 位 = 原 DPI），`lParam` = 建议的窗口矩形（物理像素）。
/// **本仓必须处理它的原因不是「跨屏错位」而是「尺寸需随 DPI 重算」**：
/// PMv2 下窗口物理尺寸 = 逻辑尺寸，素材位图恒为 `WIN_W`×`WIN_H`，
/// 不跟随新 DPI 重建窗口与 DIB 就会一直是「素材原尺寸 / 屏幕倍率」的错配。
/// 实测（`_refs/dpi-probe/`，2026-10-05）：200% 屏上不缩放 ⇒ 桌宠只有应有逻辑尺寸的 50%。
pub(crate) const WM_DPICHANGED: u32 = 0x02E0;
pub(crate) const MK_LBUTTON: usize = 0x0001;
pub(crate) const MENU_HIDE: usize = 101;
pub(crate) const MENU_MIN: usize = 102;
pub(crate) const MENU_EXIT: usize = 103;
pub(crate) const MENU_SHOW: usize = 104;
pub(crate) const SM_CXSCREEN: i32 = 0;
pub(crate) const SM_CYSCREEN: i32 = 1;
/// `MonitorFromPoint` 的标志：取最近的显示器（点落在所有显示器之外时的兜底）。
pub(crate) const MONITOR_DEFAULTTONEAREST: u32 = 2;
/// `GetDpiForMonitor` 的类型：实际生效 DPI（Win8.1+ 唯一定义值 0）。
pub(crate) const MDT_EFFECTIVE_DPI: i32 = 0;

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
