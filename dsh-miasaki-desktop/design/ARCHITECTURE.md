# Miasaki Desktop — 架构文档

> 面向维护者。变更历史见 `CHANGELOG.md`,待办见 `TODO.md`。

## 1. 组成与进程模型

```
Miasaki.exe (Tauri 2, 单进程)
├─ 主窗口 "main"(WebView2, 无边框)
│   ├─ loading.html(本地唤醒页)+ initialization_script 注入 theme-init.js
│   └─ 导航 http://127.0.0.1:3080/(DSH web,由启动器拉起)
├─ 桌宠线程(原生 Win32 分层窗口,UpdateLayeredWindow 逐像素 alpha)
│   ├─ set_mode / set_intensity(共享 Arc<Mutex<PetShared>>)
│   └─ 33ms SetTimer → compose(帧更新 + 惰性 present)
├─ hash watchdog(tokio,33ms):URL fragment → 主题/强度/拖窗/命令
├─ 后端存活看门狗(tokio,2s):后端死亡 → 自动重拉 dsh web(退避 2s→30s)+ 错误页重导航(2026-09-23)
├─ fleet 脉冲看门狗(tokio,2s,可选):MIASAKI_FLEET_PULSE 文件 → 桌宠 fleet 指示
├─ 素材服务(127.0.0.1:39800,exe 旁 ui/pets|icons,CORS)
└─ 托盘(tray-icon):显示/隐藏主窗口、退出
```

单向依赖:**运行时(注入 JS)→ URL hash → Rust(Rust 只读,不写)**。不可用 Tauri IPC
(远程页面 invoke 被 ACL 拒绝),hash 通道是唯一同步途径。

## 2. 关键设计决策(勿随意更改)

