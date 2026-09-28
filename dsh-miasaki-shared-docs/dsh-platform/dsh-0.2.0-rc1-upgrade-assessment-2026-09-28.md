# DSH 0.2.0-rc.1 升级评估（实测）：十件补丁零适配

- 日期：2026-09-28
- 调研者：总指挥（Miasaki 会话）
- 对象：`@deepseek-ai/dsh` **`0.1.7-rc.2`**（本机现行）→ **`0.2.0-rc.1`**（npm `next` 轨，2026-09-28 发布）
- **配套**：[`dsh-official-repo-review-2026-09-28.md`](dsh-official-repo-review-2026-09-28.md)
  —— 该文回答「官方仓库变了什么、影响哪几条线」，本文回答「**升上去要花多大力气**」。
- 上一份同类：[`dsh-0.1.7-rc2-upgrade-assessment-2026-09-25.md`](dsh-0.1.7-rc2-upgrade-assessment-2026-09-25.md)（09-25，升到 0.1.7-rc.2）
- 口径：`[实测]` = 本次下载真实产物或本地跑命令核到；`[推断]` = 基于证据的判断，未做隔离实例实测

---

## 0. 摘要

1. **★★★ 十件补丁零适配**：9 件官方补丁在 **0.2.0-rc.1 真实 npm 产物**上逐个跑 `apply`，
   **全部 `exit=0`、全部通过内置语法闸门、`EDITS` 一条都不用改**。第 10 件（第三方
   `@yeesy369/dsh-browser-playwright` 双半）其目标文件属于第三方包本身，**DSH 本体升级不触及**。
2. **★★★ 其中 5 件的目标文件在 0.2.0-rc.1 里逐字节未变**：`dsh-client-ui-attachment`、
   `dsh-client-ui-brand-official`、`dsh-client-ui-trajectory`、`dsh-cordis-host-runner`、
   `dsh-api-session-controller`。剩余 4 件（chat / conversation / settings-models / sidebar）
   文件有改动，但**锚点仍全部唯一命中**。
3. **★★ 发现一处真缺陷**：`dsh-client-ui-brand-official/patch.mjs` 的 `parseArgs` 把
   `argv[i]` 误写成 **`args[i]`**，导致 **`--target` 与 `--yes` 双双失效**、永远回落到 live 安装目录。
   本次预检因此一度得到**假通过**（「幂等跳过」），已用环境变量绕过并补验。§4。
4. **★ 升级成本 = 换基线常量 + 重打十件**（`BASELINE_DSH_VERSION` + `ORIGINAL_SHA256` + `PATCHED_SHA256`），
   **无一处需要改编辑规则**。
5. **★ 但升级≠只重打补丁**：行为面还有两件事要处理 —— **Schedule 转 opt-in bundle**（需显式启用）
   与 **desktop profile 新增 OTLP 上报路径**（需确认偏好）。详见配套复查文档 §6。
6. **本次预检未改动本机任何生产文件**：live 安装目录 9 个目标文件在预检前后 **SHA-256 逐一比对，零漂移**。§1.3。

---

## 1. 预检方法（可复现）

### 1.1 拉真实产物

```powershell
$tmp = "<repo>\_refs\probe-020rc1"
npm pack <pkg>@0.2.0-rc.1 --cache "$tmp\npm-cache" --pack-destination "$tmp\tgz" --ignore-scripts
tar -xzf <tgz> -C "$tmp\unpacked\<name>"
```

> `--cache` 必须指进工作区：默认缓存目录（`%LOCALAPPDATA%\npm-cache`）在工作区外，
> 会被文件沙箱以 `EPERM` 拒绝写入。

**拉取清单**（9 件，全部成功）：

| 包 | tgz 字节 |
|---|---|
| `@deepseek-ai/dsh-api-session-controller` | 221,289 |
| `@deepseek-ai/dsh-client-ui-attachment` | 23,185 |
| `@deepseek-ai/dsh-client-ui-brand-official` | 7,010 |
| `@deepseek-ai/dsh-client-ui-chat` | 192,537 |
| `@deepseek-ai/dsh-client-ui-conversation` | 264,323 |
| `@deepseek-ai/dsh-client-ui-settings-models` | 80,293 |
| `@deepseek-ai/dsh-client-ui-sidebar` | 21,311 |
| `@deepseek-ai/dsh-client-ui-trajectory` | 111,934 |
| `@deepseek-ai/dsh-cordis-host-runner` | 99,371 |

