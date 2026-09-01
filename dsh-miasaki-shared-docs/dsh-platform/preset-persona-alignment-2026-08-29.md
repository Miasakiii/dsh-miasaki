# 官方 preset/persona 机制调研与本地桌宠预设链路对齐核对

- 日期：2026-08-29
- 调研者：总指挥（Miasaki 会话）
- 调研方式：GitHub 官方仓（deepseek-ai/deepseek-harness master）raw 文档精读 + 本地已装预设实例（`%USERPROFILE%\.dsh\.agent-presets\whale\agent.cordis.yml`）+ `preset-sources/` 全量对照
- 结论速览：**本地桌宠预设链路（`preset-sources/` → `apply-presets.ps1` → `~/.dsh/.agent-presets/`）与官方 user-root + copy-only 作者模型完全一致；persona 注入 `dsh-persona` 行的 `text` 字段是官方正解。无需任何改动，仅记录两个运维注意点与两个可选进阶方向。**

来源文档（官方仓 master）：

- `packages/preset/README.md`、`packages/preset/agent-presets/README.md`、`packages/preset/persona/README.md`
- `packages/extensions/README.md`（动态 Cordis 插件子系统，见既往调研）
- `docs/architecture.md`、`docs/subsystems/system-prompt.md`

---

## 1. 官方 preset 机制速览（`packages/preset/`）

- **一个 agent preset = 一个目录 + 一份 `agent.cordis.yml`**。会话由预设组合而来：跑该预设的工具、prompt 段与技能；其他会话保持自己的组合，一个进程可同时运行多个不同组合的 agent。
- **花名册（roster）两个来源**：
  - 包内置 `presets/`（`system` 根，随部署升级）
  - 用户自建 `<dshHome>/.agent-presets`（`user` 根）——本地桌宠预设就住在这里。
- **常驻挂载（standing mount）**：每预设每进程只挂一次；同预设会话共享组合、状态各自独立；子代理继承父会话组合。
- **代际（generation）按 `agent.cordis.yml` 的 mtime+size 判定**：新会话发现文件戳变了才挂新一代；已运行的会话永远留在旧代际。⚠️ 只改同目录 skill 文件/资产不触发换代。
- **作者模型 copy-only**：新建预设只能整目录复制现有预设（组合、元数据、技能目录、资产），不接受手写组合文本；id 必须匹配 `[a-z0-9][a-z0-9-]*`；复制不覆盖已有 id。
- **删除限制**：只能删 user 根下自建预设，随部署内置的不可删；已运行在已删预设上的会话继续运行。
- **切换限制**：会话仅在**尚未产出任何消息/工具调用**时才能换预设，之后组合锁定（防止中途换工具集导致已记录的工具调用无法执行）；切换会记录进会话日志，恢复/分叉按所跑组合重建。
- **破损可见**：组合缺失/不可解析/模块无法解析的预设不隐藏，带原因列出；组合失败在会话创建前拒绝，绝不让会话半组合启动。
- **信任语义**：自建预设与它所命名的插件同等特权——等于 shell 权限。

## 2. `dsh-persona` 行契约（`packages/preset/persona/`）

预设要改 agent 的"身份"（而非只改工具），挂这一行：

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a terse systems engineer who answers in short commands.
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `text` | 必填 | 渲染为 `deployment:persona` 段的人设文本；`{{…}}` 模板变量在**渲染时**严格按已注册 prompt 变量解析（如 `{{model}}`、`{{cwd}}`） |
| `complete` | `false` | `true` 时汇编结束后把该人设恢复为**唯一**系统提示段，其余所有段（身份、工具指引、监听者追加）全部压制 |
| `includeRuntimeContext` | `true` | `false` 时对该 agent 作用域关闭全部动态运行时上下文快照（沙箱/审批/委派策略说明），不影响拥有这些事实的服务 |

关键语义：

