# dsh-miasaki 项目状态总结与未完成任务项（2026-09-26）

> 生成日期：2026-09-26　｜　分析范围：整个 monorepo（**八条线** + 共享参考 + 治理层）
> 证据口径：`[实测]` = 本次直接跑命令 / 读源码核到；`[审计]` = 本次八线只读死代码审计（8+7 个并行审计员，
> 明细落 `_refs/audit-2026-09-26/`，**结论均经 Lead 逐条复核**）；`[文档]` = 仅见文档记载、本次未复跑。
> 上一份同类报告：[`repo-review-2026-09-14.md`](repo-review-2026-09-14.md)。

---

## 一、核心判断（六条）

1. **09-14 → 09-26 的十二天里工作大量沉淀，但全部堆在工作区未提交。** `[实测]` HEAD 仍是 `b3badb3`
   （09-26 前后的 batch 全在 `git status` 里）：usage 线迁出（9 个文件重命名）、desktop P7/P9/P10 三轮
   稳定性修复、canvas 存储治理 + `sessions/sync` 400 修复、ssh B1–B4 让位修复、shared-docs 平台调研。
   **本报告同批完成清仓并提交（见 §七）**。

2. **静态健康度创新高：本次实跑 113/113 全绿。** `[实测]` `node scripts/verify-all.mjs` →
   sidebar 10/10、canvas 12/12、fleet 15/15、desktop **33/33**（含 `cargo test` 与 6 个运行时补丁的离线自证）、
   ssh 12/12、dual-model 12/12、appearance 16/16、usage 3/3。
   （09-14 基线为 81 项；增量来自 desktop 的 6 个补丁自证 + 7 个行为闸门、canvas 的存储治理用例、
   usage 第八线接入。）

3. **治理层仍是最大欠账，且这次多了一条硬证据。** `[实测]` 仓库根**依然没有** `.editorconfig` /
   `eslint.config.*` / `.prettierrc*` / `biome.json` / 根 `package.json`；
   `cross/smoke-test-matrix.md` 全文**零个 checkbox**（A7 自 09-12 评审起未动）。
   CI（`.github/workflows/verify-all.yml`）是唯一已落地的治理项，且它的注释仍写「七线」。

4. **本轮审计的最大发现不是死代码，而是「文档当前态失真」与「静默降级」。** `[审计]` 15 名审计员里
   有 10 名的结论指向同一模式：**文档头/README 里的「当前态」描述与代码相反**（ssh README 5 处、
   desktop 9 处、appearance 9 处、dual-model 3 处、sidebar 2 处），以及**多处 `existsSync` / `readJsonOrNull`
   守卫造成的静默断链**（fleet 的 `shared/agent-vendors.json` 被两处文档宣称可覆盖却不存在；
   appearance 的 `package.json` `files` 缺 `assets/`，npm 安装场景下三款预设静默消失）。
   这与本仓 2026-09-10 的「删素材静默断链」教训**同型**。

5. **实机验收仍是瓶颈，且积压更重了。** `[文档]` ssh 的 D1–D4/U2 四轮验收记录都在文档里、桌面端实机项
   （P10 的 401/404、桌宠多状态、让位协议）也在等重启；dual-model 的「静默丢图」风险点（设计文档自陈
   「绝不静默降级」）**仍未实机闭环**；appearance M2 的 12 组视觉矩阵未拍；canvas V1–V4 的 18 张走查未拍。

6. **上一份报告的 P1/P2 有两处已消除、两处被证实仍在。** `[实测]` ① `appearance/index.js` 的**写失败吞错**
   仍在（`index.js:367-374`：`store.save` 抛错 → `.catch` 只 `logger.error` → **无条件 200 + `changed: true`**，
   客户端据此 `setState` 旧值 ⇒ 用户改动静默回滚）；② fleet-monitor 的 **CORS 通配**
   （`server.js:325`）与 **写接口零鉴权**（`server.js:386-405`）仍在；
   ③ 已修：sidebar 的沙箱假阴性（09-19）、CI 落地（09-14）。

---

## 二、八线状态一览

