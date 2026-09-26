# `@yeesy369/dsh-browser-playwright` 0.1.7 兼容运行时补丁（host + client 两半）

> 2026-09-23。本机 DSH 升到 0.1.7-alpha.2 后，web UI 停在启动屏：
>
> ```
> HARNESS
> Failed to load plugins
> web boot: 1 entry did not activate
> @yeesy369/dsh-browser-playwright: pending (waiting for service: settingsScope)
> ```
>
> 根因是 0.1.7 重写设置机制，该插件两半各自踩雷（详见下文）。本补丁把两半都改成
> **双轨**（0.1.7 新路 / ≤0.1.6 老路），npm 上作者尚未发兼容版（0.8.1 仍是 latest）。
>
> **2026-09-26 二次复发（同一症状，不同成因）**：`miasaki` profile（`miasaki.exe` 桌面端
> 拉起的口径 `dsh --profile miasaki`）在重装依赖时冲掉了两半补丁，而 `patch.mjs` 当时
> **只探 `web` 一个 profile** ⇒ 补丁静默缺席，桌面端一开就停在上面那张启动屏。
> 处置：探测改为**遍历所有装了该插件的 profile**（`status`/`apply`/`revert`/
> `rebuild-baseline` 全覆盖，`--target-dir` 退化为单目标），并把本机 `web` / `miasaki`
> 两个 profile 都重打到位（无头 Edge 实载验证：启动屏消失，会话列表 / 插件入口 /
> SSH 胶囊 / 模型选择正常渲染）。npm `latest` 至今仍是 0.8.1。

## 症状与两级破坏

| 半 | 坏点 | 后果 |
|---|---|---|
| client（`lib/client.js`） | `inject = ["slots","locale","settingsScope"]`，而 `settingsScope` 服务在 0.1.7 被移除 | cordis 纤维永远 pending；**web 前端 boot loader 对任何非 active 的 client 条目直接抛错停启动屏**（host 侧同款审计只是 warning，见 `dsh-app-boot` 的 `auditStartupEntries`）——整个 web UI 打不开 |
| host（`lib/index.js`） | `settings.register(name, Config, …)` 没了（`settings` 服务还在，inject 过得去，但 API 变了） | `apply` 抛 `TypeError: settings.register is not a function`，provider 纤维失败，`ctx.browser` 永不 provide → `@yeesy369/dsh-tool-browser` 整条 pending（浏览器工具全灭） |

## 0.1.7 新机制（源码级实测结论）

- **配置即 profile entry 的 Cordis 配置**：设置值落到 profile patch（`~/.dsh/profiles/web/cordis.patch.yml`），
  旧 `settings.yaml` 一次性导入（`~/.dsh/settings.yaml.imported` 即其产物）。
- **可编辑字段**：插件 `Config` Schema 里标 `.volatile()` 的字段（`dsh-settings` 的 `describe()`
  只暴露这些；写路径 `mutate(ops)` → `configEditor.edit` → profile patch，拒绝返回 false）。
- **client 侧服务 `configForms`**：`ctx.configForms.get(NS)` 取某 entry 的共享表单 scope
  （快照 `{status,value,base,user,writable,revision}`，读接口与旧 settingsScope 一致）；
  写接口从 `set/unset` 两颗子弹变为批量 `mutate([{op,path}])`。
- **卡片槽迁移**：官方插件设置卡片统一挂 `plugins.item`（旧 `settings.plugin.item` 槽在
  0.1.7 已无声明方，只剩一条历史注释）；注册键 `key` → `id`，需补 `order`/`label`。
  卡片由 `dsh-client-ui-plugin-manager` 的侧栏「插件」面板渲染。
- **自带页策略**：`dsh-settings` README 规定——自带设置页的插件在**可选**
  `ctx.inject(['settings'], …)` 子 fiber 里 `configure({ auto: false }, ctx.fiber)`
  （服务缺失时子 fiber 挂起、业务插件照常运行）。
- **`.volatile()` 的坑**：profile 的 schemastery 是 3.18.1（无 `.volatile()` builder；
  dsh CLI 自带 3.18.4 才有）。但 `volatile()` 的实现就是 `extra('volatile', true)` →
  `meta.volatile = true`，**结构打标即可**，`dsh-settings` 读的是 `meta.volatile` 与
  `schema.dict`（均为跨副本兼容的普通属性）。

## 本补丁做了什么

