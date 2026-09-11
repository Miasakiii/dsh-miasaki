import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * 会话头部窄宽度自适应（2026-09-10）。
 *
 * 现象：展开官方右侧边栏后中栏变窄，官方会话头一行放不下 —— titleCluster 被压到 0，
 * 其内部 flex:none 的 headerActions 溢出并压在 headerUtilities 上，画布切换器被图标按钮盖住。
 * 修复：画布切换器在「留给标题的余量」不足时降级为图标形态（≈116px → ≈64px）。
 *
 * 截取与求值手法：client.js 是 `__ModuleLoader__` bundle（没有 exports），判定逻辑按
 * 源码锚点截取后 `new Function` 求值 —— 锚点改名或挪位会**响亮失败**，不会静默通过。
 */
const CLIENT_URL = new URL('../client.js', import.meta.url)

/** 截取常量 + 判定函数并求值（该片段不引用 react）。 */
async function loadDecision() {
  const source = await readFile(CLIENT_URL, 'utf8')
  const start = source.indexOf('const COMPACT_ENTER_PX')
  const end = source.indexOf('const dialogGlyph')
  assert.notStrictEqual(start, -1, 'client.js 里找不到 COMPACT_ENTER_PX 锚点')
  assert.notStrictEqual(end, -1, 'client.js 里找不到 dialogGlyph 锚点')
  const code = source.slice(start, end)
  return new Function(`${code}\nreturn { compactDecision, COMPACT_ENTER_PX, COMPACT_RELEASE_PX }`)()
}

test('标题余量充足时不降级，余量不足时降级', async () => {
  const { compactDecision, COMPACT_ENTER_PX } = await loadDecision()
  assert.equal(compactDecision({ leftGap: 600, compact: false }), false)
  assert.equal(compactDecision({ leftGap: COMPACT_ENTER_PX, compact: false }), false, '恰好等于进入阈值时不切')
  assert.equal(compactDecision({ leftGap: COMPACT_ENTER_PX - 1, compact: false }), true)
  assert.equal(compactDecision({ leftGap: 0, compact: false }), true, '标题被完全挤没时必须降级')
})

test('滞回：降级后要明显更宽才恢复，且滞回带大于两种形态的宽度差', async () => {
  const { compactDecision, COMPACT_ENTER_PX, COMPACT_RELEASE_PX } = await loadDecision()
  assert.ok(COMPACT_RELEASE_PX > COMPACT_ENTER_PX, '退出阈值必须高于进入阈值')
  // 完整形态 ≈116px、紧凑形态 ≈64px，差 ≈52px：滞回带必须大于它，否则切换自身
  // 改变的占宽会把判定推回原形态，形成来回抖动。
  assert.ok(COMPACT_RELEASE_PX - COMPACT_ENTER_PX > 52, '滞回带应大于两种形态的宽度差')
  assert.equal(compactDecision({ leftGap: COMPACT_ENTER_PX + 10, compact: true }), true, '刚降级后的小幅回升不应立刻恢复')
  assert.equal(compactDecision({ leftGap: COMPACT_RELEASE_PX - 1, compact: true }), true)
  assert.equal(compactDecision({ leftGap: COMPACT_RELEASE_PX, compact: true }), false)
})

test('切换器观察 header 而不是自身，并在卸载时断开观察', async () => {
  const source = await readFile(CLIENT_URL, 'utf8')
  // 自身是 flex:none：被挤压时它自己的宽度不变，观察自身检测不到溢出。
  assert.match(source, /const header = node\.closest\('header'\)/)
  assert.match(source, /new ResizeObserver\(\(\) => measure\(\)\)/)
  assert.match(source, /observer\.observe\(header\)/)
  assert.match(source, /return \(\) => observer\.disconnect\(\)/)
  assert.doesNotMatch(source, /observer\.observe\(node\)/, '不应观察自身')
})

