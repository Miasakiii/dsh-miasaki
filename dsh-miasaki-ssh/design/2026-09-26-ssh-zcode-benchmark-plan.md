# SSH 线对标 zcode（zai-org/ZCode）调研与后续方案设计

> **状态**：**v1.2：P0×3 + P1-1 + P2×4 全部实施完毕**（用户两次拍板「按建议开工」「p2开工」）。
> P0-1 keepalive/错误词汇、P0-3 `lib/exec.js`、U2.2 SFTP 含降级链、P1-1 ssh config 导入、
> P2-1 U3 跳板（D4=② sock 注入）+ 本地转发、P2-2 A1 三工具（D2 默认 off）、
> P2-3 双栈边界、P2-4 真协议探针 8/8（归档 `_refs/scripts-archive/ssh-p2-probes/`）。
> 单测 153 → **276 例**、`verify-all ssh` 14/14 → **31/31**，实施记录见 [CHANGELOG](CHANGELOG.md)。
> **全部待重启 `dsh web` 后实机验收**（SFTP 往返 / 降级实机路径 / ssh config 导入 / 真跳板建连 /
> 本地转发实机 / `agentTools: true` 的工具注册与审批落点）。
>
> **参考克隆**：`_refs/zcode/`（zai-org/ZCode `main` @ `2026-09-24`，README 自称 v3.14.3；
> 6.8k stars，TypeScript pnpm monorepo）。`_refs/` 为归档区、不入库；文中所有 zcode 路径均相对该克隆。

---

## 0. 结论速览（TL;DR）

1. **形态不同、底层同源**。zcode 是智谱的 AI 编程工作台（agent harness），其 SSH 子系统的用途是
   **「把 agent runtime 部署到远程机器」**（上传资产 → 远端起 daemon → stdio over SSH）；
    本线是**「人的交互式 SSH 终端」**。上层目标不同，但底层同为 `ssh2` + Node
    （zcode ssh2 未锁版本实测 `packages/server/package.json`；本线锁 **ssh2 1.17.0**），
    **踩过的坑高度重合**，互相印证的价值大于照抄。
2. **双方独立踩中的同一批坑**（→ 说明这些是 ssh2 通病，本线已有的修复方向正确）：
    `tryKeyboard` 不开则新装 Ubuntu/Debian 密码登录必失败（我们 2026-09-26 修过，zcode 同样开着）；
    短命令 `exit` 早于 stdout `data`（zcode `execSimple` 只在 `close` 收尾、preflight 还给 50ms 排空窗口）；
    ssh2 默认 `readyTimeout` 20s 太短（zcode 显式 60s，我们握手预算 60s）；
    `client` 无常驻 `error` 监听会在连接抖动时炸 host 进程（zcode 常驻 + dispose 后 no-op sink）。
3. **zcode 没有的（是我们的强项或需自研）**：
    **host key 校验**（zcode 产品代码零 `hostVerifier`，只在验证脚本里 `StrictHostKeyChecking=no`）
    —— 本线 TOFU + known_hosts 保持不动，这是安全红线也是差异化；
    **端口转发 / 跳板**（zcode 无实现，`ProxyJump` grep 零命中）—— U3 需完全自研；
    **连接诊断**（zcode 无同类产品化功能，我们有 8 码 verdict + 出口 IP + 认证方式探测）。
4. **zcode 有我们没有的（本方案主体）**：SSH-level **keepalive**（15s×3）；
    **SFTP → exec pipe 降级链**（网关/跳板把 sftp 与 exec 落到不同文件系统视图时）；
    **`~/.ssh/config` 别名导入**（708 行解析器 + `ssh -G` 优先）；连接向导的
    **实时阶段日志 + 「收起 ≠ 关闭」语义**；**远端能力 preflight**（一条 exec 探 curl/wget/tar/sha256）；
    **docker sshd + `ssh -L` 真隧道**的验证基建。
5. **产出 11 项候选**：P0 × 3（连接健壮性三件套 / SFTP 降级链注入 / exec 前置工作）、
    P1 × 4（ssh config 别名 / 向导 UX / 诊断扩展 / 连接复用注册表模式）、P2 × 4
    （U3 跳板转发 / A1 `ssh_exec` / 双栈细节 / 验证基建升级）。
    **另立「明确不做」清单**（§7）：agent-over-ssh 部署链、WSL/Docker backend、去掉 TOFU 等，各附理由。

---

## 1. 调研对象与范围

