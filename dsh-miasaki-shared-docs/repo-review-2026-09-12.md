# dsh-miasaki 仓库评审与优化规划（2026-09-12）

> **性质**：仓库级工程评审（跨线治理视角），非某一条线的设计文档。
> **口径**：只读核查。本次**未运行任何测试、构建、校验脚本或服务**，未安装依赖，未修改业务代码。
> **证据分级**：`[实测]` = 本次以 git / 源码直接核到；`[推断]` = 由代码结构推出的风险，未运行验证。
> **与昨日报告的关系**：`repo-review-2026-09-11.md` 覆盖七线结构、方法论与实测健康度；
> 本文不重复其结论，只做**增量**：昨日报告的 6 条建议已基本执行完毕（见 §2），
> 因此本文的重心转移到**它未覆盖的跨线治理层**。
> **与前一日各线规划的关系**：canvas 视觉精细化、sidebar 右栏优化、desktop 桌宠 v3 三份规划
> 已由用户当日产出（工作区未提交）。本文**不重复**这三份的内容，只处理它们不覆盖的仓库级问题。

---

## 0. 结论摘要（六条）

1. **整体判断：这是一个工程规格显著高于其规模的个人项目。** 4.4 万行、七条线、83 次提交，
   却具备分层回归（L0–L4）、补丁双基线离线自证、每线 README + CHANGELOG + design 三件套。
   真正的稀缺资产不是代码，而是**这套纪律本身**。

2. **昨日报告的欠账已基本清零 `[实测]`**：工作区干净（无未跟踪的实质资产）、fleet 能力闸门已接线、
   AGENTS.md 已补 `link.exe` 环境注记、回归矩阵已七线化、sidebar 壳死代码已删。
   昨日列的 6 条建议中 5 条完成、1 条（desktop P0）未动且**仍无进展**。

3. **当前最大的结构性缺口是「验证不可复现」，不是「功能未实现」。** 仓库**没有 CI**
   `[实测]`：`.github/` 不存在，83 次提交的全部质量保证依赖「维护者记得在本机跑一次
   `node scripts/verify-all.mjs`」。而这道唯一闸门本身还是环境敏感的——desktop 的
   `cargo test` 在 Git Bash 下必然假阴性（`link.exe` 遮蔽，AGENTS.md 已记录）。

4. **第二个缺口是「加载路径无自动化覆盖」。** 本项目迄今唯一一次真实的线上级故障
   （appearance 首跑 `module is not defined` 整包加载失败）恰好落在**插件加载**这一层，
   而自动化测试几乎全是纯函数单测。五个 Web 插件里只有 appearance 有半装载契约测试。
   **最高频的故障类型与最厚的测试覆盖不在同一层。**

5. **「七线零耦合」在代码层成立，在测试层不成立 `[实测]`**：canvas 的测试读取 desktop 的
   主题源码，ssh 的测试读取 canvas 的 client 源码。这使一条线的重构可以打断另一条线的回归，
   且失败现象与根因不在同一条线——是排查成本最高的耦合形态。

6. **唯一发现的具体安全缺陷在 fleet-monitor** `[实测]`：`Access-Control-Allow-Origin: *`
   施加在真实数据响应上，且该服务**没有任何信任围栏**、`POST /api/toggle/:agentId` 可无鉴权写入
   `control.json`。而同一仓库的四个 Web 插件都有三道围栏——**安全姿态在仓内不一致**。

---

## 1. 评审方法与本次增量

| 项 | 说明 |
|---|---|
| 手段 | `git log/status/ls-files/grep`、源码直读、配置与锁文件清点 |
| 未做 | 未执行 `verify-all.mjs`、未执行 `cargo`、未启动 `dsh web`、未跑任何单测 |
| 因此 | 本文所有「健康度」表述均引用昨日实测结果，**不声称本次复验通过** |
| 增量 | ①昨日建议的执行核对 ②CI / 工具链缺口 ③测试层跨线耦合 ④加载路径覆盖 ⑤fleet-monitor 安全 ⑥测试断言方式 ⑦文档漂移复核 |

---

## 2. 昨日建议的执行核对 `[实测]`

