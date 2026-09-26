# @miasaki/dsh-ssh

DSH（DeepSeek Harness）web SSH 插件线：在**会话头第一行的视图切换胶囊**（与「对话 / 会话布」同一个胶囊、第三段「SSH」）集成入口，页面内交互式连接云服务器。

- 全新自研（不 fork 上游），技术栈与 canvas / sidebar 同构；
- 与 canvas、sidebar **零代码耦合**，仅共享 `dsh-miasaki-shared-docs/`；
- 红线沿用 canvas：不改系统提示 / 模型请求 / 工具 schema；插件不直接调模型。

## 状态

**M1 代码完成**（2026-09-09 立项）：存储层、运行时、host 路由与前端页面已完成并通过单测；已 link 安装到 DSH web profile，待重启 host 后在浏览器验证真实连接。SPIKE S2 / S4 / S5 已实测通过。**2026-09-10 按用户反馈调整入口位置**：从官方 tab 栏（第二行，排在「会话用量」之后）迁到会话头第一行，与「对话 / 会话布」**合成为同一个胶囊**（三段：对话 \| 会话布 \| SSH）；并在**画布页面内部**那组「对话 / 会话布」旁也给出一个 SSH 按钮（走画布的外部视图槽）。

**2026-09-12 U0 可靠性闭环完成**（[工作区优化规划](design/2026-09-12-ssh-workspace-plan.md) §9 首阶段，按「先通过故障注入测试」门槛验收）：

- **二进制输出修复**：WS `binaryType='arraybuffer'`，二进制帧真正落进 xterm（此前 `event.data` 是 Blob，`new Uint8Array(Blob)` 得到空数组 ⇒ **终端无输出**）；
- **查看器实例化**（新模块 `session.js`）：一个查看器独占一个 xterm + 一个 WS，整体可销毁，切换主机 / 重建 iframe 绝不跨代串写、不泄漏监听；
- **恢复 attach**：已连接 / 连接中 / 待指纹主机的主动作是「打开终端」，只 attach、不发第二个 connect（此前按钮被禁用 ⇒ iframe 重建后连接还在却进不去）；
- **生命周期契约**：viewer WS 短断有界重附着（4 次、线性退避）；SSH 自身关闭 / 报错则不重附着；输入与尺寸改走 **viewer 绑定路由**（`ws.sshRc` 实例绑定），被替换代次的僵尸 viewer 会被拒绝（`STALE_VIEWER`）；
- **指纹闭环**：确认窗口与 ssh2 握手**同一套 60s 时间预算**；确认 token 与连接实例 generation 绑定（旧确认不影响新连接）；信任记录**保存失败即拒绝连接**（不再吞错）；
- **凭据与表单**：私钥口令在连接时临时输入（后端本就支持）；秘密对话框关闭即清空输入；
- **尺寸与健壮性**：attach 初始尺寸送真实 PTY、`ResizeObserver` 观察容器 + rAF 合帧、resize 限界（2–1000 × 2–500）、WS 帧上限 256KB、慢 viewer 背压淘汰（`bufferedAmount > 8MB` 断开）。

**2026-09-12 U1 统一工作区完成**（规划 §3/§4/§6/§7 落地；界面与功能按概念稿 [`preview/2026-09-12-ssh-workspace-concept.html`](design/preview/2026-09-12-ssh-workspace-concept.html) 实施）：

- **双栏工作区**：可收起主机导航（232px，208–288 语义随容器收窄）+ 多主机终端标签 + 单条状态栏；未选主机有空态（最近连接 / 新建主机），未连接主机有摘要页（连接 / 编辑入口）；
- **主机导航**：名称 / `username@host:port` 联合搜索、分组归档、收藏（星标 + 组内置顶）、存活状态点；**右键与工具区「更多」菜单同源**（打开终端 / 编辑 / 收藏 / 复制地址 / 信任记录 / 断开 / 删除）；
- **编辑器悬浮窗**：560px 居中卡片（2026-09-26 由右侧 412px 抽屉改造，见下文「实机反馈修复」），字段校验（用户名必填、**不再默认 root**）、认证方式渐进显示私钥路径、活跃主机编辑提示「仅影响下一次连接」、服务端错误内联展示，[取消 / 保存 / 保存并连接]；
- **三主题桥接**：client.js 读取宿主**最终计算样式**（body 优先，白名单令牌）→ 同源 postMessage + 页面级注册表 `__DSH_SSH_THEME__`（iframe 首帧直读，不闪兜底色）→ `--ssh-*` 语义变量 + xterm 主题（背景 / 前景 / 光标 / 选区 / ANSI 16 色）；半透明宿主色合成到实体底再进终端；原生明暗兜底；主题切换不重建 SSH；
- **终端功能**：多主机标签（同主机只 attach；关闭查看 ≠ 断开，断开需确认）、Ctrl+Shift+C/V 复制粘贴、缓冲区原生查找（**零新依赖**——addon-search 对 xterm 6 只有 beta 版，未核验不引入）、字号 12–20px、本地清屏、专注模式、多行 / 含控制字符粘贴先预览确认；
- **响应式**：容器查询断点 960 / 720 / 480（依据 SSH 容器宽度而非窗口宽度），窄屏导航改模态抽屉（焦点陷阱 + Esc 归还焦点）。

**待实机验证**（U0+U1+A0+D2–D4+U2 合并验收，见 [回归矩阵 §3.6](../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)）：**重启 `dsh web`**（`index.js` 的 `cachedAsset` 对静态资源做进程内一次性缓存，浏览器强刷不够）后按清单逐项过。**U2 已于 2026-09-16 跑过一轮完整实机验收并修复 4 处回归（见下文「U2 实机验收」段），实机复验同样待重启后进行**。U2.2（SFTP）留待真实主机补验后开工；**A1（工具面）已于 2026-09-26 在本机真协议 sshd（真 `ssh2.Server`）上完成实机验收**——「三工具进模型工具面 / L0 免审批直通 / L1 审批双向（允许则执行、拒绝则远端零记录）」三条判据均有双侧证据，过程中逮到并修复 **6 处真缺陷**（`output` 缺失导致注册被官方全部拒收、`ssh_hosts` 不带 `id`、审批入参形状不符契约、隐式建连不等就绪、注册时点早于服务就绪、审计不落盘），见 [CHANGELOG](design/CHANGELOG.md) 顶部「A1 实机验收」节；U3（跳板 / 转发）已实施、实机待验。

**2026-09-14 A0 上下文桥已实施**（[Agent 化规划](design/2026-09-14-ssh-agent-driven-plan.md) §8.2/§17，用户拍板四项决策后的首个交付）：

- **入口**：工具区「送往对话」按钮 + **终端右键菜单**（同一份菜单，沿用主机菜单的「同源」约定），三个意图——送出选中内容 / 送出最近 40 行 / 让 Agent 看这个错误；
- **产出**：带来源首行的文本 `[SSH web-01 · ops@host:22]` + 正文（错误意图在首行追加引导语），写进剪贴板由**人**粘贴到对话；
- **边界**：全程**只读终端 + 写剪贴板**——不向远端发送任何字节、不自动发送、不碰 SSH 连接；空正文不产出只有主机名的空消息；
- **通道经核验只能是剪贴板**：SSH iframe ↔ 对话页之间**不存在**官方「插入文本」API（`input.trigger` 槽实测不存在，`dsh-client-ui-reference` 只服务 `@` 补全的固定领域）；
- 单测 60 → **63 例**，`verify-all ssh` **12/12 PASS**。

**2026-09-15 D2 实机验收：真实 GUI 24 项门槛全过**（[全屏浮层方案 §16](design/2026-09-14-ssh-fullscreen-overlay-plan.md)，驱动与证据归档 `_refs/scripts-archive/ssh-d2-accept/`）：

