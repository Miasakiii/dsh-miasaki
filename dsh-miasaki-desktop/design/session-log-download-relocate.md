# 会话日志下载按钮迁移：主界面 → 轨迹页搜索栏左侧

> 状态：**已实施**（2026-09-07）
> - 方案 A 动态插件验证通过（`slogm-1/pkg-3`：主界面按钮替换 + 轨迹页注入 + 下载全 OK；
>   关键坑——`slots.inject` 对晚激活插件无效，须用 `slots.register` 直接替换）
> - 方案 B 已固化落盘：`plugins/dsh-session-log-move/`（纯 client bundle）
> - 方案 C 不采纳
> 目标：DSH web GUI 的「Session 日志」下载按钮不再占用主界面（会话头部），
> 改到「轨迹」页 toolbar 搜索栏左边。
> 平台版本基线：以当前安装的 DSH（`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`）为准。

## 1. 现状结论（源码实测）

### 1.1 按钮从哪来

平台内置包 `@deepseek-ai/dsh-session-log-export`（服务名 `session-log-download`）：

| 事实 | 位置 |
|---|---|
| 按钮注册 slot | `conversation.session.header.utilities`，id `session-log-download` |
| 渲染组件 | `SessionLogDownloadHeaderAction`：胶囊按钮「Session 日志」+ 下载图标 + 结果对话框 |
| 公开 client 服务 | `ctx.provide("sessionLogDownload", controller)`；controller 提供 `download(sessionId)` / `dismiss(sessionId)` / `dispose()` 与公开状态 store |
| 下载实现 | `HEAD /api/session.export?sessionId=…&includeDescendants=true` 成功后触发浏览器下载 `dsh-session-<id>.zip`（含子会话与附件） |
| 命令联动 | 监听 `command/executed`，`/export` 命令复用同一下载链路 |

主界面头部即 `conversation.session.header` 的 utilities 区，按钮在这里（当前唯一 occupant）。

### 1.2 轨迹页搜索栏

轨迹页由 `@deepseek-ai/dsh-client-ui-trajectory` 实现，`TrajectoryToolbar` 结构：

```
div[role=toolbar]            ← toolbar 根（sticky）
└─ div.inner
   ├─ div.actions            ← 按钮组：时长模式 / 折叠轮次 / 折叠调用
   └─ div.search             ← 搜索栏（IconSearchOutline16 + input[type=search]）
```

「搜索栏左边」＝ `.actions` 与 `.search` 之间。**toolbar 没有任何官方 slot**，
官方 slot 目录里 trajectory 相关只有 `conversation.view`（页签级）与
`conversation.trajectory.images`（图片渲染），无法用注册方式挂进 toolbar。

### 1.3 平台给出的可复用语义

1. **slot 同 id 替换（官方契约）**：register 选项文档原文 ——
   “reusing a shipped id puts you in THAT cell and replaces it”。
   即注册 `id: 'session-log-download'` 到同一 slot，官方按钮条目被我们的条目替换。
2. **当前会话 id**：官方 UI 代码（`dsh-client-ui-conversation`）实际用法
   `sessions.list.getSnapshot().current` —— client `sessions` 服务的 `list`
   字段（ObservableSnapshot）持有当前会话。
3. **下载端点公开**：`/api/session.export` 是稳定 HTTP 接口，可不经服务自行调用。

## 2. 方案对比与推荐

| 方案 | 内容 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A. 动态 Cordis 插件（client） | 本会话临时插件：同 id 替换隐藏主界面按钮 + MutationObserver 往轨迹页搜索栏前注入按钮 | 立即可见、零落盘、快速验证锚点与体验 | 进程重启即失；需审批 | **先行验证** |
| B. 持久 DSH bundle（进仓库） | desktop 线 `plugins/` 新建 bundle，逻辑同 A | 版本化、随 profile 挂载持久生效 | 需改 profile package.json + 重启 host | **验收后固化** |
| C. 改平台源码 | 直接改 `@deepseek-ai/dsh-session-log-export` / `dsh-client-ui-trajectory` | 原生彻底 | 安装目录、升级覆盖、不进仓库 | 不采纳 |

**推荐路线：A → B**。先用 A 实测「同 id 替换是否干净、DOM 锚点是否稳定、
下载链路是否完整」，验收后把同一逻辑固化为 B，按 desktop 线既有
`dsh-token-monitor` 的 bundle 模式落盘安装。

## 3. 详细设计（client 插件，A 与 B 共用）

插件名建议：`dsh-session-log-move`（desktop 线 `plugins/dsh-session-log-move/`）。

### 3.1 隐藏主界面按钮（slot 同 id 替换）

```js
ctx.slots.inject('conversation.session.header.utilities', () =>
  ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-log-download',        // 复用官方 id → 占用同一 cell 并替换
  }, () => null),
)
```

- 替换后官方 `SessionLogDownloadHeaderAction`（按钮 + 对话框）不再渲染；
  官方插件本体仍在运行，其 `sessionLogDownload` controller 服务照常可用。
- 副作用：官方结果对话框随之消失 → 新按钮需自带下载反馈（见 3.3）。

### 3.2 轨迹页注入按钮（DOM 注入，无官方 slot）

