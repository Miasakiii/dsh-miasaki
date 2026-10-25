#!/usr/bin/env node
// classify-failure.mjs — P1-A（2026-10-21）：派单失败分类 CLI
//
// 给 PowerShell 派单器调用（classify 只有一份实现 = workers/lib/failure-classify.cjs）。
// 输出**恒为 JSON**（stdout），退出码只表示「CLI 是否正常完成」：
//   0 分类成功（哪怕结果是 unknown）；2 用法错误；1 读取日志失败（仍会尝试按已有信息分类？不——显式失败）
//
// 用法：
//   node workers/dispatch/classify-failure.mjs --exit-code 1 --log <stdout.log>
//   node workers/dispatch/classify-failure.mjs --exit-code 124 --timed-out
//
// 日志只读**尾部**（默认 64 KiB）：失败原因几乎总在末尾，避免大日志全量读入。

'use strict'

import fs from 'node:fs'
import { classifyFailure } from '../lib/failure-classify.cjs'

function parseArgs(argv) {
  const opts = { exitCode: null, timedOut: false, log: null, tailBytes: 64 * 1024 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--exit-code') {
      const v = argv[++i]
      if (v === undefined || !/^-?\d+$/.test(v)) throw new Error('--exit-code 需要整数')
      opts.exitCode = Number(v)
    } else if (a === '--timed-out') opts.timedOut = true
    else if (a === '--log') {
      const v = argv[++i]
      if (!v) throw new Error('--log 需要路径')
      opts.log = v
    } else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else throw new Error(`未知参数: ${a}`)
  }
  if (opts.exitCode === null) throw new Error('缺少 --exit-code（失败分类至少需要退出码）')
  return opts
}

function printHelp() {
  console.log(`classify-failure — 派单失败分类（P1-A）

  --exit-code <n>   进程退出码（必填）
  --timed-out       是否超时 kill（优先于文本匹配）
  --log <path>      worker stdout 日志（只读尾部 64 KiB）
  --help            显示帮助

输出：JSON {kind, retryable, suggest_switch, detail, hint}
退出码：0 分类成功 / 1 日志读取失败 / 2 用法错误`)
}

function readTail(p, n) {
  const buf = fs.readFileSync(p)
  return buf.length <= n ? buf.toString('utf8') : buf.subarray(buf.length - n).toString('utf8')
}

function main() {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (e) { console.error(`[classify-failure] ${e.message}`); return 2 }

  let logText = ''
  if (opts.log) {
    try {
      logText = readTail(opts.log, opts.tailBytes)
    } catch (e) {
      console.error(`[classify-failure] 读取日志失败（${opts.log}）：${e.message}`)
      return 1
    }
  }

  const result = classifyFailure({ exitCode: opts.exitCode, timedOut: opts.timedOut, stdout: logText, stderr: logText })
  console.log(JSON.stringify(result))
  return 0
}

process.exit(main())
