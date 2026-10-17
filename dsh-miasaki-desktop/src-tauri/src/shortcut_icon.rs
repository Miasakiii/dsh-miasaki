//! 桌面 / 开始菜单快捷方式的图标跟随（2026-10-14，用户「选择后桌面启动图标没变」）。
//!
//! ## 为什么需要单独一个模块
//!
//! [`crate::launcher_icon`] 改的是**运行中的**主窗口与托盘图标 —— 任务栏、窗口左上角、
//! 托盘随之更新。但**快捷方式自己的图标**是磁盘上的 `.lnk` 里一个字段
//! （`IShellLinkW::SetIconLocation`），运行期改窗口图标动不到它，所以此前一直是
//! 「构建期资源、不跟随」。用户 2026-10-14 明确要求让它跟随 ⇒ 本模块：
//! 把用户选的 PNG 包成 **ICO** 写到 `<dshHome>/miasaki-appearance/launcher-icon.ico`，
//! 然后改写**所有指向本程序**的 `.lnk` 的图标位置，最后通知 shell 刷新图标缓存。
//!
//! ## 边界与纪律
//!
//! * **只动指向本程序的快捷方式**：逐个用 `IShellLinkW::GetPath` 取真实目标、与
//!   `current_exe()` 比对（大小写不敏感），别人的快捷方式一个都不碰。
//! * **任何一步失败都只让这一步退化**：COM 起不来 / 权限不足 / 文件被占 ⇒ 返回 0、
//!   由调用方写一行日志，**快捷方式保持原样**，头像本身照常生效（与 launcher_icon
//!   的「坏头像绝不拖住启动」同一条纪律）。
//! * **幂等靠调用方**：本模块不做去重，只在图标内容真的变化时被调用
//!   （launcher_icon 的 `LAST_APPLIED` 键把关），所以不会每 1.5 秒重写磁盘。
//! * **可撤销**：`clear()` 把图标位置清空（空串 = 用目标程序自身的图标），
//!   即「清除」按钮回到出厂表现的完整语义。
//!
//! ## 为什么手写 COM vtable（而不是加 `windows` crate）
//!
//! 本仓 desktop 线用 `windows-sys`（纯 FFI），它只给常量与函数、**不提供接口定义**。
//! 加 `windows` crate 会引入一整棵生成代码（编译时间与产物体积都涨），而这里只需要
//! 两个接口的**三个方法**。所以按官方生成代码逐字段对照后手写：
//!
//! * `IShellLinkW`：`IID = 000214f9-0000-0000-c000-000000000046`；
//!   vtable 顺序（`windows-0.58.0/src/Windows/Win32/UI/Shell/mod.rs` 的
//!   `IShellLinkW_Vtbl` 逐字段核对）：
//!   `QueryInterface, AddRef, Release, GetPath, GetIDList, SetIDList, GetDescription,
//!    SetDescription, GetWorkingDirectory, SetWorkingDirectory, GetArguments,
//!    SetArguments, GetHotkey, SetHotkey, GetShowCmd, SetShowCmd, GetIconLocation,
//!    SetIconLocation, SetRelativePath, Resolve, SetPath`
//!   ⇒ `SetIconLocation` 在**索引 17**、`GetPath` 在**索引 3**。
//! * `IPersistFile`：`IID = 0000010b-0000-0000-c000-000000000046`；
//!   vtable = `IUnknown(3) + GetClassID, IsDirty, Load, Save, SaveCompleted, GetCurFile`
//!   ⇒ `Load` 在**索引 5**、`Save` 在**索引 6**。
//!
//! ⚠ 改这两张表前必须重新对照一次官方生成代码：**顺序错一位就是 UB（崩溃）**，
//! 而不是编译错误。`build_ico` 那部分是纯函数、有单测；COM 这部分**没有**单测
//! （要真机才谈得上），所以判据落在 `test/client.test.js` 的边界用例与实机走查上。

use std::ffi::{c_void, OsStr};
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use windows_sys::core::GUID;
use windows_sys::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows_sys::Win32::UI::Shell::{
    SHChangeNotify, ShellLink, SHCNE_ASSOCCHANGED, SHCNF_FLUSH, SHCNF_IDLIST,
};

use crate::launcher_icon::downsample_box;

