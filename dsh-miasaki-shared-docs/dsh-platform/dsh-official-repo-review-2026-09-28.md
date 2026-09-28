# 官方仓库复查（增量）：0.2.0-rc.1 首发与 0.2 系列开启

- 日期：2026-09-28
- 调研者：总指挥（Miasaki 会话）+ 只读子代理（commit 级取证）
- 上一份同类：[`dsh-official-repo-review-2026-09-25.md`](dsh-official-repo-review-2026-09-25.md)（09-25，0.1.7-rc.2）
- **配套（同日实测）**：[`dsh-0.2.0-rc1-upgrade-assessment-2026-09-28.md`](dsh-0.2.0-rc1-upgrade-assessment-2026-09-28.md)
  —— 本文回答「官方仓库这两天变了什么、影响哪几条线」，该文回答「**升到 0.2.0-rc.1 要花多大力气**」
  （10 个补丁在 0.2.0-rc.1 真实产物上逐个跑 `apply` 的实测结果）。
- 口径：`[实测]` = 本次拉 GitHub/npm API、下载真实产物或本地跑命令核到；`[推断]` = 基于证据的判断，未做隔离实例实测
- 取证链说明：§1–§3 由本会话直接核到；§4–§7 的 commit 级细节由只读子代理经 GitHub contents/compare API 与
  `.atom` 提交流取证（该子代理**未改动工作区任何文件**）。`raw.githubusercontent.com` 在本网络不可达
  （代理侧 522），子代理改用 `ghproxy.net` 服务端转发取正文。

---

## 0. 摘要

1. **★★★ 0.2 系列开启**：npm `next` 轨首次出现 **`0.2.0-rc.1`**（发布 `2026-09-28T12:36:21Z`，北京时间 20:36），
   官方 Release tag `dsh-v0.2.0-rc.1`，prerelease；**`latest` 仍是 `0.1.7-rc.2`**（= 本机运行版本）。
   次版本号跃迁（0.1.7 → 0.2.0），区间 **261 个 commit**。§1–§3。
2. **★★★ 官方没有升级迁移文档**：根目录 60 项无 `CHANGELOG.md`，`docs/` 74 项无
   migration / breaking-changes / upgrading 类文件；`docs/persistence-changes/releases/` 的快照索引
   **截至 2026-09-12、最新只到 `dsh-v0.1.5-rc.2`**，不含 0.1.7 / 0.2.0。
   ⇒「升级要改什么」只能靠 release note + commit 考古，本仓的复查/评估文档惯例因此更有必要。§7。
3. **★★ Session 日志格式未变（仍 V4）**：两个 tag 的 `docs/session-format-status.zh.md` **逐字一致**
   （`latestFinalizedVersion: 4` / `latestReleasedVersion: 3`）。**升级不会作废 0.1.7-rc.2 建的会话**
   —— 与 0.1.5→0.1.7 那次 V3→V4 不可降级形成鲜明对比。§6.1。
4. **★★ 一条真破坏性变更：Schedule 转为默认关闭的 opt-in bundle**。新包
   `@deepseek-ai/dsh-experimental-schedule-bundle` 把 `time-context` / `schedule` / `ui-schedule`
   三行打开；同时「Web 默认启用 Schedule」的旧决策笔记在本窗口内**从 `implemented/` 迁入 `archived/`**（撤销）。
   依赖自动化任务/提醒的部署必须显式启用。§6.2。
5. **★★ 新增上报路径**：窗口内加入 **OTLP 会话日志上传**与新设置项；`packages/bundle/web-app/cordis.patch.yml`
   新增 `desktop-product-telemetry` 与 `product-analytics` 两行，启用条件为
   **`profileContext?.name === 'desktop'`** —— 本机 miasaki 桌面端会话正跑在 `desktop` profile 下。§6.3。