| 线 | 版本 | 本批（09-14 → 09-26）主要变化 | 代码侧未完成 | 实机验收 |
|---|---|---|---|---|
| **desktop** | `0.1.0`（文档侧仍写 v0.1.4，漂移） | `[实测]` P7 心跳不再驱动 URL、P9 壳不再依赖 `cmd.exe`、P10 鉴权改走官方 token；看门狗已实施（`diag.rs` + `recovery.rs`）；本批清理 6 项死代码 + 1 个孤儿帧 | v3 M3/M4/M5 未开始；启动加载 2.0 的 S1–S3（闪窗根治 / stdout tee）未动；`themes/runtime.js` 1130 行 legacy 回退源待决议 | 全黑挂起根因未收敛（四次 `Application Hang`、WER 无 dump）；P10/桌宠/让位协议待重启验收 |
| **fleet** | `0.20.0` | `[实测]` 无代码改动；本批删 2 个一次性探针脚本 | **G3 未实现**；G1/G4 判定层**仍未接派单**（`dispatch-task.ps1` 只接了 G2）；Worker 生命周期为零；任务级成本上限缺失；**安全三缺口全在** | L4 跨线联动未验收；上次真实派单 09-11 |
| **canvas** | `0.5.0-miasaki.6` | `[实测]` 存储治理（84 MB `workspaces.json` → 20 MB：单条 2000 字符截断 + 每线程 50 条窗口 + 裁剪水位）、`sessions/sync` 恒 400 修复；本批清死代码 5 项 | V5「任务/产物呈现适配」未启动；字重 720→600 未做（`styles.css` 仍有 6 处）；`app.js` 2398 行待重构 | V1–V4 走查 18 张未拍 |
| **sidebar** | `0.10.0-miasaki.0` | `[实测]` 无代码改动；本批清 3 处壳时代残留 + README 两处矛盾订正 | **M2 辅助对话未做**；外部程序跳转未实现；P2/P3 多项 | v0.7.0–v0.10.0 四版待验 |
| **ssh** | `0.1.0-miasaki.0`（**立项至今未升版**） | `[实测]` B1/B2（主页入口 + 会话头胶囊互斥）、B3/B4（官方 chrome 让位与测量时机）；本批清 10 处死代码 | **U2.2 SFTP 未动**（代码侧 grep 零命中）；U3（跳板/转发）未动；侧栏拖动调宽未实现 | 四轮真机验收记录在册，但 U2 验收报告文件名与内容不符（见 §八） |
| **dual-model** | `0.1.3-miasaki.0` | `[实测]` 二轮复审修复（触发钮死件）；本批删 2 处零读取字段 | M2/M3 只有条目无判据；`selectVisionModels` 等 4 项低风险死码待随 M2 清 | **未验收**，验收矩阵仍无双模型专节 |
| **appearance** | `0.1.0-miasaki.0` | `[实测]` 玻璃 `mica` 档 + 原生材质分层（W4.2）、首帧注入 kind 白名单（W4.1） | **M3 动效 / M4 会话效果仅面板占位**；**写失败吞错未修**；`package.json` `files` 缺 `assets/` | M2 12 组视觉矩阵 + 帧率基线待用户 |
| **usage** | `dsh-token-monitor` `0.6.0` | `[实测]` 由 desktop 线迁出独立成第八线；账本按 profile 分区；装法 `file:` → `link:`；本批接线 client bundle 的第 3 项静态防线 | `design/CHANGELOG.md` 此前未入库（**本批已 add**） | 用量 Tab / 侧栏入口 / 账本续写待实机 |

**回归基线（2026-09-26 实测，全量 113 项）**：sidebar 10/10、canvas 12/12、fleet 15/15、desktop 33/33、
ssh 12/12、dual-model 12/12、appearance 16/16、usage 3/3。
**单测规模（各线口径）**：canvas 98 / sidebar 62 / ssh 126 / dual-model 33 / appearance 95 / fleet 108`[文档]` /
desktop Rust 69`[文档]`。

---

## 三、未完成任务项

### A. 治理层（跨线）

