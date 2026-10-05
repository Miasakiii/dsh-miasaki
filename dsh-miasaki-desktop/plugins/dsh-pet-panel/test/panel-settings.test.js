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

/* ---------------- E1：error 态的老化（快照驱动的必要时效） ---------------- */

/**
 * 为什么这一组必须是**行为**测试而不是源码正则：
 * 老化窗口的失败形态是「时间算错了」——正则能匹配到 `ERROR_STALE_MS` 这个符号，
 * 却证明不了「同一错误连续观测 20 次不会被无限顺延」这条最容易写坏的性质。
 * 那是本组的核心断言，必须真跑。
 *
 * 取证前提（决定了这组测试存在的理由，已实测 vendor 源码）：
 * `dsh-api-session-controller/lib/client.js:2001` 写入 `lastAgentError`，
 * 只有 `:1697 prompt()` 与 `:1586 reset()` 清回 null，**无自动清除路径**
 * ⇒ 快照驱动若直接判 error，一次偶发错误会让桌宠永久停在「出错了」。
 */
function loadErrorFreshness() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const start = source.indexOf('const ERROR_STALE_MS = ')
  assert.notStrictEqual(start, -1, 'client.js 里找不到 ERROR_STALE_MS')
  // 右边界取 `startPetStateReporter`：这一段里还夹着 `readPendingApproval` /
  // `readRunningAggregate`，它们引用 `window` / `ctx`（本测试不需要，注入桩即可）。
  const end = source.indexOf('function startPetStateReporter', start)
  assert.notStrictEqual(end, -1, '找不到 startPetStateReporter（抽取段右边界）')
  const seg = source.slice(start, end)
  assert.match(seg, /function makeFreshError\(\)/, '抽取段必须含 makeFreshError（边界收窄过头了）')
  // 形参给被吞进来的两个读取函数提供 `ctx` / `window` / `PET_PANEL_KEY` 绑定 ——
  // `PET_PANEL_KEY` 声明在 `ERROR_STALE_MS` **之前**，落在这个抽取段之外，
  // 所以只能当自由变量注入（首版就是漏了它，报 'PET_PANEL_KEY is not defined'）。
  const factory = new Function('ctx', 'window', 'PET_PANEL_KEY', `${seg}
     return { ERROR_STALE_MS, makeFreshError }`)
  return factory({}, {}, '__miasakiPetPanel')
}

test('E1：新错误立即呈现，同一错误持续存在则在窗口后老化', () => {
  const { ERROR_STALE_MS, makeFreshError } = loadErrorFreshness()
  const t0 = 1_000_000
  const f = makeFreshError()

  assert.strictEqual(f('boom', t0), true, '首次见到就该是 error')
  assert.strictEqual(f('boom', t0 + 1000), true, '窗口内重复观测仍是 error')
  assert.strictEqual(f('boom', t0 + ERROR_STALE_MS - 1), true, '窗口边界内仍新鲜')
  assert.strictEqual(f('boom', t0 + ERROR_STALE_MS), false, '到窗口即老化')
  assert.strictEqual(f('boom', t0 + ERROR_STALE_MS + 60_000), false, '老化后不会自己复活')
})

test('E1·反例：重复观测不得顺延计时（否则每 1.5s 刷一次就永不老化）', () => {
  const { ERROR_STALE_MS, makeFreshError } = loadErrorFreshness()
  const t0 = 5_000_000
  // 观测跨度必须**严格大于**窗口，否则测不到顺延：判定是 `now - errorSince < 窗口`，
  // 跨度恰等于窗口时最后一拍本就应判 false（首版按 20 拍算得 30000ms = 窗口本身，
  // 断言却写成 `>`，自己把前提算错成了失败）。
  const beats = Math.floor(ERROR_STALE_MS / 1500) + 2
  assert.ok(beats * 1500 > ERROR_STALE_MS,
    `观测跨度须严格大于窗口：${beats} 拍 × 1500ms = ${beats * 1500}ms vs 窗口 ${ERROR_STALE_MS}ms`)
  const f = makeFreshError()
  f('boom', t0)
  // 模拟多次心跳观测（每拍 +1500ms = PET_HB_MS）
  let last = true
  for (let i = 1; i <= beats; i++) last = f('boom', t0 + i * 1500)
  assert.strictEqual(last, false,
    `连续 ${beats} 拍观测后必须已老化——顺延计时会让 error 永久挂着`)
})

