# Miasaki Desktop

> Miasaki 专属 DSH 桌面端 — Tauri 2 薄壳 + 三主题（原版简约纯净 / 刻刻帝 / 狂狂帝）

双击 EXE → 自动拉起 `dsh web`（如未运行）→ 打开 DSH Web GUI，并注入三套原创主题皮肤与悬浮切换条。**不修改 DSH 本体**：主题以令牌层覆盖（`--dsw-static-*` 色阶）实现，DSH 升级不受影响。

## 快速开始

```bash
npm install                 # 安装 @tauri-apps/cli（本线以 npm 为准，见下方「包管理准则」）
npm run gen-init            # 内联主题 → src-tauri/injected/theme-init.js（含令牌完备性校验）
npm run tauri dev           # 开发运行
npm run tauri build         # 产出 Windows 安装包/EXE（src-tauri/target/release/）
```

> **包管理准则（2026-09-12 决议）**：本线自身依赖统一走 **npm**，`package-lock.json` 是**唯一锁文件**；
> `pnpm-lock.yaml` 已删除并在根 `.gitignore` 挡回。**成因**：历史上两套锁文件各自漂移——pnpm 侧早已解析到
> sharp 0.35.4，npm 侧仍锁 0.35.3，而 dependabot 只读 npm 侧，于是高危漏洞告警长期挂着。
> **注意区分**：文中多处提到的「profile 目录 `pnpm install`」指的是 **DSH profile 宿主侧**的
> `file:` 插件依赖安装（那是宿主生态的既定方式），与本线自身依赖无关，不受此决议影响。

静态回归（令牌完备性 + 令牌漂移 + 运行时补丁自证）已并入仓库级统一入口：

```bash
node ../scripts/verify-all.mjs desktop   # gen-init + tokens:diff + patch verify + cargo test
```

`npm run verify`（`scripts/verify-themes.mjs`）**不在该脚本内**——它需要附着运行中的
CDP target，属实机项；无 host 时会以 `CDP target not found` 失败。实机冒烟清单
（启动恢复 / 窗口 / 桌宠 / pulse 联动）见
[七线统一回归矩阵](../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md) §3–§4。

> **沙箱注意**：无头 Edge 需要创建命名管道，在受限文件沙箱（`workspace-write`）下必然
> 以 `CDP target not found` 失败——用 `danger-full-access` 重跑**同一条命令**即可
> （2026-09-10 实测跑通；断言含第 6 节「右上角安全区」：窗控裸键组与官方右栏两处控件的
> 矩形交叠必须为 0，且垂直中心差 ≤ 2px）。

## DSH 运行时补丁（本体例外）

`patches/` 存放**五处**「修改 DSH 本体」的补丁——都改写已安装包的编译产物，
**DSH 升级会被覆盖、需重新应用**；补丁规则与基线文件均已入库，可重建/可校验/可回退。

| 补丁 | 目标包 | 做什么 |
|---|---|---|
| [`dsh-client-ui-settings-models`](patches/dsh-client-ui-settings-models/README.md) | 官方设置页 | 逐模型「思考强度」下拉 + 「测试连通性」按钮 |
| [`dsh-client-ui-conversation`](patches/dsh-client-ui-conversation/README.md) | 官方会话头 | 窄宽度溢出保护：`headerActions` 改可收缩 + 横向可滚，消除右栏展开时的控件压叠 |
| [`dsh-client-ui-trajectory`](patches/dsh-client-ui-trajectory/README.md) | 官方轨迹页 | 首 token 计时可恢复：实时 chunk 缺位时从 `assistant/message` 紧凑流恢复，修掉「首 token 时间不可用」 |
| [`dsh-client-ui-chat`](patches/dsh-client-ui-chat/README.md) | 官方聊天区 | 同上，作用于消息气泡的「首 token 用时（TTFT）」与窗口口径兜底统计 |
| [`dsh-cordis-host-runner`](patches/dsh-cordis-host-runner/README.md) | 官方 host 侧 Cordis runner | `cordis_inspect_query`(client) 永久挂起修复：记下页面的拒绝原因 + 15s 兜底超时，把「无限挂起」变成「带原因的报错」 |

