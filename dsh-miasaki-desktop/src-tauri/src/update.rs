//! 自更新**降级方案**（W5，2026-09-25）：只做「检查 + 提示 + 打开下载页」。
//!
//! ## 为什么只做降级方案
//!
//! 真正的自更新（下载 + 静默安装）需要三样本项目目前没有的东西：**签名密钥的保管链**、
//! **CI 产线**、以及**安装前的任务准入**（官方 Electron 用 `update-tasks lock` 排空在途请求
//! 之后才敢 `quitAndInstall`；本项目的停机准入语义在 `recovery.rs::stop_decision`）。
//! 缺这些还做静默安装，风险很直接：**更新到一半把用户正在跑的会话打断**。
//! 因此本模块的边界写死 —— **能查、能提示、能打开下载页，绝不自己下载或安装**。
//!
//! ## 更新源（用户自管，不猜默认值）
//!
//! 配置文件 `%LOCALAPPDATA%\miasaki\update-source.json`（与 `server.log`、诊断报告同目录，
//! 用户点「打开日志目录」就能看到）：
//!
//! ```json
//! { "feed": "https://example.com/miasaki/version.txt", "page": "https://example.com/miasaki/" }
//! ```
//!
//! · `feed` 返回**纯文本版本号**（如 `0.2.0`）—— 刻意不用 JSON 响应：少一层解析就少一类
//!   失败面，用户自己维护这个文件时也更容易写对；
//! · `page` 是下载页，**仅在用户确认后**经系统默认浏览器打开；
//! · 缺文件 / 缺键 / 非 http(s) URL ⇒ 返回明确的中文错误（含路径），**不猜、不回落默认源**。
//!
//! ## 为什么用系统 curl 而不是新依赖
//!
//! `curl.exe` 自 Win10 1803 起随系统提供（本机实测 8.21.0）。为这个"降级方案"加一个
//! HTTP 客户端依赖（ureq + rustls ≈ +1.5 MB 与一段编译时间）并不划算。curl 缺失时
//! 返回明确错误，让用户手工检查 —— 降级方案的失败方式也应该是可读的。

use std::path::PathBuf;
use std::process::Command;

/// 配置文件名（与 `server.log` / `pet.log` / 诊断报告同目录）。
pub const SOURCE_FILE: &str = "update-source.json";
/// 网络请求超时（秒）：这是手动触发的交互式动作，不能让用户干等。
const FETCH_TIMEOUT_SECS: &str = "15";

/// 更新源配置。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateSource {
    pub feed: String,
    pub page: String,
}

/// 配置文件路径（`%LOCALAPPDATA%\miasaki\update-source.json`）。
pub fn source_path() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("miasaki").join(SOURCE_FILE)
}

/// 解析配置 JSON（**纯函数**，单测直接喂字符串）。
///
/// 只认 `http` / `https`：这两个值会分别交给 `curl` 与系统浏览器，
/// 放行 `file:` / `javascript:` 之类的 scheme 没有任何正当用途。
pub fn parse_source(json: &str) -> Result<UpdateSource, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("配置不是合法 JSON：{e}"))?;
    let pick = |key: &str| -> Result<String, String> {
        v.get(key)
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("配置缺少非空字符串字段 `{key}`"))
    };
    let feed = pick("feed")?;
    let page = pick("page")?;
    for (key, url) in [("feed", &feed), ("page", &page)] {
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err(format!("字段 `{key}` 必须是 http(s) URL：{url}"));
        }
    }
    Ok(UpdateSource { feed, page })
}

/// 读配置；缺失 / 损坏都返回**可读的中文错误**（含路径，便于用户自助修复）。
pub fn load_source() -> Result<UpdateSource, String> {
    let path = source_path();
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取配置失败（{}）：{e}", path.display()))?;
    parse_source(&text)
}

