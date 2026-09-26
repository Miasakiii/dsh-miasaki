# CHANGELOG — dsh-miasaki-ssh

本文件记录 `dsh-miasaki-ssh/` 线的设计决策与变更。

## 2026-09-26 · A1 实机验收：真协议 sshd 上的工具面闭环（逮到 6 处真缺陷并修复）

**背景**：用户「SSH线A1 实测」。P2-2 落地后一直挂着「`agentTools: true` 的工具注册与审批落点待实机验收」——
本轮把这句话兑现，并**逮到六个只靠单测看不见的缺陷**（前四个属于「一上机必失败」级别）。

### 实测基座（归档 `_refs/scripts-archive/ssh-a1-live/`，不入库）

- `sshd.mjs`：**真 ssh2.Server**（真握手 / 公钥认证 / exec / shell channel），命令表应答，含
  `a1-race`（exit 早于 data）、`a1-fail`（非零退出 + stderr）、`a1-sleep`（超时）三个时序陷阱；
- `prepare.mjs`：一次性 ed25519 主机/客户端密钥 + **隔离 dataDir**（预置 `connections.json` 与
  `known_hosts.json` 的 TOFU 指纹），测试主机不进用户真实连接库；
- 实例：`dsh --profile web --patch a1-live.patch.yml --no-open --port 3099`（`agentTools: true` +
  隔离 dataDir）——**不改仓库默认、不动用户 profile 文件**；
- 探针：`selftest.mjs`（exec 通道 7/7）、`runtime-e2e.mjs`（host 半端到端 9/9）、
  `official-ask-check.mjs`（官方 cordis + `dsh-user-questions` 真服务 6/6）、
  `official-tools-check.mjs`（官方 `dsh-tools` 注册表 3/3）。

### 实机结论（三条证据链，缺一不算过）

| 判据 | 证据 |
|---|---|
| 三工具真进模型工具面 | 会话 `request/header` 的 54 个工具里含 `ssh_exec` / `ssh_hosts` / `ssh_session_read` |
| L0 免审批直通 | `uname -a` 台账 `exit:0`（62ms），假 sshd 侧同一时刻收到该命令 |
| L1 审批**双向** | 允许：卡上停顿 10.0s → `allowed-once` → `exit:0`，远端有记录；拒绝：停顿 6.6s → `APPROVAL_REJECTED` → **远端 sshd 零新增记录**（命令根本没连出去） |

**修复后复验（同日第二、三轮，均为新会话）**：

- **第二轮（缺陷 2/6 的复验）**：`ssh_hosts` 返回行首即 `a1-live-local`，模型**一次就用对 `hostId`**
  （`exit:0` / 61ms，远端 sshd 同一时刻收到 `uname -a`），`dataDir/exec-audit.jsonl` 同步落盘（seq 1）。
- **第三轮（缺陷 8/9 的复验 + `ssh_session_read` 实机）**：人在页面连上 `a1-local-sshd`（终端出现
  `Welcome to Ubuntu …` 与提示符，敲了一行 `ls`），Agent 侧 `ssh_session_read` **读回该终端原文**
  （含 `file-a / file-b / dir-c`），紧接着 `ssh_exec uname -a` 拿到 `exit:0` / 56ms。远端日志给出
  通道分离的直接证据：`shell: opened`（15:45:50，人的 PTY）→ `exec: "uname -a"`（15:46:42，Agent 的
  exec channel）**同一条连接、互不干扰** —— J2「人的 PTY ≠ Agent 的 exec」与 SPIKE S4（同一 Client
  上 shell 与 exec 并存）双双落地；落盘台账同步记下 `(session_read)` / `decision:"read"`。

### 逮到并修复的缺陷

1. **`output` 缺失 ⇒ 三个工具被官方注册表全部拒收**（最严重）：`ctx.tools.register()` 要求
   `ToolDefinition.output = { schema, render }`，旧定义没有 ⇒ 抛
   `tool "<name>" must declare output { … }`，而这条错误被 `catch { logger.error }` 静默吞掉 ——
   页面上看起来像「D2 关着」，实际是**一个工具都没注册**。修：三工具补齐 `output`（schema +
   render 文本卡片），并补注册表级探针与形状回归单测。
2. **`ssh_hosts` 渲染不带 `id` ⇒ 工具面实机不可用**：模型只看得见 `output.render` 的文本
   （看不到 value 的 JSON），旧渲染只有 `label · address · …` ⇒ 模型拿 label 当 `hostId`，
   连吃 `NOT_FOUND`。修：`id` 提到行首 + 描述明确「hostId 用返回里的 id」+ 回归断言。
3. **审批入参形状不符官方契约**：旧实现传 `{ title, reason, detail:{…}, options:[…] }`，官方是
   `{ questions:[…], agent?, signal? }` ⇒ 真机上必然 `TypeError` 被兜成 `APPROVAL_UNAVAILABLE`
   （**所有 L1/L2 审批必然失败关闭**）。修：按契约重写（`questions[]` / `detail` 为 string /
   `agent`+`signal` 透传 / `ASK_ABORTED ⇒ cancelled` / 自由文本**拒绝优先**）。
4. **隐式建连不等就绪 ⇒ 首次 `ssh_exec` 必 `NOT_CONNECTED`**：`runtime.connect()` 是异步的，
   返回时 `status` 还停在 `connecting`（单测 stub 直接给 `connected`，把这一层时序掩盖了）。
   修：`awaitReady()` 轮询真就绪；指纹等待立刻给 `FINGERPRINT_REQUIRED`；已有在飞连接不重复
   `connect`（重复会 retire 掉前一条 runtime）。
5. **注册时点早于服务就绪**：profile bundle 行的 apply 早于 `tools` / `userQuestions` 就绪，
   同步 `ctx.get()` 取到 undefined。修：改走 cordis 依赖注入 `ctx.inject(['tools'], …)` +
   `userQuestions` 活引用 + **注册自证** `dataDir/agent-tools.json`（把「注没注册」变成可查事实）。
6. **审计只留内存 ⇒ 重启失忆**（规划 §7.5 本就要求落盘）：`lib/audit.js` 增 `file` 参数，追加写
   `dataDir/exec-audit.jsonl`，懒加载回填 + 超长压回尾部 + 坏行跳过；`clear()` 只清内存不删历史。
7. **拒绝卡看不到被拒的命令**：错误分支 render 现在带 `host · command · riskLevel`，工具返回值
   也补 `host`（对话流回看才知道被拒的是哪台机器的哪条命令）。
8. **REST 路由的连接 id 口径与 store 不一致 ⇒ 非 UUID id 的记录「看得见、点不动」**（人工复验
   时逮到）：`store.normalizeConnection` 接受任意非空 id，而路由正则只认 `[0-9a-f-]+`（UUID 形状）
   ⇒ 详情/连接/断开全落 `404 接口不存在`（页面只显示「连接失败：接口不存在」，假 sshd 侧连一次
   TCP 都没收到）。**同一条记录 Agent 走 store 直查一直好用** —— 所以缺陷只在人这一侧显形，
   前几轮的 Agent 实测（`ssh_exec` 全绿）根本照不到它。修：两处正则改 `([^/]+)` + `decodeURIComponent`，
   补 REST 回归（非 UUID id 的详情 200 / 连接走业务分支）。**服务端自证**：`GET …/a1-live-local`
   → 200、`POST …/connect` → `{"ok":true,"state":"connecting"}` 且假 sshd 侧记录 `shell: opened`。

9. **`connId` 形状校验在 WS/SFTP 侧另有一套 ⇒ 终端永远附着不上**（同一次人工复验的第二处）：
   `/ssh/api/attach` 与 `/ssh/api/sftp/ticket` 各自写着 `^[0-9a-f-]+$`（UUID 形状）⇒ 非 UUID id 的
   连接**连得上、却看不到终端**：页面显示「浏览器与本地服务暂时失联，正在自动重新附着（4/4）」→
   最终「connId 不合法」。修：把判据收敛成 `store.isConnectionId()` **一处口径**（非空、无空白 /
   路径分隔符 / 控制字符；UUID 不是唯一合法形状），路由目录段、attach、sftp ticket 三处共用，
   `normalizeConnection` 与它同源（畸形输入 id 回落新 UUID）。**服务端自证**：
   `POST /ssh/api/attach {connId:"a1-live-local"}` → 200 + 票据 + `shells:[{shellId:"sh-1",state:"live"}]`；
   `POST /ssh/api/sftp/ticket` → 200 + 票据（两者修复前都是 400）。

### 测试与闸门

- 单测 **276 → 294 例**（tools +6 / audit +5 / http +2 / store +1，含上述缺陷的回归断言）；
  `verify-all ssh` **31/31**。
- **仍未实测**：B 阶段的对话流 SSH 工具卡；官方 `approval/asked|decided` 审计对仍不可用（§7.3
  方案 A 的已知代价，现由落盘台账承担）。**`ssh_session_read` 已随第三轮验完**（见上）。

### 部署口径（2026-09-26 用户拍板）

- **仓库默认仍是 `off`**（D2「关掉即原生」不动）。**`miasaki` 桌面端**（自制壳 `dsh --profile miasaki`）
  的 profile 补丁层设 `agentTools: true` **长期开启**，三工具随后端启动常驻 —— 该文件是**启动时读取**，
  改完必须重启后端（关掉自制壳再打开）。覆盖时注意 dsh 的 patch 语义是 **config 整体替换而非深合并**，
  必须抄全 `dataDir` / `trustedHosts` / `scrollbackBytes`（漏 `dataDir` 等于「主机库搬家」）。
- **web profile 只用于实测**：起独立实例时用
  `--patch _refs/scripts-archive/ssh-a1-live/a1-live.patch.yml`（隔离 dataDir），既不动用户 profile，
  也不碰真实连接库 `~/.dsh/miasaki-ssh/`。
- **主机授权仍默认拒绝**：`agentAccess` 未设置的主机对 Agent 不可见，要在「编辑主机 → Agent 访问」
  里显式选「只读 / 完整」才会出现在 `ssh_hosts` 里。
- 注册自证：`~/.dsh/miasaki-ssh/agent-tools.json` 记录本次启动是否注册成功、注册了哪几条 —— 
  重启后一眼可查（静默失败不再靠猜）。

## 2026-09-26 · P2 落地：U3 跳板/本地转发 + A1 ssh_exec 工具面 + 双栈边界 + 真协议探针

**背景**：用户「p2开工」——对标方案 §5 的 P2 四项全部实施（D4=② 跳板走 runtime 复用路线）。

### P2-1 U3：跳板 + 本地端口转发（`lib/forward.js` + `lib/runtime.js` + `store.js` + 编辑器）

- **本地转发**：`createLocalForward()` 在 127.0.0.1 起真 TCP 监听，每入连接经 ssh2 `forwardOut`（direct-tcpip）送远端视角的 `remoteHost:remotePort`；fast-client 首字节不丢（data 监听先于通道回调挂 + pending 补发）；失败即停两端；`close()` 兜底 500ms 不挂 teardown；端口关闭即可再绑（无僵尸占用）；EADDRINUSE / 服务端拒绝逐连接上报且**不撤监听**（改配置后新连接立即可用）。
- **跳板（D4=②）**：目标连接的 cfg.sock = 跳板 runtime 的 forwardOut 通道 ⇒ 凭据 / TOFU / 票据全复用既有机制，不另起一套。两个诚实边界：① 跳板**从未连过**（无指纹记录）⇒ 前置拒绝 `JUMP_UNAVAILABLE`（它的 TOFU 确认窗口没有 UI 附着点，让用户先单独连一次）；② password 跳板未连过 ⇒ 不隐式建连（「不把发起认证暴露成隐式能力」与 A1 同一条纪律）。
- **就绪门**：RuntimeConn 新增 `readyPromise`（ready resolve / 终态 reject / 创建即挂 no-op catch 防未处理拒绝）；`awaitJump` 等真就绪——修掉「跳板未就绪就 forwardOut」的真 bug。
- **生命周期**：转发随连接就绪自动建立（幂等按 localPort 去重）、随断开/teardown/shutdown 全撤；SSH 意外断开也撤（僵尸端口比没端口更糟）。
- **数据与 UI**：连接记录新增 `forwards`（上限 8、端口/主机校验、本地端口去重）与 `jumpHostId`（引用另一条已受信任连接）；编辑器加「Agent 访问 / 经由跳板 / 本地端口转发」三组字段；身份行标注「经 X / 转发 N 条」；转发错误经 `forward` 帧进状态栏。

### P2-2 A1 `ssh_exec` 工具面（`lib/tools.js` / `lib/policy.js` / `lib/audit.js` + `index.js`）

- **三工具**（规划 §6.1，少而正交）：`ssh_hosts`（只读免审批，杜绝主机幻觉）/ `ssh_exec`（核心）/ `ssh_session_read`（读人正在用的终端回放，只读免审批）。**D2：总开关默认 `off`**（cordis patch `agentTools: false`；开启且 ctx.get('tools') 在场才注册——不进 inject 声明，缺失不拖垮插件）。
- **服务端分级**：`classifyCommand()` 纯函数——L2 危险模式（命令头判 rm -rf，`docker rm -f` 不误伤；sudo/env 前缀剥离）、L0 只读白名单（`sed -i`/`find -delete` 等写 flag 落 L1）、未识别一律保守 L1；`decideRisk()` 硬闸：readonly 主机 L1/L2 **连审批机会都不给**。
- **审批四态**（规划 §7.3 方案 A）：`userQuestions.ask()` 宽容解析返回值；`rejected`/`cancelled`/`unavailable` 全返回结构化结果、**不抛异常不中止轮次**；unavailable 给可行动失败信息（官方 approval seam SPIKE S3 实测不可用 ⇒ 失败关闭是正确方向）。
- **连接纪律**：key/agent 主机可隐式建连（无秘密传递，不开 shell）；password 主机 `NOT_CONNECTED`；`exec.signal` 取消透传到 channel；超时结束 channel 不挂死工具；输出 32KB/8KB 双预算截断；cwd 经 POSIX 引用前置。
- **审计**：`createAuditRing()` 内存环 200 条（seq/时间/主机/命令/分级/决策），`GET /ssh/api/agent-audit` 只读 + 主机菜单「Agent 执行记录」浮层。秘密从不进台账。
- **偏离登记**：`userQuestions.ask()` 的确切参数形状无实测记录（SPIKE 只确认服务可达）⇒ 调用按通用约定 + 返回值宽容解析 + 不可用失败关闭；待一次真实会话实测后收紧。

### P2-3 双栈边界

- 既有就位项核对：Windows agent pipe / ssh.exe 四级发现 / 反斜杠字面保留 / `C:\` keyPath 判定。
- **exec 的 `/bin/sh` 边界**：远端是 Windows（OpenSSH for Windows）时无 /bin/sh ⇒ `EXEC_FAILED` 消息带可照做提示（不静默失败）。SFTP 路径按 POSIX 归一（远端 Windows 的盘符路径不支持）——记入已知边界。

### P2-4 真协议探针（归档 `_refs/scripts-archive/ssh-p2-probes/run-forward-probe.mjs`）

**8/8 ALL PASS**：A 组本地转发经真 ssh2 服务器 direct-tcpip 字节往返 / 计数 / 端口释放（含 ssh2 `tcpip` 事件挂连接实例的坑）；B 组**经跳板 forwardOut 通道 sock 注入完成真协议握手**（D4=② 的可行性证明）；C 组真 exec 退出码 + motd 行进 stdout + `scanJsonLine` 跳过 + POSIX 包装形状。

### 测试与闸门

- 单测 **225 → 276 例**（forward +8 / forward-runtime +6 / policy +12 / audit +4 / tools +21）；
- `verify-all ssh` **20/20 → 31/31**；全量 verify-all 九类全 PASS；`npm run build` 全文件通过；
- 期间逮到并修复的真 bug：跳板未就绪即 forwardOut（缺就绪门）、readyPromise 未处理拒绝、转发首字节丢失（fast client）、两处 app.js 语法笔误（粘行/多层花括号，均被 vm 加载的单测逮住）。
- **重启 `dsh web` 后待实机验收**：真实跳板机建连、本地转发实机使用、`agentTools: true` 后三工具在真实会话的注册与审批落点。

## 2026-09-26 · zcode 对标方案落地：P0 三件套 + U2.2 SFTP + P1-1 ssh config 导入

**背景**：用户对[对标调研与方案](2026-09-26-ssh-zcode-benchmark-plan.md)拍板「按建议开工」——
D1②（P0 三件套全做）、D5②（降级链并进 U2.2）、D2①（ssh config 只导直连 alias）。

### P0-1 连接健壮性三件套（`lib/runtime.js`）

| 子项 | 落地 |
|---|---|
| keepalive | 连接配置加 `keepaliveInterval 15s × keepaliveCountMax 3`（zcode 同款口径）：NAT/防火墙静默断开时不再挂在 `connected` |
| 连接配置可测 | 提取纯函数 `buildConnectConfig(record, creds, env)`：三条口径（60s 握手预算与指纹窗口同源 / keepalive / agent 只认显式选择）全部可单测 |
| 错误词汇 | `classifyError()` 新增 ssh2 `level` 分级（`client-authentication`→AUTH_FAILED、`client-timeout`→TIMEOUT 带预算口径）与加密私钥口令两码（`KEY_PASSPHRASE_MISSING` / `KEY_PASSPHRASE_INVALID`） |
| error 监听复核 | `ready` 前后 `error` 常驻 + dispose 后 no-op 既有实现经复核保持，补单测锁定 |

**真协议探针**（归档 `_refs/scripts-archive/ssh-keepalive-probe/`）：真 `ssh2.Server` 握手完成后吞掉服务端全部外发字节（只进不出 = 静默断开）⇒ **60043ms（=15s×4）收到 `Keepalive timeout`（level `client-timeout`）**，`classifyError` 归 `TIMEOUT`；对照组（keepalive 缺席）20s 窗口内零错误 ⇒ 非环境噪声。6/6 PASS，进程干净退出。

### P0-3 exec 前置（`lib/exec.js`，A1 `ssh_exec` 地基）

- `buildPosixShellExecCommand()` / `quotePosixShellArg()`：一律包 `/bin/sh -c`（fish 等非 POSIX 默认 shell 下语义一致）；
- `execCommand()`：**只在 `close` 收尾 + `exit` 码优先 + close 后 50ms 排空窗口**（迟到 stdout data 不丢）；客户端侧超时结束 channel；输出封顶截断；
- `scanJsonLine()`：协议行逐行扫描，banner/motd/欢迎行自然跳过（A1 handshake 同款思想）。

### U2.2 SFTP（`lib/paths.js` / `lib/sftp.js` / `lib/limits.js` + REST 八端点 + `sftp-ui.js` 抽屉）

- **路径安全一处**：`normalizeRemotePath()` 词法归一 `//`/`.`/`..`（根处 `..` 停根）、`~` 展开、拒 NUL/控制字符/超长；与 A1 共用的口径（规划决策 7）。`limits.js` 收拢全部上限（512MiB / 10min 票据 / 进度节流 1s·5% / 并发 2）。
- **zcode 降级链**（`uploadResilient` + `uploadViaExecPipe`）：目录在 sftp 视图不存在（网关/跳板把 exec 与 sftp 落到两个文件系统视图）⇒ **零字节消耗直降 `mkdir -p && cat >`**；sftp 会话打不开同样降级；失败瞬间停两端流不刷虚假进度；进度节流 1s/5%/终点带速度；`AbortSignal` 取消一致。
- **偏离登记（单次 HTTP 源流不可回放）**：mid-stream 写失败**不就地降级**——连接标记 `execOnlyUpload`，错误明示「请重试（将自动改用命令通道上传）」；新连接记忆自然清零（zcode `execUploadOnly` 同款语义）。
- **票据族**：`POST /ssh/api/sftp/ticket`（10 分钟可续期 Bearer，renew 端点；与 WS attach 的 30s 一次性是两种生命周期）；teardown 同批作废。
- **REST**：list / stat / download（带头流式）/ upload（流式 + 上限双重校验）/ op（mkdir·rename·unlink·rmdir）+ renew/ticket；错误映射 `NO_SUCH_FILE→404 / PERMISSION_DENIED→403 / TARGET_EXISTS→409`；`Content-Disposition` 带 UTF-8 文件名。
- **前端**（`sftp-ui.js`，自包含 IIFE）：右抽屉 = 面包屑 + 列表 + 传输队列（并发 2、XHR 浏览器侧进度、单项取消）；下载走标签 click；上传/变更操作过同一个 `ensureTicket()`（超 4 分钟才续期）；窄屏（≤720）整幅覆盖；断开即收起。
- **端到端**：12 例走真实 HTTP + 故障注入 rc（`config.runtime` 测试缝，与 diagnose.js 的 deps 注入同一惯例）——票据失效/teardown 作废、`..` 归一、409/413、execOnly 直降、会话打不开自动降级、op 全分支、fence 先于票据。

### P1-1 `~/.ssh/config` 别名导入（`lib/sshConfig.js`，D2=①）

- **双通道**：`ssh -G` 优先（Windows ssh.exe 四级发现 + PATH、并发 3、1.5s 超时、ASKPASS 清空防挂起），失败回退自研解析器（Include glob / 注释 / 引号 / 转义 / 深度 8 / 上限 200 / 30s 按路径缓存）；
- **两条 zcode 教训落地**：privateKeyPath 只信 config 显式 `IdentityFile`（不信 `ssh -G` 默认值——否则密码登录被误判成密钥登录）；Windows 路径的 `\` 仅在确为转义分隔符/引号时解义；
- **只导直连**：含 `ProxyJump`/`ProxyCommand` 的 alias 标 `direct:false` 禁选，**不静默丢弃**（用户在 ssh 里就是用别名连的）；`*`/`!`/通配 Host 不是别名；
- **UI**：新建/编辑主机弹窗加「SSH 配置导入」下拉（懒加载），选中回填 host/port/user，显式带 IdentityFile 才切「私钥」并填路径；`GET /ssh/api/ssh-config/aliases` 过同一道 fence。

### 测试与闸门

- 单测 **153 → 225 例**（runtime +5 / exec +11 / paths +12 / sftp +14 / http-sftp +12 / sftp-ui +9 / sshConfig +9；其中 http-sftp 定位并修复一处真 bug：SFTP 操作错误未映射状态码会落 500）；
- `verify-all ssh` **14/14 → 26/26**（13 个入口语法含 6 个新模块 + 13 个测试文件）；`npm run build` 全文件语法检查通过；
- **重启 `dsh web` 后待实机验收**：文件面板真实主机读写往返、exec pipe 降级实机路径、ssh config 导入回填、keepalive 长连接场景。

## 2026-09-26 · 对标 zcode（zai-org/ZCode）调研与后续方案设计（无代码变更）

**动机**：用户定向「SSH 线可以参考 zcode 的官方仓库做，去看看 zcode 怎么做的」。调研对象为智谱
[zai-org/ZCode](https://github.com/zai-org/ZCode)（v3.14.3，agent harness，SSH 子系统用于「把 agent
runtime 部署到远程机器」，参考克隆 `_refs/zcode/`，归档区不入库）。产出
[对标调研与方案](2026-09-26-ssh-zcode-benchmark-plan.md)（v1.0，**待用户拍板 D1–D5，未开工**）。

**核心结论**：

1. **形态不同、底层同源**：zcode 是「本机 IDE ↔ 远程 agent」，本线是「浏览器 ↔ 远程 shell」；
   双方同为 ssh2 + Node，**独立踩中同一批坑** ⇒ 互相印证：tryKeyboard 不开则新装 Ubuntu/Debian
   密码登录必失败（本线 2026-09-26 已修，zcode 同样开着）、短命令 `exit` 早于 stdout `data`
   （zcode `execSimple` 只在 `close` 收尾、preflight 另给 50ms 排空窗口）、ssh2 默认 readyTimeout
   20s 太短（双方均显式 60s）、client 无常驻 `error` 监听会在连接抖动时炸 host。
2. **我们更强**：TOFU + known_hosts —— zcode **产品代码零 host key 校验**（仅测试脚本
   `StrictHostKeyChecking=no`；`buildSshRemoteHostKey` 是连接复用身份键、非校验）。保持不动。
3. **识别的差距**（→ 11 项候选，P0×3 / P1×4 / P2×4）：
   - P0：keepalive 15s×3 + 错误词汇对齐 + error 常驻监听复核；**U2.2 SFTP 注入 zcode 的
     SFTP→exec pipe 降级链**（网关/跳板把 exec 与 sftp 落到不同文件系统视图 ⇒ `mkdir -p` 成功但
     SFTP 写报 `NO_SUCH_FILE`，需降级 `cat > file` 并记忆 exec-only）、进度节流 1s/5%、`~` 经
     `printf %s "$HOME"` 展开；exec 前置（POSIX `/bin/sh` 包装防 fish、close 收尾 + exit 码优先、
     banner/motd 跳过）——A1 `ssh_exec` 地基。
   - P1：`~/.ssh/config` 别名导入（`ssh -G` 优先 + 708 行自研解析回退 + Windows ssh.exe 四级发现；
     privateKeyPath 只信显式 IdentityFile）；连接向导借尸（分阶段日志 / **收起≠关闭** / requestId
     取消 / 并发入口守卫）；诊断扩展远端能力速览（preflight 同款 `command -v` 探测）；连接取消语义
     对齐注册表（connecting 取消即退休旧 entry，防重连等已 aborted 的 readiness 并沿用旧凭据）。
   - P2：**U3 跳板/端口转发 zcode 无参考、完全自研**（建议跳板机也建模成 runtime，复用三层身份 +
     票据；只做本地转发）；A1 `ssh_exec`（借 handshake 的 banner 跳过与 deploy lock 的串行治理）；
     验证基建升级（借 zcode「docker sshd + 一次性密钥 + `ssh -L` 真隧道」骨架改造成转发验收探针）。
4. **明确不做**（附理由）：agent-over-ssh 部署链（超出本线「人的终端」定位与红线）、去掉 host key
   校验（安全红线）、WSL/Docker backend（DSH web 插件形态下价值低）、远程目录+skill 同步向导
   （U2.2 SFTP 已覆盖文件诉求）。

**无代码变更**：本轮只交付设计文档 + README/CHANGELOG 同步；P0/P1/P2 是否开工、按哪个组合走，
等用户对 D1–D5 拍板。

## 2026-09-26 · 修复：「只读：另一个窗口正在此终端输入」在未连接时常驻

**现象**（用户截图）：主机未连接、状态栏写着「未连接」，页面顶部却挂着黄色只读条 +「接管写入」，用户原话「一直都有」。

**根因（两处，都是写权语义只有两态导致的）**：

1. `app.js renderWriteBar()` 写的是 `bar.hidden = writable`，而 `writable = state.session !== null && isWriteOwner()`
   —— **没有会话时 `writable=false` ⇒ 把横幅翻开**。于是任何「无会话」时刻（启动、断开、关标签后）它都会冒出来并常驻。
2. `session.js` 的写权初始值就是 `'read'` —— 连接还没开 shell（写权未决）时 UI 已经把它当成只读，
   而文案「另一个窗口正在此终端输入」在当时并不成立。

**修法：把写权补成三态** `pending`（未决）/ `read`（明确只读）/ `write`（持有写权）：

| 位置 | 改动 |
|---|---|
| `session.js` | 初始 `mode = 'pending'`；新增并导出 `isReadOnly()`（`mode === 'read'`），`isWriteOwner()` 语义不变 |
| `app.js renderWriteBar()` | 判据改为「会话活着（`isLive(liveOf(session.connId))`）**且** `isReadOnly() === true`」才显示 |
| `app.js` `write.open` 分支 | 写权空出提示从 `isWriteOwner() !== true` 收敛为 `isReadOnly() === true` —— 未决态不再误报「可以接管」 |

**连带的语义变化（刻意）**：`ready` 帧带 `mode:'read'` 时现在**会**触发一次 `onModeChange('read')`
（pending → read 是真实变化）；旧实现因初始即 `'read'` 被 `setMode` 的去抖吃掉，导致"该显示时不更新"。
对应测试断言按新语义改写。

**测试**：`session.test.js` 改写 2 例（三态语义 + 被接管后 isReadOnly）、`app.test.js` 契约 +1
（静态锁定新判据，并用 `doesNotMatch` 钉死旧写法 `bar.hidden = writable`）⇒ 全线 **152 → 153 例**、
`verify-all ssh` **14/14 PASS**。

**实测**（真产物 × headless Edge，归档 `_refs/scripts-archive/ssh-modal-verify/`）：新增
`H-idle-write-bar-hidden` 场景，未连接态直接量 `#write-bar` —— `hidden:true` / `display:none` /
状态栏「未连接」；连同既有 7 景共 **8/8 PASS**，截图 `shots/H-idle-write-bar-hidden.png`。