| # | 项 | 现状证据 | 成本 |
|---|---|---|---|
| A1 | **无 lint / format 自动化** | `.editorconfig` / `eslint.config.*` / `.prettierrc*` / `biome.json` 全不存在 `[实测]`（与 09-12、09-14 评审逐条一致） | 低 |
| A2 | **无统一工作区根** | 根 `package.json` / `pnpm-workspace.yaml` 不存在 `[实测]`（守住「不引 workspace」既有决议） | 低 |
| A3 | **实机验收矩阵无勾选记录** | `cross/smoke-test-matrix.md` 全文 checkbox 计数 **0** `[实测]`；§2 L2 / §3.3–3.5 / §4 L4 均无结论 | 需一次重启批次 |
| A4 | **CI 注释与配置仍写「七线」** | `.github/workflows/verify-all.yml` 未随第八线（usage）更新 `[审计]` | 低 |
| A5 | **加载路径自动化覆盖不足** | 五个 Web 插件中仅 appearance / usage 有 client 半装载契约测试（usage 的第 3 项静态扫描**本批刚接线**） | 中 |
| A6 | **测试层跨线耦合** | canvas 测试读 desktop 主题源码、ssh 测试读 canvas client 源码 `[审计]`：契约应以常量快照落 `cross/` | 中 |
| A7 | **文档漂移多点** | 见 §八清单（本轮审计共列 30+ 处，按「当前态失真 / 断链 / 缺退役横幅」三类） | 低但量大 |

### B. desktop

**P0**
- 偶发「全黑无响应」根因未收敛：9/5 起四次 `Application Hang`，签名恒定；Mica 假设已推翻、WER 通道已榨干
  （四次 `Report.wer` 无 dump、`LoadedModule entries: 0`）—— 看门狗已实施（`diag.rs`），**剩余是实机验收三项**
  （人为阻塞消息泵是否真落 `crash-*-watchdog.log` / 隐藏到托盘时 `wv.url()` 是否被节流 / release
  `panic="abort"` 下 panic hook 是否落盘），见 `design/TODO.md`。
- 「一打开找不到页面」：P9 处置了 `os error 740` 那一半，**剩下的就绪判据 + 残留清理那一半未做**
  （`port_ready()` 只做 TCP connect，分不清「健康且本 profile / 僵死残留 / 别人的实例」）。

**P1/P2**
- 启动加载 2.0 的 **S1–S3 未动**（闪窗归因与根治、stdout tee 钩子），S4b（日志流 + 四阶段进度）等钩子。
- 安装包 + 卸载、历史会话恢复验证、长时间稳定性观察（≥1h）。
- 桌宠 v3 **M3（快捷审查与提权）/ M4（边缘状态）/ M5（立绘与动作扩容）**未开始；`r7` 行语义错配未修。
- 主题→人格切换自动打开新会话；主题切换视觉漂移核对（需用户机截图）。

**P3 / 技术债**
- 正式 IPC 替代 hash 通道（W1 已给契约 v1，hash 仍是唯一写通道）；`verify-themes.mjs` 沙箱方案；
  `parse_fragment` 纯函数单测；`GHSA-wrw7-89jp-8q8g`（glib 0.18.5，仅 Linux GTK 传递依赖）跟踪。
- **待决议（本轮审计新增）**：`themes/runtime.js`（1130 行 legacy 回退源，唯一引用是不可达分支，且仍带已移除的
  `set_pet_mode` invoke）；`ui/icons/app.png`（43 KB 零消费者，删除须同批改 `build.rs:21` 与 `make-icons.mjs:136-145`）。

**文档**
- `design/HANDOVER.md` 仍写 v0.1.4（2026-08-30 停更），代码侧 `package.json` = 0.1.0；
  `design/ARCHITECTURE.md` §7 文件地图漏掉全部 `plugins/` `patches/` `docs/`；
  `plugins/dsh-session-log-move/README.md` **整段「当前态」仍描述 2026-09-26 已删除的 slot 替换死路**（high）；
  9 处相对链接写成 `../`（应为 `../../`）；`design/HANDOVER-MULTIAGENT.md` 疑为 fleet 线误留（7 个目录 + 5 处文档
  引用全断，但内容可能未被 fleet 线吸收 ⇒ **不可直接删**）。
- `design/desktop-contract.md` 称「hash 写者只有两个」，与 pet-panel 的 `replaceState` 实现不符 —— **可能是真 bug**。

### C. fleet

**安全三缺口（全部仍在）** `[实测]`
- CORS 通配 `Access-Control-Allow-Origin: '*'`（`fleet-monitor/server.js:325`，`sendJSON()` 对所有 JSON 响应施加，
  OPTIONS 预检裸放）；
- `POST /api/toggle/:agentId` 无鉴权（`server.js:386-405`，仅 `..` 过滤，无 Host/Origin/sec-fetch-site 校验）；
- 信任围栏代码完全缺失（对照 sidebar/ssh/appearance 三处均有三道围栏）。
唯一做对：`server.js:422` 只绑 `127.0.0.1`。

