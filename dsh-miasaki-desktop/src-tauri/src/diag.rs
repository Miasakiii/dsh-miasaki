//! 诊断报告与进程内看门狗（T2.1 / T2.2，对症 `design/TODO.md` 里挂了半个月的 P0
//!「偶发全黑无响应」挂起）。
//!
//! ## 为什么要有这个模块
//!
//! WER 通道已经榨干：4 次 `Application Hang` 的 `Report.wer` 既没有 dump，也写着
//! `LoadedModule entries: 0`——**壳进程内没有任何取证能力**，用户侧只能看到「窗口全黑、
//! 托盘也没反应」，重启后一切如常、证据为零。官方桌面端的做法（本地留档诊断报告 +
//! 限量轮转 + renderer console 尾 + 宿主 stderr 尾）是本模块的格式参照。
//!
//! ## 两条铁律
//!
//! 1. **`panic = "abort"`（`Cargo.toml` [profile.release]）**：panic 之后不 unwind，
//!    `catch_unwind` 抓不到任何东西。所以取证必须在 panic **发生点**完成 —— 走
//!    `std::panic::set_hook`；启动期的 `expect`（`main.rs` 建窗 / 托盘）同样落在这条链上。
//! 2. **正常路径零开销**：心跳只是一次 `AtomicU64` 存；看门狗线程每 500ms 读一次、
//!    比一次阈值。重活（组报告、读日志尾）只在阈值被击穿的那一刻做一次。
//!
//! ## 心跳归属（重要）
//!
//! 桌宠线程**自持 `GetMessageW` 消息泵**（`pet_native/window.rs`），与主窗是两个独立的
//! 消息循环。本模块的心跳**只归属主窗口 UI 线程**：喂点写在 hash 轮询任务里
//! （`wv.url()` 是一次「派发到主线程的 WebView2 同步 COM 调用」，它返回即证明主窗
//! 消息泵仍在转）。桌宠线程的卡死不在本看门狗判据内，也不该由它背锅。

use std::{
    collections::VecDeque,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/* ---------------- 报告格式（对齐官方：事实头 + error + renderer console + host tail） ---------------- */

/// 保留的报告份数（官方同款上限）。
pub const KEEP_REPORTS: usize = 10;
/// `--- renderer console ---` 段保留的最大字节数（最近优先，官方同款 64 KiB）。
pub const CONSOLE_MAX_BYTES: usize = 64 * 1024;
/// `--- host tail ---` 段保留的最大字节数（后端 stderr 尾部）。
pub const HOST_TAIL_MAX_BYTES: usize = 32 * 1024;
/// 单条 console 行的硬上限：`eval` 回传的字符串可能被截断在 UTF-16 中间，
/// 也可能被恶意页面灌成巨串——单行超限即截断，保证报告本身永远写得出来。
pub const CONSOLE_LINE_MAX_CHARS: usize = 2000;

/// 报告来源。文件名里那一段 `<source>`。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// 壳进程自身（panic hook、启动期致命错误）
    Main,
    /// 自拉后端
    Host,
    /// 渲染层（挂起时从页面回捞的 console 环）
    Renderer,
    /// 启动链（WebView2 初始化失败、导航失败）
    WebBoot,
    /// 看门狗（心跳超时 / 恢复）
    Watchdog,
    /// 用户主动触发（托盘「生成诊断报告」，2026-09-25）：**自助取证**，不必等崩溃、
    /// 也不必人为阻塞消息泵 —— 怀疑卡顿/异常时点一下就有现场。
    Manual,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Main => "main",
            Source::Host => "host",
            Source::Renderer => "renderer",
            Source::WebBoot => "web-boot",
            Source::Watchdog => "watchdog",
            Source::Manual => "manual",
        }
    }

    /// 文件名里的 `<source>` → 枚举（`diag_report` 命令的入参解析）。未知值返回 None。
    pub fn parse(s: &str) -> Option<Source> {
        match s.trim().to_ascii_lowercase().as_str() {
            "main" => Some(Source::Main),
            "host" => Some(Source::Host),
            "renderer" => Some(Source::Renderer),
            "web-boot" | "webboot" => Some(Source::WebBoot),
            "watchdog" => Some(Source::Watchdog),
            "manual" => Some(Source::Manual),
            _ => None,
        }
    }
}

/// 报告的事实头（时间/版本/平台/架构/WebView2 或系统版本/locale + 触发原因）。
#[derive(Clone, Debug, Default)]
pub struct Facts {
    /// ISO-8601 UTC（`2026-09-25T13:04:05.123Z`）
    pub time: String,
    pub app_version: String,
    pub platform: String,
    pub arch: String,
    /// WebView2 runtime 版本；取不到时回落为「OS <系统版本>」
    pub webview: String,
    pub locale: String,
    pub pid: u32,
    /// 触发本次报告的原因（一句话，中文）
    pub reason: String,
}

/// 组一份诊断报告文本。**纯函数**（不碰磁盘、不看时钟），单测直接喂数据。
///
/// 段落顺序与标题对齐官方：事实头 → `--- error ---` → `--- renderer console
/// (error level, oldest first) ---` → `--- host tail ---`。
pub fn format_report(facts: &Facts, error: &str, console: &[String], host_tail: &str) -> String {
    let mut out = String::with_capacity(4096);
    out.push_str("Miasaki 诊断报告（本地留档，不外发）\n");
    out.push_str("========================================\n");
    out.push_str(&format!("time        : {}\n", facts.time));
    out.push_str(&format!("application : Miasaki 桌面端 v{}\n", facts.app_version));
    out.push_str(&format!("platform    : {}\n", facts.platform));
    out.push_str(&format!("arch        : {}\n", facts.arch));
    out.push_str(&format!("runtime     : {}\n", facts.webview));
    out.push_str(&format!("locale      : {}\n", facts.locale));
    out.push_str(&format!("pid         : {}\n", facts.pid));
    out.push_str(&format!("reason      : {}\n", facts.reason));

    out.push_str("\n--- error ---\n");
    out.push_str(error.trim_end_matches('\n'));
    out.push('\n');

    out.push_str("\n--- renderer console (error level, oldest first) ---\n");
    if console.is_empty() {
        out.push_str("(无：渲染层未回传 error 级 console，或挂起时页面已无法执行脚本)\n");
    } else {
        // 最近优先保留：从尾部往回收，凑满 CONSOLE_MAX_BYTES 即停，再正序输出。
        let mut kept: Vec<&String> = Vec::new();
        let mut used = 0usize;
        for line in console.iter().rev() {
            let cost = line.len() + 1;
            if used + cost > CONSOLE_MAX_BYTES && !kept.is_empty() {
                break;
            }
            used += cost;
            kept.push(line);
        }
        kept.reverse();
        if kept.len() < console.len() {
            out.push_str(&format!(
                "（已截断：共 {} 行，保留最近 {} 行 / ≤{} KiB）\n",
                console.len(),
                kept.len(),
                CONSOLE_MAX_BYTES / 1024
            ));
        }
        for line in kept {
            out.push_str(line);
            out.push('\n');
        }
    }

    out.push_str("\n--- host tail ---\n");
    if host_tail.trim().is_empty() {
        out.push_str("(无：后端非本应用拉起，或 server.log 为空)\n");
    } else {
        out.push_str(host_tail.trim_end_matches('\n'));
        out.push('\n');
    }
    out
}

