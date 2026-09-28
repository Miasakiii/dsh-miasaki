# DSH 会话头「窄宽度溢出保护 + 弹层放行」运行时补丁

> 官方会话头（`@deepseek-ai/dsh-client-ui-conversation`）在**宽度不足时会把控件压叠**：
> 中栏被右侧边栏推窄后，「对话 / 会话布」切换器被右侧图标按钮盖住、会话标题消失。
> 本补丁把 `headerActions` 从「不收缩」改为「可收缩 + 横向可滚」，让溢出退化为滚动而不是压叠。
> 2026-09-10 首次落地。
>
> **2026-09-28 续修（第二条规则）**：上面那条规则**把挂在 `headerActions` 内的浮层一起裁掉了** ——
> 0.1.7 起官方的「后台任务」列表（`dsh-client-ui-jobs`）把展开面板**直接渲染在 headerActions 里**
> （无 portal），于是点击任务控件后 DOM 里确有菜单、肉眼却什么都看不到（用户报障词：
> 「顶栏的后台运行项目展开栏打不开」）。现补一条 `:has([aria-expanded=true]){overflow:visible}`：
> **仅在某个控件处于展开态时放行溢出**，其余时刻照旧裁剪。归因与代价见下方「为什么需要第二条规则」。

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
| `patch.mjs` | **补丁规范**：1 条锚点编辑（CSS 片段替换，内含 3 条 CSS 规则）+ 产物语法守卫 `assertParsable()` + CLI（verify / status / apply / revert） |
| `rebuild-baseline.mjs` | **升级专用**：以当前安装的官方原版重建 baseline，并打印待同步进 `patch.mjs` 的三个常量（只写 baseline/，不改常量） |
| `baseline/client.original.js` | DSH **0.1.7-rc.2** 官方原版 client.js（712,829 B，SHA-256 `40EF6D13…`）。2026-09-25 由 0.1.7-alpha.2（701,296 B，`38326414…`）升级重打，锚点仍唯一命中、`EDITS` 零改；**2026-09-28 增补第二条规则**后产物 `713,019 B / 668FD5F0…` |

> 与其他补丁的差别：**不存 patched 全文**。目标文件 ~696 KB，再存一份不划算；产物以
> `PATCHED_SHA256` 常量记录，`verify` 用「由原始 baseline 重建出的 SHA 是否等于该常量」自证 ——
> SHA 相等即逐字节相等，锚点失配时仍会响亮报错。
>
> **但 SHA 自证不覆盖语法**：2026-09-28 的事故证明「重建 == 记录」与「产物仍是合法 JS」是两件事，
> 故 `verify`/`apply` 另跑一次 `assertParsable()`（见下）。

## 补丁做了什么

一条编辑，按「锚点唯一」定位（不唯一或缺失即报错，宁可失败也不瞎改）：

```diff
-.wSkVaW_headerActions{flex:none;align-items:center;gap:8px;display:flex}
+.wSkVaW_headerActions{flex:0 1 auto;min-width:0;align-items:center;gap:8px;display:flex;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
+.wSkVaW_headerActions::-webkit-scrollbar{display:none}
+.wSkVaW_headerActions:has([aria-expanded=true]){overflow:visible}
```

- `flex:0 1 auto` + `min-width:0`：空间不足时 actions 自行收缩，不再溢出压叠；
- `overflow-x:auto`：收缩后内容变为**横向可滚**，控件始终可达（最坏情况是滚一下，而不是看不见）；
- `overflow-y:hidden` + 滚动条样式隐藏：避免多出纵向滚动条与常驻横条；
- `:has([aria-expanded=true])`：**展开态放行溢出**，让挂在 headerActions 内部的弹出层不被裁掉。

> 取舍：`overflow-y:hidden` 会裁掉聚焦轮廓的上下部分 —— 这是兜底路径（正常宽度下不触发），
> 换掉的是「控件被压得完全不可用」这个更差的状态。

