# 跨线规划 · 官方桌面端可借鉴点的落地（2026-09-25）

> 状态：**已实施完成（2026-09-25 当晚）** —— W0 / W1 / W2 / W3 / W4（含 W4.2、W4.3）/ W5 / W6 全部落地，
> 另追加**契约 v1.1 受控写能力**。用户拍板结论：W1 做、W2 做、「关闭=隐藏到托盘」做、W6 做、W4.2 排 T2.2 之后做。
> 上游分析：[官方 DSH 桌面端实测分析](../dsh-platform/dsh-official-desktop-analysis-2026-09-25.md)（28 条可借鉴点，逐条附行号证据）。
> 本稿回答的是："那 28 条里，**哪些该做、以什么顺序做、落在哪个文件、怎么验收**"。

## 实施结果（2026-09-25 收口）

| 期 | 状态 | 关键交付 | 验证 |
|---|---|---|---|
| W0 | ✅ | `__MIA_THEME__` 断链 / hash **字段级**读写 / 死代码清理 / 注入产物三道自校验 | +16 例闸门 |
| W1 | ✅ | 契约 v1（读 + 订阅）；T1.1 spike 结论：`__DSH_BOOT_READY__` **不可**用作闸门（后端注入即 resolve），正确首帧通道是 `webserver/index-inject` | +11 例 |
| W2 | ✅ | `diag.rs`（诊断报告 + 进程内看门狗 + 隐藏态阈值放宽）/ `recovery.rs`（原生恢复对话框 + sanitizeProfile + 分级停机）/ Job Object 孤儿回收 | `cargo test` 78 例 |
| W3 | ✅ | 关闭 = 隐藏到托盘（一次性原生确认 + marker 可重放）；失败页加「恢复选项」入口 | T3.2 **降级**（见下） |
| W4 | ✅ | W4.1 kind 白名单 / **W4.2 材质分层**（壳说事实、页面选分支，消除双层模糊）/ W4.3 窗口底色回传 | +18 例（跨 appearance 线） |
| W5 | ✅ | 自更新**降级方案**：只查、只提示、只打开下载页（零新依赖，走系统 curl） | +5 例 |
| W6 | ✅ | 10 个自研插件挂进 `~/.dsh/profiles/desktop`（含备份与回滚命令） | 依赖面已核；**需重启官方桌面端生效** |
| 追加 | ✅ | 契约 **v1.1** 受控写能力（事件驱动，不新增 hash 写者） | +4 例 |

**总账**：`verify-all` 七线全绿、desktop **29/29**（起点 23）；`cargo test` **78 passed / 0 failed**（起点 35）；
desktop 单测 **120 例**（起点 63）。实机验收清单见 [`smoke-test-matrix.md`](smoke-test-matrix.md) §3.1。

**未做 / 降级（如实记录）**：

1. **T3.2 的"活动任务"维度降级**：调研确认 DSH 只暴露 `/api/file` 与 `/api/remote.mux`（WS RPC），
   **没有**可用的任务状态 HTTP 端点；继续做需先实现 DSH 的 WS RPC 客户端。当前保留"后端存活 + 外部客户端仍在用"两个既有维度。
2. **W4.2 之外的原生材质深化**（vibrancy 调参等）未做 —— Win11 上 Mica 已生效，进一步改动属视觉重活，需另行拍板。
3. **W5 不做静默安装**（本即方案边界）：缺签名保管链 / CI / 安装前任务准入，静默安装会打断用户正在跑的会话。

---

## 0. 摘要：一个结论、三条路线、一处需要换落点的借鉴

**结论** `[实测]`：DSH 前端（本机 npm 版 `@deepseek-ai/dsh-web-frontend` **0.1.7-rc.2**）**已内置官方桌面端的通用 boot 契约消费点**——

```js
// dist/assets/index-Q6zc2uHV.js 实测（minified，节选）
async run(e) {
  await globalThis.__DSH_BOOT_READY__?.promise;          // ① 可选：存在就等
  const o = globalThis.__ModuleLoader__;                  // 后端注入的引导门面
  const s = globalThis.__DSH_TRANSPORT__;                 // ② 可选：传输层描述
  ...
}
const uo = globalThis.dshDesktopBoot;                     // ③ 可选：桌面 boot 桥
if (uo !== undefined) {
  const o = globalThis.__DSH_BOOT_READY__;
  if (o === undefined) throw new Error("desktop web: boot readiness is missing");
  uo.ready().then(async ({ injections, streamBaseUrl }) => { ... });   // ④ 壳交付注入物
}
```

也就是说：**本项目不需要改 DSH、也不需要发明自己的桥，只要在正确的时机注入契约要求的全局对象，DSH 前端就会按"桌面端语义"工作**。这是本规划最大的杠杆。

**但有一个反直觉的边界** `[实测]`：npm 版前端**只消费 4 个契约**（`__DSH_BOOT__` / `__DSH_BOOT_READY__` / `__DSH_TRANSPORT__` / `dshDesktopBoot`）。官方桌面端那套"目录选择器 / 宿主路径 / locale / 平台账号"注入物（`__DSH_DIRECTORY_PICKER__`、`__DSH_HOST_PATHS__`、`__DSH_LOCALE__`、`dshPlatform`、`dshOnboarding`）**在 npm 版的 bundle 里根本不存在消费点**——它们是官方**特制前端构建**里的东西。所以本项目即使注入它们，前端也不会有任何反应；这类能力的消费者只能是**我们自己的插件**。

