# Miasaki Desktop — 待办列表

> 优先级自上而下。完成项进入 `CHANGELOG.md`。

## P0 · 稳定性阻断

- [x] **后端断连自愈（运行期存活看门狗 + 关闭误伤防护）** — 2026-09-23 用户拍板实施
  （2026-09-08 列为待拍板项）：2s 看门狗探测自拉后端进程 + 3080，意外死亡自动重拉
  （退避 2s→30s），错误页补重新导航，活页面靠 DSH 前端自带重连静默恢复；关闭前探测
  外部客户端（netstat 对端端口 + Toolhelp32 进程树），浏览器仍连着则保留后端不杀。
  详见 CHANGELOG 2026-09-23。待用户实机验收（杀后端自愈 / 带浏览器关闭保留 / release 部署）
- [x] **闪退 ** — GDI 泄漏/高频创建 → 持久表面 + 脏标记(2026-08-21 第六轮)
- [x] **启动链路异常兜底** — bootstrap.json 健康标记 + 失败恢复页(2026-08-24,见
  `design/bootstrap-reliability.md`);GDI 侧兜底(§异常兜底)仍待做
- [ ] **偶发「全黑无响应」根因定位** — 9/5 起**四次** `Application Hang`（窗口纯黑 + 连托盘
  都无响应 + 只能任务管理器；9/05 17:59、9/09 00:52、9/09 01:09、9/10 17:01）。四次问题签名
  **恒定**（`P4=c27d` / `P5=67246080`）但产物跨越两次构建（`6a9a7b15`/09-04 与
  `6aa0269d`/09-08）→ 已排除「某次构建引入」。
  **2026-09-10(深夜) 重大更正：Mica 假设已推翻** —— 首挂（09-05 17:59:27）比 Mica 首次运行
  （pet.log 09-05 22:43:28）早 **4 小时 44 分**、比其提交（8f48216 / 09-06 01:26）早约 7.5 小时，
  且首挂产物**不含 Mica 代码**（运行时 / 二进制 / 提交三重证据，见 CHANGELOG）。
  **A/B 因此由「主验证」降为「最终确认」**：它确已于 2026-09-10 17:37:36 真正开始（pet.log
  首次出现 `mica skipped (MIASAKI_NO_MICA) → opaque background`），但已不在关键路径上。
  **嫌疑区间收窄**：产物 `6a968676`（09-01 16:01，根 `dist/`）在 9/1~9/4 支撑多次会话且零挂起
  → 引入区间锁定 **09-01 16:01 → 09-04 16:02**（运行时拆分 / 桌宠模块化 / GDI 兜底 / 令牌漂移 /
  Fleet 指示器）。**注意**：偶发问题里「零发生」需足够长观察窗才可信，回滚验证同样要按此折算。
  已排除：Mica/透明窗口、WebView2 版本（.62/.66 均挂起）、WebView2 崩溃、**跨进程挂起**
  （Event Name 为 `AppHangB1` 且 `P6` 空）、cookie 401、dsh 后端、GPU TDR、待机冻结。
  取证脚本 `_refs/scripts-archive/`：`read-wer-hang.ps1`（自提权读 WER；09-10 升级为导出完整
  Report.wer 供离线分析）/ `watch-miasaki-hang.ps1`（常驻）/ `diag-miasaki-hang.ps1`（单次）。
- [ ] **挂起现场取证能力（根因定位的真正瓶颈）** — **2026-09-10 提权取证已确认：四次挂起
  `Report.wer` 全部无 dump，且 `LoadedModule entries: 0`**，拿不到挂起瞬间的全线程栈、
  也拿不到 hung module，只能靠排除法。**结论：WER 通道已榨干，不要再等它。**
  需二选一：进程内看门狗（检测消息循环心跳超时即落盘线程栈 + 可选自动恢复）或外部监控在
  `Responding=False` 时抓 dump；否则根因无法收敛（2026-09-10 评估）。
- [ ] **长时间稳定性观察** — 用户连续运行 ≥1h 无崩溃(第六轮修复验证)
- [x] **GDI 异常兜底** — ULW 连续失败计数（首失败+每 300 次日志，10 连败销毁表面）
  + 表面无效每 ~30 compose 重试重建（2026-09-04，`pet_native/window.rs`；
  pet.log 可见 `ULW failed`/`surface rebuilt`，harness `cargo check` 通过，
  Windows 机终验 `tauri build`；**2026-09-05 本机终验通过**：release 构建 30.7s
  零错误产出 `miasaki.exe`，smoke-test 非沙箱 8/8 全过）