**判定层「可查询但未强制」**
- G1 未接派单（`dispatch-task.ps1` 仅接 G2 能力闸门）；G4 未强制挂验证器；G2 未持久化；
- **G3 失败归因与恢复未实现**；Worker 生命周期为零（无 timeout/retry/orphan）；任务级成本上限缺失。

**其他**
- `validate-bus.mjs` 对缺失 `result.json` 静默 `continue` ⇒ 台账标记 `done+accepted` 却无交付物的任务（t-0007/t-0008）
  会被放行（C6 缺口，`tasks/t-0003/result.json` 自陈）。
- **静默断链（与本仓既有教训同型）**：`workers/graph/verifier-pick.mjs:71-73` 读 `shared/agent-vendors.json`，
  该文件**不存在** ⇒ 静默回退 `DEFAULT_VENDORS`，回归照常 PASS，而两处文档宣称「可由该文件覆盖」。
- `schemas/README.md:5-9` 与主协议 `:23` 虚指 tasks/ledger/events/usage 四类 schema（从未存在）；
  `graph-engineering-fleet-design.md:322` 的 G0 清单引用不存在的 `schemas/tasks.schema.json`，同文档 `:690` 却标 G0「✅ 全部实现」。
- `shared/collective-memory.md` **会主动传播已废弃路线**（写「协议 v0.3」实为 v0.22；`dsh-sdk` 常驻 worker 路线已于
  08-17 废弃；给出的 `node --import tsx workers/worker-cli/worker.mjs` 文件不存在）—— 它是活的引用源，**需策展而非删**。
- `docs/multi-agent-cli-orchestrator-design.md:3` 头部版本落后自身变更记录 6 版。

### D. canvas

- **V5「任务/产物呈现适配」未启动**，需单独决议；字重 720→600 未实施（`styles.css` 6 处）；
  §6.6 方案乙未排期；compact 档 `line-clamp:6` 为临时取舍。
- `app.js` **2398 行**（本批清理前 2417），重构在即。
- `loadThreadHistory()` 是**空实现**却被 9 处调用（本批判为「低收益不动」，见 CHANGELOG）。
- V1–V4 实机走查未做（三主题 × 明暗 × 三档共 18 张截图）。
- `docs/architecture.md:61` 的 projection 段未跟上 2026-09-26 存储治理（只写 8000 截断，缺 2000 载荷上限与
  50 条线程窗口）。

### E. sidebar

- **M2 辅助对话未做**（设计完成，待实现后再注册官方 tab 类型）；外部程序跳转未实现（待另立项）。
- v0.7.0–v0.10.0 四版待实机验证；依赖拷贝语义待确认。
- 标题栏注入脆弱性：`MutationObserver` 观察整个 `document.body` 子树且无 rAF/去抖。
- P2 过滤框 + 分支显示未做；P3 三项未做；betterSidebar 兼容层未做；未跟随 DSH 用户字号缩放。
- `untrackedTruncated`（`index.js:413`）是契约外的孤立响应字段；
  `TERMINAL_FALLBACK_ORDER`（`index.js:518`）生产代码从不读（运行时 fallback 在 `:575` 另算），
  仅测试引用 ⇒ **纪律只存在于注释里**。

### F. ssh

- **U2.2 SFTP 未动**、U3（跳板/转发/文本联动）未动（代码侧 `sftp|proxyJump|forwardOut` 零命中）。
- 侧栏拖动调宽未实现（设计承诺 208–288px，实际 `styles.css` 固定 232px）。
- 精确终端恢复 / 全屏 TUI 边界未实现；`plan §13.2` 六项未覆盖。
- 文档：README 5 处仍描述已删除的 `conversation.view` / tab 委托与容器查询；3 处断链（含**桌面线 themes 改名
  导致 `zafkiel.css` / `kurkuriel.css` 断链**）；2 份规划稿头部状态与正文矛盾；
  `design/preview/2026-09-16-ssh-u2-acceptance-report.html` **文件名与内容不符**（实为实施验收包）
  且零入站引用 ⇒ 建议改名 `implementation-report.html` 并补 README 目录树链接（**不宜当重复页删除**）。

### G. dual-model

- **M1 未实机验证**；**验收矩阵无双模型专节**（`smoke-test-matrix.md:13` 声称 L3 覆盖「双模型」，§3 却无清单）。
- 契约义务 2 未闭环（本线最大风险）：设计要求「含图步骤真的走该路由，两个模型都不支持时显式报错，**绝不静默降级**」，
  当前仅纯函数单测。
