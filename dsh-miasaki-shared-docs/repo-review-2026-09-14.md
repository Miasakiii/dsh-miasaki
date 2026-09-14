# dsh-miasaki 项目状态总结与未完成任务项（2026-09-14）

> 生成日期：2026-09-14　｜　分析范围：整个 monorepo（七条线 + 共享参考 + 治理层）
> 证据口径：`[实测]` = 本次直接跑命令 / 读源码核到；`[线报]` = 本次四条线只读深读（带 文件:行号）；`[文档]` = 仅见文档记载、本次未复跑。
> 上一份同类报告：`../2026-09-13-bb854913/2026-09-13-项目总结分析报告.md`（**未入库，位于会话目录**）。

---

## 一、核心判断（五条）

1. **09-13、09-14 两天零提交，工作没有沉淀。** `[实测]` 提交总数仍为 **94**，最后一次提交是 `faadaf5`（2026-09-12 22:2x，desktop 包管理收口）。首次提交 2026-08-18，至今 27 天。**09-13 会话的产物——一份完整的 CI 工作流 + 部署说明 + 总结报告——全部留在未追踪的会话目录 `2026-09-13-bb854913/` 里**，随时可能被清理。

2. **静态健康度稳定：本次实跑 77/78。** `[实测]` `node scripts/verify-all.mjs` → sidebar 9/10※、canvas 11/11、fleet 15/15、desktop 8/8、ssh 12/12、dual-model 10/10、appearance 12/12。唯一失败项是 sidebar `terminal-hub.test.js`，**本次已复现并确认是受限沙箱环境假阴性**：`where.exe` 以 `stdio:'inherit'` 运行 exit=0 且打印 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`（说明 PATH 里有，只是沙箱禁止管道捕获其输出）。

3. **治理层三大缺口一个未动，但 CI 这道闸门已经"只差一次复制"。** `[实测]` 仓库根无 `.github/`、无根 `package.json`、无 `.editorconfig`/eslint/prettier/biome、无 git hooks——与 09-12 评审时**逐条一致**。变化在于：09-13 已把 `verify-all.yml`（94 行，含 Windows runner / Rust 工具链 / cargo 缓存 / 只装 ssh 依赖 / pnpm frozen-lockfile 的完整决策理由）**写好并本地校验过 YAML 语法**，只是没搬进仓库根。

4. **瓶颈仍是实机验收，且两天来没有任何新增验收记录。** `[线报]` 五条 Web 线的待验收清单原封不动：ssh **连一次真实连接都没做过**（M1 都未过）、dual-model 未验收且**验收矩阵里根本没有它这一节**、sidebar v0.7.0/v0.8.0/v0.8.1 三版全挂、appearance M2 的 12 组视觉矩阵待用户验收、canvas V1–V4 的 18 张走查截图未拍、desktop 桌宠 v3 M2 待桌面壳实机。

5. **上一份报告的 P2 有两处事实错误，本次更正。** `[实测]` 09-13 报告称「ssh 终端两个健壮性缺口：`push()` 无 `bufferedAmount` 背压检查、`teardown` 不清 `pending` 指纹项」——**两项均已实现**：`dsh-miasaki-ssh/lib/runtime.js:427` 有 `ws.bufferedAmount > MAX_WS_BUFFERED_BYTES`（8 MiB，`:22`）守卫并 `close(1011,'viewer-too-slow')`；`:344-345` `teardown(rc)` 首行即 `this.expirePendingFor(rc)`。该结论源自 `repo-review-2026-09-12.md:232-245`，**评审条目本身已过时**。

---

## 二、七线状态一览

| 线 | 版本 | 最后提交 | 已完成 | 代码侧未完成 | 实机验收 |
|---|---|---|---|---|---|
| **desktop** | 壳 `0.1.0`（文档侧写 v0.1.4，漂移） | 09-12 | 桌宠 v2 A/B、v3 M0/M1/M2；标题栏 v4；5 个本体补丁；让位协议；npm 唯一锁文件 + sharp 0.35.4 | v3 **M3/M4/M5 未开始**；v2 阶段 C1/D 未落地 | 桌宠 M1/M2 各一套清单待用户；长稳定性观察未做 |
| **fleet** | `package.json` 0.20.0（文档 v0.16 / 变更记录 v0.22，三处漂移） | 09-12 | F1/F2/F3、X1、G0/G1/G2/G4 判定层、能力闸门接线 | **G3 未实现**；G1/G4 判定未接派单；Worker 生命周期为零；任务级成本上限缺失；**安全三缺口全在** | L4 跨线联动未验收；上次真实派单 09-11 |
| **canvas** | `0.5.0-miasaki.6` | 09-12 | MVP + V1–V4 视觉精细化；89 例单测 | V5 未启动；字重 720→600 未做；§6.6 方案乙待决议；app.js **2417 行**待重构 | V1–V4 三主题×明暗×三档共 18 张走查未拍 |
| **sidebar** | `0.8.1-miasaki.0` | 09-12 | 接入官方右栏；自研壳已删除；内嵌终端两形态（node-pty 路线 B）；54 例单测 | **M2 辅助对话未做**；外部程序跳转未实现；P2/P3 多项 | **v0.7.0/v0.8.0/v0.8.1 三版全待验**（v0.8.0 有 7 项清单） |
| **ssh** | `0.1.0-miasaki.0`（立项至今**从未升版**） | 09-12 | M1 代码 + U0 可靠性闭环 + U1 统一工作区；60 例单测 | **U2（SFTP/多 shell）U3（跳板/转发）未动**（grep 0 命中）；侧栏拖动调宽未实现 | **从未做过一次真实连接** |
| **dual-model** | `0.1.0-miasaki.0` | **09-10（零改动 4 天）** | M1 实现 + 图片准入补丁（patched，哈希自证） | M2/M3 只有条目无判据；settings 命名空间前置阻塞 | 未验收，**且矩阵无双模型专节** |
| **appearance** | `0.1.0-miasaki.0` | 09-12 | M1（已实机六项全过）+ M2 S1–S6 全收官；60 例单测 | **M3 动效 / M4 会话效果仅面板占位**；M5 未列 | M2 12 组视觉矩阵 + 帧率基线待用户 |

**回归基线**（2026-09-14 实测，全量 78 项）：sidebar 9/10※、canvas 11/11、fleet 15/15、desktop 8/8、ssh 12/12、dual-model 10/10、appearance 12/12。
**单测总量**：canvas 89 + sidebar 54 + ssh 60 + dual-model 24 + appearance 60 + fleet 108 + desktop(Rust) 10 = **405 例**（fleet 为文档记载，余为实测计数）。

---

## 三、未完成任务项

### A. 治理层（跨线，优先级最高）

| # | 项 | 现状证据 | 成本 |
|---|---|---|---|
| A1 | ~~**CI 未落地**~~ → **已落地并全绿（2026-09-14）** | 新建 `.github/workflows/verify-all.yml`（修正版）。审查发现 09-13 草稿有致命缺陷：其「唯 ssh 有依赖」的判断错误，漏装 desktop 的 `sharp`（实测 `ERR_MODULE_NOT_FOUND`）与 sidebar 的 4 个依赖；另修正 Node 版本表述、pnpm 对齐 11、超时 30→45 分钟。**首跑（run #1）失败 8 项**，根因是缺 `.gitattributes` 导致 CRLF 污染（见文末附录）；加 `.gitattributes` 后 **run #2 = 78/78 全 PASS**（sidebar 10/10、canvas 11/11、fleet 15/15、desktop 8/8、ssh 12/12、dual-model 10/10、appearance 12/12） | 已完成 |
| A2 | **无 lint/format 自动化** | `.editorconfig`/`eslint.config.*`/`.prettierrc*`/`biome.json` 全不存在 `[实测]` | 低 |
| A3 | **无统一工作区根** | 根 `package.json`、`pnpm-workspace.yaml` 均不存在 `[实测]`（sidebar/ssh 各有自己的 workspace 文件） | 低，但需守住"不引 workspace"的既有决议 |
| A4 | **加载路径无自动化覆盖** | 五个 Web 插件中仅 appearance 有 client 半装载契约测试；唯一真实线上故障（`module is not defined`）恰在此层 `[线报]` | 中（假 `ctx` 调 `apply()` 断言路由/插槽/inject，可完全离线） |
| A5 | **测试层跨线耦合** | canvas 测试读 desktop 主题源码、ssh 测试读 canvas client 源码 `[线报]` | 中（契约以常量快照落 `cross/`） |
| A6 | **79 条源码文本断言** | canvas 27+13+13 / ssh 25 / sidebar 1 `[线报]`；canvas `app.js` 2417 行重构在即时会变成"重构税" | 中，机会驱动 |
| A7 | **实机验收矩阵无勾选记录** | `cross/smoke-test-matrix.md` 全文**无任何 checkbox**，最后更新 09-12；§2 L2 九行、§3.3–3.5、§4 L4 七行均无验收结论 `[线报]` | 需一次重启批次 |
| A8 | **文档漂移（多点）** | 见下表 | 低 |

**文档漂移清单**（可点名）：
- `README.md:10` fleet 写 v0.16，实际 `dsh-miasaki-fleet/package.json:4` = **0.20.0**
- `cross/smoke-test-matrix.md:66,112` sidebar health 仍写 `0.6.0-miasaki.0`，实际 **0.8.1-miasaki.0**
- `dsh-miasaki-appearance/README.md:41` 写 38 例 vs `:99` 写 60 例（实测 60）
- `dsh-miasaki-ssh/design/CHANGELOG.md:39` 写"59 例" vs `:17` 写"60 例"（收官口径 60）
- `dsh-miasaki-sidebar/design/CHANGELOG.md:13-17`（紧贴 brand）与 `:530-532` + `client.js:413-418`（置于首位）**互相矛盾**，代码=首位
- `dsh-miasaki-sidebar/design/CHANGELOG.md:530` 最新条目「2026-09-12（晚）」排在**文件末尾**（全文其余为倒序）
- `dsh-miasaki-appearance/design/2026-09-12-appearance-m2-design.md:4` 状态仍写"设计定稿，待拍板后开工"，而同文件 `:523-528` 已全部 ✅
- `dsh-miasaki-dual-model/design/2026-09-10-dual-model-design.md:577` 写"6 个 lib 模块"，实际 4 个；`:347-359` 规划的 `lib/settings.js` 与 `styles.css` 均不存在
- `dsh-miasaki-desktop/design/HANDOVER.md:10` 写 v0.1.4（2026-08-30 停更），代码侧为 0.1.0
- `repo-review-2026-09-12.md:166-167,401` 的 sidebar `client.js` 756 行 / canvas `app.js` 2400 行已过期（实测 1529 / 2417）
- `dsh-miasaki-desktop/design/titlebar-v4-embed.md:158-167` 验收清单 8 项全未勾 vs `:171-172` 称"真机过验证清单全过"
- canvas/sidebar README 安装命令内嵌本机绝对路径（`repo-review-2026-09-12.md:204-209`）

### B. desktop

**P0 · 稳定性阻断**
- 偶发「全黑无响应」根因未收敛：9/5 起四次 `Application Hang`，签名恒定（`P4=c27d`/`P5=67246080`），Mica 假设已推翻 — `design/TODO.md:10-25`
- 挂起现场取证能力缺失：四次 `Report.wer` 全无 dump、`LoadedModule entries: 0`；需二选一看门狗方案 — `design/TODO.md:26-30`；**源码中无 watchdog 实现** `[实测]`
- 长时间稳定性观察未做（≥1h 连续运行） — `design/TODO.md:31`

**P1**：鉴权 secret 动态化（`TODO.md:46-48`）｜401 恢复指引分支（`:49-50`）｜安装包+卸载（`:64-65`）｜历史会话恢复验证（`:66-67`）
**P2**：最小化到托盘（`:73`）｜桌宠审批等待实机验收（`:74-79`）｜反转狂三 run/wave/jump 动画帧（`:80`）｜**v3 M3 快捷审查与提权未开始**（`:85-91`，全仓无 `cmd=open-review`/`approve-once`）｜**v3 M4 边缘状态未开始**｜**v3 M5 立绘与动作扩容未开始**（`r7` 行语义错配未修）｜主题→人格切换自动开新会话（`:92-93`）｜主题切换视觉漂移核对（`:94`）
**P3**：正式 IPC 替代 hash 通道（`:98`）｜`verify-themes.mjs` 沙箱方案（`:99`）｜`parse_fragment` 纯函数单测（`:100-102`）｜升级策略（`:103`）｜`GHSA-wrw7-89jp-8q8g`（glib 0.18.5）跟踪（`:104-109`）
**其他**：`node_modules` 仍是 pnpm 结构待重装（`CHANGELOG.md:31-33`）｜`themes/runtime.js` 与 `themes/src/` 拼接不一致（1101 vs 1042 行）｜浮窗模式下让位协议误判（`CHANGELOG.md:414-418`）｜v2 阶段 C1 `validate-frames.mjs` 未实施、阶段 D 配置迁移未完成（`pet-v2-roadmap.md:141-157`）

### C. fleet

**安全三缺口（全部仍在）** `[实测]`
- CORS 通配 `Access-Control-Allow-Origin: '*'` — `fleet-monitor/server.js:325`，且 `sendJSON()`（`:330-335`）对所有 JSON 响应施加、OPTIONS 预检同样裸放（`:361-366`）
- `POST /api/toggle/:agentId` 无鉴权写 `control.json` — `server.js:386-405`，仅有 `..` 过滤，**无 Host/Origin/sec-fetch-site 校验**
- 信任围栏代码完全缺失（对照 sidebar/ssh/appearance 三处均有三道围栏）
- 唯一做对：`server.js:422` 只绑 `127.0.0.1`（评审的风险链为 `[推断]`，未构造 PoC）

**判定层「可查询但未强制」**
- G1 未接派单：`dispatch-task.ps1` 中 grep `evaluateDispatchable|task-ready` 零命中
- G4 未强制挂验证器：grep `verifier` 零命中
- G2 未持久化、confidence 仅 agent 级 — `graph-engineering-fleet-design.md:745,756`
- **G3 失败归因与恢复未实现** — 同上 `:791-796`

**其他**：P0-5 唯一写入入口覆盖不全（`bus-contract.cjs:316` author 枚举不含 worker；`validate-bus.mjs:231` 缺 `result.json` 静默放行）｜派单器无法表达 `blocked` 终态（`dispatch-task.ps1:326`）｜**Worker 生命周期为零**（`:301` 同步阻塞，无 timeout/retry/orphan）｜**任务级成本上限缺失**（`:50-64` 只判当日已花）｜notes.md 契约边界待裁决｜能力档案缺口（claude 未声明 `zh-report`）｜L4 实机联动未验收

### D. canvas

- **V5「任务/产物呈现适配」未启动**，需单独决议 — `design/2026-09-12-canvas-visual-refinement.md:226-228`
- 字重 720→600 未实施（待三主题对比图） — 同上 `:158,279①`
- §6.6 操作按钮方案乙未排进四阶段 — `:279②`
- compact 档 `line-clamp:6` 为临时取舍 — `:279③`
- V1–V4 实机走查未做（三主题×明暗×0.5/0.8/1.0 共 18 张截图） — `:261`
- `app.js` **2417 行**，重构在即（评审称"必然事件"）
- 外部视图槽实机复验点未确认（`CHANGELOG.md:40`）；会话头窄宽度自适应未确认（`:49`）
- 0.1.2 存量历史会话投影不回填（待上游开放 persistence 读接口） — `CHANGELOG.md:173,188`
- `@yeesy369/dsh-web-permission` 是否已装回 profile **未证实** — `CHANGELOG.md:189`

### E. sidebar

- **v0.7.0 / v0.8.0 / v0.8.1 三版全部待实机验证**（须重启 `dsh web`） — `README.md:8-10,62,64`
- v0.8.0 实机验收 7 项全未验：交互式 pwsh / vim·git log TUI resize / 两 viewer 移位回放 / viewer 全关 pty 保活 / yes 洪泛 / 三主题配色 / 桌面壳按钮+让位+Ctrl+` — `CHANGELOG.md:64-68`
- 依赖拷贝语义待实机确认（profile 拷贝下原生模块能否加载） — `CHANGELOG.md:67-68`
- **标题栏注入脆弱性**：`MutationObserver` 观察**整个 `document.body` 子树且无 rAF/去抖**（对照 tavern 是 `#root` + rAF）— `client.js:460-463`；顺序正确性依赖"其它注入方插在 brand 紧前"假设（`:416-418`）；`--ms-titlebar-reserve:156px` 仅首次创建时写入（`:450`）
- **M2 辅助对话未做**（蓝图标注"设计完成，待实现后再注册官方 tab 类型"） — `README.md:3,65`
- 终端：T1 显式跳过、T3 无独立通过记录、T4/T5/T6 无实机证据 — `CHANGELOG.md:24,38-45`
- 外部程序跳转按钮（explorer/VS Code）未实现，待另立项 — `README.md:66`
- P2 过滤框+分支显示未做；P3 三项（官方预览联动 / 分栏并排 diff / 整仓单次 diff）未做 — `CHANGELOG.md:95,111-112`
- betterSidebar 兼容层未做（`:354`）；未跟随 DSH 用户字号缩放（`:518-519`）

