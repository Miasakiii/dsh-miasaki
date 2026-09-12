# M1 实施：底座、配置模型与契约自检

- 日期：2026-09-11
- 状态：**已实现，待实机验证**（重启 `dsh web` 后设置里应出现「外观」栏）
- 上游：[规划设计与方向选型](2026-09-11-appearance-settings-plan.md)（官方契约取证、三仓库取舍、风险清单、D1–D10 抉择、M1 spike 结论）
- 目标（源自规划 §6）：新线骨架 + `appearance` 配置命名空间 + 设置页空壳 + 首帧防闪烁 + 契约探针

---

## 1. 分层与文件职责

```
浏览器                                     Host（DSH web 进程）
┌──────────────────────────────┐          ┌────────────────────────────────────┐
│ client.js                    │  fetch   │ index.js                           │
│  · settings.section 注册      │ ───────▶ │  · /appearance/api/state           │
│  · 面板 UI（M1 骨架）         │          │  · /appearance/api/config          │
│  · 契约事实采集（probe）      │          │  · /appearance/api/contract        │
│  · 应用管线（门控属性）        │          │  · webserver/index-inject 首帧注入 │
│  · 明暗/字号 → 官方 ctx.theme │          └──────────────┬─────────────────────┘
└──────────────────────────────┘                          │ import
                                                          ▼
                                          lib/config.js  纯逻辑（默认值/钳制/合并/迁移/
                                                         首帧脚本/契约判定）← test/ 覆盖
                                          lib/store.js   config.json 原子写
                                          lib/fence.js   Host/Origin 围栏
```

**为什么判定逻辑在 Host**：client bundle 由 `window.__ModuleLoader__.load` 装载，**不能 import**
（只能 `require('react')`）。所以浏览器只负责「采集事实」，归一化与判定一律走 `lib/config.js`，
这段因此可被单测直接覆盖。

## 2. 对外接口

### 2.1 插槽

```js
ctx.slots.inject('settings.section', () => ctx.slots.register(
  { name: 'settings.section', id: 'appearance', order: 5, label: '外观' },
  AppearancePanel,
))
```

`order: 5` 落在官方「通用」(0) 与「模型」(10) 之间。**两段式注册是硬要求**：0.1.5 实测直接
`register` 会抛 `slot "…" is not declared`。

### 2.2 HTTP API（前缀 `/appearance/api/`）

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/state` | 读配置 → `{ config, revision, persistent }` |
| POST | `/config` | 写配置 → body `{ patch, expectedRevision? }`；**按板块深合并**；修订不符返回 `409 revision-conflict` 并回带当前状态 |
| POST | `/contract` | 提交浏览器侧探针 → `{ ok, issues, revision }` |

全部请求先过 `fenceCheck`：Host 头须为环回或 `trustedHosts` 成员、`sec-fetch-site: cross-site` 拒绝、
Origin 存在时其 hostname 必须等于 Host。

**乐观并发**：`revision` 每次实质变更 +1；面板提交时带上读到的修订，冲突即拉取最新值并提示重试
（面板的重复提交是常态，`configEquals` 判定「无实质变化」时不写盘、不递增修订）。

### 2.3 首帧注入

```js
ctx.on('webserver/index-inject', (table) => {
  table.push({ kind: 'script', placement: 'body', text: buildBootScript(current) })
  const style = buildBootStyle(current)          // M1 恒为空串；M2 起放皮肤色阶
  if (style !== '') table.push({ kind: 'style', text: style })
})
```

注入位置由 `dsh-host-webserver` 决定：`body` 行紧跟开 body 标签、在 shell 挂载之前 ——
与官方 `ui-theme` 的 `bootThemeInjection` 同理，用来消除「先原生后外观」的闪色。
M1 的脚本只写三个属性（`data-mia-appearance` / `data-mia-skin` / `data-mia-scheme`），
且自带 `try/catch`（首帧脚本绝不允许抛错）。

## 3. 配置模型

出厂配置（`lib/config.js` 的 `DEFAULT_CONFIG`）——**总开关默认 `false`**：

| 板块 | 字段 | 类型 / 范围 | 默认 |
|---|---|---|---|
| — | `version` | 整数（当前 1） | 1 |
| — | `enabled` | 布尔 | **false** |
| `theme` | `skin` | `pure` / `zafkiel` / `kurkuriel` | `pure` |
| | `scheme` | `light` / `dark` / `system` | `system` |
| | `accent` | `#rgb` / `#rrggbb` / 空 | `''` |
| | `fontSize` | 12–17 整数 | 14 |
| `wallpaper` | `source` | 空 / `builtin:<id>` / 同源 `/…` / `http(s)://…` | `''` |
| | `blur` | 0–60 | 0 |
| | `scrim` | 0–100 | 0 |
| `motion` | `enabled` | 布尔 | false |
| | `preset` | `fluid` / `elegant` / `minimal` | `fluid` |
| | `scale` | 0.5–1.5 | 1 |
| `conversation` | `density` | `comfortable` / `compact` | `comfortable` |
| | `maxWidth` | 0–1600（0 = 官方默认） | 0 |

纪律：磁盘内容与浏览器发来的 JSON **一律视为不可信输入**；未知字段丢弃、非法值回退默认、
字符串字段有长度上限。`migrateConfig` 是版本迁移骨架（新增版本时串一条分支，
保证「旧配置 + 新字段」不留空洞）。