- M2/M3 只有条目无判据；M2 前置（settings 命名空间）已改为插件自管，阻塞解除但未实施。
- **补丁 README 基线表停在 0.1.7-alpha.2 / `05DAAAF8…` / 锚点 `:780`**，而 `patch.mjs` + baseline 已在 `c5a704e`
  推到 rc.2 / `FB0F7B96…` / 锚点 `:872`（该提交只改了线根 README，漏改补丁 README）。
- 待清死码 4 项（`selectVisionModels` / `providers` 透传 / `shortModel` 不可达分支 / `snapshot(force)` 不可达分支）。

### H. appearance

- **M2 待用户验收**：12 组视觉矩阵（3 皮肤 × 2 明暗 × 2 壁纸）+ 帧率基线 + 桌面壳同页实机项。
- **已知缺陷（真缺陷 + 零测试覆盖）**：配置写入失败被吞掉却回报 200 成功（`index.js:367-374`，详见 §一.6），
  60+ 例测试中**无写失败用例**；临时文件名 `${this.file}.tmp` 未带 pid（`lib/store.js:50`）。
- **发布链风险**：`package.json` 的 `files` 缺 `assets/` ⇒ npm 安装场景下三款位图预设经 `readFileSync` 静默吞错后
  从 `/presets` 清单消失（现状 `link:` 安装无影响）。
- **M3 动效 / M4 会话效果仅面板占位**；M5 未做且 README 漏列。
- 死配置：`wallpaper.blur` + `light/dark` 端到端零消费（M1 遗留，被 M2 玻璃档位取代；删除需 v3→v4 迁移）。
- 4 组双份 id 列表（皮肤 / 预设等）无一致性闸门，漂移无声。

### I. usage

- **`design/CHANGELOG.md` 此前未入库**（被根 README 等 3 处跨线文档引用）—— **本批已 `git add`**。
- `README.md:171` 的面板宽度与实现矛盾；`:309` 声称的「模板字面量平衡」自检在**本批接线前并不存在**（已修）。
- `lib/index.js:94-104` 的 `resolveDataDir` 三档宿主服务探测是否真命中，**本机无 DSH 源码 checkout 无法核实**。
- 实机项：用量 Tab / 侧栏入口 / 账本按 profile 分区后的续写。

---

## 四、与 2026-09-14 报告的差异（核销表）

| 项 | 09-14 报告 | 09-26 实测 | 判定 |
|---|---|---|---|
| CI 未落地（P0） | 草稿在会话目录，有丢失风险 | `.github/workflows/verify-all.yml` 已入库并全绿 | **已修** |
| 无 `.gitattributes`（CI 首跑挂 8 项） | 附录记录了根因 | `* -text` 已在库 | **已修** |
| sidebar 沙箱假阴性 | `terminal-hub.test.js` 受限沙箱整片失败 | 已注入 `resolveBin`，15/15 全绿 | **已修（09-19）** |
| desktop 看门狗（P0） | 源码零命中 | `diag.rs` + `recovery.rs` + Job Object 已实施 | **已修（09-25）**，剩实机验收 |
| desktop 全黑挂起 | 未收敛 | 仍未收敛（但取证能力已建） | 部分 |
| fleet-monitor CORS 通配 | 仍在 | `server.js:325` 仍在 | 未修 |
| fleet-monitor 写接口鉴权 | 无 | `server.js:386-405` 仍无 | 未修 |
| fleet G1/G4 未接派单 | 未接 | `dispatch-task.ps1` 仍只接 G2 | 未修 |
| fleet G3 | 未实现 | 未实现 | 未修 |
| 无 lint/format（P1） | 全不存在 | 仍全不存在 | 未修 |
| appearance 写失败吞错（P2） | `index.js:206-213` | 位置漂到 `index.js:367-374`，行为未改 | 未修 |
| 加载层契约测试 | 仅 appearance 有 | appearance + usage 有（usage 第 3 项本批接线） | 部分改善 |
| 测试层跨线耦合 | 存在 | 仍存在 | 未修 |
| 矩阵无 checkbox（A7） | 0 个 | 0 个 | 未修 |
| canvas `app.js` 行数 | 2417 | 2398（本批清 19 行） | 改善 |
| canvas 测试用例 | 89 | 98 | 增长 |
| 提交数 | 94，两天零提交 | 本批把 12 天积压全部提交 | **已修** |
| 文档漂移（13 处） | 部分已修 | 本轮审计又列 30+ 处（多为**当前态失真**） | 未修（清单见 §八） |