| # | 昨日建议 | 现状 | 证据 |
|---|---|---|---|
| 1 | 入库工作区实质资产 | **已完成** | `git status` 干净；`appearance/` 9 文件、desktop 补丁目录、fleet 增量均已入库 |
| 2 | 一次重启，批次验收 | **未执行** | ssh / dual-model README 仍写「待实机验证」；appearance 仍写「待实机验证」 |
| 3 | AGENTS.md 环境注记 | **已完成** | AGENTS.md「工作区卫生 → 验证方式」段已含 `link.exe` 遮蔽判据与正确跑法 |
| 4 | fleet 接线（G2 → 派单器） | **已完成** | `f5bc431`；`verify-all.mjs:92-116` 已挂守卫 |
| 5 | desktop P0 看门狗 | **未动** | `design/TODO.md:29` 仍为待办；无 watchdog 实现 |
| 6 | 文档同步 | **部分完成** | 回归矩阵、canvas 版本号已修；**但根 README 又产生新漂移**（§6.1） |

**规模核对**：83 次提交 / 493 个入库文件 / 117 个入库 Markdown。
代码行数：desktop 55,122（含生成物）、dual-model 7,333、fleet 6,877、canvas 6,068、
ssh 2,421、sidebar 2,393、appearance 1,328。

---

## 3. 值得保留的资产（不要为了「优化」而动它们）

1. **补丁治理契约**：`patch.mjs` + 双基线 + `verify` 纯离线自证 + `status` 报 `unknown` 即需重打。
   它把「改本体」这个最脏的手法约束成了可审计、可回滚、可离线验证的流程。6 个补丁全部遵守同一契约。
2. **回归分层 L0–L4 与「为什么不用 `node --test`」的成文理由**（`verify-all.mjs:14-16`）。
   把「反直觉决策 + 其理由」写进代码注释，是防止后来者好心改回去的唯一有效手段。
3. **信任围栏的统一范式**（Host → `sec-fetch-site` → `Origin`）：sidebar `index.js:614-632`、
   ssh `lib/store.js:127-144`、appearance `index.js:87-88` 三处独立实现、语义一致。
4. **零第三方依赖**：canvas / sidebar / dual-model / appearance / fleet 五条线**无任何运行时依赖**，
   只有 ssh 有 4 个（`ssh2` / `ws` / `@xterm/xterm` / `@xterm/addon-fit`）。
   供应链攻击面接近于零——这是本仓被低估的优势。
5. **故障根因的取证纪律**：desktop 的 `cordis_inspect_query` 挂起案例（127 个会话日志、13460 条工具结果
   逐帧解压定位三重原因）、桌宠 v3 的 D1–D4 纯静态可判定缺陷清单——都是「先证伪假设再动手」的范例。

---

## 4. 问题清单（按优先级）

### P0-1 · 没有 CI：全部质量保证依赖人工记忆 `[实测]`

- **事实**：仓库根无 `.github/`；无根 `package.json` / `pnpm-workspace.yaml`；
  无任何 pre-push / pre-commit 钩子配置。
- **后果**：`verify-all.mjs` 的 79 项检查（七线）只在维护者主动执行时存在。
  第三方 clone 后无法判断任一 commit 是否曾经通过；回归结论不可被外部复现。
- **放大因素**：唯一闸门还是环境敏感的。desktop 的 `cargo test` 在 Git Bash 下因
  `/usr/bin/link.exe` 遮蔽 MSVC 链接器而必然失败（`verify-all.mjs:247-252` 探测 cargo，
  但无法修正 `PATH` 顺序）。即「跑了也可能是假的」。
- **为何是 P0**：其余所有问题都会在「有 CI」之后变得可度量；没有 CI，本次评审的其余建议
  都只是文档，无法形成约束。

### P0-2 · 加载路径无自动化覆盖，而它正是唯一真实故障的所在 `[实测]`

- **事实**：五个 Web 插件的测试全部是纯函数 / 源码断言级；
  唯一涉及「装载」的测试是 `dsh-miasaki-appearance/test/client.test.js`
  （在无 `module` 的 VM 上下文里跑 factory，钉死整包加载失败）。
- **反证**：appearance 实机首跑暴露的正是 `module is not defined` —— 加载期故障，
  而它在**该测试被补上之前**逃过了全部 L0/L1。
- **缺口面**：ssh / dual-model / canvas / sidebar 均无「用假 `ctx` 调 `apply()`，
  断言路由已注册、插槽已声明、依赖 `inject` 已满足」的测试。这类测试**完全可离线**，
  不需要重启 host。
