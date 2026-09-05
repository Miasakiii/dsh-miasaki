# themes/src/ — 注入运行时分片（D1 拆分）

`themes/runtime.js` 1100 行单文件已按顺序切分为 9 片，拼接顺序见 `MANIFEST.json`。
拼接结果与 legacy `themes/runtime.js` 逐字节一致（切分时校验 `identical: True`）。

| 分片 | 行段 | 职责 |
|---|---|---|
| `00-boot.js` | 1–46 | IIFE 开头、错误陷阱、STYLES/META/TIPS/FORCE_DARK/PET_MODES |
| `01-persona.js` | 47–124 | 人格会话联动（RPC session.create + toast） |
| `02-core.js` | 125–272 | hash 同步通道、notifyPet、IS_LOCAL、apply 定律 |
| `03-switcher.js` | 273–534 | 悬浮切换条 CSS + 构建/交互 |
| `04-deco.js` | 535–637 | 水印 SVG、aurora 光晕、ICON_BASE、字形兜底 |
| `05-sensors.js` | 638–786 | 强度/活动/审批扫描 + 防抖 + `__miasakiProbe` |
| `06-titlebar.js` | 787–899 | 自绘标题栏 + 最大化同步 |
| `07-dialog-geom.js` | 900–1045 | 关闭确认弹窗 + 侧栏几何帧同步 |
| `08-ready.js` | 1046–1100 | onReady 启动 + 1s 自愈巡检 + IIFE 结尾 |

编辑纪律：改对应分片即可，勿手改 `src-tauri/injected/theme-init.js`（构建产物）；
`themes/runtime.js` 保留为回退源，`build-init.mjs` 优先读 `src/`。
