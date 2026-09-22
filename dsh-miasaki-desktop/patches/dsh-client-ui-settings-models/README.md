# DSH 设置页「模型能力增强」运行时补丁

> 给 DSH 官方设置页（`@deepseek-ai/dsh-client-ui-settings-models`）增量加入
> **模型级「思考强度」下拉**与**逐模型「测试连通性」按钮**。
> 2026-09-07 首次落地，2026-09-08 补丁规则与基线文件入版本控制（此前只存在于 `vendor/`，不入库）。
>
> **2026-09-19（v2）：「测试连通性」改为真正的可用性探测。** v1 的实现复用官方目录探测
> （`GET {baseURL}/v1/models`），问的是「网关能不能列出模型目录」——Step Plan 这类只兼容
> `POST /v1/messages` 的订阅网关会回 401，于是**能正常对话的模型被报成错误**。v2 让按钮优先
> 调用 host 插件 [`plugins/dsh-model-probe/`](../../plugins/dsh-model-probe/) 的同源路由：
> 先发零消耗握手（必然被参数校验拒绝的请求）判定鉴权，仅在鉴权通过后发 1-token 生成请求，
> 结果按六分类渲染；插件缺席时自动降级回 v1 的目录探测。设计见
> [`../../design/model-probe-v2.md`](../../design/model-probe-v2.md)。
>
> **2026-09-19（v2.1）：修掉一次「能通过 verify、却让整页插件全灭」的产物事故，并补上语法闸门。**
> v2 的 locale 字典在 en / zh 各漏一个尾逗号，产物在 `testProbeOk` 处语法错误。因为当时的
> `verify` 只做「重建 == baseline」逐字节比对（**可复现 ≠ 合法**），坏产物照样 PASS 并被打进
> 安装目录，症状是浏览器报 `failed to import loader entry … loaded without registering` ——
> **多包合并的 client bundle 里只要一个包语法坏了，整份 bundle 都不注册，页面里所有插件一起失效**。
> 现在 `applyPatch` 出口强制过 `vm.Script` 语法闸门。细节见下文「产物不变量」。产物
> `C6C1DCBC…` → `F1717A07…`（+2 字节 = 补回的两个逗号）。
>
> **2026-09-21（v2.2）：edit #5 升级为「双代变体」，补丁同时支持 `0.1.5-rc.x` 与 `0.1.6-alpha.2`。**
> 官方在 0.1.6-alpha.2 把 model row 抽成独立组件 `ModelRow.tsx`，容量字段的渲染随之搬进组件内部，
> 而 `testing` / `testResults` / `testModel` 这些状态留在 `ModelListEditor` —— 于是：
> ① 原锚点 `editCapacity(index, "maxTokens", event.target.value);`（回调吃**事件对象**）在新版变成
> `editCapacity(index, "maxTokens", text);`（回调吃**文本**）；② 原插入位置（内联 JSX 的 children 数组）
> 在新版已不存在——那里是**组件的 props 对象**。因此 edit #5 改为 `variants` + `probe` 两代分支：
> 新版走「Editor 侧把两块 UI 渲染成 ReactNode → 作为 `reasoningRow` prop 传给 ModelRow →
> ModelRow 把它摆到容量字段之后」，闭包仍在 Editor，跨组件的是**已渲染好的节点**而非状态函数。
> **两份 baseline 与三个常量均未变**（官方原版仍是 0.1.5-rc.1），legacy 分支逐字节不动，
> `verify` 三行 PASS 照旧。实测两代真实产物上 `apply` 均成功（`0.1.5-rc.2`、`0.1.6-alpha.2`）。