- **判据**：新增插槽名拼错、`inject` 漏声明、`export const name` 写错、
  顶层 import 了不存在的模块——这四类错误当前只能靠实机发现。

### P0-3 · 测试层的跨线耦合，与「零耦合」的宣称不符 `[实测]`

- `dsh-miasaki-canvas/test/header-adaptive.test.js:77`、`:90`
  → 读取 `../../dsh-miasaki-desktop/themes/src/03-switcher.js`
- `dsh-miasaki-ssh/test/client.test.js:136`
  → 读取 `../../dsh-miasaki-canvas/client.js`

**后果**：desktop 移动主题源文件 → canvas 回归失败；canvas 移动 `client.js` → ssh 回归失败。
失败信息指向测试自身，根因在另一条线。这比生产代码耦合更难查，因为它只在 CI/回归时暴露。

**判据（可直接执行的验收方式）**：临时重命名 `dsh-miasaki-desktop/` 后跑 canvas 单测，
应仍全绿。当前不会。

### P1-1 · fleet-monitor 无信任围栏 + CORS 通配 + 无鉴权写接口 `[实测]`

| 位置 | 事实 |
|---|---|
| `dsh-miasaki-fleet/fleet-monitor/server.js:325` | `Access-Control-Allow-Origin: *` |
| 同上 `:333-338` | `sendJSON()` 对**所有** JSON 响应调用 `setCors()`，故通配头出现在真实数据响应上 |
| 同上 `:388-402` | `POST /api/toggle/:agentId` 写 `agents/<id>/control.json`，无鉴权、无 Origin 校验、不校验 `Content-Type` |
| 同上 `:422` | `listen(PORT, '127.0.0.1')` —— 仅本机，**外部网络不可达**（这点是对的） |

**风险链（`[推断]`，未构造 PoC）**：用户在浏览器中打开任意页面 → 该页可跨源读取
`/api/fleet` 与 `/api/report`（成本、token、agent 清单），并可发 `Content-Type: text/plain`
的「简单请求」直接 `POST /api/toggle/...` 关停或 `force_kill` 某个 agent——
因为 `text/plain` 不触发预检，而通配 ACAO 又允许读取响应。
无需用户点击，无需本地进程权限。

**对照**：同一仓库的 sidebar / ssh / appearance 三处都有 Host + `sec-fetch-site` + `Origin` 三道围栏。
fleet-monitor 是**唯一裸奔的 HTTP 面**。修复成本极低（照抄现有围栏范式即可）。

**边界说明**：`agentId` 的 `..` 过滤（`:391-393`）与 `path.join` 组合，
在当前写法下**未发现目录穿越**（无 `..` 即无法上跳，且目标目录不存在时写入抛错）。
不应把这条夸大为「任意文件写入」。

### P1-2 · 79 条断言在断言「源码文本」，而非行为 `[实测]`

| 文件 | `assert.match(source, …)` 数量 |
|---|---|
| `canvas/test/canvas-runtime.test.js` | 27 |
| `ssh/test/client.test.js` | 25 |
| `canvas/test/external-views.test.js` | 13 |
| `canvas/test/header-adaptive.test.js` | 13 |
| `sidebar/test/rightbar-guide.test.js` | 1 |
| **合计** | **79** |

**两面性**：这类测试**能**防住「有人误删了接线」（例如 `verify-all.mjs:92-116` 对
`dispatch-task.ps1` 的字符串断言，其存在理由正是防止闸门被静默摘除）——这是有价值的。
**但它们不能证明行为正确，且会因合法重构而失败**：提取函数、改局部变量名、拆文件都会红，
而真正的逻辑回归（判断条件写反）反而可能漏过。

**风险权重**：`canvas/app.js` 已达 2,400 行、`canvas/index.js` 1,178 行、
`sidebar/client.js` 756 行、`sidebar/index.js` 708 行。这个体量下重构是必然事件，
79 条文本断言会变成**重构税**——而重构正是最需要测试保护的时候。

### P1-3 · 无任何代码规范自动化 `[实测]`

- 全仓无 `eslint` / `prettier` / `.editorconfig` / `biome` / `tsconfig` 配置。
- 现状风格一致性靠人工纪律维持（实际做得很好——这是事实，不是反讽）。
- 但 4.4 万行、7 条线、多人/多会话协作下，**没有机器约束的风格一致性是消耗品**。
  最廉价的两个动作：`.editorconfig`（缩进/换行/编码）+ 一条格式化检查。

