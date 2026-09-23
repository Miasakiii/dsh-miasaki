#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod launcher_icon;
mod pet_native;

use std::{
    fs::OpenOptions,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const REMOTE_URL: &str = "http://127.0.0.1:3080/";
const ASSET_PORT: u16 = 39800;
const INIT_SCRIPT: &str = include_str!("../injected/theme-init.js");
const BOOTSTRAP_VERSION: u32 = 1;
const BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(90);
const BOOTSTRAP_WAITING_INTERVAL: Duration = Duration::from_secs(3);
static LAUNCHING: AtomicBool = AtomicBool::new(false);
/// 启动序列代际：retry 时 +1，旧序列检测到代际变化自行退出（避免双序列并存）。
static BOOTSTRAP_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
/// 桌面端拉起的 dsh web 进程 PID；None = 后端非本应用启动（用户手动/已在运行），关闭应用时不杀。
/// 注意（2026-09-23）：关闭前还会探测 3080 上是否有本应用进程树之外的客户端（浏览器等）
/// 仍连着——有则保留后端不杀，杜绝「关桌面端 → 拖走共享后端 → 浏览器断连」。
static DSH_PID: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(None);
/// 最近一次关闭请求时间：短时间内重复请求视为前端无响应，兜底强制退出（不杀后端）。
static LAST_CLOSE_REQ: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
/// 最近一次观察到的主题（prefs 落盘去重）。
static LAST_THEME: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
/// 鉴权 cookie 预置就绪位：`set_auth_cookie` 成功写入 WebView2 cookie jar 后置位；
/// `start_launch_sequence` 在 navigate 前等待（3s 超时放行，fail-open）。
static AUTH_COOKIE_READY: AtomicBool = AtomicBool::new(false);
/// 主动关闭流程进行位：`shutdown_app` 置位 → 后端存活看门狗下一轮即退出，
/// 不与「停后端 + 退出」抢节奏（避免关闭前一刻又把新后端拉起来）。
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
/// 3080 文档成功加载就绪位：`on_page_load` 命中远程 URL 时置位。后端看门狗重拉后端后
/// 据此区分「活 SPA」（DSH 前端自带指数退避重连，静候即可，无需 reload）与「从未加载
/// 成功的错误页」（WebView2 错误页不会自行重试，必须重新导航）。
static PAGE_UP: AtomicBool = AtomicBool::new(false);

fn remote_url() -> String {
    std::env::var("MIASAKI_REMOTE").unwrap_or_else(|_| REMOTE_URL.to_string())
}

/* ---------------- 日志 ---------------- */

fn log_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("miasaki");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn app_log_line(line: &str) {
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir().join("pet.log"))
    {
        let _ = f.write_all(line.as_bytes());
    }
}

fn chrono_now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| format!("{}s", d.as_secs()))
        .unwrap_or_else(|_| "?".into())
}

/* ---------------- Bootstrap 启动健康标记（bootstrap.json v1） ---------------- */

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapAttempt {
    at: String,
    phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dsh_available: Option<bool>,
}

impl BootstrapAttempt {
    fn new(phase: &str) -> Self {
        Self {
            at: chrono_now(),
            phase: phase.into(),
            detail: None,
            dsh_available: None,
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapState {
    version: u32,
    last_attempt: BootstrapAttempt,
    last_ok: Option<String>,
}

impl BootstrapState {
    fn default_state() -> Self {
        Self {
            version: BOOTSTRAP_VERSION,
            last_attempt: BootstrapAttempt::new("bootstrap"),
            last_ok: None,
        }
    }
}

fn bootstrap_path() -> PathBuf {
    log_dir().join("bootstrap.json")
}

/// 读取状态；损坏/版本不符 → None（调用方重建默认，fail-loud 的轻量版：不猜、不静默零值）。
fn read_bootstrap_state() -> Option<BootstrapState> {
    let txt = std::fs::read_to_string(bootstrap_path()).ok()?;
    let s: BootstrapState = serde_json::from_str(&txt).ok()?;
    if s.version != BOOTSTRAP_VERSION {
        return None;
    }
    Some(s)
}

/// 原子写：temp + rename，任何时刻不存在半写文件。
fn write_bootstrap_state(s: &BootstrapState) {
    let dir = bootstrap_path();
    if let Some(parent) = dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = dir.with_extension("tmp");
    if let Ok(text) = serde_json::to_string(s) {
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &dir);
        }
    }
}

fn update_bootstrap_attempt(phase: &str, detail: Option<&str>, dsh_available: Option<bool>) {
    let mut s = read_bootstrap_state().unwrap_or_else(BootstrapState::default_state);
    let mut attempt = BootstrapAttempt::new(phase);
    attempt.detail = detail.map(str::to_string);
    attempt.dsh_available = dsh_available;
    s.last_attempt = attempt;
    write_bootstrap_state(&s);
}

/// 记录「成功进入 DSH 页面」（on_page_load 匹配 3080 时调用）。
fn record_bootstrap_up() {
    let mut s = read_bootstrap_state().unwrap_or_else(BootstrapState::default_state);
    s.last_attempt = BootstrapAttempt::new("up");
    s.last_ok = Some(chrono_now());
    write_bootstrap_state(&s);
}

/// cmd 输出捕获（用户机运行时使用；用于 where dsh / dsh --version 探测）。
fn cmd_capture(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("cmd").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn dsh_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        cmd_capture(&["/C", "where", "dsh"]).is_some()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/* ---------------- 主题偏好持久化（prefs.json v1） ---------------- */

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prefs {
    version: u32,
    theme: String,
}

fn prefs_path() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("com.miasaki.desktop").join("prefs.json")
}

/// 读取偏好；损坏/版本不符 → 默认（pure，与 DSH 页运行时默认一致）。
fn load_prefs() -> Prefs {
    let default = || Prefs { version: 1, theme: "pure".into() };
    let Ok(txt) = std::fs::read_to_string(prefs_path()) else {
        return default();
    };
    let s: Prefs = serde_json::from_str(&txt).unwrap_or_else(|_| default());
    if s.version != 1 || s.theme.is_empty() {
        return default();
    }
    s
}

/// 原子写 theme：仅在主题变化时调用（temp + rename 铁律，任何时刻无半写文件）。
fn save_prefs_theme(theme: &str) {
    if theme != "pure" && theme != "zafkiel" && theme != "kurkuriel" {
        return;
    }
    let mut s = load_prefs();
    if s.theme == theme {
        return;
    }
    s.theme = theme.to_string();
    let p = prefs_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = p.with_extension("tmp");
    if let Ok(text) = serde_json::to_string(&s) {
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}

/* ---------------- 关闭流程（确认弹窗 + 同步停止 DSH 后端） ---------------- */

/// 停止由桌面端拉起的 dsh web（cmd 进程树：taskkill /T）。非本应用拉起的后端不触碰。
/// 2026-09-23 起：关闭前探测 3080 上是否仍有本应用进程树之外的客户端（浏览器等）
/// 连接着——后端是共享服务，「关桌面端」不应把别人正在用的连接拖走（12:14 断连事故
/// 根因：桌面端两次关闭分别杀掉了浏览器正连着的后端）。有外部客户端 → 保留 + 落日志；
/// 探测失败（netstat 起不来）→ 维持历史语义照停，最坏不劣化。
fn kill_spawned_dsh() {
    let pid = DSH_PID.lock().unwrap().take();
    let Some(pid) = pid else { return };
    if external_backend_clients() {
        app_log_line(&format!(
            "[{}] close: 后端 pid {pid} 仍有外部客户端（浏览器等）连接 → 保留不停止\n",
            chrono_now()
        ));
        return;
    }
    app_log_line(&format!("[{}] shutting down dsh backend pid {pid}\n", chrono_now()));
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(0x0800_0000)
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
    }
}

/// 确认关闭：停后端 + 退出（仅由用户确认后的入口调用，不经过重复请求兜底判定）。
fn shutdown_app(app: &AppHandle) {
    app_log_line(&format!("[{}] shutdown confirmed\n", chrono_now()));
    // 先告知后端看门狗「这是主动关闭」：它下一轮即退出，不会在关闭流程里重拉后端。
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    kill_spawned_dsh();
    app.exit(0);
}

/// 关闭请求：唤起主窗口并显示前端确认弹窗（主题自绘，见 runtime.js）。
/// 所有入口统一：#miasaki-titlebar 关闭按钮 / Alt+F4 / 托盘「退出」/ 桌宠「退出应用」。
/// 兜底仅限系统关闭路径：5s 内再次触发（前端弹窗无响应、用户 Alt+F4 连击）→ 直接退出（不杀后端）。
pub(crate) fn request_close(app: &AppHandle) {
    request_close_with(app, false);
}

fn request_close_system(app: &AppHandle) {
    request_close_with(app, true);
}

fn request_close_with(app: &AppHandle, system: bool) {
    if system {
        let now = Instant::now();
        let forced = {
            let mut last = LAST_CLOSE_REQ.lock().unwrap();
            let f = last
                .map(|t| now.duration_since(t) < Duration::from_secs(5))
                .unwrap_or(false);
            *last = Some(now);
            f
        };
        if forced {
            app_log_line(
                &format!("[{}] alt+F4 repeated (frontend unresponsive?) → force exit, backend kept\n", chrono_now()),
            );
            app.exit(0);
            return;
        }
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.eval("window.__miasakiOpenCloseDialog && window.__miasakiOpenCloseDialog()");
    }
}

/* ---------------- DSH 启动器 ---------------- */

/// dsh web 鉴权 secret：读 `~/.dsh/.credentials.yaml` 的
/// `client-connection/browser-session.secret`（2026-09-22 预置注入配套的「secret 动态化」）。
/// 手写行解析，零 crate 依赖：定位段 → 段内缩进行找 `secret:`；值须为 b64url 字符集。
/// 任何失败返回 None —— 调用方（loading 页）回落硬编码常量，行为与历史版本一致。
#[tauri::command]
fn auth_secret() -> Option<String> {
    let path = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .map(|h| h.join(".dsh").join(".credentials.yaml"))?;
    let text = std::fs::read_to_string(path).ok()?;
    let mut in_section = false;
    for line in text.lines() {
        if line.starts_with('#') {
            continue;
        }
        let top = !line.starts_with(' ') && !line.starts_with('\t');
        if top {
            in_section = line.trim_end() == "client-connection/browser-session:";
            continue;
        }
        if !in_section {
            continue;
        }
        if let Some(rest) = line.trim_start().strip_prefix("secret:") {
            let v = rest.trim().trim_matches('"').trim_matches('\'');
            if !v.is_empty()
                && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Some(v.to_string());
            }
            return None;
        }
    }
    None
}

