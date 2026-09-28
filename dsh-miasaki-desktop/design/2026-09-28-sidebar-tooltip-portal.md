# 侧边栏头部悬浮提示「被遮盖」修复（Tooltip portal 化）

- 日期：2026-09-28
- 状态：已落地（运行时补丁 `dsh-miasaki-desktop/patches/dsh-client-ui-sidebar/`）
- 触发：用户实机报告「鼠标悬浮在左上角时，悬浮提示会被遮盖」+ 两张截图

## 症状

DSH web GUI（`dsh web`，127.0.0.1:3080）左上角侧边栏头部，鼠标悬浮 logo 时
弹出的「新建会话」深色气泡**被遮盖 / 被裁切**。截图实测（2026-09-28）：

- 截图 A（566×112，未悬停）：brand 行正常，右侧一个 28px panel-left 图标按钮
  （479–506）全可见，其右仅余 3px 深色弧条（541–543，y 40–82，胶囊状左端盖）。
- 截图 B（604×106，悬停 logo）：「新建会话」气泡位于 471–545（75×52，圆角
  ≈10，与 logo 行垂直居中 = side:"right" 气泡），文字完整但已贴到中栏区域；
  悬停态下中栏控件被气泡覆盖。

两个状态合起来表明：side:"right" 的气泡从侧边栏列内探入中栏时，超出侧边栏
右界的部分被后绘制的中间列内容**盖住**（截图 A 的 3px 弧条即气泡露出侧边栏
列的残余）。

## 归因

### 组件与挂点

`@deepseek-ai/dsh-client-ui-sidebar` 的 `SidebarRoot` 在 logoRow 内渲染：

```
logoRow（overflow:hidden）
  ├ Tooltip「新建会话」→ button.brand      ← 用户报告点（side 默认 "right"）
  └ Tooltip「收起侧边栏」→ button.toggle   ← side: captionTooltipSide
同包另两处：newSession pill（disabled:wide）、PanelRow（折叠轨道态）、
HeaderLeadingControls（shell.leading 窗槽，macOS 侧边栏全隐时）。
```

全部 **不带 `portal`**，气泡作为锚点兄弟节点渲染在侧边栏列内，CSS 为
`position: fixed; z-index: 100`。

### 绘制顺序

`AppFrame`（ui-layout）三列 grid，DOM 序 sidebar 在前、center 在后：

```
sidebarCol(overflow:hidden, 无 transform/contain)     ← 不形成叠加上下文
centerCol → conversation.session.header
  ├ titleRow: container-type: inline-size              ← 布局遏制 = 叠加上下文 + fixed 包含块
  └ tabs:     z-index:1; position:relative             ← 定位后代，树序上晚于整个 sidebar 子树
```

固定定位气泡不会被普通 `overflow:hidden` 裁剪（无包含块），但侧边栏子树内
z-index:100 的解析受限于根叠加上下文；中间列任意后绘制的叠加上下文
（titleRow 的 container-type、tabs 的 z-index、以及窄窗口 <1024 时
`narrowExpanded` 让侧边栏覆盖在被挤压的中栏之上）都会把内联气泡压在下面。
**官方 Tooltip 组件的 JSDoc 即为这个失败模式提供了逃生通道**：
`props.portal` —— "render the bubble under document.body, so an ancestor's
clipping or its stacking context (which confines the bubble's z-index to that
context) cannot hide it"，portal 气泡 z-index 1100。同 shell 的菜单
（`.JYBKaa_portal{z-index:1100}`）、上下文计量面板（z-index:1100 fixed）都走
这条通道；侧边栏包一处都没用。

### 为什么不是别的原因

- web profile 五个社区插件（free-model-pool / model-probe / pet-panel /
  session-log-move / token-monitor）均无 fixed/高层级覆盖元素、不占
  sidebar.brand 槽、不改侧边栏宽度——全部排除。
- 官方 UI 常驻 z-index 只有 overlayLayer(20)/leadingSeat(15)/handle(11)，
  永久高于 tooltip(100) 的全屏浮层（settings 1001 / onboarding 900 / 模态
  1000）在正常会话态不挂载——排除「被常驻浮层盖住」。
- 与 0.1.6-alpha.2 源码对照：Tooltip CSS、logoRow/frame 结构无回归差异——
  不是升级引入的行为变化，是官方自始未用 portal。

## 方案

给 `dsh-client-ui-sidebar` 包内全部 6 处 Tooltip 加 `portal: true`：

| # | 调用点 | 理由 |
|---|---|---|
| 1 | HeaderLeadingControls · 打开侧边栏 | shell.leading 窗槽悬在中栏之上 |
| 2 | HeaderLeadingControls · 新建会话 | 同上 |
| 3 | PanelRow（折叠轨道态） | side 默认 right，必探入中栏 |
| 4 | SidebarRoot · 开关按钮 | 紧邻报告点，同一失效 |
| 5 | **SidebarRoot · brand（用户报告点）** | side 默认 right，探入中栏 |
| 6 | SidebarRoot · 新会话 pill | 折叠态启用，同一失效 |

几何（side/align/fit 钳制）与内容零变化——位置计算只依赖锚点 rect 与
window，与挂点无关；交互（pointer-events:none、悬停/聚焦、抑制通道、keycap）
原样。

**备选方案与否决不**：

- 改 `side: "bottom"`（captionTooltipSide 风格）：破坏官方桌面/网页两态一致的
  几何语义，且气泡仍会被中栏底部内容盖——否。
- 提高内联气泡 z-index：盖不过「整棵侧边栏子树早于中间列入栈」——否。
- 插件侧 CSS `!important` 修：治标且与叠加上下文无关——否。

## 边界与风险

- portal 气泡 z-index 1100 > 全屏浮层（1001/1000）：与官方菜单层同层，
  模态/设置全屏态本就不应见 tooltip，行为与官方菜单一致。
- 与 pet-panel 瞬时 toast（2147483646）相遇时 toast 在上；toast 仅人格切换
  后 3.6s 可见，可接受。
- DSH 升级覆盖该包后补丁失效，按 README「升级后怎么办」重打。

## 落地物

- 补丁：`dsh-miasaki-desktop/patches/dsh-client-ui-sidebar/`（patch.mjs +
  baseline/client.original.js + rebuild-baseline.mjs + README.md）
- 回归：`scripts/verify-all.mjs` 新增「patch verify (侧边栏悬浮提示 portal 化
  补丁可重建)」一项（verify 纯离线：baseline 重建 → SHA 比对 + 语法闸门）
- live 状态：`node patch.mjs apply` 已写入全局安装（0.1.7-rc.2），
  status=patched，SHA 与记录一致

## 验证

- `node patch.mjs verify` PASS（6 条编辑，SHA-256 `655ED7D5…`，语法闸门过）
- live 生效条件：client 侧产物，**刷新页面**即生效（host 早于写入启动时
  client-hmr 热推 rebuilt 帧）；实机验收点 = 悬停左上角 logo，「新建会话」
  气泡完整浮于中栏之上不再被裁。