> **2026-09-22（v3）：模型页三件事——无 Key 引导 / 思考强度可读化 / 批量测试与能力徽标。**
> 用户报「配置模型会失败」。排查确认**官方写入链路本身是好的**（`settings.mutate` 整数组 set
> 实测 ok），真正的崩溃在 dual-model 控件（另线修复，见其 CHANGELOG）。顺着这条线索把模型页
> 本身的三处短板一并补上，全部走本补丁的既有形态（EDITS + 语法闸门 + 黄金产物）：
>
> | 新 edit | 内容 | 数据来自 |
> |---|---|---|
> | `no-key-row-hint` | 缺 key 行的小点 tooltip 点名环境变量（如 `OPENROUTER_API_KEY`） | 行上原有 `row.apiKeyEnv` |
> | `no-key-card-hint` | 编辑卡片密钥区下方一行可操作提示（点名 ref + 后果） | `keyState` / `keyRef` |
> | `reasoning-default-resolver` | `catalogProps` 增加 `reasoningDefaultOf(id)`：按 id 在**解析后**命名空间值里找同 id 条目 | `namespace.value` |
> | `reasoningInheritLabel`（edit #1 助手） | 「继承」选项显示**当前生效值**（未声明 / 具体等级） | 上述解析器 |
> | `capabilities-state` | 徽标 Map + `testingAll` 态 | — |
> | `capabilities-effect-and-testall` | 能力加载 effect（`POST /model-probe-api/capabilities`）+ `testAllModels` 顺序跑全部行 | model-probe 插件 v0.2.0 |
> | `test-all-button` | 模型列表头「获取可用模型」右侧「测试全部」按钮 | — |
> | edit #5 两代变体 | 容量区行首**能力徽标**（视觉 / 推理），inherit 选项改走助手 | 徽标走 `capabilities` Map |
>
> **徽标是可选依赖**：路由 404（插件未装 / host 未重启）时静默无徽标，与探测降级同构。
> **免费模型池合体（C 项）零补丁改动**：baseline 0.1.5-rc.1 的 models section 本就声明并渲染了
> `settings.models.footer` 列表槽，插件改为优先注册到那里、失败才回退自有 section
> （见 `plugins/dsh-free-model-pool/lib/client.js`）。

## 为什么是「运行时补丁」而不是插件
官方设置页刻意不提供逐模型思考强度控件，也不做逐模型连通性测试——上游取向是
「effort 是 per-MODEL 能力，放在对话模型选择器里」。而本机没有 pnpm 全量重建链路
（npm registry HTTPS 不可达 / pnpm store 被沙箱锁死 / AppData 只读），
「fork 官方包 + 重建 dist」这条路走不通，因此**直接改写已安装包的编译产物**
`lib/client.js`（生产页面加载的就是它）。

**代价必须说清楚**：DSH 升级会覆盖该包，补丁随之消失，需要重新应用。
这就是本目录入库的原因——补丁规则 + 基线文件进版本控制后，升级后能**重建、能校验、能回退**，
而不是依赖某台机器上的一次性产物。

完整设计、源码位置核查与实施记录见
[模型设置工具包设计](../../../dsh-miasaki-shared-docs/cross/model-settings-toolkit-design-2026-09-07.md)。

## 目录内容

| 文件 | 作用 |
|---|---|
| `patch.mjs` | **补丁规范**：13 条锚点编辑规则（其中 **#5 分两代变体**，见下文「双代变体」）+ CLI（verify / status / apply / resync / revert / rebuild）+ **语法闸门**（`applyPatch` 出口强制 `vm.Script` 解析） |
| `rebuild-baseline.mjs` | **升级专用**：以当前安装的官方原版重建两份 baseline，并打印待同步进 `patch.mjs` 的三个常量（只写 baseline/，不改常量） |
| `baseline/client.original.js` | DSH **0.1.5-rc.1** 官方原版 client.js（138,937 B，SHA-256 `A60FD863…`）。与安装目录的 `client.js.dsh-bak` 逐字节一致 |
| `baseline/client.patched.js` | 应用补丁后的产物（154,284 B，SHA-256 `7D7D8494…`）。**黄金对照**：既是重建目标，也是下次升级后人工适配时的 diff 基准 |

> 两份 baseline 是第三方产物而非本项目源码，但它们是不可再生的重建依据
> （`vendor/` 不入库、安装目录会被升级覆盖），故随补丁规则一并版本化。
>
> **基线沿革**：`0.1.2-rc.1`（2026-09-08 入库，`7ACF9736…` / `18D114AC…`）
> → `0.1.5-rc.1`（2026-09-10 重打，`A60FD863…` / `E602C1F1…`）
> → `0.1.5-rc.1` + 连通性探测 v2（2026-09-19，规则升级，**官方原版未变**，产物 `C6C1DCBC…`
> ——**该产物语法非法，勿用**，仅作事故考古留档）
> → `0.1.5-rc.1` + v2.1 尾逗号修复（2026-09-19，**官方原版未变**，产物 `F1717A07…`）
> → `0.1.5-rc.1` + v3 模型页增强（2026-09-22，**官方原版未变**，13 条编辑，产物 `7D7D8494…`）。
> 旧基线见 git 历史。

