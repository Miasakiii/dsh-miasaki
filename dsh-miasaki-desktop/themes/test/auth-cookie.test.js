// 鉴权 cookie 兜底链的行为闸门（offline）。
//
// 被测对象是 `themes/src/00-boot.js` 里 `@slice:auth-cookie` 标记之间的那个 IIFE ——
// 它注入到 WebView2 的**每个文档**（document_start），负责：
//   ① 无 cookie 时用硬编码兜底 secret 签一枚 `dsh-auth-*`；
//   ② 有 cookie 时**按原值续写** `Max-Age`（不改值）；
//   ③ 401 文本页 → reload，但带 sessionStorage 跨文档熔断（上限 3 次，超限停止并显示提示）。
//
// 为什么必须离线钉死（2026-09-23 二轮复审 P2-B）：
//   原实现无条件用硬编码 secret 覆写 cookie。预置注入（main.rs set_auth_cookie）签入的是
//   `~/.dsh/.credentials.yaml` 里的**真** secret，两者一旦漂移，覆写就把**有效** cookie
//   换成无效的 ⇒ 首次导航成功、下次整页导航 401 ⇒ reload ⇒ 新文档再签错 ⇒ 无限刷新。
//   实机复现要造「secret 漂移 + 预置失败」场景，成本高且危险；这里用假浏览器把三条契约
//   钉死在接口层。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import vm from 'node:vm'

const source = await readFile(new URL('../src/00-boot.js', import.meta.url), 'utf8')

/** 截出被测 IIFE（含首尾标记注释，注释在 JS 里合法）。 */
const slice = (() => {
  const begin = source.indexOf('/* @slice:auth-cookie:begin')
  assert.notEqual(begin, -1, '00-boot.js 必须保留 @slice:auth-cookie:begin 标记')
  const end = source.indexOf('/* @slice:auth-cookie:end */', begin)
  assert.notEqual(end, -1, '00-boot.js 必须保留 @slice:auth-cookie:end 标记')
  return source.slice(begin, end)
})()

const RELOAD_KEY = 'miasaki.auth.reloads'
const AUTHORITY = '127.0.0.1:3080'
const FAIL_TEXT = 'dsh web authentication required; reopen the URL printed by dsh web.'

/** cookie jar 的最小实现：写 `name=value; attrs`，Max-Age=0 视为删除。 */
function applyCookieWrite(jar, write) {
  const [pair, ...attrs] = write.split(';')
  const eq = pair.indexOf('=')
  const name = pair.slice(0, eq).trim()
  const value = pair.slice(eq + 1)
  const kept = jar
    .split(';')
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => item.slice(0, item.indexOf('=')).trim() !== name)
  if (/max-age=0/i.test(attrs.join(';'))) return kept.join('; ')
  kept.push(`${name}=${value}`)
  return kept.join('; ')
}

/**
 * 造一个假浏览器。`docText` 非空即模拟「文档已有正文」（401 页传 FAIL_TEXT）。
 * `reloadCount` 预置 sessionStorage 里的熔断计数。
 */
function harness({ jar = '', docText = '', readyState = 'loading', reloadCount = 0 } = {}) {
  const state = { jar, writes: [], reloads: 0, timers: [], appended: [], listeners: {}, store: new Map() }
  if (reloadCount > 0) state.store.set(RELOAD_KEY, String(reloadCount))
  const body = docText === ''
    ? null
    : { textContent: docText, innerText: docText, appendChild: (el) => state.appended.push(el) }
  const document = {
    get cookie() { return state.jar },
    set cookie(write) { state.writes.push(write); state.jar = applyCookieWrite(state.jar, write) },
    body,
    documentElement: { textContent: docText },
    readyState,
    addEventListener: (name, fn) => { state.listeners[name] = fn },
    getElementById: (id) => state.appended.find(el => el.id === id) ?? null,
    createElement: () => ({ id: '', style: {}, textContent: '' }),
  }
  const sessionStorage = {
    getItem: (k) => (state.store.has(k) ? state.store.get(k) : null),
    setItem: (k, v) => { state.store.set(k, String(v)) },
    removeItem: (k) => { state.store.delete(k) },
  }
  const location = { origin: `http://${AUTHORITY}`, reload: () => { state.reloads += 1 } }
  state.document = document
  state.sessionStorage = sessionStorage
  state.location = location
  return state
}

/**
 * 跑一遍被测段。
 * `waitWrite`：无 cookie 的用例必须等**真实** `crypto.subtle` 签名落地（Node 的 webcrypto
 * 走 libuv 线程池，固定轮数的 setImmediate 会偶发抢跑 → 用例假红）。有 cookie 的路径不碰
 * crypto、纯 microtask，无需等待。
 */
