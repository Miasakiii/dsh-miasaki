# 官方仓库复查（增量）：0.1.7-rc.2 与升级触发条件首次满足

- 日期：2026-09-25
- 调研者：总指挥（Miasaki 会话）
- 上一份同类：[`dsh-official-repo-review-2026-09-21.md`](dsh-official-repo-review-2026-09-21.md)（09-21，0.1.6-alpha.2）
- **配套（同日实测）**：[`dsh-0.1.7-rc2-upgrade-assessment-2026-09-25.md`](dsh-0.1.7-rc2-upgrade-assessment-2026-09-25.md)
  —— 本文回答「官方仓库这两周变了什么、影响哪几条线」，该文回答「**现在就升到 rc.2 要花多大力气**」
  （7 个补丁在 rc.2 真实产物上逐个跑 `apply` 的实测结果）。
- 口径：`[实测]` = 本次拉 GitHub/npm API、下载真实产物或本地跑命令核到；`[推断]` = 基于证据的判断，本次未做隔离实例实测
- 方法升级 `[实测]`：本轮对契约文件的「变没变」采用 **blob SHA 双 ref 比对 + 逐字节 diff** 两道，
  且**每次下载都校验退出码与字节数**（原因见 §9「本轮的方法论教训」）。

---

## 0. 摘要

1. **★★★ 升级触发条件首次满足**：09-23 那份评估把条件定为「等 `next` 轨出现 `0.1.7-rc.*`」。
   实测 npm 渠道标签：**`next = 0.1.7-rc.2`**，`latest = 0.1.5-rc.3`，`alpha = 0.1.7-alpha.2`。
   **条件已满足，可以进入升级决策**，而不再需要被动等待。
2. **契约面零必改**：`alpha.2 → rc.2` 之间 7 个关键契约文件**全部有改动，但全部是纯增量**，
   五条 web 线的 13 个注册点**无一命中破坏性变更**；`host/webserver/src/index.ts`（`index-inject`）
   **逐字节未变**（blob SHA 相同）。
3. **遮蔽关系不变**：`ui-sidebar-right/tab-registry.ts` 的 kind 裁决规则（extension 压 builtin）**未变**，
   官方终端在 rc.2 仍是 `kind: 'terminal'` + `priority: 'builtin'`，我们依然遮蔽它。
   **但官方终端新出现 `multiple: true`（多标签）**——遮蔽它的机会成本上升，§5 给出复评。
4. **新机制：插件 peer 兼容性硬闸门**（rc.1，PR #5061）。本仓实测**零命中**，但
   **desktop 线 3 个插件踩在检查范围内**（声明了 `@deepseek-ai/dsh-settings` 等 peer），
   当前与 rc.2 均判定通过；**隐患是上界 `<0.2.0`**，dsh 一旦进 0.2.0 这三个插件会被直接拒绝。§4。
5. **官方持续压向本仓卖地**：rc.1 起「Web 侧边栏新增终端」「插件管理页」「侧边栏 Office 预览 /
   浏览器模式 / Subagent 会话」全部落地；rc.2 又把「定时任务与时间上下文」默认关闭。§6。
6. **六个 desktop 补丁 + dual-model 补丁在 rc.2 上全部锚点命中**，增量与 alpha.2 上**逐字节一致**——升级成本为零。详见配套文档。

---

## 1. 仓库动态 `[实测]`

| 项 | 值（2026-09-25） | 相对 09-21 |
|---|---|---|
| 仓库 | `deepseek-ai/deepseek-harness`（MIT / TypeScript / 默认分支 `master`） | — |
| 最新 Release | **`dsh-v0.1.7-rc.2`**，published `2026-09-24T14:10:21Z`，prerelease | `0.1.6-alpha.2` → `0.1.7-rc.2` |
| master HEAD | rc.2 release merge（2026-09-24） | 09-21 时停在 09-17 |
| npm dist-tags | `latest = 0.1.5-rc.3`；**`next = 0.1.7-rc.2`**；`alpha = 0.1.7-alpha.2` | **`next` 由 `0.1.5-rc.3` → `0.1.7-rc.2`** ★ |
| Star / Fork / Watcher | **235,598** / 28,335 / 1,018 | +3,728 / +527 / +22 |
| 对外形态 | Issues 与 PR 均禁用，反馈只走 Discussions | 未变 |
| 本机运行版本 | `0.1.7-alpha.2`（`dsh --version`） | 09-23 晚用户已升 alpha |

