# @miasaki/dsh-ssh 设计文档

- 状态：**M1 实现中**（2026-09-09）；store / runtime / host 路由 / WS 桥 / 前端页面 / 单测（16 例）已完成并已 link 安装，SPIKE **S1–S5 全部通过**（见 §9）；待重启 `dsh web` 后浏览器上验证真实连接（验收标准见 §7）
- 线：`dsh-miasaki-ssh/`（本仓第五条线）
- 上游参照：无 fork，全新自研
- 相关线：`dsh-miasaki-canvas`（视图切换同族）、`dsh-miasaki-sidebar`（终端启动器 / M3 内嵌终端底座复用）

---

## 1. 背景与目标

### 1.1 需求

在 DSH web 的会话头切换区集成一个 **SSH 入口**，点击切换到 SSH 页面，实现连接云服务器、在页面内交互式操作远程 shell。

### 1.2 目标

| 编号 | 目标 | 判定 |
|---|---|---|
| G1 | 会话头出现 SSH 切换入口 | 会话 tab 栏出现「SSH」，与「对话 / 轨迹 / Token 监控」并列 |
| G2 | 页面内交互式终端 | vim / htop / Ctrl+C / 窗口 resize 全部可用 |
| G3 | 连接管理 | 主机库 CRUD、密码 / 私钥 / agent 三种认证 |
| G4 | 连接保活 | 切走视图、刷新页面不断连（host 侧持有连接） |
| G5 | 主机指纹校验 | TOFU 首次确认；指纹变更拒绝并告警 |
| G6 | 安全边界 | 三道浏览器围栏；凭据不落前端存储 |

### 1.3 非目标（M1 明确不做）

- 不做 SFTP 文件传输（M2）
- 不做跳板机 / 端口转发（M3）
- 不做与 agent 的联动（M3）
- 不做多用户 / 团队共享（本项目是单机自用形态）

### 1.4 红线（沿用 canvas / sidebar）

- 不改系统提示、模型请求、工具 schema；插件不直接调模型
- DSH 原生会话是唯一事实来源
- SSH 连接与凭据**只存在于 host 进程**，浏览器侧永不持有私钥

---

## 2. 关键调研结论（2026-09-09 实测）

### 2.1 DSH 官方有会话视图切换机制，canvas 未使用

`conversation.view` 是官方 list 插槽（scope: `session`，`replaceRisk: none`），现有占用者：

| id | order | 来源 |
|---|---|---|
| `chat` | 0 | DSH 内置 |
| `trajectory` | 10 | DSH 内置 |
| `token-monitor` | 15 | DSH 内置 |

注册项 `{ id, order, label }` 被投影为 `ViewTab { id, label }`，由 `ConversationSessionHeader` 渲染：

```js
// dsh-client-ui-conversation/lib/client.js:14599
tabs.length > 1 && jsx("div", { className: "tabs", role: "tablist",
  children: tabs.map(viewTab => jsx("button", {
    role: "tab",
    "aria-selected": viewTab.id === active?.id,
    className: clsx("tab", viewTab.id === active?.id && "tabActive"),
    onClick: () => selectView(viewTab.id),
  }, viewTab.label)) })
```

要点：

- **`tabs.length > 1` 才渲染整条 tab 栏**；DSH 已有 3 个 view，所以新增第 4 个必然显示；
- 激活态、`aria-selected`、每会话独立记忆（`ConversationStoreState.view`）全部由 DSH 托管；
- `label` 支持 thunk，跟随语言切换重新投影；
- owner props 提供 `openView(view, focus)`，可从别处编程跳转到某个视图；
- 空白会话（`session.blank && phase === 'blank'`）整个 header 被 `hideChrome` 隐藏，tab 栏随之消失——**这是 M1 的入口缺口，见 §5.2**。

### 2.2 canvas 的切换按钮在另一处，两套切换 UI 并存

`conversation.session.header.actions` 当前占用者：

