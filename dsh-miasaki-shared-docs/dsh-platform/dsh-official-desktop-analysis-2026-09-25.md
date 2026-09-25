# 官方 DSH 桌面端实测分析（DeepSeek Harness Desktop 0.1.7-rc.2 / Electron 44）

- 日期：2026-09-25
- 调研者：Miasaki 会话（Lead 主导 + 4 名并行调查员分主题精读）
- 对象：`F:\sud\dsh-desk` 官方 Windows x64 安装（注册表 `DeepSeek Harness 0.1.7-rc.2`，更新通道 `nightly`）
- 证据基础：从 `resources/app.asar` 解包出的桌面壳源码（`lib/main.js` 11,695 行 / 57 个模块分区、3 个 preload、`renderer/` 壳内页面）、`@deepseek-ai/dsh-desktop-host` 宿主包、内置 runtime 清单、本机 profile 与用户数据目录、正在运行的宿主环境变量
- 口径：`[实测]` = 本次解包源码 / 读代码 / 跑命令 / 读运行环境核到；`[推断]` = 基于证据的判断，未做隔离实例验证
- 配套：[`dsh-0.1.7-rc2-upgrade-and-refit-plan-2026-09-25.md`](dsh-0.1.7-rc2-upgrade-and-refit-plan-2026-09-25.md)、[`dsh-official-repo-review-2026-09-25.md`](dsh-official-repo-review-2026-09-25.md)

---

## 0. 摘要：七条结论

1. **★★★ 本会话此刻就跑在官方桌面端里** `[实测]`。当前进程环境为 `DSH_PROFILE=desktop`、`DSH_PROFILE_DIR=C:\Users\Asakii\.dsh\profiles\desktop`、`DSH_WEB_URL=http://127.0.0.1:19387`，而官方宿主默认启动参数正是 `--port 19387`。**官方桌面端不是"另一个产品"，而是本项目 DSH 的另一个前端宿主**——同一份 `~/.dsh`、同一份 `0.1.7-rc.2` 运行时，只是 profile 不同。

2. **架构主干 = Electron 壳进程 + DSH Host 子进程** `[实测]`。Electron 只做进程编排、窗口、自定义协议、原生能力与更新；真正的 DSH 应用由 `spawn(Electron 可执行文件, ["--expose-internals", "@deepseek-ai/dsh-desktop-host/lib/index.js", runtimeDir, profileDir, primaryRuntime, pnpmEntry, nodeBin])` 拉起，`stdio` 带 `ipc` 通道握手。宿主内部直接复用 `@deepseek-ai/dsh-app-boot` 的 `loadProfileDirectory` + `@deepseek-ai/dsh/profile-boot` 的 `runProfile`——**与 `dsh web` CLI 是同一条启动路径**。

3. **渲染层 origin 恒为 `dsh-app://app`，静态资源直读 asar、动态请求反向代理到后端** `[实测]`。这是全场最精妙的一段设计：`/`、`/index.html`、`/assets/*`、favicon、manifest 直接从 asar 内 `dsh-web-frontend/dist` 读取（**不依赖后端起没起来**），其余路径 `forwardWebRequest(request, hostUrl, hostCookie)` 代理到 `127.0.0.1:19387` 并注入认证 cookie；WebSocket 也走同一通道（`onBeforeSendHeaders` 强制 `Origin === dsh-app://app`）。配套的首帧协议：静态 `index.html` 的 `<head>` 被注入 `globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()`，前端入口 await 它之后再套用 `injections`——**把"等宿主就绪"变成可等待的承诺，而不是竞态抢跑**。

4. **桌面壳与渲染层有正式契约，不是注入 hack** `[实测]`。`window.dshDesktop`（`protocolVersion: 1`）+ `dshDesktopBoot.ready()` 交付 `{ injections, streamBaseUrl }`；`injections` 由宿主 `ctx.webServer.collectIndexInjections()` 收集、经 IPC 上报、再由渲染层自行应用。`dshDesktop` 只在 `dsh-app://app` 主帧暴露真实 API，其它帧只拿到 `{ protocolVersion: 1 }` 空壳。

5. **发行代价 1,010 MiB，换来"完全离线自带运行时"** `[实测]`。安装目录 9,767 文件 / 1,010 MiB：Electron 本体 244 MB、`app.asar` 112 MiB、`app.asar.unpacked` 241.3 MiB（其中 LibreOffice 精简引擎 `libreoffice-kit-win32-x64` 独占 182 MiB）、`resources/runtime` 290 MiB（内置 Node 24 / pnpm 11 / Python 3.12.14 + numpy/pandas/python-docx/pptx/openpyxl/Pillow/lxml/XlsxWriter）。Node 不自带独立二进制：`runtime/bin/node.cmd` 实为 `set ELECTRON_RUN_AS_NODE=1` 后调用 Electron 自身的转接脚本。

6. **默认桌面 profile 与本项目插件线完全隔离** `[实测]`。`~/.dsh/profiles/desktop/package.json` 的 bundles 只有 `dsh-base`、`dsh-web-app`、`dsh-experimental-agent-team-profile`；本项目 6 条线的插件全部注册在 `profiles/web`。**因此在官方桌面端里，本项目的外观/画布/侧边栏/SSH/双模型/桌宠面板等一切默认不可见**——但 `~/.dsh/sessions`、`storages`、`.credentials.yaml` 是 home 级共享的，会话与凭据跨前端互通。

7. **迁移前提已具备** `[实测]`。`~/.dsh/profiles/node_modules/@deepseek-ai/dsh` = `0.1.7-rc.2`，与官方桌面端 runtime **同版本**；本项目 5 个主插件**未声明任何 `@deepseek-ai/dsh*` peerDependencies**，按官方规则"未声明 DSH peer 时不施加版本约束"⇒ 不会被 peer 闸门拒绝。desktop 线自带的 5 个插件声明了 `@deepseek-ai/cordis ^4.0.2` 与 `dsh-settings`/`dsh-host-webserver >=0.1.2-rc.1 <0.3.0`，desktop runtime 均在范围内且两个 peer 包在 asar 内齐备。

---

## 1. 安装形态与体积账本

### 1.1 顶层结构 `[实测]`

```
F:\sud\dsh-desk\                    总计 9,767 文件 / 1,009.81 MiB（1,058,859,729 B，字节精确核对）
├─ 根目录启动文件                   297.40 MiB   DeepSeek Harness.exe 233.16 + Chromium 运行时
│                                                （dxcompiler.dll 24.56 / LICENSES.chromium 19.52 /
│                                                  resources.pak 11.86 / icudtl.dat 10.37 …）
├─ locales\*.pak（55 个）            48.30 MiB   Chromium 界面语言包
├─ Uninstall DeepSeek Harness.exe    —            NSIS 卸载器（注册表 InstallLocation 指向本目录）
└─ resources\
   ├─ app.asar                      112.00 MiB   桌面壳 + 打包的 DSH 运行时（逻辑树 350.08 MiB / 12,875 项）
   ├─ app.asar.unpacked\             241.29 MiB  25 个包实体 / 1,495 文件（原生二进制解包区）
   ├─ runtime\primary-runtime\       272.12 MiB  python 164.89 + node 89.40 + pnpm 17.83
   ├─ runtime\pnpm\                   17.83 MiB  与 dependencies/pnpm 重复的副本（448 文件同、4 个原生文件 hash 不同）
   ├─ runtime\bin + versions.json + office-skills   0.03 MiB
   ├─ app-update.yml                 306 B       electron-updater 源：generic + nightly
   └─ tray.ico / icon.png / elevate.exe / default_app.asar    0.47 MiB
```