### 1.2 干跑

对每件补丁，把解包出的目标文件**复制到副本目录**，再对副本跑：

```powershell
node <线>\patches\<补丁>\patch.mjs apply --target <副本文件> --yes
```

判据：`exit=0` + 产物通过内置语法闸门（`parseVerdict`）⇒ 该补丁的全部 `EDITS` 在新版产物上
**锚点唯一命中且期望值检查通过**。

### 1.3 隔离保证 `[实测]`

预检**前后各取一次 live 安装目录**（`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\*\lib\*.js`）
的 SHA-256，逐件比对：**9/9 未变，漂移数 0**。预检是只读的。

---

## 2. 逐件结果 `[实测]`

| 补丁 | 线 | 0.2.0-rc.1 原文件 | 补丁产物 | exit | 目标文件是否变化 |
|---|---|---|---|---|---|
| `dsh-client-ui-attachment` | desktop | 45,064 B | 45,175 B / `DDDBFA9495CAEAA6…` | 0 | **逐字节未变**（产物 SHA = live） |
| `dsh-client-ui-brand-official` | desktop | 1,863 B | 8,286 B / `821DD9B3CA7AA6E0…` | 0（绕过后） | **逐字节未变**（原文件 SHA `22BB7E18…` 与 baseline 原始相同） |
| `dsh-client-ui-chat` | desktop | 546,916 B | 548,780 B / `3D6074A29E619B28…` | 0 | 有改动，锚点全命中 |
| `dsh-client-ui-conversation` | desktop | 715,533 B | 715,723 B / `20F939778E9C336B…` | 0 | 有改动，锚点全命中 |
| `dsh-client-ui-settings-models` | desktop | 186,641 B | 202,111 B / `950BE2350D9C6850…` | 0 | 有改动，锚点全命中 |
| `dsh-client-ui-sidebar` | desktop | 32,212 B | 32,328 B / `CE314B9691C23F53…` | 0 | 有改动，锚点全命中 |
| `dsh-client-ui-trajectory` | desktop | 421,649 B | 423,513 B / `2BBC3E662EE1A5EA…` | 0 | **逐字节未变**（产物 SHA = live） |
| `dsh-cordis-host-runner` | desktop | 102,835 B | 103,592 B / `D3126110630D4755…` | 0 | **逐字节未变**（产物 SHA = live） |
| `dsh-api-session-controller` | dual-model | 124,151 B | 124,896 B / `40A032EF7123CA97…` | 0 | **逐字节未变**（产物 SHA = live） |
| `dsh-browser-playwright`（双半） | shared-docs | — | — | 不适用 | 目标属第三方包，**DSH 升级不触及** |

> **「逐字节未变」的判据**：补丁产物 SHA-256 与本机 0.1.7-rc.2 上已打补丁的 live 产物**完全一致**；
> `applyPatch` 是确定性纯函数（同一输入必得同一输出），故输入文件相同。
> brand-official 另有一条更直接的证据：0.2.0-rc.1 的原文件与 baseline 登记的
> `client.original.js` **SHA-256 完全相同**（`22BB7E181A8D9337…`，1,863 B）。

**判读**：官方在 `0.1.7-rc.2 → 0.2.0-rc.1` 这 261 个 commit 里改了 4 个被本仓打补丁的 client bundle，
但都**没有触及任何一条编辑的锚点上下文**。这与此前的判断（「UI 层改动多、契约层零改动」）一致。

---

## 3. 升级成本与步骤

**改动面**：每件补丁的 3 个常量（`BASELINE_DSH_VERSION` / `ORIGINAL_SHA256` / `PATCHED_SHA256`）
与两份 baseline 文件（`client.original.js` / `client.patched.js`，或 `index.*`）。
**`EDITS` 数组零改动。**

推荐流程（沿用既有纪律）：

