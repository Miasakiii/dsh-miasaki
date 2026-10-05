# 第三方素材声明（启动片头）

本目录下的四段 mp4 为**第三方素材**，非本仓库原创。

| 项 | 内容 |
|---|---|
| 来源仓库 | [NativeDog1/dsh-boot-animation](https://github.com/NativeDog1/dsh-boot-animation) |
| 来源 tag | `v0.4.2`（`media/` 目录） |
| 上游作者 | NativeDog1 |
| 许可 | BSD-3-Clause（见上游 LICENSE；上游 README「许可」节明示包内 `lib/clips.data.js` 的内嵌片源以相同条款分发） |
| 引入日期 | 2026-10-05 |
| 引入方式 | `scripts/extract-intro-clips.mjs`（SHA256 台账校验后入库，见该脚本头注释） |

## 文件

| 本仓文件 | 上游文件 | 字节数 | SHA256 前 16 位 |
|---|---|---|---|
| `intro-brand.mp4` | `deepseek-brand-intro.mp4` | 1,308,725 | `b22de4810e195b50` |
| `intro-cyberpunk.mp4` | `deepseek-cyberpunk-intro.mp4` | 1,856,280 | `beabf5956e0b467e` |
| `intro-awakening.mp4` | `deepseek-awakening-intro.mp4` | 2,600,325 | `ff5afe0dabc16e09` |
| `intro-startup.mp4` | `deepseek-startup-intro.mp4` | 3,305,269 | `ba72c501021444cd` |

## 使用范围与边界

- 仅作为 Miasaki 桌面端**本地启动片头**播放（不联网、不再分发、不商用）；
- 上游代码许可为 BSD-3-Clause；本仓**未复用其代码**，仅取素材，故不涉及源码派生；
- 素材原样保留（未做重编码 / 剪辑），字节级与上游一致（可经 `node scripts/extract-intro-clips.mjs --check` 复核）；
- 若上游作者要求撤下，删除本目录四段并清空 `<dshHome>/miasaki-appearance/config.json` 的
  `boot.intro` 即可（行为自动回落到纹章动效层）。
