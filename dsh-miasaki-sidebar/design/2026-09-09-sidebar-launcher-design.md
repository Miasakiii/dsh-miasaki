# 标题栏启动器组设计 — 外部程序跳转按钮 + 终端展开按钮（内嵌终端面板）

- 日期：2026-09-09
- 状态：**设计定稿（未写代码）**；两个前置 spike（S1 node-pty、S3 底部推挤）为本设计的立项门
- 用户参考图：VS Code 风格「外部程序选择器」下拉（主图标按钮 + 下拉箭头；菜单：资源管理器 / VS Code（✓ 当前）/ VS Code Insiders）
- 关联：本线 `2026-09-06-sidebar-roadmap-design.md` §6（两段式终端：M1 启动器 / M3 内嵌规划）；
  SSH 线 `2026-09-09-ssh-design.md`（`registerUpgrade` 已验证可用的 S2 结论、xterm vendor 静态资源服务方案）

## 1. 目标与用户拍板

在桌面壳标题栏按钮组（`.tb-group`）内新增**两个按钮**，紧邻既有侧栏按钮，排列（自右向左）：

```
[外部程序跳转] [终端展开] [侧栏] [徽章] [min] [max] [close]
                ▲ 本次新增    ▲ 既有（sidebar 插件注入）
```

1. **外部程序跳转按钮**：VS Code 参考图同款 split button——主键显示**当前默认程序**的彩色图标，点击直接打开该程序到当前会话工作区；下拉箭头展开菜单（资源管理器 / VS Code / VS Code Insiders，当前项带 ✓），点菜单项 = 打开 + 设为默认。
2. **终端展开按钮**：点击**展开/收起底部终端面板**（VS Code 肌肉记忆：窗口底部横贯面板，xterm + node-pty + WS 路由）；再点收起，面板内终端进程**保活**。

用户拍板（2026-09-09）：按钮位置 = 标题栏按钮组、侧栏按钮左侧；终端语义 = **展开内嵌终端面板**（非系统终端启动器）；面板形态 = **底部终端面板**。

### 1.1 为什么落在 sidebar 线

- 标题栏按钮注入本就是 sidebar 插件的职责（`client.js` `syncTitlebarButton()` 已注入 `.tb-sidebar`，双环境自切换）；
- 底部终端面板需要 host 侧能力（pty + WS + 静态资源服务），desktop 线是 Tauri 薄壳（Rust 只读、单 hash 通道），没有 Node 运行时；
- 本线 §6.2 已规划内嵌终端（node-pty + xterm + WS），本设计是将该规划**从「仅规划」推进为「已立项、M3 启动」**，并按用户拍板的形态（底部面板 + 标题栏按钮）收敛；
- 参考 SSH 线已验证的 DSH 官方能力：`WebServer.registerUpgrade`（SSH 线 S2 通过）、host 路由 serve 静态文件（SSH 线 S3 部分通过）——本设计直接复用，不再重复论证。

## 2. 现状核对（本机 2026-09-09 实测）

| 项 | 现状 |
|---|---|
| 标题栏组 DOM | `#miasaki-titlebar > .tb-group`（V4 裸键组）：`[tb-sidebar] [tb-brand] [min] [max] [close]`，`tb-sidebar` 由 sidebar 插件 `group.insertBefore(button, group.firstChild)` 注入 |
| 让位 | desktop `themes/src/03-switcher.js`: `#root header:has([role="tablist"]){padding-right:118px}`——**写死值**，按“徽章 16+4 + 三键 26×3 + gap ≈108px + 10 余量”核算；tb-sidebar 注入后组宽 ≈130px，已逼近让位上限，**再加两键（+52px）必然与 header actions 叠压**（§5 处理） |
| 外部程序可达性 | `where.exe code` → `…\Microsoft VS Code\bin\code.cmd`；`Code.exe` 位于同级 `..\Code.exe`（本机确有 `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe`）；`explorer.exe` 在 System32（恒在）；**本机未装 Insiders**（UI 置灰，验证降级路径） |
| 会话 cwd | `store.reviewCwd`（sessions 服务 + 1.5s watchdog），已有 `resolveWorkdir()` 绝对目录校验 |
| pty 通道 | 本线未验证；SSH 线 S2：`ctx.get('webServer').registerUpgrade` 可注册 upgrade 路由，无冲突 |
| xterm 资源 | 未引入；SSH 线方案：host 路由从 `node_modules/@xterm/xterm/lib/xterm.js` serve（`main` 即该路径，无运行时依赖，MIT） |
| node-pty | 未引入；**Windows 需 VS Build Tools 编译，是本设计唯一硬前置**（SSH 线明言“规避 node-pty 是选 ssh2 的主因”） |

