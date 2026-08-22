# M36 rc.8(+) 平台回归冒烟（2026-08-22）

> 从原 `docs/m36-rc8-regression-smoke-2026-08-22.md` 拆出的平台级回归证据。
> 桌面端主题校验见 `../../dsh-miasaki-desktop/docs/m36-theme-verify-2026-08-22.md`；编排线 registry 重扫见 `../../dsh-miasaki-fleet/docs/m36-registry-rescan-2026-08-22.md`。

- 对象：本机全局 dsh CLI 实测 **0.1.1-rc.1**（非计划文档原记 rc.8；npm dist-tags 现状 `latest=0.1.1-rc.2 / next=0.1.1-rc.2`，本机装 rc.1）+ 既有 `.dsh/profiles/{m3-test,rc7-test}` 混装 profile，对照 M3.5 基线。
- 结论：**关键路径无回归——profile 混装 `--dump-config` 双双 exit 0，rc7-test 插件树与 M3.5 基线 313 行字节级一致。**

## 版本面（npm 实测 2026-08-22）
- `@deepseek-ai/dsh` → `{ latest: 0.1.1-rc.2, next: 0.1.1-rc.2 }`
- `@deepseek-ai/dsh-base` → `{ latest: 0.0.1-rc.1, next: 0.1.1-rc.2 }`
- 本机全局 CLI = 0.1.1-rc.1（自带 `@deepseek-ai/cordis@4.0.1` + `@deepseek-ai/dsh-base@0.1.1-rc.1`）

## profile 混装加载（核心）
| profile | 全局 CLI | --dump-config exit | 判定 |
|---|---|---|---|
| m3-test | 0.1.1-rc.1 | 0 ✅ | pnpm 布局 profile（dsh-subagent-dsh-sdk@0.0.1-rc.1）加载正常 |
| rc7-test | 0.1.1-rc.1 | 0 ✅ | npm 全家桶（dsh-*@0.1.0-rc.7 + subagent@0.0.1-rc.1）加载正常 |

- cordis 由全局 CLI 自带（4.0.1），profile 只供插件包——混装模型成立，与 M3.5「rc.6 CLI 加载 rc.7 家族」同型。
- **rc7-test 插件树与 M3.5 基线 313 行完全一致**（`diff --strip-trailing-cr` exit 0，零内容漂移）——最关键无回归证据。基线位于 `../../dsh-miasaki-fleet/tests/m3-acp/logs/rc7/profile-dump-config.log`。

## 方法要点
- 绕开 PATH 上 dsh 的 sh shim 在受限 shell 的路径转换缺陷（`/c/Users`→`c:\c\Users`，纯环境问题，cmd/PowerShell 下 `dsh.cmd` 正常），直接 `node …/lib/bin.js` 调用。
- 全局 0.1.1-rc.1 CLI 下加载 m3-test/rc7-test 跑 `--dump-config`；`diff --strip-trailing-cr` 对比 rc7-test 新 dump 与基线。

## 仍待办
- [ ] **引用资料梳理**：`_refs/rc8-src.zip` 已损坏、`_refs/deepseek-harness` 仍 rc.7 解包——需源码参考时重下官方 0.1.1-rc.2 source。
- [ ] **M3.5 A/B/C 全链路重跑**：本次只做了 profile 混装 + 主题两条线，未重跑 vendor harness e2e（worker 主路线已不依赖 dsh 包升级，A/B/C 回归价值主要是「dsh 原生任务参考线」防护）。

## 日志
`../../dsh-miasaki-fleet/tests/m3-acp/logs/m36/`：profile-m3-dump / profile-rc7-dump / dist-tags / verify-themes / scan-output
