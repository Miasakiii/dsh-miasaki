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
| 桌宠状态源 = DOM 扫描 + 优先级映射(2026-08-30) | 总指挥活动/审批状态只能从 DSH 主页面 DOM 取(无 IPC,无 fleet 文件总线);等待审批在 kurumi 复用既有 `wait` 行(偶发语义对)+ 常驻气泡 |

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

### 3.4 桌宠状态源(2026-08-30)
```
DSH 主页面 DOM(总指挥会话)
  │  runtime.js 每 1.5s 扫描:
  │    scanActivity()   → "停止生成"按钮? → act=busy
  │    scanApproval()   → dialog/modal 内"允许"+"拒绝"成对? → wait=1
  │    scanEffort()     → 模型选择器推理等级 → int=idle/work/deep
  │  act 翻转需 2 次连续确认(防抖);wait 出现即时上报/消失 2 次确认
  ▼  URL hash 扩展:#miasaki-theme=X&int=Y&act=Z&wait=0|1
main.rs parse_fragment + start_hash_watchdog
  ▼  pet.set_intensity / set_activity / set_waiting_approval
pet_native.rs compose 优先级映射:
  waiting=true  → kurumi `wait` 行 / whale·inverse `work` 立绘
                  + 常驻"等待审批"气泡(状态帧跳 3s 过期)
                  + 禁 ambient/wander + 单击桌宠=唤起主窗
  activity=busy → eff_intensity=work(whale·inverse work 立绘;kurumi 静默守候)
  idle          → 回退到 intensity(DOM 推理等级)
```
**校准**:`__miasakiProbe()`(window 全局)dump 当前候选按钮文本,Operator 按 DSH
实际版本调整 `runtime.js` 顶部的 `ACT_BTN_TEXT`/`APPROVE_TEXT`/`DENY_TEXT`/
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
- **标题栏**(v3 2026-09-05):**零占位叠加**——窗口自绘壳对 DSH 页面零布局侵入
  (无顶带/无下推/无卡片,页面 y=0 起渲染,顶部控件与 web 端同位置);窗控 = 右上角
  悬浮胶囊(pointer-events:none 容器,仅胶囊子元素接收事件);拖动 = document 级
  mousedown 捕获 + 顶部 36px 命中判定(复用 tauri drag-region 判定口径:路径上有
  可点击标签/contenteditable/tabindex/交互 role 即放行点击,否则
  `plugin:window|start_dragging`/双击 `internal_toggle_maximize`);唯一页面级调整 =
  `#root header:has([role="tablist"]){padding-right:132px}` 给胶囊让位(初版 104px
  真机叠压后加宽;选择器锚定 `role=tablist`,DSH 升级时随 verify-themes 复核)。
  底座为 Win11 Mica(`apply_mica` DWM 直调 `DWMWA_SYSTEMBACKDROP_TYPE` + 透明窗口底,
  面板令牌半透明后透出,与胶囊共享同一材质),Mica 不可用(Win10)回退主题实色底
  (见 CHANGELOG 2026-09-05 条目)。侧栏色块模拟/几何同步已随 v2 移除(历史见
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
