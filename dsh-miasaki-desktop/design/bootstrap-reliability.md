# 启动可靠性（Bootstrap Reliability）设计

> 状态：设计定稿（2026-08-24）。依据：deepseek-harness-desktop（dsh-plugin-desktop）源码调研
> （2026-08-24，scheme：`desktop-boot-recovery.ts` / `profile-manager.ts` / `startup-recovery-controller.ts` /
> `docs/operation-reliability-matrix.yaml` / `windows-agent-presets.ts`）。本文件是「做什么、为什么、怎么验收」，
> 落地顺序见 `TODO.md`，实现细节见 `ARCHITECTURE.md`。

## 1. 目标

让 Miasaki 的启动链路从「探活重试页」升级为「**能诊断、能恢复的失败页**」，并让每次启动的结果
**落盘留痕**，使 DSH 未安装 / 端口被占用 / 中途闪退等场景不再需要用户瞎猜：

- **失败可诊断**：失败页展示具体失败原因（哪个阶段、哪条错误、上次失败发生在何时）；
- **失败可恢复**：一键动作——重试 / 打开终端 / 打开日志目录 / 导出诊断摘要 / 检查 dsh 安装；
- **启动有留痕**：`bootstrap.json` 记录每次启动的阶段与结果，下次启动时直接读取并在失败时提示；
- **无盲区**：与 TODO P0「异常兜底」、P1「启动失败测试用例」「安装包+卸载」对齐。

## 2. 现状盘点（事实核对过）

| 项目 | 现状 | 缺口 |
|---|---|---|
| loading.html | 探活/拉起状态 + 重试按钮；`__setStatus` / `__setRetry` 由 Rust eval 驱动 | 无失败原因展示、无恢复动作、无上次状态读取 |
| main.rs `spawn_dsh` | `cmd /C dsh web --no-open`，spawn 失败仅 `set_status` 文本 | 错误不落盘；不区分「dsh 未安装」与「spawn 其他错误」 |
| 端口探活 | `port_ready()` 300ms 超时、400ms 轮询，无限循环 | 无「长时间未就绪」提示（可能端口被占用） |
| 状态持久化 | `window.json` 直接 `fs::write`；`pet.json` 由 pet_native 写 | **非原子写**（进程崩溃/断电可半写）；无版本字段 |
| 日志 | `server.log`（dsh stdout/stderr）+ `pet.log`（Rust 自记） | 无「一键收集」入口，用户需手动找路径 |
| 启动结果 | 无任何记录 | 下次启动不知道上次发生了什么 |

## 3. 借鉴映射（对方 → 我们）

| 对方设计 | 我们吸收的**原则**（不照搬实现） |
|---|---|
| `desktop-boot-recovery.ts`：恢复控件挂在 boot 页、同源注入、framework-free | 恢复动作与 UI 同页（loading.html），**不依赖 DSH Web UI 加载成功** —— 失败的场景正是主 UI 起不来 |
| recovery 窗口动作：打开终端/导出诊断/回滚/切换配置 | 我们映射为：打开终端 / 打开日志目录 / 导出诊断摘要 / 重试 |
| 每次动作需 preview 确认（防误触） | 破坏性动作才有确认；我们 v1 全部为只读/无害动作，无需 preview |
| `operation-reliability-matrix.yaml`：每个操作声明 persistedState(原子写)/recovery/evidence/faultContracts | bootstrap.json 声明原子写 + 版本 + 损坏回退；启动各阶段写 evidence；每阶段缺陷配测试（见 §7） |
| profile 状态机 `{version, active, pending, lastKnownGood}` + corruption: fail-loud | bootstrap.json v1：`{version, lastAttempt, lastOk}`；损坏 → 删除重建（fail-loud 的轻量版：不猜测、恢复默认） |
| `renderer-boot.ts` / 健康标记：Web 加载成功后才提交 healthy | 导航到 3080 **成功加载**（on_page_load 匹配 3080）后才写 `lastOk`——与「探活成功但页面白屏」区分 |
| `windows-agent-presets.ts`：平台守卫 + 默认预设永远安全 | 我们的人格联动（阶段 C，另立项）：预设缺失/损坏时白名单校验 + 语义降级 |

## 4. 设计

