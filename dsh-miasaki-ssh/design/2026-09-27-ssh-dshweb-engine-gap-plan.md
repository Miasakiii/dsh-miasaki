# dsh-web 对标：U2 引擎层差距与加固方案（v1.1，G1/G2 已实施）

- **日期**：2026-09-27
- **对标对象**：[zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web) `packages/dsh-ssh` v0.4.3（`@linxin666/dsh-ssh`）
- **深度笔记**：`_refs/dsh-ssh-study/NOTES.md`（源码同目录留档 37 文件；`_refs/` 为归档区，不入库）
- **触发**：用户「参考 dsh-web 官方仓库」，先完成引擎/路由层深读，再展开为对本线的具体改造方案
- **实施状态**：**G1/G2 已于 2026-09-27 实施完成**（单测 299→310、`verify-all ssh` 31/31、真协议探针 `_refs/scripts-archive/ssh-g1-g2-probe/`）；G3–G5/G6 仍待拍板。实施记录见 [CHANGELOG](CHANGELOG.md) 顶部。

## 0. 结论先行（含一处对仓库级过时描述的更正）

**更正**：仓库根 `AGENTS.md` 与共享记忆里「ssh 线 U2（SFTP/多 shell）/ U3（跳板/转发）未动」是**过时描述**。
本线实际进度（以本目录 CHANGELOG 与 README 时间线为准）：U2.1 三层身份 + 多 shell、U2.3 工作区记忆、
U2.4 精确恢复（2026-09-16）；U2.2 SFTP + P0 三件套 + P1-1 ssh config 导入（2026-09-26）；
U3 跳板/本地转发 + A1 工具面（2026-09-26，A1 已实机验收）；T4 让位契约化（2026-09-27）。
单测 **299 例**、`verify-all ssh` **31/31**。**因此本文不是「从零做 U2」，而是对标后的差距加固。**

**结论**：UI/配置层、TOFU、写所有权、票据、连接诊断、A1 工具面本线已**反超** dsh-web；
引擎层逐项核对后识别出 **2 项真实缺陷风险（G1/G2，建议必修）+ 3 项候选（G3–G5，待拍板）**。

## 1. 现状盘点：dsh-web 能力 ↔ 本线现状

| dsh-web 引擎/路由能力 | 本线现状 | 判定 |
|---|---|---|
| 连接池 broken 标记 + 断线重连（≤3 次） | `bail()/answer()/classifyError()` + 重连走 `connect()` 重来；keepalive 15s×3 | 等价（形态不同） |
| PTY 会话归 Host + detach/reattach + 滚动回放 | 三层身份 `connId→runtimeId→shellId` + ShellChannel 回放环 + 一次性 30s attach 票据（U2.1） | **已覆盖**（票据比 dsh-web 的 sessionId 更严） |
| 终屏精确恢复 | U2.4 `@xterm/addon-serialize` 屏幕快照（host 侧 128KiB 内存封顶） | **更强** |
| 写所有权单写多读 + 显式接管 | `bindShell/unbindShell/takeoverShell` + `write.open/write.revoked`（U2.1） | **已覆盖** |
| WS 背压：高低水位 → `shell.pause()/resume()` | 慢 viewer **直接断开**（`bufferedAmount > 8MB` → `close(1011)`，runtime.js:781-787） | **差距 → G2** |
| `withSftp` 频道 endOnce（防 MaxSessions 泄漏） | 连接级**缓存** `rc.sftp`（不逐操作开关频道，从根上无此泄漏）；teardown/shutdown 均 `rc.sftp?.end?.()`（:1024/:1041） | **已覆盖**（路线不同） |
| SFTP 上传/下载/列目录/进度节流 | `lib/sftp.js` + zcode 降级链（exec pipe）+ 1s/5% 节流 + AbortSignal（U2.2） | **已覆盖**（降级链更强） |
| SFTP 会话中途死亡后的自愈 | `rc.sftp` 死引用无清理 ⇒ 文件面板整条连接生命周期中毒 | **差距 → G1（缺陷风险）** |
| 端口转发 pin 连接 + 兄弟隧道引用释放 | `lib/forward.js` direct-tcpip 真监听；转发随连接就绪/断开自动建立/撤除；首字节不丢；500ms 收尾兜底 | **已覆盖** |
| ProxyJump 多跳（别名或地址形式） | `jumpHostId` 只引用**已受信任连接** + forwardOut sock 注入 + 就绪门 + JUMP_UNAVAILABLE 前置拒绝 | **更强**（不认临时地址跳板是安全取舍） |
| ProxyCommand 传输层 | 未实现（U3 范围未含；dsh-web 有 248 行全语义实现） | 候选（G6，见 §5） |
| 集群并发执行 | 无（A1 仅单主机 `ssh_exec`） | M3 工具面扩展，不在本文 |
| loopback 围栏（socket 权威 + 同源 markers，不信 XFF） | 三道浏览器围栏（Host / `sec-fetch-site` / Origin），HTTP 与 WS upgrade 都过 | **已覆盖** |
| exec 截断 2MB + 防代理对切割 | `cap()` 按 JS 字符串长度切，未防代理对切割；`maxOutputBytes` 名实为 UTF-16 单位（exec.js:63） | 小瑕疵 → G5 |
| Agent 工具 6 个 | 3 个（`ssh_hosts`/`ssh_exec`/`ssh_session_read`）+ L0/L1/L2 分级 + 审批 + 审计落盘 | 定位不同（少而正交），不算差距 |

