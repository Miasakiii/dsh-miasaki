# 桌宠参考实现对标评估（MerZlin/dsh-pet-indesktop）

> 状态：**评估稿（2026-09-16），仅调研与建议，零代码改动。**
> 评估对象：第三方 fork `MerZlin/dsh-pet-indesktop`（上游 `PC2005-cloud/dsh-pet` 的跨平台移植，
> Python + PySide6，仓库自述 v4.2.0；本机全量套件 1950 passed）。
> 对照基线：本项目 `pet-v3-roadmap.md`（v3 **M1/M2 已落地**，M3/M4/M5 待做）、
> `ARCHITECTURE.md`（单向依赖/铁律）、`TODO.md`（P0 挂起未收敛）。
> 证据来源：源码快照归档于 `_refs/dsh-pet-indesktop/`（会话期临时档案，**不入库**，已 ignore）。
> 本文所有引用均标注 `文件:行号` 或函数名，可回溯核对。

---

## 0. 结论先行

1. **值得参考的不是它的架构，而是它在四个「我们还没走到」的地方踩过的坑**：
   审批交互的**幂等关联与队列语义**、气泡/提醒的**单槽 → 队列**演进、
   窗口**逐像素鼠标穿透**与**不夺焦点**、以及**行数预算/架构红线**式工程治理。
2. **两条零素材、零依赖、与我方架构完全契合的缺口被它直接证实**：
   - 我方桌宠**没有透明区域穿透**（全仓 `grep WS_EX_TRANSPARENT|NCHITTEST|SetWindowRgn` 无命中），
     角色的透明画布区域会吃掉下层窗口的点击；
   - 我方桌宠窗口样式为 `WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW`
     （`pet_native/window.rs:998`），**缺 `WS_EX_NOACTIVATE`** —— 点击桌宠会激活该窗口，
     参考项目记录该缺陷会让用户随后的 Ctrl+C/V「整机失效」（其 issue #98）。
3. **它的素材不可用**：角色动画为 CC BY-NC-SA 类同人素材（`THIRD_PARTY_NOTICES.md` §2，
   仅限个人非商业、须署名）。本项目继续走自建素材链，**不引入其任何素材与代码**。
4. **它没有解决我们的 P0**（偶发「全黑无响应」挂起）：全仓未见「GUI 事件循环心跳超时 →
   落盘线程栈 / 自愈」类进程内看门狗机制（其 `*_watchdog` 均属业务级：解码流、IPC 选主、
   Agent 行为循环）。**这条不能指望借鉴，得自建**。
5. **本次对标还查出一处我方真实漏报面**（深挖 A）：我方桌宠只读**当前选中会话**
   （`plugins/dsh-pet-panel/lib/client.js:216-232` 写死 `ls.current`）——用户切到另一个会话后，
   别的会话正在等待的审批**在桌宠上完全不可见**。而「快捷提权」的价值前提正是「不用切窗口」。
   官方 `pendingInteractions` 本身就是 `ReadonlyMap<SessionId, …>`，改为遍历即可，
   **`client.js` ~10 行、Rust 零改动**（见 §4 第一批 R0）。
6. **一条改变 M5 顺序的架构判断**（深挖 B）：参考项目在**三个独立文件**里写明「旋转/形变
   在绘制层完成、**不依赖素材**、不改动帧缓存与解码链」⇒ 用户抱怨的「动作太少」里
   **有一大块不需要出图**（黄金回旋 / Q 弹挤压 / 甩出 / 探头倾斜都是纯绘制变换）；
   而真正要补的是 **whale `work`/`deep` 与 inverse 三态目前各只有 1 帧**——这是
   「非 idle 态完全静止」的最强来源。M5 的正确顺序因此是：**先建变换管线 → 再补单帧 →
   最后才谈新动作素材**（详见 §2.8 与 R11–R15）。

> **订正一处历史记录**：`pet-v3-roadmap.md:100` 的「审批只有通知」结论，针对的是其**上游
> `PC2005-cloud/dsh-pet` 的 Electron 版**，**不适用于本次评估的 fork**——本 fork 已实现完整的
> 可点击审批（气泡内「同意/拒绝」→ 回写），是我方 M3.2 的直接参照。

---

## 1. 评估对象与边界

| 维度 | 事实 |
|---|---|
| 形态 | 独立桌面宠物应用（**脱离 DSH 运行时**），Python + PySide6，PyInstaller onedir + Inno Setup 打包 |
| 素材 | VP9-alpha 透明 `.webm`（640×360 / 24fps），ffmpeg 常驻解码；GIF 变体已停供 |
| 与 DSH 的关系 | 通过 `integrations/dsh-pet-bridge/`（host 侧 cordis 插件，MIT）+ WebSocket mux 中继读取 DSH 事件，写本地 JSONL 供 Python 侧消费 |
| 能力面 | 106 个动画、拖拽物理、边缘探头、多窗（单进程多开 + 共享解码链）、灵动岛、待办提醒、识屏、AI 对话、七域设置与菜单编排 |
| 许可 | 代码 MIT；**角色动画素材非商用**（见 §0.3） |
| 与我方关系 | 同源不同实现：我方是 DSH 桌面壳内的原生分层窗桌宠（Tauri 2 + Rust + PNG 图集） |

**边界（本次评估不做的判断）**：不评估其产品质量与稳定性，只提取**机制与教训**；
不因「它有而我们没有」就建议照搬，每一项都要过 `ARCHITECTURE.md` 的铁律（零新增依赖、
33ms 主路径零分配、不新增 GDI 对象、单向 hash 通道）与 `pet-v3-roadmap.md` 的既有设计。

---

## 2. 参考实现全景（按与本项目相关度排序）

### 2.1 DSH 联动与审批链路（与我方 M2/M3 正面相关）

它的链路是**三段式**：DSH 事件源 → bridge 写 JSONL → Python monitor/AgentLinkManager → 气泡与按钮。

```
DSH host 事件(session/event, agent/status, cordis/request-run)
        ├─→ dsh-pet-bridge (host cordis 插件) ─写→ ~/.dsh-pet/agent-events/dsh-<pid>.jsonl
        └─→ WebSocket ws://127.0.0.1:<port>/api/events.mux
                └─ 权威交互帧 approval/requested · question/requested · */resolved（带 rpcId）
                        └─→ 同上 JSONL（可交互版本）
JSONL → DshMonitor(增量读) → AgentLinkManager(交互队列/气泡优先级) → PetWindow(气泡 + 按钮)
按钮点击 → POST /api/respond（allowed-once | rejected）→ 等待 resolved 事件确认
```

**几条硬教训（对我方 M3 直接可用）**：

