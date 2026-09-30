# DSH 会话浏览器「侧线会话不占列表」运行时补丁

> `@miasaki/dsh-sidebar` 的「辅助对话」用官方 `sessions.fork` 建侧线 —— 它继承主会话
> 上下文、能继续对话，是一条**真会话**。但官方把「会话列表显示什么」这一投影留在壳里：
> 插件没有「不进列表」的接口，也写不了会话元数据。于是侧线以普通会话身份出现在左侧
> 列表与会话搜索里 —— 用户原话：「辅助对话怎么还是有记录，会上会话记录」。
> 本补丁补上官方**已经为自己留好、但没向插件开放**的那一个判定：让插件声明的侧线会话
> 不进列表，而会话本身照常可打开、可对话、上下文一字不少。
>
> **2026-09-30 首次落地（DSH `0.2.0-rc.2`）**：1 条编辑，锚点唯一命中。

## 为什么是「运行时补丁」而不是插件

这是官方**已经存在**的形态缺口，插件侧无路可走 —— 三条源码级事实：

1. **唯一生效的过滤点**在客户端壳里：`dsh-client-ui-workspace/lib/client.js` 的
   `sessionVisible(session, current, archived, archivedFilter)`。全仓 Host 侧
   （`dsh-session-query` 的 `listSessions`、`dsh-api-session-controller` 的目录投影）
   **完全不过滤 origin**，只跳过「冷会话且无 cwd」。
2. **它已经会隐藏一类会话**：
   ```js
   function sessionVisible(session, current, archived, archivedFilter) {
       if (session.origin === "subagent") return false;   // ← 官方自己的「建了但不进列表」
   ```
   `origin` 是**持久化 header 字段**，写入者只有 `dsh-subagent` 的 `childSessionMeta`
   （其注释写明 `Navigation classification only` —— 它本就是**导航分类**，不是身份）。
   插件拿不到写它的位置：客户端 `sessions.create` 入参只有 `{ workspaceId?, cwd?, sessionId? }`，
   `sessions.fork` 只有 `{ sessionId, atSeq?, increaseTitle?, onCreated? }`；
   官方源码注释也写死：「A fork shares the lineage field **without** the origin and is an
   independent conversation」。
3. **没有能过滤一行的插槽**：与会话行相关的 5 个插槽（`sidebar.workspaces`、
   `sidebar.session.row.leading` / `.hover`、`sidebar.workspaces.session.menu.item` /
   `.row.action`）里，`list` 类只能**加**装饰/菜单/按钮，`single` 类要替换**整块**
   （含分组、搜索、拖拽），都不是「过滤掉一行」。
   **不受支持的替代方案**里，归档（archive）看似可行但**会禁步**：
   `ArchivedSessionGate` 无条件装载，归档会话执行任何模型步都被 `agent/pre-step` 拒绝 ——
   「藏起来」和「能聊天」不可兼得。

> 顺带记下**官方原生路径**（本轮实测，供将来摆脱补丁时取用）：Host 插件可走
> `ctx.agents.create({ meta: { origin: 'subagent' }, seed, inheritedEventCount })` ——
> 这正是官方 fork-subagent 驱动器
> （`dsh-subagent-in-process-driver/lib/index.js:180-185`）的做法，能拿到
> 「不进列表 + 继承父前缀」的会话。本仓**不采用**它：`seed` 只搬历史，preset / 权限 /
> 模型路由要靠 `applyChildComposition` 那一整套手工重建，而 `sessions.fork` 是官方
> **自动继承**（侧线的核心价值就是「和主会话同一条线」）。取舍见设计文档 §5.1(E)。

## 目录内容

| 文件 | 作用 |
|---|---|
| `patch.mjs` | **补丁规范**：1 条锚点编辑 + 产物语法守卫 `parseVerdict()` + **行为自证 `behaviorVerdict()`** + CLI（verify / status / apply / revert） |
| `rebuild-baseline.mjs` | **升级专用**：以当前安装的官方原版重建 baseline，并打印待同步进 `patch.mjs` 的三个常量（只写 baseline/，不改常量） |
| `baseline/client.original.js` | DSH **0.2.0-rc.2** 官方原版 client.js（200,045 B，SHA-256 `E7845437…`） |

> 与 conversation / sidebar 补丁同：**不存 patched 全文**（产物 201,756 B，SHA
> `511E7A12…`），`verify` 用「由原始 baseline 重建出的 SHA 是否等于该常量」自证 ——
> SHA 相等即逐字节相等；锚点失配时仍会响亮报错，另有一道 `vm.Script` 经典脚本语法闸门。

### 三道闸门，各管一段（为什么不止两道）

