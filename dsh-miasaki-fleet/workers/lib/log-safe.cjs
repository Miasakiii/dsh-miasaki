// log-safe.cjs — 日志行安全化（CWE-117 日志注入，2026-10-20 修 monkeyscan da827）
//
// 为什么需要：validate-bus 的 fail() 会把**总线数据**（tasks.jsonl 的行字段、
// status.json 的 state 等）直接插进 console.error 的自由格式消息。总线写入者可以
// 把 `\n` / `\r` / `\u001b`（JSON 转义 + JSON.parse 还原后是真控制字符）存进台账，
// 于是运维终端 / CI 日志里会出现**伪造的日志行**或 ANSI 控制序列（覆盖、清行）。
//
// 修法口径：在**唯一汇点**做转义，而不是逐个插值点改 —— 后者的典型失败是漏掉新增
// 的插值点（本仓「判定单点」纪律同源）。转义只影响日志展示，不改变退出码与真实摘要。
//
// 注意：写入侧 `JSON.stringify` 只保证磁盘上是单行；读取侧 `JSON.parse` 会把转义
// 还原成控制字符，所以**读取到日志之间必须有这一步**，不能指望写入侧的转义。

'use strict'

/** 可读的转义别名（比 `\x0a` 更好认）。 */
const NAMED = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
}

/**
 * 把控制字符替换为可见转义（`\n` → `\\n`、ESC → `\\x1b`）。
 *
 * @param {unknown} value 任意值（非字符串按 String() 处理）
 * @returns {string} 不含 C0/C1 控制字符的单行文本
 */
function logSafe(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, (ch) => {
    if (NAMED[ch] !== undefined) return NAMED[ch]
    return `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`
  })
}

module.exports = { logSafe }