/// 预置 dsh web 鉴权 cookie：由 loading 页 Web Crypto 签名后经 IPC 送入，在 **navigate 之前**
/// 写入 WebView2 的 cookie jar，使首次 `GET /` 即带有效 cookie —— 401 不发生
/// （2026-09-22「启动后总出错要点刷新」修复的主修；设计见 design/auth-cookie-prepinject.md）。
/// async 命令：Webview2 的 cookie API 在同步命令里死锁（wry#583）。
#[tauri::command]
async fn set_auth_cookie(app: AppHandle, name: String, value: String) -> Result<(), String> {
    if name.is_empty() || value.is_empty() {
        return Err("empty cookie name/value".into());
    }
    use tauri::webview::Cookie;
    let nlen = name.len();
    let vlen = value.len();
    // session cookie（不设 max_age）：预置每次启动执行，跨文档导航/reload 有效即够；
    // 3080 文档内 00-boot.js 的同名写入（带 30 天 Max-Age）会把它升级为持久 cookie。
    let cookie = Cookie::build((name, value))
        .domain("127.0.0.1")
        .path("/")
        .same_site(tauri::webview::cookie::SameSite::Strict)
        .build();
    let wv = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    wv.set_cookie(cookie).map_err(|e| format!("set cookie failed: {e}"))?;
    AUTH_COOKIE_READY.store(true, Ordering::SeqCst);
    app_log_line(&format!(
        "[{}] auth cookie pre-injected (name len {}, value len {})\n",
        chrono_now(),
        nlen,
        vlen
    ));
    Ok(())
}

