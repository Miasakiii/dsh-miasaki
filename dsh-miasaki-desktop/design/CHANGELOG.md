# Miasaki Desktop — 变更日志

> 按时间倒序。历史排查细节与决策见 `ARCHITECTURE.md`;待办见 `TODO.md`。

## 2026-09-25（晚）· 排查：MSI 打包失败（结论＝会话环境限制，非项目配置）

**现象**：`npm run build` 的 exe 环节成功、MSI 环节失败，而 tauri 只给出一句
`failed to run …\light.exe` —— **light 的 stderr 没有被转发**，这就是此前只能"挂账"的原因。

**排查**：改用 `npx tauri build --verbose`（会打印被调用的完整命令行与子进程输出），
两层报错先后暴露：

1. `LGHT0001 … 对路径"%LOCALAPPDATA%\Temp\xxxx.tmp"的访问被拒绝`（`UnauthorizedAccessException`，
   调用栈含 `TempFileCollection.EnsureTempNameCreated`）—— light 需要一个**可写的 `%TEMP%`**；
2. 把 `TEMP`/`TMP` 指到 `target/tmp` 后，立刻撞上 `LGHT0217 : Error executing ICE action 'ICE01' …
   The Windows Installer Service could not be accessed` —— 而当时 **`msiserver` 实为 `Running`**。

**结论**：两层都是**执行会话的环境限制**（受限令牌 / 沙箱挡住了 `%TEMP%` 写入与服务访问），
**与项目配置无关**。三条取证：① 手动给 light 加 `-sval`（跳过 ICE）后**成功产出 37.62 MiB MSI**；
② `bundle/msi/` 里那份 **2026-09-04** 的 MSI 证明这条链在正常桌面会话里是通的；
③ 先做过"旧 MSI 被占用"的假设检验 —— 独占读写试开通过，**已排除**。

**同一根因的既有影响**（当时误判为 cargo 特有）：受限会话里 `cargo test` 的测试进程写系统
`%TEMP%` 得到 os error 5（10 例假红）。当时的处置是把测试临时目录统一改到 `target/test-tmp/`
—— 那是本项目侧的**真实改进**（测试不再依赖系统 TEMP），与本次排查结论互相印证。

**落地**：排查路径 + 两条变通写进 `README.md` 新增的「打包（MSI）失败排查」章节。
**未改任何构建配置** —— 不为环境问题给项目加复杂度；发布用 MSI 仍应在正常桌面会话里走完整 ICE 校验。

## 2026-09-25（晚）· 契约 v1.1：受控写能力（事件驱动，不新增 hash 写者）

**新增**：`window.miasakiDesktop` 加 `theme.set(name)` 与 `window.controls.{minimize,maximize,close}`。

**关键设计：契约自己不写 hash**。契约分片是独立 IIFE，拿不到寄生 IIFE 里的 `apply` / `petHashCmd`；若在那里直接实现写通道，会立刻造出**第三个 hash 写者**（正是 W0-T0.2 刚修掉的竞态）。因此写能力一律**派发内部事件**：

- `theme.set` → `miasaki-theme-set` → `02-core.js`（寄生）执行 `apply()`；
- `window.controls.*` → `miasaki-window-command` → `06-titlebar.js`（寄生）映射为 `petHashCmd('min'|'max'|'close')` —— **复用唯一写者**，写者数量不变。

**两条纪律**：

1. **双向校验**：契约侧白名单（且只暴露 `minimize`/`maximize`/`close` 这些人话名，内部协议名 `min`/`max` **不透出**），执行侧（寄生分片）**再校验一次** —— 事件可被任意页面脚本派发，不能只靠发起方自觉；
2. **返回值语义写清**：`true` = 已派发，**不代表已生效**（Rust 侧 33ms 轮询消费并按 `seq` 去重）；需要回执请订阅既有通道（如 `window.onMaxStateChange`）。

**同批修正文档的一处不一致**：原文写"新增能力要提升 `protocolVersion`"，但那与 `has()` 探测机制重叠。现明确：`protocolVersion` **只在破坏性变更时提升**，增量能力只追加 `capabilities` 条目 —— 旧插件完全不受影响。本次 v1.1 **`protocolVersion` 仍为 1**。

**验证**：契约闸门 11 → **15 例**（新增：派发与白名单拒绝 / 人话名不透内部协议名 / 只派发不写 hash / 寄生侧监听的静态断言）；`verify-all` 七线全绿、desktop 29/29；`cargo test` 78 例。已构建部署（exe 哈希 `1C4D41812F1D4A45`）。

**待实机验收**：DevTools 里执行 `window.miasakiDesktop.theme.set('kurkuriel')` 应切主题；`window.miasakiDesktop.window.controls.minimize()` 应最小化窗口；`theme.set('bogus')` 应返回 `false` 且无任何副作用。

## 2026-09-25（晚）· W5 自更新降级方案：只查、只提示、只打开下载页

**边界写死**：真正的自更新需要三样本项目目前没有的东西 —— **签名密钥的保管链**、**CI 产线**、**安装前的任务准入**（官方 Electron 用 `update-tasks lock` 排空在途请求才敢 `quitAndInstall`；本项目的停机准入在 `recovery.rs::stop_decision`）。缺这些还做静默安装，风险很直接：**更新到一半打断用户正在跑的会话**。所以 `src-tauri/src/update.rs` 的边界是：**能查、能提示、能打开下载页，绝不自己下载或安装**。

**更新源由用户自管**（不猜默认值）：`%LOCALAPPDATA%\miasaki\update-source.json`（与 `server.log`、诊断报告同目录，点「打开日志目录」即可见）

```json
{ "feed": "https://example.com/miasaki/version.txt", "page": "https://example.com/miasaki/" }
```

- `feed` 返回**纯文本版本号**（如 `0.2.0`）—— 刻意不用 JSON 响应：少一层解析就少一类失败面，用户自己维护时也更容易写对；
- 缺文件 / 缺键 / 非 http(s) URL ⇒ **明确的中文错误（含路径）**，不猜、不回落默认源（一个假的默认源比没有更糟）；
- 非 http(s) scheme 一律拒绝（这两个值分别交给 `curl` 与系统浏览器，放行 `file:`/`javascript:` 没有正当用途）。

**零新依赖**：用系统 `curl.exe`（Win10 1803+ 随系统提供，本机实测 8.21.0）而不是引入 HTTP 客户端（ureq + rustls ≈ +1.5 MB 与一段编译时间）；打开下载页用 `ShellExecuteW`（比 `cmd /C start` 少一次 shell 解析链）；`windows-sys` 加 `Win32_UI_Shell` 特性。

**交互**：托盘「检查更新」→ **后台线程**跑（curl 最长 15s，绝不阻塞托盘菜单处理线程）→ 原生对话框：有新版本则问「现在打开下载页吗」（Yes/No），文案显式写明「本应用不会自动下载或安装」；已最新给一句确认；失败给可读原因 + 配置文件路径。

**版本比较**（纯函数，单测覆盖）：允许 `v` 前缀；截断预发布/构建元数据（`0.2.0-rc.1` → `0.2.0`）；按段比较且补零（`0.2.1 > 0.2`、`10.0.0 > 9.9.9` 不按字符串比）；**任一侧无法解析 ⇒ 一律不报新版**（宁可漏报 —— 一个假的新版本提示会把用户推去装不该装的包）。

**验证**：`cargo test` **78 passed / 0 failed**（update 模块 5 例）；`verify-all` 七线全绿、desktop 29/29。已构建部署（exe 哈希 `2EAF2F8FEEF9D376`）。

**待实机验收**：① 未配置更新源时点「检查更新」→ 提示配置路径（不发网络请求）；② 配一个真实 `feed`（内容版本号大于 0.1.0）→ 弹「发现新版本」并可打开下载页；③ `feed` 内容改成 `0.1.0` → 提示已是最新；④ 断网 → 可读的失败提示（不是静默、不是假装已最新）。

## 2026-09-25（晚）· W4.2 材质分层：壳说事实、页面选分支（消除双层模糊）

**问题**（跨线评审实测）：外观线的玻璃档位 `mica` 语义是「**用系统云母**」，但实现是页面侧 `backdrop-filter: blur(40px) saturate(1.6)`。Win11 上原生 Mica 同时生效 ⇒ Chromium 的模糊叠在 DWM 材质之上 = **两层模糊**：更糊、更耗电，而且与档位语义自相矛盾（外观线自己文档里标注的"web 近似、非 Win11 真 Mica"正是这个矛盾的注脚）。且 `data-mia-glass` 与 `MIASAKI_NO_MICA` 此前**互不知情**。

**分工**（本次定的契约）：**壳负责说事实，页面负责选分支**。

- 壳：`initialization_script` 前缀注入**预判值** `window.__MIA_NATIVE_MICA__`（Win11 = 系统 build ≥ 22000 且未设 `MIASAKI_NO_MICA`）；页面就绪后（600ms）用 DWM 的**实际结果**广播 `miasaki-native-material`（`push_native_material`，与 `push_max_state` 同构）；
- 注入层：`themes/src/12-material.js`（新分片，独立 IIFE）把事实落到 `html[data-mia-native-mica="on|off"]`；
- 外观线：`mica` 档的玻璃规则改挂 `:not([data-mia-native-mica="on"])` —— 原生生效时**不加**页面侧模糊，只留 alpha tint。

**为什么首帧就是对的**：外观线的 boot style 写在 index.html 文本里（**解析期**生效），而 `12-material.js` 在 `document_start` 就跑（`initialization_script`）——**比解析期更早**。因此那条 `:not(...)` 选择器首帧即命中正确分支，不存在"先叠一层再撤"的闪烁。预判只在 DWM 实际拒绝材质时失准，由 600ms 的广播修正。

**边界**：`light` / `frost` 是「页面自己做玻璃」的独立档位，与原生材质叠加属用户选择，**不掺入**该条件（测试钉死）；注入层**只搬运事实、不做决策**（不读外观线配置、不读 `data-mia-glass`），拿不到预判一律按 `off`（保守 —— 宁可让页面侧玻璃兜住视觉，也不要"以为有原生材质、结果什么都没有"的裸窗口）。

**改动面**：`main.rs`（`native_mica_expected` + `push_native_material` + init 前缀）· `diag.rs`（抽出 `windows_build_number()` 供预判复用）· `themes/src/12-material.js`（新）· `appearance/lib/config.js`（`buildGlassBootCss` 条件化）· 两侧各加闸门。

**验证**：`cargo test` 73 例全过；`verify-all` 七线全绿、**desktop 29/29**（新增 material 闸门 8 例）；appearance 16/16（`config.test.js` 加 W4.2 断言）。已构建部署（exe 哈希 `5DBF81ED812E1177`）。

**待实机验收**：① Win11 下选 `mica` 档 → 侧栏 / 对话 / 右栏**只有一层模糊**（与 `frost` 档对比质感，不应更糊）；② `MIASAKI_NO_MICA=1` 启动 → `mica` 档回落到页面侧模糊（此时它是唯一模糊来源）；③ DevTools 里 `document.documentElement.getAttribute('data-mia-native-mica')` 与环境变量设置一致；④ 切 `light` / `frost` 不受影响。

## 2026-09-25（晚）· W2 取证与可靠性 + W3 关闭语义 + W4 表现层（官方桌面端借鉴第二批）

**背景**：同 [`official-desktop-adoption-plan-2026-09-25.md`](../dsh-miasaki-shared-docs/cross/official-desktop-adoption-plan-2026-09-25.md) 的 W2–W4。
Rust 侧（W2）由子代理实施、Lead 复核并修正两处判据；全部经 `cargo test` 与七线回归验证。

### W2 · 取证与可靠性（对症 P0「偶发全黑无响应」）

| 模块 | 内容 |
|---|---|
| `src-tauri/src/diag.rs`（新增 ~1160 行） | **诊断报告**：事实头（时间/版本/平台/WebView2 版本读注册表/locale）+ `--- error ---` + `--- renderer console (error level, oldest first) ---`（64 KiB 最近优先）+ `--- host tail ---`；文件名 `crash-<ISO8601>-<source>.log`（source ∈ main/host/renderer/web-boot/watchdog），**保留最近 10 份**且只删匹配自身模式的文件（`server.log`/`pet.log` 永不误伤）。**`panic = "abort"` 下走 `std::panic::set_hook`** —— 该配置 `catch_unwind` 抓不到任何东西，panic 点即唯一取证点。<br>**进程内看门狗**：独立 OS 线程 500ms 一拍，读**主窗 UI 线程**心跳（`wv.url()` 是派发到主线程的同步 COM 调用，返回即证明主窗消息泵在转）；5s 无心跳 → 落盘现场（缺失时长 + 最后 hash + 关键状态 + 后端存活性 + server.log 尾），30s 才请求恢复对话框；恢复后落 `recovered` 并重置。**桌宠线程自持 `GetMessageW` 消息泵，不属本判据、也不背锅**。 |
| `src-tauri/src/recovery.rs`（新增 ~680 行） | **原生恢复对话框**（Win32 `MessageBoxW`，不依赖 WebView2 健康度）：退出 / 重启 / **停用第三方插件后重启**。「停用」= 备份 `cordis.patch.yml` 为同目录 `.bak-<unix_ms>`（冲突追加序号、**绝不覆盖既有备份**）+ 把 `package.json` 的 `dsh.profile.bundles` 重置为基线（**失败即中止、原文件逐字保留**）；profile 名有路径穿越硬闸门。端口占用降级两按钮。<br>**分级停机状态机** + `stop_backend_tiered`（软杀 → 等 → 强杀 → 等 → 再强杀 → 记录未退出 PID）。 |
| `main.rs` | **Job Object**（`KILL_ON_JOB_CLOSE`）把自拉后端纳入 Job，壳崩溃时由 OS 回收整棵进程树。**停机判据一行未动** —— 「3080 上仍有本进程树外的客户端 → 保留后端」（2026-09-23 断线事故修复）原样保留并配断言单测。 |

**两处必须记住的事实**：

1. **Job 与「保留后端」的冲突及取舍**（Lead 复核结论）：判定 Retain 时 `retain_job_until_exit()` 把 Job 句柄永久摘除（等价于「本进程没有 Job」），代价是此后壳崩溃**不再回收那个后端**。**认账**：该场景下它本就有别的用户在用，按既有语义不该被杀 —— **保「外部客户端不断连」优先于「崩溃时回收」**。
2. **`taskkill` 不带 `/F` 杀不掉控制台进程**（只发 WM_CLOSE，而 `cmd.exe`/`node.exe` 没有消息循环）⇒ 软杀阶段对后端注定白等，真正生效的是强杀。已钉进注释与回归测试，**防止后人误以为「软杀成功了」而裁掉强杀级**。

### W3 · 关闭语义改为「关闭 = 隐藏到托盘」（对齐官方）

- `CloseRequested`（含 Alt+F4 / 任务栏关闭）与标题栏 ×（hash `cmd=close`）**不再退出**，统一走 `hide_to_tray()`：首次弹**一次性原生确认**，确认后写 marker（`%LOCALAPPDATA%\miasaki\background-close-confirmed`）；取消则窗口保持可见、下次仍会问。marker 让交互**可重放、可测试**（删文件即回到首次态）。
- **真退出只经托盘「退出」/ 桌宠「退出应用」** → 前端确认弹窗 → `cmd=shutdown` → 分级停机停后端。5s 内重复请求仍是「强制退出（不杀后端）」兜底。
- `ui/loading.html` 失败页加「恢复选项」按钮，把 W2 的原生三按钮暴露到页面侧。

### W4 · 表现层

- **W4.1**（appearance 线，另见该线 CHANGELOG）：首帧注入行加官方六种 kind 白名单 —— 前端对未知 kind 是**启动期抛错**（整页起不来），产出侧必须自证每一行都合法。
- **W4.3 窗口底色回传**：`02-core.js` 新增 `resolveNativeBg()`（半透明底与 `html` 底合成到不透明；**拿不到不透明底就如实放弃上报**，绝不猜颜色），经 hash `bg=RRGGBB` 回传；Rust 侧 `parse_fragment` 校验 6 位十六进制（脏值不透传）、`apply_window_bg` 消费 —— **仅 Mica 未生效时**（`MICA_ACTIVE`），否则会盖掉系统材质。窗口底至此不再只是「创建时算一次的硬编码两档」。
- **W2 收尾 · 渲染层 console 旁路**（`themes/src/11-console.js`，新增）：诊断报告的 `--- renderer console ---` 段此前**恒为空**（Rust 侧 `diag_console`/`push_console_line` 早已就位但无写者），而挂起类 P0 的线索恰在渲染层。旁路 `console.error` + `error`/`unhandledrejection`，环形缓冲（50 条 / 16 KiB，丢最旧）+ 2s 批量 `invoke('diag_console')`；**只旁路不改变**（原生调用照常、记录失败不影响原调用）、**只顶层 frame**（避免 iframe 重复灌）。

### 同批修正（复核子代理产物时发现）

- **`taskkill` 结局判据**：Windows 控制台程序的错误串是**系统 OEM 代码页**（简体中文 GBK），`from_utf8_lossy` 后中文成 U+FFFD ⇒ 原「文本匹配 `denied`/`拒绝访问`」判据把**权限拒绝误判成 `Failed`**（回归假红）。改为：用法错误（ASCII）→ `Failed`；否则以**目标进程是否仍存活**为准（活着 = 系统拒绝；已死 = 其实成功）。
- **测试临时目录**：`diag`/`recovery` 的 4 处测试原用 `std::env::temp_dir()`，本机受限环境下 `create_dir_all` 返回 os error 5 ⇒ 统一改为 `target/test-tmp/`（cargo 自己可写，测试产物不再进系统 TEMP）。

### 追加防御：隐藏/最小化时放宽看门狗阈值（同日复核）

`wv.url()` 虽是 Rust 侧发起的同步 COM 调用，但 WebView2/Windows 对**不可见宿主**存在节流与遮挡（occlusion）处理的可能 —— 若此时仍按 5s 判据，会把「节流导致的调用变慢」**误报成挂起**。**假报告比漏报更伤诊断的可信度**（报告的价值全在信得过）。

处置：主窗 UI 线程喂心跳时一并上报 `is_visible() && !is_minimized()`，看门狗按可见性选阈值 —— 可见 **5s**（快速取证）/ 不可见 **90s**（容忍节流）。**放宽不是取消**：隐藏态真挂死仍在 90s 后落盘（用户此时看不到窗口，晚一点取证可接受）。可见性原子量默认 `true`（判据未就绪时按最严格阈值走，宁可多报不可漏报）。

单测覆盖三条：同一 gap 可见报 / 不可见不报；阈值收紧立即生效（窗口被重新打开）；隐藏态超 90s 仍报。

### 手动生成诊断报告（托盘入口，同日）

托盘菜单新增「生成诊断报告」：与自动路径**同一套** `collect_facts` + `format_report` + `write_report`（含轮转），仅来源标记为 `Source::Manual`、原因写"用户手动触发"。点击后原生信息框回显**完整路径**（成功与失败都回显 —— 取证模块的唯一价值就是"可诊断"，静默成功或静默失败都会毁掉它）。

为什么要它：取证链路此前只能在崩溃 / 挂起时被触发，用户想验证"它到底工作不工作"得人为阻塞消息泵，日常怀疑卡顿时更是无门。这个入口把诊断从"出事才跑"变成"随手可跑"。

配套三处：`Source::Manual` 同时进 `as_str` / `parse` / **`is_report_file_name` 白名单**（漏最后一处会让手动报告**永远轮转不掉**、点几次堆一堆）；`recovery::show_info` 用 Win32 `MessageBoxW`，与恢复对话框同一条纪律 —— 不依赖 WebView2 健康度；单测覆盖「命名与轮转识别成对」+「manual 与其它来源共享配额且不误伤 `server.log`/`pet.log`」。

**验证**：`cargo test` **73 passed / 0 failed**（含 3 例真机进程级测试）；`node scripts/verify-all.mjs` 七线全绿、**desktop 28/28**（W1 后 26 → W4.3 后 27 → console 钩子后 28）。

**待实机验收**：① 人为阻塞主窗消息泵 → 5s 内生成 `crash-*-watchdog.log`；② 隐藏/最小化到托盘静置 2 分钟**不应**产生报告（已加阈值防御，此条转为「确认防御生效」）；③ release（`panic="abort"`）下人为 panic 是否真落盘；④ 关闭 → 隐藏 → 托盘召回全链路 + 首次确认与 marker 重放；⑤ `MIASAKI_NO_MICA=1`（Win10 等价）下切主题窗口底色跟随。

## 2026-09-25（晚）· 红条过滤 ResizeObserver 调度产物（注入层缺陷误报修复）

**起因**：用户实机截图，桌面壳注入层红条常亮
`MIASAKI-ERR[1]: ResizeObserver loop completed with undelivered notifications.`，
`@` 后跟的既非脚本路径而是**文档 URL（含 hash）**（红条文案把 `e.filename` 末段
+ `e.lineno` 拼在消息后；该事件无脚本来源，filename 落回页面 URL）。
实机 hash 快照同时用于交叉验证：`pet=thinking&pettool=&petts=…&petkey=&diag=603.1.1.1.0.1.727.793.DIV.fixed%2F9999…`——
hash 字段本身拼装正确（`pettool=` 为空即无工具名），非格式缺陷。

**根因判定**（环不在注入层，修不了也不该我们修）：Chrome/WebView2 在 RO 回调引发
观察元素尺寸反复变化、超过单帧派发上限时抛此 ErrorEvent（Firefox 措辞为
`ResizeObserver loop limit exceeded`）。逐处核查四条 RO 链：
① 注入层唯一自建 RO（`runtime.js` 侧栏几何 `watchSidebarEl`）——回调只读布局、
只写 `position:fixed` 的 `#miasaki-titlebar`（`--ms-sidebar-w` / `--ms-details-left`），
**结构上不可能自反馈**；② DSH 本体 `conversation` 的 `seatResizeRef`（观察 scroller
却往 scroller 写 `--dsh-composer-height` / `--dsh-conversation-viewport-height`）——
两变量唯一消费方是 chat 包两个浮层（`contain:layout` + absolute/sticky，不回流尺寸），
收敛；③ chat `follow.bind` 流式跟滚 / 虚拟列表、attachment `updateEdges`、
trajectory `measure`——均无「观察即写自身尺寸」模式。结论：触发者是宿主页自身
观察器（流式输出 / 布局过渡期间的经典 Chrome 行为），误报会让红条与 `ERR_COUNT`
（hash diag `errCount` → Rust 日志）长期「狼来了」。

**实施**：`themes/src/00-boot.js` + legacy 回退 `themes/runtime.js` 的 error trap
新增 `isBrowserArtifactError(e)` 双重判据过滤——消息必须命中
`ResizeObserver loop (completed with undelivered notifications.|limit exceeded.)`
两个浏览器既有变体之一，**且** `e.lineno` 为 0/缺失（真实脚本异常必有行号）。
过滤事件不进红条、不计入 `ERR_COUNT`；其余行为（单例红条 / `[N]` 计数 /
parentNode 判空重建）不变。

**验证**：过滤判据单测 11 例 + vm harness 行为验证 8 例（产物两措辞均不渲染；
真实异常仍进红条且计数从 1 起；单例与重建语义不回退）全 PASS；`npm run gen-init`
重建通过（10 片、令牌校验 + 三道自校验）。**注意**：`main.rs:19` 以
`include_str!` 把 `src-tauri/injected/theme-init.js` 编译进二进制，须重新
`npm run tauri build`（或 dev）后重启桌面壳生效，热刷新不够。

- 触摸点：`themes/src/00-boot.js`、`themes/runtime.js`、本文件。
  构建产物 `src-tauri/injected/theme-init.js` 已随 gen-init 更新（gitignore 覆盖）。
- 用户待执行：重新构建并启动桌面端（`npm run tauri dev` 或 `build`），复现场景
  （agent 流式输出期间）红条不再出现；若仍有红条，按消息文本定位真实脚本异常。

### 实机验收（2026-09-25 22:16–22:30 · 上文「用户待执行」的闭环）

- **构建/部署**：`npm run build`（MSVC x64 开发者环境 + cargo 1.95）→ exe 编译与本地证书
  签名成功（SHA256 `AF14DA12…`），复制到 `dist/` 后 `npm run deploy` →
  `C:\ProgramData\MiasakiApp`（8/8 PASS，两端哈希一致）。**MSI 打包未过**：`light.exe` 报
  `LGHT0001`「访问路径 `%LOCALAPPDATA%\Temp\*.tmp` 被拒绝」，把 TEMP/TMP 指向可写目录后
  **仍复现** ⇒ 本机 WiX 环境限制（非代码问题，见 README §构建环境三件套的新补注）；
  exe 本体已产出，安装包可在普通终端重跑 `npm run tauri build` 补齐。
- **二进制自证（"刷新页面不够"的闭环）**：直接在 exe 内检索到 `isBrowserArtifactError`、
  `MIASAKI-ERR[` 与 RO 产物判据注释段 —— `include_str!` 内嵌的注入脚本确已随二进制更新。
- **验证①·受控真实触发（真实 WebView2，11/11 PASS）**：壳以 `MIASAKI_REMOTE` 指向本地探针页
  （`_refs/scripts-archive/redbar-probe.mjs`）：真实 RO 调度产物被**真实抛出**（独立监听器
  见证 `lineno=0`、filename 落文档 URL —— 与实机红条截图的 `@` 后缀同形），红条全程 `null`、
  diag `errCount` 恒 0；期间累计 8690 条 error 事件（绝大多数是 RO 产物）无一污染红条/计数；
  随后注入真实未捕获异常 ⇒ 红条 `MIASAKI-ERR[1]: Uncaught Error: …` 亮起、errCount=1
  （**防过滤过度**）、单例语义不回退；142 段落 / 6s 流式渲染压力期间红条文本逐字节不变。
- **验证②·真实 DSH 页面 + 真实模型流式输出（5/5 PASS）**：无头 Edge + CDP 打开
  `127.0.0.1:3080`（注入**同一份** `theme-init.js` + 壳同款鉴权 cookie），真发一条消息 ⇒
  流式 20 次 DOM 增长（630 → 1366 字符）+ 视口每 1.5s 抖动强制重排，红条全程 `null`、
  `errCount ∈ [0,0]`。**诚实注记**：该场景本次**未自然触发** RO 产物（监听器计数 0），
  故它证明的是「真实流式期无红条 / 无虚增」；**过滤生效的直接证据来自验证①**。
- **验证③·壳内真实页面交叉印证**：正常模式壳的 `hash-diag`（变化才落盘）在真实 DSH 页面
  窗口内 errCount 恒 0；同一份日志里探针注入真实异常的两次运行精确落盘 errCount=1。
- **复跑**：首次验证在 11 片产物（`EDD01B15…`）上完成；部署**含并行新增 `11-console.js`
  的 12 片产物**（`AF14DA12…`）后同样 **11/11 PASS**。
- 截图证据（`_refs/`，已 gitignore）：`shot-A-ro-loop-filtered.png`（产物期无红条）、
  `shot-B-real-exception.png`（真实异常红条）、`shot-C-real-dsh-page.png` 与
  `shot-D-final-normal-mode.png`（真实 DSH 页面无红条）。
- 遗留：验证在 3080 后端留下 2 个探针会话（"数到 60"、"雨夜的图书馆"短文），可在侧栏删除。
- **观察（未定因、非本次改动引入，记录备查）**：其中一次正常模式启动（22:30:31）出现
  「主窗空白 + 期间无任何 hash 上报（`pet.log` 无 `hash-diag`/`set_mode` 行）」；同一产物
  重启后恢复正常（启动 5s 即落盘 `hash-diag`、3080 两条持久连接、errCount=0）。
  与红条修复无因果关系，未复现，暂不作为缺陷立案。

## 2026-09-25 · W0 顺手修复 + W1 桌面契约 v1（官方桌面端借鉴第一批）

**背景**：官方桌面端（Electron，0.1.7-rc.2）实测分析 → 跨线落地规划，见
[`official-desktop-adoption-plan-2026-09-25.md`](../dsh-miasaki-shared-docs/cross/official-desktop-adoption-plan-2026-09-25.md)。
本轮落地 **W0（既有缺陷修复）** 与 **W1（契约层）**；Rust 侧 W2/W3 另行。

### W0 · 四处既有缺陷修复（零风险，先做）

| # | 问题（实测） | 处置 | 闸门 |
|---|---|---|---|
| T0.1 | 壳注入 `window.__MIA_THEME__`（`main.rs:1647-1649`），但 `themes/src` **全片零读取** ⇒ 本地唤醒页（`tauri.localhost`，localStorage 为空）主题退化成 `pure`，而该页 `:root` 默认色板是 zafkiel ⇒ **启动闪窗** | `02-core.js` 主题来源新增最高优先级 `__MIA_THEME__`（`> URL 参数 > localStorage > pure`） | `themes/test/theme-source.test.js`（8 例） |
| T0.2 | `05-sensors.petHashCmd` 写入时**从零构造 hash**、1600ms 后又**整体清空** ⇒ 抹掉 `02-core.syncHash` 与 pet-panel 并发写入的字段（"hash 单写者"约定实际不成立） | 改为**字段级精确增删**（`hashPairs`/`readHashField`/`setHashFields`）；保留其它字段**原始编码**（不用 `URLSearchParams.toString()`，避免 `%20`→`+` 打乱 Rust percent-decode 口径）；TTL 清理加 **seq 覆盖保护** | `themes/test/hash-fields.test.js`（8 例） |
| T0.3 | ① `notifyPet` invoke 的 `set_pet_mode` **命令从未注册**（注册表 `main.rs:1607-1618` 仅 10 个），恒失败并被 `.catch()` 静默吞掉；② 仅供它使用的 `PET_MODES` 与 Rust `main.rs:947 pet_mode_for` 重复定义 | 删除 `notifyPet` + 3 个调用点（`02-core` / `08-ready` / `03-switcher`）+ `PET_MODES`。桌宠联动本来就走 hash `miasaki-theme` → `main.rs:1191-1204` | 语法闸门 + 全量回归 |
| T0.4 | `build-init` 产物（JSON 字面量 + JS 分片拼接）**无自校验**；官方同类 manifest 恰是"尾部 `}` 被截断仍被打包" | 三道自校验：样式 JSON 可解析且键集 == THEMES、**目录下 `.js` 必须全部登记进 `MANIFEST.order`**（漏登记＝静默不打包）、写盘字节一致 | `build-init.mjs` 自证 + 全量回归 |

同批：`themes/src/MANIFEST.json` 删除已过期的 `slices` 行段（与 legacy `runtime.js` 早已非逐字节一致）。

### W1 · 桌面壳 ↔ 渲染层契约 v1

新增独立分片 `themes/src/10-contract.js`，暴露 `window.miasakiDesktop`：
`protocolVersion: 1` / `isDesktop` / `isLocalPage` / `capabilities` + `has()` /
`theme.current|onChange` / `window.onMaxStateChange` / `assets.baseUrl`。

三条纪律（闸门逐条钉死）：**只暴露确实实现的能力**、**只读 + 订阅、不开写通道**
（否则立刻造出第三个 hash 写者——正是 T0.2 刚修掉的竞态）、**子 frame 只给空壳**
（`initialization_script` 注入每个文档，`08-ready.js:3-8` 有"iframe 里浮出两套假窗控"的实机教训）。

设计文档：[`design/desktop-contract.md`](desktop-contract.md)。

**T1.1 结论（推翻规划初稿）**：官方后端 `dsh-host-webserver` 在 index.html 末尾注入
`(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()` —— 它**复用我们的 deferred
后立刻 resolve**，故壳无法把 DSH 前端挡在 `onReady()` 之后；首帧就位的正确通道是
`webserver/index-inject`（appearance 线既有做法）。

**验证**：`node scripts/verify-all.mjs desktop` = **26/26 PASS**（W0 前 23 → W0 后 25 → W1 后 26），含 `cargo test` 35 例。
**待实机验收**：① loading 页与 DSH 页主题一致（无闪窗）；② 连续点窗控 / 切主题 / 桌宠上报互不干扰；③ 页面内 `window.miasakiDesktop` 可探测。

## 2026-09-25 · 三个插件的 dsh peer 上界放宽（拆掉 0.2.0 定时炸弹）

**起因**：官方 0.1.7-rc.1 引入**插件 peer 兼容性硬闸门**
（`packages/boot/app-boot/src/plugin-compatibility.ts`）：只校验 `peerDependencies` 中
`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的条目，按 `semver.satisfies(本体版本, 范围, { includePrerelease: true })`
判定，不满足即**拒绝加载**（需 `dsh plugin allow-version` 做精确版本豁免）。

**问题**：`dsh-pet-panel` / `dsh-model-probe` / `dsh-free-model-pool` 声明的是 `^0.1.2-rc.1`，
其隐含上界为 `<0.2.0` —— 即 **dsh 一进入 0.2.0，这三个插件就会被直接拒载**（当前 0.1.7-rc.2 尚在范围内，属定时炸弹）。

**处置**：5 处范围改为 `>=0.1.2-rc.1 <0.3.0` —— 覆盖 0.1.x / 0.2.x，同时保留 0.3.0 的挡板。

| 文件 | 行 | 字段 |
|---|---|---|
| `plugins/dsh-pet-panel/package.json` | 26 | `@deepseek-ai/dsh-settings` |
| `plugins/dsh-model-probe/package.json` | 28–29 | `dsh-settings` + `dsh-host-webserver` |
| `plugins/dsh-free-model-pool/package.json` | 26–27 | `dsh-settings` + `dsh-host-webserver` |

`@deepseek-ai/cordis: ^4.0.2` **不动** —— 不以 `@deepseek-ai/dsh` 开头，**不进闸门检查**。

**验证**（逐字复刻闸门逻辑后跑**真实 package.json**）：

| 插件 | 0.1.5-rc.3 | 0.1.7-alpha.2 | 0.1.7-rc.2 | 0.2.0 | 0.2.5-rc.1 | 0.3.0 |
|---|---|---|---|---|---|---|
| dsh-pet-panel | PASS | PASS | PASS | **PASS** | PASS | DENIED |
| dsh-model-probe | PASS | PASS | PASS | **PASS** | PASS | DENIED |
| dsh-free-model-pool | PASS | PASS | PASS | **PASS** | PASS | DENIED |
| dsh-token-monitor（对照，未改） | PASS | PASS | PASS | PASS | PASS | PASS |

（PASS = 闸门放行；DENIED = 拒载。`dsh-token-monitor` 只声明 `@deepseek-ai/cordis`，不进检查故全 PASS。）

**回归**：`plugins/dsh-model-probe` 单测 **12 例全过**，其中含 `probeModel resolves the stored profile on ≤0.1.6 (get world)`
与 `… on 0.1.7 (describe world)` 两条 —— 正是 0.1.7 设置机制重写后的双轨用例。

**依据**：[`dsh-0.1.7-rc2-upgrade-and-refit-plan-2026-09-25.md`](../dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.7-rc2-upgrade-and-refit-plan-2026-09-25.md) §3（W2）
与 [`dsh-official-repo-review-2026-09-25.md`](../dsh-miasaki-shared-docs/dsh-platform/dsh-official-repo-review-2026-09-25.md) §4。

## 2026-09-24（三轮复审）· 文档基线归位 + 两处 P3 断言修复 + live 审计补第八件

**起因**：第三轮独立复审（纯审查、未改文件）复跑出实测基线 **98 项 / desktop 22/22 /
`cargo test` 35 例**，与文档口径（96 / 20 / 28）矛盾且与同文件历史记录行自相矛盾。
逐条核实后：**P2 一处 + P3 两处全部属实**，本轮修完；观察项两条一并收口。

| 编号 | 问题 | 处置 |
|---|---|---|
| P2 | 基线数字过时（根 `README.md` 最新基线块、`smoke-test-matrix.md` 表头与 desktop 行、本线 `README.md` 命令注释、本文件 09-24 条）：S4a 视觉闸门 + 桌宠资产闸门（+2 项）与 `dot.rs`（+7 例）未回写 | 四处同步为 **98 项 / desktop 22 / cargo 35**；`smoke-test-matrix.md` 的 §0 L1 行（双模型 24→**33**、外观 91→**95**、Desktop 18+25→**63 项 + cargo 35 例**）同批校正。**历史条目里的旧数字不改写**（那是当时快照），改为加括注指向现行基线——文档要能区分「当时」与「现在」 |
| P3 | `ui/loading.html` 就绪正则首分支码位写错：`\u5c31\u7ed3`（就**结**）是永不命中的死分支，真实文案靠第二分支「正在进入」侥幸兜住；测试字符串又把「就绪」写成 `\u5c31\u7ed2`（就**绒**）——同样靠第二分支通过，断言无区分力 | 正则改 `\u5c31\u7eea`（就绪）；测试三处字符串同步；新增「**仅**『已就绪』（不带第二分支）」用例单独钉第一分支 |
| P3 | `ui/test/loading-visual.test.js` 性能预算只截到首个 `}`——CSS `@keyframes` 是嵌套花括号，第二个及以后 stop 里写 `width:` 之类布局属性不会被抓 | 抽出 `blockBody()` 按花括号深度配平取**整块**；把「breathe 的 50% 分支（`scale(1.09)`）必须落在被检查的正文里」钉在 `body` 上（不另取一次）；reduced-motion 段改用同一 helper 去重 |

**区分力双向验证**（`_refs/` 下变异副本，跑完即删）：① 把正则码位回退成 `\u5c31\u7ed3`
→ 「仅『已就绪』」用例红（`fail 1`）；② 把截取回退成「首个 `}`」→ 性能预算用例红
（`fail 1`）；还原 → **10/10 绿**。

**观察项收口**：
- `scripts/patch-live-audit.mjs` 只审计 desktop 六件 + dual-model 一件，`shared-docs` 的
  第八件（`@yeesy369/dsh-browser-playwright` 双半补丁）在审计之外——而它被打回原版会让
  **web UI 连启动屏都过不去**，属真实盲区。本轮：审计工具支持补丁自报 `LIVE_TARGETS`
  （多目标，每半一行）+ 补 `shared-docs` 补丁根 + profile 布局探测扩到每个
  `~/.dsh/profiles/<name>/node_modules`；该补丁补 `LIVE_TARGETS` 导出与 **CLI 守卫**
  （此前 import 它会以调用方 argv 误跑 CLI，与 09-23 修掉的 attachment 同类）。
  判据自证：假 profile 根注入 `client.js` 原版 → 报 `original … 回归！` + 退出码 1，
  `host` 半仍 `patched`。顺带把该补丁 `verify` 里 `spawn EPERM` 的**环境假阴性**从
  「语法校验失败」改成诚实 ⚠（shell 层 `node --check` 双半 exit 0 实测通过）。
- 00-boot 兜底链依赖 `dsh-auth-*` cookie **非 HttpOnly**（靠 JS 可读来区分「已有 cookie
  只续期」）：已在 `design/auth-cookie-prepinject.md` §3 钉为显式契约——预置侧一旦加
  `HttpOnly`，`readAuthCookie()` 恒空 ⇒ 每文档重签兜底值 ⇒ secret 漂移 401 循环回归。

**并行会话协作（同一工作区，如实记录）**：本轮执行期间**另一个会话**正在落 S3「拖放安全网」
（新分片 `themes/src/09-dropguard.js` + 重生成 `injected/theme-init.js`，并在 `ui/loading.html`
与 `ui/test/loading-visual.test.js` 同步补第 11 例），两次与本轮验证发生竞态：
① 该分片末尾 `;((function () { … })()` **少一个 `)`** ⇒ 拼接产物在末尾 `Unexpected end of input`
⇒ verify-all 的注入语法闸门红（闸门按设计拦住，判据：分片 `parens diff = +1`）——已补为
`})())` 并复跑转绿，**该分片的归属与设计记录仍在原会话**（`design/drag-drop-attachment-upload.md`）；
② 其 `loading.html` / 测试文件的中间态一度让 loading 项红，落定后 **11/11**。若两条线并行编辑
同一批文件，请以本条为界：本轮只碰了 `09-dropguard.js` 的**那一个字符**与 loading 测试的
三处字符串 + 两处断言。

**验证**：`node scripts/verify-all.mjs` 七线 **98 项全过**（desktop 22/22，含启动页契约 11 例）、
`cargo test` **35/35**、`node scripts/patch-live-audit.mjs` **9 个目标全 patched**、
第八件补丁 `verify` PASS（语法项因沙箱 EPERM 降级为 ⚠，已 shell 层人工复核）。
**实机项不变**：appearance 图标名、S4a 启动页视觉、`SameSite=Strict` 首载、悬浮球三主题目视、
`verify-themes`（需普通终端）。

## 2026-09-24 · 故障定位：桌面端「打不开」= WebView2 运行时被系统更新打断（非本线代码）

**现象**：双击 `Miasaki-dsh.lnk`（或任何入口）只出现桌宠（`MiasakiPetWin`）+ 托盘，**主窗口
永不出现**；`pet.log`/`bootstrap.json` 无新写入（setup 走到 pet spawn，webview 早已失败）。

**根因（探针实测，非推测）**：`WebviewWindowBuilder::build()` 内部 `create_controller`
（`CreateCoreWebView2ControllerWithOptions`）失败 → **WebView2 浏览器进程
（`msedgewebview2.exe` 153.0.4234.48）启动即以 `STATUS_BREAKPOINT`（0x80000003）崩在
`msedge.dll+0x3806213`**（WER Report.wer 实锤，fault bucket `e728eff3…`）。已逐项排除：
配置文件（全新 UDD 同样崩）、沙箱（计划任务无沙箱同样崩）、GPU（`--disable-gpu` 同样崩）、
磁盘空间（清出 5GB 同样崩）、运行应用内上下文（独立 Rust 探针同样崩）。**环境创建
（`CreateCoreWebView2EnvironmentWithOptions`）是好的，坏的只是控制器/浏览器进程**；
机器在 21:19 有 Windows 更新暂存、21:48 因此重启，19:55 之前本功能正常——断点即该更新之后。

**已做**：重装 WebView2 运行时（UAC 修复安装 exit 0）——**无效**；本线代码零改动。
部署侧已把**签名版**产物覆盖为 `dist/Miasaki.exe`（旧未签名版备份
`_refs/bin-archive/`），桌面快捷方式随之获得 Authenticode 签名（`CN=Miasaki Dev`）。

**待办（需用户侧执行/观察）**：①再重启一次（更新批处理未完全收尾，尚有 40 条
`PendingFileRenameOperations`）；②仍不行则回滚 9/23 这台机器的 Windows 更新，或改用
**固定版（Fixed Version）运行时**挂 HKCU（免管理员）；③持续则向 WebView2Feedback 提
issue（附 WER bucket `e728eff3e06d4f6d5d9e3d4f6593c497`）。诊断脚本与输出归档：
`_refs/scripts-archive/2026-09-23-webview2-breakpoint-diagnosis.log`、`_refs/wv2-probe/`。

## 2026-09-24 · 隐藏态恢复入口：硬编码紫点 → 主题头像悬浮球

**起因**：桌宠隐藏后只剩一个硬编码紫色实心圆（`0xB36AD9`，`DOT_SIZE = 30`）——与三主题毫无
关联，且小到看不清。改为**当前主题的头像悬浮球**。

**视觉规格**（`pet_native/dot.rs`，纯 CPU 逐像素**预乘**合成，零 GDI 绘图/字体调用，与桌宠
合成同一纪律）：

| 元素 | 取值 |
|---|---|
| 窗口 / 球面 | 56px 方窗，球面半径 19（直径 38），球心恒在窗口中心 |
| 球面素材 | `ui/icons/theme-*.png` 三张 96px 徽章（与设置「主题」选择器**同一批图**，编译期内嵌）；再放大 `DOT_AVATAR_ZOOM = 1.09` —— 1:1 映射时素材自带的环落在球面内侧，与我们画的主题色环之间留一圈暗缝（读作「甜甜圈」）；放大后该环正好被球缘裁掉，球面内只剩头像本体 |
| 主题色环 | 球缘外 2px 描边，色取自各主题徽章环：pure 银 `#A6A0B2` / zafkiel 鎏金 `#D9B36A` / kurkuriel 破血红 `#C23A2E`（徽章原色 `#9E1B1B` 作发光过暗，提亮） |
| 外发光 | 环外 4px 二次衰减，峰值 alpha 96 |
| 球面高光 | 左上 45°，半径系数 0.52，峰值 alpha 34（玻璃球质感；46 在 38px 球上压脸） |
| 底部落影 | 圆心下移 1.8px，**只作用球体下半个环带**（上半权重 0）——上半加灰会把发光读成脏雾 |
| 悬停态 | 整体 ×1.08、发光与高光 ×1.45；**离散两态，不做插值动画** |

**接线**：
- `PetShared.theme` + `NativePet::set_theme`（白名单 `pure/zafkiel/kurkuriel`，hash 字段不可信）；
  `main.rs` 的 `miasaki-theme=` 分支在 `set_mode` 之外再喂一次主题。`spawn` 直接用
  `load_prefs()`（该函数提为 `pub(crate)`）——**冷启动恢复隐藏态时第一帧就是正确球面**，
  不必等页面 hash 上报，否则肉眼可见一次「换脸」。
- 窗口线程在 `compose` 里比对 `dot_theme`：变化且球可见（= 桌宠隐藏）时立即重绘；球不可见时
  只更新字段，交给显隐切换那次渲染带上新主题（省一次不可见的 ULW）。
- `draw_dot(hwnd, pos)` 自由函数 → `PetWin::render_dot()` 方法：渲染结果留在 `dot_buf`，
  **画面与命中共据同源**（球面即 mask，与 R2 主窗「查最终合成缓冲」同一范式）。
- 尺寸 30 → 56（`DOT_SIZE`），`CreateWindowExW` 与 ULW 尺寸常量同源，无第二处硬编码。

**为什么必须配穿透（「隐形挡板」）**：球从 30px 涨到 38px 后，方窗四角约占 26% 面积、发光外沿
一圈半透明。照收鼠标的话，隐藏态会在桌面上多出一片**看不见却吃点击**的区域。故复刻 R2 范式
给 dot 窗口配**自己的 10ms 命中轮询**（`dot_proc` 的 `IDT_HIT` → `update_dot_hit`）：查
`dot_buf` 的 alpha（阈值 16，与主窗同常量）决定 `WS_EX_TRANSPARENT`，**同一命中**同时驱动悬停
放大——用户看到能点的地方就有放大反馈，反之亦然；球隐藏时恒不穿透并清悬停态。

**兜底与不变量**：
- 素材缺失 / 主题未知 → 主题色实心球（`avatar_key` / `palette` 未知一律按 pure），**绝不空白、
  更不回退成紫点**；
- **位置语义不变**：dot 窗口仍以 `pos`（桌宠窗口左上角）定位，不补偿尺寸差 —— 补偿虽能让球心
  与旧圆心重合，但贴边时会因窗口出屏把球裁角，收益不足 9px；M1.4 的四处同步点（显隐切换 /
  散步自然结束 / 散步撞墙 / 拖动结束）全部改调 `render_dot()`；
- 单测 7 例钉死不变量：主题→素材键映射（**`kurkuriel` 用 `theme-inverse.png`** 的命名陷阱）、
  配色兜底、球心不透明 + 四角全透、**悬停放大后发光半径不越窗口**（越界即被方窗硬裁出直边）、
  球缘抗锯齿存在半透明过渡、环色随主题变化、素材缺失兜底。

**验证**：`cargo test` **35/35**（新增 7 例：`dot.rs` 渲染契约）、`node scripts/verify-all.mjs` **98 项全过**
（desktop 22/22）。离线目视：`dot::render` 三主题 × 常态/悬停输出 1×（桌面实尺寸观感）与 4×
（像素细节）预览图，核对球面 / 色环 / 发光 / 落影 / 悬停放大（临时预览测试**跑完即删**，不入库；
预览图落 `_refs/` 后清理）。**实机待验**：隐藏桌宠出现主题头像球、悬停放大、点击恢复、
主题切换即时换面、球外区域点击穿透到下层窗口。

## 2026-09-23（二轮复审）· 注入链 cookie 契约与 401 熔断 + 三项 P3 收口

**起因**：第二轮独立复审在工作区 4 文件之外再扫近 15 个已提交提交，报出 2 项 P2 回归 + 3 项 P3
瑕疵（dual-model 触发钮死件归 dual-model 线处理）。逐条核实**全部属实**，本轮修完。

| 编号 | 问题 | 处置 |
|---|---|---|
| P2-B | `themes/src/00-boot.js` 每次 3080 文档加载都用**硬编码 secret 无条件覆写** `dsh-auth-*` cookie。预置注入（9-22 主修）签入的是 `credentials.yaml` 里的**真** secret，两者一旦漂移就被兜底值盖掉：首次导航成功 → 下次整页导航 401 → reload → 新文档再签错 → **无限 reload**（四轮检查只管单文档内停检，跨文档无次数上限） | ① 已有 `dsh-auth-*` 时**只按原值续写** `Max-Age`（保留「session → 持久 cookie」升级意图，值一个字节不动），无 cookie 才走兜底签名；② 401 → reload 加 `sessionStorage` 跨文档熔断（上限 3 次；到上限前清一次已失效 cookie，给兜底签名最后自愈机会），超限停止重载并在页面显示可见提示；计数只在确认到达非 401 文档时复位（document_start 时 `is401()` 恒 false，据此复位等于无熔断） |
| P3 | 可见性兜底日志把 `is_visible()` 的 `Err`（窗口已销毁）与 `Ok(false)`（真不可见）混为一谈：用户 800ms 内关窗会留下「on_page_load 未触发？」的误导归因 | `match` 三态分明：`Ok(true)` 不动作 / `Ok(false)` 记「仍不可见」+ `show()` / `Err(e)` 记「可见性查询失败（e）」+ 仍尝试 `show()`（兜底目的与幂等性不变） |
| P3 | token-monitor 全局浮窗刷新钮把 `setLastAt` 放在 `finally`：刷新失败也推进「更新于」时间戳，谎称刚更新过（`refreshBus.fire()` 会如实 reject，无内部吞错） | 改为**成功才推进**（`fire()` 的 resolve 分支），失败保留上一次成功时刻；≥0.5s 旋转反馈不变 |

**回归闸门（desktop 项 18 → 20）**：

1. `syntax injected/theme-init.js` —— `themes/src/*.js` 是 WebView2 **每个文档**都跑的注入
   脚本，分片不是独立语法单元（IIFE 跨片闭合），而 `gen-init` 只验令牌完备性、不验语法；
   注入脚本语法错＝实机整屏黑，这是最廉价的前置闸门；
2. `themes/test/auth-cookie.test.js` **6 例行为闸门** —— 从 `themes/src/00-boot.js` 的
   `@slice:auth-cookie` 标记段截出 IIFE，在 VM 里用假浏览器（cookie jar / sessionStorage /
   真 `crypto.subtle` / `location.reload`）驱动，钉死本轮两条新契约与一条时序契约：
   已有 cookie 只按原值续期、无 cookie 才兜底签名、401 未超限 reload 一次、超限停止并显示
   可见提示、正常文档复位计数、**document_start（body 未解析）不得误清计数**。
   区分力双向验证：回退「不覆写」判据 → 用例 1 红；把上限改 999 → 用例 4 红；还原 → 6/6 绿
   （连跑 5 次稳定）。`themes/test/package.json` 只为 Node 声明 ESM（与 `plugins/*/test` 同约定）。

**验证**：`cargo check --bin miasaki --tests` 通过、无 warning；`node scripts/verify-all.mjs`
七线 **96 项全过**（sidebar 10 / canvas 11 / fleet 15 / desktop **20** / ssh 12 /
dual-model **12** / appearance 16），desktop 内含 `cargo test` 28 例与 6 个补丁自证。
（※ 上列数字是该批次运行时的快照，**不随基线推进改写**；09-24 起现行基线为全量 **98 项**、
desktop **22/22**、`cargo test` **35 例**——见本文件顶部 09-24 各条。）
实机项：熔断行为与兜底日志语义见 `design/auth-cookie-prepinject.md` §5 验收第 6 条。

## 2026-09-23 · 启动链容错加固（可见性兜底转正 + 导航失败可见化）

**起因**：一轮「主窗口不显示 / 黑屏」排查在 `main.rs` 留下 22 处 `[PROBE] eprintln!` 探针 +
一处 800ms 强制 `show()` 兜底。代码审查判定「探针不得入库」，并指出兜底判据用错变量。本轮
逐条核实审查结论（**全部属实**）后收口：探针全清、有价值的一处转正、顺带修掉三处容错缺口。

**核实与处置**：

| 审查结论 | 核实 | 处置 |
|---|---|---|
| 兜底判据借用 `PAGE_UP`，口径错误 | 属实：`PAGE_UP` 语义是「3080 文档加载成功」（`on_page_load` 命中远程 URL 才置位），后端冷启动 3~6s → 800ms 时必为 false，每次启动都误入「强制 show」分支、观测数据失真 | 判据改为 `!is_visible().unwrap_or(false)`（审查建议的字面写法 `!is_visible()` 不成立：该方法返回 `Result`）；触发时写一行 `pet.log` |
| `eprintln!` 在 release 无控制台，探针整体不可见 | 属实：`#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` | 随探针删除消解；转正后的兜底改走 `app_log_line`（`pet.log`），release 亦可观测 |
| 22 处探针不可入库 | 属实 | 全删；含 WebView2 运行时探测（手写 `extern` 声明 + 返回串未 `CoTaskMemFree`） |
| `port_ready()` 落在 setup 同步路径 | 属实：探针在 `start_launch_sequence` 的 spawn 之前同步调用，最坏给启动加 300ms | 随探针删除消解 |
| 导航处 `.expect` × `panic = "abort"` 可杀整个进程 | 属实：`MIASAKI_REMOTE` 非法 → release 直接 abort；同文件后端看门狗却是 `if let Ok(url)` | 抽出 `navigate_main() -> Result<(), String>`；失败 → 落盘 + 状态栏反馈 + `__setRetry(true)` |
| `navigate` 结果仅记日志，失败无反馈 | 属实：失败后界面永远停在「已就绪，正在进入…」 | 同上，纳入 `navigate_main()` 的错误分支 |
| 90s 超时文案把「进程秒退」误归因为端口占用 | 属实：`spawn_dsh` 成功 ≠ 进程存活，而该阶段只试拉一次 | 文案与 `bootstrap.json` detail 并列补上「或 dsh 拉起后立即退出」 |

**转正项**：主窗口可见性兜底（建窗后 800ms 判 `is_visible()`）。其余排查物一律不留——
`run_on_main_thread` 事件循环存活探针、`bootstrap.json` 落盘探针、WebView2 运行时探测等。

**验证**：`[PROBE]` / `eprintln!` 在 `main.rs` 中已归零；`cargo check --bin miasaki --tests`
（MSVC x64 环境）通过，无 warning。实机验收（正常启动窗口显示、`MIASAKI_REMOTE` 非法值不崩、
失败时「重试」按钮可见）待用户执行。

**归档**：探针批次完整差异留在 `_refs/_probe/main-rs-probe-batch-2026-09-23.patch`
（`_refs/` 已 ignore，不入库）；如需继续采样 `git apply` 即复原。

## 2026-09-23 · 构建产物接入代码签名（本地自签 `CN=Miasaki Dev`，SmartScreen 不再拦本机运行）

**起因**：用户双击 `dist/Miasaki.exe` 被 Windows Defender SmartScreen 拦下
（「已保护你的电脑 … 应用: Miasaki.exe 发行者: 发布者未知」），诉求「给 exe 签名」。

**路线决策**（依据微软[代码签名选项对比](https://learn.microsoft.com/zh-cn/windows/apps/package-and-deploy/code-signing-options)
2026-09 版 + Tauri 官方 [Windows 代码签名文档](https://v2.tauri.app/distribute/sign/windows/)）：

- OV 证书 ¥1000–2200/年、EV ¥3000+/年但 **2024 年起 EV 不再即时免 SmartScreen**
  （与 OV 同走发布者信誉积累，EV 溢价失去意义）；
- Azure Artifact Signing（~$9.99/月）**个人账号仅限美/加**，本机用户在国内，不可行；
- Microsoft Store MSIX 是唯一零警告路线，但桌宠常驻壳不适合上架；
- SignPath Foundation 免费需开源项目审核（备选，未申请）。

→ **先落地本地自签名**：免费、当天生效、签名链路与将来换 OV 证书完全通用
（只换 `certificateThumbprint` 一个字段）。

**实施**：

1. 生成自签名代码签名证书 `CN=Miasaki Dev`（.NET `CertificateRequest`，EKU CodeSigning
   `1.3.6.1.5.5.7.3.3`、SHA-256、RSA 2048、10 年期）。本机 `New-SelfSignCertificate`
   不可用（pwsh 7 无 PKI 模块；Windows PowerShell 5.1 亦未装该 cmdlet）→ 改走 .NET API；
2. 证书导入 `Cert:\CurrentUser\{My, Root, TrustedPublisher}`；pfx/cer 归档
   `_refs/miasaki-codesign.pfx`（.cer 同目录；根 `.gitignore` 的 `_refs/` 覆盖，
   **私钥不入库**）；
3. `src-tauri/tauri.conf.json` 的 `bundle.windows` 增加
   `certificateThumbprint: 9A849C22D97999A011E8D9863B005630E977DBD7` +
   `digestAlgorithm: sha256`。tauri-bundler 据此对**每个构建产物**调 signtool
   （`/fd sha256 /sha1 <指纹> /d Miasaki`）：主 exe 与 bundle 内一级 DLL 都签。

**踩坑（均为环境层，非本线代码）**：

- 沙箱 `workspace-write` 下一切证书私钥存储访问被拦（`0x80090010` /
  `Store::ImportCertObject() failed`）——生成 pfx 落盘不受影响，但只要触私钥
  （导入存储、signtool /f、构造带私钥证书对象）即失败；会话提升到
  `danger-full-access` 后全部一次通过；
- `cargo` 不在本会话 PATH（rustup 装在 `%USERPROFILE%\.cargo\bin`）；
- Rust release 编译需 MSVC `link.exe` → 须在 VS 2022 `vcvars64.bat` 环境执行；
- WiX 3.14.1 `light.exe`（.NET）写系统 `%TEMP%` 被沙箱拒
  （`UnauthorizedAccessException`）→ `TEMP/TMP` 指到工作区可写目录可解；
  且 **vcvars 的 `&&` 链里后置 `set TEMP` 会被 setlocal 作用域吞掉**
  （`echo %TEMP%` 实证仍为系统 Temp），须用 bat 文件逐行 `call` 才生效；
- tauri-bundler 找 signtool 走注册表 `Windows Kits\Installed Roots`（本机
  `10.0.26100.0`），也可用环境变量 `TAURI_WINDOWS_SIGNTOOL_PATH` 显式指定。

**验证**：`npm run tauri build`（vcvars64 环境）日志出现
`Signing … with identity "9A849C22…"` → `Successfully signed:
…target\release\miasaki.exe`（WixUtilExtension.dll / WixUIExtension.dll 同签）；
`signtool verify /pa`：签名链 `Issued to: Miasaki Dev / Issued by: Miasaki Dev`，
`File is not timestamped`（自签无 TSA）、`Successfully verified`。

**能力边界（已同步 README「代码签名」节）**：自签只覆盖**本机**。经 IM/浏览器下载
（带 Mark-of-the-Web）的文件在他人机器上首次运行仍可能弹一次 SmartScreen（措辞会变为
显示发布者名）。彻底免提示 = Store MSIX 或 OV 证书 + 积累发布者信誉。

- 触摸点：`src-tauri/tauri.conf.json`（bundle.windows 新增两字段）、`README.md`
  （新增「代码签名（本地自签，2026-09-23 落地）」节，含重新生成证书的 PowerShell）、
  本文件；`_refs/miasaki-codesign.{pfx,cer}`（私钥材料，gitignore）。
- 用户待执行：无（本机已生效）。之后每次 `npm run tauri build` 自动带签。

## 2026-09-23 · 修复图片显示问题：消息画廊多图 tile 宽高比保持（attachment 补丁）+ 桌宠红条只留最新一条

**起因**：用户「看看你现在的情况，修复图片显示的问题」，随三张实机截图：
①桌面壳注入层左上角红条 `MIASAKI-ERR: ResizeObserver loop completed with undelivered
notifications.`；②③消息区多图缩略图变成 62×62 方块（截图现场两幅）。排查结论：

- **图②③不是图标裂了**：那两幅里的空心方框是桌面壳标题栏的「最大化」窗控按钮
  （`themes/runtime.js` 的 `TB_ICONS.max`，10×10 空心矩形 SVG），属正常 UI；
- **真正的图片显示缺陷在 DSH 本体**：`@deepseek-ai/dsh-client-ui-attachment` 的
  MessageImage 画廊把**多图**场景的每张图渲染成固定 `64×64` + `object-fit:cover`
  的方片。宽高比偏离 1:1 的图被裁得只剩一小块——用户实发的 716×34 红条截图只剩
  原图 1/21 被放大显示，完全无法辨认；84×32 / 70×36 小截图同样面目全非。单图场景
  官方本就有 `singleFit`（长边 240 + 比例 clamp），问题只在多图 tile 这一路；
- **红条暴露的是注入层缺陷**：全局 error trap 每次 error 都 `appendChild` 一个**新**
  div、从不清理，反复触发时红条沿屏幕向下堆叠盖住页面（`ERR_COUNT` 已有 hash 诊断位，
  堆叠 div 纯属视觉事故）。

**实施（两处，互不相干）**：

1. **新建第六件本体补丁** [`patches/dsh-client-ui-attachment/`](../patches/dsh-client-ui-attachment/README.md)
   （基线 DSH **0.1.7-alpha.2**，原版 SHA-256 `397B4947…`，产物 `381D2676…`）。
   **纯 CSS 两条唯一子串替换**：tile 定宽 64 → `width:auto;min-width:44px;max-width:220px`
   （高仍 64）；tile 内 img `cover/100%/100%` → 追加 `.R_Yw7q_frame[data-variant=tile] img
   {object-fit:contain;width:auto;height:100%;max-width:220px}`。常规横图 contain 与 cover
   等价（无留白），超宽图完整可见（红条 220×10.5 居中），竖图 clamp 在 min-width 内。
   单图 / 缩略图 / 点开原图三条路均不碰；
2. **桌宠红条单例化**（`themes/src/00-boot.js` + legacy 回退 `themes/runtime.js` 同步）：
   error trap 改为复用同一个 div 更新文本（重入场景由 `parentNode` 判空兜底重建），
   次数随文本 `MIASAKI-ERR[N]:` 暴露。构建产物已由 `npm run gen-init` 重建。

**验证**：补丁 `verify` 三行 PASS（重建逐字节一致 + 语法闸门 + 常量自洽）；`apply` 后
playwright 实机（桌面壳同源 127.0.0.1:3080，带自签 session cookie）复测：三张实测图
tile 由 62×62 分别变为 **220×64 / 165×64 / 123×64**，`object-fit` 全部 `contain`，
无新增 console / page 错误。

- 触摸点：`patches/dsh-client-ui-attachment/{patch.mjs,README.md,baseline/(新两文件)}`、
  `themes/src/00-boot.js`、`themes/runtime.js`（legacy 同步）、`README.md`（补丁总表
  五处 → 六处）、本文件。构建产物 `src-tauri/injected/theme-init.js` 已随 gen-init 更新
  （gitignore 覆盖）。
- 用户待执行：**刷新页面**即生效（client-hmr 500ms 热推或下次加载）；DSH 升级后按
  attachment 补丁 README「DSH 升级后怎么办」重打（`status` → rebuild-baseline → 常量 → verify → apply）。

## 2026-09-23（晚）· DSH 0.1.7-alpha.2 实装后：六个补丁全量重打（EDITS 零改）

**背景**：核查「各条线适配状况」时发现——本机全局 DSH 已实装 **0.1.7-alpha.2**
（`dsh --version` 实测；评估文档触发的「等 0.1.7-rc.*」条件被跳过，直接升了 alpha），
而六个补丁（desktop 五件 + dual-model 图片准入一件）的 baseline 仍是 0.1.5-rc.1，
live 安装目录里它们全部处于 `unknown`（升级覆盖、从未重打）——除 09-23 新生的
attachment 外，其余补丁的修复在运行宿主上实际不在场。按各补丁 README 的升级流程
逐个 `rebuild-baseline` → 同步三常量 → `verify` → `apply`：

| 补丁 | 原版（0.1.7-alpha.2） | 产物 | 锚点 |
|---|---|---|---|
| settings-models | `B2D7D445…`（184,096 B） | `9F2F1EE8…`（199,566 B） | 13 条编辑零改；变体 probe 自动选中 0.1.6+ 分支 |
| conversation | `38326414…`（701,296 B） | `59A185B9…` | 1 条唯一命中 |
| trajectory | `E64C3D03…`（417,494 B） | `4B577822…` | 2 条唯一命中 |
| chat | `CCC14F1E…`（514,483 B） | `1594AC3C…` | 2 条唯一命中 |
| cordis-host-runner | `AC73F866…`（102,835 B） | `D3126110…` | 4 条唯一命中 |
| 图片准入（dual-model 线） | `05DAAAF8…` | `450C25A2…` | 1 条唯一命中（`:780`，`expect` 两行逐字未变；走 `seal` 流程） |

**验证**：六个 `verify` 全 PASS（行为断言含 chat/trajectory 8/8、host-runner 两组反例）；
`apply` 后 `status` 全部 `patched`（`.dsh-bak` 留 0.1.7 原版可回退）；
`node scripts/verify-all.mjs` 全量 **93 项全过**（desktop 17 → 18：attachment 补丁
此前未纳入统一回归，本次补位）。

**生效面**：client 侧四个（settings-models / conversation / trajectory / chat）
**刷新页面即生效**；host 侧两个（cordis-host-runner + 图片准入）**需重启 `dsh web`**
（Node 已加载的模块不热更新；注意重启会断开当前 harness 会话）。

- 触摸点：六个补丁各自的 `patch.mjs`（三常量）+ `baseline/`（0.1.5-rc.1 → 0.1.7-alpha.2）
  + README 基线段、`README.md` 补丁总表基线段、`scripts/verify-all.mjs`（+1 项）、
  根 `README.md` 93 项基线、本文件。
- 遗留实机项：刷页面目检「思考强度 / 测试全部」两控件；重启 `dsh web` 后验证
  dual-model 带图发送放行（union 语义）与 cordis 查询不再挂起；desktop 三插件
  设置注入（免费模型池面板 / 已保存行测试连通性）目检。

## 2026-09-23 · 修复设置页（模型栏）设置：settings 读取双轨适配 DSH 0.1.7（free-model-pool v0.3.1 / model-probe v0.2.1）

**起因**：用户「修复设置页的设置」。本机全局 DSH 已升 **0.1.7-alpha.2**，web profile 正跑该版本；
0.1.7 重写设置机制后设置页模型栏两处坏死，线上实证：

- **免费模型池面板整块报错**：`GET /freepool-api/status` 原样返回
  `{"ok":false,"error":"ctx.settings.get is not a function"}`——0.1.7 把
  `ctx.settings.get(ns)` 在全树移除（0.1.6 有 19 处 → 0.1.7 零处），服务本身
  （`SettingsForms`）还在、`inject: ['settings']` 仍过得去，但读 API 变了；
- **「测试连通性」对已保存行静默退化**：`resolveProfile` 的 `ctx.settings.get(NS)`
  被 try/catch 吞掉 → 存储档案读不到 → `no-credential` / `no-endpoint`。
   Models 页请求体只带草稿值，已保存行的 baseURL / api / apiKeyEnv 全靠这次读。

**实施（两个插件同一破绽、同一修法，各自独立打包故各自一份 helper）**：

- 各新增 `lib/settings-read.js`：`readSettingsSection(ctx, ns)` 按
  `typeof settings.get === 'function'` 探针分轨——≤0.1.6 走 `get(ns)`（已注册命名空间，
  与旧代码逐字同路，含抛错 posture），0.1.7+ 走 `describe().find(d => d.ns === ns).value`
  （profile 条目 Config 投影；`llm-pi-ai` 条目的 `providers` 正是 volatile 字段，
  已核对 0.1.7 快照 `packages/llm/llm-pi-ai/src/config.ts`）；
- `dsh-free-model-pool/lib/index.js`：`listPlatforms` 与 `/apply` 两处读取换_helper；
  写路径 `ctx.settings.update(NS, {providers})` 两代同名同义（0.1.7 深合并进条目 Config
  用户层，只受理 volatile 字段），原样保留；
- `dsh-model-probe/lib/index.js`：`resolveProfile` 换_helper（外层 try/catch 保留——
  设置抖动只许退化探测、不许抛）；
- 版本 bump：free-model-pool 0.3.0 → 0.3.1、model-probe 0.2.0 → 0.2.1（health 路由
  `version` 同步）。

**为什么双轨而不是按版本探测**：与 dual-model 失效信号双轨（`a956776`）同款依据——
cordis 上 `typeof` 一个不存在的方法是 `undefined`，两代宿主各自命中；无条件回退
≤0.1.6 也保住回退路径可测。peerDeps `^0.1.2-rc.1` 的声明债维持 §7.10 既有结论
（`link:`/`file:` 安装不触发 peer 校验），不本次扩范围。

**验证**：新增单测 **27 例**——free-model-pool `test/settings-read.test.js` 10 例
（helper 契约：老路优先 / 未注册 null / 抛错透传 / 新路投影 / ns 缺席 / 服务缺席 /
属性代理抛错）+ `test/routes.test.js` 5 例（fetch 打桩驱动真实 `/status` 与
`/apply` 路由，双世界各一遍，锁定写入形状）；model-probe `test/settings-read.test.js`
12 例（helper 契约 10 + probeModel 存储档案解析接线 2：老路/新路都解析出 profile 的
`api` → `unsupported` 早退不发网）。`node scripts/verify-all.mjs desktop` **11 → 17 项
全过**（新增 6 项检查已并入；cargo test 28/28 同过）。修复前线上实证见上；**实机待
用户重启桌面端后验收**。

- 触摸点：`plugins/dsh-free-model-pool/{lib/settings-read.js(新),lib/index.js,package.json,
  test/(新两文件)}`、`plugins/dsh-model-probe/{lib/settings-read.js(新),lib/index.js,
  package.json,test/settings-read.test.js(新)}`、`scripts/verify-all.mjs`（desktop 段
  +6 检查）、`README.md`（两插件小节）、本文件；
  `../dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.7-upgrade-assessment-2026-09-23.md`
  §7.4 / §10 第 8 项闭环。
- 用户待执行：**重启桌面端（Miasaki.exe）**（或重拉 `dsh web`）使新 host 代码生效。
  本次修复已把 `lib/index.js` / `lib/settings-read.js` / `package.json` 同步进 profile
  顶层 `node_modules` 的 file: 拷贝（哈希已核对一致，file: 拷贝不随工作区自动更新），
  **重启即可、无需重跑 pnpm install**。重启后打开 设置 → 模型：① 页面底部「免费模型池」
  面板应列出已配置平台（不再出现 `ctx.settings.get is not a function`）；② 对任一已保存行
  点「测试连通性」应走出真实探测结果而非 `no-credential` / `no-endpoint`。

## 2026-09-23 · 后端断连自愈：存活看门狗自动重拉 + 关闭时外部客户端保留（**已实施**）

**起因**：用户「刚刚桌面端突然断连了，查查原因；然后断连重连的机制要优化一下」。

**事故复盘（三份日志 + 进程现状坐实，根因不是后端崩溃）**：`pet.log` / `server.log` /
`bootstrap.json` 时间线——11:49:32 桌面端 A 启动并拉起后端 pid 32136；12:06:44 用户在
Quark 浏览器打开 DSH 页面，连的正是这个后端；12:14:52 关闭桌面端 A → `taskkill` 杀死
32136 → 浏览器页面断连；12:14:56 桌面端 B 重启拉起新后端 7208（浏览器自动重连）；
12:15:37 再关 B → 再杀 7208 → 浏览器再次断连；12:15:52 用户手动 `dsh web`（pid 10688，
即当前服务）才恢复。server.log 74 次启动记录中**没有一次运行中崩溃**——断连全部由桌面端
既定契约「关闭应用 = taskkill 停掉本应用拉起的后端」造成，而该后端是**共享服务**，
浏览器等其他客户端正在用。次要缺口：运行期后端一旦因任何原因死亡，此前**无任何恢复手段**
（webview 停在死后端，只能重启整个应用）——2026-09-08 条目已列为「待用户拍板」。

**实施（`src-tauri/src/main.rs` + `Cargo.toml`，默认行为不劣化）**：

- **运行期后端存活看门狗 `start_backend_watchdog`**（启动序列导航成功后与 hash/pulse
  看门狗同批启动）：2s 探测 = 自拉后端进程存活（`OpenProcess(PROCESS_QUERY_LIMITED_
  INFORMATION)` + `GetExitCodeProcess == STILL_ACTIVE`，零子进程开销）+ 3080 TCP 连通。
  恢复两路：自拉后端进程退出且端口无监听 → 自动重拉 `dsh web`（等端口就绪 90s 上限）；
  自拉后端已退出但端口被别的实例接管 → 转「采用」不重拉；采用的外部后端消失 → 接管重拉。
  连续失败退避 2s→4s→8s→16s→30s 封顶；「进程活着但端口没起来」（启动中/僵死）不重复
  spawn（EADDRINUSE 只会让新进程秒退），降频记录。**活页面无需 reload**：DSH 前端自带
  500ms→10s 指数退避重连，鉴权走持久化 HMAC cookie（secret 来自 credentials，后端重启
  不变，RPC/WS 均同源携带）→ 服务器回来后页面自行恢复。仅「文档从未加载成功」
  （`PAGE_UP` 未置位：启动撞上正在退出的旧服务 / 导航中途后端死亡，WebView2 错误页不会
  自行重试）时，重拉成功后补一次重新导航。主动关闭流程（`SHUTTING_DOWN` 置位）看门狗即退。
- **关闭前外部客户端探测 `external_backend_clients`**：`kill_spawned_dsh` 停止后端前，
  用 Toolhelp32 取本应用进程树（自身 + 全部后代，含 WebView2 子进程），`netstat -ano`
  解析**对端端口 3080** 的 ESTABLISHED 连接归属 PID（DSH 页面持有到网关的持久 WebSocket，
  客户端行对端正是 3080；服务端 accepted 行本地才是 3080，不计入——否则判据恒真），
  剔除进程树后仍有剩余 → **保留后端不杀**并落日志；无人用 → 照旧 taskkill。探测失败
  （netstat 起不来）→ false 回落历史语义，最坏不劣化。
- **可观测**：pet.log 新增 `backend-watchdog:` / `close: 后端 pid … 仍有外部客户端 …
  → 保留不停止` 两类日志行，断连事故下次可直接从日志复盘。

**验证**：`cargo test --bin miasaki` **28/28**（新增 3 项：netstat 对端端口解析——
服务端 accepted 行排除 / 客户端行去重保序 / IPv6 与无关端口；进程树过滤；退避封顶）；
`node scripts/verify-all.mjs desktop` **11/11**（含 cargo test）；真实 `netstat` 输出
端到端模拟——当前机器正确识别出 Quark 浏览器（pid 38120）为外部客户端。release 构建与
实机验收待用户（杀后端自愈 / 带浏览器关闭保留后端 / 冷启动 5 连发零回归）。

- 触摸点：`src-tauri/src/main.rs`（新增约 300 行：常量/静态/判活/进程树/netstat 解析/
  看门狗/关闭保留 + 3 项单测；`kill_spawned_dsh`、`shutdown_app`、`port_ready`、启动序列、
  `on_page_load` 改动）、`src-tauri/Cargo.toml`（windows-sys 增 `Win32_System_Threading` /
  `Win32_System_Diagnostics_ToolHelp` 两特性）、`README.md`、`design/ARCHITECTURE.md`
  （§1 树 + §2 决策两行）、`design/themes.md` §3、`design/TODO.md`、本文件。
- 用户待执行：`cargo build --release` 后用 `src-tauri/target/release/miasaki.exe` 替换
  `dist/Miasaki.exe`（用户快捷方式目标），重启桌面壳。验证点：①终端 `taskkill /PID <后端pid>`
  后桌面端应在数秒内自愈、页面自动重连（pet.log 见 `backend-watchdog: 后端已恢复`）；
  ②浏览器开着 DSH 页面时关闭桌面端 → 后端保留、浏览器不断连（pet.log 见「保留不停止」）；
  ③无浏览器时关闭 → 后端照常停止。

## 2026-09-23 · token-monitor v0.5.2:全局浮窗头部新增「刷新」钮

依据:用户「总用量统计页这里,右上角退出图标右边加一个刷新图标,点击可刷新总用量统计页面」。

- **位置与形态**:全局浮窗头部在**关闭钮左侧**新增 30px 圆形图标钮(`.tokmn-iconbtn`,
  与关闭钮同款 hover/圆角),14px 旋转箭头 SVG(270° 圆弧 + 上指箭头,
  `stroke: currentColor`),`aria-label` / `title` 均为「刷新」;关闭钮仍居最右。
  **位置修正**(交付后用户实测反馈「放反了」):初版按「退出图标右边」字面放在关闭钮
  右侧,不符合「关闭居最右」的常规收尾布局,已对调为刷新在左、关闭在右。
- **位置再修正**(第二轮实测「位置放退出按钮旁边」):`margin-left:auto` 当时挂在
  关闭钮上 —— flex 把剩余空间加在关闭钮**之前**,刷新钮连同标题一起留在左端、
  两钮被隔开。已把 auto margin 挪到**刷新钮**:视觉
  `[标题][meta] ………… [刷新][关闭]`,两钮紧挨、关闭居最右。
  **教训:flex 里 `margin-left:auto` 挂谁,谁及其后续元素才被推向右端。**
- **刷新反馈**(第二轮实测「刷新按钮没反应」):并非逻辑失效 —— 数据本就有 5s 自动
  轮询,手动重拉视觉上零差异,且本地请求毫秒级完成、旋转一闪而过,用户感知不到
  「点了有反应」。两处强反馈:①点击后图标保证 ≥0.5s 旋转
  (`Promise.all([fire(), minSpin])`,旋转时长不依赖请求耗时);②头部 meta 追加
  「更新于 HH:MM:SS」(点击完成即记,`toLocaleTimeString` 对齐会话 Tab 口径)。
  失败路径同样复位、同样记时,不吞错。
- **行为**:点击立即重拉 `/dsh-token-monitor/global` 与 `/dsh-token-monitor/heatmap`
  两个数据源,不必等 5s / 60s 轮询周期;两条轮询本身不变(刷新只是提前),浮窗关闭
  (组件卸载)即停的契约不变。
- **实现**(零新依赖,沿用 `overlayStore` 的模块级极简发布订阅风格):新增
  `refreshBus`(`fire()` 汇合各订阅方返回的 Promise,`subscribe()` 返回退订函数);
  `GlobalStatsContent` 订阅后调用 `loadGlobalRef.current()` + `loadHeatmapRef.current()`
  并返回 `Promise.allSettled`,驱动头部按钮的 `refreshing` 态;图标加
  `.tokmn-spin`(`@keyframes` 纯 transform 旋转,请求失败也一并复位)。订阅随
  `useEffect` 清理自动退订,浮窗关闭时数据组件卸载、订阅即失效,无泄漏。
- **边界**:刷新纯客户端行为,不改任何 host 侧路由/账本口径;`Promise.allSettled`
  兜底单源失败不影响另一源。
- 触摸点:`plugins/dsh-token-monitor/lib/client.js`、`package.json`(0.5.1 → 0.5.2)、
  `README.md`、`cordis.patch.yml`(注释)、本文件。验证:
  `node plugins/dsh-token-monitor/scripts/verify-client-bundle.mjs
  plugins/dsh-token-monitor/lib/client.js --sync` 全部通过(语法 + react stub
  factory 执行 + profile 安装副本同步);client 半按请求读盘,**刷新页面即生效**。

## 2026-09-22 · 拖拽上传附件到会话（Tauri 默认拖放处理器拦截，设计定稿，未实施）

- **起因**：用户「桌面端现在缺少拖拽上传附件到会话」。
- **定性**：不是缺功能——官方 Web 端早有完整拖放上传（`dsh-client-ui-attachment`
  的 document 级 `dragenter/dragover/dragleave/drop` + `DropOverlay` 全屏遮罩，
  `intakeFiles` 与纸夹按钮同路做限额预检，`dsh-client-file-upload` 流式上传）。
  桌面端拖文件进主窗口**静默无效果**（光标显示 copy、松手无反应）。
- **根因**（查 registry 源码逐层坐实，tauri 2.11.5 / tauri-runtime-wry 2.11.4 /
  wry 0.55.1）：`drag_drop_handler_enabled` 默认 true → wry 注册 handler 时先
  `SetAllowExternalDrop(false)` 关掉 WebView2 自身外部拖放、再
  `RegisterDragDrop`（OLE `IDropTarget` 挂上 WebView2 子 HWND）→ 页面级 HTML5
  DnD 被整体拦成 `tauri://drag-drop` 窗口事件；本壳零监听（全仓 grep 零命中）→
  drop 静默丢失。
- **修法（主）**：`main.rs` 主窗 builder 加 `.disable_drag_drop_handler()`——tauri
  官方注释原话 *"required to use HTML5 drag and drop APIs on the frontend on
  Windows"*。之后 WebView2 原生拖放直达页面，官方链路全量复用（零补丁、零
  capability、DSH 升级无忧）。
- **配套（必做）**：官方 document 级监听只活在对话视图（composer 挂载期间）；
  其他页面（轨迹/用量/设置/启动页）drop 落空会触发浏览器默认 `file://` 导航、
  **炸掉整个 SPA**。故加注入层安全网 `themes/src/09-dropguard.js`（新片进
  `MANIFEST.json` order）：只拦文件拖放、`defaultPrevented` 判据精准让位官方、
  `dragover` 必阻止（否则 drop 不触发）、非文件拖放完全不碰；`ui/loading.html`
  加最小防默认。
- **验收**：实机十项（对话页拖图端到端 / 混合多文件 / busy 拒绝态 / 子代理拒绝 /
  非文件拖放无反应 / 轨迹等页 SPA 不被导航走 / loading 页无副作用 / 超限 toast /
  窗口拖动与主题回归 / verify-all + smoke §0b）。
- 触摸点（预期）：`src-tauri/src/main.rs`、`themes/src/09-dropguard.js`（新）+
  `themes/src/MANIFEST.json` + `npm run gen-init`、`ui/loading.html`、
  `design/drag-drop-attachment-upload.md`（新）、`design/TODO.md`（P2 新条目）、
  README、本文件。设计：`design/drag-drop-attachment-upload.md`。

## 2026-09-22 · 鉴权 cookie 预置注入（401 恢复链失效修复，**已实施**）

**起因**：用户「启动后总出错，要点一下刷新才能正常使用」。错误长相确认为**「浏览器样式的
页面」**= 401 纯文本页（`text/plain`：`dsh web authentication required; reopen the URL printed
by dsh web.`）在深色窗口里的裸露渲染。**实测坐实**：① 无 cookie 请求 3080 必然 401；② 硬编码
secret 与 `~/.dsh/.credentials.yaml` 仍一致（所以手动刷新即好）；③ 9-05「401 检测→自动
reload」恢复链对 text/plain 文档的 `body.innerText` 检测无保证 + 只查两次，漏检即永久停住。

**实施（三处，与设计 `auth-cookie-prepinject.md` 逐条对应）**：

- **主修 · 预置注入（`ui/loading.html` + `main.rs`）**：cookie 签名从「3080 页面加载后」提前到
  **navigate 之前**——loading 页 DOMContentLoaded 起 Web Crypto 签名（secret 经
  `invoke('auth_secret')` 从 `credentials.yaml` 动态读，手写 yaml 行解析，失败回落硬编码
  b64url 兜底），`invoke('set_auth_cookie')` 交 Rust 用 Tauri 2 `WebviewWindow::set_cookie`
  写入 WebView2 cookie jar（domain 127.0.0.1 / Path / SameSite=Strict，session cookie；
  3080 文档内 00-boot.js 同名写入会把它升级为 30 天持久 cookie）。`port_ready()` 后 navigate
  前 `wait_auth_cookie(3s)`（50ms 轮询，超时放行 fail-open）。两个 invoke 均为 **async 命令**
  （Webview2 cookie API 在同步命令里死锁，wry#583）。效果：首次 `GET /` 即带有效 cookie，
  401 不发生。
- **兜底加固（`themes/src/00-boot.js`）**：三级文本兜底（`body.innerText` → `body.textContent`
  → `documentElement.textContent`）+ 四轮检查（立即/100/400/1200ms）+ 文案加宽
  （`authentication required` / `reopen the URL printed`）。预置生效时此链不触发。
- **顺手清掉 TODO P1「secret 动态化」遗留项**：轮换后不再要改源码重编译（已并入本链路）。

**验证**：`node --check` + gen-init 重生成（79KB，9 片，令牌校验通过）；`verify-all desktop`
**11/11 EXIT=0**（含 cargo test 25/25）；`cargo check --bin miasaki --tests` 干净通过（0 警告——
cookie 0.18 的 `finish()`→`build()` 顺手修正）。**实机项待用户验收**（冷启动 5 连发无 401 /
secret 改文件后仍免 401 / credentials 缺失不劣化 / 注掉预置后兜底链 ≤1.2s 自愈）。
**部署**：`cargo build --release` 后 `target/release/miasaki.exe` → 替换 `dist/Miasaki.exe`
（用户快捷方式目标），同 9-05 修复流程。

- 触摸点：`src-tauri/src/main.rs`（`auth_secret` / `set_auth_cookie` 命令、`AUTH_COOKIE_READY`
  原子位、navigate 前等待、invoke_handler 注册）、`ui/loading.html`（预置签名 IIFE）、
  `themes/src/00-boot.js`（兜底加固）+ `src-tauri/injected/theme-init.js`（gen-init 重生成）、
  `design/TODO.md`、`README.md`、本文件；设计：`design/auth-cookie-prepinject.md`。

## 2026-09-22 · 鉴权 cookie 预置注入（设计定稿）——同日已实施，见上一条

- **起因**：用户「启动后总出错，要点一下刷新才能正常使用」。错误长相确认为**「浏览器样式的
  页面」**= 401 纯文本页在深色窗口里的裸露渲染。**实测坐实**：无 cookie 请求 3080 必然 401
  （`text/plain`，body = `dsh web authentication required; reopen the URL printed by dsh web.`），
  硬编码 secret 与 `~/.dsh/.credentials.yaml` 仍一致（所以刷新即好）。
- **根因**：9-05「401 检测→自动 reload」恢复链治「401 之后」，当前失效于两个脆弱点——
  text/plain 文档的 `body.innerText` 检测无保证 + 只查两次（漏检即永久停住）。
- **主修（根治）**：cookie 签名与写入**提前到 navigate 之前**——loading 页用 Web Crypto 签名 →
  `invoke('set_auth_cookie')` → Rust 经 Tauri 2 cookie API 写入 3080 域；`port_ready()` 后
  navigate 前等待置位（50ms 轮询 / 3s 超时放行，**fail-open 不劣化**）。首次 `GET /` 即带
  有效 cookie，401 不发生。Rust 不实现签名算法（零新 crate / 零 FFI），name/value 由 JS 算。
- **合并 P1 待办「secret 动态化」**：`invoke('auth_secret')` 由 Rust 手写 yaml 行解析读
  `credentials.yaml`（失败返 null 回落硬编码），secret 轮换后不再需要改源码重编译。
- **兜底加固**（`00-boot.js`）：检测文本三级兜底（body.innerText → body.textContent →
  documentElement.textContent）、检查四轮（立即/100/400/1200ms）、文案匹配加宽。
- **验收**：冷启动 5 连发无 401 / secret 改文件后仍免 401 / credentials.yaml 缺失不劣化 /
  预置注掉后兜底链 ≤1.2s 自愈 / smoke §0b 与 verify-all desktop 回归。
- 触摸点（预期）：`ui/loading.html`、`src-tauri/src/main.rs`（两 invoke + 原子位 + navigate 前等待
  + cookies API）、`themes/src/00-boot.js`（+gen-init 重生成）、`design/TODO.md`、`README.md`、本文件；
  落地需 `cargo build --release` 替换 `dist/Miasaki.exe`。设计：`design/auth-cookie-prepinject.md`。

## 2026-09-22 · 启动加载 2.0 + cmd 闪窗根治（设计定稿，未实施）

- **起因**：用户「现在的启动加载界面太简单不符合本项目」「每次启动都会闪过终端窗口」
  「我觉得加载页直接把这个启动终端代码内置，弄酷炫一点」。同一需求的 appearance 半
  （DSH 首帧启动画）见 appearance 线 `design/2026-09-22-appearance-boot-splash-design.md`；
  两线契约见 `../dsh-miasaki-shared-docs/cross/boot-loading-2026-09-22.md`。
- **闪窗先归因再修**（不拍脑袋）：嫌疑矩阵四条——S1 cmd 自身控制台分配（CREATE_NO_WINDOW
  理论已治）/ S2 dsh.cmd 批处理链 / **S3 dsh 本体孙进程（最可能，CREATE_NO_WINDOW 不遗传）** /
  S4 WebView2 GPU 进程创建视觉误判。验证法 = Process Monitor 抓 Process/Thread 创建链
  （conhost 创建者 + 时间戳）。修法首选 **F1：解析 npm shim 直达 `node <@deepseek-ai/dsh/lib/bin.js>
  web --no-open`**，绕开 cmd 整层（本机实测 shim 形态已记录）；F2 孙进程级修复需动 dsh 本体，
  单独拍板不预支；**F3：解析失败静默回落现行 cmd 链，零回归**。
- **「启动终端代码内置」= stdout tee**：`spawn_dsh()` 的 stdout 从「直接重定向 server.log 文件句柄」
  改为 piped + 行泵（每行一份 append 落盘、一份 eval 推页 `window.__appendLog`），页面侧内嵌
  终端风日志流（环形缓冲 500 行 / 自动滚动 / 三级着色 / 默认折叠计数徽标，失败自动展开）
  + 四阶段进度（探活→拉起→等待→就绪）。新钩子只增不改：`__appendLog` / `__setPhase`，
  `__setStatus` / `__setRetry` 契约冻结。安全：行内容 JSON 转义后 eval（禁拼接防注入）。
- **视觉**：延续三主题纹章 DNA + Mica 策略，新增纹章旋转/扫描线/打字机光标/节点脉冲
  （全部 transform/opacity 纯 CSS，reduced-motion 全降级）；与 bootstrap-reliability 的
  失败卡片/诊断按钮/落盘链路零改动（日志流只做失败现场的补充入口）。
- **实施顺序**：S1 归因 → S2 F1 修法 + F3 兜底 → S3 tee 管道 → S4 loading.html 2.0 → S5 实机
  验收七项（闪窗 5 连发 / 日志流 / 失败零回归 / 兜底回退 / 性能 / 降级 / smoke 回归）。
- 触摸点（预期）：`src-tauri/src/main.rs`（`spawn_dsh` + 行泵 task + `__appendLog`/`__setPhase`）、
  `ui/loading.html`（日志流 / 阶段进度 / 动效）、`design/boot-loading-terminal.md`（新）、
  `design/TODO.md`（P2 新条目）、`README.md`、本文件、cross 契约（新）。

## 2026-09-22 · 设置页「模型」增强三件套 + 免费模型池合体（补丁 v3 / 插件 v0.2.0 / v0.3.0）

**起因**：用户「设置页里的模型页优化一下，还有功能加强一下，现在配置模型会失败，查查原因」。

**「配置模型失败」根因不在模型页**：经 `/api` RPC 直连实测，官方写入链路完全正常
（`settings.mutate` 整数组 set ok、思考强度字段过 schema、目录探测 ok）。真正的崩溃是
`@miasaki/dsh-dual-model` 控件：`props.useInput()` **无 selector 调用**触发
`TypeError: l is not a function`（bundle 11727 行 = `useSyncExternalStoreWithSelector`
内的 `selector(...)`；runner 的 `bindSnapshotSelector` 无 identity 兜底）。
修复与实测见 dual-model 线 CHANGELOG 同日条目；输入状态字段名同步由 `imageIds`
更正为 `attachmentIds`。

**模型页本体三处增强**（`patches/dsh-client-ui-settings-models/`，EDITS 7 → 13 条）：

| 项 | 内容 |
|---|---|
| 无 Key 引导 | 缺 key 行的小点 tooltip 与环境变量名（`API 密钥缺失（OPENROUTER_API_KEY）`）；编辑卡片密钥区下方一行可操作提示（点名 ref + 后果）。针对实测短板：openrouter 配了 21 个模型但 `OPENROUTER_API_KEY` 未配置，此前整页只有一个灰点 |
| 思考强度可读化 | 「继承提供方默认」选项显示**当前生效值**（未声明 / 具体等级）——`catalogProps` 新增 `reasoningDefaultOf(id)` 解析器（按 id 查解析后命名空间值的同 id 条目），标签由模块级 `reasoningInheritLabel()` 生成。不猜用户看不见的默认值 |
| 批量测试 + 能力徽标 | 模型列表头「获取可用模型」右侧新增「测试全部」（顺序跑探针，逐行出结果）；容量区行首渲染**视觉 / 推理**徽标。徽标数据来自 model-probe 插件新路由 `POST /model-probe-api/capabilities`（v0.2.0，读 `llm.resolveModelInfo`，零提供商请求、免凭据、缺元数据不猜），路由 404 时静默无徽标 |

**免费模型池合体（C 项，零补丁改动）**：baseline 0.1.5-rc.1 的 models section 本就声明并渲染
`settings.models.footer` 列表槽 —— `dsh-free-model-pool`（v0.3.0）改为**优先注册到那里**
（与模型页合体、少一个设置栏），footer 注册失败（补丁缺席）才回退自有 `settings.section`；
两目标互斥、失败日志只记一次。

**踩坑记录**（都被工具链当场拦住）：① 字典新增词条后，原末行缺尾逗号、且新行的逗号必须写在
**字符串内部**（`assertDictionaryContinued` 两连拦）；② 密钥失败段是 children 数组最后一个
元素（无尾逗号），不能简单后插——改插它前面（`vm.Script` 语法闸门拦下 `Unexpected identifier`）；
③ 误用 replace_all 改 options 行差点删掉整个等級数组，且留下 `',,` 稀疏空洞
（`applyPatch` 的稀疏守卫会炸）。**教训：EDITS 的多行改动优先用「拆首行 / 插前面」，
不要整句 replace_all。**

**验证**：`node patch.mjs verify` 三行 PASS（13 条编辑，golden `7D7D8494…` 154,284 B）；
`resync` 落安装目录后首页 bundle（rev `77f6f2945c12`）九项新功能字符串全量命中；
`verify-all.mjs desktop` 11/11 PASS（model-probe 单测 18 → 20 例，新增 capabilityFlags 两例）。
**待用户执行**：刷新页面（client 半 HMR 已推）；**重启 `dsh web`** 后 capabilities 路由激活、
徽标开始显示（重启前按钮/提示/思考强度均已可用，徽标静默缺席属预期降级）。

触摸点：`patches/dsh-client-ui-settings-models/{patch.mjs,README.md,baseline/client.patched.js}`、
`plugins/dsh-model-probe/{lib/index.js,test/probe.test.js,README.md,package.json}`（v0.2.0）、
`plugins/dsh-free-model-pool/{lib/client.js,package.json}`（v0.3.0）、`README.md`、本文件。
另见 dual-model 线同日条目（「配置模型失败」的真正根因）。

## 2026-09-22 · session-log-move v0.1.1：官方接管后停止注册冲突刷屏

**起因**：排查「设置 → 模型」相关故障时发现控制台被 `dsh-session-log-move:
header register failed` 刷屏（每次页面加载约 25+ 条，持续 30s 重试窗口）。

**根因**：DSH 0.1.5-rc.1 起官方自带 `@deepseek-ai/dsh-session-log-export`（bundle 内 id `Z8`），
已自行注册 `conversation.session.header.utilities` 的 `session-log-download` 条目——
本插件「同 id 替换隐藏官方按钮」的做法从此**永远冲突**（`already has an entry …
registered by Z8`）。旧代码把每次失败都 `console.error`，叠加 60 次 × 500ms 重试，
刷屏掩盖真正的问题。

**修复**（`plugins/dsh-session-log-move/lib/client.js`，v0.1.1）：
- 「重复 id」判定为**永久失败**：`headerPermanentlyBlocked` 后不再重试；
- 失败日志整个 fiber **只记一次**（`headerErrorLogged`），slot 未声明的短暂窗口仍允许重试；
- 轨迹页 DOM 注入（MutationObserver + 重试）逻辑不变；官方按钮可见性随官方包，
  本插件不再试图隐藏（也隐藏不了）。

**验证**：真实 GUI 重载后该插件的错误从 ~25 条/次降至 0–1 条；bundle 内容核对
（`headerPermanentlyBlocked` 在场）确认 host 吐出的已是新版。
同步方式：file: 依赖在 profile 顶层是普通拷贝——已 `cp` 覆盖
`%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-session-log-move/lib/client.js`。

## 2026-09-21 · 软件头像 → 启动器图标（appearance 线跨线消费）

**起因**：用户「外观设置里要可以设置软件头像，比如这个」（附图），澄清后落点是**桌面壳的启动器图标**
（任务栏 / 窗口 / 托盘那一处）。上传与存储由 appearance 线负责（见该线 CHANGELOG 同日 M2.5 条目），
本文是消费端 —— 这也是 desktop 线第一次**读别的线的配置**。

- **新增 `src-tauri/src/launcher_icon.rs`**（含 6 例单测）
  - **契约解析**：dshHome（非空白 `$DSH_HOME` 优先 → `%USERPROFILE%\.dsh`，与官方
    `dsh-home-paths` 同口径）→ `<dshHome>/miasaki-appearance/config.json` 的 `avatar.source`
    → 白名单文件名（复刻 JS 侧 `^[\w][\w.-]{0,80}\.png$` + percent 解码 + 单段路径）。
  - **图片**：`png` crate 解码（**零新依赖** —— 桌宠图集本就在用）→ 中心裁方（图标必须是方的，
    非方图会被系统拉伸）→ 超过 256px 时盒式降采样 → `Image::new_owned`。
  - **应用**：`window.set_icon` + `app.tray_by_id("main-tray")` 取回句柄后 `set_icon`
    （任务栏图标跟窗口图标走）。
  - **跟随**：1.5s 巡检（与既有 pulse / hash 巡检同范式），幂等键 = 文件名 + mtime + 大小；
    选轮询而非页面推 hash，是因为头像本质是**文件态**（用户可能直接换 `avatars/` 里的文件，
    页面没开着也要生效）。
  - **失败姿态**：配置损坏 / 文件缺失 / 解码失败 → 一行日志 + 回退出厂图标，**绝不阻断启动**。
- **接线**：`main.rs` 的 setup 中，托盘 build 之后 `apply()` 一次（首次生效不等巡检）+
  `spawn_watcher()`。出厂未设置时是 no-op（回退默认图标并去重），对既有外观零影响。
- **验证**：`cargo check --bin miasaki --tests` 通过；`cargo test --bin miasaki`
  **25 例全过**（新增 6：白名单一致性、百分号解码与坏转义不 panic、中心裁方取中、
  降采样尺寸与颜色、坏 PNG 报错不 panic、源串解析）。**实机（上传 → 任务栏图标跟随）
  待重启桌面壳后验收**。
- **边界（明确不做）**：EXE 内嵌图标与桌面 / 开始菜单快捷方式的静态图标是构建期资源
  （`make-icons.mjs` + `npx tauri icon`），运行时改不了；本模块改的是运行中的窗口与托盘图标。
  该边界已写进 DSH 面板文案，避免用户误判成 bug。
- 触摸点：`src-tauri/src/launcher_icon.rs`（新）、`src-tauri/src/main.rs`、`README.md`、
  `../dsh-miasaki-shared-docs/cross/appearance-launcher-icon-2026-09-21.md`、本文件。

## 2026-09-21 · 模型设置补丁 v2.2：双代变体（同时支持 0.1.5-rc.x 与 0.1.6-alpha.2）

**起因**：官方仓库增量复查发现 `0.1.6-alpha.2` 上 `patches/dsh-client-ui-settings-models/` 的
第 5 条编辑锚点失效 —— `editCapacity(index, "maxTokens", event.target.value);` 命中 0 次。
根因是官方把 model row 抽成了独立组件 `ModelRow.tsx`（该文件 `0.1.6-alpha.2` 才有、alpha.1 还没有），
容量字段的渲染随之搬进组件内部，回调签名也从 `(event) => event.target.value` 改成 `(text) => text`。

- **难点是跨作用域，不是找新锚点**：`testing` / `testResults` / `testModel` / `patch` / `t` / `disabled`
  全在 `ModelListEditor` 里，而渲染位置在 `ModelRow` 内部、props 契约是官方的。
- **解法**：`EDITS` 支持**变体**（`variants` + `probe`），edit #5 分两代分支。新版走
  「Editor 侧把两块 UI 渲染成一个 `Fragment`（闭包仍在 Editor）→ 作为 `reasoningRow` prop 传给
  `ModelRow` → `ModelRow` 把它摆到容量字段之后」。跨组件传的是**已渲染好的节点**，不是状态函数。
- **`patch.mjs` 的改动**：拆出 `resolveEdits()`（选变体）与 `applyOne()`（施加单条编辑），
  `applyPatch` 对单条/变体两种形态统一处理；入口守卫（稀疏数组、字典尾逗号）递归覆盖子编辑。
  **单条形态完全向后兼容**，其余 6 条编辑与另外 4 个补丁一字未动。
- **零回归**：两份 baseline 与三个常量均未变（官方原版仍是 0.1.5-rc.1），legacy 分支逐字节不动，
  `verify` 三行 PASS 照旧（`F1717A07…`）；`verify-all.mjs desktop` **11/11**。
- **实测覆盖两代**：`0.1.5-rc.2`（当前 `latest`）与 `0.1.6-alpha.2` 的真实 npm 产物上 `apply` 均成功；
  alpha.2 产物 140,442 → 150,544 B，`reasoningRow` 落在 props（L889）与渲染槽位（L266，
  容量字段 map 与 `ModelInputTypes` 之间），7 条编辑的注入件全部到位。
- **两条踩坑记录**（都撞在 `applyPatch` 出口的语法闸门上）：① 锚点不能选 `onFieldChange` ——
  `ModelRow` 被两个编辑器共用，该锚点在 bundle 里命中 2 次；② `}, field)), (0, jsx)(ModelInputTypes, {`
  这行插不进独立行（行内同时装着上一项的收尾与下一项的开头），必须用 `replaceLine` 整行重写。
  详见补丁 README 的「双代变体」节。
- 触摸点：`patches/dsh-client-ui-settings-models/patch.mjs`、该目录 `README.md`、本文件。

## 2026-09-19 · 模型连通性探测 v2（「测试连通性」改问对的问题）

**起因**：用户在设置 → 模型里对 `step/step-5-preview`（StepFun Step Plan）点「测试连通性」，
得到 `https://api.stepfun.com/step_plan/v1/models?limit=1000 answered 401; check the API key`，
但同一模型的对话完全正常。根因不是 key：v1 按钮复用官方**目录探测**
（`GET {baseURL}/v1/models`），问的是「网关能不能列出模型目录」，而按钮语义是
「这个模型能不能用」——Step Plan 只兼容 `POST /v1/messages`，对 `/v1/models` 回 401。
v1 设计稿 §6.2 早已写明「不能因 A 档失败就认为不通」，但 B 档与六分类当时未落地。

- **新增 host 插件 `plugins/dsh-model-probe/`**（host only，无 client 半侧、不注册 slot）
  - 路由：`POST /model-probe-api/probe`、`GET /model-probe-api/health`，
    经 `ctx.webServer.register` + `ctx.effect` 注册；`inject: ['settings', 'webServer']`。
  - **两段式探测**：① 握手档发必然被参数校验拒绝的请求（空 `messages` / 空 `input`）——
    401/403 = key 坏则**当场结束、零 token 消耗**；400 = 鉴权已通过、端点存在；
    ② 仅在鉴权通过后发 `max_tokens: 1` 的生成请求确认端到端可用。
  - **结果类别**：`ok`（附耗时）/ `unauthorized` / `model-missing` / `quota` /
    `rate-limited` / `timeout` / `unreachable` / `bad-request` / `server-error` /
    `unknown` / `unsupported` / `no-credential` / `no-endpoint` / `no-model`。
    host 只回稳定 `kind`，**文案在客户端本地化**（中英各一份），两语言不会漂移。
  - **协议**：`anthropic-messages` 用 `POST {root}/v1/messages`（`root` 去尾 `/v1`，
    与 `dsh-llm-pi-ai` 的 `listingUrl()` 同规则——探测路径必须与真实对话路径一致）；
    `openai-completions` → `/chat/completions`；`openai-responses` → `/responses`；
    其余协议回 `unsupported` 且不发请求。
  - **凭据**：表单临时 key → `credentials.resolve(apiKeyEnv)`（`.credentials.yaml`，
    Models 页写入处）→ 进程环境变量。注意 v1 的 `process.env` 单路径在本机**本来就取不到
    step 的 key**（它存在 `.credentials.yaml`），这也是新插件必须接 credentials 服务的原因。
  - **安全**：Host/Origin/`sec-fetch-site` 三层信任栅栏（与 sidebar、canvas 同构）；
    响应 `detail` 两遍脱敏（精确 key + `sk-`/长串通配）；无副作用（不改配置、不写文件）。
  - **快照式设计**：`lib/probe.js` 承载全部纯逻辑（URL/请求体构造、状态分类、脱敏、截断），
    `lib/index.js` 只做装配 —— 于是判定表能被 18 例单测完整覆盖而不碰网络。
- **补丁升级 `patches/dsh-client-ui-settings-models/`**（仍是 7 条编辑，内容变化）
  - edit #1 追加 `describeProbe()`（结果类别 → 本地化文案）与 `probeViaHost()`
    （调 host 路由；非 200 / 非 JSON / 网络失败一律返回 null）。
  - edit #3 `testModel()` 改为**先** `probeViaHost`、返回 null 时**降级** `discoverModels`，
    降级文案尾附「探测服务未就绪，已回退目录探测」——因此插件是补丁的**可选**依赖。
  - edit #6/#7 词条 7 → 22（新增 13 条类别文案 + 降级提示）。
  - 产物 `144,576 B / E602C1F1…` → `148,922 B / C6C1DCBC…` → **`148,924 B / F1717A07…`**
    （中间那一版语法非法、曾导致整页插件不注册，见下方「同日补记」；**当前生效的是最后一个**）；
    官方原版未变
    （`138,937 B / A60FD863…`），故只换 `PATCHED_SHA256` 与 baseline 产物。
  - `patch.mjs` 新增**稀疏数组守卫**：编辑规则里的 `[a,,b]` 语法合法却会留 `undefined` 空洞，
    随后在几百行之外以 `Cannot read properties of undefined (reading 'trim')` 炸开
    （本次实际踩到，`node --check` 放行）。现在当场报出可读错误。
- **验证**：插件单测 18/18；`node patch.mjs verify` PASS（由官方原版重建逐字节一致）；
  `node scripts/verify-all.mjs desktop` **11/11**（新增插件语法 2 项 + 判定表 1 项 + cargo 19 例）。
- **待办（实机项）**：profile 安装插件 + host 重启后，`step/step-5-preview` 应显示绿色
  「可用 · Nms」；错 key 应显示「认证失败」且零消耗；错模型 ID 应显示「模型 ID 未注册」；
  停用插件应看到降级文案。设计见 [`model-probe-v2.md`](model-probe-v2.md)。

### 同日补记 · 补丁产物语法事故与**语法闸门**（v2 → v2.1）

**现场**：浏览器 `Failed to load plugins`，`@deepseek-ai/dsh-client-*` 全系 + 5 个自研插件
一起 `loaded without registering`；控制台 `Unexpected identifier 'testProbeOk'`。
**不是崩溃而是"整页插件全灭"** —— 这是多包合并 client bundle 的失效形态。

**根因**：v2 的 locale 字典（edit #6/#7）在 en / zh 各漏一个**尾逗号**。注意本补丁的写法约定：
发出的逗号写在**字符串内部**（`'\t\t\tkey: "value",'`），行尾那个逗号只是数组元素分隔符 ——
少写"内部那个"，产出就是缺分隔符的 JS：`testReachableNotListed: "…"` 紧跟 `testProbeOk: "…"`。

**为什么规则错了却没被拦住**（这条比事故本身更重要）：当时的 `verify` 只做
「由 original 重建 == baseline 产物」的逐字节比对，它证明的是**可复现**、不是**合法**。
规则错、产物错、golden 也错，三者一致 ⇒ `verify` 照常 PASS、`apply` 照常写入。
`node --check` 当时也不会被想起——它对**另一个**包（cordis）才有。

**修复与补强**（`patches/dsh-client-ui-settings-models/`）：
- 补回两个逗号；产物 `148,922 B / C6C1DCBC…` → **`148,924 B / F1717A07…`**（官方原版未变）。
- **语法闸门**：`applyPatch` **出口**强制 `vm.Script` 解析（按经典脚本目标，与该 bundle
  `window.__ModuleLoader__.load({…})` 的真实加载路径一致，报出的行号可直接对回文件）。
  放在纯函数出口 ⇒ `verify` / `apply` / `rebuild` 三条路径自动继承，无第二条路能把非法产物写进安装目录。
- **字典结构不变量**：`replaceLine`（一行 → 多行字典展开）除末行外每行必须有尾逗号，
  在入口当场点名「哪条编辑的第几行缺尾逗号」——语法闸门能兜住，但 V8 报的是几百行外的裸标识符，极具误导性。
- **`verify` 增加常量自洽校验**：产物 SHA 必须等于 `PATCHED_SHA256`，堵住「改了 EDITS +
  重生成 golden 却忘了同步常量」的静默漂移（本补丁历史上吃过同类亏）。
- **`status` 增加"语法状态"维度**，独立于补丁状态：文件可以 `patched`、SHA 与常量一致、
  产物却是坏的 —— 本次正是如此。发现该状态时给出一条明确处置路径。
- **新增 `resync` 模式**：`apply` 对带标记的文件幂等跳过 ⇒ **规则修好后无法直接重打**，
  必须先 `revert` 再 `apply`。这条操作坑真踩到了，固化成命令；它只接受 SHA 等于已知官方原版的 backup。
- **新增 `rebuild` 模式**：改过 `EDITS` 后由 original 重建 golden 并打印新常量（只写 `baseline/`，不改常量）。

**排查方法可复用**（三条独立证据链对齐，任一单独都不足以定性）：
① `status` 报「语法 非法（第 2923 行）」；② 安装文件与 `baseline/client.patched.js` SHA 相同
（`C6C1DCBC…`）⇒ 线上跑的就是入库产物、没被外部改坏；③ `applyPatch(original)` 重建结果**逐字节等于**
该产物 ⇒ 反证"规则本身产出了坏 JS"。

**验证**：`node patch.mjs verify` 三行 PASS；全量复扫 15 个 client/host bundle
（4 个本体补丁目标 + 10 个自研插件）语法 **0 例同类**；`verify-all.mjs desktop` **11/11**。

## 2026-09-16 · 桌宠第二批落地（R4/R5/R7：提醒模型 + **桌宠内联审批**）

按 [`pet-reference-benchmark.md`](pet-reference-benchmark.md) §4 第二批实施。
新增一张**构建期**位图；运行时仍是零依赖、零 GDI 字体调用、零新增 IPC。

- **R4 · 提醒（气泡）模型**（`pet_native/model.rs::Alert` + `window.rs` 合流段）
  - 单槽 `Option<(usize, Instant)>` → `Alert { id, frame, priority, sticky, until }`，优先级
    **审批(0) > 告警(1) > 状态(2) > 台词(3)**；**同 id 就地更新**（帧变了才换、不重置计时 →
    状态抖动不再闪气泡）；**按 id 精确移除**（`resolve_alert`）；限时项显式 `until`
    （取代原先「状态帧不参与 3s 过期」的散列判定）。
  - id 语义：审批 = `approval:<官方 PendingApproval.key>`；状态 = `state:*`；台词 = `quote` / `quote:click`。
  - 单击「撸一下」的台词按**告警档(1)**展示（用户主动交互可短暂压过状态气泡），
    但**压不过审批(0)**——审批气泡必须常驻到 resolved（v3 M3 硬约束）。
  - **未采纳**参考实现的「被抢占项回队首、稍后恢复」：我方同时只展示一个气泡，
    被抢占的低优先级项要么是台词（可丢弃）、要么是状态派生项（状态仍在，下一轮自然回来）。
- **R7 · 气泡最小驻留**（按我方实际情况**重塑**，非照搬 30s 节流）
  - 参考实现的「跨检测器 30s 节流」作用于**事件型告警源**（stuck/pattern/exploration 三检测器）；
    我方状态均为快照派生、**没有事件型检测器**，直接搬会把状态变化一并吞掉。
  - 故只取其**防抖内核**：同优先级新项在 `ALERT_MIN_DWELL_MS=900ms` 内不替换当前项，
    而**审批(0)/告警(1) 恒可立即抢占**（可读性优先，与 v3 M1「审批 ≤2s 切过去」一致）。
- **R5 · 桌宠内联审批（M3.2）**
  - **新增位图** `ui/pets/approval.png`（240×84：提问文案 +「拒绝 / 允许一次」两按钮），
    由 `scripts/gen-bubbles.ps1` 一并生成（构建期 System.Drawing 出图、运行时零字体调用）；
    两按钮之间留 **8px 间隙**防误触（roadmap M3.2 红线）。
    `build.rs` 需**显式登记**该素材——该函数是显式清单、不扫 `pets/` 根目录，
    漏登记会让单文件分发时内嵌兜底缺图。
  - **hash 身份通路**：`client.js` 把官方 `PendingApproval.key` 写进 `window.__miasakiPetPanel.key`
    → 注入运行时 `syncHash` 合并 `petkey=`（仍由注入运行时单写 hash）→ `main.rs` `parse_fragment`
    解析（percent-decode）→ `set_official_state(ts, state, tool, key)` → `PetShared.official_key`。
  - **Rust 侧**：`approval_hit()` 固定矩形命中判定（不新增 GDI 对象）→ `decide_approval()`：
    ① **乐观收起**该审批气泡；② 记单调 `seq`；③ 经 `wv.eval` 派发 CustomEvent
    `miasaki-approval-decision`（detail: `key`/`decision`/`seq`，key 经 `serde_json` 转义防注入）。
    日志**不打 key 明文**（含 sessionId），只记长度与决策。
  - **插件侧**（`dsh-pet-panel` 0.1.0 → **0.2.0**）：监听该事件 → 在**跨会话** `pendingInteractions`
    中按 key 找到待审批项 → 调用官方 `PendingApproval.answer('allowed-once' | 'rejected')`。
    **红线**：只接受这两个枚举（协议收窄）；按 seq 去重（用集合而非单调比较——壳重启会重置 seq）；
    先本地收起再异步确认，**失败不假装成功**（写 `decisionError`）。
  - **失败回落**：点击后 `DECISION_FALLBACK_MS=3000ms` 内该审批**仍在** → 桌宠改显
    `BUBBLE_NEED_APPROVE`（"需要你的批准"）提示去 DSH 界面处理——**绝不显示"已处理"**。
  - **身份门禁**（R0 起延续）：拿不到官方 `key` 的审批**不挂可交互气泡**（只作普通 waiting 呈现），
    杜绝「挂出一个永远等不到 resolved、也点不动的气泡」（参考实现同款教训）。
- **R6 · 等待态语义补全（本轮为结论，无代码）**
  - 官方 `SessionPendingInteractionMap` **当前只有 `approval` 域**
    （`dsh-client-ui-approval/lib/types/client/contract/slots.d.ts:6-11`）⇒
    **提问等待（`ask_user_question`）不在该通道**，走 `dsh-client-ui-user-questions`，
    属**新增通道**而非改映射（未做，已记入 TODO）。
  - **cordis 动态插件运行审批是否落在 `approval` 域：本轮未能运行时验证**——客户端插件包的激活
    需要用户批准，而本会话审批已禁用（探针插件无法激活）。已记入实机验收项：
    跑一个动态 Cordis 插件，观察桌宠是否出现审批气泡。
  - 代码侧防御：R5 只处理 `kind === "approval"`，其余 kind 一律忽略（未来出现新域时需显式扩展）。
- **验证**：`cargo check` 零警告；`cargo test` **19/19**（新增 3 例 Alert 单测：优先级次序 /
  同 id 就地更新 / 只有限时项过期）；`verify-all desktop` **8/8**；`node --check` 通过；
  `gen-bubbles.ps1` 重跑后 `bubbles.png` **逐字节未变**（生成链确定性），`approval.png` 240×84 已入册。
- **实机验收清单（待用户）**：
  1. 触发一次工具审批 → 桌宠显示含「拒绝 / 允许一次」的审批气泡；
  2. 点「允许一次」→ 会话继续、气泡收起、DSH 界面审批消失；
  3. 点「拒绝」→ 工具被拒、会话继续；
  4. 让插件不可用（无插件宿主）后点按钮 → 3s 后出现「需要你的批准」回落提示（**不假装成功**）；
  5. 审批期间点角色本体 → 仍唤起主窗口（审批语义优先）；点气泡外空白 → 正常「撸一下」；
  6. `pet.log` 出现 `approval decision sent -> allowed-once seq=…`（无 key 明文）。
- 触摸点：`src-tauri/build.rs`、`src-tauri/src/pet_native.rs`、
  `src-tauri/src/pet_native/{model,window,image,config}.rs`、`plugins/dsh-pet-panel/lib/client.js`、
  `plugins/dsh-pet-panel/package.json`、`themes/src/02-core.js`、`scripts/gen-bubbles.ps1`、
  新增 `ui/pets/approval.png`、`README.md`、本文件。
  **需重编壳；插件已同步 profile（0.2.0，哈希核对一致），重启 DSH host 后生效。**

## 2026-09-16 · 桌宠第一批改进落地（R0–R3：跨会话审批 / 不夺焦点 / 透明穿透 / 位置 v2）

按 [`pet-reference-benchmark.md`](pet-reference-benchmark.md) §4 第一批（用户拍板）实施——
**零素材、零新增依赖、不动状态机与 hash 协议**。

- **R0 · 跨会话聚合待审批 + 审批身份门禁**（`plugins/dsh-pet-panel/lib/client.js`）
  - 旧实现只读 `sessions.list.current`：用户切走会话后，别的会话正在等待的审批**完全不可见**——
    而「快捷提权」的价值前提正是「不用切窗口」。深挖 A 判定这是当前最大的一处漏报面。
  - 改为遍历 `ctx.uiSession.pendingInteractions`（本就是 `ReadonlyMap<SessionId, PendingApproval>`）
    找审批、遍历 `list.ids`/`byId` 判 running（**任一非子代理会话 running = 忙**，
    修掉「先完成的会话把仍在干活的顶成 idle」）；M2.3 子代理排除保留。
  - **身份透出**：`sessionId` + `reason`（截断 160 字符）随态写入 `window.__miasakiPetPanel`
    （非审批态清空），供 M3 决策链路使用；不进 hash ⇒ **Rust 零改动**。
  - **插件版本 0.1.0 → 0.2.0**（行为与语义变更；同时便于 profile 侧 `pnpm install` 识别
    `file:` 依赖变化——同版本号时 pnpm 可能跳过拷贝，这是本线已知的 store 缓存滞后问题）。
  - **身份门禁**：拿不到任何稳定身份（条目 `sessionId` 或 map key）的审批**一律不显示**——
    宁可不报，也不挂一个永远等不到 resolved 的常驻态（参考实现踩坑：`agent_link.py:3190-3194`）。
- **R1 · 点击桌宠不夺前台**（`pet_native/window.rs` 窗口样式 + `ffi.rs` 常量）
  - 扩展样式补 `WS_EX_NOACTIVATE`：此前点击桌宠会把前台与键盘焦点夺走，用户在原应用的
    Ctrl+C/V 会落到桌宠窗口（参考实现 issue #98 的「整机复制粘贴失效」观感）。
  - 只改样式位、**不重建原生窗口**；鼠标/键盘消息照常送达（点击、拖动、双击不受影响）。
  - **右键菜单兼容（必做，否则是回归）**：`TrackPopupMenu` 要求 owner 窗口是**前台窗口**，
    否则「点击菜单外不关闭」；而 `WS_EX_NOACTIVATE` 会让 `SetForegroundWindow` 失效。
    故 `show_menu` 改为：弹菜单前用 `GetForegroundWindow` 记下原前台 → **临时摘掉该样式位** →
    `SetForegroundWindow` 自身 → 弹菜单 → 按 MSDN 建议补 `PostMessageW(WM_NULL)` 确保菜单消失 →
    **恢复样式位并把前台归还原窗口**（用完不留前台占用）。
- **R2 · 透明区域逐像素鼠标穿透**（`pet_native/window.rs` + `config.rs` + `ffi.rs`）
  - 新增 **10ms 光标轮询定时器**（`IDT_HIT`），按光标位置查**当前合成缓冲 `buf` 的 alpha**——
    `buf` 已是「立绘 + 气泡」逐像素 over 之后的最终结果，故**无需为每种元素单独维护 mask**
    （比参考实现的 Qt mask 路径更省）；阈值 `CLICK_THROUGH_ALPHA = 16`（参考实机值）。
  - 命中透明像素 → 置位 `WS_EX_TRANSPARENT`（鼠标穿透到下层窗口），否则清除。
    **必须轮询**：置位后本窗口收不到鼠标消息，「何时恢复可点击」无从由事件得知。
  - 隐藏 / 拖拽中恒不穿透；只改扩展样式位、**不重建窗口**（重建会造成可见闪烁）；
    切换日志按 `CLICK_THROUGH_LOG_EVERY=500` 节流（鼠标扫过轮廓会频繁切换，不能每切必写盘）。
- **R3 · 位置持久化 v2 + 可见性判据修正**（`pet_native/persist.rs` + `pet_native.rs`）
  - `pet.json` 升 **v2**：`rx`/`ry`（**角色可见区域中心**相对所在显示器工作区的比例）
    + `work`（该工作区几何，作为「屏幕身份」）+ 绝对坐标兜底 + `hide`。
    **v1 文件可无缝读取**（按 `version` 字段分流解析），读后下次保存即自动升级为 v2。
  - 恢复顺序：工作区几何**完全一致** → 按比例还原并 clamp 回工作区（分辨率/缩放变化安全）；
    几何已变 → 绝对坐标 + 可见性校验；都不可见 → 默认位置（保留 `hide`）。
  - **可见性判据由「窗口中心点」改为「角色可见区域 ∩ 工作区的面积占比 ≥ 25%」**：
    角色区域 = 底部 `CELL_H` 高的一条带（与 `blit_center_bottom` 的几何一致），
    排除了窗口上方的气泡带与左右留白。**这是 M4.1（peek 缩边）的前置**——
    peek 时窗口中心会落在屏外，旧判据会误判「不可见」并把桌宠拉回默认位置（「桌宠丢了」回归）；
    参考实现同款结论见 `pet/window_placement.py:183-200`（以角色 alpha 轮廓为可见性口径）。
- **验证**：`cargo check --offline` 零警告；`cargo test --offline` **16/16**
  （新增 6 例 `persist` 单测：相交面积 / 角色带几何 / 全局矩形偏移 / v1 解析 /
  v2 往返 / 未知版本拒绝）；`node --check plugins/dsh-pet-panel/lib/client.js` 通过。
- **实机验收清单（待用户，需提权 + 真实 DSH 页）**：
  1. 会话 A 触发审批 → **切到会话 B** → 桌宠仍显示「等待审批」（R0 核心）；
  2. 点击桌宠后，在记事本里 Ctrl+C/Ctrl+V 仍作用于记事本（R1）；
  3. 点击桌宠**透明区域**（角色身旁空白）→ 命中下层窗口；点击角色本体 → 照常跳跃/拖动（R2）；
  4. 拖动桌宠到屏幕边缘并重启 → 位置保持（R3）；改分辨率/缩放后重启 → 位置按比例合理落位；
  5. `pet.log` 出现 `pet.json v2 restored by ratio …` 或 `workarea changed ->`；
     无新增 `ULW failed`，GDI 对象数不增。
- 触摸点：`plugins/dsh-pet-panel/lib/client.js`、`src-tauri/src/pet_native/{window.rs,persist.rs,config.rs,ffi.rs}`、
  `src-tauri/src/pet_native.rs`、`README.md`、本文件。**Rust 需重编壳**（`npm run tauri build`）。

## 2026-09-16 · 桌宠参考实现对标评估（**仅调研，代码零改动**）

- **来源**：用户给定第三方参考 `MerZlin/dsh-pet-indesktop`（上游 `PC2005-cloud/dsh-pet` 的跨平台
  移植 fork，Python + PySide6，自述 v4.2.0）。源码经 **GitHub API 快照**归档于
  `_refs/dsh-pet-indesktop/`（本机 `git clone` 因 schannel 凭证不可用，`gh api` 通道可用；
  归档为会话期临时档案，已 ignore、不入库）。
- **产出**：新增 [`pet-reference-benchmark.md`](pet-reference-benchmark.md)——评估范围与许可边界、
  参考实现全景（DSH 联动/审批、提醒队列、窗口层、边缘探头、位置持久化、工程门禁）、
  16 项可迁移性分级、建议落地清单 R0–R10、明确不采纳清单、待拍板 8 项、证据索引。
  另有三路并行深挖报告（`_refs/pet-analysis/A-dsh-link.md` 等，临时档案）。
- **对标结论（要点）**：
  - **新查出我方一处真实漏报面**：桌宠只读**当前选中会话**（`plugins/dsh-pet-panel/lib/client.js:216-232`
    写死 `ls.current`），用户切走会话后**看不到其他会话的待审批**；而官方
    `ctx.uiSession.pendingInteractions` 本就是 `ReadonlyMap<SessionId,…>`，改为遍历即可
    （建议 R0：`client.js` ~25 行、**Rust 零改动**）。
  - **两处窗口层缺口**：① 无透明区域逐像素穿透（`grep WS_EX_TRANSPARENT|NCHITTEST|SetWindowRgn`
    零命中 ⇒ 现为整窗矩形吃鼠标）；② 窗口样式缺 `WS_EX_NOACTIVATE`
    （`pet_native/window.rs:998`），点击桌宠会夺前台——参考项目记录该缺陷会造成
    「整机 Ctrl+C/V 失效」的观感（其 issue #98）。
  - **一处结构缺口**：气泡为单槽 `Option<(usize, Instant)>`（`window.rs:31`）；M3 审批气泡
    常驻后需要「带 id/优先级的提醒队列 + 精确移除 + 恢复防抖」，参考项目
    `pet/window_alerts.py:68-160` 有完整先例与踩坑记录。
  - **一条改变 M5 顺序的发现**：参考实现**三处独立写明**「旋转/形变在绘制层完成、**不依赖素材**、
    不改动帧缓存/解码链」⇒ 用户抱怨的「动作太少」里有**一大块不需要出图**（黄金回旋 / Q 弹挤压 /
    甩出 / 探头倾斜都是纯绘制变换）；真正要补的是 **whale `work`/`deep` 与 inverse 三态目前各只有
    1 帧**（`frames.json` 已核实）——这是「非 idle 态完全静止」的最强来源。M5 顺序因此改为
    **先建变换管线 → 再补单帧 → 最后才谈新动作素材**（R11–R15）。
  - **一处确定性体验缺陷**：拖动为 `WM_MOUSEMOVE` 逐事件 `MoveWindow`（`window.rs:736-754`，
    1000Hz 鼠标即每秒千次窗口移动）；参考侧为此专门做了 8ms 合帧 + 回归测试
    （R13，也是「甩出物理」的必要前置）。
  - **窗口层另两处可抄语义**：位置持久化用「中心相对**工作区**比例 + 屏幕名」、可见性判据用
    **角色轮廓而非窗口矩形**（`window_placement.py:183-263`，正对 M4.1 的 peek 误判坑，R3）；
    边缘探头露出量必须以**旋转后投影 bbox** 为分母、且 `pause/resume` 要平移过渡起点（R14）。
  - **订正历史记录**：`pet-v3-roadmap.md:100`「审批只有通知」针对的是其**上游 Electron 版**，
    **不适用本 fork**——本 fork 已有完整可点击审批（同意/拒绝 + 回写），是我方 M3.2 的直接参照。
  - **无借鉴价值项（重要）**：参考实现**没有**「GUI 事件循环心跳超时 → 落盘线程栈/自愈」类
    进程内看门狗（其 6 类 heartbeat/watchdog 全部是业务级；`faulthandler` / `sys._current_frames` /
    `MiniDumpWriteDump` 在 `pet/` 全目录零命中）⇒ 我方 P0「偶发全黑无响应」**无法从它抄现成方案**。
    深挖 C 另给出**三条可执行机制建议**（评估文档 §4 第六批）：P0-1 独立 OS 线程心跳看门狗 +
    自检 + dump（心跳用既有 `AtomicU32`，零分配；A 层文本 marker 必须先 fsync）、
    P0-2 外部 `SendMessageTimeoutW(SMTO_ABORTIFHUNG)` 探测 + **外部进程**抓 dump、
    P0-3 把「关不掉」从症状里摘出去（独立线程强制退出通道 + 给 `wv.url()` 慢调用设硬阈值出口）。
  - **素材许可**：其角色动画为 CC BY-NC-SA 类条款（仅个人非商业、须署名）⇒
    **不引入任何素材与代码**，只吸收机制与教训。
- 触摸点：新增 `design/pet-reference-benchmark.md`；`design/pet-v3-roadmap.md`（§1.6 补订正与指向）、
  本文件。**代码零改动，无需重编。**
- **待用户拍板**：见评估文档 §6（10 项）——R0–R3 是否立即落地、跨会话审批提示的语义边界、
  M3.2 一键审批、穿透阈值、是否补「等待回答」态、`pet.json` 是否升 v2、设置准入线、
  「通道死亡」实机探针、第三批（玩法与物理）如何排期、P0 三项是否立项及顺序。

## 2026-09-12 · 依赖安全：sharp 升级 0.35.4（修复 libheif 高危漏洞）

- **来源**：GitHub dependabot alert #2（severity **high**，`GHSA-rgj7-g3m4-5g8c`）——
  `sharp < 0.35.4` 受 libheif 两个漏洞影响（`GHSA-g89c-p67h-r497` / `GHSA-2jg2-4ch7-h545`），
  清单为 `dsh-miasaki-desktop/package-lock.json`。
- **处置**：采纳 dependabot PR #1 的改动——`sharp` 0.35.3 → **0.35.4**、`@img/sharp-*` 平台包
  0.35.3 → 0.35.4、`@img/sharp-libvips-*` 1.3.2 → 1.3.3，`package.json` 下限 `^0.35.3` → `^0.35.4`。
  **逐条目审计**（node 解析两版 lock 逐包比对）：46 个包条目数量一致、无增删，28 处差异
  全部落在 sharp 家族，其余依赖与 `lockfileVersion` 零变动——确认采纳无副作用。
- **附带修正**：`pnpm-lock.yaml` 的 importer `specifier` 由 `^0.35.3` 同步为 `^0.35.4`
  （其解析版本本就已是 0.35.4），使两套锁文件与 `package.json` 自洽，
  `pnpm install --frozen-lockfile` 不再判定锁文件过期。
- **验证**：`verify-all desktop` **8/8**（`build-init` 实际经 sharp 处理 whale / kurumi 图集，
  78 KB 产物令牌校验通过）。GitHub 侧 alert 已转 `fixed`（`fixed_at` 2026-09-12T14:32:03Z），无 open alert。
- **背景**：sharp 仅用于**构建链脚本**（`cut-frames` / `inverse-states` / `make-icons` /
  `make-inverse-sheet` / `build-init`），不进运行时；本地 `node_modules` 此前已解析到 0.35.4，
  本次修的是**锁文件记录**（npm 侧此前仍锁 0.35.3，dependabot 读的正是它）。
- **决议与收口（同日，用户拍板「以 npm 为准则」）**：本线自身依赖统一走 **npm**，
  `package-lock.json` 为**唯一锁文件**——`pnpm-lock.yaml` **已 `git rm` 删除**，并在根 `.gitignore`
  加条目挡回（防再次生成后误提交）。**成因回顾**：正是两套锁文件各自漂移，才造成「pnpm 侧早已是
  0.35.4、npm 侧仍锁 0.35.3」的分裂，而 dependabot 只读 npm 侧 ⇒ 高危告警长期挂着。
  **注意区分**：本 README/CHANGELOG 多处提到的「profile 目录 `pnpm install`」指的是 **DSH profile
  宿主侧** `file:` 插件依赖的安装方式（宿主生态既定），与本线自身依赖无关，不受此决议影响。
- **一致性校验**（删锁文件前做的最后核验）：`package-lock.json` 与 `package.json` 的
  dependencies / devDependencies / 包名版本**逐字段一致**，三个声明依赖（sharp / ws / @tauri-apps/cli）
  均有 lock 条目且带 `resolved` + `integrity`（`lockfileVersion` 3）⇒ `npm ci` 前置检查可通过。
- **待用户执行**：本地 `node_modules` 目前仍是 **pnpm 结构**（存在 `.pnpm/`）。依赖不进运行时、
  不影响壳，故非阻塞；但建议在普通终端执行 `Remove-Item -Recurse -Force node_modules; npm install`
  使其与 npm 锁文件对齐（受限沙箱内 npm 缓存写入被拒，无法代跑）。
- 触摸点：`package.json`、`package-lock.json`、`pnpm-lock.yaml`（**已删除**）、`README.md`（新增包管理准则段）、
  根 `.gitignore`、本文件。**无需重编壳**（依赖不进运行时）。

## 2026-09-12 · 桌宠 v3 M2 真实工作状态（**官方契约为主信号,DOM 降级兜底**）

按 [`pet-v3-roadmap.md`](pet-v3-roadmap.md) M2 执行,含 M0 探针(跑完即删)。**官方契约通道
实机探针全部实证**(临时探针插件 + pet-panel 调试段,验证后已删净):

- **M0 探针结论**(S2/S4):
  - `ctx.uiSession.pendingInteractions` 可达:形状 `ReadonlyMap<SessionId, PendingApproval>`,
    同步读 `getSnapshot()`、订阅 `subscribe()`;条目含 `toolName`/`reason`/`answer()`。
    **cordis ctx 属性访问受 inject 白名单保护**——'uiSession' 不声明在 inject 里直接抛
    `cannot get property "uiSession" without inject`(实证)。
  - `ctx.sessions.list.getSnapshot()` 形状 `{ids, byId(普通对象), current, phase,
    subagentsByParent, jobsBySession, currentAddress}`,**row 自带 `running`**;
    `sessions.get()` 仅对 materialize 过的会话返回 SessionFace(否则 null)→ running 必须从
    list row 读。
  - S4:`PendingApproval.answer('allowed-once')` 链路可达(钩子就绪;真实审批端到端
    留桌面壳验收)。
- **M2.1 六态模型**:Rust `PetState`(Idle/Thinking/Waiting/Error/Done/FleetBlocked,
  `pet_native.rs`)成为行选择唯一口径,替换 activity+waiting 松散组合。compose 六态合成:
  **官方契约(5s 心跳内) > DOM 扫描兜底(通道静默时) > fleet 叠加**(M1.2 次序保留:
  Waiting > FleetBlocked)。
- **M2.2 信号通道**:hash 新增 `pet=<六态>`/`pettool=<工具名>`/`petts=<心跳 ms>`
  (`main.rs` parse_fragment 结构体化 + percent_decode);心跳 1.5s,同 petts 去重,
  白名单外归一化回 idle(防篡改)。**hash 单写者仍是注入运行时**:pet-panel 只更新
  `window.__miasakiPetPanel`,`themes/src/02-core.js` syncHash 合并进 hash;
  `themes/src/05-sensors.js` 按心跳探活,**官方通道活着时完全关闭 act/wait DOM 扫描**
  (roadmap:不是双源并存),通道静默自动回落。
- **M2.3 会话口径**:只读 `list.current`;`projectionValues.subagent` 非空的会话不计入主态。
- **Done 庆祝**:`running` true→false 边沿 → 一次性 review 槽(DONE_REVIEW_MS 1.5s,不循环)
  + 「完成了」气泡(JS 侧 doneHold 10s 后归 idle 收尾)。
- **气泡精灵表 20→22 帧**(`gen-bubbles.ps1` +「出错了」+「完成了」;`BUBBLE_ERROR`=20/
  `BUBBLE_DONE`=21),六态→气泡映射进 compose 状态段。
- **交互一致性**:`pick_state_row` 签名改六态(单测 5 项);单击/双击唤起判定改
  `effective_waiting()`(DOM waiting_approval 或官方 Waiting 5s 内)。
- whale/inverse 三态立绘:Waiting/Error/Done/FleetBlocked → work;Thinking → intensity
  (idle 升 work);Idle → intensity(fleet_running 例外升 work)。

验证:`cargo check` 零警告;**MSVC `cargo test` 10/10**(新增 Done 让位槽用例);浏览器实机
探针(S2 事实全实证、心跳 state=idle 正确);探针代码已从 pet-panel 删净。
**待桌面壳实机验收**:发消息 → ≤1.5s thinking;完成 → done → idle;审批 → waiting+工具名;
hash `pet=` 字段落盘;`pet.log` 出现 `official state ->` 行。

## 2026-09-12 · 让位协议落地（M2 S6，appearance 线接管主题时本壳停注配色）

S2 已把主题拆为 `*.skin.css`（配色）/ `*.deco.css`（装饰）两层；本轮接入让位判定——
appearance 线（DSH web 外观插件）接管主题时，桌面壳**停注入配色并交还明暗所有权**，
装饰层与窗口能力恒保留。设计依据
[`../dsh-miasaki-appearance/design/2026-09-12-appearance-m2-design.md`](../../dsh-miasaki-appearance/design/2026-09-12-appearance-m2-design.md) §4。

- **判定**：`appearanceYield()` = `html[data-mia-appearance="on"]` 且 `data-mia-skin ≠ pure`
  （两属性由 appearance 的 boot script 写在 `<html>` 上）。默认不让位——appearance 未安装 /
  未启用 / 纯净皮肤时，本壳行为与之前**逐字节一致**（零回归）。
- **`themes/src/00-boot.js`**：`styleFor(t)` 按让位挑层——让位只注入 deco，否则 deco + skin。
- **`themes/src/02-core.js`**：
  - `syncDark()` 让位时 return（`FORCE_DARK` 锁定停用，明暗归官方 presenter；残留锁定由
    presenter 的全量 apply 修正）；
  - `setAttr()` 置 **`data-miasaki-theme-yield="skin"`** 双向保险标记——appearance 线据此判定
    「桌面壳在位却未让位」的唯一不可接受冲突（`override-conflict`）；未让位时移除标记；
  - 新增 `yieldObserver`（监听 `<html>` 的 `data-mia-appearance` / `-skin` / `-wallpaper`）：
    appearance 属性翻转即 `apply(current)` 重跑——**让位与恢复都无需刷新页面**（时序补偿：
    appearance 的 boot script 晚于本 init script 的首次判定，§4.1 设计约束 2）。
- **`themes/src/03-switcher.js`**：切换条**第二入口**——让位态点皮肤不再本地 `apply`，改为
  `GET /appearance/api/state` + `POST /appearance/api/config`（带 expectedRevision），成功后
  自行同步 `<html>` 门控属性（与 appearance client 半 save() 同源幂等）；桌宠人格随目标
  主题联动（`notifyPet(forTheme)` 增参数）。切回 pure 即解除让位，本壳自动恢复注入。
- **`themes/src/04-deco.js`**：`buildAurora()` 在 `data-mia-wallpaper="on"` 时把光晕层
  `opacity: 0`——壁纸与桌面光晕两层氛围不打架（appearance M2 §5.1）；壁纸关闭后经
  `updateAurora()` 重建恢复。
- **`themes/src/08-ready.js`**：`onReady()` 挂 `startYieldObserver()`。
- **`scripts/verify-themes.mjs`**：新增 **§4.5 让位往返 4 项**自动化（模拟 appearance 门控
  属性 → 断言 skin 停注入 + yield 标记 + `data-miasaki-theme` 保留 → 解除后 skin 回注 +
  标记移除）；setup 增「先经 appearance API 关总开关并二次导航」（本脚本验证 desktop 独立
  行为，需 appearance 处于 off 基线——裸 API 写入不唤醒其 client 半，必须让首帧重读）。
  首轮跑出的 12 项 FAIL 正是让位协议真实工作的证据（appearance 残留 enabled 配置下本壳
  正确让位，测试前提失效），非回归。

验证：`verify-themes` **22/22**（含让位往返）；`verify-all desktop` **8/8**。
**实机项**（桌面壳 + appearance 插件同页）：切换条双入口换肤、aurora × 壁纸叠加、
关总开关即时恢复接管——见 `dsh-miasaki-shared-docs/cross/smoke-test-matrix.md` §3.5/§4。

## 2026-09-12 · 桌宠 v3 M1 状态机修复（**纯代码,零素材,零依赖**）

按 [`pet-v3-roadmap.md`](pet-v3-roadmap.md) M1 执行,铲除四个确定性缺陷(D1/D3/D4/D5/D6),
对应 §3 M1 验收 + §8 回归用例 1-3/6:

- **D1 根治 · 单一动作槽**(M1.1):`hop_until`/`hop_hold_until`/`wave_until`/`ambient`/`wander`
  五个独立 `Option` 统一为 `ActionSlot { action, started, duration }`(`model.rs`)。
  旧 `hop_until` 只有写入没有复位路径——单击一次后 compose 的 hop 分支恒真,每帧重挂 hold,
  **永久 `jump`**,且 `wander`/`ambient` 触发门以 `hop_until.is_none()` 为前提、行选择链把
  waiting/fleet_alert 排在 hop 之后 → 「动作太少」「不反映工作状态」两症状同一根因。
  新 compose **每轮先「到期即清」再行选择**(Jump 到期自动转 `JumpHold` 落地定格,保留 v2 无硬切观感),
  「忘记清理」一类缺陷从结构上不再可能。
- **D3 修复 · 优先级重排**(M1.2):行选择收进纯函数 `pick_state_row`,新优先级
  **waiting(审批) > fleet_alert > busy(静默守候) > 手势/环境动作 > idle**——审批与告警姿态
  不再被单击手势遮蔽(刚点过桌宠也 ≤2s 切审批姿态)。busy 工作态站定:散步/ambient 触发门
  同步排除 busy(触发必能播,不挂空槽)。4 个单测钉死优先级表(`model.rs::tests`)。
- **D4 修复 · 双击挥手可达**(M1.3):窗口类补注册 `CS_DBLCLKS`(`ffi.rs` 新常量)——此前
  `WM_LBUTTONDBLCLK` 永不到达,`do_wave` 是死代码,双击只会「再跳一次」。
- **D5 修复 · 单击不抢焦点**(M1.3):单击改为「撸一下」(jump+气泡,不 `focus_main`);
  **等待审批或主窗口最小化/隐藏**时单击/双击仍立即唤起主窗口。单击与双击去抖区分:
  `WM_LBUTTONUP` 后 `SetTimer` 250ms(`IDT_SINGLE_CLICK`)判定是否第二击,双击序列的
  第二次 UP 被吞(防「跳一次+挥一次」);新按压序列(DOWN)取消挂起去抖,拖动不受影响。
- **D6 修复 · 圆点跟随**(M1.4):圆点位置在四处同步——拖动结束、散步结束(自然到期/撞墙)、
  显隐切换、位置重置(原有)——隐藏态恢复入口不再与桌宠位置脱节。
- 行为变更三点:① 单击不再唤起主窗口(除审批等待/主窗不可见);② busy 时散步与环境小动作停触发;
  ③ 双击 = 挥手一次(不再是跳两次)。另:`Wander`/`Ambient` 旧结构删除,`HOP_MS`/
  `SINGLE_CLICK_DEBOUNCE_MS`/`IDT_COMPOSE`/`IDT_SINGLE_CLICK` 常量化(`config.rs`),
  `ffi.rs` 补 `KillTimer` 声明。

验证:`cargo check --bin miasaki --tests` 零警告;**MSVC 环境 `cargo test` 9/9**
(新增 4 项:优先级抢占 ×2、动作行映射、槽到期;既有 5 项不回归)。
实机验收待用户:roadmap §3 M1 验收 ①-⑤(单击 1.5s 回基线 / 连点 20 次不卡 / 审批 ≤2s 抢占 /
双击挥手 / `pet.log` 无新增 `ULW failed`)。

## 2026-09-12 · 主题 CSS 拆分 skin/deco（M2 S2，**零行为变更**）

为 appearance 线 M2 的「desktop 注入层让位协议」做前置拆分（设计见
[`../dsh-miasaki-appearance/design/2026-09-12-appearance-m2-design.md`](../../dsh-miasaki-appearance/design/2026-09-12-appearance-m2-design.md)
§4）：非 pure 主题一分为二——

- **`themes/{zafkiel,kurkuriel}.skin.css`（配色层）**：73 个 `--dsw-static-*` 色阶 + 品牌 alias
  重定向 + 杂项/JSON 树/代码高亮令牌 + 6 个半透明 alias（面板半透明化）。让位协议落地后
  （appearance 线 S6）外观线接管主题时**本层停注入**。
- **`themes/{zafkiel,kurkuriel}.deco.css`（装饰层）**：`--ms-*`（切换条/标题栏/关闭弹窗自有
  配色）+ `::selection` / 光晕 / caret / 标题字族 / 水印。**恒注入**——桌面壳专属视觉与
  自有命名空间，与 DSH 主题无耦合。
- 原 `themes/{zafkiel,kurkuriel}.css` 删除（拆分前内容 = deco + skin 级联等价，
  无同选择器同属性冲突）；`pure.css` 语义不变（不覆盖任何 token，无 skin 层）。

配套同步：

- `scripts/build-init.mjs`：产物改为 `__MIASAKI_STYLES__[t] = { skin, deco }`；**令牌完备性
  校验只作用于 `*.skin.css`**（deco 不含色阶）。
- `scripts/diff-tokens.mjs`：只扫 `*.skin.css`（缺失 0 / 死覆盖 0，与拆分前一致）。
- `themes/src/00-boot.js` 新增 `styleFor(t)`（deco + skin 恒拼接，级联等价于拆分前；
  让位判定在 appearance S6 接入时改为按判定挑选层）；`02-core.js` / `08-ready.js` /
  legacy `runtime.js` 的全部 `STYLES[t]` 消费点改走 `styleFor`。
- `scripts/verify-themes.mjs` **无改动**：端到端断言的是注入后的运行时行为，结构变化透明。

验证：`build-init` 重建通过（73 KB，令牌校验过）；`verify-themes` 18/18
（首轮 22/24 的两个 FAIL 为测试环境残留——上轮 headless Edge 进程未死透 + 测试 profile
复用导致首载读到 zafkiel，清理 `.edge-test-profile` 与残留进程后全绿；非拆分引入）；
`verify-all desktop` **8/8**（含 cargo test 10 例：pulse stale 语义 + 立绘回落链）。

## 2026-09-12 · 桌宠 v3 专项规划设计（**仅设计，代码零改动**）

依据:用户反馈「桌宠立绘不准确、动作太少、不能反应工作状态、不能快捷审查提权」,并新增诉求
「边缘状态」(扒屏幕边缘露头 / 爬窗口边缘)。本轮只做调研与设计,产出
[`pet-v3-roadmap.md`](pet-v3-roadmap.md)。

### 一、关键结论:四项抱怨中三项的主因是代码缺陷,不是素材不足

**同一处缺陷同时造成「动作太少」与「不反映工作状态」两个症状。**

1. **`hop_until` 泄漏(确定性缺陷)**:`src-tauri/src/pet_native/window.rs:555` 由 `do_hop` 写入,
   全仓唯一复位点是构造处的 `:867`,运行期无任何清理路径。于是 `compose` 的行选择链
   `:253` 分支恒真,每轮重新挂上 `hop_hold_until`(`:258-262`)→ **单击一次后桌宠永久播 `jump`**。
2. **连带禁掉散步与环境编排**:`:109`(wander 门)与 `:129`(ambient 门)都以 `hop_until.is_none()`
   为前提 → 单击一次后 ambient / wander **永不再触发**。这是「动作太少」的直接主因。
3. **连带遮蔽状态姿态**:行选择链把 `waiting`(`:288`)与 `fleet_alert`(`:291`)排在 `hop`(`:253`)
   **之后** → 审批与告警姿态永远轮不到。这是「不能反应工作状态」的直接主因。
4. **双击挥手是死代码**:窗口类 `style: CS_HREDRAW | CS_VREDRAW`(`:892`)未注册 `CS_DBLCLKS`,
   `WM_LBUTTONDBLCLK` 处理器(`:702`)**永不可达**;双击的第二击只会再走一次 `WM_LBUTTONUP`
   (`:686`)。→ `TODO.md` P2「桌宠双击 = 唤起/聚焦主窗口(已实现,待用户验证)」应修正为「待修」。
5. 另两处交互缺陷:单击无条件 `focus_main()`(`:694`);隐藏后恢复用的圆点不跟随拖动
   (`:67`/`:698`/`:952`)。

### 二、状态信号源错位(非崩溃,但语义错误)

现役实现是整页 DOM 扫描(`themes/src/05-sensors.js:67-98`),不绑定任何会话。官方已提供权威契约,
本项目此前未使用:`SessionSnapshot.running` / `lastAgentError` / `queue` / `subagent`
(`@deepseek-ai/dsh-api-session-controller` 的 `client/contract/snapshot.d.ts:71-94`);
`ctx.uiSession.pendingInteractions` + `registerPendingInteraction`
(`@deepseek-ai/dsh-client-ui-session` 的 `client/index.d.ts:96,117`);`PendingApproval` 与
`ApprovalDecision = 'allowed-once' | 'rejected'`(`@deepseek-ai/dsh-client-ui-approval` 的
`client/contract/slots.d.ts`,该包 README 明确「transient decisions only」,持久策略归 Host);
审查跳转 `ctx.sidebarRight.openTab(kind)` / `toggleExpanded()`
(`@deepseek-ai/dsh-client-ui-sidebar-right` 的 `client/service.d.ts`)。

### 三、边缘 / 多屏 / DPI 现状

- 可复用基础:`pet_native/persist.rs:52-78`(`monitor_workspaces`)与 `:82-93`(`pos_visible`)。
- **主屏钳制**:`pet_native/ffi.rs:181-183` 的 `screen_size()` 取 `SM_CXSCREEN/CYSCREEN`,
  被 `window.rs:157-163` 用于 wander 边界 → **副屏不可达,会被拉回主屏**。
- **DPI**:`window.rs:855` 一次性声明 per-monitor-v2,全仓无 `WM_DPICHANGED` 处理 →
  混合 DPI 跨屏拖动会坐标/尺寸错。
- **M4.1 必测坑**:缩边(peek)状态下窗口中心点落在工作区外,现行 `pos_visible` 会判「不可见」
  → 重启后把桌宠拉回默认坐标(即「桌宠丢了」回归)。

### 四、一处「看着像 bug 但不是」的项(记录以免误改)

`window.rs:529` / `:785` 的 `BlendFn { blend_op: 1, … }`:按 Win32 规范 `BlendOp` 应为
`AC_SRC_OVER`(`0x00`,`wingdi.h:4821`),此处传 `1` 属**规范偏差**。但
`%LOCALAPPDATA%\miasaki\pet.log` 中 `ULW failed` 出现 **0 次**,首帧 `buf_nonzero=26419`、
`first compose done` 正常 → **本机实际渲染成功,本轮不动它**;未来若改必须加日志断言。

### 五、素材侧事实(与「立绘不准确」相关)

- `ui/pets/frames.json`:kurumi 9 行 57 帧已切全;**`runRight` / `runLeft` 已切但运行时未使用**
  (只用 `run`,`window.rs:273`)。
- **语义错配**:`r7` 行(名为 `run`)实为「坐姿用电脑」画面,却被当作「散步」播放。
- **inverse 不是滤镜**:三张独立原图经 `scripts/inverse-states.mjs:159-174` 生成;
  README 中「同狂三图集 + CSS 反转滤镜」表述与实现不符,且原图
  `ui/pets/inverse/raw/blue-idle.png` 与 `blue-deep.png` 的**金钟眼左右已互换**。

### 六、参考仓库评估(PC2005-cloud/dsh-pet)

固定提交 `814b0e4`(2026-09-11 10:44:24Z),经 GitHub API + README 核实(未拉源码)。架构为
DSH web 插件 + Electron 透明局部窗 + VP9-Alpha `.webm` 素材。**已有**:会话事件驱动的档位化
工作状态(思考/工作/整理/等待/成功/出错)+ 常驻气泡、权重化动画调度、多宠物实例、多屏 DPI 处理。
**未证明**:宠物内直接审批(仅有窗口失焦的系统 toast 通知)、检测并攀爬其他应用窗口边缘
(其边缘能力止于屏幕/工作区边界)。许可:代码 MIT,但**动画/提示词/源视频禁止商用,二创须署名**。
→ 只借鉴机制(档位化状态、权重调度、交叉淡入、多屏 DPI 经验、降级开关),**不引入其素材、不换架构**。

### 七、方案里程碑

M0 探针(S1–S4)→ **M1 状态机修复**(一次性动作统一为带到期时间的槽位;优先级改为
「审批 > 告警 > 工作 > 用户手势 > 散步 > 环境」;补 `CS_DBLCLKS` + 单击/双击去抖;圆点跟随)
→ M2 官方契约六态(idle/thinking/waiting/error/fleet-blocked/done,DOM 扫描降为兜底)
→ M3 审批闭环与审查跳转 → M4 边缘(先屏幕边缘,后本应用主窗口,第三方窗口降为可选)
→ M5 素材与立绘。**M1 是一切前置**:不修 `hop_until`,后续新增的动作与状态姿态都会被 `jump` 吃掉。

红线:桌宠**永不自动决策**审批,只允许 `allowed-once` / `rejected`,不写持久策略,不触碰 OS UAC;
零新依赖;33ms 主路径零新增分配;不新增 GDI 对象(考虑到 `TODO.md` P0 仍有未收敛的偶发挂起)。

## 2026-09-10(深夜,续三) · `cordis_inspect_query`(client) 永久挂起:根因查明 + 本体补丁(第五例)

依据:用户报告「`cordis_inspect_query` · client 这个工具好像总是卡住,看看什么原因」。

### 一、结论

不是「慢」,是**失败即永久挂起**:同一次会话里,查 client 平台不带 input 的目录查询**秒回**,
带 input 的精确查询**挂了 18.6 分钟**直到用户中断。三重原因叠加:

1. Host 侧 `CordisInspectRegistryService.resolveClientQuery` 只接受**成功**的页面应答——
   `if (!resolution.ok) return { accepted: false }` 把错误应答**静默丢弃**,既不 settle 也不清理
   pending;输出 schema 校验失败的 catch 分支同样丢弃。
2. 浏览器侧 `ClientCordisInspectRegistry.query()` 对一次广播**只回一次**,不重试,回执也无人检查——
   于是「客户端拒绝了这次查询」这个信息在链路上被彻底吞掉。
3. `cordis_inspect_query` 未声明 `timeoutMs`,而 `dsh-tool-call-timeout-policy` 对未声明者直接
   `return next()`——没有兜底 deadline。唯一结束路径只剩 `exec.signal` 被中断,也就是人来按 Esc。

触发条件已精确到可预测:客户端 Service 目录只有 8 个 key(`layout` `locale` `sessions` `slots`
`theme` `timer` `uiWorkspace` `workspaces`),查这 8 个以外的 key 会抛
`no catalogued Service named "X"` → 必挂。而 `conversation.*` 是 **Slot** 命名空间,与 Service key
形似,极易混淆——这就是「总是」踩到的原因。同一类错误在 **host 平台会立刻返回**,所以表象是
「host 好好的,client 总卡」。

### 二、实测(逐帧解压 127 个会话日志,13460 条工具结果)

`cordis_inspect_query` 共 163 次调用,其中 client 查询 96 次。key 存在则秒回
(`timer` 0s、`sessions` 1s、`Slots.listSubTree` 各种 root 0–4s),key 不存在则永久挂起:
`conversation` 挂 **1116 秒**、`sessionLogDownload` 挂 **13420 / 3325 / 572 / 407 秒**——
共 7 次真挂死,最长 **3 小时 43 分**,全部以 `Client inspect query … was cancelled` 收场。

> 取证方法备记:DSH 会话日志是 append-only 的**多帧 zstd**,Node 的解压 API 只返回第一帧;
> 需扫描帧魔数 `28 B5 2F FD` 逐帧解压。另:`tool/result` 事件的 callId 在
> `data.message.source.callId`,不在 `data.callId`。

### 三、修复:新增第五个本体补丁

| 补丁 | 目标包 | 改动 |
|---|---|---|
| [`patches/dsh-cordis-host-runner/`](../patches/dsh-cordis-host-runner/README.md) | 官方 host 侧 Cordis runner(`lib/index.js`) | 4 条锚点编辑:失败应答记入 `pending.lastFailure`(仍不 settle,保住多标签页抢答语义)+ 每次查询挂 15s 兜底定时器,到期结算为**带真实拒绝原因**的 `timeout` 错误 + `finally` 清理定时器 |

**不采用「第一个失败就 settle」**:多标签页会同时收到广播,某页没有该 provider 不代表别页也没有,
先到先得只对**成功**应答成立。失败仍不抢答、只记录,由超时兜底收场——「永久挂起」退化为
「15 秒后带准确原因的报错」,多页面语义原样保留。

**本补丁与其他四个的差别**:它改的是 **host 侧 Node 包**(其余四个是浏览器 bundle),
因此**生效必须重启 DSH host 进程**,刷新页面不够。

### 四、自证与验收

`verify` 四项全绿(比 CSS 类补丁多两道,因为注入的是代码):baseline 重建后 SHA 比对 +
重建产物 `node --check` + **拒绝应答行为断言**(把重建产物里真实的 `resolveClientQuery` 抠出来用
最小假 registry 跑,并对 baseline 原版跑反例以证明断言有区分力)+ **超时兜底行为断言**
(注入假 `setTimeout` 手动触发,不真等 15 秒)。已接入 `verify-all.mjs desktop`
(desktop 由 7 项增至 **8 项**,全 PASS)。安装目录已 apply:`58EF79A0…` → `8B81500A…`,
留有 `index.js.dsh-bak` 备份可回退。

用户需执行:**重启 DSH host 进程**(Node 已加载模块不会热更新;重启前查询仍会挂起)→ 复现原用例
(`client/Service/listService` + 不存在的 key,如 `conversation`),预期 **15 秒内**返回
`Error: … timed out after 15000ms … (the client refused it: no catalogued Service named "conversation")`。

### 五、触摸点

`patches/dsh-cordis-host-runner/`(新增 patch.mjs / rebuild-baseline.mjs / README.md /
baseline/index.original.js)、`scripts/verify-all.mjs`(desktop +1 项)、`README.md`
(补丁表「四处」→「五处」+ host/client 生效方式差异说明)、本文件。

## 2026-09-10(深夜,续二) · 轨迹页「首 token 时间不可用」:根因查明 + 两个本体补丁(轨迹/聊天)

依据:用户贴出轨迹页计时面板截图,三行值全是「首 token 时间不可用」,问「轨迹里计时不可用
是怎么回事」。

### 一、结论(先排除环境因素)

三行不是三个故障 —— `ttft()` / `generationTime()` / `throughput()` 共用同一个前置条件
`firstTokenTime`,三行同句只可能是这一个字段为 null(反证:`stepStartTime` 或用量若缺,
它们会先报各自那句)。根因在官方客户端:`firstTokenTime` **只在实时流式 chunk**
(`assistant/live-chunk`)折叠时写入,而该事件是浏览器端 session controller 合成的 transient
事件、**从不落盘**;窗口重建(刷新 / 重开会话 / 切走再切回)后,已结束的步骤只剩 durable
事件,而 `settleMessage()` 不恢复这个字段 → 永久 null。

### 二、实测(数据一直都在)

逐帧解压本会话日志:155 条事件里 `assistant/live-chunk` = **0 条**;23 条 `assistant/message`
每条都带紧凑流 `data.stream`,用官方 `assistantStreamFirstTokenTime` 逐步算得出首 token 时间
(1/1 = 6.70s,其余 0.69–1.49s,均值约 1.1s)。官方 host 侧统计投影 `dsh-session-stats` 走的
正是这条路 —— 所以「统计」对话框里的平均 TTFT 一直正常,只有轨迹/气泡面板没做恢复。

### 三、修复:新增两个本体补丁(本体例外第三、四例)

| 补丁 | 目标包 | 改动 |
|---|---|---|
| [`patches/dsh-client-ui-trajectory/`](../patches/dsh-client-ui-trajectory/README.md) | 官方轨迹页 | 注入 `dshPatchedFirstTokenTime` + timing 回退 → 三行计时恢复 |
| [`patches/dsh-client-ui-chat/`](../patches/dsh-client-ui-chat/README.md) | 官方聊天区 | 同一注入与回退 → 消息气泡 TTFT 与窗口口径兜底统计恢复 |

各 2 条锚点编辑;实时值优先(流式过程行为不变);紧凑流里确实没有 token 时仍返回 null ——
**不编造数字**。

### 四、自证与验收

`verify` 三层(比既有两个补丁多两道,因为注入的是代码而非 CSS):baseline 重建后 SHA 比对 +
**从重建产物里抠出注入函数跑 8 条 fixture 行为断言** + 重建产物 `node --check`。已接入
`verify-all.mjs desktop`(desktop 由 4 项增至 6 项)。安装目录已 apply:轨迹
`73A878B4…` → `C3485ADF…`、chat `4F9CFFF8…` → `BE4C68D5…`,各自留有 `.dsh-bak` 备份可回退。

用户需执行:刷新 DSH Web 页面 → 打开任一**已结束**步骤的计时面板(首 token 延迟 / 生成 /
吞吐量应为数字)→ 悬停消息耗时面板(应出现「首 token 用时(TTFT)」,与轨迹页同一步一致)。

### 五、触摸点

`patches/dsh-client-ui-trajectory/`(新增 patch.mjs / rebuild-baseline.mjs / README.md /
baseline/client.original.js)、`patches/dsh-client-ui-chat/`(同 4 文件)、`scripts/verify-all.mjs`
(desktop +2 项)、`README.md`(补丁表「两处」→「四处」+ 基线与流程说明)、
`design/trajectory-ttft-restore.md`(新增:归因链、方案对比、自证设计)、本文件。

## 2026-09-10(深夜,续) · 展开右栏时让位安全区白空 144px

依据:用户指出「左边的外部按钮和三点扩展按钮位置离展开的右侧边栏太远」。像素实测:展开态
会话头最右控件 `⋯` 的右边界 x=**89**、右栏分栏线 x=**233** —— 中间**空 144px**,正是
2026-09-10(晚) 那条让位规则 `padding-right:var(--ms-titlebar-reserve)`(128px) 加上官方
header 自带 `padding-right:28px` 的残留。

### 一、根因(让位无条件生效,而展开态并不需要)

让位是给**桌面壳窗控**留安全区:收起态中栏延伸到窗口右缘,窗控(占距右缘 [8,116]px)会压住
会话头右端的展开按钮。但**推挤展开时**中栏右边界已退到分栏线内、窗控压的是**右栏**头部,
会话头不该再留那 128px。

判据是关键:**官方右栏 panel 用 `transform:translate(100%)` 移出屏幕、并未卸载** —— 所以
不能用"元素是否存在"判断开合;`data-sidebar-right-open`(与 `data-sidebar-right-panel="push"`
挂在**同一元素**、条件挂载)才是可靠信号。

### 二、修复(第一次尝试失效,第二次才对)

❌ **门控方案(失效)** —— 给让位规则加
`:not(:has([data-sidebar-right-panel="push"][data-sidebar-right-open]))` 门控,指望
"展开态不覆盖 → 官方 28px 自然生效"。**实测无效**:用户回报「还是这样」,像素复测空隙仍是
**144px**(`⋯` 右边界 105、分栏线 249)。原因:注入脚本是 `include_str!` **编译期内嵌**,
**已经发布出去的壳二进制里那份无条件 128px 规则仍在页面上生效**;门控版在展开态"不匹配",
等于**没人去覆盖它**。

✅ **覆写方案(有效)** —— 主动写一条**特异性更高**的规则撤回让位:

    #root:has([data-sidebar-right-panel="push"][data-sidebar-right-open])
      header:has([data-conversation-header-corner]){padding-right:28px}

`#root:has([a][b]) header:has([c])` = (1,3,1) > 原规则 (1,1,1)。28px 即官方 header 的
padding-right(`.wSkVaW_header{padding:10px 28px 0 20px}`),官方若改需同步。canvas 线在
页面级注入里放了**逐字同一条**(热更,刷新即生效),测试用同一条正则同时断言两处。

> **教训**:撤销一条已经"发布"出去的 CSS 规则,**不能靠改原规则** —— 宿主的注入产物可能是
> 编译期内嵌的,运行中那份不会跟着源文件变。要么覆写(特异性取胜),要么请用户重建宿主。
> 这条同样写进了 canvas 线的 CHANGELOG。

### 三、已知限制

浮窗模式(`data-sidebar-right-float-host`)下 panel 仍带 `push`+`open`,会被判为"已展开"而
撤销让位 —— 浮窗不占布局、中栏满宽,严格说仍应让位。浮窗是低频用法,留待需要时补
float-host 判据。

### 四、触摸点

`themes/src/03-switcher.js`(本线)、`src-tauri/injected/theme-init.js`(重建产物)、
canvas 线 `client.js` + `test/header-adaptive.test.js`、本文件。

## 2026-09-10(深夜) · 会话头控件与窗控不在同一水平线(4px 偏差)

依据:用户两张截图 +「展开右侧边栏是对齐的,收起时不在同一水平线」。对两张 PNG 逐控件做
像素切分(连通列分组 + y 范围)量出垂直中心:

| 状态 | 会话头侧控件 | 窗控组 |
|---|---|---|
| 收起(图一) | open-in-app 胶囊 cy=**21.5** / 日志菜单 **22.0** / 右栏展开钮 **22.0** | 徽章 **17.5** / 最小化 **18.0** / 最大化 **18.0** / 关闭 **18.0** |
| 展开(图二) | 全屏 **20.0** / 收起 **20.0** | 徽章 **19.5** / 三键 **20.0** |

即**展开态全部落在 19.5~20.0(齐),收起态分成 22 与 18 两组,相差 4px** —— 用户描述得到量化证实。

### 一、根因(两段:3px + 1px)

1. **3px 来自 titleRow 被撑高**:canvas 线的「对话/会话布」切换器 = `padding:3px×2 +
   border:1px×2 + 按钮 28px` = **36px**,而官方 `titleRow` 的 `min-height` 只有 30px ——
   被撑到 36px 后,行内**所有**控件(含官方的 open-in-app、日志菜单、右栏展开按钮)居中下移
   (36−28)/2 = 4px;窗控是 `position:fixed`,不跟着动,于是分成两组。这一截由 canvas 线
   收敛(总高 36 → 30px),本项目内不重复实现。
2. **1px 是官方两处的固有差**:会话头 `padding-top:10px + min-height:30px`、28px 控件居中
   ⇒ 中心 **25px**;而 dockkit strip(10px + 28px)与窗控组(`top:11px` + 26px)都是 **24px**。
   展开态因为会话头侧没有可比控件(该行只有右栏自己的 chrome)而看不出来。

### 二、修复(本线一处)

`themes/src/03-switcher.js` 常驻 CSS 增一条,把会话头三个容器整体上移 1px:

    #root [class*="_headerActions"],#root [class*="_headerUtilities"],
    #root [class*="_headerCorner"]{position:relative;top:-1px;}

选择器用 `[class*="_xxx"]` 子串锚点(hash 前缀随版本变,后缀稳定),与本线已有的
`[class*="sessionLogButton"]` 同一套稳健做法。**只位移不改布局**:`top:-1px` 不参与 flex
计算,控件仍在 header 的 padding 内,不会被裁。

### 三、验收

- canvas 侧:`node --check client.js` 通过,全量单测 **84 项全绿**(含新增的高度契约 1 项);
- 本线:`build-init.mjs` 重建注入产物(68 KB,令牌校验通过);
- `verify-all.mjs canvas desktop` **10/10 + 5/5**;
- **用户待执行**:重启 `dsh web`(canvas 侧的 client bundle)+ 重启桌面壳(主题注入生效)。
- **复验点**:收起态下 `⋯`、右栏展开钮与窗控三键落在同一水平线(预期全部 cy≈24)。

### 四、触摸点

`themes/src/03-switcher.js`、`src-tauri/injected/theme-init.js`(重建产物)、本文件。

### 五、生效链路(本次踩到的坑,后续改动同理)

> 附:那条 1px 基线补偿**已经生效** —— 走的是 canvas 的页面级注入(热更通道),用户刷新页面后
> 实测左 `[📁⌄]` cy=21.5 / `⋯` 22.0、右 `⊙` 21.5 / `[ ]`·`□|` 22.0 / 窗控 22.0,全部落在
> 21.5~22.0。本文件里的同源规则等下次重建壳时自然一致。

`src-tauri/src/main.rs` 用 `include_str!("../injected/theme-init.js")` 把注入脚本**编译期内嵌**
进 EXE —— 所以改 `themes/src/*` 并跑过 `build-init.mjs` 之后,**还必须重新构建壳再启动**,
否则新规则只躺在源文件里。本次实测证据:壳(pid 26840,`dist/Miasaki.exe`)启动于 21:01、
注入产物重建于 21:41、release 二进制却是 19:17 构建的 —— 用户随后量到的仍是未补偿的 1px,
即"规则没进二进制"的直接证据。

> 这条链路对 1px 级别的调整代价过高,而"会话头控件与右栏 dockkit chrome 差 1px"在**纯浏览器**
> 下同样存在(右侧没有窗控做参照也一样差)。因此 canvas 线已在**页面级注入**里加了同源规则
> (支持 client-hmr,刷新即生效)。**两处值必须一致** —— canvas 的
> `test/header-adaptive.test.js` 会同时断言本文件里的 `top:-1px` 仍在,防止只改一处。
> 本文件里的那条**保留**:它是"桌面壳让位"系列的正式归属,不依赖 canvas 插件是否加载。

## 2026-09-10(晚,续) · 会话头窄宽度溢出保护:第二个本体补丁

依据:用户报告「展开右侧边栏会挤压」+ 截图 —— 会话头里 canvas 的「对话/会话布」切换器被
右侧图标按钮压住、会话标题消失。归因与方案见 canvas 线
`design/2026-09-10-conversation-header-crowding-fix.md`。

### 一、根因(官方会话头缺溢出保护)

官方把会话头一行分成:titleCluster(`flex:1; min-width:0`,可被一路压到 0)、
headerUtilities / headerCorner(均 `flex:none`,不收缩),而 titleCluster 内部的
`headerActions` 同样是 `flex:none`。中栏被右栏推窄到「固定项之和」以下时,titleCluster
被压到 0,其内部 flex:none 的 actions 无处安放 → **溢出**,并与同样从 x≈0 起画的
utilities 重叠(DOM 靠后者在上层);标题被 `crumbs` 的 `overflow:hidden` 先裁没,是同一
机制的自证。固定项合计 ≈411px(内边距 48 + 创造模式 95 + 后台任务 32 + canvas 切换器 116
+ gap 16 + utilities 84 + corner 20)⇒ 中栏窄于 ≈410px 必然重叠。现场佐证:用户拉宽
窗口后重叠消失、标题回归。

### 二、修复:新增 `patches/dsh-client-ui-conversation/`(本体例外第二例)

一条 CSS 片段替换(锚点唯一,不唯一即报错,宁可失败不瞎改):

    -.wSkVaW_headerActions{flex:none;align-items:center;gap:8px;display:flex}
    +.wSkVaW_headerActions{flex:0 1 auto;min-width:0;align-items:center;gap:8px;display:flex;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
    +.wSkVaW_headerActions::-webkit-scrollbar{display:none}

溢出从「压叠」退化为「可横向滚动」,控件始终可达。补丁规则 + baseline(官方原版 647,101 B,
SHA `81314DFD…`)+ CLI(verify/status/apply/revert)+ `rebuild-baseline.mjs` 一并入库。

> 与 settings-models 补丁的差别:**不存 patched 全文**(目标 632KB,再存一份不划算),
> 产物以 `PATCHED_SHA256`(`D9A841DE…`)记录,verify 用「重建后 SHA 是否等于该常量」自证
> —— SHA 相等即逐字节相等,锚点失配时仍会响亮报错。
>
> 代价:DSH 升级覆盖该包后需 `rebuild-baseline.mjs` 重建基线并重打(流程见补丁 README)。

### 三、配套(canvas 线,同日)

canvas 的 `ViewSwitch` 增加运行时自适应:`ResizeObserver` 观察 `closest('header')`
(不能观察自身 —— 自身是 `flex:none`,被挤压时宽度不变,观察自身检测不到溢出),留给标题的
余量不足时收成图标形态(≈116 → ≈64px),进入 120 / 退出 200 的滞回避免抖动,图标形态下
`aria-label` / `title` 保留可访问名;新增 `test/header-adaptive.test.js` 4 项。
**canvas 侧保住可用性,本补丁保证任何插件 / 任何窄窗口都不再压叠**,两者独立、任一单独生效
都有明显改善。

### 四、验收

- `node patch.mjs verify` PASS(1 条编辑,产物 SHA 与记录一致);
- `node patch.mjs apply` 成功(647,226 B,安装目录已 `patched`,备份 `client.js.dsh-bak` 已建);
- `verify-all.mjs desktop` **5/5 通过**(新增该项离线自证);canvas 全量单测 83/83。
- **用户待执行**:刷新页面即生效(host 启动早于本次写入,`client-hmr` 会热推 rebuilt 帧);
  canvas 侧的自适应需重启 `dsh web`(client bundle 在启动时载入内存)。

### 五、触摸点

`patches/dsh-client-ui-conversation/{patch.mjs,rebuild-baseline.mjs,README.md,baseline/client.original.js}`(新)、
`README.md`(补丁章节由「唯一一处」改「两处」+ 对照表)、
`patches/dsh-client-ui-settings-models/README.md`(「唯一例外」表述改为并列)、
`scripts/verify-all.mjs`(desktop 增第 5 项)、本文件。

## 2026-09-10(晚) · 窗控 × 官方右栏:右上角安全区让位(V4 让位规则重写)

依据:用户升级到 DSH 0.1.5-rc.1 后的两张截图 —— 折叠态下官方「打开右侧边栏」按钮被窗控
徽章压住,展开态下官方面板的「全屏/收起」两键与窗控的最小化/最大化/关闭几乎完全重合,
即「窗控与新右侧边栏的关闭与展开都不适配」。

### 一、根因(两处让位全部失效,且是两条独立的失效路径)

DSH 0.1.5 的官方右栏(`ui-sidebar-right`)把两个控件放在了桌面壳窗控的必经之路上。窗控裸键
组实测宽 = 徽章(16+4×2) + 三键(26×3) + gap(2×3) = **108px**,加 `right:8px` 后恒占
**距窗口右缘 [8,116]px** 这一带;而 v4 时代留下的让位规则
`#root header:has([role="tablist"]){padding-right:118px}` 同时踩了两个坑:

| # | 位置 | 官方几何 | 与窗控的实际交叠 |
|---|---|---|---|
| ① | 折叠态:`conversation.session.header.corner` 的 ExpandButton(`data-sidebar-right-expand`) | 官方给 corner 挂 `margin-right:-16px`,118px 让位实际只让出 **102px** | **14px 硬叠压**;更糟的是 `[role="tablist"]` 那一行官方只在 view tab 数 >1 时渲染(`tabs.length>1`),单 tab 会话下**整条规则静默失效**,corner 回到距右缘 12px → 叠压 32px |
| ② | 展开态:dockkit strip 末端的 PanelChrome(`data-dockkit-strip-chrome`:全屏 + 收起) | 该 strip 官方只有 `padding-right:6px`,两个 28px 按钮占距右缘 **[6,70]px** | 与窗控 close[8,34] / max[36,62] **几乎完全重合** —— 旧规则压根不覆盖这一处 |

叠加顺序上窗控 `z-index:100000` 远高于官方 UI,因此表现是「官方按钮被盖住、双方都难点」。

### 二、修复(`themes/src/03-switcher.js` 常驻 CSS)

1. **让位锚点换成恒存属性**(不再依赖 `role=tablist`):
   - `#root header:has([data-conversation-header-corner]){padding-right:var(--ms-titlebar-reserve)}`
     —— corner 容器在任意活跃会话下都恒在 DOM(`:empty` 时仅 `display:none`),选择器不再随 tab 数抖动;
   - `#root [data-conversation-header-corner]{margin-right:0}` —— 抵消官方的 -16px 负边距,否则
     按钮会反向探入安全区 16px;
   - `#root [data-sidebar-right-panel] [data-dockkit-strip-chrome]{margin-right:calc(var(--ms-titlebar-reserve) - 6px)}`
     —— 直接作用在 chrome 容器上。dockkit 只在 `chromePaneId`(分栏时的**最右一格**)渲染该容器
     (`data-dockkit-strip-chrome` 为恒存属性),因此分栏左格天然不受影响;`-6px` 是补掉 strip 自带的
     `padding-right`,使 ② 与 ① 落在同一条安全线上。浮窗(`[data-sidebar-right-float-host]`)不在
     `[data-sidebar-right-panel]` 内,不受此规则影响。
2. **安全区变量化**:`:root{--ms-titlebar-reserve:128px}`(= 窗控组 116px + 12px 呼吸位)。
   变量名与 sidebar 线 `design/2026-09-09-sidebar-launcher-design.md` §5 的规划一致 —— 该线若将来
   用 `measureChromeReserve()` 量测 `.tb-group` 宽度写 `documentElement.style`,inline 变量会**自动
   覆盖**这里的默认值,两侧无需再改选择器。
3. **垂直对齐(优化项)**:`.tb-group` 的 `top:5px` → `top:11px`。官方视图控件的垂直中心落在
   24~25px(会话头 titleRow = header `padding-top:10px` + 30px 行高内居中;dockkit strip =
   `padding-top:10px` + 28px 高),旧值让窗控中心停在 18px,比官方低 6~7px;改后中心 24px 与之齐平。

选择器一律带 `#root` 提权:官方 CSS Module 是运行时插到 head 末尾的,注入时机晚于我们,
同特异性会被反超。

### 三、验证(`npm run verify`,无头 Edge + 真实 DSH 页面,视口 1280)

`scripts/verify-themes.mjs` 新增第 6 节「右上角安全区」,在真实页面上量矩形(该脚本会把完整
注入层 `Page.addScriptToEvaluateOnNewDocument`,因此页面上同时存在窗控按钮组与官方右栏):

| 断言 | 实测 |
|---|---|
| 安全区变量覆盖窗控组 | `--ms-titlebar-reserve=128px`,窗控组宽 108px |
| 折叠态:窗控组 × 「打开右侧边栏」 | overlap **0px²** —— 窗控[1140..1248] / 官方[1100..1128],间隔 12px |
| 展开态:窗控组 × 面板 chrome | overlap **0px²** —— chrome[1064..1128] |
| 展开态:窗控组 × 「收起」/「全屏」 | 各 **0px²**,收起键[1100..1128] / 全屏键[1064..1092] |
| 与官方控件同一水平线 | 中心差 **Δ=0px** |

同轮 22/24 项通过;两项 FAIL(`pure: html[data-miasaki-theme]` 得到 `zafkiel`、`pure: 无水印`)
是 `.edge-test-profile` 里 localStorage 的**上次运行残留**(第 4/5 节持久化断言本轮 PASS),
与本轮改动无关 —— 需要干净基线时删掉该 profile 目录重跑即可(需重新登录 DSH)。

### 四、变更文件

| 文件 | 改动 |
|---|---|
| `themes/src/03-switcher.js` | 让位规则重写 + `--ms-titlebar-reserve` + `.tb-group` top 11px |
| `scripts/verify-themes.mjs` | 新增第 6 节安全区断言;`--window-size=1280,860`(让视口贴近桌面壳) |
| `src-tauri/injected/theme-init.js` | `npm run gen-init` 重新生成(构建产物,不入库) |

**待用户执行**:`cd dsh-miasaki-desktop && npm run gen-init && npm run tauri dev`(或重打 release)
后重启桌面壳;人工目检项:三主题下右上角无叠压、窗控与官方展开/收起键同高。

## 2026-09-10(深夜) · token-monitor v0.5.1:span 快照重复回写修复 + 分布显示优化

依据:v0.5.0 重启后用户实测截图(主问题已解决 —— 会话列全是可读中文标题),
反馈「优化显示」;同时本轮排查发现账本长期膨胀。

### 一、span 快照重复回写(账本 19% 是纯冗余)

**根因**:`loadLedger()` 载入 `type:'span'` 行时经 `touchSpan` 把这些键**重新标脏**,
而 `process.on('exit')` 的 `flushLedger(true)` 是**强制写**(刻意绕过节流判断),
于是每次 host 正常退出都把全部存量快照重写一遍。

**对照实测**(真实退出路径 `process.exit` → exit 钩子;合成账本含 45 个 span 存量):

| 版本 | 退出前 | 退出后 | 增量 |
|---|---|---|---|
| 未修复 | 46 行 | 92 行 | **+46**(45 行存量重复 + 1 行真实推进) |
| 已修复 | 46 行 | 47 行 | **+1**(仅本次真实推进的那个会话) |

**影响面(本机真实账本)**:4884 行中 span 行 998、去重后仅 51 个唯一
`(date|sessionId)` —— **947 行为纯冗余(19%)**,单键最多重复 82 次(≈ 重启 82 回)。
幂等快照不改统计结果(载入即 min/max 合并),但文件不可逆地膨胀。

**修复**:`touchSpan(date, sessionId, ts, dirty)` 增 `dirty` 形参,载入路径传 `false`
(存量已在磁盘上,不再标脏);本次真实推进的会话**照常**在退出时落盘(实测 +1 行,功能未削弱)。

**存量清理**:新增 `plugins/dsh-token-monitor/scripts/dedupe-usage-ledger.mjs`
(默认预演,`--apply` 才写,`--file` 可指定),按 `(date, sessionId)` **无损合并**为一行
(取 min first / max last,与载入语义完全一致),写盘前做**语义等价校验**
(用量聚合 + span 合并摘要比对),不一致直接拒绝写入;执行前自动备份 `.bak-<时间戳>`。
实测:4884 → 3937 行、1.13 MB → 983 KB(**省 148 KB**),语义校验一致。

### 二、分布显示优化(用户截图反馈)

| 截图里的问题 | 改法 | 依据 |
|---|---|---|
| 条带渲染成"一整条灰带 + 右侧一个深块" | 改**底部对齐的迷你柱**:空日只留 3px 基线、有量给 5–18px 高柱(高度 + 透明度双编码) | 实测按会话维度填充率仅 4%,等高画法必然满屏灰且看不出趋势 |
| `近 7 日` 挂在「使用分布」区头部 | **口径错位** —— 它只作用于模型环形图,会话分布固定近 30 日;移到模型卡标题旁 | `models` 由 `trend.slice(-range)` 得出,列表则固定 30 日 |
| `298 轮消息` 占宽 | 压成 `298 轮`;占比列 120 → 96px、数值列 78 → 84px,宽度让给条带 | — |
| 10 行两行式文本连排容易串行 | 行间加极细分隔线(`.tokmn-sess-row + .tokmn-sess-row`) | 对齐参考图的行间细线 |
| 默认 Top 10 却要滚动才看全 | 列表限高 376 → **420px**,默认档恰好一屏放满 | 行高约 42px × 10 |

**形态实测**(真实账本 + ASCII 化,`·` = 空日基线):

```
会话维度   97768382   7%  ························▆█····
目录维度   552890592  20%  ························▅▄▃▄▃█   ← 同项目多会话叠加后成形
```

### 三、二轮回修(交付后第二轮用户截图)

用户刷新后再截图,暴露四处**布局溢出** —— 其中第一处是本轮改动**引入的回归**,
另三处是既有问题(超长模型名 + 缺收缩约束):

| 现象 | 根因 | 修法 |
|---|---|---|
| 模型列表的百分比跑到卡片外、叠到右列卡片上 | 上一轮把 `.tokmn-dist` 左列收窄成 `minmax(300px, 380px)`;`.tokmn-donut` 的 `1fr` 与 `.tokmn-dist` 两列都受 grid 项默认 `min-width: auto` 约束 → 列被撑到 min-content,`.tokmn-pct` 的 `margin-left: auto` 被推出卡片 | 三处 `minmax(0, …)`(`.tokmn-dist` 两列 + `.tokmn-donut` 列表列)+ `.tokmn-pct { flex: none }`;左列改比例 `minmax(0,1fr) minmax(0,1.15fr)`,不再定宽挤压 |
| 趋势图悬浮提示被面板右边界裁掉、数字看不见 | `.tokmn-tip { white-space: nowrap }` 遇超长模型名(`deepseek-v4.1-flash-expires-on-0910`)把提示框撑宽,而定位仍按硬编码 `chartWpx - 190` 留位 | 提示框 `max-width: 340px; overflow: hidden`;模型名走 `.tokmn-tip-name`(flex + ellipsis)、数值 `.tokmn-tip-val { flex: none }`;定位改按实际上限留位(`- 366`);热力图 tooltip 的硬编码 `cr.width - 170` 同步改 `- 366` |
| 悬浮提示列出 8 个模型、其中 7 个当日为 0 | `hoverRows` 对 `visibleModels` 只做 map + sort,未过滤 | 加 `.filter((r) => r.v > 0)` —— hover 明细回答的是"这天用了什么" |
| 卡头 meta「近 30 日 · 共 3 个工作目录」被卡片边界裁掉 | 标题区 div 是 flex item 却缺 `min-width: 0`,不可收缩 | 新增 `.tokmn-sess-head-l`(flex + `min-width: 0`):标题 `flex: none`、meta `flex: 0 1 auto` + ellipsis |

**验证边界(如实记录)**:JS 侧(过滤逻辑、类名、定位数值)已静态复核 + 语法检查通过;
**CSS 布局效果无法在本机自动验证**(浏览器工具屏蔽本地地址),需刷新页面目检 ——
四处都属"约束缺失"类问题,修法是 CSS 布局的确定性规则(`minmax(0,…)` 允许收缩、
`flex: none` 防压缩),但视觉效果以实际渲染为准。

**同批(用户点名)**:「模型用量」的悬浮信息补全。`models` 此前只有 `label`(显示名,同名
跨供应商时带 provider 前缀)与 `provider`,列表 hover 给的是 `title: m.provider` —— 悬浮
只看到供应商名,而窄列**必然**把模型名截断(`deepseek-v4.1-flash-exp…`),等于没给。补
`model: nm` 字段后,三处 hover 统一改为给出完整模型名:

| 位置 | 改动 |
|---|---|
| 模型列表名称 | `title: m.model + " · " + m.provider`(原为只给 `m.provider`) |
| 趋势图图例 chip | 同上 + `" · 点击显示/隐藏"` |
| 环形图扇区 | **新增** SVG 原生 `<title>`:`模型名 · 用量 · 占比` —— 扇区此前 hover 不出任何信息(只有颜色,无图例对应关系) |

### 四、用户需执行

`lib/client.js`、`lib/index.js`、`package.json` 覆盖为仓库最新 → **刷新页面**
(client 半按请求读盘);界面未变再重启 host。本次未改协议,`usage-log.jsonl`
与 `config.json` 格式不变(清理只删重复行,未动任何用量行)。

## 2026-09-10(深夜·续) · hash 同步通道节流:33ms → 基准 150ms + 自适应退避

依据:本轮对 09-01 → 09-04 改动的审查。**未在该区间找到直接致命改动**,但发现一条**长期存在**
的结构性风险链路,本次予以削弱。

### 一、审查结论(09-01 → 09-04 逐项核查)

| 改动 | 结论 |
|---|---|
| `pet_native.rs` 1433 行 → 拆 6 模块 | 纯重构;`Arc<Mutex<PetShared>>` 语义与锁范围未变 |
| 注入层 `themes/runtime.js` → 拆 9 文件 | 纯重构;**定时器周期完全一致**(旧版亦为 `PET_TIER_MS = 1500`,1s 自愈巡检同样存在) |
| `main.rs` +57 行 Fleet 脉冲看门狗 | **从未启动** —— `MIASAKI_FLEET_PULSE` 未设,函数首行即 `return`;pet.log 无任何 `[pulse]` 行 |
| GDI 兜底(ULW 失败计数 / 表面重建) | **从未触发** —— pet.log 中 `ULW failed` 计数为 0 |

→ 区间内无「冒烟的枪」;**嫌疑未能在该区间收口**。

### 二、发现的结构性风险(非 9/4 引入)

`start_hash_watchdog` 每 **33ms** 调用一次 `wv.url()`。在 Tauri 2.11.5 中该路径为:
tokio 线程 → `run_on_main_thread` → **无超时阻塞等待**(`rx.recv()`)→ 主线程执行 WebView2
`ICoreWebView2::get_Source()` **同步 COM 调用**。而注入层每 **1.5s** 才 `replaceState` 一次
—— **45 倍冗余轮询**。一旦渲染侧无响应,这条 30 次/秒的同步链路会把「局部卡顿」放大为
「整个 UI 冻结」(黑屏 + 托盘无响应 + 关闭失效,与四次挂起现象吻合)。

**推理修正**:pet.log 停写**不等同于** tokio 线程卡住 —— 更可能是渲染进程先停摆,注入层
`setInterval` 不再执行、hash 不再变化,于是 watchdog 每轮走 `continue`(该分支不写日志)。
即:**渲染侧压力是因,33ms 同步轮询是放大器。**

### 三、改动(`src-tauri/src/main.rs`,一处函数 + 一处拖窗分支)

- 新增常量:`HASH_POLL_MS = 150` / `HASH_POLL_FAST_MS = 33` / `HASH_SLOW_MS = 250` /
  `HASH_BACKOFF_MS = 1000` / `HASH_BACKOFF_HOLD_MS = 3000` / `HASH_DRAG_HOLD_MS = 400`。
- 轮询间隔由固定 33ms 改为**三档决策**(优先级:退避 > 拖窗提速 > 基准):
  ①**基准 150ms**;②**拖窗期间保持 33ms**(`move=` 出现即置 `drag_until`,松开 400ms 后回落
  —— **不牺牲拖动跟手**);③单次 `url()` 耗时 ≥250ms,或连续失败 ≥3 次 → **退避 3s 内用 1000ms**。
- 新增诊断日志(便于下次挂起时判读):`hash poll slow {n}ms → backoff 3000ms`(前 5 次 +
  每 50 次)、`hash poll url() failed x{n}`(首次 + 每 20 次)。
- **净效果**:主线程上的 WebView2 COM 调用由 **30 次/秒 → 6.7 次/秒(-78%)**,
  异常时自动降至 **1 次/秒**;卡顿撞上轮询的概率同步下降。

### 四、验证

- `cargo build --release` 通过(**31.30s,无编译错误**)。
- 产物 `target/release/miasaki.exe`:PE 时间戳 **`6aa28262`**(2026-09-10 18:11:46),24.5 MB;
  二进制串校验 `hash poll slow` / `hash poll url() failed` / `MIASAKI_NO_MICA` /
  `mica skipped (MIASAKI_NO_MICA)` **均存在**。
- **体积较上一版小 16.3 MB 属预期,已核实非缺件**:工作区删除了 5 个**切帧用源素材**
  (`pets/{kurumi,whale}/spritesheet.webp`、`pets/inverse/raw/blue-{deep,idle,work}.png`,
  合计 16.3 MB,与差值精确吻合);逐条核验 `assets.rs` 的 **75 条内嵌引用零缺失**,且
  **不引用**上述任何文件(运行时只读切好的 `frames/` 与 `states/`)→ 产物功能完整。

- **修订(收尾整理):上述 5 个文件**全部恢复入库**(合计 16.3 MB)。**
  原核验只覆盖了**运行时**(那部分结论依然成立:`assets.rs` 不引用它们,只读切好的
  `frames/` 与 `states/`),**漏核了构建链** —— 逐条查证后,5 个文件各有脚本消费,删掉即断链:

  | 文件 | 消费者(脚本内的真实读取点) |
  |---|---|
  | `pets/kurumi/spritesheet.webp` | `scripts/build-init.mjs:15`(webp→png 图集转换,产物即被追踪的 `spritesheet.png`)、`scripts/make-icons.mjs:14`(图标裁切源) |
  | `pets/whale/spritesheet.webp` | `scripts/build-init.mjs:15`(同上转换) |
  | `pets/inverse/raw/blue-{deep,idle,work}.png` | `scripts/inverse-states.mjs:30,48`(`RAW` 是其唯一输入,抠出 `states/*.png`) |

  另:`ui/pets/{whale,kurumi,inverse}/pet.json` 的 `spritesheetPath` 均指向 `spritesheet.webp`。
  **为什么删了却没被发现**:`build-init.mjs` 的转换带 `existsSync(src)` 守卫,源缺失即**静默跳过**
  —— 删掉 webp 后 `verify-all` 的 `gen-init` 仍 PASS(用旧的 `spritesheet.png` 顶替),
  断链不会自己暴露。**教训:大素材的"能不能删"必须核对脚本输入,而非只核对运行时引用。**
  **结论:本次瘦身全部回退,仓库体积与上一版持平;运行时产物不受影响(删或恢复均不进
  `assets.rs`)。**

- **触摸点**:`src-tauri/src/main.rs`;`README.md`(§桌宠设置面板 通信段);本文件。
  新增 `_refs/scripts-archive/deploy-miasaki.ps1`(部署脚本,自动等待进程退出 + SHA256 校验)。
- **验证点(用户执行)**:先**退出桌面端**(运行中会锁定 `dist/Miasaki.exe`),再运行
  `deploy-miasaki.ps1` 完成部署;启动后**拖动窗口应仍跟手**(拖窗档 33ms),常态下 pet.log
  仅在异常时出现 `hash poll slow` —— 若长期无该行,即说明 UI 线程未再被同步调用拖住。

## 2026-09-10(升级会话) · DSH 0.1.5-rc.1:persona 拆分致三个 preset 失效,改为模板生成

**现象**:DSH 全局升级到 `0.1.5-rc.1` 后,`whale` / `kurumi` / `inverse` 三个 agent preset 全部失效。

**根因**(已核实,非推测):`@deepseek-ai/dsh-persona` 的 Config schema 在 0.1.5 由单字段改为前后缀:

```js
// node_modules/@deepseek-ai/dsh-persona/lib/index.js
prefix: z.string().required(),        // ← 必填
suffix: z.string().default(""),       // 缺省为空,且**缺省即遮蔽部署级后缀**(不继承)
complete: z.boolean().default(false),
includeRuntimeContext: z.boolean().default(true),
```

旧字段 `config.text` **已不存在**,而三个 preset 里写的仍是 `text:` → schema 校验必然失败,preset 无法加载。这正是 0.1.5 release note 所说「自定义 persona 配置拆分为前缀和后缀」。

**底座差异**:把用户侧 `whale/agent.cordis.yml` 与 0.1.5 的 `dsh-agent-presets/presets/standard/agent.cordis.yml` 逐行 diff,共 6 处:

| 处 | 0.1.5 底座 | 本仓库自定义 | 处置 |
|---|---|---|---|
| persona 行 | `suffix` + `prefix` 两字段 | 原 `text`(自包含 model 与 cwd) | 映射到 `prefix`,**不设 suffix** |
| goals 段 | 新增 `command-goal` 行 | — | 采用底座 |
| delegation 注释 | 删去 tool-subagent-report 段 | — | 采用底座 |
| tool-subagent | 新增 `modelSelectionSettings: true` | `agentOptions` → openrouter / z-ai/glm-5.2:free / 32768 | **两者都保留** |
| tool-subagent-fork | 删去 `agentOptions`(注释说明:fork 继承父模型才能复用 KV Cache) | 同上 `agentOptions` | **保留自定义**(放弃该优化换子 agent 免费) |
| tool-web | `fetch: true` | `fetch: false` | **保留自定义** |
| 文件末尾 | 新增 `present` 行(`@deepseek-ai/dsh-tool-present`) | — | 采用底座 |

**改动**:

1. **新增 `preset-sources/agent.base.cordis.yml`** —— 0.1.5 `standard` 底座全文,persona 行改为占位符 `__PERSONA__`,本仓库三处自定义已就地合并并加注释标注。
2. **`apply-presets.ps1` 重写** —— 从"在已安装底座上做 persona 文本锚点替换"改为**读模板整体生成**。旧做法的 `$oldText` 锚点是 0.1.2 的模板措辞,底座一变就 `throw "persona anchor not found"`;新做法幂等、不依赖底座措辞,覆盖前留 `.bak`。
3. **新增 `preset-sources/verify-presets.cjs`** —— 校验产物:persona 字段形状、自定义项是否保留、0.1.5 新增行是否就位。自带 `!!js` 标签 schema(preset 里的 `disabled: !!js process.platform === 'win32'` 会让标准 js-yaml 报 unknown tag)。
4. **用户侧 `~/.dsh/.agent-presets/<id>/` 从此是生成产物** —— 不再手改,改动一律进 `preset-sources/`。

**验证**:以 `$env:USERPROFILE` 指向临时目录干跑脚本,三个 preset × 12 项检查全部通过(prefix 存在、text 已移除、suffix 未设、含 `{{model}}`/`{{cwd}}`、多行块、两处 agentOptions 保留、fetch=false 保留、command-goal 与 present 就位)。

**补丁重打(同日完成)**:`patches/dsh-client-ui-settings-models` 被本次升级覆盖(`status` 报 `unknown`,`.dsh-bak` 丢失)。核对结果:**7 个锚点在新版 client.js 中全部唯一命中**(新版 138,937 B,比 0.1.2 多 1,236 B),`insertAfterOffset` 的期望值检查也全部通过 —— 因此**未改动任何 EDITS**,只换了两份 baseline 并更新三个常量(`BASELINE_DSH_VERSION` → `0.1.5-rc.1`、`ORIGINAL_SHA256` → `A60FD863…`、`PATCHED_SHA256` → `E602C1F1…`)。`verify` PASS(7 条编辑逐字节一致),`apply` 成功(144,576 B,安装目录已 `patched`,备份 `client.js.dsh-bak` 重建),`verify-all.mjs desktop` **4/4 通过**。基线沿革已记入补丁 README。

## 2026-09-10(深夜) · 【重大更正】Mica 假设被推翻:首挂早于 Mica 上线 4h44m

依据:对上方 WER 取证结果的交叉验证。**本轮推翻 2026-09-09 条目的核心论断**,无代码改动,
只更正认知并重定向排查方向。

### 一、Mica 假设不成立(三重独立证据)

2026-09-09 条目称「挂起首次出现在 9/05,与当日「标题栏与主界面融为一体(Mica)」同日 →
时间拐点指向 Mica」。该推断**只比对了日期,未核实 9/05 当天的先后顺序** —— 而首挂其实
**早于** Mica:

| # | 证据类型 | 内容 |
|---|---|---|
| 1 | 运行时 | pet.log 中 `mica backdrop applied` **首次**出现在 **09-05 22:43:28**;此前每次会话(含 17:57:23 启动、17:59:27 挂起的那次)启动段**全无 mica 行**,亦无 `mica unavailable` |
| 2 | 二进制 | 首挂 WER `P3=6a9a7b15` = **09-04 16:02:29** 构建的产物(对照:旧 dist 备份为 `6aa0269d`/09-08 23:15,系**另一次**构建) |
| 3 | 提交 | Mica 改动(`DWMWA_SYSTEMBACKDROP_TYPE` 与 `.shadow(true)`)由提交 **8f48216(09-06 01:26)** 引入 `main.rs` |

→ **首挂(09-05 17:59:27)比 Mica 首次运行早 4 小时 44 分、比其提交早约 7.5 小时**,
因果方向不成立。

### 二、新证据:挂起签名跨产物恒定

| 次序 | 时刻 | P3(产物) | 构建时间 | 含 Mica | P4(HangSig) | P5(HangType) |
|---|---|---|---|---|---|---|
| 1 | 09-05 17:59:27 | `6a9a7b15` | 09-04 16:02 | 否 | `c27d` | `67246080` |
| 2 | 09-09 00:52:37 | `6aa0269d` | 09-08 23:15 | 是 | `c27d` | `67246080` |
| 3 | 09-09 01:09:02 | `6aa0269d` | 09-08 23:15 | 是 | `c27d` | `67246080` |
| 4 | 09-10 17:01:07 | `6aa0269d` | 09-08 23:15 | 是 | `c27d` | `67246080` |

- **P4/P5 四次完全相同** → 同一挂起模式,不是随机噪声(也与「首挂与后三次成因可能不同」的
  猜想相左:签名一致,更像**同一成因**、只是首挂那次 fault bucket 归并不同)。
- **产物跨越两次构建**(且首挂那次**不含 Mica**) → **排除「某一次构建引入的缺陷」**,
  指向长期存在的代码路径或环境侧因素。
- **嫌疑区间收窄**:产物 `6a968676`(09-01 16:01,即根 `dist/Miasaki.exe`)在 9/1~9/4 支撑
  多次会话且**零挂起** → 引入区间锁定在 **09-01 16:01 → 09-04 16:02**,对应 CHANGELOG
  2026-09-04 条目所载「运行时拆分 / 桌宠模块化 / GDI 兜底 / 令牌漂移 / Fleet 指示器」。

### 三、跨进程挂起已排除(更正上方条目的疑点)

上方条目注意到 `ConsentKey=AppHangXProcB1`。经查**该字段不表示实际跨进程**:真正的
`AppHangXProcB1` 在**事件日志 `Event Name`** 处即写作 `AppHangXProcB1`,且问题签名
**`P6` = 被等待的进程名**(实例见 Microsoft Q&A:`P1: explorer.exe … P5: HangType
P6: svchost.exe`)。本机四次事件的 **`Event Name` 均为 `AppHangB1`、`P6` 均为空**
→ **非跨进程挂起**。

### 四、新增(未确证)线索:WebView2 更新节奏

`EdgeWebView\Application\SetupMetrics` 记录的更新活动:09-02 13:32、09-03 11:54、
**09-05 00:00:26**、**09-06 22:59:41**(后者与 WebView2 目录 `152.0.4191.66` 的创建时间
09-06 22:59:36 吻合);首挂在 09-05 00:00 那次更新后约 18 小时。**反向证据**:事件日志自
7/23 起**只有 Miasaki 挂起**,本机其他 WebView2 应用(微信等)均无记录 → 若为运行时通用
缺陷应波及他者,故更像 Miasaki 特有路径。**列为待验假设,不作结论。**

### 五、A/B 的价值重估

Mica 既已排除,`MIASAKI_NO_MICA` 关闭组由「主验证」降为「最终确认」(成本低,可继续跑,
但已不在关键路径上)。**真正的瓶颈仍是缺挂起瞬间的线程栈**:WER 无 dump、`LoadedModule`
为 0,含栈定位不可得。

- **触摸点**:本文件;`design/TODO.md`。**无代码改动**。
  (`_refs/scripts-archive/read-wer-hang.ps1` 本轮升级:导出完整 Report.wer 供离线分析)

## 2026-09-10(晚·续) · token-monitor v0.5.0:**会话活跃分布** + 会话身份折叠

依据:用户实测反馈 —— 「用量统计里的**会话用量不清晰**」,进一步澄清为
「**显示的是一串内部编号,不清楚是哪个会话,这才是问题所在**」;同时给出一张
「工作空间活跃分布」参考图(名称 | 数值 | 占比·会话数 | 行内迷你分布条 +
排序键/搜索/条数三组控件)作为设计路径。

### 一、根因(先查清楚再动手)

1. 账本 `usage-log.jsonl` 按 `sessionId` 聚合,**本身不含标题**;
2. 旧实现唯一标题来源是 `ctx.sessions.get(id)` —— 那是**内存 store**,只认当前
   活着的会话,已归档会话一律 `undefined` → 降级成截断 ID。实测账本 45 个会话中
   绝大多数属第二类,于是整列编号。

### 二、方案与实测依据(不靠猜 API)

- 用 Inspect 查 `Service.listService` 后锁定 `ctx.sessionQuery`:
  `readTitleSnapshots(ids[])` —— 批量、**支持已持久化(非内存)会话**、按会话隔离
  失败,返回 `{session: SessionHeader, title?}`,header 带 `cwd`/`createdAt`/
  `origin`/`agentPreset`。
- **临时 host 探针插件实测**(`tprobe-1`,用完即删):10 个真实历史会话 **10/10**
  取到标题(来源 `provider`/`fallback`),带回工作目录与 `origin=subagent`;
  **冷读 2.8s / 10 会话** —— 该数字决定了缓存与预热是必需项而非优化项。

### 三、改动

- **lib/index.js**:新增「会话身份折叠」通道 —— TTL 缓存(有标题 30min / 无标题
  2min 重试)+ 单飞任务 + 启动预热(账本载入后 1.5s 起跑)+ 首屏等待上限 2.5s
  (超时用 ID 兜底、后台补完,下一轮轮询即有);降级链 缓存 → 内存 store → 截断 ID,
  **绝不编造名字**。`sessionRanking` 增出 `dates[]`/`rows[].daily[]` 与
  `totalAll`/`callsAll`/`matched` 三个口径字段;下发上限 `SESSION_TOPN` 10 → 50
  (排序键切换与搜索若在截断后的 Top 10 上做,结果会错)。
- **lib/client.js**:「会话用量 Top N」→「**会话活跃分布**」:名称列两行(标题 +
  `工作目录 · 最后活跃日`,子会话标签,hover 给完整 ID/cwd/预设)、数值列、
  `占比% · N 轮消息`(分母 = 窗口内**全部**会话)、**近 30 日逐日分布格**(空日极淡、
  有量按**该行自身峰值** 4 档提亮)、**四组控件**(维度 / 排序键 / 搜索标题·ID·目录 /
  条数 Top 10–50,全部本地即时生效);「使用分布」两列改为 `minmax(300,380) 1fr`,
  把宽度让给排行。
- **维度切换是实测逼出来的,不是照抄参考图**:第一版只有「按会话」,真实账本回放
  直接证伪 —— 45 个会话 / 1350 格**只有 50 格非零(4%)**,单行最多活跃 2 天,条带
  几乎全空。单会话时间跨度天生短(多在当天活跃),须按工作目录叠加才成形:补
  `cwdRanking` 后 4 个目录 / 120 格 **21 格非零(18%)**、单行最多活跃 6 天。
  聚合入参用**全量**会话行(截断后聚合会随口径漂移);未解析出目录的会话计入
  `unresolved` 如实提示,**不塞进"未知目录"假分组**。
- **会话「用量」Tab 一行未动**(用户明确要求只改「用量统计」全局浮窗这一处)。

### 四、验证

- 源码级探针(host 真跑 `apply` + 真调 `/global`;client 从 `client.js` 原文截取
  组件函数体渲染):**61/61 通过** —— 两个维度的聚合与渲染、逐日分布、分母口径、
  标题折叠、子会话标记、三个降级场景(无 `sessionQuery` / 单会话失败 / 整批抛错)、
  四组控件交互全覆盖。
- 真实账本回放(副本,不碰原账本):45 会话 / 4 目录,确认上述填充率对比;首屏
  2ms 返回(命中预热缓存),折叠按全量 45 个 id 单飞一次,第二轮不再触发。
- 目检待办:host 重启后确认整列显示中文标题、身份行目录/日期正确、分布条形态可读。

### 五、附带发现 → **已由 v0.5.1 修复**(见上方条目)

`flushLedger(true)` 在 `process.on('exit')` 触发时,**强制**写出所有 `spanDirty`
条目,而 `loadLedger()` 载入 span 行时经 `touchSpan` 把这些键重新标脏 —— 于是
**每次 host 正常退出都会向 `usage-log.jsonl` 追加一批重复的 span 快照行**
(本机 45 个会话 ≈ 45 行 / 次)。追加的是幂等快照,不改统计结果,只是账本缓慢膨胀。
实测本机账本因此积了 **947 行纯冗余(占 19%)**;修复、存量清理与对照实验见上方
v0.5.1 条目。

### 六、用户需执行

`%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-token-monitor\lib\` 覆盖为仓库
最新两文件 → **重启 host** → 刷新页面 → 侧栏「用量统计」。

## 2026-09-10(晚) · WER 提权取证完成:**确认无 dump** + **A/B 正式开跑**

> ⚠️ **2026-09-10(深夜) 补正两处**:①`Sig[4]=67246080` 的十六进制应为 **`0x04021800`**
> (非 `0x04020000`);②`ConsentKey=AppHangXProcB1` **不代表跨进程挂起** —— 判定依据是事件
> `Event Name` 与签名 `P6`,本机为 `AppHangB1` 且 `P6` 空。详见上方 2026-09-10(深夜) 条目。

依据:用户以管理员身份运行 `read-wer-hang.ps1`,并用 `miasaki-mica-off.cmd` 启动。
原始报告落盘 `_refs/scripts-archive/wer-hang-report-20260910-173656.txt`(14,320 B)。

### 一、WER 提权读取结论(admin: True)

- **Miasaki 报告目录仅 1 个** —— `Critical_Miasaki.exe_5f97eb7b…`(modified 2026-09-10
  17:01:10),目录内含**唯一文件 `Report.wer`(56,346 B)**。
- **`>>> no dump in this report`** —— 四次挂起**全部无 dump**,与既有判断一致。
  `LoadedModule entries: 0`:报告未记录任何已加载模块 → **「hung module」这一路彻底走不通**。
  根因仍只能靠排除法,含栈定位不可得。
- **`Sig[4]` 实测已取到**(此前判断「需提权才能拿」正确,但**取值与预期不同**):

  | 字段 | 值 |
  |---|---|
  | `EventType` | `AppHangB1` |
  | `ConsentKey` | `AppHangXProcB1` |
  | `FriendlyEventName` | `Stopped responding and was closed` |
  | `Sig[3]`(Hang Signature) | `c27d` |
  | **`Sig[4]`(Hang Type)** | **`67246080`** |
  | `DynamicSig[22..28]` | `c27d7f28a4f1ea1f22a0d6d606cd5fc8` / `3f2f` / `3f2fe0835551d23dfc45a490bcc50b94` |

  **重要更正**:`Sig[4]` 的值是十进制整数 `67246080`(即 `0x04020000`),**并非**此前设想的
  可读字符串 `Top level window is idle`。后者是**事件日志** `1002` 的 `HangType` 字段语义,
  两套通道字段名撞车但取值格式不同 —— 后续取证勿再混淆。
- **Fault bucket 序列(9/05 与 9/09/9/10 不同)**:
  - 9/05 17:59:31 → `1181927956033363949`(**孤例**)
  - 9/09 00:52:42 / 01:09:05 / 9/10 17:01:10 → **`2204849698794992458`**(连续三次**相同**)
  - 即**首挂与后三次成因可能不同**;后三次已构成稳定的可比基线。
- 每次挂起伴随 `1001`(Windows Error Reporting)紧邻 `1002`,时间戳一一对应。
- `OsInfo[39].servicinginprogress = 1` —— 留意:挂起期间系统有 servicing 在挂起态,
  属环境噪声,不足以解释(9/05 首挂未标注)。

### 二、A/B 正式开跑(硬证据)

`MIASAKI_NO_MICA` 部署修复**已实证生效**,pet.log 第 2497 行:

```
[1789033056s] mica skipped (MIASAKI_NO_MICA) → opaque background
```

- 时间 **2026-09-10 17:37:36**,`mica skipped` 计数 = **1**(历史首次出现)。
- 该行**直接跟在** `asset-server listening :39800` 之后、`window created` 之前 ——
  与 `main.rs` 的设计一致:窗口**从创建起**即用实色底,不存在「先透明后补实色」的中间态。
- 对照:此前 28 次启动(pet.log 第 1524~2477 行)**全部**为
  `mica backdrop applied (window transparent)`,`mica skipped` 出现次数为 **0**。
- **A/B 自此正式开始,观察起点 = 2026-09-10 17:37:36。**

### 三、本轮方法学修正(写入长期记忆)

- `read-wer-hang.ps1` 的 dump 判定**需提权**(`ReportArchive\*` 内容受 ACL 保护,实测
  所有 WER 报告目录一致,非 Miasaki 特有);但 **`HangType` / `ReportId` / `ProcessId` /
  `ExeFileName` 等字段可经 `wevtutil qe Application /f:xml` 免提权取得**,
  足以覆盖事件通道诉求。
- **进程级提权在助手侧不可用**:`Start-Process -Verb RunAs` 与
  `[Diagnostics.Process]::Start` 均被安全策略拦截 → 需 UAC 的动作**只能由用户手动执行**。

## 2026-09-10 · 「全黑无响应」第 4 次复现,并查明诊断开关从未部署(A/B 实际未开始)

依据:用户「刚刚突然又全黑屏关不掉了」。

- **事件定性(第 4 次)**:今天 17:01:07 `Application Hang`(Id 1002 / `AppHangB1`),WER fault
  bucket `2204849698794992458` —— 与 9/09 两次**完全相同** → 同一成因。四次记录:9/05 17:59:27、
  9/09 00:52:37、9/09 01:09:02、9/10 17:01:07。
- **本次为「全进程冻结」而非仅窗口无响应**:pet.log 最后写入 16:55:19,此后连桌宠线程也不再
  有任何输出(该文件由桌宠窗口线程与 hash 看门狗共同写入)。
- **【决定性发现】`MIASAKI_NO_MICA` 诊断开关从未部署到用户实际运行路径**:
  1. 带开关的构建产物是 `src-tauri/target/release/miasaki.exe`(2026-09-09 01:23:53,二进制串
     校验含 `MIASAKI_NO_MICA` / `mica skipped (MIASAKI_NO_MICA)`);
  2. 但桌面快捷方式 `Miasaki-dsh.lnk` 与 `_refs/scripts-archive/miasaki-mica-{on,off}.cmd`
     **全部指向** `dsh-miasaki-desktop/dist/Miasaki.exe`(2026-09-09 00:07:59),该产物
     **不含**上述字符串;
  3. 即 9/09 那次「构建通过」后**遗漏了 dist 同步**,`miasaki-mica-off.cmd` 设的环境变量被旧
     exe 完全忽略。硬证据:pet.log 全程只有 `mica backdrop applied (window transparent)`,
     **从未出现** `mica skipped (MIASAKI_NO_MICA) → opaque background`。
  - **结论:至今 4 次挂起全部发生在 Mica 模式下,Mica 假设既未被证实也未被排除;
    9/09 计划的 A/B 对比实际从未开始。**
- **本轮新排除**:
  ①**WebView2/Edge 版本更新** —— `EBWebView.bak/Last Version` = `152.0.4191.62`(首挂 9/05 时),
  今天为 `152.0.4191.66`,**两个版本均挂起**;
  ②**WebView2 侧崩溃** —— `Local State` 的 `system_crash_count: 0`、`Crashpad/reports` 为空、
  `exited_cleanly: true`,即 WebView2 未崩溃,是挂起。
- **「黑屏」与「关不掉」的机制(对既有现象的补充解释)**:Mica 模式窗口底色为 `RGBA(0,0,0,0)`
  (全透明),画面完全依赖 DWM 合成 + WebView2 提交帧,窗口挂起后无内容可合成 → 纯黑(区别于
  普通窗口挂起会保留最后一帧);「关不掉」是因为 `main.rs` 对 `CloseRequested` 调
  `api.prevent_close()` 并把关闭交给**前端弹窗**确认,前端已挂起则弹窗不出现,而兜底(5s 内二次)
  只认 Alt+F4 系统路径,**消息循环停摆时连 `WM_CLOSE` 都无法分发** → 只能任务管理器。
- **改动**:
  1. **部署修复** —— 将 `target/release/miasaki.exe` 复制为 `dist/Miasaki.exe`(SHA256
     `CBA9F54B94A5AF46313995CFC85A2A178EE1382F7DD7156E2F900CB21E3D0EE3`,与源逐字节一致);
     旧产物备份至 `_refs/bin-archive/Miasaki.exe.20260909-0007.bak`。至此 `MIASAKI_NO_MICA`
     才真正可用。
  2. 新增取证脚本 `_refs/scripts-archive/read-wer-hang.ps1`(自提权):列出 Miasaki 的全部 WER
     报告目录与文件、抽取 `Report.wer` 关键字段与 LoadedModule 尾段、**并重点报告是否存在
     dump**(有 dump 即可读全线程栈直接定位根因)。
- **验证**:`dist/Miasaki.exe` 与 `target/release/miasaki.exe` SHA256 一致;二进制串校验
  `MIASAKI_NO_MICA` / `mica skipped (MIASAKI_NO_MICA)` / `mica backdrop applied` /
  `mica unavailable` 四项均存在;`read-wer-hang.ps1` 通过 PowerShell AST 语法检查,其事件筛选
  段在非提权下实测命中 12 条记录。
- **触摸点**:`dsh-miasaki-desktop/dist/Miasaki.exe`(产物,已 gitignore);本文件;`design/TODO.md`;
  新增 `_refs/scripts-archive/read-wer-hang.ps1` 与 `_refs/bin-archive/`。
- **验证点(用户执行)**:①以**管理员身份**运行 `read-wer-hang.ps1`,看是否存在 dump 与 hung
  module;②用 `miasaki-mica-off.cmd` 启动,pet.log 应出现
  `mica skipped (MIASAKI_NO_MICA) → opaque background` —— 出现即证明开关生效、A/B 正式开始。

## 2026-09-09 · 偶发「全黑无响应」取证:新增 MIASAKI_NO_MICA 诊断开关

依据:用户「桌面端会突然全黑屏无法操作，必须通过任务管理器才能终止程序」。本轮**只做取证与
可回退实验**，不改默认行为。

- **现象定性**:Windows 事件日志为 `Application Hang`(Id 1002) + WER `Critical_Miasaki.exe_*`，
  **不是崩溃**。三次记录:2026-09-05 17:59:27、2026-09-09 00:52:37、01:09:02；后两次
  fault bucket 相同(`2204849698794992458`) → 同一成因、可复现。窗口纯黑且连托盘都无响应，
  说明主窗口消息循环整体停摆、WebView2 侧已无内容——区别于「渲染冻结」（那会保留最后一帧）。
- **时间拐点（本次关键证据）**:事件日志覆盖 7/23 起，Miasaki 记录只有两类——8/21~8/22 五次
  `Application Error`（即 TODO 的「闪退」，第六轮 GDI 修复后彻底消失）与 9/5 起三次
  `Application Hang`。**挂起首次出现在 2026-09-05，与该日「标题栏与主界面融为一体
  (Win11 Mica + 圆角 + 零分界)」同日**（那次引入 `.background_color(0,0,0,0)` +
  `apply_mica()` + `.shadow(true)`，窗口自此不再自绘底色，画面完全依赖 DWM 合成 +
  WebView2 提交帧）。
- **已排除**:①401 cookie 黑屏——`.credentials.yaml` 的 `client-connection/browser-session`
  secret 与 `themes/src/00-boot.js` 硬编码值 SHA-256 一致(`8712c86000fec812…`)，注入仍有效；
  ②后端——dsh web 进程 `Responding=True`、CPU 约 23% 单核；③GPU 驱动超时/硬件错误——近 6 天
  `System` 日志无 TDR(4101)/WHEA/BugCheck；④待机冻结——Modern Standby 仅 9/7、9/8 22:05~22:31，
  两次挂起不在窗口内；⑤桌宠渲染——pet.log 中 `ULW failed`/`surface rebuilt` 兜底路径从未触发。
- **改动**（`src-tauri/src/main.rs`，三处，默认行为不变）:
  1. 新增 `no_mica_requested()`:`MIASAKI_NO_MICA=1`（或 `true`）时启用；
  2. `apply_mica()` 顶部短路:跳过 DWM Mica、直接 `set_background_color(fallback_bg)`，
     并落盘 `mica skipped (MIASAKI_NO_MICA) → opaque background`；
  3. 窗口创建处 `.background_color(window_bg)`:`no_mica` 时从建窗起就用实色主题底，
     避免「先透明后补实色」闪一下。
- **验证**:`cargo build --release` 通过（36.53s，产物 `target/release/miasaki.exe`，
  42,797,056 B）；产物内嵌字符串 `MIASAKI_NO_MICA` / `mica skipped` 已确认存在。
- **触摸点**:`src-tauri/src/main.rs`；本文件；`design/TODO.md`。
- **验证点（用户执行）**:A/B 对比——「开 Mica」（不设变量）与「关 Mica」各跑几天，比较挂起频率；
  关 Mica 时 `%LOCALAPPDATA%\miasaki\pet.log` 应出现
  `mica skipped (MIASAKI_NO_MICA) → opaque background`。若关 Mica 后不再挂起，即坐实
  「透明窗口 + Mica 合成」成因，再定正式修复方案。
- **取证工具**（一次性，归档未入库）:`_refs/scripts-archive/watch-miasaki-hang.ps1`
  （后台常驻，检测到 `Responding=False` 自动抓 CPU 采样 / 逐线程 state-wait / WebView2 子进程 /
  日志尾部 / 前台窗口）、`_refs/scripts-archive/diag-miasaki-hang.ps1`（手动单次快照）。

## 2026-09-08(晚) · 注入层状态扫描性能收敛:去掉每轮强制同步布局

依据:用户报告桌面端「有时断连」。实机问诊后现象为**界面还在但消息发不出、输出卡住不动**
(而非 DSH 的「连接异常,点击立即重连」)。排查出两条叠加因素,本次只动桌面端那一侧:

- **机制层(DSH 本体,未改)**:事件流走 WebSocket mux,服务端 `websocketHeartbeatIntervalMs`
  默认 **2000ms**、`MAX_MISSED_HEARTBEATS = 2`——连续 2 次收不到 pong(约 4~6s)即
  `socket.terminate()`;断后前端才走指数退避重连(500ms→10s),该窗口内界面无任何更新。
  即:任何 ≥4s 的进程冻结/主线程卡顿都会被放大成「断连 + 静默期」。
- **桌面端特有(本次修)**:注入层每 1.5s 的状态扫描链路里含多次**强制同步布局**调用。

- **`02-core.js`:`syncHash` 拆出 `computeDiag`,diag 段按 10s 节流重算 + 缓存**:
  diag 里的 `getBoundingClientRect()`(×2)、`document.elementFromPoint()`、
  `getComputedStyle()` 都是强制同步布局;而 `syncHash` 由状态扫描每 1.5s 触发一次,
  在长会话 + 流式输出(DOM 持续变化)时每轮都要重算一次完整布局。
  新增 `DIAG_MIN_INTERVAL_MS = 10000` 与 `DIAG_CACHE`/`DIAG_AT`;`syncHash(force)` 在
  主题切换(`apply`)与启动首帧(`08-ready`)传 `true` 立即重算,常规同步只写
  `theme/int/act/wait` + 缓存 diag(字段格式与取值语义不变,Rust 侧 `hash-diag` 落盘逻辑零改动)。
- **`05-sensors.js`:`scanActivity` 把廉价判断前置**:
  原实现对**每个** button 求 `el.offsetParent`(强制布局)后才做文本匹配;改为先
  `isBtnTextMatch(textContent)`(不碰布局),命中后才做 `closest`/可见性判断——
  常规轮次对绝大多数按钮零布局开销。
- **`05-sensors.js`:`petEvalIntensity` 扫描节奏分级**:
  `activity` 每轮(只查 button,廉价);`effort`/`approval` 属重量级全量查询
  (遍历整棵 DOM,approval 还带 `[class*="modal" i]` 属性选择器)降到每
  `PET_HEAVY_EVERY = 2` 轮(3s)一次;`document.visibilityState === 'hidden'` 时整体降到每
  `PET_HIDDEN_EVERY = 4` 轮(6s)一次(此时 Chromium 本就节流页面,实时性收益极低)。
- **可感知的行为变化(折中,已评估可接受)**:思考强度/等待审批的检测间隔 1.5s→3s;
  审批气泡消失确认窗口 3s→6s(防抖更强);忙碌指示保持 1.5s 不变;主窗口隐藏时扫描
  1.5s→6s;hash diag 段 1.5s→10s 重算(主题切换/启动仍即时)。
- **实机实测依据**(2026-09-08 21:5x~22:4x,当前 pure 主题,工具
  `_refs/scripts-archive/measure-render-cpu.ps1`):
  - 渲染进程:平均 **3.9~4.2% 单核**,每 ~1.5s 出现一次 **15~47ms** 尖峰,节奏与
    `PET_TIER_MS` 完全吻合(长会话 + 流式输出时尖峰更高)。
  - GPU 进程(加载 `d3d11/dxgi/nvldumdx`):**39~58% 单核持续占用**(随页面活动波动,
    流式输出时接近满载)——pure 主题无光斑仍如此,故主因是「透明窗口 + Mica + 流式重绘」的
    合成开销,**不是**主题装饰;本次不动,已列为后续候选。
  - DSH 主机 HTTP 延迟中位 1ms / P90 2ms(健康);仅在跑构建 / `cargo test` 期间出现
    348~597ms 尖峰,说明主机响应对同机系统负载敏感。
  - **边界(诚实说明)**:本次优化去掉的是渲染主线程每轮的强制同步布局,收益在长会话 +
    高输出场景下更明显;它**不能单独解释**「断连」——DSH 心跳 4~6s 窗口、Modern Standby
    冻结、GPU 持续高占用仍是并列候选,需复现取证才能定论。
  - 系统事件日志另有 9/7 多次 Modern Standby 进出与 9/5 一次 `Miasaki.exe` AppHang 记录。
- **未改动(待用户拍板)**:WebView2 后台节流参数(`additionalBrowserArgs`)、运行期后端
  存活监控 + 自动重启、DSH 侧心跳间隔调大(经 `cordis.patch.yml` 覆盖)。
- **部署复核(2026-09-09)**:`dist/Miasaki.exe` 与 `src-tauri/target/release/miasaki.exe`
  哈希一致(`983382110f870e6a15265cc5ed756724`,42851840 B,9/8 23:15 构建,含本次收敛)——
  重新复制落盘并重启桌面壳(新进程主窗口 `Miasaki · DSH` 正常、DSH host 复用),
  本次优化已进入用户实际使用的二进制;端到端目检仍待用户实操。
- **遗留提示**:`themes/runtime.js`(legacy 回退源)早于本次改动即与 `themes/src/` 拼接结果
  不一致(1101 行 vs 1042 行),构建链路以 `MANIFEST.json` 为准,未同步;若日后要复活回退
  路径需先重新拼接。另:`ARCHITECTURE.md` §3.3 关于「思考强度」的描述(MutationObserver
  计数 / 2.5s 分级)与实现(`scanEffort` 读模型选择器推理等级)不符,属历史遗留,待后续核对。
- 触摸点:`themes/src/02-core.js`、`themes/src/05-sensors.js`、`themes/src/08-ready.js`、
  `src-tauri/injected/theme-init.js`(构建产物)、`design/ARCHITECTURE.md` §3.4、本文件。
- 验证:`npm run gen-init`(令牌完备性通过,产物 65 KB);`node --check` 产物语法通过;
  `node ../scripts/verify-all.mjs desktop` **4/4 通过**;另用 `vm` 抽取改动后的真源码
  (02-core + 05-sensors)做逻辑验证 **14/14 通过**——diag 节流(force 后重算 1 次 / 3s 内
  两次常规同步不重算 / 超 10s 重算 1 次)、`scanActivity` 判定语义逐分支未变(可见→busy、
  `offsetParent` 空且 visibility=hidden→idle、注入层内→idle),且 5 个文本不匹配的按钮
  `offsetParent` 读取 **0 次**(原实现为 5 次)。脚本归档
  `_refs/scripts-archive/verify-inject-scan-logic.mjs`(仓库根运行,可复跑)。
- 排查工具(一次性,归档未入库,均从仓库根运行):
  - `_refs/scripts-archive/diag-desktop-conn.ps1`——卡住瞬间跑一次,抓齐主机 HTTP 延迟 /
    3080 连接与 TIME_WAIT / 各 WebView2 子进程角色与负载 / 三份日志时间线 / 会话日志活性,
    用于区分「主机卡」「连接被掐」「前端卡」三种成因;
  - `_refs/scripts-archive/measure-render-cpu.ps1`——按角色(GPU/渲染/网络)采 CPU 与尖峰,
    优化前后对比用(注意:同机常有其他 `msedgewebview2` 宿主,脚本按进程树/启动时间筛 Miasaki 的);
  - `_refs/scripts-archive/verify-inject-scan-logic.mjs`——注入层扫描逻辑回归(14 项)。
- 用户待执行:**重启 Miasaki** 使注入层新代码生效(`src-tauri/injected/theme-init.js` 已重新生成)。
  验证点:①桌宠思考强度跟随模型选择器仍正确(最多延迟 3s);②等待审批气泡仍及时出现;
  ③长会话流式输出时输入/滚动不再发涩;④`%LOCALAPPDATA%\miasaki\pet.log` 的 `hash-diag` 行
  频率应明显下降(原每 1.5s 变化即落盘);⑤重启后跑
  `pwsh -File _refs/scripts-archive/measure-render-cpu.ps1` 复采一次,与本次基线对比
  「渲染进程」的 >50ms 次数与平均值。

## 2026-09-08 · 模型设置运行时补丁入库（本体例外 · 可重建可回退）

依据:状态盘点发现「设置页模型能力增强」补丁此前**只存在于 `vendor/runtime-bundle/`（gitignore，不入库）**,
而 `vendor/` 丢失或换机即无法重建;同时该目录里的 `patch-runtime.mjs` **已损坏**
（第 93 行 `probe.pруютсяrovider` 混入乱码、第 167-169 行 `if (next === Nt)', => {` 是无效语法、
`replaceAtShift` 未定义,`node --check` 直接报 SyntaxError),其第 5 步块内容与实际产物也不一致
（脚本写 `jsx`/`lv`/`orphan`,产物是 `jsxs`/`level`）。即:唯一的重建脚本既跑不起来,也不忠实。

- **新建 `patches/dsh-client-ui-settings-models/`**:补丁规则 + 基线 + CLI 一体入库。
  - `patch.mjs`——**7 条锚点编辑规则**(5 处插入 + 2 处字典替换),锚点按 trim 全等匹配、
    要求唯一(不唯一即报错);`reasoning-ui` 一条用「锚点 +2 行」并断言目标行内容,避免改版后插错层级。
    CLI 四模式:`verify`(离线自证)/ `status`(状态判定 original/patched/unknown)/ `apply`(备份+幂等应用)/ `revert`。
  - `baseline/client.original.js`——DSH **0.1.2-rc.1** 官方原版(137,701 B,SHA-256 `7ACF9736…`),
    与安装目录 `client.js.dsh-bak` **逐字节一致**(独立副本交叉验证过)。
  - `baseline/client.patched.js`——补丁产物(143,340 B,SHA-256 `18D114AC…`),兼作黄金对照与升级后 diff 基准。
- **重建闭环已自证**:`node patch.mjs verify` 由 baseline 原始文件重建,与 baseline 产物
  **逐字节一致**(非仅哈希;7 条编辑、SHA-256 `18D114AC19CC2C9E…`)。
  途中修正两处自身缺陷:探测路径把已含 scope 的包名重复拼了一层(导致 `status` 找不到安装目录)、
  字节数报的是字符数而非 UTF-8 字节。
- **实机验证**(不碰安装目录):`status` 自动探测到运行中的安装目录并判定 `patched`;
  对副本 `apply` 幂等跳过、对原始副本 `apply` 产出与 baseline 一致的哈希、`revert` 还原成功。
- **接入统一回归**:`scripts/verify-all.mjs` desktop 线新增 `patch verify`(纯离线、不依赖安装目录),
  desktop 3/3 → **4/4**。注意它证明的是「补丁规则与基线自洽」,不是「补丁此刻在安装目录里」——
  DSH 升级覆盖补丁后该项仍应 PASS,而 `status` 会显示 `unknown`。
- **边界**:这是本项目「不修改 DSH 本体」原则的**唯一例外**,代价(升级覆盖、需重打)已在
  `patches/…/README.md` 写清;补丁只改该包 client 产物,不动 DSH 源码与其他包。
- 触摸点:`patches/dsh-client-ui-settings-models/{README.md,patch.mjs,baseline/*}`(新)、
  `README.md`(本线)、`../scripts/verify-all.mjs`、`../dsh-miasaki-shared-docs/cross/{model-settings-toolkit-design-2026-09-07.md,smoke-test-matrix.md}`、根 `../README.md`、本文件。
- 用户待执行:无(补丁已在安装目录中生效);DSH 升级后按 `patches/…/README.md`「升级后怎么办」重打。

## 2026-09-07(晚) · Fleet 脉冲 stale 语义 + Rust 单测首建

依据:桌宠 Fleet 指示器此前不检查 `fleet-pulse.json` 的 `ts` 时效——发布器（常驻
`--interval-ms`）一旦崩溃或被杀,文件仍留在盘上、内容仍是合法 v2 JSON,桌宠会永远停在
「忙碌中…」/「需要你的批准」,且无任何告警(陈旧数据比没有数据更危险)。

- **`read_pulse_flag` 改为 `parse_pulse_flag(txt, now_ms)` + 阈值 `PULSE_STALE_SECS = 30`**:
  龄期 > 30s(发布器建议间隔 5s 的 6 倍)即 stale,等同不可用 → 桌宠 fleet 指示关闭;
  `ts` 缺失/不可解析、未来时间戳(超前>30s,时钟回拨或跨机复制的文件)同判不可信;
  `v != 2`/缺 `fleet`/非 JSON 仍按不可用。
- **新增 `parse_iso8601_ms()`**:极简 ISO-8601 UTC 解析(带小数秒 / `+00:00` 等价形式),
  非 UTC 偏移拒绝;不引第三方时间库。
- **看门狗日志区分三类不可用**:`文件不存在` / `存在但不可用（stale/格式错误)` /
  `未配置 MIASAKI_FLEET_PULSE`——排查时能立刻分清「发布器死了」与「没配变量」。
- **首建 Rust 单测**(`src/main.rs` `#[cfg(test)] mod tests`, 4 项)+ 既有
  `pet_native::image::tests` 共 5 项:`iso8601_parses_utc_forms_and_rejects_offsets`、
  `fresh_pulse_maps_counts_to_running_and_alert`、`stale_pulse_is_rejected_so_the_pet_cannot_freeze_on_busy`(29s 边界有效/31s 已 stale)、
  `malformed_pulse_degrades_to_none`(BOM 前缀容错、单字段缺失按 0 处理)。
- 触摸点:`src-tauri/src/main.rs`(改)、`design/CHANGELOG.md`(本条目)、
  `../dsh-miasaki-shared-docs/cross/ab-linkage-pulse-v2-2026-09-04.md`(时效语义补记)、
  `../scripts/verify-all.mjs`(desktop 线新增 `cargo test`)。
- 验证:`cargo test --bin miasaki` 5/5 通过;`node scripts/verify-all.mjs desktop` 3/3 通过。
- 用户待执行:cargo 在 `~/.cargo/bin` 不在 PATH,`verify-all.mjs` 已自动探测;
  若本机另装 rustup 到别处,`cargo test --bin miasaki --quiet` 手动跑亦可。

## 2026-09-07 · 会话日志下载入口迁移:主界面 → 轨迹页搜索栏左侧（新 bundle dsh-session-log-move）

依据:用户要求「Session 日志」下载按钮不在主界面,改放轨迹页搜索栏左边;
规划设计见 `design/session-log-download-relocate.md`（方案 A 动态插件验证 → B 固化 bundle,
C 改平台源码不采纳——安装目录升级即覆盖）。

- **方案 A 验证（动态 cordis 插件 `slogm-1`,v3 验收通过）**:
  - v1 用 `slots.inject` 隐藏官方按钮无效 —— 动态插件晚于页面激活,`inject` 只对
    “未来声明”的 slot 触发回应,已命名的 slot 被错过;改 `slots.register` 直接替换即生效
    （occupants 由官方 H5 → `dyn/slogm-1` active,官方条目 active:false）;
  - 轨迹页 toolbar 无官方 slot（全树核对 `conversation.view`/`trajectory.images` 均非
    toolbar 挂点）,采用 DOM 注入:`[role=toolbar]` 内 `input[type=search]` 容器左侧
    `insertBefore`,MutationObserver + 500ms 重试兜底（约 30s）,React 重渲染冲掉自动补挂;
  - 下载复用官方 client 服务 `sessionLogDownload.download()`（缺失降级 `<a download>`
    直触 `/api/session.export`）,按钮内联文案反馈并自动复位;
  - client 闭包环境遮蔽 `fetch/timers`（`new Function` 参数梯形成了教学错误）,对
    `document/MutationObserver` 则未遮蔽可直接用——降级路径因此不能走 `fetch`。
- **B 固化**:新增 `plugins/dsh-session-log-move/`（纯 client bundle,host 空壳）:
  `package.json`（dsh.bundle.patch + dsh.client web + peer cordis ^4.0.2）、
  `cordis.patch.yml`（insert id）、`lib/client.js`（替换+注入+下载+反馈,逻辑与验证版
  同源）、`lib/index.js`/`lib/index.d.ts`、`lib/types/client/index.d.ts`、`README.md`。
- 触摸点:`plugins/dsh-session-log-move/`（新增）、`README.md`（目录树 + 插件专节）、
  本文件、`design/session-log-download-relocate.md`（新）。
- 用户待执行:profile `%USERPROFILE%\.dsh\profiles\web\package.json` 挂 file: 依赖
  `dsh-session-log-move` + `dsh.profile.bundles`,profile 目录 install 后 host 重启生效;
  动态插件验证版随时可 `cordis_stop` 停用（可逆）。

## 2026-09-06 · 标题栏 v4:窗控去胶囊化——无壳裸键（阶段 A）+ 真机验收收官

依据:用户对 v3 悬浮胶囊「外壳感」的观感反馈;规划设计见 `design/titlebar-v4-embed.md`
（路线 A 无壳裸键 → A+ 几何嵌入 → B 官方 Slot 真嵌入,B 留 roadmap 待评估）。

- **去胶囊壳**:`.tb-capsule` → `.tb-group`（`03-switcher.js` 删半透明底/边框/圆角/
  backdrop-filter/box-shadow/padding 整段壳样式;`06-titlebar.js` DOM 类名同步）,
  三键以裸键形态直接落右上角,hover 底色只落单按钮（Win11 原生标题栏同款,零新增样式,
  关闭键 hover 红底不变）。
- **徽章保留**:16px 主题小圆留在按钮组左侧（原 18px）,为启动页唯一主题标识
  ——用户拍板 2026-09-06。
- **让位收窄**:132px → 118px（裸键组 ≈108px + 余量）;真机三主题 × 最小宽度 960
  复核「Session 日志/工具」无叠压（v3 初版 104px 叠压教训未复发）。
- **零行为变更回归全过**:hash 命令链（min/max/close/want-max）、关闭确认弹窗、
  36px 空白拖动 + 按钮区不拖、双击标题栏、Win+↑ 系统路径图标同步（≤1.5s 巡检）、
  重开窗口状态恢复、非 DSH 页（404/loading 同注入路径）窗控同形态可用;
  `npm run gen-init` + `npm run verify` 18/18 无告警。
- 触摸点:`themes/src/03-switcher.js`、`themes/src/06-titlebar.js`、本文件、
  `README.md`（标题栏段 v3→v4）、`design/titlebar-v4-embed.md`（新,方案 + 验收记录）。

## 2026-09-06 · 「用量」页重构:会话/全局一刀切 + 侧栏「用量统计」浮窗（token-monitor v0.4.0）

依据:用户对 v0.3.3「用量」Tab 两条诉求——会话页只统计当前会话（与「轨迹」页同口径）、
总量统计整体收口到侧栏独立入口;规划设计见 `design/usage-stats-redesign.md`（四决策点
已拍板:D1 浮窗 / D2 日限额迁全局页 / D3 模型+会话 Top N / D4 加会话活跃时长卡）。

- **host 拆路由（旧 `/summary` 退役）**:`/session?sessionId=…` 只回官方聚合 + 按
  `sessionId` 过滤的实时明细（载荷瘦身）;`/global` 承接跨会话账本统计 + 新增
  **会话 Top N 聚合**（近 30 日按账本 sessionId 聚合 tokens/calls/活跃跨度,Top 10,
  会话标题经 `sessions.get` 尽力解析、失败降级 ID）。`heatmap`/`config`/`reset` 不变,
  账本写入路径零改动,历史统计零迁移。
- **顺带修复现存缺陷**:v0.3.3 `buildSummary` 把 `live.calls`/`live.tools` 全量返回、
  未按 sessionId 过滤,会话页混入了同进程其他会话的数据——现按会话过滤后再下发。
- **会话 Tab 精简**:保留上下文剩余 hero / 会话用量总览卡组（新增「会话活跃时长」卡,
  实时口径）/ 按模型明细（仅本会话）/ 工具调用 / 性能 / 会话口径脚注;迁出总览五卡、
  热力图、近 7/30 日趋势、模型环形图、今日用量、日限额、重置账本。
- **全局浮窗**:client 半新增 `sidebar.footer.action`（id `usage-stats`,设置按钮旁,
  展开态全宽钮/收起态 36px 圆图标钮）+ `shell.overlay`（id `usage-stats-overlay`,
  全帧背板 + 居中面板,Esc/关闭钮/点背板收起）两个槽位条目,开合经模块级
  useSyncExternalStore store 共享;开启期间 `/global` 5s + `/heatmap` 60s 轮询,
  关闭即停。模块序按用户点名:总览六卡 → 热力图 → 使用趋势 → 使用分布（模型环形 +
  会话 Top N）→ 今日与限额（含重置账本）→ 全局口径脚注。图表组件原样复用,
  `--tokmn-*` 中性色作用域扩展到 `.tokmn-ov`。
- 触摸点:`plugins/dsh-token-monitor/{lib/index.js,lib/client.js,package.json,
  cordis.patch.yml,README.md}`、`README.md`（目录树）、本文件、
  `design/usage-stats-redesign.md`（规划稿→定稿）。
- 验证:node --check 双半通过;临时 mock 验证（stub React 渲染 + stub host 路由）覆盖
  会话过滤（s1/s2 不串扰）、Top N 聚合与标题降级、限额读写、重置归零、存量载入不翻倍、
  浮窗开合与空/有数据两态渲染,全绿后脚本已删。机上验证:profile 目录 `pnpm install`
  → 重启 host → 目检会话 Tab 数字随会话切换、浮窗与切会话解耦、重置后热力图归零。
- **目检修复（同日第二轮,用户报告三处问题）**:
  1. 侧栏「用量统计」按钮不谐入（浏览器默认样式边框）+ 浮窗整体无样式堆叠在左上角
     ——同一根因:`UsageStatsButton` 里 `return createElement(style), createElement(div)`
     **逗号表达式**只返回后者,`<style>` 被求值后丢弃,CSS 从未挂载。改为返回
     `[style, …]` 数组,浮窗根组件也自持一份 `<style>`（三个槽位条目独立挂载点,
     样式各自成立）;按钮形态对齐宿主设置触发钮实测 CSS（42px/12px 圆角/透明底/
     hover 同令牌/行高 22px,展开态 `flex:1` 撑满 footerActions,收起态 36px 圆钮）。
  2. 浮窗报「Failed to execute 'json' on 'Response': Unexpected end of JSON」——
     `api()` 未检查 `res.ok`,404 空响应直接 `res.json()` 炸出裸解析错。抽出
     `readJSON` 统一解包（先查状态码,404 给出「host 路由未注册」可读提示）,
     `fetchSession` 一并收编。
  3. 会话页 404「host 路由未注册」——机上状态问题:host 进程 14:36 boot 早于
     profile 拷贝完成（14:38）,跑的是旧 host 半（无 `/session`/`/global`）而 client
     按请求读盘已是新码,新旧混搭。重启 host 后路由全部就位（curl 实测 `/session`
     `/global` 200、旧 `/summary` 按设计 404 退役）。教训落进插件 README:同步必须
     「拷贝完全落盘 → 再重启 host」。
  修复后探针回归（stub React 渲染断言三槽位组件树,归档
  `_refs/scripts-archive/test-token-monitor-v040-fix.cjs`）ALL-PASS;浏览器实机目检:
  按钮与「设置」同构、会话 Tab 真实数据（90% 剩余/2.5M 累计）、浮窗居中背板 +
  六卡/热力图/趋势/Top N/限额全量渲染、Esc 与关闭钮收起均通过。
- **目检修复（同日第三轮,浮窗版式两处）**:
  1. 热力图/趋势图右侧大片空白——热力图网格固定 52 周×14px≈730px 而卡片全宽,
     改 max-content 水平居中;趋势图 `chartW` 的 ResizeObserver 挂在 `[]` 依赖上,
     首挂时数据未到、图表容器未渲染,测量落空后宽度永远回退 640px——改为趋势容器
     无条件渲染（空态文案也放进容器）,observer 首挂即测得真宽,SVG 随面板伸缩。
  2. 每周/累计两模式图表一样「没变化」——账本现只有 2026-09-05/06 两天、同属一周,
     逐周聚合与逐周累计在数学上就是同一根柱,属数据形态而非代码缺陷;仍做形态优化:
     两模式由「整条柱同色分档」改为**变高柱**（柱高 ∝ 值,零周 3px 空柱做基线,
     底部对齐）,并给三模式各配口径脚注（峰值周 X / 累计 X·截至 Y / 活跃日 N）,
     数据跨多周后累计模式自然呈爬坡形态与每周分化。
  验证:node --check + 探针回归 ALL-PASS;仅 client 半变更,`cp` 覆盖 profile 后页面
  刷新生效（host 半零改动无需重启）;浏览器目检每日格点/每周柱/累计柱三态脚注、
  热力图居中与趋势图全宽均通过。

## 2026-09-06 · 人格会话联动改道（修复「人格会话创建失败:not found」）

依据:用户报告切换主题时 toast「人格会话创建失败:Unexpected token 'o', "not found"
is not valid JSON」。实测复现:`POST /api/session.create` → HTTP 404 `not found`。

- **根因**:注入层 `01-persona.js` 自研 RPC(`fetch('/api/'+method)` + client-request
  信封)在 dsh 0.1.2-rc.1 已失效——该版本 RPC 走 WebSocket mux(`/api/remote.mux`,
  见 `dsh-api-gateway` `registerUpgrade`),HTTP `/api/*` 路由不存在 → 404;
  官方客户端经生成的 `ctx.remote.session.*` 代理调用(实测
  `dsh-client-ui-model-selection`: `ctx.remote.session.modelCatalog()`)。
- **修复(职责迁移,版本自适应)**:注入层不再自行 RPC——`01-persona.js` 改为派发
  `miasaki-persona-request` CustomEvent(detail.theme);`plugins/dsh-pet-panel/lib/client.js`
  (桌面插件,官方客户端上下文)监听事件,经 `ctx.remote.session.create({agentPreset,
  workspaceId?})` 创建,保留 localStorage(`miasaki.petSessions`)去重与主题化 toast
  (DSH 令牌配色);`inject` 增加 `remote.session`/`workspaces`。
- 触摸点:`themes/src/01-persona.js`、`plugins/dsh-pet-panel/{lib/client.js}`(已同步
  profile `node_modules`,哈希核对一致)、`README.md`、`injected/theme-init.js`(重生成
  64KB,令牌校验 + node --check 通过)。
- 验证:release 构建通过;验证点——切换主题后 toast 不再报错,「已创建『狂三』人格
  会话」;若插件升级缺失则静默降级(无 toast、无创建),不阻断主题切换。

## 2026-09-05 深夜 · 标题栏 v3:零占位叠加 + 窗控胶囊(修复「顶部切换按钮位置/被遮」)

依据:用户连续三轮反馈「窗口栏把对话会话布局切换按钮遮住了」「最主要的问题是按钮的
位置而不是整个窗口的风格」——v1 色带/v2.1 卡片式都对页面有 32px 布局侵入,把 DSH
会话头整行(标题行 + `role=tablist` 页签「对话/轨迹/用量」)压到顶带下方,按钮位置与
web 端不一致。本轮先做**布局取证**再动手(用户要求「先定位再改」):

- **取证结论**(读 `@deepseek-ai/dsh-client-ui-conversation` 包源码):会话头 =
  `<header>`(ConversationSessionHeader,`.header{padding:12px 28px 0 20px}`)→
  `titleRow`(`titleCluster`(flex:1:面包屑 + `conversation.session.header.actions`
  槽(后台任务等)) + `headerUtilities`(`conversation.session.header.utilities` 槽,
  Session 日志等))→ `tabs`(`role="tablist"`:对话/轨迹/用量)。全部为文档流定位;
  web 端 tabs 位于 y≈46,桌面端被 32px 下推后到 y≈78——位置被顶带挤掉。
- **v3 设计(用户批准)**:
  1. **零占位叠加**:删除 32px 顶带/卡片/#root 下推与 transform——页面回到 y=0,
     所有顶部控件与 web 端同位置(视觉与交互零侵入);
  2. **窗控胶囊**:右上角悬浮胶囊(主题徽章 + 最小化/最大化/关闭,半透明 +
     `backdrop-filter` 毛玻璃,悬停变实色),胶囊外 `pointer-events:none`,不挡页面;
  3. **顶行让位**:`#root header:has([role="tablist"]){padding-right:132px}`——
     会话头右侧(headerUtilities)为胶囊预留宽度(实测胶囊 ≈114px + 余量),
     Session 日志等左移,不再与悬浮胶囊叠压(与 VSCode 等自绘标题栏应用同款让位;
     初版 104px 不足,真机叠压后加宽至 132px;选择器锚定 `role=tablist`,
     DSH 升级时随 verify-themes 复核);
  4. **空白拖动**:document 级捕获 mousedown(y<36 且事件路径无交互元素——复用
     tauri 内置 drag-region 判定口径:可点击标签/contenteditable/tabindex/交互 role)
     → `plugin:window|start_dragging`;双击 → `internal_toggle_maximize`。
     页面按钮/页签/输入框照常点击,空白处拖窗;
  5. 主题标识移入胶囊(顶部左侧不再放任何东西,不碰侧栏 logo);右下角悬浮切换条保留。
- **清理**:删除各主题 `--ms-titlebar-bg`(+ fallback/@supports)与
  `#miasaki-titlebar` 顶缘高光规则;`prefers-reduced-motion` 去掉 tb-theme 引用;
  `06-titlebar.js` 重写为胶囊 + wireDragZone;`08-ready.js` 接线 wireDragZone。
- 触摸点:`themes/src/{03,06,08}`、`themes/{pure,zafkiel,kurkuriel}.css`、
  `src-tauri/injected/theme-init.js`(重生成 67KB,令牌校验 + node --check 通过)。
- 验证:release 构建(`tauri build --no-bundle`)通过;目检点——重启后「对话/轨迹/用量」
  页签回到 web 端位置、右上角胶囊不遮任何页面按钮、顶部空白可拖窗/双击最大化、
  三主题配色正确。

## 2026-09-05 深夜 · 用量页网格/区块边界可见性修复（token-monitor v0.3.3）

依据:用户截图反馈「用量界面的网格状不明显,各个区块的边界线不清晰」。取证 host
主题令牌:浅色模式下 `--dsw-alias-border-l1` 仅 `#0000000a`(4% 黑)、
`--dsw-alias-bg-layer-2` 与 layer-1 同为 `neutral-bluish-00`(纯白)——凡以这两个
令牌做「结构线/空格底」的地方在浅色主题下全部隐形:

- **区块边界**:卡片/总览五卡/hero/悬浮提示/按钮/输入框/chip 的 1px 边框(4% 黑
  肉眼不可见)→ 换插件内自派生 `--tokmn-border`(label-secondary 34% color-mix);
  模型列表/行分隔线 → `--tokmn-hairline`(20%,弱于区块边框一档)。
- **热力图网格**:空格与未来格底色原为 layer-2(白上白,整片空白仅右端有数据格
  可见)→ `--tokmn-cell-empty`(15%,GitHub 热力图空格观感),CSS 类与 `heatStyle`
  内联双处同步。
- **同类隐形顺手修**:趋势图横向网格线(零基线用 border 档、其余虚线用 hairline
  档)、环形图底环、上下文/限额进度条轨道、分段切换轨道、「未使用」图例 dot 的
  inset 描边,均从 layer-2/border-l1 换到对应派生档。
- 派生令牌挂在 `.tokmn-pane` 作用域,基于 `label-secondary` color-mix,深色主题
  (zafkiel/kurkuriel)下同样自适应可见;`color-mix` 需 Chromium 111+,WebView2 满足。
- 触摸点:`plugins/dsh-token-monitor/{lib/client.js, package.json}`。
- 验证:`node --check` 通过;目检点——浅色主题下五卡/各区块有清晰边线,Token 活动
  空格呈浅灰网格,趋势图有横向网格线与零基线,深色主题回归不变。
- 2026-09-06 实机目检通过(profile 重装 + host 重启后,playwright 无头 Edge 取证):
  浅色下五卡/卡片/hero/按钮/chip 边线清晰(`--tokmn-border` 34% 档像素级可见),Token
  活动空格呈浅灰网格(`--tokmn-cell-empty` 15%,371 格全着底),趋势图零基线 34% 实线
  + 25M/50M/75M 20% 虚线网格线可见,环形图底环/进度条轨道/分段切换轨道同步自适;
  深色下同档派生自 label-secondary 亮色、观感与改动前一致。附带实测:`var()`
  写入 SVG 呈现属性经 Chromium 152 正确解析(computed stroke 返回实际颜色)。

## 2026-09-05 深夜 · 标题栏 v2.1:内嵌卡片式(修复「顶带遮住页面顶部控件」)

依据:用户反馈「窗口栏把对话会话布局切换按钮遮住了」「窗口栏顶栏会遮住按钮」——
v2 的固定 32px 顶带 + `margin-top:32px` 推挤方案下,DSH 页面顶部控件(会话头部行/
切换类按钮,部分为脱离文档流的 fixed/sticky 定位)会被顶带压住或紧贴带底边被裁切;
同一页面在 web 端(无顶带)顶部控件位于页面自然顶部。v2.1 改为参考图中 MiniMax 的
「chrome 面 + 内容卡片」结构,从根上消除交叠:

- **chrome 面**:`body` 底色 = `--ms-titlebar-bg`(与顶带同色,见 v2)——顶带与四周
  留边是同一张表面,带与页面无第二层覆盖关系,页面永远在带的下方。
- **内容卡片**:`body #root{margin:38px 8px 10px;border-radius:12px;overflow:hidden;
  background-color:var(--dsw-alias-bg-base);box-shadow;transform:translateZ(0)}`:
  DSH 整体作为圆角白色卡片浮在 chrome 面上(侧栏/详情面板一并入卡),页面顶部控件
  在卡片内保持 web 端的自然位置与间距。
- **fixed/sticky 隔离**:`transform:translateZ(0)` 使 `#root` 成为其内部
  fixed/绝对定位后代的包含块——页面内任何脱离文档流的控件(含用户反馈的切换按钮)
  都会被定位到卡片内,结构上不可能出现在顶带下方;popover/菜单在卡片内照常工作
  (edges 处轻微裁切,可接受)。
- **顶带**:仍为 chrome 表面的一部分(左侧主题标识 + 右侧窗控),但不再与页面内容
  有任何上下层交叠——即使 DSH 升级引入新的 fixed 顶部元素,也无法越过卡片边界。
- 触摸点:`themes/src/03-switcher.js`(SWITCHER_CSS 的 body/#root/带规则)、
  `src-tauri/injected/theme-init.js`(重生成,68KB,令牌校验 + node --check 通过)。
- 验证:release 构建(`tauri build --no-bundle`)通过;目检点——三主题下顶部为
  灰 chrome 色带 + 圆角白色内容卡片,「对话/轨迹/用量」页签与头部控件在卡片内
  完整可见可点,web 端与桌面端顶部布局一致;窗控/拖动/关闭确认行为不变。

## 2026-09-05 晚 · 标题栏 v2:应用化「色带」(对齐 MiniMax Design 参考)

依据:用户给出 MiniMax Design 截图,要求「窗口栏能自然融合到主页面,像第二张图一样
差不多的效果,现在我们的桌面端还不行」。对照参考图像素取证:顶部菜单区采样 `#EFEFF2`、
页面底 `#FAFAFA` —— 参考实现是**全宽约 32px 的统一色带**(与页面同色系、略深一线),
菜单在带内左侧、窗控在带内右侧,带与页面零分界。v1 做法(色带 = DSH 基底令牌,与页面
零色差 + `::before/::after` 侧栏色块/详情分隔线模拟)在纯色/侧栏收起态下带完全隐形,
窗控像浮在页面上的裸图标,观感未达参考。v2 按参考重做:

- **标题带 = 应用 chrome 表面**(`themes/src/03-switcher.js` SWITCHER_CSS):
  `--ms-titlebar-bg` 由各主题定义,三主题均用 `color-mix` 以页面基底混少量分色
  (pure:`label-secondary`;kurkuriel:枪铁 `#6a6159`;zafkiel:蓝灰 `#d6cfe4`)→
  亮色主题略深一线、暗色主题略亮一线(≈12~16% 分量);`@supports` 守卫 + 各主题
  显式 fallback 色,保证 color-mix 不可用的环境回退到近似旧观感而非透明。
  移除 `::before`(侧栏色块)/`::after`(详情分隔线)与 `data-details-open`/`data-local`
  规则——不再依赖 DSH DOM 网格几何(见 ARCHITECTURE 契约废弃)。
- **主题文字常显**:左侧品牌徽 + 主题名/副标题即「应用级内容」(对齐 MiniMax 菜单位),
  不再随侧栏收起淡出;收起态规则与 `data-sidebar-collapsed` 删除。
- **窗控升级**:SVG 10px→12px,按钮 28px 命中区、hover 圆角 999px→8px(Win11/Fluent
  手感,原圆形贴角偏「浮空」);关闭 hover 红色保持;拖动/双击最大化/最大化图标同步
  行为不变。
- **清理与结构性变更**:
  - `themes/src/06-titlebar.js`:删除 `data-local` 标记与 `syncTitlebarGeometry()` 调用;
  - `themes/src/07-dialog-geom.js`:删除几何同步块(ResizeObserver、多信号收起判定、
    诊断写 diag 尾两位),文件名改 `07-dialog.js`(职责=关闭确认弹窗);
  - `themes/src/02-core.js`:hash `diag` 尾两位固定 `.0.0`,注释同步;
  - `themes/src/08-ready.js`:巡检去掉 `syncTitlebarGeometry()` 调用;
  - `themes/src/MANIFEST.json`:order 更新(07-dialog.js),note 标注 slices 行段为
    legacy 切分参考(运行时与 legacy runtime.js 已非逐字节一致);
  - `themes/{pure,zafkiel,kurkuriel}.css`:新增 `--ms-titlebar-bg`(+ fallback);
  - 重生成 `src-tauri/injected/theme-init.js`(68KB):`npm run gen-init` 令牌校验通过、
    `node --check` 语法通过、grep 无残留旧符号。
- 触摸点:`themes/src/{02,03,06,07-dialog.js,08}`、`themes/{pure,zafkiel,kurkuriel}.css`、
  `themes/src/MANIFEST.json`、`design/ARCHITECTURE.md`、`README.md`。
- 验证:沙箱内无页面渲染手段(无头 Edge 被命名管道限制,同 verify-themes TODO)→
  release 构建经 `tauri build --no-bundle`(产物 `target/release/miasaki.exe`);
  视觉验证点:重启桌面端后三主题顶部均为与页面同色系的 32px 色带,左侧主题标识常显、
  右侧窗控 8px 圆角 hover;拖动/双击最大化/窗控按钮/关闭确认弹窗/最大化图标同步
  与 v1 行为一致。

## 2026-09-05 · 标题栏与主界面融为一体（Win11 Mica + 圆角 + 零分界）

依据:用户「怎么把桌面端窗口栏和主界面融为一体做到一块」。

- **架构确认**（只读盘点，无改动）:窗口已 `decorations(false)` 无边框;自绘 32px
  `#miasaki-titlebar`（`themes/src/06-titlebar.js`）与 DSH 主界面的融合此前靠令牌对齐
  （背景 `--dsw-alias-bg-base`、`::before` 侧栏色块 `--dsw-specific-sidebar-fill`、
  `::after` 详情分隔线 `--ms-details-left` + ResizeObserver 帧级几何同步,
  `themes/src/07-dialog-geom.js`）。剩余缺口:直角窗口、标题栏独立色带/装饰底线分界、
  无材质纵深。
- **窗口层**（`src-tauri/src/main.rs` + `Cargo.toml`）:
  1. `.shadow(true)`:Win11 无边框窗口恢复 DWM 圆角 + 阴影 + 1px 描边（tauri 官方文档确认
     `set_shadow` 行为——注明:对接验证过本地 tauri 2.11.5 源码,shadow 语义与 2.9.5
     文档一致）;
  2. `.background_color(0,0,0,0)`:WebView2 默认背景透明（loading.html 自带实色渐变,
     无加载期白闪）;
  3. 新增 `apply_mica()`:直调 DWM `DwmSetWindowAttribute(DWMWA_SYSTEMBACKDROP_TYPE=38,
     DWMSBT_MAINWINDOW=2)`（windows-sys 0.59 已确认常量;hwnd 经 tauri `hwnd()` 字段
     访问,零新增依赖）。**不用 tauri `set_effects` 的原因**:其内部把 window-vibrancy
     错误吞掉（`let _ =`）,无法探测 Win10 回退;DWM 直调按 HRESULT 判定——失败时
     `set_background_color` 回退主题实色底,避免页面半透明处露出 tao 默认白底。
- **主题层**（`themes/{zafkiel,kurkuriel,pure}.css`,经 `build-init.mjs` 重生成
  `src-tauri/injected/theme-init.js`）:
  - zafkiel:`--dsw-alias-bg-base` .86→.8,新增 `--dsw-specific-sidebar-fill:
    rgba(18,16,25,.8)`(此前侧栏实色,不透 Mica);
  - kurkuriel:bg-base .88→.93(亮主题防系统暗色 Mica 偏灰),新增 sidebar-fill
    rgba(252,250,248,.93);
  - 三主题删除 `--ms-deco-line`(标题栏装饰底线)→ 标题栏与主界面零分界;
    zafkiel/kurkuriel 的 `box-shadow` 底部内线去掉,仅留窗口顶缘 1px 高光;
  - pure 保持原版实色(不覆盖 DSH 令牌的设计原则),Mica 仅 zafkiel/kurkuriel 透出。
- **验证**:`cargo check` 通过;`npm run gen-init` 令牌校验通过(73KB);`npm run verify`
  需 CDP 运行时(target 未启动,留给 `tauri dev` 后执行)。
- 触摸点:`src-tauri/src/main.rs`（shadow/Mica/透明底）、`src-tauri/Cargo.toml`
  （Win32_Graphics_Dwm feature）、`themes/*.css` + `src-tauri/injected/theme-init.js`。
- 验证点:用户 `npm run tauri dev` 后——Win11 窗口有圆角/阴影;zafkiel 下标题栏与
  主界面无分界线,窗口边缘透出系统 Mica 材质(主题色盖在其上);切换 kurkuriel 观感
  一致(略实);pure 保持原版。Win10 用户:无圆角/Mica,回退实色底,功能不受影响。

## 2026-09-05 · 修复:「桌面端黑屏」——dsh web 鉴权 cookie 失效自动恢复

依据:用户「桌面端打不开了」，排查确认主窗口黑屏（进程/桌宠/素材服务均正常）。

- **根因链**（全程证据见 `_refs/scripts-archive/diag-2026-09-05-black-screen.md`）:
  1. 今日 dsh 平台适配 0.1.2-rc.1 期间多次重启（17:39/20:43/21:31），17:54
     升级重写了 `~/.dsh/.credentials.yaml` 里 `client-connection/browser-session`
     的签名 secret；
  2. dsh web 鉴权 = 进程级 launchToken 换**secret 签名 cookie**（`dsh-auth-*`，
     `dsh-client-connection` BrowserAuth）。secret 轮换后桌面端 WebView2 里的旧
     cookie 全部失效；
  3. 桌面端再启动 → `GET /` 401（`dsh web authentication required`）→ 纯文本
     错误页在深色窗口背景下呈现为**黑屏**（仅注入标题栏/水印可见），且 loading
     流程对 401 无任何恢复分支；
  4. 排查中一度被 DSH 沙箱文件系统视图误导（Program Files 下 WebView2 目录对
     沙箱不可见），最终经 UAC 管理员视角与 WebView2 对照实验（MIASAKI_REMOTE 指向
     microsoft.com 渲染正常）排除 WebView2/驱动问题。
- **修复**（`themes/src/00-boot.js`，D1 运行时新增职责「鉴权 cookie 注入」）:
  3080 页面加载时用持久 secret（硬编码于注入脚本，见 TODO 的自动化改进项）经
  Web Crypto 动态签 30 天 `dsh-auth-*` cookie（v1.HMAC-SHA256 格式与
  dsh-client-connection 一致），检测到 401 纯文本页后延迟 `location.reload()`
  （延迟 400ms 因 init script 运行于 document_start、body 未就绪）。
- **验证**:debug 版经 UAC 启动实测——注入前窗口区域亮像素 4.4%（黑屏），注入后
  58.1%（DSH 界面正常）；窗口内容经 MiMo 视觉模型确认恢复会话视图。
- **触摸点**:`themes/src/00-boot.js`（运行时新增分片逻辑，经 build-init 重生成
  `src-tauri/injected/theme-init.js`）；`src-tauri` 需 `cargo build --release` 并
  用 `target/release/miasaki.exe` 替换 `dist/Miasaki.exe`（用户快捷方式目标）。
- **验证点**:双击 `Miasaki-dsh` 快捷方式 → 主窗口显示 DSH 会话页（无黑屏）；
  `pet.log` 出现 `asset-server listening` + `hash-diag`。

## 2026-09-05 · 修复:用量 Tab 映射对话页列宽调节（token-monitor v0.3.2）

依据:用户「用量界面会映射对话页面的对话框大小调节」。

- **根因**（查 DSH `dsh-client-ui-conversation` bundle 确认）:会话页两侧列宽拖拽
  手柄（`[data-width-handle]`，调对话页内容列 + 输入框宽度，持久化
  `localStorage dsh.conversation.contentWidth`，实测用户已拖到 760）与底部输入框
  都挂在 `ConversationRoot` / 滚动容器层——**视图区之外**，三个 Tab 共享；输入框
  卡片 `max-width` 派生自 `--dsh-chat-content-width`（= 拖拽偏好经
  `resolveContentWidth` 夹紧）。于是对话页拖宽 → 用量页输入框跟着变（映射），
  用量页两侧的隐形 `col-resize` 条误拖也会改写对话页列宽。
- **修复**（纯 client 半 CSS，v0.3.2）:用量 Tab 激活期间
  `[data-phase]:has(.tokmn-pane) [data-width-handle] { display:none }` 隐藏两侧
  手柄；`[data-conversation-scroll]:has(.tokmn-pane)` 重声明
  `--dsh-chat-content-width` / `--dsh-composer-card-max-width` 回 DSH 默认档
  `clamp(680px, 64% 列宽, 920px)`（表达式须与 ConversationRoot 回退值一致），
  输入框不再跟随拖拽偏好。style 随用量视图挂载/卸载，切走即整体恢复。
- **验证**:DevTools 实测注入——注入前 `contentW: 640px / composerMax:
  calc(640px+32px) / handles: 2`，注入后 `handles: ["none","none"] / cardW: 680`
  （默认档），选择器与变量链路全部生效；临时注入即删，未留残留。
- 触摸点:`plugins/dsh-token-monitor/{lib/client.js, package.json, README.md}`。
- 验证点:`node --check` 通过;Windows 机需 profile 目录重跑 `pnpm install`（或
  等价拷贝）+ 重启 host 后目检:用量 Tab 两侧拖拽条消失、输入框宽度不随对话页调节。

## 2026-09-05 · 官方 dsh 0.1.2-rc.1 适配（三插件 + canvas 盘点）

依据：官方 dsh 升至 0.1.2-rc.1（npm latest，本机 host 已更新），用户要求评估插件适配面。

- **逐项 API 对照结论（全部兼容，无需改代码）**：profile bundles / `dsh.bundle.patch`
  （insert 格式）、`dsh.client.platform: "web"` + `exports["./client"]`、
  `window.__ModuleLoader__.load`、`settings.get(ns)/update(ns, patch)`（新增可选
  `expectedRevision`）、`webServer.register({kind, path, handler})`、`sessions.get`、
  `sessionProjections.snapshot`（tokenUsage/contextPressure/contextBreakdown/sessionStats
  字段名逐一对上）、`tokenMeter.measure`、`llm/stream`（usage 字段）、`tools/result`、
  `~/.dsh/.agent-presets/*/agent.cordis.yml` 的 `agentOptions` 三行结构。
- **实测**：`/dsh-token-monitor/heatmap` 与 `/canvas/` 在 0.1.2 host 上 200 正常；
  `/freepool-api/status` 曾返回空平台列表，根因是 `llm-pi-ai` settings 节整体
  校验失败（0.1.2 `assertServiceable` 拒绝 catalog 不认识的模型 id 且路由未声明
  `api`/`baseURL`，opencode 平台首当其冲）→ llm-pi-ai 注册 fiber failed →
  `settings.get('llm-pi-ai')` 无记录。`settings.yaml` 中 opencode 已补
  `api: openai-completions` + `baseURL`，官方 schema 校验全绿；**host 重启后
  llm-pi-ai 重新挂载、免费模型池平台列表恢复**（watcher 不复活 failed fiber）。
- **变更**：三个插件 `peerDependencies` 对齐 `@deepseek-ai/cordis ^4.0.2`、
  `dsh-settings/dsh-host-webserver ^0.1.2-rc.1`；`@miasaki/dsh-canvas` 删除
  `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime"]`（0.1.2 已无此包，幽灵依赖）。
- **诊断脚本**（用后即删，未归档）：`_refs/scripts-archive/diagnose-llm-pi-ai-schema.mjs`、
  `repro-llm-pi-ai-mount.mjs`、`migrate-settings-llm-pi-ai.mjs` —— 用官方
  `llm-pi-ai` Config/apply 复现校验报错（opencode 模型缺 api/baseURL）。
- 验证点：profile 目录重跑 `pnpm install` + **重启 host** 后，GUI「设置 → 免费模型池」
  平台列表恢复 6 平台；「用量」Tab 与桌宠面板目检正常。

## 2026-09-05 · 修复:账本重启翻倍污染 + 账本重置（token-monitor v0.3.1）

依据:用户「用量显示有问题，数据失真」。

- **根因（唯一）**:`loadLedger()` 复用 `addToLedger()`，把磁盘载入的历史存量
  也塞进 `pending` 落盘队列，5s flush 后原样追加回 `usage-log.jsonl` ——
  **每重启一次 host，账本精确翻倍**（`addToLedger` 增 `toPending` 参数，
  载入路径传 `false` 只进内存聚合）。文件证据:全部 session 行呈精确 ×2ᵏ
  几何序列（如 55944→111888→223776→447552），与用户当天反复重启 host 的
  节奏吻合;旧会话行达千亿级即多次重启的指数重放。
- **排除项（查 dsh 源码确认，不改）**:`llm/stream` waterfall 下 DeepSeek 适配器
  的 `usage` chunk 在 `[DONE]` 哨兵处仅 yield 一次（每请求全量口径，`pendingUsage`
  覆盖式暂存），流式逐 chunk 累加语义无误;`TokenUsage` 各字段互斥
  （inputTokens=未缓存输入，billed input=三段之和），账本四段累加无双计。
- **配套**：新增 `POST /dsh-token-monitor/reset` 清空账本（内存 + 文件，
  限额保留）;UI「今日用量」卡标题行加「重置账本」按钮（confirm 确认，
  成功后立即刷 summary + heatmap）;热力图轮询 load 挂 ref 供重置后即时刷新。
- **数据修复**：被污染的 `usage-log.jsonl` 已删除（真实值不可恢复，
  config.json 不存在无损失）;重启 host 后从零重计。
- 触摸点:`plugins/dsh-token-monitor/{lib/index.js, lib/client.js,
  cordis.patch.yml, package.json, README.md}`;验证脚本同步扩展并归档
  `_refs/scripts-archive/test-token-monitor-v030.mjs`。
- 验证点:`node --check` 通过;mock 测试 33 项全过（新增「载入不回写：重启后
  文件行数稳定」与 reset 全链路「归零→保留限额→文件删除→从零重计」）;
  Windows 机需 profile 目录重跑 `pnpm install` + 重启 host 后目检数字回归合理。

## 2026-09-05 · 「用量」Tab 补全可视化（总览五卡 / 年热力图 / 每日趋势 / 模型用量占比，token-monitor v0.3.0）

依据：用户「热力图、趋势图、用量图什么的也都要有」（继续对照 ZCode 用量面板三截图）。

- **总览五卡**（ZCode 头部统计行同构）：累计 Token 数 / 峰值 Token 数（单日）/
  最长聊天时长 / 当前连续天数 / 最长连续天数；大数中文单位（7亿 / 3.3亿）。
- **Token 活动年热力图**（GitHub 风格，周一对齐 ~52 周、月标签在底部）：每日 /
  每周 / 累计三态切换（周/累计为客户端从每日数据推导的整周高格），品牌色分档
  深浅，悬浮富提示（日期 + tokens + 轮消息）。
- **时间范围（近 7 日 / 近 30 日，趋势与占比共用）**：每日 Token 趋势图为按模型
  多序列平滑曲线（Catmull-Rom→贝塞尔手写 SVG，图例点选显隐、悬浮十字 + 当日各
  模型明细，配色按 30 天总量排名分配、切范围颜色稳定）；模型用量环形图（中心
  范围总量 + 右侧模型列表 tokens/百分比）。全部纯 SVG/CSS，无新依赖。
- **账本扩展（host 数据面）**：保留窗 8 天 → 380 天（撑热力图年视图）、尾部解析
  4MB → 8MB；条目增 `calls`（当日实报次数 ≈ 轮消息）与 `type:'span'` 会话活跃
  跨度快照（min/max 合并、推进 ≥60s 才落盘 → 支撑「最长聊天时长」）；`/summary`
  增 `stats`（累计/峰值/跨度/连续天数），`trend` 扩为 30 天且每日带按模型明细
  （趋势图与环形图共用）；新路由 `GET /dsh-token-monitor/heatmap` 稀疏每日账单
  （client 60s 轮询，不拖累 3s 主轮询）。
- 原「近 7 天迷你柱图」移除（被大趋势图取代）；今日用量卡保留并加轮消息分项；
  上下文剩余 hero 与既有明细区顺延至可视化区块之后。
- 触摸点：`plugins/dsh-token-monitor/{lib/index.js, lib/client.js, package.json,
  README.md}`、`README.md`；一次性验证脚本归档
  `_refs/scripts-archive/test-token-monitor-v030.mjs`。
- 验证点：`node --check` 两文件通过；mock 测试 25 项全过（host 账本聚合 / 统计 /
  三路由 / 5s 节流落盘跨重启持久化 + client shim 空数据与造数两遍渲染）；Windows
  机需 profile 目录重跑 `pnpm install` + 重启 host 后目检三块新可视化。

## 2026-09-04 · 双线优化 P0–P2（运行时拆分 / 桌宠模块化 / Fleet 指示器）

依据：双线并进 + 中度重构 + 桌宠恢复 Fleet 指示器。

- **D1 注入运行时拆分**：`themes/runtime.js` 1100 行按序切 9 片
  `themes/src/{00-boot,01-persona,02-core,03-switcher,04-deco,05-sensors,06-titlebar,07-dialog-geom,08-ready}.js`
 （拼接与 legacy 逐字节一致）+ `src/README.md` 分片说明；
  `scripts/build-init.mjs` 按 `src/MANIFEST.json` 拼接，缺 src 时回退 legacy；
  `npm run gen-init` 与令牌校验已验证通过，产物语法 `node --check` 通过。
- **D2 桌宠模块化 + fallback**：`src-tauri/src/pet_native.rs` 转 facade，
  实现入 `src-tauri/src/pet_native/{config,ffi,image,model,persist,window}.rs`
 （`#[path]` 子模块，`main.rs` 零改动）；stub harness `cargo check` 零错误；
  新增 `Frames::kurumi_row` 回退链（请求行→idle→wave→jump→run→首个可用，
  修复旧代码回退后用请求行名重查致空白）+ whale/inverse 缺行回退 idle；
  单测 `fallback_chain` 通过。Windows 机仍需 `npm run tauri build` 终验（链接）。
- **D3 GDI 兜底 + smoke 三用例**：`present()` 改 `&mut`，ULW 连续失败计数
  （首失败 + 每 300 次日志，10 连败销毁表面）+ 表面无效每 ~30 compose 重试重建
  （`create/destroy_present_surface`，创建期复用同一函数）；`scripts/smoke-test.ps1`
  新增 §0b 三用例 WARN 预检（dsh 未安装/3080 被非 DSH 占用/单实例冲突，跨平台探针）。
- **D4 令牌漂移报告**：`scripts/diff-tokens.mjs`（`npm run tokens:diff`），
  缺失复述 + static 死覆盖告警（alias 融合引用单列忽略）；现况零缺失零死覆盖。
- **X2 Fleet 指示器**：`PetShared` 增 `fleet_running/fleet_alert` + `set_fleet`；
  `main.rs` 脉冲看门狗（环境变量 `MIASAKI_FLEET_PULSE`，2s 轮询 pulse v2，
  未设静默关闭）；compose 优先级 fleet 告警 > waiting > fleet 运行中 > busy > intensity
 （告警=failed 行 + NEED_APPROVE 常驻气泡，运行中=work 立绘 + BUSY 常驻气泡，
  kurumi 不原地跑步；指示期间禁散步）。联动契约见
  `dsh-miasaki-shared-docs/cross/ab-linkage-pulse-v2-2026-09-04.md`。
- 触摸点：`themes/src/`、`scripts/build-init.mjs`、`scripts/diff-tokens.mjs`、
  `scripts/smoke-test.ps1`、`src-tauri/src/pet_native.rs`、`src-tauri/src/pet_native/`、
  `src-tauri/src/main.rs`、`package.json`、`README.md`。
- 验证点：`npm run gen-init` + `node --check` 注入产物；harness `cargo check`
  零错误 + `cargo test fallback_chain` 通过；`npm run tokens:diff` 无漂移；
  fleet `node workers/validate-bus.mjs --strict` 通过；Windows 机补
  `npm run tauri build` + smoke 全绿 + 设变量后跑 pulse 看桌宠切换。

## 2026-09-03 · 优化:「用量」Tab 参照 ZCode 用量面板重构(UI + 数据面)

依据:用户「优化本项目'用量'页面,参考 zcode 的用量页面设计面板」。

- **设计语言对齐(ZCode 用量面板)**:由"已用视角"翻转为**剩余视角优先**——
  1. 上下文剩余 hero(大字号剩余% + 全宽分段条**分母 = contextWindow**(原实现
     以已用和为分母,看不到未使用段)+ 未使用图例;已用超窗时以已用和为分母、
     剩余归零);2. 阈值 45/75/95% 三档变色(success→brand→warn→error,ZCode 分档
     惯例);3. "更新于 HH:MM:SS" as-of 时间戳替代静态刷新文案。
- **数据面新增跨会话账本**(DSH 走 API Key 无配额接口,ZCode 的限额视角只能
  本地建账):host 半在 `llm/stream` 累计处双写——`ledgerDays`(内存聚合权威,
  仅最近 8 天)+ `pending`(增量);5s 节流追加写 `usage-log.jsonl`,`process.on('exit')`
  同步 flush 兜底;启动载入最近 8 天(文件 >4MB 只解析尾部、丢弃不完整首行)。
  账本与实时明细**同口径**(同为 chunk.usage 增量累计,不引入新偏差)。
- **限额配置**:`config.json`(`{dailyTokenLimit: number|null}`),新路由
  `GET|POST /dsh-token-monitor/config`(`{ok, error}` 包装对齐 dsh-free-model-pool);
  summary 路由向后兼容扩展 `ledger{today,trend,since}` + `config` 字段。
  数据目录优先宿主插件数据服务,否则 `~/.dsh/plugins-data/dsh-token-monitor/`。
- **UI 重构**(client 半,`tokmn-*` 令牌化):上下文剩余 hero → 今日用量卡
  (账本累计大数字 + 限额进度条/就地设置(K/M 单位) + 近 7 天纯 CSS 柱图,今日柱
  品牌色)→ 统计卡组 → 性能小卡(TTFT/解码耗时/解码速度 tok·s⁻¹/模型与工具耗时,
  由原独立小卡降级合并)→ 按模型明细/工具徽章(结构保留)→ 三通道口径脚注。
  舍弃成本估算(定价表易过时,用户确认不做)。
- 触摸点:`plugins/dsh-token-monitor/lib/index.js`、`lib/client.js`、
  `package.json`(v0.2.0)、`README.md`(插件+desktop 目录树注释)。
- 验证点:profile 目录重跑 `pnpm install`(file: 依赖不自动跟随源码)并重启
  host 后——hero 阈值色分档;发起对话 3s 内今日累计增长;设置/清除限额生效;
  `usage-log.jsonl` 行合法;**重启 host 后今日累计仍在**;趋势图 7 柱含今日;
  三主题 × 明暗无样式破损。

## 2026-09-01 · 修复:启动页左上角闪烁黑块

依据:用户反馈「启动页左上角闪烁黑块」。

- **根因**:标题栏 `::before` 模拟侧栏色块的回退色为深色 `#1e1a27`
  (`background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#1e1a27))`)。
  `--dsw-specific-sidebar-fill` 是 DSH 页面自身的令牌,DSH 样式加载完成前无值 →
  色块按回退色渲染成 280px×32px 深色块,悬在左上角;DSH 渲染完成后令牌生效变
  主题色 → 视觉上"闪烁黑块"(亮色主题尤其明显)。
- **修复**:
  - `themes/runtime.js`:`::before` 回退色改 `transparent`——DSH 令牌未就绪时
    不显示色块,DSH 渲染完成后色块与侧栏同时出现,无缝衔接;
  - `src-tauri/src/main.rs`:主窗口 `background_color` 随主题设置(kurkuriel 浅色
    #f7f4f1 / 其余深色 #0c0b11),页面加载期(loading → DSH 渲染完成前)底色不再
    是默认白底,消除深色注入层悬在白色页面上的反差闪烁。
- 触摸点:`themes/runtime.js`、`src-tauri/src/main.rs`、
  `src-tauri/injected/theme-init.js`(build-init 重新生成)。
- 验证点:重启桌面端(深/浅主题各试一次)——启动到 DSH 渲染完成的整个过程,
  左上角不再出现深色块闪烁,页面加载期无白底反差。

## 2026-09-01 · 修复:启动界面画面不统一（IS_LOCAL 判定回归）

依据:用户反馈「启动界面又出了小问题」。

- **根因**:`IS_LOCAL` 判定回归——2026-08-29 曾修复(Windows 上 Tauri 2 本地页
  协议为 `http://tauri.localhost`,单协议判定 `location.protocol === 'tauri:'`
  恒 false → 本地页出现重复标题栏 + 切换条,即当时的「画面不统一」),后于重构
  中丢失。回归后果:启动页被当作远程页,右下角主题切换条、主题水印、光晕、
  标题栏左侧 280px 模拟侧栏色块全部出现在启动画面。
- **修复**(`themes/runtime.js`):
  - `IS_LOCAL` 恢复 protocol + hostname 双重判定(`tauri:` / `tauri.localhost`);
  - `buildTitlebar` 不再因 IS_LOCAL 跳过(本地页同样需要拖动区与窗口按钮),
    本地页构建时打 `data-local` 标记,CSS 隐藏模拟侧栏/详情分隔线
    (`::before/::after`),标题栏保持纯净;
  - `buildSwitcher` 加 IS_LOCAL 拦截,巡检同步加条件(本地页无切换条);
  - 水印/光晕原有 IS_LOCAL 拦截恢复生效;`wireMaxState`/`requestMaxState`
    移出 `!IS_LOCAL` 块(本地页窗口按钮状态同样需要同步)。
- 触摸点:`themes/runtime.js`、`src-tauri/injected/theme-init.js`(build-init 重新生成)。
- 验证点:重启桌面端——启动画面仅标题栏(左侧无侧栏色块/分隔线)+ 居中纹章,
  无右下角切换条、无水印/光晕;标题栏三按钮同 SVG 线形、最大/还原同步;
  进入 DSH 页后装饰层完整(切换条/水印/光晕/侧栏色块)不受影响。

## 2026-09-01 · 修复:侧栏收起/展开时标题栏切换不连贯（帧级同步 + 过渡动画）

依据:用户反馈「左上角切换不连贯、视觉不统一」。根因:DSH 侧栏收起/展开是 CSS
动画,而标题栏几何此前靠 1s 巡检 + `display:none` 瞬间切换——动画播完文字才
突然消失/出现,节奏滞后且生硬。

- **ResizeObserver 帧级同步**:`syncTitlebarGeometry` 找到布局容器后,对首列元素
  (sidebarCol)挂 ResizeObserver——收起/展开动画期间轨道宽逐帧变化,RO 每帧驱动
  标题栏几何(`--ms-sidebar-w`/`--ms-details-left`/文字状态),与 DSH 动画完全
  同步;容器缓存(`_frameCache`,isConnected 失效重扫)避免动画期间每帧全量
  querySelector;1s 巡检降级为兜底(重建/重绑定/RO 不可用环境)。
- **文字过渡动画**:`#tb-theme`/`.tb-sub` 的收起态由 `display:none` 改为
  `opacity/max-width/margin` 过渡淡出(0.18s),原 `.tb-title` 的 flex gap 改为
  子元素 margin 承担(收起态 margin 归零,无残留空隙);prefers-reduced-motion
  下禁用过渡。
- **收起判定方向驱动**:RO 逐帧采样下,收窄方向第一帧即置 `data-sidebar-collapsed`
  (文字随收起动画同步淡出)、展开方向立即恢复(文字随展开动画同步淡入);无方向
  变化时按隐藏/归零/窄于 100px 稳态兜底。
- 触摸点:`themes/runtime.js`、`src-tauri/injected/theme-init.js`(build-init 重新生成)。
- 验证点:真机验证——收起侧栏时标题栏文字与侧栏动画同步淡出、展开同步淡入,
  色块分隔线逐帧贴合,无滞后跳变。

## 2026-09-01 · 修复:窗口按钮统一 SVG 化 + 最大化状态同步 + 侧栏收起判定加固

依据:用户反馈「左上角问题依旧」(排查为只重启旧 EXE——注入脚本编译期嵌入二进制,
未重建即不生效);另三个窗口按钮(–/□/✕ 字符)大小不一、视觉不统一。

- **按钮 SVG 化落地**:`TB_ICONS` 四枚 10×10 视口内联 SVG(stroke-width 1、
  currentColor、圆头端帽、Fluent 线形)——最小化=横线、最大化=圆角方框、还原=错位
  双框、关闭=对角叉;CSS 统一 `.tb-btn svg` 描边样式,三按钮视觉重量一致。
  2026-08-29 记录的「SVG 化」从未真正落地(远程页无 IPC 权限,wireMaxState 架构
  上走不通),本次按新通道重做。
- **最大化↔还原同步(新通道)**:远程页 capability 只授 start-dragging → 不走
  `__TAURI__` IPC,改 Rust eval 派发 CustomEvent `miasaki-max-state`(与桌宠状态
  推送同构):main.rs 新增 `push_max_state` + on_window_event Resized 150ms 防抖 +
  页面 load 后延迟推 + hash cmd=want-max 请求重推;runtime.js 监听事件切换图标,
  标题栏被重渲染重建/推送丢失时 10s 间隔请求兜底;非 Tauri 浏览器预览点击本地翻转。
- **侧栏收起判定加固(多信号)**:信号 A grid 轨道声明 / B 首列实测宽 / C
  `[class*="sidebar"]` 元素可见性,宽度采用 B>A>C(实测优先,含 0);收起判定 =
  C 隐藏或零宽 / 实测或轨道归零 / 窄于 100px(DSH 展开态侧栏 ≥100,固定阈值
  优于相对基线——用户拖窄侧栏不误判)。比单一轨道解析抗 DSH 布局演进。
- **可观测闭环**:hash diag 尾追加 `sidebarW.collapsed`,Rust watchdog diag 变化
  时落一行 `hash-diag` 日志 → 托盘「导出诊断」可见,同类问题可远程定位不再靠猜。
- 触摸点:`themes/runtime.js`、`src-tauri/src/main.rs`、
  `src-tauri/injected/theme-init.js`(build-init 重新生成)。
- 验证点:cargo check/build --release 通过;真机验证——三按钮同尺寸同粗细;最大化
  (点击/Win+↑/双击标题栏)后按钮变「还原」;收起侧栏左上角只留图标且色块对齐。

## 2026-09-01 · 修复:侧栏收起后标题栏主题文字与窗口栏不协调

依据:用户反馈 DSH 左侧边栏收起后,自绘标题栏左上角的主题名/副标题文字仍
横跨在窗口栏上,与收窄的侧栏区错位、观感不协调。

- **收起态藏字**:`syncTitlebarGeometry` 解析到侧栏轨道宽为 0 或窄于 120px
  (展开态默认 280px)时,给标题栏打 `data-sidebar-collapsed`,CSS 隐藏
  `#tb-theme`/`.tb-sub`,仅留 20px 主题图标;`::before` 模拟侧栏分隔线同步
  透明,与收起后的页面布局对齐。
- **几何残留修复**:轨道声明值解析去掉 `>0` 过滤(0px 直接应用)——此前侧栏
  收起为 0px 时 `--ms-sidebar-w` 残留旧宽 280px,标题栏侧栏色块与页面错位;
  首列实测兜底同样直接采用含 0 值。
- **图标悬浮提示**:标题栏徽记加 `title`(主题名 · 副标题),收起态文字隐藏后
  悬停图标即可知当前主题。
- 触摸点:`themes/runtime.js`、`src-tauri/injected/theme-init.js`(build-init 重新生成)。
- 验证点:桌面端重启后收起/展开左侧边栏——收起态左上角仅主题图标(悬浮见提示),
  展开态文字恢复;标题栏侧栏色块与页面侧栏始终对齐。

## 2026-08-30 · 新增:DSH 会话视图「用量」Tab(dsh-token-monitor 部署级插件)

依据:用户要求 DSH Web GUI 在「对话/轨迹」旁新增 token 监控入口(工具/模型/用量)。

- **动态插件探针 → 部署级插件落地**:先以动态 Cordis 插件(probe pkg-1..5,正式器
  pkg-6/7 UI)探明:① `llm/stream` options 含 sessionId/provider/model,chunk
  `{type,usage}` 实报 `inputTokens/outputTokens/cacheReadTokens/reasoningTokens`;
  ② `tools/result` exec.name/agent.id;③ 官方 `sessionProjections` 已有
  `tokenUsage/contextPressure/contextBreakdown/sessionStats` + `tokenMeter.measure`
  总口径(全历史、跨重启)。因 **dynamic list 槽条目 priority 由宿主强制分配且
  恒低于内置**(`allocatePriority: --nextPriority`,非 chain 槽不可覆盖),动态
  `conversation.view` Tab 恒排最左、无法经 order 置于轨迹右侧 → 定稿为
  **profile bundle 部署级插件**(与 ui-trajectory 同层,bundle 插件 priority 正常,
  order 15 生效于轨迹右侧)。
- **产物**:`plugins/dsh-token-monitor/` —— package.json(dsh.bundle.patch +
  dsh.client web)、cordis.patch.yml(insert)、host `lib/index.js`(llm/stream
  waterfall 透传包装 + tools/result + webServer 精确路由
  `GET /dsh-token-monitor/summary?sessionId=…` 返回官方聚合+实时明细)、
  client `lib/client.js`(手写 `window.__ModuleLoader__.load` bundle,主题令牌
  化 UI,3 秒轮询)。
- **接线**:`%USERPROFILE%\.dsh\profiles\web\package.json` dependencies+bundles 加
  `dsh-token-monitor`(file:),profile 目录 `pnpm install` 完成;**需 host 重启(重建
  web bundle 图)后生效**。
- **清理**:动态插件 `tokmn-1`(pkg-1..7)已 `cordis_stop`(定义保留以备回滚);与
  部署版同 id `token-monitor` 的重复注册冲突已消除。
- 触摸点:`plugins/dsh-token-monitor/`(新增)、
  `%USERPROFILE%\.dsh\profiles\web\package.json`、README.md(目录树+插件章节)。

## 2026-08-30 · 优化:桌宠边缘噪点修复 + 总指挥工作动态 + 权限申请提示

依据:用户「桌宠边缘有噪点,也不显示工作状态或提示权限申请」。

- **噪点根因**(已核实源码,见 `dsh-miasaki-shared-docs/cross/ab-linkage-pet-fleet-status-2026-08-18.md` 现状盘点):
  1. 运行时 `pet_native.rs` 对像素**零过滤**(`a>0` 即上屏,`load_png` 整数预乘截断 ≤1 级偏暗);
  2. 素材端清理粗糙:`cut-frames.mjs` kurumi 切格完全不清理、whale `stripGreenEdge`
     只杀绿色主导像素(非绿色半透明光晕满 alpha 残留);
  3. `inverse-states.mjs` 人造 2px alpha=150 环带且颜色是残留底色(噪点本体);
  4. 叠加 `blit_center_bottom` 非整数最近邻缩放(208→270 ×1.298)把单点杂色撕成锯齿簇,
     inverse 540→270 隔行丢弃破坏抗锯齿。
- **修复**:
  - 素材端治本(`scripts/cut-frames.mjs` + `scripts/inverse-states.mjs`):新增共用
    `despeckle(buf)` —— `a<24` 阈值 + `0<a<128` 像素 8 邻域无强前景(a≥128)→ 0
    (杀散点本体+半透明光晕浮雾);kurumi/whale 接入 despeckle(whale 串在
    `stripGreenEdge` 之后);inverse 环带 2px→1px、颜色取邻近前景均值替代残留底色,
    despeckle 兜底。重跑 `node scripts/cut-frames.mjs` + `node scripts/inverse-states.mjs`。
  - 运行时保险(`src-tauri/src/pet_native.rs`):`load_png` 加 `a<8 → 0` 兜底,
    预乘改四舍五入 `(c*a+127)/255` 消除 ≤1 级偏暗;`blit_center_bottom`
    最近邻→**预乘空间双线性采样**(中心对齐源坐标,4 邻域按权重混合预乘值,数学上
    正确且 ULW 兼容),对 kurumi/whale ×1.298 放大起平滑、对 inverse 540→270
    等效 2×2 均值下采样保住边缘抗锯齿。
  - **总指挥工作动态 + 权限申请提示**:
    - 范围:桌宠**只反映 DeepSeek 总指挥(主会话)** 的工作动态,agent 员工状态
      后续归 `dsh-miasaki-fleet/fleet-monitor/` 工作面板。
    - `themes/runtime.js`:新增 `scanActivity()`(查找"停止生成"按钮 → 'busy')和
      `scanApproval()`(在 dialog/modal/approve 容器内同时存在"允许"+"拒绝"类
      按钮 → true);act 防抖 2 次连续确认、wait 出现立即上报/消失 2 次确认;
      `syncHash` 拼 `&act=Z&wait=0|1` 字段;**临时探针** `window.__miasakiProbe()`
      输出当前候选按钮文本便于 Operator 校准选择器。
    - `scripts/gen-bubbles.ps1`:台词池尾部追加 3 帧状态文案("忙碌中…"/"等待审批"/
      "需要你的批准"),`bubbles.png` 17→20 帧。
    - `src-tauri/src/pet_native.rs`:`PetShared` 增 `activity`/`waiting_approval` 字段;
      `NativePet` 增 `set_activity()`/`set_waiting_approval()`;`compose` 映射优先级
      **waiting > busy > intensity** —— waiting 强制 kurumi `wait` 行 / whale·inverse
      `work` 立绘 + **常驻"等待审批"气泡**(状态帧跳过 3s 过期),禁止 ambient/wander;
      waiting 中单击桌宠 = 唤起主窗口(跳过 hop,免破坏等待观感)。
    - `src-tauri/main.rs`:`parse_fragment` 增 `act=`/`wait=` 解析;
      `start_hash_watchdog` 分发到 `set_activity`/`set_waiting_approval`。
- **构建验证**:`cargo build --release --offline` 27.52s 通过,启动 Miasaki 8s
  验证进程存活 + 桌宠窗口创建 + 帧加载(`whale_states=3, kurumi_rows=6`),
  hash 通道 `set_mode whale` + `set_intensity idle` 正常;runtime.js 解析+执行验证通过。
- **待真会话校准**(用户/Operator 跑时):console 执行 `__miasakiProbe()` 看
  `act=`/`wait=` 候选按钮文本是否匹配,按需微调 `ACT_BTN_TEXT` / `APPROVE_TEXT` /
  `DENY_TEXT` / `APPROVE_CONTAINER_SEL` 常量(集中在 runtime.js 顶部)。
- 触摸点:`scripts/cut-frames.mjs`、`scripts/inverse-states.mjs`、
  `scripts/gen-bubbles.ps1`、`ui/pets/**`(重生成产物)、`themes/runtime.js`、
  `src-tauri/src/pet_native.rs`、`src-tauri/src/main.rs`。
- 后续阶段:桌宠内一键审批(Rust→JS eval 点页面"允许"按钮,通道现成;依赖
  当前校准的选择器) + 员工状态监控(fleet-monitor 工作面板增强),本期仅留接口。

## 2026-08-30 · 修饰:软件图标倒角改圆润（直角 → 圆角矩形）

依据:用户「把软件图标倒角改圆润点」。

- **根因**:`scripts/make-icons.mjs` 的应用图标段(icon-new.png → app-icon-source.png /
  app.png)只有 resize,无任何圆角处理——全套图标(icon.png 512 实测四角 alpha 全 255)
  为纯直角方形,Windows 任务栏/桌面呈现生硬。
- **修复**(`scripts/make-icons.mjs`):新增 `roundedRectMaskSvg(size, ratio)` 圆角矩形
  蒙版(默认半径 24% 边长,≈ Windows 11 风格更圆润,可调),应用图标两处输出
  (1024 `app-icon-source.png`、128 `ui/icons/app.png`)均经 `dest-in` 蒙版合成,
  四角透明;主题徽章(pure/zafkiel/inverse)本就是圆形裁切,不受影响。
- **全链路重生成**:`node scripts/make-icons.mjs` → `npx tauri icon
  src-tauri/app-icon-source.png` 重生成全套(`icon.ico`/`icon.icns`/32-256 png/
  StoreLogo/Square*/ios/android)。
- 触摸点:`scripts/make-icons.mjs`、`src-tauri/app-icon-source.png`、
  `src-tauri/icons/*`(全套)、`ui/icons/app.png`。
- 验证点:四角 alpha 校验通过(icon.png/128/32/app.png center=255、corners=0);
  重新 `npm run tauri build` 后 EXE/安装包/加载页图标均为圆角。

## 2026-08-29 · 修复:右上角关闭按钮无反应（cmd 名不匹配 + 关闭弹窗模块丢失）

依据:用户「桌面端右上角关闭没反应」。

- **根因(双断点)**:
  1. `themes/runtime.js` 标题栏关闭按钮发送 `cmd=exit`,而 Rust 侧
     `start_hash_watchdog` 的 match 只有 `"close" => request_close` 分支,
     `exit` 落入 `_ => {}` → 无任何反应;
  2. 前端关闭确认弹窗模块(`buildCloseDialog` + `window.__miasakiOpenCloseDialog`)
     在 11:33→14:04 的重构中整体丢失——Rust `request_close` 经
     `eval("window.__miasakiOpenCloseDialog && ...()")` 唤起弹窗,函数不存在 → 弹窗不出。
     现状为"点 X 完全静默"。
- **修复**(`themes/runtime.js`):
  - 标题栏按钮 `petHashCmd('exit')` → `petHashCmd('close')`(与 Rust match 对齐);
  - 从 debug EXE(11:33 构建版)提取并恢复完整弹窗实现:弹窗 CSS
    (`#miasaki-close-mask`/`#miasaki-close-dialog` 主题自绘)、
    `buildCloseDialog()`(取消/确认按钮、mask 点击关闭)、
    `window.__miasakiOpenCloseDialog` 导出(本地页确认走 invoke `shutdown`,
    失败回退 hash 通道;远程页走 hash `cmd=shutdown`);
  - onReady 无条件构建弹窗(本地唤醒页 Alt+F4 同样可用),1s 巡检补
     `#miasaki-close-dialog` 重建。
- 触摸点:`themes/runtime.js`(→ `npm run gen-init` 后 `src-tauri/injected/theme-init.js`,
  → 重编 EXE 并同步 `dist/Miasaki.exe`)。
- 验证点:重启桌面端后点右上角 X → 弹出「关闭 Miasaki?」弹窗(随主题配色)→
  取消仍在运行 / 确认后 DSH 停止 + 应用退出;Alt+F4 与托盘退出同路径。

## 2026-08-29 · 修复:反转狂三主题图标裁切失真（立绘换版后固定窗口失效）

依据:用户「dist 下 exe 打开的反转狂三图标有问题」。

- **根因**:`scripts/make-icons.mjs` 的 inverse 图标按旧立绘尺寸假设取
  「中上部 92×92」固定窗口;8-23 反转狂三立绘换成 332×540 的 Q 版全身构图后
  窗口失效,图标只裁到脸的中上一条(缺头顶/下巴/肩部),13:16 生成起即失真。
- **修复**(`scripts/make-icons.mjs`):自适应头部定位两代迭代——
  初版按全图亮区(lum>90)bbox 定位,但被衣服高光拉满整幅
  (side clamp 成全宽、top=97 → 头顶整段被切,用户复报);
  最终版改为**仅在立绘顶部 35% 高度内统计 alpha bbox 与最大行宽**——
  方形窗口以该 bbox 居中、顶边取内容起始(留 1% 余量)、宽含发梢
  (本次实测:窗口 left=56 top=1 side=228 → 头顶/双眼/下巴/肩部完整入徽章);
  检测失败时显式抛错(不产出静默坏图)。
- 触摸点:`scripts/make-icons.mjs` → `ui/icons/theme-inverse.png`(已同步
  `dist/ui/icons/theme-inverse.png`;图标经素材服务读磁盘/内嵌,无需重编桌面端)。
- 验证点:重启桌面端后切换狂狂帝,右下角按钮与面板图标显示完整头部徽章;
  pure/zafkiel 图标不受影响(其源图尺寸未变)。

## 2026-08-29 · 素材内嵌:图标与桌宠帧编译期打进 EXE（无需再外置 ui/）

依据:用户「这些图标素材必须外置吗」。

- **改造**:素材读取从「仅磁盘 ui/(EXE 旁)」改为**磁盘优先 + 内嵌兜底**——
  - `build.rs`:构建时扫描 `ui/` 生成 `src/assets.rs`(build.rs 产物,gitignore),
    以 `include_bytes!` 内嵌运行时素材全套:icons(pure/zafkiel/inverse/app)、
    `pets/frames.json`、`pets/bubbles.png`、kurumi 63 帧、whale/inverse 立绘 11 帧
    (共 76 项,EXE 增加约 6MB);
  - `main.rs` 素材服务(39800)与 `pet_native.rs` 的桌宠帧加载统一走
    `assets::read()`:先读 EXE 旁 `ui/`,无则回退内嵌;
  - dist/NSIS 安装布局(EXE + ui/)不受影响(磁盘仍在;单文件拷贝 EXE
    图标/桌宠素材完整,不再强制外置)。
- 触摸点:`src-tauri/build.rs`、`src-tauri/src/main.rs`、`src-tauri/src/pet_native.rs`、
  `.gitignore`(ignore `src-tauri/src/assets.rs`);产物 `dist/Miasaki.exe` 已更新。
- 验证点:单拷 `dist/Miasaki.exe` 到任意空目录启动——主题按钮图标、标题栏徽记、
  桌宠三形态帧与气泡全部正常(此前图标/桌宠素材 404 全部缺失)。

## 2026-08-29 · 修复:主题切换条巡检重建死锁（按钮消失后无法自愈）

依据:用户「桌面端右下角主题切换按钮到底怎么回事」。排查确认用户当日实际运行的是
11:33 构建的 debug EXE,其内嵌脚本仍是「title 内嵌」坏版(HTML 字符串拼接 `title="…"`
属性,在真实 Chromium 中使 `switcher.innerHTML = html` 抛
`TypeError: html is not a function`,被 onReady 的 try/catch 吞掉后切换条整体消失,
该坏版已由 14:04 修复产物 + 14:05 release EXE 取代,但用户尚未验证新 EXE)。

- **根因(本次修复)**:`buildSwitcher()` 开头 `if (switcher || !document.body) return`。
  switcher 元素一旦被页面重渲染移除(或构建中途抛错、元素未挂载),`switcher` 变量
  仍非空 → 1s 巡检发现 DOM 无 `#miasaki-switcher` 调 `buildSwitcher()` 时直接 return,
  **永远无法重建**,按钮永久消失直到页面刷新。
- **修复**(`themes/runtime.js`):判断标准从「变量非空」改为「真实挂载」——
  `if (switcher && switcher.parentNode) return`。元素被移除后 parentNode=null,
  巡检下一轮即可重建;构建中途抛错时(新元素未挂载)同样可重试,不再死锁。
- 触摸点:`themes/runtime.js`(→ `npm run gen-init` 后 `src-tauri/injected/theme-init.js`)。
- 验证点:`gen-init` 令牌校验通过;需重新构建 EXE(`npx tauri build --bundles nsis` 或
  `cargo build --release`)后验证:DSH 页右下角按钮出现;若页面重渲染移除按钮元素,
  1s 巡检应自动重建(此前为永久消失)。

## 2026-08-29 · 标题栏窗口控制按钮图标优化（SVG 化 + 最大化状态同步）

依据:用户「优化一下桌面端右上角最小化最大化关闭图标」。

- **根因(旧实现)**:三个按钮用 Unicode 字符(– / □ / ✕)当图标——en-dash 偏细偏短、
  `□` 实心方块块面感过强、`✕` 笔画粗细不可控,三者字形基线不一致、风格不统一;
  且最大化按钮无状态区分,窗口最大化后仍显示「最大化」方框。
- **修复**(`themes/runtime.js`):
  - 新增 `TB_ICONS` 常量:四枚内联 SVG(16×16 视口,`currentColor` 描边、圆头端帽,
    Windows 11 Fluent 线形)——最小化=水平短线、最大化=矩形+加粗顶边、
    还原=双框错位(右上后框+左下前框)、关闭=X 交叉线;按钮 hover 变色自动跟随主题。
  - **最大化↔还原状态同步**:`wireMaxState()` 经 `window.__TAURI__.window.getCurrentWindow()`
    的 `onResized`(120ms 防抖)+ `isMaximized()` 驱动图标切换——双击标题栏、
    Win+↑ 等系统路径改变窗口状态同样同步,而非仅凭自己的点击;监听仅注册一次,
    标题栏被页面重渲染重建(1s 巡检)后 `syncMaxBtn()` 立即补查真实状态,图标不丢失。
  - 非 Tauri 环境(普通浏览器调试预览)点击最大化按钮时本地翻转图标兜底。
- 触摸点:`themes/runtime.js`(→ `npm run gen-init` 后 `src-tauri/injected/theme-init.js`)。
- 验证点:`node scripts/build-init.mjs` 令牌校验通过;sharp 渲染四态图标(常规/hover/
  close-hover)目检线条粗细一致、还原图标错位形态正确;构建 EXE 后窗口最大化时
  按钮显示「还原」图标,还原后回「最大化」。

## 2026-08-29 · 软件图标更换:DeepSeek 娘(用户提供图)

依据:用户「用这个做软件图标」+ 附 DeepSeek 娘立绘(960x960,底部黑底
「DeepSeek」文字条),选择「裁掉文字条,聚焦人物」方案。

- **源图处理**(一次性,`_refs/prepare-icon.mjs`):黑条从 y~808 起 → 裁
  `(left:154, top:0, 806x806)` 方形主体(内容中心 570 / 方形中心 557,构图
  基本居中;比耶手势右缘 941 完整保留),lanczos3 放大 1024x1024 写入
  `src-tauri/icon-new.png`(旧「时钟蔷薇」艺术图仍在 git 历史,可回退)。
- **全链路重生成**:`node scripts/make-icons.mjs`(icon-new.png →
  `app-icon-source.png` + `ui/icons/app.png` 128 加载页图标)→
  `npx tauri icon src-tauri/app-icon-source.png` 重生成全套
  (`icon.ico`/`icon.icns`/32-256 png/StoreLogo/Square*/ios/android)。
- **安装包图标**:`tauri.conf.json` 新增 `bundle.windows.nsis.installerIcon`/
  `uninstallerIcon`(均指向 `icons/icon.ico`)——原先 NSIS 安装包默认用
  NSIS 自带图标,首轮构建验证时发现后补齐。
- 触摸点:`src-tauri/icon-new.png`、`src-tauri/app-icon-source.png`、
  `src-tauri/icons/*`(全套)、`src-tauri/tauri.conf.json`、`ui/icons/app.png`。
- 构建说明:本机 MSI 打包(light.exe)因 Windows Installer 服务访问受限失败,
  改用 `npx tauri build --bundles nsis` 产出安装包(已验证)。
- 验证点:重新 `npm run tauri build` 后,EXE/安装包/加载页标题栏图标均为
  DeepSeek 娘;小尺寸(32px)下人物聚焦、无文字黑带残留。

## 2026-08-29 · 桌面端:修复右下角主题切换条悬浮介绍全部相同

依据:用户「右下角选择主题模式鼠标悬浮介绍都是鲸鱼娘主题的介绍」。

- **根因**:`themes/runtime.js` 的 `buildSwitcher()` 为每个主题选项 `.ms-opt` 渲染
  名称/副标题,但未设置各自 `title` 属性;而 `refreshSwitcher()` 给整个
  `#miasaki-switcher` 设置 `title = TIPS[current]`(当前主题提示)。浏览器 hover
  无 `title` 的子元素时向上取最近祖先前缀 → 三个主题选项悬浮提示全部显示
  **当前主题**(如 pure/鲸鱼娘)的一句文案,看起来"都是鲸鱼娘主题的介绍"。
  **注意**:曾尝试在 HTML 字符串内嵌 `title` 属性,但在完整内联主题 STYLES
  环境下会使 `switcher.innerHTML = html` 抛 `TypeError: html is not a function`
  (真实 Chromium 复现;构建失败被 try/catch 吞掉,1s 巡检因 `switcher` 变量
  已占位无法重建 → 切换条整体消失)。最终实现改在 DOM 构建后 `setAttribute` 设置。
- **修复**:
  - 每个 `.ms-opt` 在 `switcher.innerHTML` 赋值后经 `setAttribute('title', …)`
    设置独立提示(缺失回退 `META[t].name · META[t].sub`),
    hover 选项时原生悬浮提示显示该主题自己的介绍;
  - 面板底部 `.ms-tip` 增加 hover 联动:`mouseenter` 显示对应主题提示、
    `mouseleave` 恢复当前主题提示(`TIPS[current]`);
  - 切换条整体 `title`(按钮/空白区)仍为当前主题提示,行为不变。
- 触摸点:`themes/runtime.js`(→ `npm run gen-init` 后 `src-tauri/injected/theme-init.js`)。
- 验证点:真实 Chromium(Edge 151 headless)加载构建产物,`#miasaki-switcher`
  构建成功且三选项 `title` 分别为「原版 DSH · 简约纯净」/
  「ふふふ,今晚的时间也属于我呢」/「选好了吗?我讨厌犹豫的人」,
  不再全部是当前主题的介绍;桌面端 EXE 构建部署后同效。

## 2026-08-29 · 修复:桌宠显隐切换条件反转（边缘杂色跳动 + 日志刷屏）

依据:用户现场「桌宠边缘有杂色跳动」。

- **根因**:显示/隐藏切换比较条件写反 —— `want_hide != self.shown` 应为
  `want_hide == self.shown`。初始态(want_hide=false 想显示 / shown=true 已显示)
  语义一致但布尔不等 → 进入分支,每 33ms tick 重复执行 ShowWindow +
  UpdateLayeredWindow(dirty 置位) + pet.json 原子写 → 分层窗口高频重提交,
  合成器边缘出现杂色抖动;pet.log 同步刷屏(每秒 ~30 行「shown (hide persisted)」)。
  切换后的 `self.shown = !want_hide` 幂等(不再变化),故日志只有 show 无 hide,
  无用户操作也持续触发。
- **修复**:条件改为 `want_hide == self.shown`(目标隐藏态==实际显示态才需切换,
  含 (true,true)=想藏但已显、(false,false)=想显但已藏 两种)。
  JS 状态机模拟验证:修复前 10/10 tick 触发,修复后稳定 0 触发;隐藏操作只切 1 次且结果正确。
- 触摸点:`src-tauri/src/pet_native.rs`(compose 命令消费块)。

## 2026-08-29 · 桌面端:桌宠位置屏外修复 + 设置面板(设置 → 桌宠)

依据:用户「桌宠没启动,而且应该在设置里有桌宠设置选项」。

- **「桌宠没启动」根因定位**:桌宠窗口实际随应用正常创建(pet.log
  `window created at 2902,930`),但位置保存在 `pet.json` → 屏幕 2560×1440 下
  (2902,930) 完全位于屏幕外(显示器布局变化/历史遗留坐标),用户看不到。
- **位置可见性校验**(`pet_native.rs`):新增 `EnumDisplayMonitors` +
  `GetMonitorInfoW` FFI 枚举全部显示器工作区;`initial_pet_state()` 要求位置
  中心点落在任一工作区,否则回默认 (1200,500) 并保留隐藏设置,pet.log 记录回退。
- **pet.json 版本化 v1**:`{version:1, x, y, hide}` + 原子写(temp+rename);
  损坏/版本不符 → 全部默认重建(不静默零值,兑现 bootstrap-reliability.md §4.1
  遗留项);`hide` 持久化,重启保持隐藏状态,恢复时圆点可见、可点击显示。
- **显隐/重置命令统一到窗口线程**:右键菜单「隐藏桌宠」与面板命令只写
  `PetShared` 标志,UI 切换 + pet.json 落盘由 compose(窗口线程)消费执行,
  避免多线程 user32 调用;`PetWin` 增加 `shown` 镜像字段。
- **hash 通道扩展**(`main.rs`):`cmd=pet-show/pet-hide/pet-reset/pet-state`;
  新增 `push_pet_state()` 经 eval 下发 `miasaki-pet-state` CustomEvent(状态回显)。
- **新增 DSH bundle `plugins/dsh-pet-panel/`(桌面端设置面板)**:
  settings.section「桌宠」(order 26,client bundle 手写 `__ModuleLoader__` 格式):
  显示/隐藏开关、位置重置、状态回显;非桌面端(无 `window.__MIASAKI_BOOTED__`)
  降级提示。host 侧空壳(职责全在 hash 通道);安装入
  `%USERPROFILE%\.dsh\profiles\web\package.json`(dependencies + bundles)。
- 触摸点:`src-tauri/src/pet_native.rs`、`src-tauri/src/main.rs`、
  `plugins/dsh-pet-panel/`(新增)、`%USERPROFILE%\.dsh\profiles\web\package.json`、
  `README.md`、`design/TODO.md`。
- 验证点:重启桌面端后桌宠出现在默认位置(而非屏外空窗);设置 → 桌宠
  (host 重启后生效):开关隐藏/显示(重启保持)、位置重置回到 (1200,500)、
  右键菜单显隐与面板状态一致;桌宠拖到屏外后重启自动回默认。

## 2026-08-29 · 桌面端:关闭确认弹窗 + 启动画面主题统一

依据:用户「桌面端启动画面需要优化,画面不统一」「关闭桌面端应弹窗提醒是否关闭应用,选择关闭应用
应该同步关闭后端」。

- **关闭确认弹窗(主题自绘,所有关闭入口收敛)**:标题栏 X / 系统关闭(Alt+F4)/ 托盘「退出」/
  桌宠右键「退出应用」统一走 `request_close` → 唤起主窗口并显示确认弹窗(`runtime.js` 注入
  `#miasaki-close-dialog`,色板随三主题 `--ms-*` 变量)。「关闭应用」→ hash `cmd=shutdown`
  → `shutdown_app`:**停止由桌面端拉起的 DSH 后端**(按 spawn 时记录的 PID `taskkill /T /F`
  杀进程树)再退出;「取消」仅收起弹窗。非本应用拉起的后端(用户手动 `dsh web` / 端口已在运行
  时接入)不触碰。兜底:仅 Alt+F4 连击(5s 内二次系统关闭,前端无响应)强制退出(不杀后端,服务保持)。
- **启动画面统一**:
  - `loading.html` 移除自带标题栏(`.tb`),统一由 `runtime.js` 构建 `#miasaki-titlebar`
    (本地唤醒页与 DSH 页同款画面);本地页不再构建切换条/水印/光晕,保持启动画面简洁。
  - 修复 `IS_LOCAL` 判定:Windows 上 Tauri 2 协议为 `http://tauri.localhost`,
    原 `location.protocol === 'tauri:'` 恒 false → 本地页出现重复标题栏 + 切换条
    (这正是「画面不统一」);现以 protocol + hostname + pathname 三重判定,并修正巡检
    在本地页重建切换条的问题。
  - 启动画面随主题换肤:主题偏好由 DSH 页 hash 通道同步 Rust 落盘
    `%APPDATA%\com.miasaki.desktop\prefs.json`(原子写),启动时经 `__MIA_THEME__` 注入
    initial script;`loading.html` 按 `html[data-miasaki-theme]` 渲染三套色板 + 主题纹章
    (刻刻帝钟面 / 狂狂帝破裂表盘 / 原版简约环)。
- **命令收敛**:移除 `exit_app` / `minimize_main`(标题栏按钮改走 hash `cmd=close` / `min`);
  hash `cmd=exit`(直接退出)移除,防绕过确认。
- **素材服务提前**:`start_asset_server` 移至 setup 开头(启动页标题栏图标同源加载,防 404 竞态)。
- 触摸点:`themes/runtime.js`、`ui/loading.html`、`src-tauri/src/main.rs`、
  `src-tauri/src/pet_native.rs`、`src-tauri/injected/theme-init.js`(构建产物)、
  `README.md`、`design/themes.md`。
- 验证点:标题栏 X → 弹窗(随三主题配色)→ 取消仍在运行 / 确认后 DSH 停止 + 应用退出;
  DSH 页切换主题后重启桌面端,启动画面同主题;托盘、桌宠退出弹窗同路径;本地页无切换条。

## 2026-08-24 · 启动可靠性(Bootstrap Reliability)第 1 部分

依据:`design/bootstrap-reliability.md`(设计定稿,借鉴 deepseek-harness-desktop 的
启动恢复/健康标记/可靠性矩阵思路)。

- **bootstrap.json 健康标记(v1)**:`%LOCALAPPDATA%\miasaki\bootstrap.json`,记录每次启动的
  `lastAttempt{at,phase,detail,dshAvailable}` 与 `lastOk`;阶段流水
  bootstrap → spawn(失败,语义化错误) → waiting(3s 低频心跳) → up(3080 页面加载成功);
  90s 未就绪仅提示一次(端口占用排查指引)。损坏/版本不符 → 删除重建默认(不猜不静默)。
- **失败恢复页(loading.html)**:失败时显示恢复动作组——检查 dsh / 打开终端 / 打开日志目录 /
  导出诊断;页面初始化读取上次启动状态,上次失败(spawn/waiting)会提前提示且不阻塞本次启动;
  上次成功显示「已进入」时间。恢复动作仅本地页可 invoke(远程 3080 页受 remote-dsh.json 限制,不暴露)。
- **dsh 安装检测**:spawn 前 `where dsh` 探测 → 未安装时提示安装指引(而非笼统的"启动失败")。
- **重试换代修复(既有 bug)**:原「重试」按钮在 spawn 失败后实际无效(LAUNCHING 已置位且旧循环
  不再 spawn);引入 `BOOTSTRAP_GEN` 代际计数,retry 时换代,旧序列检测到代际变化退出,
  新序列完整重跑(bootstrap/spawn/探活)。
- **导出诊断**:聚合 server.log/pet.log 尾部(各 ≤512KB)+ bootstrap.json + window.json + pet.json
  + OS 信息 → `%APPDATA%\com.miasaki.desktop\diagnostics-<ts>.txt`(只读副本,不触碰原日志)。
- **原子写铁律落地**:bootstrap.json 与 window.json 均改为 temp+rename(原 window.json 直接
  `fs::write`,崩溃/断电可半写)。
- 触摸点:`src-tauri/src/main.rs`、`ui/loading.html`、`design/bootstrap-reliability.md`(新增)、
  `design/TODO.md`、`README.md`。
- 验证:`cargo check --offline` 通过;`gen-init` 令牌校验通过;loading.html 内嵌 JS 语法检查通过。
  真机待验:三条失败用例 + 正常启动回归(见设计文档 §6 验收标准)。

## 2026-08-22 · DSH 插件:免费模型池(Free Model Pool) v0.2 — 多平台扫描 + 能力画像

依据:用户要求「以后可能不仅 OpenRouter,其他平台也会有」+「边界明确:这些模型能干什么、
适合干什么,都要快速分析决策怎么使用」。

- **多平台化**:扫描对象从写死 OpenRouter 改为 `llm-pi-ai.providers` 中**所有带 baseURL 的
  OpenAI 兼容平台路由**;detect/apply/subagent 全部带 `platform` 参数,新平台配置后自动出现,
  零插件改动。status 返回平台列表(displayName/endpoint/apiKeyEnv/configuredCount)。
- **免费判定分层**:`:free` 后缀 → pricing 全零 → 名称含 免费/free;三层任一命中即收录,
  避免单规则漏检(真实 OpenRouter 列表:17 个 `:free` + 零定价预览 2 + `openrouter/free`
  特殊路由 1 = 21)。实测无误报付费模型。
- **能力画像 `analyzeModel`**:从端点自述提取 工具调用/tool_choice/推理/编码/视觉/结构化输出/
  超长上下文/预览标记,产出三档 verdict:
  `首选(复杂|编码|多模态)子代理` / `可用:通用子代理` / `仅问答、批处理(无工具调用)` /
  `需实测验证(有 tools 无 tool_choice)`;warnings 标出 缺 tool_choice/预览模型/输出上限低/上下文小。
  子代理门槛 = tools + tool_choice(DSH agent loop 依赖工具循环)。
- **决策摘要 summary**:bestAgent(评分排序首位)/codingAgent/longContextAgent/visionAgent
  (仅子代理可用者计)/agentCount/qaOnly;面板顶部直接呈现,子代理切换默认推荐最佳。
- 判定原则:画像从端点自述而非 benchmark ELO,无自述者标「元数据缺失」而非猜测。
- **持久化机制修正**:pnpm `file:` 依赖按包版本缓存 store 副本,改源码后 `pnpm install`
  不会刷新(实测 DIFF);需 `--force` 或直接复制 `lib/*` 到 node_modules 并核对哈希;
  本版随功能升 0.2.0 并同步部署副本。
- 验证:离线冒烟(fake hub:三免费标记、付费不误报、canAgent/code/vision/tools-only 四类画像、
  排序与摘要语义)全 PASS;真实 OpenRouter 审计 21 模型 verdict/warnings 全部一致,无误报。
- 触摸点:`plugins/dsh-free-model-pool/lib/index.js`(analyzeModel + 多平台路由)、
  `lib/client.js`(平台选择器 + 画像行 + 摘要块)、`lib/index.d.ts`/`lib/types/detect.d.ts`、
  `package.json`(0.2.0)、`README.md`。

## 2026-08-22 · DSH 插件:免费模型池(Free Model Pool)

依据:用户在 DSH web 会话「配置聚合平台API检测免费模型」需求——从聚合平台(OpenRouter)
检测免费模型并用于子代理,首轮手工落地(settings.yaml 注册 openrouter 路由 + 预设
agentOptions),本轮把该能力固化为可重复使用的 DSH web profile bundle。

- **`plugins/dsh-free-model-pool/`(新增)**:host 插件 + 手写 client bundle 的 DSH bundle 包。
  - 面板:DSH「设置 → 免费模型池」(settings.section, order 25),
    检测结果列表(含 ctx/maxTokens)、写入全部/单个模型、一键切换子代理后端。
  - host 路由(webServer 注册,client 浏览器同源 fetch):
    `GET /freepool-api/status`(读 llm-pi-ai openrouter 配置)、
    `GET /freepool-api/detect`(拉 OpenRouter /v1/models,`:free` 后缀 + pricing 全零判定)、
    `POST /freepool-api/apply`(settings.update 深合并,保留其他 provider/字段,写入 openrouter.models)、
    `POST /freepool-api/subagent`(重写三预设 tool-subagent/tool-subagent-fork 的 agentOptions)。
  - 通信选型:client bundle 无动态 runner 的 `host.call`,故 host 侧走 `webServer.register`
    同源 JSON 路由(与官方 client-connection 的浏览器 fetch 一致);
    host 为普通 ESM(Node 全局 fetch 可用),不受动态插件 fetch 陷阱约束。
  - client bundle 为手写 `window.__ModuleLoader__.load({id, factory})` 格式(本机无 tsdown),
    遵循官方产物同构:`inject` 数组 + `apply` + `module.exports`;
    面板纯 `React.createElement`,无 JSX/import。
- **安装**:`%USERPROFILE%\.dsh\profiles\web\package.json` 以 `file:` 依赖引入并加入
  `dsh.profile.bundles`;pnpm install 后需重启 host 生效;改源码后重跑 pnpm install 同步。
- **验证**:离线冒烟(status/detect/apply/subagent 四路由,真 http 服务 + 假 settings/
  假预设目录副本)全 PASS;detect 命中 17 个 `:free` 模型;apply 保留 xiaomi 等其他 provider;
  subagent 正确更新 kurumi/whale/inverse 三预设。真机验证点:重启后面板渲染、写入后模型选择器出现、
  子代理实际切换模型。
- 触摸点:`plugins/dsh-free-model-pool/*`(新增)、
  `%USERPROFILE%\.dsh\profiles\web\package.json`(bundle 注册)、`README.md`。

## 2026-08-23 · 标题栏 × DSW 布局融合 + 主题装饰

- **标题栏与 DSH 页面融合**：背景/文字改走 DSH 本体令牌（`--dsw-alias-bg-base` / `--dsw-alias-label-*`），
  按钮 28px 圆形 + 圆底 hover，对齐 DSW 原生 UI 手感；新增 `syncTitlebarGeometry()` 模拟
  「侧栏色块向上延伸 + 详情面板分隔线向上延伸」，制造标题栏是页面一部分的错觉；loading.html 同步同款样式。
- **逐条对照 DSH 本体源码验证**（0.1.1-rc.1 前端包）：`--dsw-specific-sidebar-fill` 为 DSH 官方令牌
  （`dsh-client-ui-theme`，明暗双值 = sidebarCol 背景色），三主题经 `--dsw-static-*` 覆盖自动跟随；
  几何探测目标 = `dsh-client-ui-layout` AppFrame 的内联网格
  （`"${cols.sidebar}px minmax(0,1fr) ${cols.details}px"`），首列=侧栏/末列=详情/折叠=0px 全部吻合；
  全 DSH 前端仅此一处内联 `gridTemplateColumns`，首个命中无歧义；
  `::before/::after` 复用的 `--dsw-alias-border-l1/-l2` 与 DSH `sidebarCol`/`detailsCol` 的分隔线令牌同源。
- **P1 修复（1px 对齐）**：`::before` 加 `box-sizing:border-box`——grid item 默认 stretch 下
  border-box 宽 == 轨道宽，DSH 的 `sidebarCol` 分隔线画在轨道右缘**内侧 1px**，而原 `::before`
  为 content-box 时 border 画在轨道右缘外侧 1px → 双线错位 2px；改 border-box 后逐像素重合。
- **探测防御**：`--ms-details-left` 末列仅在网格声明 ≥2 列时取（防未来两列结构把侧栏宽误判为
  详情宽）；轨道 px 声明值优先、实测列宽降级为兜底（二者在 stretch 语义下相等）。
- **契约记档**：对 DSH 内部 DOM 的依赖（AppFrame 内联网格/首末列语义/折叠 0px）为隐性契约，
  上升为 `design/ARCHITECTURE.md` 已知约束（DSH 升级时需复核）。
- **标题栏装饰（用户需求「美化」）**：左端主题徽记（复用主题图标 20px 圆 + `--ms-glow` 主题光晕 +
  3.2s 呼吸，`prefers-reduced-motion` 禁用）+ 主题副标（`Zafkiel · XII` 等）；底部 1px 主题渐变底线
  （`--ms-deco-line` 独立声明 + 逐层回退，装饰失效不拖垮基底）：zafkiel 金→暗红檐线 + 金表圈内高光
  （inset）、kurkuriel 右重血红渐变 + 上下血红内线、pure 跟随 `--ms-border` 弱线保持极简。
  徽记清理链：加载失败字形兜底按 `data-glyph` 定位清除、onerror 用 JS 挂载（切主题后始终引用最新
  `current`）。
- 触摸点：`themes/runtime.js`（CSS + `syncTitlebarGeometry` + buildTitlebar/updateTitlebar）、
  `ui/loading.html`、`themes/{pure,zafkiel,kurkuriel}.css`、`README.md`。
- 验证：`build-init.mjs` 通过（令牌校验 + 53KB theme-init.js 产出，js 语法检查通过）；
  几何同步与装饰待真机验收（三主题切换 + 拖拽详情分隔线 + 侧栏折叠 + 窗口 resize + 徽记呼吸/底线观感）。

## 2026-08-22 · 桌宠 v2 阶段 A：动作丰富化（针对「动作少、僵硬」整改）

- 规划链路：学习 OpenDesign 宠物体系 → `design/pet-v2-roadmap.md`（总览+诊断+决策）→
  `design/pet-v2-phase-a-execution.md`（可开工执行方案）。僵硬诊断七条根因详见 roadmap §3.5。
- **反转狂三立绘清晰化（用户反馈「不像」）**：形象核查（高清源 1728×2368：银发、金钟眼 12:05、
  红瞳尖线、黑金哥特裙、血红内衬——形象本身正确）；根因是素材链退化 + v1 遗留断层：
  `inverse-states.mjs` 输出名为 `blue-*.png` 与 frames.json 引用的 `states/{idle,work,deep}.png` 错位，
  桌宠一直渲染 8/21 产的 128×208 旧图（钟眼糊成色块、形象沦为普通异色瞳少女）。
  修复：输出名统一 `{idle,work,deep}.png` + 输出档位 208 → 540 高（渲染 270 的 2 倍超采样）。
  三态现为 332/313/381 × 540，钟眼可辨认。
- **whale 帧拆分 bug（真机「缩放跳动」修复）**：`sharp(gif, {animated:true, page:p})` 的语义
  是「输出从第 p 页起的堆叠塔」而非单帧——拆出帧尺寸为 192×1248/1040/832/624/416/208，
  渲染按各帧宽高比缩放 → 每帧忽大忽小（真机截图可见「微型三连叠影」）。修复：整动画图
  用 `extract` 逐段切（顶部=帧 0），全部帧固定 192×208。教训：sharp animated 输出为垂直堆叠图，
  `page` 与 `animated` 组合语义反直觉，帧序列务必校验输出尺寸（`ui/pets/whale/states/idle-*.png` 已验）。
- **whale 绿色描边净化（真机反馈「绿边不好看」）**：`idle.gif` 为「透明替代色残留」型 GIF——
  制图用纯绿（0,254,0 / 0,126,0 等）当透明区而未标 alpha，帧边缘呈绿色系实色描边。
  新增 `stripGreenEdge()` 后处理（绿色主导像素 → alpha 0）接入 whale 拆帧链路，
  复检剩余绿色像素 0。素材审计原图/像素抽样两步确认非渲染 halo（半透明像素 0）。
- **专注态语义修正（真机反馈「狂三一直跳动」）**：强度分级实为 DSH 页面模型标签解析
  （`Max→deep / High→work`，runtime.js `CUR_INT`），页面常驻时 intensity 长期非 idle；
  v2 初版把思考中映射到 wait 行 + 4fps 慢放，wait 帧组帧间起伏（眨眼/下沉）被慢放放大 →
  观感「一停一顿的跳动」。修正：思考中=静默守候（idle 姿态，ambient 仅在 idle 强度触发自动安静），
  wait 行专属阶段 B 审批等待。决策 3 修订记录于 `design/pet-v2-roadmap.md` §7。
- 用户机体验反馈触点：真机验收发现跳动 → 截图取证（角色区/背景区对照差分 + 肉眼核查）→
  定位 whale 帧尺寸不一 → 修复后三张抽查帧尺寸一致，动画闭环正常。
- **素材全行切出（A0）**：`cut-frames.mjs` 的 `NEEDED` 4 行 → 全 9 行（idle/runRight/runLeft/wave/jump/failed/wait/run/review），
  kurumi 帧组 21 → 57 帧；wait/review/failed 行此前躺在 spritesheet 中未用（僵硬 #1）。
- **whale 帧序列（A6）**：`idle.gif`（192×1248 六帧条）拆为 `states/idle-00~05.png`；
  `frames.json` 三态值支持「帧组数组 | 单帧字符串」双形态；渲染侧统一为帧组（`Frames.states: HashMap<String, Vec<Image>>`），
  帧组 6fps 循环 + bob，单帧行为与历史一致。
- **修复 wave 不可达（A1）**：双击此前永远 `do_hop+focus_main`（README 声称的「双击=挥手」实为漂移）；
  现按决策改为：主窗最小化/隐藏 → 唤起，否则 → `do_wave()`（wave 行 1300ms）。
- **强度语义修正（A2）**：work/deep 不再原地播 run（僵硬 #3），改 `wait` 行守候（慢放 4fps），
  run 行只归属有位移的 wander——「移动才有跑步」。
- **呼吸与过渡（A3/A4）**：kurumi 基线（idle/wait 且无行动）加 ±2px 3200ms 呼吸 bob；
  跳跃落地加 200ms 末帧定格（`hop_hold_until`），消除硬切。
- **环境编排 + 滑步修正（A5）**：idle 基线低频随机小动作（池 wave/review/wait，jump 15% 偶发；
  表演 1.2~2.2s / 休息 8~18s / 首演 5.5s；指针按下即打断）；wander 滑步修正：位移从「每 tick 3px」
  改为「每帧 9px」（帧同步，90px/s 速度不变）；wander 改为 kurumi 专属（whale/inverse 不再无声滑行）。
- 触摸点：`src-tauri/src/pet_native.rs`（常量表/PetWin 字段/compose 状态机/FFI 交互）、
  `scripts/cut-frames.mjs`、`ui/pets/frames.json`、`ui/pets/kurumi/frames/`（+34 帧）、
  `ui/pets/whale/states/idle-*.png`（+6 帧）。
- 验证：`cargo check --offline` 通过；沙箱内冒烟通过——进程存活、`MiasakiPetWin` 286×390 物理尺寸正确、
  金点窗/托盘/单实例窗齐备；角色区像素活性对照差分成立（角色区 23K~32K px 变化 vs 背景区 0~5.4K，
  9/9 帧对变化，`_refs/scripts-archive/pet-pixdiff*.ps1` 可复用）。用户机验收清单见执行方案 §验证。

## 2026-08-22 · monorepo 重组（仓库结构）

- 仓库重组为三文件夹 monorepo（umbrella `dsh-miasaki` 仍是唯一 git 仓）：本目录 `dsh-miasaki-desktop/`（原 `desktop/` + `design/` 内移）、`dsh-miasaki-fleet/`（编排线）、`dsh-miasaki-shared-docs/`（跨线/DSH 平台参考）。
- `design/` 从仓库根移入本目录内部 → `build-init.mjs` 令牌面路径由 `join(root,'..','design',...)` 改 `join(root,'design',...)`（gen-init 验证通过，令牌校验 + 46KB theme-init.js 产出）。
- `README.md` 设计规范引用 `../design/` → `design/`；`.gitignore` 锚定路径前缀 `desktop/`→`dsh-miasaki-desktop/`。
- 安全网：tag `pre-reorg-2026-08-22` @ `10f8baa`；era tag `0.1.1-rc.1-era` 落在重组+修复后的 `bee066d`。

## 2026-08-22 · m36 冒烟收尾（工程）

- **`verify-themes.mjs` 断言修正**：`kurkuriel: 骨白基底令牌` 原检查 `--dsw-static-neutral-bluish-950 === '#e9e5e1'`，
  但 `kurkuriel.css` 自初版（4f07bd9）起该令牌即声明为 `#0f0d0b`——骨白实际走「DSH 亮色语义」亮端令牌
  （`--dsw-static-neutral-bluish-50=#fcfaf8`）+ `--dsw-alias-bg-base=rgba(247,244,241,.88)`。
  该断言从首次提交即不可满足，因 `verify-themes` 此前从未在真机跑通而潜伏。
  改为：亮端令牌 + alias 基底含 `247, 244, 241`，并新增「深端令牌同步覆盖 = `#0f0d0b`」佐证覆盖链路健康。
  真机首次完整跑通 **18/18**（0.1.1-rc.1 全局 CLI）。属测试断言修复，非主题代码回归。
- **m36 回归冒烟**：详见 `docs/m36-rc8-regression-smoke-2026-08-22.md`——m3-test/rc7-test 混装 profile
  `--dump-config` 双双 exit 0，rc7-test 插件树与 M3.5 基线 313 行字节一致，三主题端到端通过。

## 2026-08-22 · v0.1.4(第七轮)

- **桌宠 Agent 预设(三个)**:standard 底座复制 + 中文 persona。
  人设按桌宠贴合成角色(鲸鱼娘/狂三/反转狂三),调用偏好区分:鲸鱼娘先本地后网页、
  狂三复杂任务先规划后动手、反转狂三默认直接动手改动面大才计划;
  每条 persona 带硬性「入戏边界」——工具调用、错误报告、审批/凭证一律标准语气(中档扮演)。
  三个预设经 `standingKeyFor` 挂载校验通过;RPC 通道经真实创建验证。
- **主题→人格会话联动**:切换主题自动用对应桌宠的 Agent 预设开启新会话
  (官方 RPC `session.create` 的 `agentPreset`;优先挂当前 workspace)。
  每主题仅自动创建一次(localStorage 去重),RPC 失败静默降级不阻断切换。
- **三桌宠灵魂文件(pet.json)补全**:whale/kurumi/inverse 三份中文人设
  (inverse 新增 manifest + spritesheet.png/webp 图集,由 `scripts/make-inverse-sheet.mjs` 生成)。

## 2026-08-21 · v0.1.3(第六轮)

- **闪退根治(关键)**:GDI 高频创建改为**持久 DC/DIB 表面**(创建一次终身复用);
  气泡文本渲染从 33ms 心跳降到帧更新时;BmiHeader `biSize` 44 → 40 标准值。
  此前 gdi32full+0x2ae13 固定偏移崩溃连续出现 5 次(22:16/22:25/22:47/23:16…)。
- **主窗口位置/大小持久化**:关闭时保存 `%APPDATA%\com.miasaki.desktop\window.json`(物理坐标),启动时恢复(负坐标/过小尺寸防御)。
- **托盘菜单**:显示/隐藏主窗口、退出(`tray-icon` feature;左键点击不弹菜单)。
- **冒烟测试脚本**:`desktop/scripts/smoke-test.ps1`(交付物完整性 / 进程存活 / 桌宠窗口 / 素材加载 tick0)。

## 2026-08-21 · v0.1.2(第五轮)

- **GDI 句柄泄漏修复**:`present()`/`draw_text()`/`draw_dot()` 的 `SelectObject` 后未恢复原对象即 `DeleteObject`,
  33ms 高频下句柄耗尽 → gdi32full 崩溃;全部改为先恢复再删除,DC/DIB 创建失败提前返回。
- **防复发**:compose 加脏标记,静止时 `present` 频率 33ms → ≥125ms。
- **桌宠放大**:窗口 220×300 → 286×390,角色 208 → 270 高;气泡 170×36 → 210×48;金点 26 → 30;散步 2 → 3px。
- **拖窗跟手**:JS 发「按下起点累计物理增量(×DPR)」+ Rust 差值应用 + `move=reset` + 轮询 100ms → 33ms + pointercancel。

## 2026-08-21 · v0.1.1(第四轮)

- **桌宠动画循环真相**:`WM_CREATE` 期间 `GWLP_USERDATA` 未设置 → `wnd_proc` 的 `SetTimer` 从未执行
  → 桌宠自 v0.1 起只画一帧、永不刷新;修复:USERDATA 就位后显式 `SetTimer`。
- 二次根因:`compose` 每 33ms 清空 buf 但帧更新间隔 ≥125ms → 空帧闪烁;修复:清空移入帧更新分支。
- 明暗锁定修复:pure/system 切换时移除残留 `data-ds-dark-theme`(切回原版不再残留暗色)。
- 标题栏 36→32px 低调化、去阴影;切换条 hover 展开 + 300ms 延迟关闭 + 面板 hover 保活。
- `set_mode`/`set_intensity` 日志埋点。

## 2026-08-21 · v0.1.0 增补(第三轮)

- **apply() 核心同步优先**:syncHash/refreshSwitcher/updateTitlebar 提到装饰层之前并 try-catch,
  消除"装饰层异常 → 图标不换+桌宠不切换"连锁失败;自愈巡检 5s → 1s。
- 切换条交互重做(见上);标题栏按钮 `--ms-danger` 主题化。
- **软件图标重设计**:百炼生成「暗夜紫 + 鎏金时钟 10:10 + 绯红蔷薇」艺术图(icon-new.png),
  `npx tauri icon` 重生成全套;make-icons.mjs 换源并修复 inverse 徽章引用。
- set_mode 日志埋点;启动器 `--no-open`(rc.8 双窗口问题)。

## 2026-08-21 · 第二轮

- 桌宠待机随机行为(18-42s 气泡 / 22-50s 散步 + 贴边吸附)。
- **反转狂三全新立绘**:qwen-image-3.0 生成 3 态 + 深蓝背景 flood-fill 抠图(`scripts/inverse-states.mjs`);
  inverse 从「kurumi 重着色 atlas」改为立绘三态。
- 滚动锁死(`html,body overflow:hidden` + `#root calc(100% - 32px)`);aurora 光晕层 + 面板半透明化;水印增强。
- 清理:pet_native.rs 死代码、50+ 诊断截图、测试 profile、旧状态帧/inverse 图集。
- `inputModalities` 修复使 read_image 可用;百炼 skills 刷新 1.17.0。

## 2026-08-21 · 第一轮(rc.8 适配)

- 启动器加 `--no-open`(rc.8 起 `dsh web` 自动开浏览器 → 双窗口)。
- runtime.js 内页宠物死代码清理(-426 行,注入包 56KB → 38KB);删除 ui/pet.html/css/js。
- rc.8 令牌面核对:`--dsw-static-*` 73 个与 token-surface.txt 一致;`--json-tree-*` 等 8 个失效(死覆盖,无害)。

## 2026-08-17 · v0.1.0 初始

- Tauri 2 薄壳 + 三主题(纯色/刻刻帝/狂狂帝)+ 原生 Win32 分层窗桌宠(鲸鱼娘/狂三/反转狂三)。
- 用户验收通过("好了")。

## 2026-09-24 · 拖拽上传附件到会话 S1–S3 落地（design/drag-drop-attachment-upload.md 实施）

**起因**：用户点名「桌面端现在缺少拖拽上传附件到会话」。核查结论（设计 2026-09-22 定稿）：
不是缺功能，是壳把官能入口关在门外——tauri-runtime-wry 默认 drag-drop handler 在
WebView2 上 `SetAllowExternalDrop(false)` + `RegisterDragDrop`，页面级 HTML5 拖放被
整体拦成无人监听的 `tauri://drag-drop`（本壳零监听）→ drop 静默丢失。

**实施**（壳侧零业务逻辑，官方链路全量复用）：

- **S1** `main.rs` 主窗 builder 追加 `.disable_drag_drop_handler()`——wry 不再注册
  `IDropTarget`、不再关 `AllowExternalDrop` → WebView2 原生拖放直达页面。`cargo check
  --bin miasaki` 通过（与并行会话同文件的在途工作未冲突，其探针已还原）。
- **S2** 注入层安全网 `themes/src/09-dropguard.js`（自包含 IIFE，拼在 08-ready.js
  闭合大 IIFE 之后）+ MANIFEST.order 登记 + `npm run gen-init`（10 片、87KB、令牌
  校验过）。三判据：dragover 一律阻止（否则 drop 不触发）/ drop 只认 Files（文本链接
  不干预，与官方同判据）/ `defaultPrevented` 放行（官方已消费的精准让位）。
- **S3** `ui/loading.html` 独立第二道最小防默认（注入层本就走 initialization_script
  覆盖启动页，S3 让本地页不依赖注入链；两处判据逐条一致）。

**回归**：新增 `themes/test/dropguard.test.js` 4 例（order 登记 / 生成产物含片 /
三判据 / 自包含无常驻状态）；`ui/test/loading-visual.test.js` 10 → 11 例（S3 行为：
文件拖放阻止 / 官方已消费放行 / 文本链接不碰 / dragover 阻止）；`node scripts/verify-all.mjs`
**99/99**（desktop 23/23，含 cargo 35 例）。**实机验收十项待用户重启桌面壳**
（§3.1 新行：对话页拖图全链路 / 生成中拒绝态 / 轨迹设置页不炸 SPA / loading 无导航 /
超大图官方 toast / 窗口手势与桌宠回归）。

## 2026-09-24 · 启动加载 S4a-2 启动计时（诚实的「已等待」读数）

**起因**：S4a 视觉层落地后复查启动体验——Rust 阶段词汇齐（正在唤醒/正在拉起/仍在等待/已就绪），
但冷启动 3~6s、重拉等待最坏 90s 期间页面只有一行静止文案，用户对「卡了还是在走」没有判断依据。

**实施**（`ui/loading.html`，纯页面侧零 Rust 依赖）：`#boot-timer` 读数——250ms tick、
`tabular-nums` 等宽防跳动、小于 10s 给一位小数；**就绪即停并隐藏**（马上退场）；
失败路径继续走表（超时文案旁挂着的耗时就是排查线索）。**纪律**：只读 elapsed，
不出假百分比（§4.1「不假装」同款）；纯文本读数无动效，reduced-motion 零影响。
不抢占 S4b（日志流 / 阶段进度仍随 S3 stdout tee 钩子落地）。

**回归**：`ui/test/loading-visual.test.js` 8 → 10 例（计时即时读数 / 250ms 推进 /
就绪停表且读数冻结 / 无百分比形态 / 无动画）；VM 上下文注入 `setInterval/clearInterval`
（vm 不继承 Node 全局，缺了整段页面脚本会求值崩）。`verify-all` desktop 22/22 不变
（同一测试文件扩例，不增检查位）。

## 2026-09-24 · 启动加载 S4a 视觉层（boot-loading-terminal §4.2 无 Rust 依赖部分）

**起因**：用户点名启动加载界面「太简单不符合本项目……加载页弄酷炫一点」。设计 2026-09-22
已定稿（`design/boot-loading-terminal.md`），其 S4 页面半依赖 S3 的 stdout tee 钩子
（`__appendLog` / `__setPhase`，Rust 半未做）；本轮先落地**不需要数据钩子**的视觉层，
日志流与四阶段进度（S4b）留待 S3 同批接。

**实施**（全部在 `ui/loading.html`，纯 CSS transform/opacity、零 JS 动画循环、零新增色）：

- 纹章外环缓旋 24s + 呼吸光晕 3s（三枚主题纹章 SVG 各加 `mia-boot-halo` 圆——
  `fill: var(--mia-accent)` 跟主题换色，blur 静态施加、动画只碰 opacity/scale；
  外环组装进 `<g class="mia-boot-ring">`，`transform-box: fill-box` 绕自身中心）；
- 舞台扫描线：88px 窄带 4s 自上而下，opacity .06（design 上限），pointer-events:none；
- 就绪纹章回弹 1.06/600ms：`__setStatus` 按就绪文案派生触发（Rust 侧 `__setPhase('ready')`
  落地后改显式钩子，`__setReady` 已预留且幂等）；
- `prefers-reduced-motion: reduce` 全量静止（设计 §6-6 降级项）。

**回归**：新增 `ui/test/loading-visual.test.js`（8 例 ESM，`ui/test/package.json` 指定模块类型）——
动画属性白名单（只准 transform/opacity）/ 扫描线上限 / 零字面量新色 / reduced-motion 全覆盖 /
`.mia-boot-*` 类名纪律 / 标记结构（三 halo + 三旋转组 + SVG 组配平）/ VM 驱动就绪触发与幂等；
接入 `verify-all` desktop 线（20 → 21 项）。`node scripts/verify-all.mjs desktop` 21/21 PASS
（含并行会话 dot.rs 重构后的 cargo 35 例）。

**待实机验收**：冷启动三主题目检（亮主题 kurkuriel 扫描线对比度重点）/ 就绪回弹 /
减少动画效果降级 / 失败路径零回归。S1–S3（闪窗根治 + stdout tee）未动，见 TODO 同项拆分。

## 2026-09-25 · 启动失败可见化（「桌宠出来了、主界面一直不出来」根治性定位）

**起因**：用户报「桌面端还是打不开」——现象是**桌宠正常出现、主界面窗口永不出现**，且全程无任何提示。

**定位过程（现场实测，非推断）**：

1. **主窗确实被创建过，但句柄随即消失**。在 `setup` 逐点埋桩得到：
   `setup: main window built` → `hwnd 获取失败: the underlying handle is not available`
   —— `WebviewWindowBuilder::build()` **返回 Ok 且不 panic**，但窗口 HWND 已被回收，
   于是主窗不显示、`on_page_load` 的 `show()` 与 800ms 兜底 `show()` 全部静默失败。
   桌宠是原生 Win32 分层窗（纯 GDI、不依赖 WebView2）→ 照常显示，形成「只剩桌宠」的现象。
2. **上游诱因：进程写不了用户数据目录**。同一进程里埋点能写工作区文件，
   但写 `%LOCALAPPDATA%\miasaki\*` 与 `%LOCALAPPDATA%\com.miasaki.desktop\EBWebView\*`
   一律 `os error 5（拒绝访问）` → WebView2 环境创建失败 → 主窗报废。
3. **决定性判据：进程完整性级别**（`TokenIntegrityLevel`，同一二进制换位置对比）：

   | 位置 | 完整性 | 结果 |
   |---|---|---|
   | `…\dsh-miasaki-desktop\dist\Miasaki.exe`（用户目录） | `0x1000` = **Low** | 写不了 `%LOCALAPPDATA%` → 主窗不出 |
   | `C:\ProgramData\MiasakiApp\Miasaki.exe` | `0x2000` = Medium | **正常打开（`bootstrap.phase=up`）** |
   | `C:\MiasakiApp\Miasaki.exe` | `0x2000` = Medium | 同上 |

   同一份 `node.exe` 复制进用户目录也变 Low、放回 `C:\Program Files` 即 Medium
   —— 证明**降权由路径（用户可写目录）触发，与文件名、签名、二进制内容都无关**。
   本机 `HKCU\…\AppCompatFlags\Layers` 与 IFEO 均无 miasaki 条目、`__COMPAT_LAYER` 为空，
   排除兼容性层；低完整性进程无权写 Medium 完整性的用户目录，这就是「打不开」的机理。

**实施（`src-tauri/src/main.rs`，只增不改语义）**：

- 新增 `show_native_error()` —— 用 `MessageBoxW` 弹原生框，**刻意不依赖 WebView2**
  （调用场景正是 WebView2 起不来，用页面弹提示等于让哑巴喊话）；
- 兜底 `show()` 之后再复查一次（2.6s）：窗口仍不可见即判定 WebView2 初始化失败 →
  写 `pet.log` + 弹原生框，给出「加白名单 / 结束残留进程 / 日志路径」三条排查指引。
  **正常路径不受影响**（窗口已可见 → 直接 return，幂等）。

**规避与交付**：可用版本已部署到 `C:\ProgramData\MiasakiApp\Miasaki.exe`（系统目录，逃脱降权），
桌面生成 `Miasaki 桌面端.lnk` 指向它；原 `Miasaki-dsh.lnk` 仍指向用户目录下的
`dist\Miasaki.exe`，**本机上该位置必然被降权，不要再作入口**。

**回归**：`cargo check --release` 通过；实机以系统目录版本启动 → 主窗
`class='Tauri Window' title='Miasaki · DSH'` 可见 + `bootstrap.json` 写入 `phase=up`。
**注**：本机 `cargo build --release` 偶发 rustc `0xc0000409 / 0xc0000005`（重跑即过，
与本次代码无关，疑似环境侧干扰），遇到时重跑即可。

## 2026-09-25 · 启动失败复发的防呆加固（构建产物 → 系统目录一键同步）

**起因**：21:22 用户再报同一个弹窗。现场取证确认是**当日已定位问题的复发**，不是新故障：

| 证据 | 观察 |
|---|---|
| 启动路径 | `…\dsh-miasaki-desktop\dist\Miasaki.exe`（用户可写目录 → 本机必降权） |
| `pet.log` | 停在 20:20:40，21:22 之后**一行未增**（低权写不进 `%LOCALAPPDATA%\miasaki`） |
| `EBWebView` | 20:20:41 之后零文件变更；21:22 实例未拉起任何新的 `msedgewebview2` |
| 窗口枚举 | 该进程只有 `MiasakiPetWin` / `MiasakiPetDot` / 托盘窗口，**无** `Tauri Window` |
| 对照 | dist 与 `C:\ProgramData\MiasakiApp\Miasaki.exe` **SHA256 相同**（`DDA711…57CD`），差别只在目录 |

顺带排除两个误判方向：18:47/19:02 启动的 3 个孤儿 `msedgewebview2`（20:05 那次成功运行时它们已在跑，
且本轮未触碰 `EBWebView`）与 C 盘剩余 5.5 GB，均非诱因。

**根因（工程侧而非代码侧）**：`Miasaki-dsh.lnk`（2026-09-06 建立）仍指向 `dist\Miasaki.exe`，
而构建产物没有任何落地环节——「构建完顺手双击 dist」必然踩降权陷阱，这就是复发路径。

**实施**：

- **新增 `scripts/deploy-local.ps1`**：把 `dist\{Miasaki.exe, ui\}` 同步到系统目录
  （默认 `C:\ProgramData\MiasakiApp`；`ui` 走 `robocopy /MIR` 防旧帧残留），带 exe 占用检测
  （`-Force` 自动结束运行中实例）、SHA256 一致性校验、`-FixShortcuts` 修正桌面仍指向用户目录的
  旧快捷方式；`package.json` 增 `npm run deploy`。
- **弹窗文案分流**（`main.rs`「启动失败可见化」段，仅改失败分支文案）：按启动位置判断，exe 在
  `%USERPROFILE%` 之下时直接点名「改用 `C:\ProgramData\MiasakiApp\Miasaki.exe`」并说明
  「加白名单 / 换文件名 / 换副本皆无效」；非用户目录时保留原安全软件排查方向。文案新增
  **启动位置**一栏与「被降权时日志写不进去」的说明。
- **README §启动失败排查**增「构建后必做」小节。

**自检（临时目标目录，不碰在用实例）**：以 `-Target $env:TEMP\…` 跑完整流程 8 项 PASS、退出码 0；
重复跑第二遍（robocopy 无变化）仍 `8 通过 / 0 失败`、退出码 0；目标不可写时给出
`FAIL 目标目录可写` + `abort`、退出码 1。自检暴露并修掉两处问题：
① robocopy 退出码 1（=有文件被复制，属成功语义）会**泄漏成脚本退出码**，使成功部署返回 1 —— 已显式
归零并在成功末尾 `exit 0`；② 占用判据从「有 Miasaki 在跑」收紧为「**跑的就是目标 exe**」，
避免跑在别处的实例无谓挡住部署。