> 前四个作用于浏览器 bundle，改完**刷新页面**即生效；第五个作用于 **host 侧 Node 包**
> （`lib/index.js`），改完必须**重启 DSH host 进程**才生效（Node 已加载的模块不会热更新）。

```powershell
cd patches/<补丁目录>
node patch.mjs verify       # 离线自证（已并入 verify-all）
node patch.mjs status       # 检查安装目录状态
node patch.mjs apply        # 备份 + 应用（幂等）
node patch.mjs revert       # 还原
node rebuild-baseline.mjs   # 升级后：用新的官方原版重建 baseline
```

> **当前基线：DSH 0.1.5-rc.1**。settings-models 于 2026-09-10 重打（原版 `A60FD863…` →
> 补丁版 `E602C1F1…`；0.1.2 的 7 个锚点在新版中全部唯一命中，未改动任何 `EDITS`）；
> conversation 于 2026-09-10 新建（原版 `81314DFD…` → 产物 `D9A841DE…`，1 条锚点唯一命中）；
> trajectory / chat 两个计时补丁同日新建（`73A878B4…` → `C3485ADF…`、`4F9CFFF8…` → `BE4C68D5…`，
> 各 2 条锚点唯一命中）。**两个计时补丁要一起重打**才完整（同一个 `firstTokenTime` 的两处显示）。
> cordis-host-runner 同日新建（原版 `58EF79A0…` → 产物 `8B81500A…`，4 条锚点唯一命中）——
> 它是本目录里**唯一作用于 host 侧 Node 包**的补丁（其余四个都是浏览器 bundle）。
> 下次升级的流程（五个补丁**各自独立**）：`status` 报 `unknown` → `rebuild-baseline.mjs` 重建 →
> 按它打印的值更新 `patch.mjs` 的常量 → `verify` → `apply`。

详见五个补丁各自的 README，以及
[模型设置工具包设计](../dsh-miasaki-shared-docs/cross/model-settings-toolkit-design-2026-09-07.md)、
[会话头部挤压修复设计](../dsh-miasaki-canvas/design/2026-09-10-conversation-header-crowding-fix.md)
与[首 token 计时恢复设计](design/trajectory-ttft-restore.md)。
除这五个补丁外，本线对 DSH 的一切改动都在令牌层，DSH 升级不受影响。

## 三个主题

| 主题 | 概念 | 说明 |
|---|---|---|
| `pure` | 原版简约纯净 | 零覆盖，DSH 原生样貌透传（兜底主题） |
| `zafkiel` | 刻刻帝 · 永夜钟阁 | 暗夜基底 · 绯红交互 · 鎏金装饰 · 表盘水印 · 金色光标 |
| `kurkuriel` | 狂狂帝 · 白夜逆钟 | 骨白基底 · 血绯交互 · 枪铁装饰 · 破裂表盘 · 星座母题 |

切换：右下角悬浮按钮 → 悬停展开三主题；每个主题悬浮显示各自的介绍文案（不再全部是当前主题的提示），
选择持久化于 localStorage，重启保持。

## 软件头像（启动器图标）

**在 DSH 页面的「设置 → 外观 → 软件头像」里换掉本应用在任务栏 / 窗口 / 托盘上的图标**，
无需重建 EXE（2026-09-21 落地，appearance 线跨线消费端）。

| 项 | 说明 |
|---|---|
| 入口 | DSH 页面 设置 → **外观** → 「软件头像」→ 上传图片 / 从清单里选 / 清除（appearance 线提供） |
| 存储 | 图片归一化成 **PNG** 落在 `~/.dsh/miasaki-appearance/avatars/`，配置记在 `~/.dsh/miasaki-appearance/config.json` 的 `avatar.source` |
| 生效面 | 主窗口图标（**任务栏**随之）+ **托盘**图标；改完 1.5s 巡检内跟随 |
| 实现 | `src-tauri/src/launcher_icon.rs` —— 读配置 → PNG 解码（`png` crate，零新依赖）→ 中心裁方 + 盒式降采样（≤256px）→ `window.set_icon` + `tray.set_icon` |
| 失败姿态 | 配置损坏 / 文件缺失 / 解码失败 → 一行日志 + 回退出厂图标，不阻断启动 |
| **不含** | EXE 内嵌图标、桌面 / 开始菜单快捷方式的静态图标（构建期资源，只有重跑 `make-icons.mjs` + `npx tauri icon` 才能改）、页面 favicon |

