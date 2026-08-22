# M36 rc.8(+) 回归冒烟报告

- 日期：2026-08-22
- 执行者：总指挥（Miasaki 会话）
- 对象：本机已升级的全局 dsh CLI（实测 **0.1.1-rc.1**，非计划文档原记的 rc.8；npm dist-tags 现状 `latest=0.1.1-rc.2 / next=0.1.1-rc.2`，本机装的是 rc.1）+ 既有 `.dsh/profiles/{m3-test,rc7-test}` 混装 profile，对照 M3.5 基线（rc.6 时代 CLI 加载 rc.7 家族）
- 结论速览：**关键路径无回归——profile 混装 `--dump-config` 双双 exit 0，rc7-test 插件树与 M3.5 基线 313 行字节级一致；三主题端到端校验在真机首次完整跑通（18/18）。附带修正一个自初版起即不可满足的陈旧断言。registry 重扫 8/8，dsh 档案版本过期已修。**

## 1. 背景与口径修正

- `docs/next-tasks-plan-2026-08-20.md` P1-2 记的目标是「rc.8 回归冒烟」。实测本机全局 CLI 已再升一级线到 **0.1.1-rc.1**（rc.8 之后），dist-tags 最新已到 rc.2。冒烟按「在当前实际在跑的 CLI 上验证」原则推进，结论对 rc.8 同样成立（rc.8 ⊆ 0.1.1-rc.1 范围内的加载路径）。
- 版本面（npm 实测，2026-08-22）：
  - `@deepseek-ai/dsh` → `{ latest: 0.1.1-rc.2, next: 0.1.1-rc.2 }`
  - `@deepseek-ai/dsh-base` → `{ latest: 0.0.1-rc.1, next: 0.1.1-rc.2 }`
  - 本机全局 CLI = 0.1.1-rc.1（自带 `@deepseek-ai/cordis@4.0.1` + `@deepseek-ai/dsh-base@0.1.1-rc.1`）

## 2. 方法

1. 绕开 PATH 上 dsh 的 sh shim 在本受限 shell 里的路径转换缺陷（`/c/Users` 被解释成 `c:\c\Users` → MODULE_NOT_FOUND，纯环境问题，cmd/PowerShell 下 `dsh.cmd` 正常），直接 `node …/lib/bin.js` 调用。
2. 在全局 0.1.1-rc.1 CLI 下加载 `m3-test` 与 `rc7-test` 两个混装 profile，跑 `--dump-config`，记录 exit code。
3. `diff --strip-trailing-cr` 对比 rc7-test 新 dump 与 M3.5 基线 `tests/m3-acp/logs/rc7/profile-dump-config.log`。
4. 后台拉起 `dsh web --no-open --port 3080`，跑 `desktop/scripts/verify-themes.mjs`（无头 Edge + CDP 端到端注入校验）。
5. 跑 `workers/discovery/scan-agents.ps1` 重扫 fleet，刷新 `agents/registry.json` 与各 manifest 的 `cli` 字段。
6. 测试结束停掉临时 DSH 服务，恢复 3080 端口测试前的关闭状态。

## 3. 结果

### 3.1 profile 混装加载（核心）

| profile | 全局 CLI | `--dump-config` exit | 判定 |
|---|---|---|---|
| m3-test | 0.1.1-rc.1 | **0** ✅ | 无回归；pnpm 布局 profile（dsh-subagent-dsh-sdk@0.0.1-rc.1）加载正常 |
| rc7-test | 0.1.1-rc.1 | **0** ✅ | 无回归；npm 全家桶（dsh-*@0.1.0-rc.7 + subagent@0.0.1-rc.1）加载正常 |

- cordis 由全局 CLI 自带（4.0.1），profile 只供插件包——混装模型成立，与 M3.5「rc.6 CLI 加载 rc.7 家族」同型。
- **rc7-test 插件树与 M3.5 基线 313 行完全一致**（`diff --strip-trailing-cr` exit 0，零内容漂移）。这是本次最关键的无回归证据。

### 3.2 三主题端到端校验（桌面端 P1-3）

首次在真机完整跑通 `verify-themes.mjs`（此前因无头 Edge 命名管道限制未在沙箱跑成）。结果 **18/18 通过**。

