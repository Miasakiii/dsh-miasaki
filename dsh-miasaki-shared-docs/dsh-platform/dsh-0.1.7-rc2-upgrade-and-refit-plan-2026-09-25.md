# DSH 0.1.7-rc.2 升级与七线全量适配规划

- 日期：2026-09-25
- 状态：**待用户批准**（本文只做规划，未动任何代码）
- 依据：[`dsh-official-repo-review-2026-09-25.md`](dsh-official-repo-review-2026-09-25.md)（官方仓库复查）
  + [`dsh-0.1.7-rc2-upgrade-assessment-2026-09-25.md`](dsh-0.1.7-rc2-upgrade-assessment-2026-09-25.md)（升级实测）
- 用户指令（2026-09-25）：① 放宽 peer 范围；② 停止遮蔽官方终端；③ 围绕 rc 线版本做各线优化、全量适配
- 口径：`[实测]` = 本轮已跑命令/读源码核到；`[计划]` = 待执行；`[待核]` = 执行时需现场确认

---

## 0. 目标与范围

三件事，按依赖排序：

| # | 目标 | 性质 | 阻塞关系 |
|---|---|---|---|
| **W1** | 本体从 `0.1.7-alpha.2` 升级到 **`0.1.7-rc.2`** | 基础设施 | 阻塞 W2/W3/W4（新能力只在 rc 上可用） |
| **W2** | **放宽** 3 个 desktop 插件的 dsh peer 范围 | 一行改动 ×5 | 可独立于 W1 先做 |
| **W3** | **停止遮蔽**官方终端（kind 改名） | sidebar 线改动 | 依赖 W1（官方终端能力在 rc 才完整） |
| **W4** | **七条线全量适配 + 接入 rc.2 新能力** | 主线工作 | 依赖 W1 |
| **W5** | **全量回归与实机验收** | 收口 | 依赖 W1–W4 |

**不在本次范围**：ssh 线 U2.2（SFTP）/ U3（跳板转发）；canvas 操作按钮方案乙决议；fleet 的派单流程强制化。

---

## 1. 现状基线 `[实测]`

### 1.1 运行环境

| 项 | 值 |
|---|---|
| 本机 DSH | `0.1.7-alpha.2`（全局 npm） |
| 目标版本 | **`0.1.7-rc.2`**（`next` 轨；`latest` 仍是 `0.1.5-rc.3`，**不用**） |
| profile | `~/.dsh/profiles/web`：pnpm 管理（`nodeLinker: hoisted`、`autoInstallPeers: false`、有 `pnpm-lock.yaml`） |
| profile 依赖 | 5 个 `link:`（canvas / sidebar / ssh / dual-model / appearance）+ 5 个 `file:`（desktop 五个插件）+ 3 个 npm 插件（openviking-memory / browser-playwright / tool-browser） |
| profile bundles | 16 项（含 `dsh-base`、`dsh-web-app`、`dsh-experimental-agent-team-profile`） |
| 装配文件 | `cordis.yml`（空入口）+ `cordis.patch.yml`（19 KB，真正的装配处） |

### 1.2 七条线现状

