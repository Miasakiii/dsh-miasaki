# 全线审查 · 各线对 miasaki 桌面端的适配现状（2026-09-27）

> **审查方式**：只读。八线逐线核对 + 一次运行态实测 + 一次跨线契约面全仓普查。
> **证据口径**：`文件:行号`（相对工作区根）；`[实测]` = 本次在运行中的实例 / 磁盘上直接验证；
> `[事实]` = 源码静态读取；`[声称]` = 文档说法与代码事实不符；`[未验证]` = 需真机或运行 host 才能定。
> **审查基线**：`HEAD = e992671`（2026-09-27），全程 `git status --short` 为空（未改任何文件）。
> **审查人**：Lead + 6 名只读审查员（canvas / sidebar / ssh / appearance / dual-model+usage / fleet）。
> **后续方案**：[跨线方案 · 桌面端适配整改](cross/desktop-adaptation-plan-2026-09-27.md)（同日定稿，待拍板）。

---

## 0. 结论摘要

**一句话**：各线插件在自研壳里**跑得起来**（运行态实测全部在线），但「适配」这件事**缺一层正式的契约与闸门**——
壳实际对外提供 **12 项**契约面，正式文档只登记 **1 项**（`window.miasakiDesktop`），而**它零消费**；
真正在被使用的 8 项属性 / CSS 变量契约**全部未登记、无闸门**、靠源码注释维持。

**三条最硬的缺口**：

| # | 缺口 | 判据 |
|---|---|---|
| ① | **右上角三方争用**：sidebar 往 `.tb-group` 插按钮并写 `--ms-titlebar-reserve:156px`；壳读该变量做官方控件让位；canvas / ssh 各自**量不同对象**做避让，canvas 还明确声明「按钮组宽度固定，无需监听」 | `sidebar/client.js:1270,1299`、`desktop/themes/src/03-switcher.js:60,89,110`、`canvas/client.js:269-280`、`ssh/app.js:390-401`、`ssh/client.js:555-569` |
| ② | **跨线契约零闸门**：`fleet-pulse.json` 的生产字段集与消费读取集之间**没有任何自动断言**，改名不会被任何红灯拦住 | `scripts/verify-all.mjs:130-132,385-391`；无 `check-pulse-contract` 类闸门 |
| ③ | **实机验收 1 / 44**：回归矩阵台账建立于 2026-09-26，唯一勾选项是 A16（SSH 工具面） | `cross/smoke-test-matrix.md:94-170`（`- [x]` 1 / `- [ ]` 44） |

**三条正面结论**（本次实测，不是文档声称）：

- **7 条线插件全部在线**：`/sidebar/api/health` 200、`/appearance/api/state` 200、`/dual-model/api/state` 200、`/canvas/` 200、`/ssh/` 200。
- **7 个 DSH 本体补丁全部已应用**：desktop 六件 + dual-model 一件，逐个 SHA-256 与 `patches/*/patch.mjs` 的 `PATCHED_SHA256` 常量比对，**7/7 PATCHED**。
- **usage 的「账本按 profile 分区」经实测成立**：同时探测两个在线 host——官方桌面端（19387）`profile=desktop`（since 09-26，5.16 亿 token）、自研壳（3080）`profile=miasaki`（since 09-05，29.5 亿 token），两本账各自续写、互不混入。
  **八线里只有这一条把「桌面端适配」做到了可测量、可复现的程度**（§3.8 数据面 5 项已闭环）。

---

## 1. 「桌面端」在本仓的三层含义（先分清，否则结论会串）

| 运行面 | DSH 来源 | profile | 加载的 miasaki 插件 |
|---|---|---|---|
| **自研壳**（`dsh-miasaki-desktop`，Tauri 2） | 全局 npm `@deepseek-ai/dsh@0.1.7-rc.2`（`%APPDATA%\npm\node_modules\…`） | `miasaki` | **全部 7 线 + desktop 自研 4 插件** |
| **浏览器 GUI**（`dsh web`） | 同上（同一份安装） | `web` | 与 `miasaki` 几乎相同（bundles 少一个官方实验包） |
| **官方桌面端**（Electron，`F:\sud\dsh-desk`） | **自带**：`resources/app.asar` 内含 `dsh/` | `desktop` | **只有 `dsh-token-monitor`（usage 线）** |

**关键推论**：前两个运行面**共用同一份全局 DSH 安装**，因此 desktop 的 6 个补丁 + dual-model 的 1 个补丁
**对自研壳与浏览器 GUI 同时生效**；官方桌面端因为读 asar 内自带的 DSH 副本，**补丁影响不到它**——
这正是「官方桌面端 profile 隔离为纯净官方版」在代码层面成立的原因（隔离靠的是 asar，不是 profile）。
> **限定**：asar 内副本对普通文件系统不可读，`scripts/patch-live-audit.mjs` 也只审计 npm 全局安装
> ⇒ 「官方那份是否被打」**没有判据**，上面是「加载来源不同」的推论，不是逐字节核实。

---

## 2. 环境事实（本次实测）

### 2.1 进程与实例

| 进程 | 状态 | 说明 |
|---|---|---|
| 自研壳 `Miasaki` | 运行中（PID 23140，2026-09-27 00:15 启动） | 后端 `node bin.js --profile miasaki --no-open`（PID 52148） |
| 官方桌面端 `DeepSeek Harness` | **6 个进程在运行**（最早 2026-09-26 11:00，另有 09-27 00:19 一个） | `profiles/desktop/package.json` 改动于 09-26 **10:43**，**早于**进程启动（11:00）⇒ 当前进程加载的就是「只挂 usage」的清单，**已实测生效**（§2.4 / §5.5） |

### 2.2 补丁在线状态（`[实测]`，逐文件 SHA-256 比对）