## 3. 外部程序跳转按钮设计

### 3.1 程序目录（host 侧固定枚举，客户端不可指定）

```js
// index.js —— 与 TERMINAL_SHELLS 同纪律：固定枚举 + argv 数组 + 无 shell
EXTERNAL_APPS = [
  { id: 'explorer',        label: '资源管理器',   icon: 'explorer',        bin: 'explorer.exe' },
  { id: 'vscode',          label: 'VS Code',       icon: 'vscode',          bin: 'Code.exe',   fromCmd: 'code.cmd' },
  { id: 'vscode-insiders', label: 'VS Code Insiders', icon: 'vscode-insiders', bin: 'Code - Insiders.exe', fromCmd: 'code-insiders.cmd' },
]
```

**解析规则 `resolveAppExecutable(app)`（纯函数，可单测）**：

1. `explorer`：System32 恒在 → `join(process.env.SystemRoot, 'explorer.exe')`（不依赖 PATH，explorer 是系统组件）；
2. `vscode` / `vscode-insiders`：先测**已知安装路径**（Windows 用户级 / Program Files 两级 + bin 上溯），再 fallback `where.exe <fromCmd>` 拿到 `bin\code.cmd` 路径后 **`resolve(join(dir, '..', 'Code.exe'))`** 静态上溯（不解析 cmd 内容、不 spawn cmd）；所有候选路径都要 `stat` 确认存在，**无存在路径 → `available: false`**；
3. 任何情况下**不执行**程序做探测（与终端启动器第 4 条同纪律：`where`/`stat` 都不闪窗）。

**为什么绕开 `code.cmd` 本身**：cmd 是批处理，spawn 需 `cmd /c` 包装或 `shell:true`，而 cwd 会经 cmd 的解释器（引号/元字符解析），违反本线「永不拼命令字符串」红线。直接定位 `Code.exe`（GUI 原生 exe）后 `spawn(bin, [cwd])` 即纯 argv，与红线一致。

### 3.2 host 路由与安全边界

| 路由 | 方法 | 用途 |
|---|---|---|
| `/sidebar/api/apps/options` | GET | `{ apps: [{ id, label, icon, available, bin? }], fallback }`（探测结果；fallback = 第一个 available） |
| `/sidebar/api/apps/open` | POST `{ app }` | 打开 `cwd = resolveWorkdir(body.cwd)`（绝对 + 已存在目录，同 terminal/open）；`EXTERNAL_APPS` 枚举白名单；`available === false` → 400「未安装」；spawn `{ detached:true, stdio:'ignore' }` + unref，无 shell |

- explorer 特判：`spawn` 后**不等待 exit 码**（explorer 把目录交给现有窗口后即退出且码不稳定），`spawn` 事件成功即视为已打开；
- 菜单仍展示 `available: false` 项（**置灰 + 「未安装」注记**，不静默隐藏——与终端类型单选同款纪律：用户应知道选项存在但不可用，参考图菜单的完整性优先）。
- 打开目标恒为**当前会话 cwd**（`store.reviewCwd`，客户端随请求附上，与 diff/terminal 一致）。

### 3.3 UI（client 侧，参考图对齐）

**标题栏版按钮**（`.tb-btn` 家族，26×26 透明底同规格），拆两件：

- 主键 `.tb-apps-main`：显示当前默认程序图标（16px 内联 SVG 彩色），`title` 用默认程序名；点击 → `POST /apps/open`（无会话 cwd → 置灰）；
- 箭头键 `.tb-apps-arrow`：`⌄`（11px 线形 SVG，与窗控图标同视口），点击 → 展开菜单。

