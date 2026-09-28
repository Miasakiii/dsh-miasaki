# 品牌徽标 HARNESS → miasaki 部署名补丁（第八处本体补丁）

- 日期：2026-09-28
- 状态：已落地并实机验证（0.1.7-rc.2，`status=patched`，刷页面生效）
- 补丁目录：`patches/dsh-client-ui-brand-official/`
- 统一回归：`scripts/verify-all.mjs` desktop 线 +1 项（35/35 PASS）

## 事件

用户指着侧边栏左上角品牌行（鲸鱼 + deepseek 字标 + 黑胶囊「HARNESS」）
问「把这个改成 Miasaki 怎么样」——要求替换的是**胶囊徽标文字**，
deepseek 字标与鲸鱼 mark 保留。

## 归因与机制

品牌行由两个 slot 组成（`dsh-client-ui-sidebar` 声明）：

| slot | 官方 occupant | 渲染 |
|---|---|---|
| `sidebar.brand.mark` | `FishLogo`（24px 鲸鱼） | 保留不动 |
| `sidebar.brand.name` | `OfficialBrandName` → `BrandWordmark{includeMark:false}` | deepseek 字标 + HARNESS 胶囊 |

`BrandWordmark` 是 primitives 包（`lib/index.js`，exports 唯一实现）
的纯 SVG 复刻：8 个字母 path（d/e/e/p/s/e + k 的两笔）+ 胶囊 rect
（`x=129.348 y=5.5 w=52 h=14 rx=2`，fill currentColor）+ badge g 里
7 个 HARNESS 转曲字母（fill `var(--dsw-alias-label-primary-inverted)`）。
viewBox `26 0 156 24`。

官方替换通道：slot 是 single occupant，**后注册的 occupant 胜出**
（runner 文档「a dynamically registered entry ... makes it the winner」）。
替换姿势有两个：①写一个注册同 slot 的客户端插件；②直接改
official occupant 的实现（本补丁）。

## 方案对比：为什么是补丁而不是插件

| | 补丁（本方案） | 新客户端插件 |
|---|---|---|
| 装载 | 无（就地改一个 client 产物） | 改 `~/.dsh/profiles/miasaki/package.json`（link: + bundles）+ pnpm install + **宿主重载 profile** |
| 生效 | client-hmr 热推 / 刷页面 | 需宿主重新 evaluate profile（本会话宿主为用户 GUI 进程，不便重启） |
| 基建复用 | 锚点唯一校验 + SHA 重建自证 + 语法闸门 + 统一回归（既有 8 补丁同型） | 从零 |
| 代价 | DSH 升级覆盖需重打 | 新包需长期维护、随 profile 走 |

用户 GUI 宿主进程不可轻易重启 + 项目已有补丁全套基建 ⇒ 选补丁。
这与其余本体补丁同属「不修改 DSH 本体」原则的**例外**。

## 实现

`patches/dsh-client-ui-brand-official/patch.mjs`：2 条锚点编辑。

1. **插入 `MiasakiBrandName` 组件**（Brand.js region 末尾）：
   - `MIASAKI_WORDMARK_LETTERS`：8 个字标 path，**从 primitives
     `lib/index.js` 逐字节提取**（非手抄）；
   - 复刻 SVG：viewBox `26 0 156 24`、字标 fill currentColor、
     胶囊 rect 与官方完全同几何；
   - 徽标改为 `<text>`（`x="136.5" y="15"`，fontSize 7.4 / bold /
     letter-spacing 0.2，系统无衬线栈），fill 取官方同款反色 token。
2. **`OfficialBrandName` 返回改渲染 `MiasakiBrandName`**。

关键教训（**手抄事故**）：第一版 8 个 path 是人工转写的 6KB path
数据，逐字节 diff 抓到 2 处静默错字（`33.6562→32.6562`、
`95.006→96.006` 且多抄一段）。已全部改为程序化提取/替换/比对
（patch.mjs 里的数组经脚本与 primitives 原文逐字节断言一致后才
进入 verify 流程）。

**字标保真验证**：Edge 无头渲染「官方复刻 svg（8 path + HARNESS
徽标）」vs「补丁复刻 svg（8 path + MIASAKI）」——两者字标渲染
逐像素一致（含「deepse」与「k」之间的间隙：那是官方 wordmark
原本的几何，非补丁引入；GUI 原尺寸下间隙约 2px 不可见，放大
截图才显形）。

胶囊内文字位置如需微调：改 patch.mjs 编辑 1 里 text 的 `x/y`
（当前视觉略偏左约 1–2 单位），重跑 verify → apply。

## 边界

- 只改 `dsh-client-ui-brand-official` 一个包的 client 产物；
- `BrandWordmark` 全局仅本包一处在用（exports 亦只有本包），
  影响面 = 仅侧边栏品牌名；会话主视觉的鱼是声明包 animated
  fallback，不受影响；
- 字标 8 path 是**软依赖** primitives 的 BrandWordmark data：升级后
  若官方字标漂移需重新提取（README「DSH 升级后怎么办」第 2 步）；
- client 侧补丁，刷页面即生效，无需重启 host；回退 `revert` 即可。

## 实机验证

- `node patch.mjs verify` PASS（基线 1863 B / 产物 8286 B，SHA
  `821DD9B3…`，两侧语法闸门）；
- `node patch.mjs status/apply`：安装目录 0.1.7-rc.2 原版 → patched，
  备份 `.dsh-bak` 就位；
- `verify-all.mjs desktop` 35/35 PASS；
- 用户实机截图确认：胶囊内 HARNESS → MIASAKI，字标与鲸鱼不变。
