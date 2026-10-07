# 第三方素材声明（启动片头）

本目录下的七段 mp4 为**第三方素材**，非本仓库原创。分两批引入、两种许可：

| 批 | 段 id | 上游 | 许可 |
|---|---|---|---|
| 第一批（2026-10-05） | `brand` / `cyberpunk` / `awakening` / `startup` | [NativeDog1/dsh-boot-animation](https://github.com/NativeDog1/dsh-boot-animation) | BSD-3-Clause |
| 第二批（2026-10-08） | `dreamsea` / `lagoon` / `bubbles` | [lxj5820/dsh-boot-animation](https://github.com/lxj5820/dsh-boot-animation) | MIT |

## 第一批（brand / cyberpunk / awakening / startup）

| 项 | 内容 |
|---|---|
| 来源仓库 | [NativeDog1/dsh-boot-animation](https://github.com/NativeDog1/dsh-boot-animation) |
| 来源 tag | `v0.4.2`（`media/` 目录） |
| 上游作者 | NativeDog1 |
| 许可 | BSD-3-Clause（见上游 LICENSE；上游 README「许可」节明示包内 `lib/clips.data.js` 的内嵌片源以相同条款分发） |
| 引入日期 | 2026-10-05 |
| 引入方式 | `scripts/extract-intro-clips.mjs`（SHA256 台账校验后入库，见该脚本头注释） |

### 文件

| 本仓文件 | 上游文件 | 字节数 | SHA256 前 16 位 |
|---|---|---|---|
| `intro-brand.mp4` | `deepseek-brand-intro.mp4` | 1,308,725 | `b22de4810e195b50` |
| `intro-cyberpunk.mp4` | `deepseek-cyberpunk-intro.mp4` | 1,856,280 | `beabf5956e0b467e` |
| `intro-awakening.mp4` | `deepseek-awakening-intro.mp4` | 2,600,325 | `ff5afe0dabc16e09` |
| `intro-startup.mp4` | `deepseek-startup-intro.mp4` | 3,305,269 | `ba72c501021444cd` |

## 第二批（dreamsea / lagoon / bubbles）

| 项 | 内容 |
|---|---|
| 来源仓库 | [lxj5820/dsh-boot-animation](https://github.com/lxj5820/dsh-boot-animation) |
| 来源 tag | `v0.2.0`（`assets/videos/` 目录，上游文件名 `1.mp4` / `2.mp4` / `3.mp4`） |
| 上游作者 | lxj5820 |
| 许可 | MIT（上游 LICENSE 原文：「The three `.mp4` files are the author's own animation work and are distributed under the same MIT terms as the code.」——Copyright (c) 2026 dsh-boot-animation contributors；本声明即 MIT 要求的版权与许可声明随附） |
| 引入日期 | 2026-10-08 |
| 引入方式 | 同第一批（`scripts/extract-intro-clips.mjs`）；上游无官方 meta 可对，**SHA256 以下载字节实测为台账** |

### 文件

| 本仓文件 | 上游文件 | 字节数 | SHA256 前 16 位 |
|---|---|---|---|
| `intro-dreamsea.mp4` | `1.mp4` | 8,391,471 | `970afeb9b8a981de` |
| `intro-lagoon.mp4` | `2.mp4` | 11,065,265 | `95794b99c3ae4c36` |
| `intro-bubbles.mp4` | `3.mp4` | 5,195,581 | `585143d714778d48` |

三段内容实测（2026-10-08）：深海环境下、蓝发女仆装动漫少女、气泡与穿透水面的光束，
梦幻唯美风格，**无文字 / 无水印**；1280×720 H.264 + AAC，`moov` 均已前置。

## 使用范围与边界（两批共通）

- 仅作为 Miasaki 桌面端**本地启动片头**播放（不联网、不再分发、不商用）；
- 两批均**只取素材、未复用其代码**，不涉及源码派生；
- 素材原样保留（未做重编码 / 剪辑），字节级与上游一致（可经 `node scripts/extract-intro-clips.mjs --check` 复核）；
- 若上游作者要求撤下，删除本目录对应段并清空 `<dshHome>/miasaki-appearance/config.json` 的
  `boot.intro` 即可（行为自动回落到纹章动效层）。
