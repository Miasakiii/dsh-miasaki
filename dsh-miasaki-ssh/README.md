# @miasaki/dsh-ssh

DSH（DeepSeek Harness）web SSH 插件线：在**会话头第一行的视图切换胶囊**（与「对话 / 会话布」同一个胶囊、第三段「SSH」）集成入口，页面内交互式连接云服务器。

- 全新自研（不 fork 上游），技术栈与 canvas / sidebar 同构；
- 与 canvas、sidebar **零代码耦合**，仅共享 `dsh-miasaki-shared-docs/`；
- 红线沿用 canvas：不改系统提示 / 模型请求 / 工具 schema；插件不直接调模型。

## 状态

**M1 实现中，代码骨架已就绪**（2026-09-09）。存储层、运行时、host 路由与前端页面已完成并通过单测；待安装到 DSH web profile 后在浏览器验证真实连接。SPIKE S2 / S4 / S5 已实测通过。**2026-09-10 按用户反馈调整入口位置**：从官方 tab 栏（第二行，排在「会话用量」之后）迁到会话头第一行，与「对话 / 会话布」**合成为同一个胶囊**（三段：对话 \| 会话布 \| SSH）；并在**画布页面内部**那组「对话 / 会话布」旁也给出一个 SSH 按钮（走画布的外部视图槽）。

设计要点速览（完整版见 [设计文档](design/2026-09-09-ssh-design.md)）：

| 维度 | 决策 |
|---|---|
| 入口 | ① 会话头第一行的三段胶囊：注册官方 `conversation.session.header.actions` 槽（id `ssh-view-switch`，order 26），与 canvas 的「对话 / 会话布」**合成为同一个控件**（纯 CSS 覆盖，canvas 文件未改）；② **画布页面内部**那组「对话 / 会话布」旁的一个 SSH 按钮：走 canvas 提供的通用「外部视图槽」（页面级注册表 `window.__DSH_CANVAS_VIEW_ITEMS__` + `canvas:view` 广播，canvas 侧不认识 SSH）。页面本身由 `conversation.view`（id `ssh`，order 20）托管，该 tab 收起不再显示（2026-09-10 调整，见[设计文档 §5.5](design/2026-09-09-ssh-design.md)） |
| 页面 | `/ssh/` iframe 内嵌在视图组件中（样式隔离；client bundle 无法 `require` 第三方包） |
| SSH 实现 | **方案 A**：host 侧 `ssh2` + `ws`，前端 `@xterm/xterm` + `addon-fit` |
| 终端桥 | `ctx.webServer.registerUpgrade('/ssh/ws')` —— DSH 官方 WebSocket 注册 API |
| 连接保活 | 连接在 host 侧全局持有，视图切换 / 页面刷新不断连 |
| 凭据 | 密码仅 host 内存、断开即清；私钥只存路径引用；**任何密钥不进前端存储** |
| 指纹 | known_hosts TOFU 首次确认 + 变更拒绝告警 |
| 安全 | 三道浏览器围栏（Host / `sec-fetch-site` / Origin），**HTTP 与 WS upgrade 都过** |

为什么页面仍走官方 `conversation.view`：注册即得页面宿主、激活态、每会话记忆与视图卸载语义（切走卸载 iframe、host 侧回放 scrollback），canvas 手写 pill 的补丁史（幂等守卫 / 重渲染看门狗 / 叠压修复）不必重演。入口按钮虽然落在第一行 actions 槽（位置诉求），**切换仍委托官方 tab 的 onClick** —— DSH 未对外暴露 View 切换 API（`selectView` 只在官方 header 组件的 inject face 里），委托点击是官方唯一通道，且「找不到 tab 就收手」：最坏退回「双入口」，不会没入口。

## 里程碑

| 阶段 | 范围 | 状态 |
|---|---|---|
| **M1** | 纯终端 + 连接管理：`conversation.view` 入口、`/ssh/` 页面、密码/私钥/agent 三种认证、xterm 交互终端、known_hosts、三道围栏、连接保活 | **实现中**（store / runtime / 路由 / WS / 前端 / 单测已完成，待安装验证） |
| M2 | 连接分组与颜色、多标签、断线重连、复制粘贴、主题跟随、SFTP、系统终端打开、空白会话备用入口 | 规划 |
| M3 | 与 DSH 联动：选中文本送进对话、`ssh_exec` 工具（带审批门）、命令片段、跳板机 / 端口转发、云厂商实例导入 | 规划 |

## M1 前置 SPIKE

| 编号 | 验证项 | 状态 |
|---|---|---|
| S1 | `ssh2` 在 Windows + Node 22 下安装（`install.js` 是否因可选原生模块中断）与真实连接 | **已通过**（依赖安装成功，见下） |
| S2 | `ctx.webServer.registerUpgrade('/ssh/ws')` 能否注册并接管升级连接 | **已通过**（2026-09-09 实测） |
| S3 | xterm.js 资源由 host 路由 serve 的可行性与体积 | **已通过**（xterm 6.0.0 `lib/xterm.js` ≈ 260KB） |
| S4 | `conversation.view` 内嵌 iframe 的尺寸 / 滚动 / 键盘捕获 / 切换行为 | **已通过**（2026-09-09 实测） |
| S5 | ssh2 `hostVerifier` 能否在拒绝前拿到指纹并挂起（TOFU 交互） | **已通过**（回调式签名支持异步确认，代码已用） |

实测细节与数据见[设计文档 §9](design/2026-09-09-ssh-design.md)。S4 的附带结论是：**切视图会卸载重建 iframe**，因此 host 侧必须保留 scrollback 并在 attach 时回放。

## 目录结构

```
dsh-miasaki-ssh/
├── package.json            # @miasaki/dsh-ssh（dsh.client web 声明）
├── cordis.patch.yml        # 插件身份（id: ssh / 数据目录 / trustedHosts）
├── index.js                # host 半：路由族 + REST API + WS 桥
├── lib/
│   ├── store.js            # 纯数据层：连接库 / known_hosts / 三道围栏（可单测）
│   └── runtime.js          # ssh2 运行时：TOFU / scrollback 环形缓冲 / WS 中继
├── client.js               # client 半：第一行入口按钮（actions 槽）+ conversation.view 注册 + iframe 视图
├── app.js                  # 前端（iframe 内）：xterm + 连接表单 + 连接列表
├── styles.css
├── test/                   # 单测（store: 围栏/归一化/持久化 ↔ runtime: TOFU/错误分类 ↔ client: 工厂返回契约 + 入口位置/切换通道/宽度判据）
├── design/
│   ├── 2026-09-09-ssh-design.md
│   └── CHANGELOG.md
└── README.md
```

## 文档

| 文档 | 内容 |
|---|---|
| [设计文档](design/2026-09-09-ssh-design.md) | 调研结论、技术选型、架构、数据模型、安全红线、里程碑、SPIKE 清单、风险 |
| [CHANGELOG](design/CHANGELOG.md) | 本线变更记录 |

## 相关线

- [canvas 视图切换与叠压修复历史](../dsh-miasaki-canvas/design/CHANGELOG.md)
- [sidebar 终端启动器安全边界与 M3 内嵌终端规划](../dsh-miasaki-sidebar/README.md)
- [跨线共享参考](../dsh-miasaki-shared-docs/)