/// navigate 前等待预置 cookie 就绪（50ms 轮询 + 超时放行）。
/// fail-open：loading 页签名失败 / IPC 失败 / WebView2 拒绝时，超时后照常 navigate，
/// 由 00-boot.js 的「401 检测→reload」加固链兜底 —— 最坏情况不劣化。
async fn wait_auth_cookie(timeout: Duration) {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if AUTH_COOKIE_READY.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// DSH 后端端口（与 REMOTE_URL 同源；存活探测 / netstat 外部客户端枚举共用同一口径）。
const BACKEND_PORT: u16 = 3080;

fn port_ready() -> bool {
    let addr = format!("127.0.0.1:{BACKEND_PORT}")
        .parse()
        .expect("valid socket addr");
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

fn spawn_dsh() -> Result<PathBuf, String> {
    let log_path = log_dir().join("server.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("无法写入日志 {}: {e}", log_path.display()))?;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("cmd");
        // --no-open：rc.8 起 `dsh web` 会自动打开默认浏览器，与 WebView2 导航重复 → 双窗口
        cmd.args(["/C", "dsh", "web", "--no-open"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(std::process::Stdio::from(log))
            .creation_flags(0x0800_0000);
        let child = cmd.spawn().map_err(|e| format!("启动 dsh 失败: {e}"))?;
        // 记录 PID：确认关闭应用时据此停止（taskkill /T），仅限本应用拉起的后端
        *DSH_PID.lock().unwrap() = Some(child.id());
        Ok(log_path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = log;
        Err("Miasaki 桌面端目前仅支持 Windows".to_string())
    }
}

fn eval_status(app: &AppHandle, js: &str) {
    if let Some(wv) = app.get_webview_window("main") {
        let _ = wv.eval(js);
    }
}

fn set_status(app: &AppHandle, text: &str) {
    let escaped = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    eval_status(app, &format!("window.__setStatus && window.__setStatus({escaped})"));
}

fn start_launch_sequence(app: &AppHandle) {
    if LAUNCHING.swap(true, Ordering::SeqCst) {
        set_status(app, "仍在等待 DSH 服务就绪…");
        return;
    }
    update_bootstrap_attempt("bootstrap", None, None);
    let gen = BOOTSTRAP_GEN.load(Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut spawn_attempted = false;
        let mut timeout_hinted = false;
        let started = Instant::now();
        let mut last_wait_log = Instant::now();
        loop {
            // 已被更新的重试序列取代 → 退出（新序列负责继续）
            if BOOTSTRAP_GEN.load(Ordering::SeqCst) != gen {
                return;
            }
            if port_ready() {
                // 鉴权 cookie 预置等待：loading 页签好后经 set_auth_cookie 置位；
                // 3s 超时放行（fail-open），401 兜底链见 themes/00-boot.js。
                // 效果：首次 GET / 即带有效 cookie，不再出现「启动后要点刷新」。
                wait_auth_cookie(Duration::from_secs(3)).await;
                set_status(&app, "已就绪，正在进入…");
                if let Some(wv) = app.get_webview_window("main") {
                    let url = tauri::Url::parse(&remote_url()).expect("valid remote url");
                    let _ = wv.navigate(url);
                }
                start_hash_watchdog(&app);
                start_pulse_watchdog(&app);
                // 运行期后端存活看门狗：页面就绪后常驻探测，后端意外死亡时自动重拉
                //（断连自愈，2026-09-23；此前运行期无任何恢复手段，只能重启整个应用）。
                start_backend_watchdog(&app);
                return;
            }
            if !spawn_attempted {
                spawn_attempted = true;
                let dsh_ok = dsh_available();
                match spawn_dsh() {
                    Ok(log_path) => {
                        update_bootstrap_attempt("waiting", None, Some(dsh_ok));
                        set_status(
                            &app,
                            &format!("正在拉起 DSH 服务…（日志：{}）", log_path.display()),
                        );
                    }
                    Err(e) => {
                        update_bootstrap_attempt("spawn", Some(&e), Some(dsh_ok));
                        let msg = if !dsh_ok {
                            "未检测到 dsh，请安装 DeepSeek Harness（详见 README），或点击「检查 dsh」".to_string()
                        } else {
                            format!("启动失败：{e}")
                        };
                        set_status(&app, &msg);
                        eval_status(&app, "window.__setRetry && window.__setRetry(true)");
                    }
                }
            }
            // 90s 未就绪：提示端口占用排查（只提示一次；继续轮询，用户手动修复后自动进入）
            if started.elapsed() > BOOTSTRAP_TIMEOUT && !timeout_hinted {
                timeout_hinted = true;
                update_bootstrap_attempt(
                    "waiting",
                    Some("端口 3080 长时间未就绪，可能被其他程序占用或 dsh 启动失败"),
                    None,
                );
                set_status(
                    &app,
                    "DSH 服务长时间未就绪：可能端口 3080 被占用。请点击「打开终端」运行 netstat -ano | findstr 3080 排查。",
                );
                eval_status(&app, "window.__setRetry && window.__setRetry(true)");
            }
            // 低频落盘 waiting 心跳（避免每 400ms 写盘）
            if last_wait_log.elapsed() > BOOTSTRAP_WAITING_INTERVAL {
                last_wait_log = Instant::now();
                update_bootstrap_attempt("waiting", None, None);
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    });
}

/* ---------------- 运行期后端存活看门狗（断连自愈，2026-09-23） ---------------- */

/// 常态探测周期。启动序列把页面导航到 3080 之后才启动本看门狗（与 hash/pulse 看门狗同批）。
const BACKEND_POLL_MS: u64 = 2000;
/// 重拉后等待端口就绪的上限：dsh web 冷启动约 3~6s，90s 与 BOOTSTRAP_TIMEOUT 同口径。
const BACKEND_RESPAWN_TIMEOUT: Duration = Duration::from_secs(90);
/// `GetExitCodeProcess` 对仍活着的进程返回的退出码（Win32 STILL_ACTIVE）。
#[cfg(target_os = "windows")]
const STILL_ACTIVE: u32 = 259;
/// 自拉后端「进程活着但端口没起来」（启动中/僵死）的日志降频：每 15 个周期（约 30s）一行。
const BACKEND_BOOTWAIT_LOG_EVERY: u32 = 15;

/// 连续重拉失败的退避间隔：2s → 4s → 8s → 16s → 30s 封顶（纯函数，单测覆盖）。
fn backend_fail_backoff_ms(streak: u32) -> u64 {
    (BACKEND_POLL_MS << streak.min(4)).min(30_000)
}

/// 进程是否仍活着：`OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` +
/// `GetExitCodeProcess == STILL_ACTIVE`。进程不存在 → OpenProcess 返回 NULL → false。
/// 零 crate、零子进程拉起（比轮询 tasklist 轻一个量级）。
#[cfg(target_os = "windows")]
fn backend_process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code);
        let _ = CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE
    }
}

#[cfg(not(target_os = "windows"))]
fn backend_process_alive(pid: u32) -> bool {
    let _ = pid;
    true
}

/// 纯函数：从 `netstat -ano` 文本中提取「**对端端口** = port 且 ESTABLISHED」的连接所属
/// PID（去重保序）——即「谁正连着这个端口上的服务」。DSH 页面持有到网关的持久
/// WebSocket，客户端行的对端正是 3080；服务端 accepted 行（本地 3080、对端临时端口）
/// 不计入：那既含后端自己，也会让判据恒真。netstat 文本格式只在这一处解析，格式变化
/// 只坏这一个函数（单测覆盖典型行）。`LISTENING`/`TIME_WAIT`、UDP 行、`30801` 之类的
/// 端口前缀误伤全部排除。
fn parse_backend_client_pids(text: &str, port: u16) -> Vec<u32> {
    let suffix = format!(":{port}");
    let mut pids: Vec<u32> = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        // 行形态：TCP  local_addr:port  foreign_addr:port  ESTABLISHED  pid
        if cols.len() < 5 || !cols[0].eq_ignore_ascii_case("TCP") {
            continue;
        }
        if !cols[3].eq_ignore_ascii_case("ESTABLISHED") || !cols[2].ends_with(&suffix) {
            continue;
        }
        if let Ok(pid) = cols[4].parse::<u32>() {
            if !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }
    pids
}

/// 纯函数：剔除本应用进程树内的 PID，剩下即「外部客户端」（浏览器、别的终端等）。
fn pids_outside_tree(pids: &[u32], tree: &std::collections::BTreeSet<u32>) -> Vec<u32> {
    pids
        .iter()
        .copied()
        .filter(|p| !tree.contains(p))
        .collect()
}

/// 本应用进程树（自身 PID + 全部后代）：Toolhelp32 全进程快照 → (pid, ppid) 表 →
/// 从自身 PID 向下闭包（快照不保证父先进列表，闭包循环到收敛，层级浅一两趟即止）。
/// 用途：关闭后端前，把「我们自己的 WebView2 子进程」从外部客户端里剔掉——主窗口
/// 自己就连着后端，不剔除就会永远判「有外部客户端」。
#[cfg(target_os = "windows")]
fn our_process_tree() -> std::collections::BTreeSet<u32> {
    use std::collections::BTreeSet;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut tree: BTreeSet<u32> = BTreeSet::new();
    tree.insert(std::process::id());
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() || snap == INVALID_HANDLE_VALUE {
            return tree;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as _;
        let mut all: Vec<(u32, u32)> = Vec::with_capacity(256);
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let pid = entry.th32ProcessID;
                let ppid = entry.th32ParentProcessID;
                all.push((pid, ppid));
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        loop {
            let before = tree.len();
            for (pid, ppid) in &all {
                if tree.contains(ppid) {
                    tree.insert(*pid);
                }
            }
            if tree.len() == before {
                break;
            }
        }
    }
    tree
}

/// 关闭前探测：3080 上是否仍有本应用进程树之外的已连接客户端（浏览器等）。
/// 探测失败（netstat 缺失/执行失败）→ false = 维持历史语义照停后端，最坏不劣化。
#[cfg(target_os = "windows")]
fn external_backend_clients() -> bool {
    let tree = our_process_tree();
    let Ok(out) = std::process::Command::new("netstat").arg("-ano").output() else {
        return false;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    !pids_outside_tree(&parse_backend_client_pids(&text, BACKEND_PORT), &tree).is_empty()
}

#[cfg(not(target_os = "windows"))]
fn external_backend_clients() -> bool {
    false
}

/// 运行期后端存活看门狗（断连自愈）：页面加载后启动，专治「后端意外死亡 → webview
/// 永久停在死后端、只能重启整个应用」的缺口（2026-09-08 排查列为待拍板项，
/// 2026-09-12/23 断连事故后由用户拍板实施）。DSH 前端自带 500ms→10s 指数退避重连，
/// 鉴权走持久化 HMAC cookie（secret 来自 credentials，后端重启不变）→ 服务器回来后
/// 页面自行重连、无需 reload。本看门狗负责把后端尽快接回来；恢复分两路：自拉后端进程
/// 退出 → 重拉；采用的外部后端消失 → 接管重拉。文档从未加载成功过（错误页）时重拉后
/// 补一次重新导航。主动关闭不受影响：`shutdown_app` 置位 `SHUTTING_DOWN` 后本任务即退，
/// 绝不与「停后端 + 退出」抢节奏。
fn start_backend_watchdog(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut fail_streak: u32 = 0;
        let mut bootwait_logs: u32 = 0;
        loop {
            let interval = if fail_streak == 0 {
                BACKEND_POLL_MS
            } else {
                backend_fail_backoff_ms(fail_streak)
            };
            tokio::time::sleep(Duration::from_millis(interval)).await;
            if SHUTTING_DOWN.load(Ordering::SeqCst) {
                return;
            }
            // 自拉后端进程状态（只读拷贝；确认死亡才清除 DSH_PID）
            let our_pid = *DSH_PID.lock().unwrap();
            let mut respawn_reason: Option<String> = None;
            if let Some(pid) = our_pid {
                if !backend_process_alive(pid) {
                    DSH_PID.lock().unwrap().take();
                    if port_ready() {
                        app_log_line(&format!(
                            "[{}] backend-watchdog: 自拉后端 pid {pid} 已退出，3080 已被其他实例接管 → 转为采用\n",
                            chrono_now()
                        ));
                    } else {
                        respawn_reason = Some(format!("自拉后端 pid {pid} 退出且 3080 无监听"));
                    }
                } else if !port_ready() {
                    // 进程活着但端口没起来：仍在启动或已僵死。不重复 spawn（端口占用只会
                    // 让新进程秒退刷错误），降频记日志等下一轮。
                    bootwait_logs += 1;
                    if bootwait_logs % BACKEND_BOOTWAIT_LOG_EVERY == 1 {
                        app_log_line(&format!(
                            "[{}] backend-watchdog: 自拉后端 pid {pid} 进程在但 3080 未监听（启动中/僵死？）\n",
                            chrono_now()
                        ));
                    }
                }
            } else if !port_ready() {
                respawn_reason = Some("采用的外部后端已退出，3080 无监听".to_string());
            }
            let Some(reason) = respawn_reason else { continue };
            // —— 恢复：重拉 dsh web 并等端口就绪 ——
            fail_streak += 1;
            app_log_line(&format!(
                "[{}] backend-watchdog: {reason} → 自动重拉 dsh web（连续第 {fail_streak} 次，间隔 {interval}ms）\n",
                chrono_now()
            ));
            match spawn_dsh() {
                Ok(_) => {
                    let started = Instant::now();
                    loop {
                        if SHUTTING_DOWN.load(Ordering::SeqCst) {
                            return;
                        }
                        if port_ready() {
                            app_log_line(&format!(
                                "[{}] backend-watchdog: 后端已恢复（pid {:?}），页面重连中\n",
                                chrono_now(),
                                *DSH_PID.lock().unwrap()
                            ));
                            fail_streak = 0;
                            if !PAGE_UP.load(Ordering::SeqCst) {
                                // 当前文档从没成功加载过（启动撞上正在退出的旧服务 / 导航
                                // 中途后端死亡）——WebView2 错误页不会自行重试，重新导航。
                                let target = remote_url();
                                app_log_line(&format!(
                                    "[{}] backend-watchdog: 当前文档未就绪 → 重新导航 {target}\n",
                                    chrono_now()
                                ));
                                if let Some(wv) = app.get_webview_window("main") {
                                    if let Ok(url) = tauri::Url::parse(&target) {
                                        let _ = wv.navigate(url);
                                    }
                                }
                            }
                            break;
                        }
                        if started.elapsed() > BACKEND_RESPAWN_TIMEOUT {
                            app_log_line(&format!(
                                "[{}] backend-watchdog: 重拉后 90s 端口未就绪，下轮退避重试\n",
                                chrono_now()
                            ));
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(400)).await;
                    }
                }
                Err(e) => {
                    app_log_line(&format!(
                        "[{}] backend-watchdog: 自动重拉失败：{e}\n",
                        chrono_now()
                    ));
                }
            }
        }
    });
}

/* ---------------- hash 命令/状态通道（33ms 轮询，跟手拖窗） ---------------- */

/// hash 片段解析结果。M2(v3) 新增官方契约三字段：pet=<六态> / pettool=<工具名> / petts=<心跳 ms>；
/// R4(2026-09-16) 再增 petkey=<审批稳定身份，官方 PendingApproval.key>。
struct FragmentParts {
    theme: Option<String>,
    int: Option<String>,
    cmd: Option<String>,
    act: Option<String>,
    wait: Option<bool>,
    pet: Option<String>,
    pet_tool: Option<String>,
    pet_key: Option<String>,
    pet_ts: Option<i64>,
    move_xy: Option<(i32, i32)>,
    move_reset: bool,
    seq: i64,
}

/// percent-decode（encodeURIComponent 产物；'+' 不转空格——encode 不产生 '+'）。
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hi = (b[i + 1] as char).to_digit(16);
            let lo = (b[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_fragment(fragment: &str) -> FragmentParts {
    let mut p = FragmentParts {
        theme: None,
        int: None,
        cmd: None,
        act: None,
        wait: None,
        pet: None,
        pet_tool: None,
        pet_key: None,
        pet_ts: None,
        move_xy: None,
        move_reset: false,
        seq: -1,
    };
    for part in fragment.split('&') {
        if let Some(v) = part.strip_prefix("miasaki-theme=") {
            p.theme = Some(v.to_string());
        }
        if let Some(v) = part.strip_prefix("int=") {
            p.int = Some(v.to_string());
        }
        if let Some(v) = part.strip_prefix("cmd=") {
            p.cmd = Some(v.to_string());
        }
        if let Some(v) = part.strip_prefix("act=") {
            p.act = Some(v.to_string());
        }
        if let Some(v) = part.strip_prefix("wait=") {
            p.wait = Some(v == "1");
        }
        if let Some(v) = part.strip_prefix("pet=") {
            p.pet = Some(v.to_string());
        }
        if let Some(v) = part.strip_prefix("pettool=") {
            p.pet_tool = Some(percent_decode(v));
        }
        // R4:审批稳定身份（percent-encoded；官方 key 含 ':' 等字符）
        if let Some(v) = part.strip_prefix("petkey=") {
            p.pet_key = Some(percent_decode(v));
        }
        if let Some(v) = part.strip_prefix("petts=") {
            p.pet_ts = v.parse().ok();
        }
        if let Some(v) = part.strip_prefix("seq=") {
            p.seq = v.parse().unwrap_or(-1);
        }
        if let Some(v) = part.strip_prefix("move=") {
            if v == "reset" {
                p.move_reset = true;
            } else if let Some((a, b)) = v.split_once(',') {
                if let (Ok(x), Ok(y)) = (a.parse::<i32>(), b.parse::<i32>()) {
                    p.move_xy = Some((x, y));
                }
            }
        }
    }
    p
}

fn pet_mode_for(theme: &str) -> &'static str {
    match theme {
        "zafkiel" => "kurumi",
        "kurkuriel" => "inverse",
        _ => "whale",
    }
}

/// 推送桌宠状态到 DSH 页面：设置面板监听 `miasaki-pet-state` CustomEvent（detail.hidden）。
/// 与主题推送同理：Rust 侧 eval 单向下发，面板经 hash cmd=pet-state 主动请求。
fn push_pet_state(app: &AppHandle) {
    let pet = app.state::<pet_native::NativePet>();
    let hidden = pet.is_hidden();
    let js = format!(
        "window.dispatchEvent && window.dispatchEvent(new CustomEvent('miasaki-pet-state',{{detail:{{hidden:{hidden}}}}}))"
    );
    eval_status(app, &js);
}

/// 推送主窗口最大化状态到页面：远程页无 IPC 权限（capability 只授 start-dragging），
/// 经 eval 派发 CustomEvent（与 push_pet_state 同构）。runtime.js 监听 `miasaki-max-state`
/// 切换标题栏「最大化/还原」图标；页面经 hash cmd=want-max 主动请求重推。
fn push_max_state(app: &AppHandle) {
    if let Some(wv) = app.get_webview_window("main") {
        let maximized = wv.is_maximized().unwrap_or(false);
        let js = format!(
            "window.dispatchEvent && window.dispatchEvent(new CustomEvent('miasaki-max-state',{{detail:{{max:{maximized}}}}}))"
        );
        let _ = wv.eval(js);
    }
}

/// 上次最大化状态推送时间（毫秒）：Resized 拖动时高频触发，150ms 防抖。
static LAST_MAX_PUSH: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// X2:fleet 脉冲文件路径（A×B 路径 B：Rust 直读聚合文件）。
/// 由环境变量 MIASAKI_FLEET_PULSE 指定，未设 → 联动关闭（两线零耦合，可选接入）。
fn pulse_path() -> Option<PathBuf> {
    std::env::var_os("MIASAKI_FLEET_PULSE").map(PathBuf::from)
}

/// pulse 时效上限：超过此龄期的 pulse 视为 stale（发布器已死），不再当作实时状态。
/// 发布器建议 5s 间隔（契约文档），取 6 倍留足抖动余量。
const PULSE_STALE_SECS: i64 = 30;

/// 解析 pulse v2 文本 → (fleet_running, fleet_alert)。
/// running+waiting_approval>0 → running；blocked+error>0 → alert。
/// `now_ms` 为当前 UNIX 毫秒；`ts` 超出 PULSE_STALE_SECS 龄期则返回 None（stale
/// 等同不可用），否则发布器一崩，桌宠会永远停在最后一帧「忙碌中…」。
/// 未来时间戳同样按 stale 处理：时钟回拨或跨机器复制的文件不可信。
fn parse_pulse_flag(txt: &str, now_ms: i64) -> Option<(bool, bool)> {
    let v: serde_json::Value = serde_json::from_str(txt.trim_start_matches('\u{feff}')).ok()?;
    if v.get("v").and_then(|x| x.as_u64()) != Some(2) {
        return None;
    }
    // ts 缺失/不可解析 → 无法判定时效，按 stale 拒绝（契约要求 ts 必填）。
    let ts = v.get("ts").and_then(|x| x.as_str())?;
    let age_ms = now_ms - parse_iso8601_ms(ts)?;
    if age_ms.abs() > PULSE_STALE_SECS * 1000 {
        return None;
    }
    let f = v.get("fleet")?;
    let n = |k: &str| f.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    Some((
        n("running") + n("waiting_approval") > 0,
        n("blocked") + n("error") > 0,
    ))
}

/// 极简 ISO-8601 UTC 解析（`2026-09-04T07:40:08Z` / 带小数秒 / `+00:00`）→ UNIX 毫秒。
/// 只为算龄期，不引第三方时间库；非 UTC 偏移一律拒绝（发布器恒写 Z）。
fn parse_iso8601_ms(ts: &str) -> Option<i64> {
    let bytes = ts.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |range: std::ops::Range<usize>| ts.get(range)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let tail = &ts[19..];
    let tail = tail.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    if !(tail == "Z" || tail == "+00:00" || tail == "-00:00") {
        return None;
    }
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    // days_from_civil（Howard Hinnant 算法）：公历日 → UNIX epoch 天数。
    let y_adj = if mo <= 2 { y - 1 } else { y };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = y_adj - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400) + h * 3600 + mi * 60 + s) * 1000)
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_pulse_flag() -> Option<(bool, bool)> {
    let txt = std::fs::read_to_string(pulse_path()?).ok()?;
    parse_pulse_flag(&txt, now_unix_ms())
}

/// X2:fleet 脉冲看门狗（2s 轮询，与 33ms hash 看门狗独立任务，避免互相阻塞）。
fn start_pulse_watchdog(app: &AppHandle) {
    if pulse_path().is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last = (false, false);
        let mut logged = false;
        loop {
            tokio::time::sleep(Duration::from_millis(2000)).await;
            match read_pulse_flag() {
                Some(cur) => {
                    logged = false;
                    if cur != last {
                        last = cur;
                        app.state::<pet_native::NativePet>().set_fleet(cur.0, cur.1);
                    }
                }
                None => {
                    if last != (false, false) {
                        last = (false, false);
                        app.state::<pet_native::NativePet>().set_fleet(false, false);
                    }
                    if !logged {
                        logged = true;
                        // 区分「文件没了」与「发布器死了」——后者文件仍在但 ts 过龄，
                        // 是最容易误判为「fleet 一直在跑」的情形，日志必须点明。
                        let reason = match pulse_path() {
                            Some(p) if p.exists() => "存在但不可用（stale/格式错误）",
                            Some(_) => "文件不存在",
                            None => "未配置 MIASAKI_FLEET_PULSE",
                        };
                        app_log_line(&format!(
                            "[pulse] fleet-pulse.json {reason} → fleet 指示关闭\n"
                        ));
                    }
                }
            }
        }
    });
}