**生效条件**：改的是 `app.js` 与 `session.js` ⇒ 仍需重启 `dsh web`（`index.js` 的 `cachedAsset` 是进程内缓存）。

## 2026-09-26 · 新功能：连接诊断（档 B：诊断面板 + 测试连接 + 复制报告）

**动机（用户当场提出）**：这一整轮排障里，真正解决问题的信息（本机出口 IP、对端端口是不是 SSH、服务端允许哪些认证方式）
全是**在命令行里挖出来的**。产品里应该让它们自己浮出来 —— 用户原话「加个功能吧，可以查看本机的一些信息，方便放行」。

**成熟做法对照**（选型依据）：DBeaver / Navicat / TablePlus 的 **Test Connection** 放在会话属性里（最高频、离"填完就试"最近）；
VS Code Remote-SSH 的 **Show Log** 与 MobaXterm / Xshell 的网络工具是独立诊断入口。⇒ 两个入口都做：
主机菜单（工具区 `⋯` / 终端右键同源）「连接诊断」+ 编辑主机弹窗「测试连接」（草稿也能测）。
**设置页不做**：本机信息属于诊断，不属于偏好；偏好页（默认端口 / 超时 / keepalive / 终端字号）留待走官方 `settings.section` 的第二期。

**架构：探测与结论都在 host 半，页面只渲染**

| 层 | 文件 | 职责 |
|---|---|---|
| 探测 | `lib/diagnose.js` | `resolveHost`（IP 字面量短路）/ `probeTcpAndBanner`（**一次连接同时取 TCP 结果与 banner**）/ `probeAuthMethods` / `resolveEgressIp` / `listLocalAddresses` |
| 归因 | `lib/diagnose.js` `buildVerdict()` | 把事实收成 `REACHABLE` / `NOT_SSH` / `TCP_TIMEOUT` / `TCP_REFUSED` / `TCP_RESET` / `TCP_UNREACHABLE` / `DNS_FAILED` / `PASSWORD_DISABLED` + 可照做的提示（**单一出处、可单测**） |
| 路由 | `index.js` `POST /ssh/api/diagnose` | 复用同一道 fence；`connectionId`（已存主机）或 `draft`（编辑中的草稿） |
| 渲染 | `app.js` `openDiagnostics()` | 结论条（按 level 上色）+ 事实格 + 说明 + 「查询公网出口 IP」「探测认证方式」「复制报告」 |

**三条设计硬约束（都由这次封 IP 的事故逼出来）**：

1. **默认不发任何凭据**。诊断按钮要是每次都记一次失败登录，用户会被 fail2ban / 云主机安全封 IP —— 这次就是这么被
   封的（用户自己的重试 + 我的诊断探测同源）。默认探测只做 DNS / TCP / SSH banner。
2. **认证方法探测只发协议自带的 `none`**。`USERAUTH_FAILURE` 会带回服务端允许的方法清单，而 OpenSSH **不把 `none`
   记成失败密码**（fail2ban 的 sshd 过滤器不匹配它）⇒ 既能读到清单，又不增加封禁风险。测试用真 `ssh2.Server` 断言
   「服务端只看到 `none`、看不到任何 password」。
3. **出口 IP 逐次显式**。查公网 IP 必须外呼第三方服务（ipinfo.io → ipify → ifconfig.me 逐个回退），所以默认不查、
   点按钮才查，界面写明数据去向；`egress` 字段默认 `null`，测试里用「fetcher 抛错也不该被调用」钉死这个默认值。

**其它取舍**：TCP 探测走**主机名**（不是我们解析出的 IP），报告与实际连接行为一致；TCP 通但对端零字节**不能报成 TCP 超时**
（`connected` + `banner: null` ⇒ `NOT_SSH`）—— 这正是实机踩过的形态，测试用真 socket 钉住。

**测试**：`test/diagnose.test.js` **11 例**（banner 解析 / socket 错误词汇 / DNS 字面量短路 / 真 socket 三形态 /
真 `ssh2.Server` 的 `none` 探测 / 出口 IP 回退 / verdict 全分支 / 端到端组装）、`http.test.js` **+1**（路由端到端：
真协议探测 + 默认不外呼 + 缺目标 400 + fence 403）、`app.test.js` **+2**（两个入口与三条默认值的静态契约、
面板样式契约）⇒ 全线 **138 → 152 例**、`verify-all ssh` **12 → 14/14**。

**实测**（真产物 × headless Edge，归档 `_refs/scripts-archive/ssh-modal-verify/`）：探针服务器的 `/ssh/api/diagnose`
桩路由**直接调真实 `lib/diagnose.js`**（渲染的是真报告，不是编的数据），新增两景全过：
`F-diag-not-ssh`（TCP 通零字节 ⇒ 红框「这不是 SSH 服务」）、`G-diag-reachable-auth`（真 ssh2 假 sshd + 认证方式探测 ⇒
绿框「网络与 SSH 服务可达」+ `publickey / password`）；连同既有 6 个悬浮窗场景共 **8/8**。

## 2026-09-26 · 主机栏里连端口一起填 ⇒ `getaddrinfo ENOTFOUND`（实机反馈）

**触发**：用户截图报「报错了」—— 连接失败横幅 `getaddrinfo ENOTFOUND 8.138.243.30:25112`。
取证就在同一张截图的标题行：地址显示为 `wwq7tmzr@8.138.243.30:25112:22`，而页面那行是
`${username}@${host}:${port}` ⇒ **host 字段本身是 `8.138.243.30:25112`**、端口栏还是默认 22。
`requireHost()` 当时只拒空白与斜杠，于是整串被当成主机名交给 DNS。

**决策：把「粘贴地址」当成一等输入，而不是要求用户自己拆。** 规则只写一处（`splitHostPort`），
三条路径共用：

| 层 | 位置 | 行为 |
|---|---|---|
| 拆分规则 | `lib/store.js` `splitHostPort()` | `example.com:2222` / `[::1]:2222` → `{host, port}`；**裸 IPv6 不拆**（多个冒号是地址语法）；端口照旧过 1–65535 校验 |
| 写入 | `normalizeConnection()` | 内嵌端口**优先于**端口栏（粘贴的地址比默认 22 更具体）；`10.0.0.1:99999` 报端口错，不静默连错 |
| 历史记录 | `runtime.connect()` | 发现 host 带端口 → 拆分 + `updateConnection()` 回写 + 返回 `repaired`；`index.js` 透传，前端 `setStatusNote` 如实说明「已移到「端口」栏」并刷新列表（**不静默改数据**） |

**报错文案**：`classifyError()` 的 `HOST_NOT_FOUND` 分支前面补一句能照做的指引
（`无法解析主机名（<原始消息>）—— 请检查主机地址：只填域名或 IP，端口填在「端口」栏`）。
原始消息原样保留 —— 排障要看它。

**为什么不只在 UI 层拆**：写入口有三个（页面 POST、编辑 PUT、Agent/API 直连），只在前端拆会漏；
放在 `normalizeConnection()` 之后，三条路径一次覆盖，前端只负责「如实告知」。

**为什么不静默修**：连接请求带写盘副作用（修历史记录）本身可接受（host 里带端口必然连不上，
这是明确的坏数据），但**必须回报**：前端拿到 `repaired` 就刷新列表 + 状态栏说明，用户能看到
端口栏从 22 变成 25112。

**测试**（全线 **127 → 135 例**，`verify-all ssh` **12/12 PASS**）：
`store +2`（`splitHostPort` 六形态 / `normalizeConnection` 优先级与非法端口）、
`runtime +3`（ENOTFOUND 文案保留原文 + 指引、历史记录连接时修正并回写磁盘、干净记录不产生
`repaired` 也不多写盘）、`http +2`（**真实 `index.js` 端到端**：POST 主机栏带端口即拆分；
种子历史记录 connect 响应带 `repaired` 且 GET 回读的磁盘记录已修正）、
`app +1`（页面必须提示并刷新列表，静态锁定）。

**立即解法（给用户，不用等重启）**：打开该主机的「编辑主机」→ 主机 `8.138.243.30`、端口 `25112` → 保存。
重启后即使不改，点「重新连接」也会自动修正。

**生效条件**：本轮改到 `lib/store.js` / `lib/runtime.js` / `index.js` / `app.js` ⇒ **必须重启 `dsh web`**。

### 续：第二跳 `Connection lost before handshake`（地址修对之后的那个错，不是本线缺陷）

用户把地址改成 `8.138.243.30:25112` 后报 `Connection lost before handshake`。链路探测
（`_refs/scripts-archive/ssh-conn-probe/ssh-conn-probe.mjs`，真实 `ssh2` 客户端）给出硬数据：

| 阶段 | 结果 |
|---|---|
| TCP 建连 | **成功，38ms** |
| 服务器 banner | **8 秒内零字节**（正常 sshd 会在建连后立刻发 `SSH-2.0-…`） |
| ssh2 侧 | `read ECONNRESET` → `Connection lost before handshake`，**69ms 就断** |

即：**TCP 通、但对端在本端发出 SSH banner 之前就 RST**。结论是「`25112` 上不是（或不对外
提供）SSH 服务」——典型成因是端口映射指向了非 sshd、或云安全组只对特定来源放行。**本线不做
任何「绕过」，只把诊断信息说清楚**：

- `classifyError()` 新增 `HANDSHAKE_LOST` 码：原句保留 + 排查方向（先确认端口是不是 SSH：
  安全组放行、端口映射是否指向 sshd），`ECONNRESET` 另立 `CONNECTION_RESET` 码（会话中途被重置
  也走它，不与「握手前断开」混为一谈）。
- 测试 +1（原句保留 + 指引 + 两码互不串味）⇒ 全线 **136 例**。

**给用户的排查路径**（写进回复，不写代码）：① 本机 `ssh -vvv -p 25112 wwq7tmzr@8.138.243.30`
复核；② 服务器上 `sudo ss -lntp | grep -E 'sshd|25112'` 看该端口是谁在听；③ 云控制台安全组
确认放行来源与方向。

### 续二：第三跳 `connect ETIMEDOUT`（端口换 2005 之后）—— 端口画像一次探清

同一台机器的多端口 TCP 探测（`_refs/scripts-archive/ssh-conn-probe/port-scan-probe.mjs`，
与前端同一条出口链路）：

| 端口 | 实测 | 判读 |
|---|---|---|
| 22 | `timeout-no-response` 3508ms | 包被丢：未放行 / 无监听且策略为 DROP |
| 2005 | `timeout-no-response` 3506ms | 同 22 —— 与前端的 `connect ETIMEDOUT` 完全一致 |
| 25112 | `tcp-open-silent`（上一轮还测到 69ms RST） | **有东西在监听但不是 sshd**，且行为不稳定（像前置防护/转发设备） |
| 443 | `tcp-open-silent` | 可达（HTTPS 在收到 ClientHello 前本就沉默） |
| 8080 | `timeout-no-response` 3506ms | 被丢 |

⇒ 结论：这台机器对**按端口白名单**放行（443 / 25112 可达，22 / 2005 / 8080 被丢），sshd 实际
端口不在已放行集合里。**本线仍然只做「把话说清楚」**：`classifyError()` 的 `TIMEOUT` 分支同样
补上排查方向（原句保留）。测试 +1 ⇒ 全线 **137 例**。

（探测脚本保留在 `_refs/scripts-archive/ssh-conn-probe/`：以后遇到连接问题先跑它，别靠猜。）

### 续三：第四跳 `All configured authentication methods failed`（放行 22 之后）—— 补 keyboard-interactive

用户放行 22 后，链路全通（TCP ✓ 握手 ✓ 指纹已信任 ✓），但认证失败。**其中一支是本线的真实能力缺口**：

- 新装 Ubuntu / Debian 与部分云镜像的 sshd 默认是 `PasswordAuthentication no` +
  `KbdInteractiveAuthentication yes`（PAM 的 keyboard-interactive 才是密码入口）。
- ssh2 客户端**只在 `tryKeyboard === true`** 时才把该方法列入 `authsAllowed`
  （`ssh2/lib/client.js:843`，已读源码核实）；本线此前只设 `cfg.password`，于是这类服务器
  **密码再对也只会得到 `All configured authentication methods failed`**。

**修法**：password 认证分支加 `cfg.tryKeyboard = true`，并注册
`client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => finish(prompts.map(() => password)))`
—— 回填的就是本次连接的那一个密码（PAM 单提示），密码仍只在内存、仍不落盘。服务端若拿这个
通道做二次验证，回填密码自然不通过（不猜、不绕过）。

**测试（真协议端点）**：`test/runtime.test.js` 用 `ssh2.Server` 起一个**只提供 keyboard-interactive**
的假 sshd（RSA host key 现场生成 + 真实 `session/pty/shell` 应答），走完「TOFU 指纹确认 →
keyboard-interactive 回填密码 → 开首个 shell → connected」全链路。
**反向验证**：把 `cfg.tryKeyboard` 临时置 false，该用例立刻失败（28 pass / 1 fail）⇒ 测试确实锁住
这个能力，不是摆设。**注意**：客户端先试 password 被拒再改走 keyboard-interactive 是 ssh2 的正常
顺序（`offered` 里两个方法都在），断言因此钉的是「最后一个方法必须是 keyboard-interactive」。

⇒ 全线 **137 → 138 例**、`verify-all ssh` **12/12 PASS**。

**另一支（同样要用户确认）**：若 `sshd -T` 显示 `passwordauthentication yes`，那就是用户名或密码
本身不对（对照实验：系统 `ssh -p 22 wwq7tmzr@8.138.243.30`，以及 `whoami` 确认用户名）。

**实测定论（同日，不依赖用户跑命令）**：`_refs/scripts-archive/ssh-conn-probe/auth-methods-probe.mjs`
用 ssh2 的 `authHandler` 直接读服务端在 `USERAUTH_FAILURE` 里回的方法清单 ——
`8.138.243.30:22` 对 `wwq7tmzr` 回的是 **`["publickey","password"]`**：

- **password 是被允许的** ⇒ 这台机器**不属于**「只开 keyboard-interactive」那一类；
  续三补的 `tryKeyboard` 对它是多余但无害的（对真正只开该方法、或用 PAM 提示密码的服务器有用，
  且有真协议测试 + 反向验证兜住）。
- 因此这台机器的 `All configured authentication methods failed` **收窄到凭据本身**（用户名或密码）。
  探测用的是一次性假密码，失败属预期 —— 脚本不猜密码。
- 定位手段：系统 `ssh -p 22 wwq7tmzr@8.138.243.30` 对照（能进 ⇒ 我们的问题，继续查；不能进 ⇒ 凭据问题），
  服务器侧 `whoami` / `sudo passwd wwq7tmzr` 复核用户名与密码。

## 2026-09-26 · 弹层形态改造：右侧抽屉 → 居中悬浮窗（修「右下角主题球压住确认键」）

**触发**：用户截图 —— 桌面壳右下角的主题球（`#miasaki-switcher .ms-btn`，fixed `right/bottom:16px` 的
46px 圆 + 6px ping 光晕，`z-index: 99990`，压在 `/ssh/` iframe 之上）盖住贴边抽屉右下角的确认键：
「连接密码 · NO.1」那颗「确认」正好落在球底下，点不到。

**为什么不再加一条让位**：这与 2026-09-15「窗控压住抽屉标题栏 ×」同源（壳 chrome 是零占位浮层，
页面 z-index 拦不住），但那次是**同排冲突**（都在右上角那一行），垂直让位即可解决；这次是
**贴边形态的固有冲突** —— 抽屉的底部按钮区与 fixed 右下角的球必然共享同一块像素，继续让位只会把
按钮推得越来越别扭。改形态才是根因修复。

**决策**：`.sheet` 从「右缘滑出的全高抽屉」改为**居中悬浮窗**，观感对齐官方设置面板
（`vendor/deepseek-harness/packages/client/ui-settings-general/src/client/SettingsRoot.module.css`：
遮罩 `--dsw-alias-bg-mask-1` + `--dsw-mask-blur`、大圆角、`--dsw-elevation-prominent` 的轻投影）。
那些宿主 token 没有桥接进本线，按等价口径落到 `--ssh-*`：遮罩 `rgba(0,0,0,.24)`（暗色 `.5`）+
`backdrop-filter: blur(2px)`、圆角 24px、`0 0 0 .5px var(--ssh-border)` 发丝描边 + 两层淡投影。
**全部弹层场景统一换形态**（新建 / 编辑主机、连接密码、私钥口令、TOFU 指纹确认、信任记录、
断开确认、粘贴确认）—— 不留「一半抽屉一半弹窗」的两套语言。

**两条让位口径（父视口实测写入，量不到归零）**：

| 变量 | 口径 | 消费点 |
|---|---|---|
| `--ssh-chrome-clearance` | 窗控组下沿 − iframe 顶 + 8px 呼吸（量不到 iframe 矩形时按顶格） | `.overlay` 的 `padding-top` ⇒ 卡片（含右上角 ×）整体落在窗控带之下 |
| `--ssh-shell-fab-safe-right` | 主题球左缘距本 iframe 右缘 + 6px 光晕 + 8px 呼吸 | `--ssh-modal-edge: max(32px, 安全线)` ⇒ 卡片宽度 `min(560px, 100% − 2×边距)` |

第二条是这次新增：宽窗口（卡片右缘天然远离球）零影响；**窄窗口**（宽 < 卡片宽 + 2×安全线）自动缩窄，
球够不着卡片。高度只留固定 64px 呼吸位：球在右下角，与卡片上下边界无关。浮层（iframe 顶格）与
会话视图（iframe 在中栏、两块 chrome 都可能落在 iframe 之外）共用一套算法，无分支。

**退役**：`--ssh-chrome-avoid-right`（贴边形态的水平兜底 —— 它服务的是标题栏 × 与窗控**同排**的冲突，
居中卡片天然不同排）、`openSheet` 的 `wide` 参数（全仓零调用，CSS 里也从无 `.sheet.wide` 规则）。

**实测（真产物 × headless Edge，探针归档 `_refs/scripts-archive/ssh-modal-verify/`）**：宿主页加载
**真实壳注入产物** `dsh-miasaki-desktop/src-tauri/injected/theme-init.js` 自建窗控组与主题球
（结果里 `shell=real`，非手抄几何），iframe 直供**真实** `app.js` / `styles.css`。五场景全过：

| 场景 | 视口 | 球 × 卡片 | 球 × 按钮 | 卡片顶 − 窗控下沿 | 关键变量 |
|---|---|---|---|---|---|
| A 新建主机 | 1540×1042 | 0 | 0 | +212.7px | clearance 45 / fabSafe 80 |
| B 窄窗新建主机 | 640×820 | 0 | 0 | +101.7px | 卡片宽 480（缩到安全线内） |
| D 极窄新建主机 | 480×640 | 0（垂直投影相交 34px、水平 0） | 0（垂直 19px、水平 0） | +40px | 卡片宽 320、内容滚动 |
| C 连接密码 | 1540×1042 | 0 | 0 | +371.4px | 确认键与球完全分离 |
| E 无壳 chrome（浏览器） | 1540×1042 | — | — | — | `fabSafe 0 / clearance 0`，边距退回 32px 基数 |

`fabSafeRight` 实测 **80px** 而非手算的 76px：真实球的 `box-sizing: content-box` 让 2px 边框外扩，
外框 50px（46 + 2×2）⇒ 安全线更保守，正确。

**代码面**：`styles.css`（`:root` 新增 `--ssh-modal-w` / `--ssh-modal-edge`；`.overlay` 改居中 + 遮罩口径 +
顶部内边距；`.sheet` 改卡片；`.sheet-head` 去掉 avoid-right 消费）、`app.js`（新增 `computeFabSafeRight()`
纯函数与 `measureShellFab()`；`syncChromeClearance()` 写两条变量；`applyChrome()` 不再顺带重测让位；
`overlayState.reserve` 字段随兜底一起退役；`openSheet()` 去掉 `wide`）。**`client.js` / `session.js` /
`index.js` / `lib/` 零改动** —— 这是纯页面半的形态变更。

**验证**：`node scripts/verify-all.mjs ssh repo` → **ssh 12/12 + repo 2/2 PASS**；全线单测 **127 例**
（app 16 → 17：新增 `computeFabSafeRight` 纯函数例，`syncChromeClearance` 与样式契约两例改写为新口径）。

**生效条件**：改的是 `app.js` / `styles.css`，而 `index.js` 的 `cachedAsset` 是**进程内一次性缓存**
⇒ 必须重启 `dsh web`（浏览器强刷不够）；桌面壳无需重编（未触碰注入产物）。

## 2026-09-26（深夜）· 死代码清理（零行为变更，10 项）

仓库级死代码审计后的清理。本线无文件级垃圾（空目录 0 / 备份副本 0 / 误入库产物 0），全部删除面都是
「生产路径零引用」的函数、字段与方法。**每一条都用全仓引用搜索逐个核过，且确认无一被测试的 `readFile`+正则
契约断言钉住**。验证：`node scripts/verify-all.mjs ssh` **12/12 PASS**（126 例单测全过）。

| 项 | 位置 | 判定证据 |
|---|---|---|
| `RuntimeManager.currentStatus()` | `lib/runtime.js:704-708` | 全仓 `.currentStatus` 零命中；index.js 全走 `listState()`（:130/:172/:187） |
| `RuntimeConn` 的 `cols` / `rows` 字段 | `lib/runtime.js` 构造器 | `rc.cols` / `rc.rows` 零读取（尺寸已收敛到 `ShellChannel` 级）；模块级 `DEFAULT_COLS/ROWS` 常量仍被 openShell 使用，未动 |
| `RuntimeConn` 的 `fpToken` / `fpHash` 字段 | 同上 | 两字段全仓仅构造器赋值处命中，零读取（指纹走 `rc.fp` 对象） |
| `RuntimeConn` 的 `host` 字段 | 同上 | `this.host` / `rc.host` 零读取（`rc.label` 才是对外名） |
| `RuntimeConn.get stream()` | `lib/runtime.js` | 注释自称「兼容旧测试」，但测试全用 `shell.stream` / `sh.stream`；`rc.stream` 零命中。**属未接线的兼容外壳** |
| `ShellChannel.disposed` 字段 + `dispose()` | `lib/runtime.js` | `shell.dispose` 零调用；`.disposed` 的全部读点都是 `rc.disposed`（RuntimeConn 的同名成员是活的，未动） |
| `parseHostKey()` | `lib/store.js:32-40` | 全仓 2 命中＝定义＋`test/store.test.js` 的 import（该测试全文无调用）；test 的 import 同批移除 |
| `SshStore.exit()` | `lib/store.js` | 空实现（`{ /* nothing to clean */ }`）、零调用（`index.js:96` 只挂 `runtime.shutdown?.()`） |
| 导出 `DEFAULT_COLS` / `DEFAULT_ROWS` | `lib/store.js:9-10` | 无任何 import 方；runtime.js 用的是自己的私有同名副本（:25-26） |
| `ticketTimer` | `session.js:68`+`:372` | 全仓 2 命中＝声明＋destroy 清理，**零赋值**（票据改为每次重附着现取后的残留） |
| `rememberLastTab()` | `app.js:86-101` | 全仓 1 命中＝定义本身；工作区快照 `saveWorkspace/readWorkspace` 已接管（`readLastTab` 仍被 mount 兼容分支使用，保留） |
| `.fact-line` 规则 | `styles.css:274` | 该父容器在现有 app.js 中零产出 |