| 补丁 | 目标包 | 在线状态 | 跨线兜底对象 |
|---|---|---|---|
| `dsh-client-ui-conversation` | `@deepseek-ai/dsh-client-ui-conversation` | **PATCHED** | **ssh 线**：会话头「窄宽度溢出保护」——各插件往 `headerActions` 塞控件导致压叠，正是 ssh 三段胶囊的落点 |
| `dsh-client-ui-attachment` | `…-attachment` | **PATCHED** | **dual-model 线**：多图消息画廊按原始宽高比显示 |
| `dsh-client-ui-chat` / `dsh-client-ui-trajectory` | `…-chat` / `…-trajectory` | **PATCHED** | desktop 自身：TTFT 计时可恢复 |
| `dsh-client-ui-settings-models` | `…-settings-models` | **PATCHED** | desktop 自身：思考强度 + 连通性测试（与 `plugins/dsh-model-probe` 同源） |
| `dsh-cordis-host-runner` | `@deepseek-ai/dsh-cordis-host-runner` | **PATCHED** | 全仓：`cordis_inspect_query`(client) 永久挂起修复 |
| `dsh-api-session-controller`（**dual-model 线自带**） | `…-api-session-controller` | **PATCHED** | dual-model：图片准入 |

⇒ **跨线隐性依赖成立**：把 ssh / dual-model 挂进官方桌面端时，它们依赖的本体补丁在 asar 内**不存在**，
行为会与自研壳里不一致（这正是 W6「挂 10 个插件」在 09-26 被收敛为「只挂 usage」的技术原因之一）。

### 2.3 插件挂载矩阵（`[实测]`，读三个 profile 的 `package.json`）

| profile | 声明挂载 | 磁盘 `node_modules` 实际 |
|---|---|---|
| `miasaki`（自研壳） | 7 线 + desktop 4 插件 + 3 个第三方 | 一致 |
| `web`（浏览器 GUI） | 同上（bundles 少 `dsh-experimental-auto-review`） | 一致 |
| `desktop`（官方桌面端） | **仅 `dsh-token-monitor`（`link:`）** | **残留 9 个死副本**：`@miasaki/*` 5 个（junction）+ `dsh-free-model-pool` / `dsh-model-probe` / `dsh-pet-panel` / `dsh-session-log-move`（物理目录） |

⚠ **声明与磁盘不一致**：残留副本不会被 bundles 加载（加载按显式清单），但「隔离为纯净官方版」这一声称
**在磁盘上不可验证**——排查时容易把死副本当成「已挂载」。

### 2.4 运行态探测（`[实测]`，对运行中的 3080 实例发只读请求）

| 探测 | 结果 |
|---|---|
| `GET /sidebar/api/health` | `200 {"ok":true,"plugin":"sidebar","version":"0.10.0-miasaki.0"}` |
| `GET /appearance/api/state` | `200 {"version":5,"enabled":true,"theme":{"skin":"pure"},…}` |
| `GET /dual-model/api/state` | `200 {"enabled":true,"assist":{…"deepseek-flash"},"primary":{…"step-5-preview"},"primaryVision":true}` |
| `GET /canvas/` / `GET /ssh/` | `200`（各自页面外壳，293 B / 775 B） |
| `GET /` | `401`（P10 改走官方 token 后的预期鉴权态） |
| usage 账本 | 三分区 `desktop` / `miasaki` / `web` 均在；`miasaki/usage-log.jsonl` 3.89 MB，**最后写入 = 探测时刻（00:19:34）** ⇒ 自研壳记账活跃 |
| `MIASAKI_FLEET_PULSE` | **用户级 / 机器级 / 进程级均为空** ⇒ 桌宠的 fleet 指示器**当前处于静默关闭**（`fleet-pulse.json` 本身存在且 23:50 刚更新过） |

---

## 3. 核心发现：契约面 **12 项** vs 正式登记 **1 项** vs 被消费 **0 项**

`design/desktop-contract.md` 只登记了 `window.miasakiDesktop`（v1.1）。把源码里**实际生效**的跨线契约面
全部普查一遍后，真实清单是：

| # | 契约面 | 写方 | 读方 | 登记在契约文档 | 有闸门 |
|---|---|---|---|---|---|
| 1 | `window.miasakiDesktop`（capabilities / theme / window.controls） | 壳 `themes/src/10-contract.js` | **无（零消费）** | ✅ | ✅ `themes/test/contract.test.js`（只测自身暴露面） |
| 2 | `html[data-miasaki-theme]` | 壳 `02-core.js:314` | canvas `client.js:405`、appearance `client.js:137` | ❌（正文提及，未列契约面） | 部分 |
| 3 | `html[data-miasaki-theme-yield="skin"]` | 壳 `02-core.js:317` | appearance `lib/config.js:499-512` | ❌ | ❌ |
| 4 | `html[data-mia-appearance]` / `html[data-mia-skin]` | **appearance** | 壳 `00-boot.js:236`、`03-switcher.js:259` | ❌ | 部分（外观线单测） |
| 5 | `html[data-mia-native-mica]` | 壳 `themes/src/12-material.js` | appearance `client.js:672`、`lib/config.js:372-377` | ❌ | ✅ `themes/test/material.test.js` |
| 6 | `--ms-titlebar-reserve`（壳默认 128px） | 壳 `03-switcher.js:89`；**sidebar 覆写为 156px** | 壳 CSS `:90,110`、ssh `client.js:725` | ❌ | ❌ |
| 7 | `#miasaki-titlebar .tb-group`（DOM 挂载点） | 壳 `06-titlebar.js:165` | canvas `client.js:272`、ssh `client.js:322`、sidebar `client.js:1270`（并插按钮） | ❌ | ❌ |
| 8 | `#miasaki-switcher .ms-btn`（主题球） | 壳 `03-switcher.js` | ssh `app.js:408` | ❌ | ❌ |
| 9 | `window.__MIA_THEME__` / `__MIA_NATIVE_MICA__` | 壳 Rust `main.rs:1647-1649` | 壳 `02-core.js:280`、`12-material.js:46` | ❌ | ✅ `theme-source.test.js` |
| 10 | `location.hash` 字段协议（`miasaki-theme/cmd/seq/int/act/wait/pet/petkey/diag/bg`） | 壳 `02-core.syncHash` / `05-sensors.petHashCmd` | 壳 Rust 33ms 轮询 | 部分 | ✅ `hash-fields.test.js` |
| 11 | `miasaki-pet-heartbeat` / `miasaki-boot`（Tauri 事件） | 壳 `02-core.js:165` / `08-ready.js:46` | 壳 Rust `main.rs:3159,3177` | ✅（变更记录） | ✅ `hash-sync.test.js` |
| 12 | `fleet-pulse.json` v2 | **fleet** `workers/pulse/publish-pulse.mjs` | 壳 Rust `main.rs:1860-1900` | ✅（`cross/ab-linkage-pulse-v2`） | ❌（见 §4-② ） |

