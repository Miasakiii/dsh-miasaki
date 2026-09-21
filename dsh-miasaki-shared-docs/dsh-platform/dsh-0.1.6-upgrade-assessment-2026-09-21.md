# DSH 升级评估（更新版）：0.1.6-alpha.2（实测）

- 日期：2026-09-21
- 当前运行：`@deepseek-ai/dsh@0.1.5-rc.1`
- 候选：`0.1.6-alpha.2`（`alpha` 轨）／`0.1.5-rc.2`（**`next` 与 `latest` 双轨**）
- 上一版：[`dsh-0.1.6-upgrade-assessment-2026-09-16.md`](dsh-0.1.6-upgrade-assessment-2026-09-16.md)（09-16，alpha.1 实测）
- 配套：[`dsh-official-repo-review-2026-09-21.md`](dsh-official-repo-review-2026-09-21.md)（alpha.2 变更清单 + 五条线 slot 逐项核对）
- 方法：**与上一版同法**——把目标版本的**真实 npm 产物**拉下来，对全部 6 个本体补丁逐个跑真实的 `patch.mjs apply --target … --yes`

---

## 0. 结论

**仍然不建议现在升级，触发条件不变。但成本侧出现了第一个实质变化。**

| 项 | 09-16（alpha.1） | **09-21（alpha.2）** |
|---|---|---|
| 6 个补丁重打 | **全部零改动** | **5 个零改动，1 个（`settings-models`）锚点失效，需要真正的适配** |
| 代码适配（slot / 事件） | 零 | **零**（① 文档 §4/§6 逐项确认） |
| 补丁自身健康（离线 verify） | 未记录 | **6/6 PASS** |
| 结论 | 暂不升，等 `next` 轨出 `0.1.6-rc.*` | **同上**——成本从"纯机械"变成"一次中等适配"，收益仍是零，等待的理由更强了 |

一句话：**升级的技术阻力第一次不为零**。这不改变"现在不升"的结论，但改变了"升级是纯机械流程"的预期——
**升级前必须先完成 `settings-models` 的适配**，否则那一个补丁打不上去。

---

## 1. 实测一：6 个补丁在 alpha.2 真实产物上的 apply 结果

命令形态（每个补丁一次，目标是一份**副本**，不改动解包原件）：

```powershell
cd dsh-miasaki-desktop\patches\<补丁名>
node patch.mjs apply --target <alpha.2 产物副本的绝对路径> --yes
```

| 补丁 | 目标产物 | 0.1.5-rc.1 基线 | alpha.1（09-16 实测） | **alpha.2** | **alpha.2 结果** |
|---|---|---:|---:|---:|---|
| `dsh-client-ui-chat` | `lib/client.js` | 370,078 B | 371,568 (+1,490) | **372,178** | ✅ **锚点全命中** → 374,042 B |
| `dsh-client-ui-conversation` | `lib/client.js` | 647,101 B | 648,197 (+1,096) | **654,901** | ✅ **锚点全命中** → 655,026 B (+125) |
| `dsh-client-ui-settings-models` | `lib/client.js` | 138,937 B | 139,668 (+731) | **140,442** | ❌ **锚点失效**（详见 §2），产物未被改动 |
| `dsh-client-ui-trajectory` | `lib/client.js` | 392,863 B | 413,065 (+20,202) | **418,238** | ✅ **锚点全命中** → 420,102 B (+1,864) |
| `dsh-cordis-host-runner` | `lib/index.js` | 104,811 B | 104,811 (±0) | **104,567** | ✅ **锚点全命中** → 105,324 B (+757) |
| `dsh-api-session-controller`（dual-model） | `lib/index.js` | 113,381 B | 113,326 (−55) | **112,593** | ✅ **锚点全命中** → 113,338 B (+745) |

> `ui-trajectory` 在 alpha.1 时涨了 20 KB 仍全命中，alpha.2 又涨到 418,238 B（较基线 +25,375 B / +6.5%）
> ——**变化仍全部落在锚定区域之外**。锚点唯一命中设计继续有效。

