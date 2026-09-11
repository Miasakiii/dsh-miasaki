# Miasaki Desktop — 变更日志

> 按时间倒序。历史排查细节与决策见 `ARCHITECTURE.md`;待办见 `TODO.md`。

## 2026-09-10(深夜,续三) · `cordis_inspect_query`(client) 永久挂起:根因查明 + 本体补丁(第五例)

依据:用户报告「`cordis_inspect_query` · client 这个工具好像总是卡住,看看什么原因」。

### 一、结论

不是「慢」,是**失败即永久挂起**:同一次会话里,查 client 平台不带 input 的目录查询**秒回**,
带 input 的精确查询**挂了 18.6 分钟**直到用户中断。三重原因叠加:

1. Host 侧 `CordisInspectRegistryService.resolveClientQuery` 只接受**成功**的页面应答——
   `if (!resolution.ok) return { accepted: false }` 把错误应答**静默丢弃**,既不 settle 也不清理
   pending;输出 schema 校验失败的 catch 分支同样丢弃。
2. 浏览器侧 `ClientCordisInspectRegistry.query()` 对一次广播**只回一次**,不重试,回执也无人检查——
   于是「客户端拒绝了这次查询」这个信息在链路上被彻底吞掉。
3. `cordis_inspect_query` 未声明 `timeoutMs`,而 `dsh-tool-call-timeout-policy` 对未声明者直接
   `return next()`——没有兜底 deadline。唯一结束路径只剩 `exec.signal` 被中断,也就是人来按 Esc。

触发条件已精确到可预测:客户端 Service 目录只有 8 个 key(`layout` `locale` `sessions` `slots`
`theme` `timer` `uiWorkspace` `workspaces`),查这 8 个以外的 key 会抛
`no catalogued Service named "X"` → 必挂。而 `conversation.*` 是 **Slot** 命名空间,与 Service key
形似,极易混淆——这就是「总是」踩到的原因。同一类错误在 **host 平台会立刻返回**,所以表象是
「host 好好的,client 总卡」。

### 二、实测(逐帧解压 127 个会话日志,13460 条工具结果)

`cordis_inspect_query` 共 163 次调用,其中 client 查询 96 次。key 存在则秒回
(`timer` 0s、`sessions` 1s、`Slots.listSubTree` 各种 root 0–4s),key 不存在则永久挂起:
`conversation` 挂 **1116 秒**、`sessionLogDownload` 挂 **13420 / 3325 / 572 / 407 秒**——
共 7 次真挂死,最长 **3 小时 43 分**,全部以 `Client inspect query … was cancelled` 收场。

> 取证方法备记:DSH 会话日志是 append-only 的**多帧 zstd**,Node 的解压 API 只返回第一帧;
> 需扫描帧魔数 `28 B5 2F FD` 逐帧解压。另:`tool/result` 事件的 callId 在
> `data.message.source.callId`,不在 `data.callId`。

### 三、修复:新增第五个本体补丁

| 补丁 | 目标包 | 改动 |
|---|---|---|
| [`patches/dsh-cordis-host-runner/`](../patches/dsh-cordis-host-runner/README.md) | 官方 host 侧 Cordis runner(`lib/index.js`) | 4 条锚点编辑:失败应答记入 `pending.lastFailure`(仍不 settle,保住多标签页抢答语义)+ 每次查询挂 15s 兜底定时器,到期结算为**带真实拒绝原因**的 `timeout` 错误 + `finally` 清理定时器 |

**不采用「第一个失败就 settle」**:多标签页会同时收到广播,某页没有该 provider 不代表别页也没有,
先到先得只对**成功**应答成立。失败仍不抢答、只记录,由超时兜底收场——「永久挂起」退化为
「15 秒后带准确原因的报错」,多页面语义原样保留。

**本补丁与其他四个的差别**:它改的是 **host 侧 Node 包**(其余四个是浏览器 bundle),
因此**生效必须重启 DSH host 进程**,刷新页面不够。

### 四、自证与验收

`verify` 四项全绿(比 CSS 类补丁多两道,因为注入的是代码):baseline 重建后 SHA 比对 +
重建产物 `node --check` + **拒绝应答行为断言**(把重建产物里真实的 `resolveClientQuery` 抠出来用
最小假 registry 跑,并对 baseline 原版跑反例以证明断言有区分力)+ **超时兜底行为断言**
(注入假 `setTimeout` 手动触发,不真等 15 秒)。已接入 `verify-all.mjs desktop`
(desktop 由 7 项增至 **8 项**,全 PASS)。安装目录已 apply:`58EF79A0…` → `8B81500A…`,
留有 `index.js.dsh-bak` 备份可回退。

用户需执行:**重启 DSH host 进程**(Node 已加载模块不会热更新;重启前查询仍会挂起)→ 复现原用例
(`client/Service/listService` + 不存在的 key,如 `conversation`),预期 **15 秒内**返回
`Error: … timed out after 15000ms … (the client refused it: no catalogued Service named "conversation")`。

### 五、触摸点

`patches/dsh-cordis-host-runner/`(新增 patch.mjs / rebuild-baseline.mjs / README.md /
baseline/index.original.js)、`scripts/verify-all.mjs`(desktop +1 项)、`README.md`
(补丁表「四处」→「五处」+ host/client 生效方式差异说明)、本文件。

## 2026-09-10(深夜,续二) · 轨迹页「首 token 时间不可用」:根因查明 + 两个本体补丁(轨迹/聊天)

依据:用户贴出轨迹页计时面板截图,三行值全是「首 token 时间不可用」,问「轨迹里计时不可用
是怎么回事」。

### 一、结论(先排除环境因素)

三行不是三个故障 —— `ttft()` / `generationTime()` / `throughput()` 共用同一个前置条件
`firstTokenTime`,三行同句只可能是这一个字段为 null(反证:`stepStartTime` 或用量若缺,
它们会先报各自那句)。根因在官方客户端:`firstTokenTime` **只在实时流式 chunk**
(`assistant/live-chunk`)折叠时写入,而该事件是浏览器端 session controller 合成的 transient
事件、**从不落盘**;窗口重建(刷新 / 重开会话 / 切走再切回)后,已结束的步骤只剩 durable
事件,而 `settleMessage()` 不恢复这个字段 → 永久 null。

### 二、实测(数据一直都在)

逐帧解压本会话日志:155 条事件里 `assistant/live-chunk` = **0 条**;23 条 `assistant/message`
每条都带紧凑流 `data.stream`,用官方 `assistantStreamFirstTokenTime` 逐步算得出首 token 时间
(1/1 = 6.70s,其余 0.69–1.49s,均值约 1.1s)。官方 host 侧统计投影 `dsh-session-stats` 走的
正是这条路 —— 所以「统计」对话框里的平均 TTFT 一直正常,只有轨迹/气泡面板没做恢复。

### 三、修复:新增两个本体补丁(本体例外第三、四例)

| 补丁 | 目标包 | 改动 |
|---|---|---|
| [`patches/dsh-client-ui-trajectory/`](../patches/dsh-client-ui-trajectory/README.md) | 官方轨迹页 | 注入 `dshPatchedFirstTokenTime` + timing 回退 → 三行计时恢复 |
| [`patches/dsh-client-ui-chat/`](../patches/dsh-client-ui-chat/README.md) | 官方聊天区 | 同一注入与回退 → 消息气泡 TTFT 与窗口口径兜底统计恢复 |

各 2 条锚点编辑;实时值优先(流式过程行为不变);紧凑流里确实没有 token 时仍返回 null ——
**不编造数字**。

### 四、自证与验收

`verify` 三层(比既有两个补丁多两道,因为注入的是代码而非 CSS):baseline 重建后 SHA 比对 +
**从重建产物里抠出注入函数跑 8 条 fixture 行为断言** + 重建产物 `node --check`。已接入
`verify-all.mjs desktop`(desktop 由 4 项增至 6 项)。安装目录已 apply:轨迹
`73A878B4…` → `C3485ADF…`、chat `4F9CFFF8…` → `BE4C68D5…`,各自留有 `.dsh-bak` 备份可回退。

用户需执行:刷新 DSH Web 页面 → 打开任一**已结束**步骤的计时面板(首 token 延迟 / 生成 /
吞吐量应为数字)→ 悬停消息耗时面板(应出现「首 token 用时(TTFT)」,与轨迹页同一步一致)。

### 五、触摸点

`patches/dsh-client-ui-trajectory/`(新增 patch.mjs / rebuild-baseline.mjs / README.md /
baseline/client.original.js)、`patches/dsh-client-ui-chat/`(同 4 文件)、`scripts/verify-all.mjs`
(desktop +2 项)、`README.md`(补丁表「两处」→「四处」+ 基线与流程说明)、
`design/trajectory-ttft-restore.md`(新增:归因链、方案对比、自证设计)、本文件。

## 2026-09-10(深夜,续) · 展开右栏时让位安全区白空 144px

依据:用户指出「左边的外部按钮和三点扩展按钮位置离展开的右侧边栏太远」。像素实测:展开态
会话头最右控件 `⋯` 的右边界 x=**89**、右栏分栏线 x=**233** —— 中间**空 144px**,正是
2026-09-10(晚) 那条让位规则 `padding-right:var(--ms-titlebar-reserve)`(128px) 加上官方
header 自带 `padding-right:28px` 的残留。

### 一、根因(让位无条件生效,而展开态并不需要)

让位是给**桌面壳窗控**留安全区:收起态中栏延伸到窗口右缘,窗控(占距右缘 [8,116]px)会压住
会话头右端的展开按钮。但**推挤展开时**中栏右边界已退到分栏线内、窗控压的是**右栏**头部,
会话头不该再留那 128px。

判据是关键:**官方右栏 panel 用 `transform:translate(100%)` 移出屏幕、并未卸载** —— 所以
不能用"元素是否存在"判断开合;`data-sidebar-right-open`(与 `data-sidebar-right-panel="push"`
挂在**同一元素**、条件挂载)才是可靠信号。

### 二、修复(第一次尝试失效,第二次才对)

❌ **门控方案(失效)** —— 给让位规则加
`:not(:has([data-sidebar-right-panel="push"][data-sidebar-right-open]))` 门控,指望
"展开态不覆盖 → 官方 28px 自然生效"。**实测无效**:用户回报「还是这样」,像素复测空隙仍是
**144px**(`⋯` 右边界 105、分栏线 249)。原因:注入脚本是 `include_str!` **编译期内嵌**,
**已经发布出去的壳二进制里那份无条件 128px 规则仍在页面上生效**;门控版在展开态"不匹配",
等于**没人去覆盖它**。

✅ **覆写方案(有效)** —— 主动写一条**特异性更高**的规则撤回让位:

    #root:has([data-sidebar-right-panel="push"][data-sidebar-right-open])
      header:has([data-conversation-header-corner]){padding-right:28px}

`#root:has([a][b]) header:has([c])` = (1,3,1) > 原规则 (1,1,1)。28px 即官方 header 的
padding-right(`.wSkVaW_header{padding:10px 28px 0 20px}`),官方若改需同步。canvas 线在
页面级注入里放了**逐字同一条**(热更,刷新即生效),测试用同一条正则同时断言两处。

> **教训**:撤销一条已经"发布"出去的 CSS 规则,**不能靠改原规则** —— 宿主的注入产物可能是
> 编译期内嵌的,运行中那份不会跟着源文件变。要么覆写(特异性取胜),要么请用户重建宿主。
> 这条同样写进了 canvas 线的 CHANGELOG。

### 三、已知限制

浮窗模式(`data-sidebar-right-float-host`)下 panel 仍带 `push`+`open`,会被判为"已展开"而
撤销让位 —— 浮窗不占布局、中栏满宽,严格说仍应让位。浮窗是低频用法,留待需要时补
float-host 判据。

### 四、触摸点

`themes/src/03-switcher.js`(本线)、`src-tauri/injected/theme-init.js`(重建产物)、
canvas 线 `client.js` + `test/header-adaptive.test.js`、本文件。

## 2026-09-10(深夜) · 会话头控件与窗控不在同一水平线(4px 偏差)

依据:用户两张截图 +「展开右侧边栏是对齐的,收起时不在同一水平线」。对两张 PNG 逐控件做
像素切分(连通列分组 + y 范围)量出垂直中心:

| 状态 | 会话头侧控件 | 窗控组 |
|---|---|---|
| 收起(图一) | open-in-app 胶囊 cy=**21.5** / 日志菜单 **22.0** / 右栏展开钮 **22.0** | 徽章 **17.5** / 最小化 **18.0** / 最大化 **18.0** / 关闭 **18.0** |
| 展开(图二) | 全屏 **20.0** / 收起 **20.0** | 徽章 **19.5** / 三键 **20.0** |

即**展开态全部落在 19.5~20.0(齐),收起态分成 22 与 18 两组,相差 4px** —— 用户描述得到量化证实。

### 一、根因(两段:3px + 1px)

1. **3px 来自 titleRow 被撑高**:canvas 线的「对话/会话布」切换器 = `padding:3px×2 +
   border:1px×2 + 按钮 28px` = **36px**,而官方 `titleRow` 的 `min-height` 只有 30px ——
   被撑到 36px 后,行内**所有**控件(含官方的 open-in-app、日志菜单、右栏展开按钮)居中下移
   (36−28)/2 = 4px;窗控是 `position:fixed`,不跟着动,于是分成两组。这一截由 canvas 线
   收敛(总高 36 → 30px),本项目内不重复实现。
2. **1px 是官方两处的固有差**:会话头 `padding-top:10px + min-height:30px`、28px 控件居中
   ⇒ 中心 **25px**;而 dockkit strip(10px + 28px)与窗控组(`top:11px` + 26px)都是 **24px**。
   展开态因为会话头侧没有可比控件(该行只有右栏自己的 chrome)而看不出来。

### 二、修复(本线一处)

`themes/src/03-switcher.js` 常驻 CSS 增一条,把会话头三个容器整体上移 1px:

    #root [class*="_headerActions"],#root [class*="_headerUtilities"],
    #root [class*="_headerCorner"]{position:relative;top:-1px;}

选择器用 `[class*="_xxx"]` 子串锚点(hash 前缀随版本变,后缀稳定),与本线已有的
`[class*="sessionLogButton"]` 同一套稳健做法。**只位移不改布局**:`top:-1px` 不参与 flex
计算,控件仍在 header 的 padding 内,不会被裁。

### 三、验收

- canvas 侧:`node --check client.js` 通过,全量单测 **84 项全绿**(含新增的高度契约 1 项);
- 本线:`build-init.mjs` 重建注入产物(68 KB,令牌校验通过);
- `verify-all.mjs canvas desktop` **10/10 + 5/5**;
- **用户待执行**:重启 `dsh web`(canvas 侧的 client bundle)+ 重启桌面壳(主题注入生效)。
- **复验点**:收起态下 `⋯`、右栏展开钮与窗控三键落在同一水平线(预期全部 cy≈24)。

### 四、触摸点

`themes/src/03-switcher.js`、`src-tauri/injected/theme-init.js`(重建产物)、本文件。

### 五、生效链路(本次踩到的坑,后续改动同理)

> 附:那条 1px 基线补偿**已经生效** —— 走的是 canvas 的页面级注入(热更通道),用户刷新页面后
> 实测左 `[📁⌄]` cy=21.5 / `⋯` 22.0、右 `⊙` 21.5 / `[ ]`·`□|` 22.0 / 窗控 22.0,全部落在
> 21.5~22.0。本文件里的同源规则等下次重建壳时自然一致。

`src-tauri/src/main.rs` 用 `include_str!("../injected/theme-init.js")` 把注入脚本**编译期内嵌**
进 EXE —— 所以改 `themes/src/*` 并跑过 `build-init.mjs` 之后,**还必须重新构建壳再启动**,
否则新规则只躺在源文件里。本次实测证据:壳(pid 26840,`dist/Miasaki.exe`)启动于 21:01、
注入产物重建于 21:41、release 二进制却是 19:17 构建的 —— 用户随后量到的仍是未补偿的 1px,
即"规则没进二进制"的直接证据。

> 这条链路对 1px 级别的调整代价过高,而"会话头控件与右栏 dockkit chrome 差 1px"在**纯浏览器**
> 下同样存在(右侧没有窗控做参照也一样差)。因此 canvas 线已在**页面级注入**里加了同源规则
> (支持 client-hmr,刷新即生效)。**两处值必须一致** —— canvas 的
> `test/header-adaptive.test.js` 会同时断言本文件里的 `top:-1px` 仍在,防止只改一处。
> 本文件里的那条**保留**:它是"桌面壳让位"系列的正式归属,不依赖 canvas 插件是否加载。

## 2026-09-10(晚,续) · 会话头窄宽度溢出保护:第二个本体补丁

依据:用户报告「展开右侧边栏会挤压」+ 截图 —— 会话头里 canvas 的「对话/会话布」切换器被
右侧图标按钮压住、会话标题消失。归因与方案见 canvas 线
`design/2026-09-10-conversation-header-crowding-fix.md`。

### 一、根因(官方会话头缺溢出保护)

官方把会话头一行分成:titleCluster(`flex:1; min-width:0`,可被一路压到 0)、
headerUtilities / headerCorner(均 `flex:none`,不收缩),而 titleCluster 内部的
`headerActions` 同样是 `flex:none`。中栏被右栏推窄到「固定项之和」以下时,titleCluster
被压到 0,其内部 flex:none 的 actions 无处安放 → **溢出**,并与同样从 x≈0 起画的
utilities 重叠(DOM 靠后者在上层);标题被 `crumbs` 的 `overflow:hidden` 先裁没,是同一
机制的自证。固定项合计 ≈411px(内边距 48 + 创造模式 95 + 后台任务 32 + canvas 切换器 116
+ gap 16 + utilities 84 + corner 20)⇒ 中栏窄于 ≈410px 必然重叠。现场佐证:用户拉宽
窗口后重叠消失、标题回归。

### 二、修复:新增 `patches/dsh-client-ui-conversation/`(本体例外第二例)

