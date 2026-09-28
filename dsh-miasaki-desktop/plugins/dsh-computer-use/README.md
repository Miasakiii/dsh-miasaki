# @miasaki/dsh-computer-use

Computer Use GUI 工具插件（miasaki 二改版）——桌宠 v4 的能力底座。

> **状态：L1+L2 已过 + 正式装入 `miasaki` profile（2026-09-27）**：junctions 与 bundles 注册完成、
> `--dump-config` 静态验证 preset insert 零重复零 error。**待用户重启壳生效**（patch 层启动时读取），
> 之后做 L3 实机会话验收（见文末清单）。

## 它是什么

surface 层对 agent 暴露 13 个桌面 GUI 工具（`click` / `input_text` / `scroll` / `hotkey` /
`wait` / `long_wait` / `screenshot` / `long_press` / `drag` / `open_in_browser` /
`open_in_finder` / `list_apps` / `open_app`）+ 首帧前台窗口截屏 + `code_agent` 后台派发
（`code_agent` / `code_agent_status` / `code_agent_stop`）。插件以 **agent preset** 形式装载：
GUI 工具只注册在 `computer-use` preset 内，普通编码会话（standard 预设）零变化。

- Windows 后端：GDI 截前台应用窗口并集 + `SendInput` 发输入，每监视器物理像素，
  z-order 前台选择跳过 overlay HWND/任务栏/桌面；hotkey 前 `SetForegroundWindow` 抢焦点
- 坐标编码：默认 0–1000 千分比（随附截图的比例空间）
- overlay-guard（截图遮蔽/HID 点击穿透）依赖 Electron 专属服务 `computerUseOverlayGuard`，
  经 `ctx.get` 运行时可选探测——miasaki host 不提供该服务时插件功能完整、仅无遮蔽
  （遮蔽由壳侧承接，见设计文档 §3.3）

## 来源与锁版本

