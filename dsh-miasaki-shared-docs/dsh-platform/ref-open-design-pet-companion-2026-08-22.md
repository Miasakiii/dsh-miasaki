# OpenDesign 宠物伴侣（Pet Companion）体系学习参考

> 来源：`nexu-io/open-design`（main，v0.20.2 同期），2026-08-22 学习整理。
> 这是一次「外部项目解剖」：OpenDesign 将 Codex `hatch-pet` 体系接入自家桌面应用的
> 完整链路（契约 → 发现 → 渲染 → 交互 → 任务联动 → 孵化）。
> 本文同时给出对 `dsh-miasaki-desktop`（Tauri 2 + Win32 桌宠）的可迁移启发。

## 0. 一句话画像

OpenDesign 桌面端悬浮一只「数字宠物」：它不是独立的桌宠应用，而是
**宿主应用的一个常驻浮层组件**（`PetOverlay`），动画资产来自开源 Codex
`hatch-pet` 技能的产物（8×9 spritesheet atlas），通过一个简单目录契约
（`pets/<id>/{pet.json, spritesheet.*}`）被 daemon 扫描发现，Web 端提供
「收养 / 最近孵化」面板。宠物会做一件对用户有用的事：**汇总任务中心**
（running / queued / recent 分组气泡 + 未读角标），让「可爱」承载信息。

## 1. 契约层：目录即身份，atlas 是硬规格

```
${CODEX_HOME:-~/.codex}/pets/<pet-id>/
  pet.json          # { id, displayName, description, spritesheetPath }（全部可选）
  spritesheet.webp  # 1536×1872，8列×9行，每格 192×208（.png / .gif 亦接受）
```

**atlas 行语义（`codexAtlas.ts`，稳如磐石的规格）**：

| 行 | id | 帧数 | fps | 语义 |
|---|---|---|---|---|
| 0 | idle | 6 | 6 | 待机基线 |
| 1 | running-right | 8 | 8 | 向右跑 |
| 2 | running-left | 8 | 8 | 向左跑（可由右镜像） |
| 3 | waving | 4 | 6 | 挥手（hover/向下拖） |
| 4 | jumping | 5 | 7 | 跳（向上拖） |
| 5 | failed | 8 | 7 | 失败（负叙事，不进环境池） |
| 6 | waiting | 6 | 6 | 长时间闲置 |
| 7 | running | 6 | 8 | 通用跑 |
| 8 | review | 6 | 6 | 检查 |

关键设计决策：

- **文件夹名是身份**，manifest 的 `id` 只是展示用；daemon 两侧都用
  sanitize 后的文件夹名作为公开 `id`，manifest typo 不会 404 下载路由。
- manifest 全部字段可选、防御式读取（非字符串即忽略）；手放一个文件夹
  也能显示（displayName 从目录名 pretty 化）。
- `spritesheetPath` 相对宠物目录解析，**越出目录直接拒绝**；
  缺省回退链 `spritesheet.webp → .png → .gif`。
- `looksLikeCodexAtlas`：只按宽高比（±6%）判定是否是 Codex atlas，
  容忍传输重采样，拒绝普通截图。

## 2. 发现层：双根扫描 + 防逃逸 + 排序语义

`apps/daemon/src/codex-pets.ts`（278 行，无第三方依赖）：

- **双根**：用户 `~/.codex/pets/` 优先（本地 re-bake 覆盖内置），内置
  `assets/community-pets/` 兜底；两次扫描共用一个 `seenIds` 去重。
- **bundled 标记独立于来源目录**：按「是否属于 curated 集合」判定，
  而不是「从哪个目录读出来的」——用户全量同步了社区宠物后，
  「内置」标签页不会因此变空。
- **惰性扫描**：每次 list 请求都扫（宠物就几十个），不做文件监听，
  省掉 daemon 侧 watcher 依赖。
- **排序按 mtime 倒序**：`hatchedAt` = spritesheet 的 mtime，保证
  「最近孵化」槽位诚实（2024 年的内置宠物沉底，今早孵的置顶）。
- **id sanitize（安全关键）**：去非法字符 → 折叠点号 → 剥离首尾点/横线
  → 80 字符上限 → 残留 `..` 即拒绝。下载路由用同一个 sanitize，
  用户无法 path-escape 到任意目录。

## 3. 数据与渲染层：四种渲染形态 + 自愈迁移

`pets.ts` + `PetSpriteFace.tsx`：

- **四路渲染**：① emoji 字形（旧内置/纯文本）② 全 atlas（8×9，行由
  interaction 驱动）③ 横向 strip（CSS `steps(n, jump-none)`）④ 静态图。
