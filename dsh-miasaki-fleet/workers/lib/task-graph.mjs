// task-graph.mjs — ESM 门面，实现在 task-graph.cjs。
//
// 为什么分两个文件：调度判定的消费者既可能是 ESM（workers/graph/task-ready.mjs、
// 未来的面板插件），也可能是 CJS（fleet-monitor/server.js 若要展示就绪集）。
// CJS 实现能被两者共用，反之不行 —— 与 liveness / bus-contract 同一做法：
// **判定口径只有一份，不存在两处副本会漂移**。
//
// 语义说明（两种依赖、回退规则）见 task-graph.cjs 头部注释。

import module from './task-graph.cjs'

export const {
  TERMINAL,
  foldTasks,
  effectiveDeps,
  buildGraph,
  groupSummary,
  legacyReady,
  evaluateReadiness,
  evaluateDispatchable,
  readySet,
  dispatchableSet,
} = module
