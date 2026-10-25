// schema-version.cjs — P2-E（2026-10-21）：manifest / observed 的 schema 版本与迁移
//
// 为什么需要：P0-A 起 manifest 字段持续增加，P2-B 又拆出 observed.json。没有版本号时，
// 「这份档案按哪版契约解释」只能靠猜；迁移脚本也无法判断「已迁移 / 待迁移 / 未来版本」。
//
// 语义：
//   · `schema_version` 是**档案契约版本**（不是总线超步版本，也不是 package 版本）；
//   · 当前 = 2（v1 = P0-A 的单 manifest；v2 = P2-B 起 manifest Operator + observed 事实）；
//   · **缺席 = v1（legacy）**，允许读（兼容窗口），迁移脚本补到 2；
//   · **大于当前 = future** ⇒ 显式拒绝（不猜新字段语义）；
//   · 迁移只做「标注版本」，**不重排/不改字段内容**（字段迁移由扫描器负责，见 P2-B）。

'use strict'

const CURRENT_SCHEMA_VERSION = 2
const MIN_SCHEMA_VERSION = 1

/** 合法版本号：整数且 1 ≤ v ≤ 当前。 */
function isValidSchemaVersion(v) {
  return Number.isInteger(v) && v >= MIN_SCHEMA_VERSION && v <= CURRENT_SCHEMA_VERSION
}

/**
 * 分类一份档案/观测文档的版本状态：
 *   missing（缺席 = v1 legacy）/ legacy（1）/ current（2）/ future（>2）/ invalid（非整数）
 * @returns {{status: 'missing'|'legacy'|'current'|'future'|'invalid', version: number|null}}
 */
function classifySchema(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { status: 'invalid', version: null }
  const v = doc.schema_version
  if (v === undefined || v === null) return { status: 'missing', version: null }
  if (!Number.isInteger(v) || v < MIN_SCHEMA_VERSION) return { status: 'invalid', version: v }
  if (v > CURRENT_SCHEMA_VERSION) return { status: 'future', version: v }
  if (v === CURRENT_SCHEMA_VERSION) return { status: 'current', version: v }
  return { status: 'legacy', version: v }
}

/**
 * 纯函数迁移：把 schema_version 标到当前版本。
 * 其余字段**原样保留**（迁移不负责字段重排；那属于扫描器的职责，见 P2-B）。
 * @returns {{changed: boolean, from: object|null, doc: object|null, reason: string}}
 */
function migrateSchema(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { changed: false, from: null, doc: null, reason: '文档不是 object' }
  }
  const c = classifySchema(doc)
  if (c.status === 'current') return { changed: false, from: c, doc, reason: '已是当前版本' }
  if (c.status === 'future') return { changed: false, from: c, doc, reason: `未来版本 ${c.version}，拒绝降级` }
  if (c.status === 'invalid') return { changed: false, from: c, doc, reason: `版本号非法：${JSON.stringify(doc.schema_version)}` }
  return { changed: true, from: c, doc: Object.assign({}, doc, { schema_version: CURRENT_SCHEMA_VERSION }), reason: c.status === 'missing' ? '补标 version=2（legacy 缺席）' : `升级 ${c.version} → ${CURRENT_SCHEMA_VERSION}` }
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  MIN_SCHEMA_VERSION,
  isValidSchemaVersion,
  classifySchema,
  migrateSchema,
}