### client 半（`lib/client.js`，五处锚点编辑）

1. inject 瘦身为 `["slots","locale"]`——设置服务不再列为父级必需，纤维必定 activate。
2. `apply()` 改**两条可选子 fiber 轨**：
   - `ctx.inject(['configForms'], child => …)`：0.1.7 路。`child.configForms.get('browser-playwright')`
     取 scope，按官方范式 `whileServed([NS], mount)` 等 Host serve 该 namespace 才挂卡、
     停止 serve 即卸卡。
   - `ctx.inject(['settingsScope'], child => …)`：≤0.1.6 路，直接挂卡。
   - `cardMounted` 模块级守卫防（假想的）双服务宿主双挂，子 fiber 拆卸时复位。
3. 写路径适配器 `writeSetting(scope, field, change)`：有 `scope.mutate` 走批量 ops
   （返回 false 判拒绝 → failed 置位），否则回退 `set/unset`。
4. `resetField` / `save()` 改走适配器；`save()` 串行写（mutate 带 revision 栅栏，
   并行会 stale-conflict）。
5. 挂卡槽 `settings.plugin.item` → `plugins.item`，`key` → `id`，补 `order: 50` / `label`。

> **为什么必须用可选子 fiber 而不是 try/catch 直读**：实测 cordis 语义——父级 fiber
> 访问未 inject 的服务**必然抛错**（`cannot get property "x" without inject`，accessor
> 检查），哪怕服务由祖先 fiber 提供；`ctx.get(name)` 同样拿不到。第一版补丁就死在这里：
> 冒烟桩复现不了这个语义，线上两轨全废、卡片静默不挂。`ctx.inject(names, factory)`
> 是 cordis 原生的可选依赖机制（服务缺失只挂起子 fiber），`dsh-settings` README 对
> host 侧也是这么规定的。

### host 半（`lib/index.js`，两处锚点编辑）

1. 模块级对 `windowVisibility` / `stealth` / `allowFakeIp` 三个字段结构打
   `meta.volatile = true`（`headless` 等保持普通配置）。
2. `apply()` 双轨：探到 `settings.register` 走老路（原样保留）；否则 0.1.7 路——
   直接以 entry config 起 `PlaywrightBrowserRuntime`（字段语义与旧 `base: config`
   一致），并在可选 `ctx.inject(['settings'], …)` 子 fiber 里 `configure({auto:false}, ctx.fiber)`
   避免官方自动页与自带卡片重复。

## 目录内容

| 文件 | 作用 |
|---|---|
| `patch.mjs` | 补丁规范：client 5 条 + host 2 条锚点编辑；CLI（verify / status / apply / revert / freeze / rebuild-baseline） |
| `baseline/client.original.js` | npm 0.8.1 官方原版 client bundle（12,933 B，SHA-256 `0DA733A8…`） |
| `baseline/index.original.js` | npm 0.8.1 官方原版 host bundle（15,691 B，SHA-256 `3FDFD5BB…`） |
| `baseline/client.patched.js` | 补丁后 client 产物全文（13.4 KB，小文件直接存全文） |
| `baseline/index.patched.js` | 补丁后 host 产物全文 |

## 用法

```bash
node patch.mjs verify            # 离线自检：两半重建 SHA 比对 + node --check + 双世界行为断言（27 项）
node patch.mjs status            # 两半当前状态（ORIGINAL / PATCHED / UNKNOWN）——默认遍历全部 profile
node patch.mjs apply --yes       # 备份 + 应用（幂等；已是当前版补丁则跳过；旧版补丁需 revert 或 --force）
node patch.mjs revert            # 从 .dsh-bak 还原
node patch.mjs rebuild-baseline  # 升级专用：以当前安装原版重建 baseline（先 revert）
```

**多 profile 语义（2026-09-26 起）**：`status` / `apply` / `revert` / `rebuild-baseline` 默认
遍历 `$DSH_HOME/profiles/*` 中**所有装了本插件**的 profile（本机：`miasaki` + `web`），逐个判态、
逐个打补丁，输出带 `== profile: <名> ==` 标题；`--target-dir <lib 目录>` 退化为只打单个目标，
`DSH_PROFILE_DIR` 在场时仍只认它（显式优先）。`verify` / `freeze` 是离线操作，与 profile 无关。