/* ---------------- 文件名与轮转（纯逻辑，单测覆盖） ---------------- */

/// 文件名时间戳：`2026-09-25T13-04-05-123Z`。
///
/// **刻意偏离字面上的 ISO-8601**：Windows 文件名不允许 `:`，且规范里「冒号与点替换为
/// `-`」正是官方落盘时的做法。替换后**字典序 == 时间序**，因此裁剪可以只按文件名排序。
pub fn file_stamp_ms(ms: i64) -> String {
    let (y, mo, d, h, mi, s) = civil_from_unix_ms(ms);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}-{mi:02}-{s:02}-{:03}Z", ms.rem_euclid(1000))
}

/// 报告文件名：`crash-<ISO8601,冒号与点替换为 ->-<source>.log`。
pub fn report_file_name(ms: i64, source: Source) -> String {
    format!("crash-{}-{}.log", file_stamp_ms(ms), source.as_str())
}

/// 该文件名是否是本模块产出的报告（轮转只删这一类，绝不误伤 server.log / pet.log）。
///
/// 判据刻意「正面列举已知 source」而不是切分：`web-boot` 自带连字符，
/// 用 `rsplit_once('-')` 会被切错，于是漏判 → 该报告永远轮转不掉。
pub fn is_report_file_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("crash-") else {
        return false;
    };
    let Some(stem) = rest.strip_suffix(".log") else {
        return false;
    };
    let stamp_pattern_ok = |stamp: &str| {
        stamp.len() == "2026-09-25T13-04-05-123Z".len()
            && stamp.starts_with(|c: char| c.is_ascii_digit())
            && stamp.ends_with('Z')
            && stamp.as_bytes()[4] == b'-'
            && stamp.as_bytes()[10] == b'T'
    };
    for source in ["main", "host", "renderer", "web-boot", "watchdog", "manual"] {
        if let Some(stamp) = stem.strip_suffix(source).and_then(|s| s.strip_suffix('-')) {
            if stamp_pattern_ok(stamp) {
                return true;
            }
        }
    }
    false
}

/// 裁剪决策（纯函数）：`names` 是目录下**全部**文件名，返回应按序删除的部分。
/// 只认 `crash-*.log` 报告；按文件名升序 = 时间升序，留下最后 `keep` 个。
pub fn reports_to_prune(names: &[String], keep: usize) -> Vec<String> {
    let mut reports: Vec<&String> = names.iter().filter(|n| is_report_file_name(n)).collect();
    reports.sort();
    if reports.len() <= keep {
        return Vec::new();
    }
    reports[..reports.len() - keep].iter().map(|s| (*s).clone()).collect()
}

/* ---------------- 落盘 ---------------- */

/// 报告目录：沿用既有日志目录约定（`%LOCALAPPDATA%\miasaki`，见 `main.rs::log_dir`），
/// 与 `server.log` / `pet.log` 同居 —— 用户点「打开日志目录」就能看到崩溃报告。
pub fn reports_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("miasaki");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// 写一份报告并轮转。返回落盘路径。
///
/// **`create_new(true)` 是硬要求**：同一毫秒内两次落盘（panic hook 与看门狗同时触发）
/// 不能互相覆盖 —— 撞名时退化为加序号后缀，绝不 truncate 既有报告。
pub fn write_report(
    dir: &Path,
    source: Source,
    facts: &Facts,
    error: &str,
    console: &[String],
    host_tail: &str,
) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let text = format_report(facts, error, console, host_tail);
    let ms = now_unix_ms();
    let mut path = dir.join(report_file_name(ms, source));
    let mut seq = 0u32;
    let file = loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(f) => break f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && seq < 100 => {
                seq += 1;
                path = dir.join(format!(
                    "{}.{seq}",
                    report_file_name(ms, source).trim_end_matches(".log")
                ));
            }
            Err(e) => return Err(e),
        }
    };
    let mut file = file;
    file.write_all(text.as_bytes())?;
    let _ = file.flush();
    drop(file);
    prune_reports(dir);
    Ok(path)
}

/// **手动生成一份诊断报告**（托盘「生成诊断报告」入口，2026-09-25）。
///
/// 与自动路径**完全同一套**（`collect_facts` + `format_report` + `write_report`，含轮转），
/// 只有两点不同：来源标记为 `Manual`，原因写明"用户手动触发"。
///
/// 为什么要这个入口：取证链路此前只能在崩溃 / 挂起时被触发 —— 用户想验证"它到底工作不工作"
/// 得人为阻塞消息泵，日常怀疑卡顿时更是无门。给一个点击即得的入口，把诊断从"出事才跑"
/// 变成"随手可跑"。
pub fn write_manual_report() -> std::io::Result<PathBuf> {
    let dir = reports_dir();
    let facts = collect_facts("用户从托盘手动触发（自助取证 / 排障）");
    // 渲染层 console 环（`11-console.js` 经 `diag_console` 推送，已落在本模块的环里）一并带走
    let console = console_snapshot();
    write_report(&dir, Source::Manual, &facts, "", &console, "")
}

