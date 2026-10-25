// failure-classify.cjs — P1-A（2026-10-21）：派单失败分类器
//
// 为什么存在：fleet 的失败语义此前只有 exit code（0/2/3/4）与自由文本 `last_error`。
// Commander / 面板无法回答「这次失败换一个 agent 有没有用」，重试策略也只能一刀切
// （普通失败不重试、超时重试一次）。本模块把失败分成**可行动的类别**：
//
//   timeout         执行超时（进程树已 kill）              retryable=true  switch=true
//   rate_limit      速率限制 / 429                        retryable=true  switch=true
//   quota           额度/余额不足（402 / quota）           retryable=true  switch=true
//   auth            鉴权失败（401/403 / invalid key）      retryable=false switch=true
//   unavailable     CLI 缺失 / 网络不可达 / 5xx            retryable=true  switch=true
//   context_overflow 上下文溢出                             retryable=false switch=false
//   request_error   请求本身非法（400/422）                 retryable=false switch=false
//   unknown         未识别                                  retryable=false switch=false
//
// 语义边界（重要）：
//   · `retryable` = **同一 agent 再试一次**可能成功（例如限流冷却后）；
//   · `suggest_switch` = **换一个异构 agent** 可能有帮助（与 G4 异构思想一致）；
//   · 判据是**日志文本 + exit code**，启发式必然有误差 —— 不确定就 `unknown`，不猜。
//
// 颜色对齐 magpie 的失败分类（retryable / lateRests / 冷却），但只借语义、不引实现。

'use strict'

const FAILURE_KINDS = Object.freeze([
  'timeout', 'rate_limit', 'quota', 'auth', 'unavailable',
  'context_overflow', 'request_error', 'unknown',
])

/** 规则按**优先级**排列（先匹配者胜）：上下文溢出最容易被 400 文案误归，必须排在 request_error 前。 */
const RULES = Object.freeze([
  {
    kind: 'timeout',
    retryable: true,
    suggest_switch: true,
    re: /timed?\s*out|timeout|超时|etimedout/,
    detail: '执行超时（进程树已 kill；钱可能已花）',
  },
  {
    kind: 'context_overflow',
    retryable: false,
    suggest_switch: false,
    re: /context (window|length)|maximum context|context overflow|prompt is too long|reduce the length|too many tokens|token limit|上下文(长度|窗口|溢出)/,
    detail: '上下文溢出（换 agent 也没用，应压缩输入或拆任务）',
  },
  {
    kind: 'rate_limit',
    retryable: true,
    suggest_switch: true,
    re: /rate.?limit|too many requests|throttl|\b429\b|限流/,
    detail: '速率限制（冷却后同 agent 可重试，也可换 agent/账号）',
  },
  {
    kind: 'quota',
    retryable: true,
    suggest_switch: true,
    re: /quota|insufficient (credit|balance|funds)|exceeded your current quota|out of credits|billing|\b402\b|额度|余额不足/,
    detail: '额度/余额不足（换账号或 provider 可能恢复）',
  },
  {
    kind: 'auth',
    retryable: false,
    suggest_switch: true,
    re: /unauthoriz|invalid api key|authentication|not logged in|permission denied|forbidden|\b401\b|\b403\b|鉴权|未登录/,
    detail: '鉴权失败（同 agent 重试无意义；换 vendor 可能可行）',
  },
  {
    kind: 'unavailable',
    retryable: true,
    suggest_switch: true,
    re: /econnrefused|enotfound|econnreset|network error|service unavailable|overloaded|temporarily unavailable|connection (refused|reset)|\b5\d{2}\b|不可用/,
    detail: '服务/网络暂时不可用（可重试或换 agent）',
  },
  {
    kind: 'request_error',
    retryable: false,
    suggest_switch: false,
    re: /bad request|invalid request|invalid argument|\b400\b|\b422\b|参数(非法|错误)/,
    detail: '请求本身非法（重试/换 agent 都不会好，应修 brief 或命令）',
  },
])

const HINTS = Object.freeze({
  timeout: '检查 timeout_ms；可改派异构 agent，但先确认上次是否已产生交付物',
  rate_limit: '等冷却窗口后重试，或改派另一 vendor 的 agent',
  quota: '换账号/provider 或充值；不要原样重试',
  auth: '修该 CLI 的凭据；或改派其它 vendor 的 agent',
  unavailable: '确认 CLI 在 PATH / 网络可达；可重试',
  context_overflow: '压缩上下文 / 拆小任务；换 agent 无效',
  request_error: '修 brief、prompt 或命令参数；不要重试',
  unknown: '未识别失败：按原 exit code 处理，不做自动重试',
})

/**
 * 分类一次失败。
 *
 * @param {object} input { exitCode?: number, timedOut?: boolean, stdout?: string, stderr?: string }
 * @returns {{kind: string, retryable: boolean, suggest_switch: boolean, detail: string, hint: string}}
 */
function classifyFailure(input) {
  const o = input || {}
  const exitCode = Number.isFinite(Number(o.exitCode)) ? Number(o.exitCode) : null
  const timedOut = o.timedOut === true
  const text = `${o.stdout || ''}\n${o.stderr || ''}`

  if (timedOut) {
    const rule = RULES[0]
    return { kind: rule.kind, retryable: rule.retryable, suggest_switch: rule.suggest_switch, detail: rule.detail, hint: HINTS[rule.kind] }
  }

  // CLI 缺失是**环境事实**（exit 127），不是模型/网络失败：换 agent 往往有效。
  if (exitCode === 127) {
    return {
      kind: 'unavailable', retryable: true, suggest_switch: true,
      detail: 'CLI 不存在或不在 PATH（exit 127）', hint: '装好 CLI 或改派已安装的 agent',
    }
  }

  const lower = text.toLowerCase()
  for (const rule of RULES) {
    if (rule.re.test(lower) || rule.re.test(text)) {
      return { kind: rule.kind, retryable: rule.retryable, suggest_switch: rule.suggest_switch, detail: rule.detail, hint: HINTS[rule.kind] }
    }
  }

  return {
    kind: 'unknown', retryable: false, suggest_switch: false,
    detail: `未识别的失败（exit ${exitCode === null ? '?' : exitCode}）`, hint: HINTS.unknown,
  }
}

module.exports = { FAILURE_KINDS, classifyFailure }