### 1.2 `app.asar` 内部构成 `[实测]`

| 条目 | 文件数 | 体积 | 说明 |
|---|---|---|---|
| `dsh/` | 12,320 | 345.04 MiB | 打包的 DSH 运行时（`@deepseek-ai/dsh-desktop-runtime`，依赖清单 15.6 KB，锁定 0.1.7-rc.2 全家桶） |
| `dsh/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/` | 730 | 182.04 MiB | Office 文档引擎（**单包占全包一半以上**） |
| `dsh/node_modules/@deepseek-ai/dsh-web-frontend/` | 132 | 5.44 MiB | Web UI 静态产物（`dsh-app://app` 的静态资源来源） |
| `node_modules/` | 528 | 4.14 MiB | 桌面壳自身依赖：electron-updater、semver、ws、builder-util-runtime 等 |
| `lib/` | 13 | 0.86 MiB | 桌面壳代码：`main.js` 463 KB、`preload-app.cjs` 37 KB、welcome/ |
| `renderer/` | 13 | 0.04 MiB | 壳内页面：welcome、update-dialog、mandatory-update、policy-login-loading |

> **口径说明**：上表按 asar 头部记录的**逻辑文件树**统计（12,875 项 / 350.1 MiB），其中标记为 `unpacked` 的条目内容实际落在 `resources/app.asar.unpacked`（241.3 MiB），并不在 asar 文件内；`app.asar` 文件本身仅 112.0 MiB（内含 11,380 个 packed 文件 / 108.79 MiB 载荷）。两者相加才是"asar 逻辑树"的完整体积——**不要把 350 MiB 当成单文件大小**。

**运行时身份有两份描述符，且已出现口径分歧** `[实测]`：

| 文件 | 内容 | 问题 |
|---|---|---|
| `resources/runtime/versions.json`（66 B） | `{schemaVersion:1, node:"24.18.1", pnpm:"11.7.0"}` | **全仓无任何引用**，且与实际二进制不符 |
| `resources/runtime/primary-runtime/runtime.json` | `desktopVersion 0.1.7-rc.2 / win32 / x64 / payloadDigest <sha256> / **node 24.21.0** / pnpm 11.7.0 / **python 3.12.14**` + 13 个 Python 包版本 | 与实际 `node.exe`（24.21.0）一致 |
| `dsh/desktop-runtime.json`（**2.67 MiB / 75,339 行**） | `release { version 0.1.7-rc.2, **hostProtocolVersion 4**, nodeVersion **24.18.1**, pnpmVersion 11.7.0 }` + `sharedPackages` **282 条**（274 条为 0.1.7-rc.2）+ `files` **12,319 条**（`path/bytes/sha256/executable`，合计 342.37 MiB，sha256 覆盖 12319/12319） | 与 versions.json 同写 24.18.1，但真实 payload 是 24.21.0 |

> 顺手记一个官方的小瑕疵：`desktop-runtime.json` 的结尾 `}` 被 asar 条目 size 截掉了（声明 2,797,255 B、实际 2,797,253 B，首部另带 2 字节对齐 NUL），即**随包分发的 JSON 用 `JSON.parse` 会直接失败**。这提醒我们：生成 manifest 的脚本必须自带 `JSON.parse` 自校验 + 字节数校验。

> **全机同时存在三套运行时** `[实测]`：Electron 内嵌 Node（跑 DSH 宿主，靠 `ELECTRON_RUN_AS_NODE=1`）→ 真 `node.exe` 24.21.0（跑 LibreOffice 引擎）→ CPython 3.12.14（跑 Office 脚本，site-packages 114.16 MiB，含 pandas 33.57 / numpy 20.99 / PIL 14.07 / lxml 8.60，甚至带了 10.15 MiB 的 `pip`）。

### 1.3 解包（unpacked）策略 `[实测]`

`resources/app.asar.unpacked/dsh/node_modules` 下只有需要"物理文件路径"的包：`@deepseek-ai/{dsh-session-log-export, libreoffice-kit, libreoffice-kit-win32-x64}`、`node-pty`、`sherpa-onnx-win-x64`（语音识别）、`@img`(sharp)、`@swc`、`@vscode`、`@koromix`、`node-addon-require-builtin-win32-x64-msvc`、`fontkit` 等；全树 `.node/.dll/.exe` 共 **22 个文件 / 222.76 MiB**，其中 `libreoffice-kit-win32-x64` 一个包的 `bin/libreoffice-kit.exe` 就占 **170.31 MiB**。

**规则意图**（由产物反推）：
1. **根因**：asar 补丁只覆盖 Node 的 `fs` 层；**原生 DLL 加载**与**非 Electron 子进程 spawn**（libreoffice-kit.exe 等）拿不到虚拟路径，必须落盘。
2. **匹配的是"包目录 glob"而不是"按扩展名"**：`@swc/helpers`（438 个纯 JS 文件）、`fontkit`（127 个文件）整目录被解包，说明规则形如 `**/node_modules/{node-pty,sherpa-onnx-win-x64,@img/**,…}/**`，并非 `**/*.node`。
3. **连带代价**：包目录一解包，pnpm 为它解析出的传递依赖闭包一起落盘（`fontkit → restructure/brotli/unicode-trie/dfa/tiny-inflate/tslib`、`libreoffice-kit → fflate/fontkit/saxes`），**约 18.5 MiB 是纯 JS 陪跑**。
4. **有代码为证**：`@deepseek-ai/dsh-desktop-host/lib/index.js:25-61` 用 `node:module` 的 `registerHooks({ resolve })` 把 `@deepseek-ai/libreoffice-kit-*` 的解析从 `app.asar/...` 重写到 `app.asar.unpacked/...`，并显式拒绝"解析到 asar 内"的结果——因为那个 170 MB 的 exe 要交给独立的 `node.exe` 去跑。

### 1.4 与本项目桌面线的体积对照 `[实测]`

