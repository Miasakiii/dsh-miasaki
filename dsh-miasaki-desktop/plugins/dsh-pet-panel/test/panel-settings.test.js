import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * 桌宠面板的**客户端设置层**（2026-09-29 新增）。
 *
 * 为什么要有测试：这两项（六态开关 / 主题跟随）是 `PetPanel` 唯一**不经过 Rust** 的
 * 设置 —— 心智模型上最容易被后来者当成「随手改改」的地方，而它们各有一个真实的
 * 坏路径：① 设置读坏 ⇒ 整份回默认（用户会以为「设置莫名丢了」）；② 写盘失败
 * （私密模式）⇒ 必须**如实告知**而不是假装保存成功。
 *
 * `lib/client.js` 是 `__ModuleLoader__` bundle（没有 exports），故按源码抽取求值——
 * 与 `dsh-miasaki-sidebar/test/sidechat-registry.test.js` 同一手法。
 */
const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

/** 抽取设置层常量与读写函数（注入 localStorage），并暴露内部 `panelSettings` 读口。 */
function loadPanelSettings(localStorage) {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const start = source.indexOf('const PANEL_SETTINGS_KEY = ')
  const end = source.indexOf('const petPanel = {')
  assert.notStrictEqual(start, -1, 'client.js 里找不到 PANEL_SETTINGS_KEY')
  assert.notStrictEqual(end, -1, 'client.js 里找不到 petPanel 锚点（抽取段的右边界）')
  const factory = new Function('localStorage',
    `${source.slice(start, end)}
     return { readPanelSettings, writePanelSettings, reloadPanelSettings,
              PANEL_SETTINGS_KEY, PANEL_SETTINGS_DEFAULTS,
              current: () => panelSettings }`)
  return factory(localStorage)
}

function makeStorage(initial = {}, { failWrite = false } = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (failWrite) throw new Error('QuotaExceededError')
      map.set(key, String(value))
    },
    removeItem: key => { map.delete(key) },
  }
}

const KEY = 'miasaki.petPanel.settings.v1'

test('无存储 ⇒ 默认全开（六态都显示、跟随主题）', () => {
  const s = loadPanelSettings(makeStorage())
  const v = s.readPanelSettings()
  assert.deepStrictEqual(v.states, { thinking: true, waiting: true, error: true, done: true })
  assert.strictEqual(v.followTheme, true)
})

test('坏 JSON / 形状不对 ⇒ 回默认且**不抛**（坏数据不该让面板崩）', () => {
  const corrupt = loadPanelSettings(makeStorage({ [KEY]: '{ 这不是 JSON' }))
  assert.doesNotThrow(() => corrupt.readPanelSettings())
  assert.deepStrictEqual(corrupt.readPanelSettings().states, { thinking: true, waiting: true, error: true, done: true })

  const wrongShape = loadPanelSettings(makeStorage({ [KEY]: '[1,2,3]' }))
  assert.deepStrictEqual(wrongShape.readPanelSettings().states, { thinking: true, waiting: true, error: true, done: true })
})

test('逐字段合并：缺字段按默认 true，显式 false 才生效（旧版本/手改文件都容得下）', () => {
  const partial = loadPanelSettings(makeStorage({ [KEY]: JSON.stringify({ states: { done: false } }) }))
  const v = partial.readPanelSettings()
  assert.strictEqual(v.states.done, false, '显式关掉的必须生效')
  assert.strictEqual(v.states.thinking, true, '没提到的字段按默认开')
  assert.strictEqual(v.followTheme, true, '缺 followTheme 也按默认开')

  const off = loadPanelSettings(makeStorage({ [KEY]: JSON.stringify({ followTheme: false }) }))
  assert.strictEqual(off.readPanelSettings().followTheme, false)
})

test('只有布尔 false 才算关：字符串 "false" 不生效（不猜用户意图）', () => {
  const s = loadPanelSettings(makeStorage({ [KEY]: JSON.stringify({ states: { done: 'false' }, followTheme: 0 }) }))
  const v = s.readPanelSettings()
  assert.strictEqual(v.states.done, true, '非布尔一律按默认（不把 "false" 当 false）')
  assert.strictEqual(v.followTheme, true, '0 同理')
})

