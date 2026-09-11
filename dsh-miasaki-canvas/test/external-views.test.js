// 外部视图槽契约（2026-09-10）。
//
// 背景：第三方插件（首个使用者是 SSH 线）希望自己的入口出现在**画布页面内部**那组
// 「对话 / 会话布」按钮旁边。那组按钮属于画布自己的 iframe 文档，宿主 DOM 碰不到，
// 所以本包提供一条**通用**通道：
//
//   1. 插件把 `{ id, label }` 写进页面级注册表 `window.__DSH_CANVAS_VIEW_ITEMS__`
//      并派发 `dsh-canvas:view-items`；
//   2. client 半（宿主）把它转成 `canvas:views` 下发给画布页面（iframe 就绪 / 浮层打开 /
//      注册表变化时各发一次）；
//   3. 画布页面在 `.view-switch` 里多渲染一个按钮，点击广播 `canvas:view`；
//   4. **注册方自己**监听那条广播去切视图 —— 本包不解释 id 的语义、也不回调任何人。
//
// 红线（本文件同时守住它）：canvas 侧**不认识任何具体视图**，源码里不该出现 "SSH"、
// 不该 import 别的线；两侧只有这一份页面级约定。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8')

test('client 半把页面级注册表转给画布页面，不解释 id 的语义', async () => {
  const source = await read('client.js')
  assert.match(source, /window\.__DSH_CANVAS_VIEW_ITEMS__/)
  assert.match(source, /const publishExternalViews = \(\) => send\('canvas:views', \{ items: externalViews\(\) \}\)/)
  // 三个下发时机：iframe 加载完成、浮层打开、注册表变化。
  assert.match(source, /const onFrameLoad = \(\) => \{[\s\S]*?publishExternalViews\(\)/)
  assert.match(source, /send\('canvas:map-opened'\)\s*\n\s*publishExternalViews\(\)/, '打开浮层时也要下发（iframe 可能早已就绪）')
  assert.match(source, /window\.addEventListener\('dsh-canvas:view-items', publishExternalViews\)/)
  assert.match(source, /window\.removeEventListener\('dsh-canvas:view-items', publishExternalViews\)/, '卸载必须解绑')
  // 只认形状（id / label 都是字符串），不认具体 id。
  assert.match(source, /typeof item\.id === 'string' && typeof item\.label === 'string'/)
})

test('画布页面渲染外部按钮并广播点击，不引入任何具体视图知识', async () => {
  const source = await read('app.js')
  assert.match(source, /externalViews: \[\]/, 'state 里要有外部视图位')
  assert.match(source, /data-action="external-view" data-view-id="\$\{escapeHtml\(item\.id\)\}"/)
  assert.match(source, /<button class="active" type="button" aria-pressed="true">会话布<\/button>\$\{externalViewButtons\(\)\}/, '按钮要长在「对话 / 会话布」那组里')
  assert.match(source, /if \(button\.dataset\.action === 'external-view' && typeof button\.dataset\.viewId === 'string'\) post\('canvas:view', \{ id: button\.dataset\.viewId \}\)/)
  assert.match(source, /if \(data\.type === 'canvas:views'\)/)
  // 重渲染要守 canReplaceView（用户正在输入时不能被打断）。
  assert.match(source, /state\.externalViews = items\s*\n\s*if \(canReplaceView\(\)\) render\(\)/)
})

test('红线：canvas 侧不认识具体视图，也不 import 别的线', async () => {
  const [client, app] = await Promise.all([read('client.js'), read('app.js')])
  for (const [name, source] of [['client.js', client], ['app.js', app]]) {
    assert.doesNotMatch(source, /SSH|@miasaki\/dsh-ssh/, `${name} 不该出现 SSH 字样`)
    assert.doesNotMatch(source, /dsh-miasaki-ssh/, `${name} 不该引用别的线`)
  }
})