---

## 2. `settings-models` 失效的精确解剖 `[实测]`

### 2.1 报错

```
[patch] 失败：锚点必须唯一：editCapacity(index, "maxTokens", event.target.value);（命中 0 次）
```

### 2.2 7 条编辑逐条命中情况

| # | 编辑 id | alpha.2 命中 | 说明 |
|---|---|---|---|
| 1 | `reasoning-helpers` | ✅ 1 | 注入 reasoning/探测辅助函数 |
| 2 | `test-state` | ✅ 1 | 注入 `testing` / `testResults` state |
| 3 | `test-model` | ✅ 1 | 注入 `testModel()` |
| 4 | `reindex-test-state` | ✅ 1 | 删除行时重排测试态 |
| 5 | **`reasoning-ui`** | ❌ **0** | **失效项**：思考强度选择器 + 连通性测试按钮的 UI 插入 |
| 6 | `locale-en` | ✅ 1 | 英文词条（22 条） |
| 7 | `locale-zh` | ✅ 1 | 中文词条（22 条） |

**7 条里 6 条零改动，只有第 5 条失效。**

### 2.3 根因：官方把模型行的容量字段从「内联 JSX」重构成「组件 props 对象」

`[实测]` 源码级对比（`packages/client/ui-settings-models/src/client/ModelListEditor.tsx`）：

**alpha.1**（`:420`, `:433`）——内联 JSX，回调直接吃事件对象：

```tsx
onChange={(event) => { editCapacity(index, 'contextWindow', event.target.value) }}
...
onChange={(event) => { editCapacity(index, 'maxTokens', event.target.value) }}
```

**alpha.2**（`:360-369`）——变成 `<ModelRow>` 的**结构化 props**，回调改吃文本值：

```tsx
contextWindow={{
  value: capacityText(model, index, 'contextWindow'),
  placeholder: CAPACITY_HINT.contextWindow,
  onChange: (text) => { editCapacity(index, 'contextWindow', text) },
}}
maxTokens={{
  value: capacityText(model, index, 'maxTokens'),
  placeholder: CAPACITY_HINT.maxTokens,
  onChange: (text) => { editCapacity(index, 'maxTokens', text) },
}}
onFieldChange={...} onChange={...} onToggle={...} onRemove={...}
```

产物侧同样可见（alpha.2 `client.js` 第 771-790 行）：
`editCapacity(index, "contextWindow", text);` / `editCapacity(index, "maxTokens", text);`，
而**旧锚点文本 `event.target.value` 已不存在**。

### 2.4 适配要做什么（**不是改一行**）

第 5 条编辑的原始意图是：**在 maxTokens 输入框之后，插入一个「思考强度」选择器 + 一个「测试连通性」按钮**。
它用的是 `mode: 'insertAfterOffset'`，锚点 +2 行、并额外断言该行是 `})]`：

```js
{ id: 'reasoning-ui', mode: 'insertAfterOffset',
  anchor: 'editCapacity(index, "maxTokens", event.target.value);',
  offset: 2, expect: '})]', … }
```

alpha.2 里这两处**同时不成立**：

| 断言 | alpha.1 | alpha.2 |
|---|---|---|
| `anchor` | `editCapacity(index, "maxTokens", event.target.value);` | `editCapacity(index, "maxTokens", text);`（第 782 行） |
| `anchor + offset(2)` 行的内容 | `})]`（内联 JSX 的闭合） | **`},`**（一个对象字面量的属性闭合），`+1` 是 `}`、`+3` 是 `onFieldChange: (field, value) => {` |

**结论**：原来的插入位置——"JSX 字段元素之后的兄弟节点位置"——在 alpha.2 里**没有等价物**。
那里现在是 ModelRow 的 props 对象，不是 JSX children。

**因此这一条必须重新设计插入点，而不是替换锚点文本**。实施时至少要先回答：

