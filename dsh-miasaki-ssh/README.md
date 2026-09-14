# @miasaki/dsh-ssh

DSH（DeepSeek Harness）web SSH 插件线：在**会话头第一行的视图切换胶囊**（与「对话 / 会话布」同一个胶囊、第三段「SSH」）集成入口，页面内交互式连接云服务器。

- 全新自研（不 fork 上游），技术栈与 canvas / sidebar 同构；
- 与 canvas、sidebar **零代码耦合**，仅共享 `dsh-miasaki-shared-docs/`；
- 红线沿用 canvas：不改系统提示 / 模型请求 / 工具 schema；插件不直接调模型。

## 状态

**M1 代码完成**（2026-09-09 立项）：存储层、运行时、host 路由与前端页面已完成并通过单测；已 link 安装到 DSH web profile，待重启 host 后在浏览器验证真实连接。SPIKE S2 / S4 / S5 已实测通过。**2026-09-10 按用户反馈调整入口位置**：从官方 tab 栏（第二行，排在「会话用量」之后）迁到会话头第一行，与「对话 / 会话布」**合成为同一个胶囊**（三段：对话 \| 会话布 \| SSH）；并在**画布页面内部**那组「对话 / 会话布」旁也给出一个 SSH 按钮（走画布的外部视图槽）。

**2026-09-12 U0 可靠性闭环完成**（[工作区优化规划](design/2026-09-12-ssh-workspace-plan.md) §9 首阶段，按「先通过故障注入测试」门槛验收）：

- **二进制输出修复**：WS `binaryType='arraybuffer'`，二进制帧真正落进 xterm（此前 `event.data` 是 Blob，`new Uint8Array(Blob)` 得到空数组 ⇒ **终端无输出**）；
- **查看器实例化**（新模块 `session.js`）：一个查看器独占一个 xterm + 一个 WS，整体可销毁，切换主机 / 重建 iframe 绝不跨代串写、不泄漏监听；
- **恢复 attach**：已连接 / 连接中 / 待指纹主机的主动作是「打开终端」，只 attach、不发第二个 connect（此前按钮被禁用 ⇒ iframe 重建后连接还在却进不去）；
- **生命周期契约**：viewer WS 短断有界重附着（4 次、线性退避）；SSH 自身关闭 / 报错则不重附着；输入与尺寸改走 **viewer 绑定路由**（`ws.sshRc` 实例绑定），被替换代次的僵尸 viewer 会被拒绝（`STALE_VIEWER`）；
- **指纹闭环**：确认窗口与 ssh2 握手**同一套 60s 时间预算**；确认 token 与连接实例 generation 绑定（旧确认不影响新连接）；信任记录**保存失败即拒绝连接**（不再吞错）；
- **凭据与表单**：私钥口令在连接时临时输入（后端本就支持）；秘密对话框关闭即清空输入；
- **尺寸与健壮性**：attach 初始尺寸送真实 PTY、`ResizeObserver` 观察容器 + rAF 合帧、resize 限界（2–1000 × 2–500）、WS 帧上限 256KB、慢 viewer 背压淘汰（`bufferedAmount > 8MB` 断开）。

**2026-09-12 U1 统一工作区完成**（规划 §3/§4/§6/§7 落地；界面与功能按概念稿 [`preview/2026-09-12-ssh-workspace-concept.html`](design/preview/2026-09-12-ssh-workspace-concept.html) 实施）：

- **双栏工作区**：可收起主机导航（232px，208–288 语义随容器收窄）+ 多主机终端标签 + 单条状态栏；未选主机有空态（最近连接 / 新建主机），未连接主机有摘要页（连接 / 编辑入口）；
- **主机导航**：名称 / `username@host:port` 联合搜索、分组归档、收藏（星标 + 组内置顶）、存活状态点；**右键与工具区「更多」菜单同源**（打开终端 / 编辑 / 收藏 / 复制地址 / 信任记录 / 断开 / 删除）；
- **编辑器抽屉**：右侧 412px sheet，字段校验（用户名必填、**不再默认 root**）、认证方式渐进显示私钥路径、活跃主机编辑提示「仅影响下一次连接」、服务端错误内联展示，[取消 / 保存 / 保存并连接]；
- **三主题桥接**：client.js 读取宿主**最终计算样式**（body 优先，白名单令牌）→ 同源 postMessage + 页面级注册表 `__DSH_SSH_THEME__`（iframe 首帧直读，不闪兜底色）→ `--ssh-*` 语义变量 + xterm 主题（背景 / 前景 / 光标 / 选区 / ANSI 16 色）；半透明宿主色合成到实体底再进终端；原生明暗兜底；主题切换不重建 SSH；
- **终端功能**：多主机标签（同主机只 attach；关闭查看 ≠ 断开，断开需确认）、Ctrl+Shift+C/V 复制粘贴、缓冲区原生查找（**零新依赖**——addon-search 对 xterm 6 只有 beta 版，未核验不引入）、字号 12–20px、本地清屏、专注模式、多行 / 含控制字符粘贴先预览确认；
- **响应式**：容器查询断点 960 / 720 / 480（依据 SSH 容器宽度而非窗口宽度），窄屏导航改模态抽屉（焦点陷阱 + Esc 归还焦点）。