---

## 五、风险优先级

**P0（应立刻处理）**

1. **appearance 写失败吞错**：用户改设置静默回滚且无提示 —— 唯一被代码级证实、却仍无测试覆盖的真缺陷。
   修法：`writeChain` 的 `.catch` 改为**明确失败响应**（500 + 错误信息 + `changed:false`），并补故障注入用例
   （mock `store.save` 抛错）。
2. **shared-docs 的 playwright 补丁 `BASELINE_DSH_VERSION` 仍是 `0.1.7-alpha.2`**（其余 7 件已随 rc.2）⇒
   `scripts/patch-live-audit.mjs` 对该件补丁的「🔴 回归」分支**永不触发** —— 而它恰是 09-26 复发事故的那一件。
3. **实机验收批次积压**：ssh / dual-model / sidebar 四版 / appearance 视觉 / desktop（P10 + 桌宠 + 让位）/
   canvas 走查，全部等一次重启。越晚做，改动叠加后定位成本非线性上升。
4. **dual-model 的静默丢图风险**：准入放行与路由未实机闭环，设计文档自陈「绝不静默降级」。

**P1（两周内）**

5. fleet-monitor 安全三缺口（虽仅绑 `127.0.0.1`，但它是唯一「写接口零鉴权 + CORS 通配」的组合）。
6. appearance 补故障注入用例 + `files` 补 `assets/`。
7. 治理层三件套：`.editorconfig` / 格式检查 / CI 注释改「八线」。
8. 文档「当前态失真」清理：优先修**会让后续读者误判现状**的 5 处 —— desktop 的
   `session-log-move/README.md`、desktop `ARCHITECTURE.md §7`、ssh README 5 处、fleet 的
   `agent-teams-collaboration-gap` 摘要、dual-model 补丁 README 基线表。
9. fleet 的静默断链二选一：补 `shared/agent-vendors.json` 或删 `loadVendors()` 与两处「可覆盖」声明。

**P2（机会驱动）**

10. 文档漂移守卫（把 §八 清单变成闸门，例如 README 版本号与 `package.json` 的一致性检查）。
11. `dsh-miasaki-shared-docs/**` 的历史报告归档策略（43 份，其中 `dsh-platform/` 24 份）。
12. ssh 版本号从未升版（`0.1.0-miasaki.0`）；canvas 字重 720→600。
13. `themes/runtime.js` legacy 回退源与 `ui/icons/app.png` 的处置决议。

---

## 六、建议路线

1. **第一步（分钟级，本批已做）**：把 12 天积压与新清理提交推送（见 §七）。
2. **第二步（一次重启，批次验收）**：ssh 真实连接 + dual-model 三验证点 + sidebar 四版清单 + appearance 视觉矩阵 +
   desktop P10/桌宠/让位 + canvas 18 张走查；**同批给 dual-model 补验收矩阵专节**（否则无判据）。
3. **第三步（半天）**：appearance 写失败修复 + 故障注入测试；playwright 补丁基线常量同步；
   CI 注释改八线；`.editorconfig`。
4. **第四步**：文档当前态失真 5 处（§五.P1.8）+ fleet 静默断链二选一。
5. **第五步**：fleet 围栏 + G3 / C6 强制化；canvas `app.js` 重构；desktop 就绪判据 + 残留清理。

---

## 七、本批整理（清仓）记录

**范围**：仓库级死代码与冗余审计（15 个只读审计员，明细 `_refs/audit-2026-09-26/*.md`）+ 逐条人工复核 + 提交。

**删除（均已复核零引用，且改后各线回归全绿）**

