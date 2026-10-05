//! 启动片头决定（appearance 线的桌面消费端 #2）。
//!
//! 外观设置页「启动」栏写 `<dshHome>/miasaki-appearance/config.json`，本模块读同一份配置，
//! 决定加载页（`ui/loading.html`）是否铺全屏视频片头、放哪一段、是否出声。
//! 设计见 `design/2026-10-04-boot-intro-video.md`（§5-D3/D5/D10）。
//!
//! ## 跨线契约（改一处必须同时改 `dsh-miasaki-appearance` 的 `lib/config.js` 与 `client.js`）
//!
//! | 项 | 值 |
//! |---|---|
//! | 配置路径 | `<dshHome>/miasaki-appearance/config.json`（与 `launcher_icon` 同源） |
//! | 门控 | 顶层 `enabled === true`（总开关，与 `splashEnabled` 同源纪律） |
//! | 字段 | `boot.intro`（枚举）/ `boot.audio`（布尔，默认 false） |
//! | 枚举值域 | `brand` / `cyberpunk` / `awakening` / `startup`，与 `ui/intro/intro-<id>.mp4` 一一对应 |
//! | 未知值 | 一律归「不播」（宁可不播，不猜） |
//!
//! ## 边界
//!
//! * **只读本地文件，绝不联网**；配置缺失 / 损坏 / 字段非法 ⇒ 一律「不播」。
//! * 异常绝不拖住启动：本模块只做一次纯读，任何失败都返回「不播」，从不 panic、从不报错。
//! * 与 avatar 的 1.5s 巡检**不同，本模块不轮询**：片头只活在启动头几秒，
//!   面板改动以「下次启动生效」为准（面板说明行已写明）。

use std::fs;
use std::path::Path;

use crate::launcher_icon::{dsh_home, CONFIG_REL};

/// 可选片头 id —— 与 `ui/intro/intro-<id>.mp4` 台账、appearance `boot.intro` 枚举**三方同源**。
pub const INTRO_IDS: [&str; 4] = ["brand", "cyberpunk", "awakening", "startup"];

/// 宿主侧的启动片头决定。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootIntro {
    /// 要播的段 id；`None` = 不播（总开关关 / 关闭档 / 配置不可用 / 未知值）。
    pub intro: Option<String>,
    /// 是否出声（出厂与一切异常档都是 false）。
    pub audio: bool,
}

impl BootIntro {
    /// 「不播」——关闭态与一切异常的归一点。
    pub fn off() -> Self {
        Self { intro: None, audio: false }
    }
}

/// **决策矩阵（零依赖纯函数，落地判据的唯一实现）**。
///
/// 事实来源三分：总开关（`enabled`）/ 段落枚举（`boot.intro`）/ 音轨（`boot.audio`）。
/// 只有「总开关开 + 段 id 在白名单内」才播；其余一律不播。
///
/// @param enabled - 顶层 `enabled` 的布尔值（缺字段 / 非布尔 ⇒ 调用方传 false）。
/// @param intro - `boot.intro` 原样字符串（缺字段 / 非字符串 ⇒ None）。
/// @param audio - `boot.audio` 的布尔值（缺字段 / 非布尔 ⇒ 调用方传 false）。
pub fn decide(enabled: bool, intro: Option<&str>, audio: bool) -> BootIntro {
    if !enabled {
        return BootIntro::off();
    }
    match intro {
        Some(id) if INTRO_IDS.contains(&id) => BootIntro {
            intro: Some(id.to_string()),
            audio,
        },
        _ => BootIntro::off(),
    }
}

/// 从配置 JSON 文本解析启动片头决定（serde 提取 → 交给 [`decide`] 判）。
///
/// 提取层只做「取三个原语」，任何形状异常都退化成 `decide` 的关闭输入 —— 判定逻辑
/// 因此只有一份实现，JSON 细节不会长出第二套判据。
/// @param json - `config.json` 全文。
pub fn parse_boot_intro(json: &str) -> BootIntro {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return BootIntro::off();
    };
    let enabled = value.get("enabled").and_then(|v| v.as_bool()) == Some(true);
    let Some(boot) = value.get("boot") else {
        // 没有 boot 板块（旧版本配置 / 面板从未保存过）⇒ 视同关闭输入。
        // 出场默认值由 appearance 侧 schema 迁移负责补 `boot`（v6 → v7），本模块不猜。
        return decide(enabled, None, false);
    };
    let audio = boot.get("audio").and_then(|v| v.as_bool()) == Some(true);
    let intro = boot.get("intro").and_then(|v| v.as_str());
    decide(enabled, intro, audio)
}

