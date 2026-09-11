# dsh-miasaki 仓库评审报告（2026-09-11）

> **性质**：仓库级自评（非某一条线的设计文档）。覆盖七线结构、工程方法论、实测健康度、风险与建议。
> **口径**：数据取自 2026-09-11 工作区实测（`HEAD = b160a62`，73 次提交，2026-08-18 起）。
> **方法**：通读根 `README.md` / `AGENTS.md` / 七线 README / `cross/smoke-test-matrix.md` / 关键 design 文档，
> 并实际执行统一回归脚本与 Rust 编译检查。

---

## 0. 结论摘要（五条）

1. **形态清晰**：七条零耦合线围绕单一主题——「以官方扩展点扩展 DSH 平台」，共享一个 git 仓与一个回归入口。
2. **工程规格高于同类个人项目**：103 个入库 Markdown、L0–L4 回归分层、补丁「规则 + 基线 + 离线自证」闭环、
   每线 README + CHANGELOG 双文档。纪律的密度是这份仓库最突出的资产。
3. **实测健康度良好**：六线静态回归全绿（sidebar 9/9、canvas 11/11、fleet 15/15、ssh 9/9、
   dual-model 10/10、appearance 9/9）；desktop 7/8，唯一失败项经归因为**工具链环境假阴性**，非代码缺陷（§4.2）。
4. **主要欠账是「实机验收」而非「代码实现」**：ssh / dual-model / sidebar v0.6.0 / fleet L4 均已完成代码与静态回归，
   卡在一次重启 host 的实机验收上；appearance 已于当日完成实机首跑并修复首轮暴露的整包加载失败（§5）。
5. **两处真实风险**：desktop 的 P0 偶发挂起（取证通道已耗尽，唯一未试通道是进程内看门狗）；
   fleet 的判定层与执行层脱节已于当日接线（§6.2），但验证器仍未强制挂载。

---

## 1. 项目形态

| 维度 | 事实 |
|---|---|
| 主题 | Miasaki 专属 DSH（DeepSeek Harness）周边扩展 |
| 仓库 | 单 git 仓承载七条互不耦合的线 + 共享参考 |
| 提交 | 73 次，2026-08-18 → 2026-09-10 |
| 入库文件 | 约 446 个（desktop 245 / fleet 101 / canvas 25 / shared-docs 20 / sidebar 20 / dual-model 18 / ssh 17） |
| 代码规模 | 约 4.4 万行（js / mjs / cjs / rs / css / html） |
| 文档规模 | 103 个入库 Markdown（+ appearance 线 4 个未入库） |
| 宿主版本 | DSH 0.1.5-rc.1 / Node v24.15.0 |
| 统一入口 | `node scripts/verify-all.mjs [线名]` |

**零耦合的实现方式**：七线之间不互相 import，唯一的共享物是 `dsh-miasaki-shared-docs/`；
跨线引用一律写成 `../dsh-miasaki-shared-docs/…` 相对路径，保证 clone 后不断链。

---

## 2. 七线画像

| 线 | 包名 / 版本 | 代码规模 | 定位 | 当前状态 |
|---|---|---|---|---|
| desktop | `miasaki-desktop` 0.1.0 | 17,177 行 / 45 文件 | Tauri 2 薄壳 + Win32 桌宠 + 三主题 + 4 个 web 插件 | 已实机运行；含 5 个本体补丁 |
| fleet | `miasaki-fleet` 0.20.0 | 6,877 行 / 28 文件 | 多 Agent CLI 编排（文件总线为唯一通道） | 判定层已接线（2026-09-11） |
| canvas | `@miasaki/dsh-canvas` 0.5.0-miasaki.5 | 5,913 行 / 10 文件 | 会话布：可浏览 / 分支 / 合并的视觉工作区 | M1–M4 收官，实机验收 |
| sidebar | `@miasaki/dsh-sidebar` 0.6.0-miasaki.0 | 2,927 行 / 8 文件 | 官方右栏 tab：审查 / 终端 | v0.6.0 迁移后待复验 |
| ssh | `@miasaki/dsh-ssh` 0.1.0-miasaki.0 | 2,421 行 / 10 文件 | 会话头 SSH 视图 + 交互终端 | M1 实现完成，待真实连接验证 |
| dual-model | `@miasaki/dsh-dual-model` 0.1.0-miasaki.0 | 7,333 行 / 12 文件 | 会话级「主 + 辅模型」，含图片准入补丁 | M1 完成，待实机验证 |
| appearance | `@miasaki/dsh-appearance` 0.1.0-miasaki.0 | 1,203 行 | 设置页「外观」栏（皮肤 / 壁纸 / 动效） | 实机首跑完成，§3.5 清单待跑 |

