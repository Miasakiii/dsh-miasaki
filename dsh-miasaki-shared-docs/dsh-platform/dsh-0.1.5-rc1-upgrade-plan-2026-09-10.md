# DSH 0.1.5-rc.1 升级方案（影响分析 + 执行手册）

- 日期：2026-09-10
- 起点：`@deepseek-ai/dsh@0.1.2-rc.1`（全局 npm 安装）
- 目标：`@deepseek-ai/dsh@0.1.5-rc.1`
- 性质：影响分析 + 执行手册；**升级已于 2026-09-10 执行**，进度见下方状态表
- 配套文档：slot 契约与实测 `dsh-0.1.5-rc1-slot-contract-2026-09-10.md`；sidebar 线迁移 `../../dsh-miasaki-sidebar/design/2026-09-10-migrate-to-official-rightbar.md`

---

## 执行状态（2026-09-10 复核）

| 阶段 | 状态 | 说明 |
|---|---|---|
| 0 备份 + 记录基线 | ✅ 完成 | `~/.dsh-backup-0.1.2-rc.1-20260910` 已存在 |
| 1 安装 0.1.5-rc.1 | ✅ 完成 | `dsh --version` → `0.1.5-rc.1`；`settings.yaml` 的 `agent-default-model` 已指向 `deepseek-flash` |
| 2 验证基础可用 | ✅ 完成 | web 实例正常；profile 的三个 `link:` 插件（canvas / sidebar / ssh）junction 全部有效；新会话按 `session.v3.jsonl.zstd` 写入 |
| 3 适配 persona | ⚠️ **代码就绪，待执行脚本** | 三个 preset 因 `text` → `prefix` 失效（§2 的预测命中）；`preset-sources/` 已改为模板生成并干跑验证 12×3 项全通过，**需在真实 `~/.dsh` 上跑一次 `apply-presets.ps1` 才算完成** |
| 4 重打设置页补丁 | ✅ 完成 | 7 个锚点在新版中**全部唯一命中**，`insertAfterOffset` 期望值检查也通过 ⇒ **未改动任何 `EDITS`**；只换了两份 baseline 并更新三个常量。`verify` PASS、`apply` 成功（144,576 B / `E602C1F1…`，备份 `client.js.dsh-bak` 重建）、`verify-all.mjs desktop` **4/4**。另新增 `rebuild-baseline.mjs` 供下次升级一步重建基线 |
| 5 sidebar 迁移到官方右栏 | ✅ 完成（阶段 1） | 自研壳停用：删 Toggle entry 整段 79 行（含**两处自研开关按钮**）+ 尾部 70 行（`shell.overlay` 注册与推挤/watchdog 生命周期）；新增 `RIGHT_BAR_TABS` 两阶段注册，正文经 `props.useTabInfo()` 取 `tab.id`/`tab.visible`。判定：`shell.overlay` / `sidebar-toggle` / `syncTitlebarButton` **清零**，`sidebar.right.pane.tab` 就位，`node --check` 过，44 项单测 + `verify-all sidebar` **8/8** 全绿。**阶段 2 待办**：未调用的壳死代码与壳 CSS 待清理，`drawer-gesture` 与 `client-tabs` 的持久化测试随之退役。**待实机验证**（client bundle 需重启 DSH host 生效） |
| 6 实机验证 host 端插件 | ❌ 未做 | canvas 会话布 / ssh 终端 / token-monitor 用量统计 |

---

## 0. 摘要

**Web 插件代码零必改** —— 已在 0.1.5-rc.1 隔离实例上实测：三条线的全部 slot 注册名（`conversation.session.header.actions`、`conversation.view`、`conversation.session.header.utilities`、`shell.overlay`、`sidebar.footer.action`、`settings.section`）与 `ctx.slots.inject(key, cb)` 签名均未变；推挤机制实测有效；`label` thunk 合法。

**真实工作量集中在四处**，且都不在 web 插件层：

| # | 项目 | 归属 | 风险 |
|---|---|---|---|
| 1 | persona 前后缀拆分 → `apply-presets.ps1` 锚点失配 | desktop | 中（脚本会 `throw`，但可修复） |
| 2 | `patches/dsh-client-ui-settings-models` 需重打 | desktop | **高**（目标包在 0.1.5 被改过，锚点大概率漂移） |
| 3 | 会话数据 V3 迁移 | 全局 | **不可逆**（升级后新会话无法被 0.1.2 读取） |
| 4 | sidebar 线迁移到官方右栏（用户已拍板） | sidebar | 中（纯客户端壳层重写，host 半不动） |

**执行前置**：升级会**中断当前运行中的会话**，且需要写工作区外的路径 —— 详见 §5、§6。

