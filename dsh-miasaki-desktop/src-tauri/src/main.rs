#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod diag;
mod launcher_icon;
mod pet_native;
mod recovery;
mod update;

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
/// W4.3（2026-09-25）：DWM Mica 是否**真的生效**（由 `apply_mica` 写入）。
/// 渲染层回传的窗口底色只在未生效时才应用——生效时窗口底必须保持透明（否则盖掉系统材质）。
static MICA_ACTIVE: AtomicBool = AtomicBool::new(false);

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

/* ---------------- 取证模块（diag.rs / recovery.rs）的接线口 ---------------- */

/// `diag.rs` 写一行应用日志（避免它反向依赖 main 的私有项）。
pub(crate) fn app_log_line_public(line: &str) {
    app_log_line(line);
}

/// 自拉后端 stderr 尾部（T2.1 `--- host tail ---`）。
/// `spawn_dsh` 把后端 stdout/stderr 都重定向到 `server.log`，此处只读它、
/// 不碰进程（取证模块绝不改变被取证对象的状态）。
pub(crate) fn host_log_tail_public(max: usize) -> String {
    tail_log(&log_dir().join("server.log"), max)
}

/// 挂起现场的关键全局状态（T2.2）：把「壳自己怎么看世界」写进报告，
/// 让一份日志就能回答「后端还在吗 / 页面到过哪 / 是不是在关闭中」。
pub(crate) fn globals_snapshot() -> String {
    let pid = *DSH_PID.lock().unwrap();
    format!(
        "page_up        : {}\n\
         auth_cookie    : {}\n\
         launching      : {}\n\
         shutting_down  : {}\n\
         last_theme     : {}\n\
         dsh_pid        : {}\n\
         asset_port     : {} (bound={})\n",
        PAGE_UP.load(Ordering::SeqCst),
        AUTH_COOKIE_READY.load(Ordering::SeqCst),
        LAUNCHING.load(Ordering::SeqCst),
        SHUTTING_DOWN.load(Ordering::SeqCst),
        LAST_THEME.lock().unwrap(),
        pid.map(|p| p.to_string()).unwrap_or_else(|| "none（后端非本应用拉起）".into()),
        ASSET_PORT,
        port_ready_on(ASSET_PORT),
    )
}

/// 后端存活性（T2.2）：自拉 PID 是否还活着 + 3080 是否在监听。
pub(crate) fn backend_liveness_snapshot() -> String {
    let pid = *DSH_PID.lock().unwrap();
    let alive = pid.map(backend_process_alive);
    format!(
        "spawned backend pid : {}\n\
         process alive       : {}\n\
         port {BACKEND_PORT} listening : {}\n",
        pid.map(|p| p.to_string()).unwrap_or_else(|| "none".into()),
        match alive {
            Some(true) => "yes",
            Some(false) => "no（已退出，看门狗应已重拉）",
            None => "n/a",
        },
        port_ready(),
    )
}

/// 任意端口的连通探测（素材服务 39800 的存活也进现场报告）。
fn port_ready_on(port: u16) -> bool {
    match format!("127.0.0.1:{port}").parse() {
        Ok(addr) => TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok(),
        Err(_) => false,
    }
}

/// 原生错误弹窗 + （T2.3）随后的恢复对话框。**刻意不依赖 WebView2**：本函数的调用
/// 场景正是「WebView2 起不来」，用页面弹提示等于让哑巴喊话。
///
/// 为什么把恢复对话框挂在这里：本函数就是既有失败路径的汇合点（WebView2 初始化失败 /
/// 建窗失败），从这里接一根线，三按钮对所有致命启动失败都可用——不需要页面健康。
fn show_native_error_then_recover(app: &AppHandle, msg: &str) {
    let app = app.clone();
    let msg = msg.to_string();
    std::thread::spawn(move || {
        show_native_error(&msg);
        // 用户关掉错误弹窗后才问「接下来怎么办」；此时处置顺序与文案都已在上一条里给足。
        request_recovery_dialog(
            native_owner_hwnd(&app),
            "主界面无法创建：WebView2 初始化失败（细节见上一条弹窗与日志目录）".to_string(),
        );
    });
}

/// 主窗的原生 HWND（给对话框做属主，让弹窗跟随主窗层级）。
/// Tauri 2 在 Windows 上的 `HWND` 是 `*mut c_void` 包装；取不到（窗口已销毁）返回 None，
/// 调用方**必须**容得下 None —— 挂起场景下主窗消息泵可能已卡死。
fn native_owner_hwnd(app: &AppHandle) -> Option<isize> {
    app.get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
}

