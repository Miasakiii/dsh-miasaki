# Miasaki 桌面端 — 进度手账（续推唯一入口）

- 定稿：2026-08-17 深夜
- 状态：**v0.1 全功能落地，用户验收通过（"好了"）**。下一步从「§5 路线图」选取。

---

## 1. 交付总览（dist\Miasaki.exe + dist\ui\）

| 模块 | 状态 | 实现要点 |
|---|---|---|
| 启动器 | ✅ | 单实例 → 探活 3080 → 自动拉起 `dsh web`（日志 %LOCALAPPDATA%\miasaki\server.log）→ 导航 |
| 三主题 | ✅ | 纯色=透传 / 刻刻帝=暗夜绯红鎏金 / 狂狂帝=骨白血绯（令牌层覆盖 `--dsw-static-*` 全 98 个） |
| 主题切换条 | ✅ | 右下角金环圆钮 + 三枚徽章图标 + 原版专属「明暗」三档（浅/深/跟随系统） |
| 主题化标题栏 | ✅ | 无边框主窗 + 注入标题栏（拖动/min/max/close 经 hash 命令通道） |
| 桌宠 | ✅ | **原生 Win32 分层窗口**（真透明）：整窗拖动 / 左键跳+气泡 / 双击 / 右键原生菜单 / 隐藏→金点恢复 / 位置持久化 |
| 三角色 | ✅ | 鲸鱼娘（立绘三态随思考强度：待机=Q版/常规=幼年体/深度=少女体）、狂三、反转狂三（银发红眼重着色新立绘） |
| 图标 | ✅ | 徽章化设计（头像+鎏金时钟环+刻度+绯红顶珠），EXE 图标集已生成 |
| 素材服务 | ✅ | 127.0.0.1:39800（exe 旁 ui\，CORS），供主页面图集/图标 |

## 2. 架构定论（勿再改）

- **主应用 = Tauri（WebView2）**：主题/标题栏/启动器全部稳定 ✅
- **桌宠 = 原生 Win32 分层窗口**（`src-tauri/src/pet_native.rs`）：WebView2 透明/分层/置顶工具窗全部不可用（黑化/空白/绿幕），这是最终形态
- **同步通道**：主页面运行时 → URL hash（`#miasaki-theme=X&int=X&cmd=X&seq=N&move=dx,dy`）→ Rust 100ms 轮询 → 桌宠（Arc<Mutex> 直连）/ 窗口命令执行
- **初始化注入**：`initialization_script` 只在文档创建时可靠（head 可能空 → ensureStyle/ensureBase「补挂载」模式）；导航后 eval 不可靠；远程页 invoke 被 ACL 拦截（不用）

## 3. 构建链路（顺序固定）

```powershell
# desktop 目录
node scripts/cut-frames.mjs        # 预切图集帧 + frames.json（换素材后重跑）
node scripts/make-icons.mjs        # 图标（徽章）
node scripts/build-init.mjs        # 注入包（令牌完备性校验 + webp→png）
# src-tauri 目录
cargo build --release --offline
# 发布：先删后拷（Copy-Item 嵌套陷阱）
Copy exe → dist\Miasaki.exe
Remove dist\ui; Copy desktop\ui → dist\ui
```

## 4. 验证工具箱（已验证可靠）

- **hash diag**：运行时状态全量进 URL fragment → Rust pet.log（%LOCALAPPDATA%\miasaki\pet.log）
- **MiMo 视觉**：`python C:\Users\Asakii\.agents\skills\mimo-omni\mimo_api.py image <png> "<问题>"`（本会话模型无图像输入）
- **窗口取证**：枚举+置顶截屏用**物理坐标**（进程 DPI-aware，PowerShell 未感知差 2 倍！）；脚本必须带 SWP_NOZORDER
- **像素扫描**：确定性色彩分布（图集蓝色/绯红等特征色）

## 5. 路线图（下一步候选，按价值排序）

**P0 · 体验补全（下次直接做）**
1. 主窗口位置/大小记忆（window-state）
2. 桌宠待机随机行为：定时散步（左右 run 帧+位移）、随机气泡台词、贴边吸附
3. 桌宠「等待审批」状态：主页面 DOM 扫描审批按钮 → `int=wait` 上报 → 桌宠 waiting 姿态+气泡（目标中的审批快捷项，v1 未接入）
4. 托盘图标：显示/隐藏桌宠与主窗、退出（替代右键菜单单一入口）
5. 双击桌宠 = 唤起/聚焦主窗口

**P1 · 分发与工程**
6. NSIS 安装包（tauri CLI bundler 需联网下载工具，沙箱内不可行→用户机执行 `npm run build`）
7. 清理死代码：runtime.js 内页宠物模块（INPAGE_PET=false 已停用）、ui/pet.html/css/js（已被原生宠物替代）、pet.log 诊断精简
8. DSH 升级韧性：令牌面变化时 build-init 校验会失败报警（已内置），届时更新 token-surface.txt

**P2 · 角色深化**
9. 狂三/反转狂三专属台词体系扩充（按强度档位）
10. 桌宠语音播报（MiMo TTS 或 edge-tts，与主题联动）
11. Live2D 化（kulumi 有现成资产可参考——用户此前表示 kulumi 为半成品、需自行评估）

**P3 · 生态集成**
12. 多 Agent 编排面板（见 `docs/multi-agent-cli-orchestrator-design.md` §8）：Operator 开关/状态灯/token 成本 → 桌面端独立标签或 DSH 客户端插件
13. 桌宠联动编排状态（fleet 健康度 → 桌宠表情）

## 6. 血泪教训（违反必炸）

1. WebView2 ≠ 桌宠窗口载体（三连黑化/空白/绿幕）；原生分层窗口是唯一解
2. DPI：进程内物理坐标 vs 未感知进程逻辑坐标差整倍
3. Copy-Item 到已存在目录会嵌套成 `dist\ui\ui`
4. GDI 画 32bpp DIB 不写 alpha → 分层窗内图形必须手工像素
5. 素材路径 = `exe_dir/ui/pets/`（ui 层不可漏）
6. 远程页 eval 返回 Ok 也可能未执行；标题不同步；invoke 被 ACL 拒
7. 运行应用必须提权一次（WebView2 写 %LOCALAPPDATA%）；cargo 用 --offline；rustc LTO 会崩（opt-level=1）
8. 截图脚本 SetWindowPos 勿用 HWND_TOPMOST（曾把用户主窗永久置顶）

## 7. 文件地图

```
dsh-miasaki\
├─ design\HANDOVER.md / themes.md / token-surface.txt
├─ dist\Miasaki.exe + dist\ui\            # 交付物
├─ docs\multi-agent-cli-orchestrator-design.md  # 多 Agent 编排规划
└─ desktop\
   ├─ ui\ loading.html · icons\ · pets\{whale,kurumi,inverse}\
   ├─ themes\ runtime.js + {pure,zafkiel,kurkuriel}.css
   ├─ scripts\ build-init / cut-frames / make-icons / segment-litu / recolor-inverse …
   └─ src-tauri\ src\main.rs · src\pet_native.rs · injected\theme-init.js（生成物）
```