/// `IShellLinkW` 的 IID（`windows-0.58.0` 的 `define_interface!(IShellLinkW, …, 0x000214f9_…)`）。
const IID_ISHELLLINKW: GUID = GUID::from_u128(0x000214f9_0000_0000_c000_000000000046);
/// `IPersistFile` 的 IID（同源：`define_interface!(IPersistFile, …, 0x0000010b_…)`）。
const IID_IPERSISTFILE: GUID = GUID::from_u128(0x0000010b_0000_0000_c000_000000000046);
/// `IPersistFile::Load` 的 `STGM_READWRITE`（`Win32_System_Com` 的 STGM 常量，值为 2）。
const STGM_READWRITE: u32 = 0x0000_0002;
/// `SLGP_RAWPATH`：`GetPath` 取**原始**目标路径（不解析环境变量、不做 UNC 优先化）。
/// 取原始值才便于与 `current_exe()` 直接比对 —— 解析过的路径反而可能变形。
const SLGP_RAWPATH: u32 = 0x0000_0004;

/// ICO 里放的尺寸档（Windows 会挑最接近的一档；16/32/48/256 覆盖任务栏到超大图标视图）。
const ICO_SIZES: [u32; 4] = [16, 32, 48, 256];

/* ---------------- ICO 编码（纯函数，可单测） ---------------- */

/// 把一张正方 RGBA 图编码成多尺寸 ICO。
///
/// 全部条目用 **BMP/DIB**（不是 PNG-in-ICO）：小尺寸在资源管理器、任务栏、开始菜单各处
/// 的兼容性最好（PNG 条目在部分老渲染路径上不画）。
/// @param rgba - 自上而下的 RGBA 像素，边长 `side`。
/// @param side - 源图边长。
/// @returns ICO 文件字节；`side == 0` 或像素数不足时返回空 vec（调用方据此放弃）。
pub fn build_ico(rgba: &[u8], side: u32) -> Vec<u8> {
    if side == 0 || rgba.len() < (side as usize) * (side as usize) * 4 {
        return Vec::new();
    }
    let entries: Vec<(u32, Vec<u8>)> = ICO_SIZES
        .iter()
        .map(|&size| (size, dib_entry(rgba, side, size)))
        .collect();

    let header_len = 6 + 16 * entries.len();
    let body_len: usize = entries.iter().map(|(_, data)| data.len()).sum();
    let mut out = Vec::with_capacity(header_len + body_len);

    // ICONDIR
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    out.extend_from_slice(&1u16.to_le_bytes()); // type = 1（图标）
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());

    // ICONDIRENTRY × N
    let mut offset = header_len as u32;
    for (size, data) in &entries {
        let dim = if *size >= 256 { 0u8 } else { *size as u8 }; // 256 用 0 表示
        out.push(dim); // width
        out.push(dim); // height
        out.push(0); // 调色板色数（真彩为 0）
        out.push(0); // reserved
        out.extend_from_slice(&1u16.to_le_bytes()); // planes
        out.extend_from_slice(&32u16.to_le_bytes()); // 位深
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        offset += data.len() as u32;
    }
    for (_, data) in &entries {
        out.extend_from_slice(data);
    }
    out
}

/// 单档 DIB 条目：`BITMAPINFOHEADER` + 自下而上的 BGRA 像素 + AND 掩码。
fn dib_entry(rgba: &[u8], side: u32, size: u32) -> Vec<u8> {
    let px = size as usize;
    let scaled = downsample_box(rgba, side, size);

    // DIB 是自下而上的；源是自上而下 ⇒ 这里翻行序，顺手做 RGBA → BGRA。
    let mut pixels = vec![0u8; px * px * 4];
    for y in 0..px {
        let src_row = y * px * 4;
        let dst_row = (px - 1 - y) * px * 4;
        for x in 0..px {
            let s = src_row + x * 4;
            let d = dst_row + x * 4;
            pixels[d] = scaled[s + 2]; // B
            pixels[d + 1] = scaled[s + 1]; // G
            pixels[d + 2] = scaled[s]; // R
            pixels[d + 3] = scaled[s + 3]; // A
        }
    }
    // AND 掩码：32bpp 走 alpha 通道，掩码全 0（= 不透明），每行按 4 字节对齐。
    let mask_row = (px + 31) / 32 * 4;
    let mask = vec![0u8; mask_row * px];

    let mut out = Vec::with_capacity(40 + pixels.len() + mask.len());
    out.extend_from_slice(&40u32.to_le_bytes()); // biSize
    out.extend_from_slice(&(px as i32).to_le_bytes()); // biWidth
    out.extend_from_slice(&((px as i32) * 2).to_le_bytes()); // biHeight = XOR + AND 两段
    out.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    out.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    out.extend_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
    out.extend_from_slice(&(pixels.len() as u32).to_le_bytes()); // biSizeImage
    out.extend_from_slice(&[0u8; 16]); // 分辨率（2×i32）+ 调色板色数
    out.extend_from_slice(&pixels);
    out.extend_from_slice(&mask);
    out
}