| # | 教训 | 证据 |
|---|---|---|
| L1 | **`approval/asked`（会话/审计信号）≠ UI 层真实待确认审批**。把前者升级成审批气泡，会挂出一个**永远等不到 resolved** 的常驻气泡 | `integrations/dsh-pet-bridge/index.js:1541-1554` 注释明确；UI 审批只由 mux `approval/requested`（带 `rpcId`+`sessionId`）产生（`:1151-1160`） |
| L2 | **resolved 必须按稳定关联键精确移除，不能按队列位置**；去重降级键（`tool+command`）只在**没有任何稳定身份**时才生成，且必须拼入 `sessionId`，否则同会话 8s 内两个不同审批会被静默吞掉 | `index.js:1292-1320`、`docs/DSH-BRIDGE-PET-EVENT-CONTRACT-2026-09-02.md`「当前验收重点」 |
| L3 | **cordis 动态插件运行审批是独立类别**（`kind:"cordis"`，`requiresApproval` 嵌在 `payload` 内），不能伪装成普通 approval | `index.js:1433-1439`、契约文档同节 |
| L4 | **阻塞交互需要锁存**：进入 `waiting_approval`/`waiting_question` 后暂时忽略后续 thinking/working，直到成对的 `decided/resolved` 到达；并有 **120s 兜底**超时回到 `working`，DSH 离线则整体清空 | `pet/dsh_state.py`（状态机表）、`docs/PET-STATE-MACHINE-AND-REPETITION-2026-09-02.md` §一 |
| L5 | **链路断了也要能收尾**：mux 中途连上/断线会丢 `resolved`，必须有兜底写盘路径，否则「桌宠卡死在 waiting」 | `index.js:1021-1034`（`resolveQuestion` 的注释即此教训） |
| L6 | 多会话聚合优先级 **attention > error > working > thinking > idle**，**子代理不抢状态** | `docs/RELEASE-v4.2.0.md`「DSH 富事件状态」 |
| L7 | **事件汇报概率门（Report Gate）**：单一 `0.00–1.00` 概率作为「某类事件汇报多少」的唯一旋钮（无布尔开关）；**门只作用于气泡那一步**，检测器与原始记录链永不被采样 | `CONTEXT.md`「Report Gate / Gate Group」词条 |
| L8 | **可关联身份门禁**：拿不到稳定关联键（`rpcId`/`approvalId`/`requestId`/`callId`）的审批**一律不弹窗**——宁可不报，也不挂一个永远关不掉的 sticky 气泡 | `pet/agent_link.py:3190-3194` |
| L9 | **多会话聚合「任一忙=忙」**：必须按 agent 分别跟踪再聚合；全局单值去重会让先完成的 agent 把还在干活的顶成 `idle`。且 agent 创建瞬间**不写 `idle`**（数毫秒后必发 running，幻影 idle 会占住换帧节流位） | `integrations/dsh-pet-bridge/index.js:43-62` |
| L10 | **跨告警源节流**：同档或更低档抑制、更高档放行、**抑制不记账**。顺序纪律：**判定在展示之前、记账在真的展示之后**（其 F14 踩坑注释即此） | `pet/agent_link.py:3908-3935`、`:3963-3971` |

**与我方现状的对照**：我方走的是**官方客户端契约**（`ctx.sessions` + `ctx.uiSession.pendingInteractions`
→ `window.__miasakiPetPanel` → hash `pet=`），比它的 JSONL+HTTP 链路**更短、更少故障面**，
不需要照搬（见 §5）。但它踩过的 L1–L5 恰好是我方 M3 即将面对的同一类语义问题。

### 2.2 提醒队列：我方「单槽气泡」到 M3 必须补的一课

我方现状：`pet_native/window.rs` 的气泡是**单槽** `bubble: Option<(usize, Instant)>`（`:31`），
状态帧常驻、随机台词 3s 过期，靠 `next_quote` 门控。加入「审批气泡 + 按钮」后，
单槽会遇到三个已在参考项目发生过的故障：

| 故障 | 参考项目的解法 | 证据 |
|---|---|---|
| 并发提醒互相顶掉 / 误关他人 | `show_alert(alert_id, priority, sticky, buttons)` 入队 + `resolve_alert(alert_id)` **按 id 精确移除**（正在展示→收起并推进队首；在队列→移除，不打断当前） | `pet/window_alerts.py:68-160` |
| 同 id 重复到达 | 同 id **正在展示**→就地替换（升级文案/按钮）；同 id **在队列**→移除旧条目由新条目接管 | `:97-116` |
| 高优先级被低优先级占位 | `priority` 更小者**抢占**当前项；被抢占的 sticky 项 `appendleft` 回队列可恢复 | `:117-136` |

另外两条防御值得直接抄语义：

- **抑制期只压普通展示**：设置窗打开等场景，`alert_survives_suppression()` 让审批/提问/控制/
  限流/失败等**有状态事件永远存活**（`window_alerts.py:18-28`）；且抑制结束后，被隐藏的
  **普通限时提醒必须结束并推进队列**——否则队列永久卡死、后续提醒（含审批）再也不出现
  （`:55-65` 的注释即该 bug 的修复）。
- **sticky 恢复防抖 300ms**：避免「审批被盖 → 恢复 → 再盖」的抖动循环（`:215-247`）；
  自言自语**不覆盖 sticky 提醒**（`:307-309`）。

> 对我方的含义：M3 的审批气泡必须**常驻到 resolved**，而 done 庆祝/随机台词/状态气泡
> 仍在跑。单槽无法表达，需要在 Rust 侧引入「带 id 与优先级的提醒队列」——**这是 M3 的前置结构改造**，
> 建议与 M3.1 同期落地（详见 §4 的 **R4**）。

### 2.3 窗口层：逐像素穿透 + 不夺焦点（我方两处真实缺口）

**(a) 透明区域鼠标穿透**

参考项目（Windows）：独立定时器轮询光标（常态 10ms / 拖拽中 100ms），
`_is_transparent_at(local)` 查当前帧 alpha，命中透明像素就置位 `WS_EX_TRANSPARENT`；
非 Windows 走 `setMask`。且明确「`HTTRANSPARENT` 只能继续命中当前线程的窗口，
无法穿透到其他应用」，所以必须用扩展样式位。

- 证据：`pet/platform_win.py:49-120`（`_set_windows_click_through` / `WindowsPerPixelInputController`）、
  `pet/window.py:12`（模块头说明）、`:2159-2220`（`_sync_mask` / `_is_transparent_at`）、
  `pet/window.py:2038-2047`（命中测试复用已缩放的预乘图，避免二次 `toImage`）。
