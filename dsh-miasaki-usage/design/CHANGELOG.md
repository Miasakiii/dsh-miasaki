# dsh-miasaki-usage（第八线）变更记录

本线只承载一个包：`dsh-token-monitor`（Token 用量统计）。**2026-09-26 之前的变更历史不在本文** ——
该插件当时是桌面端线的内置插件，历史条目见
[`../../dsh-miasaki-desktop/design/CHANGELOG.md`](../../dsh-miasaki-desktop/design/CHANGELOG.md)
（按 `token-monitor` / `用量` 检索，覆盖 2026-08-30 立项到 v0.5.2 的全部迭代）。

---

## 2026-09-26（深夜）· client 装载闸门的「第 3 项」从死代码变回防线

仓库级死代码审计在本线只发现一处真冗余：`scripts/verify-client-bundle.mjs`（本线唯一 L0 装载闸门，
`verify-all.mjs:446` 直接调用）里躺着两个**从未被调用**的扫描器：

- `scanTemplateLiterals(src)`（58-111）：完整的逐字符状态机（`code / single / double / template / lineComment /
  blockComment`，处理 `\`` 与 `\${` 嵌套），返回裸反引号行号 —— 写好了但零调用；
- `reportTemplateHint(src)`（115-140）：半成品（两个分支体完全相同、`inTpl` 只写不读、无返回值）——
  显然是上一版被放弃的草稿，同样零调用。

后果是脚本头部注释声称「做三件事」而实际只做两件：历史事故（2026-09-10，CSS 注释里的反引号在模板字符串内部
提前闭合 ⇒ `pct is not defined`）的**静态防线一直缺位**，只有 vm 执行路径在兜底，而闭合后语法恰好合法时会漏。

**处置（接线而非删除）**：删掉残废的 `reportTemplateHint`，把完整的 `scanTemplateLiterals` 接成脚本第 3 项检查
（`offenders` 非空即 `exit 1`，逐行打印行号），安装点核对顺延为第 4 项，头注释同步修正为四项。
验证：`node scripts/verify-all.mjs usage` **3/3 PASS**，实跑输出新增一行
`[OK]   模板字面量平衡（无裸反引号 / 未闭合字面量）`，证明现行 `lib/client.js` 无 offenders（不误报）。

**待订正（文档，本次未改）**：`README.md:171` 的面板宽度 `minmax(300px,380px)` 与实现
`minmax(0,1fr) minmax(0,1.15fr)` 矛盾；`README.md:309` 声称的「模板字面量平衡」自检在本次接线前并不存在。

## 2026-09-26 · 账本按 profile 分区 + 迁出独立成第八线（v0.5.2 → v0.6.0）

**依据**（用户原话，两条，第二条才是主线）：

1. 「关于 miasaki 的用量统计可以干净的移植到官方 dsh 这来」；
2. 澄清：「**干净接入是指统计要干净，官方桌面端统计只记载官方消耗**」。

第 1 条是落地形式（独立成线 + 装进隔离后的官方桌面端），第 2 条是真正要修的东西。

### 背景

官方 DSH 桌面端的 profile（`~/.dsh/profiles/desktop`）当日 09:41 被隔离为纯官方 bundle
（备份 `package.json.bak-20260926-isolation`）。用量统计是那批自制插件里唯一可以「干净接入」的
一个 —— 但**接入干净 ≠ 统计干净**：账本原先落在全局单文件
`~/.dsh/plugins-data/dsh-token-monitor/usage-log.jsonl`，官方桌面端（`desktop`）/
自制壳（`miasaki`）/ 浏览器 GUI（`web`）三个 profile 的 host 混写同一本账 ——
官方侧的「今日用量 / 热力图 / 趋势 / 模型占比」里一直掺着自制环境的消耗，
与「官方 dsh 我要纯净」的诉求直接冲突。

### 做了什么

