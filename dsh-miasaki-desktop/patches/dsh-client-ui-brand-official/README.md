# DSH 官方品牌徽标 → 部署品牌名运行时补丁

> 侧边栏品牌行的 `sidebar.brand.name` slot 由官方插件
> `@deepseek-ai/dsh-client-ui-brand-official` 填充：渲染
> `BrandWordmark{ includeMark: false }`（primitives 包的唯一实现，
> `lib/index.js`）—— deepseek 字标（8 个字母 path）+ 黑胶囊徽标
> 「HARNESS」（rect 胶囊 `x=129.348 y=5.5 w=52 h=14 rx=2` +
> 7 个转曲字母 path，反色 `var(--dsw-alias-label-primary-inverted)`），
> 徽标区 `viewBox "26 0 156 24"`、宽 `size * 156 / 24`。
> 本补丁把该 occupant 换成部署自有实现 **DshMiasakiBrandName**：
> **「DSH」字标 + 黑胶囊「MIASAKI」**。鲸鱼 mark（`sidebar.brand.mark`
> 的 FishLogo）不动 —— 左上角读作「鲸鱼 + DSH + MIASAKI 徽标」。

`BrandWordmark` 全局仅本包一处在用（客户端 exports 亦只有本包），
补丁影响面 = 仅侧边栏品牌名；会话主视觉的鱼是声明包自带 animated
fallback，不受影响。

## 沿革（三个形态，两条 legacy 升级路径）

| 版本 | 品牌名区 | 产物 |
|---|---|---|
| 2026-09-28 – 2026-10-12 | deepseek 字标（8 path **逐字节保留**）+ 黑胶囊徽标「MIASAKI」 | 8,286 B / `821DD9B3…` |
| 2026-10-12 白天 | 整块「DSH」（胶囊被去掉） | 3,314 B / `6E9FFF1B…` |
| **2026-10-12 晚起** | **「DSH」字标 + 黑胶囊「MIASAKI」**（鲸鱼 mark 不变） | 3,927 B / `250CAF78…` |

两个历史形态都由 `classify` 识别为 `legacy`（标记分别是
`const MIASAKI_WORDMARK_LETTERS = [` 与 `const DSH_BRAND_VIEWBOX_WIDTH`）
⇒ `apply` 可**直接原地升级**（不需要 `--yes`），并各留一份档：
最老形态 → `<client.js>.dsh-legacy-bak`、上一形态 → `<client.js>.dsh-prev-bak`。
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
| `patch.mjs` | **补丁规范**：2 条锚点编辑（①插入 DshMiasakiBrandName 组件定义 ②OfficialBrandName 改渲染它）+ CLI（verify / status / apply / revert） |
| `rebuild-baseline.mjs` | **升级专用**：以当前安装的官方原版重建 baseline，并打印待同步进 `patch.mjs` 的三个常量（只写 baseline/、不改常量） |
| `baseline/client.original.js` | DSH **0.1.7-rc.2** 官方原版 client.js（1,863 B，SHA-256 `22BB7E18…`） |

> 与其他补丁一致：**不存 patched 全文**。产物以 `PATCHED_SHA256`
> 常量记录（3,927 B），`verify` 用「由原始 baseline 重建出的 SHA
> 是否等于该常量」自证——SHA 相等即逐字节相等，锚点失配时仍会
> 响亮报错；另有一道语法闸门（`vm.Script` 经典脚本目标），产物
> 必须是合法 JS 才允许落盘。

## 补丁做了什么

两条编辑，各按「锚点唯一」定位（不唯一或缺失即报错，宁可失败也不瞎改）：

| # | 编辑 | 锚点 |
|---|---|---|
| 1 | 在 Brand.js region 末尾插入 `DshMiasakiBrandName` 组件（一个 24 单位高的 SVG：`<text>DSH</text>` + 胶囊 `<rect>` + 胶囊内 `<text>MIASAKI</text>`） | `//#endregion` + `//#region lib/types/client/index.js` 两行 |
| 2 | `OfficialBrandName` 的返回由 `BrandWordmark{includeMark:false}` 改为 `DshMiasakiBrandName` | `function OfficialBrandName() {` + return 行 + `}` 三行 |

要点：

- **组件签名与官方对齐**（`{ size = 24, className }`，高 `size`、
  宽 `size * 100.44 / 24`），sidebar 的 `.brandName` 容器无需任何变化；
- **字号/字重/字距写成 SVG 呈现属性**（`font-size:20` / `font-weight:700` /
  `letter-spacing:0` / `fill:currentColor`）—— 呈现属性优先于继承值，
  故 `.brandName` 的 `font-size:18px;font-weight:600;letter-spacing:.04em`
  不会串味（否则实测几何与下面的推导不符）；
- **胶囊取官方几何原样**：`rect` 宽 52 / 高 14 / `y 5.5` / `rx 2`、
  `fill currentColor`（浅色主题下即黑胶囊），内文用官方同款反色 token
  `var(--dsw-alias-label-primary-inverted)`；
- **不引第三方资源**：系统字体栈 `'Segoe UI', system-ui, sans-serif`，
  无网络字体、无图片。

## 几何怎么定的（量出来的，不是估的）

### 字标「DSH」

