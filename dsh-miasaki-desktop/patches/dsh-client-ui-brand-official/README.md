# DSH 官方品牌徽标 → DSH 部署品牌名运行时补丁

> 侧边栏品牌行的 `sidebar.brand.name` slot 由官方插件
> `@deepseek-ai/dsh-client-ui-brand-official` 填充：渲染
> `BrandWordmark{ includeMark: false }`（primitives 包的唯一实现，
> `lib/index.js`）—— deepseek 字标（8 个字母 path）+ 黑胶囊徽标
> 「HARNESS」（rect 胶囊 `x=129.348 y=5.5 w=52 h=14 rx=2` +
> 7 个转曲字母 path，反色 `var(--dsw-alias-label-primary-inverted)`）。
> 本补丁把该 occupant 换成部署自有实现 **DshBrandName**：品牌名区
> **整块渲染「DSH」**（不再复刻 deepseek 字标与胶囊徽标）。鲸鱼 mark
> （`sidebar.brand.mark` 的 FishLogo）不动 —— 左上角读作「鲸鱼 + DSH」。

`BrandWordmark` 全局仅本包一处在用（客户端 exports 亦只有本包），
补丁影响面 = 仅侧边栏品牌名；会话主视觉的鱼是声明包自带 animated
fallback，不受影响。

## 沿革（两次形态，一次 legacy 升级路径）

| 版本 | 品牌名区 | 产物 |
|---|---|---|
| 2026-09-28 – 2026-10-12 | deepseek 字标（8 path **逐字节保留**）+ 黑胶囊徽标「MIASAKI」 | 8,286 B / `821DD9B3…` |
| **2026-10-12 起** | **整块「DSH」**（鲸鱼 mark 不变） | 3,314 B / `6E9FFF1B…` |

旧产物由 `classify` 识别为 `legacy`：`apply` 可**直接原地升级**（不需要
`--yes`），升级前把旧文件另存 `<client.js>.dsh-legacy-bak` 留档。
`revert` 仍回到官方原版（`.dsh-bak` 是 2026-09-29 存的 0.1.7-rc.2 原版）。

## 为什么是「运行时补丁」而不是插件

- slot 替换机制上本可写一个注册同名单 slot 的客户端插件，但那需要
  **新增 profile bundle 装载**（改 `~/.dsh/profiles/miasaki/package.json`
  + 重装 link + 宿主重载 profile），生效链路比重打个 client bundle 更长；
- 该项目对 DSH 本体补丁已有既定路线与全套基建（锚点唯一校验、
  SHA 重建自证、`vm.Script` 语法闸门、verify 接入统一回归），
  与其余本体补丁同型：**只改一个包的 client 产物，不动 DSH 源码、
  不动其他包**。

**代价必须说清楚**：DSH 升级会覆盖该包，补丁随之消失，需要重新
应用。这就是本目录入库的原因——补丁规则 + 基线进版本控制后，
升级后能**重建、能校验、能回退**。

## 目录内容

| 文件 | 作用 |
|---|---|
| `patch.mjs` | **补丁规范**：2 条锚点编辑（①插入 DshBrandName 组件定义 ②OfficialBrandName 改渲染它）+ CLI（verify / status / apply / revert） |
| `rebuild-baseline.mjs` | **升级专用**：以当前安装的官方原版重建 baseline，并打印待同步进 `patch.mjs` 的三个常量（只写 baseline/、不改常量） |
| `baseline/client.original.js` | DSH **0.1.7-rc.2** 官方原版 client.js（1,863 B，SHA-256 `22BB7E18…`） |

> 与其他补丁一致：**不存 patched 全文**。产物以 `PATCHED_SHA256`
> 常量记录（3,314 B），`verify` 用「由原始 baseline 重建出的 SHA
> 是否等于该常量」自证——SHA 相等即逐字节相等，锚点失配时仍会
> 响亮报错；另有一道语法闸门（`vm.Script` 经典脚本目标），产物
> 必须是合法 JS 才允许落盘。

