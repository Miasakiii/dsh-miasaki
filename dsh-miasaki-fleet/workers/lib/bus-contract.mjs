// bus-contract.mjs — ESM 门面，实现在 bus-contract.cjs。
//
// 为什么分两个文件：契约校验有两个消费者，一为 ESM（workers/bus/bus-apply.mjs、
// workers/validate-bus.mjs），将来还可能有 CJS 消费者（fleet-monitor/server.js
// 若需在面板侧校验事件）。CJS 实现能被两者共用，反之不行，所以实现落在 .cjs，
// 这里只做转发 —— **「什么算合法」只有一份定义，不存在两处副本会漂移**。
//
// 契约细则与设计依据见 bus-contract.cjs 头部注释。

import module from './bus-contract.cjs'

export const {
  // 谓词
  isStr,
  isNum,
  isNonNegInt,
  isObj,
  isTaskId,
  isEventAuthor,
  // 形态常量
  TASK_ID_RE,
  GROUP_RE,
  AGENT_ID_RE,
  SHA256_RE,
  MAX_EVENT_BYTES,
  // graph
  NODE_KINDS,
  validateGraph,
  // result
  RESULT_STATUS,
  EVIDENCE_TYPES,
  validateResult,
  // verdict（G4 验证器结论）
  VERDICT_VALUES,
  FINDING_SEVERITIES,
  validateVerdict,
  // event
  EVENT_TYPES,
  EVENT_AUTHORS,
  validateEvent,
  makeEvent,
  currentBusVersion,
  // patch
  PATCH_OPS,
  PATCH_PATH_RULES,
  validatePatch,
  patchSortKey,
  sortPatchesDeterministic,
} = module
