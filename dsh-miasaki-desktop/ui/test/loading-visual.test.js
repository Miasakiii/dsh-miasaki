// loading-visual.test.js — 启动页 S4a 视觉层契约（design/boot-loading-terminal.md §4.2）。
//
// 守什麽：2026-09-24 落地的「无 Rust 依赖」视觉层——纹章外环缓旋 / 呼吸光晕 /
// 舞台扫描线 / 就绪纹章回弹 / prefers-reduced-motion 降级。硬契约来自设计 §4.2 与 §4.4：
//   ① 动画属性只准 transform / opacity（性能预算：零 JS 动画循环、GPU 友好）；
//   ② 扫描线 opacity ≤ .06；零新增色（只准引用既有 --mia-* 变量）；
//   ③ reduced-motion 下全部静止；
//   ④ 类名一律 .mia-boot-* 前缀（禁哈希类名纪律）。
// 行为侧用 VM + 假浏览器驱动页面脚本，钉死就绪回弹触发（文案派生 + __setReady 幂等）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../loading.html', import.meta.url), 'utf8')

/** 截出 <style> 正文与 <script> 正文。 */
const style = (() => {
  const start = source.indexOf('<style>')
  const end = source.indexOf('</style>')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  return source.slice(start, end)
})()
const script = (() => {
  const start = source.lastIndexOf('<script>')
  const end = source.indexOf('</script>', start)
  assert.notEqual(start, -1)
  return source.slice(start + '<script>'.length, end)
})()

/** S4a 视觉层的三段 keyframes 名（扫描 / 旋转 / 呼吸 / 回弹）。 */
const KEYFRAMES = ['mia-boot-scan', 'mia-boot-spin', 'mia-boot-breathe', 'mia-boot-pop']

/**
 * 按花括号深度配平，取出 from 处所在块的**正文**（整块，非首个 `}` 之前的一段）。
 * CSS 的 @keyframes / @media 是嵌套花括号：只切到第一个内层 `}` 只能看到首个 stop，
 * 后面的 stop 写什么属性都看不见（2026-09-24 三轮复审指出的断言盲区）。
 */
const blockBody = (text, from) => {
  const open = text.indexOf('{', from)
  assert.notEqual(open, -1, `未找到块起始花括号：${text.slice(from, from + 48)}`)
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  assert.fail(`花括号未配平：${text.slice(from, from + 48)}`)
}

test('S4a 视觉层四件齐：扫描线 / 外环缓旋 / 呼吸光晕 / 就绪回弹', () => {
  for (const name of KEYFRAMES) {
    assert.ok(style.includes(`@keyframes ${name}`), `缺少 @keyframes ${name}`)
  }
  assert.ok(style.includes('.mia-boot-scan'), '缺少扫描线规则')
  assert.ok(style.includes('.mia-boot-ring'), '缺少外环缓旋规则')
  assert.ok(style.includes('.mia-boot-halo'), '缺少光晕规则')
  assert.ok(style.includes('body.mia-boot-ready .crest'), '缺少就绪回弹规则')
})

