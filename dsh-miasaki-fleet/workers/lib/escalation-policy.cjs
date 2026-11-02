// escalation-policy.cjs — G5 语义分级闸门（2026-11-02）
//
// 为什么存在：fleet 既有闸门链（README「闸门顺序」）全是**资源/能力口径** ——
// 档案 / 开关 / 日预算 / 并发上限 / G1 可派 / G2 能力 / G4 验证 / 任务级 token 预算。
// 「这件事危不危险」这个**任务语义**维度此前没有任何判定：删数据、停服、对外发消息、
// 轮换密钥这类事与改一行文案走同一套闸门，而它们的善后成本差着数量级。
//
// 来源（借鉴，非照搬）：卡兹克《折腾了整整1年，毫无保留地分享一下我这套Agent自动化系统》
// （2026-11-02，https://mp.weixin.qq.com/s/2R9xtPdgYr3kF6L-LGr8aA）§5：
// 「必须先问我的就那么几类了，比如删数据、停服、花钱、对外发消息、改产品方向、
// 新建或轮换密钥、修改权限等等，剩下的，Agent 就自己全权做完上线。」
// 评估报告（_refs/article-borrow-2026-11-02-kazike-agent-automation.md）判定为 🟢 真缺口。
//
// 三条设计纪律：
//   1. **escalate 只提示不硬拒**：命中不改变派单退出码语义（0/2/3/4 分毫不动），
//      与 D4「escalate 只提示不硬拒」拍板同口径
//      （design/2026-10-29-gvs5h-harness-absorb-design.md §9-4）。
//      升级 = 醒目提示 + task.started 事件附 escalation 字段，供 Operator「批奏折」时检索。
//   2. **误报比漏报贵**：模式逐条收窄（如「修改权限」不匹配裸「权限」——fleet brief 里
//      「权限」高频出现于技术讨论）。误报会训练 Operator 忽略告警，那是把闸门变成噪声；
//      漏报只是这条任务没被提示，Commander 仍可能自己看出来。
//   3. 纯函数集中在写文件，CLI 只做 IO（与 schedule.cjs / source-gate 同纪律，便于单测）。

'use strict'

// ---------------------------------------------------------------------------
// 七类清单：每类的 pattern 都经过收窄，改动前先读上面第 2 条纪律
// ---------------------------------------------------------------------------

const CATEGORIES = [
  {
    category: 'delete_data',
    label: '删数据',
    pattern: /删除?数据|清理?数据|清除数据|清库|删库|数据清零|归档后删除|drop\s+(?:table|database|schema)|truncate\s+table|delete\s+from/i,
  },
  {
    category: 'stop_service',
    label: '停服',
    pattern: /停服|停机|停止服务|服务(?:下线|关停|终止)|下线服务|关停服务|系统维护停机|shutdown|decommission/i,
  },
  {
    category: 'spend_money',
    label: '花钱',
    pattern: /花钱|付费|购买|订阅费|支付(?:订单|费用|账单)?|充值|扣费|产生费用|采购|开发票|billing|invoice|purchase/i,
  },
  {
    category: 'external_message',
    label: '对外发消息',
    pattern: /对外发|群发|给用户发|发邮件给|对外公告|发布公告|广播消息|推送(?:给|至)用户|通知用户|mass\s*mail|broadcast/i,
  },
  {
    category: 'product_direction',
    label: '改产品方向',
    pattern: /改产品方向|产品方向|调整方向|改变方向|战略转向|路线调整|转型|pivot/i,
  },
  {
    // 「新建/创建/轮换/更换/重置/撤销/吊销」+ 8 字内出现「密钥/凭证/私钥/secret/credential/api key」；
    // 反向组合（密钥轮换）单独兜底。刻意不用裸「密钥」——「密钥管理」「密钥存放位置」是纯技术讨论。
    category: 'key_rotation',
    label: '密钥新建或轮换',
    pattern: /(?:新建|创建|轮换|更换|重置|撤销|吊销|泄露|泄露).{0,8}(?:密钥|凭证|私钥|secret|credential|api[_-]?key)|(?:密钥|凭证|私钥|secret|credential|api[_-]?key).{0,8}(?:轮换|更换|重置|撤销|吊销)|密钥轮换|凭证轮换/i,
  },
  {
    // 「修改/变更/调整/提升/开放/收紧/回收/授予」+ 10 字内出现「权限/permission」，或反向组合；
    // 裸「权限」「permission」不匹配（brief 里「权限不足」「只读权限」是技术陈述，不是改权限）。
    // 窗口取 10 是实测值：「修改该 agent 的权限配置」（动作词与「权限」相隔 9 字符）必须命中，
    // 而 10 字内尚不足以从「修改」跨到下一句的「权限」造成跨句误报。
    category: 'permissions',
    label: '修改权限',
    pattern: /(?:修改|变更|调整|提升|开放|收紧|回收|授予).{0,10}(?:权限|permission)|(?:权限|permission).{0,10}(?:变更|调整|提升|开放|收紧|回收)|提权|sudo|chmod|admin\s+rights/i,
  },
]