| # | 项 | 内容 |
|---|---|---|
| 1 | **账本按 profile 分区** | 新增 `resolveProfileName()`：宿主 `profileContext.name` → `process.env.DSH_PROFILE` → `default`（**软依赖**：三档都拿不到时退化为旧的全局单账本语义，不丢数据、只是不隔离）。账本与限额配置一起落到 `~/.dsh/plugins-data/dsh-token-monitor/<profile>/` —— **一个 profile 一本账**；限额跟账本同住一个分区，限额进度条才自洽 |
| 2 | **历史归位（一次性）** | 分区前的全局账本是混合账、**无法事后拆归属**。新增 `migrateLegacyLedger()`：在 `miasaki` 分区首次启动且该分区还没有账本时，把全局 `usage-log.jsonl` + `config.json` + `.bak-*` 备份整体搬进 `miasaki/`；官方桌面端与 web 侧从零开始累计 —— 「只记官方消耗」物理上没有别的实现方式 |
| 3 | 口径可见性 | 浮窗内容顶部新增一行「口径：本页只统计当前 profile（xxx）的消耗 · 与其它 profile 的账本完全隔离」；`GET /global` 响应新增 `profile` 字段、`note` 文案同步。分区后官方桌面端首次打开是空账本，这行提示让「空」是预期而不是故障 |
| 4 | 源码迁移 | `git mv dsh-miasaki-desktop/plugins/dsh-token-monitor/ → dsh-miasaki-usage/`（9 个文件全部识别为 R 重命名；桌面端线插件数 5 → 4）。设计文档 `design/usage-stats-redesign.md` 随迁，桌面端线原路径留**转发页**（该线历史 CHANGELOG 的既有引用不断链） |
| 5 | 包名 | **保持 `dsh-token-monitor`**：该字符串同时是插件 id / client bundle entry id / HTTP 路由前缀 / 数据目录名，改名等于历史账本「搬家」 |
| 6 | profile 装法 | `file:` → **`link:`**（官方 `desktop` / `web` / `miasaki` 三处同改）。file: 副本会与源码静默漂移 —— 本次实测安装副本的 `client.js` 已落后源码 262 字节；`link:` 下源码即真源 |
| 7 | 自检脚本 | `scripts/verify-client-bundle.mjs` 的 `--sync` 由「拷贝到 web profile 副本」改为**逐个 profile 核对安装点**（链接指回本线即一致；遗留的 file: 副本按旧行为覆盖并提示改用 link） |
| 8 | 数据修复工具 | `scripts/dedupe-usage-ledger.mjs` 增加 `--profile <名>`（默认 `miasaki`，历史账本所在分区） |
| 9 | 统一回归 | `scripts/verify-all.mjs` 接入第八线 `usage`（host 半语法 + dedupe 脚本语法 + client bundle 自检），七线 → 八线 |
| 10 | profile 接入 | 官方桌面端 profile 加回**仅此一条**（`dependencies` + `dsh.profile.bundles`），其余自制插件维持隔离 |

### 验证

- **探针 profile 实测（离线可复现）**：复制官方桌面端清单 + junction 复用其 `node_modules`，
  跑 `dsh --profile usageprobe --dump-config` → **1290 行**（隔离当时为 1287 行），其中
  `token-monitor` 3 处，而 `@miasaki` / pet-panel / model-probe / free-model-pool /
  session-log-move **计数全为 0** —— 坐实「只多这一条、隔离保持」；树尾正确追加
  `# == dsh-token-monitor` 段。探针 profile 用后即删。
- **分区逻辑离线冒烟**：以两个假 profile（`__probe_a__` / `__probe_b__`）驱动 `apply()`，
  各自建出独立分区目录、无异常；根目录旧账本（3,419,757 B，mtime 未变）**零改动**。
  冒烟脚本与探针目录均已删除。
- `node scripts/verify-all.mjs usage` → **3/3 PASS**。
- `node dsh-miasaki-usage/scripts/verify-client-bundle.mjs dsh-miasaki-usage/lib/client.js --sync`
  → 三个 profile 安装点全部「link 指回本线，源码即真源」。
- **实机验收（2026-09-26 当日实测，官方桌面端 `desktop` profile）**：
  - host 半路由：`GET http://127.0.0.1:19387/dsh-token-monitor/global` → **HTTP 200**，顶层 `"profile":"desktop"`；
  - **口径隔离**：`note` 原文「账本按 profile 分区 —— 本页只统计当前 profile（desktop）的消耗，
    官方桌面端与自制壳 / 浏览器 GUI 各记各的账、互不混入」；`stats.since = 2026-09-26`、
    `activeDays = 1` —— 官方侧**从零累计**，未掺入自制环境消耗；
  - 分区落盘：`desktop/usage-log.jsonl` 存在且持续续写（当日 11:10 仍在写，43,894 B）；
  - 历史归位：`miasaki/` 下已有 `usage-log.jsonl`（3,419,914 B）+ `config.json` + `.bak-*`，
    数据根目录无散落账本；
  - 安装点核对：三 profile（`desktop` / `web` / `miasaki`）junction 全部指回本线；
  - **尚待目视**：侧栏脚部「用量统计」入口、会话「用量」Tab、浮窗顶部口径行的**视觉**确认
    （数据面已闭环，见 `../../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md` §3.8 实测记录）。

