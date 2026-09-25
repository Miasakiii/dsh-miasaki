//! 恢复动作：原生恢复对话框（T2.3）+ 「停用第三方插件」（对齐官方 `sanitizeProfile`）
//! + 分级停机状态机（T2.4）。
//!
//! ## 为什么恢复动作要放在壳里、而不是页面里
//!
//! 本模块服务的场景是「**主界面本身不响应**」——页面里放按钮等于让哑巴喊话
//! （与 `main.rs::show_native_error` 同一条纪律）。因此对话框走 Win32 `MessageBoxW`，
//! 零 WebView2 依赖，UI 线程即使完全卡死也弹得出来。
//!
//! ## 语义边界（刻意的）
//!
//! * **绝不自动强杀**：看门狗只落盘取证；「退出 / 重启 / 停用插件重启」三选一由用户点。
//! * 「停用第三方插件」= **备份 + 重置**，不改写 `cordis.patch.yml` 的内容，
//!   也不删任何文件；备份文件名带毫秒时间戳，用户可一键回滚（对齐官方 sanitizeProfile
//!   的「只动 bundles 基线」语义）。
//! * 本模块**不引入 main.rs 的依赖**：一切副作用都由调用方以闭包注入 —— 既避免
//!   模块循环依赖，也让「决策」与「执行」可以分别单测。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/* ---------------- 原生对话框（三按钮 / 端口占用时降级为两按钮） ---------------- */

/// 用户在恢复对话框里的选择。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    /// 退出应用（走后端保留判定，不无条件杀后端）
    Quit,
    /// 重启（保持现状）
    Restart,
    /// 停用第三方插件后重启
    RestartSafe,
}

/// 端口占用（EADDRINUSE / 3080 被占）时的降级形态：**只两按钮**（退出 / 重启）。
///
/// 理由：这种情况下「停用第三方插件重启」是无效动作 —— 起不来的是端口而不是插件，
/// 给一个必然无效的按钮只会让用户多点一次、多等一轮。
pub fn buttons_for(port_conflict: bool) -> [&'static str; 3] {
    if port_conflict {
        ["重启", "退出", "（不适用：重启）"]
    } else {
        ["重启", "退出", "停用第三方插件后重启"]
    }
}

/// 端口占用类失败的判据（纯函数，单测覆盖）：官方错误码 `EADDRINUSE` 或明确提到 3080。
/// 只认这两个信号，避免把「后端启动慢」也误判成端口冲突而砍掉第三个按钮。
pub fn is_port_conflict(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("eaddrinuse") || text.contains("3080")
}

/// 对话框文本。两按钮形态换文案（说明为什么没有第三个按钮）。
pub fn dialog_text(reason: &str, port_conflict: bool) -> (String, String) {
    let title = "Miasaki · 主界面无响应".to_string();
    let body = if port_conflict {
        format!(
            "{reason}\n\n\
             检测到端口 3080 被占用：本次失败与插件无关，因此不提供「停用第三方插件」选项。\n\n\
             · 重启 — 结束当前实例并重新打开（推荐先试这个）\n\
             · 退出 — 关闭桌面端；若 3080 上仍有其他客户端在连，后端会保留不停止\n\n\
             选择后才会执行，当前不会自动结束任何进程。"
        )
    } else {
        format!(
            "{reason}\n\n\
             请选择接下来的动作：\n\
             · 重启 — 结束当前实例并重新打开（推荐先试这个）\n\
             · 退出 — 关闭桌面端；若 3080 上仍有其他客户端在连，后端会保留不停止\n\
             · 停用第三方插件后重启 — 先把 profile 的 cordis.patch.yml 备份为\n\
             {}，再把 bundles 重置为基线，然后重启\n\n\
             现场已落盘到日志目录（crash-*.log）。选择后才会执行，当前不会自动结束任何进程。",
            ".bak-<毫秒时间戳>"
        )
    };
    (title, body)
}