> **发布节奏**：`alpha.1`(09-22) → `alpha.2`(09-22) → **`rc.1`(09-23) → `rc.2`(09-24)**。
> 两天内从 alpha 推进到 rc.2，节奏明显加快；`latest` 仍停在 `0.1.5-rc.3`（未跟随）。

---

## 2. 升级触发条件：已满足 ★★★

09-23 的结论是「等 `next` 出现 `0.1.7-rc.*`」。本轮实测：

```
latest = 0.1.5-rc.3     alpha = 0.1.7-alpha.2     next = 0.1.7-rc.2    ← 已触发
```

**判读**：`next` 轨从 `0.1.5-rc.3` 直接跳到 `0.1.7-rc.2`，说明官方把 0.1.7 系列推进到了候选阶段。
按既有约定，升级决策现在可以启动——成本实测见配套评估文档（结论：7/7 补丁零适配）。

> 注：`latest` 仍是 `0.1.5-rc.3`。若新装环境走 `latest`，装到的仍是旧版；
> 本次升级应显式指定 `next` 轨（`0.1.7-rc.2`）。

---

## 3. 契约面逐项核对：7 个文件有改动，**零必改** `[实测]`

方法：对每个文件取 `dsh-v0.1.7-alpha.2` 与 `dsh-v0.1.7-rc.2` 两个 ref 的 blob SHA（先判变没变），
再把两份内容下载到临时目录做逐字节 diff（再判怎么变）。
**每次下载都校验进程退出码与落盘字节数**（§9 教训）。

| 契约文件 | 增/删 | 实际内容 | 本仓注册点 | 判定 |
|---|---|---|---|---|
| `ui-sidebar-right/.../contract/slots.ts` | +19/−1 | 新增 `SidebarRightTabCommands{refresh?}`；`SidebarRightTabActions` 新增 `bindCommands()`（**框架侧实现，非注册者实现**）；`tab.refreshShortcut?`；`visible` 注释语义更新 | sidebar 线 5 槽 | ✅ kind/scope **全未变** |
| `ui-sidebar-right/.../tab-registry.ts` | +3/−0 | `SidebarRightGuideEntry` 新增可选 `commandId?: ShortcutCommandId` | sidebar 线 kind 裁决 | ✅ **裁决规则未变** |
| `ui-conversation/.../contract/slots.ts` | +2/−0 | `ComposerBarInjected.hooks` 新增 `stopShortcut` | canvas / ssh / dual-model | ✅ `header.actions`、`input.right` 未变 |
| `ui-settings/.../contract/slots.ts` | +4/−0 | `SettingsLauncherOwnerProps` 新增 `settingsOpen`（必填）、`settingsShortcut?` | appearance 线 | ✅ `settings.section` 未变 |
| `ui-sidebar/.../contract/slots.ts` | +2/−1 | `SidebarRootInjected.hooks` 新增 `shortcuts` | desktop·token-monitor | ✅ `sidebar.footer.action` 未变 |
| `ui-layout/src/client/index.ts` | +27/−4 | `inject` 增 `shortcuts`；新 locale 命名空间 `shortcuts.layout`；`LayoutController` 构造增 `panelInfo` 参数；注册 `sidebar.left.toggle` | canvas / ssh / desktop | ✅ **`shell.overlay` 仍为 `list`/`root`**（实测 L91 声明） |
| `ui-chat/.../contract/slots.ts` | +60/−2 | 新增 quota notice 一族（`QuotaNoticeCode/State/OwnerProps/Injected/HostProps`）+ 新槽 `shell.quota-notice` | 本仓未用该槽 | ✅ 纯新增 |
| `host/webserver/src/index.ts` | **SAME** | blob SHA 相同 | appearance 线 | ✅ `webserver/index-inject` 零改动 |

**结论**：五条 web 线的 13 个注册点在 rc.2 上**零必改**。
本轮新增的槽（`shell.quota-notice`）与本仓无交集；新增字段全部可选，或属于 owner→注册者的注入面
（由框架填充，注册者不构造），**不构成插件侧迁移**。

---

## 4. 新机制：插件 peer 兼容性**硬闸门**（rc.1）`[实测]`

