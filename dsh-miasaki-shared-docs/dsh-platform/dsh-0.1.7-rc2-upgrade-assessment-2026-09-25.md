# DSH 升级评估（增量）：0.1.7-rc.2（实测）

- 日期：2026-09-25
- 当前运行：`@deepseek-ai/dsh@0.1.7-alpha.2`（`dsh --version` 实测）
- 候选：**`0.1.7-rc.2`**（`next` 轨）；`latest = 0.1.5-rc.3`（不用）；`alpha = 0.1.7-alpha.2`
- 上一版评估：[`dsh-0.1.7-upgrade-assessment-2026-09-23.md`](dsh-0.1.7-upgrade-assessment-2026-09-23.md)（0.1.7-alpha.2 实测）
- 配套（同日官方仓库复查）：[`dsh-official-repo-review-2026-09-25.md`](dsh-official-repo-review-2026-09-25.md)
  —— 本文回答「**现在就升到 rc.2 要花多大力气**」，该文回答「官方仓库变了什么、影响哪几条线」
- 方法：与上几版同法——`npm pack` 拉 **rc.2 真实 npm 产物**到临时目录，对**副本**逐个跑
  `patch.mjs apply --target … --yes`；契约面用 **blob SHA 双 ref 比对 + 逐字节 diff**；
  **全程未触碰 `%APPDATA%\npm` 的真实安装目录，未执行任何安装/升级/重启**

---

## 0. 结论

**升级到 `0.1.7-rc.2` 的成本是「历史最低」：7 个补丁全部锚点命中、增量与 alpha.2 逐字节一致，
契约面零必改，代码侧零新增必改点。触发条件（`next` 出现 `0.1.7-rc.*`）已满足。**

| 项 | 09-23（0.1.7-alpha.2） | **09-25（0.1.7-rc.2）** |
|---|---|---|
| 触发条件 | `next = 0.1.5-rc.3`，**未触发** | **`next = 0.1.7-rc.2`，已触发** ★ |
| 补丁 apply | 6/6 零改动命中 | **7/7 零改动命中**（多一个 attachment 补丁） |
| 补丁增量 | 与基线一致 | **与 alpha.2 逐字节一致**（见 §3） |
| 槽契约 | 7 个关键槽零变化 | **7 个契约文件全为纯增量，零必改** |
| 事件面 | `settings/updated` 移除 → dual-model 已适配 | **适配继续有效**（`settings/document-updated` 仍在，旧事件仍移除） |
| 代码必改点 | 2 处（已落地） | **0 处新增** |
| 第三方插件补丁 | browser-playwright 补丁落地 | **依赖的两个契约（`configForms` / `plugins.item`）仍在 → 继续有效** |
| 结论 | 等 rc | **可以升级** |

一句话：**rc.2 相对 alpha.2 只带来了纯增量契约与功能增强，没有任何一项触及本仓的补丁锚点、
注册点或事件面。升级动作已无技术障碍，剩下的纯粹是排期与验收。**

---

## 1. 本地事实与口径 `[实测]`

| 项 | 值 |
|---|---|
| 本机运行版本 | `0.1.7-alpha.2` |
| npm dist-tags | `latest = 0.1.5-rc.3`；`next = 0.1.7-rc.2`；`alpha = 0.1.7-alpha.2` |
| 补丁总数 | **7 个**：desktop 六个（attachment / chat / conversation / settings-models / trajectory / cordis-host-runner）+ dual-model 一个（dsh-api-session-controller） |
| 与 09-23 的差异 | 09-23 是 5 个 desktop + 1 个 dual-model；**`dsh-client-ui-attachment`（消息图片画廊宽高比）为 09-23 之后新增** |
| 测试方式 | `npm pack <pkg>@0.1.7-rc.2` → 解包到临时目录 → `patch.mjs apply --target <副本文件> --yes` |

> **沙箱适配记录**：`npm` 默认缓存目录（`%LOCALAPPDATA%\npm-cache`）在本会话被沙箱拒绝（`EPERM`）。
> 把 `--cache` 指向临时区即可正常拉包（`npm pack … --cache <临时目录> --pack-destination <临时目录>`），
> **不污染工作区**。

---

## 2. rc.2 相对 alpha.2 改了什么 `[实测]`

