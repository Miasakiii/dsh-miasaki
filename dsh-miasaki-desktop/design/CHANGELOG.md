# Miasaki Desktop — 变更日志

> 按时间倒序。历史排查细节与决策见 `ARCHITECTURE.md`;待办见 `TODO.md`。

## 2026-08-22 · 桌宠 v2 阶段 A：动作丰富化（针对「动作少、僵硬」整改）

- 规划链路：学习 OpenDesign 宠物体系 → `design/pet-v2-roadmap.md`（总览+诊断+决策）→
  `design/pet-v2-phase-a-execution.md`（可开工执行方案）。僵硬诊断七条根因详见 roadmap §3.5。
- **反转狂三立绘清晰化（用户反馈「不像」）**：形象核查（高清源 1728×2368：银发、金钟眼 12:05、
  红瞳尖线、黑金哥特裙、血红内衬——形象本身正确）；根因是素材链退化 + v1 遗留断层：
  `inverse-states.mjs` 输出名为 `blue-*.png` 与 frames.json 引用的 `states/{idle,work,deep}.png` 错位，
  桌宠一直渲染 8/21 产的 128×208 旧图（钟眼糊成色块、形象沦为普通异色瞳少女）。
  修复：输出名统一 `{idle,work,deep}.png` + 输出档位 208 → 540 高（渲染 270 的 2 倍超采样）。
  三态现为 332/313/381 × 540，钟眼可辨认。
- **whale 帧拆分 bug（真机「缩放跳动」修复）**：`sharp(gif, {animated:true, page:p})` 的语义
  是「输出从第 p 页起的堆叠塔」而非单帧——拆出帧尺寸为 192×1248/1040/832/624/416/208，
  渲染按各帧宽高比缩放 → 每帧忽大忽小（真机截图可见「微型三连叠影」）。修复：整动画图
  用 `extract` 逐段切（顶部=帧 0），全部帧固定 192×208。教训：sharp animated 输出为垂直堆叠图，
  `page` 与 `animated` 组合语义反直觉，帧序列务必校验输出尺寸（`ui/pets/whale/states/idle-*.png` 已验）。
- **whale 绿色描边净化（真机反馈「绿边不好看」）**：`idle.gif` 为「透明替代色残留」型 GIF——
  制图用纯绿（0,254,0 / 0,126,0 等）当透明区而未标 alpha，帧边缘呈绿色系实色描边。
  新增 `stripGreenEdge()` 后处理（绿色主导像素 → alpha 0）接入 whale 拆帧链路，
  复检剩余绿色像素 0。素材审计原图/像素抽样两步确认非渲染 halo（半透明像素 0）。
- **专注态语义修正（真机反馈「狂三一直跳动」）**：强度分级实为 DSH 页面模型标签解析
  （`Max→deep / High→work`，runtime.js `CUR_INT`），页面常驻时 intensity 长期非 idle；
  v2 初版把思考中映射到 wait 行 + 4fps 慢放，wait 帧组帧间起伏（眨眼/下沉）被慢放放大 →
  观感「一停一顿的跳动」。修正：思考中=静默守候（idle 姿态，ambient 仅在 idle 强度触发自动安静），
  wait 行专属阶段 B 审批等待。决策 3 修订记录于 `design/pet-v2-roadmap.md` §7。
- 用户机体验反馈触点：真机验收发现跳动 → 截图取证（角色区/背景区对照差分 + 肉眼核查）→
  定位 whale 帧尺寸不一 → 修复后三张抽查帧尺寸一致，动画闭环正常。
- **素材全行切出（A0）**：`cut-frames.mjs` 的 `NEEDED` 4 行 → 全 9 行（idle/runRight/runLeft/wave/jump/failed/wait/run/review），
  kurumi 帧组 21 → 57 帧；wait/review/failed 行此前躺在 spritesheet 中未用（僵硬 #1）。
- **whale 帧序列（A6）**：`idle.gif`（192×1248 六帧条）拆为 `states/idle-00~05.png`；
  `frames.json` 三态值支持「帧组数组 | 单帧字符串」双形态；渲染侧统一为帧组（`Frames.states: HashMap<String, Vec<Image>>`），
  帧组 6fps 循环 + bob，单帧行为与历史一致。
- **修复 wave 不可达（A1）**：双击此前永远 `do_hop+focus_main`（README 声称的「双击=挥手」实为漂移）；
  现按决策改为：主窗最小化/隐藏 → 唤起，否则 → `do_wave()`（wave 行 1300ms）。
- **强度语义修正（A2）**：work/deep 不再原地播 run（僵硬 #3），改 `wait` 行守候（慢放 4fps），
  run 行只归属有位移的 wander——「移动才有跑步」。
- **呼吸与过渡（A3/A4）**：kurumi 基线（idle/wait 且无行动）加 ±2px 3200ms 呼吸 bob；
  跳跃落地加 200ms 末帧定格（`hop_hold_until`），消除硬切。