fn show_native_error(msg: &str) {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND,
        };
        let text: Vec<u16> = msg.encode_utf16().chain(std::iter::once(0)).collect();
        let title: Vec<u16> = "Miasaki · 启动失败"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
            );
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = msg;
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
/// `pub(crate)`：桌宠线程 spawn 时也读它——隐藏态冷启动的悬浮球球面必须是持久化主题
/// （否则要等页面 hash 上报才换面，肉眼可见一次「换脸」）。
pub(crate) fn load_prefs() -> Prefs {
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

/* ---------------- 关闭流程（确认弹窗 + 分级停止 DSH 后端 + 恢复对话框） ---------------- */

/// 停止由桌面端拉起的 dsh web。判据**原样保留 2026-09-23 的修复**：
/// 关闭前探测 3080 上是否仍有本应用进程树之外的客户端（浏览器等）连接着——
/// 后端是共享服务，「关桌面端」不应把别人正在用的连接拖走（12:14 断连事故根因：
/// 桌面端两次关闭分别杀掉了浏览器正连着的后端）。
///
/// T2.4 只在「本来就该停」的前提下改进了**停法**：不再是单发 `taskkill /T /F`，
/// 而是软杀 → 等 → 强杀 → 等 → 再强杀，并记录始终未退出的 PID（见 `stop_backend_tiered`）。
fn kill_spawned_dsh() {
    let pid = DSH_PID.lock().unwrap().take();
    match recovery::stop_decision(pid, external_backend_clients()) {
        recovery::StopDecision::NothingToDo => {}
        recovery::StopDecision::Retain => {
            app_log_line(&format!(
                "[{}] close: 后端 pid {} 仍有外部客户端（浏览器等）连接 → 保留不停止\n",
                chrono_now(),
                pid.unwrap_or(0)
            ));
            // Job Object 的 KILL_ON_JOB_CLOSE 是「壳一死就带走整棵进程树」的兜底，
            // 而这里恰恰要求「壳退出但后端留下」—— 必须显式把 Job 从静态里摘掉，
            // 让它的句柄活到进程终结（等价于「本进程没有 Job」的历史行为）。
            retain_job_until_exit();
        }
        recovery::StopDecision::Stop => {
            let Some(pid) = pid else { return };
            app_log_line(&format!(
                "[{}] shutting down dsh backend pid {pid}（分级停机：软杀→强杀→重试）\n",
                chrono_now()
            ));
            stop_backend_tiered(pid);
        }
    }
}

/// 分级停机：软杀 → 等 → 强杀 → 等 → 再强杀 → 记录未退出 PID（纯状态机在
/// `recovery::ShutdownMachine`，这里只做「发信号 + 等待」的副作用）。
///
/// 时间刻度对齐官方 Electron 的 `SIGTERM → 10s → SIGKILL → 5s → SIGKILL`：
/// 每阶段最多发 2 次（首次 + 重试），每次之间等 5s（关窗体验上限 20s，超时即放弃，
/// 进程若真僵死则由 Job Object / 用户侧任务管理器兜底）。
///
/// **本机实测（2026-09-25）的一个负面结论，必须写在这里免得后人误判**：
/// `taskkill /PID <pid> /T`（不带 `/F`）**杀不掉控制台进程**——它只发 WM_CLOSE，
/// 而 `cmd.exe` / `node.exe` 没有窗口消息循环，收不到也不响应（真机测试
/// `soft_taskkill_does_not_terminate_a_console_child` 已把这条观察固化成回归）。
/// 所以软杀阶段对后端实际是「尽力而为、大概率无效」，真正生效的是强杀；
/// 保留它是因为①结构上与官方阶梯同构、②若将来后端带上窗口或改为 GUI 进程即自动生效、
/// ③给「正在写盘的进程」多一次自我了断的机会。**强杀不得因为软杀存在而被裁掉。**
fn stop_backend_tiered(pid: u32) {
    /// 软杀后的观察窗：本机实测软杀对控制台进程无效，等久了只是白等（关窗体感变慢）。
    const SOFT_GRACE: Duration = Duration::from_secs(1);
    /// 强杀后的观察窗（强杀理论上立即生效，留余量给进程表刷新）。
    const FORCE_GRACE: Duration = Duration::from_secs(1);
    let mut machine = recovery::ShutdownMachine::new(2);
    loop {
        match machine.tick(backend_process_alive(pid)) {
            recovery::KillAction::Done => {
                app_log_line(&format!(
                    "[{}] 后端 pid {pid} 已退出（软杀 {} 次 / 强杀 {} 次）\n",
                    chrono_now(),
                    machine.soft_attempts(),
                    machine.force_attempts()
                ));
                return;
            }
            recovery::KillAction::Run(stage) => {
                let force = matches!(stage, recovery::KillStage::Force);
                let outcome = taskkill(pid, force);
                if outcome == TaskkillOutcome::Denied {
                    // 令牌权限不足（受限环境）：继续走完阶梯也只是白等，直接记录并放弃
                    app_log_line(&format!(
                        "[{}] 停机被系统拒绝：无权终止 pid {pid}（Access denied）→ \
                         记录未退出 PID 并放弃（Job Object 会在壳退出时兜底回收）\n",
                        chrono_now()
                    ));
                    return;
                }
                // 发完信号先给一小段反应时间再复查（省掉一整轮等待）
                std::thread::sleep(Duration::from_millis(300));
                if !backend_process_alive(pid) {
                    app_log_line(&format!(
                        "[{}] 后端 pid {pid} 已响应{}信号\n",
                        chrono_now(),
                        if force { "强杀" } else { "软杀" }
                    ));
                    return;
                }
                std::thread::sleep(if force { FORCE_GRACE } else { SOFT_GRACE });
            }
            recovery::KillAction::GiveUp => {
                app_log_line(&format!(
                    "[{}] 停机失败：后端 pid {pid} 在软杀 {} 次 + 强杀 {} 次后仍未退出 → \
                     记录未退出 PID 并放弃（Job Object 会在壳退出时兜底回收）\n",
                    chrono_now(),
                    machine.soft_attempts(),
                    machine.force_attempts()
                ));
                return;
            }
        }
    }
}

/// `taskkill` 的结局。区分「被拒绝」与「其它失败」是为了让**测试能区分环境与代码**：
/// 受限环境（沙箱/低完整性令牌，`taskkill` 报 `Access denied`）下不该把测试判成代码缺陷，
/// 但同一环境下若出现「命令不存在 / 参数错误」就一定是代码写错了。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TaskkillOutcome {
    /// 命令成功（进程已被终止）
    Ok,
    /// 系统拒绝（`Access denied`）：调用方令牌缺少 PROCESS_TERMINATE 权限
    Denied,
    /// 其它失败（命令不存在、参数错误、目标不存在等）
    Failed,
    /// 非 Windows 平台：空实现
    #[cfg(not(target_os = "windows"))]
    Unsupported,
}

/// `taskkill /PID <pid> /T [/F]`，同步等待并返回结局。
/// 不带 `/F` = 向进程（及 `/T` 覆盖的子树）发关闭请求，等价于 Windows 上的 SIGTERM；
/// 带 `/F` = 强杀。创建标志 0x0800_0000 = CREATE_NO_WINDOW（不留黑框）。
fn taskkill(pid: u32, force: bool) -> TaskkillOutcome {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut args = vec!["/PID".to_string(), pid.to_string(), "/T".to_string()];
        if force {
            args.push("/F".to_string());
        }
        let out = std::process::Command::new("taskkill")
            .args(&args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .creation_flags(0x0800_0000)
            .output();
        match out {
            Ok(o) if o.status.success() => TaskkillOutcome::Ok,
            Ok(o) => {
                // 判据顺序（2026-09-25 修正）：Windows 控制台程序的错误串是**系统 OEM 代码页**
                // （简体中文为 GBK），`from_utf8_lossy` 之后中文会变成 U+FFFD ⇒ **只靠文本匹配
                // 不可靠**（本机实测：权限拒绝被误判成 `Failed`，进而让回归测试假红）。改为三条：
                //   ① 用法错误（taskkill 的用法提示是纯 ASCII，与代码页无关）⇒ Failed，是真缺陷；
                //   ② 文本命中 denied / 拒绝访问 ⇒ Denied；
                //   ③ 否则以**目标进程是否仍存活**为准：仍活着 ⇒ 系统拒绝（Denied）；
                //      已死 ⇒ 其实成功了（Ok，属竞态）。
                let text = format!(
                    "{}{}",
                    String::from_utf8_lossy(&o.stdout),
                    String::from_utf8_lossy(&o.stderr)
                )
                .to_ascii_lowercase();
                if text.contains("invalid argument")
                    || text.contains("invalid syntax")
                    || text.contains("error: invalid")
                {
                    TaskkillOutcome::Failed
                } else if text.contains("access is denied")
                    || text.contains("access denied")
                    || text.contains("拒绝访问")
                    || backend_process_alive(pid)
                {
                    TaskkillOutcome::Denied
                } else {
                    TaskkillOutcome::Ok
                }
            }
            Err(_) => TaskkillOutcome::Failed,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (pid, force);
        TaskkillOutcome::Unsupported
    }
}

/* ---------------- 孤儿回收：Job Object（T2.4） ---------------- */

/// 自拉后端进程所属的 Job。`KILL_ON_JOB_CLOSE` 语义 = 「本句柄关闭时干掉 Job 内所有进程」，
/// 因此壳**正常退出**与**异常消亡**（崩溃 / 被任务管理器结束）都会被 OS 统一回收整棵
/// 进程树 —— 这是官方 `SIGTERM→SIGKILL` 阶梯在 Windows 上更根本的等价物。
/// 注意判据 ①：**只纳入本应用拉起的后端**，采用的外部后端不进 Job（那本来就不该被我们杀）。
/// 注意判据 ②：`kill_spawned_dsh` 判定「有外部客户端 → 保留后端」时，必须先
/// `retain_job_until_exit()` 把 Job 摘掉，否则壳一退就把人家的连接拖走（断线事故重演）。
static BACKEND_JOB: std::sync::Mutex<Option<isize>> = std::sync::Mutex::new(None);

/// 创建 Job 并设 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。返回 Job 句柄。
/// 只设这一个限制标志：不设 UI/内存/进程数上限，避免给后端套上未知副作用。
#[cfg(target_os = "windows")]
fn open_kill_on_close_job() -> Option<isize> {
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, SetInformationJobObject, JobObjectExtendedLimitInformation,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    };
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let info = job_limit_info();
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            use windows_sys::Win32::Foundation::CloseHandle;
            let _ = CloseHandle(job);
            return None;
        }
        Some(job as isize)
    }
}

#[cfg(not(target_os = "windows"))]
fn open_kill_on_close_job() -> Option<isize> {
    None
}

