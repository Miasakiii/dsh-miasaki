# 桌面壳 ↔ 渲染层契约（v1.1）

> 状态：**v1.1 已落地（2026-09-25）**——v1 见规划 W1/T1.2–T1.4，v1.1 是**受控写能力**增量。
> 实现 = `themes/src/10-contract.js`（独立 IIFE 分片），
> 闸门 = `themes/test/contract.test.js`（**15 例**，已接入 `node scripts/verify-all.mjs desktop`）。
> 上游规划：[`official-desktop-adoption-plan-2026-09-25.md`](../../dsh-miasaki-shared-docs/cross/official-desktop-adoption-plan-2026-09-25.md)；
> 对标实现（官方 Electron）：[`dsh-official-desktop-analysis-2026-09-25.md`](../../dsh-miasaki-shared-docs/dsh-platform/dsh-official-desktop-analysis-2026-09-25.md) §3.4。

## 1. 为什么需要契约

此前七线插件各自"猜环境"——靠 UA、靠某个 DOM 节点在不在、靠 `window.__TAURI__` 是否存在
（而远程页的 Tauri IPC 被 capability 挡住，`capabilities/remote-dsh.json:5-9` 只授
`core:default` + `start-dragging`）。壳与页面之间**没有有版本号、可探测、可降级的能力面**：
插件无法回答"我在桌面壳里吗？这个壳支持我要的能力吗？不支持时我该退回什么？"

本契约就是这三个问题的唯一答案。

## 2. 契约面（v1）

```js
window.miasakiDesktop = {
  protocolVersion: 1,          // 契约版本，用于协商
  isDesktop: true,             // 环境标识（web 直开时该对象不存在）
  isLocalPage: false,          // 本地唤醒页（loading.html）为 true，DSH 页为 false
  capabilities: [...],         // 能力名数组（事实清单）
  has(name) -> boolean,        // 能力探测
  theme: {
    current() -> 'pure' | 'zafkiel' | 'kurkuriel' | null,
    onChange(cb) -> unsubscribe,
    set(name) -> boolean       // v1.1：派发内部事件，true = 已派发（≠ 已生效）
  },
  window: {
    onMaxStateChange(cb) -> unsubscribe,  // cb(boolean)
    controls: {                // v1.1：窗控（最大化是 toggle，与标题栏按钮同语义）
      minimize() -> boolean,
      maximize() -> boolean,
      close() -> boolean       // 关闭 = 隐藏到托盘（W3.1 语义）
    }
  },
  chrome: {                    // v1.2：壳 chrome 几何（只读 + 订阅，避让量由插件自己算）
    bounds() -> { left, top, right, bottom, width, height } | null,  // 视口坐标；量不到为 null
    onChange(cb) -> unsubscribe                                      // cb(bounds | null)
  },
  assets: { baseUrl: 'http://127.0.0.1:39800/' }
}
```

能力表（**即事实**）：

| 能力名 | 语义 | 实现依据 |
|---|---|---|
| `theme.current` | 读当前主题（读 `html[data-miasaki-theme]`） | `09-ready.js` 在文档创建时置属性 |
| `theme.onChange` | 订阅主题变更（MutationObserver 属性观察） | 同上 |
| `theme.set` | 切换主题（**v1.1**）：派发 `miasaki-theme-set`，由 `02-core.js`（寄生分片）执行 `apply()` | `02-core.js` 的监听 + `apply()` 顺序定律 |
| `window.maxState.subscribe` | 订阅最大化状态（Rust `eval` 派发 `miasaki-max-state`） | `06-titlebar.js` / `main.rs::push_max_state` |
| `window.controls` | 窗控（**v1.1**）：派发 `miasaki-window-command`，由 `06-titlebar.js` 映射为 `petHashCmd('min'\|'max'\|'close')` | 同上（复用唯一 hash 写者） |
| `assets.baseUrl` | 素材服务基址（省得插件各抄一遍端口） | `main.rs`（39800 素材服务） |
| `chrome.bounds` | **v1.2**：壳窗控按钮组在视口坐标下的矩形（量不到返回 `null`） | `06-titlebar.js` 建的 `#miasaki-titlebar .tb-group` |
| `chrome.onChange` | **v1.2**：订阅该组尺寸/位置变化（`ResizeObserver`）——sidebar 往组里插按钮这类事会触发 | 同上 |