## 用法

```powershell
cd dsh-miasaki-desktop/patches/dsh-client-ui-settings-models

node patch.mjs verify            # 离线自检：baseline 原始 → 重建 → 逐字节比对 + 语法闸门 + 常量自洽
node patch.mjs status            # 检查已安装 bundle 的补丁状态与语法状态
node patch.mjs apply             # 备份 + 应用（幂等：已打过则跳过；**打坏时拒绝静默跳过**）
node patch.mjs resync            # 由 backup 重打（apply 幂等跳过时的正确重打姿势）
node patch.mjs revert            # 从 .dsh-bak 还原
node patch.mjs rebuild           # 改过 EDITS 后：由 baseline 原始文件重建 golden 产物并打印新常量
node rebuild-baseline.mjs        # 升级后：用当前安装的官方原版重建 baseline（见下）

# 通用参数：--target <client.js 路径> 覆盖自动探测（默认探测 %APPDATA%\npm 全局安装）
```

> **改了 `EDITS` 之后的标准动作**：`node patch.mjs rebuild` → 把打印出的 `PATCHED_SHA256`
> 写回 `patch.mjs` → `node patch.mjs verify`（三行 PASS 才算数）→ `node patch.mjs resync`。
> `rebuild` 只写 `baseline/`、不改常量，与 `rebuild-baseline.mjs` 同一约定：改常量是有语义的决策。
>
> **`resync` 为何必要**：`apply` 对带补丁标记的文件是幂等跳过的，于是**规则修好后无法直接重打**
> ——必须先 `revert` 再 `apply`。这条操作坑在 2026-09-19 修语法错误时实打实踩到，故固化成命令。
> 它只接受 SHA 等于已知官方原版的 backup，否则拒绝（那种情况该走 `rebuild-baseline` 重新适配锚点）。

> **`rebuild-baseline.mjs` 的正确时机**：DSH 升级后、**尚未重打之前**。此时安装目录是
> 新的官方原版，脚本会用它重建两份 baseline。**对已打补丁的文件跑会被拒绝**
> （`applyPatch` 见到补丁标记即报错），这是刻意的保护。脚本不改 `patch.mjs` 的常量，
> 请按它打印的值手动同步 —— 改常量是有语义的决策。
>
> 本次（2026-09-10）以 `.dsh-bak` 反向自测：脚本打印的三个值与 `patch.mjs` 里已写入的
> 完全一致，`verify` 仍 PASS。

`verify` 是纯离线检查，不碰安装目录，已接入仓库级统一回归：

```powershell
node ..\..\..\scripts\verify-all.mjs desktop
```

## 补丁做了什么

13 条编辑，全部按「锚点唯一」定位（不唯一即报错，宁可失败也不瞎改）：

| # | 位置 | 内容 |
|---|---|---|
| 1 | 模块级（`textOf` 前） | `REASONING_LEVELS` / `reasoningChoice()` / `reasoningPatch()` / `reasoningInheritLabel()`（继承项带当前生效值）/ `testResultClass()` / `describeProbe()`（结果类别 → 本地化文案）/ `probeViaHost()`（调 host 探测路由，未就绪时返回 null） |
| 2 | `ModelListEditor` state 区 | `testing` / `testResults` 两个 useState |
| 3 | `askable` 前 | `testModel()`——**先** `probeViaHost`（真实可用性，六分类）；返回 null（插件未就绪）时**降级**为 `operations.discoverModels`（目录探测），并在文案尾附「探测服务未就绪」 |
| 4 | 删除模型行处 | `testing` / `testResults` 的行号重排（防幽灵按钮） |
| 5 | 高级编辑区（maxTokens 之后） | 思考强度 `<select>` + 测试按钮 + 结果文案 + **能力徽标**（视觉/推理）。**分两代变体**（`variants` + `probe`）：`0.1.5-rc.x` 直接插入内联 JSX（1 条子编辑）；`0.1.6-alpha.2` 起改为「Editor 渲染成 ReactNode → `reasoningRow` prop → ModelRow 摆位」（2 条子编辑，成对生效） |
| 6/7 | en / zh 字典 | 32 个词条（思考强度 / 继承提供方默认 / 未声明 / 不支持思考 / 测试连通性 / 测试中… / 测试全部 / 可达·已列出 / 可达·未列出 / 无 Key 引导两条 / 视觉 / 推理 + 13 条探测类别文案） |
| 8 | 缺 key 行小点 | tooltip 点名环境变量：`API 密钥缺失（OPENROUTER_API_KEY）` |
| 9 | 编辑卡片密钥区 | 未配置且未粘 key 时一行可操作提示（点名 ref + 后果） |
| 10 | `catalogProps` | `reasoningDefaultOf(id)` 解析器（按 id 查解析后命名空间值的同 id 条目） |
| 11 | state 区（锚 edit #2 产物） | `capabilities` Map / `testingAll` 态 |
| 12 | `askable` 前（锚 edit #3 之后） | 能力加载 effect（`POST /model-probe-api/capabilities`，404 静默）+ `testAllModels`（顺序跑全部行） |
| 13 | 模型列表头 | 「测试全部」按钮（获取可用模型右侧） |

