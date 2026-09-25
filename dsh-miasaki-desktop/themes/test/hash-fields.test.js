// hash-fields.test.js — hash 字段级读写行为闸门（W0-T0.2，2026-09-25）。
//
// 守什么：`location.hash` 是页面 → Rust 的唯一上行通道（33ms 轮询 + parse_fragment，
// main.rs:884-1188），但当时有**两个写者**：02-core.syncHash（主题/强度/活动/审批/diag）
// 与本节 petHashCmd（窗控命令 min/max/close/want-max），插件 dsh-pet-panel 也会追加。
// 旧实现两个缺陷：
//   ① 写入时从零构造 hash（`#miasaki-theme=…&cmd=…&seq=…`）⇒ 抹掉 int/act/wait/pet/diag；
//   ② 1600ms 后把 hash 整体清成只剩 miasaki-theme ⇒ 抹掉并发写者刚写的字段。
// 现改为**按字段精确增删**，并保留其它字段的**原始编码**（不能用 URLSearchParams.toString()，
// 它会把 `%20` 改写成 `+`、打乱 Rust 侧 percent-decode 的既有口径）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../src/05-sensors.js', import.meta.url), 'utf8')

const slice = (() => {
  const begin = source.indexOf('/* @slice:hash-fields:begin')
  assert.notEqual(begin, -1, '05-sensors.js 必须保留 @slice:hash-fields:begin 标记')
  const end = source.indexOf('/* @slice:hash-fields:end */', begin)
  assert.notEqual(end, -1, '05-sensors.js 必须保留 @slice:hash-fields:end 标记')
  return source.slice(begin, end)
})()

/**
 * 造一个假页面：location.hash + history.replaceState + 可手动触发的定时器。
 * @param hash 初始 hash（含或不含 `#`）
 * @param current 当前主题（锚点字段用）
 */
function harness({ hash = '', current = 'zafkiel' } = {}) {
  const timers = []
  const sandbox = {
    current,
    location: { hash: hash === '' ? '' : (hash.startsWith('#') ? hash : `#${hash}`) },
    history: {
      replaceState: (_state, _title, url) => {
        sandbox.location.hash = url
      }
    },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    }
  }
  vm.runInNewContext(slice, sandbox)
  return {
    sandbox,
    hash: () => sandbox.location.hash,
    /** 触发所有已登记的定时器（模拟 1600ms 到期）。 */
    fireTimers: () => { while (timers.length > 0) timers.shift().fn() },
    timerCount: () => timers.length
  }
}

test('写入 cmd/seq 时保留其它字段（不丢 int/act/wait/pet/diag）', () => {
  const h = harness({ hash: '#miasaki-theme=zafkiel&int=deep&act=busy&wait=1&diag=abc' })
  h.sandbox.setHashFields({ cmd: 'min', seq: '111' })
  const out = h.hash()
  assert.match(out, /int=deep/, 'int 被抹掉')
  assert.match(out, /act=busy/, 'act 被抹掉')
  assert.match(out, /wait=1/, 'wait 被抹掉')
  assert.match(out, /diag=abc/, 'diag 被抹掉')
  assert.match(out, /cmd=min/, 'cmd 未写入')
  assert.match(out, /seq=111/, 'seq 未写入')
})

test('保真其它字段的原始编码（%20 不得被改写成 +）', () => {
  const h = harness({ hash: '#miasaki-theme=zafkiel&pettool=Bash%20Tool&petkey=a%2Fb' })
  h.sandbox.setHashFields({ cmd: 'max', seq: '222' })
  const out = h.hash()
  assert.match(out, /pettool=Bash%20Tool/, '原始编码被改写（Rust 侧 percent-decode 口径会被打乱）')
  assert.match(out, /petkey=a%2Fb/, '原始编码被改写')
})

test('空 hash 写入时自动补 miasaki-theme 锚点（Rust 解析以此为锚）', () => {
  const h = harness({ hash: '', current: 'kurkuriel' })
  h.sandbox.setHashFields({ cmd: 'close', seq: '333' })
  assert.match(h.hash(), /miasaki-theme=kurkuriel/, '缺锚点')
  assert.match(h.hash(), /cmd=close/)
})

test('value 为 null 即移除该字段，其余字段不动', () => {
  const h = harness({ hash: '#miasaki-theme=zafkiel&cmd=min&seq=444&int=deep' })
  h.sandbox.setHashFields({ cmd: null, seq: null })
  const out = h.hash()
  assert.doesNotMatch(out, /cmd=/)
  assert.doesNotMatch(out, /seq=/)
  assert.match(out, /int=deep/, '移除字段时误伤其它字段')
})

test('readHashField 读到原值，字段不存在返回 null', () => {
  const h = harness({ hash: '#miasaki-theme=zafkiel&seq=555' })
  assert.equal(h.sandbox.readHashField('seq'), '555')
  assert.equal(h.sandbox.readHashField('nope'), null)
})

test('★ petHashCmd：命令写入后 1600ms 自行清除，但不误伤并发字段', () => {
  const h = harness({ hash: '#miasaki-theme=zafkiel&int=work' })
  h.sandbox.petHashCmd('max')
  assert.match(h.hash(), /cmd=max/)
  assert.match(h.hash(), /int=work/)
  assert.equal(h.timerCount(), 1, '应登记一个到期清理定时器')
  h.sandbox.setHashFields({ int: 'deep' }) // 模拟 02-core 在 TTL 内又写了字段
  h.fireTimers()
  assert.doesNotMatch(h.hash(), /cmd=/, 'TTL 到期后命令应清除')
  assert.match(h.hash(), /int=deep/, 'TTL 清理误伤了并发写入的字段')
})

test('★ seq 被他人覆盖时，TTL 到期不清除（避免抹掉后写的命令）', () => {
  const h = harness({ hash: '#miasaki-theme=zafkiel' })
  h.sandbox.petHashCmd('min')
  h.sandbox.setHashFields({ cmd: 'close', seq: '999' }) // 另一写者随后写入新命令
  h.fireTimers()
  assert.match(h.hash(), /cmd=close/, '旧 TTL 清掉了新命令')
  assert.match(h.hash(), /seq=999/)
})

test('形态纪律：不得回退成从零构造或整体清空', () => {
  assert.doesNotMatch(
    slice,
    /replaceState\(null,\s*'',\s*'#miasaki-theme='\s*\+\s*current\s*\)/,
    '发现「整体清成只剩 miasaki-theme」的旧写法'
  )
  assert.doesNotMatch(slice, /new URLSearchParams\(/, '不得用 URLSearchParams 重编码（会改写 %20 等）')
})
