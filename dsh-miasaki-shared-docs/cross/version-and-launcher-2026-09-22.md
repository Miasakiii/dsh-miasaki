# 跨线纪要 · 版本管理与启动器路线（2026-09-22 研讨结论）

> 状态：**研讨定稿（2026-09-22），未实施**。触发：用户提出「是不是该加版本管理 / 做一个启动器还是接一下启动器」。
> 用户拍板：**自用为主**（GitHub 已公开）／ 启动器**先 A 后 B** ／ 版本三个痛（可追溯·防漂移·分发带版本）全治 ／ 本轮只出纪要。

## 1. 现状盘点（2026-09-22 逐项核实）

**版本管理：有版本号，没有版本管理。**

- 七线各自维护版本，语义良好但存在三处漂移风险：
  - 插件包用 `上游版本-miasaki.N`（canvas `0.5.0-miasaki.6` / sidebar `0.9.0-miasaki.0` /
    ssh `0.1.0-miasaki.0` / dual-model `0.1.1-miasaki.0` / appearance `0.1.0-miasaki.0`）——
    **结论：保留此约定**，上游版本 + fork 自增一眼可读；
  - private 线纯 semver（desktop `0.1.0` / fleet `0.20.0`）；
  - 版本号散落 commit message / 各线 CHANGELOG / package.json 三处，**无一致性机制**。
- **desktop 有两个版本源**：`dsh-miasaki-desktop/package.json` 与
  `dsh-miasaki-desktop/src-tauri/tauri.conf.json` 各写一份 `0.1.0`；**安装包版本号
  （产物文件名 / 关于页）取自 tauri.conf.json**，不是 package.json——这是分发语境下
  必须卡住的漂移点。
- git tag 纪律缺失：全仓仅 2 个 tag（`0.1.1-rc.1-era`、`pre-reorg-2026-08-22`），
  重组后 300+ 提交零 tag，出事无法回到「能跑的那一版」。
- DSH 本体基线版本（当前 `0.1.5-rc.1`）在 desktop README / 补丁 README / CHANGELOG 多处手写。

**启动器：事实存在，未正名。**

`dsh-miasaki-desktop/` 的 Tauri 壳已在承担启动器职责：双击 EXE → `spawn_dsh()` 拉起
`dsh web` → loading.html → navigate 3080；[boot-loading 2.0 契约](boot-loading-2026-09-22.md)
（日志流 / 阶段进度 / cmd 闪窗根治）正在把它推向正经启动器。
根 `scripts/` 目前只有 `verify-all.mjs`，无任何一键启动脚本。

## 2. 结论一：版本管理 = 三条纪律 + 一个闸门，不上 changesets

**L0 纪律（必须落 git 追踪文件——根 `AGENTS.md` 被 `.gitignore` 忽略、clone 不到，
纪律只能落库；候选落点：本文件 + 根 `README.md`「版本与发布」节）：**

1. **行为变更必 bump**：插件线自增 `-miasaki.N`；private 线 minor；desktop 的
   `package.json` 与 `tauri.conf.json` **两个版本源同步改**。
2. **里程碑 / 实机验收通过即打 tag**：`<线>/v<版本>`（如 `sidebar/v0.8.1-miasaki.1`）；
   需要「整套复盘」时另打 `suite/vYYYY.MM`（**不引入常驻套件版本号**——七线独立演进，
   人为同步版本号只会制造虚假耦合）。
3. **CHANGELOG 条目与 tag 一一对应**，tag message 指向对应 CHANGELOG 段落。

**L1 防漂移闸门（verify-all 新增检查项）：**

- 各线 `package.json` 的 `version` 与该线 CHANGELOG 最新条目版本一致；
- desktop 附加：`tauri.conf.json` 的 `version` == `package.json` 的 `version`；
- （可选）各线补丁 README 中手写的 DSH 基线版本与一个统一基线值一致。

**分发带版本**：安装包版本**单源化**（`tauri.conf.json` 为准、`package.json` 跟随），
由 L1 闸门卡死漂移；tag 纪律同时服务 GitHub 公开后的外部观察者回溯。

**不上 changesets 的理由**：七线零耦合 + 全部 `file:` 安装进 DSH profile，不存在
registry 发布流，changesets 收益≈0、只添维护面。将来若决定发官方插件市场再议。

## 3. 结论二：启动器 = 先 A 后 B，不新开线

**归属纪律**：launcher **不新开第八线**——Tauri 壳已经在做启动的事，launcher 是
desktop 线的自然延伸（七线零耦合纪律）。

**A（先做，自向）**：根级 `scripts/start-all.ps1`——起 `dsh web` → 轮询 3080 就绪 →
起桌宠 EXE → 可选 fleet-monitor；参数支持只起 / 跳过某部件。目标：消掉「每次开三个
终端」的自用摩擦，零架构风险。

**B（渐进升级 desktop 壳为正式 Launcher）**，四步各自可独立上线、互不阻塞：

| 步 | 内容 | 与现有资产的衔接 |
|---|---|---|
| B1 | 进程管理：`dsh web` 生命周期（退出收尸 / 端口占用检测 / 重启） | 与 boot-loading 2.0 同排期顺接 |
| B2 | profile 切换：miasaki 全家桶 profile ↔ 纯净 profile | 呼应 appearance「关掉即原生」硬契约 |
| B3 | 启动自检：五个 `file:` 插件 linked 状态 + 五个运行时补丁 `patch verify`，全过亮绿灯 | 复用 `patches/*/patch.mjs verify` 与 verify-all |
| B4 | 托盘 / 桌宠运行状态呈现 | 复用 pulse 桌宠↔fleet 联动基础 |

**C（定位为参考 / 兜底，不做主力）**：anywhere-labs DSH Desktop（Electron 打包、
普通用户零装）可作「纯净模式」入口参考；主力仍是自家壳（桌宠 + 三主题不可弃）。

## 4. 后续事项（用户拍板前不动手）

- [ ] L0 纪律正式落点：本文件 + 根 `README.md` 补「版本与发布」节（待用户确认措辞）。
- [ ] L1 闸门：`scripts/verify-all.mjs` 加「版本漂移」检查项（待排期）。
- [ ] A 脚本：`scripts/start-all.ps1`（待排期；PowerShell 为 Windows 自用环境原生选择）。
- [ ] B1 启动时机建议：boot-loading 2.0 实施排期时一并评审（进程管理同属启动链路）。
