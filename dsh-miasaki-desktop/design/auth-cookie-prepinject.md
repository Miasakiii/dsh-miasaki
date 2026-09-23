# 鉴权 cookie 预置注入 设计（401 恢复链失效修复）

> 状态：**设计定稿（2026-09-22），待实施**。用户反馈（2026-09-22）：「启动后总出错，
> 要点一下刷新才能正常使用」——错误长相经确认为**「浏览器样式的页面」**：深色 App 窗口里
> 一行裸露的英文纯文本页。
> 本设计顺带完成 TODO P1 遗留项 **「鉴权 secret 动态化」**（同一链路，合并落地）。

## 1. 根因链（实测证据，2026-09-22）

1. **401 必然发生**：桌面壳每次拉起**新的** `dsh web` 进程 ⇒ dsh 鉴权 = 进程级 launchToken 换
   **secret 签名 cookie**（`dsh-auth-*`）。WebView2 里只有上一进程的旧 cookie ⇒ 首次
   `GET /` 401。实测复现（无 cookie 请求本机 3080）：

   ```
   STATUS: 401 Unauthorized
   ContentType: text/plain; charset=utf-8
   Body: dsh web authentication required; reopen the URL printed by dsh web.
   ```

2. **9-05 的恢复链失效**（`themes/src/00-boot.js`「401 检测 → location.reload()」）：事后自愈
   依赖「进错误页后再爬出来」，当前失效原因与两个脆弱点：
   - 401 是 **`text/plain` 纯文本文档**，`document.body` / `innerText` 的解析形态与 HTML 页
     不同，检测文本取不取得到无保证；
   - 只检查两次（document_start 立即 + 400ms），漏检即永久停在错误页。
3. **刷新即好**：`00-boot.js` 的 cookie 注入逻辑仍在、硬编码 secret 与
   `~/.dsh/.credentials.yaml` 实测一致（`2h4nw6D…ETas`）⇒ 手动刷新时 cookie 已签好，第二次
   `GET /` 直接 200。

**结论**：恢复链治「401 之后」，正确解是**让 401 不发生**——把 cookie 签名与写入
**提前到 navigate 之前**。

## 2. 设计

### 2.1 总览（三步替代两步）

```
现状：  loading → [探活→拉起 dsh] → navigate(/)  ← 401 发生在这里（无新 cookie）
                        ↓ 00-boot.js 检测 401 页面 → reload（脆弱，时好时坏）

改后：  loading → [探活→拉起 dsh] 并行: JS 签名 cookie → invoke(set_auth_cookie) → Rust 写 WebView2 cookie jar
        → [navigate 前: 等 cookie 置位 ≤3s，超时放行] → navigate(/)  ← 首次即带有效 cookie
        → 兜底: 00-boot.js 维持「401 检测→reload」但加固（文本兜底 + 四轮 + 文案加宽）
```

### 2.2 Rust 侧（`src-tauri/src/main.rs`）

新增两个 invoke 命令（loading.html 是本地页 `WebviewUrl::App`，**无需新增 ACL**）：

| 命令 | 入参 | 行为 |
|---|---|---|
| `auth_secret` | — | 读 `~/.dsh/.credentials.yaml`，手写行解析取 `client-connection/browser-session:` 段下 `secret:` 值；**解析失败 / 文件缺失 / 值不合法 → 返回 null**（调用方回落硬编码，fail-open，永不因此阻断启动） |
| `set_auth_cookie` | `{ name, value }` | 用 Tauri 2 cookie API（`webview.cookies()` → `cookies.set(...)`，`url: http://127.0.0.1:3080`、`Path=/`、`Max-Age=2592000`、`SameSite=Strict`）写入；成功置 `AUTH_COOKIE_READY: AtomicBool = true`；失败仅记 pet.log，不阻断 |

- **yaml 解析为手写行扫描**（零 crate 依赖守则：扫 `client-connection/browser-session:`
  前缀行 → 后续缩进行找 `secret: <b64url>` → 简单字符集校验 `^[A-Za-z0-9_-]+$`）；
  失败即 null。**解析收益**：secret 轮换后无需改源码重编译（TODO P1 待办的原始诉求）；
- **navigate 前等待**：`start_launch_sequence` 的 `port_ready()` 分支里 `navigate(url)` 之前，
  轮询 `AUTH_COOKIE_READY`（50ms 间隔，**上限 3s**）；超时未就绪 → 照常 navigate（兜底链接管，
  行为与今天一致 ⇒ 最坏情况不劣化）；
