# Miasaki Desktop

> Miasaki 专属 DSH 桌面端 — Tauri 2 薄壳 + 三主题（原版简约纯净 / 刻刻帝 / 狂狂帝）

双击 EXE → 自动拉起 `dsh web`（如未运行）→ 打开 DSH Web GUI，并注入三套原创主题皮肤与悬浮切换条。**不修改 DSH 本体**：主题以令牌层覆盖（`--dsw-static-*` 色阶）实现，DSH 升级不受影响。

## 快速开始

```bash
npm install                 # 安装 @tauri-apps/cli
npm run gen-init            # 内联主题 → src-tauri/injected/theme-init.js（含令牌完备性校验）
npm run tauri dev           # 开发运行
npm run tauri build         # 产出 Windows 安装包/EXE（src-tauri/target/release/）
```

## 三个主题

| 主题 | 概念 | 说明 |
|---|---|---|
| `pure` | 原版简约纯净 | 零覆盖，DSH 原生样貌透传（兜底主题） |
| `zafkiel` | 刻刻帝 · 永夜钟阁 | 暗夜基底 · 绯红交互 · 鎏金装饰 · 表盘水印 · 金色光标 |
| `kurkuriel` | 狂狂帝 · 白夜逆钟 | 骨白基底 · 血绯交互 · 枪铁装饰 · 破裂表盘 · 星座母题 |

切换：右下角悬浮按钮 → 悬停展开三主题；选择持久化于 localStorage，重启保持。

## Q 版桌宠（Codex 风格）

透明置顶小窗桌宠，随主题自动换角色：

| 主题 | 桌宠 | 素材 |
|---|---|---|
| `pure` | DS 鲸鱼娘 | `ui/pets/whale/`（deepseek-whale-pet，MIT） |
| `zafkiel` | 狂三（Q 版） | `ui/pets/kurumi/`（hatch-pet-kurumi，作者自产） |
| `kurkuriel` | 反转狂三（Q 版） | 同狂三图集 + CSS 反转滤镜（白化/降饱和/血红辉光） |

- 图集兼容 Codex 宠物 V1/V2 格式（8 列 192×208，自动探测每行非空帧）
- 交互：**拖动**移动 / **单击**跳跃+气泡 / **双击**挥手 / **右键**菜单（手动切换角色、隐藏）
- 位置与角色持久化到 `%APPDATA%\com.miasaki.desktop\pet.json`
- 悬浮主题条切换时，主窗口通过 `set_pet_mode` 命令联动宠物角色

## 目录

```
desktop/
├─ ui/loading.html           # 本地唤醒页（探活/拉起状态 + 重试）
├─ themes/                   # 主题源（原创设计）
│  ├─ pure.css / zafkiel.css / kurkuriel.css
│  └─ runtime.js             # 注入运行时：主题属性/明暗锁定/切换条/过渡/水印
├─ scripts/build-init.mjs    # 打包内联 + 令牌完备性强制校验
└─ src-tauri/
   ├─ src/main.rs            # 启动器：单实例/探活 3080/拉起 dsh web/导航
   ├─ injected/theme-init.js # 构建产物（include_str! 注入，勿手改）
   └─ capabilities/          # 最小权限（core:default）
```

## 设计规范

- 总体设计与三主题规范：`../design/themes.md`
- DSH 令牌面（构建校验依据）：`../design/token-surface.txt`

## 行为约定

- 关闭窗口 = 退出应用；**DSH 服务保持运行**（再次双击秒开）。
- DSH 启动日志：`%LOCALAPPDATA%\miasaki\server.log`。
- 主题为「明暗锁定」：刻刻帝强制暗色、狂狂帝强制亮色、原版跟随 DSH 自身设置。
- 二次启动由单实例锁接管，只唤起已有窗口。