test('胶囊高度不超过官方 titleRow 的 min-height，否则会把整行撑高', async () => {
  const source = await readFile(CLIENT_URL, 'utf8')
  const block = source.slice(source.indexOf('.dsh-canvas-switch{'), source.indexOf('.dsh-canvas-switch button{'))
  // 上下 padding 必须为 0：3px 上下 padding + 1px 边框 ×2 + 28px 按钮 = 36px，会把官方
  // titleRow 从 min-height:30px 撑到 36px；行内所有控件（含官方 open-in-app、日志菜单、
  // 右栏展开按钮）居中后整体下移 (36-28)/2 = 4px，与固定定位的桌面窗控错开 —— 这正是
  // 2026-09-10 用户截图逐控件量出的 4px 偏差（会话头 cy≈22 vs 窗控 cy≈18）。
  // 0 上下 padding 时总高 = 1 + 28 + 1 = 30px，正好等于 titleRow 的 min-height。
  assert.match(block, /padding:0 3px/, '上下 padding 必须为 0')
  assert.doesNotMatch(block, /padding:3px/, '不应回退到 3px 上下 padding')
})

test('注入样式含会话头基线补偿，且与 desktop 主题注入同源同值', async () => {
  const source = await readFile(CLIENT_URL, 'utf8')
  // 官方 titleRow 中心 25px vs 右栏 dockkit chrome / 桌面窗控 24px ⇒ 差 1px，
  // 由这条把会话头三个容器整体上移补齐（桌面壳主题注入里有同源规则）。
  assert.match(source, /#root \[class\*="_headerActions"\],#root \[class\*="_headerUtilities"\],/)
  assert.match(source, /#root \[class\*="_headerCorner"\]\{position:relative;top:-1px\}/)
  // 两条通道（页面级注入 / 桌面壳编译期内嵌）写的是同一个值，这里顺带锁住 desktop 侧，
  // 防止只改一处造成两环境不一致。
  const switcher = await readFile(new URL('../../dsh-miasaki-desktop/themes/src/03-switcher.js', import.meta.url), 'utf8')
  assert.match(switcher, /top:-1px/, 'desktop 主题注入里的同源规则不应被移除')
})

test('让位规则带右栏展开门控：推挤展开时不再空出让位安全区', async () => {
  const source = await readFile(CLIENT_URL, 'utf8')
  // 必须是**覆写**，而不是给让位规则加 :not() 门控：已经发布出去的壳二进制里嵌着无条件的
  // 128px 让位规则（include_str! 编译期内嵌），源文件改了页面上的旧规则也不会消失 ——
  // 门控版在展开态"不匹配"，等于没人去覆盖它，让位照旧生效（上一版就是这么失效的）。
  // 覆写靠特异性取胜：#root:has([a][b]) header:has([c]) = (1,3,1) > 原规则 (1,1,1)。
  const override = /#root:has\(\[data-sidebar-right-panel="push"\]\[data-sidebar-right-open\]\) header:has\(\[data-conversation-header-corner\]\)\{padding-right:28px\}/
  assert.match(source, override, '本线注入应含展开态的覆写规则')
  // 两条通道必须逐字同一条：只改一处会在「桌面壳 / 纯浏览器」之间产生行为差。
  const switcher = await readFile(new URL('../../dsh-miasaki-desktop/themes/src/03-switcher.js', import.meta.url), 'utf8')
  assert.match(switcher, override, 'desktop 主题注入应含同一条覆写规则')
})

test('紧凑形态：class 开关、图标替换、可访问名与 CSS 收窄都在位', async () => {
  const source = await readFile(CLIENT_URL, 'utf8')
  assert.match(source, /compact \? 'dsh-canvas-switch is-compact' : 'dsh-canvas-switch'/)
  assert.match(source, /compact \? dialogGlyph\(\) : '对话'/)
  assert.match(source, /compact \? mapGlyph\(\) : '会话布'/)
  // 图标形态下按钮没有可见文字，aria-label / title 就是唯一可访问名 —— 必须保留。
  assert.match(source, /'aria-label': '对话', onClick: switchTo\('dialog'\)/)
  assert.match(source, /'aria-label': '会话布', onClick: switchTo\('map'\)/)
  assert.match(source, /\.dsh-canvas-switch\.is-compact button\{width:28px/)
})
