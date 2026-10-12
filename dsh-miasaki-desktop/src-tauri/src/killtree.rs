//! 快速停机：Win32 快照 + 逐进程 `TerminateProcess` 终止整棵进程树（2026-10-12）。
//!
//! **为什么要有它**（用户实机反馈「退出和重启都有点慢」的根因）：停机阶梯原先每一步都
//! 拉起一次 `taskkill.exe`，而本机实测（2026-10-12，探针与壳内同一调用方式
//! `std::process::Command::output()`）：
//!
//! | 动作 | 耗时 |
//! |---|---|
//! | `cmd /C exit`（纯进程创建基线） | **13 ms** |
//! | `taskkill /PID <node> /T`（软杀） | **630–780 ms** |
//! | `taskkill /PID <node> /T /F`（强杀） | **540–800 ms** |
//! | `netstat -ano` | 20 ms |
//! | **本模块：快照 9 ms + 逐进程终止 0.2 ms** | **~10 ms** |
//!
//! 阶梯要发两次 ⇒ 光「杀进程」就 1.2–1.6s；再叠加固定观察窗（软杀 0.3s + 0.3s、强杀
//! 0.3s + 1s）与 netstat 探测，用户点「退出」后要等 2–3s 窗口才消失、轻量重启实测
//! 5.8–7.0s（`pet.log` 的 `restart: 完成（耗时 …）`）。
//!
//! **语义不变**：`TerminateProcess` 与 `taskkill /F` 是同一个内核动作（进程被强制结束、
//! 无善后机会）—— 现状真正生效的本来就是强杀（软杀对控制台进程必然无效，见
//! `stop_backend_tiered` 的注释与本机回归 `soft_taskkill_does_not_terminate_a_console_child`），
//! 所以这不是「用更粗暴的方式换速度」，而是「用同一条代价更小的路径做同一件事」。
//!
//! **边界（刻意保留，别在后续清理里删掉）**：
//! - **不替代软杀**：`taskkill` 不带 `/F` 是「发关闭请求」（`WM_CLOSE`），只有**带顶层窗口**
//!   的进程收得到；判据 `pid_has_top_level_window` 让调用方按事实决定是否保留软杀档，
//!   而不是无差别跳过。
//! - **失败必须可见、且必须回落**：任何一步没能让根进程退出，调用方仍走 `taskkill` 阶梯
//!   （最坏与旧实现等价）；本模块只如实报告结局，绝不吞错。
//! - **只终止调用方指名的那棵树**：子树由 `ppid` 闭包推出，绝不按进程名匹配。
//! - **子先于父**：先终止叶再终止根，避免根先死导致子树变成孤儿后再也找不到父子关系。

#[cfg(target_os = "windows")]
use core::ffi::c_void;

/// 一次树终止的结局（**如实报告**，供调用方判断是否需要回落 `taskkill`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeKill {
    /// 实际尝试终止的 pid，**叶 → 根**顺序（最后一个元素恒为根）。
    pub targets: Vec<u32>,
    /// `TerminateProcess` 返回成功的个数。
    pub terminated: u32,
    /// `(pid, Win32 错误码)`：打开或终止被系统拒绝的项（空 = 全部成功）。
    pub failures: Vec<(u32, u32)>,
}

impl TreeKill {
    /// 根进程是否被本模块成功终止过（调用方仍应复查存活，见 `process_alive`）。
    pub fn root_terminated(&self, root: u32) -> bool {
        self.targets.last() == Some(&root)
            && self.terminated > 0
            && !self.failures.iter().any(|(pid, _)| *pid == root)
    }
}

/// 进程快照 `(pid, ppid)` 列表（Toolhelp；失败 → 空表，调用方据此退化为「只处理根进程」）。
///
/// 本机实测 367 个进程约 **9 ms** —— 比一次 `taskkill` 便宜两个数量级。
#[cfg(target_os = "windows")]
pub fn snapshot_process_pairs() -> Vec<(u32, u32)> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut out: Vec<(u32, u32)> = Vec::with_capacity(384);
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() || snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as _;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                out.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}

#[cfg(not(target_os = "windows"))]
pub fn snapshot_process_pairs() -> Vec<(u32, u32)> {
    Vec::new()
}

/// **纯函数**：从 `(pid, ppid)` 表推出 `root` 的全部后代，**父先子后**（BFS 逐层）。
///
/// 去重、防自环、防假环（快照可能出现 `ppid` 指向已退出进程的 pid、甚至等于自身）：
/// 每层只收「尚未收录且不是根」的 pid，因此无论输入多脏都会收敛。
pub fn descendants_of(root: u32, pairs: &[(u32, u32)]) -> Vec<u32> {
    let mut found: Vec<u32> = Vec::new();
    let mut frontier: Vec<u32> = vec![root];
    while !frontier.is_empty() {
        let mut next: Vec<u32> = Vec::new();
        for (pid, ppid) in pairs {
            if *pid != root && frontier.contains(ppid) && !found.contains(pid) {
                found.push(*pid);
                next.push(*pid);
            }
        }
        frontier = next;
    }
    found
}