test('E1：换一条错误 ⇒ 重新计时（连续不同错误不被压成一次）', () => {
  const { ERROR_STALE_MS, makeFreshError } = loadErrorFreshness()
  const t0 = 9_000_000
  const f = makeFreshError()
  f('boom-A', t0)
  assert.strictEqual(f('boom-A', t0 + ERROR_STALE_MS), false, 'A 已老化')
  assert.strictEqual(f('boom-B', t0 + ERROR_STALE_MS), true, 'B 是新错误 ⇒ 立即重新计时')
  assert.strictEqual(f('boom-B', t0 + ERROR_STALE_MS + 1000), true, 'B 的窗口从头算')
})

test('E1：官方清空（错误消失）后复位，下一条错误重新计时', () => {
  const { makeFreshError } = loadErrorFreshness()
  const t0 = 13_000_000
  const f = makeFreshError()
  f('boom', t0)
  assert.strictEqual(f(null, t0 + 1000), false, '字段空 ⇒ 不再是 error')
  assert.strictEqual(f(undefined, t0 + 2000), false, 'undefined 同样按空处理')
  assert.strictEqual(f('', t0 + 3000), false, '空串同样按空处理（不猜用户意图）')
  // 复位后再来一条**同文**错误：必须当作新的（指纹已清 ⇒ 不复用旧时刻）
  assert.strictEqual(f('boom', t0 + 4000), true, '复位后同文错误也算新错误')
})

/* ---------------- E2 / E3：接线契约 ---------------- */

test('E2：动效强度下限放行到 0（Rust 常量与面板 stepper 必须同步）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const at = source.indexOf('stepper(shell.motion,')
  assert.notStrictEqual(at, -1, '找不到动效强度 stepper')
  // **不能只取单行**：`min` 落在 stepper 的第 4 个参数行上（首版按 `\n` 截断，
  // 拿到的是首行 `'stepper(shell.motion, ...'` 而漏了 min —— 测试自身写错，不是代码错）。
  // 右边界取下一个 row(...) 标题。
  const seg = source.slice(at, source.indexOf('row("气泡时长"', at))
  assert.match(seg, /min:\s*0\s*,/, '面板 stepper 的 min 必须同步为 0 —— Rust 下限改了而这里还写 0.5，E2 等于没做')
  assert.ok(!/min:\s*0\.5/.test(seg), '不得残留 0.5 下限（那正是本项要修的）')
  // 面板文案须说清 0× 的语义，否则用户不知道 0 是「关闭」还是「坏了」
  const row = source.slice(source.lastIndexOf('row("动效强度"', at), at)
  assert.match(row, /完全关闭/, '「动效强度」说明里必须写清 0× 的含义')
})

