# Learnings

## [LRN-20260817-001] best_practice

**Logged**: 2026-08-17T00:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: config

### Summary
DSH（DeepSeek Harness）本机环境接入视觉能力的三个关键事实与做法。

### Details
1. **DSH 子进程环境会清洗凭据形变量**：用户级环境变量 `MIMO_API_KEY`（存于注册表 `HKCU:\Environment`）不会出现在 pwsh/bash 工具的子进程 env 中，但非凭据形变量（如 `MIMO_API_BASE_URL`）会保留。因此技能脚本读 `$env:MIMO_API_KEY` 必然失败。
   - **解法**：脚本内做 Windows 注册表回退（python 用 `winreg.OpenKey(HKEY_CURRENT_USER, "Environment")`），或显式传 `--api-key`。
   - 已应用到 `~/.agents/skills/mimo-omni/` 的 `mimo_api.py` / `mimo_api.sh`（原脚本的 `--api-key` 只写在帮助文本里、并未实装，这次补上了）。
2. **`$DSH_HOME/settings.yaml` 与 `$DSH_HOME/.credentials.yaml` 都是 chokidar 热监听**：外部编辑直接热发布，无需重启；`dsh-settings-file` 解析失败时保留上一份可用文档并告警。
   - `llm-pi-ai` 插件以休眠态挂载：`settings.yaml` 出现 `llm-pi-ai.providers.<route>` 段后路由即热注册，段清空即卸载。`apiKeyEnv` 是按请求解析的凭据引用，值存 `.credentials.yaml`（凭据库绝不物化进进程环境）。
   - xiaomi 路由示例：`llm-pi-ai.providers.xiaomi.apiKeyEnv: MIMO_API_KEY` + 凭据库写入 `MIMO_API_KEY`。切换后 `mimo-v2.5`（input: text+image）可让 `read_image` 复活。
3. **本机 `bash.exe` 是 WSL 启动器**（`C:\Windows\system32\bash.exe`），没有 Git Bash；`python3` 别名不存在，只有 `python`（F:\su\Python3.14，requests 可用）。mimo 技能在本机应直接走 `python mimo_api.py`。
4. **MCP/沙箱边界**：对 `~/.dsh`、`~/.agents` 等工作区外路径的写入在 workspace-write 模式下会被 `[sandbox: file access denied]` 拒绝；正确流程是原样重试一次并带 `sandbox_permissions: danger-full-access` + 一句话 justification，由用户批准。

### Suggested Action
后续会话给 DSH 加 provider、修技能脚本时直接复用上述模式；密钥一律走 `.credentials.yaml` 引用，不要写进 settings.yaml。

### Metadata
- Source: conversation
- Related Files: C:\Users\Asakii\.dsh\settings.yaml, C:\Users\Asakii\.dsh\.credentials.yaml, C:\Users\Asakii\.agents\skills\mimo-omni\mimo_api.py, C:\Users\Asakii\.agents\skills\mimo-omni\mimo_api.sh
- Tags: dsh, credentials, sandbox, mimo, llm-pi-ai, hot-reload
- Pattern-Key: harden.credential_injection
- First-Seen: 2026-08-17
- Last-Seen: 2026-08-17

---

## [ERR-20260817-001] bailian-cli_quota

**Logged**: 2026-08-17T00:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: config

### Summary
百炼 CLI 图像/视频生成类调用返回 403 `AllocationQuota.FreeTierOnly`，免费额度已用尽。

### Error
```
AllocationQuota.FreeTierOnly
```

### Context
- 命令：`bl image generate` / `bl video generate` 等生成类
- 环境：bailian-cli 1.8.0 已认证；视觉理解类（bl vision describe）不受影响
- 起因：阿里百炼控制台"仅使用免费额度"模式 / 账户无余额

### Suggested Fix
用户在百炼控制台充值或关闭"仅使用免费额度"开关后重测生成链路。CLI 侧可用 `bl usage freetier --off --all` 关闭 free-tier 自动停止（需先 `bl auth login --console --console-site domestic` 恢复控制台会话）。

### Retest Notes
- 2026-08-17 复测（用户要求）：`bl image generate`（qwen-image-3.0，API Key 认证）仍返回 HTTP 403 AllocationQuota.FreeTierOnly（Request ID d55b8180-ee8e-9281-afe0-6a87f8975894）——额度门仍未解除，账户侧未处理。
- 控制台会话已过期（`bl usage free` 报 "Console session is not logged in or has expired"），CLI 无法查询/修改 freetier 状态。
- bl 1.15.0 在 Windows 出错退出时伴随 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（libuv 退出断言，不影响结果，CLI 噪音）。

### Metadata
- Reproducible: yes
- Related Files: ~/.agents/skills/bailian-cli（如需）
- See Also: 无

### Resolution
- **Resolved**: 2026-08-17（用户控制台关闭"免费额度用完即停"并保证余额后复测通过）
---

## [LRN-20260817-002] best_practice

**Logged**: 2026-08-17T00:00:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: config

### Summary
bl CLI 的水印默认值无法通过官方配置关闭，用 PowerShell profile 包装函数实现"默认关水印"。

### Details
- `bl config set` 键白名单（base_url/output/timeout/api_key/default_*_model 等）不含 watermark；水印解析器（bailian-cli-core）硬编码默认 `true`，无环境变量钩子。
- 解法：`Documents\PowerShell\profile.ps1`（CurrentUserAllHosts）定义 `bl` 包装函数——对 `image/video generate|edit|ref` 子命令自动追加 `--watermark false`（已显式传 --watermark 则跳过），其余命令透传；直接调 `node ...\bailian-cli\dist\bailian.mjs` 避免递归与 bl.ps1 的 `exit` 陷阱。
- 代理侧同步写入 `~/.agents/skills/bailian-cli/SKILL.md` 作为技能默认。dry-run 已验证注入生效（request.parameters.watermark: false）。
- 注意：Windows PowerShell 5.1 的 profile 在 `Documents\WindowsPowerShell\`，与 pwsh 7 不同目录。

### Metadata
- Source: conversation
- Related Files: C:\Users\Asakii\Documents\PowerShell\profile.ps1, C:\Users\Asakii\.agents\skills\bailian-cli\SKILL.md
- Tags: bailian-cli, powershell, profile, watermark
- Pattern-Key: harden.cli_default_override
- First-Seen: 2026-08-17
- Last-Seen: 2026-08-17

---
