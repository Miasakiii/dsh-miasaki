# @miasaki/dsh-sidebar

DSH（DeepSeek Harness）web 轻量右侧边栏插件：**无重基座**的自研右栏，内置辅助对话、审查、终端三类实在工具。

- 路线 D（2026-09-06 拍板）：不安装 `dsh-better-sidebar` 基座，完全自研；与 canvas 线同构技术栈，零代码耦合；
- 产品理念参考：Codex `/side` 侧边对话、GitHub Copilot 右栏范式、CHI'25 常显侧面板研究（详见设计文档 §2 调研来源）；
- 红线沿用 canvas：不改系统提示/模型请求/工具 schema；DSH 原生会话是唯一事实来源；插件不直接调模型。

## 状态

**M1 实现中**（2026-09-07）：右栏壳 + 审查 tab 数据面已实机验证（见下），下一项为终端启动器。

- 壳：AppFrame padding 推挤（实测 center 1000→600px）、`shell.overlay` 挂载、空态标签选择页（Edge 范式）、双环境入口（桌面壳标题栏徽章左侧 / 浏览器会话头）、48px 让位、三主题令牌跟随；
- 审查 tab：host `/sidebar/api/review/{status,diff,checklist}`（git CLI 只读、2000 条设界、自研 unified diff 解析、按 cwd 隔离的清单持久化）+ 收尾自检清单 UI（逐条点名 / 未点名红色警示 / 行级 diff 展开 / 60s TTL 刷新）。实测本仓 16 条改动全部渲染、点名与 diff 往返正常。

## 组件蓝图（M1–M3）

| 组件 | 定位 | 里程碑 | 状态 |
|---|---|---|---|
| 右栏壳 | AppFrame padding 推挤 + shell.overlay 挂载 + 空态标签选择页 + 三主题令牌 + 桌面壳让位 | M1 | **已实机验证**（2026-09-06） |
| 审查 tab | 收尾自检清单 + 本轮 git diff（行级渲染） | M1 | **已实机验证**（2026-09-07） |
| 终端启动器 | host spawn 系统终端到会话 cwd（Windows Terminal / pwsh） | M1 | 设计完成 |
| 辅助对话 tab | fork+注入侧线（复用 canvas merge 内核链路）+ 侧线树 + 保存为新会话 | M2 | 设计完成 |
| 内嵌终端 | xterm + node-pty + 自建 WS 路由（同屏） | M3（条件立项） | 仅规划，见设计 §6 |

## 目录结构

```
dsh-miasaki-sidebar/
├── README.md
├── package.json            # @miasaki/dsh-sidebar（dsh.client web 声明）
├── cordis.patch.yml        # 插件身份（id: sidebar / 数据目录 / trustedHosts）
├── index.js                # host 半：/sidebar/api 路由族（review 已落地，terminal 待 M1 后续）
├── client.js               # client 半：壳面板 + 审查 tab + 双环境入口 + 推挤/空态/持久化
├── test/
│   └── review-data.test.js # diff 解析器 / 文档同步检测 / checklists 持久化单测
└── design/
    ├── 2026-09-06-sidebar-roadmap-design.md   # 路线 D 总设计（§3.1.1 spike 结论 + §3.1 入口定稿）
    └── CHANGELOG.md                            # 本线变更记录
```

## 规划来源

- [路线讨论与调研（跨线共享文档）](../../dsh-miasaki-shared-docs/cross/sidebar-plan-2026-09-06.md)
- 上游参考（仅调研/架构参照，不装、不 fork）：[DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT）