| 决策 | 原因 |
|---|---|
| WebView2 只做主窗,桌宠用原生 Win32 分层窗 | WebView2 透明/置顶/工具窗全部不可用(黑化/空白/绿幕),三角色/待机行为已验证 |
| 初始化注入 = initialization_script + on_page_load eval | 只在文档创建时可靠;导航后 eval 不可靠 |
| 主题 = 令牌层覆盖 `--dsw-static-*` + `--dsw-alias-bg-*` | 不动 DSH 本体,升级无冲突;rc.8 令牌面 73 个 static 与 token-surface.txt 一致 |
| 桌宠帧数据 = 启动时一次性加载,裸指针共享 | compose 高频,避免每次拷贝;帧数据不可变,指针安全 |
| present = 持久 DC/DIB 表面 + 脏标记 | 高频 CreateDIBSection/gdi32full 崩溃(见下 §4);脏标记把静止态 GDI 频率从 33ms 降到 ≥125ms |
| 拖窗 = 累计增量(×DPR)+ Rust 差值应用 | 增量式在 33ms 轮询下丢帧;DPI 200% 下物理/CSS 混用会半速 |
| 启动健康标记 = bootstrap.json(v1),temp+rename 原子写 | 启动阶段落盘(bootstrap/spawn/waiting/up),失败可诊断;损坏删除重建默认(不猜不静默)。设计见 bootstrap-reliability.md |
| 重试 = BOOTSTRAP_GEN 代际计数(+1 后旧序列自行退出) | spawn 失败后旧循环不再 spawn,原「重试」按钮形同虚设;换代后新序列完整重跑 |
| 桌宠缩放 = 预乘空间双线性采样(2026-08-30) | 非整数最近邻(208→270 ×1.298)把单点杂色撕成锯齿簇,540→270 隔行丢像素破坏抗锯齿;双线性在预乘空间下数学正确且 ULW 兼容 |
| 桌宠状态源 = 官方契约为主 + DOM 兜底(v3 M2 2026-09-12;R0 2026-09-16 改为**跨会话聚合**) | `dsh-pet-panel` 读官方 `ctx.sessions`/`ctx.uiSession.pendingInteractions`(inject 白名单实证),hash `pet=` 上报;DOM 扫描仅通道死亡时兜底。单写者:注入运行时 syncHash 合并 pet 字段,pet-panel 只写全局对象。**R0 起**:审批遍历全部会话的 `pendingInteractions`(切走会话也能看到后台待审批),运行态「任一非子代理会话 running = 忙」;审批带出 `sessionId`/`reason`,**无稳定身份不显示** |
| 桌宠窗口 = 不夺前台(`WS_EX_NOACTIVATE`,R1 2026-09-16) | 点击桌宠不再夺走前台/键盘焦点——否则用户在原应用的 Ctrl+C/V 会落到桌宠窗口(参考实现 issue #98 的「整机复制粘贴失效」观感)。**只改扩展样式位、不重建原生窗口**;鼠标/键盘消息照常送达,点击/拖动/双击不受影响 |
| 桌宠窗口 = 透明区域逐像素穿透(R2 2026-09-16) | 10ms 光标轮询(`IDT_HIT`) + 查**当前合成缓冲 `buf`** 的 alpha(阈值 `CLICK_THROUGH_ALPHA=16`) → 动态置位/清除 `WS_EX_TRANSPARENT`。**必须轮询**:置位后本窗口收不到鼠标消息,恢复判定无从由事件得知。拖拽/隐藏中恒不穿透;只改样式位不重建窗口(重建会闪烁) |
| 桌宠位置 = pet.json v2 比例 + 屏幕身份(R3 2026-09-16) | 「**角色可见区域**中心」相对所在工作区的比例 `rx/ry` + 工作区几何(屏幕身份) + 绝对坐标兜底 + hide;v1 按 `version` 分流读取并自动升级。可见性判据 = **角色可见区域 ∩ 工作区 ≥ 25%**(角色区域 = 底部 `CELL_H` 带,与 `blit_center_bottom` 几何一致)。旧「窗口中心点」判据在 M4.1 peek 缩边时必然误判「不可见」→ 拉回默认位置 |
| 桌宠气泡 = 提醒模型 `Alert`(R4/R7 2026-09-16) | 单槽 → `{ id, frame, priority, sticky, until }`;优先级 **审批(0) > 告警(1) > 状态(2) > 台词(3)**;同 id **就地更新**(不重置计时,状态抖动不闪);**按 id 精确移除**(`resolve_alert`);低优先级受 `ALERT_MIN_DWELL_MS=900ms` 最小驻留保护,审批/告警**恒可立即抢占**。未采纳参考实现的「被抢占项回队首」(我方同时只展示一个气泡) |
| 桌宠内联审批 = 单向链 + 官方 `answer()`(R5/M3.2 2026-09-16) | **Rust 不持有任何 DSH API**:命中区(`approval.png` 固定矩形)→ `decide_approval` → 乐观收起 + 单调 `seq` → `wv.eval` 派发 `miasaki-approval-decision` → `dsh-pet-panel` 在跨会话 `pendingInteractions` 中按 `key` 匹配 → 官方 `PendingApproval.answer('allowed-once'\|'rejected')`。红线:仅用户显式点击、仅两个枚举、seq 去重、**失败不假装成功**(`DECISION_FALLBACK_MS=3000ms` 后回落「需要你的批准」);**无 `key` 不挂可交互气泡**(身份门禁) |
| 桌宠状态扫描(DOM 兜底) = 节奏分级 + 零强制布局(2026-09-08) | 原实现每轮对每个 button 求 `offsetParent`(强制布局)、且每轮重算含 `elementFromPoint`/`getComputedStyle` 的 diag;长会话+流式输出下实测每 1.5s 出现 15~47ms 主线程尖峰,表现为输入发涩/发送无响应。改为 activity 每轮、effort/approval 每 2 轮、hidden 时每 4 轮,diag 按 10s 节流重算 |
| 后端存活看门狗 = 2s 探测 + 自动重拉(2026-09-23) | 此前运行期无任何恢复手段:后端意外死亡(外部杀掉 / 撞上正在退出的旧服务 / 采用的外部后端退出)后 webview 永久停在死后端,只能重启整个应用。看门狗判活 = 自拉后端进程(`OpenProcess`+`GetExitCodeProcess==STILL_ACTIVE`)+ 3080 TCP 连通;重拉失败按 2s→4s→8s→16s→30s 退避;文档从未加载成功(错误页)时重拉后补一次重新导航,活页面交给 DSH 前端自带 500ms→10s 指数退避重连(cookie 持久有效,无需 reload)。主动关闭(`SHUTTING_DOWN`)即退,不与停后端抢节奏 |
| 关闭应用 ≠ 无条件停后端(2026-09-23) | 后端是共享服务:桌面端两次关闭曾分别杀死浏览器正连着的后端 → 页面断连只能等手动重启。关闭前用 Toolhelp32 进程树 + `netstat -ano` **对端端口**判定外部客户端(WebView2 子进程与自身剔除);仍然连着 → 保留后端并落日志,没人用 → 照旧 taskkill。探测失败回落旧语义(照停),最坏不劣化 |

## 3. 数据流

### 3.1 主题/桌宠联动
```
切换条点击 → apply(t) → (核心同步先行) syncHash()
  → history.replaceState('#miasaki-theme=t&int=…&diag=…')
  → Rust watchdog(33ms)→ parse_fragment → pet.set_mode(pet_mode_for(t))
```
**apply() 顺序是定律**:syncHash/refreshSwitcher/updateTitlebar 在装饰层(watermark/aurora)之前,
装饰层各自 try-catch。曾因装饰层异常阻断同步导致"图标不换+桌宠不切换"。

### 3.2 拖窗
```
tb-drag pointerdown → 记录起点;pointermove → move=累计物理增量(×devicePixelRatio)
  → Rust 差值应用(apply = cur - last_move);pointerup → move=reset + 160ms 后清 hash
```

### 3.3 思考强度
页面 DOM 变异计数(MutationObserver,忽略注入层自身)每 2.5s 分级 idle/work/deep → hash `int=` → set_intensity。

### 3.4 桌宠状态源(v3 M2 2026-09-12 重做:官方契约为主,DOM 兜底)
```
主信号 —— DSH 官方契约(dsh-pet-panel 插件,inject sessions/uiSession;**R0 起跨会话聚合**):
  ctx.sessions.list.getSnapshot()   → { ids, byId, current, ... };遍历 ids/byId 取 row.running
                                      (**任一非子代理会话 running = 忙**;不再只读 current)
  ctx.uiSession.pendingInteractions → ReadonlyMap<SessionId, PendingApproval>;**遍历全部会话**
                                      找审批(切走会话也能看到后台待审批);带出 toolName+sessionId+reason+key;
                                      **无稳定身份的审批不显示**(身份门禁)
  hash petkey= ← 官方 PendingApproval.key(审批的幂等身份;R5 内联审批按它匹配与移除)
  合成六态 idle/thinking/waiting/error/done(subagent 会话不计入;running true→false 边沿=done)
反向(仅 R5 决策,用户点击才发生):
  Rust 命中区 → 乐观收起 + seq → wv.eval 派发 'miasaki-approval-decision'
    → dsh-pet-panel 按 key 匹配 → 官方 PendingApproval.answer('allowed-once'|'rejected')
    → (失败) 3s 内审批仍在 → 桌宠改显「需要你的批准」提示去 DSH 界面处理
    │ 每 1.5s 心跳写 window.__miasakiPetPanel = { ts, state, tool }
    ▼
注入运行时 02-core.js syncHash(hash 单写者):心跳 5s 内 → 追加 pet=<态>&pettool=<工具名>&petts=<ms>
  官方通道静默 → 不带 pet 字段;05-sensors.js 同步关闭 act/wait DOM 扫描(不是双源并存)
兜底信号 —— DOM 扫描(通道死亡时,themes/src/05-sensors.js):
  scanActivity()("停止生成"按钮→busy) / scanApproval()(dialog 内允许+拒绝成对→wait=1)
main.rs parse_fragment(结构体) + start_hash_watchdog
  ▼  pet.set_official_state(ts, state, tool) / set_activity / set_waiting_approval
compose 六态合成(pet_native.rs PetState):
  官方(5s 心跳内,白名单归一化) > DOM 兜底(waiting/busy) > fleet 叠加(告警;Waiting>FleetBlocked)
  行选择 pick_state_row:Waiting(wait 行) > FleetBlocked/Error(failed) > Done(review 一次)
    > Thinking(idle 静默守候) > Idle(动作槽)
  气泡:waiting→等待审批 / error→出错了 / done→完成了(10s) / thinking·fleet_running→忙碌中
```
**DOM 兜底校准**:`__miasakiProbe()`(window 全局)dump 当前候选按钮文本,Operator 按 DSH
实际版本调整 `themes/src/05-sensors.js` 顶部的 `ACT_BTN_TEXT`/`APPROVE_TEXT`/`DENY_TEXT`/
`APPROVE_CONTAINER_SEL` 常量。agent 员工状态归 `dsh-miasaki-fleet/fleet-monitor/`
工作面板,不在桌宠内展示。

## 4. GDI 绘制流水线(血泪区)

**铁律(违反必崩)**:
1. `SelectObject(dc, obj)` 返回旧对象;**恢复旧对象后才允许 `DeleteObject(obj)`**。
   被 DC 选中的对象删除失败 → 33ms 高频下句柄泄漏 → gdi32full 0xc0000005(偏移稳定 0x2ae13)。
2. 避免高频 `CreateDIBSection`:已用持久表面(DIB 32bpp 预乘 alpha,top-down)。
3. 每像素手工预乘(`bgra = (a<<24)|((r*a+127)/255)<<16|…` 2026-08-30 改四舍五入消 ≤1 级偏暗);
   GDI 绘制不写 alpha;`load_png` 加 `a<8 → 0` 兜底(防 desync 素材被拉满)。
4. 所有 GDI 调用前检查句柄(0/null 提前返回)。
5. 桌宠缩放走**预乘空间双线性采样**(`blit_center_bottom`,2026-08-30):源坐标中心对齐
   `(x+0.5)*src.w/w-0.5`,四邻域按权重混合预乘值,边界 clamp。ULW 的
   `AC_SRC_ALPHA` 需要预乘值,直接在预乘空间插值数学正确;最近邻会因非整数缩放比
   (×1.298)产生锯齿簇,等倍缩放(×0.5)会隔行丢像素破坏抗锯齿。

## 5. 构建链路(顺序固定)

```powershell
# desktop 目录
node scripts/cut-frames.mjs    # 图集切帧(kurumi 切 9 行 + whale 拆 idle.gif;内置 despeckle 杀散点/光晕)
node scripts/inverse-states.mjs # 反转狂三立绘处理(1px 净色环带 + despeckle;需 raw/blue-*.png 源)
node scripts/make-icons.mjs    # 主题徽章 + 应用图标(源 src-tauri/icon-new.png,圆角 24% 边长)
node scripts/gen-init          # 注入包 + 令牌完备性校验
powershell -File scripts/gen-bubbles.ps1 # 桌宠气泡精灵表(20 帧:17 台词 + 3 状态帧;改 quote_pool 后必跑)
npx tauri icon src-tauri/app-icon-source.png   # 换图标时执行
# src-tauri 目录
cargo build --release --offline
# 发布:先删后拷(嵌套陷阱)
Remove dist\Miasaki.exe; Copy target\release\miasaki.exe → dist
Remove dist\ui -Recurse; Copy desktop\ui → dist\ui
```

## 6. 已知约束

- **运行应用需提权一次**(WebView2 写 %LOCALAPPDATA%);DSH 沙箱内主窗口不可见(非提权 WebView2),
  沙箱子进程也写不了 %LOCALAPPDATA%(pet_log_line 静默失败)→ 沙箱验证靠工作区 marker 探针 + 窗口截图。
- **DPI**:进程 DPI-aware(物理坐标);PowerShell 取证脚本需 `SetProcessDPIAware`,否则坐标差 2 倍。
- **rc.8 令牌面**:`--json-tree-*`(5)/`--dsl-code-block-banner-background-color`/`--dsw-hovercard-bg`/
  `--dsh-state-ongoing` 已失效(主题内为死覆盖,无害);视觉漂移点在 alias 表达处。
- **单实例**:tauri-plugin-single-instance(二次启动唤起已有窗口)。
- 主窗口关闭 = 退出应用(DSH 服务保持运行);托盘菜单可隐藏主窗口。
- **标题栏**(v4 2026-09-06,自 v3 2026-09-05 演进):**零占位叠加**——窗口自绘壳对 DSH 页面零布局侵入
  (无顶带/无下推/无卡片,页面 y=0 起渲染,顶部控件与 web 端同位置);窗控 = 右上角
  **无壳裸键组**(v3 悬浮胶囊外壳已删:无底色/边框/毛玻璃/padding,hover 底色只落单按钮;
  主题徽章 16px 保留在按钮组左侧;`pointer-events:none` 容器,仅按钮组子元素接收事件);
  拖动 = document 级 mousedown 捕获 + 顶部 36px 命中判定(复用 tauri drag-region 判定口径:
  路径上有可点击标签/contenteditable/tabindex/交互 role 即放行点击,否则
  `plugin:window|start_dragging`/双击 `internal_toggle_maximize`);唯一页面级调整 =
  **右上角安全区让位**(2026-09-10 晚重写):`:root{--ms-titlebar-reserve:128px}`
  (裸键组 108px + right 8px + 12px 呼吸位),按恒存锚点让位官方右栏两处控件 ——
  `#root header:has([data-conversation-header-corner]){padding-right:var(--ms-titlebar-reserve)}`
  + `#root [data-conversation-header-corner]{margin-right:0}`(抵消官方 -16px),
  `#root [data-sidebar-right-panel] [data-dockkit-strip-chrome]{margin-right:calc(var(--ms-titlebar-reserve) - 6px)}`;
  `.tb-group` 的 `top:11px` 使窗控中心与官方控件同落 24px 线。v4 原有的
  `header:has([role="tablist"]){padding-right:118px}` 已废(该行官方仅在 view tab >1 时渲染,
  单 tab 会话整条失效;且未计入 corner 的 -16px,实际只让出 102px)。选择器一律带 `#root` 提权
  (官方 CSS Module 运行时注入,时机晚于我们)。改动随 verify-themes 第 6 节复核。底座为
  Win11 Mica(`apply_mica` DWM 直调 `DWMWA_SYSTEMBACKDROP_TYPE` + 透明窗口底,
  面板令牌半透明后透出),Mica 不可用(Win10)回退主题实色底
  (见 CHANGELOG 2026-09-05 / 2026-09-06 条目)。侧栏色块模拟/几何同步已随 v2 移除(历史见
  CHANGELOG 2026-08-29 / 2026-09-05 各条)。
- **Rust→页面单向通道(eval + CustomEvent)**:远程页 capability 只授 start-dragging,
  无 IPC 权限;Rust 侧经 `wv.eval` 派发 CustomEvent 下发状态(`miasaki-pet-state` /
  `miasaki-max-state`),页面经 hash `cmd=*` 请求重推(want-max / pet-state)。新增
  窗口状态推送需遵循此模式,勿走 `__TAURI__` IPC。

## 7. 文件地图(关键)

```
desktop/
├─ themes/runtime.js       # 注入运行时(主题/标题栏/切换条/水印/aurora/hash 通道/强度)
├─ themes/{pure,zafkiel,kurkuriel}.css
├─ scripts/build-init.mjs / cut-frames.mjs / make-icons.mjs / inverse-states.mjs /
│  capture-all.ps1 / smoke-test.ps1
└─ src-tauri/
   ├─ src/main.rs          # 启动器/hash 通道/托盘/窗口状态
   ├─ src/pet_native.rs    # Win32 分层窗桌宠(FFI 全裸,无 winapi 依赖)
   └─ injected/theme-init.js(生成物)
design/HANDOVER.md(续推入口)/ CHANGELOG.md / TODO.md / themes.md / token-surface.txt
```