## P1 · 用户已验证清单(本轮)

- [x] **鉴权 cookie 注入(黑屏修复)** — dsh web 重启后旧 cookie 失效黑屏，运行时
  自动重签+重载（2026-09-05，`themes/src/00-boot.js`，见 CHANGELOG；secret 硬编码
  改进项见 P3；**2026-09-05 静态全链路验证通过**：硬编码 secret 与
  `.credentials.yaml` 当前值一致，cookie 名/`v1.body.sig` 格式/payload 字段/
  authority 与官方 `dsh-client-connection` 逐项一致，401 场景可复现；已随
  release 构建部署至 `dist/Miasaki.exe`，端到端目检待用户双击快捷方式）
- [x] ~~**鉴权 secret 动态化**~~ — **已并入 2026-09-22「鉴权 cookie 预置注入」设计**
  （`design/auth-cookie-prepinject.md`，与 401 恢复链失效修复同链路落地）：secret 改为
  loading 页经 invoke 从 `~/.dsh/.credentials.yaml` 动态读取（Rust 手写 yaml 行解析，
  失败回落硬编码），与原「401 检测→reload」兜底链分离——主修不再依赖进入错误页后自愈。
- [ ] **401 恢复指引分支（部分保留）** — 预置注入后 401 概率极低，残余场景（硬编码 secret
  也过期）由加固后的 00-boot.js 兜底链自愈；「指引用户重新打开 dsh web 打印的 URL」的文案
  引导视验收结果再评是否还需要（见 `design/auth-cookie-prepinject.md` §3）

- [x] 主窗口位置/大小持久化(window.json)
- [x] 托盘菜单(显示/隐藏主窗口、退出)
- [x] 冒烟测试脚本(smoke-test.ps1,用户机执行)
- [x] 文档拆分(CHANGELOG / ARCHITECTURE / TODO)
- [x] **启动失败恢复页** — dsh 未安装/端口占用/重试换代;失败页动作:检查 dsh/打开终端/
  打开日志目录/导出诊断(2026-08-24,设计见 `design/bootstrap-reliability.md`)
- [x] **bootstrap.json 与 window.json 原子写**(temp+rename)
- [x] **启动失败用例自动化** — dsh 未安装 / 端口被占用 / 单实例冲突三用例以
  WARN 预检接入 smoke-test.ps1 §0b（2026-09-04，跨平台 .NET 探针，环境相关不计 fail；
  手动用例清单见设计文档 §6 仍有效）
- [x] **pet.json 版本化** — `version: 1` + 损坏回默认(设计已定,见 bootstrap-reliability.md §4.1;
  2026-08-29 落地:含位置可见性校验(EnumDisplayMonitors 工作区)+ hide 持久化)
- [ ] **安装包 + 卸载** — NSIS/MSI 需要联网下载 bundler(沙箱内不可行 → 用户机执行
  `npm run build`);建议连同 DSH 依赖检测一起:启动时探测 `dsh` 命令 + 3080,失败页给出安装指引
- [ ] **历史会话恢复验证** — rc.8 SQLite 不兼容,需在桌面端 GUI 抽查一个 rc.7 时期历史会话
  能否正常恢复/分叉;无头环境无法验证(源自 8-20 计划 P1-4,该稿已归档 `_refs/plans-archive/`)

## P2 · 体验

- [x] **桌宠设置面板** — DSH「设置 → 桌宠」:显示/隐藏(持久化)、位置重置(屏幕外找回)、
  状态回显(hash 命令通道 + eval 回推);位置屏外自动回默认(2026-08-29,见 CHANGELOG)
- [ ] **启动加载 2.0 + cmd 闪窗根治（2026-09-22 设计定稿）** — 用户点名「太简单 / 闪过终端窗口 /
  加载页把启动终端代码内置」。三件：① 归因后根治 `cmd /C dsh web` 闪窗（首选绕开 cmd 直达
  `node <bin.js>`，兜底回落 cmd；先归因再修，嫌疑矩阵见设计 §3.1）；② dsh stdout tee 进 loading 页
  （内嵌终端日志流 + 四阶段进度，`__appendLog` / `__setPhase` 新钩子，`__setStatus` 契约不变）；
  ③ 视觉升级（纹章旋转/扫描线/打字机光标，reduced-motion 降级）。设计见
  `design/boot-loading-terminal.md`；appearance 半（DSH 首帧启动画）与 cross 契约见
  `../dsh-miasaki-shared-docs/cross/boot-loading-2026-09-22.md`。实机验收七项（闪窗 5 连发 /
  日志流 / 失败零回归 / 兜底回退 / 性能 / 降级 / smoke 回归）见设计 §6。
