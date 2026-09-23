# 桌面端拖拽上传附件到会话（设计定稿，未实施）

> 需求原话：「桌面端现在缺少拖拽上传附件到会话」。
> 结论先行：**这不是「缺功能」，是「壳把官能的入口关在门外」**——官方 Web 端早就有完整的
> 拖放上传链路；桌面壳的 Tauri 默认拖放处理器在 Windows/WebView2 上把页面级 HTML5
> 拖放整体拦截，drop 事件被转成无人监听的 `tauri://drag-drop` 窗口事件，**静默丢失**
> （光标显示 copy、松手无任何效果）。修法是一行构建器调用 + 一个注入层安全网。

---

## 1. 现状：官方 Web 端已有完整拖放上传

三个官方包分工（均已在本机安装目录核对过源码，DSH 0.1.5-rc.1 基线）：

| 包 | 职责 | 关键事实 |
|---|---|---|
| `@deepseek-ai/dsh-client-ui-attachment` | 拖放手势 + 全屏遮罩 + 草稿缩略图 | `lib/client.js` 的 `ComposerAttachments`：`document` 级 `dragenter/dragover/dragleave/drop` + `window` `dragend`，`dragDepth` 计数进出；只认 `dataTransfer.types.includes("Files")`（拖选中文本/链接不触发）；`drop` 后 `onAddFiles([...dataTransfer.files])`；`DropOverlay` 走 body portal、`pointer-events:none`（不抢拖放目标） |
| `@deepseek-ai/dsh-client-ui-conversation` | 准入判定 + 限额 | `lib/client.js` L15920–15942：`intakeFiles` 与纸夹按钮**同一条路**——`mediaTypes` 过滤 → `maxImagesPerMessage` / `maxImageBytes` / `maxMessageImageBytes` 预检 → 失败 `showToast`，通过才 `addFiles(files)`；`canAcceptDrop = subagent === null && !locked && !machineBusy && addFiles !== void 0`（子代理视图 / 会话锁定 / 生成中 = 拒绝态，遮罩显示对应文案） |
| `@deepseek-ai/dsh-client-file-upload` | 字节上传 | `ctx.fileUpload.upload(sessionId, body, name, signal, onProgress)` → Worker 内 XHR 流式上传 → 暂存 `receiptId` → prompt 准入时消费 |

**推论**：桌面端只要让 HTML5 拖放事件到达页面，上传链路、限额、错误提示、遮罩
全部由官方提供，**壳侧零业务逻辑、零补丁、DSH 升级无忧**。

## 2. 根因：Tauri 默认拖放处理器把 HTML5 DnD 拦在壳外

证据链（按本仓 `src-tauri/Cargo.lock` 的版本核对 registry 源码：tauri 2.11.5 /
tauri-runtime-wry 2.11.4 / wry 0.55.1）：

1. **默认开启**：`tauri-runtime-2.11.3/src/webview.rs` L349/L515 ——
   `WebviewAttributes::default().drag_drop_handler_enabled = true`。
2. **接线**：`tauri-runtime-wry-2.11.4/src/lib.rs` L4862–4889 —— 该位为真即
   `wry::WebViewBuilder::with_drag_drop_handler(...)`，拖放事件转成
   `DragDropEvent` → 合成窗口事件 `tauri://drag-drop` 等。
3. **Windows 拦截机制**：`wry-0.55.1/src/webview2/mod.rs` L150–158 —— 一旦注册 handler：
   `ICoreWebView2Controller4::SetAllowExternalDrop(false)` **先关掉 WebView2 自身的
   外部拖放**，再 `DragDropController::new()` 用 `EnumChildWindows` 在 WebView2 子 HWND` 上
   `RevokeDragDrop + RegisterDragDrop`（`webview2/drag_drop.rs`：自实现 `IDropTarget`，
   `CF_HDROP` 取路径，Enter/Over/Leave/Drop 四态回调）。
4. **净效果**：文件拖入主窗口 → OLE 层吃掉 → 只剩 `tauri://drag-drop` 窗口事件。
   而本壳**没有任何监听**（全仓 grep `tauri://drag-drop|onDragDropEvent|dragDrop` 零命中，
   `main.rs` 的主窗 `WebviewWindowBuilder`（`WebviewWindowBuilder::new(app, "main", …)`）
   无任何拖放处置）→ **drop 静默丢失**。
