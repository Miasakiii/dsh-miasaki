# 桌宠 v4 · Computer Use 集成评估（2026-09-27）

> 状态：**评估完成，待拍板**。本文登记 [deepseek-harness-orb](https://github.com/mini-yifan/deepseek-harness-orb)（dsh 0.1.7 非官方 fork，Electron 悬浮球产品）的 Computer Use 能力向桌宠线集成的可行性、形态设计与工作量分级。
> 源码材料：`_refs/orb-computer-use/orb`（sparse checkout，锁 commit `72f1d738458a223696685a909e806b683eff5885`，2026-09-27）。**`_refs/` 为归档区，产物仅作评估与构建输入，gitignore 覆盖。**

## 1. 背景与结论

- **是什么**：orb = dsh 整仓 fork + 自研「DeepSeek Orb」产品。核心自研资产 = `apps/desktop`（Electron 壳 + 屏幕右沿悬浮球）+ `apps/desktop-host`（球的编排）+ `packages/experimental/tool-computer-use`（13 个 GUI 工具 + 首帧截屏 + code_agent 派发，host 侧 cordis 插件）。
- **方向拍板（用户）**：不整包接、不换 Electron 壳、不做第二个悬浮球；**把 Computer Use 能力集成到现有桌宠身上**（桌宠 v4），Computer Use 插件本体装进现有 dsh profile。
- **结论**：可行。插件是 host 侧标准 cordis 插件（`inject = ['tools','systemPrompt','attachments']`，零 Electron 依赖，overlay-guard 服务运行时可选探测），与桌面形态解耦；miyasaki 侧已有 80% 接收端（六态心跳、内联审批、persona 会话创建先例）。工作量：壳侧中等、插件侧小。

## 2. 地基验证结论（2026-09-27，已实测）

隔离 profile `cu-test`（sessions/storages root 隔离，bundles = base + web-app + 本插件）实弹验证，全绿：

| 层 | 判据 | 结果 |
|---|---|---|
| 构建 | orb monorepo 全量 checkout + toolchain（typescript/tsdown/@types/node）tsc emit + tsdown bundle；paths 映射零 install 原生编译 | ✅ 产物 `lib/index.js`(83.5KB)+backend/windows-native chunk + `lib/code-agent.js`；src 自身零类型错误（TS6059 rootDir 越界不阻断 emit） |
| 装载 | `--dump-config` 组合树 preset-computer-use insert | ✅ plugins 列表齐（persona/bash\|pwsh/compaction/ask-user/web/tool-computer-use/tool-code-agent + preset 默认工具集自动补齐） |
| 加载 | probe（`createRequire` 锚定 profile，与 cordis loader 同源）require 插件 | ✅ 117ms 加载，契约 `name/inject/apply` 齐，code-agent 子路径通 |
| 解析 | bundle 的 bare import 解析基点 = **lib 的 realpath**（仓内插件目录），profile junctions 不生效 ⇒ 插件自身 `node_modules` junctions 直链全局 dsh 树（单实例，非 pnpm 副本） | ✅ probe 复现并修复后全过（含 koffi 原生加载） |
| eager register | cu-test web boot 日志零 error（preset-registry `register` 为 eager load，失败仅 log 不 crash） | ✅ 实例 `http://127.0.0.1:19388` 起停正常 |
| backend | `createPlatformBackend('win32')` 直驱只读路径 | ✅ listScreens 18ms（1 屏 scale=2）；capture 838KB PNG（2166×1322，magic 校验过，落盘 `_refs/orb-computer-use/l2-capture.png` 实图核对）；inspectForeground 抓前台 app/标题正确 |

探针脚本（有留存价值，复现/回归用，`_refs/` 归档区）：`probe-import.mjs`（L1）、`probe-backend.mjs`（L2）。

**遗留风险**：`sendInput/system` 输入类工具（click/input_text/hotkey 等）只做了「加载层」验证，真实 HID 未经会话触发；orb main 分支源码与本地 dsh `0.1.7-rc.2` 的运行时漂移面（src 对 src 编译、lib 对 rc.2 运行）以 L1/L2 绿为前提，写入工具前需 L3 实机会话验收。

| 判据 | 结论 |
|---|---|
| preset 装载契约 | 通用。`- insert: preset-computer-use` 与 miyasaki profile 既有 patch 语法同源；兄弟包（agent-preset/tool-bash/pwsh/web/ask-user/compaction-\*/persona）在本地 dsh `0.1.7-rc.2` **全部在位** |
| 插件本体 | npm **404**、`private: true`，官方 rc.2 不带；须从上游仓 build 或取产物 |
| 加载路线 | **TS 源码 overlay 判死**：npm 全局 dsh 无 tsx，`cordis-plugin-loader` 只依赖 cosmokit/schemastery ⇒ 走 **orb monorepo 内 build lib + 标准插件包**路线 |
| overlay-guard | 运行时 `ctx.get('computerUseOverlayGuard')` 可选探测，服务缺失时裸奔原生 backend（GDI 截屏 + SendInput 全可用，仅无截图遮蔽）——miasaki host 不提供该服务不影响功能 |
| Windows backend | GDI 截前台窗口并集 + `SendInput`，每监视器物理像素；koffi FFI（本地 dsh node_modules **未装**，需补） |
| 视觉模型 | profile `step-5-preview` `input:[text,image]` ✅；`assertImageCapableRoute` 会挡无图模型 |

## 3. 形态设计：三梯度

| 梯度 | 内容 | 判定 |
|---|---|---|
| **梯 1** 遥控器 + 状态镜 | plugin 装进 miyasaki profile；右键菜单「派任务」建 Computer Use 会话；会话激活期桌宠贴边缩条（peek 先例）+ 点击穿透；六态验收 | **梯 2 硬前置** |
| **梯 2** 任务抽屉 | 桌宠挂 WebView2 抽屉（第二 WebviewWindow）：最近 N 条消息 + 输入框 + 问题卡片；「干活时收、问话时展」互斥状态机 | 本轮评估重点 |
| ~~梯 3~~ 气泡动态文本 | agent 回复进气泡（DWrite 位图） | **建议搁置**——梯 2 已覆盖对话呈现 |

### 3.1 抽屉与「球」的边界（三条硬约束，防腐化）

1. 无独立管理面：没有自己的菜单/历史/模型选择/会话管理（会话归主窗 DSH 管）；
2. 不可脱离桌宠：桌宠隐藏 → 抽屉隐藏；桌宠位置即抽屉锚点；
3. 视觉上从桌宠长出：展开动画自立绘边缘滑出，不是独立悬浮窗出现。

对照 orb：球 = 自包含 agent 产品；抽屉 = 桌宠外接的「话筒和屏幕」。**展示态不常显 dot 球**（避免向「又做一个球」滑坡），把手 = 立绘边缘 hover 高亮 + 长按。

### 3.2 三个技术选择

**窗口载体**：Tauri 第二个 `WebviewWindow`（主窗同款 builder；透明/置顶/无装饰；同进程共享 EBWebView 用户目录；**按需创建/销毁**控内存）。弃选：Win32 自绘（GDI 字体崩溃铁律）、WebView2 控件嵌桌宠分层窗（无先例）。

**数据通道**：抽屉 html（file://）→ Tauri event → 壳（Rust 中转 + 状态机 + 跟随桌宠位置）→ eval CustomEvent → 主窗 `dsh-pet-panel` 插件 → `ctx.remote.session.*`（typert RPC，全部官方契约）：

| 抽屉需要 | 路由 | 状态 |
|---|---|---|
| 读消息 | `session/page` → `SessionPage` 分页 | ✅ 已核实（`typert.remote-client.d.ts`） |
| 实时更新 | `session/follow` 流，或 1.5s 心跳 + page 增量（首版） | ✅ |
| 发送 | `session/prompt` → `RemoteResult`（失败经 `PromptError` 回显） | ✅ |
| 问题作答 | `pendingInteractions` + `answer()` | ✅ 已有链路 |
| 停止 / 派任务 | `session/cancel` / `session/create` | ✅ 已有先例 |
| 截图缩略 | `session/attachment` | ✅ 路由在，首版可不渲染 |

**触发器**：长按 400ms（主，与拖动以「按下即位移」区分）+ 右键菜单项（保底）+ 全局热键 `Ctrl+Alt+D`（`RegisterHotKey`，占用冲突静默降级）。

### 3.3 与 Computer Use 激活态协同（互斥状态机，经六态心跳驱动）

| 六态 | 抽屉行为 | 理由 |
|---|---|---|
| idle | 收起成把手；有未读徽标 | 不碍事 |
| thinking（GUI 执行中） | **强制收起** | 展开态 always-on-top 会被截进 agent 视野、`SendInput` 会点到它；收起失效 = 体验事故，全方案最需实机打磨点 |
| waiting（ask_user/审批） | **自动展开**定位问题卡片 | agent 停等人，正是该人看的时候 |
| done / error | 展开显示摘要/错误（done 10s） | — |

## 4. 风险清单

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | 消息/输入契约 | 已核实，无红色 | — |
| R2 | 第二 WebView2 实例内存（百 MB 级） | 中 | 按需创建/销毁；内存基线 |
| R3 | 长按 vs 拖动误判 | 中 | 位移阈值 + 计时双条件；实机调参 |
| R4 | 激活期收起状态机失效 → agent 截到 UI 卡片 | 高影响 | 收起走壳侧最高优先级（tick 内同步）；日志判据；实机冒烟专项 |
| R5 | 形态腐化（抽屉长成球） | 中 | §3.1 三约束 review 对照 |
| R6 | 未沙箱化桌面控制（安装=同意、无逐次批准） | 高 | preset 隔离只影响显式创建的 Computer Use 会话；**后台 code_agent 的 unattended 自动允许审批需二改关闭**，approval 走桌宠内联气泡（显式决策红线）；默认模型锁视觉模型 |

## 5. 工作量分级

| 件 | 量 | 说明 |
|---|---|---|
| Rust 抽屉窗口类 | 中（~400 行） | 创建/停靠（屏缘自适应）/跟随拖动/滑出动画/状态机/热键；照 `window.rs`/`dot.rs` 范式 |
| Tauri 第二 WebviewWindow + capabilities | 小 | html `include_str!` |
| 抽屉前端 | 小-中 | vanilla JS；消息摘要渲染 + 输入 + 问题卡片；主题 CSS 变量壳注入 |
| 插件 client 扩展 | 小-中 | 六态心跳骨架 + page/follow/prompt 中转 |
| 插件包工程（build lib / peers 实名 / patch） | 小-中 | 见 §2 结论 |
| 文档/回归 | 小 | 单测 + verify-all + README/CHANGELOG |

## 6. 拍板记录（2026-09-27，用户确认「五点全是」）

1. ✅ **触发器三件套**：长按 400ms（主交互，与拖动以「按下即位移」区分）+ 右键菜单项（保底）+ 全局热键 `Ctrl+Alt+D`（`RegisterHotKey`，占用冲突静默降级）
2. ✅ **展示态 dot 球不常显**：把手 = 立绘边缘 hover 高亮 + 长按；dot 球维持「仅隐藏态桌宠替身」语义，不新增「球」观感
3. ✅ **ask_user 作答面并存**：桌宠气泡按钮（拒绝/允许一类的快捷一键决策）+ 抽屉内完整问题卡片（上下文 + 富交互）；两者共用同一 `pendingInteractions` 事件源
4. ✅ **截图缩略图首版不渲染**（`session/attachment` 后置，工具调用一行摘要 + 文本先行）
5. ✅ **梯 1 先落地再上梯 2**：依赖链成立（激活态信号、六态覆盖、patch 安装均属梯 1）

1. 触发器三件套（长按主 + 右键菜单 + 热键）=OK？主交互确认长按？
2. 展示态 dot 球不常显 =OK？
3. ask_user 作答面：桌宠气泡按钮（一键快捷）保留 + 抽屉内完整问题卡片，并存？
4. 截图缩略图首版不渲染（`session/attachment` 后置）=OK？
5. 梯 1 先落地再上梯 2（依赖成立）？

## 7. 关联

- 梯 1/2 共同前置：`_refs/orb-computer-use/` 的 build 产物与插件包工程（本次地基验证对象）。
- 更新记录见 `design/CHANGELOG.md`。
