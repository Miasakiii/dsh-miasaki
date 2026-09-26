import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

// 详情视图渲染前用 app.js 的 isInternalTurnText 过滤 DSH 运行期注入的上下文
// （persistedMessagesFor → render）。app.js 是浏览器端入口，不能直接 import，
// 因此按源码切片在 VM 里求值 —— 切片锚点必须钉在**被生产路径调用**的函数上。
//
// 2026-09-26：本用例原先测的是 messagesFromEvents（fork 前的前端投影第二份实现），
// 该函数在生产路径中零调用、仅被本测试的源码切片引用（测试遮蔽型死代码），已删除；
// 它的语义由 host 侧 index.js 的 projectableEvent 承担，覆盖见
// test/workspace-store.test.js「does not persist the DSH runtime context as a user conversation turn」。
async function loadIsInternalTurnText() {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8')
  const start = source.indexOf('function isInternalTurnText')
  const end = source.indexOf('async function loadThreadHistory')
  const context = { globalThis: {} }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)};globalThis.isInternalTurnText = isInternalTurnText`, context)
  return context.globalThis.isInternalTurnText
}

test('filters the DSH runtime context out of the rendered conversation', async () => {
  const isInternalTurnText = await loadIsInternalTurnText()

  assert.equal(isInternalTurnText('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\nPolicy details.'), true)
  assert.equal(isInternalTurnText('  <system-reminder>\n注意\n</system-reminder>'), true)
  assert.equal(isInternalTurnText('你是谁'), false)
  assert.equal(isInternalTurnText(undefined), false)
})
