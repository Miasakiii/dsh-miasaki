// A1 工具面策略（Agent 化规划 §7 的纯函数层：命令分级 L0/L1/L2 + 主机访问判定）。
// 判据只有一处：工具执行体、单测、审批理由文案都从这里取。
//
// 分级口径（§7.2，保守优先）：
//   L2 危险  —— 命中危险模式（rm -rf 带根/通配、dd、mkfs、shutdown、iptables -F、
//               curl|sh、fork bomb、写块设备…）⇒ 需审批 + 理由里显式标注；
//   L1 变更  —— 白名单外的任何写操作/安装/重启 ⇒ 需审批；
//   L0 只读  —— 只读白名单 ⇒ full 主机免审批、readonly 主机允许；
//   **未命中任何表 ⇒ 保守判 L1**（不认识的一律要审批，不猜）。

/** 单次 exec 的输出预算（超出截断并标记 truncated）。 */
export const MAX_STDOUT_BYTES = 32 * 1024
export const MAX_STDERR_BYTES = 8 * 1024
export const MAX_COMMAND_LENGTH = 2000
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000
export const MAX_EXEC_TIMEOUT_MS = 120_000

/** 剥掉已知前缀（sudo / env VAR=… / command / nohup），露出真正的命令头。 */
function stripPrefixes(text) {
  let rest = String(text ?? '').trim()
  for (;;) {
    const m = /^(sudo|command|nohup|env)\s+/.exec(rest)
    if (m === null) break
    rest = rest.slice(m[0].length)
    rest = rest.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '')
  }
  return rest
}

/** L2 危险模式（顺序即优先级）。 */
const L2_PATTERNS = [
  // rm 只在**命令头**是 rm（剥前缀后）且带 r/f flag 时判危
  // （`docker rm -f web` 的 rm 不是命令头 ⇒ 不误伤；`sudo rm -rf` 是 ⇒ 命中）
  { re: /^rm\s+(-\S+\s+)*-\S*[rf]/i, label: 'rm -r/-f', head: true },
  { re: />\s*\/dev\/(sd|vd|hd|nvme)/i, label: '写块设备' },
  { re: /\bdd\s+if=/i, label: 'dd' },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/i, label: 'mkfs' },
  { re: /\b(shutdown|poweroff|halt|reboot|init\s+[06])\b/i, label: '关机/重启' },
  { re: /\biptables\b|\bnft\b|\bfirewall-cmd\b/i, label: '防火墙' },
  { re: /\bchmod\s+(-[a-z]+\s+)*-?R\s+777\b/i, label: '递归 777' },
  { re: /\bchown\s+(-[a-z]+\s+)*-?R\s+root\b/i, label: '递归 chown root' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i, label: '远程脚本直执行' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, label: 'fork 炸弹' },
  { re: /\b(userdel|deluser)\b/i, label: '删用户' },
  { re: /\bkill\s+-9\s+-1\b|\bkillall\b/i, label: '批量杀进程' },
]

/** L0 但带这些参数时是写操作（-i 原地改 / -delete / -exec…）⇒ 落 L1。 */
const L0_WRITE_FLAGS = {
  sed: /\s-i(\s|=)/,
  find: /\s-(delete|exec|execdir|ok|fprint|fprintf)\b/,
}

/** L0 只读白名单（命令 basename 精确命中；参数不再细分——读命令的副作用由 shell 自身决定，
 *  这与 §7.2「白名单免审批」的粒度一致：真正的闸是「陌生命令要审批」）。 */
const L0_COMMANDS = new Set([
  'cat', 'ls', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'find', 'ps', 'top', 'df', 'free',
  'uptime', 'ss', 'netstat', 'wc', 'sort', 'uniq', 'cut', 'awk', 'sed', 'stat', 'file',
  'du', 'id', 'who', 'whoami', 'hostname', 'uname', 'date', 'which', 'whereis', 'env',
  'printenv', 'dmesg', 'lscpu', 'lsblk', 'lsusb', 'mount', 'dpkg', 'rpm', 'systemctl',
  'journalctl', 'docker', 'kubectl', 'helm', 'git', 'curl', 'wget', 'ping', 'traceroute',
  'dig', 'nslookup', 'ip', 'ifconfig', 'route', 'arp', 'nproc', 'vmstat', 'iostat',
])