官方字标的几何取自 primitives 的 path 数据：ink 为 `y 4.628→18.622`
（高 **13.99**）。用 Edge 无头 canvas `measureText` 量 Segoe UI
（Windows 系统字体，确定性）：

| 字体规格 | advance | ink 左 | ink 右 | cap 高（D/H） |
|---|---|---|---|---|
| **700 / 20px（采用）** | **41.279** | **1.000** | **39.957** | **14.000** |

⇒ 取 `fontSize=20`（cap 高 14.00 与官方字标 13.99 逐值同档）、
基线 `y=18.62`（官方 ink 底 18.622）。

### 黑胶囊「MIASAKI」

胶囊 rect 的几何**原样取自官方 HARNESS 徽标**（宽 52、高 14、`y 5.5`、
`rx 2`），只做横向平移：官方胶囊左 **129.348**，其左侧是官方字标
ink 右 **121.517** ⇒「字标 ink 右 → 胶囊左」间距 **7.831**；viewBox 右缘
余量 **0.652**（官方 viewBox 宽 156、胶囊右 181.348 相对 26 起点即 155.348）。
DSH 的 ink 右为 **39.957** ⇒

| 量 | 取值 |
|---|---|
| 胶囊左 `x` | 39.957 + 7.831 = **47.788** |
| 胶囊中心 | 47.788 + 26 = **73.788**（内文 `text-anchor:middle` 落点） |
| viewBox 宽 | 47.788 + 52 + 0.652 = **100.44** |

内文用 `text-anchor:middle` 居中，**不依赖字体 advance 的估算**
（旧版是固定 `x = 胶囊左 + 7.152`，逐字对齐官方 HARNESS 的起始内边距，
但两者字宽不同 ⇒ 视觉偏左）。

### 自证

复现命令（任意 Edge/Chromium 无头；**注意：本会话环境拦了
`msedge.exe` / `chrome.exe`**——见下节）：

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

**2026-10-12 晚实测（两条路径）**：

| 判据 | 实测 | 期望 / 对照 |
|---|---|---|
| DSH advance（Pillow + `segoeuib.ttf`） | **41.000** | 浏览器 41.279（两套光栅器差 0.7%，同档） |
| MIASAKI advance @8px / @7px（7.4px 上下界） | **36.2 / 31.2** | 按 7.4px ≈ **33.5** ⇒ 胶囊 52 宽居中后左右各余 ≈9.3，**不贴边不裁切** |
| 近似效果图（浅 / 深底，4×） | 比例、间距、反色 token 正常 | 目视复核通过 |
| **浏览器渲染自证** | **缺席**（环境拦了无头浏览器） | 留给实机：刷页面即见 |

> **环境边界（记下以免误判）**：本会话里 `msedge.exe --version` 与
> `chrome.exe --version` **都无任何输出**、`--dump-dom` 得到 0 字节文件
> —— 与本仓既有的「`cmd.exe` 被会话环境拒绝 spawn」同族，属环境边界，
> **不是**补丁缺陷。故本次没有浏览器侧渲染自证，改用 Pillow 度量
> 交叉验证 + 实机可见性确认。

## apply 为什么不「就地打补丁」

`apply` 写入的内容**一律**取「由仓库 baseline 重建 + 两侧 SHA 自证」的产物，
不对目标文件就地去匹配锚点。原因是 2026-10-12 实测踩到的一条：**历史
形态产物的锚点与官方原版不同** —— 它们的 `OfficialBrandName` 已经指向
`MiasakiBrandName` / `DshBrandName`，对它就地去匹配原版锚点必然命中 0 次
（`dsh-miasaki-brand-name-usage: 锚点必须唯一，实际命中 0 次`）。重建路径写的是
**逐字节确定的内容**，顺带消掉「目标被第三方手改过」的风险；`original`
状态下目标与 baseline 逐字节相同（SHA 相等），故两种路径产物一致。

## 还原与回退

```powershell
node patch.mjs revert   # 从 client.js.dsh-bak 还原官方原版，刷页面即生效
```

磁盘上会同时存在三份档（形态从新到旧）：

| 文件 | 内容 |
|---|---|
| `<client.js>.dsh-bak` | 官方原版（2026-09-29 存） |
| `<client.js>.dsh-legacy-bak` | 最老形态：deepseek 字标 + 胶囊 MIASAKI（8,286 B） |
| `<client.js>.dsh-prev-bak` | 上一形态：整块「DSH」（3,314 B） |

想回到某个历史形态：`git checkout <该形态所在提交> -- patch.mjs`
后用 `--target` 指向目标文件跑 `apply`。

## 用法

```powershell
cd dsh-miasaki-desktop/patches/dsh-client-ui-brand-official

node patch.mjs verify            # 离线自检：baseline 原始 → 重建 → 与记录 SHA 比对 + 语法闸门
node patch.mjs status            # 检查已安装 bundle 的状态（original / patched / legacy / unknown）与语法
node patch.mjs apply             # 备份 + 应用（幂等：已打过则跳过；两个历史形态可直接升级）
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
   另需确认 primitives 的 `BrandWordmark` 字标 ink 几何与胶囊 rect 是否漂移
   （本补丁的字号/基线/横向排布都是按它们推的 —— 这是唯一的"软"依赖）；
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