/// hash 同步通道的轮询节流参数（2026-09-10 性能审查）。
///
/// 背景：注入层每 1.5s 才 `history.replaceState` 一次，而原先固定 33ms 轮询（30 次/秒）
/// 属 45 倍冗余；更关键的是每次 `wv.url()` 都要 dispatch 到主线程执行 WebView2 的
/// `get_Source()` 同步 COM 调用 —— 一旦渲染侧无响应，这条 30 次/秒的链路会把「局部卡顿」
/// 放大成「整个 UI 冻结」（主窗口黑屏 + 托盘无响应 + 关闭失效）。
/// 现改为：基准 150ms / 拖窗期间 33ms（保持跟手）/ 慢调用或失败时自适应退避。
const HASH_POLL_MS: u64 = 150;
const HASH_POLL_FAST_MS: u64 = 33;
const HASH_SLOW_MS: u128 = 250;
const HASH_BACKOFF_MS: u64 = 1000;
const HASH_BACKOFF_HOLD_MS: u64 = 3000;
const HASH_DRAG_HOLD_MS: u64 = 400;

fn start_hash_watchdog(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_fragment = String::new();
        let mut last_seq: i64 = -1;
        let mut last_diag = String::new();
        // 拖窗：累计增量差值应用(JS 发相对按下起点的累计值;Rust 应用与上次的差,不丢帧不重复)
        let mut last_move: (i32, i32) = (0, 0);
        // —— 节流状态 ——
        let mut fail_streak: u32 = 0;
        let mut slow_hits: u32 = 0;
        let mut backoff_until = Instant::now();
        let mut drag_until = Instant::now();
        loop {
            // 间隔决策优先级：退避 > 拖窗提速 > 基准
            let now = Instant::now();
            let interval = if now < backoff_until {
                HASH_BACKOFF_MS
            } else if now < drag_until {
                HASH_POLL_FAST_MS
            } else {
                HASH_POLL_MS
            };
            tokio::time::sleep(Duration::from_millis(interval)).await;
            let t0 = Instant::now();
            let Some(wv) = app.get_webview_window("main") else { continue };
            let url = match wv.url() {
                Ok(u) => {
                    fail_streak = 0;
                    // 慢调用 → 退避一会儿，降低再次撞上同步阻塞的概率
                    let cost = t0.elapsed().as_millis();
                    if cost >= HASH_SLOW_MS {
                        backoff_until = Instant::now() + Duration::from_millis(HASH_BACKOFF_HOLD_MS);
                        if slow_hits < 5 || slow_hits % 50 == 0 {
                            app_log_line(&format!(
                                "[{}] hash poll slow {cost}ms → backoff {HASH_BACKOFF_HOLD_MS}ms\n",
                                chrono_now()
                            ));
                        }
                        slow_hits += 1;
                    }
                    u
                }
                Err(_) => {
                    fail_streak += 1;
                    if fail_streak == 1 || fail_streak % 20 == 0 {
                        app_log_line(&format!(
                            "[{}] hash poll url() failed x{fail_streak}\n",
                            chrono_now()
                        ));
                    }
                    if fail_streak >= 3 {
                        backoff_until = Instant::now() + Duration::from_millis(HASH_BACKOFF_HOLD_MS);
                    }
                    continue;
                }
            };
            let Some(fragment) = url.fragment() else { continue };
            if fragment == last_fragment {
                continue;
            }
            last_fragment = fragment.to_string();
            let parts = parse_fragment(fragment);
            // 诊断位落盘：hash diag（含侧栏宽/收起判定）变化时写一行日志，
            // 导出诊断可见 → 标题栏/侧栏问题可远程定位（1.5s 同步一次，变化才写，不刷屏）
            if let Some(p) = fragment.split("&diag=").nth(1) {
                let diag = p.split('&').next().unwrap_or(p);
                if diag != last_diag {
                    last_diag = diag.to_string();
                    app_log_line(&format!("[{}] hash-diag {diag}\n", chrono_now()));
                }
            }
            let pet = app.state::<pet_native::NativePet>();
            if let Some(t) = parts.theme {
                let mode = pet_mode_for(&t);
                pet.set_mode(mode);
                // 主题偏好落盘：DSH 页每次 syncHash 都携带当前主题 → 启动画面据此注入
                if ["pure", "zafkiel", "kurkuriel"].contains(&t.as_str()) {
                    let mut cur = LAST_THEME.lock().unwrap();
                    if *cur != t {
                        *cur = t.clone();
                        save_prefs_theme(&t);
                    }
                }
            }
            if let Some(i) = parts.int {
                pet.set_intensity(&i);
            }
            // v2026-08-30:总指挥活动状态/审批等待（M2 后为 DOM 兜底源,官方通道静默时生效）
            if let Some(a) = parts.act {
                pet.set_activity(&a);
            }
            if let Some(w) = parts.wait {
                pet.set_waiting_approval(w);
            }
            // M2(v3):官方契约六态通道（pet=/pettool=/petts=/petkey=）;petts 同值 = 页面未更新,
            // set_official_state 内部去重（不刷新心跳）→ 通道静默 5s 后 compose 自动回落 DOM 兜底
            if let (Some(st), Some(ts)) = (parts.pet.as_deref(), parts.pet_ts) {
                pet.set_official_state(
                    ts,
                    st,
                    parts.pet_tool.as_deref().unwrap_or(""),
                    parts.pet_key.as_deref().unwrap_or(""),
                );
            }
            if parts.move_reset {
                last_move = (0, 0);
            }
            if let Some((dx, dy)) = parts.move_xy {
                // 拖窗期间提速轮询保证跟手；松开后 HASH_DRAG_HOLD_MS 内回落基准间隔
                drag_until = Instant::now() + Duration::from_millis(HASH_DRAG_HOLD_MS);
                let apply = (dx - last_move.0, dy - last_move.1);
                last_move = (dx, dy);
                if apply.0 != 0 || apply.1 != 0 {
                    if let Ok(p) = wv.outer_position() {
                        let _ = wv.set_position(tauri::PhysicalPosition::new(p.x + apply.0, p.y + apply.1));
                    }
                }
            }
            if let Some(c) = parts.cmd {
                if parts.seq > last_seq {
                    last_seq = parts.seq;
                    app_log_line(&format!("[{}] hash-cmd {c}\n", chrono_now()));
                    match c.as_str() {
                        "hide" => {
                            let _ = wv.hide();
                        }
                        "show" => {
                            let _ = wv.show();
                            let _ = wv.set_focus();
                        }
                        "min" => {
                            let _ = wv.minimize();
                        }
                        "max" => {
                            if wv.is_maximized().unwrap_or(false) {
                                let _ = wv.unmaximize();
                            } else {
                                let _ = wv.maximize();
                            }
                        }
                        "close" => request_close(&app),
                        "shutdown" => shutdown_app(&app),
                        // 桌宠面板命令（设置 → 桌宠）：显示/隐藏/位置重置/状态请求
                        "pet-show" => {
                            pet.set_hide(false);
                            push_pet_state(&app);
                        }
                        "pet-hide" => {
                            pet.set_hide(true);
                            push_pet_state(&app);
                        }
                        "pet-reset" => {
                            pet.request_reset();
                            push_pet_state(&app);
                        }
                        "pet-state" => {
                            push_pet_state(&app);
                        }
                        // 页面请求最大化状态重推（标题栏被重渲染重建/推送丢失兜底）
                        "want-max" => {
                            push_max_state(&app);
                        }
                        _ => {}
                    }
                }
            }
        }
    });
}

