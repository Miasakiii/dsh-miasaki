# DSH 消息图片画廊「宽高比保持」运行时补丁

> 修用户报的「图片显示的问题」：消息里连发多张截图时，官方画廊把每张图都渲染成
> **固定 64×64 且 `object-fit:cover`** 的方片 —— 宽高比偏离 1:1 的图被裁得只剩一小块
> （716×34 的红条截图只剩原图 1/21 被放大显示，完全无法辨认；84×32 / 70×36 的小截图
> 同样面目全非）。补丁把多图 tile 改为**按原始宽高比显示**。
>
> 单图场景不受影响：官方对单图本就有 `singleFit`（长边 240 + 比例 clamp）。

## 为什么是「运行时补丁」而不是插件

这是官方组件的**显示缺陷**（不是可插拔功能），且修复位置在 DMH 本体包的编译产物里。
本机没有 pnpm 全量重建链路，「fork 官方包 + 重建 dist」走不通，
因此与既有五件 DSH 本体补丁同一范式：**直接改写已安装包的 `lib/client.js`**，
补丁规则 + baseline 进版本控制，升级后能重建、能校验、能回退。

**代价**：DSH 升级会覆盖该包，补丁随之消失，需要重新应用（见下文「DSH 升级后怎么办」）。
改的是 `@deepseek-ai/dsh-client-ui-attachment` 这一个包，不碰 DSH 源码与其他包。

## 补丁做了什么（2 条唯一子串替换）

CSS 位于 bundle 第 766 行的 `MessageImage.module.css` 字面量（minified 单行，
故用子串替换而非行级编辑；每条 `from` 必须恰好命中一次，否则报错而非瞎改）：

| # | 原来 | 改为 | 效果 |
|---|---|---|---|
| `gallery-tile-size` | `.R_Yw7q_frame[data-variant=tile]{width:64px;min-width:64px;height:64px;min-height:64px}` | `width:auto;min-width:44px;max-width:220px;height:64px;min-height:64px` | tile 高仍 64，宽按图片宽高比自适应（44–220） |
| `gallery-tile-fit` | `.R_Yw7q_frame img{object-fit:cover;width:100%;height:100%;display:block}`（其后追加一条 tile 专用规则） | 追加 `.R_Yw7q_frame[data-variant=tile] img{object-fit:contain;width:auto;height:100%;max-width:220px}` | tile 内图**完整显示**，不再裁切 |

尺寸推导（height:100% = 64 内容高，width:auto 按 natural 比例）：

| 原图 | 修前 | 修后 |
|---|---|---|
| 716×34（21:1 红条） | 64×64 方块，cover 只显示 1/21 | 220×64，contain 完整（220×10.5 居中） |
| 84×32（2.6:1） | 64×64 方块 | 165×64，完整 |
| 70×36（1.94:1） | 64×64 方块 | 123×64，完整 |
| 16:9 常规横图 | 64×64 方块 | 114×64（contain 与 cover 等价，无留白） |
| 1:1 方图 | 64×64 | 64×64（不变） |

## 边界（勿越线）

- 只改 `@deepseek-ai/dsh-client-ui-attachment` 的 client 产物；
- **纯 CSS**，不碰渲染逻辑 —— 单图 `singleFit`、缩略图 `thumbnail` 变体
  （48px，本就 contain）、点击查看原图（`ImageLightbox`）全部不受影响；
- 与既有五件本体补丁（settings-models / chat / conversation / trajectory /
  cordis-host-runner）各自独立：锚点、baseline、CLI 与 `verify` 互不依赖。

## 用法

```powershell
cd dsh-miasaki-desktop/patches/dsh-client-ui-attachment

node patch.mjs verify            # 离线自检：baseline 原始 → 重建 → 逐字节比对 + 语法闸门 + 常量自洽
node patch.mjs status            # 已安装 bundle 的补丁状态与语法状态
node patch.mjs apply             # 备份 + 应用（幂等）
node patch.mjs resync            # 由 .dsh-bak 重打（apply 幂等跳过时的正确重打姿势）
node patch.mjs revert            # 从 .dsh-bak 还原
node patch.mjs rebuild           # 改过 EDITS 后：由 baseline 原始文件重建 golden 产物
```

> **改了 `EDITS` 之后的标准动作**：`node patch.mjs rebuild` → 把打印出的
> `PATCHED_SHA256` 写回 `patch.mjs` → `node patch.mjs verify`（三行 PASS）→ `apply`。
>
> **产物不变量**（沿袭 settings-models 补丁的纪律）：① 锚点子串唯一命中；
> ② 产物必须过 `vm.Script` 语法闸门 —— 多包合并 bundle 里一个包语法坏了会让
> 整份 bundle 不注册、页面所有插件一起失效；③ `PATCHED_SHA256` 常量与产物一致，
> 防「改了规则重生成 golden 却忘同步常量」的静默漂移。

## DSH 升级后怎么办

1. `node patch.mjs status` —— `unknown` 即安装的是新版本，补丁已被覆盖；
2. 用 `baseline/client.original.js` ↔ 新版 client.js 做 diff，核对两条锚点是否仍在
   （锚点漂移时 `patch.mjs` 会明确报错，不会静默改错）；
3. 锚点漂移则更新 `EDITS` 与两份 baseline，`verify` 自证后 `apply` 重打；
4. 刷新页面生效（`client-hmr` 每 500ms stat，命中变化即热推 rebuilt 帧；
   host 启动晚于补丁写入则启动快照即补丁）。

> **实操记录（2026-09-23，DSH 0.1.7-alpha.2）**：官方原版 48,479 B，
> SHA-256 `397B4947…`；补丁产物 48,590 B，SHA-256 `381D2676…`（+111 B = 两条 CSS 差值）。
> `verify` 三行 PASS；`apply` 后 playwright 实机（桌面壳 WebView2 同源的 127.0.0.1:3080）
> 验证：三张实测截图 tile 分别由 62×62 变为 220×64 / 165×64 / 123×64，
> `object-fit` 全部 `contain`，无新增 console/page 错误。

## 相关文档

- 用户反馈物证：本仓会话「修复图片显示问题」的三张实机截图（红条 ResizeObserver 提示、
  多图 62×62 方块现场两幅）；
- desktop 线 README「DSH 本体补丁」总表与 `design/CHANGELOG.md` 均有本次登记。
