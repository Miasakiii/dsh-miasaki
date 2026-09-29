# DSH 0.2.0-rc.2 升级评估（实测）：七件零适配 + 两件需处置

- 日期：2026-09-29
- 对象：`@deepseek-ai/dsh` **`0.2.0-rc.1`**（本机现行，npm `next` 轨）→ **`0.2.0-rc.2`**
  （npm `next` 轨，GitHub Release tag `dsh-v0.2.0-rc.2`，published `2026-09-29T09:42:36Z`）
- 上一份同类：[`dsh-0.2.0-rc1-upgrade-assessment-2026-09-28.md`](dsh-0.2.0-rc1-upgrade-assessment-2026-09-28.md)（09-28，升到 0.2.0-rc.1）
- 口径：`[实测]` = 本次下载真实产物或本地跑命令核到；`[推断]` = 基于证据的判断，未做隔离实例实测
- **本文只做「准备」，未改动本机任何生产文件、未升级、未改任何补丁文件。**

---

## 0. 摘要

1. **★★★ 七件零适配，两件需处置**。9 件补丁在 **0.2.0-rc.2 真实 npm 产物**上逐个干跑 `apply`：
   **7 件 `exit=0`、锚点全部唯一命中**（其中 5 件的产物 SHA 与现有常量逐字节一致）；
   **2 件必须处置** —— `dsh-cordis-host-runner`（4/4 锚点失效）与 `dsh-client-ui-sidebar`
   （6 条编辑中 `sidebar-brand-portal` 1 条失效）。§2、§3。
2. **★★★ `cordis-host-runner` 建议整件退役 —— 官方在 rc.2 里自行实现了同一修复**，
   且比本补丁更完整：`pending.failure ??=` 记录拒绝原因、`clientQueryTimeoutMs` 可配超时、
   `finally { clearTimeout(timer) }` 清理、以及**本补丁没有的**「无页面连接时立刻失败」守卫。
   本补丁 4 条编辑的意图**全部被上游吸收**。§3.1。
3. **★★ `sidebar` 失效的那一条同样源于官方收敛**：rc.2 **删掉了侧边栏品牌区（logo）
   的 Tooltip 包装**，`sidebar-brand-portal` 失去了作用对象。剩余 **5 条仍全部命中**，
   删掉该条后产物 `0347DB5D…`（32,091 B）、语法闸门 PASS —— 适配方案已离线实证。§3.2。
4. **★ 会话格式未变**：`docs/session-format-status.zh.md` 在 rc.1 与 rc.2 **逐字一致**
   （`latestFinalizedVersion: 4` / `latestReleasedVersion: 3` / `evidenceTag: dsh-v0.1.5-alpha.1`）。
   **升级不会作废 0.2.0-rc.1 建的会话**。§5.1。
5. **★ 插件版本闸门全绿**：本仓 8 条自制插件线的 peer 约束统一为
   `>=0.1.2-rc.1 <0.3.0`，`0.2.0-rc.2` 落在范围内，**无需 `dsh plugin allow-version` 豁免**。§5.2。
6. **★ 升级成本 = 换 3 处 baseline 常量 + 退役 1 件补丁 + 删 1 条编辑**。无一处需要重写编辑规则。§4。
7. **★ 升级前必须退出 DSH 进程**：09-28 已有前车之鉴（在宿主存活时 `npm i -g` 在 `reify`
   阶段静默死锁 15 分钟，中断后留下半安装状态）。本次实测**当前全局 dsh 的 20 个原生文件零锁定**，
   即现在是可行窗口，但执行前仍须复核。§4.2。
8. **本次预检未改动本机任何生产文件**：live 安装目录 9 个目标文件预检后仍全部等于各自的
   `PATCHED_SHA256`，**漂移 0**。§1.4。

---

## 1. 预检方法（可复现）

### 1.1 拉真实产物

沿用 09-28 的既定手法（`npm pack` 的 `--cache` **必须指进工作区**，否则默认缓存目录在
工作区外、被文件沙箱以 `EPERM` 拒绝）：

