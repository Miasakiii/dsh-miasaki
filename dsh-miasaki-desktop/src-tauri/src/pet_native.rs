// pet_native.rs — 原生 Win32 分层窗口桌宠（UpdateLayeredWindow 逐像素 alpha）
// D2 拆分后本文件为 facade：共享类型 + NativePet 对外 API；实现见 pet_native/ 子模块。
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

#[path = "pet_native/config.rs"]
pub(crate) mod config;
#[path = "pet_native/ffi.rs"]
pub(crate) mod ffi;
#[path = "pet_native/image.rs"]
pub(crate) mod image;
#[path = "pet_native/model.rs"]
pub(crate) mod model;
#[path = "pet_native/persist.rs"]
pub(crate) mod persist;
#[path = "pet_native/window.rs"]
pub(crate) mod window;

pub struct PetShared {
    pub mode: String,
    pub intensity: String,
    pub hide: bool,
    /// 面板「位置重置」请求：窗口线程 compose 消费后清 false。
    pub pending_reset: bool,
    /// 总指挥活动状态(v2026-08-30):"busy" = 生成中,"idle" = 等待
    pub activity: String,
    /// 总指挥等待 Operator 审批工具调用(优先级最高)
    pub waiting_approval: bool,
    /// X2 fleet 指示：有任务 running（或 waiting_approval>0）
    pub fleet_running: bool,
    /// X2 fleet 指示：blocked+error>0（最高优先级，与 waiting_approval 并列展示）
    pub fleet_alert: bool,
}

pub struct NativePet {
    shared: Arc<Mutex<PetShared>>,
    _thread: Option<std::thread::JoinHandle<()>>,
}

impl NativePet {
    pub fn spawn(app: AppHandle) -> Self {
        let restore_hide = persist::load_pet_state().map(|s| s.hide).unwrap_or(false);
        let shared = Arc::new(Mutex::new(PetShared {
            mode: "whale".to_string(),
            intensity: "idle".to_string(),
            hide: restore_hide,
            pending_reset: false,
            activity: "idle".to_string(),
            waiting_approval: false,
            fleet_running: false,
            fleet_alert: false,
        }));
        let frames = image::load_frames();
        let s2 = shared.clone();
        let app2 = app.clone();
        let thread = std::thread::spawn(move || {
            window::create_window(app2, s2, frames);
        });
        NativePet {
            shared,
            _thread: Some(thread),
        }
    }

    pub fn set_mode(&self, mode: &str) {
        window::pet_log_line(&format!("[native-pet] set_mode {mode}\n"));
        if let Ok(mut s) = self.shared.lock() {
            s.mode = mode.to_string();
        }
    }

    pub fn set_intensity(&self, int: &str) {
        window::pet_log_line(&format!("[native-pet] set_intensity {int}\n"));
        if let Ok(mut s) = self.shared.lock() {
            s.intensity = int.to_string();
        }
    }

    /// v2026-08-30:总指挥活动状态(busy/idle)由 runtime.js 扫描 DSH 页面 DOM 上报
    pub fn set_activity(&self, act: &str) {
        if let Ok(mut s) = self.shared.lock() {
            // 仅接受 idle/busy;其它忽略(防 hash 篡改)
            let norm = if act == "busy" { "busy" } else { "idle" };
            if s.activity != norm {
                window::pet_log_line(&format!("[native-pet] set_activity {norm}\n"));
                s.activity = norm.to_string();
            }
        }
    }

    /// v2026-08-30:总指挥等待 Operator 审批(true=常驻气泡+强制 wait 姿态)
    pub fn set_waiting_approval(&self, waiting: bool) {
        if let Ok(mut s) = self.shared.lock() {
            if s.waiting_approval != waiting {
                window::pet_log_line(&format!("[native-pet] set_waiting_approval {waiting}\n"));
                s.waiting_approval = waiting;
            }
        }
    }

    /// X2:fleet 脉冲状态（main.rs 脉冲看门狗 2s 轮询 fleet-pulse.json 写入）
    pub fn set_fleet(&self, running: bool, alert: bool) {
        if let Ok(mut s) = self.shared.lock() {
            if s.fleet_running != running || s.fleet_alert != alert {
                window::pet_log_line(&format!(
                    "[native-pet] set_fleet running={running} alert={alert}\n"
                ));
                s.fleet_running = running;
                s.fleet_alert = alert;
            }
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
