// verifier.mjs — ESM 门面，实现在 verifier.cjs。
//
// 与 liveness / bus-contract / task-graph / capability-graph 同一做法：
// 实现落在 .cjs，让 ESM（CLI、面板插件）与 CJS 都能消费同一份口径。
//
// 异构等级的定义、厂商映射的来源、以及「模型字段普遍缺失时如何仍能判定异构」
// 见 verifier.cjs 头部注释。

import module from './verifier.cjs'

export const {
  DEFAULT_VENDORS,
  HETERO_LEVELS,
  levelRank,
  levelAtLeast,
  vendorOf,
  normalizeModel,
  assessHeterogeneity,
  selectVerifiers,
  buildVerifierBrief,
  summarizeVerdicts,
} = module