/// 展示对话框并返回用户选择；`owner` 为主窗 HWND（None 则无属主）。
/// 按钮映射：Yes=重启 / No=退出 / Cancel=停用插件后重启。
#[cfg(target_os = "windows")]
fn ask(owner: Option<isize>, reason: &str, port_conflict: bool) -> Option<Choice> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONWARNING, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNOCANCEL, MB_YESNO, IDCANCEL,
        IDNO, IDYES,
    };
    let (title, body) = dialog_text(reason, port_conflict);
    // 按钮文案在 body 里（MessageBox 的自定义按钮文字不可改），这里把映射落进日志：
    // 用户报「我点了第三个」时，日志能还原成确定的行为。
    crate::app_log_line_public(&format!(
        "[recovery] 对话框按钮映射（port_conflict={port_conflict}）：\
         Yes={} / No={} / Cancel={}\n",
        buttons_for(port_conflict)[0],
        buttons_for(port_conflict)[1],
        buttons_for(port_conflict)[2]
    ));
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let (text, caption) = (wide(&body), wide(&title));
    let flags = if port_conflict {
        MB_YESNO | MB_ICONWARNING | MB_SETFOREGROUND | MB_TOPMOST
    } else {
        MB_YESNOCANCEL | MB_ICONWARNING | MB_SETFOREGROUND | MB_TOPMOST
    };
    let id = unsafe {
        MessageBoxW(
            owner.unwrap_or(0) as *mut core::ffi::c_void,
            text.as_ptr(),
            caption.as_ptr(),
            flags,
        )
    };
    let choice = match id {
        IDYES => Some(Choice::Restart),
        IDNO => Some(Choice::Quit),
        IDCANCEL if !port_conflict => Some(Choice::RestartSafe),
        // 关闭窗口（X）与两按钮形态下的异常返回值：不做任何动作
        _ => None,
    };
    crate::app_log_line_public(&format!(
        "[recovery] 用户选择：{}\n",
        match choice {
            Some(Choice::Restart) => "重启",
            Some(Choice::Quit) => "退出",
            Some(Choice::RestartSafe) => "停用第三方插件后重启",
            None => "（取消/关闭对话框，不动作）",
        }
    ));
    choice
}

#[cfg(not(target_os = "windows"))]
fn ask(_owner: Option<isize>, _reason: &str, _port_conflict: bool) -> Option<Choice> {
    None
}

/// 同一时刻只允许一个恢复对话框（看门狗可能连拍、页面也可能同时 invoke）。
static DIALOG_OPEN: AtomicBool = AtomicBool::new(false);

/// 弹恢复对话框并执行用户选择（在**独立线程**里，绝不阻塞 UI 线程与看门狗线程）。
///
/// * `owner`：主窗 HWND；挂起场景下主窗消息泵可能已卡死，因此调用方**可以不传**
///   （无属主对话框同样可交互，只是不跟随主窗层级）。
/// * `apply`：用户选择后的动作执行器（由 `main.rs` 注入，见 `apply_choice`）。
pub fn offer<F>(owner: Option<isize>, reason: String, apply: F)
where
    F: FnOnce(Choice) + Send + 'static,
{
    if DIALOG_OPEN.swap(true, Ordering::SeqCst) {
        return;
    }
    let port_conflict = is_port_conflict(&reason);
    std::thread::Builder::new()
        .name("miasaki-recovery-dialog".into())
        .spawn(move || {
            let choice = ask(owner, &reason, port_conflict);
            DIALOG_OPEN.store(false, Ordering::SeqCst);
            if let Some(c) = choice {
                apply(c);
            }
        })
        .ok();
}

/* ---------------- 「停用第三方插件」= sanitizeProfile ---------------- */

/// 原生信息提示（手动诊断报告生成后的路径回显等）。
///
/// 与恢复对话框同一条纪律：**不依赖 WebView2 健康度** —— 诊断入口本身不该有
/// "界面坏了就用不了"的脆弱性（那恰恰是最需要它的时候）。
#[cfg(target_os = "windows")]
pub fn show_info(title: &str, text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND, MB_TOPMOST,
    };
    let text_w: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let title_w: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text_w.as_ptr(),
            title_w.as_ptr(),
            MB_OK | MB_ICONINFORMATION | MB_TOPMOST | MB_SETFOREGROUND,
        );
    }
}

#[cfg(not(target_os = "windows"))]
pub fn show_info(_title: &str, _text: &str) {}