rc.1 引入 `feat(plugins): deny incompatible bundles and clarify compatibility refusals`（PR #5061）
与 `feat(plugins): report incompatible versions as typed refusals`。本轮读到实现本体：
`packages/boot/app-boot/src/plugin-compatibility.ts`（104 行，已通读）。

### 4.1 判定规则（源码级）

```
evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)
  ├─ manifest 无 peerDependencies 字段 → 直接返回 undefined（不检查）★
  ├─ 只检查名字为 '@deepseek-ai/dsh' 或以 '@deepseek-ai/dsh-' 开头的 peer
  ├─ 范围判定：semver.satisfies(runtimeVersion, range, { includePrerelease: true })
  │    · 'workspace:^' / 'workspace:~' / 'workspace:*' → 视为当前运行时版本（恒通过）
  │    · 空串或非法范围 → 判为不兼容
  └─ runtimeVersion = app-boot 包自身版本（即 dsh 本体版本）
不兼容 ⇒ 拒绝加载；需 `dsh plugin allow-version` 做 **精确版本豁免**（name@version ↔ runtime version）
```

### 4.2 对本仓的实测核对 ★

| 插件 | peerDependencies | 是否进入检查 | 判定 |
|---|---|---|---|
| canvas / sidebar / ssh / dual-model / appearance | **无该字段** | 否（函数首行即返回） | ✅ 零影响 |
| `dsh-token-monitor` / `dsh-session-log-move` | 仅 `@deepseek-ai/cordis` | 否（前缀不匹配） | ✅ 零影响 |
| **`dsh-pet-panel`** | `@deepseek-ai/dsh-settings: ^0.1.2-rc.1` | **是** | ✅ 通过 |
| **`dsh-model-probe`** | 同上 + `@deepseek-ai/dsh-host-webserver: ^0.1.2-rc.1` | **是** | ✅ 通过 |
| **`dsh-free-model-pool`** | 同上两项 | **是** | ✅ 通过 |

`[实测]` semver 判定（`includePrerelease: true`）：

```
0.1.5-rc.3     vs ^0.1.2-rc.1  → SATISFIED
0.1.7-alpha.2  vs ^0.1.2-rc.1  → SATISFIED
0.1.7-rc.2     vs ^0.1.2-rc.1  → SATISFIED
```

### 4.3 需要登记的隐患

`^0.1.2-rc.1` 的隐含上界是 **`<0.2.0`**。也就是说：

- 升到 `0.1.7-rc.2`：**安全**（实测通过）；
- 未来 dsh 进入 **0.2.0**：这三个插件会被**直接拒绝加载**，直到把 peer 范围放宽或加豁免。

**建议**（非本次实施）：趁本次升级顺手把三个插件的 peer 范围改为更耐久的形式
（例如 `>=0.1.2-rc.1 <0.3.0`，或与本体同轨的 `workspace:` 形式），把「迟早会撞」变成「不会撞」。

---

## 5. 官方终端状态与「遮蔽」复评 `[实测]`

读 rc.2 的 `packages/client/ui-sidebar-terminal/src/client/index.ts`：

```
L72:  id, kind: 'terminal', multiple: true, priority: 'builtin', title: () => t('title'),
L17-18 / L102-129: TerminalRecovery / TerminalCleanup 仍整段注释掉
```

**三点判读**：

1. **遮蔽关系不变**：官方仍是 `kind: 'terminal'` + `priority: 'builtin'`，我们仍是未声明 priority 的
   **extension**，按 `tab-registry.ts` 的「extension 压 builtin」规则，**我们继续遮蔽官方终端**。
   09-21 §5 登记的「半遮蔽」隐患（Recovery/Cleanup 残留）在 0.1.7 已由官方自己注释掉，**依然消失**。
2. **新变量：`multiple: true`**。这正是 rc.1 release note「Web 侧边栏新增终端，支持**多标签**、
   Shell 选择和刷新后恢复」的来源。**官方终端变强了**——它不再是一个"被遮蔽也无所谓"的占位实现。
3. **决策含义**：09-21 判「遮蔽更好用（无重复入口）」，那是基于官方终端能力弱的前提。
   rc.1 之后前提变了：**遮蔽 = 主动放弃官方已具备的多标签 / Shell 选择 / 刷新恢复**。
   是否继续遮蔽，建议在 sidebar 线实机验收时**连同这一条一起复评**（换 `miasaki-terminal` 之类的
   独立 kind 即可并存，代价是引导页出现两个终端入口）。**本次不拍板。**

