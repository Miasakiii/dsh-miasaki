# 补丁：给 `dsh-our-free-model` 做界面增量 + 弹窗静默化

## 这是什么

对上游插件 `dsh-our-free-model` 的**本机安装副本**做两类改写：

1. **界面收敛（2026-09-28）** —— 把本线（`@miasaki/dsh-free-model`）的**扫描能力接进上游插件的设置页**，
   让设置里**只剩一个页面**、名字叫「免费模型」，且**没有公告**；
2. **静默化（2026-10-07）** —— **去掉它的右下角弹窗公告**（新公告 / 「插件可升级」/ 热重载提示，
   连同紧急公告的全屏模态与系统通知），**以后有更新只在「免费模型」设置页顶部提醒**。

> 一句话契约：**这个插件不该主动找上门。**
> 唯一保留的弹窗是设置页里「保存失败」的即时应答 —— 那是对你刚做动作的回话，不是公告。

## 为什么必须用补丁

用户的三条诉求是：**一个页面**、**长在 Our Free Model 那张页面上**、**视觉与它一致**。
而 `dsh-our-free-model` 的设置页是**整页自绘**的 —— 六个 `<Section>` 写死在
`SettingsPage` 的返回值里（`client.js:1419-1441`）。官方 slot 机制只允许别的插件注册
**自己的** section，**没有往别人 section 里插内容的通道**。所以只有"在它身上做增量"这一条路。

静默化同理：弹窗（`showToast` / `showUrgentModal` / `osNotify`）全在它的 `apply()` 里，
只有它的源码说了算 —— 官方没有"关掉某个插件通知"的开关。

同时**不改它的源仓库**（那是人家的项目），只改**本机安装副本**：
`%USERPROFILE%\.dsh\local-plugins\dsh-our-free-model\client.js`。

## 十二处改动（锚点全部唯一命中才动手）

### 一、界面收敛（2026-09-28）

| id | 改动 | 说明 |
|---|---|---|
| `nav-label` | `label: () => t('nav')` → `label: '免费模型'` | 左栏名字 |
| `drop-news-section` | 删掉 `h(Section, { title: t('section.news') … })` 那一行 | 「公告中心」分区 |
| `drop-onboarding` | 删掉 `ctx.slots.inject('settings.onboarding', …)` 整块 | 首启那个 5 页公告弹窗 |
| `inject-panel-component` | 在 `function SettingsPage(props) {` 之前插入 `PlatformScanPanel` | 新分区的组件，源码在 [`inject/platform-panel.js`](inject/platform-panel.js) |
| `inject-platform-section` | 在模型清单那一行之后插入新 `<Section>` | 「本机自配平台」分区 |

### 二、静默化（2026-10-07，用户点名「去掉右下角弹窗公告，以后有更新在设置页提醒」）

| id | 改动 | 说明 |
|---|---|---|
| `silence-announcement-push` | 删掉 `announcements` SSE 里的推送块 | 一次关掉三条通道：右下角 toast、`urgent` 全屏模态、系统通知 |
| `silence-update-push` | 删掉 `update` SSE 里的 `osNotify` + `showToast` | 「插件可升级」不再弹窗；事件广播照旧 |
| `silence-reload-notice` | 删掉 `'our-free-model: reload notice'` 整个 `ctx.effect` | 它唯一的产物就是那个右下角提示（连 `localStorage` 记账一起移除，不留死逻辑） |
| `inject-update-notice-component` | 注入 `UpdateNotice` 组件 | 源码在 [`inject/update-notice.js`](inject/update-notice.js)；锚点是 `// ── in-app upgrade` 标题行 |
| `inject-update-notice-bar` | 在模型清单之前插入 `h(UpdateNotice, {})` | 提醒条落在**页首 hero 之后**，一进「免费模型」就能看见 |

**新提醒条的行为**：读 `api('/update/status')`（本页现成辅助函数，同源带 cookie），
并监听上游仍在广播的 `ofm:update` / `ofm:upgraded` 两个 window 事件；
**没有新版本时整块渲染 `null`**（不占位），有更新时给一条警告色提示 + 「立即升级」「稍后再说」。
样式全部复用上游 `ofm_*` 类，**不新增 CSS 类、不碰它的 i18n 字典**。