- **通道**：真浏览器 × **真实 DSH GUI**（真宿主 + 真插件 + 真会话 + 真桌面壳注入）＋真实鼠标/键盘事件（走 hit-test，验"用户可达"）＋本地假 sshd（真 SSH 协议）远端端点；与 §15 探针（桩宿主页）的区别正在于此。
- **形态门槛**：两条入口真实点击开浮层；浮层全屏覆盖（五点 hit-test 全落浮层）；顶栏「对话｜会话布｜SSH」且**宿主文档内零顶栏**；顶栏只放切换按钮（查找/字号/专注/送往对话 留在工具区）；`Esc` 不关闭；**Shift+Tab 能从工作区反向走到「对话」**且 focus-visible 清晰；点「对话」退出并**把焦点还给入口按钮**。
- **互斥与生命周期**：SSH ↔ 画布**双向**互斥（含画布内外部视图槽按钮）；开关记忆符合 `sessionStorage` 语义（开着刷新自动恢复 / 关掉刷新停在对话）；**真协议端点零损失**——关闭期间远端零 resize 帧、重开 iframe 未重载、30 次开关零帧且 SSH 侧 shell 恒为 1、真实键盘输入送达远端。
- **三主题**（D2 门槛本尊）：pure / 刻刻帝 / 狂狂帝 逐一切换，顶栏均消费壳窗控 reserve（`padding-right = 14 + 150`），与宿主观感一致；壳内入口与窗控同排不叠压。
- **两条移交发现已修复并复验（2026-09-15，用户定向「两条一起修」）**：**D-1**「保存并连接」从不发起连接（U1 遗留）—— 意图标记改走闭包变量（原写法挂在按钮 `event` 上，解析到全局 `window.event`，`dispatchEvent` 后读不到），复验中凭据框被正常拉起；**D-2** 指纹确认后状态栏/横幅不追平（U0 遗留）—— `session.js` 现在把每一帧带 `state` 的宿主帧统一转发给 `onFrame`，复验中状态栏「已连接」、横幅 `display:none`。
- **D2 语义边界已按「诚实降级」收口**：hero 态（无会话头 ⇒ canvas 无胶囊可委托）下，宿主随 chrome 消息下发 `canvasAvailable=false`，浮层顶栏只渲染「对话｜SSH」两段，不留死按钮；进入会话后三段自动回归（可逆）。
- **结论**：单测 72 → **79 例**、`verify-all ssh` **12/12**；重启 host 后重跑实机验收 → **`allPassed=true`（24 项全 PASS）**。注：`index.js` 的 `cachedAsset` 是进程内一次性缓存 ⇒ 改 `app.js`/`session.js`/`client.js` **必须重启 `dsh web`**（浏览器强刷不够）。

**2026-09-15 D3 实机验收：功能门槛全过，1 项清理残留**（[全屏浮层方案 §18](design/2026-09-14-ssh-fullscreen-overlay-plan.md)，驱动归档 `_refs/scripts-archive/ssh-d3-accept/`）：

- **四档宽度按视口语义落位**（D3 门槛本尊）：1280 → rail 232px（全宽档）/ **960 → rail 208px（恰好在断点值上落紧凑档**，正是本轮修的"等于断点值错位一档"）/ 720 与 480 → 抽屉（rail 隐藏 + 关闭钮在场）；**四档零横向溢出**、顶栏四档稳定。
- **三主题 × 1280/480**：零溢出、顶栏段数稳定、`padding-right: 164px`（窗控 reserve 消费）。
- **A0 文案**：真实点「送往对话 → 送出最近 40 行」→ 状态栏「已复制 99 字符——**点左上「对话」退出后粘贴（Ctrl+V）即可**」；剪贴板实读首行 `[SSH <标签> · <用户>@<主机>:<端口>]`。
- **清理生效**：官方 tab 栏**无 SSH tab**（回退视图已删）；会话态下官方 `[data-width-handle]` 正常显示（本线未再隐藏）；`.dsh-ssh-view` / 临时退出条零残留。
- **D3-F1 已闭环（用户定向「现在就删」）**：`client.js` 里那条 `div[data-phase]:has(...) [data-width-handle]` 死规则（回退视图已删 ⇒ `:has()` 永不命中）已删除；两条把它锁成「保留」的旧断言同步改写为「零残留 / 零触碰」，并新增一条回归断言（注入样式表零 `width-handle` + 相邻规则链完整性：合体胶囊 / 浮层 / `is-closed` 隐藏策略 / launcher 四条仍在）。**无需为它重启 host**（不参与运行时行为，下次重启自然生效）。
- 当前单测 **82 例**（app 13 + client 25 + http 3 + runtime 14 + session 19 + store 8）、`verify-all ssh` **12/12**。

**2026-09-15 D4 实机验收（= D3 三项尾项清理）：6 项门槛全 PASS**（[全屏浮层方案 §20](design/2026-09-14-ssh-fullscreen-overlay-plan.md)，驱动归档 `_refs/scripts-archive/ssh-d4-accept/`）：

- **尾项① `renderBanner` 隐藏即清空**（运行态取证）：可见态 `hidden:false / childCount:3`（图标+文案+「核对指纹」按钮）→ **连接完成后 `hidden:true / display:none / childCount:0`**（旧实现只设 `hidden`，3 个节点会留在 DOM 含闭包引用）；断开后横幅再现且 `childCount:4` ⇒ 清空没把功能弄坏。
- **尾项③ 过渡区间落位**：1280 → rail 232 / 860 → rail 208（紧凑档）/ 600 → 抽屉 / **500 → 抽屉且 `.tools .optional` 可见（480 档未触发）** / 480 → 抽屉且 `.tools .optional` 隐藏（480 档命中）；五档**零横向溢出**。
- **尾项② 运行态**：30 次开关浮层 → 零 JS 异常、iframe 未重载、远端零 resize 帧。静态侧：`observe(header, { childList, subtree })`（`attributes`/`attributeFilter` 已移除）、`aria-selected` 仅剩说明注释。
- **附带复核**：注入样式零 `width-handle`（D3-F1 删除已实机生效）。
- **例数校正（第二次同类笔误）**：D4 实施记录写的「单测 65/65」是沿用旧基线，实测 **82 例**、`verify-all ssh` **12/12** —— 已在 CHANGELOG 与本文件就地校正。

**2026-09-15 实机反馈修复：抽屉标题栏的 × 与桌面壳窗控叠在一起**（本线首个「壳窗控让位」缺口，用户截图报告）：

- **现象与取证**：右上角出现**两个 ✕** —— 桌面壳窗控组的关闭键与「新建主机」抽屉标题栏的关闭键叠在同一块像素上（截图逐像素量测：窗控组中心 y≈23，抽屉 `.icon-btn` 中心 y≈32、距右缘 35px），抽屉那颗被窗控压住点不到。根因：浮层顶栏早就消费 `--ssh-chrome-reserve`，**抽屉从来没有让位**。
- **修法（垂直让位）**：`app.js` 用**父视口坐标**下的窗控组矩形与 `window.frameElement` 矩形相减，算出「本 iframe 内需要让开的顶部高度」（窗控下沿 − iframe 顶 + 8px 呼吸）写进 `--ssh-chrome-clearance`；`.sheet` 消费它（`margin-top` + `height: calc(100% − …)`）整体下移到窗控之下。iframe 本就在窗控下方时（会话视图里 iframe 从会话头下开始）差值为负 → 归零，两种挂载形态一套算法、无分支。窗口尺寸变化用 rAF 合并的 resize 重测。
- **为何不把 × 往左推**：会话头第一行的入口胶囊（窄窗口紧凑态 `>_`）同在这一行，往左会让位撞上它；窄窗口里还会把 × 推到抽屉中间、标题栏右侧空出一大片。垂直让位一次避开两者。
- **兜底**：量不到窗控组但宿主下发了 `reserve` 时，退回水平让位（`--ssh-chrome-avoid-right` → `.sheet-head` 的 `padding-right`）；浏览器里两者皆为 0，抽屉照旧顶格满高。
- **验证**：单测 82 → **85 例**（新增让位量纯函数 / 量测与兜底分支 / 样式契约三例）；另有一次性探针（headless Chrome × 桌面壳几何复刻）出前后对照图 —— 修复前两个 ✕ 叠在一起，修复后抽屉下移 45px、× 与窗控完全分离（探针用完即删）。
- **重启生效**：改的是 `app.js` 与 `styles.css` ⇒ 需重启 `dsh web`（`index.js` 的 `cachedAsset` 是进程内缓存，浏览器强刷不够）。
- **形态变更（2026-09-26）**：贴边抽屉形态已整体退役，改为居中悬浮窗；本条的顶部让位量 `--ssh-chrome-clearance` 保留、消费点改为遮罩层的内边距，水平兜底 `--ssh-chrome-avoid-right` 退役（见下条）。