1. **备份** `~/.dsh`（含 profiles 与 sessions）—— 虽然会话格式未变（复查文档 §6.1），仍属升级前必备。
2. `npm i -g @deepseek-ai/dsh@0.2.0-rc.1`（**显式指定版本**，勿用 `latest`——它仍是 `0.1.7-rc.2`）。
3. `dsh --version` 核对为 `0.2.0-rc.1`。
4. 十件补丁**逐件** `rebuild-baseline`（或 `seal`）→ 同步三常量 → `verify` → `apply`。
   - 本次预检已证 `EDITS` 零改，故 `rebuild-baseline` 应**无 diff 冲突**；
   - 若某件报 `unknown`，先核锚点再适配，**不要**直接 `--yes` 硬打。
5. `node scripts/verify-all.mjs` 全量回归（**2026-09-29 实测基线 161 项**；本文件起草时为 150 项）。
6. **重启 `dsh web` / 桌面壳**（`dsh-cordis-host-runner` 与 `dsh-api-session-controller` 属 host 半，
   不重启不生效）。
7. 行为面收尾（见配套复查文档 §6）：点掉「预览版说明」弹窗；按需启用
   `@deepseek-ai/dsh-experimental-schedule-bundle`；确认 General 设置里的 Session Log 上传偏好。
8. 桌面壳浮层定位**实机走查**（官方本窗口修了一批 Windows 标题栏/浮层间隙）。

---

## 4. 本次发现的缺陷：`brand-official` 的 `--target` / `--yes` 失效 ★★

### 4.1 现象

预检时该件报 **`[patch] 已应用，跳过（幂等）`**，而副本文件保持 1,863 B（官方原版）不变。
其余 8 件同一命令同一顺序均正常应用。

### 4.2 根因 `[实测]`

`dsh-miasaki-desktop/patches/dsh-client-ui-brand-official/patch.mjs:203-210`：

```js
function parseArgs(argv) {
  const args = { mode: argv[0] ?? 'status', yes: false, target: null }
  for (let i = 1; i < argv.length; i += 1) {
    if (args[i] === '--yes') args.yes = true                                   // ← 应为 argv[i]
    else if (args[i] === '--target') { args.target = argv[i + 1] ?? null; i += 1 }  // ← 应为 argv[i]
  }
  return args
}
```

`args` 是结果对象，`args[i]` 恒为 `undefined` ⇒ 两个分支**永不进入** ⇒
`args.target` 恒为 `null`（回落 `defaultTarget()` = live 安装目录）、`args.yes` 恒为 `false`。

**全仓 9 件补丁里只有这一件这么写**（其余 8 件的对应行均为 `argv[i]`）。

### 4.3 复现 `[实测]`

```powershell
node patch.mjs status --target <副本>     # 「目标」一栏打印的仍是 live 路径，不是副本
```

### 4.4 影响

1. **预检/离线验证静默失效**：任何以 `--target` 做隔离验证的流程（含本仓既有升级评估惯例）
   对该件都会得到**假结果**——live 已打过补丁时报「幂等跳过」，看起来"通过"，**实际根本没验证**。
   这是典型的**静默回退读取**形态，与 `scripts/check-silent-guards.mjs` 要抓的 R3 类同源。
2. **`--yes` 失效**：对 `unknown` 状态的目标无法强制应用（`args.yes` 恒 false ⇒ 一律拒绝）。
   方向安全（不会误写），但文档承诺的能力不存在。
3. **连带提示**：09-25 那份升级评估用的是同一方法（`apply --target <副本>`），
   若当时也走过该件，其"预检通过"结论同样不可信。**最终 live 状态无误**（该件在 rc.2 上确已 apply 成功），
   但当时的**验证证据**存疑。

### 4.5 绕过与修复

- **绕过**（本次采用）：`defaultTarget()` 会优先读环境变量
  `MIASAKI_DSH_BRAND_OFFICIAL_BUNDLE`，指向副本即可正常验证（已实测：副本 1,863 → 8,286 B，
  SHA `821DD9B3…` 与记录一致；live 未被触碰）。
- **修复**：把两处 `args[i]` 改为 `argv[i]`（单行 ×2）。**本次未改**——属代码改动，待用户确认后按
  desktop 线纪律（改后同步 README / `design/CHANGELOG.md` 并重跑 `verify-all.mjs`）执行。

---

## 5. 未做 / 未验项（不假装拿到）

1. **未在隔离实例上真升级**：本文全部结论来自 `npm pack` 真实产物上的**离线干跑**，
   未在独立 profile 里实装 0.2.0-rc.1 跑端到端。
