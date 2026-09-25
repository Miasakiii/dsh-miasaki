// Contract test for the client half（2026-09-23 新建，锁定「触发钮死件」回归）。
//
// 背景事故（859 版本批次 `8583adf` UI 令牌化引入，2026-09-23 复审发现）：
//   触发钮一度写成 `disabled: state === null`，而 load() 的失败路径只 setError、
//   **state 恒为 null**，错误行又只渲染在**面板内部**。链条：
//     `/state` 失败 → state=null + error≠null → 触发钮 disabled → 面板打不开
//     → 错误永远不可见 → 控件成死件（只能刷新页面）。
//   旧实现按钮不带 disabled，失败时至少能点开看到错误 —— 属 UI 改版引入的功能回归。
//   修复：`loading = state === null && error === null`（加载中才禁、出错放行）。
//   本文件把判据钉死在**行为**上：驱动真实渲染路径，断言失败态下 disabled 不为 true。
//
// 1) 装载契约：DSH 客户端装载器只给 factory 传 `require`（不注入 `module`），
//    故在**没有 `module` 的 VM 上下文**里跑 factory —— 与 appearance 线同一范式。
// 2) 槽位契约：控件注册在官方 `conversation.input.right`。
// 3) 渲染契约：react stub 支持跨渲染的 state 槽位 + 可手动 flush 的 effect，
//    以便驱动「挂载 → fetch 失败 → 重渲染」这条真实路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/**
 * react stub：state/ref 槽位按 hook 调用序存放并**跨渲染保留**，
 * effect 收集进 `react.effects` 由测试手动 flush（真实 React 在提交后执行）。
 */
const react = {
  slots: [],
  cursor: 0,
  effects: [],
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState(initial) {
    const i = this.cursor++
    if (!(i in this.slots)) this.slots[i] = typeof initial === 'function' ? initial() : initial
    const self = this
    return [this.slots[i], (next) => { self.slots[i] = typeof next === 'function' ? next(self.slots[i]) : next }]
  },
  useRef(initial) {
    const i = this.cursor++
    if (!(i in this.slots)) this.slots[i] = { current: initial }
    return this.slots[i]
  },
  useCallback(fn) {
    this.cursor += 1
    return fn
  },
  useEffect(fn) {
    this.cursor += 1
    this.effects.push(fn)
  },
}

/** 在 VM 里执行 client.js（上下文刻意不提供 `module`），捕获装载描述符。 */
function capture(fetchImpl) {
  let descriptor = null
  const window = { __ModuleLoader__: { load(d) { descriptor = d } } }
  const document = {
    createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {}, remove() {} }),
    head: { appendChild() {}, append() {} },
    body: { appendChild() {} },
  }
  // fetch 是 client.js 访问 host 的唯一通道（同源 /dual-model/api/*）——注入 VM 上下文，
  // 与真实浏览器里它是全局函数一致（渲染期在 effect 里才被调用，故必须常驻）。
  const context = vm.createContext({ window, document, console, fetch: (...args) => fetchImpl(...args) })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.notEqual(descriptor, null, 'client.js 必须调用 window.__ModuleLoader__.load()')
  return { descriptor, window, context }
}

/** 取出 apply 注册的控件组件；同时返回 spec 以断言槽位契约。 */
function mount(descriptor, fetchImpl) {
  const registered = []
  const ctx = {
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    slots: {
      inject: (name, cb) => cb(),
      register: (spec, component) => { registered.push({ spec, component }) },
    },
  }
  const factory = descriptor.factory((name) => {
    if (name === 'react') return react
    throw new Error(`client.js 只允许 require('react')，实际：${name}`)
  })
  factory.apply(ctx)
  assert.equal(registered.length, 1, 'apply 必须注册恰好一个控件')
  return { control: registered[0].component, spec: registered[0].spec, ctx }
}

/** 渲染一次：重置 hook 游标与 effect 收集箱，保留 state 槽位。 */
function render(control, props = { sessionId: 's1' }) {
  react.cursor = 0
  react.effects = []
  const element = control(props)
  return { element, effects: react.effects }
}

