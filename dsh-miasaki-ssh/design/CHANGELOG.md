# CHANGELOG — dsh-miasaki-ssh

本文件记录 `dsh-miasaki-ssh/` 线的设计决策与变更。

## 2026-09-10

- **修复：client 半加载失败 `invalid plugin … received undefined`（`client.js` 工厂漏 `return module.exports`）**。
  - **现象**：宿主重启后前端报 `Failed to load plugins` / `failed to apply loader entry <8 位随机 id> (@miasaki/dsh-ssh): invalid plugin, expect function or object with an "apply" method, received undefined`。
  - **定位**（DSH 0.1.2-rc.1 源码逐层核实）：
    - 报错出自 **浏览器端 cordis**，不是 host 半：`packages/client/web/src/boot.tsx` 的插件启动对每个客户端模块执行 `loader.create({ name })`——只传 `name` 不传 `id`，故 entry id 是 `ensureId()` 生成的随机 8 位十六进制（即错误里的 `2f010b31`）；随后 `EntryTree.import` → `internal.import`（ClientModuleLoader）物化 `client.js` 注册的工厂，把返回值交给 `registry.plugin()`。
    - host 半无恙：`dsh web --dump-config` 中 `id: ssh` 一行完整；profile 目录直接 `import('@miasaki/dsh-ssh')` 也拿得到 `apply` / `inject` / `name`。
  - **根因**：`client.js` 的 `factory` 结尾漏了 `return module.exports`（canvas / sidebar 两线均有此行）。工厂返回 `undefined` ⇒ cordis 判定 `invalid plugin`。
  - **修复**：补 `return module.exports`。
  - **防回归**：新增 `test/client.test.js`——在 `node:vm` 里执行 `client.js`，捕获 `window.__ModuleLoader__.load` 的 descriptor，断言工厂返回含 `inject`/`apply` 的对象、`apply` 注册 `conversation.view`（id `ssh` / order 20 / label `SSH`，视图为 `src='/ssh/'` 的 iframe）、幂等守卫与 effect 复位可重挂载。单测 20 例全绿。
  - **待复核**：宿主重启 + 浏览器刷新后确认 tab 出现、无插件加载失败横幅（M1 真实连接验收清单不变）。
- **纳入统一回归（六线）**：`scripts/verify-all.mjs` 新增 `ssh` 线，登记 5 项语法检查（`index.js` / `client.js` / `app.js` / `lib/store.js` / `lib/runtime.js`）+ 4 个单测文件，**9/9 通过**（含 20 例单测）。
  - 纳入口径：单测不触真实 SSH 连接（store 的三道围栏与归一化、runtime 的 TOFU 与错误分类、http 路由、client 工厂返回契约），**任何机器可复现**；真实连接验收仍是实机项，留在 `dsh-miasaki-shared-docs/cross/smoke-test-matrix.md`。
  - 同步：根 `README.md` 由「五线统一回归」改为六线，`AGENTS.md` 扩为六线登记（补 dual-model 行）。

## 2026-09-09

- **立项**：在 DSH web 会话视图切换区集成 SSH 入口、页面内交互式连接云服务器，正式立项为本仓第五条线。
- **关键调研结论**（实测 DSH 0.1.2-rc.1 源码与运行时）：
  - **DSH 官方有会话视图机制**：`conversation.view`（list 插槽，scope `session`，`replaceRisk: none`）现有 `chat`(0) / `trajectory`(10) / `token-monitor`(15)；注册项被投影为 `ViewTab { id, label }`，由 `ConversationSessionHeader` 渲染成 `role="tablist"` 的 tab 栏（`tabs.length > 1` 才渲染），激活态、`aria-selected`、每会话独立记忆（`ConversationStoreState.view`）全部由 DSH 托管。
  - **canvas 的切换按钮在另一处**：`conversation.session.header.actions`（order 25，第一行标题右侧），与 DSH 原生 tab 栏（第二行）是两套并行 UI；canvas 为此背了幂等守卫 / 重渲染看门狗 / 叠压修复 / 主题令牌化等补丁。
  - **host 侧官方支持 WebSocket**：`@deepseek-ai/dsh-host-webserver` 的 `WebServer.registerUpgrade({ path, handler })` 按精确路径匹配、handler 拥有协议协商与 socket 生命周期、插件卸载时服务显式销毁 tracked upgraded socket——SSH 终端流不需要自建 HTTP 服务器。
  - **依赖形态**（registry 元数据核实）：`ssh2` 1.17.0 为纯 JS（`cpu-features` / `nan` 仅 optional 加速）；`@xterm/xterm` 6.0.0 无运行时依赖、`main: lib/xterm.js` 可直接 `<script>` 引入。