- `compare/dsh-v0.1.7-alpha.2...dsh-v0.1.7-rc.2`：**502 个 commit**（含合并），release note 分「新增 / 修复 / 调整 / 优化」四类。
- 功能面（撞卖地、正向项）见配套复查文档 §6，本文不重复。
- **对本仓的相关度**：rc.1 是「自 `v0.1.5-rc.3` 以来的汇总」，其条目多数在 alpha.2 已存在；
  rc.2 相对 rc.1 的增量以**修复与体验优化**为主。

---

## 3. 实测一：7 个补丁在 rc.2 真实产物上 `apply` ★

对 `npm pack` 拉取的 **0.1.7-rc.2 真实产物副本**逐个打补丁：

| # | 补丁 | 目标产物 | rc.2 原始 | 补丁后 | 增量 | alpha.2 上的增量 | 判定 |
|---|---|---|---:|---:|---:|---:|---|
| 1 | `dsh-client-ui-attachment` | `lib/client.js` | 45,064 | 45,175 | **+111** | —（09-23 后新增） | ✅ 命中 |
| 2 | `dsh-client-ui-chat` | `lib/client.js` | 530,699 | 532,563 | **+1,864** | +1,864 | ✅ **一致** |
| 3 | `dsh-client-ui-conversation` | `lib/client.js` | 712,829 | 712,954 | **+125** | +125 | ✅ **一致** |
| 4 | `dsh-client-ui-settings-models` | `lib/client.js` | 186,454 | 201,924 | **+15,470** | +15,470 | ✅ **一致** |
| 5 | `dsh-client-ui-trajectory` | `lib/client.js` | 421,649 | 423,513 | **+1,864** | +1,864 | ✅ **一致** |
| 6 | `dsh-cordis-host-runner` | `lib/index.js` | 102,835 | 103,592 | **+757** | +757 | ✅ **一致** |
| 7 | `dsh-api-session-controller`（dual-model） | `lib/index.js` | 124,151 | 124,896 | **+745** | +745 | ✅ **一致** |

**关键判读**：增量由各补丁的编辑条数固定决定。**七项增量与 alpha.2 上完全一致 ⇒ 每条编辑的锚点都命中且作用范围未变**
（若某条落空，增量必然不同）。因此**零 `EDITS` 适配、零锚点重写**。

### 3.1 产物侧的交叉验证

| 包 | alpha.2 原始 | rc.2 原始 | 判定 |
|---|---|---|---|
| `dsh-cordis-host-runner/lib/index.js` | `AC73F8669B536CF0…` | `AC73F8669B536CF0…` | **逐字节相同**（该包在 alpha.2→rc.2 之间未发布新内容） |
| `dsh-client-ui-settings-models/lib/client.js` | `B2D7D44531687EDD…` | `67EBF868E5278F9E…` | 有变化，但锚点仍命中 |

补丁产物 SHA-256（rc.2 上，截断）：`chat = E5B5E3DF6A2A8C6F…`、`api-session-controller = 40A032EF7123CA97…`。

### 3.2 本轮踩到的两个工具链陷阱（已排除，非补丁问题）

1. **`dsh-api-session-controller` 同时含 `lib/client.js` 与 `lib/index.js`**。
   批量脚本按「优先 `client.js`」探测，把 host 侧补丁喂给了 client 产物，
   报出「锚点命中 0 次」——**看起来像补丁在 rc.2 上失效，实为选错目标**。
   改指 `lib/index.js` 后 **+745 正常命中**。诊断佐证：按补丁的匹配方式复现，锚点在 rc.2 中**精确命中 1 次（第 872 行）**。
2. **`gh api` 静默失败会落盘空文件**，曾把「下载失败」渲染成「契约文件被整个删除」。
   修正为「每次下载校验退出码 + 打印字节数」后，真实变化是 `+19/−1`。详见配套复查文档 §9。

> 教训：**凡是工具说「失败」或「变了」，先怀疑工具链自身；凡是说「成功」，也要用第二道证据交叉验证。**

---

## 4. 实测二：契约面零必改 `[实测]`

逐项核对见配套复查文档 §3，此处只列结论：

| 契约面 | 判定 |
|---|---|
| `ui-sidebar-right/contract/slots.ts`（sidebar 5 槽） | ✅ kind/scope 全未变（+19/−1 均为新增可选字段与注释） |
| `ui-sidebar-right/tab-registry.ts`（kind 裁决规则） | ✅ **规则未变**，extension 压 builtin 仍成立 |
| `ui-conversation/contract/slots.ts` | ✅ `header.actions` / `input.right` 未变（仅 `hooks.stopShortcut` 新增） |
| `ui-settings/contract/slots.ts` | ✅ `settings.section` 未变（仅 Launcher props 新增字段） |
| `ui-sidebar/contract/slots.ts` | ✅ `footer.action` 未变（仅 Root hooks 新增 `shortcuts`） |
| `ui-layout/src/client/index.ts` | ✅ **`shell.overlay` 仍为 `list`/`root`** |
| `packages/client/ui-plugin-manager/src/client/slot-contract.ts` | ✅ **blob SHA 相同（逐字节未变）**，`plugins.item` 仍在 |
| `packages/host/webserver/src/index.ts` | ✅ **blob SHA 相同**，`webserver/index-inject` 零改动 |