/// Job 限制参数（**纯函数**，单测覆盖）：只置 `KILL_ON_JOB_CLOSE` 一个标志。
///
/// 为什么单独抽出来：这是「壳一死，整棵进程树被 OS 回收」这条保证的唯一开关，
/// 它错了就是静默失效（Job 建得出来、子进程也进去了，但退出时谁也不死）。
/// 抽成纯函数后可以在单测里直接断言标志位与「其它字段全部为零」。
#[cfg(target_os = "windows")]
fn job_limit_info() -> windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    use windows_sys::Win32::System::JobObjects::{
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    info
}

/// 把子进程纳入 Job。失败只落一行日志（不阻断启动）：Job 是**保险**，
/// 不是后端能否跑起来的前提。
#[cfg(target_os = "windows")]
fn assign_to_backend_job(child: &std::process::Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    let Some(job) = *BACKEND_JOB.lock().unwrap() else { return };
    let handle = child.as_raw_handle() as *mut core::ffi::c_void;
    let ok = unsafe { AssignProcessToJobObject(job as *mut core::ffi::c_void, handle) };
    if ok == 0 {
        app_log_line(&format!(
            "[{}] job: 后端 pid {} 纳入 Job 失败（子进程已退出或权限不足）\n",
            chrono_now(),
            child.id()
        ));
    }
}

#[cfg(not(target_os = "windows"))]
fn assign_to_backend_job(_child: &std::process::Child) {}

/// 「壳退出但后端保留」路径：把 Job 句柄从静态里取出并**永不关闭**（静态槽位此后为
/// None，没有任何路径会去关它）—— 等价于「本进程没有 Job」的历史行为，后端得以留在
/// 3080 上继续服务浏览器等外部客户端。
///
/// 代价（认账）：此后若壳异常消亡，**已经是孤儿的前后端**不会再被 Job 回收，只能靠
/// 用户侧任务管理器。这是刻意的取舍 —— 2026-09-23 断线事故的修复优先级高于兜底回收，
/// 且该场景下后端本来就「有别的用户在用」，本就不该被回收。
fn retain_job_until_exit() {
    let taken = BACKEND_JOB.lock().unwrap().take();
    if taken.is_some() {
        app_log_line(&format!(
            "[{}] job: 外部客户端在用后端 → 摘除 Job（句柄保留到进程终结，不再 KILL_ON_CLOSE）\n",
            chrono_now()
        ));
    }
}

/// 确认关闭：走分级停机停后端 + 退出。
fn shutdown_app(app: &AppHandle) {
    app_log_line(&format!("[{}] shutdown confirmed\n", chrono_now()));
    // 先告知后端看门狗「这是主动关闭」：它下一轮即退出，不会在关闭流程里重拉后端。
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    kill_spawned_dsh();
    app.exit(0);
}

/// 真退出请求：唤起主窗口并显示前端确认弹窗（主题自绘，见 `themes/src/07-dialog.js`）。
/// 所有**退出**入口统一：托盘「退出」/ 桌宠「退出应用」；前端确认后走 hash `cmd=shutdown`
/// （`shutdown_app` → 分级停机停后端 → 退出）。
///
/// 兜底：5s 内再次请求（前端弹窗无响应、用户连点）→ 直接退出，**不杀后端**
/// （与 `shutdown_app` 的分级停机刻意区分）。
pub(crate) fn request_close(app: &AppHandle) {
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
        app_log_line(&format!(
            "[{}] quit repeated (frontend unresponsive?) → force exit, backend kept\n",
            chrono_now()
        ));
        app.exit(0);
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.eval("window.__miasakiOpenCloseDialog && window.__miasakiOpenCloseDialog()");
    }
}

/// W3.1（2026-09-25）**关闭 = 隐藏到托盘**（对齐官方桌面端语义）。
///
/// 语义变更：点关闭按钮 / Alt+F4 / 任务栏关闭**不再退出应用**，而是隐藏到托盘；
/// 真正退出只经托盘「退出」或桌宠「退出应用」（那条路径保留前端确认弹窗 + `cmd=shutdown`
/// 的分级停机）。
///
/// 首次隐藏前弹**一次**原生确认，确认后写 marker 文件记住；用户取消则什么都不做
/// （窗口保持可见），下次仍会问。marker 让这个交互**可重放、可测试**——删掉文件即回到首次态。
fn hide_to_tray(app: &AppHandle) {
    if !background_close_acknowledged() {
        if !confirm_background_close() {
            app_log_line(&format!(
                "[{}] background close declined by user → keep window visible\n",
                chrono_now()
            ));
            return;
        }
        write_background_close_marker();
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    app_log_line(&format!("[{}] main window hidden to tray\n", chrono_now()));
}

/// marker 路径：与 `server.log` / `pet.log` 同目录（`%LOCALAPPDATA%\miasaki`），
/// 用户点「打开日志目录」时能一并看到，不另造目录。
fn background_close_marker() -> std::path::PathBuf {
    log_dir().join("background-close-confirmed")
}

fn background_close_acknowledged() -> bool {
    background_close_marker().exists()
}

fn write_background_close_marker() {
    let p = background_close_marker();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // 写不进去不阻断流程（代价只是下次再问一遍），但必须留痕
    if let Err(e) = std::fs::write(&p, b"") {
        app_log_line(&format!(
            "[{}] background close marker write failed: {e}\n",
            chrono_now()
        ));
    }
}

/// 首次「关闭 = 隐藏到托盘」的一次性原生确认。
/// 用 Win32 `MessageBoxW` 而非 Tauri dialog：本函数不需要 WebView2 参与，
/// 与 `recovery.rs` 的恢复对话框同一条纪律（主界面健康度不可信时不依赖前端）。
#[cfg(target_os = "windows")]
fn confirm_background_close() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDOK, MB_ICONINFORMATION, MB_OKCANCEL, MB_SETFOREGROUND, MB_TOPMOST,
    };
    let text: Vec<u16> = "关闭后 Miasaki 会继续在后台运行（桌宠与后端保持工作），\
可以从任务栏托盘图标重新打开或退出。\n\n确定继续吗？"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let caption: Vec<u16> = "Miasaki".encode_utf16().chain(std::iter::once(0)).collect();
    let r = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_OKCANCEL | MB_ICONINFORMATION | MB_TOPMOST | MB_SETFOREGROUND,
        )
    };
    r == IDOK
}