test('写盘后能读回；写失败返回 false 且不抛（私密模式）', () => {
  const storage = makeStorage()
  const s = loadPanelSettings(storage)
  const next = { states: { thinking: false, waiting: true, error: true, done: false }, followTheme: false }
  assert.strictEqual(s.writePanelSettings(next), true)
  assert.deepStrictEqual(s.readPanelSettings(), next, '写什么读回什么')

  const priv = loadPanelSettings(makeStorage({}, { failWrite: true }))
  assert.doesNotThrow(() => priv.writePanelSettings(next))
  assert.strictEqual(priv.writePanelSettings(next), false, '写不进去必须如实返回 false')
})

test('reloadPanelSettings 刷新模块级缓存（心跳读的是它）', () => {
  const storage = makeStorage()
  const s = loadPanelSettings(storage)
  storage.map.set(KEY, JSON.stringify({ states: { error: false }, followTheme: false }))
  s.reloadPanelSettings()
  assert.strictEqual(s.current().states.error, false, 'reload 后模块级缓存必须看到新值')
  assert.strictEqual(s.current().followTheme, false)
})

/* ---------------- 源码契约：接线不能只加 UI 而不生效 ---------------- */

test('源码契约：心跳按设置过滤呈现，但内部状态机与真态都保留', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  assert.match(source, /panelSettings\.states\[state\] !== false/,
    '六态呈现必须过 settings 过滤 —— 只加 UI 不接线的「假设置」是本仓踩过的形态')
  assert.match(source, /petPanel\.rawState = state/, '必须保留真态，面板才能显示「当前真态 X（被你隐藏）」')
  assert.match(source, /const gated|state === "idle" \|\|/, 'idle 恒开（关掉它等于桌宠永不动）')
})

test('源码契约：主题联动有 followTheme 门，且只切断创建不动已建会话', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const at = source.indexOf('function ensurePersonaSession(ctx, theme)')
  assert.notStrictEqual(at, -1, 'client.js 里找不到 ensurePersonaSession')
  const body = source.slice(at, source.indexOf('const PET_PANEL_KEY', at))
  assert.match(body, /if \(!panelSettings\.followTheme\) return;/, '关掉跟随主题必须真的不建会话')
  assert.ok(!/remove|delete|clear/i.test(body), '不得删除已建会话（用户资产，删了不可逆）')
})

test('源码契约：apply 时初始化设置缓存（不把读盘放进 1.5s 心跳）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const at = source.indexOf('function apply(ctx)')
  assert.notStrictEqual(at, -1, 'client.js 里找不到 apply')
  const body = source.slice(at, source.indexOf('exports.apply', at))
  assert.match(body, /reloadPanelSettings\(\)/, 'apply 里必须初始化一次')
  const tickAt = source.indexOf('const tick = () => {')
  const tick = source.slice(tickAt, source.indexOf('tick();', tickAt))
  assert.ok(!/readPanelSettings\(\)/.test(tick), '心跳里不得读盘 + 解析（会白烧 CPU 并让告警刷屏）')
})

/* ---------------- 风格契约：与「通用设置」页同一套设计语言 ---------------- */

/**
 * 为什么这几条要写成闸门：面板**第一次做出来是裸 div + 内联样式**，功能全对但「跟别的设置页
 * 不像」——用户直接指出了这一点（2026-09-29：「太丑了，与其他设置页设计语言要统一」）。
 * 这类问题**功能测试一条都抓不到**，只能把「用官方原语 + 官方行式规格」写成断言钉住，
 * 否则下次改动又会滑回内联样式（口径照 `dsh-miasaki-appearance/test/client.test.js` 的风格契约）。
 */
test('风格契约：复用官方 UI 原语（名字须与 seed 导出表逐字一致）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  assert.match(source, /require\(["']@deepseek-ai\/dsh-client-ui-primitives["']\)/,
    '必须 require 官方 primitives —— 自造控件是「与其它设置页不像」的根因')
  for (const name of ['Switch', 'SegmentedControl', 'Button']) {
    assert.match(source, new RegExp(`PRIM\\.${name}\\b`),
      `必须经 PRIM.${name} 取原语（2026-09-23 事故：名字要与 dsh-web-frontend 的 seed 导出表逐字一致）`)
  }
  // 原语缺席时必须降级且留痕：面板是设置入口，不能整页白屏
  assert.match(source, /官方 UI 原语不可用，降级为原生控件/, '原语不可用要 console.warn 留痕，不静默')
})

