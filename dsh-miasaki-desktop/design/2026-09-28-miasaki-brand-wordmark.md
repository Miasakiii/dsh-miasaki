# 品牌徽标 HARNESS → 部署品牌名补丁（第八处本体补丁）

- 日期：2026-09-28
- 状态：已落地并实机验证（0.1.7-rc.2，`status=patched`，刷页面生效）
- 改版：**2026-10-12 两次改版 —— 白天由「deepseek 字标 + 胶囊 MIASAKI」改为整块「DSH」，
  晚间按用户点名定为「DSH 字标 + 黑胶囊 MIASAKI」**（见文末两段；本文档上半部分保留
  09-28 首次落地的原始记录，未改写）
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

## 2026-10-12 改版：品牌名区整块换成「DSH」

**事件**：用户贴出左上角现状截图（鲸鱼 + deepseek 字标 + 黑胶囊「MIASAKI」）
要求「左上角改为 DSH」。形态有多种合理读法（只换胶囊文字 / 整块换 /
连鲸鱼一起换），故先问后做；用户选择 **「保留鲸鱼，整块品牌名换成 DSH」**。

**为什么是这个形态**：官方那一行的语义本来就是「deepseek 字标 + HARNESS 胶囊
= DeepSeek Harness」，miasaki 版把胶囊换成了 MIASAKI。用户这次要的是这行读作
**DSH**（DeepSeek Harness 的缩写）⇒ 不是「换胶囊里的词」，而是**整块品牌名
就是 DSH**；鲸鱼是 `sidebar.brand.mark` 另一个 slot 的官方 occupant，
不在本补丁范围，保留 ⇒ 左上角读作「鲸鱼 + DSH」。

**实现（patch.mjs 重写编辑 1）**：删掉原来那套「复刻 8 条官方字标 path +
黑胶囊 rect + 胶囊内 `<text>`」的 ~5 KB 产物，改为一个 24 单位高的 SVG，
内含单个 `<text>DSH</text>`。组件名 `MiasakiBrandName` → `DshBrandName`
（幂等标记与产物形态同步换）。字号/字重/字距/颜色写成 **SVG 呈现属性**
（`20` / `700` / `0` / `currentColor`）—— 呈现属性优先于继承值，故
`.brandName` 的 `font-size:18px;font-weight:600;letter-spacing:.04em`
不会串味（这是硬约束：一旦串味，下面按 20px 推的几何全部不成立）。

**尺寸不是估的，是量的**：官方字标 ink 为 `y 4.628→18.622`（高 **13.99**）、
相对 viewBox 左缘偏移 **0.95**。用 Edge 无头 canvas `measureText` 量系统字体
Segoe UI 在 700/20px 下的「DSH」：advance **41.279**、ink `1.000→39.957`、
cap 高（D/H）**14.000** ⇒ 取 `fontSize=20`（cap 高与官方字标逐值同档）、
基线 `y=18.62`、`viewBox="0 0 41.5 24"`（ink 右 + 1.54 余量防亚像素裁切）。

**渲染自证（离线，不依赖 GUI 登录态）**：从**补丁产物**里抽出组件代码，
用 stub `react_jsx_runtime` 求值成虚拟树 → 转 markup → 套官方品牌行 CSS
（三条规则**从 sidebar client.js 原文抽取**，未手抄）在 Edge 里渲染：

| 判据 | 实测 | 对照 |
|---|---|---|
| `<text>` 排版宽 | 41.281 | canvas advance 41.279（两套独立测量吻合） |
| ink 右边界 | 39.957 | viewBox 宽 41.5 ⇒ **不裁切** |
| 鲸鱼 ink 右 → D ink 左 | **9.84 px** | 官方同口径 **9.79 px** |
| 计算样式 | 20px / 700 / `normal` / `rgb(26,26,26)` | 继承值被呈现属性正确覆盖 |
| 浅色 / 深色主题 | 均跟随 `currentColor` | 无硬编码色 |

**踩到并修掉的一个真缺陷（apply 的 legacy 路径）**：`classify` 加了 `legacy`
识别后，`apply` 最初仍是「对目标就地打补丁」⇒ 对旧版 MIASAKI 产物**必然**
锚点命中 0 次而失败（`dsh-brand-name-usage: 锚点必须唯一，实际命中 0 次`）——
旧产物的 `OfficialBrandName` 已指向 `MiasakiBrandName`，与官方原版锚点不同。
**修法**：`apply` 一律改为写「由仓库 baseline 重建 + 两侧 SHA 自证」的产物，
不针对目标就地匹配锚点。这比原来更强 —— 写的是逐字节确定的内容，
顺带消掉「目标被第三方手改过」的风险；`original` 状态下目标与 baseline
逐字节相同，两种路径产物一致。旧产物在升级前另存 `.dsh-legacy-bak` 留档。

