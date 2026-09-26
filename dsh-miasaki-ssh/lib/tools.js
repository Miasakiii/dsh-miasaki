// A1 工具面 v1（Agent 化规划 §6/§7 定稿的设计落地；D2 总开关默认 off）。
// 三个工具，少而正交：
//   ssh_hosts        { filter? }                      只读 · 免审批 —— 让模型知道手在哪，杜绝主机幻觉
//   ssh_exec         { hostId, command, cwd?, timeoutMs? } 分级 L0/L1/L2 —— 核心能力
//   ssh_session_read { hostId, lines? }                只读 · 免审批 —— 读人正在用的终端回放
//
// 治理口径（规划 §7）：
//   * riskLevel 由服务端 classifyCommand 填，**不接受模型传入**；
//   * 审批走 ctx.userQuestions.ask()（SPIKE S3：官方 approval seam 当前 unavailable ⇒
//     失败关闭；方案 B 留给 seam 修复后升级）。四态：allowed-once / rejected /
//     cancelled / unavailable —— 后三种都返回结构化结果，**不抛异常、不中止轮次**；
//   * 连接只对 key/agent 认证且 agentAccess≠none 的主机隐式建立；password 主机
//     返回 NOT_CONNECTED（「不把发起认证暴露成模型可调用的能力」）；
//   * 每次决策进审计环（lib/audit.js，内存不落盘）。
import { execCommand } from './exec.js'
import { classifyCommand, decideAccess, decideRisk, needsApproval, describeCommand, DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS, MAX_COMMAND_LENGTH, MAX_STDOUT_BYTES, MAX_STDERR_BYTES } from './policy.js'

const HOSTS_LIMIT = 50

/** 隐式建连后等「真就绪」的预算（与 runtime 的握手预算同量级）与轮询间隔。 */
export const READY_WAIT_MS = 60_000
export const READY_POLL_MS = 50

/** 审批选项标签（官方契约：options = [{ label }]；返回值里 selected 装的就是 label 文本）。 */
export const ALLOW_CHOICE = '允许执行'
export const DENY_CHOICE = '拒绝'

function cap(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return { text: value, truncated: false }
  return { text: `${value.slice(0, max)}\n…[输出已截断，原长度 ${value.length}]`, truncated: true }
}

const errText = error => String(error?.message ?? error ?? '未知错误')

/**
 * 官方 `ToolDefinition` 契约（2026-09-26 从运行中宿主 Inspect 读到精确声明）：
 *   `output: { schema: JsonSchemaNode, render(args, value) => ContentBlock[] }` 是**必填**。
 * 少它一条，`ctx.tools.register()` 会抛
 *   `tool "<name>" must declare output { schema, render, presentationMeta? }`
 * —— 这正是 A1 首次实机实测里「三个工具一个都没进模型工具面」的真根因（旧代码把这条
 * 错误 catch 进 logger.error，页面上完全看不出来）。
 */
const textBlocks = text => [{ type: 'text', text: String(text ?? '') }]

function renderHosts(value) {
  const hosts = Array.isArray(value?.hosts) ? value.hosts : []
  if (hosts.length === 0) return '没有对 Agent 开放的主机（agentAccess 均为 none）'
  // **id 必须首列**（2026-09-26 实机实测）：模型只看得见 output.render 的文本，看不见 value 的
  // JSON —— 不带 id 时它只能拿 label 当 hostId，连吃三次 NOT_FOUND ⇒ ssh_exec 形同不可用。
  return hosts.map(item => `${item.id} · ${item.label} · ${item.address} · agentAccess=${item.agentAccess} · state=${item.state}`).join('\n')
}

