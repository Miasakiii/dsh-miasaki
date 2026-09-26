# 跨线方案 · 桌面端适配整改（2026-09-27）

> **状态：A 批（T1–T5）与 B 批 T7 已于 2026-09-27 实施完毕；T6 未做**（用户当日拍板三项：
> A 批开工、fleet 加回退定位、先做 D1+D2 实机验收）。实施结果见 §12。
> **上游**：[全线审查报告](../repo-review-2026-09-27.md)（八线适配现状 + 9 条跨线缺陷 + 14 处文档失真）。
> **本稿回答**：审查发现的问题里，**哪些该修、以什么顺序修、落在哪个文件、怎么验收、哪几处需要你拍板**。
> **不改的**：各线自己的功能路线图（appearance M4 / ssh U3 / canvas 等）不在本稿范围，见 §10 的衔接说明。

---

## 0. 摘要：一个判断、三条主线、四批落地

**一个判断** `[事实]`：审查暴露的根本问题不是「某条线适配得不好」，而是——

> **壳与插件之间的契约面已经从 1 项长到 12 项，但只有 1 项被文档化，而恰恰是那一项零消费。**

真正在用的 8 项（`data-miasaki-theme`、`data-miasaki-theme-yield`、`data-mia-*`、`--ms-titlebar-reserve`、
`#miasaki-titlebar .tb-group`、`#miasaki-switcher .ms-btn`…）全部是**隐式契约**：
靠源码注释活着，改名即静默失效，且**同一个事实有三方各自取数**（§2.1）。

所以整改的主线不是「给每条线补适配代码」，而是**把已经在用的隐式契约显式化**，
再用闸门把它钉住。三条主线：

| 主线 | 内容 | 解决审查里的哪几条 |
|---|---|---|
| **一 · 契约显式化** | 壳成为 `--ms-titlebar-reserve` 的唯一写者；契约 v1.2 增量提供 `chrome.bounds()`；canvas / ssh / sidebar 三处改造 | §4-①（右上角三方争用）、§3（契约零消费） |
| **二 · 装闸门** | `check-pulse-contract.mjs`（跨线字段契约）+ `MIASAKI_FLEET_PULSE` 回退定位 + `unwrap_or(0)` 收紧 | §4-②（跨线零闸门）、§4-④（联动默认关闭） |
| **三 · 验收可执行** | 44 项台账按「重启依赖」聚类成 4 批，每批有前置、判据、记录口径 | §4-③（实机 1/44） |

**四批落地**：A 契约与让位（一次提交，不可拆）→ B 闸门与联动 → C 文档与小修 → D 实机验收（人工）。

---

## 1. 设计原则（三条，改之前先读）

1. **壳说事实、插件选分支** —— 已经在 `12-material.js` 验证过的分工模式（壳广播材质事实、外观线选 CSS 分支）。
   本稿把同一模式推广到「壳 chrome 几何」：**壳提供矩形，避让量由各插件自己算**
   （各自 gap 不同：canvas 6px、ssh 6+8px，壳无权替它们决定）。
2. **不要为「可能将来有人用」加能力** —— 契约 §3 纪律①「能力表即事实」。
   本稿新增的 `chrome.bounds()` **当场就有三个消费者**（T3/T4/T5），不是占位。
3. **改动一次到位、不留双写过渡** —— `--ms-titlebar-reserve` 一旦由壳自动计算，
   sidebar 的写入必须**同批删除**（双写不会坏，但会掩盖问题）。

---

## 2. 主线一 · 契约显式化

### 2.1 问题的精确形状（先看清，否则会修错地方）

右上角「距窗口右缘 8–116px、高 11–37px」这一带，目前是**三方各自为政**：

```
                      ┌─ 写 ─────────────────────────────────────────┐
  sidebar/client.js:1299   documentElement.style.setProperty('--ms-titlebar-reserve','156px')  ← 硬编码
  sidebar/client.js:1294   把 #miasaki-tb-terminal 插进 .tb-group 首位                          ← 改宽度
                      └──────────────────────────────────────────────┘
                      ┌─ 读 ─────────────────────────────────────────┐
  壳 03-switcher.js:90     header{padding-right:var(--ms-titlebar-reserve)}
  壳 03-switcher.js:110    dockkit strip{margin-right:calc(var(…)-6px)}
  ssh client.js:725        WATCHED_ROOT_VARS 观察 documentElement.style → 重测 ✅
  canvas client.js:269-280 量 .tb-group 一次，注释断言「宽度固定，无需监听」 ❌
                      └──────────────────────────────────────────────┘
```