1. 思考强度选择器要不要走 `ModelRow` 的 props（需要先确认 `ModelRow` 的 props 契约是否接受额外字段 / 是否透传）；
2. 若不改 `ModelRow` 契约，就要改它**内部**渲染容量字段的那一层
   （`[实测]` 产物第 248 行附近：`["contextWindow","maxTokens"].map((field) => …)`），
   在同一层插入第三个控件；
3. 无论哪条路，`expect` 断言的语义要重新写死（这是"宁可失败也不瞎改"的护栏，不能省）。

**工作量预估** `[推断]`：**约 1–2 小时**（读新结构 → 定新插入点 → 改 `EDITS` → `rebuild` → `verify` → 补一条行为断言）。
其余 6 条编辑与 locale 词条**完全不动**。

> 附带一句：这正是 09-19 那次事故留下的护栏在起作用——`insertAfterOffset` 会额外断言目标行内容，
> 所以官方改结构时它**报错而不是插错层级**。若当初只用 `insertAfter`，这次会静默把 JSX 插进一个对象字面量里，
> 产物语法直接坏掉，且症状是"整份 client bundle 不注册"。

---

## 3. 实测二：离线 `verify` —— 6/6 PASS（补丁自身健康）

对全部 6 个补丁跑 `node patch.mjs verify`（纯离线，不碰安装目录）：

| 补丁 | 结果 | 编辑条数 | 重建产物 SHA-256（前 16 位） | 附加断言 |
|---|---|---:|---|---|
| `dsh-client-ui-chat` | ✅ PASS | 2 | `BE4C68D5247CA75C…` | 恢复逻辑行为断言 8/8 + `node --check` |
| `dsh-client-ui-conversation` | ✅ PASS | 1 | `D9A841DE123218E7…` | — |
| `dsh-client-ui-settings-models` | ✅ PASS | 7 | `F1717A078C13A3A9…` | 语法闸门（`vm.Script`）+ `PATCHED_SHA256` 常量自洽 |
| `dsh-client-ui-trajectory` | ✅ PASS | 2 | `C3485ADFC25E6F32…` | 恢复逻辑行为断言 8/8 + `node --check` |
| `dsh-cordis-host-runner` | ✅ PASS | 4 | `8B81500ABA7BA403…` | 拒绝应答 / 超时兜底两组行为断言（含区分力验证） |
| `dsh-api-session-controller` | ✅ PASS | 1 | `58574E8A9BA2C314…` | — |

**意义**：这 6 个补丁**在 0.1.5-rc.1 基线上依然完全健康**——§2 的失效是"官方改了"，不是"我们坏了"。
升级前的适配工作因此是**增量改写**，不是排障。

---

## 4. 实测三：`0.1.5-rc.2`（当前 `latest`）也试了一次

`latest` 已从 `0.1.5-rc.1` 抬到 `0.1.5-rc.2`（① 文档 §1）。rc.2 的真实源码改动里**只有 `ui-chat` 有我们的补丁**
（另两个真实改动包 `ui-deliverables` / `ui-message-feedback` / `ui-primitives` 我们没有补丁）。

| 补丁 | rc.2 产物 | 结果 |
|---|---:|---|
| `dsh-client-ui-chat` | 370,093 B（基线 370,078，**+15 B**） | ✅ **锚点全命中** → 371,957 B |

**结论**：**升到 `0.1.5-rc.2` 对补丁是零阻力**（仍需走一遍 `rebuild-baseline` 同步 SHA 常量，但 `EDITS` 一行不用改）。
其余 5 个补丁的目标包在 rc.2 里**只有 `package.json` 跟版**，源码未被触碰。

---

## 5. 破坏性变更命中：**零**（详见配套 ① 文档）

