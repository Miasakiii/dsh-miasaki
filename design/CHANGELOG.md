# Miasaki Desktop — 变更日志

> 按时间倒序。历史排查细节与决策见 `ARCHITECTURE.md`;待办见 `TODO.md`。

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
