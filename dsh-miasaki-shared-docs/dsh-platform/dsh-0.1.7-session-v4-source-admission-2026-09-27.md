# DSH 0.1.7 会话格式 v4 的消息来源准入（`kind: "plugin"` 被硬拒）

> **本文回答一个具体报障**：miasaki 桌面端出现「本轮运行失败 format v4 message requires a
> producer-owned source kind」，状态 `UNKNOWN`。
> **结论**：不是会话损坏、不是模型问题，而是**第三方插件仍在用 v3 的消息来源写法**，
> 被 DSH 0.1.7 起的 v4 准入在**落盘前**拒绝。修法是升级该插件，不是修会话。
>
> 日期：2026-09-27 ｜ 适用：DSH `0.1.7-*`（v4 会话格式）｜ 实例：`@openviking/dsh-memory-plugin`

## 1. 报错在说什么

DSH 0.1.7 起会话日志格式为 **v4**。v4 要求每条 durable 消息的 `source.kind` 是
**生产者自有的 kind**（producer-owned）——即"谁写的、署谁的名"。

退役的 **v3 写法**是：

```js
{ kind: "plugin", plugin: "<插件名>" }   // ✗ v4 硬拒
```

v4 的合法形态是把生产者名并进 kind：

```js
{ kind: "plugin:<插件名>" }              // ✓ 例：plugin:openviking-memory
```

判定实现（DSH 0.1.7-rc.2 实装代码）：

| 位置 | 函数 | 时机 | 拒绝范围 |
|---|---|---|---|
| `dsh-session-persistence-jsonl/lib/worker.cjs:11758` | `assertV4RowAdmission` → `assertV4SourceRowAdmission` | **写 / 读每一行** | 只拒 `kind === "plugin"`（v3 语法本身） |
| 同上 `:11678` | `assertReleasedV4Relationships` → `assertV4MessageSources` | **恢复已发布的 v4 会话** | 拒一切非 producer-owned：缺失 / 非对象 / 空 kind / `plugin` |

两处抛的都是同一句 `SessionFormatError('format v4 message requires a producer-owned source kind')`
（源码：`packages/session/session-format-v3-to-v4/src/message-sources.ts`）。

**它出现在 UI 上的样子**：DSH 把它当成该轮的 turn error，文案为 `message.turnError`（"本轮运行失败"）
＋ 错误原文，右侧模型列可能是 `UNKNOWN`（那一轮还没轮到模型）。所以**先把「模型坏了」这个方向排除掉**。

## 2. 为什么磁盘上查不到

这是本次排查最费时的一点：**被准入拒绝的消息根本不会落盘**。
`assertV4SourceRowAdmission` 在写入前抛错 ⇒ 那一轮的会话日志里**没有任何痕迹**，
host 日志（`server.log` / `pet.log` / watchdog 报告）也不会有 —— 它是 turn 级错误，直接顶到 UI。

因此判据必须分两路：

- **磁盘侧**（会话日志里有没有已存在的坏数据）→ 用 `scripts/inspect-session-sources.mjs`；
- **写入侧**（哪个插件会写出这种消息）→ 用 `scripts/check-message-sources.mjs`。

本次两路都跑了：全库 **533 个会话文件**里 `kind:"plugin"` 共 **1976 条，全部落在 v3 / 更早代的旧文件**
（218 个无版本号 + 146 个 `.v3`），**v4 文件 0 条** —— 这正是"升级后它一次都没写成功过"的形状。

> **日志取证坑（务必记住）**：会话日志是**逐帧追加的 zstd**（单文件实测可达数万帧）。
> `zstdDecompressSync(整个文件)` **只解得出第一帧**（就是 header 那一行），
> 于是看起来"日志是空的 / 只有一行"。必须按帧 magic（`28 B5 2F FD`）切分后逐帧解压。

## 3. 本次实例

| 项 | 值 |
|---|---|
| 插件 | `@openviking/dsh-memory-plugin`（第三方记忆插件） |
| 出事版本 | `0.2.1`（`runtime.mjs:305` 用 `{ kind: "plugin", plugin: "openviking-memory", form }` 构造注入消息） |
| 注入时机 | 挂在 `agent/pre-step`（`index.mjs:32-43`）：**每一轮**把「启动画像 / 记忆召回」追加进本轮消息 |
| 后果 | 追加的消息要落盘时被 v4 准入拒绝 ⇒ **整轮失败**（"本轮运行失败"），而插件本身不报自己的错 |
| 修复版本 | `0.5.8`（`capture.mjs:8` 改为 `` OPENVIKING_PLUGIN_KIND = `plugin:${OPENVIKING_PLUGIN_SOURCE}` ``） |
| 装在哪 | `~/.dsh/profiles/miasaki` 与 `~/.dsh/profiles/web`（两处都要升） |

**为什么升级 DSH 时没人拦**：0.2.1 声明的 peer 范围是 `>=0.1.0-rc.6 <0.2.0`，
而 `0.1.7-rc.2` 落在区间内 ⇒ 包管理器判定"兼容"，实际已在 v4 上失效。**peer 范围不保证协议兼容。**

### 判定闭环（实测，不是读代码推断）