#[cfg(not(target_os = "windows"))]
fn confirm_background_close() -> bool {
    true
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
        // 纳入 Job（KILL_ON_JOB_CLOSE）：壳异常消亡时由 OS 回收整棵进程树，
        // 不再依赖「关闭流程跑到了」这个前提（见 BACKEND_JOB 的注释）。
        assign_to_backend_job(&child);
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

/// 把主窗口导航到 DSH 后端地址。
///
/// 刻意不用 `expect`：`remote_url()` 可被环境变量 `MIASAKI_REMOTE` 覆盖（见其定义），
/// 非法值会让 `Url::parse` 失败，而 release 构建是 `panic = "abort"`（Cargo.toml）
/// ——一处配置写错就终结整个桌面端进程。这里与 backend-watchdog 的 `if let Ok(url)`
/// 保持同一容错口径，失败信息交给调用方做用户可见反馈。
fn navigate_main(app: &AppHandle) -> Result<(), String> {
    let target = remote_url();
    let url = tauri::Url::parse(&target).map_err(|e| format!("远端地址无效（{target}）：{e}"))?;
    let wv = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    wv.navigate(url).map_err(|e| e.to_string())
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
                if let Err(e) = navigate_main(&app) {
                    // 导航失败不再静默（原实现 `let _ = wv.navigate(…)` 会让界面永远停在
                    //「已就绪，正在进入…」）：落盘 + 状态栏可见反馈 + 放出重试按钮。
                    app_log_line(&format!("[{}] launch: 导航失败：{e}\n", chrono_now()));
                    // T2.1：给这次失败留一份可带走的现场（web-boot 源）
                    let _ = diag::report(
                        diag::Source::WebBoot,
                        "首屏导航失败",
                        &format!("navigate failed: {e}\ntarget: {}\n", remote_url()),
                    );
                    set_status(&app, &format!("进入 DSH 失败：{e}。请点击「重试」重新进入。"));
                    eval_status(&app, "window.__setRetry && window.__setRetry(true)");
                    return;
                }
                start_hash_watchdog(&app);
                start_pulse_watchdog(&app);
                // T2.2 进程内看门狗（独立 OS 线程，只归属主窗 UI 心跳）：
                // 与 hash 轮询同批启动 —— 后者第一次成功 `wv.url()` 就会喂上首个心跳。
                diag::spawn_ui_watchdog();
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
            // 90s 未就绪：提示排查方向（只提示一次；继续轮询，用户手动修复后自动进入）
            // 归因保留两种可能：端口被别的实例占用，或 dsh 拉起后立即退出（spawn 成功≠进程活着，
            // 此处只试拉一次，见下方 spawn_attempted）。
            if started.elapsed() > BOOTSTRAP_TIMEOUT && !timeout_hinted {
                timeout_hinted = true;
                update_bootstrap_attempt(
                    "waiting",
                    Some("端口 3080 长时间未就绪：可能被其他程序占用，或 dsh 拉起后立即退出"),
                    None,
                );
                set_status(
                    &app,
                    "DSH 服务长时间未就绪：可能端口 3080 被占用，或 dsh 拉起后立即退出。请点击「打开终端」运行 netstat -ano | findstr 3080 排查。",
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
                    // T2.1：后端拉不起来是 host 侧故障，留现场（含 server.log 尾）
                    let _ = diag::report(
                        diag::Source::Host,
                        "自动重拉 dsh web 失败",
                        &format!("respawn failed: {e}\nreason: {reason}\n"),
                    );
                }
            }
        }
    });
}

/* ---------------- hash 命令/状态通道（33ms 轮询，跟手拖窗） ---------------- */