**三个数、三种语义、零协调**：壳默认 128px（= 组宽 108 + 8 right + 12 呼吸）、
sidebar 覆写 156px（= 108+28）、ssh 实算 150px（= 组宽 136 + 8 + 6）。

**关键洞察** `[事实]`：`156 = 108 + 8 + 12 + 28` 与 `156 = 136 + 8 + 12` **完全等价**——
sidebar 的硬编码 156px 其实就是在替壳做「组宽 + 8 + 12」这道算术。
**让壳自己算，sidebar 就不用写了**。这就是 T1。

### 2.2 T1 · 壳成为 `--ms-titlebar-reserve` 的唯一写者

| 项 | 内容 |
|---|---|
| **落点** | `dsh-miasaki-desktop/themes/src/06-titlebar.js` 的 `buildTitlebar()`（`:159-192`，`document.body.appendChild(bar)` 于 `:174` 之后） |
| **做法** | 对该分片新挂一个 `ResizeObserver` 观测 `.tb-group`；回调写 `document.documentElement.style.setProperty('--ms-titlebar-reserve', Math.round(w + 8 + 12) + 'px')`。常量含义：`8` = `.tb-group` 的 `right`（`03-switcher.js:60`），`12` = 与官方控件的呼吸位（由 128−108−8 反推） |
| **兜底** | `03-switcher.js:89` 的 `:root{--ms-titlebar-reserve:128px}` **保留**——ResizeObserver 不可用 / 未触发时仍是原来那个值；inline style 优先级更高，会自动覆盖 |
| **为什么放在壳而不是继续让 sidebar 写** | ① 注入方数量无上限（注释 `client.js:1265` 自陈「其他注入方都往 brand 紧前插」）；② 每多一个注入方，sidebar 都要改一次硬编码——它已经改过一次（118 → 156） |
| **边界** | 该分片是**寄生分片**（`00-boot.js:7` 的 IIFE 内），新增代码必须留在既有分片内，**不新增分片**（纪律见 `desktop-contract.md` §4.5-6） |
| **验收** | ① `verify-themes.mjs` 增加断言「注入 1 个额外按钮后 reserve 自动 +28」；② 实机：删掉 sidebar 的写入后，官方会话头 padding-right 仍为 156 |

### 2.3 T2 · 契约 v1.2 增量：`chrome.bounds()`

| 项 | 内容 |
|---|---|
| **落点** | `dsh-miasaki-desktop/themes/src/10-contract.js`（现有 `CAPABILITIES` 在 `:102-106`）+ `design/desktop-contract.md` |
| **新增能力** | `chrome.bounds()` → `{ left, top, right, bottom, width, height }`（视口坐标，量不到返回 `null`）；`chrome.onChange(cb)` → 退订函数（由 ResizeObserver 驱动） |
| **能力名** | `chrome.bounds` / `chrome.onChange`（沿用现有命名风格 `theme.onChange` / `window.maxState.subscribe`） |
| **版本语义** | **`protocolVersion` 仍为 1** —— 按 `desktop-contract.md` §4（2026-09-25 修正）：「只在破坏性变更时提升，增量能力只追加 `capabilities` 条目」 |
| **不做什么** | ① 不提供「官方 DOM 位置」——那是 DSH 的资产，壳无权代理（ssh 的口径②继续自己量，见 T4）；② 不改纪律③「子 frame 只给空壳」——iframe 内的插件**本来就不直接量壳 chrome**（canvas/ssh 都是主帧量完、postMessage 下发，见 `canvas/client.js:279`、`ssh/client.js:346`），无需开口子 |
| **闸门** | `themes/test/contract.test.js` 既有「能力表声称的每一项在暴露面上真实存在」的逐项核验会自动覆盖新能力；再补 2 例：量不到时返回 `null`（子 frame / 无按钮组）、`onChange` 退订后不再回调 |
| **首帧可用性** | `buildTitlebar()` 在 `onReady()` 里跑，早于插件 client 装载 ⇒ 插件装载时 `bounds()` 已有值；`onChange` 兜住「sidebar 后注入按钮」这一刻 |
| **验收** | DevTools（DSH 页）：`window.miasakiDesktop.has('chrome.bounds') === true`；`chrome.bounds().width` ≈ 108（无 sidebar 键）/ 136（有键）；SSH / 画布 iframe 内 `chrome === undefined` |