**这张表本身就是结论**：

1. **正式契约（#1）零消费**——设计初衷是「消灭七线各自猜环境」（`10-contract.js:3-7`），
   实际八线插件对它 **0 命中**（全仓 grep `miasakiDesktop` 的 23 处命中全部落在 desktop 自身与文档）。
2. **真正在用的（#2–#8）全部未登记**——它们靠源码注释与跨线口口相传维持。
   `desktop-contract.md` 通篇没有 `--ms-titlebar-reserve`、没有 `.tb-group`、没有 `data-mia-*`。
3. **「猜环境」没有被消灭，只是换了手法**——普查各线的环境探测：
   UA / `__TAURI__` / `navigator.platform` **零命中**（这点比预期好），取而代之的是
   **DOM 探针 + CSS 变量读写**：canvas `client.js:272-273`、sidebar `client.js:1270`、ssh `client.js:322-323`。
   这比 UA 精确，但同样是**隐式契约**：改类名 / 去变量即静默失效，不会有人报错。
4. **闸门分布倒挂**——被守护的（#1、#5、#9–#11）全是壳**自己写自己读**的；
   跨线在用的（#6、#7）**一个闸门都没有**。

---

## 4. 跨线缺陷（按严重度）

### ① 右上角三方争用：三个写者、两种量法、零协调 `[事实]`

同一块「距窗口右缘 8–116px、高 11–37px」的安全区（壳注释 `03-switcher.js:75-77` 实测），被三方同时占用：

| 方 | 角色 | 实现 | 是否响应变化 |
|---|---|---|---|
| **sidebar** | **写入方**（插按钮） | 往 `.tb-group` **首位**插 `#miasaki-tb-terminal`（`client.js:1270-1297`），并**一次性**写 `--ms-titlebar-reserve:156px`（`:1299`，注释自称「+28 = 多占一格按钮位」） | MutationObserver 常驻保证插入（`:1310`） |
| **壳** | 读取方（消费变量） | `#root header:has([data-conversation-header-corner]){padding-right:var(--ms-titlebar-reserve)}`（`03-switcher.js:90`）、dockkit strip `margin-right:calc(var(…)-6px)`（`:110`） | CSS 自动 |
| **ssh** | 读取方（量父文档实测） | `measureChromeClearance()` 量 `.tb-group` 矩形（`app.js:391-401`）+ `rootObserver` **观察 `documentElement.style`** 让安全线变化有重测信号（`client.js:555-569`，B4 修复） | ✅ 逐帧跟随 + 5 个补充信号 |
| **canvas** | 读取方（量 `.tb-group` 宽度） | `syncChrome()` 量 `getBoundingClientRect()` 下发 `--canvas-chrome-reserve`（`client.js:269-280`） | ❌ **明确声明「按钮组宽度与 right 偏移固定，不随窗口尺寸变化，故无需监听 resize」**（`:268`） |

**缺陷判据**：canvas 的那句前提**已被 sidebar 的注入打破**——`.tb-group` 的宽度**会**变（+28px）。
且 canvas 的 `syncChrome()` 只在 `open()` / `onFrameLoad()` / `showMapOverlay()` 三条路径触发
（`client.js:298,311,316`），其 `themeObserver` 只观察 `data-ds-dark-theme` 与 `data-miasaki-theme` 两个属性
（`:402-405`）——**既不观察 `.tb-group` 子节点，也不观察 `--ms-titlebar-reserve`**。

⇒ 运行期若 sidebar 的终端按钮在 canvas 取数**之后**才创建（sidebar client 晚装载、或壳注入
`.tb-group` 晚于 sidebar 首次 `ensure()`），canvas 的让位量会**少 28px**并持续陈旧，
直到下一次打开画布 / 切主题。**同类问题 ssh 已在 2026-09-26 用 `rootObserver` 修过一轮（B4）**，
canvas 是同一形态的未修版本——修法可直接照搬。

> **三方数值现状（实测口径核对）**：无 sidebar 注入时 `.tb-group` = 108px（壳注释 `03-switcher.js:75`）；
> 注入终端键后 = **136px**（ssh 复刻壳实测）。由此派生三个数：壳默认 `--ms-titlebar-reserve = 128px`、
> sidebar 覆写 = **156px**（128+28）、ssh 实算 reserve = **150px**（136+8+6）。
> 三者语义不同（CSS 右边距 / 注入方声明 / 实测落点），但**没有任何一处把它们对齐或互校**——
> 这正是「隐式契约」的代价。
>
> **ssh 为什么没踩坑**：它的 `rootObserver` 本意是监听「安全线变化」（B4 洞 B），
> 而 sidebar 写 `--ms-titlebar-reserve` 与插按钮**是同一时刻的同一动作** ⇒ 这个 observer
> **顺带兜住了 `.tb-group` 的宽度变化**。canvas 两者都没有，于是成了唯一暴露面。

> **反面纪律**：这不是「canvas 该不该监听 resize」的问题（窗口尺寸确实不影响），
> 而是「**同排其他插件会改变按钮组宽度**」——单看 canvas 自己永远推不出来。

### ② 跨线契约无闸门：`fleet-pulse.json` 字段漂移不会亮红灯 `[事实]`

- 生产端 `dsh-miasaki-fleet/workers/pulse/publish-pulse.mjs` 写 9 个字段；
  消费端 `desktop/src-tauri/src/main.rs:1866-1883` 只读其中 4 个计数 + `v` + `ts`。