- **决策**：
  - SSH 协议实现走**方案 A（ssh2 + ws + xterm.js）**，规避 node-pty 在 Windows 的 VS Build Tools 依赖（sidebar 线 M3「内嵌终端」长期未立项的主因）；「spawn 系统 ssh.exe」作为 M2 补充按钮，复用 `~/.ssh/config` 处理复杂认证；
  - 入口走 **`conversation.view` 官方机制**（用户 2026-09-09 拍板，方案 1）：SSH 成为会话 tab 栏的一个 tab，与「对话 / 轨迹 / Token 监控」并列；**本次不改 canvas**；
  - 页面形态 = iframe（`/ssh/`）内嵌在视图组件里，沿用 canvas 的隔离策略（client bundle 由 `__ModuleLoader__` 加载、无法 `require` 第三方包）；
  - 连接在 **host 侧全局持有**（视图切换 / 页面刷新不断连），凭据只存在于 host 进程内存；
  - 安全红线：三道浏览器围栏（Host / `sec-fetch-site` / Origin）**HTTP 与 WS upgrade 都要过**、默认只连回环、主机指纹 TOFU + 变更拒绝、密码不落盘、私钥不进前端存储；
  - M1 范围 = 纯终端 + 连接管理（不含 SFTP / 跳板机 / agent 联动）；
  - 项目位置 = `dsh-miasaki-ssh/`，包名 `@miasaki/dsh-ssh`。
- **产出**：[设计文档](2026-09-09-ssh-design.md)（含 §9 SPIKE 清单 S1–S5 与 §7 安全红线）。
- **SPIKE 实测（同日，动态 Cordis 探针，已清理）**：
  - **S2 通过**：`ctx.get('webServer')` 在插件里可访问，`register` / `registerUpgrade` 均可调用；注册 `/ssh-spike/ws`（upgrade）后 Node 原生 `WebSocket` 客户端连接被 handler 完整接管（拿到 `upgrade: websocket` / `connection: upgrade` / `sec-websocket-key` / `sec-websocket-version: 13`，`head` 长度 0）；普通 GET 打到 upgrade 路径返回 404（不污染普通路由表）；HTTP + upgrade 双注册无冲突。
  - **S4 通过**：注册真实 `conversation.view`（id `ssh-spike`）后 tab 栏出现第四个 tab；iframe 视口 992×596（父文档 1280×800）填满中间列、无内部滚动条；keydown 0→23 递增（含 IME 的 `Process`、`Backspace`、`Enter`），iframe 内键盘不被 DSH 抢。
  - **S4 附带发现（影响架构）**：切走再切回视图，iframe **加载次数 1→2→3、`timeOrigin` 每次变化**——`ConversationSession` 以 `renderSlot(…, { only: active.id })` 只渲染激活视图，故切换会卸载重建。设计随之新增 **host 侧 scrollback 环形缓冲 + attach 时 `replay` 帧**（§5.4，M1 强制项），并记录「常驻 `shell.overlay`」为 M2 备选。
  - **S3 部分通过**：host 路由 serve 静态页面给 iframe 已验证（探针页面即经 `/ssh-spike/page` 提供）；xterm 具体文件与体积待装包后确认。
- **未实现**：本线当前只有设计文档，无代码；M1 实现前仍需跑 SPIKE S1（ssh2 在 Windows 的安装与真实连接）与 S5（`hostVerifier` 的 TOFU 交互）。
- **M1 实现（推进中，同日）**：
  - **依赖落地（SPIKE S1 / S3 闭环）**：`pnpm install` 成功安装 `ssh2` 1.17.0、`ws` 8.21.3、`@xterm/xterm` 6.0.0（`lib/xterm.js` UMD ≈ 260KB）、`@xterm/addon-fit` 0.11.0；ssh2 的 `cpu-features` / `nan` 只编译了 optional 部分、未中断安装。S1 / S3 正式转绿。
  - **代码骨架落地**：`lib/store.js`（纯数据层：连接库 CRUD + known_hosts TOFU + 三道围栏 + JSON 原子写）、`lib/runtime.js`（ssh2 运行时：`hostVerifier` 异步 TOFU、scrollback 环形缓冲、WS 中继、错误分类）、`index.js`（host 半路由族：`/ssh/` 页面、xterm 静态资源、`/ssh/api/*` REST、`/ssh/ws` upgrade）、`client.js`（`conversation.view` 注册 + iframe）、`app.js`（前端 xterm + 连接管理 + 密码即时输入）、`styles.css`。S5（异步 TOFU）已在运行时中落地。
  - **单测全绿**：`test/store.test.js`（围栏 / 归一化 / 指纹格式 / 持久化 / 凭据不落盘）与 `test/runtime.test.js`（错误分类 / TOFU 三分支 / 变更拒绝）共 13 例全部通过；`node --test` 可复跑。
  - **与设计文档 §5.4 一致**：WS 帧为「JSON 控制帧 + 二进制输出帧」双通道；attach 时 host 先回放 scrollback 再续流，视图切换 / 页面刷新不丢屏。
  - 注：`__ModuleLoader__` 的 `client.js` 栈式注册 / `cordis.patch.yml` 的 `dshHomePath` 写法沿用 canvas 既有模式。
  - **待办**：`dsh plugin --profile web add link:…` 安装到 web profile 后，浏览器实测真实连接的验收标准（§7 清单）。
