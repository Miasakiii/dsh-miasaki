# Miasaki Desktop

> Miasaki 专属 DSH 桌面端 — Tauri 2 薄壳 + 三主题（原版简约纯净 / 刻刻帝 / 狂狂帝）

双击 EXE → 自动拉起 `dsh web`（如未运行）→ 打开 DSH Web GUI，并注入三套原创主题皮肤与悬浮切换条。**不修改 DSH 本体**：主题以令牌层覆盖（`--dsw-static-*` 色阶）实现，DSH 升级不受影响。

## 快速开始

```bash
npm install                 # 安装 @tauri-apps/cli（本线以 npm 为准，见下方「包管理准则」）
npm run gen-init            # 内联主题 → src-tauri/injected/theme-init.js（含令牌完备性校验）
npm run tauri dev           # 开发运行
npm run tauri build         # 产出 Windows 安装包/EXE（src-tauri/target/release/）
```

> **包管理准则（2026-09-12 决议）**：本线自身依赖统一走 **npm**，`package-lock.json` 是**唯一锁文件**；
> `pnpm-lock.yaml` 已删除并在根 `.gitignore` 挡回。**成因**：历史上两套锁文件各自漂移——pnpm 侧早已解析到
> sharp 0.35.4，npm 侧仍锁 0.35.3，而 dependabot 只读 npm 侧，于是高危漏洞告警长期挂着。
> **注意区分**：文中多处提到的「profile 目录 `pnpm install`」指的是 **DSH profile 宿主侧**的
> `file:` 插件依赖安装（那是宿主生态的既定方式），与本线自身依赖无关，不受此决议影响。

静态回归（令牌完备性 + 令牌漂移 + 运行时补丁自证）已并入仓库级统一入口：

```bash
node ../scripts/verify-all.mjs desktop   # 22 项：gen-init / tokens:diff / 注入脚本语法 + cookie 兜底链行为闸门 + 启动页 S4a 视觉层契约 + 桌宠资产链完整性 / patch verify ×6 / 插件单测 / cargo test（35 例）
```

`npm run verify`（`scripts/verify-themes.mjs`）**不在该脚本内**——它需要附着运行中的
CDP target，属实机项；无 host 时会以 `CDP target not found` 失败。实机冒烟清单
（启动恢复 / 窗口 / 桌宠 / pulse 联动）见
[七线统一回归矩阵](../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md) §3–§4。

> **沙箱注意**：无头 Edge 需要创建命名管道，在受限文件沙箱（`workspace-write`）下必然
> 以 `CDP target not found` 失败——用 `danger-full-access` 重跑**同一条命令**即可
> （2026-09-10 实测跑通；断言含第 6 节「右上角安全区」：窗控裸键组与官方右栏两处控件的
> 矩形交叠必须为 0，且垂直中心差 ≤ 2px）。

## 代码签名（本地自签，2026-09-23 落地）

`tauri.conf.json` 的 `bundle.windows` 已配 `certificateThumbprint` +
`digestAlgorithm: sha256`：**每次 `npm run tauri build` 自动签名**（tauri-bundler 调
signtool，主 exe 与 bundle 内一级二进制均签；构建日志出现 `Successfully signed: …`
即成功）。本机运行产物不再弹 SmartScreen「已保护你的电脑」，UAC 黄条显示发布者
**Miasaki Dev** 而非「未知」。

| 项 | 值 / 说明 |
|---|---|
| 证书 | 自签名代码签名证书 `CN=Miasaki Dev`（EKU 1.3.6.1.5.5.7.3.3 CodeSigning，SHA-256，RSA 2048，10 年期） |
| 指纹 | `9A849C22D97999A011E8D9863B005630E977DBD7`（填入 `tauri.conf.json` 的 `certificateThumbprint`） |
| 归档 | pfx/cer 存 `_refs/miasaki-codesign.pfx`（已 gitignore，**私钥不入库**） |
| 信任库 | `Cert:\CurrentUser\{My, Root, TrustedPublisher}`（本机已导入；换机/重装系统后需重新导入） |
| 将来换 OV 证书 | 只需替换 `certificateThumbprint` 并把新证书导入 `My` 存储，链路不变 |

