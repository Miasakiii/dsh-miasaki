# CHANGELOG — dsh-miasaki-appearance

本文件记录 `dsh-miasaki-appearance/` 线的设计决策与变更。

## 2026-09-11（晚）

- **修：整包加载失败 `module is not defined`（实机启动即暴露）**

  - **现象**：重启 `dsh web` 后浏览器报 `Failed to load plugins /
    failed to import loader entry 201b625b (@miasaki/dsh-appearance): module is not defined`，
    设置里「外观」栏完全不出现。

  - **根因**：`client.js` 的 factory 里写了 `module.exports.inject` / `module.exports.apply` /
    `return module.exports`，但**没有声明 `module`**。DSH 的客户端装载器只把 `require` 交给
    factory（契约见 `@deepseek-ai/dsh-client-modules` 的 `ClientBundleRegistration`：
    `factory: (require) => exports`），`module` 不是注入项 —— factory 一执行就
    `ReferenceError: module is not defined`，`__ModuleLoader__` 拿不到导出，整个 bundle 加载失败。
    canvas / sidebar / ssh / dual-model 四条线都在 factory 首行写了
    `const module = { exports: {} }`，本线建线时漏了这一行（同一范式的复制遗漏）。

  - **为何此前自检没拦住**：`node --check` 只做语法检查，`module.exports` 在 ESM 里语法合法；
    `pnpm run build` 与 `verify-all` 的 L0 同样只到语法层。这是**运行期**才暴露的错误。
    Host 半（`index.js` 及其 `lib/`）导入正常，故障面仅限浏览器侧。

  - **修法**：`client.js` factory 首行补 `const module = { exports: {} }`，并写明「装载器不注入
    `module`」的原因，防止后来者再删。

  - **回归闸门（新增 `test/client.test.js`，5 例）**：在 **VM 上下文里刻意不提供 `module`**，
    执行 `client.js` 后调 `factory(require)`，断言 ①装载器收到的 id 为 `@miasaki/dsh-appearance`；
    ②上下文里 `module === undefined`；③factory 返回对象且 `inject === ['slots']`、`apply` 是函数；
    ④`apply` 把「外观」注册进 `settings.section`（`id: appearance`、`order: 5`）；
    ⑤`apply` 幂等 + fiber 拆除复位 `__DSH_APPEARANCE_BOOTED__`（允许 HMR 重挂）；
    ⑥通信走同源 `/appearance/api/*`、不出现 `host.call`。
    这一条与 ssh 线 2026-09-10 的 `invalid plugin … received undefined` 属同一类事故，
    现在两条线都各有契约测试兜底。

  - **顺手核对**：`webserver/index-inject` 事件与 `IndexInjection` 行类型（`{kind:'script',
    placement:'body', text}` / `{kind:'style', text}`）在本机 0.1.5-rc.1 上逐字复核通过，
    Host 半的首帧注入写法无需修改；`settings.section` 的 `label` 经 `resolveSlotLabel` 解析
    （`typeof t === 'function' ? t() : t`），传字符串 `'外观'` 合法。

  - **验证**：`node --test test/*.test.js` → **34 例全绿**（原 29 + 新增 5）；
    `node ../scripts/verify-all.mjs appearance` → **9/9 PASS**（原 8 项 + client 契约 1 项）。

  - 触摸点：`dsh-miasaki-appearance/client.js`（补一行 + 注释）、
    `dsh-miasaki-appearance/test/client.test.js`（新增）、`README.md`（测试段）、
    `design/CHANGELOG.md`（本条）、`scripts/verify-all.mjs`（L0/L1 注释）、
    `dsh-miasaki-shared-docs/cross/smoke-test-matrix.md`（基线 8/8 → 9/9）。

## 2026-09-11