---

## 1. Web 插件线（canvas / sidebar / ssh / desktop 的四个 web 插件）

**结论：无需为 slot 契约改动任何代码。**

已实测确认（0.1.5-rc.1 隔离实例 + 无头浏览器）：

| 注册点 | 位置 | 0.1.5 状态 |
|---|---|---|
| `conversation.session.header.actions` | `dsh-miasaki-canvas/client.js:77`、`dsh-miasaki-sidebar/client.js:504` | 未变（list / session） |
| `conversation.view` | `dsh-miasaki-ssh/client.js:36`、`dsh-token-monitor/lib/client.js:1155` | 未变（list / session） |
| `conversation.session.header.utilities` | `dsh-session-log-move/lib/client.js:99` | 未变（list / session） |
| `shell.overlay` | `dsh-miasaki-sidebar/client.js:1278`、`dsh-token-monitor/lib/client.js:1165` | 未变（list / root） |
| `sidebar.footer.action` | `dsh-token-monitor/lib/client.js:1161` | 未变（list / root） |
| `settings.section` | `dsh-pet-panel/lib/client.js:184`、`dsh-free-model-pool/lib/client.js:207` | 未变（list / root） |

`label` 三种写法（字符串 / thunk / 缺省）都被接受；`SlotLabel = string | (() => string)`，ssh 线的 `label: () => 'SSH'` 属官方设计用法。

**唯一已做的改动**（2026-09-10，本方案之前）：`dsh-miasaki-sidebar/client.js` 的 `FRAME_ANCHOR_SELECTOR` 补为 `'[data-slot="main"], [data-slot="conversation"]'`，兼容两版。44 项测试全绿。

---

## 2. persona 配置拆分（desktop 线）

### 2.1 现状

`~/.dsh/.agent-presets/<id>/agent.cordis.yml` 里：

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      <注入的 persona 内容>
```

三个 preset：`whale` / `kurumi` / `inverse`。注入由 `dsh-miasaki-desktop/preset-sources/apply-presets.ps1` 完成，方式是**锚点文本替换**：

```powershell
$oldText = "text: >-`n      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}."
if (-not $t.Contains($oldText)) { throw "persona anchor not found in $agent" }
```

### 2.2 0.1.5 的变化

release note：**「自定义 persona 配置拆分为前缀和后缀，旧配置及相关常量需要适配。」**

### 2.3 影响

- 升级后 DSH 的**预设底座**（shipped preset 的 `agent.cordis.yml`）会更新为前后缀结构；
- 用户侧三个 preset 目录是**旧底座 + 已注入 persona**，`$oldText` 这个 0.1.2 模板文本在新底座里**大概率不存在** → `apply-presets.ps1` 会直接 `throw`（这是设计好的失败姿态，不会静默改错）；
- `config.text` 这个字段名本身是否保留，取决于 `dsh-persona` 插件的新 schema，**需升级后实际查看**。

### 2.4 处理步骤（升级后）

1. 备份三个 preset 目录（见 §6）；
2. 查看 0.1.5 的预设底座（`dsh-miasaki-desktop/preset-sources/apply-presets.ps1` 注释里提到的"standard diff"做法）：对比新旧 `agent.cordis.yml` 的 persona 行；
3. 按新 schema 改写 `apply-presets.ps1` 的 `$oldText` / `$newText` 生成逻辑；
4. 重跑脚本，用 `agent.cordis.yml` 的 diff 自证；
5. 若 0.1.5 的底座结构变化较大，考虑改为"整段替换 persona 行"而非"文本锚点替换"，降低对底座措辞的耦合。

> 待确认：`config.text` 是否被 `prefix`/`suffix` 取代，还是保留 `text` 并新增字段。这决定脚本的改法。

---

## 3. 设置页补丁重打（desktop 线）

### 3.1 现状（已核实）

- 唯一补丁包：`dsh-miasaki-desktop/patches/dsh-client-ui-settings-models`
- 内容：7 条锚点编辑（5 处插入 + 2 处字典替换），给官方设置页增量加入**逐模型思考强度下拉**与**测试连通性**按钮
- 安装目标（`patch.mjs status` 实测输出）：
  `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-ui-settings-models\lib\client.js`
  —— 注意它嵌在 **dsh 包自己的 `node_modules`** 里
- 当前状态：**`patched`**，SHA-256 `18D114AC19CC2C9E…`（与 `baseline/client.patched.js` 一致）
- 备份：同目录 `client.js.dsh-bak`

### 3.2 风险：高

**升级会覆盖整个 dsh 包（含其 `node_modules`）**，补丁产物与 `.dsh-bak` 一并消失 —— 这正是补丁 README 第 15 行预警的情形。

更关键的是**锚点漂移的概率很高**：0.1.5 的 release note 明确提到该包所在领域的两处改动：

- 「修复模型目录变化后失效的 pi-ai 配置导致整个模型设置入口消失的问题；错误项保留诊断和修复入口」
- 「在发现模型或创建自定义 provider 前校验并规范化 Base URL，并直接提示无效地址」

而补丁第 3 条 `testModel()` 恰恰**复用 `operations.discoverModels`，按当前行 provider/baseURL/api/apiKey 探测** —— 与上述改动直接相邻。另 0.1.5 还增强了模型探测（支持自定义 provider 的 `models` 对象、Anthropic 原生模型列表、回填模型名/上下文窗口/最大输出 token），`discoverModels` 的行为与返回形状可能变化。

### 3.3 重打流程（补丁 README 已定义，照做）

```powershell
cd dsh-miasaki-desktop/patches/dsh-client-ui-settings-models