test('E2·Rust 侧：MOTION_MIN 必须是 0.0 且 0 是合法值（不被当缺失回落）', () => {
  const rsPath = join(dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', 'src-tauri', 'src', 'pet_native', 'settings.rs')
  const rs = readFileSync(rsPath, 'utf8')
  assert.match(rs, /pub\(crate\) const MOTION_MIN: f32 = 0\.0;/,
    'MOTION_MIN 必须放行到 0.0（0.5 会让「减少动效」无法真正落地）')
  // 落盘路径是 f32 + serde(default)：0.0 是合法反序列化值，不会被当缺失回默认。
  // 真正的陷阱在写入侧 normalize —— 它必须 clamp 而不是「非零才写」。
  const norm = rs.slice(rs.indexOf('pub(crate) fn normalize'), rs.indexOf('#[cfg(test)]'))
  assert.match(norm, /self\.motion = self\.motion\.clamp\(MOTION_MIN, MOTION_MAX\)/,
    'normalize 必须 clamp（含 0.0），不得改成 truthy 判定')
})

test('E3：awaitingFirstTurn 参与合成（补「已提交但 turn 未到」的空窗）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const at = source.indexOf('function readRunningAggregate(ctx)')
  assert.notStrictEqual(at, -1, '找不到 readRunningAggregate')
  const body = source.slice(at, source.indexOf('const PET_PANEL_KEY', at))
  assert.match(body, /s\.awaitingFirstTurn/, '必须读官方 awaitingFirstTurn（snapshot.d.ts:80）')
  assert.match(body, /if \(s\.awaitingFirstTurn\) starting = true;/,
    '命中时须置 starting（list row 只有 running，拿不到这个字段）')
  assert.match(body, /return \{ running: running, starting: starting,/,
    'starting 必须随聚合结果返回（漏了则合成链读到 undefined）')
  const tick = source.slice(source.indexOf('const tick = () => {'), source.indexOf('tick();'))
  assert.match(tick, /agg\.running \|\| agg\.starting/, '合成链须把 starting 并入 thinking')
})

/* ---------------- G2：done 庆祝的冷却窗口 ---------------- */

/**
 * G2 的**硬限制**（实测，别再试图绕过）：官方 `SessionSnapshot`（`snapshot.d.ts:56-90`）
 * 共 12 个字段，**没有 goal 状态、没有 turnId、没有回合边界** ⇒ 上游那套
 * 「goal 续跑轮中间轮 → result、收尾轮才 success」在快照驱动下**没有数据源**。
 * 能观测到的只有 `running` 布尔，它在多轮任务期间会 true→false→true 抖动。
 *
 * 所以冷却窗口是**近似而非真解**：它保证「首次庆祝不被挡」+「连续庆祝被拉开到 ≥45s」，
 * 但 45s 内跑完的多轮任务**仍会各庆祝一次**。测试必须钉住的是**这个实际语义**，
 * 而不是「多轮任务只庆祝一次」—— 那会写出一条永远转红的假断言。
 */
test('G2·源码契约：done 边沿同时受庆祝驻留与冷却窗口约束', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const tick = source.slice(source.indexOf('const tick = () => {'), source.indexOf('tick();'))
  const edge = tick.split('\n').find(l => l.includes('state = "done"; doneHoldUntil'))
  assert.ok(edge, '找不到 done 边沿分支')
  assert.match(edge, /now >= doneHoldUntil/, '必须仍受 doneHoldUntil（气泡驻留）约束')
  assert.match(edge, /now - lastDoneAt >= DONE_COOLDOWN_MS/, '必须叠加冷却窗口约束（E5/E6 前的实现缺这一条）')
  assert.match(edge, /lastDoneAt = now;/, '进入 done 时必须记下时刻（不记则冷却窗口永远是空的）')
  // 首次庆祝不得被冷却挡住：lastDoneAt 初值必须是 0
  assert.match(source, /let lastDoneAt = 0;/,
    'lastDoneAt 初值须为 0 —— 否则首次庆祝会被自家冷却窗口挡掉（Date.now() 远大于任何窗口）')
})

test('G2·冷却窗口常量必须大于 done 气泡驻留（否则气泡会被下一次庆祝顶掉）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const cd = Number(source.match(/const DONE_COOLDOWN_MS = (\d+)/)[1])
  const hold = Number(source.match(/const DONE_HOLD_MS = (\d+)/)[1])
  assert.ok(cd > hold,
    `冷却 ${cd}ms 必须 > 气泡驻留 ${hold}ms —— 相等或更短会让前一次气泡还在时就被新庆祝顶掉`)
})

test('G2·反向：去掉冷却约束时上面那条必须转红', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  // 反向验证：模拟「只受驻留约束、不受冷却约束」的旧实现，确认断言会失败
  const tick = source.slice(source.indexOf('const tick = () => {'), source.indexOf('tick();'))
  const edge = tick.split('\n').find(l => l.includes('state = "done"; doneHoldUntil'))
  const withoutCooldown = edge.replace(/ && now - lastDoneAt >= DONE_COOLDOWN_MS/, '')
  assert.notStrictEqual(withoutCooldown, edge, '本用例前提：源码里确实有冷却约束可摘')
  assert.ok(!/DONE_COOLDOWN_MS/.test(withoutCooldown),
    '摘掉冷却后不得再出现该常量 —— 断言在旧实现下会失败（这正是它有效的证据）')
})

/* ---------------- G2·行为：冷却窗口的实际时间语义 ---------------- */

/**
 * **为什么要再加这一组**（上面三条是源码契约，只能证明「符号在」，证不了「时间算对」）：
 * G2 的失败形态是**时间语义写错** —— `>=` 写成 `>`、或漏了 `lastDoneAt = now`、
 * 或初值不是 0。这些全是源码契约**照样全绿**的形态。
 *
 * **重演的是同一串判定条件**（逐字对照 `client.js` 的合成链），不是另写一份近似实现 ——
 * 若日后合成链改了条件，这里会与源码漂移，故配一条「条件指纹」断言在下面钉住同步义务。
 */

/** 从源码里抠出 done 边沿的**真实条件串**，用于钉住「行为测试与源码不漂移」。 */
function doneEdgeCondition() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const tick = source.slice(source.indexOf('const tick = () => {'), source.indexOf('tick();'))
  const edge = tick.split('\n').find(l => l.includes('state = "done"; doneHoldUntil'))
  assert.ok(edge, '找不到 done 边沿分支')
  return edge
}

