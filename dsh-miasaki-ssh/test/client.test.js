// Contract test for the client half. DSH's client module loader calls
// `factory(require)` and hands the return value to cordis as the plugin, so a
// factory that never returns `module.exports` yields undefined and the whole
// plugin fails to load with `invalid plugin, expect function or object with an
// "apply" method, received undefined` — the 2026-09-10 startup failure.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** Run client.js in a VM whose `window.__ModuleLoader__` captures the descriptor. */
function capture() {
  let descriptor = null
  const window = { __ModuleLoader__: { load(d) { descriptor = d } } }
  vm.runInContext(source, vm.createContext({ window }), { filename: 'client.js' })
  assert.notEqual(descriptor, null, 'client.js must call window.__ModuleLoader__.load()')
  return { descriptor, window }
}

const react = { createElement: (type, props) => ({ type, props }) }
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
    slots: {
      inject(name, callback) { registered.push({ name, ...callback() }) },
      register(meta, view) { return { meta, view } },
    },
    effect(callback, label) { effects.push({ label, dispose: callback() }) },
  }
}

test('client half registers under the package id', () => {
  const { descriptor } = capture()
  assert.equal(descriptor.id, '@miasaki/dsh-ssh')
  assert.equal(typeof descriptor.factory, 'function')
})

test('factory returns the plugin exports', () => {
  const { descriptor } = capture()
  const exports = descriptor.factory(requireStub)
  assert.equal(typeof exports, 'object', 'factory must return module.exports')
  assert.notEqual(exports, null)
  // Spread first: the exports object comes from another VM realm, so its
  // array prototype is not this realm's.
  assert.deepEqual([...exports.inject], ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('apply registers the conversation view tab', () => {
  const { descriptor, window } = capture()
  const ctx = fakeCtx()
  descriptor.factory(requireStub).apply(ctx)

  assert.equal(window.__DSH_SSH_BOOTED__, true)
  assert.equal(ctx.registered.length, 1)
  const [row] = ctx.registered
  assert.equal(row.name, 'conversation.view')
  assert.equal(row.meta.id, 'ssh')
  assert.equal(row.meta.label(), 'SSH')
  assert.equal(row.meta.order, 20)

  const view = row.view()
  assert.equal(view.type, 'iframe')
  assert.equal(view.props.src, '/ssh/')
})

test('apply is idempotent and the effect resets the guard', () => {
  const { descriptor, window } = capture()
  const exports = descriptor.factory(requireStub)
  const ctx = fakeCtx()

  exports.apply(ctx)
  exports.apply(ctx)
  assert.equal(ctx.registered.length, 1, 'a second apply must not stack a tab')

  assert.equal(ctx.effects.length, 1)
  assert.equal(ctx.effects[0].label, 'ssh: view')
  ctx.effects[0].dispose()
  assert.equal(window.__DSH_SSH_BOOTED__, false)

  exports.apply(ctx)
  assert.equal(ctx.registered.length, 2, 'apply after teardown must remount')
})