```powershell
$tmp = "<仓库根>\_refs\probe-020rc2"
New-Item -ItemType Directory -Force -Path "$tmp\tgz","$tmp\npm-cache" | Out-Null
foreach ($p in @("dsh-api-session-controller","dsh-client-ui-attachment","dsh-client-ui-brand-official",
                 "dsh-client-ui-chat","dsh-client-ui-conversation","dsh-client-ui-settings-models",
                 "dsh-client-ui-sidebar","dsh-client-ui-trajectory","dsh-cordis-host-runner")) {
  npm pack "@deepseek-ai/$p@0.2.0-rc.2" --cache "$tmp\npm-cache" --pack-destination "$tmp\tgz" --ignore-scripts
}
Get-ChildItem "$tmp\tgz\*.tgz" | ForEach-Object {
  $name = $_.BaseName -replace '^deepseek-ai-','' -replace '-0\.2\.0-rc\.2$',''
  New-Item -ItemType Directory -Force -Path "$tmp\unpacked\$name" | Out-Null
  tar -xzf $_.FullName -C "$tmp\unpacked\$name"
}
```

**拉取清单**（9 件，全部成功；列 rc.1 压缩包大小以见变化量）：

| 包 | rc.1 tgz | rc.2 tgz | Δ |
|---|---|---|---|
| `dsh-api-session-controller` | 221,289 | 222,187 | +898 |
| `dsh-client-ui-attachment` | 23,185 | 23,186 | +1 |
| `dsh-client-ui-brand-official` | 7,010 | 7,013 | +3 |
| `dsh-client-ui-chat` | 192,537 | **211,309** | **+18,772** |
| `dsh-client-ui-conversation` | 264,323 | 264,573 | +250 |
| `dsh-client-ui-settings-models` | 80,293 | 80,296 | +3 |
| `dsh-client-ui-sidebar` | 21,311 | 21,382 | +71 |
| `dsh-client-ui-trajectory` | 111,934 | 111,936 | +2 |
| `dsh-cordis-host-runner` | 99,371 | **101,783** | **+2,412** |

> 压缩包体积只作**导航**用，判据一律取解包后的解压产物（tgz 头部含元数据，+1/+3 不代表内容有变）。

### 1.2 三方比对（rc.2 原版 vs 补丁登记的 baseline）

把 rc.2 解包出的目标文件与各补丁 `baseline/*.original.js` 逐字节比对：

| 补丁 | 目标文件 | rc.2 原版 | baseline 登记（rc.1 原版） | 判定 |
|---|---|---|---|---|
| `dsh-client-ui-attachment` | `lib/client.js` | 45,064 B / `538711EF…` | `538711EF…` | **逐字节未变** |
| `dsh-client-ui-brand-official` | `lib/client.js` | 1,863 B / `22BB7E18…` | `22BB7E18…` | **逐字节未变** |
| `dsh-client-ui-settings-models` | `lib/client.js` | 186,641 B / `7674ED0B…` | `7674ED0B…` | **逐字节未变** |
| `dsh-client-ui-trajectory` | `lib/client.js` | 421,649 B / `71FA00F0…` | `71FA00F0…` | **逐字节未变** |
| `dsh-api-session-controller`（dual-model 线） | `lib/index.js` | 124,151 B / `FB0F7B96…` | `FB0F7B96…` | **逐字节未变** |
| `dsh-client-ui-chat` | `lib/client.js` | 565,361 B / `575DE080…` | `09AE7BFE…` | 有改动 |
| `dsh-client-ui-conversation` | `lib/client.js` | 716,179 B / `8D5C8223…` | `6A9CBE7C…` | 有改动 |
| `dsh-client-ui-sidebar` | `lib/client.js` | 31,997 B / `88D7E6D2…` | `57C5C6AC…` | 有改动（−215 B） |
| `dsh-cordis-host-runner` | `lib/index.js` | 104,756 B / `5D014094…` | `AC73F866…` | 有改动（+1,921 B） |

### 1.3 干跑

对每件补丁，把 rc.2 解包出的目标文件**复制到副本目录**，再对副本跑：

```powershell
node <线>\patches\<补丁>\patch.mjs apply --target <副本文件> --yes
```

判据：`exit=0` + 产物通过内置语法闸门 ⇒ 全部 `EDITS` 在新版产物上**锚点唯一命中且期望值检查通过**。

> **`--target` 的可靠性**：09-28 曾发现 `brand-official` 的 `parseArgs` 把 `argv[i]` 误写成 `args[i]`，
> 导致 `--target` / `--yes` 双双失效、静默回落到 live 安装目录（详见 09-28 评估 §4）。
> 该缺陷**已修复**（`patches/dsh-client-ui-brand-official/patch.mjs:206-207` 现为 `argv[i]`），
> 本次 9 件全部正确作用于副本。