**未做（留待决议，非误判）**：`GET /ssh/api/state`（`index.js:129-131`）线内零消费方，但 `_refs/scripts-archive/` 下
9 处验收探针依赖它、README 要求复验时重跑 ⇒ 保留；`lib/runtime.js` 的序列化占位脚本分支（`index.js:108-111`）
看似永不执行，但 CHANGELOG:114 实证发生过（宿主先启动、addon 后安装）⇒ 保留。

## 2026-09-26（B4：让位测量的「时机」修复 —— 修「还是会有问题，点击页面后可能恢复正常」）

- **用户第三次复报**：「还是会有问题，点击页面后可能恢复正常」＋两张桌面壳截图。图 1（异常）里 SSH 文字被官方两颗「▭」夹在中间、按钮盒交叠；图 2（正常）里 SSH 退到整排 chrome 左侧、留出大段空白。两张图**相位相同**（都是主页 hero），差别只在落点。
- **方法（这次不再靠像素反推，直接逐帧量测 + 对照实验）**：用 Playwright 起无头 Chromium，`addInitScript` 在 document-start **复刻桌面壳标题栏**（`#miasaki-titlebar .tb-group` 5 颗 26px 键 + desktop 线 `03-switcher.js` 的两条让位 CSS + `:root{--ms-titlebar-reserve:156px}`），再逐帧（rAF）记录 `--dsh-ssh-launcher-right`、launcher 按钮盒、两个官方锚点的 rect 与**重叠量**。为绕开沙箱对命名管道的限制，浏览器用 `--remote-debugging-port` 单独起、Playwright 走 `connectOverCDP`；页面认证用另起一个 `dsh --profile web --port 3099` 实例拿带 `?token=` 的 URL（`launchToken` 是进程级随机值，外部读不到）。
- **实测事实（两个洞，各自独立可复现）**：
  - **洞 A —— 过渡期间只有一次测量**。右栏开合走官方 CSS transform 过渡（`.P3OORG_panel [data-dockkit-host=dock]{transition: transform var(--ds-transition-duration-slow)}`）。对照实验（探针 B 阶段，157 帧）：只在触发瞬间测一次的实现里，过渡期间 launcher 与刚移入视口的 strip **最大重叠 41px**，要等 `transitionend` 才在下一次纠正 —— 41px 正是用户图 1 那个 `{SSH[]` 叠压的量级。
  - **洞 B —— CSS 变量让位线变化不带任何 DOM 变动（持久性叠压的根因）**。桌面壳侧栏线把安全线 `--ms-titlebar-reserve`（默认 128px → 注入终端键后 156px）写在 `document.documentElement.style` 上；这条线一变，官方整行 chrome 整体平移，而 **`MutationObserver` 的 childList 与右栏属性判据一个都收不到**。对照实验（探针 D 阶段，93 帧）：把安全线 156→220px 后，落点变量**一次都没有重测**（取值序列只有一个旧值），dockkit strip 从 `x[1028,1092]` 移到 `x[964,1028]` 后与 launcher **持续重叠 20px** —— 这正是用户说的「还是会有问题」；而「点击页面后可能恢复正常」是点击引发某处 React 重渲染、**顺带**补上一次测量（= 图 2）。
  - **附带事实**：右栏收起时 `[data-dockkit-strip-chrome]` 被 `transform: translateX(var(--dsh-sidebar-width))` 推到视口右缘之外，实测 `left=1590 / 64×28`（视口 1248）—— 宽高都是真实值，B3 的 0×0 判据拦不住它。
- **归因澄清（防回潮）**：屏外锚点**不是**叠压的根因 —— 让位量取 `Math.min`，屏外坐标（1590）比在场锚点（corner 1080）更大，min 根本选不中它。B4 把「视口外的锚点不参与」加进来，修的是**语义**（否则「量不到」与「量到一个无效值」混在一起、不可分辨），不是为了消除叠压。真正的因果链是「**零 DOM 变动的让位线变化** ⇒ 没有重测信号 ⇒ 落点停在旧值」。
- **修（`client.js`）**：
  - **视口过滤**：新增纯函数 `inViewportRow(rect, viewportWidth)`（有真实尺寸 + 左边界在视口右缘之内），主锚点与紧邻兄弟一律先过它；
  - **过渡期跟随重测**：`startFollow()` / `followTick()` —— 触发后逐帧重测，跟到连续 `FOLLOW_SETTLE_FRAMES=4` 帧不再变化；**并设下限 `FOLLOW_MIN_FRAMES=30`**（≈500ms）：过渡前段 chrome 还在视口外时让位量恒取兜底值、可连着多帧「不变」，只看「稳定」就收手会漏掉它移进视口的那一刻 —— 实测这个早停正是残留 41px 叠压的原因；硬上限 `FOLLOW_MAX_FRAMES=90` 兜住抖动。无 rAF 的宿主（契约测试桩）直接不启动，避免同步递归；
  - **根元素观察（洞 B 的解）**：`rootObserver` 观察 `document.documentElement` 的 `style`，且**同步调用 `syncNow()`、不走 rAF 节流** —— 安全线是 inline style 覆盖 `:root` 声明、同步生效，延后一帧就会露出「chrome 已平移、launcher 还没跟」的窗口（实测 20px）。回调是微任务、浏览器尚未绘制，强制布局读到的就是新位置。`documentElement.style` 的写入方不止本线（皮肤线 / 侧栏线 / 官方都在写），故先做一次**廉价的相关变量比对**（`WATCHED_ROOT_VARS = ['--ms-titlebar-reserve', '--dsh-ssh-chrome-reserve']`，读 inline style 不触发布局），只有真的变了才重测 —— 顺带断掉「写自己的 `--dsh-ssh-launcher-right` 触发自己」的自激环；
  - **补充信号**：`transitionend`（捕获阶段，过渡收尾的权威信号）、`visibilitychange`（后台标签页不跑 rAF）、`document.fonts.ready`（字体落地会改变 chrome 实测宽度）；`resize` 与 body 子树/右栏属性观察照旧；
  - **兄弟链基准修正**：断链判据改用**本锚点自己的** `nodeLeft`，而不是跨锚点累积的 `chromeLeft`（后者会被前一个锚点拉小、导致提前 `break`）；
  - 工厂级 rAF 取用（`hasAnimationFrame` / `raf`）上提复用；fiber 卸载时断开两个 observer、移除三个监听并 `stopFollow()`。
- **对照结果（同一探针，修复前语义 vs 修复后语义）**：

  | 阶段 | 修复前 | 修复后 |
  | --- | --- | --- |
  | A 冷加载（右栏收起） | 179px，无叠压 | 179px，无叠压（不变） |
  | B 右栏展开过渡（157 帧） | 过渡期**持续叠压 41px**，末帧才纠正 | 逐帧轨迹 `179→200→220→236→247→255→261→264`，**0 帧重叠** |
  | D 安全线 156→220px（93 帧） | **落点一次都不重测**，持续叠压 20px | 同步重测到 328px，仅 **1 帧**（≈16ms）过渡态 |
  | C 右栏收起（125 帧） | 跟随 | 0 帧重叠 |

  余下 D 阶段的那 1 帧来自「CSS 变量同步生效」与「MutationObserver 微任务」之间的渲染管线时序；16ms 人眼不可见，且与修复前的**持续性**叠压有本质区别（进一步消除需把落点改成 `calc(var(--ms-titlebar-reserve) + chrome 宽 + gap)` 的纯 CSS 组合式，复杂度与边界风险不值得，此处留档说明）。
- **测试**：`test/client.test.js` 33 → **38 例** ——
  - `B4 视口判据`（纯函数直读：1590/1248 ⇒ 不参与、1028/1248 ⇒ 参与、0×0 ⇒ 不参与、左半截在视口内 ⇒ 参与）；
  - `B4 视口判据进实测路径`（只在场一颗屏外锚点 ⇒ **不写变量**，旧实现会算出 0 后退回兜底；对照：同一锚点移进视口 ⇒ `228px`）；
  - `B4 跟随重测`（受控 rAF 桩：过渡逐帧移入视口 ⇒ 落点跟着改；**下限帧数内即使值不变也继续跟**；下限之后值稳定 ⇒ 自行收手，不排空帧）；
  - `B4 接线静态锁定`（视口过滤两处、局部兄弟基准、`FOLLOW_*` 三常量与终止条件、`startFollow` 的 rAF 守卫、`transitionend` 捕获、`visibilitychange`、`fonts.ready`、`stopFollow`、导出）；
  - `B4 重测信号`（**行为**：渲染 launcher 后有 observer 盯着 `documentElement` 的 `style`；并断言 body 子树的 childList 观察没被取代）；
  - 夹具（非产品）：`capture({ raf: true })` 提供**受控** rAF 队列 + `flushRaf(rounds)`、`capture({ effects: true })` 让 effect 立即执行并收集清理函数、MutationObserver 记录 `observe` 的 target/options —— 后者是「有没有重测信号」这条契约唯一可钉的方式（桩不会自己派发 mutation）。
- **回归**：单测 **121 → 126 例**（app 16 / client 38 / http 7 / runtime 23 / session 34 / store 8）；`node --test test/*.test.js` 全绿。
- **生效方式**：只改 `client.js`（client bundle，不经 `index.js` 的 `cachedAsset`）⇒ **刷新页面即可**（被缓存则硬刷新，或重启 `dsh web` / 桌面壳）。改后实测：探针页面**无需重启实例**即加载到新代码。
- **实机复验待办（桌面壳）**：① 冷启动进主页，SSH **不再**压在任何官方键上，且**不需要**点一下页面；② 点开右栏的全过程里 SSH 平滑让位、无叠压帧；③ 侧栏线注入终端键（`--ms-titlebar-reserve` 128→156px）那一刻 SSH 同步让位；④ 窗口缩放 / 切回窗口（最小化恢复）后落点正确；⑤ 会话窗口（胶囊在场）仍不出现右上角那颗（B2 契约不变）。

## 2026-09-26（B3：主页入口「同排官方 chrome 让位」—— 修「SSH 按钮还是有问题」的叠压）

- **用户复报**：「SSH按钮还是有问题，修复一下」＋两张桌面壳截图（红框圈住右上角那一排）。批注框逐像素量测：图 1 红框 `x[2046,2329] y[16,95]`、图 2 红框 `x[1952,2327] y[14,82]`。
- **先做的事实核验（避免又一次「推演根因」）**：
  - **两张图是同一个页面相位**。用官方 hero 居中布局反推表头高度：图 1 `logo_top=582 / composer_bottom=991 (B=409)`、图 2 `467 / 1103 (B=636)` ⇒ 反推表头高 `H≈57` 与 `H≈56`（同一常量口径），**相差 ≤3px**。若图 2 是「已绑定会话的空白会话」（表头多出 `padding-top 10 + titleRow 30`，右栏折叠时再多 28px 的 ExpandButton），居中块会下移 14–20px —— 实测只差 1.5px ⇒ **两图同相位**，不存在「会话窗口又冒出入口」。
  - **两颗 SSH 都是 launcher、不是胶囊**：沿文字中线扫像素，`x 2082/2085/2088` 全白 ⇒ 没有胶囊的 1px 边框（胶囊有 `border:1px solid --dsw-alias-border-l2` + 半透明底）。胶囊形态排除。
  - **DPI 与窗控口径对齐**：`- □ ×` 三键中心间距 56 物理 px、图标 18px ⇒ 与桌面壳 `#miasaki-titlebar .tb-btn{26px}` + `gap:2px` 在 **200% 缩放**下逐项吻合；侧栏线注入到 tb-group 首位的终端键（`26px`，且把 `--ms-titlebar-reserve` 从 128px 抬到 **156px**）把窗控组左边界推到 `x≈2192` ⇒ `syncChrome` 量出的 reserve ≈158px ⇒ launcher 右缘落在 `x≈2148`。**实测值一致**，说明定位管线本身没错。
- **可见缺陷（本次真正要修的）**：launcher 的按钮盒 `x[2081,2148]`，而官方那颗「▭」的按钮盒 `x[2120,2176]`（会话头 corner 里的「展开侧栏」= 折叠态；右栏展开时同一落点换成 dockkit strip 末端的「收起」键，两者都被壳的 reserve 顶到同一条让位线上）⇒ **按钮盒重叠 28 物理 px（14 CSS px）**，文字与图标净距只剩 **1.5 CSS px**，视觉上贴在一起；右栏展开时左邻又插进「全屏 / 收起」两颗键（`x[1996,2028]`、`x[2058,2090]`），launcher 被夹在中间、两侧各剩 3 物理 px。用户红线框住的正是这一排。
- **根因**：launcher 的 `right` 只按**桌面壳窗控组**算（`--dsh-ssh-chrome-reserve + 16px`），而壳把窗控组之外的空间让给 DSH 官方控件（`--ms-titlebar-reserve`）⇒ 官方控件被顶到窗控组左侧的同一行里，正好压在 launcher 的落点上。**这不是「该不该显示」的问题**（B1/B2 已定：主页显示、胶囊在场时不显示），而是同一行里两块 chrome 抢位。
- **修（`client.js`，沿用本仓既有的「实测让位」纪律）**：
  - 新增纯函数 `launcherClearanceOffset({ viewportWidth, chromeLeft, gap })`（工厂级、`module.exports` 导出供测试直读，同 `readThemeSnapshot` 的做法）：返回 `viewportWidth − chromeLeft + gap`，量不到返回 `null`；
  - 新增 `syncLauncherOffset()`：实测**官方在这一行的 chrome 最左边界** —— `[data-conversation-header-corner]`（会话头右端；canvas 线早已用同一属性做 `:has()` 锚点）与 `[data-dockkit-strip-chrome]`（右栏 dockkit strip 末端两键；desktop 线用它做让位），并**吸收间距 ≤48px 的紧邻兄弟按钮**（strip 末端左边可能还挨着「加标签 / 分栏」等禁用态键）；口径 = `max(壳窗控口径 reserve+16, 躲开官方 chrome 的偏移)`，结果写进 `--dsh-ssh-launcher-right`，量不到时移除变量；
  - CSS 改为 `right:var(--dsh-ssh-launcher-right,calc(var(--dsh-ssh-chrome-reserve,0px) + 16px))` —— **hero 态（量不到）行为逐字不变**，`--dsh-ssh-chrome-reserve` 仍只服务壳窗控口径（iframe 顶栏的 `reserve` 语义不受影响）；
  - 重测时机：`syncChrome()`（apply 期间 + iframe load）、launcher 可见时的 DOM 变动（rAF 节流）、`window resize`；MutationObserver 的观察项**补上 `data-sidebar-right-open` / `data-sidebar-right-panel`** —— 官方 panel 开合是**改属性 + 改 transform**（不卸载、不增删节点），只看 `childList` 会漏掉「dockkit chrome 进出这一行」；
  - fiber 卸载清理新增 `--dsh-ssh-launcher-right`。
- **一次被实机量测推翻的方案（留档，防回潮）**：B3 最初把「会话面板已绑定会话」（`[data-conversation-header-corner]` 存在）当成第三维来**隐藏** launcher。量测证明那会误杀主页入口 —— 空白会话 `hideChrome = blank` 不渲染 titleCluster（胶囊缺席），但官方 `ConversationMainPanel` 的 `hero = sessionId === void 0 || (blank && (open || summaryBlank))` 仍让它处于 hero 相位（输入框居中），**那正是用户口中的「主页」**；B1 的「只在主页显示」锚的也是会话面板这一维。⇒ 判据**维持两维**，该锚点只用于让位测量。回归用例 `D1.1g` 把这个反例钉死。
- **测试**：`test/client.test.js` 29 → **33 例** ——
  - 新增 `B3 让位：偏移 = …`（纯函数：实机口径 1248/1060 ⇒ 196px、chrome 更靠左 ⇒ 更大偏移、gap 可注入、三种量不到 ⇒ null、退化场景不为负）；
  - 新增 `B3 让位：实测路径写落点变量（含紧邻兄弟按钮），量不到时不写`（桩里按实机坐标摆 DOM：corner 锚点 ⇒ `196px`；chrome + 紧邻兄弟 ⇒ `272px`，只量 chrome 会是 210px、仍会叠上；0×0 空容器 ⇒ 不写变量）；
  - 新增 `B3 让位：接线静态锁定`（官方双锚点、`max` 口径、CSS 回落、resize 重测、卸载清理）；
  - 改写 `D1.1g` 为「会话头在场不影响显隐」的反例锁定；`D1.1f` 判据断言回到两维；`D1.1d` 观察项断言补属性过滤；
  - 夹具（非产品）：`document.documentElement.style` 记录 `setProperty/removeProperty`、节点支持 `setRect()` 与 `previousElementSibling`、`window.innerWidth` 可注入 —— 否则让位路径在桩里永远走 `catch` 分支（假绿）。
- **回归**：单测 **117 → 121 例**（app 16 / client 33 / http 7 / runtime 23 / session 34 / store 8）；`node scripts/verify-all.mjs ssh` **12/12 PASS**。
- **生效方式**：改的是 `client.js`（client bundle，不经 `index.js` 的 `cachedAsset`）⇒ **浏览器刷新即可**（被缓存则硬刷新，或重启 `dsh web`）。
- **实机复验待办**：① 主页（hero / 空白会话）右上角那颗 SSH 与左邻的官方「▭」**不再贴在一起**（净距 ≥8px）；② 右栏展开时它退到 dockkit chrome 左侧、不再被夹在中间；③ 右栏收起 / 会话头卸载后落点**可逆地**回到窗控口径；④ 窗口缩放后落点跟随；⑤ 会话窗口（胶囊在场）仍**不出现**右上角那颗（B2 契约不变）。

## 2026-09-25（B2：launcher 与会话头胶囊结构性互斥 —— 修「会话窗口右上角多一颗 SSH」）

- **用户报障**：「右上角 SSH 按钮优化一下」→ 随即澄清「**会话窗口右上角不应该有 SSH 按钮**」＋「**重复了，胶囊有 SSH 按钮入口**」，并附桌面壳窗口截图（红框标出右上角那颗）。
- **现象**：会话窗口里**同时**存在两个 SSH 入口 —— 会话头第一行的三段胶囊「对话｜会话布｜SSH」，以及右上角（窗控左侧）那颗独立 `SSH`（`shell.overlay` 的 launcher）。放大截图逐像素确认：红框内那颗是粗体 `SSH` 文字（launcher 的 `font:600 12px`），与胶囊里的 SSH 段是两处独立 DOM。
- **根因（判据推演 ≠ 官方渲染条件）**：D1.1 的 launcher 判据读官方 `useSessions` 的 `SessionSummary.blank`（`blank === true` ⇒ 当作 hero ⇒ 显示），但官方真正决定会话头 chrome（含 `conversation.session.header.actions` 槽）渲不渲染的是
  `blank = session === void 0 || conversation === void 0 || (session.blank && conversationPhase(session, conversation) === "blank")`
  （`dsh-client-ui-conversation/lib/client.js` 的 `ConversationHeader` → `renderSlot("conversation.session.header", { hideChrome: blank })`，`hideChrome` 正是那坨 titleRow chrome 的开关）。**两个 blank 语义不同**：`SessionSummary.blank` 仍为真、而 `conversationPhase` 已经不是 blank 时，官方 `hideChrome = false` ⇒ 会话头**带 chrome 渲染、胶囊出现**，旧判据却照样返回 hero ⇒ launcher 同时渲染 ⇒ 双入口。旧判据里的「摘要未就绪 ⇒ 保守显示」是同一类误判的第二个入口（`byId[current]` 取不到时一律显示）。
- **修（`client.js`，只认 DOM 事实）**：
  - 新增 `OWN_ENTRY_SELECTOR = '.dsh-ssh-switch'` 与 `ownEntryPresent()`；判据收敛成一条 `launcherShouldRender() = onConversationHome() && !ownEntryPresent()` ——「**在主页**」**且**「**本线胶囊不在场**」；
  - hook 更名 `useOnConversationHome` → `useLauncherVisible`（MutationObserver 观察 body 子树 + rAF 节流、只在布尔翻转时 setState，均不变）；
  - `SshLauncher` 与 `LauncherButton` **合并为一层**：本组件不再消费任何官方 prop（`useSessions`），「React 规则：hook 不能条件调用」的拆层前提随之消失；
  - **为什么这里可以用 DOM 探测**：探的是**本线自己的产物**（`.dsh-ssh-switch` 是本线注册的胶囊），不是官方内部结构 —— 与本线既有手法同源（`syncChrome()` 用 `.dsh-canvas-switch` 的存在性算 `canvasAvailable`，那条注释写的就是「判据必须来自真实 DOM 查询」）；它也**不受官方 blank / conversationPhase 语义漂移影响**（本次事故的根因正是语义漂移）。降级方向同样安全：胶囊真不在场（注册失败 / 会话头未渲染）时 launcher 顶上兜底。
  - **顺带修掉首帧闪**：会话头与本线 launcher 是**两棵不同的 fiber**（前者在 `conversation` 面板、后者在 root 的 `shell.overlay`），而 React 的 render 阶段不改 DOM ⇒ 首次渲染时 launcher 读到的 DOM 还没有胶囊，判据必然先返回 true。订阅原先挂在 `react.useEffect`（**paint 之后**）⇒ 刷新时停在会话窗口会**先画出一帧多余的 SSH**。改为 `usePaintEffect`（= `useLayoutEffect` 优先，commit 后 / paint 前执行，其 setState 补偿渲染在同一帧内完成）；单测的 react 桩没有 `useLayoutEffect` ⇒ 退回 `useEffect`（行为不变）。
- **测试**：`test/client.test.js` 27 → **29 例** ——
  - 判据用例重写为「① 主页 + 无胶囊 ⇒ 渲染；② 胶囊在场 ⇒ 不渲染；③ 胶囊退场 ⇒ 恢复（**可逆**，证明不是被写死成一律不显示）」；
  - 新增 `D1.1e`：复刻事故组合（胶囊已在 DOM ⇒ launcher 必须为 `null`，**与会话 store 报什么状态无关**）；
  - 新增 `D1.1f`：静态断言 —— 判据必须锚定 `OWN_ENTRY_SELECTOR`、必须是 `onConversationHome() && !ownEntryPresent()`、订阅必须走 `usePaintEffect`（`useLayoutEffect` 优先），且 `useOnConversationHome` / `LauncherButton` 不得回来（防止判据被改回「推演官方 blank 字段」）；
  - 断言口径随组件合并从「两层求值（`outer.type(outer.props)`）」改为「单层直接调用」，另 4 处用例的 launcher 调用同步改写。
- **回归**：单测 **115 → 117 例**（app 16 / client 29 / http 7 / runtime 23 / session 34 / store 8）；`node scripts/verify-all.mjs ssh` **12/12 PASS**（6 个 `--check` + 6 个测试文件）。**环境注记**：本机受限沙箱下 `node --test test/*.test.js`（node test runner 的进程隔离经管道 spawn）会以 `spawn EPERM` 失败 —— 环境限制而非代码缺陷；单测因此另用 `node <file>` 直接执行逐项复核，与 `verify-all` 结果一致。
- **生效方式**：`@miasaki/dsh-ssh` 以 junction 链入 web profile，改的是 `client.js`（client bundle，不经 `index.js` 的 `cachedAsset`）⇒ **浏览器刷新即可**（被缓存则硬刷新，或重启 `dsh web`）。
- **相邻场景已排除（层级取证，不是推断）**：自然会问「那画布浮层 / SSH 浮层打开时，右上角是不是又叠一颗」。查官方 `dsh-client-ui-layout` 的样式：`shell.overlay` 所在层是 `.pI_x6G_overlayLayer{z-index:20;pointer-events:none;position:absolute;inset:0}`，而本线 SSH 浮层与 canvas 浮层都是 `position:fixed;z-index:100;inset:0` ⇒ **全屏浮层必定完整盖住 launcher**（z-index 100 > 20），不存在「浮层之上还压着一颗 SSH」的重复；指针事件也随之被浮层接管，那一颗点不到。
- **实机复验待办**：① 会话窗口右上角**不再**出现 SSH（只剩胶囊那一段）；② hero（首屏 / 新会话）仍能从右上角进入；③ 设置页 / 轨迹页仍不出现；④ 从会话切回 hero（或返回首屏）时入口**能恢复**（可逆性）；⑤ 刷新时**不闪**一颗多余的 SSH（首帧防闪）。

## 2026-09-25（B1：launcher 越界修复 —— SSH 入口只在主页显示）

- **用户报障**：「右上角这个 SSH 按钮应该只在主页显示，而不是每个界面都有」。
- **根因（两维判据缺了一维）**：hero 态常驻入口注册在官方 `shell.overlay`，而它是 **root 级浮层、每一屏都会渲染**；D1.1 的判据却只有「会话是否空白（hero）」这一维，**在设置页 / 轨迹页等非会话界面上同样成立**（那些界面下当前会话依旧是空白、或摘要未就绪 ⇒ 判据保守返回 true）⇒ 入口跟着浮层出现在**每一屏的右上角**。会话头胶囊那条入口（`conversation.session.header.actions`）不受影响 —— 它本来就只在会话面板渲染。
- **修（`client.js`）**：补第二维判据「**在不在主页**」——
  - `CONVERSATION_PANEL_SELECTOR = '[data-slot="main.conversation"]'`：官方隔离契约里该锚点**只在会话面板激活时存在**（其它主面板激活时它不存在）。取中栏仍首选 `[data-slot="main"]`，本处只判「激活与否」；
  - `useOnConversationHome()`：面板切换由官方 React 增删 DOM 完成、**没有可读信号**（`ctx.uiWorkspace` 只给导航动作，不给「当前 main 是谁」），故用 `MutationObserver` 观察 body 子树，**rAF 节流**合并流式输出期的高频变动，只在布尔值真正翻转时 `setState`；
  - `LauncherButton` 判据改为 `if (!hero || !onHome) return null`（hook 无条件调用，守 React 规则）。**hero 那一维仍走官方 `useSessions`** —— 这不是把「有没有会话」改回 DOM 探测。