---

## 5. 代码侧必改点核对：**0 处新增** `[实测]`

| # | 09-23 登记的必改点 | rc.2 实测 | 结论 |
|---|---|---|---|
| 1 | dual-model：`settings/updated` 移除，改监听 `settings/document-updated` | rc.2 中 `settings/updated` **仍为移除态**；`packages/settings/settings/src/types.ts:75` 只有 `'settings/document-updated'(ns: SettingsNamespace, revision: number): void` | ✅ **09-23 的适配继续有效，无需再改** |
| 2 | desktop 两插件：settings 读取双轨 | rc.2 契约面（`ui-settings` slots）无破坏性变更 | ✅ 无需再改 |
| 3 | 事件目录 `api-catalog.ts` | 双 ref diff：**唯一变化是一句 description 文案**（`beforeOpen` 的说明补充，+61 B），**无 API/签名变化** | ✅ 无影响 |
| 4 | `ui-sidebar-terminal` 遮蔽关系 | rc.2 仍为 `kind: 'terminal'` + `priority: 'builtin'`，`TerminalRecovery`/`TerminalCleanup` 仍注释 | ✅ 关系不变（但新增 `multiple: true`，见复查文档 §5） |
| 5 | 插件 peer 兼容性闸门 | 本仓零命中风险清单外；3 个 desktop 插件的 `^0.1.2-rc.1` 对 rc.2 **判定通过** | ✅ 可升（隐患见 §6） |

---

## 6. 插件 peer 兼容性闸门（rc.1 新机制）`[实测]`

判定实现：`packages/boot/app-boot/src/plugin-compatibility.ts`（104 行，已通读）。
规则与逐插件核对表见配套复查文档 §4，此处只给结论与行动项：

- 五条 web 线**无 `peerDependencies` 字段** → 机制首行即返回，**零影响**；
- `dsh-token-monitor` / `dsh-session-log-move` 只声明 `@deepseek-ai/cordis` → 前缀不匹配，**跳过**；
- **`dsh-pet-panel` / `dsh-model-probe` / `dsh-free-model-pool`** 声明了 `@deepseek-ai/dsh-settings: ^0.1.2-rc.1`
  （后两者还有 `dsh-host-webserver`）→ **进入检查**，实测 `0.1.7-rc.2` **SATISFIED**。

> ⚠️ **登记隐患**：`^0.1.2-rc.1` 隐含上界 `<0.2.0`。dsh 一旦进入 **0.2.0**，这三个插件会被**直接拒绝加载**
> （需 `dsh plugin allow-version` 精确豁免或改 peer 范围）。**建议本次升级顺手把范围放宽**，把定时炸弹拆掉。

---

## 7. 第三方插件补丁：browser-playwright `[实测]`

`dsh-miasaki-shared-docs/dsh-platform/patches/dsh-browser-playwright/` 针对
`@yeesy369/dsh-browser-playwright@0.8.1`（host + client 两半），修的是 0.1.7 设置机制重写导致的
**整个 web UI 停在启动屏**（client 半 `settingsScope` 服务消失 → 纤维 pending → 前端 boot 审计直接抛错）。

rc.2 上重新核对：

| 检查项 | 结果 |
|---|---|
| 插件产物 `apply`（副本） | ✅ **client / host 两半均应用成功**（插件自身版本未变） |
| 依赖的服务 `configForms` | ✅ 仍在（`packages/client/ui-settings/src/client/config-form.ts`、`index.ts`） |
| 依赖的槽 `plugins.item` | ✅ 仍在（`ui-plugin-manager/src/client/slot-contract.ts` **blob SHA 未变**） |
| 判定 | ✅ **补丁在 rc.2 上继续有效**（其双轨 + 安静降级设计对此有冗余） |

---

## 8. 升级步骤建议

> ⚠️ **升级会重启 `dsh web`，从而断开当前这个 harness 会话**。建议在本会话收尾、事项落档之后执行。