- **生产了没人读的 4 个**：`fleet.online`、`today_cost`、`top_task`、`stale_agents`（全仓零读取）。
  `stale_agents` 最可惜——它是「区分真空闲与 worker 疑似崩溃」的唯一信号（桌宠目前区分不了）。
- **现有三道闸门全是同侧自证**：`verify-all.mjs:130-132`（fleet 自己 publish → 自己 validate）、
  桌面端 `cargo test` 用的 pulse 样例是 `main.rs:3291-3295` **本地硬编码字符串**，从不读生产端真产物。
- 唯一共享物 `schemas/pulse.schema.json` **无消费方**（validator 用手写检查，不用 schema）。
- **后果**：把 `running` 改名成 `active` 只改生产端 ⇒ 两侧回归**全绿**，
  消费端 `unwrap_or(0)`（`main.rs:1878`）静默按 0 ⇒ 桌宠「该亮不亮」，**没有任何红灯**。

### ③ 实机验收 1 / 44，且分线不均 `[实测]`

台账（`smoke-test-matrix.md:94-170`）分线项数：SSH 16（含 1 勾）、双模型 3、Sidebar 5、外观 7、
桌面端 8、Canvas 2、跨线 3。**唯一勾选项是 A16**。另有 `§3.3 Canvas 根本没收验收表`（只有两行散文）。

### ④ `MIASAKI_FLEET_PULSE` 默认关闭，联动等于不存在 `[实测]`

桌宠 fleet 指示器只在环境变量存在时启动（`main.rs:1853-1855` 只读环境变量、无默认值无回退）。
本次实测：用户级 / 机器级 / 进程级**全未设置** ⇒ 尽管 `fleet-pulse.json` 每分钟都在更新
（最后写入 23:50），**桌宠侧根本不读它**——从「开始菜单 / 资源管理器」启动壳时永远不会生效。
desktop 自己的 CHANGELOG 早已记过「从未启动」（`desktop/design/CHANGELOG.md:2577`）。

### ⑤ 官方桌面端 profile 声明与磁盘不一致 `[实测]`

`~/.dsh/profiles/desktop/package.json` 的 dependencies 只剩 `dsh-token-monitor`，
但 `node_modules/` 里仍留着 `@miasaki/*` 5 个 junction + 4 个 `file:` 物理目录（见 §2.3）。
死副本不会被加载，但让「纯净官方版」这一声称在磁盘上不可验证。

### ⑥ 桌宠状态优先级文档与代码写反 `[事实]`

`desktop/README.md:399-401`、`design/CHANGELOG.md:3548`、矩阵 `:420` 都写「**fleet 告警 > DSH 等待审批**」；
代码是 `pet_native/window.rs:157`（`st == Waiting` 时**不**被覆盖）+ `model.rs:82-83`（审批 0 / 告警 1）
⇒ 实为「**等待审批 > fleet 告警**」，与 `window.rs:158` 自己的注释一致、与文档相反。

### ⑦ 契约文档头部与实现自相矛盾（壳侧） `[事实]`

`themes/src/10-contract.js:11-14` 头部纪律仍写「**只读 + 订阅，不提供写通道**」，
而同一文件 `:66-100` 就是 v1.1 的受控写能力（`theme.set` / `window.controls`）。
`design/desktop-contract.md` 已更新，**源文件头部没跟上**——改这个文件的人会先读到过时纪律。

### ⑧ 两段启动画：契约只管「不同框」，不管「像不像两遍」 `[事实]`

`cross/boot-loading-2026-09-22.md` §2 约定 loading 页与 Boot Splash **永不同框、各自干净退场**；
实现都到位（desktop `ui/loading.html` 的 `__setReady` 阶段钩子；appearance `lib/splash.js:163` 的 2.5s 兜底）。
但两段都是**纹章动效**（loading：crest ring + halo + scanline / splash：双环 + 三点流动），
用户冷启动会**连续看到两个纹章动画**。契约没约定这条，属设计选择——**列为待目检项，不是缺陷**。

### ⑨ 「一个客户端一本账」的假设被壳的「采用外部后端」打破 `[事实]`

usage 的账本分区键是 **host 进程的 profile**（`lib/index.js:116-124`），不是端口、不是 argv。
但壳在 3080 已被占用时不重新拉起后端，而是**采用既有实例**（`main.rs:1310-1316`）。
`dsh web` 的默认 profile 恰好也是 `web` ⇒ **「浏览器先开 `dsh web`，再启动壳」这条路径下，
壳里跑出来的用量会记进 `web` 分区**，与浏览器 GUI 共写一本账。
README 与矩阵 §3.8 的口径都只声明了「三个 profile 各记各的」，**未覆盖这条共用路径**——
它不破坏已实现的分区机制，但会让「自研壳统计干净」这一承诺在特定启动顺序下不成立。

---

## 5. 逐线适配结论

> 各线小节以「契约消费 / 实机验收 / 文档失真 / 缺口」四段式给出，证据均为 `文件:行号`。

### 5.1 canvas —— 吃了「DOM 侧三件」，不吃契约

- **主题适配是真的**：`data-miasaki-theme` 观察（`client.js:405`）→ 读官方令牌（`:249-263`）→ 写 `--canvas-accent`（`app.js:2261`），三主题品牌色由 `themes/zafkiel.skin.css:61` / `kurkuriel.skin.css:61` 提供，pure 走原生蓝。**不是死观察者**。
- **根 README 的「桌面端窗控」失真**：canvas 只有「量窗控组宽度 → 让开位置」（`client.js:269-280`），没有任何 `window.controls` / hash `cmd` 调用。
- **iframe 内降级未做**：壳的 `initialization_script` 注入每个文档，画布 iframe 内**本有** `data-miasaki-theme` 却从不读（主题全靠父页 postMessage 下发）。
- 验收：§3.3 **无验收表**；§3.0 中 canvas 自有 2 项（F1 视觉走查 18 张 / F2 字重决议），**0 勾选**。

### 5.2 sidebar —— 唯一「写入」右上角安全区的一方，且是未承认的活耦合

