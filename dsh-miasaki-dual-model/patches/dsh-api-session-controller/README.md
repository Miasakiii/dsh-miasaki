# 补丁：`@deepseek-ai/dsh-api-session-controller` — 双模型图片准入

> **唯一一处「修改 DSH 本体」的改动，属于 `dsh-miasaki-dual-model` 线。**
> 规则与基线已入库，可重建 / 可校验 / 可回退。

## 它解决什么

DSH 的 `session.prompt` 在提交带图消息时按「当前会话模型是否声明支持图片」硬拒整条消息：

```js
// dsh-api-session-controller/lib/index.js（0.1.5-rc.1 第 762-764 行）
const current = this.agents.selectionFor(agent).current;
const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model);
if (model.inputModalities !== void 0 && !model.inputModalities.includes("image")) throw new RemoteError(...)
```

该判定是 **host 私有**的，没有任何插件可挂的 waterfall。而图片以 `image block` 形式进入 durable log 的唯一正路就是 `session.prompt` —— 所以「主模型 + 辅助模型」在不改本体时无法让图片进入官方管道（完整推演见 `../../design/2026-09-10-dual-model-design.md` §3.2，其中排除了 6 条替代路径）。

## 补丁做了什么

把准入判定**委托**给一个可选服务：

```js
ctx.get("dualModelVisionRoute")   // → { for(agent) -> {provider, model} | undefined }
```

改后的三分支结构：

| 情形 | 行为 |
|---|---|
| 服务不存在（**未装插件**） | 走原生分支 —— 与打补丁前**逐字节相同**，含错误信息 |
| 服务存在且返回路由 | 按「主 OR 辅任一支持图片」放行（union 语义） |
| 两者都不支持 | 报 `Neither "X" nor "Y" supports image input` |

**关键性质：零退化。** 服务不存在时（未装 / 未启用 / 未配置辅助模型）本体走原生分支，裸 DSH 行为与打补丁前完全一致。因此本补丁是**纯可选依赖**，插件的装载与卸载都不需要动它。

本补丁只有 **1 条编辑**（`replaceRange`，替换 2 行 → 12 行）。

## 用法

```bash
cd dsh-miasaki-dual-model/patches/dsh-api-session-controller

node patch.mjs verify    # 离线自证：baseline 原始 → 重建 → 与 baseline 产物逐字节比对
node patch.mjs status    # 检查已安装 bundle 的补丁状态
node patch.mjs apply     # 备份(.dsh-bak) + 应用（幂等）
node patch.mjs revert    # 从 .dsh-bak 还原
node patch.mjs seal      # 升级重新适配后：由原始文件重生成 baseline 产物并打印 SHA-256
```

环境变量 `MIASAKI_DSH_CONTROLLER` 或参数 `--target <path>` 可覆盖目标文件自动探测。

**应用后需重启 `dsh web`** —— host 半的 bundle 只在启动时加载。

本补丁已并入仓库统一静态回归：`node ../scripts/verify-all.mjs dual-model`。

## 与 `dsh-miasaki-desktop` 的补丁是什么关系

| | 本补丁 | desktop 线的补丁 |
|---|---|---|
| 目标包 | `dsh-api-session-controller` | `dsh-client-ui-settings-models` |
| 作用 | 图片准入判定委托 | 设置页思考强度 + 连通性测试 |
| 作用面 | host（Node） | client（浏览器 bundle） |

**两者作用于不同的包，互不冲突**，但都需在 DSH 升级后重打 —— 建议合并进同一份升级检查清单。

## 升级后怎么办

DSH 升级会覆盖 `dsh-api-session-controller`，本补丁随之失效。步骤：

1. `node patch.mjs status` —— 若输出 `unknown`，说明是升级后的新版本（这也是 `.dsh-bak` 仍在但状态不是 `patched` 的原因）。
2. 重新定位锚点。锚点是这一行（在文件里必须**唯一**）：
   ```
   const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model);
   ```
   ```powershell
   Select-String -Path "<安装目录>\@deepseek-ai\dsh-api-session-controller\lib\index.js" `
     -Pattern 'const model = await this\.ctx\.llm\.resolveModelInfo'
   ```
3. 核对 `EDITS[0].expect` 里断言的两行是否仍与新版一致（**这一步不能省** —— `expect` 是防止改错层级的保险）。
4. 用新版文件替换 `baseline/index.original.js`，更新 `ORIGINAL_SHA256` 常量。
5. `node patch.mjs seal` → 回填打印出的 `PATCHED_SHA256`。
6. `node patch.mjs verify` → `node patch.mjs apply`。

**若锚点已被上游重构**（例如校验挪进了别的函数），补丁需要重新设计插入点 —— 此时请一并复核 `design/` 里「准入委托」的契约是否仍然成立。

## 基线

| 项 | 值 |
|---|---|
| DSH 版本 | `0.1.5-rc.1` |
| 目标 | `@deepseek-ai/dsh-api-session-controller/lib/index.js` |
| 原始 SHA-256 | `16ECB48F33996EFE72868F1603223214430634C5AC4C3E8FE9060BF240E990FF` |
| 补丁后 SHA-256 | `58574E8A9BA2C31423250D1ED5FAF5503B54C973D62743EE8B10EFBC3034A930` |
| 编辑数 | 1（`replaceRange`，2 行 → 12 行） |
| 特征串 | `dualModelVisionRoute` |