**三条路线**：

| 路线 | 内容 | 收益 | 成本/风险 | 建议 |
|---|---|---|---|---|
| **A · 协议层** | 自定义协议固定 origin + 静态直读 + 动态代理（复刻 `dsh-app://app`） | 端口/cookie 不出壳、首屏不等后端 | **高**（见 §1.3 + §4.5 第 2 条：`SameSite=Strict` cookie、五处 origin 硬编码、WS 无法走 Tauri 自定义协议） | **远期**，先不做 |
| **B · 契约层** | 对齐官方**能力契约**：`protocolVersion` 桥 + 能力探测降级 + 注入物收敛到官方 6 种 kind（~~`__DSH_BOOT_READY__` 闸门~~ 已证不可用，见 §2.1） | 桥能力有版本、可探测可降级；注入物有统一格式；与官方语义同源 | **低**（纯注入层，不含闸门） | **主推，W1** |
| **C · 可靠性/体验** | 崩溃与挂起取证、退出编排、关闭到托盘、准入锁 | 对症本项目 **P0 挂起无法取证**等真实痛点 | 中低（独立于 A/B，可并行） | **主推，W2/W3** |

**一个精确化的发现（官方那条不是全废，但落点要换）** `[实测]`：官方 P0 的"渲染层实测调色板 → 回传原生标题栏"（`setTitleBarOverlay`）在本项目**标题栏维度不适用**——主窗口是 `.decorations(false)` 无边框自绘（`main.rs:1675`），没有原生标题栏可染色。**但同一机制在本项目有等价落点，而且是最低成本项**：窗口底 / Mica 回退色目前是 Rust 侧**硬编码两档**——

```rust
// main.rs:1652-1655（窗口创建时算一次）
let bg = match theme.as_str() {
    "kurkuriel" => Color(247, 244, 241, 255),   // 浅
    _           => Color(12, 11, 17, 255),      // 深
};
```

运行期切主题（三主题）或外观线换皮肤/壁纸时**它不会更新**；Win10（Mica 不可用、`apply_mica` 回退实色，`main.rs:1464`）下会露出旧主题的实色底。把"渲染层实测实际底色 → `eval` 回传 → 更新窗口背景"补上，正是官方机制的本地化用法，且 `push_pet_state` / `push_max_state`（`main.rs:954-974`）已是现成范式、**零新依赖**。⇒ 列入 W4（T4.3），**不进**不做清单。

---

## 1. 技术地基（本轮实测，决定一切方案取舍）

### 1.1 DSH 前端契约面 `[实测]`

| 契约 | 形态 | 前端行为 | 本项目可用性 |
|---|---|---|---|
| `__DSH_BOOT_READY__` | `{ promise, resolve, reject }`（`Promise.withResolvers()`） | `await __DSH_BOOT_READY__?.promise`——**存在就等，不存在就跳过** | ✅ 可直接用（拿"启动时序闸门"） |
| `dshDesktopBoot` | `{ ready(): Promise<{injections, streamBaseUrl}>, failed(msg) }` | 存在则走桌面分支：要求 `__DSH_BOOT_READY__` 必须存在，调 `ready()` 后逐条应用 injections | ⚠️ 可用，但一旦注入就**必须**实现完整语义 |
| `__DSH_TRANSPORT__` | `{ loadBundle?, ... }` | 传给模块加载器的 `loadBundle` 钩子 | ⚠️ 可用于拦截/改写插件 bundle 加载 |
| `__DSH_BOOT__` | 引导描述 | 传给 `__ModuleLoader__.create()` | ❌ 后端负责，壳不该碰 |

**injections 的官方 kind 白名单** `[实测]`（前端 `eM()` 逐条 switch，未知 kind 直接抛错）：

```
"global"        → globalThis[name] = value          ← 全局变量注入（唯一能注入 BOOT/TRANSPORT 的途径）
"script"        → 内联 <script>（head/body）
"script-src"    → await loadScript(src)
"script-preload"→ 占位（当前无操作）
"style"         → <style>
"html"          → insertAdjacentHTML（head/body）
default         → throw new Error("web boot: unknown index injection row")
```

> 这条对本项目 appearance 线直接有用：**外观线的 `webserver/index-inject` 只要产出上述 kind，就能被前端原生消化**，不需要自己写注入应用逻辑。

### 1.2 Tauri 侧的能力与硬约束 `[实测]`

| 项 | 事实 | 出处 |
|---|---|---|
| 自定义协议 origin | Windows 上是 `http://<scheme>.localhost/`（可用 `useHttpsScheme` 切 https） | `tauri-2.11.5/src/app.rs:2127`、`manager/webview.rs:251` |
| 请求头拦截 | **无** WebView2 层的 `onBeforeSendHeaders` 等价物（官方 Electron 靠它改写 WS 的 Origin/Cookie） | Tauri 2 API 面 |
| WebSocket | **不能**走自定义协议 handler | 协议模型 |
| 现有依赖 | `tauri`（`tray-icon`）+ `tauri-plugin-single-instance`，无 updater | `src-tauri/Cargo.toml` |
| 窗口 | `.decorations(false)` + `.shadow(true)` + `.initialization_script(&init)` + `.on_page_load()` 二次 eval | `main.rs:1662-1691` |
| 注入产物 | `themes/src/*.js` 按 `MANIFEST.json` order 拼接 + `themes/*.css` 内联 → `src-tauri/injected/theme-init.js` | `scripts/build-init.mjs:69-101` |
| 桥通道 | URL hash（`history.replaceState`）+ Rust `eval`（`main.rs:478, 972`） | `design/ARCHITECTURE.md:22` |

