# A×B 联动实施记录:总指挥活动 + 边缘噪点(2026-08-30)

- 日期:2026-08-30
- 状态:已实施(项目 A 侧);项目 B 联动暂缓
  > **2026-10-05 注**:「项目 B 联动暂缓」写于当日,**其后已大幅推进** —— fleet-pulse 聚合器(09-04 v2 契约 +
  > `workers/pulse/publish-pulse.mjs`)与壳侧 Rust 看门狗(09-04 起、09-07 补 `PULSE_STALE_SECS=30`
  > 陈旧语义)均已落地;**仍未做的只剩「agent 卡片级状态映射」**(经 08-30 裁定归 `fleet-monitor`
  > 工作面板,不进桌宠)。逐条更正见下方 §0 / §2 的同日更正块。
- 上游草案:`ab-linkage-pet-fleet-status-2026-08-18.md`(员工状态联动方案,仍为 Draft)
- 关联:`dsh-miasaki-desktop/design/CHANGELOG.md` 2026-08-30 条、`ARCHITECTURE.md` §3.4 / §4.5、`dsh-miasaki-fleet/fleet-monitor/`(员工状态归宿)

---

## 0. 范围裁定

用户 2026-08-30 明确:

> 桌宠只反映 DeepSeek 总指挥(主会话)的工作动态;agent 员工状态以后单独做监控页面。

**结论**:`ab-linkage-pet-fleet-status-2026-08-18.md` 草案里的"fleet-pulse 聚合器 + Rust
watchdog + agent 卡片状态映射"**本期不实施**;数据源从"fleet 文件总线"收窄为
"DSH 主页面 DOM"(总指挥在主页面内,其活动/审批 UI 只能 DOM 扫描)。

> **2026-10-05 更正**:本结论里的「**本期不实施**」如今只对**第三项(agent 卡片状态映射)**成立,前两项此后已被落地推翻 ——
> ① **fleet-pulse 聚合器**:2026-09-04 发布 `fleet-pulse.json` **v2**(写者
> `dsh-miasaki-fleet/workers/pulse/publish-pulse.mjs`,契约 `ab-linkage-pulse-v2-2026-09-04.md`),
> 2026-09-07 又补**心跳判活**(`dsh-miasaki-fleet/workers/lib/liveness.cjs`:心跳过龄降级 `unknown`、不进 running 计数);
> ② **Rust watchdog**:`dsh-miasaki-desktop/src-tauri/src/main.rs` 的脉冲看门狗(2s 轮询 pulse v2、
> `PULSE_STALE_SECS = 30` 时效判据;开启方式为环境变量 `MIASAKI_FLEET_PULSE` 或本机配置 `fleetPulsePath`)。
> 因此下句「数据源收窄为 DSH 主页面 DOM」也随之反转:**pulse 文件是首选通道,DOM 扫描降为兜底**
> (官方通道 5s 无心跳才启用 `act=`/`wait=` 扫描)。实现记录见 `dsh-miasaki-desktop/design/CHANGELOG.md`
> 2026-09-04 条(X2 Fleet 指示器)与 2026-09-07(晚)条(Fleet 脉冲 stale 语义)。

员工状态的归宿是 **`dsh-miasaki-fleet/fleet-monitor/` 工作面板增强**——已有
`panel.html` 卡片 + 状态点,后续在该面板深化(独立任务),桌宠不参与。

---

## 1. 本期 A 侧实施清单

### 1.1 噪点根因与修复

- 素材端:kurumi 切格零清理 + whale `stripGreenEdge` 只杀绿色像素 + inverse 2px 环带
  带残留底色 + 208→270 ×1.298 最近邻缩放撕单点杂色成锯齿簇
- 修复:`scripts/cut-frames.mjs` + `scripts/inverse-states.mjs` 共用 `despeckle(buf)`
  (a<24 阈值 + 0<a<128 像素 8 邻域无强前景 → 0,杀散点/光晕);kurumi/whale 接入
  despeckle;inverse 环带 2px→1px、颜色取邻近前景均值;**双管齐下**
- 运行时保险:`pet_native.rs` 的 `load_png` 改四舍五入预乘 + a<8 兜底;
  `blit_center_bottom` 最近邻→**预乘空间双线性采样**(ULW 兼容)
- 重生成全部 `ui/pets/**`;像素抽检:whale idle 帧 `0<a<96=0, isolated=0`(浮雾归零)

### 1.2 总指挥工作动态 + 权限申请提示

- `themes/runtime.js`:新增 `scanActivity`("停止生成"按钮 → busy) +
  `scanApproval`(dialog/modal 内"允许"+"拒绝"成对 → 等待审批);act 防抖 2 次连续
  确认、wait 出现即时上报/消失 2 次确认;`syncHash` 拼 `&act=Z&wait=0|1`;
  临时探针 `__miasakiProbe()` 便于 Operator 校准
