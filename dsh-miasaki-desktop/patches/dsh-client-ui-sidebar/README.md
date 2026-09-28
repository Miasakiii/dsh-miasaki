# DSH 侧边栏头部「悬浮提示被遮盖」修复运行时补丁

> 官方侧边栏（`@deepseek-ai/dsh-client-ui-sidebar`）头部控件（左上角 logo、
> 侧边栏开关、折叠态「新会话」、面板行、`shell.leading` 窗槽控件）的 Tooltip
> **都不带 portal**：气泡作为锚点的兄弟节点渲染在侧边栏列内，靠
> `position: fixed; z-index: 100` 试图越过祖先裁剪。但侧边栏列整体**早于中间列
> 绘制**，中间列顶部的叠加上下文（会话头 titleRow 的 `container-type: inline-size`
> 布局遏制、tabs 行 `z-index:1`、窄窗口下侧边栏覆盖被挤压的中栏）会把气泡
> **盖住 / 裁掉** —— 鼠标悬浮左上角 logo 想读「新建会话」提示，只看到气泡被切掉的
> 一丝（2026-09-28 实机截图：深色气泡只剩左端 3px）。本补丁给这个包全部 6 处
> Tooltip 加 `portal: true`（官方 primitives 自带的逃生通道：气泡改挂
> `document.body`、z-index 升 1100），几何与内容零变化。

## 为什么是「运行时补丁」而不是插件

这是**官方 Tooltip 挂点选择**与三列布局绘制顺序的冲突，插件侧无法修根：

```
AppFrame（grid: sidebar | center | rightbar，DOM 序：sidebar 在前）
  sidebarCol(overflow:hidden)
    SidebarRoot
      logoRow(overflow:hidden)
        Tooltip{brand「新建会话」}   ← 气泡 render 在这里（无 portal）
        Tooltip{toggle「收起侧边栏」}
  中间列（后绘制）：
    conversation.session.header
      titleRow  container-type:inline-size  ← 布局遏制 = 叠加上下文 + fixed 包含块
      tabs     z-index:1; position:relative
```

内联气泡的 `z-index:100` 在侧边栏子树内解析，整棵侧边栏子树又早于中间列入栈；
中间列任意一个形成叠加上下文的后绘制元素（或把侧边栏挤上去的窄布局）都会盖住它。
官方 Tooltip 组件为此提供 `props.portal`（"render the bubble under document.body,
so an ancestor's clipping or its stacking context ... cannot hide it"，z-index 1100），
但侧边栏包一处都没用 —— 本补丁补上。

完整归因与方案对比见
[侧边栏悬浮提示 portal 化设计](../../design/2026-09-28-sidebar-tooltip-portal.md)。

**代价必须说清楚**：DSH 升级会覆盖该包，补丁随之消失，需要重新应用。这就是本目录入库的原因——
补丁规则 + 基线进版本控制后，升级后能**重建、能校验、能回退**。

## 目录内容

| 文件 | 作用 |
|---|---|
| `patch.mjs` | **补丁规范**：6 条锚点编辑（tooltip 加 `portal: true`）+ CLI（verify / status / apply / revert） |
| `rebuild-baseline.mjs` | **升级专用**：以当前安装的官方原版重建 baseline，并打印待同步进 `patch.mjs` 的三个常量（只写 baseline/，不改常量） |
| `baseline/client.original.js` | DSH **0.1.7-rc.2** 官方原版 client.js（32,052 B，SHA-256 `40E651B9…`） |

> 与其他补丁的差别：**不存 patched 全文**。产物以 `PATCHED_SHA256` 常量记录，
> `verify` 用「由原始 baseline 重建出的 SHA 是否等于该常量」自证 —— SHA 相等即
> 逐字节相等，锚点失配时仍会响亮报错；另有一道语法闸门（`vm.Script` 经典脚本目标），
> 产物必须是合法 JS 才允许落盘。

## 补丁做了什么

6 条编辑，各按「锚点唯一」定位（不唯一或缺失即报错，宁可失败也不瞎改）：

| # | 调用点 | 锚点（前 2 行示意） |
|---|---|---|
| 1 | `shell.leading` 窗槽 · 打开侧边栏 | `label: t("toggle.open"),` … `delayMs: 500,` |
| 2 | `shell.leading` 窗槽 · 新建会话 | `label: t("session.new.label"),` … `HeaderLeadingControls…iconButton,` |
| 3 | 折叠轨道态全局面板行 | `Tooltip, {` `label,` `delayMs: 500,` `disabled: wide,` |
| 4 | 侧边栏开关按钮 | `label: toggleLabel,` … `side: captionTooltipSide,` |
| 5 | **用户报告点：左上角 logo「新建会话」** | 7 制表符缩进的 `label: t("session.new.label"),` … `children: …"button", {` |
| 6 | 展开态「新会话」pill | 6 制表符缩进的 `label: t("session.new.label"),` … `disabled: wide,` |

每条即在 `delayMs: 500,` 后插入 `portal: true,`（保持原缩进）：

```diff
 				delayMs: 500,
+				portal: true,
 				children: (0, react_jsx_runtime.jsx)("button", {
```

- 气泡改挂 `document.body`、`z-index:1100`（`.bubble[data-portal]`），祖先的
  裁剪容器（logoRow / sidebarCol 的 `overflow:hidden`）与叠加上下文再也盖不住它；
- 几何不变：`side` / `align` / fit 钳制全部沿用原逻辑，位置计算只依赖锚点 rect
  与 `window`，与挂点无关；
- 交互不变：`pointer-events:none`、悬停/聚焦触发、抑制通道、keycap 渲染原样。

> 取舍：portal 气泡的 z-index(1100) 高于全屏浮层（设置 1001 / 模态 1000）——
> 这与官方菜单层（`.JYBKaa_portal{z-index:1100}`）同层，菜单场景本就不该看到
> tooltip；与 pet-panel 的瞬时 toast（2147483646）相遇时 toast 在上，但 toast 仅
> 人格切换后 3.6s 可见，可接受。

## 用法

```powershell
cd dsh-miasaki-desktop/patches/dsh-client-ui-sidebar

node patch.mjs verify            # 离线自检：baseline 原始 → 重建 → 与记录 SHA 比对 + 语法闸门
node patch.mjs status            # 检查已安装 bundle 的状态（original / patched / unknown）与语法
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
2. 用 `baseline/client.original.js` ↔ 新版 client.js 做 diff，核对 6 处锚点是否仍在
   （`patch.mjs` 会在锚点缺失或多重命中时明确报错，不会静默改错）；
3. 锚点漂移则更新 `EDITS` 与 baseline，再跑 `node rebuild-baseline.mjs` 取新常量、`node patch.mjs verify` 自证；
4. `node patch.mjs apply` 重新应用，刷新页面生效。

## 边界（勿越线）

- 补丁只改 `dsh-client-ui-sidebar` 这一个包的 client 产物，**不动 DSH 源码、不动其他包**；
- 与其余六个本体补丁同属「不修改 DSH 本体」原则的**例外**，代价同样明确（升级覆盖、需重打）；
- client 侧补丁，刷页面即生效，无需重启 host。