### 2.1 按「与 DSH 的耦合深度」再分类

这个视角比按功能分类更能反映维护成本：

| 层级 | 线 | 升级风险 |
|---|---|---|
| 零侵入（官方插槽 / 服务 / 路由 / WS） | canvas、sidebar、ssh、appearance | 低——DSH 升级通常无损 |
| 近零侵入（扩展点 + 一行本体补丁） | dual-model | 低——补丁失效时自动回落原生分支 |
| 令牌层覆盖 | desktop 主题 / 桌宠 / 4 个 web 插件 | 低——令牌面漂移由 `tokens:diff` 告警 |
| 改本体（唯一例外） | desktop 的 5 个运行时补丁 | **中——升级即被覆盖，需重打** |
| 完全独立 | fleet | 无——不依赖 DSH 宿主 |

**结论**：整仓的升级风险被收敛到一个很小的面（5 个补丁），且这个面有完整治理（§3.3）。

---

## 3. 工程方法论（四项可复用实践）

### 3.1 回归分层 L0–L4

| 层 | 内容 | 载体 | 可自动化 |
|---|---|---|---|
| L0 | 静态检查（语法 / 令牌完备性 / 令牌漂移 / 补丁自证） | `scripts/verify-all.mjs` | 是 |
| L1 | 单线单测（含 fleet 总线校验、图判定） | 同上 | 是 |
| L2 | 插件加载（装 profile → 重启 host → 刷新） | `smoke-test-matrix.md` §2 | 否 |
| L3 | 实机冒烟（桌面壳 / 窗口 / 主题 / 桌宠 / 各插件） | 同上 §3 | 否 |
| L4 | 跨线联动（pulse → 桌宠、主题 → 画布、标题栏让位） | 同上 §4 | 否 |

**关键实现决策**：`verify-all.mjs` 不用 `node --test`（它会为每个测试文件 spawn 子进程并管道捕获，
在受限沙箱下以 `EPERM` 失败），而是直接 `node <file>` 逐文件执行、`stdio: 'inherit'`，以退出码判定。
这条注记解释了「为什么脚本要绕开标准测试运行器」，避免了后来者「优化」回去。

### 3.2 文档纪律

- 每条线：`README.md`（状态 + 目录 + 验证命令）+ `design/CHANGELOG.md`（变更记录）+ `design/*.md`（设计决策）；
- 跨线：`shared-docs/cross/`（契约与回归矩阵）+ `shared-docs/dsh-platform/`（平台调研与升级回归）；
- `AGENTS.md` 定义缓存卫生、目录职责、提交纪律与**会话收尾清单**（每条 `git status` 的 M/?? 都能点名）。

**已发现的文档漂移（建议顺手修）**：

| 位置 | 问题 | 状态 |
|---|---|---|
| `cross/smoke-test-matrix.md` §1 基线表 | 仍写 sidebar 8 项 / canvas 9 项 / fleet 5 项 / desktop 7 项，且缺 ssh、dual-model、appearance 三行 | **已修**（2026-09-11 重跑后七线化，并补 desktop 环境假阴性注记） |
| `dsh-miasaki-canvas/README.md` 状态段 | 写 `v0.5.0-miasaki.1`，而 `package.json` 与根 README 均为 `0.5.0-miasaki.5` | **已修**（标注 MVP 收官版本与当前包版本） |
| `dsh-miasaki-sidebar/README.md` | 大段「自研右栏壳」描述已自标失效（壳已退役），死代码与文档同步待第二阶段清理 | 未修（留待第二阶段） |

### 3.3 补丁治理（本仓最有价值的机制）

6 个「改本体」补丁（desktop 5 + dual-model 1）统一遵守同一契约：

```
patches/<包名>/
├── patch.mjs            # 规则（EDITS）+ 命令（verify / status / apply / revert）
├── baseline/            # 官方原版 + 补丁产物（双基线，逐字节可比对）
├── rebuild-baseline.mjs # 升级后用新版官方文件重建基线
└── README.md            # 升级后重打流程
```

- `patch.mjs verify` 纯离线：由 baseline 原版重建产物并与记录 SHA 逐字节比对——
  它证明的是「补丁规则与基线自洽」，因此**DSH 升级覆盖补丁后该项仍应 PASS**；
- 代码类补丁（trajectory / chat / cordis-host-runner）的 verify 还会把注入的函数从重建产物里抠出来
  跑 fixture 行为断言，并对 baseline 原版跑反例以证明断言有区分力；
- `status` 报 `unknown` 即为「需重打」的信号。

### 3.4 跨线契约显式化

