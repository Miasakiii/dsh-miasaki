#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pet_native;

use std::{
    fs::OpenOptions,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const REMOTE_URL: &str = "http://127.0.0.1:3080/";
const ASSET_PORT: u16 = 39800;
const INIT_SCRIPT: &str = include_str!("../injected/theme-init.js");
static LAUNCHING: AtomicBool = AtomicBool::new(false);

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
        cmd.args(["/C", "dsh", "web"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(std::process::Stdio::from(log))
            .creation_flags(0x0800_0000);
        cmd.spawn().map_err(|e| format!("启动 dsh 失败: {e}"))?;
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
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut spawn_attempted = false;
        loop {
            if port_ready() {
                set_status(&app, "已就绪，正在进入…");
                if let Some(wv) = app.get_webview_window("main") {
                    let url = tauri::Url::parse(&remote_url()).expect("valid remote url");
                    let _ = wv.navigate(url);
                }
                start_hash_watchdog(&app);
                return;
            }
            if !spawn_attempted {
                spawn_attempted = true;
                match spawn_dsh() {
                    Ok(log_path) => set_status(
                        &app,
                        &format!("正在拉起 DSH 服务…（日志：{}）", log_path.display()),
                    ),
                    Err(e) => {
                        set_status(&app, &format!("启动失败：{e}"));
                        eval_status(&app, "window.__setRetry && window.__setRetry(true)");
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    });
}

/* ---------------- hash 命令/状态通道（100ms 轮询） ---------------- */

fn parse_fragment(
    fragment: &str,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<(i32, i32)>,
    i64,
) {
    let mut theme = None;
    let mut int = None;
    let mut cmd = None;
    let mut move_xy = None;
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
        if let Some(v) = part.strip_prefix("seq=") {
            seq = v.parse().unwrap_or(-1);
        }
        if let Some(v) = part.strip_prefix("move=") {
            if let Some((a, b)) = v.split_once(',') {
                if let (Ok(x), Ok(y)) = (a.parse::<i32>(), b.parse::<i32>()) {
                    move_xy = Some((x, y));
                }
            }
        }
    }
    (theme, int, cmd, move_xy, seq)
}

fn pet_mode_for(theme: &str) -> &'static str {
    match theme {
        "zafkiel" => "kurumi",
        "kurkuriel" => "inverse",
        _ => "whale",
    }
}

fn start_hash_watchdog(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_fragment = String::new();
        let mut last_seq: i64 = -1;
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let Some(wv) = app.get_webview_window("main") else { continue };
            let Ok(url) = wv.url() else { continue };
            let Some(fragment) = url.fragment() else { continue };
            if fragment == last_fragment {
                continue;
            }
            last_fragment = fragment.to_string();
            let (theme, int, cmd, move_xy, seq) = parse_fragment(fragment);
            let pet = app.state::<pet_native::NativePet>();
            if let Some(t) = theme {
                let mode = pet_mode_for(&t);
                pet.set_mode(mode);
            }
            if let Some(i) = int {
                pet.set_intensity(&i);
            }
            if let Some((dx, dy)) = move_xy {
                if let Ok(p) = wv.outer_position() {
                    let _ = wv.set_position(tauri::PhysicalPosition::new(p.x + dx, p.y + dy));
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
                        "exit" => app.exit(0),
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
    start_launch_sequence(&app);
}

#[tauri::command]
fn minimize_main(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn pet_log(msg: String) {
    app_log_line(&format!("[{}] {msg}\n", chrono_now()));
}

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
                    exe_asset_path(dir, &file).and_then(|p| std::fs::read(p).ok())
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

fn exe_asset_path(dir: &str, file: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let base = exe.parent()?.to_path_buf();
    Some(base.join("ui").join(dir).join(file))
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
            minimize_main,
            exit_app,
            pet_log
        ])
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    window.app_handle().exit(0);
                }
            }
        })
        .setup(|app| {
            let webview = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("loading.html".into()))
                .title("Miasaki · DSH")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .center()
                .decorations(false)
                .visible(false)
                .initialization_script(INIT_SCRIPT)
                .on_page_load(|webview, payload| {
                    let _ = webview.show();
                    let url = payload.url().to_string();
                    if url.starts_with("http://127.0.0.1:3080") {
                        let _ = webview.eval(INIT_SCRIPT);
                    }
                })
                .build()
                .expect("failed to build main window");

            // 原生分层窗口桌宠（与主窗同进程，零 IPC 同步）
            app.manage(pet_native::NativePet::spawn(app.handle().clone()));

            start_asset_server();

            let app = app.handle().clone();
            start_launch_sequence(&app);
            let _ = webview;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Miasaki");
}
