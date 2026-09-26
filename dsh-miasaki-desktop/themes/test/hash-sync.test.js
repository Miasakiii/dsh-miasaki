// hash-sync.test.js — `syncHash` 写入判重行为闸门（2026-09-26「一直在刷新」修复 P3）。
//
// 守什么：`02-core.syncHash` 由 `05-sensors` 的状态扫描每 1.5s 触发一次，而 pet-panel 的
// 心跳时间戳（`petts`）每轮都是新值 —— 旧实现**无条件** `history.replaceState`，于是壳侧
// 每轮都判为「fragment 变化」并重设桌宠。实测 pet.log 因此以 1.32 行/秒持续 5 小时
// （156945 行 / 4.7MB），用户观感即「一直在刷新，停不下来」。
//
// 现在的契约：
//   ① 目标 hash 与当前**逐字节一致** → 一次 `replaceState` 都不发（消除无谓 URL 变更）；
//   ② 只要有任何字段真的变了（含心跳推进）→ 必须照写，否则壳收不到真状态更新；
//   ③ 写入形态不变（字段顺序与命名仍是 Rust `parse_fragment` 的既有口径）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../src/02-core.js', import.meta.url), 'utf8')

const slice = (() => {
  const begin = source.indexOf('/* @slice:hash-sync:begin')
  assert.notEqual(begin, -1, '02-core.js 必须保留 @slice:hash-sync:begin 标记')
  const end = source.indexOf('/* @slice:hash-sync:end */', begin)
  assert.notEqual(end, -1, '02-core.js 必须保留 @slice:hash-sync:end 标记')
  return source.slice(begin, end)
})()

/**
 * 造一个假页面：可控时钟 + `history.replaceState` 记账 + 可控 pet-panel 心跳 +
 * 可选 Tauri IPC。
 * @param panel 初始 `window.__miasakiPetPanel`（null = 官方通道静默）
 * @param diag  每轮 `computeDiag()` 的返回（改它即模拟几何/诊断位变化）
 * @param tauri null = 无 IPC（浏览器/预览）；'ok' = 正常 resolve；'reject' = 异步拒绝
 */
function harness({ panel = null, diag = 'd0', tauri = null } = {}) {
  const calls = []
  const emits = []
  const sandbox = {
    DIAG_MIN_INTERVAL_MS: 10000,
    DIAG_AT: 0,
    DIAG_CACHE: diag,
    computeDiag: () => (typeof diag === 'function' ? diag() : diag),
    current: 'pure',
    CUR_INT: 'low',
    CUR_ACT: 'idle',
    CUR_WAIT: false,
    CUR_BG: '',
    now: 1_000_000,
    location: { hash: '' },
    history: {
      replaceState(_state, _title, url) {
        calls.push(url)
        sandbox.location.hash = url
      }
    },
    window: { __miasakiPetPanel: panel }
  }
  if (tauri) {
    sandbox.window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        emits.push({ cmd, args })
        return tauri === 'reject'
          ? Promise.reject(new Error('event emit denied'))
          : Promise.resolve(null)
      }
    }
  }
  sandbox.Date = { now: () => sandbox.now }
  vm.createContext(sandbox)
  vm.runInContext(slice, sandbox)
  return {
    sandbox,
    calls,
    emits,
    syncHash(force = false) {
      vm.runInContext(`syncHash(${force === true})`, sandbox)
    },
    /** 等异步路径（emit 被拒后的回落写入）落定。 */
    flush: () => new Promise((resolve) => setImmediate(resolve))
  }
}

