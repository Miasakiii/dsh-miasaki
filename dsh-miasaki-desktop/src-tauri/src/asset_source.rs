//! 素材来源判定（2026-09-30，静默失效 #20）。
//!
//! ## 为什么要单独成一个模块
//!
//! 素材解析有**两层**：EXE 旁的磁盘 `ui/`（覆盖层）与编译期内嵌（兜底）。
//! 磁盘优先是刻意设计（dist 布局 / 开发覆盖 / 单文件拷贝回退），但它的失效形态很隐蔽：
//! **磁盘上的旧素材会静默遮蔽内嵌的新素材** —— 改了源码、重编了 EXE，界面还是旧的，
//! 全程不报错（2026-09-27/28 实际失效过一整天，靠人肉比对 SHA 才发现）。
//!
//! 更麻烦的是这个判定原本藏在 `build.rs` **生成的** `assets.rs` 里 —— 生成物不可单测。
//! 所以判据搬到这里（手写、纯函数、带测试），生成物只留薄封装。
//!
//! ## 判据（两条，都只回答「有没有版本分裂」）
//!
//! - [`resolve`]：按来源解析一个素材（磁盘优先，除非显式要求内嵌）。
//! - [`shadow_report`]：列出「磁盘有、内嵌也有、但**内容不同**」的素材 —— 这就是「遮蔽」的
//!   可观测定义。**内容相同不算遮蔽**（那只是同份素材的副本，不构成版本分裂）。
//!
//! ## 逃生门
//!
//! [`SOURCE_ENV`] 设成 `embedded` ⇒ 忽略磁盘覆盖层。磁盘上是旧素材时，这是不改部署目录
//! 就能立刻用上新素材的唯一手段（也是 E13 那类事故的应急动作）。

use std::path::Path;
use std::sync::OnceLock;

/// 编译期内嵌素材的条目（`build.rs` 生成 `ASSETS` 时复用本类型）。
pub struct Asset {
    pub path: &'static str,
    pub data: &'static [u8],
}

/// 素材来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// EXE 旁的磁盘 `ui/` 覆盖层。
    Disk,
    /// 编译期内嵌。
    Embedded,
}

/// 解析结果：数据 + 来源。
#[derive(Debug)]
pub struct Resolved {
    pub data: Vec<u8>,
    pub source: Source,
}

/// 一处「被遮蔽」的素材。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shadow {
    pub path: String,
}

/// 环境变量：`embedded` ⇒ 忽略磁盘覆盖层，一律用内嵌素材。
pub const SOURCE_ENV: &str = "MIASAKI_ASSETS_SOURCE";

/// 是否要求强制用内嵌素材（读环境变量，进程内缓存一次）。
///
/// 缓存是必要的：`read()` 会被每个素材各调一次（asset-server 每请求一次），
/// 而进程内环境变量不会变。
pub fn prefer_embedded_from_env() -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        matches!(
            std::env::var(SOURCE_ENV).ok().as_deref(),
            Some("embedded") | Some("Embedded") | Some("EMBEDDED")
        )
    })
}

/// 统一分隔符：生成的清单用正斜杠，磁盘 `join` 在 Windows 上也吃正斜杠。
fn rel_slashes(rel: &str) -> String {
    rel.replace('\\', "/")
}

/// 解析一个素材。
///
/// - `ui_dir`：磁盘覆盖层目录（EXE 旁的 `ui/`）；`None` = 该层不可用
/// - `embedded`：编译期内嵌数据；`None` = 该素材未内嵌
/// - `prefer_embedded`：`true` ⇒ 跳过磁盘层（逃生门）
pub fn resolve(
    rel: &str,
    ui_dir: Option<&Path>,
    embedded: Option<&[u8]>,
    prefer_embedded: bool,
) -> Option<Resolved> {
    if !prefer_embedded {
        if let Some(dir) = ui_dir {
            if let Ok(data) = std::fs::read(dir.join(rel_slashes(rel))) {
                return Some(Resolved { data, source: Source::Disk });
            }
        }
    }
    embedded.map(|d| Resolved { data: d.to_vec(), source: Source::Embedded })
}