| 维度 | 官方桌面端 | 本项目 `dsh-miasaki-desktop` |
|---|---|---|
| 安装占用 | 1,010 MiB / 9,767 文件 | 单 exe 41 MiB（`dist` 含素材 110.9 MiB；MSI 37.5 MiB / NSIS 35.8 MiB） |
| 桌面运行时 | Electron 44 | Tauri 2（WebView2） |
| DSH 本体 | 随包内置 345 MiB（离线可用） | 依赖本机 `dsh` 安装 + profile `link:` |
| Node/pnpm | 内置（复用 Electron 二进制） | 复用用户环境 |
| Python/Office 引擎 | 内置 3.12.14 + LibreOffice 引擎 182 MiB | 无 |
| 自更新 | electron-updater + 强制更新策略 | 无（靠用户手动升级） |
| 更新成本 | **全量 NSIS 整包 274.90 MiB/次**（实测 `installer.exe` 与 `pending\*.exe` 均 288,245,480 B；blockmap 仅 299,839 B 做差量判定，无语义级增量） | 壳 3–8 MiB，与 DSH 解耦 |
| 首次启动 | 装完即用、**首启零网络**：profile 是零依赖模板（`dependencies: {}` + 无 `node_modules`），payload 由 `resolvePrimaryRuntime` **就地只读校验、不展开不复制**（实测 `~/.dsh/dsh-runtimes` 不存在） | 需探测本机 `dsh` + 版本校验，多一类失败面 |
| 可复现性 | 满分：12,319 条 sha256 + 282 个包精确 pin + `dshBuildCommit c1275515…`（`dshBuildDirty: false`） | 需自建版本探测；用户可自行升级导致基线漂移 |

> `[推断]` 25 倍的体积差不是"实现优劣"，而是两种产品定位：官方要"下载即用、零环境依赖、可强制升级"，本项目要"薄、可定制、与用户既有 DSH 环境共存"。

---

## 2. 进程与运行时架构

### 2.1 启动链路 `[实测]`

```
用户双击 → DeepSeek Harness.exe（Electron 主进程，app.asar/lib/main.js）
  ├─ requestSingleInstanceLock() 失败即退出；成功则 second-instance → 聚焦已有窗口          main.js:6784-6791, 11682
  ├─ protocol.registerSchemesAsPrivileged([{ scheme: "dsh-app", standard/secure/supportFetchAPI/corsEnabled/stream/codeCache }])   main.js:10452
  ├─ pruneCrashReports(logs) → resolveDesktopPaths() → profile = ~/.dsh/profiles/desktop（lock 同目录）    main.js:10613, 69-74
  ├─ 【关键】先建隐藏主窗（show:false）并 navigateMain("dsh-app://app/")：先渲染本地 UI 骨架，再起后端   main.js:11626, 10836
  ├─ initProfile(profileDir, bundles)  幂等：写 package.json / cordis.patch.yml / pnpm-workspace.yaml（已存在不覆盖）  main.js:3291-3307
  │    └─ 全程持 profile 锁：openSync(lock,"wx",0600) 写 pid + fsync；EEXIST 时 kill(pid,0) 判活，陈旧则 unlink 重试  main.js:3480-3514
  ├─ new DesktopBackendController(...) → new DesktopHostProcess(node, runtimeDir, profileDir, inspectPort, env, onFailure, primaryRuntime, packageManager, onPlatformSession)   main.js:10716-10720
  │    └─ spawn(process.execPath /* Electron 二进制 */, [
  │         "--expose-internals",
  │         "[--inspect=127.0.0.1:<port>]",
  │         "<asar>/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js",
  │         "<runtimeDir = asar>/dsh",
  │         "<profileDir = ~/.dsh/profiles/desktop>",
  │         "<primaryRuntime = resources/runtime/primary-runtime>",
  │         "<pnpm.mjs>", "<runtime/bin>"      // 仅包操作时传入
  │       ], { cwd: profileDir, env: desktopNodeEnvironment(...), stdio: ["ignore","pipe","pipe","ipc"] })   main.js:3672-3692
  ├─ 子进程 ready → { url: <带 token 的 http://127.0.0.1:19387>, injections: [...] }                          host/index.js:338-345
  ├─ 主进程 authenticateWebHost(ready.url) 取 cookie → hostCookie                                            main.js:10724
  ├─ 主窗口 loadURL("dsh-app://app/")，渲染层调 dshDesktopBoot.ready() 拿 { injections, streamBaseUrl }        main.js:10938-10946
  └─ 退出：ipc "quit-inspection" / "update-tasks"(inspect|lock|unlock) / "shutdown" → "shutdown-complete"      host/index.js:264-323
```

### 2.2 Host 侧职责边界 `[实测]`（`@deepseek-ai/dsh-desktop-host`，367 行）

宿主包很薄，只做四件事：
1. **启动**：`installOfficeEngineResolution`（asar → unpacked 的 resolve hook）→ `loadProfileDirectory("dsh", projectDir, installAnchor)` → `reportSkippedBundles` → `runProfile({ profile: "desktop", args: ["--no-open", "--port", "19387"] })`；`installAnchor` = `<runtimeDir>/node_modules/@deepseek-ai/dsh/package.json`。
2. **Office 组合**：`ctx.plugin(office_exports, { runtimeDir, source: primaryRuntime, root: ~/.dsh/dsh-runtimes/dsh-primary-runtime })`，把 Python/Node 引擎与 `office-skills` 资源接进 profile，并挂 `dsh-tool-workspace-dependencies`。
3. **控制面**：`installDesktopUpdateTaskControl`（`connection/request` 中间件：锁定后新请求一律 503，随后 `Promise.all(pendingRequests)` 排空在途请求，再回报是否有活跃任务）、`installDesktopQuitInspection`（活跃 agent / inbox 待处理 / running|stopping 的后台 job + 已武装的定时提醒）。
4. **凭据与就绪**：`installPlatformSessionPublisher` 把 `deepseekAccount` 的会话（origin/token/userId）经私有 IPC 推给 Electron 主进程（**不落渲染层**）；最后 `ctx.connection.authenticatedUrl(...)` + `ctx.webServer.collectIndexInjections()` 上报 ready。

### 2.3 IPC 消息契约（父 ↔ 子） `[实测]`

| 方向 | type | 载荷 | 语义 |
|---|---|---|---|
| 子→父 | `ready` | `{ url, injections }` | 应用已启动，附认证 URL 与首帧注入 |
| 子→父 | `platform-session` | `{ origin, token, userId }` | 账号会话更新（null = 清除） |
| 子→父 | `fatal` | `{ message, diagnostic(≤64KB inspect) }` | 启动致命错误，带结构化诊断 |
| 子→父 | `shutdown-complete` | — | 应用已优雅关闭 |
| 父→子 | `shutdown` | — | 请求关闭 |
| 父→子 | `quit-inspection` | `{ requestId }` | 询问"现在退出会打断什么"（默认 10s 超时） |
| 父→子 | `update-tasks` | `{ requestId, action: inspect\|lock\|unlock }` | 更新前准入控制 |

子进程 stdout 直接 pipe 到父进程 stdout，stderr 保留最后 64 KB 用于失败诊断 `[实测]`（`main.js:3694-3698`）。

### 2.4 profile 机制（本项目最需要理解的一节） `[实测]`