一条 CSS 片段替换(锚点唯一,不唯一即报错,宁可失败不瞎改):

    -.wSkVaW_headerActions{flex:none;align-items:center;gap:8px;display:flex}
    +.wSkVaW_headerActions{flex:0 1 auto;min-width:0;align-items:center;gap:8px;display:flex;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
    +.wSkVaW_headerActions::-webkit-scrollbar{display:none}

溢出从「压叠」退化为「可横向滚动」,控件始终可达。补丁规则 + baseline(官方原版 647,101 B,
SHA `81314DFD…`)+ CLI(verify/status/apply/revert)+ `rebuild-baseline.mjs` 一并入库。

> 与 settings-models 补丁的差别:**不存 patched 全文**(目标 632KB,再存一份不划算),
> 产物以 `PATCHED_SHA256`(`D9A841DE…`)记录,verify 用「重建后 SHA 是否等于该常量」自证
> —— SHA 相等即逐字节相等,锚点失配时仍会响亮报错。
>
> 代价:DSH 升级覆盖该包后需 `rebuild-baseline.mjs` 重建基线并重打(流程见补丁 README)。

### 三、配套(canvas 线,同日)

canvas 的 `ViewSwitch` 增加运行时自适应:`ResizeObserver` 观察 `closest('header')`
(不能观察自身 —— 自身是 `flex:none`,被挤压时宽度不变,观察自身检测不到溢出),留给标题的
余量不足时收成图标形态(≈116 → ≈64px),进入 120 / 退出 200 的滞回避免抖动,图标形态下
`aria-label` / `title` 保留可访问名;新增 `test/header-adaptive.test.js` 4 项。
**canvas 侧保住可用性,本补丁保证任何插件 / 任何窄窗口都不再压叠**,两者独立、任一单独生效
都有明显改善。

### 四、验收

- `node patch.mjs verify` PASS(1 条编辑,产物 SHA 与记录一致);
- `node patch.mjs apply` 成功(647,226 B,安装目录已 `patched`,备份 `client.js.dsh-bak` 已建);
- `verify-all.mjs desktop` **5/5 通过**(新增该项离线自证);canvas 全量单测 83/83。
- **用户待执行**:刷新页面即生效(host 启动早于本次写入,`client-hmr` 会热推 rebuilt 帧);
  canvas 侧的自适应需重启 `dsh web`(client bundle 在启动时载入内存)。

### 五、触摸点

`patches/dsh-client-ui-conversation/{patch.mjs,rebuild-baseline.mjs,README.md,baseline/client.original.js}`(新)、
`README.md`(补丁章节由「唯一一处」改「两处」+ 对照表)、
`patches/dsh-client-ui-settings-models/README.md`(「唯一例外」表述改为并列)、
`scripts/verify-all.mjs`(desktop 增第 5 项)、本文件。

## 2026-09-10(晚) · 窗控 × 官方右栏:右上角安全区让位(V4 让位规则重写)

依据:用户升级到 DSH 0.1.5-rc.1 后的两张截图 —— 折叠态下官方「打开右侧边栏」按钮被窗控
徽章压住,展开态下官方面板的「全屏/收起」两键与窗控的最小化/最大化/关闭几乎完全重合,
即「窗控与新右侧边栏的关闭与展开都不适配」。

### 一、根因(两处让位全部失效,且是两条独立的失效路径)

DSH 0.1.5 的官方右栏(`ui-sidebar-right`)把两个控件放在了桌面壳窗控的必经之路上。窗控裸键
组实测宽 = 徽章(16+4×2) + 三键(26×3) + gap(2×3) = **108px**,加 `right:8px` 后恒占
**距窗口右缘 [8,116]px** 这一带;而 v4 时代留下的让位规则
`#root header:has([role="tablist"]){padding-right:118px}` 同时踩了两个坑:

| # | 位置 | 官方几何 | 与窗控的实际交叠 |
|---|---|---|---|
| ① | 折叠态:`conversation.session.header.corner` 的 ExpandButton(`data-sidebar-right-expand`) | 官方给 corner 挂 `margin-right:-16px`,118px 让位实际只让出 **102px** | **14px 硬叠压**;更糟的是 `[role="tablist"]` 那一行官方只在 view tab 数 >1 时渲染(`tabs.length>1`),单 tab 会话下**整条规则静默失效**,corner 回到距右缘 12px → 叠压 32px |
| ② | 展开态:dockkit strip 末端的 PanelChrome(`data-dockkit-strip-chrome`:全屏 + 收起) | 该 strip 官方只有 `padding-right:6px`,两个 28px 按钮占距右缘 **[6,70]px** | 与窗控 close[8,34] / max[36,62] **几乎完全重合** —— 旧规则压根不覆盖这一处 |

叠加顺序上窗控 `z-index:100000` 远高于官方 UI,因此表现是「官方按钮被盖住、双方都难点」。

### 二、修复(`themes/src/03-switcher.js` 常驻 CSS)

1. **让位锚点换成恒存属性**(不再依赖 `role=tablist`):
   - `#root header:has([data-conversation-header-corner]){padding-right:var(--ms-titlebar-reserve)}`
     —— corner 容器在任意活跃会话下都恒在 DOM(`:empty` 时仅 `display:none`),选择器不再随 tab 数抖动;
   - `#root [data-conversation-header-corner]{margin-right:0}` —— 抵消官方的 -16px 负边距,否则
     按钮会反向探入安全区 16px;
   - `#root [data-sidebar-right-panel] [data-dockkit-strip-chrome]{margin-right:calc(var(--ms-titlebar-reserve) - 6px)}`
     —— 直接作用在 chrome 容器上。dockkit 只在 `chromePaneId`(分栏时的**最右一格**)渲染该容器
     (`data-dockkit-strip-chrome` 为恒存属性),因此分栏左格天然不受影响;`-6px` 是补掉 strip 自带的
     `padding-right`,使 ② 与 ① 落在同一条安全线上。浮窗(`[data-sidebar-right-float-host]`)不在
     `[data-sidebar-right-panel]` 内,不受此规则影响。
2. **安全区变量化**:`:root{--ms-titlebar-reserve:128px}`(= 窗控组 116px + 12px 呼吸位)。
   变量名与 sidebar 线 `design/2026-09-09-sidebar-launcher-design.md` §5 的规划一致 —— 该线若将来
   用 `measureChromeReserve()` 量测 `.tb-group` 宽度写 `documentElement.style`,inline 变量会**自动
   覆盖**这里的默认值,两侧无需再改选择器。
3. **垂直对齐(优化项)**:`.tb-group` 的 `top:5px` → `top:11px`。官方视图控件的垂直中心落在
   24~25px(会话头 titleRow = header `padding-top:10px` + 30px 行高内居中;dockkit strip =
   `padding-top:10px` + 28px 高),旧值让窗控中心停在 18px,比官方低 6~7px;改后中心 24px 与之齐平。

选择器一律带 `#root` 提权:官方 CSS Module 是运行时插到 head 末尾的,注入时机晚于我们,
同特异性会被反超。

### 三、验证(`npm run verify`,无头 Edge + 真实 DSH 页面,视口 1280)

`scripts/verify-themes.mjs` 新增第 6 节「右上角安全区」,在真实页面上量矩形(该脚本会把完整
注入层 `Page.addScriptToEvaluateOnNewDocument`,因此页面上同时存在窗控按钮组与官方右栏):

| 断言 | 实测 |
|---|---|
| 安全区变量覆盖窗控组 | `--ms-titlebar-reserve=128px`,窗控组宽 108px |
| 折叠态:窗控组 × 「打开右侧边栏」 | overlap **0px²** —— 窗控[1140..1248] / 官方[1100..1128],间隔 12px |
| 展开态:窗控组 × 面板 chrome | overlap **0px²** —— chrome[1064..1128] |
| 展开态:窗控组 × 「收起」/「全屏」 | 各 **0px²**,收起键[1100..1128] / 全屏键[1064..1092] |
| 与官方控件同一水平线 | 中心差 **Δ=0px** |

同轮 22/24 项通过;两项 FAIL(`pure: html[data-miasaki-theme]` 得到 `zafkiel`、`pure: 无水印`)
是 `.edge-test-profile` 里 localStorage 的**上次运行残留**(第 4/5 节持久化断言本轮 PASS),
与本轮改动无关 —— 需要干净基线时删掉该 profile 目录重跑即可(需重新登录 DSH)。

### 四、变更文件

| 文件 | 改动 |
|---|---|
| `themes/src/03-switcher.js` | 让位规则重写 + `--ms-titlebar-reserve` + `.tb-group` top 11px |
| `scripts/verify-themes.mjs` | 新增第 6 节安全区断言;`--window-size=1280,860`(让视口贴近桌面壳) |
| `src-tauri/injected/theme-init.js` | `npm run gen-init` 重新生成(构建产物,不入库) |

**待用户执行**:`cd dsh-miasaki-desktop && npm run gen-init && npm run tauri dev`(或重打 release)
后重启桌面壳;人工目检项:三主题下右上角无叠压、窗控与官方展开/收起键同高。

## 2026-09-10(深夜) · token-monitor v0.5.1:span 快照重复回写修复 + 分布显示优化

依据:v0.5.0 重启后用户实测截图(主问题已解决 —— 会话列全是可读中文标题),
反馈「优化显示」;同时本轮排查发现账本长期膨胀。

### 一、span 快照重复回写(账本 19% 是纯冗余)

**根因**:`loadLedger()` 载入 `type:'span'` 行时经 `touchSpan` 把这些键**重新标脏**,
而 `process.on('exit')` 的 `flushLedger(true)` 是**强制写**(刻意绕过节流判断),
于是每次 host 正常退出都把全部存量快照重写一遍。

**对照实测**(真实退出路径 `process.exit` → exit 钩子;合成账本含 45 个 span 存量):

| 版本 | 退出前 | 退出后 | 增量 |
|---|---|---|---|
| 未修复 | 46 行 | 92 行 | **+46**(45 行存量重复 + 1 行真实推进) |
| 已修复 | 46 行 | 47 行 | **+1**(仅本次真实推进的那个会话) |

**影响面(本机真实账本)**:4884 行中 span 行 998、去重后仅 51 个唯一
`(date|sessionId)` —— **947 行为纯冗余(19%)**,单键最多重复 82 次(≈ 重启 82 回)。
幂等快照不改统计结果(载入即 min/max 合并),但文件不可逆地膨胀。

**修复**:`touchSpan(date, sessionId, ts, dirty)` 增 `dirty` 形参,载入路径传 `false`
(存量已在磁盘上,不再标脏);本次真实推进的会话**照常**在退出时落盘(实测 +1 行,功能未削弱)。

**存量清理**:新增 `plugins/dsh-token-monitor/scripts/dedupe-usage-ledger.mjs`
(默认预演,`--apply` 才写,`--file` 可指定),按 `(date, sessionId)` **无损合并**为一行
(取 min first / max last,与载入语义完全一致),写盘前做**语义等价校验**
(用量聚合 + span 合并摘要比对),不一致直接拒绝写入;执行前自动备份 `.bak-<时间戳>`。
实测:4884 → 3937 行、1.13 MB → 983 KB(**省 148 KB**),语义校验一致。

### 二、分布显示优化(用户截图反馈)

| 截图里的问题 | 改法 | 依据 |
|---|---|---|
| 条带渲染成"一整条灰带 + 右侧一个深块" | 改**底部对齐的迷你柱**:空日只留 3px 基线、有量给 5–18px 高柱(高度 + 透明度双编码) | 实测按会话维度填充率仅 4%,等高画法必然满屏灰且看不出趋势 |
| `近 7 日` 挂在「使用分布」区头部 | **口径错位** —— 它只作用于模型环形图,会话分布固定近 30 日;移到模型卡标题旁 | `models` 由 `trend.slice(-range)` 得出,列表则固定 30 日 |
| `298 轮消息` 占宽 | 压成 `298 轮`;占比列 120 → 96px、数值列 78 → 84px,宽度让给条带 | — |
| 10 行两行式文本连排容易串行 | 行间加极细分隔线(`.tokmn-sess-row + .tokmn-sess-row`) | 对齐参考图的行间细线 |
| 默认 Top 10 却要滚动才看全 | 列表限高 376 → **420px**,默认档恰好一屏放满 | 行高约 42px × 10 |

**形态实测**(真实账本 + ASCII 化,`·` = 空日基线):

```
会话维度   97768382   7%  ························▆█····
目录维度   552890592  20%  ························▅▄▃▄▃█   ← 同项目多会话叠加后成形
```

### 三、二轮回修(交付后第二轮用户截图)

用户刷新后再截图,暴露四处**布局溢出** —— 其中第一处是本轮改动**引入的回归**,
另三处是既有问题(超长模型名 + 缺收缩约束):

| 现象 | 根因 | 修法 |
|---|---|---|
| 模型列表的百分比跑到卡片外、叠到右列卡片上 | 上一轮把 `.tokmn-dist` 左列收窄成 `minmax(300px, 380px)`;`.tokmn-donut` 的 `1fr` 与 `.tokmn-dist` 两列都受 grid 项默认 `min-width: auto` 约束 → 列被撑到 min-content,`.tokmn-pct` 的 `margin-left: auto` 被推出卡片 | 三处 `minmax(0, …)`(`.tokmn-dist` 两列 + `.tokmn-donut` 列表列)+ `.tokmn-pct { flex: none }`;左列改比例 `minmax(0,1fr) minmax(0,1.15fr)`,不再定宽挤压 |
| 趋势图悬浮提示被面板右边界裁掉、数字看不见 | `.tokmn-tip { white-space: nowrap }` 遇超长模型名(`deepseek-v4.1-flash-expires-on-0910`)把提示框撑宽,而定位仍按硬编码 `chartWpx - 190` 留位 | 提示框 `max-width: 340px; overflow: hidden`;模型名走 `.tokmn-tip-name`(flex + ellipsis)、数值 `.tokmn-tip-val { flex: none }`;定位改按实际上限留位(`- 366`);热力图 tooltip 的硬编码 `cr.width - 170` 同步改 `- 366` |
| 悬浮提示列出 8 个模型、其中 7 个当日为 0 | `hoverRows` 对 `visibleModels` 只做 map + sort,未过滤 | 加 `.filter((r) => r.v > 0)` —— hover 明细回答的是"这天用了什么" |
| 卡头 meta「近 30 日 · 共 3 个工作目录」被卡片边界裁掉 | 标题区 div 是 flex item 却缺 `min-width: 0`,不可收缩 | 新增 `.tokmn-sess-head-l`(flex + `min-width: 0`):标题 `flex: none`、meta `flex: 0 1 auto` + ellipsis |

**验证边界(如实记录)**:JS 侧(过滤逻辑、类名、定位数值)已静态复核 + 语法检查通过;
**CSS 布局效果无法在本机自动验证**(浏览器工具屏蔽本地地址),需刷新页面目检 ——
四处都属"约束缺失"类问题,修法是 CSS 布局的确定性规则(`minmax(0,…)` 允许收缩、
`flex: none` 防压缩),但视觉效果以实际渲染为准。

**同批(用户点名)**:「模型用量」的悬浮信息补全。`models` 此前只有 `label`(显示名,同名
跨供应商时带 provider 前缀)与 `provider`,列表 hover 给的是 `title: m.provider` —— 悬浮
只看到供应商名,而窄列**必然**把模型名截断(`deepseek-v4.1-flash-exp…`),等于没给。补
`model: nm` 字段后,三处 hover 统一改为给出完整模型名:

| 位置 | 改动 |
|---|---|
| 模型列表名称 | `title: m.model + " · " + m.provider`(原为只给 `m.provider`) |
| 趋势图图例 chip | 同上 + `" · 点击显示/隐藏"` |
| 环形图扇区 | **新增** SVG 原生 `<title>`:`模型名 · 用量 · 占比` —— 扇区此前 hover 不出任何信息(只有颜色,无图例对应关系) |

### 四、用户需执行

`lib/client.js`、`lib/index.js`、`package.json` 覆盖为仓库最新 → **刷新页面**
(client 半按请求读盘);界面未变再重启 host。本次未改协议,`usage-log.jsonl`
与 `config.json` 格式不变(清理只删重复行,未动任何用量行)。

## 2026-09-10(深夜·续) · hash 同步通道节流:33ms → 基准 150ms + 自适应退避

依据:本轮对 09-01 → 09-04 改动的审查。**未在该区间找到直接致命改动**,但发现一条**长期存在**
的结构性风险链路,本次予以削弱。

### 一、审查结论(09-01 → 09-04 逐项核查)

| 改动 | 结论 |
|---|---|
| `pet_native.rs` 1433 行 → 拆 6 模块 | 纯重构;`Arc<Mutex<PetShared>>` 语义与锁范围未变 |
| 注入层 `themes/runtime.js` → 拆 9 文件 | 纯重构;**定时器周期完全一致**(旧版亦为 `PET_TIER_MS = 1500`,1s 自愈巡检同样存在) |
| `main.rs` +57 行 Fleet 脉冲看门狗 | **从未启动** —— `MIASAKI_FLEET_PULSE` 未设,函数首行即 `return`;pet.log 无任何 `[pulse]` 行 |
| GDI 兜底(ULW 失败计数 / 表面重建) | **从未触发** —— pet.log 中 `ULW failed` 计数为 0 |

→ 区间内无「冒烟的枪」;**嫌疑未能在该区间收口**。

### 二、发现的结构性风险(非 9/4 引入)

`start_hash_watchdog` 每 **33ms** 调用一次 `wv.url()`。在 Tauri 2.11.5 中该路径为:
tokio 线程 → `run_on_main_thread` → **无超时阻塞等待**(`rx.recv()`)→ 主线程执行 WebView2
`ICoreWebView2::get_Source()` **同步 COM 调用**。而注入层每 **1.5s** 才 `replaceState` 一次
—— **45 倍冗余轮询**。一旦渲染侧无响应,这条 30 次/秒的同步链路会把「局部卡顿」放大为
「整个 UI 冻结」(黑屏 + 托盘无响应 + 关闭失效,与四次挂起现象吻合)。

**推理修正**:pet.log 停写**不等同于** tokio 线程卡住 —— 更可能是渲染进程先停摆,注入层
`setInterval` 不再执行、hash 不再变化,于是 watchdog 每轮走 `continue`(该分支不写日志)。
即:**渲染侧压力是因,33ms 同步轮询是放大器。**

### 三、改动(`src-tauri/src/main.rs`,一处函数 + 一处拖窗分支)

- 新增常量:`HASH_POLL_MS = 150` / `HASH_POLL_FAST_MS = 33` / `HASH_SLOW_MS = 250` /
  `HASH_BACKOFF_MS = 1000` / `HASH_BACKOFF_HOLD_MS = 3000` / `HASH_DRAG_HOLD_MS = 400`。
- 轮询间隔由固定 33ms 改为**三档决策**(优先级:退避 > 拖窗提速 > 基准):
  ①**基准 150ms**;②**拖窗期间保持 33ms**(`move=` 出现即置 `drag_until`,松开 400ms 后回落
  —— **不牺牲拖动跟手**);③单次 `url()` 耗时 ≥250ms,或连续失败 ≥3 次 → **退避 3s 内用 1000ms**。
- 新增诊断日志(便于下次挂起时判读):`hash poll slow {n}ms → backoff 3000ms`(前 5 次 +
  每 50 次)、`hash poll url() failed x{n}`(首次 + 每 20 次)。
- **净效果**:主线程上的 WebView2 COM 调用由 **30 次/秒 → 6.7 次/秒(-78%)**,
  异常时自动降至 **1 次/秒**;卡顿撞上轮询的概率同步下降。

### 四、验证

- `cargo build --release` 通过(**31.30s,无编译错误**)。
- 产物 `target/release/miasaki.exe`:PE 时间戳 **`6aa28262`**(2026-09-10 18:11:46),24.5 MB;
  二进制串校验 `hash poll slow` / `hash poll url() failed` / `MIASAKI_NO_MICA` /
  `mica skipped (MIASAKI_NO_MICA)` **均存在**。
- **体积较上一版小 16.3 MB 属预期,已核实非缺件**:工作区删除了 5 个**切帧用源素材**
  (`pets/{kurumi,whale}/spritesheet.webp`、`pets/inverse/raw/blue-{deep,idle,work}.png`,
  合计 16.3 MB,与差值精确吻合);逐条核验 `assets.rs` 的 **75 条内嵌引用零缺失**,且
  **不引用**上述任何文件(运行时只读切好的 `frames/` 与 `states/`)→ 产物功能完整。

- **修订(收尾整理):上述 5 个文件**全部恢复入库**(合计 16.3 MB)。**
  原核验只覆盖了**运行时**(那部分结论依然成立:`assets.rs` 不引用它们,只读切好的
  `frames/` 与 `states/`),**漏核了构建链** —— 逐条查证后,5 个文件各有脚本消费,删掉即断链:

  | 文件 | 消费者(脚本内的真实读取点) |
  |---|---|
  | `pets/kurumi/spritesheet.webp` | `scripts/build-init.mjs:15`(webp→png 图集转换,产物即被追踪的 `spritesheet.png`)、`scripts/make-icons.mjs:14`(图标裁切源) |
  | `pets/whale/spritesheet.webp` | `scripts/build-init.mjs:15`(同上转换) |
  | `pets/inverse/raw/blue-{deep,idle,work}.png` | `scripts/inverse-states.mjs:30,48`(`RAW` 是其唯一输入,抠出 `states/*.png`) |

  另:`ui/pets/{whale,kurumi,inverse}/pet.json` 的 `spritesheetPath` 均指向 `spritesheet.webp`。
  **为什么删了却没被发现**:`build-init.mjs` 的转换带 `existsSync(src)` 守卫,源缺失即**静默跳过**
  —— 删掉 webp 后 `verify-all` 的 `gen-init` 仍 PASS(用旧的 `spritesheet.png` 顶替),
  断链不会自己暴露。**教训:大素材的"能不能删"必须核对脚本输入,而非只核对运行时引用。**
  **结论:本次瘦身全部回退,仓库体积与上一版持平;运行时产物不受影响(删或恢复均不进
  `assets.rs`)。**

- **触摸点**:`src-tauri/src/main.rs`;`README.md`(§桌宠设置面板 通信段);本文件。
  新增 `_refs/scripts-archive/deploy-miasaki.ps1`(部署脚本,自动等待进程退出 + SHA256 校验)。
- **验证点(用户执行)**:先**退出桌面端**(运行中会锁定 `dist/Miasaki.exe`),再运行
  `deploy-miasaki.ps1` 完成部署;启动后**拖动窗口应仍跟手**(拖窗档 33ms),常态下 pet.log
  仅在异常时出现 `hash poll slow` —— 若长期无该行,即说明 UI 线程未再被同步调用拖住。

## 2026-09-10(升级会话) · DSH 0.1.5-rc.1:persona 拆分致三个 preset 失效,改为模板生成

**现象**:DSH 全局升级到 `0.1.5-rc.1` 后,`whale` / `kurumi` / `inverse` 三个 agent preset 全部失效。

**根因**(已核实,非推测):`@deepseek-ai/dsh-persona` 的 Config schema 在 0.1.5 由单字段改为前后缀:

```js
// node_modules/@deepseek-ai/dsh-persona/lib/index.js
prefix: z.string().required(),        // ← 必填
suffix: z.string().default(""),       // 缺省为空,且**缺省即遮蔽部署级后缀**(不继承)
complete: z.boolean().default(false),
includeRuntimeContext: z.boolean().default(true),
```

旧字段 `config.text` **已不存在**,而三个 preset 里写的仍是 `text:` → schema 校验必然失败,preset 无法加载。这正是 0.1.5 release note 所说「自定义 persona 配置拆分为前缀和后缀」。

**底座差异**:把用户侧 `whale/agent.cordis.yml` 与 0.1.5 的 `dsh-agent-presets/presets/standard/agent.cordis.yml` 逐行 diff,共 6 处:

| 处 | 0.1.5 底座 | 本仓库自定义 | 处置 |
|---|---|---|---|
| persona 行 | `suffix` + `prefix` 两字段 | 原 `text`(自包含 model 与 cwd) | 映射到 `prefix`,**不设 suffix** |
| goals 段 | 新增 `command-goal` 行 | — | 采用底座 |
| delegation 注释 | 删去 tool-subagent-report 段 | — | 采用底座 |
| tool-subagent | 新增 `modelSelectionSettings: true` | `agentOptions` → openrouter / z-ai/glm-5.2:free / 32768 | **两者都保留** |
| tool-subagent-fork | 删去 `agentOptions`(注释说明:fork 继承父模型才能复用 KV Cache) | 同上 `agentOptions` | **保留自定义**(放弃该优化换子 agent 免费) |
| tool-web | `fetch: true` | `fetch: false` | **保留自定义** |
| 文件末尾 | 新增 `present` 行(`@deepseek-ai/dsh-tool-present`) | — | 采用底座 |

**改动**:

1. **新增 `preset-sources/agent.base.cordis.yml`** —— 0.1.5 `standard` 底座全文,persona 行改为占位符 `__PERSONA__`,本仓库三处自定义已就地合并并加注释标注。
2. **`apply-presets.ps1` 重写** —— 从"在已安装底座上做 persona 文本锚点替换"改为**读模板整体生成**。旧做法的 `$oldText` 锚点是 0.1.2 的模板措辞,底座一变就 `throw "persona anchor not found"`;新做法幂等、不依赖底座措辞,覆盖前留 `.bak`。
3. **新增 `preset-sources/verify-presets.cjs`** —— 校验产物:persona 字段形状、自定义项是否保留、0.1.5 新增行是否就位。自带 `!!js` 标签 schema(preset 里的 `disabled: !!js process.platform === 'win32'` 会让标准 js-yaml 报 unknown tag)。
4. **用户侧 `~/.dsh/.agent-presets/<id>/` 从此是生成产物** —— 不再手改,改动一律进 `preset-sources/`。

**验证**:以 `$env:USERPROFILE` 指向临时目录干跑脚本,三个 preset × 12 项检查全部通过(prefix 存在、text 已移除、suffix 未设、含 `{{model}}`/`{{cwd}}`、多行块、两处 agentOptions 保留、fetch=false 保留、command-goal 与 present 就位)。

**补丁重打(同日完成)**:`patches/dsh-client-ui-settings-models` 被本次升级覆盖(`status` 报 `unknown`,`.dsh-bak` 丢失)。核对结果:**7 个锚点在新版 client.js 中全部唯一命中**(新版 138,937 B,比 0.1.2 多 1,236 B),`insertAfterOffset` 的期望值检查也全部通过 —— 因此**未改动任何 EDITS**,只换了两份 baseline 并更新三个常量(`BASELINE_DSH_VERSION` → `0.1.5-rc.1`、`ORIGINAL_SHA256` → `A60FD863…`、`PATCHED_SHA256` → `E602C1F1…`)。`verify` PASS(7 条编辑逐字节一致),`apply` 成功(144,576 B,安装目录已 `patched`,备份 `client.js.dsh-bak` 重建),`verify-all.mjs desktop` **4/4 通过**。基线沿革已记入补丁 README。

## 2026-09-10(深夜) · 【重大更正】Mica 假设被推翻:首挂早于 Mica 上线 4h44m

依据:对上方 WER 取证结果的交叉验证。**本轮推翻 2026-09-09 条目的核心论断**,无代码改动,
只更正认知并重定向排查方向。

### 一、Mica 假设不成立(三重独立证据)

2026-09-09 条目称「挂起首次出现在 9/05,与当日「标题栏与主界面融为一体(Mica)」同日 →
时间拐点指向 Mica」。该推断**只比对了日期,未核实 9/05 当天的先后顺序** —— 而首挂其实
**早于** Mica:

| # | 证据类型 | 内容 |
|---|---|---|
| 1 | 运行时 | pet.log 中 `mica backdrop applied` **首次**出现在 **09-05 22:43:28**;此前每次会话(含 17:57:23 启动、17:59:27 挂起的那次)启动段**全无 mica 行**,亦无 `mica unavailable` |
| 2 | 二进制 | 首挂 WER `P3=6a9a7b15` = **09-04 16:02:29** 构建的产物(对照:旧 dist 备份为 `6aa0269d`/09-08 23:15,系**另一次**构建) |
| 3 | 提交 | Mica 改动(`DWMWA_SYSTEMBACKDROP_TYPE` 与 `.shadow(true)`)由提交 **8f48216(09-06 01:26)** 引入 `main.rs` |

→ **首挂(09-05 17:59:27)比 Mica 首次运行早 4 小时 44 分、比其提交早约 7.5 小时**,
因果方向不成立。

### 二、新证据:挂起签名跨产物恒定

| 次序 | 时刻 | P3(产物) | 构建时间 | 含 Mica | P4(HangSig) | P5(HangType) |
|---|---|---|---|---|---|---|
| 1 | 09-05 17:59:27 | `6a9a7b15` | 09-04 16:02 | 否 | `c27d` | `67246080` |
| 2 | 09-09 00:52:37 | `6aa0269d` | 09-08 23:15 | 是 | `c27d` | `67246080` |
| 3 | 09-09 01:09:02 | `6aa0269d` | 09-08 23:15 | 是 | `c27d` | `67246080` |
| 4 | 09-10 17:01:07 | `6aa0269d` | 09-08 23:15 | 是 | `c27d` | `67246080` |

- **P4/P5 四次完全相同** → 同一挂起模式,不是随机噪声(也与「首挂与后三次成因可能不同」的
  猜想相左:签名一致,更像**同一成因**、只是首挂那次 fault bucket 归并不同)。
- **产物跨越两次构建**(且首挂那次**不含 Mica**) → **排除「某一次构建引入的缺陷」**,
  指向长期存在的代码路径或环境侧因素。
- **嫌疑区间收窄**:产物 `6a968676`(09-01 16:01,即根 `dist/Miasaki.exe`)在 9/1~9/4 支撑
  多次会话且**零挂起** → 引入区间锁定在 **09-01 16:01 → 09-04 16:02**,对应 CHANGELOG
  2026-09-04 条目所载「运行时拆分 / 桌宠模块化 / GDI 兜底 / 令牌漂移 / Fleet 指示器」。

### 三、跨进程挂起已排除(更正上方条目的疑点)

上方条目注意到 `ConsentKey=AppHangXProcB1`。经查**该字段不表示实际跨进程**:真正的
`AppHangXProcB1` 在**事件日志 `Event Name`** 处即写作 `AppHangXProcB1`,且问题签名
**`P6` = 被等待的进程名**(实例见 Microsoft Q&A:`P1: explorer.exe … P5: HangType
P6: svchost.exe`)。本机四次事件的 **`Event Name` 均为 `AppHangB1`、`P6` 均为空**
→ **非跨进程挂起**。

### 四、新增(未确证)线索:WebView2 更新节奏

`EdgeWebView\Application\SetupMetrics` 记录的更新活动:09-02 13:32、09-03 11:54、
**09-05 00:00:26**、**09-06 22:59:41**(后者与 WebView2 目录 `152.0.4191.66` 的创建时间
09-06 22:59:36 吻合);首挂在 09-05 00:00 那次更新后约 18 小时。**反向证据**:事件日志自
7/23 起**只有 Miasaki 挂起**,本机其他 WebView2 应用(微信等)均无记录 → 若为运行时通用
缺陷应波及他者,故更像 Miasaki 特有路径。**列为待验假设,不作结论。**

### 五、A/B 的价值重估

Mica 既已排除,`MIASAKI_NO_MICA` 关闭组由「主验证」降为「最终确认」(成本低,可继续跑,
但已不在关键路径上)。**真正的瓶颈仍是缺挂起瞬间的线程栈**:WER 无 dump、`LoadedModule`
为 0,含栈定位不可得。

- **触摸点**:本文件;`design/TODO.md`。**无代码改动**。
  (`_refs/scripts-archive/read-wer-hang.ps1` 本轮升级:导出完整 Report.wer 供离线分析)

## 2026-09-10(晚·续) · token-monitor v0.5.0:**会话活跃分布** + 会话身份折叠

依据:用户实测反馈 —— 「用量统计里的**会话用量不清晰**」,进一步澄清为
「**显示的是一串内部编号,不清楚是哪个会话,这才是问题所在**」;同时给出一张
「工作空间活跃分布」参考图(名称 | 数值 | 占比·会话数 | 行内迷你分布条 +
排序键/搜索/条数三组控件)作为设计路径。

### 一、根因(先查清楚再动手)

1. 账本 `usage-log.jsonl` 按 `sessionId` 聚合,**本身不含标题**;
2. 旧实现唯一标题来源是 `ctx.sessions.get(id)` —— 那是**内存 store**,只认当前
   活着的会话,已归档会话一律 `undefined` → 降级成截断 ID。实测账本 45 个会话中
   绝大多数属第二类,于是整列编号。

### 二、方案与实测依据(不靠猜 API)

- 用 Inspect 查 `Service.listService` 后锁定 `ctx.sessionQuery`:
  `readTitleSnapshots(ids[])` —— 批量、**支持已持久化(非内存)会话**、按会话隔离
  失败,返回 `{session: SessionHeader, title?}`,header 带 `cwd`/`createdAt`/
  `origin`/`agentPreset`。
- **临时 host 探针插件实测**(`tprobe-1`,用完即删):10 个真实历史会话 **10/10**
  取到标题(来源 `provider`/`fallback`),带回工作目录与 `origin=subagent`;
  **冷读 2.8s / 10 会话** —— 该数字决定了缓存与预热是必需项而非优化项。

### 三、改动

- **lib/index.js**:新增「会话身份折叠」通道 —— TTL 缓存(有标题 30min / 无标题
  2min 重试)+ 单飞任务 + 启动预热(账本载入后 1.5s 起跑)+ 首屏等待上限 2.5s
  (超时用 ID 兜底、后台补完,下一轮轮询即有);降级链 缓存 → 内存 store → 截断 ID,
  **绝不编造名字**。`sessionRanking` 增出 `dates[]`/`rows[].daily[]` 与
  `totalAll`/`callsAll`/`matched` 三个口径字段;下发上限 `SESSION_TOPN` 10 → 50
  (排序键切换与搜索若在截断后的 Top 10 上做,结果会错)。
- **lib/client.js**:「会话用量 Top N」→「**会话活跃分布**」:名称列两行(标题 +
  `工作目录 · 最后活跃日`,子会话标签,hover 给完整 ID/cwd/预设)、数值列、
  `占比% · N 轮消息`(分母 = 窗口内**全部**会话)、**近 30 日逐日分布格**(空日极淡、
  有量按**该行自身峰值** 4 档提亮)、**四组控件**(维度 / 排序键 / 搜索标题·ID·目录 /
  条数 Top 10–50,全部本地即时生效);「使用分布」两列改为 `minmax(300,380) 1fr`,
  把宽度让给排行。
- **维度切换是实测逼出来的,不是照抄参考图**:第一版只有「按会话」,真实账本回放
  直接证伪 —— 45 个会话 / 1350 格**只有 50 格非零(4%)**,单行最多活跃 2 天,条带
  几乎全空。单会话时间跨度天生短(多在当天活跃),须按工作目录叠加才成形:补
  `cwdRanking` 后 4 个目录 / 120 格 **21 格非零(18%)**、单行最多活跃 6 天。
  聚合入参用**全量**会话行(截断后聚合会随口径漂移);未解析出目录的会话计入
  `unresolved` 如实提示,**不塞进"未知目录"假分组**。
- **会话「用量」Tab 一行未动**(用户明确要求只改「用量统计」全局浮窗这一处)。

### 四、验证

- 源码级探针(host 真跑 `apply` + 真调 `/global`;client 从 `client.js` 原文截取
  组件函数体渲染):**61/61 通过** —— 两个维度的聚合与渲染、逐日分布、分母口径、
  标题折叠、子会话标记、三个降级场景(无 `sessionQuery` / 单会话失败 / 整批抛错)、
  四组控件交互全覆盖。
- 真实账本回放(副本,不碰原账本):45 会话 / 4 目录,确认上述填充率对比;首屏
  2ms 返回(命中预热缓存),折叠按全量 45 个 id 单飞一次,第二轮不再触发。
- 目检待办:host 重启后确认整列显示中文标题、身份行目录/日期正确、分布条形态可读。

### 五、附带发现 → **已由 v0.5.1 修复**(见上方条目)

`flushLedger(true)` 在 `process.on('exit')` 触发时,**强制**写出所有 `spanDirty`
条目,而 `loadLedger()` 载入 span 行时经 `touchSpan` 把这些键重新标脏 —— 于是
**每次 host 正常退出都会向 `usage-log.jsonl` 追加一批重复的 span 快照行**
(本机 45 个会话 ≈ 45 行 / 次)。追加的是幂等快照,不改统计结果,只是账本缓慢膨胀。
实测本机账本因此积了 **947 行纯冗余(占 19%)**;修复、存量清理与对照实验见上方
v0.5.1 条目。

### 六、用户需执行

`%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-token-monitor\lib\` 覆盖为仓库
最新两文件 → **重启 host** → 刷新页面 → 侧栏「用量统计」。

## 2026-09-10(晚) · WER 提权取证完成:**确认无 dump** + **A/B 正式开跑**

> ⚠️ **2026-09-10(深夜) 补正两处**:①`Sig[4]=67246080` 的十六进制应为 **`0x04021800`**
> (非 `0x04020000`);②`ConsentKey=AppHangXProcB1` **不代表跨进程挂起** —— 判定依据是事件
> `Event Name` 与签名 `P6`,本机为 `AppHangB1` 且 `P6` 空。详见上方 2026-09-10(深夜) 条目。

依据:用户以管理员身份运行 `read-wer-hang.ps1`,并用 `miasaki-mica-off.cmd` 启动。
原始报告落盘 `_refs/scripts-archive/wer-hang-report-20260910-173656.txt`(14,320 B)。

### 一、WER 提权读取结论(admin: True)

- **Miasaki 报告目录仅 1 个** —— `Critical_Miasaki.exe_5f97eb7b…`(modified 2026-09-10
  17:01:10),目录内含**唯一文件 `Report.wer`(56,346 B)**。
- **`>>> no dump in this report`** —— 四次挂起**全部无 dump**,与既有判断一致。
  `LoadedModule entries: 0`:报告未记录任何已加载模块 → **「hung module」这一路彻底走不通**。
  根因仍只能靠排除法,含栈定位不可得。
- **`Sig[4]` 实测已取到**(此前判断「需提权才能拿」正确,但**取值与预期不同**):

  | 字段 | 值 |
  |---|---|
  | `EventType` | `AppHangB1` |
  | `ConsentKey` | `AppHangXProcB1` |
  | `FriendlyEventName` | `Stopped responding and was closed` |
  | `Sig[3]`(Hang Signature) | `c27d` |
  | **`Sig[4]`(Hang Type)** | **`67246080`** |
  | `DynamicSig[22..28]` | `c27d7f28a4f1ea1f22a0d6d606cd5fc8` / `3f2f` / `3f2fe0835551d23dfc45a490bcc50b94` |

  **重要更正**:`Sig[4]` 的值是十进制整数 `67246080`(即 `0x04020000`),**并非**此前设想的
  可读字符串 `Top level window is idle`。后者是**事件日志** `1002` 的 `HangType` 字段语义,
  两套通道字段名撞车但取值格式不同 —— 后续取证勿再混淆。
- **Fault bucket 序列(9/05 与 9/09/9/10 不同)**:
  - 9/05 17:59:31 → `1181927956033363949`(**孤例**)
  - 9/09 00:52:42 / 01:09:05 / 9/10 17:01:10 → **`2204849698794992458`**(连续三次**相同**)
  - 即**首挂与后三次成因可能不同**;后三次已构成稳定的可比基线。
- 每次挂起伴随 `1001`(Windows Error Reporting)紧邻 `1002`,时间戳一一对应。
- `OsInfo[39].servicinginprogress = 1` —— 留意:挂起期间系统有 servicing 在挂起态,
  属环境噪声,不足以解释(9/05 首挂未标注)。

### 二、A/B 正式开跑(硬证据)

`MIASAKI_NO_MICA` 部署修复**已实证生效**,pet.log 第 2497 行:

```
[1789033056s] mica skipped (MIASAKI_NO_MICA) → opaque background
```

- 时间 **2026-09-10 17:37:36**,`mica skipped` 计数 = **1**(历史首次出现)。
- 该行**直接跟在** `asset-server listening :39800` 之后、`window created` 之前 ——
  与 `main.rs` 的设计一致:窗口**从创建起**即用实色底,不存在「先透明后补实色」的中间态。
- 对照:此前 28 次启动(pet.log 第 1524~2477 行)**全部**为
  `mica backdrop applied (window transparent)`,`mica skipped` 出现次数为 **0**。
- **A/B 自此正式开始,观察起点 = 2026-09-10 17:37:36。**

### 三、本轮方法学修正(写入长期记忆)

- `read-wer-hang.ps1` 的 dump 判定**需提权**(`ReportArchive\*` 内容受 ACL 保护,实测
  所有 WER 报告目录一致,非 Miasaki 特有);但 **`HangType` / `ReportId` / `ProcessId` /
  `ExeFileName` 等字段可经 `wevtutil qe Application /f:xml` 免提权取得**,
  足以覆盖事件通道诉求。
- **进程级提权在助手侧不可用**:`Start-Process -Verb RunAs` 与
  `[Diagnostics.Process]::Start` 均被安全策略拦截 → 需 UAC 的动作**只能由用户手动执行**。

## 2026-09-10 · 「全黑无响应」第 4 次复现,并查明诊断开关从未部署(A/B 实际未开始)

依据:用户「刚刚突然又全黑屏关不掉了」。

- **事件定性(第 4 次)**:今天 17:01:07 `Application Hang`(Id 1002 / `AppHangB1`),WER fault
  bucket `2204849698794992458` —— 与 9/09 两次**完全相同** → 同一成因。四次记录:9/05 17:59:27、
  9/09 00:52:37、9/09 01:09:02、9/10 17:01:07。
- **本次为「全进程冻结」而非仅窗口无响应**:pet.log 最后写入 16:55:19,此后连桌宠线程也不再
  有任何输出(该文件由桌宠窗口线程与 hash 看门狗共同写入)。
- **【决定性发现】`MIASAKI_NO_MICA` 诊断开关从未部署到用户实际运行路径**:
  1. 带开关的构建产物是 `src-tauri/target/release/miasaki.exe`(2026-09-09 01:23:53,二进制串
     校验含 `MIASAKI_NO_MICA` / `mica skipped (MIASAKI_NO_MICA)`);
  2. 但桌面快捷方式 `Miasaki-dsh.lnk` 与 `_refs/scripts-archive/miasaki-mica-{on,off}.cmd`
     **全部指向** `dsh-miasaki-desktop/dist/Miasaki.exe`(2026-09-09 00:07:59),该产物
     **不含**上述字符串;
  3. 即 9/09 那次「构建通过」后**遗漏了 dist 同步**,`miasaki-mica-off.cmd` 设的环境变量被旧
     exe 完全忽略。硬证据:pet.log 全程只有 `mica backdrop applied (window transparent)`,
     **从未出现** `mica skipped (MIASAKI_NO_MICA) → opaque background`。
  - **结论:至今 4 次挂起全部发生在 Mica 模式下,Mica 假设既未被证实也未被排除;
    9/09 计划的 A/B 对比实际从未开始。**
- **本轮新排除**:
  ①**WebView2/Edge 版本更新** —— `EBWebView.bak/Last Version` = `152.0.4191.62`(首挂 9/05 时),
  今天为 `152.0.4191.66`,**两个版本均挂起**;
  ②**WebView2 侧崩溃** —— `Local State` 的 `system_crash_count: 0`、`Crashpad/reports` 为空、
  `exited_cleanly: true`,即 WebView2 未崩溃,是挂起。
- **「黑屏」与「关不掉」的机制(对既有现象的补充解释)**:Mica 模式窗口底色为 `RGBA(0,0,0,0)`
  (全透明),画面完全依赖 DWM 合成 + WebView2 提交帧,窗口挂起后无内容可合成 → 纯黑(区别于
  普通窗口挂起会保留最后一帧);「关不掉」是因为 `main.rs` 对 `CloseRequested` 调
  `api.prevent_close()` 并把关闭交给**前端弹窗**确认,前端已挂起则弹窗不出现,而兜底(5s 内二次)
  只认 Alt+F4 系统路径,**消息循环停摆时连 `WM_CLOSE` 都无法分发** → 只能任务管理器。
- **改动**:
  1. **部署修复** —— 将 `target/release/miasaki.exe` 复制为 `dist/Miasaki.exe`(SHA256
     `CBA9F54B94A5AF46313995CFC85A2A178EE1382F7DD7156E2F900CB21E3D0EE3`,与源逐字节一致);
     旧产物备份至 `_refs/bin-archive/Miasaki.exe.20260909-0007.bak`。至此 `MIASAKI_NO_MICA`
     才真正可用。
  2. 新增取证脚本 `_refs/scripts-archive/read-wer-hang.ps1`(自提权):列出 Miasaki 的全部 WER
     报告目录与文件、抽取 `Report.wer` 关键字段与 LoadedModule 尾段、**并重点报告是否存在
     dump**(有 dump 即可读全线程栈直接定位根因)。
- **验证**:`dist/Miasaki.exe` 与 `target/release/miasaki.exe` SHA256 一致;二进制串校验
  `MIASAKI_NO_MICA` / `mica skipped (MIASAKI_NO_MICA)` / `mica backdrop applied` /
  `mica unavailable` 四项均存在;`read-wer-hang.ps1` 通过 PowerShell AST 语法检查,其事件筛选
  段在非提权下实测命中 12 条记录。
- **触摸点**:`dsh-miasaki-desktop/dist/Miasaki.exe`(产物,已 gitignore);本文件;`design/TODO.md`;
  新增 `_refs/scripts-archive/read-wer-hang.ps1` 与 `_refs/bin-archive/`。
- **验证点(用户执行)**:①以**管理员身份**运行 `read-wer-hang.ps1`,看是否存在 dump 与 hung
  module;②用 `miasaki-mica-off.cmd` 启动,pet.log 应出现
  `mica skipped (MIASAKI_NO_MICA) → opaque background` —— 出现即证明开关生效、A/B 正式开始。

## 2026-09-09 · 偶发「全黑无响应」取证:新增 MIASAKI_NO_MICA 诊断开关

依据:用户「桌面端会突然全黑屏无法操作，必须通过任务管理器才能终止程序」。本轮**只做取证与
可回退实验**，不改默认行为。

- **现象定性**:Windows 事件日志为 `Application Hang`(Id 1002) + WER `Critical_Miasaki.exe_*`，
  **不是崩溃**。三次记录:2026-09-05 17:59:27、2026-09-09 00:52:37、01:09:02；后两次
  fault bucket 相同(`2204849698794992458`) → 同一成因、可复现。窗口纯黑且连托盘都无响应，
  说明主窗口消息循环整体停摆、WebView2 侧已无内容——区别于「渲染冻结」（那会保留最后一帧）。
- **时间拐点（本次关键证据）**:事件日志覆盖 7/23 起，Miasaki 记录只有两类——8/21~8/22 五次
  `Application Error`（即 TODO 的「闪退」，第六轮 GDI 修复后彻底消失）与 9/5 起三次
  `Application Hang`。**挂起首次出现在 2026-09-05，与该日「标题栏与主界面融为一体
  (Win11 Mica + 圆角 + 零分界)」同日**（那次引入 `.background_color(0,0,0,0)` +
  `apply_mica()` + `.shadow(true)`，窗口自此不再自绘底色，画面完全依赖 DWM 合成 +
  WebView2 提交帧）。
- **已排除**:①401 cookie 黑屏——`.credentials.yaml` 的 `client-connection/browser-session`
  secret 与 `themes/src/00-boot.js` 硬编码值 SHA-256 一致(`8712c86000fec812…`)，注入仍有效；
  ②后端——dsh web 进程 `Responding=True`、CPU 约 23% 单核；③GPU 驱动超时/硬件错误——近 6 天
  `System` 日志无 TDR(4101)/WHEA/BugCheck；④待机冻结——Modern Standby 仅 9/7、9/8 22:05~22:31，
  两次挂起不在窗口内；⑤桌宠渲染——pet.log 中 `ULW failed`/`surface rebuilt` 兜底路径从未触发。
- **改动**（`src-tauri/src/main.rs`，三处，默认行为不变）:
  1. 新增 `no_mica_requested()`:`MIASAKI_NO_MICA=1`（或 `true`）时启用；
  2. `apply_mica()` 顶部短路:跳过 DWM Mica、直接 `set_background_color(fallback_bg)`，
     并落盘 `mica skipped (MIASAKI_NO_MICA) → opaque background`；
  3. 窗口创建处 `.background_color(window_bg)`:`no_mica` 时从建窗起就用实色主题底，
     避免「先透明后补实色」闪一下。
- **验证**:`cargo build --release` 通过（36.53s，产物 `target/release/miasaki.exe`，
  42,797,056 B）；产物内嵌字符串 `MIASAKI_NO_MICA` / `mica skipped` 已确认存在。
- **触摸点**:`src-tauri/src/main.rs`；本文件；`design/TODO.md`。
- **验证点（用户执行）**:A/B 对比——「开 Mica」（不设变量）与「关 Mica」各跑几天，比较挂起频率；
  关 Mica 时 `%LOCALAPPDATA%\miasaki\pet.log` 应出现
  `mica skipped (MIASAKI_NO_MICA) → opaque background`。若关 Mica 后不再挂起，即坐实
  「透明窗口 + Mica 合成」成因，再定正式修复方案。
- **取证工具**（一次性，归档未入库）:`_refs/scripts-archive/watch-miasaki-hang.ps1`
  （后台常驻，检测到 `Responding=False` 自动抓 CPU 采样 / 逐线程 state-wait / WebView2 子进程 /
  日志尾部 / 前台窗口）、`_refs/scripts-archive/diag-miasaki-hang.ps1`（手动单次快照）。

## 2026-09-08(晚) · 注入层状态扫描性能收敛:去掉每轮强制同步布局

依据:用户报告桌面端「有时断连」。实机问诊后现象为**界面还在但消息发不出、输出卡住不动**
(而非 DSH 的「连接异常,点击立即重连」)。排查出两条叠加因素,本次只动桌面端那一侧:

- **机制层(DSH 本体,未改)**:事件流走 WebSocket mux,服务端 `websocketHeartbeatIntervalMs`
  默认 **2000ms**、`MAX_MISSED_HEARTBEATS = 2`——连续 2 次收不到 pong(约 4~6s)即
  `socket.terminate()`;断后前端才走指数退避重连(500ms→10s),该窗口内界面无任何更新。
  即:任何 ≥4s 的进程冻结/主线程卡顿都会被放大成「断连 + 静默期」。
- **桌面端特有(本次修)**:注入层每 1.5s 的状态扫描链路里含多次**强制同步布局**调用。

- **`02-core.js`:`syncHash` 拆出 `computeDiag`,diag 段按 10s 节流重算 + 缓存**:
  diag 里的 `getBoundingClientRect()`(×2)、`document.elementFromPoint()`、
  `getComputedStyle()` 都是强制同步布局;而 `syncHash` 由状态扫描每 1.5s 触发一次,
  在长会话 + 流式输出(DOM 持续变化)时每轮都要重算一次完整布局。
  新增 `DIAG_MIN_INTERVAL_MS = 10000` 与 `DIAG_CACHE`/`DIAG_AT`;`syncHash(force)` 在
  主题切换(`apply`)与启动首帧(`08-ready`)传 `true` 立即重算,常规同步只写
  `theme/int/act/wait` + 缓存 diag(字段格式与取值语义不变,Rust 侧 `hash-diag` 落盘逻辑零改动)。
- **`05-sensors.js`:`scanActivity` 把廉价判断前置**:
  原实现对**每个** button 求 `el.offsetParent`(强制布局)后才做文本匹配;改为先
  `isBtnTextMatch(textContent)`(不碰布局),命中后才做 `closest`/可见性判断——
  常规轮次对绝大多数按钮零布局开销。
- **`05-sensors.js`:`petEvalIntensity` 扫描节奏分级**:
  `activity` 每轮(只查 button,廉价);`effort`/`approval` 属重量级全量查询
  (遍历整棵 DOM,approval 还带 `[class*="modal" i]` 属性选择器)降到每
  `PET_HEAVY_EVERY = 2` 轮(3s)一次;`document.visibilityState === 'hidden'` 时整体降到每
  `PET_HIDDEN_EVERY = 4` 轮(6s)一次(此时 Chromium 本就节流页面,实时性收益极低)。
- **可感知的行为变化(折中,已评估可接受)**:思考强度/等待审批的检测间隔 1.5s→3s;
  审批气泡消失确认窗口 3s→6s(防抖更强);忙碌指示保持 1.5s 不变;主窗口隐藏时扫描
  1.5s→6s;hash diag 段 1.5s→10s 重算(主题切换/启动仍即时)。
- **实机实测依据**(2026-09-08 21:5x~22:4x,当前 pure 主题,工具
  `_refs/scripts-archive/measure-render-cpu.ps1`):
  - 渲染进程:平均 **3.9~4.2% 单核**,每 ~1.5s 出现一次 **15~47ms** 尖峰,节奏与
    `PET_TIER_MS` 完全吻合(长会话 + 流式输出时尖峰更高)。
  - GPU 进程(加载 `d3d11/dxgi/nvldumdx`):**39~58% 单核持续占用**(随页面活动波动,
    流式输出时接近满载)——pure 主题无光斑仍如此,故主因是「透明窗口 + Mica + 流式重绘」的
    合成开销,**不是**主题装饰;本次不动,已列为后续候选。
  - DSH 主机 HTTP 延迟中位 1ms / P90 2ms(健康);仅在跑构建 / `cargo test` 期间出现
    348~597ms 尖峰,说明主机响应对同机系统负载敏感。
  - **边界(诚实说明)**:本次优化去掉的是渲染主线程每轮的强制同步布局,收益在长会话 +
    高输出场景下更明显;它**不能单独解释**「断连」——DSH 心跳 4~6s 窗口、Modern Standby
    冻结、GPU 持续高占用仍是并列候选,需复现取证才能定论。
  - 系统事件日志另有 9/7 多次 Modern Standby 进出与 9/5 一次 `Miasaki.exe` AppHang 记录。
- **未改动(待用户拍板)**:WebView2 后台节流参数(`additionalBrowserArgs`)、运行期后端
  存活监控 + 自动重启、DSH 侧心跳间隔调大(经 `cordis.patch.yml` 覆盖)。
- **部署复核(2026-09-09)**:`dist/Miasaki.exe` 与 `src-tauri/target/release/miasaki.exe`
  哈希一致(`983382110f870e6a15265cc5ed756724`,42851840 B,9/8 23:15 构建,含本次收敛)——
  重新复制落盘并重启桌面壳(新进程主窗口 `Miasaki · DSH` 正常、DSH host 复用),
  本次优化已进入用户实际使用的二进制;端到端目检仍待用户实操。
- **遗留提示**:`themes/runtime.js`(legacy 回退源)早于本次改动即与 `themes/src/` 拼接结果
  不一致(1101 行 vs 1042 行),构建链路以 `MANIFEST.json` 为准,未同步;若日后要复活回退
  路径需先重新拼接。另:`ARCHITECTURE.md` §3.3 关于「思考强度」的描述(MutationObserver
  计数 / 2.5s 分级)与实现(`scanEffort` 读模型选择器推理等级)不符,属历史遗留,待后续核对。
- 触摸点:`themes/src/02-core.js`、`themes/src/05-sensors.js`、`themes/src/08-ready.js`、
  `src-tauri/injected/theme-init.js`(构建产物)、`design/ARCHITECTURE.md` §3.4、本文件。
- 验证:`npm run gen-init`(令牌完备性通过,产物 65 KB);`node --check` 产物语法通过;
  `node ../scripts/verify-all.mjs desktop` **4/4 通过**;另用 `vm` 抽取改动后的真源码
  (02-core + 05-sensors)做逻辑验证 **14/14 通过**——diag 节流(force 后重算 1 次 / 3s 内
  两次常规同步不重算 / 超 10s 重算 1 次)、`scanActivity` 判定语义逐分支未变(可见→busy、
  `offsetParent` 空且 visibility=hidden→idle、注入层内→idle),且 5 个文本不匹配的按钮
  `offsetParent` 读取 **0 次**(原实现为 5 次)。脚本归档
  `_refs/scripts-archive/verify-inject-scan-logic.mjs`(仓库根运行,可复跑)。
- 排查工具(一次性,归档未入库,均从仓库根运行):
  - `_refs/scripts-archive/diag-desktop-conn.ps1`——卡住瞬间跑一次,抓齐主机 HTTP 延迟 /
    3080 连接与 TIME_WAIT / 各 WebView2 子进程角色与负载 / 三份日志时间线 / 会话日志活性,
    用于区分「主机卡」「连接被掐」「前端卡」三种成因;
  - `_refs/scripts-archive/measure-render-cpu.ps1`——按角色(GPU/渲染/网络)采 CPU 与尖峰,
    优化前后对比用(注意:同机常有其他 `msedgewebview2` 宿主,脚本按进程树/启动时间筛 Miasaki 的);
  - `_refs/scripts-archive/verify-inject-scan-logic.mjs`——注入层扫描逻辑回归(14 项)。
- 用户待执行:**重启 Miasaki** 使注入层新代码生效(`src-tauri/injected/theme-init.js` 已重新生成)。
  验证点:①桌宠思考强度跟随模型选择器仍正确(最多延迟 3s);②等待审批气泡仍及时出现;
  ③长会话流式输出时输入/滚动不再发涩;④`%LOCALAPPDATA%\miasaki\pet.log` 的 `hash-diag` 行
  频率应明显下降(原每 1.5s 变化即落盘);⑤重启后跑
  `pwsh -File _refs/scripts-archive/measure-render-cpu.ps1` 复采一次,与本次基线对比
  「渲染进程」的 >50ms 次数与平均值。

## 2026-09-08 · 模型设置运行时补丁入库（本体例外 · 可重建可回退）

依据:状态盘点发现「设置页模型能力增强」补丁此前**只存在于 `vendor/runtime-bundle/`（gitignore，不入库）**,
而 `vendor/` 丢失或换机即无法重建;同时该目录里的 `patch-runtime.mjs` **已损坏**
（第 93 行 `probe.pруютсяrovider` 混入乱码、第 167-169 行 `if (next === Nt)', => {` 是无效语法、
`replaceAtShift` 未定义,`node --check` 直接报 SyntaxError),其第 5 步块内容与实际产物也不一致
（脚本写 `jsx`/`lv`/`orphan`,产物是 `jsxs`/`level`）。即:唯一的重建脚本既跑不起来,也不忠实。