/** 展开渲染树里的节点，返回第一个匹配谓词的节点。 */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const hit = find(child, predicate)
    if (hit !== null) return hit
  }
  return null
}

/**
 * 走完 effects 并把微任务队列排空（fetch 链是 then/catch 多跳）。
 * **不调用 cleanup**：真实 React 只在卸载/依赖变化时调用它，而 load() 的 cleanup 会把
 * `cancelled` 置真、让本次结果被丢弃 —— 立即调用会让 setIsState 永不发生（假阴性）。
 */
async function flush() {
  for (const effect of react.effects.splice(0)) effect()
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

const settle = (payload, ok = true, status = 200) => Promise.resolve({
  ok,
  status,
  json: () => Promise.resolve(payload),
})

const FAILURE = () => Promise.resolve({
  ok: false,
  status: 500,
  json: () => Promise.resolve({ error: '状态路由不可用' }),
})

const STATE = {
  enabled: true,
  imageOwner: 'assist',
  primary: { provider: 'p', model: 'deepseek-chat' },
  assist: { provider: 'p', model: 'glm-4v' },
  assistName: 'GLM-4V',
  primaryVision: false,
  assistVision: true,
  visionModels: [{ provider: 'p', id: 'glm-4v', name: 'GLM-4V', providerName: '智谱' }],
}

test('装载契约：无 module 的 VM 上下文里 factory 可执行，控件注册在 conversation.input.right', () => {
  react.slots = []
  const { descriptor } = capture(() => settle(STATE))
  const { spec } = mount(descriptor, () => settle(STATE))
  assert.equal(spec.name, 'conversation.input.right')
  assert.equal(spec.id, 'dual-model')
})

test('回归闸门：/state 失败时触发钮不得被禁用（否则错误面板永远打不开）', async () => {
  react.slots = []
  const { descriptor } = capture(FAILURE)
  const { control } = mount(descriptor, FAILURE)

  // 首帧：state=null、error=null —— 真·加载中，禁用是对的。
  const first = render(control)
  const firstTrigger = find(first.element, n => n.props?.className === 'dsh-dual-model-trigger')
  assert.equal(firstTrigger.props.disabled, true, '加载中应禁用（避免点到半截数据）')

  // 挂载 effect 发出 /state → 失败 → 重渲染。
  await flush()
  const second = render(control)
  const trigger = find(second.element, n => n.props?.className === 'dsh-dual-model-trigger')
  assert.notEqual(trigger.props.disabled, true,
    '读取失败后必须放行：错误只渲染在面板里，禁用按钮＝错误不可见＋控件成死件')
  assert.match(String(trigger.props.title), /状态路由不可用/, '失败原因应带到 title 上，悬停即可见')
})

test('回归闸门：失败态下点开面板，错误行真的渲染出来（死件链条的末端）', async () => {
  react.slots = []
  const { descriptor } = capture(FAILURE)
  const { control } = mount(descriptor, FAILURE)

  render(control)
  await flush()
  const failed = render(control)

  // 模拟用户点击触发器：setOpen(true) 落到 state 槽位，再渲染一次。
  const trigger = find(failed.element, n => n.props?.className === 'dsh-dual-model-trigger')
  trigger.props.onClick()
  const expanded = render(control)

  const errorNode = find(expanded.element, n => n.props?.className === 'dsh-dual-model-error')
  assert.notEqual(errorNode, null, '展开后必须能看到错误行')
  const panel = find(expanded.element, n => n.props?.className === 'dsh-dual-model-panel')
  assert.notEqual(panel, null, '展开态必须渲染面板')
})

test('成功路径：state 到位后触发钮可用，标签走「主 ▸ 辅」', async () => {
  react.slots = []
  const { descriptor } = capture(() => settle(STATE))
  const { control } = mount(descriptor, () => settle(STATE))

  render(control)
  await flush()
  const { element } = render(control)

  const trigger = find(element, n => n.props?.className === 'dsh-dual-model-trigger')
  assert.notEqual(trigger.props.disabled, true, '成功路径必须可点')
  assert.match(JSON.stringify(trigger), /deepseek-chat ▸ glm-4v/, '折叠标签应为主 ▸ 辅双短名')
})