**为什么锚点选 `// ── in-app upgrade` 而不是 `function SettingsPage`**：
`inject-panel-component` 的 applied 判据要求 `PANEL` 与 `function SettingsPage` 那一行**逐字相邻**；
在两者之间再插一份源码，会把它挤成 `pending` ⇒ **下一次 apply 会二次注入 `PlatformScanPanel`**。
（这个坑是 2026-10-07 真踩到的，现在由 `self-test.mjs` 的**幂等断言**看着。）

**不碰的东西**：它的任何内部逻辑、它的 i18n 字典（`t()` 的 zh/en 表）、它的文件清单
（不留任何新文件 —— 纯文本改写，所以 `revert` 能把文件逐字节还原）。
**唯一例外**见 §三（分区标题的字号，一行 CSS）。

### 三、标题层级（2026-10-07，用户点名「分区标题与内容一样大一样粗」）

| id | 改动 | 说明 |
|---|---|---|
| `enlarge-section-title` | `.ofm_sec_title{font-size:14px;font-weight:650}` → `font-size:16px` | 「模型清单 / 本机自配平台 / 升级」这些分区标题提档 |

**为什么**：上游分区标题 14px/650 与**卡片名** `ofm_cardname` 13.5px/650 几乎同级
（页基准字号是 13px）⇒ 分区与分区里的内容看不出层级。只提字号，字重 650 与
`label-primary` 都是上游自己的取值 ⇒ 观感仍是它那套设计语言，不是我们另起一套。

**这一处刻意破了「本补丁不动上游 CSS」的原约束**（原决策记在 §一 的 2026-09-28 条）：
那条约束的收益只是"少一处升级漂移面"，而漂移本来就会被 `self-test.mjs` **显式打红**
（`drift` ⇒ exit 1，绝不静默写坏文件），用户点名的层级问题优先。除这一行外仍不碰它的 CSS。

### 四、自升级不再被 8 秒超时打断（2026-10-07，用户截图报红框后补）

| id | 改动 | 说明 |
|---|---|---|
| `apply-upgrade-long-timeout` | `const result = await post('/update/apply', {})` → `await ofmApplyUpgrade()` | 上游「升级」分区那次调用；提醒条自己也走同一个函数 |

**现象**：点「立即升级」后红框 `signal is aborted without reason`，看起来像按钮坏了。

**根因**：上游 `api()` 给**每个**请求套了 8 秒 `AbortController`（它为防挂起加的兜底），
而 `/update/apply` 要做「拉 manifest（自身超时 15s）→ 并发 4 路下载全部文件（每路 30s）→
备份 → 安装 → 热重载」—— 8 秒必然打断；**真实失败原因**（host 侧 `~/.dsh/our-free-model/updates.json`
记的 `staging failed: … fetch failed`，随 500 响应发出）到达时客户端早已断开，用户永远看不到它。
2026-10-07 实测那次升级在 host 侧**真的跑了、也真的失败了**。

**修法**：`inject/update-notice.js` 里的 `ofmApplyUpgrade()` —— 自己发 `fetch`、**240 秒超时**、
失败时把服务端 `error` 原样抛出；两处调用点共用它。**这是修上游的缺陷，不是我们的功能新增。**

新分区的**数据来自同源路由** `/freemodel-api/*`（本线 host 半身注册，cookie 自动携带，
与内核 `/api` 同级）。**本线插件不在场时**，新分区退化成一行说明 —— 不抛错、不影响本页其它分区。

## 用法

```bash
node patch.mjs status        # 每处锚点：applied / pending / drift
node patch.mjs apply --yes   # 打补丁（首次会写 client.js.ofm-patchbak）
node patch.mjs verify        # 全部 applied 才算过（已接入 verify-all 的 free-model 类别）
node patch.mjs revert --yes  # 从 .ofm-patchbak 整文件还原
```

`drift` = 锚点既不在场、也非恰好命中一次 —— **上游升级后最可能就是这个状态**，
`apply` 会显式失败而不是写坏文件。