6. **★ 第三方插件的 `<0.2.0` 定时炸弹仍在**：本仓 09-25 已把自家 3 个插件上界放宽到 `<0.3.0`，
   但 **`@openviking/dsh-memory-plugin` 与 `@yeesy369/dsh-tool-browser` 仍钉 `<0.2.0`** ——
   `0.2.0-rc.1`（预发布）尚能通过，**0.2.0 正式版一到即被 peer 闸门拒载**。§5.2。
7. **自制插件 peer 全 PASS**：复刻官方闸门逻辑扫描工作区 + 本机 7 个 profile，自制 10 件在
   `0.1.7-rc.2` / `0.2.0-rc.1` / `0.2.0` 三档**全部放行**；09-25 那轮拆弹（`^0.1.2-rc.1` → `>=0.1.2-rc.1 <0.3.0`）确认有效。§5.1。

---

## 1. 仓库动态 `[实测]`

| 项 | 值（2026-09-28） | 相对 09-25 |
|---|---|---|
| 仓库 | `deepseek-ai/deepseek-harness`（MIT / TypeScript / 默认分支 `master`） | 未变 |
| 最新 Release | **`dsh-v0.2.0-rc.1`**，published `2026-09-28T12:36:21Z`，prerelease，release id `398234978` | `0.1.7-rc.2` → `0.2.0-rc.1` |
| master HEAD | `4878cda` = `release(dsh): 0.2.0-rc.1 (#5387)`（`2026-09-28T11:48:10Z`） | 09-25 停在 rc.2 release merge |
| npm dist-tags | `latest = 0.1.7-rc.2`；**`next = 0.2.0-rc.1`**；`alpha = 0.1.7-alpha.2` | **`next` 由 `0.1.7-rc.2` → `0.2.0-rc.1`** ★ |
| 本机运行版本 | `0.1.7-rc.2`（全局 npm `%APPDATA%\npm\node_modules\@deepseek-ai\dsh`，`package.json` 实测） | 未变 |
| 官方桌面端 | `F:\sud\dsh-desk` = **`0.1.7-rc.2`**（`resources/runtime/primary-runtime/runtime.json`、注册表 `DeepSeek Harness 0.1.7-rc.2`）；更新源 `download.deepseek.com/dsh-desk/feeds/win-x64/`，**通道 `nightly`，无 `latest.yml`（404）** | 未跟随 |

> **发布节奏**：09-23 `rc.1` → 09-24 `rc.2` → 09-28 **`0.2.0-rc.1`**。
> 0.1.7 系列到 rc.2 后直接换次版本号，说明官方把这一批（261 commit）整体定性为 0.2 代的开端。
> `latest` 未跟随，新装环境走 `latest` 仍会装到 0.1.7-rc.2。

> **通道盲区提示**：官方桌面端 `nightly` feed 的 `nightly.yml` 存在（HTTP 200，`application/yaml`），
> 但 `latest.yml` 是 404 —— 桌面端与 npm 的版本推进**不同步**，不能以 npm 的 `next` 推断桌面端是否已更新。

---

## 2. 区间规模 `[实测]`

compare API：`deepseek-ai:477b4f4...deepseek-ai:4878cda`

| 项 | 值 |
|---|---|
| `total_commits` | **261** |
| `status` / `ahead_by` / `behind_by` | `ahead` / 261 / 0 |
| base | `477b4f4` = tag `dsh-v0.1.7-rc.2`（"Merge pull request #5180 … release(dsh): 0.1.7-rc.2"，`2026-09-24T13:39:59Z`） |
| head | `4878cda` = `release(dsh): 0.2.0-rc.1 (#5387)`（`2026-09-28T11:48:10Z`） |