- [ ] **拖拽上传附件到会话（2026-09-22 设计定稿，未实施）** — 桌面端拖文件进主窗口
  静默无效果。根因：tauri-runtime-wry 默认注册 drag-drop handler → WebView2
  `SetAllowExternalDrop(false)` + `RegisterDragDrop` → 页面级 HTML5 DnD 被整体拦成
  无人监听的 `tauri://drag-drop` 窗口事件。修法：`main.rs` 主窗 builder 加
  `.disable_drag_drop_handler()`（官方注释指明这是 Windows 上用 HTML5 DnD 的必要条件）
  + 注入层安全网 `09-dropguard.js`（防 composer 未挂载页面 drop 落入浏览器默认
  `file://` 导航炸掉 SPA）+ loading 页防默认。四步实施与实机验收十项见设计
  `design/drag-drop-attachment-upload.md`。
- [ ] 主窗口最小化到托盘(关闭=退出保持现状,托盘已有显隐)
- [ ] 桌宠「审批等待」状态(主页面 DOM 扫描 → 桌宠 waiting 姿态)— 2026-08-30 接入,见 CHANGELOG;桌宠内一键审批后续阶段
  - **2026-09-12 v3 M2 落地**:主信号已替换为官方契约(`SessionSnapshot.running` +
    `uiSession.pendingInteractions`,dsh-pet-panel 经 hash `pet=` 上报),DOM 扫描降级为
    兜底(官方通道 5s 无心跳才启用);waiting 姿态与常驻气泡不变。剩余:桌面壳实机验收
    (发消息 thinking / 完成 done / 审批 waiting+工具名)。详见 CHANGELOG 与
    [`pet-v3-roadmap.md`](pet-v3-roadmap.md) M2。
  - **2026-09-16 R0 落地（对标第一批）**：审批改为**跨会话聚合**——遍历全部会话的
    `pendingInteractions`（**切走会话也能看到后台会话的待审批**），随态带出 `sessionId`/`reason`；
    并落地**身份门禁**（拿不到稳定身份的审批一律不显示）。见 CHANGELOG 2026-09-16 与
    [`pet-reference-benchmark.md`](pet-reference-benchmark.md) R0。
  - **2026-09-16 R5 落地（对标第二批，M3.2 完成）**：审批气泡升级为含「拒绝 / 允许一次」两按钮的
    交互气泡；点击经 `eval` 派发 → 插件调用官方 `PendingApproval.answer()`；只发两个枚举、
    seq 去重、3s 未生效则回落「需要你的批准」（**不假装成功**）。**桌宠内一键审批不再是待办**。
- [ ] 反转狂三 run/wave/jump 动画帧(立绘已换,动画帧未生)
- [x] **桌宠双击 = 唤起/聚焦主窗口** — **2026-09-12 v3 M1.3 重做落地**:窗口类补注册
  `CS_DBLCLKS` 后双击真正可达(此前是死代码,第二击只会再走一次 `WM_LBUTTONUP`);
  语义定为**双击挥手**(250ms 去抖与单击区分),等待审批或主窗口最小化/隐藏时双击/单击
  = 唤起主窗口。修复记录见 CHANGELOG, [`pet-v3-roadmap.md`](pet-v3-roadmap.md) M1.3。
- [ ] **桌宠 v3 专项(2026-09-12 立项规划)** — 立绘准确性 / 动作数量 / 真实工作状态 / 快捷审查提权 /
  边缘状态(屏幕边缘露头 + 爬本应用主窗口)。**M1 状态机修复、M2 真实工作状态均已同日落地**
  (M1:hop 泄漏卡死 / 优先级重排 / 双击可达 / 单击不抢焦点 / 圆点跟随;
  M2:六态模型 / 官方契约通道 / DOM 兜底降级 / Done 庆祝 / 气泡 22 帧;单测 10/10)。
  实机验收清单见 roadmap §3 M1/M2;下一步 **M3 快捷审查与提权**(S3/S4 已实证可达,
  M3.1 提示 + M3.3 快捷审查先行,M3.2 桌宠内一键审批待用户拍板)。
  详见 [`pet-v3-roadmap.md`](pet-v3-roadmap.md)。
