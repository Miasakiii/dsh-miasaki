# assets/presets — 位图预设图标

本目录存放**位图预设**（与 `lib/icon-presets.js` 里程序化渲染的那批并列）。
两者的对外接口完全一致：host 拿到「预设 id」→ 得到一份 PNG 字节 → 落盘成
`<dataDir>/avatars/preset-<id>.png`，桌面壳照旧从 `avatars/` 目录读 —— **跨线契约一个字不用改**。

## portrait.png（「头像」预设）

| 项 | 值 |
|---|---|
| 来源 | 用户提供的图（原图 530×428 JPEG，圆角方形应用图标风格） |
| 当前产物 | 512×512 PNG（8 位调色板量化，quality 92 / dither 0.4，约 97 KB） |
| 入库时间 | 2026-09-21 |

**处理链**（原图边缘有一圈纯黑描边，必须先 trim 掉再裁方，否则图标会带黑边）：

```
trim(threshold 12)                    → 482×420（去掉四周黑边）
居中裁方                               → 420×420
resize 512×512 (cover)
圆角蒙版 rx = 512 × 0.235 = 120        → 与本仓 make-icons.mjs 同一倒角口径
png({ palette: true, quality: 92 })   → 97 KB（未量化时 471 KB，肉眼无差）
```

一次性的生成脚本没有入库（它依赖 `sharp`，而本线是**零第三方依赖**：`sharp` 只在
desktop 线的构建链里）。要换图或重做时，用任意带 `sharp` 的环境按上表参数重跑即可；
换新图后记得同步 `lib/icon-presets.js` 里该条的 `label`。

## 约束

- 文件名必须命中 `^[\w][\w.-]{0,80}\.png$`（跨线契约的白名单，见
  `../../../dsh-miasaki-shared-docs/cross/appearance-launcher-icon-2026-09-21.md`）；
- 只放 PNG（桌面壳只依赖 `png` crate，不引其它解码器）；
- 图标应是**正方形**且自带圆角透明边（桌面壳会再按中心裁方 + 缩放到 ≤256）。
