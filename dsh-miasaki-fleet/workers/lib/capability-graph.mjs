// capability-graph.mjs — ESM 门面，实现在 capability-graph.cjs。
//
// 与 liveness / bus-contract / task-graph 同一做法：实现落在 .cjs，
// 让 ESM（CLI、面板插件）与 CJS（fleet-monitor/server.js）都能消费同一份口径。
//
// 能力词表的保守策略、confidence 口径、选型评分公式见 capability-graph.cjs 头部注释。

import module from './capability-graph.cjs'

export const {
  CAP_PREFIX,
  DEFAULT_ALIASES,
  DEFAULT_WEIGHTS,
  normalizeSkill,
  canonicalize,
  capabilityId,
  buildCapabilityGraph,
  findSubstitutes,
  scoreAgent,
  selectAgents,
  capabilityGaps,
} = module