/// 原生**二选一**确认（返回用户是否选了「是」）。
/// 用于「发现新版本 → 现在打开下载页吗」这类只有两个答案、不需要第三选项的场景。
#[cfg(target_os = "windows")]
pub fn show_confirm(title: &str, text: &str) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONQUESTION, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO,
    };
    let text_w: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let title_w: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    let r = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text_w.as_ptr(),
            title_w.as_ptr(),
            MB_YESNO | MB_ICONQUESTION | MB_TOPMOST | MB_SETFOREGROUND,
        )
    };
    r == IDYES
}

#[cfg(not(target_os = "windows"))]
pub fn show_confirm(_title: &str, _text: &str) -> bool {
    false
}

/// 基线 bundles（官方 sanitizeProfile 的同一份清单）。
pub const BASELINE_BUNDLES: [&str; 2] = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
/// profile 的补丁层文件名（备份对象）。
pub const PATCH_FILE: &str = "cordis.patch.yml";
/// background profile 解析顺序：环境变量优先，再按 dsh 的 profile 约定回落。
pub const PROFILE_CANDIDATES: [&str; 4] = ["web", "desktop", "tui", "headless"];

/// 解析 dshHome，口径与 `@deepseek-ai/dsh-home-paths` 及 `launcher_icon::dsh_home` 一致：
/// 非空白 `$DSH_HOME` 优先，否则 `~/.dsh`。
pub fn dsh_home() -> Option<PathBuf> {
    if let Some(raw) = std::env::var_os("DSH_HOME") {
        let text = raw.to_string_lossy().trim().to_string();
        if !text.is_empty() {
            return Some(PathBuf::from(text));
        }
    }
    for key in ["USERPROFILE", "HOME"] {
        if let Some(home) = std::env::var_os(key) {
            let text = home.to_string_lossy().trim().to_string();
            if !text.is_empty() {
                return Some(PathBuf::from(text).join(".dsh"));
            }
        }
    }
    None
}

/// profile 名的合法性：只允许字母数字与 `-`/`_`，首字符必须是字母数字。
/// **这是防路径穿越的硬闸门** —— 名字会拼进文件路径。
pub fn is_valid_profile_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 {
        return false;
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 解析当前 profile 目录（纯函数，喂 dshHome 与候选名，单测覆盖）。
///
/// 实测依据：壳拉起的是 `dsh web`，而 `dsh <name>` 即 `dsh --profile <name>`，
/// 所以本机后端跑的是 `web` profile（已核对 `~/.dsh/profiles/web/package.json`
/// 的 `dsh.profile.bundles` 含全部七线插件）。`MIASAKI_PROFILE` / `DSH_PROFILE`
/// 用于覆盖（自定义 profile、多 profile 实验）；其余候选按顺序回落。
/// **不猜**：目录里既没有 `package.json` 也没有 `cordis.patch.yml` 就跳过。
pub fn resolve_profile_dir(dsh_home: &Path, candidates: &[String]) -> Option<PathBuf> {
    for name in candidates {
        if !is_valid_profile_name(name) {
            continue;
        }
        let dir = dsh_home.join("profiles").join(name);
        if dir.join("package.json").is_file() || dir.join(PATCH_FILE).is_file() {
            return Some(dir);
        }
    }
    None
}

/// 运行时解析：环境变量 → `web` → `desktop` → 其余候选。
pub fn profile_dir() -> Option<PathBuf> {
    let home = dsh_home()?;
    let mut candidates: Vec<String> = Vec::new();
    for key in ["MIASAKI_PROFILE", "DSH_PROFILE"] {
        if let Ok(v) = std::env::var(key) {
            let v = v.trim().to_string();
            if !v.is_empty() {
                candidates.push(v);
            }
        }
    }
    candidates.extend(PROFILE_CANDIDATES.iter().map(|s| s.to_string()));
    resolve_profile_dir(&home, &candidates)
}

/// 备份文件名：`cordis.patch.yml.bak-<unix_ms>`（同名冲突追加 `.<n>`，绝不覆盖）。
pub fn backup_file_name(unix_ms: i64, seq: u32) -> String {
    if seq == 0 {
        format!("{PATCH_FILE}.bak-{unix_ms}")
    } else {
        format!("{PATCH_FILE}.bak-{unix_ms}.{seq}")
    }
}

/// `package.json` 的 `dsh.profile.bundles` 是否已是基线（幂等判据，纯函数）。
pub fn bundles_already_baseline(json: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return false;
    };
    let Some(list) = v
        .get("dsh")
        .and_then(|d| d.get("profile"))
        .and_then(|p| p.get("bundles"))
        .and_then(|b| b.as_array())
    else {
        return false;
    };
    let got: Vec<&str> = list.iter().filter_map(|x| x.as_str()).collect();
    got == BASELINE_BUNDLES
}

