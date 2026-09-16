# 官方仓库复查：0.1.6-alpha.1 与两条线的撞车预警

- 日期：2026-09-16
- 调研者：总指挥（Miasaki 会话）
- 上一份同类：`dsh-official-repo-review-2026-08-17-rc7.md`（08-17，rc.7）
- 口径：`[实测]` = 本次拉 GitHub API / 跑命令核到；`[推断]` = 基于证据的判断，本次未做隔离实例实测
- 涉及本仓：七条线全部；重点是 **sidebar / ssh / dual-model** 三条

---

## 0. 摘要

1. **官方在 0.1.6-alpha.1 自建了 SSH 与侧边栏终端**——这正好是我们 `ssh` 线与 `sidebar` 线（v0.8.1 终端两形态）的核心卖地。两条线都要重新回答"还做不做、做什么"。
2. **本地那份"官方仓库"离线副本已落后一个月**，跨越 rc.7 → 0.1.6 五个版本，不能再当现行契约用。
3. **运行版本本身没掉队**：`latest` 仍是 `0.1.5-rc.1`，与本地一致。0.1.6 挂在 `alpha` 轨，**不建议升**。

---

## 1. 仓库动态 `[实测]`

| 项 | 值 |
|---|---|
| 仓库 | `deepseek-ai/deepseek-harness`（MIT / TypeScript / 默认分支 master） |
| 最新 Release | **`dsh-v0.1.6-alpha.1`**，published `2026-09-15T04:57:57Z`（**昨天**），prerelease |
| master HEAD | `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`（2026-09-15，`perf(web): bootstrap client fast`） |
| npm dist-tags | `latest = 0.1.5-rc.1`；`next = 0.1.5-rc.2`；`alpha = 0.1.6-alpha.1` |
| Star / Fork | 225,648 / 26,874（08-17 评审时为 145,447——一个月 +8 万） |
| 对外形态 | Issues 与 PR **均禁用**，反馈只走 Discussions（镜像式仓库，与 08-17 结论一致） |

**发布节奏**（本周期）：09-08 alpha.1 → 09-09 alpha.2 → 09-10 rc.1 → 09-10 rc.2 → **09-15 0.1.6-alpha.1**。0.1.6-alpha.1 距上一个 tag 隔了 5 天，是本周期最长的一次。

---

## 2. 本地三处"官方副本"的新旧 `[实测]`

| 位置 | 形态 | 版本 | 时间 | 状态 |
|---|---|---|---|---|
| 全局安装 | npm | `0.1.5-rc.1` | — | **= npm latest，未掉队** |
| `vendor/deepseek-harness` | git clone | `0.1.0-rc.7` | HEAD `47f9438` @ **2026-08-13**（建仓当天，PR #2519 "feat/npm-public"） | **537 条脏改动**：488 已跟踪（大量 `.agents/notes/**` i18n）+ 49 未跟踪 |
| `_refs/deepseek-harness` | 解包快照（无 `.git`） | `0.1.1-rc.1` | 最后写入 **2026-08-21** | 含 apps/{cli,web} + 50 个 packages |

**结论**：两份离线副本都停在 8 月中下旬，**比线上少约一个月的提交**。凡涉及"官方现行契约"的判断，必须走 GitHub API 或 npm 包，不能引用这两份。

### 2.1 `vendor/` 那 537 条脏改动的甄别结论（2026-09-16 当日追查）

**成因** `[实测]`：该仓库是 **shallow clone（`--depth=1`，仅 1 个提交、0 个 tag）**，HEAD 停在 rc.5；而工作区内容在 **2026-08-17 04:03** 被 **rc.7 的源码包解压覆盖**（482/488 个文件的 mtime 精确落在同一分钟）。HEAD 未动、工作区已换版，于是全部差异以 `M` 呈现——**不是本地开发成果**。

三类内容，逐类有证据：

