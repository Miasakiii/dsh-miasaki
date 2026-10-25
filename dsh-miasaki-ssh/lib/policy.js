// A1 工具面策略（Agent 化规划 §7 的纯函数层：命令分级 L0/L1/L2 + 主机访问判定）。
// 判据只有一处：工具执行体、单测、审批理由文案都从这里取。
//
// 2026-10-20（monkeyscan 0a186 修复）：补齐设计 §7.2 承诺的**逐段分析**（`;` / `&&` / `||` /
// `|` / 换行）、L0 判定前先剥 sudo/env/command/nohup 前缀、输出重定向按写入、解释器类
// （awk/sed）与写文件/上传参数（git branch|tag、curl|wget）收紧。**分级仍是保守启发式**
// （设计 J4 明说命令文本分级不是安全边界）：这里只负责把明显的写/执行形态从「免审批的
// 只读」里剔出去，不承诺拦住所有混淆写法（base64、变量拼接等仍可能绕过）。
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

/** 剥掉已知前缀（sudo / env VAR=… / command / nohup），露出真正的命令头。
 *  返回 { text, elevated }：elevated=true 表示链里出现过 sudo（提权执行 ⇒ 至少按变更处理）。 */
function stripPrefixes(text) {
  let rest = String(text ?? '').trim()
  let elevated = false
  for (;;) {
    const m = /^(sudo|command|nohup|env)\s+/.exec(rest)
    if (m === null) break
    if (m[1] === 'sudo') elevated = true
    rest = rest.slice(m[0].length)
    rest = rest.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '')
  }
  return { text: rest, elevated }
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

/** L0 但带这些参数时是写操作（-i 原地改 / -delete / -exec…）⇒ 落 L1。
 *  `-i` 允许贴值/贴空串（`-i.bak` / `-i''`，macOS 常用），`--in-place` 同义。 */
const L0_WRITE_FLAGS = {
  sed: /(^|\s)(-i\S*|--in-place)(\s|$)/,
  find: /\s-(delete|exec|execdir|ok|fprint|fprintf)\b/,
}

/** L0 只读白名单（命令 basename 精确命中）。参数不再「一律不细分」：解释器类
 *  （awk/sed）、`git branch/tag`、`curl/wget` 与输出重定向在下面单独收紧——
 *  白名单免审只覆盖**真只读形态**，写/执行形态一律回 L1/L2。
 *  2026-10-20：`env` 已移出白名单（`env <任意命令>` 等价于任意命令执行；剥前缀后
 *  真正的命令头会照常参与判定）。 */