### P1-4 · 无统一工作区根 `[实测]`

- 无根 `package.json` / `pnpm-workspace.yaml`。锁文件仅在确有依赖处存在
  （canvas / sidebar / ssh 有 `pnpm-lock.yaml`，desktop 有 `package-lock.json` + `Cargo.lock`；
  dual-model / appearance / fleet 零依赖故无锁文件——**这是正确的，不是缺口**）。
- 后果：没有 `pnpm -r test` 这类统一入口，唯一的仓库级命令是 `verify-all.mjs`；
  依赖版本策略无法集中表达。
- **不建议**为此引入 workspace（会引入 hoisting 语义与 DSH link 安装的交互风险）。
  建议只在根加一个**非包管理**的 `Makefile` 或 npm script 壳，暴露 `verify` / `lint` / `fmt` 三个目标。

### P2-1 · 根 README 的 sidebar 测试数自相矛盾 `[实测]`

| 位置 | 内容 | 判定 |
|---|---|---|
| `README.md:12` | 「单测 40 项、静态回归 9/9」 | 与 sidebar README 一致 |
| `README.md:91` | 「46 项单测（… **抽屉手势 9**）」 | **失效**——抽屉测试已随自研壳删除 |
| `dsh-miasaki-sidebar/README.md:34` | 「退役 `test/drawer-gesture.test.js`（9 项）」 | 权威 |
| 实际文件 | 7 个测试文件、无 drawer 测试 | 权威 |

即同一份 README 在第 12 行和第 91 行给出两个互斥的数字，且第 91 行的分类里含一个已不存在的测试。
**这正是「文档漂移需以源码为准逐条复核」的又一实例**（昨日 sidebar/desktop 两条线都踩过）。

### P2-2 · 操作指令内嵌本机绝对路径，与「clone 后不断链」的目标冲突 `[实测]`

| 位置 | 内容 |
|---|---|
| `dsh-miasaki-appearance/README.md:19` | `"link:C:/Users/Asakii/Desktop/dsh-miasaki/dsh-miasaki-appearance"` |
| `dsh-miasaki-canvas/README.md:32` | `dsh plugin --profile web add link:C:\Users\Asakii\Desktop\...` |
| `dsh-miasaki-dual-model/README.md:38`、`:43` | 同上 |

14 个入库文件含 `Users.Asakii`，其中 11 个是**历史记录**（task result / design / 调研），
记录本机路径是合理的；**上面 4 处是「用户照着敲」的操作指令**，换机器或移动目录即失效。
建议改为 `link:./dsh-miasaki-canvas`（相对当前工作目录）或 `<仓库根>` 占位符。

### P2-3 · appearance 配置写入失败被吞掉，并回报成功 `[实测]`

```
dsh-miasaki-appearance/index.js:119-126
  writeChain = writeChain.then(async () => {
    current = await store.save(next)      // ← 可抛（EACCES / Windows 文件占用导致 rename EPERM）
    revision += 1
  }).catch(error => { ctx.logger?.error?.(…) })   // ← 吞掉
  await writeChain
  return sendJson(res, 200, { config: current, revision, …, changed: true })  // ← 回报成功
```

- `lib/store.js:46-54` 的 `save` 依次 `mkdir` → `writeFile` → `rename`，三步都可抛。
- 失败后 `current` 未变、`revision` 未增，但响应是 **200 + `changed: true`**，
  面板据此认为已保存。用户在 Windows 上遇到文件被占用时，会看到「保存成功但重启后配置回退」。
- 附带：临时文件名是固定的 `${this.file}.tmp`（`lib/store.js:50`），
  两个 `dsh web` 实例会互相覆盖；ssh 的同功能实现用了 `${file}.${process.pid}.tmp`
  （`ssh/lib/store.js:171`）——**同一仓库内两种质量，应向 ssh 看齐**。
- 严重度不高（配置可重建），但它是**主配置路径上的静默失败**，且违反了本线
  「`persistent: false` 时面板要能看见」这一已声明的可观测性设计。

### P2-4 · ssh 终端的两个健壮性缺口 `[实测]`