`verify` 的双世界冒烟按**真实 cordis 语义**建模：父级访问未 inject 服务抛错、
`ctx.inject` 仅在服务齐备时激活子 fiber、`whileServed` 的 serve/卸卡翻转、
`mutate` 拒绝路径、以及 host 半的 3.18.1 结构打标 + 可选子 fiber configure。

## 验证记录（2026-09-23，本机实测）

1. `node patch.mjs verify` → **VERIFY PASS**（27/27）。
2. 应用到 profile 后重启 `dsh web`：boot 日志干净（无 `did not activate`、无
   `settings.register` 报错、`tool-browser` 不再 pending）。
3. 无头 Chromium 实载 `http://127.0.0.1:3080`：启动屏消失，会话列表/设置/模型选择/SSH
   胶囊正常渲染；侧栏「插件」面板出现 `browser-playwright` 卡片，三个字段
   （窗口模式三选项 / 反检测 / fake-ip DNS）与保存/放弃按钮完整可交互。

## 代价与边界

- profile 的 `node_modules` 是安装产物，且 `lib/*.js` 与 pnpm store 是**硬链**（链接数 2）——
  `apply` 用「临时文件 + rename」换目录项，**不能就地截断写**（会污染 store 的同一 inode）；
  store 侧原版已核实未动（`0DA733A8…` 仍在）。
- 重装/升级该插件会冲掉补丁：先 `revert`（或删 `.dsh-bak` 后重打），再 `apply`；
  插件发新版本后先 `rebuild-baseline` 核对锚点。**任一个 profile 重装依赖后都要重跑一次
  `node patch.mjs apply --yes`**（默认覆盖全部 profile、幂等，已是当前版会直接跳过）；
  `node scripts/patch-live-audit.mjs` 逐半判 PATCHED / ORIGINAL，是这条纪律的兜底检查
  ——2026-09-26 的复发正是「审计判据正确、但没人跑」+「apply 只打 web」两头叠加。
- 只改这一个第三方包的安装产物，不动 DSH 本体、不动其他插件、不进 profile 配置。
- 备份文件：应用后在插件 lib 目录留 `client.js.dsh-bak` / `index.js.dsh-bak`。

## live 审计与沙箱注记（2026-09-24 三轮复审补）

- **已进审计范围**：`scripts/patch-live-audit.mjs` 的 `PATCH_ROOTS` 新增
  `dsh-miasaki-shared-docs/dsh-platform/patches`，本机输出由「7 个补丁」变为
  **9 个目标 / 8 件补丁**——本件两半各占一行（`…dsh-browser-playwright (client)` /
  `(host)`），逐半判 `patched` / `original`（=升级覆盖，web UI 会停在启动屏）/
  `unknown`；基线版本对得上却没打上即 🔴 退出码 1。之所以必须纳入：本件被打回原版
  的后果是**整个 web UI 打不开**，而离线 `verify` 恒 PASS，正是「离线全绿 + live 全
  unknown 并存」的经典盲区。
  **判据自证（实测）**：令假 profile 根的 `client.js` 为 baseline 原版 → 该行报
  `original … 回归！`、退出码 1，而 `host` 半仍 `patched`（两半独立判定）。
- **本文件为此补的两样**：① `import.meta.url` **CLI 守卫**——此前是八件补丁里唯一
  漏网的，被 import 时会以调用方 argv 误跑一次 CLI（argv 为空即打印用法并可能改写调用方
  `exitCode`）；② **`LIVE_TARGETS`** 导出（双半 ⇒ 多目标契约；`classify` 返回
  `{ state }`，与其余七件同形同词表）。
- **沙箱注记（环境假阴性）**：受限沙箱（`workspace-write`）禁止管道捕获子进程输出，
  `verify` 里的 `node --check` 会以 `spawn EPERM` 结束。旧版把它打印成「语法校验失败」
  （stderr 为空，极具误导），现改为 ⚠ 明说「未能执行 + 请在普通终端复核」，**不计 FAIL**。
  手工判据：把 `baseline/client.patched.js` 复制为 `.js`、`index.patched.js` 复制为
  `.mjs`，在 shell 层跑 `node --check`——2026-09-24 实测双双 exit 0。SHA 三层比对与
  双世界冒烟不受此影响。

## 相关

- 升级评估（本补丁的决策背景）：[`../dsh-0.1.7-upgrade-assessment-2026-09-23.md`](../dsh-0.1.7-upgrade-assessment-2026-09-23.md)
- 作者发兼容版后：删本目录、`revert`、pnpm 升级该插件即可。