语义：`inherit` = 不写字段、`disabled` = `reasoningEfforts: false`、其余 = `{off: null, [lvl]: lvl}`。
**「继承」的显示语义（v3）**：标签带当前生效值——按模型 id 在解析后的命名空间值里找同 id 条目，
取其声明的等级；解析不到显示「未声明」。绝不猜一个用户看不见的默认值。

**连通性结果语义（v2）**：host 返回稳定的 `kind`（不是句子），文案在客户端本地化，
两语言不会各说各话。类别：`ok`（附耗时）/ `unauthorized` / `model-missing` /
`quota` / `rate-limited` / `timeout` / `unreachable` / `bad-request` /
`server-error` / `unknown` / `unsupported` / `no-credential` / `no-endpoint` / `no-model`。
v1 的「原样回显错误串」已不再出现——那条路径只在降级时保留。

## 双代变体（edit #5 如何同时支持两个 DSH 版本）

`EDITS` 的项有两种形态：**单条**（`{ id, mode, anchor, lines }`，自身即一次编辑）与
**变体**（`{ id, variants: [{ probe, edits: [...] }] }`）。`probe` 是一行源码文本，trim 后全等且在
源文件里出现即选中该变体；**没有任何 probe 命中就报错** —— 「两个已知版本都不匹配」必须响亮失败，
因为静默跳过会让补丁「成功」而 UI 不在位，那要等用户打开设置页才发现。

edit #5（思考强度 + 测试按钮）是唯一用到变体的：

| 子编辑 | probe（选中条件） | 模式 | 插到哪里 |
|---|---|---|---|
| `reasoning-ui@inline-jsx` | `editCapacity(index, "maxTokens", event.target.value);` | `insertAfterOffset` | `ModelListEditor` 内联 JSX 的 children 数组，紧跟 maxTokens 输入框（锚点 +2 行的 `})]` 之后） |
| `reasoning-ui@model-row-prop` | `editCapacity(index, "maxTokens", text);` | `insertBefore` | Editor 的 `<ModelRow>` props：插一个 `reasoningRow`（已渲染好的 `Fragment`） |
| `reasoning-ui@model-row-slot` | 同上 | `replaceLine` | `ModelRow` 内部：把 `props.reasoningRow` 摆到容量字段 map 之后、`ModelInputTypes` 之前 |

**新版为什么跨组件传节点，而不是把状态搬进组件**：`testing` / `testResults` / `testModel` 以及
`patch`、`t`、`disabled`、`model`、`index` 全在 `ModelListEditor` 作用域里，而 `ModelRow` 是官方组件、
props 契约固定。所以让**闭包留在 Editor**，跨组件传递的是**已渲染好的 ReactNode** ——
`ModelRow` 只负责摆位置。另一处 `ModelRow` 调用点（`DeepSeekModelsEditor`）不传 `reasoningRow`，
值为 `undefined`，React 对 undefined 子节点不渲染任何东西，**安全且无需改动它**。