5. **官方给的正门**：`tauri-2.11.5/src/webview/mod.rs` L971–976 ——
   `WebviewWindowBuilder::disable_drag_drop_handler()`，注释原文：
   *"Disables the drag and drop handler. This is required to use HTML5 drag and drop
   APIs on the frontend on Windows."*

## 3. 方案选型

| 方案 | 做法 | 评价 |
|---|---|---|
| **A（选定）** | 主窗 builder 调 `.disable_drag_drop_handler()`：wry 不再注册 `IDropTarget`、不再关 `AllowExternalDrop` → WebView2 原生 HTML5 DnD 直达页面 → 官方链路全量复用 | 一行改动；与 Web 端行为逐条对齐；无 capability、无补丁、无维护面。**唯一新风险**：composer 未挂载的页面（轨迹/用量/设置/loading）drop 会落入浏览器默认行为 = **导航到 `file://`，SPA 被换掉** → 必须配注入层安全网（§4.2） |
| B（退路，不首选） | 保留 handler，监 `tauri://drag-drop` 拿 paths，注入层把路径桥进页面，页面侧再走官方上传路由 | 要自建 fs 读取 + capability 授权 + 复刻限额判定 + 手拼上传请求；与 Web 行为分叉、维护面大。**仅当 S1 实机验证失败时启用** |
| C（已否） | 桌面壳自绘拖放 UI，不经官方链路 | 等于重造官方，违背「薄壳」定位 |

**A + 安全网 = 本次落点**。安全网只兜「官方没消费」的落点，`defaultPrevented` 判据
保证不干扰官方链路（§4.2）。

## 4. 详细设计

### 4.1 主改动（S1）

`src-tauri/src/main.rs` 主窗 `WebviewWindowBuilder`（`WebviewWindowBuilder::new(app, "main", …)` 那一处）追加一行：

```rust
// 拖拽上传附件到会话（2026-09-22 设计）：tauri-runtime-wry 默认注册 drag-drop
// handler，会在 WebView2 上 SetAllowExternalDrop(false) + RegisterDragDrop，
// 把页面级 HTML5 拖放整体拦成无人监听的 tauri://drag-drop 窗口事件（drop 静默
// 丢失）。禁用后 WebView2 原生拖放直达页面，官方 ComposerAttachments 的
// document 级 DnD 与上传全链路照常工作。本壳无人监听 tauri://drag-drop，零损失。
.disable_drag_drop_handler()
```

- 不需要任何 capability：页面 HTML5 DnD 不经 Tauri IPC（与 `start_dragging` 必须授
  `core:window:allow-start-dragging` 的情形相反）。
- 不动 `tauri.conf.json`（现无 drag-drop 配置），纯 builder 层。
- 桌宠窗口是原生分层窗口（无 webview），与本改动正交。

### 4.2 注入层安全网（S2，必做）

**为什么必须**：官方 document 级监听只活在 `ComposerAttachments` 挂载期间（对话
视图）。其他页面（轨迹 / 用量 / 设置，以及 loading 启动页）拖入文件时无人
`preventDefault` → WebView2 默认行为 = 导航到拖入的 `file://` 路径 → **DSH SPA 被
整体换掉**（白屏/错误页，无恢复入口）。这是修好 A 之后新暴露的回归面。

**做法**：新增注入分片 `themes/src/09-dropguard.js`，追加进
`themes/src/MANIFEST.json` 的 `order` 末尾（ready 之后；`order` 是拼接唯一真相，
`slices` 只是 legacy 考古不用动），随后 `npm run gen-init` 重生成
`src-tauri/injected/theme-init.js`。逻辑（document bubble 监听，全部副作用即监听器
本身，无常驻状态）：

