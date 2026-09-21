# DSH 升级评估：0.1.6-alpha.1（实测版）

> ⚠️ **本版结论已被取代**（2026-09-21）：本文实测的是 `0.1.6-alpha.1`，结论为「6 个本体补丁全部零改动」。
> 09-21 在 `0.1.6-alpha.2` 上重测，**`settings-models` 补丁的 `reasoning-ui` 锚点已失效**（官方重构了
> `ModelListEditor` 的容量字段渲染），升级成本不再是"纯机械"。
> 现行版本：[`dsh-0.1.6-upgrade-assessment-2026-09-21.md`](dsh-0.1.6-upgrade-assessment-2026-09-21.md)。

- 日期：2026-09-16
- 当前运行：`@deepseek-ai/dsh@0.1.5-rc.1`（= npm `latest`）
- 候选：`0.1.6-alpha.1`（`alpha` 轨）／`0.1.5-rc.2`（`next` 轨）
- 方法：**不是推演，是实测**——把 0.1.6 的真实 npm 产物拉下来，对全部 6 个本体补丁跑了一次真实的 `patch.mjs apply`
- 配套：`dsh-official-repo-review-2026-09-16.md`（0.1.6 变更清单与对七条线的影响）

---

## 0. 结论

**暂不升级，等 `0.1.6` 进入 `next`（rc）轨再升。**

一句话理由：**升级的技术阻力已实测为接近零，但收益同样接近于零，而 alpha 的稳定性未知**。实测出的"零阻力"结论不依赖 alpha 还是 rc——所以等几天再升，**成本完全不变，稳定性更好**。

---

## 1. 实测一：升级要花多大力气？—— 6 个补丁全部零改动

我们为桌面壳/双模型打了 6 个"DSH 本体补丁"（改动编译产物）。升级时它们必须能重新应用，这是**历史上升级的最大成本项**。

本次把 `0.1.6-alpha.1` 的真实产物从 npm 拉下来，逐个跑 `node patch.mjs apply --target <0.1.6产物> --yes`：

| 补丁 | 目标产物 | 0.1.5 基线 | 0.1.6 产物 | 结果 |
|---|---|---:|---:|---|
| `dsh-client-ui-chat` | `lib/client.js` | 370,078 B | 371,568 B (+1,490) | ✅ **锚点全命中** |
| `dsh-client-ui-conversation` | `lib/client.js` | 647,101 B | 648,197 B (+1,096) | ✅ **锚点全命中** |
| `dsh-client-ui-settings-models` | `lib/client.js` | 138,937 B | 139,668 B (+731) | ✅ **锚点全命中** |
| `dsh-client-ui-trajectory` | `lib/client.js` | 392,863 B | 413,065 B (**+20,202**) | ✅ **锚点全命中** |
| `dsh-cordis-host-runner` | `lib/index.js` | 104,811 B | 104,811 B (**±0**) | ✅ **锚点全命中**，且补丁后 SHA 与记录一致 ⇒ 该包**字节级未变** |
| `dsh-api-session-controller`（dual-model） | `lib/index.js` | 113,381 B | 113,326 B (−55) | ✅ **锚点全命中** |

**22 个锚点（仅 desktop 侧计）+ dual-model 全部命中，`EDITS` 一行都不用改。**

> 注意 `ui-trajectory` 产物涨了 20 KB（+5.1%）却仍全命中——说明变化发生在我们锚定区域之外。这正是"锚点唯一命中"设计的价值：**宁可失败也不瞎改**。

**升级时补丁侧的实际动作**（纯机械，有脚本）：
1. 升级 DSH；
2. 逐个跑 `node rebuild-baseline.mjs`（用新官方原版重建两份 baseline，并打印待同步的常量）；
3. 手动同步各补丁的 3 个常量（`BASELINE_DSH_VERSION` / `ORIGINAL_SHA256` / `PATCHED_SHA256`）；
4. `node patch.mjs verify` 自证 → `apply` 重新应用。

---

## 2. 实测二：我们会踩到哪些破坏性变更？—— 零命中

0.1.6 的破坏性变更清单（`agent/session-start` → `agent/created`、PTC 改名 `ptc-runtime`、`SandboxProvider.confine` / `ShellExecutor.start` 异步化、弃用 `snapshotEvents`/`eventAt`/`ownEvents` 等）**逐条对我们全部六条线做过 grep**：

| 线 | 命中 |
|---|---|
| canvas | 1 处（`index.js:348`，**防御性写法**：`typeof session.snapshotEvents === 'function' ? … : session.events`，且见下） |
| sidebar / ssh / dual-model / appearance / desktop | **0** |

关于那一处 `snapshotEvents`：`[实测]` 该接口在 0.1.6 中**仍存在**，且被官方自己的生产代码大量使用（`packages/session/**` 下 81 处命中，含 `session-title`、`session-projection`、`session-telemetry`）。release note 说的"弃用"是**面向插件作者的 API 政策**，不是移除。加之我们的写法本就有 `typeof` 守卫与 `?? []` 兜底，**不会崩**。

其余三项（插槽契约、persona 配置、host 服务）在配套文档 §6.1 已逐条源码级确认：

| 项 | 结论 |
|---|---|
| `sidebar.right.pane.tab` / `.title` / `settings.section` / `webserver/index-inject` / `conversation.session.header.*` | ✅ 全部未变 |
| `guide` 的 `title`/`description` 仍要求**函数** | ✅ 仍是（我们现有写法正确） |
| persona 配置字段 | ✅ 仍是 `prefix` + `suffix`（0.1.5 已适配，**零改动**） |
| 会话数据格式 | V3 已在 0.1.5 完成迁移，**无新增风险** |

---

## 3. 收益侧：0.1.6 为我们解决了什么？—— 基本没有