契约（配置路径 / 文件名白名单 / 目录）见
[`../dsh-miasaki-shared-docs/cross/appearance-launcher-icon-2026-09-21.md`](../dsh-miasaki-shared-docs/cross/appearance-launcher-icon-2026-09-21.md)；
改契约必须同时改 appearance 线的 `lib/avatar.js`（两侧各有单测钉同一组样本）。

## Q 版桌宠（Codex 风格）

透明置顶小窗桌宠，随主题自动换角色：

| 主题 | 桌宠 | 素材 |
|---|---|---|
| `pure` | DS 鲸鱼娘 | `ui/pets/whale/`（deepseek-whale-pet，MIT） |
| `zafkiel` | 狂三（Q 版） | `ui/pets/kurumi/`（hatch-pet-kurumi，作者自产） |
| `kurkuriel` | 反转狂三（Q 版） | 同狂三图集 + CSS 反转滤镜（白化/降饱和/血红辉光） |

- 图集兼容 Codex 宠物 V1/V2 格式（8 列 192×208，自动探测每行非空帧）；kurumi 已切全 9 行语义帧
  （idle/runRight/runLeft/wave/jump/failed/wait/run/review），whale idle 为帧序列（idle.gif 拆分 6 帧）
- 交互（v3 M1，2026-09-12 重排；**R1/R2 于 2026-09-16 补窗口层**）：**拖动**移动 / **单击**「撸一下」
  跳跃+气泡（**不抢焦点**——窗口已带 `WS_EX_NOACTIVATE`，点击不会夺走前台与键盘焦点，
  在被遮挡的应用里 Ctrl+C/V 照常可用；等待审批或主窗口最小化/隐藏时单击为**唤起主窗口**）/
  **双击**挥手（250ms 去抖与单击区分；等待审批或主窗口最小化/隐藏时双击为**唤起主窗口**）/
  **右键**菜单（显示主窗口、隐藏桌宠、最小化主窗口、退出）
- **透明区域鼠标穿透**（R2，2026-09-16）：角色轮廓以外的透明像素不再拦截鼠标——10ms 轮询光标位置，
  查**当前合成缓冲**的 alpha（阈值 16，与显示逐像素一致），命中透明像素即置位 `WS_EX_TRANSPARENT`
  把点击交给下层窗口，光标回到角色本体立即恢复可点；隐藏 / 拖拽中恒不穿透（保证跟手）。
  只改扩展样式位、不重建窗口（无闪烁）；切换日志按 500 次节流
- **桌宠内联审批（R5 / M3.2，2026-09-16）**：审批等待时气泡升级为**含「拒绝 / 允许一次」两个按钮**
  的交互气泡（`ui/pets/approval.png`，240×84，构建期 `gen-bubbles.ps1` 出图、运行时零字体调用；
  两按钮间留 8px 间隙防误触）。点按钮 → 桌面端记单调 `seq` 并经 `eval` 派发
  `miasaki-approval-decision` → `dsh-pet-panel` 调用官方 `PendingApproval.answer('allowed-once'|'rejected')`。
  **红线**：只在用户显式点击时决策、只发这两个枚举、不做「全部允许 / 记住选择」；
  点完**先本地收起**，若 3s 内该审批仍在（未生效）则回显「需要你的批准」提示去 DSH 界面处理，
  **绝不假装成功**。拿不到官方 `key` 的审批不挂可交互气泡（身份门禁）