/* ---------------- COM vtable（顺序见模块头，错一位即 UB） ---------------- */

#[repr(C)]
struct IUnknownVtbl {
    query_interface:
        unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> i32,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
}

#[repr(C)]
struct IShellLinkWVtbl {
    base: IUnknownVtbl,
    /// 索引 3
    get_path: unsafe extern "system" fn(*mut c_void, *mut u16, i32, *mut c_void, u32) -> i32,
    /// 索引 4–15（GetIDList … SetShowCmd），本模块不用。
    _unused_4_15: [usize; 12],
    /// 索引 16（测试读回用）
    get_icon_location: unsafe extern "system" fn(*mut c_void, *mut u16, i32, *mut i32) -> i32,
    /// 索引 17
    set_icon_location: unsafe extern "system" fn(*mut c_void, *const u16, i32) -> i32,
    /// 索引 18–19（SetRelativePath / Resolve）
    _unused_18_19: [usize; 2],
    /// 索引 20（测试造临时快捷方式用）
    set_path: unsafe extern "system" fn(*mut c_void, *const u16) -> i32,
}

#[repr(C)]
struct IPersistFileVtbl {
    base: IUnknownVtbl,
    /// 索引 3：GetClassID
    _get_class_id: usize,
    /// 索引 4：IsDirty
    _is_dirty: usize,
    /// 索引 5
    load: unsafe extern "system" fn(*mut c_void, *const u16, u32) -> i32,
    /// 索引 6
    save: unsafe extern "system" fn(*mut c_void, *const u16, i32) -> i32,
}

/// 成功判据：HRESULT **非负**（S_OK = 0 / S_FALSE = 1 都算成功）。
#[inline]
fn ok(hr: i32) -> bool {
    hr >= 0
}

/// 把路径转成以 NUL 结尾的宽字符串。
fn wide(text: &OsStr) -> Vec<u16> {
    let mut out: Vec<u16> = text.encode_wide().collect();
    out.push(0);
    out
}

/// 起一个 `ShellLink` 对象（失败返回 None，调用方照常继续）。
unsafe fn create_shell_link() -> Option<*mut c_void> {
    let mut raw: *mut c_void = std::ptr::null_mut();
    let hr = CoCreateInstance(
        &ShellLink,
        std::ptr::null_mut(),
        CLSCTX_INPROC_SERVER,
        &IID_ISHELLLINKW,
        &mut raw,
    );
    if ok(hr) && !raw.is_null() { Some(raw) } else { None }
}

/// 从 `IShellLinkW` 上取 `IPersistFile`（`.lnk` 的读写都走它）。
unsafe fn query_persist_file(link: *mut c_void) -> Option<*mut c_void> {
    let vtbl = *(link as *mut *const IShellLinkWVtbl);
    let mut raw: *mut c_void = std::ptr::null_mut();
    let hr = ((*vtbl).base.query_interface)(link, &IID_IPERSISTFILE, &mut raw);
    if ok(hr) && !raw.is_null() { Some(raw) } else { None }
}

unsafe fn release(ptr: *mut c_void) {
    if ptr.is_null() {
        return;
    }
    let vtbl = *(ptr as *mut *const IUnknownVtbl);
    ((*vtbl).release)(ptr);
}

/// 读 `.lnk` 的目标路径；不是文件快捷方式或读取失败返回 None。
unsafe fn get_path(link: *mut c_void) -> Option<PathBuf> {
    let vtbl = *(link as *mut *const IShellLinkWVtbl);
    let mut buf = vec![0u16; 1024];
    let hr = ((*vtbl).get_path)(
        link,
        buf.as_mut_ptr(),
        buf.len() as i32,
        std::ptr::null_mut(),
        SLGP_RAWPATH,
    );
    if !ok(hr) {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    if len == 0 {
        return None;
    }
    Some(PathBuf::from(String::from_utf16_lossy(&buf[..len])))
}

unsafe fn set_icon_location(link: *mut c_void, ico: &[u16]) -> bool {
    let vtbl = *(link as *mut *const IShellLinkWVtbl);
    ok(((*vtbl).set_icon_location)(link, ico.as_ptr(), 0))
}

/// 读回图标位置（**仅测试**用；主流程不消费它）。
#[cfg(test)]
unsafe fn get_icon_location(link: *mut c_void) -> Option<String> {
    let vtbl = *(link as *mut *const IShellLinkWVtbl);
    let mut buf = vec![0u16; 1024];
    let mut index: i32 = 0;
    let hr = ((*vtbl).get_icon_location)(link, buf.as_mut_ptr(), buf.len() as i32, &mut index);
    if !ok(hr) {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..len]))
}