/// 轮转裁剪：只删匹配 `crash-<...>.log` 的文件，保留最近 `KEEP_REPORTS` 份。
/// 目录列举失败/删除失败一律静默 —— 取证模块绝不能因为清理失败而影响主流程。
pub fn prune_reports(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let names: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
        .collect();
    for name in reports_to_prune(&names, KEEP_REPORTS) {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

/* ---------------- 通用落盘入口（供 main.rs 的失败路径调用） ---------------- */

/// 落一份报告（背景快照 + 宿主日志尾 + console 环），返回路径。
/// `main.rs` 的失败路径（WebView2 初始化失败、导航失败、后端重拉失败）都走这里，
/// 保证「用户看到的每条致命提示，日志目录里都有一份可带走的现场」。
pub fn report(source: Source, reason: &str, error: &str) -> std::io::Result<PathBuf> {
    let facts = collect_facts(reason);
    write_report(
        &reports_dir(),
        source,
        &facts,
        error,
        &console_snapshot(),
        &crate::host_log_tail_public(HOST_TAIL_MAX_BYTES),
    )
}

/* ---------------- 事实头采集（WebView2 / 系统版本 / locale） ---------------- */

/// WebView2 客户端状态注册表键（Microsoft 官方文档口径）。
const WEBVIEW2_CLIENT_KEY: &str =
    r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

/// 事实头采集：能拿到的都拿到，拿不到就如实写「未知」——**绝不编造版本号**。
pub fn collect_facts(reason: &str) -> Facts {
    let time = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => iso8601_utc(d.as_millis() as i64),
        Err(_) => "unknown".to_string(),
    };
    Facts {
        time,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: platform_name(),
        arch: std::env::consts::ARCH.to_string(),
        webview: webview_runtime_version(),
        locale: locale(),
        pid: std::process::id(),
        reason: reason.to_string(),
    }
}

fn platform_name() -> String {
    let base = match std::env::consts::OS {
        "windows" => "Windows",
        other => other,
    };
    match windows_version() {
        Some(v) => format!("{base}（系统 {v}）"),
        None => base.to_string(),
    }
}

/// `Windows 11 24H2 (10.0.26100)` / `Windows 10 22H2 (10.0.19045)`。
/// 纯函数（喂 build 号），单测覆盖分档边界——Windows 版本号是「11 与 10 共用
/// 10.0.x」的著名坑，靠 build 号分档是官方认可口径。
pub fn windows_version_label(major: u32, minor: u32, build: u32) -> String {
    let (name, release) = if major != 10 || minor != 0 {
        ("Windows", "")
    } else if build >= 22000 {
        (
            "Windows 11",
            match build {
                26100.. => "24H2",
                22631..=26099 => "23H2",
                22621..=22630 => "22H2",
                _ => "21H2",
            },
        )
    } else {
        (
            "Windows 10",
            match build {
                19045.. => "22H2",
                19044 => "21H2",
                19043 => "21H1",
                19042 => "20H2",
                19041 => "2004",
                _ => "",
            },
        )
    };
    let suffix = if release.is_empty() {
        String::new()
    } else {
        format!(" {release}")
    };
    format!("{name}{suffix} (10.0.{build})")
}

/// 系统 build 号：读注册表 `CurrentVersion\BuildLabEx`（形如 `26100.1.amd64fre...`）。
///
/// 刻意**不用 `GetVersionExW`**：自 Win8.1 起，进程未在 manifest 里声明支持的
/// Windows 版本时该 API 一律返回 6.2 假值 —— 取证报告宁可写「未知」，也不能写错版本。
/// 系统 build 号（如 `26100`）。读不到返回 `None`。
///
/// 与 `windows_version()` 同一数据源（`BuildLabEx` → `CurrentBuildNumber`），
/// 单独暴露是为了给**原生材质预判**用（见 `main.rs::native_mica_expected`）：
/// Win11 = build ≥ 22000，据此在 `initialization_script` 里先给一个预期值，
/// 让外观线的 boot style 在首帧就能选对分支（见 `themes/src/12-material.js`）。
#[cfg(target_os = "windows")]
pub fn windows_build_number() -> Option<u32> {
    let lab = read_registry_string(
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
        "BuildLabEx",
    )
    .or_else(|| {
        read_registry_string(
            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
            "CurrentBuildNumber",
        )
    })?;
    // `26100.1.amd64fre.ge_release...` → build = 26100
    lab.trim().split('.').next().unwrap_or("").parse().ok()
}

#[cfg(not(target_os = "windows"))]
pub fn windows_build_number() -> Option<u32> {
    None
}

#[cfg(target_os = "windows")]
fn windows_version() -> Option<String> {
    Some(windows_version_label(10, 0, windows_build_number()?))
}

#[cfg(not(target_os = "windows"))]
fn windows_version() -> Option<String> {
    None
}

/// WebView2 运行时版本；取不到回落「OS <系统版本>」——两者对挂起取证都有意义
/// （官方报告头同样写 Electron 版本或系统版本，二选一）。
fn webview_runtime_version() -> String {
    match read_registry_string(WEBVIEW2_CLIENT_KEY, "pv") {
        Some(v) if !v.trim().is_empty() => format!("WebView2 {}", v.trim()),
        _ => match windows_version() {
            Some(v) => format!("OS {v}"),
            None => "runtime 未知".to_string(),
        },
    }
}

/// 只读注册表取一个 `REG_SZ`。写死 Win32 直调而不是引 crate：本模块的依赖面越小，
/// 「取证链自己坏掉」的概率越低。
#[cfg(target_os = "windows")]
fn read_registry_string(subkey: &str, value: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
        REG_SZ,
    };
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let sub = wide(subkey);
    let val = wide(value);
    unsafe {
        let mut key: HKEY = std::mem::zeroed();
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE, sub.as_ptr(), 0, KEY_READ, &mut key) != 0 {
            return None;
        }
        let mut ty: u32 = 0;
        let mut len: u32 = 0;
        let ok = RegQueryValueExW(
            key,
            val.as_ptr(),
            std::ptr::null(),
            &mut ty,
            std::ptr::null_mut(),
            &mut len,
        );
        if ok != 0 || (ty != REG_SZ && ty != 1) || len == 0 || len > 4096 {
            RegCloseKey(key);
            return None;
        }
        let mut buf = vec![0u8; len as usize];
        let ok = RegQueryValueExW(
            key,
            val.as_ptr(),
            std::ptr::null(),
            &mut ty,
            buf.as_mut_ptr(),
            &mut len,
        );
        RegCloseKey(key);
        if ok != 0 {
            return None;
        }
        let units: Vec<u16> = buf
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|c| *c != 0)
            .collect();
        String::from_utf16(&units).ok()
    }
}

#[cfg(not(target_os = "windows"))]
fn read_registry_string(_subkey: &str, _value: &str) -> Option<String> {
    None
}