## 2. G1（必修）：SFTP 会话中途死亡后无自愈

**现状证据**：

- `lib/sftp.js:110-117` `openSftpSession()` 的 `sftp.on('error', …)` 是 **no-op**（只防 uncaught）；
- `lib/runtime.js:268-282` `sftpSession()` 缓存 `rc.sftp`，只在 `catch`（打开失败）时清缓存；
- teardown/shutdown 有 `rc.sftp?.end?.()`（:1024/:1041）——**连接拆除路径已收尾**，缺的是
  **会话中途死亡**：服务端关子系统、`MaxSessions` 被别的客户端占满后打开失败并留下半死状态、
  ssh2 因超时自行关通道 —— 之后每次 `sftpHome/list/upload/download` 都复用这个死引用，
  **错误原样复现**（`NO_CONNECTION`/`CONNECTION_LOST`/`Not connected`），文件面板在整条连接的
  生命周期内全废，用户唯一出路是手动断开重连。

**dsh-web 对照**：连接池 `broken` 标记 + `withClient` 自动重连；`withSftp` 监听频道 `close` 双保险收尾。

**修法（`lib/runtime.js` 一处为主）**：

1. `sftpSession()` 在 `.then` 里给 session 挂死亡监听（channel 是 EventEmitter）：

   ```js
   rc.sftpPromise = openSftpSession(rc.client).then(sftp => {
     sftp.on('close', () => {
       if (rc.sftp === sftp) { rc.sftp = null; rc.sftpPromise = null }
     })
     rc.sftp = sftp
     rc.sftpPromise = null
     return sftp
   }).catch(…)
   ```

2. 失败归类上「通道级死亡」也清缓存：`lib/sftp.js` 导出谓词
   `isSftpTransportFailure(error)`（`NO_CONNECTION`/`CONNECTION_LOST`/`Not connected`/打开类
   `uploadFailureKind==='sftp-session'`），调用方（routes 层或 runtime 包装）catch 到即
   `rc.sftp=null; rc.sftpPromise=null` 并允许**当次请求重开一次**（仅一次，防死循环）。
3. 不改调用面：`sftpSession(rc)` 签名与缓存语义不变，测试替身不受影响。

**测试**：

- 单测（`test/sftp.test.js` 或 `test/runtime.test.js`）：替身 session emit `close` 后
  `rc.sftp` 清空、下一次 `sftpSession()` 重新打开（**当前实现下该用例失败**，符合 TDD 门槛）；
  传输层错误谓词各分支。
- 真协议探针（归档 `_refs/scripts-archive/ssh-g1-probe/`）：真 `ssh2.Server` 上开 SFTP →
  服务端主动关子系统 → 本线再发一次 list 应**自动重开并成功**。

## 3. G2（必修）：慢 viewer 背压从「断开」改为「暂停/恢复」

**现状证据**：`lib/runtime.js:781-787`——`pushTo()` 里 `ws.bufferedAmount > MAX_WS_BUFFERED_BYTES`
（8MiB）即 `unbindShell + close(1011,'viewer-too-slow')`。弱网 / 高延迟 / 笔记本休眠恢复 /
`top` 狂刷场景下，用户终端会反复掉线，且断开后要人手动重开标签。

**dsh-web 对照**：`BACKPRESSURE_HIGH_WATER 1MB / LOW_WATER 512KB`——任一 attached socket
超过高水位 ⇒ `shell.pause()`（**远端 PTY 输出流暂停**，数据不丢）；全部回落到低水位以下 ⇒
`resume()`。断连只是更极端情况的兜底。

**修法**：

1. `ShellChannel` 增 `paused` 状态与 `pauseOutput()/resumeOutput()`（ssh2 channel stream 为
   Duplex，`pause()/resume()` 原生可用；`stream === null` 即 shell 已结束时 no-op）。