### 为什么需要第二条规则（2026-09-28）

**现象**：miasaki 桌面端顶栏的「后台任务」控件点不开 —— 点了没有任何反应，`aria-expanded` 确实变成
`true`、DOM 里也确有那个 `<ul>` 菜单，但屏幕上什么都看不到。

**归因链**（逐环实测）：

1. `dsh-client-ui-jobs` 注册到 `conversation.session.header.actions` 槽（`order: 20`）；
2. 官方会话头把槽内容**直接**渲染进 `headerActions` 这个 div：
   `(0, react_jsx_runtime.jsx)("div", { className: "wSkVaW_headerActions", children: renderSlot(...) })`
   —— **没有 portal**；
3. 该包的弹层是普通绝对定位子元素：`.QsffPG_root{position:relative}` +
   `ul.QsffPG_menu{position:absolute;top:calc(100% + 5px);z-index:100}`；
4. 本补丁第一条规则给容器加了 `overflow-x:auto; overflow-y:hidden` ⇒ 按 CSS 规范，
   **非 visible 的 overflow 会裁剪其后代**（绝对定位后代同样被裁，只要定位祖先在容器内）。

实测（真实 miasaki 实例 + 真实会话头 `wSkVaW_headerActions`，弹层 CSS/DOM 取自 jobs 产物原文）：

| 状态 | 容器 overflow | 弹层可见比例 | 命中测试 |
|---|---|---|---|
| 修复前 | `auto/hidden` | **0**（119px 全被裁） | false |
| 修复后（展开态） | `visible/visible` | **1** | true |
| 修复后（收起态） | `auto/hidden` | —（菜单本就隐藏） | — |

**为什么不是「把 jobs 的弹层 portal 化」**：那是改官方包、每个版本都要重打，而且只修好这一个控件 ——
任何将来往 headerActions 里放浮层的插件都会重蹈覆辙。`:has()` 规则是**一次性、面向全部插件**的兜底：
只要是「展开态才有浮层」的控件，都自动被放行。

**代价（写清楚）**：某个控件展开期间，本条宽度溢出保护临时失效（可能重新出现压叠）—— 但那一刻用户
正在看那个浮层，浮层 `z-index:100` 盖在最上层，观感可接受；收起后立刻恢复裁剪。
`:has()` 需要 Chromium 105+ / Safari 15.4+ / Firefox 121+；不被支持时本条规则整条被忽略，
**退回修复前的行为**（裁剪），不会更糟。

### ⚠ 引号纪律与语法守卫（2026-09-28 事故，勿重蹈）

本包的 CSS 常量是**双引号字符串**（`const css$4 = ".wSkVaW_root{…}"`），所以**替换文本里绝不能出现裸引号**。

首版把规则写成 `[aria-expanded="true"]` —— 双引号提前终止了字符串字面量，整个 `client.js` 变成语法
错误，页面直接 `Failed to load plugins`（**全量白屏**）；而 `verify` 的 SHA 自证照样 PASS，因为
「重建产物 == 记录产物」与「产物是否还是合法 JS」是两件事。

两道闸门现已就位：

1. **属性选择器一律用无引号标识符写法**（`[aria-expanded=true]` —— CSS 对合法标识符值允许不加引号，
   实测在 Edge/WebView2 上匹配 `aria-expanded="true"` 正常）；
2. **`assertParsable()`**：`verify` 与 `apply` 都会用 `new Function(产物)` 强制解析一次，
   语法错误**在写盘前**显式失败（反向测试：把规则改回含引号写法 → `verify` 以
   `产物语法校验失败：Unexpected string` 退出码 1 失败）。

> 跨补丁审计（同日）：其余 8 个本体补丁（含 dual-model 的图片准入）产物语法均 OK、状态均 patched、
> `EDITS` 内无裸引号 —— 本事故只发生在这一处，已修复并加固。

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
