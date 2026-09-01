# Miasaki Desktop — 待办列表

> 优先级自上而下。完成项进入 `CHANGELOG.md`。

## P0 · 稳定性阻断

- [x] **闪退 ** — GDI 泄漏/高频创建 → 持久表面 + 脏标记(2026-08-21 第六轮)
- [x] **启动链路异常兜底** — bootstrap.json 健康标记 + 失败恢复页(2026-08-24,见
  `design/bootstrap-reliability.md`);GDI 侧兜底(§异常兜底)仍待做
- [ ] **长时间稳定性观察** — 用户连续运行 ≥1h 无崩溃(第六轮修复验证)
- [ ] **GDI 异常兜底** — GDI/定时器失败写 pet.log 统计 + 触发后自动重建(当前仅部分)

## P1 · 用户已验证清单(本轮)

- [x] 主窗口位置/大小持久化(window.json)
- [x] 托盘菜单(显示/隐藏主窗口、退出)
- [x] 冒烟测试脚本(smoke-test.ps1,用户机执行)
- [x] 文档拆分(CHANGELOG / ARCHITECTURE / TODO)
- [x] **启动失败恢复页** — dsh 未安装/端口占用/重试换代;失败页动作:检查 dsh/打开终端/
  打开日志目录/导出诊断(2026-08-24,设计见 `design/bootstrap-reliability.md`)
- [x] **bootstrap.json 与 window.json 原子写**(temp+rename)
- [ ] **启动失败用例自动化** — dsh 未安装 / 端口被占用 / 单实例冲突三条用例接入
  smoke-test.ps1(手动用例清单见设计文档 §6)
- [x] **pet.json 版本化** — `version: 1` + 损坏回默认(设计已定,见 bootstrap-reliability.md §4.1;
  2026-08-29 落地:含位置可见性校验(EnumDisplayMonitors 工作区)+ hide 持久化)
- [ ] **安装包 + 卸载** — NSIS/MSI 需要联网下载 bundler(沙箱内不可行 → 用户机执行
  `npm run build`);建议连同 DSH 依赖检测一起:启动时探测 `dsh` 命令 + 3080,失败页给出安装指引

## P2 · 体验

- [x] **桌宠设置面板** — DSH「设置 → 桌宠」:显示/隐藏(持久化)、位置重置(屏幕外找回)、
  状态回显(hash 命令通道 + eval 回推);位置屏外自动回默认(2026-08-29,见 CHANGELOG)
- [ ] 主窗口最小化到托盘(关闭=退出保持现状,托盘已有显隐)
- [ ] 桌宠「审批等待」状态(主页面 DOM 扫描 → 桌宠 waiting 姿态)— 2026-08-30 接入,见 CHANGELOG;待 Operator 跑 `__miasakiProbe()` 校准选择器;桌宠内一键审批后续阶段
- [ ] 反转狂三 run/wave/jump 动画帧(立绘已换,动画帧未生)
- [ ] 桌宠双击 = 唤起/聚焦主窗口(已实现,待用户验证)
- [ ] **主题→人格切换后自动打开新会话**(v0.1.4 仅自动创建 + toast 提示;自动选中需 DSH 提供
  URL 直达会话或谨慎的侧栏定位,前者优先,后者脆弱不做)
- [ ] 主题切换视觉漂移核对(rc.8 alias 表达处,需用户机截图)

## P3 · 工程

- [ ] 正式 IPC(如 tauri 自定义协议 / postMessage)替代 hash 通道(收益有限,hash 已验证可靠)
- [ ] verify-themes.mjs 沙箱运行方案(无头 Edge 被命名管道限制;可换 WebView2 实例化)
- [ ] 测试自动化(单元:parse_fragment 纯函数;集成:smoke-test 扩展)
- [ ] 升级策略(DSH rc.x 升级后跑 verify-themes + 令牌面 diff,build-init 已内建令牌校验)

## 历史教训(勿重犯)

1. WebView2 ≠ 桌宠窗口载体;原生分层窗是唯一解
2. GDI 选中对象先恢复再删除;高频调用用持久表面
3. DPI 物理/逻辑坐标差整倍(取证脚本必须 DPI-aware)
4. Copy-Item 到已存在目录会嵌套(dist\ui\ui)
5. 沙箱子进程写 %LOCALAPPDATA% 失败(用工作区 marker 探针)
6. 主窗口 must 提权运行(WebView2 初始化)