/// hash 片段解析结果。M2(v3) 新增官方契约三字段：pet=<六态> / pettool=<工具名> / petts=<心跳 ms>；
/// R4(2026-09-16) 再增 petkey=<审批稳定身份，官方 PendingApproval.key>。
///
/// **deprecated（T0.3，2026-09-25）**：`move_*` 保留但已无写者 —— 拖动改走 Tauri 原生
/// `start_dragging`（`themes/src/06-titlebar.js` 的 `data-tauri-drag-region`，
/// 全仓已无任何 `move=` 写入点，只在本文件残留解析）。**刻意不删**：
/// 老版本注入产物（`injected/theme-init.js` 是构建产物，可能仍是旧的一版）在升级窗口期
/// 还会写 `move=`，删掉解析会让它们静默失效。真正清理待下一次注入产物重建后一并做。
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
    /// deprecated：见 `FragmentParts` 的文档注释（渲染层已无写者，仅留兼容期）。
    move_xy: Option<(i32, i32)>,
    /// deprecated：同上。
    move_reset: bool,
    seq: i64,
    /// W4.3（2026-09-25）：渲染层实测的窗口底色（6 位十六进制、不带 `#`）。
    /// **只在 Mica 不可用（回退实色底）时消费**——Mica 生效时窗口底必须保持透明，
    /// 否则会把系统材质整个盖掉（见 `apply_window_bg`）。
    bg: Option<String>,
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
        bg: None,
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
        // W4.3：窗口底色。只接受 6 位十六进制（渲染层不产出 `#`——它会截断 fragment）；
        // 校验不过即忽略，**绝不把脏值透给 `apply_window_bg`**。
        if let Some(v) = part.strip_prefix("bg=") {
            if v.len() == 6 && v.bytes().all(|b| b.is_ascii_hexdigit()) {
                p.bg = Some(v.to_ascii_lowercase());
            }
        }
        // deprecated（T0.3）：拖动已改走 Tauri 原生 start_dragging，渲染层无写者。
        // 保留解析 = 兼容升级窗口期里仍是旧版的注入产物；见 FragmentParts 的注释。
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
                    // T2.2 心跳喂点：`wv.url()` 是一次「派发到主线程」的 WebView2 同步
                    // COM 调用（见本节开头的性能审查注释），它**返回**就证明主窗消息泵
                    // 当轮还在转。代价 = 一次原子 store，正常路径零额外开销。
                    diag::heartbeat();
                    // 可见性一并上报（T2.2 防御，2026-09-25）：隐藏到托盘 / 最小化时看门狗
                    // 放宽阈值（5s → 90s）—— WebView2 对不可见宿主可能有节流，按 5s 判会把
                    // 节流误报成挂起，而**假报告比漏报更伤诊断可信度**。
                    // `is_visible() && !is_minimized()`：最小化时 `is_visible()` 仍是 true，
                    // 但窗口对用户不可见，两者都要判。
                    diag::set_ui_visible(
                        wv.is_visible().unwrap_or(true) && !wv.is_minimized().unwrap_or(false),
                    );
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
            // 挂起现场要用「最后一次 hash fragment」，在同一个观察点上顺手记下（零拷贝路径）
            diag::note_hash_fragment(fragment);
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
                // 2026-09-24:隐藏态悬浮球的球面（主题头像 + 主题色环）跟随主题切换；
                // 白名单校验在 set_theme 内部（hash 字段不可信），窗口线程变化才重绘。
                pet.set_theme(&t);
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
                // deprecated（T0.3）：此分支已无渲染层写者（拖动走原生 start_dragging）。
                // 保留 = 不让升级窗口期里仍是旧版的注入产物「拖窗突然失灵」。
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
            // W4.3：窗口底色回传 —— 仅 Mica 未生效时应用（见 apply_window_bg 的两条纪律）
            if let Some(bg) = parts.bg.as_deref() {
                apply_window_bg(&wv, bg);
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
                        // W3.1：标题栏关闭按钮与系统关闭路径语义一致 —— 隐藏到托盘
                        "close" => hide_to_tray(&app),
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

/* ---------------- 恢复动作（T2.3：原生恢复对话框） ---------------- */

/// 弹恢复对话框（退出 / 重启 / 停用第三方插件后重启）。
///
/// 两个入口共用本函数：
/// ① Rust 侧失败路径（看门狗挂起 30s、启动失败可见化）；
/// ② 页面侧 `invoke('recovery_dialog', { reason })` —— 本地 loading 页在失败态
///    可以调它，无需 WebView2 健康（对话框本身是 Win32 的）。
///
/// **绝不自动强杀**：用户点了才动作（先取证，后恢复）。
pub(crate) fn request_recovery_dialog(owner: Option<isize>, reason: String) {
    let Some(app) = RECOVERY_APP.get().cloned() else {
        // 壳还没进 setup（连窗口都没有）时静默放弃：此时没有任何可恢复的界面。
        return;
    };
    let owner = owner.or_else(|| native_owner_hwnd(&app));
    recovery::offer(owner, reason, move |choice| apply_recovery_choice(&app, choice));
}

/// 恢复对话框的回调需要 AppHandle，但 `recovery::offer` 刻意不依赖 tauri
/// （保持模块无副作用、可单测）。用一次写入的 AppHandle 把两者接上。
static RECOVERY_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

fn apply_recovery_choice(app: &AppHandle, choice: recovery::Choice) {
    match choice {
        recovery::Choice::Quit => {
            app_log_line(&format!("[{}] recovery: 用户选择「退出」\n", chrono_now()));
            shutdown_app(app);
        }
        recovery::Choice::Restart => {
            app_log_line(&format!("[{}] recovery: 用户选择「重启」\n", chrono_now()));
            restart_app(false);
        }
        recovery::Choice::RestartSafe => {
            app_log_line(&format!("[{}] recovery: 用户选择「停用第三方插件后重启」\n", chrono_now()));
            restart_app(true);
        }
    }
}

/// 重启：**先停后端 + 退出本进程，再拉起新实例**。
///
/// 顺序不能反：单实例插件（`tauri-plugin-single-instance`）是以「持有锁的旧进程退出」
/// 为放行条件的，先起新进程只会让新实例判成「已有实例」而立刻退出（或把焦点抢给旧窗）。
/// 因此起进程放在 `app.exit(0)` 之前，但新进程自带就绪重试；退出的同时旧实例锁释放。
fn restart_app(disable_plugins: bool) {
    if disable_plugins {
        match recovery::profile_dir() {
            Some(dir) => match recovery::sanitize_profile(&dir, chrono_now_ms()) {
                Ok(notes) => app_log_line(&format!(
                    "[{}] recovery: 已停用第三方插件（profile {}）\n{notes}\n",
                    chrono_now(),
                    dir.display()
                )),
                Err(e) => app_log_line(&format!(
                    "[{}] recovery: 停用第三方插件失败，**中止重启**（原文件保持不动）：{e}\n",
                    chrono_now()
                )),
            },
            None => app_log_line(&format!(
                "[{}] recovery: 定位不到 profile 目录 → 跳过插件停用，按普通重启继续\n",
                chrono_now()
            )),
        }
    }
    let exe = std::env::current_exe();
    match &exe {
        Ok(path) => {
            let spawn = std::process::Command::new(path).spawn();
            match spawn {
                Ok(child) => app_log_line(&format!(
                    "[{}] recovery: 已拉起新实例 pid {} → 本实例退出\n",
                    chrono_now(),
                    child.id()
                )),
                Err(e) => app_log_line(&format!(
                    "[{}] recovery: 拉起新实例失败：{e} → 仍执行退出（用户可手动重开）\n",
                    chrono_now()
                )),
            }
        }
        Err(e) => app_log_line(&format!(
            "[{}] recovery: 取不到自身路径：{e} → 仍执行退出\n",
            chrono_now()
        )),
    }
    if let Some(app) = RECOVERY_APP.get() {
        shutdown_app(app);
    }
}

/// 页面侧入口：失败页/远程页都可 invoke（`reason` 缺失时给一句通用文案）。
#[tauri::command]
fn recovery_dialog(reason: Option<String>) {
    request_recovery_dialog(
        None,
        reason.unwrap_or_else(|| "启动或运行过程中出现异常".to_string()),
    );
}

/// 取证入口：任何时候都可以让壳落一份诊断报告（页面「反馈问题」按钮、插件自检用）。
/// `source` 可选：main / host / renderer / web-boot / watchdog（缺省 main）。
#[tauri::command]
fn diag_report(reason: Option<String>, source: Option<String>) -> Result<String, String> {
    let reason = reason.unwrap_or_else(|| "用户手动触发".to_string());
    let source = source
        .as_deref()
        .and_then(diag::Source::parse)
        .unwrap_or(diag::Source::Main);
    let error = format!(
        "manual report\nlast hash fragment: {}\n--- 关键全局状态 ---\n{}\n--- 后端存活性 ---\n{}\n",
        diag::last_hash_fragment(),
        globals_snapshot(),
        backend_liveness_snapshot(),
    );
    diag::report(source, &reason, &error)
        .map(|p| p.display().to_string())
        .map_err(|e| format!("诊断报告落盘失败：{e}"))
}

/// renderer 侧 console 回传入口（`--- renderer console ---` 段的喂点）。
///
/// 现状：**注入链尚未挂 hook**（那属于 `themes/` 的改动面，本轮不动），因此这个命令
/// 目前是「通道已就位、写者待接」状态；远程页也拿不到 IPC 权限，真要接需走 hash 通道
/// 或官方 `index-inject`（见设计文档 §1.1）。报告里该段为空时会有显式说明，不会误导。
#[tauri::command]
fn diag_console(lines: Vec<String>) {
    for line in lines.iter().take(64) {
        diag::push_console_line(line);
    }
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

/// **原生材质预判**（W4.2，2026-09-25）：窗口创建时 `initialization_script` 里先给一个
/// 预期值，让外观线的 boot style 在**首帧**就能选对分支（`data-mia-native-mica`）。
///
/// 为什么需要预判：`apply_mica` 要拿到 hwnd 才能试（`DwmSetWindowAttribute` 的返回值才是真相），
/// 而 `initialization_script` 是 builder 参数、必须在此之前定稿 —— 首帧拿不到"实际值"。
/// 判据：未显式禁用 **且** 系统 build ≥ 22000（Win11）。实际结果与之不符时由
/// `push_native_material` 在页面就绪后**广播修正**。
fn native_mica_expected() -> bool {
    if no_mica_requested() {
        return false;
    }
    diag::windows_build_number().map(|b| b >= 22000).unwrap_or(false)
}

/// 把**原生材质是否生效**广播给页面（W4.2）。与 `push_max_state` 同构：eval 设属性 + 派发事件。
///
/// 页面侧（`themes/src/12-material.js`）据此维护 `html[data-mia-native-mica="on|off"]`，
/// 外观线的 `mica` 档玻璃规则挂在 `:not([data-mia-native-mica="on"])` 上 ——
/// **原生云母生效时撤掉页面侧 backdrop-filter**，避免 Chromium 模糊与 DWM 材质叠成两层。
fn push_native_material(app: &AppHandle) {
    let mica = MICA_ACTIVE.load(Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(&format!(
            "(function(){{try{{var r=document.documentElement;\
             r.setAttribute('data-mia-native-mica','{attr}');\
             window.dispatchEvent(new CustomEvent('miasaki-native-material',{{detail:{{mica:{mica}}}}}));\
             }}catch(e){{}}}})()",
            attr = if mica { "on" } else { "off" },
            mica = mica
        ));
    }
}

/// 用系统默认浏览器打开 URL（W5 自更新降级方案）。
///
/// 用 Win32 `ShellExecuteW` 而不是 `cmd /C start`：后者要再经一次 shell 解析，
/// 而这个 URL 来自**用户自管配置**——即便已在 `update::parse_source` 校验过 http(s)，
/// 也不该把"再解析一次"的机会留在链上。
#[cfg(target_os = "windows")]
fn open_in_browser(url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let op: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
    let file: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    let r = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW 的约定：返回值 > 32 才是成功（≤ 32 是错误码）
    if (r as isize) > 32 {
        Ok(())
    } else {
        Err(format!("ShellExecuteW 返回 {r:?}"))
    }
}

#[cfg(not(target_os = "windows"))]
fn open_in_browser(_url: &str) -> Result<(), String> {
    Err("仅 Windows 支持".to_string())
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
        MICA_ACTIVE.store(false, Ordering::SeqCst);
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
    // W4.3：记下材质是否真的生效 —— 只有「未生效」时才允许渲染层回传的底色接管窗口底。
    MICA_ACTIVE.store(ok, Ordering::SeqCst);
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

/// W4.3（2026-09-25）消费渲染层回传的窗口底色（6 位十六进制，无 `#`）。
///
/// 为什么需要：窗口创建时的底色是**硬编码两档**（见 `window_bg`）且只算一次，
/// 运行期切主题 / 换皮肤不会更新 —— Win10（Mica 不可用）下会露出旧主题的实色底。
/// 渲染层知道真实底色（`themes/src/02-core.js` 的 `resolveNativeBg`，半透明会先合成到不透明），
/// 经 hash `bg=` 回传到这里。
///
/// 两条纪律：
/// ① **Mica 生效时一律不动**（`MICA_ACTIVE`）—— 那时窗口底必须透明，否则盖掉系统材质；
/// ② 入参已在 `parse_fragment` 校验过，这里再解析一次失败即**静默忽略**（不 panic、不猜色）。
#[cfg(target_os = "windows")]
fn apply_window_bg(wv: &tauri::WebviewWindow, hex: &str) {
    if MICA_ACTIVE.load(Ordering::SeqCst) {
        return;
    }
    if let Some(rgb) = parse_hex_color(hex) {
        let _ = wv.set_background_color(Some(tauri::utils::config::Color(
            rgb[0], rgb[1], rgb[2], 255,
        )));
    }
}

/// `RRGGBB` / `rrggbb` → `[r, g, b]`；长度或字符不合即 `None`（**不猜测、不 panic**）。
/// 平台无关且无副作用，便于单测 —— `apply_window_bg` 本身要窗口句柄，测不动。
fn parse_hex_color(hex: &str) -> Option<[u8; 3]> {
    let bytes = hex.as_bytes();
    if bytes.len() != 6 {
        return None;
    }
    let mut rgb = [0u8; 3];
    for (i, slot) in rgb.iter_mut().enumerate() {
        let hi = (bytes[i * 2] as char).to_digit(16)?;
        let lo = (bytes[i * 2 + 1] as char).to_digit(16)?;
        *slot = ((hi << 4) | lo) as u8;
    }
    Some(rgb)
}

#[cfg(not(target_os = "windows"))]
fn apply_window_bg(_wv: &tauri::WebviewWindow, _hex: &str) {}

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
    // T2.1 取证第一步，必须**最先**装：release 是 `panic = "abort"`（Cargo.toml），
    // panic 之后没有 unwind 机会——报告只能在 panic 发生点由 hook 就地落盘。
    // 启动期的 expect（建窗 / 托盘）同样落在这条链上。
    diag::install_panic_hook();
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
            set_auth_cookie,
            recovery_dialog,
            diag_report,
            diag_console
        ])
        .on_window_event(|window, event| {
            if window.label() == "main" {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        save_window_state(window);
                        // W3.1：关闭 = 隐藏到托盘（首次弹一次原生确认 + marker 记忆），
                        // 不再触发退出流程；真正退出只经托盘「退出」/ 桌宠「退出应用」。
                        api.prevent_close();
                        hide_to_tray(window.app_handle());
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
            // T2.4：Job 必须在**任何 spawn_dsh 之前**建好——启动序列（下方
            // start_launch_sequence）随时可能拉起后端。失败不阻断启动（Job 是保险，不是前提）。
            match open_kill_on_close_job() {
                Some(job) => {
                    *BACKEND_JOB.lock().unwrap() = Some(job);
                    app_log_line(&format!(
                        "[{}] job: 已建立 KILL_ON_JOB_CLOSE Job（自拉后端将纳入，壳消亡时由 OS 回收进程树）\n",
                        chrono_now()
                    ));
                }
                None => app_log_line(&format!(
                    "[{}] job: 建立失败 → 孤儿回收退化为关闭流程里的 taskkill（最坏不劣化）\n",
                    chrono_now()
                )),
            }
            // 恢复对话框回调要用 AppHandle（弱耦合：recovery.rs 不依赖 tauri）
            let _ = RECOVERY_APP.set(app.handle().clone());

            // 素材服务先于窗口启动：启动页标题栏/纹章图标同源加载，避免 404 竞态
            start_asset_server();

            // 启动画面随上次主题：注入 __MIA_THEME__（持久化于 DSH 页主题选择，见 prefs）
            let theme = load_prefs().theme;
            let theme_json = serde_json::to_string(&theme).unwrap_or_else(|_| "\"pure\"".into());
            // W4.2：原生材质**预判值**随 init 一起注入 —— 注入层在 document_start 据此落
            // `data-mia-native-mica` 属性，外观线的 boot style（属性选择器）首帧即选对分支；
            // 页面就绪后由 `push_native_material` 用 DWM 的实际结果广播修正。
            let mica_expected = if native_mica_expected() { "true" } else { "false" };
            let init = format!(
                "window.__MIA_THEME__={theme_json};\nwindow.__MIA_NATIVE_MICA__={mica_expected};\n{INIT_SCRIPT}"
            );
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
                // 拖拽上传附件到会话（design/drag-drop-attachment-upload.md §4.1）：
                // tauri-runtime-wry 默认注册 drag-drop handler，会在 WebView2 上先
                // SetAllowExternalDrop(false) 再 RegisterDragDrop，把页面级 HTML5 拖放
                // 整体拦成无人监听的 tauri://drag-drop 窗口事件（drop 静默丢失）。禁用后
                // WebView2 原生拖放直达页面，官方 ComposerAttachments 的 document 级 DnD
                // 与上传全链路照常工作；本壳无人监听 tauri://drag-drop，零损失。
                // 其它页面/启动页的兜底由注入层 09-dropguard.js 与 loading.html 负责。
                .disable_drag_drop_handler()
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
                        // 延迟推一次最大化状态与**原生材质实际值**：eval INIT_SCRIPT 后页面监听
                        // 已就绪（重启后恢复上次窗口尺寸时的初始图标同样正确）
                        let app2 = webview.app_handle().clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(600)).await;
                            push_max_state(&app2);
                            // W4.2：用 DWM 的**实际**结果修正 init 里的预判值
                            push_native_material(&app2);
                        });
                    }
                })
                .build()
                .expect("failed to build main window");

            // 【可见性兜底】窗口以 visible(false) 建出，正常路径靠 on_page_load 回调 show()。
            // 但 WebView2 对不可见宿主有可见性优化：窗口隐藏时可能根本不加载首帧页面，
            // 于是 on_page_load 永不触发 → show() 永不执行 → 主窗口永久不可见（打不开）。
            // 判据必须是「窗口当前是否可见」本身：不可借用 PAGE_UP——后者语义是
            //「3080 文档加载成功」（on_page_load 命中远程 URL 才置位），后端冷启动要 3~6s，
            // 800ms 时必然为 false，会让兜底每次都误触发、观测数据失真。
            // 兜底只补一次 show()：WebView2 一旦可见即恢复加载，on_page_load 随后照常走原流程；
            // 正常路径下 loading.html 已 show 过 → 判据为 false → 不动作，天然幂等。
            {
                let wv_fb = webview.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    // 三态分明（2026-09-23 复审 P3）：`is_visible()` 的 Err 与 Ok(false) 是两件事。
                    // 原来用 `unwrap_or(false)` 把 Err 归到「仍不可见」，用户 800ms 内关窗时
                    // 会留下一条「on_page_load 未触发？」的误导日志（其 show() 同样 Err 且被吞）。
                    // 两分支都仍尝试 show()（兜底目的不变、幂等无害），只是日志各说各的。
                    match wv_fb.is_visible() {
                        Ok(true) => {}
                        Ok(false) => {
                            app_log_line(&format!(
                                "[{}] boot: 800ms 窗口仍不可见（on_page_load 未触发？）→ 兜底 show()\n",
                                chrono_now()
                            ));
                            let _ = wv_fb.show();
                        }
                        Err(e) => {
                            app_log_line(&format!(
                                "[{}] boot: 800ms 可见性查询失败（{e}）→ 仍尝试兜底 show()（窗口多半已关闭）\n",
                                chrono_now()
                            ));
                            let _ = wv_fb.show();
                        }
                    }
                });
            }

            // 【启动失败可见化】2026-09-25 排查「桌面端打不开」时新增。
            // 现象：桌宠正常出现，主界面窗口却永远不出现，且全程无任何提示。
            // 机理：WebView2 环境创建失败时（典型诱因是进程写不了
            // %LOCALAPPDATA%\com.miasaki.desktop\EBWebView 这个用户数据目录——被安全软件
            // 或「受控文件夹访问」拦截时正是如此），`WebviewWindowBuilder::build()`
            // 仍返回 Ok，但窗口句柄随即被回收（实测 `hwnd()` 报
            // "the underlying handle is not available"）：主窗既不显示，上面的兜底
            // show() 也只能静默失败。用户侧看到的就是「双击后什么都没有」。
            // 处置：兜底之后复查一次，仍不可见即判定初始化失败 → 落盘 + 原生弹窗，
            // 把原因与排查方向摆到用户面前，杜绝这类哑巴失败。
            {
                let wv_check = webview.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(2600)).await;
                    let failed = match wv_check.is_visible() {
                        Ok(visible) => !visible,
                        Err(_) => true,
                    };
                    if !failed {
                        return;
                    }
                    let ts = chrono_now();
                    app_log_line(&format!(
                        "[{ts}] boot: 主窗 2.6s 后仍不可见 → 判定 WebView2 初始化失败（进程写不了 EBWebView 用户数据目录？）\n"
                    ));
                    // T2.1：WebView2 初始化失败也要留现场（web-boot 源）。
                    // 注意：被降权到 Low 完整性时可能连日志目录都写不了 —— 报告失败无所谓，
                    // 用户可见的那条弹窗仍然给出处置路径。
                    let _ = diag::report(
                        diag::Source::WebBoot,
                        "WebView2 初始化失败（主窗 2.6s 仍不可见）",
                        &format!(
                            "main window still invisible after 2600ms\nexe: {}\nlog dir: {}\n",
                            std::env::current_exe()
                                .map(|p| p.display().to_string())
                                .unwrap_or_else(|_| "?".into()),
                            log_dir().display()
                        ),
                    );
                    // 【文案分流】2026-09-25 本机实测：用户可写目录（%USERPROFILE% 之下，含桌面 /
                    // 文档 / %LOCALAPPDATA% / 仓库内 dist）里的 exe 一律被降权到 Low 完整性级别，
                    // 写不了 EBWebView 用户数据目录 —— 这才是本机「只剩桌宠」的主因。此时
                    // 「加安全软件白名单」是无效建议，必须点名正确的启动入口；反之（exe 已在
                    // 系统目录）保留原来的安全软件排查方向。
                    let exe_path = std::env::current_exe()
                        .map(|p| p.display().to_string())
                        .unwrap_or_else(|_| "?".into());
                    let exe_lower = exe_path.to_lowercase();
                    let user_profile = std::env::var("USERPROFILE").unwrap_or_default().to_lowercase();
                    let in_user_dir =
                        !user_profile.is_empty() && exe_lower.starts_with(&user_profile);
                    let head = if in_user_dir {
                        "直接原因（本机实测）：程序从「用户可写目录」启动会被系统降权到低完整性\n\
                         级别，写不了 %LOCALAPPDATA%\\com.miasaki.desktop，WebView2 因此起不来。\n\
                         加安全软件白名单、换文件名、换副本都无效，必须换到系统目录运行。\n\n\
                         请改用这个入口重新打开：\n\
                         C:\\ProgramData\\MiasakiApp\\Miasaki.exe\n\
                         （桌面上的「Miasaki 桌面端」快捷方式即指向它）\n\n"
                    } else {
                        "最常见原因：安全软件或「受控文件夹访问」拦截了本程序对\n\
                         %LOCALAPPDATA%\\com.miasaki.desktop 的写入。\n\n\
                         处理建议：把 Miasaki.exe 加入安全软件白名单后重新打开。\n\n"
                    };
                    let msg = format!(
                        "Miasaki 主界面无法创建：WebView2 初始化失败。\n\n{}\
                         下一步：\n\
                         1. 先在任务管理器结束所有 Miasaki 进程（残留实例会让新实例直接退出）；\n\
                         2. 双击桌面「Miasaki 桌面端」重新打开；\n\
                         3. 若下方日志为空：被降权时进程写不进日志，属正常现象。\n\n\
                         启动位置：{}\n\
                         日志：{}\n\
                         日志目录：{}",
                        head,
                        exe_path,
                        log_dir().join("pet.log").display(),
                        log_dir().display()
                    );
                    // T2.3：错误弹窗关掉后接恢复对话框（三按钮），失败路径不再是死胡同。
                    show_native_error_then_recover(wv_check.app_handle(), &msg);
                });
            }

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
                // 手动生成诊断报告（2026-09-25）：把取证链路从"出事才跑"变成"随手可跑"
                let diag_item = MenuItem::with_id(app, "diag", "生成诊断报告", true, None::<&str>)
                    .expect("menu item");
                // W5 自更新降级方案：只查、只提示、只打开下载页（绝不自己下载或安装）
                let update_item = MenuItem::with_id(app, "update", "检查更新", true, None::<&str>)
                    .expect("menu item");
                let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>).expect("menu item");
                let menu = Menu::with_items(app, &[&toggle, &diag_item, &update_item, &quit]).expect("menu");
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
                        "diag" => {
                            // 手动生成诊断报告（2026-09-25）：与自动路径同一套写入 + 轮转，
                            // 只是 source=manual。**成功与失败都要回显** —— 取证模块的唯一价值
                            // 就是"可诊断"，静默成功或静默失败都会毁掉它。
                            match diag::write_manual_report() {
                                Ok(path) => recovery::show_info(
                                    "生成诊断报告",
                                    &format!(
                                        "已生成诊断报告：\n{}\n\n该目录可在启动失败页用「打开日志目录」打开；最多保留最近 {} 份。",
                                        path.display(),
                                        diag::KEEP_REPORTS
                                    ),
                                ),
                                Err(e) => recovery::show_info(
                                    "生成诊断报告",
                                    &format!(
                                        "生成失败：{e}\n\n报告目录：{}\n请检查磁盘权限或空间后重试。",
                                        diag::reports_dir().display()
                                    ),
                                ),
                            }
                        }
                        "update" => {
                            // W5 自更新降级方案（2026-09-25）：**只查、只提示、只打开下载页** ——
                            // 绝不自己下载或安装（缺签名保管链 / CI / 安装前任务准入，
                            // 静默安装的风险是打断用户正在跑的会话）。
                            // `update::check` 会跑 curl（最长 15s）：放后台线程，
                            // 不阻塞托盘菜单的处理线程（那会让整个托盘卡住）。
                            let handle = app.clone();
                            std::thread::spawn(move || {
                                let current = handle.package_info().version.to_string();
                                match update::check(&current) {
                                    Ok(update::CheckOutcome::Newer { remote, page }) => {
                                        let go = recovery::show_confirm(
                                            "检查更新",
                                            &format!(
                                                "发现新版本：{remote}（当前 {current}）\n\n\
                                                 现在打开下载页吗？\n{page}\n\n\
                                                 （本应用不会自动下载或安装，更新由你手动完成。）"
                                            ),
                                        );
                                        if go {
                                            if let Err(e) = open_in_browser(&page) {
                                                recovery::show_info(
                                                    "检查更新",
                                                    &format!("无法打开下载页：{e}\n\n可手动访问：\n{page}"),
                                                );
                                            }
                                        }
                                    }
                                    Ok(update::CheckOutcome::UpToDate { current }) => recovery::show_info(
                                        "检查更新",
                                        &format!("已是最新版本（{current}）。"),
                                    ),
                                    Err(e) => recovery::show_info(
                                        "检查更新",
                                        &format!(
                                            "无法检查更新：{e}\n\n更新源配置在：\n{}",
                                            update::source_path().display()
                                        ),
                                    ),
                                }
                            });
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

    /* ---------------- T2.4：Job Object 与分级停机 ---------------- */

    /// Job 参数构造：只置 KILL_ON_JOB_CLOSE，其余字段必须全零
    /// （多置一个标志就可能给后端套上未知的 UI/内存/进程数限制）。
    #[cfg(target_os = "windows")]
    #[test]
    fn job_limit_info_sets_only_kill_on_job_close() {
        use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let info = job_limit_info();
        assert_eq!(info.BasicLimitInformation.LimitFlags, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
        assert_eq!(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 8192);
        // 未设任何资源上限
        assert_eq!(info.BasicLimitInformation.ActiveProcessLimit, 0);
        assert_eq!(info.BasicLimitInformation.MinimumWorkingSetSize, 0);
        assert_eq!(info.BasicLimitInformation.MaximumWorkingSetSize, 0);
        assert_eq!(info.BasicLimitInformation.PriorityClass, 0);
        assert_eq!(info.BasicLimitInformation.Affinity, 0);
        assert_eq!(info.ProcessMemoryLimit, 0);
        assert_eq!(info.JobMemoryLimit, 0);
        // 布局自检：结构体必须比 BASIC_LIMIT 大（含 IoInfo + 4 个 usize），且按 8 字节对齐。
        // 真正的「大小写错」由下面那条真机测试兜住（SetInformationJobObject 会直接失败）。
        use windows_sys::Win32::System::JobObjects::{
            JOBOBJECT_BASIC_LIMIT_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        };
        let ext = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        assert!(ext > std::mem::size_of::<JOBOBJECT_BASIC_LIMIT_INFORMATION>());
        assert_eq!(ext % 8, 0);
    }

    /// **真机进程级验证**：KILL_ON_JOB_CLOSE 不是「设了标志」就算数 —— 这里真建一个 Job、
    /// 把 `ping -n 60 127.0.0.1`（约 60s 不退出）放进去，然后关闭 Job 句柄，断言子进程随之消亡。
    /// 这正是「壳崩溃 → 后端进程树被 OS 回收」那条保证的最小可验证切片。
    #[cfg(target_os = "windows")]
    #[test]
    fn kill_on_job_close_really_kills_the_process() {
        use std::os::windows::io::AsRawHandle;
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

        let job = open_kill_on_close_job().expect("创建 Job 失败");
        let mut child = std::process::Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("拉起测试子进程失败");
        let pid = child.id();
        let assigned = unsafe {
            AssignProcessToJobObject(
                job as *mut core::ffi::c_void,
                child.as_raw_handle() as *mut core::ffi::c_void,
            )
        };
        assert_ne!(assigned, 0, "AssignProcessToJobObject 失败");
        // 等它真的跑起来，再确认它活着
        std::thread::sleep(Duration::from_millis(400));
        assert!(backend_process_alive(pid), "子进程本应存活");

        // 关闭 Job 句柄 = 模拟「壳进程消亡」→ 子进程必须被 OS 杀掉
        let closed = unsafe { CloseHandle(job as *mut core::ffi::c_void) };
        assert_ne!(closed, 0, "CloseHandle 失败");
        let mut dead = false;
        for _ in 0..40 {
            if !backend_process_alive(pid) {
                dead = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
        assert!(dead, "KILL_ON_JOB_CLOSE 未生效：子进程 pid {pid} 在 Job 关闭后仍存活");    }

    /// **真机实测（2026-09-25）与两处环境边界。**
    ///
    /// ① 语义：`taskkill` 不带 `/F` 只发 WM_CLOSE，**杀不掉控制台进程**（`cmd.exe` /
    ///    `node.exe` 没有窗口消息循环），所以软杀阶段注定白等 —— 这条写死在这里，
    ///    是为了让后人**不要**误以为「软杀成功了」而把强杀阶段裁掉。
    /// ② 环境：本仓库的测试沙箱（DSH 受限令牌）下 `taskkill` 对任何子进程都返回
    ///    `Access denied`，连强杀都不生效 —— 因此本测试**不断言总能杀掉**，而是断言
    ///    「三态可选集合」：Ok（真杀了）/ Denied（环境受限，可接受）/ Failed（一定是缺陷）。
    ///    这样在正常桌面会话里它是一条真回归，在沙箱里也不会给出假阴性。
    /// W4.3：`RRGGBB` 解析 —— 只认 6 位十六进制，其余一律 `None`（不猜、不 panic）。
    #[test]
    fn parse_hex_color_accepts_rrggbb_and_rejects_junk() {
        assert_eq!(parse_hex_color("0c0b11"), Some([12, 11, 17]));
        assert_eq!(parse_hex_color("F7F4F1"), Some([247, 244, 241]));
        assert_eq!(parse_hex_color("ffffff"), Some([255, 255, 255]));
        assert_eq!(parse_hex_color("000000"), Some([0, 0, 0]));
        assert_eq!(parse_hex_color(""), None);
        assert_eq!(
            parse_hex_color("#0c0b11"),
            None,
            "不得接受带 # 的形态（hash 里 # 会截断 fragment）"
        );
        assert_eq!(parse_hex_color("0c0b1"), None, "长度不足");
        assert_eq!(parse_hex_color("0c0b111"), None, "长度超出");
        assert_eq!(parse_hex_color("0c0b1z"), None, "非十六进制字符");
    }

    /// W4.3：`parse_fragment` 的 `bg=` 校验 —— 脏值不得透给 `apply_window_bg`。
    #[test]
    fn fragment_parses_bg_only_when_six_hex_digits() {
        assert_eq!(
            parse_fragment("miasaki-theme=zafkiel&bg=f7f4f1&diag=0")
                .bg
                .as_deref(),
            Some("f7f4f1")
        );
        assert_eq!(
            parse_fragment("bg=F7F4F1").bg.as_deref(),
            Some("f7f4f1"),
            "统一小写后再存"
        );
        assert_eq!(parse_fragment("bg=#f7f4f1").bg, None, "带 # 必须忽略");
        assert_eq!(parse_fragment("bg=f7f4").bg, None, "长度不足必须忽略");
        assert_eq!(parse_fragment("bg=zzzzzz").bg, None, "非十六进制必须忽略");
        assert_eq!(parse_fragment("miasaki-theme=pure").bg, None, "缺省即 None");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn taskkill_reports_ok_denied_or_failure_but_never_silently() {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
        let mut child = std::process::Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("拉起测试子进程失败");
        let pid = child.id();
        std::thread::sleep(Duration::from_millis(400));
        assert!(backend_process_alive(pid), "测试子进程本应存活");

        // 软杀：期望「无效」，但不允许出现 Failed（那意味着命令行写错了）
        let soft = taskkill(pid, false);
        assert_ne!(soft, TaskkillOutcome::Failed, "软杀命令行本身有误");
        std::thread::sleep(Duration::from_secs(2));
        let alive_after_soft = backend_process_alive(pid);

        // 强杀：必须给出确定结局
        let force = taskkill(pid, true);
        assert_ne!(force, TaskkillOutcome::Failed, "强杀命令行本身有误");
        if force == TaskkillOutcome::Ok {
            let mut dead = false;
            for _ in 0..40 {
                if !backend_process_alive(pid) {
                    dead = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            assert!(dead, "强杀报成功但 pid {pid} 仍存活");
            assert!(
                alive_after_soft,
                "软杀居然生效了 —— Windows 语义可能已变化，请复核 stop_backend_tiered 的注释"
            );
        } else {
            // 环境受限：留一条明确记录，并清理现场（不强杀就等它自己跑完，太慢）
            eprintln!(
                "[env] taskkill 被系统拒绝（Access denied）→ 沙箱环境限制，\
                 pid {pid} 由 child.kill() 清理；本项需在正常桌面会话复验"
            );
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}