- profile = `$DSH_HOME/profiles/<name>`，由"可安装组合包（bundles）+ 自身 `cordis.patch.yml`"组成；官方文档 `dsh-app-boot/README.zh.md` 明确：**"由应用持有的 npm 项目（例如 Electron 保留的 Desktop profile）通过 `loadProfileDirectory` 加载已经初始化的目录，而不会将它暴露给 CLI profile 查找。"**
- `initProfile` 写入的三件套（本次实测的 desktop profile 正是这三件 + 空 patch 模板）：`package.json`（`dsh.profile.bundles`）、`cordis.patch.yml`、`pnpm-workspace.yaml`（`nodeLinker: hoisted` / `autoInstallPeers: false`）。
- **desktop profile 下没有 `node_modules` 是正常的**：bundles 携带的官方包由宿主从 `runtimeDir`（asar 内 `dsh/node_modules`，12,318 个包文件）解析；`$DSH_HOME/profiles/node_modules` 是共享祖先（runtime resolution 的落点）。0.1.5 时代 link 后端曾把包投影进 profile（`.dsh-module-fallback`），现在只剩"清理遗留投影"的代码 `[实测]`（`main.js:3308-3345`）。
- peer 闸门 `[实测·文档]`：DSH 在导入插件前检查其 `peerDependencies` 中 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 与 `getDshRuntimeVersion()` 是否匹配，**未声明则不施加约束**；豁免写在 profile 自己的 `compatibility.json`（精确 `包名@版本` ↔ 运行时版本列表），插件升级与 DSH 升级都不继承授权。
- 致命恢复用的 `sanitizeProfile` `[实测·文档]`：把 `cordis.patch.yml` 改名为 `.bak-<timestamp>` 备份、恢复调用方给定的 bundle 列表，其它 manifest 字段原样保留——正是桌面壳 `disableAllPlugins` 的底层动作（`main.js:10406-10412`）。

### 2.5 用户数据目录 `[实测]`

```
%APPDATA%\@deepseek-ai\dsh-desktop\      Electron userData（产品名 @deepseek-ai/dsh-desktop）
├─ Partitions\dsh-platform-<sha256(origin,userId)>\   内嵌 Platform 登录视图的独立分区（persist:）
├─ Cache / Code Cache / GPUCache / DawnGraphiteCache / DawnWebGPUCache / Shared Dictionary
├─ Local Storage / Session Storage / Network(Cookies) / Preferences / Local State / DIPS
└─ logs\                                 崩溃报告落点（app.getPath("logs")，本次为空 = 未发生 fatal）
%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\   electron-updater 缓存（pending\*.exe + blockmap，实测 ~288 MB）
```

### 2.6 并发、互斥与停机分级 `[实测]`

**三重互斥**（同一份数据被两个进程同时写的经典防线）：
1. `app.requestSingleInstanceLock()` —— 应用级单实例，第二次启动导流到已运行窗口（`main.js:6784-6791, 11682`）。
2. **profile 文件锁** —— `openSync(<profile>/lock, "wx", 0600)` 写入 pid 并 `fsync`；已存在则读 pid 用 `process.kill(pid, 0)` 判活，`ESRCH` 视为陈旧锁并 `unlink` 重试，否则抛 `another profile operation is active`；`finally` 关 fd 并删锁（`main.js:3480-3514`）。**跨进程、可判活**，专门保护 `applyRelease` 这类改 profile 的操作。
3. 固定端口 19387 —— 与另一个 `dsh web` / 桌面端实例天然互斥，外壳专门识别 `EADDRINUSE` 并换成"另一个实例在运行"的文案（`main.js:7228, 6484/6624`）。

**停机分级**（`stop(requireGraceful)`，`main.js:3791-3805`）：清理 platform session → 发 `{type:"shutdown"}` → 等 10s → `SIGTERM` → 5s → `SIGKILL` → 仍不退则抛错。更新安装路径更严：要求 `exitCode === 0` **且**收到 `shutdown-complete` ack，否则抛 `DesktopHostUncleanExitError` **拒绝安装**（`main.js:3807, 10763-10769, 10880-10885`）。控制请求也各自带超时：`quit-inspection` 2s、`update-tasks` 10s。

**值得注意的两处"官方没有"**：宿主**无心跳**（活性仅靠 `child.connected` 前置检查与 `error`/`close` 事件）、**无自动重启/退避**（唯一重试入口是更新失败回滚与用户点 Restart）。本项目 desktop 线的"后端存活看门狗（2s 探测 + 2s→30s 退避重拉）"在这里是**反超官方**的设计。

### 2.7 运行时描述符 `dsh/desktop-runtime.json` `[实测]`

官方用一份随包分发的描述符钉住整个运行时身份：`schemaVersion 1`、`release { version: 0.1.7-rc.2, hostProtocolVersion: 4, nodeVersion: 24.18.1, pnpmVersion: 11.7.0 }`、`platform/arch`、`sharedPackages: 282`、`files: 12319`（每项含 sha256）。

- 启动路径上的 `runtime-tree` 模块只做**结构与身份校验**：包名正则、`path` 必须形如 `node_modules/<name>`、不得重名、并强制 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-desktop-host` 的版本等于 `release.version`（`main.js:80-119`）。
- **逐文件 sha256 校验发生在打包期**，运行期主进程只取 `release.version` 用于更新头 `x-client-bundled-dsh-version`（`main.js:3474, 11641`）。
- profile 的 pnpm 设置里另有一份 `allowBuilds` 白名单：允许 `node-pty` / `koffi` / `fs-ext` / `dsh-subprocess-local` 跑构建脚本，拒绝 `genai` / `protobufjs` / `node-addon-require-builtin`（`main.js:3434-3442`）。
- **payload 就位策略有"只读"与"安装"两条路**：`resolvePrimaryRuntime` 只校验元数据与条目、**就地使用、不复制任何文件**（首启零等待的来源）；`installPrimaryRuntime` 则走 staging 目录 + `rename` 原子切换 + `.previous` 回滚（`dsh-desktop-host` 的 Office 组合用的是前者）。本项目 `deploy-local.ps1` 这类部署脚本可直接借用后者的原子切换 + 回滚语义。

> 对本项目的意义：这等于把"版本约定"从 README 搬到机器可读 manifest + 启动期校验，值得在 desktop 线的 `verify-all.mjs` 里做同构物。

---

## 3. 渲染层：协议、窗口与契约

### 3.1 `dsh-app://` 路由表 `[实测]`（`main.js:10920-10929`）

| 请求 | 处理 |
|---|---|
| `dsh-app://shell/*` | `serveWebDocument(request, <asar>/renderer)` —— 壳内页面（welcome、更新对话框、强制更新） |
| `dsh-app://app/`、`/index.html`、`/assets/*`、`/favicon.svg`、`/manifest.webmanifest` | `serveWebDocument(request, <asar>/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist)` —— **静态直读 asar** |
| `dsh-app://app/<其它>` | `forwardWebRequest(request, hostUrl, hostCookie)` —— 代理到后端并注入 cookie |
| 后端未就绪 | `503` |
| 其它 host | `404` |

配套的同源防护 `[实测]`（`main.js:10961-10977`）：`session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["ws://127.0.0.1/*"] })` 只对主窗口放行、且要求 `Origin === "dsh-app://app"`，否则 `cancel: true`；目标 host 也必须等于 `hostUrl` 的 host。

> **这是本项目最值得抄的一条**：自定义协议把"后端端口 + cookie"完全藏进主进程，渲染层永远只有一个稳定 origin。本项目当前是 WebView2 直接导航 `http://127.0.0.1:3080/`，端口与 cookie 暴露在 webview session 中，且因 Tauri IPC 对远程页面被 ACL 拒绝，只能用 URL hash 当同步通道。