- **内嵌终端与壳无关**：纯页面内 DOM 面板（`bottom:0` 的 `#miasaki-bottomterm`）+ `node-pty` + 同源 WS（`index.js:695,713`；`client.js:523-524`），原理上在壳里可用。
- **壳耦合只剩 120 行且未申报**：`titlebarButton`（`client.js:1258-1380`）——用 DOM 探针判环境、插按钮、**写壳的内部变量 `--ms-titlebar-reserve`**。而 README `:67-69/:81` 称桌面壳让位「仅作历史存档」，CHANGELOG `:7-8` 称「只剩三处壳时代残留」——**都漏了这一处最大的活耦合**。
- **xterm 主题热切换缺口**：`terminalClient.theme()` 只在一处调用（`client.js:273`），底部面板只挂载一次（`:1159-1162`）⇒ 壳内热切主题后终端配色停在旧主题，须刷新。
- **推挤选择器疑失效**：`client.js:1517` 的 `#root>[data-slot="root"]>div` 在官方源码里查无锚点 ⇒ 底部面板多半退化为纯浮层（未实测运行时 DOM）。
- 验收：C1–C5 **0 勾选**；§3.4 判据表 7 行**无勾选框**（不可计入台账）。

### 5.3 ssh —— 这条链上最成熟的一方（且它的 observer 顺带兜住了 sidebar 的注入）

- **两条真链路**：① 主题走官方令牌桥（`client.js:180-190` 白名单 9 个 `--dsw-alias-*` 令牌 + `data-ds-dark-theme`），
  **三主题全适配（间接）**，`--mia-*` 消费 0 处；② 让位走**运行后实测几何**，两个纯函数
  （`computeChromeClearance` / `computeFabSafeRight`，`app.js:356-388`）覆盖「浮层」与「会话视图中栏」两种挂载，
  跨源 / 顶层窗口天然归零。
- **让位算式经得起核对**：壳窗控组实测 = 徽章 24 + 4 键 104 + gap 8 = **136px**（含 sidebar 的终端键），
  `reserve = innerWidth - rect.left + 6` = **150px**，与矩阵 §3.6 实测 `padding-right = 14 + 150` 逐字吻合；
  口径②量的是**被壳顶左后的官方 DOM 布局几何**（`[data-conversation-header-corner]` / `[data-dockkit-strip-chrome]`），
  不写死 128px ⇒ 壳自绘标题栏造成的位移正是它要测的量。
- **`rootObserver` 是这条链的关键补丁**：B4 的「洞 B」指出「CSS 变量让位线变化不带任何 DOM 变动」
  （对照实测：安全线 156→220 后落点变量一次都没重测，持续重叠 20px）。修法是观察 `documentElement.style`
  （`client.js:725-738`，`WATCHED_ROOT_VARS`）+ 过渡期逐帧跟随 + `transitionend`/`visibilitychange`/`fonts.ready`。
  **这个 observer 顺带兜住了 sidebar 写 `--ms-titlebar-reserve:156px` 的那次注入**——
  ssh 因此不会像 canvas 那样取到陈旧值。
- **浮层压不住壳窗控**：ssh 浮层 `z-index:100`（`client.js:139`）< 壳窗控 `100000`（`03-switcher.js:51`）
  < 主题球 `99990`，同顶层文档 ⇒ 只能被壳盖，不会盖壳。
- **残留**：① B3/B4 的证据是**复刻壳**（`design/CHANGELOG.md:506` 用 addInitScript 复刻 `.tb-group` 5 键 + 156px），
  **真机复验仍挂在待办**（`design/CHANGELOG.md:538`）；② 右下角状态栏（`styles.css:279-290`）**没有底部安全线**，
  主题球（46px + 6px 光晕，right/bottom 16）会压住其右端约 13px；③ `--dsh-ssh-chrome-top/height` 只在
  `syncChrome()` 写（`client.js:346-348`），`rootObserver` 不刷新 ⇒ 可能留旧值（低影响）。
- **契约**：`window.miasakiDesktop` **零消费**，仍靠 `.tb-group` / `.tb-capsule` 双类名探针兜底（`client.js:322-323`）。
- **文档失真 9 处**：README `:159,168,174,187,214` 五处仍称页面由 `conversation.view`(order20) 托管（代码已删）；
  「首帧同源直读不闪底色」只对第二次打开成立（注册表首写时机在 iframe `load`，晚于 `initialTheme()` ⇒ 首次/强刷走
  `matchMedia`，暗色 OS + 亮主题可能闪深色 = A7 未验的根因）；`app.js:74` 的 `--ssh-chrome-avoid-right` 全仓已无；
  数值不一（`design/CHANGELOG.md:546` 记 158px vs 算式 150px）。
- 验收：A1–A16 共 16 项，**仅 A16 勾选**；A7（主题桥接）/ A8（入口去重）/ A12–A15 全未验。

### 5.4 appearance —— 让位协议自洽，但有三处真实缺口

- **让位双向自洽、无功能级死锁**（逐条核对 ①–④）：
  ① 开启皮肤时壳**必定**让位（`02-core.js:317` 置标记；`00-boot.js:248` 让位时只注入 deco、不注入 skin）；
  ② 关闭时壳**必定**收回（`02-core.js:318` 移除标记；`verify-themes.mjs:217-225` 有自动化断言）；
  ③ 无「双让位丢主题」（deco 恒注入 + 外观线 head boot style 独立兜底 `lib/config.js:301-323`）；
  ④ 无「双不让位互覆盖」的**持久**路径（`client.js:182-184` 在「壳在位 + 无 yield 标记」时拒绝注册 overrideTokens，
  `lib/config.js:504-510` 报 `override-conflict`）。