> **两条实测踩过的坑**（都撞在 `applyPatch` 出口的语法闸门上，值得记下）：
> ① **锚点不能选 `onFieldChange`** —— `ModelRow` 被**两个编辑器**共用，那个锚点在 bundle 里命中 2 次，
> 撞 `findUnique` 的唯一性要求；`inputLoading` 里的 `catalogProvider` 只有本编辑器有，实测唯一命中。
> ② **`}, field)), (0, react_jsx_runtime.jsx)(ModelInputTypes, {` 这一行插不进独立行** ——
> 它**行内**同时装着上一项的收尾（`.map(...)` 的 `)`）与下一项的开头：在它之前插入会落进
> `.map()` 的参数里，在它之后插入会落进 `ModelInputTypes` 的 props 里。改用 `replaceLine` 整行重写，
> 把节点放在两者之间。

**legacy 分支逐字节不变**：0.1.5 走的分支与改造前完全一致，两份 baseline 与三个常量都未动，
`verify` 仍报同一条 `F1717A07…`。因此这次改造**不影响当前运行环境**，只增加了一条未来路径。

## 产物不变量（四条，缺一不可）

`verify` 的 PASS 只说明这些不变量当前成立；任一条破了都必须先修再重打。

| # | 不变量 | 落地位置 | 不成立时 |
|---|---|---|---|
| 1 | 锚点唯一命中，`insertAfterOffset` 的期望行相符 | `findUnique` / `applyPatch` | 直接抛错，不瞎改 |
| 2 | 编辑规则的 `lines` 无稀疏空洞；`replaceLine`（字典展开）除末行外每行都有尾逗号 | `applyPatch` 入口守卫 | 当场报出「哪条编辑的第几行缺尾逗号」 |
| 3 | **产物是可解析的经典脚本** | `applyPatch` 出口 `assertParses`（`vm.Script`） | 语法闸门抛错；`status` 单独报「语法 非法」 |
| 4 | **变体探测命中**：至少要有一个 `probe` 在源文件里 trim 后整行全等 | `resolveEdits` | 抛出「没有任何变体的探测锚点命中」并列出试过的 probe —— **不静默跳过** |

### 为什么「逐字节一致」不够（2026-09-19 事故复盘）

出事那一版的 `verify` 只有「由 original 重建 == baseline 产物」这一条比对。它证明的是
**可复现**，不是**合法** —— 规则写错、产物跟着错、baseline 也跟着错，三者一致，PASS 照旧。
v2 的 locale 字典就漏了两个尾逗号（en / zh 各一处）：

```js
testReachableNotListed: "Reachable, but not listed in catalog"   // ← 缺逗号
testProbeOk: "Reachable",
```

产物于是在 `testProbeOk` 处报 `SyntaxError: Unexpected identifier`。而 client bundle 是
**多包合并**产物：一个包语法坏了会让整份 bundle 不注册，浏览器直接报
`failed to import loader entry <hash> (<name>): … loaded without registering`，
**页面上所有插件一起失效** —— 不是「少一个按钮」的量级。

现在闸门加在 `applyPatch` 出口，`verify` / `apply` / `rebuild` 三条路径自动继承，
没有第二条路能把非法产物写进安装目录。`status` 另把「语法状态」作为**独立于补丁状态的一维**
报出来：文件完全可以「打过了」却依然语法错误 —— 这次正是如此（状态 `patched`、
SHA 与常量一致、产物却是坏的）。`verify` 同时校验 `PATCHED_SHA256` 常量本身，
避免「改了 EDITS + 重生成 golden，却忘了同步常量」的静默漂移。

### 写编辑规则时最容易踩的两处

1. **发出的逗号写在字符串内部**：`'\t\t\tkey: "value",'` 里的逗号在**单引号之内**；
   行尾那个逗号只是数组元素分隔符。少写「内部那个」就产出缺分隔符的 JS ——
   两种写法在阅读工具里肉眼几乎相同，别靠看，靠语法闸门。
2. **`[a,,b]` 稀疏数组**：语法合法，但在 `lines` 里留 `undefined` 空洞，
   随后在几百行之外以 `Cannot read properties of undefined (reading 'trim')` 炸开。已在入口拦住。

## DSH 升级后怎么办

1. `node patch.mjs status` —— 若显示 `unknown`，说明安装的是新版本，补丁已被覆盖；
2. 用 `baseline/client.original.js` ↔ 新版 client.js 做 diff，核对 7 个锚点是否仍在
   （`patch.mjs` 会在锚点缺失或不唯一时明确报错，不会静默改错）；