- **两个必须一起抄的实现约束**：① **置位后窗口收不到鼠标消息**，所以「何时恢复」不能靠鼠标事件驱动，
  只能靠**独立定时器**轮询光标（参考侧常态 10ms、拖拽中降为 100ms）；② 命中判据用 alpha 阈值
  （参考侧 `alpha < 16`），旋转姿态须先做**逆变换**再采样；可交互的气泡区域走「非透明白名单」。
- 代价参考：mask 重建按 ~30Hz 限频（`window.py:2380-2385`），命中缓存与画面同源。

**我方缺口**：`grep -r "NCHITTEST|WS_EX_TRANSPARENT|SetWindowRgn|hit_test"` 在我方 `src-tauri/src/`
**零命中** → 目前 286×390 的整窗矩形都会吃掉鼠标，角色以外的透明区域挡住下层窗口点击。
我方已有帧数据裸指针（`ARCHITECTURE.md` §2「帧数据启动时一次性加载，裸指针共享」）与
预乘 alpha，查表成本极低；窗口线程已有 33ms compose 循环，可就近做命中判定，
**无需新增线程、无需新增 GDI 对象**。

**(b) 点击不夺前台（`WS_EX_NOACTIVATE`）**

参考项目为其 issue #98 的根因：桌宠被点击后成为前台窗口，用户随后的键盘输入
（Ctrl+C/V）全部落到桌宠，观感是「整机复制粘贴失效」，点回原窗口才恢复；
解是只加 `WS_EX_NOACTIVATE`（不影响鼠标/键盘消息与逐像素穿透判定，不重建原生窗口）。

- 证据：`pet/platform_win.py:32-76`（含注释）、`:60-76`（`_set_windows_no_activate`）。

**我方缺口**：窗口样式无该位（`pet_native/window.rs:998`）。我方 v3 M1.3 只做到
「单击不再主动 `focus_main()`」，但**窗口自身的激活语义未处理**。需实机确认（见 §6 决策 3）。

### 2.4 边缘探头（我方 M4.1 的现成算法口径）

参考项目的探头是**旋转姿态**而非简单裁剪，参数与口径可直接用于我校准：

| 参数 | 值 | 含义 |
|---|---|---|
| `EDGE_PROBE_ANGLE` | 45.0 | 探头姿态旋转角（±45°） |
| `EDGE_PEEK_EXPOSURE` | 0.55 | 常驻露出比例 |
| `EDGE_ENGAGE_EXPOSURE` | 0.82 | 点击拉直后的露出比例 |
| `EDGE_ENTER_MS` / `EDGE_STRAIGHTEN_MS` / `EDGE_RETURN_MS` | 300 / 250 / 300 | 进入/拉直/退回动画时长 |
| `EDGE_IDLE_SECONDS` | 5.0 | 静置多久进入探头 |
| 状态机 | `OFF/ENTERING/PEEKING/STRAIGHTENING/STRAIGHTENED/RETURNING` | `edge_probe.py:32-39` |

**关键口径**：露出量的分母必须是「**当前姿态（含 ±45° 旋转）的投影 bbox 宽度**」，
不是未旋转的角色宽度——旋转会让水平投影变宽，用错分母会导致实际露出量与设计不符。

- 证据：`pet/edge_probe.py:19-30`（常量）、`:401-407`（旋转后 bbox 作分母的注释与实现）、
  `pet/window_effects.py`（`rotated_region_bounds` / `unrotate_point`）。

> 与我方 roadmap 的差异：我方原计划「静置 ≥15s 缩边、露 ~35%」，参考项目是
> **5s / 0.55**，且带姿态旋转与点击拉直。建议 M4.1 采纳其口径与参数作为起点，
> 但**先不引入旋转姿态**（我方无旋转帧素材，旋转会暴露预乘插值边缘问题）——
> 分两步：先做「水平收缩露头」，旋转姿态留待素材就绪。

### 2.5 位置持久化与「桌宠丢了」（我方 D6 / M4.1 坑位的现成答案）

参考项目的位置模型比我方当前实现更抗环境变化：

| 机制 | 做法 | 证据 |
|---|---|---|
| **比例化持久化** | 存「窗口中心相对屏幕**可用区**（排除任务栏）的比例」`rx/ry` + **屏幕名**，而不是绝对坐标 → 分辨率/缩放变化后位置仍正确 | `pet/window_placement.py:247-263` |
| **可见性判据 = 角色轮廓** | `visible_content_rect()` 以 **alpha mask 的 boundingRect**（角色实际可见轮廓）为准，明确注释「其他窗口该贴着角色而不是透明画布」 | `:183-200` |
| **副屏暂未就绪** | 开机自启时目标副屏不在线 → 先落主屏，**此期间拒绝写回位置/屏名**（否则会把副屏坐标永久覆盖），并由 `screenAdded` 监听上线后恢复；另有屏幕几何未稳的定时重试 | `:203-244`、`:92-170` |
| **重置前的动作清理** | 回默认角落前先 `_cancel_move()` / `_stop_physics()`，否则插值/物理定时器会把桌宠立刻拉回原处 | `:269-288` |

**对我的直接含义（roadmap §M4.1 已预警的那个坑）**：我方 `persist.rs:82-93` 的 `pos_visible`
用**窗口矩形**判可见性；一旦实现 peek（窗口中心在工作区外），重启即被判「不可见」→ 拉回默认位置
= 「桌宠丢了」回归。参考项目的答案是**把判据换成角色可见轮廓 ∩ 工作区**——
这个改动**独立于 M4.1 且可提前做**，顺带覆盖「窗口矩形相交但角色已基本出屏」的边界。

### 2.6 设置治理与工程红线（可借鉴的是门槛，不是体系）

- **设置准入/准出门禁**（`docs/SETTINGS-CHANGE-GATES.md`）：准入六条（是偏好不是命令、低频跨任务、
  有可靠默认、归属唯一、值得用户决策、契约完整）+ 准出五节（契约 / TDD / 布局与可访问性 /
  跨平台 / 视觉与文档）。对我方的用处：M3/M4 会往「设置 → 桌宠」加控件，先立一条
  轻量准入线可避免设置页膨胀。
- **架构红线测试**（`tests/test_architecture.py`）：纯逻辑层禁 Qt 依赖、共享解码链单向依赖、
  窗口私有面冻结（`win._xxx` 只允许 window 自身与 collision_client 访问）、`window.py`
  行数预算（4429 行）、孤儿簇守卫（文件存在但零引用 = 违规）——**红了即 CI 失败**。
  我方对应物是 `cargo test` 里的 `model.rs` 单测；可考虑补「文件行数预算 + 模块依赖方向」两条。
- **CI 成本纪律**（`AGENTS.md`）：推送前三道本地门（ruff / 全量测试 / 受影响时序族高负载复跑 3 遍）；
  时序测试一律事件同步 + 宽预算，禁止固定 sleep 猜时序、禁止赌目录枚举顺序。
