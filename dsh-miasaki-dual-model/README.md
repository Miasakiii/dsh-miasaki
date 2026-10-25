# @miasaki/dsh-dual-model — 双模型

> DSH（DeepSeek Harness）插件：会话级「**主模型 + 辅助模型**」——
> 只要其中一个支持图片，你就能往会话里发图。

配置入口在**输入框右下角**（`conversation.input.right`）：折叠态显示「主 ▸ 辅」两个短名，点开选模型。

## 它解决什么

DSH 里图片能不能发，取决于**当前模型**是否支持视觉。于是常见情形是：
主力模型推理强但看不了图，而看得图的模型你又不想全程用它。

双模型的解法：**会话里同时挂两个模型**——

- 纯文本对话走**主模型**（保持你原有的选择）；
- 一旦上下文里有图片，**自动切到辅助模型**；
- 两者都支持图片时保持主模型不变（不做无意义的切换抖动）。

## 行为细节

| 情形 | 行为 |
|---|---|
| 未启用 / 未配置辅助模型 | 一律保持主模型（`keep`） |
| 上下文无图片 | 保持主模型 |
| 上下文有图片 + 已配置辅助模型 | 切换到辅助模型（`assist`） |
| 辅助模型与当前路由相同 | 保持（不产生配置抖动） |
| 模型能力**未知** | 按「可能支持」放行，不武断判负 |

切换时会**清空继承的 `reasoningEffort`** —— 避免把主模型的推理档位硬套到辅助模型上。

## 安装

```bash
dsh plugin --profile <profile> add @miasaki/dsh-dual-model
```

装完**重启 DSH**并刷新页面。

### 可选：本体准入补丁

DSH 对「当前模型是否支持图片」的准入判定在本体里。本插件自带一个**一行改动**的补丁
（`patches/dsh-api-session-controller/`），把准入改成**可选服务探测**：

- 插件**没装**时行为与原生**完全一致**（零退化）；
- 插件在场时才接管判定。

```powershell
cd patches\dsh-api-session-controller
node patch.mjs apply      # 应用（会备份为 .dsh-bak）
node patch.mjs verify     # 离线自证：由 baseline 重建产物并逐字节比对
node patch.mjs revert     # 回退
```

**升级 DSH 后需要重打**（补丁按 baseline 校验，升级会让 baseline 漂移，`verify` 会明确报出来）。

## 边界

- 插件**不直接调模型**：它只决定「这一轮用哪个已注册路由」；
- 不改系统提示、不改工具 schema；
- 模型能力来自官方 `resolveModelInfo`，**适配器不声明就当未知**，不猜 `false`。

## 安全

`/dual-model/api/*` 是 webServer 自注册的 prefix 路由，**不经过**内核 `/api` 的准入链，
因此自带两层浏览器信任围栏（2026-10-20）：

- **优先** `connection.requestRejection`（与内核 `/api` 同级：信任围栏 + 浏览器鉴权
  cookie；**逐请求读取**，不做 apply 期快照）—— 401 / 403 原样回给客户端；
- 该服务缺席时退回**结构层**：只允许回环 Host、拒绝跨站 `sec-fetch-site`、
  Origin / Referer 的 hostname 必须与 Host 相同，且 **Origin 显式带端口时必须等于
  Host 端口**（Host 无端口时按 Origin 的 scheme 取 80/443；Origin 不带端口 =
  部分 Chromium 会剥掉非默认回环端口，沿用 hostname 判定，避免误拒）。

在装载了 `connection` 服务的 composition（正式 web 应用）里，写配置的 `POST /settings`
不再能被「伪造 Host、不带 Origin 的本机进程」静默改写（无浏览器 cookie 直接 401）；
只有内核准入缺席的极简 composition 才退回结构层，此时仍以「回环 Host」作纵深防御
（与 free-model / usage 的结构层同口径）。配置写入点本身只接受已知字段
（`enabled` / `assistProvider` / `assistModel`），落盘前经 `sanitizeConfig` 归一化。

## 状态

核心交互（触发钮 / 配置面板 / 模型下拉 / 主题令牌）已在真实 GUI 实测可用。
**端到端的图片准入链路与辅助模型路由仍在实机验收中** —— 这是本插件上线前的最后一项。

## 开发

```bash
pnpm install
pnpm run build        # node --check 入口与 lib/
pnpm test             # 60 例单测（2026-10-20 实测：admission 6 / client 4 / content 7 / invalidation 5 / routing 10 / store 7 / trust 21）
pnpm run patch:verify # 本体补丁离线自证
```

仓库级统一回归：`node ../scripts/verify-all.mjs dual-model`。

设计决策与逐条变更见 [`design/`](design/)。