- **新建 `patches/dsh-client-ui-settings-models/`**:补丁规则 + 基线 + CLI 一体入库。
  - `patch.mjs`——**7 条锚点编辑规则**(5 处插入 + 2 处字典替换),锚点按 trim 全等匹配、
    要求唯一(不唯一即报错);`reasoning-ui` 一条用「锚点 +2 行」并断言目标行内容,避免改版后插错层级。
    CLI 四模式:`verify`(离线自证)/ `status`(状态判定 original/patched/unknown)/ `apply`(备份+幂等应用)/ `revert`。
  - `baseline/client.original.js`——DSH **0.1.2-rc.1** 官方原版(137,701 B,SHA-256 `7ACF9736…`),
    与安装目录 `client.js.dsh-bak` **逐字节一致**(独立副本交叉验证过)。
  - `baseline/client.patched.js`——补丁产物(143,340 B,SHA-256 `18D114AC…`),兼作黄金对照与升级后 diff 基准。
- **重建闭环已自证**:`node patch.mjs verify` 由 baseline 原始文件重建,与 baseline 产物
  **逐字节一致**(非仅哈希;7 条编辑、SHA-256 `18D114AC19CC2C9E…`)。
  途中修正两处自身缺陷:探测路径把已含 scope 的包名重复拼了一层(导致 `status` 找不到安装目录)、
  字节数报的是字符数而非 UTF-8 字节。