- **三处真实缺口**：
  - **yield 标记在「解析期 → DOMContentLoaded」之间不诚实**：属性写在 document_start（`08-ready.js:2`）与
    DOMContentLoaded（`:10-12`），而 yield observer 到 `08-ready.js:15` 才启动 ⇒ 这段窗口的属性态
    恰是外观线自己定义的「冲突态」（视觉无害，因壳 style 尚未注入，但任意脚本可观测）。
  - **运行期切换有空窗**：开启时壳**先**停注入、外观线**后**（跨 `/state` + `/skin` 两次 fetch）注册
    ⇒ 若本次 head boot style 不含该皮肤（用户刚把 pure 改成皮肤），出现「无皮肤配色」空窗；
    关闭时相反（overrideTokens 是 body inline 最高特异性，短暂双写后才跳回桌面主题）。
  - **`skin = pure` 下表面不透明度四旋钮完全失效**：`client.js:184` 要求 `skin.id !== 'pure' && skin.tokens !== null`
    ⇒ `:209 wantParams = false`；而**盘上配置恰好是 `skin=pure` + 80/80/80/100**
    （`~/.dsh/miasaki-appearance/config.json`，本次实测）⇒ 面板里那四个旋钮转了没反应，
    且 CHANGELOG `:23-25` 与矩阵 `:252` 还在指引用户「降到 60–80」。
- **启动画**：单 webview + `navigate` ⇒ loading 与 splash **不同文档、不可能同框**，与 cross §2 一致；
  C1 = 2.5s 一致（`lib/splash.js:20` ↔ `index.js:163`）。**但**：
  ① 契约 C2 的「行序」≠**渲染后文档序**（head 组紧跟 `<head>`、body 组紧跟 `<body>`，
  功能等价但契约没写明）；
  ② **401 硬用例判据失真**：401 纯文本由鉴权层直出，`index-inject` 根本不渲染 ⇒ 401 文档里**没有 splash**，
  「2.5s 兜底淡出」不可能被触发（矩阵 `:236` 的判据实为「未注入即通过」）；
  ③ 两段启动画**配色来源不同**（loading 跟 `data-miasaki-theme` / splash 跟 `data-mia-skin`）
  ⇒ 桌面主题 ≠ 外观皮肤时，navigate 瞬间纹章/底色会跳色（cross 文档未约定）。
- **材质分层是唯一被消费的「壳说事实」契约**：`data-mia-native-mica`（`12-material.js:40` 首帧必写 on/off，无第三态）
  被 `client.js:672` / `lib/config.js:376-377` 正确消费。
- 验收：D1–D7 共 7 项，**0 勾选**；矩阵自身还自相矛盾（`:235` 说 config v5、`:244` 说 v4，盘上实为 v5）。
- 文档失真 7 条，其中最误导的是 README `:139/:226`「当前只做检测与提示」（M2 早已落地完整协议）。

### 5.5 dual-model / usage —— 两条「与壳解耦」的线，适配方式截然不同

**dual-model：零接触，但有一条未文档化的隐性依赖**

- **对壳注入层零依赖**：全线对桌面设备的探测 **0 命中**（无 UA / `__TAURI__` / DOM 探针 / `miasakiDesktop`）；
  `client.js:394-395` 只注册官方槽位 `conversation.input.right`（id `dual-model`，order 100），
  落在输入框右下角——与壳右上角 chrome **无争用**。
- **与 desktop 线的补丁无重叠包**：`patches/dsh-api-session-controller/README.md:57-65` 自带对照表
  （本补丁 = **host 半** `dsh-api-session-controller`；desktop 六件 = **client 半** `dsh-client-ui-*` + `cordis-host-runner`）
  ⇒ 冲突风险 0。**但两份升级重打清单目前是分开的**，README 只写「建议合并进同一份升级检查清单」
  —— 实测两侧都在线（§2.2），若将来 DSH 升级只重打了 desktop 的六个，dual-model 的准入补丁会静默失效。
- **唯一一处与壳的正面配合**：`themes/src/09-dropguard.js:29-33` 的拖放安全网在 `defaultPrevented` 时
  **主动让位官方 DnD**，dual-model 的拖图上传因此不被壳的全局 `dragover` 拦截
  —— 这是本次审查里少见的「壳为插件预留了正确行为」的例子。
- **补丁 README 的基线表已失真**：`patches/dsh-api-session-controller/README.md:98-101` 仍写
  `0.1.7-alpha.2` / `05DAAAF8…` / `450C25A2…`，与 `patch.mjs:48-52`（rc.2 / `FB0F7B96…` / `40A032EF…`）
  及本次 live 实测**三处全不符**（`repo-review-2026-09-26.md:326` 已列过 P1，至今未改）。
- **官方桌面端那份 DSH 的补丁状态无判据**：`scripts/patch-live-audit.mjs` 只审计 npm 全局安装，
  asar 内副本不可读 ⇒ 无法验证官方那份是否被打。当前因未挂 `desktop` 而无影响，但这是补丁台账的已知盲区。
- **隐性依赖（未写进任何跨线文档）**：dual-model 的图片准入补丁**只对全局 npm 安装生效**；
  官方桌面端读 asar 内自带的 DSH ⇒ 若把 dual-model 挂进官方桌面端，**准入补丁不生效，图片会被官方硬拒**。
  这是「W6 的 10 个插件」在 09-26 被收敛为「只挂 usage」的又一条技术注脚。
- 验收：B1–B3 三项 **0 勾选**；其中 B3「纯文本主模型仍可传图（**不是静默丢图**）」正是根 README 列为
  最高优先未修项之一——**至今没有一次实机记录**。

**usage：唯一「纯官方契约」的线，两条干净经本次实测成立**

- **零 miasaki 耦合声称属实**：全仓 grep `miasaki` 在 usage 内的命中**全部是 profile 名与迁移注释**
  （`lib/index.js:111,997-1006`），无桌面壳探测、无 `__TAURI__`、无 DOM 探针、无主题耦合。
- **profile 分区经实测成立**（本次同时探测两个在线 host，`[实测]`）：

  | host | 端口 | `/dsh-token-monitor/global` 的 `profile` | since | activeDays | totalTokens |
  |---|---|---|---|---|---|
  | **官方桌面端** | 19387 | `desktop` | 2026-09-26 | 2 | 515,702,979 |
  | **自研壳** | 3080 | `miasaki` | 2026-09-05 | 19 | 2,949,195,537 |

  两分区账本各自续写（均在 00:23:55 有写入），`note` 文案一致 ⇒
  **「官方桌面端只记官方消耗」这条硬契约成立**，`web`（浏览器 GUI）为第三个独立分区（20 KB）。