### 2.4 T3 · canvas 消费契约（并修掉「无需监听」的错误前提）

| 项 | 内容 |
|---|---|
| **落点** | `dsh-miasaki-canvas/client.js:265-280` 的 `syncChrome()` |
| **改法** | 契约优先 → `var d = window.miasakiDesktop; if (d && d.has('chrome.bounds'))` 时用 `innerWidth - d.chrome.bounds().left + 6`，并在初始化时 `d.chrome.onChange(syncChrome)`（退订挂到既有 `dispose`）；否则**保留现有 DOM 探针**作为浏览器 / 旧壳兜底 |
| **必须删掉的** | `:268` 那句「按钮组宽度与 right 偏移固定，不随窗口尺寸变化，故无需监听 resize」——**前半句是错的**（sidebar 会插按钮），后半句只对窗口尺寸成立 |
| **验收** | ① 单测：喂一个 fake `miasakiDesktop`，断言 `canvas:chrome` 下发的 reserve 正确、且 `onChange` 触发重发；② 实机：先开画布、再让 sidebar 注入终端键，画布工具条不叠压（当前会少让 28px） |

### 2.5 T4 · ssh 口径① 消费契约（口径② 不动）

| 项 | 内容 |
|---|---|
| **落点** | `dsh-miasaki-ssh/client.js:317-354`（壳窗控口径 `shellReserve`）、`:725-738`（`rootObserver`） |
| **改法** | 口径①（壳窗控组）改走 `miasakiDesktop.chrome.bounds()`；**口径②（量官方 `[data-conversation-header-corner]` / `[data-dockkit-strip-chrome]`）保持原样**——那不是壳的资产 |
| **保留** | `rootObserver` 与逐帧跟随**不删**——它今天兜住的是「官方 chrome 随 `--ms-titlebar-reserve` 平移」，
契约化口径①之后它仍要盯官方那一侧；两者不是替代关系 |
| **验收** | 现有 `test/client.test.js:774` 的无头复刻壳用例（复刻 `.tb-group` + `--ms-titlebar-reserve`）改为**同时**喂一个 fake 契约对象，断言两条口径都成立；真机项并入批 D |

### 2.6 T5 · sidebar 停止写壳的内部变量

| 项 | 内容 |
|---|---|
| **落点** | `dsh-miasaki-sidebar/client.js:1299`（写 156px）与 `:1378`（removeProperty）——**两处都删** |
| **保留** | `titlebarButton` 整体（插按钮是正当功能，且壳的 click 委托已正确忽略 `data-act="miasaki-terminal"`，见 `06-titlebar.js:176-187`） |
| **顺带修的** | README `:67-69/:81` 与 `design/CHANGELOG.md:7-8` 声称「桌面壳耦合已停用 / 仅历史存档」——**与实际不符**，改准（这是审查 §7 的一行） |
| **验收** | ① 单测：断言 sidebar 源码**不再出现** `--ms-titlebar-reserve`（防回潮）；② 实机：终端按钮在、官方会话头右边距仍正确（由 T1 保证） |

### 2.7 批 A 的提交边界与中间态

**T1–T5 必须同批提交**。理由：T1 落地后若 sidebar 仍写 156px，两者会**双写同一个 inline 变量**——
结果相同（都是 156）但语义已分叉；一旦以后按钮宽度变化，sidebar 的硬编码会把它钉死。
反过来若先删 sidebar 的写入而没做 T1，reserve 会永久停在 128px，官方控件被窗控压住 ⇒ **真回归**。

---

## 3. 主线二 · 给跨线契约装闸门

### 3.1 T6 · `check-pulse-contract.mjs`（新增，挂 `repo` 段）

**要防的事** `[事实]`：把 `publish-pulse.mjs` 里的 `running` 改名成 `active`，两侧回归**全绿**，
桌面端 `unwrap_or(0)`（`main.rs:1878`）静默按 0 ⇒ 桌宠「该亮不亮」，没有任何红灯。

