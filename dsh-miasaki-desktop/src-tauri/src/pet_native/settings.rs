//! 桌宠**用户设置**持久化（`pet-settings.json`）。
//!
//! ── 为什么是独立文件，而不是塞进 `pet.json` ────────────────────────────────────
//! `pet.json` 由 `persist::save_pet_pos()` 在**拖动桌宠时高频重写**（每次 WM_MOVING 收尾）。
//! 把设置混进去会有两个真实后果：
//!   ① **拖动覆盖设置**：拖动路径写的是「内存里的整份结构」，刚在面板改的值会被旧快照盖掉；
//!   ② **加字段就丢位置**：`PetStateV2` 是严格反序列化的，加字段必须同时给默认值，
//!      漏一个就让旧文件解析失败 ⇒ 位置静默回默认（比崩掉更糟：无声）。
//! 分成两个文件后，两种生命周期互不干扰，各自演进。
//!
//! ── 版本与兼容 ────────────────────────────────────────────────────────────────
//! v1。**结构体上带 `#[serde(default)]`**：任何字段缺失都取该字段的默认值，
//! 于是「旧文件 + 新字段」和「新文件 + 去掉某字段」都能读，不需要写迁移代码。
//! 版本号不认识（0 / 99）⇒ 按损坏处理，回默认并**留痕**（不猜、不静默）。
//!
//! ── 值的可信度 ────────────────────────────────────────────────────────────────
//! 设置的两个来源（面板 / hash 字段）都**不可信**，一律走 `normalize()` 夹取到
//! 合法区间后才落地。这是既有纪律（`set_theme` 的白名单、`set_activity` 的归一化）
//! 的同一条口径：**hash 是输入，不是真相**。

use std::path::PathBuf;

/// 动效强度的合法区间（倍率）。1.0 = 现在的手感。
///
/// **E2（2026-10-04）：下限由 0.5 放行到 0.0**，即「允许完全关闭形变」。
/// 此前 0.5 的下限让「减少动效」这条诉求**无法真正落地**——用户拉到最低仍有半强度摇摆与呼吸。
/// 上游 dsh-pet 对应的是 `prefers-reduced-motion`（`pet.ts:1079` 直接 return 跳过 Q 弹、
/// `:102` 用 CSS 关掉过渡），本仓是对等实现而非开关的附庸。
///
/// **0.0 的语义边界**：`motion` 只乘在 `breath_offset` / `sway_angle` / `squash_scales` 三个
/// 形变函数上（`window.rs` 的四路调用点），置 0 ⇒ 三者恒返回中性值（0 位移 / 0 角 / 1.0 缩放），
/// **帧动画本身照常播放**——这是有意为之：关的是「动效」不是「动画」，
/// 与上游关掉 Q 弹但保留待机呼吸的处理同构。
/// 另注：`sway_layout_margin` 按 `MOTION_MAX`（1.6）而非本下限算余量，故下限变更不影响底部留白。
pub(crate) const MOTION_MIN: f32 = 0.0;
pub(crate) const MOTION_MAX: f32 = 1.6;
/// 气泡驻留的合法区间（毫秒）。默认对齐 `config::QUOTE_MS`。
pub(crate) const BUBBLE_MS_MIN: u64 = 1000;
pub(crate) const BUBBLE_MS_MAX: u64 = 10000;
/// 不透明度的合法区间（百分比）。低于 30% 会看不清，故设下限。
pub(crate) const ALPHA_MIN: u32 = 30;
pub(crate) const ALPHA_MAX: u32 = 100;

/// 宠物覆盖：空串 = 跟随主题（既有行为），否则钉死一只。
pub(crate) const PET_OVERRIDE_FOLLOW: &str = "";
pub(crate) const PET_OVERRIDES: [&str; 3] = ["whale", "kurumi", "inverse"];