/// 把 bundles 重置为基线；保留其它字段（含 `dependencies`）与 4 空格缩进。
fn rewrite_bundles_baseline(json: &str) -> Result<String, String> {
    let mut v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("package.json 不是合法 JSON：{e}"))?;
    let obj = v.as_object_mut().ok_or("package.json 顶层不是对象")?;
    let dsh = obj
        .get_mut("dsh")
        .and_then(|d| d.as_object_mut())
        .ok_or("package.json 缺少 dsh 段")?;
    let profile = dsh
        .get_mut("profile")
        .and_then(|p| p.as_object_mut())
        .ok_or("package.json 缺少 dsh.profile 段")?;
    if !profile.contains_key("bundles") {
        return Err("package.json 缺少 dsh.profile.bundles".into());
    }
    profile.insert(
        "bundles".to_string(),
        serde_json::Value::Array(
            BASELINE_BUNDLES
                .iter()
                .map(|s| serde_json::Value::String((*s).to_string()))
                .collect(),
        ),
    );
    let mut text = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    // 与既有文件一致的收尾换行；缩进沿用 serde_json 的 2 空格（该文件本就是 2 空格）
    text.push('\n');
    Ok(text)
}

/// 备份 + 重置。返回给用户看的诊断行（多行）。
///
/// **铁律：失败要中止并保留原文件。** 全程只有两条写操作，各自都是
/// 「先写临时文件 / 先备份，再 rename」 —— 任何一步失败都原样保留 `package.json`，
/// 且 `cordis.patch.yml` **只被复制、从不被改写**。
pub fn sanitize_profile(dir: &Path, unix_ms: i64) -> Result<String, String> {
    let patch = dir.join(PATCH_FILE);
    let pkg = dir.join("package.json");
    let mut notes: Vec<String> = Vec::new();

    // ① 备份 cordis.patch.yml（存在才备份；不存在说明本来就没有用户补丁层）
    if patch.is_file() {
        let mut target = dir.join(backup_file_name(unix_ms, 0));
        let mut seq = 0u32;
        while target.exists() {
            seq += 1;
            if seq > 100 {
                return Err(format!("备份名冲突超过 100 次：{}", target.display()));
            }
            target = dir.join(backup_file_name(unix_ms, seq));
        }
        std::fs::copy(&patch, &target)
            .map_err(|e| format!("备份 {} 失败：{e}", patch.display()))?;
        notes.push(format!("已备份 {}", target.display()));
    } else {
        notes.push(format!("{} 不存在，跳过备份", patch.display()));
    }

    // ② 重置 bundles 为基线（原子写：临时文件 + rename）
    let original = std::fs::read_to_string(&pkg).map_err(|e| format!("读取 {} 失败：{e}", pkg.display()))?;
    if bundles_already_baseline(&original) {
        notes.push("bundles 已是基线，无需改写".to_string());
        return Ok(notes.join("\n"));
    }
    let rewritten = rewrite_bundles_baseline(&original)?;
    let tmp = pkg.with_extension("json.tmp");
    std::fs::write(&tmp, rewritten).map_err(|e| format!("写入临时文件失败：{e}"))?;
    std::fs::rename(&tmp, &pkg).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换 {} 失败（原文件保持不变）：{e}", pkg.display())
    })?;
    notes.push(format!(
        "bundles 已重置为基线 [{}]",
        BASELINE_BUNDLES.join(", ")
    ));
    Ok(notes.join("\n"))
}

/* ---------------- 分级停机（T2.4） ---------------- */

/// 停机阶段。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KillStage {
    /// 请求优雅退出（`taskkill /PID <pid> /T`，不带 /F）
    Soft,
    /// 强杀（`taskkill /PID <pid> /T /F`）
    Force,
}

/// 一个阶段的动作。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KillAction {
    Run(KillStage),
    /// 进程已退出
    Done,
    /// 全部阶段用尽仍未退出 → 记录 PID 并放弃（Job Object 兜底）
    GiveUp,
}