| 闸门 | 证明什么 | 证明不了什么 |
|---|---|---|
| SHA 重建比对 | 「由 baseline 重建 == 记录产物」 | 产物逻辑对不对 |
| `vm.Script` 语法闸门 | 「产物是合法经典脚本」（bundle 坏一个包全体失效） | 产物逻辑对不对 |
| **行为自证（7 例）** | **那段判定逻辑真的按契约工作**：键缺失 / 命中 / 未命中 / 空数组 / 改回缺失（缓存须失效）/ 坏 JSON / 非数组 / 数组混入非字符串 | —— |

行为自证把产物里**我们插入的那一段**抽出来真的跑一遍（自包含、不依赖包内其他符号）。
它专治一类场景：**升级适配时重算 `PATCHED_SHA256`** —— 那时前两道闸门会一起变绿，
只有它会问「改完的判定逻辑还对吗」。首版它自己抓出过一个真缺陷（替身被闭包捕获 ⇒ 逐例不变量），
所以这道闸门不是仪式。

## 补丁做了什么

一条编辑，按「锚点唯一」定位（不唯一或缺失即报错，宁可失败也不瞎改）：

```diff
  * either way so unarchiving restores position.
  */
+ /**
+ * miasaki 侧线（@miasaki/dsh-sidebar「辅助对话」）的列表隐藏声明。
+ * …（读取函数：键、缓存、降级语义，见 patch.mjs 原文）
+ */
+ const MIASAKI_SIDECHAT_HIDDEN_KEY = "miasaki-sidebar:sidechat:hidden:v1";
+ let miasakiSideChatHiddenRaw = null;
+ let miasakiSideChatHiddenSet = new Set();
+ function miasakiSideChatHidden(sessionId) { … }
  function sessionVisible(session, current, archived, archivedFilter) {
      if (session.origin === "subagent") return false;
+     if (miasakiSideChatHidden(session.id)) return false;
```

要点：

- **一处判定覆盖两条路径**：`sessionVisible()` 是分组列表（`deriveGroups` →
  `groupByWorkspace`）、扁平列表（`visibleSessionIds` / `sessionMemberIds`）与会话
  搜索（`deriveSearchResults`）**共用的唯一判据** —— 侧线既不在列表里，也不在搜索里；
- **零官方逻辑改动**：官方既有分支一行未动，只在 origin 判定之后追加一条；
- **失败即官方原状（关键）**：localStorage 读不到、键不存在、内容不是合法 JSON、
  元素不是非空字符串 —— 一律按「没有侧线」处理。插件没装时本补丁等于空操作，
  **不可能因为声明的问题把人挡在列表外**；
- **性能**：按「上一次读到的原始字符串」做缓存，只有声明真的变了才重新 parse，
  列表派生的高频调用不会反复 JSON 解析。

## 跨包契约：声明键

| 项 | 值 |
|---|---|
| 键 | `miasaki-sidebar:sidechat:hidden:v1` |
| 位置 | 浏览器 `localStorage`（与插件的侧线登记表同一介质） |
| 值 | JSON **字符串数组**：侧线 child 会话 id（如 `["session-3bac833a…"]`） |
| 写入方 | `@miasaki/dsh-sidebar`（客户端）：侧线登记表每次变更后重写全量 |
| 读取方 | 本补丁（`dsh-client-ui-workspace` 产物） |
| 另一个消费方 | `@miasaki/dsh-canvas`（**会话布**）：它不隐藏侧线，反而**照旧显示**，并用这份声明给那条线打**「辅助对话」标注** —— 与画布是否显示无关的只有本补丁；画布的显示权来自宿主 `ctx.sessions.list()` |

**为什么用 localStorage 而不是别的**：它是**唯一**同时满足「插件能写」「壳能读」
「页面刷新后仍在（首屏即正确）」的地方 —— 走 host 服务要多一轮往返且首帧可能闪出侧线行。

## 用法

```powershell
cd dsh-miasaki-desktop/patches/dsh-client-ui-workspace

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
2. 用 `baseline/client.original.js` ↔ 新版 client.js 做 diff，核对 `sessionVisible`
   的 JSDoc 与 origin 判定两行是否仍在（`patch.mjs` 会在锚点缺失或多重命中时明确报错）；
3. 锚点漂移则更新 `EDITS` 与 baseline，再跑 `node rebuild-baseline.mjs` 取新常量、
   `node patch.mjs verify` 自证；
4. `node patch.mjs apply` 重新应用，刷新页面生效。

## 边界（勿越线）

- 补丁只改 `dsh-client-ui-workspace` 这一个包的 client 产物，**不动 DSH 源码、不动其他包**；
- 与本仓其余本体补丁同属「不修改 DSH 本体」原则的**例外**，代价同样明确（升级覆盖、需重打）；
- **只隐藏本插件声明的侧线**：不碰普通会话、不碰官方 subagent 会话、不碰归档/置顶语义；
- client 侧补丁，刷页面即生效，无需重启 host；
- 官方桌面端（`app.asar` 内自带官方包）**天然不受影响** —— 补丁只作用于
  `%APPDATA%\npm` 全局安装（即 `dsh web` / miasaki 桌面端加载的那一份）。
