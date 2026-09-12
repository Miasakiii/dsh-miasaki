// Unit tests for app.js's pure view-model helpers.
//
// app.js is a browser script; loading the whole file in node:vm with a stub
// window/document is safe (module level only defines functions and registers
// one DOMContentLoaded listener), so the pure helpers are called directly from
// the vm global — no DOM driving needed for these.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')

const context = vm.createContext({
  window: { addEventListener() {} },
  document: { addEventListener() {} },
})
vm.runInContext(source, context, { filename: 'app.js' })

test('matchesQuery covers label / user@host:port / group', () => {
  const conn = { label: 'web-01', host: 'web.example.com', port: 22, username: 'ops', group: '生产环境' }
  const matches = query => context.matchesQuery(conn, query)
  assert.equal(matches(''), true)
  assert.equal(matches('WEB-01'), true)
  assert.equal(matches('ops@web'), true)
  assert.equal(matches(':22'), true)
  assert.equal(matches('生产'), true)
  assert.equal(matches('nope'), false)
})

test('hostGroups filters, groups, and sorts favorites first / 未分组 last', () => {
  const connections = [
    { id: 'b', label: 'beta', host: 'b.example.com', port: 22, username: 'ops', group: '测试环境', favorite: false },
    { id: 'a', label: 'alpha', host: 'a.example.com', port: 22, username: 'ops', group: '生产环境', favorite: false },
    { id: 'c', label: 'gamma', host: 'c.example.com', port: 22, username: 'ops', group: '生产环境', favorite: true },
    { id: 'd', label: 'delta', host: 'd.example.com', port: 22, username: 'ops', group: '未分组', favorite: true },
    { id: 'e', label: 'hidden', host: 'h.example.com', port: 22, username: 'ops', group: '生产环境', favorite: false },
  ]
  const liveOf = () => 'idle'
  const groups = context.hostGroups(connections, '', liveOf)
  // vm realm 返回的数组须先浅拷贝再 deepEqual
  assert.deepEqual([...groups.map(g => g.name)], ['测试环境', '生产环境', '未分组'])
  assert.deepEqual([...groups[1].hosts.map(h => h.id)], ['c', 'a', 'e']) // 生产环境组内收藏 gamma 在前
  assert.deepEqual([...groups[2].hosts.map(h => h.id)], ['d'])
  // 搜索过滤：只有 beta 剩下，空组不出现
  const filtered = context.hostGroups(connections, 'beta', liveOf)
  assert.deepEqual([...filtered.map(g => g.name)], ['测试环境'])
  // 无 group 的连接落进「未分组」
  const ungrouped = context.hostGroups([{ id: 'x', label: 'x', host: 'x', port: 22, username: 'u' }], '', liveOf)
  assert.deepEqual([...ungrouped.map(g => g.name)], ['未分组'])
})

test('looksSuspiciousPaste flags multi-line / control-char payloads only', () => {
  assert.equal(context.looksSuspiciousPaste('ls -la'), false)
  assert.equal(context.looksSuspiciousPaste(''), false)
  assert.equal(context.looksSuspiciousPaste('with\ttab'), false) // Tab 放行
  assert.equal(context.looksSuspiciousPaste('rm -rf /\nyes'), true)
  assert.equal(context.looksSuspiciousPaste('a\rb'), true)
  assert.equal(context.looksSuspiciousPaste('null\x00byte'), true)
  assert.equal(context.looksSuspiciousPaste('esc\x1b[200~'), true) // ESC 也是控制字符：预览确认后才进终端
  assert.equal(context.looksSuspiciousPaste(undefined), false)
})

test('compositeOver blends translucent host colors onto a solid base', () => {
  // rgba(0,0,0,.5) over #ffffff → #808080
  assert.equal(context.compositeOver('rgba(0, 0, 0, 0.5)', '#ffffff'), '#808080')
  // 不透明色原样返回
  assert.equal(context.compositeOver('#123456', '#ffffff'), '#123456')
  // #rrggbbaa：#00000080 over #ffffff → alpha=128/255，(255−128)/255×255=127 → #7f7f7f
  assert.equal(context.compositeOver('#00000080', '#ffffff'), '#7f7f7f')
  // 解析失败原样返回（交给浏览器 CSS 处理）
  assert.equal(context.compositeOver('not-a-color', '#ffffff'), 'not-a-color')
})

test('tokenColor falls back when the host token is missing or unusable', () => {
  assert.equal(context.tokenColor(undefined, '#111111', '#ffffff'), '#111111')
  assert.equal(context.tokenColor('var(--unknown)', '#111111', '#ffffff'), '#111111')
  assert.equal(context.tokenColor('#rrggbbaa-nope', '#111111', '#ffffff'), '#111111')
  assert.equal(context.tokenColor('rgba(9, 9, 9, 0.5)', '#111111', '#ffffff'), '#848484')
  assert.equal(context.tokenColor('#3964fe', '#111111', '#ffffff'), '#3964fe')
})

test('composeXtermTheme yields a full 16-color palette and solid cursor', () => {
  const light = context.composeXtermTheme(false, { accent: '#3964fe' }, '#3964fe')
  assert.equal(light.background, '#ffffff')
  assert.equal(light.cursor, '#3964fe')
  assert.equal(light.selectionBackground, '#3964fe4d') // hex accent → 带 alpha 的选区
  assert.equal(Object.keys(light).filter(k => k.startsWith('bright')).length, 8)
  const dark = context.composeXtermTheme(true, {}, '#638aff')
  assert.equal(dark.background, '#15191f')
  assert.equal(dark.cursor, '#638aff')
  // 语义红绿在两套方案里含义一致（red=r 系 / green=g 系）
  assert.match(light.red, /^#b/d)
  assert.match(light.green, /^#[0-9a-f]/i)
  assert.notEqual(dark.red, dark.green)
})