- 内存治理口径（供我方参考其「测量方式」）：以「每个播过的片段永久持帧 ≈1.76MB/段」定位慢涨根因，
  改为切走即清显示槽；以及隐藏即停（暂停解码/定时器）、可选服务懒装配
  （`pet/window_optional_services.py`，关闭即不建线程/定时器）。

### 2.7 稳定性与生命周期（对我方 P0 的直接输入）

**先回答一个否定结论**：参考项目**没有**任何「进程内看门狗 / 消息循环心跳超时 → 落盘线程栈 / 自愈」机制——
`pet/` 全目录对 `faulthandler` / `sys._current_frames` / `traceback.print_stack` / `MiniDumpWriteDump`
**零命中**；它实际存在的 6 类 heartbeat/watchdog 全部是业务级的（GUI 帧间隔看门狗**仅在观测模式下启用、
只落一行 warning、不落栈不恢复**；fan-out stall 看门狗超时后回退本地解码；碰撞 IPC 500ms 静默看门狗；
Agent 业务检测器 ×2；pulse 时效判定）。
⇒ **我方 P0「偶发全黑无响应」无法从它抄现成方案**（`TODO.md` P0 的「进程内看门狗 or 外部抓 dump」二选一不变）。

**可抄的三类真金**：

| 主题 | 做法 | 证据 |
|---|---|---|
| Windows 会话结束闸门 | `WM_QUERYENDSESSION` → **冻结一切子进程派生**（会话拆除中创建进程会 `0xc0000142` 失败并阻塞关机）；顺序纪律「**先 `_pause_activity()` 再置 `_closing`**」（先置 `_closing` 会让停机变 no-op）；并附「会话结束时**刻意不做**写盘/解锁」的反向清单 | `pet/session_watcher.py`、`docs/ISSUE-111-WINDOWS-SESSION-END-FFMPEG-2026-09-12.md` |
| 进程真死活与防误杀 | `GetExitCodeProcess == STILL_ACTIVE` 判真死活（**不能**用「OpenProcess 能否打开」——父进程持句柄时已死子进程仍可打开，有实机事故）；杀前用 exe 路径核验 pid 身份防复用误杀 | `pet/child_pet_cleanup.py`、`docs/RELEASE-v4.2.0.md`「子肥鱼生命周期」 |
| 原子写退避 | `os.replace` 遇瞬时 `WinError 5`（Defender/索引器占用）走**有界退避**（0.05/0.1/0.2/0.4/0.8s），耗尽时最后一次不捕获、如实上抛 | `pet/chat/session_store.py` |

**工程红线**（其 `tests/test_architecture.py` 217 行**全是布尔断言、零外部依赖**）：纯逻辑层禁 Qt 依赖 /
共享解码链单向依赖 / 窗口私有面冻结 / 文件行数预算 / 顶层 import 禁令 / 孤儿簇守卫。
其中**行数预算必须三件套一起抄**（意图条款 + 校准账本 + 越线豁免），否则第一次越线就被绕过；
其 CI 实证「红线是**组合性质**」——两个各自绿的改动合起来越线，三平台同时红。

我方现状：`src-tauri/src/main.rs` 1296 行、`pet_native/window.rs` 1029 行**已近临界**，
且 Rust 侧**无独立测试目录**（`cargo test` 目前只有 `model.rs` 的内联单测）。

### 2.8 玩法与物理：零素材的动作扩容（对「动作太少」的直接回应）

**结构性发现（本次对标最有价值的一条）**：参考项目在**三个独立文件**里重复同一句架构判断——
旋转/形变**在绘制层完成、不依赖素材、不改动帧缓存与解码链**
（`pet/golden_spin.py:5`、`pet/throw_egg.py:34`、`pet/window_effects.py:3-6`）。
⇒ 用户抱怨的「动作太少」里**有一大块不需要新素材**：黄金回旋、Q 弹挤压、甩出、探头倾斜
全是纯绘制变换；真正需要出图的只有「探头/攀爬的**姿态语义**」与非 idle 态的**单帧问题**。

| 玩法 | 关键参数 / 算法 | 证据 |
|---|---|---|
| 甩出物理 | `GRAVITY=1400` / `RESTITUTION=0.78` / `GROUND_FRICTION=2.5` / `REST_VY=40` / `REST_VX=15`；释放速度 = 端点均值 0.5 + 峰值 0.5 加权、加速度增益上限 0.6、死区 500px/s；`soft_clamp_speed` 软钳到上限 | `pet/physics.py:17-27, 77-83, 181-210` |
| 黄金回旋 | 700ms/圈；连点把当前圈压到 130ms 收尾、逐圈 ×0.82、下限 200ms | `pet/golden_spin.py:22-26, 127-131, 153-163` |
| 撞飞旋转 | 头部角度 = `90° + atan2(vy, vx)`；**双档阈值**：贴地 780px/s（更低会因连续碰撞让头部来回变向）、空中仅 150px/s（否则中段飞行角度被冻结） | `pet/throw_egg.py:20, 26, 71-73` |
| 省电降帧 | 闲置 30s 后按**源时间线帧号**隔帧发布（`% 2 == 0`，**不许改播放速率**）；门控含按压/菜单/Agent 忙；**解码节流与显示跳帧不可叠乘**；默认关（灰度） | `pet/window.py:177-185, 824-838, 840-857, 866-898` |
| 拖动合帧 | 只记最新绝对目标 + 8ms 定时器消费（≈120Hz），松手强制 flush | `docs/RELEASE-v4.2.0.md`「拖拽合帧」、`tests/test_drag_move_coalescing.py` |

**我方对应缺口**：`WM_MOUSEMOVE` 逐事件 `MoveWindow`（`window.rs:736-754`——1000Hz 鼠标即每秒千次窗口移动）；
compose 固定 33ms（`window.rs:697`）；**无任何绘制变换层**（`blit_img` 逐像素直搬，`window.rs:491-516`）。

**B 方向点名「不照搬」**：气泡分页/动态文本（我方气泡是**构建期位图**，运行时排版必须调 GDI 字体
= 踩 `CreateFontW` 确定性崩溃，`README.md:184-189`）；灵动岛（1232 行，与 fleet 工作面板职责重叠）；
多开 IPC 碰撞（我方单实例前提不成立）；主动识屏（我方无截图与模型凭据，正确落位在 DSH 插件侧）；
语音报时（无音频栈）。

---

## 3. 可迁移性分级汇总

评级口径：**高** = 与我方架构同构、可直接落地；**中** = 需新增状态或结构，收益明确但成本可观；
**低** = 与架构前提冲突或收益不抵成本。