/** L0 但子命令必须是只读形态的（systemctl status / docker ps / kubectl get / git status…）。 */
const L0_SUBCOMMANDS = {
  systemctl: ['status', 'list-units', 'list-unit-files', 'is-active', 'is-enabled', 'show'],
  journalctl: [], // journalctl 本身只读
  service: ['status'],
  docker: ['ps', 'logs', 'images', 'inspect', 'stats', 'top', 'version', 'info', 'network ls', 'volume ls'],
  kubectl: ['get', 'describe', 'logs', 'top', 'explain', 'version'],
  helm: ['list', 'status', 'history', 'get', 'search', 'version'],
  git: ['status', 'log', 'diff', 'show', 'branch', 'remote', 'tag', 'blame', 'grep'],
  ip: ['addr', 'a', 'route', 'r', 'link', 'neigh', '-s', 'rule'],
  dpkg: ['-l', '--list', '-s', '--status', '-L', '--listfiles'],
  rpm: ['-q', '--query', '-qa', '-V'],
}

/** 取命令的首个 token（去路径、去引号），空命令返回 ''。 */
export function commandHead(command) {
  const text = String(command ?? '').trim()
  if (text.length === 0) return ''
  const first = text.split(/\s+/)[0] ?? ''
  return first.replace(/^['"]|['"]$/g, '').split('/').pop() ?? ''
}

/**
 * 命令分级。
 * @returns {{ riskLevel: 'L0'|'L1'|'L2', reason: string }}
 */
export function classifyCommand(command) {
  const text = String(command ?? '').trim()
  if (text.length === 0) return { riskLevel: 'L1', reason: '空命令' }
  if (text.length > MAX_COMMAND_LENGTH) return { riskLevel: 'L1', reason: '命令过长' }
  const stripped = stripPrefixes(text)
  for (const pattern of L2_PATTERNS) {
    // head:true 的模式在剥前缀后的命令头上判定（rm 专属）
    if (pattern.re.test(pattern.head === true ? stripped : text)) return { riskLevel: 'L2', reason: `命中危险模式：${pattern.label}` }
  }
  const head = commandHead(text)
  if (L0_COMMANDS.has(head)) {
    // 白名单命令带写 flag（sed -i / find -delete…）⇒ L1：白名单免审只覆盖真只读形态
    const writeFlag = L0_WRITE_FLAGS[head]
    if (writeFlag !== undefined && writeFlag.test(text)) {
      return { riskLevel: 'L1', reason: `${head} 带写参数，按变更处理` }
    }
    const subs = L0_SUBCOMMANDS[head]
    if (subs === undefined || subs.length === 0) return { riskLevel: 'L0', reason: `只读命令 ${head}` }
    const rest = text.slice(text.indexOf(head) + head.length).trim()
    const firstArg = rest.split(/\s+/)[0] ?? ''
    if (subs.includes(firstArg)) return { riskLevel: 'L0', reason: `只读命令 ${head} ${firstArg}` }
    return { riskLevel: 'L1', reason: `${head} 的 "${firstArg || '（无子命令）'}" 不是只读形态` }
  }
  // 白名单外：保守 L1（不猜）
  return { riskLevel: 'L1', reason: `未识别的命令 ${head || '（解析失败）'}，按变更处理` }
}

/**
 * 主机访问判定（§7.1）。
 * @returns {{ allowed: true } | { allowed: false, code: string, message: string }}
 */
export function decideAccess(record) {
  const access = record?.agentAccess ?? 'none'
  if (!['none', 'readonly', 'full'].includes(access)) {
    return { allowed: false, code: 'ACCESS_DENIED', message: `未知的 Agent 访问档位：${access}` }
  }
  if (access === 'none') {
    return { allowed: false, code: 'ACCESS_DENIED', message: '该主机未对 Agent 开放：可在编辑主机里把「Agent 访问」改成只读或完整' }
  }
  return { allowed: true }
}

/**
 * 分级 × 档位的硬闸（§7.1）：readonly 主机只放行 L0，L1/L2 **连审批机会都不给**
 * —— 这才叫只读。full 档的 L1/L2 走审批（needsApproval）。
 */
export function decideRisk(record, riskLevel) {
  const access = record?.agentAccess ?? 'none'
  if (access === 'readonly' && riskLevel !== 'L0') {
    return { allowed: false, code: 'ACCESS_DENIED', message: `该主机对 Agent 只读：不允许执行 ${riskLevel} 命令（只有只读命令放行）` }
  }
  return { allowed: true }
}

/** 该档位 + 该分级是否需要审批（L0 永远免审批；readonly 主机根本到不了 L1/L2）。 */
export function needsApproval(record, riskLevel) {
  const access = record?.agentAccess ?? 'none'
  return access === 'full' && riskLevel !== 'L0'
}

/** 供审批理由与审计的人类可读摘要（绝不包含任何秘密——命令本身不是秘密）。 */
export function describeCommand(record, command, riskLevel) {
  return `[${riskLevel}] ${record?.label ?? record?.host ?? '?'}（${record?.username ?? '?'}@${record?.host ?? '?'}:${record?.port ?? 22}）：${String(command ?? '').slice(0, 200)}`
}