/// A 批（2026-10-19，design/2026-10-19-pet-a-appearance.md）：桌宠**形象**（换装）白名单。
/// `"default"` = 现有 whale 资产（图集 + 立绘，即 `frames.json` 的平铺 `whale` 键）；
/// 其余名对应 `whale.<name>` 条目（加载期烘焙进现有字段，compose 零感知）。
/// **只对 whale 生效**——kurumi / inverse 的发型服装是角色设定，与 P2-a 配色同口径
/// （mode 门控在加载与重载处，见 `image::load_frames_for` 与 window 重载块）。
/// 加形象 = 这里加一个字符串 + 面板 `APPEARANCE_CHOICES` 加一个选项（runbook §7 六处）。
/// ⚠ 本清单刻意用**字面量**（而非 `APPEARANCE_DEFAULT` 标识符）：面板契约测试
/// （`panel-settings.test.js` 的 A 契约组）用正则从两侧抓清单做逐字镜像比对，
/// 标识符它解析不到；`APPEARANCE_DEFAULT` 必须在清单内由 Rust 单测钉死（见下）。
pub(crate) const APPEARANCE_DEFAULT: &str = "default";
pub(crate) const APPEARANCES: [&str; 1] = ["default"];

/// 穿透策略：`auto` = 按 alpha 自动（R2 现状）；`always` = 整窗可点（不做穿透）。
pub(crate) const THROUGH_AUTO: &str = "auto";
pub(crate) const THROUGH_ALWAYS: &str = "always";

/// 隐藏后的形态：`dot` = 主题头像悬浮球（现状）；`tray` = 只留托盘；`both` = 两者都有。
pub(crate) const TRAY_DOT: &str = "dot";
pub(crate) const TRAY_TRAY: &str = "tray";
pub(crate) const TRAY_BOTH: &str = "both";

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct PetSettings {
    pub(crate) version: u32,
    /// 动效强度倍率（呼吸 / 摇摆 / 挤压三条 L1 动效统一乘这个系数）。
    pub(crate) motion: f32,
    /// 气泡驻留时长（毫秒）。
    pub(crate) bubble_ms: u64,
    /// 桌宠不透明度（百分比，100 = 不透明）。
    pub(crate) alpha: u32,
    /// 钉死某只宠物；空串 = 跟随主题。
    pub(crate) pet_override: String,
    /// `auto` / `always`。
    pub(crate) through: String,
    /// `dot` / `tray` / `both`。
    pub(crate) tray: String,
    /// R20-a（2026-10-17）：全屏时自动隐藏桌宠。默认 true。
    /// 关闭路径是硬契约——「关不掉比没有更糟」。
    pub(crate) fs_hide: bool,
    /// R20-b（2026-10-17）：音效总开关（跳跃/挥手/拎起/审批/庆祝）。默认 true。
    pub(crate) sound: bool,
    /// P2-a（2026-10-18）：whale 配色预设索引（0..=`COLOR_MAX`，0 = 原色）。
    /// **只对 whale 生效**——kurumi/inverse 的发色是角色设定，不参与换色。
    /// 重着色在加载期做（`image::recolor_frames`），设置变更触发一次整份重载。
    pub(crate) color: u32,
    /// A 批（2026-10-19）：桌宠形象（whale 换装）。`"default"` = 现有资产；
    /// 其余名 = `frames.json` 的 `whale.<name>` 条目。与配色正交（两者在
    /// `load_frames_for(color, appearance)` 汇成一个加载键），同样只对 whale 生效。
    pub(crate) appearance: String,
    /// R20-c 重做（2026-10-19）：背景反差柔光总开关。默认 true。
    ///
    /// 用户实机报「有时候会有一个白圈圈着」后补的关闭路径——设计文档当初判断
    /// 「这是自动美化、关它的需求强度不够」，实机证明**审美类功能必须可关**。
    /// 关掉后 `backdrop_tick` 照常采样（采样只影响这一件事，没有别的消费者），
    /// 只是 `apply_halo` 不再跑；不影响任何行为与命中判定。
    pub(crate) halo: bool,
}

impl Default for PetSettings {
    fn default() -> Self {
        PetSettings {
            version: 1,
            motion: 1.0,
            bubble_ms: super::config::QUOTE_MS,
            alpha: ALPHA_MAX,
            pet_override: PET_OVERRIDE_FOLLOW.to_string(),
            through: THROUGH_AUTO.to_string(),
            tray: TRAY_DOT.to_string(),
            fs_hide: true,
            sound: true,
            color: 0,
            appearance: APPEARANCE_DEFAULT.to_string(),
            halo: true,
        }
    }
}

