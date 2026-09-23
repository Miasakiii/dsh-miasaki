# 启动加载 2.0 · 内嵌启动终端 与 cmd 闪窗根治 设计

> 状态：**设计定稿（2026-09-22），待用户拍板实施**。用户原点名需求：「现在的启动加载界面太简单
> 不符合本项目」「每次启动都会闪过终端窗口」「加载页直接把这个启动终端代码内置，弄酷炫一点」。
> 本文件是 desktop 线半（loading 页 + dsh 拉起 + 闪窗）；appearance 线半（DSH 首帧启动画）见
> `../dsh-miasaki-appearance/design/2026-09-22-appearance-boot-splash-design.md`；两线契约见
> `../dsh-miasaki-shared-docs/cross/boot-loading-2026-09-22.md`。
> 既有启动可靠性设计见 [`bootstrap-reliability.md`](bootstrap-reliability.md)（本项目不改其结论，只在其上叠加）。

## 1. 目标

1. **根治启动闪窗**：消除 `cmd /C dsh web --no-open` 链路上的终端窗口一闪（根因未实机坐实，
   先归因再修，见 §3）；
2. **启动过程内置展示**：dsh 后端的 stdout 实时进 loading 页（终端风格日志流 + 阶段进度），
   不再只写 `server.log` 靠用户事后翻——启动过程即展示，失败时日志流即诊断现场；
3. **视觉升级**：延续三主题纹章 DNA（刻刻帝 / 狂狂帝 / pure）与 Mica 材质，加入克制动效
   （脉冲 / 扫描线 / 打字机光标），`prefers-reduced-motion` 全量降级；
4. **零回归**：bootstrap-reliability 的失败卡片、诊断按钮、bootstrap.json 落盘链路不变；
   `__setStatus` / `__setRetry` 契约只增不改。

## 2. 现状链路（事实核对过，2026-09-22）

```
Miasaki.exe（Tauri，GUI 子系统，无控制台）
 ├─ WebviewWindowBuilder::new("main", WebviewUrl::App("loading.html"))
 │    · visible(false) → on_page_load 才 show（防白闪）
 │    · initialization_script = runtime.js（#miasaki-titlebar + data-miasaki-theme）
 │    · Mica（Win11）或实色主题底（MIASAKI_NO_MICA / Win10）
 ├─ start_launch_sequence()（main.rs:347）
 │    ├─ port_ready()：127.0.0.1:3080 连接探测，300ms 超时
 │    ├─ 未就绪 → spawn_dsh()（main.rs:306）：
 │    │    cmd /C dsh web --no-open
 │    │    · creation_flags(0x0800_0000) = CREATE_NO_WINDOW
 │    │    · stdin null；**stdout/stderr 直接重定向到 server.log 文件句柄**
 │    │    · PID 记 DSH_PID（taskkill /T 仅杀本应用拉起的后端）
 │    ├─ 400ms 轮询 port_ready；90s 未就绪 → 超时提示（端口占用排查）
 │    └─ 就绪 → navigate http://127.0.0.1:3080 → DSH 页接管
 │         on_page_load 匹配 3080 → record_bootstrap_up() + eval INIT_SCRIPT
 └─ ui/loading.html（本地页）
      · 三主题纹章 SVG + "MIASAKI" wordmark + #status 单行状态 + #retry/#diag 按钮组
      · __setStatus / __setRetry 由 Rust eval_status 驱动
      · invoke('bootstrap_state') 读上次启动结果，异常时提前出卡片
```

dsh 命令解析（本机实测 2026-09-22，`Get-Command dsh` → `%APPDATA%\npm\dsh.ps1`，cmd 侧为
`%APPDATA%\npm\dsh.cmd`）：**npm 标准 cmd shim**，核心一行
`"%_prog%" "%dp0%\node_modules\@deepseek-ai\dsh\lib\bin.js" %*` ⇒ 实际是
`node …\@deepseek-ai\dsh\lib\bin.js web --no-open`。

## 3. 闪窗归因与根治

### 3.1 归因矩阵（每条配验证法，**未坐实不动手**）