| 线 | 版本 | 测试文件 | 当前状态（登记口径） |
|---|---|---|---|
| **desktop** | `v0.1.0` + 5 插件 | 7 | 6 个本体补丁在本机 alpha.2 **实装目录已全部 `patched`**（[patch-live-audit.mjs](scripts/patch-live-audit.mjs)，09-24：9 目标/8 件）；`verify-all desktop` **23 项**、`cargo test` **35 例**。**欠账**：偶发「全黑无响应」根因**未定位**（[TODO:15-30](dsh-miasaki-desktop/design/TODO.md#L15-L30)）、后端断连自愈 / 拖拽上传十项 / 启动加载 S4a **待实机**、启动加载 S1–S3 未动、桌宠 v3 多项未竟 |
| **fleet** | `v0.20.0` | 7 | **与 DSH 本体解耦**（零 `@deepseek-ai/dsh*` 依赖、零 peerDependencies）；`verify-all fleet` **15 项**（108 例）。**唯一耦合点** = dsh worker 档案（`agents/dsh/manifest.json` 的 `dsh --profile headless {prompt}`，**headless profile 尚未建**、档案 version 停在 `0.1.1-rc.1`）⇒ 正是 rc.1 Headless 新能力的落点 |
| **canvas** | `v0.5.0-miasaki.6` | 8 | MVP M1–M4 已实机验收；V1–V4 视觉已实施（单测 **89 例**）。**欠账**：⚠️ **0.1.2 起历史会话存量投影不回填**（启动 replay 空 ⇒ 旧会话多为无内容骨架卡，[CHANGELOG:195](dsh-miasaki-canvas/design/CHANGELOG.md#L195)，**本次升级最该复核的一条**）；V1–V4 视觉走查（18 张截图清单）未做；字重 720→600 待对比图 |
| **sidebar** | `v0.9.0-miasaki.0` | 8 | 终端两形态已实机验证（单测 **62 例** / `verify-all` **10 项**）。**欠账**：v0.9.0 多标签**整体待重启实机验证**（不串台 / 两容器同看一会话不错行 / 刷新恢复 / 8 上限 / 三主题）；辅助对话 tab（M2）设计完成**未实现**；WS `list` 帧未实现（与设计偏差） |
| **ssh** | `v0.1.0-miasaki.0` | 6 | D2/D3/D4 + U2 已跑过一轮（单测 **113 例** / `verify-all` **12 项**）。**欠账**：全量合并复验待重启；**U2.4 上一轮实际未上线**（`hasSerializeAddon` 只在 apply 判一次，重启即解，非代码缺陷）；U2.2 SFTP / U3 未动；**README:99 关于 `conversation.view` 的记载已过期**（该注册在 D3 清理中已整体删除，[client.js:9-11](dsh-miasaki-ssh/client.js#L9-L11)） |
| **dual-model** | `v0.1.3-miasaki.0` | 5 | M1 完成（单测 33 例 / `verify-all` 12 项）。**欠账**：① 带图发送放行（union 语义）**补丁已打但须重启 `dsh web` 才生效、尚未验证**；② 设置事件为**双轨并监**（`settings/updated` + `settings/document-updated`，[lib/invalidation.js:19](dsh-miasaki-dual-model/lib/invalidation.js#L19)），rc.2 上只有新名生效 ⇒ 无需改 |
| **appearance** | `v0.1.0-miasaki.0` | 8 | M2 已落地（单测 95 例 / `verify-all` 16 项），**无本体补丁**。**欠账**：M2 视觉矩阵 + 帧率基线 + 让位协议 4 项、M2.5 头像链路、M2.6 面板视觉、M2.7 四款预设图标**均待实机**；2026-09-23 修的「外观栏整栏空白」**待用户硬刷新（Ctrl+F5）验收** |

> **关键判读**：七条线里 **6 条都卡在「已实施、待实机验证」**。所以「全量适配」的实质 =
> **把升级后的 rc.2 当作统一验收基线，一次性把积压的实机验收做完**，而不是大改代码
> （契约面已实测零必改）。

### 1.3 三条 web 线的接口脆性（升级时最该盯的面）`[实测]`

| 线 | 依赖的 DSH 面 | 脆性 |
|---|---|---|
| **canvas** | `conversation.session.header.actions`（id `canvas-view-switch`，order 25）；**官方 CSS Module 类名子串** `[class*="_headerActions"]`（[client.js:80](dsh-miasaki-canvas/client.js#L80)）；`[data-sidebar-right-panel="push"][data-sidebar-right-open]` + 官方 **28px** padding 逐字绑定（[:90](dsh-miasaki-canvas/client.js#L90)）；Session API **三路兼容**（`snapshotEvents` / `isSeeded`+`inheritedEventCount` / `seedLength`） | 中高（选择器 + Session API 双绑） |
| **sidebar** | `sidebarRightTabs.register`（kind 裁决 + priority band）；`sidebar.right.pane.tab` + `useTabInfo()`；`ctx.layout.closeDetails()`；`ctx.get('sidebarRight')` | **高**（`kind:'terminal'` 与官方 builtin 撞 kind ⇒ 撞则抛错、插件加载失败）→ **W3 正是拆这颗雷** |
| **ssh** | `conversation.session.header.actions`（id `ssh-view-switch`，order **26**）、`shell.overlay`（id `ssh-launcher`，order 40）、**`registerUpgrade` 签名**、**canvas 的 DOM 类名/结构** | 中高（跨线 DOM + 双槽，见 R10） |

**三条共性**：① **均未声明 `peerDependencies`** ⇒ 升级不会被包管理器拦下，**只能靠实机回归**；
② host 半与静态资源都有**进程内缓存** ⇒ 改完必须重启 `dsh web`（见 R12）；
③ 三份 `cordis.patch.yml` 数据目录互不共享（`miasaki-canvas/workspaces.json` / `miasaki-sidebar/state.json` / `miasaki-ssh/`）。

---

## 2. W1 · 升级本体到 rc.2

### 2.1 步骤 `[计划]`

```powershell
# ① 装 rc.2（显式走 next 轨）
npm i -g @deepseek-ai/dsh@0.1.7-rc.2
dsh --version                       # 期望 0.1.7-rc.2

# ② profile 依赖重装（宿主生态既定方式：在 profile 目录跑 pnpm）
cd $env:USERPROFILE\.dsh\profiles\web
pnpm install

# ③ 7 个本体补丁逐个重打
cd <repo>\dsh-miasaki-desktop\patches\<每个补丁目录>
node rebuild-baseline.mjs           # 用新装原版重建 baseline，打印待同步常量
#   → 同步常量进 patch.mjs（预期 EDITS 零改）→ node patch.mjs verify → node patch.mjs apply

# ④ 第三方补丁重打
cd <repo>\dsh-miasaki-shared-docs\dsh-platform\patches\dsh-browser-playwright
node patch.mjs apply --yes

# ⑤ 重启 dsh web（host 侧补丁生效）+ 刷新页面（client 侧生效）
```

### 2.2 已实测的预期值（用于验证"打对了"）`[实测]`

| 补丁 | 目标 | rc.2 原始字节 | 补丁后 | 增量 |
|---|---|---:|---:|---:|
| `dsh-client-ui-attachment` | `lib/client.js` | 45,064 | 45,175 | +111 |
| `dsh-client-ui-chat` | `lib/client.js` | 530,699 | 532,563 | +1,864 |
| `dsh-client-ui-conversation` | `lib/client.js` | 712,829 | 712,954 | +125 |
| `dsh-client-ui-settings-models` | `lib/client.js` | 186,454 | 201,924 | +15,470 |
| `dsh-client-ui-trajectory` | `lib/client.js` | 421,649 | 423,513 | +1,864 |
| `dsh-cordis-host-runner` | `lib/index.js` | 102,835 | 103,592 | +757 |
| `dsh-api-session-controller`（dual-model） | `lib/index.js` | 124,151 | 124,896 | +745 |

> **重打时若某个增量对不上 → 立刻停下核对锚点**（`EDITS` 应按预期零改；增量是锚点全部命中的强证据）。

### 2.3 验收标准

- [ ] `dsh --version` = `0.1.7-rc.2`
- [ ] 7 个补丁 `node patch.mjs status` 全部报 `patched`
- [ ] 7 个补丁的增量与 §2.2 表**逐个一致**
- [ ] `node scripts/verify-all.mjs` 全绿（desktop 项需在 **MSVC 环境**跑 `cargo test`）
- [ ] web UI 能正常启动（无 "Failed to load plugins" / 启动屏卡死）
- [ ] browser-playwright 的浏览器工具可用

### 2.4 风险与回退

| 风险 | 说明 | 处置 |
|---|---|---|
| 会话日志 V3→V4 迁移 | 0.1.7 起日志格式升级，**降级路径变远** | 升级前备份 `~/.dsh` 会话目录；接受"不可轻易回退" |
| 插件不兼容被跳过 | rc.1 新增 peer 闸门 + `Profile.skippedBundles` | 升级后检查启动日志有无 skipped bundle |
| `latest` 陷阱 | `latest` 仍是 `0.1.5-rc.3` | **必须显式指定 `@0.1.7-rc.2`** |
| 硬链补丁被冲掉 | pnpm store 与 `lib/*.js` 是硬链，重装插件会还原 | 任何插件重装后**重跑 `apply`** |

---

## 3. W2 · 放宽 dsh peer 范围（用户点名 ①）

### 3.1 改动清单（精确到行）`[实测]`

| 文件 | 行 | 现值 | 改为 |
|---|---|---|---|
| [dsh-pet-panel/package.json](dsh-miasaki-desktop/plugins/dsh-pet-panel/package.json#L26) | 26 | `"@deepseek-ai/dsh-settings": "^0.1.2-rc.1"` | `">=0.1.2-rc.1 <0.3.0"` |
| [dsh-model-probe/package.json](dsh-miasaki-desktop/plugins/dsh-model-probe/package.json#L28-L29) | 28 | `"@deepseek-ai/dsh-settings": "^0.1.2-rc.1"` | 同上 |
| 〃 | 29 | `"@deepseek-ai/dsh-host-webserver": "^0.1.2-rc.1"` | 同上 |
| [dsh-free-model-pool/package.json](dsh-miasaki-desktop/plugins/dsh-free-model-pool/package.json#L26-L27) | 26 | `"@deepseek-ai/dsh-settings": "^0.1.2-rc.1"` | 同上 |
| 〃 | 27 | `"@deepseek-ai/dsh-host-webserver": "^0.1.2-rc.1"` | 同上 |

共 **5 处**。

### 3.2 为什么是这个范围 `[实测]`

```
版本            ^0.1.2-rc.1（现状）   >=0.1.2-rc.1 <0.3.0（新）
0.1.7-rc.2      true                  true      ← 当前与目标版本
0.2.0           false ← 定时炸弹       true      ← 修掉
0.2.5-rc.1      false                 true
0.3.0           false                 false     ← 保留保护，届时应重新评估
```

- 旧范围 `^0.1.2-rc.1` 隐含上界 `<0.2.0` ⇒ **dsh 一进 0.2.0，这三个插件会被 rc.1 的 peer 闸门直接拒绝加载**；
- 新范围覆盖 0.1.x / 0.2.x，同时保留 0.3.0 的挡板（不无限放宽，保持"大版本变更需人工确认"的意图）。

> `@deepseek-ai/cordis: ^4.0.2` **不动**——它不以 `@deepseek-ai/dsh` 开头，**不进闸门检查**（源码级实测）。

### 3.3 验收标准

- [ ] 5 处全部改毕
- [ ] `node -e` 复跑 semver 判定：`0.1.7-rc.2` / `0.2.0` 均 `true`，`0.3.0` 为 `false`
- [ ] 三个插件的测试仍绿（`dsh-model-probe` 有 `npm test`）
- [ ] 升级后启动日志中三个 bundle 均未被 skip

---

## 4. W3 · 停止遮蔽官方终端（用户点名 ②）

> **⚠ 同日后续（已被取代，保留原文以供审计）**：W3 落地后用户**进一步拍板右栏终端整体退役**——
> 「新版 dsh 右侧边栏有终端项，沿用官方的策略，本项目不再做右侧边栏终端」。终端 tab 类型
> （kind `miasaki-terminal`）已注销，`openTab('miasaki-terminal')` 调用点与本文 §4.2/§4.4 中
> 「两个终端入口并存」「同一 pty 两个 viewer」等验收项**随之作废**；右栏只留「审查」，
> 内嵌终端收敛为底部面板单形态（host 半零改动）。决策与触摸点见
> [`../../dsh-miasaki-sidebar/design/CHANGELOG.md`](../../dsh-miasaki-sidebar/design/CHANGELOG.md)
> 2026-09-25 第一条（v0.10.0-miasaki.0）。官方终端即右栏终端的唯一提供方，本节「停止遮蔽」的
> 初衷（不放弃官方能力、消除脆性）由退役以更强的方式达成。

### 4.1 背景：为什么要停 `[实测]`

`ui-sidebar-right/src/client/tab-registry.ts` 的裁决规则：**一个 kind 最多容纳 `builtin` + `extension` 各一条，
extension 压过 builtin**。我们的终端注册 `kind: 'terminal'`（extension），官方内置终端是 `kind: 'terminal'`（builtin）
⇒ **官方终端被我们遮蔽**（引导页不出现它的入口）。

**09-25 复查发现前提变了**：rc.2 的官方终端已具备 `multiple: true`（多标签）+ Shell 选择 + 刷新后恢复。
遮蔽 = 主动放弃官方这些能力，且第三方若也注册 `terminal` 的 extension 会**双方抛错、插件加载失败**（脆性）。
**用户已拍板：停止遮蔽。**

### 4.2 改动清单 `[实测]`

| 文件 | 行 | 现值 | 改为 | 说明 |
|---|---|---|---|---|
| [dsh-miasaki-sidebar/client.js](dsh-miasaki-sidebar/client.js#L2256) | 2256 | `kind: 'terminal',` | `kind: 'miasaki-terminal',` | 改用独占命名空间，**不再与任何方撞车** |
| [dsh-miasaki-sidebar/client.js](dsh-miasaki-sidebar/client.js#L1073) | 1073 | `service.openTab('terminal')` | `service.openTab('miasaki-terminal')` | **必须同步改**，否则「底部面板 → 右栏」会打开**官方终端**（另起 pty），破坏「同一 pty 两个 viewer」的核心设计 |
| [dsh-miasaki-sidebar/client.js](dsh-miasaki-sidebar/client.js#L2269-L2274) | 2269–2274 | 「我们恰好遮蔽官方终端」注释 | 重写为「**不再遮蔽**：改用独占 kind，与官方终端并存」 | 注释必须跟着事实走 |

**不需要改的**（已核实）`[实测]`：
- 正文派发：`ctx.slots.register({ name: 'sidebar.right.pane.tab', key: tab.id }, ...)` 的 key 是**类型 id**（`@miasaki/dsh-sidebar/terminal`），与 kind 无关 ⇒ **换 kind 不影响渲染**；
- [test/rightbar-guide.test.js](dsh-miasaki-sidebar/test/rightbar-guide.test.js)：测试自己传 title/description 调用工厂，**不依赖注册处的 kind** ⇒ 无需改；
- `priority: 'extension'` 保留（已显式声明）。

### 4.3 连带影响与处置

| 影响 | 说明 | 处置 |
|---|---|---|
| **引导页出现两个终端入口** | 官方「终端」+ 我们的「终端」同名 | **把我们的标题改为「内嵌终端」**，description 写明差异（同一 pty 双形态 / 跟随会话 cwd） |
| **已持久化的旧 tab 恢复**（**已确认，非推测**）`[实测]` | rc.2 的 `ui-sidebar-right/src/client/persistence.ts:20` 持久化的 tab 记录形如 `{ id, kind, contentId, title }` —— **`kind` 被写进 `localStorage`**（命名空间 `dsh.sidebar-right.v1.<sessionId>`）。改名后旧记录 `kind: 'terminal'` 会解析到**官方终端** | **接受一次性影响**：验收时关闭旧终端 tab、从引导页重开。**不做**存储迁移——① 那是宿主内部格式（ns 自带 `v1` 版本号）；② 我们**无法区分**"我们的 terminal tab"与"官方 terminal tab"，盲改会把官方的记录也改成我们的，更糟 |
| **`openTab` 语义变化** | 外部若有人按 `'terminal'` 打开，将得到官方终端 | 本仓内只有 L1073 一处（已列入改动）；插件对外不承诺该 kind |
| **与官方的能力重叠** | 官方已有多标签 / Shell 选择 | **定位重审**：我们主打「底部面板 + 右栏共享**同一 pty**」「跟随当前会话 cwd」「Ctrl+\` 全局唤起」，不重复造官方已有的能力 |

### 4.4 验收标准

- [ ] `kind` 改名 + `openTab` 同步改 + 注释重写
- [ ] 引导页出现**两个**终端入口，且我们的显示为「内嵌终端」
- [ ] 底部面板「在右栏打开 ↧」→ 右栏显示的是**同一个 pty**（不是新会话）
- [ ] 官方终端单独打开可用（多标签、Shell 选择、刷新恢复）
- [ ] sidebar 单测 62 项仍绿
- [ ] **不再存在**「第三方注册 `terminal` 导致加载失败」的风险面

---

## 5. W4 · 各线 rc.2 适配与优化

### 5.1 适配面（已被实测证明为零必改）

| 线 | 注册点 | rc.2 契约 | 适配动作 |
|---|---|---|---|
| canvas | `conversation.session.header.actions` | 未变 | **零** |
| sidebar | `sidebar.right.pane.tab` 等 5 槽 | kind/scope 未变 | **零**（W3 是主动优化，非适配） |
| ssh | `conversation.session.header.actions`（order 26）、`shell.overlay`（order 40） | 未变（`shell.overlay` 仍 `list`/`root`） | **零** |
| dual-model | `conversation.input.right` | 未变 | **零**（设置事件适配已在 09-23 落地且 rc.2 复核有效） |
| appearance | `settings.section`、`webserver/index-inject` | 未变（后者 blob SHA 相同） | **零** |
| desktop·token-monitor | `conversation.view` / `sidebar.footer.action` / `shell.overlay` | 未变 | **零** |
| fleet | 不注册 DSH web 槽 | — | **零** |

### 5.2 rc.2 新能力接入矩阵（真正的"优化"在这里）

| 新能力（契约增量） | 能力是什么 | 建议接入线 | 价值 | 成本 |
|---|---|---|---|---|
| `ctx.shortcuts.register({ id, label, aliases, defaults, regions, modals, resolve })` | **官方快捷键服务**：可自定义、可搜索、侧栏同步显示键位；**注册时自带 `resolve` 回调 ⇒ 官方负责按键分发与模态门控**（`regions: ['page','editable','terminal']`，可覆盖终端区域） | **sidebar**（终端 `Ctrl+\`` 一族）、canvas、ssh | **高** | 中 |
| `SidebarRightTabActions.bindCommands({ refresh })` + `tab.refreshShortcut` | tab 可绑定"刷新"操作，官方在菜单/快捷键里暴露 | **sidebar**（审查 tab 手动刷新，现为 60s TTL 轮询） | 中 | 低 |
| `SidebarRightGuideEntry.commandId` | 引导页条目显示快捷键 | sidebar | 低 | 低 |
| `ComposerBarInjected.hooks.stopShortcut` | 输入框区域可读 Stop 快捷键 | **dual-model**（`conversation.input.right`） | 低 | 低 |
| `SettingsLauncherOwnerProps.settingsOpen` / `settingsShortcut?` | 设置开合状态 + 键位 | **appearance** | 低 | 低 |
| `SidebarRootInjected.hooks.shortcuts` | 侧栏可读键位表 | desktop·token-monitor | 低 | 低 |
| `shell.quota-notice` 槽（新增） | 额度提示 host | 可选（desktop 用量线） | 低 | 中 |
| **MCP 资源**（发现/读取/URI 模板） | 插件可暴露资源供 Agent 读取 | ssh（主机列表）、canvas（会话布）、desktop（会话日志） | 中 | 中 |
| **插件管理页**（安装/配置/启停/运行时卸载） | 官方入口 | 全部（安装体验 + 排查手段） | 中 | 低（无需改代码） |
| **Headless stdin / `--session-id` / `--json`** | 无头编排 | **fleet** | 中 | 中 |

### 5.3 各线任务（建议优先级）

**P0（本次必做）**
1. **sidebar**：W3 停止遮蔽 + 标题/描述区分 + 验收
2. **desktop**：W2 放宽 peer + 7 补丁重打（含在 W1）+ Windows 修复项实测
3. **全七线**：在 rc.2 上完成**积压实机验收**（这是"全量适配"的实体）

**P1（本次建议做）**
4. **sidebar**：终端快捷键接入官方 `shortcuts` 服务（用户可自定义键位；顺带消掉自研 capture 拦截的维护面）
5. **sidebar**：审查 tab 接 `bindCommands({ refresh })`
6. **desktop**：rc.2 的 Windows 修复项（目录 junction / Markdown 图片预览 / 文件菜单图标）逐项实测并记录
7. **desktop**：rc.2 契约面零必改，但**两个插件的 settings 读取双轨**（`lib/settings-read.js`：`typeof get` 探针 → 0.1.7+ 走 `describe()`）是**升级后必回归的实机点**（[README:382-388](dsh-miasaki-desktop/README.md#L382-L388)）
8. **fleet**：dsh worker 档案校准 + 新建 headless profile，接 rc.1 的 `--session-id` / `--json`（补上"dsh 仍为非活动 worker"这条欠账）

**P2（可延后，登记即可）**
9. canvas / ssh：注册官方快捷键；canvas 三主题 × 明暗 × 三档缩放视觉走查
10. 各线：MCP 资源暴露（需先定信息架构）
11. **desktop·`dsh-session-log-move`**：与官方 `dsh-session-log-export` **同 slot id 永久冲突**（主界面隐藏行为永久失败，已降级保留官方按钮，[README:422-427](dsh-miasaki-desktop/README.md#L422-L427)）—— 与 W3 属**同一类撞车问题**，建议本次只登记、不扩大改动面
12. **ssh · 文档债**：`README.md:99` 仍写「页面由 `conversation.view`（id `ssh`，order 20）托管」，而该注册**已在 D3 清理中整体删除**（[client.js:9-11](dsh-miasaki-ssh/client.js#L9-L11)，测试断言"必须已删除"）⇒ 按项目纪律**本次一并订正**，否则后人按错记载排查
13. **canvas · 视觉走查**：V1–V4 的 18 张截图清单（三主题 × 明暗 × 三档缩放）—— 与升级后的 rc.2 一并做，避免验两轮

---

## 6. 执行顺序与依赖

```
阶段 0  准备（本规划批准后）
         └─ 备份 ~/.dsh（会话日志 + profile 装配文件）
         └─ W2 放宽 peer（可提前做，与升级无依赖）
              ↓
阶段 1  W1 升级本体  ──────────────┐
         └─ 装 rc.2 → profile pnpm install → 7+1 补丁重打 → 重启
              ↓                     │
阶段 2  W3 停止遮蔽（sidebar）        │  此时才具备官方终端完整能力
         └─ 改名 + openTab + 注释 + 标题 → 单测 → 实机
              ↓                     │
阶段 3  W4 各线适配与优化  ←─────────┘
         └─ P0 实机验收 → P1 新能力接入 → P2 登记
              ↓
阶段 4  W5 全量回归
         └─ verify-all 全绿 + 逐线实机清单 + 文档同步（各线 README/CHANGELOG）
```

**关键路径**：W1 → W3 → 验收。W2 与 W1 可并行。

---

## 7. 风险登记

| # | 风险 | 触发条件 | 缓解 |
|---|---|---|---|
| R1 | 升级后 web UI 打不开 | 某插件纤维 pending（0.1.7 曾发生） | browser-playwright 补丁已适配；重启前先 `verify-all` |
| R2 | 补丁锚点失效 | 官方在 rc.2 后的版本又改产物 | 增量比对（§2.2）作为哨兵；失效则按 README「升级后怎么办」适配 |
| R3 | 硬链补丁被重装冲掉 | 重装任一 file: 插件 | 重装后**必跑 `apply`**；`status` 报 `original` 即知 |
| R4 | 会话日志不可降级 | 已升级并产生新日志 | 升级前备份；接受单向 |
| R5 | 停止遮蔽后用户困惑 | 引导页两个终端入口 | 标题区分 + 首帧引导文案 |
| R6 | 快捷键接管冲突 | 接入官方 shortcuts 后与本机/浏览器键冲突 | 逐个键位实测；官方支持用户自定义，冲突可由用户改 |
| R7 | `cargo test` 环境假阴性 | Git Bash 的 `link.exe` 遮蔽 MSVC | **必须在 MSVC 环境跑**（既有教训） |
| R8 | **appearance 配置版本号撞车** | `CONFIG_VERSION = 3` 已被 `avatar` 板块占用（[lib/config.js:160-170](dsh-miasaki-appearance/lib/config.js#L160-L170)），而 Boot Splash 设计文档写的迁移是「v2→v3 仅加默认字段」（[CHANGELOG.md:115](dsh-miasaki-appearance/design/CHANGELOG.md#L115)） | 实施 Boot Splash 前**先定新版本号**（v4），否则迁移逻辑会与 avatar 互踩 |
| R9 | appearance 依赖前端壳内部导出名 | primitives 图标名漂移曾致「外观栏整栏空白」（[CHANGELOG.md:19-54](dsh-miasaki-appearance/design/CHANGELOG.md#L19-L54)） | rc.2 升级后**首帧就走查一次外观栏**；该线已有回归闸门 |
| R10 | **跨线 DOM 硬依赖**：ssh 依赖 canvas 的类名与结构 | ssh 的会话头锚点与回退按钮都找 `.dsh-canvas-switch` / `.dsh-canvas-overlay`，合体胶囊圆角靠 `:has(+ .dsh-ssh-switch)`（[ssh/client.js:60-64](dsh-miasaki-ssh/client.js#L60-L64)）⇒ **canvas 一改类名，SSH 入口即失效** | 本次两线**不得同时改这些锚点**；若须改，先写跨线约定（建议提升为 `cross/` 文档） |
| R11 | canvas 历史会话投影不回填 | 0.1.2 起启动 replay 为空，旧会话成骨架卡（[canvas CHANGELOG:180](dsh-miasaki-canvas/design/CHANGELOG.md#L180)、[:195](dsh-miasaki-canvas/design/CHANGELOG.md#L195)） | **升级后专项复核**：0.1.7 的 Session API 是否已提供 persistence 读接口；有则立项修，无则继续挂账 |
| R12 | 改完只刷浏览器不生效 | canvas / sidebar 的 client bundle 与 ssh 的 `cachedAsset` 都是**进程内缓存** | **必须重启 `dsh web`**；这条对 W3（sidebar 改动）与所有 host 侧补丁都成立 |

---

## 8. 验收清单（W5）

**自动化**
- [ ] `node scripts/verify-all.mjs` 全绿（全量基线 **96 项**；desktop 项须在 **MSVC 环境**跑）
      已知分线项数：desktop **23**、fleet **15**（108 例）、dual-model **12**（33 例）、appearance **16**（95 例）
- [ ] `cargo test --bin miasaki` **35 例**（MSVC 环境）
- [ ] **`node scripts/patch-live-audit.mjs` 报全部 `patched`**（既有的 9 目标/8 件）
      —— **这条不可省**：`verify-all` 里的 patch `verify` 只证「规则与基线自洽」，**不证 live 在位**；
      升级后只有 live audit 能证明实装目录真的被打上了
- [ ] 各线单测全绿（**本轮实测口径**：canvas **89** / sidebar **62** / ssh **113** / dual-model **33** / appearance **95** / fleet **108** 例 / desktop `cargo test` **35** 例）
      —— 注：ssh README 记的是「110 例」，实测为 **113 例**，落档时一并订正

**实机（rc.2 上逐线）**
- [ ] **desktop**：桌宠六态、主题切换、5 个插件面板、Windows 修复项
- [ ] **canvas**：会话布渲染 + 三主题 × 明暗 × 三档缩放走查
- [ ] **sidebar**：审查 tab 四视图 + 终端多标签 + **两形态共享同一 pty** + 两个终端入口并存
- [ ] **ssh**：U0+U1+A0+D2–D4+U2 合并清单（重启 `dsh web` 后）
- [ ] **dual-model**：图片准入 + 辅助模型路由 + 输入框右下角配置
- [ ] **appearance**：设置「外观」栏 + 皮肤/壁纸/玻璃档位 + 首帧防闪
- [ ] **fleet**：CLI 编排回归
- [ ] 全局：插件管理页可见并可启停；确认「定时任务 / 时间上下文」默认关闭后的实际形态

**文档同步**
- [ ] 各线 `README.md` + `design/CHANGELOG.md` 更新（升级适配 + 新能力接入）
- [ ] 本规划追加"实施结果"章节
- [ ] desktop `patches/*/README.md` 的 baseline 版本号更新到 rc.2

---

## 9. 执行记录（2026-09-25 起）

### W2 · 放宽 peer —— ✅ **已完成**

- **改动**：5 处全部落地（清单见 §3.1），范围 `^0.1.2-rc.1` → `>=0.1.2-rc.1 <0.3.0`。
- **验证**（`[实测]`）：**逐字复刻** `plugin-compatibility.ts` 的 `evaluatePluginCompatibility` 后，对**真实 package.json** 跑判定：

  | 插件 | 0.1.5-rc.3 | 0.1.7-alpha.2 | 0.1.7-rc.2 | 0.2.0 | 0.2.5-rc.1 | 0.3.0 |
  |---|---|---|---|---|---|---|
  | dsh-pet-panel | PASS | PASS | PASS | **PASS** | PASS | DENIED |
  | dsh-model-probe | PASS | PASS | PASS | **PASS** | PASS | DENIED |
  | dsh-free-model-pool | PASS | PASS | PASS | **PASS** | PASS | DENIED |
  | dsh-token-monitor（对照，未改） | PASS | PASS | PASS | PASS | PASS | PASS |

  —— 0.2.0 的定时炸弹**已拆除**，0.3.0 的挡板**保留**。
- **回归**：`plugins/dsh-model-probe` 单测 **12 例全过**（含 `≤0.1.6 get world` / `0.1.7 describe world` 双轨用例）。
- **文档**：`dsh-miasaki-desktop/design/CHANGELOG.md` 已加当日条目。

### W3 · 停止遮蔽 —— ✅ **代码完成，待实机**

- **改动**：3 处（清单见 §4.2）+ 标题改「内嵌终端」+ 描述订正（原描述写的是**终端启动器**的能力，不是本 tab 定位）。
- **验证**（`[实测]`）：`node --check index.js` / `client.js` 均通过；
  单测 **62 项（57 pass / 5 skip / 0 fail）** —— 5 个 skip 是**既有**的 `canCaptureGit()` 环境跳过（受限沙箱无法捕获 git 子进程输出），**与本改动无关**。
- **文档**：sidebar `README.md`（「接入方式」行 + 组件蓝图「内嵌终端（两形态）」行）+ `design/CHANGELOG.md` 已更新。
- **待实机**：需**重启 `dsh web`** 后按 §4.4 验收（两个入口 / 同一 pty / 官方终端独立可用）。

### W1 · 升级本体 —— ✅ **已完成（2026-09-25 本会话执行）**

**结论**：`dsh --version` = **`0.1.7-rc.2`**；7/7 本体补丁全部 `patched`；browser-playwright 两半保持 `patched`。

- **原「阻断原因 1」已不成立**：本会话实测 `%APPDATA%\npm` **可写**（探针 `WRITE_OK`），
  `npm i -g` 可在会话内完成。原记录的单点失败已被推翻，**不要**再据此把 W1 推给用户。
- **新发现的坑（任务书未预见，两次安装失败才定位）★**：`koffi@3.3.1`（被 `dsh-fs-local` 依赖）
  的 install 脚本 `cnoke.cjs -P . -D src/koffi --prebuild --release` 在本机**必然失败**：
  其 `checkPrebuild()` 实现是 `spawnSync(node, ['-e','require(process.argv[1])', package_dir])`
  —— 用 `require(koffi 包目录)` 去验证「预编译是否可用」，而该 require 又依赖**平台包**
  `@koromix/koffi-win32-x64` 在 reify 期已就位。npm reify 的时序不保证 ⇒ 判为无效 ⇒
  回退源码编译 ⇒ 无 CMake ⇒ `code 1` ⇒ npm 整体失败并回滚（回滚本身还被 safe-delete shim
  部分拦截，留下 52 个文件删除告警）。**两次失败**分别用 managed node 22 与系统 node 24，
  ⇒ 与 Node 版本、与沙箱 shim 均无关（清空 `NODE_OPTIONS` 复跑仍失败）。
- **处置**：`npm i -g --ignore-scripts @deepseek-ai/dsh@0.1.7-rc.2`（用**系统 npm 11.12.1**，
  其 prefix 已正确指向 `%APPDATA%\npm`；**不要**用 managed npm，其 prefix 指向自身目录）。
  实测本次安装仅 3 个脚本（`@google/genai` no-op / `koffi` 失败 / `node-pty` 成功），
  跳过脚本后**逐项验证无副作用**：`require(koffi)` → **KOFFI_OK**（koffi 运行时优先走
  `@koromix/koffi-<platform>` 平台包，**不依赖 `build/`**）；`require(node-pty)` → **PTY_OK**
  （包自带 `prebuilds/` 已足够，无需重跑 node-pty 脚本）。
- **第三方补丁无需重打**：`@yeesy369/dsh-browser-playwright` 属 profile 插件，不随本体升级，
  实测两半仍 `PATCHED` 且 `verify` 27 项 PASS。
- **profile 侧**：`pnpm install` 已跑（6.1s，`reused 5`，未动 browser-playwright 补丁）。
  但**必须手动同步 `file:` 插件**——实测 `pnpm install` 对 `file:` 是 no-op（无内容指纹），
  W2 的 5 处 peer 改动**不会**自动生效，已用 `cp -f` 覆盖 3 个插件的 `package.json` 到
  `~/.dsh/profiles/web/node_modules/<pkg>/`。
- **回滚点**：`~/.dsh-backup/{sessions,profiles-web,dsh-npm-global-0.1.7-alpha.2}`。
- **待用户执行**：启动 `dsh web`（当前 3080 未监听，dsh web 未运行）→ 刷新页面验收。

#### 9.0 W1 实际执行记录（补丁重打明细）

| 补丁 | baseline 原版 B | 产物 B | 增量 | 任务书预期 | 判定 |
|---|---:|---:|---:|---:|---|
| `dsh-client-ui-attachment` | 45,064 | 45,175 | +111 | +111 | ✅ |
| `dsh-client-ui-chat` | 530,699 | 532,563 | +1,864 | +1,864 | ✅ |
| `dsh-client-ui-conversation` | 712,829 | 712,954 | +125 | +125 | ✅ |
| `dsh-client-ui-settings-models` | 186,454 | 201,924 | +15,470 | +15,470 | ✅ |
| `dsh-client-ui-trajectory` | 421,649 | 423,513 | +1,864 | +1,864 | ✅ |
| `dsh-cordis-host-runner` | 102,835 | 103,592 | +757 | +757 | ✅ |
| `dsh-api-session-controller` | 124,151 | 124,896 | +745 | +745 | ✅ |

**7/7 增量与 §2.2 预期逐字节一致 ⇒ EDITS 零改得到独立验证**。

**重打流程的两处与任务书描述不符（已按实际修正）**：
1. **不存在 `rebuild-baseline.mjs`**（§2.1/§9.1 写错）。实际 CLI：A 类
   （attachment / settings-models / api-session-controller）用 `rebuild`；
   **`dsh-api-session-controller` 的命令名是 `seal`**，不是 `rebuild`，且它 `verify` 要求
   `baseline/index.patched.js` 与重建逐字节一致 ⇒ **重打必须 `seal` → `verify` → `apply`**。
2. B 类（chat / conversation / trajectory / cordis-host-runner）**不存 patched 全文**，
   只存 `PATCHED_SHA256`；`verify` 在常量未同步时会以 FAIL **打印**重建 SHA，据此回填即可。

**另一处环境坑**：受限沙箱下 `spawnSync` 的**管道捕获会失败**（拿不到子进程输出，表现为
「锚点可能失效」但错误串为空）。批量脚本必须用**文件重定向**（`stdio:['ignore',fd,fd]`）而非
`encoding:'utf8'` —— 与 `verify-all.mjs` 已记录的 stdio 限制同源。

**验收**：`patch-live-audit` → 9 目标/8 件全 `patched`，`✅ live 安装与补丁基线一致`。

---

### W1（原记录，已作废）· ⏸ 交由用户执行（沙箱限制，已实测）

- **阻断原因 1**：本会话沙箱为 workspace-write，**写 `%APPDATA%\npm` 被拒** ——
  实测探针 `New-Item %APPDATA%\npm\.dsh-write-probe` 报 `Access to the path … is denied`
  ⇒ `npm i -g` **无法在会话内完成**。
- **阻断原因 2**：重启 `dsh web` 会**切断本会话**。
- 因此 W1 的安装与重启必须在**外部终端**执行；本会话已把它能做的部分全部做完
  （rc.2 产物上的 7/7 补丁预验证、契约核对、代码侧改动）。

#### 9.1 W1 用户执行清单（可复制）

```powershell
# ① 备份（升级不可轻易回退：会话日志要做 V3→V4 迁移）
robocopy "$env:USERPROFILE\.dsh\sessions" "$env:USERPROFILE\.dsh-backup\sessions" /MIR /NFL /NDL /NJH /NJS
robocopy "$env:USERPROFILE\.dsh\profiles\web" "$env:USERPROFILE\.dsh-backup\profiles-web" /MIR /NFL /NDL /NJH /NJS

# ② 装 rc.2（显式走 next 轨；latest 仍是 0.1.5-rc.3，不要用）
npm i -g @deepseek-ai/dsh@0.1.7-rc.2
dsh --version                      # 期望：0.1.7-rc.2

# ③ profile 依赖重装
cd "$env:USERPROFILE\.dsh\profiles\web"
pnpm install

# ④ 7 个本体补丁逐个重打（在仓库里跑）
$repo = 'C:\Users\Asakii\Desktop\dsh-miasaki'
$patches = @(
  "$repo\dsh-miasaki-desktop\patches\dsh-client-ui-attachment",
  "$repo\dsh-miasaki-desktop\patches\dsh-client-ui-chat",
  "$repo\dsh-miasaki-desktop\patches\dsh-client-ui-conversation",
  "$repo\dsh-miasaki-desktop\patches\dsh-client-ui-settings-models",
  "$repo\dsh-miasaki-desktop\patches\dsh-client-ui-trajectory",
  "$repo\dsh-miasaki-desktop\patches\dsh-cordis-host-runner",
  "$repo\dsh-miasaki-dual-model\patches\dsh-api-session-controller"
)
foreach ($p in $patches) {
  Write-Host "==== $p" -ForegroundColor Cyan
  Push-Location $p
  node rebuild-baseline.mjs        # 重建 baseline 并打印需同步的常量
  #  ← 把打印出的常量同步进 patch.mjs（预期 EDITS 零改）
  node patch.mjs verify
  node patch.mjs apply
  Pop-Location
}

# ⑤ 第三方补丁重打
cd "$repo\dsh-miasaki-shared-docs\dsh-platform\patches\dsh-browser-playwright"
node patch.mjs apply --yes

# ⑥ 验收（cargo test 必须在 MSVC 环境跑）
cd $repo
node scripts/patch-live-audit.mjs      # live 在位审计（verify-all 证不到这一层）
node scripts/verify-all.mjs
```

**预期值哨兵**（对照 §2.2，增量对不上就立刻停下核对锚点）：
`attachment +111` / `chat +1,864` / `conversation +125` / `settings-models +15,470` /
`trajectory +1,864` / `cordis-host-runner +757` / `api-session-controller +745`。

#### 9.2 备份体量参考 `[实测]`

| 路径 | 体量 | 说明 |
|---|---|---|
| `~/.dsh/sessions` | **201 MB** | 会话日志，**升级要做 V3→V4 迁移**，最该备份 |
| `~/.dsh/profiles/web` | 18.5 MB | profile 装配 + 插件 |
| `~/.dsh`（全量） | 725 MB | 含 node_modules，可不全备 |

---

## 10. 未决问题（需用户拍板）

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 停止遮蔽后，我们的终端**叫什么**？ | 「**内嵌终端**」（与官方「终端」区分，且点出"嵌在会话里"的差异） |
| Q2 | 审查 tab 与官方 `changes-review`（内置改动审阅）也重叠，**是否一并停让**？ | 建议**保留**——我们的四视图 + 收尾点名是官方没有的；但需在 README 里讲清差异 |
| Q3 | 是否本次就接官方 `shortcuts` 服务（终端快捷键）？ | 建议做（P1）——它同时消掉自研 capture 拦截的维护面 |
| Q4 | fleet 线是否纳入本次全量适配？ | 它与 DSH web 契约零耦合，建议只做**回归确认**，不投新能力 |
| Q5 | 升级时间点 | 升级会重启 `dsh web`、**断开当前会话**，建议本会话收尾后执行 |
| Q6 | 是否把各线「待实机验收清单」**并入统一回归矩阵**（[cross/smoke-test-matrix.md](dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)）作为升级前置？ | 建议**并入**——各线欠账已经积压 1–2 周，散在各线 README 里容易被漏掉 |
| Q7 | desktop 偶发「全黑无响应」根因未定位，是否作为升级的前置阻塞？ | 建议**不阻塞**（它是既有问题、与 rc.2 无关），但升级后若复现需保留现场取证 |

---

## 附：本规划的依据与边界

- 契约面、补丁实测、闸门判定、官方终端状态，全部来自同日两份文档的 `[实测]` 结论（未重复劳动）。
- W2/W3 的改动位置均已在源码中核对到**具体文件与行号**。
- **本规划未修改任何代码**；`git status` 中与本规划相关的改动仅有 09-25 新增的两份文档与其后续指引。
- 执行时的口径纪律不变：**凡"工具说失败"先怀疑工具链，凡"工具说成功"须有第二道证据**。