> **v1.2 的边界（改之前先读）**：① 只给**矩形**，不给「你该让多少」——各插件呼吸位不同
> （canvas 6px、ssh 6+8px），壳无权替它们决策；② **不提供官方 DSH chrome 的位置**（那是官方资产，
> ssh 自己的口径②继续自量）；③ 子 frame 仍只给空壳（纪律③）——canvas / ssh 都是
> **主帧量、iframe 消费**（`canvas:chrome` / `--ssh-chrome-reserve` 下发），无需开口子。
>
> 配套：`06-titlebar.js` 用 `ResizeObserver` 观测 `.tb-group` 实宽，
> **壳成为 `--ms-titlebar-reserve` 的唯一写者**（公式 = 组宽 + right 8 + 呼吸 12；
> 108→128、136→156）。静态兜底 `03-switcher.js:89` 取**注入形态上界** `156px`
> （2026-09-27 实机重叠事件后由 128 改：兜底是「无人写」时的最后防线，按「无终端键」取值会在
> sidebar 插键后少让一格 ⇒ 官方 ExpandButton 压住终端键）。
>
> **注入方契约**（跨线，判据用契约能力而不是版本号）：
> `chrome.bounds` 能力在位 ⇒ 壳自己观测实宽，**注入方一律不写**该变量；
> 能力缺席（旧壳 / 浏览器直开）⇒ 注入方按**同源公式**（组实宽 + 8 + 12）补位 ——
> 当下唯一实现是 sidebar 线的 `titlebarButton.writeReserve`，闸门在
> `dsh-miasaki-sidebar/test/titlebar-button.test.js`。两条线各自只守一半：壳守"我在位时我算"，
> 注入方守"壳不在位时我算"。

## 3. 三条设计纪律（改契约前必读）

1. **只暴露确实实现的能力**——能力表即事实，不写"将来会有"的占位。闸门里有一条测试
   逐项核验"能力表声称的每一项在暴露面上真的存在"。
2. **写能力一律"派发内部事件、由寄生分片执行"，契约自己不碰 `location.hash`**——本壳的
   hash 写者只有两个（`02-core.syncHash` 与 `05-sensors.petHashCmd`）；在契约里直接实现一套
   写通道会立刻造出**第三个写者**，正是 W0-T0.2 刚修掉的竞态。
   v1.1 的 `theme.set` / `window.controls` 因此只 `dispatchEvent`（`miasaki-theme-set` /
   `miasaki-window-command`），落到 `02-core.js` 与 `06-titlebar.js` 执行 —— 后者复用
   `petHashCmd`，**写者数量不变**。闸门用"剥离注释后不得出现 `.replaceState(` /
   `petHashCmd(` / `syncHash(` / `__TAURI__`"把这条钉死，另有测试**静态断言寄生侧真的在
   监听**（防"派发了没人收"）。
3. **子 frame 只给空壳**——`initialization_script` 注入**每个文档**（`08-ready.js:3-8` 记录了
   "iframe 里浮出两套假窗控"的实机教训）。因此非顶层 frame 只拿到
   `{ protocolVersion, isDesktop, isLocalPage }`，拿不到 `capabilities` / `theme` / `window`。

## 4. 版本协商与降级

- 插件先判存在性：`var d = window.miasakiDesktop`（web 直开时为 `undefined`）。
- 再判版本：`d.protocolVersion >= N`。**语义边界（2026-09-25 修正）**：`protocolVersion`
  只在**破坏性变更**（删能力 / 改既有语义）时提升；**增量能力**只追加 `capabilities` 条目，
  插件用 `has()` 探测即可 —— 旧插件因此完全不受影响。本次 **v1.1**（`theme.set` /
  `window.controls`）属增量，**`protocolVersion` 仍为 1**。
- 再判能力：`d.has('theme.onChange')`。
- 任一步不满足 ⇒ **退回 web 实现**（与官方同构：官方 `__DSH_DIRECTORY_PICKER__` 缺失时回落
  `ctx.uiWorkspace.pickDirectory()`）。

```js
// 插件侧推荐写法
var d = typeof window !== 'undefined' ? window.miasakiDesktop : undefined
if (d && d.protocolVersion >= 1 && d.has('theme.onChange')) {
  d.theme.onChange(function (t) { applySkin(t) })
} else {
  observeFallback() // 纯 web 环境：靠属性观察/事件兜底，功能不减
}

// v1.1 写能力：先探测再调用。返回值 true 只表示**已派发**（Rust 侧 33ms 轮询消费并按 seq 去重），
// 不代表已生效；需要确认结果请订阅既有回执通道（如 window.onMaxStateChange）。
if (d && d.has('window.controls')) d.window.controls.minimize()
if (d && d.has('theme.set')) d.theme.set('kurkuriel')
```

## 5. 与官方 `dshDesktop` 的关系（明确不做的事）

| 官方做法 | 本项目 | 理由 |
|---|---|---|
| `dshDesktopBoot.ready()` 交付 `injections` | **不做** | 需要壳自己成为 injections 的提供方（= 自建反向代理量级，见规划 §2.2 路线 A） |
| `dshPlatform` / `dshOnboarding` / `__DSH_DIRECTORY_PICKER__` | **不做** | 这些是官方**特制前端构建**的消费点，本机 npm 版 `dsh-web-frontend` 里不存在；注入了也没人读 |
| `protocolVersion` 协商 + 能力按帧降级 | **对齐** | 纯收益，且与本项目插件生态契合 |
| 命名 | 用 `miasakiDesktop` 而非 `dshDesktop` | 避免与官方将来可能引入的同名对象冲突 |