### F. ssh

- **真实连接从未验收**：M1 设计验收第 2 条「密码与私钥各连一台真实云服务器，`ls`/`vim`/`top`/`Ctrl+C` 正常」无通过记录 — `design/2026-09-09-ssh-design.md:554`；SPIKE S1 的"已通过"只验了装包（`README.md:62` vs `design:576`）
- U0 六项 + U1 六项待验收清单均无通过记录 — `CHANGELOG.md:41,69`；矩阵 `:134-149`
- **U2（SFTP / 同主机多 shell / 工作区记忆）未动**、**U3（跳板 / 转发 / 文本联动）未动** — 全 `*.js` grep `sftp|proxyJump|forwardOut|jump` **0 命中** `[线报]`
- 侧栏拖动调宽未实现（`plan:60` 承诺 208–288px，实际 `styles.css:91-92` 固定 232px）
- 精确终端恢复 / 全屏 TUI 边界未实现 — `plan:183-188,287`
- `plan §13.2` 六项未覆盖：真实宿主令牌继承、真实 `setWindow`、reduced-motion、150% 缩放字体与滚动条、触屏命中、长主机名/IPv6/指纹换行 — `plan:362-366`
- `plan §10` 验收矩阵 16 条从未执行 — `plan:273-296`
- **新发现**：回放路径无背压——`flush()`/`flushTo()`/`broadcast()`（`runtime.js:446-452,454-457,438-444`）直接 `ws.send` 不查 `bufferedAmount`（回放上限 256 KiB，风险有界）

