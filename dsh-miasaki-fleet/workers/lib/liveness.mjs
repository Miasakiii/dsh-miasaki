// liveness.mjs — ESM 门面，实现在 liveness.cjs。
//
// 为什么分两个文件：判活逻辑有两个消费者，一为 ESM（workers/pulse/publish-pulse.mjs），
// 一为 CJS（fleet-monitor/server.js）。CJS 实现能被两者共用，反之不行，所以
// 实现落在 .cjs，这里只做转发——**判活口径只有一份，不存在两处副本会漂移**。
//
// 契约与判定规则见 liveness.cjs 头部注释。

import module from './liveness.cjs'

export const { STALE_FACTOR, DEFAULT_HEARTBEAT_MS, parseTimestamp, evaluateLiveness } = module