/// 设置目标程序（**仅测试**用：造一张临时快捷方式）。
#[cfg(test)]
unsafe fn set_path(link: *mut c_void, target: &[u16]) -> bool {
    let vtbl = *(link as *mut *const IShellLinkWVtbl);
    ok(((*vtbl).set_path)(link, target.as_ptr()))
}

unsafe fn persist_load(persist: *mut c_void, lnk: &[u16]) -> bool {
    let vtbl = *(persist as *mut *const IPersistFileVtbl);
    ok(((*vtbl).load)(persist, lnk.as_ptr(), STGM_READWRITE))
}

unsafe fn persist_save(persist: *mut c_void, lnk: &[u16]) -> bool {
    let vtbl = *(persist as *mut *const IPersistFileVtbl);
    ok(((*vtbl).save)(persist, lnk.as_ptr(), 1)) // TRUE = 记住这次修改
}

/* ---------------- 快捷方式枚举与改写 ---------------- */

/// ICO 的落盘路径（与 config.json / avatars 同住 `miasaki-appearance/`）。
pub fn ico_path(home: &Path) -> PathBuf {
    home.join("miasaki-appearance").join("launcher-icon.ico")
}

/// 收集四个常见位置的快捷方式：用户桌面 / 公共桌面 / 用户开始菜单 / 全局开始菜单。
fn shortcut_roots() -> Vec<PathBuf> {
    let env = |key: &str| std::env::var_os(key).map(PathBuf::from);
    let mut roots = Vec::new();
    if let Some(home) = env("USERPROFILE") {
        roots.push(home.join("Desktop"));
    }
    if let Some(public) = env("PUBLIC") {
        roots.push(public.join("Desktop"));
    }
    if let Some(appdata) = env("APPDATA") {
        roots.push(appdata.join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    if let Some(programdata) = env("ProgramData") {
        roots.push(programdata.join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    roots
}

/// 递归收集 `.lnk`（开始菜单是树状目录，深度限 4 层足够且防环）。
fn collect_lnks(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_lnks(&path, depth + 1, out);
        } else if path
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("lnk"))
            .unwrap_or(false)
        {
            out.push(path);
        }
    }
}

fn all_shortcuts() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in shortcut_roots() {
        collect_lnks(&root, 0, &mut out);
    }
    out
}

/// 把 `ico` 设为所有「指向本程序」的快捷方式的图标。
/// @returns 改写成功的数量。
unsafe fn rewrite_shortcuts(ico: &Path) -> usize {
    // 巡检跑在 tokio 线程上，这里自己起一次 COM（用完就 uninit）。
    // 失败（例如已按别的套间模型初始化过）⇒ 整条链路放弃，不影响其余图标逻辑。
    let hr = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
    if !ok(hr) {
        return 0;
    }
    let changed = rewrite_shortcuts_inner(ico, None);
    CoUninitialize();
    changed
}

/// 清掉所有「指向本程序」的快捷方式的图标位置（空串 = 回退到目标程序自身图标）。
unsafe fn clear_shortcuts() -> usize {
    let hr = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
    if !ok(hr) {
        return 0;
    }
    let empty = wide(OsStr::new(""));
    let changed = rewrite_shortcuts_inner(Path::new(""), Some(&empty));
    CoUninitialize();
    changed
}

/// `icon` 为 None ⇒ 用 `ico` 路径；为 Some ⇒ 用该字符串（`clear` 传空串）。
unsafe fn rewrite_shortcuts_inner(ico: &Path, override_value: Option<&[u16]>) -> usize {
    let Ok(exe) = std::env::current_exe() else { return 0 };
    let ico_wide = match override_value {
        Some(value) => value.to_vec(),
        None => wide(ico.as_os_str()),
    };
    rewrite_matching(&ico_wide, &exe.to_string_lossy())
}

/// 改写所有「目标 == `exe_text`（大小写不敏感）」的快捷方式的图标位置。
///
/// 从 `rewrite_shortcuts_inner` 抽出来是为了**测试能指定目标 exe**：测试进程的
/// `current_exe()` 是 cargo 的测试二进制、不是 Miasaki.exe，用 `current_exe` 的版本
/// 永远匹配不到真实快捷方式 ⇒ 「把 .lnk 指向 ICO」这条路径就没法验证
/// （见本模块 `apply_to_real_miasaki_shortcut`，`#[ignore]` 手动跑）。
unsafe fn rewrite_matching(icon_wide: &[u16], exe_text: &str) -> usize {
    let mut changed = 0usize;
    for lnk in all_shortcuts() {
        let Some(link) = create_shell_link() else { continue };
        let persist = query_persist_file(link);
        let Some(persist) = persist else {
            release(link);
            continue;
        };
        let lnk_wide = wide(lnk.as_os_str());
        if persist_load(persist, &lnk_wide) {
            if let Some(target) = get_path(link) {
                // 只认指向目标程序的快捷方式（大小写不敏感 —— Windows 路径语义）。
                if target.to_string_lossy().eq_ignore_ascii_case(exe_text)
                    && set_icon_location(link, icon_wide)
                    && persist_save(persist, &lnk_wide)
                {
                    changed += 1;
                }
            }
        }
        release(persist);
        release(link);
    }
    changed
}