test('首轮写入一次，形态仍是 parse_fragment 的既有口径', () => {
  const h = harness()
  h.syncHash()
  assert.equal(h.calls.length, 1)
  assert.match(h.calls[0], /^#miasaki-theme=pure&int=low&act=idle&wait=0&diag=d0$/)
})

test('★ P3 核心：内容逐字节一致时不再写 hash', () => {
  const h = harness()
  h.syncHash()
  assert.equal(h.calls.length, 1, '首轮必须写（建立锚点）')
  h.syncHash()
  h.syncHash()
  h.syncHash()
  assert.equal(h.calls.length, 1, '内容没变 → 一次 replaceState 都不该再发')
})

/** 官方通道心跳：ts 必须落在 syncHash 的 5s 新鲜度窗口内（否则 petPart 整段不写）。 */
function setPanel(h, ts) {
  h.sandbox.window.__miasakiPetPanel = { ts, state: 'idle', tool: '', key: '' }
}

test('P7 回落：无 IPC 环境（浏览器 / 预览）心跳推进仍照写 URL，行为不劣化', () => {
  const h = harness()
  setPanel(h, 999_700)
  h.syncHash()
  assert.equal(h.calls.length, 1)
  assert.match(h.calls.at(-1), /&petts=999700/)
  setPanel(h, 999_800)
  h.syncHash()
  assert.equal(h.calls.length, 2, '没有 IPC 时心跳只能走 URL，否则壳判通道静默、回落 DOM 兜底')
  assert.match(h.calls.at(-1), /&petts=999800/)
})

/* ---------------- 2026-09-26（下午）P7：心跳不再驱动 URL ----------------
 *
 * 背景（实测量，非推测）：pet-panel 每 1.5s 推进一次 `petts`，`05-sensors` 也每 1.5s 调一次
 * `syncHash` ⇒ P3 的顺序无关判重对心跳**永远不成立** ⇒ 每 1.5s 一次 replaceState。
 * WebView2 每次都留一条 History 记录（`visits` 88629 条 / 87MB、URL 每秒变 1–2 次），
 * 壳侧 `on_page_load` 也随之每 1.5s 触发并重复注入 120KB 脚本 —— 用户观感「一直在刷新」。
 * 下面的用例钉住修复后的三态契约：桌面端心跳走事件通道（URL 不动）、实质变化照写、
 * 事件被拒时回落写 URL（心跳绝不静默丢失）。
 */

test('★ P7 核心：桌面端心跳推进**不写 URL**，改经事件通道送达壳', () => {
  const h = harness({ tauri: 'ok' })
  setPanel(h, 999_700)
  h.syncHash()
  assert.equal(h.calls.length, 1, '首轮仍写一次 URL 建立锚点')
  h.emits.length = 0
  setPanel(h, 999_800)
  h.syncHash()
  assert.equal(h.calls.length, 1, '心跳推进不得再产生 URL 变更 —— 那正是本次事故的驱动源')
  assert.equal(h.emits.length, 1, '心跳必须经 IPC 送达，不能丢')
  assert.equal(h.emits[0].cmd, 'plugin:event|emit')
  assert.equal(h.emits[0].args.event, 'miasaki-pet-heartbeat')
  // 逐字段断言：payload 由 vm 沙箱 realm 构造，deepStrictEqual 会因跨 realm 原型不同而误报
  const payload = h.emits[0].args.payload
  assert.equal(payload.pet, 'idle')
  assert.equal(payload.pettool, '')
  assert.equal(payload.petkey, '')
  assert.equal(payload.petts, 999_800)
})

test('★ P7：IPC 被拒（异步 reject）→ 回落写 URL，心跳不静默丢失', async () => {
  const h = harness({ tauri: 'reject' })
  setPanel(h, 999_700)
  h.syncHash()
  setPanel(h, 999_800)
  h.syncHash()
  assert.equal(h.calls.length, 1, '同步路径先把心跳交给 IPC，不立刻写 URL')
  await h.flush()
  assert.equal(h.calls.length, 2, 'emit 被拒后必须回落写 URL')
  assert.match(h.calls.at(-1), /&petts=999800/)
})

test('★ P7：实质字段变化照旧写 URL（心跳通道不得退化成"永不写"）', () => {
  const h = harness({ tauri: 'ok' })
  setPanel(h, 999_700)
  h.syncHash()
  const before = h.calls.length
  h.sandbox.CUR_ACT = 'busy'
  setPanel(h, 999_800)
  h.syncHash()
  assert.equal(h.calls.length, before + 1, '实质状态变化必须写 URL')
  assert.match(h.calls.at(-1), /&act=busy/)
  assert.match(h.calls.at(-1), /&petts=999800/, '这次写入要把新心跳一并带上')
  assert.equal(h.emits.length, 0, '走 URL 的轮次不必再发事件（同一份状态只走一条通道）')
})

test('心跳同值重发（页面未更新）不产生新写入', () => {
  const h = harness()
  setPanel(h, 999_700)
  h.syncHash()
  setPanel(h, 999_700)
  h.syncHash()
  assert.equal(h.calls.length, 1)
})

test('任一真字段变化都必须写（活动 / 审批 / 主题 / 强度 / 底色）', () => {
  const cases = [
    ['CUR_ACT', 'busy', /&act=busy/],
    ['CUR_INT', 'high', /&int=high/],
    ['current', 'zafkiel', /^#miasaki-theme=zafkiel/],
    ['CUR_BG', '0c0b11', /&bg=0c0b11/]
  ]
  for (const [key, value, re] of cases) {
    const h = harness()
    h.syncHash()
    const before = h.calls.length
    h.sandbox[key] = value
    h.syncHash()
    assert.equal(h.calls.length, before + 1, `${key} 变化必须写`)
    assert.match(h.calls.at(-1), re)
  }

  const h = harness()
  h.syncHash()
  h.sandbox.CUR_WAIT = true
  h.syncHash()
  assert.match(h.calls.at(-1), /&wait=1/)
})

test('force=true 强制重算 diag：diag 变了必须写，否则样式层刚变的现场报不出去', () => {
  let diag = 'd0'
  const h = harness({ diag: () => diag })
  h.syncHash()
  assert.equal(h.calls.length, 1)
  diag = 'd1'
  // 未到节流窗口（DIAG_MIN_INTERVAL_MS）也不重算 → 无写入
  h.syncHash()
  assert.equal(h.calls.length, 1)
  // force 时立即重算 → diag 变 → 必须写
  h.syncHash(true)
  assert.equal(h.calls.length, 2)
  assert.match(h.calls.at(-1), /&diag=d1$/)
})

test('形态纪律：判重走的是"相同才跳过"，不得退化成"永不写"', () => {
  const h = harness()
  setPanel(h, 999_700)
  h.syncHash()
  h.sandbox.now = 1_001_000
  setPanel(h, 1_000_700)
  h.syncHash()
  h.sandbox.now = 1_002_000
  setPanel(h, 1_001_700)
  h.syncHash()
  assert.equal(h.calls.length, 3, '每轮心跳都不同 → 每轮都要写')
})

/* ---------------- 2026-09-26「刷新后无限刷新」修复 P4/P5 闸门 ----------------
 *
 * 背景（实测量，非推测）：WebView2 History 库 `urls` 表 79170 条、`visits` 88520 条、文件
 * 87MB；F5 之后每约 1.19s 一轮「基础 hash → want-max → 基础 hash」三条 URL 变更，
 * 而壳侧 pet.log 里**从头到尾没有一条 `hash-cmd want-max`**。
 * 根因之一：`syncHash` 从零构造 target，把 `petHashCmd` 刚写入的 `cmd/seq` 在约 1ms 后
 * 原样抹掉 —— 命令存活窗口短于壳侧 33ms 轮询周期，于是「最大化状态永远未知」→ 无限重试。
 * 下面两条钉住修复后的契约：**命令通道不得被状态通道踩掉**，且判等必须顺序无关。
 */

test('★ P4 核心：syncHash 不得抹掉 cmd/seq（命令通道优先于状态通道）', () => {
  const h = harness()
  h.syncHash()
  assert.equal(h.calls.length, 1)
  // 模拟 05-sensors.petHashCmd 的真实写入形态（追加 cmd+seq，其余字段原样保留）
  h.sandbox.location.hash = h.calls[0] + '&cmd=want-max&seq=1790358021'
  h.syncHash()
  assert.equal(h.calls.length, 1, '命令字段被保真 ⇒ 字段集合没变 ⇒ 连一次写入都不该产生')
  assert.ok(
    h.sandbox.location.hash.includes('cmd=want-max'),
    '命令必须还在 hash 里（否则壳侧 33ms 轮询永远抓不到）'
  )
})

test('★ P4：心跳推进时命令必须一起保留（旧实现在这里把命令吃掉）', () => {
  const h = harness()
  setPanel(h, 999_700)
  h.syncHash()
  h.sandbox.location.hash = h.calls.at(-1) + '&cmd=min&seq=7'
  setPanel(h, 999_800)
  h.syncHash()
  const last = h.calls.at(-1)
  assert.equal(h.calls.length, 2, '心跳推进必须照写')
  assert.match(last, /&petts=999800/, '新心跳要在')
  assert.match(last, /&cmd=min&seq=7$/, '命令与 seq 必须随这次写入一起保留，不得被抹掉')
})

test('★ P4：判等顺序无关（仅字段先后不同 → 不写，避免每轮 URL 变更）', () => {
  const h = harness()
  h.syncHash()
  const before = h.calls.length
  // 同一份状态、字段顺序打乱（pet-panel 走 URLSearchParams 重写时就是这样）
  h.sandbox.location.hash =
    '#cmd=want-max&seq=1&diag=d0&wait=0&act=idle&int=low&miasaki-theme=pure'
  h.syncHash()
  assert.equal(h.calls.length, before, '同一份状态换个字段顺序，不该再写一次 URL')
})

test('P4：未知字段一并保真（不替别的通道做主删字段）', () => {
  const h = harness()
  h.syncHash()
  h.sandbox.location.hash = h.calls[0] + '&future=1'
  h.syncHash()
  assert.equal(h.calls.length, 1, '未知字段被保真 ⇒ 集合相同 ⇒ 不写')
  h.sandbox.CUR_ACT = 'busy'
  h.syncHash()
  assert.equal(h.calls.length, 2, '真字段变化必须写')
  assert.match(h.calls.at(-1), /&future=1$/, '写回时未知字段仍要在')
})