**为什么没有"就地逆向"兜底**：那段实现无法保证逐字节还原（`replace` 类要换回原串、
`insert` 类只能删新增部分而不能删锚点，我第一版写错过）。**给出半对的回退比显式失败更糟** ——
所以无备份时 `revert` 直接失败并给出两条正路：重装插件，或按上表手工撤接入点。

## ⚠️ 升级后必须重打

上游插件的**应用内升级会覆盖清单内文件、并删除清单外文件**
（`src/updater.js` 的 `installStaged`，逐行核实过）。`client.js` 在发布清单内，
所以**每次它自升级之后，本补丁都会被冲掉**：

```
node patch.mjs status        # 期望看到 12 处 pending（= 被升级冲掉了）
node patch.mjs apply --yes   # 重打
node patch.mjs verify
```

这与本仓 `dsh-miasaki-desktop/patches/` 下那批官方补丁**完全同一套纪律**：
补丁一定会被升级冲掉，所以必须有一个一眼可见的状态命令和一个一键重打命令。

若 `status` 报 **drift**（而不是 pending），说明上游改了这几行的写法：照着
`patch.mjs` 顶部 `EDITS` 里的 `from` 逐条到新版 `client.js` 里找对应位置，改准锚点后再 apply；
`inject/platform-panel.js` 与 `inject-platform-section` 的插入位置通常不受影响。

## 升级前先预判（2026-10-07 新增，因为踩过）

上游 2.0.0 把网页半身改成了**多标签壳**（`FreePage` / `EacPage` / `ChannelsPage` / `LedgerPage` /
`LogsPage` / `GatewayPage`）⇒ 2026-10-07 实测：**12 处锚点只有 8 处还能命中**
（3 处 `drift` ⇒ `apply` 会显式失败；1 处是**误导性绿灯**，见下）。**先看，再点升级**：

```powershell
# 把新版 client.js 下到临时目录，把补丁指过去看状态（不动真文件）
$tmp = "$env:TEMP\ofm-new"; New-Item -ItemType Directory -Force $tmp | Out-Null
Invoke-WebRequest 'https://raw.githubusercontent.com/zouyuxuan122/dsh-our-free-model/main/client.js' -OutFile "$tmp\client.js"
$env:OFM_CLIENT = "$tmp\client.js"; node patch.mjs status
```

**判据的局限（务必知道）**：`remove` 类锚点的 applied 判据是"`from` 不在场"——
上游把目标**改写**成别的形态时它会报**绿灯**，而目标其实还在。
2.0.0 实测就是这样：`drop-news-section` 报 `applied`，而公告中心在 2.0.0 里**变成了两处新写法**、
一处都没删掉。所以 **`remove` 类锚点不能只信 `status`**，要配一句"目标语义确实消失"的断言 ——
`self-test.mjs` 里「『公告中心』分区那一行已消失」那条只对 1.3.1 的写法有效。

## ⚠️ 改了 `inject/*.js` 的内容之后：必须 revert 再整份重打

`inject-*` 类锚点的 applied 判据是"改写结果 `to` 在场"，而 `to` 里嵌着注入源码 ——
**注入源码一改，`to` 就变了** ⇒ live 上那份**旧版本**判 `pending` ⇒ 直接 `apply` 会把组件
**注入第二份**（重复函数声明：不报错、不崩溃，最难发现的那种）。2026-10-07 实测复现
（`function UpdateNotice()` ×2）。正确流程：

```
node patch.mjs revert --yes    # 整文件还原到上游原版
node patch.mjs apply --yes     # 12 处一次打全
```

`self-test.mjs` 的「注入片段各只出现一次」就是盯这个形态的（已做定向故障注入验证）。

## 验证记录 `[实测]`

**2026-09-28（界面收敛，五处）**

```
副本上跑（OFM_CLIENT 指向临时副本，不动真文件）：
  status 改前        → 5/5 pending
  apply --yes        → 5 处全部写入；node --check 通过
  精确断言           → 左栏名已改 ✓ / 组件已注入 ✓ / 新分区已挂上 ✓ /
                       「公告中心」那一行已消失 ✓ / 首启公告注册已消失 ✓ / i18n 字典未被破坏 ✓
  revert --yes       → 与原文件**逐字节一致**（SHA-256 相同）
  无备份时 revert    → exit 1 + 指引（刻意不给半对的兜底）
```