| 维度 | 结论 |
|---|---|
| 五条 web 线的 13 个注册点 | ✅ **零命中**——alpha.2 的 663 个 client 文件改动没动到我们任何一个槽（① 文档 §4） |
| 六条线用到的 10 个事件 | ✅ alpha.1 与 alpha.2 签名**逐字全等**；0.1.5 → alpha.2 只有 `agent/created` 的 payload 扩展（我们只读 `payload.agent`）（① 文档 §6） |
| 会话数据格式 | V3 已在 0.1.5 完成迁移，**无新增风险** |
| persona 配置字段 | 仍是 `prefix` + `suffix`，**零改动** |
| `snapshotEvents` 弃用 | `[实测]` 该接口在 0.1.6 中**仍存在**（09-16 已核），我们本就有 `typeof` 守卫 |

---

## 6. 收益侧：仍然是零

| 0.1.6 的能力 | 对我们的价值 |
|---|---|
| 官方插件管理页（`ui-plugin-manager`） | 与我们"profile `file:` 安装 + 重启生效"的流程**不同路**；且 release note 明确要求插件作者自查"运行时依赖解析 + 运行时卸载"，**是新增的待办而非收益** |
| 官方侧边栏终端 | **负价值**——与我们 sidebar 线的终端 tab 同 kind，当前**被我们遮蔽**（① 文档 §5） |
| 官方侧边栏浏览器 / Office 预览 / Subagent 会话 / 交付文件审阅 | 与我们 sidebar / ssh 线的卖地**重叠**，属竞争面 |
| 官方 SSH 能力提供方 | 仍是服务层无 UI，仅作为**未来演进方向**（UI 改消费 `ctx.ssh`）有价值 |
| 0.1.5-rc.2 的 backport（反馈 / 交付文件 / 文件类型图标） | 与本仓工作无关 |

**关键判断未变**：七条线当前的真实瓶颈是**实机验收未做**与治理层缺口，**没有一项能靠升级 DSH 解决**。

---

## 7. 成本侧（更新）

| 项 | 评估 |
|---|---|
| 补丁重打 | **5 个零改动；1 个（`settings-models`）需重新设计 1 条编辑的插入点**（§2.4，约 1–2 小时） |
| 代码适配 | **零**（§5） |
| alpha 稳定性 | 未知——仍是唯一实质风险 |
| 升级会中断当前会话 | 是 |
| 升完还要再升一次 | 是——alpha → rc → latest |
| 沙箱约束 | **升级必须在沙箱外执行**：npm 全局安装需写 `%APPDATA%\npm`；沙箱内 `npm view`/`npm pack` 需 `--cache` 重定向到工作区才能工作（本次实测沿用此法） |

---

## 8. 触发条件与建议

**升级触发条件（不变）**：`next` 轨出现 `0.1.6-rc.*`。

```powershell
npm view @deepseek-ai/dsh dist-tags --json
# 沙箱内的会话需加 --cache <工作区内路径>
```

**当前（2026-09-21）**：`latest = 0.1.5-rc.2`、`next = 0.1.5-rc.2`、`alpha = 0.1.6-alpha.2` → **未触发**。

**另两条轨次**：

- `0.1.5-rc.2`（现在的 `latest`）：**补丁零阻力**（§4），但**收益也确实为零**（① 文档 §2：只改了 6 个包）。
  作为"顺手抬一格"可以，**不值得为它单独安排一次升级**。
- `0.1.6-alpha.2`：**不建议现在升**——alpha 轨 + `settings-models` 适配未做 + `sidebar`/`ssh` 两线的方向决策未拍板。

**建议动作（本次唯一建议立刻做的）**：

1. ~~给 `settings-models` 补丁做适配~~ → **先登记，不急做**（§9 已把它写成升级清单的第 7 步）。
2. **给 sidebar 线的两个 tab 类型补显式 `priority: 'extension'`**（① 文档 §5 建议 1）——一行改动、零行为变化。

---

## 9. 升级执行清单（更新版，触发后照做）

**前置**