- **客户端 sanitize（`sanitizeAtlas`）**：非法行剔除、index 越界丢弃、
  行去重、frames/fps 钳制（frames 1–24 / fps 1–30）——渲染器永远不
  需要防御 NaN。
- **atlas 帧驱动用 JS `setInterval` 而非 CSS `steps()`**：绕开
  jump-end/jump-none 的切片坑，且换行（idle↔waving 切换）时
  fps 可随行变化、帧索引重置为 0（动画干净起播）。
- **background 数学**：`background-size = cols×100% / rows×100%`；
  `position-x = frame/(cols-1)×100%`；`position-y = rowIndex/(rows-1)×100%`。
- **行查找有 fallback 链**：请求行 → idle → waiting → waving → running →
  running-right → 第一行——部分填充的 atlas 永不空白。
- **自愈迁移**：旧版本把 atlas 裁成单行 strip 存进配置；新渲染器发现
  `imageUrl 有但 atlas 无` 时，按名称匹配注册表、静默重下载全 atlas
  （`migrateCustomPetAtlas`），用户无感知地从「雕像」变「全动画」。

## 4. 交互层：行切换 = 动画状态机

`PetOverlay.tsx`（644 行）：

- **声明式映射**：`idle→idle`、`hover→waving`、`drag-right→running-right`、
  `drag-left→running-left`、`drag-up→jumping`、`drag-down→waving`、
  `waiting→waiting`。交互状态集刻意收窄，保证映射是表格而非条件乱麻。
- **拖拽**：pointer capture；起步抖动用「曼哈顿距离 <4px 不算拖动」；
  方向判定阈值 14px + 轴偏置 1.18（对角拖不闪行）；动画粘住直到
  反向越阈；拖完停 → 若 hover 则 waving，否则 idle。
- **拖拽边界**：以 right/bottom 锚定窗口角（右下 24px 起），clamp 预算
  ~120px 保证 96px 精灵贴角不丢；位置持久化 localStorage
  （`open-design:pet-position`），轮询 storage 事件同步多窗口。
- **waiting 计时**：45s 无交互 → 从 idle 升 waiting 行（仅在基线为
  idle 时升级，活动中的拖拽不会被打断）。
- **环境编排（ambient choreography）**——「宠物有自己的生活」的
  精髓：idle 时随机从池 `waving/review/jumping/running/running-*`
  （**排除 idle/waiting/failed**，failed 是负叙事、waiting 专留长闲）挑
  一行演一小段：play 1.4–2.3s（随机）+ rest 9–18s（随机），两个窗口都
  随机化防机械感；任何用户手势立即取消当前 beat（effect 按
  `interaction === 'idle'` 作用域，cleanup 即刻切回）。
- **物理语感参数**：初始延迟 4–7s（刚醒不立刻做戏）、waiting 45s、
  拖拽 jitter 4px、方向阈值 14px/1.18。

## 5. 任务中心联动：宠物 = 状态聚合器

`taskCenter.ts` + `DesktopPetSurface.tsx`：

- 每 2s 轮询 + `RUNS_CHANGED_EVENT` 事件驱动刷新；config 1.5s 轮询 +
  storage 事件。
- 聚合语义：按项目聚合 running / queued（count 累加，排序 count 降序
  → 名称）；recent 只留终态（succeeded/failed/canceled）、每项目一条、
  按 updatedAt 排序取前 3。
- **`incomplete` 单独成类**：`succeeded` 但「声明的工作没做完」的 run
  不能渲染成成功色点（#1247/#1060 的教训）——成功≠靠谱。
- 未读确认队列：recent 任务出现 → 角标；点开气泡 → 移入 viewing 集合；
  关闭不再作为「未读」重放。
- 气泡内容优先级：任务摘要行 > 环境名言（内置 6 条名人名言轮播）>
  宠物问候。
- 宿主集成：`DesktopPetSurface`（独立窗壳，`body.desktop-pet-shell`）
  通过 `@open-design/host` 的 `setHostPetVisible` 控制宿主侧宠物显隐；
  `dockLine` 模式让宠物「站在标签栏线上」——top 锚定、只允许横向拖动、
  垂直余位锁定，气泡向下生长。

## 6. 孵化链（生成侧）：skill + 确定性脚本 + 硬边界

`skills/hatch-pet/`（vendored 自 openai/skills curated 版）：

- 组织：`SKILL.md`（23.8KB，frontmatter 含 triggers 双语——
  「孵化宠物/电子宠物」）+ `references/{animation-rows,codex-pet-contract,qa-rubric}.md`
  + `agents/openai.yaml` + `scripts/`（16 个 Python，只做确定性工作）+
  `LICENSE.txt`（原许可保留，UI 里注明 upstream 出处）。