### 1.3 本项目的既有硬约束 `[实测]`

1. **鉴权 cookie 是 `SameSite=Strict`**（`themes/src/00-boot.js:38`），cookie 名 `dsh-auth-<sha256(authority)>`，authority 硬编码 `127.0.0.1:3080`。⇒ 一旦页面 origin 不再是 `http://127.0.0.1:3080`，cookie **既不会自动携带、也不会被注入层写入**（`00-boot.js:33` 有 `location.origin !== 'http://127.0.0.1:3080'` 直接 return 的守卫）。
2. **前端产物在本机可用**：`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-web-frontend/dist/`（`index.html` + `assets/`，资源全是相对路径 `./assets/...`）——**方案 A 的静态资源来源现成**。
3. **后端不做 Origin 校验**（`dsh-client-connection` 全量 grep 无 origin 白名单逻辑）——比官方 Electron 宽松（官方是自己加了 `Origin === dsh-app://app` 校验）。⇒ 方案 A 的障碍不在服务端，在**浏览器 cookie 策略**。
4. 无边框自绘标题栏 ⇒ 无原生标题栏可染色（见 §0）。

---

## 2. 方案取舍

### 2.1 路线 B（契约层）——为什么值得做

现状是"hash 单通道 + `on_page_load` 二次 eval"，`design/TODO.md:157` 曾记为"正式 IPC 替代 hash（**收益有限**，hash 已验证可靠）"。本轮实测把收益重新定位了——**收益不在"通信可靠性"，而在"启动时序与能力协商"**：

1. **首帧"就绪"语义**：初稿以为 `__DSH_BOOT_READY__` 能当壳的启动闸门——**本轮两处实测把它否掉了**：

   > ❌ **闸门不成立（一：后端抢先 resolve）**：官方后端 `dsh-host-webserver`（本机 0.1.7-rc.2 实测）在 index.html 末尾注入
   > ```js
   > const READY_MARKUP = "<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>";
   > ```
   > 源码注释写明它"**creates and resolves it in one statement, because every row is already in the document text**"。我们在 document_start 用 `??=` 抢先创建也没用——后端只是**复用我们的 deferred 然后照旧立刻 resolve**。执行序：我们的 `initialization_script` → … → body 末尾 tail script（**后端 resolve**）→ head 里 module 入口执行 → `DOMContentLoaded` → 我们的 `onReady()`。**DSH 前端永远跑在我们的 `onReady()` 之前**，"先无标题栏 → 后补栏"的窗口依旧存在。
   >
   > ❌ **闸门不成立（二：本项目注入层没有"就绪"概念）**：`08-ready.js:39-64` 是"`DOMContentLoaded` + 1s 巡检 + 固定超时重试"，与 DSH 侧**零握手**；`__DSH_BOOT_READY__` 在 `themes/src/` 全片零命中。
   >
   > ✅ **正确通道是 `webserver/index-inject`（后端注入）**：注入行写在 index.html 文本里（head 行紧跟 `<head>`、body 行紧跟 `<body>`），**解析期即生效、早于 module 入口**——这正是 appearance 线首帧防闪色的既有做法（`appearance/index.js:128-134` push `script`(body) + `style`(head)；`design/2026-09-11-appearance-settings-plan.md:620` 已逐字确证 6 种行与 `__DSH_BOOT_READY__` 尾巴形态）。
   >
   > ⇒ **改判**：`__DSH_BOOT_READY__` 只有在**壳自己也走桌面分支**（即由壳提供 `injections`，官方语义要求该全局必须存在）时才真正握在壳手里——那是方案 A 的量级。**W1 因此从"闸门实现"降级为"通道评估 + 契约桥"**（见 T1.1/T1.2）。

2. **注入物有了官方格式**：injections 的 6 种 kind 是官方契约（`global`/`script`/`script-src`/`script-preload`/`style`/`html`，未知 kind 前端直接抛错）。它对本项目的现实用法是**经 `index-inject` 通道**（由后端渲染进 HTML 文本），而不是"壳交付"；本项目后续"往页面塞东西"的需求（外观皮肤、壁纸、boot splash、SSH 胶囊探测……）都可收敛到这一个格式上。
3. **能力有版本号**：`protocolVersion` 让"壳能力"可演进、可探测、可降级——这正是本项目七线插件长期需要的（当前每个插件各自猜环境）。
4. **与官方语义同源**：将来若要把本项目插件也挂到官方桌面端（见 §6 W6），同一套契约两边通吃。

### 2.2 路线 A（协议层）——为什么先不做

复刻 `dsh-app://app` 需要**同时**解决：① 壳内自建 HTTP 反向代理（含流式/SSE）；② 壳内自建 WS 代理（Tauri 无请求头拦截，无法像 Electron 那样只改 Origin/Cookie）；③ cookie 代持与改写（`SameSite=Strict` + authority 硬编码）；④ 注入层 origin 守卫重写（触碰历史上出过"黑屏"的鉴权链）。**收益（端口不外露、首屏不等后端）真实但有限**，而代价是动鉴权链——本项目最敏感的资产。

