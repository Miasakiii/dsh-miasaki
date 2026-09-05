# @miasaki/dsh-canvas

DSH（DeepSeek Harness）web 画布插件：可浏览、可分支、**可合并**的会话画布。

- 基础能力二开自 [dsh-synapse](https://github.com/liangmianya/dsh-synapse) v0.4.1（MIT，`LICENSE` 保留）：把同一工作区的会话、追问和分支组织成可拖拽、可缩放的地图，保留 DSH 原生会话作为唯一事实来源。
- 本项目的增量：**会话合并**（双线汇合产出真实 DSH 会话）+ 画布交互增强（多选/框选、拖拽并置合并手势、DAG 血缘渲染）。
- 产品理念参考：[Huabu](https://github.com/microsoft/Huabu)（微软亚研院）。

本目录根即插件包（`package.json` 在此），同时承载线级文档。

## 状态

**MVP 全量完成（M1–M4）**（2026-09-05）：`@miasaki/dsh-canvas` v0.5.0-miasaki.1——合并内核（v5 元数据 + merge RPC + 执行流）、画布交互（多选/框选、拖拽并置手势、吸收标记、详情传递血缘）、`summary` 注入形式、发送失败重试，全部实机验收。已适配 DSH 0.1.2-rc.1。已知限制与后续待办见 [CHANGELOG](design/CHANGELOG.md)。

## 合并怎么用

1. 进入「会话布」，一条线**线尾卡**上的 ◇ 按钮（或 Ctrl 点选两张不同线的卡，或把一张卡拖到另一条线的卡上）发起合并；
2. 合并面板选目标线、注入形式（**全文引用**：精确但上下文开销大；**摘要提炼**：省上下文但有信息损失）、可写合并指令；
3. 画布上出现紫色虚线边的**合并请求草稿卡**，确认无误点「执行合并」；
4. 插件从源线 fork 新 DSH 会话，把两条线的问题与结论写入首条合并请求，DSH 正常生成合并产物——菱形卡实时长出内容；原两条线保留，线尾带「已被吸收 ◇」标记，点击可跳回合并节点。

## 本机开发与安装

```powershell
# 安装到本机 DSH web profile（link 模式，改代码后重启 dsh web + 刷新页面）
dsh plugin --profile web add link:C:\Users\Asakii\Desktop\dsh-miasaki\dsh-miasaki-canvas

# 语法校验 + 全量测试（上游测试套件，64 个用例）
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm test
```

注意：`cordis.patch.yml` 的 `name` 是 loader import 的**包名**（必须 `@miasaki/dsh-canvas`）；`client.js` 的 ModuleLoader `id` 必须逐字等于包名——两者改错都会让插件加载失败（详见 SPIKE 文档坑 1/坑 2）。

## 目录结构

```
dsh-miasaki-canvas/
├── package.json                # @miasaki/dsh-canvas（插件包清单）
├── index.js                    # Host：WorkspaceStore + /canvas 路由 + 投影
├── client.js                   # 客户端桥：视图切换 + iframe postMessage RPC
├── app.js                      # 画布前端（iframe 内）
├── styles.css / deepseek-mark.svg
├── cordis.patch.yml            # web profile 注入行（数据目录 miasaki-canvas/）
├── test/                       # 上游测试套件（node --test）
├── docs/                       # 上游用户手册（zh-CN / en，内容基于上游原文）
├── design/                     # 本线设计文档与变更记录
│   ├── 2026-09-05-canvas-merge-design.md
│   ├── 2026-09-05-m1-spike-findings.md
│   └── CHANGELOG.md
└── README.md
```

## 文档

| 文档 | 内容 |
|---|---|
| [设计文档](design/2026-09-05-canvas-merge-design.md) | 目标、边界红线、三层分离的合并设计、架构与里程碑 |
| [M1 SPIKE 结论](design/2026-09-05-m1-spike-findings.md) | fork API、注入消息 API、link 安装闭环、首条消息携带；改名清单与 DSH 升级风险注记 |
| [CHANGELOG](design/CHANGELOG.md) | 本线变更记录 |
| [上游用户手册](docs/zh-CN/README.md) | 安装、启动、配置、使用、卸载和限制（安装命令以本文档为准） |

## 设计要点（速览）

- **分支**：沿用 DSH 原生 fork（`ctx.sessions.fork({ sessionId, atSeq, increaseTitle })`），血缘由 `sourceParentSessionId` + `sourceSeedLength` 忠实记录。
- **合并**：三层分离——DSH 事实层（fork 新会话 + 首条消息注入另一线内容）、投影层（`mergeFrom` 元数据 + 菱形 DAG 节点）、交互层（合并请求卡 + 拖拽手势）。
- **红线**：不改系统提示/模型请求/工具 schema；插件不直接调模型；DSH 是唯一事实来源。
- **数据隔离**：画布元数据存 `$DSH_HOME/miasaki-canvas/`，不与上游 dsh-synapse 的 `$DSH_HOME/synapse/` 共用。