### 3.2 窗口与外观 `[实测]`（`main.js:10507-10567`）

- 主窗口 1280×820、min 520×600；`webPreferences = { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: primary, devTools: true }`。
- Windows：`titleBarStyle: "hidden"` + `titleBarOverlay { height: 40, color, symbolColor }`；macOS：`hiddenInset` + `trafficLightPosition {16,18}` + `vibrancy: "sidebar"` + 透明背景，并在最小化/隐藏时把 vibrancy 置空、换成不透明兜底色（`applyBackdrop`）。
- 兜底色 `chromeFallbackFill()` = 深色 `#1b1b1c` / 浅色 `#f9fafb`，注释明确对应内置侧边栏 token `--dsw-static-neutral-bluish-900` / `-50`。
- `setWindowOpenHandler`：http(s) → `shell.openExternal`，其余一律 `deny`。
- 自绘右键菜单：可编辑区给 undo/redo/cut/copy/paste/selectAll，仅有选区时给 copy（`main.js:10568-10591`）。

### 3.3 主题调色板回传 `[实测]`（`main.js:11370-11379`）

渲染层（仅 `dsh-app://app/` 主帧）通过 `DESKTOP_IPC.windowsAppearance` 上报 `(language, color, symbolColor)`；主进程校验来源帧 URL 前缀、用正则校验颜色格式（`#[\da-f]{3,8}` 或 `rgb()/rgba()`），再 `mainWindow.setTitleBarOverlay({ color, symbolColor })`。**自定义主题时标题栏颜色由渲染层实测值决定，而不是壳里硬编码**——本项目 `design/titlebar-v4-embed.md` 的问题域与此完全重合，可直接对照。

另外 `windowsMenu` IPC `[实测]`（`main.js:11337-11369`）：渲染层可请求在指定坐标弹出原生 application/edit 菜单，坐标按 `webContents.getZoomFactor()` 换算，edit 项通过快捷键子系统派发按键（`shortcuts.sendEditingKey`）——因为 webview 里无法直接执行原生剪贴板动作。

### 3.4 preload 契约面 `[实测]`（`lib/preload-app.cjs`）

| 注入名 | 暴露条件 | 内容 |
|---|---|---|
| `dshDesktop` | 仅 `dsh-app://app` 主帧；其它帧只给 `{ protocolVersion: 1 }` | `protocolVersion: 1`；`browser.{acquire,release,onOpenRequested}`；`keyboard.{closeWindow,subscribe}`；`shortcuts.{get,edit,recording,subscribe}`；`updates.{status,open,subscribe}` |
| `dshDesktopBoot` | 同上 | `ready()` → `{ injections, streamBaseUrl }`；`failed(message)` → 上报启动失败给壳 |
| `dshPlatform` | 主帧 | `open(page, bounds)` / `setBounds(bounds)` / `close()`（内嵌 Platform 登录视图） |
| `dshOnboarding` | 主帧 | `hasApiKey()` / `setActive(active)` |
| `__DSH_DIRECTORY_PICKER__` | — | `pick()` → 原生目录选择器 |
| `__DSH_HOST_PATHS__` | — | `pathFor(file)` → `webUtils.getPathForFile`（拖拽文件取真实路径） |
| `__DSH_LOCALE__` | `dsh-app://app` | `read()` / `onChange(locale)` |

其它 preload：`preload-platform-account.cjs`（平台账号视图用，expose `dsh` → `getAuthToken()/getLocale()/onLocaleChange()`）、`preload-welcome.cjs`（expose `dshWelcome`：欢迎流程 API）、`preload-mandatory.cjs` / `preload-update-dialog.cjs`（只在各自壳页面 URL 下 expose）。

### 3.5 内嵌浏览器视图 `[实测·部分]`

`browserGuests` 用 `WebContentsView` 叠在主窗口上（`main.js:6054`），`acquire(workspace)` / `release(lease)` 是**租约语义**，`view.webContents.setWindowOpenHandler` 与 `will-navigate` 双重拦截，视图用 `partition: lease.partition` 独立分区（`main.js:9125`）。主窗口 `webviewTag: true` 也开着——即官方同时支持"叠加视图"与 `<webview>` 两条内嵌浏览器路线。

---

## 4. 原生能力面

| 能力 | 实现要点 `[实测]` |
|---|---|
| 托盘 | `DesktopTray` 常驻（不是仅隐藏时出现），tooltip/菜单随语言 `relabel()`；菜单=打开应用 / 退出；退出确认后 `dispose()` 不留死图标（`main.js:10264-10308`） |
| 关闭到托盘 | 首次"关闭=隐藏"前弹一次原生确认，确认后写 marker 文件记住；取消则下次仍会问；重复请求只聚焦不自叠（`DesktopBackgroundNotice`，`main.js:10310-10369`） |
| 退出确认 | 先问 Host `quit-inspection`；按"活跃任务/定时提醒"选 4 种文案；**检查失败或超时按"有任务"处理（fail-safe）**；一次只弹一个，批准后不复检（`main.js:10190-10262`） |
| 快捷键 | `installDesktopShortcuts(getWindow, userData, platform, updateMenu, overlayInput)`：用户可改动并持久化到 userData、有录制态、有 revision 乐观并发校验（`shortcutsEdit` 带 `expectedRevision`）、可关闭窗口、可挂到 guest 视图 |
| 目录选择器 | `installDesktopDirectoryPicker(getWindow)`，经 IPC `directoryPick` |
| 麦克风权限 | `installMicrophonePermissions(session.defaultSession, () => mainWindow?.webContents)`（语音输入链路，配合 `sherpa-onnx`） |
| 通知 | Electron `Notification`（更新可用等场景）、窗口 `attention`（`flashFrame` / `dock.bounce`） |
| 电源 | `powerMonitor`（唤醒/休眠后触发更新检查等） |
| 菜单 | 应用菜单 + 渲染层按坐标弹出的上下文菜单（见 §3.3） |
| 文件拖拽 | `webUtils.getPathForFile`（`__DSH_HOST_PATHS__`） |

---

## 5. 更新体系（electron-updater + 服务端强制更新）

`[实测]`（主进程 region `update-*`，约 2,200 行）：

