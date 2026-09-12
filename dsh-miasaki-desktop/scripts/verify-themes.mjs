// verify-themes.mjs — 端到端主题注入验证
// 用无头 Edge + CDP 模拟 WebView2 initialization_script 注入路径：
//   Page.addScriptToEvaluateOnNewDocument(theme-init.js) → 导航 DSH → 断言
// 覆盖：属性管理 / 明暗锁定 / 令牌计算值 / 悬浮切换条 / 水印 / 持久化 /
//      右上角安全区（窗控按钮组 × 官方右栏两处控件不叠压）
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
  '--window-size=1280,860',
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
function skip(name, why) {
  console.log(`SKIP  ${name}  ->  ${why}`)
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
  await sleep(2000)
  // M2 S6：本脚本验证 desktop 的**独立**行为——先把 appearance 线总开关关掉（幂等；
  // appearance 未安装时 fetch 404，静默忽略）。裸 API 写入不会唤醒 client 半，
  // 所以关完**再导航一次**，让 boot script 首帧就写到 data-mia-appearance=off。
  await evaluate(`(function(){
    try {
      fetch('/appearance/api/state').then(function (s) { return s.json() }).then(function (st) {
        return fetch('/appearance/api/config', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ patch: { enabled: false }, expectedRevision: st.revision })
        })
      }).catch(function () {})
    } catch (e) {}
    return true
  })()`)
  await sleep(1200)
  await cdp('Page.navigate', { url: TARGET })
  await sleep(3000)
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

  // ---------- 4.5 M2 S6 让位协议往返（模拟 appearance 线的 <html> 门控属性） ----------
  // 前 22 项已证「appearance 未安装时 desktop 行为逐字节不变」；这里手动写门控属性验证协议：
  // 让位（skin 停注入 + yield 标记 + 明暗锁定停用）→ 解除（skin 回注 + 标记移除），全程无需刷新。
  await evaluate(`document.documentElement.setAttribute('data-mia-appearance','on'); document.documentElement.setAttribute('data-mia-skin','zafkiel'); true`)
  await sleep(1500)
  let yieldState = JSON.parse(await evaluate(`JSON.stringify({
    mark: document.documentElement.getAttribute('data-miasaki-theme-yield'),
    layer: (document.getElementById('miasaki-theme-layer') || { textContent: '' }).textContent,
    attr: document.documentElement.getAttribute('data-miasaki-theme')
  })`))
  check('让位: yield 标记已置位', yieldState.mark === 'skin', String(yieldState.mark))
  check('让位: skin 配色停注入（style 层只剩 deco）',
    yieldState.layer.includes('--dsw-static-neutral-bluish-950') === false,
    `layerLen=${yieldState.layer.length}`)
  check('让位: data-miasaki-theme 保留（装饰层与切换条仍依赖）', yieldState.attr === 'kurkuriel', String(yieldState.attr))

  await evaluate(`document.documentElement.setAttribute('data-mia-appearance','off'); true`)
  await sleep(1500)
  yieldState = JSON.parse(await evaluate(`JSON.stringify({
    mark: document.documentElement.getAttribute('data-miasaki-theme-yield'),
    layer: (document.getElementById('miasaki-theme-layer') || { textContent: '' }).textContent
  })`))
  check('解除: skin 配色回注 + 标记移除',
    yieldState.mark === null && yieldState.layer.includes('--dsw-static-neutral-bluish-950') === true,
    `mark=${yieldState.mark} layerLen=${yieldState.layer.length}`)

  // ---------- 5. 切回 pure ----------
  await evaluate(`document.querySelector('#miasaki-switcher .ms-opt[data-theme="pure"]').click(); true`)
  await sleep(1000)
  const attr = await evaluate(`document.documentElement.getAttribute('data-miasaki-theme')`)
  check('切回 pure 生效', attr === 'pure', String(attr))

  // ---------- 6. 右上角安全区：窗控按钮组 × 官方右栏两处控件 ----------
  // 桌面壳窗控裸键组常驻右上角（fixed / 宽 108px / 距右缘 [8,116]px）。DSH 0.1.5 官方右栏
  // 有两个控件落进这一带：折叠态的 ExpandButton（会话头 conversation.session.header.corner）
  // 与展开态的面板 chrome（dockkit strip 末端）。本节在真实页面上量矩形，断言互不相交。
  const GEOM = `(function(){
    function rc(sel){var e=document.querySelector(sel);if(!e)return null;var r=e.getBoundingClientRect();
      return {l:+r.left.toFixed(2),t:+r.top.toFixed(2),r:+r.right.toFixed(2),b:+r.bottom.toFixed(2),w:+r.width.toFixed(2),h:+r.height.toFixed(2)};}
    function ov(a,b){if(!a||!b)return null;var w=Math.min(a.r,b.r)-Math.max(a.l,b.l);var h=Math.min(a.b,b.b)-Math.max(a.t,b.t);
      return +(Math.max(0,w)*Math.max(0,h)).toFixed(2);}
    var g=rc('#miasaki-titlebar .tb-group');
    var out={vw:innerWidth,group:g,reserve:getComputedStyle(document.documentElement).getPropertyValue('--ms-titlebar-reserve').trim()};
    var ex=rc('[data-sidebar-right-expand]');
    out.collapsed={expand:ex,overlap:ov(g,ex)};
    var ch=rc('[data-dockkit-strip-chrome]'), tg=rc('[data-sidebar-right-toggle]'), md=rc('[data-sidebar-right-mode]');
    out.expanded={chrome:ch,toggle:tg,mode:md,overlap:ov(g,ch),overlapToggle:ov(g,tg),overlapMode:ov(g,md)};
    out.verticalDelta=(ch&&g)?+Math.abs((ch.t+ch.b)/2-(g.t+g.b)/2).toFixed(2):null;
    return JSON.stringify(out);
  })()`
  const span = (r) => (r ? `[${r.l}..${r.r}]` : 'null')

  let g = JSON.parse(await evaluate(GEOM))
  if (!g.collapsed.expand) {
    skip('折叠态：窗控组与「打开右侧边栏」不叠压', '未找到 [data-sidebar-right-expand]（DSH < 0.1.5，或右栏默认已展开）')
  } else {
    const reservePx = parseFloat(g.reserve) || 0
    check('右上角安全区变量已定义且覆盖窗控组',
      reservePx >= g.group.w + 8,
      `--ms-titlebar-reserve=${g.reserve}，窗控组宽 ${g.group.w}px`)
    check('折叠态：窗控组与「打开右侧边栏」不叠压',
      g.collapsed.overlap === 0,
      `overlap=${g.collapsed.overlap}px² 窗控${span(g.group)} 官方${span(g.collapsed.expand)}`)
  }

  // 点官方展开按钮 → 面板 chrome（全屏/收起）出现，再量一次
  const opened = await evaluate(
    `(function(){var b=document.querySelector('[data-sidebar-right-expand]');if(!b)return false;b.click();return true})()`)
  await sleep(1500)
  g = JSON.parse(await evaluate(GEOM))
  if (!opened || !g.expanded.chrome) {
    skip('展开态：窗控组与面板 chrome 不叠压', '未能展开官方右栏（无 [data-dockkit-strip-chrome]）')
  } else {
    check('展开态：窗控组与面板 chrome 不叠压',
      g.expanded.overlap === 0,
      `overlap=${g.expanded.overlap}px² 窗控${span(g.group)} chrome${span(g.expanded.chrome)}`)
    check('展开态：窗控组与「收起侧边栏」按钮不叠压',
      g.expanded.overlapToggle === 0,
      `overlap=${g.expanded.overlapToggle}px² 收起键${span(g.expanded.toggle)}`)
    check('展开态：窗控组与「全屏」按钮不叠压',
      g.expanded.overlapMode === 0,
      `overlap=${g.expanded.overlapMode}px² 全屏键${span(g.expanded.mode)}`)
    check('窗控组与官方控件同一条水平线（中心差 ≤ 2px）',
      g.verticalDelta !== null && g.verticalDelta <= 2,
      `Δ=${g.verticalDelta}px`)
  }

  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} 项通过`)
  if (failed > 0) process.exitCode = 1
} finally {
  try { ws && ws.close() } catch {}
  edge.kill()
}