```js
// 桌面端拖放安全网（design/drag-drop-attachment-upload.md）：
// 官方 ComposerAttachments 只在对话视图挂载 document 级 DnD；其余页面（轨迹/
// 用量/设置/启动页）drop 落空会触发浏览器默认行为 = 导航到 file://，SPA 被换掉。
// 此处只兜底：官方已 preventDefault（已消费）的 drop 不碰；其余一律阻止默认。
;((function () {
  var isFileDrag = function (e) {
    return e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') !== -1
  }
  var stop = function (e) {
    if (e.cancelable) e.preventDefault()
  }
  document.addEventListener('dragover', stop, false)   // 不阻止则 drop 不触发
  document.addEventListener('drop', function (e) {
    if (!isFileDrag(e)) return                        // 非文件拖放（文本/链接）不干预
    if (e.defaultPrevented) return                    // 官方链路已消费，交给它
    stop(e)
    // 可选档：1.5s 轻提示「请切换到对话页再拖入文件」；最小档可直接静默
  }, false)
})())
```

设计要点：

- **判据 `defaultPrevented`**：官方处理器 `event.preventDefault()` 后，同 target 同
  phase 的其余监听仍会收到事件，但 `defaultPrevented` 已置位 → 安全网精准让位，
  不破坏官能遮罩、`dropEffect` 与 `onAddFiles`。
- **dragover 一律阻止**：不阻止 `dragover` 则 `drop` 根本不触发（浏览器口径），
  且官方遮罩的 `dropEffect=copy/none` 由官方自己设置，安全网不干预。
- **只认文件拖放**：拖选中文本 / 链接等 `types` 不含 `Files` 的拖放完全不碰，
  与官方一致。
- **提示两档**：最小档静默阻止；完整体验档挂一个 1.5s 自绘小提示（DOM + 定时器，
  随页面卸载自然消失，不进任何持久状态）。实施时按工作量二选一，**默认最小档**。
- 单测/静态面：纯字符串逻辑，无令牌依赖，`gen-init` 的令牌完备性校验不受影响。

### 4.3 loading 启动页（S3）

`ui/loading.html` 加同样最小防默认（拖文件不导航、不报错）。启动期没有会话，
「排队等就绪再附」不做（见 §7）。

### 4.4 行为规格（修后与 Web 端对齐）

| 场景 | 修后桌面端行为 |
|---|---|
| 对话页拖图片（png/jpg/webp/gif，部署允许的 mediaType） | 官方 DragMask 遮罩 → 松手 → composer 缩略图 → 发送 |
| 拖非图片文件（PDF/文本等） | 进入文件卡（按部署配置） |
| 单条消息图片数 / 单图大小 / 总大小超限 | 官方 toast（`maxImagesPerMessage` / `maxImageBytes` / `maxMessageImageBytes`） |
| 生成中（busy）/ 会话锁定 / 子代理会话视图拖文件 | DropOverlay disabled 态（不可用文案），松手无副作用 |
| 拖选中文本 / 图片链接（非 Files） | 无遮罩、无副作用 |
| 轨迹 / 用量 / 设置页拖文件 | 安全网阻止默认导航，SPA 不炸（+轻提示，档位见 §4.2） |
| loading 页拖文件 | 静默忽略（§4.3） |
| 窗口顶部 36px 空白拖动、双击空白最大化、窗控三键 | 不受影响（mousedown 手势与 OLE 拖放正交） |

### 4.5 回归与兼容性风险矩阵