### G. dual-model

- **M1 实机验证未做**，三个验证点无通过记录 — `README.md:7,55-56`
- **验收矩阵无双模型专节**：`smoke-test-matrix.md:13` 声称 L3 覆盖"双模型"，但 §3 只有 3.1–3.6，**有验收要求、无验收清单** — `[线报]`
- **契约义务 2 未实机闭环（本线最大风险）**：设计要求"含图步骤真的走该路由，两个模型都不支持时显式报错，绝不静默降级"，且"两者必须同版本上线" — `design:328,331`；当前仅 24 例纯函数单测
- M2/M3 只有条目、无门槛与判据 — `design:481-488`
- **M2 前置阻塞未解**：接入 settings 命名空间需先解决 `@deepseek-ai/schemastery` 解析问题 — `design:461-465`
- §8.5 两条未做：plugin 来源消息注入 API 签名；「辅助模型切换后 header 变化的 log 体积需在 M1 实测评估」**未评估** — `design:543-546`
- 文档与实现不符：规划 `lib/settings.js` + `styles.css` 不存在；"6 个 lib 模块"实为 4 个 — `design:347-359,577`

### H. appearance

- **M2 待用户验收**：12 组视觉矩阵（3 皮肤×2 明暗×2 壁纸）+ 帧率基线（有壁纸组 p95 ≥ 原生 90%）+ 桌面壳同页实机项 — `README.md:11-13`、`m2-design:473-482`
- 「切换条双入口」未验收；首帧无闪色录屏逐帧核**未执行** — `CHANGELOG.md:41`、`m2-design:493-496`
- 阻塞原因在案：Windows 锁屏阻塞截图；**IAB 对全局注入层失真**（fixed 层与 `backdrop-filter` 截图不可见）⇒ 必须走桌面浏览器或桌面壳 — `CHANGELOG.md:40-41,82-84`
- **已知缺陷（真缺陷 + 零测试覆盖）**：配置写入失败被吞掉却回报 200 成功 — `index.js:206-213`：`store.save` 抛错 → `current`/`revision` 保持旧值（赋值在 `await` 之后）→ `.catch` 只 `logger.error` → **无条件 200 + `changed:true`（假值）+ 返回旧配置**；客户端（`client.js:308-342`）据此 `setState` 旧值、按旧值重写门控属性、`setError(null)` ⇒ **用户改动静默回滚、无任何提示**
  - 触发边界：`dataDir` 缺失时不触发（`lib/store.js:48`），需 dataDir 在位而 `mkdir`/`writeFile`/`rename` 失败（`store.js:49-52`）
  - 临时文件名 `${this.file}.tmp` 未带 pid — `store.js:50`
  - 60 例测试中**无写失败用例**
