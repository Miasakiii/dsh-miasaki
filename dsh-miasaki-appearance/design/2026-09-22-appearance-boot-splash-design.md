# Boot Splash 首帧启动画 设计（appearance 线半）

> 状态：**设计定稿（2026-09-22），待用户拍板实施**。用户原点名需求（跨线）：「现在的启动
> 加载界面太简单不符合本项目」「加载页弄酷炫一点」——本文件是 **appearance 线半**：DSH 首帧
> （3080 HTML 到达 → shell 挂载）的启动画。desktop 线半（loading.html 2.0 + 内嵌启动日志流 +
> cmd 闪窗根治）见 `../../dsh-miasaki-desktop/design/boot-loading-terminal.md`；
> 两线契约见 `../../dsh-miasaki-shared-docs/cross/boot-loading-2026-09-22.md`。

## 1. 目标与边界

**做**：在 `webserver/index-inject` 已注入的防闪色底座之上，加一层**有感知的全屏启动画**——
皮肤色 / 壁纸即显 + 纹章动效 + 一句品牌语，DSH shell 挂载后干净淡出。把「先原生后外观」的
空窗期变成品牌时刻。

**不做**：

- 不碰桌面壳 loading.html（归 desktop 线）；不碰 DSH 本体（零 shell 改动纪律）；
- 不等后端进度（appearance 看不到 dsh bootstrap 阶段——那是 desktop 线日志流的事）；
- 不做跨页动画接力（默认各自干净退场，见 cross 契约）。

## 2. 与 M2 boot style 的关系（分层，不重叠）

| 层 | 现状（M2） | 本设计（Boot Splash） |
|---|---|---|
| boot script（body） | 写 `html[data-mia-*]` 门控属性，0 视觉 | 不变 |
| boot style（head） | 皮肤 token + 壁纸 + 玻璃的**防闪色**（无感知过渡） | 不变，继续打底 |
| **新增 splash（head style + body html/script）** | — | 全屏启动画层：纹章 + wordmark + 动效，挂淡出 |

即：splash 是**叠在 boot style 之上的独立一层**，`data-mia-appearance="off"` 时两层都不注入
（硬契约）。

## 3. 实现（index-inject 通道，全部走既有能力）

`ctx.on('webserver/index-inject')`（index.js:128，现有注入点扩展，不新增订阅）：

| 行 | kind | placement | 内容 |
|---|---|---|---|
| 1 | `script` | `body` | 现有 `buildBootScript`（门控属性）**不变** |
| 2 | `style` | `head` | 现有 `buildBootStyle`（防闪色）**不变** |
| 3 | `style` | `head` | **新增** `buildSplashStyle(config, skinTokens)`：splash 层 + 动效 + reduced-motion |
| 4 | `html` | `body` | **新增** splash 容器 DOM（纹章 + wordmark + 进度点） |
| 5 | `script` | `body` | **新增** splash 生命周期（退场双信号 §3.2） |

> 行类型与 placement 依据 spike 期取证（plan 文档 §9-8：`global`/`script`/`script-src`/
> `script-preload`/`style`/`html` 六种；head 行紧跟开 head、body 行紧跟开 body，各组按表顺序）。
> **实施第一步复测 placement 顺序**（注入行 3/4/5 相对彼此与相对官方 `__DSH_BOOT_READY__` 尾巴
> 的位置），不凭半年前的记录直接写码。

### 3.1 视觉规范（复用三主题 DNA，自有前缀）

- splash 容器 `#mia-splash`：`position:fixed; inset:0; z-index:2147483000`（压过一切 shell 层，
  但**尊重**桌面壳注入层的既有 `data-miasaki-theme` 让位协议——splash 只在 3080 页生效，
  桌面壳 loading 由 desktop 线自理，天然不撞）；
- 内容：`--mia-bs-*` 变量驱动的皮肤底色 / accent；纹章与 desktop loading 同设计语言
  （时钟图腾：刻刻帝顺时针 / 狂狂帝逆时针 / pure 简约——**小尺寸重绘，不引外部资产**）；
  一句 wordmark「MIASAKI」+ tag「专属 DSH 桌面端」与桌面壳一致；
- 动效（全部 transform/opacity）：纹章外环旋转（zafkiel 顺 / kurkuriel 逆 / pure 无）+
  呼吸光晕 + 底部三点流动进度；`@media (prefers-reduced-motion: reduce)` 全部静止；
- 字体栈与桌面壳 loading 一致（Segoe UI / Microsoft YaHei / system-ui），纹章内联 SVG。