#[tauri::command]
fn retry_start(app: AppHandle) {
    eval_status(&app, "window.__setRetry && window.__setRetry(false)");
    // 换代：旧序列（可能卡在 spawn 失败后的轮询）检测到代际变化退出，新序列重新完整启动
    BOOTSTRAP_GEN.fetch_add(1, Ordering::SeqCst);
    LAUNCHING.store(false, Ordering::SeqCst);
    start_launch_sequence(&app);
}

#[tauri::command]
fn pet_log(msg: String) {
    app_log_line(&format!("[{}] {msg}\n", chrono_now()));
}

/// 本地唤醒页确认「关闭应用」的直接入口（远程页经 hash cmd=shutdown 到达 shutdown_app）。
#[tauri::command]
fn shutdown(app: AppHandle) {
    shutdown_app(&app);
}

/* ---------------- 失败页恢复动作（loading.html 本地页可 invoke） ---------------- */

/// 上次启动状态的**安全投影**：只暴露失败诊断所需字段，不暴露路径等细节。
#[tauri::command]
fn bootstrap_state() -> serde_json::Value {
    match read_bootstrap_state() {
        Some(s) => serde_json::to_value(&s).unwrap_or_default(),
        None => serde_json::json!({
            "version": BOOTSTRAP_VERSION,
            "lastAttempt": serde_json::Value::Null,
            "lastOk": serde_json::Value::Null,
        }),
    }
}