| 项 | 内容 |
|---|---|
| **落点** | 新增 `scripts/check-pulse-contract.mjs`，注册进 `scripts/verify-all.mjs` 的 `repo` 段（现有 2 项 → 3 项） |
| **输入** | ① **生产集**：跑一次 `dsh-miasaki-fleet/workers/pulse/publish-pulse.mjs` 取真实输出（或复用 `verify-all` 里已 publish 的那份文件）；② **消费集**：从 `desktop/src-tauri/src/main.rs:1860-1900` 抽取消费字段名 |
| **断言** | `消费集 ⊆ 生产集`；且 `v` / `ts` 这类协议字段必须在两侧同时出现。失败时打印「消费了但没人生产」的具体字段名 |
| **抽取方式** | 消费端用正则抽 `pulse.get("…")` / `pulse["…"]` 形式的字面量；**若 Rust 侧写法变化导致抽不到，闸门必须 `exit 1` 而不是静默通过**（`// guard-ok` 豁免不适用于此） |
| **配套改代码** | `main.rs:1878` 的 `unwrap_or(0)` → 缺键即**拒绝整份**并记一行日志（消掉静默失亮） |
| **不做** | 不引入 ajv / 不消费 `schemas/pulse.schema.json`（它目前无消费者；要不要接它是另一件事，本稿不顺手扩大范围） |
| **验收** | 故障注入：把 `publish-pulse.mjs` 的 `running` 改名 → 闸门 `exit 1` 并点名；改回 → `exit 0` |

### 3.2 T7 · `MIASAKI_FLEET_PULSE` 回退定位