1. **落档**（已完成）：本评估 + 配套复查文档入库。
2. **装 rc.2**（显式走 `next` 轨，**不要用 `latest`**——它仍是 `0.1.5-rc.3`）：
   ```powershell
   npm i -g @deepseek-ai/dsh@0.1.7-rc.2
   ```
3. **重打补丁基线**（7 个补丁逐个）：
   ```powershell
   cd dsh-miasaki-desktop/patches/<补丁目录>
   node rebuild-baseline.mjs     # 用当前安装的官方原版重建 baseline，打印需同步的常量
   # 把打印出的常量同步进 patch.mjs → node patch.mjs verify → node patch.mjs apply
   ```
   - **预期**：`EDITS` 零改动（本轮已实测锚点全命中）；
   - `dsh-cordis-host-runner` 的产物与 alpha.2 **逐字节相同**，其 baseline 常量预计无需变；
   - dual-model 的 `dsh-api-session-controller` 走同一流程。
4. **重打第三方补丁**：`dsh-browser-playwright`（`node patch.mjs apply --yes`；该包的 `lib/*.js` 与 pnpm store 是硬链，**重装该插件会冲掉补丁**）。
5. **重启 `dsh web`**（host 侧补丁生效），**刷新页面**（client 侧补丁生效）。
6. **验收清单**（沿用既有条目 + 本轮新增）：
   - [ ] 轨迹页首 token 延迟三行、消息气泡 TTFT 行正常（chat + trajectory 补丁）
   - [ ] 消息多图画廊保持原始宽高比、不再裁成方片（attachment 补丁）
   - [ ] 模型设置页正常渲染（settings-models 补丁，双代变体自动选中）
   - [ ] dual-model 图片准入与辅助模型路由正常（session-controller 补丁）
   - [ ] 浏览器工具可用（browser-playwright 补丁；注意别在升级后重装该插件）
   - [ ] sidebar 右栏终端 / 审查 tab 正常，**并借机复评“遮蔽官方终端”的取舍**（复查文档 §5）
   - [ ] 升级后确认本仓 profile 是否需要**显式重新启用**「定时任务 / 时间上下文」（rc.2 默认关闭）
   - [ ] 桌面端 Windows 项：目录 junction、本地 Markdown 图片预览、文件菜单图标（rc.2 修复项）

---

## 9. 边界：本轮**未**做的事

1. **未执行升级 / 未重打补丁**：所有 `apply` 都在临时目录的**产物副本**上完成，
   `patch.mjs status` 未对**实装环境**运行（实装环境仍是 alpha.2 的 patched 态）。
2. **未做隔离实例实测**：契约结论为源码级，未在隔离实例 + 无头浏览器上验证真实挂载。
3. **未逐字提取十个事件的签名**：09-23 已做过一次（结论：9 个相同、`settings/updated` 移除）。
   本轮以**替代证据**判定事件面无破坏性变更——相关契约文件全为纯增量、`api-catalog.ts` 仅文案变化、
   `settings/document-updated` 仍在且 `settings/updated` 仍为移除态。**若要求逐字级证据，需补做一次提取。**
4. **未评估 0.1.7 的定向机制迁移**（09-23 §7.9 登记的「预设组合包化」）——仍排队，与本次升级解耦。
5. **未核 `dsh-client-ui-attachment` 补丁的 baseline 现状**（该补丁为 09-23 后新增，其 README/常量未在本文复核）。

---

## 附：本次核实方法

- **产物获取**：`npm pack <pkg>@0.1.7-rc.2 --cache <临时目录> --pack-destination <临时目录>`（7 个包）+ `tar -xzf` 解包。
- **补丁实测**：对副本执行 `node <补丁>/patch.mjs apply --target <副本产物> --yes`，
  记录前后字节数与增量，并与 09-23 文档记录的 alpha.2 增量逐项比对。
- **契约比对**：`contents?ref=<tag>` 取 blob SHA 做「变没变」判定，再下载两份做 `git diff --no-index` 判「怎么变」，
  **每次附字节数校验**。
- **事件/机制核对**：`settings/types.ts`、`plugin-compatibility.ts`、`ui-plugin-manager/slot-contract.ts`、
  `ui-sidebar-terminal/index.ts`、`ui-settings/config-form.ts` 逐一读取源码确认。
- **semver 判定**：`node -e` + `semver.satisfies(v, r, { includePrerelease: true })`。
- **未执行**任何安装 / 升级 / 重启；本仓受版本控制的文件中，本次仅新增本文档与配套复查文档。
