# DSH 官方品牌徽标 HARNESS → miasaki 部署品牌名运行时补丁

> 侧边栏品牌行的 `sidebar.brand.name` slot 由官方插件
> `@deepseek-ai/dsh-client-ui-brand-official` 填充：渲染
> `BrandWordmark{ includeMark: false }`（primitives 包的唯一实现，
> `lib/index.js`）—— deepseek 字标（8 个 path）+ 黑胶囊徽标
> 「HARNESS」（rect 胶囊 `x=129.348 y=5.5 w=52 h=14 rx=2` +
> 7 个转曲字母 path，反色 `var(--dsw-alias-label-primary-inverted)`）。
> 本补丁把该 occupant 换成部署自有实现 **MiasakiBrandName**：
> deepseek 字标 8 path 与官方**逐字节一致**（视觉零变化），黑胶囊
> 几何不变，徽标文字 **HARNESS → MIASAKI**（SVG `<text>`，取官方同款
> 反色 token）。鲸鱼 mark（`sidebar.brand.mark` 的 FishLogo）不动。

`BrandWordmark` 全局仅本包一处在用（客户端 exports 亦只有本包），
补丁影响面 = 仅侧边栏品牌名；会话主视觉的鱼是声明包自带 animated
fallback，不受影响。

## 为什么是「运行时补丁」而不是插件

- slot 替换机制上本可写一个注册同名单 slot 的客户端插件，但那需要
  **新增 profile bundle 装载**（改 `~/.dsh/profiles/miasaki/package.json`
  + 重装 link + 宿主重载 profile），生效链路比重打个 client bundle 更长；
- 该项目对 DSH 本体补丁已有既定路线与全套基建（锚点唯一校验、
  SHA 重建自证、`vm.Script` 语法闸门、verify 接入统一回归），
  与其余七处补丁同型：**只改一个包的 client 产物，不动 DSH 源码、
  不动其他包**。

**代价必须说清楚**：DSH 升级会覆盖该包，补丁随之消失，需要重新
应用。这就是本目录入库的原因——补丁规则 + 基线进版本控制后，
升级后能**重建、能校验、能回退**。

## 目录内容

| 文件 | 作用 |
|---|---|
| `patch.mjs` | **补丁规范**：2 条锚点编辑（①插入 MiasakiBrandName 组件定义 ②OfficialBrandName 改渲染它）+ CLI（verify / status / apply / revert） |
| `rebuild-baseline.mjs` | **升级专用**：以当前安装的官方原版重建 baseline，并打印待同步进 `patch.mjs` 的三个常量（只写 baseline/、不改常量） |
| `baseline/client.original.js` | DSH **0.1.7-rc.2** 官方原版 client.js（1,863 B，SHA-256 `22BB7E18…`） |

> 与其他补丁一致：**不存 patched 全文**。产物以 `PATCHED_SHA256`
> 常量记录（8,286 B），`verify` 用「由原始 baseline 重建出的 SHA
> 是否等于该常量」自证——SHA 相等即逐字节相等，锚点失配时仍会
> 响亮报错；另有一道语法闸门（`vm.Script` 经典脚本目标），产物
> 必须是合法 JS 才允许落盘。

## 补丁做了什么

两条编辑，各按「锚点唯一」定位（不唯一或缺失即报错，宁可失败也不瞎改）：

| # | 编辑 | 锚点 |
|---|---|---|
| 1 | 在 Brand.js region 末尾插入 `MIASAKI_WORDMARK_LETTERS`（8 个官方字标 path 原文）+ `MiasakiBrandName` 组件 | `//#endregion` + `//#region lib/types/client/index.js` 两行 |
| 2 | `OfficialBrandName` 的返回由 `BrandWordmark{includeMark:false}` 改为 `MiasakiBrandName` | `function OfficialBrandName() {` + return 行 + `}` 三行 |

要点：

- 字标 8 path **从 primitives `lib/index.js` 的官方源码逐字节提取**
  （提取与比对用脚本完成，不用手抄——手抄 6KB path 数据出过两处
  静默错字，靠逐字节 diff 才抓住）；
- 胶囊内 MIASAKI 用 SVG `<text>`（`x="136.5" y="15"`，
  `fontSize 7.4 / fontWeight 700 / letterSpacing 0.2`，系统无衬线栈），
  黑底 rect 与胶囊几何**与官方完全一致**；文字位置可在 `patch.mjs`
  编辑 1 的 text 参数里微调（`x` / `y`）；
- 组件签名与官方对齐（`{ size = 24, className }`，宽
  `size*156/24`），sidebar 的 `.brandName` 容器无需任何变化。

## 还原与回退

```powershell
node patch.mjs revert   # 从 client.js.dsh-bak 还原官方原版，刷页面即生效
```

## 用法

```powershell
cd dsh-miasaki-desktop/patches/dsh-client-ui-brand-official

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
2. 用 `baseline/client.original.js` ↔ 新版 client.js 做 diff，核对 2 条锚点是否仍在
   （`patch.mjs` 会在锚点缺失或多重命中时明确报错，不会静默改错）；
   另需确认 primitives 的 `BrandWordmark` 字母 path 未变（若新版字标
   data 漂移，字标会静默变形——这是本补丁唯一的"软"依赖）；
3. 锚点漂移则更新 `EDITS` 与 baseline，再跑 `node rebuild-baseline.mjs`
   取新常量、`node patch.mjs verify` 自证；
4. `node patch.mjs apply` 重新应用，刷新页面生效。

## 边界（勿越线）

- 补丁只改 `dsh-client-ui-brand-official` 这一个包的 client 产物，
  **不动 DSH 源码、不动其他包**；
- 与其余七个本体补丁同属「不修改 DSH 本体」原则的**例外**，代价同样
  明确（升级覆盖、需重打）；
- client 侧补丁，刷页面即生效，无需重启 host。