### 3.2 退场双信号（幂等，谁先到谁执行）

| 信号 | 机理 | 角色 |
|---|---|---|
| 主信号 | appearance **client 半装载后**执行退场（client 装载 ⇒ shell 已挂载，最可靠） | 正常路径 |
| 兜底信号 | boot script 内 `MutationObserver` 观察 `document.body` 子节点/属性变化，shell 容器出现即退场 | client 迟迟不装载 |
| 超时兜底 | 上述皆无：**2.5s 后无条件淡出** | 防 splash 挡住错误页（401 / 白屏 / 后端异常） |

- 幂等：`document.documentElement.dataset.miaSplashDone` 守卫，退场只执行一次；
- 淡出：opacity 过渡 300ms（reduced-motion 时 0ms），`transitionend`/超时后 `remove()` 节点；
- **401/错误页场景是硬用例**：dsh web 未认证时首帧非 shell——必须 2.5s 兜底让位，
  splash 不得常驻（否则挡住「重新打开 dsh web 打印的 URL」提示，与 desktop P1 待办联动）。

## 4. 配置面（最小增量，M3 动效落位前不膨胀 schema）

- 既有 `motion` 板块（M3 规划中已预留）新增字段 `bootSplash: 'auto' | 'off'`，默认 `auto`；
  **总开关 `enabled=false` ⇒ 不注入**（现有 `buildBootStyle` 同款门控，`sanitizeConfig` 收窄）；
- 不做独立开关面板行——先复用 M2.6 面板里动效板块的既有控件形态（等 M3 动效落地时
  统一暴露，避免提前制造 UI 债）；
- 配置迁移：v2 → v3 仅加默认字段（现有 `mergeConfig`/迁移链零风险，同 M2 壁纸 v2 先例）。

## 5. 与 desktop Loading 2.0 的衔接（摘录，契约以 cross 文档为准）

- 桌面壳场景：loading（desktop）退场 → 3080 首帧 → **splash（本线）** → shell；
- 两线各自干净退场，**不做接力动画**；时间预算参考值：splash 超时 2.5s ≥ desktop loading
  正常就绪后 navigate 时延即可，具体对齐见 cross 契约 §3。

## 6. 实施顺序

| 步 | 内容 | 产出 |
|---|---|---|
| S1 | 复测 index-inject 六行 placement 与 `__DSH_BOOT_READY__` 尾巴形态（§3 注记） | 取证记录 |
| S2 | `lib/splash.js`（纯函数：`buildSplashStyle` / `buildSplashHtml` / `buildSplashScript`）+ 单测 | host 半逻辑 |
| S3 | index.js 注入点扩展（第 3/4/5 行）+ 门控 | host 半接线 |
| S4 | client 半退场钩子（装载后执行幂等退场） | client 半 |
| S5 | 实机验收（§7） | 验收记录 |

## 7. 验收标准

1. **出现**：冷启动（后端已热）可见 splash 并按设计动效呈现；与皮肤/壁纸/明暗一致（三主题 × 明暗抽查）；
2. **淡出**：shell 挂载后 ≤400ms 完成淡出，无「splash → 原生 → 外观」三段跳
   （boot style 继续兜底防闪色）；
3. **关掉即原生**：总开关关闭 / `bootSplash:'off'` ⇒ 首帧与原生 diff = 0（截图比对，同 M1 验收法）；
4. **错误页硬用例**：dsh web 返回 401（或后端起不来）⇒ splash 2.5s 内淡出，不挡提示；
5. **降级**：prefers-reduced-motion ⇒ 全部动效静止，功能不变；
6. **契约**：`test/` 新增用例（纯函数 shape / 门控 off 返回空串 / 脚本幂等守卫存在）；
   91+ 例既有单测全绿；`node ../scripts/verify-all.mjs appearance` 全过。

## 8. 风险与边界

- **官方改 index-inject**：S1 复测 + 契约自检黄条机制（M1 已有，缺插槽时黄条不崩溃）；
  review 记录显示 0.1.6 升级该事件未变（risk 低）；
- **z-index 战争**：2147483000 压壳但 splash 节点 `pointer-events:none`+短生命周期，
  不参与交互；官方弹窗理论上可能与 splash 共存 2.5s——目检项（验收 §7-1）；
- **双主题注入层共处**：splash 在三主题变量上叠 `--mia-bs-*`，与 desktop 让位协议
  不交叉（splash 不在桌面壳页运行）；
- **不做**：进度百分比（无真实进度数据，装饰性假进度违反「不假装」约定——
  只有流动三点不做百分比）；音效；外部字体/图片资产。
