# 跨线契约 · 启动加载 2.0 与 Boot Splash（2026-09-22）

> 状态：**设计定稿（2026-09-22），待用户拍板实施**。一条需求、两条线、三个衔接点。
> 线级设计：[desktop 半](../../dsh-miasaki-desktop/design/boot-loading-terminal.md) /
> [appearance 半](../../dsh-miasaki-appearance/design/2026-09-22-appearance-boot-splash-design.md)。

## 1. 需求与分工（用户 2026-09-22 点名）

| 用户原话 | 落点 | 归属线 |
|---|---|---|
| 「现在的启动加载界面太简单不符合本项目」 | loading.html 2.0（纹章动效 + 阶段进度） | desktop |
| 「每次启动都会闪过终端窗口」 | `spawn_dsh()` 绕开 cmd 直达 node（先归因） | desktop |
| 「加载页直接把这个启动终端代码内置」 | dsh stdout tee → 页面内嵌日志流 | desktop |
| 「弄酷炫一点」 | 上两项视觉 + DSH 首帧启动画 | desktop + appearance |
| （外观线新项） | Boot Splash（index-inject 全屏层） | appearance |

**为什么必须两线**：loading.html 与 dsh 拉起在 Tauri 壳（Rust），appearance 是 DSH web 插件，
够不到 exe 启动前的页面；反之 DSH 首帧也只有 web 插件能注入。用户已拍板两线都做。

## 2. 三段时间线（各线负责段，边界清晰）

```
t0  Miasaki.exe 启动
│   [desktop] loading.html 可见（纹章 + 日志流 + 阶段进度）
├── dsh web 未起：spawn_dsh()（根治后：node bin.js web --no-open）
│   [desktop] 日志流实时滚动 dsh stdout
├── 3080 就绪 → navigate（loading 干净退场）
│   [appearance] boot style 防闪色（既有 M2）
│   [appearance] Boot Splash 全屏层（新）
├── shell 挂载（appearance client 装载）
│   [appearance] Splash 淡出 300ms 后 remove
└── DSH 界面可用
```

- 两段加载页**永不同框**（loading 是本地 App 页，splash 只活在 3080 文档）；
- 各自退场均「干净无接力」——loading 直接 navigate，splash 淡出即消失，不赌对方时序。

## 3. 衔接契约（唯二需要对齐的数值）

| # | 参数 | 约定 | 理由 |
|---|---|---|---|
| C1 | splash 超时兜底 | **2.5s** 无条件淡出 | ≥ desktop loading 正常就绪到 navigate 的时延；401/错误页不被挡（desktop P1「401 恢复指引」的前置） |
| C2 | 行序 | appearance 注入行顺序：boot script → boot style → splash style → splash html → splash script | 依赖 index-inject 各组按表顺序；实施时按 desktop/appearance 两线 S1 复测结果校准 |

- 除 C1/C2 外**零耦合**：任一线单独上线/回滚不影响另一线（契约自检黄条兜底）；
- 主题一致性（纹章 / wordmark / 字体栈）：两份线级设计各自规定同源设计语言，
  **不共享代码**（七线零代码耦合纪律；desktop 是 Rust+本地页，appearance 是 web 插件，
  物理上也不该共享）。

## 4. 故障矩阵（哪条线兜哪件事）

| 场景 | desktop 表现 | appearance 表现 |
|---|---|---|
| dsh 未安装 | 「未检测到 dsh」卡片 + 诊断按钮（既有） | 无关（到不了 3080） |
| dsh 启动失败/端口占用 | 90s 超时提示；日志流自动展开（ERROR 行） | 无关 |
| 3080 白屏/后端半死 | loading 已 navigate，靠既有 cookie 401 重签（P1 机制） | splash 2.5s 兜底淡出，露出真实页面态，**不假装成功** |
| 两线同时故障 | loading 仍在（诊断卡片） | 无 splash（配置/注入失败静默降级） |

## 5. 验证矩阵（实机项分工）

| 用例 | 谁验 | 记录去处 |
|---|---|---|
| 冷启动无闪窗（连续 5 次） | desktop | desktop 设计 §6-1 |
| 日志流滚动 / 阶段点亮 / 失败展开 | desktop | desktop 设计 §6-2/3 |
| splash 三主题×明暗目检 | appearance | appearance 设计 §7-1 |
| splash 淡出 ≤400ms、无三段跳 | appearance | appearance 设计 §7-2 |
| 401 首帧不被 splash 挡（2.5s 兜底） | **联合**（appearance 触发、desktop 现场配合） | appearance 设计 §7-4 |
| 总关断 diff=0 | appearance | appearance 设计 §7-3 |
| cmd 兜底回退（shim 解析失败模拟） | desktop | desktop 设计 §6-4 |

联调用例仅 §5 倒数第三行一条，需要两线都在场；其余各自独立验，回归不互相阻塞。

## 6. 实施顺序建议

两线**并行**，C1/C2 先对齐（本文件即契约）。建议排期：

1. desktop S1（闪窗归因）+ appearance S1（index-inject 复测）——互不依赖，可同时；
2. desktop S2–S4 与 appearance S2–S4 并行推进；
3. 联合验收（§5 联流行）+ 各自回归。

任一线延期不影响另一线单独上线（除 §5 联流行延后外无损失）。
