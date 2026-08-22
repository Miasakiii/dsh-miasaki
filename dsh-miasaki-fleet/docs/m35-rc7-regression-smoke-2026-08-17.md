# M3.5 rc.7 回归冒烟报告

- 日期：2026-08-17
- 执行者：总指挥（Miasaki 会话）
- 对象：官方主包 **0.1.0-rc.7**（npm next 线）+ subagent 线 0.0.1-rc.1，对照 M3 基线（rc.6 时代 master @ 47f9438）
- 结论速览：**A/B/C 关键路径与 rc.6 基线完全一致，无回归；rc7-test profile 混装加载成功（exit 0）。rc.7 继续沿用 M3 判定。**

## 1. 方法

1. vendor/deepseek-harness 工作树镜像更新到 rc.7（master @ 99f6f02；来源 = 本地 _refs zip 快照，robocopy /MIR 保护 .git 与 node_modules；沙箱内 git/curl 的 schannel TLS 被拦，remote-helper 子进程无法 spawn，故不走 git pull）。
2. Windows fixture 热补丁复核：上游 rc.7 **未修复**该 bug（该文件 8-13 后只有一个无关 merge），重新打上（JSON 转义 cwd）。
3. pnpm install（LEFTHOOK=0）对账 rc.7 lockfile。
4. 跑 M3 计划（tests/m3-acp/plan.md）A/B/C 三个测试，全部 keyless。
5. rc7-test profile：$DSH_HOME/profiles/rc7-test 安装 npm 发布线（@deepseek-ai/dsh-base@0.1.0-rc.7 全家 + dsh-subagent-dsh-sdk@0.0.1-rc.1），原生包 rebuild，rc.6 全局 CLI 加载 --dump-config。

## 2. 结果

| 测试 | rc.7 结果 | M3 基线（rc.6 时代） | 判定 |
|---|---|---|---|
| A keyless-smoke.e2e.ts（子运行时协议） | **4/4** ✅（27.9s） | 4/4（21.6s） | 无回归；测试面已演进为 3×max-token 映射 + 1×非法 env fail-loud |
| B sdk.snapshot.ts（SDK 客户端 replay） | **3/4** ✅（38.7s） | 3/4 | 无回归；唯一失败仍为**已知 win32 平台缺口**（persistent-tools 依赖 terminal inspection，win32 官方不支持），与 M3 §2.2 相同；**热补丁在 rc.7 上继续有效**（replay 可跑通） |
| C loader-composition.e2e.ts（进程外后端全链路） | **1/1** ✅（9.6s） | 1/1（7.9s） | 无回归；父 harness spawn 子 harness → 委派 → cwd 继承断言 → dispose 干净 |
| rc7-test profile（npm 线混装加载） | ✅ exit 0 | m3-test（0.0.1-rc.1）同型 | 216 包安装成功；rc.6 CLI 加载 rc.7 家族 profile 配置 dump 有效 |

## 3. 环境与运维记录（本会话新增经验，供后续复用）

1. **沙箱授权**：受限模式下 Node spawn（pnpm 生命周期脚本、vitest 子进程）一律 EPERM——与 M3 一致，需 danger-full-access；dsh CLI 首次引导 profile 需在 $DSH_HOME 写 cordis.yml，同样需授权。
2. **pnpm v11 三个坑**：① 默认 verify-deps-before-run 会在跑脚本前隐式重跑 install（会绕过 LEFTHOOK），需 --config.verify-deps-before-run=false；② onlyBuiltDependencies 已不读 package.json 的 pnpm 字段，须写 pnpm-workspace.yaml；③ minimumReleaseAge 供应链策略默认拒绝 24h 内新发布的包——rc.7 发布刚 1 小时被拦，测试 profile 用 --config.minimumReleaseAge=0 放行。
3. **网络**：registry 批量拉取可选平台包（sharp-libvips-linux-* / koffi-freebsd 等）反复 UND_ERR_DESTROYED；指向工作区 .pnpm-store（M3 已入库 1.36GB）后 reused 215 / downloaded 0，秒过。
4. **git**：沙箱内 git fetch/clone 不可用（remote-helper 子进程被拦），大版本更新走「gh api zipball → robocopy /MIR」路线。

## 4. 结论与后续

- **rc.7 无回归**：A/B/C 与 rc.6 基线一致（B 的唯一失败仍为已知 win32 终端检查平台缺口），rc7-test profile 的 npm rc.7 家族安装 + rc.6 CLI 混合加载均通过（exit 0）。
- **与当前主路线（v0.11/v0.12）的关系**：worker 主路线已改为本机 agent CLI 编排（扫描发现 → 开关 → 派单），不依赖 dsh 包升级；本次冒烟服务于①§12 的 dsh 原生任务参考线（dsh-sdk / acp 行）与②§12 版本线升级纪律——结论：**dsh 原生任务路径可安全升 rc.7**。
- 上游跟进：Windows fixture 转义 bug（Discussions #2477）在 rc.7 仍未修，本地热补丁继续有效；rc.7 的「产品提供方后台 Job」等新能力按设计文档 §12/§13 M6 计划启用。
- 日志：tests/m3-acp/logs/rc7/（a-keyless-smoke / b-sdk-snapshot / c-loader-composition / profile-install7 / profile-dump-config）。