| # | 嫌疑 | 机理 | 与现有代码的关系 | 验证法 |
|---|---|---|---|---|
| S1 | `cmd.exe` 自身分配控制台 | GUI 进程 spawn 控制台子系统程序时系统创建 conhost，闪一下 | spawn_dsh 已带 `0x08000000`，**理论已治**；但 `dsh.cmd` 内含 npm shim 回退行 `title %COMSPEC%`，值得复核 | Process Monitor 启动时过滤 `Process Create` + `Thread Create`，看 conhost.exe / cmd.exe 创建链与时间戳 |
| S2 | `dsh.cmd` 批处理解释链 | cmd /C → 批处理 → node，两层进程 | 同 S1，CREATE_NO_WINDOW 应覆盖 cmd.exe 本身 | 同上：抓 cmd.exe 的 `CreationFlags` 需要用 ETW（procmon 不显示 flags），或 A/B：直接换 F1 修法闪窗即消失 |
| S3 | **dsh 本体孙进程**（最可能） | `bin.js` 后 web server 启动链内部 spawn 子进程（pty / worker / sidecar），孙进程**不继承** CREATE_NO_WINDOW | 本仓 sidebar 线自持 node-pty（路线 B）即证明 dsh 生态存在 spawn | 同 S1 procmon 抓本应用之外的 node.exe / conhost 创建事件，看其创建者与耗时 |
| S4 | 视觉误判 | WebView2 GPU 子进程创建时机与启动重合，形似闪窗 | — | 复现时同步抓 GPU 进程创建事件对时间戳 |

**归因判据（收口条件）**：抓到「谁创建了可见 conhost」即坐实；抓不到则按 S2/S3 合并处理——
直接上 F1 修法（绕开 cmd 直达 node），闪窗消失即反证归因。

### 3.2 根治修法（按优先级）

- **F1（首选，与 §3.1 归因并行可先落）绕开 cmd，直达 node 入口**：
  1. `where dsh` 拿 shim 路径（现有 `cmd_capture(&["/C","where","dsh"])` 取第一行；
     注意 `where` 在 cmd 环境可能同时列出 `.cmd`/`.ps1`，**只认第一个 `.cmd`**）；
  2. 读 shim 文本，正则提取入口：`/"%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin\.js"/`
     —— npm shim 形态稳定（本机实测如上）；提取失败 → 回落 F3；
  3. spawn `node <bin.js 绝对路径> web --no-open`，`creation_flags(0x0800_0000)`，
     `windowsHide` 语义不变；node.exe 解析顺序：shim 同目录 `node.exe` → PATH `node`；
  4. `--no-open` 等参数表硬编码保持现状（rc.8 起自动开浏览器与 WebView2 重复）。
  - 收益：消除 S1/S2 两层的 cmd.exe 与批处理链；对 S3 无效但无副作用。
- **F2（仅坐实 S3 后评估）孙进程闪窗**：治本只有改 dsh 本体 spawn 链——需走
  `patches/` 补丁链并**单独拍板**（desktop 线对 DSH 本体的改动先例已在纪律内）；备选是接受
  一次性一闪（S3 若只是启动早期一瞬，感知弱于 S1/S2）。**归因结论出来前不预支工作量**。
- **F3（兜底链，永不删）解析失败回落**：F1 任一步失败（where 无果 / shim 变形 / node 缺失）
  → 回退现行 `cmd /C dsh web --no-open`，行为与今天完全一致，bootstrap.json 的
  `dshAvailable` 记录不受影响。

### 3.3 防漂移

- dsh 升级后 shim 形态若变（npm 换 shim 生成器），F1 解析失败即静默回落 F3——**不报错、不回归**；
- `verify-all.mjs appearance` / desktop 静态回归不覆盖 spawn 链，闪窗验收为**实机项**（§6）；
- 修法只碰 `spawn_dsh()` 一个函数，`kill_spawned_dsh()` / `dsh_available()` / 端口探活 / 导航
  全链路不改。

## 4. Loading 2.0 设计

### 4.1 「启动终端代码内置」：内嵌启动日志流

**核心改造 = stdout 从「文件重定向」改为「tee」**（现状见 §2：`Stdio::from(log)`）：

```
dsh 子进程 stdout（Stdio::piped）
  → tokio BufReader::lines() 逐行读
      ├─ append 到 server.log（既有落盘语义不变，导出诊断链路不变）
      └─ eval_status(app, "window.__appendLog(<行JSON>)") → 页面日志流
```