证据：[compare API](https://api.github.com/repos/deepseek-ai/deepseek-harness/compare/dsh-v0.1.7-rc.2...dsh-v0.2.0-rc.1)

> **取证边界**：该响应 >110 KB 被工具截断，`files` 数组只解析出 35 条（按字母序，全部落在
> `.agents/notes/**`），**增删行统计与完整改动文件清单不可得**；261 条提交亦未全量拉取
> （分页每页都重复携带 `files` 数组，单页即超限）。§8 列出全部未取到项。

---

## 3. 官方 release note 要点 `[实测]`

官方把 261 个 commit 收敛为 20 条（中文正文，见 [Release 页](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1)）：

### 3.1 体验优化（10）

- 对话进行中/完成状态的实时动画、用时信息、过程信息间距
- **会话在图片失效后自动重传并继续请求的可靠性** ← 与 dual-model 图片准入补丁同域
- 桌面更新提示补全版本、下载与重试说明
- 无标题历史会话统一显示「未命名」，重命名提供空白输入
- 插件管理界面、内置插件界面布局与交互、安装引导
- 深色主题开关色彩区分度；Office / PDF 预览文字选区在明暗主题下的清晰度
- 插件配置保存操作的等待时间
- 创造模式完善插件开发指引并提供体验技能
- **使用 DeepSeek 账号模型的会话无需额外 API Key 即可网页搜索**

### 3.2 问题修复（7）

- **Windows 内置沙箱新增权限诊断技能**：定位访问被拒原因，并在限定目录内做带备份、可恢复的权限修复
- **修复工具调度异常后对话无法继续**；结果未知的操作会提示先核实副作用、不盲目重试
- 桌面端弹窗/菜单/浮动面板避让标题栏（小窗口与全屏切换）
- Windows「在文件资源管理器中打开」/定位文件不再弹隐藏窗口、不再无响应
- macOS 录音权限影响麦克风授权；Safari 流式输出中刷新无法恢复回复；部分 Linux 缺原生预构建包时 npm 安装失败

### 3.3 其他变更（2）

- **自动化任务改由可选插件包提供**（详见 §6.2 —— 这条是本次唯一的真破坏性变更）
- 调整工作过程展示在不同初始化路径的默认值

> **与 `.agents/notes/` 的对应**：官方用 Agent Note 制度记录设计决策，本窗口内可见的新增/更新包括
> `2026-09-19-failed-step-tool-results`（失败步骤补齐工具结果，**明确"无格式变更"**）、
> `2026-09-27-pwsh-prompt-tail-grace`（`dsh-terminal-bash` 新增 `promptTailGraceMs`，默认 `0`，
> **零值精确复现旧上界 ⇒ 升级不改变任何部署行为**，专门针对 Windows 自托管 lane 的提示符尾部分块问题）、
> 以及 `2026-07-10-parallel-tool-call-execution` 的语义更新（abort 现在为未派发调用记录合成 aborted 对）。

---

## 4. 结构层变化 `[实测]`

### 4.1 包目录

| 项 | `dsh-v0.1.7-rc.2` | `dsh-v0.2.0-rc.1` | 差 |
|---|---|---|---|
| `packages/` 下包目录数 | **54** | **55** | +1 |
| 新增 | — | **`packages/telemetry/`**（其下 `packages/telemetry/otel/`） | ★ |
| 移除 | — | **无** | — |
| 子包级新增 | — | `packages/experimental/schedule-bundle/` | ★ |

证据：[0.2.0 packages](https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages?ref=dsh-v0.2.0-rc.1)、
[0.1.7 packages](https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages?ref=dsh-v0.1.7-rc.2)

### 4.2 npm 依赖层（本会话直接核对）

对本机实装 `0.1.7-rc.2` 的 `package.json`（`dependencies` 81 项 / `devDependencies` 47 项）
与 registry 上 `0.2.0-rc.1` 的清单做对照，**真正新增的依赖包只有
`@deepseek-ai/dsh-experimental-schedule-bundle`** —— 正好对应 §3.3 第一条。

其余曾疑似新增的包（`dsh-time-context`、`dsh-skill-office`、`dsh-tool-subagent-control`、
`dsh-agent-tool-presentation`、`dsh-client-ui-agent-preset`、`dsh-experimental-voice-input-bundle`、
`dsh-session-projection`、`dsh-tmux-context`）在 `0.1.7-rc.2` 中**已在位**，不是新增；
`dsh-experimental-ptc-runtime-python` 在 rc.2 已位于 `devDependencies`，亦非新增。

> 方法注记：本次为**单向候选核对**（对可疑包逐个判存在性），未做全量 81×81 依赖 diff —— 见 §8。

---

## 5. 与本仓的关联 `[实测]`

### 5.1 官方 peer 兼容性硬闸门：自制插件三档全 PASS

复刻官方判定（`semver.satisfies(本体版本, range, { includePrerelease: true })`，仅检查
`peerDependencies` 中以 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 开头的条目），
扫描工作区各线源码 + 本机 7 个 profile（`desktop` / `miasaki` / `web` / `cu-test` / `m3-test` /
`rc7-test` / `open-design`），排除官方自家包（`@deepseek-ai/*` 随本体同步发版，其内部 peer 不构成风险）：

| 插件 | 0.1.7-rc.2 | 0.2.0-rc.1 | 0.2.0（正式版） |
|---|---|---|---|
| `@miasaki/dsh-computer-use`（4 条 peer） | PASS | PASS | **PASS** |
| `@miasaki/dsh-free-model`（2 条） | PASS | PASS | **PASS** |
| `dsh-free-model-pool`（2 条） | PASS | PASS | **PASS** |
| `dsh-model-probe`（2 条） | PASS | PASS | **PASS** |
| `dsh-pet-panel`（1 条） | PASS | PASS | **PASS** |
| 八线主插件（canvas/sidebar/ssh/dual-model/appearance/usage） | — | — | — |
| `@openviking/dsh-memory-plugin@0.5.8` | PASS | PASS | **★ 拒载** |
| `@yeesy369/dsh-tool-browser@0.7.0` | PASS | PASS | **★ 拒载** |
| `@open-design/dsh-runtime@0.1.0` | 拒载 | 拒载 | 拒载 |

**判读：**

1. 09-25 那轮「三个插件 `^0.1.2-rc.1` → `>=0.1.2-rc.1 <0.3.0`」的拆弹**确认有效** —— 三档全过。
2. **八线主插件（canvas / sidebar / ssh / dual-model / appearance / usage）未声明任何
   `@deepseek-ai/dsh*` peer**，按官方规则「未声明即不施加版本约束」，天然不进闸门（表中以 `—` 表示）。
3. 两个**第三方**插件的上界仍是 `>=… <0.2.0`（openviking 的三条是
   `>=0.1.0-rc.6 <0.2.0 || ^0.1.5-rc.1 || ^0.1.7-rc.2`，三项上界同为 `<0.2.0`）。
   两者在 `0.2.0-rc.1` 下**因 `0.2.0-rc.1 < 0.2.0` 成立而侥幸通过**，但 **`0.2.0` 正式版一到即全部拒载**。
   二者都在 `miasaki` profile 的 bundle 列表里（`~\.dsh\profiles\miasaki\package.json`）。
4. `@open-design/dsh-runtime` 精确钉死 `0.1.0-rc.6`，**当前就已拒载** —— 属历史实验 profile，不构成新增风险。

### 5.2 十个补丁的基线全部是 `0.1.7-rc.2` `[实测]`

| 线 | 补丁 | target 包 | 目标文件 |
|---|---|---|---|
| desktop | `dsh-client-ui-attachment` | `@deepseek-ai/dsh-client-ui-attachment` | `lib/client.js` |
| desktop | `dsh-client-ui-brand-official` | `@deepseek-ai/dsh-client-ui-brand-official` | `lib/client.js` |
| desktop | `dsh-client-ui-chat` | `@deepseek-ai/dsh-client-ui-chat` | `lib/client.js` |
| desktop | `dsh-client-ui-conversation` | `@deepseek-ai/dsh-client-ui-conversation` | `lib/client.js` |
| desktop | `dsh-client-ui-settings-models` | `@deepseek-ai/dsh-client-ui-settings-models` | `lib/client.js` |
| desktop | `dsh-client-ui-sidebar` | `@deepseek-ai/dsh-client-ui-sidebar` | `lib/client.js` |
| desktop | `dsh-client-ui-trajectory` | `@deepseek-ai/dsh-client-ui-trajectory` | `lib/client.js` |
| desktop | `dsh-cordis-host-runner` | `@deepseek-ai/dsh-cordis-host-runner` | `lib/index.js` |
| dual-model | `dsh-api-session-controller` | `@deepseek-ai/dsh-api-session-controller` | `lib/index.js` |
| shared-docs | `dsh-browser-playwright`（双半） | `@yeesy369/dsh-browser-playwright` | 见该补丁 `LIVE_TARGETS` |

`BASELINE_DSH_VERSION` 逐件核对均为 `'0.1.7-rc.2'`（`patch.mjs` 常量）。**升级必须重打全部十件**；
逐件在 0.2.0-rc.1 真实产物上的锚点命中结果见配套评估文档。

### 5.3 两条与本仓具体产品线的勾连

- **appearance 线**：本窗口新增主题别名 **`--dsw-alias-switch-thumb`**（09-28，暗色开关态，属向后兼容新增）。
  若皮肤 token 表或开关样式自行覆写，可对齐该 token。官方 `docs/web-styling.zh.md` 既有硬规则仍适用
  （功能包只用 `--dsw-alias-*`；菜单必须用 `Menu` / `MenuSurface`；中性边框一律 0.5px 且不得与
  elevation token 混用；正圆须配 `corner-shape: round`）。
- **desktop 线**：窗口内一批 Windows 标题栏/浮层间隙修复（`447471d3`、`1aea67a7`、`ce6af05c`、`3adf5612`）
  → 直接影响自制桌面壳的浮层定位。本线 2026-09-28 刚落地的
  [`sidebar 头部 tooltip portal 化补丁`](../../dsh-miasaki-desktop/design/2026-09-28-sidebar-tooltip-portal.md)
  升级后应优先实机走查。

---

## 6. 破坏性 / 需迁移项 `[实测]`

### 6.1 Session 日志格式：**未变，无需迁移** ★★★

两个 tag 的 `docs/session-format-status.zh.md` 逐字一致：

```
latestFinalizedVersion: 4
latestReleasedVersion: 3
evidenceTag: dsh-v0.1.5-alpha.1
```

窗口内**没有推进会话格式版本**。证据：
[0.2.0 侧](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/docs/session-format-status.zh.md) vs
[0.1.7-rc.2 侧](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/docs/session-format-status.zh.md)。

⇒ 本次升级**不存在** 0.1.5→0.1.7 那种「升级后旧会话不可降级读取」的风险。
（另注：`2026-09-19-failed-step-tool-results` 决策明确写「日志使用已有事件类型与恢复代码，**无格式变更**」。）

### 6.2 Schedule 改为默认关闭的 opt-in bundle ★★（最需要行动）

- 新包 `@deepseek-ai/dsh-experimental-schedule-bundle`：`0.2.0-rc.1` 存在、`0.1.7-rc.2` **404**。
- 提交原文："The shipped Web composition carries `time-context`, `schedule`, and `ui-schedule` disabled."
  该 bundle 负责把这三行打开。
- 同时 `.agents/notes/implemented/architecture/2026-09-24-web-default-schedule-composition.*`
  在本窗口内**从 `implemented/` 迁入 `archived/`** —— 即「Web profile 默认启用 Schedule」的旧决策被撤销
  （旧笔记当时明确写"web profile 默认启用"）。

证据：[commit 41c29fa](https://github.com/deepseek-ai/deepseek-harness/commit/41c29fa8326818acdc4dab617995ec50ecd42199)、
[新包 package.json](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/packages/experimental/schedule-bundle/package.json)、
[0.1.7-rc.2 时的旧笔记](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/.agents/notes/implemented/architecture/2026-09-24-web-default-schedule-composition.md)

⇒ **行动**：升级后若需保留「自动化任务页 / 会话提醒 / `schedule_*` 工具」，须显式启用该 bundle
（或在自己的 profile patch 里打开三行）。
置信度：提交信息 + 包存在性已证；**三行 `disabled` 的具体落点（base patch 还是 web patch）未逐行核对**。

### 6.3 新增上报路径 ★★

窗口内加入 OTLP 会话日志上传与新设置项：

- `feat(telemetry): upload session log events through byte-bounded OTLP`
- `refactor(telemetry): share reporting through a Cordis OTel service`
- `feat(web): add Session Log upload preference in General settings (#5337)`

[`packages/bundle/web-app/cordis.patch.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/packages/bundle/web-app/cordis.patch.yml)
新增两行：`desktop-product-telemetry`（`@deepseek-ai/dsh-host-product-telemetry-otel`）与 `product-analytics`，
启用条件均为 `disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"` —— **仅 desktop profile 启用**。

⇒ **与本机直接相关**：miasaki 桌面端会话运行在 `DSH_PROFILE=desktop` 下，即**落在启用范围内**。
该偏好的**默认值与是否 opt-in 未核实**，升级后应先在 General 设置里确认再决定。

### 6.4 首启弹窗重新确认（用户可见，必做一次）★

- `WELCOME_NOTICE_VERSION`：`2026-08-13.1` → **`2026-09-28.1`**
- 文案从「内测声明（0.1，面向 Harness 开发者测试）」改为「**预览版说明**（0.2 仍处预览阶段；
  新的桌面端开箱即用，进阶功能仍可在开发者模式中使用）」
- 确认值写在设置命名空间 `ui-settings-general.welcomeNoticeVersion`；
  包 README 明确「已确认旧版的用户会**再次**看到当前说明」

证据：[版本号提交](https://github.com/deepseek-ai/deepseek-harness/commit/441939eaa4d524f12f10b0fde5e179ad5e21e9f9)、
[文案提交](https://github.com/deepseek-ai/deepseek-harness/commit/cd57af492510ad70602b14b950d68df9c318c4c1)

---

## 7. 插件契约面逐项核对 `[实测]`

| 契约面 | 结论 | 证据 |
|---|---|---|
| Session 日志格式 | **未变**（V4 保持） | §6.1，两 tag 文件逐字一致 |
| 插件开发契约 `packages/AGENTS.md` | **本窗口未改**（该路径最后一次修改 2026-09-05，窗口外） | [提交流](https://github.com/deepseek-ai/deepseek-harness/commits/dsh-v0.2.0-rc.1/packages/AGENTS.md.atom) |
| client slot 目录（`slot-catalog.ts`） | **无删除、无改名**；仅 2 笔提交触及（`7ded036` Session Log 偏好、`5d72bfb` 插件刷新反馈/图标） | [提交流](https://github.com/deepseek-ai/deepseek-harness/commits/dsh-v0.2.0-rc.1/packages/extensions/cordis-client-runner/src/client/slot-catalog.ts.atom) |
| settings | **无 schema 迁移**；窗口内仅两笔 `perf(settings)`（09-28）。实际变化是新**值**：`welcomeNoticeVersion` 语义更新 + 新增 Session Log 上传偏好 | [提交流](https://github.com/deepseek-ai/deepseek-harness/commits/dsh-v0.2.0-rc.1/packages/settings.atom) |
| `ctx.*` 服务 | 新增 `packages/telemetry/otel`（Cordis OTel 服务，desktop profile 由 `@deepseek-ai/dsh-host-product-telemetry-otel` 提供）；`docs/capability-seams.zh.md`（61 KB 服务总表）**未逐字 diff**，仅以路径提交轨迹判断窗口内只有 telemetry 相关触及 | [telemetry 目录](https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/telemetry?ref=dsh-v0.2.0-rc.1) |
| Web 样式契约 | **向后兼容新增** `--dsw-alias-switch-thumb`；`docs/web-styling.zh.md` 硬规则仍适用 | [web-styling 文档](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/docs/web-styling.zh.md) |

**当前官方插件契约基线（窗口未变，供本仓对齐）**：服务包 default-export 服务类；函数插件
named-export `name` / `inject` / `Config` / `apply` 且**不得有 default export**；可选服务用 `ctx.get(name)`，
`ctx.<name>` 只留给声明式 `inject`；只有包拥有分歧观测时才发布 `./invariant`。

### 7.1 官方**没有**升级迁移文档

- 根目录 60 项中**无 `CHANGELOG.md`**；`docs/` 74 项中**无** migration / breaking-changes / upgrading 类文件。
  证据：[根目录](https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/?ref=dsh-v0.2.0-rc.1)、
  [docs 目录](https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/docs?ref=dsh-v0.2.0-rc.1)
- 最接近的三处都**不是**升级指南：
  1. `docs/session-format-status.zh.md` —— Session 格式版本单一真源（§6.1 已用）；
  2. `docs/persistence-changes/README.zh.md`（持久化兼容性规则表 same-version / version-bump）与
     [releases/README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/docs/persistence-changes/releases/README.zh.md)
     （26 个 alpha/RC 历史快照索引，**捕获范围截至 2026-09-12、最新只到 `dsh-v0.1.5-rc.2`**，不含 0.1.7 / 0.2.0）；
  3. `docs/rescope.zh.md`（vendor 包改名 `cordis` → `@deepseek-ai/cordis`），属 2026-08-10 归档决策，**不在本窗口**。
- 面向用户的"迁移提示"实际是产品内的 **0.2 预览版说明弹窗**（§6.4）。

---

## 8. 未取到 / 未证项（不假装拿到）

1. compare 的**完整 `files` 清单与增删行统计**（响应 >110 KB 被截断，仅解析出 35 条，全在 `.agents/notes/**`）。
2. **261 条提交的全量列表**（分页每页重复携带 `files`，单页即超限）。
3. `docs/capability-seams.zh.md`（61 KB 服务总表）的**逐字 diff** —— 仅以路径提交轨迹推断。
4. `docs/cordis-api/`（无 README）逐文件对比。
5. **Session Log 上传偏好的默认值与是否 opt-in**。
6. §6.2 三行 `disabled` 的**具体落点**（base patch / web patch 未逐行核对）。
7. 本会话的依赖对比是**单向候选核对**，未做 `0.1.7-rc.2` × `0.2.0-rc.1` 的全量依赖 diff。

---

## 9. 结语与下一步

1. **不必急于升级**：`latest` 仍是 `0.1.7-rc.2`，官方自身仍在 RC 阶段；桌面端 nightly 也未跟随。
2. **升级窗口的判断依据已齐**：Session 格式未变（低风险）＋ 契约面零改动 ＋ Schedule 转 opt-in（需显式启用）
   ＋ 新增 desktop profile 上报路径（需确认偏好）。
3. **升级成本**见配套 [`dsh-0.2.0-rc1-upgrade-assessment-2026-09-28.md`](dsh-0.2.0-rc1-upgrade-assessment-2026-09-28.md)：
   10 个补丁在 0.2.0-rc.1 真实产物上的逐个 `apply` 实测结果。
4. **与升级无关但建议先做**：处理两个第三方插件的 `<0.2.0` 上界（§5.1 第 3 点），
   否则 0.2.0 正式版转正那天会以「插件被拒载」的形式突然暴露。