/// **纯函数**：终止顺序 —— 叶 → 根（`descendants_of` 的反序 + root 收尾）。
///
/// 反序即「子先于父」：BFS 里子恒在父之后入列，逆序后子恒在父之前。
pub fn terminate_order(root: u32, pairs: &[(u32, u32)]) -> Vec<u32> {
    let mut order: Vec<u32> = descendants_of(root, pairs);
    order.reverse();
    order.push(root);
    order
}

/// 目标进程是否拥有**顶层窗口** —— `taskkill` 不带 `/F`（发 `WM_CLOSE`）能否生效的前提。
///
/// 用途：`stop_backend_tiered` 据此决定要不要保留软杀档。本机后端是 `node.exe`
/// （直启、无窗口），软杀必然无效（实测每次净花 630–780ms 换来一句
/// `can only be terminated forcefully`）—— 无窗口就不发，是**判据**而不是拍脑袋跳过；
/// 将来后端若变成 GUI 进程或带上控制台窗口，本判据自动为真、软杀档自动回来。
#[cfg(target_os = "windows")]
pub fn pid_has_top_level_window(pid: u32) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId};

    struct Ctx {
        pid: u32,
        found: bool,
    }
    unsafe extern "system" fn visit(hwnd: *mut c_void, lparam: isize) -> i32 {
        let ctx = &mut *(lparam as *mut Ctx);
        let mut owner = 0u32;
        GetWindowThreadProcessId(hwnd, &mut owner);
        if owner == ctx.pid {
            ctx.found = true;
            return 0; // 0 = 停止枚举
        }
        1
    }

    let mut ctx = Ctx { pid, found: false };
    unsafe {
        EnumWindows(Some(visit), &mut ctx as *mut Ctx as isize);
    }
    ctx.found
}

/// 非 Windows：无从判断，**保守返回 true**（保留软杀档，行为与旧实现一致）。
#[cfg(not(target_os = "windows"))]
pub fn pid_has_top_level_window(_pid: u32) -> bool {
    true
}

/// `GetExitCodeProcess` 对仍活着的进程返回的退出码（Win32 `STILL_ACTIVE`）。
/// windows-sys 0.59 未在 `Win32::System::Threading` 导出该常量（原 main.rs 也是本地声明），
/// 判据随实现搬到本模块，全仓只此一份。
#[cfg(target_os = "windows")]
const STILL_ACTIVE: u32 = 259;

/// 进程是否仍活着（`OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` +
/// `GetExitCodeProcess == STILL_ACTIVE`）。进程不存在 → `OpenProcess` 返回 NULL → false。
/// 零 crate、零子进程拉起 —— 停机轮询与看门狗判活共用这一份判据。
#[cfg(target_os = "windows")]
pub fn process_alive(pid: u32) -> bool {
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
pub fn process_alive(_pid: u32) -> bool {
    true
}

/// 终止单个进程。`Err(win32 错误码)` = 打开或终止被拒（权限不足、进程已不存在等）。
#[cfg(target_os = "windows")]
fn terminate_one(pid: u32) -> Result<(), u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return Err(GetLastError());
        }
        let ok = TerminateProcess(handle, 1);
        let err = if ok == 0 { GetLastError() } else { 0 };
        let _ = CloseHandle(handle);
        if ok == 0 {
            Err(err)
        } else {
            Ok(())
        }
    }
}

/// 终止整棵进程树：**快照 → 推子树 → 叶到根逐个 `TerminateProcess`**。
///
/// 本机实测 2 进程树 **208 µs**（同树 `taskkill /T /F` 680 ms）。失败项如实进
/// `failures`，调用方据此决定是否回落 `taskkill`。
#[cfg(target_os = "windows")]
pub fn terminate_tree(root: u32) -> TreeKill {
    let pairs = snapshot_process_pairs();
    let targets = terminate_order(root, &pairs);
    let mut report = TreeKill {
        targets: targets.clone(),
        terminated: 0,
        failures: Vec::new(),
    };
    for pid in &targets {
        match terminate_one(*pid) {
            Ok(()) => report.terminated += 1,
            Err(code) => report.failures.push((*pid, code)),
        }
    }
    report
}

