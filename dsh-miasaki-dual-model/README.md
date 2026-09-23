# Miasaki Dual Model

> DSH web 双模型插件线 `@miasaki/dsh-dual-model` —— 会话级「主模型 + 辅助模型」，只要其一支持图片即可上传图片，输入框右下角快速配置。

## 状态

**0.1.3-miasaki.0（2026-09-23）**：设置变更的缓存失效信号改为**新旧事件双轨监听**
（`settings/updated` + `settings/document-updated`，见 `lib/invalidation.js`）——
DSH 0.1.7 重写设置机制后旧事件被移除，双轨让本线在 0.1.5/0.1.6 与 0.1.7+ 上行为一致、
升级零改动。详见 [`design/CHANGELOG.md`](design/CHANGELOG.md) 2026-09-23 条目。

**0.1.2-miasaki.0（2026-09-22）**：右下角「双模型」选择框 UI 优化 —— 全部配色切换到
DSH 真实主题令牌（旧实现引用的 `--dsw-static-surface` / `--dsw-static-text` / `--dsw-static-border`
在本体不存在，面板背景恒回退硬编码 GitHub 深色，浅色主题下不可读），弹层表面对齐官方
ContextMeter 面板（`--dsw-specific-menu` + `--dsw-elevation-prominent` + 12px 圆角），
折叠按钮对齐官方紧凑控件（28px / 999px 圆角 / `--dsw-specific-selector`）；折叠态改为
「主 ▸ 辅」双短名（设计文档 §5.2 原意），面板新增主模型行与「看图 / 纯文本」能力徽标；
新增 Esc / 点击面板外关闭。详见 [`design/CHANGELOG.md`](design/CHANGELOG.md) 2026-09-22
UI 优化条目。

0.1.1-miasaki.0（2026-09-22）：M1 的「配置模型」控件渲染崩溃已修复——
标准 kit hook `useInput` 必须带 selector 调用（`bindSnapshotSelector` 无 identity 兜底，
无参调用抛 `selector is not a function`，控件被 slot error boundary 吞掉）；
字段名由 `imageIds` 更正为 `attachmentIds`。修复后按钮 / 面板 / 下拉在真实 GUI 实测可用，
详见 [`design/CHANGELOG.md`](design/CHANGELOG.md) 2026-09-22 条目。

M1 原始实现见 2026-09-10 记录；M0 六项技术假设已实测全部成立，
设计定稿见 [`design/2026-09-10-dual-model-design.md`](design/2026-09-10-dual-model-design.md)（§8 为 M0 实测结果）。

## 解决什么

DSH 0.1.5-rc.1 的现状是：**图片能拖进输入框，发送时才被 host 拒绝**。

- 客户端 `canAcceptDrop` 与模型能力无关，图片随便拖入；
- host `session.prompt` 按「当前会话模型是否声明支持图片」硬拒整条消息；
- 若绕过该校验，`dsh-llm` 会把图片**静默替换成一行占位文本**（不报错）——比直接失败更糟。

本线把「准入判定」与「实际执行者」统一到同一个能力真值源上，让图片在有任一支持图片的模型时即可用。

> **痛点场景已实测确认**：本机 9 个 provider / 59 个模型中，`openrouter` 的 **21 个免费模型全部不支持图片** ——
> 以免费池模型为主力时图片上传完全不可用。另有 16 个视觉模型可作辅助模型候选（`mimo-v2.5-free` 免费 → `deepseek-flash` → `claude-*`）。

## 组成

| 部分 | 位置 | 职责 |
|---|---|---|
| Host 半 | `index.js` + `lib/` | 提供 `dualModelVisionRoute` 可选服务；在 `agent/pre-step` 记录每步的图片上下文；在 `agent/request` 把含图步骤路由到辅助模型；`/dual-model/api/*` JSON 路由 |
| Client 半 | `client.js` | `conversation.input.right` 控件：状态点 + 辅助模型选择 + 「图片将由谁处理」状态行 |
| 运行时补丁 | `patches/dsh-api-session-controller/` | 把 `session.prompt` 的图片准入判定委托给上面的可选服务（详见其 [README](patches/dsh-api-session-controller/README.md)） |

**补丁与插件必须同版本上线**：补丁负责「放行」，插件负责「真的有人能处理图片」。只打前者会出现放行后图片被静默丢弃的失败模式。

## 安装

```powershell
# 1) 注册到 DSH web profile（link 方式，改源码后重启 host 生效）
#    在 %USERPROFILE%\.dsh\profiles\web\package.json 中：
#      dependencies 加 "@miasaki/dsh-dual-model": "link:C:/Users/Asakii/Desktop/dsh-miasaki/dsh-miasaki-dual-model"
#      dsh.profile.bundles 加 "@miasaki/dsh-dual-model"
cd $env:USERPROFILE\.dsh\profiles\web ; pnpm install

# 2) 应用图片准入补丁（会备份为 .dsh-bak，可 revert）
cd C:\Users\Asakii\Desktop\dsh-miasaki\dsh-miasaki-dual-model\patches\dsh-api-session-controller
node patch.mjs apply

# 3) 重启 dsh web（host 半与补丁都只在启动时加载）
```

## 验证

```bash
node ../scripts/verify-all.mjs dual-model     # 静态检查 + 29 项单测 + 补丁离线自证
```

实机验证点（需运行中的 DSH host）：右下角出现「双模型」控件；配好辅助模型后拖入图片，
状态行显示「图片将由「X」处理」；切换主模型到纯文本模型后仍可发送带图消息且模型能读到图。

## 关键设计结论

1. **三层拆解**：准入（能不能传）/ 路由（谁来看图）/ 配置（在哪配、存哪）—— 三者必须共享同一个能力真值源。
2. **路由判据取自 `agent/pre-step`**：官方 `prepareRequest` 契约是 "before admitting model-visible input"，
   `agent/request` 触发时本步消息尚未进入 Session。pre-step 的 payload 带本步消息，
   历史由 `session.deriveMessages()` 补齐 —— 这同时天然覆盖「同 turn 后续步骤」与「后续 turn 引用旧图」，
   且 compaction 清理图片后自动回落主模型。
3. **UI 落点是加法槽**：`conversation.input.right`（`replaceRisk: none`），位置正是「提交按钮之前」；0.1.5-rc.1 该槽不变。
4. **准入用可选服务探测**：未装插件时本体走原生分支（零退化），装插件才改变准入。见设计文档 §3.4。

## 与其他线的关系

- 与 `dsh-miasaki-desktop/plugins/dsh-free-model-pool` 的能力画像（含**视觉**判定）存在复用可能。
- 官方 `subagentModelSelection` 是「第二模型」配置的现成模板。
- 六条线代码零耦合，仅共享 `../dsh-miasaki-shared-docs/`。