- **基础**：`app-update.yml` = `provider: generic`、`url: https://download.deepseek.com/dsh-desk/feeds/win-x64/`、`channel: nightly`、`updaterCacheDirName: @deepseek-aidsh-desktop-updater`。
- **策略**：`autoDownload=false`、`autoInstallOnAppQuit=false`、`allowPrerelease=true`、`allowDowngrade=false`；差分走 electron-updater 默认 blockmap；`ElectronHttpExecutor` 只额外加"静默空闲超时"（默认 60s，可用 `DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS` 覆盖）。
- **节奏**：启动即查、窗口获得焦点/系统唤醒也查、周期默认 10 分钟；失败退避 ×2、封顶 60 分钟、带 ±20% 抖动（`DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS` / `_MAX_BACKOFF_MS` / `_JITTER` 可覆盖）。
- **双确认与策略字段**：下载与安装是**两次独立确认**（版本不匹配即判"确认已过期"）；`allowedPageOrigins` 是唯一允许"打开/复制下载页"的 HTTPS 源白名单；`authentication: anonymous` 时请求 `credentials: omit` 且禁止配置登录源。**策略请求失败不会清除已生效的阻断**（只累加失败计数并保留 blocking），即断网无法绕过强制升级。
- **强制更新判定在服务端**：`GET {origin}/api/v0/check_client_update`（origin = `package.json` 的 `dshMandatoryUpdatePolicy.origin` = `https://harness.deepseek.com`），匿名请求（`credentials: omit`、`cache: no-store`、`redirect: error`），携带 `x-client-arch` / `x-client-update-channel: nightly` / `x-client-bundled-dsh-version`。响应 `code === 40005` 即"必须升级"（可带标题/正文/下载链接），`code === 0 && biz_code === 0 && biz_data === null` 为"不强制"，其余抛错；**本地 semver 只用于普通更新的 `gt(version, currentVersion)` 判断**。
- **阻断方式**（不杀后端）：Windows 在 `dsh-app://app` 页面内嵌 iframe overlay（`position: fixed; top: 40px` + closed shadow root + `z-index: 2147483647`），macOS 独立 modal overlay；窗口关闭键在阻断期等价于退出应用。
- **更新前准入**：`update-tasks lock` → 新 API 请求返回 503、排空在途请求 → 检查是否真有活跃任务 → 用户确认后 `install`。若"任务停不下来"，明确拒绝安装而不是强杀。
- **更新台账**：`update-journal.js` 只在设置 `DSH_DESKTOP_UPDATE_JOURNAL_DIR` 时才落盘（生产包不设置 ⇒ **生产环境无持久更新台账**），白名单字段 JSONL。
- **提示注意力**：`update-attention.js` 用"任务栏闪烁 + 系统通知"（每版本一次、失焦才提示、聚焦即清），**不是红点**。

---

## 6. 首次引导与账户

`[实测]`：

- **触发条件**：`!loggedIn && !hasApiKey` → 弹欢迎窗口；登录后再登出 / session 过期会重新弹出。
- **欢迎窗口**：600×700 固定、不可缩放、sandbox + contextIsolation、locale 通过 `additionalArguments` 传入；流程 = 浏览器授权登录 / 手填 API key（"保存并继续" / "稍后设置" = 跳过）/ 取消（Windows 上取消 = 直接退出应用）。主窗口在此期间 `hide()`。
- **API 面**：`dshWelcome`（locale 消息表 + `takeNotice` / `startSignIn` / `cancelSignIn` / `copySignInLink` / `onAccountState` / `saveApiKey` / `skip`）。
- **账户**：壳进程**不落盘 token**；Host 子进程通过 `platform-session` IPC 推送 `{ origin, token, userId }`，主进程内存持有，内嵌 Platform 视图用 `persist:dsh-platform-<sha256(origin,userId)>` 独立分区；授权 URL 会附 `theme=light|dark` 让登录页与宿主主题一致。
- **默认模型**（实测 desktop profile 的 patch 层）：`agent-default-model = { provider: deepseek-account, model: deepseek-flash, reasoningEffort: max }`；`ui-chat = { transcriptView: standard, performanceUsage: detailed }`；账号引导标记 `step: done, completion: api-key`。

---

## 7. 健壮性设计

| 机制 | 行为 `[实测]` |
|---|---|
| 崩溃报告 | **不上报远端**，只写 `app.getPath("logs")` 下 `crash-<ISO>-<host\|web-boot\|renderer\|main>.log`，保留最近 10 份；内容含 phase（startup/running）、error、host diagnostic、**主窗口 renderer console 尾部**、app/electron/node 版本与 locale |
| 致命恢复 | `DesktopFatalRecovery` 原生三按钮：退出 / 重启 / **停用全部第三方插件后重启**（走 `sanitizeProfile` 备份 patch 并恢复 bundle 列表）；端口占用类错误（EADDRINUSE）降级为"退出/重启"两按钮并换文案 |
| 启动失败路径 | 渲染层可用 `dshDesktopBoot.failed(message)` 上报，壳转成 fatal 并走恢复流程；启动错误文案含"任务数据存储在独立位置"的安抚说明 |
| 单实例 | `single-instance` region：第二次启动聚焦已有窗口而非新开 |
| 退出编排 | `skipQuitConfirmation`（崩溃恢复、开发重启、安装器接管等路径不重复询问）；`shuttingDown` 冻结"后端状态"读数，避免关闭期的失败被误报为异常 |

---

## 8. 与本项目的对照与可参考点

### 8.1 结构性差异一览 `[实测 + 推断]`

| 维度 | 官方桌面端 | 本项目（七线现状） |
|---|---|---|
| 壳技术 | Electron 44 + WebContentsView | Tauri 2 + WebView2 + 原生 Win32 桌宠 |
| 与渲染层通信 | 自定义协议 + preload `contextBridge` 正式契约（`protocolVersion: 1`） | URL hash 单通道（Tauri IPC 对远程页面被 ACL 拒绝） |
| 页面来源 | `dsh-app://app`（静态直读 asar + 后端代理） | 直接导航 `http://127.0.0.1:3080/` |
| 后端进程 | Electron spawn Host 子进程（`ipc` 通道、控制协议） | Tauri 拉起 `dsh web` + 存活看门狗（2s 探测、退避重拉） |
| 首帧注入 | Host `collectIndexInjections` → boot IPC 交付 | appearance 线 `webserver/index-inject` |
| 主题↔原生 chrome | 渲染层上报实测调色板 → `setTitleBarOverlay` | 主题令牌层 + titlebar v4（本次可直接对照） |
| 插件宿主 | `profiles/desktop`（bundles 声明式，运行时来自 asar） | `profiles/web`（`link:` 显式依赖 + bundles） |
| 自更新 | electron-updater + 服务端强制更新 | 无 |
| 桌宠/原生装饰 | 无（只有托盘 + 窗口材质） | **本项目独有**：分层窗桌宠、内联审批、fleet 指示、三主题 |

### 8.2 可参考点（按优先级）

**P0 — 结构与契约层面，收益最大**

1. **自定义协议 + 固定 origin 的"本地应用化"**：把后端藏到主进程后面，渲染层只见 `dsh-app://app`；静态资源直读包内 dist、动态请求才代理。对本项目意义：Tauri 有 `register_asynchronous_uri_scheme_protocol`，可在不放弃薄壳路线的前提下获得"无端口暴露 + 同源 + 首帧极快"。**注意**：需同时处理 WebSocket（官方用 `onBeforeSendHeaders` 校验 Origin + 注入认证）。
2. **桌面壳 ↔ 渲染层正式契约 + 版本号**：`window.dshDesktop.protocolVersion`，且**只在产品 origin 主帧暴露真实 API**，其它帧给空壳。本项目 hash 通道的替代路线：自定义协议 origin + `initialization_script` 注入 + `postMessage` 双向通道，契约里带 `protocolVersion` 以便未来演进。
3. **首帧注入统一收集、一次交付**：Host 收集 → IPC → 渲染层 `boot.ready()` 拉取。本项目 appearance 线已有 `index-inject`，可把"多插件注入物"收敛成一个交付点，天然解决防闪色的时序问题。
4. **主题调色板回传原生 chrome**：渲染层上报实测 `color/symbolColor`（带格式校验 + 来源帧校验），壳再更新标题栏。本项目 titlebar v4 / 三主题线可直接据此替换"壳内硬编码兜底色"。