Rust 侧要点：

- 读行循环放 `start_launch_sequence` 已有的 async_runtime 里（spawn 一个 log pump task，
  子进程退出时 `lines()` 自然结束）；写文件保留 `OpenOptions::append` 与现有错误处理；
- **回压**：eval 每条日志即一次 IPC；高峰期按 50ms 合批（行缓冲 + 定时 flush），
  防 IPC 洪水把 WebView2 主线程打满；
- 行内容经 `serde_json::to_string` 转义后 eval，**禁字符串拼接进 JS**（防日志内容注入脚本，
  如日志里出现 `</script>` 或引号）；
- **隐私边界**：server.log 现状已是本机文件、`export_diagnostics` 已含其尾部；推到页面只是
  同一份数据的另一视图，不新增落地、不外传。

页面侧（loading.html）契约：

| 钩子 | 方向 | 语义 |
|---|---|---|
| `window.__appendLog(line)` | Rust → 页 | 追加一行日志（纯文本，自动滚动） |
| `window.__setPhase(name)` | Rust → 页（**新增**） | 阶段切换：`probe` / `spawn` / `wait` / `ready`，驱动进度点 |
| `__setStatus` / `__setRetry` | Rust → 页 | **既有契约不变**（§4.3） |

日志流 UI 规范：

- `#log-stream` 固定于舞台下方，终端风：等宽栈（Cascadia Mono / Consolas）、
  12px、行前缀 `HH:MM:SS`（页面本地时钟，Rust 侧不额外打戳）、行距 1.5；
- **环形缓冲**：DOM 最多保留 500 行，超出从头部移除（防长会话内存膨胀）；
- 着色只做三级：`ERROR`/`失败` 系词 → `--mia-danger`；`WARN` → `--mia-accent`；
  其余 → `--mia-muted`；**不做语法高亮**（克制 + 零第三方依赖纪律）；
- 自动滚动仅在用户未手动上翻时（`scrollTop` 判定，手动上翻则停 3s 再恢复）；
- 日志流默认**折叠为一行计数徽标**（`▸ 启动日志 12 行 ▾`），点击展开——默认界面保持
  「酷炫而非杂乱」，完整日志一臂距离；失败时自动展开（`__setRetry(true)` 联动）。

阶段进度（`__phase` 点亮序）：`probe`（探活）→ `spawn`（拉起）→ `wait`（等待就绪）→
`ready`（进入）。四节点 + 连接线，当前节点脉冲动画；就绪时整条线一次性金色贯穿（600ms）后
随页面退场。

### 4.2 视觉规范（延续 DNA，克制加法）

保留（现状不动）：三主题纹章 SVG（cr-zafkiel / cr-kurkuriel / cr-pure）、wordmark、
Mica / 实色底策略、`data-miasaki-theme` 驱动、runtime.js 标题栏。

新增（全部自有 `--mia-*` 变量 + `.mia-boot-*` 类，禁哈希类名，禁第三方依赖）：

| 元素 | 动效 | reduced-motion 降级 |
|---|---|---|
| 纹章 | 外环缓慢旋转（24s/圈）+ 呼吸光晕（3s） | 静止 |
| 舞台底 | 扫描线（自上而下 4s 循环，opacity ≤ .06） | 移除 |
| 进度节点 | 当前节点 1.2s 脉冲 | 静态点亮 |
| 日志流 | 末尾打字机光标（1s 闪烁）；新行 120ms fade-in | 去光标与 fade |
| 就绪 | 整线金色贯穿 600ms + 纹章缩放 1.06 回弹 | 直接切走（无过渡） |

主题：四套已有变量（pure / zafkiel 默认 / kurkuriel）零新增色；亮主题（kurkuriel）扫描线
对比度需目检（`color-scheme: light` 已有先例处理）。

### 4.3 与 bootstrap-reliability 的关系

- **不重复建设**：失败卡片 / diag 按钮组（检查 dsh / 打开终端 / 打开日志目录 / 导出诊断）/
  bootstrap.json 落盘 / 90s 超时提示 / retry_start 全部保留原样；
- 日志流是失败现场的**新增入口**（自动展开 + 首行 ERROR 定位），与「打开日志目录」并存——
  前者看现场，后者给文件；