function renderExec(value) {
  if (value === null || typeof value !== 'object') return String(value ?? '')
  if (typeof value.error === 'string') {
    // 错误也要带上下文：拒绝/失败在对话流里回看时，必须看得出「被拒的是哪台主机的哪条命令」。
    const where = typeof value.host === 'string' && value.host.length > 0 ? ` · ${value.host}` : ''
    const what = typeof value.command === 'string' && value.command.length > 0 ? ` · ${value.command}` : ''
    const level = typeof value.riskLevel === 'string' && value.riskLevel.length > 0 ? ` · risk=${value.riskLevel}` : ''
    return `${value.error}：${value.message ?? ''}${where}${what}${level}`
  }
  const lines = [`${value.host ?? '?'} · ${value.command ?? ''}`, `exit=${value.exitCode ?? '?'} · ${value.durationMs ?? '?'}ms · risk=${value.riskLevel ?? '?'}${value.truncated === true ? ' · 输出已截断' : ''}`]
  if (typeof value.stdout === 'string' && value.stdout.length > 0) lines.push(`--- stdout ---\n${value.stdout}`)
  if (typeof value.stderr === 'string' && value.stderr.length > 0) lines.push(`--- stderr ---\n${value.stderr}`)
  return lines.join('\n')
}

function renderSessionText(value) {
  if (typeof value?.error === 'string') return `${value.error}：${value.message ?? ''}`
  return String(value?.text ?? '')
}

/**
 * @param {{ runtime: object, store: object, audit: object,
 *   userQuestions?: object, logger?: object, readyWaitMs?: number }} deps 全部经注入（便于单测）
 */
