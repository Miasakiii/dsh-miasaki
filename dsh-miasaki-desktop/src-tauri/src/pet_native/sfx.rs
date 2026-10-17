//! R20-b（2026-10-17，design/2026-10-17-pet-fullscreen-sfx-sprint.md §3.2）：程序化音效播放。
//!
//! 音效本体由 `scripts/gen-sfx.mjs` 在**构建期合成**（振荡器+噪声，零音频资产），
//! 经 `build.rs` 显式登记编译期内嵌；本模块只负责「按名取出 → winmm 异步播放」。
//!
//! 三条纪律：
//! - **设置门在调用方**（`PetWin::sfx` 读 `shared.settings.sound`）——本模块不持锁，
//!   与 `dot_enabled()` 的「短临界区在窗口层」模式一致；
//! - **`'static` 缓冲区**：`assets::find()` 返回编译期内嵌的 `&'static [u8]`，
//!   `PlaySoundW(SND_MEMORY|SND_ASYNC)` 异步播放期间缓冲区始终有效，无悬挂指针；
//! - **后响替换前响**（不加 `SND_NOSTOP`）：连打桌宠时不叠音不爆音；
//! - **未知名 / 缺素材静默**：不猜、不播错音；首次缺失留一行日志（`static` 节流，
//!   照 R16 `CAPTURE_WARNED` 先例——播放路径在交互热点上，不能刷盘）。

use super::ffi::*;

/// 音效名表。**三处必须一致**：本表 ↔ `scripts/gen-sfx.mjs` 的参数表 ↔ `build.rs` 的登记
/// （漏一处 = 该音效静默失踪；`every_declared_sfx_resolves_to_an_embedded_asset` 钉住
/// 本表与 build.rs 的关系，`gen-sfx.mjs --check` 钉住产物与生成器的关系）。
pub(crate) const SFX_NAMES: [&str; 8] =
    ["jump", "land", "wave", "grab", "drop", "alert", "done", "tick"];

/// 按名取内嵌音效字节。**纯查找、不碰 Win32**（可单测）：未知名 / 未登记 ⇒ `None`。
pub(crate) fn resolve(name: &str) -> Option<&'static [u8]> {
    if !SFX_NAMES.contains(&name) {
        return None;
    }
    crate::assets::find(&format!("pets/sfx/{name}.wav"))
        .map(|a| a.data as &'static [u8])
}

/// 播放一个音效（异步）。未知名 / 素材缺失 ⇒ 静默返回（false）。
///
/// 调用方必须先过设置门（sound 开关）——本函数不做该判断（见模块头）。
pub(crate) fn play(name: &str) -> bool {
    let Some(wav) = resolve(name) else {
        // 已知名但取不到字节 = build.rs 登记漂移或磁盘覆盖层删了文件 —— 首次留痕
        if SFX_NAMES.contains(&name) {
            static WARNED: std::sync::atomic::AtomicBool =
                std::sync::atomic::AtomicBool::new(false);
            if !WARNED.swap(true, std::sync::atomic::Ordering::SeqCst) {
                super::window::pet_log_line(&format!(
                    "[native-pet] sfx: {name}.wav 未内嵌/被覆盖层移除（音效静默）\n"
                ));
            }
        }
        return false;
    };
    unsafe {
        PlaySoundW(wav.as_ptr(), 0, SND_MEMORY | SND_ASYNC);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R20-b-1：未知名恒静默（不猜、不播错音；拼错的名字必须无声无副作用）。
    #[test]
    fn unknown_sfx_name_is_silent() {
        assert!(resolve("nope").is_none());
        assert!(resolve("").is_none());
        assert!(resolve("JUMP").is_none(), "大小写敏感——表是小写");
        assert!(!play("nope"), "未知名不得尝试播放");
    }

    /// R20-b-2：**登记契约**——名表里每一个都必须在内嵌资产里找得到。
    ///
    /// 这条钉住「SFX_NAMES ↔ build.rs 登记」的关系：加了个名字却忘了在 build.rs
    /// 登记（或 gen-sfx 没跑），这里就红。没有它，漂移的表现是「那个音效永远不响」，
    /// 而功能测试一条都抓不到。
    #[test]
    fn every_declared_sfx_resolves_to_an_embedded_asset() {
        for name in SFX_NAMES {
            let wav = resolve(name);
            assert!(wav.is_some(), "{name}.wav 未内嵌——build.rs 登记或 gen-sfx 漏了");
            let wav = wav.unwrap();
            assert!(wav.len() > 44, "{name}.wav 至少要有 RIFF 头");
            assert_eq!(&wav[0..4], b"RIFF", "{name}.wav 不是 RIFF");
            assert_eq!(&wav[8..12], b"WAVE", "{name}.wav 不是 WAVE");
            assert_eq!(&wav[36..40], b"data", "{name}.wav 缺 data 块");
        }
    }
}