const L0_COMMANDS = new Set([
  'cat', 'ls', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'find', 'ps', 'top', 'df', 'free',
  'uptime', 'ss', 'netstat', 'wc', 'sort', 'uniq', 'cut', 'awk', 'sed', 'stat', 'file',
  'du', 'id', 'who', 'whoami', 'hostname', 'uname', 'date', 'which', 'whereis',
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

/** `git branch/tag` 的破坏性参数（写操作 ⇒ L1；列表形态 `-a/-v/--show-current` 不受影响）。
 *  短选项允许贴值（`-dfoo` / `-Dmain`），长选项单列。 */
const GIT_DESTRUCTIVE_FLAGS = /(^|\s)(-[dDmMf][A-Za-z0-9_-]*|--delete|--force|--move)(\s|$)/

/** `curl` 的写文件 / 上传 / 发数据参数（⇒ L1；短选项允许贴值，如 `-o/tmp/x`）。 */
const CURL_WRITE_FLAGS = /(^|\s)(-[oOtTFDdc]\S*|--output\S*|--upload-file\S*|--post-file\S*|--data(?:-raw|-binary|-urlencode)?\S*|--form\S*)(\s|$)/

/**
 * 其余 L0 命令里**会改变系统状态**的参数形态（⇒ L1）。白名单里不少命令同时有
 * 「读」与「改」两种用法（`ifconfig -a` 读 / `ifconfig eth0 1.2.3.4` 改），
 * 这里把已知的「改」形态挑出来——仍属保守启发式，未列举的写法仍可能漏判。
 * 规则作用于命令头之后的 `rest`（不含命令名本身）。
 */
const L0_MUTATE_FLAGS = {
  sort: /(^|\s)-o\S*(\s|$)/, // sort -o 文件
  date: /(^|\s)(-s|--set)(\s|=|$)/, // 改系统时间
  hostname: /(^|\s)[^-]\S*/, // hostname 带位置参数 = 改主机名；纯选项（-f/-s/-I）是读
  ifconfig: /(^|\s)(up|down|add|del|delete|netmask|hw|mtu|address|broadcast|pointopoint)(\s|$)|(^|\s)(?!-)\S+(\s+(?!-)\S+)+/,
  ip: /(^|\s)(add|del|delete|flush|change|replace|set|append|prepend|up|down)(\s|$)/,
  route: /(^|\s)(add|del|delete|flush)(\s|$)/,
  arp: /(^|\s)(-s|-d|--set|--delete)(\s|$)/,
  mount: /(^|\s)\S*\/\S*(\s|$)/, // 带路径操作数 ⇒ 是挂载（mount 裸命令 / -l 是列挂载表）
  journalctl: /(^|\s)(--vacuum\S*|--rotate)(\s|=|$)/, // 清/轮转日志
}

/** `awk` 脚本里能派生进程 / 写文件 / 读额外输入的形态（解释器类命令 ⇒ L2）。 */
const AWK_DANGER = [
  { re: /\bsystem\s*\(/, reason: 'awk 的 system() 会执行任意命令' },
  { re: /\bgetline\b/, reason: 'awk 的 getline 会读额外输入' },
  { re: /\|/, reason: 'awk 的管道会派生进程' },
  { re: />/, reason: 'awk 的重定向/比较会写文件或读上下文之外的内容' },
]

/** `sed` 的 e/w/r 命令与 `s///` 的 e/w flag（解释器类命令 ⇒ L2）。 */
const SED_DANGER = [
  { re: /(^|[;{}\s'"])([0-9,$!]*)[ewrW](\s|$|[;)])/, reason: 'sed 的 e/w/r 命令会执行命令或写文件' },
  { re: /\bs(.).*?\1.*?\1[0-9gpIMm]*[ewW]\b/, reason: 'sed 的 s///e（执行）或 w（写文件）flag' },
]

/** 风险序：逐段分析时整体取最高。 */
const RISK_ORDER = { L0: 0, L1: 1, L2: 2 }

/**
 * 逐段切分（设计 §7.2「管道与复合命令逐段分析」）：`;`、`&&`、`||`、`|`、换行。
 * 保守实现：不识别引号/转义（引号内的分隔符也照切——切碎只会让判定更严，不会更松）。
 * 残余：单个 `&`（后台执行）不是分隔符，`cmd & other` 仍按一段判（见 design/CHANGELOG）。
 */
function splitSegments(text) {
  return String(text ?? '')
    .split(/\s*(?:\|\||&&|;|\||\n)\s*/)
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

/**
 * 该段是否有**写文件**的输出重定向：`>` / `>>` 后面跟目标。
 * 先剥掉文件描述符复制（`2>&1` / `>&2`——它们不写文件），`> /dev/sd*` 由 L2 模式先拦。
 * 排除 `->` / `=>`（引号里搜代码时的箭头不是重定向）——保守实现，宁可漏判成 L1 也不误杀。
 */
function hasFileRedirect(segment) {
  const probe = String(segment).replace(/\d*>&\d+/g, ' ')
  return /(?:&>>?|(?<![-&=>])>>?)\s*[^&\s|;]+/.test(probe)
}

/** 白名单命令的形态校验：真只读 ⇒ L0；写/执行/提权形态 ⇒ L1/L2。 */
function classifyReadOnlyShape(head, raw, text) {
  if (head === 'awk') {
    for (const rule of AWK_DANGER) {
      if (rule.re.test(raw)) return { riskLevel: 'L2', reason: rule.reason }
    }
  }
  if (head === 'sed') {
    for (const rule of SED_DANGER) {
      if (rule.re.test(raw)) return { riskLevel: 'L2', reason: rule.reason }
    }
  }
  // 白名单命令带写 flag（sed -i / find -delete…）⇒ L1：白名单免审只覆盖真只读形态
  const writeFlag = L0_WRITE_FLAGS[head]
  if (writeFlag !== undefined && writeFlag.test(raw)) {
    return { riskLevel: 'L1', reason: `${head} 带写参数，按变更处理` }
  }
  const rest = text.slice(text.indexOf(head) + head.length).trim()
  const firstArg = rest.split(/\s+/)[0] ?? ''
  // 白名单里「读/改两用」命令的已知识别形态（ifconfig/ip/route/mount/date/hostname/sort…）⇒ L1
  const mutate = L0_MUTATE_FLAGS[head]
  if (mutate !== undefined && mutate.test(rest)) {
    return { riskLevel: 'L1', reason: `${head} 带变更参数，按变更处理` }
  }
  // git branch/tag 的破坏性参数、curl/wget 的写文件/上传参数 ⇒ L1
  if (head === 'git' && (firstArg === 'branch' || firstArg === 'tag') && GIT_DESTRUCTIVE_FLAGS.test(rest)) {
    return { riskLevel: 'L1', reason: `git ${firstArg} 带破坏性参数，按变更处理` }
  }
  if (head === 'curl' && CURL_WRITE_FLAGS.test(raw)) {
    return { riskLevel: 'L1', reason: 'curl 带写文件/上传/发数据参数，按变更处理' }
  }
  // wget 默认就落盘（与 curl 不同）：只有只读探活（--spider）或显式输出到 stdout
  // （`-O-` / `-O -` / `--output-document=-`，含 `-qO-` 这类合并短选项）才算真只读。
  if (head === 'wget') {
    const spider = /(^|\s)--spider(\s|$)/.test(raw)
    const toStdout = /(^|\s)--output-document(?:=|\s+)-(?=\s|$)/.test(raw)
      || /(^|\s)-[A-Za-z]*O-(?=\s|$)/.test(raw)
      || /(^|\s)-[A-Za-z]*O\s+-(?=\s|$)/.test(raw)
    if (spider !== true && toStdout !== true) {
      return { riskLevel: 'L1', reason: 'wget 默认落盘写文件，按变更处理' }
    }
  }
  const subs = L0_SUBCOMMANDS[head]
  if (subs === undefined || subs.length === 0) return { riskLevel: 'L0', reason: `只读命令 ${head}` }
  if (subs.includes(firstArg)) return { riskLevel: 'L0', reason: `只读命令 ${head} ${firstArg}` }
  return { riskLevel: 'L1', reason: `${head} 的 "${firstArg || '（无子命令）'}" 不是只读形态` }
}

/** 单段分级；空段返回 null（忽略）。 */
function classifySegment(segment) {
  const raw = String(segment ?? '').trim()
  if (raw.length === 0) return null
  const stripped = stripPrefixes(raw)
  if (stripped.text.length === 0) return { riskLevel: 'L1', reason: '只有命令前缀、没有实际命令' }
  // 段内再扫一遍 L2：整串可能因分段把危险模式切到后续段（如 `ls && rm -rf /`）
  for (const pattern of L2_PATTERNS) {
    if (pattern.re.test(pattern.head === true ? stripped.text : raw)) {
      return { riskLevel: 'L2', reason: `命中危险模式：${pattern.label}` }
    }
  }
  const head = commandHead(stripped.text)
  let result = L0_COMMANDS.has(head)
    ? classifyReadOnlyShape(head, raw, stripped.text)
    : { riskLevel: 'L1', reason: `未识别的命令 ${head || '（解析失败）'}，按变更处理` }
  // 输出重定向 = 写目标（§7.2 的 L1「写文件」）：只提升真只读形态
  if (result.riskLevel === 'L0' && hasFileRedirect(raw)) {
    result = { riskLevel: 'L1', reason: `${head} 带输出重定向，按写入处理` }
  }
  // sudo 提权：即便命令本身只读也按变更处理（不把「以 root 读」当免审批）
  if (result.riskLevel === 'L0' && stripped.elevated) {
    result = { riskLevel: 'L1', reason: `${head} 经 sudo 提权执行，按变更处理` }
  }
  return result
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
  // 整串 L2 优先：有些模式跨段才成立（`curl … | sh`），先分段会把它切开
  const whole = stripPrefixes(text)
  for (const pattern of L2_PATTERNS) {
    // head:true 的模式在剥前缀后的命令头上判定（rm 专属）
    if (pattern.re.test(pattern.head === true ? whole.text : text)) return { riskLevel: 'L2', reason: `命中危险模式：${pattern.label}` }
  }
  // 逐段分析（设计 §7.2）：各段独立分类，整体取最高风险（段间不互相洗白）
  let best = null
  for (const segment of splitSegments(text)) {
    const result = classifySegment(segment)
    if (result === null) continue
    if (best === null || RISK_ORDER[result.riskLevel] > RISK_ORDER[best.riskLevel]) best = result
  }
  return best ?? { riskLevel: 'L1', reason: '无法解析的命令，按变更处理' }
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