1. **无背压控制**：`ssh/lib/runtime.js:337-352` 的 `push()` 对每个 socket 直接 `ws.send(payload)`，
   不检查 `ws.bufferedAmount`。远端执行高吞吐命令（如 `yes`）而浏览器端消费慢时，
   Node 侧缓冲会持续增长；`rc.sockets` 也无上限。`scrollbackBytes`（默认 256KB）只约束
   回放环形缓冲，**不约束在途数据**。
2. **`teardown` 不清 `pending`**：`runtime.js:276-282` 未清理该连接的指纹确认项，
   只有 `shutdown()`（`:291`）统一清。`disconnect(id)` 后对应的 `setTimeout`
   （`:150-159`）仍持有 `verify` 闭包，最长 60s 后才释放，并对已 dispose 的连接回调。

**边界说明**：这两条是**健壮性**问题，不是可利用漏洞。`attach()`（`:228-247`）
允许任何通过围栏的本机 WebSocket 附着到既有会话并注入输入——围栏把范围限在环回，
但同一台机器上的其他本地程序（`Host: localhost` 是合法头）仍可附着到活跃 SSH 会话。
若要收紧，需在 WS 握手引入会话级一次性 token；是否值得做取决于用户对该威胁模型的接受度。

### P2-5 · `pnpm test` 与 `verify-all` 是两套语义不同的运行器 `[实测]`

- 各线 `package.json` 的 `test` 用 `node --test test/*.test.js`。
- 而 `verify-all.mjs:39-45` 的注释明确写了**为什么不能用 `node --test`**：
  它为每个测试文件 spawn 子进程并管道捕获，受限沙箱下以 `EPERM` 失败，
  因此改为直接 `node <file>` + `stdio: 'inherit'`。
- 结果：README「快速开始」推荐的 `pnpm test`，正是维护者已判定在受限环境不可用的那条命令。
  同一套测试有两个入口、两套通过标准（`node --test` 还会额外做「是否有测试被跳过」的判断）。

### P2-6 · fleet 能力闸门测试是「字符串存在性断言」 `[实测]`

`verify-all.mjs:92-116` 用 `String.includes` 检查 `dispatch-task.ps1` 是否仍含
`Test-CapabilityGate` / `-Requires` / 闸门文案等 7 处文本。它守护的是**接线未被误删**，
**不能**证明闸门判定正确（例如把 `-not` 写反仍会 PASS）。
结合 `repo-review-2026-09-11.md §6.2` 的剩余风险（G4 验证器仍是「可查询」而非「强制」），
fleet 的**判定能力已具备、强制能力仍缺**。这是设计选择，不是缺陷，但应显式登记为已知边界。

### P2-7 · desktop P0 挂起未收敛 `[引用昨日实测]`

4 次偶发「全黑无响应」，签名恒定（`P4=c27d` / `P5=67246080`），跨两次构建；
WER 通道已证明无效（四次 `Report.wer` 无 dump、`LoadedModule entries: 0`）。
`design/TODO.md:29` 记录的**唯一剩余通道**是进程内看门狗（消息循环心跳超时即落盘线程栈）。
本次核查确认：**仍无 watchdog 实现**，该项 24 小时无进展。

---

## 5. 目标架构与设计原则（跨线）

本次评审不支持「重构」类建议——七线边界清晰、依赖面干净，重构的收益为负。建议的演进方向是
**把已有的良好实践从「人工纪律」升级为「机器约束」**，共四条原则：

**原则 1：可复现性优先于完备性。**
宁可 CI 只跑 79 项中的 60 项（全部离线、全部确定性），也不要一个「本机能跑全绿」的本地脚本。
具体：CI 跑 L0 + L1；desktop 的 `cargo test` 放到 MSVC 环境（`windows-latest` 自带）执行，
从而把昨天的「环境假阴性」变成真信号。

**原则 2：故障在哪一层，测试就补在哪一层。**
唯一真实故障在加载层 → 补加载层契约测试（假 `ctx` 调 `apply()`），
这类测试**不需要 host、不需要重启、完全可离线**，是投入产出比最高的一项。

**原则 3：耦合只允许通过「显式契约」发生。**
测试读另一条线的源码文件属于**隐式耦合**，应改为：契约以文档 + 常量快照形式落在
`shared-docs/cross/`，各线测试只断言自己的产物符合契约。这样契约变更会同时影响两侧，
且根因与失败点在同一条线。

