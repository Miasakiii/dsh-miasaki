#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
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
static DSH_PID: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(None);
/// 最近一次关闭请求时间：短时间内重复请求视为前端无响应，兜底强制退出（不杀后端）。
static LAST_CLOSE_REQ: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
/// 最近一次观察到的主题（prefs 落盘去重）。
static LAST_THEME: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

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
fn kill_spawned_dsh() {
    let pid = DSH_PID.lock().unwrap().take();
    let Some(pid) = pid else { return };
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

fn port_ready() -> bool {
    TcpStream::connect_timeout(
        &"127.0.0.1:3080".parse().expect("valid socket addr"),
        Duration::from_millis(300),
    )
    .is_ok()
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
                set_status(&app, "已就绪，正在进入…");
                if let Some(wv) = app.get_webview_window("main") {
                    let url = tauri::Url::parse(&remote_url()).expect("valid remote url");
                    let _ = wv.navigate(url);
                }
                start_hash_watchdog(&app);
                start_pulse_watchdog(&app);
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

/* ---------------- hash 命令/状态通道（33ms 轮询，跟手拖窗） ---------------- */

fn parse_fragment(
    fragment: &str,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<bool>,
    Option<(i32, i32)>,
    bool,
    i64,
) {
    let mut theme = None;
    let mut int = None;
    let mut cmd = None;
    let mut act = None;
    let mut wait = None;
    let mut move_xy = None;
    let mut move_reset = false;
    let mut seq: i64 = -1;
    for part in fragment.split('&') {
        if let Some(v) = part.strip_prefix("miasaki-theme=") {
            theme = Some(v.to_string());
        }
        if let Some(v) = part.strip_prefix("int=") {
            int = Some(v.to_string());
        }
        if let Some(v) = part.strip_prefix("cmd=") {
            cmd = Some(v.to_string());
        }
        if let Some(v) = part.strip_prefix("act=") {
            act = Some(v.to_string());
        }
        if let Some(v) = part.strip_prefix("wait=") {
            wait = Some(v == "1");
        }
        if let Some(v) = part.strip_prefix("seq=") {
            seq = v.parse().unwrap_or(-1);
        }
        if let Some(v) = part.strip_prefix("move=") {
            if v == "reset" {
                move_reset = true;
            } else if let Some((a, b)) = v.split_once(',') {
                if let (Ok(x), Ok(y)) = (a.parse::<i32>(), b.parse::<i32>()) {
                    move_xy = Some((x, y));
                }
            }
        }
    }
    (theme, int, cmd, act, wait, move_xy, move_reset, seq)
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

/// 解析 pulse v2 → (fleet_running, fleet_alert)。
/// running+waiting_approval>0 → running；blocked+error>0 → alert。
fn read_pulse_flag() -> Option<(bool, bool)> {
    let txt = std::fs::read_to_string(pulse_path()?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&txt).ok()?;
    if v.get("v").and_then(|x| x.as_u64()) != Some(2) {
        return None;
    }
    let f = v.get("fleet")?;
    let n = |k: &str| f.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    Some((
        n("running") + n("waiting_approval") > 0,
        n("blocked") + n("error") > 0,
    ))
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
                        app_log_line("[pulse] fleet-pulse.json 不可用 → fleet 指示关闭\n");
                    }
                }
            }
        }
    });
}

fn start_hash_watchdog(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_fragment = String::new();
        let mut last_seq: i64 = -1;
        let mut last_diag = String::new();
        // 拖窗：累计增量差值应用(JS 发相对按下起点的累计值;Rust 应用与上次的差,不丢帧不重复)
        let mut last_move: (i32, i32) = (0, 0);
        loop {
            tokio::time::sleep(Duration::from_millis(33)).await;
            let Some(wv) = app.get_webview_window("main") else { continue };
            let Ok(url) = wv.url() else { continue };
            let Some(fragment) = url.fragment() else { continue };
            if fragment == last_fragment {
                continue;
            }
            last_fragment = fragment.to_string();
            let (theme, int, cmd, act, wait, move_xy, move_reset, seq) = parse_fragment(fragment);
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
            if let Some(t) = theme {
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
            if let Some(i) = int {
                pet.set_intensity(&i);
            }
            // v2026-08-30:总指挥活动状态/审批等待
            if let Some(a) = act {
                pet.set_activity(&a);
            }
            if let Some(w) = wait {
                pet.set_waiting_approval(w);
            }
            if move_reset {
                last_move = (0, 0);
            }
            if let Some((dx, dy)) = move_xy {
                let apply = (dx - last_move.0, dy - last_move.1);
                last_move = (dx, dy);
                if apply.0 != 0 || apply.1 != 0 {
                    if let Ok(p) = wv.outer_position() {
                        let _ = wv.set_position(tauri::PhysicalPosition::new(p.x + apply.0, p.y + apply.1));
                    }
                }
            }
            if let Some(c) = cmd {
                if seq > last_seq {
                    last_seq = seq;
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

/// 直调 DWM 设置 SYSTEMBACKDROP = MAINWINDOW（Mica，跟随系统明暗）。
/// 不用 tauri 的 set_effects：其内部吞掉 window-vibrancy 错误无法探测 Win10 ，
/// 而此处需按 DWM 返回值决定 WebView2 透明底是否可用（失败回退实色主题底）。
#[cfg(target_os = "windows")]
fn apply_mica(wv: &tauri::WebviewWindow, fallback_bg: tauri::utils::config::Color) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE, DWMSBT_MAINWINDOW,
    };
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
            export_diagnostics
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
                .background_color(tauri::utils::config::Color(0, 0, 0, 0))
                .initialization_script(&init)
                .on_page_load(|webview, payload| {
                    let _ = webview.show();
                    let url = payload.url().to_string();
                    if url.starts_with("http://127.0.0.1:3080") {
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