| 0.1.6 的能力 | 对我们的价值 |
|---|---|
| 官方 SSH 能力提供方 | **用不上**——它是服务层（`ctx.ssh`/`fs`/`subprocess`/`sandbox`），面向 headless/自定义组合；我们做的是 Web UI 终端。仅作为**未来演进方向**（UI 改消费 `ctx.ssh`）有价值 |
| 官方侧边栏终端 | **负价值**——与我们 sidebar 线的终端 tab 同 slot 重复，会多出一个入口 |
| Browser Use / Computer Use | 实验性，尚未看出与七条线的连接点 |
| 已归档会话列表、Headless 改进 | 与本仓工作无关 |
| DeepSeek V4.1 图片链路 / Files API | 只对 `dual-model` 线有意义，而该线**当前瓶颈是未验收**，不是缺这个 |

**关键**：七条线当前的真实瓶颈（见 `repo-review-2026-09-14.md`）是**实机验收未做**与治理层缺口，**没有一项能靠升级 DSH 解决**。

---

## 4. 成本侧

| 项 | 评估 |
|---|---|
| 补丁重打 | **已实测为零改动**，仅需机械流程（§1） |
| 代码适配 | **零**（§2） |
| alpha 稳定性 | **未知**——这是本次唯一实质风险 |
| 升级会中断当前会话 | 是（所有在跑的会话） |
| 升完还要再升一次 | 是——alpha → rc → latest，按历史节奏约 1–3 天 |
| 沙箱约束 | **升级必须在沙箱外执行**：npm 全局安装需写 `%APPDATA%\npm`，当前会话是 `workspace-write`，**做不到**（实测 `npm view` 即因 `EPERM` 写缓存失败，改用 `--cache` 重定向才通） |

---

## 5. 为什么不建议现在升 alpha

1. **等待成本几乎为零**：0.1.6 的锚点稳定性不取决于它是 alpha 还是 rc —— 现在实测零漂移，rc 阶段**只会更稳**（rc 相对 alpha 的代码变化通常小于 alpha 相对上一正式版）。
2. **要升两次**：现在升 alpha，等 rc/latest 出来还得再走一遍 §1 的流程。
3. **它会强推一个尚未拍板的决策**：官方终端一旦出现，sidebar 线终端 tab 的存废就必须面对——宜在正式版语境下决策。
4. **我们不等这个版本**：没有任何一条线卡在缺 0.1.6 的能力上。

---

## 6. 触发条件与建议

**升级触发条件**：`next` 轨出现 `0.1.6-rc.*`（历史上 alpha → rc 约 1–2 天）。

查一行即可（普通终端）：

```powershell
npm view @deepseek-ai/dsh dist-tags --json
```

> 若在**沙箱内的会话**里查，需加 `--cache <工作区内路径>`，否则会因写 `%APPDATA%\npm-cache` 被拒而报 `EPERM`（本次实测踩过，见 §4 末行）。

**当前（2026-09-16）**：`latest = 0.1.5-rc.1`、`next = 0.1.5-rc.2`、`alpha = 0.1.6-alpha.1` → **未触发**。

**另两个轨次的判断**：

- `0.1.5-rc.2`（现在的 `next`）：**风险极低但收益也极低**（只改了反馈提交体验与交付文件卡片排版）。**不值得为它单独升一次**。
- 直接等 `0.1.6` 转正：**最省事**，但可能要等更久。

---

## 7. 升级执行清单（备查，触发后照做）

**前置**

1. 确认所有在跑的会话已收尾（升级会中断它们）。
2. 备份：`~/.dsh`（复制成 `~/.dsh-backup-<版本>-<日期>`，沿用 0.1.5 那次的做法）。
3. **在沙箱外的普通终端执行**（当前沙箱模式做不到）。

**执行**

4. `npm i -g @deepseek-ai/dsh@<目标版本>` → `dsh --version` 核对。
5. 检查 `~/.dsh/settings.yaml` 与 profile 的三个 `link:` 插件（canvas / sidebar / ssh）是否仍有效。
6. 六条线逐条 `node scripts/verify-all.mjs <line>`。
7. 补丁：对 6 个补丁目录逐个 `node rebuild-baseline.mjs` → 同步常量 → `node patch.mjs verify` → `apply`。
8. 重跑 persona 同步脚本：`dsh-miasaki-desktop/preset-sources/apply-presets.ps1`（若该版 persona 字段有变；**本次实测未变**）。
9. 重启 `dsh web`，按 `cross/smoke-test-matrix.md` 走 L2/L3。

**回退**

10. `npm i -g @deepseek-ai/dsh@0.1.5-rc.1` + 还原 `~/.dsh` 备份。
    ⚠️ **会话数据不可降级**：0.1.5 已把会话升到 V3，升级后新建的会话无法被旧版读取（历史会话文件保留）。

---

## 附：本次实测的复现方法

```powershell
# 1) 让 npm 能在沙箱内工作（缓存重定向到工作区，工作区外不可写）
$cache = "$PWD\vendor\.npm-cache-probe"

# 2) 拉取目标版本的编译产物
npm pack "@deepseek-ai/dsh-client-ui-chat@0.1.6-alpha.1" --cache $cache --pack-destination vendor\_probe-016
# …对其余 5 个包重复（见 §1 表格的包名）

# 3) 解包 → 复制一份副本（apply 会改写目标）
tar -xzf <pkg>.tgz -C vendor\_probe-016\<pkg>

# 4) 对副本跑真实 apply —— 锚点缺失/不唯一会抛错并指名道姓
cd dsh-miasaki-desktop\patches\<补丁名>
node patch.mjs apply --target <副本绝对路径> --yes
```

清理：`vendor\_probe-016` 与 `vendor\.npm-cache-probe` 用完即删（本次已删）。