- **生成委托硬边界**：视觉一律走 `$imagegen` 系统技能，**禁止**本地
  Pillow/SVG/canvas 代画视觉；行生成必须带 grounding 参考图（仅 base
  允许纯 prompt）；`running-left` 只能镜像 `running-right` 且须人工检查
  批准；不允许篡改 job 清单伪造「已完成」。
- **风格契约**（Codex 数字宠物风）：小 chibi 比例、厚重可读轮廓、
  1–2px 深色描边、可见像素阶梯、受限色板、平涂 cel 着色、简单表情；
  明确拒绝插画/写实/3D/渐变/高细节。
- **透明与特效规则**：192×208 单元内 chroma-key 可清理；允许的特效
  必须贴附本体、在同一帧槽、不透明硬边、像素风、小到 192×208 可读。
- **QA 输出**：contact-sheet.png（多行拼图）+ 预览视频 mp4 + 校验脚本
  `validate_atlas.py`；产出 `final/spritesheet.png|webp` + `pet.json`。

## 7. 对 dsh-miasaki-desktop 的可迁移启发

对照现状：本仓桌面线是 Tauri 2 + Win32 原生桌宠（`themes/`、`scripts/`
cut-frames 构建链、`preset-sources/` persona+preset.yml），
骨架完全不同（原生窗口 vs Web 浮层），但以下设计思想可直接借用：

| 主题 | OpenDesign 做法 | 建议借用点 |
|---|---|---|
| 动画规格契约化 | 8×9/192×208/行语义/帧数/fps 写成常量表 + 文档 | `scripts/` 生成帧时对照一份「行语义表」，preset 增删动画行有据可依 |
| 行 = 状态机 | interaction → 行 是单张声明表 + fallback 链 | 桌宠状态（待机/跟随/拖拽/等主人）映射帧组，表驱动而非散落 condition |
| 帧驱动 | JS interval（非 CSS steps），换行重置帧 | Win32 下自己管定时器，注意重置帧偏移 |
| 环境编排 | 随机 play/rest 窗口、排除负叙事行、手势即打断 | 「狂三会自己挥手/转动时钟」的低频随机节拍（1.5–2.5s 演 + 10–18s 歇） |
| 交互阈值 | 4px 抖动 / 14px 方向 / 1.18 轴偏置 | 拖拽判定直接抄参数，手感更稳 |
| 参数钳制 | frames 1–24、fps 1–30、atlas 客户端 sanitize | `preset.yml` 加载时防御式校验，坏配置不崩渲染 |
| 发现即身份 | 文件夹=sanitize id；manifest 全可选 | 主题/宠物目录做「懒扫描 + 容错 manifest」 |
| 安全 | sanitize 两侧一致、路径拒绝逃逸 | 主题加载的路径处理隔离 |
| 自愈迁移 | 旧配置按名称匹配重下载升级 | `preset.yml` 版本号 + 迁移函数，老 preset 静默升级 |
| 状态聚合 | running/queued/recent + **incomplete≠succeeded** | 桌宠「任务汇报」语义：未完成声明工作不可报喜 |
| 生成边界 | 视觉委托 $imagegen、禁止本地代画、QA contact sheet | 桌宠新表情资产的产线应保持「生成→QA→打包」三段，禁止脚本伪造美术 |
| 文档先于实现 | references 契约 + qa-rubric + 例程里写明上游出处 | 新动画行先定契约再开工，attribute 上游（如 guizang-ppt 先例已在做） |

## 8. 关键文件索引（上游仓库）

| 层 | 文件 |
|---|---|
| 文档 | `docs/codex-pets.md` |
| daemon 扫描/校验 | `apps/daemon/src/codex-pets.ts` |
| 路由 | `apps/daemon/src/server.ts`（`GET /api/codex-pets`、`/api/codex-pets/:id/spritesheet`） |
| atlas 规格与裁剪 | `apps/web/src/components/pet/codexAtlas.ts` |
| 前端模型/交互映射 | `apps/web/src/components/pet/pets.ts` |
| 浮层交互 | `apps/web/src/components/pet/PetOverlay.tsx` |
| 帧渲染 | `apps/web/src/components/pet/PetSpriteFace.tsx` |
| 任务中心聚合 | `apps/web/src/components/pet/taskCenter.ts` |
| 宿主表面 | `apps/web/src/components/pet/DesktopPetSurface.tsx` |
| 孵化 skill | `skills/hatch-pet/`（SKILL.md + references/ + scripts/） |
| 社区目录同步 | `scripts/sync-community-pets.ts` |