- `ab-linkage-pulse-v2-2026-09-04.md`：fleet 发布 `fleet-pulse.json` → desktop 桌宠 2s 轮询的状态映射契约；
- canvas 的「外部视图槽」：页面级注册表 `window.__DSH_CANVAS_VIEW_ITEMS__` + `canvas:view` 广播，
  **canvas 不认识任何具体视图**，首个使用者是 ssh 线——把跨插件耦合降到「一个通用契约」。

---

## 4. 本次实测

### 4.1 统一回归结果

```
node scripts/verify-all.mjs
  PASS  sidebar: 9/9
  PASS  canvas: 11/11
  PASS  fleet: 15/15
  FAIL  desktop: 7/8
  PASS  ssh: 9/9
  PASS  dual-model: 10/10
  PASS  appearance: 9/9
失败项：[desktop] cargo test (pulse stale 语义) → exit 101
```

（同日 20:43 复核：fleet 由 14 项增至 **15** 项——新增「dispatch 能力闸门接线」守卫；appearance 由 8 项增至
**9** 项——新增 `test/client.test.js`，均为当日增量工作，非本报告口径变化。）

### 4.2 desktop 失败项归因：工具链环境问题，非代码缺陷

**证据链**：

1. 报错为 `link: missing operand after '\377\376'` + `link.exe returned an unexpected error`；
2. `which -a link.exe` → `/usr/bin/link.exe` —— 这是 **Git 自带的 GNU coreutils `link`**，
   在 Git Bash 的 PATH 中排在 MSVC 链接器之前，导致 `link.exe` 解析到错误的程序；
3. `cargo check --bin miasaki --tests` → `Finished dev profile in 10.93s`（**编译无误**，
   失败只发生在链接阶段）。

**正确跑法**：在 VS 2022 的 x64 开发者环境（`vcvars64.bat` / x64 Native Tools Command Prompt）
或带 MSVC 环境的 PowerShell 中执行 `cargo test --bin miasaki`。

**建议**：把这条注记写进 `AGENTS.md` 的「验证方式」一节或 desktop README，
否则每次在 Git Bash 中跑统一回归都会把 desktop 误判为回归失败。

### 4.3 工作区状态

- 已跟踪文件改动 **33 个**（+1832 / −129），未跟踪 **43 项**（2026-09-11 20:5x 复核）；
- 分布：desktop 改 4 / 新 17、fleet 改 11 / 新 6、canvas 改 4 / 新 3、sidebar 改 4 / 新 1、
  ssh 改 5、appearance 新 15、shared-docs 改 1 / 新 1、根级改 3；
- 未跟踪中包含**实质资产**：`dsh-miasaki-appearance/`（整条新线，15 文件）、
  desktop 的 4 个新补丁目录（各含 `patch.mjs` / `rebuild-baseline.mjs` / `baseline/*.original.js` / `README.md`）、
  fleet 的当日增量（`state/graph-events.jsonl`、t-0003 / t-0004 的 `result.json`、两份 docs）、
  canvas 的 2 个新测试文件与 1 份设计文档、sidebar 的 `rightbar-guide.test.js`；
- 按 `AGENTS.md` 的收尾清单，这些都应能点名归属并入库——目前是最大的流程缺口。

---

## 5. 健康度评估

| 线 | 代码 | 静态回归 | 实机验证 | 说明 |
|---|---|---|---|---|
| desktop | 通过 | 通过 | 通过 | 主题 / 桌宠 / V4 标题栏均已实机；P0 挂起未定位（§6.1） |
| fleet | 通过 | 通过 | 部分 | 判定层已接线（2026-09-11，§6.2）；L4 联动仍靠人工核对 |
| canvas | 通过 | 通过 | 通过 | M1–M4 全部实机验收 |
| sidebar | 通过 | 通过 | 待复验 | v0.6.0 官方右栏迁移后未记录复验结论 |
| ssh | 通过 | 通过 | 待验证 | 待重启 host 验证真实 SSH 连接 |
| dual-model | 通过 | 通过 | 待验证 | 待实机验证图片路由与准入补丁协同 |
| appearance | 通过 | 通过 | 部分 | 实机首跑已完成（暴露并修复 `module is not defined` 整包加载失败）；§3.5 完整清单待跑 |

---

## 6. 风险清单

### 6.1 P0 · desktop 偶发「全黑无响应」（未收敛）

- 已发生 4 次（09-05、09-09 ×2、09-10），签名恒定（`P4=c27d` / `P5=67246080`）但跨两次构建；
- 嫌疑区间已收窄到 **2026-09-01 16:01 → 09-04 16:02**（运行时拆分 / 桌宠模块化 / GDI 兜底 / 令牌漂移 / Fleet 指示器）；
- **取证通道已耗尽**：提权读取的四次 `Report.wer` 均无 dump、`LoadedModule entries: 0`，
  既拿不到挂起瞬间线程栈，也拿不到 hung module——只能靠排除法；