async function run(state, { waitWrite = false } = {}) {
  const context = vm.createContext({
    location: state.location,
    document: state.document,
    sessionStorage: state.sessionStorage,
    crypto: webcrypto,
    setTimeout: (fn) => { state.timers.push(fn); return state.timers.length },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    TextEncoder,
    console,
  })
  vm.runInContext(slice, context, { filename: '00-boot.js#auth-cookie' })
  if (waitWrite) {
    const deadline = Date.now() + 2000
    while (state.writes.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  // 再把 then 链（ensureCookie → armChecks → check）排空。
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** 取某次 cookie 写入的名字与值。 */
function splitWrite(write) {
  const pair = write.split(';')[0]
  const eq = pair.indexOf('=')
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1), attrs: write.slice(eq + 1) }
}

test('预置 cookie 在场时不改写其值，只按原值续写 Max-Age（P2-B 主症状）', async () => {
  const preset = `dsh-auth-PRESET=v1.payload.signature`
  const state = harness({ jar: preset })
  await run(state)

  const authWrites = state.writes.map(splitWrite).filter(w => w.name.startsWith('dsh-auth-'))
  assert.equal(authWrites.length, 1, `只应有一次续期写入，实际 ${state.writes.length} 次：${JSON.stringify(state.writes)}`)
  assert.equal(authWrites[0].name, 'dsh-auth-PRESET')
  assert.equal(authWrites[0].value, 'v1.payload.signature', '值必须原样保留（覆写＝用可能漂移的兜底 secret 把有效 cookie 写坏）')
  assert.match(authWrites[0].attrs, /Max-Age=2592000/, '仍要升级为持久 cookie（原设计意图保留）')
  assert.equal(state.jar.includes('v1.payload.signature'), true)
})

test('无 cookie 时才用兜底 secret 签一枚 v1 三段的 cookie', async () => {
  const state = harness({ jar: '' })
  await run(state, { waitWrite: true })

  const authWrites = state.writes.map(splitWrite).filter(w => w.name.startsWith('dsh-auth-'))
  assert.equal(authWrites.length, 1, '无 cookie 必须签一次')
  assert.match(authWrites[0].name, /^dsh-auth-[\w-]+$/)
  assert.match(authWrites[0].value, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, '值形如 v1.<payload>.<sig>')
  assert.match(authWrites[0].attrs, /Path=\//)
  assert.match(authWrites[0].attrs, /Max-Age=2592000/)
  assert.match(authWrites[0].attrs, /SameSite=Strict/)
})

test('401 页在熔断计数未到上限时 reload 一次并推进计数', async () => {
  const state = harness({ docText: FAIL_TEXT, reloadCount: 0 })
  await run(state, { waitWrite: true })

  assert.equal(state.reloads, 1, '401 且未超限 → 应 reload')
  assert.equal(state.sessionStorage.getItem(RELOAD_KEY), '1', '计数必须落库（跨文档熔断的唯一凭据）')
  assert.equal(state.appended.length, 0, '未超限不显示提示条')
})

test('401 页超过熔断上限时停止 reload，并显示可见提示（不再无限刷新）', async () => {
  const state = harness({ docText: FAIL_TEXT, reloadCount: 3 })
  await run(state, { waitWrite: true })

  assert.equal(state.reloads, 0, '超过上限必须停止自动重载')
  const halt = state.appended.find(el => el.id === 'miasaki-auth-halt')
  assert.notEqual(halt, undefined, '必须留下可见提示（否则用户只看到纯文本 401 页，无从判断）')
  assert.match(String(halt.textContent), /鉴权 cookie 注入失败/)
  assert.equal(state.sessionStorage.getItem(RELOAD_KEY), '4', '计数继续推进，便于记录已重试次数')
})

test('正常文档（非 401）复位熔断计数，保证下次仍能自愈', async () => {
  const state = harness({ jar: 'dsh-auth-PRESET=v1.a.b', docText: '正常会话页', readyState: 'complete', reloadCount: 2 })
  await run(state)

  assert.equal(state.reloads, 0, '正常页绝不 reload')
  assert.equal(state.sessionStorage.getItem(RELOAD_KEY), null, '到达正常文档即复位（否则计数只增不减，终有一天误熔断）')
})

test('document_start（body 尚未解析）不误判为正常页，不误清计数', async () => {
  // 复现「本段跑在 document_start，is401() 必然 false」的时序：此时若清零，
  // 熔断计数永远归零、等于没有熔断。
  const state = harness({ docText: '', readyState: 'loading', reloadCount: 2 })
  await run(state, { waitWrite: true })

  assert.equal(state.reloads, 0)
  assert.equal(state.sessionStorage.getItem(RELOAD_KEY), '2', '未确认到达正常文档前不得复位')
})