- **实机验证**(不碰安装目录):`status` 自动探测到运行中的安装目录并判定 `patched`;
  对副本 `apply` 幂等跳过、对原始副本 `apply` 产出与 baseline 一致的哈希、`revert` 还原成功。
- **接入统一回归**:`scripts/verify-all.mjs` desktop 线新增 `patch verify`(纯离线、不依赖安装目录),
  desktop 3/3 → **4/4**。注意它证明的是「补丁规则与基线自洽」,不是「补丁此刻在安装目录里」——
  DSH 升级覆盖补丁后该项仍应 PASS,而 `status` 会显示 `unknown`。
- **边界**:这是本项目「不修改 DSH 本体」原则的**唯一例外**,代价(升级覆盖、需重打)已在
  `patches/…/README.md` 写清;补丁只改该包 client 产物,不动 DSH 源码与其他包。
- 触摸点:`patches/dsh-client-ui-settings-models/{README.md,patch.mjs,baseline/*}`(新)、
  `README.md`(本线)、`../scripts/verify-all.mjs`、`../dsh-miasaki-shared-docs/cross/{model-settings-toolkit-design-2026-09-07.md,smoke-test-matrix.md}`、根 `../README.md`、本文件。
- 用户待执行:无(补丁已在安装目录中生效);DSH 升级后按 `patches/…/README.md`「升级后怎么办」重打。

## 2026-09-07(晚) · Fleet 脉冲 stale 语义 + Rust 单测首建

依据:桌宠 Fleet 指示器此前不检查 `fleet-pulse.json` 的 `ts` 时效——发布器（常驻
`--interval-ms`）一旦崩溃或被杀,文件仍留在盘上、内容仍是合法 v2 JSON,桌宠会永远停在
「忙碌中…」/「需要你的批准」,且无任何告警(陈旧数据比没有数据更危险)。

- **`read_pulse_flag` 改为 `parse_pulse_flag(txt, now_ms)` + 阈值 `PULSE_STALE_SECS = 30`**:
  龄期 > 30s(发布器建议间隔 5s 的 6 倍)即 stale,等同不可用 → 桌宠 fleet 指示关闭;
  `ts` 缺失/不可解析、未来时间戳(超前>30s,时钟回拨或跨机复制的文件)同判不可信;
  `v != 2`/缺 `fleet`/非 JSON 仍按不可用。
- **新增 `parse_iso8601_ms()`**:极简 ISO-8601 UTC 解析(带小数秒 / `+00:00` 等价形式),
  非 UTC 偏移拒绝;不引第三方时间库。
- **看门狗日志区分三类不可用**:`文件不存在` / `存在但不可用（stale/格式错误)` /
  `未配置 MIASAKI_FLEET_PULSE`——排查时能立刻分清「发布器死了」与「没配变量」。
- **首建 Rust 单测**(`src/main.rs` `#[cfg(test)] mod tests`, 4 项)+ 既有
  `pet_native::image::tests` 共 5 项:`iso8601_parses_utc_forms_and_rejects_offsets`、
  `fresh_pulse_maps_counts_to_running_and_alert`、`stale_pulse_is_rejected_so_the_pet_cannot_freeze_on_busy`(29s 边界有效/31s 已 stale)、
  `malformed_pulse_degrades_to_none`(BOM 前缀容错、单字段缺失按 0 处理)。
- 触摸点:`src-tauri/src/main.rs`(改)、`design/CHANGELOG.md`(本条目)、
  `../dsh-miasaki-shared-docs/cross/ab-linkage-pulse-v2-2026-09-04.md`(时效语义补记)、
  `../scripts/verify-all.mjs`(desktop 线新增 `cargo test`)。
- 验证:`cargo test --bin miasaki` 5/5 通过;`node scripts/verify-all.mjs desktop` 3/3 通过。
- 用户待执行:cargo 在 `~/.cargo/bin` 不在 PATH,`verify-all.mjs` 已自动探测;
  若本机另装 rustup 到别处,`cargo test --bin miasaki --quiet` 手动跑亦可。

## 2026-09-07 · 会话日志下载入口迁移:主界面 → 轨迹页搜索栏左侧（新 bundle dsh-session-log-move）

依据:用户要求「Session 日志」下载按钮不在主界面,改放轨迹页搜索栏左边;
规划设计见 `design/session-log-download-relocate.md`（方案 A 动态插件验证 → B 固化 bundle,
C 改平台源码不采纳——安装目录升级即覆盖）。

- **方案 A 验证（动态 cordis 插件 `slogm-1`,v3 验收通过）**:
  - v1 用 `slots.inject` 隐藏官方按钮无效 —— 动态插件晚于页面激活,`inject` 只对
    “未来声明”的 slot 触发回应,已命名的 slot 被错过;改 `slots.register` 直接替换即生效
    （occupants 由官方 H5 → `dyn/slogm-1` active,官方条目 active:false）;
  - 轨迹页 toolbar 无官方 slot（全树核对 `conversation.view`/`trajectory.images` 均非
    toolbar 挂点）,采用 DOM 注入:`[role=toolbar]` 内 `input[type=search]` 容器左侧
    `insertBefore`,MutationObserver + 500ms 重试兜底（约 30s）,React 重渲染冲掉自动补挂;
  - 下载复用官方 client 服务 `sessionLogDownload.download()`（缺失降级 `<a download>`
    直触 `/api/session.export`）,按钮内联文案反馈并自动复位;
  - client 闭包环境遮蔽 `fetch/timers`（`new Function` 参数梯形成了教学错误）,对
    `document/MutationObserver` 则未遮蔽可直接用——降级路径因此不能走 `fetch`。
- **B 固化**:新增 `plugins/dsh-session-log-move/`（纯 client bundle,host 空壳）:
  `package.json`（dsh.bundle.patch + dsh.client web + peer cordis ^4.0.2）、
  `cordis.patch.yml`（insert id）、`lib/client.js`（替换+注入+下载+反馈,逻辑与验证版
  同源）、`lib/index.js`/`lib/index.d.ts`、`lib/types/client/index.d.ts`、`README.md`。
- 触摸点:`plugins/dsh-session-log-move/`（新增）、`README.md`（目录树 + 插件专节）、
  本文件、`design/session-log-download-relocate.md`（新）。
- 用户待执行:profile `%USERPROFILE%\.dsh\profiles\web\package.json` 挂 file: 依赖
  `dsh-session-log-move` + `dsh.profile.bundles`,profile 目录 install 后 host 重启生效;
  动态插件验证版随时可 `cordis_stop` 停用（可逆）。

## 2026-09-06 · 标题栏 v4:窗控去胶囊化——无壳裸键（阶段 A）+ 真机验收收官

依据:用户对 v3 悬浮胶囊「外壳感」的观感反馈;规划设计见 `design/titlebar-v4-embed.md`
（路线 A 无壳裸键 → A+ 几何嵌入 → B 官方 Slot 真嵌入,B 留 roadmap 待评估）。

- **去胶囊壳**:`.tb-capsule` → `.tb-group`（`03-switcher.js` 删半透明底/边框/圆角/
  backdrop-filter/box-shadow/padding 整段壳样式;`06-titlebar.js` DOM 类名同步）,
  三键以裸键形态直接落右上角,hover 底色只落单按钮（Win11 原生标题栏同款,零新增样式,
  关闭键 hover 红底不变）。
- **徽章保留**:16px 主题小圆留在按钮组左侧（原 18px）,为启动页唯一主题标识
  ——用户拍板 2026-09-06。
- **让位收窄**:132px → 118px（裸键组 ≈108px + 余量）;真机三主题 × 最小宽度 960
  复核「Session 日志/工具」无叠压（v3 初版 104px 叠压教训未复发）。
- **零行为变更回归全过**:hash 命令链（min/max/close/want-max）、关闭确认弹窗、
  36px 空白拖动 + 按钮区不拖、双击标题栏、Win+↑ 系统路径图标同步（≤1.5s 巡检）、
  重开窗口状态恢复、非 DSH 页（404/loading 同注入路径）窗控同形态可用;
  `npm run gen-init` + `npm run verify` 18/18 无告警。
- 触摸点:`themes/src/03-switcher.js`、`themes/src/06-titlebar.js`、本文件、
  `README.md`（标题栏段 v3→v4）、`design/titlebar-v4-embed.md`（新,方案 + 验收记录）。

## 2026-09-06 · 「用量」页重构:会话/全局一刀切 + 侧栏「用量统计」浮窗（token-monitor v0.4.0）

依据:用户对 v0.3.3「用量」Tab 两条诉求——会话页只统计当前会话（与「轨迹」页同口径）、
总量统计整体收口到侧栏独立入口;规划设计见 `design/usage-stats-redesign.md`（四决策点
已拍板:D1 浮窗 / D2 日限额迁全局页 / D3 模型+会话 Top N / D4 加会话活跃时长卡）。

- **host 拆路由（旧 `/summary` 退役）**:`/session?sessionId=…` 只回官方聚合 + 按
  `sessionId` 过滤的实时明细（载荷瘦身）;`/global` 承接跨会话账本统计 + 新增
  **会话 Top N 聚合**（近 30 日按账本 sessionId 聚合 tokens/calls/活跃跨度,Top 10,
  会话标题经 `sessions.get` 尽力解析、失败降级 ID）。`heatmap`/`config`/`reset` 不变,
  账本写入路径零改动,历史统计零迁移。
- **顺带修复现存缺陷**:v0.3.3 `buildSummary` 把 `live.calls`/`live.tools` 全量返回、
  未按 sessionId 过滤,会话页混入了同进程其他会话的数据——现按会话过滤后再下发。
- **会话 Tab 精简**:保留上下文剩余 hero / 会话用量总览卡组（新增「会话活跃时长」卡,
  实时口径）/ 按模型明细（仅本会话）/ 工具调用 / 性能 / 会话口径脚注;迁出总览五卡、
  热力图、近 7/30 日趋势、模型环形图、今日用量、日限额、重置账本。
- **全局浮窗**:client 半新增 `sidebar.footer.action`（id `usage-stats`,设置按钮旁,
  展开态全宽钮/收起态 36px 圆图标钮）+ `shell.overlay`（id `usage-stats-overlay`,
  全帧背板 + 居中面板,Esc/关闭钮/点背板收起）两个槽位条目,开合经模块级
  useSyncExternalStore store 共享;开启期间 `/global` 5s + `/heatmap` 60s 轮询,
  关闭即停。模块序按用户点名:总览六卡 → 热力图 → 使用趋势 → 使用分布（模型环形 +
  会话 Top N）→ 今日与限额（含重置账本）→ 全局口径脚注。图表组件原样复用,
  `--tokmn-*` 中性色作用域扩展到 `.tokmn-ov`。
- 触摸点:`plugins/dsh-token-monitor/{lib/index.js,lib/client.js,package.json,
  cordis.patch.yml,README.md}`、`README.md`（目录树）、本文件、
  `design/usage-stats-redesign.md`（规划稿→定稿）。
- 验证:node --check 双半通过;临时 mock 验证（stub React 渲染 + stub host 路由）覆盖
  会话过滤（s1/s2 不串扰）、Top N 聚合与标题降级、限额读写、重置归零、存量载入不翻倍、
  浮窗开合与空/有数据两态渲染,全绿后脚本已删。机上验证:profile 目录 `pnpm install`
  → 重启 host → 目检会话 Tab 数字随会话切换、浮窗与切会话解耦、重置后热力图归零。
- **目检修复（同日第二轮,用户报告三处问题）**:
  1. 侧栏「用量统计」按钮不谐入（浏览器默认样式边框）+ 浮窗整体无样式堆叠在左上角
     ——同一根因:`UsageStatsButton` 里 `return createElement(style), createElement(div)`
     **逗号表达式**只返回后者,`<style>` 被求值后丢弃,CSS 从未挂载。改为返回
     `[style, …]` 数组,浮窗根组件也自持一份 `<style>`（三个槽位条目独立挂载点,
     样式各自成立）;按钮形态对齐宿主设置触发钮实测 CSS（42px/12px 圆角/透明底/
     hover 同令牌/行高 22px,展开态 `flex:1` 撑满 footerActions,收起态 36px 圆钮）。
  2. 浮窗报「Failed to execute 'json' on 'Response': Unexpected end of JSON」——
     `api()` 未检查 `res.ok`,404 空响应直接 `res.json()` 炸出裸解析错。抽出
     `readJSON` 统一解包（先查状态码,404 给出「host 路由未注册」可读提示）,
     `fetchSession` 一并收编。
  3. 会话页 404「host 路由未注册」——机上状态问题:host 进程 14:36 boot 早于
     profile 拷贝完成（14:38）,跑的是旧 host 半（无 `/session`/`/global`）而 client
     按请求读盘已是新码,新旧混搭。重启 host 后路由全部就位（curl 实测 `/session`
     `/global` 200、旧 `/summary` 按设计 404 退役）。教训落进插件 README:同步必须
     「拷贝完全落盘 → 再重启 host」。
  修复后探针回归（stub React 渲染断言三槽位组件树,归档
  `_refs/scripts-archive/test-token-monitor-v040-fix.cjs`）ALL-PASS;浏览器实机目检:
  按钮与「设置」同构、会话 Tab 真实数据（90% 剩余/2.5M 累计）、浮窗居中背板 +
  六卡/热力图/趋势/Top N/限额全量渲染、Esc 与关闭钮收起均通过。
- **目检修复（同日第三轮,浮窗版式两处）**:
  1. 热力图/趋势图右侧大片空白——热力图网格固定 52 周×14px≈730px 而卡片全宽,
     改 max-content 水平居中;趋势图 `chartW` 的 ResizeObserver 挂在 `[]` 依赖上,
     首挂时数据未到、图表容器未渲染,测量落空后宽度永远回退 640px——改为趋势容器
     无条件渲染（空态文案也放进容器）,observer 首挂即测得真宽,SVG 随面板伸缩。
  2. 每周/累计两模式图表一样「没变化」——账本现只有 2026-09-05/06 两天、同属一周,
     逐周聚合与逐周累计在数学上就是同一根柱,属数据形态而非代码缺陷;仍做形态优化:
     两模式由「整条柱同色分档」改为**变高柱**（柱高 ∝ 值,零周 3px 空柱做基线,
     底部对齐）,并给三模式各配口径脚注（峰值周 X / 累计 X·截至 Y / 活跃日 N）,
     数据跨多周后累计模式自然呈爬坡形态与每周分化。
  验证:node --check + 探针回归 ALL-PASS;仅 client 半变更,`cp` 覆盖 profile 后页面
  刷新生效（host 半零改动无需重启）;浏览器目检每日格点/每周柱/累计柱三态脚注、
  热力图居中与趋势图全宽均通过。

## 2026-09-06 · 人格会话联动改道（修复「人格会话创建失败:not found」）

依据:用户报告切换主题时 toast「人格会话创建失败:Unexpected token 'o', "not found"
is not valid JSON」。实测复现:`POST /api/session.create` → HTTP 404 `not found`。

- **根因**:注入层 `01-persona.js` 自研 RPC(`fetch('/api/'+method)` + client-request
  信封)在 dsh 0.1.2-rc.1 已失效——该版本 RPC 走 WebSocket mux(`/api/remote.mux`,
  见 `dsh-api-gateway` `registerUpgrade`),HTTP `/api/*` 路由不存在 → 404;
  官方客户端经生成的 `ctx.remote.session.*` 代理调用(实测
  `dsh-client-ui-model-selection`: `ctx.remote.session.modelCatalog()`)。
- **修复(职责迁移,版本自适应)**:注入层不再自行 RPC——`01-persona.js` 改为派发
  `miasaki-persona-request` CustomEvent(detail.theme);`plugins/dsh-pet-panel/lib/client.js`
  (桌面插件,官方客户端上下文)监听事件,经 `ctx.remote.session.create({agentPreset,
  workspaceId?})` 创建,保留 localStorage(`miasaki.petSessions`)去重与主题化 toast
  (DSH 令牌配色);`inject` 增加 `remote.session`/`workspaces`。
- 触摸点:`themes/src/01-persona.js`、`plugins/dsh-pet-panel/{lib/client.js}`(已同步
  profile `node_modules`,哈希核对一致)、`README.md`、`injected/theme-init.js`(重生成
  64KB,令牌校验 + node --check 通过)。
- 验证:release 构建通过;验证点——切换主题后 toast 不再报错,「已创建『狂三』人格
  会话」;若插件升级缺失则静默降级(无 toast、无创建),不阻断主题切换。

## 2026-09-05 深夜 · 标题栏 v3:零占位叠加 + 窗控胶囊(修复「顶部切换按钮位置/被遮」)

依据:用户连续三轮反馈「窗口栏把对话会话布局切换按钮遮住了」「最主要的问题是按钮的
位置而不是整个窗口的风格」——v1 色带/v2.1 卡片式都对页面有 32px 布局侵入,把 DSH
会话头整行(标题行 + `role=tablist` 页签「对话/轨迹/用量」)压到顶带下方,按钮位置与
web 端不一致。本轮先做**布局取证**再动手(用户要求「先定位再改」):

- **取证结论**(读 `@deepseek-ai/dsh-client-ui-conversation` 包源码):会话头 =
  `<header>`(ConversationSessionHeader,`.header{padding:12px 28px 0 20px}`)→
  `titleRow`(`titleCluster`(flex:1:面包屑 + `conversation.session.header.actions`
  槽(后台任务等)) + `headerUtilities`(`conversation.session.header.utilities` 槽,
  Session 日志等))→ `tabs`(`role="tablist"`:对话/轨迹/用量)。全部为文档流定位;
  web 端 tabs 位于 y≈46,桌面端被 32px 下推后到 y≈78——位置被顶带挤掉。
