# CLI 校准批次报告

- 日期：2026-08-17
- 方法：对扫描器发现的 8 个 agent CLI 逐一做最小派单探测（"Reply with exactly: PONG" 或 --help），记录派单可用性、鉴权/权限要求与计量来源
- 探测环境：沙箱内（workspace-write）优先，被 EPERM 拦后按规则升级 full-access

## 校准总表

| CLI | 探测结果 | 派单可用性 | 权限要求 | 计量 | 备注 |
|---|---|---|---|---|---|
| claude 2.1.233 | ✅ t-0006 完整闭环（21 回合） | **可用** | 无需升级（cwd=workspace 读文件可行；写权限被自身拒绝→交付物代写） | json-cost-usd 已实现 | 成本 $0.414/cache-read 608K 实测 |
| bl 1.16.0 | ✅ t-0005 完整闭环 | **可用** | 无需升级；用量类命令需 console 会话（已登录） | console-usage | blocked→reopen→done 首次真实走通 |
| opencode 1.18.18 | ✅ PONG | **可用** | 需 full-access（写 ~/.local/share/opencode 日志） | unknown（待查 --format json） | 默认模型 deepseek-v4-flash |
| pi 0.84.1 | ✅ PONG | **可用** | 需 full-access（写 ~/.pi 配置） | unknown（--mode json 待测） | pi -p 非交互模式 |
| gemini 0.55.1 | ⚠️ 启动成功、鉴权通过、模型 403 | **半可用** | 需 full-access（自重启 spawn） | unknown | 默认 gemini-3.5-flash 区域受限，需换模型 |
| dsh 0.1.0-rc.6 | ⏳ 未派单 | 待建 headless profile | 本机 profile 目录只有 web | session | M3.5 剩余项 |
| mimo 0.1.12 | ⚠️ 位置参数被当作目录 | **语法待校准** | 未定 | unknown | 需 mimo --help 确认正确调用形式 |
| agent-browser 0.34.0 | ⏳ 未派单 | 命令型 CLI（非 prompt 型） | 未定 | unknown | 任务需映射到具体命令（skills get core 起步） |

## 关键结论

1. **4/8 立即可用**（claude / bl / opencode / pi），1 个半可用（gemini，模型区域受限），3 个待补（dsh profile / mimo 语法 / agent-browser 任务映射）；
2. **权限模式清晰**：npm 类 CLI（opencode/pi/gemini）写自身配置目录 → 派单需 full-access；原生 exe（claude）与纯网络读（bl）沙箱内即可——已写入各档案 `preflight` 字段，派单器会自动提示；
3. **技能字段已补齐**（8 档案），§6.2 技能匹配可用；
4. gemini 的 skill 目录冲突警告（~/.agents/skills vs ~/.gemini/skills 各有一份 bailian 家族）是用户机器的环境事实，与派单无关但值得留意。

## 落盘

- 各档案 preflight/skills 已由扫描器刷新（`agents/<id>/manifest.json`）；
- 校准探测原始输出：`agents/<id>/logs/`（部分为终端直捕，未单独落盘）。