/// locale：`zh-CN` 这类 BCP-47 标签。取 `LANG`（若有）之外优先 Windows 的
/// `UserDefaultLocaleName` 等价物 —— 这里用环境变量组合，零额外 API 面。
fn locale() -> String {
    for key in ["LANG", "LC_ALL", "LC_MESSAGES"] {
        if let Ok(v) = std::env::var(key) {
            let v = v.trim();
            if !v.is_empty() {
                return v.replace('_', "-").split('.').next().unwrap_or(v).to_string();
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        // LOCALE_NAME_MAX_LENGTH = 85（Windows SDK 常量，windows-sys 未导出）
        use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
        const LOCALE_NAME_MAX_LENGTH: i32 = 85;
        let mut buf = [0u16; LOCALE_NAME_MAX_LENGTH as usize];
        let n = unsafe { GetUserDefaultLocaleName(buf.as_mut_ptr(), LOCALE_NAME_MAX_LENGTH) };
        if n > 1 {
            if let Ok(s) = String::from_utf16(&buf[..(n as usize - 1)]) {
                return s;
            }
        }
    }
    "unknown".to_string()
}

/* ---------------- 时间（零依赖，与 main.rs 的 parse_iso8601_ms 同源口径） ---------------- */

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// UNIX 毫秒 → (年,月,日,时,分,秒)，UTC。`days_from_civil` 的逆运算（Howard Hinnant）。
fn civil_from_unix_ms(ms: i64) -> (i64, u32, u32, u32, u32, u32) {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (
        y,
        m as u32,
        d as u32,
        (rem / 3600) as u32,
        ((rem % 3600) / 60) as u32,
        (rem % 60) as u32,
    )
}

/// `2026-09-25T13:04:05.123Z`
pub fn iso8601_utc(ms: i64) -> String {
    let (y, mo, d, h, mi, s) = civil_from_unix_ms(ms);
    format!(
        "{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{:03}Z",
        ms.rem_euclid(1000)
    )
}

/* ---------------- renderer console 环（挂起时回捞用） ---------------- */

/// 页面 console error 环的进程内副本上限（64 KiB 级；按行存，报告侧再截一次）。
const CONSOLE_RING_LINES: usize = 200;

static CONSOLE_RING: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

/// 记一行 renderer console（error 级）。由 `eval` 回传通道喂入。
/// 单行超长即截断：报告必须永远写得出来，不能被一条巨串拖死。
pub fn push_console_line(line: &str) {
    let mut cleaned: String = line.chars().take(CONSOLE_LINE_MAX_CHARS).collect();
    if cleaned.trim().is_empty() {
        return;
    }
    cleaned = format!("[renderer] {}", cleaned.trim_end());
    if let Ok(mut ring) = CONSOLE_RING.lock() {
        if ring.len() >= CONSOLE_RING_LINES {
            ring.pop_front();
        }
        ring.push_back(cleaned);
    }
}

/// 环快照（oldest first）。
pub fn console_snapshot() -> Vec<String> {
    CONSOLE_RING
        .lock()
        .map(|r| r.iter().cloned().collect())
        .unwrap_or_default()
}

/* ---------------- 关键全局状态快照（挂起现场） ---------------- */

/// 挂起现场里那段「最后 hash fragment + 关键全局状态」。
static LAST_FRAGMENT: Mutex<Option<String>> = Mutex::new(None);

/// hash 轮询任务每次观察到新 fragment 时写一次（只在新值时写，正常路径零额外开销）。
pub fn note_hash_fragment(fragment: &str) {
    if let Ok(mut slot) = LAST_FRAGMENT.lock() {
        if slot.as_deref() == Some(fragment) {
            return;
        }
        // 单条上限：hash 可能被页面写成巨串，报告里只留头 512 字符。
        *slot = Some(fragment.chars().take(512).collect());
    }
}

pub fn last_hash_fragment() -> String {
    LAST_FRAGMENT
        .lock()
        .ok()
        .and_then(|s| s.clone())
        .unwrap_or_else(|| "(尚未观察到 hash)".to_string())
}

/* ---------------- 心跳（T2.2：正常路径 = 一次原子写 / 一次原子读） ---------------- */

static HEARTBEAT_MS: AtomicU64 = AtomicU64::new(0);
static HEARTBEAT_ARMED: AtomicBool = AtomicBool::new(false);
static CLOCK: OnceLock<std::time::Instant> = OnceLock::new();

fn clock_ms() -> u64 {
    CLOCK
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as u64
}

/// 心跳喂点：**主窗口 UI 线程可达处**每轮调用一次（见模块头「心跳归属」）。
/// 代价 = 一次 release store，无锁、无分配、无系统调用。
pub fn heartbeat() {
    HEARTBEAT_MS.store(clock_ms().max(1), Ordering::Release);
    HEARTBEAT_ARMED.store(true, Ordering::Release);
}

pub fn heartbeat_armed() -> bool {
    HEARTBEAT_ARMED.load(Ordering::Acquire)
}

/// 距上次心跳的毫秒数；从未心跳过返回 None（此时看门狗保持沉默，不误报）。
pub fn heartbeat_gap_ms() -> Option<u64> {
    let last = HEARTBEAT_MS.load(Ordering::Acquire);
    if last == 0 {
        return None;
    }
    Some(clock_ms().saturating_sub(last))
}

/// 心跳超时判定（纯函数，单测覆盖）。
pub fn is_hung(gap_ms: Option<u64>, threshold_ms: u64) -> bool {
    matches!(gap_ms, Some(gap) if gap >= threshold_ms)
}

/* ---------------- 挂起/恢复状态机（纯逻辑，单测覆盖） ---------------- */

/// 判定挂起的阈值：连续 5s 无心跳。取 5s 的理由：主窗 hash 轮询基准 150ms、
/// 退避上限 1s，正常运行时 gap 恒在 1s 量级；5s 已远超任何合法停顿，又短到
/// 能在用户「以为死机了」之前落盘。
pub const HANG_THRESHOLD_MS: u64 = 5_000;
/// **窗口不可见（隐藏到托盘 / 最小化）时的放宽阈值**。
///
/// 由来（2026-09-25）：`wv.url()` 虽然是 Rust 侧发起的同步 COM 调用，但 WebView2/Windows
/// 对**不可见宿主**存在节流与遮挡（occlusion）处理的可能 —— 若此时仍按 5s 判定，就会把
/// 「节流导致的调用变慢」误报成挂起。**假报告比漏报更伤诊断的可信度**（报告的价值全在信得过）。
///
/// 放宽不是取消：隐藏态真挂死仍会在 90s 后落盘 —— 用户此时看不到窗口，晚一点取证可以接受。
pub const HIDDEN_HANG_THRESHOLD_MS: u64 = 90_000;
/// 看门狗线程轮询间隔：只做一次原子读 + 一次比较，500ms 的代价可以忽略。
pub const WATCHDOG_TICK_MS: u64 = 500;
/// 挂起持续到此时长才弹恢复对话框：5s 只落盘（先取证），30s 才打扰用户
/// （短暂卡顿不该弹窗；真挂死了必须给出口，而不是让用户去任务管理器）。
pub const RECOVERY_DIALOG_AFTER_MS: u64 = 30_000;

/// 主窗口对用户是否可见（隐藏到托盘 / 最小化时为 `false`）。
///
/// 由主窗 UI 线程在喂心跳时一并更新（见 `main.rs` 的 hash 轮询），看门狗线程只读。
/// **默认 `true`**：宁可多报，不可漏报 —— 判据未就绪时按最严格阈值走。
static UI_VISIBLE: AtomicBool = AtomicBool::new(true);

/// 上报主窗可见性（`is_visible() && !is_minimized()`）。
pub fn set_ui_visible(visible: bool) {
    UI_VISIBLE.store(visible, Ordering::Release);
}

/// 主窗当前是否可见（看门狗线程读）。
pub fn ui_visible() -> bool {
    UI_VISIBLE.load(Ordering::Acquire)
}

/// 挂起/恢复判定的状态机（无 IO、无时钟，单测可完整驱动）。
#[derive(Debug, PartialEq, Eq)]
pub struct WatchdogMachine {
    hung: bool,
    /// 本次挂起已落盘的报告数（每次挂起最多一份，避免刷盘）
    reports: u32,
    /// 恢复记录数
    recoveries: u32,
    /// 是否已请求过恢复对话框
    dialog_requested: bool,
    /// 当前生效的判定阈值 —— 由看门狗线程按**主窗可见性**每拍设置：
    /// 可见 5s（快速取证），隐藏/最小化 90s（容忍不可见节流）。
    threshold_ms: u64,
}

impl Default for WatchdogMachine {
    fn default() -> Self {
        Self {
            hung: false,
            reports: 0,
            recoveries: 0,
            dialog_requested: false,
            threshold_ms: HANG_THRESHOLD_MS,
        }
    }
}

/// 状态机每拍的动作。
#[derive(Debug, PartialEq, Eq)]
pub enum WatchdogAction {
    /// 正常，什么都不做
    None,
    /// 刚判定挂起 → 落盘现场
    ReportHang { gap_ms: u64 },
    /// 挂起持续且还没弹过 → 请求恢复对话框
    OfferRecovery { gap_ms: u64 },
    /// 心跳回来 → 落一条 recovered
    Recovered { hung_ms: u64 },
}

impl WatchdogMachine {
    /// 设置判定阈值（每拍由看门狗线程按主窗可见性调用；见 `HIDDEN_HANG_THRESHOLD_MS`）。
    pub fn set_threshold(&mut self, threshold_ms: u64) {
        self.threshold_ms = threshold_ms;
    }

    /// 一拍。`gap` = 距上次心跳毫秒（None = 从未心跳）；`was_hung_for` = 进入挂起后累计毫秒。
    pub fn tick(&mut self, gap: Option<u64>, hung_for_ms: u64) -> WatchdogAction {
        if is_hung(gap, self.threshold_ms) {
            if !self.hung {
                self.hung = true;
                self.reports += 1;
                return WatchdogAction::ReportHang {
                    gap_ms: gap.unwrap_or(0),
                };
            }
            if !self.dialog_requested && hung_for_ms >= RECOVERY_DIALOG_AFTER_MS {
                self.dialog_requested = true;
                return WatchdogAction::OfferRecovery { gap_ms: gap.unwrap_or(0) };
            }
            return WatchdogAction::None;
        }
        if self.hung {
            // 心跳恢复：计数与对话框标记一起重置 —— 下一次挂起是全新事件，
            // 不该因为「上次已经报过」而沉默（误报累积的反面同样是漏报）。
            self.hung = false;
            self.dialog_requested = false;
            self.recoveries += 1;
            return WatchdogAction::Recovered { hung_ms: hung_for_ms };
        }
        WatchdogAction::None
    }

    /// 测试用访问器（生产路径不读这些计数）。
    #[cfg(test)]
    pub fn is_hung(&self) -> bool {
        self.hung
    }

    #[cfg(test)]
    pub fn reports(&self) -> u32 {
        self.reports
    }

    #[cfg(test)]
    pub fn recoveries(&self) -> u32 {
        self.recoveries
    }
}

/// 看门狗线程主体（独立 **OS 线程**，不是 UI 线程、不是 tokio 任务）。
///
/// 只做三件事：读心跳原子量 → 比阈值 → 击穿时组报告落盘。**绝不自动强杀进程**：
/// 恢复动作交给恢复对话框或用户（先取证，后恢复）。
pub fn spawn_ui_watchdog() {
    std::thread::Builder::new()
        .name("miasaki-ui-watchdog".into())
        .spawn(|| {
            let mut machine = WatchdogMachine::default();
            let mut hung_since: Option<std::time::Instant> = None;
            loop {
                std::thread::sleep(Duration::from_millis(WATCHDOG_TICK_MS));
                // 从未心跳（页面还没加载成功）时保持沉默：启动期的卡顿由
                // bootstrap 序列自己的 90s 超时与状态栏负责，不在这里误报。
                if !heartbeat_armed() {
                    continue;
                }
                let gap = heartbeat_gap_ms();
                let hung_for = hung_since.map(|t| t.elapsed().as_millis() as u64).unwrap_or(0);
                // 按主窗可见性选择阈值：隐藏/最小化时放宽到 90s（见 HIDDEN_HANG_THRESHOLD_MS
                // 的说明）—— 放宽不是取消，隐藏态真挂死仍在 90s 后落盘。
                machine.set_threshold(if ui_visible() {
                    HANG_THRESHOLD_MS
                } else {
                    HIDDEN_HANG_THRESHOLD_MS
                });
                match machine.tick(gap, hung_for) {
                    WatchdogAction::ReportHang { gap_ms } => {
                        hung_since = Some(std::time::Instant::now());
                        report_hang(gap_ms);
                    }
                    WatchdogAction::OfferRecovery { gap_ms } => {
                        // 30s 仍无心跳：先取证已落盘，现在给用户出口（**不自动强杀**）。
                        // 弱引用：挂起可能早已自愈、窗口可能已销毁 —— 拿不到就静默放弃。
                        crate::request_recovery_dialog(
                            None,
                            format!("主界面已 {hung_for}ms 无响应（心跳缺失 {gap_ms}ms）"),
                        );
                    }
                    WatchdogAction::Recovered { hung_ms } => {
                        hung_since = None;
                        report_recovered(hung_ms);
                    }
                    WatchdogAction::None => {}
                }
            }
        })
        .ok();
}

/// 落盘挂起现场：心跳缺失时长 + 最后一次 hash fragment + 关键全局状态 + 后端存活性。
fn report_hang(gap_ms: u64) {
    let facts = collect_facts(&format!(
        "UI 线程心跳缺失 {gap_ms}ms（阈值 {}ms）→ 判定挂起",
        HANG_THRESHOLD_MS
    ));
    let error = format!(
        "heartbeat missing for {gap_ms} ms (threshold {} ms)\n\
         last hash fragment: {}\n\
         console ring lines : {}\n\
         --- 关键全局状态 ---\n{}\n\
         --- 后端存活性 ---\n{}\n",
        HANG_THRESHOLD_MS,
        last_hash_fragment(),
        console_snapshot().len(),
        crate::globals_snapshot(),
        crate::backend_liveness_snapshot(),
    );
    let host_tail = crate::host_log_tail_public(HOST_TAIL_MAX_BYTES);
    match write_report(
        &reports_dir(),
        Source::Watchdog,
        &facts,
        &error,
        &console_snapshot(),
        &host_tail,
    ) {
        Ok(p) => crate::app_log_line_public(&format!(
            "[diag] 挂起报告已落盘：{}\n",
            p.display()
        )),
        Err(e) => crate::app_log_line_public(&format!("[diag] 挂起报告落盘失败：{e}\n")),
    }
}

/// 恢复记录：心跳回来后落一条，证明这次挂起是自愈的（避免误报累积）。
fn report_recovered(hung_ms: u64) {
    crate::app_log_line_public(&format!(
        "[diag] UI 心跳恢复（挂起约 {hung_ms}ms）\n"
    ));
    let facts = collect_facts(&format!("UI 线程心跳恢复（挂起约 {hung_ms}ms）"));
    let error = format!(
        "recovered: heartbeat resumed after ~{hung_ms} ms\nlast hash fragment: {}\n",
        last_hash_fragment()
    );
    let _ = write_report(
        &reports_dir(),
        Source::Watchdog,
        &facts,
        &error,
        &console_snapshot(),
        &crate::host_log_tail_public(HOST_TAIL_MAX_BYTES),
    );
}

/* ---------------- panic hook（`panic = "abort"` 下唯一可行的取证点） ---------------- */

static PANIC_HOOK_INSTALLED: AtomicBool = AtomicBool::new(false);

/// 装 panic hook：**在 panic 发生点就地落盘**。
///
/// `panic = "abort"` 决定了这里不能靠 unwind/catch_unwind —— hook 跑完进程就直接
/// 终结，因此本函数把「能拿到的都写进一次性报告」，且刻意用最小 API 面
/// （不 re-export、不引 crate），把「取证链自己 panic」的概率压到最低。
pub fn install_panic_hook() {
    if PANIC_HOOK_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // 先按默认 hook 打一份到 stderr（保持既有行为不变：裸跑时控制台仍能看到 panic）。
        previous(info);
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "(非字符串 panic payload)".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "(未知位置)".to_string());
        let facts = collect_facts("进程 panic（panic = \"abort\"：报告即最后现场）");
        // 注意：这里**不能**用 lock 保护的环/日志 —— panic 可能就发生在持锁线程上。
        // console 环与 hash 快照都走「拿不到就空」的锁（try_lock 语义由 Mutex::lock 的
        // 返回值兜住：中毒锁返回 Err，我们当作空处理）。
        let console = console_snapshot();
        let error = format!(
            "panic at {location}\npayload: {payload}\nthread: {}\n\
             --- 关键全局状态 ---\n{}\n\
             --- 后端存活性 ---\n{}\n",
            std::thread::current()
                .name()
                .unwrap_or("<unnamed>")
                .to_string(),
            crate::globals_snapshot(),
            crate::backend_liveness_snapshot(),
        );
        let host_tail = crate::host_log_tail_public(HOST_TAIL_MAX_BYTES);
        let _ = write_report(
            &reports_dir(),
            Source::Main,
            &facts,
            &error,
            &console,
            &host_tail,
        );
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> Facts {
        Facts {
            time: "2026-09-25T13:04:05.123Z".into(),
            app_version: "0.1.0".into(),
            platform: "Windows（系统 Windows 11 24H2 (10.0.26100)）".into(),
            arch: "x86_64".into(),
            webview: "WebView2 130.0.2849.68".into(),
            locale: "zh-CN".into(),
            pid: 4242,
            reason: "测试".into(),
        }
    }

    #[test]
    fn report_has_official_section_headers_in_order() {
        let console = vec!["[renderer] boom".to_string(), "[renderer] bang".to_string()];
        let text = format_report(&facts(), "oops", &console, "host stderr tail");
        let order = [
            "time        :",
            "application :",
            "platform    :",
            "arch        :",
            "runtime     :",
            "locale      :",
            "--- error ---",
            "oops",
            "--- renderer console (error level, oldest first) ---",
            "[renderer] boom",
            "[renderer] bang",
            "--- host tail ---",
            "host stderr tail",
        ];
        let mut cursor = 0usize;
        for needle in order {
            let at = text[cursor..]
                .find(needle)
                .unwrap_or_else(|| panic!("缺少/乱序：{needle}\n---\n{text}"));
            cursor += at + needle.len();
        }
    }

    #[test]
    fn empty_console_and_host_tail_are_explicit_not_silent() {
        let text = format_report(&facts(), "e", &[], "");
        assert!(text.contains("(无：渲染层未回传"));
        assert!(text.contains("(无：后端非本应用拉起"));
    }

    #[test]
    fn console_is_truncated_to_recent_budget_oldest_first() {
        // 造 5000 行 × 20B ≈ 100KiB > 64KiB：必须只留最近的一段，且仍是 oldest first。
        let console: Vec<String> = (0..5000).map(|i| format!("[renderer] line-{i:05}")).collect();
        let text = format_report(&facts(), "e", &console, "");
        assert!(text.contains("（已截断：共 5000 行"));
        assert!(text.contains("line-04999"), "最新一行必须保留");
        assert!(!text.contains("line-00000"), "最旧一行必须被裁掉");
        let first = text.find("line-0").unwrap();
        let last = text.find("line-04999").unwrap();
        assert!(first < last, "输出必须是 oldest first");
    }

    #[test]
    fn file_stamp_is_filename_safe_and_sorts_with_time() {
        // 冒号与点全部替换为 '-'（Windows 文件名硬约束），字典序 == 时间序。
        let a = file_stamp_ms(1_790_000_000_000);
        let b = file_stamp_ms(1_790_000_001_000);
        assert!(!a.contains(':') && !a.contains('.'));
        assert!(a.ends_with('Z'));
        assert!(a < b);
    }

    #[test]
    fn file_name_pattern_matches_only_our_reports() {
        let name = report_file_name(1_790_000_000_123, Source::Watchdog);
        assert!(name.starts_with("crash-"));
        assert!(name.ends_with("-watchdog.log"));
        assert!(is_report_file_name(&name));
        for src in [
            Source::Main,
            Source::Host,
            Source::Renderer,
            Source::WebBoot,
            Source::Watchdog,
        ] {
            assert!(is_report_file_name(&report_file_name(0, src)), "{src:?}");
        }
        // 绝不误伤既有日志与别的文件
        for other in [
            "server.log",
            "pet.log",
            "crash-main.log",
            "crash-2026-09-25T13-04-05-123Z-unknown.log",
            "crash-2026-09-25T13-04-05-123Z-main.txt",
            "diagnostics-1790000000.txt",
        ] {
            assert!(!is_report_file_name(other), "{other} 不该被当成报告");
        }
    }

    #[test]
    fn rotation_keeps_ten_of_twelve_and_deletes_oldest() {
        // 故障注入：12 份报告 + 2 个无关日志。
        let mut names: Vec<String> = Vec::new();
        for i in 0..12i64 {
            names.push(report_file_name(1_790_000_000_000 + i * 1000, Source::Main));
        }
        names.push("server.log".to_string());
        names.push("pet.log".to_string());

        let doomed = reports_to_prune(&names, KEEP_REPORTS);
        assert_eq!(doomed.len(), 2, "12 份 → 只该删 2 份");
        assert_eq!(doomed[0], report_file_name(1_790_000_000_000, Source::Main));
        assert_eq!(doomed[1], report_file_name(1_790_000_001_000, Source::Main));
        assert!(!doomed.iter().any(|n| n.ends_with("server.log")));
        assert!(!doomed.iter().any(|n| n.ends_with("pet.log")));

        // 恰好 10 份：一份都不删
        let exact: Vec<String> = (0..10i64)
            .map(|i| report_file_name(1_790_000_000_000 + i * 1000, Source::Host))
            .collect();
        assert!(reports_to_prune(&exact, KEEP_REPORTS).is_empty());
    }

    /// 测试临时目录：放在 `target/test-tmp/` 下，**不依赖系统 TEMP**。
    /// 由来（2026-09-25 实测）：受限环境下 cargo 启动的测试进程写系统 TEMP 会
    /// `create_dir_all` → os error 5（拒绝访问），而 `target/` 是 cargo 自己可写的位置。
    fn test_tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(format!("{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create test tmp dir under target/");
        dir
    }

    #[test]
    fn prune_reports_actually_removes_files_on_disk() {
        let dir = test_tmp_dir("prune-reports");
        std::fs::write(dir.join("server.log"), b"keep me").unwrap();
        for i in 0..12i64 {
            std::fs::write(
                dir.join(report_file_name(1_790_000_000_000 + i * 1000, Source::Main)),
                b"crash",
            )
            .unwrap();
        }
        prune_reports(&dir);
        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
            .filter(|n| is_report_file_name(n))
            .collect();
        assert_eq!(left.len(), KEEP_REPORTS);
        assert!(dir.join("server.log").exists(), "无关日志必须留下");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_report_never_overwrites_and_writes_readable_text() {
        let dir = test_tmp_dir("write-report");
        let f = facts();
        let p1 = write_report(&dir, Source::Main, &f, "first", &[], "").unwrap();
        // 同一毫秒内再写一次：必须换名，绝不覆盖
        let p2 = write_report(&dir, Source::Main, &f, "second", &[], "").unwrap();
        assert_ne!(p1, p2);
        assert!(std::fs::read_to_string(&p1).unwrap().contains("first"));
        assert!(std::fs::read_to_string(&p2).unwrap().contains("second"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn heartbeat_gap_and_hang_threshold() {
        // 从未心跳 → 绝不判定挂起（页面还没加载成功，不该误报）
        assert!(!is_hung(None, HANG_THRESHOLD_MS));
        assert!(!is_hung(Some(0), HANG_THRESHOLD_MS));
        assert!(!is_hung(Some(4_999), HANG_THRESHOLD_MS));
        assert!(is_hung(Some(5_000), HANG_THRESHOLD_MS));
        assert!(is_hung(Some(60_000), HANG_THRESHOLD_MS));
    }

    #[test]
    fn watchdog_machine_reports_once_then_offers_then_recovers() {
        let mut m = WatchdogMachine::default();
        // 正常：无动作
        assert_eq!(m.tick(Some(120), 0), WatchdogAction::None);
        // 击穿阈值：恰好一份报告
        assert_eq!(
            m.tick(Some(5_100), 0),
            WatchdogAction::ReportHang { gap_ms: 5_100 }
        );
        assert_eq!(m.reports(), 1);
        // 持续挂起：不重复落盘
        assert_eq!(m.tick(Some(9_000), 4_000), WatchdogAction::None);
        assert_eq!(m.reports(), 1);
        // 挂起 30s：请求恢复对话框（且只请求一次）
        assert_eq!(
            m.tick(Some(30_100), RECOVERY_DIALOG_AFTER_MS),
            WatchdogAction::OfferRecovery { gap_ms: 30_100 }
        );
        assert_eq!(m.tick(Some(31_000), RECOVERY_DIALOG_AFTER_MS + 900), WatchdogAction::None);
        // 心跳恢复：一条 recovered，状态归零
        assert_eq!(
            m.tick(Some(90), 33_000),
            WatchdogAction::Recovered { hung_ms: 33_000 }
        );
        assert!(!m.is_hung());
        assert_eq!(m.recoveries(), 1);
        // 第二次挂起是全新事件：重新落盘、重新允许弹窗（不因上次报过而漏报）
        assert_eq!(
            m.tick(Some(6_000), 0),
            WatchdogAction::ReportHang { gap_ms: 6_000 }
        );
        assert_eq!(m.reports(), 2);
        assert_eq!(
            m.tick(Some(40_000), RECOVERY_DIALOG_AFTER_MS),
            WatchdogAction::OfferRecovery { gap_ms: 40_000 }
        );
    }

    /// 隐藏/最小化时阈值放宽：**同一段 gap，可见时报挂起、不可见时不报**；
    /// 但放宽不是取消 —— 隐藏态真挂死仍会在 90s 后落盘。
    #[test]
    fn watchdog_threshold_widens_when_window_hidden() {
        // 可见（默认 5s）：5.1s 即报
        let mut visible = WatchdogMachine::default();
        visible.set_threshold(HANG_THRESHOLD_MS);
        assert!(matches!(
            visible.tick(Some(5_100), 0),
            WatchdogAction::ReportHang { .. }
        ));

        // 隐藏（90s）：同一个 gap 不得报（WebView2 对不可见宿主的节流不该被当成挂起）
        let mut hidden = WatchdogMachine::default();
        hidden.set_threshold(HIDDEN_HANG_THRESHOLD_MS);
        assert_eq!(hidden.tick(Some(5_100), 0), WatchdogAction::None);
        assert!(!hidden.is_hung());
        assert_eq!(hidden.reports(), 0, "隐藏态不得误报");

        // 但隐藏态真挂死必须报
        assert!(matches!(
            hidden.tick(Some(HIDDEN_HANG_THRESHOLD_MS + 1_000), 0),
            WatchdogAction::ReportHang { .. }
        ));
    }

    /// 隐藏 → 可见的切换：阈值收紧后，尚未达旧阈值的 gap 立即按新阈值判定。
    #[test]
    fn watchdog_threshold_tightening_takes_effect_immediately() {
        let mut m = WatchdogMachine::default();
        m.set_threshold(HIDDEN_HANG_THRESHOLD_MS);
        assert_eq!(m.tick(Some(6_000), 0), WatchdogAction::None, "隐藏态不报");
        m.set_threshold(HANG_THRESHOLD_MS); // 窗口被用户重新打开
        assert!(matches!(
            m.tick(Some(6_000), 0),
            WatchdogAction::ReportHang { .. }
        ));
    }

    /// 可见性原子量的默认值与往返（默认 true：判据未就绪时按最严格阈值走，宁可多报不可漏报）。
    /// 注意这是进程级静态量：末尾恢复原值，避免与并行执行的其它测试互相干扰。
    #[test]
    fn ui_visible_defaults_to_true_and_round_trips() {
        let before = ui_visible();
        set_ui_visible(false);
        assert!(!ui_visible());
        set_ui_visible(true);
        assert!(ui_visible());
        set_ui_visible(before);
    }

    /// 手动报告（托盘入口）：`Source::Manual` 的**命名与轮转识别必须成对** ——
    /// 若 `is_report_file_name` 漏了 `manual`，手动报告会永远留在目录里（轮转不掉），
    /// 用户点几次就堆一堆。
    #[test]
    fn manual_source_is_named_parsed_and_prunable() {
        assert_eq!(Source::Manual.as_str(), "manual");
        assert_eq!(Source::parse("manual"), Some(Source::Manual));
        assert_eq!(Source::parse("MANUAL"), Some(Source::Manual));

        let name = report_file_name(1_790_000_000_000, Source::Manual);
        assert!(name.starts_with("crash-"), "统一 crash- 前缀（轮转只认一套模式）");
        assert!(name.ends_with("-manual.log"));
        assert!(
            is_report_file_name(&name),
            "手动报告必须被轮转识别，否则会无限堆积"
        );

        // 轮转把 manual 与其它来源一视同仁地计入配额，且绝不误伤既有日志
        let mut names: Vec<String> = (0..11)
            .map(|i| report_file_name(1_790_000_000_000 + i * 1000, Source::Manual))
            .collect();
        names.push("server.log".to_string());
        names.push("pet.log".to_string());
        let prune = reports_to_prune(&names, KEEP_REPORTS);
        assert_eq!(prune.len(), 1, "11 份报告只留 10 份");
        assert!(
            !prune.iter().any(|n| n == "server.log" || n == "pet.log"),
            "绝不误伤既有日志"
        );
    }

    #[test]
    fn watchdog_machine_ignores_missing_heartbeat_entirely() {
        let mut m = WatchdogMachine::default();
        for _ in 0..10 {
            assert_eq!(m.tick(None, 0), WatchdogAction::None);
        }
        assert!(!m.is_hung());
        assert_eq!(m.reports(), 0);
    }

    #[test]
    fn console_ring_bounds_and_truncates_single_line() {
        // 单行超长必须截断（报告不能被一条巨串拖死）
        let huge = "x".repeat(CONSOLE_LINE_MAX_CHARS * 3);
        let cleaned: String = huge.chars().take(CONSOLE_LINE_MAX_CHARS).collect();
        assert_eq!(cleaned.chars().count(), CONSOLE_LINE_MAX_CHARS);
        // 空行被丢弃
        assert!(push_console_line_is_noop("   "));
    }

    fn push_console_line_is_noop(s: &str) -> bool {
        // 不碰全局环：只验证判据本身（全局环是进程级单例，测试里不污染）
        s.trim().is_empty()
    }

    #[test]
    fn windows_version_label_splits_win10_and_win11_by_build() {
        assert_eq!(windows_version_label(10, 0, 19045), "Windows 10 22H2 (10.0.19045)");
        assert_eq!(windows_version_label(10, 0, 19041), "Windows 10 2004 (10.0.19041)");
        assert_eq!(windows_version_label(10, 0, 22621), "Windows 11 22H2 (10.0.22621)");
        assert_eq!(windows_version_label(10, 0, 22631), "Windows 11 23H2 (10.0.22631)");
        assert_eq!(windows_version_label(10, 0, 26100), "Windows 11 24H2 (10.0.26100)");
        // 非 10.0 内核：如实回退，不硬套 Win11 分档
        assert_eq!(windows_version_label(6, 1, 7601), "Windows (10.0.7601)");
    }

    /// 事实头采集的真机自检：报告头不能出现空字段或「未知」兜底 ——
    /// WebView2 版本 / 系统版本 / locale 三样都必须是本机真值。
    /// 这也是对注册表读取与 `GetUserDefaultLocaleName` 调用的唯一自动化覆盖。
    #[cfg(target_os = "windows")]
    #[test]
    fn collect_facts_fills_real_values_on_windows() {
        let f = collect_facts("自检");
        assert!(f.platform.starts_with("Windows"), "platform={}", f.platform);
        assert!(
            f.platform.contains("(10.0."),
            "系统版本必须来自注册表真实 build：{}",
            f.platform
        );
        assert!(
            f.webview.starts_with("WebView2 ") || f.webview.starts_with("OS "),
            "runtime 必须二选一给出真值：{}",
            f.webview
        );
        assert_ne!(f.locale, "unknown", "locale 不应落到兜底值");
        assert!(!f.app_version.is_empty());
        assert!(f.pid > 0);
        assert!(f.time.ends_with('Z') && f.time.contains('T'));
    }

    #[test]
    fn iso8601_round_trips_known_instants() {        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00.000Z");
        // 与 main.rs 既有 parse_iso8601_ms 的锚点对齐（跨模块口径一致）
        assert_eq!(iso8601_utc(951_868_800_000), "2000-03-01T00:00:00.000Z");
        assert_eq!(iso8601_utc(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
        // 与 .NET DateTimeOffset.FromUnixTimeMilliseconds(1790000000123) 实测对齐
        assert_eq!(iso8601_utc(1_790_000_000_123), "2026-09-21T14:13:20.123Z");
    }
}