用 DSH 实装的 v4 编码器（`releasedV4SessionFormatCodec.encodeEvent`）喂两种 source：

```
kind: "plugin"                  → SessionFormatError: format v4 message requires a producer-owned source kind
kind: "plugin:openviking-memory" → 通过
```

升级后再用插件**真实导出**的 `pluginMessage()` 构造消息并过同一编码器 → 通过（见 §5 验证记录）。

## 4. 通用识别方法（下次别的插件中招照此办）

1. **它往会话里写消息吗？** 看插件是否挂 `agent/pre-step`、`session/event`、往 inbox 注入、
   或调用 `createUserMessage` / `session.prompt` 一类入口。
2. **它怎么构造 `source`？** 找 `kind:` 字面量 —— 精确等于 `"plugin"` 就是中招；
   `"plugin:<名>"` 则已适配。（比较式 `kind === "plugin"` 是**迁移/校验代码**的正当形态，不算问题。）
3. **升级到最新版还中招吗？** `npm view <包名> versions`，拉最新 tarball 看同一个函数 ——
   本次 0.5.8 已修，`0.2.1` 未修（**不要只看版本号变大就假定修好了**）。
4. **兜底**：把该插件从 profile 的 `dsh.profile.bundles` 移除（记忆类插件失效，其余不受影响），
   或按 v4 形态自行改写法并在读取侧同步 `kind` 判定。

## 5. 本次修复与验证记录

改动（**用户环境，不在本仓库**）：`~/.dsh/profiles/{miasaki,web}/package.json` 的
`"@openviking/dsh-memory-plugin": "^0.2.1"` → `"^0.5.8"`，两处 `pnpm install`（各 `+1 -2`）。
备份留在同目录 `package.json.bak-20260927-203025-before-openviking-0.5.8`。

验证（全部实测）：

```
落盘版本       miasaki 0.5.8 / web 0.5.8
常量核对       OPENVIKING_PLUGIN_KIND = `plugin:${OPENVIKING_PLUGIN_SOURCE}`
真实构造       pluginMessage('召回测试块', {form:'recall'})
               → source = {"kind":"plugin:openviking-memory","plugin":"openviking-memory","form":"recall"}
v4 准入       通过 ✅（对照：旧写法逐字抛出用户截图那句错误）
模块加载       capture.mjs / index.mjs 均可导入（peer 依赖可解析）
宿主 peer      dsh-llm / dsh-mcp-client / dsh-skill-filesystem 均 0.1.7-rc.2，满足 ^0.1.7-rc.2
残留排查       miasaki + web 的 @openviking / @yeesy369 与全部自制插件：0 处
```

**生效条件**：插件装在 host 半，**只在启动时加载** ⇒ 必须重启后端
（miasaki 桌面端关掉壳再打开；`dsh web` 重启进程）。
> `pnpm peers check` 在 DSH profile 下会报 `missing peer @deepseek-ai/dsh-llm` 之类 ——
> 那是**正常形态**（peer 由宿主共享目录 `~/.dsh/profiles/node_modules/` 提供），不是故障。

## 6. 已固化的闸门与工具

| 产物 | 作用 |
|---|---|
| `scripts/check-message-sources.mjs`（`verify-all repo` 第 3 项） | 扫仓库内源码 + 本机已装插件，禁止退役 v3 source 写法；**内置自证**（正例必命中、反例必不误报），故障注入实测 `exit 1` 并点名文件:行；豁免标记 `// source-ok: <理由>` |
| `scripts/inspect-session-sources.mjs` | 会话日志取证：按帧解压 `.jsonl.zstd`，报告 header 代次 / 事件类型 / **每条 durable 消息的 source.kind** / 异常清单；只读、零依赖 |

两道防线互补：**闸门管写入方（源码），工具管已落盘的数据（日志）**。
注意闸门*抓不到*动态拼出的 kind、以及"消息完全没有 source"这类情形 —— 覆盖边界写在脚本头部。

## 7. 影响面与遗留

- **已有会话没有损坏**：v4 文件干净（本次全库实测）；旧代会话仍走各自的版本读取 / 迁移路径。
  丢的只是"那一轮"。
- **旧文件里的 1976 条 `kind:"plugin"` 是历史资产，不是缺陷**：v3 读取器与 v3→v4 迁移器认这个语法
  （`rewriteV3MessageSource` 会把它转成 producer kind）。**不要**去批量改历史文件。
- **遗留**：本次只排查了本机已装插件。其他机器 / 其他第三方插件（尤其 `@yeesy369/*` 之外的社区包）
  若也写消息，需各自核一遍 —— 这也是本闸门 `--installed` 分支存在的原因。

## 关联

- 仓库级闸门实现与用法：`scripts/check-message-sources.mjs` 头部
- 回归入口：[`scripts/verify-all.mjs`](../../scripts/verify-all.mjs) 的 `repo` 类别（3 项）
- 实机验收登记：[`../cross/smoke-test-matrix.md`](../cross/smoke-test-matrix.md) §3.0（G 组）
- 平台升级评估：[`dsh-0.1.7-rc2-upgrade-assessment-2026-09-25.md`](dsh-0.1.7-rc2-upgrade-assessment-2026-09-25.md)