**产物与回归**：3,314 B / `6E9FFF1BBFE8EB04…`（旧版 8,286 B / `821DD9B3…`）；
`verify` PASS、`apply` 后 `status=patched`、幂等复跑跳过；实机侧刷页面即生效
（client-hmr 会热推）。已知 `verify-all.mjs desktop` 的本件闸门只跑 `verify`（离线重建自证）。

**一次探针自伤（记下来省得再犯）**：渲染探针第一版把 SVG 的 `viewBox`
按通用 camelCase→kebab 规则写成了 `view-box`，浏览器不认 ⇒ 页面脚本读
`getAttribute('viewBox')` 拿到 `null` 后抛错、测量输出停在 `pending`。
**React 的 SVG 属性名有特例**（`viewBox` / `preserveAspectRatio` 等保持原样），
不能一律 kebab 化 —— 探针本身也得按 React 的映射规则写。

## 2026-10-12 晚 · 第三次改版：「DSH 字标 + 黑胶囊 MIASAKI」

**事件**：整块「DSH」落地后，黑胶囊随之消失；用户说「右上角黑色胶囊MIASAKI不要删了」
（随后更正位置为左上角），澄清后给出目标形态：**「DSH字标加黑胶囊MIASAKI」**
—— 保留 DSH 字标，把 2026-09-28 那版的黑胶囊徽标（内文 MIASAKI）放回来。

**几何**：三段各自有出处，横向排布复刻官方。

| 件 | 取值 | 出处 |
|---|---|---|
| DSH 字标 | Segoe UI 700 / 20px、基线 `y 18.62`、`x 0`、`fill currentColor` | 与上一版同参（cap 高 14.00 ↔ 官方字标 ink 13.99） |
| 胶囊 rect | `x 47.788` `y 5.5` `w 52` `h 14` `rx 2`、`fill currentColor` | 官方 HARNESS 徽标几何原样，只平移 x |
| 胶囊内文 | MIASAKI、`x 73.788`（= 胶囊中心）、`y 15`、7.4 / 700 / ls 0.2、**`text-anchor:middle`** | 旧版字号字距 + 本次改居中 |
| viewBox | `0 0 100.44 24`（宽 = `size * 100.44 / 24`） | 47.788 + 52 + 0.652（官方右缘余量） |

**间距怎么来的（量出来的）**：官方 `BrandWordmark{includeMark:false}` = `width size*156/24`
+ `viewBox "26 0 156 24"`；字标 ink 右 **121.517**（k 的最后一笔）、胶囊左 **129.348**
⇒「字标 ink 右 → 胶囊左」= **7.831**、viewBox 右缘余量 **0.652**。DSH 的 ink 右为
**39.957**（Edge canvas 实测）⇒ 胶囊左 **47.788**、胶囊中心 **73.788**、viewBox 宽 **100.44**。

**为什么改居中**：旧版把 MIASAKI 的 x 定在「胶囊左 + 7.152」（对齐官方 HARNESS 的起始
内边距），但 HARNESS 是 7 个转曲 path（≈38 单位宽）、MIASAKI 是 `<text>`（7.4px 下 ≈33.5）
⇒ 逐字对齐会让文字视觉偏左。改 `text-anchor:middle` 后，居中由渲染器按 advance 完成，
**不依赖字体度量**；`letterSpacing 0.2` 使尾部多 0.2 单位 advance、视觉重心偏左 0.1 单位
（≈0.1px），可忽略。

**度量与自证（本次没有浏览器渲染自证 —— 环境边界）**：本会话 `msedge.exe` / `chrome.exe`
**都无法执行**（`--version` 无输出、`--dump-dom` 得到 0 字节文件），与本仓既有的
「`cmd.exe` 被会话环境拒绝 spawn」同族，属环境边界而非缺陷。替代路径：

- Pillow + `C:\Windows\Fonts\segoeuib.ttf` 交叉验证：DSH @20px advance **41.000**
  （浏览器实测 41.279 —— 两套光栅器差 0.7%，同档，故既有几何结论继续成立）；
  MIASAKI 在 8px / 7px（7.4px 的上下界）advance **36.2 / 31.2** ⇒ 按 7.4px 约 **33.5**
  ⇒ 胶囊 52 宽居中后左右各余 **≈9.3 单位**（不贴边、不裁切）；
- 浅 / 深底近似效果图（4× 放大）目视复核：字标与胶囊比例、间距、反色 token 解析正常；
- **浏览器渲染自证缺席** ⇒ 实机可见性由用户刷页面确认（client-hmr 会热推 rebuilt 帧）。

**产物与回归**：`3,927 B / 250CAF785F449B9C…`；`verify` PASS（2 条编辑 + 两侧语法闸门）；
实机 `apply`：目标当时是上一版（整块 DSH）产物 ⇒ `classify` 判 `legacy`（新扩的历史标记
`const DSH_BRAND_VIEWBOX_WIDTH` 命中）⇒ 直接升级、上一版另存 `.dsh-prev-bak`、最老形态仍在
`.dsh-legacy-bak`，升级后 `status=patched`、幂等复跑跳过。
