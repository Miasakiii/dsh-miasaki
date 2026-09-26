# themes/src/ — 注入运行时分片（D1 拆分，source of truth）

`themes/runtime.js` 1100 行单文件已按顺序切分为 **13 片**，拼接顺序见 `MANIFEST.json`
（`order` 是唯一事实源：`build-init.mjs` 只按它拼接，不扫描目录）。
`build-init.mjs` 优先读 `src/`（缺 `src/` 时回退 legacy `themes/runtime.js`）。
注意：2026-09-05 标题栏 v2/v3 改版后 `src/` 与 legacy 已**不再逐字节一致**
（legacy 仅作缺 `src/` 时的回退，行为偏旧）。

**作用域结构**：`00-boot.js` 开启大 IIFE，`01`–`08` **寄生其中并共享作用域**，由
`08-ready.js` 末尾 `})()` 闭合；`09-dropguard.js` 与 `10-contract.js` 是**各自独立的 IIFE**，
不共享作用域。新增分片前先决定它属于哪一类（寄生片可复用 `current`/`petHashCmd` 等闭包变量，
独立片只能靠 DOM 属性与事件）。漏登记进 `MANIFEST.order` 会被 `build-init.mjs` 判失败
（W0-T0.4 漏登记防护）。

| 分片 | 行段(legacy 参考) | 职责 |
|---|---|---|
| `00-boot.js` | 1–46 | IIFE 开头、错误陷阱、STYLES/META/TIPS/FORCE_DARK、鉴权 cookie 注入 |
| `01-persona.js` | 47–124 | 人格会话联动（派发 `miasaki-persona-request`；创建/去重/toast 由 dsh-pet-panel 插件完成） |
| `02-core.js` | 125–272 | hash 同步通道、主题来源优先级（`__MIA_THEME__` > URL > localStorage）、IS_LOCAL、apply 定律 |
| `03-switcher.js` | 273–534 | 切换条/标题栏/关闭弹窗 CSS + 切换条构建与交互 |
| `04-deco.js` | 535–637 | 水印 SVG、aurora 光晕、ICON_BASE、字形兜底 |
| `05-sensors.js` | 638–786 | 强度/活动/审批扫描 + 防抖 + `__miasakiProbe` + hash 字段级读写（`setHashFields`/`petHashCmd`） |
| `06-titlebar.js` | 787–899 | 窗控胶囊 + 空白拖动 + 最大化同步 + **让位量自动化**（2026-09-27：`ResizeObserver` 观测 `.tb-group` 实宽 → 写 `--ms-titlebar-reserve`，**壳在位时壳是唯一写者**；旧壳（无 `chrome.bounds` 能力）由注入方按同源公式兜底，见 `03-switcher.js:89` 与 `design/desktop-contract.md` 的注入方契约） |
| `07-dialog.js` | 900–1045 | 关闭确认弹窗（原 07-dialog-geom.js，侧栏几何同步已随 v2 移除） |
| `08-ready.js` | 1046–1100 | onReady 启动 + 1s 自愈巡检 + **大 IIFE 结尾** |
| `09-dropguard.js` | —（2026-09-24 新增） | 拖放安全网（独立 IIFE；`design/drag-drop-attachment-upload.md`） |
| `10-contract.js` | —（2026-09-25 新增） | 桌面壳↔渲染层契约 **v1.2** `window.miasakiDesktop`（独立 IIFE；读能力 + 订阅 + **受控写能力**：写一律派发内部事件，由 `02-core`/`06-titlebar` 执行 —— 契约自己不碰 hash，写者数量不变；**v1.2 增 `chrome.bounds()`/`chrome.onChange()`** 暴露壳窗控组矩形；`design/desktop-contract.md`） |
| `11-console.js` | —（2026-09-25 新增） | 渲染层 console 错误旁路 → 诊断报告的 `--- renderer console ---` 段（独立 IIFE；环形 50 条 + 2s 节流、只顶层 frame、与红条同判据过滤 `ResizeObserver` 噪声） |
| `12-material.js` | —（2026-09-25 新增） | 原生材质事实落地 `html[data-mia-native-mica="on\|off"]`（独立 IIFE；**壳说事实、外观线选分支**，消除外观线 `mica` 档与原生 Mica 的双层模糊） |

编辑纪律：改对应分片即可，勿手改 `src-tauri/injected/theme-init.js`（构建产物）；
`themes/runtime.js` 保留为回退源，`build-init.mjs` 优先读 `src/`。