impl PetSettings {
    /// 夹取到合法区间。**每一个外部来源的值都必须先过这里**。
    /// 返回是否发生了改动 —— 调用方据此决定要不要写回（改了就写，避免无谓写盘）。
    pub(crate) fn normalize(&mut self) -> bool {
        let before = self.clone();
        self.version = 1;
        if !self.motion.is_finite() {
            self.motion = 1.0; // NaN / inf：不夹取而是回默认（f32::clamp 遇 NaN 会返回 NaN）
        }
        self.motion = self.motion.clamp(MOTION_MIN, MOTION_MAX);
        self.bubble_ms = self.bubble_ms.clamp(BUBBLE_MS_MIN, BUBBLE_MS_MAX);
        self.alpha = self.alpha.clamp(ALPHA_MIN, ALPHA_MAX);
        if !PET_OVERRIDES.contains(&self.pet_override.as_str()) {
            self.pet_override = PET_OVERRIDE_FOLLOW.to_string(); // 含空串（合法）
        }
        if self.through != THROUGH_ALWAYS {
            self.through = THROUGH_AUTO.to_string();
        }
        if ![TRAY_DOT, TRAY_TRAY, TRAY_BOTH].contains(&self.tray.as_str()) {
            self.tray = TRAY_DOT.to_string();
        }
        // P2-a：配色索引夹取（hash/文件都是不可信输入；越界回 0 = 原色，不猜）
        self.color = self.color.min(super::config::COLOR_MAX);
        // A 批：形象白名单（hash/文件都是不可信输入；越界回 default，不猜）
        if !APPEARANCES.contains(&self.appearance.as_str()) {
            self.appearance = APPEARANCE_DEFAULT.to_string();
        }
        *self != before
    }
}

pub(crate) fn settings_path() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("com.miasaki.desktop").join("pet-settings.json")
}

/// 读取设置。文件缺失 ⇒ 默认（**不写盘**：没改过就别造文件）；
/// 损坏 / 版本不认识 ⇒ 默认 + **留痕**（`pet_log_line`）。
pub(crate) fn load_settings() -> PetSettings {
    let path = settings_path();
    let txt = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return PetSettings::default(), // 首次运行：正常路径，不告警
    };
    let value: serde_json::Value = match serde_json::from_str(&txt) {
        Ok(v) => v,
        Err(e) => {
            super::window::pet_log_line(&format!(
                "[native-pet] pet-settings.json 解析失败（用默认值）: {e}\n"
            ));
            return PetSettings::default();
        }
    };
    match value.get("version").and_then(|x| x.as_u64()) {
        Some(1) | None => match serde_json::from_value::<PetSettings>(value.clone()) {
            Ok(mut s) => {
                if s.normalize() {
                    super::window::pet_log_line(
                        "[native-pet] pet-settings.json 有越界值，已夹取\n",
                    );
                }
                s
            }
            Err(e) => {
                super::window::pet_log_line(&format!(
                    "[native-pet] pet-settings.json 字段不合法（用默认值）: {e}\n"
                ));
                PetSettings::default()
            }
        },
        Some(other) => {
            super::window::pet_log_line(&format!(
                "[native-pet] pet-settings.json 版本 {other} 不认识（用默认值）\n"
            ));
            PetSettings::default()
        }
    }
}