| 项 | 结论 |
|---|---|
| 失去 `tauri://drag-drop` 窗口事件 | 本壳零监听（全仓 grep 实证），零损失 |
| WebView2 版本兼容 | 禁用 handler 后**不再调用** `SetAllowExternalDrop(false)`；`AllowExternalDrop` 默认 true，老 Runtime 无依赖 |
| 窗口拖动 / 标题栏 / 最大化同步 | 正交（Mousedown 手势 vs 拖放数据传递，两套机制） |
| 桌宠 / 托盘 / hash 命令通道 | 正交（原生窗口 + URL hash） |
| cookie 注入、401 兜底、主题注入 | 正交（安全网仅增 document 拖放监听，不动既有逻辑） |
| CSP | `tauri.conf.json` `csp: null`，无新增限制 |
| DSH 升级 | 壳侧仅一行 Rust + 一片注入；官方链路自演进 |

## 5. 实施顺序

- **S1**：`main.rs` 加 `.disable_drag_drop_handler()`（§4.1）。
- **S2**：`themes/src/09-dropguard.js` 新片 + `MANIFEST.json` order 追加 +
  `npm run gen-init`。
- **S3**：`ui/loading.html` 最小防默认（§4.3）。
- **S4**：实机验收（§6 十项）+ smoke §0b + `node ../scripts/verify-all.mjs desktop`。
- **S5**：文档回填——本文件改「已实施」、`README.md` 小节、`CHANGELOG.md` 实装条目、
  `TODO.md` 勾选。

## 6. 实机验收清单

1. 对话页拖 1 张 PNG → 遮罩出现 → 松手 → composer 缩略图 → 发送成功、模型收到图
2. 多文件混合拖入（图片 + 文本/PDF）→ 各自入轨
3. 生成中拖文件 → 拒绝态遮罩、松手无副作用
4. 子代理会话视图拖文件 → 拒绝态
5. 拖选中文字 / 拖链接 → 完全无反应（无遮罩无导航）
6. 轨迹页 / 用量页 / 设置页拖文件 → **SPA 不被导航走**，有轻提示（完整体验档）
7. loading 页拖文件 → 无导航、无报错
8. 超大图（> `imageLimits.maxImageBytes`）→ 官方 toast 报错
9. 窗口顶部空白拖动、双击最大化、三主题切换、桌宠点击/拖动回归
10. `verify-all desktop` + smoke §0b 回归

## 7. 不做什么 / 延期

- **不做方案 B（OLE 事件桥）**——仅当 S1 实机失败（个别 WebView2 版本仍拦截）时启动。
- 不自建限额判定 / 错误文案（单一事实源在官方 `intakeFiles`）。
- loading 页不做「拖文件排队、就绪后自动附」（启动期无会话，语义不成立）。
- 不做断点续传（官方已知限制：失败重试从首字节开始）。
- 不动 DSH 本体、不打补丁。

---

## 证据出处（核对日期 2026-09-22，本机安装目录）

- `…/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-attachment/lib/client.js`
  —— document 级 DnD 实现与 DropOverlay
- `…/@deepseek-ai/dsh-client-ui-conversation/lib/client.js` L15920–15942
  —— `intakeFiles` / `canAcceptDrop`
- `…/@deepseek-ai/dsh-client-file-upload/README.zh.md` —— `ctx.fileUpload.upload` 链路
- `~/.cargo/registry/src/*/tauri-runtime-2.11.3/src/webview.rs` L349/L515 —— 默认 true
- `~/.cargo/registry/src/*/tauri-runtime-wry-2.11.4/src/lib.rs` L4862–4889 —— handler 接线
- `~/.cargo/registry/src/*/wry-0.55.1/src/webview2/mod.rs` L150–158 + `webview2/drag_drop.rs`
  —— `SetAllowExternalDrop(false)` + `RegisterDragDrop`
- `~/.cargo/registry/src/*/tauri-2.11.5/src/webview/mod.rs` L971–976 —— 官方 `disable_drag_drop_handler()` 与注释
- 本仓 `src-tauri/Cargo.lock`（tauri 2.11.5 / tauri-runtime-wry 2.11.4 / wry 0.55.1）、
  `src-tauri/src/main.rs`（主窗 `WebviewWindowBuilder`，现无任何 drag-drop 处置）、
  `src-tauri/tauri.conf.json`、`themes/src/MANIFEST.json`
