# M2.5 实施设计：软件头像（外观设置 → 桌面壳启动器图标）

- 日期：2026-09-21
- 状态：**已实施**（单测全绿；实机验收待用户重启 `dsh web` 后执行）
- 上游：[M2 设计](2026-09-12-appearance-m2-design.md)（皮肤 / 壁纸 / 玻璃 / 让位协议）
- 跨线契约：[`../../dsh-miasaki-shared-docs/cross/appearance-launcher-icon-2026-09-21.md`](../../dsh-miasaki-shared-docs/cross/appearance-launcher-icon-2026-09-21.md)
- 消费端：`dsh-miasaki-desktop/src-tauri/src/launcher_icon.rs`

---

## 0. 一页结论

> 用户原话：「外观设置里要可以设置软件头像，比如这个」（附图），澄清后落点是
> **桌面壳 `Miasaki.exe` 的启动器图标**（任务栏 / 窗口 / 托盘那一处），入口仍是设置里的
> 「外观」栏。这是本线第一条**跨线**能力：外观线出「配置 + 图片」，桌面壳消费。

| # | 结论 | 依据 |
|---|---|---|
| **1** | 通道走**配置文件**（`config.json` 的 `avatar.source`），不走 DOM 属性 / hash 命令 | §2 |
| **2** | 图片格式**收敛到 PNG**，重编码在浏览器侧（canvas）做 | §3 |
| **3** | 「上传」与「启用」**分成两个请求**（上传只落盘、启用走 /config） | §4 |
| **4** | 桌面壳用 **1.5s 轮询**跟随，而不是等页面推 | §2 |
| **5** | EXE / 快捷方式的静态图标**明确不做**（构建期资源），面板文案写明 | §6 |

**一句话方案**：面板里选一张图 → 浏览器 canvas 归一化成 PNG（≤512）→ `POST /avatar` 落盘到
`<dataDir>/avatars/` → `POST /config` 写入 `avatar.source` → 桌面壳读同一份配置，PNG 解码
→ 中心裁方 → `window.set_icon` + `tray.set_icon`，任务栏 / 窗口 / 托盘 1–2 秒内跟随。

---

## 1. 落点取证（为什么是「品牌标记」之外的东西）

需求初判时先查了 DSH 客户端全部插槽，与「头像 / 标志」相关的只有三处：

| 插槽 | kind | 官方占用 | 说明 |
|---|---|---|---|
| `sidebar.brand.mark` | single | 有（Z8，priority 0） | 侧边栏左上角 24px 标志（鲸鱼）；官方包文档写明「替代呈现属于占据相同槽位的另一个 Cordis 包」 |
| `sidebar.brand.name` | single | 有（Z8） | 品牌名 / 版本号 |
| `conversation.hero.brand.mark` | single | 无（用 fallback 动画鱼） | 空会话首屏标志 |

同时确认了 single 插槽的注册语义（vendor `SlotCore.register`）：**同 priority 重复注册会抛错，
`register at a different priority to shadow it (lowest renders)`** —— 即插槽层面确实可以
「低 priority 抢占」，`entriesOfSlot` 对 single 只取第一个。

**但用户澄清落点是「启动器图标」**（桌面壳在 Windows 任务栏 / 开始菜单 / 快捷方式上显示的那个），
不是页面内的任何位置。因此本里程碑**没有**动插槽，上表取证留档供后续「页面内头像」需求复用
（若要做，`sidebar.brand.mark` 用 priority `-N` 抢占即可，无需改 shell）。

---

## 2. 通道选型：为什么是配置文件

桌面壳已有两条 web → Rust 的现成通道：

- **hash 巡检**（`location.hash` 轮询，1.5s）：主题、桌宠状态、窗口控制都走它；
- **自愈巡检**（1s）：文件态的自愈（如 fleet 脉冲）。

头像的特点是**纯文件态**：用户既可能在面板里上传，也可能直接往 `avatars/` 里丢一张图换掉。
若走 hash/DOM 通道，等于把「配置」变成「页面必须在线并主动推送」——页面没开、页面在别的
标签页被节流、或用户手动换了文件，都不会生效。

**决定**：桌面壳直读 `<dshHome>/miasaki-appearance/config.json`，1.5s 轮询。
对「面板上传」与「手动放文件」一视同仁，页面不在场也生效；代价是每 1.5 秒一次小 JSON 读取
（与既有 pulse / hash 巡检同量级，可忽略）。

---

## 3. 格式收敛：为什么只支持 PNG