test('设计参数逐项对齐：扫描 4s/opacity≤.06、旋转 24s、呼吸 3s、回弹 600ms·1.06', () => {
  assert.match(style, /\.mia-boot-scan\s*\{[^}]*animation:\s*mia-boot-scan 4s linear infinite/)
  const scanOpacity = style.match(/\.mia-boot-scan\s*\{[^}]*opacity:\s*([\d.]+)/)
  assert.notEqual(scanOpacity, null, '扫描线必须显式声明 opacity')
  assert.ok(Number(scanOpacity[1]) <= 0.06, `扫描线 opacity ${scanOpacity[1]} 超过设计上限 .06`)
  assert.match(style, /\.mia-boot-ring\s*\{[^}]*animation:\s*mia-boot-spin 24s linear infinite/)
  assert.match(style, /\.mia-boot-halo\s*\{[^}]*animation:\s*mia-boot-breathe 3s ease-in-out infinite/)
  assert.match(style, /body\.mia-boot-ready \.crest\s*\{[^}]*animation:\s*mia-boot-pop \.6s ease-out/)
  assert.match(style, /@keyframes mia-boot-pop\s*\{[\s\S]*?scale\(1\.06\)/)
  assert.match(style, /\.mia-boot-ring\s*\{[^}]*transform-box:\s*fill-box/, 'SVG 子组旋转必须 transform-box: fill-box')
})

test('性能预算：所有 keyframes 只动画 transform / opacity（零布局属性、零 JS 循环）', () => {
  for (const name of KEYFRAMES) {
    const at = style.indexOf(`@keyframes ${name}`)
    assert.notEqual(at, -1, `缺少 @keyframes ${name}`)
    // 整块（深度配平）——只切到首个 `}` 会漏掉第二个及以后 stop 里的属性。
    const body = blockBody(style, at)
    const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map(m => m[1])
    assert.ok(props.length > 0, `${name} 没有动画属性`)
    for (const prop of props) {
      assert.ok(['transform', 'opacity'].includes(prop),
        `${name} 动画了 ${prop}——设计只准 transform/opacity（§4.4 性能预算）`)
    }
    // 截取范围的区分力自证（钉在被检查的 `body` 上，不能另取一次）：breathe 的第二条
    // stop（50%）必须落在正文里。退回「首个 `}`」的旧实现时正文只剩 0% 那条 ⇒ 本条红。
    if (name === 'mia-boot-breathe') {
      assert.match(body, /scale\(1\.09\)/, 'keyframes 截取必须覆盖全部 stop（含 50% 分支）')
    }
  }
  // 零 JS 动画循环：不得出现 rAF / setInterval 驱动的动画
  assert.ok(!/\brequestAnimationFrame\b/.test(script), '不得用 rAF 驱动视觉动画')
})

test('零新增色：S4a 规则只准引用既有 --mia-* 变量，不得出现新字面量颜色', () => {
  const newRules = [...style.matchAll(/\.mia-boot-[^{}]+\{[^}]*\}/g)].map(m => m[0])
  assert.ok(newRules.length >= 4, '应至少有 scan/ring/halo/ready 四条规则')
  for (const rule of newRules) {
    // 允许透明关键字与 var() 引用；#hex / rgb( / hsl( 一律视为新增色，直接红
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(rule), `规则引入字面量颜色：${rule.slice(0, 80)}`)
    assert.ok(!/\b(?:rgba?|hsla?)\(/.test(rule), `规则引入字面量颜色：${rule.slice(0, 80)}`)
  }
  // 亮主题（kurkuriel）同参数：扫描线/光晕靠 var(--mia-accent(-soft)) 自然换色
  assert.match(style, /\.mia-boot-scan\s*\{[^}]*var\(--mia-accent-soft\)/)
  assert.match(source, /class="mia-boot-halo"[^>]*fill="var\(--mia-accent\)"/, '光晕必须走主题 accent 变量')
})

test('reduced-motion 降级：全部动效静止、功能不变（设计 §6-6）', () => {
  const at = style.indexOf('@media (prefers-reduced-motion: reduce)')
  assert.notEqual(at, -1, '缺少 reduced-motion 降级块')
  // 括号配平截出整个 @media 块（第一条规则的 } 不是块尾）
  const block = blockBody(style, at)
  assert.match(block, /\.mia-boot-scan\s*\{[^}]*display:\s*none/)
  assert.match(block, /animation:\s*none/, 'reduced-motion 下必须有 animation:none')
  for (const sel of ['.mia-boot-ring', '.mia-boot-halo', 'body.mia-boot-ready .crest']) {
    assert.ok(block.includes(sel), `reduced-motion 未覆盖 ${sel}`)
  }
})