**2026-09-26 实机反馈修复：弹层从右侧抽屉改为居中悬浮窗（右下角主题球遮挡确认键）**（用户截图报告）：

- **现象与取证**：桌面壳右下角的主题球（`#miasaki-switcher .ms-btn`，fixed `right/bottom 16px` 的 46px 圆 + 6px ping 光晕，z-index 99990，压在 `/ssh/` iframe 之上）盖住贴边抽屉右下角的确认键 —— 截图里「连接密码 · NO.1」弹窗的确认键正好在球底下，点不到。
- **修法（形态改造，不是再让位）**：`.sheet` 从「右缘滑出的全高抽屉」改为**居中悬浮窗**：遮罩口径照官方设置面板（`rgba(0,0,0,.24)` + `blur(2px)`，深色主题 `rgba(0,0,0,.5)`）、卡片 `min(560px, 100% − 2×边距)`、24px 圆角、发丝描边 + 两层淡投影、`max-height: calc(100% − 64px)`，结构为标题栏 + 可滚动内容 + 底部右侧按钮区。**所有弹层场景**（新建/编辑主机、连接密码、私钥口令、指纹确认 TOFU、信任记录、断开确认、粘贴确认）一并换形态，不留两套。
- **两条让位口径（父视口实测写入，量不到归零）**：① 顶部 `--ssh-chrome-clearance` 改挂在遮罩层的 `padding-top`，卡片（含右上角 ×）整体落到壳窗控带之下；② 新增 `--ssh-shell-fab-safe-right` = 主题球左缘距本 iframe 右缘 + 6px 光晕 + 8px 呼吸，卡片宽度取 `min(560px, 100% − 2 × max(32px, 安全线))` —— 宽窗口零影响，窄窗口自动缩窄以避开球。同时退役 `--ssh-chrome-avoid-right`（贴边形态的水平兜底）与 `openSheet` 的死参数 `wide`。
- **实测（真产物 × headless Edge，探针归档 `_refs/scripts-archive/ssh-modal-verify/`）**：宿主页加载**真实壳注入产物** `dsh-miasaki-desktop/src-tauri/injected/theme-init.js` 自建窗控组与主题球（结果里 `shell=real`），iframe 直供**真实** `app.js` / `styles.css`。五场景全过：1540×1042 新建主机、640×820 窄窗、**480×640 极窄**（卡片与球的垂直投影相交 34px、水平 0 —— 安全线正是为此）、1540×1042「连接密码」、无壳 chrome 的浏览器形态（`fabSafeRight=0px` / `clearance=0px`，边距退回 32px 基数）。「保存并连接」「确认」与球的**重叠面积全为 0**。
- **测试**：app 例数 16 → **17**（新增 `computeFabSafeRight` 纯函数例；`syncChromeClearance` 与样式契约两例改写为新口径），全线 **127 例**、`verify-all ssh` **12/12 PASS**。
- **重启生效**：改的是 `app.js` 与 `styles.css` ⇒ 需重启 `dsh web`（`index.js` 的 `cachedAsset` 是进程内缓存，浏览器强刷不够）。

**2026-09-26 实机反馈修复：主机栏里连端口一起填 ⇒ `getaddrinfo ENOTFOUND`**（用户截图报告「报错了」）：

- **现象**：连接失败，横幅 `getaddrinfo ENOTFOUND 8.138.243.30:25112`。取证在截图里：标题行地址是 `wwq7tmzr@8.138.243.30:25112:22`（页面格式是 `${username}@${host}:${port}`）⇒ **host 字段本身就是 `8.138.243.30:25112`**、端口栏还是默认 22。
- **根因**：主机栏粘贴了 `host:port` 写法，`requireHost()` 只拒空白/斜杠、放行 ⇒ ssh2 把整串当主机名交给 DNS。
- **修法（三层，规则只有一处）**：
  1. **`splitHostPort()`**（`lib/store.js`）：拆 `example.com:2222` / `[::1]:2222`；**裸 IPv6 不拆**（多个冒号是地址语法）；端口照样过 1–65535 校验（`10.0.0.1:99999` 报错而不是静默连错）。
  2. **写入即拆分**：`normalizeConnection()` 用它，且**内嵌端口优先于端口栏**（粘贴进来的地址比默认 22 更具体）⇒ 以后直接粘贴 `8.138.243.30:25112` 就能存对。
  3. **历史记录在连接时修正**：`runtime.connect()` 发现 host 带端口就拆分、回写磁盘、并把改动如实回报（`repaired`）→ `index.js` 透传 → 前端 `setStatusNote` 说明「主机地址里带着端口 25112 —— 已移到「端口」栏」，同时刷新列表让标题栏地址跟着更新。**不静默改数据**。
  4. 报错文案：`classifyError` 的 `HOST_NOT_FOUND` 前面补一句能照做的指引（原始消息原样保留，排障要看它）。
- **立即解法（不用等重启）**：打开该主机的「编辑主机」，把主机改成 `8.138.243.30`、端口改成 `25112`，保存即可连；重启后即使不改，点「重新连接」也会自动修正。
- **测试**：store +2（`splitHostPort` 各形态、`normalizeConnection` 优先级与非法端口）、runtime +3（ENOTFOUND 文案、历史记录连接时修正并回写、干净记录不多写盘）、http +2（**真实 `index.js` 端到端**：POST 写入即拆分；种子历史记录 connect 响应带 `repaired` 且磁盘已修正）、app +1（页面必须提示并刷新列表）⇒ 全线 **135 例**、`verify-all ssh` **12/12 PASS**。
- **同一轮实机反馈的第二跳（地址修对后报 `Connection lost before handshake`）**：这不是本线缺陷 —— 链路探测（`_refs/scripts-archive/ssh-conn-probe/`，真实 `ssh2` 握手）显示 **TCP 38ms 建连成功、服务器 8 秒零字节、69ms 内 RST**：该端口上不是（或不对外提供）SSH 服务。`classifyError()` 为此新增 `HANDSHAKE_LOST` 码，把原句配上排查方向（「先确认这个端口是不是 SSH：云安全组放行、端口映射指向 sshd」），`ECONNRESET` 另立 `CONNECTION_RESET` 码；两者都保留原始消息。例数 135 → **136**。
- **第三跳（端口换 2005 后报 `connect ETIMEDOUT`）**：多端口 TCP 探测给出画像 —— **22 / 2005 / 8080 全部被丢包**（3.5s 无响应），**443 / 25112 可达**（TCP 通但沉默；25112 上一轮实测 69ms RST，不是 sshd）。即这台机器按**端口白名单**放行，sshd 实际端口不在放行集合里。`classifyError()` 的 `TIMEOUT` 分支同样补上排查方向（云安全组 / 防火墙是否放行该端口、服务是否在监听），原句保留。例数 136 → **137**。
- **第四跳（放行 22 后报 `All configured authentication methods failed`）—— 补上真实能力缺口**：新装 Ubuntu / Debian 与部分云镜像的 sshd 默认 `PasswordAuthentication no` + `KbdInteractiveAuthentication yes`，密码入口在 **keyboard-interactive**；而 ssh2 **只在 `tryKeyboard === true` 时才尝试该方法**（`ssh2/lib/client.js:843`）⇒ 本线此前对这类服务器「密码再对也认证失败」。现在 password 分支开 `tryKeyboard` 并用同一密码回填 prompt（密码仍只在内存、不落盘；服务端若用它做二次验证则自然不通过，不猜不绕过）。**真协议测试**：`ssh2.Server` 起只开 keyboard-interactive 的假 sshd（现场生成 RSA host key + 真实 session/pty/shell），走完 TOFU → 认证 → 开 shell → connected；**反向验证**：临时置 false 该用例立挂 ⇒ 测试确实锁得住。例数 137 → **138**。