- 注册为 `deployment:persona` 段、order 0（紧跟 harness 身份开头），**shadow** 部署级人设，只对被该预设组合的 agent 生效；
- **只能挂在预设组合内**：全局挂载会与 prompt registry 自己的 persona 注册冲突并故意报错——这一行存在的全部意义就是"为单个 agent 遮蔽默认人设"；
- 空文本也能占位：把部署级人设完全遮蔽后渲染为空；
- 部署级默认人设本身配置在 `dsh-system-prompt` 行上，不是在这里；
- KV cache 友好：每 agent 一生挂一次、文本不变，不同预设的会话从该段起前缀不同，互不失效。

## 3. system-prompt 汇编要点（`docs/subsystems/system-prompt.md`）

- `PromptSection`：`name`（同层重名抛错）/ `order`（升序，同序按 name 码位）/ `text`（静态文本或每次汇编求值的 provider，可含 `{{变量}}`）/ `complete`；
- 动态上下文是 `PromptContext`（cache-safe 的 PromptSection 对应物），由 agent-loop 在保留模型历史后以 user 角色快照落日志，仅在变化或被压缩移除时重写；
- `ctx.systemPrompt` API：`section() / context() / variable() / tools() / suppressRuntimeContext() / assemble()`；变量名规则 `[a-z][a-z0-9_]*`；
- `system-prompt/assemble` 为瀑布事件（专家级扩展点）；生效的 `complete` 段在瀑布**之后**恢复，监听者无法向 complete 段追加内容。

## 4. 本地链路逐项核对表

| 官方契约 | 本地实现 | 状态 |
|---|---|---|
| 预设目录 = `<dshHome>/.agent-presets/<id>/agent.cordis.yml` | `%USERPROFILE%\.dsh\.agent-presets\whale\agent.cordis.yml` | ✅ 正是官方 user 根 |
| 人设 = `dsh-persona` 行的 `text` 字段 | `apply-presets.ps1` 把 `*.persona.txt` 注入 `text: >-` 锚点 | ✅ 官方正解 |
| 元数据 = `preset.yml`（name/description/order） | `whale.preset.yml` 等三文件三字段齐全 | ✅ 正是 display metadata |
| 作者模型 = copy-only（复制 standard 再改） | whale/kurumi/inverse 均为 standard 全量复制 + persona 替换 | ✅ 官方推荐做法 |
| 模板变量 | persona 已使用 `{{model}}`、`{{cwd}}` | ✅ 官方变量 |
| 默认 `complete: false` | 未设置 → 只 shadow 人设段，身份/工具指引段保留 | ✅ 正好满足"入戏边界"诉求（工作场合保持标准） |
| `includeRuntimeContext` 默认 true | 未设置 → 保留运行时上下文 | ✅ |

## 5. 运维注意点（已有防御，记录备忘）

1. **代际判定只看 `agent.cordis.yml` 的 mtime+size**：`apply-presets.ps1` 每次 `WriteAllText` 重写 → mtime 必变 → 新会话拿到新人设、运行中会话保留旧代际。改完人设须开新会话验证（已符合现有预期）。
2. **锚点失配防御**：脚本用固定 `oldText` 字符串做 replace 锚定，官方 `standard` 底座升级若动了 `dsh-persona` 行默认 text 会 throw 提醒；脚本注释已写明"底座升级时先做 standard diff"。

## 6. 可选进阶（仅设计决策参考，本次未实施）

1. **完全体人设**：给 persona 行加 `complete: true` → 人设段即全部系统提示，不混任何部署级指引；
2. **部署级默认人设**：想让桌宠人设成为所有会话默认（而非靠选预设），改 `dsh-system-prompt` 行的部署级 persona 配置即可，preset 行继续负责按会话 shadow。

## 7. 与既往调研的关系

- 本篇为 08-16 / 08-17 官方仓调研（`dsh-official-repo-review-2026-08-16.md`、`dsh-official-repo-review-2026-08-17-rc7.md`）在 preset/persona 子系统的补充精读；
- 涉及动态 Cordis 插件工具（`cordis_inspect_* / cordis_define / cordis_run`）的底层即 `packages/extensions/` 四包（tool-cordis / cordis-host-runner / cordis-client-runner / ui-cordis）：定义仅存于进程内存、重启即清、插件持不可变 Package 版本，供后续桌宠面板动态插件线参考。