- 已排除：Mica / 透明窗口、WebView2 版本与崩溃、跨进程挂起、cookie 401、dsh 后端、GPU TDR、待机冻结；
- **唯一未试通道**：进程内看门狗（检测消息循环心跳超时即落盘线程栈，可选自动恢复）
  或外部监控在 `Responding=False` 时抓 dump。

### 6.2 fleet 判定层接线（2026-09-11 已落地，剩余风险收窄）

- G0（总线契约与 applier）、G1（任务图就绪度）、G2（能力图）、G4（异构验证器）均已落地并有单测覆盖；
- **原缺口**：`dispatch-task.ps1` 此前没有任何依赖判定代码——G0–G4 属于「高质量的未接线组件」；
- **当日已接线**：`Resolve-RequiredCaps` + `Test-CapabilityGate` 落进 `dispatch-task.ps1`，
  能力闸门同时纳入 `-CheckOnly`，使其成为「能不能派」的完整判定；**零行为变更**
  （brief 未声明 `requires` 时跳过闸门）。首个真实 CLI 派单（t-0003）跑通全链路，总线版本 3 → 4，
  `task-ready --dispatchable` 已无积压；
- **剩余风险**：验证器（G4）仍是 Commander **可查询**而非**强制**——高风险任务应挂验证者而未挂时无告警。

### 6.3 次要风险

| 风险 | 说明 |
|---|---|
| 实机验收欠账集中 | 五条线等待一次重启 host 的批次验收；越晚跑，改动叠加越难定位问题 |
| 补丁与插件必须同版本上线 | dual-model 的补丁负责「放行」、插件负责「有人能处理图片」；只打前者会导致图片被静默丢弃 |
| 令牌面漂移 | DSH 升级后 `tokens:diff` 只告警不阻塞，需人工判断 |
| 依赖安全（低） | `glib 0.18.5` unsoundness（GHSA-wrw7-89jp-8q8g）仅经 Linux GTK 目标传递，不进 Windows 产物，已按 not_used 驳回 |
| 文档漂移 | 见 §3.2 表；基线表与包版本号需同步 |

---

## 7. 建议路线（按优先级，含 2026-09-11 当日执行状态）

1. **入库当前工作区（待执行）**：appearance 整条线、desktop 的 4 个新补丁目录、fleet 当日增量
   （dispatch 闸门接线 + `graph-events.jsonl` + t-0003 / t-0004 交付物）——这是唯一「只存在于工作区」的实质资产；
2. **一次重启，批次验收（待执行）**：集中跑 L2/L3——ssh 真实连接、dual-model 图片路由、
   sidebar v0.6.0 复验、appearance §3.5 完整清单（含「关掉即原生」逐像素比对）；
3. **AGENTS.md 环境注记（当日已完成）**：`link.exe` 遮蔽问题已写入「工作区卫生 → 验证方式」（§4.2）；
4. **fleet 接线（当日已完成主体）**：能力闸门已进派单器（§6.2）；剩余项是把 G4 验证器从「可查询」变「强制」；
5. **desktop P0（未动）**：实现进程内看门狗——WER 通道已证明无效，这是唯一剩下的取证路径；
6. **文档同步（当日已完成主体）**：回归矩阵 §1 基线表与 canvas README 版本号已修；
   sidebar README 的自研壳死代码段留待第二阶段清理。

---

## 8. 附录：数据来源与命令

```bash
# 规模统计
git ls-files <线目录> | wc -l
git ls-files <线目录> | grep -E '\.(js|mjs|cjs|rs|css|html)$' | xargs wc -l

# 统一回归
node scripts/verify-all.mjs                        # 七线全量
node scripts/verify-all.mjs sidebar canvas ssh dual-model appearance   # 指定线

# desktop Rust 单测（必须在 MSVC 环境）
cd dsh-miasaki-desktop/src-tauri && cargo test --bin miasaki

# 仓库状态
git log --oneline -20 ; git status --short ; git diff --shortstat
```

| 数据项 | 值 |
|---|---|
| HEAD | `b160a62` |
| 提交数 | 73（2026-08-18 → 2026-09-10） |
| 入库 Markdown | 103 |
| 代码行数合计 | 约 4.4 万 |
| 本次回归 | 六线全绿（sidebar 9 / canvas 11 / fleet 15 / ssh 9 / dual-model 10 / appearance 9）；desktop 7/8（环境假阴性） |