| 类别 | 数量 | 判定证据 | 处置 |
|---|---|---|---|
| **A. 官方 rc.7 内容** | ~483 | 抽样 blob 哈希与官方 tag **逐字节一致**（`packages/acp/acp/src/index.ts` = `7be2a2bd…417f`，与 `contents?ref=dsh-v0.1.0-rc.7` 返回的 sha 相同）；全量 diff 对本仓/本机标识（`miasaki`/`Asakii`）**零命中** | **可丢**，官方随时可再取 |
| **B. 模型设置补丁的源码草稿** | 4 | mtime 09-07，全在 `packages/client/ui-settings-models/`；成果已于 09-08 固化进 `dsh-miasaki-desktop/patches/dsh-client-ui-settings-models/`（该补丁 README 自述"**此前只存在于 `vendor/`，不入库**"，7 条 EDITS 与 vendor diff 逐条对应） | **可丢**，成果已入库并有 `verify` 自证 |
| **C. 孤儿修复** | 1 | `examples/jsonrpc-agent/tests/sdk.snapshot.ts`：把 `replaceAll('{{cwd}}', cwd)` 改成 `JSON.stringify(cwd).slice(1, -1)`（修 Windows 反斜杠进 JSON fixture 的转义）。blob 哈希与官方 rc.7 **不符**（`8fe3d45b` vs `9b45292d`），且 `scripts/` + desktop + shared-docs **全仓零固化**，官方到 `0.1.1-rc.1` 仍未修 | ⚠️ **唯一副本，先决定再动** |

未跟踪的 49 条：27 个 `.agents/notes/**` 官方决策笔记（08-11~08-15，rc.7 新增）+ 21 个官方源码（`scripts/`、`examples/`、`packages/`、`patches/`）+ **1 个 `.npmrc`（本地创建**，内容为把 pnpm store 重定向到 `vendor/.pnpm-store-session`，注释写明"沙箱无法写全局 store"）。

`vendor/` 下另有**不属该 git 仓**的本地产物：`runtime-bundle/`（`client.original.js` / `client.patched.js` / `client.runtime.js` / `patch-runtime.mjs`，09-05~09-07，模型设置补丁的早期工作产物，属 0.1.2-rc.1 时代）与 `.npm-offline-probe/`（09-07）。

> 整个 `vendor/` 已被根 `.gitignore` 第 22 行挡住，**不入库**。因此上述清理只影响本机磁盘，不影响仓库历史。

---

## 3. 0.1.6-alpha.1 有什么（按对本仓重要度排序）

### 3.1 官方新增 `packages/ssh`——**能力提供方级**的 SSH ★★★

Release note 原文：「扩展文件、命令及 PTC 工具，支持 DSH 在本地运行，通过 SSH 使用远端工作区。」

`[实测]` 包结构（0.1.6 tag）：`packages/ssh/` 下四个子包 + README×3

| 子包 | 含义 |
|---|---|
| `ssh` | 核心 |
| `fs-ssh` | **文件系统提供方**（FS provider over SSH） |
| `sandbox-ssh` | **沙箱提供方** |
| `subprocess-ssh` | **子进程提供方** |

`[实测]` 新增证据（两条独立旁证）：① 0.1.1-rc.1 快照的 50 个 packages 中**无** `ssh`；② 本地 0.1.5-rc.1 的 `@deepseek-ai/dsh` 依赖表里**无**任何 ssh 包。

**边界判断** `[推断]`：官方做的是「**让 DSH 的工具链跑在远端**」——把 fs / sandbox / subprocess 三个 provider 换成 SSH 版，模型仍在本地，工作区在远端。这**不是**「人在浏览器里手敲命令的终端客户端」。两者层次不同，但对"SSH 能力"这个标签是正面重叠。

### 3.2 官方新增 `packages/client/ui-sidebar-terminal` ★★★

Release note 原文：「Web 侧边栏新增终端，支持多标签、Shell 选择和刷新后恢复。」

`[实测]` 0.1.6 的 `packages/client/` 下，侧边栏家族现为：

```
ui-sidebar                     侧边栏本体
├── ui-sidebar-right           右侧栏（我们 sidebar 线接入的就是它）
├── ui-sidebar-files           文件树
├── ui-sidebar-documentpreview 文档预览
└── ui-sidebar-terminal        ← 本次新增：官方终端
```

**这条是直接撞车**：官方终端与我们 `dsh-miasaki-sidebar` v0.8.1-miasaki.0 的「内嵌终端两形态（底部面板 + 右栏 tab 共享同一 pty，node-pty 路线 B）」在同一套侧边栏体系内，功能重复。官方版还多了我们未做的**刷新后恢复**。