**2026-09-26 新功能：连接诊断（档 B）** —— 把「连不上时该看什么」做进产品，不再靠命令行挖：

- **两个入口**：主机菜单（工具区 `⋯` 与终端右键同源）里的 **「连接诊断」**；编辑主机悬浮窗里的 **「测试连接」**（草稿也能测，不必先保存）。
- **三层事实 + 一句结论**：DNS（IP 字面量会明确标注「无需解析」）→ TCP + SSH banner 一次连接同时取 →（可选）服务端允许的认证方式。**结论由 host 半 `buildVerdict()` 给**（单一出处、可单测），页面只渲染与复制：`REACHABLE` / `NOT_SSH` / `TCP_TIMEOUT` / `TCP_REFUSED` / `TCP_RESET` / `TCP_UNREACHABLE` / `DNS_FAILED` / `PASSWORD_DISABLED`，每条带可照做的提示。
- **两条默认值（2026-09-26 那次封 IP 的直接教训）**：① **公网出口 IP 默认不查**，点「查询公网出口 IP」才外呼第三方（ipinfo.io → ipify → ifconfig.me 逐个尝试），界面写明数据去向；② **认证方式默认不探测**，点了也只发协议自带的 **`none`** —— 不发送任何密码或密钥，也**不会被服务器记成一次失败登录**（fail2ban 的 sshd 过滤器不匹配 `none`）。
- **本机信息**（放行时要用）：出口 IP + 网卡地址 + 诊断环境（平台 / Node 版本）；**报告一键复制**（纯文本，可直接贴给同事或云厂商工单）。
- **实测**（真产物 × headless Edge，归档 `_refs/scripts-archive/ssh-modal-verify/`）：探针的 `/ssh/api/diagnose` 桩路由**直接调真实 `lib/diagnose.js`**，8 个场景全过 —— 其中诊断两景为「TCP 通但零字节 ⇒ NOT_SSH」与「真 ssh2 假 sshd + 认证方式探测 ⇒ REACHABLE + publickey/password」。
- **测试**：`test/diagnose.test.js` **11 例**（banner 解析 / socket 错误词汇 / DNS 字面量短路 / **真 socket** 三种形态 / **真 `ssh2.Server`** 验「只发 `none`、服务端看不到密码」/ 出口 IP 逐个回退 / verdict 全分支 / 端到端组装）+ http 路由端到端 **1 例** + 前端契约 **2 例** ⇒ 全线 **138 → 152 例**、`verify-all ssh` **12 → 14/14**。

**2026-09-26 修复：「只读：另一个窗口正在此终端输入」在未连接时常驻**（用户截图报告「一直都有」）：

- **根因两处**：① `renderWriteBar()` 写的是 `bar.hidden = isWriteOwner()` —— **没有会话时它也等于 false**，于是启动 / 断开 / 关标签后横幅都会被翻开；② `session.js` 的写权初始值就是 `'read'`，连接还没开 shell（写权未决）就被 UI 当成只读，而文案「另一个窗口正在此终端输入」当时并不成立。
- **修法：写权补成三态** `pending`（未决）/ `read`（明确只读）/ `write`（持有写权）—— `session.js` 初始 `pending` 并新增 `isReadOnly()`；`app.js` 只在「会话活着 + `isReadOnly() === true`」时显示只读条；`write.open`（写权空出）的提示同样收敛为「明确只读」，未决态不再误报「可以接管」。
- **连带（刻意）**：`ready` 帧带 `mode:'read'` 现在会触发一次 `onModeChange`（pending → read 是真实变化），旧实现被 `setMode` 去抖吃掉 —— 对应断言已按新语义改写。
- **测试 + 实测**：session 2 例改写 + app 契约 1 例 ⇒ 全线 **153 例**、`verify-all ssh` **14/14**；探针新增 `H-idle-write-bar-hidden`（未连接态量到 `hidden:true / display:none`），8 景全过。