- **环境编排 + 滑步修正（A5）**：idle 基线低频随机小动作（池 wave/review/wait，jump 15% 偶发；
  表演 1.2~2.2s / 休息 8~18s / 首演 5.5s；指针按下即打断）；wander 滑步修正：位移从「每 tick 3px」
  改为「每帧 9px」（帧同步，90px/s 速度不变）；wander 改为 kurumi 专属（whale/inverse 不再无声滑行）。
- 触摸点：`src-tauri/src/pet_native.rs`（常量表/PetWin 字段/compose 状态机/FFI 交互）、
  `scripts/cut-frames.mjs`、`ui/pets/frames.json`、`ui/pets/kurumi/frames/`（+34 帧）、
  `ui/pets/whale/states/idle-*.png`（+6 帧）。
- 验证：`cargo check --offline` 通过；沙箱内冒烟通过——进程存活、`MiasakiPetWin` 286×390 物理尺寸正确、
  金点窗/托盘/单实例窗齐备；角色区像素活性对照差分成立（角色区 23K~32K px 变化 vs 背景区 0~5.4K，
  9/9 帧对变化，`_refs/scripts-archive/pet-pixdiff*.ps1` 可复用）。用户机验收清单见执行方案 §验证。

## 2026-08-22 · monorepo 重组（仓库结构）

- 仓库重组为三文件夹 monorepo（umbrella `dsh-miasaki` 仍是唯一 git 仓）：本目录 `dsh-miasaki-desktop/`（原 `desktop/` + `design/` 内移）、`dsh-miasaki-fleet/`（编排线）、`dsh-miasaki-shared-docs/`（跨线/DSH 平台参考）。
- `design/` 从仓库根移入本目录内部 → `build-init.mjs` 令牌面路径由 `join(root,'..','design',...)` 改 `join(root,'design',...)`（gen-init 验证通过，令牌校验 + 46KB theme-init.js 产出）。
- `README.md` 设计规范引用 `../design/` → `design/`；`.gitignore` 锚定路径前缀 `desktop/`→`dsh-miasaki-desktop/`。
- 安全网：tag `pre-reorg-2026-08-22` @ `10f8baa`；era tag `0.1.1-rc.1-era` 落在重组+修复后的 `bee066d`。

## 2026-08-22 · m36 冒烟收尾（工程）

- **`verify-themes.mjs` 断言修正**：`kurkuriel: 骨白基底令牌` 原检查 `--dsw-static-neutral-bluish-950 === '#e9e5e1'`，
  但 `kurkuriel.css` 自初版（4f07bd9）起该令牌即声明为 `#0f0d0b`——骨白实际走「DSH 亮色语义」亮端令牌
  （`--dsw-static-neutral-bluish-50=#fcfaf8`）+ `--dsw-alias-bg-base=rgba(247,244,241,.88)`。
  该断言从首次提交即不可满足，因 `verify-themes` 此前从未在真机跑通而潜伏。
  改为：亮端令牌 + alias 基底含 `247, 244, 241`，并新增「深端令牌同步覆盖 = `#0f0d0b`」佐证覆盖链路健康。
  真机首次完整跑通 **18/18**（0.1.1-rc.1 全局 CLI）。属测试断言修复，非主题代码回归。
- **m36 回归冒烟**：详见 `docs/m36-rc8-regression-smoke-2026-08-22.md`——m3-test/rc7-test 混装 profile
  `--dump-config` 双双 exit 0，rc7-test 插件树与 M3.5 基线 313 行字节一致，三主题端到端通过。

## 2026-08-22 · v0.1.4(第七轮)

- **桌宠 Agent 预设(三个)**:standard 底座复制 + 中文 persona。
  人设按桌宠贴合成角色(鲸鱼娘/狂三/反转狂三),调用偏好区分:鲸鱼娘先本地后网页、
  狂三复杂任务先规划后动手、反转狂三默认直接动手改动面大才计划;
  每条 persona 带硬性「入戏边界」——工具调用、错误报告、审批/凭证一律标准语气(中档扮演)。
  三个预设经 `standingKeyFor` 挂载校验通过;RPC 通道经真实创建验证。
- **主题→人格会话联动**:切换主题自动用对应桌宠的 Agent 预设开启新会话
  (官方 RPC `session.create` 的 `agentPreset`;优先挂当前 workspace)。
  每主题仅自动创建一次(localStorage 去重),RPC 失败静默降级不阻断切换。
- **三桌宠灵魂文件(pet.json)补全**:whale/kurumi/inverse 三份中文人设
  (inverse 新增 manifest + spritesheet.png/webp 图集,由 `scripts/make-inverse-sheet.mjs` 生成)。

## 2026-08-21 · v0.1.3(第六轮)