test('标记结构：扫描线 div + 三个纹章各带 halo 与旋转组（含 zafkiel 嵌套自闭合）', () => {
  assert.match(source, /<div class="mia-boot-scan" aria-hidden="true"><\/div>/)
  assert.equal((source.match(/class="mia-boot-halo"/g) ?? []).length, 3, '三个纹章各一枚光晕')
  assert.equal((source.match(/<g class="mia-boot-ring">/g) ?? []).length, 3, '三个纹章各一组外环')
  // SVG 组配平：ring 开标签各有一个对应闭标签（ crest 区域取 cr-pure 的 svg 起止）
  const opens = (source.match(/<g class="mia-boot-ring">/g) ?? []).length
  const crestStart = source.indexOf('<svg class="cr-pure"')
  const crestEnd = source.indexOf('</svg>', crestStart)
  const pureSvg = source.slice(crestStart, crestEnd)
  assert.equal((pureSvg.match(/<g class="mia-boot-ring">/g) ?? []).length, 1, 'pure 纹章应有且仅有一组旋转组')
  assert.equal((pureSvg.match(/<\/g>/g) ?? []).length, 1, 'pure 纹章旋转组必须闭合')
})

test('类名纪律：新增类一律 mia-boot- 前缀，无哈希类名', () => {
  const classes = [...source.matchAll(/class="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/))
  for (const cls of classes) {
    if (cls.startsWith('mia-boot')) {
      assert.match(cls, /^mia-boot-[a-z-]+$/, `新增类名不合规：${cls}`)
    }
  }
})

test('行为：就绪文案触发回弹且幂等；非就绪文案不触发', () => {
  // VM + 假浏览器驱动页面脚本（与 themes/test/auth-cookie.test.js 同一范式）
  const classes = new Set()
  const status = { textContent: '' }
  const listeners = {}
  const document = {
    readyState: 'complete',
    body: { classList: { add: c => classes.add(c), contains: c => classes.has(c) } },
    getElementById: id => (id === 'status' ? status : null),
    addEventListener: (type, fn) => { listeners[type] = fn },
  }
  const window = {}
  const context = vm.createContext({ window, document, console, Promise, btoa: s => s, atob: s => s })
  vm.runInContext(script, context, { filename: 'loading.html' })

  window.__setStatus('\u6b63\u5728\u68c0\u6d4b dsh\u2026')
  assert.equal(classes.has('mia-boot-ready'), false, '非就绪文案不得触发回弹')

  // 区分力①：**仅**「已就绪」，不带第二分支「正在进入」——必须命中正则第一分支。
  // 2026-09-24 三轮复审前该分支码位写错（\u5c31\u7ed3 =「就结」，死分支），本条当时会红。
  window.__setStatus('\u5df2\u5c31\u7eea')
  assert.equal(classes.has('mia-boot-ready'), true, '仅「已就绪」文案必须触发回弹（第一分支不可死）')

  // 复位后验 Rust 现用文案（两个分支都能命中）
  classes.delete('mia-boot-ready')
  window.__setStatus('\u5df2\u5c31\u7eea\uff0c\u6b63\u5728\u8fdb\u5165\u2026')
  assert.equal(classes.has('mia-boot-ready'), true, '就绪文案必须触发回弹')

  window.__setStatus('\u5df2\u5c31\u7eea\uff0c\u6b63\u5728\u8fdb\u5165\u2026')
  assert.equal([...classes].filter(c => c === 'mia-boot-ready').length, 1, '触发必须幂等')
})

test('行为：启动计时给出诚实读数，就绪即停（S4a-2）', async () => {
  const classes = new Set()
  const status = { textContent: '' }
  const timer = { textContent: '', style: { display: 'none' } }
  const document = {
    readyState: 'complete',
    body: { classList: { add: c => classes.add(c), contains: c => classes.has(c) } },
    getElementById: id => (id === 'status' ? status : id === 'boot-timer' ? timer : null),
    addEventListener: () => {},
  }
  const window = {}
  const context = vm.createContext({
    window, document, console, Promise, btoa: s => s, atob: s => s,
    setInterval, clearInterval,
  })
  vm.runInContext(script, context, { filename: 'loading.html' })

  // 即时一帧（不等 interval）就应有读数
  assert.match(timer.textContent, /^\u5df2\u7b49\u5f85 \d/, '加载即显示已等待读数')
  assert.equal(timer.style.display, 'block')
  // interval 推进后读数刷新
  await new Promise(r => setTimeout(r, 400))
  assert.match(timer.textContent, /^\u5df2\u7b49\u5f85 \d/)
  const before = timer.textContent
  await new Promise(r => setTimeout(r, 350))
  assert.notEqual(timer.textContent, before, '读数应随时间推进（250ms tick）')

  // 就绪 → 停表并隐藏
  window.__setStatus('\u5df2\u5c31\u7eea\uff0c\u6b63\u5728\u8fdb\u5165\u2026')
  assert.equal(timer.style.display, 'none', '就绪后计时隐藏')
  const frozen = timer.textContent
  await new Promise(r => setTimeout(r, 350))
  assert.equal(timer.textContent, frozen, '停表后读数不再变化')
})

test('S4a-2 契约：计时只读 elapsed、不出假百分比、reduced-motion 无需降级', () => {
  assert.match(source, /id="boot-timer"/, '缺少计时元素')
  assert.match(style, /#boot-timer\s*\{[^}]*tabular-nums/, '等宽数字防跳动')
  // 纪律：不出假百分比——只允许「已等待」读数，不得出现百分比形态
  assert.ok(!/%|percent/i.test(script.slice(script.indexOf('boot-timer') - 200)), '计时不得出现百分比（不假装）')
  // 计时是纯文本读数，@keyframes 白名单外的属性一个都不许动画
  assert.ok(!/boot-timer[\s\S]{0,120}animation/.test(style), '计时不得带动画')
})

test('行为：拖放安全网只拦文件拖放，官方已消费/文本链接不碰（S3）', () => {
  // design/drag-drop-attachment-upload.md §4.3：主窗禁用 tauri 拖放 handler 后，
  // 启动页 drop 落空会导航到 file:// 把启动页换掉。最小档判据：
  //   文件拖放 → 阻止默认；defaultPrevented（官方已消费）→ 放行；
  //   文本/链接拖放（types 不含 Files）→ 完全不干预（与官方同一判据）。
  const listeners = {}
  const document = {
    readyState: 'complete',
    body: { classList: { add() {}, contains: () => false } },
    getElementById: () => null,
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn) },
  }
  const window = {}
  vm.runInContext(script, vm.createContext({
    window, document, console, Promise, btoa: s => s, atob: s => s, setInterval, clearInterval,
  }), { filename: 'loading.html' })

  const drops = listeners.drop ?? []
  const overs = listeners.dragover ?? []
  assert.ok(drops.length >= 1, '必须注册 drop 监听（安全网在位）')
  assert.ok(overs.length >= 1, '必须注册 dragover 监听（不阻止则 drop 不触发）')
  const drop = drops[drops.length - 1]
  const over = overs[overs.length - 1]

  const mk = (types, prevented = false) => {
    let called = false
    return {
      dataTransfer: { types }, cancelable: true, defaultPrevented: prevented,
      preventDefault() { called = true },
      get stopped() { return called },
    }
  }
  const file = mk(['Files'])
  drop(file)
  assert.equal(file.stopped, true, '文件拖放必须阻止默认导航')
  const consumed = mk(['Files'], true)
  drop(consumed)
  assert.equal(consumed.stopped, false, '官方已消费（defaultPrevented）的 drop 必须放行')
  const text = mk(['text/plain'])
  drop(text)
  assert.equal(text.stopped, false, '文本/链接拖放不得干预')
  const anyOver = mk(['Files'])
  over(anyOver)
  assert.equal(anyOver.stopped, true, 'dragover 一律阻止（否则 drop 不触发）')
})
