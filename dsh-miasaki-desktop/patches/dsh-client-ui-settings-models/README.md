# DSH 设置页「模型能力增强」运行时补丁

> 给 DSH 官方设置页（`@deepseek-ai/dsh-client-ui-settings-models`）增量加入
> **模型级「思考强度」下拉**与**逐模型「测试连通性」按钮**。
> 2026-09-07 首次落地，2026-09-08 补丁规则与基线文件入版本控制（此前只存在于 `vendor/`，不入库）。

## 为什么是「运行时补丁」而不是插件

官方设置页刻意不提供逐模型思考强度控件，也不做逐模型连通性测试——上游取向是
「effort 是 per-MODEL 能力，放在对话模型选择器里」。而本机没有 pnpm 全量重建链路
（npm registry HTTPS 不可达 / pnpm store 被沙箱锁死 / AppData 只读），
「fork 官方包 + 重建 dist」这条路走不通，因此**直接改写已安装包的编译产物**
`lib/client.js`（生产页面加载的就是它）。

**代价必须说清楚**：DSH 升级会覆盖该包，补丁随之消失，需要重新应用。
这就是本目录入库的原因——补丁规则 + 基线文件进版本控制后，升级后能**重建、能校验、能回退**，
而不是依赖某台机器上的一次性产物。

完整设计、源码位置核查与实施记录见
[模型设置工具包设计](../../../dsh-miasaki-shared-docs/cross/model-settings-toolkit-design-2026-09-07.md)。

## 目录内容

| 文件 | 作用 |
|---|---|
| `patch.mjs` | **补丁规范**：7 条锚点编辑规则（5 处插入 + 2 处字典替换）+ CLI（verify / status / apply / revert） |
| `rebuild-baseline.mjs` | **升级专用**：以当前安装的官方原版重建两份 baseline，并打印待同步进 `patch.mjs` 的三个常量（只写 baseline/，不改常量） |
| `baseline/client.original.js` | DSH **0.1.5-rc.1** 官方原版 client.js（138,937 B，SHA-256 `A60FD863…`）。与安装目录的 `client.js.dsh-bak` 逐字节一致 |
| `baseline/client.patched.js` | 应用补丁后的产物（144,576 B，SHA-256 `E602C1F1…`）。**黄金对照**：既是重建目标，也是下次升级后人工适配时的 diff 基准 |

> 两份 baseline 是第三方产物而非本项目源码，但它们是不可再生的重建依据
> （`vendor/` 不入库、安装目录会被升级覆盖），故随补丁规则一并版本化。
>
> **基线沿革**：`0.1.2-rc.1`（2026-09-08 入库，`7ACF9736…` / `18D114AC…`）
> → `0.1.5-rc.1`（2026-09-10 重打，`A60FD863…` / `E602C1F1…`）。旧基线见 git 历史。

## 用法

```powershell
cd dsh-miasaki-desktop/patches/dsh-client-ui-settings-models

node patch.mjs verify            # 离线自检：baseline 原始 → 重建 → 与 baseline 产物逐字节比对
node patch.mjs status            # 检查已安装 bundle 的状态（original / patched / unknown）
node patch.mjs apply             # 备份 + 应用（幂等：已打过则跳过）
node patch.mjs revert            # 从 .dsh-bak 还原
node rebuild-baseline.mjs        # 升级后：用当前安装的官方原版重建 baseline（见下）

# 通用参数：--target <client.js 路径> 覆盖自动探测（默认探测 %APPDATA%\npm 全局安装）
```

> **`rebuild-baseline.mjs` 的正确时机**：DSH 升级后、**尚未重打之前**。此时安装目录是
> 新的官方原版，脚本会用它重建两份 baseline。**对已打补丁的文件跑会被拒绝**
> （`applyPatch` 见到补丁标记即报错），这是刻意的保护。脚本不改 `patch.mjs` 的常量，
> 请按它打印的值手动同步 —— 改常量是有语义的决策。
>
> 本次（2026-09-10）以 `.dsh-bak` 反向自测：脚本打印的三个值与 `patch.mjs` 里已写入的
> 完全一致，`verify` 仍 PASS。