---

## 6. 功能面撞车（rc.1 / rc.2 相对 `v0.1.5-rc.3` 的汇总）`[实测，取自 release note]`

> 注意口径：`rc.1` 的 release note 是**自 `v0.1.5-rc.3` 以来的汇总**，不等于「rc.1 新增」。
> 例：「侧边栏新增终端」的**包**（`ui-sidebar-terminal`）在 0.1.6-alpha.1 就已存在（09-21 §5 已登记），
> rc.1 的这条实际指其**能力增强**（多标签等）。判读时勿当作全新包。

| rc | 变更 | 撞谁 | 级别 |
|---|---|---|---|
| rc.1 | Web 侧边栏终端：**多标签 / Shell 选择 / 刷新后恢复** | **sidebar 线（正面）** | 高 |
| rc.1 | 插件管理页：安装 / 配置 / 启停 / **运行时卸载** | 七条线全部 | 高 |
| rc.1 | 侧边栏 Office 预览（Word/Excel/PPT/CSV/TSV） | sidebar / ssh | 中 |
| rc.1 | 侧边栏浏览器模式访问 URL | ssh | 中 |
| rc.1 | 侧边栏打开 Subagent 会话 | sidebar / canvas | 中 |
| rc.1 | 会话文件改动审阅（逐行 / 左右分栏 / 同步滚动） | sidebar 审查 tab | 中 |
| rc.1 | 插件安装可选官方源 / 国内镜像 / 自定义源 | 安装侧（对国内网络是**正向**） | 中 |
| rc.1 | **MCP 支持发现与读取资源、URI 模板** | —（本会话已生效★） | 低 |
| rc.1 | Headless stdin / `--session-id` / `--json` 逐行事件 | fleet 线可关注 | 低 |
| rc.1 | 动态工具更新（会话中途启用新工具，无需另开对话） | dual-model / 插件工具注册 | 中 |
| rc.1 | 实验性 Computer Use / Playwright MCP / Chrome DevTools MCP | — | 低 |
| rc.2 | **Web 与桌面端默认关闭定时任务与时间上下文** | **profile 插件集合** | 中 |
| rc.2 | 插件管理页可启用自动审阅；**Inspector 不再默认提供，需单独安装** | profile 插件集合 | 中 |
| rc.2 | 账号任务与 API Key 任务使用独立模型入口 | desktop | 低 |
| rc.2 | Windows 修复：文件菜单图标、目录 junction、安装包启动失败、Markdown 图片预览 | **desktop 线（正向）** | 中 |
| rc.2 | 过长工具输出的残字与后续对话失败修复；长对话无法发送消息修复 | 全体（正向） | 中 |

★ **MCP 资源**这条本会话已实际生效：当前工具集里已出现 `list_mcp_resources` /
`list_mcp_resource_templates` / `read_mcp_resource`（server: `openviking`），可直接印证该能力在生产路径上。

---

## 7. 对七条线的影响（更新版）

| 线 | 影响 | 级别 | 相对 09-21 的变化 |
|---|---|---|---|
| **sidebar** | 官方终端获得**多标签 / Shell 选择 / 刷新恢复**；「遮蔽」从零成本变成有成本；官方 tab 类型继续增多 | **高（方向级）** | **新增**：遮蔽的收益面被官方削弱，需复评 |
| **canvas** | `conversation.session.header.actions`、`shell.overlay` 均未变；`session/created`/`session/event` 未变 | 低 | 无变化 |
| **ssh** | 官方 `ui-sidebar-browser` 与我们 iframe 视图相邻；ssh 的槽（`header.actions` / `shell.overlay`）未变 | 中 | 无新增 |
| **dual-model** | `settings/updated` 在 rc.2 **确认仍为移除态**，只有 `settings/document-updated`；09-23 的适配在 rc.2 上**继续有效**；补丁 +745 锚点命中 | **低** | 由「中」维持低位——事件面已闭环 |
| **appearance** | `settings.section` 未变、`webserver/index-inject` **逐字节未变** | 低 | 无变化 |
| **desktop** | 6 个补丁**全部锚点命中**；3 个插件踩在兼容性闸门检查范围内（当前通过）；Windows 修复多为正向 | **低（本轮下调）** | 由「中」下调——补丁零适配 |
| **fleet** | Headless(`stdin`/`--session-id`/`--json`)、Team 面板、动态工具更新 | 中 | 无新增（多为 alpha.1 已登记项的延续） |