| 线 | 项 | 量 |
|---|---|---|
| canvas | `messagesFromEvents()`（测试遮蔽型死代码）、`connectorPathFromElements()`、`open-current` 死分支、`brand-mark` 死标记、退役「对比页」样式族 22 处 | ≈40 行 + 1 个测试改写 |
| sidebar | `closeNativeDetails()`、`pushInjected` 字段、`.dsh-sidebar-menuicon` 两条 CSS | ≈10 行 |
| fleet | `tests/m3-acp/inspect-raw.mjs`、`inspect-session.mjs`（一次性探针，零引用） | 2 个文件 |
| desktop | 孤儿帧 `whale/states/idle.png`、`lib/types/detect.d.ts`、`__devOnly` ×2、`SettingsSectionPanelProps`、hash 的 `hide`/`show` 死臂、`pet_log` 命令 | 860 KB + ≈60 行 |
| ssh | `currentStatus()`、`get stream()`、`rc.cols/rows/fpToken/fpHash/host`、`ShellChannel.dispose()+disposed`、`parseHostKey()`、`SshStore.exit()`、`DEFAULT_COLS/ROWS` 导出、`ticketTimer`、`rememberLastTab()`、`.fact-line` | ≈60 行 |
| dual-model | `/state` 的 `stickWithinTurn` 字段、`resolveRouteCapability` 的 `known` 字段 | 2 行 + JSDoc |
| usage | 残废的 `reportTemplateHint()`；并把完整的 `scanTemplateLiterals()` **从死代码接线为脚本第 3 项防线** | ≈30 行 |
| shared-docs | playwright 补丁的零引用导出 `TARGET_VERSION` | 1 行 |
| 工作区 | `dsh-miasaki-desktop/.edge-test-profile/`（Edge 测试 profile 残留，已 ignore）、`tests/m3-acp/logs/` 空目录 | 25.9 MB |

**复核中推翻的审计结论（记录以备后续审计复用）**

- `mergePanelCard()` 被判「旧实现」——实测由 `render()` 模板的 `${mergePanelCard()}` 活调用（合并面板对话框）⇒ 保留；
- `LEGACY_CARD_POSITIONS_KEY` / `card-positions:v2` 被当死代码 —— 实为**迁移代码** ⇒ 保留；
- `whale/states/idle.png` 的「frames.json 不引用」证据 —— 实测 `frames.json:100` 的 `states/idle.png` 属 **inverse** 宠物，
  两行看串即误判 ⇒ 结论仍成立（whale 是孤儿），但判据须写明；
- ssh 的 `pet-hide`/`pet-show` 与 `hide`/`show` 是**两对**不同 hash 值（前者活、后者死）⇒ 只删后者。

**入库但未改代码的既有改动（本批一并提交）**：usage 线迁出（9 文件重命名 + 账本 profile 分区）、
desktop P7/P9/P10、canvas 存储治理与 sync 400 修复、ssh B1–B4、shared-docs 平台调研。

---

## 八、文档漂移与断链清单（本轮审计新增，**未修**）

> 按「当前态失真 / 断链 / 缺退役横幅」分类。历史条目（CHANGELOG 内）按体例不改。

**当前态失真（会让读者误判现状，优先）**

| 位置 | 失真内容 |
|---|---|
| `dsh-miasaki-desktop/plugins/dsh-session-log-move/README.md` | 整段「当前态」仍描述 2026-09-26 已删除的 slot 替换死路（high） |
| `dsh-miasaki-desktop/design/ARCHITECTURE.md` §7 | 文件地图漏掉全部 `plugins/` `patches/` `docs/` |
| `dsh-miasaki-desktop/design/HANDOVER.md:10` | 写 v0.1.4，代码侧 0.1.0 |
| `dsh-miasaki-desktop/src-tauri/src/main.rs` 注释 | `diag_console`「写者待接」与实现相反；「反馈问题按钮」与仓库相反 |
| `dsh-miasaki-ssh/README.md`（5 处） | 仍描述已删除的 `conversation.view` / tab 委托与容器查询 |
| `dsh-miasaki-fleet/docs/agent-teams-collaboration-gap-2026-09-11.md:19-20` | 称「派单器无任何依赖判定代码 / 无 `result.json`」，均已被 `f5bc431` 推翻（同文档 `:215` 自相矛盾） |
| `dsh-miasaki-fleet/docs/multi-agent-cli-orchestrator-design.md:3` | 头部 v0.16，变更记录已至 v0.22 |
| `dsh-miasaki-fleet/shared/collective-memory.md` | 写「协议 v0.3」实为 v0.22；含已废弃的 `dsh-sdk` 路线；给出不存在的文件命令 |
| `dsh-miasaki-fleet/schemas/README.md:5-9`、主协议 `:23` | 虚指 tasks/ledger/events/usage 四类从未存在的 schema |
| `dsh-miasaki-fleet/docs/graph-engineering-fleet-design.md:322` | G0 清单引用不存在的 `schemas/tasks.schema.json`，同文档 `:690` 却标「✅ 全部实现」 |
| `dsh-miasaki-fleet/tests/m3-acp/plan.md` | M3 计划所述 dsh-sdk 路线已废弃（但被 2 处追踪文件引用 ⇒ 只加横幅） |
| `dsh-miasaki-dual-model/patches/dsh-api-session-controller/README.md` | 基线表停在 0.1.7-alpha.2 / 旧 SHA / 锚点 `:780`（实际 rc.2 / `FB0F7B96…` / `:872`） |
| `dsh-miasaki-dual-model/design/2026-09-10-dual-model-design.md` | 状态行「未写代码」与正文矛盾；「6 个 lib 模块」实为 5；规划的 `lib/settings.js` / `styles.css` 不存在 |
| `dsh-miasaki-appearance/README.md` | 「让位协议只做提示」与真实让位实现矛盾（另有 8 处待订正） |
| `dsh-miasaki-appearance/design/2026-09-11-appearance-settings-plan.md` | 配置通道决议被推翻却无作废横幅 |
| `dsh-miasaki-usage/README.md:171` | 面板宽度 `minmax(300px,380px)` 与实现 `minmax(0,1fr) minmax(0,1.15fr)` 矛盾 |
| `dsh-miasaki-canvas/docs/architecture.md:61` | projection 段未跟上 2026-09-26 存储治理 |
| `.github/workflows/verify-all.yml` | 注释仍写「七线」（缺 usage） |
| 根 `README.md` | 已在**本批修正** fleet 版本（v0.16 → 0.20.0） |