> `[推断]` 若将来确要做，**最小可行切片**是先只做"静态资源直读"（把 `index.html`/`assets` 从本机 `dsh-web-frontend/dist` 经自定义协议提供），保留 API/WS 直连 3080——但那样 origin 仍会变，cookie 问题照旧，**所以这个切片并不成立**；真正的可行性取决于"壳内 WS 代理 + cookie 代持"这一个工程。建议届时单独立项评估。

### 2.3 路线 C（可靠性/体验）——对症哪些真实痛点

| 官方机制 | 本项目对应痛点（有据） | 落点 |
|---|---|---|
| 崩溃报告（本地留档 + renderer console 尾 + 宿主诊断 + 保留 10 份） | `design/TODO.md:15-35`：**偶发「全黑无响应」4 次挂起，WER 通道已榨干**（`Report.wer` 无 dump、`LoadedModule entries: 0`），结论是"需进程内看门狗或外部抓 dump" | 新增 `src-tauri/src/diag.rs` |
| 致命恢复三按钮（退出/重启/**禁用第三方插件后重启**） | 同上：挂起后只能任务管理器；本项目插件密集（七线），"停用插件重启"是有效的降损手段 | `main.rs` + Tauri dialog |
| 关闭=隐藏到托盘 + 首次确认 marker | `design/TODO.md:106`「主窗口最小化到托盘（关闭=退出保持现状）」 | `main.rs` 关闭事件 |
| 退出前工作量探针（`quit-inspection`）+ fail-safe 文案 | 本项目已有"关闭 ≠ 无条件停后端"（探测外部客户端），但**没有"是否有任务在跑"**这一维 | `main.rs` + 后端探测 |
| 优雅停机分级（请求 → 10s → SIGTERM → 5s → SIGKILL） | 缺口**只在壳异常退出/裸跑 `dsh web`**：正常关壳已由 `main.rs:277-298` 的 `taskkill /PID <pid> /T /F` 覆盖；sidebar 全仓仅一次 `pty.kill()`（`index.js:903-907`），**无分级、无 Job Object、无父死回收**；ssh 是远端连接，天然无信号阶梯 | 见 §4 T2.4 |
| 更新/危险操作准入锁（503 + 排空在途请求） | 目前无自更新；**仅在决定做自更新后才有意义** | 见 §6 W5 |

---

## 3. 落地分期总览

```
W0·顺手修复 ✅ 已完成（+16 例闸门）
  ├─ T0.1 __MIA_THEME__ 断链修复（壳写了、渲染层没人读 → loading 页主题错置）
  ├─ T0.2 hash 双写者竞态修复（改为**字段级**精确增删）
  ├─ T0.3 死字段/死代码清理（notifyPet / PET_MODES / capability "pet" / MANIFEST.slices）
  └─ T0.4 注入产物自校验（JSON.parse + 键集一致 + 漏登记 + 写盘字节一致）
        │
W1·契约层 ✅ 已完成（+11 例；T1.1 从"闸门实现"改判为"通道评估"并给出结论）
  ├─ T1.1 首帧通道 spike → 结论：BOOT_READY 不可用作闸门，正确通道是 webserver/index-inject
  ├─ T1.2 window.miasakiDesktop 桥契约 v1（注入层 + 文档）
  ├─ T1.3 契约闸门测试（版本 / 降级 / 时序 / 产物自校验）
  └─ T1.4 契约文档 + 版本协商约定
        │
W2·取证与可靠性 ✅ 已完成（cargo test 78 例）
  ├─ T2.1 诊断报告（格式对齐官方，本地留档 + 保留最近 10 份）
  ├─ T2.2 进程内看门狗（独立线程心跳；**隐藏/最小化时阈值放宽到 90s** 防 WebView2 节流假报）
  ├─ T2.3 原生恢复对话框（退出/重启/停用插件重启）
  └─ T2.4 优雅停机分级 + Job Object 孤儿回收
        │
W3·退出与托盘 ✅ 已完成（T3.2 降级）
  ├─ T3.1 关闭 = 隐藏到托盘 + marker（删文件即回到首次态，可重放）
  ├─ T3.2 退出前工作量探针 —— **降级**：只剩"后端存活 + 外部客户端"两维（DSH 无任务状态 HTTP 端点）
  └─ T3.3 托盘菜单（本次新增「生成诊断报告」「检查更新」）
        │
W4·表现层对齐 ✅ 已完成（+18 例，跨 appearance 线）
  ├─ T4.1 injections 对齐官方 kind 白名单
  ├─ T4.2 材质分层（壳广播原生材质事实 → 外观线据此撤掉页面侧模糊）
  └─ T4.3 窗口底/Mica 调色板回传（`bg=` 通道，仅 Mica 未生效时消费）
        │
W5·分发 ✅ 已完成 —— 降级方案（只查 / 只提示 / 只打开下载页，不做静默安装）
W6·互操作 ✅ 已完成 —— 10 个插件挂进官方 desktop profile（需重启桌面端生效）
追加·契约 v1.1 ✅ 受控写能力（theme.set / window.controls，事件驱动、不新增 hash 写者）
```

**顺序约束**：W1 → W4 有依赖（injections 契约先立）；W1/W2/W3 相互独立，可任意并行；W5 依赖 W2 的准入锁语义；W6 与全部无关（只改 `~/.dsh/profiles/desktop`）。

---

## 4. 任务分解（逐条可执行）

> **本稿已实施完毕**：以下逐条细则是**实施前的设计依据**，刻意保留原貌以便回溯"当初为什么这么定"。
> 实际交付、与设计有出入之处（如 T3.2 降级、分区序号调整），以上方「实施结果」表与各线
> `design/CHANGELOG.md` 为准。

### W0 · 顺手修复（零风险，建议立刻做）

这两处是逐行勘察中**发现的既有缺陷**（与"借鉴官方"无直接关系），但成本极低、收益明确，且都会干扰后续契约改造——一个制造主题时序噪声，一个破坏"hash 单写者"这一前提。

| 任务 | 落点 | 问题（实测） | 做法 | 验收 |
|---|---|---|---|---|
| **T0.1** `__MIA_THEME__` 断链 | `main.rs:1646-1649` + `themes/src/02-core.js:87-93` | 壳注入了 `window.__MIA_THEME__`，但 `themes/src/` **全片零处读取**；`current` 只来自 `localStorage` + URL 参数。两页不同源（`tauri.localhost` vs `127.0.0.1:3080`）⇒ loading 页 `localStorage` 为空 → 属性被置 `pure`，而该页 `:root` 默认色板是 zafkiel（`ui/loading.html:22-31,46-57`） | **二选一**：① 让渲染层真正读 `__MIA_THEME__`（优先级高于 localStorage/URL，与 `design/themes.md:51` 的声称对齐）；② 删掉该注入与文档声称。**推荐 ①**——它正是"启动画面与 DSH 页同主题"的正解 | 单测：三来源优先级；实机：loading 页与进入后的 DSH 页主题一致、无闪窗 |
| **T0.2** hash 双写者竞态 | `themes/src/05-sensors.js:2-10` | `petHashCmd()` 在 **1600ms 后无条件把 hash 清成只剩 `miasaki-theme`**（`:6-8`），会清掉 `int/act/wait/pet/diag`，也可能清掉并发写者刚写的 `cmd`（`02-core.js:53-55` 自称"hash 单写者"实际不成立；插件 `plugins/dsh-pet-panel/lib/client.js:19-33` 也在追加） | 把"清写"改为**按字段精确移除**（只移除自己写的 `cmd`/`seq`，其余保留），并保持 `seq` 去重语义（Rust `main.rs:1241`） | 单测：并发写入后字段不丢；实机：连续点窗控 / 切主题 / 桌宠状态上报互不干扰 |
| **T0.3** 死字段与死代码清理 | `main.rs:931`、`themes/src/02-core.js:74-77`、`capabilities/default.json:5`、`themes/src/MANIFEST.json:14-51` | ① `move=`/`move=reset` 渲染层**已无写者**（拖动改走 Tauri `start_dragging`，`06-titlebar.js:87-90`）；② `02-core.js:74-77` 调**未注册**命令 `invoke('set_pet_mode')` 且被 `.catch()` 静默吞掉（注册表 `main.rs:1607-1618` 仅 10 个命令）；③ capability 的 `windows` 里 `"pet"` 已无对应 Tauri 窗口（桌宠是裸 Win32 窗）；④ `MANIFEST.slices` 行段已过期（`:52` 自承认） | 逐项删除或标 deprecated；`move=` 若要留兼容期，先在 Rust 侧显式标注 | `verify-all desktop` 全绿；`git grep "move="` 只剩文档 |
| **T0.4** 注入产物自校验 | `scripts/build-init.mjs:91-98` | 产物 `window.__MIASAKI_STYLES__=<JSON>;\n<runtime>` **无自校验**；官方同类 manifest 恰恰踩过"尾部 `}` 被截断、`JSON.parse` 直接失败"的坑（分析报告 §1.2） | 生成后 `JSON.parse` 校验样式 JSON，并校验分片数与 `MANIFEST.order` 长度一致，失败即 `exit(1)` | 故障注入：故意截断产物 → 构建失败且报明原因 |

### W1 · 契约层与首帧时序

| 任务 | 落点 | 做法 | 验收 |
|---|---|---|---|
| **T1.1** 首帧通道 spike（原"闸门"已证不可用，见 §2.1） | 注入层 +（视结论）appearance 线 `index-inject` | ① **spike 记录时序**：`initialization_script`（document_start）执行时 `document.documentElement` 是否已可用、能否插入 `<style>`/占位容器——决定"壳能否自己做到首帧"；② **评估三条替代路径**：(a) 把"必须首帧出现"的元素改走 `index-inject`（与 appearance 线共用通道，但注入物出自 DSH 侧插件，壳的标题栏需要插件载体）；(b) 壳只在 document_start 做 `html` 属性级工作，接受 `DOMContentLoaded` 补栏；(c) 走桌面分支自持 injections（= 方案 A 量级，**不建议**）；③ 产出结论与推荐 | spike 记录含实测打点（`performance.now()`）；结论写入 `design/desktop-contract.md` |
| **T1.2** 桥契约 | 同 T1.1 分片，暴露 `window.miasakiDesktop = { protocolVersion: 1, ... }` | 只暴露本项目**确实实现**的能力（探测式扩展，缺失即降级）；非主帧/非 3080 origin 只给 `{ protocolVersion: 1 }` 空壳（对齐官方降级策略） | 单测：能力探测降级；非目标 origin 时空壳 |
| **T1.3** 就绪派发 | `main.rs`（`on_page_load` 附近） | 保留现有"`on_page_load` 命中 3080 时 eval INIT_SCRIPT"；就绪信号由注入层自行 resolve（Rust 不参与，减少跨进程时序） | 实机：冷启动无白屏、无闪色、进入界面耗时对比基线不劣化 |
| **T1.4** 契约文档 | `dsh-miasaki-desktop/design/desktop-contract.md`（新） | 写清 `protocolVersion` 语义、能力表、降级约定、与官方 `dshDesktop*` 命名空间的关系 | 文档评审 |

> **风险与回滚**：T1.1 是"劫持启动时序"，若 resolve 缺失/延迟会**白屏**。硬要求：① 兜底定时器与 try/catch 双保险；② 单测覆盖三条路径；③ 保留一个 `localStorage` 开关（或构建期常量）可一键退回"不注入 BOOT_READY"的现状。

### W2 · 取证与可靠性（对症 TODO P0）

| 任务 | 落点 | 做法 | 验收 |
|---|---|---|---|
| **T2.1** 诊断报告 | 新增 `src-tauri/src/diag.rs` | 格式对齐官方：事实头（时间/版本/平台/Electron 或 WebView2 版本/locale）+ `--- error ---` + `--- renderer console (error level, oldest first) ---` + `--- host tail ---`；**保留最近 10 份**；写盘 0600 | 单测：格式化 + 轮转（故障注入造 12 份） |
| **T2.2** 看门狗 | `diag.rs` + `main.rs` 启动处 | **独立线程**（非 UI 线程）定期检查"UI 线程心跳时间戳"（UI 侧定时喂），超阈值（如 5s）即落盘现场（线程栈可用 `windows` crate 采集本进程快照或退化为"心跳缺失时长 + 最后 hash 状态 + pet.log 尾部"） | 实机：人为阻塞 UI 线程 → 生成报告；正常路径零开销（心跳写原子变量） |
| **T2.3** 恢复对话框 | `main.rs` | 原生对话框三按钮：退出 / 重启 / **停用第三方插件后重启**（先把 `cordis.patch.yml` 备份为 `.bak-<ts>`，再把 bundles 重置为基线——对齐官方 `sanitizeProfile` 语义） | 实机：三按钮行为正确；备份文件可回滚 |
| **T2.4** 停机与孤儿回收 | `main.rs`（壳）+ 可选插件侧 | **两级**：① **Job Object**（`CreateJobObject` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，把自拉后端与 pty 子进程纳入）——壳崩溃时由 OS 回收整棵进程树，这是官方 `SIGTERM→SIGKILL` 阶梯在 Windows 上更根本的等价物；② 正常关闭时的分级：先请求退出 → 等 10s → 强杀 → 等 5s → 再强杀，并记录未退出 PID | 实机：见 §5 L3 新增行；`tasklist` 核对无孤儿；强杀壳进程后子进程树自动消失 |

### W3 · 退出与托盘

| 任务 | 落点 | 做法 | 验收 |
|---|---|---|---|
| **T3.1** 关闭=隐藏 | `main.rs` 关闭事件 | 首次关闭弹一次确认 + 写 marker（如 `%USERPROFILE%\.dsh\miasaki-desktop\background-close-confirmed`）→ 隐藏到托盘；托盘"退出"才是真退出 | 实机：删 marker 可重放首次确认；二次关闭直接隐藏 |
| **T3.2** 退出探针 | `main.rs` | 真退出前探测：① 自拉后端是否有活动任务（复用 DSH 侧会话状态或退化用 HTTP 探测）② 外部客户端是否仍在用（**已有**） | 实机：跑着任务时退出有确认；空转时静默退出 |
| **T3.3** 托盘增强 | `main.rs` | 菜单随语言 relabel、tooltip 用产品名、点击聚焦 | 实机目检 |

### W4 · 表现层对齐

| 任务 | 落点 | 做法 | 验收 |
|---|---|---|---|
| **T4.1** injections 格式 | `dsh-miasaki-appearance/`（index-inject 产出侧） | 对齐 §1.1 的 6 种 kind；未知 kind 会被前端直接抛错 ⇒ 产出侧加白名单校验 | 单测：kind 白名单；实机：外观首帧无闪色 |
| **T4.2** 材质分层 | `themes/*.deco.css` + `main.rs` | 评估后再定：本项目已有 Mica 试点（曾因挂起被 A/B 降级，TODO:19-28 已推翻 Mica 为嫌疑）。若重启此方向，**必须**与 T2.2 看门狗同期上线以便取证 | 实机 + 长稳观察 |
| **T4.3** 窗口底/Mica 调色板回传 | 注入层（新增回传段）+ `main.rs`（消费端） | 渲染层实测当前实际底色（随主题/皮肤/壁纸变化）→ `eval` 回传 → Rust 更新 `set_background_color`（或 Mica tint）。**恒不覆盖已有值 semantics**：仅在颜色确实变化时更新；首次回传前的兜底仍是现有两档硬编码 | 实机：三主题 + 外观皮肤切换后，Win10 回退底与页面严格一致；切主题无闪色；单测覆盖回传解析与"无变化不更新" |

### W5/W6（可选）

- **W5 自更新**：仅做"检查 + 提示 + 打开下载页"（零静默安装），或 Tauri updater（需签名密钥 + CI + 准入锁语义）。
- **W6 互操作**：把七线插件挂进 `~/.dsh/profiles/desktop`（版本同号、无 peer 阻塞，详见分析报告 §9）。
  **✅ 已实施（2026-09-25）**：`profiles/desktop/package.json` 挂入 10 个自研插件（5 个 `link:` miasaki 线 + 5 个 `file:` desktop/plugins），`pnpm install` 落盘 5 包（618ms，零下载——store 命中）。
  依赖面已核：8 个插件零传递依赖，`dsh-canvas` / `dsh-sidebar` / `dsh-ssh` **自带 `node_modules`**（共享祖先缺的 `@xterm/*`、`ssh2` 正好由插件目录物理提供）。
  **回滚**（一条命令，随时可用）：
  ```powershell
  cd $env:USERPROFILE\.dsh\profiles\desktop
  Copy-Item package.json.bak-20260925-w6 package.json -Force
  Remove-Item node_modules, pnpm-lock.yaml -Recurse -Force
  ```
  **生效条件**：需重启官方桌面端（当前 host 进程仍持旧 profile 树）。**未重启前不改变任何行为**。
  **注意**：`dsh-pet-panel` 在官方桌面端里是"上报但无人消费"（桌宠是 Tauri 壳的资产，官方壳不解析 `miasaki-*` hash），保留它只为将来互通，不影响官方壳行为。

### 4.5 实施注意：Rust 侧的五个硬约束（来自壳层逐行勘察）`[实测]`

| # | 约束 | 对落地的影响 |
|---|---|---|
| 1 | **`panic = "abort"`**（`Cargo.toml:35`），且启动期有 `expect`（`main.rs:1702`/`1846`） | T2.1/T2.2 的诊断落盘**不能**靠 `catch_unwind`——必须挂 `std::panic::set_hook`，并显式覆盖"启动期 panic 直接终结进程"这条路径 |
| 2 | **origin/authority 五处硬编码**：`main.rs:1688`（`on_page_load` 判据）、`main.rs:405`（cookie `.domain("127.0.0.1")`）、`themes/src/00-boot.js:33`、`:36`、`ui/loading.html:322`；cookie 名 = `dsh-auth-<sha256(authority)>` | 路线 A 的真实成本在此：换 origin 会**同时**让"签名 + cookie 名 + 页面判据"失效——这是 §2.2 判"远期"的量化依据 |
| 3 | **端口是静态 JSON 的一部分**：`main.rs:437` 之外，`capabilities/remote-dsh.json:7` 也写死 3080，而 capability 的 `remote.urls` **运行期不可改** | 任何"端口配置化"的需求都需要动态 capability；T2/T3 不应顺手引入端口可变性 |
| 4 | **桌宠线程与主窗深度耦合**：桌宠线程持 `AppHandle` 直接操作主窗（`pet_native/window.rs:820`/`994-998`）并**自持 `GetMessageW` 消息泵**（`:1425-1428`） | T2.2 的"UI 线程心跳"要注意**主窗与桌宠是两个消息泵**（心跳要分别定义归属）；T3.1 关闭语义变更必须同时回归桌宠唤起主窗的路径（`window.rs:917`/`968`） |
| 5 | **既有死代码/残留**：`capabilities/default.json:5` 的 `"pet"` 窗口已无对应 Tauri 窗口（桌宠是裸 Win32 窗）；`themes/src/02-core.js:74-77` 调用**未注册**命令 `invoke('set_pet_mode')` 并被 `.catch()` 静默吞掉 | 低风险搭车清理（见 W0 T0.3）；尤其后者会误导排查（看起来像"IPC 可用"，实则从未生效） |
| 6 | **注入分片是"跨片 IIFE"**：`01`–`08` 寄生在 `00-boot.js:7` 开启的**同一个 IIFE** 内、由 `08-ready.js:65` 的 `})()` 闭合（只有 `09-dropguard.js:19` 是独立 IIFE）；`MANIFEST.json` 的 `order` 是拼接事实源，**漏登记即静默不打包** | 新增分片必须明确"寄生还是独立"；`verify-all.mjs:139-145` 的语法闸门是**按整产物**跑 `node --check`（注释已写明"分片本身不是独立语法单元"）——任何"把分片模块化/拆成 ESM"的设想都要连带改这道闸门 |

---

## 5. 验收挂点（挂到既有体系，不新建体系）

| 层 | 挂点 | 新增内容 |
|---|---|---|
| L0 | `scripts/verify-all.mjs`（desktop 线） | 注入脚本语法闸门（已有）+ 新分片纳入 `MANIFEST.order` 校验 + 契约文档存在性 |
| L1 | `dsh-miasaki-desktop/themes/test/`、`ui/test/` | T1.1 时序三条路径单测；T1.2 能力降级单测；T2.1 报告格式化与轮转单测；`cargo test` 补 diag 模块单测 |
| L2 | `cross/smoke-test-matrix.md` §2 | 无需变更（插件加载路径不受影响） |
| L3 | 同文档 **§3.1 桌面壳启动与窗口** 表 | 新增行：① 首帧无闪色（T1.1）；② 契约对象可用且 `protocolVersion` 正确（T1.2）；③ 关闭=隐藏 + marker 重放（T3.1）；④ 退出探针文案（T3.2）；⑤ 恢复对话框三按钮（T2.3）；⑥ 人为阻塞 UI 生成挂起报告（T2.2） |
| L4 | 同文档 §4 | 外观线 boot splash 与 T1.1 闸门的联动（与 `cross/boot-loading-2026-09-22.md` 的时间线合并验证） |

---

## 6. 不做清单与理由（避免无效工作）

| 项 | 理由 |
|---|---|
| **调色板回传"原生标题栏"** | 本项目 `.decorations(false)` 无边框自绘（`main.rs:1675`），原生标题栏不存在。**注意**：机制本身有等价落点（窗口底 / Mica 回退色，`main.rs:1652-1655`），见 W4 T4.3——**不要因为"标题栏不适用"把整条砍掉** |
| **1 GB 级内置运行时**（Python/LibreOffice/语音） | 与"薄壳 + 复用既有环境"定位冲突；本项目已有按需插件机制 |
| **强制更新阻断使用**（服务端 `code 40005`） | 适合官方集中分发，不适合本地自研壳；只取"更新前准入 + 失败明确拒绝"语义 |
| **Electron 替换 Tauri** | 桌宠（分层窗、逐像素 alpha、内联审批）、主题令牌层等资产无法等价迁移 |
| **完整固定 origin（路线 A）** | 见 §2.2：收益有限但触碰鉴权链；单独立项评估后再定 |
| **照抄官方 `dshDesktop` 产品 API 面** | npm 版前端无消费点，注入了也没人读；只有**我们自己的插件**才会消费 |
| **租约式内嵌视图 / 独立 partition（sidebar + ssh）** | 本轮实测：多 viewer 共享单一 pty/shell、各自终结不影响会话、输入不串台、刷新可恢复**均已实现且比 partition 更严**（partition 只隔离存储、不隔离输入串台）——sidebar 用 `sessionId` 绑定 + 最小尺寸仲裁（`sidebar/index.js:694-901`），ssh 用 `connId→runtimeId→shellId` + 单写多读 + 写入所有权代次（`ssh/lib/runtime.js:458-650`）；一次性票据握手也已有（sidebar 60s token、ssh 30s attach ticket）。两线内嵌的是**自家同源页面**，官方那套是为第三方内容设计的；若改成壳级视图 + 独立 partition，主题桥、CSP、chrome-reserve 三条链都要重做 ⇒ **收益为负** |

---

## 7. 需用户拍板的决策点

1. **是否启动 W1（契约层）？** 低风险、收益集中于首帧时序与长期契约；建议做，且建议**只做 T1.1 + T1.2 最小集**，先实机验证再考虑 T1.3/T1.4。
2. **是否立项 W2（挂起取证）？** 这是 `design/TODO.md` 里挂了半个月的 P0（"WER 通道已榨干"）。官方那套报告格式与"停用插件重启"给了现成参照。建议**独立立项**，与桌宠功能解耦。
3. **关闭语义是否改为"关闭=隐藏到托盘"？** 这是行为变更（用户习惯会变），需明确。
4. **是否要做 W6（把本项目插件挂进官方桌面端）？** 纯 profile 配置（不碰代码），可在官方桌面端里直接用上本项目七线成果；但官方 nightly 频繁更新，需接受"跟随验证"成本。
5. **是否重启 W4.2（材质）？** 需先确认与历史挂起问题的关系；建议排到 T2.2 之后。

---

## 8. 风险台账

| 风险 | 影响 | 缓解 |
|---|---|---|
| T1.1 未 resolve ⇒ 白屏 | 高（阻断启动） | try/catch + 超时兜底 + 三条路径单测 + 构建期开关可回退 |
| 注入层与 DSH 升级耦合 | 中 | 契约均为**可选消费**（前端用 `?.` 与 `undefined` 判断），DSH 升级不破坏；升级后跑既有令牌漂移与语法闸门 |
| 看门狗自身成为负担 | 中 | 心跳为原子变量写，零锁；仅在超阈值时才做重活 |
| 停用插件重启误伤 | 中 | 只备份不改写；备份文件带时间戳，可一键回滚 |
| 关闭语义变更引发"关不掉"困惑 | 低 | 首次确认 + marker + 托盘"退出"明确入口 |

---

## 9. 下一步（本稿落地动作）—— 已全部执行完毕，留作回溯

1. ✅ **W0 不等拍板直接做**：T0.1–T0.4 已落地（对既有缺陷的修复，零行为变更争议）。
2. ✅ 用户已对 §7 的 5 个决策点给出结论：**W1 做、W2 做、关闭=隐藏到托盘做、W6 做、W4.2 排 T2.2 之后做**。
3. ✅ 契约先行：`dsh-miasaki-desktop/design/desktop-contract.md` 已出（契约定义 + T1.1 spike 结论 + 三条纪律），
   之后才动 `themes/src/`；后续又追加了 **v1.1 受控写能力**。
4. ✅ 每期完成即回写：`dsh-miasaki-desktop/design/CHANGELOG.md`、`README.md`、`design/TODO.md`，
   并在 `cross/smoke-test-matrix.md` §3.1 补了验收行（W2 / W3 / W4.2 / W4.3 / W5 / 契约各一行）。

**收口后仍待办（不在本稿范围）**：`smoke-test-matrix.md` §3.1 的**实机验收**需用户在真机执行
（尤其：隐藏到托盘静置 2 分钟不应生成 watchdog 报告、W6 需重启官方桌面端才生效）。