/// dsh 安装探测：where dsh + dsh --version（失败则仅返回 where 结果）。
#[tauri::command]
fn dsh_check() -> String {
    #[cfg(target_os = "windows")]
    {
        let where_result = cmd_capture(&["/C", "where", "dsh"]).unwrap_or_else(|| "未找到 dsh（不在 PATH）".into());
        match cmd_capture(&["/C", "dsh", "--version"]) {
            Some(v) => format!("{where_result}\n版本：{v}"),
            None => format!("{where_result}\n（dsh --version 执行失败）"),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        "当前平台不支持 dsh 检查".to_string()
    }
}

/// 打开独立 cmd 窗口（用户手动执行 dsh web / netstat 排查）。
#[tauri::command]
fn open_terminal() {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "cmd", "/K", "title Miasaki 诊断终端 && echo 可手动运行: dsh web --no-open"])
            .spawn();
    }
}

/// 打开日志目录（%LOCALAPPDATA%\miasaki\）。
#[tauri::command]
fn open_logs_dir() -> Result<String, String> {
    let dir = log_dir();
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("打开日志目录失败：{e}"))?;
    Ok(dir.display().to_string())
}

fn tail_log(path: &Path, max: usize) -> String {
    match std::fs::read(path) {
        Ok(bytes) => {
            let start = bytes.len().saturating_sub(max);
            String::from_utf8_lossy(&bytes[start..]).into_owned()
        }
        Err(_) => "（无日志）".to_string(),
    }
}

/// 导出诊断摘要：聚合 server.log / pet.log 尾部 + 状态文件 + 系统信息到
/// %APPDATA%\com.miasaki.desktop\diagnostics-<ts>.txt（只读副本，不触碰原日志）。
#[tauri::command]
fn export_diagnostics() -> Result<String, String> {
    const MAX_LOG_BYTES: usize = 512 * 1024;
    let dir = state_path();
    let out_dir = dir.parent().ok_or("无法定位诊断输出目录")?;
    let _ = std::fs::create_dir_all(out_dir);
    let ts = chrono_now().trim_end_matches('s').to_string();
    let dest = out_dir.join(format!("diagnostics-{ts}.txt"));

    let mut out = String::new();
    out.push_str(&format!("Miasaki 诊断摘要（导出时间 {}\n", chrono_now()));
    out.push_str(&format!("OS: {} {}（rustc 目标 {}）\n", std::env::consts::OS, std::env::consts::ARCH, std::env::consts::FAMILY));
    out.push_str(&format!("log dir: {}\n\n", log_dir().display()));
    out.push_str("===== bootstrap.json =====\n");
    out.push_str(&tail_log(&bootstrap_path(), MAX_LOG_BYTES));
    out.push_str("\n\n===== server.log（尾部） =====\n");
    out.push_str(&tail_log(&log_dir().join("server.log"), MAX_LOG_BYTES));
    out.push_str("\n\n===== pet.log（尾部） =====\n");
    out.push_str(&tail_log(&log_dir().join("pet.log"), MAX_LOG_BYTES));
    out.push_str("\n\n===== window.json =====\n");
    out.push_str(&tail_log(&state_path(), 16 * 1024));
    out.push_str("\n\n===== pet.json =====\n");
    if let Ok(appdata) = std::env::var("APPDATA") {
        out.push_str(&tail_log(&PathBuf::from(appdata).join("com.miasaki.desktop").join("pet.json"), 16 * 1024));
    } else {
        out.push_str("（无 pet.json）");
    }
    out.push('\n');

    std::fs::write(&dest, out).map_err(|e| format!("导出诊断失败：{e}"))?;
    Ok(dest.display().to_string())
}

/* ---------------- Win11 Mica 材质（标题栏 × 主界面一体化的底座） ---------------- */