const MAX_EVIDENCE = 40

function isNonEmptyStr(v) {
  return typeof v === 'string' && v.trim() !== ''
}

function clip(s) {
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length > MAX_EVIDENCE ? `${t.slice(0, MAX_EVIDENCE)}…` : t
}

/**
 * 语义分级判定（纯函数）。
 *
 * @param {string} text 待判定文本（派单场景 = brief + context）
 * @returns {{escalate: boolean, hits: Array<{category: string, label: string, evidence: string}>}}
 *   hits 按 CATEGORIES 顺序去重（每类至多一条，evidence 取首个命中片段）
 */
function classifyEscalation(text) {
  const hits = []
  if (!isNonEmptyStr(text)) return { escalate: false, hits }
  for (const c of CATEGORIES) {
    const m = text.match(c.pattern)
    if (m) hits.push({ category: c.category, label: c.label, evidence: clip(m[0]) })
  }
  return { escalate: hits.length > 0, hits }
}

/** 七类清单的只读副本（CLI --list 与单测共用，避免两处硬编码）。 */
function listCategories() {
  return CATEGORIES.map((c) => ({ category: c.category, label: c.label }))
}

// ---------------------------------------------------------------------------
// CLI：只做 IO，判定全部走上面的纯函数
//   输入三选一：--text <s> | --file <path> | --stdin（派单器用管道，避开 Windows 命令行长度限制）
//   输出：--json 单行 JSON（派单器解析）；默认人类可读摘要
//   退出码：0 判定完成（含未命中） / 1 输入源读取失败 / 2 用法错误
// ---------------------------------------------------------------------------

function readStdinSync() {
  const fs = require('fs')
  try {
    return fs.readFileSync(0, 'utf8')
  } catch (e) {
    process.stderr.write(`[escalation] 读取 stdin 失败: ${e.message}\n`)
    process.exit(1)
  }
}

function main(argv) {
  const args = argv.slice(2)
  let text = null
  let json = false
  let list = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--json') json = true
    else if (a === '--list') list = true
    else if (a === '--stdin') text = readStdinSync()
    else if (a === '--text') {
      const v = args[++i]
      if (v === undefined) { process.stderr.write('[escalation] --text 缺参数\n'); process.exit(2) }
      text = v
    } else if (a === '--file') {
      const v = args[++i]
      if (v === undefined) { process.stderr.write('[escalation] --file 缺参数\n'); process.exit(2) }
      const fs = require('fs')
      try {
        text = fs.readFileSync(v, 'utf8')
      } catch (e) {
        process.stderr.write(`[escalation] 读取文件失败 ${v}: ${e.message}\n`)
        process.exit(1)
      }
    } else {
      process.stderr.write(`[escalation] 未知参数: ${a}\n`)
      process.exit(2)
    }
  }

  if (list) {
    process.stdout.write(`${JSON.stringify(listCategories())}\n`)
    process.exit(0)
  }
  if (text === null) {
    process.stderr.write('[escalation] 用法: --text <s> | --file <path> | --stdin [--json] | --list\n')
    process.exit(2)
  }

  const r = classifyEscalation(text)
  if (json) {
    process.stdout.write(`${JSON.stringify(r)}\n`)
  } else if (r.escalate) {
    process.stdout.write(`[escalation] 命中 ${r.hits.length} 类:\n`)
    for (const h of r.hits) process.stdout.write(`  - ${h.label}（${h.evidence}）\n`)
  } else {
    process.stdout.write('[escalation] 未命中七类清单\n')
  }
  process.exit(0)
}

if (require.main === module) main(process.argv)

module.exports = { classifyEscalation, listCategories, CATEGORIES }