- **M3 动效仅占位**：`client.js:483-484` 只有标题+提示；配置骨架 `lib/config.js:72,17,48,190-193` 无消费者；§5.5 的 7 条 Playwright 断言尚无测试文件 — `plan:570`
- **M4 会话效果仅占位**：`client.js:485-486`；配置骨架 `lib/config.js:73,195-197` 无应用
- **M5 未做且 README 漏列**：`plan:572` 定义 M5，`README.md:62-66` 只列 M2/M3/M4，而 `:114` 又写"M1–M5 路线"
- `persistent:true` 自检无记录 — `smoke-test-matrix.md:72`；动效重放 spike 未做 — `plan:618`

---

## 四、与 2026-09-13 报告的差异

| 项 | 09-13 报告 | 09-14 实测 | 判定 |
|---|---|---|---|
| ssh `push()` 背压检查 | 缺失（P2） | `runtime.js:427` 已实现 | **报告有误，已修** |
| ssh `teardown` 清 pending | 缺失（P2） | `runtime.js:344-345` 已实现 | **报告有误，已修** |
| 根 README sidebar 测试数矛盾 | 40 vs 46（P2） | 两处均 54 例 | **已修** |
| fleet-monitor CORS 通配 | 未修（P1） | `server.js:325` 仍在 | 未修 |
| fleet-monitor 写接口鉴权 | 无（P1） | `server.js:386-405` 仍无 | 未修 |
| 无 CI（P0） | 未修 | 草稿已备，**仍未落地** | 未修（差一步） |
| 无 lint/format（P1） | 未修 | 全不存在 | 未修 |
| desktop 看门狗（P0） | 未实现 | 源码 grep 零命中 | 未修 |
| appearance 写失败吞错（P2） | 仍在 | `index.js:206-213` 仍在 | 未修 |
| 提交数 | 94 | 94 | **两天零提交** |