### 4.1 BootstrapState（`%LOCALAPPDATA%\miasaki\bootstrap.json`，v1）

```jsonc
{
  "version": 1,
  "lastAttempt": {           // 最近一次完整启动尝试（进程启动即写 attempt）
    "at": "epoch秒",         // chrono_now 同源格式
    "phase": "bootstrap",    // bootstrap | spawn | waiting | failed | up
    "detail": "错误原文（可空）",
    "dshAvailable": true     // spawn 前 where dsh 探测结果
  },
  "lastOk": {                // 最近一次成功进入 3080 的时间（on_page_load 写）
    "at": "epoch秒"
  }
}
```

**写入规则（原子写铁律：temp + rename，所有状态文件统一）**：

| 时机 | 写什么 |
|---|---|
| 进程启动（setup） | `lastAttempt = {phase: bootstrap}` |
| spawn_dsh 前 | `dshAvailable = where dsh 结果`；失败 → `phase: spawn, detail: 错误原文` |
| spawn 后轮询 | 每 3s 更新 `phase: waiting`（轻量，避免每 400ms 写盘） |
| 导航 3080 成功（on_page_load 匹配） | `phase: up` + 更新 `lastOk` |
| 轮询超时（90s 未就绪） | `phase: waiting` + detail「端口 3080 长时间未就绪，可能被其他程序占用」 |

- 损坏处理：JSON 解析失败 / version ≠ 1 / 字段缺失 → **删除文件重建默认**（不静默零值）。
- 原子写：`write temp → rename`（借鉴 window.json 的既有风险点顺手修正：save_window_state 同步改造）。
- 不做「每次启动清空 history」：v1 只保留 lastAttempt/lastOk 两个点，够诊断。

### 4.2 失败页（loading.html 升级）

状态机（Rust 侧 eval 仍为主驱动，页面自持 `__setStatus/__setRetry` 不变）：

```
启动页 WebviewUrl::App("loading.html")
  ├─ JS 初始化时 invoke('bootstrap_state')
  │    └─ 上次 lastAttempt.phase ∈ {spawn, waiting} → 显示「上次启动异常」卡片（时间/原因/是否成功过）
  ├─ Rust 实时: set_status / __setRetry
  ├─ spawn 失败 → 显示失败卡片（原因 + 动作按钮组）
  └─ 失败卡片动作（全部自定义命令，本地页可 invoke，无需新 ACL）:
       ├─ 重试            → invoke('retry_start')（现状）
       ├─ 检查 dsh        → invoke('dsh_check') → 显示 where/version 结果
       ├─ 打开终端        → invoke('open_terminal') → cmd /K（用户手动执行 dsh web）
       ├─ 打开日志目录    → invoke('open_logs_dir') → explorer %LOCALAPPDATA%\miasaki
       └─ 导出诊断摘要    → invoke('export_diagnostics') → 聚合 txt 到 %APPDATA%\com.miasaki.desktop\，提示路径
```

- 视觉：沿用现有暗紫风格；失败卡片为红色提示（#c23a2e 已有品牌色），按钮样式复用 #retry。
- 加载中不展示卡片；90s 超时后 `__setRetry(true)` + 状态文本说明端口占用排查方法。

### 4.3 dsh 检测与语义化错误

| 场景 | 判定 | 提示 |
|---|---|---|
| dsh 未安装 | `where dsh` 无结果 | 「未检测到 dsh，请安装 DeepSeek Harness……（附安装指引）」，提供检查/打开终端 |
| spawn 失败（其他） | 错误原文 | 失败卡片 + 打开日志目录 |
| 端口占用 | 90s 未就绪但 spawn 成功 | 「端口 3080 长时间未就绪」+ netstat 排查指引（打开终端按钮） |
| 单实例冲突 | tauri-plug-in-single-instance（现状已处理） | 二次启动仅唤起（不变） |

### 4.4 新增/修改命令