| 项 | 值 |
|---|---|
| 仓库 | <https://github.com/zai-org/ZCode>（`main`，2026-09-24 推送，README 自称 **v3.14.3**） |
| 定位 | Z.ai（智谱）AI 编程工作台：桌面应用 + 浏览器 Web + 终端 Agent（TUI） |
| 结构 | pnpm monorepo：`packages/{desktop,web,server,zcode-server-cli,ui,services,shared,rpc,client,provider,provider-node}` + `apps/zcode-cli` + `harness/` |
| 本线关注面 | `packages/server/src/remote/`（SSH 后端族）、`packages/shared/src/`（协议）、`packages/ui/src/SSHDialog.tsx`（连接 UI）、`packages/desktop/src/host/windowRemoteConnectionRegistry.ts`（连接注册表）、`harness/remote/`（测试 sshd 镜像）、`packages/zcode-server-cli/scripts/verify-remote-ssh.mjs`（远程验收脚本） |

**范围声明**：本方案只对标「SSH 连接与文件传输」层；zcode 的模型调用、会话协议、插件生态不在范围内。

---

## 2. zcode 远程 SSH 架构解剖

### 2.1 总体链路

```
UI 向导（SSHDialog.tsx：kind→settings→connecting→directory 四步）
  │  buildRemoteTarget()  →  RemoteTarget{kind:'ssh', host, port, username,
  │                            password|privateKeyPath+passphrase, sshConfigAlias?}
  ▼
server: createRemoteBackend(target) ──► SSHBackend（implements IRemoteBackend）
  │  buildSSHConnectConfig()（sshAuth.ts：readyTimeout 60s / keepalive 15s×3 /
  │                            tryKeyboard=有密码时 / agent 仅显式传入才启用）
  ▼
SSHBackend 能力面：detect()（uname -s/-m + /proc ostype 防 Darwin 伪装）
                 exec()（POSIX 包装后的 stdio channel）
                 upload()（mkdir -p → SFTP → 失败记 exec-only → cat > file 降级）
                 sftp()（备用通道）
  ▼
部署链：preflight（探远端 curl/wget/tar/sha256）→ 资产上传（SFTP/exec pipe，进度节流 1s/5%）
       → 远端起 daemon → handshake（跳过 banner/motd 逐行找 zcode-hello JSON 行）
```

与我们线的对应：我们的 `lib/runtime.js`（ssh2 Client + shell channel + 回放环）≈ zcode 的
`SSHBackend` 的 exec/sftp 面；我们的 `index.js` REST/WS ≈ zcode 的 server 路由族。

### 2.2 连接与认证（`packages/server/src/remote/sshAuth.ts`，126 行）

| 维度 | zcode 口径 | 本线现状（`lib/runtime.js`） | 判定 |
|---|---|---|---|
| readyTimeout | 显式 **60s**（注释：默认 20s 公网弱网误判） | `HANDSHAKE_BUDGET_MS`（60s，与指纹确认窗口同一预算） | **对齐** |
| keepalive | `keepaliveInterval 15s` + `keepaliveCountMax 3`（防 NAT/防火墙静默断开、stdio channel 不 close 导致 UI 卡 loading） | **未设置** | **差距 → P0-1** |
| tryKeyboard | 有密码即开，同一密码回填所有 prompt | 有密码即开（2026-09-26 修） | **对齐** |
| agent | **仅显式传入才用**；带密码时默认**不**带 `SSH_AUTH_SOCK`（否则公钥阶段先耗尽 MaxAuthTries，密码永远进不了认证） | 仅 `auth.method==='agent'` 时用（Windows `\\.\pipe\openssh-ssh-agent` / `SSH_AUTH_SOCK`） | **对齐**（我们按主机记录显式选择，同样不吃隐式 agent 的亏） |
| 错误归一化 | `level:'client-authentication'` → 「认证失败请检查用户名密码私钥」；`level:'client-timeout'` → 握手超时指引；私钥口令两种模式（缺口令 / 口令错误）→ 产品语义文案，原句保留 | `classifyError()` 已有 `HOST_NOT_FOUND/HANDSHAKE_LOST/CONNECTION_RESET/TIMEOUT/AUTH_FAILED…` 词汇表（2026-09-26 大批扩充） | **基本对齐**，词汇表互相补 (§4-P0-1 有两条可补) |

### 2.3 exec 通道细节（`ssh-backend.ts` 的 `exec`/`execSimple`）

- **POSIX 包装**：`buildPosixShellExecCommand(command)` 把所有 exec 包进 `/bin/sh` ——
  注释原委：SSH exec 先交给远端默认 shell，**fish 会把 `download=` 等 POSIX 语法当错误**。
- **exit/data 时序**：短命令场景 ssh2 可能先 `exit` 再异步派发 stdout `data` ⇒ **只在 `close` 统一收尾、
  优先用 `exit` 记录的退出码**，否则 `detect()` 的 uname 偶发识别为空。preflight 另加
  **50ms 排空窗口**兜底 stdout 不触发 end/close 的后端实现。