**2026-09-26 对标 zcode 调研完成**（[zcode 对标调研与方案](design/2026-09-26-ssh-zcode-benchmark-plan.md)，用户定向「参考 zcode 官方仓库做」）：对象为智谱 [zai-org/ZCode](https://github.com/zai-org/ZCode)（v3.14.3，agent harness，其 SSH 子系统用于「把 agent runtime 部署到远程」，参考克隆 `_refs/zcode/`）。**双方独立踩中同一批 ssh2 坑**（tryKeyboard 不开则新装 Ubuntu/Debian 密码必失败——本线 2026-09-26 已修；短命令 exit 早于 stdout data；readyTimeout 20s 太短；client 无常驻 error 监听会炸 host）⇒ 互相印证。**我们更强项**：TOFU + known_hosts（zcode 产品代码零 host key 校验，保持不动）。**识别的差距与候选**：keepalive 15s×3、**SFTP→exec pipe 降级链**（网关/跳板把 exec 与 sftp 落到不同文件系统视图）、`~/.ssh/config` 别名导入（`ssh -G` 优先 + 自研解析回退）、连接向导「实时阶段日志 + 收起≠关闭」、远端能力 preflight、docker sshd + `ssh -L` 真隧道验证基建；跳板/端口转发（U3）zcode 无参考、需自研。产出 **P0×3 / P1×4 / P2×4 共 11 项候选 + 5 项待用户拍板决策（D1–D5）**，另有「明确不做」清单（agent-over-ssh 部署链、WSL/Docker backend 等，各附理由）。

**2026-09-26 P2 落地：U3 跳板/本地转发 + A1 `ssh_exec` 工具面**（[zcode 对标调研与方案](design/2026-09-26-ssh-zcode-benchmark-plan.md)，用户「p2开工」，实施记录见 [CHANGELOG](design/CHANGELOG.md)）：

- **U3 本地端口转发**：`lib/forward.js` 在 127.0.0.1 起真监听，每入连接经 `forwardOut`（direct-tcpip）送达远端视角地址；编辑器配置（上限 8 条）、连上即建、断开即撤、端口关闭即释放；EADDRINUSE/服务端拒绝逐连接上报不撤监听；
- **U3 跳板（D4=②）**：目标连接经跳板 runtime 的 forwardOut 通道作 `sock` 注入——凭据/TOFU/票据全复用；跳板从未连过或缺指纹 ⇒ `JUMP_UNAVAILABLE` 前置拒绝（TOFU 确认窗口无 UI 附着点）；password 跳板不隐式建连；
- **A1 工具面（D2 默认 off）**：`ssh_hosts` / `ssh_exec` / `ssh_session_read` 三工具；命令服务端分级 L0/L1/L2（命令头判 `rm -rf`、`docker rm -f` 不误伤；未识别保守 L1）；readonly 主机 L1/L2 连审批机会都不给；full 的 L1/L2 走 `userQuestions` 审批四态（unavailable 失败关闭）；key/agent 隐式建连、password 不；`exec.signal` 取消、双预算截断、cwd POSIX 引用前置；审计台账（内存环 200 条 + **追加落盘 `dataDir/exec-audit.jsonl`**，重启可查）+「Agent 执行记录」浮层；
- **P2-3 双栈边界**：exec 假定 `/bin/sh`（远端 Windows 给可照做提示）；SFTP 路径按 POSIX 归一；
- **P2-4 真协议探针**（归档 `_refs/scripts-archive/ssh-p2-probes/`）**8/8 PASS**：真 direct-tcpip 字节往返 + **经跳板 sock 注入完成真协议握手** + 真 exec（motd 跳过）；
- 单测 **225 → 276 例**、`verify-all ssh` **20/20 → 31/31**；**A1 工具面已于 2026-09-26 单独完成实机验收**（本机真协议 sshd，工具面可见 / L0 直通 / L1 审批双向，见 [CHANGELOG](design/CHANGELOG.md) 顶部；基座 `_refs/scripts-archive/ssh-a1-live/`）；真跳板建连与本地转发实机仍待验。

**2026-09-26 对标方案落地：P0 三件套 + U2.2 SFTP + P1-1 ssh config 导入**（[zcode 对标调研与方案](design/2026-09-26-ssh-zcode-benchmark-plan.md)，用户拍板「按建议开工」D1②/D5②/D2①，实施记录见 [CHANGELOG](design/CHANGELOG.md)）：

- **P0-1 连接健壮性**：keepalive 15s×3（NAT/防火墙静默断开不再挂死，真协议探针 6/6 PASS 归档 `_refs/scripts-archive/ssh-keepalive-probe/`：60043ms 报 `Keepalive timeout` 归 `TIMEOUT`）；连接配置提取为纯函数 `buildConnectConfig()`；`classifyError()` 新增 ssh2 `level` 分级与私钥口令两码（`KEY_PASSPHRASE_MISSING/INVALID`）；
- **P0-3 exec 前置**（`lib/exec.js`）：POSIX `/bin/sh -c` 包装、close 收尾 + exit 码优先 + 50ms 排空、banner/motd 跳过 —— A1 `ssh_exec` 地基；
- **U2.2 SFTP**（`lib/paths.js` / `lib/sftp.js` + 8 个 REST 端点 + `sftp-ui.js` 右抽屉）：列目录 / 流式下载 / 上传队列（并发 2、浏览器侧进度、可取消）/ 新建·重命名·删除；**zcode 降级链**——目录在 sftp 视图不存在或会话打不开 ⇒ 零字节消耗直降 `mkdir -p && cat >`，mid-stream 失败记 `execOnlyUpload` 下次直走命令通道；票据族 10 分钟可续期；路径穿越/NUL/超长拒于 `lib/paths.js` 一处；**偏离登记**：单次 HTTP 源流不可回放 ⇒ mid-stream 不就地降级；
- **P1-1 ssh config 导入**（`lib/sshConfig.js`）：`ssh -G` 优先 + 自研解析回退，编辑器下拉一键回填；只导直连 alias（含 ProxyJump 的禁选不静默丢）；privateKeyPath 只信 config 显式 `IdentityFile`；
- 单测 **153 → 225 例**、`verify-all ssh` **14/14 → 26/26**（新模块同批进静态语法闸门）；**重启 `dsh web` 后待实机验收**（真实主机 SFTP 往返 / 降级实机路径 / 导入回填）。

**2026-09-16 U2 主体落地：多 shell / 工作区记忆 / 精确恢复**（[U2 规划](design/2026-09-15-ssh-u2-plan.md) §6 顺序 U2.1 → U2.3 → U2.4；交接文档 [实施验收包](design/2026-09-16-ssh-u2-implementation-report.md)）：

- **U2.1 身份分层 + 多 shell**：`lib/runtime.js` 重写为三层身份（`connId → runtimeId → shellId`）——连接按 `runtimeId` 键控 + `byProfile` 映射，`ShellChannel` 承载独立 stream / 尺寸 / 回放环 / viewer 集合 / 写入所有权；**shell 结束 ≠ 连接结束**，同 runtime 上限 **8** 个 shell。**安全前置**：WS attach 帧必须持 `POST /ssh/api/attach` 签发的**一次性 30s 票据**（消费即废，重放 / 过期 / teardown 全拒 `TICKET_INVALID`），落实规划 §8「不得把运行连接 ID 当授权证明」。**写入所有权**：单写多读 + 显式接管（`shell.takeover`，原 owner 即时转只读收 `write.revoked`），非 owner 的 input / resize 一律拒收 ⇒ 堵死「最后一个 resize 获胜」。**协议**：WS 全帧 `v:2`，旧帧拒收并提示刷新（`VERSION_MISMATCH`，不做双栈）；标签栏「+」新建 shell，关闭对话框区分「仅关闭查看 / 关闭此 shell / 断开整个连接」。
- **U2.3 工作区记忆**：拆两张据 —— 偏好（字号 / rail 折叠 / 专注）→ `localStorage['dsh-ssh:prefs']` **v2**（读取兼容 v1）；工作区快照（标签集合 + 激活项 + 抽屉状态）→ `sessionStorage['dsh-ssh:workspace']` **v1**，统一 `sessionStore` 封装全 try / catch。恢复语义 = **只恢复标签形状，绝不自动连接 / 输凭据**——刷新后仅当 host 侧连接仍存活才重挂 attach，失效 connId 静默丢弃 + 提示，快照损坏一律回默认不白屏。**附带修掉一处真实事故**：`PREFS_KEY` 与 `LAST_TAB_KEY` 曾同为掩码字面量 `'***'`（上一会话脱敏写入事故）导致两据互相覆盖，本轮重写为真实键名。
- **U2.4 精确恢复**：官方 `@xterm/addon-serialize` **0.14.0 精确锁定**（探针 B 已证兼容 xterm 6.0.0，故不做自研快照）；session.js 输出空闲 1.5s 采集序列化快照上报 host（每 shell 内存态封顶 128KiB、scrollback 500 行，**不落盘**）；附着恢复三路判定 = 快照帧优先（reset 后重放）/ 回放兜底（刷新后）/ 重附着丢弃整段回放（防翻倍）；addon 缺失即静默降级为回放恢复（删包即单独退出 U2.4，不动 U2.1 / U2.3）。
- **验证**：单测 **85 → 110 例**（runtime 22 / session 32 / http 7 重写适配 v2 契约，app 16 / client 25 / store 8 无回归），`verify-all ssh` **12/12**；端到端探针（真 sshd × 本线 `SshRuntime`）**9/9**——4 shell 隔离 / 尺寸按 channel 精确对应 / 输出隔离 / shell 退出其余存活；**回滚演练实际执行**（基线恢复 85/85 绿 → U2 还原 110/110 绿）。
- **待实机验收**：vim / top 刷新后恢复逐行一致、双窗口写权互斥、8 shell RSS、三主题回归。
- **偏离登记**：规划决策 5 的「`app.js` 纯搬迁拆分」本轮未执行（改造以补丁叠加，避免搬迁与逻辑混在一个 diff，`app.js` 已 1731 行），列入 U2.2 前置工单。

**2026-09-16 U2 实机验收：自动化全绿，实机首连被两处阻断级回归挡住 —— 4 处缺陷已定位并修复，待重启复验**（[验收报告](design/2026-09-16-ssh-u2-acceptance-report.md)；驱动与结果归档 `_refs/scripts-archive/ssh-u2-accept/`）：

- **发现（2 阻断 / 1 高危 / 1 中危）**：① 等待指纹阶段 viewer 依 U0 契约已 attach，而那时**没有 shell** ⇒ 前端无条件发出的 input/resize 被判 `STALE_SHELL`，该错误横幅**覆盖了唯一带「核对指纹」按钮的 waiting-fingerprint 分支** ⇒ **新主机彻底连不上**（最小复现：45s 内确认入口从未出现，远端握手停在 hostVerifier）；② `onReady` 广播的 `ready` **不带 `shellId`、也不做服务端补绑** ⇒ 指纹确认通过后终端仍拿不到 shell 绑定；③ **同主机多 shell 输入串台**（`openHost` 按 `connId` 找标签永远命中第一个 + 前端无条件取「第一个 live shell」，实测三个标签的输入全部落在 ch-1 —— 正是方案 §8 风险表第一条）；④ 刷新恢复后标签错乱 / 点标签空白（③ 的连锁）。
- **修复**：`session.js` 未绑定 shell 时**不发** input/resize + 绑定后 `syncSize()` 补发真实尺寸 + 票据 shell 清单按 `shellSeq` 精确匹配；`lib/runtime.js` 的 `onReady` 对未绑定 viewer 补 `bindShell()` 并逐发带 `shellId/mode` 的 `ready`；`app.js` 的 `openHost` 支持 `tabIndex` 精确定位（`openHostAt` / 关闭接续 / 挂载恢复三处同步）；`index.js` 的 `/ssh/api/attach` 返回补 `shellSeq`。单测 110 → **113 例**（新增 3 条回归断言），`verify-all ssh` **12/12**。
- **已 PASS 的实机项**：双窗口单写多读（第二窗口只读条、原 owner 保持写权、零新建 TCP）与显式接管（原 owner 即时转只读、新 owner 输入送达远端）；3 个 shell 建立（host × sshd × 标签三方对齐）；刷新后标签数量恢复且 `tcp-connect`/`shell` 事件**零增长**（零自动连接）；损坏快照不白屏；旧帧收 `VERSION_MISMATCH`。
- **U2.4 本轮实际未上线**（非代码缺陷）：`@xterm/addon-serialize` 在宿主启动**之后**才安装，而 `hasSerializeAddon` 只在 apply 时判定一次 ⇒ 运行态回 79 字节占位脚本、前端静默降级为回放恢复；重启即解。
- **下一步（重启 `dsh web` 后）**：`node run-u2-accept.mjs`（多 shell 隔离 / 双窗口写权 / 关闭语义 / 刷新恢复 / 8 shell 上限 + host RSS / 旧帧）、`node run-u2-tui.mjs`（U2.4：TUI 画面刷新后逐行 + 光标行一致 ×3）、三主题回归。

设计要点速览（完整版见 [设计文档](design/2026-09-09-ssh-design.md)）：

| 维度 | 决策 |
|---|---|
| 入口 | ① 会话头第一行的三段胶囊：注册官方 `conversation.session.header.actions` 槽（id `ssh-view-switch`，order 26），与 canvas 的「对话 / 会话布」**合成为同一个控件**（纯 CSS 覆盖，canvas 文件未改）；② **画布页面内部**那组「对话 / 会话布」旁的一个 SSH 按钮：走 canvas 提供的通用「外部视图槽」（页面级注册表 `window.__DSH_CANVAS_VIEW_ITEMS__` + `canvas:view` 广播，canvas 侧不认识 SSH）。页面本身由 `conversation.view`（id `ssh`，order 20）托管，该 tab 收起不再显示（2026-09-10 调整，见[设计文档 §5.5](design/2026-09-09-ssh-design.md)）；③ **主页右上角**的常驻入口：注册官方 `shell.overlay`（id `ssh-launcher`，order 40），补「hero 态没有会话头 ⇒ 没有胶囊入口」的缺口。**③ 是两维判据**——「当前停在主页（`[data-slot="main.conversation"]` 锚点存在）」**且**「**本线胶囊不在场**（`.dsh-ssh-switch` 不在 DOM 里）」：第一维是必需的（`shell.overlay` 是 root 级浮层、**每一屏都会渲染**，只判「会话空白」会让入口出现在设置页 / 轨迹页，2026-09-25 B1 修）；第二维把 launcher 与会话头胶囊做成**结构性互斥**（2026-09-25 B2 修 —— 旧判据推演官方 `useSessions` 的 `blank` 字段，与「会话头会不会渲染」**不等价**，会话窗口里会出现「胶囊 + 右上角」两个 SSH，详见 [CHANGELOG](design/CHANGELOG.md)）。**落点同排让位**（2026-09-26 B3 修，B4 补取数时机）：`right` 除桌面壳窗控口径（`--dsh-ssh-chrome-reserve + 16px`）外，还会实测 DSH 官方在这一行的 chrome（会话头 `[data-conversation-header-corner]` / 右栏 `[data-dockkit-strip-chrome]`，含紧邻兄弟按钮）并**退到其左侧 8px**——桌面壳用 `--ms-titlebar-reserve` 把官方控件顶到窗控左侧，正好压在 launcher 的默认落点上。**B4（用户第三次复报「还是会有问题，点击页面后可能恢复正常」）**用无头 Chromium + 复刻桌面壳标题栏逐帧量测 + 对照实验补齐了让位量的**取数时机**：① 官方右栏开合走 CSS transform 过渡，只在触发瞬间测一次会让过渡期**持续叠压 41px** ⇒ 触发后逐帧跟随到值稳定（含下限帧数，防「过渡前段值不变」误收手）；② 桌面壳侧栏线注入 `--ms-titlebar-reserve`（128→156px）会让官方整行 chrome 平移而**零 DOM 变动**，`MutationObserver` 的 childList / 右栏属性判据都收不到 ⇒ 落点**永不重测**、持续叠压 20px（「点击页面后恢复」= 点击引发 React 重渲染顺带补测）⇒ 增补 `documentElement` 的 `style` 观察（**同步**重测）与 `transitionend` / `visibilitychange` / `fonts.ready` 三个信号；③ 视口外的锚点（右栏收起时 dockkit strip 被 `transform` 推出视口，`left=1590` 而宽高非零）不参与让位。实测：过渡期 **41px → 0 帧重叠**；安全线跳变 **持续 20px → 1 帧（≈16ms）**；单测 33 → 38 例 |
| 页面 | `/ssh/` iframe 内嵌在视图组件中（样式隔离；client bundle 无法 `require` 第三方包） |
| SSH 实现 | **方案 A**：host 侧 `ssh2` + `ws`，前端 `@xterm/xterm` + `addon-fit` |
| 终端桥 | `ctx.webServer.registerUpgrade('/ssh/ws')` —— DSH 官方 WebSocket 注册 API |
| 连接保活 | 连接在 host 侧全局持有，视图切换 / 页面刷新不断连 |
| 凭据 | 密码仅 host 内存、断开即清；私钥只存路径引用；**任何密钥不进前端存储** |
| 指纹 | known_hosts TOFU 首次确认 + 变更拒绝告警 |
| 安全 | 三道浏览器围栏（Host / `sec-fetch-site` / Origin），**HTTP 与 WS upgrade 都过** |

为什么页面仍走官方 `conversation.view`：注册即得页面宿主、激活态、每会话记忆与视图卸载语义（切走卸载 iframe、host 侧回放 scrollback），canvas 手写 pill 的补丁史（幂等守卫 / 重渲染看门狗 / 叠压修复）不必重演。入口按钮虽然落在第一行 actions 槽（位置诉求），**切换仍委托官方 tab 的 onClick** —— DSH 未对外暴露 View 切换 API（`selectView` 只在官方 header 组件的 inject face 里），委托点击是官方唯一通道，且「找不到 tab 就收手」：最坏退回「双入口」，不会没入口。

## 里程碑

| 阶段 | 范围 | 状态 |
|---|---|---|
| **M1** | 纯终端 + 连接管理：`conversation.view` 入口、`/ssh/` 页面、密码/私钥/agent 三种认证、xterm 交互终端、known_hosts、三道围栏、连接保活 | **代码完成，待实机验收** |
| **U0+U1**（工作区规划） | U0 可靠性闭环（二进制输出 / 查看器实例 / 恢复 attach / 指纹闭环 / 输入归属）+ U1 统一工作区（主机导航 / 多标签 / 编辑抽屉 / 三主题桥接 / 复制粘贴 / 查找 / 字号 / 响应式） | **已实施，待实机验收** |
| **A0**（Agent 化规划 §8.2/§17） | 上下文桥：送往对话（选区 / 最近 40 行 / 错误追问）+ 来源主机标记 + 剪贴板通道 | **已实施（2026-09-14），待实机验收**（单测 63 例、`verify-all ssh` 12/12） |
| M2 | SFTP、系统终端打开、空白会话备用入口（多标签 / 断线重连 / 主题跟随 / 分组收藏已随 U1 交付） | **U2 主体已实施（2026-09-16）：[U2 规划](design/2026-09-15-ssh-u2-plan.md) §6 的 U2.1 多 shell / U2.3 工作区记忆 / U2.4 精确恢复已落地并过 **113 例单测** + 端到端探针（见[实施验收包](design/2026-09-16-ssh-u2-implementation-report.md)）；同轮实机验收发现并修复 4 处回归（2 阻断 / 1 高危 / 1 中危，见[验收报告](design/2026-09-16-ssh-u2-acceptance-report.md)）⇒ **待重启复验**；**U2.2 SFTP 已于 2026-09-26 实施**（zcode 降级链 + 8 个 REST 端点 + 文件抽屉 + ssh config 导入，单测 225 例、`verify-all ssh` 26/26，实施记录见 [CHANGELOG](design/CHANGELOG.md)，真实主机读写往返待实机验收） |
| M3 | 与 DSH 联动：选中文本送进对话、`ssh_exec` 工具（带审批门）、命令片段、跳板机 / 端口转发、云厂商实例导入 | **A1 工具面 + U3 跳板/本地转发已于 2026-09-26 实施**：`ssh_hosts` / `ssh_exec` / `ssh_session_read` 三工具（D2 总开关默认 `off`，patch `agentTools` 开启）；服务端分级 L0–L2（`classifyCommand`）；readonly 硬闸 + full 走 `userQuestions` 审批四态（unavailable 失败关闭）；key/agent 隐式建连、password 不；`exec.signal` 取消 + 双预算截断；审计台账（内存环 + 落盘 `exec-audit.jsonl`）+「Agent 执行记录」浮层。跳板 D4=②：目标连接经跳板 runtime 的 forwardOut 通道作 `sock` 注入（凭据/TOFU/票据全复用）；本地转发 direct-tcpip 真监听。真协议探针 8/8 归档 `_refs/scripts-archive/ssh-p2-probes/`，实施记录见 [CHANGELOG](design/CHANGELOG.md)。**A1 工具面已于 2026-09-26 实机验收**（真协议 sshd：工具面可见 + L0 直通 + L1 审批双向 + 拒绝零外发；基座 `_refs/scripts-archive/ssh-a1-live/`）；**真跳板建连 / 本地转发实机仍待验**；云厂商实例导入未动 |

## M1 前置 SPIKE

| 编号 | 验证项 | 状态 |
|---|---|---|
| S1 | `ssh2` 在 Windows + Node 22 下安装（`install.js` 是否因可选原生模块中断）与真实连接 | **已通过**（依赖安装成功，见下） |
| S2 | `ctx.webServer.registerUpgrade('/ssh/ws')` 能否注册并接管升级连接 | **已通过**（2026-09-09 实测） |
| S3 | xterm.js 资源由 host 路由 serve 的可行性与体积 | **已通过**（xterm 6.0.0 `lib/xterm.js` ≈ 260KB） |
| S4 | `conversation.view` 内嵌 iframe 的尺寸 / 滚动 / 键盘捕获 / 切换行为 | **已通过**（2026-09-09 实测） |
| S5 | ssh2 `hostVerifier` 能否在拒绝前拿到指纹并挂起（TOFU 交互） | **已通过**（回调式签名支持异步确认，代码已用） |

实测细节与数据见[设计文档 §9](design/2026-09-09-ssh-design.md)。S4 的附带结论是：**切视图会卸载重建 iframe**，因此 host 侧必须保留 scrollback 并在 attach 时回放。

## 目录结构

```
dsh-miasaki-ssh/
├── package.json            # @miasaki/dsh-ssh（dsh.client web 声明）
├── cordis.patch.yml        # 插件身份（id: ssh / 数据目录 / trustedHosts）
├── index.js                # host 半：路由族 + REST API + WS 桥（帧上限 + viewer 路由 + SFTP REST）
├── lib/
│   ├── store.js            # 纯数据层：连接库 / known_hosts / 三道围栏（可单测）
│   ├── runtime.js          # ssh2 运行时：TOFU / generation 绑定 / scrollback 环形缓冲 / WS 中继 /
│   │                       #   三层身份 + 票据 / keepalive / SFTP 会话缓存与 execOnly 记忆 /
│   │                       #   跳板（就绪门 + sock 注入）/ 本地转发 / readShellText
│   ├── diagnose.js         # 连接诊断：DNS / TCP+banner / 认证方式（只发 none）/ 出口 IP / verdict
│   ├── exec.js             # exec 通道前置（P0-3）：POSIX 包装 / close 收尾 + 排空 / banner 跳过 / signal 取消
│   ├── paths.js            # 远程路径规范化（SFTP 与 A1 共用的安全口径一处）
│   ├── sftp.js             # SFTP 传输层：列目录 / 流式上下行 / 变更 / SFTP→exec pipe 降级链 / 进度节流
│   ├── limits.js           # 共享上限常量（512MiB / 票据 TTL / 节流 / 并发）
│   ├── sshConfig.js        # ~/.ssh/config 别名导入（ssh -G 优先 + 自研解析回退，只导直连）
│   ├── forward.js          # 本地端口转发（net 监听 + forwardOut，U3/P2-1）
│   ├── policy.js           # A1 策略：命令分级 L0/L1/L2 + 访问判定（纯函数）
│   ├── tools.js            # A1 工具面：ssh_hosts / ssh_exec / ssh_session_read（定义与执行体）
│   └── audit.js            # A1 执行台账：内存环 + 追加落盘 exec-audit.jsonl（不记输出内容与秘密）
├── client.js               # client 半：第一行入口按钮（actions 槽）+ conversation.view 注册 + iframe 视图
├── session.js              # 前端查看器实例：一个查看器独占 xterm + WS，整体可销毁（U0）+ 主题/字号/查找 API（U1）+ 只读缓冲区快照（A0）+ v2 票据附着/多 shell 绑定/写权/序列化快照（U2）
├── sftp-ui.js              # 前端（iframe 内）：远程文件面板抽屉（U2.2）—— 面包屑/列表/上传队列/变更操作，自包含 IIFE（window.SshFiles）
├── app.js                  # 前端（iframe 内）：主机导航 / 多标签 / 编辑悬浮窗 / 工具区 / 状态栏 / 主题应用 / 送往对话（A0）/ 结构化标签与写权只读条（U2.1）/ 工作区快照（U2.3）/ 文件面板入口与 ssh config 导入（U2.2/P1-1）
├── styles.css              # 工作区布局 + --ssh-* 语义令牌（原生明暗兜底，宿主桥接覆盖）
├── test/                   # 单测 276 例（store: 围栏/归一化/持久化 ↔ runtime: TOFU/U0 故障注入/v2 票据与多 shell/就绪补绑/keepalive 与错误词汇 ↔
│                           #   session: 二进制/销毁隔离/重附着/主题查找/缓冲快照/写权与序列化快照/未绑定不发帧/按 seq 匹配 ↔
│                           #   exec: POSIX 包装/exit 早于 data/排空窗口/超时/协议行扫描/signal 取消 ↔ paths: 词法归一/NUL/控制字符/~ 展开 ↔
│                           #   sftp: 状态词汇/进度节流/列目录映射/上传降级链(sftp→exec pipe)/下载计数 ↔ http-sftp: 真实 HTTP 端到端（票据/fence/409/413/降级）↔
│                           #   sftp-ui: vm 加载/纯函数/接线契约 ↔ sshConfig: 解析器/ssh -G 合并/缓存/回退通道 ↔
│                           #   forward: 真 TCP 往返/EADDRINUSE/close 释放/store 归一化/编辑器契约 ↔ forward-runtime: 跳板选取/就绪门/转发生命周期 ↔
│                           #   policy: L0/L1/L2 分级表/readonly 硬闸 ↔ audit: 环语义 ↔ tools: 三工具执行体/审批四态/取消/超时/隐式建连 ↔
│                           #   app: 分组过滤/粘贴守卫/颜色合成/送对话格式/工作区快照 ↔ http: 路由与 attach 票据 ↔ client: 工厂契约 + 主题桥接快照）
├── design/
│   ├── 2026-09-09-ssh-design.md
│   ├── 2026-09-12-ssh-workspace-plan.md        # 工作区优化规划设计（U0/U1 已实施；U2 细化方案见下）
│   ├── 2026-09-14-ssh-agent-driven-plan.md     # Agent 化规划（已定稿；A0 已实施，A1–B 待做）
│   ├── 2026-09-14-ssh-global-panel-plan.md     # 独立模块化（全局面板）规划（待评审，未实施）
│   ├── 2026-09-14-ssh-fullscreen-overlay-plan.md  # 全屏浮层路线丁（D0–D4 全部实施并验收）
│   ├── 2026-09-15-ssh-u2-plan.md               # 工作区 U2 规划（SFTP / 多 shell / 工作区记忆 / 精确恢复）
│   ├── 2026-09-16-ssh-u2-implementation-report.md  # U2.1/U2.3/U2.4 实施验收包（变更清单/回滚演练/风险表）
│   ├── 2026-09-16-ssh-u2-acceptance-report.md  # U2 实机验收报告（4 处回归定位与修复 + 待复验清单）
│   ├── preview/
│   │   ├── 2026-09-12-ssh-workspace-concept.html  # 可交互概念稿（三主题 / 四档宽度 / 八种状态）
│   │   ├── 2026-09-14-ssh-d1-kickoff-board.html
│   │   ├── 2026-09-15-ssh-d2-review-board.html
│   │   ├── 2026-09-15-ssh-d3-review-board.html
│   │   ├── 2026-09-15-ssh-u2-spike-report.html    # U2.0 SPIKE 验收报告板（探针 A/B/C）
│   │   └── 2026-09-16-ssh-u2-acceptance-board.html  # U2 实机验收板（矩阵 / 四缺陷 / 复验清单）
│   └── CHANGELOG.md
└── README.md
```

## 文档

| 文档 | 内容 |
|---|---|
| [设计文档](design/2026-09-09-ssh-design.md) | 调研结论、技术选型、架构、数据模型、安全红线、里程碑、SPIKE 清单、风险 |
| [工作区优化规划](design/2026-09-12-ssh-workspace-plan.md) | **规划与实施记录**：现状诊断、信息架构、三主题桥接、连接生命周期契约、分期 U0–U3、验收矩阵。**U0（可靠性闭环）+ U1（统一工作区）已实施（2026-09-12），U2/U3 未动** |
| [工作区概念稿](design/preview/2026-09-12-ssh-workspace-concept.html) | 可交互概念稿：三主题 + 原生暗色、四档宽度、八种连接状态；仅本地演示 |
| [**Agent 化规划**](design/2026-09-14-ssh-agent-driven-plan.md) | **能力分层与实施规划（2026-09-14，已定稿）**：平台事实核查（`ctx.tools` / `ctx.approval` / `ctx.userQuestions` / `ctx.terminals` / host-preset 平面判据）、五条核心设计判断、四层能力（上下文桥 / 工具面 / 治理面 / 协作面）、工具清单、授权与命令分级、**SPIKE S1–S3 实测记录（§16）**、**A0 实施记录（§17）**、决策记录（D1–D4）与验收矩阵 |
| [**zcode 对标调研与方案**](design/2026-09-26-ssh-zcode-benchmark-plan.md) | **对标智谱 zai-org/ZCode v3.14.3 的 SSH 子系统（2026-09-26，待用户拍板 D1–D5）**：zcode 架构解剖（连接认证 / exec / SFTP 降级链 / host key 缺席 / ssh config 别名 / 连接向导 / 连接注册表 / 验证基建）、17 维逐项对照总表、**P0×3（keepalive 等健壮性三件套 / SFTP 注入 exec pipe 降级 / exec 前置工作）/ P1×4 / P2×4 共 11 项候选**、风险表、「明确不做」清单、参考索引 |
| [**独立模块化规划**](design/2026-09-14-ssh-global-panel-plan.md) | **从「会话视图」升级为「全局面板」（2026-09-14，待评审，未实施）**：诉求拆解（R1 独立 / R2 不消失 / R3 模块化）、作用域错配诊断、会话布参照物解剖、**0.1.5 全局面板通道逐行取证（`main` root keyed slot + `sidebar.panellist` + `ctx.layout.selectPanel`）**、**官方硬约束 F4（点会话条目强制回对话）**、A/B/C 方案对比、G0–G4 分期与 SPIKE 清单、待决策四项 |
| [**全屏浮层规划（已定向）**](design/2026-09-14-ssh-fullscreen-overlay-plan.md) | **路线丁：照会话布同构（2026-09-14/15，用户拍板「全屏／走丁方案」，**D0 五项（§12）+ D1 四门槛（§13）+ D1.1 launcher（§14）+ D2 顶栏六项（§15/§16）+ D3 清理回归十一项（§17/§18）+ D4 尾项清理三项（§19）实测全过**，浮层改造收官）**：决策记录、三路对比（甲/乙/丁）、分层结构、**与 canvas 的同构对照表**、五个关键技术问题（**§5.1 隐藏态误 fit 会写坏远端 PTY——必须偏离 canvas 的 `display:none`**、窗控 reserve、双浮层互斥、响应式重校准、焦点）、逐文件改动清单、D0–D4 分期、验收矩阵与风险表 |
| [**工作区 U2 规划**](design/2026-09-15-ssh-u2-plan.md) | **效率补齐（2026-09-15，**v1.0 已定稿**：7 项决策全部拍板；尚未开工）**：现状取证（**profile/runtime 共用 `connId`**、单 shell、连接级回放环与尺寸、WS 四帧、ssh2 SFTP 能力面、addon 版本实测）、**三层身份（connId → runtimeId → shellId）+ 短期附着票据**（规划 §8 硬要求）、四项分项设计（**同主机多 shell** / **SFTP**（REST 流式 + host 端零本机 IO）/ **工作区记忆**（偏好 `localStorage` + 快照 `sessionStorage` 双据）/ **精确恢复**（价值被 D0–D4 收窄，可降级为已知边界））、逐文件改动清单、U2.0–U2.4 分期与门槛、验收矩阵、风险表、SPIKE S-U2-1…4、**决策记录 7 项（全部已定）**；**§12 U2.0 SPIKE 验收：批内判据强度不通过（验的是自己构造的对象）→ 补做探针 A/B/C（真 Client×4 channel / 官方 addon / 真 GUI）全过后四项命门全部回答，两条独立路径同指 Go** |
| [**U2 实施验收包**](design/2026-09-16-ssh-u2-implementation-report.md) | **U2.1/U2.3/U2.4 交付说明**：逐文件变更清单、与 S-U2-1 实测基线的前后对照、自动化与手动验证记录、**回滚步骤（已实际演练：基线 85/85 绿 → U2 还原 110/110 绿）**、部署/发布说明、风险与遗留事项 R1–R7、决策符合性自检 |
| [**U2 实机验收报告**](design/2026-09-16-ssh-u2-acceptance-report.md) | **2026-09-16 实机验收**：验收矩阵逐项判定、运行态逐字节核查（含 addon 未上线的时序根因）、**4 处缺陷（2 阻断 / 1 高危 / 1 中危）的因果链与修复**、夹具缺陷登记、沙箱环境适配记录、**待重启复验清单**、未覆盖边界 |
| [CHANGELOG](design/CHANGELOG.md) | 本线变更记录 |

## 相关线

- [canvas 视图切换与叠压修复历史](../dsh-miasaki-canvas/design/CHANGELOG.md)
- [sidebar 终端启动器安全边界与 M3 内嵌终端规划](../dsh-miasaki-sidebar/README.md)
- [跨线共享参考](../dsh-miasaki-shared-docs/)
