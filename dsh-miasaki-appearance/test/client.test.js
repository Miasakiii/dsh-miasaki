// Contract test for the client half.
//
// 1) 回归闸门（2026-09-11 启动失败）：DSH 的客户端装载器只把 `require` 交给
//    factory（契约见 `@deepseek-ai/dsh-client-modules` 的 `ClientBundleRegistration`：
//    `factory: (require) => exports`），**不注入 `module`**。bundle 里写
//    `module.exports` 而没自己声明 `const module = { exports: {} }`，factory 一执行
//    就抛 `ReferenceError: module is not defined`，整包加载失败、设置里那栏直接不出现。
//    本文件在**没有 `module` 的 VM 上下文**里跑 factory，正是为了把这个坑钉死。
// 2) 槽位契约：外观栏必须注册在官方 `settings.section`（list 槽）上，id=appearance、
//    order=5 —— 官方「通用」是 0、「模型」是 10，5 落在两者之间即「紧跟通用」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** 在 VM 里执行 client.js，捕获装载器收到的描述符。上下文刻意不提供 `module`。 */
function capture() {
  let descriptor = null
  const window = { __ModuleLoader__: { load(d) { descriptor = d } } }
  const document = {
    body: { append() {} },
    createElement: () => ({ style: {}, append() {}, remove() {}, setAttribute() {} }),
    head: { append() {} },
    documentElement: { getAttribute: () => null, hasAttribute: () => false, setAttribute() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  const context = vm.createContext({ window, document, console })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.notEqual(descriptor, null, 'client.js 必须调用 window.__ModuleLoader__.load()')
  return { descriptor, window, context }
}

// React stub：createElement 保留 children 便于断言；hooks 惰性化，组件可被调用一次。
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}
const requireStub = name => {
  if (name === 'react') return react
  throw new Error(`unexpected require: ${name}`)
}

function fakeCtx() {
  const registered = []
  const effects = []
  return {
    registered,
    effects,
    get: () => undefined,
    slots: {
      inject(name, callback) { registered.push({ name, ...callback() }) },
      register(meta, view) { return { meta, view } },
    },
    effect(callback, label) { effects.push({ label, dispose: callback() }) },
  }
}

test('client half 以包名注册，且装载器上下文里没有 module 全局', () => {
  const { descriptor, context } = capture()
  assert.equal(descriptor.id, '@miasaki/dsh-appearance')
  assert.equal(typeof descriptor.factory, 'function')
  assert.equal(context.module, undefined, '装载器不提供 module —— bundle 必须自己声明')
})

test('factory 返回插件导出（2026-09-11 加载失败的回归闸门）', () => {
  const { descriptor } = capture()
  // 这一行就是当初抛 `module is not defined` 的地方：factory 只拿到 require。
  const exports = descriptor.factory(requireStub)
  assert.equal(typeof exports, 'object', 'factory 必须返回 module.exports')
  assert.notEqual(exports, null)
  // 先展开：导出对象来自另一个 VM realm，数组原型与本 realm 不同。
  assert.deepEqual([...exports.inject], ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('apply 把「外观」注册进官方 settings.section（id=appearance、order=5）', () => {
  const { descriptor } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)

  assert.equal(ctx.registered.length, 1)
  const section = ctx.registered[0]
  assert.equal(section.name, 'settings.section')
  assert.equal(section.meta.name, 'settings.section')
  assert.equal(section.meta.id, 'appearance')
  // 官方 order：通用 = 0、模型 = 10；5 即「紧跟通用」。
  assert.equal(section.meta.order, 5)
  assert.equal(section.meta.label, '外观')
  assert.equal(typeof section.view, 'function', '注册项必须带一个组件')
})

test('apply 幂等，且 fiber 拆除时复位守卫（允许 HMR 重挂）', () => {
  const { descriptor, window } = capture()
  const exports = descriptor.factory(requireStub)
  const ctx = fakeCtx()

  exports.apply(ctx)
  exports.apply(ctx)
  assert.equal(ctx.registered.length, 1, '重复 apply 不得叠加第二个设置栏')
  assert.equal(window.__DSH_APPEARANCE_BOOTED__, true)

  assert.equal(ctx.effects.length, 1)
  ctx.effects[0].dispose()
  assert.equal(window.__DSH_APPEARANCE_BOOTED__, false, '拆除后必须允许重新挂载')

  exports.apply(ctx)
  assert.equal(ctx.registered.length, 2, '拆除后的 apply 必须能重新注册')
})

test('与 Host 的通信走同源 JSON 路由，不用动态插件的 host.call', () => {
  // client bundle 由 __ModuleLoader__ 装载，没有 host.call builtin（那是动态插件专属），
  // 所以只能走 /appearance/api/*。这条断言防的是「照抄动态插件写法」的退化。
  // 只查装载器调用之后的代码：文件头说明注释里正当地提到了 host.call，
  // 且注释里含 `/appearance/api/*`，任何朴素的「剥注释」都会在那里踩空。
  const code = source.slice(source.indexOf('window.__ModuleLoader__.load('))
  assert.match(code, /const API = '\/appearance\/api'/)
  assert.doesNotMatch(code, /host\.call/)
})