| 项 | 内容 |
|---|---|
| **现状** | `main.rs:1853-1855` 只读环境变量、无默认值无回退；本次实测用户级/机器级/进程级**全未设置** ⇒ 桌宠 fleet 指示器**从未真正工作过**（`desktop/design/CHANGELOG.md:2577` 早有记录） |
| **做法** | 三级回退：**环境变量** → `%USERPROFILE%\.dsh\miasaki-desktop\config.json` 的 `fleetPulsePath` → 无（保持静默关闭） |
| **为什么不用 exe 旁** | 壳是安装到 `Program Files` / 用户目录的，exe 旁不可写；`.dsh\miasaki-desktop\` 已经有 marker 文件先例（W3 的 `background-close-confirmed`） |
| **文档** | `desktop/README.md:395-401` 补一句「默认关闭 + 两种开启方式」；顺带订正 `:399-401` 的**优先级写反**（实为「等待审批 > fleet 告警」，见 `window.rs:157` + `model.rs:82-83`） |
| **验收** | 不设变量 → 静默关闭（行为不变）；写配置文件 → 桌宠 fleet 指示生效（并入批 D 的 G1） |

---

## 4. 主线三 · 实机验收的可行组织（T8）

44 项一次性验完不现实。按**重启依赖**聚类，每批只付一次重启成本：

| 批 | 前置 | 项 | 数量 | 预计 |
|---|---|---|---|---|
| **D1 桌面壳自身** | 桌面壳重启 | E1–E8（§3.1/§3.2）+ G1–G3（跨线） | 11 | 30 min |
| **D2 页面侧三线** | `dsh web` 重启 + 浏览器强刷 | C1–C5（sidebar）+ D1–D7（外观）+ F1–F2（canvas） | 14 | 60 min（F1 是 18 张视觉走查，占大头） |
| **D3 SSH 真机** | 一台真实 Linux 主机 | A1–A15 | 15 | 60 min（可用本次 A16 的基座 `_refs/scripts-archive/ssh-a1-live/`） |
| **D4 双模型** | 一个支持图片的模型 | B1–B3 | 3 | 15 min |

**记录口径**（沿用矩阵 §3.0 的既定规则）：验完把 `- [ ]` 改成 `- [x]`，行尾补日期与一句结论，
可指向截图/日志路径。**不要**在 §3.x 的判据表里另起勾选位（矩阵已经因为「判据表无勾选框」而不可度量过一次）。

**建议顺序**：D1 → D2（这两批能覆盖「文档失真最集中的部分」）→ D4 → D3（最重、依赖外部主机）。

---

## 5. 落地批次总表（含依赖与提交边界）

| 批 | 任务 | 依赖 | 提交边界 | 工作量 |
|---|---|---|---|---|
| **A** | T1 壳自动 reserve · T2 契约 v1.2 · T3 canvas · T4 ssh · T5 sidebar | 无 | **一次提交**（五件不可拆，见 §2.7） | 3–4 h |
| **B** | T6 闸门 + `unwrap_or(0)` 收紧 · T7 fleet 回退定位 | 无（与 A 并行） | 可拆两次提交 | 2–3 h |
| **C** | T9 文档订正（14 处 + 2 处 cross）· T10 壳侧小修 | A / B 落地后（文档要写最终态） | 一次提交 | 1.5 h |
| **D** | T8 实机四批 | A / B / C 全部落地 | 勾选即提交（或并入 C） | 2.5–3 h（人工） |

**A 批的必跑闸门**（任一红即不提交）：
```
cd dsh-miasaki-desktop && npm run gen-init      # 重生成 injected/theme-init.js（含令牌完备性校验）
node scripts/verify-all.mjs desktop             # 含 contract 闸门 + 语法闸门 + cargo test
node scripts/verify-all.mjs canvas sidebar ssh  # 三条被改造的线
node scripts/verify-all.mjs repo                # silent-guards（新代码不得引入静默降级）
```

---

## 6. 逐项细则速查（A 批改哪些文件）

| # | 文件 | 改动 | 行数级 |
|---|---|---|---|
| T1 | `dsh-miasaki-desktop/themes/src/06-titlebar.js` | `buildTitlebar()` 末尾 +ResizeObserver 写 reserve | +18 / −0 |
| T2 | `dsh-miasaki-desktop/themes/src/10-contract.js` | +`chrome.bounds()` / `chrome.onChange()`；`CAPABILITIES` +2 条；头部纪律同步 v1.1/v1.2（顺带修审查 §4-⑦） | +40 / −4 |
| T2 | `dsh-miasaki-desktop/themes/test/contract.test.js` | +2 例（null 降级 / 退订） | +30 |
| T2 | `dsh-miasaki-desktop/design/desktop-contract.md` | §2 契约面 + §7 变更记录（v1.2 增量） | +15 |
| T2 | `dsh-miasaki-desktop/scripts/verify-themes.mjs` | +1 断言（注入按钮后 reserve 自动跟随） | +12 |
| T3 | `dsh-miasaki-canvas/client.js` | `syncChrome` 契约优先 + 订阅；删错误注释 | +14 / −4 |
| T3 | `dsh-miasaki-canvas/test/*` | +1 例（fake 契约下 reserve 正确 + onChange 重发） | +35 |
| T4 | `dsh-miasaki-ssh/client.js` | 口径① 契约优先；`rootObserver` 保留 | +12 / −6 |
| T4 | `dsh-miasaki-ssh/test/client.test.js` | 复刻壳用例喂 fake 契约 | +20 |
| T5 | `dsh-miasaki-sidebar/client.js` | 删两处 `--ms-titlebar-reserve` 写入 | +0 / −6 |
| T5 | `dsh-miasaki-sidebar/test/*` | +1 例（源码不得再出现该变量名） | +12 |
| T5 | `dsh-miasaki-sidebar/README.md`、`design/CHANGELOG.md` | 把「已停用/历史存档」改准 | 2 处 |

---

## 7. 不做清单与理由

| 项 | 理由 |
|---|---|
| **提升 `protocolVersion` 到 2** | 本次全是增量能力，按契约 §4 语义不需要；提升了反而逼所有插件写版本分支 |
| **让契约提供「官方 DSH chrome 位置」** | 那是官方资产，壳无权代理；ssh 的口径②继续自量（它当前实现正确） |
| **改纪律③：让子 frame 也拿到 `chrome`** | 不需要——canvas/ssh 都是**主帧量、iframe 消费**，实测代码路径如此（`canvas/client.js:279`、`ssh/client.js:346`） |
| **把 `data-mia-*` 系列改名为 `data-miasaki-*`** | 外观线的 boot style 在**解析期**依赖这些属性名（`12-material.js` 注释 §「为什么属性要尽早落」），改名会同时触碰首帧链路；收益只是命名整齐 |
| **给 usage 浮窗提高 z-index / 改层级** | 壳 chrome 永远在最上层是**有意设计**（窗控必须可点）；那是观感级问题，正确做法是浮窗自己留安全区（ssh 已用 padding 做过）。**留作 P2 备选**，本稿不动 |
| **消费 `schemas/pulse.schema.json`（引 ajv）** | 它无消费者是既成事实；T6 用「真实产物 vs 消费字段集」更直接，且零新依赖 |
| **批量转换存量 CRLF / 引 lint 工具链** | 与本次整改无关，且会淹没真实改动（`.editorconfig` 已覆盖编辑器约定） |

---

## 8. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 改壳注入层导致主题/标题栏异常 | 高（影响启动） | 分片内改动、`gen-init` 令牌完备性校验 + 语法闸门 + 契约闸门三重；`theme-init.js` 是构建产物，回滚 = 回退源码后重跑 `gen-init` |
| ResizeObserver 在旧 WebView2 不可用 | 低 | CSS 兜底 128px 保留；`try/catch` 包裹（壳注入层的既有纪律） |
| reserve 自动计算与官方控件错位 | 中 | `12 + 8` 两个常量从现状反推（108→128、136→156 双向验证），T1 的 `verify-themes` 断言钉住 |
| 契约新增能力但插件没跟上 | 低 | T3/T4/T5 同批落地；契约纪律①要求「能力表即事实」，`contract.test.js` 逐项核验暴露面 |
| 闸门正则抽取 Rust 字段名失效 | 中 | 抽不到即 `exit 1`（不静默通过）；这是 T6 的硬要求 |
| 双写 / 半改状态 | 中 | §2.7 的提交边界：T1–T5 一次提交 |

---

## 9. 需你拍板的决策点

| # | 决策 | 我的建议 |
|---|---|---|
| **D1** | 是否接受「**壳成为 `--ms-titlebar-reserve` 的唯一写者**」（要改壳的注入层 + 重跑 `gen-init`）？ | **接受**。它是消除三方争用的唯一干净解，且顺带让 sidebar 不再需要硬编码 |
| **D2** | 契约新增 `chrome.bounds()` 走**增量**（`protocolVersion` 仍为 1）还是顺带升到 2？ | **增量**。符合契约 §4 既有语义，且不让旧插件被迫写版本分支 |
| **D3** | fleet 联动怎么办：**加回退定位让它真能用**，还是**明确保持默认关闭**（只做文档）？ | **加回退**。当前状态是「功能写了但从没生效」，比「明说不做」更糟；若你根本不用 fleet，选后者也行——但请在 README 写明 |
| **D4** | 实机验收四批（§4）**什么时候**做？需要你在场操作壳/`dsh web` 重启 | 至少先做 **D1 + D2**（25 项，覆盖文档失真最集中的部分） |
| **D5** | usage 浮窗被壳 chrome 覆盖（观感级）**要不要修**？ | **暂不修**。壳 chrome 常驻可点是有意设计；真要在意，用 ssh 式 padding 让位，属 P2 |
| **D6** | 是否接受「**A 批一次提交含 5 个任务**」（跨 5 条线的改动在一个 commit 里）？ | **接受**。它们是同一契约改造的不可分片（§2.7）；若你偏好按线拆，也可以先合 T1+T2（壳/契约）再合 T3–T5（消费方），**但中间态不得发布** |

---

## 10. 与其他路线图的衔接（本稿不重复各线既有规划）

| 线 | 该线自己的下一步 | 与本稿的关系 |
|---|---|---|
| appearance | P3 M4 会话效果 → P4 恢复默认 → P5 导入导出 | **独立**。本稿只顺带修审查发现的两处：`skin=pure` 下表面旋钮失效（`client.js:184`）、运行期切皮肤空窗；M4 不受影响 |
| ssh | U3 跳板 / 端口转发 | **独立**。T4 只动让位取数口径，不碰 U3 |
| canvas | V1–V4 视觉走查（F1）| **互补**。T3 修的是叠压，F1 验的是视觉，两者都在批 D2 |
| sidebar | 审查 tab M2（辅助对话）| **独立**。T5 只删两行写入 |
| desktop | `design/TODO.md` 的挂起取证 / 自更新路线 | **交叉**。T1/T2 动注入层，与 TODO 里的注入层议题（`__DSH_BOOT_READY__` 闸门可行性）同域，建议 T2 落地后回写 `design/TODO.md` |
| fleet | G0–G4 图工程判定层 | **交叉**。T6 的闸门模式（真实产物 vs 消费字段集）可复用到 fleet↔桌宠以外的跨线契约 |

---

## 11. 本稿的验证方式（设计稿自身的自证）

- 所有「现状」断言都指向上游审查报告的证据行号，未新增未取证的说法；
- T1 的常量 `8 + 12` 由**双向反推**得出（108→128、136→156），两处独立验证；
- T2 的 `protocolVersion` 决策引契约 §4 原文，不是我的判断；
- T3 的「必须删掉的注释」直接引用 `canvas/client.js:268` 原句；
- §7 的不做清单逐条给了理由，其中两条（子 frame、DSH chrome 代理）是**推翻我自己在审查时的初步设想**后的结论。

---

## 12. 实施结果（2026-09-27 当日收口）

**全量回归**：`node scripts/verify-all.mjs` —— sidebar **11/11**、canvas **13/13**、fleet **17/17**、
desktop **33/33**（含 `cargo test` **86 例**）、ssh **31/31**、dual-model **12/12**、appearance **18/18**、
usage **3/3**、repo **2/2** —— **九类全 PASS**（合计 140 项检查）。

| 任务 | 状态 | 关键交付 | 验收证据 |
|---|---|---|---|
| T1 让位量归壳 | ✅ | `06-titlebar.js` 挂 `ResizeObserver` 写 `--ms-titlebar-reserve`（壳成唯一写者） | `verify-themes` 新增 2 项端到端断言，**实跑 23/23 PASS**（注入一格按钮 99→127 ⇒ reserve 119→147，即 +28） |
| T2 契约 v1.2 | ✅ | `chrome.bounds()` / `chrome.onChange()`；`protocolVersion` 仍为 1 | `contract.test.js` **15 → 19 例**；补「未知命名空间即失败」守卫 |
| T3 canvas 消费 | ✅ | 契约优先 + DOM 兜底 + 订阅/退订；删掉「无需监听」错误前提 | `verify-all canvas` 13/13；单测 100 → **105 例**；4 组突变逐条被打红 |
| T4 ssh 口径① | ✅ | 口径①契约化；**口径②与 `rootObserver` 不动** | `verify-all ssh` 31/31；`client.test.js` 38 → **43 例**；顺带修掉夹具一个假阴性 |
| T5 sidebar 停写 | ✅ | 删两处 `--ms-titlebar-reserve` 写入；按钮功能保留 | `verify-all sidebar` 11/11；单测 62 → **64 例** |
| T7 fleet 回退 | ✅ | 三级回退（环境变量 → `%LOCALAPPDATA%\miasaki\config.json` → 关闭）；订正 README 里写反的优先级 | `cargo test` +1 例（六种坏输入安全 None） |
| **T6 跨线闸门** | ❌ **未做** | `check-pulse-contract.mjs` 未落地 —— 跨线字段漂移仍无自动断言（审查 §4-②） | — |
| T8 实机验收 | ⏳ 待人工 | 台账新增 **E9**；矩阵 §3.1 新增判据行 | 需一次桌面壳重启 + 一次 `dsh web` 重启 |

**实施中额外发现并修掉的两件事**（不在原方案里）：

1. **`verify-themes.mjs` 在 P10 之后已经跑不完了** —— 未鉴权页面的 `localStorage` 访问被拒会抛
   SecurityError **崩掉整个脚本**（此前它一项都验不到，因为脚本不在自动回归里所以没人发现）。
   改为该项 `skip`、其余照跑 ⇒ 恢复可用（23/23）。
2. **闸门假阳性** —— 该脚本的无头 Edge profile 原落在工作区 `.edge-test-profile/`（747 文件 / 34MB），
   而 `check-silent-guards.mjs` 按目录遍历、**不读 `.gitignore`** ⇒ 全量回归凭空报「190 处新增静默降级」。
   已把 profile 改到系统临时目录 + 在 `SKIP_DIRS` 兜一道。**假红比不红更糟**：它会训练人忽略闸门。

**未做/未验**（如实登记）：T6；E9 与 §4 的四批实机验收（D1+D2 共 25 项，一次重启可同批）；
T4 的实机位（真机壳内 B4 零叠压，此前证据是复刻壳）。