- **profile 解析链**：`profileContext`（宿主服务）→ `DSH_PROFILE` 环境变量 → 兜底，目录名净化；
  历史混合账的一次性归位只在 `miasaki` 分区首次启动且该分区尚无账本时执行（`lib/index.js:1006`）。
- **一处壳 UI 缺口（浮层层级，观感级）**：官方 `shell.overlay` 层的约定是
  `z-index:20; pointer-events:none` + `>*{pointer-events:auto}`；usage 的实现改成
  `position:fixed; inset:0; z-index:50`（`lib/client.js:152`）**脱离了该层**。
  壳的 `#miasaki-titlebar` 是 `z-index:100000`（`03-switcher.js:51`）⇒ 浮窗打开时窗控三键与主题球
  **浮在背板之上**（按钮仍可点——这本就是壳的预期行为，问题在**观感**：浮层"没关进去"）。
  `86vh`（`client.js:153`）在壳里等于 webview 高，可接受；壳不设 `data-windows-titlebar`
  （`themes/src` 零命中）⇒ 无 padding 冲突。
- **一处路径缺口（分区语义未被文档覆盖）**：分区键取自 **host 进程的 profile**
  （`profileContext.name` → `DSH_PROFILE` → `default`，非端口、非 argv），而壳在 3080 已被占用时会
  **「采用」既有后端**（`desktop/src-tauri/src/main.rs:1310-1316`）。若用户先跑了 `dsh web`
  （官方 CLI 的默认 profile 正是 `web`，同为 3080），再启动壳，**壳与浏览器 GUI 会共写同一本账**。
  README 只声明了「官方桌面端 / 自制壳 / 浏览器 GUI 各记各的账」，**未覆盖这条共用路径**。
- 验收：**§3.8 是全矩阵唯一有实测记录的一节**——数据面 5 项 ✅（host 半生效 / 口径隔离 / 分区落盘 /
  历史归位 / 隔离未被破坏），仅剩 2 项**待目视**（侧栏脚部入口、会话「用量」Tab）。
  它是八线里唯一「按台账口径执行过」的线，其余七线合计 42 项全未动。

### 5.6 fleet —— 单向发布、默认关闭、无闸门

- `fleet-pulse.json` v2 的 4 个计数两侧字段**确实对上**（`publish-pulse.mjs:74-84` ↔ `main.rs:1880-1881`），
  时效判据两侧同源（30s，`main.rs:1859` ↔ `cross/ab-linkage-pulse-v2-2026-09-04.md:61-67`）。
- **fleet 侧对自己发布的文件零回读**：读者全仓只有 Rust 一处 ⇒ 写坏零感知。
- **路径无硬编码**（生产端由 `import.meta.url` 推导；消费端只用环境变量），换盘符不断——这点比预期干净。
- **FleetBlocked 不会永久卡住**（`window.rs:311-351` 按当前六态逐帧派生），
  但气泡文案与 DSH 审批**共用同一句「需要你的批准」**（`window.rs:337-338`），语义易混。
- 验收：fleet↔桌宠共 7 项（E2 / G1 / G3 + §4 四行），**0 勾选**。

---

## 6. 实机验收台账现状（`[实测]`）

`cross/smoke-test-matrix.md`：`- [x]` **1** / `- [ ]` **44**（建立于 2026-09-26，次日无变化）。

| 组 | 项数 | 已勾 |
|---|---|---|
| A. SSH（§3.6） | 16 | 1（A16） |
| B. 双模型（§3.10） | 3 | 0 |
| C. Sidebar（§3.4） | 5 | 0 |
| D. 外观（§3.5） | 7 | 0 |
| E. 桌面端（§3.1/§3.2） | 8 | 0 |
| F. Canvas（§3.3） | 2 | 0 |
| G. 跨线联动（§4） | 3 | 0 |

**前置条件**：一次 `dsh web` 重启 + 桌面壳重启 + 浏览器强刷即可同批验完（矩阵 §3.0 已写明）。

---

## 7. 文档失真汇总（本次点名的，按线）

| 线 | 位置 | 失真 |
|---|---|---|
| desktop | `themes/src/10-contract.js:11-14` | 头部纪律「只读 + 不提供写通道」↔ 同文件 v1.1 写能力 |
| desktop | `README.md:399-401`、`design/CHANGELOG.md:3548` | fleet 告警优先级写反（实为等待审批优先） |
| desktop | `README.md:395` | Fleet 指示器未在同一句点明「默认关闭、需环境变量」 |
| canvas | 根 `README.md:11` | 「桌面端窗控」——实为避让，无窗控 |
| canvas | `dsh-miasaki-canvas/README.md:13,21` | 版本停在 .6（实为 .7）；适配段未回写 .3 品牌色修复 |
| sidebar | `README.md:67-69,81`、`design/CHANGELOG.md:7-8,389` | 声称桌面壳耦合「已停用 / 仅历史存档」↔ `client.js:1258-1380` 是活代码 |
| sidebar | `README.md:77` ↔ `:78` | 同页「已实机验证」与「待实机验证」自相矛盾 |
| sidebar | `design/CHANGELOG.md:770` | 兜底 118px ↔ 壳侧现为 128px |
| fleet | `README.md:261-262` | 指向「四线」矩阵且相对路径少一级 |
| fleet | `README.md:209` | 「15/15」陈旧（现 17 项） |
| fleet | `cross/ab-linkage-pet-fleet-status-2026-08-18.md` | 整份契约字段在 v2 里一个都不存在，仍挂 Draft |
| fleet | `cross/ab-linkage-pet-fleet-status-impl-2026-08-30.md:16-18,63` | 称「本期不实施」——已被 09-04/09-07 实现推翻 |
| dual-model | `patches/dsh-api-session-controller/README.md:98-101` | 基线表仍写 `0.1.7-alpha.2` / `05DAAAF8…` / `450C25A2…`，与 `patch.mjs:48-52`（rc.2 / `FB0F7B96…` / `40A032EF…`）及本次 live 实测**三处全不符** |
| dual-model | `README.md:56-60`、`README.md:12-25` | 安装节只写 `web` profile（未记已装 `miasaki`）；自陈「真实 GUI 实测可用」与根 README「待实机验证」口径不一 |
| usage | `README.md:171` | 写 `minmax(300px,380px) 1fr`，实为 `minmax(0,1fr) minmax(0,1.15fr)`（`lib/client.js:75`）；其 CHANGELOG `:28-29` 自列「待订正」至今未改 |
| usage | `README.md:13-17` | 「不与自制壳 / 浏览器 GUI 混账」未覆盖「壳采用外部 3080 后端」这条共用路径（见 §4-⑨） |
| shared | `cross/official-desktop-adoption-plan-2026-09-25.md:18,200` | W6「10 个插件挂进官方 profile」已被 09-26 收敛口径取代，未标取代 |
| 全局 | 根 `README.md` | 已知 30+ 处「当前态失真」中的上述条目仍未订正 |

