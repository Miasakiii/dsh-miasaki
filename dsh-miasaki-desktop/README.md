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

- 图集兼容 Codex 宠物 V1/V2 格式（8 列 192×208，自动探测每行非空帧）；kurumi 已切全 9 行语义帧
  （idle/runRight/runLeft/wave/jump/failed/wait/run/review），whale idle 为帧序列（idle.gif 拆分 6 帧）
- 交互：**拖动**移动 / **单击**跳跃+气泡（主窗口最小化/隐藏时单击为**唤起主窗口**）/ **双击**挥手
  （主窗口最小化/隐藏时双击为**唤起主窗口**）/ **右键**菜单（显示主窗口、隐藏桌宠、最小化主窗口、退出）
- 自主动作（环境编排）：静止时低频随机小动作（挥手/检查/等待，偶发跳跃——表演 1.2~2.2s、休息 8~18s、
  首次 5.5s 延迟；指针按下即打断）；思考强度上升时转「守候」姿态（wait 行慢放，不再原地跑步）
- 位置与角色持久化到 `%APPDATA%\com.miasaki.desktop\pet.json`
- **人格会话联动**：主题切换时自动用对应桌宠的 Agent 预设开启新会话（DSH 官方 RPC
  `/api/session.create` 的 `agentPreset` 参数）。映射 `pure→whale`（鲸鱼娘）/
  `zafkiel→kurumi`（狂三）/`kurkuriel→inverse`（反转狂三）；每个主题仅自动创建一次，
  结果记于 localStorage（`miasaki.petSessions`），切换回来时只提示「已建立」；
  新会话优先挂到当前 workspace；RPC 不可用或预设缺失时静默降级，不影响主题切换。
  三个预设定义在 `%USERPROFILE%\.dsh\.agent-presets\{whale,kurumi,inverse}\`
  （standard 底座 + 桌宠中文人设，persona 含「入戏边界」：工具/错误/审批一律标准语气）。
  维护材料在 `preset-sources/`（`*.persona.txt` / `*.preset.yml` / `apply-presets.ps1`，
  改人设后重跑脚本再生成 `%USERPROFILE%\.dsh\.agent-presets\` 下对应文件）。
- 悬浮主题条切换时，主窗口通过 `set_pet_mode` 命令联动宠物角色
- **主窗口拖动**：标题栏走 Tauri 原生 `data-tauri-drag-region`（OS 级 start_dragging，系统消息
  循环接管，完全跟手；双击标题栏 = 最大化/还原）。早期版本用 URL hash 轮询 + set_position
  差值应用（33ms 滞后、DPI 换算误差、事件流竞态 → 不跟手/跳变），已废弃。
  注意：远程页面（http://127.0.0.1:3080）的子 capability `remote-dsh.json` 必须授予
  `core:window:allow-start-dragging`，否则拖动手势会被插件 ACL 拒绝且无任何提示。
- 气泡台词为**构建期预渲染**的位图帧（`ui/pets/bubbles.png`，17 帧），运行时零 GDI 字体调用：
  Windows 11 的 GDI 字体在多线程（WebView2 + 桌宠线程）并发使用时存在已知堆损坏，`CreateFontW`
  会确定性崩溃（gdi32full!CreateFontW+0xA3 / 0xC0000005）。**修改台词池（`src/pet_native.rs`
  的 `quote_pool`）后必须重新生成**：`powershell -File scripts/gen-bubbles.ps1`（无 PowerShell 5
  时用 `pwsh`）

## 目录

```
desktop/
├─ ui/loading.html           # 本地唤醒页（探活/拉起状态 + 重试）
├─ themes/                   # 主题源（原创设计）
│  ├─ pure.css / zafkiel.css / kurkuriel.css
│  └─ runtime.js             # 注入运行时：主题属性/明暗锁定/切换条/过渡/水印/标题栏（几何同步+主题装饰）
├─ scripts/build-init.mjs    # 打包内联 + 令牌完备性强制校验
├─ scripts/gen-bubbles.ps1   # 气泡台词位图精灵表（预渲染，规避 GDI 字体崩溃）
└─ src-tauri/
   ├─ src/main.rs            # 启动器：单实例/探活 3080/拉起 dsh web/导航
   ├─ injected/theme-init.js # 构建产物（include_str! 注入，勿手改）
   └─ capabilities/          # 最小权限（core:default）
```

## 设计规范

- 总体设计与三主题规范：`design/themes.md`
- DSH 令牌面（构建校验依据）：`design/token-surface.txt`

## 行为约定

- 关闭窗口 = 退出应用；**DSH 服务保持运行**（再次双击秒开）。
- DSH 启动日志：`%LOCALAPPDATA%\miasaki\server.log`。
- 主题为「明暗锁定」：刻刻帝强制暗色、狂狂帝强制亮色、原版跟随 DSH 自身设置。
- 二次启动由单实例锁接管，只唤起已有窗口。