| 命令 | 作用 | 安全边界 |
|---|---|---|
| `bootstrap_state` | 返回 BootstrapState 摘要（安全投影，不含全量路径） | 只读 |
| `dsh_check` | `where dsh` + `dsh --version`（1.5s 超时），返回文本 | 只读 |
| `open_terminal` | `cmd /K` 新窗口 | 无（用户自决） |
| `open_logs_dir` | explorer 打开日志目录 | 只读 |
| `export_diagnostics` | 聚合 server.log + pet.log + bootstrap.json + window.json + pet.json → `diagnostics-<ts>.txt`（≤1MB 截断），返回路径 | 只读副本 |

导出 v1 为聚合文本（零 crate 依赖守则）；v2 若需 zip 再评估手写 stored-ZIP 或 `Compress-Archive`。

## 5. 分级清单

### P0 · 第一部分（本次实施）

- [x] §4.1 BootstrapState 落盘（bootstrap.ts 同源 Rust 实现，原子写）
- [x] §4.2 loading.html 失败卡片 + 动作按钮组
- [x] §4.3 dsh 检测（where dsh）+ 语义化错误
- [x] §4.4 五个命令（bootstrap_state / dsh_check / open_terminal / open_logs_dir / export_diagnostics）

### P1 · 第二部分

- [ ] 启动失败三条用例自动化（dsh 未安装 / 端口占用 / 单实例冲突）→ smoke-test.ps1 扩展
- [x] `window.json` / `pet.json` 原子写 + 版本字段（pet.json `version: 1`，损坏回默认；
  2026-08-29 落地：window.json 原子写此前完成；pet.json 本次含位置可见性校验 + hide 持久化）
- [ ] 安装包构建流程文档化（NSIS 需用户机）+ 首次启动 dsh 检测引导
- [ ] 打开终端按钮的「诊断专用 tab」预填常用命令

### P2 · 第三部分（观察后定）

- [ ] 诊断导出升级 zip（保留上限，对齐对方 bounded zip）
- [ ] 「人格联动」平台守卫（windows-agent-presets 思路，预设白名单 + 降级）
- [ ] 操作可靠性矩阵表落地 design/（pet.compose / theme.commit / session.create / bootstrap / pet.json）

## 6. 验收标准

1. **dsh 未安装**：删 PATH 中 dsh → 启动 → 失败卡片显示「未检测到 dsh」+ 动作按钮可用（打开终端/导出诊断/重试）。
2. **端口占用**：`dsh web` 后手动 kill 端口持有者模拟异常 → 90s 内提示超时原因；再次启动 90s 超时提示后
   `bootstrap.json` `phase: waiting` + detail 正确。
3. **中途闪退**：加载页阶段强杀进程 → 重启 → 失败卡片显示上次异常（spawn/waiting），不影响本次正常启动
   （本次成功则卡片自动消失）。
4. **bootstrap.json**：每次启动都更新；损坏内容（写入垃圾字节）→ 应用仍正常启动且文件被重建。
5. **导出诊断**：文件生成、内容含 server.log 尾部 + pet.log 尾部 + 系统版本与关键时间戳；路径提示可点击。
6. **回归**：正常启动路径（探活→导航）无变化；smoke-test.ps1 通过；gen-init 令牌校验通过。

## 7. 故障契约（对齐对方 faultContracts 思路，P1 自动化）

| 契约 | 期望行为 | v1 人工验证 |
|---|---|---|
| bootstrap.commit.disk-full | 写 bootstrap.json 失败不阻塞启动（仅记 pet.log） | ✓（无法写盘时仍进入等待/导航） |
| bootstrap.state.corrupted | 损坏 → 删除重建默认 | ✓ 用例 4 |
| bootstrap.state.atomic | 任何时刻不存在半写文件 | ✓ 代码审查 + 用例 4 |
| spawn.failure.retry | 失败后重试可再次 spawn（LAUNCHING 置位不阻塞） | ✓ 用例 1（修复后重启 dsh 场景） |

## 8. 风险与边界

- **loading 页 invoke 权限**：loading.html 是本地页（`WebviewUrl::App`），自定义命令无需新增 ACL；
  远程 3080 页仍受 `remote-dsh.json` 限制（不暴露这些命令给 DSH 页面——它们对远程页不可见）。
- **hash 通道不受影响**：本轮不触碰 runtime.js / hash 通道 / 桌宠链路。
- **错误文本安全**：spawn 错误原文可能含路径，export 导出时仅当前用户可读（默认用户目录权限）。