`verify` 是纯离线检查，不碰安装目录，已接入仓库级统一回归：

```powershell
node ..\..\..\scripts\verify-all.mjs desktop
```

## 补丁做了什么

7 条编辑，全部按「锚点唯一」定位（不唯一即报错，宁可失败也不瞎改）：

| # | 位置 | 内容 |
|---|---|---|
| 1 | 模块级（`textOf` 前） | `REASONING_LEVELS` / `reasoningChoice()` / `reasoningPatch()` / `testResultClass()` |
| 2 | `ModelListEditor` state 区 | `testing` / `testResults` 两个 useState |
| 3 | `askable` 前 | `testModel()`——复用 `operations.discoverModels`，按当前行 provider/baseURL/api/apiKey 探测 |
| 4 | 删除模型行处 | `testing` / `testResults` 的行号重排（防幽灵按钮） |
| 5 | 高级编辑区（maxTokens 之后） | 思考强度 `<select>` + 测试按钮 + 结果文案 |
| 6/7 | en / zh 字典 | 7 个词条（思考强度 / 继承提供方默认 / 不支持思考 / 测试连通性 / 测试中… / 可达·已列出 / 可达·未列出） |

语义：`inherit` = 不写字段、`disabled` = `reasoningEfforts: false`、其余 = `{off: null, [lvl]: lvl}`。
错误分类当前只做两档（`refused` 原样回显 / 可达与否），六分类是设计稿目标、尚未落地。

## DSH 升级后怎么办

1. `node patch.mjs status` —— 若显示 `unknown`，说明安装的是新版本，补丁已被覆盖；
2. 用 `baseline/client.original.js` ↔ 新版 client.js 做 diff，核对 7 个锚点是否仍在
   （`patch.mjs` 会在锚点缺失或不唯一时明确报错，不会静默改错）；
3. 锚点漂移则更新 `EDITS` 与两份 baseline，再跑 `node patch.mjs verify` 自证；
4. `node patch.mjs apply` 重新应用，刷新页面生效。

> **实操记录（2026-09-10，0.1.2-rc.1 → 0.1.5-rc.1）**：7 个锚点在新版 client.js 中
> **全部唯一命中**（新版 138,937 B，比 0.1.2 多 1,236 B），`insertAfterOffset` 的期望值检查
> 也全部通过 —— 因此**未改动任何 EDITS**，只换了两份 baseline 并更新三个常量
> （`BASELINE_DSH_VERSION` / `ORIGINAL_SHA256` / `PATCHED_SHA256`）。
> 重建与重打各一次成功，`verify-all.mjs desktop` 4/4 通过。

> 生效机制：`dsh-client-modules` 以 `/plugins/??<id>/client.js&rev=<hash>` 提供该文件，
> `client-hmr` 每 500ms stat 一次，命中变化即经 SSE 推 rebuilt 帧热更；
> 若 host 启动晚于补丁写入，则启动快照即补丁，无需热更。

## 边界（勿越线）

- 补丁只改 `dsh-client-ui-settings-models` 这一个包的 client 产物，**不动 DSH 源码、不动其他包**；
- 与本项目另一个本体补丁（[`../dsh-client-ui-conversation`](../dsh-client-ui-conversation/README.md)，
  会话头窄宽度溢出保护）同属「不修改 DSH 本体」原则的**例外**，代价同样明确（升级覆盖、需重打）；
- 两个补丁各自独立：各自的锚点、baseline、CLI 与 `verify` 互不依赖，升级后分别重打即可；
- 本目录不含任何宿主服务调用，改动全部发生在浏览器侧 UI 与 `settings.mutate` 写回路径上。