/// 非 Windows：空实现（本应用是 Windows 桌面壳，此分支只为编译完整）。
#[cfg(not(target_os = "windows"))]
pub fn terminate_tree(root: u32) -> TreeKill {
    TreeKill {
        targets: vec![root],
        terminated: 0,
        failures: vec![(root, 0)],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 样本树：1 → {10, 11}，10 → {12}；另有无关分支 90 → {99}。
    fn sample() -> Vec<(u32, u32)> {
        vec![(10, 1), (11, 1), (12, 10), (99, 90), (1, 0)]
    }

    #[test]
    fn descendants_are_parent_first_and_deduped() {
        assert_eq!(
            descendants_of(1, &sample()),
            vec![10, 11, 12],
            "必须是父先子后的 BFS 顺序，且不含无关分支与根自身"
        );
    }

    #[test]
    fn terminate_order_kills_leaves_before_their_parents() {
        let order = terminate_order(1, &sample());
        assert_eq!(*order.last().unwrap(), 1, "根必须最后终止");
        let pos = |p: u32| order.iter().position(|x| *x == p).expect("pid 应在顺序里");
        assert!(pos(12) < pos(10), "孙进程必须先于父进程被终止");
        assert!(pos(10) < pos(1) && pos(11) < pos(1), "子进程必须先于根被终止");
    }

    #[test]
    fn descendants_survive_self_loop_and_fake_cycle() {
        // 快照脏数据：自环 (1,1) + 假环 (2,3)/(3,2) + 一条真后代 (5,1)
        let weird = vec![(1, 1), (2, 3), (3, 2), (5, 1)];
        let kids = descendants_of(1, &weird);
        assert_eq!(kids, vec![5], "只认真后代：自环不得把自己算进去，假环不得死循环");
        assert!(!kids.contains(&1), "根永远不是自己的后代");
    }

    #[test]
    fn descendants_of_unknown_root_is_empty() {
        assert!(descendants_of(777, &sample()).is_empty());
        assert_eq!(terminate_order(777, &sample()), vec![777]);
    }

    #[test]
    fn root_terminated_judgement_is_honest_about_failures() {
        let ok = TreeKill {
            targets: vec![12, 10, 1],
            terminated: 3,
            failures: Vec::new(),
        };
        assert!(ok.root_terminated(1));
        let denied = TreeKill {
            targets: vec![12, 10, 1],
            terminated: 2,
            failures: vec![(1, 5)],
        };
        assert!(!denied.root_terminated(1), "根被拒时不得报成功");
        let empty = TreeKill {
            targets: Vec::new(),
            terminated: 0,
            failures: Vec::new(),
        };
        assert!(!empty.root_terminated(1));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn snapshot_contains_self_and_is_not_empty() {
        let me = std::process::id();
        let pairs = snapshot_process_pairs();
        assert!(
            pairs.len() > 4,
            "进程快照不应为空（当前只有 {} 条）",
            pairs.len()
        );
        assert!(
            pairs.iter().any(|(pid, _)| *pid == me),
            "快照必须含本进程 pid {me}"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn terminate_tree_on_missing_pid_reports_failure_instead_of_silence() {
        let bogus: u32 = 0xFFFF_FFF0;
        let report = terminate_tree(bogus);
        assert_eq!(report.targets, vec![bogus]);
        assert_eq!(report.terminated, 0);
        assert!(
            !report.failures.is_empty(),
            "终止不存在的进程必须如实报告失败（否则调用方会以为杀成功了）"
        );
        assert!(!report.root_terminated(bogus));
    }

    /// 真机取证：起一个真子进程，用本模块杀掉，断言它真的死了。
    /// 受限环境（沙箱拒绝 `OpenProcess`）按**环境**跳过，不判成代码缺陷 —— 与
    /// `taskkill_reports_ok_denied_or_failure_but_never_silently` 同口径。
    #[cfg(target_os = "windows")]
    #[test]
    fn terminate_tree_really_kills_a_live_child() {
        let child = std::process::Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn();
        let Ok(mut child) = child else {
            eprintln!("[env] 无法拉起 ping 子进程 → 跳过");
            return;
        };
        let pid = child.id();
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(process_alive(pid), "刚拉起的子进程应当活着");

        let report = terminate_tree(pid);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while process_alive(pid) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let gone = !process_alive(pid);
        if report.terminated == 0 && !gone {
            eprintln!(
                "[env] TerminateProcess 被拒（{:?}）→ 沙箱限制，跳过断言",
                report.failures
            );
            let _ = child.kill();
            let _ = child.wait();
            return;
        }
        assert!(report.root_terminated(pid), "报告必须说清根进程被杀：{report:?}");
        assert!(gone, "Win32 树终止后该进程必须已不存在");
        let _ = child.wait();
    }
}
