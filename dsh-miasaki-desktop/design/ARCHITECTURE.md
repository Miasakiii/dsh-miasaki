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

## 4. GDI 绘制流水线(血泪区)

**铁律(违反必崩)**:
1. `SelectObject(dc, obj)` 返回旧对象;**恢复旧对象后才允许 `DeleteObject(obj)`**。
   被 DC 选中的对象删除失败 → 33ms 高频下句柄泄漏 → gdi32full 0xc0000005(偏移稳定 0x2ae13)。
2. 避免高频 `CreateDIBSection`:已用持久表面(DIB 32bpp 预乘 alpha,top-down)。
3. 每像素手工预乘(`bgra = (a<<24)|(r*a/255)<<16|…`);GDI 绘制不写 alpha。
4. 所有 GDI 调用前检查句柄(0/null 提前返回)。

## 5. 构建链路(顺序固定)

```powershell
# desktop 目录
node scripts/cut-frames.mjs    # 图集切帧(仅 kurumi;inverse 由 inverse-states 生成)
node scripts/inverse-states.mjs # 反转狂三立绘处理(需 raw/blue-*.png 源)
node scripts/make-icons.mjs    # 主题徽章 + 应用图标(源 src-tauri/icon-new.png)
node scripts/gen-init          # 注入包 + 令牌完备性校验
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
- **DSH DOM 契约(标题栏几何同步,验证于 0.1.1-rc.1)**:`syncTitlebarGeometry` 依赖
  `#root` 内 AppFrame(`@deepseek-ai/dsh-client-ui-layout`)的内联网格,且首列=侧栏、末列=详情面板;
  DSH 升级时须复核(网格结构/折叠语义变动会静默错位,探测失败仅回退 280px 默认,不报错)。

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