## 4. 契约自检

浏览器采集这些事实（`collectProbe`）：`ctx.get('theme')` / `slots` 是否存在、主题服务的四个方法、
`[data-slot="main"]` 锚点、两个代表性 token 是否可读、桌面壳注入层是否在位。
Host 侧 `evaluateContract(probe)` 判定：

| 级别 | 触发 | 面板行为 |
|---|---|---|
| `error` | 主题/插槽服务缺失、`getTheme`/`setTheme`/`setFontSize`/`overrideTokens` 缺失 | 显示黄条并说明「DSH 可能已升级」，不崩溃 |
| `warn` | 中栏锚点缺失、别名/静态 token 不可读、桌面壳主题在位（让位提示） | 显示黄条，功能降级但不报错 |

设计意图：DSH 升级导致契约漂移时，用户看到的是**一句人话**，而不是一个失效的控件或一片空白。

## 5. 关键决策

1. **配置自管 JSON，不注册 settings 命名空间** —— `link:` 装载时 `@deepseek-ai/schemastery`
   不在模块查找链上（实测 `ERR_MODULE_NOT_FOUND`）；引入依赖会拖垮整个 profile 的加载。
   与 canvas / sidebar / dual-model 同一约定。
2. **主题将走 `overrideTokens` 而非 `register`** —— 官方「外观」行是硬编码的三立方，不读注册表
   （详见规划 §2.2）；M1 只落地门控属性，皮肤在 M2。
3. **明暗与字号直通官方 API** —— 本线是官方偏好的**第二个入口**，不是另一个偏好仓库：
   面板显示值一律从 `ctx.theme.getTheme()` 读，用户改动即调用官方写入口，不做本地覆盖。
4. **面板不推回存下来的 scheme/fontSize** —— 避免「打开面板就把用户偏好改掉」的副作用。

## 6. 与既有线的接口

| 相对方 | 协议 |
|---|---|
| desktop 主题引擎 | 当前只做检测（`html[data-miasaki-theme]` 在位即黄条提示）；M2 起按规划 §7 的让位协议执行 |
| canvas / sidebar / ssh / dual-model | 本线只占 `settings.section` 的一个新 id，不动任何 `conversation.*` / `sidebar.*` 插槽；z-index 与动效纪律在 M3 生效 |
| 官方 ui-theme | 不写 `body[data-ds-dark-theme]`、不注册主题、不搬动官方 General 页的两行 |

## 7. 验收

### 已通过（本机静态）

- `node --check` 五个文件全绿；
- 单测 **29 例全绿**（配置 16 / 围栏 6 / 持久化 7）；
- `node ../scripts/verify-all.mjs appearance` → **8/8 PASS**。

> **2026-09-11（晚）补充**：M1 首次实机启动失败 —— client 半 factory 用了 `module.exports`
> 却没声明 `module`（装载器只注入 `require`），报 `module is not defined`，设置栏不出现。
> 已修并新增 `test/client.test.js`（5 例）钉死该装载契约；当时基线为**单测 34 例全绿 /
> `appearance` 9/9**。原因、修法与回归闸门见 [变更记录](CHANGELOG.md) 同日条目。
>
> **2026-09-12 补充**：M1 实机验证**六项全部通过**（过程修复两处实机 bug：路由前缀尾随
> 斜杠致 API 全 404、`runtime.theme` apply 期快照致明暗/字号永 disabled；新增
> `test/host.test.js` 4 例）→ 当前基线**单测 38 例全绿 / `appearance` 10/10**。
> 逐项结论与根因见 [变更记录](CHANGELOG.md) 同日条目。

### 实机项（需重启 `dsh web` 后执行）

1. 设置里出现「外观」栏，位置在「通用」之后、「模型」之前；
2. 打开面板：契约状态条显示「通过」（或按实际降级项给出黄条）；
3. 切换明暗：官方「通用 → 外观」的三立方同步变化；改字号：会话正文即时变化；
4. **开关往返**：打开总开关 → `html[data-mia-appearance="on"]`；关闭 → `"off"`；配置写入
   `~/.dsh/miasaki-appearance/config.json`；
5. **修订冲突**：开两个标签页，A 改一次、B 用旧修订提交 → B 看到「配置已被其它窗口修改」提示；
6. **关掉即原生**：总开关关闭时（或临时移出 profile roster 重启后）页面与原生逐像素一致。

## 8. 后续可选升级

**迁移到官方 settings 命名空间**（非必须）：若将来希望配置进 `~/.dsh/settings.yaml`
（可手改、可被 `settings.describe()` 列举、享官方修订与 schema 校验），路径是：

1. 在本线目录装 `@deepseek-ai/schemastery`（像 ssh 线自带 `node_modules` 那样），
   在 `package.json` 声明依赖；
2. `index.js` 改为 `ctx.inject(['settings'], (c) => c.settings.register('appearance', Schema, { base }))`，
   路由保留（浏览器仍需读写通道）；
3. 或客户端直接 `ctx.settingsScope.bind({ namespace: 'appearance' })`（**已实测可用**，
   读接口 `getSnapshot()` → `{ status, value, base, user, revision, writable, mode }`），
   此时 `/config` 路由可退役。

风险：依赖解析失败会拖垮 profile 加载（这正是当前不做的原因），因此升级前必须先验证解析。