**菜单**：复用现有 `.dsh-sidebar-popover` / `.dsh-sidebar-menuitem`（8px 圆角、28px 行、令牌色），`role="menu"` + `menuitemradio`；每行 = 16px 彩色图标 + 标签 + 右侧 ✓（`aria-checked` 当前项，**✓ 走 label-primary**，不用 checkbox 占位——参考图即行尾 ✓）。菜单项点击：`POST /apps/open` + `localStorage 'miasaki-sidebar:app:v1'` 持久化默认 id（全局，不做会话级——打开哪个程序是个人偏好）。

**图标**：client 内联 SVG 常量（16px）：资源管理器=黄文件夹（`#f7a35c` 系）、VS Code=官方蓝（`#007acc`）、Insiders=官方青绿（`#00b294`）。VS Code Logo 用 simple-icons 公开 path（MIT），避免再画一版。

**浏览器环境 fallback**：无桌面壳时，同一组件注册进 `conversation.session.header.actions` 槽（order 26 / 28 / 30：`apps`、`terminal`、`sidebar`——注意 actions 槽**左→右升序**，与标题栏的左右镜像关系要经 screenshot 校准一次，保证两环境顺序一致「外部程序→终端→侧栏」）。

### 3.4 无 cwd 时的行为

无会话/无工作区 → 两键均置灰（`title` 提示“打开一个带工作区的会话后可用”）；与终端 tab 现有提示文案风格一致。

## 4. 终端展开按钮 + 底部终端面板

### 4.1 面板形态（用户拍板：底部横贯面板）

```
┌──────────────────────────────────────────────────┐
│ ▸ 终端    C:\Users\...\dsh-miasaki（省略中段） ⧉ × │   ← 头部 32px：终端图标 + cwd（缩略，title 全文）+ 复制 + 关闭
├──────────────────────────────────────────────────┤
│                                                  │   ← xterm 主体（fit addon，跟随面板尺寸）
│                 xterm (256 色 / 等宽)             │
│                                                  │
└──────────────────────────────────────────────────┘
```

- 默认高 **260px**，上缘 6px 拖拽把手，clamp **120–480px**；`localStorage 'miasaki-sidebar:term:v1'` 记 `{ open, height }`（全局键，跨会话）；
- 样式全部走 `--dsw-*` 令牌：面板底 `--dsw-alias-bg-layer-1`、上边 `.5px solid --dsw-alias-border-l3`（同侧栏面板）、xterm 主题由 `getComputedStyle` 读令牌映射（bg/foreground/selection，三主题零桥）；
- z-index **60**（与侧栏面板同层，低于 canvas 100——canvas 全屏盖住终端面板为预期）；与侧栏面板同时打开时两者各自独立（终端面板 `bottom:0` 全宽、侧栏面板 `right:0` 全高，视觉上终端面板纵贯侧栏之下，无需第 3 个 z 值，截图校准即可）；
- `aria-expanded` 在按钮上，面板 `role="region" aria-label="终端"`。

### 4.2 推挤（与侧栏同构，变量化）

新增 `--miasaki-terminal-height`（`<html>` 上，与 `--miasaki-sidebar-width` 并列）：

- 常驻 CSS：`#root > [data-slot="root"] > div, ${FRAME_FALLBACK_SELECTOR}{padding-bottom:var(--miasaki-terminal-height,0px)}`；
- 与既有 `padding-right` 推挤**可共存**（两个独立变量，grid 的两个 padding 方向互不干扰——**S3 spike 验证**：DSH AppFrame grid 是单行三列，`padding-bottom` 压缩的是整行高度，center 列自身不滚动，正文区应随底边收缩；若实测 grid 行高不被 padding 吸收，则降级为**浮层面板 + 收主区高度**不可行 → 改为浮层（不动布局，面板盖住底部 260px，用户可拖高），并把结论记入本文档）；
- **不推挤的视口**：与侧栏不同，底部推挤不影响 center 宽度，**无 1280px 下限**（宽度吃紧与高度吃紧是两回事）；<768px 抽屉语义下终端面板同样全宽浮层（高度兜底 45vh 上限）。