## 补丁做了什么

两条编辑，各按「锚点唯一」定位（不唯一或缺失即报错，宁可失败也不瞎改）：

| # | 编辑 | 锚点 |
|---|---|---|
| 1 | 在 Brand.js region 末尾插入 `DshBrandName` 组件（一个 24 单位高的 SVG，内含 `<text>DSH</text>`） | `//#endregion` + `//#region lib/types/client/index.js` 两行 |
| 2 | `OfficialBrandName` 的返回由 `BrandWordmark{includeMark:false}` 改为 `DshBrandName` | `function OfficialBrandName() {` + return 行 + `}` 三行 |

要点：

- **组件签名与官方对齐**（`{ size = 24, className }`，高 `size`、
  宽 `size * 41.5 / 24`），sidebar 的 `.brandName` 容器无需任何变化；
- **字号/字重/字距写成 SVG 呈现属性**（`font-size:20` / `font-weight:700` /
  `letter-spacing:0` / `fill:currentColor`）—— 呈现属性优先于继承值，
  故 `.brandName` 的 `font-size:18px;font-weight:600;letter-spacing:.04em`
  不会串味（否则实测几何与下面的推导不符）；`fill:currentColor`
  让颜色跟随侧边栏文字令牌，浅色/深色主题自动解析；
- **不引第三方资源**：系统字体栈 `'Segoe UI', system-ui, sans-serif`，
  无网络字体、无图片。

## 尺寸怎么定的（量出来的，不是估的）

官方字标的几何取自 primitives 的 path 数据：ink 为 `y 4.628→18.622`
（高 **13.99**）、相对其 viewBox 左边缘 `26` 偏移 **0.95**。于是我们要求
「DSH」的 cap 高与之等高、基线与之 ink 底对齐。用 Edge 无头 canvas
`measureText` 量 Segoe UI（Windows 系统字体，确定性）：

| 字体规格 | advance | ink 左 | ink 右 | cap 高（D/H） |
|---|---|---|---|---|
| **700 / 20px（采用）** | **41.279** | **1.000** | **39.957** | **14.000** |

⇒ 取 `fontSize=20`（cap 高 14.00 与官方字标 13.99 逐值同档）、
基线 `y=18.62`（官方 ink 底 18.622）、`viewBox="0 0 41.5 24"`
（ink 右 39.957 + 1.54 余量，防亚像素裁切）。

复现命令（任意 Edge/Chromium 无头）：

```powershell
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
# 把下面这段存成 measure.html 后：& $edge --headless=new --dump-dom file:///<路径>/measure.html
# <div id="out"></div><script>
# const c=document.createElement('canvas').getContext('2d'); c.font='700 20px "Segoe UI"';
# const t=c.measureText('DSH'), d=c.measureText('D');
# out.textContent=[t.width,t.actualBoundingBoxLeft,t.actualBoundingBoxRight,d.actualBoundingBoxAscent].join(' ');
# </script>
# 期望：41.279 -1.000 39.957 14.000
```

**渲染自证（2026-10-12 实测）**：从补丁产物里抽出组件代码、用 stub
`react_jsx_runtime` 求值后，套官方品牌行 CSS（`.brandIdentity` /
`.brandMark` / `.brandName` 原文）在 Edge 里渲染，量得——

| 判据 | 实测 | 期望 |
|---|---|---|
| `<text>` 排版宽 | 41.281 | ↔ canvas advance 41.279（两套独立测量吻合） |
| ink 右边界 | 39.957 < viewBox 宽 41.5 | **不裁切** |
| 鲸鱼 ink 右 → D ink 左 | **9.84 px** | 官方同口径 **9.79 px**（视觉同档） |
| `getComputedStyle` | 20px / 700 / `normal` / `rgb(26,26,26)` | 继承的 18px/600/.04em 被正确覆盖，颜色随文字令牌 |