- **测试**：`test/client.test.js` 25 → **27 例**——
  - `D1.1c` 非主页不渲染：`capture({ home: false })` 模拟设置页，无会话 / 空白会话两种输入**都不得渲染**；随后补上锚点**恢复渲染**，证明判据读的是锚点而不是被写死成「一律不显示」；
  - `D1.1d` 锚点与官方契约一致 + 靠 `MutationObserver` 跟随切换。
  - **夹具修复（桩缺陷，非产品）**：DOM 桩的选择器解析器在整段上匹配 `.`，把 `[data-slot="main.conversation"]` 属性值里的 `.conversation` 误当成类选择器 ⇒ 改为**先剥属性段再取类名 / id**。真实 DOM 无此问题，影响面仅测试文件。
- **回归**：`node --test test/*.test.js` **115/115**；`node scripts/verify-all.mjs ssh` **12/12 PASS**。
- **生效方式**：`@miasaki/dsh-ssh` 以 junction 链入 web profile，`client.js` 改动即时落到 profile；**浏览器刷新页面**即加载新 bundle（若被缓存则硬刷新，或重启 `dsh web`）。
- **实机验收待办**：① 主页（首屏）入口仍在；② 设置页 / 轨迹页 / 用量浮层等界面**不再出现**右上角 SSH；③ 会话内胶囊入口不受影响。

## 2026-09-16（第十三批：U2 实机验收 —— 4 处回归定位并修复）

- **U2 实机验收：自动化全绿，实机在「首次连接」即被挡住。共发现 4 处真实缺陷（2 阻断 / 1 高危 / 1 中危），全部已定位并修复（含 3 条新增回归断言）；单测 110 → 113 例、`verify-all ssh` 12/12。**完整报告：[U2 实机验收报告](2026-09-16-ssh-u2-acceptance-report.md)；通道同 D2/D3/D4（真 Edge × 真实 DSH GUI × 真实鼠标/键盘 × 本地假 sshd 真协议），驱动与结果归档 `_refs/scripts-archive/ssh-u2-accept/`。
  - **U2-A（阻断）首连的指纹确认入口被 `STALE_SHELL` 覆盖**：等待指纹阶段 viewer 依 U0 契约已 attach，而此时**没有任何 shell** ⇒ `session.js` 无条件发出的 input/resize 被 host `currentShell()` 判为绑定失效，`STALE_SHELL` 经 `onStatus('error')` 写成 `frameState`，**覆盖 `renderBanner` 的 waiting-fingerprint 分支**（该分支是唯一带「核对指纹」按钮的）⇒ 新主机彻底连不上；状态栏「指纹待确认」按钮 onclick 实为 `trustListSheet()`（打开信任记录列表，此时为空），**不是确认入口**。最小复现 `diag-tofu.mjs`：45s 采样内「核对指纹」从未出现、横幅在第 3 个采样点（≈1.2s）即被覆盖、远端 `tcp-connect=1 / auth-ok=0 / shell=0`（握手停在 hostVerifier）。**修**：未绑定 shell 时**不发** input/resize，并在绑定后由新增 `syncSize()` 补发一次真实尺寸（U0 契约不丢）。
  - **U2-B（阻断）连接就绪时不补绑已 attach 的 viewer**：`onReady()` 建好主 shell 后只 `broadcast({ type:'ready', state:'connected', runtimeId, shells })` —— **不带 `shellId`、也不做服务器端绑定** ⇒ 等待指纹期间 attach 的 viewer 永远停在 `shellId=null`，指纹确认通过后终端仍不可用（实测：手动点一次标签重挂走全新 attach 才拿到绑定）。**修**：`onReady` 遍历 `rc.sockets`，对尚未绑定 shell 的 viewer 调 `bindShell()` 并逐发带 `shellId / mode` 的 `ready`。
  - **U2-C（高危 · 方案 §8 风险表第一条）同主机多 shell 输入串台**：两处根因叠加 —— ① `app.js openHost()` 用 `state.tabs.find(item => item.connId === id)` 找标签，同主机多 shell 时**永远命中第一个标签**，于是激活第 2/3 个标签反而改写第一个标签的 `shellSeq` 并把 `activeTab` 指回 0；② `session.js` 拿到票据后 `info.shells.find(sh => sh.state === 'live')` **无条件取第一个 live shell**，覆盖了调用方传入的 `shellSeq`。实测三个标签各发一个标记，sshd 侧 `inputChannels [1,1,1]`（全部落在 ch-1），标签 2/3 的屏幕显示的是 ch-1 的内容。**修**：`openHost` 支持 `tabIndex` 精确定位（`openHostAt` / 关闭接续 / 挂载恢复三处调用点同步）、票据 shell 清单按 `shellSeq` 精确匹配（仅「无 seq 的全新打开」才回退）、`index.js` 的 `/ssh/api/attach` 返回补 `shellSeq` 供前端匹配。
  - **U2-D（中）恢复后标签错乱 / 点标签空白**：上条的连锁 —— 刷新后恢复出 `["… #3","… #2","… #3"]`（缺 `#1`、`#3` 重复）、点标签屏幕空白、关闭对话框缺「关闭此 shell（连接保留）」（其条件依赖被错置的 `activeTab`）。随 U2-C 一并闭环，待重启复验。
  - **运行态核查（逐字节，非推断）**：`session.js` / `app.js` / `styles.css` 运行态与磁盘 **SHA256 完全一致**；host 半确认是 U2（`/ssh/api/attach` 命中 U2 分支的 404 文案）。**但 `/ssh/vendor/addon-serialize.js` 运行态返回 79 字节占位脚本** —— 根因是启动时序：宿主 **12:52:17** 启动、而 `@xterm/addon-serialize` **12:57:17** 才装进 `node_modules`，`index.js` 的 `hasSerializeAddon` 只在 apply 时判定一次 ⇒ **U2.4 本轮实际没有上线**（重启即解，非代码缺陷）。
  - **已 PASS 的实机项**（在两处阻断被绕过后取得）：**双窗口单写多读**（第二窗口只读条在场、原 owner 保持可写、**零新建 TCP 连接**）+ **显式接管**（原 owner 即时转只读、新 owner 输入送达远端、可夺回）；**3 个 shell 建立**（host `sh-1..3` × sshd 3 个 shell 事件 × 3 个标签）；**刷新后标签数量恢复且 `tcp-connect`/`shell` 事件零增长**（零自动连接）；**损坏快照不白屏**；**旧帧收 `VERSION_MISMATCH`**。
  - **夹具缺陷（非产品，已修并登记在报告 §4）**：假 sshd 的 `pty` 事件早于 `shell` 到达导致 channel 归属丢失（改 pending 补写）；后台标签页 rAF 节流使 `.xterm-rows` 读到旧内容（读前 `Page.bringToFront`）；关闭对话框未关会盖住终端、后续输入被 sheet 吃掉（用后即关）；`+` 需先把 selection 归位；prefs 判据误设（偏好只在用户改设置时落盘）。
  - **环境适配记录**：受限沙箱下 Edge 与 Chrome 均以 `STATUS_BREAKPOINT` 退出，Edge 日志定位为 `FATAL:mojo/platform_channel.cc Check failed: 拒绝访问 (0x5)`（Chromium 的 Mojo IPC 需要命名管道，受限模式禁止）⇒ 完整访问下浏览器正常、驱动全程可跑。复跑本驱动的人需注意这一点。
  - **待重启复验**：P0b（TOFU 入口）、P1b（三 channel 应为 `[1,2,3]`）、P2a（关闭三分支齐备）、P3（per-shell 尺寸）、P5b/P5c（两张据与重附着）、P7（8 shell 上限 + host RSS）、U2.4 判据（`run-u2-tui.mjs`：TUI 刷新后逐行 + 光标行一致 ×3）、三主题回归。**本轮改动已提交**（`fix(ssh): U2 实机验收定位并修复 4 处回归（2 阻断 / 1 高危 / 1 中危）`）。

## 2026-09-16（第十二批：U2.1 多 shell + U2.3 工作区记忆 + U2.4 精确恢复）

- **U2 主体落地**（按 [U2 规划](2026-09-15-ssh-u2-plan.md) §6 顺序：U2.1 → U2.3 → U2.4，U2.2 SFTP 留待下一阶段用真实主机补验）。交接文档（变更清单/基线对照/回滚演练/风险表）：[实施验收包](2026-09-16-ssh-u2-implementation-report.md)。
  - **U2.1 身份分层 + 多 shell**：`lib/runtime.js` 重写为三层身份（`connId → runtimeId → shellId`）—— `conns` 改按 `runtimeId` 键控 + `byProfile` 映射，`ShellChannel` 承载独立 stream/尺寸/回放环/viewer 集合/写入所有权；shell 结束 ≠ 连接结束；同 runtime 上限 8（决策 1）。**安全前置**：WS attach 帧必须持 `POST /ssh/api/attach` 签发的一次性 30s 票据（消费即废、重放/过期/teardown 全拒 `TICKET_INVALID`），落实规划 §8「不得把运行连接 ID 当授权证明」。**写入所有权（决策 2）**：单写多读 + 显式接管（`shell.takeover`，原 owner 即时转只读收 `write.revoked`）；非 owner 的 input/resize 一律拒收 —— 「最后一个 resize 获胜」连同初始 attach 尺寸一并堵死。**协议**：WS 全帧 `v:2`，旧帧拒收并提示刷新（`VERSION_MISMATCH`，方案 §3.3 不做双栈）。前端 `state.tabs` 结构化为 `[{connId, shellSeq, title, live}]`，标签栏「+」= 新建 shell 标签（tabstrip 与主机菜单双入口）；关闭对话框区分「仅关闭查看 / 关闭此 shell（连接保留）/ 断开整个连接」。
  - **U2.3 工作区记忆（决策 4）**：拆两张据 —— 偏好（字号/rail 折叠/专注）→ `localStorage['dsh-ssh:prefs']` **v2**（增 version 字段，读取兼容 v1）；工作区快照（标签集合 + 激活项 + 抽屉状态）→ `sessionStorage['dsh-ssh:workspace']` **v1**，统一 `sessionStore` 封装全 try/catch。恢复语义 = **恢复标签形状，绝不自动连接/输凭据**：刷新后激活标签仅在 host 侧连接仍存活时重挂 attach，失效 connId 静默丢弃 + 提示；快照损坏/版本不认/无痕模式一律回默认不白屏。**修复**：原 `PREFS_KEY` 与 `LAST_TAB_KEY` 同为掩码字面量 `'***'`（上一会话脱敏写入事故）导致两据同键互相覆盖 —— 本轮重写为真实键名后消除。
  - **U2.4 精确恢复（决策 6 → 方案 A）**：官方 `@xterm/addon-serialize` **0.14.0 精确锁定**（探针 B 已证兼容 xterm 6.0.0）；session.js 输出空闲 1.5s 采集序列化快照上报 host（每 shell 内存态封顶 128KiB、scrollback 500 行，不落盘）；附着恢复三路判定 = 快照帧优先（reset 后重放）/ 回放兜底（刷新后）/ 重附着丢弃整段回放（防翻倍）；addon 缺失/加载失败静默降级为回放恢复（删包即单独退出 U2.4，不动 U2.1/U2.3）。
  - **验证**：单测 **85 → 110 例**（runtime 22 / session 32 / http 7 全部重写适配 v2 契约，app 16 / client 25 / store 8 无回归），`verify-all ssh` **12/12**；端到端探针 `u21-verify-runtime.mjs`（真 sshd × 本线 SshRuntime）**9/9** —— 探针 A 基线的 P1–P4 判据在改造后真实链路全部复现（4 shell 隔离 / 尺寸按 channel 精确对应 / 输出隔离 / shell 退出其余存活），另证写权与票据生命周期；**回滚演练实际执行**（基线恢复 85/85 绿 → U2 还原 110/110 绿）。**待实机验收**：vim/top 刷新恢复逐行一致（§4.4.3）、双窗口写权互斥、8 shell RSS、三主题回归。
  - **偏离登记**：决策 5 的「app.js 纯搬迁拆分」本轮未执行（改造以补丁叠加，避免搬迁与逻辑混在一个 diff），列入 U2.2 前置工单；风险表与交接文档均已登记。

## 2026-09-15（第十一批：抽屉窗控让位修复）

- **实机反馈修复：抽屉标题栏的 × 与桌面壳窗控组叠在同一块像素上**（用户截图报告，本线首个「壳窗控让位」缺口）。
  - **取证（截图逐像素量测，非推断）**：桌面壳窗控组（`#miasaki-titlebar .tb-group`，fixed `top:11px / right:8px`）中心 y≈23；抽屉 `.sheet-head` 的 `.icon-btn`（30×30）中心 y≈32、距右缘 35px（= 20px padding + 15px 半宽）⇒ 两者水平错位 14px、垂直错位 9px，**叠在一起**（放大图上就是"两个 ✕"），抽屉那颗被 z-index 100000 的窗控压住点不到。根因：`.topbar` 早已消费 `--ssh-chrome-reserve`（D2），而**抽屉从来没让位**。
  - **修法：垂直让位，而不是把 × 往左推**。`app.js` 新增三个函数：`computeChromeClearance()`（纯函数）、`measureChromeClearance()`（读父文档）、`syncChromeClearance()`（写变量）。口径 = 用**父视口坐标**下的窗控组矩形与 `window.frameElement` 矩形相减，得「本 iframe 内需要让开的顶部高度」（窗控下沿 − iframe 顶 + 8px 呼吸），写进 `--ssh-chrome-clearance`；`styles.css` 的 `.sheet` 消费它（`margin-top` + `height: calc(100% − …)`）。iframe 本就在窗控下方时（会话视图里 iframe 从会话头下开始）差值为负 → 归零 ⇒ 两种挂载形态（浮层 / 会话视图）**一套算法、无分支**。窗口尺寸变化用 rAF 合并的 resize 重测（会话视图下 iframe 右缘会随中栏宽度动）。
  - **为什么不水平让位**：① 会话头第一行的入口胶囊（窄窗口紧凑态 `>_`）也在这一行，往左让位会撞上它；② 窄窗口里会把 × 推到抽屉中间、标题栏右侧空出一大片，读感更差。垂直让位一次避开两者（探针图里可见：修复后顶部灰带同时露出 `>_` 与窗控）。
  - **兜底与零副作用**：量不到窗控组（浏览器 / 跨源）但宿主下发了 `reserve` 时，退回水平让位（`--ssh-chrome-avoid-right` → `.sheet-head` 的 `padding-right`）；两者皆为 0 时抽屉照旧顶格满高。顶层窗口（直接打开 `/ssh/`）与跨源抛错都静默降级为"不让位"，不冒泡。
  - **验证**：单测 **82 → 85 例**（新增 3 例：让位量纯函数边界 / 量测与两条兜底分支 / 样式契约），全套 85/85 通过（app 16 + client 25 + http 3 + runtime 14 + session 19 + store 8）。另有一次性探针（`headless Chrome × 桌面壳几何复刻`，含真实 `styles.css` 与抽屉 DOM）出前后对照图 —— 修复前两个 ✕ 叠在一起；修复后抽屉下移 45px、`sheet` 贴右缘且 `close` 距右缘 20px，× 与窗控垂直分离 41px。探针文件与截图**用完即删**，不入库。
  - **影响面与回滚**：只动 `app.js`（新增测量函数与 resize 重测，未改既有消息协议）与 `styles.css`（`.sheet` / `.sheet-head` / `.sheet-head h2` 三条规则）；`--ssh-chrome-reserve` 通道、顶栏行为、`client.js` 全未触碰。回滚 = 撤掉新函数与两条 CSS 规则，抽屉回到顶格。
  - **生效方式**：`app.js` / `styles.css` 走 `index.js` 的 `cachedAsset`（进程内一次性缓存）⇒ **必须重启 `dsh web`**，浏览器强刷不够。

## 2026-09-15（第十批：U2.0 SPIKE 验收）

- **U2.0 SPIKE 验收：批内不通过 → 补做探针后四项命门全部回答**（[U2 规划](2026-09-15-ssh-u2-plan.md) 新增 **§12 验收记录**）。批内 SPIKE 归档 `_refs/scripts-archive/ssh-u2-spikes/`（charter + S2/S3/S4），本轮**独立复核**并补做 `_refs/scripts-archive/ssh-u2-verify/`（探针 A/B/C，判据自证非空）。
  - **批内判定**：**S1**（SFTP 能力与基准）**受阻待放行**（脚本骨架在会话临时区 `.openclaw/tmp/d0/spike-s1-sftp.mjs`、判据已书面化、护栏拦截未跑；实施者已论证它**不阻塞** —— SFTP 走 ssh2 原生能力、无新依赖，S1 只剩性能基线）；**S2**（多 shell）**判据未覆盖问题** —— 用两个 `new RuntimeConn()` 对象代替"一个 ssh2 Client 上的两个 channel"，用例 5 验证的还是脚本里**自写的 `resizeTo` 函数**（并自注"此处无 stream"），全程无 Client/channel、`stream` 恒为 null，用例 2/6/7 属同义反复；**S4**（精确恢复）**验错对象** —— 从未加载 `@xterm/addon-serialize`，用的是探针页自写的 `serializeBuffer`（逐 cell dump 成 JSON），`mismatches: 0`/"ratio: 1" 是"自己 dump 自己 restore"的**必然结果**；**S3**（工作区记忆）方法有效（原型明确标注非生产代码）但落点与 §10 决策 4 冲突（全塞 localStorage 一张据）。**形态定性：D1「探针可达 ≠ 用户可达」的同族 —— 「验证的是自己构造的对象，不是真实链路」。**
  - **补做探针（全部通过）**：**A**（真 ssh2 Client × 真假 sshd，7/7）—— 同一 Client 连开 **4 个 shell channel**；四者各设尺寸 → 服务端记录到**精确对应**的 `window-change`（132×33/140×35/148×37/156×39，4 个不同 channel）；只往 ch2 写标记则**只有 ch2 收到回显**；**服务端让 ch2 退出 → ch2 关闭、其余 3 个继续 PONG**（shell 结束 ≠ 连接结束）；ch4 注入 **32MiB** 期间 ch1 的 PING 往返**稳定 20ms**（空载 21ms）；`client.sftp()` 与 4 个 shell **并存**。**B**（npm `addon-serialize@0.14.0` 原样产物 × 本线 xterm **6.0.0**，4/4）—— UMD 加载 + 构造 + `loadAddon` **零异常**（元数据虽无 peer 声明但**实测兼容**）；普通缓冲区 43 行 → serialize **834 字节** → 回放**逐行一致**；alt-screen TUI 24 行 → **1760 字节** → 一致且 `buffer.active.type === 'alternate'`。**C**（真 GUI，4/4）—— 浮层 iframe 的 sessionStorage **刷新后保留**、**新标签页不可见**（`probe`/`overlayMemory` 均为 null）⇒ 决策 4 落地前提成立。
  - **四问的答案**：S-U2-1 **可行**（尺寸/输出/生命周期隔离精确）／S-U2-2 **可行**（本机回环下大流量零退化；广域网带宽竞争待 U2.2 用真实主机复验）／S-U2-3 **兼容** ⇒ §4.4 方案 A 可用、**U2.4 从"可选"升级为"有实现路径"**（体积随 scrollback 线性增长，落地需配滚动上限或分区 serialize）／S-U2-4 **成立**。**判定：Go —— U2 可以开工**，按 §6 顺序 U2.1 先行。
  - **一处更正（验收方自纠）**：实施者的交付其实**完整** —— 工作区规划新增 **§14《U2.0 SPIKE 决策建议书》**（四项结论 + 三个实施前提 + 待办 + 事故记录）与 `design/preview/2026-09-15-ssh-u2-spike-report.html`；§12.3.1 给出"**结论方向一致、判据路径不同**"的交叉口径（S2/S3/S4 均 GO 的方向被本次复核独立证实；分歧只在判据路径与两处落点：记忆存哪、恢复用自研还是官方 addon）。本轮否定的是**判据强度**，不是交付完整性。
  - **副带发现（已修复）**：验收中查出本线 `node_modules` 于 **21:04**（批内 SPIKE 时段）被污染 —— 混入 `eslint`/`@babel`/`@esbuild` 等**不属于本线**的依赖树，且 `ssh2` 包**本体丢失**（随包 `SFTP.md` 也没了）⇒ `require('ssh2')` 直接 MODULE_NOT_FOUND、`verify-all ssh` 一度不可跑。确认 `pnpm-lock.yaml`（9/9 未变）与 `package.json` 干净后，**删除 `node_modules` 再 `pnpm install`** 恢复（`verify-all ssh` 回到 **12/12**）。**教训**：pnpm 的 `--frozen-lockfile` 与 `--force` 都报 "Already up to date" —— 它只校验链接与 lockfile 一致，**不校验包内文件完整性**，包被掏空时察觉不到；SPIKE 临时试用依赖（如 charter 提到的 node-ssh 候选）应装在会话临时区，别动本线 `node_modules`。

## 2026-09-15（第九批：工作区 U2 规划）

- **工作区 U2「效率补齐」规划设计（v0.1 待评审，本轮只产出方案文件、未实施业务代码）**（新文件 [2026-09-15-ssh-u2-plan.md](2026-09-15-ssh-u2-plan.md)）。范围 = 工作区优化规划 §9 的 U2 四项：**同主机多 shell / SFTP / 工作区记忆 / 精确终端恢复**。
  - **现状取证（代码事实，非推断）**：`lib/runtime.js:52` 的 `conns: Map<connId, RuntimeConn>` ⇒ **profile id = runtime id = viewer 绑定键**三者合一；`RuntimeConn` 只有一条 `stream`（`runtime.js:236/391`）且 shell 关闭即 `dispose()` 整个连接（`248-255`）；回放环与尺寸都是**连接级**（`393-394`/`405-406`）⇒ 多 shell 不是"多几个标签按钮"而是**身份分层**问题（与规划 §5.1 判断一致）。
  - **核心设计：三层身份 + 短期附着票据**（落实规划 §8 硬要求"不得把运行连接 ID 本身当作授权证明"）——`connId → runtimeId → shellId`；附着走 `POST /ssh/api/attach` 签发**一次性 30s 票据**（与既有指纹确认 token 同构：随机 + generation 绑定 + teardown 联动失效）；**写入所有权 = 单写多读 + 显式接管**（落实 §5.3"不能最后一个 resize 获胜"）；同主机仍限一运行连接，多 shell 是同一 ssh2 Client 上的多 channel。
  - **SFTP 通道选型**：在"复用 `/ssh/ws` 发帧 / **REST 流式 HTTP** / 独立 WS 端点"三者中取 **REST 流式**（大文件天然流式 + 浏览器原生下载与 `<input type=file>` 上传）；**关键安全决策：host 端不做任何本机文件系统读写**（上传 = 浏览器 File → HTTP → 远端；下载 = 远端 → HTTP → 浏览器落盘）⇒ 规避"远程内容写入本机任意路径"，也不需要 host 临时目录；配套 `realpath` 规范化、拒绝 NUL/换行/超长、符号链接默认不跟随、覆盖与删除二次确认、并发 2 + 仅空目录可删（**无递归删除**）、内存审计环（不记内容）。ssh2 1.17.0 随包 `SFTP.md` 确认能力齐备 ⇒ **零新依赖**。
  - **工作区记忆落点（拆两张据）**：偏好（字号 / rail 宽度与折叠 / 专注）继续 `localStorage`（跨标签页共享）；**工作区快照进 `sessionStorage`**（按标签页隔离，避免两个窗口互踩同一"现场"）；恢复的是**标签形状而非连接**（不自动建连、不自动填凭据，符合 §5.2）；损坏数据一律降级回默认、不白屏。
  - **精确恢复被降级为可选项**：D0–D4 已证明常驻 iframe 让"切走切回"零损失 ⇒ 该需求只剩"页面刷新 / 换浏览器"两个场景。平台事实：`@xterm/addon-serialize` 稳定版 `0.14.0` **无 peer 声明**（元数据无法证明兼容本线 xterm **6.0.0**），beta 线声明需 `^6.1.0-beta.304` ⇒ 必须 SPIKE 实测；不过则记为已知边界或走自研快照。
  - **分期**：**U2.0 SPIKE**（4 项，其中 S-U2-1/2 建议与 Agent 化规划的 S4 合并成一次探针）→ **U2.1** 身份分层 + 多 shell（含 `app.js` 纯搬迁拆分，它已 1731 行）→ **U2.2** SFTP → **U2.3** 工作区记忆 → **U2.4** 精确恢复（可选）。理由：U2.1 是其余三项的地基（没有票据与分层，SFTP 就没有安全授权面）。
  - **待决策 7 项**见方案 §10：多 shell 上限 / 写入所有权模型 / 上传上限 / 记忆落点 / `app.js` 拆分 / U2.4 取舍 / 与 A1 的共享边界（路径规范化与审计环是否抽公共模块）。
  - **决策记录（2026-09-15 用户逐条拍板 7 项，方案 **v1.0 已定稿**，见 §10）**：① **工作区记忆拆两张据** —— 偏好（字号 / rail 宽度与折叠 / 专注）继续 `localStorage` 跨标签页共享，工作区快照（标签集合与激活项 / 抽屉状态 / 每主机最近 SFTP 路径）进 `sessionStorage` 按标签页隔离，**不新增 host 侧写盘面**；② **`app.js` 先做纯搬迁拆分**（不改行为，只挪文件 + 补模块边界测试）并作为 U2.1 的第一步。**7 项全部已定**（多 shell 上限 8 / 单写多读+显式接管 / 上传 512MiB / 记忆拆两张据 / `app.js` 先纯搬迁拆分 / U2.4 待 S-U2-3 实测再定 / 抽 `lib/paths.js` + `lib/audit.js` 与 A1 共用）⇒ **方案定稿，无待定项**。**尚未开工**：首个动作建议为 U2.0 的四项 SPIKE（S-U2-1/2 与 Agent 化规划尚未做的 S4 合并成一次探针）。
  - 文档同步：`README.md` 文档表与目录结构新增本方案、里程碑 M2 行更新为"规划已出"。