/**
 * 重演合成链的 done 判定（逐字对照 `client.js:695` 的条件顺序）。
 * `cool` 可传 0 以复现「没有冷却窗口」的旧行为 ⇒ 供反向验证用。
 */
function runDoneSequence(seq, { cool = 45000, hold = 10000, dt = 5000, start = 1_000_000_000_000 } = {}) {
  let lastRunning = false, doneHoldUntil = 0, lastDoneAt = 0, now = start
  const out = []
  for (const running of seq) {
    const st = lastRunning && !running && now >= doneHoldUntil && now - lastDoneAt >= cool
      ? 'done'
      : (now < doneHoldUntil && !running) ? 'done'
        : (running ? 'thinking' : 'idle')
    // 复刻 tick 尾部的状态推进
    if (st === 'done' && now >= doneHoldUntil && lastRunning && !running) {
      doneHoldUntil = now + hold
      lastDoneAt = now
    }
    out.push(st)
    lastRunning = running
    now += dt
  }
  return out
}

test('G2·行为：多轮任务的 running 抖动不得连着放两次烟花', () => {
  // 序列 = 跑 → 停（回合 1 结束）→ 跑 → 停（回合 2 结束），两轮间隔 15s
  const seq = [true, true, false, true, true, false]
  const seen = runDoneSequence(seq)
  assert.strictEqual(seen[2], 'done', `第 1 回合结束必须庆祝（实际 ${JSON.stringify(seen)}）`)
  assert.notStrictEqual(seen[5], 'done',
    `第 2 回合结束距上次仅 15s，必须被冷却 ${45000}ms 挡住，却仍庆祝了（实际 ${JSON.stringify(seen)}）`)
})

test('G2·反向：冷却为 0（= 旧实现）时第二拍必须被放行', () => {
  // 同一序列，冷却置 0 ⇒ 两次都庆祝。
  // 这条与上面那条构成**双向反证**：证明「挡住第二拍」确实是冷却干的，不是别的东西。
  const seq = [true, true, false, true, true, false]
  const seen = runDoneSequence(seq, { cool: 0 })
  assert.strictEqual(seen[2], 'done')
  assert.strictEqual(seen[5], 'done',
    `冷却为 0 时第 2 回合也该庆祝（实际 ${JSON.stringify(seen)}）—— 上面那条断言不是恒真`)
})

test('G2·行为：首次庆祝不得被冷却窗口挡住（初值语义）', () => {
  // lastDoneAt 初值 0 ⇒ start - 0 远大于任何窗口 ⇒ 首拍不受阻。
  // 若有人把初值改成「当前时间」，这条会立刻转红 —— 那正是它要防的回归。
  const seen = runDoneSequence([true, false])
  assert.strictEqual(seen[1], 'done', '首次庆祝不得被自家冷却窗口挡掉')
})

test('G2·行为：冷却窗口过期后仍能再次庆祝（冷却不是永久封锁）', () => {
  // 序列里两个 `false`（回合结束）在 idx2 与 idx5 ⇒ 间隔 = 3 × dt。
  // 初版写 dt=10000（间隔 30s）却断言「已超冷却」—— **前提算错、实现是对的**，
  // 故把「间隔 > 冷却」写成前置断言，让这个坑不会再犯第二次。
  const dt = 20_000
  const gapMs = 3 * dt
  assert.ok(gapMs > 45000, `本用例前提：两回合间隔须大于冷却窗口（${gapMs}ms vs 45000ms）`)
  const seen = runDoneSequence([true, true, false, true, true, false], { dt })
  assert.strictEqual(seen[2], 'done', '第 1 回合庆祝')
  assert.strictEqual(seen[5], 'done',
    `冷却过期后应能再次庆祝（间隔 ${gapMs}ms > 45000ms，实际 ${JSON.stringify(seen)}）`)
})

test('G2·防漂移：行为测试重演的条件串必须与源码逐字对应', () => {
  // 上面 `runDoneSequence` 重演了合成链的判定。若日后源码改了条件而这里没跟上，
  // 行为测试会「绿着一件已经不存在的事」⇒ 用条件指纹把同步义务钉成可执行断言。
  const edge = doneEdgeCondition()
  const m = edge.match(/lastRunning && !agg\.running && now >= doneHoldUntil && now - lastDoneAt >= DONE_COOLDOWN_MS/)
  assert.ok(m, 'done 边沿的条件串已变样（见实际文本：' + edge.trim() + '）—— 请同步 runDoneSequence')
})