- 自主动作（环境编排）：静止且空闲时低频随机小动作（挥手/检查/等待，偶发跳跃——表演 1.2~2.2s、
  休息 8~18s、首次 5.5s 延迟；指针按下即打断）；等待审批 / fleet 指示 / busy 工作态期间
  散步与小动作**停触发**（工作姿态可读，不被环境动作打断）
- **工作动态 + 权限申请提示**（v3 M2 2026-09-12 重做；**R0 2026-09-16 改为跨会话聚合**）：
  桌宠反映六态 `idle / thinking / waiting / error / done / fleet-blocked`——**主信号 = DSH 官方契约**：
  `dsh-pet-panel` 插件读官方 `ctx.sessions`（**跨会话聚合**：任一非子代理会话 `running` = 忙，
  修掉「先完成的会话把仍在干活的顶成 idle」）+ `ctx.uiSession.pendingInteractions`
  （**遍历全部会话**找审批——切走会话后仍能看到后台会话的待审批，这是「快捷提权」的价值前提；
  随态带出工具名 + `sessionId` + 原因（截断 160 字符）+ **官方 `key`**（经 hash `petkey=` 上报，
  用于内联审批的幂等身份），并落地**身份门禁**：拿不到稳定身份的审批一律不显示，
  宁可不报也不挂一个永远等不到 resolved 的常驻态），
  1.5s 心跳写 `window.__miasakiPetPanel`，由注入运行时 `syncHash`
  合并进 URL hash `pet=/pettool=/petts=`（单写者定律不变）。Rust `compose` 合成六态并按
  **Waiting(审批) > FleetBlocked(告警) > Error > Done > Thinking(静默守候) > Idle** 优先级
  映射立绘/气泡（`pick_state_row` 单测钉死）：waiting 强制 kurumi `wait` 行 /
  whale·inverse `work` 立绘 + **常驻"等待审批"气泡**；done 播 review 庆祝一次（气泡 10s）；
  error/告警播 `failed` 行；waiting 中**单击/双击桌宠 = 唤起主窗口**。**DOM 扫描仅为兜底**：
  官方通道 5s 无心跳（非桌面端 / 插件缺失 / 崩溃）才启用 `act=/wait=` 扫描（选择器
  `themes/src/05-sensors.js` 顶部常量区，校准 `__miasakiProbe()`）。agent 员工状态
  后续归 `dsh-miasaki-fleet/fleet-monitor/` 工作面板，不进桌宠。