| id | order | 说明 |
|---|---|---|
| `agent-preset` | -10 | DSH 内置 |
| `job-list` | 20 | DSH 内置「后台任务」 |
| `canvas-view-switch` | 25 | canvas 手写「对话 / 会话布」pill |
| `sidebar-toggle` | 30 | sidebar 入口 |

该区域渲染在会话头**第一行标题右侧**（`titleCluster > headerActions`），而原生 tab 栏在**第二行**。即 DSH 已经有一排视图 tab，canvas 又在旁边手写了一个功能重复的 pill，并为它背了幂等守卫、重渲染看门狗、叠压修复、主题令牌化等一串补丁。

**本次不改 canvas**（用户 2026-09-09 拍板），SSH 走官方机制。canvas 未来若迁移，SSH 已经就位。

### 2.3 DSH host 侧官方支持 WebSocket

`@deepseek-ai/dsh-host-webserver` 的 `WebServer` 服务：

```ts
register(route: WebRoute): () => void
registerUpgrade(route: { path: string; handler: (req, socket, head) => void | Promise<void> }): () => void
```

- upgrade 路由按**精确路径**匹配，未匹配的连接被关闭；
- handler 自己拥有协议协商与 socket 生命周期；
- 插件卸载时 `WebServer` 会销毁所有 tracked upgraded socket（Node 的 `closeAllConnections()` 不含 upgraded socket，服务显式跟踪）；
- 一个路径只能有一个协议所有者，重复注册抛错。

**结论**：SSH 终端流不需要自建 HTTP 服务器，注册 `/ssh/ws` 即可。

### 2.4 浏览器不能直接建立 SSH 连接

浏览器没有原始 TCP socket（Direct Sockets 仅限 Isolated Web App），SSH 协议必须在 host 侧实现或代理。

### 2.5 依赖形态（registry 元数据核实）

| 包 | 版本 | 依赖 | 结论 |
|---|---|---|---|
| `ssh2` | 1.17.0 | `asn1`、`bcrypt-pbkdf`；**optional**: `nan`、`cpu-features` | 官方描述 "pure JavaScript"；原生依赖是可选加速，装不上只损失性能 |
| `ws` | 8.x | 无 | WebSocket 服务端 |
| `@xterm/xterm` | 6.0.0 | **无运行时依赖**；`main: lib/xterm.js`、`style: css/xterm.css` | 可直接 `<script>` 引入，MIT |
| `@xterm/addon-fit` | 0.11.0 | 无运行时依赖（README 只要求 xterm v4+）；`main: lib/addon-fit.js` | 自适应尺寸 |

注意：`ssh2` 有 `scripts.install: node install.js`，Windows 下是否会因可选原生模块构建失败而中断，**必须 spike 验证**（§9 S1）。

---

## 3. 技术选型

### 3.1 SSH 协议实现三方案

| 方案 | host 侧实现 | 优点 | 缺点 |
|---|---|---|---|
| **A. ssh2 库** | `ssh2` + `ws`，前端 xterm.js | 纯 JS 无需原生编译；认证 / 指纹 / SFTP / 端口转发全可控；跨平台行为一致；远程 PTY 由 `shell()` channel 提供，`setWindow()` 传 resize | 需自己接 known_hosts、跳板机、agent |
| B. spawn 系统 ssh.exe | `child_process` + `node-pty` | 复用 `~/.ssh/config`、密钥、ProxyJump、agent | node-pty 在 Windows 需 VS Build Tools（sidebar 线已判定「重」）；交互式密码提示需要真 PTY，无 PTY 时不可用 |
| C. 浏览器直连 | — | — | 不可行（无 TCP socket） |

### 3.2 结论

**M1 采用方案 A**。理由：

1. 规避 node-pty 的 Windows 原生编译风险（sidebar M3「内嵌终端」长期未立项的主要原因）；
2. 远程 PTY 语义由 ssh2 的 `shell()` channel 完整提供，前端 resize 通过 `setWindow()` 直达，不需要本地 PTY；
3. 认证、指纹、连接复用全部在 host 侧可控，安全边界清晰。