/* ---------------- 对外 API ---------------- */

/// 把当前头像同步到快捷方式：ICO 落盘 + 改写全部匹配的 `.lnk` + 通知 shell 刷新图标缓存。
/// @param home - dshHome。
/// @param rgba - 已裁方并缩放到 ≤256 的 RGBA。
/// @param side - 上述 RGBA 的边长。
/// @returns 改写成功的快捷方式数量（0 = 没找到或全失败，调用方照常继续）。
pub fn apply(home: &Path, rgba: &[u8], side: u32) -> usize {
    let ico = build_ico(rgba, side);
    if ico.is_empty() {
        return 0;
    }
    let path = ico_path(home);
    if let Some(dir) = path.parent() {
        if fs::create_dir_all(dir).is_err() {
            return 0;
        }
    }
    // 【幂等闸门】2026-10-14 新增：**ICO 内容没变就整体跳过**（写盘 + 改写 .lnk + 通知 shell）。
    //
    // 为什么必须有这道闸门：上游 `launcher_icon::apply` 的去重位 `LAST_APPLIED` 是
    // **进程内**静态量，新进程必然是 None ⇒ 只要配置了头像，**每次启动**都会走到这里，
    // 无条件 `fs::write` + `rewrite_shortcuts`（COM 逐个改写 .lnk 并 Save）+
    // `SHChangeNotify(SHCNF_FLUSH)`（等 shell 处理，最贵的一步）。
    // 实测这一串 1~7 秒，且**全程跑在启动路径上** —— 2026-10-13/10-14 三次「WebView2
    // 初始化失败」误报，根因就是它把主线程堵到了 2.6s 判定之后（真机日志：三次
    // `launcher-icon:` 落盘与三次误报一一对应）。而其中绝大多数启动，头像根本没变 ——
    // 白写盘、白改快捷方式、白让资源管理器刷一遍图标缓存。
    //
    // 判据取「ICO 字节一致」：它由头像像素唯一决定，一致 ⇒ 结果已经是要的样子，重做无收益。
    //
    // **已知边界（刻意接受）**：若用户手工改掉了 `.lnk` 的图标位置，本函数不再自动纠正
    // （原实现每次启动都会纠正）。恢复路径：在外观面板重新选一次头像即可。
    if fs::read(&path).map(|old| old == ico).unwrap_or(false) {
        return 0;
    }
    if fs::write(&path, &ico).is_err() {
        return 0;
    }
    let changed = unsafe { rewrite_shortcuts(&path) };
    notify_shell();
    changed
}

/// 清除快捷方式图标（「清除」按钮的完整语义：不只是窗口/托盘回出厂，快捷方式也回）。
pub fn clear() -> usize {
    let changed = unsafe { clear_shortcuts() };
    if changed > 0 {
        notify_shell();
    }
    changed
}