node patch.mjs status    # 期望显示 unknown（新版安装，补丁被覆盖）
# 用 baseline/client.original.js（0.1.2 原版）↔ 新版 client.js 做 diff，核对 7 个锚点
# 锚点漂移 → 更新 EDITS 与两份 baseline（新版 original + 重打后的 patched）
node patch.mjs verify    # 离线自证：original → 重建 → 与 patched 逐字节比对
node patch.mjs apply     # 备份 + 应用
```

**决策点**：若锚点漂移严重（例如 `discoverModels` 的调用形状变了），需要重写补丁第 3 条。届时可考虑是否仍值得维护这个补丁，或改用其它手段（该补丁是"不修改 DSH 本体"原则的唯一例外）。

---

## 4. 会话数据：V3 格式迁移（不可逆项）

### 4.1 现状

`~/.dsh/sessions/`：**111 个 `.zstd` 文件 / 134.5 MB / 7 个会话目录**。

### 4.2 迁移语义（据官方 `session-format-v2-to-v3/README.zh.md`）

- 迁移是**恢复（restore）**语义：把受支持的已发布 V2 会话恢复为 V3，"保留历史请求含义"；
- 持久化层负责"读取准备和**不可变后继代**的发布"——即**生成新代次文件**，而非就地改写；
- **拒绝时"持久化保留源字节且不发布后继代"**；
- 转换内容：`version: 2` → `version: 3`、插入系统头节点消息、重映射本地事件引用、PTC 词汇（`tools-code-mode` → `tools-ptc`）、规范化信封、`agentPreset.code: 'code'` → `'ptc'`；
- **不迁移文件或设置**，不修改 `settings.yaml`；
- 已标记为 V3 的输入不再跑这条迁移。

### 4.3 不可逆性（准确表述）

- release note 原文：**「升级后的会话不支持降级读取」**；
- 具体含义：**升级后新产生的会话是原生 V3，0.1.2 读不了**；
- 历史会话的源文件按设计保留，但"回滚 DSH 版本后目录层是否仍会读取被迁移的旧代次"**未经实测** —— 因此**不应把回滚当作可靠的数据恢复手段**；
- 磁盘影响：源字节保留 + 新代次 → **占用净增**。

### 4.4 处理建议

升级前完整备份 `~/.dsh/sessions/`（134.5 MB，成本可接受），这是唯一可靠的回退保障。

---

## 5. host 插件 API 变更（影响：低，升级后验证）

| 变更（release note） | 对本仓的影响 |
|---|---|
| Session 持久化 API 改为生命周期持有的 `SessionHandle`；`agentLoop.create()` 变异步；新增 session 锁 | 本仓插件未直接调用这些 API。canvas host 端用的是 `ctx.on('session/created')` / `ctx.on('session/event')`（事件层），ssh/canvas 用的是 `ctx.get('webServer')`（未变）。**推断影响低，需升级后实机验证** |
| 移除 `ctx.agent`，调用方需显式传递 Agent | 全仓 grep 无命中（初查） |
| `Inbox` 改为类型接口，改走 `agent.inbox`；`hasPending` / `claim` 不再是公共 API | 全仓 grep 无命中（初查） |
| 默认工具：Web `minimal` 与 Python `sdk-minimal` 默认只给持久 shell，`str_replace_editor` 需显式启用 | 用户 `web` profile 的 bundles 是 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + 树外插件，**不是 minimal** → 不受影响 |
| 新增 `dsh-http-proxy`：出站请求遵循 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` | 用户环境这四个变量**当前均为空** → 无行为变化 |
| 新模型 `DeepSeek-V41-Flash`（`deepseek-flash`） | 新会话默认使用；配置显式指定模型时以配置值为准。需检查 `~/.dsh/settings.yaml` 是否显式指定了模型 |