**2026-10-07（静默化，新增五处 → 共十处）**

```
副本 dry run        → status 改前 5 applied / 5 pending（正是"旧补丁在位、新锚点待打"）
apply --yes        → 5 处新锚点全部写入；node --check 与 vm 编译均通过
幂等                → 连打两次 SHA-256 相同（07BC4683…E0FD8）—— self-test 已把它固化成断言
self-test          → 16 条断言全绿（含"公告不再弹 toast / 模态 / 系统通知""提醒条已注入"
                       "保存失败的错误提示仍保留"反向判据），上游原版输入下同样 PASS（= 升级后能重打）
渲染探针            → 用迷你 hooks 运行时真渲染 `SettingsPage`：注入的 `UpdateNotice` 恰好 1 个；
                       有更新时渲染出 `ofm_callout` 提醒条（文案 + 两个按钮齐全），无更新时渲染 `null`；
                       **A/B 对照**：上游原版在同探针下 UpdateNotice 实例数 = 0（探针有区分力）
bundle 加载冒烟      → 改写后 bundle 可加载、factory 可执行；`apply(ctx)` 注册的槽位只剩
                       `settings.section`（`settings.onboarding` 已消失），section label = 「免费模型」
live 落盘           → 真副本 10/10 applied（`~/.dsh/local-plugins/dsh-our-free-model/client.js`）
```

> 两个探针（`bundle-load-probe.mjs` / `render-probe.mjs`）是**一次性取证**，留档在
> `_refs/scripts-archive/ofm-silence-probe-2026-10-07/`（`_refs/` 不入库）—— 上游自升级冲掉补丁后，
> 可以用它们在不重启宿主的前提下先证一遍"补丁真的改对了"。

**2026-10-07（续 · 标题层级，新增一处 → 共十一处）**

```
status（改前）      10 applied / 1 pending（enlarge-section-title）
self-test（改前）    真文件是原版分支 → 临时副本上 apply 了 11 处；17 条断言全绿 + vm 编译
apply --yes        只写新锚点 1 处（其余 10 处按 applied 跳过 ⇒ 不重复注入）
verify             11/11 applied PASS
self-test（改后）    真文件已带补丁分支 → 直接断言，同样 17 条全绿
live 落盘           `.ofm_sec_title{font-size:16px;font-weight:650}` 已在真副本逐行核对
```

**2026-10-07（续二 · 升级超时，新增一处 → 共十二处）**

```
触发               用户截图：提醒条正常（1.3.1 → 2.0.0），点「立即升级」后红框
                   `signal is aborted without reason`
根因               api() 的 8 秒 AbortController 打断 /update/apply（宿主侧一次升级要 15s+30s×N+安装+热重载）；
                   真实原因在 ~/.dsh/our-free-model/updates.json：
                   `staging failed: vendor/channel-pack/NOTICE.md: fetch failed`（host 侧真跑真失败）
诊断              该文件在仓库里可取（两源 HTTP 200 / 3542B / sha256 与清单一致）；
                   本会话用 Node fetch 复现同样的 ECONNRESET（PowerShell 能过）⇒ 瞬时网络，非上游缺文件
dry run            status 11 applied / 1 pending → apply → verify 12/12 → --check 通过
定向故障注入        拿"二次注入"脏副本（改注入源码后直接重打所致）跑 self-test
                   ⇒ 只有「注入片段各只出现一次」变红 ⇒ 判据有区分力
live               revert（回上游原版）→ apply 12 处 → verify PASS → 注入片段各 1 份
self-test          21 条断言全绿
渲染探针            提醒条文本含新增的本机提示；有更新 → 提醒条；无更新 → null
verify-all          free-model 16/16 PASS
2.0.0 预判          1/12 applied / 3 drift / 8 pending（见「升级前先预判」一节）
```

## 许可

改写对象是 `dsh-our-free-model`（MIT）。本目录**不存放**它的任何副本 ——
只有锚点规则、我们自己的注入组件（`inject/platform-panel.js` / `inject/update-notice.js`）与说明。