**原则 4：安全姿态在仓内必须一致。**
四个 Web 插件有三道围栏，fleet-monitor 一道也没有——这种不一致本身就是风险
（下一个人会以为「本仓不要求围栏」）。要么全部有，要么在 README 显式写明
「本服务仅本机、无围栏、勿暴露」并禁止绑定非环回地址。

---

## 6. 分阶段优化规划

### 阶段 A（P0，建议本周内）——建立不可绕过的验证闸门

| 项 | 内容 | 验收标准（可执行判据） |
|---|---|---|
| A1 | 加 CI（GitHub Actions，`windows-latest`） | 推送到远端后自动跑 `node scripts/verify-all.mjs`；任一 commit 的 L0/L1 结果可被第三方复现 |
| A2 | 修复 desktop 项的环境依赖 | CI 中 desktop 从 7/8 变为 8/8（不再出现 `link.exe` 假阴性）；本地 Git Bash 的失败被文档标记为预期 |
| A3 | 加载层契约测试 | ssh / dual-model / canvas / sidebar 各新增一个「假 `ctx` 调 `apply()`」测试：断言路由注册、插槽声明、`inject` 满足、顶层无缺失模块。**判据：人为删掉 `inject: ['webServer']` 或把插槽名写错，测试必须变红** |
| A4 | 消除测试层跨线耦合 | 重命名 `dsh-miasaki-desktop/` 后 canvas 单测仍全绿；重命名 `dsh-miasaki-canvas/` 后 ssh 单测仍全绿 |

**为何 A 在前**：A1–A4 全部是「一次投入、长期生效」的约束。不做这一步，
后续任何改进都无法防止回退。

### 阶段 B（P1，建议两周内）——收敛安全与维护性

| 项 | 内容 | 验收标准 |
|---|---|---|
| B1 | fleet-monitor 加围栏 | 跨站请求打 `/api/fleet` 与 `/api/toggle/...` 均返回 **403**（与 appearance 的越权防护用例同口径）；通配 ACAO 从数据响应移除 |
| B2 | 测试断言方式收敛 | 新增测试一律行为优先；存量 79 条文本断言**不要求一次改完**，但规定：凡因重构而红的文本断言，改断言形式而非放宽红线。**判据：为「合法重命名局部变量」重构一次，红掉的测试数应下降** |
| B3 | 加 `.editorconfig` + 一条格式化检查 | 新文件自动符合缩进/换行/编码约定；CI 中格式检查不通过即失败 |
| B4 | 根级命令壳 | 根目录一条命令暴露 `verify` / `fmt`；不引入 workspace、不改依赖解析语义 |

### 阶段 C（P2，机会驱动）——消除已知小缺陷与漂移

| 项 | 内容 | 验收标准 |
|---|---|---|
| C1 | appearance 写入失败可观测 | `store.save` 抛错时响应为 **非 2xx 或 `changed:false` + 错误原因**；临时文件名带 pid（对齐 ssh 实现） |
| C2 | ssh 终端健壮性 | `push()` 增加 `bufferedAmount` 阈值保护；`teardown` 清理本连接的 `pending` 指纹项 |
| C3 | 文档漂移守卫 | 根 README 数字与实际一致（当前 `:91` 的「46 项 / 抽屉手势 9」需删）；**进阶**：在 `verify-all` 加一项「README 引用的文件均存在 + 测试项数与实际文件数一致」的检查，让漂移无法再产生 |
| C4 | 操作指令去本机路径 | appearance / canvas / dual-model README 的 `link:` 示例改为相对路径或占位符 |
| C5 | desktop P0 看门狗 | 心跳超时即落盘线程栈；验收为「下次偶发挂起时能拿到栈」，而非「不再挂起」 |

### 明确不做（非目标）

- **不引入根 workspace / 不重构七线边界**：现有零依赖、零 import 的边界是资产。
- **不为视觉/体验问题动用本次工程改进预算**：canvas 视觉、sidebar 右栏、桌宠 v3 已有独立规划，
  属产品演进，不应与治理改进混在同一批次（否则两者互相阻塞）。
- **不追求 100% 行为化测试**：文本断言对「防误删」有真实价值，保留合理数量即可。
- **不把 fleet-monitor 暴露到非环回地址**：它是本机工具，保持 `127.0.0.1` 绑定。

---

## 7. 与已有各线规划的关系