| 方案 | 代价 |
|---|---|
| 壳侧挂 jpeg/webp 解码器 | 新增依赖（`image`/`jpeg-decoder`），拉长编译、扩大攻击面 |
| 壳侧调用系统 API 解码 | 平台分支 + 非托管内存，风险最高 |
| **浏览器侧归一化 + 壳侧只认 PNG** | 浏览器已具备 canvas；`png` crate **本来就已在依赖里**（桌宠图集用） |

选第三条。面板上传时用 `createImageBitmap` + canvas 把任意格式重编码成 PNG，并把最长边压到
512px（桌面图标最大按 256px 取，512 足够且体积可控，通常 < 1MB）。
副作用是**两条入口自动一致**：面板上传的和手动放进目录的，都必须是 PNG。

---

## 4. 上传与启用分离

`POST /appearance/api/avatar` **只写文件**：解析 `data:image/png;base64,…` → 校验魔数与体积
→ 用 host 生成的名字（`avatar-<时间戳>-<随机>.png`）落盘 → 返回文件名与 URL。
是否启用由随后的 `POST /config`（`{ avatar: { source } }`）决定。

理由：① 「上传了但先不启用」是合法状态，用户可以先攒几张再挑；② 不会因为一次上传就把
用户当前选的头像顶掉；③ 配置写入继续走既有的 `expectedRevision` 乐观并发与深合并，不需要
为头像开第二套写路径。

---

## 5. 安全与失败面

| 面 | 处理 |
|---|---|
| 请求来源 | 复用既有围栏（Host / Origin / sec-fetch-site），上传与清单都在 `/appearance/api/*` 之下 |
| 体积 | data URL 文本上限 ≈ 5.4MB（对应 4MB 二进制）；上传 body 上限单独放宽到 8MB（其余接口仍是 32KB） |
| 内容 | **真查 PNG 魔数**，不信任 data URL 前缀（`data:image/jpeg;base64,<png>` 与「声明 PNG 实为 GIF」都被拒） |
| 落盘路径 | 文件名由 host 生成，白名单 `^[\w][\w.-]{0,80}\.png$`；文件路由再做 basename + `normalize` 前缀双闸门 |
| 跨线输入 | `config.avatar.source` 只接受本线头像路由下的白名单文件（外链 / 其它路由 / 非 PNG / 穿越一律清空）——**桌面壳永远只读自己那一个本地目录，永不联网** |
| 壳侧失败 | 配置损坏 / 文件缺失 / 解码失败 → 只写一行日志 + 回退出厂图标；`apply()` 幂等（文件名 + mtime + 大小作为键），稳态零重复设置 |

---

## 6. 明确不做的边界

- **EXE 文件自身的图标**：内嵌资源，只有重建（`make-icons.mjs` + `npx tauri icon`）能改；
- **桌面 / 开始菜单快捷方式的静态图标**：`.lnk` 的 IconLocation 是构建期或安装期产物；
- **浏览器标签页图标（favicon）与 PWA manifest 图标**：属于 web 侧的另一条链路
  （`webserver/index-inject` 的 `html` 行 + 动态 manifest），本轮未做。

面板文案已把第一条边界写给用户看，避免「改了没反应 = 功能坏了」的误判。

---

## 7. 验收

### 自动化（已通过）

- appearance `node --test`：**79 例**（新增 19 例：`lib/avatar.js` 8、配置与契约 4、
  host 路由 4、client 渲染冒烟 2、既有断言随 v3 调整），覆盖三条主风险：
  「伪装成 PNG 的其它内容」「编码穿越」「host 未更新时的面板降级」；
- desktop `cargo test --bin miasaki`：**25 例**（新增 6：白名单一致性、百分号解码、
  中心裁方、降采样、坏 PNG 不 panic、源串解析）。

### 实机（待用户执行）

> 前置：`dsh web` 与桌面壳都要重启（appearance 改了 host 半；desktop 改了 Rust）。

1. 设置 → **外观** → 「软件头像」→ **上传图片…** 选一张图 → 预览出现；
2. 约 1.5–2 秒内：桌面端**任务栏图标**、**窗口左上角图标**、**托盘图标**同时变成该图；
3. 点 **清除** → 三处图标回到出厂图标；
4. 把一张 PNG 直接放进 `~/.dsh/miasaki-appearance/avatars/` → 面板清单里出现该项 → 选中生效；
5. 「契约自检」条无 `avatar-host-stale` 黄条（有则是 host 未重启）。

---

## 8. 后续可选扩展（本轮不做）

- 头像文件管理（面板内删除 / 重命名）；
- 把头像一并写进 `.lnk` 的 IconLocation（PowerShell + `WScript.Shell` 可做，但涉及用户
  快捷方式路径探测，需单独拍板）；
- 页面内头像位置（`sidebar.brand.mark` / `conversation.hero.brand.mark` 抢占，见 §1 取证）；
- favicon / PWA manifest 图标的动态替换。