### 3.3 DeepSeek 协议链路与图片处理变更 ★★★（打 dual-model）

- **DeepSeek 默认改用 Messages 协议**，并通过 **Files API 复用已上传图片**；自定义 API 地址行为不变。若手工配过旧官方根地址，需移除或改为 `https://api.deepseek.com/anthropic`。
- **为适配 DeepSeek V4.1 调整图片缩放与 Token 估算**，提高默认请求图片尺寸与编码质量。
- 新增 **image offload** 会话事件：记录请求中被省略的历史图片，并在会话恢复/分叉时保留该记录。
- 请求图片缓存移至 `DSH_HOME/cache/attachments/request-images`（删除后可重建；原图保留；旧缓存不自动清理）。

`[推断]` 我们 `dual-model` 线的图片准入补丁（`patches/dsh-api-session-controller/`）针对的正是"图片如何进入请求"这条链，**大概率失效或变得多余**——但本次未验证，列为待办。

### 3.4 插件 / 工具 API 破坏性变更（全七线适用）`[实测，取自 release note]`

| 变更 | 影响面 |
|---|---|
| `agent/session-start` → 异步串行的 **`agent/created`**；首次模型请求等它完成 | 任何监听 session 启动的插件 |
| 弃用 Session 同步历史接口 `snapshotEvents` / `eventAt` / `ownEvents` | 读会话历史的插件 |
| PTC 包名 / 服务名统一为 **`ptc-runtime`**，**旧名不再兼容** | 引 PTC 的插件与配置 |
| 工作流执行器改为 **`workflow-ptc`**，遵循会话文件策略 | fleet 类编排 |
| `SandboxProvider.confine`、`ShellExecutor.start` → **可取消的异步**接口 | 沙箱 / 执行器相关 |
| 配置热更新**取消事务回滚**（解析失败保留原配置，激活失败可能半生效） | 所有 profile 配置 |
| 默认**不再启用 Ralph** | 需要显式开启 |
| **移除内置 E2B** 执行后端 | 自定义配置需调整 |
| MCP 升级官方 SDK v2（协议协商、工具分页、无工具服务器） | MCP 相关插件 |
| 实验性 Team 模式统一 `spawn_teammate`，关闭 `subagent` / `subagent_fork`，队友上限 8 → 16 | fleet |
| 子代理完成通知**仅传正文**（修推理块导致父会话 Messages 请求失败） | fleet / 子代理 |

`[实测]` 旁证交叉验证：0.1.1-rc.1 有的 `code-runtime` 与 `e2b` 两个包，在 0.1.6 的 packages 列表中**均已消失**，新增 `ptc-runtime`——与"PTC 改名""移除 E2B"两条 note 完全吻合。

### 3.5 与外观线（appearance）相关 `[实测，取自 release note]`

- 改善 Web 终端**文字与光标对比度**，**切换主题时保留应用配色**（刷新后的新视图暂不恢复该配色）。
- **推理与压缩摘要展开后标题随滚动吸顶**——这是新引入的 sticky 元素，可能影响外观层的样式覆盖面。
- 调整输入框加号菜单分组、统一斜杠菜单中英文展示——**我们做过 UI 覆盖的位置可能位移**。
- 文件、Skill 引用及交付文件链接**默认由侧边栏预览**。

### 3.6 其他值得记一笔的

- 实验性 **Browser Use**（Playwright MCP / Chrome DevTools MCP / Stagehand）与 **Computer Use**（Cua Driver MCP / 原生驱动）——`[实测]` 0.1.1 快照中均无此二包。官方在"操作外部环境"上明显扩张。
- Headless 支持 stdin 收任务、`--session-id` 续会话、`--json` 逐行事件。
- Settings 新增**已归档会话列表**（查看与恢复）。

---

## 4. 对七条线的影响