**P1 — 产品体验与可靠性**

5. **"关闭 = 隐藏到托盘"的一次性确认 + marker 记忆**：避免"关不掉"的困惑，又不重复打扰。
6. **退出前问后端"会打断什么"**：结构化 `quit-inspection`（活跃任务 + 定时提醒）+ 检查失败按"有任务"处理的 fail-safe。本项目当前是"探测外部客户端决定是否停后端"，两者可合并成更完整的退出编排。
7. **更新/危险操作前的准入锁**：`503 + 排空在途请求 + 复核活跃任务`，任务停不下来就明确拒绝，而不是强杀。
8. **崩溃本地留档 + 三按钮恢复**：保留 10 份、带 renderer console 尾部；恢复选项里的"停用第三方插件后重启"对本项目插件密集的现状尤其对口（等价于本项目手动清 `cordis.patch.yml`）。
9. **peer 兼容性闸门与 `compatibility.json` 豁免**：本项目插件要么不声明 DSH peer（当前主插件如此，无约束），要么就得接受上界约束（desktop 线 3 个插件的 `<0.3.0` 上界是已知隐患）。

**P2 — 工程细节**

10. `ELECTRON_RUN_AS_NODE=1` + `runtime/bin/node.cmd` 转接脚本：**用 Electron 二进制当 Node**，省掉一份 ~100 MB 运行时（Tauri 无此路径，但"复用宿主二进制"思路可迁移到"复用系统 node"）。
11. asar 内原生二进制的 resolve hook 重定向到 `app.asar.unpacked`：asar 打包的通用教训，本项目若将来用 asar/资源归档会直接踩到。
12. 注意力提示用"任务栏闪烁 + 系统通知"而非红点（每版本一次、失焦才提示）——本项目桌宠气泡已有更细的提醒模型，可只借鉴"失焦才提示"的节流策略。
13. 内嵌浏览器同时提供 `WebContentsView` 叠加与 `<webview>` 两条路线，视图走独立 partition 的租约语义。

**P2 续 — 可靠性契约与工程规范（源自三名调查员的逐行核对）**

14. **双保险互斥**：单实例锁（`requestSingleInstanceLock`）**加上** profile 级 pid 文件锁（`wx` 创建 + `kill(pid,0)` 判活 + 陈旧锁回收 + `finally` 必删）。本项目多条线都会写 `~/.dsh` 下的状态，这层防护能挡住"两个实例同时写同一 profile"这类最难复现的数据损坏。
15. **优雅停机分级 + ack 门槛**：应用层 shutdown 请求 → 等 10s → `SIGTERM` → 5s → `SIGKILL`。对本项目 sidebar（node-pty 终端）、ssh（会话/转发）尤其对口：先请求、再杀、最后强杀，否则会留下孤儿 pty 与悬挂连接。
16. **每处 IPC 三查 + 乐观锁**：`event.sender === owner.webContents`、`event.senderFrame === mainFrame`、`frame.url` 的 origin 落在白名单内；带状态的写操作再叠一个 `revision` 拒绝陈旧请求（改键、更新对话框应答、窗口关闭都这么做）。
17. **租约式内嵌视图**：`acquire(workspace) → {lease, partition}`，渲染层用一次性占位 URL（`about:blank#<lease>`）握手，主进程**丢弃渲染层提交的 webPreferences 并写入自己的硬策略集**，导航离开 / 渲染进程崩溃 / 窗口销毁一律批量释放。本项目 sidebar 的"底部面板与右栏 tab 共享同一 pty 的两个 viewer"正需要这种"多 viewer、一份会话、各自终结"的模型。
18. **注入物命名与降级约定**：`window.__DSH_*` 常量式注入，且**每个注入物在前端都有 web 回落**（`__DSH_DIRECTORY_PICKER__` 缺失时退回 `ctx.uiWorkspace.pickDirectory()`）——桌面能力是增强项而非硬依赖，与本项目"关掉即原生"的硬契约同源。
19. **快捷键偏好的文件规范**：`schemaVersion` + 按平台分 profile（`desktop|web:windows|macos|linux`）+ 域名式命令 id + `revision` 乐观锁 + 结构化的冲突/保留组合判定；**改键不另开录制窗口**，只用"录制标志 + 暂停派发"。
20. **一次性原生提示 + marker 文件**：首次"关闭到托盘"确认后写 `userData/background-close-confirmed`，此后静默。marker 让交互**可重放、可测试**（删文件即回到首次态）——比"每次问"或"永久静默"都更好验证。
21. **状态广播与"红点"解耦**：壳只广播语义状态（`phase/version/percent/failure`），红点由前端决定；原生侧只做一次性注意力（任务栏闪烁 + 静默通知），且失焦才提示、聚焦即清。
22. **本地服务用端口 0 + 回传实际端口**：官方把 19387 硬编码进宿主，代价是要为 `EADDRINUSE` 写专门文案与分支。本项目自研服务（素材服务 39800 等）建议一律绑 0 端口再回传，从根上消除互斥解释成本。
23. **模态 UI 双形态共用一份实现**：Windows 用"主文档内嵌 iframe + closed shadow root + `MessageChannel` + 吞掉背景按键"，其它平台用"透明无边框子窗跟随父 bounds"，**共用同一份 HTML/CSS 与同一套 revision 校验 IPC**。
24. **协议唤起只接受白名单形态**：`setAsDefaultProtocolClient` + `open-url` 只识别固定形态后聚焦既有窗口，配合单实例锁导流二次启动；本项目若做 `dsh-miasaki://` 唤起，务必不做"任意 URL 参数执行"。
25. **敏感值不落盘、不落日志**：更新台账字段白名单化、下载页过 origin 白名单、账号 token 只驻内存（宿主 → 壳 → 内嵌视图 `sendSync` 一次性下发）、cookie 只落独立 partition。本项目 SSH/终端插件接本地服务时应照此办理，而不是把 token 注入 `window`。
26. **"清单 + 逐文件 sha256"二合一是好模式，但生成脚本必须自校验**：官方 `desktop-runtime.json` 尾部 `}` 被 asar 条目 size 截断（声明 2,797,255 B、实际 2,797,253 B），随包分发的 JSON **用 `JSON.parse` 会直接失败**。本项目若做同构 manifest（`MANIFEST.json` 等），生成后必须 `JSON.parse` + 字节数双重自校验后再入库/打包。
27. **asar/资源归档的解包规则要按"含原生二进制的包"精确列举**，不要按扩展名或整目录贪心：官方按包目录 glob 解包，连带把 pnpm 解析出的纯 JS 传递依赖闭包一起落盘，**约 18.5 MiB 属于陪跑**（`@swc/helpers` 438 个 JS 文件、`fontkit` 127 个）。
28. **版本清单只保留一份**：官方同时存在 `versions.json`（无引用、写 24.18.1）、`runtime.json`（写 24.21.0）与 `desktop-runtime.json`（写 24.18.1）三处口径，而真实 `node.exe` 是 24.21.0——**三处已分歧**。本项目 desktop 线的 `themes/src/MANIFEST.json` 等清单不应再引入第二份版本来源。