/// 分级停机状态机。**纯逻辑**：阶段推进只看「进程是否还活着」，实际杀进程由调用方做。
///
/// 官方 Electron 侧是 `SIGTERM → 10s → SIGKILL → 5s → SIGKILL`；Windows 上等价物是
/// `taskkill`（不带 /F = 发关闭请求，带 /F = 强杀），因此阶段序列同构：
/// 软杀 → 等 → 强杀 → 等 → 再强杀 → 记录未退出 PID。
#[derive(Debug)]
pub struct ShutdownMachine {
    /// 每个阶段最多发几次 kill（首次 + 重试）
    pub attempts_per_stage: u32,
    soft_attempts: u32,
    force_attempts: u32,
}

impl ShutdownMachine {
    pub const fn new(attempts_per_stage: u32) -> Self {
        Self {
            attempts_per_stage,
            soft_attempts: 0,
            force_attempts: 0,
        }
    }

    /// 一拍：`alive` = 目标进程当前是否还活着。
    pub fn tick(&mut self, alive: bool) -> KillAction {
        if !alive {
            return KillAction::Done;
        }
        if self.soft_attempts < self.attempts_per_stage {
            self.soft_attempts += 1;
            return KillAction::Run(KillStage::Soft);
        }
        if self.force_attempts < 2 {
            self.force_attempts += 1;
            return KillAction::Run(KillStage::Force);
        }
        KillAction::GiveUp
    }

    pub fn soft_attempts(&self) -> u32 {
        self.soft_attempts
    }

    pub fn force_attempts(&self) -> u32 {
        self.force_attempts
    }
}

