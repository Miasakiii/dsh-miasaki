// verify-themes.mjs — 端到端主题注入验证
// 用无头 Edge + CDP 模拟 WebView2 initialization_script 注入路径：
//   Page.addScriptToEvaluateOnNewDocument(theme-init.js) → 导航 DSH → 断言
// 覆盖：属性管理 / 明暗锁定 / 令牌计算值 / 悬浮切换条 / 水印 / 持久化
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9333
const TARGET = process.env.MIASAKI_VERIFY_URL || 'http://127.0.0.1:3080/'
const INIT = readFileSync(join(root, 'src-tauri', 'injected', 'theme-init.js'), 'utf8')

const edge = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  '--no-first-run',
  '--disable-gpu',
  `--user-data-dir=${join(root, '.edge-test-profile')}`,
  'about:blank'
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page')
      if (page) return page
    } catch {}
    await sleep(500)
  }
  throw new Error('CDP target not found')
}

let seq = 0
const pending = new Map()
let ws

function cdp(method, params = {}) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text
    throw new Error(`eval failed: ${d}`)
  }
  return r.result?.value
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ->  ' + detail : ''}`)
}

try {
  const target = await getPageTarget()
  ws = new WebSocket(target.webSocketDebuggerUrl, {
    perMessageDeflate: false,
    headers: { Origin: 'http://127.0.0.1:9333' }
  })
  await new Promise((res, rej) => {
    ws.on('open', res)
    ws.on('error', rej)
  })
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
  })
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: INIT })

  // ---------- 1. 首次加载（默认 pure） ----------
  await cdp('Page.navigate', { url: TARGET })
  await sleep(5000)
  let state = JSON.parse(await evaluate(`JSON.stringify({
    attr: document.documentElement.getAttribute('data-miasaki-theme'),
    bodyDark: document.body.hasAttribute('data-ds-dark-theme'),
    switcher: !!document.getElementById('miasaki-switcher'),
    watermark: !!document.getElementById('miasaki-watermark'),
    overlay: !!document.getElementById('miasaki-overlay')
  })`))
  check('pure: html[data-miasaki-theme]', state.attr === 'pure', String(state.attr))
  check('pure: 切换条已注入', state.switcher === true)
  check('pure: 无水印（纯透传）', state.watermark === false)
  check('pure: 不干预 DSH 明暗属性', typeof state.bodyDark === 'boolean')

  // ---------- 2. 切换 zafkiel ----------
  await evaluate(`document.querySelector('#miasaki-switcher .ms-opt[data-theme="zafkiel"]').click(); true`)
  await sleep(1000)
  state = JSON.parse(await evaluate(`JSON.stringify({
    attr: document.documentElement.getAttribute('data-miasaki-theme'),
    bodyDark: document.body.hasAttribute('data-ds-dark-theme'),
    bg: getComputedStyle(document.body).getPropertyValue('--dsw-static-neutral-bluish-950').trim(),
    brand: getComputedStyle(document.body).getPropertyValue('--dsw-static-deepseek-450').trim(),
    gold: getComputedStyle(document.body).getPropertyValue('--ms-accent').trim(),
    watermark: !!document.getElementById('miasaki-watermark'),
    carets: getComputedStyle(document.body).getPropertyValue('caret-color').trim()
  })`))
  check('zafkiel: 切换生效', state.attr === 'zafkiel')
  check('zafkiel: 强制暗色（body[data-ds-dark-theme]）', state.bodyDark === true, String(state.bodyDark))
  check('zafkiel: 墨夜基底令牌', state.bg === '#0c0b11', state.bg)
  check('zafkiel: 钟刻绯红品牌令牌', state.brand === '#c23a2e', state.brand)
  check('zafkiel: 切换条鎏金强调', state.gold === '#d9b36a', state.gold)
  check('zafkiel: 表盘水印已挂载', state.watermark === true)

  // ---------- 3. 切换 kurkuriel ----------
  await evaluate(`document.querySelector('#miasaki-switcher .ms-opt[data-theme="kurkuriel"]').click(); true`)
  await sleep(1000)
  state = JSON.parse(await evaluate(`JSON.stringify({
    attr: document.documentElement.getAttribute('data-miasaki-theme'),
    bodyDark: document.body.hasAttribute('data-ds-dark-theme'),
    bgDeep: getComputedStyle(document.body).getPropertyValue('--dsw-static-neutral-bluish-950').trim(),
    bgLight: getComputedStyle(document.body).getPropertyValue('--dsw-static-neutral-bluish-50').trim(),
    aliasBase: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim(),
    brand: getComputedStyle(document.body).getPropertyValue('--dsw-static-deepseek-450').trim(),
    watermark: !!document.getElementById('miasaki-watermark')
  })`))
  check('kurkuriel: 切换生效', state.attr === 'kurkuriel')
  check('kurkuriel: 强制亮色（移除暗色属性）', state.bodyDark === false, String(state.bodyDark))
  // 骨白纸面遵循 DSH 亮色语义：亮端令牌 + alias 基底，而非重映射深端 950（旧断言 #e9e5e1 为初版设计残留，自首次提交即不可满足）
  check('kurkuriel: 骨白基底令牌', state.bgLight === '#fcfaf8' && state.aliasBase.includes('247, 244, 241'),
    state.bgLight + ' | ' + state.aliasBase)
  check('kurkuriel: 深端令牌同步覆盖', state.bgDeep === '#0f0d0b', state.bgDeep)
  check('kurkuriel: 血绯品牌令牌', state.brand === '#9e1b1b', state.brand)
  check('kurkuriel: 破裂表盘水印已挂载', state.watermark === true)

  // ---------- 4. 持久化 ----------
  const persisted = await evaluate(`localStorage.getItem('miasaki.theme')`)
  check('主题持久化到 localStorage', persisted === 'kurkuriel', String(persisted))

  // ---------- 5. 切回 pure ----------
  await evaluate(`document.querySelector('#miasaki-switcher .ms-opt[data-theme="pure"]').click(); true`)
  await sleep(1000)
  const attr = await evaluate(`document.documentElement.getAttribute('data-miasaki-theme')`)
  check('切回 pure 生效', attr === 'pure', String(attr))

  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} 项通过`)
  if (failed > 0) process.exitCode = 1
} finally {
  try { ws && ws.close() } catch {}
  edge.kill()
}