export function createSshTools({ runtime, store, audit, userQuestions, logger = console, readyWaitMs = READY_WAIT_MS }) {
  /**
   * 审批（方案 A：`ctx.userQuestions.ask()`）。**契约不再是「按通用约定」**：
   * 2026-09-26 从运行中宿主（0.1.7-rc.2）的 Inspect 读到精确声明，并与安装产物
   * `dsh-user-questions/lib/index.js` 逐条对齐——
   *
   *   ask({ questions: [{ id, question, detail?, header?, options?: [{ label, description? }] }],
   *         agent?, signal? }) => { answers: [{ id, selected: string[], custom? }] }
   *
   * 形如 `{ title, detail, options: [...] }` 的**扁平调用必然抛错**（`questions` 缺失 ⇒
   * `request.questions.length` 的 TypeError；空数组 ⇒ EMPTY_QUESTIONS；`agent` 非 live
   * root ⇒ CALLER_NOT_LIVE / DELEGATED_CALLER）。四种失败在这里统一收敛为
   * `unavailable` ⇒ **失败关闭**（§7.3：不给放行，也不抛异常中止轮次）。
   */
  async function requestApproval({ reason, detail, agent, signal }) {
    if (userQuestions === undefined || userQuestions === null || typeof userQuestions.ask !== 'function') {
      return { decision: 'unavailable', message: '当前环境没有可用的确认通道（userQuestions）' }
    }
    let answer
    try {
      answer = await userQuestions.ask({
        questions: [
          {
            id: 'ssh-exec',
            header: 'SSH 命令执行审批',
            question: reason,
            detail, // 契约是 string：这里是完整命令（人能看到要执行什么）
            options: [{ label: ALLOW_CHOICE }, { label: DENY_CHOICE }],
          },
        ],
        ...(agent === undefined ? {} : { agent }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      // ASK_ABORTED 是「人还没回答就被撤回」⇒ 结算成 cancelled（不是 unavailable）
      if (error?.code === 'ASK_ABORTED') return { decision: 'cancelled', message: '审批被撤回（会话已中止）' }
      return { decision: 'unavailable', message: `确认通道调用失败：${errText(error)}${error?.code === undefined ? '' : `（${error.code}）`}` }
    }
    const verdict = decisionOf(answer)
    if (verdict !== null) return verdict
    return { decision: 'unavailable', message: `无法解析确认结果：${describeAnswer(answer)}` }
  }

  /** 官方形状优先（answers[0].selected[0] / custom），旧形状宽容兜底；解析不出返回 null。 */
  function decisionOf(answer) {
    if (answer === true) return { decision: 'allowed-once' }
    if (answer === false) return { decision: 'rejected' }
    if (typeof answer === 'string' || typeof answer === 'number') return decisionOfChoice(String(answer))
    if (answer === null || typeof answer !== 'object') return null
    const item = Array.isArray(answer.answers) ? answer.answers[0] : undefined
    if (item !== undefined && item !== null) {
      // 人手填的 custom 优先于选项 label
      const text = String(item.custom ?? item.selected?.[0] ?? '')
      return decisionOfChoice(text)
    }
    // 非官方形状（单测替身/未来契约漂移）：choice | answer | value | approved 都试
    const fallback = answer.choice ?? answer.answer ?? answer.value ?? answer.approved
    if (fallback === undefined || fallback === null) return null
    return decisionOfChoice(String(fallback))
  }

  function decisionOfChoice(text) {
    const value = String(text ?? '').trim()
    if (value.length === 0) return null
    // 精确 label 优先（官方路径的正常形态）
    if (value === ALLOW_CHOICE) return { decision: 'allowed-once' }
    if (value === DENY_CHOICE) return { decision: 'rejected' }
    // 自由文本：**拒绝优先** —— 「不执行」「不允许」这类句子同时含允许词与否定词，
    // 含混时判拒绝（失败关闭方向），绝不能因为看见了「执行」就放行。
    if (/拒绝|不允许|不能|不要|不执行|取消|驳回|deny|reject|cancel|false|\bno\b/i.test(value)) return { decision: 'rejected' }
    if (/允许|同意|可以|确认|执行|yes|allow|approve|\bok\b|true/i.test(value)) return { decision: 'allowed-once' }
    return null
  }

  function describeAnswer(answer) {
    try {
      const text = JSON.stringify(answer)
      return text === undefined ? String(answer) : text.slice(0, 200)
    } catch {
      return String(answer)
    }
  }

  async function listVisibleHosts(filter) {
    const connections = await store.listConnections()
    const live = new Map(runtime.listState().map(item => [item.id, item.state]))
    const q = String(filter ?? '').trim().toLowerCase()
    return connections
      .filter(conn => (conn.agentAccess ?? 'none') !== 'none')
      .filter(conn => q.length === 0 || `${conn.label} ${conn.username}@${conn.host}:${conn.port}`.toLowerCase().includes(q))
      .slice(0, HOSTS_LIMIT)
      .map(conn => ({
        id: conn.id,
        label: conn.label,
        address: `${conn.username}@${conn.host}:${conn.port}`,
        agentAccess: conn.agentAccess ?? 'none',
        state: live.get(conn.id) ?? 'idle',
      }))
  }

  /**
   * 连接状态里「不值得再等」的两类，各自给可行动的失败。
   * careful：waiting-fingerprint 不是失败，是**等人** —— 但人不在这个工具调用里，
   * 等下去只会把工具挂满预算，所以立刻返回可照做的指引（与跳板 JUMP_UNAVAILABLE 同一口径）。
   */
  function connectionHealth(rc) {
    if (rc.status === 'waiting-fingerprint') {
      return { code: 'FINGERPRINT_REQUIRED', message: '该主机是首次连接（需要人确认主机指纹）：请先在 SSH 页面上连接一次这台主机完成信任，再让 Agent 执行（Agent 不代按指纹确认）' }
    }
    if (rc.status === 'error' || rc.status === 'closed') {
      return { code: 'NOT_CONNECTED', message: `连接未建立（${rc.status}）：请在 SSH 页面查看连接状态后重试` }
    }
    return null
  }

  /**
   * 等连接**真正就绪**（而不只是「已发起」）。
   *
   * 2026-09-26 host 半端到端实测逮到：`runtime.connect()` 是异步的（握手在后台跑），
   * 它返回时 `rc.status` 几乎必然还是 `connecting` ⇒ 旧写法「connect 之后立刻查
   * isConnected/status」在真机上**首次 ssh_exec 必返回 NOT_CONNECTED**；单测里 stub
   * 直接给 `connected`，把这一层时序掩盖了。这里按状态轮询到真就绪，并把指纹等待、
   * 连接失败、超时三种结局各自收敛成可行动的错误码。
   */
  async function awaitReady(rc, { timeoutMs = readyWaitMs } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (rc.status === 'connected' && rc.client !== null) return { rc }
      const bad = connectionHealth(rc)
      if (bad !== null) return { error: bad }
      if (Date.now() >= deadline) {
        return { error: { code: 'NOT_CONNECTED', message: `连接未在 ${Math.round(timeoutMs / 1000)}s 内就绪（当前状态 ${rc.status}）：请稍后重试，或先在 SSH 页面连接该主机` } }
      }
      await new Promise(resolve => setTimeout(resolve, READY_POLL_MS))
    }
  }

  /** 确保连接可用（隐式建连仅限 key/agent）；返回 { rc } 或 { error }。 */
  async function ensureRuntime(record) {
    const existing = runtime.runtimeOf(record.id)
    if (existing !== null && existing.status === 'connected') return { rc: existing }
    if (existing !== null && (existing.status === 'connecting' || existing.status === 'waiting-fingerprint')) {
      // 已有一次建连在飞：等它，别重复 connect —— 重复调用会 retire 掉前一条连接
      // （第二条 exec 把第一条的连接拆了，是比慢更糟的错）
      return await awaitReady(existing)
    }
    if (record.auth?.method === 'password') {
      return { error: { code: 'NOT_CONNECTED', message: '该主机尚未连接：密码主机需要人在 SSH 页面连接（Agent 不发起密码认证）' } }
    }
    if (record.auth?.method !== 'key' && record.auth?.method !== 'agent') {
      return { error: { code: 'NOT_CONNECTED', message: `不支持的认证方式：${record.auth?.method}` } }
    }
    const result = await runtime.connect(record.id, { openShell: false })
    if (result?.error !== undefined) {
      return { error: { code: 'NOT_CONNECTED', message: `无法建立连接：${result.error}` } }
    }
    const rc = runtime.runtimeOf(record.id)
    if (rc === null) return { error: { code: 'NOT_CONNECTED', message: '连接尚未就绪，请稍后重试' } }
    return await awaitReady(rc)
  }

  const tools = [
    {
      name: 'ssh_hosts',
      description: 'List SSH hosts this agent may use (agentAccess != none). Read-only, no approval needed. Each line starts with the connection `id` — pass exactly that id as hostId to ssh_exec / ssh_session_read (never the label or the address).',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Optional substring filter over label / user@host:port' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            hosts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  address: { type: 'string' },
                  agentAccess: { type: 'string' },
                  state: { type: 'string' },
                },
                additionalProperties: true,
              },
            },
            count: { type: 'integer' },
          },
          additionalProperties: true,
        },
        render: (_args, value) => textBlocks(renderHosts(value)),
      },
      async execute(args) {
        const hosts = await listVisibleHosts(args?.filter)
        return { hosts, count: hosts.length }
      },
    },
    {
      name: 'ssh_session_read',
      description: 'Read the tail of the live terminal scrollback of a host the user is using. Read-only, no approval needed.',
      parameters: {
        type: 'object',
        properties: {
          hostId: { type: 'string', description: 'Connection id from ssh_hosts' },
          lines: { type: 'integer', description: 'Tail lines to read (default 200, max 2000)', minimum: 1, maximum: 2000 },
        },
        required: ['hostId'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            truncated: { type: 'boolean' },
            cols: { type: 'integer' },
            rows: { type: 'integer' },
            live: { type: 'boolean' },
            error: { type: 'string' },
            message: { type: 'string' },
          },
          additionalProperties: true,
        },
        render: (_args, value) => textBlocks(renderSessionText(value)),
      },
      async execute(args) {
        const hostId = String(args?.hostId ?? '')
        const record = await store.getConnection(hostId)
        if (record === null) return { error: 'NOT_FOUND', message: '主机不存在' }
        const access = decideAccess(record)
        if (access.allowed !== true) return { error: access.code, message: access.message }
        const rc = runtime.runtimeOf(hostId)
        if (rc === null || rc.status !== 'connected') {
          return { error: 'NOT_CONNECTED', message: '该主机当前没有活动连接：先让用户在页面上连接' }
        }
        const snapshot = runtime.readShellText(hostId, { lines: Number(args?.lines) || 200 })
        if (snapshot === null) return { error: 'NO_SHELL', message: '该连接当前没有 shell' }
        const capped = cap(snapshot.text, MAX_STDOUT_BYTES)
        audit.record({ hostId, host: record.label, command: '(session_read)', riskLevel: 'L0', decision: 'read' })
        return { text: capped.text, truncated: snapshot.truncated || capped.truncated, cols: snapshot.cols, rows: snapshot.rows, live: snapshot.live }
      },
    },
    {
      name: 'ssh_exec',
      description: 'Execute a shell command on an authorized SSH host. The class (L0 read-only / L1 change / L2 dangerous) is decided server-side; L1/L2 require human approval per policy.',
      parameters: {
        type: 'object',
        properties: {
          hostId: { type: 'string', description: 'Connection id from ssh_hosts' },
          command: { type: 'string', description: 'POSIX shell command' },
          cwd: { type: 'string', description: 'Optional working directory on the remote host' },
          timeoutMs: { type: 'integer', description: `Timeout in ms (default ${DEFAULT_EXEC_TIMEOUT_MS}, max ${MAX_EXEC_TIMEOUT_MS})`, minimum: 1000, maximum: MAX_EXEC_TIMEOUT_MS },
        },
        required: ['hostId', 'command'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            exitCode: { type: 'integer' },
            stdout: { type: 'string' },
            stderr: { type: 'string' },
            truncated: { type: 'boolean' },
            durationMs: { type: 'integer' },
            host: { type: 'string' },
            command: { type: 'string' },
            riskLevel: { type: 'string' },
            error: { type: 'string' },
            message: { type: 'string' },
          },
          additionalProperties: true,
        },
        render: (_args, value) => textBlocks(renderExec(value)),
      },
      async execute(args, exec = {}) {
        const hostId = String(args?.hostId ?? '')
        const command = String(args?.command ?? '')
        const record = await store.getConnection(hostId)
        if (record === null) return { error: 'NOT_FOUND', message: '主机不存在' }
        if (command.trim().length === 0) return { error: 'BAD_INPUT', message: '命令不能为空' }
        // 错误返回也带 host/command：对话流回看时「被拒/失败的是哪台主机的哪条命令」必须看得见
        // （2026-09-26 实机实测：旧实现只在成功结果里带 host，拒绝卡上只剩一句错误码）。
        const address = `${record.username}@${record.host}:${record.port}`

        // ① 访问档位
        const access = decideAccess(record)
        if (access.allowed !== true) {
          audit.record({ hostId, host: record.label, command, riskLevel: null, decision: 'denied-access' })
          return { error: access.code, message: access.message }
        }
        // ② 服务端分级（模型传什么都不算数）
        const { riskLevel, reason } = classifyCommand(command)
        // readonly 硬闸：L1/L2 连审批机会都不给（§7.1「这才叫只读」）
        const risk = decideRisk(record, riskLevel)
        if (risk.allowed !== true) {
          audit.record({ hostId, host: record.label, command, riskLevel, decision: 'denied-risk' })
          return { error: risk.code, message: risk.message, riskLevel, command }
        }
        if (needsApproval(record, riskLevel)) {
          const decision = await requestApproval({
            reason: describeCommand(record, command, riskLevel),
            detail: command.slice(0, MAX_COMMAND_LENGTH), // 契约 detail 是 string：给人看完整命令
            agent: exec?.agent, // 官方契约：有 agent 时只认 exact live root（非 live ⇒ 失败关闭）
            signal: exec?.signal,
          })
          if (decision.decision === 'rejected') {
            audit.record({ hostId, host: record.label, command, riskLevel, decision: 'rejected' })
            return { error: 'APPROVAL_REJECTED', message: '用户拒绝了这次命令执行', riskLevel, command, host: address }
          }
          if (decision.decision === 'cancelled') {
            audit.record({ hostId, host: record.label, command, riskLevel, decision: 'cancelled' })
            return { error: 'APPROVAL_CANCELLED', message: '审批被撤回', riskLevel, command, host: address }
          }
          if (decision.decision !== 'allowed-once') {
            // unavailable：失败关闭（不给可行动的失败信息就是干拒绝）
            audit.record({ hostId, host: record.label, command, riskLevel, decision: 'unavailable' })
            return {
              error: 'APPROVAL_UNAVAILABLE',
              message: `当前会话无法弹出审批（${decision.message ?? '无确认通道'}）：这条命令是 ${riskLevel}，需要人批准。请由人在 SSH 页面手动执行，或切换到允许审批的权限模式。`,
              riskLevel,
              command,
              host: address,
            }
          }
          audit.record({ hostId, host: record.label, command, riskLevel, decision: 'allowed-once' })
        }

        // ③ 连接（password 主机不隐式建连）
        const ensured = await ensureRuntime(record)
        if (ensured.error !== undefined) {
          audit.record({ hostId, host: record.label, command, riskLevel, decision: ensured.error.code })
          return { error: ensured.error.code, message: ensured.error.message, riskLevel, command, host: address }
        }

        // ④ 执行（cwd 经 POSIX 引用前置；signal 透传取消）
        const cwd = String(args?.cwd ?? '').trim()
        const effective = cwd.length > 0 ? `cd ${quote(cwd)} && ${command}` : command
        const timeoutMs = Math.min(Math.max(Number(args?.timeoutMs) || DEFAULT_EXEC_TIMEOUT_MS, 1000), MAX_EXEC_TIMEOUT_MS)
        const started = Date.now()
        const result = await execCommand(ensured.rc.client, effective, {
          timeoutMs,
          maxOutputBytes: MAX_STDOUT_BYTES,
          signal: exec?.signal,
        })
        const durationMs = Date.now() - started
        const out = cap(result.stdout, MAX_STDOUT_BYTES)
        const err = cap(result.stderr, MAX_STDERR_BYTES)
        audit.record({
          hostId,
          host: record.label,
          command,
          riskLevel,
          decision: result.canceled === true ? 'canceled' : result.timedOut === true ? 'timeout' : `exit:${result.code ?? 'null'}`,
          durationMs,
        })
        if (result.error !== undefined) {
          // 双栈边界（P2-3）：exec 一律包 /bin/sh —— 远端是 Windows（OpenSSH for
          // Windows）时没有 /bin/sh，这一句就是用户能照着做的线索。
          const hint = /no such file|not found|\/bin\/sh/i.test(result.error)
            ? '（若远端是 Windows：exec 通道按 POSIX 语义包了 /bin/sh，Windows 服务器上不可用）'
            : ''
          return { error: 'EXEC_FAILED', message: `${result.error}${hint}`, riskLevel, command, host: address }
        }
        if (result.canceled === true) {
          return { error: 'CANCELED', message: '执行已被取消', riskLevel, command, host: address }
        }
        if (result.timedOut === true) {
          return { error: 'TIMEOUT', message: `命令超过 ${timeoutMs}ms 未结束，已结束 channel`, riskLevel, command, host: address }
        }
        return {
          exitCode: result.code,
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated,
          durationMs,
          host: address,
          command,
          riskLevel,
        }
      },
    },
  ]

  return { tools, requestApproval, listVisibleHosts, ensureRuntime }
}

/** 本地 quote（与 lib/exec.js 同一个规则；tools 不直接依赖 exec 的内部件）。 */
function quote(arg) {
  return `'${String(arg ?? '').replaceAll("'", "'\\''")}'`
}