| 项 | 值 |
|---|---|
| 上游 | [mini-yifan/deepseek-harness-orb](https://github.com/mini-yifan/deepseek-harness-orb)（dsh 0.1.7 非官方 fork） |
| 包路径 | `packages/experimental/tool-computer-use` |
| 锁 commit | `72f1d738458a223696685a909e806b683eff5885`（2026-09-27 `fix(orb): default millifraction coordinates by operating system`） |
| 本地材料 | `_refs/orb-computer-use/orb`（gitignore 归档区，工作树全量 158MB） |
| 许可 | MIT（随上游） |
| npm | **不存在**（`private: true`，官方 rc.2 不带）⇒ 只能源码构建 |

## 构建（复现流程）

工具链与产物隔离在 `_refs/`（不进仓库）：

```powershell
# ① 拉源码（sparse 后补全量；_refs 归档区）
git clone --depth 1 --filter=blob:none https://github.com/mini-yifan/deepseek-harness-orb.git _refs/orb-computer-use/orb
git -C _refs/orb-computer-use/orb sparse-checkout disable   # 全量（paths 映射需要被依赖包 src）

# ② 工具链（不进工作区；npm 全局装亦可）
npm i --prefix _refs/orb-computer-use/toolchain typescript tsdown @types/node

# ③ tsc：orb 包 tsconfig extends 根 tsconfig.base.json（paths 把 @deepseek-ai/* 映射到 orchestr 源码；
#    普通 tsc 无 tsx/install，composite project references 全量 checkout 后满足）。
#    tsconfig.build.json 仅三处覆盖（composite off / sourcemap off / typeRoots 指 toolchain）
node _refs/orb-computer-use/toolchain/node_modules/typescript/bin/tsc -p _refs/orb-computer-use/orb/packages/experimental/tool-computer-use/tsconfig.build.json
#    预期噪音：TS6059（rootDir 越界，被 paths 拉入的上游 src）+ 1 条 TS2307
#    （上游包 dsh-client-file-upload/types 的 paths 映射缺失）——均不阻断 emit，src 自身零类型错误

# ④ tsdown：config 的 import('tsdown') 从包目录解析 ⇒ orb/node_modules junction 到 toolchain
New-Item -ItemType Junction -Path _refs/orb-computer-use/orb/node_modules -Target _refs/orb-computer-use/toolchain/node_modules
node _refs/orb-computer-use/orb/node_modules/tsdown/dist/run.mjs --config _refs/orb-computer-use/orb/packages/experimental/tool-computer-use/tsdown.config.ts

# ⑤ 拷贝产物（d.ts 不随包分发，本仓自用）
Copy-Item _refs/.../tool-computer-use/lib/*.js plugins/dsh-computer-use/lib/
```

产物：`lib/index.js`（+ `backend-*.js` / `windows-native-*.js` 两个 chunk）、`lib/code-agent.js`。
全部 `@deepseek-ai/*` 与 zod/koffi 保持 bare import（external），运行时由宿主侧解析。

## 安装到 profile

bundle 的 bare import 无法从 profile 目录解析到全局 dsh 树 ⇒ **junction 单实例方案**
（`install.ps1 -Profile <name>`，幂等；`link:` 安装本插件 + 缺失依赖直链全局 dsh 树）：

| junction（profile/node_modules 下） | 目标 |
|---|---|
| `@miasaki/dsh-computer-use` | 本目录（`plugins/dsh-computer-use`） |
| `@deepseek-ai/dsh-{llm,tools,attachment,brand}` | `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<pkg>` |
| `zod` / `koffi` | 同上（全局 dsh 树顶层） |
| `schemastery` / `cosmokit` | profile 已有 pnpm 副本时不建（现役插件已在用，保持现状） |

装载本体 = patch insert（`cordis.patch.yml`），经 `dsh --profile <p> --patch ./cordis.patch.yml`
或并入 profile 的 `cordis.patch.yml`。

**miyasaki profile 已装（2026-09-27）**：上述 junctions + `package.json` 的 `dependencies`（`link:`）+
`dsh.profile.bundles`（末位）均登记；`--dump-config` 验证 preset insert 一次无重复、零 error。
**重启壳生效**（patch 层启动时读取）。

## L1/L2 探针（_refs/orb-computer-use/，复现/回归用）

```powershell
node _refs/orb-computer-use/probe-import.mjs   # L1：createRequire 锚定 cu-test profile，验加载/契约/递归 bare import/koffi
node _refs/orb-computer-use/probe-backend.mjs  # L2：createPlatformBackend 直驱只读路径（listScreens/capture/inspectForeground）
```

## L3 验收清单（用户重启壳后手动执行）

> Computer Use 会话 = 未沙箱化真实桌面控制；按只读→写入逐级验，写入项围观时做。

1. 主窗口「设置 → 模型」确认 **step-5-preview**（视觉模型，Computer Use 强制图片输入）可用
2. 新建会话 → 模式选择器应出现 **「Computer Use 模式」**（preset 注册成功的 UI 判据）
3. 选它 → 工具目录应含 13 个 GUI 工具 + `code_agent` / `code_agent_status` / `code_agent_stop`
4. 只读验：「截个图看看当前窗口」→ 期望 screenshot 执行、图落桌面 + 剪贴板
5. 写入验：「打开记事本，输入 hello」→ 期望记事本被拉起并键入
6. 异常路径：以管理员运行的窗口应被拒绝输入且如实报错（不假装成功）
7. 背景轨：「做个贪吃蛇小游戏」→ 期望 `code_agent` 派发后台会话、立即返回、完成通知回会话

## 二改跟踪

| 项 | 状态 |
|---|---|
| name 改指本插件（exports /code-agent） | ✅ 已改（唯一相对上游的 patch 改动） |
| persona 中文化 / 桌宠语气 | 待拍板 |
| code-agent-unattended 自动允许审批 | 待评估关闭（桌宠红线） |
| 桌宠 HWND 遮蔽（ovb overlay-guard 等效） | 壳侧激活态收起方案先行，host 侧精致解留 v4.1 |