/// 关闭前是否该停后端（纯函数，单测覆盖）。
///
/// **这条判据是 2026-09-23 断线事故的修复，不可推翻**：后端是共享服务
/// （浏览器、其它终端都可能连着），「关桌面端」不该把别人正在用的连接拖走。
/// 因此只要 3080 上还有本应用进程树之外的客户端，就**保留**后端。
/// T2.4 的分级停机只在「本来就该停」的前提下改进了停法，不改判据。
pub fn stop_decision(pid: Option<u32>, external_clients: bool) -> StopDecision {
    match pid {
        None => StopDecision::NothingToDo,
        Some(_) if external_clients => StopDecision::Retain,
        Some(_) => StopDecision::Stop,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopDecision {
    /// 后端不是本应用拉起的 → 不触碰
    NothingToDo,
    /// 有外部客户端 → 保留
    Retain,
    /// 该停 → 走分级停机
    Stop,
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ---- 对话框文案与判据 ---- */

    #[test]
    fn three_buttons_normally_two_on_port_conflict() {
        assert_eq!(buttons_for(false)[2], "停用第三方插件后重启");
        assert_eq!(buttons_for(true)[2], "（不适用：重启）");

        let (title, body) = dialog_text("主界面无响应", false);
        assert!(title.contains("Miasaki"));
        assert!(body.contains("停用第三方插件后重启"));
        assert!(body.contains("cordis.patch.yml"));
        assert!(body.contains(".bak-"));

        // 端口占用形态：必须换文案并说明为什么没有第三个按钮
        let (_, body2) = dialog_text("dsh 启动失败：EADDRINUSE", true);
        assert!(!body2.contains("停用第三方插件后重启"));
        assert!(body2.contains("端口 3080 被占用"));
    }

    #[test]
    fn port_conflict_detection_only_accepts_real_signals() {
        assert!(is_port_conflict("Error: listen EADDRINUSE: address already in use"));
        assert!(is_port_conflict("eaddrinuse"));
        assert!(is_port_conflict("端口 3080 长时间未就绪"));
        // 「后端启动慢」不是端口冲突：不该砍掉第三个按钮
        assert!(!is_port_conflict("dsh 拉起后立即退出"));
        assert!(!is_port_conflict("WebView2 初始化失败"));
        assert!(!is_port_conflict(""));
    }

    /* ---- profile 解析 ---- */

    #[test]
    fn profile_name_rejects_path_traversal() {
        assert!(is_valid_profile_name("web"));
        assert!(is_valid_profile_name("m3-test"));
        assert!(is_valid_profile_name("web_2"));
        assert!(!is_valid_profile_name(""));
        assert!(!is_valid_profile_name("../web"));
        assert!(!is_valid_profile_name("a/b"));
        assert!(!is_valid_profile_name("a\\b"));
        assert!(!is_valid_profile_name(".hidden"));
        assert!(!is_valid_profile_name(&"x".repeat(65)));
    }

    /// 测试临时目录：见 `diag.rs` 同名函数的说明 —— 放 `target/test-tmp/` 下，
    /// 不依赖系统 TEMP（受限环境下对 cargo 测试进程不可写，os error 5）。
    fn test_tmp_dir(tag: &str) -> PathBuf {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(format!("{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create test tmp dir under target/");
        dir
    }

    #[test]
    fn resolve_profile_dir_picks_first_existing_and_skips_missing() {
        let home = test_tmp_dir("resolve-profile");
        // 只造 desktop：候选顺序 web → desktop，web 不存在必须被跳过（不猜、不建）
        let desktop = home.join("profiles").join("desktop");
        std::fs::create_dir_all(&desktop).unwrap();
        std::fs::write(desktop.join("package.json"), "{}").unwrap();
        let cands = vec!["web".to_string(), "desktop".to_string()];
        assert_eq!(resolve_profile_dir(&home, &cands), Some(desktop.clone()));
        // 非法候选名被跳过，不参与路径拼接
        let bad = vec!["../etc".to_string(), "desktop".to_string()];
        assert_eq!(resolve_profile_dir(&home, &bad), Some(desktop.clone()));
        // 一个都不存在 → None（调用方必须中止，不得凭空造 profile）
        std::fs::remove_dir_all(&home).unwrap();
        assert_eq!(resolve_profile_dir(&home, &cands), None);
    }

    #[test]
    fn backup_name_is_timestamped_and_conflict_suffixed() {
        assert_eq!(backup_file_name(1_790_000_000_123, 0), "cordis.patch.yml.bak-1790000000123");
        assert_eq!(backup_file_name(1_790_000_000_123, 2), "cordis.patch.yml.bak-1790000000123.2");
    }

    /* ---- sanitizeProfile ---- */

    fn profile_fixture(tag: &str) -> PathBuf {
        let dir = test_tmp_dir(&format!("sanitize-{tag}"));
        std::fs::write(dir.join(PATCH_FILE), "- id: ui-chat\n  config:\n    x: 1\n").unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "@miasaki/dsh-sidebar": "link:C:/x"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@miasaki/dsh-sidebar"
      ]
    }
  }
}
"#,
        )
        .unwrap();
        dir
    }

    #[test]
    fn sanitize_backs_up_patch_and_resets_bundles_to_baseline() {
        let dir = profile_fixture("ok");
        let notes = sanitize_profile(&dir, 1_790_000_000_123).unwrap();
        assert!(notes.contains("已备份"), "{notes}");

        // ① 备份存在且内容与原文件逐字相同（只复制、不改写）
        let bak = dir.join(backup_file_name(1_790_000_000_123, 0));
        assert_eq!(
            std::fs::read_to_string(&bak).unwrap(),
            std::fs::read_to_string(dir.join(PATCH_FILE)).unwrap()
        );
        // ② bundles 变基线，dependencies 与 name 原样保留
        let pkg = std::fs::read_to_string(dir.join("package.json")).unwrap();
        assert!(bundles_already_baseline(&pkg));
        let v: serde_json::Value = serde_json::from_str(&pkg).unwrap();
        assert_eq!(v["name"], "dsh-profile-web");
        assert!(v["dependencies"]["@miasaki/dsh-sidebar"].is_string());
        // ③ 临时文件不残留
        assert!(!dir.join("package.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_is_idempotent_and_still_backs_up_each_time() {
        let dir = profile_fixture("idem");
        sanitize_profile(&dir, 1000).unwrap();
        let notes = sanitize_profile(&dir, 2000).unwrap();
        assert!(notes.contains("已是基线"), "{notes}");
        // 两次备份都在（同名冲突也不会互相覆盖）
        assert!(dir.join(backup_file_name(1000, 0)).exists());
        assert!(dir.join(backup_file_name(2000, 0)).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_name_collision_appends_sequence_never_overwrites() {
        let dir = profile_fixture("collide");
        // 先占位同名备份
        std::fs::write(dir.join(backup_file_name(1234, 0)), b"PRE-EXISTING").unwrap();
        sanitize_profile(&dir, 1234).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(backup_file_name(1234, 0))).unwrap(),
            "PRE-EXISTING",
            "既有备份绝不能被覆盖"
        );
        assert!(dir.join(backup_file_name(1234, 1)).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_patch_file_is_skipped_but_bundles_still_reset() {
        let dir = profile_fixture("nopatch");
        std::fs::remove_file(dir.join(PATCH_FILE)).unwrap();
        let notes = sanitize_profile(&dir, 42).unwrap();
        assert!(notes.contains("不存在，跳过备份"), "{notes}");
        assert!(bundles_already_baseline(
            &std::fs::read_to_string(dir.join("package.json")).unwrap()
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_package_json_aborts_and_keeps_original_bytes() {
        let dir = profile_fixture("broken");
        let pkg = dir.join("package.json");
        let broken = "{ this is not json";
        std::fs::write(&pkg, broken).unwrap();
        let err = sanitize_profile(&dir, 7).unwrap_err();
        assert!(err.contains("不是合法 JSON"), "{err}");
        // 原文件逐字保留（失败即中止）
        assert_eq!(std::fs::read_to_string(&pkg).unwrap(), broken);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn package_json_without_bundles_key_aborts() {
        let dir = profile_fixture("nobundles");
        let pkg = dir.join("package.json");
        std::fs::write(&pkg, r#"{"name":"x","dsh":{"profile":{}}}"#).unwrap();
        let err = sanitize_profile(&dir, 8).unwrap_err();
        assert!(err.contains("bundles"), "{err}");
        assert_eq!(
            std::fs::read_to_string(&pkg).unwrap(),
            r#"{"name":"x","dsh":{"profile":{}}}"#
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ---- 分级停机 ---- */

    #[test]
    fn shutdown_goes_soft_then_force_then_force_then_gives_up() {
        // 目标顽强存活：软杀 ×2 → 强杀 ×2 → 记录未退出 PID
        let mut m = ShutdownMachine::new(2);
        assert_eq!(m.tick(true), KillAction::Run(KillStage::Soft));
        assert_eq!(m.tick(true), KillAction::Run(KillStage::Soft));
        assert_eq!(m.tick(true), KillAction::Run(KillStage::Force));
        assert_eq!(m.tick(true), KillAction::Run(KillStage::Force));
        assert_eq!(m.tick(true), KillAction::GiveUp);
        // 放弃之后不再发 kill（幂等：重复 tick 不刷进程）
        assert_eq!(m.tick(true), KillAction::GiveUp);
        assert_eq!(m.soft_attempts(), 2);
        assert_eq!(m.force_attempts(), 2);
    }

    #[test]
    fn shutdown_stops_early_when_process_dies_at_any_stage() {
        let mut m = ShutdownMachine::new(2);
        assert_eq!(m.tick(true), KillAction::Run(KillStage::Soft));
        assert_eq!(m.tick(false), KillAction::Done); // 软杀即退：不进强杀

        let mut m2 = ShutdownMachine::new(2);
        assert_eq!(m2.tick(true), KillAction::Run(KillStage::Soft));
        assert_eq!(m2.tick(true), KillAction::Run(KillStage::Soft));
        assert_eq!(m2.tick(true), KillAction::Run(KillStage::Force));
        assert_eq!(m2.tick(false), KillAction::Done); // 强杀后退：Done 而不是再强杀
        assert_eq!(m2.force_attempts(), 1);

        // 已经死了的进程：立刻 Done，一次 kill 都不发
        let mut m3 = ShutdownMachine::new(2);
        assert_eq!(m3.tick(false), KillAction::Done);
        assert_eq!(m3.soft_attempts(), 0);
    }

    /* ---- 关闭判据（2026-09-23 断线事故修复，不得推翻） ---- */

    #[test]
    fn stop_decision_preserves_external_client_protection() {
        // 非本应用拉起 → 不触碰
        assert_eq!(stop_decision(None, false), StopDecision::NothingToDo);
        assert_eq!(stop_decision(None, true), StopDecision::NothingToDo);
        // 有外部客户端（浏览器等）→ 保留后端（断线事故的修复语义）
        assert_eq!(stop_decision(Some(4242), true), StopDecision::Retain);
        // 只有我们自己 → 停
        assert_eq!(stop_decision(Some(4242), false), StopDecision::Stop);
    }
}