### 1.4 隔离保证 `[实测]`

预检**前后各取一次 live 安装目录**（`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\*\lib\*.{js}`）
的 SHA-256，逐件比对：**9/9 未变，漂移数 0**（全部仍等于各自补丁的 `PATCHED_SHA256`）。
预检是只读的。

---

## 2. 逐件结果 `[实测]`

| 补丁 | 线 | rc.2 原版 | 干跑产物 | exit | 判定 |
|---|---|---|---|---|---|
| `dsh-client-ui-attachment` | desktop | 45,064 B | 45,175 B / `DDDBFA94…` | 0 | ✅ 产物 = 现有常量 |
| `dsh-client-ui-brand-official` | desktop | 1,863 B | 8,286 B / `821DD9B3…` | 0 | ✅ 产物 = 现有常量 |
| `dsh-client-ui-settings-models` | desktop | 186,641 B | 202,112 B / `9AF06957…` | 0 | ✅ 产物 = 现有常量 |
| `dsh-client-ui-trajectory` | desktop | 421,649 B | 423,513 B / `2BBC3E66…` | 0 | ✅ 产物 = 现有常量 |
| `dsh-api-session-controller` | dual-model | 124,151 B | 124,896 B / `40A032EF…` | 0 | ✅ 产物 = 现有常量 |
| `dsh-client-ui-chat` | desktop | 565,361 B | 567,225 B / `C41AC671…` | 0 | 🟡 锚点全命中，**需回填常量** |
| `dsh-client-ui-conversation` | desktop | 716,179 B | 716,369 B / `A393013F…` | 0 | 🟡 锚点全命中，**需回填常量** |
| `dsh-client-ui-sidebar` | desktop | 31,997 B | 4/6 命中后中止（`sidebar-brand-portal` 0 次） | 1 | 🔴 **需删 1 条编辑**（§3.2） |
| `dsh-cordis-host-runner` | desktop | 104,756 B | 4/4 锚点全部 0 命中，未产出 | 1 | 🔴 **建议整件退役**（§3.1） |

> 前 5 件的「产物 = 现有常量」是**最强证据**：`applyPatch` 是确定性纯函数，产物相同 ⇒ 输入文件相同
> ⇒ rc.2 的该文件与 rc.1 逐字节一致，等于 §1.2 的独立结论二次印证。

**判读**：官方在 `0.2.0-rc.1 → 0.2.0-rc.2` 这 **187 个 commit** 里改了 4 个被本仓打补丁的产物文件，
其中 2 个（chat / conversation）**没有触及任何一条编辑的锚点上下文**；另 2 个（sidebar / cordis-host-runner）
**正是改动落在锚点上**——且都不是意外漂移，而是**官方主动收敛了本仓补丁所针对的那两处代码**。

---

## 3. 两件需要处置

### 3.1 `dsh-cordis-host-runner`：上游已完整吸收，建议整件退役 `[实测]`

**逐条命中对照**（同一份 `EDITS`，对两个输入文件跑）：

| 编辑 | rc.1 baseline | rc.2 原版 |
|---|---|---|
| `record-client-refusal` | 1 ✅ | **0 🔴** |
| `record-output-refusal` | 1 ✅ | **0 🔴** |
| `client-query-deadline` | 1 ✅ | **0 🔴** |
| `clear-deadline` | 1 ✅ | **0 🔴** |

**rc.1（补丁作用对象）**：

```js
resolveClientQuery(agent, requestId, resolution) {
  const pending = this.pending.get(requestId);
  if (pending === void 0 || pending.request.agentId !== agent.id) return { accepted: false };
  if (!resolution.ok) return { accepted: false };          // ← 补丁在此插入「记下拒绝原因」
  try { resolution = { ok: true, data: validateOutput(...) }; }
  catch { return { accepted: false }; }                    // ← 补丁在此插入「记下校验失败原因」
  this.pending.delete(requestId);
  pending.settle(resolution);
  this.ctx.emit("cordis/inspect-query-resolved", { requestId });
  return { accepted: true };
}
```

**rc.2（官方自研版）**：