1. 确认所有在跑的会话已收尾（升级会中断它们）。
2. 备份 `~/.dsh`（复制成 `~/.dsh-backup-<版本>-<日期>`）。
3. **在沙箱外的普通终端执行**。

**执行**

4. `npm i -g @deepseek-ai/dsh@<目标版本>` → `dsh --version` 核对。
5. 检查 `~/.dsh/settings.yaml` 与 profile 的三个 `link:` 插件（canvas / sidebar / ssh）是否仍有效。
6. 七条线逐条 `node scripts/verify-all.mjs <line>`。
7. **补丁——本轮唯一新增的步骤**：
   - 对 **5 个零改动**补丁：`node rebuild-baseline.mjs` → 同步 3 个常量 → `node patch.mjs verify` → `apply`；
   - 对 **`settings-models`**：
     a. 先读新版 `ModelListEditor.tsx` 的 `ModelRow` props 契约；
     b. 重新设计 `reasoning-ui` 的插入点与 `expect` 断言（§2.4 三条路线）；
     c. 改 `EDITS` → `node patch.mjs rebuild` → `verify` → 同步 `PATCHED_SHA256`；
     d. `apply`；
     e. **刷新页面确认「思考强度」与「测试连通性」两个控件真的在**（这一条最容易被漏——产物合法不等于 UI 在位）。
8. 重跑 persona 同步脚本 `dsh-miasaki-desktop/preset-sources/apply-presets.ps1`（**本次实测该字段未变**）。
9. 重启 `dsh web`，按 `cross/smoke-test-matrix.md` 走 L2/L3。
10. **升到 0.1.6 后新增的观察项**：官方侧边栏终端被我们的 `kind: 'terminal'` 遮蔽，
    但它的 `TerminalRecovery`（会话头）与 `TerminalCleanup`（`shell.overlay`）**仍会注册**——
    确认这两处不会出现"点不到的恢复按钮"或"空浮层"。

**回退**

11. `npm i -g @deepseek-ai/dsh@0.1.5-rc.1` + 还原 `~/.dsh` 备份。
    ⚠️ **会话数据不可降级**：0.1.5 已把会话升到 V3，升级后新建的会话无法被旧版读取（历史会话文件保留）。

---

## 附：本次实测的复现方法

```powershell
# 1) 让 npm 能在沙箱内工作（缓存重定向到工作区，工作区外不可写）
$cache = "$PWD\vendor\.npm-cache-probe"
$dest  = "$PWD\vendor\_probe\pkgs"

# 2) 拉取目标版本的编译产物（6 个包，见 §1 表格）
npm pack "@deepseek-ai/dsh-client-ui-chat@0.1.6-alpha.2" --cache $cache --pack-destination $dest
# …其余 5 个：dsh-client-ui-conversation / dsh-client-ui-settings-models /
#             dsh-client-ui-trajectory / dsh-cordis-host-runner / dsh-api-session-controller

# 3) 解包 → 复制一份副本（apply 会改写目标）
tar -xzf <pkg>.tgz -C vendor\_probe\unpacked\<pkg>
Copy-Item <解包路径>\package\lib\client.js <副本路径>

# 4) 对副本跑真实 apply —— 锚点缺失/不唯一会抛错并指名道姓
cd dsh-miasaki-desktop\patches\<补丁名>
node patch.mjs apply --target <副本绝对路径> --yes

# 5) 补丁自身健康（离线，不碰安装目录）
node patch.mjs verify
```

**本轮探针产物**（均在 git-ignored 的 `vendor/` 内，**已清理**）：
`vendor/_probe-0162/`（alpha.2 zipball、解包产物、tgz）与 `vendor/.npm-cache-probe/`。

**唯一保留的产物**是 alpha.1 旧快照 `vendor/deepseek-harness-0.1.6-alpha.1/`（11,229 文件 / 87.8 MB）——
它已从探针目录提升为与主快照并列的一等目录，是「新旧并排逐字节 diff」这一方法的前提（① 文档 §8 P2）。