3. 锚点漂移则更新 `EDITS` 与两份 baseline，再跑 `node patch.mjs verify` 自证；
4. `node patch.mjs apply` 重新应用，刷新页面生效。
   若它报「已应用但产物语法非法」，说明安装目录里躺着旧规则的坏产物 —— 用
   `node patch.mjs resync` 由 backup 重打。

> **实操记录（2026-09-10，0.1.2-rc.1 → 0.1.5-rc.1）**：7 个锚点在新版 client.js 中
> **全部唯一命中**（新版 138,937 B，比 0.1.2 多 1,236 B），`insertAfterOffset` 的期望值检查
> 也全部通过 —— 因此**未改动任何 EDITS**，只换了两份 baseline 并更新三个常量
> （`BASELINE_DSH_VERSION` / `ORIGINAL_SHA256` / `PATCHED_SHA256`）。
> 重建与重打各一次成功，`verify-all.mjs desktop` 4/4 通过。

> **实操记录（2026-09-21，前瞻适配 0.1.6-alpha.2）**：在 alpha.2 的真实 npm 产物上，
> 第 5 条编辑锚点**失效**（命中 0 次），其余 6 条**全部唯一命中**。按上文「双代变体」改造后，
> 两代产物上 `apply` 均成功（`0.1.5-rc.2` 与 `0.1.6-alpha.2`）。
> **本轮刻意不换 baseline** —— 当前运行环境仍是 0.1.5-rc.1，换掉会让补丁打不上当前环境；
> 变体机制的意义正是「先把未来的路铺好，而不动脚下」。
> **真正升到 0.1.6 时的动作**：`node rebuild-baseline.mjs` 重建两份 baseline → 同步三个常量 →
> `verify` → `apply`；**`EDITS` 无需再改**（变体已覆盖两代）。

> **事故记录（2026-09-19，v2 → v2.1）**：不是 DSH 升级，而是 v2 的编辑规则本身有缺陷。
> 现场表现是浏览器 `Failed to load plugins` + 整串 `@deepseek-ai/dsh-client-*` 及自研插件
> 全部 `loaded without registering`，控制台另有 `Unexpected identifier 'testProbeOk'`。
> 排查靠三条独立证据链对齐：① `status` 报「语法 非法（第 2923 行）」；
> ② 安装文件与 `baseline/client.patched.js` 的 SHA 均为 `C6C1DCBC…`（即线上跑的就是入库产物）；
> ③ `applyPatch(original)` 重建结果逐字节等于该产物 —— 反证「规则本身产出了坏 JS」，
> 而非文件被外部改坏。修法：补两个逗号 → `rebuild` → 同步常量 → `verify` 三行 PASS →
> `resync` 重打。全量复扫 15 个 client/host bundle（4 个本体补丁目标 + 10 个自研插件）语法，**0 例同类**。
> `verify-all.mjs desktop` **11/11**。

> 生效机制：`dsh-client-modules` 以 `/plugins/??<id>/client.js&rev=<hash>` 提供该文件，
> `client-hmr` 每 500ms stat 一次，命中变化即经 SSE 推 rebuilt 帧热更；
> 若 host 启动晚于补丁写入，则启动快照即补丁，无需热更。

## 边界（勿越线）

- 补丁只改 `dsh-client-ui-settings-models` 这一个包的 client 产物，**不动 DSH 源码、不动其他包**；
- 与本项目另一个本体补丁（[`../dsh-client-ui-conversation`](../dsh-client-ui-conversation/README.md)，
  会话头窄宽度溢出保护）同属「不修改 DSH 本体」原则的**例外**，代价同样明确（升级覆盖、需重打）；
- 两个补丁各自独立：各自的锚点、baseline、CLI 与 `verify` 互不依赖，升级后分别重打即可；
- **v2 起补丁会 `fetch('/model-probe-api/probe')`**（同源、只读语义：不改配置、不写文件）。
  该路由由 [`plugins/dsh-model-probe/`](../../plugins/dsh-model-probe/) 提供，是补丁的**可选**依赖——
  路由 404 时按钮自动降级回目录探测，因此插件未装/未重启不会让功能缺失。
  插件的凭据解析、脱敏与信任栅栏都在 host 侧，补丁本身不接触 API Key 的存储。