/// 诊断开关：`MIASAKI_NO_MICA=1`（或 `true`）时跳过 DWM Mica，改走实色主题底。
/// 用途：验证「透明窗口 + Mica 合成」是否与偶发 AppHang（主窗口纯黑、连托盘也无响应）相关。
/// 默认未设置时行为与既有版本完全一致；删掉环境变量即回退。
fn no_mica_requested() -> bool {
    std::env::var("MIASAKI_NO_MICA")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// 直调 DWM 设置 SYSTEMBACKDROP = MAINWINDOW（Mica，跟随系统明暗）。
/// 不用 tauri 的 set_effects：其内部吞掉 window-vibrancy 错误无法探测 Win10 ，
/// 而此处需按 DWM 返回值决定 WebView2 透明底是否可用（失败回退实色主题底）。
#[cfg(target_os = "windows")]
fn apply_mica(wv: &tauri::WebviewWindow, fallback_bg: tauri::utils::config::Color) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE, DWMSBT_MAINWINDOW,
    };
    // 诊断开关：跳过 Mica 与透明窗口底，用于验证合成链路是否为偶发挂起成因
    if no_mica_requested() {
        app_log_line(&format!(
            "[{}] mica skipped (MIASAKI_NO_MICA) → opaque background\n",
            chrono_now()
        ));
        let _ = wv.set_background_color(Some(fallback_bg));
        return;
    }
    let ok = wv
        .hwnd()
        .map(|hwnd| {
            let attr: u32 = DWMSBT_MAINWINDOW as u32;
            unsafe {
                DwmSetWindowAttribute(
                    hwnd.0,
                    DWMWA_SYSTEMBACKDROP_TYPE as u32,
                    &attr as *const u32 as *const core::ffi::c_void,
                    std::mem::size_of::<u32>() as u32,
                )
            }
        })
        .map(|hr| hr == 0)
        .unwrap_or(false);
    if ok {
        app_log_line(&format!(
            "[{}] mica backdrop applied (window transparent)\n",
            chrono_now()
        ));
    } else {
        app_log_line(&format!(
            "[{}] mica unavailable → fallback opaque background\n",
            chrono_now()
        ));
        let _ = wv.set_background_color(Some(fallback_bg));
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_mica(_wv: &tauri::WebviewWindow, _fallback_bg: tauri::utils::config::Color) {}

/* ---------------- 素材服务 ---------------- */

fn start_asset_server() {
    std::thread::spawn(|| {
        let Ok(listener) = TcpListener::bind(("127.0.0.1", ASSET_PORT)) else {
            app_log_line(&format!("[{}] asset-server bind failed\n", chrono_now()));
            return;
        };
        app_log_line(&format!("[{}] asset-server listening :{ASSET_PORT}\n", chrono_now()));
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            std::thread::spawn(move || {
                let _ = s.set_read_timeout(Some(Duration::from_secs(8)));
                let mut req = String::new();
                let mut buf = [0u8; 8192];
                loop {
                    match s.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            req.push_str(&String::from_utf8_lossy(&buf[..n]));
                            if req.contains("\r\n\r\n") {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                if req.is_empty() {
                    return;
                }
                let path = req
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("/")
                    .split('?')
                    .next()
                    .unwrap_or("/")
                    .trim_start_matches('/');
                let mut parts = path.split('/');
                let dir = parts.next().unwrap_or("");
                let file = parts.collect::<Vec<_>>().join("/");
                let valid = (dir == "pets" || dir == "icons")
                    && !file.is_empty()
                    && !file.contains("..")
                    && !file.contains('\\');
                let body = if valid {
                    assets::read(&format!("{dir}/{file}"))
                } else {
                    None
                };
                match body {
                    Some(bytes) => {
                        let mime = if file.ends_with(".png") {
                            "image/png"
                        } else if file.ends_with(".webp") {
                            "image/webp"
                        } else if file.ends_with(".json") {
                            "application/json"
                        } else {
                            "application/octet-stream"
                        };
                        let head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
                            bytes.len()
                        );
                        let _ = s.write_all(head.as_bytes());
                        let _ = s.write_all(&bytes);
                    }
                    None => {
                        let head = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\nnot found";
                        let _ = s.write_all(head.as_bytes());
                    }
                }
            });
        }
    });
}

/* ---------------- 主窗口状态持久化（位置/大小） ---------------- */

fn state_path() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("com.miasaki.desktop").join("window.json")
}

fn load_window_state() -> Option<(i32, i32, i32, i32)> {
    let txt = std::fs::read_to_string(state_path()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&txt).ok()?;
    let x = v.get("x")?.as_i64()? as i32;
    let y = v.get("y")?.as_i64()? as i32;
    let w = v.get("w")?.as_i64()? as i32;
    let h = v.get("h")?.as_i64()? as i32;
    if w < 800 || h < 500 {
        return None;
    }
    Some((x, y, w, h))
}

fn save_window_state(w: &tauri::Window) {
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) else {
        return;
    };
    let dir = state_path();
    if let Some(parent) = dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::json!({ "x": pos.x, "y": pos.y, "w": size.width, "h": size.height });
    // 原子写：temp + rename，避免半写（与 bootstrap.json 同一铁律）
    let tmp = dir.with_extension("tmp");
    if std::fs::write(&tmp, serde_json::to_string(&json).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &dir);
    }
}

fn apply_window_state(w: &tauri::WebviewWindow) {
    if let Some((x, y, wpx, hpx)) = load_window_state() {
        // 防负坐标/崩溃:仅当位置在可视工作区附近才应用
        if x > -5000 && y > -5000 {
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
            let _ = w.set_size(tauri::PhysicalSize::new(wpx, hpx));
        }
    }
}