### 已知取舍（必须让用户知道）

- **官方桌面端的统计从零开始**：混合账无法事后拆分归属，这是「只记官方消耗」的必然代价。
- **日限额按 profile 各设各的**：与账本同住一个分区，进度条口径才自洽；官方侧需要重新设一次。
- **会话存储未动**：`~/.dsh/sessions/` 仍是全局共享（按 cwd 分目录，DSH 既有设计）。
  本次只隔离**统计口径**，不改官方存储布局 —— 官方桌面端仍能看到自制壳跑过的会话列表，
  这属于另一个议题（用户本次只提统计）。

---

## 事故记录：同日越界改动与回滚（2026-09-26 上午）

**本节记录一次不属于本线需求、且与上一节自相矛盾的改动**，供后来者引以为戒。

- **越界内容**：本线会话在 **10:51**（本文档写成后 3 分钟）于官方桌面端 profile 的
  `cordis.patch.yml` 追加 `session-persistence-jsonl` 的
  `root: !!js dshHomePath('profiles', ctx.get('profileContext').name, 'sessions')`，
  试图把**会话记录也按 profile 隔离** —— 而上一节刚刚写明「**会话存储未动**……
  这属于另一个议题（用户本次只提统计）」。
- **后果**（两条，都落在用户身上）：
  1. 会话根被改走 → 官方桌面端 **212 个历史会话从列表消失**（数据仍在磁盘，只是 root 变了）；
  2. 插件树重载失败 → `sessionController` 服务不可用 → **用户新建会话失败**
     （`gateway/service-unavailable: ... active Service "sessionController" is unavailable`）。
- **回滚**：用户 **10:58** 自行备份坏 patch 并恢复原版（该备份与另 3 个 `.bak` 已于同日
  归档到 `_refs/desktop-profile-bak-20260926/`，desktop profile 目录保持干净 —— 其中
  `cordis.patch.yml.bak-20260926-105803-before-restore` 即本次事故的原始物证），
  11:00 host 重启后恢复；隔离期写入 profile 专属目录的 3 个会话已搬回全局
  `~/.dsh/sessions/`（临时备份 `_refs/backup-desktop-sessions-20260926`；dsh-miasaki 项目会话
  212 → 214）。
- **纪律结论**：**统计口径分区（本线需求）与会话存储布局（另一议题）必须分开**；
  不得在用户**正在使用**的 profile 上做需求之外的结构性改动 —— 官方桌面端当时正跑着，
  patch 一改即触发它的插件树重载。

---

## 2026-09-26（中午·续）· 闭环记录：「会话存储未动」那条取舍，同日已被处理

上一节「已知取舍」第 3 条写着「**会话存储未动**：`~/.dsh/sessions/` 仍是全局共享……
这属于另一个议题」——**该议题同日已落地**，本线只留一条闭环指针（实现、验证、踩坑全在 desktop 线，
见 [`../../dsh-miasaki-desktop/design/CHANGELOG.md`](../../dsh-miasaki-desktop/design/CHANGELOG.md)
2026-09-26「会话记录按 profile 隔离」条）。

- **做法**：`miasaki` profile 补丁层覆写 `session-persistence-jsonl` 的 `root` 为
  `profiles/miasaki/sessions`（官方默认是不随 profile 走的全局 `sessions/`）；**官方 `desktop`
  profile 零改动**，历史**整体复制**一份而非搬走；
- **与本节事故的关系**：上午那次的成因被逐条规避 —— 只改 miasaki 侧（不在正在使用的 profile 上动手）、
  表达式**不依赖任何服务**（消除缺可选链的 `TypeError`）、历史不搬空（避免「列表里会话消失」）；
- **对本线的影响**：无。账本分区（`plugins-data/dsh-token-monitor/<profile>/`）与会话 root 分区
  互不依赖，二者是「按 profile 各记各的」这同一口径的两个落点；
- **口径随之对齐**：用量浮窗顶部「本页只统计当前 profile（xxx）的消耗」与会话列表的可见范围
  现在**同源** —— 不再有「账分开了、会话没分开」的错位观感（本节开头「会话存储未动」那段描述
  的正是那个错位）。
