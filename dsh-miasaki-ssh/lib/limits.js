// 共享上限常量（U2.2 SFTP / 票据 / 传输队列的唯一出处）。
// 改这里就是改全线口径 —— 前端渲染与 host 侧校验都读同一批数字。

/** 远端路径词法上限（字符）。 */
export const MAX_PATH_LENGTH = 4096

/** SFTP 单次上传上限：U2 规划决策 3 —— Content-Length 预检 + 流式计数双重校验。 */
export const SFTP_MAX_UPLOAD_BYTES = 512 * 1024 * 1024

/**
 * SFTP 票据 TTL（U2 规划 §4.2.4）：长传输要活过一次排队 + 完整收发，
 * 且可续期（POST /ssh/api/sftp/renew）。与 WS attach 票据（30s 一次性）是两种生命周期。
 */
export const SFTP_TICKET_TTL_MS = 600_000

/** 进度节流：1s 或 5% 或到达终点才上报（zcode sshUploadProgress.ts 同款口径）。 */
export const SFTP_PROGRESS_INTERVAL_MS = 1_000
export const SFTP_PROGRESS_PERCENT_STEP = 5

/** 传输队列并发：SFTP 与 shell 共用一条 SSH 连接的 TCP 窗口，保守取 2。 */
export const SFTP_MAX_CONCURRENT_TRANSFERS = 2

/** 单次 SFTP 操作（列目录 / stat / 变更）的超时。 */
export const SFTP_OP_TIMEOUT_MS = 15_000