## 2026-09-15（第八批：D4 实机验收）

- **D4 实机验收：6 项门槛全 PASS（`allPassed=true`）**（[全屏浮层方案](2026-09-14-ssh-fullscreen-overlay-plan.md) 新增 **§20 验收记录**）。**独立重跑运行态**（真 Edge × 真实 GUI × 真实鼠标/键盘 × 本地假 sshd 真协议），**尾项①与②都取运行态证据**、不采信静态断言；驱动归档 `_refs/scripts-archive/ssh-d4-accept/run-d4-accept.mjs`（约 4 分钟可复现，结果 `d4-accept-result.json` + `shots/`）。
  - **尾项①（核心判据）**：真实连接流程逐帧采集横幅 —— 可见态 `hidden:false / display:flex / childCount:3`（图标 + 文案 + 「核对指纹」按钮）→ **连接完成后 `hidden:true / display:none / childCount:0`**（旧实现只设 `hidden`，3 个节点会留在 DOM）。补充验证**清空后仍能重建**：断开连接后横幅再现且 `childCount:4`（「编辑主机」/「重新连接」）⇒ 清空逻辑没把功能弄坏。
  - **尾项③**：过渡区间落位实测 —— 1280 → rail 232（全宽）/ 860 → rail 208（紧凑档 721–960）/ 600 → 抽屉 / **500 → 抽屉且 `.tools .optional` 可见（480 档未触发）** / **480 → 抽屉且 `.tools .optional` 隐藏（480 档命中）**；五档**零横向溢出**（首尾档与三个过渡档一次跑齐）。
  - **尾项②运行态**：30 次开关浮层 → **零 JS 异常**、iframe 未重载（window 标记存活）、远端**零 resize 帧**。静态侧：`observer.observe(header, { childList: true, subtree: true })`（`attributes`/`attributeFilter` 整组已移除）、`aria-selected` 产品码只剩一条说明注释、`data-width-handle` 全仓 grep 零命中。
  - **D3-F1 实机复核**：注入样式（2674 字符）**零 `width-handle`** ⇒ host 已加载删除后的 client.js。
  - **例数校正（第二次同类笔误）**：第七批写的「单测 65/65」是沿用旧基线的笔误，实测 **82 例**（app 13 + client 25 + http 3 + runtime 14 + session 19 + store 8），`verify-all ssh` **12/12**；已在第七批与 §19 两处就地校正。教训：**例数必须现跑现抄**。
  - **判定：D4 完全达标** —— 三项尾项全部闭环且经运行态复核。

## 2026-09-15（第七批：D4 尾项清理）

- **D3 验收三项尾项一次清掉：探针 10/10、单测 82/82（验收时实测校正，实施记录原写 65/65 为沿用旧基线的笔误）、verify-all 12/12 全绿**（[全屏浮层方案](2026-09-14-ssh-fullscreen-overlay-plan.md) 新增 §18 尾项闭环记录）：
  - **尾项① renderBanner 隐藏时清空横幅内容**（§16.4-3 顺延项）：`renderBanner()` 入口在 `banner.hidden = true` 后追加 `banner.replaceChildren()`——隐藏态 = 空容器，不再残留上次的图标/文案/按钮节点（含 onclick 闭包引用）；显示态由 `bannerNode()` 完整重建。验证：单测新例三段行为闭环（显示 3 节点 → 隐藏 children=0/text='' → 重建 3 节点）+ 探针 P2 运行态同判据实测。
  - **尾项② sync() 移除 aria-selected 观察**（§17 已知风险②）：三件套删除后该属性已无消费者，`observer.observe(header, { childList: true, subtree: true })`（attributes/attributeFilter 整组移除，childList 监听保留，激活态同步语义不变）；全局检索 aria-selected 产品码零残留（仅 D4 说明注释）；运行态探针 P3 属性翻转 + 开关循环零异常、激活态稳定。
  - **尾项③ 三过渡区间（860/600/500）复验**：无代码变更。**口径说明**：860/600/500 是视口宽度 px（D3 验收的过渡区间档位），非毫秒——按 D3 验收记录口径执行。探针 P4 实测：860 → narrow（rail 208px）、600 → drawer（收起）、500 → drawer（480 紧凑未触发），加 1280/480 首尾档对照，全部零横向溢出、零遮挡、零异常；零损失回归（30 开关）同步过。
- **验证**：探针 10/10（尾项①运行态 + 尾项②运行态 + 尾项③过渡 5 项 + 零异常 + 零损失 + 连接）；数据 `_refs/scripts-archive/ssh-d0-spike/d4-result.json`（含可复现 run-d4.mjs）。
- **影响面与回滚**：三项修复互相独立可单独 revert——尾项①只影响状态横幅渲染路径（旧行为无功能损害）、尾项②只影响入口激活态同步的触发面（childList 语义不变）、尾项③无代码变更。

## 2026-09-15（第六批：D3 实机验收）

- **D3 实机验收：功能门槛全过，1 项清理残留（D3-F1）**（[全屏浮层方案](2026-09-14-ssh-fullscreen-overlay-plan.md) 新增 **§18 验收记录**）。**独立重跑用户可达路径**（真 Edge × 真实 GUI × 真实鼠标/键盘事件（走 hit-test）× 本地假 sshd 真协议），不依赖 §17 的实施者探针；驱动归档 `_refs/scripts-archive/ssh-d3-accept/run-d3-accept.mjs`（约 4 分钟可复现，结果 `d3-accept-result.json` + `shots/`）。
  - **7 项通过**：① **四档宽度按视口语义落位**（D3 门槛本尊）——1280 → rail 232px（全宽）/ **960 → rail 208px（恰好在断点值上落紧凑档**，正是本轮修的"等于断点值错位一档"）/ 720 与 480 → rail `display:none` + 抽屉关闭钮在场；**四档零横向溢出**、顶栏四档稳定；② 三主题 × 1280/480 两档：零溢出 + 顶栏三段 + reserve 消费 `padding-right: 164px`；③ **A0 文案**：真实点「送往对话 → 送出最近 40 行」→ 状态栏「已复制 99 字符——**点左上「对话」退出后粘贴（Ctrl+V）即可**，首行已标注来源主机。」，剪贴板实读首行 `[SSH d3-accept-local · tester@127.0.0.1:2231] 这是终端的最近输出：`；④ 官方 tab 栏**无 SSH**（回退视图已删）；⑤ 会话态下官方 `[data-width-handle]` 两个 `display:block` ⇒ 本线未再隐藏它；⑥ 回退视图面零残留（`.dsh-ssh-view=0` / `.dsh-ssh-bar=0`）；⑦ 真实连接链路（A0 前置）。
  - **唯一未达标（D3-F1，零行为影响）**：`client.js:71` 仍注入 `div[data-phase]:has(iframe[title="SSH"]) [data-width-handle]{display:none!important}`（+ L64–70 注释）。**死代码论证**：规则前提是"SSH iframe 挂在 `div[data-phase]` 内"＝回退视图的 DOM 形态；§17.2 已把 view 注册与 `SshView` 整体删除（全仓零命中），浮层形态下 iframe 在 `body > .dsh-ssh-host > .dsh-ssh-overlay` 内 ⇒ `:has()` **永不命中**；实测反证 = 官方手柄 `display:block`。与 §8 C 组「`grep` 应无命中」的判据冲突（§17.2 把它列为"保留"）⇒ 属**判据与实施的口径分歧**。修法：删 L64–71 + 补一条"注入样式不含 width-handle"的断言；**无需为它单独重启 host**（不参与运行时行为，下次重启自然生效）。
  - **判定：完全达标** —— 唯一的未达标项 D3-F1 已于同日按用户定向「现在就删」闭环（见下条）。
  - **本轮未覆盖**：三过渡区间（860/600/500，§17 探针覆盖过）；`sync()` 的 MutationObserver 仍观察 `aria-selected`（§17.6 已记为无害冗余）；`renderBanner` 隐藏时未清空内容（§16.4-3）。
  - **D3-F1 闭环（用户定向「现在就删」）**：删掉 `client.js` 那条死规则与旧注释（新注释只说明「为何删除」，**不含 `width-handle` 字面量** ⇒ 全局 grep 零命中）；两条把它锁成「保留」的旧断言同步改写 —— D3 清理断言 → 「死规则零残留」、2026-09-12 那条 → 「官方列宽手柄不再被本线触碰」；另新增一条回归断言（注入样式表零 `width-handle` + **相邻规则链完整性**四条：合体胶囊 / 浮层 / `is-closed` 隐藏策略 / launcher —— 删的是拼接链中间一环，拼错会静默丢掉后续样式）。单测 80 → **81 例**、`verify-all ssh` **12/12**。**无需为它重启 host**（不参与运行时行为，下次重启自然生效）⇒ **D3 完全达标**。
  - **验收期间的一次自纠**：首轮 P1/三主题判据误用 `b.text`（不存在的属性）读段身份 ⇒ 误报 FAIL；段身份实测走 `btn.dataset.seg`（产品侧 §17 保留完好）。同 §16 的 `innerText` 教训一类：**探针也要自证**。

## 2026-09-15（第二批，D3）

- **D3 清理与回归一次完成：探针 11/11、单测 80/80、verify-all 12/12 全绿**（[全屏浮层方案](2026-09-14-ssh-fullscreen-overlay-plan.md) 新增 §17 实施记录）。对照 §16.4 四张核对清单：
  - **D-3 判空修复 × 6**：`byId(state.selection/activeTab)` 在主机被删后返回 undefined，所有 `conn === null` 判空失效——renderIdentity（原始发现）/emptyStateNodes/renderStatusbar（探针 P4 实测逮到的第三处）/renderBanner/renderBody/banner 编辑闭包统一 `?? null` 归一化；单测新增「删选中主机不抛错且归空态」回归 + 探针 P4 行为闭环。
  - **删 conversation.view 与 tab 委托三件套**（client.js 净 -6.6KB）：view 注册块、SshView 组件、ownTab/hideOwnTab/restoreTabs/viewIsSsh/selectSsh、selectDefaultView/onDialogClick/bind/unbindDialogButton/dismissing、sync() 内相关调用、文件头注释重写；保留 dismissCanvasOverlay（互斥仍用）与 :has() 手柄隐藏规则。注册面三项 → 两项。全局搜索零残留。
  - **A0 文案**：「切到「对话」粘贴」→「点左上「对话」退出后粘贴」，全局旧文案零命中。
  - **响应式四档重校准**：`@container`（中栏宽）→ `@media`（视口语义）且断点改含端点的 960/720/480——原 959/719/479 在典型宽度恰好等于断点值时错位一档（首轮探针实测暴露：960 落全宽档、720 落窄档）；`.workbench` container-type 一并移除。四档 + 三过渡区间实测落位正确、零溢出零遮挡。
- **测试基建同步**：client.test.js 三条 D1 回退期断言改写为 D3 清理断言（doesNotMatch 零残留 + 注册面数量 2/4）、宽度手柄保留断言保留；探针 widthProbe 判据修正（iframe 上下文直查本档 document，不套宿主选择器）。
- **D3 收工看板**：[design/preview/2026-09-15-ssh-d3-review-board.html](preview/2026-09-15-ssh-d3-review-board.html)（Müller-Brockmann：任务台账 / D-3 同病排查表 / 删除清单 / 四档实测 / 回归总表 / 风险回滚 / 交接）。
- **可选项顺延**：renderBanner 隐藏时清空横幅内容（无害项，D4 顺手）。

## 2026-09-15（第一批，D2）

- **D2 页面顶栏实施：探针六项全过**（[全屏浮层方案](2026-09-14-ssh-fullscreen-overlay-plan.md) 新增 §15 实施记录）。**client.js**：删 D1 临时退出条；新增顶栏消息协议 `onOverlayMessage`——`ssh:close`（关浮层 + 焦点归还最后触发者）/ `ssh:view view:'canvas'`（关自己 + 委托点击 canvas 胶囊「会话布」段，canvas 不在场静默收手）；安全：消息必须来自浮层 iframe 本体（`source === frame.contentWindow`）且带 `overlayToken`（随机、随 chrome 消息下发、宿主严格校验）；`openOverlayFrom(el)` 记录归焦目标（入口/launcher/画布广播三触发点）；卸载解绑。**app.js**：chrome 消息扩展（token 存 overlayState、reserve 写 `--ssh-chrome-reserve`）；`isOverlayMode()` + `buildTopbar`——浮层模式下自绘「对话｜会话布｜SSH」三段胶囊（SSH 段 active + aria-current），**回退视图不渲染顶栏**。**styles.css**：.topbar 用 --ssh-* 令牌（三主题自动跟随）+ 右内边距消费窗控让位；#ssh-root 改纵向 flex（顶栏 40px 固定 + 工作区 flex:1）。
- **实测**（真浏览器 × 真 client.js × 真 app.js 顶栏）：①顶栏渲染（三按钮、SSH aria-current="page"）；②「对话」退出消息闭环（关闭 + 记忆归 0 + launcher 重开）；③「会话布」无 canvas 时静默收手零异常；④宿主文档无顶栏；⑤30 开关零损失回归（session 同实例、零 resize 帧）；⑥静态回归 client 21/21 + 其余 34 例 + verify-all ssh 12/12。数据：`_refs/scripts-archive/ssh-d0-spike/d2-result.json`。
- **过程记录**：探针桩 slots.inject 由纯 push 改为 cordis 同名替换语义（dispose+重 apply 后旧代闭包失效问题）；桩补属性选择器与节点 click()；两处单测场景流程修正。均属测试基建，非产品缺陷。
- **偏差**：A0 文案（2.9）顺延 D3——与响应式重校准、四档宽度验收同批执行更连贯。
- **D2 收工看板**：[design/preview/2026-09-15-ssh-d2-review-board.html](preview/2026-09-15-ssh-d2-review-board.html)（Müller-Brockmann：任务台账 / 实测记录 / 异常处置 / 风险回滚 / 复盘与 D3 建议）。

## 2026-09-15（第三批：验收发现项修复 + D2 语义边界收口）

- **D-1 / D-2 修复 + hero 态「会话布」诚实降级**（用户定向：两条一起修 / hero 态不渲染该段）。
  - **D-1「保存并连接」从不连接**（`app.js`）：意图标记改走**闭包变量**（`let saveAndConnect` → `submit` 里 `const alsoConnect = saveAndConnect` → `if (alsoConnect === true) void connectFlow(connection)`）。原写法把标记挂在按钮 run 的 `event` 上，那颗 `event` 解析到全局 `window.event`（click 事件），而 `dispatchEvent(new Event('submit'))` 让 submit 处理器拿到的是**新事件对象** ⇒ 标记永远读不到。
  - **D-2 状态栏 / 横幅不追平**（`session.js`）：`handleControl` 现在把**每一帧带 `state` 的宿主帧**（`ready` 与 `status`）规范化成 `{ type: 'status', state, … }` **统一前置转发一次**给 `onFrame`，各分支只负责文案。此前只有 `waiting-fingerprint` 那一支调过 `onFrame`，`ready` / `status:connected` 只写状态栏文本 ⇒ app 侧 `state.live` / `state.frameState` 停在 `idle` / `waiting-fingerprint`，随后任何 `renderAll()` 都把「已连接」覆盖回「未连接」、把指纹横幅留在屏幕上。
  - **hero 态「会话布」死按钮**（`client.js` + `app.js`）：宿主在 chrome 消息里新增 `canvasAvailable`（判据 = 宿主文档里 `.dsh-canvas-switch` 是否存在，即 canvas 胶囊在不在场），并且**每次打开浮层都重发**（浮层打开期间用户无法切会话 ⇒ 打开时刻的取值就是整个可见期的取值）；浮层侧 `applyChrome()` 消费该字段，值变化时**幂等重建**顶栏（`buildTopbar` 先移除旧顶栏），hero 态只渲染「对话｜SSH」两段。默认（未收到字段）仍是三段 —— **不擅自替别人减入口**；查询异常时保守为 `true`。`btn.dataset.seg` 让段身份可断言。
  - **测试 72 → 79 例**：`session.test.js` +2（`ready` 帧必须喂 `onFrame`；`status:connected` 帧同样；并把 waiting-fingerprint 那条补上"只转发一次"的断言）；`client.test.js` +3（chrome 消息下发 `canvasAvailable=false`（桩里无胶囊）/ `true`（塞入胶囊节点）/ 每次打开浮层都重发）；`app.test.js` +2（顶栏段数随 `canvasAvailable` 双向变化且重建不叠加、D-1 形态护栏：源码里不得再出现把意图挂到事件对象上的写法）。桩侧扩展：iframe 的 `postMessage` 记录完整 chrome 消息序列、节点 `id` setter 自动登记进 `getElementById` 索引。
  - **静态回归 `verify-all ssh` 12/12**（单测 79 例）。
  - **实机复验（重启 host 后）全绿**：本轮改动落在 `app.js` / `session.js` / `client.js`，而 `index.js` 的 `cachedAsset` 是**进程内一次性缓存** ⇒ 必须**重启 `dsh web`** 才生效（浏览器强刷不够）；按纪律未擅自重启正在服务用户界面的 host，由用户重启桌面壳（新 host 15:06:23 起）后重跑验收 → **`D2_ACCEPT_DONE allPassed=true`（24 项门槛全 PASS、0 FAIL）**。修复的直接证据：**A3** hero 态顶栏两段 `segs: ["dialog","ssh"]`；**A3b** 会话态三段回归（降级可逆）；**A6a** hero 态不渲染「会话布」且零异常；**A9b** 键盘序列随段数同步（`对话→SSH`）；**P16a** 点「保存并连接」后凭据框被拉起（`sheetTitle: "连接密码 · d2-accept-local"`；修复前是"主机落库但零 TCP、无凭据框"）；**P16b** 真协议全链路 + `tcpDelta=1`；**P16c** 状态栏「已连接」且横幅 `hidden:true / display:none`（修复前是「未连接」+ 常驻横幅）；**B2** 关闭期间零 resize 帧、单 shell、真实键盘输入送达远端。
  - **一条探针判据教训（方法论）**：判"横幅还在不在"**不能读 `innerText`** —— 按规范，元素"不被渲染"时 `innerText` 会退回 `textContent`，于是**已隐藏的横幅会被误判成残留**（本轮 P16c 因此假阴性一次）。正确判据是 `hidden` 属性 + `getComputedStyle().display === 'none'`。与 D1「探针可达 ≠ 用户可达」同属"判据本身也会骗人"这一类。
  - **附带观察（未修）**：① `renderBanner()` 只设 `banner.hidden = true`、不清内容 ⇒ DOM 里仍留着上次的按钮节点（视觉与交互均已不可达，无害）；② **D-3（新发现，真异常）**：验收收尾清理（REST 删除主机）时捕获 `TypeError: Cannot read properties of undefined (reading 'group')` @ `renderIdentity`（`renderAll` 调用链）—— 根因是 `app.js:909` 的 `const conn = state.selection !== null ? byId(state.selection) : null`：主机被删除后 `state.selection` 仍指向旧 id，`byId()` 返回 **undefined**（不是 null），于是 `app.js:912` 的 `conn === null || !conn.group` 短路失效。用户的触发路径相同（在 UI 里删除当前选中的主机）。一行修法：`byId(state.selection) ?? null`。**处置（用户定向 2026-09-15）：并入 D3 与「删 conversation.view + tab 委托三件套 / A0 文案 / 响应式重校准」同批改，只重启一次 host、一次性复验。**

## 2026-09-15（第二批）

- **D2 实机验收：真实 GUI 20 项门槛全过，收获 2 项非 D2 的移交发现**（[全屏浮层方案](2026-09-14-ssh-fullscreen-overlay-plan.md) 新增 **§16 实机验收记录**）。与 §15 探针的本质区别：本轮跑的是**真实 DSH GUI**（真宿主 + `link:` 安装的真插件 + 真会话 + 真桌面壳注入），每条门槛都从**用户能点的元素**出发、用 `Input.dispatchMouseEvent`（走 hit-test）与真实键盘/文本输入触发，并接一台本地假 sshd（`ssh2.Server`，真协议 + 密码 + TOFU + PTY/`window-change`）作真远端端点——D1「单向门」教训的直接落地。
  - **通过的关键项**：A1/A1b 两条入口真实点击开浮层；A2 五点 hit-test 全落浮层（官方 UI 不可达）；A3 顶栏三按钮 + SSH `aria-current="page"` + **宿主文档零顶栏**；A4 两态下工具区控件都不在顶栏；A5 退出 + **焦点归还 launcher**；A6b/A6c **双向互斥**（SSH↔画布，含画布外部视图槽按钮）；A7a 普通浏览器 `padding-right` 退回 14px 基数；A9a `Esc` 不关闭；A9b **键盘 Shift+Tab 反向可达「对话」且 focus-visible 为 solid 2px**；B1a/B1b 记忆语义；**B2 真协议端点零损失**（关闭期间远端零 resize 帧、重开 iframe 未重载、30 次开关零帧且 SSH 侧 `shell` 恒为 1、真实键盘输入送达远端）；C1 三主题真实切换；**C2 三主题顶栏一致且 `padding-right = 14 + 150`（壳窗控 reserve）**；C3 壳内入口与窗控同排不叠压。静态回归 `verify-all ssh` **12/12**。
  - **发现项 D-1（阻断级，U1 遗留）**：「保存并连接」**从不发起连接**——主机落库但远端零 TCP 连接、无凭据框。根因 `app.js:554` 的 `event.saveAndConnect` 写在全局 `window.event` 上，而 `dispatchEvent(new Event('submit'))` 让处理器拿到的是新事件对象 ⇒ `app.js:543` 的 `connectFlow` 永不被调用。
  - **发现项 D-2（体验级，U0 遗留）**：指纹确认后**状态栏与横幅不追平**（host 已 `connected`、xterm 已挂载，界面仍「未连接」+「核对指纹」横幅，≥6s 不自恢复，刷新后正常）。根因 `session.js:106-108` 的 `ready` 帧只走 `onStatus` 文案、**从不喂给 `onFrame`** ⇒ app 侧 `state.live`/`state.frameState` 停在旧值，被后续 `renderAll()` 覆盖回去。
  - **待议一条（D2 语义边界，未改代码）**：hero 态没有会话头 ⇒ canvas 无胶囊 ⇒ 顶栏「会话布」必然失效（静默收手、零异常）。候选：hero 态不渲染该段 / canvas 线补 `shell.overlay` launcher / 记为已知边界，**待定向**。
  - **通道与纪律**：`dsh web` 的激活 token 每进程随机只存内存 ⇒ 验收用 credentials 的持久签名 secret **离线签发本机合法会话 cookie**（不打印、不落盘、仅内存）；三主题由注入 desktop 真产物 `theme-init.js` 复刻；**未改任何产品代码**，用户数据（连接库 / known_hosts）由脚本 `finally` 恢复为空库原状。驱动与证据归档 `_refs/scripts-archive/ssh-d2-accept/`（`node run-accept.mjs` 可复现 + `accept-result.json` + `shots/*.png`）。

## 2026-09-14（第三批）

