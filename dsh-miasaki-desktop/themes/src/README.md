# themes/src/ — 注入运行时分片（D1 拆分，source of truth）

`themes/runtime.js` 1100 行单文件已按顺序切分为 9 片，拼接顺序见 `MANIFEST.json`。
`build-init.mjs` 优先读 `src/`（缺 `src/` 时回退 legacy `themes/runtime.js`）。
注意：2026-09-05 标题栏 v2/v3 改版后 `src/` 与 legacy 已**不再逐字节一致**
（legacy 仅作缺 `src/` 时的回退，行为偏旧）。

| 分片 | 行段(legacy 参考) | 职责 |
|---|---|---|
| `00-boot.js` | 1–46 | IIFE 开头、错误陷阱、STYLES/META/TIPS/FORCE_DARK/PET_MODES、鉴权 cookie 注入 |
| `01-persona.js` | 47–124 | 人格会话联动（派发 `miasaki-persona-request`；创建/去重/toast 由 dsh-pet-panel 插件完成） |
| `02-core.js` | 125–272 | hash 同步通道、notifyPet、IS_LOCAL、apply 定律 |
| `03-switcher.js` | 273–534 | 切换条/标题栏/关闭弹窗 CSS + 切换条构建与交互 |
| `04-deco.js` | 535–637 | 水印 SVG、aurora 光晕、ICON_BASE、字形兜底 |
| `05-sensors.js` | 638–786 | 强度/活动/审批扫描 + 防抖 + `__miasakiProbe` |
| `06-titlebar.js` | 787–899 | 窗控胶囊 + 空白拖动 + 最大化同步 |
| `07-dialog.js` | 900–1045 | 关闭确认弹窗（原 07-dialog-geom.js，侧栏几何同步已随 v2 移除） |
| `08-ready.js` | 1046–1100 | onReady 启动 + 1s 自愈巡检 + IIFE 结尾 |

编辑纪律：改对应分片即可，勿手改 `src-tauri/injected/theme-init.js`（构建产物）；
`themes/runtime.js` 保留为回退源，`build-init.mjs` 优先读 `src/`。