- `scripts/gen-bubbles.ps1`:气泡 17→20 帧(新增"忙碌中…/等待审批/需要你的批准")
- `src-tauri/pet_native.rs`:`PetShared` 增 `activity`/`waiting_approval`;
  `compose` 优先级 **waiting > busy > intensity**;waiting 强制 kurumi `wait` 行
  (复用既有素材,偶发语义对)+ whale·inverse `work` 立绘 + 常驻审批气泡(状态帧
  跳 3s 过期);waiting 禁 ambient/wander;waiting 中单击桌宠 = 唤起主窗口
- `src-tauri/main.rs`:`parse_fragment` 增 `act=`/`wait=` 解析分发

### 1.3 构建验证

- `cargo build --release --offline` 27.52s 通过(无 warning)
- 启动 Miasaki 8s:`tick0 mode=whale int=idle whale_states=3 kurumi_rows=6 buf_nonzero=26419`
- runtime.js 解析+执行通过,`__miasakiProbe` 已挂 window

---

## 2. 与原草案的偏差(供后续对照)

| 草案点 | 草案设想 | 本期实际 | 后续处理 |
|---|---|---|---|
| 数据源 | `state/fleet-pulse.json`(B 侧聚合器) | DSH 主页面 DOM(runtime.js scan) | 员工状态归 fleet-monitor,不再做 pulse |
| 状态范围 | fleet_state(idle/busy/waiting/warn/alert) | act(busy/idle) + wait(0/1) | warn/alert 走 fleet-monitor,本桌宠不预警 |
| 气泡文案 | 动态文本(可拼 t-id/进度) | 预渲染固定 3 状态帧 | 用户决定;Win11 多线程 GDI 字体崩溃也排除动态方案 |
| 跨线协议 | `state/fleet-pulse.json` 契约 + 写者单一 | hash 新增 `act=/wait=`,无新文件 | — |

> **2026-10-05 更正**(针对本表「数据源」「状态范围」两行):
> 「员工状态归 fleet-monitor,**不再做 pulse**」已被推翻 —— `fleet-pulse.json` v2(2026-09-04)正是桌宠 Fleet 指示器的
> **首选数据源**(fleet 文件总线;DOM 扫描转为兜底);「本桌宠不预警」也不再完全成立 —— 桌宠会按**聚合计数**进入
> **fleet 告警**(`blocked`/`error` ⇒ `failed` 行 + 常驻气泡)与 **fleet 运行中**(`running`)两态。
> **仍然成立的部分**:逐 agent 的卡片状态映射没做,`warn`/`alert` 这类**员工级**状态仍归
> `dsh-miasaki-fleet/fleet-monitor/` 面板,不进桌宠(`dsh-miasaki-desktop/README.md` 原文:
> 「agent 员工状态后续归 `dsh-miasaki-fleet/fleet-monitor/` 工作面板,不进桌宠」)。

---

## 3. 后续阶段(本期留接口,未实施)

1. **桌宠内一键审批**:waiting 中单击桌宠 = `eval_status()` 注入 JS 点击页面
   "允许"按钮;右键菜单加"拒绝"项。依赖 §1.2 校准后的选择器,Rust→JS 通道
   现成(`push_pet_state` 同模式)。防误触需 1s 二次确认或仅气泡显示期间有效。
2. **agent 员工状态监控面板**:`dsh-miasaki-fleet/fleet-monitor/panel.html` 增强,
   独立任务另行规划。

---

## 4. 验收清单(用户机执行)

- [ ] 启动 Miasaki 8s,桌宠窗口存在(`MiasakiPetWin` 类名,pet.log 帧加载记录)
- [ ] 三角色边缘真机观察(whale idle 帧序列、kurumi 全 9 行、inverse 三态):
  无散点、无光晕圈,kurumi 放大无锯齿簇、inverse 边缘平滑
- [ ] 触发一次总指挥生成:≤3s 内桌宠进 busy(whale/inverse 切 work 立绘),
  回答结束 ≤3s 回 idle,不抖动
- [ ] 触发一次需批准的工具调用:kurumi 切 `wait` 行(whale/inverse work 立绘)
  + "等待审批"气泡常驻不消失
- [ ] waiting 中单击桌宠:主窗口唤起并聚焦;批准后 3s 内姿态/气泡恢复
- [ ] console 跑 `__miasakiProbe()`:act/wait 候选按钮文本命中预期(若 DSH 改版,
  按需微调 `themes/runtime.js` 顶部常量区的 `ACT_BTN_TEXT` / `APPROVE_TEXT` /
  `DENY_TEXT` / `APPROVE_CONTAINER_SEL`)
- [ ] 回归:主题切换/单击 hop/双击 wave/右键菜单/托盘行为与现状一致