- **错误事件常驻 + dispose sink**：ready 之后底层抖动 ssh2 仍发 `error`，无常驻监听会
  uncaughtException 崩 host；dispose 后的迟到事件静默吞掉（no-op sink），不移除过早。
- **HOME 解析**：`printf %s "$HOME"` 一问，`resolvePosixHomePath()` 展开 `~`（SFTP 前置）。

### 2.4 SFTP 与上传降级链（本线 U2.2 最需要的一段）

`SSHBackend.upload()` 的完整链路：

```
mkdir -p <dir>（先证明 shell 视图可写）
  → uploadViaSftp（createReadStream → sftp.createWriteStream，进度 onProgress + 节流 1s/5%）
  → 失败判定 uploadFailureKind ∈ {sftp-session, sftp-write}
      → 记住 execUploadOnly=true，整条 backend 后续不再试 SFTP
      → uploadViaExec：mkdir -p … && cat > <file>，本地 readStream pipe 进 stdin
```

注释里的两个关键事实：

1. **「某些网关/跳板 SSH 会把 exec 与 SFTP 落到不同的文件系统视图」** —— `mkdir -p` 成功但
   SFTP 写同一路径报 `NO_SUCH_FILE`。不降级就会把「网关不支持 SFTP 直写」误判成连接失败。
2. **失败瞬间必须停掉两端 stream**，否则本地 read stream 继续读到 100%，UI 在已切 exec pipe 后
   还刷虚假进度。

配套工具（`sshUploadProgress.ts`）：SFTP status code 词汇表（`0 OK / 2 NO_SUCH_FILE /
3 PERMISSION_DENIED…` 映射成可读标签）、节流 reporter（1s 或 5% 或到达终点；force 去重）、
`AbortSignal` 取消（`AbortError` 语义）、总字节未知时降级文案。

### 2.5 host key：zcode 完全不做（产品代码）

grep `hostVerifier|hostKey|checkServerIdentity` 全库：**产品代码零命中**；
`remoteSshHostKey.ts` 的 `buildSshRemoteHostKey()` 是 UI 侧「同一主机身份键」
（`["ssh:v1", host小写, port, username, authKind, 归一化keyPath]` 的 JSON），用于连接复用去重，
与 known_hosts 无关。测试脚本用 `StrictHostKeyChecking=no`。

**⇒ 本线 TOFU + known_hosts 保持不动**（红线：安全三道围栏的同级物）。此项列为「明确不借鉴」。

### 2.6 `~/.ssh/config` 别名导入（`packages/services/src/system/sshConfigAlias.ts`，708 行）

- **双通道解析**：`ssh -G -F <config> -o BatchMode=yes <alias>`（并发 3、单 alias 1.5s 超时）优先；
  **无 ssh 可执行文件或失败时回退自研解析器**（`Host` 块 / `Include` glob / 注释 / 引号 / 转义 /
  `%d` 展开 / 最大深度 8 / 上限 200 alias / 30s 缓存）。
- **Windows 特判**：ssh.exe 发现顺序 = `PATH` → `%WINDIR%\System32\OpenSSH` → `ProgramFiles\OpenSSH`
  → `ProgramFiles\Git\usr\bin` → `ProgramFiles(x86)\Git\usr\bin`。