/* ---------------- 入口 ---------------- */

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            retry_start,
            pet_log,
            shutdown,
            bootstrap_state,
            dsh_check,
            open_terminal,
            open_logs_dir,
            export_diagnostics,
            auth_secret,
            set_auth_cookie
        ])
        .on_window_event(|window, event| {
            if window.label() == "main" {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        save_window_state(window);
                        // 拦截关闭：前端弹窗确认；确认后走 hash cmd=shutdown（停后端 + 退出）
                        api.prevent_close();
                        request_close_system(window.app_handle());
                    }
                    // 最大化/还原状态推送：窗口尺寸变化（含双击标题栏/Win+↑ 等系统路径），
                    // 150ms 防抖（拖动调整大小时 Resized 高频触发）
                    tauri::WindowEvent::Resized(_) => {
                        let now = chrono_now_ms();
                        let last = LAST_MAX_PUSH.load(std::sync::atomic::Ordering::Relaxed);
                        if now - last >= 150 {
                            LAST_MAX_PUSH.store(now, std::sync::atomic::Ordering::Relaxed);
                            push_max_state(window.app_handle());
                        }
                    }
                    _ => {}
                }
            }
        })
        .setup(|app| {
            // 素材服务先于窗口启动：启动页标题栏/纹章图标同源加载，避免 404 竞态
            start_asset_server();

            // 启动画面随上次主题：注入 __MIA_THEME__（持久化于 DSH 页主题选择，见 prefs）
            let theme = load_prefs().theme;
            let theme_json = serde_json::to_string(&theme).unwrap_or_else(|_| "\"pure\"".into());
            let init = format!("window.__MIA_THEME__={theme_json};\n{INIT_SCRIPT}");
            // 主题兜底底色：仅当 Mica 不可用（Win10）时回退（页面半透明处显示实色），
            // 避免透出 tao 默认白底。Win11 Mica 生效时窗口底透明。
            let bg = match theme.as_str() {
                "kurkuriel" => tauri::utils::config::Color(247, 244, 241, 255),
                _ => tauri::utils::config::Color(12, 11, 17, 255),
            };
            // MIASAKI_NO_MICA=1：窗口从创建起就用实色底，避免「先透明后补实色」闪一下
            let window_bg = if no_mica_requested() {
                bg
            } else {
                tauri::utils::config::Color(0, 0, 0, 0)
            };
            let webview = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("loading.html".into()))
                .title("Miasaki · DSH")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .center()
                .decorations(false)
                // Win11：无边框窗口恢复 DWM 圆角 + 阴影 + 1px 描边（tauri 文档确认 shadow(true) 行为）
                .shadow(true)
                .visible(false)
                // 窗口底透明（主题底色移交给页面自身/Mica）：loading.html 自带实色渐变
                // 背景无加载期白闪；DSH 页面板令牌已半透明化（themes/*.css），与自绘标题栏
                // 共享同一张 Mica 材质 → 标题栏与主界面融为一体。
                // Mica 不可用（Win10 等）时 apply_mica 回退实色主题底。
                .background_color(window_bg)
                .initialization_script(&init)
                .on_page_load(|webview, payload| {
                    let _ = webview.show();
                    let url = payload.url().to_string();
                    if url.starts_with("http://127.0.0.1:3080") {
                        PAGE_UP.store(true, Ordering::SeqCst);
                        record_bootstrap_up();
                        let _ = webview.eval(INIT_SCRIPT);
                        // 延迟推一次最大化状态：eval INIT_SCRIPT 后页面监听已就绪（重启后
                        // 恢复上次窗口尺寸时的初始图标同样正确）
                        let app2 = webview.app_handle().clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(600)).await;
                            push_max_state(&app2);
                        });
                    }
                })
                .build()
                .expect("failed to build main window");

            // Win11 Mica 材质：成功 → 主题半透明面板与标题栏共享同一材质（融为一体）；
            // 失败（Win10/禁用）→ 回退实色主题底（页面半透明处不露出默认白底）。
            apply_mica(&webview, bg);

            // 恢复上次的主窗口位置/大小(有记录则覆盖默认 center)
            apply_window_state(&webview);

            // 托盘菜单:显示/隐藏主窗口、退出
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::TrayIconBuilder;
                let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏主窗口", true, None::<&str>)
                    .expect("menu item");
                let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>).expect("menu item");
                let menu = Menu::with_items(app, &[&toggle, &quit]).expect("menu");
                let icon = app
                    .default_window_icon()
                    .cloned()
                    .expect("default window icon");
                let _tray = TrayIconBuilder::with_id("main-tray")
                    .icon(icon)
                    .tooltip("Miasaki · DSH")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "toggle" => {
                            if let Some(w) = app.get_webview_window("main") {
                                if w.is_visible().unwrap_or(false) {
                                    let _ = w.hide();
                                } else {
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                }
                            }
                        }
                        "quit" => request_close(app),
                        _ => {}
                    })
                    .build(app)
                    .expect("tray build");
            }

            // 软件头像 → 启动器图标（appearance 线的桌面消费端，2026-09-12）：
            // 窗口与托盘都在位后才能设图标；此处先按当前配置应用一次，随后交给巡检跟随变化。
            // 出厂未设置时是 no-op（apply 内部回退出厂图标并去重），不影响既有外观。
            let icon_app = app.handle().clone();
            launcher_icon::apply(&icon_app);
            launcher_icon::spawn_watcher(icon_app);

            // 原生分层窗口桌宠（与主窗同进程，零 IPC 同步）
            app.manage(pet_native::NativePet::spawn(app.handle().clone()));

            let app = app.handle().clone();
            start_launch_sequence(&app);
            let _ = webview;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Miasaki");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 契约样例（ab-linkage-pulse-v2-2026-09-04.md）的时间戳基准。
    const TS: &str = "2026-09-04T07:40:08Z";
    fn base_ms() -> i64 {
        parse_iso8601_ms(TS).expect("契约样例 ts 必须可解析")
    }
    fn pulse(running: u64, waiting: u64, blocked: u64, error: u64) -> String {
        format!(
            r#"{{"v":2,"ts":"{TS}","fleet":{{"online":4,"running":{running},"waiting_approval":{waiting},"blocked":{blocked},"error":{error}}},"today_cost":0,"top_task":null}}"#
        )
    }

    #[test]
    fn iso8601_parses_utc_forms_and_rejects_offsets() {
        // 1970 epoch 与已知日期锚点：算法正确性而非自洽。
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601_ms("1970-01-02T00:00:00Z"), Some(86_400_000));
        assert_eq!(parse_iso8601_ms("2000-03-01T00:00:00Z"), Some(951_868_800_000));
        // 闰年边界（2024-02-29 存在）
        assert_eq!(parse_iso8601_ms("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
        // 小数秒与 +00:00 等价形式
        let z = parse_iso8601_ms("2026-09-04T07:40:08Z").unwrap();
        assert_eq!(parse_iso8601_ms("2026-09-04T07:40:08.512Z"), Some(z));
        assert_eq!(parse_iso8601_ms("2026-09-04T07:40:08+00:00"), Some(z));
        // 非 UTC 偏移一律拒绝：发布器恒写 Z，带偏移的文件来源不可信
        assert_eq!(parse_iso8601_ms("2026-09-04T07:40:08+08:00"), None);
        assert_eq!(parse_iso8601_ms("2026-09-04 07:40:08"), None);
        assert_eq!(parse_iso8601_ms("not-a-timestamp"), None);
        assert_eq!(parse_iso8601_ms(""), None);
    }

    #[test]
    fn fresh_pulse_maps_counts_to_running_and_alert() {
        let now = base_ms();
        assert_eq!(parse_pulse_flag(&pulse(0, 0, 0, 0), now), Some((false, false)));
        assert_eq!(parse_pulse_flag(&pulse(2, 0, 0, 0), now), Some((true, false)));
        // waiting_approval 单独也算 running（契约：running+waiting>0）
        assert_eq!(parse_pulse_flag(&pulse(0, 1, 0, 0), now), Some((true, false)));
        assert_eq!(parse_pulse_flag(&pulse(0, 0, 1, 0), now), Some((false, true)));
        assert_eq!(parse_pulse_flag(&pulse(0, 0, 0, 3), now), Some((false, true)));
        // 告警与运行可同时成立，优先级由 compose 决定，解析层不吞
        assert_eq!(parse_pulse_flag(&pulse(1, 0, 1, 0), now), Some((true, true)));
    }

    #[test]
    fn stale_pulse_is_rejected_so_the_pet_cannot_freeze_on_busy() {
        let now = base_ms();
        // 边界内：29s 龄期仍视为有效
        assert_eq!(
            parse_pulse_flag(&pulse(1, 0, 0, 0), now + 29_000),
            Some((true, false))
        );
        // 超过 30s：发布器已死，必须返回 None 而不是继续报「运行中」
        assert_eq!(parse_pulse_flag(&pulse(1, 0, 0, 0), now + 31_000), None);
        assert_eq!(parse_pulse_flag(&pulse(0, 0, 1, 0), now + 600_000), None);
        // 未来时间戳（时钟回拨/跨机复制）同样不可信
        assert_eq!(parse_pulse_flag(&pulse(1, 0, 0, 0), now - 31_000), None);
    }

    #[test]
    fn malformed_pulse_degrades_to_none() {
        let now = base_ms();
        // 版本不符 / 缺 fleet / 缺 ts / 非 JSON / 空
        assert_eq!(parse_pulse_flag(r#"{"v":1,"ts":"2026-09-04T07:40:08Z","fleet":{}}"#, now), None);
        assert_eq!(parse_pulse_flag(r#"{"v":2,"ts":"2026-09-04T07:40:08Z"}"#, now), None);
        assert_eq!(parse_pulse_flag(r#"{"v":2,"fleet":{"running":1}}"#, now), None);
        assert_eq!(parse_pulse_flag("{ not json", now), None);
        assert_eq!(parse_pulse_flag("", now), None);
        // BOM 前缀（本机 PowerShell 产物常见）必须容错，与 fleet 侧同口径
        let with_bom = format!("\u{feff}{}", pulse(1, 0, 0, 0));
        assert_eq!(parse_pulse_flag(&with_bom, now), Some((true, false)));
        // 计数字段缺失按 0 处理，不因单字段缺失丢掉整份 pulse
        assert_eq!(
            parse_pulse_flag(r#"{"v":2,"ts":"2026-09-04T07:40:08Z","fleet":{"running":1}}"#, now),
            Some((true, false))
        );
    }

    /// netstat 解析：只认「**对端端口**命中 + ESTABLISHED」的 TCP 行，PID 去重保序。
    /// 服务端 accepted 行（本地 3080、对端临时端口，含后端自己）必须排除，否则判据恒真。
    #[test]
    fn netstat_parse_extracts_backend_clients_only() {
        let text = concat!(
            // 服务端 accepted 行（本地 3080 / 监听）——不是客户端，排除
            "  TCP    127.0.0.1:3080    127.0.0.1:50826    ESTABLISHED   10688\n",
            "  TCP    127.0.0.1:3080    127.0.0.1:50677    TIME_WAIT     0\n",
            "  TCP    0.0.0.0:3080     0.0.0.0:0          LISTENING     10688\n",
            // 客户端行（对端 3080）：Quark 浏览器（重复 PID 去重）与 IPv6 形态
            "  TCP    127.0.0.1:50826   127.0.0.1:3080     ESTABLISHED   38120\n",
            "  TCP    127.0.0.1:50843   127.0.0.1:3080     ESTABLISHED   38120\n",
            "  TCP    127.0.0.1:52001   [::1]:3080         ESTABLISHED   777\n",
            // 无关端口（本机素材服务 39800）
            "  TCP    127.0.0.1:39999   127.0.0.1:39800    ESTABLISHED   4242\n",
            "  UDP    127.0.0.1:3080    *:*                                5150\n",
        );
        assert_eq!(parse_backend_client_pids(text, 3080), vec![38120, 777]);
        assert_eq!(parse_backend_client_pids(text, 39800), vec![4242]);
        assert!(parse_backend_client_pids("garbage output\n", 3080).is_empty());
        assert!(parse_backend_client_pids("", 3080).is_empty());
    }

    /// 外部客户端判据：进程树内的 PID（自身 + WebView2 子进程）必须被剔除，
    /// 树外的（浏览器等）才是外部客户端。
    #[test]
    fn pids_outside_tree_filters_own_process_tree() {
        use std::collections::BTreeSet;
        let tree: BTreeSet<u32> = [100u32, 200, 300].into_iter().collect();
        let pids = vec![200u32, 38120, 300, 999];
        assert_eq!(pids_outside_tree(&pids, &tree), vec![38120, 999]);
    }

    /// 重拉退避：指数增长到 30s 封顶（streak 截断防移位溢出）。
    #[test]
    fn backend_backoff_grows_then_caps() {
        assert_eq!(backend_fail_backoff_ms(0), 2_000);
        assert_eq!(backend_fail_backoff_ms(1), 4_000);
        assert_eq!(backend_fail_backoff_ms(2), 8_000);
        assert_eq!(backend_fail_backoff_ms(3), 16_000);
        // 2s<<4 = 32s → 30s 封顶；之后一直 30s（含极大 streak 不移位溢出）
        assert_eq!(backend_fail_backoff_ms(4), 30_000);
        assert_eq!(backend_fail_backoff_ms(50), 30_000);
    }
}