---

## 五、风险优先级

**P0（应立刻处理）**
1. **09-13 的 CI 草稿有丢失风险**——它在未追踪的会话目录里；搬进 `.github/workflows/` 即可把"人工纪律"变成"机器约束"，成本一次复制。
2. **实机验收批次积压**：ssh / dual-model / sidebar 三版 / appearance 视觉 / desktop 桌宠，全部等一次重启。**越晚做，改动叠加后故障定位成本非线性上升**。
3. **desktop 偶发全黑挂起未收敛**，且取证通道（WER dump）已榨干，看门狗未实现。
4. **dual-model 的静默丢图风险**：准入放行与路由未实机闭环，设计文档自己点名"绝不静默降级"——**实机验收前不宜宣称可用**。

**P1（两周内）**
5. fleet-monitor 安全三缺口（虽仅绑 127.0.0.1）
6. appearance 写失败吞错 + 补故障注入用例
7. 加载层契约测试（假 `ctx` 调 `apply()`，完全离线）
8. 测试层跨线耦合消除
9. `.editorconfig` + 格式检查

**P2（机会驱动）**
10. 文档漂移守卫（本报告列出 13 处）
11. link 示例去本机路径
12. 回放路径背压（ssh `flush*`）
13. ssh 版本号从未升版（`0.1.0-miasaki.0`）