2. **未验运行时行为**：补丁产物只是**字节级可应用**，其在 0.2.0-rc.1 运行时下的**实际效果**
   （DOM 锚点是否仍存在、遮蔽关系是否仍成立）需实机验收——尤其 `sidebar` 的推挤选择器与
   `conversation` / `trajectory` 的 DOM 结构，官方本轮恰有对话区 UI 改动。
3. **未核 `packages/AGENTS.md` 之外的契约文件**（复查文档 §8 已列）。
4. **`dsh-browser-playwright` 未做任何验证**：结论「DSH 升级不触及」是基于其 `TARGET_PACKAGE`
   指向第三方包（`patch.mjs:66`）的**推断**，未验证其在 0.2.0-rc.1 的 client runtime 下是否仍工作。
5. **未验证第三方插件在 0.2.0-rc.1 的运行时兼容性**：`@openviking/dsh-memory-plugin`、
   `@yeesy369/dsh-tool-browser` 的 peer 上界问题（复查文档 §5.1）只是准入闸门层面，
   协议层面是否兼容未验。

---

## 6. 结论

**升到 `0.2.0-rc.1` 的补丁侧成本是「零适配」**——十件补丁在真实产物上全部可应用，
五件目标文件甚至逐字节未变。本次唯一的负面发现不在官方，而在本仓：
`brand-official` 补丁的 `--target` / `--yes` 解析缺陷（§4），使离线验证链路对该件静默失真。

**升级决策建议**：补丁侧风险已探明且极低，可以升；但**不必抢在 RC 阶段升**——
`latest` 仍是 `0.1.7-rc.2`，且升级后需处理 Schedule opt-in、desktop 上报偏好，
以及桌面壳浮层的实机走查。建议等 0.2.0 正式版或 0.2.0-rc.2+ 再一次性做，
届时本文的预检流程可直接复用（注意先修 §4 的缺陷）。

---

## 7. 事后核对：预检结论 vs 实际升级 `[实测]`

**用户当日决定立即执行**（未等正式版）。升级已按本文流程走完，**预检结论与实操逐件吻合**：
五件目标文件逐字节未变、四件有改动但锚点全部唯一命中、**`EDITS` 零改动**、只换了三常量与 baseline。

| 复核项 | 结果 |
|---|---|
| `patch.mjs verify`（九件逐个自证） | **9/9 PASS** |
| `patch.mjs apply` → live SHA | **9/9 与阶段 A 产物逐字节一致** |
| `scripts/patch-live-audit.mjs` | **11 目标 / 10 件补丁：patched 11、未生效 0、未安装 0** |
| `scripts/verify-all.mjs` 全量 | **153 项 PASS**（desktop 36/36，含 `cargo test` 100 例） |
| `dsh --version` | `0.2.0-rc.1` |

### 7.1 两件预检没有覆盖的事（已补入经验）

1. **在 DSH 运行时 `npm i -g` 会死锁** ★★★
   `reify` 阶段静默僵死 15 分钟（日志零增量、CPU 零增量），停在
   `reify mark deleted [...\@img\sharp-win32-x64]`——`libvips-42.dll` 等 `.node` 正被宿主进程加载锁定。
   **结论：升级 DSH 本体前必须先退出正在运行的 DSH 进程。** 本文 §1 的离线预检方法（`npm pack` 到工作区 +
   `apply --target` 副本）之所以安全，正是因为它**不写 live**；而真正落盘的那一步继承了宿主的文件锁风险。
2. **死锁中断会留下三处半安装状态**（bin shim 缺失、`@img/sharp-win32-x64` 缺 `package.json`、
   `@deepseek-ai/libreoffice-kit-win32-x64` 半解包）。逐项修复方式见 desktop 线
   [`design/CHANGELOG.md`](../../dsh-miasaki-desktop/design/CHANGELOG.md) 2026-09-28（续九）。

### 7.2 影响边界（本次实测澄清）

官方桌面端自带独立运行时（`app.asar` 内 `@deepseek-ai/dsh-desktop-runtime` + 14,999 个文件），
**不经过全局 npm**，故本次升级不影响官方桌面端与当时运行中的会话；受影响的是 `dsh web` 与 miasaki 桌面壳。
官方桌面端自身亦经 `nightly` 通道同期更新到 `0.2.0-rc.1`。
