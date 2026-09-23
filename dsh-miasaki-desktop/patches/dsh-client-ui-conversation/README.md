# DSH 会话头「窄宽度溢出保护」运行时补丁

> 官方会话头（`@deepseek-ai/dsh-client-ui-conversation`）在**宽度不足时会把控件压叠**：
> 中栏被右侧边栏推窄后，「对话 / 会话布」切换器被右侧图标按钮盖住、会话标题消失。
> 本补丁把 `headerActions` 从「不收缩」改为「可收缩 + 横向可滚」，让溢出退化为滚动而不是压叠。
> 2026-09-10 首次落地。

## 为什么是「运行时补丁」而不是插件

这是**官方布局自身的缺失**，插件侧无法修根：官方把一行分成

```
titleCluster    flex:1; min-width:0     ← 可被一路压到 0
  crumbs        min-width:0; overflow:hidden   ← 标题先被裁没
  headerActions flex:none               ← 不收缩（各插件往里塞控件）
headerUtilities flex:none               ← 不收缩
headerCorner    flex:none               ← 不收缩
```

可用宽度小于「固定项之和」时，`titleCluster` 被压到 0，而它内部 `flex:none` 的
`headerActions` 无处安放、**溢出**并与同样从 x≈0 起画的 utilities 重叠 —— DOM 靠后的
utilities 盖在上层，于是出现「文件夹图标压住『会话布』、标题消失」。任何插件都改不动这个计算，
只能改写官方 CSS。

完整归因、宽度预算与方案对比见
[会话头部挤压修复设计](../../../dsh-miasaki-canvas/design/2026-09-10-conversation-header-crowding-fix.md)。

**代价必须说清楚**：DSH 升级会覆盖该包，补丁随之消失，需要重新应用。这就是本目录入库的原因——
补丁规则 + 基线进版本控制后，升级后能**重建、能校验、能回退**。

## 目录内容

| 文件 | 作用 |
|---|---|
| `patch.mjs` | **补丁规范**：1 条锚点编辑（CSS 片段替换）+ CLI（verify / status / apply / revert） |
| `rebuild-baseline.mjs` | **升级专用**：以当前安装的官方原版重建 baseline，并打印待同步进 `patch.mjs` 的三个常量（只写 baseline/，不改常量） |
| `baseline/client.original.js` | DSH **0.1.7-alpha.2** 官方原版 client.js（701,296 B，SHA-256 `38326414…`）。2026-09-23 由 0.1.5-rc.1（647,101 B，`81314DFD…`）升级重打，锚点仍唯一命中，`EDITS` 零改；产物 `59A185B9…` |

> 与其他补丁的差别：**不存 patched 全文**。目标文件 632 KB，再存一份不划算；产物以
> `PATCHED_SHA256` 常量记录，`verify` 用「由原始 baseline 重建出的 SHA 是否等于该常量」自证 ——
> SHA 相等即逐字节相等，锚点失配时仍会响亮报错。

## 补丁做了什么

一条编辑，按「锚点唯一」定位（不唯一或缺失即报错，宁可失败也不瞎改）：

```diff
-.wSkVaW_headerActions{flex:none;align-items:center;gap:8px;display:flex}
+.wSkVaW_headerActions{flex:0 1 auto;min-width:0;align-items:center;gap:8px;display:flex;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
+.wSkVaW_headerActions::-webkit-scrollbar{display:none}
```

- `flex:0 1 auto` + `min-width:0`：空间不足时 actions 自行收缩，不再溢出压叠；
- `overflow-x:auto`：收缩后内容变为**横向可滚**，控件始终可达（最坏情况是滚一下，而不是看不见）；
- `overflow-y:hidden` + 滚动条样式隐藏：避免多出纵向滚动条与常驻横条。

> 取舍：`overflow-y:hidden` 会裁掉聚焦轮廓的上下部分 —— 这是兜底路径（正常宽度下不触发），
> 换掉的是「控件被压得完全不可用」这个更差的状态。

配合 canvas 线的自适应降级（画布切换器在窄宽度下收成图标，≈116px → ≈64px）：
**canvas 侧保住可用性，本补丁保证任何插件 / 任何窄窗口都不会再压叠。**

## 用法

```powershell
cd dsh-miasaki-desktop/patches/dsh-client-ui-conversation

node patch.mjs verify            # 离线自检：baseline 原始 → 重建 → 与记录 SHA 比对
node patch.mjs status            # 检查已安装 bundle 的状态（original / patched / unknown）
node patch.mjs apply             # 备份 + 应用（幂等：已打过则跳过）
node patch.mjs revert            # 从 .dsh-bak 还原
node rebuild-baseline.mjs        # 升级后：用当前安装的官方原版重建 baseline

# 通用参数：--target <client.js 路径> 覆盖自动探测（默认探测 %APPDATA%\npm 全局安装）
```

`verify` 是纯离线检查，不碰安装目录，已接入仓库级统一回归：

```powershell
node ..\..\..\scripts\verify-all.mjs desktop
```

## DSH 升级后怎么办

1. `node patch.mjs status` —— 若显示 `unknown`，说明安装的是新版本，补丁已被覆盖；
2. 用 `baseline/client.original.js` ↔ 新版 client.js 做 diff，核对锚点是否仍在
   （`patch.mjs` 会在锚点缺失或多重命中时明确报错，不会静默改错）；
3. 锚点漂移则更新 `EDITS` 与 baseline，再跑 `node rebuild-baseline.mjs` 取新常量、`node patch.mjs verify` 自证；
4. `node patch.mjs apply` 重新应用，刷新页面生效。

## 边界（勿越线）

- 补丁只改 `dsh-client-ui-conversation` 这一个包的 client 产物，**不动 DSH 源码、不动其他包**；
- 与本项目另一个本体补丁（[`../dsh-client-ui-settings-models`](../dsh-client-ui-settings-models/README.md)）
  同属「不修改 DSH 本体」原则的**例外**，代价同样明确（升级覆盖、需重打）；
- 本目录不含任何宿主服务调用，改动只发生在浏览器侧的一条 CSS 规则上。
