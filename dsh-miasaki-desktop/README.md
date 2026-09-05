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

切换：右下角悬浮按钮 → 悬停展开三主题；每个主题悬浮显示各自的介绍文案（不再全部是当前主题的提示），
选择持久化于 localStorage，重启保持。

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
- **工作动态 + 权限申请提示**（v2026-08-30）：桌宠反映**总指挥（主会话）** 的活动状态——
  注入层 `themes/runtime.js` 周期扫描 DSH 页面 DOM（"停止生成"按钮 → busy；
  dialog/modal 内同时存在"允许"+"拒绝"类按钮 → 等待审批），经 URL hash `act=` / `wait=`
  字段回传，Rust `compose` 按 **waiting > busy > intensity** 优先级映射立绘/姿态：
  waiting 强制 kurumi `wait` 行 / whale·inverse `work` 立绘 + **常驻"等待审批"气泡**；
  waiting 中**单击桌宠 = 唤起主窗口**（跳过 hop 动画）。选择器集中在 `runtime.js` 顶部
   常量区，校准方式：console 跑 `__miasakiProbe()` 看候选按钮文本。agent 员工状态
   后续归 `dsh-miasaki-fleet/fleet-monitor/` 工作面板，不进桌宠。
- **Fleet 指示器（v2026-09-04，可选联动）**：设环境变量 `MIASAKI_FLEET_PULSE`
  指向 `dsh-miasaki-fleet/state/fleet-pulse.json`（由 fleet 侧
  `node workers/pulse/publish-pulse.mjs` 发布，契约见
  `dsh-miasaki-shared-docs/cross/ab-linkage-pulse-v2-2026-09-04.md`），桌面端
  脉冲看门狗 2s 轮询，桌宠按 **fleet 告警(blocked/error，failed 行 + 常驻
  “需要你的批准”气泡）> DSH 等待审批 > fleet 运行中（work 立绘 + 常驻“忙碌中…”）
  > busy > intensity** 映射；未设变量时联动静默关闭。
- 位置与角色持久化到 `%APPDATA%\com.miasaki.desktop\pet.json`（v1：位置 + 隐藏状态，原子写；
  位置不在任何可见显示器工作区时自动回默认 (1200,500)，修复拔掉副屏/分辨率变化后的「桌宠丢了」）
- **设置入口**：DSH「设置 → 桌宠」面板（`plugins/dsh-pet-panel/`）提供：
  显示/隐藏开关、位置重置（屏幕外找回）、状态回显（面板挂载时经
  `cmd=pet-state` 请求，桌面端 eval `miasaki-pet-state` 事件回推）。
  命令走主窗口 URL hash 通道（`cmd=pet-show/pet-hide/pet-reset`），与主题联动同链路；
  非桌面端（普通浏览器打开 DSH）面板显示降级提示。
- **人格会话联动**：主题切换时自动用对应桌宠的 Agent 预设开启新会话。注入层切换
  主题时派发 `miasaki-persona-request` CustomEvent，由 `dsh-pet-panel` 插件客户端
  经官方 `ctx.remote.session.create`（0.1.2-rc.1 的 WebSocket mux 通道，2026-09-06
  从注入层 fetch 迁移）创建：映射 `pure→whale`（鲸鱼娘）/`zafkiel→kurumi`（狂三）/
  `kurkuriel→inverse`（反转狂三）；每个主题仅自动创建一次，结果记于 localStorage
  （`miasaki.petSessions`），切换回来时只提示「已建立」；新会话优先挂到当前
  workspace；RPC 不可用或预设缺失时静默降级，不影响主题切换。
  三个预设定义在 `%USERPROFILE%\.dsh\.agent-presets\{whale,kurumi,inverse}\`
  （standard 底座 + 桌宠中文人设，persona 含「入戏边界」：工具/错误/审批一律标准语气）。
  维护材料在 `preset-sources/`（`*.persona.txt` / `*.preset.yml` / `apply-presets.ps1`，
  改人设后重跑脚本再生成 `%USERPROFILE%\.dsh\.agent-presets\` 下对应文件）。
- 悬浮主题条切换时，主窗口通过 `set_pet_mode` 命令联动宠物角色
- **主窗口拖动（V3 空白拖动）**：窗口零占位叠加后没有自绘拖动条——注入运行时在
  document 级捕获 mousedown：落在顶部 36px 内且事件路径上无「可交互元素」（复用
  Tauri 内置 drag-region 判定口径：可点击标签/contenteditable/tabindex/交互 role）
  时调 Tauri 原生 `start_dragging`（OS 级，完全跟手），双击 = 最大化/还原；
  页面按钮/页签/输入框照常点击不受影响。远程页面（http://127.0.0.1:3080）的子
  capability `remote-dsh.json` 必须授予 `core:window:allow-start-dragging`（已授），
  否则拖动手势会被插件 ACL 拒绝且无任何提示。
- **窗口控制按钮**：右上角悬浮胶囊内最小化/最大化/关闭为统一内联 SVG 线图标（10×10 视口、
  `stroke-width 1`、`currentColor` 描边、圆头端帽 Fluent 风格，三按钮视觉重量一致），
  最大化后按钮自动切换为「还原」错位双框图标——远程页无 IPC 权限，状态由 Rust 侧
  `on_window_event`（Resized，150ms 防抖）经 eval 派发 `miasaki-max-state` CustomEvent
  驱动，页面加载后延迟补推、页面经 hash `cmd=want-max` 可请求重推；双击顶部空白 /
  Win+↑ 等系统路径同样同步；非 Tauri 环境（浏览器调试预览）点击时本地翻转兜底。
- **标题栏 × 主界面一体化（v3 · 零占位叠加）**：系统标题栏移除（`decorations(false)`）
  后，桌面壳对 DSH 页面**零布局侵入**——无 32px 顶带、无下推、无卡片，页面从 y=0
  起渲染，顶部控件（会话头「对话/轨迹/用量」页签、Session 日志等）位置与 web 端
  完全一致；窗控收进右上角**悬浮胶囊**（主题徽章 + 三键，半透明 + 毛玻璃，悬停
  实色，胶囊外 pointer-events:none）；唯一页面级调整 = `#root header:has([role="tablist"])`
  右侧 padding 132px 给胶囊让位（初版 104px 真机叠压后加宽；DSH 升级时随
  verify-themes 复核选择器）。底座仍为
  **Win11 Mica**（DWM 直调 `DWMWA_SYSTEMBACKDROP_TYPE`，窗口底透明），`.shadow(true)`
  恢复圆角/阴影/描边；Mica 不可用（Win10）时回退主题实色底，pure 保持原版实色。
- 气泡台词为**构建期预渲染**的位图帧（`ui/pets/bubbles.png`，20 帧：17 台词 + 3 状态帧
  「忙碌中…/等待审批/需要你的批准」），运行时零 GDI 字体调用：
  Windows 11 的 GDI 字体在多线程（WebView2 + 桌宠线程）并发使用时存在已知堆损坏，`CreateFontW`
  会确定性崩溃（gdi32full!CreateFontW+0xA3 / 0xC0000005）。**修改台词池（`src/pet_native.rs`
  的 `quote_pool`）后必须重新生成**：`powershell -File scripts/gen-bubbles.ps1`（无 PowerShell 5
  时用 `pwsh`）

## 目录

```
desktop/
├─ ui/loading.html           # 本地唤醒页（探活/拉起状态 + 重试 + 随主题换肤/统一标题栏）
├─ themes/                   # 主题源（原创设计）
│  ├─ pure.css / zafkiel.css / kurkuriel.css
│  ├─ src/                   # 注入运行时分片（9 片，按 MANIFEST.json 拼接；改这里）
│  │                         #   （00-boot.js 含 DSH 鉴权 cookie 注入：dsh web 重启后
│  │                         #    旧 cookie 失效黑屏时自动重签并重载，见 CHANGELOG 2026-09-05）
│  └─ runtime.js             # legacy 回退源（build-init 缺 src/ 时使用）
├─ plugins/dsh-free-model-pool/  # DSH web profile bundle：免费模型池插件（见下）
├─ plugins/dsh-pet-panel/        # DSH web profile bundle：桌宠设置面板（设置 → 桌宠）
├─ plugins/dsh-token-monitor/    # DSH web profile bundle：会话视图「用量」Tab（总览五卡 + 年热力图 + 每日趋势/模型用量占比 + 上下文 hero + 今日限额 + 模型明细）
├─ scripts/build-init.mjs    # 打包内联 + 令牌完备性强制校验
├─ scripts/diff-tokens.mjs   # 令牌漂移报告（`npm run tokens:diff`，只告警不阻塞）
├─ scripts/smoke-test.ps1    # 冒烟测试（§0b 启动失败三用例预检：dsh 未安装/端口占用/单实例）
├─ scripts/make-icons.mjs    # 主题徽章 + 应用图标生成（app 图标为圆角 24% 边长，重生成后跑 `npx tauri icon src-tauri/app-icon-source.png`）
├─ scripts/gen-bubbles.ps1   # 气泡台词位图精灵表（预渲染，规避 GDI 字体崩溃）
└─ src-tauri/
   ├─ src/main.rs            # 启动器：单实例/探活 3080/拉起 dsh web/导航 + fleet 脉冲看门狗（环境变量 MIASAKI_FLEET_PULSE）
   ├─ src/pet_native.rs      # 桌宠 facade（共享类型 + NativePet API；实现见 pet_native/ 子模块）
   ├─ injected/theme-init.js # 构建产物（include_str! 注入，勿手改）
   └─ capabilities/          # 最小权限（core:default）
```

## DSH 插件：免费模型池（`plugins/dsh-free-model-pool/`）

> **官方 dsh 0.1.2-rc.1 适配（2026-09-05）**：三个插件与 `@miasaki/dsh-canvas` 已核对
> 并跟进官方 0.1.2 插件 API（peerDeps 对齐 `^0.1.2-rc.1`，canvas 清理已消失的
> `dsh-client-runtime` 依赖声明）。注意 0.1.2 的 `llm-pi-ai` 配置校验收紧：
> `settings.yaml` 里模型 id 不在官方 catalog 的平台必须显式声明 `api` 与 `baseURL`
> 才能整节通过校验（否则整节失效、免费模型池平台列表为空）。适配细节与排查记录见
> `design/CHANGELOG.md`。

检出免费模型并给出能力画像与适用性决策，Web 面板挂在 DSH「设置 → 免费模型池」：

- **多平台扫描**：扫描 `llm-pi-ai.providers` 中**带 baseURL 的全部 OpenAI 兼容平台**（OpenRouter、
  自建网关、微信 chatapi 等），一个面板统一管理；新增平台只需在设置 → 模型页配置，
  面板自动出现，零插件改动。
- **免费判定（分层）**：`:free` 后缀 → 定价字段全零 → 名称含「免费/free」；三者任一命中即收录，
  每个模型标注命中依据与警告（预览模型随时下线、缺 tool_choice 需实测等）。
- **能力画像**：从端点自述（`supported_parameters` / `architecture.modality` / `reasoning` /
  上下文 / 输出上限）判定 工具调用、tool_choice、推理、编码、视觉、结构化输出、超长上下文、
  子代理可用性（门槛 = tools + tool_choice），产出「子代理可用 / 仅问答、批处理、需实测」三档 verdict。
- **决策摘要**：面板顶部给出 最佳子代理 / 编码类 / 超长上下文 / 多模态 四个快捷决策，
  子代理后端切换按钮直接使用最佳推荐。
- **写入配置**：`ctx.settings.update('llm-pi-ai', …)` 深合并写入目标平台 `models`
  （保留其他 provider 与字段），DSH 设置系统校验 schema；`/freepool-api/subagent` 重写三预设
  `tool-subagent` / `tool-subagent-fork` 的 `agentOptions`（provider 必须是已登记路由键）。

安装（host 重启后生效）：`plugins/dsh-free-model-pool` 为 `file:` 依赖，被
`%USERPROFILE%\.dsh\profiles\web\package.json` 的 `dsh.profile.bundles` 引用；修改源码后需在
profile 目录 `pnpm install` 并把 `lib/*` 同步到 `node_modules`（pnpm file: store 缓存会滞后，
务必核对文件哈希）。client bundle 为手写 `window.__ModuleLoader__.load` 格式（本机无 tsdown），
勿用 JSX；面板经同源 `/freepool-api/*` JSON 路由与 host 通信（client bundle 无 `host.call`）。

## DSH 插件：桌宠设置面板（`plugins/dsh-pet-panel/`）

桌宠的配置入口，挂在 DSH「设置 → 桌宠」（`settings.section`，order 26）：

- **显示 / 隐藏开关**：桌面端原生分层窗口的显隐控制，状态持久化（pet.json `hide`），
  重启保持；隐藏后右下角圆点可点击恢复。
- **位置重置**：一键回到默认位置 (1200, 500) —— 桌宠被拖丢到屏幕外 / 拔掉副屏后找回。
- **状态回显**：面板挂载时发 `cmd=pet-state`，桌面端 eval `miasaki-pet-state`
  CustomEvent 回推当前 `hidden`，与显示/隐藏联动保持同步。
- **通信（零 host 职责）**：面板命令经主窗口 URL hash 通道
  （`#…&cmd=pet-show|pet-hide|pet-reset|pet-state&seq=…`，`history.replaceState`
  不触发刷新），由桌面端 hash watchdog 33ms 轮询执行；host 侧 `lib/index.js` 为空壳。
- **降级**：非桌面端（普通浏览器打开 DSH，无 `window.__MIASAKI_BOOTED__`）面板提示
  命令不会生效，不阻断设置页。

安装：同免费模型池 —— profile `package.json` 的 `dependencies` + `dsh.profile.bundles`
加 `dsh-pet-panel`（file: 依赖），profile 目录 `pnpm install` 后核对
`node_modules/dsh-pet-panel/lib/*` 与源码哈希一致；host 重启后生效。

## 设计规范

- 总体设计与三主题规范：`design/themes.md`
- DSH 令牌面（构建校验依据）：`design/token-surface.txt`
- 启动可靠性（失败恢复页/健康标记）：`design/bootstrap-reliability.md`

## 行为约定

- 关闭窗口 → 弹窗确认（标题栏 X / Alt+F4 / 托盘「退出」/ 桌宠「退出应用」统一入口，弹窗为三主题自绘）；
  选择「关闭应用」会**同步停止由桌面端拉起的 DSH 服务**（下次双击自动重新拉起）；「取消」仅收起弹窗。
  用户**手动启动**、或端口已就绪时接入的 DSH 服务不会被停止（非本应用 spawn 的后端不触碰）。
  重复触发关闭请求仅重新显示确认弹窗；仅 Alt+F4 连击（前端无响应）时兜底强制退出、后端保持运行。
- **启动画面与 DSH 页画面统一**：loading 页与 DSH 页共用同一主题标题栏（本地页不出现主题切换条/水印），
  配色与纹章随上次选择主题（pure/zafkiel/kurkuriel）；主题偏好由 DSH 页同步持久化
  `%APPDATA%\com.miasaki.desktop\prefs.json`，下次启动注入启动画面。
- DSH 启动日志：`%LOCALAPPDATA%\miasaki\server.log`。
- 主题为「明暗锁定」：刻刻帝强制暗色、狂狂帝强制亮色、原版跟随 DSH 自身设置。
- 二次启动由单实例锁接管，只唤起已有窗口。

## 启动故障恢复

启动失败（dsh 未安装 / 端口被占用 / DSH 拉起异常）时，加载页会显示恢复动作组：

- **检查 dsh** — `where dsh` + `dsh --version` 探测结果；
- **打开终端** — 独立 cmd 窗口（可手动运行 `dsh web --no-open` / `netstat` 排查）；
- **打开日志目录** — `%LOCALAPPDATA%\miasaki\`（server.log / pet.log / bootstrap.json）；
- **导出诊断** — 聚合日志尾部与状态文件到 `%APPDATA%\com.miasaki.desktop\diagnostics-<ts>.txt`。

每次启动的进度落盘于 `%LOCALAPPDATA%\miasaki\bootstrap.json`（启动尝试阶段/失败原因/上次成功时间），
下次启动若上次失败会提前提示。设计：`design/bootstrap-reliability.md`（借鉴
deepseek-harness-desktop 启动恢复 + 健康标记 + 可靠性矩阵思路）。