---

## 8. 建议的下一步（按优先级，具体到文件）

**P0（机制缺口，修一次管一类）**

1. **给右上角安全区立一份契约并统一取数口径**（`desktop-contract.md` 新增一节）：
   - 变量与挂载点（`--ms-titlebar-reserve`、`#miasaki-titlebar .tb-group`）**登记进契约面**，写清「谁可以写、写多少、读者怎么重测」；
   - `canvas/client.js:269-280` 照搬 ssh 的 B4 修法（观察 `documentElement.style` + `.tb-group` 子节点，或直接改为读 `--ms-titlebar-reserve`），删掉「无需监听」的前提注释；
   - `sidebar/client.js:1299` 的 156px 改为**量测实宽**（旧 `measureChromeReserve` 曾存在，2026-09-11 清理中删除）。
2. **补一道跨线契约闸门**（`scripts/verify-all.mjs` 的 `repo` 段）：
   新增 `check-pulse-contract.mjs`——用 fleet 真发布的 `fleet-pulse.json` 作为输入，
   断言「生产字段集 ⊇ 消费读取字段集」，并把 `main.rs:1878` 的 `unwrap_or(0)` 改为「缺键即拒绝整份 + 记日志」。
3. **给 `MIASAKI_FLEET_PULSE` 加回退定位**（`main.rs:1853-1855` + `desktop/README.md:395`）：
   exe 旁 / `%LOCALAPPDATA%\miasaki\` 配置项（草案 §5 阶段 1 本就如此要求），否则联动在实机上等于不存在。

**P1（让契约真正被消费）**

4. `canvas/client.js:400-406`、`sidebar/client.js:1270`、`ssh/client.js:322` 三处 DOM 探针
   改为「`window.miasakiDesktop` 探测优先 + DOM 兜底」——**这是契约 v1.1 的第一个消费者**，
   同时把 desktop 线从「自产自销」里救出来。
5. `themes/src/10-contract.js` 头部纪律同步 v1.1（消掉文件内自相矛盾）。
6. 官方桌面端 profile 的 `node_modules` 残留清理（9 个死副本），或在 README 注明「残留不加载」。

**P2（体验与文档）**

7. sidebar 的 xterm 主题热更新（监听主题变更后重设 `term.options.theme`）。
8. FleetBlocked 独立气泡文案（`window.rs:337-338`），与 DSH 审批区分。
9. 逐条订正 §7 的文档失真；`cross/ab-linkage-*` 两份旧稿加 `Superseded` 横幅。
10. 执行 §6 的实机台账（一次重启可同批验完），优先 E2/E3/E4（桌面壳自身）与 C4（底部终端）、G1（fleet 联动）。
11. **补丁台账收口**：把 dual-model 的准入补丁与 desktop 六件**合并进同一份「DSH 升级后重打」清单**
    （现状两份分开 ⇒ 只重打六个会让图片准入静默失效）；订正 `patches/dsh-api-session-controller/README.md:98-101`
    的基线表（三处数值全错）；`scripts/patch-live-audit.mjs` 对 asar 内副本无判据，至少在报告里写明这一盲区。
12. **usage 口径文档补两句**：① 浮窗层级与壳 chrome 的关系（观感级，可不动代码）；
    ② 「一本账 = 一个 host profile，多客户端共用」——覆盖「壳采用外部 3080 后端」这条路径（§4-⑨）。

---

## 9. 未验证项（需真机或运行 host，本轮只读审查覆盖不到）

1. 三方让位链的**运行时实宽**：`.tb-group` 在 sidebar 注入后到底是 108+28 还是别的值；canvas 的 `--canvas-chrome-reserve` 实际下发值。
2. sidebar 的 `#root>[data-slot="root"]>div` 推挤选择器在实装 0.1.7-rc.2 DOM 上是否命中（仅在 vendor alpha.2 里查无锚点）。
3. 壳内真机 `Ctrl+\`` 与 WebView2 / 输入法冲突（既有证据只有无头 CDP 模拟）。
4. 三主题 × 明暗下：canvas 品牌色实时跟随、底部终端配色、用量浮窗定位（自绘标题栏下）的观感。
5. 让位态（`data-miasaki-theme-yield="skin"`）下切皮肤能否唤醒 canvas（依赖同值 `setAttribute` 是否产生 mutation 记录）。
6. 双模型「静默丢图」闭环（矩阵 §3.10 判据 B3）——至今无实机记录。
7. 官方桌面端 `desktop` profile 的「只挂 usage」**已实测生效**（19387 的 `/dsh-token-monitor/global` 200 且
   `profile=desktop`）；仍未验证的是**那 9 个残留死副本会不会被任何加载层读到**（profile 清单层面已排除），
   以及 §3.8 剩下的 2 项**视觉确认**（侧栏脚部入口 / 会话「用量」Tab）。