- [ ] **桌宠参考对标后续（2026-09-16 评估 → `design/pet-reference-benchmark.md`）** —
  **第一批 R0–R3 已落地**（跨会话审批聚合 + 身份门禁 / 点击不夺前台 `WS_EX_NOACTIVATE` /
  透明区域逐像素穿透 / `pet.json` v2 位置比例化 + 可见性判据改角色区域）；
  **第二批 R4/R5/R7 已落地**（提醒模型 `Alert`（优先级 + 同 id 就地更新 + 按 id 精确移除）/
  **桌宠内联审批**（`approval.png` 双按钮气泡 + eval 派发 + 官方 `answer()` + 3s 失败回落）/
  气泡最小驻留防抖），`cargo test` **19/19**、`verify-all desktop` 8/8，见 CHANGELOG 2026-09-16。
  **剩余候选（待用户拍板，按评估文档 §4 批次）**：
  - **R6 待实机**：跑一个动态 Cordis 插件，确认其运行审批是否落在官方 `approval` 域
    （本轮因客户端插件激活需用户批准、而会话审批已禁用，**未能运行时验证**）；
    提问等待（`ask_user_question`）走 `dsh-client-ui-user-questions`，属**新增通道**（未做）；
  - 第三批 动作与物理（**零素材**）：R11 绘制层变换管线 / R12 甩出物理 / R13 拖动合帧 / R8 省电降帧；
  - R14 M4.1 边缘探头口径（露出量按旋转后投影 bbox、pause/resume 平移）；
  - R15 M5：补 whale/inverse **单帧态** + `runRight`/`runLeft` 接入 + `r7` 语义修正；
  - R9/R10 工程治理（Rust 侧架构红线 / 设置准入线）；
  - **P0-1~P0-3**：挂起取证与降损（独立于桌宠功能，建议单独立项）。
- [ ] **主题→人格切换后自动打开新会话**(v0.1.4 仅自动创建 + toast 提示;自动选中需 DSH 提供
  URL 直达会话或谨慎的侧栏定位,前者优先,后者脆弱不做)
- [ ] 主题切换视觉漂移核对(rc.8 alias 表达处,需用户机截图)

## P3 · 工程

- [ ] 正式 IPC(如 tauri 自定义协议 / postMessage)替代 hash 通道(收益有限,hash 已验证可靠)
- [ ] verify-themes.mjs 沙箱运行方案(无头 Edge 被命名管道限制;可换 WebView2 实例化)
- [ ] 测试自动化(单元:parse_fragment 纯函数;集成:smoke-test 扩展)
  - 注 2026-09-04：Rust `Frames::kurumi_row` 单测（harness `cargo test` 通过）、
    dispatch 解析器四路 pwsh 实测通过；parse_fragment 单测仍待
- [ ] 升级策略(DSH rc.x 升级后跑 verify-themes + 令牌面 diff,build-init 已内建令牌校验)
- [ ] **依赖安全跟踪（GHSA-wrw7-89jp-8q8g）**：`Cargo.lock` 中 glib 0.18.5 受 `VariantStrIter`
  unsoundness 影响（修复版 0.20.0）；其为 Tauri 仅 Linux(GTK) 目标的传递依赖
  （webkit2gtk 2.0.2 → gtk ^0.18 → glib ^0.18），上游 tauri/webkit2gtk 最新版均未迁移
  gtk-rs 0.20 世代，官方生态暂无修复版本；本项目仅发布 Windows 桌面端，受影响代码
  不进任何产物，Dependabot 告警 #1 已按 not_used 驳回（2026-09-06）。待上游迁移后
  `cargo update` 跟随升级并重新核对。

## 历史教训(勿重犯)

1. WebView2 ≠ 桌宠窗口载体;原生分层窗是唯一解
2. GDI 选中对象先恢复再删除;高频调用用持久表面
3. DPI 物理/逻辑坐标差整倍(取证脚本必须 DPI-aware)
4. Copy-Item 到已存在目录会嵌套(dist\ui\ui)
5. 沙箱子进程写 %LOCALAPPDATA% 失败(用工作区 marker 探针)
6. 主窗口 must 提权运行(WebView2 初始化)