/// 原子写（temp + rename，与 `persist::save_pet_state` 同一铁律：任何时刻不存在半写文件）。
pub(crate) fn save_settings(s: &PetSettings) {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("tmp");
    if let Ok(text) = serde_json::to_string_pretty(s) {
        if std::fs::write(&tmp, text).is_ok() {
            if let Err(e) = std::fs::rename(&tmp, &path) {
                super::window::pet_log_line(&format!(
                    "[native-pet] pet-settings.json 落盘失败: {e}\n"
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_in_range() {
        let d = PetSettings::default();
        assert_eq!(d.version, 1);
        assert_eq!(d.motion, 1.0);
        assert_eq!(d.alpha, ALPHA_MAX);
        assert_eq!(d.pet_override, PET_OVERRIDE_FOLLOW);
        assert_eq!(d.through, THROUGH_AUTO);
        assert_eq!(d.tray, TRAY_DOT);
        assert!(d.fs_hide, "R20-a：全屏隐藏默认开");
        assert!(d.sound, "R20-b：音效默认开");
        assert!(d.halo, "R20-c 重做：背景柔光默认开");
        assert!((BUBBLE_MS_MIN..=BUBBLE_MS_MAX).contains(&d.bubble_ms));
        assert_eq!(d.color, 0, "P2-a：配色默认原色（0）");
        assert_eq!(d.appearance, APPEARANCE_DEFAULT, "A 批：形象默认 default（现有资产）");
    }

    /// A 批：形象白名单——hash/文件都是不可信输入，越界回 default（不保留脏值）；
    /// 合法值（当前只有 default）不被改动。
    #[test]
    fn appearance_whitelist_falls_back() {
        let mut s = PetSettings { appearance: "godzilla".into(), ..Default::default() };
        assert!(s.normalize(), "越界形象应被夹取（返回 true 表示发生了改动）");
        assert_eq!(s.appearance, APPEARANCE_DEFAULT, "未知形象 ⇒ 回 default（不猜）");
        let mut ok = PetSettings::default();
        assert!(!ok.normalize() || ok.appearance == APPEARANCE_DEFAULT, "合法值不得被改动");
    }

    /// A 批：形象字段必须真落盘（`#[serde(default)] 只管读取；写盘靠序列化）——
    /// 旧文件缺字段回 default（兼容），新文件写出的 JSON 必须含 appearance 键。
    #[test]
    fn appearance_survives_round_trip() {
        let old: PetSettings = serde_json::from_str(r#"{"version":1}"#).unwrap();
        assert_eq!(old.appearance, APPEARANCE_DEFAULT, "旧文件缺字段回 default");
        let s = PetSettings::default();
        let txt = serde_json::to_string(&s).unwrap();
        assert!(txt.contains("\"appearance\""), "写盘 JSON 必须含 appearance 键（否则重启即丢）");
        let back: PetSettings = serde_json::from_str(&txt).unwrap();
        assert_eq!(back.appearance, s.appearance);
    }

    /// A 批：白名单必须含回落值本身——`APPEARANCES` 用字面量登记（面板契约测试
    /// 要从两侧抓清单做镜像），`APPEARANCE_DEFAULT` 是指纹常量；两者漂移
    /// （default 不在清单里）⇒ normalize 把用户看到的默认值都打成非法，静默回落死循环。
    #[test]
    fn appearance_default_is_whitelisted() {
        assert!(APPEARANCES.contains(&APPEARANCE_DEFAULT),
            "APPEARANCE_DEFAULT 必须在 APPEARANCES 白名单内（否则默认值即非法值）");
        assert_eq!(PetSettings::default().appearance, APPEARANCE_DEFAULT);
    }

    /// P2-a：配色索引越界夹取（hash/文件都是不可信输入）；合法值不动。
    #[test]
    fn color_index_is_clamped() {
        let mut s = PetSettings::default();
        s.color = 99;
        assert!(s.normalize(), "越界值应被夹取（返回 true 表示发生了改动）");
        assert_eq!(s.color, crate::pet_native::config::COLOR_MAX, "越界夹到最大合法档");
        let mut ok = PetSettings::default();
        ok.color = 3;
        assert!(!ok.normalize() || ok.color == 3, "合法值不得被改动");
        assert_eq!(ok.color, 3);
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        // 只有 version：其余字段全靠 #[serde(default)] 补齐（旧文件 + 新字段的兼容路径）
        let s: PetSettings = serde_json::from_str(r#"{"version":1}"#).unwrap();
        assert_eq!(s.motion, 1.0);
        assert_eq!(s.alpha, ALPHA_MAX);
        assert_eq!(s.tray, TRAY_DOT);
    }

    #[test]
    fn normalize_clamps_out_of_range() {
        let mut s = PetSettings { motion: 99.0, bubble_ms: 1, alpha: 1000, ..Default::default() };
        assert!(s.normalize(), "越界值必须被夹取并报告改动");
        assert_eq!(s.motion, MOTION_MAX);
        assert_eq!(s.bubble_ms, BUBBLE_MS_MIN);
        assert_eq!(s.alpha, ALPHA_MAX);
    }

    /// E2：`motion = 0`（完全关闭形变）必须能**存能读能规范化**，且不被当缺失回落。
    ///
    /// 这条钉住的是三个各自会静默出错的环节，任一坏掉都不会报错、只会「关不掉动效」：
    /// ① 反序列化：`0` 是合法 `f32`，不得被 `#[serde(default)]` 覆盖成 1.0；
    /// ② 规范化：`clamp(0.0, 1.6)` 必须留住 0.0（写成 truthy 判定就会变成 1.0）；
    /// ③ 往返：写盘再读回仍是 0.0。
    #[test]
    fn zero_motion_survives_round_trip() {
        // ① 显式写 0（不是缺字段）—— 读出来必须是 0
        let s: PetSettings = serde_json::from_str(r#"{"version":1,"motion":0.0}"#).unwrap();
        assert_eq!(s.motion, 0.0, "显式 motion:0 不得被 serde(default) 覆盖成 1.0");
        // 缺字段仍走默认 1.0（对照：0 与「没写」必须可区分）
        let d: PetSettings = serde_json::from_str(r#"{"version":1}"#).unwrap();
        assert_eq!(d.motion, 1.0, "缺字段仍回默认 1.0（0 与「没写」的区分）");

        // ② normalize 必须把 0 留住、且报告「无改动」（已在合法区间内）
        // 输入是 ① 里显式 motion:0 的那份样本——不是缺字段的 d（d 的 motion=1.0，
        // 拿它过 normalize 恒为 1.0，断言就变成恒红；首版正是拿错了 d，且从未真跑过）。
        let mut z = s.clone();
        assert!(!z.normalize(), "motion=0 在 [0.0, 1.6] 内，不该被报告为改动");
        assert_eq!(z.motion, 0.0, "normalize 不得把 0 抬回 1.0（truthy 陷阱）");

        // ③ 往返
        let json = serde_json::to_string(&z).unwrap();
        let back: PetSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.motion, 0.0, "写盘再读回必须仍是 0");
    }

    /// E2 的语义边界：`0` 关掉的是**形变**、不是**动画**——三条形变函数都要回中性值。
    ///
    /// **这条必须走 `normalize()` 才能钉住 `MOTION_MIN`**：初版直接把 `0.0` 传给形变函数，
    /// 结果反向验证时把 `MOTION_MIN` 改回 `0.5` 它**照样全绿** —— 因为压根没经过下限判定，
    /// 测的是「形变函数在 0 时是中性的」（那是 xform 的性质，与 E2 无关），
    /// 而 E2 的真实主张是「0 能通过规范化存活」。两条必须都过 normalize 才测得到。
    #[test]
    fn zero_motion_survives_normalize_and_yields_neutral_transforms() {
        use crate::pet_native::xform::{breath_offset, squash_scales, sway_angle};

        // ① 过一遍 normalize（下限判定的真实入口）
        let mut s = PetSettings { motion: 0.0, ..Default::default() };
        assert!(!s.normalize(), "motion=0 在合法区间内，不该被报告为改动");
        assert_eq!(s.motion, 0.0,
            "normalize 不得把 0 抬回 MOTION_MIN={MOTION_MIN}（truthy 陷阱）");

        // ② 归一后的值喂给形变：全部中性
        let m = s.motion;
        for t in [0_u64, 250, 500, 750] {
            assert_eq!(breath_offset(t, 2.0, m), 0.0, "t={t}: 呼吸位移须为 0");
            assert_eq!(sway_angle(t, m), 0.0, "t={t}: 摇摆角须为 0");
        }
        let (sx, sy) = squash_scales(0.0, m);
        assert!((sx - 1.0).abs() < 1e-6 && (sy - 1.0).abs() < 1e-6,
            "挤压缩放须回中性 1.0（得到 {sx} / {sy}）——0 是「不形变」不是「塌成一点」");
    }

    #[test]
    fn normalize_rejects_unknown_enums() {
        let mut s = PetSettings {
            pet_override: "godzilla".into(),
            through: "maybe".into(),
            tray: "nope".into(),
            ..Default::default()
        };
        assert!(s.normalize());
        assert_eq!(s.pet_override, PET_OVERRIDE_FOLLOW, "未知宠物 ⇒ 回跟随主题（不是保留脏值）");
        assert_eq!(s.through, THROUGH_AUTO);
        assert_eq!(s.tray, TRAY_DOT);
    }

    #[test]
    fn normalize_is_idempotent_and_keeps_valid_enums() {
        let mut s = PetSettings {
            pet_override: "kurumi".into(),
            through: THROUGH_ALWAYS.into(),
            tray: TRAY_BOTH.into(),
            motion: 1.3,
            ..Default::default()
        };
        assert!(!s.normalize(), "合法值不应被报告为改动");
        let snapshot = s.clone();
        assert!(!s.normalize(), "二次 normalize 仍不应改动");
        assert_eq!(s, snapshot);
    }

    #[test]
    fn nan_motion_falls_back_instead_of_staying_nan() {
        // f32::clamp 遇 NaN 会原样返回 NaN ⇒ 必须先判 is_finite，否则 NaN 会一路传到绘制
        let mut s = PetSettings { motion: f32::NAN, ..Default::default() };
        assert!(s.normalize());
        assert_eq!(s.motion, 1.0);
        assert!(s.motion.is_finite());
    }

    #[test]
    fn roundtrip_preserves_all_fields() {
        let s = PetSettings {
            motion: 1.25,
            bubble_ms: 5000,
            alpha: 80,
            pet_override: "whale".into(),
            through: THROUGH_ALWAYS.into(),
            tray: TRAY_TRAY.into(),
            fs_hide: false,
            sound: false,
            appearance: APPEARANCE_DEFAULT.into(),
            ..Default::default()
        };
        let txt = serde_json::to_string(&s).unwrap();
        let back: PetSettings = serde_json::from_str(&txt).unwrap();
        assert_eq!(back, s);
    }

    /// R20：两个 bool 开关必须能「显式 false」存、读、往返 —— 缺字段时回默认 true
    /// （旧文件 + 新字段的兼容路径，`#[serde(default)]` 负责；false 与「没写」因此可区分）。
    #[test]
    fn r20_switches_survive_explicit_false_round_trip() {
        // 旧文件（缺两个字段）⇒ 默认全 true
        let old: PetSettings = serde_json::from_str(r#"{"version":1}"#).unwrap();
        assert!(old.fs_hide && old.sound, "缺字段回默认 true");
        // 显式 false 必须存活（serde(default) 不得把 false 覆盖成 true）
        let off: PetSettings =
            serde_json::from_str(r#"{"version":1,"fsHide":false,"sound":false}"#).unwrap();
        assert!(!off.fs_hide && !off.sound, "显式 false 不得被默认值覆盖");
        let back: PetSettings = serde_json::from_str(&serde_json::to_string(&off).unwrap()).unwrap();
        assert!(!back.fs_hide && !back.sound, "往返后仍为 false");
        // normalize 不碰合法 bool
        let mut z = off.clone();
        assert!(!z.normalize(), "合法 bool 不应被报告改动");
        assert!(!z.fs_hide && !z.sound);
    }

    /// R20-c 重做（2026-10-19）：「背景柔光」开关必须能显式关（用户报白圈后的关闭路径）。
    /// 旧文件缺字段 ⇒ 默认 true；显式 false 必须存活（serde(default) 不得覆盖）。
    #[test]
    fn halo_switch_survives_explicit_false_round_trip() {
        let old: PetSettings = serde_json::from_str(r#"{"version":1}"#).unwrap();
        assert!(old.halo, "缺字段回默认 true（旧文件兼容）");
        let off: PetSettings = serde_json::from_str(r#"{"version":1,"halo":false}"#).unwrap();
        assert!(!off.halo, "显式 false 不得被默认值覆盖");
        let back: PetSettings = serde_json::from_str(&serde_json::to_string(&off).unwrap()).unwrap();
        assert!(!back.halo, "往返后仍为 false");
        let mut z = off.clone();
        assert!(!z.normalize(), "合法 bool 不应被报告改动");
        assert!(!z.halo);
    }
}