- **D1 浮层骨架实施：四项门槛实测全过**（[全屏浮层方案](2026-09-14-ssh-fullscreen-overlay-plan.md) 新增 §13 实施记录）。client.js 新增浮层宿主（body 级 `.dsh-ssh-host` → `.dsh-ssh-overlay`（fixed/inset:0/z:100/**is-closed=visibility+pointer-events**，D0 §12 维持的偏离）→ 常驻 iframe）+ **懒加载**（首开才赋 src + 加载态占位 + 3s 兑底）+ **开关记忆**（`dsh-ssh:overlay-open` sessionStorage，§5.9：apply 末尾记忆为真自动恢复、open/close 各写一次、卸载不清除）+ chrome-reserve 量法下发（canvas syncChrome 同款）+ 主题桥迁移到浮层 iframe（load 补发 + 去重）；入口按钮与画布广播改线为「关画布 → 开浮层」；卸载整树回收宿主。app.js 新增 lastTab sessionStorage 记忆（openHost 写 / 关标签清 / **mount 尾部重挂 attach**——「刷新恢复」门槛的页面半边）。**conversation.view 与 tab 委托三件套保留作回退**（D3 才删）。
- **实测**（真浏览器 × 真实 client.js × 真实 host 栈）：①真实 openOverlay 路径（记忆=1 → dispose+重 apply）浮层现于 DOM、iframe src 真实赋 `/ssh/`；②浮层 iframe 里真实 UI 走完密码 + TOFU + 已连接；③30 次开关 session 同实例、零 resize 帧、内容保留；④Page.reload 后记忆 1 → 浮层自动重开 → lastTab 重挂 → 状态栏「已连接」。数据：`_refs/scripts-archive/ssh-d0-spike/d1-result.json`。
- **测试**：`test/client.test.js` 重写为浮层契约（**16 例**：宿主/初始态/懒加载/占位/visibility 策略与不得 display:none/记忆双路径/入口 onClick/画布广播/chrome-reserve/主题桥去重/回退保留/幂等回收/手柄/胶囊），verify-all ssh **12/12**。
- **D1 启动看板**：[design/preview/2026-09-14-ssh-d1-kickoff-board.html](preview/2026-09-14-ssh-d1-kickoff-board.html)（Müller-Brockmann 瑞士网格：章程 / D0–D4 排期 / 13 条任务台账 / 风险登记册 / 异常预案 / 收尾复核 / 交接说明）。
- **D1 验收：发现并修复「单向门」（阻断级；用户实机截图确认）**。**判定：D1 首版不通过。** 现象：点一次 SSH 按钮进浮层后**没有任何办法回到会话界面**——浮层 `inset:0` 盖住会话头（入口按钮不可达）、浮层内只有 loading + iframe、**`closeOverlay` 全仓零调用点**、iframe 侧无关闭消息、`Esc` 明确不接管、而 `sessionStorage` 记忆=1 使 `apply` 末尾自动重开 ⇒ **刷新也被困**，唯一出路是关标签页 / 应用。
  - **为什么上面那条"四项门槛全过"没拦住**：① **探针的可达性 ≠ 用户的可达性**——探针页能**直接操作 DOM / 调内部函数**关闭浮层，所以"关闭"在探针里可达，而产品代码里没有任何用户可达路径；② **门槛与分期自相矛盾**——§7 的 D1 门槛写「点「对话」退出」，但那颗「对话」按钮本身是 **D2 的交付物**（浮层内自绘顶栏）；③ **单测没兜住**——那几条断言测的是**源码文本**（CSS 字符串、`onClick` 字面量），没有一条测"能不能真的退出来"。
  - **修复**（最小，不抢 D2 的活）：① `client.js` 加一条 38px **临时退出条** `.dsh-ssh-bar`（`.dsh-ssh-exit` 按钮「← 对话」→ `closeOverlay()`），浮层改 `display:flex;flex-direction:column`、iframe 由 `height:100%` 改 `flex:1 1 auto;min-height:0` 让出这条高度（**D2 顶栏落地时整条删除**，代码内已注明）；② `test/client.test.js` DOM 桩补 `.dsh-ssh-bar` / `.dsh-ssh-exit` 子树，并**新增一条行为闭环断言**（记忆=1 → apply 自动恢复浮层 → 点退出控件 → 回 `is-closed` 且记忆写回 `0`）；③ `verify-all ssh` **12/12**（client 16 → **17 例**）。
  - **方法论教训（写给后续所有门槛验收）**：**探针能调到内部函数，不等于用户能触达该路径。** 门槛写"点 X 应 Y"时，验收必须**从用户可达的入口出发**（找到真实可点的元素并触发它），而不是在探针里直接操作状态。§13 表格「点「对话」退出」一行的判定口径已改记为「**函数级可达**」，与「用户级可达」区分；§13.1 为完整验收记录。
- **D1.1 无会话头时的常驻入口（`shell.overlay`）：已实施**（[方案](2026-09-14-ssh-fullscreen-overlay-plan.md) §14 设计 + §14.9 实施记录）。触发：用户首屏观察「新对话是不是也应该加个 SSH 入口」—— 正是 §1/§3 诊断的 **D2「无会话即无入口」**（hero 态没有会话头 ⇒ 入口不存在 ⇒ 必须先发一条消息才能用 SSH）。
  - **用户首选的 `sidebar.panellist` 被技术否决**：那一行的点击是官方写死的 `selectPanel(id)`（`ui-sidebar` 的 `PanelRow`），而 `ctx.layout.selectPanel` 对未注册的 main key **直接抛错** ⇒ 图标画得出来但**点了没反应**。要用它必须同时注册 `main` 的 key `ssh`，那等于**转路线乙**（放弃全屏 + 吃 F4 + 面板切换导致 iframe 重建），用户已明确不转。
  - **改用 `shell.overlay`**：现场查询契约 —— `list` / `root` / `replaceRisk: none` / `ownerProps: []` / standardProps 含 `useSessions` / 当前仅 `usage-stats-overlay` 一个占用者；官方 catalog 原文 "The layer itself is **click-through** — entries opt back into pointer events"。设计要点：判据走 `useSessions(state => state.current)`（**有会话即不渲染** ⇒ 与会话头胶囊绝不双入口，验收用 `querySelectorAll('.dsh-ssh-launcher').length === 0` 锁死）；位置在**右上角、窗控左侧**（与有会话时胶囊的位置保持连续，复用 D0 实测的真实壳 reserve=150px，写成宿主 CSS 变量 `--dsh-ssh-chrome-reserve`）；点击与胶囊**同一条路径**（`dismissCanvasOverlay()` → `openOverlay()`，零新逻辑）；注册用自有 id `ssh-launcher` + `order: 40`。
  - **官方明示的坑已入风险表（高）**：`overlayLayer > *` 会拿到 `pointer-events: auto` ⇒ 容器若铺满就**挡住整个应用**。方案：容器 `inset:0` + `pointer-events:none`，只有按钮自己 opt-in；验收第 5 条用 `elementFromPoint` 实测"hero 态下输入框仍可点"。
  - 附**四条入口的覆盖关系**（有会话=会话头胶囊 / hero=`shell.overlay` / 画布内=外部视图槽 / 浮层内=临时退出条）、改动清单（`client.js` + `test/client.test.js` +3 例）与 7 条验收门槛。
  - **实施完成（同日）**：回归 `verify-all ssh` **12/12**，client 16 → **20 例**（+3 条 D1.1 + 同步两条既有计数断言：注册数 2→3、两次 apply 4→6）。实施中三个**"照抄就会踩"**的点已记入方案 §14.9：① **launcher 不得复用 `.dsh-ssh-switch` 类名** —— `ownHeader()` 拿它当会话头锚点，共用会让回退期的 tab 三件套（`hideOwnTab`/`viewIsSsh`/`selectSsh`）集体失灵，改用独立类 `.dsh-ssh-launcher`、视觉并列写一份；② 容器 `pointer-events:none` **必须带 `!important`** —— 官方 `overlayLayer>*{pointer-events:auto}` 与本条特异性相同、注入顺序不定，容器一旦被设回 `auto` 就**挡住整个应用**；③ **`syncChrome()` 必须在 `apply` 期间主动调一次** —— 原先只挂 iframe 的 `load` 监听，而 iframe 是懒加载的 ⇒ reserve 变量永不设置 ⇒ 桌面壳里 launcher 退回 `0px` 被窗控压住。另：组件按 React 规则拆两层（外层判 `useSessions` 有无、内层无条件调 hook；缺 prop 则整层不渲染，不回退成 DOM 探测）。
  - **实机验证发现判据写错（当日修正）**：首版判据 `state.current === undefined`，结果**真实首屏上入口不出现**。根因 —— 进入首屏时工作区**已建好一个 blank session**，`state.current` 有值；而"会话头不渲染"看的是 `main.conversation` 绑定的 sessionId（`undefined`），**两者语义不同**。**诊断路径**：先查 `shell.overlay` 的 occupants，见 `ssh-launcher` **已注册且 active** ⇒ 一步排除注册问题、锁定渲染判据（比在代码里猜快得多）。修正为「`current === undefined` **或** `byId[current].blank === true`」，用官方字段 `SessionSummary.blank`；并把不确定情形统一为**显示**（状态缺失 / 摘要未就绪 ⇒ true）—— **没有入口比短暂双入口更糟**。测试补三条边界（非空白不渲染 / 空白渲染 / 未就绪与缺失保守显示）。回归仍 **12/12**（client 20 例）。
  - **位置**：`conversation.hero.agentPreset`（模式选择器）与 `conversation.hero.workspace` 都是 **`single` 槽 + `registration: []` + `replaceRisk: shadows-shipped-ui` + 已被官方占用** ⇒ 注册会**顶掉控件本身**，不能用；要"贴着模式选择器"只能用 `shell.overlay` + 测量定位（脆弱，未采纳）。落点仍是**右上角、窗控左侧**。
  - **视觉对齐（实机反馈后优化，同日）**：用户评"不好看"，两处都是首版问题 —— ① **太重**：带边框 + 实底 + 模糊的 `999px` 胶囊，混在一排线性图标与圆形头像里读作异物 ⇒ 改为**与窗控同一视觉语言**（无底无框、hover 才显淡底、同款 `7px` 小圆角）；② **没对齐**：首版写死 `top:14px`，而窗控组是 `top:5px`，低了 9px ⇒ **不再写死**，由 `syncChrome()` 量窗控组的 `top` 与 `height` 写成 `--dsh-ssh-chrome-top` / `--dsh-ssh-chrome-height`（带限界防呆，量不到退回 `5` / `28`），卸载时三个变量一并清理。回归仍 **12/12**（client 20 例）。

## 2026-09-14（第二批）

- **全屏浮层方案 D0 SPIKE 实测：五项全过，D1 获准开工**（[方案](2026-09-14-ssh-fullscreen-overlay-plan.md) 新增 §12 实测记录）。实测通道：**headless Edge（原生 CDP）+ 探针宿主页（复刻路线丁浮层结构）+ 真实 `index.js`/`SshStore`/`SshRuntime`/真实 `app.js`/`session.js`/`xterm` 原样 import（零改动）+ `ssh2.Server` 假远端**（真协议、密码认证、TOFU 指纹确认走真实 UI）；判据端点是假 sshd 的 `window-change` 事件＝resize 帧到达「真实 PTY 语义端点」的权威记录：
  - **①visibility:hidden 关闭态**：关闭瞬间 0 帧；隐藏期改视口 → 1 帧且是新视口的正确值（163×45→119×38）；恢复 → 1 帧回正确值；重开 0 帧（xterm 去重生效）——**全程零退化帧**。
  - **②30 次开关零损失**：iframe 从未重载、session 同一实例、回放环全保留（含关闭期间 4 次推送）、开关后输入回显正常、周期内零 resize 帧、单 shell 连接、状态栏恒「已连接」。
  - **③窗控 reserve**：普通浏览器 0；注入真 `theme-init.js` 后窗控实测（left:1311/w:97）→ canvas 同款量法 reserve=111px。
  - **④双浮层互斥**：画布浮层开时头部按钮 hit-test 不可达 ⇒「天然互斥」成立；委托关画布→开 SSH 通；强制双开时 SSH（DOM 后者）在上。
  - **⑤IS_TOP 守卫**：desktop 线真产物 `theme-init.js` 注入 SSH iframe → 无标题栏/无主题球（closeDialog/aurora 按既有设计存在），`data-miasaki-theme` 照常下发。
  - **设计前提修正（§12.3）**：**display:none 的 2×2 灾难在本版 Chromium 未复现**——display:none 的 iframe 渲染管线暂停，RO/rAF 不跑，误 fit 无从发生。但不回退到 display:none：①依赖浏览器实现细节不可依赖；②关闭期间不绘制新输出；③visibility 是规范行为。丁方案不变；验收矩阵 B-3 修正为「零**退化** resize 帧」（隐藏期改视口发出正确尺寸帧是期望行为）。
- **修复：TOFU 首连死锁（探针逮到的阻断级缺陷）**。`buildSkeleton` 把 `#status-text` 嵌在 `#status-pill` 内部，而 `renderStatusbar()` 每次 `pill.replaceChildren(dot, span)` 把它从 DOM 抹掉 → 每个 WS 状态帧进 `handleSessionStatus` 就在 `$('#status-text').textContent` 上抛 TypeError → `waiting-fingerprint` 的 `onFrame` 永不执行 → **指纹确认 banner 永不出现，首连永远卡死**。修复：`#status-text` 移为 statusbar 直接子节点（pill 只留 dot），`renderStatusbar` 改为只换 dot 类名与文本、不重建节点。此缺陷意味看现工作树的「M1 真实连接」从未真正跑通首连链路（此前实机验收停在 U1 两个更早的阻断 bug 上，未覆盖到 TOFU 环节）。探针顺带确认：预置 connections.json 的 id 必须 UUID 形状（官方 connect 路由正则 `[0-9a-f-]+`，非 UUID id 在 connect 时 404「接口不存在」）。
- **测试**：`test/app.test.js` 新增骨架幂等回归（vm 桩驱动 buildSkeleton + 两次 renderStatusbar，断言 `#status-text` 存活且状态更新）60 → **63 例**全绿；`verify-all ssh` **12/12**。
- **探针归档**：四件套 + 结果数据在 `_refs/scripts-archive/ssh-d0-spike/`（`node run-d0.mjs` 可复现，约 90 秒）。

## 2026-09-14

- **全屏浮层规划（路线丁，已定向）**（[2026-09-14-ssh-fullscreen-overlay-plan.md](2026-09-14-ssh-fullscreen-overlay-plan.md)，v1.0 待评审，**未实施业务代码**）。用户在同一议题下逐轮定向：「不能通过顶栏的这个按钮切换吗」→「那我现在的会话布实现形式是什么样的」→ **「全屏，走丁方案」**。本轮先讲清会话布的真实实现，再出丁方案设计：
  - **澄清一条关键误解（用户问「顶栏胶囊不能注册过去吗」）**：**不能注册**——官方胶囊是注册在 `conversation.session.header.actions` 的 React 组件，绑死在会话头 DOM 上；**只能重画**。会话布正是这么做的：它 `inset:0` 的浮层**把官方顶栏一起盖住**，所以画布页面在自己的 topbar 里**重画**了一组 `.view-switch`（用户看到的「对话｜会话布｜SSH」里，前两个是画布画的，第三个是本线经**外部视图槽**塞进去的）。
  - **会话布实现形式（三层）**：① 浮层本体 = `document.body` 上的 `.dsh-canvas-overlay`（`fixed`/`inset:0`/`z-index:100`）+ 常驻 iframe `/canvas/`（只切显隐，**从不卸载**）；② 入口 = 会话头 actions 槽的 `ViewSwitch` 组件；③ 页面内顶栏 = 画布页面自绘。
  - **定丁（照会话布同构）的四条理由**：**顶栏胶囊保留**（页面内重画）／**切会话不消失**（与会话 DOM 无关，无需 observer 纠偏）／**切走切回终端零损失**（iframe 常驻，连 256KiB 回放都不需要）／**「委托点击官方 tab」整套 hack 全删**，且只依赖唯一稳定槽 `conversation.session.header.actions`，**不碰 `main` slot、不碰左栏**。附带：「第二行 tab 不存在」从"要修的问题"变成"自然结果"。
  - **头号技术风险（本方案唯一可能写坏远端 PTY 的点）**：canvas 关闭浮层用 `[hidden]{display:none}`，对画布无碍（它的困扰只是 `scrollTop` 被夹回 0，源码里有注释），**但对 xterm 是灾难**——iframe 尺寸塌成 0 ⇒ `session.js` 的 `ResizeObserver` 触发 fit ⇒ 按 U0 的 resize 限界算出 **2×2** 并**真的写进远端 PTY**，正在跑的 `vim`/`top` 画面直接乱掉。**必须偏离 canvas**：关闭态改用 `visibility:hidden; pointer-events:none`（元素仍在布局中，尺寸恒等于视口，且 `visibility` 变化**不触发** `ResizeObserver`），并在 `session.js` 的 fit 路径加可见性门控，打开后补一次去重 fit——三层保险，D0 首项实测。
  - 其余四项关键问题与对策：**桌面壳窗控 reserve**（抄 canvas 的 `syncChrome()` → `--ssh-chrome-reserve`；并复验 desktop 线 2026-09-12 的 `IS_TOP` 守卫在本线 iframe 内生效）／**双浮层互斥**（任一浮层打开都盖住会话头 ⇒ 另一颗入口点不到，**天然互斥**，只需正向关对方）／**响应式重校准**（容器宽度语义从中栏变为视口，959/719/479 断点需重跑）／**焦点与退出路径**（用户当场定向：**`Esc` 不关闭浮层**——终端聚焦时必须留给远端程序，故不做"仅顶栏聚焦时拦截"的折中）。
  - **由「`Esc` 不接管」推出一条硬约束**：官方顶栏被浮层盖住 + `Esc` 不接管 ⇒ **退出浮层的唯一路径是浮层顶栏的「对话」按钮**，它必须始终可见、键盘可达、focus-visible 清晰，且不因任何窄宽度断点被折进菜单（已单列进验收矩阵 A 组）。
  - **用户当场定的一项界面约束**：浮层顶栏**只放三个切换按钮，不堆工具**（「别把顶栏堆长了」）——查找 / 字号 / 专注 / 送往对话全部留在**终端工具区原位**。
  - **用户第二轮定向（同日）**：① **SSH 与会话布不同屏**（两浮层互斥，接受全屏方案的固有代价）；② **浮层开关状态要记忆**，选 **`sessionStorage`**（刷新恢复浮层 / 关标签页即忘 / 多标签页互不干扰）——排除 `localStorage` 的理由：它会让**每次打开 DSH 都自动弹进全屏 SSH**（含新开标签页），想先跟 Agent 说话时反成打扰。
  - **规划外补查的一条事实（风险表据此划掉一项）**：扫遍官方所有 client 包的文档/窗口级 `keydown`，**DSH 没有全局快捷键监听**——仅有三处（`ui-conversation:15429` 上下文用量气泡 / `ui-chat:3424` 回合用量气泡 / `ui-attachment:481` 图片灯箱）全是"气泡打开时才注册"的 Escape 关闭。加上 iframe 天然隔离键盘事件，**浮层不会抢终端的键**。
  - **新增一条与 Agent 化规划的交叉待议项**（规划 §9 风险表 + §11-5）：A1 落地后 Agent 会经 `ssh_exec` 自行在远端执行命令，而浮层**默认关闭** ⇒ 用户看不见，与该规划核心原则 **J5「可见性即安全」** 有张力。倾向"对话流工具卡（`tool.call.toolview`，该规划 §16 已核实可用）+ 浮层内活动面板"为主，**不建议**"Agent 一动就自动弹浮层"；**不影响本方案实施**，但应在 A1 开工前定。
  - **改动面**：`client.js`（新增浮层宿主与 open/close，**删** `conversation.view` 注册 + `ownTab`/`hideOwnTab`/`restoreTabs`/`viewIsSsh`/`selectSsh`/`selectDefaultView`/`onDialogClick`/`dismissing`/列宽手柄规则；**留**合体胶囊 CSS 与外部视图槽消费）、`app.js`（新增顶栏三按钮 + chrome reserve + A0 文案）、`styles.css`、`session.js`（fit 门控）、`test/`；**`index.js` 与 host 侧零改动**。
  - **分期 D0–D4**（D0 五项 SPIKE → D1 浮层骨架（先留 `conversation.view` 作回退）→ D2 页面顶栏 → D3 清理与回归 → D4 可选 Esc/记忆/动效），另附 A/B/C 三组验收矩阵与风险表。
  - 文档同步：`README.md` 文档表新增本方案条目。

- **独立模块化规划提案**（[2026-09-14-ssh-global-panel-plan.md](2026-09-14-ssh-global-panel-plan.md)，v0.1 待评审，**未实施业务代码**）。用户诉求：「我希望的是像会话布那样的独立页面，不是切换会话 SSH 就没了，当成一个独立的功能模块」。本轮先做平台取证再出方案：
  - **诊断：不是 bug，是作用域错配。** 主机连接库（`~/.dsh/ssh/`）、SSH 连接 host 侧全局保活、多主机标签——**三者本就是全局的**，却注册进了 session scope 的 `conversation.view`。三条根因：D1 作用域错配 / D2 **空会话（hero）态下该槽整个不渲染 ⇒ 没有会话就进不去 SSH** / D3 视图选择与记忆均 per-session ⇒ 必须「记住 SSH 在哪个会话里」。
  - **参照物解剖（会话布为什么切会话不消失）**：`dsh-miasaki-canvas/client.js:94-95` 把浮层 `document.body.append()`，`position:fixed;z-index:100;inset:0`，**完全在 React / 会话 DOM 之外**；iframe `/canvas/` 常驻只切 `hidden` ⇒ 状态零损失。**关键推论：用户说的「像会话布那样」技术实质是「会话之外的常驻宿主」，不必连全屏浮层一起搬**（canvas 为此付过幂等守卫/重渲染看门狗/叠压修复的补丁史）。
  - **官方正解已在本机具备（0.1.5-rc.1 逐行取证）**：`main` 是 **root scope 的 keyed slot**，官方注释原文 "The root-scoped main slot selects the Conversation or a **global panel**… other keys receive **no Session binding**"（`dsh-client-ui-layout/lib/client.js:95-96`、`532-535`）；注册走 `ctx.slots.inject('main', () => ctx.slots.register({name:'main', key:'ssh'}, Panel))`（官方 example 见 `dsh-cordis-client-runner/lib/client.js:3399`）；`keyDomain` 已占用者仅 `conversation`，`replaceRisk: shadows-shipped-ui` ⇒ 用自有 key 是**新增一格**而非替换。
  - **左栏入口**：官方有 `nav[aria-label="全局面板"]`（中文词典原文），位于「新建会话」下方、会话列表上方（`dsh-client-ui-sidebar/lib/client.js:271-282`）；行 = 自绘 glyph + 官方 label，owner props `{size, active}`；契约条目 `occupants: []` ⇒ **SSH 将是 DSH 第一个全局面板占用者**，该区域现在因 `panels.length > 0` 不成立而完全不渲染。
  - **⚠️ 官方硬约束 F4（本轮最重要的负面结论）**：`dsh-client-ui-workspace/lib/client.js:61-64` 的 `openSession()` **强制 `ctx.layout.selectPanel(null)`**（点左栏会话 / 切换工作区 / fork 均经此），故「在 SSH 页面里切会话、画面保持不动」**在官方通道下做不到**——这是「点会话＝看那个会话」的既定语义，第三方无法覆盖。R2 因此拆成两半：**状态零损失能做到（G2 常驻承载），画面不消失做不到**。
  - **方案与建议**：A 现状 view tab ／ **B 全局面板（推荐骨架）** ／ C body 级常驻浮层；推荐 **B 为骨架 + 吸收 C 的唯一优点（宿主常驻）**，即「全局面板 + 常驻承载 + 左栏常驻入口」。R2 给出三条出路：**B1 接受官方语义（推荐）** ／ B2 全屏浮层（与「切会话去看对话」的意图互斥，不建议） ／ **B3 = B1 + 可选钉住小窗**（走官方 `shell.overlay` 槽）。
  - **分期 G0–G4**：G0 六项 SPIKE（**命门是 ② 面板高度契约**——`centerCol` 为 flex column，`height:100%` 有歧义，需实测 `flex:1 1 auto; min-height:0`）→ G1 形态迁移（同时**删掉「委托点击官方 tab」整套绕过逻辑与合成胶囊 CSS**，因为官方终于给了切换 API）→ G2 常驻承载（切走切回零损失）→ G3 全局语义收尾 → G4 可选钉住小窗。
  - **附带收益**：迁移后不再需要「委托点击官方 tab 按钮」这一唯一通道 hack（含幂等守卫、关画布浮层、`dsh-canvas-switch` 合成选择器系列），并顺带修掉 D2 的「无会话进不去 SSH」。
  - **实测通道受限说明**：本会话浏览器工具对 `127.0.0.1` / `localhost` 直接阻断，G0 未实测；建议通道为 `cordis_define` + `cordis_run` 的动态 Cordis 探针（Client 半边在真实 GUI 内跑，探针用完即删），次选本线已有的本地静态 harness 做法。
  - **待决策四项**（拍板后实施）：①R2 走 B1/B2/B3；②会话头入口是否完全撤出；③画布内入口去留；④G2 是否紧随 G1。
  - 文档同步：`README.md` 文档表新增本方案条目。

- **Agent 化规划提案**（[2026-09-14-ssh-agent-driven-plan.md](2026-09-14-ssh-agent-driven-plan.md)，v0.2 待评审，**未实施业务代码**）。用户诉求：「SSH 线希望是 Agent 驱动的，集成 Agent 能力」。本轮先做平台事实核查再出方案，核心结论与依据：
  - **立场：做「Agent 的 SSH 手」，不做「SSH 里的 Agent」。** DSH 已有完整 agent 循环（对话视图 / 审批 UI / 工具卡 / 会话日志 / 压缩 / 子代理），SSH 自造内嵌对话会重复实现全部四件并带来双份会话状态；正确形态是 SSH 当**能力提供方**，页面当**观察窗**。
  - **五条设计判断**：J1 不做第二个 Agent；J2 人的交互式 PTY 与 Agent 的 exec 通道**物理分离**（`client.shell()` vs 同 Client 下 `client.exec()`，避免污染屏幕 / 被人打断 / 冲掉 256KiB 回放环）；J3 凭据永不归 Agent（主机级 `agentAccess: none|readonly|full`，**默认 `none`**）；J4 审批走官方 seam 且**诚实声明命令正则不是安全边界**；J5 可见性即安全（Agent 活动时间线，事件不写 PTY）。
  - **平台事实**（0.1.5-rc.1 安装产物源码 + 随包中文 README）：`ctx.tools.register(defineTool({...}))` 注册即进系统提示词、`restrict` 按 agent 收窄、`guard` 单调拒绝不可翻案、五段执行流水线；`ctx.approval.request({agent,toolName,callId?,reason?,signal?})` 返回 `allowed-once|rejected|cancelled|unavailable`，**三条硬约束**——`allowed-once` 是唯一授权 / 请求需 open turn / **请求不携带工具参数**（命令细节只能进 `reason` 或靠 `callId` 关联工具卡），审计 `approval/asked|decided` 自动落会话日志；`tool.call.toolview` 可让 `ssh_exec` 在对话流有专属卡片；`dsh-web-app/cordis.patch.yml:252` 已挂 `ui-approval`。
  - **否决一条看似对口的路线**：`ctx.terminals` 的 `TerminalBackend` 契约是全 UNIX 进程模型（`pid` / `targetPgid` / `TerminalSignal`），且 `TerminalSpawnRequest` **只有 `{type,name?,cwd?}`、没有主机标识** ⇒ SSH 塞进去三处语义打架，不走该路线（留 S5 对照实验）。
  - **平面归属判据**（引自 `dsh-web-app/cordis.patch.yml:351–484` 原文）：`tools`(:460) / `approval`(:224) / `subagent`(:328) 均在 `dsh-base` = **Host 平面**，故 profile bundle 行的本插件可 inject 并注册进全局层；代价是**每个会话固定多付 schema token** ⇒ 推演出「工具少而正交」+「总开关默认 `off`（不注册即不进 schema）」。
  - **能力四层与分期**：A0 上下文桥（零平台依赖，最便宜）→ A1 工具面（`ssh_hosts` / `ssh_exec` / `ssh_session_read` 三个 + exec 通道 + 输出双上限 + spill 对齐）→ A2 治理闭环（主机授权 / 命令分级 L0–L2 / 审批四分支 / 执行台账 `exec-audit.jsonl` 不记输出）→ B 协作面（活动时间线 + 对话流卡片）→ C 自主面（子代理，独立评审）→ D 接管模式（Agent 驱动人的 PTY，默认关闭）。
  - **8 项 SPIKE**，其中 **S1（bundle 行能否 inject `tools` 且对会话内 agent 可见）** 与 **S4（同 Client 上 `shell()` 与 `exec()` 并存是否稳定）** 为命门：前者决定「Agent 有没有手」，后者决定「手干不干净」。
  - **本文档定位**：本轮只产出方案文件，**不等于批准业务改造**；「切换到 Agent 模式只允许产出方案文件」同 plan §11 既有约定。方案内所有标「⚠ 推断」的结论必须经 SPIKE 验证后才能当事实使用。
  - **同步**：`README.md` 文档表新增本方案条目、里程碑 M3 行指向本方案。

- **方案评审通过 + SPIKE S1–S3 实测（2026-09-14，同日）**。用户拍板四项决策（D1 做「Agent 的 SSH 手」不做「SSH 里的 Agent」/ D2 总开关默认 `off` / D3 确认发生在对话页 / D4 允许对 key/agent 主机隐式建连），方案从「待评审」转为「已定稿」。随即用**动态 Cordis 探针**（Host 半边）在**本进程内**实测三条命门假设，**探针已按纪律删除**（`cordis_undefine`，不留残留工具）：
  - **S1 ✅ 通过**：`ctx.get('tools')` 可达；`harness.defineTool` + `harness.registerTool(ctx, tool)` 注册成功，工具**立即出现在该 agent 的 `Tool.listTools` 与模型 `<functions>` 中**，schema 正确投影 ⇒「注册 → 进提示词 → 对 agent 可见」链路成立。
  - **S2 ✅ 通过**：真实模型调用中 `exec.agent` **被填充**（`agentPresent: true`，`agentId` = 会话 id）、`exec.callId` / `exec.rootCallId` 存在、`exec.signal` / `deferContext` / `concludeTurn` 均为可用成员。
  - **S3 ⚠ 部分通过（负面但重要）**：`ctx.approval` 服务可达、`request()` 是函数、**open-turn 前提满足**（未抛「no turn is open」），但决策结果为 **`unavailable`**——`approval/request` 是 scope-filtered waterfall，**本进程没有应答者接手，官方审批 UI 未出现**。失败关闭方向正确，但对 A2 意味着官方审批 seam 当前用不上。
  - **回退通道已确认**：`ctx.userQuestions.ask({ questions: [{ id, header, question, detail, options }], agent, signal })`——官方提问 seam，**`detail` 能携带完整命令**（正好补上「审批请求不携带参数」的缺口）、UI 在对话页（`ui-user-questions`）、且 `ask_user_question` 工具在该会话正常工作即为可用性佐证。**A2 因此改用 userQuestions**，官方 `approval/asked|decided` 审计对由本线执行台账替代。
  - **仍未实测**：S4（同 Client 上 `shell()` 与 `exec()` 并存）——需要一台真实可连的 SSH 主机，是 A1 开工前的最后一道门槛。
  - 文档同步：方案新增 **§16 SPIKE 实测记录**（复现步骤 / 结果表 / 边界与不可外推之处）；§13 改为「决策记录」（已定四项 + 待定三项）；§7.3 重写为方案 A（userQuestions，推荐）/ 方案 B（approval，留作 seam 修复后升级）；§4 J4、§9 A2、§11 SPIKE 表、§12 验收矩阵 B 组随之更新。

- **A0 上下文桥实施**（[Agent 化规划](2026-09-14-ssh-agent-driven-plan.md) §8.2，四项决策拍板后的首个交付）。定位：把终端现场送进对话，**不触碰 host 侧、不注册任何模型工具**。
  - **通道选定（一个负面结论）**：SSH 页面 ↔ 对话页之间**没有**「插入任意文本」的公开 API——`dsh-client-ui-reference` 的对外注册面只有一个 slash source，服务 `@` 补全的**固定候选领域**（文件 / 文件夹 / 会话）；且 slot 树中**不存在 `input.trigger` 槽**（`Slots.listSubTree` 实测 `available: false`）。因此按规划 §8.2 **路径 1（剪贴板 + 引导）** 落地，§8.2 的路径 2 在文档里标为不可行。
  - **`session.js` 新增 `snapshot(lines = 40)`**：只读缓冲区快照。语义经测试修正过一次——**先跳过末尾连续空行，再从最后一个非空行往前取 N 行**；初版是「取最后 N 行再裁掉尾部空行」，当末尾空白行数 ≥ N 时整段落空（`snapshot(2)` 返回空串），被新增单测逮住。行内 `translateToString(true)` 逐字 trimRight，中间空行原样保留（终端输出里的空行有语义）。**不向 socket 写任何字节**（单测断言）。
  - **`app.js` 新增**：纯函数 `formatSshContext(conn, body, { intro })`（首行 `[SSH web-01 · ops@host:22]` 标注来源；空正文产出空串，绝不产出只有主机名的空消息）、`SEND_INTENTS` 三种意图（选区原样送 / 「这是终端的最近输出：」/「帮我看下这段终端输出有什么问题：」）、`sendToChat` + `sendMenuItems`、工具区 `#btn-send` 按钮、**终端右键菜单**（与按钮同一份菜单，沿用 `hostMenuItems` 的「同源」约定）、`send` 图标。
  - **隐私边界**：全程只读终端 + 写剪贴板；复制后状态栏明确提示字符数与「切到对话粘贴」，**不自动发送、不自动追加回车、不碰 SSH 连接、不向远端发任何字节**。
  - **测试**：ssh 60 → **63 例**（`session.test.js` +1：尾部裁剪 / 越界兜底 / 空缓冲 / 全空行 / 只读断言 / 销毁后为空；`app.test.js` +2：来源标记与引导语格式、intents 措辞）。`node scripts/verify-all.mjs ssh` → **12/12 PASS**。
  - **沙箱提示（环境假阴性）**：`node --test test/*.test.js`（多文件）在本会话受限沙箱下报 `spawn EPERM`——test runner 为每个测试文件 spawn 子进程并**管道捕获输出**，命中沙箱的命名管道边界，**不是代码缺陷**；改用 `node --test-isolation=none --test test/*.test.js`（单进程）或 `verify-all.mjs ssh` 均全绿。与 smoke-test-matrix 已记录的 sidebar `where.exe` EPERM 同源。
  - **待实机验证**：`index.js` 的 `cachedAsset` 对静态资源做**进程内一次性缓存**，改了 `app.js` / `session.js` **必须重启 `dsh web`** 才生效（浏览器强刷不够）。

## 2026-09-12

- **SSH 视图下隐藏官方「对话列宽」拖拽手柄**（用户实机反馈：「这个页面不需要可以调节对话框宽度」）。
  - **取证**（`dsh-client-ui-conversation/lib/client.js` 14652/14722/14957）：官方 `WidthHandle`（`[data-width-handle]`，两侧各 40px 的 `col-resize` 隐形条）挂在会话根 body 上，`phase === "active"` 即渲染、**与激活视图无关**——SSH 页面上用户会拖到一条毫无意义的列宽手柄，拖动即改写全局 `dsh.conversation.contentWidth` 偏好并连带挤压 SSH iframe。官方自己已有 `:has([data-conversation-composer-overlay])` 隐藏同一手柄的先例。
  - **实施**（`client.js` 既有样式注入追加一条规则）：`div[data-phase]:has(iframe[title="SSH"]) [data-width-handle]{display:none!important}`——以 iframe 挂载为条件（SSH 视图激活才挂载，切走即卸载 ⇒ 手柄自动恢复）；选择器全部用稳定 data 属性，不依赖 CSS-modules 哈希类；同一 style 元素、同一 effect 生命周期。
  - **测试**：`test/client.test.js` 增 1 例（12 → 13）——断言规则存在于注入样式、属性名无拼写漂移；**教训：harness 里样式在 `apply(ctx)` 时才注入，只调 factory 断言不到**。`verify-all ssh` 仍 **12/12**。
  - **运维**：host 进程改由本会话分离启动（`Start-Process` 隐藏窗口，日志 `%TEMP%\dsh-web-out/err.log`）——**若 host 再次消失，在用户自己的终端跑 `dsh web` 即可**（工具会话分离进程的生命周期不完全受控）。

- **U1 实机首跑两处阻断性 bug 热修**（用户实机截图：工作区主体蒙灰、右侧整块空白、列表不渲染）。本地静态 harness + 浏览器实测复现并逐项验证修复：
  - **`.hidden` 类名失配**：U1 重写 styles.css 时把 `.hidden{display:none!important}` 误改成 `[hidden]`（属性选择器），而 `#sheet-overlay` 初始态用的是 **class** `hidden` ⇒ 编辑抽屉浮层**从未隐藏**——灰层即遮罩 tint（`rgba(16,23,40,.21)`），右侧「空白块」即空的 sheet 面板（412px，右上 ✕ 就是 `#sheet-close`）。修复：`.hidden` 与 `[hidden]` 两条规则并存。
  - **`mount()` 同步崩溃**：mount 尾部引用了骨架里已不存在的 `#font-value`（字号控件重写时从静态骨架移到了菜单内联行）⇒ TypeError 使 `refreshConnections/renderAll` 全部未执行（空态/横幅/主机列表全不渲染）。修复：字号 −/值/+ 改为**主机菜单内的内联行**（`hostMenuItems` 支持 `custom` 节点，`setFont` 对 `#font-value` 判空），mount 不再引用菜单内元素。
  - 顺带修复 `icon('panel')`/`icon('copy')` 缺矩形形状（只有内部线条）。
  - **验证**（本地 harness，浏览器实测）：浮层 `display:none`、空态/横幅/列表渲染、编辑抽屉开→字段齐全→用户名必填且为空→取消关闭→焦点归还 `#toggle-rail`；ssh 回归仍 **12/12**（60 例：client 12 → 13）。截图通道当日不可用（IAB quirk），以 DOM 断言代偿。

- **U1 统一工作区实施**（[规划 §3/§4/§6/§7](2026-09-12-ssh-workspace-plan.md)；用户实机看过 U0 后反馈「界面和功能都不完善」，即按概念稿实施 U1；U2/U3 未动）。前端三件（app / styles / session）按概念稿重写，client.js 增主题桥接。
  - **双栏工作区**（`app.js` + `styles.css` 全量重写）：
    - 左侧主机导航（232px，容器 <720px 改模态抽屉、`inert` + 焦点陷阱 + Esc 归还焦点）：搜索（名称/`user@host:port`/分组联合）、分组归档（未分组垫底）、收藏星标（组内置顶）、存活状态点 + 文案；
    - 右侧工作区：多主机**终端标签**（同主机只 attach；关闭查看 ≠ 断开，[仅关闭查看 / 断开并关闭] 二选一确认）+ 身份工具栏 + 状态横幅（connecting / waiting-fingerprint / transport / closed / error / mismatch 六态各有行动按钮）+ 单条状态栏（状态 / 信任 / cols×rows·字号）；
    - 空态三态：无主机（新建引导）、未选中（最近连接 3 条 + 新建）、未连接选中（摘要 + [连接主机] [编辑配置]）；不再有整页连接库；
    - 主机菜单「右键与更多同源」（plan §3.2）：打开终端 / 编辑 / 收藏 / 复制地址 / 信任记录 / 断开… / 删除…（删除活跃主机说明将断开的连接数）；
    - 响应式断点 960 / 720 / 480 依据 **SSH 容器宽度**（container query），非窗口宽度；专注模式只收起本线导航。
  - **编辑器抽屉**：右侧 412px sheet——字段校验（用户名必填、**不再默认提权 root**）、认证方式渐进显示私钥路径、活跃主机编辑提示「仅影响下一次连接」、服务端错误内联展示、[取消/保存/保存并连接]；凭据（密码/口令）、指纹确认（TOFU 与 mismatch 两态，mismatch 无「仍然继续」只有「忘记旧记录」）、断开确认、粘贴确认全部走同一 sheet 组件。
  - **三主题桥接**（`client.js` ↔ `app.js`，plan §4.2）：
    - client.js：读宿主**最终计算样式**（body 优先、根元素兜底）白名单令牌（`--dsw-alias-bg-base/layer-1/layer-2/overlay/border-l2/label-primary/label-secondary/interactive-bg-hover` + `--dsw-static-deepseek-450`）+ 明暗（`data-ds-dark-theme`，canvas 同款判据）+ 字体 → 快照 `{source:'dsh-ssh',type:'theme',version:1,revision,dark,tokens,typography}`；
    - 双通道下发：同源 `postMessage(targetOrigin=location.origin)` + 页面级注册表 `window.__DSH_SSH_THEME__`（iframe 首帧同源直读，**不闪兜底色**，plan §4.2-9）；iframe 侧核验 `event.source===parent`、origin、字段白名单；
    - 变化检测：html/body 属性 observer（class/style/data-ds-dark-theme）+ head 样式增删 + visibilitychange 补发；快照序列化去重，同快照不重发；主题切换不销毁 xterm、不断 SSH；
    - iframe：`--ssh-*` 语义令牌 + `data-scheme` 亮暗；**半透明宿主色合成到实体底**（`compositeOver`）再进 xterm——桌面端 zafkiel/kurkuriel 的 `bg-base` 都是 rgba(.8/.93)，直接用会让终端透出壁纸；终端不透明硬契约；
    - xterm 配色：背景/前景/光标/选区（accent+alpha）+ ANSI 16 色按明暗两套固定（语义红绿保留含义，不全部品牌红）；首帧兜底 = `prefers-color-scheme`；iframe 元素底色改宿主令牌（不再固定深色闪底）。
  - **终端功能**（`session.js` 新 API + `app.js` 接线）：
    - `applyTheme` / `setFontSize`（12–20px 夹紧，重 fit → PTY 跟随）/ `find` / `clearLocal`（只清本地显示，与远端 clear 严格区分）/ `input`（粘贴确认后的直写通道）/ `onResize` 回调；
    - **查找零依赖**：`@xterm/addon-search` 对 xterm 6 只有 `0.17.0-beta` 线（registry 核实，无稳定兼容版），按规划「新增依赖须单独核验」标准**不引入**，改为缓冲区原生扫描（`translateToString` 逐行 + `term.select` 高亮 + `scrollToLine`，Enter/Shift+Enter 上下导航、n/m 计数）；已知边界：组合宽字符处 string index 与列号可能有偏差；
    - **复制粘贴**：Ctrl+Shift+C 写选区、Ctrl+Shift+V 读剪贴板（捕获阶段拦截，不污染 shell 的 Ctrl+C/V）；多行或含控制字符（含 ESC）粘贴先 sheet 预览确认、不自动加回车（plan §6）；
    - 布局偏好（字号/收起/专注）进 `localStorage`（非敏感，plan §8 允许）；秘密/终端输出仍不落盘。
  - **store.js**：`favorite` 字段归一化（布尔强转）+ 默认分组 `default`→`未分组` + **username 不再默认 root**（空串，表单必填）——迁移安全（normalizeConnection 补默认值），`sanitizeConnection` 暴露 `favorite`。
  - **测试（48 → 59 例）**：`test/app.test.js`（新 6 例）vm 加载 app.js 直取纯函数（分组过滤排序、粘贴守卫、rgba 合成、令牌回退、xterm 主题组合）；`test/session.test.js` 11 → 16 例（主题下发、字号夹紧+重 fit、缓冲查找导航换行、本地清屏、直写输入、onResize）；`test/store.test.js` 补 favorite/group/username 断言。跨 realm 教训再 +1：vm 返回对象 deepEqual 前必须浅拷贝。`node scripts/verify-all.mjs ssh` → **12/12**（语法 6 项 + 测试 6 文件 59 例）。七线全量：**ssh 12/12**；sidebar 9/10 的失败项（`terminal-hub.test.js` 两条）当时记为「并行会话中间态」，**2026-09-12 收官复核改判为受限沙箱环境假阴性**——`resolvePtyBin` 要捕获 `where.exe` 输出解析 shell 绝对路径，受限沙箱禁止管道捕获（`EPERM spawnSync where.exe`），用例在到达被测分支前即失败；判据与正确跑法见[回归矩阵 §1 的 ※※ 注记](../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)。
  - **误删回滚（同日）**：处理窗控/悬浮球反馈时曾把 `#miasaki-titlebar .tb-group`（titlebar v4 窗控）与 `#miasaki-switcher`（主题球）误判为"重复元素"做 SSH 作用域隐藏——二者正是用户在用的正主（壳为 `decorations(false)` 无边框，tb-group 即唯一窗控），已回滚并在 `test/client.test.js` 加 `doesNotMatch` 防回归断言。**真正根因在 desktop 线**：Tauri initialization_script 注入所有 frame，`themes/src/08-ready.js` 在 SSH/画布等 iframe 里重建了标题栏与主题球（页面右上的假窗控 + 右下角上面的假主题球）——已在 08-ready 加 `IS_TOP` 守卫（chrome 只在顶层 frame 构建，含 1s 自愈巡检），`gen-init` 重出产物，desktop 回归 8/8；壳为 `include_str!` 编译期打入，**需 MSVC 环境重编壳并重启**后生效。
  - **待实机验收**（U0+U1 合并，验收矩阵 §10）：重启 `dsh web` —— ①三主题（pure 亮/暗、刻刻帝、狂狂帝）下页面与 xterm 同步换肤、无闪底；②主机导航/标签/抽屉/状态栏布局成立、窄容器（右栏展开）降级抽屉；③真实连接 → 输出、多主机切换 attach、关闭查看再恢复；④指纹确认/mismatch 忘记/重信闭环；⑤Ctrl+Shift+C/V、查找、字号、粘贴确认；⑥对比度抽验狂狂帝浅底。

- **U0 可靠性闭环实施**（[工作区规划 §9](2026-09-12-ssh-workspace-plan.md) 首阶段；用户指示推进 SSH 方向，U0 按规划「先通过故障注入测试」门槛落地；U1–U3 未动）。
  - **新模块 [`session.js`](../session.js)：查看器实例**（诊断「输出与清理风险」「活跃终端无法恢复」的实现载体）：
    - 每个查看器独占一个 xterm + 一个 WS + 一组监听，`dispose()` 整体回收（term.dispose / socket 关闭并摘除处理器 / ResizeObserver 断开 / window resize 解绑 / 重附着定时器清除）；
    - **二进制输出修复**：构造时即设 `socket.binaryType='arraybuffer'`，二进制帧以 `new Uint8Array(event.data)` 落入 xterm——此前 binaryType 缺省为 Blob，`new Uint8Array(Blob)` 得到空数组，**终端根本没有输出**；
    - `onmessage` 不用 `instanceof ArrayBuffer` 判二进制（跨 realm 会失效，node:vm 测试踩中），按「非字符串即字节」处理；
    - **viewer 通道有界重附着**：WS 短断后 4 次、0.8s×n 线性退避自动重附；任何服务端帧重置预算；SSH 自身 `closed` / `error` / `NO_CONNECTION` 置 `sshEnded`，不再重附着（重附着不可能复活已结束的 SSH）；
    - **尺寸**：`ResizeObserver` 观察 holder + window resize 双路进 rAF 合帧 fit；出站 resize 限界 2–1000 列 × 2–500 行；
    - 状态文案映射（附着中 / 连接中 / 等待指纹 / 已连接 / 会话已结束 / 失败 / 重附着 N/4）。
  - **[`runtime.js`](../lib/runtime.js)**：
    - **指纹时间预算统一**：`HANDSHAKE_BUDGET_MS = 60s` 同时作为 ssh2 `readyTimeout` 与确认窗口——此前确认窗 60s、握手超时 15s，用户确认时连接早已死掉；
    - **确认 token 与连接实例 generation 绑定**：pending 项记录 `rc` 引用，`confirmFingerprint` 校验 `conns.get(connId) === item.rc && !disposed`——连接重发后的旧确认返回失效，绝不写新实例状态；
    - **保存失败不再吞错**：`recordFingerprint` 抛错 ⇒ `verify(false)` + `FINGERPRINT_SAVE_FAILED`（此前 `.catch(() => {})` 后照样放行，没落盘的信任被当作已确认）；
    - **pending 生命周期**：client error / close、`teardown`、`shutdown` 均经 `expirePendingFor` 清 token + `verify(false)`；
    - **attach 契约**：viewer 绑定写 `ws.sshRc`；携带的初始尺寸夹紧后**立即 `setWindow` 进真实 PTY**；`onReady` 的 ready 帧补 `state:'connected'`（此前无 state 字段，前端误显示「等待连接」）；
    - **输入归属**：新增 `currentViewer / viewerInput / viewerResize`——输入与尺寸按 `ws.sshRc` 实例路由而非 connId 查表，被替换代次的僵尸 viewer 收 `STALE_VIEWER` 并被关闭；`sendInput / resize`（按 id 查表）删除；
    - **背压**：`push()` 发现 `ws.bufferedAmount > 8MB` 即淘汰该 viewer（1011 关闭），不无限堆积拖死连接；
    - resize / attach 尺寸统一 `clampDim` 夹紧（负数 / 巨大值有界）。
  - **[`index.js`](../index.js)**：WS 帧 256KB 上限（超限静默丢弃）；input/resize 改走 viewer 绑定路由；新增 `/ssh/session.js` 静态路由并在页面按序引入。
  - **[`app.js`](../app.js)**：
    - **恢复 attach**：已连接 / 连接中 / 待指纹主机的主动作是「打开终端」（只 attach，不发第二个 connect）；idle 才是「连接」，error/closed 是「重新连接」；顶栏「终端」按钮只在存在查看器实例时可用；
    - **凭据对话框泛化**（`askSecret`）：密码必填、私钥口令选填（后端本就支持口令，前端从未给过输入框）；对话框关闭即清空输入框（秘密清理）；
    - **取消按钮**：补 `type="button"` + 独立行为（返回连接库）——此前它默认 type=submit 且无处理器，**点「取消」等于提交保存**；
    - **信任记录 UI**：连接库底部新增 known_hosts 列表（hostKey + 指纹 + 忘记按钮），闭合「指纹变更拒绝后无恢复路径」的死胡同（REST 早已存在，前端一直没入口）；
    - 删除活跃主机时在 confirm 里说明将断开连接；指纹确认失败 / 过期在状态栏给可读文案。
  - **[`styles.css`](../styles.css)**：终端高度链修复（`.term-holder` 去掉 `height:100%` 改 `flex:1 1 auto; min-height:0`，不再与工具栏叠加溢出）；信任记录 / 对话框提示样式。
  - **测试（28 → 48 例）**：新增 [`test/session.test.js`](../test/session.test.js) 11 例——node:vm + 假 Terminal/WS/定时器/ResizeObserver 驱动故障注入（二进制落终端、dispose 后旧 socket 无串写、重附着预算与线性退避、sshEnded 不重附、NO_CONNECTION、等待指纹不封死重附、畸形控制帧、出站 resize 夹紧、rAF 合帧、dispose 全量回收）；[`test/runtime.test.js`](../test/runtime.test.js) 5 → 14 例（保存失败拒绝、跨代确认隔离、teardown/shutdown 清 pending、attach 尺寸进 PTY、viewer 夹紧、僵尸 viewer 拒绝、背压淘汰、onReady ready 帧契约；既有 TOFU 用例补 `conns.set` 适配 generation 绑定）；`RuntimeConn` 导出供测试构造真实实例。`node scripts/verify-all.mjs ssh` → **11/11**（语法检查 6 项，新增 session.js）。
  - **待实机验证**（并入 M1 验收清单）：重启 `dsh web` 后——真实连接出终端输出（U0 前终端应是无输出的）、连上 → 切对话 → 切回 scrollback 回放且无串写、已连接主机一键回终端、WS 断网 4 次内自动重附、指纹确认 / 忘记 / 重新信任闭环、取消编辑不保存。

- **工作区优化规划设计（设计提案，未写业务代码）**。用户诉求：「SSH 界面很简陋，要和本项目界面风格统一、适配三大主题，功能完备简洁合理、界面适配自然优雅」。
  - **产出**：
    - [`2026-09-12-ssh-workspace-plan.md`](2026-09-12-ssh-workspace-plan.md)（新）——诊断、信息架构、主题桥接、生命周期契约、分期 U0–U3、验收矩阵、源码索引、概念稿验证记录；
    - [`preview/2026-09-12-ssh-workspace-concept.html`](preview/2026-09-12-ssh-workspace-concept.html)（新）——可交互概念稿，支持三主题 + 原生暗色、四档宽度、八种状态切换；
    - `README.md`（文档表补两行）。
  - **诊断（源码取证，非文档转述）**：
    - 主题割裂：`styles.css:2–12` 固定蓝黑色板、`app.js:165–170` xterm 独立硬编码配色 ⇒ pure 亮色与狂狂帝下页面像外挂应用；
    - 页面割裂：`app.js:237–310` 连接库 / 编辑器 / 终端三屏切换、`styles.css:66` 连接库限宽 720px ⇒ 大屏浪费且上下文丢失；
    - **活跃终端不可恢复**：`app.js:77–79` 已连接时按钮被禁用、`mount()` 恒回连接库 ⇒ iframe 重建后连接还在但进不去；
    - 关闭语义缺失：前端无断开 / 重连，`runtime.js:58–74` 重复 connect 会 teardown 旧连接；
    - 输出链缺陷：`app.js:187–198` 未设 `binaryType` 却把二进制事件直接当 `Uint8Array` 处理；新终端未集中销毁旧 term / socket / resize 监听；
    - 指纹闭环不足：`app.js:221–228` 用原生 `confirm`、重置信任无 UI、`runtime.js:181` 记录指纹失败被吞、`runtime.js:13` 的 60s 确认窗口与 `runtime.js:73` 的 15s 握手超时不协调；
    - 尺寸处理不足：`app.js:182` 仅监听 window resize；`styles.css:112–127` 终端 `height:100%` 叠加工具栏高度。
  - **方案要点**：可收起主机侧栏 + 多主机终端标签 + 单条状态栏；**保留现有会话头三段胶囊入口，不新增应用级上栏**（沿用 2026-09-10 第六次修正的结论）；主题以宿主最终计算样式为唯一源，白名单化后经同源 postMessage 下发 `--ssh-*` 与 xterm ANSI 色；区分「主机配置 / 运行连接 / 查看器」三种身份并明确关闭、断开、重连契约；响应式依据 SSH 容器实际宽度（960 / 720 / 480 断点）而非桌面窗口宽度。
  - **三主题口径校正**：以现役 CSS 为准——刻刻帝 `#c23a2e` 暗色、狂狂帝 `#9e1b1b` 亮色（`kurkuriel.css:8` 为 `color-scheme: light`）；`design/themes.md` 的旧色阶表与现役实现存在漂移，不作为实施依据。
  - **概念稿实测（第一轮，真实 Chromium）**：三主题渲染正常；内容宽 560px 时主机栏正确收起、无横向溢出；390px 抽屉宽 288px 且工作区 `inert`；信任面板 `role=dialog` + `aria-modal`、焦点正确移入。
  - **概念稿实测（第二轮，无障碍与键盘）**：
    - **axe-core 4.12.1 审计**：首轮 1 类严重违规（11 处对比度不足，最差 3.51:1）+ 3 处 `aria-label` 挂在无 role 的 `div` 上 + 2 处 `☆` 文本字符判为非文本。**修复后四套实装组合（原版亮色 / 原版暗色 / 刻刻帝 / 狂狂帝）全部 0 违规、0 待复核、39 通过。**
    - 修复项：`.host-address` 4.36→ 调深 `--muted`；`.caption` 4.37、说明区序号 3.51、说明区正文 4.49、页脚 3.50 各自调深；**狂狂帝 `--warning` `#7f693a` on `#f3ecdd` 仅 4.48、`--muted` `#74685e` on `#e9e3dd` 仅 4.24**，分别调深至 `#7a6436` / `#6a5e54`；`.native-switch` / `#tabs` 补 `role="group"`、`#terminal` 补 `role="region"`；收藏标记改为 `aria-hidden` 的 SVG + `sr-only` 文本。
    - **键盘实测**：连按 14 次 Tab 与 6 次 Shift+Tab 焦点均不逃逸面板；Esc 关闭面板 / 抽屉后 `inert` 复原且焦点归还触发元素。
    - **修出一个真实缺陷**：关闭浮层的焦点回退守卫原以 `isConnected && !closest("[hidden]")` 判定，`document.body` 也满足该条件 → 触发器不可聚焦时焦点丢到 `body`。已改为排除 `body` 并回退到确定目标。该约束已写入设计文档 §7.1。
    - **由此固化的实现约束**：`--muted` 类辅助文字与 `--warning`/`amber` 类语义色必须**逐主题**在其实际底色上校验 ≥ 4.5:1；狂狂帝浅底最易失守，与其「亮面为主」取向直接相关，不是偶发。
    - **仍未覆盖**：真实宿主令牌继承、真实 xterm 尺寸同步与 `setWindow`、reduced-motion、浏览器 150% 缩放的字体渲染与滚动条占宽差异、触屏命中尺寸。150% 缩放对布局的影响已被窄宽度用例部分覆盖（容器查询只依赖宽度），其余留作实现阶段验收项。
  - **待用户评审的三个取舍**：① 是否采用「主机侧栏 + 终端工作区」（对比整页连接库）；② 终端是否默认完全跟随主题（狂狂帝即亮终端）；③ 是否接受 U0+U1 为首个可发布范围（SFTP 留 U2）。
  - **本轮不改**：`app.js` / `styles.css` / `client.js` / `lib/*` / `index.js` 与既有测试均未改动；概念稿只新增在 `design/` 下。

## 2026-09-10

- **修复：client 半加载失败 `invalid plugin … received undefined`（`client.js` 工厂漏 `return module.exports`）**。
  - **现象**：宿主重启后前端报 `Failed to load plugins` / `failed to apply loader entry <8 位随机 id> (@miasaki/dsh-ssh): invalid plugin, expect function or object with an "apply" method, received undefined`。
  - **定位**（DSH 0.1.2-rc.1 源码逐层核实）：
    - 报错出自 **浏览器端 cordis**，不是 host 半：`packages/client/web/src/boot.tsx` 的插件启动对每个客户端模块执行 `loader.create({ name })`——只传 `name` 不传 `id`，故 entry id 是 `ensureId()` 生成的随机 8 位十六进制（即错误里的 `2f010b31`）；随后 `EntryTree.import` → `internal.import`（ClientModuleLoader）物化 `client.js` 注册的工厂，把返回值交给 `registry.plugin()`。
    - host 半无恙：`dsh web --dump-config` 中 `id: ssh` 一行完整；profile 目录直接 `import('@miasaki/dsh-ssh')` 也拿得到 `apply` / `inject` / `name`。
  - **根因**：`client.js` 的 `factory` 结尾漏了 `return module.exports`（canvas / sidebar 两线均有此行）。工厂返回 `undefined` ⇒ cordis 判定 `invalid plugin`。
  - **修复**：补 `return module.exports`。
  - **防回归**：新增 `test/client.test.js`——在 `node:vm` 里执行 `client.js`，捕获 `window.__ModuleLoader__.load` 的 descriptor，断言工厂返回含 `inject`/`apply` 的对象、`apply` 注册 `conversation.view`（id `ssh` / order 20 / label `SSH`，视图为 `src='/ssh/'` 的 iframe）、幂等守卫与 effect 复位可重挂载。单测 20 例全绿。
  - **待复核**：宿主重启 + 浏览器刷新后确认 tab 出现、无插件加载失败横幅（M1 真实连接验收清单不变）。
- **纳入统一回归（六线）**：`scripts/verify-all.mjs` 新增 `ssh` 线，登记 5 项语法检查（`index.js` / `client.js` / `app.js` / `lib/store.js` / `lib/runtime.js`）+ 4 个单测文件，**9/9 通过**（含 20 例单测）。
  - 纳入口径：单测不触真实 SSH 连接（store 的三道围栏与归一化、runtime 的 TOFU 与错误分类、http 路由、client 工厂返回契约），**任何机器可复现**；真实连接验收仍是实机项，留在 `dsh-miasaki-shared-docs/cross/smoke-test-matrix.md`。
  - 同步：根 `README.md` 由「五线统一回归」改为六线，`AGENTS.md` 扩为六线登记（补 dual-model 行）。
- **入口位置调整：从第二行 tab 栏迁到第一行「对话 / 会话布」旁**（用户 2026-09-10 反馈：「SSH 的入口按钮应该是和对话会话布切换按钮那里，而不是在会话用量后面」）。
  - **归因**：一条会话里有两套并行切换 UI —— canvas 的「对话 / 会话布」胶囊注册在 `conversation.session.header.actions`（会话头**第一行**，order 25）；SSH 走 `conversation.view` 被投影成官方 tab 栏（**第二行**）的 tab，order 20 正好排在 token-monitor(15) 之后，就是用户看到的位置。
  - **能力边界（源码核实，非猜测）**：DSH **未对外暴露 View 切换 API** —— `selectView` 只注入官方 `conversation.session.header` 组件（`dsh-client-ui-conversation/lib/client.js` 16705–16713），而 `conversation.session.header.actions` 子槽渲染时 owner props 是空对象 `{}`（同文件 15072）；客户端 Inspect 服务目录也只有 layout / locale / sessions / slots / theme / timer / uiWorkspace / workspaces，没有 conversation 相关服务。
  - **实现**（`client.js`）：
    - 新增注册 `conversation.session.header.actions`（id `ssh-view-switch`，order 26 —— 紧跟 canvas 的 25），渲染与 canvas 胶囊同款视觉的「SSH」按钮（主题令牌配色、999px 圆角、28px 按钮、总高 30px）；
    - `conversation.view`（id `ssh`，order 20）注册**保持不变**：页面本身、host 侧连接保活、scrollback 回放全部不动；
    - 切换**委托点击官方 tab 按钮**（官方唯一通道），全程带守卫：找不到 tab 就不动作、也**不**收起 tab —— 最坏退回「双入口」，而不是没入口；激活态读官方 `aria-selected`，由 header 上的 MutationObserver 同步；
    - 收起官方 tab 栏里那一个 tab（内联 `display:none`，tab 元素被重建后重新收起，fiber 卸载时复原）；
    - 点「SSH」前先走 canvas 自己的「对话」按钮关掉「会话布」全屏浮层（直接改 `overlay.hidden` 会让 canvas 胶囊激活态不同步）；canvas 不在场时选择器落空即跳过；
    - 继承 canvas 2026-09-10 定下的两条行内契约：**高度** 30px（上下 padding 必须为 0）、**宽度**窄时按同款判据（`leftGap` 120/200 滞回 + 观察 header）降级为 28px 终端图标；
    - tab 查询范围限定在会话头 `header` 内（用自己的按钮当锚点），避免误伤页面上其他 `role="tablist"`。
  - **二次优化（同日第二次反馈：「两个同款胶囊并排、中间一道缝，还是两组控件」）**：改为**与 canvas 胶囊合成为同一个控件**，一个胶囊里「对话 | 会话布 | SSH」三段，**全部是纯 CSS 覆盖，canvas 文件一行未改**：
    - `.dsh-canvas-switch:has(+ .dsh-ssh-switch)` 把 canvas 胶囊右端打开（去右边框 + 右圆角归零）；`.dsh-canvas-switch + .dsh-ssh-switch` 用 `margin-left:-8px` 吃掉官方 `headerActions` 的 `gap:8px`、本段左圆角归零，保留自己的左边框 ⇒ 中间那条竖线即分段线；
    - **同一控件里不同时亮两段**：停在 SSH 时用 CSS 抑制「对话」段的高亮；「会话布」全屏浮层打开时抑制本段的高亮（两条都带 `:not(:hover)`，hover 反馈照旧）；
    - **行为补齐**：canvas 的「对话」段只关它自己的浮层、管不了 DSH 的 View，停在 SSH 时点它屏幕上什么都不变。本线捕获它的 click，若当前停在 SSH 就顺带委托切回默认视图（官方 tab 栏里 order 最小的 view，`chat` order 0 恒为第一个）；`dismissCanvasOverlay()` 自己也会点这个按钮，故加 `dismissing` 标志隔离那一下，否则点「SSH」会先切 chat 再切 ssh（视图连换两次、iframe 卸两次）；
    - **退化方向**：canvas 不在场、或未来有别的插件插在两者之间 ⇒ `+` / `:has()` 不匹配 ⇒ 本段退回完整胶囊（又变回两个胶囊），功能与安全不受影响。
  - **三次优化（同日第三次反馈：「会话布页面没有按钮」）**：canvas 浮层是 `position:fixed; inset:0; z-index:100`，一打开就把会话头连同切换器一起盖住 —— 用户在画布上没有任何切换入口。**没有去跟层叠上下文斗**（要让 header 内控件压过浮层，需要 header 到根之间每个祖先都没创建层叠上下文，离线核不实，只能确认 `#root` 自身没有），改让**浮层从会话头下沿开始**：`body .dsh-canvas-overlay{top:var(--dsh-ssh-header-h,76px)}` —— 切换器留在原位、任何视图里都在，画布自适应（`/canvas/` 的 iframe 是 100% 高）。高度由 `measure()` 实测 `header` 高度写入变量（官方 header 是 `min-height` 而非固定高，主题 / 字号 / 语言都会改它），`76px` 兜底；`body` 前缀把特异性抬到 (0,1,1) > canvas 的 (0,1,0)，否则谁先 apply 谁被覆盖；卸载时撤掉变量与规则。代价：会话布顶部让出会话头高度。备选（若实机反馈「画布要全屏」）：保留全屏 + 在浮层之上挂一条 body 直接子元素的悬浮切换器（`z-index:101`，同层比较，不依赖祖先链）。
  - **四次修正（同日第四次反馈：「怎么搞成这样了」+ 截图）**：只让位不够 —— 浮层让出的 76px 露出的是**整条页面顶**（左侧栏的品牌行 / 工作区行也在里面），跟画布自己的标题栏叠成两层，看着像两个应用摞在一起。修正：在浮层之上补一条**本线自己的工具条** `body > .dsh-ssh-canvas-bar`（`position:fixed; top:0; left:0; right:0; height:var(--dsh-ssh-header-h,76px); z-index:101`，不透明底色 + 底边框，右端放与 header 里同款、同行为的三段胶囊）把露出的部分盖住；它挂在 `document.body` 下、与浮层**同处 body 的层叠上下文**，`101 > 100` 必然在上，不依赖任何祖先链。三段行为全部复用既有通道（「对话」= 委托 canvas 按钮关浮层、「SSH」= 委托官方 tab 切视图）⇒ header 与工具条是同一套逻辑的两处 UI；用原生 DOM（client 半拿不到 react-dom，没有第二个挂载点）；浮层可能晚于本插件被创建，故先盯 `document.body` 的 childList、拿到浮层后再盯它的 `hidden`。会话布视图下三层：0–76px 本线工具条 / 76px 以下 canvas 浮层（其标题栏、工具组、窗控完整保留）/ 再往下被盖住的 DSH 会话区。
  - **五次修正（同日第五次反馈的截图：工具条上的胶囊被桌面壳窗控 − □ × 压住）**：原先工具条照抄官方 header 的 `padding:0 28px`，但桌面壳会给会话头**额外的窗控让位**（desktop 线主题注入的 128px 安全区），会话头里的胶囊本来就比 28px 靠左得多，工具条这颗却贴右边 —— 正好撞进窗控。修正：**不抄常量，跟随会话头里那颗胶囊的实测位置** —— `measure()` 每轮把 `视口宽 − 会话头内胶囊.right` 写进 `--dsh-ssh-bar-right`，工具条用它当右内边距；于是纯浏览器 / 桌面壳 / 右栏推挤展开三个环境以及主题、字号、语言变化全部自动跟随，两处胶囊还逐像素对齐。
  - **六次修正（同日第六次反馈：「只是让加一个 SSH 按钮，为什么会多出一整个上栏」）——三～五次的产物全部撤掉**：需求被重新校准 —— 用户从第三次起说的「会话布页面没有按钮」，指的是**画布页面内部那组「对话 / 会话布」按钮旁边缺一个 SSH**，不是"页面上没有任何入口"。我在浮层之上补整条工具条方向错了。移除：`body .dsh-canvas-overlay{top:...}` 让位、`--dsh-ssh-header-h`、`--dsh-ssh-bar-right`、整条 `.dsh-ssh-canvas-bar`（画布浮层恢复全屏原样）。改走**画布提供的通用「外部视图槽」**：本线把 `{ id, label }` 写进页面级注册表 `window.__DSH_CANVAS_VIEW_ITEMS__` 并派发 `dsh-canvas:view-items` → canvas 的 client 半在 iframe `load` / 浮层打开 / 注册表变化时转成 `canvas:views` 下发 → 画布页面在它自己的 `.view-switch`（「对话 / 会话布」）里多渲染一个按钮 → 点击广播 `canvas:view` → **本线自己监听**并关浮层 + 切视图。canvas 侧不认识 SSH（源码里连 "SSH" 字样都被测试锁死），两侧只有这一份页面级约定、没有代码耦合。canvas 线改动：`app.js`（state.externalViews + `externalViewButtons()` + `canvas:views` 处理 + 点击广播）、`client.js`（注册表转发 + 三处下发时机 + 监听/解绑），并新增契约测试 `dsh-miasaki-canvas/test/external-views.test.js`（3 例，含"canvas 不认识具体视图"的红线断言）。
  - **测试**：`test/client.test.js` 由 4 例扩为 **12 例**（入口槽与 order 相邻性、胶囊样式与 30px 高度契约、合体规则与「单一高亮」、画布外部视图槽的注册与响应（并断言上栏产物已彻底消失）、委托切换与「找不到就收手」、点「对话」段的行为补齐与 `dismissing` 隔离、tab 收起与复原、窄宽度判据锚点截取求值等），本线 **28 例全绿**；`node scripts/verify-all.mjs canvas ssh` → **canvas 11/11、ssh 9/9 PASS**。
  - **未采纳**：在浮层之上补整条工具条 / 让浮层让位（用户明确否掉：「为什么会多出一整个上栏」）；宿主 DOM 里覆盖按钮去对齐画布内部的按钮（那组按钮在 iframe 内，位置读不到，只能猜）；让 canvas 宿主胶囊容纳「SSH」项（那是 canvas 私有的浮层开关，与 iframe 内那组不是同一处）；改 DSH 本体把 tab 栏搬到第一行（升级重打 + 第一行宽度预算放不下 4 个 tab）；直接写 per-session View 偏好（store 已物化，绕过 store 状态不一致）。理由见[设计文档 §5.5](2026-09-09-ssh-design.md)。
  - **待实机复验**：宿主重启 + 浏览器刷新后 —— ①第一行出现「SSH」段并与「对话 / 会话布」**同处一个胶囊**（中间一条分段竖线、无缝隙）；②第二行 tab 栏只剩「对话 / 轨迹 / 会话用量」；③点该段切到 SSH 页面、本段高亮而「对话」段不再高亮；④停在 SSH 时点「对话」段能回到对话视图；⑤**切到「会话布」后，画布页面内部那组「对话 / 会话布」旁边多出一个「SSH」按钮**（不多出任何栏、页面顶不再有第二条标题栏）；⑥在画布里点那个 SSH 按钮，浮层关闭并切到 SSH 页面；⑦切走再切回：连接不断、scrollback 回放正常；⑧右栏展开收窄时两段一起降级为图标且不与官方控件压叠。

## 2026-09-09

- **立项**：在 DSH web 会话视图切换区集成 SSH 入口、页面内交互式连接云服务器，正式立项为本仓第五条线。
- **关键调研结论**（实测 DSH 0.1.2-rc.1 源码与运行时）：
  - **DSH 官方有会话视图机制**：`conversation.view`（list 插槽，scope `session`，`replaceRisk: none`）现有 `chat`(0) / `trajectory`(10) / `token-monitor`(15)；注册项被投影为 `ViewTab { id, label }`，由 `ConversationSessionHeader` 渲染成 `role="tablist"` 的 tab 栏（`tabs.length > 1` 才渲染），激活态、`aria-selected`、每会话独立记忆（`ConversationStoreState.view`）全部由 DSH 托管。
  - **canvas 的切换按钮在另一处**：`conversation.session.header.actions`（order 25，第一行标题右侧），与 DSH 原生 tab 栏（第二行）是两套并行 UI；canvas 为此背了幂等守卫 / 重渲染看门狗 / 叠压修复 / 主题令牌化等补丁。
  - **host 侧官方支持 WebSocket**：`@deepseek-ai/dsh-host-webserver` 的 `WebServer.registerUpgrade({ path, handler })` 按精确路径匹配、handler 拥有协议协商与 socket 生命周期、插件卸载时服务显式销毁 tracked upgraded socket——SSH 终端流不需要自建 HTTP 服务器。
  - **依赖形态**（registry 元数据核实）：`ssh2` 1.17.0 为纯 JS（`cpu-features` / `nan` 仅 optional 加速）；`@xterm/xterm` 6.0.0 无运行时依赖、`main: lib/xterm.js` 可直接 `<script>` 引入。
- **决策**：
  - SSH 协议实现走**方案 A（ssh2 + ws + xterm.js）**，规避 node-pty 在 Windows 的 VS Build Tools 依赖（sidebar 线 M3「内嵌终端」长期未立项的主因）；「spawn 系统 ssh.exe」作为 M2 补充按钮，复用 `~/.ssh/config` 处理复杂认证；
  - 入口走 **`conversation.view` 官方机制**（用户 2026-09-09 拍板，方案 1）：SSH 成为会话 tab 栏的一个 tab，与「对话 / 轨迹 / Token 监控」并列；**本次不改 canvas**；
  - 页面形态 = iframe（`/ssh/`）内嵌在视图组件里，沿用 canvas 的隔离策略（client bundle 由 `__ModuleLoader__` 加载、无法 `require` 第三方包）；
  - 连接在 **host 侧全局持有**（视图切换 / 页面刷新不断连），凭据只存在于 host 进程内存；
  - 安全红线：三道浏览器围栏（Host / `sec-fetch-site` / Origin）**HTTP 与 WS upgrade 都要过**、默认只连回环、主机指纹 TOFU + 变更拒绝、密码不落盘、私钥不进前端存储；
  - M1 范围 = 纯终端 + 连接管理（不含 SFTP / 跳板机 / agent 联动）；
  - 项目位置 = `dsh-miasaki-ssh/`，包名 `@miasaki/dsh-ssh`。
- **产出**：[设计文档](2026-09-09-ssh-design.md)（含 §9 SPIKE 清单 S1–S5 与 §7 安全红线）。
- **SPIKE 实测（同日，动态 Cordis 探针，已清理）**：
  - **S2 通过**：`ctx.get('webServer')` 在插件里可访问，`register` / `registerUpgrade` 均可调用；注册 `/ssh-spike/ws`（upgrade）后 Node 原生 `WebSocket` 客户端连接被 handler 完整接管（拿到 `upgrade: websocket` / `connection: upgrade` / `sec-websocket-key` / `sec-websocket-version: 13`，`head` 长度 0）；普通 GET 打到 upgrade 路径返回 404（不污染普通路由表）；HTTP + upgrade 双注册无冲突。
  - **S4 通过**：注册真实 `conversation.view`（id `ssh-spike`）后 tab 栏出现第四个 tab；iframe 视口 992×596（父文档 1280×800）填满中间列、无内部滚动条；keydown 0→23 递增（含 IME 的 `Process`、`Backspace`、`Enter`），iframe 内键盘不被 DSH 抢。
  - **S4 附带发现（影响架构）**：切走再切回视图，iframe **加载次数 1→2→3、`timeOrigin` 每次变化**——`ConversationSession` 以 `renderSlot(…, { only: active.id })` 只渲染激活视图，故切换会卸载重建。设计随之新增 **host 侧 scrollback 环形缓冲 + attach 时 `replay` 帧**（§5.4，M1 强制项），并记录「常驻 `shell.overlay`」为 M2 备选。
  - **S3 部分通过**：host 路由 serve 静态页面给 iframe 已验证（探针页面即经 `/ssh-spike/page` 提供）；xterm 具体文件与体积待装包后确认。
- **未实现**：本线当前只有设计文档，无代码；M1 实现前仍需跑 SPIKE S1（ssh2 在 Windows 的安装与真实连接）与 S5（`hostVerifier` 的 TOFU 交互）。
- **M1 实现（推进中，同日）**：
  - **依赖落地（SPIKE S1 / S3 闭环）**：`pnpm install` 成功安装 `ssh2` 1.17.0、`ws` 8.21.3、`@xterm/xterm` 6.0.0（`lib/xterm.js` UMD ≈ 260KB）、`@xterm/addon-fit` 0.11.0；ssh2 的 `cpu-features` / `nan` 只编译了 optional 部分、未中断安装。S1 / S3 正式转绿。
  - **代码骨架落地**：`lib/store.js`（纯数据层：连接库 CRUD + known_hosts TOFU + 三道围栏 + JSON 原子写）、`lib/runtime.js`（ssh2 运行时：`hostVerifier` 异步 TOFU、scrollback 环形缓冲、WS 中继、错误分类）、`index.js`（host 半路由族：`/ssh/` 页面、xterm 静态资源、`/ssh/api/*` REST、`/ssh/ws` upgrade）、`client.js`（`conversation.view` 注册 + iframe）、`app.js`（前端 xterm + 连接管理 + 密码即时输入）、`styles.css`。S5（异步 TOFU）已在运行时中落地。
  - **单测全绿**：`test/store.test.js`（围栏 / 归一化 / 指纹格式 / 持久化 / 凭据不落盘）与 `test/runtime.test.js`（错误分类 / TOFU 三分支 / 变更拒绝）共 13 例全部通过；`node --test` 可复跑。
  - **与设计文档 §5.4 一致**：WS 帧为「JSON 控制帧 + 二进制输出帧」双通道；attach 时 host 先回放 scrollback 再续流，视图切换 / 页面刷新不丢屏。
  - 注：`__ModuleLoader__` 的 `client.js` 栈式注册 / `cordis.patch.yml` 的 `dshHomePath` 写法沿用 canvas 既有模式。
  - **待办**：`dsh plugin --profile web add link:…` 安装到 web profile 后，浏览器实测真实连接的验收标准（§7 清单）。