---

## 六、建议路线

1. **第一步（分钟级）**：把 `2026-09-13-bb854913/ci-draft/.github/workflows/verify-all.yml` 复制到仓库根 `.github/workflows/`，并按 `ci-draft/部署说明.md` §六 回答两个开放问题（仓库是否已推 GitHub？分支名？）。若未推远端，改用 pre-push 钩子兜底。
2. **第二步（一次重启，批次验收）**：ssh 真实连接 + dual-model 三验证点 + sidebar v0.8.x 清单 + appearance 视觉矩阵 + desktop 桌宠（建议同时补 dual-model 的验收矩阵专节，否则无判据）。
3. **第三步（两天内）**：appearance 写失败修复 + 故障注入测试；加载层契约测试；治理层 lint 配置。
4. **第四步**：fleet-monitor 围栏 + G3/P0-5 等判定层强制化。
5. **工作区卫生收尾**：`.opencode/`、`config/` 补进 `.gitignore`；`2026-09-13-bb854913/` 的 CI 草稿搬走后归档或删除；确认 `2026-09-14-dc825d4f/` 为本会话目录。

### 明确不做（沿袭既有决议）
- 不引入根 workspace、不重构七线边界
- 不把 fleet-monitor 暴露到非环回地址
- 不追求 100% 行为化测试
- canvas 语法高亮不做（零依赖纪律）

---