/// 版本号 → 数字段（`0.1.0` → `[0,1,0]`）。**纯函数**。
///
/// 允许前缀 `v`（`v0.2.0`）；预发布/构建元数据一律截断（`0.2.0-rc.1` → `[0,2,0]`）——
/// 降级方案只回答"远端比本地新吗"，多解析一层 semver 语义就多一类判错的机会。
pub fn parse_version(s: &str) -> Option<Vec<u64>> {
    let trimmed = s.trim();
    let trimmed = trimmed.strip_prefix('v').unwrap_or(trimmed);
    let core = trimmed.split(['-', '+']).next()?.trim();
    if core.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for part in core.split('.') {
        out.push(part.parse::<u64>().ok()?);
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 远端版本是否比本地新（**纯函数**）。任一侧无法解析 → `false`（**宁可漏报，不误报**：
/// 一个假的新版本提示会把用户推去装一个并不存在或不该装的包）。
pub fn is_newer(remote: &str, current: &str) -> bool {
    let (Some(r), Some(c)) = (parse_version(remote), parse_version(current)) else {
        return false;
    };
    // 缺失的段按 0 补齐：0.2 == 0.2.0
    let len = r.len().max(c.len());
    for i in 0..len {
        let a = *r.get(i).unwrap_or(&0);
        let b = *c.get(i).unwrap_or(&0);
        if a != b {
            return a > b;
        }
    }
    false
}

/// 经系统 `curl.exe` 取远端版本号文本。失败一律返回可读错误（不 panic、不静默）。
pub fn fetch_version(feed: &str) -> Result<String, String> {
    let out = Command::new("curl.exe")
        .args([
            "-sS", // 静默但保留错误输出
            "--fail", // HTTP >= 400 视为失败（否则会把错误页正文当版本号）
            "-L",  // 跟随重定向
            "--max-time",
            FETCH_TIMEOUT_SECS,
            feed,
        ])
        .output()
        .map_err(|e| format!("无法运行 curl.exe（Win10 1803+ 随系统提供）：{e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("请求更新源失败：{}", err.trim()));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // 去 BOM 与首尾空白：静态托管常在文件头塞 BOM，不去会把版本号判成非版本号
    let version = text.trim_start_matches('\u{feff}').trim().to_string();
    if version.is_empty() {
        return Err("更新源返回了空内容".to_string());
    }
    Ok(version)
}

/// 检查结果。**不在这里弹窗** —— UI 归 `main.rs`，本模块只回答事实。
#[derive(Debug, PartialEq, Eq)]
pub enum CheckOutcome {
    /// 发现新版本（含下载页，供用户确认后打开）
    Newer { remote: String, page: String },
    /// 已是最新
    UpToDate { current: String },
}

/// 检查更新：读配置 → 取远端版本 → 比较。`current` 由调用方传入（便于单测与在途版本口径统一）。
pub fn check(current: &str) -> Result<CheckOutcome, String> {
    let source = load_source()?;
    let remote = fetch_version(&source.feed)?;
    if is_newer(&remote, current) {
        Ok(CheckOutcome::Newer {
            remote,
            page: source.page,
        })
    } else {
        Ok(CheckOutcome::UpToDate {
            current: current.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_accepts_v_prefix_and_strips_prerelease() {
        assert_eq!(parse_version("0.1.0"), Some(vec![0, 1, 0]));
        assert_eq!(parse_version("v0.2.0"), Some(vec![0, 2, 0]));
        assert_eq!(parse_version(" 0.2.0 "), Some(vec![0, 2, 0]), "两端空白应被裁掉");
        assert_eq!(parse_version("0.2.0-rc.1"), Some(vec![0, 2, 0]), "预发布后缀截断");
        assert_eq!(parse_version("0.2.0+build.7"), Some(vec![0, 2, 0]), "构建元数据截断");
        assert_eq!(parse_version("1"), Some(vec![1]));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("abc"), None);
        assert_eq!(parse_version("0.x.0"), None, "任一段非数字即整体不可用");
    }

    #[test]
    fn is_newer_compares_segment_wise_with_zero_padding() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.0"), "同版本不算新");
        assert!(!is_newer("0.0.9", "0.1.0"), "更旧必须为 false");
        assert!(is_newer("0.1.1", "0.1.0"));
        assert!(is_newer("1.0.0", "0.99.99"), "高位段优先，不是按字符串比");
        assert!(!is_newer("0.2", "0.2.0"), "段数不同但相等 ⇒ false");
        assert!(is_newer("0.2.1", "0.2"), "补齐 0 后 0.2.1 > 0.2.0");
        assert!(is_newer("10.0.0", "9.9.9"), "多位数不得按字符串比大小");
    }

    #[test]
    fn is_newer_refuses_to_guess_on_unparsable_input() {
        assert!(!is_newer("not-a-version", "0.1.0"), "远端无法解析 ⇒ 不报新版");
        assert!(!is_newer("0.2.0", "not-a-version"), "本地无法解析 ⇒ 不报新版");
        assert!(!is_newer("", "0.1.0"));
    }

    #[test]
    fn parse_source_requires_both_keys_and_http_urls() {
        let ok = parse_source(r#"{"feed":"https://x.test/v.txt","page":"https://x.test/"}"#)
            .expect("合法配置");
        assert_eq!(ok.feed, "https://x.test/v.txt");
        assert_eq!(ok.page, "https://x.test/");

        assert!(parse_source("not json").unwrap_err().contains("合法 JSON"));
        assert!(parse_source(r#"{"feed":"https://x.test/v.txt"}"#)
            .unwrap_err()
            .contains("page"), "缺 page 必须报缺 page");
        assert!(parse_source(r#"{"feed":"","page":"https://x.test/"}"#)
            .unwrap_err()
            .contains("feed"), "空串视为缺失");
        assert!(parse_source(r#"{"feed":"file:///c:/x","page":"https://x.test/"}"#)
            .unwrap_err()
            .contains("http(s)"), "非 http(s) scheme 必须拒绝");
        assert!(parse_source(r#"{"feed":"https://x.test/v.txt","page":"javascript:alert(1)"}"#)
            .is_err(), "危险 scheme 必须拒绝");
    }

    #[test]
    fn source_path_points_at_miasaki_log_dir() {
        let p = source_path();
        assert!(p.ends_with(SOURCE_FILE));
        assert!(p.parent().map(|d| d.ends_with("miasaki")).unwrap_or(false), "必须与日志同目录");
    }
}