### 4.3 pty 生命周期（单实例，M1）

| 事件 | 行为 |
|---|---|
| 首次点击终端按钮 | 懒加载 xterm（`<script>` 拉 `/sidebar/vendor/xterm.js` + css + addon-fit）→ WS 连 `/sidebar/ws/terminal` → `attach { shell, cwd, cols, rows }` → host `pty.spawn`（shell = 内嵌集合探测第一个可用）→ `ready` 回帧 → 渲染 |
| 再次点击（收起） | 面板隐藏（keep-mounted），发 `detach`；**pty 保活**（进程继续跑，输出进 host 侧 1MB 环形缓冲） |
| 第三次点击（展开） | 重连 WS → `attach` → host 回放 scrollback（`replay` 帧，截断到最近 200KB）+ `ready` |
| pty 退出（用户敲 exit） | `exit` 帧 → 面板显示「进程已退出 [重启]」；重启 = 同一 cwd 新 spawn |
| 会话切换（cwd 变化） | **不自动重启**（避免误杀用户运行中的任务）：面板头部下显示非阻塞提示条「会话工作区已切换 — [在新工作区重启终端]」；已运行的 pty 继续在旧 cwd |
| 切页 / 切会话不丢 | pty 挂在 host 进程内存（`TerminalSession` 单例），与页面生命周期无关；DSH host 重启才终止（桌面壳 + DSH 同进程，可接受） |
| 插件卸载 | WS 服务销毁时 tracked socket 关闭（`registerUpgrade` 文档行为），pty 一并 kill（effect 清理） |

**内嵌 shell 集合**（新表，区别于 `TERMINAL_SHELLS`——wt.exe 是容器不适合 pty）：

```js
PTY_SHELLS = [
  { id: 'pwsh',       bin: 'pwsh.exe',       platform: 'win32' },
  { id: 'powershell', bin: 'powershell.exe', platform: 'win32' },
  { id: 'cmd',        bin: 'cmd.exe',        platform: 'win32' },
  { id: 'bash',       bin: 'bash',           platform: 'darwin' | 'linux' },
]
```

探测 = PATH 查询（同 `probeShell`）；**客户端只可报 id，shell 参数只给 `[]`**（pty 的 cwd/cols/rows 均是 option 位，不进 argv——恶意 cwd 无法进入命令解释层面；与启动器的 argv 纪律对齐）。

### 4.4 WS 路由与帧协议

`/sidebar/ws/terminal`（`registerUpgrade`，精确路径）。帧（JSON，复用 SSH 线协议形状，语义本地化）：

```jsonc
// Client → Host
{ "type": "attach", "shell": "pwsh", "cwd": "C:\\...", "cols": 120, "rows": 32 }   // 首次连接 = spawn；重连 = 回放
{ "type": "input",  "data": "ls\r" }
{ "type": "resize", "cols": 120, "rows": 32 }
{ "type": "detach" }

// Host → Client
{ "type": "ready",  "shell": "pwsh", "pid": 1234, "cwd": "..." }
{ "type": "replay", "data": "..." }        // attach 后立即回放 scrollback（仅在重连时）
{ "type": "output", "data": "..." }
{ "type": "status", "state": "running|exited", "code": 0, "signal": null }
{ "type": "error",  "code": "SHELL_MISSING|CWD_INVALID|PTY_FAILED", "message": "..." }
```

- 路由围栏：upgrade 请求同 `/sidebar/api` 三道（Host trusted + `sec-fetch-site` + Origin hostname 比对——`registerUpgrade` 的 handler 能读 `req.headers`，SSH 线探针已确认）；**PTY 只对 ws 帧内 `cwd` 负责，路由层不做 cwd 假设**；
- shell 校验：`PTY_SHELLS` 白名单 + `available` 探测；cwd 校验：`resolveWorkdir` + `assertDirectory`（复用）。

### 4.5 依赖与体积