- **建线 + M1 底座落地（同日完成一次 M1 spike）**

  - **立项与方向**：用户提出「设置页加一栏『外观』页，可开关主题 / 设置壁纸 / 设置动效 / 会话效果」，
    并要求参考 `plolpl789/dsh-raw-html`、`feitangyuan/motion-web`、`yoli-mi/dsh-client-ui-custom` 三个仓库。
    完成规划后用户拍板三项：**D1 新开一条线**（而非并入 desktop / sidebar）、**D2 外观线统一接管主题**
    （desktop 注入层让位）、**D3 下沉 desktop 既有三主题**（而非重画）。
    完整规划（官方契约取证、三仓库取舍、R1–R10 风险、M1–M5 路线、D1–D10 抉择）见
    [规划设计与方向选型](2026-09-11-appearance-settings-plan.md)。

  - **M1 spike（只读探针，产物已删）**：源码逐份核对 + 运行期动态探针双路取证，**方案无需修改**。
    确证七项：① `overrideTokens` 接受任意 token 名（含 `--dsw-static-*`）且写入 body inline style
    → **D3 成立**；② 层按 `seq` 叠加、同 source 再调 = 替换整层并置顶、停用即整层回收 → **双 source 设计成立**；
    ③ 客户端 `settingsScope.bind()` 可用，读接口 `getSnapshot()`；④ `settings.describe()` 枚举全部
    15 个命名空间（第三方与官方并列）→ **无需白名单、零补丁**；⑤ 用户设置文档 = `~/.dsh/settings.yaml`；
    ⑥ `index-inject` 支持 `style`(head) 等 6 种行 → 首帧防闪烁有正解；
    ⑦ `ConversationRoot` 直读 `--dsw-alias-bg-base`（无中间层）→ D8 的补丁代价确认，
    但「会话最大宽度」有官方变量可用、**无需补丁**。
    两项顺延到实施期（动效重放、性能基线）——动态插件 Client 半**无 DOM 能力**。
    副产物：把动态探针的六条能力边界（受限 Builtin、服务访问规则、`overrideTokens` 的 source 被
    强制改写为包 ID、`fs` 被沙箱拒、取数走同源路由、**服务注册必须挂 `ctx.effect` 否则泄漏**）
    整理进规划文档 §9.1 —— 其中最后一条是本次真实踩到的坑（一条路由在插件删除后仍在响应）。

  - **M1 实现**：新线骨架 `index.js`（Host）+ `client.js`（浏览器）+ `lib/`（配置模型 / 持久化 / 围栏）
    + `test/`（29 例）+ `cordis.patch.yml`；profile 侧以 `link:` 依赖 + `bundles` 行 + junction 挂载，
    与其余四线同构。设置里新增 **「外观」栏**（`settings.section`，`id: appearance`，`order: 5`，
    紧跟官方「通用」）。M1 可用：明暗偏好与正文字号**直通官方 `ctx.theme`**
    （与官方「通用 → 外观」是同一个偏好，不是第二套状态）、总开关门控 `html[data-mia-appearance]`、
    契约自检（浏览器采事实 → Host 判定 → 面板黄条）、让位检测（`html[data-miasaki-theme]` 在位即提示）、
    配置读写闭环（`/appearance/api/state|config|contract`，按板块深合并 + `expectedRevision` 乐观并发）。
    实施细节与验收清单见 [M1 实施](2026-09-11-appearance-m1-design.md)。

  - **两条关键决策**（都写进了 README 与实施文档，避免后来者重走一遍）：
    ① **配置自管 JSON，不注册 settings 命名空间** —— `link:` 装载时 `@deepseek-ai/schemastery`
    不在模块查找链上（实测 `ERR_MODULE_NOT_FOUND`），引入依赖一旦解析失败会拖垮整个 profile 的加载；
    canvas / sidebar / dual-model 三条线同一约定。官方通道本身可用，迁移路径记在实施文档 §8。
    ② **主题将走 `overrideTokens` 而非 `ctx.theme.register`** —— 官方「外观」行是**硬编码的
    light/dark/system 三立方**（`AppearanceRow` 只渲染 `CUBES`、不读注册表），注册进去的皮肤既不会
    出现在官方 UI，用户点官方立方还会把它顶掉；改用叠加层后明暗仍归官方三值管理、皮肤自动适配两种色阶、
    且停用即回收。

  - **纪律与契约**：总开关**默认关闭**，「未配置时对页面零影响」「关掉即原生」是硬契约与验收项；
    动效与装饰只挂 `[data-slot="…"]` 稳定锚点 + 自有前缀，不依赖哈希类名；
    需要改官方源码的能力（如聊天列独立不透明度，D8）默认不做，确需时并入 desktop 线既有补丁链。

  - **测试**：`node --check` 五个文件全绿；单测 **29 例**（配置模型 16 / 围栏 6 / 持久化 7）；
    `node ../scripts/verify-all.mjs appearance` → **8/8 PASS**；`verify-all.mjs` 已从六线扩为七线入口。

  - **实机复验点**（需重启 `dsh web`）：设置里出现「外观」栏且位于「通用」之后；
    面板契约状态条显示通过或按实际降级项给黄条；切明暗时官方三立方同步、改字号时会话正文即时变化；
    总开关往返写入 `~/.dsh/miasaki-appearance/config.json`；双标签页可复现修订冲突；
    关掉总开关后页面与原生逐像素一致。

  - 触摸点：`dsh-miasaki-appearance/**`（新线）、`scripts/verify-all.mjs`（七线入口）、
    `README.md`（根，七线描述）、`AGENTS.md`（七线描述）、
    `dsh-miasaki-shared-docs/cross/smoke-test-matrix.md`（实机项）；
    profile 侧：`~/.dsh/profiles/web/package.json`（link 依赖 + bundles）与
    `~/.dsh/profiles/web/node_modules/@miasaki/dsh-appearance`（junction）。
