# assets/presets — 位图预设图标

本目录存放**位图预设**（与 `lib/icon-presets.js` 里程序化渲染的那款并列）。
两者的对外接口完全一致：host 拿到「预设 id」→ 得到一份 PNG 字节 → 落盘成
`<dataDir>/avatars/preset-<id>.png`，桌面壳照旧从 `avatars/` 目录读 —— **跨线契约一个字不用改**。

当前三款位图预设都是**鲸鱼娘**（同角色、不同构图），用户随场景挑：

| 文件 | 预设 | 来源 |
|---|---|---|
| `portrait.png` | 头像 | 用户 2026-09-21 提供的图（原图 530×428 JPEG，圆角方形应用图标风格） |
| `illustration.png` | 立绘 | 用户 2026-09-23 提供的图（原图 1254×1254 JPEG，蓝天底竖构图） |
| `current.png` | 现行 | 现行 EXE 图标同款艺术图 `src-tauri/icon-new.png`（1024×1024，desktop 线构建链输入） |

三项产物统一为 **512×512 PNG（8 位调色板量化，quality 92 / dither 0.4，61–134 KB）**。

## 处理链

原图带纯色描边时必须**先 trim** 再裁方（把黑边当白色做"自动裁边"会判断错，
当年 portrait 的源图四角像素是 `0,0,0`，实测踩过）：

```
trim(threshold 12)                    → 去掉四周黑边（满幅方图无需此步）
居中裁方                               → portrait 420×420；两款方图即全图
resize 512×512 (cover, lanczos3)
圆角蒙版 rx = 512 × 0.235 = 120        → 与本仓 make-icons.mjs 同一倒角口径
png({ palette: true, quality: 92, dither: 0.4 })   → 未量化时数百 KB，量化后肉眼无差
```

| 文件 | trim | 居中裁方 | 产物 |
|---|---|---|---|
| portrait.png | 482×420 | 420×420 | 133,757 B |
| illustration.png | —（满幅方图） | 1254×1254 | 62,545 B |
| current.png | —（满幅方图） | 1024×1024 | 122,789 B |

一次性的生成脚本没有入库（它依赖 `sharp`，而本线是**零第三方依赖**：`sharp` 只在
desktop 线的构建链里）。2026-09-23 那次生成的脚本归档在
`_refs/scripts-archive/make-icon-presets-2026-09-23.mjs`（本地留档，不入库）；
要换图或重做时，用任意带 `sharp` 的环境按上表参数重跑即可；
换新图后记得同步 `lib/icon-presets.js` 里该条的 `label`。

## 约束

- 文件名必须命中 `^[\w][\w.-]{0,80}\.png$`（跨线契约的白名单，见
  `../../../dsh-miasaki-shared-docs/cross/appearance-launcher-icon-2026-09-21.md`）；
- 只放 PNG（桌面壳只依赖 `png` crate，不引其它解码器）；
- 图标应是**正方形**且自带圆角透明边（桌面壳会再按中心裁方 + 缩放到 ≤256）。