---

## 8. 行动建议

**P0**

1. **升级决策可以启动**（触发条件已满足）。成本实测：**7/7 补丁零适配**、**契约面零必改**、
   **事件面已在 09-23 闭环**。详见配套评估文档。
2. 升级时**显式走 `next` 轨**（`0.1.7-rc.2`）——`latest` 仍是 `0.1.5-rc.3`，不要用 `latest`。
3. 升级前记住：**host 侧补丁需重启 `dsh web` 生效，重启会断开当前 harness 会话**。

**P1**

4. **把三个 desktop 插件的 dsh peer 范围改耐久**（§4.3）——这是唯一「迟早会撞」的定时炸弹。
5. **sidebar 的遮蔽决策连同 `multiple: true` 一起复评**（§5）——官方终端已不是弱实现。

**P2**

6. 桌面端 Windows 修复项（rc.2）值得在升级后实测一轮：目录 junction、Markdown 图片预览、
   文件菜单图标、安装包启动。
7. rc.2 默认关闭「定时任务与时间上下文」——升级后确认本仓 profile 是否需要显式重新启用。

---

## 9. 本轮的方法论教训（值得写下来）

**下载类逐字节比对必须校验字节数，不能只看 diff 结果。**

本轮首轮核对时，`ui-sidebar-right/contract/slots.ts` 的 diff 曾显示「**整个文件被删除（−199 行）**」。
真相是：该次 `gh api` 调用**静默失败**（错误被 `2>$null` 吞掉），落盘了一个 **0 字节文件**，
于是 diff 把「下载失败」渲染成了「文件被删除」——这是一个会导致**完全错误结论**的假象。
加 `$LASTEXITCODE` 校验 + 落盘字节数打印后，真实变化是 **+19/−1**。

同类教训（本轮再次踩到）：批量脚本按「优先 `lib/client.js`」探测目标产物，
而 `dsh-api-session-controller` **同时含 `client.js` 与 `index.js`**，
导致 dual-model 补丁被喂了错误的文件、报出「锚点命中 0 次」——
**看起来像补丁失效，实则是脚本选错了目标**。修正后 +745 命中。

两条合起来：**凡是"工具说失败/说变了"，先怀疑工具链自己；凡是"工具说成功"，也要用第二道证据交叉验证。**

---

## 10. 本轮边界（未做的事）

1. **未做隔离实例实测**：以上全部为源码级 / 产物级结论，未在隔离实例 + 无头浏览器上验证真实挂载。
2. **未升级、未重打补丁**：补丁 apply 全部在**临时目录的产物副本**上完成，
   未触碰 `%APPDATA%\npm` 的真实安装目录（`patch.mjs status` 未对实装环境运行）。
3. **未评估 0.1.7 的定向机制迁移**（09-23 文档 §7.9 登记的「预设组合包化」）——仍排队中。
4. **未逐条实测 rc.2 的 Windows 桌面修复项**（§8 P2）。
5. **未做自动审阅 / 插件管理页 / Inspector 变动的插件作者影响分析**——
   09-21 §9.2 已将其列为独立课题，本轮仍未立项。

---

## 附：本次核实方法

- GitHub REST API（只读）：仓库元数据、`releases`、`commits`、`contents`（**双 ref blob SHA 比对**）。
- `gh` CLI（已登录 `Miasakiii`）：`search/code` 定位实现文件；`contents` + `Accept: application/vnd.github.raw` 取正文。
- npm 只读：`registry.npmjs.org/-/package/@deepseek-ai/dsh/dist-tags`（渠道标签）；
  `npm pack <pkg>@<ver> --cache <临时目录> --pack-destination <临时目录>`（下载真实产物）。
  —— 注：沙箱禁止写 `%LOCALAPPDATA%\npm-cache`，**把 `--cache` 指向临时区即可**（不污染工作区）。
- 本地逐字节 diff：`git diff --no-index`（产物与契约文件），**每次附带字节数校验**。
- semver 判定实测：`node -e` + `semver.satisfies(v, r, { includePrerelease: true })`。
- **未执行**任何安装 / 升级 / 重启；本仓受版本控制的文件中，本次仅新增本文档与配套评估文档。