```js
resolveClientQuery(agent, requestId, resolution) {
  const pending = this.pending.get(requestId);
  if (pending === void 0 || pending.request.agentId !== agent.id) return { accepted: false };
  if (!resolution.ok) {
    pending.failure ??= `${resolution.reason}: ${resolution.message}`;   // ① 官方自记拒绝原因
    return { accepted: false };
  }
  try { resolution = { ok: true, data: validateOutput(...) }; }
  catch (error) {
    pending.failure ??= error instanceof Error ? error.message : String(error);  // ② 官方自记校验失败
    return { accepted: false };
  }
  pending.settle(resolution);
  return { accepted: true };
}
```

`queryClient` 侧官方同样补齐（rc.2）：

```js
const gateway = this.ctx.get("typertGateway");
if (gateway !== void 0 && !gateway.hasLiveClient())
  throw new Error(`... has no connected Harness page. Open or reconnect the Harness page, then retry.`);  // ③ 无页面立刻失败
...
const timer = setTimeout(() => {
  const pending = this.pending.get(requestId);
  if (pending === void 0) return;
  const detail = pending.failure === void 0 ? "Open or reconnect the Harness page, then retry."
                                            : `Client failure: ${pending.failure}`;
  pending.settle({ ok: false, reason: "provider-error",
                   message: `... timed out after ${this.clientQueryTimeoutMs}ms. ${detail}` });  // ④ 超时带上拒绝原因
}, this.clientQueryTimeoutMs);
...
} finally {
  clearTimeout(timer);                                    // ⑤ 清理定时器
  signal.removeEventListener("abort", onAbort);
  this.pending.delete(requestId);
}
```

**结论**：本补丁的**全部四条编辑意图（记录拒绝原因、记录校验失败、超时兜底、清理定时器）
都已在 rc.2 由官方实现**，且实现优于补丁 —— 超时阈值走可配置的 `this.clientQueryTimeoutMs`
（补丁是硬编码 15 s），并额外做了补丁没有的「无页面连接立即失败」守卫与 `emit` 搬迁
（`settle` 回调内通知，任何结算路径都不会漏发 `cordis/inspect-query-resolved`）。

> **建议**：**整件退役**。处置方式二选一，推荐前者：
> ① 从 `verify-all.mjs` 的 desktop 检查清单与 README 补丁表中移除本件，
>    `patches/dsh-cordis-host-runner/` 连同 `design/` 记录归档（保留历史，不再 apply）；
> ② 若想留个「守卫」，可改为只断言 rc.2 仍保有 `pending.failure` 与 `clientQueryTimeoutMs`
>   （即**反回归断言**而非改写），但这属于新增测试，不是补丁。
> **不要**为了保住补丁去硬改锚点 —— 那会与官方实现重复记录失败原因，把 `??=` 的幂等语义
> 变成双写，收益为负。

### 3.2 `dsh-client-ui-sidebar`：官方移除品牌区 Tooltip，删该条编辑 `[实测]`

**逐条命中（rc.2 原版）**：

| # | 编辑 id | rc.2 命中 | 处置 |
|---|---|---|---|
| 0 | `leading-toggle-portal` | 1 ✅ | 保留 |
| 1 | `leading-newsession-portal` | 1 ✅ | 保留 |
| 2 | `panel-row-portal` | 1 ✅ | 保留 |
| 3 | `sidebar-toggle-portal` | 1 ✅ | 保留 |
| 4 | **`sidebar-brand-portal`** | **0 🔴** | **删除** |
| 5 | `sidebar-newsession-portal` | 1 ✅ | 保留 |

**根因**：rc.2 把侧边栏**品牌区（logo）那个「新建会话」Tooltip 的包装整个删掉了**，
直接渲染带 `aria-label` 的 button：

```js
// rc.1（8 tab 缩进的 Tooltip 包装，即 sidebar-brand-portal 的锚点所在）
}) : (0, react_jsx_runtime.jsx)(Tooltip, {
        label: t("session.new.label"),
        shortcutKeys: newShortcut?.keys,
        delayMs: 500,
        children: (0, react_jsx_runtime.jsx)("button", {
          className: clsx(SidebarRoot_module_css_default.brand, SidebarRoot_module_css_default.wide),
          "aria-label": t("session.new.label"),

// rc.2（Tooltip 包装消失，直接是 button）
  className: clsx(SidebarRoot_module_css_default.brand, SidebarRoot_module_css_default.wide),
  "aria-label": t("session.new.label"),
  "aria-keyshortcuts": newShortcut?.aria,
  onClick: () => { startSession(); },
  children: identity
```