- **锚点**（不依赖 CSS module hash 类名）：toolbar 内唯一的搜索输入
  `[role="toolbar"] input[type="search"]`，取其父容器 `.search`，
  `insertAdjacentElement('beforebegin', 按钮)`。
- **生命周期**：`ctx.effect()` 内建 MutationObserver 观察
  `document.body`（childList + subtree），toolbar 出现即注入、消失即回收；
  插件停止/重载时移除按钮并断开 observer，主界面官方按钮随之恢复。
- **实现形态**：纯原生 DOM（`document.createElement` + `addEventListener`），
  不依赖 React/ReactDOM 在动态环境中的可用性；样式贴 toolbar（高 20px、
  `--dsw-*` 主题令牌，亮暗双主题跟随）。
- 按钮文案「Session 日志」+ 下载图标；`aria-label` 完整描述。

### 3.3 点击链路与反馈

```
点击
 └─ sessionId = ctx.sessions.list.getSnapshot().current     ← 点击时实时取，不缓存
 └─ downloader = ctx.get('sessionLogDownload')              ← 官方服务，可选
     ├─ 可用 → downloader.download(sessionId)               ← 完全复用官方链路
     └─ 不可用 → 自实现 fallback：
         HEAD /api/session.export?sessionId=…&includeDescendants=true
         成功 → 触发浏览器下载 dsh-session-<id>.zip
 └─ 反馈：订阅 downloader.store（SnapshotStore：getSnapshot/subscribe）
     bySession[sessionId].status: downloading → 按钮禁用+「准备中…」
     success → 「已开始下载」（3 秒复位）；error → 「下载失败」tooltip/提示
```

fallback 时自行维护等价状态机（复用官方 store 形状，便于日后切换）。

### 3.4 生命周期与可逆性

- 所有副作用（slot 注入、observer、按钮 DOM、订阅）全部挂在 `ctx.effect()`
  返回的 disposer 上 —— 停止/重载后主界面按钮自动恢复、轨迹页按钮消失。
- 不触碰官方插件本身，不动 `/export` 命令链路（`command/executed` 监听保留）。

## 4. 风险与降级

| 风险 | 概率 | 降级 |
|---|---|---|
| R1 平台升级后 toolbar DOM/类名变化 | 中 | 锚点只用语义选择器 `[role=toolbar] input[type=search]`；升级后冒烟测试复查 |
| R2 `sessionLogDownload` 服务不可 `ctx.get` | 低 | 3.3 的自实现 fallback（官方 HTTP 端点公开稳定） |
| R3 `sessions.list` 字段非公开契约 | 低 | 实施第一步验证；不可用则从会话绑定/DOM 上下文推导当前 id |
| R4 官方未来改条目 id / 新增 occupant | 低 | 冒烟检查主界面是否残留按钮（occupants 变化即失效信号） |
| R5 无障碍 | — | 按钮入 toolbar 语境，带 `aria-label`、禁用态与键盘可达 |

## 5. 实施步骤（A → B）

1. **A-1 动态插件**：`cordis_define`（client half，idPrefix `slogm`）→ `cordis_run`；
   验证 3.1 替换生效、3.2 锚点命中、3.3 下载完整。
2. **A-2 冒烟**：见 §6 清单，逐项过。
3. **B-1 固化**：新建 `dsh-miasaki-desktop/plugins/dsh-session-log-move/`：
   `package.json`（`dsh.client` web 声明 + `dsh.profile.bundles` 信息）、
   `cordis.patch.yml`（insert）、`lib/client.js`、`README.md`。
   host 半无职责（不写 index.js）。
4. **B-2 安装**：`%USERPROFILE%\.dsh\profiles\web\package.json` 加 `file:` 依赖 +
   `dsh.profile.bundles` 挂载（同 dsh-token-monitor 安装流程），host 重启生效。
5. **B-3 验收**：§6 清单 + 动态插件已停用（避免双份按钮）。
6. **文档同步**：desktop `README.md`（插件清单/目录树）、`design/CHANGELOG.md`。

## 6. 验收清单

- [ ] 主界面（对话页头部）不再出现「Session 日志」按钮
- [ ] 轨迹页 toolbar 搜索栏左侧出现下载按钮，亮/暗主题样式正常
- [ ] 点击 → 浏览器下载 `dsh-session-<id>.zip`（含子会话、附件）
- [ ] 下载中按钮禁用 + 文案「准备中…」；成功/失败反馈正确
- [ ] 切换会话后点击，下载的是当前会话（非缓存旧 id）
- [ ] `/export` 命令仍正常工作（官方链路未受影响）
- [ ] 插件停止/重载：主界面官方按钮恢复、轨迹页按钮消失（可逆）
- [ ] 刷新页面（SPA 重挂）后按钮随 toolbar 重新注入

## 7. 变更文件规划

| 阶段 | 文件 |
|---|---|
| A（临时） | 无落盘（动态插件，进程内） |
| B（固化） | `dsh-miasaki-desktop/plugins/dsh-session-log-move/`（新增 4 文件） |
| 文档同步 | `dsh-miasaki-desktop/README.md`、`dsh-miasaki-desktop/design/CHANGELOG.md` |
| 安装配置 | `%USERPROFILE%\.dsh\profiles\web\package.json`（用户机，外部仓） |