2. `pushTo()` 分流（按 shell 判定，保留现有洪泛有界精神）：

   | 条件 | 动作 |
   |---|---|
   | 任一 attached `bufferedAmount > WS_PAUSE_HIGH_WATER`（新常量，建议 2MiB） | `shell.pauseOutput()` + 广播 `{type:'output.paused'}` |
   | 全部 attached 低于 `WS_PAUSE_LOW_WATER`（建议 512KiB） | `shell.resumeOutput()` + 广播 `{type:'output.resumed'}` |
   | 暂停持续超过 `WS_PAUSE_MAX_MS`（建议 30s）仍不 drain，或 bufferedAmount 超 8MiB 兜底 | 维持现有断开逻辑（最终兜底，不删） |

3. 前端（`session.js`/`app.js`）：`onFrame` 收两个新帧，状态栏显示「输出已暂停（对端繁忙）/
   已恢复」；无交互副作用。**旧宿主（新帧不认识）不受影响**——新增帧类型向前兼容。
4. `limits.js` 或 runtime.js 顶部收常量（高/低水位 + 最长暂停），与 `MAX_WS_BUFFERED_BYTES`
   的关系写进注释：兜底断开仍然存在，暂停只是第一道防线。

**测试**：fake stream 记录 `pause/resume` 调用序；水位边界（超暂停 / 部分 drain 不恢复 /
   全 drain 恢复）；暂停超时兜底断开； Ended shell 上调用 no-op。前端契约 1–2 例（帧到达即展示）。

## 4. G3–G5：候选（待拍板，不默认开工）

| # | 项 | 说明 | 倾向 |
|---|---|---|---|
| G3 | 空闲回收 | dsh-web：连接 idle 30min sweep + detached shell 10min reap + exit grace 60s。本线哲学是「连接 host 侧全局持有、断开需确认」，自动回收与它冲突。若做：默认关、可配置、断开前广播征询 | **待拍板**（我倾向不做或仅「无 viewer 超 24h 状态栏提示」） |
| G4 | keyboard-interactive 中途应答 | dsh-web `pendingAuthFinish` 存 session 上、跨 attach socket 应答 2FA。本线连接时一次性认证，重连才有 UI 附着点；PAM 2FA 服务器首次连接时密码走 `tryKeyboard` 已有（2026-09-26 续三）。中途二次提示（如 `sudo` 强制认证）场景罕有 | **低优候选** |
| G5 | exec 截断保真 | `lib/exec.js:63` `cap()` 按 UTF-16 长度切割，未防代理对切割（dsh-web `appendOutput` 有防代理对处理）；`maxOutputBytes` 名实为字符单位。改按字节计或至少切后去尾部孤立代理 | **小改动，可搭车 G1/G2 同批** |
| G6 | ProxyCommand 传输层 | dsh-web 248 行全语义（`%h %p %r %n`、POSIX 进程组 + SIGTERM→SIGKILL、Windows cmd.exe verbatim、clean-EOF 判定）。本线 U3 未含；堡垒机客户端场景（`ssh -W` 之外的私有客户端）够不着 | **U3 补立项候选**，本文不含 |

## 5. 实施顺序与验收

**顺序**：G1 → G2 →（G5 搭车）→ G3/G4/G6 拍板后另立。

**验收判据**（每项都要证据，缺一不可）：

1. 单测：`node --test test/*.test.js` 全绿；例数变化点名（预期 +6～9：G1 3 / G2 4 / G5 1～2），
   `npm run build`（`node --check` 全文件）通过。
2. 静态闸门：`node scripts/verify-all.mjs ssh` 项 PASS（当前基线 31/31）。
3. 真协议探针归档 `_refs/scripts-archive/ssh-g1-g2-probe/`：G1 的「关子系统后自动重开」
   与 G2 的「慢 consumer 下 shell 被 pause 而非连接被断」各一例（真 `ssh2.Server`）。
4. 实机验收项补进[回归矩阵 §3.6](../dsh-miasaki-shared-docs/cross/smoke-test-matrix.md)：
   弱网/大数据量滚动时终端不掉线、文件面板遇服务端关子系统后自愈。
5. **生效条件**：改 `lib/runtime.js`/`lib/sftp.js`/`session.js`/`app.js` ⇒ 必须重启 `dsh web`
   （`index.js` 的 `cachedAsset` 是进程内缓存，浏览器强刷不够）。

**文档同步义务**（实施轮执行）：本线 `README.md` 时间线与「里程碑」表、`design/CHANGELOG.md`
顶部各加一节；若引入新常量，`limits.js` 注释写清与旧常量的关系。

**红线复核**：G1/G2 均不碰系统提示/模型请求/工具 schema；G2 新帧是 host→browser 单向展示帧，
浏览器半无任何上行新权限。