该包 32,212 B → 31,997 B（−215 B）正好是一个 Tooltip 包装的体量，与「只删了这里」相符。

**适配已离线实证**：跳过该条后重建产物 → **32,091 B / `0347DB5D73EFDDE20FC9F6AD32645E67FD318A0097A1F74615C77F939352F4C4`**，
语法闸门 **PASS**，其余 5 条全部命中。

> **建议**：删除 `sidebar-brand-portal` 这一条编辑（该 Tooltip 已不存在，其被遮挡问题随之消失），
> patch.mjs 头部注释/README 里「6 处 Tooltip」的说法同步改为 **5 处**。
> 上表产物 SHA 即升级后要回填的 `PATCHED_SHA256`。

---

## 4. 升级成本与步骤

### 4.1 常量回填对照表

**只需动 3 个补丁目录**（其余 5 件原版逐字节未变，`ORIGINAL_SHA256` / `PATCHED_SHA256` 一个字节都不用改）：

| 补丁 | 字段 | 新值 |
|---|---|---|
| `dsh-client-ui-chat` | `BASELINE_DSH_VERSION` | `0.2.0-rc.2` |
| | `ORIGINAL_SHA256` | `575DE08018F49053A58680FBD62D5B9832A93AAFC385217CC4331D5FED6D0DC0` |
| | `PATCHED_SHA256` | `C41AC671B91CEDD3AB1BF2396838DA2122B98C0DB671438F5CA11F50993B2A02` |
| `dsh-client-ui-conversation` | `BASELINE_DSH_VERSION` | `0.2.0-rc.2` |
| | `ORIGINAL_SHA256` | `8D5C8223197D52D69EB0587F88A8A051FC172985553915F1DE361544653A68B0` |
| | `PATCHED_SHA256` | `A393013F1617DB7BD4D1F8AEF82845053F5A0935F06C0E44301266D99E1D45F9` |
| `dsh-client-ui-sidebar` | `BASELINE_DSH_VERSION` | `0.2.0-rc.2` |
| | `ORIGINAL_SHA256` | `88D7E6D2F65350A62F1D97D0CE9BE34643C73E9825243AE9307DAE55094896A2` |
| | `PATCHED_SHA256` | `0347DB5D73EFDDE20FC9F6AD32645E67FD318A0097A1F74615C77F939352F4C4` |
| | `EDITS` | **删除 `sidebar-brand-portal` 一条** |

**原版 SHA 不变的 5 件**（可保持 `BASELINE_DSH_VERSION = 0.2.0-rc.1` 不动，并在补丁 README 注明
「rc.2 同文件逐字节相同」—— 避免制造无信息量的 diff）：

| 补丁 | 原版 / 产物 SHA（两版相同） |
|---|---|
| `dsh-client-ui-attachment` | `538711EF…` / `DDDBFA94…` |
| `dsh-client-ui-brand-official` | `22BB7E18…` / `821DD9B3…` |
| `dsh-client-ui-settings-models` | `7674ED0B…` / `9AF06957…` |
| `dsh-client-ui-trajectory` | `71FA00F0…` / `2BBC3E66…` |
| `dsh-api-session-controller` | `FB0F7B96…` / `40A032EF…` |

### 4.2 执行清单

> ⚠️ **前置硬条件：先退出所有 DSH 进程。**
> 09-28 的事故 —— 在宿主存活时 `npm i -g` 在 `reify` 阶段**静默僵死 15 分钟**（日志零增量、CPU 零增量），
> 根因是 `libvips-42.dll` 等 `.node` 正被运行中的进程加载锁定，中断后留下**半安装状态**
> （`dsh` 命令消失、`@img/sharp-win32-x64` 缺 `package.json`）。**本次实测当前零锁定，说明现在是可行窗口**，
> 但执行前仍需复核一次。