/// 列出被磁盘覆盖层遮蔽的素材：磁盘有、内嵌也有，但**内容不同**。
///
/// 磁盘有而内嵌没有的（例如用户自加的素材）**不算** —— 那不是遮蔽，是新增。
pub fn shadow_report(ui_dir: &Path, assets: &[Asset]) -> Vec<Shadow> {
    let mut out = Vec::new();
    for a in assets {
        let Ok(disk) = std::fs::read(ui_dir.join(rel_slashes(a.path))) else { continue };
        if disk != a.data {
            out.push(Shadow { path: a.path.to_string() });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// 启动日志用的一行摘要。
///
/// 没有分裂就**不说话**（避免每次启动写一行噪声 —— 本仓有过「pet.log 以 1.32 行/秒
/// 持续 5 小时」的教训）；有分裂则点名前 5 个 + 总数 + 逃生门提示。
pub fn shadow_summary(total: usize, shadows: &[Shadow], prefer_embedded: bool) -> Option<String> {
    if prefer_embedded {
        return Some(format!(
            "[assets] {SOURCE_ENV}=embedded —— 忽略磁盘 ui/ 覆盖层，{total} 个素材全部取自内嵌"
        ));
    }
    if shadows.is_empty() {
        return None;
    }
    let head: Vec<&str> = shadows.iter().take(5).map(|s| s.path.as_str()).collect();
    let more = if shadows.len() > head.len() {
        format!(" 等 {} 个", shadows.len())
    } else {
        String::new()
    };
    Some(format!(
        "[assets] 磁盘 ui/ 与内嵌素材有 {} 处内容不同（磁盘在遮蔽内嵌）：{}{}；如需强制内嵌设 {SOURCE_ENV}=embedded",
        shadows.len(),
        head.join("、"),
        more
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// 每个用例一个独立临时目录（用进程 id + 计数避免并行用例互踩）。
    ///
    /// 基目录刻意选**测试可执行文件所在目录**（`target/**/deps/`）而非 `std::env::temp_dir()`：
    /// 后者在本机 cargo test 的运行环境里不可写（实测 `create_dir_all` 报
    /// `Os { code: 5, PermissionDenied }`，5 个用例一起挂）。cargo 刚往该目录写产物 ⇒ 必可写。
    fn scratch(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let base = std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!(
            "miasaki-asset-source-{}-{}-{}",
            std::process::id(),
            tag,
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    fn write(dir: &Path, rel: &str, bytes: &[u8]) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(p, bytes).expect("write asset");
    }

    #[test]
    fn resolve_prefers_disk_over_embedded() {
        let dir = scratch("disk-priority");
        write(&dir, "pets/frames.json", b"from-disk");
        let r = resolve("pets/frames.json", Some(&dir), Some(b"embedded"), false).expect("resolved");
        assert_eq!(r.source, Source::Disk);
        assert_eq!(r.data, b"from-disk");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_falls_back_to_embedded_when_disk_missing() {
        let dir = scratch("fallback");
        let r = resolve("pets/frames.json", Some(&dir), Some(b"embedded"), false).expect("resolved");
        assert_eq!(r.source, Source::Embedded, "磁盘没有该素材时必须回退内嵌");
        assert_eq!(r.data, b"embedded");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_escape_hatch_ignores_disk_layer() {
        let dir = scratch("escape-hatch");
        write(&dir, "pets/frames.json", b"stale-disk");
        let r = resolve("pets/frames.json", Some(&dir), Some(b"fresh-embedded"), true).expect("resolved");
        assert_eq!(r.source, Source::Embedded, "逃生门必须压过磁盘层");
        assert_eq!(r.data, b"fresh-embedded");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_returns_none_when_neither_layer_has_it() {
        let dir = scratch("none");
        assert!(resolve("pets/ghost.png", Some(&dir), None, false).is_none());
        assert!(resolve("pets/ghost.png", None, None, false).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn shadow_report_flags_only_content_mismatch() {
        let dir = scratch("shadow");
        write(&dir, "pets/different.png", b"old");
        write(&dir, "pets/same.png", b"identical");
        let assets = [
            Asset { path: "pets/different.png", data: b"new" },
            Asset { path: "pets/same.png", data: b"identical" },
            Asset { path: "pets/disk-only.png", data: b"embedded" },
        ];
        let report = shadow_report(&dir, &assets);
        // 只有「两边都有且内容不同」才算遮蔽：
        // - different.png：磁盘 old vs 内嵌 new ⇒ 入列
        // - same.png：内容相同 ⇒ 不入列（同份素材的副本）
        // - disk-only.png：磁盘没有 ⇒ 不入列（内嵌直出，不存在遮蔽）
        assert_eq!(report.len(), 1, "报告：{report:?}");
        assert_eq!(report[0].path, "pets/different.png");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn shadow_summary_is_silent_without_split() {
        assert!(shadow_summary(100, &[], false).is_none(), "无分裂不得产生日志噪声");
    }

    #[test]
    fn shadow_summary_names_paths_and_escape_hatch() {
        let shadows: Vec<Shadow> = (0..7)
            .map(|i| Shadow { path: format!("pets/p{i}.png") })
            .collect();
        let line = shadow_summary(120, &shadows, false).expect("summary");
        assert!(line.contains("7 处"), "必须给出总数：{line}");
        assert!(line.contains("pets/p0.png"), "必须点名：{line}");
        assert!(line.contains("等 7 个"), "超过 5 个要显式说明：{line}");
        assert!(line.contains(SOURCE_ENV), "必须给出逃生门：{line}");
    }

    #[test]
    fn shadow_summary_reports_escape_hatch_engagement() {
        let line = shadow_summary(120, &[], true).expect("summary");
        assert!(line.contains("忽略磁盘"), "逃生门生效时要留痕：{line}");
    }
}