| # | 项 | 参考实现 | 我方现状（证据） | 分级 | 素材依赖 |
|---|---|---|---|---|---|
| 1 | **跨会话聚合待审批** | `index.js:43-62`「任一忙=忙」 | 只读 `ls.current`（`client.js:216-232`）→ **切走会话即漏报** | **高** | 无 |
| 2 | **审批身份透出 + 身份门禁** | 无 `rpcId/approvalId/requestId/callId` 一律不弹窗（`agent_link.py:3190-3194`） | 只取 `toolName`，无 sessionId/reason（`client.js:195-209`） | **高** | 无 |
| 3 | 透明区域穿透 | `platform_win.py:49-120` | 无（全窗矩形吃鼠标） | **高** | 无 |
| 4 | 点击不夺前台 | `WS_EX_NOACTIVATE`（`platform_win.py:60-76`） | 样式无该位（`window.rs:998`） | **高** | 无 |
| 5 | 提醒队列（id/优先级/sticky/精确移除） | `window_alerts.py:68-160` | 单槽 `bubble`（`window.rs:31`） | **中**（并发时才成刚需；M3.2 后必需） | 无 |
| 6 | 审批内联决策 | 气泡按钮 → 回写 | 无任何决策命令（`main.rs:806-847`） | **高**（路径换官方 `answer()`） | 需按钮位图（可预渲染） |
| 7 | 30s 跨告警源节流 | `_detector_alert_gate`（同档抑制/越级放行/**抑制不记账**） | 无（`fleet_alert` 与 `waiting` 靠优先级互斥，仍会来回抢气泡） | **高**（~20 行） | 无 |
| 8 | 三类交互区分（approval/question/cordis） | 三套独立处理 | 仅 `kind==='approval'` | 中（question 需另接官方槽位） | 气泡帧 +2 |
| 9 | 位置持久化 v2 + 可见性判据 | `window_placement.py:183-263` | 绝对坐标 + 窗口矩形判可见（`persist.rs:82-93`） | **高** | 无 |
| 10 | 边缘探头参数与口径 | `edge_probe.py:19-39, 401-407` | M4.1 未做 | 中高 | 水平收缩可无素材；旋转姿态需素材 |
| 11 | 暂停/恢复的计时锚点后移 | `exploration_watchdog.py:260-307` | 隐藏后 compose 仍 33ms 跑 | 中 | 无 |
| 12 | 阻塞交互锁存 + 120s 兜底 | `dsh_state.py:56-59` | 无锁存——**不需要**（快照驱动天然自洽，5s 老化已覆盖兜底目的） | **低（不照搬）** | — |
| 13 | 事件汇报概率门 / 三检测器 / 429 门 | `agent_link.py` 等 | 无（前置是事件级通道） | 低（当前无源之水） | — |
| 14 | JSONL 桥接写盘 + tailer | `integrations/dsh-pet-bridge/` | 已有官方 ctx 直读 | **低（不照搬）** | — |
| 15 | 架构红线测试 / 设置门禁 | `tests/test_architecture.py`、`docs/SETTINGS-CHANGE-GATES.md` | 部分（`cargo test` 有模型单测） | 中 | 无 |
| 16 | 已在且无需迁移 | 子代理不抢主态 | 我方**已有**且更直接（`client.js:221`） | — | — |
| 17 | 绘制层变换管线（旋转/形变/挤压） | `window_effects.py:18-95`（明确「不依赖素材」） | 无——`blit_img` 逐像素直搬（`window.rs:491-516`） | **高** | 零 |
| 18 | 甩出 / 惯性 / 反弹物理 | `physics.py:17-27`（常量与函数可整段移植） | 无（松手即停，`window.rs:773-778`） | **高** | 零 |
| 19 | 拖动合帧 | 8ms 目标合帧 + 回归测试 | `WM_MOUSEMOVE` 逐事件 `MoveWindow`（`window.rs:736-754`） | **高** | 零 |
| 20 | 省电降帧 | 闲置 30s 隔帧发布 | 无（compose 恒 33ms） | 中高 | 零 |
| 21 | 气泡分页 / 运行时动态文本 | 避头尾 / 孤行再平衡 / 按字数停留 | 构建期预渲染位图 | **低（结构性阻断）** | — |

**深挖 A 附带查出的两处我方次生风险**（推测，未实测）：① 官方通道活跃时 DOM 扫描被跳过、
但 `act=/wait=` 仍每轮输出（`02-core.js:51-52`），通道死亡瞬间可能回落到**陈旧值**，
理论上有约 1.5–3s 的 `waiting` 误报窗口；② `pettool` 只在 waiting 分支赋值
（`client.js:247`），Rust `official_tool` **只在 Waiting 态有意义**，M3 复用时勿当通用「当前工具」字段。

---

## 4. 推荐落地清单（建议顺序）

### 第一批 · 零素材零依赖（**2026-09-16 已落地**）

| 编号 | 项 | 现状证据 | 做法要点 | 风险 |
|---|---|---|---|---|
| **R0** | **跨会话聚合待审批 + 审批身份门禁**（深挖 A 建议一/二） | 只读 `ls.current`（`client.js:216-232`）；审批只取 `toolName`（`:195-209`）；无任何回写命令 | ① 把「找审批」与「判 running」从 `ls.current` 改为遍历 `pendingInteractions`（本就是 `ReadonlyMap<SessionId,…>`）与 `ls.ids/byId`（list row 自带 `running`），聚合语义写死「审批 > 运行态」；② 审批项带上 `sessionId` + `reason`（截断，参考取 160 字符）写入 `window.__miasakiPetPanel`；③ 落地门禁：**拿不到 sessionId 就不显示审批态**（宁可不报，也不挂一个关不掉的态） | 极低（只读官方 map，不写不调用 `answer()`）；**Rust 零改动**，`client.js` ~25 行 |
| **R1** | **点击桌宠不夺前台** | `pet_native/window.rs:998` 无 `WS_EX_NOACTIVATE`；v3 M1.3 只做到「不主动 `focus_main()`」 | 创建窗口时补该扩展样式位（`ffi.rs` 加常量 + `CreateWindowExW` 实参），不重建原生窗口 | 极低（参考项目注释确认不影响鼠标/键盘消息与穿透判定） |
| **R2** | **透明区域逐像素穿透** | `grep WS_EX_TRANSPARENT\|NCHITTEST\|SetWindowRgn` 零命中 → 整窗矩形吃鼠标 | 按光标位置查**当前帧预乘 alpha**（帧数据已在内存，零拷贝）；命中透明像素则置位 `WS_EX_TRANSPARENT`，否则清除。**必须配独立定时器**（置位后收不到鼠标消息，不能靠事件驱动恢复）。阈值：参考侧用 `alpha < 16`，我方先按 `a < 8`（与 `load_png` 的 `a<8→0` 兜底一致）实测再定；拖拽中禁用穿透 | 中低（须实机确认切换不引起闪烁；参考项目的教训是**只改扩展样式位、不改窗口 flags**） |
| **R3** | **位置持久化 v2 + 可见性判据修正** | `persist.rs:82-93` 以窗口矩形判可见；`pet.json` 存绝对坐标 | `pet.json` v2：中心相对**工作区**比例 + 屏幕名（v1 静默迁移）；`pos_visible` 改判「角色可见轮廓 ∩ 工作区」 | 中低（有 v1 迁移先例；收益：**提前拆掉 M4.1 的 peek 误判坑**） |

### 第二批 · M3「快捷审查与提权」的前置与主体（**2026-09-16 已落地**）

| 编号 | 项 | 说明 |
|---|---|---|
| **R4** | **Rust 侧提醒队列**（M3 前置结构） | 把单槽 `bubble` 升级为 `id + priority + sticky + deadline` 队列：同 id 就地替换、高优先级抢占（被抢占的 sticky 项回队首可恢复）、`resolve(id)` 精确移除、随机台词不覆盖 sticky、恢复 300ms 防抖。**没有它，审批气泡会被 done/随机台词顶掉** |
| **R5** | **气泡内联审批（M3.2）** | 走官方 `PendingApproval.answer('allowed-once' \| 'rejected')`，**不引入 HTTP**（我方已实证 0.1.2-rc.1 起该路由移除）。三条纪律照抄：① **协议收窄**——只发两个枚举，不做「全部允许/记住选择」；② **先本地收起、再异步确认，失败必须回落到「请到 DSH 界面处理」**（桌宠绝不假装决策已生效）；③ **幂等与防重放**——`seq` 单飞 + 决策绑定 `sessionId`（而非仅 agent 键），已决策集合设上限（参考用 2048 FIFO）。链路：Rust 命中区 → hash `cmd=approve-once\|deny&seq=…` → 插件调用 `answer()`；按钮字号/图形走 `gen-bubbles.ps1` **预渲染位图**（GDI 字体禁区）。**前置：M0 S4 探针必须先过**；不过则降级为「提示 + 唤起主窗口」，不伪造响应 |
| **R6** | **等待态语义补全（需先探针）** | ① cordis 动态插件运行审批（参考单列 `kind:"cordis"`，且**无按钮**、有独立结果集 approved\|rejected\|cancelled\|failed\|completed）是否出现在我方 `pendingInteractions`；② **提问等待不在该通道**——官方 `SessionPendingInteractionMap` 当前只有 `approval` 域（`dsh-client-ui-approval/lib/types/client/contract/slots.d.ts:6-11`），`ask_user_question` 走 `dsh-client-ui-user-questions`，是新增通道而非改映射 |
| **R7** | **气泡最小驻留防抖**（M3 伴生；**落地时按我方实际情况重塑**，见下） | 参考的「跨检测器 30s 节流」作用于**事件型告警源**（stuck/pattern/exploration）；我方状态均为快照派生、无事件型检测器，照搬会把状态变化一并吞掉。故只取其**防抖内核**：同优先级新项在 `ALERT_MIN_DWELL_MS=900ms` 内不替换，审批(0)/告警(1) 恒可立即抢占（可读性优先） |

### 第三批 · 动作与物理扩容（**零素材优先**，直接回应「动作太少」）

| 编号 | 项 | 做法与验收 | 素材 |
|---|---|---|---|
| **R11** | **绘制层变换管线**（B 优先级 1 = M5 前置） | 在 `blit_img`（`window.rs:491-516`）之上加一层可选**仿射变换**（旋转 + 非等比 sx/sy + 绕 pivot），pivot 与命中判定**共用同一变换的逆**（对齐参考侧 `window_effects.py:18-95` 的双端一致原则）。它是**回旋 / 挤压 / 甩出 / 探头倾斜**四项玩法的共同前置。验收：`pet.log` 无新增 `ULW failed`；GDI 对象数不增（复用 `present_dib`）；一次 360° 旋转采样落在 33ms 预算内（打点实测） | **零** |
| **R12** | **甩出物理**（B 优先级 2） | 新建 `pet_native/physics.rs`（**纯函数、无 Win32 依赖**，与参考侧「纯逻辑层禁 Qt」同一分层）；轨迹环形缓冲 0.15s → 释放速度估计 → `Action::Thrown` 按参考常量积分。`Thrown` 必须落 `pick_state_row` **低优先级**且被 Waiting/FleetBlocked/Error 压过（D3 防线）并补单测；窗口边界改用 `monitor_workspaces()`（顺带修「副屏不可达」） | **零**（飞行复用 jump/idle 行） |
| **R13** | **拖动合帧**（B 优先级 4，R12 的必要前置） | `WM_MOUSEMOVE` 改「记最新绝对目标 + 8ms 定时器消费」，松手强制 flush；改为「抓取偏移 + 绝对目标」以免丢位移；首帧仍立即 `MoveWindow` 保跟手。**不做合帧，R12 的轨迹缓冲会被同帧重复样本污染** | **零** |
| **R8** | **省电降帧**（B 优先级 3） | 隔帧门控 + `last_activity` / `mark_activity()`；条件 `enabled && shown && 无按压 && 无菜单 && Idle && !fleet_running && 闲置 ≥ 阈值`；**按源时间线帧号**（不改播放速率），审批/告警态不降帧；默认关（灰度） | **零** |

### 第四批 · M4 边缘状态

| 编号 | 项 | 做法与验收 | 素材 |
|---|---|---|---|
| **R14** | **边缘探头（M4.1）** | 采纳口径：静置 5s 进入、常驻露出 **0.55**、点击拉直 **0.82**、300/250/300ms；**露出量分母 = 当前姿态投影 bbox 宽度**（按未旋转宽度算会「只剩一只眼」）；**`pause()/resume()` 平移过渡起点**（隐藏时长不吃进度，否则恢复后姿态从半途跳完）。三条实机教训照抄：① 露出常量 0.70 实测「探出过多」→ 0.55；② 探头会话期间必须**同时**拦住全部位移来源（我方对应 `WM_MOUSEMOVE` 与 wander 位移），缺一处就会「挂着探头姿态被平移出屏幕」；③ peek 态中心点在屏外 ⇒ **必须同步改 `pos_visible`**（即 R3）。**建议先做水平收缩**，±45° 旋转姿态等 R11 就绪后再上 | 水平收缩**零素材** |
| — | M4.2 主窗口吸附 | 参考项目**未实现**（README 级描述仅屏幕/工作区边界），无可借鉴，仍按我方原方案自建 | — |

### 第五批 · M5 立绘与素材（**顺序：先补单帧，再谈新动作**）

| 编号 | 项 | 做法 | 素材 |
|---|---|---|---|
| **R15** | ① 散步改用 `runRight`/`runLeft` 按方向选行（`Action::Wander` 现恒返 `"run"`，`model.rs:74`）；修正 `r7`（"坐姿用电脑"）被当散步播的语义错配；② whale `work`/`deep` 与 inverse 三态**目前各只有 1 帧**（`frames.json` 已核实）——这是「非 idle 态完全静止」的最强来源，补成帧序列即可显著改善，**无需新动作语义** | ①**零素材**；②走现有 `cut-frames.mjs` 链 | ①零 ②中 |

> **顺序理由**：v3 roadmap §0 的教训（「不修状态机就堆素材，新动作会被 `jump` 分支吃掉」）
> 有下半句——**不建变换管线就堆素材，新玩法会被「没有绘制变换」这个能力缺口吃掉**。

### 第六批 · P0「偶发全黑无响应」取证与降损（**独立于桌宠功能，建议单独立项**）

> 这组**不是**从参考项目抄来的（它没有对应机制，见 §2.7），而是深挖 C 基于我方已有证据给出的设计。
> 前提：WER 通道已榨干（无 dump、`LoadedModule entries: 0`），现状只能靠排除法。

| 编号 | 项 | 要点 | 成本 |
|---|---|---|---|
| **P0-1** | **独立 OS 线程心跳看门狗 + 自检 + dump** | 心跳源 = `compose` 里已有的 `AtomicU32`（`window.rs:52`）自增，`fetch_add` **零分配**、符合铁律；看门狗用 `std::thread::spawn`（独立调度，消息循环停摆时仍活着）。动作三层：**A 层必做**——写独立 `hang-<ts>.marker`（**不走共享 logger**，先 `flush` + `fsync`；含两计数器最后值与最后推进时间、`GetTickCount64()`、前台窗口标题、`pet.log` 长度与 mtime）——**这一层就能区分「主循环停摆」还是「全进程冻结」**；**B 层** `MiniDumpWriteDump`（`dbghelp` 裸 FFI，`WithThreadInfo\|WithUnloadedModules`，**不要** `WithFullMemory`）；**C 层**自动重启**默认关**（会把「偶发」变成「无法复现」）。**必做自检**：启动写 `armed` 证明 + `MIASAKI_HANG_SELFTEST=1` 人为触发端到端验证（否则就是第二个「`MIASAKI_NO_MICA` 从未部署到实跑路径」） | ~150–250 行 Rust |
| **P0-2** | **外部无响应探测 + 外部抓 dump** | 提权常驻脚本每 15–30s `SendMessageTimeoutW(hwnd, WM_NULL, SMTO_ABORTIFHUNG\|SMTO_BLOCK, 3000)`（与 Windows 判 `Responding=False` 同口径）；连续 3 次无响应 → **外部进程**抓 dump（不会自死锁）+ 句柄/GDI/工作集前后差分 + 托盘/气泡告知现场路径。脚本须断言目标 exe 的 SHA256/构建时间（同 `MIASAKI_NO_MICA` 的部署教训） | PowerShell ~120–200 行 |
| **P0-3** | **把「关不掉」从症状里摘出去** | ① **独立线程**强制退出通道（命名事件 + `TerminateProcess`，托盘入口）——不依赖消息循环（`RegisterHotKey` 同样依赖，不够）；② hash 看门狗里加「前端关闭弹窗超时」观察点；③ 给 `wv.url()`（唯一同步进主线程的 COM 调用）**设硬阈值出口**——当前是「慢则退避 1s 且**无限静默**」，正是我方自述的「局部卡顿 → 整个 UI 冻结」放大器 | ①80–120 ②30–60 ③40–80 行 |

### 第七批 · 可选（工程治理）

- **R9 Rust 侧架构红线**：补可自动化断言——文件行数预算、模块依赖方向（对齐其 `test_architecture.py` 思路，**不搬其体系**；行数预算须三件套一起立：意图条款 + 校准账本 + 越线豁免）。
- **R10 设置准入轻量线**：新增「设置 → 桌宠」控件前先过「是偏好而非命令 / 有可靠默认 / 归属唯一」三问。

---

## 5. 明确不采纳

| 项 | 不采纳原因 |
|---|---|
| JSONL 事件桥接 + `POST /api/respond` | 我方已有**官方客户端契约**（`ctx.sessions` / `ctx.uiSession.pendingInteractions`）与 `answer()` 直连，链路更短、无写盘、无额外 HTTP；引入 JSONL 会与官方直读构成**双源并存**，违反 `ARCHITECTURE.md:36` 与 roadmap「不是两者并存」。另外 `POST /api/respond` 这条路由在 0.1.2-rc.1 起**已移除**（我方 `client.js:113-117` 实证） |
| 阻塞交互锁存 + 120s 超时 | 我方态直接从官方快照推导（快照消失态即消失），**不需要锁存**；引入反而与快照驱动构成两个真相源。其 120s 兜底的**目的**已被我方 `OFFICIAL_FRESH_MS=5000` 老化覆盖 |
| 事件汇报概率门 + 三个行为检测器（stuck/pattern/exploration） | 当前无源之水：我方只有 `running` 布尔与 `lastAgentError`，检测器所需的 tool/result/errorCode/timeout 事件级数据不存在；先建事件通道才谈得上 |
| 子代理 → 根会话归一（`resolveControlRoot`） | 为 watchdog 的 interrupt/replan 服务，我方无控制命令需求；且我方**已有**更直接的子代理排除（`client.js:221`） |
| 多 Agent 适配器抽象（Claude/Cursor/OpenCode Monitor） | 我方只有 DSH 一条线，抽象是净负担 |
| `agent-event/v1` 完整契约（字段/有界化/别名表） | 我方无需事件流；但**可借其字段命名**（`sessionId`/`callId`/`reason`）作为插件→Rust 的上报字段规范（零运行时成本） |
| webm 视频素材 + ffmpeg 解码链 | 违反 `ARCHITECTURE.md` 铁律（零新增依赖 + 33ms 主路径零分配 + 不新增 GDI 对象）；且我方是 PNG 图集帧动画 |
| Electron / 独立进程模型 / PyInstaller onedir | 我方是 Tauri 2 单进程薄壳，进程模型是既有决策 |
| 其角色动画素材（webm/声音） | CC BY-NC-SA 类条款，仅限个人非商业使用，须署名；**不引入** |
| Python/Qt 专有实现（QSS 主题、keyring、Fcitx、Qt mask） | 平台栈不同，机制可参照、代码不可搬 |
| 气泡分页 / 运行时动态文本 | **结构性阻断**：我方气泡是**构建期预渲染位图**，运行时排版必须调 GDI 字体 → 踩 `CreateFontW` 确定性崩溃（`README.md:184-189`）。要长文本只能「预渲染更多帧」或换绘制栈 |
| 灵动岛 / 主动识屏 / 语音报时 / 多开 IPC 碰撞 | 前提不成立或职责重叠：灵动岛与 fleet 工作面板职责重叠（`README.md:118-119` 已划定「agent 员工状态不进桌宠」）；主动识屏我方无截图与模型凭据，正确落位在 **DSH 插件侧**；语音报时无音频栈；多开碰撞以「同素材多窗」为前提，我方单实例 |

---

## 6. 待用户拍板

1. **第一批 R0–R3 是否立即落地？**（建议：是。四项都是零素材、零依赖、不动状态机；
   **R0 优先**——它是 v3 M3 的价值前提，且 Rust 零改动；R1/R2 需真机（提权 + 真实 DSH 页）验收；
   R3 有单测可覆盖）
2. **跨会话审批提示的语义边界（R0 的产品决策）**：桌宠是否应当提示**非当前会话**的待审批？
   若提示，气泡是否需标明来源会话名？这会影响 `pettool` 之外的 hash 字段设计。
3. **M3.2「桌宠内一键审批」是否做？** 参考项目已把这条链路跑通并留下大量踩坑记录，
   官方 `answer()` 契约在我方探针中已实证可达（`CHANGELOG` 2026-09-12 M0/S4）。
   成本集中在**按钮位图预渲染 + 命中区 + 误操作防护**，收益是真正的「不切窗口即提权」。
4. **穿透阈值与半透明边缘策略**：`a < 8` 视为透明是否合适？角色描边/光晕的半透明像素
   （如狂三的血红辉光）若被算作「不透明」，会出现「看不见但能点到」的窄带。
5. **是否补「等待回答」态？** 官方 `pendingInteractions` 目前只有 `approval` 域，
   提问等待需另接 `dsh-client-ui-user-questions`，属新增通道而非改映射。
6. **`pet.json` 是否升 v2**（中心比例 + 屏幕名）？会动持久化 schema，需 v1 迁移与损坏回退。
7. **是否引入轻量「设置准入线」**（R10）？M3/M4 预计新增若干开关，先立规矩成本低。
8. **是否先跑一次「通道死亡」实机探针**，确认深挖 A 推测的 1.5–3s `waiting` 误报窗口
   （跑完即删，符合项目纪律）？
9. **第三批（R11–R13、R8）怎么排**？建议：R13 拖动合帧 + R8 省电可近期顺手做；
   R11 变换管线 + R12 甩出物理作为一个小批次（「玩法与物理」），与 R15①（零素材的
   `runRight/runLeft`、`r7` 修正）并行。
10. **P0 三项是否立项、按什么顺序**？建议 **P0-3（降损，最便宜且不依赖根因）→ P0-1（进程内取证）
    → P0-2（外部兜底，需提权部署并与 exe 一起核对）**。三者都不属于桌宠功能，建议单列条目跟踪。

---

## 7. 与既有文档的映射

| 本文章节 | 落到既有文档的位置 |
|---|---|
| §2.1 / R5 / R6 | `pet-v3-roadmap.md` M3（快捷审查与提权）——补充「关联键幂等」「resolved 精确移除」「不自动决策」三条硬约束 |
| §2.1 / R0 | `pet-v3-roadmap.md` M2.3（会话口径）——**由「只跟当前选中会话」改为「跨会话聚合待审批」**，与 M3 的价值前提绑定 |
| §2.2 / R4 | `pet-v3-roadmap.md` M3 前置（新增「M3.0 提醒队列」） |
| §2.5 / R3 / R14 | `pet-v3-roadmap.md` M4.1（可见性判据、peek 参数口径、pause/resume 平移） |
| §2.8 / R11–R13 / R15 | `pet-v3-roadmap.md` M5（**新增「M5 前置：绘制层变换管线」**，并把「补单帧」排在「新动作素材」之前） |
| §2.3 / R1 / R2 | `ARCHITECTURE.md` §2 关键设计决策（新增两条窗口层决策：逐像素穿透、不夺前台） |
| §2.7 / P0-1–P0-3 | `TODO.md` P0（「偶发全黑无响应」的取证能力与降损三件套） |
| §2.6 / R9 / R10 | `TODO.md` P3（工程） |
| 完成落地后 | `README.md`「Q 版桌宠」段 + `design/CHANGELOG.md` 对应条目 |

---

## 附录 · 证据索引（本次核对的一手文件）

| 主题 | 文件 | 关键位置 |
|---|---|---|
| 审批/提问事件区分与降级 | `integrations/dsh-pet-bridge/index.js` | `:1151-1210`（mux 帧）、`:1263-1350`（去重键）、`:1541-1556`（`approval/asked` 不得升级） |
| 阻塞交互锁存 + 120s 兜底 | `pet/dsh_state.py` | `:56-59`、`:173-190`、`:257-315`、`:416-427` |
| 提醒队列 | `pet/window_alerts.py` | `:18-28`、`:68-160`、`:163-189`、`:215-247` |
| 逐像素穿透 | `pet/platform_win.py`、`pet/window.py` | `platform_win.py:49-120`；`window.py:12, 2038-2047, 2159-2220, 2380-2385` |
| 不夺前台 | `pet/platform_win.py` | `:32-35`、`:60-76` |
| 边缘探头参数 | `pet/edge_probe.py` | `:19-39`、`:401-407` |
| 位置与可见性 | `pet/window_placement.py` | `:183-200`、`:203-244`、`:247-288` |
| 素材许可 | `THIRD_PARTY_NOTICES.md` | §1（音效 MIT）、§2（**角色素材非商用**） |
| 工程门禁 | `docs/SETTINGS-CHANGE-GATES.md`、`AGENTS.md`、`docs/RELEASE-v4.2.0.md` | 全文 / 「CI cost discipline」/ 「流畅度与性能」 |
| 状态机与重复检测 | `docs/PET-STATE-MACHINE-AND-REPETITION-2026-09-02.md`、`docs/DSH-BRIDGE-PET-EVENT-CONTRACT-2026-09-02.md` | 全文 |

**会话内深挖报告**（临时档案，位于 `_refs/pet-analysis/`，不入库、可随时删除）：
- `A-dsh-link.md`（DSH 联动与审批链路，316 行：链路全景 + 18 项逐条对照 + 三条建议 + 证据索引）
- `B-interaction.md`（交互玩法与体验特性，482 行：24 项特性表 + 11 项机制细节 + 优先 5 项）
- `C-perf-governance.md`（性能/内存/工程治理与 P0 建议，413 行：25 项对照 + P0 三条可执行机制）