```powershell
# ① 升级前锁检测（20 个原生文件应全部可独占打开）
$root = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh"
Get-ChildItem $root -Recurse -Include "*.dll","*.node" | ForEach-Object {
  try { $fs=[System.IO.File]::Open($_.FullName,'Open','ReadWrite','None'); $fs.Close() }
  catch { "被锁定: $($_.FullName)" }
}

# ② 备份 ~/.dsh（含 profiles 与 sessions；会话格式虽未变，仍属升级前必备）
# ③ 退出 miasaki 桌面壳 / 官方桌面端 / 任何 dsh web 进程，然后：
npm i -g @deepseek-ai/dsh@0.2.0-rc.2      # 显式指定版本；latest 仍是 0.1.7-rc.2，勿用
dsh --version                              # 应输出 0.2.0-rc.2
```

升级完成后，按**既有纪律**逐件重打：

1. 5 件原版未变的（attachment / brand-official / settings-models / trajectory / api-session-controller）：
   `status` 应直接报 `patched`（产物 SHA 未变），**无需任何操作**。
2. chat / conversation：`rebuild`（或 `rebuild-baseline.mjs`）同步 baseline 与常量 → `verify`（须 PASS）→ `apply`。
3. sidebar：先删 `sidebar-brand-portal` 一条编辑，再按上表回填三常量 → `verify` → `apply`。
4. cordis-host-runner：**退役**（§3.1），不 apply；同步清理 `verify-all.mjs` 与 README 补丁表的引用。
5. `node scripts/verify-all.mjs` 全量回归（当前基线 **161 项**）。
6. **重启 `dsh web` / 桌面壳**使 host 半生效；client 半刷页面即可。

### 4.3 回滚

- 补丁层：每件均有 `.dsh-bak`，`node patch.mjs revert` 可还原；`seal`/`rebuild` 前的
  `client.original.js` 是权威原版，`git checkout` 可复原常量。
- 本体层：`npm i -g @deepseek-ai/dsh@0.2.0-rc.1` 退回（同 §4.2 的前置条件与锁检测）。
- 会话数据：**格式未变（§5.1），回滚不涉及数据迁移**。这是本轮升级风险最低的一面。

---

## 5. 行为面变更与兼容面

### 5.1 会话格式 `[实测]`

`docs/session-format-status.zh.md` 在 `dsh-v0.2.0-rc.1` 与 `dsh-v0.2.0-rc.2` 两个 tag 上**逐字一致**：
`latestFinalizedVersion: 4`、`latestReleasedVersion: 3`、`evidenceTag: dsh-v0.1.5-alpha.1`。
**升级不会作废既有会话**（与 0.1.5→0.1.7 那次 V3→V4 不可降级形成对比）。

### 5.2 插件版本闸门 `[实测]`

本仓自制插件对 DSH 包的 peer 约束一律为 `>=0.1.2-rc.1 <0.3.0`
（appearance / canvas / dual-model / free-model / sidebar / ssh / token-monitor 七条线实测），
`0.2.0-rc.2` 落在范围内 ⇒ **无需版本豁免**。

> 注：09-28 复查留下的隐患仍在 —— 第三方 `@openviking/dsh-memory-plugin` 与
> `@yeesy369/dsh-tool-browser` 钉的是 `<0.2.0`。`0.2.0-rc.2` 属**预发布**，semver 的 prerelease
> 规则下仍能通过；**一旦 `0.2.0` 正式版发布，这两个插件会被 peer 闸门拒载**。
> 这是下一颗定时炸弹，与本轮升级无关但同批需留意。

### 5.3 官方 rc.2 变更面（187 commit / Release note）