- **Fleet 指示器（v2026-09-04，可选联动）**：设环境变量 `MIASAKI_FLEET_PULSE`
  指向 `dsh-miasaki-fleet/state/fleet-pulse.json`（由 fleet 侧
  `node workers/pulse/publish-pulse.mjs` 发布，契约见
  `dsh-miasaki-shared-docs/cross/ab-linkage-pulse-v2-2026-09-04.md`），桌面端
  脉冲看门狗 2s 轮询，桌宠按 **fleet 告警(blocked/error，failed 行 + 常驻
  “需要你的批准”气泡）> DSH 等待审批 > fleet 运行中（work 立绘 + 常驻“忙碌中…”）
  > busy > intensity** 映射；未设变量时联动静默关闭。
- 位置与角色持久化到 `%APPDATA%\com.miasaki.desktop\pet.json`（**v2，2026-09-16**：
  「**角色可见区域**中心」相对所在显示器工作区的比例 `rx/ry` + 工作区几何（作为屏幕身份）
  + 绝对坐标兜底 + 隐藏状态，原子写；**v1 文件自动读取并在下次保存时升级**）。
  恢复顺序：工作区几何完全一致 → 按比例还原并 clamp 回工作区（**分辨率/缩放变化后位置仍成立**）；
  几何已变 → 绝对坐标 + 可见性校验；都不可见 → 回默认 (1200,500)（保留隐藏设置）。
  可见性判据为「**角色可见区域 ∩ 工作区的面积占比 ≥ 25%**」——半出屏/贴边保留，完全出屏才回默认；
  旧的「窗口中心点」判据已废弃，它是 M4.1（peek 缩边）的必然坑：peek 时窗口中心在屏外，
  会被误判「不可见」而把桌宠拉回默认位置（即「桌宠丢了」回归）
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
  **用户侧是生成产物，不要手改**；维护材料全部在 `preset-sources/`：
  `agent.base.cordis.yml`（DSH 0.1.5 `standard` 底座全文 + 本仓库自定义，persona 行为
  `__PERSONA__` 占位符）、`*.persona.txt` / `*.preset.yml`（人设与预设元数据）、
  `apply-presets.ps1`（读模板整体生成，覆盖前留 `.bak`）、`verify-presets.cjs`
  （校验产物字段与自定义项，自带 `!!js` 标签 schema）。改人设或换底座后重跑脚本并复验。
  注：DSH 0.1.5 起 persona 拆为 `prefix`（必填）+ `suffix`（缺省即遮蔽部署级后缀），
  旧 `text` 字段已不存在。
- 悬浮主题条切换时，主窗口通过 `set_pet_mode` 命令联动宠物角色
- **主窗口拖动（V3 空白拖动）**：窗口零占位叠加后没有自绘拖动条——注入运行时在
  document 级捕获 mousedown：落在顶部 36px 内且事件路径上无「可交互元素」（复用
  Tauri 内置 drag-region 判定口径：可点击标签/contenteditable/tabindex/交互 role）
  时调 Tauri 原生 `start_dragging`（OS 级，完全跟手），双击 = 最大化/还原；
  页面按钮/页签/输入框照常点击不受影响。远程页面（http://127.0.0.1:3080）的子
  capability `remote-dsh.json` 必须授予 `core:window:allow-start-dragging`（已授），
  否则拖动手势会被插件 ACL 拒绝且无任何提示。
- **窗口控制按钮**：右上角**无壳裸键组**内最小化/最大化/关闭为统一内联 SVG 线图标（10×10 视口、
  `stroke-width 1`、`currentColor` 描边、圆头端帽 Fluent 风格，三按钮视觉重量一致；
  v4 起无底色/无边框/无毛玻璃，hover 底色只落单按钮——Win11 原生同款），
  最大化后按钮自动切换为「还原」错位双框图标——远程页无 IPC 权限，状态由 Rust 侧
  `on_window_event`（Resized，150ms 防抖）经 eval 派发 `miasaki-max-state` CustomEvent
  驱动，页面加载后延迟补推、页面经 hash `cmd=want-max` 可请求重推；双击顶部空白 /
  Win+↑ 等系统路径同样同步；非 Tauri 环境（浏览器调试预览）点击时本地翻转兜底。
- **标题栏 × 主界面一体化（v3 零占位叠加 → v4 去胶囊 · 无壳裸键）**：系统标题栏移除
  （`decorations(false)`）后，桌面壳对 DSH 页面**零布局侵入**——无 32px 顶带、无下推、
  无卡片，页面从 y=0 起渲染，顶部控件（会话头「对话/轨迹/用量」页签、Session 日志等）
  位置与 web 端完全一致；窗控三键以**无壳裸键**直接落在右上角（v3 的悬浮胶囊外壳已删：
  无底色/无边框/无毛玻璃/padding，观感接近标准无边框应用；主题徽章 16px 保留在按钮组
  左侧，为启动页唯一主题标识——用户拍板 2026-09-06），hover 底色只落在单按钮上
  （Win11 原生同款，关闭键 hover 红底）。**唯一页面级调整 = 右上角安全区让位**（2026-09-10
  晚重写）：裸键组实测宽 108px，加 `right:8px` 后恒占距窗口右缘 `[8,116]px`，故声明
  `--ms-titlebar-reserve:128px`（含 12px 呼吸位），再按**恒存锚点**让位 DSH 0.1.5 官方右栏的
  两处控件——折叠态的「打开右侧边栏」（`[data-conversation-header-corner]`，其官方
  `margin-right:-16px` 需归零）与展开态的面板 chrome 全屏/收起两键
  （`[data-dockkit-strip-chrome]`，只在分栏最右一格渲染）；裸键组 `top:11px` 使其中心与官方
  控件同落在 24px 水平线上。旧规则 `header:has([role="tablist"]){padding-right:118px}` 已废
  （依赖仅在多 view tab 时才渲染的 `role=tablist`，单 tab 会话下整条失效）。命令链/拖动/
  最大化同步与 v3 相同：hash `cmd=min/max/close`
  → Rust watchdog；双击顶部空白 / Win+↑ 等系统路径同样同步；裸键组仍在
  `#miasaki-titlebar` 内，拖动排除自动生效。底座仍为
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
├─ plugins/dsh-token-monitor/    # DSH web profile bundle：用量监控（会话「用量」Tab 纯会话视角 + 侧栏脚部「用量统计」入口 → 全局浮窗：总览六卡/年热力图/趋势/模型用量 + 会话活跃分布（标题折叠自会话日志／近 30 日逐日分布条／排序·搜索·条数控件）/今日限额，v0.5.0）
├─ plugins/dsh-session-log-move/ # DSH web profile bundle：会话日志下载入口迁移（主界面 → 轨迹页搜索栏左侧，见下）
├─ plugins/dsh-model-probe/      # DSH web profile bundle：模型连通性真实探测（host only，设置页「测试连通性」的 B 档能力，见下）
├─ scripts/build-init.mjs    # 打包内联 + 令牌完备性强制校验
├─ scripts/diff-tokens.mjs   # 令牌漂移报告（`npm run tokens:diff`，只告警不阻塞）
├─ scripts/smoke-test.ps1    # 冒烟测试（§0b 启动失败三用例预检：dsh 未安装/端口占用/单实例）
├─ scripts/make-icons.mjs    # 主题徽章 + 应用图标生成（app 图标为圆角 24% 边长，重生成后跑 `npx tauri icon src-tauri/app-icon-source.png`）
├─ scripts/gen-bubbles.ps1   # 气泡位图：台词精灵表 `bubbles.png` + 审批气泡 `approval.png`（预渲染，规避 GDI 字体崩溃）
└─ src-tauri/
   ├─ src/main.rs            # 启动器：单实例/探活 3080/拉起 dsh web/导航 + fleet 脉冲看门狗（环境变量 MIASAKI_FLEET_PULSE）
   ├─ src/launcher_icon.rs   # 软件头像 → 窗口/托盘图标（读 appearance 线配置，1.5s 巡检跟随）
   ├─ src/pet_native.rs      # 桌宠 facade（共享类型 + NativePet API；实现见 pet_native/ 子模块）
   ├─ injected/theme-init.js # 构建产物（include_str! 注入，勿手改）
   └─ capabilities/          # 最小权限（core:default）
```

## DSH 插件：免费模型池（`plugins/dsh-free-model-pool/`）

> **官方 dsh 0.1.2-rc.1 适配（2026-09-05）**：四个插件与 `@miasaki/dsh-canvas` 已核对
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
  不触发刷新），由桌面端 hash watchdog 轮询执行（**基准 150ms**；拖窗期间自动提速至 33ms
  保证跟手；单次取用 ≥250ms 或连续失败则退避至 1000ms —— 见 CHANGELOG 2026-09-10(深夜·续)）；
  host 侧 `lib/index.js` 为空壳。
- **降级**：非桌面端（普通浏览器打开 DSH，无 `window.__MIASAKI_BOOTED__`）面板提示
  命令不会生效，不阻断设置页。

安装：同免费模型池 —— profile `package.json` 的 `dependencies` + `dsh.profile.bundles`
加 `dsh-pet-panel`（file: 依赖），profile 目录 `pnpm install` 后核对
`node_modules/dsh-pet-panel/lib/*` 与源码哈希一致；host 重启后生效。

## DSH 插件：会话日志下载入口迁移（`plugins/dsh-session-log-move/`）

把「Session 日志」下载按钮从**主界面会话头部**迁移到**轨迹页工具栏搜索栏左侧**：

- **主界面隐藏**：`conversation.session.header.utilities` 同 id（`session-log-download`）
  替换为空条目（平台 slot 语义：同 id 复用即替换该 cell），官方「Session 日志」胶囊不渲染；
- **轨迹页注入**：`[role=toolbar]` 内搜索框容器左侧插入同功能按钮（toolbar 无官方 slot，
  DOM 注入 + MutationObserver + 500ms 重试兜底约 30s，重渲染冲掉自动补挂）；
- **下载链路**：复用官方 `sessionLogDownload` 服务（缺失降级 `<a download>` 触发
  `/api/session.export?sessionId=…&includeDescendants=true` 流式下载）；
- **反馈**：按钮内联文案（准备中 / 已开始下载 / 下载失败，重试）自动复位；
- 全部副作用挂 `ctx.effect` disposer，停用即完全复原。host 半空壳无职责。

先行动态插件验证（2026-09-07）通过后按此形态固化；设计见
`design/session-log-download-relocate.md`，安装同 token-monitor profile bundle。

## DSH 插件：模型连通性探测（`plugins/dsh-model-probe/`）

设置页「测试连通性」按钮的**真实可用性探测**（host only，无 client 半侧）。配套补丁
[`patches/dsh-client-ui-settings-models/`](patches/dsh-client-ui-settings-models/README.md)
负责按钮侧调用，本插件负责「问对的问题」。设计见 `design/model-probe-v2.md`。

**解决什么**：v1 的按钮复用官方目录探测（`GET {baseURL}/v1/models`），问的是
「网关能不能列出模型目录」，而按钮语义是「这个模型能不能用」。StepFun Step Plan
这类只兼容 `POST /v1/messages` 的订阅网关对 `/v1/models` 回 401 —— 于是**能正常对话的
模型被报成认证失败**。v2 改为发真实对话请求。

- **两段式，默认零消耗**：① 握手档发一个必然被参数校验拒绝的请求（空 `messages`），
  401/403 = key 坏（**到此结束，不产生任何生成**）；400 = 鉴权已通过。
  ② 仅在鉴权通过后才发 `max_tokens: 1` 的生成请求确认端到端可用。
- **结果六分类**：`ok`（附耗时）/ `unauthorized` / `model-missing` / `quota` /
  `rate-limited` / `timeout` / `unreachable` / `bad-request` / `server-error` /
  `unknown` / `unsupported` / `no-credential` / `no-endpoint` / `no-model`。
  host 只回稳定 `kind`，文案在客户端本地化（中英各一份）。
- **协议覆盖**：`anthropic-messages`（`POST {root}/v1/messages`，与对话路径同规则）、
  `openai-completions`、`openai-responses`；其余协议明确回 `unsupported`。
- **凭据**：表单临时 key → `credentials.resolve(apiKeyEnv)` → 进程环境变量；
  **key 永不回传**（`detail` 两遍脱敏）。
- **信任栅栏**：Host / Origin / `sec-fetch-site` 三层（与 sidebar、canvas 的 `/api` 栅栏同构）。
- **无副作用**：除一次极小模型调用外不改配置、不写文件。
- **降级**：路由 404（插件未装 / host 未重启）时补丁自动回退 v1 目录探测并附提示，
  因此本插件是补丁的**可选**依赖，缺失不会让按钮失效。

路由：`POST /model-probe-api/probe`、`GET /model-probe-api/health`。

安装：同其它 profile bundle —— `%USERPROFILE%\.dsh\profiles\web\package.json` 的
`dependencies` + `dsh.profile.bundles` 加 `dsh-model-probe`（file: 依赖），
profile 目录 `pnpm install`，**host 重启**后生效。

自证：`node plugins/dsh-model-probe/test/probe.test.js`（18 例判定表单测，纯逻辑无网络），
已并入 `node scripts/verify-all.mjs desktop`。

## 设计规范

- 总体设计与三主题规范：`design/themes.md`
- DSH 令牌面（构建校验依据）：`design/token-surface.txt`
- 启动可靠性（失败恢复页/健康标记）：`design/bootstrap-reliability.md`
- 模型连通性探测 v2（两段式探测 / 分类表 / 降级策略）：`design/model-probe-v2.md`

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