| 包 | 版本（registry 核实） | 用途 | 备注 |
|---|---|---|---|
| `@xterm/xterm` | 6.0.0 | 前端终端 | `main: lib/xterm.js`，**无运行时依赖**，`css/xterm.css`；UMD 直接 `<script>` |
| `@xterm/addon-fit` | 0.11.0 | 自适应尺寸 | 无运行时依赖 |
| `node-pty` | 1.1.0 | host 侧 pty | **Windows 需编译**（见 §6 S1）；这是 M3 立项门 |

资源服务：`/sidebar/vendor/xterm.js` / `/sidebar/vendor/xterm.css` / `/sidebar/vendor/addon-fit.js`（host 从 `node_modules` 读，`import.meta.url` 上溯定位包根）；浏览器缓存 + **懒加载**（首次展开面板才注入 script，一次性约 400KB 解压，SSH 线同款策略）。

## 5. 标题栏让位（跨线最小改动）

桌壳标题栏窗口按钮组**加宽**后，desktop 的写死让位 `padding-right:118px` 必须先改，否则与 header 右侧 actions 叠压（这是本次唯一的 desktop 线改动点）：

| 文件 | 改动 |
|---|---|
| `dsh-miasaki-desktop/themes/src/03-switcher.js` | `padding-right:118px` → `padding-right:var(--ms-titlebar-reserve, 118px)`（保留默认值，变量缺失行为不变） |
| `dsh-miasaki-sidebar/client.js` | `measureChromeReserve()` 扩展：量测 `.tb-group` 实际宽度 `W` → 写 `document.documentElement.style['--ms-titlebar-reserve'] = W + 12px`（浏览器环境无 tb-group → 不写变量，5 分钟内 desktop 壳默认 118px 兜底；desktop 环境按钮注入与量测同一次 `syncAll` 完成） |

- 增量核算：组宽 ≈ `26×2（新增）+ gap 2×2 + 既有 130 ≈ 186px` → 变量写入 ≈ 198px；desktop 无需再写死新值；
- 头部让位对浏览器环境零影响（规则在 desktop 主题 CSS 里，浏览器不加载）。

> **落地状态与前提变更（2026-09-10，记录 desktop 线事实）**：变量化已在 desktop 侧**先行落地**，
> 但两条前提发生了变化，实施 M3 时以本注记为准：
> 1. **本节的触发前提已作废** —— 标题栏按钮注入（`syncTitlebarButton`）随自研壳于 2026-09-10
>    退役（见 `design/2026-09-10-migrate-to-official-rightbar.md`），组宽不再由本线加宽（维持
>    108px），故「必须先改 118px」与「`W + 12px` 量测写入」都不再是必需项；
> 2. **变量已存在且语义已升级** —— `themes/src/03-switcher.js` 现自行声明
>    `:root{--ms-titlebar-reserve:128px}`，含义从「让位宽度」变为**距窗口右缘的安全线**
>    （窗控组 116px + 12px 呼吸位），并用于让位 DSH 0.1.5 官方右栏的两处控件（会话头
>    `[data-conversation-header-corner]` 的展开按钮、dockkit `[data-dockkit-strip-chrome]`
>    的全屏/收起两键）。明细见 `dsh-miasaki-desktop/design/CHANGELOG.md` 2026-09-10(晚) 条目。
>
> 兼容性：若本线将来重启标题栏入口，`measureChromeReserve()` 写
> `document.documentElement.style['--ms-titlebar-reserve']` 的 inline 变量**会自动覆盖**
> desktop 的 `:root` 默认值，两侧均无需再改选择器。

## 6. SPIKE 清单（立项门，M1 实现前）