### 8.3 不建议照搬

- **1 GB 体积与内置 LibreOffice/Python**：与"薄壳 + 用户既有环境"的本项目定位冲突；Office 能力若要，更合理的是按需安装（本项目已有 `dsh-miasaki-desktop/plugins/` 插件机制）。
- **强制更新（服务端 `code 40005` 阻断）**：适合官方集中分发，不适合本地自研壳；可取其"更新前准入 + 失败明确拒绝"的语义，去掉"阻断使用"。
- **Electron 路线替换 Tauri**：本项目已投入桌宠（分层窗、逐像素 alpha、内联审批、主题联动）等 Electron 难以等价实现的资产，替换成本远大于收益。

### 8.4 本项目相对官方的优势与不可放弃项 `[实测 + 推断]`

对照不是为了照抄，下面几条本项目已领先或路线不同，参考时应保留：

| 维度 | 本项目 | 官方桌面端 |
|---|---|---|
| 后端存活 | **2s 探测 + 2s→30s 退避重拉 + 错误页重新导航**（2026-09-23） | **无心跳、无自动重启**：宿主挂了只能靠 2s/10s 控制超时暴露，或用户点 Restart |
| 桌宠与原生装饰 | 分层窗逐像素 alpha、六态状态机、内联审批、fleet 指示、点击穿透、不夺前台 | 无桌宠；只有托盘图标与窗口材质 |
| 主题体系 | 令牌层覆盖（105 token）+ 首帧防闪色 + 壁纸/玻璃档位 + 三主题 | 仅"标题栏 overlay 色回传" + 欢迎窗 tint token；主 UI 未使用材质 token |
| 分发体积 | 单 exe 41 MiB（MSI 37.5 MiB / NSIS 35.8 MiB） | 1,010 MiB（含 LibreOffice 引擎 182 MiB 与 Python 运行时） |
| 环境共存 | 复用用户既有 `dsh` 与 `profiles/web`，浏览器/CLI/桌面端共享同一环境 | 自带整套运行时，与用户 npm 安装的 dsh 仅共享 `~/.dsh` 数据 |

> `[推断]` 官方路线是"把不确定性全部收进包内"，本项目路线是"薄壳 + 复用既有环境 + 更强的自愈与表现层"。两者在**协议层与可靠性契约**上可以互相取长：本项目需要补的是"正式契约 + 崩溃/退出/更新编排"，而官方的体积与分发模型不适合用来替换本项目的桌宠与主题资产。

---

## 9. 与本项目插件线的互操作（迁移可行性）

`[实测]`：

1. **数据层已互通**：`~/.dsh` 是 home 级共享目录（`sessions/`、`storages/`、`.credentials.yaml`、`AGENTS.md`、`.agent-presets/`），官方桌面端与 `dsh web` 看到同一批会话与凭据；差异只在 `profiles/<name>`。
2. **版本一致**：`~/.dsh/profiles/node_modules/@deepseek-ai/dsh` = `0.1.7-rc.2` = 官方桌面端 runtime 版本。
3. **peer 闸门不阻塞**：本项目 5 个主插件（appearance/canvas/sidebar/ssh/dual-model）**未声明** `@deepseek-ai/dsh*` peer；desktop 线 5 个插件声明的 `cordis ^4.0.2`、`dsh-settings >=0.1.2-rc.1 <0.3.0`、`dsh-host-webserver >=0.1.2-rc.1 <0.3.0` 在 0.1.7-rc.2 下均满足，且 `dsh-settings` / `dsh-host-webserver` 两个包在 asar 内齐备。
4. **迁移动作**（若要让本项目成果出现在官方桌面端）：在 `~/.dsh/profiles/desktop/package.json` 增补 `dependencies`（`link:` 本地源码或 npm 包）与 `dsh.profile.bundles` 列表；`cordis.patch.yml` 保持为空模板即可（bundles 层已提供条目）。**注意**：官方桌面端会随 nightly 自动更新（app.asar 整包替换），而 profile 位于 `~/.dsh` 不受影响；但**升级到 0.2.x 时** desktop 线三个插件会被 `<0.3.0` 上界拦下（主插件无 peer 声明，不受影响）。
5. **风险提示**：官方宿主会调用 `sanitizeProfile` 在致命错误时"停用第三方插件"，处置对象正是 profile 的 `cordis.patch.yml` 与 bundle 列表；把本项目插件写进 bundle 列表后，这条恢复路径会一并作用于我们自己的插件——建议迁移时保留一份 profile 备份流程（本项目已有备份惯例）。

---

## 10. 附录：证据索引

| 证据 | 位置 |
|---|---|
| 桌面壳主进程 bundle（11,695 行 / 57 region） | `F:\sud\dsh-desk\resources\app.asar!lib/main.js` |
| 渲染层 preload 契约 | `...!lib/preload-app.cjs`（775 行附近为 `createProductApi`） |
| Host 宿主包 | `...!dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`（367 行） |
| profile/bundles 机制权威文档 | `...!dsh/node_modules/@deepseek-ai/dsh-app-boot/README.zh.md` |
| 更新配置 | `F:\sud\dsh-desk\resources\app-update.yml` |
| 内置运行时身份 | `F:\sud\dsh-desk\resources\runtime\primary-runtime\runtime.json`、`runtime\versions.json` |
| Node 转接脚本 | `F:\sud\dsh-desk\resources\runtime\bin\node.cmd` |
| 运行环境变量（本会话） | `DSH_PROFILE=desktop`、`DSH_PROFILE_DIR=~/.dsh/profiles/desktop`、`DSH_WEB_URL=http://127.0.0.1:19387` |
| 两个 profile 的装配 | `~/.dsh/profiles/{desktop,web}/package.json`、各自 `cordis.patch.yml` |

> **关于源码可见性** `[实测]`：工作区既有的官方仓库 checkout（`_refs/deepseek-harness/`，版本 `0.1.1-rc.1`）**不含任何 desktop 相关目录**（`apps/` 下只有 `cli` 与 `web`）。也就是说本次分析的全部桌面壳实现只能来自随包分发的 asar 产物——**没有可对照的上游源码**，因此本文所有结论都以 asar 内代码与实际运行痕迹为准，并经四名独立调查员分主题逐行核对（进程/宿主、窗口/协议/契约、更新/引导/恢复、发行工程）。

> 说明：本次分析为只读调研，未修改官方安装目录，也未改动本项目任何线的代码。解包出的桌面壳源码（1.2 MiB，38 个文件）已归档为 `_refs/official-desktop-shell-0.1.7-rc.2/`（`_refs/` 已 gitignore，不属于任何一线）；一次性探针脚本归档到 `_refs/scripts-archive/`，可按需重新解包。