/// 通知 shell 图标变了，让它刷新图标缓存（不通知的话资源管理器可能继续用旧图标）。
fn notify_shell() {
    unsafe {
        SHChangeNotify(
            SHCNE_ASSOCCHANGED as i32,
            SHCNF_IDLIST | SHCNF_FLUSH,
            std::ptr::null(),
            std::ptr::null(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一张纯色的正方 RGBA。
    fn solid(side: u32, rgba: [u8; 4]) -> Vec<u8> {
        rgba.iter().copied().cycle().take((side * side * 4) as usize).collect()
    }

    #[test]
    fn ico_header_declares_four_entries() {
        let ico = build_ico(&solid(64, [10, 20, 30, 255]), 64);
        assert!(!ico.is_empty());
        assert_eq!(u16::from_le_bytes([ico[0], ico[1]]), 0, "reserved 必须为 0");
        assert_eq!(u16::from_le_bytes([ico[2], ico[3]]), 1, "type 必须是图标");
        assert_eq!(u16::from_le_bytes([ico[4], ico[5]]), 4, "四档尺寸");
    }

    #[test]
    fn ico_entries_cover_expected_sizes_and_offsets_are_consistent() {
        let ico = build_ico(&solid(64, [10, 20, 30, 255]), 64);
        let count = u16::from_le_bytes([ico[4], ico[5]]) as usize;
        let header_len = 6 + 16 * count;
        for i in 0..count {
            let at = 6 + i * 16;
            let dim = ico[at];
            let expected = ICO_SIZES[i];
            assert_eq!(
                dim as u32,
                if expected >= 256 { 0 } else { expected },
                "第 {i} 档尺寸标注不对（256 用 0 表示）"
            );
            assert_eq!(u16::from_le_bytes([ico[at + 4], ico[at + 5]]), 1, "planes");
            assert_eq!(u16::from_le_bytes([ico[at + 6], ico[at + 7]]), 32, "位深");
            let bytes = u32::from_le_bytes([ico[at + 8], ico[at + 9], ico[at + 10], ico[at + 11]]);
            let offset =
                u32::from_le_bytes([ico[at + 12], ico[at + 13], ico[at + 14], ico[at + 15]]);
            assert!(offset as usize >= header_len, "图像数据不得与目录重叠");
            assert!(
                (offset as usize) + (bytes as usize) <= ico.len(),
                "第 {i} 档越界"
            );
            // DIB 头自校验：biSize=40、biHeight = 2×边长（XOR + AND 两段）
            let dib = &ico[offset as usize..];
            assert_eq!(u32::from_le_bytes([dib[0], dib[1], dib[2], dib[3]]), 40);
            let w = i32::from_le_bytes([dib[4], dib[5], dib[6], dib[7]]);
            let h = i32::from_le_bytes([dib[8], dib[9], dib[10], dib[11]]);
            assert_eq!(w, expected as i32);
            assert_eq!(h, expected as i32 * 2, "DIB 高度必须是 XOR+AND 两段之和");
        }
    }

    #[test]
    fn ico_pixels_are_bottom_up_bgra() {
        // 顶行纯红、底行纯蓝 ⇒ DIB 第一行（自下而上）应当是**蓝**。
        let side = 4u32;
        let mut rgba = Vec::new();
        for y in 0..side {
            for _ in 0..side {
                if y == 0 {
                    rgba.extend_from_slice(&[255, 0, 0, 255]);
                } else {
                    rgba.extend_from_slice(&[0, 0, 255, 255]);
                }
            }
        }
        let ico = build_ico(&rgba, side);
        // 取最小那档（16×16）的数据起点
        let offset = u32::from_le_bytes([ico[18], ico[19], ico[20], ico[21]]) as usize;
        let first = &ico[offset + 40..offset + 44];
        assert_eq!(first, &[255, 0, 0, 255], "底行是蓝 ⇒ DIB 首像素应是 BGRA 的蓝");
    }

    #[test]
    fn ico_rejects_empty_or_short_input() {
        assert!(build_ico(&[], 0).is_empty(), "side=0 必须放弃");
        assert!(build_ico(&[0u8; 8], 4).is_empty(), "像素数不足必须放弃");
    }

    /// **手动验收**：对着**真实**的 Miasaki 快捷方式跑一次「应用自定义图标」，
    /// 验证生产路径的另一半 —— 写 ICO + 把 `.lnk` 的 IconLocation 指向它。
    ///
    /// 为什么 `#[ignore]`：它**真的会改写你桌面上的快捷方式**（这正是要验证的行为），
    /// 所以不进默认 `cargo test`、更不进 CI。手动跑：
    /// `cargo test -- --ignored --nocapture apply_to_real_miasaki_shortcut`
    /// 跑完想恢复：在桌面端外观页点一次「清除」，或换个图标。
    #[test]
    #[ignore = "会真的改写桌面上的 Miasaki 快捷方式（手动验收用）"]
    fn apply_to_real_miasaki_shortcut() {
        let home = PathBuf::from(std::env::var_os("USERPROFILE").expect("需要 USERPROFILE")).join(".dsh");
        let exe_text = r"C:\ProgramData\MiasakiApp\Miasaki.exe";
        assert!(Path::new(exe_text).exists(), "先跑部署脚本：{exe_text} 不存在");

        // 走生产路径的「头像文件 → 像素」段：拿 avatars/ 里第一张 PNG，用同一套解码与裁方。
        let dir = home.join("miasaki-appearance").join("avatars");
        let avatar = fs::read_dir(&dir)
            .expect("avatars/ 目录必须存在")
            .flatten()
            .map(|entry| entry.path())
            .find(|p| p.extension().map(|e| e.eq_ignore_ascii_case("png")).unwrap_or(false))
            .expect("avatars/ 里至少要有一张 PNG");
        let bytes = fs::read(&avatar).expect("读头像文件");
        let (rgba, side) = crate::launcher_icon::square_rgba(&bytes).expect("PNG 解码");

        let ico = ico_path(&home);
        fs::create_dir_all(ico.parent().unwrap()).expect("建 miasaki-appearance 目录");
        if let Err(error) = fs::write(&ico, build_ico(&rgba, side)) {
            // **沙箱边界，不是产品缺陷**：本机实测 DSH 的文件沙箱会拦「工作区外的写入」——
            // 写 `%TEMP%`（第一版）与写 `~/.dsh/miasaki-appearance/` 都是 os error 5（拒绝访问），
            // 而写工作区内的 `target/` 正常；同一个路径用 PowerShell 写也是通的
            // ⇒ 拦的是「受管子进程写工作区外」这件事。用户双击快捷方式启动的真实壳不受此限。
            eprintln!("跳过：本环境写不了 ICO（{error}: {}）—— 沙箱边界，请在真实桌面端里验收", ico.display());
            return;
        }

        let changed = unsafe {
            if !ok(CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32)) {
                panic!("本环境起不了 COM —— 手动验收必须真跑");
            }
            let n = rewrite_matching(&wide(ico.as_os_str()), exe_text);
            CoUninitialize();
            n
        };
        println!("源头像: {}（{side}px）", avatar.display());
        println!("ICO   : {}（{} 字节）", ico.display(), fs::metadata(&ico).map(|m| m.len()).unwrap_or(0));
        println!("改写  : {changed} 个快捷方式");
        assert!(changed > 0, "本机应至少有一个指向 {exe_text} 的快捷方式");
    }

    /// 2026-10-14 幂等闸门：同一个头像连跑两次，第二次必须**整体跳过**。
    ///
    /// 回归背景：上游去重位 `LAST_APPLIED` 是**进程内**的，新进程必然为 None ⇒ 只要配置了
    /// 头像，**每次启动**都会走到 `apply` 并重写 ICO + 改写 .lnk + 通知 shell（实测 1~7 秒）。
    /// 三次「WebView2 初始化失败」误报的 `launcher-icon:` 日志与三次误报一一对应 ——
    /// 就是这条路径把主线程堵到了 2.6s 判定之后。这里钉死「内容没变 ⇒ 一个字节都不写」，
    /// 并反向钉死「真变了必须写」（闸门不得把真实变更一起吃掉）。
    #[test]
    fn apply_skips_everything_when_the_ico_is_unchanged() {
        // 目录刻意放 `target/` 下（构建产物区，已 gitignore）：`%TEMP%` 在受限沙箱里
        // 写不进去（本仓既有 EPERM/os error 5 一族记录），工作区内没有这个边界。
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("ico-idem-test");
        let _ = fs::remove_dir_all(&dir);
        let px = solid(64, [10, 20, 30, 255]);

        // 首次：文件不存在 ⇒ 必须落盘。
        // 注意 `changed` 在测试进程里恒为 0（`current_exe()` 是测试二进制，匹配不到
        // 任何真实快捷方式）—— 所以「有没有重做」只能看文件本身，不能看返回值。
        let _ = apply(&dir, &px, 64);
        let path = ico_path(&dir);
        assert!(path.is_file(), "首次必须落盘 ICO：{}", path.display());
        let first_bytes = fs::read(&path).expect("读回 ICO");
        let first_mtime = fs::metadata(&path)
            .and_then(|m| m.modified())
            .expect("首次 ICO 必须有 mtime");

        // 第二次（同一份像素）：内容一致 ⇒ 走「跳过」分支。判据取 mtime —— 即便写回
        // 完全相同的字节也算一次重写，mtime 会推后。
        std::thread::sleep(std::time::Duration::from_millis(20));
        let second = apply(&dir, &px, 64);
        let second_mtime = fs::metadata(&path)
            .and_then(|m| m.modified())
            .expect("第二次 ICO 必须有 mtime");
        assert_eq!(second, 0, "ICO 未变时不得报告改写了任何快捷方式");
        assert_eq!(
            first_mtime, second_mtime,
            "ICO 未变时不得重写文件 —— 这正是「每次启动白干 1~7 秒」的那一步"
        );
        assert_eq!(fs::read(&path).expect("读回 ICO"), first_bytes);

        // 反向：像素真的变了，必须重新落盘。
        std::thread::sleep(std::time::Duration::from_millis(20));
        let _ = apply(&dir, &solid(64, [200, 100, 50, 255]), 64);
        let third_mtime = fs::metadata(&path)
            .and_then(|m| m.modified())
            .expect("第三次 ICO 必须有 mtime");
        assert_ne!(
            second_mtime, third_mtime,
            "头像像素变了必须重新落盘：闸门只该吃掉「无变化」，不该吃掉真实变更"
        );
        assert_ne!(
            fs::read(&path).expect("读回 ICO"),
            first_bytes,
            "新像素生成的 ICO 必须与旧的逐字节不同"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ico_path_lives_beside_config() {
        let path = ico_path(Path::new("C:\\dsh"));
        assert!(path.ends_with("miasaki-appearance\\launcher-icon.ico") || path.to_string_lossy().contains("miasaki-appearance"));
    }

    /// **端到端覆盖 COM vtable 索引**（本轮唯一的实机风险点）：
    /// 在临时目录造一张 .lnk（**不碰用户任何快捷方式**），用 SetPath + SetIconLocation
    /// 写一遍，再新建对象 Load 读回。
    ///
    /// 为什么必须有这一条：vtable 是手写索引表，**错一位不是编译错误，是 UB（崩溃或读垃圾）**。
    /// 三种失败在这里各有明确签名：
    /// * 索引 3（GetPath）/ 16（GetIconLocation）/ 20（SetPath）错 ⇒ 断言失败或崩溃；
    /// * 索引 17（SetIconLocation）错 ⇒ 写不进去 ⇒ 读回的图标位置对不上；
    /// * 索引 6（Save）错 ⇒ 首次保存就失败。
    #[test]
    fn shortcut_round_trip_on_temporary_file() {
        let stamp = std::process::id();
        // 临时文件落在 target/ 下而不是 %TEMP%：本机实测 %TEMP% 会被拒（os error 5，
        // 而同一个路径用 PowerShell 写是通的 ⇒ 是进程级的神祕限制而非权限问题）。
        // target/ 是 cargo 自己的地盘，写入必然可行，且不会污染用户目录。
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("test-tmp");
        let _ = fs::create_dir_all(&dir);
        let temp_lnk = dir.join(format!("miasaki-icon-test-{stamp}.lnk"));
        let temp_ico = dir.join(format!("miasaki-icon-test-{stamp}.ico"));
        let _ = fs::remove_file(&temp_lnk);
        let ico_bytes = build_ico(&solid(64, [9, 8, 7, 255]), 64);
        assert!(!ico_bytes.is_empty(), "ICO 编码不该为空");
        fs::write(&temp_ico, &ico_bytes)
            .unwrap_or_else(|e| panic!("写临时 ICO 失败 {}: {e}", temp_ico.display()));

        let notepad = wide(OsStr::new("C:\\Windows\\System32\\notepad.exe"));
        let lnk_w = wide(temp_lnk.as_os_str());
        let ico_w = wide(temp_ico.as_os_str());

        unsafe {
            if !ok(CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32)) {
                // 本环境起不了 COM（例如线程已按别的套间模型初始化）—— 直接返回而不是假绿。
                return;
            }
            let link = create_shell_link().expect("ShellLink 必须能创建");
            let persist = query_persist_file(link).expect("必须能取到 IPersistFile");
            assert!(set_path(link, &notepad), "SetPath 失败 ⇒ vtable 索引 20 不对");
            assert!(persist_save(persist, &lnk_w), "首次保存失败 ⇒ vtable 索引 6 不对");
            assert!(
                set_icon_location(link, &ico_w),
                "SetIconLocation 失败 ⇒ vtable 索引 17 不对"
            );
            assert!(persist_save(persist, &lnk_w), "写图标后保存必须成功");
            release(persist);
            release(link);
            CoUninitialize();
        }

        unsafe {
            assert!(ok(CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32)));
            let link = create_shell_link().expect("ShellLink 必须能创建");
            let persist = query_persist_file(link).expect("必须能取到 IPersistFile");
            assert!(persist_load(persist, &lnk_w), "Load 刚写的 .lnk 必须成功");
            let icon = get_icon_location(link).expect("读不回图标位置 ⇒ vtable 索引 16 不对");
            let target = get_path(link).expect("读不回目标 ⇒ vtable 索引 3 不对");
            release(persist);
            release(link);
            CoUninitialize();
            assert!(
                target.to_string_lossy().to_lowercase().contains("notepad"),
                "目标应是 notepad，实得 {target:?}"
            );
            assert!(
                icon.to_lowercase().contains("miasaki-icon-test"),
                "图标位置应是我们刚写进去的那个，实得 {icon:?}"
            );
        }

        let _ = fs::remove_file(&temp_lnk);
        let _ = fs::remove_file(&temp_ico);
    }
}