**待实机验证**（U0+U1 合并验收，见 [回归矩阵 §3](../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)）：重启 `dsh web` 后按清单逐项过。U2（SFTP、同主机多 shell）、U3（跳板 / 转发）未动。

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
| **M1** | 纯终端 + 连接管理：`conversation.view` 入口、`/ssh/` 页面、密码/私钥/agent 三种认证、xterm 交互终端、known_hosts、三道围栏、连接保活 | **代码完成，待实机验收** |
| **U0+U1**（工作区规划） | U0 可靠性闭环（二进制输出 / 查看器实例 / 恢复 attach / 指纹闭环 / 输入归属）+ U1 统一工作区（主机导航 / 多标签 / 编辑抽屉 / 三主题桥接 / 复制粘贴 / 查找 / 字号 / 响应式） | **已实施，待实机验收** |
| M2 | SFTP、系统终端打开、空白会话备用入口（多标签 / 断线重连 / 主题跟随 / 分组收藏已随 U1 交付） | 规划（并入 U2：SFTP、多 shell、工作区记忆） |
| M3 | 与 DSH 联动：选中文本送进对话、`ssh_exec` 工具（带审批门）、命令片段、跳板机 / 端口转发、云厂商实例导入 | 规划（对应 U3）；**细化方案见 [Agent 化规划](design/2026-09-14-ssh-agent-driven-plan.md)（2026-09-14，待评审：A0 上下文桥 → A1 工具面 → A2 治理闭环 → B 协作面，总开关默认 `off`）** |

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
├── index.js                # host 半：路由族 + REST API + WS 桥（帧上限 + viewer 路由）
├── lib/
│   ├── store.js            # 纯数据层：连接库 / known_hosts / 三道围栏（可单测）
│   └── runtime.js          # ssh2 运行时：TOFU / generation 绑定 / scrollback 环形缓冲 / WS 中继
├── client.js               # client 半：第一行入口按钮（actions 槽）+ conversation.view 注册 + iframe 视图
├── session.js              # 前端查看器实例：一个查看器独占 xterm + WS，整体可销毁（U0）+ 主题/字号/查找 API（U1）
├── app.js                  # 前端（iframe 内）：主机导航 / 多标签 / 编辑抽屉 / 工具区 / 状态栏 / 主题应用
├── styles.css              # 工作区布局 + --ssh-* 语义令牌（原生明暗兜底，宿主桥接覆盖）
├── test/                   # 单测 60 例（store: 围栏/归一化/持久化 ↔ runtime: TOFU/U0 故障注入 ↔
│                           #   session: 二进制/销毁隔离/重附着/主题查找 ↔ app: 分组过滤/粘贴守卫/颜色合成 ↔
│                           #   http: 路由 ↔ client: 工厂契约 + 主题桥接快照）
├── design/
│   ├── 2026-09-09-ssh-design.md
│   ├── 2026-09-12-ssh-workspace-plan.md        # 工作区优化规划设计（U0 已实施，U1–U3 待做）
│   ├── preview/
│   │   └── 2026-09-12-ssh-workspace-concept.html  # 可交互概念稿（三主题 / 四档宽度 / 八种状态）
│   └── CHANGELOG.md
└── README.md
```

## 文档

| 文档 | 内容 |
|---|---|
| [设计文档](design/2026-09-09-ssh-design.md) | 调研结论、技术选型、架构、数据模型、安全红线、里程碑、SPIKE 清单、风险 |
| [工作区优化规划](design/2026-09-12-ssh-workspace-plan.md) | **规划与实施记录**：现状诊断、信息架构、三主题桥接、连接生命周期契约、分期 U0–U3、验收矩阵。**U0（可靠性闭环）+ U1（统一工作区）已实施（2026-09-12），U2/U3 未动** |
| [工作区概念稿](design/preview/2026-09-12-ssh-workspace-concept.html) | 可交互概念稿：三主题 + 原生暗色、四档宽度、八种连接状态；仅本地演示 |
| [**Agent 化规划**](design/2026-09-14-ssh-agent-driven-plan.md) | **能力分层与实施规划（2026-09-14，待评审）**：平台事实核查（`ctx.tools` / `ctx.approval` / `ctx.subagents` / `ctx.terminals` / `tool.call.toolview` / host-preset 平面判据）、五条核心设计判断、四层能力（上下文桥 / 工具面 / 治理面 / 协作面）、工具清单、授权与命令分级、SPIKE 清单、验收矩阵、待评审取舍 |
| [CHANGELOG](design/CHANGELOG.md) | 本线变更记录 |

## 相关线

- [canvas 视图切换与叠压修复历史](../dsh-miasaki-canvas/design/CHANGELOG.md)
- [sidebar 终端启动器安全边界与 M3 内嵌终端规划](../dsh-miasaki-sidebar/README.md)
- [跨线共享参考](../dsh-miasaki-shared-docs/)