- **两条反直觉教训（代码注释）**：① `ssh -G` 会返回**默认** identityfile（`~/.ssh/id_rsa`），
  直接采用会把「密码登录」误判成「密钥登录」⇒ privateKeyPath 只信 config 显式声明；
  ② Windows 路径里的 `\` **不是转义符** ⇒ 仅在确为转义分隔符/引号时解义，其余保留字面反斜杠。
- 通配 pattern 匹配用 escape 后拼正则（防 Teleport 的 `Host *.teleport-*.example.com` 拼出非法正则）。

### 2.7 UI 连接向导（`packages/ui/src/SSHDialog.tsx`，639 行）

四步向导 + 侧边步骤条：**kind**（SSH/WSL/Docker）→ **settings**（host/port/username、
认证方式渐进显示、**sshConfigAlias 下拉**、错误区分「表单校验 warning」与「连接失败 destructive」）
→ **connecting**（**实时阶段日志** `useRemoteConnectionLogs(requestId)` + 重试 + 返回）
→ **directory**（连上后浏览远端目录 + skill/MCP/plugin/agent 同步选择）。

三个值得借的交互语义：

1. **「收起」≠「关闭」**：连接中可收起弹窗（**不取消后台连接**），从入口恢复当前步骤；
   关闭才走确认 + `cancelPendingRemoteConnection(requestId)`。
2. **requestId 取消**：每次连接一个 uuid，取消按 requestId 精确命中 pending 会话。
3. **并发入口守卫**：React 还没来得及 disable 按钮时，快速重复点击会起多个 SSH 进程
   ⇒ 事件入口再查一次 loading。

### 2.8 连接注册表（`packages/desktop/src/host/windowRemoteConnectionRegistry.ts`，786 行）

把「物理连接」与「逻辑会话」彻底分开的状态机：

- **连接键** = `ssh:${buildSshRemoteHostKey(target)}`（host 小写/port/user/authKind/归一 keyPath）
  ⇒ **同目标复用同一连接**（entry 级），logical session 只挂接。
- **状态机**：entry `connecting|online|closing|failed|disconnected`；session 同构 + `sourceAvailability`。
- **取消语义矩阵**：最后一个 waiter 取消时 —— SSH 且 connecting ⇒ **立即按对象身份退休旧 entry**
  （否则重连继续等已 aborted 的 readiness 并沿用上次凭据）；SSH 且 online ⇒
  **保持连接作为窗口缓存**，只迁 logical owner；WSL ⇒ idle TTL 60s 后 dispose。
- **generation**：workspace runtime 每次易主 +1，旧 release 未完成时新一代 acquire 要等
  （fail-closed 而非踩过未完成清理）。

与我们线的对应：我们已有 `connId → runtimeId → shellId` 三层身份 + 一次性 30s attach 票据 +
写权单写多读 —— **身份分层已对齐**；注册表的价值在「跨标签/跨窗口的同主机连接复用语义」与
「取消时精确退休旧 entry」两处（我们 `connect()` 已有 `byProfile` 替身逻辑，可对照补强）。

### 2.9 验证基建（`packages/zcode-server-cli/scripts/verify-remote-ssh.mjs`，311 行）

「docker 起真 sshd（一次性 ed25519 密钥只进容器）→ scp 发行包 → 远端起 daemon →
**本机 `ssh -L` 隧道** → 验证 HTTP/WS 升级合同 / capability 一次性票据（重放 401）/
node-pty 真 spawn / 生命周期 status→stop」全链真协议验收。`--keep` 留容器供手工调试。

对我们 **U3（端口转发）验收**的直接价值：这套「真 sshd + 真隧道」骨架可以改造成
「本线 ssh2 客户端 ↔ 假 sshd 之间拉真 `direct-tcpip` 转发，再打一个真 echo 服务」的验收探针。

---

## 3. 与本线逐项对照总表

| # | 维度 | zcode 做法 | 本线现状 | 判定 | 落点 |
|---|---|---|---|---|---|
| 1 | 握手超时 | 60s 显式 | 60s（与指纹预算共享） | 对齐 | — |
| 2 | keepalive | 15s×3 SSH 级 | 无 | **差距（小）** | P0-1 |
| 3 | tryKeyboard | 有密码即开 | 同 | 对齐 | — |
| 4 | agent 隐式启用 | 禁用（有密码时） | 不隐式（显式选择才用） | 对齐 | — |
| 5 | host key | **不校验** | TOFU + known_hosts + 变更拒绝 | **我们更强** | 保持 |
| 6 | 错误归一化 | ssh2 level → 产品文案 | classifyError 词汇表已 12+ 码 | 基本对齐，补 2 条 | P0-1 |
| 7 | exec shell 包装 | 一律 `/bin/sh` | 无 exec 面（A1 未做） | 需前置工作 | P0-3 |
| 8 | exit/data 时序 | close 收尾 + exit 码优先 + 50ms 排空 | 无 exec 面 | 需前置工作 | P0-3 |
| 9 | sftp 失败降级 | sftp→exec pipe + exec-only 记忆 | U2.2 规划中**未含降级** | **差距（中）** | P0-2 |
| 10 | 传输进度 | 节流 1s/5% + 速度 + 总量未知降级 | U2.2 规划传输队列未定进度口径 | 差距（小） | P0-2 |
| 11 | ~/.ssh/config | 708 行解析器 + ssh -G | 无 | **差距（产品级）** | P1-1 |
| 12 | 连接中反馈 | 实时阶段日志 + 收起不取消 | 状态点 + 横幅（无分阶段日志） | 差距（中） | P1-2 |
| 13 | 远端能力探测 | preflight 一条 exec 探工具 | 连接诊断（DNS/TCP/banner/auth） | 部分差距 | P1-3 |
| 14 | 连接复用/取消语义 | 注册表状态机 + 精确退休 | 三层身份 + byProfile 替身 | 基本对齐，补取消语义 | P1-4 |
| 15 | 端口转发/跳板 | **无** | 无（U3 未动） | 平手 → 自研 | P2-1 |
| 16 | 验证基建 | docker sshd + ssh -L 真隧道 | 假 sshd 探针（ssh2.Server）已多轮 | 我们已有同款思想，补隧道形态 | P2-4 |
| 17 | banner/motd 跳过 | handshake 逐行找 JSON 行 | 无 exec 面 | 需前置工作 | P0-3 |

---

## 4. 候选方案明细

### P0-1 连接健壮性三件套（预计 0.5 天，风险低）

| 子项 | 设计 | 验收判据 |
|---|---|---|
| keepalive | `lib/runtime.js` 连接配置加 `keepaliveInterval: 15_000`、`keepaliveCountMax: 3`；常量与 `HANDSHAKE_BUDGET_MS` 并列注明出处（zcode 同款 + 注释：NAT/防火墙静默断开时 stdio channel 不一定 close） | 单测锁定配置存在；探针：假 sshd 侧模拟静默丢弃，45s 内 runtime 报 `CONNECTION_LOST` 类错误而非永久挂死 |
| 错误词汇对齐 | `classifyError()` 补两条：① `ECONNREFUSED` 已覆盖（`TCP_REFUSED` 在 diagnose，connect 路径核对一遍）；② ssh2 `level:'client-timeout'` 文案与握手预算数字一致 | 畸形错误对象表进单测 |
| 错误事件常驻复核 | 核对 `RuntimeConn`：ready 前后 `error` 监听是否常驻、dispose 后迟到事件是否 no-op（zcode 踩过：不常驻会炸 host） | 故障注入：ready 后对端 RST，runtime 转 error 态且 host 进程不退出 |

### P0-2 U2.2 SFTP 注入 zcode 降级链（预计 1 天，风险中）

在既有 [U2 规划 §4.2](../2026-09-15-ssh-u2-plan.md) 的 REST 流式 + host 零本机 IO 大框架**不变**的前提下补：

1. **协议层降级**：`lib/sftp.js` 的 `session`/`write` 失败带 `kind` 标记（`sftp-session`/`sftp-write`），
   连接级记忆 `execOnly`，后续传输走 `exec('mkdir -p … && cat > file')` pipe（复用 zcode 判据：
   网关/跳板的 exec 与 sftp 文件系统视图不一致）。
2. **路径前置**：`resolveRemotePath()` 先 `printf %s "$HOME"` 展开 `~`，再 `realpath` 规范化
   （与 U2 规划 §10 待决策的 `lib/paths.js` 合并落地）；所有远端路径进 shell 前过 POSIX 引用函数
   （新建 `lib/posixQuote.js`，A1 共用）。
3. **进度口径**：传输队列进度 = 节流 1s 或 5% 或终点，带瞬时速度；总量未知时降级文案；
   失败瞬间停两端流（防虚假进度）。
4. **status 词汇表**：SFTP 数字 code → `NO_SUCH_FILE / PERMISSION_DENIED / NO_CONNECTION…` 可读标签，
   进 `classifyError` 同级。
5. **取消语义**：`AbortSignal` 贯穿；上传/下载中断后清理 SFTP 会话引用。

**验收**：假 sshd 探针新增「sftp session 失败 → 自动走 exec pipe 成功落盘」「sftp write 失败同理」
两景；进度节流纯函数单测；`~` 展开与引用的畸形路径表单测。
**注**：真实广域网带宽竞争仍留 U2.2 既有门槛（真实主机补验，见 U2 规划 §12.5）。

### P0-3 exec 前置工作（预计 0.5 天，风险低）—— A1 `ssh_exec` 的地基

一个新模块 `lib/exec.js`（或者直接落在未来的 `lib/tools.js`），一次性把 zcode 用教训换来的三件事固化：

1. `buildPosixShellExecCommand()`：所有 exec 包 `/bin/sh`（fish 等非 POSIX 默认 shell）。
2. **短命令收尾协议**：`close` 统一收尾 + `exit` 码优先 + 50ms 排空窗口（`scheduleCloseFallback` 同款），
   单测用「先 exit 后 data」的假 channel 锁死。
3. **banner/motd 跳过**：逐行扫描 stdout，非协议行原样透出但不参与协议判定（handshake.ts 同款思想）。

**验收**：假 sshd（真 ssh2.Server）上跑「uname 输出被 motd 行包裹」「exit 早于 data」两景。

### P1-1 `~/.ssh/config` 别名导入与主机建议（预计 1.5 天，风险中）

- `lib/sshConfig.js`（host 半）：**先 `ssh -G`（并发 3、1.5s 超时、Windows ssh.exe 四级发现），
  失败/缺失回退自研解析器**；alias → `{ host, port, username, privateKeyPath? }`；
  30s 缓存；`*`/`!`/通配 pattern 不当 alias；**privateKeyPath 只信 config 显式 IdentityFile**
  （不信 `ssh -G` 默认值，否则密码登录被误判成密钥）。
- 入口：新建/编辑主机弹窗加「从 ssh config 导入」下拉（选中即回填 host/port/user/key 路径）；
  连接库新增 `source: 'ssh-config'` 只读标记（导入的主机在 UI 上标出来源，可断开链接）。
- **不做**：`ProxyJump`/`Match` 全量语义（导入时跳过含跳板的 alias 并在 tooltip 说明）——
  跳板属 U3，落地前只导「直连可用」的 alias。
- **安全口径**：解析只读 `~/.ssh/config`，不写、不外传；`~` 展开限定 home 目录。

**验收**：畸形 config 样本表（注释/引号/转义/Include  glob/Windows 路径/循环 Include/通配 Host）
→ 解析结果快照单测；无 ssh.exe 环境（PATH 清空）走回退路径的集成测试；别名导入的端到端
（POST 草稿 → 回填）。

### P1-2 连接向导 UX 借尸（预计 1 天，风险低）

把 zcode `SSHDialog.tsx` 的三个语义搬进我们的「新建/编辑主机」悬浮窗与连接流程：

1. **分阶段日志**：连接过程拆阶段（DNS/TCP → 握手 → 认证 → 指纹 → shell），进度条旁一个可展开的
   实时日志区（数据直接复用 `lib/diagnose.js` 的各阶段事实，不新增探测）。
2. **收起不取消**：连接中允许收起弹窗，连接在后台继续；状态栏与主机列表反映真实进度，
   再次打开恢复同一流程。**关闭才取消**（`cancelConnect(requestId)` 语义）。
3. **requestId**：每次 connect 尝试签发 requestId，取消/重试按 id 精确命中；
   事件入口加并发守卫（防 React 未及时 disable 时的双发）。

**验收**：慢握手假 sshd（握手延迟 3s）下：收起 → 后台完成 → 主机列表变「已连接」；
关闭 → 连接中止且 runtime 无残留；连点两次只建一个 Client（探针数 TCP 连接数）。

### P1-3 连接诊断扩展：远端能力速览（预计 0.5 天，风险低）

`lib/diagnose.js` 增加**可选**一节「远端环境」：复用既有 exec 前置（P0-3）发一条
`command -v` 探测（uname/curl/wget/tar/sha256sum + 默认 shell 探测 `$SHELL`），
在诊断面板展示。**默认仍不发任何凭据之外的东西**——它只在用户已连上（持票）时可用，
未连接的主机只显示「连接后可见」。

**验收**：假 sshd 上预置/不预置 curl 两景。

### P1-4 连接复用与取消语义对齐注册表（预计 1 天，风险中）

对照 `windowRemoteConnectionRegistry.ts` 复核我们的 `SshRuntime`：

1. **取消即退休**：连接中（connecting）被取消 ⇒ 旧 runtime 实例立即退休而非留在复用表
   （zcode 注释：否则立即重连会等已 aborted 的 readiness 并沿用上次凭据）。我们已有
   `byProfile` 替身逻辑，需核对「取消」路径是否同样退休。
2. **在线连接是缓存**：关闭最后一个标签 ≠ 断开（我们已如此），补一条显式断言锁死。
3. **同主机多 shell 上限 8** 与连接级 SFTP 会话的生命周期矩阵写进单测（shell 全关 →
   SFTP 会话仍活；断开 → 两者同死）。

**验收**：取消-重连竞态探针（取消后 50ms 内重连，断言新 Client 用新凭据且旧 Client 已 end）。

### P2-1 U3：跳板与端口转发（预计 3–4 天，风险高）——zcode 无参考，全自研

- **跳板（ProxyJump / 显式跳板机）**：ssh2 无内建 ProxyJump ⇒ 两条路：① 手工
  `socks5`/`direct-tcpip` 跳（ssh2-stream 支持 `forwardOut`，但完整实现要处理多跳链认证)；
  ② 复用我们线的连接拓扑：把跳板机也建模成一条 runtime，目标连接走其 `forwardOut`。
  设计决策需拍板（见 §8-D4）。
- **本地/远程/动态转发**：`direct-tcpip` / `tcpip-forward` / SOCKS5 三形态，
  DSH web 插件形态下只暴露「本地转发」（host 监听 127.0.0.1 端口 → 经 SSH 到远端目标），
  远程/动态转发价值低且暴露面大，建议不做。
- **UI**：主机编辑器加「转发」页（本地端口 → 远端 host:port 列表），状态栏可见；
  与 U2.2 SFTP 共用票据族（转发绑定 runtimeId，短 TTL）。
- **验收基建**：借 zcode `verify-remote-ssh.mjs` 骨架改造——假 sshd 上开
  `forwardOut` 到另一个本地真 echo 服务，断言字节往返 + 关闭后端口释放。

### P2-2 A1：`ssh_exec` 工具面（预计 2 天，风险高，红线密集）

设计已在 [Agent 化规划](2026-09-14-ssh-agent-driven-plan.md) 定稿（D1–D4）。zcode 增量：

- **执行模型照搬 P0-3**（POSIX 包装 + close 收尾 + banner 跳过）；
- **治理**参照其 `remoteDeployLock`：同一 runtime 的 exec 串行 + 单次超时 +
  输出上限（截断标记），命令分级沿用既有规划（只读白名单 / 审批门）；
- **audit 环**与 SFTP 共用（U2 规划决策 7 的 `lib/audit.js`）；
- **边界重申**：工具输出经审批回流给 Agent，不直接落地执行；任何密钥不进输出摘要。

### P2-3 双栈细节补强（预计 0.5 天）

- Windows agent pipe 已有；P1-1 落地时同步 Windows ssh.exe 四级发现（zcode 同款）。
- `splitHostPort()` 已有；补 `ssh config` 导入路径的端口校验同源（1–65535）。

### P2-4 验证基建升级（预计 0.5 天）

把散落的 ssh 探针收敛为 `scripts/` 级（**注意：不进构建链目录**，按线惯例放 `test/probes/`
或 `_refs/scripts-archive/` 风格）：一个「假 sshd 基座」+ 多场景注册（多 shell/写权/
票据/sftp 降级/exec 时序/转发），形态参照 zcode verify 脚本的 `ALL CHECKS PASSED` 汇总。

---

## 5. 分期与验收矩阵

| 阶段 | 内容 | 单测增量预估 | 实机/探针判据 |
|---|---|---|---|
| P0 | 三件套 + SFTP 降级 + exec 前置 | +25 例 | keepalive 探针 1 景、sftp 降级 2 景、exec 时序 2 景 |
| P1 | config 别名 + 向导 UX + 诊断扩展 + 取消语义 | +20 例 | 别名端到端、慢握手收起/关闭 2 景、取消竞速 1 景 |
| P2 | U3 转发 + A1 exec + 基建收敛 | +30 例 | 真隧道转发 1 景、exec 治理序列 |

每个 P0/P1 项都按线的既有纪律走：**故障注入/真协议探针先于宣称修复**，
`verify-all ssh` 全绿 + 重启 `dsh web` 后实机复验清单。

---

## 6. 风险表

| 风险 | 等级 | 缓解 |
|---|---|---|
| keepalive 与既有 viewer 重附着契约叠加产生双通道重连 | 中 | keepalive 只触发 ssh2 自身 error/close，重附着仍是 session.js 有界重试；探针验证「静默断开」只走一条恢复链 |
| SFTP exec 降级把权限问题误降级（cat > 也会失败但原因不同） | 中 | 降级判据只认 `sftp-session/sftp-write` 两类 kind（能力缺失），`PERMISSION_DENIED` 不降级、直接如实报 |
| ssh config 导入把含 ProxyJump 的 alias 导成直连必败 | 中 | 导入期跳过（tooltip 说明），U3 落地后再开放 |
| `ssh -G` 在低权限 Windows 上不存在 | 低 | 回退自研解析器（zcode 同款双通道） |
| 分阶段日志泄漏敏感信息（banner 里的主机名/内网域名） | 低 | 日志区仅本机可见，但按线纪律仍过一遍 `sec-fetch` 围栏 + 不记凭据；复制报告时给用户可见全集 |
| P0-3 exec 面提前落地后被 A1 改造导致返工 | 低 | 模块边界一次划清（`lib/exec.js` 只做通道语义，治理留 A1） |

---

## 7. 明确不做（及理由）

| 项 | zcode 做法 | 不做理由 |
|---|---|---|
| agent-over-ssh 部署链（上传资产 → 远端起 daemon → 远端跑 agent） | zcode 的核心架构 | 本线定位是**人的终端**；向远端部署并执行 runtime 超出红线（「插件不直接调模型 / 不改系统提示」的同级物：不向远端投放可执行物）。Agent 化走 A1 的 `ssh_exec` + 审批门，而非部署 |
| 去掉 host key 校验 | zcode 产品代码不校验 | 安全红线。TOFU + known_hosts 是本线对 zcode 的**优势项**，保持并考虑增强（如已知指纹变更时的强告警已实现） |
| WSL / Docker backend | zcode 三种 target | DSH web 插件形态（host 即用户机器）下价值低；本地终端由 sidebar 线覆盖，不做重复 |
| 远程目录浏览 + skill/MCP 同步向导 | zcode directory 步骤 | 本线 U2.2 SFTP 已覆盖「浏览远端文件」诉求；skill/MCP 同步是 DSH 另一层能力，不塞进 SSH 线 |
| 用户 asking「zcode 那样」的全盘照搬 | — | 形态决定需求：zcode 是「本机 IDE ↔ 远程 agent」；本线是「浏览器 ↔ 远程 shell」。取其踩坑经验与产品化细节，不搬架构 |

---

## 8. 待用户拍板决策项

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| D1 | P0 三件套是否本轮就做 | ① 只做 keepalive+词汇（最小） ② 三件套全做 ③ 并入 U2.2 批 | **②**（互相咬合，单切 keepalive 也要跑同一批探针） |
| D2 | `~/.ssh/config` 导入的深度 | ① 只导直连 alias（跳过 ProxyJump） ② 全量导入 + U3 后开放跳板 | **①**（与 U3 解耦，先交货） |
| D3 | 连接中反馈做到多重 | ① 分阶段日志 ② 仅进度条+阶段名 | **②**起步、**①**作为可展开区（P1-2 已按此设计） |
| D4 | U3 跳板实现路线 | ① ssh2 `forwardOut` 手工链 ② 跳板机也建模成 runtime（复用本线连接拓扑+票据） | **②**（与三层身份、票据、写权同构；① 的凭证管理会另起一套） |
| D5 | 本方案与 U2.2/SFTP 的开工顺序 | ① P0 先行、U2.2 随后 ② P0-2 直接并进 U2.2 | **②**（降级链本来就应该长在 U2.2 里，分开做会写两遍 SFTP 错误处理） |

---

## 9. 参考索引

**zcode（`_refs/zcode/`，归档区）**

| 文件 | 内容 |
|---|---|
| `packages/server/src/remote/sshAuth.ts` | 连接配置：60s 超时 / keepalive 15s×3 / tryKeyboard / agent 显式 / 错误归一化 |
| `packages/server/src/remote/ssh-backend.ts` | SSHBackend：ensureConnected / detect / exec / upload（SFTP→exec 降级）/ dispose |
| `packages/server/src/remote/sshUploadProgress.ts` | 进度节流 reporter + SFTP status 词汇表 |
| `packages/server/src/remote/detectEnv.ts` | 平台/架构归一（/proc ostype 防 Darwin 伪装） |
| `packages/server/src/remote/handshake.ts` | stdio 上行握手：跳过 banner/motd 逐行找协议行 |
| `packages/server/src/remote/create-backend.ts` | target → backend（ssh/wsl/docker 三态） |
| `packages/server/src/remote/remoteAssetPreflight.ts` | 远端工具探测（curl/wget/tar/sha256）+ 50ms 排空窗口 |
| `packages/services/src/system/sshConfigAlias.ts` | `~/.ssh/config` 别名：ssh -G 优先 + 自研解析回退（708 行） |
| `packages/shared/src/remoteSshHostKey.ts` | 同主机身份键（连接复用去重用，非 host key 校验） |
| `packages/shared/src/remoteTarget.ts` | SSHConnectOptions + `stripRemoteTargetSecrets()` |
| `packages/ui/src/SSHDialog.tsx` | 四步连接向导 + 收起/关闭语义 + requestId |
| `packages/desktop/src/host/windowRemoteConnectionRegistry.ts` | 连接注册表状态机（物理/逻辑分离 + 取消矩阵） |
| `packages/zcode-server-cli/scripts/verify-remote-ssh.mjs` | docker sshd + 一次性密钥 + `ssh -L` 真隧道验收 |
| `harness/remote/` | 本地测试 sshd 镜像（root/dev 双用户） |

**本线**

| 文件 | 对照点 |
|---|---|
| `lib/runtime.js` | 连接配置 / TOFU / 三层身份（P0-1 改这里） |
| `lib/diagnose.js` | 诊断 8 码 verdict（P1-3 扩展） |
| `design/2026-09-15-ssh-u2-plan.md` §4.2 | SFTP REST 流式大框架（P0-2 注入降级链） |
| `design/2026-09-14-ssh-agent-driven-plan.md` | A1 `ssh_exec` 定稿（P2-2） |
| `lib/store.js` `splitHostPort()` | 主机:端口拆分（P2-3 同源复用） |