| 主题 | 关键断言 | 结果 |
|---|---|---|
| pure | 属性 / 切换条 / 无水印 / 不干预明暗 | 4/4 ✅ |
| zafkiel | 强制暗色 / 墨夜基底 `#0c0b11` / 绯红 `#c23a2e` / 鎏金 `#d9b36a` / 表盘水印 | 5/5 ✅ |
| kurkuriel | 强制亮色 / 骨白基底 / 深端同步覆盖 `#0f0d0b` / 血绯 `#9e1b1b` / 破裂表盘水印 | 5/5 ✅ |
| 持久化 + 切回 pure | localStorage / 切回生效 | 2/2 ✅ |

**附带修复**：原断言 `kurkuriel: 骨白基底令牌` 检查 `--dsw-static-neutral-bluish-950 === '#e9e5e1'`，但 `kurkuriel.css` 自初版（4f07bd9）起该令牌即声明为 `#0f0d0b`——骨白实际走「DSH 亮色语义」亮端令牌（`--dsw-static-neutral-bluish-50=#fcfaf8`）+ `--dsw-alias-bg-base=rgba(247,244,241,.88)`。该断言从首次提交即不可满足，因脚本从未成功跑通而潜伏。本次修正为：亮端令牌 + alias 基底包含 `247, 244, 241`，并新增「深端令牌同步覆盖 = `#0f0d0b`」断言佐证覆盖链路健康。见 `desktop/scripts/verify-themes.mjs`。

> 注：这是**测试断言修复**，非主题代码回归——实测值与主题声明值完全一致，证明令牌覆盖链路在 0.1.1-rc.1 下健康。

### 3.3 registry 重扫（编排线）

| id | 旧版本（HANDOVER 记） | 新版本（本次重扫） | 备注 |
|---|---|---|---|
| bl | 1.16.0 | 1.16.0 | 不变 |
| claude | 2.1.233 | **2.1.238** | 升级 |
| gemini | 启动失败 | **0.55.1** | 版本探测已通；invoke 仍待校准（403 区域限制预案不变） |
| opencode | 1.18.18 | 1.18.18 | 不变 |
| dsh | rc.6（**过期**） | **0.1.1-rc.1** | **本次主修** |
| pi | 0.84.1 | 0.84.1 | 不变 |
| mimo | 0.1.12 | 0.1.12 | invoke 语法仍待校准 |
| agent-browser | 0.34.0 | 0.34.0 | 命令型，非 prompt 型 |

- 8/8 全部发现并刷新 `cli` 字段；Operator 编辑字段未被覆盖（脚本仅刷新 discovered 元数据）。

## 4. 仍待办（本次未覆盖）

- [ ] **历史会话恢复验证**（P1-4）：rc.8 明示 SQLite 存储格式不兼容——需在 rc.8/0.1.1 GUI 里抽查一个 rc.7 时期历史会话能否正常恢复/分叉。**需用户在桌面端 GUI 操作**，本次（无头 Edge）无法验证。
- [ ] **引用资料梳理**（P1-5）：`_refs/rc8-src.zip` 已损坏、`_refs/deepseek-harness` 仍 rc.7 解包——需要源码参考时再重下官方 0.1.1-rc.2 source。
- [ ] **M3.5 的 A/B/C 全链路重跑**：本次只做了 profile 混装 + 主题两条线，未重跑 vendor harness 的 e2e（A keyless-smoke / B sdk-snapshot / C loader-composition）。因 worker 主路线已不依赖 dsh 包升级（改用本机 agent CLI 编排），M3.5 A/B/C 的回归价值主要是「dsh 原生任务参考线」防护；如需完整复跑，参照 M3.5 §1（需 rc.8+ source 快照 + 热补丁复核）。

## 5. 结论

- **两条线的共同最大风险点（rc.8 升级欠账）已解除**：profile 混装加载无回归（与 M3.5 基线字节一致）、三主题在当前 CLI 下端到端通过。
- **编排线 registry 卫生已修**：dsh 档案不再记过期版本；claude/gemini 版本同步到现状。
- 剩余 P1-4（历史会话）需用户在 GUI 验证；P1-5（引用资料）按需再下。

## 6. 日志

`tests/m3-acp/logs/m36/`：`profile-m3-dump.log` / `profile-rc7-dump.log` / `dist-tags.txt` / `verify-themes.log` / `scan-output.log`