**断链**

- `dsh-miasaki-ssh/design/*` 引用桌面线 `themes/{zafkiel,kurkuriel}.css` —— 该文件已改名 `*.skin.css`（3 处）；
- `dsh-miasaki-dual-model/design/*` 3 条共 7 处断链 + 1 处 cwd 歧义；
- `dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.7-rc2-upgrade-and-refit-plan-2026-09-25.md` 24 条根相对死链；
- `.github/workflows/verify-all.yml` 与测试夹具 2 处死链；
- `dsh-miasaki-shared-docs/dsh-platform/m36-rc8-regression-2026-08-22.md:21` 把已 ignore 且现为空的
  `fleet/tests/m3-acp/logs/rc7/profile-dump-config.log` 称作「M3.5 基线」⇒ 证据不可复现。

**缺退役横幅的规划稿**

- `dsh-miasaki-sidebar/design/2026-09-08-sidebar-review-redesign-implementation.md`（正文大段描述已删除的自研壳，
  引用的 `test/client-tabs.test.js` 不存在）；
- `dsh-miasaki-sidebar/design/2026-09-09-sidebar-launcher-design.md`（§3 外部程序跳转从未实现；形态决策已被取代）；
- `dsh-miasaki-sidebar/design/2026-09-12-rightbar-optimization-plan.md`（范围仍写「两个官方右栏 tab」，终端已退役）；
- `dsh-miasaki-ssh/design/2026-09-14-ssh-global-panel-plan.md`（被否决路线）；
- `dsh-miasaki-shared-docs/cross/sidebar-plan-2026-09-06.md`、`cross/ab-linkage-pet-fleet-status-2026-08-18.md`。

**其他口径不一致**

- `cross/smoke-test-matrix.md:89` 记 api-routing「9 项」，实际 12 项；ssh 记 113/117，实测 126 例；
  根 README 曾记 canvas 89（现 98）；
- `dsh-miasaki-fleet/agents/claude/transcript.md` 等运行时产物已在 `.gitignore` 覆盖（新 clone 不受影响），
  本地磁盘仍有存量（`agents/*/` 与 `tests/m3-acp/logs/`）。

---

## 附：本报告的证据与可复现命令

```powershell
# 全量静态回归（八线 113 项）
node scripts/verify-all.mjs

# 审计明细（15 份，只读审计员产出，Lead 已逐条复核）
Get-ChildItem _refs/audit-2026-09-26        # 注：_refs/ 已 gitignore，不入库

# 关键复核命令（示例）
rg -n "mergePanelCard" dsh-miasaki-canvas/app.js          # 2 命中＝定义 + render 模板调用 ⇒ 活代码
rg -n "Access-Control-Allow-Origin" dsh-miasaki-fleet/fleet-monitor/server.js   # :325 通配仍在
rg -n "known|stickWithinTurn" dsh-miasaki-dual-model      # 零读取 ⇒ 本批删除
```