- cookie 的 name/value **完全由页面 JS 计算**（算法与 `00-boot.js` 逐位一致：
  `name = 'dsh-auth-' + b64url(sha256("127.0.0.1:3080"))`，
  `value = 'v1.' + b64url(payloadJson) + '.' + b64url(hmacSig)`），Rust 不实现任何签名算法
  （**零新 crate、零 FFI**）。

### 2.3 loading 页侧（`ui/loading.html`）

```
DOMContentLoaded:
  → invoke('auth_secret') → secret ?? 硬编码 SECRET_B64
  → Web Crypto 签 cookie（逻辑从 00-boot.js 原样搬来，同一份常量）
  → invoke('set_auth_cookie', { name, value })
  →（失败/异常：静默；Rust 3s 超时放行 + 页面兜底链接管）
```

- 与 Rust 的探活/拉起**并行**（不串行化启动路径，冷启动通常秒级完成签名）；
- 失败一律静默（不弹错误、不阻塞）；loading 页已有 `if (window.__TAURI__…)` invoke 包装可复用。

### 2.4 兜底链加固（`themes/src/00-boot.js`，经 build-init 重生成 injected）

- 检测文本兜底链：`document.body?.innerText` → `document.body?.textContent` →
  `document.documentElement.textContent`（覆盖 text/plain 文档形态）；
- 检查四轮：立即 / 100ms / 400ms / 1200ms（漏检即永久失败是现状最大痛点）；
- 文案匹配加宽：`authentication required` **或** `dsh web authentication`（dsh 换措辞时不至于
  静默失效）；
- 预置成功时此链自然不触发（页面已是 200 正常页，纯兜底）。**双写幂等**：00-boot.js 在 3080
  文档里仍会签同一份 cookie（值相同，重复写无害），不为省这一次写引入跨文档状态标记（过度设计）。

## 3. 失败与边界

| 场景 | 行为 |
|---|---|
| crypto.subtle 不可用（旧 WebView2） | JS 签失败静默 → Rust 3s 超时放行 → 00-boot.js 兜底链（今天的行为，不劣化） |
| `credentials.yaml` 缺失 / 损坏 / secret 不合字符集 | `auth_secret` 返 null → 回落硬编码 secret（与今天一致） |
| 硬编码 secret 也过期（credentials 轮换过） | 仍 401 → 兜底链兜底；至少动态读取路径让「轮换后必须改源码」成为历史 |
| dsh 已在运行（热启动，port 早已就绪） | 正常走预置流程；签名通常 100ms 级，3s 窗口充裕 |
| cookie API 写入失败 | 仅 pet.log 记一条；超时放行 + 兜底链 |
| dsh 未安装 / spawn 失败 | 与本设计正交（loading 失败卡片照旧） |

## 4. 触摸点与落地

- `ui/loading.html`（签名 + 两个 invoke 调用）；
- `src-tauri/src/main.rs`（`auth_secret` / `set_auth_cookie` 命令、`AUTH_COOKIE_READY` 原子位、
  navigate 前等待/超时、cookie 写入）；
- `themes/src/00-boot.js`（兜底加固三件）→ `npm run gen-init` 重生成 `src-tauri/injected/theme-init.js`；
- `design/TODO.md`（P1「鉴权 secret 动态化」条目收敛至本设计）；
- `README.md`、`design/CHANGELOG.md`；
- **落地流程同 9-05 修复**：`cargo build --release` 后用 `target/release/miasaki.exe` 替换
  `dist/Miasaki.exe`（用户快捷方式目标）。纯静态回归不覆盖启动鉴权链，验收为实机项。

## 5. 验收标准

1. **冷启动 401 消失**：先结束 dsh web → 双击启动，**连续 5 次**主窗口直达 DSH 会话页，
   无纯文本错误页、无刷新操作；
2. **secret 动态化生效**：改 `~/.dsh/.credentials.yaml` 的 secret 值 → 重启启动 → 仍免 401
   （证明读的是文件不是硬编码）；
3. **fail-open 不劣化**：模拟 `auth_secret` 返 null（临时改名 credentials.yaml）→ 启动正常性
   与今天一致（硬编码兜底）；
4. **兜底链仍工作**：临时注掉预置（模拟预置失败）→ navigate 前 3s 超时放行 → 若出现 401，
   00-boot.js 加固链应在 ≤1.2s 内自恢复，不出现「停住不动」；
5. **回归**：smoke-test.ps1 §0b 三用例通过；正常启动路径功能不变；
   `node ../scripts/verify-all.mjs desktop` 全过。