## apply 为什么不「就地打补丁」

`apply` 写入的内容**一律**取「由仓库 baseline 重建 + 两侧 SHA 自证」的产物，
不对目标文件就地去匹配锚点。原因是 2026-10-12 实测踩到的一条：**legacy
（旧版 MIASAKI 胶囊）产物的锚点与官方原版不同** —— 它的 `OfficialBrandName`
已经指向 `MiasakiBrandName`，对它就地去匹配原版锚点必然命中 0 次
（`dsh-brand-name-usage: 锚点必须唯一，实际命中 0 次`）。重建路径写的是
**逐字节确定的内容**，顺带消掉「目标被第三方手改过」的风险；`original`
状态下目标与 baseline 逐字节相同（SHA 相等），故两种路径产物一致。

## 还原与回退

```powershell
node patch.mjs revert   # 从 client.js.dsh-bak 还原官方原版，刷页面即生效
```

## 用法

```powershell
cd dsh-miasaki-desktop/patches/dsh-client-ui-brand-official

node patch.mjs verify            # 离线自检：baseline 原始 → 重建 → 与记录 SHA 比对 + 语法闸门
node patch.mjs status            # 检查已安装 bundle 的状态（original / patched / legacy / unknown）与语法
node patch.mjs apply             # 备份 + 应用（幂等：已打过则跳过；legacy 可直接升级）
node patch.mjs revert            # 从 .dsh-bak 还原
node rebuild-baseline.mjs        # 升级后：用当前安装的官方原版重建 baseline

# 通用参数：--target <client.js 路径> 覆盖自动探测（默认探测 %APPDATA%\npm 全局安装）
#          --yes 允许对 unknown 状态的目标强制应用（original / legacy 无需）
```

> **注（2026-09-28 修复）**：这两个参数在 2026-09-28 之前**双双失效** ——
> `parseArgs` 把 `argv[i]` 误写成 `args[i]`（`args` 是结果对象，`args[i]` 恒为 `undefined`），
> 于是 `--target` 被忽略、**恒回落到 live 安装目录**，`--yes` 恒为 false。
> 已在同批修复并实测验证（见
> [`../../design/CHANGELOG.md`](../../design/CHANGELOG.md) 2026-09-28（续八））。
> **若你在旧提交上用 `--target` 做过离线预检，那次针对本件的结论不成立**（其余八件不受影响）。

`verify` 是纯离线检查，不碰安装目录，已接入仓库级统一回归：

```powershell
node ..\..\..\scripts\verify-all.mjs desktop
```

## DSH 升级后怎么办

1. `node patch.mjs status` —— 若显示 `unknown`，说明安装的是新版本，补丁已被覆盖；
2. 用 `baseline/client.original.js` ↔ 新版 client.js 做 diff，核对 2 条锚点是否仍在
   （`patch.mjs` 会在锚点缺失或多重命中时明确报错，不会静默改错）；
   另需确认 primitives 的 `BrandWordmark` 字标 ink 几何未变（本补丁的
   字号/基线是按「与官方字标 ink 等高对齐」推的，官方字标若漂移，
   DSH 的视觉大小就不再与之同档——这是唯一的"软"依赖）；
3. 锚点漂移则更新 `EDITS` 与 baseline，再跑 `node rebuild-baseline.mjs`
   取新常量、`node patch.mjs verify` 自证；
4. `node patch.mjs apply` 重新应用，刷新页面生效。

## 边界（勿越线）

- 补丁只改 `dsh-client-ui-brand-official` 这一个包的 client 产物，
  **不动 DSH 源码、不动其他包**；
- 与其余本体补丁同属「不修改 DSH 本体」原则的**例外**，代价同样
  明确（升级覆盖、需重打）；
- client 侧补丁，刷页面即生效，无需重启 host；
- 鲸鱼 mark 属 `sidebar.brand.mark` slot，**不在本补丁范围内**。