| 已有规划（工作区未提交） | 覆盖范围 | 本文的关系 |
|---|---|---|
| `canvas/design/2026-09-12-canvas-visual-refinement.md` | 会话布表现层（V1–V4） | 不重叠。本文的 B2（文本断言）会直接影响其 V1–V4 落地时的回归成本，建议先做 B2 再动 `styles.css` |
| `sidebar/design/2026-09-12-rightbar-optimization-plan.md` | 审查数据一致性 + diff 阅读器 + 内嵌终端（P0–P2） | 不重叠。该文已自行发现「列表/详情基线不一致」这一功能缺陷，本文不重复 |
| `desktop/design/pet-v3-roadmap.md` | 桌宠状态机 + 官方契约 + 边缘停靠（M0–M5） | 不重叠。本文 C5（看门狗）与其实机验收可**合并为同一次重启批次**，降低验证成本 |
| `repo-review-2026-09-11.md` | 结构 / 方法论 / 实测健康度 | 本文是其增量：昨日建议执行核对 + 它未覆盖的治理层 |

**建议的批次顺序**：A（闸门）→ 一次重启做批次实机验收（含 ssh / dual-model / appearance /
sidebar v0.6.0 / desktop 看门狗 / 桌宠 M1）→ B（安全与维护性）→ C（漂移与小缺陷）。
把实机验收夹在 A 与 B 之间，是因为**它是当前唯一无法自动化、且越晚做越贵的环节**——
改动持续叠加会让故障定位成本非线性上升。

---

## 8. 需要用户决策的开放问题

1. **CI 的载体**：GitHub Actions（需把仓库推到 GitHub）／本地 pre-push 钩子／两者都要？
   若仓库不出本机，A1 需降级为「pre-push 钩子 + 一份可复现的验证记录」。
2. **A3 的覆盖深度**：只断言注册（轻，半天级）还是构造最小假 host 真跑一次请求（重，但能覆盖路由逻辑）？
3. **B1 的修复口径**：只加围栏（保持工具属性），还是同时加一个本地 token（防同机其他程序）？
4. **P2-4 的 ssh 威胁模型**：是否接受「同机任意程序可附着到活跃 SSH 会话」？
   若不可接受，需要 WS 握手级 token——这会改动 ssh 的既有协议，属独立立项。
5. **是否把本文的 C3 升级为「文档漂移守卫」**：这是一项一次性投入后长期生效的机制，
   但需要在 `verify-all.mjs` 里增加对文档的解析逻辑（会引入「文档格式变更导致回归红」的新耦合）。

---

## 9. 附录：本次核查证据索引

```bash
# 结构与规模
git rev-list --count HEAD                      # 83
git ls-files | wc -l                           # 493
git ls-files '*.md' | wc -l                    # 117
git status --porcelain --untracked-files=all   # 5 项未提交规划文档（canvas/sidebar/desktop）

# 缺口核查
ls -d .github                                  # 不存在
ls package.json pnpm-workspace.yaml            # 不存在
git ls-files | grep -iE 'eslint|prettier|editorconfig|biome|tsconfig'   # 无输出

# 关键证据位置
verify-all.mjs:25,39-45,92-116,133,247-252
fleet-monitor/server.js:325,333-338,388-402,422
appearance/index.js:119-126 ; appearance/lib/store.js:46-54
ssh/lib/runtime.js:228-247,276-282,337-352 ; ssh/lib/store.js:127-144,168-177
canvas/test/header-adaptive.test.js:77,90 ; ssh/test/client.test.js:136
README.md:12 vs README.md:91 ; dsh-miasaki-sidebar/README.md:34
```

| 数据项 | 值 |
|---|---|
| HEAD | `68ba128`（2026-09-11 21:24） |
| 提交数 | 83（2026-08-18 起） |
| 入库文件 / Markdown | 493 / 117 |
| 未提交 | 4 改 2 增 3 新增文档（canvas 视觉 / sidebar 右栏 / 桌宠 v3 规划） |
| 本次回归 | **未执行**（只读评审，引用 2026-09-11 实测结果） |
| 源码最大文件 | `canvas/app.js` 2,400 行；`canvas/index.js` 1,178；`sidebar/client.js` 756；`sidebar/index.js` 708 |
| 第三方运行时依赖 | 仅 ssh 线 4 个；其余六线为 0 |