test('风格契约：行式排版走 .mia-* 类，不再用内联样式摆布局', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  for (const cls of ['mia-panel', 'mia-group', 'mia-groupTitle', 'mia-row', 'mia-rowText', 'mia-title', 'mia-desc', 'mia-control', 'mia-stepper', 'mia-hint', 'mia-notice', 'mia-error']) {
    assert.ok(source.includes(cls), `CSS 里必须有 .${cls}（官方设置页规格）`)
  }
  // 行间距 / 分隔线必须是官方取值：0.5px 分隔线 + 16px 行距（FontSizeRow.row 规格）
  assert.match(source, /\.mia-row\{border-bottom:\.5px solid var\(--dsw-alias-border-l2\);align-items:center;gap:8px;padding:16px 0/,
    '行的分隔线与行距必须对齐官方 FontSizeRow.row')
  // 字号：标题 14/22、说明 12/18（官方 row.title / row.desc）
  assert.match(source, /\.mia-title\{[^}]*font-size:14px;font-weight:400;line-height:22px/, '标题须为官方 14/22')
  assert.match(source, /\.mia-desc\{[^}]*font-size:12px;font-weight:400;line-height:18px/, '说明须为官方 12/18')
})

test('风格契约：配色只走 --dsw-* 官方令牌（不硬编码颜色，才能跟皮肤明暗自动解析）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const marker = 'const PANEL_CSS = `'
  const cssAt = source.indexOf(marker)
  assert.notStrictEqual(cssAt, -1, '找不到 PANEL_CSS')
  // 从**模板字符串内容**的起点开始找收尾反引号：直接用 cssAt 找会把 `= \`` 自身当成结尾（切片为空）。
  const bodyAt = cssAt + marker.length
  const cssEnd = source.indexOf('`\n', bodyAt)
  assert.notStrictEqual(cssEnd, -1, '找不到 PANEL_CSS 的收尾反引号')
  const css = source.slice(bodyAt, cssEnd)
  assert.ok(css.length > 500, `PANEL_CSS 切片异常（${css.length} 字符）——切片写错会让本测试变成永远绿灯`)
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), `PANEL_CSS 里不得出现硬编码十六进制颜色：${(css.match(/#[0-9a-fA-F]{3,8}\b/) || [])[0]}`)
  assert.ok(!/rgba?\(/.test(css), 'PANEL_CSS 里不得出现硬编码 rgba()')
  assert.match(css, /var\(--dsw-alias-label-primary\)/, '主文本色须走 --dsw-alias-label-primary')
  assert.match(css, /var\(--dsw-alias-label-tertiary\)/, '说明文字色须走 --dsw-alias-label-tertiary')
})

test('风格契约：样式按 data-plugin-css 去重注入（HMR 重挂不重复注入）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  assert.match(source, /querySelector\(`style\[data-plugin-css="\$\{PANEL_CSS_ID\}"\]`\)/,
    '注入前必须按 data-plugin-css 查询去重——与官方 client 插件同一注入式')
  assert.match(source, /tag\.dataset\.pluginCss = PANEL_CSS_ID/, '必须打上 data-plugin-css 标记')
  assert.match(source, /document\.head \|\| document\.documentElement/, '挂到 head，拿不到就退到 documentElement')
})

test('风格契约：界面文案不得漏出 markdown 记号（** 会被当字面量显示）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const at = source.indexOf('return react.createElement("div", { className: "mia-panel" }')
  assert.notStrictEqual(at, -1, '找不到面板根节点')
  const body = source.slice(at, source.indexOf('function ensurePersonaSession', at))
  // **先剥掉注释再查**：`/**` 的 JSDoc 开头天然含 `**`，不剥会把注释误判成界面文案
  // （首版就是这么误报的——测试自身的假阳性比漏报更耗时间）。
  const noComments = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/\*\*/.test(noComments),
    '设置页文案是纯文本渲染，** 会原样显示成星号（先前「关掉某个状态只是**不显示**它」就漏过一次）')
})
