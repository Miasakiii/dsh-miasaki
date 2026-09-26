// A1 工具面审计台账（Agent 化规划 §7.5）。
//
// 官方 `approval/asked|decided` 审计对当前不可用（SPIKE S3 实测 unavailable），SSH 侧自记一份：
//   * 内存环（默认 200 条，REST 只读、倒序）—— 页面浮层的读数源；
//   * **追加落盘** `dataDir/exec-audit.jsonl` —— 2026-09-26 实机实测暴露：只留内存环时，
//     进程一重启「这台机器最近被 Agent 动过什么」就查不到了（规划 §7.5 写的本就是落盘）。
//
// 口径不变：**不记输出内容、不记任何凭据**（命令本身不是秘密，秘密从不进台账）。
// 落盘失败绝不冒泡（审计是旁路，不能把工具执行拖下来）。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const MAX_ENTRIES = 200
// 懒加载时的文件上限：超过就只留尾部并压回，避免长期运行无限增长。
const MAX_FILE_LINES = 1000

export function createAuditRing({ max = MAX_ENTRIES, now = () => new Date().toISOString(), file = null } = {}) {
  const entries = []
  let loaded = false
  let seq = 0

  /** 首次使用前把既有台账回填进内存（否则重启后 seq 从头来、历史也看不到）。 */
  function load() {
    if (loaded) return
    loaded = true
    if (file === null) return
    let lines = []
    try {
      // 台账文件是**运行时产物**，首次运行时它还不存在 —— 这是全新安装的正常路径，不是降级。
      // guard-ok: 无文件 ⇒ 空台账起步；审计是旁路，读不到不得拖垮工具执行（下面 catch 同）。
      if (!existsSync(file)) return
      lines = readFileSync(file, 'utf8').split('\n').filter(line => line.trim().length > 0)
    } catch {
      return // 读失败（权限/损坏）：按空台账继续，落盘仍会在下次 record 时重建
    }
    if (lines.length > MAX_FILE_LINES) {
      lines = lines.slice(-max)
      try { writeFileSync(file, `${lines.join('\n')}\n`) } catch { /* 压不动就下次再读 */ }
    }
    for (const line of lines.slice(-max)) {
      try {
        const item = JSON.parse(line)
        if (typeof item?.seq === 'number' && item.seq > seq) seq = item.seq
        entries.push(item)
      } catch { /* 跳过损坏行 */ }
    }
  }

  return {
    /** @param {{ hostId, host, command, riskLevel, decision, actor?, detail? }} item */
    record(item) {
      load()
      seq += 1
      const entry = { seq, at: now(), ...item }
      entries.push(entry)
      if (entries.length > max) entries.splice(0, entries.length - max)
      if (file !== null) {
        try { appendFileSync(file, `${JSON.stringify(entry)}\n`) } catch { /* 旁路：落盘失败不影响执行 */ }
      }
      return entry
    },
    list({ hostId, limit = 100 } = {}) {
      load()
      let out = entries
      if (typeof hostId === 'string' && hostId.length > 0) out = out.filter(item => item.hostId === hostId)
      return out.slice(-Math.max(1, Math.min(limit, max))).reverse()
    },
    /** 清内存态（页面语义：清屏）。落盘的历史**不删** —— 审计不是可以随手擦掉的。 */
    clear() { entries.length = 0 },
    get size() { return entries.length },
    get file() { return file },
  }
}