- **v3 设计(用户批准)**:
  1. **零占位叠加**:删除 32px 顶带/卡片/#root 下推与 transform——页面回到 y=0,
     所有顶部控件与 web 端同位置(视觉与交互零侵入);
  2. **窗控胶囊**:右上角悬浮胶囊(主题徽章 + 最小化/最大化/关闭,半透明 +
     `backdrop-filter` 毛玻璃,悬停变实色),胶囊外 `pointer-events:none`,不挡页面;
  3. **顶行让位**:`#root header:has([role="tablist"]){padding-right:132px}`——
     会话头右侧(headerUtilities)为胶囊预留宽度(实测胶囊 ≈114px + 余量),
     Session 日志等左移,不再与悬浮胶囊叠压(与 VSCode 等自绘标题栏应用同款让位;
     初版 104px 不足,真机叠压后加宽至 132px;选择器锚定 `role=tablist`,
     DSH 升级时随 verify-themes 复核);
  4. **空白拖动**:document 级捕获 mousedown(y<36 且事件路径无交互元素——复用
     tauri 内置 drag-region 判定口径:可点击标签/contenteditable/tabindex/交互 role)
     → `plugin:window|start_dragging`;双击 → `internal_toggle_maximize`。
     页面按钮/页签/输入框照常点击,空白处拖窗;
  5. 主题标识移入胶囊(顶部左侧不再放任何东西,不碰侧栏 logo);右下角悬浮切换条保留。
- **清理**:删除各主题 `--ms-titlebar-bg`(+ fallback/@supports)与
  `#miasaki-titlebar` 顶缘高光规则;`prefers-reduced-motion` 去掉 tb-theme 引用;
  `06-titlebar.js` 重写为胶囊 + wireDragZone;`08-ready.js` 接线 wireDragZone。
- 触摸点:`themes/src/{03,06,08}`、`themes/{pure,zafkiel,kurkuriel}.css`、
  `src-tauri/injected/theme-init.js`(重生成 67KB,令牌校验 + node --check 通过)。
- 验证:release 构建(`tauri build --no-bundle`)通过;目检点——重启后「对话/轨迹/用量」
  页签回到 web 端位置、右上角胶囊不遮任何页面按钮、顶部空白可拖窗/双击最大化、
  三主题配色正确。

## 2026-09-05 深夜 · 用量页网格/区块边界可见性修复（token-monitor v0.3.3）

依据:用户截图反馈「用量界面的网格状不明显,各个区块的边界线不清晰」。取证 host
主题令牌:浅色模式下 `--dsw-alias-border-l1` 仅 `#0000000a`(4% 黑)、
`--dsw-alias-bg-layer-2` 与 layer-1 同为 `neutral-bluish-00`(纯白)——凡以这两个
令牌做「结构线/空格底」的地方在浅色主题下全部隐形:

- **区块边界**:卡片/总览五卡/hero/悬浮提示/按钮/输入框/chip 的 1px 边框(4% 黑
  肉眼不可见)→ 换插件内自派生 `--tokmn-border`(label-secondary 34% color-mix);
  模型列表/行分隔线 → `--tokmn-hairline`(20%,弱于区块边框一档)。
- **热力图网格**:空格与未来格底色原为 layer-2(白上白,整片空白仅右端有数据格
  可见)→ `--tokmn-cell-empty`(15%,GitHub 热力图空格观感),CSS 类与 `heatStyle`
  内联双处同步。
- **同类隐形顺手修**:趋势图横向网格线(零基线用 border 档、其余虚线用 hairline
  档)、环形图底环、上下文/限额进度条轨道、分段切换轨道、「未使用」图例 dot 的
  inset 描边,均从 layer-2/border-l1 换到对应派生档。
- 派生令牌挂在 `.tokmn-pane` 作用域,基于 `label-secondary` color-mix,深色主题
  (zafkiel/kurkuriel)下同样自适应可见;`color-mix` 需 Chromium 111+,WebView2 满足。
- 触摸点:`plugins/dsh-token-monitor/{lib/client.js, package.json}`。
- 验证:`node --check` 通过;目检点——浅色主题下五卡/各区块有清晰边线,Token 活动
  空格呈浅灰网格,趋势图有横向网格线与零基线,深色主题回归不变。
- 2026-09-06 实机目检通过(profile 重装 + host 重启后,playwright 无头 Edge 取证):
  浅色下五卡/卡片/hero/按钮/chip 边线清晰(`--tokmn-border` 34% 档像素级可见),Token
  活动空格呈浅灰网格(`--tokmn-cell-empty` 15%,371 格全着底),趋势图零基线 34% 实线
  + 25M/50M/75M 20% 虚线网格线可见,环形图底环/进度条轨道/分段切换轨道同步自适;
  深色下同档派生自 label-secondary 亮色、观感与改动前一致。附带实测:`var()`
  写入 SVG 呈现属性经 Chromium 152 正确解析(computed stroke 返回实际颜色)。

## 2026-09-05 深夜 · 标题栏 v2.1:内嵌卡片式(修复「顶带遮住页面顶部控件」)

依据:用户反馈「窗口栏把对话会话布局切换按钮遮住了」「窗口栏顶栏会遮住按钮」——
v2 的固定 32px 顶带 + `margin-top:32px` 推挤方案下,DSH 页面顶部控件(会话头部行/
切换类按钮,部分为脱离文档流的 fixed/sticky 定位)会被顶带压住或紧贴带底边被裁切;
同一页面在 web 端(无顶带)顶部控件位于页面自然顶部。v2.1 改为参考图中 MiniMax 的
「chrome 面 + 内容卡片」结构,从根上消除交叠:

- **chrome 面**:`body` 底色 = `--ms-titlebar-bg`(与顶带同色,见 v2)——顶带与四周
  留边是同一张表面,带与页面无第二层覆盖关系,页面永远在带的下方。
- **内容卡片**:`body #root{margin:38px 8px 10px;border-radius:12px;overflow:hidden;
  background-color:var(--dsw-alias-bg-base);box-shadow;transform:translateZ(0)}`:
  DSH 整体作为圆角白色卡片浮在 chrome 面上(侧栏/详情面板一并入卡),页面顶部控件
  在卡片内保持 web 端的自然位置与间距。
- **fixed/sticky 隔离**:`transform:translateZ(0)` 使 `#root` 成为其内部
  fixed/绝对定位后代的包含块——页面内任何脱离文档流的控件(含用户反馈的切换按钮)
  都会被定位到卡片内,结构上不可能出现在顶带下方;popover/菜单在卡片内照常工作
  (edges 处轻微裁切,可接受)。
- **顶带**:仍为 chrome 表面的一部分(左侧主题标识 + 右侧窗控),但不再与页面内容
  有任何上下层交叠——即使 DSH 升级引入新的 fixed 顶部元素,也无法越过卡片边界。
