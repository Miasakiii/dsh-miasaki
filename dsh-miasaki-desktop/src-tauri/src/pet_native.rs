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

/// M2(v3):桌宠六态（pet-v3-roadmap.md M2.1）。官方契约通道（hash pet= 字段，白名单归一化）
/// 优先；DOM 扫描（act=/wait=）兜底；fleet 脉冲叠加 FleetBlocked。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PetState {
    Idle,
    Thinking,
    Waiting,
    Error,
    Done,
    FleetBlocked,
}

pub struct PetShared {
    pub mode: String,
    pub intensity: String,
    pub hide: bool,
    /// 面板「位置重置」请求：窗口线程 compose 消费后清 false。
    pub pending_reset: bool,
    /// 总指挥活动状态(v2026-08-30):"busy" = 生成中,"idle" = 等待（DOM 兜底源,M2 后仅官方通道静默时生效）
    pub activity: String,
    /// 总指挥等待 Operator 审批工具调用（DOM 兜底源）
    pub waiting_approval: bool,
    /// X2 fleet 指示：有任务 running（或 waiting_approval>0）
    pub fleet_running: bool,
    /// X2 fleet 指示：blocked+error>0（最高优先级，与 waiting_approval 并列展示）
    pub fleet_alert: bool,
    /// M2:官方契约上报态（白名单归一化后）；None = 从未收到
    pub official_state: Option<PetState>,
    /// M2:等待审批时的工具名（M3 气泡用；M2 仅透传存储）
    pub official_tool: String,
    /// R4(2026-09-16):审批的**稳定身份**（官方 `PendingApproval.key`，hash `petkey=` 上报）。
    /// 空 = 无身份 → 按普通 waiting 处理（**身份门禁**：不挂可交互审批气泡，
    /// 也绝不凭工具名伪造审批——参考实现在此处踩过「挂出永远关不掉的气泡」的坑）。
    pub official_key: String,
    /// M2:最后一次官方心跳的 petts（hash 值，同值 = 页面未更新 = 非新心跳）
    pub official_ts: i64,
    /// M2:最后一次官方心跳到达时刻（compose 内 5s 新鲜度判定）
    pub official_at: Option<std::time::Instant>,
}

pub struct NativePet {
    shared: Arc<Mutex<PetShared>>,
    _thread: Option<std::thread::JoinHandle<()>>,
}

impl NativePet {
    pub fn spawn(app: AppHandle) -> Self {
        let restore_hide = persist::load_hide();
        let shared = Arc::new(Mutex::new(PetShared {
            mode: "whale".to_string(),
            intensity: "idle".to_string(),
            hide: restore_hide,
            pending_reset: false,
            activity: "idle".to_string(),
            waiting_approval: false,
            fleet_running: false,
            fleet_alert: false,
            official_state: None,
            official_tool: String::new(),
            official_key: String::new(),
            official_ts: 0,
            official_at: None,
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

    /// M2(v3):官方契约六态上报（main.rs watchdog 解析 hash pet=/pettool=/petts=）。
    /// 同 petts 视为页面未更新（非新心跳,不刷新 official_at）；白名单外一律归一化为
    /// idle（防篡改,roadmap M2.2）。新鲜度判定（5s）在 compose/查询点进行。
    pub fn set_official_state(&self, ts: i64, state: &str, tool: &str, key: &str) {
        if let Ok(mut s) = self.shared.lock() {
            if s.official_ts == ts {
                return;
            }
            s.official_ts = ts;
            s.official_at = Some(std::time::Instant::now());
            let norm = match state {
                "thinking" => PetState::Thinking,
                "waiting" => PetState::Waiting,
                "error" => PetState::Error,
                "done" => PetState::Done,
                _ => PetState::Idle,
            };
            if s.official_state != Some(norm) {
                window::pet_log_line(&format!(
                    "[native-pet] official state -> {norm:?} tool={tool}\n"
                ));
            }
            s.official_state = Some(norm);
            let mut t = tool.to_string();
            t.truncate(80);
            s.official_tool = t;
            // R4:审批的稳定身份（官方 `PendingApproval.key`）。插件仅在审批态填充，其余态为空。
            // hash 字段不可信 → 截断上限；身份门禁（拿不到身份就不显示可交互审批气泡）在 compose 侧。
            let mut k = key.to_string();
            k.truncate(120);
            s.official_key = k;
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