**能力边界（必读）**：自签只覆盖**本机**。经 IM/浏览器下载（带 Mark-of-the-Web）的文件
在**别人**机器上首次运行仍可能弹一次 SmartScreen（措辞会变为显示发布者名）。彻底免提示
只有两条路：① Microsoft Store MSIX（免费，官方重签）；② OV/EV CA 证书（约
¥1000–3000/年，**2024 年起 EV 不再即时免提示**，均需积累发布者信誉）。另注：Azure
Artifact Signing 个人账号仅限美/加地区，OV 溢价换 SmartScreen 的路线已废止——详见微软
[代码签名选项对比](https://learn.microsoft.com/zh-cn/windows/apps/package-and-deploy/code-signing-options)。

**重新生成本地证书**（`_refs/miasaki-codesign.pfx` 丢失或 10 年到期后）：

```powershell
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$dn  = New-Object System.Security.Cryptography.X509Certificates.X500DistinguishedName("CN=Miasaki Dev")
$req = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest($dn, $rsa,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$usage = New-Object System.Security.Cryptography.OidCollection
$usage.Add("1.3.6.1.5.5.7.3.3") | Out-Null
$req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($usage, $false)))
$req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature, $false)))
$cert = $req.CreateSelfSigned([System.DateTimeOffset]::Now.AddDays(-1), [System.DateTimeOffset]::Now.AddYears(10))
$pwd  = ConvertTo-SecureString -String "<导出密码>" -Force -AsPlainText
[System.IO.File]::WriteAllBytes("$PWD\miasaki-codesign.pfx", $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $pwd))
# 导入信任库（My/Root/TrustedPublisher 三处）后用 certmgr.msc 取新指纹更新 tauri.conf.json
```

**构建环境三件套**（2026-09-23 实测，受限终端/沙箱里跑 `npm run tauri build` 必看）：

1. `cargo` 可能不在 PATH——rustup 实际装在 `%USERPROFILE%\.cargo\bin`，先补上；
2. Rust release 编译要 MSVC `link.exe`——没有的终端先执行
   `"C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"`
   （`where.exe link` 可自检）；
3. `%TEMP%` 不可写时 WiX `light.exe` 会以 `failed to run` 失败（蹭不上证书链路）——
   构建前把 TEMP/TMP 指到可写目录（注意：`cmd /c "vcvars && set TEMP=…"` 的 `&&` 链里
   后置 `set` 会被 setlocal 作用域吞掉，pwsh 里直接 `$env:TEMP=…` 或用 bat 逐行 call）。
   > **2026-09-25 补注（不要把这条当成"改 TEMP 就能过"）**：本轮在 DSH 会话里把 TEMP/TMP
   > 显式指到可写目录后**仍在同一处失败**，且 `light.exe` 单独跑会打印更精确的原因——
   > `error LGHT0001: 对路径"C:\Users\<用户>\AppData\Local\Temp\*.tmp"的访问被拒绝`
   > （`UnauthorizedAccessException`），即失败点不是 TEMP 变量、而是**受限会话里 WiX 拿不到
   > 用户临时目录**（同一会话里 pwsh 自己写该目录是成功的）。现象是：`Running light to
   > produce …msi` → `failed to bundle project`，**exe 编译与签名早已成功**。
   > 处置：需要 MSI/NSIS 安装包时在**普通终端**（非 DSH 会话）重跑 `npm run tauri build`，
   > 或先 `npm run build -- --no-bundle` 拿到已签名 exe 再手工分发（`npm run deploy`）。

## 启动失败排查（「桌宠出来了、主界面一直不出来」）

**现象**：双击后桌宠（悬浮球 / 立绘）正常出现，主界面窗口始终不出现，且全程没有提示。

**机理**：主窗以 `visible(false)` 建出，靠页面加载回调 `show()` 显示；而 WebView2 的环境创建
必须能写 `%LOCALAPPDATA%\com.miasaki.desktop\EBWebView` 这个用户数据目录。一旦进程写不了它
（最常见的原因是**程序被以低完整性级别运行**：本机实测「用户可写目录下的 exe」会以
`0x1000 = Low` 启动，而同一条命令下 `C:\Program Files`、`C:\ProgramData` 下的 exe 是
`0x2000 = Medium`），WebView2 就起不来——此时 `WebviewWindowBuilder::build()` **仍返回 Ok**，
只是窗口句柄随即被回收，于是主窗既不显示、`show()` 也静默失败。桌宠是原生 Win32 窗口、
不依赖 WebView2，照常显示，最终表现就是「只剩桌宠」。

**处置顺序**：

1. **换到非用户目录运行**（本机已实测可解）：把 exe 放到 `C:\ProgramData\<目录>\` 或
   `C:\Program Files\` 下再双击。桌面 / 文档 / `%LOCALAPPDATA%` 等**用户可写目录**下的 exe
   在本机一律被降权，换名字、换签名、换副本都没用。
2. **先结束所有残留 Miasaki 进程**：它持有单实例锁，会让新实例**静默退出**——表现同样是
   「双击没反应」。任务管理器里搜 `Miasaki` 全部结束即可。
3. **看弹窗与日志**：2026-09-25 起，启动 2.6s 后主窗仍不可见会弹原生「Miasaki · 启动失败」
   对话框并写明原因与指引；日志在 `%LOCALAPPDATA%\miasaki\pet.log`，其中
   `bootstrap.json` 的 `phase` 为 `up` 表示页面已成功加载。

> 判据速查：任务管理器「详细信息」标签页加一列**「完整性级别」**——显示`低`即命中本问题；
> 正常应为`中`。

**构建后必做（2026-09-25 21:22 复发教训）**：`dist\Miasaki.exe` 是本机必被降权的构建产物，
**不要双击它**——哪怕它与系统目录里的版本 SHA256 逐字节相同，决定完整性级别的是**路径**而非内容。
每次构建后跑一次同步：

```powershell
npm run deploy                                                                   # → C:\ProgramData\MiasakiApp
powershell -ExecutionPolicy Bypass -File scripts\deploy-local.ps1 -FixShortcuts   # 顺带修正桌面旧快捷方式
```

再用桌面「Miasaki 桌面端」快捷方式验证。失败弹窗自本次起按启动位置**分流**：exe 在
`%USERPROFILE%` 之下时直接点名「改用 `C:\ProgramData\MiasakiApp\Miasaki.exe`」，不再给
「加安全软件白名单」这类无效建议；同时打印**启动位置**，并说明低权进程连 `pet.log` 都写不进去
（21:22 那场复发的日志一行未增，正是判据而非异常）。

## 打包（MSI）失败排查

`npm run build` 里 **exe 环节与 MSI 环节是分开的**：exe 成功、MSI 失败时，入口（exe）不受影响，
`npm run deploy` 照常可用。MSI 失败多数是**执行环境**问题，不是项目配置。

`light.exe`（WiX 3.14，.NET Framework）的报错会**被 tauri 的输出截断**（只留一句
`failed to run …light.exe`）。要看完整信息必须用 `npx tauri build --verbose` —— 它会打印
light 的完整命令行与 stderr。

| 报错 | 含义 | 处置 |
|---|---|---|
| `LGHT0001 … 对路径"C:\Users\…\AppData\Local\Temp\xxxx.tmp"的访问被拒绝`（`UnauthorizedAccessException`，调用栈含 `TempFileCollection.EnsureTempNameCreated`） | light 需要**一个可写的 `%TEMP%`** 放中间文件 | 把 `TEMP`/`TMP` 指到工作区内可写目录再构建：`$env:TEMP="$PWD\src-tauri\target\tmp"; $env:TMP=$env:TEMP; npm run build` |
| `LGHT0217 : Error executing ICE action 'ICE01' … The Windows Installer Service could not be accessed` | light 的 ICE 校验要连 **Windows Installer 服务**（`msiserver`） | 先确认：`Get-Service msiserver`。服务显示 `Running` 却仍报此错 ⇒ 当前会话（沙箱 / 受限令牌）挡住了服务访问，换普通桌面会话构建，或临时加 `-sval` 跳过 ICE |

**关于 `-sval`（跳过 ICE）**：ICE 是安装包的**最佳实践校验**（组件引用、升级路径等），
不是编译必需。跳过它能出包，但**发布用的安装包不该跳过** —— 除非已确认失败只是"连不上服务"，
而非真正的 ICE 违规。

> 2026-09-25 实测（受限会话内）：两类报错**先后**出现 —— 绕过 TEMP 后撞 ICE；再加 `-sval`
> 手动跑 light 产出 37.62 MiB 的 MSI，而当时 `msiserver` 是 `Running`。故两者都是**会话环境
> 限制**，与项目配置无关；`bundle/msi/` 里那份 2026-09-04 的 MSI 即证明这条链在正常桌面会话里
> 是通的。同一限制也体现在 `cargo test`：受限会话里测试进程写系统 `%TEMP%` 会得到 os error 5，
> 故测试临时目录统一改用 `target/test-tmp/`。

## DSH 运行时补丁（本体例外）

`patches/` 存放**六处**「修改 DSH 本体」的补丁——都改写已安装包的编译产物，
**DSH 升级会被覆盖、需重新应用**；补丁规则与基线文件均已入库，可重建/可校验/可回退。

| 补丁 | 目标包 | 做什么 |
|---|---|---|
| [`dsh-client-ui-settings-models`](patches/dsh-client-ui-settings-models/README.md) | 官方设置页 | 逐模型「思考强度」下拉 + 「测试连通性」按钮 |
| [`dsh-client-ui-conversation`](patches/dsh-client-ui-conversation/README.md) | 官方会话头 | 窄宽度溢出保护：`headerActions` 改可收缩 + 横向可滚，消除右栏展开时的控件压叠 |
| [`dsh-client-ui-trajectory`](patches/dsh-client-ui-trajectory/README.md) | 官方轨迹页 | 首 token 计时可恢复：实时 chunk 缺位时从 `assistant/message` 紧凑流恢复，修掉「首 token 时间不可用」 |
| [`dsh-client-ui-chat`](patches/dsh-client-ui-chat/README.md) | 官方聊天区 | 同上，作用于消息气泡的「首 token 用时（TTFT）」与窗口口径兜底统计 |
| [`dsh-client-ui-attachment`](patches/dsh-client-ui-attachment/README.md) | 官方消息图片画廊 | 多图 tile 宽高比保持：64×64 定宽 cover 方块改为按原始比例自适应（44–220）+ contain 完整显示，修「截图被裁成方块」 |
| [`dsh-cordis-host-runner`](patches/dsh-cordis-host-runner/README.md) | 官方 host 侧 Cordis runner | `cordis_inspect_query`(client) 永久挂起修复：记下页面的拒绝原因 + 15s 兜底超时，把「无限挂起」变成「带原因的报错」 |

> 前五个作用于浏览器 bundle，改完**刷新页面**即生效；第六个作用于 **host 侧 Node 包**
> （`lib/index.js`），改完必须**重启 DSH host 进程**才生效（Node 已加载的模块不会热更新）。
> 另有一件作用于 host 侧的图片准入补丁属 dual-model 线（`../dsh-miasaki-dual-model/patches/`），
> 同样需重启 `dsh web` 才生效。

```powershell
cd patches/<补丁目录>
node patch.mjs verify       # 离线自证（已并入 verify-all）
node patch.mjs status       # 检查安装目录状态
node patch.mjs apply        # 备份 + 应用（幂等）
node patch.mjs revert       # 还原
node patch.mjs rebuild      # A 类：同步 baseline 原版 + ORIGINAL_SHA256 后重建 golden
node patch.mjs seal         # 同上（api-session-controller 的该命令名为 seal）
```

> **当前基线：DSH 0.1.7-rc.2（2026-09-25 升级重打，EDITS 零改）**。本机全局 DSH 已实装
> `0.1.7-rc.2`（`next` 轨；`latest` 仍是 0.1.5-rc.3，勿用）。七个本体补丁当日全部重打，
> **7/7 增量与升级评估文档给出的预期值逐字节一致**，是锚点未漂移的强证据：
> attachment `45064→45175`（+111）、chat `530699→532563`（+1864）、
> conversation `712829→712954`（+125）、settings-models `186454→201924`（+15470）、
> trajectory `421649→423513`（+1864）、cordis-host-runner `102835→103592`（+757；**其 rc.2
> 原版与 alpha.2 逐字节相同**，故常量未变）、图片准入 `124151→124896`（+745，
> 见 `../dsh-miasaki-dual-model/patches/`）。
> **两个计时补丁要一起重打**才完整（同一个 `firstTokenTime` 的两处显示）。
> cordis-host-runner 是本目录里**唯一作用于 host 侧 Node 包**的补丁（其余都是浏览器 bundle）
> ——host 侧两个补丁（它 + 图片准入）**需重启 `dsh web` 生效**，client 侧刷页面即生效。
>
> **升级重打的实际流程（与下方历史记录里的表述不同，已按实测修正）**：
> ① `status` 报 `unknown`（新版覆盖）→ ② 把安装目录的新版原版复制为 `baseline/*.original.js`
> 并同步 `ORIGINAL_SHA256` + `BASELINE_DSH_VERSION` → ③ `rebuild`（A 类）或 `seal`
> （api-session-controller）重建 golden 产物并回填 `PATCHED_SHA256`；B 类补丁（chat /
> conversation / trajectory / cordis-host-runner）**不存 patched 全文**，其 `verify` 在常量
> 未同步时会以 FAIL **打印**重建 SHA，据此回填即可 → ④ `verify`（须 PASS）→ ⑤ `apply`。
> **本目录不存在 `rebuild-baseline.mjs`**（历史文档中的该命令名有误）。
>
> 历史基线记录（0.1.7-alpha.2 时期，2026-09-23 全量重打）：六个补丁（含 dual-model 线的图片准入
> 补丁）当日全部重打、`EDITS` 零改：settings-models（`B2D7D445…` → `9F2F1EE8…`，probe 自动选中
> 0.1.6+ 变体分支）、conversation（`38326414…` → `59A185B9…`）、trajectory / chat
> （`E64C3D03…` → `4B577822…`、`CCC14F1E…` → `1594AC3C…`）、cordis-host-runner
> （`AC73F866…` → `D3126110…`；图片准入补丁 `05DAAAF8…` → `450C25A2…`）。
> attachment 于 2026-09-23 新建并应用（`397B4947…` → `381D2676…`，2 条锚点唯一命中；
> 纯 CSS，修多图 tile 64×64 cover 方块 → 比例自适应 + contain）。
>
> 历史基线记录（0.1.5-rc.1 时期）：settings-models 于 2026-09-10 重打（`A60FD863…` → `E602C1F1…`）；
> conversation 于 2026-09-10 新建（`81314DFD…` → `D9A841DE…`）；
> trajectory / chat 于 2026-09-10 新建（`73A878B4…` → `C3485ADF…`、`4F9CFFF8…` → `BE4C68D5…`）；
> cordis-host-runner 于 2026-09-21 新建（`58EF79A0…` → `8B81500A…`）。
> 下次升级的流程（各补丁**各自独立**）：`status` 报 `unknown` → 用新版原版刷新
> `baseline/*.original.js` 与 `ORIGINAL_SHA256` → `rebuild`／`seal` 重建产物并按打印值回填
> `PATCHED_SHA256` → `verify` → `apply`。**注意：本目录不存在 `rebuild-baseline.mjs`**，
> 旧记载中的该命令名有误（2026-09-25 实测修正）。

详见六个补丁各自的 README，以及
[模型设置工具包设计](../dsh-miasaki-shared-docs/cross/model-settings-toolkit-design-2026-09-07.md)、
[会话头部挤压修复设计](../dsh-miasaki-canvas/design/2026-09-10-conversation-header-crowding-fix.md)
与[首 token 计时恢复设计](design/trajectory-ttft-restore.md)。
除这些补丁外，本线对 DSH 的一切改动都在令牌层，DSH 升级不受影响。

## 三个主题

| 主题 | 概念 | 说明 |
|---|---|---|
| `pure` | 原版简约纯净 | 零覆盖，DSH 原生样貌透传（兜底主题） |
| `zafkiel` | 刻刻帝 · 永夜钟阁 | 暗夜基底 · 绯红交互 · 鎏金装饰 · 表盘水印 · 金色光标 |
| `kurkuriel` | 狂狂帝 · 白夜逆钟 | 骨白基底 · 血绯交互 · 枪铁装饰 · 破裂表盘 · 星座母题 |

切换：右下角悬浮按钮 → 悬停展开三主题；每个主题悬浮显示各自的介绍文案（不再全部是当前主题的提示），
选择持久化于 localStorage，重启保持。

## 软件头像（启动器图标）

**在 DSH 页面的「设置 → 外观 → 软件头像」里换掉本应用在任务栏 / 窗口 / 托盘上的图标**，
无需重建 EXE（2026-09-21 落地，appearance 线跨线消费端）。

| 项 | 说明 |
|---|---|
| 入口 | DSH 页面 设置 → **外观** → 「软件头像」→ 上传图片 / 从清单里选 / 清除（appearance 线提供） |
| 存储 | 图片归一化成 **PNG** 落在 `~/.dsh/miasaki-appearance/avatars/`，配置记在 `~/.dsh/miasaki-appearance/config.json` 的 `avatar.source` |
| 生效面 | 主窗口图标（**任务栏**随之）+ **托盘**图标；改完 1.5s 巡检内跟随 |
| 实现 | `src-tauri/src/launcher_icon.rs` —— 读配置 → PNG 解码（`png` crate，零新依赖）→ 中心裁方 + 盒式降采样（≤256px）→ `window.set_icon` + `tray.set_icon` |
| 失败姿态 | 配置损坏 / 文件缺失 / 解码失败 → 一行日志 + 回退出厂图标，不阻断启动 |
| **不含** | EXE 内嵌图标、桌面 / 开始菜单快捷方式的静态图标（构建期资源，只有重跑 `make-icons.mjs` + `npx tauri icon` 才能改）、页面 favicon |

契约（配置路径 / 文件名白名单 / 目录）见
[`../dsh-miasaki-shared-docs/cross/appearance-launcher-icon-2026-09-21.md`](../dsh-miasaki-shared-docs/cross/appearance-launcher-icon-2026-09-21.md)；
改契约必须同时改 appearance 线的 `lib/avatar.js`（两侧各有单测钉同一组样本）。

## Q 版桌宠（Codex 风格）

透明置顶小窗桌宠，随主题自动换角色：

| 主题 | 桌宠 | 素材 |
|---|---|---|
| `pure` | DS 鲸鱼娘 | `ui/pets/whale/`（deepseek-whale-pet，MIT） |
| `zafkiel` | 狂三（Q 版） | `ui/pets/kurumi/`（hatch-pet-kurumi，作者自产） |
| `kurkuriel` | 反转狂三（Q 版） | 同狂三图集 + CSS 反转滤镜（白化/降饱和/血红辉光） |

- 图集兼容 Codex 宠物 V1/V2 格式（8 列 192×208，自动探测每行非空帧）；kurumi 已切全 9 行语义帧
  （idle/runRight/runLeft/wave/jump/failed/wait/run/review），whale idle 为帧序列（idle.gif 拆分 6 帧）
- 交互（v3 M1，2026-09-12 重排；**R1/R2 于 2026-09-16 补窗口层**）：**拖动**移动 / **单击**「撸一下」
  跳跃+气泡（**不抢焦点**——窗口已带 `WS_EX_NOACTIVATE`，点击不会夺走前台与键盘焦点，
  在被遮挡的应用里 Ctrl+C/V 照常可用；等待审批或主窗口最小化/隐藏时单击为**唤起主窗口**）/
  **双击**挥手（250ms 去抖与单击区分；等待审批或主窗口最小化/隐藏时双击为**唤起主窗口**）/
  **右键**菜单（显示主窗口、隐藏桌宠、最小化主窗口、退出）
- **透明区域鼠标穿透**（R2，2026-09-16）：角色轮廓以外的透明像素不再拦截鼠标——10ms 轮询光标位置，
  查**当前合成缓冲**的 alpha（阈值 16，与显示逐像素一致），命中透明像素即置位 `WS_EX_TRANSPARENT`
  把点击交给下层窗口，光标回到角色本体立即恢复可点；隐藏 / 拖拽中恒不穿透（保证跟手）。
  只改扩展样式位、不重建窗口（无闪烁）；切换日志按 500 次节流
- **隐藏态恢复入口 = 主题头像悬浮球**（2026-09-24，取代原 30px 硬编码紫圆）：桌宠隐藏后显示的是
  **当前主题的头像徽章**（`ui/icons/theme-pure|zafkiel|inverse.png`，与设置「主题」选择器同一批素材，
  编译期内嵌；**素材名 ≠ 主题名**——`kurkuriel` 用 `theme-inverse.png`）+ 主题色环（银 / 鎏金 / 破血红）
  + 外发光 + 球面左上高光 + 底部落影，56px 方窗内球面直径 38。**主题切换即换面**
  （`set_theme` → compose 比对 `dot_theme` 后重绘；冷启动直接用 `prefs.json` 里的主题，无「换脸」帧）；
  光标**悬停整体放大 1.08 并增强光晕**（离散两态，无插值动画）。
  命中判据 = 球面合成缓冲的 alpha（阈值 16，与 R2 同范式，独立 10ms 轮询）——方窗四角与发光外沿
  照样穿透，球放大后不会长出一片「隐形挡板」；`hide` 仍持久化于 `pet.json`，位置仍随桌宠拖动同步
  （M1.4 不变）。素材缺失 / 主题未知 → 回落为主题色实心球，绝不空白
- **桌宠内联审批（R5 / M3.2，2026-09-16）**：审批等待时气泡升级为**含「拒绝 / 允许一次」两个按钮**
  的交互气泡（`ui/pets/approval.png`，240×84，构建期 `gen-bubbles.ps1` 出图、运行时零字体调用；
  两按钮间留 8px 间隙防误触）。点按钮 → 桌面端记单调 `seq` 并经 `eval` 派发
  `miasaki-approval-decision` → `dsh-pet-panel` 调用官方 `PendingApproval.answer('allowed-once'|'rejected')`。
  **红线**：只在用户显式点击时决策、只发这两个枚举、不做「全部允许 / 记住选择」；
  点完**先本地收起**，若 3s 内该审批仍在（未生效）则回显「需要你的批准」提示去 DSH 界面处理，
  **绝不假装成功**。拿不到官方 `key` 的审批不挂可交互气泡（身份门禁）
- 自主动作（环境编排）：静止且空闲时低频随机小动作（挥手/检查/等待，偶发跳跃——表演 1.2~2.2s、
  休息 8~18s、首次 5.5s 延迟；指针按下即打断）；等待审批 / fleet 指示 / busy 工作态期间
  散步与小动作**停触发**（工作姿态可读，不被环境动作打断）
- **工作动态 + 权限申请提示**（v3 M2 2026-09-12 重做；**R0 2026-09-16 改为跨会话聚合**）：
  桌宠反映六态 `idle / thinking / waiting / error / done / fleet-blocked`——**主信号 = DSH 官方契约**：
  `dsh-pet-panel` 插件读官方 `ctx.sessions`（**跨会话聚合**：任一非子代理会话 `running` = 忙，
  修掉「先完成的会话把仍在干活的顶成 idle」）+ `ctx.uiSession.pendingInteractions`
  （**遍历全部会话**找审批——切走会话后仍能看到后台会话的待审批，这是「快捷提权」的价值前提；
  随态带出工具名 + `sessionId` + 原因（截断 160 字符）+ **官方 `key`**（经 hash `petkey=` 上报，
  用于内联审批的幂等身份），并落地**身份门禁**：拿不到稳定身份的审批一律不显示，
  宁可不报也不挂一个永远等不到 resolved 的常驻态），
  1.5s 心跳写 `window.__miasakiPetPanel`，由注入运行时 `syncHash`
  合并进 URL hash `pet=/pettool=/petts=`（单写者定律不变）。Rust `compose` 合成六态并按
  **Waiting(审批) > FleetBlocked(告警) > Error > Done > Thinking(静默守候) > Idle** 优先级
  映射立绘/气泡（`pick_state_row` 单测钉死）：waiting 强制 kurumi `wait` 行 /
  whale·inverse `work` 立绘 + **常驻"等待审批"气泡**；done 播 review 庆祝一次（气泡 10s）；
  error/告警播 `failed` 行；waiting 中**单击/双击桌宠 = 唤起主窗口**。**DOM 扫描仅为兜底**：
  官方通道 5s 无心跳（非桌面端 / 插件缺失 / 崩溃）才启用 `act=/wait=` 扫描（选择器
  `themes/src/05-sensors.js` 顶部常量区，校准 `__miasakiProbe()`）。agent 员工状态
  后续归 `dsh-miasaki-fleet/fleet-monitor/` 工作面板，不进桌宠。
- **Fleet 指示器（v2026-09-04，可选联动）**：设环境变量 `MIASAKI_FLEET_PULSE`
  指向 `dsh-miasaki-fleet/state/fleet-pulse.json`（由 fleet 侧
  `node workers/pulse/publish-pulse.mjs` 发布，契约见
  `dsh-miasaki-shared-docs/cross/ab-linkage-pulse-v2-2026-09-04.md`），桌面端
  脉冲看门狗 2s 轮询，桌宠按 **fleet 告警(blocked/error，failed 行 + 常驻
  “需要你的批准”气泡）> DSH 等待审批 > fleet 运行中（work 立绘 + 常驻“忙碌中…”）
  > busy > intensity** 映射；未设变量时联动静默关闭。
- 位置与角色持久化到 `%APPDATA%\com.miasaki.desktop\pet.json`（**v2，2026-09-16**：
  「**角色可见区域**中心」相对所在显示器工作区的比例 `rx/ry` + 工作区几何（作为屏幕身份）
  + 绝对坐标兜底 + 隐藏状态，原子写；**v1 文件自动读取并在下次保存时升级**）。
  恢复顺序：工作区几何完全一致 → 按比例还原并 clamp 回工作区（**分辨率/缩放变化后位置仍成立**）；
  几何已变 → 绝对坐标 + 可见性校验；都不可见 → 回默认 (1200,500)（保留隐藏设置）。
  可见性判据为「**角色可见区域 ∩ 工作区的面积占比 ≥ 25%**」——半出屏/贴边保留，完全出屏才回默认；
  旧的「窗口中心点」判据已废弃，它是 M4.1（peek 缩边）的必然坑：peek 时窗口中心在屏外，
  会被误判「不可见」而把桌宠拉回默认位置（即「桌宠丢了」回归）
- **设置入口**：DSH「设置 → 桌宠」面板（`plugins/dsh-pet-panel/`）提供：
  显示/隐藏开关、位置重置（屏幕外找回）、状态回显（面板挂载时经
  `cmd=pet-state` 请求，桌面端 eval `miasaki-pet-state` 事件回推）。
  命令走主窗口 URL hash 通道（`cmd=pet-show/pet-hide/pet-reset`），与主题联动同链路；
  非桌面端（普通浏览器打开 DSH）面板显示降级提示。
- **人格会话联动**：主题切换时自动用对应桌宠的 Agent 预设开启新会话。注入层切换
  主题时派发 `miasaki-persona-request` CustomEvent，由 `dsh-pet-panel` 插件客户端
  经官方 `ctx.remote.session.create`（0.1.2-rc.1 的 WebSocket mux 通道，2026-09-06
  从注入层 fetch 迁移）创建：映射 `pure→whale`（鲸鱼娘）/`zafkiel→kurumi`（狂三）/
  `kurkuriel→inverse`（反转狂三）；每个主题仅自动创建一次，结果记于 localStorage
  （`miasaki.petSessions`），切换回来时只提示「已建立」；新会话优先挂到当前
  workspace；RPC 不可用或预设缺失时静默降级，不影响主题切换。
  三个预设定义在 `%USERPROFILE%\.dsh\.agent-presets\{whale,kurumi,inverse}\`
  （standard 底座 + 桌宠中文人设，persona 含「入戏边界」：工具/错误/审批一律标准语气）。
  **用户侧是生成产物，不要手改**；维护材料全部在 `preset-sources/`：
  `agent.base.cordis.yml`（DSH 0.1.5 `standard` 底座全文 + 本仓库自定义，persona 行为
  `__PERSONA__` 占位符）、`*.persona.txt` / `*.preset.yml`（人设与预设元数据）、
  `apply-presets.ps1`（读模板整体生成，覆盖前留 `.bak`）、`verify-presets.cjs`
  （校验产物字段与自定义项，自带 `!!js` 标签 schema）。改人设或换底座后重跑脚本并复验。
  注：DSH 0.1.5 起 persona 拆为 `prefix`（必填）+ `suffix`（缺省即遮蔽部署级后缀），
  旧 `text` 字段已不存在。
- 悬浮主题条切换时，主窗口通过 `set_pet_mode` 命令联动宠物角色
- **主窗口拖动（V3 空白拖动）**：窗口零占位叠加后没有自绘拖动条——注入运行时在
  document 级捕获 mousedown：落在顶部 36px 内且事件路径上无「可交互元素」（复用
  Tauri 内置 drag-region 判定口径：可点击标签/contenteditable/tabindex/交互 role）
  时调 Tauri 原生 `start_dragging`（OS 级，完全跟手），双击 = 最大化/还原；
  页面按钮/页签/输入框照常点击不受影响。远程页面（http://127.0.0.1:3080）的子
  capability `remote-dsh.json` 必须授予 `core:window:allow-start-dragging`（已授），
  否则拖动手势会被插件 ACL 拒绝且无任何提示。
- **窗口控制按钮**：右上角**无壳裸键组**内最小化/最大化/关闭为统一内联 SVG 线图标（10×10 视口、
  `stroke-width 1`、`currentColor` 描边、圆头端帽 Fluent 风格，三按钮视觉重量一致；
  v4 起无底色/无边框/无毛玻璃，hover 底色只落单按钮——Win11 原生同款），
  最大化后按钮自动切换为「还原」错位双框图标——远程页无 IPC 权限，状态由 Rust 侧
  `on_window_event`（Resized，150ms 防抖）经 eval 派发 `miasaki-max-state` CustomEvent
  驱动，页面加载后延迟补推、页面经 hash `cmd=want-max` 可请求重推；双击顶部空白 /
  Win+↑ 等系统路径同样同步；非 Tauri 环境（浏览器调试预览）点击时本地翻转兜底。
- **标题栏 × 主界面一体化（v3 零占位叠加 → v4 去胶囊 · 无壳裸键）**：系统标题栏移除
  （`decorations(false)`）后，桌面壳对 DSH 页面**零布局侵入**——无 32px 顶带、无下推、
  无卡片，页面从 y=0 起渲染，顶部控件（会话头「对话/轨迹/用量」页签、Session 日志等）
  位置与 web 端完全一致；窗控三键以**无壳裸键**直接落在右上角（v3 的悬浮胶囊外壳已删：
  无底色/无边框/无毛玻璃/padding，观感接近标准无边框应用；主题徽章 16px 保留在按钮组
  左侧，为启动页唯一主题标识——用户拍板 2026-09-06），hover 底色只落在单按钮上
  （Win11 原生同款，关闭键 hover 红底）。**唯一页面级调整 = 右上角安全区让位**（2026-09-10
  晚重写）：裸键组实测宽 108px，加 `right:8px` 后恒占距窗口右缘 `[8,116]px`，故声明
  `--ms-titlebar-reserve:128px`（含 12px 呼吸位），再按**恒存锚点**让位 DSH 0.1.5 官方右栏的
  两处控件——折叠态的「打开右侧边栏」（`[data-conversation-header-corner]`，其官方
  `margin-right:-16px` 需归零）与展开态的面板 chrome 全屏/收起两键
  （`[data-dockkit-strip-chrome]`，只在分栏最右一格渲染）；裸键组 `top:11px` 使其中心与官方
  控件同落在 24px 水平线上。旧规则 `header:has([role="tablist"]){padding-right:118px}` 已废
  （依赖仅在多 view tab 时才渲染的 `role=tablist`，单 tab 会话下整条失效）。命令链/拖动/
  最大化同步与 v3 相同：hash `cmd=min/max/close`
  → Rust watchdog；双击顶部空白 / Win+↑ 等系统路径同样同步；裸键组仍在
  `#miasaki-titlebar` 内，拖动排除自动生效。底座仍为
  **Win11 Mica**（DWM 直调 `DWMWA_SYSTEMBACKDROP_TYPE`，窗口底透明），`.shadow(true)`
  恢复圆角/阴影/描边；Mica 不可用（Win10）时回退主题实色底，pure 保持原版实色。
- 气泡台词为**构建期预渲染**的位图帧（`ui/pets/bubbles.png`，20 帧：17 台词 + 3 状态帧
  「忙碌中…/等待审批/需要你的批准」），运行时零 GDI 字体调用：
  Windows 11 的 GDI 字体在多线程（WebView2 + 桌宠线程）并发使用时存在已知堆损坏，`CreateFontW`
  会确定性崩溃（gdi32full!CreateFontW+0xA3 / 0xC0000005）。**修改台词池（`src/pet_native.rs`
  的 `quote_pool`）后必须重新生成**：`powershell -File scripts/gen-bubbles.ps1`（无 PowerShell 5
  时用 `pwsh`）

## 拖拽上传附件到会话（2026-09-22 设计定稿，未实施）

- **症状**：桌面端把文件拖进主窗口**静默无效果**（光标显示 copy、松手无反应）——
  同一 DSH 在普通浏览器里打开则一切正常（官方本就有拖放上传）。
- **根因**：Tauri（tauri-runtime-wry）**默认注册 drag-drop handler**，在 Windows 上先
  `SetAllowExternalDrop(false)` 关掉 WebView2 自身外部拖放、再 `RegisterDragDrop`
  把文件拖放拦进 OLE 层、转成 `tauri://drag-drop` 窗口事件；本壳无人监听 ⇒ drop
  静默丢失。官方 Web 侧的拖放上传链路（`dsh-client-ui-attachment` 的 document 级
  DnD + `DropOverlay` 遮罩 + `dsh-client-file-upload` 流式上传）毫发无损——只是
  **被拦在壳外**，碰不到。
- **修法**：主窗 builder 一行 `.disable_drag_drop_handler()`（tauri 官方注释：
  Windows 上用 HTML5 DnD 的必要条件）让拖放直达页面，官方链路全量复用；**配套
  注入层安全网** `themes/src/09-dropguard.js`——官方监听只活在对话视图，其余页面
  （轨迹 / 用量 / 设置 / 启动页）drop 落空会触发浏览器默认 `file://` 导航炸掉 SPA，
  安全网只拦文件拖放、官方已消费（`defaultPrevented`）的 drop 精准让位。
- **不含**：loading 页拖文件排队自动附、自建限额判定（单一事实源在官方
  `intakeFiles`）、Rust 侧 OLE 事件桥（仅作实机失败时的退路）。

设计：`design/drag-drop-attachment-upload.md`（根因证据链 / 方案选型 / 行为规格 /
实机验收十项）。

## 目录

```
desktop/
├─ ui/loading.html           # 本地唤醒页（探活/拉起状态 + 重试 + 随主题换肤/统一标题栏）
├─ themes/                   # 主题源（原创设计）
│  ├─ pure.css / zafkiel.css / kurkuriel.css
│  ├─ src/                   # 注入运行时分片（9 片，按 MANIFEST.json 拼接；改这里）
│  │                         #   （00-boot.js 含 DSH 鉴权 cookie 注入：dsh web 重启后
│  │                         #    旧 cookie 失效黑屏时自动重签并重载，见 CHANGELOG 2026-09-05）
│  └─ runtime.js             # legacy 回退源（build-init 缺 src/ 时使用）
├─ plugins/dsh-free-model-pool/  # DSH web profile bundle：免费模型池插件（见下）
├─ plugins/dsh-pet-panel/        # DSH web profile bundle：桌宠设置面板（设置 → 桌宠）
├─ plugins/dsh-token-monitor/    # DSH web profile bundle：用量监控（会话「用量」Tab 纯会话视角 + 侧栏脚部「用量统计」入口 → 全局浮窗：总览六卡/年热力图/趋势/模型用量 + 会话活跃分布（标题折叠自会话日志／近 30 日逐日分布条／排序·搜索·条数控件）/今日限额，v0.5.0）
├─ plugins/dsh-session-log-move/ # DSH web profile bundle：会话日志下载入口迁移（主界面 → 轨迹页搜索栏左侧，见下）
├─ plugins/dsh-model-probe/      # DSH web profile bundle：模型连通性真实探测（host only，设置页「测试连通性」的 B 档能力，见下）
├─ scripts/build-init.mjs    # 打包内联 + 令牌完备性强制校验
├─ scripts/diff-tokens.mjs   # 令牌漂移报告（`npm run tokens:diff`，只告警不阻塞）
├─ scripts/smoke-test.ps1    # 冒烟测试（§0b 启动失败三用例预检：dsh 未安装/端口占用/单实例）
├─ scripts/deploy-local.ps1  # 构建产物同步到系统目录（`npm run deploy`；用户目录下的 exe 在本机必被降权）
├─ scripts/make-icons.mjs    # 主题徽章 + 应用图标生成（app 图标为圆角 24% 边长，重生成后跑 `npx tauri icon src-tauri/app-icon-source.png`）
├─ scripts/gen-bubbles.ps1   # 气泡位图：台词精灵表 `bubbles.png` + 审批气泡 `approval.png`（预渲染，规避 GDI 字体崩溃）
└─ src-tauri/
   ├─ src/main.rs            # 启动器：单实例/探活 3080/拉起 dsh web/导航 + 后端存活看门狗 + fleet 脉冲看门狗
   ├─ src/launcher_icon.rs   # 软件头像 → 窗口/托盘图标（读 appearance 线配置，1.5s 巡检跟随）
   ├─ src/pet_native.rs      # 桌宠 facade（共享类型 + NativePet API；实现见 pet_native/ 子模块）
   ├─ injected/theme-init.js # 构建产物（include_str! 注入，勿手改）
   └─ capabilities/          # 最小权限（core:default）
```

## DSH 插件：免费模型池（`plugins/dsh-free-model-pool/`）

> **官方 dsh 0.1.2-rc.1 适配（2026-09-05）**：四个插件与 `@miasaki/dsh-canvas` 已核对
> 并跟进官方 0.1.2 插件 API（peerDeps 对齐 `^0.1.2-rc.1`，canvas 清理已消失的
> `dsh-client-runtime` 依赖声明）。注意 0.1.2 的 `llm-pi-ai` 配置校验收紧：
> `settings.yaml` 里模型 id 不在官方 catalog 的平台必须显式声明 `api` 与 `baseURL`
> 才能整节通过校验（否则整节失效、免费模型池平台列表为空）。适配细节与排查记录见
> `design/CHANGELOG.md`。

检出免费模型并给出能力画像与适用性决策。**2026-09-22 起面板改挂「设置 → 模型」页底部**
（`settings.models.footer` 列表槽，模型页补丁声明并渲染的现成挂点），不再单独占一栏；
补丁缺席（未打 / 被升级覆盖）时自动回退自有 `settings.section`「免费模型池」栏，
两个目标互斥、失败日志只记一次（v0.3.0）：

- **多平台扫描**：扫描 `llm-pi-ai.providers` 中**带 baseURL 的全部 OpenAI 兼容平台**（OpenRouter、
  自建网关、微信 chatapi 等），一个面板统一管理；新增平台只需在设置 → 模型页配置，
  面板自动出现，零插件改动。
- **免费判定（分层）**：`:free` 后缀 → 定价字段全零 → 名称含「免费/free」；三者任一命中即收录，
  每个模型标注命中依据与警告（预览模型随时下线、缺 tool_choice 需实测等）。
- **能力画像**：从端点自述（`supported_parameters` / `architecture.modality` / `reasoning` /
  上下文 / 输出上限）判定 工具调用、tool_choice、推理、编码、视觉、结构化输出、超长上下文、
  子代理可用性（门槛 = tools + tool_choice），产出「子代理可用 / 仅问答、批处理、需实测」三档 verdict。
- **决策摘要**：面板顶部给出 最佳子代理 / 编码类 / 超长上下文 / 多模态 四个快捷决策，
  子代理后端切换按钮直接使用最佳推荐。
- **写入配置**：`ctx.settings.update('llm-pi-ai', …)` 深合并写入目标平台 `models`
  （保留其他 provider 与字段），DSH 设置系统校验 schema；`/freepool-api/subagent` 重写三预设
  `tool-subagent` / `tool-subagent-fork` 的 `agentOptions`（provider 必须是已登记路由键）。
- **settings 读取双轨（v0.3.1，2026-09-23）**：DSH 0.1.7 重写设置机制，`ctx.settings.get(ns)`
  在全树移除（服务还在、`inject: ['settings']` 仍过得去），读取改走 `describe()`
  （profile 条目 Config 投影，`ns` = 条目 id）。`lib/settings-read.js` 按 `typeof get`
  探针双轨：≤0.1.6 走 `get`、0.1.7+ 走 `describe`，写路径两代同名同义（`update` 深合并，
  0.1.7 只受理 volatile 字段——`providers` 正是）。不双轨时 0.1.7 上面板整块报
  `ctx.settings.get is not a function`（线上实测）；配套评估见 shared-docs
  `dsh-0.1.7-upgrade-assessment-2026-09-23.md` §7.4。

安装（host 重启后生效）：`plugins/dsh-free-model-pool` 为 `file:` 依赖，被
`%USERPROFILE%\.dsh\profiles\web\package.json` 的 `dsh.profile.bundles` 引用；修改源码后需在
profile 目录 `pnpm install` 并把 `lib/*` 同步到 `node_modules`（pnpm file: store 缓存会滞后，
务必核对文件哈希）。client bundle 为手写 `window.__ModuleLoader__.load` 格式（本机无 tsdown），
勿用 JSX；面板经同源 `/freepool-api/*` JSON 路由与 host 通信（client bundle 无 `host.call`）。

## DSH 插件：桌宠设置面板（`plugins/dsh-pet-panel/`）

桌宠的配置入口，挂在 DSH「设置 → 桌宠」（`settings.section`，order 26）：

- **显示 / 隐藏开关**：桌面端原生分层窗口的显隐控制，状态持久化（pet.json `hide`），
  重启保持；隐藏后以**主题头像悬浮球**（当前主题头像 + 主题色环/外发光，悬停放大）作为恢复入口，
  点击即显示。
- **位置重置**：一键回到默认位置 (1200, 500) —— 桌宠被拖丢到屏幕外 / 拔掉副屏后找回。
- **状态回显**：面板挂载时发 `cmd=pet-state`，桌面端 eval `miasaki-pet-state`
  CustomEvent 回推当前 `hidden`，与显示/隐藏联动保持同步。
- **通信（零 host 职责）**：面板命令经主窗口 URL hash 通道
  （`#…&cmd=pet-show|pet-hide|pet-reset|pet-state&seq=…`，`history.replaceState`
  不触发刷新），由桌面端 hash watchdog 轮询执行（**基准 150ms**；拖窗期间自动提速至 33ms
  保证跟手；单次取用 ≥250ms 或连续失败则退避至 1000ms —— 见 CHANGELOG 2026-09-10(深夜·续)）；
  host 侧 `lib/index.js` 为空壳。
- **降级**：非桌面端（普通浏览器打开 DSH，无 `window.__MIASAKI_BOOTED__`）面板提示
  命令不会生效，不阻断设置页。

安装：同免费模型池 —— profile `package.json` 的 `dependencies` + `dsh.profile.bundles`
加 `dsh-pet-panel`（file: 依赖），profile 目录 `pnpm install` 后核对
`node_modules/dsh-pet-panel/lib/*` 与源码哈希一致；host 重启后生效。

## DSH 插件：会话日志下载入口迁移（`plugins/dsh-session-log-move/`）

把「Session 日志」下载按钮从**主界面会话头部**迁移到**轨迹页工具栏搜索栏左侧**：

- **主界面隐藏**：`conversation.session.header.utilities` 同 id（`session-log-download`）
  替换为空条目（平台 slot 语义：同 id 复用即替换该 cell），官方「Session 日志」胶囊不渲染。
  **2026-09-22 起为降级行为**：DSH 0.1.5-rc.1 官方自带
  `@deepseek-ai/dsh-session-log-export` 已自行注册同一 id，本插件的替换**永远冲突**——
  此时判定永久失败（不再重试、错误日志只记一次），官方按钮保留（v0.1.1）；
- **轨迹页注入**：`[role=toolbar]` 内搜索框容器左侧插入同功能按钮（toolbar 无官方 slot，
  DOM 注入 + MutationObserver + 500ms 重试兜底约 30s，重渲染冲掉自动补挂）；
- **下载链路**：复用官方 `sessionLogDownload` 服务（缺失降级 `<a download>` 触发
  `/api/session.export?sessionId=…&includeDescendants=true` 流式下载）；
- **反馈**：按钮内联文案（准备中 / 已开始下载 / 下载失败，重试）自动复位；
- 全部副作用挂 `ctx.effect` disposer，停用即完全复原。host 半空壳无职责。

先行动态插件验证（2026-09-07）通过后按此形态固化；设计见
`design/session-log-download-relocate.md`，安装同 token-monitor profile bundle。

## DSH 插件：模型连通性探测（`plugins/dsh-model-probe/`）

设置页「测试连通性」按钮的**真实可用性探测**（host only，无 client 半侧）。配套补丁
[`patches/dsh-client-ui-settings-models/`](patches/dsh-client-ui-settings-models/README.md)
负责按钮侧调用，本插件负责「问对的问题」。设计见 `design/model-probe-v2.md`。

**解决什么**：v1 的按钮复用官方目录探测（`GET {baseURL}/v1/models`），问的是
「网关能不能列出模型目录」，而按钮语义是「这个模型能不能用」。StepFun Step Plan
这类只兼容 `POST /v1/messages` 的订阅网关对 `/v1/models` 回 401 —— 于是**能正常对话的
模型被报成认证失败**。v2 改为发真实对话请求。

- **两段式，默认零消耗**：① 握手档发一个必然被参数校验拒绝的请求（空 `messages`），
  401/403 = key 坏（**到此结束，不产生任何生成**）；400 = 鉴权已通过。
  ② 仅在鉴权通过后才发 `max_tokens: 1` 的生成请求确认端到端可用。
- **结果六分类**：`ok`（附耗时）/ `unauthorized` / `model-missing` / `quota` /
  `rate-limited` / `timeout` / `unreachable` / `bad-request` / `server-error` /
  `unknown` / `unsupported` / `no-credential` / `no-endpoint` / `no-model`。
  host 只回稳定 `kind`，文案在客户端本地化（中英各一份）。
- **协议覆盖**：`anthropic-messages`（`POST {root}/v1/messages`，与对话路径同规则）、
  `openai-completions`、`openai-responses`；其余协议明确回 `unsupported`。
- **凭据**：表单临时 key → `credentials.resolve(apiKeyEnv)` → 进程环境变量；
  **key 永不回传**（`detail` 两遍脱敏）。
- **settings 读取双轨（v0.2.1，2026-09-23）**：已保存行的 `baseURL` / `api` /
  `apiKeyEnv` 从 `llm-pi-ai` 配置解析（请求体只带草稿值）。DSH 0.1.7 移除
  `ctx.settings.get(ns)` 后改走 `describe()`（profile 条目 Config 投影）；
  `lib/settings-read.js` 按 `typeof get` 探针双轨（≤0.1.6 走 `get`、0.1.7+ 走
  `describe`）。不双轨时 0.1.7 上已保存行的探测静默退化成 no-credential /
  no-endpoint（线上实测）；配套评估见 shared-docs
  `dsh-0.1.7-upgrade-assessment-2026-09-23.md` §7.4。
- **信任栅栏**：Host / Origin / `sec-fetch-site` 三层（与 sidebar、canvas 的 `/api` 栅栏同构）。
- **无副作用**：除一次极小模型调用外不改配置、不写文件。
- **降级**：路由 404（插件未装 / host 未重启）时补丁自动回退 v1 目录探测并附提示，
  因此本插件是补丁的**可选**依赖，缺失不会让按钮失效。

路由：`POST /model-probe-api/probe`、`GET /model-probe-api/health`、
`POST /model-probe-api/capabilities`（v0.2.0 批量能力查询：读 `llm.resolveModelInfo`，
零提供商请求、不需要凭据，供模型页能力徽标；`llm` 缺失或 404 时徽标静默缺席）。

安装：同其它 profile bundle —— `%USERPROFILE%\.dsh\profiles\web\package.json` 的
`dependencies` + `dsh.profile.bundles` 加 `dsh-model-probe`（file: 依赖），
profile 目录 `pnpm install`，**host 重启**后生效。

自证：`node plugins/dsh-model-probe/test/probe.test.js`（20 例判定表单测，纯逻辑无网络）+
`node plugins/dsh-model-probe/test/settings-read.test.js`（12 例：双轨 helper 契约 10 +
probeModel 存储档案解析接线 2），已并入 `node scripts/verify-all.mjs desktop`。

## 设计规范

- 总体设计与三主题规范：`design/themes.md`
- DSH 令牌面（构建校验依据）：`design/token-surface.txt`
- 启动可靠性（失败恢复页/健康标记）：`design/bootstrap-reliability.md`
- 启动加载 2.0（闪窗根治 + 内嵌启动终端日志流，2026-09-22 定稿）：`design/boot-loading-terminal.md`
- 模型连通性探测 v2（两段式探测 / 分类表 / 降级策略）：`design/model-probe-v2.md`
- 拖拽上传附件到会话（Tauri 默认拖放拦截根因 / 一行修复 + 注入层安全网，2026-09-22 定稿）：`design/drag-drop-attachment-upload.md`

## 行为约定

- 关闭窗口 → 弹窗确认（标题栏 X / Alt+F4 / 托盘「退出」/ 桌宠「退出应用」统一入口，弹窗为三主题自绘）；
  选择「关闭应用」会**停止由桌面端拉起的 DSH 服务**（下次双击自动重新拉起）；「取消」仅收起弹窗。
  用户**手动启动**、或端口已就绪时接入的 DSH 服务不会被停止（非本应用 spawn 的后端不触碰）。
  重复触发关闭请求仅重新显示确认弹窗；仅 Alt+F4 连击（前端无响应）时兜底强制退出、后端保持运行。
- **后端断连自愈（2026-09-23）**：页面就绪后常驻「后端存活看门狗」（2s 探测：自拉后端进程
  存活 + 3080 端口监听）。后端意外死亡（被外部杀掉 / 撞上正在退出的旧服务 / 采用的外部后端
  退出）时自动重拉 `dsh web`，失败按 2s→30s 退避重试；文档从未加载成功过（错误页）时重拉后
  补一次重新导航，活页面则由 DSH 前端自带重连静默恢复（鉴权 cookie 持久有效，无需刷新）。
  关闭前的保险：若 3080 上仍有**本应用进程树之外的客户端**（浏览器等）连接着后端，
  关闭应用时**保留后端不杀**（探测失败按旧语义照停，最坏不劣化）——共享后端不应被
  「关桌面端」拖走，曾致浏览器页面断连（事故复盘见 CHANGELOG 2026-09-23）。
- **启动画面与 DSH 页画面统一**：loading 页与 DSH 页共用同一主题标题栏（本地页不出现主题切换条/水印），
  配色与纹章随上次选择主题（pure/zafkiel/kurkuriel）；主题偏好由 DSH 页同步持久化
  `%APPDATA%\com.miasaki.desktop\prefs.json`，下次启动注入启动画面。
- DSH 启动日志：`%LOCALAPPDATA%\miasaki\server.log`。
- 主题为「明暗锁定」：刻刻帝强制暗色、狂狂帝强制亮色、原版跟随 DSH 自身设置。
- 二次启动由单实例锁接管，只唤起已有窗口。

## 启动故障恢复

启动失败（dsh 未安装 / 端口被占用 / DSH 拉起异常）时，加载页会显示恢复动作组：

- **检查 dsh** — `where dsh` + `dsh --version` 探测结果；
- **打开终端** — 独立 cmd 窗口（可手动运行 `dsh web --no-open` / `netstat` 排查）；
- **打开日志目录** — `%LOCALAPPDATA%\miasaki\`（server.log / pet.log / bootstrap.json）；
- **导出诊断** — 聚合日志尾部与状态文件到 `%APPDATA%\com.miasaki.desktop\diagnostics-<ts>.txt`。

每次启动的进度落盘于 `%LOCALAPPDATA%\miasaki\bootstrap.json`（启动尝试阶段/失败原因/上次成功时间），
下次启动若上次失败会提前提示。设计：`design/bootstrap-reliability.md`（借鉴
deepseek-harness-desktop 启动恢复 + 健康标记 + 可靠性矩阵思路）。

**启动链容错加固（2026-09-23）**：

- **主窗口可见性兜底**：窗口以 `visible(false)` 建出、由 `on_page_load` 回调 `show()` 显示；
  若 WebView2 对不可见宿主的加载优化导致回调始终不触发，窗口将永不显示。现于建窗后 800ms
  检查一次「窗口是否可见」（判据是 `is_visible()` 本身，**不是**页面就绪位 `PAGE_UP`），
  仍不可见则补一次 `show()` 并写 `pet.log`；正常路径判据为假、不动作，天然幂等；
- **导航失败不再静默**：`MIASAKI_REMOTE` 非法或 WebView 拒绝导航时，原实现（`expect` / `let _ =`）
  会让 release 直接 abort（`Cargo.toml` 的 `panic = "abort"`）、或让加载页永远停在
  「已就绪，正在进入…」。现统一走容错分支：落盘 + 状态栏可见反馈 + 放出「重试」按钮
  （与后端看门狗 `if let Ok(url)` 同一口径）；
- **90s 未就绪提示**：文案不再只归因端口占用，并列提示「dsh 拉起后立即退出」
  （spawn 成功 ≠ 进程存活）。

**第二轮复审修复（2026-09-23，P2-B + 三项 P3）**：

- **兜底链不再覆写预置 cookie**：`themes/src/00-boot.js` 原实现每次文档加载都用硬编码 secret
  重签 `dsh-auth-*`，会把 loading 页用 `credentials.yaml` 真 secret 预置的有效 cookie 换成
  无效值（secret 漂移时）⇒ 401 → reload → 新文档再签错 → **无限刷新**。现在：已有 cookie 则
  **按原值续写 `Max-Age`**（保留「session → 持久 cookie」升级，值一字节不动），无 cookie 时
  才用兜底 secret 签名；
- **401 熔断**：`sessionStorage` 跨文档计数，最多 reload 3 次，超限**停止重载**并在页面上
  显示可见提示（原因 + 处理指引）；到上限前先清掉已失效的 cookie，给兜底签名最后一次
  自愈机会；计数只在确认到达非 401 文档时复位；
- **兜底日志三态**：`is_visible()` 的 `Err`（窗口已销毁，如 800ms 内关窗）不再被记成
  「仍不可见」，消除误导归因；
- **token-monitor 刷新时间戳**：全局浮窗「更新于」只在刷新**成功**后推进（失败不再谎称
  刚更新过）；
- **新增语法闸门**：`verify-all desktop` 现含 `syntax injected/theme-init.js`（注入脚本是
  每个文档都跑的代码，语法错＝实机整屏黑；分片跨片闭合，只有拼接产物能整体解析）；
- **新增行为闸门**：`themes/test/auth-cookie.test.js` 6 例 —— 从 `themes/src/00-boot.js` 的
  `@slice:auth-cookie` 段截出 IIFE，在 VM 里用假浏览器（cookie jar / sessionStorage /
  `crypto.subtle` / `location.reload`）驱动，钉死「已有 cookie 只按原值续期、绝不覆写」
  「401 reload 有跨文档上限、超限停止并显示提示」「document_start 不误清计数」三条契约
  （实机复现要造 secret 漂移 + 预置失败，成本高且危险）。**区分力已双向验证**：回退覆写判据
  → 用例 1 红；把上限改成 999 → 用例 4 红；还原 → 6/6 绿。

设计与验收见 `design/auth-cookie-prepinject.md` §2.4 / §3 / §5 第 6 条，变更记录见
`design/CHANGELOG.md` 同日「二轮复审」条。

### 鉴权 cookie 预置注入（2026-09-22 **已实施**，实机验收待用户）

**症状**：「启动后总出错，点一下刷新才能正常」——错误页是 401 纯文本页（`dsh web
authentication required; reopen the URL printed by dsh web.`）在深色窗口里的裸露渲染。
dsh web 每次重启都有新签名 cookie，首次 `GET /` 必然 401；9-05 的「进 401 页后自动 reload」
恢复链对 `text/plain` 文档的文本检测无保证，漏检即停住。

**修法（已落地）**：cookie 签名与写入**提前到 navigate 之前**（loading 页 Web Crypto 签名 →
invoke → Rust 经 Tauri 2 cookie API 写入 3080 域，navigate 前 3s 超时等待、fail-open），
首次 `GET /` 即带有效 cookie，401 不发生；00-boot.js 的检测→reload 链降级为加固兜底
（三级文本兜底 + 四轮检查 + 跨文档熔断，且**不再覆写**预置 cookie）。secret 改为从
`~/.dsh/.credentials.yaml` 动态读（失败回落硬编码），轮换不再要改源码。已随 release 构建
（47.8s 干净通过）替换 `dist/Miasaki.exe`。
设计与变更记录：`design/auth-cookie-prepinject.md`；验收清单见 `design/CHANGELOG.md` 同日条目。

## 启动加载 2.0 · 内嵌启动终端与闪窗根治（2026-09-22 设计定稿，未实施）

- **根治启动闪窗**：`cmd /C dsh web` 链路闪窗先归因（嫌疑矩阵 + Process Monitor 验证法），
  首选**绕开 cmd 直达 `node <bin.js> web --no-open`**（npm shim 入口解析），解析失败静默回落
  现行 cmd 链——零回归兜底；
- **启动终端内置**：dsh stdout 从「只写 server.log」改为 tee，实时进加载页——终端风日志流
  （默认折叠计数徽标 / 失败自动展开 / 环形缓冲）+ 探活→拉起→等待→就绪四阶段进度；
- **视觉升级**：三主题纹章旋转、扫描线、打字机光标（reduced-motion 全降级）；
  与失败恢复卡片 / 诊断按钮并存（日志流即失败现场）。

设计：`design/boot-loading-terminal.md`。与之配套的 appearance 线「DSH 首帧启动画」
（3080 首帧全屏 splash，2.5s 超时兜底不挡错误页）与两线契约见
`../dsh-miasaki-shared-docs/cross/boot-loading-2026-09-22.md`。