| 线 | 影响 | 级别 |
|---|---|---|
| **sidebar** | 官方 `ui-sidebar-terminal` 与我们的终端 tab 功能重复；官方版多"刷新恢复" | **高（方向级）** |
| **ssh** | 官方 `packages/ssh` 四包接管"远端工作区"能力层 | **高（方向级）** |
| **dual-model** | Messages 协议 + Files API 复用图片 + V4.1 图片链路；我们的图片准入补丁可能失效 | **高** |
| **appearance** | 终端主题配色、摘要吸顶新元素、输入框菜单重排——样式覆盖面需跟进 | 中 |
| **fleet** | Ralph 默认关闭、Team 模式改 `spawn_teammate`、子代理通知仅传正文 | 中 |
| **desktop** | 无直接冲击（Tauri 壳 + 桌宠不受影响） | 低 |
| **canvas** | 无直接冲击 | 低 |

---

## 5. 行动建议

**P0**

1. **不升 0.1.6-alpha.1**——alpha 轨 + 上表一串破坏性 API 变更，且 `sidebar`/`ssh` 两条线的处置方向未定。
2. **拍板两条线的方向**（需用户决策）：
   - `sidebar` 线的终端 tab：按 2026-09-10「官方做了侧边栏就用官方的」先例，**让位/退役**是默认选项；若要差异化保留，得先说清官方终端做不到什么。
   - `ssh` 线：官方拿走的是"工具链走远端"，我们做的是"人操作的交互式终端"。**两者可以共存**，但价值主张需要重写——建议把 U2（SFTP / 多 shell）从"补能力"改判为"还要不要做"。
3. **`dual-model` 的图片补丁冻结**，不再投入，等确认 0.1.6 的 Files API 路线是否已覆盖其诉求。

**P1**

4. `0.1.5-rc.2`（`next` 轨）是**低风险抬升**：只改了反馈提交体验与交付文件卡片排版，可作为下一次升级目标。
5. 决定 sidebar 终端 tab 去留前，**先做一次实机验证**——v0.8.1-miasaki.0 至今未验收，若本身就不通过，决策会简单很多。

**P2**

6. 同步 `vendor/` 与 `_refs/` 的官方副本到 0.1.6-alpha.1。**前置动作已完成**：488 条改动的甄别结论见 §2.1——A 类（官方 rc.7 内容，~483）与 B 类（模型设置补丁草稿，4）**可直接丢弃**，唯一的例外是 **C 类那 1 条孤儿修复**（`examples/jsonrpc-agent/tests/sdk.snapshot.ts` 的 `{{cwd}}` 转义），处置前需先决定去留。
7. 【C 类处置】若判定该修复仍有用，建议**先摘出来归档**（如 `_refs/scripts-archive/`）再覆盖 vendor；若判定无用（它只是让官方快照测试在 Windows 上跑得过，与七条线无耦合），则随 A/B 一起丢弃。

---

## 6. 待验证项（本次**未**做，留给下一轮）

以下都需要在 0.1.6 的隔离实例上实测，不能靠 release note 推断：

1. `sidebar.right.pane.tab` 与 `ctx.sidebarRightTabs.register` 是否仍有效、`guide` 的 `title`/`description` 仍要求**函数**（0.1.5 踩过这个坑）。
2. `settings.section` 插槽是否仍在（appearance 线依赖）。
3. `webserver/index-inject` 首帧注入是否仍在（appearance 线首帧防闪色依赖）。
4. `conversation.session.header.actions` / `conversation.view` 是否仍在（canvas / ssh 线依赖）。
5. 官方 SSH 是否提供 **UI 入口**，还是纯能力提供方。
6. 官方侧边栏终端是否**可被插件复用/扩展**（决定我们是让位还是接线）。
7. `dual-model` 的图片准入补丁在 0.1.6 下的实际状态。

> 验证方法沿用 `dsh-0.1.5-rc1-slot-contract-2026-09-10.md` 的隔离实例 + 无头浏览器路线。

---

## 附：本次核实方法

- GitHub REST API（只读）：仓库元数据、`releases`、`commits`、`contents?ref=<tag>` 逐目录列举。
- npm registry：`/-/package/@deepseek-ai/dsh/dist-tags`。
- 本地：`git -C vendor/deepseek-harness log/status`、`_refs/deepseek-harness/package.json`、读 `package.json` 的 dsh-deps 表。
- **未执行**任何写入 / 安装 / 升级；本仓文件零改动（本文档为本次唯一新增）。