- 触摸点:`themes/src/03-switcher.js`(SWITCHER_CSS 的 body/#root/带规则)、
  `src-tauri/injected/theme-init.js`(重生成,68KB,令牌校验 + node --check 通过)。
- 验证:release 构建(`tauri build --no-bundle`)通过;目检点——三主题下顶部为
  灰 chrome 色带 + 圆角白色内容卡片,「对话/轨迹/用量」页签与头部控件在卡片内
  完整可见可点,web 端与桌面端顶部布局一致;窗控/拖动/关闭确认行为不变。

## 2026-09-05 晚 · 标题栏 v2:应用化「色带」(对齐 MiniMax Design 参考)

依据:用户给出 MiniMax Design 截图,要求「窗口栏能自然融合到主页面,像第二张图一样
差不多的效果,现在我们的桌面端还不行」。对照参考图像素取证:顶部菜单区采样 `#EFEFF2`、
页面底 `#FAFAFA` —— 参考实现是**全宽约 32px 的统一色带**(与页面同色系、略深一线),
菜单在带内左侧、窗控在带内右侧,带与页面零分界。v1 做法(色带 = DSH 基底令牌,与页面
零色差 + `::before/::after` 侧栏色块/详情分隔线模拟)在纯色/侧栏收起态下带完全隐形,
窗控像浮在页面上的裸图标,观感未达参考。v2 按参考重做:

- **标题带 = 应用 chrome 表面**(`themes/src/03-switcher.js` SWITCHER_CSS):
  `--ms-titlebar-bg` 由各主题定义,三主题均用 `color-mix` 以页面基底混少量分色
  (pure:`label-secondary`;kurkuriel:枪铁 `#6a6159`;zafkiel:蓝灰 `#d6cfe4`)→
  亮色主题略深一线、暗色主题略亮一线(≈12~16% 分量);`@supports` 守卫 + 各主题
  显式 fallback 色,保证 color-mix 不可用的环境回退到近似旧观感而非透明。
  移除 `::before`(侧栏色块)/`::after`(详情分隔线)与 `data-details-open`/`data-local`
  规则——不再依赖 DSH DOM 网格几何(见 ARCHITECTURE 契约废弃)。
- **主题文字常显**:左侧品牌徽 + 主题名/副标题即「应用级内容」(对齐 MiniMax 菜单位),
  不再随侧栏收起淡出;收起态规则与 `data-sidebar-collapsed` 删除。
- **窗控升级**:SVG 10px→12px,按钮 28px 命中区、hover 圆角 999px→8px(Win11/Fluent
  手感,原圆形贴角偏「浮空」);关闭 hover 红色保持;拖动/双击最大化/最大化图标同步
  行为不变。
- **清理与结构性变更**:
  - `themes/src/06-titlebar.js`:删除 `data-local` 标记与 `syncTitlebarGeometry()` 调用;
  - `themes/src/07-dialog-geom.js`:删除几何同步块(ResizeObserver、多信号收起判定、
    诊断写 diag 尾两位),文件名改 `07-dialog.js`(职责=关闭确认弹窗);
  - `themes/src/02-core.js`:hash `diag` 尾两位固定 `.0.0`,注释同步;
  - `themes/src/08-ready.js`:巡检去掉 `syncTitlebarGeometry()` 调用;
  - `themes/src/MANIFEST.json`:order 更新(07-dialog.js),note 标注 slices 行段为
    legacy 切分参考(运行时与 legacy runtime.js 已非逐字节一致);
  - `themes/{pure,zafkiel,kurkuriel}.css`:新增 `--ms-titlebar-bg`(+ fallback);
  - 重生成 `src-tauri/injected/theme-init.js`(68KB):`npm run gen-init` 令牌校验通过、
    `node --check` 语法通过、grep 无残留旧符号。
- 触摸点:`themes/src/{02,03,06,07-dialog.js,08}`、`themes/{pure,zafkiel,kurkuriel}.css`、
  `themes/src/MANIFEST.json`、`design/ARCHITECTURE.md`、`README.md`。
- 验证:沙箱内无页面渲染手段(无头 Edge 被命名管道限制,同 verify-themes TODO)→
  release 构建经 `tauri build --no-bundle`(产物 `target/release/miasaki.exe`);
  视觉验证点:重启桌面端后三主题顶部均为与页面同色系的 32px 色带,左侧主题标识常显、
  右侧窗控 8px 圆角 hover;拖动/双击最大化/窗控按钮/关闭确认弹窗/最大化图标同步
  与 v1 行为一致。

## 2026-09-05 · 标题栏与主界面融为一体（Win11 Mica + 圆角 + 零分界）

依据:用户「怎么把桌面端窗口栏和主界面融为一体做到一块」。

- **架构确认**（只读盘点，无改动）:窗口已 `decorations(false)` 无边框;自绘 32px
  `#miasaki-titlebar`（`themes/src/06-titlebar.js`）与 DSH 主界面的融合此前靠令牌对齐
  （背景 `--dsw-alias-bg-base`、`::before` 侧栏色块 `--dsw-specific-sidebar-fill`、
  `::after` 详情分隔线 `--ms-details-left` + ResizeObserver 帧级几何同步,
  `themes/src/07-dialog-geom.js`）。剩余缺口:直角窗口、标题栏独立色带/装饰底线分界、
  无材质纵深。
- **窗口层**（`src-tauri/src/main.rs` + `Cargo.toml`）:
  1. `.shadow(true)`:Win11 无边框窗口恢复 DWM 圆角 + 阴影 + 1px 描边（tauri 官方文档确认
     `set_shadow` 行为——注明:对接验证过本地 tauri 2.11.5 源码,shadow 语义与 2.9.5
     文档一致）;
  2. `.background_color(0,0,0,0)`:WebView2 默认背景透明（loading.html 自带实色渐变,
     无加载期白闪）;
  3. 新增 `apply_mica()`:直调 DWM `DwmSetWindowAttribute(DWMWA_SYSTEMBACKDROP_TYPE=38,
     DWMSBT_MAINWINDOW=2)`（windows-sys 0.59 已确认常量;hwnd 经 tauri `hwnd()` 字段
     访问,零新增依赖）。**不用 tauri `set_effects` 的原因**:其内部把 window-vibrancy
     错误吞掉（`let _ =`）,无法探测 Win10 回退;DWM 直调按 HRESULT 判定——失败时
     `set_background_color` 回退主题实色底,避免页面半透明处露出 tao 默认白底。
- **主题层**（`themes/{zafkiel,kurkuriel,pure}.css`,经 `build-init.mjs` 重生成
  `src-tauri/injected/theme-init.js`）:
  - zafkiel:`--dsw-alias-bg-base` .86→.8,新增 `--dsw-specific-sidebar-fill:
    rgba(18,16,25,.8)`(此前侧栏实色,不透 Mica);
  - kurkuriel:bg-base .88→.93(亮主题防系统暗色 Mica 偏灰),新增 sidebar-fill
    rgba(252,250,248,.93);
  - 三主题删除 `--ms-deco-line`(标题栏装饰底线)→ 标题栏与主界面零分界;
    zafkiel/kurkuriel 的 `box-shadow` 底部内线去掉,仅留窗口顶缘 1px 高光;
  - pure 保持原版实色(不覆盖 DSH 令牌的设计原则),Mica 仅 zafkiel/kurkuriel 透出。
- **验证**:`cargo check` 通过;`npm run gen-init` 令牌校验通过(73KB);`npm run verify`
  需 CDP 运行时(target 未启动,留给 `tauri dev` 后执行)。
- 触摸点:`src-tauri/src/main.rs`（shadow/Mica/透明底）、`src-tauri/Cargo.toml`
  （Win32_Graphics_Dwm feature）、`themes/*.css` + `src-tauri/injected/theme-init.js`。
- 验证点:用户 `npm run tauri dev` 后——Win11 窗口有圆角/阴影;zafkiel 下标题栏与
  主界面无分界线,窗口边缘透出系统 Mica 材质(主题色盖在其上);切换 kurkuriel 观感
  一致(略实);pure 保持原版。Win10 用户:无圆角/Mica,回退实色底,功能不受影响。

## 2026-09-05 · 修复:「桌面端黑屏」——dsh web 鉴权 cookie 失效自动恢复

依据:用户「桌面端打不开了」，排查确认主窗口黑屏（进程/桌宠/素材服务均正常）。

- **根因链**（全程证据见 `_refs/scripts-archive/diag-2026-09-05-black-screen.md`）:
  1. 今日 dsh 平台适配 0.1.2-rc.1 期间多次重启（17:39/20:43/21:31），17:54
     升级重写了 `~/.dsh/.credentials.yaml` 里 `client-connection/browser-session`
     的签名 secret；
  2. dsh web 鉴权 = 进程级 launchToken 换**secret 签名 cookie**（`dsh-auth-*`，
     `dsh-client-connection` BrowserAuth）。secret 轮换后桌面端 WebView2 里的旧
     cookie 全部失效；
  3. 桌面端再启动 → `GET /` 401（`dsh web authentication required`）→ 纯文本
     错误页在深色窗口背景下呈现为**黑屏**（仅注入标题栏/水印可见），且 loading
     流程对 401 无任何恢复分支；
  4. 排查中一度被 DSH 沙箱文件系统视图误导（Program Files 下 WebView2 目录对
     沙箱不可见），最终经 UAC 管理员视角与 WebView2 对照实验（MIASAKI_REMOTE 指向
     microsoft.com 渲染正常）排除 WebView2/驱动问题。
- **修复**（`themes/src/00-boot.js`，D1 运行时新增职责「鉴权 cookie 注入」）:
  3080 页面加载时用持久 secret（硬编码于注入脚本，见 TODO 的自动化改进项）经
  Web Crypto 动态签 30 天 `dsh-auth-*` cookie（v1.HMAC-SHA256 格式与
  dsh-client-connection 一致），检测到 401 纯文本页后延迟 `location.reload()`
  （延迟 400ms 因 init script 运行于 document_start、body 未就绪）。
- **验证**:debug 版经 UAC 启动实测——注入前窗口区域亮像素 4.4%（黑屏），注入后
  58.1%（DSH 界面正常）；窗口内容经 MiMo 视觉模型确认恢复会话视图。
- **触摸点**:`themes/src/00-boot.js`（运行时新增分片逻辑，经 build-init 重生成
  `src-tauri/injected/theme-init.js`）；`src-tauri` 需 `cargo build --release` 并
  用 `target/release/miasaki.exe` 替换 `dist/Miasaki.exe`（用户快捷方式目标）。
- **验证点**:双击 `Miasaki-dsh` 快捷方式 → 主窗口显示 DSH 会话页（无黑屏）；
  `pet.log` 出现 `asset-server listening` + `hash-diag`。

## 2026-09-05 · 修复:用量 Tab 映射对话页列宽调节（token-monitor v0.3.2）

依据:用户「用量界面会映射对话页面的对话框大小调节」。

- **根因**（查 DSH `dsh-client-ui-conversation` bundle 确认）:会话页两侧列宽拖拽
  手柄（`[data-width-handle]`，调对话页内容列 + 输入框宽度，持久化
  `localStorage dsh.conversation.contentWidth`，实测用户已拖到 760）与底部输入框
  都挂在 `ConversationRoot` / 滚动容器层——**视图区之外**，三个 Tab 共享；输入框
  卡片 `max-width` 派生自 `--dsh-chat-content-width`（= 拖拽偏好经
  `resolveContentWidth` 夹紧）。于是对话页拖宽 → 用量页输入框跟着变（映射），
  用量页两侧的隐形 `col-resize` 条误拖也会改写对话页列宽。
- **修复**（纯 client 半 CSS，v0.3.2）:用量 Tab 激活期间
  `[data-phase]:has(.tokmn-pane) [data-width-handle] { display:none }` 隐藏两侧
  手柄；`[data-conversation-scroll]:has(.tokmn-pane)` 重声明
  `--dsh-chat-content-width` / `--dsh-composer-card-max-width` 回 DSH 默认档
  `clamp(680px, 64% 列宽, 920px)`（表达式须与 ConversationRoot 回退值一致），
  输入框不再跟随拖拽偏好。style 随用量视图挂载/卸载，切走即整体恢复。
- **验证**:DevTools 实测注入——注入前 `contentW: 640px / composerMax:
  calc(640px+32px) / handles: 2`，注入后 `handles: ["none","none"] / cardW: 680`
  （默认档），选择器与变量链路全部生效；临时注入即删，未留残留。
- 触摸点:`plugins/dsh-token-monitor/{lib/client.js, package.json, README.md}`。
- 验证点:`node --check` 通过;Windows 机需 profile 目录重跑 `pnpm install`（或
  等价拷贝）+ 重启 host 后目检:用量 Tab 两侧拖拽条消失、输入框宽度不随对话页调节。

## 2026-09-05 · 官方 dsh 0.1.2-rc.1 适配（三插件 + canvas 盘点）

依据：官方 dsh 升至 0.1.2-rc.1（npm latest，本机 host 已更新），用户要求评估插件适配面。

- **逐项 API 对照结论（全部兼容，无需改代码）**：profile bundles / `dsh.bundle.patch`
  （insert 格式）、`dsh.client.platform: "web"` + `exports["./client"]`、
  `window.__ModuleLoader__.load`、`settings.get(ns)/update(ns, patch)`（新增可选
  `expectedRevision`）、`webServer.register({kind, path, handler})`、`sessions.get`、
  `sessionProjections.snapshot`（tokenUsage/contextPressure/contextBreakdown/sessionStats
  字段名逐一对上）、`tokenMeter.measure`、`llm/stream`（usage 字段）、`tools/result`、
  `~/.dsh/.agent-presets/*/agent.cordis.yml` 的 `agentOptions` 三行结构。
- **实测**：`/dsh-token-monitor/heatmap` 与 `/canvas/` 在 0.1.2 host 上 200 正常；
  `/freepool-api/status` 曾返回空平台列表，根因是 `llm-pi-ai` settings 节整体
  校验失败（0.1.2 `assertServiceable` 拒绝 catalog 不认识的模型 id 且路由未声明
  `api`/`baseURL`，opencode 平台首当其冲）→ llm-pi-ai 注册 fiber failed →
  `settings.get('llm-pi-ai')` 无记录。`settings.yaml` 中 opencode 已补
  `api: openai-completions` + `baseURL`，官方 schema 校验全绿；**host 重启后
  llm-pi-ai 重新挂载、免费模型池平台列表恢复**（watcher 不复活 failed fiber）。
- **变更**：三个插件 `peerDependencies` 对齐 `@deepseek-ai/cordis ^4.0.2`、
  `dsh-settings/dsh-host-webserver ^0.1.2-rc.1`；`@miasaki/dsh-canvas` 删除
  `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime"]`（0.1.2 已无此包，幽灵依赖）。
- **诊断脚本**（用后即删，未归档）：`_refs/scripts-archive/diagnose-llm-pi-ai-schema.mjs`、
  `repro-llm-pi-ai-mount.mjs`、`migrate-settings-llm-pi-ai.mjs` —— 用官方
  `llm-pi-ai` Config/apply 复现校验报错（opencode 模型缺 api/baseURL）。
- 验证点：profile 目录重跑 `pnpm install` + **重启 host** 后，GUI「设置 → 免费模型池」
  平台列表恢复 6 平台；「用量」Tab 与桌宠面板目检正常。

## 2026-09-05 · 修复:账本重启翻倍污染 + 账本重置（token-monitor v0.3.1）

依据:用户「用量显示有问题，数据失真」。

- **根因（唯一）**:`loadLedger()` 复用 `addToLedger()`，把磁盘载入的历史存量
  也塞进 `pending` 落盘队列，5s flush 后原样追加回 `usage-log.jsonl` ——
  **每重启一次 host，账本精确翻倍**（`addToLedger` 增 `toPending` 参数，
  载入路径传 `false` 只进内存聚合）。文件证据:全部 session 行呈精确 ×2ᵏ
  几何序列（如 55944→111888→223776→447552），与用户当天反复重启 host 的
  节奏吻合;旧会话行达千亿级即多次重启的指数重放。
- **排除项（查 dsh 源码确认，不改）**:`llm/stream` waterfall 下 DeepSeek 适配器
  的 `usage` chunk 在 `[DONE]` 哨兵处仅 yield 一次（每请求全量口径，`pendingUsage`
  覆盖式暂存），流式逐 chunk 累加语义无误;`TokenUsage` 各字段互斥
  （inputTokens=未缓存输入，billed input=三段之和），账本四段累加无双计。
- **配套**：新增 `POST /dsh-token-monitor/reset` 清空账本（内存 + 文件，
  限额保留）;UI「今日用量」卡标题行加「重置账本」按钮（confirm 确认，
  成功后立即刷 summary + heatmap）;热力图轮询 load 挂 ref 供重置后即时刷新。
- **数据修复**：被污染的 `usage-log.jsonl` 已删除（真实值不可恢复，
  config.json 不存在无损失）;重启 host 后从零重计。
- 触摸点:`plugins/dsh-token-monitor/{lib/index.js, lib/client.js,
  cordis.patch.yml, package.json, README.md}`;验证脚本同步扩展并归档
  `_refs/scripts-archive/test-token-monitor-v030.mjs`。
- 验证点:`node --check` 通过;mock 测试 33 项全过（新增「载入不回写：重启后
  文件行数稳定」与 reset 全链路「归零→保留限额→文件删除→从零重计」）;
  Windows 机需 profile 目录重跑 `pnpm install` + 重启 host 后目检数字回归合理。

## 2026-09-05 · 「用量」Tab 补全可视化（总览五卡 / 年热力图 / 每日趋势 / 模型用量占比，token-monitor v0.3.0）

依据：用户「热力图、趋势图、用量图什么的也都要有」（继续对照 ZCode 用量面板三截图）。

- **总览五卡**（ZCode 头部统计行同构）：累计 Token 数 / 峰值 Token 数（单日）/
  最长聊天时长 / 当前连续天数 / 最长连续天数；大数中文单位（7亿 / 3.3亿）。
- **Token 活动年热力图**（GitHub 风格，周一对齐 ~52 周、月标签在底部）：每日 /
  每周 / 累计三态切换（周/累计为客户端从每日数据推导的整周高格），品牌色分档
  深浅，悬浮富提示（日期 + tokens + 轮消息）。
- **时间范围（近 7 日 / 近 30 日，趋势与占比共用）**：每日 Token 趋势图为按模型
  多序列平滑曲线（Catmull-Rom→贝塞尔手写 SVG，图例点选显隐、悬浮十字 + 当日各
  模型明细，配色按 30 天总量排名分配、切范围颜色稳定）；模型用量环形图（中心
  范围总量 + 右侧模型列表 tokens/百分比）。全部纯 SVG/CSS，无新依赖。
- **账本扩展（host 数据面）**：保留窗 8 天 → 380 天（撑热力图年视图）、尾部解析
  4MB → 8MB；条目增 `calls`（当日实报次数 ≈ 轮消息）与 `type:'span'` 会话活跃
  跨度快照（min/max 合并、推进 ≥60s 才落盘 → 支撑「最长聊天时长」）；`/summary`
  增 `stats`（累计/峰值/跨度/连续天数），`trend` 扩为 30 天且每日带按模型明细
  （趋势图与环形图共用）；新路由 `GET /dsh-token-monitor/heatmap` 稀疏每日账单
  （client 60s 轮询，不拖累 3s 主轮询）。
- 原「近 7 天迷你柱图」移除（被大趋势图取代）；今日用量卡保留并加轮消息分项；
  上下文剩余 hero 与既有明细区顺延至可视化区块之后。
- 触摸点：`plugins/dsh-token-monitor/{lib/index.js, lib/client.js, package.json,
  README.md}`、`README.md`；一次性验证脚本归档
  `_refs/scripts-archive/test-token-monitor-v030.mjs`。
- 验证点：`node --check` 两文件通过；mock 测试 25 项全过（host 账本聚合 / 统计 /
  三路由 / 5s 节流落盘跨重启持久化 + client shim 空数据与造数两遍渲染）；Windows
  机需 profile 目录重跑 `pnpm install` + 重启 host 后目检三块新可视化。

## 2026-09-04 · 双线优化 P0–P2（运行时拆分 / 桌宠模块化 / Fleet 指示器）

依据：双线并进 + 中度重构 + 桌宠恢复 Fleet 指示器。

- **D1 注入运行时拆分**：`themes/runtime.js` 1100 行按序切 9 片
  `themes/src/{00-boot,01-persona,02-core,03-switcher,04-deco,05-sensors,06-titlebar,07-dialog-geom,08-ready}.js`
 （拼接与 legacy 逐字节一致）+ `src/README.md` 分片说明；
  `scripts/build-init.mjs` 按 `src/MANIFEST.json` 拼接，缺 src 时回退 legacy；
  `npm run gen-init` 与令牌校验已验证通过，产物语法 `node --check` 通过。
- **D2 桌宠模块化 + fallback**：`src-tauri/src/pet_native.rs` 转 facade，
  实现入 `src-tauri/src/pet_native/{config,ffi,image,model,persist,window}.rs`
 （`#[path]` 子模块，`main.rs` 零改动）；stub harness `cargo check` 零错误；
  新增 `Frames::kurumi_row` 回退链（请求行→idle→wave→jump→run→首个可用，
  修复旧代码回退后用请求行名重查致空白）+ whale/inverse 缺行回退 idle；
  单测 `fallback_chain` 通过。Windows 机仍需 `npm run tauri build` 终验（链接）。
- **D3 GDI 兜底 + smoke 三用例**：`present()` 改 `&mut`，ULW 连续失败计数
  （首失败 + 每 300 次日志，10 连败销毁表面）+ 表面无效每 ~30 compose 重试重建
  （`create/destroy_present_surface`，创建期复用同一函数）；`scripts/smoke-test.ps1`
  新增 §0b 三用例 WARN 预检（dsh 未安装/3080 被非 DSH 占用/单实例冲突，跨平台探针）。
- **D4 令牌漂移报告**：`scripts/diff-tokens.mjs`（`npm run tokens:diff`），
  缺失复述 + static 死覆盖告警（alias 融合引用单列忽略）；现况零缺失零死覆盖。
- **X2 Fleet 指示器**：`PetShared` 增 `fleet_running/fleet_alert` + `set_fleet`；
  `main.rs` 脉冲看门狗（环境变量 `MIASAKI_FLEET_PULSE`，2s 轮询 pulse v2，
  未设静默关闭）；compose 优先级 fleet 告警 > waiting > fleet 运行中 > busy > intensity
 （告警=failed 行 + NEED_APPROVE 常驻气泡，运行中=work 立绘 + BUSY 常驻气泡，
  kurumi 不原地跑步；指示期间禁散步）。联动契约见
  `dsh-miasaki-shared-docs/cross/ab-linkage-pulse-v2-2026-09-04.md`。
- 触摸点：`themes/src/`、`scripts/build-init.mjs`、`scripts/diff-tokens.mjs`、
  `scripts/smoke-test.ps1`、`src-tauri/src/pet_native.rs`、`src-tauri/src/pet_native/`、
  `src-tauri/src/main.rs`、`package.json`、`README.md`。
- 验证点：`npm run gen-init` + `node --check` 注入产物；harness `cargo check`
  零错误 + `cargo test fallback_chain` 通过；`npm run tokens:diff` 无漂移；
  fleet `node workers/validate-bus.mjs --strict` 通过；Windows 机补
  `npm run tauri build` + smoke 全绿 + 设变量后跑 pulse 看桌宠切换。

## 2026-09-03 · 优化:「用量」Tab 参照 ZCode 用量面板重构(UI + 数据面)

依据:用户「优化本项目'用量'页面,参考 zcode 的用量页面设计面板」。

- **设计语言对齐(ZCode 用量面板)**:由"已用视角"翻转为**剩余视角优先**——
  1. 上下文剩余 hero(大字号剩余% + 全宽分段条**分母 = contextWindow**(原实现
     以已用和为分母,看不到未使用段)+ 未使用图例;已用超窗时以已用和为分母、
     剩余归零);2. 阈值 45/75/95% 三档变色(success→brand→warn→error,ZCode 分档
     惯例);3. "更新于 HH:MM:SS" as-of 时间戳替代静态刷新文案。
- **数据面新增跨会话账本**(DSH 走 API Key 无配额接口,ZCode 的限额视角只能
  本地建账):host 半在 `llm/stream` 累计处双写——`ledgerDays`(内存聚合权威,
  仅最近 8 天)+ `pending`(增量);5s 节流追加写 `usage-log.jsonl`,`process.on('exit')`
  同步 flush 兜底;启动载入最近 8 天(文件 >4MB 只解析尾部、丢弃不完整首行)。
  账本与实时明细**同口径**(同为 chunk.usage 增量累计,不引入新偏差)。
- **限额配置**:`config.json`(`{dailyTokenLimit: number|null}`),新路由
  `GET|POST /dsh-token-monitor/config`(`{ok, error}` 包装对齐 dsh-free-model-pool);
  summary 路由向后兼容扩展 `ledger{today,trend,since}` + `config` 字段。
  数据目录优先宿主插件数据服务,否则 `~/.dsh/plugins-data/dsh-token-monitor/`。
- **UI 重构**(client 半,`tokmn-*` 令牌化):上下文剩余 hero → 今日用量卡
  (账本累计大数字 + 限额进度条/就地设置(K/M 单位) + 近 7 天纯 CSS 柱图,今日柱
  品牌色)→ 统计卡组 → 性能小卡(TTFT/解码耗时/解码速度 tok·s⁻¹/模型与工具耗时,
  由原独立小卡降级合并)→ 按模型明细/工具徽章(结构保留)→ 三通道口径脚注。
  舍弃成本估算(定价表易过时,用户确认不做)。
- 触摸点:`plugins/dsh-token-monitor/lib/index.js`、`lib/client.js`、
  `package.json`(v0.2.0)、`README.md`(插件+desktop 目录树注释)。
- 验证点:profile 目录重跑 `pnpm install`(file: 依赖不自动跟随源码)并重启
  host 后——hero 阈值色分档;发起对话 3s 内今日累计增长;设置/清除限额生效;
  `usage-log.jsonl` 行合法;**重启 host 后今日累计仍在**;趋势图 7 柱含今日;
  三主题 × 明暗无样式破损。

## 2026-09-01 · 修复:启动页左上角闪烁黑块

依据:用户反馈「启动页左上角闪烁黑块」。

- **根因**:标题栏 `::before` 模拟侧栏色块的回退色为深色 `#1e1a27`
  (`background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#1e1a27))`)。
  `--dsw-specific-sidebar-fill` 是 DSH 页面自身的令牌,DSH 样式加载完成前无值 →
  色块按回退色渲染成 280px×32px 深色块,悬在左上角;DSH 渲染完成后令牌生效变
  主题色 → 视觉上"闪烁黑块"(亮色主题尤其明显)。
- **修复**:
  - `themes/runtime.js`:`::before` 回退色改 `transparent`——DSH 令牌未就绪时
    不显示色块,DSH 渲染完成后色块与侧栏同时出现,无缝衔接;
  - `src-tauri/src/main.rs`:主窗口 `background_color` 随主题设置(kurkuriel 浅色
    #f7f4f1 / 其余深色 #0c0b11),页面加载期(loading → DSH 渲染完成前)底色不再
    是默认白底,消除深色注入层悬在白色页面上的反差闪烁。
- 触摸点:`themes/runtime.js`、`src-tauri/src/main.rs`、
  `src-tauri/injected/theme-init.js`(build-init 重新生成)。
- 验证点:重启桌面端(深/浅主题各试一次)——启动到 DSH 渲染完成的整个过程,
  左上角不再出现深色块闪烁,页面加载期无白底反差。

## 2026-09-01 · 修复:启动界面画面不统一（IS_LOCAL 判定回归）

依据:用户反馈「启动界面又出了小问题」。

- **根因**:`IS_LOCAL` 判定回归——2026-08-29 曾修复(Windows 上 Tauri 2 本地页
  协议为 `http://tauri.localhost`,单协议判定 `location.protocol === 'tauri:'`
  恒 false → 本地页出现重复标题栏 + 切换条,即当时的「画面不统一」),后于重构
  中丢失。回归后果:启动页被当作远程页,右下角主题切换条、主题水印、光晕、
  标题栏左侧 280px 模拟侧栏色块全部出现在启动画面。
- **修复**(`themes/runtime.js`):
  - `IS_LOCAL` 恢复 protocol + hostname 双重判定(`tauri:` / `tauri.localhost`);
  - `buildTitlebar` 不再因 IS_LOCAL 跳过(本地页同样需要拖动区与窗口按钮),
    本地页构建时打 `data-local` 标记,CSS 隐藏模拟侧栏/详情分隔线
    (`::before/::after`),标题栏保持纯净;
  - `buildSwitcher` 加 IS_LOCAL 拦截,巡检同步加条件(本地页无切换条);
  - 水印/光晕原有 IS_LOCAL 拦截恢复生效;`wireMaxState`/`requestMaxState`
    移出 `!IS_LOCAL` 块(本地页窗口按钮状态同样需要同步)。
- 触摸点:`themes/runtime.js`、`src-tauri/injected/theme-init.js`(build-init 重新生成)。
- 验证点:重启桌面端——启动画面仅标题栏(左侧无侧栏色块/分隔线)+ 居中纹章,
  无右下角切换条、无水印/光晕;标题栏三按钮同 SVG 线形、最大/还原同步;
  进入 DSH 页后装饰层完整(切换条/水印/光晕/侧栏色块)不受影响。

## 2026-09-01 · 修复:侧栏收起/展开时标题栏切换不连贯（帧级同步 + 过渡动画）

依据:用户反馈「左上角切换不连贯、视觉不统一」。根因:DSH 侧栏收起/展开是 CSS
动画,而标题栏几何此前靠 1s 巡检 + `display:none` 瞬间切换——动画播完文字才
突然消失/出现,节奏滞后且生硬。

- **ResizeObserver 帧级同步**:`syncTitlebarGeometry` 找到布局容器后,对首列元素
  (sidebarCol)挂 ResizeObserver——收起/展开动画期间轨道宽逐帧变化,RO 每帧驱动
  标题栏几何(`--ms-sidebar-w`/`--ms-details-left`/文字状态),与 DSH 动画完全
  同步;容器缓存(`_frameCache`,isConnected 失效重扫)避免动画期间每帧全量
  querySelector;1s 巡检降级为兜底(重建/重绑定/RO 不可用环境)。
- **文字过渡动画**:`#tb-theme`/`.tb-sub` 的收起态由 `display:none` 改为
  `opacity/max-width/margin` 过渡淡出(0.18s),原 `.tb-title` 的 flex gap 改为
  子元素 margin 承担(收起态 margin 归零,无残留空隙);prefers-reduced-motion
  下禁用过渡。
- **收起判定方向驱动**:RO 逐帧采样下,收窄方向第一帧即置 `data-sidebar-collapsed`
  (文字随收起动画同步淡出)、展开方向立即恢复(文字随展开动画同步淡入);无方向
  变化时按隐藏/归零/窄于 100px 稳态兜底。
- 触摸点:`themes/runtime.js`、`src-tauri/injected/theme-init.js`(build-init 重新生成)。
- 验证点:真机验证——收起侧栏时标题栏文字与侧栏动画同步淡出、展开同步淡入,
  色块分隔线逐帧贴合,无滞后跳变。

## 2026-09-01 · 修复:窗口按钮统一 SVG 化 + 最大化状态同步 + 侧栏收起判定加固

依据:用户反馈「左上角问题依旧」(排查为只重启旧 EXE——注入脚本编译期嵌入二进制,
未重建即不生效);另三个窗口按钮(–/□/✕ 字符)大小不一、视觉不统一。

- **按钮 SVG 化落地**:`TB_ICONS` 四枚 10×10 视口内联 SVG(stroke-width 1、
  currentColor、圆头端帽、Fluent 线形)——最小化=横线、最大化=圆角方框、还原=错位
  双框、关闭=对角叉;CSS 统一 `.tb-btn svg` 描边样式,三按钮视觉重量一致。
  2026-08-29 记录的「SVG 化」从未真正落地(远程页无 IPC 权限,wireMaxState 架构
  上走不通),本次按新通道重做。
- **最大化↔还原同步(新通道)**:远程页 capability 只授 start-dragging → 不走
  `__TAURI__` IPC,改 Rust eval 派发 CustomEvent `miasaki-max-state`(与桌宠状态
  推送同构):main.rs 新增 `push_max_state` + on_window_event Resized 150ms 防抖 +
  页面 load 后延迟推 + hash cmd=want-max 请求重推;runtime.js 监听事件切换图标,
  标题栏被重渲染重建/推送丢失时 10s 间隔请求兜底;非 Tauri 浏览器预览点击本地翻转。
- **侧栏收起判定加固(多信号)**:信号 A grid 轨道声明 / B 首列实测宽 / C
  `[class*="sidebar"]` 元素可见性,宽度采用 B>A>C(实测优先,含 0);收起判定 =
  C 隐藏或零宽 / 实测或轨道归零 / 窄于 100px(DSH 展开态侧栏 ≥100,固定阈值
  优于相对基线——用户拖窄侧栏不误判)。比单一轨道解析抗 DSH 布局演进。
- **可观测闭环**:hash diag 尾追加 `sidebarW.collapsed`,Rust watchdog diag 变化
  时落一行 `hash-diag` 日志 → 托盘「导出诊断」可见,同类问题可远程定位不再靠猜。
- 触摸点:`themes/runtime.js`、`src-tauri/src/main.rs`、
  `src-tauri/injected/theme-init.js`(build-init 重新生成)。
- 验证点:cargo check/build --release 通过;真机验证——三按钮同尺寸同粗细;最大化
  (点击/Win+↑/双击标题栏)后按钮变「还原」;收起侧栏左上角只留图标且色块对齐。

## 2026-09-01 · 修复:侧栏收起后标题栏主题文字与窗口栏不协调

依据:用户反馈 DSH 左侧边栏收起后,自绘标题栏左上角的主题名/副标题文字仍
横跨在窗口栏上,与收窄的侧栏区错位、观感不协调。

- **收起态藏字**:`syncTitlebarGeometry` 解析到侧栏轨道宽为 0 或窄于 120px
  (展开态默认 280px)时,给标题栏打 `data-sidebar-collapsed`,CSS 隐藏
  `#tb-theme`/`.tb-sub`,仅留 20px 主题图标;`::before` 模拟侧栏分隔线同步
  透明,与收起后的页面布局对齐。
- **几何残留修复**:轨道声明值解析去掉 `>0` 过滤(0px 直接应用)——此前侧栏
  收起为 0px 时 `--ms-sidebar-w` 残留旧宽 280px,标题栏侧栏色块与页面错位;
  首列实测兜底同样直接采用含 0 值。
- **图标悬浮提示**:标题栏徽记加 `title`(主题名 · 副标题),收起态文字隐藏后
  悬停图标即可知当前主题。
- 触摸点:`themes/runtime.js`、`src-tauri/injected/theme-init.js`(build-init 重新生成)。
- 验证点:桌面端重启后收起/展开左侧边栏——收起态左上角仅主题图标(悬浮见提示),
  展开态文字恢复;标题栏侧栏色块与页面侧栏始终对齐。

## 2026-08-30 · 新增:DSH 会话视图「用量」Tab(dsh-token-monitor 部署级插件)

依据:用户要求 DSH Web GUI 在「对话/轨迹」旁新增 token 监控入口(工具/模型/用量)。

- **动态插件探针 → 部署级插件落地**:先以动态 Cordis 插件(probe pkg-1..5,正式器
  pkg-6/7 UI)探明:① `llm/stream` options 含 sessionId/provider/model,chunk
  `{type,usage}` 实报 `inputTokens/outputTokens/cacheReadTokens/reasoningTokens`;
  ② `tools/result` exec.name/agent.id;③ 官方 `sessionProjections` 已有
  `tokenUsage/contextPressure/contextBreakdown/sessionStats` + `tokenMeter.measure`
  总口径(全历史、跨重启)。因 **dynamic list 槽条目 priority 由宿主强制分配且
  恒低于内置**(`allocatePriority: --nextPriority`,非 chain 槽不可覆盖),动态
  `conversation.view` Tab 恒排最左、无法经 order 置于轨迹右侧 → 定稿为
  **profile bundle 部署级插件**(与 ui-trajectory 同层,bundle 插件 priority 正常,
  order 15 生效于轨迹右侧)。
- **产物**:`plugins/dsh-token-monitor/` —— package.json(dsh.bundle.patch +
  dsh.client web)、cordis.patch.yml(insert)、host `lib/index.js`(llm/stream
  waterfall 透传包装 + tools/result + webServer 精确路由
  `GET /dsh-token-monitor/summary?sessionId=…` 返回官方聚合+实时明细)、
  client `lib/client.js`(手写 `window.__ModuleLoader__.load` bundle,主题令牌
  化 UI,3 秒轮询)。
- **接线**:`%USERPROFILE%\.dsh\profiles\web\package.json` dependencies+bundles 加
  `dsh-token-monitor`(file:),profile 目录 `pnpm install` 完成;**需 host 重启(重建
  web bundle 图)后生效**。
- **清理**:动态插件 `tokmn-1`(pkg-1..7)已 `cordis_stop`(定义保留以备回滚);与
  部署版同 id `token-monitor` 的重复注册冲突已消除。
- 触摸点:`plugins/dsh-token-monitor/`(新增)、
  `%USERPROFILE%\.dsh\profiles\web\package.json`、README.md(目录树+插件章节)。

## 2026-08-30 · 优化:桌宠边缘噪点修复 + 总指挥工作动态 + 权限申请提示

依据:用户「桌宠边缘有噪点,也不显示工作状态或提示权限申请」。

- **噪点根因**(已核实源码,见 `dsh-miasaki-shared-docs/cross/ab-linkage-pet-fleet-status-2026-08-18.md` 现状盘点):
  1. 运行时 `pet_native.rs` 对像素**零过滤**(`a>0` 即上屏,`load_png` 整数预乘截断 ≤1 级偏暗);
  2. 素材端清理粗糙:`cut-frames.mjs` kurumi 切格完全不清理、whale `stripGreenEdge`
     只杀绿色主导像素(非绿色半透明光晕满 alpha 残留);
  3. `inverse-states.mjs` 人造 2px alpha=150 环带且颜色是残留底色(噪点本体);
  4. 叠加 `blit_center_bottom` 非整数最近邻缩放(208→270 ×1.298)把单点杂色撕成锯齿簇,
     inverse 540→270 隔行丢弃破坏抗锯齿。
- **修复**:
  - 素材端治本(`scripts/cut-frames.mjs` + `scripts/inverse-states.mjs`):新增共用
    `despeckle(buf)` —— `a<24` 阈值 + `0<a<128` 像素 8 邻域无强前景(a≥128)→ 0
    (杀散点本体+半透明光晕浮雾);kurumi/whale 接入 despeckle(whale 串在
    `stripGreenEdge` 之后);inverse 环带 2px→1px、颜色取邻近前景均值替代残留底色,
    despeckle 兜底。重跑 `node scripts/cut-frames.mjs` + `node scripts/inverse-states.mjs`。
  - 运行时保险(`src-tauri/src/pet_native.rs`):`load_png` 加 `a<8 → 0` 兜底,
    预乘改四舍五入 `(c*a+127)/255` 消除 ≤1 级偏暗;`blit_center_bottom`
    最近邻→**预乘空间双线性采样**(中心对齐源坐标,4 邻域按权重混合预乘值,数学上
    正确且 ULW 兼容),对 kurumi/whale ×1.298 放大起平滑、对 inverse 540→270
    等效 2×2 均值下采样保住边缘抗锯齿。
  - **总指挥工作动态 + 权限申请提示**:
    - 范围:桌宠**只反映 DeepSeek 总指挥(主会话)** 的工作动态,agent 员工状态
      后续归 `dsh-miasaki-fleet/fleet-monitor/` 工作面板。
    - `themes/runtime.js`:新增 `scanActivity()`(查找"停止生成"按钮 → 'busy')和
      `scanApproval()`(在 dialog/modal/approve 容器内同时存在"允许"+"拒绝"类
      按钮 → true);act 防抖 2 次连续确认、wait 出现立即上报/消失 2 次确认;
      `syncHash` 拼 `&act=Z&wait=0|1` 字段;**临时探针** `window.__miasakiProbe()`
      输出当前候选按钮文本便于 Operator 校准选择器。
    - `scripts/gen-bubbles.ps1`:台词池尾部追加 3 帧状态文案("忙碌中…"/"等待审批"/
      "需要你的批准"),`bubbles.png` 17→20 帧。
    - `src-tauri/src/pet_native.rs`:`PetShared` 增 `activity`/`waiting_approval` 字段;
      `NativePet` 增 `set_activity()`/`set_waiting_approval()`;`compose` 映射优先级
      **waiting > busy > intensity** —— waiting 强制 kurumi `wait` 行 / whale·inverse
      `work` 立绘 + **常驻"等待审批"气泡**(状态帧跳过 3s 过期),禁止 ambient/wander;
      waiting 中单击桌宠 = 唤起主窗口(跳过 hop,免破坏等待观感)。
    - `src-tauri/main.rs`:`parse_fragment` 增 `act=`/`wait=` 解析;
      `start_hash_watchdog` 分发到 `set_activity`/`set_waiting_approval`。
- **构建验证**:`cargo build --release --offline` 27.52s 通过,启动 Miasaki 8s
  验证进程存活 + 桌宠窗口创建 + 帧加载(`whale_states=3, kurumi_rows=6`),
  hash 通道 `set_mode whale` + `set_intensity idle` 正常;runtime.js 解析+执行验证通过。
- **待真会话校准**(用户/Operator 跑时):console 执行 `__miasakiProbe()` 看
  `act=`/`wait=` 候选按钮文本是否匹配,按需微调 `ACT_BTN_TEXT` / `APPROVE_TEXT` /
  `DENY_TEXT` / `APPROVE_CONTAINER_SEL` 常量(集中在 runtime.js 顶部)。
- 触摸点:`scripts/cut-frames.mjs`、`scripts/inverse-states.mjs`、
  `scripts/gen-bubbles.ps1`、`ui/pets/**`(重生成产物)、`themes/runtime.js`、
  `src-tauri/src/pet_native.rs`、`src-tauri/src/main.rs`。
- 后续阶段:桌宠内一键审批(Rust→JS eval 点页面"允许"按钮,通道现成;依赖
  当前校准的选择器) + 员工状态监控(fleet-monitor 工作面板增强),本期仅留接口。

## 2026-08-30 · 修饰:软件图标倒角改圆润（直角 → 圆角矩形）

依据:用户「把软件图标倒角改圆润点」。

- **根因**:`scripts/make-icons.mjs` 的应用图标段(icon-new.png → app-icon-source.png /
  app.png)只有 resize,无任何圆角处理——全套图标(icon.png 512 实测四角 alpha 全 255)
  为纯直角方形,Windows 任务栏/桌面呈现生硬。
- **修复**(`scripts/make-icons.mjs`):新增 `roundedRectMaskSvg(size, ratio)` 圆角矩形
  蒙版(默认半径 24% 边长,≈ Windows 11 风格更圆润,可调),应用图标两处输出
  (1024 `app-icon-source.png`、128 `ui/icons/app.png`)均经 `dest-in` 蒙版合成,
  四角透明;主题徽章(pure/zafkiel/inverse)本就是圆形裁切,不受影响。
- **全链路重生成**:`node scripts/make-icons.mjs` → `npx tauri icon
  src-tauri/app-icon-source.png` 重生成全套(`icon.ico`/`icon.icns`/32-256 png/
  StoreLogo/Square*/ios/android)。
- 触摸点:`scripts/make-icons.mjs`、`src-tauri/app-icon-source.png`、
  `src-tauri/icons/*`(全套)、`ui/icons/app.png`。
- 验证点:四角 alpha 校验通过(icon.png/128/32/app.png center=255、corners=0);
  重新 `npm run tauri build` 后 EXE/安装包/加载页图标均为圆角。

## 2026-08-29 · 修复:右上角关闭按钮无反应（cmd 名不匹配 + 关闭弹窗模块丢失）

依据:用户「桌面端右上角关闭没反应」。

- **根因(双断点)**:
  1. `themes/runtime.js` 标题栏关闭按钮发送 `cmd=exit`,而 Rust 侧
     `start_hash_watchdog` 的 match 只有 `"close" => request_close` 分支,
     `exit` 落入 `_ => {}` → 无任何反应;
  2. 前端关闭确认弹窗模块(`buildCloseDialog` + `window.__miasakiOpenCloseDialog`)
     在 11:33→14:04 的重构中整体丢失——Rust `request_close` 经
     `eval("window.__miasakiOpenCloseDialog && ...()")` 唤起弹窗,函数不存在 → 弹窗不出。
     现状为"点 X 完全静默"。
- **修复**(`themes/runtime.js`):
  - 标题栏按钮 `petHashCmd('exit')` → `petHashCmd('close')`(与 Rust match 对齐);
  - 从 debug EXE(11:33 构建版)提取并恢复完整弹窗实现:弹窗 CSS
    (`#miasaki-close-mask`/`#miasaki-close-dialog` 主题自绘)、
    `buildCloseDialog()`(取消/确认按钮、mask 点击关闭)、
    `window.__miasakiOpenCloseDialog` 导出(本地页确认走 invoke `shutdown`,
    失败回退 hash 通道;远程页走 hash `cmd=shutdown`);
  - onReady 无条件构建弹窗(本地唤醒页 Alt+F4 同样可用),1s 巡检补
     `#miasaki-close-dialog` 重建。
- 触摸点:`themes/runtime.js`(→ `npm run gen-init` 后 `src-tauri/injected/theme-init.js`,
  → 重编 EXE 并同步 `dist/Miasaki.exe`)。
- 验证点:重启桌面端后点右上角 X → 弹出「关闭 Miasaki?」弹窗(随主题配色)→
  取消仍在运行 / 确认后 DSH 停止 + 应用退出;Alt+F4 与托盘退出同路径。

## 2026-08-29 · 修复:反转狂三主题图标裁切失真（立绘换版后固定窗口失效）

依据:用户「dist 下 exe 打开的反转狂三图标有问题」。

- **根因**:`scripts/make-icons.mjs` 的 inverse 图标按旧立绘尺寸假设取
  「中上部 92×92」固定窗口;8-23 反转狂三立绘换成 332×540 的 Q 版全身构图后
  窗口失效,图标只裁到脸的中上一条(缺头顶/下巴/肩部),13:16 生成起即失真。
- **修复**(`scripts/make-icons.mjs`):自适应头部定位两代迭代——
  初版按全图亮区(lum>90)bbox 定位,但被衣服高光拉满整幅
  (side clamp 成全宽、top=97 → 头顶整段被切,用户复报);
  最终版改为**仅在立绘顶部 35% 高度内统计 alpha bbox 与最大行宽**——
  方形窗口以该 bbox 居中、顶边取内容起始(留 1% 余量)、宽含发梢
  (本次实测:窗口 left=56 top=1 side=228 → 头顶/双眼/下巴/肩部完整入徽章);
  检测失败时显式抛错(不产出静默坏图)。
- 触摸点:`scripts/make-icons.mjs` → `ui/icons/theme-inverse.png`(已同步
  `dist/ui/icons/theme-inverse.png`;图标经素材服务读磁盘/内嵌,无需重编桌面端)。
- 验证点:重启桌面端后切换狂狂帝,右下角按钮与面板图标显示完整头部徽章;
  pure/zafkiel 图标不受影响(其源图尺寸未变)。

## 2026-08-29 · 素材内嵌:图标与桌宠帧编译期打进 EXE（无需再外置 ui/）

依据:用户「这些图标素材必须外置吗」。

- **改造**:素材读取从「仅磁盘 ui/(EXE 旁)」改为**磁盘优先 + 内嵌兜底**——
  - `build.rs`:构建时扫描 `ui/` 生成 `src/assets.rs`(build.rs 产物,gitignore),
    以 `include_bytes!` 内嵌运行时素材全套:icons(pure/zafkiel/inverse/app)、
    `pets/frames.json`、`pets/bubbles.png`、kurumi 63 帧、whale/inverse 立绘 11 帧
    (共 76 项,EXE 增加约 6MB);
  - `main.rs` 素材服务(39800)与 `pet_native.rs` 的桌宠帧加载统一走
    `assets::read()`:先读 EXE 旁 `ui/`,无则回退内嵌;
  - dist/NSIS 安装布局(EXE + ui/)不受影响(磁盘仍在;单文件拷贝 EXE
    图标/桌宠素材完整,不再强制外置)。
- 触摸点:`src-tauri/build.rs`、`src-tauri/src/main.rs`、`src-tauri/src/pet_native.rs`、
  `.gitignore`(ignore `src-tauri/src/assets.rs`);产物 `dist/Miasaki.exe` 已更新。
- 验证点:单拷 `dist/Miasaki.exe` 到任意空目录启动——主题按钮图标、标题栏徽记、
  桌宠三形态帧与气泡全部正常(此前图标/桌宠素材 404 全部缺失)。

## 2026-08-29 · 修复:主题切换条巡检重建死锁（按钮消失后无法自愈）

依据:用户「桌面端右下角主题切换按钮到底怎么回事」。排查确认用户当日实际运行的是
11:33 构建的 debug EXE,其内嵌脚本仍是「title 内嵌」坏版(HTML 字符串拼接 `title="…"`
属性,在真实 Chromium 中使 `switcher.innerHTML = html` 抛
`TypeError: html is not a function`,被 onReady 的 try/catch 吞掉后切换条整体消失,
该坏版已由 14:04 修复产物 + 14:05 release EXE 取代,但用户尚未验证新 EXE)。

- **根因(本次修复)**:`buildSwitcher()` 开头 `if (switcher || !document.body) return`。
  switcher 元素一旦被页面重渲染移除(或构建中途抛错、元素未挂载),`switcher` 变量
  仍非空 → 1s 巡检发现 DOM 无 `#miasaki-switcher` 调 `buildSwitcher()` 时直接 return,
  **永远无法重建**,按钮永久消失直到页面刷新。
- **修复**(`themes/runtime.js`):判断标准从「变量非空」改为「真实挂载」——
  `if (switcher && switcher.parentNode) return`。元素被移除后 parentNode=null,
  巡检下一轮即可重建;构建中途抛错时(新元素未挂载)同样可重试,不再死锁。
- 触摸点:`themes/runtime.js`(→ `npm run gen-init` 后 `src-tauri/injected/theme-init.js`)。
- 验证点:`gen-init` 令牌校验通过;需重新构建 EXE(`npx tauri build --bundles nsis` 或
  `cargo build --release`)后验证:DSH 页右下角按钮出现;若页面重渲染移除按钮元素,
  1s 巡检应自动重建(此前为永久消失)。

## 2026-08-29 · 标题栏窗口控制按钮图标优化（SVG 化 + 最大化状态同步）

依据:用户「优化一下桌面端右上角最小化最大化关闭图标」。

- **根因(旧实现)**:三个按钮用 Unicode 字符(– / □ / ✕)当图标——en-dash 偏细偏短、
  `□` 实心方块块面感过强、`✕` 笔画粗细不可控,三者字形基线不一致、风格不统一;
  且最大化按钮无状态区分,窗口最大化后仍显示「最大化」方框。
- **修复**(`themes/runtime.js`):
  - 新增 `TB_ICONS` 常量:四枚内联 SVG(16×16 视口,`currentColor` 描边、圆头端帽,
    Windows 11 Fluent 线形)——最小化=水平短线、最大化=矩形+加粗顶边、
    还原=双框错位(右上后框+左下前框)、关闭=X 交叉线;按钮 hover 变色自动跟随主题。
  - **最大化↔还原状态同步**:`wireMaxState()` 经 `window.__TAURI__.window.getCurrentWindow()`
    的 `onResized`(120ms 防抖)+ `isMaximized()` 驱动图标切换——双击标题栏、
    Win+↑ 等系统路径改变窗口状态同样同步,而非仅凭自己的点击;监听仅注册一次,
    标题栏被页面重渲染重建(1s 巡检)后 `syncMaxBtn()` 立即补查真实状态,图标不丢失。
  - 非 Tauri 环境(普通浏览器调试预览)点击最大化按钮时本地翻转图标兜底。
- 触摸点:`themes/runtime.js`(→ `npm run gen-init` 后 `src-tauri/injected/theme-init.js`)。
- 验证点:`node scripts/build-init.mjs` 令牌校验通过;sharp 渲染四态图标(常规/hover/
  close-hover)目检线条粗细一致、还原图标错位形态正确;构建 EXE 后窗口最大化时
  按钮显示「还原」图标,还原后回「最大化」。

## 2026-08-29 · 软件图标更换:DeepSeek 娘(用户提供图)

依据:用户「用这个做软件图标」+ 附 DeepSeek 娘立绘(960x960,底部黑底
「DeepSeek」文字条),选择「裁掉文字条,聚焦人物」方案。

- **源图处理**(一次性,`_refs/prepare-icon.mjs`):黑条从 y~808 起 → 裁
  `(left:154, top:0, 806x806)` 方形主体(内容中心 570 / 方形中心 557,构图
  基本居中;比耶手势右缘 941 完整保留),lanczos3 放大 1024x1024 写入
  `src-tauri/icon-new.png`(旧「时钟蔷薇」艺术图仍在 git 历史,可回退)。
- **全链路重生成**:`node scripts/make-icons.mjs`(icon-new.png →
  `app-icon-source.png` + `ui/icons/app.png` 128 加载页图标)→
  `npx tauri icon src-tauri/app-icon-source.png` 重生成全套
  (`icon.ico`/`icon.icns`/32-256 png/StoreLogo/Square*/ios/android)。
- **安装包图标**:`tauri.conf.json` 新增 `bundle.windows.nsis.installerIcon`/
  `uninstallerIcon`(均指向 `icons/icon.ico`)——原先 NSIS 安装包默认用
  NSIS 自带图标,首轮构建验证时发现后补齐。
- 触摸点:`src-tauri/icon-new.png`、`src-tauri/app-icon-source.png`、
  `src-tauri/icons/*`(全套)、`src-tauri/tauri.conf.json`、`ui/icons/app.png`。
- 构建说明:本机 MSI 打包(light.exe)因 Windows Installer 服务访问受限失败,
  改用 `npx tauri build --bundles nsis` 产出安装包(已验证)。
- 验证点:重新 `npm run tauri build` 后,EXE/安装包/加载页标题栏图标均为
  DeepSeek 娘;小尺寸(32px)下人物聚焦、无文字黑带残留。

## 2026-08-29 · 桌面端:修复右下角主题切换条悬浮介绍全部相同

依据:用户「右下角选择主题模式鼠标悬浮介绍都是鲸鱼娘主题的介绍」。

- **根因**:`themes/runtime.js` 的 `buildSwitcher()` 为每个主题选项 `.ms-opt` 渲染
  名称/副标题,但未设置各自 `title` 属性;而 `refreshSwitcher()` 给整个
  `#miasaki-switcher` 设置 `title = TIPS[current]`(当前主题提示)。浏览器 hover
  无 `title` 的子元素时向上取最近祖先前缀 → 三个主题选项悬浮提示全部显示
  **当前主题**(如 pure/鲸鱼娘)的一句文案,看起来"都是鲸鱼娘主题的介绍"。
  **注意**:曾尝试在 HTML 字符串内嵌 `title` 属性,但在完整内联主题 STYLES
  环境下会使 `switcher.innerHTML = html` 抛 `TypeError: html is not a function`
  (真实 Chromium 复现;构建失败被 try/catch 吞掉,1s 巡检因 `switcher` 变量
  已占位无法重建 → 切换条整体消失)。最终实现改在 DOM 构建后 `setAttribute` 设置。
- **修复**:
  - 每个 `.ms-opt` 在 `switcher.innerHTML` 赋值后经 `setAttribute('title', …)`
    设置独立提示(缺失回退 `META[t].name · META[t].sub`),
    hover 选项时原生悬浮提示显示该主题自己的介绍;
  - 面板底部 `.ms-tip` 增加 hover 联动:`mouseenter` 显示对应主题提示、
    `mouseleave` 恢复当前主题提示(`TIPS[current]`);
  - 切换条整体 `title`(按钮/空白区)仍为当前主题提示,行为不变。
- 触摸点:`themes/runtime.js`(→ `npm run gen-init` 后 `src-tauri/injected/theme-init.js`)。
- 验证点:真实 Chromium(Edge 151 headless)加载构建产物,`#miasaki-switcher`
  构建成功且三选项 `title` 分别为「原版 DSH · 简约纯净」/
  「ふふふ,今晚的时间也属于我呢」/「选好了吗?我讨厌犹豫的人」,
  不再全部是当前主题的介绍;桌面端 EXE 构建部署后同效。

## 2026-08-29 · 修复:桌宠显隐切换条件反转（边缘杂色跳动 + 日志刷屏）

依据:用户现场「桌宠边缘有杂色跳动」。

- **根因**:显示/隐藏切换比较条件写反 —— `want_hide != self.shown` 应为
  `want_hide == self.shown`。初始态(want_hide=false 想显示 / shown=true 已显示)
  语义一致但布尔不等 → 进入分支,每 33ms tick 重复执行 ShowWindow +
  UpdateLayeredWindow(dirty 置位) + pet.json 原子写 → 分层窗口高频重提交,
  合成器边缘出现杂色抖动;pet.log 同步刷屏(每秒 ~30 行「shown (hide persisted)」)。
  切换后的 `self.shown = !want_hide` 幂等(不再变化),故日志只有 show 无 hide,
  无用户操作也持续触发。
- **修复**:条件改为 `want_hide == self.shown`(目标隐藏态==实际显示态才需切换,
  含 (true,true)=想藏但已显、(false,false)=想显但已藏 两种)。
  JS 状态机模拟验证:修复前 10/10 tick 触发,修复后稳定 0 触发;隐藏操作只切 1 次且结果正确。
- 触摸点:`src-tauri/src/pet_native.rs`(compose 命令消费块)。

## 2026-08-29 · 桌面端:桌宠位置屏外修复 + 设置面板(设置 → 桌宠)

依据:用户「桌宠没启动,而且应该在设置里有桌宠设置选项」。

- **「桌宠没启动」根因定位**:桌宠窗口实际随应用正常创建(pet.log
  `window created at 2902,930`),但位置保存在 `pet.json` → 屏幕 2560×1440 下
  (2902,930) 完全位于屏幕外(显示器布局变化/历史遗留坐标),用户看不到。
- **位置可见性校验**(`pet_native.rs`):新增 `EnumDisplayMonitors` +
  `GetMonitorInfoW` FFI 枚举全部显示器工作区;`initial_pet_state()` 要求位置
  中心点落在任一工作区,否则回默认 (1200,500) 并保留隐藏设置,pet.log 记录回退。
- **pet.json 版本化 v1**:`{version:1, x, y, hide}` + 原子写(temp+rename);
  损坏/版本不符 → 全部默认重建(不静默零值,兑现 bootstrap-reliability.md §4.1
  遗留项);`hide` 持久化,重启保持隐藏状态,恢复时圆点可见、可点击显示。
- **显隐/重置命令统一到窗口线程**:右键菜单「隐藏桌宠」与面板命令只写
  `PetShared` 标志,UI 切换 + pet.json 落盘由 compose(窗口线程)消费执行,
  避免多线程 user32 调用;`PetWin` 增加 `shown` 镜像字段。
- **hash 通道扩展**(`main.rs`):`cmd=pet-show/pet-hide/pet-reset/pet-state`;
  新增 `push_pet_state()` 经 eval 下发 `miasaki-pet-state` CustomEvent(状态回显)。
- **新增 DSH bundle `plugins/dsh-pet-panel/`(桌面端设置面板)**:
  settings.section「桌宠」(order 26,client bundle 手写 `__ModuleLoader__` 格式):
  显示/隐藏开关、位置重置、状态回显;非桌面端(无 `window.__MIASAKI_BOOTED__`)
  降级提示。host 侧空壳(职责全在 hash 通道);安装入
  `%USERPROFILE%\.dsh\profiles\web\package.json`(dependencies + bundles)。
- 触摸点:`src-tauri/src/pet_native.rs`、`src-tauri/src/main.rs`、
  `plugins/dsh-pet-panel/`(新增)、`%USERPROFILE%\.dsh\profiles\web\package.json`、
  `README.md`、`design/TODO.md`。
- 验证点:重启桌面端后桌宠出现在默认位置(而非屏外空窗);设置 → 桌宠
  (host 重启后生效):开关隐藏/显示(重启保持)、位置重置回到 (1200,500)、
  右键菜单显隐与面板状态一致;桌宠拖到屏外后重启自动回默认。

## 2026-08-29 · 桌面端:关闭确认弹窗 + 启动画面主题统一

依据:用户「桌面端启动画面需要优化,画面不统一」「关闭桌面端应弹窗提醒是否关闭应用,选择关闭应用
应该同步关闭后端」。

- **关闭确认弹窗(主题自绘,所有关闭入口收敛)**:标题栏 X / 系统关闭(Alt+F4)/ 托盘「退出」/
  桌宠右键「退出应用」统一走 `request_close` → 唤起主窗口并显示确认弹窗(`runtime.js` 注入
  `#miasaki-close-dialog`,色板随三主题 `--ms-*` 变量)。「关闭应用」→ hash `cmd=shutdown`
  → `shutdown_app`:**停止由桌面端拉起的 DSH 后端**(按 spawn 时记录的 PID `taskkill /T /F`
  杀进程树)再退出;「取消」仅收起弹窗。非本应用拉起的后端(用户手动 `dsh web` / 端口已在运行
  时接入)不触碰。兜底:仅 Alt+F4 连击(5s 内二次系统关闭,前端无响应)强制退出(不杀后端,服务保持)。
- **启动画面统一**:
  - `loading.html` 移除自带标题栏(`.tb`),统一由 `runtime.js` 构建 `#miasaki-titlebar`
    (本地唤醒页与 DSH 页同款画面);本地页不再构建切换条/水印/光晕,保持启动画面简洁。
  - 修复 `IS_LOCAL` 判定:Windows 上 Tauri 2 协议为 `http://tauri.localhost`,
    原 `location.protocol === 'tauri:'` 恒 false → 本地页出现重复标题栏 + 切换条
    (这正是「画面不统一」);现以 protocol + hostname + pathname 三重判定,并修正巡检
    在本地页重建切换条的问题。
  - 启动画面随主题换肤:主题偏好由 DSH 页 hash 通道同步 Rust 落盘
    `%APPDATA%\com.miasaki.desktop\prefs.json`(原子写),启动时经 `__MIA_THEME__` 注入
    initial script;`loading.html` 按 `html[data-miasaki-theme]` 渲染三套色板 + 主题纹章
    (刻刻帝钟面 / 狂狂帝破裂表盘 / 原版简约环)。
- **命令收敛**:移除 `exit_app` / `minimize_main`(标题栏按钮改走 hash `cmd=close` / `min`);
  hash `cmd=exit`(直接退出)移除,防绕过确认。
- **素材服务提前**:`start_asset_server` 移至 setup 开头(启动页标题栏图标同源加载,防 404 竞态)。
- 触摸点:`themes/runtime.js`、`ui/loading.html`、`src-tauri/src/main.rs`、
  `src-tauri/src/pet_native.rs`、`src-tauri/injected/theme-init.js`(构建产物)、
  `README.md`、`design/themes.md`。
- 验证点:标题栏 X → 弹窗(随三主题配色)→ 取消仍在运行 / 确认后 DSH 停止 + 应用退出;
  DSH 页切换主题后重启桌面端,启动画面同主题;托盘、桌宠退出弹窗同路径;本地页无切换条。

## 2026-08-24 · 启动可靠性(Bootstrap Reliability)第 1 部分

依据:`design/bootstrap-reliability.md`(设计定稿,借鉴 deepseek-harness-desktop 的
启动恢复/健康标记/可靠性矩阵思路)。

- **bootstrap.json 健康标记(v1)**:`%LOCALAPPDATA%\miasaki\bootstrap.json`,记录每次启动的
  `lastAttempt{at,phase,detail,dshAvailable}` 与 `lastOk`;阶段流水
  bootstrap → spawn(失败,语义化错误) → waiting(3s 低频心跳) → up(3080 页面加载成功);
  90s 未就绪仅提示一次(端口占用排查指引)。损坏/版本不符 → 删除重建默认(不猜不静默)。
- **失败恢复页(loading.html)**:失败时显示恢复动作组——检查 dsh / 打开终端 / 打开日志目录 /
  导出诊断;页面初始化读取上次启动状态,上次失败(spawn/waiting)会提前提示且不阻塞本次启动;
  上次成功显示「已进入」时间。恢复动作仅本地页可 invoke(远程 3080 页受 remote-dsh.json 限制,不暴露)。
- **dsh 安装检测**:spawn 前 `where dsh` 探测 → 未安装时提示安装指引(而非笼统的"启动失败")。
- **重试换代修复(既有 bug)**:原「重试」按钮在 spawn 失败后实际无效(LAUNCHING 已置位且旧循环
  不再 spawn);引入 `BOOTSTRAP_GEN` 代际计数,retry 时换代,旧序列检测到代际变化退出,
  新序列完整重跑(bootstrap/spawn/探活)。
- **导出诊断**:聚合 server.log/pet.log 尾部(各 ≤512KB)+ bootstrap.json + window.json + pet.json
  + OS 信息 → `%APPDATA%\com.miasaki.desktop\diagnostics-<ts>.txt`(只读副本,不触碰原日志)。
- **原子写铁律落地**:bootstrap.json 与 window.json 均改为 temp+rename(原 window.json 直接
  `fs::write`,崩溃/断电可半写)。
- 触摸点:`src-tauri/src/main.rs`、`ui/loading.html`、`design/bootstrap-reliability.md`(新增)、
  `design/TODO.md`、`README.md`。
- 验证:`cargo check --offline` 通过;`gen-init` 令牌校验通过;loading.html 内嵌 JS 语法检查通过。
  真机待验:三条失败用例 + 正常启动回归(见设计文档 §6 验收标准)。

## 2026-08-22 · DSH 插件:免费模型池(Free Model Pool) v0.2 — 多平台扫描 + 能力画像

依据:用户要求「以后可能不仅 OpenRouter,其他平台也会有」+「边界明确:这些模型能干什么、
适合干什么,都要快速分析决策怎么使用」。

- **多平台化**:扫描对象从写死 OpenRouter 改为 `llm-pi-ai.providers` 中**所有带 baseURL 的
  OpenAI 兼容平台路由**;detect/apply/subagent 全部带 `platform` 参数,新平台配置后自动出现,
  零插件改动。status 返回平台列表(displayName/endpoint/apiKeyEnv/configuredCount)。
- **免费判定分层**:`:free` 后缀 → pricing 全零 → 名称含 免费/free;三层任一命中即收录,
  避免单规则漏检(真实 OpenRouter 列表:17 个 `:free` + 零定价预览 2 + `openrouter/free`
  特殊路由 1 = 21)。实测无误报付费模型。
- **能力画像 `analyzeModel`**:从端点自述提取 工具调用/tool_choice/推理/编码/视觉/结构化输出/
  超长上下文/预览标记,产出三档 verdict:
  `首选(复杂|编码|多模态)子代理` / `可用:通用子代理` / `仅问答、批处理(无工具调用)` /
  `需实测验证(有 tools 无 tool_choice)`;warnings 标出 缺 tool_choice/预览模型/输出上限低/上下文小。
  子代理门槛 = tools + tool_choice(DSH agent loop 依赖工具循环)。
- **决策摘要 summary**:bestAgent(评分排序首位)/codingAgent/longContextAgent/visionAgent
  (仅子代理可用者计)/agentCount/qaOnly;面板顶部直接呈现,子代理切换默认推荐最佳。
- 判定原则:画像从端点自述而非 benchmark ELO,无自述者标「元数据缺失」而非猜测。
- **持久化机制修正**:pnpm `file:` 依赖按包版本缓存 store 副本,改源码后 `pnpm install`
  不会刷新(实测 DIFF);需 `--force` 或直接复制 `lib/*` 到 node_modules 并核对哈希;
  本版随功能升 0.2.0 并同步部署副本。
- 验证:离线冒烟(fake hub:三免费标记、付费不误报、canAgent/code/vision/tools-only 四类画像、
  排序与摘要语义)全 PASS;真实 OpenRouter 审计 21 模型 verdict/warnings 全部一致,无误报。
- 触摸点:`plugins/dsh-free-model-pool/lib/index.js`(analyzeModel + 多平台路由)、
  `lib/client.js`(平台选择器 + 画像行 + 摘要块)、`lib/index.d.ts`/`lib/types/detect.d.ts`、
  `package.json`(0.2.0)、`README.md`。

## 2026-08-22 · DSH 插件:免费模型池(Free Model Pool)

依据:用户在 DSH web 会话「配置聚合平台API检测免费模型」需求——从聚合平台(OpenRouter)
检测免费模型并用于子代理,首轮手工落地(settings.yaml 注册 openrouter 路由 + 预设
agentOptions),本轮把该能力固化为可重复使用的 DSH web profile bundle。

- **`plugins/dsh-free-model-pool/`(新增)**:host 插件 + 手写 client bundle 的 DSH bundle 包。
  - 面板:DSH「设置 → 免费模型池」(settings.section, order 25),
    检测结果列表(含 ctx/maxTokens)、写入全部/单个模型、一键切换子代理后端。
  - host 路由(webServer 注册,client 浏览器同源 fetch):
    `GET /freepool-api/status`(读 llm-pi-ai openrouter 配置)、
    `GET /freepool-api/detect`(拉 OpenRouter /v1/models,`:free` 后缀 + pricing 全零判定)、
    `POST /freepool-api/apply`(settings.update 深合并,保留其他 provider/字段,写入 openrouter.models)、
    `POST /freepool-api/subagent`(重写三预设 tool-subagent/tool-subagent-fork 的 agentOptions)。
  - 通信选型:client bundle 无动态 runner 的 `host.call`,故 host 侧走 `webServer.register`
    同源 JSON 路由(与官方 client-connection 的浏览器 fetch 一致);
    host 为普通 ESM(Node 全局 fetch 可用),不受动态插件 fetch 陷阱约束。
  - client bundle 为手写 `window.__ModuleLoader__.load({id, factory})` 格式(本机无 tsdown),
    遵循官方产物同构:`inject` 数组 + `apply` + `module.exports`;
    面板纯 `React.createElement`,无 JSX/import。
- **安装**:`%USERPROFILE%\.dsh\profiles\web\package.json` 以 `file:` 依赖引入并加入
  `dsh.profile.bundles`;pnpm install 后需重启 host 生效;改源码后重跑 pnpm install 同步。
- **验证**:离线冒烟(status/detect/apply/subagent 四路由,真 http 服务 + 假 settings/
  假预设目录副本)全 PASS;detect 命中 17 个 `:free` 模型;apply 保留 xiaomi 等其他 provider;
  subagent 正确更新 kurumi/whale/inverse 三预设。真机验证点:重启后面板渲染、写入后模型选择器出现、
  子代理实际切换模型。
- 触摸点:`plugins/dsh-free-model-pool/*`(新增)、
  `%USERPROFILE%\.dsh\profiles\web\package.json`(bundle 注册)、`README.md`。

## 2026-08-23 · 标题栏 × DSW 布局融合 + 主题装饰

- **标题栏与 DSH 页面融合**：背景/文字改走 DSH 本体令牌（`--dsw-alias-bg-base` / `--dsw-alias-label-*`），
  按钮 28px 圆形 + 圆底 hover，对齐 DSW 原生 UI 手感；新增 `syncTitlebarGeometry()` 模拟
  「侧栏色块向上延伸 + 详情面板分隔线向上延伸」，制造标题栏是页面一部分的错觉；loading.html 同步同款样式。
- **逐条对照 DSH 本体源码验证**（0.1.1-rc.1 前端包）：`--dsw-specific-sidebar-fill` 为 DSH 官方令牌
  （`dsh-client-ui-theme`，明暗双值 = sidebarCol 背景色），三主题经 `--dsw-static-*` 覆盖自动跟随；
  几何探测目标 = `dsh-client-ui-layout` AppFrame 的内联网格
  （`"${cols.sidebar}px minmax(0,1fr) ${cols.details}px"`），首列=侧栏/末列=详情/折叠=0px 全部吻合；
  全 DSH 前端仅此一处内联 `gridTemplateColumns`，首个命中无歧义；
  `::before/::after` 复用的 `--dsw-alias-border-l1/-l2` 与 DSH `sidebarCol`/`detailsCol` 的分隔线令牌同源。
- **P1 修复（1px 对齐）**：`::before` 加 `box-sizing:border-box`——grid item 默认 stretch 下
  border-box 宽 == 轨道宽，DSH 的 `sidebarCol` 分隔线画在轨道右缘**内侧 1px**，而原 `::before`
  为 content-box 时 border 画在轨道右缘外侧 1px → 双线错位 2px；改 border-box 后逐像素重合。
- **探测防御**：`--ms-details-left` 末列仅在网格声明 ≥2 列时取（防未来两列结构把侧栏宽误判为
  详情宽）；轨道 px 声明值优先、实测列宽降级为兜底（二者在 stretch 语义下相等）。
- **契约记档**：对 DSH 内部 DOM 的依赖（AppFrame 内联网格/首末列语义/折叠 0px）为隐性契约，
  上升为 `design/ARCHITECTURE.md` 已知约束（DSH 升级时需复核）。
- **标题栏装饰（用户需求「美化」）**：左端主题徽记（复用主题图标 20px 圆 + `--ms-glow` 主题光晕 +
  3.2s 呼吸，`prefers-reduced-motion` 禁用）+ 主题副标（`Zafkiel · XII` 等）；底部 1px 主题渐变底线
  （`--ms-deco-line` 独立声明 + 逐层回退，装饰失效不拖垮基底）：zafkiel 金→暗红檐线 + 金表圈内高光
  （inset）、kurkuriel 右重血红渐变 + 上下血红内线、pure 跟随 `--ms-border` 弱线保持极简。
  徽记清理链：加载失败字形兜底按 `data-glyph` 定位清除、onerror 用 JS 挂载（切主题后始终引用最新
  `current`）。
- 触摸点：`themes/runtime.js`（CSS + `syncTitlebarGeometry` + buildTitlebar/updateTitlebar）、
  `ui/loading.html`、`themes/{pure,zafkiel,kurkuriel}.css`、`README.md`。
- 验证：`build-init.mjs` 通过（令牌校验 + 53KB theme-init.js 产出，js 语法检查通过）；
  几何同步与装饰待真机验收（三主题切换 + 拖拽详情分隔线 + 侧栏折叠 + 窗口 resize + 徽记呼吸/底线观感）。

## 2026-08-22 · 桌宠 v2 阶段 A：动作丰富化（针对「动作少、僵硬」整改）

- 规划链路：学习 OpenDesign 宠物体系 → `design/pet-v2-roadmap.md`（总览+诊断+决策）→
  `design/pet-v2-phase-a-execution.md`（可开工执行方案）。僵硬诊断七条根因详见 roadmap §3.5。
- **反转狂三立绘清晰化（用户反馈「不像」）**：形象核查（高清源 1728×2368：银发、金钟眼 12:05、
  红瞳尖线、黑金哥特裙、血红内衬——形象本身正确）；根因是素材链退化 + v1 遗留断层：
  `inverse-states.mjs` 输出名为 `blue-*.png` 与 frames.json 引用的 `states/{idle,work,deep}.png` 错位，
  桌宠一直渲染 8/21 产的 128×208 旧图（钟眼糊成色块、形象沦为普通异色瞳少女）。
  修复：输出名统一 `{idle,work,deep}.png` + 输出档位 208 → 540 高（渲染 270 的 2 倍超采样）。
  三态现为 332/313/381 × 540，钟眼可辨认。
- **whale 帧拆分 bug（真机「缩放跳动」修复）**：`sharp(gif, {animated:true, page:p})` 的语义
  是「输出从第 p 页起的堆叠塔」而非单帧——拆出帧尺寸为 192×1248/1040/832/624/416/208，
  渲染按各帧宽高比缩放 → 每帧忽大忽小（真机截图可见「微型三连叠影」）。修复：整动画图
  用 `extract` 逐段切（顶部=帧 0），全部帧固定 192×208。教训：sharp animated 输出为垂直堆叠图，
  `page` 与 `animated` 组合语义反直觉，帧序列务必校验输出尺寸（`ui/pets/whale/states/idle-*.png` 已验）。
- **whale 绿色描边净化（真机反馈「绿边不好看」）**：`idle.gif` 为「透明替代色残留」型 GIF——
  制图用纯绿（0,254,0 / 0,126,0 等）当透明区而未标 alpha，帧边缘呈绿色系实色描边。
  新增 `stripGreenEdge()` 后处理（绿色主导像素 → alpha 0）接入 whale 拆帧链路，
  复检剩余绿色像素 0。素材审计原图/像素抽样两步确认非渲染 halo（半透明像素 0）。
- **专注态语义修正（真机反馈「狂三一直跳动」）**：强度分级实为 DSH 页面模型标签解析
  （`Max→deep / High→work`，runtime.js `CUR_INT`），页面常驻时 intensity 长期非 idle；
  v2 初版把思考中映射到 wait 行 + 4fps 慢放，wait 帧组帧间起伏（眨眼/下沉）被慢放放大 →
  观感「一停一顿的跳动」。修正：思考中=静默守候（idle 姿态，ambient 仅在 idle 强度触发自动安静），
  wait 行专属阶段 B 审批等待。决策 3 修订记录于 `design/pet-v2-roadmap.md` §7。
- 用户机体验反馈触点：真机验收发现跳动 → 截图取证（角色区/背景区对照差分 + 肉眼核查）→
  定位 whale 帧尺寸不一 → 修复后三张抽查帧尺寸一致，动画闭环正常。
- **素材全行切出（A0）**：`cut-frames.mjs` 的 `NEEDED` 4 行 → 全 9 行（idle/runRight/runLeft/wave/jump/failed/wait/run/review），
  kurumi 帧组 21 → 57 帧；wait/review/failed 行此前躺在 spritesheet 中未用（僵硬 #1）。
- **whale 帧序列（A6）**：`idle.gif`（192×1248 六帧条）拆为 `states/idle-00~05.png`；
  `frames.json` 三态值支持「帧组数组 | 单帧字符串」双形态；渲染侧统一为帧组（`Frames.states: HashMap<String, Vec<Image>>`），
  帧组 6fps 循环 + bob，单帧行为与历史一致。
- **修复 wave 不可达（A1）**：双击此前永远 `do_hop+focus_main`（README 声称的「双击=挥手」实为漂移）；
  现按决策改为：主窗最小化/隐藏 → 唤起，否则 → `do_wave()`（wave 行 1300ms）。
- **强度语义修正（A2）**：work/deep 不再原地播 run（僵硬 #3），改 `wait` 行守候（慢放 4fps），
  run 行只归属有位移的 wander——「移动才有跑步」。
- **呼吸与过渡（A3/A4）**：kurumi 基线（idle/wait 且无行动）加 ±2px 3200ms 呼吸 bob；
  跳跃落地加 200ms 末帧定格（`hop_hold_until`），消除硬切。
- **环境编排 + 滑步修正（A5）**：idle 基线低频随机小动作（池 wave/review/wait，jump 15% 偶发；
  表演 1.2~2.2s / 休息 8~18s / 首演 5.5s；指针按下即打断）；wander 滑步修正：位移从「每 tick 3px」
  改为「每帧 9px」（帧同步，90px/s 速度不变）；wander 改为 kurumi 专属（whale/inverse 不再无声滑行）。
- 触摸点：`src-tauri/src/pet_native.rs`（常量表/PetWin 字段/compose 状态机/FFI 交互）、
  `scripts/cut-frames.mjs`、`ui/pets/frames.json`、`ui/pets/kurumi/frames/`（+34 帧）、
  `ui/pets/whale/states/idle-*.png`（+6 帧）。
- 验证：`cargo check --offline` 通过；沙箱内冒烟通过——进程存活、`MiasakiPetWin` 286×390 物理尺寸正确、
  金点窗/托盘/单实例窗齐备；角色区像素活性对照差分成立（角色区 23K~32K px 变化 vs 背景区 0~5.4K，
  9/9 帧对变化，`_refs/scripts-archive/pet-pixdiff*.ps1` 可复用）。用户机验收清单见执行方案 §验证。

## 2026-08-22 · monorepo 重组（仓库结构）

- 仓库重组为三文件夹 monorepo（umbrella `dsh-miasaki` 仍是唯一 git 仓）：本目录 `dsh-miasaki-desktop/`（原 `desktop/` + `design/` 内移）、`dsh-miasaki-fleet/`（编排线）、`dsh-miasaki-shared-docs/`（跨线/DSH 平台参考）。
- `design/` 从仓库根移入本目录内部 → `build-init.mjs` 令牌面路径由 `join(root,'..','design',...)` 改 `join(root,'design',...)`（gen-init 验证通过，令牌校验 + 46KB theme-init.js 产出）。
- `README.md` 设计规范引用 `../design/` → `design/`；`.gitignore` 锚定路径前缀 `desktop/`→`dsh-miasaki-desktop/`。
- 安全网：tag `pre-reorg-2026-08-22` @ `10f8baa`；era tag `0.1.1-rc.1-era` 落在重组+修复后的 `bee066d`。

## 2026-08-22 · m36 冒烟收尾（工程）

- **`verify-themes.mjs` 断言修正**：`kurkuriel: 骨白基底令牌` 原检查 `--dsw-static-neutral-bluish-950 === '#e9e5e1'`，
  但 `kurkuriel.css` 自初版（4f07bd9）起该令牌即声明为 `#0f0d0b`——骨白实际走「DSH 亮色语义」亮端令牌
  （`--dsw-static-neutral-bluish-50=#fcfaf8`）+ `--dsw-alias-bg-base=rgba(247,244,241,.88)`。
  该断言从首次提交即不可满足，因 `verify-themes` 此前从未在真机跑通而潜伏。
  改为：亮端令牌 + alias 基底含 `247, 244, 241`，并新增「深端令牌同步覆盖 = `#0f0d0b`」佐证覆盖链路健康。
  真机首次完整跑通 **18/18**（0.1.1-rc.1 全局 CLI）。属测试断言修复，非主题代码回归。
- **m36 回归冒烟**：详见 `docs/m36-rc8-regression-smoke-2026-08-22.md`——m3-test/rc7-test 混装 profile
  `--dump-config` 双双 exit 0，rc7-test 插件树与 M3.5 基线 313 行字节一致，三主题端到端通过。

## 2026-08-22 · v0.1.4(第七轮)

- **桌宠 Agent 预设(三个)**:standard 底座复制 + 中文 persona。
  人设按桌宠贴合成角色(鲸鱼娘/狂三/反转狂三),调用偏好区分:鲸鱼娘先本地后网页、
  狂三复杂任务先规划后动手、反转狂三默认直接动手改动面大才计划;
  每条 persona 带硬性「入戏边界」——工具调用、错误报告、审批/凭证一律标准语气(中档扮演)。
  三个预设经 `standingKeyFor` 挂载校验通过;RPC 通道经真实创建验证。
- **主题→人格会话联动**:切换主题自动用对应桌宠的 Agent 预设开启新会话
  (官方 RPC `session.create` 的 `agentPreset`;优先挂当前 workspace)。
  每主题仅自动创建一次(localStorage 去重),RPC 失败静默降级不阻断切换。
- **三桌宠灵魂文件(pet.json)补全**:whale/kurumi/inverse 三份中文人设
  (inverse 新增 manifest + spritesheet.png/webp 图集,由 `scripts/make-inverse-sheet.mjs` 生成)。

## 2026-08-21 · v0.1.3(第六轮)

- **闪退根治(关键)**:GDI 高频创建改为**持久 DC/DIB 表面**(创建一次终身复用);
  气泡文本渲染从 33ms 心跳降到帧更新时;BmiHeader `biSize` 44 → 40 标准值。
  此前 gdi32full+0x2ae13 固定偏移崩溃连续出现 5 次(22:16/22:25/22:47/23:16…)。
- **主窗口位置/大小持久化**:关闭时保存 `%APPDATA%\com.miasaki.desktop\window.json`(物理坐标),启动时恢复(负坐标/过小尺寸防御)。
- **托盘菜单**:显示/隐藏主窗口、退出(`tray-icon` feature;左键点击不弹菜单)。
- **冒烟测试脚本**:`desktop/scripts/smoke-test.ps1`(交付物完整性 / 进程存活 / 桌宠窗口 / 素材加载 tick0)。

## 2026-08-21 · v0.1.2(第五轮)

- **GDI 句柄泄漏修复**:`present()`/`draw_text()`/`draw_dot()` 的 `SelectObject` 后未恢复原对象即 `DeleteObject`,
  33ms 高频下句柄耗尽 → gdi32full 崩溃;全部改为先恢复再删除,DC/DIB 创建失败提前返回。
- **防复发**:compose 加脏标记,静止时 `present` 频率 33ms → ≥125ms。
- **桌宠放大**:窗口 220×300 → 286×390,角色 208 → 270 高;气泡 170×36 → 210×48;金点 26 → 30;散步 2 → 3px。
- **拖窗跟手**:JS 发「按下起点累计物理增量(×DPR)」+ Rust 差值应用 + `move=reset` + 轮询 100ms → 33ms + pointercancel。

## 2026-08-21 · v0.1.1(第四轮)

- **桌宠动画循环真相**:`WM_CREATE` 期间 `GWLP_USERDATA` 未设置 → `wnd_proc` 的 `SetTimer` 从未执行
  → 桌宠自 v0.1 起只画一帧、永不刷新;修复:USERDATA 就位后显式 `SetTimer`。
- 二次根因:`compose` 每 33ms 清空 buf 但帧更新间隔 ≥125ms → 空帧闪烁;修复:清空移入帧更新分支。
- 明暗锁定修复:pure/system 切换时移除残留 `data-ds-dark-theme`(切回原版不再残留暗色)。
- 标题栏 36→32px 低调化、去阴影;切换条 hover 展开 + 300ms 延迟关闭 + 面板 hover 保活。
- `set_mode`/`set_intensity` 日志埋点。

## 2026-08-21 · v0.1.0 增补(第三轮)

- **apply() 核心同步优先**:syncHash/refreshSwitcher/updateTitlebar 提到装饰层之前并 try-catch,
  消除"装饰层异常 → 图标不换+桌宠不切换"连锁失败;自愈巡检 5s → 1s。
- 切换条交互重做(见上);标题栏按钮 `--ms-danger` 主题化。
- **软件图标重设计**:百炼生成「暗夜紫 + 鎏金时钟 10:10 + 绯红蔷薇」艺术图(icon-new.png),
  `npx tauri icon` 重生成全套;make-icons.mjs 换源并修复 inverse 徽章引用。
- set_mode 日志埋点;启动器 `--no-open`(rc.8 双窗口问题)。

## 2026-08-21 · 第二轮

- 桌宠待机随机行为(18-42s 气泡 / 22-50s 散步 + 贴边吸附)。
- **反转狂三全新立绘**:qwen-image-3.0 生成 3 态 + 深蓝背景 flood-fill 抠图(`scripts/inverse-states.mjs`);
  inverse 从「kurumi 重着色 atlas」改为立绘三态。
- 滚动锁死(`html,body overflow:hidden` + `#root calc(100% - 32px)`);aurora 光晕层 + 面板半透明化;水印增强。
- 清理:pet_native.rs 死代码、50+ 诊断截图、测试 profile、旧状态帧/inverse 图集。
- `inputModalities` 修复使 read_image 可用;百炼 skills 刷新 1.17.0。

## 2026-08-21 · 第一轮(rc.8 适配)

- 启动器加 `--no-open`(rc.8 起 `dsh web` 自动开浏览器 → 双窗口)。
- runtime.js 内页宠物死代码清理(-426 行,注入包 56KB → 38KB);删除 ui/pet.html/css/js。
- rc.8 令牌面核对:`--dsw-static-*` 73 个与 token-surface.txt 一致;`--json-tree-*` 等 8 个失效(死覆盖,无害)。

## 2026-08-17 · v0.1.0 初始

- Tauri 2 薄壳 + 三主题(纯色/刻刻帝/狂狂帝)+ 原生 Win32 分层窗桌宠(鲸鱼娘/狂三/反转狂三)。
- 用户验收通过("好了")。