/// 读磁盘配置并解析（本模块**唯一** IO 入口）。
/// @param home - 已解析的 dshHome；None ⇒ 不播（调用 [`read_boot_intro`] 可省这层）。
pub fn read_boot_intro_at(home: Option<&Path>) -> BootIntro {
    let Some(home) = home else { return BootIntro::off() };
    match fs::read_to_string(home.join(CONFIG_REL)) {
        Ok(text) => parse_boot_intro(&text),
        Err(_) => BootIntro::off(),
    }
}

/// 解析 dshHome 并读取启动片头决定。
pub fn read_boot_intro() -> BootIntro {
    read_boot_intro_at(dsh_home().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decide_plays_only_when_enabled_and_known() {
        let on = decide(true, Some("brand"), false);
        assert_eq!(on.intro.as_deref(), Some("brand"));
        assert!(!on.audio);
        // 总开关关 ⇒ 一律不播（与 splashEnabled 同源纪律）
        assert_eq!(decide(false, Some("brand"), true), BootIntro::off());
        // 未知 id ⇒ 不播（不猜）
        assert_eq!(decide(true, Some("bogus"), false), BootIntro::off());
        // 缺字段 ⇒ 不播
        assert_eq!(decide(true, None, false), BootIntro::off());
    }

    #[test]
    fn decide_covers_all_ids_and_audio() {
        for id in INTRO_IDS {
            let d = decide(true, Some(id), true);
            assert_eq!(d.intro.as_deref(), Some(id), "id {id} 必须被接受");
            assert!(d.audio, "audio 必须透传");
        }
        // 空串 / 大小写敏感 / 前缀相似值都不是合法 id
        for bad in ["", "BRAND", "brand ", "brandx", "off"] {
            assert_eq!(decide(true, Some(bad), false), BootIntro::off(), "非法 id {bad:?} 必须不播");
        }
    }

    #[test]
    fn parse_reads_three_primitives() {
        let json = r#"{"version":7,"enabled":true,"boot":{"intro":"cyberpunk","audio":true}}"#;
        let d = parse_boot_intro(json);
        assert_eq!(d.intro.as_deref(), Some("cyberpunk"));
        assert!(d.audio);
    }

    #[test]
    fn parse_defaults_audio_to_silent() {
        let json = r#"{"enabled":true,"boot":{"intro":"startup"}}"#;
        let d = parse_boot_intro(json);
        assert_eq!(d.intro.as_deref(), Some("startup"));
        assert!(!d.audio, "audio 缺字段必须静音");
    }

    #[test]
    fn parse_handles_hostile_inputs_without_playing() {
        // 损坏 JSON / 非对象 / 缺 boot / boot 非对象 / 字段类型错 —— 全部不播，且不 panic
        for json in [
            "",
            "not json",
            "[]",
            "null",
            r#"{"enabled":true}"#,
            r#"{"enabled":true,"boot":"brand"}"#,
            r#"{"enabled":true,"boot":{"intro":123,"audio":"yes"}}"#,
            r#"{"enabled":false,"boot":{"intro":"brand","audio":true}}"#,
        ] {
            assert_eq!(parse_boot_intro(json), BootIntro::off(), "输入 {json:?} 必须不播");
        }
    }

    #[test]
    fn parse_respects_master_switch() {
        let json = r#"{"enabled":false,"boot":{"intro":"brand","audio":true}}"#;
        assert_eq!(parse_boot_intro(json), BootIntro::off(), "总开关关闭 ⇒ 不播（关掉即原生）");
    }

    #[test]
    fn read_at_missing_home_or_file_is_off() {
        assert_eq!(read_boot_intro_at(None), BootIntro::off());
        let missing = Path::new("Z:\\__no_such_dir__\\nope");
        assert_eq!(read_boot_intro_at(Some(missing)), BootIntro::off());
    }
}