## 七、工作区卫生欠账 `[实测]`

`git status --short` 现有 4 条未追踪，**均未被 `.gitignore` 覆盖**（`git check-ignore` 逐条确认为"未忽略"）：

| 路径 | 性质 | 建议 |
|---|---|---|
| `.opencode/config.json` | 外部工具（opencode）配置，15 字节空 mcp | 补进 `.gitignore` |
| `config/mcporter.json` | 外部工具（mcporter）配置，39 字节空 | 补进 `.gitignore` |
| `2026-09-13-bb854913/` | 上一会话目录：**总结报告 md+html + CI 草稿** | CI 草稿搬入仓库；报告归档 `_refs/` 或入库 |
| `2026-09-14-dc825d4f/` | 本会话目录（box-agent 任务骨架） | 与上一条统一策略 |

对照 AGENTS.md「工作区卫生」与「收尾自检清单」第 1 条（每条 `M/??` 都必须能点名）——**这 4 条目前属于"无法点名"的欠账**。

---

## 附录：CI 首跑复盘 —— 8 项失败全部源于缺 `.gitattributes`

CI 接入后首跑（run #1，sha `7102f80`）失败，8 个失败项**全是逐字节 / 文本比对类**检查：

```
[desktop]    5× patch verify (可重建)            → exit 1      （desktop 3/8：gen-init / tokens:diff / cargo test 通过）
[dual-model] patch verify (图片准入补丁可重建)    → exit 1      （dual-model 9/10）
[appearance] derive-skins --check                → exit 1      （appearance 11/12；报「产物与重算不一致」）
[sidebar]    test rightbar-guide.test.js         → exit 1      （sidebar 9/10）
```

**根因**：仓库当时没有 `.gitattributes`，而 `windows-latest` 的 Git for Windows 默认 `core.autocrlf=true`
⇒ checkout 时把 LF 文件全文转成 CRLF ⇒ 「由 baseline 重建后比 SHA」「重算 token 表逐字节比对」
「源码文本断言」全线失效。本地因 `core.autocrlf=false` 而 77/78 —— **同一个 commit 两套结果**。

**对照实验**（单文件 `dsh-miasaki-appearance/lib/skins/zafkiel.js`，433 行；临时摘除 `.gitattributes` 复现 CI 场景）：

| 条件 | `git check-attr text` | checkout 后 CRLF 字节 | `derive-skins --check` |
|---|---|---|---|
| 无 `.gitattributes` + `autocrlf=true`（= CI） | `unspecified` | **433** | FAIL「zafkiel: 产物与重算不一致」——**与 CI 日志逐字一致** |
| 有 `.gitattributes`（`autocrlf` 仍为 true） | `unset` | **0** | PASS（两皮肤一致，exit=0） |

**修复**：新增 `.gitattributes`，内容为 `* -text` —— 对所有文件禁用 EOL 转换。gitattributes 的 per-path
规则**优先于** `core.autocrlf`，故 checkout 出的字节与入库字节恒等，与本机配置无关；`-text` 只禁用
EOL 转换，不影响 diff / merge。修复后 run #2（sha `0f529b6`）**78/78 全 PASS**。

**两条被这次首跑验证的既有判断**：
1. sidebar 的 `terminal-hub.test.js` 9/10 确系**受限沙箱的环境假阴性**（`where.exe` 输出捕获被禁）——
   CI runner 无此限制，实测 **10/10**；且 CI 上失败的是另一个文件（`rightbar-guide.test.js`，CRLF 所致），
   进一步印证两者根因不同。
2. 依赖安装步骤是必需的：三条线的安装步骤在两次运行中均成功，未安装时 ssh 实测 10/12、desktop 的
   `gen-init` 必然 `ERR_MODULE_NOT_FOUND`。

**遗留（低优先）**：CI 有一条无害 warning —— `actions/checkout@v4`、`actions/setup-node@v4`、
`actions/cache@v4`、`pnpm/action-setup@v4` 仍以 Node 20 为目标，被 runner 强制跑在 Node 24 上。
待官方发布对应大版本后升级即可，不影响结果。

---

*本报告基于 2026-09-14 对工作区的实测（`git status`/`git log`、`verify-all` 77/78、逐文件 grep 核对）与四条线的只读深读生成。所有"未修复"结论均在本次逐条核实；`[实测]` / `[线报]` / `[文档]` 三种口径已分别标注，未复跑项不与实测项混同。*