- 状态文本（`#status`）从唯一信息位降级为阶段摘要（如「正在拉起 DSH 服务…」），
  细节由日志流承担；
- §4.1 的 P1「401 恢复指引分支」待办与本设计无冲突：401 场景 loading 页同样走到日志流，
  dsh web 打印的认证 URL 会出现在日志里（现状只在 server.log），指引文案可复用该行。

### 4.4 性能预算

- 纯 CSS 动画（transform / opacity only），零 JS 动画循环，零 rAF 常驻；
- 日志 DOM 更新：每行一个 textNode 插入（不用 innerHTML），合批 ≤ 50ms；
- 纹章 SVG 动效用 CSS `animation` 挂在既有 SVG 组上，零新增资产；
- 目标：日志流满速（~20 行/s）下 loading 页主线程占用不可感知（验收项 §6-5）。

## 5. 实施顺序

| 步 | 内容 | 依赖 | 产出 |
|---|---|---|---|
| S1 | 闪窗归因（§3.1 矩阵逐条跑，procmon 抓创建链） | 无 | 归因结论（哪条嫌疑坐实） |
| S2 | F1 修法落 `spawn_dsh()`（绕开 cmd 直达 node）+ F3 兜底 | S1 | 闪窗根治（S1/S2 层） |
| S3 | stdout tee 管道（piped + 行泵 + 合批 + JSON 转义） | S2 的函数改造 | Rust 半 |
| S4 | loading.html 2.0（日志流 / 阶段进度 / 动效 / reduced-motion） | S3 钩子 | 页面半 |
| S5 | 实机验收（§6） | S2–S4 | 验收记录 |

S1 若坐实 S3（孙进程）：S2 照常做（消除 cmd 层无害），F2 单独列小项再拍板，**不阻塞 S3–S5**。

## 6. 验收标准

1. **闪窗**：正常冷启动（先杀 dsh web 进程）连续 5 次，无任何终端窗口闪现（S1/S2 层根治；
   S3 若残余单列记录）；
2. **日志流**：冷启动 loading 页可见 dsh 启动日志逐行滚动、阶段依次点亮；就绪后整线贯穿；
3. **失败路径零回归**：dsh 从 PATH 摘除 → 「未检测到 dsh」卡片 + 诊断按钮组与现状一致；
   端口占用 → 90s 超时提示出现；日志流在失败时自动展开；
4. **回退链**：把 shim 入口正则临时改错（或模拟 where 失败）→ 启动行为与今天一致
   （cmd /C 兜底），不报错不进不了页面；
5. **性能**：日志高频输出时 loading 页交互（点击展开、按钮）无卡顿；
6. **降级**：系统开「减少动画效果」→ 全部动效静止、功能不变；
7. **既有回归**：smoke-test.ps1 §0b 三用例通过；正常启动路径功能不变。

## 7. 风险与边界

- **dsh 不在 PATH / 非 npm 安装**：F1 解析失败即回落 F3（§3.2-F3），优先级最高的防回归设计；
- **shim 变形**（npm 升级换代）：同上回落；`dsh_check` 已有版本探测可顺带提示；
- **日志洪水**（某场景 dsh 逐字节刷屏）：合批 + 环形缓冲 + 环形外丢弃，DOM 永远是常数级；
  落盘文件语义不变（append 原样写）；
- **隐私**：日志可能含 URL/token 形态字符串——但仅本机页面展示，与 server.log 同域，
  不外传不新增落盘（`export_diagnostics` 已有行为不变）；
- **Windows-only**：`creation_flags` 与 shim 解析均 `#[cfg(target_os = "windows")]`，
  非 Windows 路径保持现有「仅支持 Windows」行为；
- **不做**：JS 直接 spawn dshWeb（loading 页是本地 App 页但 spawn 永远走 Rust，
  invoke 边界不动）；日志语法高亮；日志持久化到 bootstrap.json。

## 8. 跨线衔接

与 appearance 线 Boot Splash 的接力约定（loading 退场 ↔ splash 淡入的时间与信号）见
`../dsh-miasaki-shared-docs/cross/boot-loading-2026-09-22.md`；本线默认策略：各自干净退场，
不做跨页动画接力（除非 cross 契约评审后追加）。