**升级后实机验证的重点**：canvas 的会话布（`ctx.on('session/*')` 投影）、ssh 的 WebSocket 终端、token-monitor 的用量统计 —— 这三个是仅有的带 host 端逻辑的插件。

---

## 6. 升级前检查清单与备份

### 6.1 必须备份（升级后无法重建）

```powershell
$stamp = '0.1.2-rc.1-20260910'
$bk = "$env:USERPROFILE\.dsh-backup-$stamp"
New-Item -ItemType Directory -Force $bk | Out-Null

# 1) 会话数据（134.5 MB）—— 唯一可靠的回退保障
Copy-Item "$env:USERPROFILE\.dsh\sessions" "$bk\sessions" -Recurse

# 2) 用户侧 agent preset（三个 persona 已注入版本）
Copy-Item "$env:USERPROFILE\.dsh\.agent-presets" "$bk\.agent-presets" -Recurse

# 3) 设置与凭据
Copy-Item "$env:USERPROFILE\.dsh\settings.yaml" "$bk\settings.yaml"
Copy-Item "$env:USERPROFILE\.dsh\.credentials.yaml" "$bk\.credentials.yaml"

# 4) 补丁安装目录的现状（对照用；升级后即失效）
Copy-Item "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-ui-settings-models\lib\client.js" "$bk\settings-models.client.js.patched-installed"
```

### 6.2 记录基线（便于回滚与对照）

```powershell
(Get-Content "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\package.json" | ConvertFrom-Json).version
# → 0.1.2-rc.1（回滚时用：npm i -g @deepseek-ai/dsh@0.1.2-rc.1）
```

### 6.3 代码侧无阻塞项

- `_refs/`、`vendor/`、`dist/` 等已 ignore，不受影响；
- 三条 web 插件线的改动已提交/在途状态见 `git status`，升级不影响工作区；
- `dsh-miasaki-sidebar` 的迁移（官方右栏）**等升级后再做**（依赖 0.1.5 才有的 API）。

---

## 7. 推荐执行顺序

| 阶段 | 动作 | 验证 |
|---|---|---|
| 0 | 按 §6 备份 + 记录基线版本 | 备份目录存在、大小合理 |
| 1 | `npm i -g @deepseek-ai/dsh@0.1.5-rc.1` | `dsh --version` → `0.1.5-rc.1` |
| 2 | 重启 `dsh web`，打开既有会话 | 会话可读、三个 web 插件（canvas/sidebar/ssh）可用、无 slot 报错 |
| 3 | 适配 persona（§2.4） | `apply-presets.ps1` 跑通、三个 preset 的 persona 正确 |
| 4 | 重打设置页补丁（§3.3） | `patch.mjs verify` 通过、`status` 显示 patched |
| 5 | 迁移 sidebar 线到官方右栏（独立方案文档） | 三个 tab 在官方右栏可用 |
| 6 | 实机验证 host 端插件（§5） | 会话布 / SSH 终端 / 用量统计正常 |

**阶段 2 是关键卡点**：若 web 插件在 0.1.5 上出现 slot 错误，先回滚（`npm i -g @deepseek-ai/dsh@0.1.2-rc.1`）再排查 —— 但注意 §4.3：**回滚不保证会话数据可用**，这也是为什么阶段 0 的备份不可省。

---

## 8. 执行方式与中断说明

**升级必须由用户在自己的终端执行**，原因有二：

1. **沙箱**：`npm i -g` 要写 `%APPDATA%\npm` 与 npm 缓存，均在会话工作区之外，会被文件沙箱拒绝；
2. **会话中断**：当前 3080 实例跑在 0.1.2 上，升级后必须重启 `dsh web` —— 那会**终止当前这个对话进程**。

因此建议：备份完成后，由一个**新的、不依赖当前会话**的时机执行升级；升级后重新打开 DSH，本方案与所有相关文档均已落盘在仓库中，可直接接续阶段 2。

---

## 9. 待确认项（升级后立即核实）

1. `dsh-persona` 的新配置 schema（`text` 是否保留、前后缀字段名）—— 决定 `apply-presets.ps1` 的改法；
2. 0.1.5 的预设底座 `agent.cordis.yml` 与 0.1.2 的 diff；
3. `dsh-client-ui-settings-models/lib/client.js` 的 7 个锚点是否仍在（`patch.mjs` 会在缺失/不唯一时报错，不会静默改错）；
4. `~/.dsh/settings.yaml` 是否显式指定了模型（若是，新默认模型 `deepseek-flash` 不会自动生效）；
5. 回滚后旧会话是否仍可读（**建议在备份副本上试，不要拿真实数据试**）。