- **闪退根治(关键)**:GDI 高频创建改为**持久 DC/DIB 表面**(创建一次终身复用);
  气泡文本渲染从 33ms 心跳降到帧更新时;BmiHeader `biSize` 44 → 40 标准值。
  此前 gdi32full+0x2ae13 固定偏移崩溃连续出现 5 次(22:16/22:25/22:47/23:16…)。
- **主窗口位置/大小持久化**:关闭时保存 `%APPDATA%\com.miasaki.desktop\window.json`(物理坐标),启动时恢复(负坐标/过小尺寸防御)。
- **托盘菜单**:显示/隐藏主窗口、退出(`tray-icon` feature;左键点击不弹菜单)。
- **冒烟测试脚本**:`desktop/scripts/smoke-test.ps1`(交付物完整性 / 进程存活 / 桌宠窗口 / 素材加载 tick0)。

## 2026-08-21 · v0.1.2(第五轮)

- **GDI 句柄泄漏修复**:`present()`/`draw_text()`/`draw_dot()` 的 `SelectObject` 后未恢复原对象即 `DeleteObject`,
  33ms 高频下句柄耗尽 → gdi32full 崩溃;全部改为先恢复再删除,DC/DIB 创建失败提前返回。
- **防复发**:compose 加脏标记,静止时 `present` 频率 33ms → ≥125ms。
- **桌宠放大**:窗口 220×300 → 286×390,角色 208 → 270 高;气泡 170×36 → 210×48;金点 26 → 30;散步 2 → 3px。
- **拖窗跟手**:JS 发「按下起点累计物理增量(×DPR)」+ Rust 差值应用 + `move=reset` + 轮询 100ms → 33ms + pointercancel。

## 2026-08-21 · v0.1.1(第四轮)

- **桌宠动画循环真相**:`WM_CREATE` 期间 `GWLP_USERDATA` 未设置 → `wnd_proc` 的 `SetTimer` 从未执行
  → 桌宠自 v0.1 起只画一帧、永不刷新;修复:USERDATA 就位后显式 `SetTimer`。
- 二次根因:`compose` 每 33ms 清空 buf 但帧更新间隔 ≥125ms → 空帧闪烁;修复:清空移入帧更新分支。
- 明暗锁定修复:pure/system 切换时移除残留 `data-ds-dark-theme`(切回原版不再残留暗色)。
- 标题栏 36→32px 低调化、去阴影;切换条 hover 展开 + 300ms 延迟关闭 + 面板 hover 保活。
- `set_mode`/`set_intensity` 日志埋点。

## 2026-08-21 · v0.1.0 增补(第三轮)

- **apply() 核心同步优先**:syncHash/refreshSwitcher/updateTitlebar 提到装饰层之前并 try-catch,
  消除"装饰层异常 → 图标不换+桌宠不切换"连锁失败;自愈巡检 5s → 1s。
- 切换条交互重做(见上);标题栏按钮 `--ms-danger` 主题化。
- **软件图标重设计**:百炼生成「暗夜紫 + 鎏金时钟 10:10 + 绯红蔷薇」艺术图(icon-new.png),
  `npx tauri icon` 重生成全套;make-icons.mjs 换源并修复 inverse 徽章引用。
- set_mode 日志埋点;启动器 `--no-open`(rc.8 双窗口问题)。

## 2026-08-21 · 第二轮

- 桌宠待机随机行为(18-42s 气泡 / 22-50s 散步 + 贴边吸附)。
- **反转狂三全新立绘**:qwen-image-3.0 生成 3 态 + 深蓝背景 flood-fill 抠图(`scripts/inverse-states.mjs`);
  inverse 从「kurumi 重着色 atlas」改为立绘三态。
- 滚动锁死(`html,body overflow:hidden` + `#root calc(100% - 32px)`);aurora 光晕层 + 面板半透明化;水印增强。
- 清理:pet_native.rs 死代码、50+ 诊断截图、测试 profile、旧状态帧/inverse 图集。
- `inputModalities` 修复使 read_image 可用;百炼 skills 刷新 1.17.0。

## 2026-08-21 · 第一轮(rc.8 适配)

- 启动器加 `--no-open`(rc.8 起 `dsh web` 自动开浏览器 → 双窗口)。
- runtime.js 内页宠物死代码清理(-426 行,注入包 56KB → 38KB);删除 ui/pet.html/css/js。
- rc.8 令牌面核对:`--dsw-static-*` 73 个与 token-surface.txt 一致;`--json-tree-*` 等 8 个失效(死覆盖,无害)。

## 2026-08-17 · v0.1.0 初始

- Tauri 2 薄壳 + 三主题(纯色/刻刻帝/狂狂帝)+ 原生 Win32 分层窗桌宠(鲸鱼娘/狂三/反转狂三)。
- 用户验收通过("好了")。