## 6. 首帧通道附录（W1/T1.1 spike 结论）

规划 T1.1 原本要"用 `__DSH_BOOT_READY__` 把 DSH 前端挡在壳的 `onReady()` 之后"。**本轮实测否掉了它**：

1. 官方后端 `dsh-host-webserver`（本机 0.1.7-rc.2）在 index.html 末尾注入
   `(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()`——它**复用我们的
   deferred 然后立刻 resolve**（源码注释：*"the served form … creates and resolves it in one
   statement, because every row is already in the document text"*）。执行序注定：
   `initialization_script` → … → body 末尾 tail script（**后端 resolve**）→ head 里 module 入口
   执行 → `DOMContentLoaded` → 我们的 `onReady()`。**前端永远跑在我们的 `onReady()` 之前。**
2. 因此首帧就位的正确通道是 **`webserver/index-inject`**（注入行写在 index.html 文本里，
   解析期生效，早于 module 入口）——appearance 线首帧防闪色用的就是它
   （`appearance/index.js:128-134`）。

**可行性结论**：`initialization_script` 执行时 `document.documentElement` **可用**（既有代码
即是证据：`02-core.js:96-107` 的 `ensureStyle()` 会 `document.head || document.documentElement`
兜底挂载，注释明确"文档创建时 head 可能尚未就绪"）。但：

- 提前 `ensureStyle()` 到 document_start 的收益有限（窗口极小：body 未解析完时页面无内容，
  闪的是窗口底色而非内容），**暂不做**；
- 若将来要"进入 DSH 页的第一帧就带自绘标题栏"，只能走 `index-inject`（需要 DSH 侧插件载体），
  属**未决项**，不在 W1 范围。

## 7. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-27 | **v1.2：壳 chrome 几何**（`chrome.bounds()` / `chrome.onChange()`）。由来：[全线审查](../../dsh-miasaki-shared-docs/repo-review-2026-09-27.md) §4-① 发现右上角一带有**三方争用**——sidebar 往 `.tb-group` 插终端键并硬编码写 `--ms-titlebar-reserve:156px`、canvas 与 ssh 各自量宽避让、壳自己消费该变量给官方控件让位；同一事实三种取数，且 canvas 还写死了「宽度固定，无需监听」这个已被 sidebar 注入打破的前提。本能力把它收敛成一个**只读**接口（「壳说事实、插件选分支」，与 `12-material` 的 `data-mia-native-mica` 同一分工）。**`protocolVersion` 仍为 1** —— 按 §4 语义，增量能力只追加 `capabilities` 条目。同批：`06-titlebar.js` 用 `ResizeObserver` 观测实宽自动写 `--ms-titlebar-reserve`（**壳成为唯一写者**，sidebar 的两处写入删除）；`06-titlebar.js` 头部纪律同步 v1.1/v1.2（此前仍写「只读 + 不提供写通道」，与同文件 v1.1 实现自相矛盾）；`contract.test.js` 的能力表核验补上**未知命名空间即失败**的守卫（原先对未知 ns 静默跳过）。闸门 **15 → 19 例**。 |
| 2026-09-26 | **P7：页面 → 壳的事件通道**（`miasaki-pet-heartbeat` / `miasaki-boot`，经 `plugin:event\|emit`；权限来自既有 `core:default` 的 `core:event:default`）。**暴露面不变**：`window.miasakiDesktop` 的能力表、`protocolVersion`（仍为 1）与写者数量（仍为 2）全都没动 —— 变的是**六态心跳的送达通道**：`petts` 不再写 `location.hash`（那正是「URL 每 1.5s 变一次、History 库涨到 87MB」的驱动源），改由事件直达 `main.rs` 的 `app.listen`。§3 纪律②「契约自己不碰 `location.hash`」因此更强：**心跳也不再碰**。详见 [CHANGELOG.md](CHANGELOG.md) 2026-09-26（下午·续）。 |
| 2026-09-25 | **v1.1**：新增受控写能力 `theme.set` 与 `window.controls`（minimize / maximize / close）。实现走**内部事件**（`miasaki-theme-set` / `miasaki-window-command`），执行落在寄生分片 `02-core.js` / `06-titlebar.js` —— 契约自己不碰 `location.hash`，**写者数量不变**（仍为 2）。闸门 11 → **15 例**（新增：派发与白名单拒绝、只暴露人话名不透内部协议名 `min`/`max`、寄生侧监听的静态断言）。同批修正 §4 的版本语义：`protocolVersion` **只在破坏性变更时提升**，增量能力靠 `has()` 探测。 |
| 2026-09-25 | v1 落地（W1/T1.2–T1.4）：`10-contract.js` + 11 例闸门 + 本文档；同批记录 T1.1 spike 结论（`__DSH_BOOT_READY__` 闸门不可用，正确通道为 `index-inject`） |