| 类别 | 条目 | 对本仓的影响 |
|---|---|---|
| 新增 | 桌面端菜单栏可安装/管理 `dsh` 命令（无需另装 Node/pnpm） | 与本仓桌面壳的启动链**可能重叠**，升级后需复核 `dsh.cmd` shim 形态是否变化（desktop 线 `design/boot-loading-terminal.md` 的 F1 解析依赖它） |
| 修复 | **计划审阅在切换会话后无法打开、「查看全文」消失** | 官方侧修复；本仓无自研补丁涉及此路径 |
| 修复 | **持久 PowerShell 完成状态带尾随空格时丢退出码/泄露内部标记** | 直接影响本仓 **ssh / sidebar 线**的持久终端行为，属正向修复 |
| 修复 | 新建终端菜单重复列出同名 shell | 同上 |
| 修复 | 设置页关闭「显示代码工作视图」后无法调整 Agent 预设 | 与本仓 `settings-models` 补丁同页面，补丁已过预检 |
| 优化 | **模型选择器支持搜索（模糊匹配 + 键盘）** | 与本仓 `settings-models` 补丁**同页面**，升级后需实机走查两者是否叠压 |
| 优化 | 聊天耗时/过程信息/字号/深色主题样式、动画开销 | chat / conversation / trajectory 三个补丁的目标区，均已过预检；**升级后按冒烟矩阵走查 TTFT 显示** |
| 优化 | 侧栏文件页用本地应用打开当前文件夹 | 与本仓无冲突 |
| 优化 | 插件安装引导精简、区分已安装/不兼容/内置的升级提示 | 与本仓插件安装流程相关，属正向 |
| 优化 | 自动化提醒改为明确的用户定时消息 | 行为面变更，使用自动化任务时注意语义 |
| 变更 | **第三方模型目录更新至 pi-ai 0.87.1；部分旧模型 ID 被移除，已保存的选择可能需要重新选择** | **★★ 与本仓 free-model 线直接相关**（该线扫 `llm-pi-ai.providers` 枚举自配平台）。升级后需复核模型选择与 free-model 页面的枚举结果 |
| 变更 | Windows 沙箱权限脚本改为授权后一次完成诊断+修复 | 与本仓 `diagnose-windows-sandbox-acl` 技能相关，属正向 |
| 变更 | 实验性异步问答模式（需手动配置启用） | 需显式开启，默认不影响 |

### 5.4 环境事实 `[实测]`

- **本机全局 DSH**：`%APPDATA%\npm\node_modules\@deepseek-ai\dsh` = `0.2.0-rc.1`（8 件本体补丁
  + dual-model 图片准入补丁全部 `patched`，共 9 个 `.dsh-bak`）。
- **官方桌面端**：`desktopVersion: 0.2.0-rc.2`（`resources/runtime/primary-runtime/runtime.json`），
  **自带独立运行时、不经过全局 npm** ⇒ 本次升级不影响官方桌面端，也不影响跑在它上面的会话。
  **受影响的边界是 `dsh web` 与 miasaki 桌面壳**（二者加载全局实装）。
- npm dist-tags 现状：`latest = 0.1.7-rc.2`、`next = 0.2.0-rc.2`、`alpha = 0.1.7-alpha.2`。
  本机在 **`next` 轨**上，故「升级」= `next` 轨内前进一版。

---

## 6. 风险与待复核

| 级别 | 项 | 说明 |
|---|---|---|
| ★★★ | 升级期间 DSH 进程存活 ⇒ npm 死锁 + 半安装 | §4.2 的前置硬条件；已给出锁检测脚本 |
| ★★ | pi-ai 0.87.1 模型 ID 变更 | 升级后需复核已保存的模型选择；free-model 线枚举结果可能变化 |
| ★★ | 桌面壳 `dsh` shim 解析 | 官方新增「菜单栏安装 dsh 命令」，若改变 shim 形态，desktop 线 F1 解析会静默回落 F3（不报错、不回归）——升级后需目检启动链 |
| ★ | `settings-models` 补丁与官方新增的模型选择器搜索叠压 | 同页面，需实机走查 |
| ★ | 第三方插件 `<0.2.0` 上界 | 预发布阶段尚可通过，`0.2.0` 正式版一到即被拒载（既有隐患，非本轮引入） |
| — | 会话格式 | **无风险**（§5.1） |

---

## 附录：预检产物位置

预检脚本与下载产物位于 `<仓库根>\_refs\probe-020rc2\`（`_refs/` 已 gitignore，不入库）：

| 路径 | 内容 |
|---|---|
| `tgz\` | 9 个 `@deepseek-ai/*@0.2.0-rc.2` 原始 tarball |
| `unpacked\` | 解包后的产物（比对与回填的权威输入） |
| `work\` | 干跑副本（`*.dsh-bak` 为 rc.2 原版） |
| `dump.cjs` / `dumpRange.cjs` | 按 needle / 按偏移区间打印产物片段（比对 tab 缩进用） |
| `adapt-check.cjs` | 从 `patch.mjs` 提取 `EDITS`，逐条报命中数；可跳过指定编辑后重建产物并过语法闸门 |

> 这三个探针脚本随升级执行完成一并清理（属项目纪律「探针即用即弃」）；
> 若需长期保留，转入 `_refs/scripts-archive/`。