**B 作为补充**（M2 之后可选）：连接卡片上挂「用系统终端打开」按钮，spawn `ssh.exe` 复用系统配置处理复杂认证（ProxyJump、证书等）。

---

## 4. 架构

### 4.1 三层分离

```
┌─────────────────────────────────────────────────────────────┐
│ 交互层  会话 tab 栏「SSH」→ /ssh/ iframe                     │
│         xterm.js + addon-fit，键盘/尺寸/复制粘贴             │
├─────────────────────────────────────────────────────────────┤
│ 桥接层  /ssh/ws（WebSocket，registerUpgrade）                │
│         JSON 帧：attach / input / resize / detach / output   │
├─────────────────────────────────────────────────────────────┤
│ 事实层  host 侧 SshConnectionService                         │
│         ssh2 Client + shell channel，连接库 / known_hosts    │
│         凭据仅内存，连接随 host 进程存活                      │
│         scrollback 环形缓冲（视图重建时回放，见 §5.4）        │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 数据流

```
xterm.onData ──ws(input)──▶ stream.write
stream.on('data') ──ws(output)──▶ term.write
term.onResize ──ws(resize)──▶ stream.setWindow(rows, cols, h, w)
ssh2 Client.shell({ term:'xterm-256color', cols, rows })
视图重建后重新 attach ──ws(replay)──▶ term.write   // host 回放 scrollback
```

### 4.3 路由与协议

| 路由 | 类型 | 用途 |
|---|---|---|
| `/ssh` | exact | 302 → `/ssh/` |
| `/ssh/` | exact | 页面 HTML |
| `/ssh/app.js` | exact | 前端脚本 |
| `/ssh/styles.css` | exact | 样式 |
| `/ssh/vendor/xterm.js` | exact | 从 `node_modules/@xterm/xterm/lib/xterm.js` 读 |
| `/ssh/vendor/xterm.css` | exact | 从 `node_modules/@xterm/xterm/css/xterm.css` 读 |
| `/ssh/vendor/addon-fit.js` | exact | 从 `node_modules/@xterm/addon-fit/lib/addon-fit.js` 读 |
| `/ssh/api/*` | prefix | 连接库 CRUD、连接/断开、指纹确认 |
| `/ssh/ws` | **upgrade** | 终端流 |

WS 帧（JSON 控制帧 + 二进制输出帧，双通道；终端字节走 `Buffer`/`ArrayBuffer` 直传,零 base64 开销）：

```jsonc
// Client → Host（JSON 文本帧）
{ "type": "attach", "connId": "..." }              // 绑定到一个已建立的连接
{ "type": "input",  "data": "ls\r" }
{ "type": "resize", "cols": 120, "rows": 32 }
{ "type": "signal", "name": "INT" }                // 可选（M1 未用，Ctrl+C 走 input 0x03）
{ "type": "detach" }                               // 离开视图，连接保留

// Host → Client（JSON 文本帧）
{ "type": "ready",  "cols": 120, "rows": 32, "state": "…" }
{ "type": "status", "state": "connecting|waiting-fingerprint|connected|closed|error", "code": "…", "message": "…", "token": "…", "fingerprint": "…" }
{ "type": "error",  "code": "AUTH_FAILED", "message": "…" }

// Host → Client（二进制帧）——终端输出即实字节流
<bytes>                                            // attach 后先回放 scrollback，再续实时输出
```

### 4.4 目录结构（规划）

```
dsh-miasaki-ssh/
├── package.json            # @miasaki/dsh-ssh（dsh.client web 声明）
├── cordis.patch.yml        # 插件身份（id: ssh / 数据目录 / trustedHosts）
├── index.js                # host 半：路由族 + SshConnectionService + WS 桥
├── client.js               # client 半：conversation.view 注册 + iframe 视图
├── app.js                  # 前端（iframe 内）：xterm + 连接表单 + 连接列表
├── styles.css
├── test/                   # 单测（围栏 / 协议编解码 / 连接库 / known_hosts）
├── design/
│   ├── 2026-09-09-ssh-design.md
│   └── CHANGELOG.md
└── README.md
```

---

## 5. 按钮与页面落点（已拍板：方案 1）

### 5.1 注册 `conversation.view`

```js
// client.js
ctx.slots.inject('conversation.view', () => ctx.slots.register({
  name: 'conversation.view',
  id: 'ssh',
  order: 20,                    // 排在 token-monitor(15) 之后
  label: () => 'SSH',
}, SshView))
```

`SshView` 返回一个填满中间列的 `<iframe src="/ssh/">`：

- 沿用 canvas 的 iframe 隔离策略（样式、xterm 全局对象、键盘捕获都关在独立文档里）；
- 组件挂载时按需创建，卸载时 `detach`（连接保留在 host 侧）；
- 通过 `styles.insert()` 注入 `height:100%` 等最小样式，其余全部在 iframe 内。

**为什么用 iframe 而不是纯 React 组件**：xterm.js 需要真实 DOM 与全局样式表，且 DSH 的 client bundle 由 `__ModuleLoader__` 加载，无法 `require` 第三方包；iframe 里是独立文档，可以直接 `<script src="/ssh/vendor/xterm.js">`，与 canvas 同构、零打包改造。

**实测数据**（2026-09-09，动态 Cordis 探针注册真实视图 + iframe 自测；DSH 0.1.2-rc.1，浏览器窗口 1280×800）：

| 指标 | 实测值 | 判定 |
|---|---|---|
| tab 栏 | 第四个 tab「SSH 探针」正常出现，与「对话 / 轨迹 / Token 监控」并列 | 注册机制可用 ✅ |
| iframe 视口 | 992×596（父文档 1280×800） | 填满中间列 ✅ |
| 页面内滚动条 | 无（`scrollHeight <= clientHeight`） | 无双滚动条 ✅ |
| 键盘捕获 | keydown 0→23 递增，含 IME 的 `Process`、`Backspace`、`Enter` | iframe 内键盘不被 DSH 抢 ✅ |
| 视图切换 | 切走再切回：加载次数 1→2→3，`timeOrigin` 每次变化 | **视图被卸载重建** ⚠️ 见 §5.4 |

### 5.2 空白会话的入口缺口

tab 栏只在会话存在且 header 未被隐藏时出现。空白新会话（Hero 态）没有 SSH 入口。

M1 处理：**接受该缺口**，用户开一个会话即可见。备用入口候选（M2 视实际使用频率决定）：

| 候选 | 位置 | 代价 |
|---|---|---|
| `sidebar.footer.action` | 侧边栏脚部（设置旁） | 与 sidebar 线视觉耦合 |
| `shell.overlay` | 全局浮层 + 自己的悬浮按钮 | 需要自己处理叠压（canvas 踩过坑） |
| 欢迎页 Hero 区 | 空白会话中央 | 需要 `conversation.hero.*` 插槽，可能与工作区选择器冲突 |

### 5.3 与 canvas 的关系

- 两者零代码耦合，各自注册各自的视图 / 按钮；
- canvas 保持现状（手写 pill 在第一行，SSH 在第二行 tab 栏），互不干扰；
- 若未来 canvas 迁移到 `conversation.view`，两者会在同一条 tab 栏里并列，无需改动 SSH。

### 5.4 视图切换会销毁 iframe（实测结论）

`ConversationSession` 用 `renderSlot('conversation.view', …, { only: active.id })` 只渲染当前激活视图，因此**切到别的 tab 时 SSH 视图组件被卸载、iframe 随之销毁**（实测确认，非推断：加载次数 1→2→3、`timeOrigin` 每次变化）。

后果与对策：

- 连接本身不受影响——ssh2 Client 与 shell channel 活在 host 侧，与浏览器视图无关；
- **终端画面会丢**：重建后的 xterm 是全新空白文档，必须由 host 侧回放历史输出；
- 因此 host 侧每个连接必须维护 **scrollback 环形缓冲**（建议保留最近 256KB 原始输出字节），attach 时先发 `replay` 再续流；
- 全屏 TUI（vim / htop）回放原始字节可能出现画面错乱，行式 shell 输出回放效果良好；缓解手段：attach 后提示用户按 `Ctrl+L`，或（M2）在 host 侧维护最小屏幕快照；
- 备选方案（M2 再评估）：把终端 iframe 常驻 `shell.overlay`，视图组件只切换显隐，从根上避免重建——代价是要自己处理浮层与 DSH 布局的让位（canvas 踩过叠压坑）。

---

## 6. 数据模型

### 6.1 连接库

`$DSH_HOME/miasaki-ssh/connections.json`

```jsonc
{
  "version": 1,
  "connections": [
    {
      "id": "c_<random>",
      "label": "生产 Web 服务器",
      "host": "203.0.113.10",
      "port": 22,
      "username": "root",
      "auth": { "method": "key", "keyPath": "C:\\Users\\me\\.ssh\\id_ed25519" },
      // 或 { "method": "password" }（不存密码本体）
      // 或 { "method": "agent" }
      "group": "prod",
      "color": "#c23a2e",
      "createdAt": "2026-09-09T10:00:00.000Z",
      "lastUsedAt": "2026-09-09T12:00:00.000Z"
    }
  ]
}
```

### 6.2 known_hosts

`$DSH_HOME/miasaki-ssh/known_hosts.json`

```jsonc
{
  "version": 1,
  "hosts": {
    "[203.0.113.10]:22": {
      "algo": "ssh-ed25519",
      "fingerprint": "SHA256:...",
      "firstSeenAt": "2026-09-09T10:00:00.000Z",
      "lastSeenAt": "2026-09-09T12:00:00.000Z"
    }
  }
}
```

校验流程：

1. 首次连接 → ssh2 `hostVerifier` 拿到指纹 → 不通过、挂起连接 → 前端展示指纹与算法 → 用户确认 → 写入 → 放行；
2. 已有记录且一致 → 直接放行；
3. **不一致 → 拒绝连接**，前端红色告警（可能的中间人 / 服务器重装），只能手动在 UI 里「删除该主机记录」后再连。

### 6.3 凭据策略

| 认证方式 | 存储位置 | 生命周期 |
|---|---|---|
| 密码 | **仅 host 进程内存**（`Map<connId, string>`） | 连接建立时从表单传入，断开即清，永不落盘 |
| 私钥文件路径 | 连接库（只存路径字符串） | host 侧每次连接时读取；要求绝对路径 + 文件存在 |
| 上传的私钥 | `$DSH_HOME/miasaki-ssh/keys/<id>`，权限 0600（Windows 尽力设置 ACL） | 用户可删 |
| SSH agent | 不存 | 读 `SSH_AUTH_SOCK`（*nix）或 Windows OpenSSH agent 命名管道 |

**任何私钥内容、密码都不进 localStorage / sessionStorage / 前端内存**。

---

## 7. 安全边界（红线）

插件自定义路由**不受 DSH `/api` 的 token 认证保护**，必须自带围栏。SSH 页面等于把一把远程 shell 钥匙放进浏览器，本节为强制项。

### 7.1 三道浏览器围栏（HTTP 与 WS upgrade 都要过）

1. **Host** 必须命中 `localhost` / `127.0.0.1` 或 `cordis.patch.yml` 的 `trustedHosts`（端口无关）；
2. **`sec-fetch-site: cross-site`** 一律 403；
3. **`Origin`**（存在时）hostname 必须等于 Host 的 hostname；`Origin: null` 按不透明来源拒绝。

WS upgrade 的围栏必须在 `handleUpgrade` **之前**完成——升级后无法再写 HTTP 状态码，只能 `socket.destroy()`。

三道是 DNS-rebinding / 跨站纵深防御，**不是鉴权**。

### 7.2 其余强制项

1. **默认只连回环**：`trustedHosts` 为空时外部请求一律拒绝；不提供「绑定 0.0.0.0」开关；
2. **主机指纹严格校验**：见 §6.2，不允许「忽略并继续」的常驻开关（每次忽略都要显式确认）；
3. **连接 id 不可预测**：`crypto.randomUUID()` 或等价强度；WS 消息必须校验 `connId` 归属，拒绝越权 attach；
4. **清理**：插件卸载 / host 进程退出 → 关闭全部 SSH 连接与 shell channel；
5. **日志**：密码、私钥内容、键盘输入**永不写日志**；
6. **凭据不回传前端**：连接库 API 返回的 `auth` 只回 `method` 与 `keyPath`，不回任何密钥材料；
7. **可选审批门**（M2 视情况）：首次连接某主机、或标记为 `prod` 的连接，挂 DSH approval 二次确认。

---

## 8. 里程碑

### M1 最小可用（本次规划范围）

| 项 | 内容 |
|---|---|
| 入口 | `conversation.view` 注册 id `ssh`，order 20 |
| 页面 | `/ssh/` iframe：左连接列表 + 右终端 |
| 认证 | 密码 / 私钥路径 / agent 三种 |
| 终端 | xterm.js + addon-fit；输入、输出、resize、Ctrl+C |
| 连接库 | 主机 CRUD 持久化到 `$DSH_HOME/miasaki-ssh/connections.json` |
| 指纹 | known_hosts TOFU + 变更拒绝 |
| 保活 | host 侧持有连接；视图切换 / 页面刷新不断连 |
| 围栏 | 三道（HTTP + WS） |
| 测试 | 围栏 / 协议编解码 / 连接库迁移 / known_hosts 校验 / 凭据不落盘 |

**验收标准**：

1. 会话 tab 栏出现「SSH」，点击切换到 SSH 页面；
2. 用密码与私钥各连上一台真实云服务器，`ls` / `vim` / `top` / `Ctrl+C` 正常；
3. 窗口缩放后远端 `stty size` 跟随变化；
4. 首次连接展示指纹并等确认；指纹被人为改动后连接被拒；
5. 切到「对话」再切回「SSH」，连接仍在；
6. 刷新页面后连接仍在；
7. 跨站 / 非回环 Origin 请求返回 403；
8. 卸载插件后 `netstat` 无残留连接。

### M2 好用

连接分组与颜色（prod 红色标识）、多标签终端、断线自动重连、复制粘贴、字号与主题跟随、SFTP 上传下载、「用系统终端打开」（spawn ssh.exe）、空白会话备用入口。

### M3 与 DSH 联动（差异化）

终端选中文本 → 一键送进对话让 agent 分析；注册 `ssh_exec` 工具让 agent 操作已连接的服务器（带审批门）；命令片段 / 一键运维；跳板机与端口转发；云厂商实例列表导入。

---

## 9. SPIKE 清单（M1 前置）

| 编号 | 验证项 | 状态 | 结论 / 备选 |
|---|---|---|---|
| S1 | `ssh2` 在 Windows + Node 22 下安装（`install.js` 是否因可选原生模块中断）与真实连接 | **已通过**（装包闭环） | `pnpm install` 成功安装 `ssh2` 1.17.0 / `ws` 8.21.3 / `@xterm/xterm` 6.0.0；`cpu-features` 等 optional 原生模块经 `pnpm-workspace.yaml allowBuilds: false` 显式跳过，纯 JS 路径完整；真实连接归入 M1 验收（重启 `dsh web` 后） |
| S2 | `ctx.webServer.registerUpgrade('/ssh/ws')` 能否注册并接管升级连接 | **已通过**（2026-09-09） | 见 §9.1 |
| S3 | xterm.js 资源由 host 路由 serve 的可行性与体积 | **已通过**（装包 + 集成测试） | `@xterm/xterm@6.0.0 lib/xterm.js` 无运行时依赖、体积约 260KB；host 路由 serve `/ssh/*` 与 vendor 静态资源已有 `test/http.test.js` 集成测试覆盖 |
| S4 | `conversation.view` 内嵌 iframe 的尺寸 / 滚动 / 键盘捕获 / 切换行为 | **已通过**（2026-09-09） | 实测数据见 §5.1，切换后果见 §5.4 |
| S5 | ssh2 `hostVerifier` 能否在拒绝前拿到指纹并挂起（做 TOFU 交互） | **已通过**（代码落地 + 单测） | ssh2 1.17.0 回调式 `hostVerifier(key, verify)`：`verify` 只在返回值 `undefined` 时调用 → 天然支持异步确认；`runtime.handleHostKey` 三分支（挂起/放行/拒绝）由 `test/runtime.test.js` 覆盖 |

### 9.1 S2 / S3 实测记录（2026-09-09）

动态 Cordis 探针（host 半）实测结论：

- `ctx.get('webServer')` 在插件里可访问，`register` 与 `registerUpgrade` 均可调用（`port` 3080 / `host` 127.0.0.1）；
- 注册 `/ssh-spike/ping`（exact HTTP）→ HTTP 请求返回 200，路由注册生效；
- 注册 `/ssh-spike/ws`（upgrade）→ Node 原生 `WebSocket` 客户端连接后，handler 收到
  `upgrade: websocket`、`connection: upgrade`、`sec-websocket-key`、`sec-websocket-version: 13`，`head` 长度 0
  —— **upgrade 被插件 handler 完整接管**（探针主动回 426 并销毁 socket，客户端如预期报错）；
- 普通 HTTP GET 打到 upgrade 路径返回 404 → upgrade 路由不污染普通路由表；
- 同一插件同时注册 HTTP 与 upgrade 路由无冲突，DSH 的 HMR / index 注入不受影响。

**判定**：S2 通过；S3 的「host 路由把页面/资源 serve 给 iframe」部分通过（探针的 iframe 页面本身就是经 host 路由 serve 的）。xterm.js / css 的实际文件与体积待 M1 装包后确认。

---

## 10. 风险与待定

| 风险 | 影响 | 缓解 |
|---|---|---|
| ssh2 在 Windows 安装失败 | 阻断 M1 | S1 先行；备选 `--omit=optional` / 方案 B |
| DSH 升级改动 `conversation.view` / `registerUpgrade` | 入口或桥接失效 | 两者都是官方 API；变更记录进 CHANGELOG；升级后跑回归 |
| **切视图销毁 iframe**（已实测） | 终端画面丢失 | host 侧 scrollback 回放（§5.4，M1 强制项）；备选常驻 `shell.overlay` |
| 全屏 TUI 回放错乱 | vim / htop 切回后花屏 | 提示 `Ctrl+L`；M2 视需要维护最小屏幕快照 |
| xterm 体积（~1MB 解压） | 首屏变慢 | host 路由 + 浏览器缓存 + 懒加载（只有切到 SSH tab 才拉） |
| 空白会话无入口 | 用户找不到 SSH | §5.2 备用入口（M2） |
| 远程服务器指纹算法老旧（ssh-rsa） | 连接失败 | ssh2 可放宽算法白名单，但需在 UI 明示风险 |
| 长时连接被网络中断 | 终端卡死 | M2 断线重连；M1 至少给明确状态提示 |

---

## 11. 参考

- [DSH 会话视图机制实测](#21-dsh-官方有会话视图切换机制canvas-未使用)（本文 §2.1）
- [DSH WebServer 路由与 upgrade 注册](../../dsh-miasaki-shared-docs/dsh-platform/)（`@deepseek-ai/dsh-host-webserver`）
- [canvas 视图切换与叠压修复历史](../../dsh-miasaki-canvas/design/CHANGELOG.md)
- [sidebar 终端启动器安全边界与 M3 内嵌终端规划](../../dsh-miasaki-sidebar/README.md)
- ssh2：<https://github.com/mscdex/ssh2>
- xterm.js：<https://github.com/xtermjs/xterm.js>