| 编号 | 验证项 | 状态 | 结论 / 备选 |
|---|---|---|---|
| S1 | **node-pty 在 Windows 编译 + pty.spawn(pwsh) 冒烟**（以 **DSH host 实际进程的 Node 版本**为编译对象——先确认 host node 版本，再在本机同版本下 `npm i node-pty`） | 待验证 | 失败 → 备选预编译 fork（node-pty-prebuilt 系）；再失败 → 终端按钮降级为「打开系统终端」复用现有 launchTerminal（功能仍成立，仅面板形态变） |
| S2 | `/sidebar/ws/terminal` 注册升级路由无冲突（SSH 线已证 API 可用，本线只需验证命名空间 + 与现有 `/sidebar/api` prefix 路由共存） | 待验证 | 无 |
| S3 | **frame `padding-bottom` 推挤**：真实 AppFrame grid 下主区高度收缩 & 与 `padding-right` 并存（浏览器 spike，同 §3.1.1 手法） | 待验证 | 不吸收 → 底部面板改浮层（记录于 §4.2） |
| S4 | `code.cmd` → `Code.exe` 静态上溯规则本机实测（含 Insiders 缺失置灰路径、便携版/System32 变体） | 待验证 | 无 |
| S5 | xterm UMD 经 host 路由 serve + 懒加载 `script` 注入冒烟（SSH 线部分通过，本线补 xterm 具体文件） | 待验证 | 无 |

**顺序**：S1 → S3 → S5 → S2/S4（S2 已被 SSH 线证明，风险最低）。

## 7. 里程碑与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M3 立项（本次拍板）** | 标题栏两按钮 + 外部程序跳转（explorer/Code/Insiders）+ 底部终端面板（内嵌 pty 单实例 + 回放） | 三主题 + 桌面壳：按钮顺序「外部程序→终端→侧栏」、菜单 ✓/置灰/持久化默认打开正确；终端面板展开/收起 pty 保活、resize 跟手、`vim`/`htop` 全屏 TUI 刷新正常、切会话提示条可用、与侧栏面板同开无叠压 |
| **M2（后续）** | 多 pty 实例 / Ctrl+` 快捷键 / 会话切换自动跟随（可配置）/ 外部程序自定义注册 | 用户使用后按痛点立项 |

M1（启动器/审查/侧栏）状态不变；**底部面板落地后，启动器降级为「备胎按钮」**（§6.3 已规划）——终端按钮只挂内嵌面板，启动器入口保留在侧栏「终端」tab 内。

## 8. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| node-pty Windows 编译失败（VS Build Tools 依赖） | 阻断内嵌面板 | S1 前置；降级路径 = 按钮打开系统终端（现成 launchTerminal），功能语义不变 |
| DSH 升级改动 `registerUpgrade` / AppFrame grid | 面板或推挤失效 | 官方 API（SSH 线已作为设计基石）；S3 实测固化；升级后随 verify-themes 回归 |
| 底部推挤使主区高度过小（长会话 + 大终端面板） | 对话区被压扁 | 高度 clamp 上限 480px；面板占屏高比 <50% 校验（S3 附测）；必要时浮层降级 |
| xterm 全屏 TUI 回放错乱 | 切回花屏 | M1 提示 `Ctrl+L`（SSH 线同款）；不维护最小屏幕快照 |
| 让位变量在两线间时序差（desktop CSS 未及时更新） | 右上角叠压 | 变量保留 118px 默认；CHANGELOG 与 README 双线同步；真机截图验证 |

## 9. 决策记录

| 日期 | 决策 |
|---|---|
| 2026-09-09 | 用户拍板：标题栏按钮组新增两按钮（外部程序跳转 / 终端展开），位于侧栏按钮左侧；终端 = **展开内嵌终端面板**（非系统终端启动器）；面板形态 = **底部横贯面板** |
| 2026-09-09 | 落点 = sidebar 线（desktop 仅让位变量化一处）；内嵌终端从 §6.2「仅规划」升为 M3 立项，前置 spike S1（node-pty）为硬门，失败降级「打开系统终端」 |
| 2026-09-09 | 外部程序 = 固定枚举三件（explorer / vscode / vscode-insiders），`Code.exe` 静态定位绕开 `code.cmd` 批处理（红线：永不拼命令字符串）；未安装项置灰不隐藏；默认选择全局持久化 |
| 2026-09-09 | pty 生命周期 = 单实例 + 面板收起保活 + 重连回放；会话切换不自动重启（防误杀），仅提示条 |
| 2026-09-09 | 底部推挤 = `--miasaki-terminal-height` 变量与 padding-right 并存、**无 1280 下限**（高度推挤与宽度吃紧无关）；S3 不吸收则浮层降级 |
